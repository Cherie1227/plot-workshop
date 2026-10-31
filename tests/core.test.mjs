import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePreset, compilePreset, exportPreset } from '../lib/preset.js';
import { parseContent, snapshotHash } from '../lib/content.js';
import { normalizeEndpoint, redactSecrets, requestPlan } from '../lib/planner.js';

const validXml = '<content><plot>接过信，仍保留戒备。</plot><characters><character name="林澄"><emotion>戒备略有缓和。</emotion><response>接信并询问来意。</response></character></characters><segments><segment index="1">第三人称：复述递信动作。林澄看到封口仍然完好，接过信，问对方是否看过内容。语气是试探，未指责。</segment></segments><end_state>信未拆开，等待回应。</end_state></content>';
const baseContext = { user: '苏青', char: '林澄', currentInput: '她递出信。', animaMemory: '此前曾约定不擅自拆信。', animaStatus: 'success' };
function makePreset(prompts, order = prompts.map(p => ({ identifier: p.identifier, enabled: true })), extra = {}) {
    return normalizePreset({ prompts, prompt_order: [{ character_id: 100001, order }], ...extra });
}
function prompt(identifier, content, extra = {}) { return { identifier, name: identifier, content, role: 'system', ...extra }; }

test('imports full and wrapped presets; preserves selected order and ignores unlisted entries', () => {
    const data = { prompts: [prompt('unused', 'SHOULD NOT SEND'), prompt('two', '第二条'), prompt('one', '第一条')], prompt_order: [{ identifier: 'one', enabled: true }, { identifier: 'two', enabled: false }] };
    const p = normalizePreset({ version: 1, type: 'full', data });
    const c = compilePreset(p, { context: baseContext });
    assert.equal(c.messages[0].content, '第一条');
    assert.ok(!JSON.stringify(c.messages).includes('第二条'));
    assert.ok(!JSON.stringify(c.messages).includes('SHOULD NOT SEND'));
});

test('Prompt Manager exports may omit built-in marker definitions; never inherit missing main prose', () => {
    const p = normalizePreset({ version: 1, type: 'full', data: { prompts: [prompt('custom', '规划')], prompt_order: [{ identifier: 'main', enabled: true }, { identifier: 'charDescription', enabled: true }, { identifier: 'custom', enabled: true }] } });
    assert.equal(p.prompts.find(x => x.identifier === 'charDescription').marker, true);
    assert.equal(p.prompts.find(x => x.identifier === 'main').content, '');
    assert.ok(p.warnings.some(w => w.includes('main')));
    const result = compilePreset(p, { context: { ...baseContext, charDescription: '人设' } });
    assert.ok(result.messages.some(m => m.content.includes('人设')));
});

test('local/global variables remain isolated and evaluate in active order, including nested macros', () => {
    const variables = { state: 'external' }, globalVariables = { g: 'external-global' };
    const p = makePreset([
        prompt('set', '{{setvar::state::{{char}}的信}}{{setglobalvar::g::新值}}'),
        prompt('disabled', '{{setvar::state::错误}}'),
        prompt('get', '{{user}}读取{{getvar::state}}/{{getglobalvar::g}}'),
    ], [{ identifier: 'set', enabled: true }, { identifier: 'disabled', enabled: false }, { identifier: 'get', enabled: true }]);
    const result = compilePreset(p, { context: baseContext, variables, globalVariables });
    assert.equal(result.messages[0].content, '苏青读取林澄的信/新值');
    assert.equal(result.variables.state, '林澄的信');
    assert.deepEqual(variables, { state: 'external' });
    assert.deepEqual(globalVariables, { g: 'external-global' });
});

test('group switch prevents its variable assignments without changing per-entry state', () => {
    const p = makePreset([prompt('set', '{{setvar::x::wrong}}'), prompt('read', '值={{getvar::x}}')], undefined, {
        extensions: { baibaiToolkit: { presetPromptGroups: { groups: [{ id: 'off', name: '关闭组', enabled: false }], prompts: { set: { groupId: 'off' } } } } },
    });
    assert.equal(compilePreset(p, { context: baseContext, variables: { x: 'right' } }).messages[0].content, '值=right');
    assert.equal(p.order[0].enabled, true);
    p.groups[0].enabled = true;
    assert.equal(compilePreset(p, { context: baseContext }).messages[0].content, '值=wrong');
});

test('only preset text runs supported macros; history and memory remain literal', () => {
    const p = makePreset([prompt('history', '', { identifier: 'chatHistory', marker: true }), prompt('read', '当前={{getvar::x}}')]);
    const result = compilePreset(p, { context: { ...baseContext, chatHistory: [{ role: 'user', content: '{{setvar::x::injected}}' }], animaMemory: '{{unknown}}' }, variables: { x: 'safe' } });
    assert.equal(result.messages.at(-1).content, '当前=safe');
    assert.ok(result.messages.some(m => m.content === '{{setvar::x::injected}}'));
    assert.ok(result.messages.some(m => m.content.includes('{{unknown}}')));
});

test('unknown/malformed macros and unsupported ST injection fail before sending', () => {
    for (const content of ['{{random::a::b}}', '{{getvar::x', 'bad}}']) {
        assert.throws(() => compilePreset(makePreset([prompt('bad', content)]), { context: baseContext }), /宏/);
    }
    assert.throws(() => compilePreset(makePreset([prompt('deep', 'text', { injection_position: 1 })]), { context: baseContext }), { code: 'INJECTION_UNSUPPORTED' });
});

test('comment/trim/noop macros do not execute nested assignments; lastUserMessage is current draft', () => {
    const p = makePreset([prompt('comment', 'A\n\n{{trim}}\r\nB{{noop}}{{// ignored {{setvar::x::bad}} {{unknown}}}}\n{{ // }}hidden {{setvar::x::also-bad}}{{ /// }}{{getvar::x}}/{{lastUserMessage}}')]);
    const result = compilePreset(p, { context: { ...baseContext, currentInput: 'current draft' }, variables: { x: 'safe' } });
    assert.equal(result.messages[0].content, 'AB\nsafe/current draft');
    assert.equal(result.variables.x, 'safe');
    const spaces = compilePreset(makePreset([prompt('spaces', 'A \n{{trim}}\n B')]), { context: baseContext });
    assert.equal(spaces.messages[0].content, 'A  B');
});

test('each compilation requires actual Anima outcome and current input', () => {
    const p = makePreset([prompt('main', '计划')]);
    assert.throws(() => compilePreset(p, { context: { ...baseContext, animaStatus: 'failed' } }), { code: 'ANIMA_REQUIRED' });
    assert.throws(() => compilePreset(p, { context: { ...baseContext, currentInput: undefined } }), { code: 'CURRENT_INPUT_MISSING' });
    assert.throws(() => compilePreset(p, { context: { ...baseContext, animaStatus: 'success', animaMemory: '' } }), { code: 'ANIMA_REQUIRED' });
    const result = compilePreset(p, { context: { ...baseContext, animaStatus: 'empty', animaMemory: '' }, targetLength: '正文 1500—2000 字，不包含标题。' });
    assert.deepEqual(result.entries.find(entry => entry.id === 'anima_memory').messages, []);
    assert.ok(!result.messages.some(m => m.content.includes('未找到相关记忆')));
    assert.ok(result.messages.some(m => m.content.includes('正文 1500—2000 字') && m.content.includes('主模型扩写正文')));
});

test('export round-trip retains editable order/groups while excluding script/provider data', () => {
    const p = makePreset([prompt('a', '内容'), prompt('b', '禁用')], [{ identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }], {
        api_key: 'secret', extensions: { evilScript: { code: 'globalThis.pwned=true' }, baibaiToolkit: { presetPromptGroups: { groups: [{ id: 'g', name: '组', enabled: false }], prompts: { a: { groupId: 'g' } } } } },
    });
    const output = exportPreset(p);
    const roundTrip = normalizePreset(output);
    assert.deepEqual(roundTrip.order, p.order);
    assert.deepEqual(roundTrip.groups, p.groups);
    assert.equal(roundTrip.promptGroups.a, 'g');
    assert.ok(!JSON.stringify(output).includes('secret'));
    assert.ok(!JSON.stringify(output).includes('pwned'));
});

test('extracts exactly one XML content and excludes external analysis', () => {
    const result = parseContent(`这里是外部分析，不得注入。\n${validXml}\n分析结束。`);
    assert.equal(result.characters[0].name, '林澄');
    assert.equal(result.segments[0].index, 1);
    assert.ok(!result.xml.includes('外部分析'));
    assert.equal(parseContent(result.xml).xml, result.xml);
});

test('plain tag mentions in surrounding analysis do not count as another outline', () => {
    const expected = parseContent(validXml);
    for (const mention of ['使用 <content> 标签。', '使用 `<content>` 和 `</content>`。', '<think>交付 <content>…</content> 格式。</think>', '<think>最终输出 <content></think>', '说明结束于 </content>。']) {
        assert.deepEqual(parseContent(`${mention}\n${validXml}\n${mention}`), expected);
    }
    assert.deepEqual(parseContent(`\`\`\`xml\n${validXml}\n\`\`\``), expected);
});

test('missing, truncated and competing structured outlines have distinct errors', () => {
    for (const text of ['', '只有普通剧情文字。', '<CONTENT>大小写不符</CONTENT>', '&lt;content&gt;标签被转义&lt;/content&gt;']) {
        assert.throws(() => parseContent(text), { code: 'CONTENT_MISSING' });
    }
    for (const text of ['<content', '<content>', '<content><plot>未完成', validXml.slice(0, -10)]) {
        assert.throws(() => parseContent(text), { code: 'CONTENT_TRUNCATED' });
    }
    const partial = '<content><plot>第二份未完成';
    for (const text of [validXml + validXml, validXml + partial, '<content><plot>字段不全</plot></content>' + validXml]) {
        assert.throws(() => parseContent(text), { code: 'CONTENT_MULTIPLE' });
    }
});

test('extraction never salvages nested content or relaxes the XML schema', () => {
    for (const text of [`<content>${validXml}</content>`, `<content><plot>外层未完成${validXml}`, `<content><!--${validXml}--></content>`, `<content><![CDATA[${validXml}]]></content>`, validXml.replace('接过信，仍保留戒备。', '<content>嵌套标签</content>')]) {
        assert.throws(() => parseContent(text), { code: 'CONTENT_INVALID' });
    }
    for (const text of [validXml.replace('<content>', '<content extra="x">'), validXml.replace('<plot>', '<plot extra="x">'), validXml.replace('</plot>', '&bad;</plot>')]) {
        assert.throws(() => parseContent(`说明提到 <content>。\n${text}`), { code: 'CONTENT_INVALID' });
    }
    assert.throws(() => parseContent('<content></content>'), { code: 'CONTENT_INVALID' });
});

test('rejects truncated/multiple output, empty/missing fields and skipped segment indices', () => {
    assert.throws(() => parseContent(validXml.slice(0, -10)), { code: 'CONTENT_TRUNCATED' });
    assert.throws(() => parseContent(validXml + validXml), { code: 'CONTENT_MULTIPLE' });
    assert.throws(() => parseContent(validXml.replace('<plot>接过信，仍保留戒备。</plot>', '<plot></plot>')));
    assert.throws(() => parseContent(validXml.replace('index="1"', 'index="2"')));
    assert.throws(() => parseContent(validXml.replace('<emotion>', '<response>')));
    assert.throws(() => parseContent(validXml.replace('<plot>', '<plot bad="1">')));
    assert.throws(() => parseContent(validXml.replace('</segments>', '</segments><extra>额外字段</extra>')));
});

test('supports escaped XML entities; rejects active markup, DTD and malformed entities', () => {
    const escaped = validXml.replace('接过信，仍保留戒备。', 'A &amp; B &lt; C &#x4e2d;');
    const result = parseContent(escaped);
    assert.equal(result.plot, 'A & B < C 中');
    assert.ok(result.xml.includes('A &amp; B &lt; C 中'));
    for (const replacement of ['<script>bad</script>', 'A & B', '&unknown;', '&#0;', '<![CDATA[test]]>']) {
        assert.throws(() => parseContent(validXml.replace('接过信，仍保留戒备。', replacement)));
    }
    assert.throws(() => parseContent(validXml.replace('<plot>', '<!DOCTYPE content><plot>')));
});

test('snapshot hashes are key-order independent but identify altered input, history and chat', async () => {
    const a = { chatId: 'a', history: ['old'], currentInput: 'input' };
    assert.equal(await snapshotHash(a), await snapshotHash({ currentInput: 'input', history: ['old'], chatId: 'a' }));
    for (const change of [{ chatId: 'b' }, { currentInput: 'edited' }, { history: ['new'] }]) assert.notEqual(await snapshotHash(a), await snapshotHash({ ...a, ...change }));
});

test('LAN HTTP SHA-256 fallback matches native digest across ASCII, Unicode and multiple blocks', async () => {
    for (const snapshot of ['', {}, { input: '中文🙂', history: [1, 2, 3] }, 'x'.repeat(55), 'x'.repeat(64), { long: '剧情'.repeat(4096) }]) {
        assert.equal(await snapshotHash(snapshot, { crypto: null }), await snapshotHash(snapshot));
    }
});

test('normalizes compatible endpoints without allowing credentials/query secrets', () => {
    assert.equal(normalizeEndpoint('https://example.com'), 'https://example.com/v1/chat/completions');
    assert.equal(normalizeEndpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
    assert.equal(normalizeEndpoint('https://example.com/api/chat/completions'), 'https://example.com/api/chat/completions');
    for (const value of ['https://u:pw@example.com', 'https://example.com?key=secret', 'file:///tmp/key', 'not a url']) assert.throws(() => normalizeEndpoint(value), { code: 'ENDPOINT_INVALID' });
});

test('planner sends separate explicit key and isolates returned reasoning from the outline', async () => {
    let captured;
    const result = await requestPlan({ baseUrl: 'https://example.com/v1', apiKey: 'private-key', model: 'planner', messages: [{ role: 'user', content: 'input' }], temperature: 0, maxTokens: 4000, transport: async request => {
        captured = request;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: validXml, reasoning_content: 'private analysis' } }], usage: { total_tokens: 12 } }));
    } });
    assert.equal(captured.headers.Authorization, 'Bearer private-key');
    assert.equal(captured.body.temperature, 0);
    assert.equal(captured.body.max_tokens, 4000);
    assert.equal(result.usage.total_tokens, 12);
    assert.equal(result.analysis.reasoning, 'private analysis');
    for (const field of ['xml', 'plot', 'characters', 'segments', 'endState']) {
        assert.ok(!JSON.stringify(result[field] ?? '').includes('private analysis'));
    }
});

test('planner rejects truncated API responses and does not expose echoed HTTP errors', async () => {
    const options = { baseUrl: 'https://example.com', model: 'planner', messages: [{ role: 'user', content: 'x' }], apiKey: 'sensitive-key' };
    await assert.rejects(requestPlan({ ...options, transport: async () => new Response(JSON.stringify({ error: 'sensitive-key' }), { status: 401 }) }), error => error.code === 'HTTP_ERROR' && !error.message.includes('sensitive-key'));
    await assert.rejects(requestPlan({ ...options, transport: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: validXml } }] })) }), { code: 'OUTPUT_TRUNCATED' });
    await assert.rejects(requestPlan({ ...options, transport: async () => { throw new Error('request failed with sensitive-key Authorization=supersecret'); } }), error => !error.message.includes('sensitive-key') && !error.message.includes('supersecret'));
    assert.ok(!redactSecrets('Bearer aaa sk-testkey token=ttt https://user:pw@example.com', []).includes('aaa'));
});

test('timeout and abort stop waiting even when a custom transport ignores its signal', async () => {
    const options = { baseUrl: 'https://example.com', model: 'planner', messages: [{ role: 'user', content: 'x' }], transport: () => new Promise(() => {}) };
    await assert.rejects(requestPlan({ ...options, timeoutMs: 10 }), { code: 'TIMEOUT' });
    const controller = new AbortController();
    const pending = requestPlan({ ...options, signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
});

test('both complete bundled presets compile and retain their own output protocols', () => {
    const context = { ...baseContext, worldInfoBefore: '', personaDescription: '苏青寡言。', charDescription: '林澄重视约定。', charPersonality: '', scenario: '门口。', worldInfoAfter: '', dialogueExamples: '', chatHistory: [] };
    const compiled = {};
    for (const [version, filename, contract] of [[1, 'default.json', 'content-v1.2'], [2, 'default-v2.json', 'content-v2.0']]) {
        const raw = JSON.parse(fs.readFileSync(new URL(`../presets/${filename}`, import.meta.url), 'utf8'));
        assert.equal(raw.extensions.dual_model_outline_preset.output_contract, contract);
        const p = normalizePreset(raw);
        const result = compilePreset(p, { context, targetLength: '1500—2000 字' });
        assert.ok(!JSON.stringify(result.messages).includes('〔自行填写或删除〕'));
        compiled[version] = result.messages.map(message => message.content).join('\n');
        assert.ok(result.messages.some(x => x.content.includes('本轮共享的最终正文目标')));
    }
    for (const tag of ['content', 'plot', 'characters', 'character', 'emotion', 'response', 'segments', 'segment', 'end_state']) {
        assert.ok(compiled[1].includes(`<${tag}`)); assert.ok(compiled[1].includes(`</${tag}>`));
    }
    assert.doesNotMatch(compiled[1], /<direction>|<beats>|<anchors>/);
    for (const tag of ['content', 'direction', 'beats', 'beat', 'event', 'emotion', 'choice', 'anchors', 'end_state']) {
        assert.ok(compiled[2].includes(`<${tag}`)); assert.ok(compiled[2].includes(`</${tag}>`));
    }
});

test('both bundled templates round-trip independently', () => {
    const context = { ...baseContext, worldInfoBefore: '旧城沿用驿站传信。', personaDescription: '苏青寡言。', charDescription: '林澄重视约定。', charPersonality: '', scenario: '门口。', worldInfoAfter: '', dialogueExamples: '', chatHistory: [] };
    const expectations = [[1, 'default.json', 'content-v1.2'], [2, 'default-v2.json', 'content-v2.0']];
    for (const [version, filename, contract] of expectations) {
        const p = normalizePreset(fs.readFileSync(new URL(`../presets/${filename}`, import.meta.url), 'utf8'));
        const { messages } = compilePreset(p, { context });
        const template = messages.at(-1).content.match(/【固定模板开始】\s*([\s\S]*?)\s*【固定模板结束】/)[1];
        const plan = parseContent(template);
        assert.equal(plan.version, version);
        assert.equal(plan.contract, contract);
        assert.deepEqual(parseContent(plan.xml), plan);
        if (version === 2) {
            assert.equal(plan.plot, plan.direction);
            assert.equal(plan.beats.length, 1);
            assert.equal(plan.segments, plan.beats);
            assert.equal(plan.characters.length, 0);
            assert.ok(!plan.endState.includes('必须遵守'));
        } else {
            assert.match(plan.plot, /^世界背景：/);
            assert.equal(plan.segments.length, 1);
            assert.equal(plan.characters.length, 1);
        }
    }
    assert.equal(parseContent(validXml).version, 1);
    assert.equal(parseContent(validXml).plot, '接过信，仍保留戒备。');
});

test('content-v2 allows optional emotion and choice but rejects malformed beat shapes', () => {
    for (const fields of ['<event>雨继续下。</event>', '<event>店主决定打烊。</event><choice>常客留下帮忙。</choice>']) {
        const xml = `<content><direction>雨夜各有去处。</direction><beats><beat index="1">${fields}</beat></beats><anchors>无</anchors><end_state>众人开始各自行动。</end_state></content>`;
        const plan = parseContent(xml);
        assert.equal(plan.beats.length, 1);
        assert.equal(parseContent(plan.xml).xml, plan.xml);
    }
    const wrap = fields => `<content><direction>方向</direction><beats><beat index="1">${fields}</beat></beats><anchors>无</anchors><end_state>状态</end_state></content>`;
    assert.throws(() => parseContent(wrap('<emotion>先写情绪。</emotion><event>后写事件。</event>')), /beat/);
    assert.throws(() => parseContent(wrap('<event>事件。</event><extra>额外字段。</extra>')), /beat/);
    assert.throws(() => parseContent(wrap('<event></event>')), /event/);
});

test('same ensemble scene keeps independent cast causality with fewer locked fields in content-v2', () => {
    const legacy = '<content><plot>世界背景：雨夜便利店。本轮方向：苏青躲雨时，店主林澄、店员唐雨和外卖员许川各自处理事务并发生交汇。</plot><characters><character name="苏青"><emotion>从疲惫转为愿意参与。</emotion><response>留下并主动提出帮忙。</response></character><character name="林澄"><emotion>从忙碌转为抱歉。</emotion><response>先处理延误订单。</response></character><character name="唐雨"><emotion>因录错订单而紧张。</emotion><response>向店主承认错误。</response></character><character name="许川"><emotion>担心超时。</emotion><response>取餐后继续配送。</response></character></characters><segments><segment index="1">主体与事件：复述苏青进店躲雨，唐雨拿着订单来找林澄。判断与情绪：苏青疲惫，唐雨紧张。回应与对白：唐雨承认自己录错订单，林澄安慰并核对。信息变化：林澄得知延误原因。衔接：林澄离开收银台处理订单。</segment><segment index="2">主体与事件：许川进店取延误订单。判断与情绪：许川担心超时，苏青从旁观转为愿意帮忙。回应与对白：苏青主动提出帮忙整理，林澄向许川致歉。信息变化：苏青得知订单延误。衔接：林澄把餐交给许川。</segment><segment index="3">主体与事件：许川继续配送，唐雨重新核对订单。判断与情绪：唐雨仍然内疚。回应与对白：林澄让唐雨继续核对。信息变化：无。衔接：林澄把备用伞递给苏青后转身。</segment></segments><end_state>本轮状态：许川离开，唐雨继续核对，苏青留下帮忙，最后以林澄递伞后转身收尾。</end_state></content>';
    const v2 = '<content><direction>苏青进店躲雨时，店主林澄、店员唐雨与外卖员许川各自的事务在便利店交汇。</direction><beats><beat index="1"><event>输入已有：苏青进店躲雨。唐雨主动向林澄承认录错订单，林澄必须暂时离开收银台核对。</event><emotion>唐雨从侥幸转为紧张，苏青仍疲惫。</emotion></beat><beat index="2"><event>许川来取延误订单并担心超时，苏青因此看见这家店的实际运转。</event><emotion>苏青从旁观转为愿意参与。</emotion><choice>苏青主动留下帮忙，林澄先向许川交付订单。</choice></beat><beat index="3"><event>许川继续配送，唐雨留下重新核对后续订单。</event></beat></beats><anchors>只有林澄与唐雨知道录错订单的人；许川只知道订单延误。各人对白沿用既有口吻。</anchors><end_state>许川恢复配送，唐雨开始修正错误，苏青留下帮忙；躲雨与店内事务都已进入下一步。</end_state></content>';
    const oldPlan = parseContent(legacy), newPlan = parseContent(v2);
    assert.equal(oldPlan.version, 1);
    assert.equal(newPlan.version, 2);
    assert.equal(newPlan.beats.length, 3);
    assert.match(newPlan.beats[0].event, /唐雨主动/);
    assert.match(newPlan.beats[1].event, /许川/);
    assert.equal(newPlan.beats[2].emotion, undefined);
    assert.match(newPlan.anchors, /只有林澄与唐雨知道/);
    assert.ok(newPlan.xml.length < oldPlan.xml.length);
    assert.doesNotMatch(newPlan.xml, /回应与对白|判断与情绪|衔接：/);
});
