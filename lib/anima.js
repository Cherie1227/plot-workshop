/**
 * Upstream: Ellinav / Ellina, Anima-Memory-System and anima-rag.
 * Upstream material and adapted portions: CC BY-NC 4.0.
 * https://creativecommons.org/licenses/by-nc/4.0/
 * Attribution, source links and modifications: ../THIRD_PARTY_NOTICES.md.
 * Ellinav Anima adapter. Reviewed frontend 3.3.6 at
 * d92dfc4dc741386962091ac149a7ed4b4b04e95d and anima-rag at
 * 4ee45d16f3a40a65903cde9d75cbdb79d9e6ae48.
 * Only Anima's official dynamic-container writers are called; no summary,
 * message variable, memory vector, or chat content is written by this module.
 * Anima's own queryDual DOES update backend Echo state and may retry internally.
 */
export class AnimaError extends Error {
    constructor(message, code = 'ANIMA_FAILED') {
        super(message);
        this.name = 'AnimaError';
        this.code = code;
    }
}

export const ANIMA_FRONTEND_VERSION = '3.3.6';
export const DEFAULT_ANIMA_PATH = '/scripts/extensions/third-party/Anima-Memory-System';
const ECHO_WARNING = 'Anima 查询会立即更新 Echo 回响状态；取消或后续生成失败不会回滚，官方 queryDual 还可能内部重试。';
const moduleLoads = new Map();
let epoch = 0;
let generationActive = false;
let observation = null;
let installedObserver = null;
let directQueryInFlight = false;
let nativeQueryInFlight = false;
let dynamicSyncInFlight = 0;
let recallReuseGuard = null;
// Only the currently planned round, never persisted or populated from an old
// global Anima payload. A new input/history/settings key replaces this snapshot.
let roundCache = null;
let cacheRevision = 0;

/** Covers the whole original native interceptor (including its worldbook writes),
 * direct queryDual, and awaited adapter dynamic-container synchronization. */
export function isAnimaMemoryOperationInFlight() {
    return directQueryInFlight || nativeQueryInFlight || dynamicSyncInFlight > 0;
}

function fail(message, code) { throw new AnimaError(message, code); }
function checkAbort(signal) {
    if (signal?.aborted) fail('Anima 读取已取消；已提交的原生查询可能仍在完成。', 'ABORTED');
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function status(onStatus, message) { if (typeof onStatus === 'function') onStatus(message); }
function contextNow(fallback) { return globalThis.SillyTavern?.getContext?.() || fallback; }
function idOf(context) { return String(context?.chatId ?? context?.getCurrentChatId?.() ?? ''); }
function contextSignature(context) {
    return JSON.stringify({
        chatId: idOf(context), characterId: context?.characterId ?? null, groupId: context?.groupId ?? null,
        character: context?.characters?.[context?.characterId]?.data ?? null,
        bindings: context?.chatMetadata?.anima_rag_active_files ?? null,
        chat: (context?.chat || []).map(m => [m.is_user, m.is_system, m.name, m.mes ?? m.message ?? '', m.swipe_id ?? null]),
    });
}
function roundKey(context, userInput, settings, modules) {
    const messages = inputMessages(context, userInput, settings);
    const history = messages.slice(0, -1);
    const config = context.extensionSettings.anima_memory_system;
    return JSON.stringify({
        source: modules.base,
        story: contextSignature({ ...context, chat: history }),
        userInput,
        effectiveRag: modules.rag.getEffectiveSettings(),
        bm25: config.bm25 ?? null, kb: config.kb_settings ?? null,
        status: config.status ?? null, api: config.api ?? null,
    });
}
function cachedFor(key) {
    if (roundCache && roundCache.key !== key) roundCache = null;
    return roundCache?.key === key ? roundCache : null;
}
function cachedResult(cache, nativeAlreadyInjected = false) {
    return { ...copy(cache.result), nativeAlreadyInjected, reusedForRound: true };
}

/** Call only when a writer reply is actually committed, or the chat is left.
 * Generation end/cancel/error alone must NOT discard this round's memory. */
export function invalidateAnimaRoundCache() {
    roundCache = null;
    cacheRevision += 1;
}
function assertCurrent(context, signature, signal) {
    checkAbort(signal);
    if (contextSignature(contextNow(context)) !== signature) {
        fail('读取期间聊天、角色或历史已改变，请在当前聊天重新生成大纲。', 'ANIMA_CONTEXT_CHANGED');
    }
}
function validateContext(context) {
    if (!idOf(context) || !Array.isArray(context?.chat)) fail('请先打开一个有效聊天。', 'ANIMA_CHAT_REQUIRED');
    if (!context.extensionSettings?.anima_memory_system) fail('未发现 Ellinav Anima 的配置，请先安装并初始化 Anima。', 'ANIMA_UNAVAILABLE');
}
function frontendBase(settings) {
    const origin = globalThis.location?.origin;
    if (!origin) fail('Anima 适配器需要在酒馆页面运行。', 'ANIMA_ENVIRONMENT');
    let url;
    try { url = new URL(settings.frontendPath || DEFAULT_ANIMA_PATH, origin); }
    catch { fail('Anima 前端目录格式不正确。', 'ANIMA_PATH'); }
    if (url.origin !== origin || !url.pathname.startsWith('/scripts/extensions/third-party/') || url.search || url.hash) {
        fail('Anima 前端目录必须是当前酒馆下已安装的 third-party 扩展目录。', 'ANIMA_PATH');
    }
    return url.href.replace(/\/+$/, '');
}

/** Loads installed local modules, not remote GitHub code. No model request here. */
export async function inspectAnima({ settings = {} } = {}) {
    const base = frontendBase(settings);
    if (!moduleLoads.has(base)) {
        const loading = (async () => {
            let manifest;
            try {
                const response = await fetch(`${base}/manifest.json`, { credentials: 'same-origin', cache: 'no-store' });
                if (!response.ok) throw new Error();
                manifest = await response.json();
            } catch { fail('无法读取 Anima manifest，请检查实际安装目录。', 'ANIMA_UNAVAILABLE'); }
            if (manifest.version !== ANIMA_FRONTEND_VERSION || manifest.generate_interceptor !== 'Anima_RAG_Interceptor') {
                fail(`当前适配器核验的是 Ellinav Anima ${ANIMA_FRONTEND_VERSION}；检测到 ${String(manifest.version || '未知版本')}，请先核对接口。`, 'ANIMA_VERSION');
            }
            let rag, utils, kb, bm25, worldbook;
            try {
                [rag, utils, kb, bm25, worldbook] = await Promise.all([
                    import(`${base}/scripts/rag_logic.js`), import(`${base}/scripts/utils.js`),
                    import(`${base}/scripts/knowledge.js`), import(`${base}/scripts/bm25_logic.js`),
                    import(`${base}/scripts/worldbook_api.js`),
                ]);
            } catch { fail('Anima 前端依赖加载失败，请确认 Anima 和酒馆助手均已正常加载。', 'ANIMA_DEPENDENCY'); }
            for (const [object, method] of [[rag, 'queryDual'], [rag, 'getEffectiveSettings'], [rag, 'getLastRetrievalPayload'], [utils, 'getSmartCollectionId'], [utils, 'processMacros'], [utils, 'applyRegexRules'], [kb, 'getKbSearchPayload'], [bm25, 'getBm25BackendConfig'], [worldbook, 'updateRagEntry'], [worldbook, 'updateKnowledgeEntry']]) {
                if (typeof object[method] !== 'function') fail(`Anima 缺少已核验接口 ${method}。`, 'ANIMA_VERSION');
            }
            return { manifest: copy(manifest), base, rag, utils, kb, bm25, worldbook };
        })();
        moduleLoads.set(base, loading);
        loading.catch(() => moduleLoads.delete(base));
    }
    return moduleLoads.get(base);
}

/** Call from GENERATION_STARTED, before ST runs generation interceptors. */
export function beginAnimaGeneration() {
    epoch += 1;
    generationActive = true;
    observation = null;
    return epoch;
}

export function clearAnimaGeneration(token) {
    if (token === epoch) {
        observation = null;
        generationActive = false;
        epoch += 1;
    }
}

/**
 * Register immediately before sending a confirmed manual plan. The caller must
 * compare its exact planned chat/history/input snapshot in matches(). Consumed
 * on the next normal/chat interceptor attempt, even when it does not match.
 * Returns a disposer for failed/cancelled generate calls.
 */
export function skipNextAnimaRecall({ matches } = {}) {
    if (typeof matches !== 'function') fail('复用 Anima 召回必须提供精确上下文匹配函数。', 'ANIMA_REUSE_GUARD');
    if (!installedObserver || globalThis.Anima_RAG_Interceptor !== installedObserver.wrapper) {
        fail('Anima 观测器未就绪，不能跳过原生召回。', 'ANIMA_OBSERVER_REQUIRED');
    }
    const guard = { matches };
    recallReuseGuard = guard;
    return () => { if (recallReuseGuard === guard) recallReuseGuard = null; };
}

/**
 * Install once after Anima initializes, before generating. Captures ONLY a native
 * call occurring after beginAnimaGeneration; old global payloads are never used.
 */
export async function installAnimaObserver({ settings = {}, onStatus } = {}) {
    const modules = await inspectAnima({ settings });
    if (installedObserver?.wrapper === globalThis.Anima_RAG_Interceptor) return { version: modules.manifest.version };
    const original = globalThis.Anima_RAG_Interceptor;
    if (typeof original !== 'function') fail('Anima 原生拦截器尚未就绪，请待 Anima 加载后重试。', 'ANIMA_NOT_READY');
    const wrapper = async function (...args) {
        const token = generationActive ? epoch : 0;
        if (directQueryInFlight || nativeQueryInFlight) {
            // ST logs interceptor exceptions and continues, so throwing alone
            // cannot stop a normal send while manual planning is still running.
            try { if (typeof args[2] === 'function') args[2](true); }
            catch { /* Still reject with the adapter's actionable busy error. */ }
            fail('上一笔 Anima 召回仍在执行，当前生成已停止以避免重复推进记忆保留轮次。', 'ANIMA_BUSY');
        }
        const start = contextNow();
        const signature = contextSignature(start);
        const revision = cacheRevision;
        const latestInput = start?.chat?.at(-1);
        const input = latestInput && (latestInput.is_user === true || latestInput.role === 'user')
            ? latestInput.mes ?? latestInput.message ?? '' : '';
        const nativeRoundKey = input && (!args[3] || ['chat', 'normal'].includes(args[3]))
            ? roundKey(start, input, { inputAlreadyInChat: true }, modules) : null;
        if (recallReuseGuard && (!args[3] || ['chat', 'normal'].includes(args[3]))) {
            const guard = recallReuseGuard;
            recallReuseGuard = null;
            // A thrown or nonmatching check must never disable native Anima.
            let matches = false;
            try { matches = (await guard.matches()) === true; } catch { /* run native */ }
            if (matches && signature === contextSignature(contextNow())) {
                if (token) observation = { token, pending: false, consumed: true, signature, reused: true };
                return;
            }
        }
        if (token && (!args[3] || ['chat', 'normal'].includes(args[3])) && !directQueryInFlight) {
            if (nativeRoundKey) {
                const key = nativeRoundKey;
                const cached = cachedFor(key);
                if (cached) {
                    // This is a NEW observation of reuse for THIS generation,
                    // backed by this same round's completed successful recall.
                    observation = { token, pending: false, consumed: false, signature,
                        finalSignature: signature, cachedKey: key, completedAt: Date.now() };
                    status(onStatus, '复用当前轮已读取的 Anima 记忆，不额外消耗 Echo 保留轮次。');
                    return;
                }
            }
        }
        const before = modules.rag.getLastRetrievalPayload();
        let expectedQueries = null;
        let queryCheckFailed = false;
        if (token && modules.rag.getEffectiveSettings().rag_enabled !== false) {
            try {
                const raw = typeof globalThis.TavernHelper?.getChatMessages === 'function'
                    ? await globalThis.TavernHelper.getChatMessages('0-{{lastMessageId}}', { include_swipes: false })
                    : start.chat;
                const latestUser = [...raw].reverse().find(m => m.is_user === true || m.role === 'user');
                const queryContext = { ...start, chat: raw };
                // Auto generation has already appended its current user message.
                // Regeneration modes with different history handling fail closed.
                expectedQueries = buildQueries(queryContext, latestUser?.message || latestUser?.mes || '', { inputAlreadyInChat: true }, modules.rag.getEffectiveSettings(), modules);
            } catch { queryCheckFailed = true; }
        }
        if (token) observation = { token, pending: true, consumed: false, signature };
        nativeQueryInFlight = true;
        try {
            const result = await original.apply(this, args);
            const after = modules.rag.getLastRetrievalPayload();
            const freshPayload = after && after !== before ? copy(after) : null;
            // Keep a proven successful raw recall even if this generation was
            // cancelled before our planner interceptor ran. Formatting/summary
            // validation still happens before it can be given to either model.
            if (token && nativeRoundKey && revision === cacheRevision && signature === contextSignature(contextNow())) {
                try {
                    const ragOff = modules.rag.getEffectiveSettings().rag_enabled === false;
                    if (!ragOff) {
                        validatePayload(freshPayload);
                        if (queryCheckFailed || !expectedQueries || freshPayload.query !== expectedQueries.searchText || freshPayload.bm25Query !== expectedQueries.bm25SearchText) throw new Error();
                    }
                    if (nativeRoundKey === roundKey(contextNow(), input, { inputAlreadyInChat: true }, modules)) {
                        roundCache = { key: nativeRoundKey, payload: freshPayload, result: null, readAt: Date.now() };
                    }
                } catch { /* Invalid/failed recalls never enter the round cache. */ }
            }
            if (token && token === epoch) {
                observation = {
                    token, pending: false, consumed: false, signature,
                    finalSignature: contextSignature(contextNow()),
                    payload: freshPayload,
                    completedAt: Date.now(), type: args[3], expectedQueries, queryCheckFailed,
                };
            }
            return result;
        } catch (error) {
            if (token === epoch) observation = { token, pending: false, consumed: false, signature, failed: true };
            throw error;
        } finally { nativeQueryInFlight = false; }
    };
    globalThis.Anima_RAG_Interceptor = wrapper;
    installedObserver = { wrapper, original, base: modules.base };
    status(onStatus, '已观测 Anima 原生召回；自动模式只使用当前生成产生的新结果。');
    return { version: modules.manifest.version };
}

function validatePayload(payload) {
    if (!payload || payload.error || payload.success === false || payload._is_critical_failure) {
        fail('Anima 本轮召回失败，已停止规划。请在 Anima 面板检查连接与错误。', 'ANIMA_QUERY_FAILED');
    }
    if (!Array.isArray(payload.merged_chat_results) || !Array.isArray(payload.merged_kb_results)) {
        fail('Anima 未返回完整的新召回结构；未绑定数据库、空检索词或不兼容版本不能当成成功空命中。', 'ANIMA_QUERY_NOT_COMPLETED');
    }
    for (const item of [...payload.merged_chat_results, ...payload.merged_kb_results]) {
        if (!item || typeof item.text !== 'string') fail('Anima 召回条目结构异常。', 'ANIMA_RESPONSE_INVALID');
    }
    return payload;
}

function safeMacros(text, modules) {
    // This adapter only needs read macros; prevent preset/query text from writing ST variables.
    if (/\{\{\s*(?:set(?:global)?var|add(?:global)?var|inc(?:global)?var|dec(?:global)?var|flush(?:global)?var|set_[a-z]+_variable)\b/i.test(text)) {
        fail('Anima 检索模板含写变量宏，规划读取不执行这类宏，请改为只读模板。', 'ANIMA_WRITE_MACRO');
    }
    const rendered = modules.utils.processMacros(text);
    if (typeof rendered !== 'string' || /\{\{[^{}]+\}\}/.test(rendered) || rendered === '[Error]') {
        fail('Anima 检索或状态模板中有未解析的宏，不能静默遗漏。', 'ANIMA_MACRO');
    }
    return rendered;
}

function inputMessages(context, userInput, settings) {
    const messages = context.chat.map((m, i) => ({ ...m, message_id: i }));
    const last = messages.at(-1);
    const alreadyPresent = last && (last.is_user === true || last.role === 'user') && (last.mes ?? last.message) === userInput;
    if (settings.inputAlreadyInChat === true && !alreadyPresent) fail('本轮输入与聊天末条消息不一致。', 'ANIMA_INPUT_CHANGED');
    if (settings.inputAlreadyInChat === false || !alreadyPresent) messages.push({ role: 'user', is_user: true, mes: userInput, message_id: messages.length });
    return messages;
}

// Equivalent query selection to the reviewed interceptor, but uses a frozen
// history plus the pending draft instead of reading TavernHelper's old last user.
function buildQueries(context, userInput, settings, ragSettings, modules) {
    const all = inputMessages(context, userInput, settings);
    const isUser = m => m.role === 'user' || m.is_user === true;
    const filter = (skipZero, excludeUser = false) => all.filter((m, i) =>
        !(m.is_system && !m.role) && !(skipZero && i === 0) && !(excludeUser && isUser(m)) && (m.message || m.mes));
    const contextBlock = (messages, count, regex, skipUser, expandMacros = false) => messages.slice(-count).map(m => {
        let content = m.message || m.mes || '';
        if (expandMacros) content = safeMacros(content, modules).replace(/^(?:\s*(?:&gt;|>)\s*)+/i, '');
        if (!(skipUser && isUser(m)) && regex?.length) content = modules.utils.applyRegexRules(content, regex);
        return content.trim() ? `${isUser(m) ? 'user' : 'assistant'}: ${content.trim()}` : '';
    }).filter(Boolean).join('\n');
    const vectorParts = (ragSettings.vector_prompt || []).map(item => item.type === 'context'
        ? contextBlock(filter(ragSettings.skip_layer_zero), parseInt(item.count, 10) || 5, ragSettings.regex_strings, ragSettings.regex_skip_user)
        : item.content?.trim() ? safeMacros(item.content.trim(), modules) : '');
    const bm25Settings = context.extensionSettings.anima_memory_system.bm25 || {};
    const c = bm25Settings.content_settings || {};
    const reuse = c.reuse_rag_regex;
    const bm25Messages = filter(reuse ? (ragSettings.skip_layer_zero ?? true) : (c.skip_layer_zero ?? true), reuse ? false : (c.exclude_user ?? false));
    const bm25Parts = (c.prompt_items || []).map(item => item.id === 'floor_content'
        ? contextBlock(bm25Messages, parseInt(item.count, 10) || 1, reuse ? ragSettings.regex_strings : c.regex_list, reuse ? ragSettings.regex_skip_user : c.regex_skip_user, true)
        : item.type === 'text' && item.content?.trim() ? safeMacros(item.content.trim(), modules) : '');
    const searchText = safeMacros(vectorParts.filter(Boolean).join('\n\n').trim(), modules);
    const bm25SearchText = bm25Parts.filter(Boolean).join('\n\n').trim();
    if (!searchText && !bm25SearchText) fail('Anima 检索模板没有产生本轮检索词，请检查检索内容设置。', 'ANIMA_EMPTY_QUERY');
    // A static-only template cannot associate a manual request with this turn.
    const hasVectorContext = (ragSettings.vector_prompt || []).some(i => i.type === 'context');
    const hasBm25Context = (c.prompt_items || []).some(i => i.id === 'floor_content') && !(reuse ? false : c.exclude_user);
    if (!hasVectorContext && !hasBm25Context) fail('Anima 检索模板未包含当前输入，请启用聊天内容条目后再规划。', 'ANIMA_QUERY_WITHOUT_INPUT');
    const latest = [all.at(-1)];
    const vectorKeepsInput = hasVectorContext && contextBlock(latest, 1, ragSettings.regex_strings, ragSettings.regex_skip_user).trim();
    const bm25KeepsInput = hasBm25Context && contextBlock(latest, 1, reuse ? ragSettings.regex_strings : c.regex_list, reuse ? ragSettings.regex_skip_user : c.regex_skip_user, true).trim();
    if (!vectorKeepsInput && !bm25KeepsInput) fail('Anima 检索清理规则删除了本轮输入，不能用旧历史代替当前查询。', 'ANIMA_QUERY_WITHOUT_INPUT');
    return { searchText, bm25SearchText };
}

function getHelper() {
    const helper = globalThis.TavernHelper;
    for (const method of ['getChatWorldbookName', 'getWorldbook', 'getVariables']) {
        if (typeof helper?.[method] !== 'function') fail(`Anima 记忆读取需要酒馆助手 ${method} 接口。`, 'ANIMA_HELPER_REQUIRED');
    }
    return helper;
}

async function readWorldbook(context, signature, signal) {
    const helper = getHelper();
    const name = await helper.getChatWorldbookName('current');
    assertCurrent(context, signature, signal);
    if (!name) {
        const names = typeof helper.getWorldbookNames === 'function' ? await helper.getWorldbookNames() : [];
        if (Array.isArray(names) && names.includes(idOf(context).replace(/\.(json|jsonl)$/i, ''))) {
            fail('Anima 同名记忆世界书存在但未绑定；请先在 Anima 修复绑定，规划插件不会自动改写绑定。', 'ANIMA_WORLDBOOK_UNBOUND');
        }
        return [];
    }
    const entries = await helper.getWorldbook(name);
    assertCurrent(context, signature, signal);
    if (!Array.isArray(entries)) fail('Anima 世界书读取返回了异常结构。', 'ANIMA_WORLDBOOK_INVALID');
    return entries;
}

function recentSummaries(entries, count) {
    if (!count) return { text: '', ids: [] };
    if (!Number.isInteger(count) || count < 0) fail('Anima 最近摘要数量配置无效。', 'ANIMA_SETTINGS');
    const slices = [];
    for (const entry of entries) {
        if (entry.extra?.createdBy !== 'anima_summary') continue;
        if (!Array.isArray(entry.extra.history)) fail('Anima 摘要缺少切片历史，无法可靠读取最近记忆。', 'ANIMA_SUMMARY_INVALID');
        for (const h of entry.extra.history) {
            const rawTime = h.narrative_time ?? entry.extra.narrative_time;
            const numeric = Number(rawTime);
            const time = Number.isFinite(numeric) && numeric > 0 ? numeric : rawTime == null ? NaN : new Date(rawTime).getTime();
            slices.push({ batch: Number(h.batch_id ?? h.index), slice: Number(h.slice_id ?? 0), id: String(h.unique_id ?? h.index), text: entry.content, time });
        }
    }
    const times = slices.map(s => s.time).filter(Number.isFinite);
    const latest = times.length ? Math.max(...times) : null;
    const selected = slices.filter(s => latest === null || s.time === latest).sort((a, b) => b.batch - a.batch || b.slice - a.slice).slice(0, count).reverse();
    const parts = [];
    for (const item of selected) {
        const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = typeof item.text === 'string' ? item.text.match(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`)) : null;
        if (!match) fail('Anima 最近摘要的切片索引与内容不一致，已停止规划。', 'ANIMA_SUMMARY_INVALID');
        parts.push(match[1].trim());
    }
    return { text: parts.join('\n\n'), ids: selected.map(s => s.id) };
}

async function readStatus(context, entries, modules, signature, signal) {
    const entry = entries.find(e => e.name === '[anima_status]');
    const configured = context.extensionSettings.anima_memory_system.status?.status_enabled === true;
    if (entry ? entry.enabled === false : !configured) return '';
    const helper = getHelper();
    let state;
    // Matches Anima's get/format_message_variable fallback window.
    for (let i = context.chat.length - 1; i >= Math.max(0, context.chat.length - 50); i -= 1) {
        const variables = await helper.getVariables({ type: 'message', message_id: i });
        assertCurrent(context, signature, signal);
        if (variables != null && (typeof variables !== 'object' || Array.isArray(variables))) fail('Anima 状态变量读取结构异常。', 'ANIMA_STATUS_INVALID');
        if (variables?.anima_data != null) { state = variables.anima_data; break; }
    }
    if (state == null) return '';
    if (entry?.content) return safeMacros(entry.content, modules);
    return typeof state === 'string' ? state : JSON.stringify(state, null, 2);
}

function bm25Payload(context, modules, currentChatId, extraChatFiles, kbPayload) {
    const config = context.extensionSettings.anima_memory_system.bm25 || {};
    const output = { chat: [], kb: kbPayload.bm25ConfigsKb || [], chat_top_k: config.search_top_k || 3 };
    const role = context.characters?.[context.characterId]?.data?.extensions?.anima_bm25_settings?.bound_dict;
    for (const dbId of new Set([currentChatId, ...extraChatFiles].filter(Boolean))) {
        const dictionary = config.dict_mapping?.[dbId]?.dict || role || null;
        const value = modules.bm25.getBm25BackendConfig(dictionary);
        if (value.enabled) output.chat.push({ dbId, dictionary: value.dictionary });
    }
    return output;
}

function formatMemory(payload, recent, entries, ragSettings, state, context, modules) {
    const parts = [];
    if (ragSettings.rag_enabled === false) {
        const enabled = entries.filter(e => e.enabled !== false && e.extra?.createdBy === 'anima_summary');
        for (const entry of enabled) {
            if (typeof entry.content !== 'string') fail('Anima 已启用摘要内容异常。', 'ANIMA_SUMMARY_INVALID');
            if (entry.content.trim()) parts.push(`[Anima 摘要：${entry.name || entry.uid}]\n${entry.content}`);
        }
    } else {
        const chat = payload.merged_chat_results.map(i => i.text).join('\n\n');
        if (chat || recent.text) {
            const template = ragSettings.injection_settings?.template || '{{chatHistory}}';
            let memory = template.replace(/\{\{(?:chatHistory|rag)\}\}/gi, () => chat).replace(/\{\{recent_history\}\}/gi, () => recent.text);
            memory = safeMacros(memory, modules);
            if (memory.trim()) parts.push(`[Anima 聊天记忆]\n${memory}`);
            // Keep selected recent summaries visible even if an old custom template
            // forgot its placeholder; they have already been excluded from RAG.
            if (recent.text && !/\{\{recent_history\}\}/i.test(template)) parts.push(`[Anima 最近摘要]\n${recent.text}`);
        }
        const kb = payload.merged_kb_results.map(i => `[Source: ${i.doc_name || 'Unknown Document'}]\n${i.text}`).join('\n\n');
        if (kb) {
            const template = context.extensionSettings.anima_memory_system.kb_settings?.knowledge_injection?.template || '以下是相关设定：\n{{knowledge}}';
            parts.push(`[Anima 知识库]\n${safeMacros(template.replace(/\{\{knowledge\}\}/gi, () => kb), modules)}`);
        }
    }
    if (state.trim()) parts.push(`[Anima 当前状态]\n${state}`);
    return parts.join('\n\n').trim();
}

function dynamicContainerContent(payload, recent, ragSettings, context) {
    if (ragSettings.rag_enabled === false) return null;
    const chat = payload.merged_chat_results.map(i => i.text).join('\n\n');
    const template = ragSettings.injection_settings?.template || '{{chatHistory}}';
    const chatText = chat.trim() || recent.text.trim()
        ? template.replace(/\{\{(?:chatHistory|rag)\}\}/gi, () => chat).replace(/\{\{recent_history\}\}/gi, () => recent.text) : '';
    // Match Anima's native source grouping and template, without adding wrapper text.
    let kb = '', doc = '';
    for (const item of payload.merged_kb_results) {
        const nextDoc = item.doc_name || 'Unknown Document';
        if (nextDoc !== doc) { kb += `${kb ? '\n\n' : ''}[Source: ${nextDoc}]\n`; doc = nextDoc; }
        else kb += '\n...\n';
        kb += item.text;
    }
    const kbTemplate = context.extensionSettings.anima_memory_system.kb_settings?.knowledge_injection?.template || '以下是相关设定：\n{{knowledge}}';
    return { chat: chatText, kb: kb.trim() ? kbTemplate.replace(/\{\{knowledge\}\}/gi, () => kb) : '', settings: copy(ragSettings.injection_settings || {}) };
}

async function syncDynamicContainers(dynamic, context, signature, signal, modules) {
    dynamicSyncInFlight += 1;
    try { return await performDynamicContainerSync(dynamic, context, signature, signal, modules); }
    finally { dynamicSyncInFlight -= 1; }
}

async function performDynamicContainerSync(dynamic, context, signature, signal, modules) {
    if (!dynamic) return false;
    assertCurrent(context, signature, signal);
    let entries = await readWorldbook(context, signature, signal);
    const matches = (list, name, content) => {
        const entry = list.find(e => e.name === name);
        return content ? entry?.content === content && entry.enabled !== false : !entry || !entry.content?.trim();
    };
    const actions = [
        ['[ANIMA_Chat_History_Container]', dynamic.chat, () => modules.worldbook.updateRagEntry(dynamic.chat, dynamic.settings)],
        ['[ANIMA_Knowledge_Container]', dynamic.kb, () => modules.worldbook.updateKnowledgeEntry(dynamic.kb)],
    ];
    for (const [name, content, write] of actions) {
        if (matches(entries, name, content)) continue;
        assertCurrent(context, signature, signal);
        // updateKnowledgeEntry in the reviewed version expects this helper to
        // return a synchronous name; accepting a Promise can target the wrong book.
        const binding = getHelper().getChatWorldbookName('current');
        if (binding && typeof binding.then === 'function') fail('当前酒馆助手的世界书名称接口与已核验 Anima 不兼容。', 'ANIMA_HELPER_VERSION');
        try { await write(); }
        catch { fail('Anima 本轮动态记忆容器更新失败，已停止规划。', 'ANIMA_CONTAINER_WRITE'); }
        assertCurrent(context, signature, signal);
        entries = await readWorldbook(context, signature, signal);
        if (!matches(entries, name, content)) fail('Anima 动态记忆容器读回不一致，不能带着上轮记忆继续规划。', 'ANIMA_CONTAINER_VERIFY');
    }
    return true;
}

async function reuseResult(cache, context, signature, signal, modules, nativeAlreadyInjected = false) {
    const dynamicContainersReady = await syncDynamicContainers(cache.dynamic, context, signature, signal, modules);
    assertCurrent(context, signature, signal);
    return { ...cachedResult(cache, nativeAlreadyInjected), dynamicContainersReady };
}

/**
 * settings: {frontendPath?, inputAlreadyInChat?}. Native original-generation
 * reuse additionally requires generationToken from beginAnimaGeneration().
 * A returned empty status means successful reads with no effective memory text.
 */
export async function recallAnima({ context, userInput, signal, settings = {}, onStatus, generationToken } = {}) {
    checkAbort(signal);
    context = context || contextNow();
    validateContext(context);
    if (typeof userInput !== 'string' || !userInput.trim()) fail('本轮输入为空，不能构造 Anima 查询。', 'ANIMA_INPUT_REQUIRED');
    const signature = contextSignature(context);
    assertCurrent(context, signature, signal);
    const modules = await inspectAnima({ settings });
    assertCurrent(context, signature, signal);
    const key = roundKey(context, userInput, generationToken === undefined ? settings : { ...settings, inputAlreadyInChat: true }, modules);
    const revision = cacheRevision;
    const cached = cachedFor(key);
    let reuseCachedPayload = false;
    let cachedNativeInjected = false;
    if (generationToken === undefined && cached) {
        status(onStatus, '读取当前轮已完成的 Anima 记忆快照；重新规划不额外推进 Echo 保留轮次。');
        if (cached.result) return reuseResult(cached, context, signature, signal, modules);
        reuseCachedPayload = true;
    }
    if (generationToken !== undefined && observation?.cachedKey === key) {
        const current = observation;
        if (!cached || generationToken !== epoch || current.token !== generationToken || current.signature !== signature || current.finalSignature !== signature
            || !installedObserver || globalThis.Anima_RAG_Interceptor !== installedObserver.wrapper) {
            fail('本次生成的 Anima 复用记录已失效，请重新规划。', 'ANIMA_FRESH_RESULT_REQUIRED');
        }
        current.consumed = true;
        status(onStatus, '本次生成使用同一轮已完成的 Anima 召回，不重复消耗记忆保留轮次。');
        if (cached.result) return reuseResult(cached, context, signature, signal, modules);
        reuseCachedPayload = true;
    }
    // Retrying the planner within a single interceptor does not run Anima again.
    if (generationToken !== undefined && cached && observation?.token === generationToken && observation.consumed
        && generationToken === epoch && observation.signature === signature && observation.finalSignature === signature) {
        cachedNativeInjected = !observation.cachedKey;
        if (cached.result) return reuseResult(cached, context, signature, signal, modules, cachedNativeInjected);
        reuseCachedPayload = true;
    }
    const ragSettings = copy(modules.rag.getEffectiveSettings());
    status(onStatus, '读取当前聊天的 Anima 摘要与状态。');
    const entries = await readWorldbook(context, signature, signal);
    const state = await readStatus(context, entries, modules, signature, signal);
    const recent = ragSettings.rag_enabled === false ? { text: '', ids: [] } : recentSummaries(entries, ragSettings.injection_settings?.recent_count ?? 2);
    let payload = null;
    let nativeAlreadyInjected = false;
    if (reuseCachedPayload) {
        payload = ragSettings.rag_enabled === false ? null : validatePayload(cached.payload);
        nativeAlreadyInjected = cachedNativeInjected;
    } else if (generationToken !== undefined) {
        const current = observation;
        if (!installedObserver || globalThis.Anima_RAG_Interceptor !== installedObserver.wrapper || installedObserver.base !== modules.base) {
            fail('Anima 观测器未就绪或被替换，无法证明当前召回的新鲜度。', 'ANIMA_OBSERVER_REQUIRED');
        }
        if (!current || generationToken !== epoch || current.token !== generationToken || current.pending || current.consumed || current.failed || current.signature !== signature || current.finalSignature !== signature) {
            fail('没有本次生成可用的新鲜 Anima 结果，已停止规划；不会复用上轮缓存或再次重复召回。', 'ANIMA_FRESH_RESULT_REQUIRED');
        }
        current.consumed = true;
        const latestUser = [...context.chat].reverse().find(m => m.is_user === true || m.role === 'user');
        if ((latestUser?.mes ?? latestUser?.message ?? '') !== userInput) fail('规划输入与本次 Anima 读取的用户消息不一致。', 'ANIMA_INPUT_CHANGED');
        if (ragSettings.rag_enabled !== false) {
            payload = validatePayload(current.payload);
            if (current.queryCheckFailed || !current.expectedQueries || payload.query !== current.expectedQueries.searchText || payload.bm25Query !== current.expectedQueries.bm25SearchText) {
                fail('本次 Anima 查询与当前输入快照不一致，可能发生并发检索或不支持的生成模式。', 'ANIMA_QUERY_CHANGED');
            }
        }
        nativeAlreadyInjected = true;
        status(onStatus, '使用本次生成刚完成的 Anima 结果，不重复召回。');
    } else if (ragSettings.rag_enabled !== false) {
        if (directQueryInFlight || nativeQueryInFlight || observation?.pending) fail('上一笔 Anima 查询仍在执行，请完成后再试；取消不一定停止原生请求。', 'ANIMA_BUSY');
        const { searchText, bm25SearchText } = buildQueries(context, userInput, settings, ragSettings, modules);
        const currentChatId = modules.utils.getSmartCollectionId();
        if (!currentChatId) fail('无法确定 Anima 当前聊天记忆库标识。', 'ANIMA_CHAT_REQUIRED');
        const extraChatFiles = context.chatMetadata?.anima_rag_active_files || [];
        if (!Array.isArray(extraChatFiles) || extraChatFiles.some(id => typeof id !== 'string')) fail('Anima 聊天库绑定配置异常。', 'ANIMA_SETTINGS');
        const kbPayload = modules.kb.getKbSearchPayload();
        if (!Array.isArray(kbPayload?.kbContext?.ids)) fail('Anima 知识库配置异常。', 'ANIMA_SETTINGS');
        if (!extraChatFiles.length && !kbPayload.kbContext.ids.length) fail('Anima 当前没有绑定可查询的聊天库或向量知识库，请先完成绑定。', 'ANIMA_NO_COLLECTIONS');
        const configs = bm25Payload(context, modules, currentChatId, extraChatFiles, kbPayload);
        assertCurrent(context, signature, signal);
        status(onStatus, '为当前输入发起新的 Anima 召回。');
        directQueryInFlight = true;
        try {
            // Intentionally do not Promise.race: native API cannot abort its AJAX.
            // Keep the busy lock until it settles. Preserve a successful recall
            // for this round even when cancellation happened while it ran, so a
            // retry cannot spend another Echo retention round.
            const result = await modules.rag.queryDual({ searchText, bm25SearchText, currentChatId, extraChatFiles, excludeIds: recent.ids, isSilent: true, bm25Configs: configs, kbPayload });
            assertCurrent(context, signature);
            payload = validatePayload(result);
            if (key !== roundKey(contextNow(context), userInput, settings, modules)) fail('Anima 配置在召回期间发生变化，结果没有用于规划。', 'ANIMA_CONTEXT_CHANGED');
            if (revision === cacheRevision) roundCache = { key, payload: copy(payload), result: null, readAt: Date.now() };
        } finally { directQueryInFlight = false; }
    }
    assertCurrent(context, signature);
    const text = formatMemory(payload, recent, entries, ragSettings, state, context, modules);
    const dynamic = dynamicContainerContent(payload, recent, ragSettings, context);
    const result = {
        text, status: text ? 'ok' : 'empty', source: `Ellinav Anima ${modules.manifest.version}`,
        chatId: idOf(context), readAt: cached?.readAt || Date.now(), nativeAlreadyInjected, reusedForRound: reuseCachedPayload,
        warnings: ragSettings.rag_enabled === false ? [] : [ECHO_WARNING],
    };
    if (revision === cacheRevision) roundCache = { key, result: copy(result), payload: payload ? copy(payload) : null, dynamic };
    checkAbort(signal);
    const dynamicContainersReady = await syncDynamicContainers(dynamic, context, signature, signal, modules);
    return { ...result, dynamicContainersReady };
}
