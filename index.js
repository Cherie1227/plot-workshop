import { createWorkbench } from './ui.js';
import { normalizePreset, exportPreset, compilePreset } from './lib/preset.js';
import { parseContent } from './lib/content.js';
import { requestPlan, normalizeEndpoint, redactSecrets } from './lib/planner.js';
import * as nativeAnima from './lib/anima.js';
import { createAnimaCleanupGuard } from './lib/anima-cleanup.js';
import { fetchModelList, testApiConnection, requestDiagnosis } from './lib/api.js';
import { makeVersion, sanitizeBackup } from './lib/workshop-tools.js';
import { buildPromptInspection } from './lib/prompt-inspector.js';
import { getHostCatalog, readHostPreset, readExtraWorldbooks } from './lib/host-library.js';
import { createRuntimeLog } from './lib/runtime-log.js';
import { createWriterQuickActions } from './lib/quick-actions.js';
import { createWorkbenchEntryPoints } from './lib/entry-points.js';
import { createUpdater } from './lib/updater.js';
import { saveSettingsBeforeReload } from './lib/settings-save.js';
import { analyzeImportedPreset } from './lib/import-advisor.js';
import { buildImportReview } from './lib/import-review.js';
import { cleanSettings, proseTarget, assertChat, storySnapshot, collectPlanningContext, createSTTransport, injectForTurn, clearInjection, describeInjection, buildInjectionText } from './lib/host.js';

const STORE = 'plot_workshop';
const base = new URL('./', import.meta.url);
const normalType = type => !type || type === 'normal';
const API_FIELDS = ['baseUrl', 'model', 'temperature', 'maxTokens', 'stream'];
const connectionSettings = input => Object.fromEntries(API_FIELDS.map(key => [key, key === 'stream' ? input?.stream !== false : String(input?.[key] ?? '')]));
const newId = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const keyStorageName = id => `${STORE}:api-key:${id}`;
const bookNames = input => Array.isArray(input) ? [...new Set(input.filter(name => typeof name === 'string' && name.trim() && name.length <= 500))] : [];
const planningSettings = settings => Object.fromEntries(Object.entries(settings).filter(([key]) => !['theme', 'fontSize', 'lineHeight', 'enabled', 'regeneratePolicy'].includes(key)));
// Labels and grouping display preferences do not change the compiled request.
const outlinePreset = preset => ({
    characterId: preset.characterId,
    prompts: preset.prompts.map(({ name, ...prompt }) => prompt),
    order: preset.order,
    groups: preset.groups.map(({ id, enabled }) => ({ id, enabled })).sort((a, b) => a.id.localeCompare(b.id)),
    promptGroups: preset.promptGroups,
});
const regenerationFallbacks = {
    REUSE_NO_CACHE: '当前页面没有有效的本轮大纲与记忆缓存，将重新生成大纲。',
    REUSE_CONTEXT_CHANGED: '当前轮次或聊天资料已变化，将重新生成大纲。',
    REUSE_WORLDBOOK_CHANGED: '世界书资料已更新，将重新生成大纲。',
    REUSE_ANIMA_CONFIG_CHANGED: 'Anima 资料配置已变化，将重新生成大纲。',
    REUSE_ANIMA_PATH_CHANGED: 'Anima 来源路径已变化，将重新生成大纲。',
    REUSE_CONFIG_CHANGED: '规划配置已变化，将重新生成大纲。',
};
const errorCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';

function readPlanningPreset(input, options) {
    const data = structuredClone(input);
    const source = data?.version && data?.data ? data.data : data;
    const marker = source?.extensions?.plot_workshop;
    const preserveSelection = marker?.schema_version === 1 && marker?.preserve_prompt_selection === true;
    if (preserveSelection) delete source.extensions.plot_workshop;
    const preset = normalizePreset(data, options);
    if (preserveSelection && marker.import_advice) {
        const ids = new Set(preset.prompts.map(item => item.identifier));
        const records = key => Array.isArray(marker.import_advice[key]) ? marker.import_advice[key].filter(item => item
            && ids.has(item.id) && typeof item.reason === 'string').slice(0, 2000).map(item => ({ id: item.id, reason: item.reason.slice(0, 500) })) : [];
        preset.importAdvice = { disable: records('disable'), review: records('review') };
    }
    return { preset, preserveSelection };
}

function writePlanningPreset(preset) {
    const data = exportPreset(preset);
    // A later import must preserve intentional deletions, including the output protocol.
    data.extensions.plot_workshop = { schema_version: 1, preserve_prompt_selection: true };
    if (preset.importAdvice) data.extensions.plot_workshop.import_advice = structuredClone(preset.importAdvice);
    return data;
}

/** Exported for host-contract integration tests; normal installation uses boot(). */
export async function createPlugin({ getContext, builtin, writerRules, anima = nativeAnima, viewFactory = createWorkbench, fetchImpl = fetch,
    api = { fetchModelList, testApiConnection, requestDiagnosis }, updaterFactory = createUpdater,
    extensionUrl = base.href, currentVersion = '开发版', rewriteReply, reloadPage = () => globalThis.location?.reload() } = {}) {
    const ctx = getContext();
    const saved = ctx.extensionSettings[STORE] || {};
    const defaultPreset = normalizePreset(builtin, { name: '第三人称 · 轻度抢话' });
    const initialSettings = cleanSettings(saved.settings), initialWarnings = [];
    const apiProfiles = [];
    for (const profile of Array.isArray(saved.apiProfiles) ? saved.apiProfiles : []) {
        if (!profile || typeof profile.id !== 'string' || apiProfiles.some(item => item.id === profile.id)) continue;
        apiProfiles.push({ id: profile.id, name: String(profile.name || 'API 方案'), ...connectionSettings(profile) });
    }
    if (!apiProfiles.length) apiProfiles.push({ id: newId('api'), name: '默认 API', ...connectionSettings(initialSettings) });
    const activeApi = apiProfiles.find(profile => profile.id === saved.activeApiProfileId) || apiProfiles[0];
    const presetLibrary = [];
    for (const entry of Array.isArray(saved.presetLibrary) ? saved.presetLibrary : []) {
        if (!entry || typeof entry.id !== 'string' || presetLibrary.some(item => item.id === entry.id)) continue;
        try {
            const preset = readPlanningPreset(entry.preset).preset;
            preset.name = String(entry.name || preset.name);
            presetLibrary.push({ id: entry.id, name: preset.name, preset: writePlanningPreset(preset) });
        } catch { initialWarnings.push(`规划方案“${String(entry.name || '未命名')}”无法读取，请从备份重新导入。`); }
    }
    if (!presetLibrary.length) {
        let preset = structuredClone(defaultPreset);
        try { if (saved.preset) preset = readPlanningPreset(saved.preset).preset; }
        catch { initialWarnings.push('旧规划预设无法读取，当前载入内置副本。'); }
        presetLibrary.push({ id: newId('preset'), name: preset.name, preset: writePlanningPreset(preset) });
    }
    const activePreset = presetLibrary.find(entry => entry.id === saved.activePresetId) || presetLibrary[0];
    const secretCache = new Map();
    const historicalSecrets = new Set();
    const extraWorldbooksByChat = Object.fromEntries(Object.entries(saved.extraWorldbooksByChat || {}).map(([id, names]) => [id, bookNames(names)]));
    const state = { settings: cleanSettings({ ...initialSettings, ...connectionSettings(activeApi) }),
        preset: readPlanningPreset(activePreset.preset).preset, apiKey: '', input: '', plan: null, rawPlan: '', planningAnalysis: null,
        apiProfiles, activeApiProfileId: activeApi.id, rememberApiKey: false, apiStatus: '', apiBusy: false, models: [],
        presetLibrary, activePresetId: activePreset.id, planVersions: [],
        promptPreview: null, promptInspection: null, inspectionStale: true, diagnosis: null,
        hostCatalog: null, libraryBusy: false, libraryStatus: '', extraWorldbooks: bookNames(extraWorldbooksByChat[ctx.chatId]), importReview: null,
        status: '准备就绪', stage: 'idle', busy: false, awaitingReview: false, animaStatus: '尚未连接', animaChecking: false,
        animaDetectedPath: '', animaDetectionStatus: '', animaDetectedVersion: '', logs: [], warnings: initialWarnings, undoDeletion: null, isPreview: false };
    readProfileSecret(activeApi.id);
    const runtimeLog = createRuntimeLog({ getSecrets: () => [...historicalSecrets, state.apiKey, ...[...secretCache.values()].map(item => item.key)], limit: 200 });
    state.logs = runtimeLog.entries;
    let workId = 0, controller = null, gate = null, anchor = null, memory = null;
    let generationToken, preparationError, resuming = null, writerActive = false, disposeReuse = null, worldRevision = 0;
    let nativeRegeneration = null;
    const animaCleanup = createAnimaCleanupGuard();
    let undoDeletionRecord = null, promptSequence = 0;
    let apiController = null, apiWorkId = 0;
    let detectionWorkId = 0;
    let inspectionAnchor = null, diagnosisAnchor = null, currentVersionId = null;
    let hostGenerating = false, destroyed = false;
    // Only the current page keeps this receipt; raw memory is never persisted in chat/settings.
    let pendingWriterReceipt = null, writerReceipt = null, writerReplay = null;
    let quickActions = null;
    let entryPoints = null;
    const versionAnchors = new Map();
    const listeners = [];
    const view = viewFactory({ getState: () => state, onAction });
    const updater = updaterFactory({ getContext, fetchImpl, extensionUrl, currentVersion, preferences: saved.updatePreferences || {},
        canInstall: automatic => !destroyed && !state.busy && !state.apiBusy && !state.animaChecking && !state.libraryBusy && !hostGenerating
            && !(typeof getContext().isGenerating === 'function' ? getContext().isGenerating() : getContext().isGenerating)
            && !view.hasUnsavedChanges?.() && (!automatic || !view.isOpen?.()),
        onChange(update, meta = {}) {
            state.update = update;
            if (destroyed) return;
            render();
            if (meta.notify) {
                if (update.phase === 'installed') {
                    log('success', 'extension.update', '扩展更新已下载，等待刷新生效。');
                    globalThis.toastr?.info('Vespera已更新，保存当前工作后刷新页面生效。');
                } else if (update.phase === 'available') {
                    log('info', 'extension.update', '检测到扩展更新。');
                    globalThis.toastr?.info('Vespera有更新，可在设置中查看。');
                } else if (['error', 'unsupported'].includes(update.phase)) {
                    log('warn', 'extension.update.failed', '扩展更新未完成，请查看设置页的更新状态。', { code: update.errorCode });
                    globalThis.toastr?.warning(update.message);
                }
            }
        },
    });
    state.update = updater.state;
    const hostInput = () => document.querySelector('#send_textarea');
    const draft = () => String(hostInput()?.value ?? '');
    const configSignature = (outlineOnly = false) => JSON.stringify({ settings: Object.fromEntries(Object.entries(planningSettings(state.settings)).filter(([key]) => !outlineOnly || !['autoOnSend', 'mode'].includes(key))), preset: outlineOnly ? outlinePreset(state.preset) : state.preset, apiProfileId: state.activeApiProfileId, extraWorldbooks: state.extraWorldbooks,
        presetId: state.activePresetId, animaPath: state.animaDetectedPath || state.settings.animaPath });
    const animaConfigSignature = () => JSON.stringify(getContext().extensionSettings.anima_memory_system ?? null);
    const settingsForAnima = inputAlreadyInChat => ({ frontendPath: state.animaDetectedPath || state.settings.animaPath, inputAlreadyInChat });
    function render() {
        quickActions?.refresh();
        state.inspectionStale = !snapshotCurrent(inspectionAnchor);
        if (state.promptPreview) state.promptPreview.valid = !state.inspectionStale && !!anchor;
        state.importReview = buildImportReview(state.preset);
        view.render();
    }
    function currentSnapshot() {
        return { story: storySnapshot(getContext()), config: configSignature(), input: state.input, draft: draft(), worldRevision, animaConfig: animaConfigSignature() };
    }
    function snapshotCurrent(snapshot) {
        if (!snapshot) return false;
        try { return JSON.stringify(currentSnapshot()) === JSON.stringify(snapshot); } catch { return false; }
    }
    function status(message) { state.status = message; render(); }
    function log(level, event, message, details) { runtimeLog.add(level, event, message, details); }
    function rememberSecret(value) { if (typeof value === 'string' && value) historicalSecrets.add(value); }
    function persist() {
        const current = getContext();
        const entry = state.presetLibrary.find(item => item.id === state.activePresetId);
        if (entry) { entry.name = state.preset.name; entry.preset = writePlanningPreset(state.preset); }
        const profile = state.apiProfiles.find(item => item.id === state.activeApiProfileId);
        // No key, raw response, recalled memory or plan is saved in ST settings/chat metadata.
        if (current.chatId) extraWorldbooksByChat[current.chatId] = bookNames(state.extraWorldbooks);
        current.extensionSettings[STORE] = {
            settings: cleanSettings({ ...state.settings, ...connectionSettings(profile) }), preset: writePlanningPreset(state.preset),
            apiProfiles: state.apiProfiles.map(item => ({ id: item.id, name: item.name, ...connectionSettings(item) })),
            activeApiProfileId: state.activeApiProfileId, presetLibrary: structuredClone(state.presetLibrary), activePresetId: state.activePresetId,
            extraWorldbooksByChat: structuredClone(extraWorldbooksByChat),
            updatePreferences: { autoCheck: state.update.autoCheck, autoInstall: state.update.autoInstall },
        };
        current.saveSettingsDebounced();
        log('info', 'configuration.saved', '配置已保存。', { promptCount: state.preset.prompts.length, mode: state.settings.mode });
    }
    function setEnabled(value) {
        if (typeof value !== 'boolean') throw new Error('插件开关必须为开启或关闭。');
        const current = getContext();
        if (state.busy || state.apiBusy || state.animaChecking || state.libraryBusy || hostGenerating
            || anima.isAnimaMemoryOperationInFlight?.()
            || (typeof current.isGenerating === 'function' ? current.isGenerating() : current.isGenerating)) {
            throw new Error('请先完成或取消当前操作，再切换插件总开关。');
        }
        if (!value) {
            anima.releaseAnimaObserver?.();
            disposeReuse?.(); disposeReuse = null; resuming = null;
            generationToken = undefined; preparationError = null;
            nativeRegeneration = null;
            clearInjection(current);
        }
        state.settings.enabled = value;
        persist();
        log('info', 'extension.enabled', value ? 'Vespera 已启用。' : 'Vespera 已关闭，聊天由酒馆直接生成。', { enabled: value });
        status(value ? 'Vespera 已启用，开关已保存。' : 'Vespera 已关闭，开关已保存；聊天由酒馆直接生成。');
        return true;
    }
    function refreshHostCatalog() {
        state.libraryBusy = true; render();
        try {
            state.hostCatalog = getHostCatalog({ context: getContext(), worldInfoModule: getContext().worldInfoModule });
            state.libraryStatus = state.hostCatalog.message || '酒馆目录已读取。';
            log('info', 'library.refreshed', '已读取酒馆世界书与预设目录。'); return state.hostCatalog;
        } catch { state.libraryStatus = '无法读取酒馆目录，请检查当前酒馆是否提供世界书与预设接口。'; return false; }
        finally { state.libraryBusy = false; render(); }
    }
    function readProfileSecret(id) {
        let record = secretCache.get(id);
        if (!record) {
            let key = null;
            try { key = globalThis.localStorage?.getItem(keyStorageName(id)) ?? null; } catch { /* Private browsing may forbid local storage. */ }
            record = { key: typeof key === 'string' ? key : '', remember: key !== null };
            secretCache.set(id, record);
        }
        state.apiKey = record.key; state.rememberApiKey = record.remember;
        rememberSecret(record.key);
    }
    function saveProfileSecret(id, key, remember) {
        if (typeof key !== 'string') throw new Error('API 密钥必须是文本。');
        rememberSecret(key);
        try {
            if (remember) {
                if (!globalThis.localStorage) throw new Error('unavailable');
                globalThis.localStorage.setItem(keyStorageName(id), key);
            } else globalThis.localStorage?.removeItem(keyStorageName(id));
        } catch { throw new Error(remember ? '浏览器不允许保存密钥。请关闭“记住密钥”后重试。' : '无法清除浏览器中保存的密钥，请检查浏览器存储权限。'); }
        secretCache.set(id, { key, remember }); state.apiKey = key; state.rememberApiKey = remember;
    }
    function named(value, fallback, label) {
        const name = value === undefined ? fallback : typeof value === 'string' ? value.trim() : '';
        if (!name) throw new Error(`${label}名称不能为空。`);
        return name;
    }
    function selectApiProfile(profile) {
        secretCache.set(state.activeApiProfileId, { key: state.apiKey, remember: state.rememberApiKey });
        state.activeApiProfileId = profile.id;
        state.settings = cleanSettings({ ...state.settings, ...connectionSettings(profile) });
        readProfileSecret(profile.id); state.models = []; state.apiStatus = '';
    }
    async function saveApiProfile(payload, asNew = false) {
        const old = state.apiProfiles.find(item => item.id === state.activeApiProfileId);
        // Revoking local key storage must not depend on unrelated form validation.
        if (payload.rememberKey === false) saveProfileSecret(old.id, typeof payload.apiKey === 'string' ? payload.apiKey : state.apiKey, false);
        const name = named(payload.name ?? payload.profileName, asNew ? `${old.name} 副本` : old.name, 'API 方案');
        const oldAnimaPath = state.settings.animaPath;
        const settings = cleanSettings({ ...state.settings, ...payload.settings, enabled: state.settings.enabled });
        proseTarget(settings);
        if (settings.baseUrl.trim()) normalizeEndpoint(settings.baseUrl);
        const key = payload.apiKey === undefined ? state.apiKey : payload.apiKey;
        const remember = payload.rememberKey === undefined ? state.rememberApiKey : payload.rememberKey === true;
        const profile = { id: asNew ? newId('api') : old.id, name, ...connectionSettings(settings) };
        if (asNew) secretCache.set(old.id, { key: state.apiKey, remember: state.rememberApiKey });
        // Storage failure is reported before the saved profile is changed.
        saveProfileSecret(profile.id, key, remember);
        if (asNew) state.apiProfiles.push(profile); else Object.assign(old, profile);
        state.activeApiProfileId = profile.id; state.settings = settings; state.models = [];
        persist(); state.apiStatus = 'API 方案已保存。'; status('设置已保存。');
        if (settings.animaPath !== oldAnimaPath) { resetDetection(); await detectAnima(); }
        return { id: profile.id };
    }
    function addPreset(preset, name) {
        preset.name = named(name, preset.name, '规划预设');
        const entry = { id: newId('preset'), name: preset.name, preset: writePlanningPreset(preset) };
        state.presetLibrary.push(entry); state.activePresetId = entry.id; state.preset = preset;
        clearDeletionUndo(); persist(); return { id: entry.id };
    }
    function clearDeletionUndo() { undoDeletionRecord = null; state.undoDeletion = null; }
    function editablePrompt(id) {
        const prompt = state.preset.prompts.find(item => item.identifier === id);
        if (!prompt) throw new Error('条目已不存在，请重新选择。');
        return prompt;
    }
    function promptName(value) {
        if (typeof value !== 'string' || !value.trim()) throw new Error('条目名称不能为空。');
        return value.trim();
    }
    function promptRole(value) {
        if (!['system', 'user', 'assistant'].includes(value)) throw new Error('请选择 system、user 或 assistant 消息角色。');
        return value;
    }
    function promptContent(value) {
        if (typeof value !== 'string') throw new Error('条目内容必须是文本。');
        return value;
    }
    function promptGroup(value) {
        if (value == null || value === '') return null;
        if (typeof value !== 'string' || !state.preset.groups.some(group => group.id === value)) throw new Error('所选分组已不存在，请重新选择。');
        return value;
    }
    function setPromptGroup(id, groupId) {
        if (groupId === null) delete state.preset.promptGroups[id];
        else state.preset.promptGroups[id] = groupId;
    }
    function groupName(value) {
        if (typeof value !== 'string' || !value.trim()) throw new Error('请输入分组名称。');
        return value.trim();
    }
    function keepGroupMembersDisabled(ids) {
        const disabledGroups = new Set(state.preset.groups.filter(group => group.enabled === false).map(group => group.id));
        for (const entry of state.preset.order) {
            if (ids.has(entry.identifier) && disabledGroups.has(state.preset.promptGroups[entry.identifier])) entry.enabled = false;
        }
    }
    function nextPromptId() {
        let id;
        do { id = `plot_workshop_${Date.now().toString(36)}_${(++promptSequence).toString(36)}`; }
        while (state.preset.prompts.some(prompt => prompt.identifier === id));
        return id;
    }
    function fail(error) {
        log('error', 'operation.failed', '当前操作未完成。', { stage: state.stage, code: errorCode(error) });
        status(redactSecrets(error?.message || '操作未完成。', [...historicalSecrets, state.apiKey]).slice(0, 500));
        view.open();
    }
    function resetDetection() {
        detectionWorkId++; state.animaChecking = false; state.animaDetectedPath = '';
        state.animaDetectionStatus = ''; state.animaDetectedVersion = ''; state.animaStatus = '尚未检测当前 Anima 路径';
    }
    async function detectAnima() {
        const id = ++detectionWorkId, path = state.settings.animaPath;
        state.animaChecking = true; state.animaStatus = '正在检测 Anima 安装与就绪状态…';
        log('info', 'anima.detect.started', '开始检测 Anima 安装与就绪状态。'); render();
        try {
            if (typeof anima.detectInstalledAnima !== 'function') throw new Error('检测接口不可用');
            const result = await anima.detectInstalledAnima({ context: getContext(), settings: { frontendPath: path } });
            if (id !== detectionWorkId || path !== state.settings.animaPath) return false;
            if (!result || !['ready', 'not_found', 'not_ready', 'unsupported', 'ambiguous'].includes(result.status)) throw new Error('检测结果无效');
            if (result.status === 'ready' && (typeof result.frontendPath !== 'string' || !result.frontendPath)) throw new Error('检测结果缺少路径');
            state.animaDetectionStatus = result.status;
            state.animaDetectedVersion = typeof result.version === 'string' ? result.version : '';
            state.animaDetectedPath = result.status === 'ready' ? result.frontendPath : '';
            state.animaStatus = redactSecrets(String(result.message || 'Anima 检测已结束。'), [...historicalSecrets, state.apiKey]).slice(0, 500);
            log(result.status === 'ready' ? 'success' : 'warn', 'anima.detect.completed', 'Anima 检测已结束。', { status: result.status, version: state.animaDetectedVersion });
            return result;
        } catch (error) {
            if (id !== detectionWorkId || path !== state.settings.animaPath) return false;
            state.animaDetectionStatus = 'not_ready'; state.animaDetectedPath = ''; state.animaDetectedVersion = '';
            state.animaStatus = 'Anima 检测未完成，请重新检测或检查扩展是否加载。';
            log('error', 'anima.detect.failed', 'Anima 检测未完成。', { code: errorCode(error) }); return false;
        } finally {
            if (id === detectionWorkId) { state.animaChecking = false; render(); }
        }
    }
    async function runApiAction(type, payload) {
        const settings = cleanSettings({ ...state.settings, ...payload.settings });
        const apiKey = payload.apiKey === undefined ? state.apiKey : payload.apiKey;
        if (typeof apiKey !== 'string') throw new Error('API 密钥必须是文本。');
        rememberSecret(apiKey);
        const id = ++apiWorkId;
        apiController = new AbortController();
        const signal = apiController.signal;
        state.apiBusy = true; state.apiStatus = type === 'fetchModels' ? '正在获取模型列表…' : '正在测试连接…';
        if (type === 'fetchModels') state.models = [];
        log('info', type === 'fetchModels' ? 'api.models.started' : 'api.test.started', type === 'fetchModels' ? '开始获取 API 模型列表。' : '开始测试 API 连接。', { model: settings.model }); render();
        try {
            const options = { getContext, fetchImpl, baseUrl: settings.baseUrl, model: settings.model, stream: settings.stream, apiKey, signal, timeoutMs: 60000 };
            const result = await (type === 'fetchModels' ? api.fetchModelList(options) : api.testApiConnection(options));
            if (id !== apiWorkId || signal.aborted) return false;
            if (type === 'fetchModels') {
                if (!Array.isArray(result) || result.some(model => typeof model !== 'string')) throw new Error('模型列表格式无效。');
                state.models = [...new Set(result)];
                state.apiStatus = state.models.length ? `已获取 ${state.models.length} 个模型。请选择模型后保存。` : '连接成功，但没有返回可选模型；可以手动填写。';
            } else {
                if (!result || typeof result.message !== 'string' || !result.message.trim()) throw new Error('连接测试未返回有效结果。');
                state.apiStatus = redactSecrets(result.message, [...historicalSecrets, apiKey]).slice(0, 500);
            }
            log('success', type === 'fetchModels' ? 'api.models.completed' : 'api.test.completed', type === 'fetchModels' ? 'API 模型列表获取完成。' : 'API 连接测试完成。', { ...(type === 'fetchModels' ? { count: state.models.length } : {}) });
            render(); return result;
        } catch (error) {
            if (id !== apiWorkId || signal.aborted) return false;
            state.apiStatus = redactSecrets(error?.message || 'API 操作未完成。', [...historicalSecrets, apiKey]).slice(0, 500);
            log('error', type === 'fetchModels' ? 'api.models.failed' : 'api.test.failed', 'API 操作未完成。', { code: errorCode(error) });
            render(); return false;
        } finally {
            if (id === apiWorkId) { state.apiBusy = false; apiController = null; render(); }
        }
    }
    function cacheDraft() {
        try {
            sessionStorage.setItem(`${STORE}:draft:${getContext().chatId}`, JSON.stringify({ xml: state.plan?.xml || '', input: state.input,
                versions: state.planVersions.slice(-20) }));
        } catch { /* Session storage may be unavailable; the visible draft remains usable. */ }
    }
    function restoreDraft() {
        state.plan = null; state.rawPlan = ''; state.planningAnalysis = null; anchor = null; memory = null;
        state.planVersions = []; state.diagnosis = null; state.promptPreview = null;
        state.promptInspection = null; inspectionAnchor = null; diagnosisAnchor = null; currentVersionId = null; versionAnchors.clear();
        try {
            const savedDraft = JSON.parse(sessionStorage.getItem(`${STORE}:draft:${getContext().chatId}`));
            for (const version of (Array.isArray(savedDraft?.versions) ? savedDraft.versions : []).slice(-20)) {
                try { state.planVersions.push(sanitizeBackup({ format: 'huapi-backup', version: 1, versions: [version] }).versions[0]); } catch { /* Ignore only the malformed version. */ }
            }
            if (savedDraft?.xml) {
                state.plan = parseContent(savedDraft.xml); state.rawPlan = savedDraft.xml; state.input = savedDraft.input || '';
                state.status = '已恢复上次大纲供查看；重新规划后才能自动扩写。';
            }
        } catch { /* A malformed saved draft is never injected. */ }
    }
    function recordVersion(label) {
        const version = makeVersion({ xml: state.plan.xml, input: state.input, label, parentId: currentVersionId }, state.planVersions);
        state.planVersions.push(version); state.planVersions = state.planVersions.slice(-20); currentVersionId = version.id;
        versionAnchors.set(version.id, { anchor, memory });
        for (const id of versionAnchors.keys()) if (!state.planVersions.some(item => item.id === id)) versionAnchors.delete(id);
        cacheDraft();
    }
    function refreshPromptPreview() {
        let valid = false;
        try { checkAnchor(); valid = !state.inspectionStale; } catch { /* Display stale drafts as such. */ }
        state.promptPreview = { planner: state.promptInspection?.entries.filter(entry => entry.enabled).flatMap(entry => entry.messages) || [],
            writer: state.plan && memory ? buildInjectionText({ xml: state.plan.xml, memory: memory.text, target: proseTarget(state.settings), writerRules }) : '',
            valid, message: valid ? describeInjection(state.settings) : '预览可能已过期或尚无有效大纲；重新读取或生成后再确认扩写。' };
    }
    function compileRound(planningContext, recalled, target, extraBooks = { text: '', books: [] }) {
        const compiled = compilePreset(state.preset, { context: { ...planningContext,
            animaMemory: recalled.text, memoryParts: recalled.memoryParts, animaStatus: recalled.status === 'empty' ? 'empty' : 'success' }, targetLength: target });
        for (const book of extraBooks.books) {
            const contents = extraBooks.entries.filter(entry => entry.book === book.name).map(entry => `${entry.comment ? `${entry.comment}\n` : ''}${entry.content}`).join('\n\n');
            const messages = contents ? [{ role: 'system', content: `【额外参考世界书：${book.name}；按启用条目提供，未做关键词触发】\n${contents}` }] : [];
            compiled.messages.push(...messages);
            compiled.entries.push({ id: `worldbook:${book.name}`, name: `额外世界书 · ${book.name}`, kind: 'runtime', order: compiled.entries.length + 1, enabled: true, messages });
        }
        const sources = [
            { name: '角色卡', status: planningContext.charDescription || planningContext.charPersonality || planningContext.scenario ? '已读取' : '已读取 · 空', detail: '以本轮酒馆角色卡与覆盖字段为准。' },
            { name: '聊天历史', status: planningContext.chatHistory.length ? '已读取' : '已读取 · 空', detail: `${planningContext.chatHistory.length} 条历史消息；当前输入单独提供。` },
            { name: '世界书', status: planningContext.worldInfoBefore || planningContext.worldInfoAfter ? '已读取' : '已读取 · 无命中', detail: '本轮干扫描命中的条目，未命中不等于读取失败。' },
            { name: 'Anima', status: recalled.retrievalSkipped === 'no_sources' ? '已读取 · 暂无召回来源' : recalled.status === 'empty' ? '已读取 · 无相关记忆' : '已读取',
                detail: recalled.retrievalSkipped === 'no_sources' ? '未绑定召回库，已读取本地摘要与状态；使用当前聊天资料继续规划。' : recalled.reusedForRound ? '复用本轮有效召回。' : '召回完成，沿用 Anima 的记忆保留规则。' },
            ...extraBooks.books.map(book => ({ name: `额外世界书 · ${book.name}`, status: book.count ? '已读取' : '已读取 · 空', detail: `${book.count} 个启用条目。仅本轮规划使用。` })),
        ];
        state.promptInspection = buildPromptInspection({ preset: state.preset, compiled, sources, model: state.settings.model });
        inspectionAnchor = currentSnapshot(); state.inspectionStale = false;
        state.warnings = compiled.warnings;
        state.promptPreview = { planner: compiled.messages, writer: '', valid: false, message: '规划请求资料已展开；尚未生成本轮大纲。' };
        return compiled;
    }
    async function inspectOrDiagnose(diagnose = false) {
        const userInput = String(state.input || draft());
        if (diagnose) { normalizeEndpoint(state.settings.baseUrl); if (!state.settings.model.trim()) throw new Error('请先选择规划模型。'); }
        state.busy = true; render();
        try {
            const preparationId = ++workId;
            await anima.installAnimaObserver({ settings: settingsForAnima(false) });
            if (preparationId !== workId) throw Object.assign(new Error('操作已取消。'), { code: 'CANCELLED' });
            const committed = !draft() && getContext().chat.at(-1)?.is_user && getContext().chat.at(-1).mes === userInput;
            const { compiled } = await performPlan(userInput, { committed, inspectOnly: true });
            if (!diagnose) return;
            const expected = inspectionAnchor, signal = controller.signal;
            const messages = compiled.entries.filter(item => item.kind === 'context' || item.kind === 'runtime').flatMap(item => item.messages);
            let diagnosedXml = '';
            try { checkAnchor(); diagnosedXml = state.plan.xml; } catch { /* Do not diagnose a stale plan as the current plan. */ }
            if (diagnosedXml) messages.push({ role: 'user', content: `【待执行的大纲，尚未发生】\n${diagnosedXml}` });
            state.stage = 'planning'; status('正在诊断本轮剧情…');
            log('info', 'diagnosis.started', '用户主动请求剧情诊断。');
            const result = await (api.requestDiagnosis || requestDiagnosis)({ getContext, fetchImpl, baseUrl: state.settings.baseUrl,
                model: state.settings.model, stream: state.settings.stream, apiKey: state.apiKey, messages, signal, timeoutMs: 180000 });
            if (signal.aborted || !snapshotCurrent(expected)) throw new Error('诊断期间输入或上下文已变化，请重新诊断。');
            state.diagnosis = result; diagnosisAnchor = { snapshot: expected, xml: state.plan?.xml || '' };
            log('success', 'diagnosis.completed', '剧情诊断已完成，等待用户选择。');
            state.stage = 'review'; status('诊断完成；选择建议后可修改本轮输入。');
        } catch (error) { if (!['CANCELLED', 'ABORTED'].includes(error.code)) anchor = null; throw error; }
        finally { state.busy = false; render(); }
    }
    function exportBackup() {
        persist();
        const data = sanitizeBackup({ format: 'huapi-backup', version: 1, settings: state.settings,
            apiProfiles: state.apiProfiles, presetLibrary: state.presetLibrary, versions: state.planVersions, extraWorldbooks: state.extraWorldbooks });
        download(JSON.stringify({ format: 'huapi-backup', version: 1, ...data }, null, 2), 'Vespera-备份.json', 'application/json');
        log('info', 'backup.exported', '设置、方案和当前聊天的大纲版本已导出，不含密钥和原始记忆。'); status('备份已导出。');
    }
    function importBackup(text) {
        const data = sanitizeBackup(text);
        if (!data.settings.enabled) anima.releaseAnimaObserver?.();
        // Validate the whole file before changing anything; imported profiles are new copies.
        const profiles = data.apiProfiles.map(profile => ({ ...profile, id: newId('api') }));
        const presets = data.presetLibrary.map(entry => ({ ...entry, id: newId('preset') }));
        const versionIds = new Map(data.versions.map(version => [version.id, newId('version')]));
        const versions = data.versions.map(version => ({ ...version, id: versionIds.get(version.id), parentId: versionIds.get(version.parentId) || null }));
        state.apiProfiles.push(...profiles); state.presetLibrary.push(...presets);
        if (profiles.length) selectApiProfile(profiles[0]);
        const profile = state.apiProfiles.find(item => item.id === state.activeApiProfileId);
        state.settings = cleanSettings({ ...data.settings, ...connectionSettings(profile) });
        if (presets.length) { state.activePresetId = presets[0].id; state.preset = readPlanningPreset(presets[0].preset).preset; }
        state.planVersions = [...state.planVersions, ...versions].slice(-20);
        state.extraWorldbooks = data.extraWorldbooks;
        state.plan = null; state.rawPlan = ''; state.planningAnalysis = null; anchor = null; memory = null; inspectionAnchor = null; diagnosisAnchor = null;
        state.promptInspection = null; state.promptPreview = null; state.diagnosis = null; currentVersionId = null;
        resetDetection(); clearDeletionUndo(); clearInjection(getContext()); persist(); cacheDraft();
        log('success', 'backup.imported', '备份已导入为新方案；旧大纲仅供查看，须重新规划。');
        status('已导入备份副本；密钥需另填，旧大纲不能直接自动扩写。');
    }
    function cancel(message = '已取消；大纲没有写入聊天。') {
        if (writerReplay) writerReplay.failed = true;
        pendingWriterReceipt = null;
        nativeRegeneration = null;
        log('info', 'operation.cancelled', '当前操作已取消，临时注入已清理。', { stage: state.stage });
        detectionWorkId++;
        if (state.animaChecking) state.animaStatus = '已取消 Anima 检测。';
        state.animaChecking = false;
        apiWorkId++; apiController?.abort(); apiController = null;
        if (state.apiBusy) state.apiStatus = '已取消 API 操作。';
        state.apiBusy = false;
        const wasWriting = writerActive; writerActive = false;
        workId++; controller?.abort(); controller = null;
        gate?.resolve(false); gate = null;
        disposeReuse?.(); disposeReuse = null; resuming = null;
        clearInjection(getContext());
        state.awaitingReview = false; state.busy = false;
        state.stage = state.plan ? 'review' : 'idle';
        if (wasWriting) getContext().stopGeneration?.();
        // Keep this-turn recalled memory: retrying the same turn must not spend Echo retention again.
        status(message);
    }
    function checkAnchor({ afterSubmission = false } = {}) {
        if (!anchor || !state.plan) throw new Error('请先为当前输入生成大纲。已恢复的旧草稿只能查看或复制。');
        const current = getContext();
        const signature = storySnapshot(current, afterSubmission && !anchor.committed ? { dropLastInput: anchor.input } : {});
        if (signature !== anchor.story || configSignature() !== anchor.config || state.input !== anchor.input || anchor.worldRevision !== worldRevision || anchor.animaConfig !== animaConfigSignature()) throw new Error('聊天、输入、世界书、预设或设置已变化，请重新生成本轮大纲。');
        if (!afterSubmission && draft() !== anchor.draft) throw new Error('酒馆输入框已经改变，请重新规划，以免覆盖新输入。');
    }
    function inject() {
        const fixedAnchor = anchor;
        const content = { xml: state.plan.xml, memory: memory?.text || '', target: proseTarget(state.settings), writerRules,
            injection: { position: state.settings.injectionPosition, depth: state.settings.injectionDepth, role: state.settings.injectionRole } };
        const current = getContext();
        pendingWriterReceipt = { prefix: storySnapshot(current), targetId: current.chat.length,
            chatId: current.chatId, content, animaConfig: animaConfigSignature(), worldRevision,
            animaPath: state.animaDetectedPath || state.settings.animaPath,
            input: state.input, plan: structuredClone(state.plan), memory: structuredClone(memory), outlineConfig: configSignature(true) };
        injectForTurn(current, { ...content,
            valid: () => !!writerActive && anchor === fixedAnchor && getContext().chatId === fixedAnchor.chatId });
        log('info', 'writer.injected', describeInjection(state.settings), { position: state.settings.injectionPosition, depth: Number(state.settings.injectionDepth), role: state.settings.injectionRole });
        writerActive = true;
    }
    async function authorizeAnimaCleanup(check) {
        const verified = anima.getAnimaDynamicCleanupProof?.();
        if (!verified) return;
        const current = getContext();
        const read = current.loadWorldInfo || current.worldInfoModule?.loadWorldInfo;
        if (typeof read === 'function') {
            let raw;
            // ST updates this cache before its debounced WORLDINFO_UPDATED.
            // Reading the full official payload avoids relying on event timing.
            try { raw = await read.call(current, verified.bookName); }
            catch { animaCleanup.invalidate(); return; }
            check();
            if (!animaCleanup.observe(verified.bookName, raw)) { animaCleanup.invalidate(); return; }
        }
        animaCleanup.authorize(verified, getContext().chatId);
    }
    async function performPlan(userInput, { committed = false, token, maxContext, inspectOnly = false, versionLabel = '生成大纲', recalledMemory = null, generationType = 'normal', regenerationReason = '' } = {}) {
        if (!userInput.trim()) throw new Error('请先填写本轮输入。');
        if (!inspectOnly) {
            normalizeEndpoint(state.settings.baseUrl);
            if (!state.settings.model.trim()) throw new Error('请先在配置页填写规划模型名称。');
        }
        const target = proseTarget(state.settings);
        assertChat(getContext());
        const id = ++workId;
        controller = new AbortController();
        const signal = controller.signal;
        const initialStory = storySnapshot(getContext()), initialConfig = configSignature(), initialDraft = draft();
        let planningRevision, planningAnimaConfig;
        state.input = userInput; state.busy = true; state.awaitingReview = false;
        const previousAnchor = anchor, previousMemory = memory;
        anchor = null; clearInjection(getContext());
        if (!recalledMemory) animaCleanup.invalidate();
        const planningStatus = message => status(regenerationReason ? `${regenerationReason} ${message}` : message);
        const check = () => {
            if (id !== workId || signal.aborted) throw Object.assign(new Error('本轮规划已取消。'), { code: 'CANCELLED' });
            if (storySnapshot(getContext()) !== initialStory || configSignature() !== initialConfig || state.input !== userInput || draft() !== initialDraft) throw new Error('规划期间上下文发生变化，结果没有用于扩写，请重新规划。');
            if (planningRevision !== undefined && planningRevision !== worldRevision) throw new Error('规划期间世界书已更新，请重新规划。');
            if (planningAnimaConfig !== undefined && planningAnimaConfig !== animaConfigSignature()) throw new Error('规划期间 Anima 配置已改变，请重新规划。');
        };
        state.stage = 'memory'; planningStatus('正在读取本轮 Anima 记忆…');
        log('info', 'anima.recall.started', '开始读取本轮 Anima 记忆。');
        // The Anima adapter shares a completed recall only within this exact story/input round.
        const baseStory = storySnapshot(getContext(), committed ? { dropLastInput: userInput } : {});
        memory = recalledMemory ? { ...structuredClone(recalledMemory), reusedForRound: true } : await anima.recallAnima({ context: getContext(), userInput, signal,
                settings: settingsForAnima(committed), generationToken: token,
                onStatus: message => { if (id === workId) { state.animaStatus = message; render(); } } });
        check();
        if (!recalledMemory) await authorizeAnimaCleanup(check);
        log('success', 'anima.recall.completed', memory.retrievalSkipped === 'no_sources' ? '暂无召回来源，已读取本地摘要与状态，继续规划。' : '本轮 Anima 记忆读取完成。',
            { status: memory.status, reused: memory.reusedForRound === true, retrievalSkipped: memory.retrievalSkipped || null });
        state.animaStatus = memory.retrievalSkipped === 'no_sources'
            ? memory.status === 'empty' ? '尚无可召回记忆，使用当前聊天资料继续规划' : '未执行召回，已读取本地摘要与状态'
            : memory.reusedForRound ? '已读取本轮记忆；重新规划不额外消耗保留次数' : memory.status === 'empty' ? '本轮读取成功，没有相关结果' : `已读取本轮记忆 · ${memory.source}`;
        check();
        planningStatus('正在读取角色卡与世界书…');
        planningRevision = worldRevision;
        planningAnimaConfig = animaConfigSignature();
        const planningContext = await collectPlanningContext(getContext(), userInput, { inputAlreadyInChat: committed, maxContext });
        check();
        let extraBooks = { text: '', books: [], entries: [] };
        if (state.extraWorldbooks.length) {
            const catalog = getHostCatalog({ context: getContext(), worldInfoModule: getContext().worldInfoModule });
            if (!catalog.mountsKnown) throw new Error('尚未确认酒馆当前挂载的世界书，无法安全加入额外世界书。请先刷新目录。');
            extraBooks = await readExtraWorldbooks({ context: getContext(), names: state.extraWorldbooks,
                mountedNames: catalog.worldbooks.filter(book => book.mounted).map(book => book.name), signal });
            check();
        }
        const compiled = compileRound(planningContext, memory, target, extraBooks);
        if (inspectOnly) {
            if (previousAnchor && previousMemory?.text === memory.text && previousMemory?.status === memory.status) {
                anchor = previousAnchor;
                try { checkAnchor(); } catch { anchor = null; }
            }
            state.stage = state.plan ? 'review' : 'idle'; refreshPromptPreview();
            status('本轮资料已读取，可检查条目与估算用量。'); return { compiled, planningContext };
        }
        state.stage = 'planning'; planningStatus('规划模型正在生成本轮大纲…');
        log('info', 'planner.request.started', '开始请求本轮大纲。', { model: state.settings.model, messageCount: compiled.messages.length });
        const result = await requestPlan({ baseUrl: state.settings.baseUrl, model: state.settings.model, apiKey: state.apiKey,
            messages: compiled.messages, signal, timeoutMs: 180000, stream: state.settings.stream,
            ...(state.settings.temperature !== '' ? { temperature: Number(state.settings.temperature) } : {}),
            ...(state.settings.maxTokens !== '' ? { maxTokens: Number(state.settings.maxTokens) } : {}),
            transport: createSTTransport(getContext, fetchImpl), DOMParser: globalThis.DOMParser });
        check();
        const { raw: returnedText, analysis, ...plan } = result;
        state.plan = plan; state.rawPlan = plan.xml;
        state.planningAnalysis = analysis ? { ...analysis, edited: false } : { reasoning: '', supplement: '', truncated: false, edited: false };
        log('success', 'planner.request.completed', '本轮大纲已生成并通过格式校验。');
        anchor = { story: initialStory, baseStory, config: initialConfig, draft: initialDraft,
            input: userInput, committed, chatId: getContext().chatId, worldRevision, animaConfig: planningAnimaConfig,
            outlineConfig: configSignature(true), animaPath: state.animaDetectedPath || state.settings.animaPath, generationType };
        recordVersion(versionLabel); refreshPromptPreview();
        state.stage = 'review'; status('本轮大纲已生成，可以编辑、复制或确认扩写。');
        return result;
    }
    async function awaitApproval() {
        state.awaitingReview = true; state.busy = true; view.open(); render();
        const accepted = await new Promise(resolve => { gate = { resolve }; });
        gate = null; state.awaitingReview = false;
        if (!accepted) throw Object.assign(new Error('已取消本次正文扩写，大纲仍可查看。'), { code: 'CANCELLED' });
        checkAnchor();
    }
    function sameResumingStory() {
        if (!resuming || !anchor) return false;
        try { checkAnchor({ afterSubmission: true }); return true; } catch { return false; }
    }
    async function confirmAndWrite() {
        if (state.apiBusy || state.animaChecking) throw new Error('请先完成或取消 API 操作或 Anima 检测。');
        checkAnchor();
        if (state.settings.mode === 'manual') throw new Error('当前为仅生成大纲模式。可以复制或填入输入框；自动扩写需切换模式后重新规划。');
        if (gate) { gate.resolve(true); view.close(); return; }
        if (state.busy) throw new Error('当前操作尚未结束。');
        if (state.input.trimStart().startsWith('/')) throw new Error('本轮输入以 / 开头，会被酒馆作为命令处理。请将故事输入与酒馆命令分开。');
        const current = getContext();
        if (current.onlineStatus === 'no_connection') throw new Error('请先连接酒馆主模型，再确认扩写。');
        if (!hostInput()) throw new Error('没有找到酒馆输入框。');
        resuming = { plan: state.plan, started: false };
        state.busy = true;
        const generationType = anchor.generationType === 'regenerate' ? 'regenerate' : 'normal';
        if (generationType !== 'regenerate') {
            disposeReuse = anima.skipNextAnimaRecall({ matches: sameResumingStory });
            hostInput().value = anchor.committed ? '' : state.input;
            hostInput().dispatchEvent(new Event('input', { bubbles: true }));
        }
        state.stage = 'writing'; status('已确认，正在调用酒馆主模型扩写…');
        log('info', 'writer.request.started', '已确认大纲，开始调用酒馆主模型扩写。');
        view.close();
        try { await current.generate(generationType); }
        finally {
            disposeReuse?.(); disposeReuse = null; resuming = null; writerActive = false;
            pendingWriterReceipt = null;
            clearInjection(getContext()); state.busy = false; render();
        }
    }
    function receiptCurrent(receipt = writerReceipt) {
        if (!receipt || destroyed) return false;
        try {
            const current = getContext(), last = current.chat.at(-1);
            return current.chatId === receipt.chatId && current.chat.length - 1 === receipt.targetId
                && last === receipt.message && !last.is_user && !last.is_system
                && receipt.animaConfig === animaConfigSignature()
                && storySnapshot({ ...current, chat: current.chat.slice(0, receipt.targetId) }) === receipt.prefix;
        } catch { return false; }
    }
    function canRewrite() {
        return state.settings.enabled && typeof rewriteReply === 'function' && !state.busy && !state.apiBusy && !state.animaChecking
            && !state.libraryBusy && !hostGenerating && state.update.phase !== 'installing' && receiptCurrent();
    }
    async function rerollWriter() {
        const current = getContext();
        if (state.busy || state.apiBusy || state.animaChecking || state.libraryBusy || hostGenerating
            || (typeof current.isGenerating === 'function' ? current.isGenerating() : current.isGenerating)) throw new Error('请先结束当前生成或操作，再重写正文。');
        if (typeof rewriteReply !== 'function') throw new Error('当前酒馆未提供正文候选重写接口。');
        if (!receiptCurrent()) throw new Error('只能重写本页由 Vespera 生成、且仍是最后一条的正文。聊天前文或人设改变后，请重新规划。');
        if (current.onlineStatus === 'no_connection') throw new Error('请先连接酒馆主模型。');
        if (view.hasUnsavedChanges?.()) throw new Error('请先保存或放弃工作台中尚未应用的修改。');
        const receipt = writerReceipt;
        const run = { receipt, started: false, intercepted: false, ended: false, failed: false,
            nextSwipe: receipt.message.swipes?.length || 1 };
        writerReplay = run; state.busy = true; state.stage = 'writing';
        status('正在沿用这条回复的大纲重写正文…');
        try {
            await anima.installAnimaObserver({ settings: settingsForAnima(true) });
            if (run.failed || writerReplay !== run || !receiptCurrent(receipt)) throw new Error('重写前聊天已变化，请重新规划。');
            disposeReuse = anima.skipNextAnimaRecall({ type: 'swipe', matches: () => writerReplay === run
                && run.started && !run.failed && receiptCurrent(receipt) });
            await rewriteReply({ context: getContext(), message: receipt.message, targetId: receipt.targetId, nextSwipe: run.nextSwipe });
            const fresh = receipt.message.swipes?.[run.nextSwipe];
            if (run.failed || !run.intercepted || !run.ended || !receiptCurrent(receipt)
                || receipt.message.swipe_id !== run.nextSwipe || typeof fresh !== 'string' || !fresh.trim() || fresh.trim() === '...') {
                throw new Error('正文重写未完成。原正文候选仍保留；请检查主 API 连接与酒馆的滑动生成设置。');
            }
            state.stage = 'complete';
            status('正文已重写，可用消息下方的左右箭头切换版本。');
            log('success', 'writer.rerolled', '已沿用固定大纲生成正文候选，未重新规划。');
            return true;
        } finally {
            disposeReuse?.(); disposeReuse = null;
            if (writerReplay === run) writerReplay = null;
            writerActive = false; clearInjection(getContext()); state.busy = false;
            if (state.stage === 'writing') state.stage = 'complete';
            render();
        }
    }
    function captureRegeneration() {
        const current = getContext();
        assertChat(current);
        // ST removes the last assistant reply after GENERATION_STARTED and
        // before interceptors. Its unsent composer text remains untouched.
        const history = [...current.chat];
        if (history.length && !history.at(-1).is_user) history.pop();
        const last = history.at(-1);
        if (!last?.is_user || !String(last.mes || '').trim()) throw new Error('没有找到这轮对应的用户输入，暂不能重新规划。');
        const input = String(last.mes), context = { ...current, chat: history };
        const prefix = storySnapshot(context), baseStory = storySnapshot(context, { dropLastInput: input });
        const animaConfig = animaConfigSignature(), animaPath = state.animaDetectedPath || state.settings.animaPath;
        const candidates = [];
        if (anchor && state.plan && memory && anchor.chatId === current.chatId && anchor.baseStory === baseStory && anchor.input === input) {
            candidates.push({ ...anchor, plan: state.plan, memory });
        }
        if (receiptCurrent() && writerReceipt.prefix === prefix && writerReceipt.input === input) candidates.push(writerReceipt);
        const source = candidates.find(item => item.worldRevision === worldRevision && item.animaConfig === animaConfig && item.animaPath === animaPath);
        const outlineConfig = configSignature(true);
        const reuseSkippedCode = !candidates.length
            ? ((anchor && state.plan && memory) || writerReceipt ? 'REUSE_CONTEXT_CHANGED' : 'REUSE_NO_CACHE')
            : !source ? (candidates[0].worldRevision !== worldRevision ? 'REUSE_WORLDBOOK_CHANGED'
                : candidates[0].animaConfig !== animaConfig ? 'REUSE_ANIMA_CONFIG_CHANGED' : 'REUSE_ANIMA_PATH_CHANGED')
                : source.outlineConfig !== outlineConfig ? 'REUSE_CONFIG_CHANGED'
                    : !source.plan || !source.memory ? 'REUSE_NO_CACHE' : null;
        return { input, prefix, worldRevision, animaConfig, animaPath,
            memory: source ? structuredClone(source.memory) : null,
            plan: source?.outlineConfig === outlineConfig ? structuredClone(source.plan) : null,
            outlineConfig, reuseSkippedCode };
    }
    function currentRegeneration() {
        const saved = nativeRegeneration;
        if (!saved || saved.prefix !== storySnapshot(getContext())) throw new Error('重新生成时聊天已改变，请在当前聊天重试。');
        const memoryValid = saved.worldRevision === worldRevision && saved.animaConfig === animaConfigSignature()
            && saved.animaPath === (state.animaDetectedPath || state.settings.animaPath);
        const configValid = saved.outlineConfig === configSignature(true);
        return { ...saved, memory: memoryValid ? saved.memory : null,
            plan: memoryValid && configValid ? saved.plan : null,
            reuseSkippedCode: !memoryValid ? (saved.worldRevision !== worldRevision ? 'REUSE_WORLDBOOK_CHANGED'
                : saved.animaConfig !== animaConfigSignature() ? 'REUSE_ANIMA_CONFIG_CHANGED' : 'REUSE_ANIMA_PATH_CHANGED')
                : !configValid ? 'REUSE_CONFIG_CHANGED' : saved.reuseSkippedCode };
    }
    function reuseRegenerationPlan(saved) {
        const current = getContext();
        state.input = saved.input; state.plan = structuredClone(saved.plan); state.rawPlan = state.plan.xml;
        state.planningAnalysis = null; memory = { ...structuredClone(saved.memory), reusedForRound: true };
        anchor = { story: saved.prefix, baseStory: storySnapshot(current, { dropLastInput: saved.input }),
            config: configSignature(), outlineConfig: configSignature(true), draft: draft(), input: saved.input,
            committed: true, chatId: current.chatId, worldRevision, animaConfig: saved.animaConfig,
            animaPath: saved.animaPath, generationType: 'regenerate' };
        state.busy = true; state.stage = 'review'; refreshPromptPreview();
        log('success', 'planner.reused', '酒馆重新生成沿用本轮有效大纲与记忆，未请求规划模型。');
        status('已沿用本轮大纲。');
    }
    async function intercept(chat, maxContext, abort, type) {
        if (!state.settings.enabled) return;
        if (state.update.phase === 'installing') { abort(true); status('Vespera正在更新，请完成后再生成。'); return; }
        if (preparationError?.code === 'CANCELLED') { preparationError = null; abort(true); clearInjection(getContext()); return; }
        if (writerReplay) {
            const run = writerReplay;
            if (type !== 'swipe' || !run.started || run.intercepted || run.failed || !receiptCurrent(run.receipt)) {
                run.failed = true; abort(true); clearInjection(getContext());
                fail(new Error('正文重写上下文已变化，或酒馆尝试连续自动重写；已停止本次请求。')); return;
            }
            run.intercepted = true; writerActive = true;
            injectForTurn(getContext(), { ...run.receipt.content, valid: () => writerReplay === run && !run.failed && receiptCurrent(run.receipt) });
            log('info', 'writer.reroll.started', '重新注入此回复的固定大纲，只调用正文模型。');
            return;
        }
        if (resuming) {
            try { checkAnchor({ afterSubmission: true }); writerActive = true; inject(); }
            catch (e) { abort(true); fail(e); }
            return;
        }
        if (!state.settings.autoOnSend || type === 'quiet' || type === 'impersonate') return;
        if (!normalType(type) && type !== 'regenerate') { abort(true); fail(new Error('自动规划支持普通发送和酒馆重新生成。续写或滑动分支请先关闭“发送时自动规划”。')); return; }
        if (state.busy || state.apiBusy || state.animaChecking) { abort(true); fail(new Error('已有规划、API 操作或 Anima 检测正在进行，请先完成或取消。')); return; }
        let regenerationFallback = false, previousPlan = null;
        try {
            if (preparationError) throw preparationError;
            const last = getContext().chat.at(-1);
            if (!last?.is_user) throw new Error('本轮没有新的用户输入，未执行自动规划。');
            if (type === 'regenerate') {
                const saved = currentRegeneration();
                if (state.settings.regeneratePolicy === 'reuse' && saved.plan && saved.memory) reuseRegenerationPlan(saved);
                else {
                    let regenerationReason = '';
                    if (state.settings.regeneratePolicy === 'reuse') {
                        regenerationFallback = true; previousPlan = state.plan;
                        const code = saved.reuseSkippedCode || 'REUSE_NO_CACHE';
                        regenerationReason = regenerationFallbacks[code];
                        log('info', 'planner.reuse.skipped', regenerationReason, { code });
                    }
                    await performPlan(String(last.mes), { committed: true, maxContext, recalledMemory: saved.memory,
                        generationType: 'regenerate', versionLabel: '酒馆重新生成大纲', regenerationReason });
                }
            } else await performPlan(String(last.mes), { committed: true, token: generationToken, maxContext });
            if (state.settings.mode === 'manual') { abort(true); view.open(); return; }
            if (state.settings.mode === 'review') await awaitApproval();
            checkAnchor(); writerActive = true; inject();
            state.stage = 'writing'; status('大纲已临时注入，主模型正在扩写…');
        } catch (e) {
            abort(true); clearInjection(getContext());
            if (!['CANCELLED','ABORTED'].includes(e.code)) {
                const error = regenerationFallback && previousPlan && state.plan === previousPlan
                    ? Object.assign(new Error(`${e.message} 当前显示的是上次成功的大纲，仅供查看，本次未复用。`), { code: e.code }) : e;
                fail(error);
            }
        }
        finally { if (!writerActive) state.busy = false; render(); }
    }
    async function onAction(type, payload = {}) {
        try {
            if (type === 'checkUpdate') return await updater.check();
            if (type === 'installUpdate') return await updater.install();
            if (type === 'updatePreferences') { updater.setPreferences(payload); persist(); render(); return; }
            if (type === 'reloadUpdate') {
                if (state.update.phase !== 'installed') return false;
                const reloadBlocked = () => destroyed || state.busy || state.apiBusy || state.animaChecking || state.libraryBusy || hostGenerating || view.hasUnsavedChanges?.()
                    || (typeof getContext().isGenerating === 'function' ? getContext().isGenerating() : getContext().isGenerating);
                if (reloadBlocked()) {
                    status('请先保存修改并结束当前生成，再刷新页面。'); return false;
                }
                cacheDraft(); persist();
                if (typeof getContext().saveSettings === 'function') await getContext().saveSettings();
                if (reloadBlocked()) { if (!destroyed) status('当前操作已变化，请结束编辑或生成后再刷新。'); return false; }
                reloadPage(); return;
            }
            if (state.update.phase === 'installing' && !['copyLogs', 'exportLogs', 'clearLogs'].includes(type)) throw new Error('扩展正在更新，请稍后再操作。');
            if (type === 'setEnabled') return setEnabled(payload.value);
            if (!state.settings.enabled && ['generate', 'rerollPlan', 'confirmAndWrite', 'rerollWriter', 'inspectPrompts', 'diagnose'].includes(type)) {
                throw new Error('Vespera 已关闭，请先打开顶部总开关。');
            }
            if (type === 'rerollWriter') return await rerollWriter();
            const editable = ['settings', 'apiKey', 'importPreset', 'selectPreset', 'createPrompt', 'editPrompt', 'duplicatePrompt', 'movePrompt', 'deletePrompt', 'undoDeletePrompt', 'promptToggle', 'groupToggle', 'input',
                'apiProfileSelect', 'apiProfileNew', 'apiProfileSave', 'apiProfileSaveAs', 'apiProfileDelete', 'saveSettings', 'fetchModels', 'testApi',
                'presetSave', 'presetSaveAs', 'presetSelect', 'presetDelete', 'presetNew', 'detectAnima',
                'inspectPrompts', 'diagnose', 'applyDiagnosis', 'restoreVersion', 'importBackup', 'exportBackup'];
            editable.push('refreshHostCatalog', 'importHostPreset', 'extraWorldbooks', 'saveAppearance', 'restoreImportDisabled', 'createPromptGroup', 'renamePromptGroup', 'dissolvePromptGroup');
            if ((state.busy || state.apiBusy || state.animaChecking || state.libraryBusy) && editable.includes(type)) throw new Error('请先完成或取消当前操作，再修改输入或设置。');
            if ((state.apiBusy || state.animaChecking || state.libraryBusy) && ['generate', 'rerollPlan', 'confirmAndWrite'].includes(type)) throw new Error('请先完成或取消 API 操作、目录读取或 Anima 检测。');
            if (type === 'input') { state.input = payload.value; render(); return; }
            if (type === 'refreshHostCatalog') return refreshHostCatalog();
            if (type === 'importHostPreset') {
                const preset = readHostPreset({ context: getContext(), id: payload.id });
                return await onAction('importPreset', { text: JSON.stringify(preset), name: preset.name || state.hostCatalog?.presets?.find(item => item.id === payload.id)?.name });
            }
            if (type === 'extraWorldbooks') {
                assertChat(getContext());
                const names = bookNames(payload.names);
                if (names.length > 50) throw new Error('最多选择 50 本额外世界书。');
                state.extraWorldbooks = names; persist(); status('当前聊天的额外世界书选择已保存。'); return;
            }
            if (type === 'inspectPrompts' || type === 'diagnose') { await inspectOrDiagnose(type === 'diagnose'); return; }
            if (type === 'previewPrompts') { refreshPromptPreview(); render(); return; }
            if (type === 'applyDiagnosis') {
                if (!snapshotCurrent(diagnosisAnchor?.snapshot) || diagnosisAnchor.xml !== (state.plan?.xml || '')) throw new Error('诊断对应的输入、大纲或上下文已变化，请重新诊断。');
                const option = state.diagnosis?.options?.[payload.index];
                if (!Number.isInteger(payload.index) || !option) throw new Error('请选择有效的诊断建议。');
                state.input = `${state.input}\n\n【本轮调整要求】\n${option.direction}`;
                diagnosisAnchor = null; anchor = null;
                cacheDraft(); status('建议已填入本轮输入；可修改后重新生成大纲。'); return;
            }
            if (type === 'restoreVersion') {
                const version = state.planVersions.find(item => item.id === payload.id);
                if (!version) throw new Error('大纲版本已不存在。');
                state.plan = parseContent(version.xml); state.rawPlan = state.plan.xml; state.planningAnalysis = null; state.input = version.input;
                const stored = versionAnchors.get(version.id); anchor = stored?.anchor || null; memory = stored?.memory || null;
                try { checkAnchor(); } catch { anchor = null; memory = null; }
                currentVersionId = version.id; state.stage = 'review'; cacheDraft(); refreshPromptPreview();
                diagnosisAnchor = null;
                log('info', 'version.restored', '已恢复大纲版本，未修改聊天或 Anima 记忆。');
                status(anchor ? '大纲已恢复，当前输入与上下文仍匹配。' : '已恢复旧大纲供查看；上下文不匹配，重新规划后才能自动扩写。'); return;
            }
            if (type === 'exportBackup') { exportBackup(); return; }
            if (type === 'importBackup') { importBackup(payload.text); return; }
            if (type === 'apiKey') {
                if (typeof payload.value !== 'string') throw new Error('API 密钥必须是文本。');
                state.apiKey = payload.value; rememberSecret(payload.value);
                secretCache.set(state.activeApiProfileId, { key: state.apiKey, remember: state.rememberApiKey }); return;
            }
            if (type === 'saveAppearance') {
                const { theme, fontSize, lineHeight } = payload;
                if (!['system', 'light', 'dark', 'host'].includes(theme)) throw new Error('请选择有效的配色。');
                const size = Number(fontSize), height = Number(lineHeight);
                if (!String(fontSize ?? '').trim() || !Number.isFinite(size) || size < 10 || size > 24) throw new Error('字号请输入 10–24 px。');
                if (!String(lineHeight ?? '').trim() || !Number.isFinite(height) || height < 1.2 || height > 2.6) throw new Error('行距请输入 1.2–2.6。');
                // A separate whitelist keeps appearance saves away from API/profile drafts.
                state.settings = cleanSettings({ ...state.settings, theme, fontSize: size, lineHeight: height });
                persist(); status('美化已保存。'); return true;
            }
            if (type === 'settings') {
                const oldPath = state.settings.animaPath;
                state.settings = cleanSettings({ ...state.settings, ...payload, enabled: state.settings.enabled }); persist(); render();
                if (state.settings.animaPath !== oldPath) { resetDetection(); await detectAnima(); }
                return;
            }
            if (type === 'saveSettings' || type === 'apiProfileSave' || type === 'apiProfileSaveAs') return await saveApiProfile(payload, type === 'apiProfileSaveAs');
            if (type === 'detectAnima') return await detectAnima();
            if (type === 'copyLogs') { await copyText(runtimeLog.text()); status('当前会话日志已复制。'); return; }
            if (type === 'exportLogs') { download(runtimeLog.text(), 'Vespera-运行日志.txt', 'text/plain;charset=utf-8'); return; }
            if (type === 'clearLogs') { runtimeLog.clear(); status('当前会话日志已清空。'); return; }
            if (type === 'apiProfileSelect') {
                const profile = state.apiProfiles.find(item => item.id === payload.id);
                if (!profile) throw new Error('API 方案已不存在。');
                selectApiProfile(profile); persist(); status('已切换 API 方案。'); return { id: profile.id };
            }
            if (type === 'apiProfileNew') {
                const profile = { id: newId('api'), name: `API 方案 ${state.apiProfiles.length + 1}`, ...connectionSettings() };
                state.apiProfiles.push(profile); selectApiProfile(profile); persist(); status('已创建空白 API 方案，请填写后保存。'); return { id: profile.id };
            }
            if (type === 'apiProfileDelete') {
                const profile = state.apiProfiles.find(item => item.id === payload.id);
                if (!profile) throw new Error('API 方案已不存在。');
                if (state.apiProfiles.length === 1) throw new Error('请至少保留一套 API 方案。');
                try { globalThis.localStorage?.removeItem(keyStorageName(profile.id)); }
                catch { throw new Error('无法清除这套方案保存的密钥，请检查浏览器存储权限。'); }
                state.apiProfiles = state.apiProfiles.filter(item => item.id !== profile.id);
                if (state.activeApiProfileId === profile.id) selectApiProfile(state.apiProfiles[0]);
                secretCache.delete(profile.id);
                persist(); status('API 方案已删除。'); return { id: profile.id };
            }
            if (type === 'fetchModels' || type === 'testApi') return await runApiAction(type, payload);
            if (type === 'presetSave') {
                state.preset.name = named(payload.name, state.preset.name, '规划预设'); persist(); status('规划预设已保存。'); return { id: state.activePresetId };
            }
            if (type === 'presetSaveAs') {
                const copy = structuredClone(state.preset);
                const result = addPreset(copy, named(payload.name, `${copy.name} 副本`, '规划预设')); status('规划预设已另存为新方案。'); return result;
            }
            if (type === 'presetNew' || type === 'selectPreset') {
                const result = addPreset(structuredClone(defaultPreset), type === 'presetNew' ? named(payload.name, '新规划预设', '规划预设') : defaultPreset.name);
                status('已建立内置预设副本，原有方案仍保留在预设库中。'); return result;
            }
            if (type === 'presetSelect') {
                const entry = state.presetLibrary.find(item => item.id === payload.id);
                if (!entry) throw new Error('规划预设已不存在。');
                const selected = readPlanningPreset(entry.preset).preset;
                selected.name = entry.name; state.activePresetId = entry.id; state.preset = selected;
                clearDeletionUndo(); persist(); status('已切换规划预设。'); return { id: entry.id };
            }
            if (type === 'presetDelete') {
                const entry = state.presetLibrary.find(item => item.id === payload.id);
                if (!entry) throw new Error('规划预设已不存在。');
                if (state.presetLibrary.length === 1) throw new Error('请至少保留一套规划预设。');
                state.presetLibrary = state.presetLibrary.filter(item => item.id !== entry.id);
                if (state.activePresetId === entry.id) {
                    const next = state.presetLibrary[0];
                    state.preset = readPlanningPreset(next.preset).preset; state.preset.name = next.name; state.activePresetId = next.id; clearDeletionUndo();
                }
                persist(); status('规划预设已删除。'); return { id: entry.id };
            }
            if (type === 'createPromptGroup') {
                if (payload.presetId !== state.activePresetId) throw new Error('当前预设已变化，请重新选择分组范围。');
                const name = groupName(payload.name);
                const orderedIds = state.preset.order.map(entry => entry.identifier);
                const listed = new Set(orderedIds);
                const ids = [...orderedIds, ...state.preset.prompts.filter(prompt => !listed.has(prompt.identifier)).map(prompt => prompt.identifier)];
                const start = ids.indexOf(payload.startId), end = ids.indexOf(payload.endId);
                if (start < 0 || end < 0) throw new Error('所选条目已不存在，请重新选择分组范围。');
                const selectedIds = ids.slice(Math.min(start, end), Math.max(start, end) + 1);
                const id = newId('group');
                keepGroupMembersDisabled(new Set(selectedIds));
                state.preset.groups.push({ id, name, enabled: true, collapsed: false, order: Math.max(-1, ...state.preset.groups.map(group => group.order)) + 1 });
                for (const promptId of selectedIds) setPromptGroup(promptId, id);
                persist(); status(`已创建“${name}”，包含 ${selectedIds.length} 个条目。`); return { id, count: selectedIds.length };
            }
            if (type === 'renamePromptGroup') {
                const id = promptGroup(payload.id);
                if (!id) throw new Error('请选择需要改名的分组。');
                const name = groupName(payload.name);
                state.preset.groups.find(group => group.id === id).name = name;
                persist(); status('分组名称已保存。'); return { id };
            }
            if (type === 'dissolvePromptGroup') {
                const id = promptGroup(payload.id);
                if (!id) throw new Error('请选择需要解散的分组。');
                const selectedIds = Object.keys(state.preset.promptGroups).filter(promptId => state.preset.promptGroups[promptId] === id);
                keepGroupMembersDisabled(new Set(selectedIds));
                for (const promptId of selectedIds) setPromptGroup(promptId, null);
                if (undoDeletionRecord?.groupId === id) {
                    if (state.preset.groups.find(group => group.id === id)?.enabled === false && undoDeletionRecord.orderEntry) undoDeletionRecord.orderEntry.enabled = false;
                    undoDeletionRecord.groupId = null;
                }
                state.preset.groups = state.preset.groups.filter(group => group.id !== id);
                persist(); status('分组已解散，条目已保留在未分组中。'); return { id, count: selectedIds.length };
            }
            if (type === 'groupToggle') { const g = state.preset.groups.find(x => x.id === payload.id); if (g) g.enabled = payload.enabled; persist(); render(); return; }
            if (type === 'promptToggle') {
                const p = state.preset.order.find(x => x.identifier === payload.identifier);
                if (p) p.enabled = payload.enabled;
                else if (state.preset.prompts.some(x => x.identifier === payload.identifier)) state.preset.order.push({ identifier: payload.identifier, enabled: payload.enabled });
                persist(); render(); return;
            }
            if (type === 'createPrompt') {
                const name = promptName(payload.name ?? '新条目');
                const content = promptContent(payload.content ?? '');
                const role = promptRole(payload.role ?? 'system');
                const groupId = promptGroup(payload.groupId);
                const id = nextPromptId();
                const lastInGroup = groupId === null ? -1 : state.preset.order.reduce((last, item, index) => state.preset.promptGroups[item.identifier] === groupId ? index : last, -1);
                state.preset.prompts.push({ identifier: id, name, content, role, enabled: true, marker: false,
                    system_prompt: false, forbid_overrides: true, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [] });
                state.preset.order.splice(lastInGroup < 0 ? state.preset.order.length : lastInGroup + 1, 0, { identifier: id, enabled: true });
                setPromptGroup(id, groupId);
                persist(); status('条目已创建并启用。'); return { id };
            }
            if (type === 'editPrompt') {
                const prompt = editablePrompt(payload.id);
                // Validate every supplied field before changing the preset. Marker payloads
                // remain host-provided; their content and role are intentionally read-only.
                const name = payload.name === undefined ? prompt.name : promptName(payload.name);
                const content = prompt.marker || payload.content === undefined ? prompt.content : promptContent(payload.content);
                const role = prompt.marker || payload.role === undefined ? prompt.role : promptRole(payload.role);
                const groupId = payload.groupId === undefined ? undefined : promptGroup(payload.groupId);
                Object.assign(prompt, { name, content, role });
                if (groupId !== undefined) setPromptGroup(prompt.identifier, groupId);
                persist(); status('条目已保存。'); return { id: prompt.identifier };
            }
            if (type === 'duplicatePrompt') {
                const original = editablePrompt(payload.id);
                if (original.marker) throw new Error('此条目是酒馆资料占位，不能复制。可以新增普通提示词条目。');
                const id = nextPromptId();
                const prompt = { ...structuredClone(original), identifier: id, name: `${original.name} 副本` };
                state.preset.prompts.splice(state.preset.prompts.indexOf(original) + 1, 0, prompt);
                const originalIndex = state.preset.order.findIndex(item => item.identifier === original.identifier);
                const orderEntry = { identifier: id, enabled: originalIndex >= 0 && state.preset.order[originalIndex].enabled !== false };
                const groupId = state.preset.promptGroups[original.identifier] ?? null;
                const lastInGroup = state.preset.order.reduce((last, item, index) => (state.preset.promptGroups[item.identifier] ?? null) === groupId ? index : last, -1);
                state.preset.order.splice(originalIndex >= 0 ? originalIndex + 1 : lastInGroup >= 0 ? lastInGroup + 1 : state.preset.order.length, 0, orderEntry);
                setPromptGroup(id, groupId);
                persist(); status('条目副本已保存。'); return { id };
            }
            if (type === 'movePrompt') {
                const prompt = editablePrompt(payload.id);
                const groupId = payload.groupId === undefined ? state.preset.promptGroups[prompt.identifier] ?? null : promptGroup(payload.groupId);
                const beforeId = payload.beforeId ?? null;
                if (beforeId === prompt.identifier) return { id: prompt.identifier };
                const before = beforeId === null ? null : editablePrompt(beforeId);
                if (before && (state.preset.promptGroups[before.identifier] ?? null) !== groupId) throw new Error('请选择同一分组中的排序位置。');
                const ordered = state.preset.order.map(item => ({ ...item }));
                const oldIndex = ordered.findIndex(item => item.identifier === prompt.identifier);
                const moving = oldIndex < 0 ? { identifier: prompt.identifier, enabled: false } : ordered.splice(oldIndex, 1)[0];
                if (before && !ordered.some(item => item.identifier === before.identifier)) ordered.push({ identifier: before.identifier, enabled: false });
                const lastInGroup = ordered.reduce((last, item, index) => (state.preset.promptGroups[item.identifier] ?? null) === groupId ? index : last, -1);
                const index = before ? ordered.findIndex(item => item.identifier === before.identifier) : lastInGroup >= 0 ? lastInGroup + 1 : ordered.length;
                ordered.splice(index, 0, moving);
                state.preset.order = ordered; setPromptGroup(prompt.identifier, groupId);
                persist(); status('条目顺序已保存。'); return { id: prompt.identifier };
            }
            if (type === 'deletePrompt') {
                const prompt = editablePrompt(payload.id);
                const promptIndex = state.preset.prompts.indexOf(prompt);
                const orderIndex = state.preset.order.findIndex(item => item.identifier === prompt.identifier);
                undoDeletionRecord = { preset: state.preset, prompt: structuredClone(prompt), promptIndex, orderIndex,
                    orderEntry: orderIndex < 0 ? null : structuredClone(state.preset.order[orderIndex]),
                    groupId: state.preset.promptGroups[prompt.identifier] ?? null };
                state.preset.prompts.splice(promptIndex, 1);
                if (orderIndex >= 0) state.preset.order.splice(orderIndex, 1);
                delete state.preset.promptGroups[prompt.identifier];
                state.undoDeletion = { id: prompt.identifier, name: prompt.name };
                persist(); status(`已删除“${prompt.name}”，可以撤销。`); return { id: prompt.identifier };
            }
            if (type === 'undoDeletePrompt') {
                const record = undoDeletionRecord;
                if (!record || record.preset !== state.preset) throw new Error('当前没有可撤销的条目删除。');
                const id = record.prompt.identifier;
                if (state.preset.prompts.some(prompt => prompt.identifier === id) || state.preset.order.some(item => item.identifier === id)) throw new Error('同名标识的条目已经存在，未重复恢复。');
                promptGroup(record.groupId);
                state.preset.prompts.splice(Math.min(record.promptIndex, state.preset.prompts.length), 0, structuredClone(record.prompt));
                if (record.orderEntry) state.preset.order.splice(Math.min(record.orderIndex, state.preset.order.length), 0, structuredClone(record.orderEntry));
                setPromptGroup(id, record.groupId);
                clearDeletionUndo();
                persist(); status(`已恢复“${record.prompt.name}”。`); return { id };
            }
            if (type === 'importPreset') {
                if (payload.text.length > 5_000_000) throw new Error('预设文件过大，请使用不超过 5 MB 的 JSON。');
                const { preset: imported, preserveSelection } = readPlanningPreset(JSON.parse(payload.text), { name: payload.name?.replace(/\.json$/i, '') || '导入预设' });
                if (!preserveSelection && !imported.prompts.some(x => x.identifier === 'outline_output')) {
                    const protocol = structuredClone(defaultPreset.prompts.find(x => x.identifier === 'outline_output'));
                    protocol.content = '本次请求只生成下一条回复的具体剧情大纲，正文由另一模型扩写。沿用已启用条目的人物与剧情要求。\n\n' + protocol.content;
                    imported.prompts.push(protocol); imported.order.push({ identifier: protocol.identifier, enabled: true });
                    let group = imported.groups.find(item => item.id === 'workshop_protocol');
                    if (!group) { group = { id: 'workshop_protocol', name: '规划交付格式', enabled: true, collapsed: false, order: imported.groups.length }; imported.groups.push(group); }
                    imported.promptGroups[protocol.identifier] = group.id;
                }
                if (!preserveSelection) {
                    imported.importAdvice = analyzeImportedPreset(imported);
                    for (const item of imported.importAdvice.disable) {
                        const entry = imported.order.find(entry => entry.identifier === item.id);
                        if (entry) entry.enabled = false;
                    }
                }
                const count = preserveSelection ? 0 : imported.importAdvice.disable.length;
                const result = addPreset(imported);
                status(count ? `已导入副本，自动关闭 ${count} 个独立输出条目；可在导入检查中查看并恢复。` : '已导入副本，保留原开关；可在导入检查中查看提示。');
                return { ...result, autoDisabledCount: count };
            }
            if (type === 'restoreImportDisabled') {
                let count = 0;
                for (const item of state.preset.importAdvice?.disable || []) {
                    const entry = state.preset.order.find(entry => entry.identifier === item.id);
                    if (entry?.enabled === false && state.preset.prompts.some(prompt => prompt.identifier === item.id)) { entry.enabled = true; count++; }
                }
                persist(); status(`已恢复 ${count} 个导入时自动关闭的条目，请按需要检查输出要求。`); return { count };
            }
            if (type === 'exportPreset') { download(JSON.stringify(writePlanningPreset(state.preset), null, 2), `${state.preset.name}.json`, 'application/json'); return; }
            if (type === 'cancel') { cancel(); return; }
            if (type === 'generate' || type === 'rerollPlan') {
                if (state.busy) return;
                const reroll = type === 'rerollPlan';
                if (reroll && !state.plan) throw new Error('请先生成一份大纲。');
                const startChat = getContext().chatId;
                let planned = false;
                state.busy = true; render();
                try {
                    const preparationId = ++workId;
                    await anima.installAnimaObserver({ settings: settingsForAnima(false) });
                    if (preparationId !== workId) throw Object.assign(new Error('操作已取消。'), { code: 'CANCELLED' });
                    const userInput = String(payload.input ?? state.input), current = getContext();
                    const regenerate = reroll && anchor?.generationType === 'regenerate' && anchor.input === userInput;
                    if (regenerate && (anchor.chatId !== current.chatId || anchor.story !== storySnapshot(current)
                        || !current.chat.at(-1)?.is_user || current.chat.at(-1).mes !== userInput)) {
                        throw new Error('这轮重新生成的聊天已改变，请从酒馆重新生成，避免重复发送上一轮输入。');
                    }
                    // A new preset or prose target needs a new outline, but does
                    // not turn an already submitted input into a new chat message.
                    const reuseMemory = regenerate && anchor.worldRevision === worldRevision
                        && anchor.animaConfig === animaConfigSignature()
                        && anchor.animaPath === (state.animaDetectedPath || state.settings.animaPath);
                    const committed = regenerate || (!draft() && current.chat.at(-1)?.is_user && current.chat.at(-1).mes === userInput);
                    await performPlan(userInput, { committed, versionLabel: reroll ? '重生成大纲' : '生成大纲',
                        generationType: regenerate ? 'regenerate' : 'normal', recalledMemory: reuseMemory ? memory : null });
                    planned = true;
                    state.busy = false; render();
                    if (state.settings.mode === 'auto') await confirmAndWrite();
                } finally { if (!writerActive) {
                    state.busy = false;
                    if (reroll && !planned && state.plan && getContext().chatId === startChat) state.stage = 'review';
                    render();
                } }
                return;
            }
            if (type === 'applyPlanEdit') {
                if (state.busy && !state.awaitingReview) throw new Error('请先完成当前操作再修改大纲。');
                const edited = parseContent(payload.xml);
                if (state.planningAnalysis && edited.xml !== state.plan?.xml) state.planningAnalysis.edited = true;
                state.plan = edited; state.rawPlan = state.plan.xml; diagnosisAnchor = null;
                recordVersion('手动修改'); refreshPromptPreview(); status('大纲修改已校验并应用。'); return;
            }
            if (type === 'confirmAndWrite') { await confirmAndWrite(); return; }
            if (type === 'copy' || type === 'fillInput') {
                if (!state.plan) throw new Error('请先生成大纲。');
                if (type === 'copy') { await copyText(state.plan.xml); status('大纲已复制。'); }
                else {
                    const text = `${state.input}\n\n【本轮大纲，请按此扩写】\n${state.plan.xml}`;
                    if (!hostInput()) throw new Error('没有找到酒馆输入框。');
                    if (state.busy) cancel();
                    hostInput().value = text; hostInput().dispatchEvent(new Event('input', { bubbles: true }));
                    status('已填入，尚未发送。手动发送会把大纲保存为用户消息；如需隔离历史，请使用确认扩写。');
                    view.close();
                }
                return;
            }
        } catch (e) { if (!['CANCELLED','ABORTED'].includes(e.code)) fail(e); return false; }
    }
    function listen(name, handler) {
        const event = ctx.eventTypes?.[name] || ctx.event_types?.[name];
        if (event) { ctx.eventSource.on(event, handler); listeners.push([event, handler]); }
    }
    listen('GENERATION_STARTED', async (type, _options, dryRun) => {
        if (!dryRun) hostGenerating = true;
        if (!state.settings.enabled) return;
        if (!dryRun && writerReplay) {
            if (type !== 'swipe' || writerReplay.started || !receiptCurrent(writerReplay.receipt)) {
                writerReplay.failed = true;
                disposeReuse?.();
                disposeReuse = anima.skipNextAnimaRecall({ type: 'swipe', matches: () => false });
            }
            else { writerReplay.started = true; generationToken = anima.beginAnimaGeneration(); }
            return;
        }
        if (dryRun || (!state.settings.autoOnSend && !resuming) || type === 'quiet' || type === 'impersonate') return;
        clearInjection(getContext()); preparationError = null;
        try {
            nativeRegeneration = type === 'regenerate' && !resuming ? captureRegeneration() : null;
            const preparationId = workId;
            await anima.installAnimaObserver({ settings: settingsForAnima(true) });
            if (preparationId !== workId) throw Object.assign(new Error('操作已取消。'), { code: 'CANCELLED' });
            // Reviewed Anima ignores native regenerate. Read through the direct
            // path after ST has removed the old reply, or reuse this turn's snapshot.
            generationToken = type === 'regenerate' ? undefined : anima.beginAnimaGeneration();
            if (resuming) resuming.started = true;
        } catch (e) { preparationError = e; }
    });
    listen('GENERATION_ENDED', () => {
        hostGenerating = false;
        if (writerReplay) writerReplay.ended = true;
        if (writerActive) {
            if (pendingWriterReceipt && !writerReplay) {
                const current = getContext(), pending = pendingWriterReceipt, last = current.chat.at(-1);
                if (pending.chatId === current.chatId && pending.targetId === current.chat.length - 1
                    && last && !last.is_user && !last.is_system && String(last.mes || '').trim()
                    && pending.prefix === storySnapshot({ ...current, chat: current.chat.slice(0, pending.targetId) })) {
                    writerReceipt = { ...pending, message: last };
                }
            }
            log('success', 'writer.request.completed', '酒馆主模型生成已结束，临时大纲已清理。');
            state.stage = 'complete'; status('正文生成已结束；本轮临时大纲已移除。');
            const last = getContext().chat.at(-1);
            if (last && !last.is_user && !last.is_system && String(last.mes || '').trim()) anima.invalidateAnimaRoundCache?.();
        }
        pendingWriterReceipt = null; writerActive = false; clearInjection(getContext());
        nativeRegeneration = null;
        if (!gate) state.busy = false;
        anima.clearAnimaGeneration(generationToken); render();
    });
    listen('GENERATION_STOPPED', () => { hostGenerating = false; writerActive = false; cancel('生成已停止；临时大纲已移除。'); });
    listen('CHAT_CHANGED', () => { cancel('已切换聊天。'); writerReceipt = null; animaCleanup.reset(); state.input = draft(); state.extraWorldbooks = bookNames(extraWorldbooksByChat[getContext().chatId]); restoreDraft(); refreshHostCatalog(); render(); });
    for (const event of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED']) listen(event, () => quickActions?.refresh());
    const onWorldChange = (name, data) => {
        const cleanup = animaCleanup.consume(name, data, getContext().chatId);
        animaCleanup.observe(name, data);
        if (cleanup) {
            if (cleanup.cleared) log('info', 'anima.containers.cleaned', 'Anima 已清空本轮临时召回容器；已读取的大纲与记忆仍有效。', { count: cleanup.cleared });
            render(); return;
        }
        animaCleanup.invalidate();
        worldRevision++;
        if (!anima.isAnimaMemoryOperationInFlight?.()) anima.invalidateAnimaRoundCache?.();
        render();
    };
    listen('WORLDINFO_UPDATED', onWorldChange);
    listen('WORLDINFO_SETTINGS_UPDATED', onWorldChange);
    clearInjection(ctx); restoreDraft();
    return {
        state, onAction, intercept, canRewrite,
        attachQuickActions() { quickActions?.destroy(); quickActions = createWriterQuickActions({ getContext, onRewrite: () => onAction('rerollWriter'), canRewrite }); quickActions.refresh(); },
        attachEntryPoints() { entryPoints?.destroy(); entryPoints = createWorkbenchEntryPoints({ onOpen: () => this.open() }); },
        startUpdates() { updater.start(); },
        async open() {
            if (!state.busy && !state.plan) state.input = draft() || (getContext().chat?.at(-1)?.is_user ? getContext().chat.at(-1).mes : '');
            view.open(); render();
            if (state.settings.enabled && !state.busy && !state.apiBusy && !state.animaChecking) await detectAnima();
            if (!state.busy && !state.apiBusy && !state.animaChecking && typeof getContext().getWorldInfoNames === 'function') refreshHostCatalog();
        },
        destroy() { destroyed = true; quickActions?.destroy(); entryPoints?.destroy(); writerReceipt = null; animaCleanup.reset(); state.planningAnalysis = null; updater.destroy(); cancel(); for (const [event, fn] of listeners) ctx.eventSource.removeListener(event, fn); view.destroy(); state.apiKey = ''; secretCache.clear(); },
    };
}

function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(text) {
    if (globalThis.isSecureContext && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
    const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
    // Place within the active dialog so focus trapping does not break HTTP/mobile fallback.
    (document.querySelector('dialog[open]') || document.body).append(field); field.focus(); field.select(); field.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); field.remove(); if (!ok) throw new Error('当前浏览器不允许自动复制，请在编辑页长按选择大纲文本。');
}

let booted;
function menuIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.style.cssText = 'width:1.15em;height:1.15em;flex:0 0 1.15em;vertical-align:middle;margin-inline-end:0.4em';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3z M18.5 3v4 M16.5 5h4');
    svg.append(path); return svg;
}
export async function boot() {
    if (booted) return booted;
    booted = (async () => {
        const extensions = await import('/scripts/extensions.js');
        const source = () => globalThis.SillyTavern?.getContext?.() || extensions.getContext();
        const [worldInfoModule, scriptModule, presetResponse, writerResponse, manifestResponse] = await Promise.all([
            import('/scripts/world-info.js'), import('/script.js'), fetch(new URL('presets/default.json', base)), fetch(new URL('presets/writer.txt', base)),
            fetch(new URL('manifest.json', base)),
        ]);
        if (!presetResponse.ok || !writerResponse.ok) throw new Error('内置预设文件加载失败，请重新安装完整扩展目录。');
        const getContext = () => {
            const c = source();
            return { ...c, getWorldInfoPrompt: c.getWorldInfoPrompt || worldInfoModule.getWorldInfoPrompt,
                loadWorldInfo: c.loadWorldInfo || worldInfoModule.loadWorldInfo,
                getCharacterCardFields: c.getCharacterCardFields || scriptModule.getCharacterCardFields,
                getRequestHeaders: c.getRequestHeaders || scriptModule.getRequestHeaders,
                saveSettings: () => saveSettingsBeforeReload(scriptModule), isGenerating: scriptModule.isGenerating || (() => scriptModule.is_send_press === true),
                extensionNames: extensions.extensionNames, getExtensionManifest: extensions.getExtensionManifest, worldInfoModule };
        };
        const manifest = manifestResponse.ok ? await manifestResponse.json() : {};
        const plugin = await createPlugin({ getContext, builtin: await presetResponse.json(), writerRules: await writerResponse.text(), currentVersion: manifest.version || '未知',
            async rewriteReply({ context, message, targetId, nextSwipe }) {
                if (typeof context.swipe?.to !== 'function') throw new Error('当前酒馆缺少 swipe.to 接口，请升级酒馆后使用正文重写。');
                if (context.swipe.isAllowed?.() === false) throw new Error('请启用酒馆的消息滑动生成，并结束当前生成或消息编辑。');
                const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
                if (SWIPE_DIRECTION?.RIGHT === undefined) throw new Error('当前酒馆未提供滑动方向接口。');
                await context.swipe.to(null, SWIPE_DIRECTION.RIGHT, { message, forceMesId: targetId, forceSwipeId: nextSwipe, forceDuration: 0 });
            } });
        globalThis.PlotWorkshop_Interceptor = plugin.intercept;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button';
        button.append(menuIcon(), document.createTextNode('Vespera')); button.style.minHeight = '44px';
        button.addEventListener('click', () => plugin.open());
        const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (container) container.append(button);
        plugin.attachEntryPoints();
        plugin.attachQuickActions();
        plugin.startUpdates();
        return plugin;
    })();
    return booted;
}

// The preview loads ui.js directly; only a real ST host boots this integration.
if (globalThis.SillyTavern?.getContext) {
    globalThis.PlotWorkshop_Interceptor = async (...args) => {
        try { return await (await boot()).intercept(...args); }
        catch { args[2]?.(true); globalThis.toastr?.error('Vespera未能加载，已停止本次生成。请检查扩展文件是否完整。'); }
    };
    boot().catch(() => globalThis.toastr?.error('Vespera加载失败，请确认完整安装并查看浏览器控制台中的模块加载错误。'));
}
