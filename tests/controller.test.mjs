import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlugin } from '../index.js';
import { INJECTION_KEY } from '../lib/host.js';

const xml = '<content><plot>接信。</plot><characters><character name="林澄"><emotion>仍有戒备。</emotion><response>接过信。</response></character></characters><segments><segment index="1">林澄看见封口完好，接过信。</segment></segments><end_state>等待回应。</end_state></content>';
const builtin = JSON.parse(fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'));
const turns = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await turns(); }
    throw new Error(`Did not reach ${label}`);
}

async function fixture(t, { settings = {}, fetchMode = 'success' } = {}) {
    const prior = { document: globalThis.document, sessionStorage: globalThis.sessionStorage, SillyTavern: globalThis.SillyTavern };
    const input = { value: '她递出信。', dispatchEvent() {} };
    const storage = new Map();
    globalThis.document = { querySelector: selector => selector === '#send_textarea' ? input : null };
    globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
    delete globalThis.SillyTavern;
    const handlers = new Map();
    const events = {
        on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
        removeListener(name, fn) { handlers.set(name, (handlers.get(name) || []).filter(f => f !== fn)); },
        async emit(name, ...args) { for (const handler of handlers.get(name) || []) await handler(...args); },
    };
    const calls = { planner: [], writer: [], saves: 0, recalled: 0, invalidated: 0, aborted: 0 };
    const ctx = {
        chatId: 'chat-a', characterId: 0, groupId: null, name1: '苏青', name2: '林澄', onlineStatus: 'connected',
        characters: [{ name: '林澄', description: '谨慎而重视约定', data: { description: '谨慎而重视约定', personality: '', scenario: '门口', mes_example: '' } }],
        chat: [{ name: '林澄', is_user: false, mes: '他站在门口。' }],
        chatMetadata: {}, powerUserSettings: { persona_description: '苏青寡言' },
        chatCompletionSettings: { openai_model: 'main-writer', openai_max_context: 32000 },
        extensionSettings: { plot_workshop: { settings: { baseUrl: 'https://relay.example/v1', model: 'planner-A', mode: 'review', minWords: '1500', maxWords: '2000', ...settings } } },
        extensionPrompts: {}, eventSource: events,
        eventTypes: Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'].map(x => [x, x])),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced() { calls.saves++; },
        async getWorldInfoPrompt() { return { worldInfoBefore: '', worldInfoAfter: '' }; },
        setExtensionPrompt(key, value, position, depth, scan, role, filter) { this.extensionPrompts[key] = { value, position, depth, scan, role, filter }; },
    };
    ctx.getCurrentChatId = () => ctx.chatId;
    const anima = {
        async installAnimaObserver() {}, beginAnimaGeneration() { return 'generation-token'; }, clearAnimaGeneration() {},
        async recallAnima() { calls.recalled++; return { text: '之前约定不擅自拆信。', status: 'success', source: 'fixture-memory' }; },
        skipNextAnimaRecall() { return () => {}; }, invalidateAnimaRoundCache() { calls.invalidated++; },
    };
    const fetchImpl = async (url, options) => {
        calls.planner.push({ url, options, body: JSON.parse(options.body) });
        if (fetchMode === 'error') return new Response('server private-key details', { status: 503 });
        if (fetchMode === 'pending') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: xml } }] }));
    };
    const view = { render() {}, open() {}, close() {}, destroy() {} };
    const plugin = await createPlugin({ getContext: () => ctx, builtin, writerRules: '按当前大纲扩写中文正文。', anima, viewFactory: () => view, fetchImpl });
    ctx.generate = async type => {
        let aborted = false;
        await events.emit('GENERATION_STARTED', type, {}, false);
        if (input.value) { ctx.chat.push({ name: ctx.name1, is_user: true, mes: input.value }); input.value = ''; }
        await plugin.intercept(ctx.chat, 32000, () => { aborted = true; calls.aborted++; }, type);
        if (!aborted) {
            const prompt = ctx.extensionPrompts[INJECTION_KEY];
            assert.ok(prompt && (!prompt.filter || await prompt.filter()), 'Writer requires the valid this-turn outline');
            calls.writer.push({ prompt: prompt.value, model: ctx.chatCompletionSettings.openai_model });
            ctx.chat.push({ name: ctx.name2, is_user: false, mes: '林澄接过信，暂时没有拆开。' });
        }
        await events.emit('GENERATION_ENDED');
    };
    t.after(() => {
        plugin.destroy();
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    return { ctx, input, plugin, calls, events, storage };
}

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
