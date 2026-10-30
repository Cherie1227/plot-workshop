import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreset, compilePreset } from '../lib/preset.js';
import { buildPromptInspection } from '../lib/prompt-inspector.js';

const part = (content, header = '[Anima 聊天记忆]') => ({ header, content });
const compose = parts => parts.map(item => `${item.header}\n${item.content}`).join('\n\n').trim();
function preset(extra = {}) {
    return normalizePreset({ prompts: [
        { identifier: 'worldInfoBefore', marker: true },
        { identifier: 'worldInfoAfter', marker: true },
        { identifier: 'rules', content: '生成本轮大纲。' },
    ], ...extra });
}
function compile(parts, context = {}, p = preset()) {
    return compilePreset(p, { context: { currentInput: '递信。', animaStatus: 'success', animaMemory: compose(parts), memoryParts: parts,
        worldInfoBefore: '', worldInfoAfter: '', ...context } });
}
const memory = compiled => compiled.entries.find(entry => entry.id === 'anima_memory');

test('complete worldbook coverage emits no duplicate memory and keeps a readable zero-token source', () => {
    const parts = [part('曾经约定不擅自拆信。'), part('当前仍然戒备。', '[Anima 当前状态]')];
    const p = preset();
    const compiled = compile(parts, { worldInfoBefore: parts[0].content, worldInfoAfter: parts[1].content }, p);
    assert.deepEqual(memory(compiled).messages, []);
    assert.equal(memory(compiled).name, 'Anima 记忆 · 已包含在世界书');
    assert.deepEqual(compiled.entries.flatMap(entry => entry.messages), compiled.messages);
    const inspection = buildPromptInspection({ preset: p, compiled, sources: [{ name: 'Anima', status: '已读取' }] });
    assert.equal(inspection.entries.find(entry => entry.id === 'anima_memory').tokens, 0);
    assert.equal(inspection.sources[0].status, '已读取');
});

test('partial coverage preserves complete unmatched blocks and their source headings', () => {
    const parts = [part('此前的约定。'), part('模板遗漏但已选中的最近摘要。', '[Anima 最近摘要]'), part('门仍开着。', '[Anima 当前状态]')];
    const compiled = compile(parts, { worldInfoAfter: `其他设定\n${parts[0].content}\n另一项设定` });
    assert.equal(memory(compiled).name, 'Anima 记忆 · 补充内容');
    assert.equal(memory(compiled).messages[0].content, `【相关经历与资料】\n${compose(parts.slice(1))}`);
    assert.equal(compiled.messages.filter(message => message.content.includes(parts[0].content)).length, 1);
});

test('disabled, grouped-off, and unlisted worldbook markers never justify removal', () => {
    const parts = [part('未实际发送的世界书资料。')];
    const variants = [
        { order: [{ identifier: 'worldInfoBefore', enabled: false }, { identifier: 'rules', enabled: true }] },
        { groups: [{ id: 'off', name: '关闭资料组', enabled: false }], promptGroups: { worldInfoBefore: 'off', worldInfoAfter: 'off' } },
        { order: ['rules'] },
    ];
    for (const extra of variants) {
        const compiled = compile(parts, { worldInfoBefore: parts[0].content }, preset(extra));
        assert.equal(memory(compiled).messages[0].content, `【相关经历与资料】\n${compose(parts)}`);
    }
});

test('whole-block line boundaries reject half-sentences, partial paragraphs, and whitespace changes', () => {
    for (const source of ['他很开心。', '开心得很', '很开心', ' 开心', '开心 ']) {
        assert.equal(memory(compile([part('开心')], { worldInfoBefore: source })).messages.length, 1, source);
    }
    assert.equal(memory(compile([part('开心')], { worldInfoBefore: '其他\n开心\n其他' })).messages.length, 0);
    for (const source of ['第一行', '第一行\n第二行多了一句', '前缀第一行\n第二行', '第一行\n\n第二行']) {
        assert.equal(memory(compile([part('第一行\n第二行')], { worldInfoAfter: source })).messages.length, 1, source);
    }
});

test('only newline encoding may differ, and complete multiline blocks remain literal', () => {
    const body = '第一行\n{{setvar::secret::untouched}}\n第三行';
    const compiled = compile([part(body)], { worldInfoBefore: `前文\r\n${body.replaceAll('\n', '\r\n')}\r\n后文` });
    assert.equal(memory(compiled).messages.length, 0);
    assert.equal(compiled.variables.secret, undefined);
    assert.equal(memory(compile([part('保留尾部空格 ')], { worldInfoBefore: '保留尾部空格' })).messages.length, 1);
});

test('unmatched worldbooks, chat history, prompt lookalikes and synthetic marker headings do not cover memory', () => {
    const parts = [part('相同历史内容')];
    assert.equal(memory(compile(parts)).messages.length, 1);
    const p = preset({ prompts: [{ identifier: 'chatHistory', marker: true }, { identifier: 'worldInfoBefore', content: parts[0].content }, { identifier: 'rules', content: parts[0].content }] });
    assert.equal(memory(compile(parts, { chatHistory: [{ role: 'assistant', content: parts[0].content }] }, p)).messages.length, 1);
    assert.equal(memory(compile([part('【worldInfoBefore】')], { worldInfoBefore: '另外的资料' })).messages.length, 1);
});

test('coverage is not stitched across separate emitted messages or transformed knowledge grouping', () => {
    const parts = [part('第一段\n第二段')];
    const messages = [{ role: 'system', content: '第一段' }, { role: 'system', content: '第二段' }];
    assert.equal(memory(compile(parts, { worldInfoBefore: messages })).messages.length, 1);
    assert.equal(memory(compile(parts, { worldInfoBefore: [{ role: 'system', content: parts[0].content }] })).messages.length, 0);
    const knowledge = part('[Source: 文档]\n第一段\n\n[Source: 文档]\n第二段', '[Anima 知识库]');
    assert.equal(memory(compile([knowledge], { worldInfoAfter: '[Source: 文档]\n第一段\n...\n第二段' })).messages.length, 1);
});

test('legacy or inconsistent part metadata preserves the original complete memory', () => {
    const parts = [part('第一块'), part('第二块', '[Anima 知识库]')];
    for (const memoryParts of [undefined, [], [parts[0]], [{ header: '[标题]', content: '' }], [{ header: '[伪造\n标题]', content: '第一块' }]]) {
        const compiled = compile(parts, { memoryParts, worldInfoBefore: '第一块\n第二块' });
        assert.equal(memory(compiled).messages[0].content, `【相关经历与资料】\n${compose(parts)}`);
    }
});

test('successful empty recall has an inspectable empty entry, without a no-results model message', () => {
    const compiled = compile([], { animaStatus: 'empty', animaMemory: '' });
    assert.equal(memory(compiled).status, 'empty');
    assert.deepEqual(memory(compiled).messages, []);
    assert.ok(!compiled.messages.some(message => /无结果|未找到相关记忆|相关经历与资料/.test(message.content)));
});
