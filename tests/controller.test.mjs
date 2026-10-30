import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlugin } from '../index.js';
import { INJECTION_KEY } from '../lib/host.js';
import { compilePreset } from '../lib/preset.js';

const xml = '<content><plot>接信。</plot><characters><character name="林澄"><emotion>仍有戒备。</emotion><response>接过信。</response></character></characters><segments><segment index="1">林澄看见封口完好，接过信。</segment></segments><end_state>等待回应。</end_state></content>';
const builtin = JSON.parse(fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'));
const turns = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await turns(); }
    throw new Error(`Did not reach ${label}`);
}

async function fixture(t, { settings = {}, saved, fetchMode = 'success', api, detectAnima, observerGate, recallAnima, host = {}, updaterFactory,
    viewState = { open: false, unsaved: false }, reloadPage, rewriteMode = 'success', plannerMessage } = {}) {
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
    };
    const calls = { planner: [], writer: [], replays: [], saves: 0, recalled: 0, invalidated: 0, aborted: 0, detection: [], observers: [], recalls: [], reloads: 0 };
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
        skipNextAnimaRecall() { return () => {}; }, invalidateAnimaRoundCache() { calls.invalidated++; },
    };
    const fetchImpl = async (url, options) => {
        calls.planner.push({ url, options, body: JSON.parse(options.body) });
        if (fetchMode === 'error') return new Response('server private-key details', { status: 503 });
        if (fetchMode === 'pending') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: plannerMessage ?? { content: xml } }] }));
    };
    const view = { render() {}, open() { viewState.open = true; }, close() { viewState.open = false; }, destroy() {},
        isOpen: () => viewState.open, hasUnsavedChanges: () => viewState.unsaved };
    const makePlugin = () => createPlugin({ getContext: () => ctx, builtin, writerRules: '按当前大纲扩写中文正文。', anima, viewFactory: () => view, fetchImpl,
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
        if (input.value) { ctx.chat.push({ name: ctx.name1, is_user: true, mes: input.value }); input.value = ''; }
        await plugin.intercept(ctx.chat, 32000, () => { aborted = true; calls.aborted++; }, type);
        if (!aborted) {
            const prompt = ctx.extensionPrompts[INJECTION_KEY];
            assert.ok(prompt && (!prompt.filter || await prompt.filter()), 'Writer requires the valid this-turn outline');
            calls.writer.push({ prompt: prompt.value, model: ctx.chatCompletionSettings.openai_model, position: prompt.position, depth: prompt.depth, role: prompt.role, scan: prompt.scan });
            ctx.chat.push({ name: ctx.name2, is_user: false, mes: '林澄接过信，暂时没有拆开。' });
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

test('input and preset changes invalidate an already generated outline', async t => {
    const { ctx, plugin, calls, input } = await fixture(t);
    await plugin.onAction('generate', { input: input.value });
    input.value = '修改后的输入';
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 0);
    assert.match(plugin.state.status, /输入框.*改变/);
    input.value = '她递出信。';
    await plugin.onAction('promptToggle', { identifier: 'outline_light_user', enabled: false });
    await plugin.onAction('confirmAndWrite');
    assert.equal(calls.writer.length, 0);
    assert.match(plugin.state.status, /预设.*变化/);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
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
    assert.match(plugin.state.status, /设置已变化/);
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

test('copying or reordering prompts invalidates the old outline and the next planner request uses the new order', async t => {
    for (const action of ['duplicatePrompt', 'movePrompt']) {
        await t.test(action, async subtest => {
            const f = await fixture(subtest, { saved: { preset: reorderPresetFixture(), settings: { baseUrl: 'https://relay.example/v1', model: 'planner-A', mode: 'review' } } });
            await f.plugin.onAction('generate', { input: f.input.value });
            const oldXml = f.plugin.state.plan.xml;
            const result = await f.plugin.onAction(action, action === 'movePrompt' ? { id: 'c', beforeId: 'a' } : { id: 'a' });
            assert.ok(result.id); assert.equal(f.plugin.state.plan.xml, oldXml);
            assert.equal(await f.plugin.onAction('confirmAndWrite'), false); assert.equal(f.calls.writer.length, 0);
            assert.match(f.plugin.state.status, /预设.*变化/);
            await f.plugin.onAction('generate', { input: f.input.value });
            const actual = f.calls.planner.at(-1).body.messages.filter(message => message.content.startsWith('ORDER_')).map(message => message.content);
            assert.deepEqual(actual, action === 'movePrompt' ? ['ORDER_c', 'ORDER_a', 'ORDER_x', 'ORDER_y'] : ['ORDER_a', 'ORDER_a', 'ORDER_x', 'ORDER_c', 'ORDER_y']);
            await f.plugin.onAction('confirmAndWrite'); assert.equal(f.calls.writer.length, 1);
        });
    }
});

test('creating a prompt or switching a planning/API profile invalidates the current outline', async t => {
    const f = await fixture(t);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('createPrompt', { name: '补充内容', content: '本轮停在门口。' });
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.match(f.plugin.state.status, /预设.*变化/);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('presetSaveAs', { name: '同内容副本' });
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    await f.plugin.onAction('generate', { input: f.input.value });
    await f.plugin.onAction('apiProfileSaveAs', { name: '同连接副本', apiKey: '', rememberKey: false });
    assert.equal(await f.plugin.onAction('confirmAndWrite'), false);
    assert.equal(f.calls.writer.length, 0);
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
    assert.deepEqual(inspection.sources.map(source => source.name), ['角色卡', '聊天历史', '世界书', 'Anima']);
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
    assert.ok(f.plugin.state.importReview.items.some(item => item.id === 'host-rule' && item.kind === 'review'));
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
