// Read-only contracts checked against SillyTavern release:
// public/scripts/st-context.js (getWorldInfoNames/loadWorldInfo/getPresetManager),
// world-info.js (selected_world_info, world_info.charLore, METADATA_KEY),
// preset-manager.js (getPresetManager('openai').getPresetList()).
// No host preset selection, worldbook scan, macro expansion or save function is called.

export class HostLibraryError extends Error {
    constructor(message, code = 'HOST_LIBRARY_INVALID') { super(message); this.name = 'HostLibraryError'; this.code = code; }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition, message, code) { if (!condition) throw new HostLibraryError(message, code); }
function nameList(value, label) {
    assert(Array.isArray(value), `${label}不可用或不是名称列表。`, 'HOST_LIBRARY_UNAVAILABLE');
    assert(value.every(name => typeof name === 'string' && name.trim() && name.length <= 1024), `${label}含有无效名称。`);
    return [...new Set(value)];
}
function worldNames(context) {
    assert(typeof context?.getWorldInfoNames === 'function', '当前酒馆未提供世界书目录接口。', 'HOST_LIBRARY_UNAVAILABLE');
    return nameList(context.getWorldInfoNames(), '世界书目录');
}
function presetList(context) {
    assert(typeof context?.getPresetManager === 'function', '当前酒馆未提供预设目录接口。', 'HOST_LIBRARY_UNAVAILABLE');
    const manager = context.getPresetManager('openai');
    assert(manager && typeof manager.getPresetList === 'function', '聊天补全预设管理器尚未就绪。', 'HOST_LIBRARY_UNAVAILABLE');
    // Always request chat-completion presets, regardless of the main API currently selected.
    const data = manager.getPresetList('openai');
    assert(record(data) && Array.isArray(data.presets) && (Array.isArray(data.preset_names) || record(data.preset_names)), '聊天补全预设目录格式不受支持。');
    const names = Array.isArray(data.preset_names) ? data.preset_names.map((name, index) => [name, index]) : Object.entries(data.preset_names);
    const mapped = names.map(([name, index]) => {
        assert(typeof name === 'string' && name.trim() && name.length <= 1024, '预设目录含有无效名称。');
        assert((typeof index === 'number' || /^\d+$/.test(String(index))) && Number.isSafeInteger(Number(index)) && Number(index) >= 0 && Number(index) < data.presets.length, `预设“${name}”的目录索引无效。`);
        return { id: `openai:${encodeURIComponent(name)}`, name, index: Number(index) };
    });
    assert(new Set(mapped.map(item => item.name)).size === mapped.length, '预设目录名称重复。');
    return { mapped, data };
}
function mountedBooks(context, worldInfoModule) {
    assert(record(worldInfoModule) && Array.isArray(worldInfoModule.selected_world_info) && record(worldInfoModule.world_info), '无法读取酒馆完整的世界书挂载信息；额外选书暂不可用。', 'HOST_MOUNTS_UNKNOWN');
    const sources = new Map();
    const add = (name, source) => {
        if (name == null || name === '') return;
        assert(typeof name === 'string' && name.trim(), `世界书 ${source} 挂载名称无效。`);
        if (!sources.has(name)) sources.set(name, new Set());
        sources.get(name).add(source);
    };
    nameList(worldInfoModule.selected_world_info, '全局世界书挂载').forEach(name => add(name, 'global'));
    const character = context.groupId ? null : context.characters?.[context.characterId];
    add(character?.data?.extensions?.world, 'character');
    // Same filename rule as official utils.js getCharaFilename; no host macro utility needed.
    const filename = typeof character?.avatar === 'string' ? character.avatar.replace(/\.[^/.]+$/, '') : null;
    const extra = worldInfoModule.world_info.charLore;
    assert(extra === undefined || Array.isArray(extra), '角色附加世界书挂载信息格式无效。');
    const selected = filename ? extra?.find(entry => entry?.name === filename) : null;
    if (selected) nameList(selected.extraBooks ?? [], '角色附加世界书').forEach(name => add(name, 'extra'));
    add(context.powerUserSettings?.persona_description_lorebook, 'persona');
    add(context.chatMetadata?.[worldInfoModule.METADATA_KEY || 'world_info'], 'chat');
    return sources;
}

/** Synchronous, partial catalog: a missing preset API never hides a readable worldbook list. */
export function getHostCatalog({ context, worldInfoModule } = {}) {
    const errors = [];
    let worldbooks = [], presets = [], mountsKnown = false;
    try {
        const names = worldNames(context), mounted = mountedBooks(context, worldInfoModule);
        mountsKnown = true;
        const available = new Set(names);
        worldbooks = [...new Set([...names, ...mounted.keys()])].map(name => ({ name, sources: [...(mounted.get(name) || [])], mounted: mounted.has(name), available: available.has(name) }));
        if (worldbooks.some(book => !book.available)) errors.push('部分已挂载世界书不在当前目录中，请在酒馆检查这些挂载。');
    } catch (error) { errors.push(error instanceof HostLibraryError ? error.message : '世界书目录读取失败，请刷新酒馆后重试。'); }
    try { presets = presetList(context).mapped.map(({ id, name }) => ({ id, name })); }
    catch (error) { errors.push(error instanceof HostLibraryError ? error.message : '聊天补全预设目录读取失败。'); }
    return { worldbooks, presets, mountsKnown, status: errors.length ? 'partial' : 'ready', message: errors.join('\n') };
}

/** Returns an independent copy of a saved complete OpenAI/chat-completion preset. */
export function readHostPreset({ context, id } = {}) {
    assert(typeof id === 'string' && id.startsWith('openai:'), '请选择酒馆目录中的聊天补全预设。', 'HOST_PRESET_MISSING');
    const { mapped, data } = presetList(context);
    const entry = mapped.find(item => item.id === id);
    assert(entry, '所选酒馆预设已不存在，请刷新目录。', 'HOST_PRESET_MISSING');
    let source = data.presets[entry.index];
    try { if (typeof source === 'string') source = JSON.parse(source); }
    catch { throw new HostLibraryError('酒馆预设不是有效的 JSON。'); }
    assert(record(source), '所选酒馆预设数据无效。');
    try { return structuredClone(source); }
    catch { throw new HostLibraryError('酒馆预设包含无法读取的数据；仅支持数据型 JSON 预设。'); }
}

function aborted(signal) { if (signal?.aborted) throw new HostLibraryError('世界书读取已取消。', 'ABORTED'); }
async function cancellableLoad(context, name, signal) {
    aborted(signal);
    let cancel;
    try {
        const operation = Promise.resolve().then(() => { aborted(signal); return context.loadWorldInfo(name); });
        if (!signal) return await operation;
        return await Promise.race([operation, new Promise((_, reject) => {
            cancel = () => reject(new HostLibraryError('世界书读取已取消。', 'ABORTED'));
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
        })]);
    } finally { if (cancel) signal.removeEventListener('abort', cancel); }
}
function rejectScriptMetadata(value, label, depth = 0, seen = new Set()) {
    if (value == null || typeof value !== 'object') return;
    assert(depth < 16 && !seen.has(value), `${label}的扩展数据层级或引用无效。`);
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
        assert(typeof item !== 'function', `${label}含有不支持的可执行扩展。`, 'HOST_SCRIPT_UNSUPPORTED');
        if (/^(?:script|scripts|javascript)$/i.test(key)) {
            const empty = item == null || item === '' || item === false || (Array.isArray(item) && !item.length) || (record(item) && !Object.keys(item).length);
            assert(empty, `${label}含有不支持的脚本扩展；请先使用纯文本副本。`, 'HOST_SCRIPT_UNSUPPORTED');
        }
        if (item && typeof item === 'object') rejectScriptMetadata(item, label, depth + 1, seen);
    }
    seen.delete(value);
}

/** Explicit reference import: all enabled entries, not keyword activation or a memory update.
 * Caller must obtain a fresh catalog with mountsKnown=true and pass its complete mountedNames.
 * Text keeps macros verbatim. Pass it as runtime/context text, never through substituteParams.
 */
export async function readExtraWorldbooks({ context, names, mountedNames, signal } = {}) {
    const selected = nameList(names, '额外世界书选择');
    assert(selected.length <= 100, '一次最多额外读取 100 本世界书。');
    const mounted = new Set(nameList(mountedNames, '当前完整挂载列表'));
    aborted(signal);
    if (!selected.length) return { text: '', books: [], entries: [] };
    const available = new Set(worldNames(context));
    for (const name of selected) assert(available.has(name), `世界书“${name}”已不在酒馆目录中，请重新选择。`, 'HOST_WORLDBOOK_MISSING');
    const extras = selected.filter(name => !mounted.has(name));
    if (!extras.length) return { text: '', books: [], entries: [] };
    assert(typeof context?.loadWorldInfo === 'function', '当前酒馆未提供世界书读取接口。', 'HOST_LIBRARY_UNAVAILABLE');
    const chatId = context.chatId;
    const unchanged = () => assert((context.getCurrentChatId?.() ?? context.chatId) === chatId, '读取期间聊天已切换，请重新读取。', 'HOST_CONTEXT_CHANGED');
    const entries = [], books = [], sections = [];
    let bytes = 0;
    for (const name of extras) {
        aborted(signal); unchanged();
        let data;
        try { data = await cancellableLoad(context, name, signal); }
        catch (error) { if (error instanceof HostLibraryError) throw error; throw new HostLibraryError(`世界书“${name}”读取失败，请检查酒馆连接后重试。`, 'HOST_WORLDBOOK_READ_FAILED'); }
        aborted(signal); unchanged();
        assert(record(data) && record(data.entries), `世界书“${name}”读取失败或条目格式无效。`, 'HOST_WORLDBOOK_READ_FAILED');
        rejectScriptMetadata(data.extensions, `世界书“${name}”`);
        for (const key of ['script', 'scripts', 'javascript']) if (Object.hasOwn(data, key)) rejectScriptMetadata({ [key]: data[key] }, `世界书“${name}”`);
        const included = [];
        const all = Object.entries(data.entries);
        assert(all.length <= 50000, `世界书“${name}”条目过多；请拆分后读取。`);
        for (const [uid, entry] of all) {
            assert(record(entry), `世界书“${name}”包含无效条目。`);
            assert(entry.disable === undefined || [true, false, 0, 1, '0', '1'].includes(entry.disable), `世界书“${name}”的条目 ${uid} 启用状态无效。`);
            if (entry.disable === true || entry.disable === 1 || entry.disable === '1') continue;
            assert(typeof entry.content === 'string', `世界书“${name}”的条目 ${uid} 缺少文本。`);
            rejectScriptMetadata(entry.extensions, `世界书“${name}”的条目 ${uid}`);
            for (const key of ['script', 'scripts', 'javascript']) if (Object.hasOwn(entry, key)) rejectScriptMetadata({ [key]: entry[key] }, `世界书“${name}”的条目 ${uid}`);
            assert(!entry.automationId && !entry.extensions?.automation_id, `世界书“${name}”的条目 ${uid} 关联了自动化，不能作为纯文本书执行。请使用不含自动化的副本。`, 'HOST_SCRIPT_UNSUPPORTED');
            const item = { book: name, uid: String(entry.uid ?? uid), comment: typeof entry.comment === 'string' ? entry.comment : '', content: entry.content };
            const rendered = `【条目 ${item.uid}${item.comment ? ` · ${item.comment}` : ''}】\n${item.content}`;
            bytes += new TextEncoder().encode(rendered).byteLength;
            assert(bytes <= 10 * 1024 * 1024, '额外世界书内容超过 10 MB，请减少选择；未截断或发送任何内容。');
            included.push(rendered); entries.push(item);
        }
        books.push({ name, count: included.length });
        sections.push(`【额外参考世界书：${name}；${included.length} 个启用条目】\n${included.length ? included.join('\n\n') : '此书没有启用条目。'}`);
    }
    aborted(signal); unchanged();
    return { text: '【只供本轮规划的额外世界书参考】\n以下内容按文件中的启用条目完整读取，不代表酒馆关键词扫描命中，不改变原有挂载或记忆。宏保持字面文本，不执行脚本。\n\n' + sections.join('\n\n'), books, entries };
}
