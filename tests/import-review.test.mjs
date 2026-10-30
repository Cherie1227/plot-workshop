import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePreset } from '../lib/preset.js';
import { buildImportReview } from '../lib/import-review.js';

const prompt = (identifier, content = '分析人物动机。', name = identifier, extra = {}) => ({ identifier, name, content, ...extra });
function preset(prompts, extra = {}) { return { prompts, order: prompts.map(p => ({ identifier: p.identifier, enabled: true })), groups: [], promptGroups: {}, ...extra }; }
const one = (name, content, extra = {}) => buildImportReview(preset([prompt('entry', content, name)], extra)).items[0];

test('flat request order and normal-editor group order do not depend on prompt array order', () => {
    const p = preset([prompt('c'), prompt('b'), prompt('marker', '', '聊天历史', { marker: true }), prompt('a'), prompt('unlisted')], {
        order: ['marker', 'a', 'b', 'c'].map(identifier => ({ identifier, enabled: true })),
        groups: [{ id: 'later', name: '后组', order: 8 }, { id: 'first', name: '先组', order: 2 }],
        promptGroups: { a: 'later', b: { groupId: 'first' }, c: 'later' },
    });
    const r = buildImportReview(p);
    assert.deepEqual(r.items.map(x => x.id), ['marker', 'a', 'b', 'c']);
    assert.deepEqual(r.groups.map(g => [g.id, g.items.map(x => x.id)]), [['first', ['b']], ['later', ['a', 'c']], ['__ungrouped', ['marker']]]);
    assert.equal(r.items[0].kind, 'context'); assert.equal(r.items[0].needsReview, false);
    p.order = ['c', 'marker', 'b', 'a'].map(identifier => ({ identifier, enabled: true }));
    assert.deepEqual(buildImportReview(p).groups.find(g => g.id === 'later').items.map(x => x.id), ['c', 'a']);
});

test('actual order and group switches control enabled states; off entries remain listed', () => {
    const p = preset([prompt('a', '请输出完整正文。', '正文输出', { enabled: false }), prompt('b'), prompt('c')], {
        order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }, { identifier: 'c', enabled: true }],
        groups: [{ id: 'off', name: '关闭组', enabled: false }], promptGroups: { c: 'off' },
    });
    const r = buildImportReview(p);
    assert.equal(r.items[0].enabled, true); assert.equal(r.items[0].needsReview, true);
    assert.equal(r.items[1].entryEnabled, false); assert.equal(r.items[1].status, 'disabled');
    assert.equal(r.items[2].entryEnabled, true); assert.equal(r.items[2].groupEnabled, false);
    assert.equal(r.items[2].enabled, false); assert.equal(r.items[2].needsReview, false);
});

test('known macros and variable-only definitions or reads are information, not conflicts', () => {
    for (const content of ['{{user}}', '{{description}}', '{{getvar::rules}}', '{{getglobalvar::rules}}', '{{setvar::rules::请输出完整正文}}', '{{setvar::name::{{char}}}}', '定义变量 mood=平静。', 'const mood = "请输出完整正文";']) {
        const item = one('正文输出', content);
        assert.equal(item.status, 'info', content); assert.equal(item.needsReview, false, content);
    }
});

test('real output or style requirements beside dependencies still need review', () => {
    for (const content of ['{{user}}\n请输出完整正文。', '{{setvar::mood::平静}}\n请输出完整正文。', '{{getvar::rules}}\n每轮输出本轮摘要。', '定义变量 mood=平静。请输出状态栏。', 'const mood = "平静";\n请输出状态栏。', '{{char}}\n字数不少于1500。']) {
        assert.equal(one('规则', content).needsReview, true, content);
    }
    const unknown = one('规则', '{{setvar::a::1}}\n{{unrecognized_macro}}');
    assert.equal(unknown.needsReview, true); assert.match(unknown.reason, /未识别/);
});

test('live edits and switches replace stale review records', () => {
    const p = preset([prompt('entry', '请输出完整正文。', '正文输出')], { importAdvice: { disable: [{ id: 'entry', reason: '原自动关闭理由' }, { id: 'gone', reason: '已删除' }], review: [{ id: 'entry', reason: '旧检查结果' }] } });
    p.order[0].enabled = false;
    let r = buildImportReview(p);
    assert.equal(r.autoDisabledCount, 1); assert.equal(r.restorableCount, 1);
    assert.equal(r.items[0].status, 'disabled'); assert.equal(r.items[0].needsReview, false);
    p.order[0].enabled = true;
    r = buildImportReview(p);
    assert.equal(r.restorableCount, 0); assert.equal(r.items[0].needsReview, true);
    assert.doesNotMatch(r.items[0].reason, /原自动|旧检查/);
    p.prompts[0].name = '人物理解'; p.prompts[0].content = '分析人物动机。';
    r = buildImportReview(p);
    assert.equal(r.items[0].status, 'normal'); assert.equal(r.items[0].needsReview, false);
});

test('fixed format remains a visible kind and a disabled format needs review even inside an off group', () => {
    const p = preset([prompt('outline_output', '格式文本', '格式')]);
    let r = buildImportReview(p);
    assert.equal(r.items[0].kind, 'format'); assert.equal(r.items[0].status, 'format');
    p.groups = [{ id: 'off', name: '格式组', enabled: false }]; p.promptGroups.outline_output = 'off';
    r = buildImportReview(p);
    assert.equal(r.items[0].status, 'review'); assert.equal(r.items[0].needsReview, true);
    assert.match(r.message, /已关闭/);
    p.order = []; assert.match(buildImportReview(p).message, /未找到/);
});

test('name hints are fallback advice and do not override disabled, marker, quoted or fixed protocol classifications', () => {
    assert.equal(one('正文输出', '未分类要求。').needsReview, true);
    assert.equal(one('正文输出', '不要输出完整正文。').needsReview, false);
    assert.equal(one('正文输出', '“输出完整正文”是原文。').needsReview, false);
    assert.equal(one('正文输出', '<content><plot>方向</plot><characters>人物</characters><segments>事件</segments><end_state>状态</end_state></content>').needsReview, false);
    const r = buildImportReview(preset([prompt('marker', '请输出正文。', '正文输出', { marker: true })]));
    assert.equal(r.items[0].kind, 'context'); assert.equal(r.items[0].needsReview, false);
});

test('review is deterministic, serializable and does not mutate frozen input', () => {
    const p = preset([prompt('entry', '{{user}}\n请输出完整正文。', '正文')]);
    const before = JSON.stringify(p);
    function freeze(v) { for (const child of Object.values(v)) if (child && typeof child === 'object') freeze(child); return Object.freeze(v); }
    freeze(p);
    const r = buildImportReview(p);
    assert.equal(JSON.stringify(p), before); assert.deepEqual(r, buildImportReview(p));
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
    assert.deepEqual(buildImportReview(null).items, []);
});

test('explicit planning handoff is compatible, but adding prose output still needs review', () => {
    const handoff = '在 plot 简要给出整体视点安排；具体叙述句式和心理描写交给正文主预设。';
    assert.equal(one('视角安排', `{{user}}\n${handoff}`).needsReview, false);
    assert.equal(one('视角安排', `{{user}}\n${handoff}\n请输出完整正文。`).needsReview, true);
});

test('current built-in planning preset has no import conflicts', async () => {
    const builtin = JSON.parse(await readFile(new URL('../presets/default.json', import.meta.url), 'utf8'));
    const review = buildImportReview(normalizePreset(builtin));
    assert.deepEqual(review.items.filter(item => item.needsReview).map(item => [item.id, item.reason]), []);
});
