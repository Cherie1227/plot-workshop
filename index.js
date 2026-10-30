import { createWorkbench } from './ui.js';
import { normalizePreset, exportPreset, compilePreset } from './lib/preset.js';
import { parseContent } from './lib/content.js';
import { requestPlan, normalizeEndpoint, redactSecrets } from './lib/planner.js';
import * as nativeAnima from './lib/anima.js';
import { DEFAULT_SETTINGS, cleanSettings, proseTarget, assertChat, storySnapshot, collectPlanningContext, createSTTransport, injectForTurn, clearInjection } from './lib/host.js';

const STORE = 'plot_workshop';
const base = new URL('./', import.meta.url);
const normalType = type => !type || type === 'normal';

/** Exported for host-contract integration tests; normal installation uses boot(). */
export async function createPlugin({ getContext, builtin, writerRules, anima = nativeAnima, viewFactory = createWorkbench, fetchImpl = fetch } = {}) {
    const ctx = getContext();
    const saved = ctx.extensionSettings[STORE] || {};
    let defaultPreset = normalizePreset(builtin, { name: '第三人称 · 轻度抢话' });
    let selected;
    try { selected = saved.preset ? normalizePreset(saved.preset) : structuredClone(defaultPreset); }
    catch { selected = structuredClone(defaultPreset); }
    const state = { settings: cleanSettings(saved.settings), preset: selected, apiKey: '', input: '', plan: null, rawPlan: '',
        status: '准备就绪', stage: 'idle', busy: false, awaitingReview: false, animaStatus: '尚未连接', warnings: [], isPreview: false };
    let workId = 0, controller = null, gate = null, anchor = null, memory = null;
    let generationToken, preparationError, resuming = null, writerActive = false, disposeReuse = null, worldRevision = 0;
    const listeners = [];
    const view = viewFactory({ getState: () => state, onAction });
    const hostInput = () => document.querySelector('#send_textarea');
    const draft = () => String(hostInput()?.value ?? '');
    const configSignature = () => JSON.stringify({ settings: state.settings, preset: state.preset });
    const animaConfigSignature = () => JSON.stringify(getContext().extensionSettings.anima_memory_system ?? null);
    const settingsForAnima = inputAlreadyInChat => ({ frontendPath: state.settings.animaPath, inputAlreadyInChat });
    function render() { view.render(); }
    function status(message) { state.status = message; render(); }
    function persist() {
        const current = getContext();
        // No key, raw response, recalled memory or plan is saved in ST settings/chat metadata.
        current.extensionSettings[STORE] = { settings: cleanSettings(state.settings), preset: exportPreset(state.preset) };
        current.saveSettingsDebounced();
    }
    function fail(error) {
        status(redactSecrets(error?.message || '操作未完成。', [state.apiKey]).slice(0, 500));
        view.open();
    }
    function cacheDraft() {
        try {
            sessionStorage.setItem(`${STORE}:draft:${getContext().chatId}`, JSON.stringify({ xml: state.plan.xml, input: state.input }));
        } catch { /* Session storage may be unavailable; the visible draft remains usable. */ }
    }
    function restoreDraft() {
        state.plan = null; state.rawPlan = ''; anchor = null; memory = null;
        try {
            const savedDraft = JSON.parse(sessionStorage.getItem(`${STORE}:draft:${getContext().chatId}`));
            if (savedDraft?.xml) {
                state.plan = parseContent(savedDraft.xml); state.rawPlan = savedDraft.xml; state.input = savedDraft.input || '';
                state.status = '已恢复上次大纲供查看；重新规划后才能自动扩写。';
            }
        } catch { /* A malformed saved draft is never injected. */ }
    }
    function cancel(message = '已取消；大纲没有写入聊天。') {
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
        injectForTurn(getContext(), { xml: state.plan.xml, memory: memory?.text || '', target: proseTarget(state.settings), writerRules,
            valid: () => !!writerActive && anchor === fixedAnchor && getContext().chatId === fixedAnchor.chatId });
        writerActive = true;
    }
    async function performPlan(userInput, { committed = false, token, maxContext } = {}) {
        if (!userInput.trim()) throw new Error('请先填写本轮输入。');
        normalizeEndpoint(state.settings.baseUrl);
        if (!state.settings.model.trim()) throw new Error('请先在设置中填写规划模型名称。');
        const target = proseTarget(state.settings);
        assertChat(getContext());
        const id = ++workId;
        controller = new AbortController();
        const signal = controller.signal;
        const initialStory = storySnapshot(getContext()), initialConfig = configSignature(), initialDraft = draft();
        let planningRevision, planningAnimaConfig;
        state.input = userInput; state.busy = true; state.awaitingReview = false;
        anchor = null; clearInjection(getContext());
        const check = () => {
            if (id !== workId || signal.aborted) throw Object.assign(new Error('本轮规划已取消。'), { code: 'CANCELLED' });
            if (storySnapshot(getContext()) !== initialStory || configSignature() !== initialConfig || state.input !== userInput || draft() !== initialDraft) throw new Error('规划期间上下文发生变化，结果没有用于扩写，请重新规划。');
            if (planningRevision !== undefined && planningRevision !== worldRevision) throw new Error('规划期间世界书已更新，请重新规划。');
            if (planningAnimaConfig !== undefined && planningAnimaConfig !== animaConfigSignature()) throw new Error('规划期间 Anima 配置已改变，请重新规划。');
        };
        state.stage = 'memory'; status('正在读取本轮 Anima 记忆…');
        // The Anima adapter shares a completed recall only within this exact story/input round.
        const baseStory = storySnapshot(getContext(), committed ? { dropLastInput: userInput } : {});
        memory = await anima.recallAnima({ context: getContext(), userInput, signal,
                settings: settingsForAnima(committed), generationToken: token,
                onStatus: message => { if (id === workId) { state.animaStatus = message; render(); } } });
        check();
        state.animaStatus = memory.reusedForRound ? '已读取本轮记忆；重新规划不额外消耗保留次数' : memory.status === 'empty' ? '本轮读取成功，没有相关结果' : `已读取本轮记忆 · ${memory.source}`;
        check();
        status('正在读取角色卡与世界书…');
        planningRevision = worldRevision;
        planningAnimaConfig = animaConfigSignature();
        const planningContext = await collectPlanningContext(getContext(), userInput, { inputAlreadyInChat: committed, maxContext });
        check();
        const compiled = compilePreset(state.preset, { context: { ...planningContext,
            animaMemory: memory.text, animaStatus: memory.status === 'empty' ? 'empty' : 'success' }, targetLength: target });
        state.warnings = compiled.warnings;
        state.stage = 'planning'; status('规划模型正在生成本轮大纲…');
        const result = await requestPlan({ baseUrl: state.settings.baseUrl, model: state.settings.model, apiKey: state.apiKey,
            messages: compiled.messages, signal, timeoutMs: 180000,
            ...(state.settings.temperature !== '' ? { temperature: Number(state.settings.temperature) } : {}),
            ...(state.settings.maxTokens !== '' ? { maxTokens: Number(state.settings.maxTokens) } : {}),
            transport: createSTTransport(getContext, fetchImpl), DOMParser: globalThis.DOMParser });
        check();
        state.plan = result; state.rawPlan = result.xml;
        anchor = { story: initialStory, baseStory, config: initialConfig, draft: initialDraft,
            input: userInput, committed, chatId: getContext().chatId, worldRevision, animaConfig: planningAnimaConfig };
        cacheDraft();
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
        disposeReuse = anima.skipNextAnimaRecall({ matches: sameResumingStory });
        hostInput().value = anchor.committed ? '' : state.input;
        hostInput().dispatchEvent(new Event('input', { bubbles: true }));
        state.stage = 'writing'; status('已确认，正在调用酒馆主模型扩写…');
        view.close();
        try { await current.generate('normal'); }
        finally {
            disposeReuse?.(); disposeReuse = null; resuming = null; writerActive = false;
            clearInjection(getContext()); state.busy = false; render();
        }
    }
    async function intercept(chat, maxContext, abort, type) {
        if (resuming) {
            try { checkAnchor({ afterSubmission: true }); writerActive = true; inject(); }
            catch (e) { abort(true); fail(e); }
            return;
        }
        if (!state.settings.autoOnSend || type === 'quiet' || type === 'impersonate') return;
        if (!normalType(type)) { abort(true); fail(new Error('首版自动规划支持普通发送。续写、重生成或滑动分支请先关闭“发送时自动规划”。')); return; }
        if (state.busy) { abort(true); fail(new Error('已有规划正在进行，请先完成或取消。')); return; }
        try {
            if (preparationError) throw preparationError;
            const last = getContext().chat.at(-1);
            if (!last?.is_user) throw new Error('本轮没有新的用户输入，未执行自动规划。');
            await performPlan(String(last.mes), { committed: true, token: generationToken, maxContext });
            if (state.settings.mode === 'manual') { abort(true); view.open(); return; }
            if (state.settings.mode === 'review') await awaitApproval();
            checkAnchor(); writerActive = true; inject();
            state.stage = 'writing'; status('大纲已临时注入，主模型正在扩写…');
        } catch (e) { abort(true); clearInjection(getContext()); if (!['CANCELLED','ABORTED'].includes(e.code)) fail(e); }
        finally { if (!writerActive) state.busy = false; render(); }
    }
    async function onAction(type, payload = {}) {
        try {
            const editable = ['settings', 'apiKey', 'importPreset', 'selectPreset', 'editPrompt', 'promptToggle', 'groupToggle', 'input'];
            if (state.busy && editable.includes(type)) throw new Error('请先完成或取消当前规划，再修改输入或设置。');
            if (type === 'input') { state.input = payload.value; return; }
            if (type === 'apiKey') { state.apiKey = payload.value; return; }
            if (type === 'settings') { state.settings = cleanSettings({ ...state.settings, ...payload }); persist(); render(); return; }
            if (type === 'groupToggle') { const g = state.preset.groups.find(x => x.id === payload.id); if (g) g.enabled = payload.enabled; persist(); render(); return; }
            if (type === 'promptToggle') {
                const p = state.preset.order.find(x => x.identifier === payload.identifier);
                if (p) p.enabled = payload.enabled;
                else if (state.preset.prompts.some(x => x.identifier === payload.identifier)) state.preset.order.push({ identifier: payload.identifier, enabled: payload.enabled });
                persist(); render(); return;
            }
            if (type === 'editPrompt') { const p = state.preset.prompts.find(x => x.identifier === payload.id); if (p && !p.marker) p.content = payload.content; persist(); status('条目已保存。'); return; }
            if (type === 'selectPreset') { state.preset = structuredClone(defaultPreset); persist(); status('已载入内置规划预设。'); return; }
            if (type === 'importPreset') {
                if (payload.text.length > 5_000_000) throw new Error('预设文件过大，请使用不超过 5 MB 的 JSON。');
                const imported = normalizePreset(JSON.parse(payload.text), { name: payload.name?.replace(/\.json$/i, '') || '导入预设' });
                if (!imported.prompts.some(x => x.identifier === 'outline_output')) {
                    const protocol = structuredClone(defaultPreset.prompts.find(x => x.identifier === 'outline_output'));
                    protocol.content = '本次请求只生成下一条回复的具体剧情大纲，正文由另一模型扩写。沿用已启用条目的人物与剧情要求。\n\n' + protocol.content;
                    imported.prompts.push(protocol); imported.order.push({ identifier: protocol.identifier, enabled: true });
                    const group = { id: 'workshop_protocol', name: '规划交付格式', enabled: true, collapsed: false, order: imported.groups.length };
                    imported.groups.push(group); imported.promptGroups[protocol.identifier] = group.id;
                }
                imported.warnings.push('已保留原预设条目。请关闭原来的正文输出、状态栏等冲突模块，并将正文字数配置为两阶段共享目标。');
                state.preset = imported; persist(); status('预设已导入；请在条目列表中检查启用项和输出要求。'); return;
            }
            if (type === 'exportPreset') { download(JSON.stringify(exportPreset(state.preset), null, 2), `${state.preset.name}.json`, 'application/json'); return; }
            if (type === 'cancel') { cancel(); return; }
            if (type === 'generate') {
                if (state.busy) return;
                state.busy = true; render();
                try {
                    await anima.installAnimaObserver({ settings: settingsForAnima(false) });
                    const committed = !draft() && getContext().chat.at(-1)?.is_user && getContext().chat.at(-1).mes === payload.input;
                    await performPlan(String(payload.input ?? state.input), { committed });
                    state.busy = false; render();
                    if (state.settings.mode === 'auto') await confirmAndWrite();
                } finally { if (!writerActive) { state.busy = false; render(); } }
                return;
            }
            if (type === 'applyPlanEdit') { state.plan = parseContent(payload.xml); state.rawPlan = state.plan.xml; cacheDraft(); status('大纲修改已校验并应用。'); return; }
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
        if (dryRun || (!state.settings.autoOnSend && !resuming) || type === 'quiet' || type === 'impersonate') return;
        clearInjection(getContext()); preparationError = null;
        try {
            await anima.installAnimaObserver({ settings: settingsForAnima(true) });
            generationToken = anima.beginAnimaGeneration();
            if (resuming) resuming.started = true;
        } catch (e) { preparationError = e; }
    });
    listen('GENERATION_ENDED', () => {
        if (writerActive) {
            state.stage = 'complete'; status('正文生成已结束；本轮临时大纲已移除。');
            const last = getContext().chat.at(-1);
            if (last && !last.is_user && !last.is_system && String(last.mes || '').trim()) anima.invalidateAnimaRoundCache?.();
        }
        writerActive = false; clearInjection(getContext());
        if (!gate) state.busy = false;
        anima.clearAnimaGeneration(generationToken); render();
    });
    listen('GENERATION_STOPPED', () => { writerActive = false; cancel('生成已停止；临时大纲已移除。'); });
    listen('CHAT_CHANGED', () => { cancel('已切换聊天。'); state.input = draft(); restoreDraft(); render(); });
    const onWorldChange = () => {
        worldRevision++;
        if (!anima.isAnimaMemoryOperationInFlight?.()) anima.invalidateAnimaRoundCache?.();
    };
    listen('WORLDINFO_UPDATED', onWorldChange);
    listen('WORLDINFO_SETTINGS_UPDATED', onWorldChange);
    clearInjection(ctx); restoreDraft();
    return {
        state, onAction, intercept,
        open() { if (!state.busy && !state.plan) state.input = draft() || (getContext().chat.at(-1)?.is_user ? getContext().chat.at(-1).mes : ''); view.open(); render(); },
        destroy() { cancel(); for (const [event, fn] of listeners) ctx.eventSource.removeListener(event, fn); view.destroy(); state.apiKey = ''; },
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
export async function boot() {
    if (booted) return booted;
    booted = (async () => {
        const extensions = globalThis.SillyTavern?.getContext ? null : await import('/scripts/extensions.js');
        const source = () => globalThis.SillyTavern?.getContext?.() || extensions.getContext();
        const [worldInfoModule, scriptModule, presetResponse, writerResponse] = await Promise.all([
            import('/scripts/world-info.js'), import('/script.js'), fetch(new URL('presets/default.json', base)), fetch(new URL('presets/writer.txt', base)),
        ]);
        if (!presetResponse.ok || !writerResponse.ok) throw new Error('内置预设文件加载失败，请重新安装完整扩展目录。');
        const getContext = () => {
            const c = source();
            return { ...c, getWorldInfoPrompt: c.getWorldInfoPrompt || worldInfoModule.getWorldInfoPrompt,
                getCharacterCardFields: c.getCharacterCardFields || scriptModule.getCharacterCardFields };
        };
        const plugin = await createPlugin({ getContext, builtin: await presetResponse.json(), writerRules: await writerResponse.text() });
        globalThis.PlotWorkshop_Interceptor = plugin.intercept;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button';
        button.textContent = '剧情工坊 · 打开大纲面板'; button.style.minHeight = '44px';
        button.addEventListener('click', () => plugin.open());
        const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (container) container.append(button);
        const actionMenu = document.querySelector('#extensionsMenu');
        if (actionMenu) { const quick = document.createElement('div'); quick.className = 'list-group-item flex-container flexGap5'; quick.setAttribute('role','button'); quick.tabIndex = 0; quick.textContent = '剧情工坊'; quick.addEventListener('click', () => plugin.open()); quick.addEventListener('keydown', e => { if(e.key === 'Enter') plugin.open(); }); actionMenu.append(quick); }
        return plugin;
    })();
    return booted;
}

// The preview loads ui.js directly; only a real ST host boots this integration.
if (globalThis.SillyTavern?.getContext) {
    globalThis.PlotWorkshop_Interceptor = async (...args) => {
        try { return await (await boot()).intercept(...args); }
        catch { args[2]?.(true); globalThis.toastr?.error('剧情工坊未能加载，已停止本次生成。请检查扩展文件是否完整。'); }
    };
    boot().catch(() => globalThis.toastr?.error('剧情工坊加载失败，请确认完整安装并查看浏览器控制台中的模块加载错误。'));
}
