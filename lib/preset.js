const MARKERS = new Set(['worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory']);
const ROLES = new Set(['system', 'user', 'assistant']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const VARIABLE_ALIASES = Object.freeze({ varexists: 'hasvar', globalvarexists: 'hasglobalvar', flushvar: 'deletevar', flushglobalvar: 'deleteglobalvar' });
export const VARIABLE_MACROS = Object.freeze(['setvar', 'getvar', 'addvar', 'incvar', 'decvar', 'hasvar', 'deletevar',
    'setglobalvar', 'getglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'hasglobalvar', 'deleteglobalvar', ...Object.keys(VARIABLE_ALIASES)]);
export const SUPPORTED_PRESET_MACROS = Object.freeze([...VARIABLE_MACROS,
    'user', 'char', 'description', 'personality', 'scenario', 'persona', 'mesexamples', 'user_input', 'currentinput', 'lastusermessage', 'noop', 'trim']);
const MAX_MACRO_TEXT = 2_000_000;
const MAX_VARIABLE_TEXT = 8_000_000;

export class PresetError extends Error {
    constructor(message, code = 'PRESET_INVALID') { super(message); this.name = 'PresetError'; this.code = code; }
}

function assert(condition, message, code) { if (!condition) throw new PresetError(message, code); }
function str(value, fallback = '') { return typeof value === 'string' ? value : fallback; }

/** Imports data only. Script, regex, provider and executable extension settings are never retained. */
export function normalizePreset(input, { name = '导入的规划预设', characterId = 100001 } = {}) {
    let source;
    try { source = typeof input === 'string' ? JSON.parse(input) : input; }
    catch { throw new PresetError('预设不是有效的 JSON。'); }
    assert(source && typeof source === 'object' && !Array.isArray(source), '预设必须是 JSON 对象。');
    if (source.version && source.data && typeof source.data === 'object') source = source.data;
    assert(Array.isArray(source.prompts), '预设缺少 prompts 条目数组。');
    const ids = new Set();
    const warnings = Array.isArray(source.warnings) ? source.warnings.filter(x => typeof x === 'string') : [];
    const prompts = source.prompts.map((p, index) => {
        assert(p && typeof p.identifier === 'string' && p.identifier.trim(), `第 ${index + 1} 个条目缺少 identifier。`);
        assert(!ids.has(p.identifier), `条目标识重复：${p.identifier}`);
        ids.add(p.identifier);
        assert(p.content == null || typeof p.content === 'string', `条目 ${p.identifier} 的内容必须是文本。`);
        const role = p.role || 'system';
        assert(ROLES.has(role), `条目 ${p.identifier} 使用了不支持的消息角色。`);
        return {
            identifier: p.identifier, name: str(p.name, p.identifier), content: str(p.content), role,
            enabled: p.enabled !== false, marker: p.marker === true,
            system_prompt: p.system_prompt === true, forbid_overrides: p.forbid_overrides === true,
            injection_position: Number(p.injection_position) || 0,
            injection_depth: Number(p.injection_depth) || 0,
            injection_order: Number(p.injection_order) || 0,
            injection_trigger: Array.isArray(p.injection_trigger) ? p.injection_trigger.filter(x => typeof x === 'string') : [],
        };
    });
    let entries = source.prompt_order ?? source.order;
    let selectedCharacter = characterId;
    if (Array.isArray(entries) && entries.some(x => Array.isArray(x?.order))) {
        const selected = entries.find(x => String(x.character_id) === String(characterId)) || (entries.length === 1 ? entries[0] : null);
        assert(selected, '预设包含多套排序，无法确定要使用哪一套。请指定 characterId。');
        entries = selected.order;
        selectedCharacter = selected.character_id;
    }
    if (entries == null) {
        warnings.push('文件没有 prompt_order；按条目数组顺序和各条目 enabled 状态导入。');
        entries = prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled }));
    }
    assert(Array.isArray(entries), 'prompt_order 必须是数组。');
    const ordered = new Set();
    const order = entries.map(entry => {
        const id = typeof entry === 'string' ? entry : entry?.identifier;
        assert(typeof id === 'string' && !ordered.has(id), '排序包含缺少标识或重复的条目。');
        ordered.add(id);
        if (!ids.has(id) && MARKERS.has(id)) {
            prompts.push({ identifier: id, name: id, content: '', role: 'system', enabled: true, marker: true, system_prompt: false, forbid_overrides: false, injection_position: 0, injection_depth: 0, injection_order: 0, injection_trigger: [] });
            ids.add(id);
        }
        if (!ids.has(id) && ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'].includes(id)) {
            prompts.push({ identifier: id, name: id, content: '', role: 'system', enabled: true, marker: false, system_prompt: true, forbid_overrides: true, injection_position: 0, injection_depth: 0, injection_order: 0, injection_trigger: [] });
            ids.add(id);
            warnings.push(`文件未提供内置条目 ${id} 的文本，已保留为空；不会套用酒馆当前预设的同名内容。`);
        }
        assert(ids.has(id), `排序引用了不存在的条目：${id}`);
        const prompt = prompts.find(p => p.identifier === id);
        return { identifier: id, enabled: typeof entry?.enabled === 'boolean' ? entry.enabled : prompt.enabled };
    });
    const meta = source.extensions?.baibaiToolkit?.presetPromptGroups;
    const groupIds = new Set();
    const groups = (Array.isArray(source.groups) ? source.groups : Array.isArray(meta?.groups) ? meta.groups : []).map((g, index) => {
        assert(g && typeof g.id === 'string' && g.id && !groupIds.has(g.id), '分组标识缺失或重复。');
        groupIds.add(g.id);
        return { id: g.id, name: str(g.name, g.id), order: Number.isFinite(g.order) ? g.order : index, enabled: g.enabled !== false, collapsed: g.collapsed === true };
    });
    const promptGroups = Object.create(null);
    const mapping = source.promptGroups ?? meta?.prompts ?? {};
    for (const [id, value] of Object.entries(mapping)) {
        const groupId = typeof value === 'string' ? value : value?.groupId;
        if (ids.has(id) && groupIds.has(groupId)) promptGroups[id] = groupId;
    }
    if (source.extensions && Object.keys(source.extensions).some(k => k !== 'baibaiToolkit' && k !== 'dual_model_outline_preset')) warnings.push('仅导入提示词与分组数据；其他扩展设置、脚本和正则不执行也不导入。');
    return { name: str(source.name, name), characterId: selectedCharacter, prompts, order, groups, promptGroups, warnings };
}

/** Serializes a standalone ST Chat Completion preset, without keys, scripts or provider settings. */
export function exportPreset(preset) {
    const normalized = normalizePreset(preset, { name: preset.name, characterId: preset.characterId ?? 100001 });
    const mapping = Object.create(null);
    for (const [id, groupId] of Object.entries(normalized.promptGroups)) mapping[id] = { groupId };
    return {
        name: normalized.name,
        prompts: normalized.prompts.map(p => ({ ...p })),
        prompt_order: [{ character_id: normalized.characterId, order: normalized.order.map(p => ({ ...p })) }],
        extensions: { baibaiToolkit: { presetPromptGroups: { version: 1, groups: normalized.groups.map(g => ({ ...g })), prompts: mapping } } },
    };
}

function dictionary(source) {
    const result = Object.create(null);
    for (const [key, value] of Object.entries(source ?? {})) {
        assert(['string', 'number', 'boolean'].includes(typeof value) || value == null, `变量 ${key} 必须是简单文本或数值。`);
        result[key] = value == null ? '' : String(value);
    }
    return result;
}

function macroResolver(context, variables, globalVariables, warnings) {
    const aliases = { user: 'user', char: 'char', description: 'charDescription', personality: 'charPersonality', scenario: 'scenario', persona: 'personaDescription', mesexamples: 'dialogueExamples', user_input: 'currentInput', currentinput: 'currentInput', lastusermessage: 'currentInput' };
    let evaluations = 0;
    let storedLength = [...Object.values(variables), ...Object.values(globalVariables)].reduce((sum, value) => sum + value.length, 0);
    function store(target, key, value) {
        const text = String(value);
        const nextLength = storedLength - (target[key]?.length || 0) + text.length;
        assert(text.length <= MAX_MACRO_TEXT && nextLength <= MAX_VARIABLE_TEXT, '变量展开内容过长，请减少重复追加或循环累积。', 'MACRO_LIMIT');
        target[key] = text; storedLength = nextLength;
        return text;
    }
    function add(target, key, value) {
        const previous = target[key] ?? '';
        const current = (previous.trim() === '' || Number.isNaN(Number(previous)) ? previous : Number(previous)) || 0;
        let parsed;
        try { parsed = JSON.parse(current); } catch { /* Plain strings are not arrays. */ }
        if (Array.isArray(parsed)) { parsed.push(value); return store(target, key, JSON.stringify(parsed)); }
        const number = Number(value);
        if (Number.isNaN(number) || Number.isNaN(Number(current))) {
            assert(String(current || '').length + String(value).length <= MAX_MACRO_TEXT, '变量展开内容过长，请减少重复追加。', 'MACRO_LIMIT');
            return store(target, key, String(current || '') + value);
        }
        const result = Number(current) + number;
        assert(Number.isFinite(result), '变量运算结果超出有效数值范围。', 'MACRO_INVALID');
        return store(target, key, result);
    }
    function evaluate(expression) {
        assert(++evaluations <= 10000, '宏数量过多，已停止解析。', 'MACRO_LIMIT');
        const head = /^\s*([A-Za-z_][\w]*)(?=\s|:|$)/.exec(expression);
        const command = head?.[1] || expression.trim();
        const originalName = command.toLowerCase();
        const name = own(VARIABLE_ALIASES, originalName) ? VARIABLE_ALIASES[originalName] : originalName;
        const rest = head ? expression.slice(head[0].length) : '';
        // Preserve multiline assignment values. Only the command/key boundaries
        // are trimmed; a space or legacy colon also introduces a single argument.
        const parts = !rest.trim() ? [] : rest.replace(/^\s*(?:::|:)\s*|^\s+/, '').split('::');
        if (name === 'noop' && !parts.length) return '';
        if (VARIABLE_MACROS.includes(name)) {
            const key = parts.shift()?.trim();
            assert(key, `宏 ${command} 缺少变量名。`, 'MACRO_INVALID');
            const target = name.includes('global') ? globalVariables : variables;
            if (name.startsWith('set') || name.startsWith('add')) {
                assert(parts.length > 0, `宏 ${command} 缺少变量值。`, 'MACRO_INVALID');
                const value = parts.join('::');
                if (name.startsWith('set')) store(target, key, value);
                else add(target, key, value);
                return '';
            }
            assert(parts.length === 0, `宏 ${command} 包含多余参数。`, 'MACRO_INVALID');
            if (name.startsWith('inc')) return add(target, key, 1);
            if (name.startsWith('dec')) return add(target, key, -1);
            if (name.startsWith('has')) return String(own(target, key));
            if (name.startsWith('delete')) {
                storedLength -= target[key]?.length || 0;
                delete target[key];
                return '';
            }
            if (!own(target, key)) warnings.push(`变量 ${key} 尚未在此预设中赋值；按空文本展开。`);
            return target[key] ?? '';
        }
        if (own(aliases, name) && !parts.length) {
            const value = context[aliases[name]];
            assert(typeof value === 'string', `宏 ${command} 缺少文本上下文。`, 'MACRO_CONTEXT_MISSING');
            return value;
        }
        throw new PresetError(`不支持宏「${command.slice(0, 80)}」。请编辑或关闭相关条目后重试；不会把未解析的宏发给模型。`, 'MACRO_UNSUPPORTED');
    }
    return function resolve(text) {
        let position = 0;
        function walk(nested = false, depth = 0) {
            assert(depth < 32, '宏嵌套过深。', 'MACRO_LIMIT');
            let output = '';
            while (position < text.length) {
                if (text.startsWith('{{', position)) {
                    position += 2;
                    // Comments are removed without evaluating any nested macros or their side effects.
                    if (/^\s*\/\//.test(text.slice(position))) {
                        const scoped = /^\s*\/\/\s*\}\}/.exec(text.slice(position));
                        if (scoped) {
                            const tail = text.slice(position + scoped[0].length);
                            const end = /\{\{\s*\/\/\/\s*\}\}/.exec(tail);
                            assert(end, '块注释缺少 {{///}} 结束符。', 'MACRO_INVALID');
                            position += scoped[0].length + end.index + end[0].length;
                        } else {
                            let balance = 1;
                            while (position < text.length && balance) {
                                if (text.startsWith('{{', position)) { balance++; position += 2; }
                                else if (text.startsWith('}}', position)) { balance--; position += 2; }
                                else position++;
                            }
                            assert(balance === 0, '注释宏没有闭合。', 'MACRO_INVALID');
                        }
                    } else {
                        const expression = walk(true, depth + 1);
                        if (expression.trim().toLowerCase() === 'trim') {
                            output = output.replace(/[\r\n]+$/, '');
                            while (position < text.length && /[\r\n]/.test(text[position])) position++;
                        } else output += evaluate(expression);
                    }
                } else if (text.startsWith('}}', position)) {
                    assert(nested, '条目含有多余的宏结束符 }}。', 'MACRO_INVALID');
                    position += 2;
                    return output;
                } else output += text[position++];
                assert(output.length <= MAX_MACRO_TEXT, '宏展开内容过长，请减少重复引用或追加。', 'MACRO_LIMIT');
            }
            assert(!nested, '条目含有未闭合的宏。', 'MACRO_INVALID');
            return output;
        }
        return walk();
    };
}

function markerMessages(value, label) {
    if (typeof value === 'string') return value.trim() ? [{ role: 'system', content: `【${label}】\n${value}` }] : [];
    assert(Array.isArray(value), `上下文 ${label} 必须是文本或消息数组。`, 'CONTEXT_MISSING');
    return value.map(message => {
        assert(message && ROLES.has(message.role) && typeof message.content === 'string', `上下文 ${label} 含有无效消息。`);
        return { role: message.role, content: message.content };
    });
}

const normalizeNewlines = value => value.replace(/\r\n?/g, '\n');
function coversWholeBlock(source, content) {
    const text = normalizeNewlines(source), block = normalizeNewlines(content);
    if (!block.trim()) return false;
    for (let start = text.indexOf(block); start !== -1; start = text.indexOf(block, start + 1)) {
        const end = start + block.length;
        if ((start === 0 || text[start - 1] === '\n') && (end === text.length || text[end] === '\n')) return true;
    }
    return false;
}

/** Only complete adapter-provided blocks may be omitted, and only when the
 * enabled worldbook markers have actually emitted the same literal content. */
function remainingMemory(context, entries) {
    if (context.animaStatus === 'empty') return { text: '', covered: 0 };
    const parts = context.memoryParts;
    const compose = values => values.map(part => `${part.header}\n${part.content}`).join('\n\n').trim();
    const valid = Array.isArray(parts) && parts.length && parts.every(part => part && typeof part.header === 'string'
        && /^\[[^\r\n]*\]$/.test(part.header) && typeof part.content === 'string' && part.content.trim());
    // Legacy adapters/mocks and inconsistent metadata keep the original text.
    if (!valid || normalizeNewlines(compose(parts)) !== normalizeNewlines(context.animaMemory)) return { text: context.animaMemory, covered: 0 };
    const sentWorldbookText = entries.filter(entry => entry.kind === 'context' && entry.messages.length
        && ['worldInfoBefore', 'worldInfoAfter'].includes(entry.id)).flatMap(entry => {
        const value = context[entry.id];
        // Exclude our marker heading from the comparison; it is not source data.
        return typeof value === 'string' ? [value] : entry.messages.map(message => message.content);
    });
    const remaining = parts.filter(part => !sentWorldbookText.some(source => coversWholeBlock(source, part.content)));
    return { text: compose(remaining), covered: parts.length - remaining.length };
}

/** Executes only our bounded macros in private dictionaries. Does not access ST variables or execute preset code. */
export function compilePreset(preset, { context = {}, variables = {}, globalVariables = {}, targetLength = '' } = {}) {
    const p = normalizePreset(preset, { name: preset.name, characterId: preset.characterId ?? 100001 });
    const warnings = [...p.warnings];
    const local = dictionary(variables);
    const global = dictionary(globalVariables);
    const resolve = macroResolver(context, local, global, warnings);
    const groupById = new Map(p.groups.map(g => [g.id, g]));
    const promptById = new Map(p.prompts.map(item => [item.identifier, item]));
    const active = p.order.filter(entry => entry.enabled !== false && groupById.get(p.promptGroups[entry.identifier])?.enabled !== false).map(entry => promptById.get(entry.identifier));
    assert(active.length, '预设没有启用的条目。');
    assert(typeof context.currentInput === 'string', '本轮输入未提供。', 'CURRENT_INPUT_MISSING');
    assert(['success', 'empty'].includes(context.animaStatus), '本轮 Anima 记忆尚未成功读取，不能开始规划。', 'ANIMA_REQUIRED');
    assert(typeof context.animaMemory === 'string', 'Anima 返回内容必须是文本。', 'ANIMA_REQUIRED');
    assert(context.animaStatus !== 'empty' || !context.animaMemory.trim(), 'Anima 状态与记忆内容不一致。', 'ANIMA_REQUIRED');
    assert(context.animaStatus !== 'success' || context.animaMemory.trim(), 'Anima 返回空内容时请明确标记为 empty。', 'ANIMA_REQUIRED');
    assert(typeof targetLength === 'string', '正文目标必须是文本。');
    const runtime = [
        { id: 'anima_memory', name: '本轮实际读取的 Anima 记忆', messages: [] },
        ...(targetLength.trim() ? [{ id: 'target_length', name: '本轮共享的最终正文目标', messages: [{ role: 'system', content: `【本轮共享的最终正文目标】\n${targetLength.trim()}\n此目标用于主模型扩写正文；请据此安排本轮内容容量与事件组织。` }] }] : []),
        ...(Array.isArray(context.extensionNotes) && context.extensionNotes.length ? [{ id: 'extension_notes', name: '其他扩展本轮注入', messages: [{ role: 'system', content: `【其他扩展本轮注入】\n以下来自其他酒馆扩展的注入内容，按其在正文请求中的位置与深度排序，属于本轮已成立的资料；规划沿用其中的事实与安排，注入格式与写法要求仍归主模型执行：\n${context.extensionNotes.map(note => `—— ${note.key} ——\n${note.text}`).join('\n\n')}` }] }] : []),
        { id: 'current_input', name: '本轮当前 user_input', messages: [{ role: 'user', content: `【本轮当前 user_input】\n${context.currentInput}` }] },
    ];
    const lastMarker = active.reduce((last, item, index) => item.marker ? index : last, -1);
    const messages = [], entries = [];
    const append = (id, name, kind, itemMessages) => {
        entries.push({ id, name, kind, messages: itemMessages, order: entries.length + 1, enabled: true, status: itemMessages.length ? 'sent' : 'empty' });
        messages.push(...itemMessages);
    };
    const appendRuntime = () => {
        const memory = remainingMemory(context, entries);
        runtime[0].messages = memory.text.trim() ? [{ role: 'system', content: `【相关经历与资料】\n${memory.text}` }] : [];
        if (memory.covered) runtime[0].name = memory.text.trim() ? 'Anima 记忆 · 补充内容' : 'Anima 记忆 · 已包含在世界书';
        runtime.forEach(item => append(item.id, item.name, 'runtime', item.messages));
    };
    active.forEach((item, index) => {
        if (item.marker) {
            assert(MARKERS.has(item.identifier), `不支持上下文占位条目 ${item.identifier}。`, 'MARKER_UNSUPPORTED');
            assert(own(context, item.identifier), `缺少上下文：${item.identifier}。`, 'CONTEXT_MISSING');
            append(item.identifier, item.name, 'context', markerMessages(context[item.identifier], item.identifier));
        } else {
            assert(item.injection_position === 0 && !item.injection_trigger.length, `条目 ${item.name} 使用了按深度或触发条件注入。当前独立规划仅支持按列表顺序注入；请编辑此条目后重试。`, 'INJECTION_UNSUPPORTED');
            let content;
            try { content = resolve(item.content); }
            catch (error) {
                if (error instanceof PresetError) throw new PresetError(`条目「${item.name}」：${error.message}`, error.code);
                throw error;
            }
            append(item.identifier, item.name, 'prompt', content.trim() ? [{ role: item.role, content }] : []);
        }
        if (index === lastMarker) appendRuntime();
    });
    if (lastMarker < 0) appendRuntime();
    return { messages, entries, warnings: [...new Set(warnings)], variables: local, globalVariables: global };
}
