import { normalizePreset } from './preset.js';

const TOKEN_METHOD = '按文本估算；非供应商计费';
const encoder = new TextEncoder();

function estimateMessages(messages) {
    // A transparent, model-independent estimate. Never reuse ST's main-model
    // tokenizer as if it were the independent planning provider's tokenizer.
    return messages.reduce((total, message) => total + Math.ceil((encoder.encode(message.role).length + encoder.encode(message.content).length) / 3) + 4, 0);
}

/** Estimates only the editable template, without resolving variables or reading memory. */
export function estimatePromptText({ role = 'system', content = '' } = {}) {
    const text = String(content ?? '');
    return text.trim() ? estimateMessages([{ role: String(role), content: text }]) : 0;
}

/** Builds a snapshot of an already compiled request, without re-expanding macros
 * or fetching any context. The caller owns freshness and source-read status. */
export function buildPromptInspection({ preset, compiled, sources = {}, model = '' } = {}) {
    if (!compiled || !Array.isArray(compiled.messages) || !Array.isArray(compiled.entries)) throw new Error('提示词检查需要本轮已编译的请求快照。');
    const flattened = compiled.entries.flatMap(entry => entry.messages);
    if (JSON.stringify(flattened) !== JSON.stringify(compiled.messages)) throw new Error('条目快照与本轮实际请求消息不一致。');
    const normalized = normalizePreset(preset, { name: preset.name, characterId: preset.characterId ?? 100001 });
    const orderMap = new Map(normalized.order.map((entry, index) => [entry.identifier, index + 1]));
    const enabledMap = new Map(normalized.order.map(entry => [entry.identifier, entry.enabled]));
    const groups = new Map(normalized.groups.map(group => [group.id, group]));
    const traced = new Set();
    const entries = compiled.entries.map(entry => {
        if (entry.kind !== 'runtime') traced.add(entry.id);
        const messages = entry.messages.map(message => {
            if (!message || typeof message.role !== 'string' || typeof message.content !== 'string') throw new Error('请求快照含有无效消息。');
            return { role: message.role, content: message.content };
        });
        return { ...entry, messages, enabled: true, status: messages.length ? 'sent' : 'empty',
            tokens: estimateMessages(messages), presetOrder: entry.kind === 'runtime' ? null : orderMap.get(entry.id) ?? null };
    });
    // Unsent prompts are listed after the actual request. Their array position
    // must never be mistaken for a position in the transmitted message sequence.
    const unsent = normalized.prompts.filter(prompt => !traced.has(prompt.identifier));
    unsent.sort((a, b) => (orderMap.get(a.identifier) ?? Infinity) - (orderMap.get(b.identifier) ?? Infinity));
    for (const prompt of unsent) {
        const listed = orderMap.has(prompt.identifier);
        const groupDisabled = groups.get(normalized.promptGroups[prompt.identifier])?.enabled === false;
        const reason = !listed ? 'unlisted' : enabledMap.get(prompt.identifier) === false ? 'prompt_disabled' : groupDisabled ? 'group_disabled' : 'not_sent';
        entries.push({ id: prompt.identifier, name: prompt.name, kind: prompt.marker ? 'context' : 'prompt', messages: [],
            order: null, presetOrder: orderMap.get(prompt.identifier) ?? null, enabled: false, status: 'disabled', reason, tokens: 0 });
    }
    return { entries, totalTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0), tokenMethod: TOKEN_METHOD,
        tokenEstimateNote: '逐条按 role 与 content 的 UTF-8 字节数除以 3 向上取整，另估每条消息 4 token 格式开销；不同模型分词会有差异，不含供应商隐藏提示。',
        model: typeof model === 'string' ? model : '', sources: structuredClone(sources) };
}
