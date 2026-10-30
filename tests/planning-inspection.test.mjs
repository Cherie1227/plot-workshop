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

test('only built-in ordering is context-first with final output last and no variable-order dependencies', () => {
    const source = JSON.parse(fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'));
    const preset = normalizePreset(source);
    assert.equal(source.name, '第三人称 · 轻度抢话');
    assert.ok(preset.prompts.every(item => !/\{\{\s*(?:set|get)(?:global)?var/i.test(item.content)));
    const groups = ['outline_context','outline_task','outline_character','outline_emotion','outline_story','outline_voice','outline_delivery'];
    assert.deepEqual(preset.groups.map(group => group.id), groups);
    const ranks = preset.order.map(entry => groups.indexOf(preset.promptGroups[entry.identifier]));
    assert.deepEqual(ranks, [...ranks].sort((a,b) => a - b));
    assert.equal(preset.order[0].identifier, 'worldInfoBefore');
    const compiled = compilePreset(preset, { context: { ...context, worldInfoBefore: '', personaDescription: '用户设定', charDescription: '人物设定', charPersonality: '', scenario: '', worldInfoAfter: '', dialogueExamples: '', chatHistory: [] } });
    assert.ok(compiled.entries.findIndex(entry => entry.id === 'current_input') < compiled.entries.findIndex(entry => entry.id === 'main'));
    assert.equal(compiled.entries.at(-1).id, 'outline_output');
    assert.ok(!compiled.messages.at(-1).content.includes('<knowledge>'));
    assert.ok(!compiled.messages.at(-1).content.includes('<cause>'));
});
