import { cleanSettings, proseTarget } from './host.js';
import { normalizePreset, exportPreset } from './preset.js';
import { parseContent } from './content.js';

export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
export const VERSION_LIMIT = 50;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function check(condition, message) { if (!condition) throw new Error(message); }
function text(value, label, max, { required = false } = {}) {
    check(typeof value === 'string', `${label}必须是文本。`);
    check(value.length <= max, `${label}过长，最多 ${max} 个字符。`);
    check(!required || value.trim(), `${label}不能为空。`);
    return value;
}
function id(value, label = '标识') {
    const result = text(value, label, 160, { required: true });
    check(!/[\u0000-\u001f\u007f]/.test(result), `${label}含有无效字符。`);
    return result;
}
function list(value, label, max) {
    check(Array.isArray(value) && value.length <= max, `${label}必须是数组，最多 ${max} 项。`);
    return value;
}
function unique(items, label) {
    check(new Set(items.map(item => item.id)).size === items.length, `${label}包含重复标识。`);
    return items;
}

let versionCounter = 0;
export function makeVersion({ xml, input = '', label = '大纲版本', parentId = null } = {}, existing = []) {
    check(Array.isArray(existing), '已有版本列表无效。');
    const parsed = parseContent(xml);
    const ids = new Set(existing.map(item => item?.id));
    let nextId;
    do { nextId = `outline_${Date.now().toString(36)}_${(++versionCounter).toString(36)}_${Math.random().toString(36).slice(2, 10)}`; } while (ids.has(nextId));
    return { id: nextId, createdAt: new Date().toISOString(), label: text(label, '版本名称', 120, { required: true }).trim(),
        xml: parsed.xml, input: text(input, '版本输入', 200000), parentId: parentId == null ? null : id(parentId, '父版本标识') };
}

function safeEndpoint(value) {
    const result = text(value, 'API 地址', 2048).trim();
    if (!result) return '';
    let url;
    try { url = new URL(result); } catch { throw new Error('备份中的 API 地址无效。'); }
    check(['http:', 'https:'].includes(url.protocol), '备份仅接受 HTTP 或 HTTPS API 地址。');
    check(!url.username && !url.password && !url.search && !url.hash, '备份中的 API 地址不能含用户名、密码、查询参数或片段；请先将密钥从地址中移除。');
    return result;
}
function optionalNumber(value, label, { min, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
    if (value == null || value === '') return '';
    check(typeof value === 'string' || typeof value === 'number', `${label}格式无效。`);
    const number = Number(value);
    check(String(value).trim() && Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isSafeInteger(number)), `${label}超出允许范围。`);
    return String(value);
}
function connection(value) {
    return { baseUrl: safeEndpoint(value.baseUrl ?? ''), model: text(value.model ?? '', '模型名称', 256),
        temperature: optionalNumber(value.temperature ?? value.temp, '温度', { min: 0, max: 2 }),
        maxTokens: optionalNumber(value.maxTokens, '最大输出 token', { min: 1, integer: true }) };
}
function backupSettings(value) {
    check(record(value), '备份设置必须是对象。');
    for (const key of Object.keys(cleanSettings())) {
        if (value[key] === undefined) continue;
        if (key === 'autoOnSend') check(typeof value[key] === 'boolean', '自动规划开关必须是布尔值。');
        else check(['string', 'number'].includes(typeof value[key]) && String(value[key]).length <= 4096, `设置 ${key} 的格式或长度无效。`);
    }
    const result = { ...cleanSettings(value), ...connection(value) };
    proseTarget(result);
    if (value.mode !== undefined) check(['auto', 'manual', 'review'].includes(value.mode), '备份中的规划模式无效。');
    if (value.theme !== undefined) check(['system', 'light', 'dark', 'host'].includes(value.theme), '备份中的外观模式无效。');
    if (value.injectionPosition !== undefined) check(['before_prompt', 'in_prompt', 'in_chat'].includes(value.injectionPosition), '备份中的注入位置无效。');
    if (value.injectionRole !== undefined) check(['system', 'user', 'assistant'].includes(value.injectionRole), '备份中的注入角色无效。');
    if (value.injectionDepth !== undefined) check(/^\d+$/.test(String(value.injectionDepth)) && Number(value.injectionDepth) <= 10000, '备份中的注入深度无效。');
    return result;
}
function backupPreset(entry) {
    check(record(entry) && record(entry.preset), '规划方案必须包含有效预设。');
    const source = entry.preset.version && entry.preset.data ? entry.preset.data : entry.preset;
    list(source.prompts, '预设条目', 3000);
    const marker = source.extensions?.plot_workshop;
    const preserve = marker?.schema_version === 1 && marker?.preserve_prompt_selection === true;
    const name = text(entry.name ?? source.name ?? '规划方案', '规划方案名称', 120, { required: true });
    const normalized = normalizePreset(entry.preset, { name, characterId: entry.preset.characterId ?? 100001 });
    normalized.name = name;
    const preset = exportPreset(normalized);
    if (preserve) preset.extensions.plot_workshop = { schema_version: 1, preserve_prompt_selection: true };
    return { id: id(entry.id, '规划方案标识'), name, preset };
}
function backupVersion(entry) {
    check(record(entry), '大纲版本必须是对象。');
    const createdAt = text(entry.createdAt, '版本时间', 40, { required: true });
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(createdAt) && Number.isFinite(Date.parse(createdAt)), '版本时间必须是有效的 UTC 时间。');
    const canonicalTime = createdAt.includes('.') ? createdAt.replace(/\.(\d+)Z$/, (_, digits) => `.${digits.padEnd(3, '0')}Z`) : createdAt.replace(/Z$/, '.000Z');
    check(new Date(createdAt).toISOString() === canonicalTime, '版本时间包含无效的日期。');
    return { id: id(entry.id, '版本标识'), createdAt, label: text(entry.label ?? '大纲版本', '版本名称', 120, { required: true }),
        xml: parseContent(entry.xml).xml, input: text(entry.input ?? '', '版本输入', 200000), parentId: entry.parentId == null ? null : id(entry.parentId, '父版本标识') };
}

/** Accepts a data-only backup envelope. No credentials, raw memory, logs or host state are retained. */
export function sanitizeBackup(input) {
    let encoded;
    try { encoded = typeof input === 'string' ? input : JSON.stringify(input); }
    catch { throw new Error('备份必须是可序列化的 JSON 数据。'); }
    check(typeof encoded === 'string' && new TextEncoder().encode(encoded).byteLength <= BACKUP_MAX_BYTES, '备份文件超过 5 MB 或内容无效。');
    let value;
    try { value = JSON.parse(encoded); } catch { throw new Error('备份不是有效的 JSON。'); }
    check(record(value) && value.format === 'huapi-backup' && value.version === 1, '不是受支持的Vespera备份（huapi-backup v1）。');
    const settings = backupSettings(value.settings ?? {});
    const apiProfiles = unique(list(value.apiProfiles ?? [], 'API 方案', 30).map(profile => {
        check(record(profile), 'API 方案必须是对象。');
        return { id: id(profile.id, 'API 方案标识'), name: text(profile.name ?? 'API 方案', 'API 方案名称', 120, { required: true }), ...connection(profile) };
    }), 'API 方案');
    const presetLibrary = unique(list(value.presetLibrary ?? [], '规划方案', 20).map(backupPreset), '规划方案');
    const versions = unique(list(value.versions ?? [], '大纲版本', VERSION_LIMIT).map(backupVersion), '大纲版本');
    const byId = new Map(versions.map(item => [item.id, item]));
    for (const version of versions) {
        const seen = new Set([version.id]);
        let current = version;
        while (current.parentId && byId.has(current.parentId)) {
            check(!seen.has(current.parentId), '版本关联存在循环。');
            seen.add(current.parentId); current = byId.get(current.parentId);
        }
    }
    const extraWorldbooks = [...new Set(list(value.extraWorldbooks ?? [], '额外世界书', 50).map(name => text(name, '世界书名称', 500, { required: true })))];
    return { settings, apiProfiles, presetLibrary, versions, extraWorldbooks };
}
