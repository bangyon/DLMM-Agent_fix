"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.askAI = askAI;
const config_1 = require("../config");
const GROQ_SYSTEM = `Kamu adalah analis DLMM LP yang cepat. Analisis data pool dan buat keputusan dalam JSON.
Fokus: vol/TVL ratio, rug risk, bundler/MEV, momentum harga, top trader consensus.
Jadilah decisive — berikan recommendation yang jelas.`;
const CLAUDE_SYSTEM = `Kamu adalah decision maker final untuk DLMM LP bot di Meteora Solana.
Groq sudah analisis. Review dan buat keputusan final yang optimal.
Strategy: BidAskImBalanced untuk meme tokens, bin range ±34-50, max hold 6 jam.
Respond HANYA JSON valid.`;
async function callGroq(messages) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config_1.CONFIG.ai.groqKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: config_1.CONFIG.ai.model || 'llama-3.3-70b-versatile',
            messages,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            max_tokens: 600,
        }),
    });
    const data = await res.json();
    if (!res.ok || !data.choices?.[0]) {
        throw new Error(`Groq error: ${data.error?.message || res.status}`);
    }
    return data.choices[0].message.content;
}
async function callClaude(messages) {
    const userMessages = messages.filter(m => m.role !== 'system');
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': config_1.CONFIG.ai.anthropicKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            system: systemMsg,
            messages: userMessages,
        }),
    });
    const data = await res.json();
    if (!res.ok || !data.content?.[0]) {
        throw new Error(`Claude error: ${data.error?.message || res.status}`);
    }
    return data.content[0].text;
}
function parseJSON(raw) {
    const clean = raw.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match)
        throw new Error('No JSON found');
    return JSON.parse(match[0]);
}
async function askAI(userPrompt) {
    try {
        // Step 1: Groq analyst
        console.log('   🔍 Groq menganalisis...');
        const groqMessages = [
            { role: 'system', content: GROQ_SYSTEM },
            { role: 'user', content: `${userPrompt}

Buat analisis dalam JSON:
{"summary":"ringkasan","top_pool":"pool terbaik","recommendation":"entry|skip|hold|close","confidence":0-100,"key_signals":"signal terpenting","poolAddress":"address jika entry","strategyType":"BidAskImBalanced","binRange":34,"riskLevel":"low|medium|high"}` },
        ];
        let groqRaw = '';
        let groqData = {};
        try {
            groqRaw = await callGroq(groqMessages);
            groqData = parseJSON(groqRaw);
            console.log(`   🔍 Groq: ${groqData.recommendation}(${groqData.confidence}%) — ${groqData.key_signals || groqData.summary || ''}`);
        }
        catch (err) {
            console.log(`   ⚠️  Groq error: ${err}`);
            return { action: 'hold', reasoning: 'Groq error', riskLevel: 'medium', confidence: 0 };
        }
        // Step 2: Claude final decision (opsional)
        if (config_1.CONFIG.ai.anthropicKey) {
            try {
                console.log('   🧠 Claude membuat keputusan final...');
                const claudeMessages = [
                    { role: 'system', content: CLAUDE_SYSTEM },
                    { role: 'user', content: `${userPrompt}\n\n=== GROQ ANALYSIS ===\n${groqRaw}\n\nBuat keputusan final. JSON: {"action":"open_position|skip|hold|close_position|rebalance","poolAddress":"address|null","strategyType":"BidAskImBalanced","binRange":34,"reasoning":"alasan","riskLevel":"low|medium|high","confidence":0-100}` },
                ];
                const claudeRaw = await callClaude(claudeMessages);
                const decision = parseJSON(claudeRaw);
                decision.groqAnalysis = groqData.key_signals || '';
                decision.claudeVerdict = decision.reasoning;
                console.log(`\n🤖 Dual AI: Groq ${groqData.recommendation}(${groqData.confidence}%) → Claude ${decision.action}(${decision.confidence}%) — ${decision.reasoning}`);
                return decision;
            }
            catch (err) {
                console.log(`   ⚠️  Claude skip (${String(err).slice(0, 80)}) — pakai Groq`);
            }
        }
        // Groq-only fallback
        const actionMap = {
            'entry': 'open_position', 'skip': 'skip', 'hold': 'hold',
            'close': 'close_position', 'rebalance': 'rebalance',
        };
        const decision = {
            action: actionMap[groqData.recommendation] || 'hold',
            poolAddress: groqData.poolAddress || undefined,
            strategyType: groqData.strategyType || 'BidAskImBalanced',
            binRange: groqData.binRange || config_1.CONFIG.agent.defaultBinRange,
            reasoning: groqData.key_signals || groqData.summary || '',
            riskLevel: groqData.riskLevel || 'medium',
            confidence: groqData.confidence || 60,
            groqAnalysis: groqData.key_signals || '',
        };
        console.log(`\n🤖 Groq: ${decision.action}(${decision.confidence}%) — ${decision.reasoning}`);
        return decision;
    }
    catch (err) {
        console.error('❌ AI error:', err);
        return { action: 'hold', reasoning: 'AI error — default hold', riskLevel: 'low', confidence: 0 };
    }
}
//# sourceMappingURL=brain.js.map