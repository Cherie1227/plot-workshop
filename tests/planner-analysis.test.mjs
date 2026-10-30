import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPlan } from '../lib/planner.js';

const xml = '<content><plot>当面解释</plot><characters><character name="林澄"><emotion>仍有戒心</emotion><response>询问来意</response></character></characters><segments><segment index="1">林澄停在门边，询问对方为何来访。</segment></segments><end_state>停在对方回答前</end_state></content>';
const request = async message => requestPlan({
    baseUrl: 'https://planner.invalid/v1', model: 'fixture', messages: [{ role: 'user', content: 'fixture input' }],
    transport: async () => ({ ok: true, json: async () => ({ choices: [{ message, finish_reason: 'stop' }], usage: { total_tokens: 42 } }) }),
});

test('visible reasoning fields remain separate from the parsed plan and raw content', async () => {
    const primary = await request({ content: xml, reasoning_content: '第一行\n第二行', reasoning: '备用返回' });
    assert.deepEqual(primary.analysis, { reasoning: '第一行\n第二行', supplement: '', truncated: false });
    assert.equal(primary.raw, xml);
    assert.equal(primary.plot, '当面解释');
    assert.equal(primary.xml.includes('第一行'), false);
    assert.deepEqual(primary.usage, { total_tokens: 42 });
    const fallback = await request({ content: xml, reasoning_content: ' \n ', reasoning: '备用第一行\n备用第二行' });
    assert.equal(fallback.analysis.reasoning, '备用第一行\n备用第二行');
});

test('text before and after the original content block is preserved even when XML is canonicalized', async () => {
    const raw = `前置分析第一行\n前置分析第二行\n${xml}\n后置补充`;
    const result = await request({ content: raw });
    assert.notEqual(result.xml, xml, 'The protocol parser canonicalizes whitespace');
    assert.equal(result.analysis.supplement, '前置分析第一行\n前置分析第二行\n\n后置补充');
    assert.equal(result.analysis.reasoning, '');
    assert.equal(result.analysis.truncated, false);
    assert.equal(result.raw, raw);
    assert.equal(result.analysis.supplement.includes('<content'), false);
});

test('a response containing only XML has empty analysis, including common outer fences', async () => {
    for (const raw of [xml, ` \n${xml}\n `, `\`\`\`xml\n${xml}\n\`\`\``, `~~~xml\r\n${xml}\r\n~~~`, `\`\`\`\`text\n${xml}\n\`\`\`\``]) {
        const result = await request({ content: raw });
        assert.deepEqual(result.analysis, { reasoning: '', supplement: '', truncated: false });
        assert.equal(result.raw, raw);
    }
});

test('analysis tags are preserved without a tag whitelist', async () => {
    const before = '<ecot>事情尚未解决\n人物仍在犹豫</ecot>\n<thinking>选择先询问</thinking>';
    const after = '<vendor_notes data-kind="custom">未归类的额外返回</vendor_notes>\n<think>补充</think>';
    const result = await request({ content: `${before}\n${xml}\n${after}` });
    assert.equal(result.analysis.supplement, `${before}\n\n${after}`);
    assert.equal(result.xml.includes('ecot'), false);
    const wrapped = await request({ content: `\`\`\`text\n${before}\n${xml}\n${after}\n\`\`\`` });
    assert.equal(wrapped.analysis.supplement, result.analysis.supplement);
});

test('only the whole-response Markdown wrapper is removed; other fenced text remains visible', async () => {
    const before = '额外返回\n```text\n保留这段代码式文字\n```';
    const raw = `${before}\n${xml}\n后文`;
    assert.equal((await request({ content: raw })).analysis.supplement, `${before}\n\n后文`);
    const separateFences = `\`\`\`text\n前文\n\`\`\`\n${xml}\n\`\`\`text\n后文\n\`\`\``;
    assert.equal((await request({ content: separateFences })).analysis.supplement, separateFences.replace(xml, ''));
});

test('explicit text arrays are supported without serializing unknown reasoning objects', async () => {
    const result = await request({
        content: [{ type: 'text', text: '附加返回\n' }, { type: 'text', text: xml }],
        reasoning_content: [{ type: 'text', text: '推理第一行\n' }, { type: 'encrypted', data: 'DO_NOT_EXPOSE' }, { type: 'text', text: '推理第二行' }, { text: 'UNKNOWN_STRUCTURE' }],
    });
    assert.deepEqual(result.analysis, { reasoning: '推理第一行\n推理第二行', supplement: '附加返回', truncated: false });
    assert.equal(result.raw, `附加返回\n${xml}`);
    for (const unknown of [{ text: 'UNKNOWN_OBJECT' }, { details: [{ text: 'UNKNOWN_DETAILS' }] }, { encrypted: 'UNKNOWN_ENCRYPTED' }, 123, null]) {
        const ignored = await request({ content: xml, reasoning_content: unknown, reasoning: unknown });
        assert.equal(ignored.analysis.reasoning, '');
    }
    const fallback = await request({ content: xml, reasoning_content: { details: 'ignored' }, reasoning: [{ type: 'text', text: '明确返回的文本' }] });
    assert.equal(fallback.analysis.reasoning, '明确返回的文本');
});

test('each analysis field is independently bounded and reports truncation without changing raw or XML', async () => {
    const reasoning = '思'.repeat(100_001), supplement = '附'.repeat(100_002);
    const raw = `${supplement}\n${xml}`;
    const result = await request({ content: raw, reasoning_content: reasoning });
    assert.equal(result.analysis.reasoning, reasoning.slice(0, 100_000));
    assert.equal(result.analysis.supplement, supplement.slice(0, 100_000));
    assert.equal(result.analysis.truncated, true);
    assert.equal(result.raw, raw);
    assert.equal(result.plot, '当面解释');
    assert.equal((await request({ content: xml, reasoning: '思'.repeat(100_000) })).analysis.truncated, false);
    const onlyReasoning = await request({ content: xml, reasoning_content: `${'思'.repeat(99_999)}😀` });
    assert.equal(onlyReasoning.analysis.reasoning, '思'.repeat(99_999));
    assert.equal(onlyReasoning.analysis.truncated, true);
    assert.equal((await request({ content: raw })).analysis.truncated, true);
});

test('additional analysis cannot make multiple or malformed content blocks acceptable', async () => {
    await assert.rejects(request({ content: `<ecot>说明</ecot>${xml}\n${xml}`, reasoning_content: '可见分析' }), { code: 'CONTENT_MULTIPLE' });
    await assert.rejects(request({ content: '<think>说明</think><content><plot>缺失字段</plot></content>' }), { name: 'ContentError' });
    await assert.rejects(request({ content: [{ type: 'text', text: xml }, { type: 'image_url', image_url: {} }] }), { code: 'RESPONSE_INVALID' });
});
