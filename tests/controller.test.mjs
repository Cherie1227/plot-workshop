import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlugin } from '../index.js';
import { INJECTION_KEY } from '../lib/host.js';
import { compilePreset } from '../lib/preset.js';

const xml = '<content><plot>接信。</plot><characters><character name="林澄"><emotion>仍有戒备。</emotion><response>接过信。</response></character></characters><segments><segment index="1">林澄看见封口完好，接过信。</segment></segments><end_state>等待回应。</end_state></content>';
const builtin = JSON.parse(fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'));
const builtinV2 = JSON.parse(fs.readFileSync(new URL('../presets/default-v2.json', import.meta.url), 'utf8'));
const turns = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await turns(); }
    throw new Error(`Did not reach ${label}`);
}

async function fixture(t, { settings = {}, saved, fetchMode = 'success', api, detectAnima, observerGate, recallAnima, host = {}, updaterFactory,
    viewState = { open: false, unsaved: false }, reloadPage, rewriteMode = 'success', plannerMessage, dynamicCleanupProof, withoutV2 = false, beforeWriterEnded } = {}) {
    const prior = { document: globalThis.document, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage, SillyTavern: globalThis.SillyTavern };
    const input = { value: '她递出信。', dispatchEvent() {} };
    const storage = new Map();
    const localStorage = new Map();
    const downloads = [], blobs = new Map();
    const priorURL = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    URL.createObjectURL = blob => { const url = `blob:fixture-${blobs.size}`; blobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => blobs.delete(url);
    globalThis.document = {
        querySelector: selector => selector === '#send_textarea' ? input : null,
        createElement: tag => {
            assert.equal(tag, 'a');
            return { href: '', download: '', click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); }, remove() {} };
        }, body: { append() {} },
    };
    globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
    globalThis.localStorage = { getItem: key => localStorage.get(key) ?? null, setItem: (key, value) => localStorage.set(key, String(value)), removeItem: key => localStorage.delete(key) };
    delete globalThis.SillyTavern;
    const handlers = new Map();
    const events = {
        on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
        removeListener(name, fn) { handlers.set(name, (handlers.get(name) || []).filter(f => f !== fn)); },
        async emit(name, ...args) { for (const handler of handlers.get(name) || []) await handler(...args); },
        // Real hosts dispatch events synchronously without awaiting listeners.
        fire(name, ...args) { for (const handler of handlers.get(name) || []) handler(...args); },
    };
    const calls = { planner: [], writer: [], replays: [], saves: 0, recalled: 0, skippedRecalls: 0, invalidated: 0, aborted: 0, detection: [], observers: [], recalls: [], reloads: 0 };
    const ctx = {
        chatId: 'chat-a', characterId: 0, groupId: null, name1: '苏青', name2: '林澄', onlineStatus: 'connected',
        characters: [{ name: '林澄', description: '谨慎而重视约定', data: { description: '谨慎而重视约定', personality: '', scenario: '门口', mes_example: '' } }],
        chat: [{ name: '林澄', is_user: false, mes: '他站在门口。' }],
        chatMetadata: {}, powerUserSettings: { persona_description: '苏青寡言' },
        chatCompletionSettings: { openai_model: 'main-writer', openai_max_context: 32000 },
        extensionSettings: { plot_workshop: saved ?? { settings: { baseUrl: 'https://relay.example/v1', model: 'planner-A', mode: 'review', minWords: '1500', maxWords: '2000', ...settings } } },
        extensionPrompts: {}, eventSource: events,
        eventTypes: Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'].map(x => [x, x])),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced() { calls.saves++; },
        async getWorldInfoPrompt() { return { worldInfoBefore: '', worldInfoAfter: '' }; },
        setExtensionPrompt(key, value, position, depth, scan, role, filter) { this.extensionPrompts[key] = { value, position, depth, scan, role, filter }; },
    };
    Object.assign(ctx, host);
    ctx.getCurrentChatId = () => ctx.chatId;
    const anima = {
        async detectInstalledAnima(options) { calls.detection.push(options); return detectAnima ? detectAnima(options) : { status: 'ready', version: '3.3.6', frontendPath: options.settings.frontendPath, message: '已就绪，尚未召回记忆。' }; },
        async installAnimaObserver(options) { calls.observers.push(options); if (observerGate) await observerGate(options); }, beginAnimaGeneration() { return 'generation-token'; }, clearAnimaGeneration() {},
        async recallAnima(options) { calls.recalled++; calls.recalls.push(options); return recallAnima ? recallAnima(options, calls.recalled) : { text: '之前约定不擅自拆信。', status: 'success', source: 'fixture-memory' }; },
        skipNextAnimaRecall() { calls.skippedRecalls++; return () => {}; }, invalidateAnimaRoundCache() { calls.invalidated++; },
        getAnimaDynamicCleanupProof: () => dynamicCleanupProof ? structuredClone(dynamicCleanupProof) : null,
    };
    const fetchImpl = async (url, options) => {
        calls.planner.push({ url, options, body: JSON.parse(options.body) });
        if (typeof fetchMode === 'function') return fetchMode({ url, options, calls });
        if (fetchMode === 'error') return new Response('server private-key details', { status: 503 });
        if (fetchMode === 'pending') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: plannerMessage ?? { content: xml } }] }));
    };
    const view = { render() {}, open() { viewState.open = true; }, close() { viewState.open = false; }, destroy() {},
        isOpen: () => viewState.open, hasUnsavedChanges: () => viewState.unsaved };
    const makePlugin = () => createPlugin({ getContext: () => ctx, builtin, builtinV2: withoutV2 ? null : builtinV2, writerRules: '按当前大纲扩写中文正文。', anima, viewFactory: () => view, fetchImpl,
        async rewriteReply({ message, targetId, nextSwipe }) {
            assert.equal(targetId, ctx.chat.length - 1);
            message.swipes ??= [message.mes];
            const prior = message.swipe_id ?? 0;
            message.swipe_id = nextSwipe;
            await events.emit('GENERATION_STARTED', 'swipe', {}, false);
            let aborted = false;
            await plugin.intercept(ctx.chat.slice(0, -1), 32000, () => { aborted = true; }, 'swipe');
            const injected = ctx.extensionPrompts[INJECTION_KEY]?.value;
            calls.replays.push({ injected, model: ctx.chatCompletionSettings.openai_model });
            if (rewriteMode === 'repeat') {
                await events.emit('GENERATION_STARTED', 'swipe', {}, false);
                await plugin.intercept(ctx.chat.slice(0, -1), 32000, () => { aborted = true; }, 'swipe');
            }
            if (!aborted && rewriteMode === 'success') {
                message.mes = '他把信接到手中，指尖停在封口。';
                message.swipes[nextSwipe] = message.mes;
            } else message.swipe_id = prior;
            await events.emit('GENERATION_ENDED');
        },
        extensionUrl: 'https://tavern.example/scripts/extensions/third-party/renamed-huapi/', currentVersion: '0.2.0',
        reloadPage() { calls.reloads++; reloadPage?.(); }, ...(api ? { api } : {}), ...(updaterFactory ? { updaterFactory } : {}) });
    let plugin = await makePlugin();
    ctx.generate = async type => {
        let aborted = false;
        await events.emit('GENERATION_STARTED', type, {}, false);
        if (type === 'regenerate') {
            if (ctx.chat.length && !ctx.chat.at(-1).is_user) { ctx.chat.pop(); await events.emit('MESSAGE_DELETED', ctx.chat.length); }
        } else if (input.value) { ctx.chat.push({ name: ctx.name1, is_user: true, mes: input.value }); input.value = ''; }
        await plugin.intercept(ctx.chat, 32000, () => { aborted = true; calls.aborted++; }, type);
        if (!aborted) {
            const prompt = ctx.extensionPrompts[INJECTION_KEY];
            assert.ok(prompt && (!prompt.filter || await prompt.filter()), 'Writer requires the valid this-turn outline');
            calls.writer.push({ prompt: prompt.value, model: ctx.chatCompletionSettings.openai_model, position: prompt.position, depth: prompt.depth, role: prompt.role, scan: prompt.scan });
            ctx.chat.push({ name: ctx.name2, is_user: false, mes: '林澄接过信，暂时没有拆开。' });
            await beforeWriterEnded?.(ctx);
        }
        await events.emit('GENERATION_ENDED');
    };
    t.after(() => {
        plugin.destroy();
        URL.createObjectURL = priorURL.createObjectURL; URL.revokeObjectURL = priorURL.revokeObjectURL;
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    return { ctx, input, get plugin() { return plugin; }, calls, events, storage, localStorage, downloads, viewState,
        async reload() { plugin.destroy(); plugin = await makePlugin(); return plugin; } };
}

function fakeUpdaterFixture() {
    const managers = [];
    const updaterFactory = options => {
        const state = { phase: 'idle', autoCheck: options.preferences?.autoCheck !== false, autoInstall: options.preferences?.autoInstall === true };
        const calls = { starts: 0, checks: 0, installAttempts: 0, installs: 0, destroys: 0 };
        const manager = {
            options, state, calls,
            emit(patch, meta) { Object.assign(state, patch); options.onChange(state, meta); },
            start() { calls.starts++; if (state.autoCheck) this.check(); },
            async check() { calls.checks++; this.emit({ phase: 'available' }); return state; },
            async install({ automatic = false } = {}) {
                calls.installAttempts++;
                if (!options.canInstall(automatic)) return false;
                calls.installs++; this.emit({ phase: 'installed' }); return state;
            },
            setPreferences(patch) {
                for (const key of ['autoCheck', 'autoInstall']) if (typeof patch[key] === 'boolean') state[key] = patch[key];
                options.onChange(state);
            },
            destroy() { calls.destroys++; },
        };
        managers.push(manager); return manager;
    };
    return { updaterFactory, managers, get manager() { return managers.at(-1); } };
}

function hostLibraryFixture() {
    const calls = { names: 0, presets: 0, reads: [] };
    const names = ['已挂载', '补充 A', '补充 B'];
    const books = {
        '已挂载': { entries: { 0: { content: 'MOUNTED_MUST_NOT_BE_READ_AS_EXTRA' } } },
        '补充 A': { entries: { 0: { uid: 0, comment: '额外背景', content: 'ONLY_EXTRA_A {{setvar::x::keep-literal}}', constant: false, key: ['未出现在聊天里的词'] }, 1: { uid: 1, disable: true, content: 'DISABLED_EXTRA_A' } } },
        '补充 B': { entries: { 0: { uid: 0, content: 'ONLY_EXTRA_B' } } },
    };
    const presets = [{ name: '目录原预设', prompts: [{ identifier: 'host-rule', name: '正文输出格式', content: 'ORIGINAL_HOST_PROMPT', role: 'system' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'host-rule', enabled: true }] }], temperature: 0.7 }];
    const manager = {
        getPresetList(api) { assert.equal(api, 'openai'); calls.presets++; return { presets, preset_names: { '目录原预设': 0 } }; },
        selectPreset() { assert.fail('Directory import must not select the main preset'); },
        savePreset() { assert.fail('Directory import must not modify a host preset'); },
    };
    let loader = name => books[name] ?? null;
    const context = {
        mainApi: 'textgenerationwebui',
        worldInfoModule: { selected_world_info: ['已挂载'], world_info: { charLore: [] }, METADATA_KEY: 'world_info' },
        getWorldInfoNames() { calls.names++; return [...names]; },
        getPresetManager(api) { assert.equal(api, 'openai'); return manager; },
        async loadWorldInfo(name) { calls.reads.push(name); return loader(name); },
        async getWorldInfoPrompt() { return { worldInfoBefore: 'NORMAL_MOUNTED_ACTIVATION', worldInfoAfter: '' }; },
        substituteParams() { assert.fail('Extra reference books must not execute host macros'); },
        saveWorldInfo() { assert.fail('Extra reference books must not change host mounting or memories'); },
    };
    return { context, calls, names, books, presets, setLoader(value) { loader = value; } };
}

function reorderPresetFixture() {
    return {
        name: '复制排序测试',
        prompts: [
            ...['a', 'b', 'c', 'x', 'y', 'unlisted'].map(id => ({ identifier: id, name: `条目 ${id}`, content: `ORDER_${id}`, role: 'system', injection_trigger: [] })),
            { identifier: 'charDescription', name: '角色卡', role: 'system', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: ['a', 'x', 'b', 'c', 'y', 'charDescription'].map(id => ({ identifier: id, enabled: id !== 'b' })) }],
        groups: [{ id: 'group-a', name: '甲组', enabled: true }, { id: 'group-b', name: '乙组', enabled: true }],
        promptGroups: { a: 'group-a', b: 'group-a', c: 'group-a', unlisted: 'group-a', x: 'group-b', y: 'group-b', charDescription: 'group-b' },
    };
}

function compiledPromptOrder(preset) {
    return compilePreset(preset, { context: { currentInput: '本轮输入', animaStatus: 'empty', animaMemory: '', charDescription: '角色资料' } })
        .messages.filter(message => message.content.startsWith('ORDER_')).map(message => message.content);
}

test('range grouping uses actual request order across groups without changing prompt content or compiled order', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    const preset = f.plugin.state.preset, order = structuredClone(preset.order), prompts = structuredClone(preset.prompts);
    const compiled = compiledPromptOrder(preset);
    const result = await f.plugin.onAction('createPromptGroup', { presetId: f.plugin.state.activePresetId, startId: 'a', endId: 'c', name: ' 人物与回应 ' });
    assert.equal(result.count, 4, 'The interleaved x belongs in the actual a..c range');
    assert.equal(preset.groups.find(group => group.id === result.id).name, '人物与回应');
    for (const id of ['a', 'x', 'b', 'c']) assert.equal(preset.promptGroups[id], result.id);
    assert.equal(preset.promptGroups.y, 'group-b');
    assert.deepEqual(preset.order, order); assert.deepEqual(preset.prompts, prompts);
    assert.deepEqual(compiledPromptOrder(preset), compiled);
    await f.plugin.onAction('groupToggle', { id: result.id, enabled: false });
    assert.deepEqual(compiledPromptOrder(preset), ['ORDER_y']);
    await f.plugin.onAction('groupToggle', { id: result.id, enabled: true });
    assert.deepEqual(compiledPromptOrder(preset), compiled);
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0);
});

test('reverse, single-entry and unlisted grouping preserve effective disabled state', async t => {
    const source = reorderPresetFixture(); source.groups[1].enabled = false;
    const f = await fixture(t, { saved: { preset: source } });
    const preset = f.plugin.state.preset, compiled = compiledPromptOrder(preset), orderIds = preset.order.map(entry => entry.identifier);
    const result = await f.plugin.onAction('createPromptGroup', { presetId: f.plugin.state.activePresetId, startId: 'c', endId: 'a', name: '反向范围' });
    assert.equal(result.count, 4);
    assert.equal(preset.order.find(entry => entry.identifier === 'x').enabled, false);
    assert.equal(preset.order.find(entry => entry.identifier === 'b').enabled, false);
    assert.equal(preset.order.find(entry => entry.identifier === 'a').enabled, true);
    assert.deepEqual(compiledPromptOrder(preset), compiled);
    const tail = await f.plugin.onAction('createPromptGroup', { presetId: f.plugin.state.activePresetId, startId: 'charDescription', endId: 'unlisted', name: '资料' });
    assert.equal(tail.count, 2); assert.equal(preset.promptGroups.unlisted, tail.id);
    assert.equal(preset.order.find(entry => entry.identifier === 'charDescription').enabled, false);
    assert.deepEqual(preset.order.map(entry => entry.identifier), orderIds);
    const single = await f.plugin.onAction('createPromptGroup', { presetId: f.plugin.state.activePresetId, startId: 'unlisted', endId: 'unlisted', name: '单条' });
    assert.equal(single.count, 1); assert.equal(preset.promptGroups.unlisted, single.id);
    assert.ok(!preset.order.some(entry => entry.identifier === 'unlisted'));
    assert.deepEqual(compiledPromptOrder(preset), compiled);
});

test('group rename and range membership survive autosave, reload and export import', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    const { id } = await f.plugin.onAction('createPromptGroup', { presetId: f.plugin.state.activePresetId, startId: 'x', endId: 'y', name: '新组' });
    await f.plugin.onAction('renamePromptGroup', { id, name: '剧情回应' });
    const before = structuredClone(f.plugin.state.preset), compiled = compiledPromptOrder(before);
    await f.plugin.onAction('exportPreset');
    const exported = await f.downloads[0].blob.text();
    await f.reload();
    assert.deepEqual(f.plugin.state.preset.groups, before.groups);
    assert.deepEqual({ ...f.plugin.state.preset.promptGroups }, before.promptGroups);
    assert.deepEqual(f.plugin.state.preset.order, before.order);
    await f.plugin.onAction('importPreset', { text: exported });
    assert.deepEqual(f.plugin.state.preset.groups, before.groups);
    assert.deepEqual({ ...f.plugin.state.preset.promptGroups }, before.promptGroups);
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), compiled);
});

test('dissolving a disabled group keeps entries and their effective off state, including a later delete undo', async t => {
    const source = reorderPresetFixture(); source.groups[1].enabled = false;
    const f = await fixture(t, { saved: { preset: source } });
    const preset = f.plugin.state.preset;
    const compiled = compiledPromptOrder(preset);
    await f.plugin.onAction('deletePrompt', { id: 'y' });
    const names = preset.prompts.map(prompt => prompt.identifier), orderIds = preset.order.map(entry => entry.identifier);
    const result = await f.plugin.onAction('dissolvePromptGroup', { id: 'group-b' });
    assert.equal(result.count, 2);
    assert.ok(!preset.groups.some(group => group.id === 'group-b'));
    assert.equal(preset.promptGroups.x, undefined);
    assert.deepEqual(preset.prompts.map(prompt => prompt.identifier), names);
    assert.deepEqual(preset.order.map(entry => entry.identifier), orderIds);
    assert.deepEqual(compiledPromptOrder(preset), compiled);
    await f.plugin.onAction('undoDeletePrompt');
    assert.equal(preset.promptGroups.y, undefined);
    assert.deepEqual(compiledPromptOrder(preset), compiled, 'Undo must not activate a member of the dissolved disabled group');
});

test('invalid or stale range/group requests do not mutate saved presets', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    const request = { presetId: f.plugin.state.activePresetId, startId: 'a', endId: 'c', name: '有效名称' };
    for (const [action, payload] of [
        ['createPromptGroup', { ...request, name: '  ' }], ['createPromptGroup', { ...request, startId: 'missing' }],
        ['createPromptGroup', { ...request, presetId: 'other-preset' }], ['createPromptGroup', { ...request, endId: null }],
        ['renamePromptGroup', { id: 'group-a', name: '' }], ['renamePromptGroup', { id: 'missing', name: '名字' }],
        ['dissolvePromptGroup', { id: 'missing' }], ['dissolvePromptGroup', { id: '' }],
    ]) {
        const before = JSON.stringify(f.plugin.state.preset), saved = JSON.stringify(f.ctx.extensionSettings), saves = f.calls.saves;
        assert.equal(await f.plugin.onAction(action, payload), false);
        assert.equal(JSON.stringify(f.plugin.state.preset), before); assert.equal(JSON.stringify(f.ctx.extensionSettings), saved);
        assert.equal(f.calls.saves, saves);
    }
});

test('group mutations cannot run while the planner is in flight', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture(), settings: { baseUrl: 'https://relay.example/v1', model: 'planner-A', mode: 'review' } }, fetchMode: 'pending' });
    const planning = f.plugin.onAction('generate', { input: f.input.value });
    await until(() => f.calls.planner.length === 1, 'planner request');
    const before = JSON.stringify(f.plugin.state.preset);
    for (const [type, payload] of [
        ['createPromptGroup', { presetId: f.plugin.state.activePresetId, startId: 'a', endId: 'c', name: '新组' }],
        ['renamePromptGroup', { id: 'group-a', name: '改名' }], ['dissolvePromptGroup', { id: 'group-a' }],
    ]) assert.equal(await f.plugin.onAction(type, payload), false);
    assert.equal(JSON.stringify(f.plugin.state.preset), before);
    await f.plugin.onAction('cancel'); await planning;
});

test('master switch defaults on, saves immediately, and preserves configuration through reload and re-enable', async t => {
    const f = await fixture(t, { settings: { autoOnSend: true, mode: 'auto' } });
    assert.equal(f.plugin.state.settings.enabled, true);
    const { id } = await f.plugin.onAction('presetSaveAs', { name: '保留的规划预设' });
    await f.plugin.onAction('editPrompt', { id: 'outline_dialogue', content: '保持角色自己的说话方式。' });
    const preset = structuredClone(f.plugin.state.preset), saves = f.calls.saves;
    assert.equal(await f.plugin.onAction('setEnabled', { value: false }), true);
    assert.equal(f.plugin.state.settings.enabled, false);
    assert.equal(f.ctx.extensionSettings.plot_workshop.settings.enabled, false);
    assert.ok(f.calls.saves > saves, 'Switching must save without a separate settings save');
    await f.reload();
    assert.equal(f.plugin.state.settings.enabled, false);
    assert.equal(f.plugin.state.settings.autoOnSend, true);
    assert.equal(f.plugin.state.settings.mode, 'auto');
    assert.equal(f.plugin.state.activePresetId, id);
    assert.deepEqual(structuredClone(f.plugin.state.preset), preset);
    assert.equal(await f.plugin.onAction('setEnabled', { value: true }), true);
    assert.equal(f.ctx.extensionSettings.plot_workshop.settings.enabled, true);
    await f.ctx.generate('normal');
    assert.equal(f.calls.recalled, 1);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.calls.writer.length, 1);
    assert.equal(f.calls.aborted, 0);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('disabled master switch blocks every planning and writing entry point without recalling or requesting models', async t => {
    let diagnoses = 0;
    const f = await fixture(t, { settings: { enabled: false, autoOnSend: true, mode: 'auto' }, api: {
        async requestDiagnosis() { diagnoses++; return { summary: '诊断', options: [] }; },
    } });
    const chat = structuredClone(f.ctx.chat), input = f.input.value;
    for (const action of ['generate', 'rerollPlan', 'confirmAndWrite', 'rerollWriter', 'inspectPrompts', 'diagnose']) {
        assert.equal(await f.plugin.onAction(action, { input }), false, action);
    }
    assert.equal(f.plugin.canRewrite(), false);
    assert.equal(f.calls.observers.length, 0);
    assert.equal(f.calls.recalled, 0);
    assert.equal(f.calls.planner.length, 0);
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.calls.replays.length, 0);
    assert.equal(diagnoses, 0);
    assert.deepEqual(f.ctx.chat, chat);
    assert.equal(f.input.value, input);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('disabled master switch leaves all native generation types untouched and installs no Anima observer', async t => {
    const f = await fixture(t, { settings: { enabled: false, autoOnSend: true, mode: 'auto' } });
    const chat = structuredClone(f.ctx.chat), aborts = [];
    for (const type of ['normal', 'swipe', 'regenerate', 'continue', 'quiet', 'impersonate', undefined]) {
        await f.events.emit('GENERATION_STARTED', type, {}, false);
        await f.plugin.intercept(f.ctx.chat, 32000, value => aborts.push({ type, value }), type);
        assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined, String(type));
        await f.events.emit('GENERATION_ENDED');
    }
    assert.deepEqual(aborts, []);
    assert.equal(f.calls.observers.length, 0);
    assert.equal(f.calls.recalled, 0);
    assert.equal(f.calls.planner.length, 0);
    assert.equal(f.calls.writer.length, 0);
    assert.deepEqual(f.ctx.chat, chat);
});

test('disabling after a completed expansion also disables a previously valid fixed-outline rewrite', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.plugin.canRewrite(), true);
    const recalls = f.calls.recalled, observers = f.calls.observers.length, chat = structuredClone(f.ctx.chat);
    assert.equal(await f.plugin.onAction('setEnabled', { value: false }), true);
    assert.equal(f.plugin.canRewrite(), false);
    assert.equal(await f.plugin.onAction('rerollWriter'), false);
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.recalled, recalls);
    assert.equal(f.calls.observers.length, observers);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.calls.writer.length, 1);
    assert.equal(f.calls.replays.length, 0);
    assert.deepEqual(f.ctx.chat, chat);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('master switch refuses to change during an active planner request', async t => {
    const f = await fixture(t, { fetchMode: 'pending' });
    const planning = f.plugin.onAction('generate', { input: f.input.value });
    await until(() => f.calls.planner.length === 1, 'pending planner request');
    const saves = f.calls.saves;
    try {
        assert.equal(await f.plugin.onAction('setEnabled', { value: false }), false);
        assert.equal(f.plugin.state.settings.enabled, true);
        assert.equal(f.calls.saves, saves);
        assert.equal(f.plugin.state.busy, true);
    } finally { await f.plugin.onAction('cancel'); await planning; }
    assert.equal(await f.plugin.onAction('setEnabled', { value: false }), true);
    assert.equal(f.plugin.state.settings.enabled, false);
});

test('master switch refuses both directions during native generation and becomes available when it ends', async t => {
    for (const enabled of [true, false]) {
        await t.test(enabled ? 'turning off' : 'turning on', async t => {
            const f = await fixture(t, { settings: { enabled, autoOnSend: false } });
            await f.events.emit('GENERATION_STARTED', 'normal', {}, false);
            const saves = f.calls.saves;
            assert.equal(await f.plugin.onAction('setEnabled', { value: !enabled }), false);
            assert.equal(f.plugin.state.settings.enabled, enabled);
            assert.equal(f.calls.saves, saves);
            assert.equal(f.calls.observers.length, 0);
            await f.events.emit('GENERATION_ENDED');
            assert.equal(await f.plugin.onAction('setEnabled', { value: !enabled }), true);
            assert.equal(f.plugin.state.settings.enabled, !enabled);
        });
    }
});

test('native regenerate replans the prior input without consuming composer draft or another Echo recall', async t => {
    const f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'refresh' } });
    await f.ctx.generate('normal');
    f.input.value = '下一轮还没发送的草稿';
    const oldXml = f.plugin.state.plan.xml;
    await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.writer.length, 2); assert.equal(f.calls.recalled, 1);
    assert.equal(f.input.value, '下一轮还没发送的草稿'); assert.equal(f.ctx.chat.length, 3);
    assert.equal(f.plugin.state.input, '她递出信。');
    const body = JSON.stringify(f.calls.planner[1].body);
    assert.match(body, /她递出信/); assert.doesNotMatch(body, /下一轮还没发送的草稿|林澄接过信，暂时没有拆开/);
    assert.ok(f.calls.writer[1].prompt.includes(oldXml));
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.ok(f.plugin.state.logs.some(e => e.event === 'anima.recall.completed' && e.details.reused));
});

test('native regenerate reuse policy uses this turn outline and plans when there is none', async t => {
    for (const hasPlan of [true, false]) await t.test(String(hasPlan), async subtest => {
        const f = await fixture(subtest, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' } });
        if (hasPlan) await f.ctx.generate('normal');
        else f.ctx.chat.push({ is_user: true, mes: '她递出信。' }, { is_user: false, mes: '未经过插件的旧回复' });
        f.input.value = '保留草稿'; const before = f.calls.planner.length, recalls = f.calls.recalled;
        await f.ctx.generate('regenerate');
        assert.equal(f.calls.planner.length, before + (hasPlan ? 0 : 1));
        assert.equal(f.calls.recalled, recalls + (hasPlan ? 0 : 1));
        assert.equal(f.input.value, '保留草稿'); assert.equal(f.plugin.state.input, '她递出信。');
        assert.equal(f.ctx.chat.length, 3); assert.equal(f.calls.writer.length, hasPlan ? 2 : 1);
        assert.equal(f.plugin.state.logs.filter(entry => entry.event === 'planner.reuse.skipped').length, hasPlan ? 0 : 1);
        if (!hasPlan) assert.equal(f.plugin.state.logs.find(entry => entry.event === 'planner.reuse.skipped').details.code, 'REUSE_NO_CACHE');
        if (!hasPlan) { assert.equal(f.calls.recalls[0].generationToken, undefined); assert.equal(f.calls.recalls[0].settings.inputAlreadyInChat, true); }
    });
});

test('native regenerate reuses an outline after display-only preset changes', async t => {
    const changes = {
        'group name': f => f.plugin.onAction('renamePromptGroup', { id: 'outline_voice', name: '显示用分组名称' }),
        'prompt name': f => f.plugin.onAction('editPrompt', { id: 'outline_dialogue', name: '显示用条目名称' }),
        'preset name': f => f.plugin.onAction('presetSave', { name: '显示用预设名称' }),
        'display metadata': f => {
            f.plugin.state.preset.warnings.push('仅显示的提示');
            f.plugin.state.preset.importAdvice = { disable: [], review: [{ id: 'outline_dialogue', reason: '仅显示的导入建议' }] };
            f.plugin.state.preset.groups[0].collapsed = !f.plugin.state.preset.groups[0].collapsed;
            f.plugin.state.preset.groups[0].order += 10;
        },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async subtest => {
        const f = await fixture(subtest, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' } });
        await f.ctx.generate('normal');
        const priorXml = f.plugin.state.plan.xml;
        await change(f); await f.ctx.generate('regenerate');
        assert.equal(f.calls.planner.length, 1); assert.equal(f.calls.recalled, 1); assert.equal(f.calls.writer.length, 2);
        assert.ok(f.calls.writer[1].prompt.includes(priorXml));
        assert.ok(f.plugin.state.logs.some(entry => entry.event === 'planner.reused'));
        assert.equal(f.plugin.state.logs.some(entry => entry.event === 'planner.reuse.skipped'), false);
    });
});

test('native regenerate still replans after prompt, switch, pace or request settings change', async t => {
    const changes = {
        content: f => f.plugin.onAction('editPrompt', { id: 'outline_dialogue', content: '对白须简短并回应上一句。' }),
        role: f => f.plugin.onAction('editPrompt', { id: 'outline_dialogue', role: 'user' }),
        'prompt switch': f => f.plugin.onAction('promptToggle', { identifier: 'outline_dialogue', enabled: false }),
        'group switch': f => f.plugin.onAction('groupToggle', { id: 'outline_voice', enabled: false }),
        'group mapping': f => f.plugin.onAction('editPrompt', { id: 'outline_dialogue', groupId: 'outline_character' }),
        'prompt order': f => {
            const items = f.plugin.state.preset.order.filter(item => f.plugin.state.preset.promptGroups[item.identifier] === 'outline_voice');
            return f.plugin.onAction('movePrompt', { id: items.at(-1).identifier, beforeId: items[0].identifier, groupId: 'outline_voice' });
        },
        'output limit': f => f.plugin.onAction('settings', { maxTokens: '60000' }),
        stream: f => f.plugin.onAction('settings', { stream: false }),
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async subtest => {
        const f = await fixture(subtest, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' } });
        await f.ctx.generate('normal'); await change(f); await f.ctx.generate('regenerate');
        assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.recalled, 1); assert.equal(f.calls.writer.length, 2);
        assert.equal(f.plugin.state.logs.find(entry => entry.event === 'planner.reuse.skipped')?.details.code, 'REUSE_CONFIG_CHANGED');
    });
});

test('a failed native regeneration fallback identifies the previous visible outline and its reason', async t => {
    let statusDuringRequest = '', f;
    f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' }, fetchMode: ({ calls }) => {
        if (calls.planner.length === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: xml } }] }));
        statusDuringRequest = f.plugin.state.status;
        return new Response('private relay details', { status: 400 });
    } });
    await f.ctx.generate('normal');
    const priorXml = f.plugin.state.plan.xml;
    await f.reload(); await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.writer.length, 1);
    assert.equal(f.plugin.state.plan.xml, priorXml);
    assert.match(statusDuringRequest, /当前页面没有有效的本轮大纲与记忆缓存.*重新生成大纲/);
    assert.match(f.plugin.state.status, /HTTP 400/);
    assert.match(f.plugin.state.status, /上次成功的大纲.*仅供查看.*本次未复用/);
    assert.doesNotMatch(f.plugin.state.status, /private relay details/);
    assert.equal(f.plugin.state.logs.find(entry => entry.event === 'planner.reuse.skipped')?.details.code, 'REUSE_NO_CACHE');
    assert.equal(f.plugin.state.logs.some(entry => entry.event === 'planner.reused'), false);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('changed planning content requires a new outline but can reuse unchanged turn memory', async t => {
    const f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' } });
    await f.ctx.generate('normal');
    await f.plugin.onAction('settings', { minWords: '1800', maxWords: '2200' });
    f.input.value = '草稿'; await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.recalled, 1);
    assert.match(f.calls.writer[1].prompt, /1800—2200/); assert.equal(f.input.value, '草稿');
});

test('changed worldbook requires new memory and a new outline for native regenerate', async t => {
    const f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' } });
    await f.ctx.generate('normal'); await f.events.emit('WORLDINFO_UPDATED', 'book');
    await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.recalled, 2);
    assert.equal(f.calls.recalls[1].generationToken, undefined);
    assert.equal(f.plugin.state.logs.find(entry => entry.event === 'planner.reuse.skipped')?.details.code, 'REUSE_WORLDBOOK_CHANGED');
});

test('verified Anima post-generation container cleanup preserves native regeneration reuse', async t => {
    const names = ['[ANIMA_Chat_History_Container]', '[ANIMA_Knowledge_Container]'];
    const proof = { chatId: 'chat-a', bookName: 'bound-book', entries: names.map((name, index) => ({ uid: index + 1, name, content: `verified-memory-${index}` })) };
    const book = { entries: Object.fromEntries(proof.entries.map(entry => [String(entry.uid), { uid: entry.uid, comment: entry.name, content: entry.content,
        disable: false, key: [], constant: true, order: 100, position: 4, extensions: { depth: 4 } }])), originalData: { preserved: true } };
    book.entries['3'] = { uid: 3, comment: '永久规则', content: '不可改动的世界规则', disable: false };
    let f;
    f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' }, dynamicCleanupProof: proof,
        recallAnima: async () => { await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book)); return { text: '本轮记忆', status: 'success', source: 'fixture' }; } });
    await f.ctx.generate('normal');
    // Anima runs these callbacks after GENERATION_ENDED, outside recall/injection.
    for (const uid of ['1', '2']) { book.entries[uid].content = ''; await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book)); }
    assert.equal(f.calls.invalidated, 2, 'Only the initial book event and normal generation end invalidate Anima round cache');
    await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 1); assert.equal(f.calls.recalled, 1); assert.equal(f.calls.writer.length, 2);
    assert.match(f.calls.writer[1].prompt, /本轮记忆/);
    assert.equal(f.calls.writer[1].prompt, f.calls.writer[0].prompt, 'Frozen memory remains in the writer injection after worldbook cleanup');
    assert.equal(f.plugin.state.logs.filter(entry => entry.event === 'anima.containers.cleaned').length, 2);
    assert.equal(f.plugin.state.logs.some(entry => entry.event === 'planner.reuse.skipped'), false);
    assert.doesNotMatch(JSON.stringify(f.plugin.state.logs), /verified-memory|不可改动的世界规则/);
    // A same-round replan can reuse recalled memory after cleanup too.
    await f.plugin.onAction('settings', { minWords: '1600' }); await f.ctx.generate('regenerate');
    await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
    await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.recalled, 1); assert.equal(f.calls.writer.length, 4);
});

test('official raw cache read arms cleanup before debounced WORLDINFO_UPDATED arrives', async t => {
    for (const timing of ['during planner', 'after generation', 'combined cleanup']) await t.test(timing, async subtest => {
        const proof = { chatId: 'chat-a', bookName: 'bound-book', entries: [
            { uid: 1, name: '[ANIMA_Chat_History_Container]', content: 'verified-chat' },
            { uid: 2, name: '[ANIMA_Knowledge_Container]', content: 'verified-knowledge' },
        ] };
        const book = { entries: Object.fromEntries(proof.entries.map(entry => [entry.uid, { uid: entry.uid, comment: entry.name, content: entry.content,
            key: entry.uid === 2 ? ['rag_knowledge'] : [], disable: false, order: 100 }])), originalData: { unchanged: true } };
        let reads = 0, f;
        f = await fixture(subtest, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' }, dynamicCleanupProof: proof,
            host: { async loadWorldInfo(name) { assert.equal(name, 'bound-book'); reads++; return structuredClone(book); } },
            recallAnima: async () => ({ text: '本轮已读取的完整记忆', status: 'success', source: 'fixture' }),
            fetchMode: async () => {
                if (timing === 'during planner') await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
                return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: xml } }] }));
            } });
        await f.ctx.generate('normal');
        assert.equal(f.calls.writer.length, 1, 'Delayed initial save cannot interrupt the first plan');
        if (timing === 'after generation') await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
        // Two helper updates can be flushed separately or coalesced by ST.
        book.entries[1].content = '';
        if (timing !== 'combined cleanup') await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
        book.entries[2].content = '';
        await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
        await f.ctx.generate('regenerate');
        assert.equal(reads, 1); assert.equal(f.calls.planner.length, 1); assert.equal(f.calls.recalled, 1); assert.equal(f.calls.writer.length, 2);
        assert.equal(f.calls.writer[1].prompt, f.calls.writer[0].prompt);
        assert.equal(f.plugin.state.logs.some(entry => entry.event === 'planner.reuse.skipped'), false);
    });
});

test('cancellation while loading a raw cleanup baseline cannot resume planning', async t => {
    const proof = { chatId: 'chat-a', bookName: 'bound-book', entries: [{ uid: 1, name: '[ANIMA_Chat_History_Container]', content: 'verified' }] };
    let resolveRead;
    const f = await fixture(t, { dynamicCleanupProof: proof,
        host: { loadWorldInfo: () => new Promise(resolve => { resolveRead = resolve; }) } });
    const pending = f.plugin.onAction('generate', { input: f.input.value });
    await until(() => resolveRead, 'raw cache read');
    await f.plugin.onAction('cancel');
    resolveRead({ entries: { 1: { uid: 1, comment: proof.entries[0].name, content: 'verified' } } });
    await pending;
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.writer.length, 0); assert.equal(f.plugin.state.busy, false);
});

test('empty and no-source recall accept identical delayed saves but still invalidate changed data', async t => {
    for (const retrievalSkipped of [null, 'no_sources']) await t.test(retrievalSkipped || 'genuine empty', async subtest => {
        const proof = { chatId: 'chat-a', bookName: 'bound-book', entries: [] };
        const book = { entries: {
            1: { uid: 1, comment: '[ANIMA_Chat_History_Container]', content: '', disable: false },
            2: { uid: 2, comment: '永久规则', content: '原规则' },
        } };
        let f;
        f = await fixture(subtest, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' }, dynamicCleanupProof: proof,
            host: { loadWorldInfo: async () => structuredClone(book) },
            recallAnima: async () => ({ text: '', status: 'empty', source: 'fixture', retrievalSkipped }),
            fetchMode: async () => {
                await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
                return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: xml } }] }));
            } });
        await f.ctx.generate('normal'); await f.ctx.generate('regenerate');
        assert.equal(f.calls.planner.length, 1); assert.equal(f.calls.recalled, 1); assert.equal(f.calls.writer.length, 2);
        book.entries[2].content = '新规则';
        await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book));
        await f.ctx.generate('regenerate');
        assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.recalled, 2); assert.equal(f.calls.writer.length, 3);
        assert.equal(f.plugin.state.logs.find(entry => entry.event === 'planner.reuse.skipped')?.details.code, 'REUSE_WORLDBOOK_CHANGED');
    });
});

test('worldbook changes outside proven Anima content cleanup still invalidate regeneration reuse', async t => {
    const variants = ['ordinary rule', 'new rule', 'permanent summary', 'status entry', 'book metadata', 'container settings', 'nonempty replacement', 'same-name fake entry', 'no payload', 'worldbook settings', 'changed user input'];
    for (const variant of variants) await t.test(variant, async subtest => {
        const name = '[ANIMA_Chat_History_Container]';
        const proof = { chatId: 'chat-a', bookName: 'bound-book', entries: [{ uid: 1, name, content: 'verified-memory' }] };
        const book = { entries: {
            1: { uid: 1, comment: name, content: 'verified-memory', disable: false, order: 100 },
            2: { uid: 2, comment: '永久规则', content: '原规则' },
            3: { uid: 3, comment: '永久摘要', content: '原摘要', extensions: { createdBy: 'anima_summary' } },
            4: { uid: 4, comment: '[anima_status]', content: '原状态' },
            5: { uid: 5, comment: name, content: '同名但未经证明的内容' },
        }, originalData: { preserved: true } };
        let f;
        f = await fixture(subtest, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' }, dynamicCleanupProof: proof,
            recallAnima: async () => { await f.events.emit('WORLDINFO_UPDATED', 'bound-book', structuredClone(book)); return { text: '本轮记忆', status: 'success', source: 'fixture' }; } });
        await f.ctx.generate('normal');
        const changed = structuredClone(book);
        changed.entries[1].content = '';
        if (variant === 'ordinary rule') changed.entries[2].content = '新规则';
        if (variant === 'new rule') changed.entries[6] = { uid: 6, comment: '新增规则', content: '新资料' };
        if (variant === 'permanent summary') changed.entries[3].content = '新摘要';
        if (variant === 'status entry') changed.entries[4].content = '新状态';
        if (variant === 'book metadata') changed.originalData.preserved = false;
        if (variant === 'container settings') changed.entries[1].order = 200;
        if (variant === 'nonempty replacement') changed.entries[1].content = '另一段非空内容';
        if (variant === 'same-name fake entry') { changed.entries[1].content = 'verified-memory'; changed.entries[5].content = ''; }
        if (variant === 'changed user input') f.ctx.chat.at(-2).mes = '已修改的本轮输入';
        else if (variant === 'worldbook settings') await f.events.emit('WORLDINFO_SETTINGS_UPDATED');
        else await f.events.emit('WORLDINFO_UPDATED', 'bound-book', variant === 'no payload' ? undefined : changed);
        await f.ctx.generate('regenerate');
        assert.equal(f.calls.planner.length, 2); assert.equal(f.calls.recalled, 2); assert.equal(f.calls.writer.length, 2);
        assert.equal(f.plugin.state.logs.find(entry => entry.event === 'planner.reuse.skipped')?.details.code,
            variant === 'changed user input' ? 'REUSE_CONTEXT_CHANGED' : 'REUSE_WORLDBOOK_CHANGED');
        assert.equal(f.plugin.state.logs.some(entry => entry.event === 'anima.containers.cleaned'), false);
    });
});

test('native regenerate obeys review mode even when reusing an outline', async t => {
    const f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' } });
    await f.ctx.generate('normal'); await f.plugin.onAction('settings', { mode: 'review' });
    f.input.value = '不要发送的草稿'; const pending = f.ctx.generate('regenerate');
    await until(() => f.plugin.state.awaitingReview, 'regeneration review');
    assert.equal(f.calls.planner.length, 1); assert.equal(f.calls.writer.length, 1);
    await f.plugin.onAction('confirmAndWrite'); await pending;
    assert.equal(f.calls.writer.length, 2); assert.equal(f.input.value, '不要发送的草稿');
});

test('native regenerate manual mode stops at an outline and later confirmation preserves composer draft', async t => {
    const f = await fixture(t, { settings: { mode: 'manual', autoOnSend: true } });
    f.ctx.chat.push({ is_user: true, mes: '她递出信。' }, { is_user: false, mes: '旧正文' });
    f.input.value = '下一轮草稿'; await f.ctx.generate('regenerate');
    assert.equal(f.calls.planner.length, 1); assert.equal(f.calls.writer.length, 0); assert.equal(f.ctx.chat.length, 2);
    assert.equal(f.input.value, '下一轮草稿');
    await f.plugin.onAction('settings', { mode: 'review', regeneratePolicy: 'reuse' });
    const pending = f.ctx.generate('regenerate'); await until(() => f.plugin.state.awaitingReview, 'review existing manual outline');
    await f.plugin.onAction('cancel'); await pending;
    assert.equal(f.calls.writer.length, 0); assert.equal(f.input.value, '下一轮草稿');
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1); assert.equal(f.input.value, '下一轮草稿'); assert.equal(f.ctx.chat.length, 3);
});

test('rerolling a cancelled native-regeneration outline preserves its submitted input and composer draft after configuration changes', async t => {
    const f = await fixture(t, { settings: { mode: 'review', autoOnSend: true } });
    f.ctx.chat.push({ is_user: true, mes: '她递出信。' }, { is_user: false, mes: '旧正文' });
    f.input.value = '下一轮尚未发送的草稿';
    const pending = f.ctx.generate('regenerate');
    await until(() => f.plugin.state.awaitingReview, 'regeneration review before reroll');
    await f.plugin.onAction('cancel'); await pending;
    await f.plugin.onAction('settings', { mode: 'auto', minWords: '1800', maxWords: '2200' });
    await f.plugin.onAction('rerollPlan', { input: f.plugin.state.input });
    assert.equal(f.calls.planner.length, 2);
    assert.equal(f.calls.recalled, 1, 'Replanning the same turn must not advance Echo again');
    assert.equal(f.calls.writer.length, 1);
    assert.match(f.calls.writer[0].prompt, /1800—2200/);
    assert.equal(f.input.value, '下一轮尚未发送的草稿');
    assert.equal(f.ctx.chat.filter(message => message.is_user).length, 1);
    assert.deepEqual(f.ctx.chat.map(message => message.mes), ['他站在门口。', '她递出信。', '林澄接过信，暂时没有拆开。']);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('native regenerate failure leaves no injection or draft changes and follows host reply removal', async t => {
    const f = await fixture(t, { settings: { mode: 'auto', autoOnSend: true }, fetchMode: 'error' });
    f.ctx.chat.push({ is_user: true, mes: '原用户输入' }, { is_user: false, mes: '将被酒馆移除的原回复' });
    f.input.value = '未发送草稿'; await f.ctx.generate('regenerate');
    assert.equal(f.calls.writer.length, 0); assert.equal(f.calls.aborted, 1); assert.equal(f.input.value, '未发送草稿');
    assert.equal(f.ctx.chat.at(-1).mes, '原用户输入'); assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('manual planning then confirmation writes only final prose and clears this-turn injection', async t => {
    const { ctx, plugin, calls, input } = await fixture(t);
    await plugin.onAction('apiKey', { value: 'private-key' });
    await plugin.onAction('generate', { input: input.value });
    assert.ok(plugin.state.plan);
    assert.equal(calls.writer.length, 0);
    assert.equal(ctx.chat.length, 1);
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 1);
    assert.equal(ctx.chat.length, 3);
    assert.equal(ctx.chat[1].mes, '她递出信。');
    assert.equal(ctx.chat[2].mes, '林澄接过信，暂时没有拆开。');
    assert.ok(ctx.chat.every(m => !m.mes.includes('<content>')));
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(plugin.state.busy, false);
    assert.equal(calls.invalidated, 1);
});

test('manual planning without Anima recall sources still uses current story material and can write prose', async t => {
    const f = await fixture(t, {
        recallAnima: async () => ({ text: '', memoryParts: [], status: 'empty', retrievalSkipped: 'no_sources', source: 'fixture' }),
    });
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.ok(f.plugin.state.plan);
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.calls.recalled, 1);
    const messages = f.calls.planner[0].body.messages;
    const requestText = messages.map(message => message.content).join('\n');
    for (const text of ['她递出信。', '谨慎而重视约定', '他站在门口。']) assert.ok(requestText.includes(text));
    const inspection = f.plugin.state.promptInspection;
    const memoryEntry = inspection.entries.find(entry => entry.id === 'anima_memory');
    assert.deepEqual(memoryEntry.messages, []);
    assert.equal(memoryEntry.tokens, 0);
    const memorySource = inspection.sources.find(source => source.name === 'Anima');
    assert.match(memorySource.status, /已读取.*暂无.*来源/);
    assert.match(memorySource.detail, /摘要/);
    assert.match(memorySource.detail, /状态/);
    assert.match(f.plugin.state.animaStatus, /尚无.*记忆.*继续规划/);
    const completed = f.plugin.state.logs.find(entry => entry.event === 'anima.recall.completed');
    assert.equal(completed.details.retrievalSkipped, 'no_sources');
    assert.equal(completed.details.status, 'empty');
    assert.doesNotMatch(requestText, /no_sources|尚无可召回记忆|暂无召回来源|本轮读取成功，没有相关结果/);
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    assert.ok(f.calls.writer[0].prompt.includes(f.plugin.state.plan.xml));
    assert.doesNotMatch(f.calls.writer[0].prompt, /no_sources|尚无可召回记忆|暂无召回来源|本轮读取成功，没有相关结果/);
    assert.deepEqual(f.ctx.chat.map(message => message.mes), ['他站在门口。', '她递出信。', '林澄接过信，暂时没有拆开。']);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('writer reroll uses the frozen outline and memory, preserves prose candidates and input draft', async t => {
    const f = await fixture(t);
    assert.equal(f.plugin.canRewrite(), false);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.plugin.canRewrite(), true);
    const originalReply = f.ctx.chat.at(-1).mes, originalPrompt = f.calls.writer[0].prompt;
    const recalls = f.calls.recalled;
    f.input.value = '尚未发送的下一轮草稿';
    await f.plugin.onAction('applyPlanEdit', { xml: xml.replace('接信。', '另一个计划。') });
    f.ctx.chatCompletionSettings.openai_model = 'writer-second';
    assert.equal(await f.plugin.onAction('rerollWriter'), true);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.calls.recalled, recalls);
    assert.equal(f.calls.replays[0].injected, originalPrompt);
    assert.equal(f.calls.replays[0].model, 'writer-second');
    assert.equal(f.ctx.chat.length, 3);
    assert.equal(f.ctx.chat.at(-1).swipes[0], originalReply);
    assert.equal(f.ctx.chat.at(-1).swipes.length, 2);
    assert.equal(f.input.value, '尚未发送的下一轮草稿');
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(f.plugin.canRewrite(), true);
});

test('writer reroll rejects changed history, stale pages and ungenerated outlines', async t => {
    const f = await fixture(t);
    assert.equal(await f.plugin.onAction('rerollWriter'), false);
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(await f.plugin.onAction('rerollWriter'), false);
    await f.plugin.onAction('confirmAndWrite');
    f.ctx.chat[0].mes = '已编辑前文';
    assert.equal(f.plugin.canRewrite(), false);
    assert.equal(await f.plugin.onAction('rerollWriter'), false);
    assert.equal(f.calls.replays.length, 0);
    await f.reload();
    assert.equal(f.plugin.canRewrite(), false);
});

test('failed or repeated writer swipes preserve old candidate and always clear temporary injection', async t => {
    for (const rewriteMode of ['failure', 'repeat']) {
        await t.test(rewriteMode, async t => {
            const f = await fixture(t, { rewriteMode });
            await f.plugin.onAction('generate', { input: f.input.value });
            await f.plugin.onAction('confirmAndWrite');
            const old = f.ctx.chat.at(-1).mes;
            assert.equal(await f.plugin.onAction('rerollWriter'), false);
            assert.equal(f.ctx.chat.at(-1).mes, old);
            assert.deepEqual(f.ctx.chat.at(-1).swipes, [old]);
            assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
            assert.equal(f.plugin.state.busy, false);
            assert.equal(f.calls.planner.length, 1);
        });
    }
});

async function manualSwipe(f, { targetIndex } = {}) {
    const index = targetIndex ?? f.ctx.chat.length - 1;
    const message = f.ctx.chat[index];
    message.swipes ??= [message.mes];
    const nextSwipe = message.swipes.length;
    message.swipe_id = nextSwipe;
    let aborted = false;
    await f.events.emit('GENERATION_STARTED', 'swipe', {}, false);
    await f.plugin.intercept(f.ctx.chat.slice(0, index), 32000, () => { aborted = true; }, 'swipe');
    const injected = f.ctx.extensionPrompts[INJECTION_KEY]?.value;
    if (!aborted) { message.mes = `${message.mes}（候选）`; message.swipes[nextSwipe] = message.mes; }
    else message.swipe_id = 0;
    await f.events.emit('GENERATION_ENDED');
    return { aborted, injected };
}

test('host swipe metadata does not erase the reply receipt or force replanning', async t => {
    const f = await fixture(t, {
        settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' },
        beforeWriterEnded(ctx) {
            // Hosts and extensions may normalize swipe fields while saving a reply.
            for (const message of ctx.chat.slice(0, -1)) {
                message.swipe_id ??= 0;
                message.swipes ??= [message.mes];
            }
        },
    });
    await f.ctx.generate('normal');
    assert.equal(f.plugin.canRewrite(), true);
    assert.equal(f.plugin.state.logs.some(entry => entry.event === 'writer.receipt.sealed'), true);
    const originalPrompt = f.calls.writer[0].prompt;
    const swiped = await manualSwipe(f);
    assert.equal(swiped.aborted, false);
    assert.equal(swiped.injected, originalPrompt);
    assert.equal(f.calls.planner.length, 1);
});

test('receipt sealing still rejects altered story text and records a safe reason', async t => {
    const f = await fixture(t, {
        settings: { mode: 'auto', autoOnSend: true, regeneratePolicy: 'reuse' },
        beforeWriterEnded(ctx) { ctx.chat.at(-2).mes = '已被改写的用户输入'; },
    });
    await f.ctx.generate('normal');
    assert.equal(f.plugin.canRewrite(), false);
    const rejected = f.plugin.state.logs.find(entry => entry.event === 'writer.receipt.rejected');
    assert.ok(rejected, JSON.stringify(f.plugin.state.logs));
    assert.equal(rejected?.details?.reason, 'prefix-changed');
    assert.ok(!JSON.stringify(rejected).includes('已被改写的用户输入'));
    const swiped = await manualSwipe(f);
    assert.equal(swiped.aborted, true);
    assert.equal(f.calls.planner.length, 1);
});

test('manual swipe under the reuse policy reuses the frozen outline without replanning or recalling', async t => {
    const f = await fixture(t, { settings: { regeneratePolicy: 'reuse' } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    const originalReply = f.ctx.chat.at(-1).mes, originalPrompt = f.calls.writer[0].prompt;
    const recalls = f.calls.recalled, skipped = f.calls.skippedRecalls;
    const first = await manualSwipe(f);
    assert.equal(first.aborted, false);
    assert.equal(first.injected, originalPrompt);
    const second = await manualSwipe(f);
    assert.equal(second.aborted, false);
    assert.equal(second.injected, originalPrompt);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.calls.recalled, recalls);
    assert.ok(f.calls.skippedRecalls > skipped);
    assert.equal(f.ctx.chat.at(-1).swipes.length, 3);
    assert.equal(f.ctx.chat.at(-1).swipes[0], originalReply);
    assert.equal(f.plugin.canRewrite(), true);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('manual swipe survives same-chat reloads and cloned messages but rejects altered reply lineage', async t => {
    const f = await fixture(t, { settings: { regeneratePolicy: 'reuse', autoOnSend: true } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    const originalPrompt = f.calls.writer[0].prompt;

    // Anima or the host may reload the same chat and clone every message. This
    // must not erase a receipt whose floor, prefix and generated swipes are intact.
    f.ctx.chat = structuredClone(f.ctx.chat);
    await f.events.emit('CHAT_CHANGED', f.ctx.chatId);
    const reloaded = await manualSwipe(f);
    assert.equal(reloaded.aborted, false);
    assert.equal(reloaded.injected, originalPrompt);

    f.ctx.chat = structuredClone(f.ctx.chat);
    const cloned = await manualSwipe(f);
    assert.equal(cloned.aborted, false);
    assert.equal(cloned.injected, originalPrompt);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.ctx.chat.at(-1).swipes.length, 3);

    f.ctx.chat.at(-1).swipes[0] = '已被其他内容替换';
    f.ctx.chat = structuredClone(f.ctx.chat);
    assert.equal(f.plugin.canRewrite(), false);
});

test('manual swipe arms synchronously: hosts dispatch GENERATION_STARTED without awaiting listeners', async t => {
    const f = await fixture(t, { settings: { regeneratePolicy: 'reuse' } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    const originalPrompt = f.calls.writer[0].prompt;
    const message = f.ctx.chat.at(-1);
    message.swipes ??= [message.mes];
    const nextSwipe = message.swipes.length;
    message.swipe_id = nextSwipe;
    let aborted = false;
    // The real host fires GENERATION_STARTED synchronously; its interceptor call
    // reaches the plugin before any await inside the listener could resolve.
    f.events.fire('GENERATION_STARTED', 'swipe', {}, false);
    await f.plugin.intercept(f.ctx.chat.slice(0, -1), 32000, () => { aborted = true; }, 'swipe');
    assert.equal(aborted, false);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY]?.value, originalPrompt);
    message.mes = `${message.mes}（候选）`; message.swipes[nextSwipe] = message.mes;
    await f.events.emit('GENERATION_ENDED');
    assert.equal(f.ctx.chat.at(-1).swipes.length, 2);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
    // A later swipe still re-arms cleanly after the previous run completed.
    const again = await manualSwipe(f);
    assert.equal(again.aborted, false);
    assert.equal(again.injected, originalPrompt);
});

test('manual swipe after a page reload reports the missing receipt in the runtime log', async t => {
    const f = await fixture(t, { settings: { regeneratePolicy: 'reuse', autoOnSend: true } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    // Receipts are session-scoped by design: a reload drops the frozen outline.
    await f.reload();
    const message = f.ctx.chat.at(-1);
    message.swipes ??= [message.mes];
    message.swipe_id = message.swipes.length;
    let aborted = false;
    f.events.fire('GENERATION_STARTED', 'swipe', {}, false);
    await f.plugin.intercept(f.ctx.chat.slice(0, -1), 32000, () => { aborted = true; }, 'swipe');
    assert.equal(aborted, true);
    const skip = f.plugin.state.logs.find(entry => entry.event === 'writer.reroll.arm_skipped');
    assert.ok(skip, 'skip reason must be logged');
    assert.ok(skip.message.includes('no-receipt'), skip.message);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('manual swipe without the reuse policy stays native: bare when idle, guided abort with auto-plan', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    const bare = await manualSwipe(f);
    assert.equal(bare.aborted, false);
    assert.equal(bare.injected, undefined);
    assert.equal(f.ctx.chat.at(-1).swipes.length, 2);
    assert.equal(f.calls.planner.length, 1);

    const g = await fixture(t, { settings: { autoOnSend: true } });
    await g.plugin.onAction('generate', { input: g.input.value });
    await g.plugin.onAction('confirmAndWrite');
    const guided = await manualSwipe(g);
    assert.equal(guided.aborted, true);
    assert.equal(guided.injected, undefined);
    assert.equal(g.ctx.chat.at(-1).swipes.length, 1);
    assert.equal(g.ctx.chat.at(-1).mes, '林澄接过信，暂时没有拆开。');
    assert.equal(g.calls.planner.length, 1);
});

test('manual swipe on an older floor never receives the latest outline', async t => {
    const f = await fixture(t, { settings: { regeneratePolicy: 'reuse' } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    const last = f.ctx.chat.at(-1);
    const older = await manualSwipe(f, { targetIndex: 0 });
    assert.equal(older.aborted, false);
    assert.equal(older.injected, undefined);
    assert.equal(f.ctx.chat[0].swipes.length, 2);
    assert.equal(last.swipes, undefined);
    // Swiping an older floor edits the history prefix, which legitimately
    // invalidates the latest floor's rewrite receipt.
    assert.equal(f.plugin.canRewrite(), false);
});

test('automatic review waits for approval; cancellation sends no writer request', async t => {
    const { ctx, plugin, calls } = await fixture(t, { settings: { autoOnSend: true, mode: 'review' } });
    const generating = ctx.generate('normal');
    await until(() => plugin.state.awaitingReview, 'review gate');
    assert.equal(calls.writer.length, 0);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
    await plugin.onAction('cancel');
    await generating;
    assert.equal(calls.writer.length, 0);
    assert.equal(calls.aborted, 1);
    assert.equal(ctx.chat.length, 2);
    assert.equal(ctx.chat.at(-1).is_user, true);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(plugin.state.busy, false);
});

test('outline reroll follows review, manual and auto modes and keeps version history', async t => {
    for (const mode of ['review', 'manual', 'auto']) {
        await t.test(mode, async t => {
            const f = await fixture(t);
            assert.equal(await f.plugin.onAction('rerollPlan', { input: f.input.value }), false);
            await f.plugin.onAction('generate', { input: f.input.value });
            const original = f.plugin.state.planVersions[0];
            await f.plugin.onAction('settings', { mode });
            await f.plugin.onAction('rerollPlan', { input: f.input.value });
            assert.equal(f.calls.planner.length, 2);
            assert.equal(f.calls.writer.length, mode === 'auto' ? 1 : 0);
            assert.equal(f.ctx.chat.length, mode === 'auto' ? 3 : 1);
            assert.equal(f.plugin.state.planVersions.length, 2);
            assert.equal(f.plugin.state.planVersions[0].id, original.id);
            assert.equal(f.plugin.state.planVersions[1].label, '重生成大纲');
            assert.equal(f.plugin.state.stage, mode === 'auto' ? 'complete' : 'review');
        });
    }
});

test('failed reroll leaves previous outline and versions available without writing prose', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    const previous = f.plugin.state.plan.xml;
    await f.plugin.onAction('settings', { baseUrl: 'invalid endpoint' });
    assert.equal(await f.plugin.onAction('rerollPlan', { input: f.input.value }), false);
    assert.equal(f.plugin.state.plan.xml, previous);
    assert.equal(f.plugin.state.planVersions.length, 1);
    assert.equal(f.plugin.state.stage, 'review');
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.plugin.state.busy, false);
});

test('automatic send performs one planner request then one main-model expansion', async t => {
    const { ctx, plugin, calls } = await fixture(t, { settings: { autoOnSend: true, mode: 'auto' } });
    await ctx.generate('normal');
    assert.equal(calls.recalled, 1);
    assert.equal(calls.planner.length, 1);
    assert.equal(calls.writer.length, 1);
    assert.equal(calls.aborted, 0);
    assert.equal(plugin.state.busy, false);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(ctx.chat.filter(m => m.is_user).length, 1);
});

test('automatic send without Anima recall sources reaches main prose without pausing or injecting an empty-memory notice', async t => {
    const f = await fixture(t, {
        settings: { autoOnSend: true, mode: 'auto' },
        recallAnima: async () => ({ text: '', memoryParts: [], status: 'empty', retrievalSkipped: 'no_sources', source: 'fixture' }),
    });
    await f.ctx.generate('normal');
    assert.equal(f.calls.recalled, 1);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.calls.writer.length, 1);
    assert.equal(f.calls.aborted, 0);
    assert.equal(f.plugin.state.awaitingReview, false);
    assert.equal(f.plugin.state.busy, false);
    const requestText = f.calls.planner[0].body.messages.map(message => message.content).join('\n');
    for (const text of ['她递出信。', '谨慎而重视约定', '他站在门口。']) assert.ok(requestText.includes(text));
    const inspection = f.plugin.state.promptInspection;
    assert.equal(inspection.entries.find(entry => entry.id === 'anima_memory').tokens, 0);
    assert.match(inspection.sources.find(source => source.name === 'Anima').status, /已读取.*暂无.*来源/);
    assert.ok(f.plugin.state.logs.some(entry => entry.event === 'anima.recall.completed' && entry.details.retrievalSkipped === 'no_sources'));
    assert.ok(f.calls.writer[0].prompt.includes(f.plugin.state.plan.xml));
    assert.doesNotMatch(`${requestText}\n${f.calls.writer[0].prompt}`, /no_sources|尚无可召回记忆|暂无召回来源|本轮读取成功，没有相关结果/);
    assert.deepEqual(f.ctx.chat.map(message => message.mes), ['他站在门口。', '她递出信。', '林澄接过信，暂时没有拆开。']);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('input box changes invalidate an outline while preset changes no longer do', async t => {
    const { ctx, plugin, calls, input } = await fixture(t);
    await plugin.onAction('generate', { input: input.value });
    input.value = '修改后的输入';
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 0);
    assert.match(plugin.state.status, /输入框.*改变/);
    input.value = '她递出信。';
    await plugin.onAction('promptToggle', { identifier: 'outline_light_user', enabled: false });
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 1);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('changing execution mode or automatic planning preserves a finished outline', async t => {
    for (const [mode, autoOnSend, patch] of [
        ['review', false, { mode: 'auto' }], ['manual', false, { mode: 'review' }],
        ['manual', false, { mode: 'auto' }], ['review', false, { autoOnSend: true }],
        ['review', true, { autoOnSend: false }],
    ]) {
        await t.test(`${mode}/${autoOnSend} to ${JSON.stringify(patch)}`, async subtest => {
            const f = await fixture(subtest, { settings: { mode, autoOnSend } });
            await f.plugin.onAction('generate', { input: f.input.value });
            const outline = f.plugin.state.plan.xml;
            await f.plugin.onAction('saveSettings', { settings: patch });
            assert.equal(f.calls.writer.length, 0, 'Saving a mode must not generate automatically');
            await f.plugin.onAction('confirmAndWrite');
            assert.equal(f.calls.planner.length, 1);
            assert.equal(f.calls.recalled, 1);
            assert.equal(f.calls.writer.length, 1);
            assert.ok(f.calls.writer[0].prompt.includes(outline));
            assert.equal(f.ctx.chat.filter(message => message.is_user).length, 1);
        });
    }
});

test('failed main requests can retry the submitted input without replanning or duplicate messages', async t => {
    for (const restored of [false, true]) for (const end of ['ended', 'stopped', 'throws without end event']) {
        await t.test(`${restored ? 'restored' : 'live'} / ${end}`, async subtest => {
            const f = await fixture(subtest);
            const input = f.input.value;
            await f.plugin.onAction('generate', { input });
            if (restored) await f.reload();
            const generate = f.ctx.generate;
            let attempts = 0;
            f.ctx.generate = async type => {
                attempts++;
                await f.events.emit('GENERATION_STARTED', type, {}, false);
                if (f.input.value) {
                    f.ctx.chat.push({ name: f.ctx.name1, is_user: true, mes: f.input.value });
                    f.input.value = '';
                }
                let aborted = false;
                await f.plugin.intercept(f.ctx.chat, 32000, () => { aborted = true; }, type);
                assert.equal(aborted, false);
                assert.ok(f.ctx.extensionPrompts[INJECTION_KEY]);
                if (end === 'ended') await f.events.emit('GENERATION_ENDED');
                if (end === 'stopped') await f.events.emit('GENERATION_STOPPED');
                if (end !== 'stopped') throw new Error('Main API unavailable');
            };
            await f.plugin.onAction('confirmAndWrite');
            assert.equal(attempts, 1);
            assert.equal(f.plugin.state.busy, false);
            assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
            f.ctx.generate = generate;
            await f.plugin.onAction('saveSettings', { settings: { mode: 'auto', autoOnSend: true } });
            await f.plugin.onAction('confirmAndWrite');
            assert.equal(f.calls.writer.length, 1, f.plugin.state.status);
            assert.equal(f.calls.planner.length, 1);
            assert.equal(f.calls.recalled, 1);
            assert.equal(f.ctx.chat.filter(message => message.is_user && message.mes === input).length, 1);
            assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
            assert.equal(await f.plugin.onAction('confirmAndWrite'), false, 'An answered turn must not be sent again');
            assert.equal(f.calls.writer.length, 1);
        });
    }
});

test('repeated main failures preserve the plugin-owned composer changes for retry', async t => {
    for (const submitted of [false, true]) await t.test(submitted ? 'submitted input remains in composer' : 'input originated in the panel', async subtest => {
        const f = await fixture(subtest);
        const input = f.input.value;
        f.input.value = '';
        await f.plugin.onAction('generate', { input });
        if (submitted) {
            f.ctx.chat.push({ name: f.ctx.name1, is_user: true, mes: input });
            f.input.value = input;
        }
        const generate = f.ctx.generate;
        let attempts = 0;
        f.ctx.generate = async () => { attempts++; throw new Error('Main API unavailable before submission'); };
        await f.plugin.onAction('confirmAndWrite');
        await f.plugin.onAction('confirmAndWrite');
        assert.equal(attempts, 2, f.plugin.state.status);
        assert.equal(f.input.value, submitted ? '' : input);
        f.ctx.generate = generate;
        await f.plugin.onAction('confirmAndWrite');
        assert.equal(f.calls.writer.length, 1, f.plugin.state.status);
        assert.equal(f.calls.planner.length, 1);
        assert.equal(f.calls.recalled, 1);
        assert.equal(f.ctx.chat.filter(message => message.is_user && message.mes === input).length, 1);
    });
});

test('recognizing a submitted input still rejects actual context changes with a specific reason', async t => {
    const changes = [
        ['new composer', f => { f.input.value = '新的未发送输入'; }, 'DRAFT_COMPOSER_CHANGED'],
        ['panel input', f => f.plugin.onAction('input', { value: '新的本轮输入' }), 'DRAFT_INPUT_CHANGED'],
        ['prior history', f => { f.ctx.chat[0].mes = '前文已修改'; }, 'DRAFT_CONTEXT_CHANGED'],
        ['character', f => { f.ctx.characters[0].description = '新人设'; }, 'DRAFT_CONTEXT_CHANGED'],
        ['different user input', f => { f.ctx.chat.at(-1).mes = '别的用户输入'; }, 'DRAFT_CONTEXT_CHANGED'],
        ['already answered', f => { f.ctx.chat.push({ is_user: false, mes: '已有正文' }); }, 'DRAFT_CONTEXT_CHANGED'],
        ['later identical input', f => { f.ctx.chat.push({ is_user: false, mes: '上一轮正文' }, { name: f.ctx.name1, is_user: true, mes: f.plugin.state.input }); }, 'DRAFT_CONTEXT_CHANGED'],
        ['worldbook', f => f.events.emit('WORLDINFO_UPDATED', 'book'), 'DRAFT_WORLDBOOK_CHANGED'],
        ['Anima settings', f => { f.ctx.extensionSettings.anima_memory_system = { rag: { imp_life: 7 } }; }, 'DRAFT_ANIMA_CHANGED'],
    ];
    for (const [name, change, code] of changes) await t.test(name, async subtest => {
        const f = await fixture(subtest);
        await f.plugin.onAction('generate', { input: f.input.value });
        f.ctx.chat.push({ name: f.ctx.name1, is_user: true, mes: f.input.value }); f.input.value = '';
        await change(f);
        const chat = structuredClone(f.ctx.chat), composer = f.input.value;
        assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
        assert.equal(f.calls.writer.length, 0);
        assert.equal(f.calls.planner.length, 1);
        assert.deepEqual(f.ctx.chat, chat);
        assert.equal(f.input.value, composer);
        assert.equal(f.plugin.state.logs.at(-1).details.code, code);
    });
});

test('a refreshed draft expands the pending input through the current main model without replanning', async t => {
    for (const submitted of [false, true]) {
        await t.test(submitted ? 'input already in chat' : 'unsent input', async subtest => {
            const f = await fixture(subtest, { settings: { autoOnSend: true } });
            const input = f.input.value;
            if (submitted) { f.ctx.chat.push({ name: f.ctx.name1, is_user: true, mes: input }); f.input.value = ''; }
            await f.plugin.onAction('generate', { input });
            const expectedXml = f.plugin.state.plan.xml;
            const saved = f.storage.get('plot_workshop:draft:chat-a');
            assert.ok(!saved.includes('之前约定不擅自拆信'), 'Raw recalled memory must not be persisted');
            assert.ok(!saved.includes('他站在门口'), 'Chat history must not be persisted');
            await f.reload();
            f.ctx.chatCompletionSettings.openai_model = 'new-main-writer';
            await f.plugin.onAction('confirmAndWrite');
            assert.equal(f.calls.planner.length, 1, 'Confirmation must not call the planner again');
            assert.equal(f.calls.recalled, 1, 'Confirmation must not run a separate planning recall');
            assert.equal(f.calls.skippedRecalls, 0, 'Missing saved memory must not suppress the native Anima hook');
            assert.equal(f.calls.writer.length, 1);
            assert.equal(f.calls.writer[0].model, 'new-main-writer');
            assert.ok(f.calls.writer[0].prompt.includes(expectedXml));
            assert.equal(f.ctx.chat.filter(message => message.is_user && message.mes === input).length, 1);
            assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
        });
    }
});

test('legacy cached XML and matching input can expand without a configured planning API', async t => {
    const f = await fixture(t, { settings: { baseUrl: '', model: '', autoOnSend: true } });
    const input = f.input.value;
    f.ctx.chat.push({ name: f.ctx.name1, is_user: true, mes: input }); f.input.value = '';
    f.storage.set('plot_workshop:draft:chat-a', JSON.stringify({ xml, input, versions: [] }));
    await f.reload();
    // Simulate the native Anima hook updating its worldbook while the main request starts.
    f.events.on('GENERATION_STARTED', () => f.events.emit('WORLDINFO_UPDATED', 'native-anima-memory'));
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.planner.length, 0);
    assert.equal(f.calls.recalled, 0);
    assert.equal(f.calls.skippedRecalls, 0);
    assert.equal(f.calls.writer.length, 1);
    assert.ok(f.calls.writer[0].prompt.includes(f.plugin.state.plan.xml));
    assert.equal(f.ctx.chat.filter(message => message.is_user).length, 1);
});

test('a saved pending round survives a refresh that clears the host composer', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    f.input.value = '';
    await f.reload();
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.ctx.chat.filter(message => message.is_user && message.mes === '她递出信。').length, 1);
});

test('restored drafts reject changed inputs, different rounds, changed history and already answered turns', async t => {
    const changes = {
        'different composer input': f => { f.input.value = '新的输入'; },
        'edited panel input': f => f.plugin.onAction('input', { value: '另一个本轮输入' }),
        'different latest user': f => { f.input.value = ''; f.ctx.chat.push({ is_user: true, mes: '新的用户消息' }); },
        'already answered': f => { f.input.value = ''; f.ctx.chat.push({ is_user: true, mes: '她递出信。' }, { is_user: false, mes: '已收到信。' }); },
        'repeated input in a later round': f => { f.input.value = ''; f.ctx.chat.push({ is_user: true, mes: '她递出信。' }, { is_user: false, mes: '已收到信。' }, { is_user: true, mes: '她递出信。' }); },
        'edited prior history': f => { f.ctx.chat[0].mes = '他已经离开。'; },
        'different character': f => { f.ctx.characters[0].description = '已经改变的人设'; },
        'another chat': async f => { f.ctx.chatId = 'chat-b'; await f.events.emit('CHAT_CHANGED'); },
    };
    for (const [name, change] of Object.entries(changes)) {
        await t.test(name, async subtest => {
            const f = await fixture(subtest);
            await f.plugin.onAction('generate', { input: f.input.value });
            await f.reload();
            await change(f);
            const before = structuredClone(f.ctx.chat), composer = f.input.value;
            assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
            assert.equal(f.calls.writer.length, 0);
            assert.equal(f.calls.planner.length, 1);
            assert.equal(f.input.value, composer);
            assert.deepEqual(f.ctx.chat, before);
            assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
        });
    }
});

test('restored draft confirmation rechecks history after asynchronous host preparation', async t => {
    let release, block = false;
    const f = await fixture(t, { observerGate: () => block ? new Promise(resolve => { release = resolve; }) : undefined });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.reload(); block = true;
    const pending = f.plugin.onAction('confirmAndWrite');
    await until(() => !!release, 'main-generation observer setup');
    f.ctx.chat[0].mes = '准备期间前文被修改。';
    release(); await pending;
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(f.plugin.state.busy, false);
});

test('restored draft confirmation stops when native observer setup fails', async t => {
    const f = await fixture(t, { observerGate: () => { throw new Error('Anima setup failed'); } });
    const input = f.input.value;
    f.storage.set('plot_workshop:draft:chat-a', JSON.stringify({ xml, input, versions: [] }));
    await f.reload();
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.calls.planner.length, 0);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(f.plugin.state.busy, false);
    assert.match(f.plugin.state.status, /Anima setup failed/);
});

test('edited restored drafts retain their original input binding across another refresh', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.reload();
    await f.plugin.onAction('applyPlanEdit', { xml: f.plugin.state.plan.xml.replace('接信。', '把信留在门口。') });
    await f.reload();
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    assert.match(f.calls.writer[0].prompt, /把信留在门口/);
    assert.equal(f.calls.planner.length, 1);
});

test('planner HTTP failure sends no writer request, exposes no secret and leaves no injection', async t => {
    const { ctx, plugin, calls, input } = await fixture(t, { fetchMode: 'error' });
    await plugin.onAction('apiKey', { value: 'private-key' });
    await plugin.onAction('generate', { input: input.value });
    assert.equal(calls.writer.length, 0);
    assert.equal(plugin.state.plan, null);
    assert.match(plugin.state.status, /HTTP 503/);
    assert.ok(!plugin.state.status.includes('private-key'));
    assert.equal(plugin.state.busy, false);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('editing worldbook after planning invalidates the outline and same-round memory', async t => {
    const { plugin, calls, input, events } = await fixture(t);
    await plugin.onAction('generate', { input: input.value });
    await events.emit('WORLDINFO_UPDATED', 'book');
    assert.equal(calls.invalidated, 1);
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 0);
    assert.match(plugin.state.status, /世界书/);
});

test('changing Anima settings after planning prevents a stale-memory writer request', async t => {
    const { ctx, plugin, calls, input } = await fixture(t);
    await plugin.onAction('generate', { input: input.value });
    ctx.extensionSettings.anima_memory_system = { rag: { imp_life: 7 } };
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 0);
    assert.match(plugin.state.status, /Anima 设置已变化/);
});

test('changing planning settings or preset after planning still allows confirm and write', async t => {
    const { plugin, calls, input } = await fixture(t);
    await plugin.onAction('generate', { input: input.value });
    await plugin.onAction('settings', { model: 'planner-B', temperature: '0.9' });
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 1);
    assert.ok(plugin.state.logs.some(entry => entry.message?.includes('规划预设或规划 API 设置已变化')));
});

test('abort during planner request does not inject a late or partial result', async t => {
    const { ctx, plugin, calls, input } = await fixture(t, { fetchMode: 'pending' });
    const planning = plugin.onAction('generate', { input: input.value });
    await until(() => calls.planner.length === 1, 'pending planner request');
    await plugin.onAction('cancel');
    await planning;
    assert.equal(calls.writer.length, 0);
    assert.equal(plugin.state.plan, null);
    assert.equal(plugin.state.busy, false);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('outline edits are validated before replacing the approved draft', async t => {
    const { plugin, input, calls } = await fixture(t);
    await plugin.onAction('generate', { input: input.value });
    const before = plugin.state.plan.xml;
    await plugin.onAction('applyPlanEdit', { xml: '<content><plot>broken' });
    assert.equal(plugin.state.plan.xml, before);
    assert.match(plugin.state.status, /截断|闭合/);
    await plugin.onAction('applyPlanEdit', { xml: before.replace('接信。', '接信但暂不拆开。') });
    assert.ok(plugin.state.plan.xml.includes('接信但暂不拆开。'));
    await plugin.onAction('confirmAndWrite');
    assert.ok(calls.writer[0].prompt.includes('接信但暂不拆开。'));
});

test('shared prose target reaches both stages while independent key never persists', async t => {
    const { ctx, plugin, calls, input, storage } = await fixture(t);
    await plugin.onAction('apiKey', { value: 'independent-private-key' });
    await plugin.onAction('settings', { minWords: '1500', maxWords: '2000' });
    await plugin.onAction('generate', { input: input.value });
    await plugin.onAction('confirmAndWrite');
    const request = calls.planner[0].body;
    assert.equal(request.model, 'planner-A');
    assert.equal(request.proxy_password, 'independent-private-key');
    assert.equal(calls.writer[0].model, 'main-writer');
    assert.ok(request.messages.some(m => m.content.includes('1500—2000')));
    assert.ok(calls.writer[0].prompt.includes('1500—2000'));
    assert.ok(!JSON.stringify(ctx.extensionSettings).includes('independent-private-key'));
    assert.ok(!JSON.stringify([...storage]).includes('independent-private-key'));
    assert.ok(!JSON.stringify(ctx.extensionSettings).includes('之前约定不擅自拆信'));
    assert.ok(calls.saves > 0);
});

test('new prompts join the selected group order; edits retain order and marker content stays read-only', async t => {
    const f = await fixture(t);
    const { plugin } = f;
    const group = plugin.state.preset.groups[0];
    const last = plugin.state.preset.order.reduce((found, item, index) => plugin.state.preset.promptGroups[item.identifier] === group.id ? index : found, -1);
    const { id } = await plugin.onAction('createPrompt', { name: '新规则', content: '只规划这一轮。', role: 'user', groupId: group.id });
    assert.equal(plugin.state.preset.order.findIndex(item => item.identifier === id), last + 1);
    assert.equal(plugin.state.preset.order.find(item => item.identifier === id).enabled, true);
    assert.equal(plugin.state.preset.promptGroups[id], group.id);
    const order = structuredClone(plugin.state.preset.order);
    await plugin.onAction('editPrompt', { id, name: '新名称', role: 'assistant', groupId: null });
    assert.deepEqual(plugin.state.preset.order, order);
    assert.equal(plugin.state.preset.promptGroups[id], undefined);
    assert.deepEqual(Object.fromEntries(Object.entries(plugin.state.preset.prompts.find(item => item.identifier === id)).filter(([key]) => ['name','role','content'].includes(key))),
        { name: '新名称', content: '只规划这一轮。', role: 'assistant' });
    const marker = plugin.state.preset.prompts.find(item => item.marker);
    const markerBefore = structuredClone(marker);
    await plugin.onAction('editPrompt', { id: marker.identifier, name: '角色资料', content: '不能替换资料', role: 'assistant', groupId: group.id });
    assert.equal(marker.name, '角色资料');
    assert.equal(marker.content, markerBefore.content);
    assert.equal(marker.role, markerBefore.role);
    await plugin.onAction('editPrompt', { id, content: '兼容旧编辑调用' });
    const before = JSON.stringify(plugin.state.preset);
    assert.equal(await plugin.onAction('editPrompt', { id, name: '不应保存', role: 'invalid' }), false);
    assert.equal(JSON.stringify(plugin.state.preset), before);
    await f.reload();
    assert.ok(f.plugin.state.preset.prompts.some(item => item.identifier === id && item.content === '兼容旧编辑调用'));
});

test('single delete undo restores disabled order, group mapping and unlisted prompts without duplication', async t => {
    const source = structuredClone(builtin);
    source.prompts.push({ identifier: 'unlisted', name: '未排序', content: '未启用', role: 'system' });
    const { plugin, ctx } = await fixture(t, { saved: { preset: source } });
    const id = plugin.state.preset.order[0].identifier;
    await plugin.onAction('promptToggle', { identifier: id, enabled: false });
    const before = JSON.parse(JSON.stringify(plugin.state.preset));
    await plugin.onAction('deletePrompt', { id });
    assert.ok(!plugin.state.preset.prompts.some(item => item.identifier === id));
    assert.equal(plugin.state.undoDeletion.id, id);
    assert.ok(!JSON.stringify(ctx.extensionSettings).includes('undoDeletion'));
    await plugin.onAction('undoDeletePrompt');
    assert.deepEqual(JSON.parse(JSON.stringify(plugin.state.preset)), before);
    assert.equal(plugin.state.undoDeletion, null);
    assert.equal(await plugin.onAction('undoDeletePrompt'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(plugin.state.preset)), before);
    await plugin.onAction('deletePrompt', { id: 'unlisted' });
    await plugin.onAction('undoDeletePrompt');
    assert.ok(plugin.state.preset.prompts.some(item => item.identifier === 'unlisted'));
    assert.ok(!plugin.state.preset.order.some(item => item.identifier === 'unlisted'));
});

test('deleted protocol stays deleted through reload and exported-preset import; importing keeps existing plans', async t => {
    const f = await fixture(t);
    const oldId = f.plugin.state.activePresetId;
    await f.plugin.onAction('deletePrompt', { id: 'outline_output' });
    const exported = structuredClone(f.ctx.extensionSettings.plot_workshop.preset);
    await f.reload();
    assert.ok(!f.plugin.state.preset.prompts.some(item => item.identifier === 'outline_output'));
    assert.equal(f.plugin.state.undoDeletion, null);
    await f.plugin.onAction('importPreset', { text: JSON.stringify(exported), name: '删后重新导入.json' });
    assert.equal(f.plugin.state.presetLibrary.length, 2);
    assert.notEqual(f.plugin.state.activePresetId, oldId);
    assert.ok(f.plugin.state.presetLibrary.some(item => item.id === oldId));
    assert.ok(!f.plugin.state.preset.prompts.some(item => item.identifier === 'outline_output'));
    assert.ok(f.plugin.state.presetLibrary.every(item => !JSON.stringify(item).includes('apiKey')));
});

test('planner busy blocks prompt and profile mutations', async t => {
    const { plugin, calls, input } = await fixture(t, { fetchMode: 'pending' });
    const planning = plugin.onAction('generate', { input: input.value });
    await until(() => calls.planner.length === 1, 'pending request');
    const before = JSON.stringify(plugin.state.preset);
    assert.equal(await plugin.onAction('createPrompt', { name: '忙时条目' }), false);
    assert.equal(await plugin.onAction('deletePrompt', { id: 'outline_output' }), false);
    assert.equal(await plugin.onAction('duplicatePrompt', { id: 'outline_output' }), false);
    assert.equal(await plugin.onAction('movePrompt', { id: 'outline_output', beforeId: null }), false);
    assert.equal(await plugin.onAction('apiProfileNew'), false);
    assert.equal(await plugin.onAction('presetNew'), false);
    assert.equal(JSON.stringify(plugin.state.preset), before);
    await plugin.onAction('cancel'); await planning;
    assert.equal(plugin.state.busy, false);
});

test('prompt copies are independent, adjacent, and preserve the original enabled state and group', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    for (const originalId of ['a', 'b']) {
        const source = f.plugin.state.preset.prompts.find(item => item.identifier === originalId);
        const { id } = await f.plugin.onAction('duplicatePrompt', { id: originalId });
        assert.notEqual(id, originalId);
        const copy = f.plugin.state.preset.prompts.find(item => item.identifier === id);
        assert.equal(copy.name, `${source.name} 副本`); assert.equal(copy.content, source.content);
        assert.equal(copy.role, source.role); assert.notEqual(copy, source); assert.notEqual(copy.injection_trigger, source.injection_trigger);
        const order = f.plugin.state.preset.order, originalIndex = order.findIndex(item => item.identifier === originalId);
        assert.equal(order[originalIndex + 1].identifier, id);
        assert.equal(order[originalIndex + 1].enabled, order[originalIndex].enabled);
        assert.equal(f.plugin.state.preset.promptGroups[id], f.plugin.state.preset.promptGroups[originalId]);
        await f.plugin.onAction('editPrompt', { id, content: `COPY_${originalId}` });
        assert.equal(source.content, `ORDER_${originalId}`, 'Editing a copy must not modify its original');
    }
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), ['ORDER_a', 'ORDER_x', 'ORDER_c', 'ORDER_y']);
    const compiled = compilePreset(f.plugin.state.preset, { context: { currentInput: '输入', animaStatus: 'empty', animaMemory: '', charDescription: '' } }).messages;
    assert.ok(compiled.some(message => message.content === 'COPY_a'));
    assert.ok(!compiled.some(message => message.content === 'COPY_b'), 'A disabled original must produce a disabled copy');
});

test('unlisted copies remain disabled and marker copy rejection changes nothing', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    const { id } = await f.plugin.onAction('duplicatePrompt', { id: 'unlisted' });
    assert.equal(f.plugin.state.preset.order.find(item => item.identifier === id).enabled, false);
    assert.equal(f.plugin.state.preset.promptGroups[id], 'group-a');
    assert.ok(!f.plugin.state.preset.order.some(item => item.identifier === 'unlisted'));
    assert.ok(!compiledPromptOrder(f.plugin.state.preset).includes('ORDER_unlisted'));
    const before = JSON.stringify(f.plugin.state.preset), saves = f.calls.saves;
    assert.equal(await f.plugin.onAction('duplicatePrompt', { id: 'charDescription' }), false);
    assert.match(f.plugin.state.status, /资料占位.*不能复制/);
    assert.equal(JSON.stringify(f.plugin.state.preset), before); assert.equal(f.calls.saves, saves);
});

test('same-group reordering changes compiled request order, keeps disabled entries, and appends at group end rather than global end', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    const groups = JSON.stringify(f.plugin.state.preset.promptGroups), groupSettings = JSON.stringify(f.plugin.state.preset.groups);
    const enabled = Object.fromEntries(f.plugin.state.preset.order.map(item => [item.identifier, item.enabled]));
    await f.plugin.onAction('movePrompt', { id: 'c', beforeId: 'a' });
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), ['ORDER_c', 'ORDER_a', 'ORDER_x', 'ORDER_y']);
    await f.plugin.onAction('movePrompt', { id: 'a', beforeId: null });
    assert.deepEqual(f.plugin.state.preset.order.map(item => item.identifier), ['c', 'x', 'b', 'a', 'y', 'charDescription']);
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), ['ORDER_c', 'ORDER_x', 'ORDER_a', 'ORDER_y']);
    await f.plugin.onAction('movePrompt', { id: 'b', beforeId: 'c' });
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), ['ORDER_c', 'ORDER_x', 'ORDER_a', 'ORDER_y']);
    assert.deepEqual(Object.fromEntries(f.plugin.state.preset.order.map(item => [item.identifier, item.enabled])), enabled);
    assert.equal(JSON.stringify(f.plugin.state.preset.promptGroups), groups); assert.equal(JSON.stringify(f.plugin.state.preset.groups), groupSettings);
});

test('explicit cross-group moves require a target in the chosen group and unlisted prompts enter the order disabled', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    await f.plugin.onAction('movePrompt', { id: 'x', groupId: 'group-a', beforeId: 'c' });
    assert.equal(f.plugin.state.preset.promptGroups.x, 'group-a');
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), ['ORDER_a', 'ORDER_x', 'ORDER_c', 'ORDER_y']);
    assert.equal(f.plugin.state.preset.order.find(item => item.identifier === 'x').enabled, true);
    await f.plugin.onAction('movePrompt', { id: 'unlisted', beforeId: 'a' });
    assert.equal(f.plugin.state.preset.order[0].identifier, 'unlisted');
    assert.equal(f.plugin.state.preset.order[0].enabled, false);
    assert.ok(!compiledPromptOrder(f.plugin.state.preset).includes('ORDER_unlisted'));
    assert.equal(f.plugin.state.preset.promptGroups.unlisted, 'group-a');
});

test('invalid move destinations and unknown prompts leave both preset and saved order untouched', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    for (const payload of [
        { id: 'a', beforeId: 'missing' }, { id: 'a', beforeId: 'x' }, { id: 'missing', beforeId: 'a' },
        { id: 'a', groupId: 'missing-group', beforeId: null }, { id: 'a', groupId: 'group-b', beforeId: 'c' },
    ]) {
        const before = JSON.stringify(f.plugin.state.preset), saved = JSON.stringify(f.ctx.extensionSettings), saves = f.calls.saves;
        assert.equal(await f.plugin.onAction('movePrompt', payload), false);
        assert.equal(JSON.stringify(f.plugin.state.preset), before); assert.equal(JSON.stringify(f.ctx.extensionSettings), saved);
        assert.equal(f.calls.saves, saves);
    }
    const before = JSON.stringify(f.plugin.state.preset), saves = f.calls.saves;
    await f.plugin.onAction('movePrompt', { id: 'a', beforeId: 'a' });
    assert.equal(JSON.stringify(f.plugin.state.preset), before); assert.equal(f.calls.saves, saves);
});

test('copied and reordered entries retain their exact order through autosave, reload and exported preset import', async t => {
    const f = await fixture(t, { saved: { preset: reorderPresetFixture() } });
    const { id } = await f.plugin.onAction('duplicatePrompt', { id: 'c' });
    await f.plugin.onAction('movePrompt', { id, beforeId: 'a' });
    await f.plugin.onAction('movePrompt', { id: 'b', beforeId: null });
    const order = structuredClone(f.plugin.state.preset.order), groups = JSON.stringify(f.plugin.state.preset.promptGroups);
    const compiled = compiledPromptOrder(f.plugin.state.preset);
    assert.deepEqual(f.ctx.extensionSettings.plot_workshop.preset.prompt_order[0].order, order);
    await f.plugin.onAction('exportPreset');
    assert.equal(f.downloads.length, 1);
    const exported = JSON.parse(await f.downloads[0].blob.text());
    assert.deepEqual(exported.prompt_order[0].order, order);
    await f.reload();
    assert.deepEqual(f.plugin.state.preset.order, order); assert.equal(JSON.stringify(f.plugin.state.preset.promptGroups), groups);
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), compiled);
    await f.plugin.onAction('importPreset', { text: JSON.stringify(exported), name: '排序导出副本' });
    assert.deepEqual(f.plugin.state.preset.order, order); assert.equal(JSON.stringify(f.plugin.state.preset.promptGroups), groups);
    assert.deepEqual(compiledPromptOrder(f.plugin.state.preset), compiled);
});

test('copying or reordering prompts keeps the old outline writable and the next planner request uses the new order', async t => {
    for (const action of ['duplicatePrompt', 'movePrompt']) {
        await t.test(action, async subtest => {
            const f = await fixture(subtest, { saved: { preset: reorderPresetFixture(), settings: { baseUrl: 'https://relay.example/v1', model: 'planner-A', mode: 'review' } } });
            await f.plugin.onAction('generate', { input: f.input.value });
            const oldXml = f.plugin.state.plan.xml;
            const result = await f.plugin.onAction(action, action === 'movePrompt' ? { id: 'c', beforeId: 'a' } : { id: 'a' });
            assert.ok(result.id); assert.equal(f.plugin.state.plan.xml, oldXml);
            await f.plugin.onAction('confirmAndWrite'); assert.equal(f.calls.writer.length, 1);
            assert.ok(f.calls.writer[0].prompt.includes(oldXml), 'Preset edits must not block the already generated outline');
            f.input.value = '她递出信。';
            await f.plugin.onAction('generate', { input: f.input.value });
            const actual = f.calls.planner.at(-1).body.messages.filter(message => message.content.startsWith('ORDER_')).map(message => message.content);
            assert.deepEqual(actual, action === 'movePrompt' ? ['ORDER_c', 'ORDER_a', 'ORDER_x', 'ORDER_y'] : ['ORDER_a', 'ORDER_a', 'ORDER_x', 'ORDER_c', 'ORDER_y']);
            await f.plugin.onAction('confirmAndWrite'); assert.equal(f.calls.writer.length, 2);
        });
    }
});

test('creating a prompt or switching a planning/API profile keeps the current outline writable', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('createPrompt', { name: '补充内容', content: '本轮停在门口。' });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    await f.plugin.onAction('generate', { input: '她递出信。' });
    await f.plugin.onAction('presetSaveAs', { name: '同内容副本' });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 2);
    await f.plugin.onAction('generate', { input: '她递出信。' });
    await f.plugin.onAction('apiProfileSaveAs', { name: '同连接副本', apiKey: '', rememberKey: false });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 3);
});

test('stream mode defaults on, saves per profile and follows all completion actions', async t => {
    const tested = [], diagnosed = [];
    const f = await fixture(t, { settings: { mode: 'manual' }, api: {
        async testApiConnection(options) { tested.push(options.stream); return { message: '成功' }; },
        async requestDiagnosis(options) { diagnosed.push(options.stream); return { summary: '本轮顺畅。', options: [] }; },
    } });
    assert.equal(f.plugin.state.settings.stream, true);
    const first = f.plugin.state.activeApiProfileId;
    await f.plugin.onAction('apiProfileSave', { settings: { stream: false } });
    const second = (await f.plugin.onAction('apiProfileSaveAs', { name: '流式', settings: { stream: true } })).id;
    for (const [id, stream] of [[first, false], [second, true]]) {
        await f.plugin.onAction('apiProfileSelect', { id });
        await f.reload();
        assert.equal(f.plugin.state.settings.stream, stream);
        await f.plugin.onAction('testApi');
        await f.plugin.onAction('generate', { input: f.input.value });
        assert.equal(f.calls.planner.at(-1).body.stream, stream);
        await f.plugin.onAction('diagnose');
    }
    assert.deepEqual(tested, [false, true]);
    assert.deepEqual(diagnosed, [false, true]);
});

test('word target saves and reaches planner and writer; retired pace settings are dropped', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('saveSettings', { settings: { minWords: '1500', maxWords: '2000', storyPace: 'fast', relationshipPace: 'slow', mode: 'auto' }, rememberKey: false });
    assert.equal(f.ctx.extensionSettings.plot_workshop.settings.minWords, '1500');
    assert.equal(f.ctx.extensionSettings.plot_workshop.settings.storyPace, undefined);
    await f.reload();
    assert.equal(f.plugin.state.settings.minWords, '1500');
    assert.equal(f.plugin.state.settings.storyPace, undefined);
    await f.plugin.onAction('generate', { input: f.input.value });
    const planner = f.calls.planner[0].body.messages.map(message => message.content).join('\n');
    assert.match(planner, /1500—2000/);
    assert.doesNotMatch(planner, /本轮剧情推进|本轮感情推进/);
    assert.equal(f.calls.writer.length, 1);
    assert.match(f.calls.writer[0].prompt, /1500—2000/);
    assert.doesNotMatch(f.calls.writer[0].prompt, /本轮剧情推进|本轮感情推进/);
});

test('API profiles migrate old connection settings, save explicitly, and keep independent secrets in memory', async t => {
    const f = await fixture(t);
    const first = f.plugin.state.activeApiProfileId;
    assert.equal(f.plugin.state.apiProfiles.length, 1);
    assert.equal(f.plugin.state.apiProfiles[0].model, 'planner-A');
    await f.plugin.onAction('settings', { model: 'unsaved-draft', minWords: '1600' });
    assert.equal(f.ctx.extensionSettings.plot_workshop.apiProfiles[0].model, 'planner-A');
    await f.plugin.onAction('saveSettings', { profileName: '主规划', settings: { model: 'saved-model' }, apiKey: 'first-private-key', rememberKey: false });
    const second = (await f.plugin.onAction('apiProfileNew')).id;
    assert.equal(f.plugin.state.settings.baseUrl, '');
    assert.equal(f.plugin.state.settings.minWords, '1600');
    await f.plugin.onAction('apiProfileSave', { name: '备选', settings: { baseUrl: 'https://second.example/v1', model: 'second-model', temperature: '0.6', maxTokens: '4096' }, apiKey: 'second-private-key', rememberKey: false });
    await f.plugin.onAction('apiProfileSelect', { id: first });
    assert.equal(f.plugin.state.settings.model, 'saved-model');
    assert.equal(f.plugin.state.apiKey, 'first-private-key');
    await f.plugin.onAction('apiProfileSelect', { id: second });
    assert.equal(f.plugin.state.apiKey, 'second-private-key');
    assert.equal(f.plugin.state.settings.minWords, '1600');
    assert.ok(!JSON.stringify(f.ctx.extensionSettings).includes('private-key'));
    assert.equal(f.localStorage.size, 0);
    await f.reload();
    assert.equal(f.plugin.state.activeApiProfileId, second);
    assert.equal(f.plugin.state.settings.model, 'second-model');
    assert.equal(f.plugin.state.apiKey, '');
    assert.equal(f.plugin.state.apiProfiles.length, 2);
});

test('remembering a key is explicit per profile, survives reload and is removed when switched off or deleted', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('apiProfileSave', { apiKey: 'remembered-key', rememberKey: true });
    const first = f.plugin.state.activeApiProfileId;
    assert.deepEqual([...f.localStorage.values()], ['remembered-key']);
    assert.ok(!JSON.stringify(f.ctx.extensionSettings).includes('remembered-key'));
    assert.ok(!JSON.stringify([...f.storage]).includes('remembered-key'));
    await f.reload();
    assert.equal(f.plugin.state.apiKey, 'remembered-key');
    assert.equal(f.plugin.state.rememberApiKey, true);
    await f.plugin.onAction('apiProfileSave', { apiKey: 'memory-only-key', rememberKey: false });
    assert.equal(f.localStorage.size, 0);
    const second = (await f.plugin.onAction('apiProfileSaveAs', { name: '副本', apiKey: 'another-key', rememberKey: true })).id;
    assert.notEqual(second, first);
    await f.plugin.onAction('apiProfileDelete', { id: second });
    assert.equal(f.localStorage.size, 0);
    assert.equal(f.plugin.state.activeApiProfileId, first);
    assert.equal(f.plugin.state.apiKey, 'memory-only-key');
    assert.equal(await f.plugin.onAction('apiProfileDelete', { id: first }), false);
});

test('preset library auto-saves edits, switches without changing API, and restores built-in as a new copy', async t => {
    const f = await fixture(t);
    const first = f.plugin.state.activePresetId;
    const api = f.plugin.state.activeApiProfileId;
    await f.plugin.onAction('apiKey', { value: 'still-memory' });
    const { id: promptId } = await f.plugin.onAction('createPrompt', { name: '属于第一套', content: '只在第一套' });
    const second = (await f.plugin.onAction('presetSaveAs', { name: '第二套' })).id;
    await f.plugin.onAction('editPrompt', { id: promptId, content: '第二套修改' });
    await f.plugin.onAction('presetSelect', { id: first });
    assert.equal(f.plugin.state.preset.prompts.find(item => item.identifier === promptId).content, '只在第一套');
    assert.equal(f.plugin.state.activeApiProfileId, api);
    assert.equal(f.plugin.state.apiKey, 'still-memory');
    await f.plugin.onAction('presetSave', { name: '第一套改名' });
    const third = (await f.plugin.onAction('selectPreset')).id;
    assert.equal(f.plugin.state.presetLibrary.length, 3);
    assert.ok(!f.plugin.state.preset.prompts.some(item => item.identifier === promptId));
    await f.plugin.onAction('presetDelete', { id: third });
    assert.equal(f.plugin.state.activePresetId, first);
    assert.equal(f.plugin.state.preset.name, '第一套改名');
    await f.reload();
    await f.plugin.onAction('presetSelect', { id: second });
    assert.equal(f.plugin.state.preset.prompts.find(item => item.identifier === promptId).content, '第二套修改');
    assert.equal(f.plugin.state.activeApiProfileId, api);
});

test('complete V1 and V2 restore as independent copies and generate only their own protocol', async t => {
    const f = await fixture(t);
    const custom = f.plugin.state.activePresetId;
    const { id: customPrompt } = await f.plugin.onAction('createPrompt', { name: '自定义保留项', content: 'CUSTOM_PROMPT_MUST_SURVIVE' });
    const v1 = (await f.plugin.onAction('selectPreset', { id: 'builtin' })).id;
    assert.notEqual(v1, custom);
    assert.match(f.plugin.state.preset.name, /V1 稳定/);
    const output = () => f.plugin.state.preset.prompts.find(item => item.identifier === 'outline_output').content;
    assert.match(output(), /<plot>/);
    assert.doesNotMatch(output(), /<direction>/);
    await f.plugin.onAction('editPrompt', { id: 'outline_output', content: `${output()}\nV1_LOCAL_EDIT` });
    await f.plugin.onAction('generate', { input: f.input.value });
    await until(() => f.plugin.state.plan, 'V1 generation');
    assert.equal(f.calls.planner.at(-1).body.messages.at(-1).content.includes('V1_LOCAL_EDIT'), true);
    assert.doesNotMatch(f.calls.planner.at(-1).body.messages.at(-1).content, /<direction>/);
    await until(() => !f.plugin.state.busy, 'V1 planning completion');
    await f.plugin.onAction('presetSelect', { id: custom });
    assert.equal(f.plugin.state.preset.prompts.find(item => item.identifier === customPrompt)?.content, 'CUSTOM_PROMPT_MUST_SURVIVE');
    const v2 = (await f.plugin.onAction('selectPreset', { id: 'builtin-v2' })).id;
    assert.notEqual(v2, v1);
    assert.match(f.plugin.state.preset.name, /V2 实验/);
    assert.match(output(), /<direction>/);
    assert.doesNotMatch(output(), /V1_LOCAL_EDIT|CUSTOM_PROMPT_MUST_SURVIVE/);
    await f.plugin.onAction('generate', { input: f.input.value });
    await until(() => f.calls.planner.length === 2 && !f.plugin.state.busy, 'V2 generation');
    assert.doesNotMatch(f.calls.planner.at(-1).body.messages.at(-1).content, /V1_LOCAL_EDIT/);
    assert.match(f.calls.planner.at(-1).body.messages.at(-1).content, /<direction>/);
    await f.plugin.onAction('presetSelect', { id: v1 });
    assert.match(output(), /V1_LOCAL_EDIT/);
    assert.equal(f.plugin.state.presetLibrary.length, 3);
    await f.reload();
    await f.plugin.onAction('presetSelect', { id: v2 });
    assert.match(output(), /<direction>/);
    assert.equal(f.plugin.state.presetLibrary.length, 3);
});

test('requesting an unavailable V2 never silently falls back to V1', async t => {
    const f = await fixture(t, { withoutV2: true });
    assert.equal(await f.plugin.onAction('selectPreset', { id: 'builtin-v2' }), false);
    assert.equal(f.plugin.state.presetLibrary.length, 1);
    assert.match(f.plugin.state.status, /V2 实验预设未加载/);
});

test('API fetch and test use submitted unblurred values, redact failures and never persist test secrets', async t => {
    const received = [];
    const api = {
        async fetchModelList(options) { received.push(options); return ['model-x', 'model-y', 'model-x']; },
        async testApiConnection(options) { received.push(options); throw new Error(`connection failed: ${options.apiKey}`); },
    };
    const f = await fixture(t, { api });
    const settings = { baseUrl: 'https://unsaved.example/v1', model: 'unblurred-model' };
    await f.plugin.onAction('fetchModels', { settings, apiKey: 'unblurred-private-key' });
    assert.deepEqual(f.plugin.state.models, ['model-x', 'model-y']);
    assert.equal(received[0].baseUrl, settings.baseUrl);
    assert.equal(received[0].apiKey, 'unblurred-private-key');
    await f.plugin.onAction('testApi', { settings, apiKey: 'unblurred-private-key' });
    assert.equal(received[1].model, settings.model);
    assert.ok(!f.plugin.state.apiStatus.includes('unblurred-private-key'));
    assert.equal(f.plugin.state.apiBusy, false);
    assert.equal(f.plugin.state.settings.model, 'planner-A');
    assert.ok(!JSON.stringify(f.ctx.extensionSettings).includes('unblurred'));
    assert.equal(f.localStorage.size, 0);
});

test('API cancellation blocks conflicts and ignores a late response even when transport ignores abort', async t => {
    let complete;
    const api = { fetchModelList: () => new Promise(resolve => { complete = resolve; }), testApiConnection: async () => ({ message: 'ok' }) };
    const f = await fixture(t, { api });
    const pending = f.plugin.onAction('fetchModels', { apiKey: 'temporary-key' });
    await until(() => f.plugin.state.apiBusy, 'API busy');
    assert.equal(f.plugin.state.busy, false);
    assert.equal(await f.plugin.onAction('generate', { input: f.input.value }), false);
    assert.equal(await f.plugin.onAction('apiProfileNew'), false);
    assert.equal(await f.plugin.onAction('fetchModels'), false);
    assert.equal(f.calls.planner.length, 0);
    await f.plugin.onAction('cancel');
    complete(['late-model']); await pending;
    assert.deepEqual(f.plugin.state.models, []);
    assert.equal(f.plugin.state.apiBusy, false);
    assert.match(f.plugin.state.apiStatus, /已取消/);
});

test('opening the panel detects Anima without an active chat or a memory recall', async t => {
    const f = await fixture(t);
    f.ctx.chatId = ''; f.ctx.chat = []; f.ctx.characters = [];
    await f.plugin.open();
    assert.equal(f.calls.detection.length, 1);
    assert.equal(f.plugin.state.animaDetectionStatus, 'ready');
    assert.equal(f.plugin.state.animaChecking, false);
    assert.equal(f.calls.observers.length, 0);
    assert.equal(f.calls.recalled, 0);
    assert.equal(f.calls.planner.length, 0);
});

test('detected Anima directory is used for observer and recall without changing the saved path', async t => {
    const detected = '/scripts/extensions/third-party/renamed-anima';
    const f = await fixture(t, { detectAnima: async () => ({ status: 'ready', version: '3.3.6', frontendPath: detected, message: '已检测到已就绪的安装。' }) });
    const configured = f.plugin.state.settings.animaPath;
    await f.plugin.onAction('detectAnima');
    assert.equal(f.plugin.state.animaDetectedPath, detected);
    assert.equal(f.plugin.state.settings.animaPath, configured);
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.calls.observers[0].settings.frontendPath, detected);
    assert.equal(f.calls.recalls[0].settings.frontendPath, detected);
    assert.equal(f.calls.recalled, 1);
    assert.ok(f.plugin.state.logs.some(entry => entry.event === 'anima.detect.completed'));
    assert.ok(f.plugin.state.logs.some(entry => entry.event === 'anima.recall.completed'));
});

test('Anima detection blocks conflicting work; changed paths reject stale detection results', async t => {
    let resolveFirst, count = 0;
    const f = await fixture(t, { detectAnima: ({ settings }) => ++count === 1 ? new Promise(resolve => { resolveFirst = resolve; })
        : Promise.resolve({ status: 'ready', frontendPath: settings.frontendPath, message: '新路径已就绪。' }) });
    const pending = f.plugin.onAction('detectAnima');
    await until(() => f.plugin.state.animaChecking, 'Anima checking');
    assert.equal(await f.plugin.onAction('generate', { input: f.input.value }), false);
    assert.equal(await f.plugin.onAction('fetchModels'), false);
    assert.equal(await f.plugin.onAction('settings', { model: 'cannot-change' }), false);
    await f.plugin.onAction('cancel');
    const newPath = '/scripts/extensions/third-party/explicit-anima';
    await f.plugin.onAction('settings', { animaPath: newPath });
    assert.equal(f.calls.detection.length, 2);
    assert.equal(f.plugin.state.animaDetectedPath, newPath);
    resolveFirst({ status: 'ready', frontendPath: '/scripts/extensions/third-party/old-anima', message: '旧结果' });
    await pending;
    assert.equal(f.plugin.state.animaDetectedPath, newPath);
    assert.equal(f.plugin.state.animaStatus, '新路径已就绪。');
    assert.equal(f.plugin.state.animaChecking, false);
    assert.equal(f.calls.recalled, 0);
});

test('chosen injection position, depth and role reach ST and are recorded without story content', async t => {
    const f = await fixture(t, { settings: { injectionPosition: 'in_chat', injectionDepth: '3', injectionRole: 'assistant' } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer[0].position, 1);
    assert.equal(f.calls.writer[0].depth, 3);
    assert.equal(f.calls.writer[0].role, 2);
    assert.equal(f.calls.writer[0].scan, false);
    const injected = f.plugin.state.logs.find(entry => entry.event === 'writer.injected');
    assert.deepEqual(injected.details, { position: 'in_chat', depth: 3, role: 'assistant' });
    assert.match(injected.message, /深度 3/);
    assert.ok(f.plugin.state.logs.some(entry => entry.event === 'writer.request.completed'));
    const logs = JSON.stringify(f.plugin.state.logs);
    assert.ok(!logs.includes('她递出信'));
    assert.ok(!logs.includes('林澄'));
    assert.ok(!logs.includes('<content>'));
    assert.ok(!logs.includes('不擅自拆信'));
    assert.ok(!JSON.stringify(f.ctx.extensionSettings).includes('writer.injected'));
});

test('session logs redact current and previous keys, omit failure bodies and clear without persistence', async t => {
    const api = { fetchModelList: async () => ['ok'], testApiConnection: async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_BODY 回声正文 old-private-key'), { code: 'HTTP_ERROR' }); } };
    const f = await fixture(t, { api });
    await f.plugin.onAction('apiKey', { value: 'old-private-key' });
    await f.plugin.onAction('apiKey', { value: 'new-private-key' });
    await f.plugin.onAction('testApi', { settings: { model: 'old-private-key' }, apiKey: 'new-private-key' });
    const logs = JSON.stringify(f.plugin.state.logs);
    assert.ok(!logs.includes('old-private-key'));
    assert.ok(!logs.includes('new-private-key'));
    assert.ok(!logs.includes('PRIVATE_PROVIDER_BODY'));
    assert.ok(!logs.includes('回声正文'));
    assert.ok(logs.includes('HTTP_ERROR'));
    assert.ok(!JSON.stringify(f.ctx.extensionSettings).includes('api.test.failed'));
    await f.plugin.onAction('clearLogs');
    assert.equal(f.plugin.state.logs.length, 0);
    await f.reload();
    assert.equal(f.plugin.state.logs.length, 0);
});

test('saved built-in preset variables expand identically in repeated inspection and planner requests without host writes', async t => {
    const f = await fixture(t);
    f.ctx.chatMetadata.variables = { rules: '酒馆原值' };
    f.ctx.extensionSettings.variables = { count: '50' };
    await f.plugin.onAction('editPrompt', { id: 'main', content: '{{addvar::rules::第一条。}}{{addglobalvar::count::1}}' });
    await f.plugin.onAction('editPrompt', { id: 'outline_input_sources', content: '{{addvar::rules::\n第二条：{{char}}。}}' });
    await f.plugin.onAction('editPrompt', { id: 'outline_current_state', content: '本轮规则：{{getvar::rules}}/次数={{getglobalvar count}}' });
    const expected = '本轮规则：第一条。\n第二条：林澄。/次数=1';
    for (let i = 0; i < 2; i++) {
        await f.plugin.onAction('inspectPrompts');
        const entry = f.plugin.state.promptInspection.entries.find(item => item.id === 'outline_current_state');
        assert.equal(entry.messages[0].content, expected);
    }
    assert.equal(f.calls.planner.length, 0);
    await f.reload();
    for (const action of ['generate', 'rerollPlan']) {
        await f.plugin.onAction(action, { input: f.input.value });
        assert.ok(f.plugin.state.plan);
        assert.ok(f.calls.planner.at(-1).body.messages.some(message => message.content === expected));
        assert.doesNotMatch(JSON.stringify(f.calls.planner.at(-1).body.messages), /\{\{(?:get|add)(?:global)?var/);
    }
    assert.equal(f.calls.planner.length, 2);
    assert.equal(f.calls.writer.length, 0);
    assert.deepEqual(f.ctx.chatMetadata.variables, { rules: '酒馆原值' });
    assert.deepEqual(f.ctx.extensionSettings.variables, { count: '50' });
});

test('prompt inspection reads actual context without a planner API request and becomes stale on input or preset edits', async t => {
    const f = await fixture(t, { settings: { baseUrl: '', model: '' } });
    await f.plugin.onAction('inspectPrompts');
    assert.equal(f.calls.recalled, 1);
    assert.equal(f.calls.planner.length, 0);
    assert.equal(f.plugin.state.plan, null);
    assert.equal(f.plugin.state.inspectionStale, false);
    const inspection = f.plugin.state.promptInspection;
    assert.equal(inspection.tokenMethod, '按文本估算；非供应商计费');
    assert.ok(inspection.totalTokens > 0);
    assert.deepEqual(inspection.sources.map(source => source.name), ['角色卡', '聊天历史', '世界书', '其他扩展注入', 'Anima']);
    assert.equal(inspection.sources.find(source => source.name === '其他扩展注入').status, '未开启');
    assert.match(inspection.sources.find(source => source.name === '聊天历史').detail, /1 条历史消息/);
    assert.match(inspection.sources.find(source => source.name === '世界书').status, /无命中/);
    assert.equal(inspection.entries.find(entry => entry.id === 'chatHistory').messages[0].content, '林澄: 他站在门口。');
    assert.match(inspection.entries.find(entry => entry.id === 'anima_memory').messages[0].content, /之前约定不擅自拆信/);
    assert.deepEqual(inspection.entries.flatMap(entry => entry.messages), f.plugin.state.promptPreview.planner);
    assert.equal(inspection.entries.find(entry => entry.id === 'outline_length_optional').tokens, 0);
    await f.plugin.onAction('input', { value: '新输入' });
    assert.equal(f.plugin.state.inspectionStale, true);
    await f.plugin.onAction('inspectPrompts');
    assert.equal(f.plugin.state.inspectionStale, false);
    await f.plugin.onAction('editPrompt', { id: 'outline_dialogue', content: '修改对白规则。' });
    assert.equal(f.plugin.state.inspectionStale, true);
    assert.equal(f.calls.planner.length, 0);
});

test('other extension injections reach the planner only when the setting is enabled', async t => {
    const off = await fixture(t);
    off.ctx.setExtensionPrompt('story_clock', '伏笔：信封还没拆。', 1, 2, true, 0, null);
    await off.plugin.onAction('generate', { input: off.input.value });
    assert.ok(!JSON.stringify(off.calls.planner[0].body.messages).includes('其他扩展本轮注入'));
    assert.equal(off.plugin.state.promptInspection.sources.find(source => source.name === '其他扩展注入').status, '未开启');

    const on = await fixture(t, { settings: { readExtensionPrompts: true } });
    on.ctx.setExtensionPrompt('story_clock', '伏笔：信封还没拆。', 1, 2, true, 0, null);
    await on.plugin.onAction('generate', { input: on.input.value });
    const messages = on.calls.planner[0].body.messages;
    const note = messages.find(message => message.content.includes('【其他扩展本轮注入】'));
    assert.ok(note);
    assert.equal(note.role, 'system');
    assert.ok(note.content.includes('伏笔：信封还没拆。'));
    assert.ok(note.content.includes('story_clock'));
    assert.ok(messages.indexOf(note) < messages.findIndex(message => message.content.includes('【本轮当前 user_input】')));
    assert.equal(on.plugin.state.promptInspection.sources.find(source => source.name === '其他扩展注入').status, '已读取');
    on.ctx.extensionPrompts.story_clock.value = '';
    await on.plugin.onAction('inspectPrompts');
    assert.equal(on.plugin.state.promptInspection.sources.find(source => source.name === '其他扩展注入').status, '已读取 · 无注入');
});

test('outline language polish rewrites language only, falls back safely and leaves anchors intact', async t => {
    const polishedXml = '<content><plot>接信。</plot><characters><character name="林澄"><emotion>戒备略有缓和。</emotion><response>接过信。</response></character></characters><segments><segment index="1">林澄看见封口完好，把信接了过来。</segment></segments><end_state>等待回应。</end_state></content>';
    const mismatchXml = '<content><plot>接信。</plot><characters><character name="林澄"><emotion>缓和。</emotion><response>接信。</response></character></characters><segments><segment index="1">接信。</segment><segment index="2">凭空多出的第二段。</segment></segments><end_state>等待回应。</end_state></content>';
    const mode = (polishReply, polishFails = false) => ({ options }) => {
        if (JSON.parse(options.body).model === 'flash-polish') {
            if (polishFails) return new Response('upstream broken', { status: 500 });
            return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: polishReply } }] }));
        }
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: xml } }] }));
    };

    const off = await fixture(t);
    await off.plugin.onAction('generate', { input: off.input.value });
    assert.equal(off.calls.planner.length, 1, 'polish stays off by default');

    const on = await fixture(t, { fetchMode: mode(polishedXml), settings: { polishEnabled: true, polishModel: 'flash-polish' } });
    await on.plugin.onAction('generate', { input: on.input.value });
    assert.equal(on.calls.planner.length, 2);
    const polishCall = on.calls.planner[1];
    assert.equal(polishCall.body.model, 'flash-polish');
    assert.equal(polishCall.body.messages[0].role, 'system');
    assert.match(polishCall.body.messages[0].content, /只改语言，不改内容/);
    assert.ok(polishCall.body.messages[1].content.includes('林澄看见封口完好'));
    assert.ok(on.plugin.state.plan.xml.includes('把信接了过来'));
    assert.match(on.plugin.state.status, /语言净化/);
    assert.equal(on.plugin.state.polishCompare.adopted, true);
    assert.ok(on.plugin.state.polishCompare.original.includes('林澄看见封口完好'));
    assert.ok(on.plugin.state.polishCompare.purified.includes('把信接了过来'));
    await on.plugin.onAction('confirmAndWrite');
    assert.ok(on.calls.writer[0].prompt.includes('把信接了过来'));

    const mismatch = await fixture(t, { fetchMode: mode(mismatchXml), settings: { polishEnabled: true, polishModel: 'flash-polish' } });
    await mismatch.plugin.onAction('generate', { input: mismatch.input.value });
    assert.ok(mismatch.plugin.state.plan.xml.includes('林澄看见封口完好，接过信。'));
    assert.equal(mismatch.plugin.state.planningFailure, null);
    assert.equal(mismatch.plugin.state.polishCompare.adopted, false);
    assert.equal(mismatch.plugin.state.polishCompare.reason, 'mismatch');
    assert.ok(mismatch.plugin.state.polishCompare.purified.includes('凭空多出的第二段'));

    const failing = await fixture(t, { fetchMode: mode('', true), settings: { polishEnabled: true, polishModel: 'flash-polish' } });
    await failing.plugin.onAction('generate', { input: failing.input.value });
    assert.ok(failing.plugin.state.plan.xml.includes('林澄看见封口完好，接过信。'));
    assert.equal(failing.plugin.state.polishCompare.reason, 'failed');
    assert.equal(failing.plugin.state.polishCompare.purified, '');

    assert.equal(off.plugin.state.polishCompare, null, 'no comparison is kept when polish is off');

    // Polish settings are execution switches: toggling them must not invalidate a finished outline.
    await off.plugin.onAction('settings', { polishEnabled: true, polishModel: 'flash-polish' });
    assert.match(off.plugin.state.status, /仍匹配|可以编辑、复制或确认扩写/);
    await off.plugin.onAction('confirmAndWrite');
    assert.equal(off.calls.writer.length, 1);
});

test('a malformed planner response is retried exactly once; a persistent one still surfaces honestly', async t => {
    const malformed = xml.replace('</plot>', '</plotx>');
    let flakyCalls = 0;
    const flaky = () => {
        flakyCalls += 1;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: flakyCalls === 1 ? malformed : xml } }] }));
    };
    const f = await fixture(t, { fetchMode: flaky });
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.calls.planner.length, 2, 'one malformed response triggers exactly one retry');
    assert.ok(f.plugin.state.plan.xml.includes('接过信'));
    assert.ok(f.plugin.state.logs.some(entry => entry.event === 'planner.request.retry'));
    assert.equal(f.plugin.state.planningFailure, null);

    const broken = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: malformed } }] }));
    const g = await fixture(t, { fetchMode: broken });
    assert.equal(await g.plugin.onAction('generate', { input: g.input.value }), false);
    assert.equal(g.calls.planner.length, 2, 'the second malformed response is not retried again');
    assert.equal(g.plugin.state.planningFailure.code, 'CONTENT_INVALID');
});

test('inspecting an unchanged generated plan preserves confirmation and preview exactly matches the sent planner messages', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    const expectedXml = f.plugin.state.plan.xml;
    assert.deepEqual(f.plugin.state.promptInspection.entries.flatMap(entry => entry.messages), f.calls.planner[0].body.messages);
    await f.plugin.onAction('inspectPrompts');
    assert.equal(f.plugin.state.plan.xml, expectedXml);
    assert.equal(f.calls.planner.length, 1);
    await f.plugin.onAction('previewPrompts');
    assert.equal(f.plugin.state.promptPreview.valid, true);
    assert.match(f.plugin.state.promptPreview.writer, /本轮已确认大纲/);
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    assert.ok(f.calls.writer[0].prompt.includes(expectedXml));
});

test('a fresh inspection with changed recalled memory prevents reuse of an older plan', async t => {
    const f = await fixture(t, { recallAnima: async (_options, call) => ({ text: call === 1 ? '原记忆' : '新的相关记忆', status: 'success', source: 'fixture' }) });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('inspectPrompts');
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.writer.length, 0);
});

test('generated and edited versions restore the chosen valid plan while stale versions cannot write', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    const first = f.plugin.state.planVersions[0];
    assert.equal(first.label, '生成大纲');
    const editedXml = first.xml.replace('接信。', '接信后保留沉默。');
    await f.plugin.onAction('applyPlanEdit', { xml: editedXml });
    const second = f.plugin.state.planVersions.at(-1);
    assert.equal(second.parentId, first.id);
    assert.equal(second.label, '手动修改');
    assert.notEqual(second.xml, first.xml);
    await f.plugin.onAction('restoreVersion', { id: first.id });
    assert.equal(f.plugin.state.plan.xml, first.xml);
    assert.match(f.plugin.state.status, /仍匹配/);
    await f.plugin.onAction('restoreVersion', { id: second.id });
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    assert.ok(f.calls.writer[0].prompt.includes('接信后保留沉默。'));
    await f.plugin.onAction('restoreVersion', { id: first.id });
    assert.match(f.plugin.state.status, /重新规划/);
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.writer.length, 1);
    await f.reload();
    assert.equal(f.plugin.state.planVersions.length, 2);
    await f.plugin.onAction('restoreVersion', { id: second.id });
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
});

test('diagnosis is explicitly requested, excludes stale plans, and applies a suggestion only to the panel input', async t => {
    const diagnoses = [];
    const api = { async requestDiagnosis(options) { diagnoses.push(options); return { summary: '本轮还有明确互动空间。', options: [{ title: '询问来意', direction: '让角色先询问递信的缘由。' }] }; } };
    const f = await fixture(t, { api });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('inspectPrompts');
    assert.equal(diagnoses.length, 0);
    await f.plugin.onAction('input', { value: '她改口说明来意。' });
    const chatBefore = structuredClone(f.ctx.chat), hostInputBefore = f.input.value;
    await f.plugin.onAction('diagnose');
    assert.equal(diagnoses.length, 1);
    assert.ok(!diagnoses[0].messages.some(message => message.content.includes('<content>')));
    assert.ok(diagnoses[0].messages.some(message => message.content.includes('她改口说明来意。')));
    assert.equal(f.calls.planner.length, 1);
    await f.plugin.onAction('applyDiagnosis', { index: 0 });
    assert.match(f.plugin.state.input, /让角色先询问递信的缘由/);
    assert.deepEqual(f.ctx.chat, chatBefore);
    assert.equal(f.input.value, hostInputBefore);
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('editing or restoring a plan invalidates recommendations from an earlier diagnosis', async t => {
    const diagnoses = [];
    const api = { async requestDiagnosis(options) { diagnoses.push(options); return { summary: '诊断', options: [{ title: '建议', direction: '保持当前距离。' }] }; } };
    const f = await fixture(t, { api });
    await f.plugin.onAction('generate', { input: f.input.value });
    const first = f.plugin.state.planVersions[0];
    await f.plugin.onAction('diagnose');
    assert.ok(diagnoses[0].messages.some(message => message.content.includes(first.xml)));
    const before = f.plugin.state.input;
    await f.plugin.onAction('applyPlanEdit', { xml: first.xml.replace('接信。', '暂不拆信。') });
    assert.equal(await f.plugin.onAction('applyDiagnosis', { index: 0 }), false);
    assert.equal(f.plugin.state.input, before);
    await f.plugin.onAction('diagnose');
    await f.plugin.onAction('restoreVersion', { id: first.id });
    assert.equal(await f.plugin.onAction('applyDiagnosis', { index: 0 }), false);
    assert.equal(f.plugin.state.input, before);
    assert.equal(f.calls.writer.length, 0);
});

test('returned planning analysis stays outside writer requests, caches, backups, logs and later planning', async t => {
    const secret = 'UNIQUE_RETURNED_ANALYSIS_92817';
    const f = await fixture(t, { settings: { mode: 'auto' }, plannerMessage: {
        content: `<ecot>${secret}-supplement</ecot>\n${xml}`, reasoning_content: `${secret}-reasoning`,
    } });
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.calls.writer.length, 1, 'Analysis must not add a review stop in auto mode');
    assert.equal(f.plugin.state.planningAnalysis.reasoning, `${secret}-reasoning`);
    assert.equal(f.plugin.state.planningAnalysis.supplement, `<ecot>${secret}-supplement</ecot>`);
    assert.equal(Object.hasOwn(f.plugin.state.plan, 'analysis'), false);
    assert.equal(Object.hasOwn(f.plugin.state.plan, 'raw'), false);
    await f.plugin.onAction('exportBackup');
    assert.ok(!(await f.downloads.at(-1).blob.text()).includes(secret));
    f.input.value = '她等待他回答。';
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.calls.planner.length, 2);
    assert.equal(f.calls.writer.length, 2);
    const surfaces = [f.plugin.state.plan, f.plugin.state.rawPlan, f.plugin.state.planVersions,
        f.plugin.state.logs, f.ctx.extensionSettings, f.ctx.chat, f.ctx.extensionPrompts,
        f.calls.planner, f.calls.writer, [...f.storage], [...f.localStorage]];
    for (const surface of surfaces) assert.ok(!JSON.stringify(surface).includes(secret));
});

test('planning analysis belongs to the current response and is cleared on restore, reload and chat change', async t => {
    const f = await fixture(t, { plannerMessage: { content: `<thinking>RESPONSE_ONLY</thinking>${xml}` } });
    await f.plugin.onAction('generate', { input: f.input.value });
    const first = f.plugin.state.planVersions[0];
    await f.plugin.onAction('applyPlanEdit', { xml: first.xml });
    assert.equal(f.plugin.state.planningAnalysis.edited, false);
    await f.plugin.onAction('applyPlanEdit', { xml: first.xml.replace('接信。', '暂不拆信。') });
    assert.equal(f.plugin.state.planningAnalysis.edited, true);
    await f.plugin.onAction('restoreVersion', { id: first.id });
    assert.equal(f.plugin.state.planningAnalysis, null);
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.ok(f.plugin.state.planningAnalysis.supplement.includes('RESPONSE_ONLY'));
    await f.reload();
    assert.equal(f.plugin.state.planningAnalysis, null);
    assert.ok(f.plugin.state.plan);
    await f.plugin.onAction('generate', { input: f.input.value });
    f.ctx.chatId = 'chat-b'; await f.events.emit('CHAT_CHANGED');
    assert.equal(f.plugin.state.planningAnalysis, null);
});

test('manual fill uses only the outline and empty analysis remains explicitly empty', async t => {
    const message = { content: `<unknown-analysis>VIEW_ONLY</unknown-analysis>${xml}` };
    const f = await fixture(t, { settings: { mode: 'manual' }, plannerMessage: message });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('fillInput');
    assert.ok(f.input.value.includes('<content>'));
    assert.ok(!f.input.value.includes('VIEW_ONLY'));
    f.input.value = '她递出信。'; message.content = xml;
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.deepEqual(f.plugin.state.planningAnalysis, { reasoning: '', supplement: '', truncated: false, edited: false });
});

test('tag mentions no longer block automatic writing and stay outside its prompt', async t => {
    const marker = 'ANALYSIS_TAG_MENTION_ONLY';
    const f = await fixture(t, { settings: { mode: 'auto' }, plannerMessage: { content: `<think>${marker}：用 <content> 标签。</think>\n${xml}\n说明 </content>。` } });
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.calls.writer.length, 1);
    assert.ok(f.plugin.state.planningAnalysis.supplement.includes(marker));
    assert.ok(!f.calls.writer[0].prompt.includes(marker));
    assert.equal(f.plugin.state.planningFailure, null);
});

test('failed model text is inspectable and copyable without becoming a plan or persistent data', async t => {
    const marker = 'FAILED_RESPONSE_VIEW_ONLY_3821';
    const message = { content: xml };
    const f = await fixture(t, { plannerMessage: message });
    await f.plugin.onAction('generate', { input: f.input.value });
    const previous = f.plugin.state.plan, count = f.plugin.state.planVersions.length;
    message.content = `${marker}：只有普通文字。`; message.reasoning_content = `${marker}：接口分析。`;
    assert.equal(await f.plugin.onAction('generate', { input: f.input.value }), false);
    assert.equal(f.plugin.state.planningFailure.code, 'CONTENT_MISSING');
    assert.equal(f.plugin.state.planningFailure.content, message.content);
    assert.equal(f.plugin.state.planningFailure.reasoning, message.reasoning_content);
    assert.equal(f.plugin.state.plan, previous);
    assert.equal(f.plugin.state.planVersions.length, count);
    assert.match(f.plugin.state.status, /最近失败响应/);
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.writer.length, 0);
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
    let copied = '';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(text) { copied = text; } } } });
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
    t.after(() => {
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
        if (secureDescriptor) Object.defineProperty(globalThis, 'isSecureContext', secureDescriptor); else delete globalThis.isSecureContext;
    });
    await f.plugin.onAction('copyFailedResponse');
    assert.ok(copied.includes(marker));
    await f.plugin.onAction('exportBackup');
    assert.ok(!(await f.downloads.at(-1).blob.text()).includes(marker));
    for (const surface of [f.plugin.state.plan, f.plugin.state.rawPlan, f.plugin.state.planVersions, f.plugin.state.logs,
        f.ctx.extensionSettings, f.ctx.chat, f.ctx.extensionPrompts, [...f.storage], [...f.localStorage]]) {
        assert.ok(!JSON.stringify(surface).includes(marker));
    }
    await f.plugin.onAction('clearFailedResponse');
    assert.equal(f.plugin.state.planningFailure, null);
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.ok(f.plugin.state.planningFailure);
    message.content = xml; delete message.reasoning_content;
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.plugin.state.planningFailure, null);
    assert.ok(!JSON.stringify(f.calls.planner).includes(marker));
});

test('failed response previews clear on reload and chat switch', async t => {
    const f = await fixture(t, { plannerMessage: { content: 'BAD_RESPONSE' } });
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.ok(f.plugin.state.planningFailure);
    await f.reload();
    assert.equal(f.plugin.state.planningFailure, null);
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.ok(f.plugin.state.planningFailure);
    f.ctx.chatId = 'chat-b'; await f.events.emit('CHAT_CHANGED');
    assert.equal(f.plugin.state.planningFailure, null);
});

test('a late failed response cannot repopulate diagnostics after switching chats', async t => {
    let release;
    const f = await fixture(t, { fetchMode: () => new Promise(resolve => { release = resolve; }) });
    const pending = f.plugin.onAction('generate', { input: f.input.value });
    await until(() => release, 'pending planner response');
    f.ctx.chatId = 'chat-b'; await f.events.emit('CHAT_CHANGED');
    release(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'LATE_PRIVATE_RESPONSE' } }] })));
    await pending;
    assert.equal(f.plugin.state.planningFailure, null);
    assert.equal(f.plugin.state.plan, null);
    assert.equal(f.calls.writer.length, 0);
});

test('backup exports no credentials or raw memory; valid imports merge copies and imported drafts cannot write', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('apiProfileSave', { name: '本地方案', apiKey: 'backup-private-key', rememberKey: true });
    await f.plugin.onAction('generate', { input: f.input.value });
    const oldApi = f.plugin.state.activeApiProfileId, oldPreset = f.plugin.state.activePresetId;
    await f.plugin.onAction('exportBackup');
    assert.equal(f.downloads.length, 1);
    const text = await f.downloads[0].blob.text();
    assert.ok(!text.includes('backup-private-key'));
    assert.ok(!text.includes('之前约定不擅自拆信。'));
    assert.ok(!text.includes('planner.request.completed'));
    const data = JSON.parse(text);
    assert.equal(data.format, 'huapi-backup');
    assert.equal(data.versions.length, 1);
    assert.ok(!Object.hasOwn(data, 'apiKey'));
    const currentSnapshot = JSON.stringify({ settings: f.plugin.state.settings, profiles: f.plugin.state.apiProfiles, presets: f.plugin.state.presetLibrary, versions: f.plugin.state.planVersions });
    const invalid = structuredClone(data);
    invalid.versions.push({ ...invalid.versions[0], id: 'invalid-version', xml: '<content><plot>截断' });
    assert.equal(await f.plugin.onAction('importBackup', { text: JSON.stringify(invalid) }), false);
    assert.equal(JSON.stringify({ settings: f.plugin.state.settings, profiles: f.plugin.state.apiProfiles, presets: f.plugin.state.presetLibrary, versions: f.plugin.state.planVersions }), currentSnapshot);
    await f.plugin.onAction('importBackup', { text });
    assert.equal(f.plugin.state.apiProfiles.length, 2);
    assert.equal(f.plugin.state.presetLibrary.length, 2);
    assert.ok(f.plugin.state.apiProfiles.some(profile => profile.id === oldApi));
    assert.ok(f.plugin.state.presetLibrary.some(preset => preset.id === oldPreset));
    assert.notEqual(f.plugin.state.activeApiProfileId, oldApi);
    assert.notEqual(f.plugin.state.activePresetId, oldPreset);
    assert.equal(f.plugin.state.apiKey, '');
    const importedVersion = f.plugin.state.planVersions.at(-1);
    assert.notEqual(importedVersion.id, data.versions[0].id);
    await f.plugin.onAction('restoreVersion', { id: importedVersion.id });
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.writer.length, 0);
    assert.ok(!JSON.stringify(f.ctx.extensionSettings).includes('backup-private-key'));
});

test('cancelling pending Anima observer setup prevents later recall and requests for planning and inspection', async t => {
    for (const action of ['generate', 'inspectPrompts', 'diagnose']) {
        await t.test(action, async subtest => {
            let release;
            const observerGate = () => new Promise(resolve => { release = resolve; });
            const f = await fixture(subtest, { observerGate, api: { requestDiagnosis: async () => { assert.fail('Diagnosis must not start after cancellation'); } } });
            const pending = f.plugin.onAction(action, { input: f.input.value });
            await until(() => f.calls.observers.length === 1, 'pending observer installation');
            await f.plugin.onAction('cancel');
            release(); await pending;
            assert.equal(f.calls.recalled, 0);
            assert.equal(f.calls.planner.length, 0);
            assert.equal(f.calls.writer.length, 0);
            assert.equal(f.plugin.state.busy, false);
            assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
        });
    }
});

test('automatic send cancelled during observer setup cannot resume planning after setup finishes', async t => {
    let release;
    const f = await fixture(t, { settings: { autoOnSend: true, mode: 'review' }, observerGate: () => new Promise(resolve => { release = resolve; }) });
    const generating = f.ctx.generate('normal');
    await until(() => f.calls.observers.length === 1, 'automatic observer setup');
    await f.plugin.onAction('cancel');
    release();
    try {
        await until(() => f.calls.aborted > 0 || f.plugin.state.awaitingReview, 'automatic cancellation or invalid resumed planning');
        assert.equal(f.calls.recalled, 0, 'Cancelled automatic preparation must not recall memory');
        assert.equal(f.calls.planner.length, 0);
        assert.equal(f.calls.writer.length, 0);
    } finally {
        await f.plugin.onAction('cancel');
        await generating;
    }
});

test('confirmed writing cancelled during observer setup aborts the host request even when automatic planning is off', async t => {
    let release, observerCalls = 0;
    const f = await fixture(t, { observerGate: () => ++observerCalls === 2 ? new Promise(resolve => { release = resolve; }) : Promise.resolve() });
    await f.plugin.onAction('generate', { input: f.input.value });
    const writing = f.plugin.onAction('confirmAndWrite');
    await until(() => f.calls.observers.length === 2, 'confirmed-write observer setup');
    await f.plugin.onAction('cancel');
    release(); await writing;
    assert.equal(f.calls.aborted, 1, 'The host request must be explicitly aborted, not allowed through as an ordinary generation');
    assert.equal(f.calls.writer.length, 0);
    assert.equal(f.calls.planner.length, 1);
    assert.equal(f.calls.recalled, 1);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('refreshing host catalogs reads no memories or book content and changes no main connection', async t => {
    const host = hostLibraryFixture();
    const f = await fixture(t, { host: host.context });
    const before = JSON.stringify({ mainApi: f.ctx.mainApi, completion: f.ctx.chatCompletionSettings, mounts: f.ctx.worldInfoModule });
    const catalog = await f.plugin.onAction('refreshHostCatalog');
    assert.equal(catalog.status, 'ready'); assert.equal(catalog.mountsKnown, true);
    assert.ok(catalog.worldbooks.find(book => book.name === '已挂载').mounted);
    assert.equal(catalog.presets[0].name, '目录原预设');
    assert.equal(f.calls.recalled, 0); assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.writer.length, 0);
    assert.deepEqual(host.calls.reads, []);
    assert.equal(JSON.stringify({ mainApi: f.ctx.mainApi, completion: f.ctx.chatCompletionSettings, mounts: f.ctx.worldInfoModule }), before);
    assert.equal(f.plugin.state.libraryBusy, false);
});

test('host preset import creates a planning copy, preserves enabled choices and reports possible format conflicts', async t => {
    const host = hostLibraryFixture(), original = structuredClone(host.presets[0]);
    const f = await fixture(t, { host: host.context });
    const oldId = f.plugin.state.activePresetId, oldApi = f.plugin.state.activeApiProfileId;
    const main = JSON.stringify(f.ctx.chatCompletionSettings);
    const catalog = await f.plugin.onAction('refreshHostCatalog');
    const imported = await f.plugin.onAction('importHostPreset', { id: catalog.presets[0].id });
    assert.notEqual(imported.id, oldId); assert.equal(f.plugin.state.presetLibrary.length, 2);
    assert.ok(f.plugin.state.presetLibrary.some(item => item.id === oldId));
    assert.equal(f.plugin.state.preset.prompts.find(item => item.identifier === 'host-rule').content, 'ORIGINAL_HOST_PROMPT');
    assert.equal(f.plugin.state.preset.order.find(item => item.identifier === 'host-rule').enabled, true);
    assert.ok(f.plugin.state.preset.prompts.some(item => item.identifier === 'outline_output'));
    assert.ok(f.plugin.state.importReview.items.some(item => item.id === 'host-rule' && item.kind === 'prompt' && item.status === 'review' && item.needsReview));
    assert.deepEqual(host.presets[0], original);
    assert.equal(f.plugin.state.activeApiProfileId, oldApi);
    assert.equal(f.ctx.mainApi, 'textgenerationwebui'); assert.equal(JSON.stringify(f.ctx.chatCompletionSettings), main);
    assert.equal(f.calls.recalled, 0); assert.equal(f.calls.planner.length, 0);
});

test('extra worldbook selection is persisted per chat and cannot leak through CHAT_CHANGED or reload', async t => {
    const host = hostLibraryFixture(), f = await fixture(t, { host: host.context });
    await f.plugin.onAction('extraWorldbooks', { names: ['补充 A'] });
    assert.deepEqual(f.ctx.extensionSettings.plot_workshop.extraWorldbooksByChat['chat-a'], ['补充 A']);
    f.ctx.chatId = 'chat-b'; await f.events.emit('CHAT_CHANGED');
    assert.deepEqual(f.plugin.state.extraWorldbooks, []);
    await f.plugin.onAction('extraWorldbooks', { names: ['补充 B'] });
    assert.deepEqual(f.ctx.extensionSettings.plot_workshop.extraWorldbooksByChat, { 'chat-a': ['补充 A'], 'chat-b': ['补充 B'] });
    f.ctx.chatId = 'chat-a'; await f.events.emit('CHAT_CHANGED');
    assert.deepEqual(f.plugin.state.extraWorldbooks, ['补充 A']);
    await f.reload(); assert.deepEqual(f.plugin.state.extraWorldbooks, ['补充 A']);
    f.ctx.chatId = 'chat-b'; await f.events.emit('CHAT_CHANGED');
    assert.deepEqual(f.plugin.state.extraWorldbooks, ['补充 B']);
    assert.equal(f.calls.recalled, 0); assert.deepEqual(host.calls.reads, []);
});

test('enabled extra book entries appear in the actual planning request and token trace without duplicate mounted content', async t => {
    const host = hostLibraryFixture(), f = await fixture(t, { host: host.context });
    const originalMounts = structuredClone(f.ctx.worldInfoModule);
    await f.plugin.onAction('extraWorldbooks', { names: ['已挂载', '补充 A'] });
    await f.plugin.onAction('generate', { input: f.input.value });
    assert.equal(f.calls.planner.length, 1);
    const actual = f.calls.planner[0].body.messages, combined = actual.map(message => message.content).join('\n');
    assert.match(combined, /ONLY_EXTRA_A \{\{setvar::x::keep-literal\}\}/);
    assert.doesNotMatch(combined, /DISABLED_EXTRA_A|MOUNTED_MUST_NOT_BE_READ_AS_EXTRA/);
    assert.equal(actual.filter(message => message.content.includes('NORMAL_MOUNTED_ACTIVATION')).length, 1);
    assert.deepEqual(host.calls.reads, ['补充 A']);
    const inspection = f.plugin.state.promptInspection;
    const extra = inspection.entries.find(item => item.id === 'worldbook:补充 A');
    assert.ok(extra.enabled); assert.ok(extra.tokens > 0); assert.equal(extra.status, 'sent');
    assert.equal(inspection.entries.find(item => item.id === 'worldbook:已挂载'), undefined);
    assert.deepEqual(inspection.entries.filter(item => item.enabled).flatMap(item => item.messages), actual);
    assert.equal(inspection.totalTokens, inspection.entries.reduce((sum, item) => sum + item.tokens, 0));
    assert.match(inspection.sources.find(item => item.name === '额外世界书 · 补充 A').detail, /1 个启用条目/);
    assert.deepEqual(f.ctx.worldInfoModule, originalMounts);
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1);
    assert.doesNotMatch(f.calls.writer[0].prompt, /ONLY_EXTRA_A/, 'Raw extra books are only sent to the planning model');
});

test('missing or failed extra book reads block a new planner request and invalidate the old outline', async t => {
    for (const failure of ['missing', 'failed']) {
        await t.test(failure, async subtest => {
            const host = hostLibraryFixture(), f = await fixture(subtest, { host: host.context });
            await f.plugin.onAction('extraWorldbooks', { names: ['补充 A'] });
            await f.plugin.onAction('generate', { input: f.input.value });
            const oldXml = f.plugin.state.plan.xml;
            if (failure === 'missing') host.names.splice(host.names.indexOf('补充 A'), 1);
            else host.setLoader(() => null);
            assert.equal(await f.plugin.onAction('generate', { input: f.input.value }), false);
            assert.match(f.plugin.state.status, /不在酒馆目录|读取失败/);
            assert.equal(f.calls.planner.length, 1);
            assert.equal(f.plugin.state.plan.xml, oldXml, 'Previous draft can remain visible but must not remain eligible to write');
            assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
            assert.equal(f.calls.writer.length, 0); assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
        });
    }
});

test('cancelling an extra book read discards its late result and prevents writing the previous outline', async t => {
    const host = hostLibraryFixture(), f = await fixture(t, { host: host.context });
    await f.plugin.onAction('extraWorldbooks', { names: ['补充 A'] });
    await f.plugin.onAction('generate', { input: f.input.value });
    let release;
    host.setLoader(() => new Promise(resolve => { release = resolve; }));
    const planning = f.plugin.onAction('generate', { input: f.input.value });
    await until(() => typeof release === 'function', 'pending extra worldbook read');
    await f.plugin.onAction('cancel'); await planning;
    release(host.books['补充 A']); await turns();
    assert.equal(f.calls.planner.length, 1); assert.equal(f.plugin.state.busy, false);
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.writer.length, 0); assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('appearance save is isolated from connection fields and survives reload', async t => {
    const f = await fixture(t);
    const profile = structuredClone(f.plugin.state.apiProfiles);
    const before = f.plugin.state.settings.baseUrl;
    assert.equal(await f.plugin.onAction('saveAppearance', { theme: 'dark', fontSize: '11.5', lineHeight: '2.15', baseUrl: 'https://unintended.example', model: 'unintended', apiKey: 'not-a-real-key' }), true);
    assert.deepEqual(f.plugin.state.apiProfiles, profile);
    assert.equal(f.plugin.state.settings.baseUrl, before);
    assert.equal(f.calls.planner.length, 0);
    await f.reload();
    assert.equal(f.plugin.state.settings.fontSize, '11.5');
    assert.equal(f.plugin.state.settings.lineHeight, '2.15');
    assert.equal(f.plugin.state.settings.theme, 'dark');
    const saved = structuredClone(f.plugin.state.settings);
    for (const patch of [{ fontSize: '' }, { fontSize: '25' }, { fontSize: 'bad' }, { lineHeight: '0' }, { lineHeight: '' }, { theme: 'unknown' }]) {
        assert.equal(await f.plugin.onAction('saveAppearance', { theme: 'dark', fontSize: '12', lineHeight: '1.75', ...patch }), false);
        assert.deepEqual(f.plugin.state.settings, saved);
    }
});

test('appearance changes keep a valid outline and its prompt inspection usable for confirmation', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    const originalXml = f.plugin.state.plan.xml;
    await f.plugin.onAction('saveAppearance', { theme: 'light', fontSize: '17', lineHeight: '1.9' });
    assert.equal(f.plugin.state.settings.theme, 'light'); assert.equal(f.plugin.state.settings.fontSize, '17');
    assert.equal(f.plugin.state.settings.lineHeight, '1.9'); assert.equal(f.plugin.state.inspectionStale, false);
    assert.equal(f.plugin.state.plan.xml, originalXml);
    await f.plugin.onAction('confirmAndWrite');
    assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.planner.length, 1);
});

test('revoking remembered API key storage succeeds even when another form field has an invalid base URL', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('apiProfileSave', { apiKey: 'remembered-before-error', rememberKey: true });
    assert.equal(f.localStorage.size, 1);
    const originalProfiles = structuredClone(f.plugin.state.apiProfiles);
    const result = await f.plugin.onAction('apiProfileSave', { settings: { baseUrl: 'not-a-valid-url' }, apiKey: 'memory-only-after-error', rememberKey: false });
    assert.equal(result, false); assert.equal(f.localStorage.size, 0);
    assert.equal(f.plugin.state.rememberApiKey, false);
    assert.deepEqual(f.plugin.state.apiProfiles, originalProfiles, 'Invalid unrelated settings must not replace the saved API profile');
    await f.reload(); assert.equal(f.plugin.state.apiKey, ''); assert.equal(f.plugin.state.rememberApiKey, false);
});

test('updater is dormant before explicit start, receives host identity and is destroyed with the controller', async t => {
    const updates = fakeUpdaterFixture(), f = await fixture(t, { updaterFactory: updates.updaterFactory });
    const manager = updates.manager;
    assert.equal(manager.calls.starts, 0); assert.equal(manager.calls.checks, 0);
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0);
    assert.equal(manager.options.getContext(), f.ctx);
    assert.equal(manager.options.extensionUrl, 'https://tavern.example/scripts/extensions/third-party/renamed-huapi/');
    assert.equal(manager.options.currentVersion, '0.2.0'); assert.equal(f.plugin.state.update, manager.state);
    f.plugin.startUpdates();
    assert.equal(manager.calls.starts, 1); assert.equal(manager.calls.checks, 1);
    await f.plugin.onAction('checkUpdate'); assert.equal(manager.calls.checks, 2);
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0);
    f.plugin.destroy(); assert.equal(manager.calls.destroys, 1);
    assert.equal(manager.options.canInstall(false), false);
});

test('update preferences persist separately from creative settings and do not invalidate the current outline', async t => {
    const updates = fakeUpdaterFixture(), f = await fixture(t, { updaterFactory: updates.updaterFactory });
    await f.plugin.onAction('generate', { input: f.input.value });
    const settings = structuredClone(f.plugin.state.settings), plan = f.plugin.state.plan.xml;
    await f.plugin.onAction('updatePreferences', { autoCheck: false, autoInstall: true });
    assert.deepEqual(f.ctx.extensionSettings.plot_workshop.updatePreferences, { autoCheck: false, autoInstall: true });
    assert.deepEqual(f.plugin.state.settings, settings); assert.equal(f.plugin.state.plan.xml, plan);
    assert.equal(f.plugin.state.inspectionStale, false);
    assert.equal(updates.manager.calls.checks, 0); assert.equal(updates.manager.calls.installs, 0);
    await f.plugin.onAction('confirmAndWrite'); assert.equal(f.calls.writer.length, 1);
    await f.reload();
    assert.deepEqual(updates.manager.options.preferences, { autoCheck: false, autoInstall: true });
    f.plugin.startUpdates(); assert.equal(updates.manager.calls.checks, 0);
});

test('busy operations and unsaved form edits prevent update installation and page reload', async t => {
    for (const guard of ['busy', 'apiBusy', 'animaChecking', 'libraryBusy', 'unsaved', 'hostGenerating']) {
        await t.test(guard, async subtest => {
            const updates = fakeUpdaterFixture(), f = await fixture(subtest, { updaterFactory: updates.updaterFactory });
            if (guard === 'unsaved') f.viewState.unsaved = true;
            else if (guard === 'hostGenerating') f.ctx.isGenerating = () => true;
            else f.plugin.state[guard] = true;
            assert.equal(updates.manager.options.canInstall(false), false);
            assert.equal(updates.manager.options.canInstall(true), false);
            assert.equal(await f.plugin.onAction('installUpdate'), false);
            assert.equal(updates.manager.calls.installs, 0);
            updates.manager.emit({ phase: 'installed' });
            assert.equal(await f.plugin.onAction('reloadUpdate'), false);
            assert.equal(f.calls.reloads, 0); assert.match(f.plugin.state.status, /保存修改.*结束当前生成/);
            assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0);
        });
    }
});

test('automatic installation waits for a closed workbench and any real host generation even when automatic planning is disabled', async t => {
    const updates = fakeUpdaterFixture(), f = await fixture(t, { settings: { autoOnSend: false }, updaterFactory: updates.updaterFactory });
    const canInstall = updates.manager.options.canInstall;
    assert.equal(canInstall(true), true);
    f.viewState.open = true; assert.equal(canInstall(true), false); assert.equal(canInstall(false), true);
    f.viewState.open = false;
    await f.events.emit('GENERATION_STARTED', 'normal', {}, true);
    assert.equal(canInstall(true), true, 'Dry-run prompt assembly is not a real generation');
    await f.events.emit('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(canInstall(true), false); assert.equal(canInstall(false), false);
    assert.equal(f.calls.observers.length, 0, 'Manual mode must still guard updates without starting planning');
    await f.events.emit('GENERATION_ENDED'); assert.equal(canInstall(true), true);
    await f.events.emit('GENERATION_STARTED', 'quiet', {}, false); assert.equal(canInstall(true), false);
    await f.events.emit('GENERATION_STOPPED'); assert.equal(canInstall(true), true);
    f.ctx.isGenerating = true; assert.equal(canInstall(true), false);
    f.ctx.isGenerating = false; assert.equal(canInstall(true), true);
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0);
});

test('installing an update aborts host generation and blocks planning and creative mutations', async t => {
    const updates = fakeUpdaterFixture(), f = await fixture(t, { settings: { autoOnSend: false }, updaterFactory: updates.updaterFactory });
    const settings = structuredClone(f.plugin.state.settings), input = f.plugin.state.input;
    updates.manager.emit({ phase: 'installing' });
    for (const type of ['normal', 'quiet', 'impersonate']) {
        const aborts = [];
        await f.plugin.intercept(f.ctx.chat, 32000, value => aborts.push(value), type);
        assert.deepEqual(aborts, [true]);
    }
    for (const [type, payload] of [
        ['generate', { input: f.input.value }], ['confirmAndWrite', {}], ['input', { value: '不应写入' }],
        ['settings', { minWords: '999' }], ['apiKey', { value: 'must-not-save' }],
        ['promptToggle', { identifier: 'outline_light_user', enabled: false }],
    ]) {
        assert.equal(await f.plugin.onAction(type, payload), false);
        assert.match(f.plugin.state.status, /正在更新/);
    }
    assert.deepEqual(f.plugin.state.settings, settings); assert.equal(f.plugin.state.input, input);
    assert.equal(f.plugin.state.apiKey, ''); assert.equal(f.plugin.state.plan, null);
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0); assert.equal(f.calls.writer.length, 0);
    assert.equal(f.ctx.extensionPrompts[INJECTION_KEY], undefined);
});

test('refreshing an installed update caches the current draft and waits for host settings to save before reloading', async t => {
    let finishSave;
    const order = [], updates = fakeUpdaterFixture();
    const f = await fixture(t, { updaterFactory: updates.updaterFactory, host: {
        saveSettings() { order.push('save-start'); return new Promise(resolve => { finishSave = () => { order.push('save-end'); resolve(); }; }); },
    }, reloadPage() { order.push('reload'); } });
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('applyPlanEdit', { xml: xml.replace('接信。', '接信后不急于拆开。') });
    await f.plugin.onAction('updatePreferences', { autoCheck: true, autoInstall: true });
    updates.manager.emit({ phase: 'installed' });
    const reloading = f.plugin.onAction('reloadUpdate');
    await until(() => typeof finishSave === 'function', 'host settings save before refresh');
    assert.equal(f.calls.reloads, 0); assert.deepEqual(order, ['save-start']);
    const cached = JSON.parse(f.storage.get('plot_workshop:draft:chat-a'));
    assert.equal(cached.xml, f.plugin.state.plan.xml); assert.equal(cached.input, f.plugin.state.input);
    assert.equal(cached.versions.length, 2);
    assert.deepEqual(f.ctx.extensionSettings.plot_workshop.updatePreferences, { autoCheck: true, autoInstall: true });
    finishSave(); await reloading;
    assert.equal(f.calls.reloads, 1); assert.deepEqual(order, ['save-start', 'save-end', 'reload']);
    assert.equal(f.calls.writer.length, 0);
});

test('an update cannot reload before installation or after a failed host settings save', async t => {
    const updates = fakeUpdaterFixture(), f = await fixture(t, { updaterFactory: updates.updaterFactory,
        host: { async saveSettings() { throw new Error('设置保存失败'); } } });
    assert.equal(await f.plugin.onAction('reloadUpdate'), false); assert.equal(f.calls.reloads, 0);
    updates.manager.emit({ phase: 'installed' });
    assert.equal(await f.plugin.onAction('reloadUpdate'), false); assert.equal(f.calls.reloads, 0);
    assert.match(f.plugin.state.status, /设置保存失败/);
});

test('update refresh rechecks generation and unsaved edits after awaiting host settings persistence', async t => {
    for (const change of ['host-generating', 'unsaved-form']) {
        await t.test(change, async subtest => {
            let finishSave;
            const updates = fakeUpdaterFixture(), f = await fixture(subtest, { updaterFactory: updates.updaterFactory,
                host: { saveSettings() { return new Promise(resolve => { finishSave = resolve; }); } } });
            updates.manager.emit({ phase: 'installed' });
            const refresh = f.plugin.onAction('reloadUpdate');
            await until(() => typeof finishSave === 'function', 'pending settings persistence');
            if (change === 'host-generating') await f.events.emit('GENERATION_STARTED', 'normal', {}, false);
            else f.viewState.unsaved = true;
            finishSave(); assert.equal(await refresh, false);
            assert.equal(f.calls.reloads, 0, 'A newly busy host or unsaved form must prevent late refresh');
        });
    }
});

test('import adjustment changes only the new copy, persists its report and restores only automatic choices', async t => {
    const f = await fixture(t);
    const originalId = f.plugin.state.activePresetId;
    const originalPreset = JSON.stringify(f.plugin.state.preset);
    const hostConfig = JSON.stringify(f.ctx.chatCompletionSettings);
    const imported = { name: '普通正文预设', prompts: [
        { identifier: 'character_work', name: '人物理解', role: 'system', content: '结合人物经历确定当前动机和回应。' },
        { identifier: 'prose', name: '正文输出', role: 'system', content: '请直接输出完整的小说正文。' },
        { identifier: 'status', name: '状态栏', role: 'system', content: '在每次回复末尾输出状态栏，包含姓名、心情和位置。' },
        { identifier: 'vars', name: '文风变量', role: 'system', content: '{{setvar::style::细腻}}' },
        { identifier: 'already_off', name: '已关闭条目', role: 'system', content: '不应恢复', enabled: false },
    ] };
    const result = await f.plugin.onAction('importPreset', { text: JSON.stringify(imported) });
    assert.equal(result.autoDisabledCount, 2);
    assert.notEqual(f.plugin.state.activePresetId, originalId);
    const enabled = id => f.plugin.state.preset.order.find(item => item.identifier === id)?.enabled;
    assert.equal(enabled('prose'), false); assert.equal(enabled('status'), false);
    assert.equal(enabled('character_work'), true); assert.equal(enabled('vars'), true); assert.equal(enabled('outline_output'), true);
    assert.equal(f.calls.planner.length, 0); assert.equal(f.calls.recalled, 0);
    assert.equal(JSON.stringify(f.ctx.chatCompletionSettings), hostConfig);
    assert.equal(f.plugin.state.importReview.autoDisabledCount, 2);
    await f.reload();
    await f.plugin.onAction('presetSave');
    assert.equal(f.plugin.state.importReview.restorableCount, 2);
    assert.equal((await f.plugin.onAction('restoreImportDisabled')).count, 2);
    assert.equal(enabled('prose'), true); assert.equal(enabled('status'), true);
    assert.equal(enabled('already_off'), false);
    assert.equal(f.plugin.state.importReview.restorableCount, 0);
    await f.plugin.onAction('presetSelect', { id: originalId });
    assert.equal(JSON.stringify(f.plugin.state.preset), originalPreset);
});

test('reimporting a Vespera export retains restored selections and scoped import history', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('importPreset', { text: JSON.stringify({ name: '独立正文', prompts: [{ identifier: 'prose', name: '正文输出', content: '请直接输出完整的小说正文。' }] }) });
    await f.plugin.onAction('restoreImportDisabled');
    const saved = structuredClone(f.ctx.extensionSettings.plot_workshop.preset);
    assert.equal(saved.extensions.plot_workshop.import_advice.disable.length, 1);
    const result = await f.plugin.onAction('importPreset', { text: JSON.stringify(saved) });
    assert.equal(result.autoDisabledCount, 0);
    assert.equal(f.plugin.state.preset.order.find(item => item.identifier === 'prose').enabled, true);
    assert.equal(f.plugin.state.importReview.restorableCount, 0);
    await f.plugin.onAction('presetNew');
    assert.equal(f.plugin.state.importReview.autoDisabledCount, 0);
    assert.equal((await f.plugin.onAction('restoreImportDisabled')).count, 0);
});
