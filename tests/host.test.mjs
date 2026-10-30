import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INJECTION_KEY, DEFAULT_SETTINGS, cleanSettings, describeInjection, proseTarget, assertChat, storySnapshot, collectPlanningContext, createSTTransport, inertHostText, injectForTurn, clearInjection } from '../lib/host.js';

function context() {
    const ctx = {
        chatId: 'scene-a', characterId: 0, groupId: null, name1: '苏青', name2: '林澄',
        characters: [{ name: '林澄', description: '重视约定', personality: '谨慎', scenario: '门口', data: { description: '重视约定', personality: '谨慎', scenario: '门口', mes_example: '示例对白' } }],
        chat: [{ name: '林澄', is_user: false, mes: '他停在门口。' }],
        powerUserSettings: { persona_description: '苏青寡言' },
        chatCompletionSettings: { openai_max_context: 32000, openai_model: 'main-writer' },
        chatMetadata: {}, extensionPrompts: {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-token' }),
        getWorldInfoPrompt: async () => ({ worldInfoBefore: '世界背景', worldInfoAfter: '世界设定' }),
    };
    ctx.getCurrentChatId = () => ctx.chatId;
    ctx.setExtensionPrompt = (key, value, position, depth, scan, role, filter) => {
        ctx.extensionPrompts[key] = { value, position, depth, scan, role, filter };
    };
    return ctx;
}

test('settings keep only supported non-secret fields and valid modes', () => {
    const saved = cleanSettings({ apiKey: 'do-not-save', secret: 'also-secret', model: 'planner', autoOnSend: true, mode: 'unknown', extra: 'unsupported' });
    assert.equal(saved.model, 'planner');
    assert.equal(saved.autoOnSend, true);
    assert.equal(saved.mode, 'review');
    assert.equal(saved.apiKey, undefined);
    assert.equal(saved.extra, undefined);
    assert.equal(cleanSettings({ autoOnSend: 'true' }).autoOnSend, false);
    assert.equal(DEFAULT_SETTINGS.minWords, '');
    assert.equal(DEFAULT_SETTINGS.maxWords, '');
});

test('prose target validates ranges and keeps absent targets unspecified', () => {
    assert.equal(proseTarget({}), '');
    assert.match(proseTarget({ minWords: '1500', maxWords: '2000' }), /1500—2000/);
    assert.match(proseTarget({ minWords: 500 }), /至少 500/);
    assert.match(proseTarget({ maxWords: 900 }), /最多 900/);
    for (const settings of [{ minWords: 0 }, { maxWords: -1 }, { minWords: 1.5 }, { maxWords: 'NaN' }, { minWords: 'Infinity' }, { minWords: 2001, maxWords: 2000 }, { maxWords: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => proseTarget(settings));
});

test('pace settings are retired: pacing is controlled by preset tier entries only', () => {
    assert.equal(DEFAULT_SETTINGS.storyPace, undefined);
    assert.equal(DEFAULT_SETTINGS.relationshipPace, undefined);
    assert.equal(cleanSettings({ storyPace: 'fast', relationshipPace: 'slow' }).storyPace, undefined);
    const legacy = proseTarget({ minWords: '1500', maxWords: '2000' });
    assert.equal(proseTarget({ storyPace: 'fast' }), '');
    assert.equal(proseTarget({ storyPace: 'fast', relationshipPace: 'slow' }), '');
    assert.equal(proseTarget({ minWords: '1500', maxWords: '2000', storyPace: 'fast', relationshipPace: 'slow' }), legacy);
    const ctx = context(); injectForTurn(ctx, { xml: '<content>大纲</content>', target: legacy });
    assert.ok(ctx.extensionPrompts[INJECTION_KEY].value.includes('1500—2000'));
    assert.doesNotMatch(ctx.extensionPrompts[INJECTION_KEY].value, /本轮剧情推进|本轮感情推进/);
});

test('ST transport uses only independent endpoint/key and authenticated same-origin forwarding', async () => {
    const ctx = context();
    const saved = JSON.stringify(ctx.chatCompletionSettings);
    Object.defineProperty(ctx, 'secretState', { get() { throw new Error('Main secret must never be read'); } });
    Object.defineProperty(ctx, 'apiKey', { get() { throw new Error('Main key must never be read'); } });
    let call;
    const transport = createSTTransport(() => ctx, async (url, options) => { call = { url, options }; return new Response('{}'); });
    const controller = new AbortController();
    await transport({ url: 'https://relay.example/api/v1/chat/completions', headers: { Authorization: 'Bearer independent-key' }, body: { model: 'planner', messages: [{ role: 'user', content: 'input' }], stream: false, chat_completion_source: 'wrong', reverse_proxy: 'wrong', proxy_password: 'wrong' }, signal: controller.signal });
    assert.equal(call.url, '/api/backends/chat-completions/generate');
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.options.signal, controller.signal);
    assert.equal(call.options.headers['X-CSRF-Token'], 'csrf-token');
    assert.equal(call.options.headers.Authorization, undefined);
    const body = JSON.parse(call.options.body);
    assert.equal(body.chat_completion_source, 'openai');
    assert.equal(body.reverse_proxy, 'https://relay.example/api/v1');
    assert.equal(body.proxy_password, 'independent-key');
    assert.equal(body.model, 'planner');
    assert.equal(JSON.stringify(ctx.chatCompletionSettings), saved);
    await transport({ url: 'https://relay.example/v1/chat/completions', headers: {}, body: { model: 'planner', messages: [] } });
    const withoutKey = JSON.parse(call.options.body);
    assert.equal(withoutKey.proxy_password, '');
    assert.equal(withoutKey.reverse_proxy, 'https://relay.example/v1');
});

test('generated macro-looking text remains inert even with repeated left braces', () => {
    for (const text of ['{{setvar::x::bad}}', '{{{setvar::x::bad}}}', '{{{{setglobalvar::x::bad}}}}', '{'.repeat(30) + 'setvar::x::bad}}', '普通文本和{{user}}']) {
        const safe = inertHostText(text);
        assert.ok(!safe.includes('{{'), `Unsafe macro opening survived: ${JSON.stringify(safe)}`);
        assert.equal(safe.replaceAll('\u200b', ''), text);
    }
});

test('temporary injection excludes WI scanning, passes a validity filter and never appends chat', () => {
    const ctx = context();
    const before = JSON.stringify(ctx.chat);
    const valid = () => true;
    ctx.extensionPrompts.other = { value: 'keep' };
    injectForTurn(ctx, { xml: '<content>{{setvar::x::bad}}</content>', memory: '记忆{{getvar::x}}', target: '1500—2000字', writerRules: '按大纲扩写', valid });
    const prompt = ctx.extensionPrompts[INJECTION_KEY];
    assert.equal(prompt.scan, false);
    assert.equal(prompt.position, 1);
    assert.equal(prompt.depth, 0);
    assert.equal(prompt.role, 0);
    assert.equal(prompt.filter, valid);
    assert.ok(prompt.value.includes('1500—2000字'));
    assert.ok(!prompt.value.includes('{{'));
    assert.equal(JSON.stringify(ctx.chat), before);
    clearInjection(ctx);
    assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
    assert.equal(ctx.extensionPrompts.other.value, 'keep');
    clearInjection(ctx);
    assert.equal(JSON.stringify(ctx.chat), before);
});

test('writer handoff follows the outline and keeps target, memory and legacy drafts intact', () => {
    const writerRules = fs.readFileSync(new URL('../presets/writer.txt', import.meta.url), 'utf8');
    for (const xml of [
        '<content><plot>世界背景：旧城。\n本轮方向：递信。</plot><characters>不涉及</characters><segments><segment index="1">递信。</segment></segments><end_state>本轮状态：信已交出。\n必须遵守：信封保持封闭。</end_state></content>',
        '<content><plot>递信。</plot><characters>不涉及</characters><segments><segment index="1">递信。</segment></segments><end_state>信已交出。</end_state></content>',
    ]) {
        const ctx = context();
        const before = JSON.stringify(ctx.chat);
        const memory = '旧信的封口图案：{{getvar::seal}}';
        const target = '1500—2000字';
        injectForTurn(ctx, { xml, memory, target, writerRules });
        const text = ctx.extensionPrompts[INJECTION_KEY].value;
        for (const value of [xml, memory, target, writerRules]) assert.equal(text.split(inertHostText(value)).length - 1, 1);
        assert.ok(text.indexOf(inertHostText(memory)) < text.indexOf(xml));
        assert.ok(text.indexOf('【正文执行规则】') > text.indexOf('</content>'));
        assert.ok(text.endsWith(inertHostText(writerRules)));
        assert.ok(!text.includes('{{'));
        assert.equal(JSON.stringify(ctx.chat), before);
    }
});

test('injection options map to the official ST enums while preserving scan isolation and filter', () => {
    const ctx = context(), valid = () => false;
    for (const [position, expectedPosition] of [['before_prompt', 2], ['in_prompt', 0], ['in_chat', 1]]) {
        for (const [role, expectedRole] of [['system', 0], ['user', 1], ['assistant', 2]]) {
            injectForTurn(ctx, { xml: '<content>大纲</content>', valid, injection: { position, depth: '3', role } });
            const result = ctx.extensionPrompts[INJECTION_KEY];
            assert.equal(result.position, expectedPosition); assert.equal(result.depth, 3); assert.equal(result.role, expectedRole);
            assert.equal(result.scan, false); assert.equal(result.filter, valid);
        }
    }
});

test('invalid direct injection options fail before modifying the host prompt', () => {
    const ctx = context();
    for (const injection of [{ position: 'before_chat' }, { position: '__proto__' }, { role: 'developer' }, { depth: -1 }, { depth: 1.5 }, { depth: '1e2' }, { depth: 'NaN' }, { depth: '' }, { depth: 10001 }, { depth: Number.MAX_SAFE_INTEGER + 1 }]) {
        assert.throws(() => injectForTurn(ctx, { xml: '<content>x</content>', injection }));
        assert.equal(ctx.extensionPrompts[INJECTION_KEY], undefined);
    }
});

test('stored injection settings are normalized to supported defaults and described accurately', () => {
    const defaults = cleanSettings({ injectionPosition: 'bad', injectionDepth: '-1', injectionRole: 'bad' });
    assert.equal(defaults.injectionPosition, 'in_chat'); assert.equal(defaults.injectionDepth, '0'); assert.equal(defaults.injectionRole, 'system');
    const custom = cleanSettings({ injectionPosition: 'before_prompt', injectionDepth: '003', injectionRole: 'user' });
    assert.equal(custom.injectionDepth, '3'); assert.equal(custom.injectionPosition, 'before_prompt'); assert.equal(custom.injectionRole, 'user');
    assert.match(describeInjection(), /IN_CHAT.*深度 0.*最新消息之后.*系统/);
    assert.match(describeInjection(custom), /BEFORE_PROMPT.*不按聊天深度.*user/);
    assert.match(describeInjection({ injectionPosition: 'in_prompt' }), /角色\/场景提示之后.*IN_PROMPT/);
    assert.match(describeInjection({ injectionDepth: '2', injectionRole: 'assistant' }), /深度 2.*向前计数.*助手/);
});

test('story fingerprint is preserved only when dropping the exact newly submitted user input', () => {
    const ctx = context();
    const before = storySnapshot(ctx);
    ctx.chat.push({ name: '苏青', is_user: true, mes: '她递出信。' });
    assert.equal(storySnapshot(ctx, { dropLastInput: '她递出信。' }), before);
    assert.notEqual(storySnapshot(ctx), before);
    assert.throws(() => storySnapshot(ctx, { dropLastInput: '不同输入' }));
    ctx.chat.at(-1).is_user = false;
    assert.throws(() => storySnapshot(ctx, { dropLastInput: '她递出信。' }));
});

test('story fingerprint notices card, persona, history and per-chat scenario overrides', () => {
    for (const mutate of [ctx => { ctx.characters[0].data.description = '新设定'; }, ctx => { ctx.powerUserSettings.persona_description = '新人格'; }, ctx => { ctx.chat[0].mes = '改写历史'; }, ctx => { ctx.chatId = 'scene-b'; }, ctx => { ctx.chatMetadata.scenario = '港口'; }, ctx => { ctx.chatMetadata.mes_example = '新的对白习惯'; }]) {
        const ctx = context();
        const before = storySnapshot(ctx);
        mutate(ctx);
        assert.notEqual(storySnapshot(ctx), before);
    }
});

test('planning context scans the current input once, retains all returned WI placements, and leaves chat intact', async () => {
    const ctx = context();
    ctx.chat.push({ name: '苏青', is_user: true, mes: '她递出信。' });
    const before = JSON.stringify(ctx.chat);
    let args;
    ctx.getWorldInfoPrompt = async (...input) => {
        args = input;
        return { worldInfoBefore: 'before', worldInfoAfter: 'after', worldInfoDepth: [{ depth: 3, entries: ['depth-entry'] }], worldInfoExamples: [{ content: 'example-entry' }], anBefore: ['note-before'], anAfter: ['note-after'], outletEntries: { plot: ['outlet-entry'] } };
    };
    ctx.getCharacterCardFields = () => ({ description: '处理后的读卡内容', persona: '有效人格', scenario: '当前场景', mesExamples: '卡对白', charDepthPrompt: '深度提示', creatorNotes: '作者说明' });
    const result = await collectPlanningContext(ctx, '她递出信。', { inputAlreadyInChat: true });
    assert.equal(args[0].filter(x => x.includes('她递出信。')).length, 1);
    assert.equal(args[0][0], '苏青: 她递出信。');
    assert.equal(args[1], 32000);
    assert.equal(args[2], true);
    assert.equal(args[3].characterDepthPrompt, '深度提示');
    assert.equal(result.chatHistory.length, 1);
    assert.equal(result.currentInput, '她递出信。');
    assert.equal(result.charDescription, '处理后的读卡内容');
    assert.equal(result.dialogueExamples, '卡对白');
    for (const entry of ['after', 'depth-entry', 'example-entry', 'note-before', 'note-after', 'outlet-entry']) assert.ok(result.worldInfoAfter.includes(entry));
    assert.equal(JSON.stringify(ctx.chat), before);
    await assert.rejects(collectPlanningContext(ctx, '更改后的输入', { inputAlreadyInChat: true }));
});

test('planning-only WI scan restores author-note side effects on both success and failure', async () => {
    for (const fail of [false, true]) {
        const ctx = context();
        const original = { value: '原作者注释', position: 1, depth: 4, scan: true, role: 0, filter: null };
        ctx.extensionPrompts['2_floating_prompt'] = { ...original };
        ctx.getWorldInfoPrompt = async () => {
            ctx.setExtensionPrompt('2_floating_prompt', 'WI前置\n原作者注释\nWI后置', 1, 4, true, 0, null);
            if (fail) throw new Error('scan failed');
            return { worldInfoBefore: '', worldInfoAfter: '', anBefore: ['WI前置'], anAfter: ['WI后置'] };
        };
        if (fail) await assert.rejects(collectPlanningContext(ctx, 'input'), /scan failed/);
        else await collectPlanningContext(ctx, 'input');
        assert.deepEqual(ctx.extensionPrompts['2_floating_prompt'], original);
    }
});

test('unsupported chats and missing worldbook API fail explicitly', async () => {
    const ctx = context();
    ctx.groupId = 'group';
    assert.throws(() => assertChat(ctx), /群聊/);
    ctx.groupId = null;
    delete ctx.getWorldInfoPrompt;
    await assert.rejects(collectPlanningContext(ctx, 'input'), /世界书/);
});
