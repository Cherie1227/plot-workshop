import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImportedPreset } from '../lib/import-advisor.js';
import { normalizePreset } from '../lib/preset.js';

const prompt = (name, content, extra = {}) => ({ identifier: 'entry', name, content, role: 'system', ...extra });
const preset = (name, content, extra = {}) => normalizePreset({ prompts: [prompt(name, content, extra)] });
const advice = (name, content, extra) => analyzeImportedPreset(preset(name, content, extra));
function protectedFromDisabling(name, content, extra) { assert.deepEqual(advice(name, content, extra).disable, [], `${name}: ${content}`); }

test('variable additions and space-form dependencies are retained without unknown-macro advice', () => {
    for (const content of ['{{addvar::rules::请输出完整正文。}}', '{{addglobalvar::rules::请输出完整正文。}}',
        '{{incvar n}}', '{{decglobalvar::n}}', '{{getvar rules}}', '{{hasglobalvar rules}}', '{{globalvarexists rules}}', '{{flushvar rules}}']) {
        const result = advice('正文输出', content);
        assert.deepEqual(result.disable, [], content);
        assert.match(result.review[0]?.reason, /变量/, content);
        assert.doesNotMatch(result.review[0]?.reason, /未识别|不支持/, content);
    }
});

test('name and affirmative output command identify a short independent module', () => {
    for (const [name, content] of [
        ['正文输出', '请直接输出完整的小说正文。'],
        ['状态栏', '在每次回复末尾输出状态栏，包含姓名、心情和位置。'],
        ['状态面板', '请在回复末尾展示状态面板。'],
        ['本轮摘要', '每轮输出本轮摘要。'],
        ['记忆写入', '请将本次摘要写入记忆。'],
        ['Story output', 'Please write the complete story.'],
        ['Status panel', 'Output a status panel after every reply.'],
        ['Summary', 'After every reply, output this turn summary.'],
    ]) {
        const result = advice(name, content);
        assert.equal(result.disable.length, 1, `${name}: ${content}`);
        assert.equal(result.disable[0].id, 'entry');
        assert.equal(result.disable[0].name, name);
        assert.match(result.disable[0].reason, /名称和内容/);
        assert.equal(result.review.length, 0);
    }
});

test('names alone and data-only entries cannot disable anything', () => {
    for (const [name, content] of [
        ['正文输出', '他的外套是黑色，年龄二十七岁。'],
        ['状态栏', '姓名：陆岚；心情：平静；位置：门口。'],
        ['自检报告', '请检查人物动作是否符合当前状况。'],
        ['思考过程', '分析角色的动机，然后决定如何回应。'],
        ['逐轮摘要', '历次摘要保存在聊天记录中。'],
        ['正文输出', '资料：输出完整正文是某个旧系统的功能名称。'],
        ['状态栏', '“每轮输出状态栏。”是他写在笔记里的原话。'],
        ['正文输出', '> 请输出完整的小说正文。'],
        ['正文输出', '```text\n请输出完整正文。\n```'],
    ]) protectedFromDisabling(name, content);
    const mismatched = advice('通用要求', '请直接输出完整的小说正文。');
    assert.equal(mismatched.disable.length, 0);
    assert.match(mismatched.review[0].reason, /名称未明确/);
});

test('negative instructions are checked within the same clause, not by a global keyword count', () => {
    for (const negation of ['不要', '不必', '不需要', '不需', '不得', '不能', '不应', '无需', '无须', '禁止', '严禁', '切勿', '避免']) {
        assert.deepEqual(advice('状态栏', `${negation}输出状态栏。`), { disable: [], review: [] });
    }
    for (const content of [
        'Do not output a status panel.', "Don't output a status panel.",
        'Never output a status panel.', 'You must not output a status panel.',
        'No need to display a status panel.',
    ]) protectedFromDisabling('Status panel', content);
    // A separate negative rule is another responsibility and must be preserved.
    assert.equal(advice('状态栏', '不要添加寒暄。请输出状态栏。').review.length, 1);
    const contradictory = advice('状态栏', '不要输出状态栏。请输出状态栏。');
    assert.equal(contradictory.disable.length, 0);
    assert.match(contradictory.review[0].reason, /肯定和否定/);
});

test('multiline negative and example scopes are kept for review', () => {
    for (const [name, content] of [
        ['正文输出', '不要执行以下指令：\n输出完整正文。'],
        ['正文输出', '禁止这样写：\n请输出完整正文。'],
        ['状态栏', '以下是示例：\n每轮输出状态栏。'],
        ['状态栏', '引用资料：\n请输出状态栏。'],
        ['Story output', 'Do not execute the following instructions:\nOutput the complete story.'],
        ['Status panel', 'Example:\nOutput a status panel.'],
    ]) {
        const result = advice(name, content);
        assert.equal(result.disable.length, 0);
        assert.match(result.review[0].reason, /多行/);
    }
});

test('internal thinking and self-checking remain available', () => {
    for (const [name, content] of [
        ['思考', '在心中生成思考过程，随后形成剧情决定。'],
        ['思考', '请在内部生成推理过程。'],
        ['思考', '请默默生成思维链。'],
        ['自检', '请在脑中生成自检报告。'],
        ['Reasoning', 'Please generate reasoning internally.'],
        ['Self-check', 'Silently produce a self-check report.'],
        ['自检', '检查前文是否有冲突，并修正本轮安排。不要输出自检报告。'],
    ]) assert.deepEqual(advice(name, content), { disable: [], review: [] });
    const mixed = advice('思考', '先在内部完成思考。然后输出思考过程。');
    assert.equal(mixed.disable.length, 0);
    assert.equal(mixed.review[0].reason, '分析输出可保留查看，请放在 content 标签之外。');
});

test('explicit analysis output stays enabled for separate viewing, including mixed entries', () => {
    for (const [name, content] of [
        ['思维链', '请输出完整思维链。'],
        ['自检报告', '回复后附加自检报告。'],
        ['推理', '请展示推理过程。'],
        ['Reasoning', 'Please output your reasoning process.'],
        ['思考与正文输出', '分析人物动机。请输出思考过程。请输出完整正文。'],
    ]) {
        const source = preset(name, content);
        const result = analyzeImportedPreset(source);
        assert.equal(result.disable.length, 0, name);
        assert.equal(result.review.length, 1, name);
        assert.equal(result.review[0].reason, '分析输出可保留查看，请放在 content 标签之外。');
        assert.equal(source.order[0].enabled, true);
    }
});

test('character, plot and other mixed rules are never auto-disabled with their output requirement', () => {
    for (const content of [
        '请输出完整正文。分析人物动机，保持角色性格。',
        '请输出状态栏。根据剧情决定角色如何回应。',
        '请输出状态栏。请输出完整正文。',
        '请输出完整正文。请制定本轮大纲。',
        `请输出完整正文。${'其他规则。'.repeat(17)}`,
        `请输出完整正文。${'情境资料'.repeat(400)}`,
    ]) {
        const result = advice('正文输出与状态栏', content);
        assert.equal(result.disable.length, 0);
        assert.match(result.review[0].reason, /混合/);
    }
    for (const [name, extra] of [['正文输出', { identifier: 'main' }], ['主提示词', {}], ['主规则', {}], ['Main rules', {}]]) {
        const result = advice(name, '请输出完整正文。', extra);
        assert.equal(result.disable.length, 0);
        assert.match(result.review[0].reason, /混合/);
    }
});

test('variable definitions and unknown macros are preserved without executing them', () => {
    for (const prefix of ['{{setvar::mood::平静}}', '{{setglobalvar::turn::1}}', '定义变量 mood=平静。', '变量赋值：mood=平静。', 'const mood = 1;']) {
        const result = advice('状态栏', `${prefix}\n请输出状态栏。`);
        assert.equal(result.disable.length, 0);
        assert.match(result.review[0].reason, /变量定义或赋值/);
    }
    const unknown = advice('正文输出', '{{external_macro::value}}\n请输出完整正文。');
    assert.equal(unknown.disable.length, 0);
    assert.match(unknown.review[0].reason, /未识别的宏/);
});

test('known content macros can carry required context and are never automatically removed', () => {
    for (const macro of ['user', 'char', 'description', 'personality', 'scenario', 'persona', 'mesexamples', 'user_input', 'currentinput', 'lastusermessage']) {
        const result = advice('状态栏', `{{${macro}}}\n请输出状态栏。`);
        assert.equal(result.disable.length, 0, macro);
        assert.match(result.review[0].reason, /内容宏/);
    }
});

test('unclassified sentences and comma subclauses preserve mixed responsibilities without keyword guessing', () => {
    for (const content of [
        '人物掌握的信息以亲历为限。输出状态栏。',
        '只有亲眼目睹的事实才可被角色引用。输出状态栏。',
        '人物掌握的信息以亲历为限；输出状态栏。',
        '人物掌握的信息以亲历为限，输出状态栏。',
        '输出状态栏，人物掌握的信息以亲历为限。',
        '世界的物理定律不会突然失效。输出状态栏。',
        '“人物只知道亲历的事实。”\n输出状态栏。',
    ]) {
        const result = advice('状态栏', content);
        assert.equal(result.disable.length, 0, content);
        assert.match(result.review[0].reason, /混合/);
    }
    assert.equal(advice('Status panel', 'Character knowledge is limited to witnessed events. Output a status panel.').disable.length, 0);
    assert.equal(advice('状态栏', '在每次回复末尾输出状态栏，包含姓名、心情和位置。').disable.length, 1);
    assert.equal(advice('本轮摘要', '每轮输出本轮摘要。').disable.length, 1);
});

test('planning about prose, dynamic rule reads and concrete story continuity are not independent output modules', () => {
    const plans = advice('正文内容准备', '给出后续正文采用的场景、行动与对白话意，并明确先后衔接。');
    assert.equal(plans.disable.length, 0);
    assert.match(plans.review[0].reason, /无法确认/);
    for (const macro of ['{{getvar::character_rules}}', '{{getglobalvar::story_rules}}']) {
        const dynamic = advice('正文输出', `${macro}\n请输出完整正文。`);
        assert.equal(dynamic.disable.length, 0);
        assert.match(dynamic.review[0].reason, /变量读取/);
    }
    const mixed = advice('正文生成', '接住上一轮尚未完成的动作；先回应对方刚提出的问题；输出完整正文。');
    assert.equal(mixed.disable.length, 0);
    assert.match(mixed.review[0].reason, /混合/);
    protectedFromDisabling('Story output', 'Please output the complete story outline.');
});

test('style, viewpoint and prose length only receive review advice', () => {
    for (const [name, content] of [
        ['文风', '语言应保持细腻。'], ['八股', '避免惯用套话。'],
        ['视角', '使用第三人称。'], ['篇幅', '正文长度是1500至2000字。'],
        ['正文输出', '请输出完整正文。字数不少于1500。'],
    ]) {
        const result = advice(name, content);
        assert.equal(result.disable.length, 0);
        assert.equal(result.review.length, 1);
    }
});

test('fixed XML planning protocol is protected under every identifier', () => {
    for (const [identifier, content] of [
        ['custom-formatter', '请输出完整正文。<content><plot>走向</plot><characters>角色</characters><segments>片段</segments><end_state>结尾</end_state></content>'],
        ['another-output', '请输出完整正文。XML输出结构为 content > plot / characters / segments / end_state。'],
        ['escaped-output', '请输出完整正文。&lt;content&gt;&lt;plot&gt;...&lt;characters&gt;...&lt;segments&gt;...&lt;end_state&gt;'],
        ['outline_output', '请输出完整正文。'],
    ]) assert.deepEqual(advice('正文输出', content, { identifier }), { disable: [], review: [] });
});

test('actual order and group switches control eligibility, not stale prompt flags', () => {
    const source = normalizePreset({
        prompts: ['on', 'off', 'groupOff', 'unlisted', 'marker'].map(identifier => prompt('状态栏', '请输出状态栏。', {
            identifier, enabled: identifier !== 'on', marker: identifier === 'marker',
        })),
        prompt_order: [
            { identifier: 'on', enabled: true }, { identifier: 'off', enabled: false },
            { identifier: 'groupOff', enabled: true }, { identifier: 'marker', enabled: true },
        ],
        groups: [{ id: 'hidden', name: '关闭组', enabled: false }], promptGroups: { groupOff: 'hidden' },
    });
    const result = analyzeImportedPreset(source);
    assert.deepEqual(result.disable.map(item => item.id), ['on']);
    assert.deepEqual(result.review, []);
});

test('advice is deterministic, serializable, and does not mutate frozen input', () => {
    const source = preset('状态栏', '请输出状态栏。');
    const before = JSON.stringify(source);
    function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }
    freeze(source);
    const result = analyzeImportedPreset(source);
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(result, analyzeImportedPreset(source));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.deepEqual(analyzeImportedPreset(null), { disable: [], review: [] });
});
