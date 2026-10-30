// Uses only SillyTavern's extension discover/version/update routes. The update
// route pulls origin's current branch; this module never switches or resets it.
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const IDLE_INTERVAL = 30 * 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class UpdateError extends Error {
    constructor(code, message, unsupported = false) { super(message); this.code = code; this.unsupported = unsupported; }
}
const fail = (code, message, unsupported = false) => { throw new UpdateError(code, message, unsupported); };

function ownFolder(extensionUrl) {
    let url;
    try { url = new URL(extensionUrl, globalThis.location?.href); }
    catch { fail('EXTENSION_LOCATION', '无法确认本扩展的安装目录，请通过酒馆扩展管理更新。', true); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (globalThis.location?.origin && url.origin !== globalThis.location.origin)) {
        fail('EXTENSION_LOCATION', '本扩展不是从当前酒馆的扩展目录加载，不能自动更新。', true);
    }
    const match = url.pathname.match(/^\/scripts\/extensions\/third-party\/([^/]+)(?:\/|$)/);
    let folder;
    try { folder = match && decodeURIComponent(match[1]); } catch { /* invalid encoded directory */ }
    if (!folder || /^[. ]|[. ]$/.test(folder) || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(folder) || folder === '..') {
        fail('EXTENSION_LOCATION', '无法安全识别本扩展的安装目录，请通过酒馆扩展管理更新。', true);
    }
    return folder;
}

function officialRemote(remote) {
    if (typeof remote !== 'string' || remote !== remote.trim()) return false;
    if (/^git@github\.com:Cherie1227\/plot-workshop(?:\.git)?\/?$/i.test(remote)) return true;
    try {
        const url = new URL(remote);
        if (url.hostname.toLowerCase() !== 'github.com' || url.port || url.password || url.search || url.hash) return false;
        if (url.protocol === 'https:' ? Boolean(url.username) : url.protocol !== 'ssh:' || url.username !== 'git') return false;
        return /^\/Cherie1227\/plot-workshop(?:\.git)?\/?$/i.test(url.pathname);
    } catch { return false; }
}

function validateVersion(data) {
    if (!record(data) || typeof data.isUpToDate !== 'boolean' || typeof data.remoteUrl !== 'string' || typeof data.currentBranchName !== 'string' || typeof data.currentCommitHash !== 'string') {
        fail('RESPONSE_INVALID', '酒馆返回的版本信息格式不受支持。');
    }
    if (!data.remoteUrl && !data.currentCommitHash) fail('NOT_GIT', '此安装不是可更新的 Git 仓库；ZIP 安装请在酒馆中重新安装仓库版。', true);
    if (!officialRemote(data.remoteUrl)) fail('FOREIGN_REMOTE', '此安装的远程仓库不是Vespera官方仓库，已停止更新。', true);
    if (!/^[a-f\d]{7,64}$/i.test(data.currentCommitHash) || !data.currentBranchName.trim() || data.currentBranchName === 'HEAD' || /[\x00-\x1f\x7f]/.test(data.currentBranchName) || data.currentBranchName.length > 200) {
        fail('BRANCH_UNSUPPORTED', '无法确认此安装的当前分支，请通过酒馆扩展管理检查。', true);
    }
    return data;
}

/**
 * onChange is a rendering signal, never a persistence or reload command.
 * canInstall(automatic) must positively confirm an idle host (and, for automatic
 * updates, a closed panel and no unsaved draft). Missing/throwing guards deny.
 * check/install resolve to state; errors use fixed messages and safe errorCode.
 */
export function createUpdater({ getContext, fetchImpl = globalThis.fetch, extensionUrl, currentVersion = '', preferences = {}, onChange = () => {}, canInstall = () => false,
    now = () => Date.now(), setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval, requestTimeoutMs = 30000 } = {}) {
    const state = { phase: 'unchecked', message: '尚未检查更新。', currentVersion: String(currentVersion), checkedAt: null,
        autoCheck: preferences.autoCheck !== false, autoInstall: preferences.autoInstall === true, available: false,
        errorCode: '', updateUncertain: false };
    let active = null, target = null, started = false, destroyed = false, interval = null, lastAttempt = null;
    const timestamp = () => { const value = Number(now()); return Number.isFinite(value) ? value : Date.now(); };
    function change(patch, notify = false) {
        Object.assign(state, patch);
        if (!destroyed) { try { onChange(state, { notify }); } catch { /* render failures must not retry a network mutation */ } }
        return state;
    }
    const automaticAllowed = () => state.autoCheck && state.autoInstall && !destroyed;
    const live = operation => !destroyed && active === operation && !operation.controller.signal.aborted;
    function ensureLive(operation) { if (!live(operation)) fail('ABORTED', '更新操作已停止。'); }
    async function request(route, operation, body) {
        const context = getContext?.();
        if (typeof context?.getRequestHeaders !== 'function') fail('HOST_UNSUPPORTED', '当前酒馆未提供扩展请求认证接口。', true);
        if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 900000) fail('TIMEOUT_INVALID', '更新请求超时设置无效。');
        ensureLive(operation);
        const controller = new AbortController();
        let timer, abort;
        const stop = new Promise((_, reject) => {
            abort = () => { controller.abort(); reject(new UpdateError('ABORTED', '更新操作已停止。')); };
            operation.controller.signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => { controller.abort(); reject(new UpdateError('TIMEOUT', '更新请求超时，请检查酒馆网络后手动检查。')); }, requestTimeoutMs);
        });
        try {
            return await Promise.race([stop, (async () => {
                const response = await fetchImpl(`/api/extensions/${route}`, {
                    method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: context.getRequestHeaders(), signal: controller.signal,
                    ...(body ? { body: JSON.stringify(body) } : {}),
                });
                if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') fail('RESPONSE_INVALID', '酒馆未返回有效的更新响应。');
                if (!response.ok) {
                    if (response.status === 403) fail('FORBIDDEN', '酒馆拒绝了更新操作；全局扩展需要管理员权限。');
                    if ([404, 405].includes(response.status)) fail('HOST_UNSUPPORTED', '当前酒馆未提供所需扩展接口或安装目录已变化。', true);
                    fail('HTTP_ERROR', '酒馆更新请求失败，请检查服务器后手动重试。');
                }
                let data;
                try { data = await response.json(); } catch { fail('RESPONSE_INVALID', '酒馆未返回有效的更新 JSON。'); }
                return data;
            })()]);
        } catch (error) {
            if (error instanceof UpdateError) throw error;
            if (operation.controller.signal.aborted) fail('ABORTED', '更新操作已停止。');
            // Neither response text nor network exception strings are safe to display.
            fail('NETWORK_ERROR', '更新请求未完成，请检查酒馆连接后手动检查。');
        } finally { clearTimeout(timer); operation.controller.signal.removeEventListener('abort', abort); }
    }
    async function inspect(operation) {
        const folder = ownFolder(extensionUrl);
        const discovered = await request('discover', operation);
        ensureLive(operation);
        if (!Array.isArray(discovered)) fail('RESPONSE_INVALID', '酒馆扩展目录格式不受支持。');
        const matches = discovered.filter(item => record(item) && item.name === `third-party/${folder}`);
        if (matches.length !== 1 || !['local', 'global'].includes(matches[0].type)) {
            fail('INSTALLATION_UNKNOWN', '未能唯一确认本扩展的安装位置，已停止自动更新。', true);
        }
        const found = { extensionName: folder, global: matches[0].type === 'global' };
        const data = validateVersion(await request('version', operation, found));
        ensureLive(operation);
        return { found, data };
    }
    function reportError(error, operation, automatic) {
        const safe = error instanceof UpdateError ? error : new UpdateError('UPDATE_ERROR', '更新操作未完成，请手动检查酒馆状态。');
        if (operation.mutationSent) {
            return change({ phase: 'error', available: false, updateUncertain: true, errorCode: safe.code,
                message: '未能确认更新结果，服务器可能仍在处理。已停止自动重试；请手动检查更新后再操作。' }, true);
        }
        return change({ phase: safe.unsupported ? 'unsupported' : 'error', available: false, errorCode: safe.code, message: safe.message }, !automatic);
    }
    async function check({ automatic = false } = {}) {
        if (destroyed || active || state.phase === 'installed') return state;
        if (automatic && (!state.autoCheck || state.updateUncertain || (lastAttempt !== null && timestamp() - lastAttempt < CHECK_INTERVAL))) return state;
        lastAttempt = timestamp();
        const operation = { kind: 'check', automatic, controller: new AbortController(), mutationSent: false };
        active = operation;
        const previousAvailable = state.available, wasUncertain = state.updateUncertain;
        change({ phase: 'checking', message: '正在检查当前分支的更新…', errorCode: '' });
        try {
            const { found, data } = await inspect(operation);
            ensureLive(operation); target = found;
            const installed = wasUncertain && data.isUpToDate;
            return change({ phase: installed ? 'installed' : data.isUpToDate ? 'current' : 'available', checkedAt: timestamp(), available: !data.isUpToDate,
                updateUncertain: false, errorCode: '', message: installed ? '服务器已是最新状态。先前的更新可能已完成，请刷新酒馆后使用。' :
                    data.isUpToDate ? '当前分支已是最新状态。' : '当前分支有可用更新。' }, !automatic || (!data.isUpToDate && !previousAvailable));
        } catch (error) { if (live(operation)) reportError(error, operation, automatic); return state; }
        finally { if (active === operation) active = null; }
    }
    async function allowed(operation, automatic) {
        let idle = false;
        try { idle = await canInstall(automatic); } catch { /* absence of idle confirmation is not permission */ }
        ensureLive(operation);
        if (automatic && !automaticAllowed()) return false;
        if (idle !== true) {
            change({ phase: 'deferred', message: automatic ? '已发现更新，将在关闭面板且酒馆空闲、没有未保存内容时安装。' : '酒馆仍在生成或有未保存内容，请结束当前操作后再更新。' });
            return false;
        }
        return true;
    }
    async function install({ automatic = false } = {}) {
        if (destroyed || active || state.phase === 'installed') return state;
        if (automatic && !automaticAllowed()) return state;
        if (state.updateUncertain) return change({ phase: 'error', message: '上次更新结果尚未确认，请先手动检查更新。' }, !automatic);
        if (!state.available || !target) return state;
        const operation = { kind: 'install', controller: new AbortController(), mutationSent: false };
        active = operation;
        try {
            if (!await allowed(operation, automatic)) return state;
            change({ phase: 'checking', message: '正在确认本扩展的安装位置和远程仓库…', errorCode: '' });
            const { found, data } = await inspect(operation);
            if (found.extensionName !== target.extensionName || found.global !== target.global) fail('INSTALLATION_CHANGED', '本扩展的安装位置已变化，请手动重新检查后再更新。', true);
            if (data.isUpToDate) return change({ phase: 'current', available: false, checkedAt: timestamp(), message: '当前分支已是最新状态。' }, !automatic);
            if (!await allowed(operation, automatic)) {
                if (live(operation) && state.phase === 'checking') change({ phase: 'available', message: '自动安装已关闭；更新仍可手动安装。' });
                return state;
            }
            ensureLive(operation);
            change({ phase: 'installing', message: '正在通过酒馆安装本扩展的更新，请保持页面打开…' });
            operation.mutationSent = true;
            const result = await request('update', operation, found);
            ensureLive(operation);
            if (!record(result) || typeof result.isUpToDate !== 'boolean' || !/^[a-f\d]{7,64}$/i.test(result.shortCommitHash || '') || !officialRemote(result.remoteUrl)) {
                fail('RESPONSE_INVALID', '酒馆未返回可确认的更新结果。');
            }
            return change({ phase: 'installed', available: false, checkedAt: timestamp(), updateUncertain: false, errorCode: '',
                message: '更新已安装，请刷新酒馆使新版本生效。' }, true);
        } catch (error) { if (live(operation)) reportError(error, operation, automatic); return state; }
        finally { if (active === operation) active = null; }
    }
    async function tick() {
        if (destroyed || active || state.phase === 'installed' || !state.autoCheck || state.updateUncertain) return state;
        if (!state.available) await check({ automatic: true });
        else if (lastAttempt === null || timestamp() - lastAttempt >= CHECK_INTERVAL) await check({ automatic: true });
        if (!destroyed && !active && state.available && automaticAllowed()) await install({ automatic: true });
        return state;
    }
    function setPreferences(values = {}) {
        const patch = {};
        if (typeof values.autoCheck === 'boolean') patch.autoCheck = values.autoCheck;
        if (typeof values.autoInstall === 'boolean') patch.autoInstall = values.autoInstall;
        change(patch);
        if (!state.autoCheck && active?.kind === 'check' && active.automatic) {
            active.controller.abort();
            change({ phase: state.available ? 'available' : 'unchecked', message: '已关闭自动检查。' });
        }
        // An update already sent to ST may continue server-side. Installation
        // preflight rechecks these preferences immediately before sending it.
        return state;
    }
    function start() {
        if (destroyed) return Promise.resolve(state);
        if (!started) { started = true; interval = setIntervalImpl(() => { void tick(); }, IDLE_INTERVAL); }
        return tick();
    }
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (interval !== null) clearIntervalImpl(interval);
        interval = null;
        if (active) {
            const mutationSent = active.mutationSent;
            active.controller.abort();
            change({ phase: mutationSent ? 'error' : 'unchecked', available: false, updateUncertain: mutationSent || state.updateUncertain, errorCode: 'ABORTED',
                message: mutationSent ? '已停止等待更新结果，服务器更新可能仍在进行。重新打开后请先手动检查。' : '更新检查已停止。' });
        }
    }
    return { state, check, install, setPreferences, start, destroy };
}
