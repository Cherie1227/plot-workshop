import { analyzeImportedPreset } from './import-advisor.js';
import { SUPPORTED_PRESET_MACROS } from './preset.js';

const KNOWN_MACROS = new Set(SUPPORTED_PRESET_MACROS);
const DEPENDENCY_REASON = /^含(?:变量定义或赋值|变量读取|角色、输入或其他内容宏)/;
const DEFINITION = /定义变量|变量定义|变量初始化|初始化变量|变量赋值|声明变量|变量声明|(?:^|[\n;；])\s*(?:const|let|var)\s+[\w$]+\s*=/i;
const NAME_HINT = /正文|输出|content|格式|状态栏|状态面板|摘要|总结|文风|视角|字数|八股|\b(?:prose|output|status|summary|style)\b/i;
const NEGATIVE_OR_QUOTED = /不要|不必|不需要|不需|不得|不能|不应|无需|无须|禁止|严禁|切勿|避免|\b(?:do\s+not|don['’]t|never|must\s+not|without)\b|```|^\s*>|[“「『]|(?:示例|例子|引用|原文|资料)\s*[:：]/im;

function isPlanningProtocol(content) {
    const text = content.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
    const schemas = [
        ['content', 'plot', 'characters', 'segments', 'end_state'],
        ['content', 'direction', 'beats', 'anchors', 'end_state'],
    ];
    return schemas.some(fields => fields.every(name => new RegExp(`<\\s*${name}(?:\\s|>)`, 'i').test(text))
        || (/XML|标签|层级|结构|输出格式|规划|大纲/i.test(text) && fields.every(name => new RegExp(`\\b${name}\\b`, 'i').test(text))));
}

function macroNames(content) {
    return [...content.matchAll(/\{\{\s*([^:{}\s]+)/g)].map(match => match[1].toLowerCase());
}

function isAdaptedStyleAdvice(advice, content) {
    // Mentioning prose/style while explicitly handing its expression to the
    // main writer is already compatible with planning. Other output conflicts
    // keep their own reasons and are never dismissed by this exception.
    return advice?.reason?.startsWith('涉及文风、视角或篇幅')
        && /大纲|规划|在\s*(?:plot|characters|segments|direction|beats|anchors|end_state)/i.test(content)
        && /(?:正文(?:表达|语言)|具体叙述句式|文风|描写).{0,30}(?:主预设|主API|主模型)|(?:主模型|正文主预设).{0,40}(?:文风|措辞|心理描写)/i.test(content);
}

// Only remove dependency syntax from a temporary inspection copy. Never expand
// variables or execute imported text; assignments are data, not instructions.
function withoutDependencies(content) {
    let result = '', cursor = 0;
    while (cursor < content.length) {
        const start = content.indexOf('{{', cursor);
        if (start < 0) { result += content.slice(cursor); break; }
        result += content.slice(cursor, start);
        let end = start + 2, depth = 1;
        while (end < content.length && depth) {
            if (content.startsWith('{{', end)) { depth++; end += 2; }
            else if (content.startsWith('}}', end)) { depth--; end += 2; }
            else end++;
        }
        const token = content.slice(start, end);
        const name = /^\{\{\s*([^:{}\s]+)/.exec(token)?.[1]?.toLowerCase();
        result += !depth && KNOWN_MACROS.has(name) ? ' ' : token;
        cursor = end;
    }
    return result
        .replace(/(?:定义变量|变量定义|变量初始化|初始化变量|变量赋值|声明变量|变量声明)[^\n。！？;；，,]*(?:[。;；，,]|$)/g, ' ')
        .replace(/(?:^|[\n;；])\s*(?:const|let|var)\s+[\w$]+\s*=[^;；\n]*(?:[;；]|$)/g, '\n');
}

function inspectDependencyContent(prompt) {
    const content = typeof prompt.content === 'string' ? prompt.content : '';
    const names = macroNames(content);
    if (names.some(name => !KNOWN_MACROS.has(name) && !name.startsWith('/'))) {
        return { reason: '含未识别的宏，需检查其含义与展开内容。', needsReview: true };
    }
    const stripped = withoutDependencies(content);
    const advice = analyzeImportedPreset({ prompts: [{ ...prompt, content: stripped }], order: [{ identifier: prompt.identifier, enabled: true }] });
    const conflict = advice.disable[0] || advice.review[0];
    if (conflict && !isAdaptedStyleAdvice(conflict, stripped)) return { reason: `${conflict.reason} 同时含资料或变量依赖，需按条目内容调整。`, needsReview: true };
    return { reason: '含资料或变量依赖，保留供预设使用。', needsReview: false };
}

/** Current, read-only import inspection. Flat items follow request order; grouped
 * items follow the same group order and in-group request order as the editor. */
export function buildImportReview(preset) {
    const prompts = new Map((preset?.prompts || []).map(prompt => [prompt.identifier, prompt]));
    const sourceGroups = [...(preset?.groups || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    const groupById = new Map(sourceGroups.map(group => [group.id, group]));
    const advice = analyzeImportedPreset(preset);
    const currentAdvice = new Map([...advice.disable, ...advice.review].map(item => [item.id, item]));
    const autoDisabled = new Map((preset?.importAdvice?.disable || []).map(item => [item.id, item]));
    const seen = new Set();
    const items = [];
    for (const entry of preset?.order || []) {
        const id = typeof entry === 'string' ? entry : entry?.identifier;
        const prompt = prompts.get(id);
        if (!prompt || seen.has(id)) continue;
        seen.add(id);
        const mapping = preset?.promptGroups?.[id];
        const mappedId = typeof mapping === 'string' ? mapping : mapping?.groupId;
        const group = groupById.get(mappedId);
        const entryEnabled = entry?.enabled !== false;
        const groupEnabled = group?.enabled !== false;
        const enabled = entryEnabled && groupEnabled;
        const kind = id === 'outline_output' ? 'format' : prompt.marker ? 'context' : 'prompt';
        let status = 'normal', reason = '', needsReview = false;
        if (kind === 'format') {
            status = enabled ? 'format' : 'review'; needsReview = !enabled;
            reason = enabled ? '固定输出接口已启用；故事内容可修改。' : '固定输出接口未启用，模型输出可能无法解析。';
        } else if (!enabled) {
            status = 'disabled';
            reason = autoDisabled.has(id) && !entryEnabled ? `导入时自动关闭：${autoDisabled.get(id).reason || '独立输出模块。'}`
                : !groupEnabled ? '所在分组已关闭，不参与请求。' : '条目已关闭，不参与请求。';
        } else if (kind === 'context') {
            status = 'info'; reason = '上下文占位，调用时填入对应资料。';
        } else {
            const content = typeof prompt.content === 'string' ? prompt.content : '';
            const found = currentAdvice.get(id);
            const current = isAdaptedStyleAdvice(found, content) ? null : found;
            const names = macroNames(content);
            const dependency = current && DEPENDENCY_REASON.test(current.reason);
            if (dependency || (names.length || DEFINITION.test(content)) && !current) {
                const checked = inspectDependencyContent(prompt);
                needsReview = checked.needsReview; reason = checked.reason;
                status = needsReview ? 'review' : 'info';
            } else if (current) {
                status = 'review'; reason = current.reason; needsReview = true;
            } else if (!isAdaptedStyleAdvice(found, content) && !id.startsWith('outline_') && NAME_HINT.test(prompt.name || '') && !NEGATIVE_OR_QUOTED.test(content) && !isPlanningProtocol(content)) {
                status = 'review'; needsReview = true;
                reason = '名称涉及输出或正文要求，尚未识别具体用途，请检查是否需要适配。';
            }
        }
        items.push({ id, name: prompt.name || id, kind, groupId: group?.id || '__ungrouped', groupName: group?.name || '未分组条目',
            enabled, entryEnabled, groupEnabled, status, reason, needsReview });
    }
    const groups = sourceGroups.map(group => ({ id: group.id, name: group.name, enabled: group.enabled !== false, items: items.filter(item => item.groupId === group.id) }));
    const ungrouped = items.filter(item => item.groupId === '__ungrouped');
    if (ungrouped.length) groups.push({ id: '__ungrouped', name: '未分组条目', enabled: true, items: ungrouped });
    const protocol = items.find(item => item.kind === 'format');
    return {
        message: !protocol ? '未找到已加入顺序的格式条目，请检查固定输出结构。' : !protocol.enabled ? '格式条目已关闭，模型输出可能无法解析。' : '格式条目已启用。',
        autoDisabledCount: items.filter(item => autoDisabled.has(item.id)).length,
        restorableCount: items.filter(item => autoDisabled.has(item.id) && !item.entryEnabled).length,
        items, groups,
    };
}
