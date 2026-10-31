import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePreset, compilePreset } from '../lib/preset.js';
import { buildPromptInspection } from '../lib/prompt-inspector.js';

const context = { user: '甲', char: '乙', currentInput: '递出信。', animaMemory: '约定不拆信。', animaStatus: 'success' };
const prompt = (identifier, content, extra = {}) => ({ identifier, name: identifier, role: 'system', content, ...extra });
function tracedPreset() {
    return normalizePreset({
        prompts: [prompt('set', '{{setvar::tone::克制}}'), prompt('chatHistory', '', { marker: true }), prompt('charDescription', '', { marker: true }),
            prompt('tail', '{{char}}保持{{getvar::tone}}。'), prompt('off', '{{unknown}}'), prompt('groupOff', '{{unknown}}'), prompt('unlisted', '{{unknown}}')],
        prompt_order: ['set','chatHistory','charDescription','tail','off','groupOff'].map(identifier => ({ identifier, enabled: identifier !== 'off' })),
        groups: [{ id: 'disabledGroup', name: '未启用组', enabled: false }], promptGroups: { groupOff: 'disabledGroup' },
    });
}

test('compiled trace exactly follows actual macro-expanded messages, including empty active entries and runtime placement', () => {
    const preset = tracedPreset();
    const compiled = compilePreset(preset, { context: { ...context, charDescription: '', chatHistory: [{ role: 'user', content: '旧输入' }, { role: 'assistant', content: '旧正文' }] }, targetLength: '1500—2000 字' });
    assert.deepEqual(compiled.entries.flatMap(entry => entry.messages), compiled.messages);
    assert.deepEqual(compiled.entries.map(entry => entry.id), ['set','chatHistory','charDescription','anima_memory','target_length','current_input','tail']);
    assert.deepEqual(compiled.entries.map(entry => entry.order), [1,2,3,4,5,6,7]);
    assert.equal(compiled.entries[0].status, 'empty');
    assert.equal(compiled.entries[2].status, 'empty');
    assert.deepEqual(compiled.messages.slice(0, 2), [{ role: 'user', content: '旧输入' }, { role: 'assistant', content: '旧正文' }]);
    assert.match(compiled.messages[2].content, /^【相关经历与资料】/);
    assert.match(compiled.messages[3].content, /^【本轮共享的最终正文目标】/);
    assert.equal(compiled.messages[4].content, '【本轮当前 user_input】\n递出信。');
    assert.equal(compiled.messages[5].content, '乙保持克制。');
    assert.equal(compiled.entries.at(-1).messages[0].content, '乙保持克制。');
    assert.ok(compiled.entries.every(entry => entry.enabled));
});

test('inspection records each disabled, grouped-off and unlisted prompt without expanding it or charging tokens', () => {
    const preset = tracedPreset();
    const compiled = compilePreset(preset, { context: { ...context, charDescription: '', chatHistory: [] } });
    const sources = { history: { status: 'read', messages: 0 }, anima: { status: 'success', source: 'actual-call' } };
    const inspection = buildPromptInspection({ preset, compiled, sources, model: 'independent-model' });
    assert.equal(inspection.model, 'independent-model');
    assert.equal(inspection.tokenMethod, '按文本估算；非供应商计费');
    assert.match(inspection.tokenEstimateNote, /UTF-8/);
    assert.deepEqual(inspection.entries.filter(entry => !entry.enabled).map(entry => [entry.id, entry.tokens, entry.reason]), [
        ['off', 0, 'prompt_disabled'], ['groupOff', 0, 'group_disabled'], ['unlisted', 0, 'unlisted'],
    ]);
    assert.ok(inspection.entries.filter(entry => !entry.enabled).every(entry => entry.order === null && entry.status === 'disabled'));
    assert.equal(inspection.entries.find(entry => entry.id === 'set').tokens, 0);
    assert.equal(inspection.entries.find(entry => entry.id === 'set').status, 'empty');
    assert.equal(inspection.totalTokens, inspection.entries.reduce((sum, entry) => sum + entry.tokens, 0));
    assert.deepEqual(inspection.entries.flatMap(entry => entry.messages), compiled.messages);
    assert.deepEqual(inspection.sources, sources);
    sources.history.status = 'changed';
    assert.equal(inspection.sources.history.status, 'read');
    inspection.entries.find(entry => entry.id === 'tail').messages[0].content = '本地展示修改';
    assert.equal(compiled.entries.at(-1).messages[0].content, '乙保持克制。');
});

test('token estimate handles Unicode and runtime messages; inconsistent or absent compiled snapshots fail explicitly', () => {
    const preset = normalizePreset({ prompts: [prompt('unicode', '汉字🙂')] });
    const compiled = compilePreset(preset, { context: { ...context, animaMemory: '', animaStatus: 'empty' } });
    const inspection = buildPromptInspection({ preset, compiled });
    // 10 content bytes + 6 role bytes => ceil(16/3) + 4 estimated format tokens.
    assert.equal(inspection.entries[0].tokens, 10);
    assert.equal(inspection.entries.find(entry => entry.id === 'anima_memory').tokens, 0);
    assert.equal(inspection.entries.find(entry => entry.id === 'anima_memory').status, 'empty');
    assert.ok(inspection.entries.find(entry => entry.id === 'current_input').tokens > 0);
    assert.ok(!inspection.entries.some(entry => entry.id === 'target_length'));
    assert.throws(() => buildPromptInspection({ preset, compiled: { messages: [] } }), /快照/);
    assert.throws(() => buildPromptInspection({ preset, compiled: { ...compiled, messages: [] } }), /不一致/);
});

test('built-in ordering is rules-first with context, input, thinking and output contract last and no variable-order dependencies', () => {
    const source = JSON.parse(fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'));
    const preset = normalizePreset(source);
    assert.equal(source.name, '状态因果 · 轻度补写（V1 稳定）');
    assert.ok(preset.prompts.every(item => !/\{\{\s*(?:set|get)(?:global)?var/i.test(item.content)));
    const groups = ['outline_context','outline_task','outline_tiers','outline_tone','outline_character','outline_special','outline_emotion','outline_story','outline_voice','outline_thinking','outline_delivery'];
    assert.deepEqual(preset.groups.map(group => group.id), groups);
    const ranks = preset.order.map(entry => groups.indexOf(preset.promptGroups[entry.identifier]));
    // Each group's entries form one contiguous block, in reading order rather than group order.
    const seen = new Set();
    for (let i = 0; i < ranks.length; i++) {
        assert.ok(!seen.has(ranks[i]), 'entries of one group must not be split by another group');
        if (i === ranks.length - 1 || ranks[i + 1] !== ranks[i]) seen.add(ranks[i]);
    }
    assert.equal(preset.order[0].identifier, 'main');
    const compiled = compilePreset(preset, { context: { ...context, worldInfoBefore: '', personaDescription: '用户设定', charDescription: '人物设定', charPersonality: '', scenario: '', worldInfoAfter: '', dialogueExamples: '', chatHistory: [] } });
    const at = id => compiled.entries.findIndex(entry => entry.id === id);
    // Rules act as the reading lens first; materials, runtime input, the thinking
    // checks and the output contract sit at the end, closest to generation.
    assert.ok(at('main') < at('worldInfoBefore'));
    assert.ok(at('outline_ending') < at('chatHistory'));
    assert.ok(at('chatHistory') < at('current_input'));
    assert.ok(at('current_input') < at('outline_think_state'));
    assert.ok(at('outline_think_drive') < at('outline_output'));
    assert.equal(compiled.entries.at(-1).id, 'outline_output');
    assert.ok(!compiled.messages.at(-1).content.includes('<knowledge>'));
    assert.ok(!compiled.messages.at(-1).content.includes('<cause>'));
});

test('all built-ins hand over story facts without prescribing prose implementation', () => {
    for (const file of ['default.json', 'default-v2.json', 'default-v3.json']) {
        const source = JSON.parse(fs.readFileSync(new URL(`../presets/${file}`, import.meta.url), 'utf8'));
        const prompts = new Map(source.prompts.map(item => [item.identifier, item.content]));
        const inspect = ['outline_light_user', 'outline_third_person', 'outline_think_drive', 'outline_output',
            'outline_userproxy_min', 'outline_userproxy_light', 'outline_userproxy_strong', 'outline_userproxy_max'];
        if (file !== 'default-v3.json') inspect.push('outline_ending');
        for (const id of inspect) {
            assert.doesNotMatch(prompts.get(id), /正文以 user_input 的润色转述起始|使用第三人称|整体视点|视点切换|按正文呈现顺序|最后一拍|叙事重心|视点不停留|视点可以/, `${file}:${id}`);
        }
        assert.match(prompts.get('outline_third_person'), /认知边界/);
        assert.match(prompts.get('outline_light_user'), /影响剧情走向与关系走向的回答与决定/);
        if (file === 'default-v3.json') {
            assert.match(prompts.get('main'), /主模型依据这些故事依据/);
            assert.equal(prompts.has('outline_dialogue'), false);
            assert.equal(prompts.has('outline_ending'), false);
            assert.match(prompts.get('outline_output'), /三者均不可省略/);
            const template = prompts.get('outline_output').match(/【固定模板开始】([\s\S]*?)【固定模板结束】/)[1];
            assert.doesNotMatch(template, /【口吻】|【逐字保留】|<beats>|<anchors>|<end_state>/);
        } else {
            assert.match(prompts.get('main'), /主模型依据这些故事事实与因果重新创作完整正文/);
            assert.match(prompts.get('outline_output'), /不得规定开场转述、叙述人称与视点/);
            assert.match(prompts.get('outline_dialogue'), /逐字保留/);
        }
    }
    const writer = fs.readFileSync(new URL('../presets/writer.txt', import.meta.url), 'utf8');
    assert.match(writer, /不是逐字段翻译、复述、扩写或润色大纲/);
    assert.match(writer, /重新创作一篇连贯、完整的中文正文/);
    assert.match(writer, /不固定从润色转述开场/);
    assert.doesNotMatch(writer, /使用第三人称/);
    assert.match(writer, /【逐字保留】的原句必须准确使用/);
    assert.match(writer, /大纲未提组件不代表省略、关闭或降级为普通旁述/);
    assert.match(writer, /V3 没有 end_state/);
});

test('built-in head creative permission is optional and preserves the output contract when enabled', () => {
    const source = JSON.parse(fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'));
    const id = 'outline_jailbreak_head';
    const runtimeContext = { ...context, worldInfoBefore: '', personaDescription: '用户设定', charDescription: '人物设定', charPersonality: '', scenario: '', worldInfoAfter: '', dialogueExamples: '', chatHistory: [] };
    assert.equal(source.prompts.find(item => item.identifier === id).enabled, false);
    assert.equal(source.prompt_order[0].order[1].identifier, id);
    assert.equal(source.prompt_order[0].order[1].enabled, false);
    assert.equal(source.extensions.baibaiToolkit.presetPromptGroups.prompts[id].groupId, 'outline_task');
    const off = compilePreset(normalizePreset(source), { context: runtimeContext });
    assert.ok(!off.messages.some(message => message.content.includes('【虚构创作许可】')));

    const enabled = structuredClone(source);
    enabled.prompts.find(item => item.identifier === id).enabled = true;
    enabled.prompt_order[0].order.find(item => item.identifier === id).enabled = true;
    const on = compilePreset(normalizePreset(enabled), { context: runtimeContext });
    assert.equal(on.entries[0].id, 'main');
    assert.equal(on.entries[1].id, id);
    assert.match(on.entries[1].messages[0].content, /不输出正文、不改变 content XML 输出合同/);
    assert.equal(on.entries.at(-1).id, 'outline_output');
});
