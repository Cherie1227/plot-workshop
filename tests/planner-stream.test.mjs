import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPlan, readChatCompletionResponse } from '../lib/planner.js';

const xml = '<content><plot>当面解释</plot><characters><character name="林澄"><emotion>仍有戒心</emotion><response>询问来意</response></character></characters><segments><segment index="1">林澄停在门边，询问对方为何来访。</segment></segments><end_state>停在对方回答前</end_state></content>';
const base = { baseUrl: 'https://planner.invalid/v1', apiKey: 'secret-test-key', model: 'fixture', messages: [{ role: 'user', content: 'fixture input' }] };
const encoder = new TextEncoder();
const event = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (content, extra = {}) => ({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });
const finish = (reason = 'stop') => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const complete = (content = xml) => event(delta(content)) + event(finish()) + event('[DONE]');
function response(text, { chunkSize = 0, hang = false, error = null, contentType = 'text/event-stream; charset=utf-8' } = {}) {
    const bytes = typeof text === 'string' ? encoder.encode(text) : text;
    let offset = 0, cancellations = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (offset < bytes.length) {
                const end = chunkSize ? Math.min(offset + chunkSize, bytes.length) : bytes.length;
                controller.enqueue(bytes.slice(offset, end)); offset = end;
            } else if (error) controller.error(error);
            else if (!hang) controller.close();
        },
        cancel() { cancellations++; },
    });
    return { value: new Response(stream, { headers: { 'content-type': contentType } }), cancelled: () => cancellations };
}
const plan = (text, options = {}, streamOptions = {}) => requestPlan({ ...base, stream: true, ...options, transport: async () => response(text, streamOptions).value });

test('streaming combines content, explicit reasoning and usage without mixing another choice', async () => {
    let captured;
    const first = xml.slice(0, 80), rest = xml.slice(80);
    const chunks = [
        { choices: [{ index: 1, delta: { content: 'NEVER_MIX_OTHER_CHOICE' }, finish_reason: 'stop' }, { index: 0, delta: { role: 'assistant', reasoning_content: '先观察🙂\n', reasoning: '备用' }, finish_reason: null }] },
        delta(`前置分析\n${first}`, { reasoning_content: [{ type: 'text', text: '再回应' }, { type: 'encrypted', text: 'DO_NOT_EXPOSE' }], reasoning: '分析' }),
        delta([{ type: 'text', text: rest }, { type: 'text', text: '\n<ecot>后置分析</ecot>' }]),
        finish(), { choices: [], usage: { prompt_tokens: 31, completion_tokens: 42, total_tokens: 73, raw: 'NO_USAGE_BODY' } }, '[DONE]',
    ];
    const result = await requestPlan({ ...base, stream: true, transport: async request => { captured = request; return response(chunks.map(event).join(''), { chunkSize: 7 }).value; } });
    assert.equal(captured.body.stream, true);
    assert.equal(captured.headers.Authorization, 'Bearer secret-test-key');
    assert.equal(result.plot, '当面解释');
    assert.equal(result.raw, `前置分析\n${xml}\n<ecot>后置分析</ecot>`);
    assert.deepEqual(result.analysis, { reasoning: '先观察🙂\n再回应', supplement: '前置分析\n\n<ecot>后置分析</ecot>', truncated: false });
    assert.deepEqual(result.usage, { prompt_tokens: 31, completion_tokens: 42, total_tokens: 73 });
    assert.equal(result.xml.includes('分析'), false);
    assert.equal(JSON.stringify(result).includes('NEVER_MIX'), false);
});

test('SSE supports byte-split UTF-8, CRLF, comments, BOM and multiline data fields', async () => {
    const json = JSON.stringify(delta(xml));
    const at = json.indexOf('"choices"');
    const text = `\uFEFF: heartbeat\r\nid: 1\r\nevent: message\r\ndata: ${json.slice(0, at)}\r\ndata: ${json.slice(at)}\r\n\r\n${event(finish()).replaceAll('\n', '\r\n')}data:[DONE]\r\n\r\n`;
    const result = await plan(text, {}, { chunkSize: 1 });
    assert.equal(result.raw, xml);
    assert.deepEqual(result.analysis, { reasoning: '', supplement: '', truncated: false });
});

test('an explicit stop permits normal EOF and a final SSE line need not have a trailing newline', async () => {
    for (const text of [event(delta(xml)) + event(finish()), event(delta(xml)) + `data: ${JSON.stringify(finish())}`, complete(xml).trimEnd()]) {
        assert.equal((await plan(text)).raw, xml);
    }
    const fallback = await plan(event(delta(xml, { reasoning_content: { unknown: 'IGNORE' }, reasoning: '备用可见分析' })) + event(finish()) + event('[DONE]'));
    assert.equal(fallback.analysis.reasoning, '备用可见分析');
});

test('valid-looking XML alone, DONE without finish and unsupported finishes cannot be delivered', async () => {
    for (const text of [event(delta(xml)), event(delta(xml)) + event('[DONE]'), event('[DONE]'), event(delta(xml)) + event(finish('tool_calls')), event(delta(xml)) + event(finish('unknown')), event(delta(xml)) + event(finish()) + event(delta('extra')) + event('[DONE]')]) {
        await assert.rejects(plan(text), { code: 'OUTPUT_INCOMPLETE' });
    }
    await assert.rejects(plan(event(delta('<content><plot>unfinished')) + event(finish()) + event('[DONE]')), { code: 'CONTENT_TRUNCATED' });
    await assert.rejects(plan(complete(`${xml}${xml}`)), { code: 'CONTENT_MULTIPLE' });
});

test('length and content_filter terminate promptly rather than becoming a timeout while awaiting DONE', async () => {
    for (const [reason, code] of [['length', 'OUTPUT_TRUNCATED'], ['content_filter', 'OUTPUT_INCOMPLETE']]) {
        const source = response(event(delta(xml)) + event(finish(reason)), { hang: true });
        await assert.rejects(requestPlan({ ...base, stream: true, timeoutMs: 1000, transport: async () => source.value }), { code });
        assert.equal(source.cancelled(), 1);
    }
    const aggregate = await readChatCompletionResponse(response(event(delta('partial')) + event(finish('length'))).value, { stream: true });
    assert.equal(aggregate.choices[0].finish_reason, 'length', 'API test and diagnosis retain their own error wording');
});

test('HTTP 524 and precise safe timeout indicators are distinct from output truncation', async () => {
    for (const status of [408, 504, 524]) {
        await assert.rejects(requestPlan({ ...base, stream: true, transport: async () => new Response('DO_NOT_EXPOSE_SECRET', { status }) }), error => error.code === 'UPSTREAM_TIMEOUT' && !error.message.includes('DO_NOT_EXPOSE'));
    }
    for (const error of [{ code: 'upstream_timeout', message: 'secret-test-key' }, { type: 'ETIMEDOUT', message: '<content>private</content>' }, { message: 'Request timed out.' }, { status: 524 }, ...[408, 504, 524].map(code => ({ message: `status code ${code}` })), { message: 'Status Code 524' }]) {
        await assert.rejects(requestPlan({ ...base, transport: async () => new Response(JSON.stringify({ error })) }), { code: 'UPSTREAM_TIMEOUT' });
    }
    for (const error of [{ message: 'Request timed out. private-story secret-test-key' }, { message: 'status code 524 private-story secret-test-key' }, { code: 'unknown', message: 'timeout is only mentioned in private-story' }, 'secret-test-key']) {
        await assert.rejects(requestPlan({ ...base, transport: async () => new Response(JSON.stringify({ error })) }), caught => caught.code === 'API_ERROR' && !/private-story|secret-test-key/.test(caught.message));
    }
    for (const [maxTokens, expected] of [[undefined, /未指定输出上限，由接口决定/], [60000, /当前指定输出上限为 60000 tokens/]]) {
        await assert.rejects(plan(event(delta(xml)) + event(finish('length')), { maxTokens }), error => error.code === 'OUTPUT_TRUNCATED' && expected.test(error.message) && /核对返回用量/.test(error.message) && !/提高/.test(error.message));
    }
    await assert.rejects(requestPlan({ ...base, stream: true, maxTokens: 60000, transport: async () => new Response(JSON.stringify({ error: { message: 'status code 524' } })) }), { code: 'UPSTREAM_TIMEOUT' });
});

test('SSE error events and malformed events never expose upstream bodies', async () => {
    for (const text of [event({ error: { message: 'private-story secret-test-key' } }), 'event: error\ndata: private-story secret-test-key\n\n', 'event: error\ndata: {"message":"private-story secret-test-key"}\n\n']) {
        await assert.rejects(plan(event(delta(xml)) + text), error => error.code === 'API_ERROR' && !/private-story|secret-test-key/.test(error.message));
    }
    await assert.rejects(plan('event: error\ndata: {"code":"request_timeout","message":"private-story"}\n\n'), { code: 'UPSTREAM_TIMEOUT' });
    await assert.rejects(plan('data: {private-story secret-test-key\n\n'), error => error.code === 'RESPONSE_INVALID' && !/private-story|secret-test-key/.test(error.message));
});

test('abort and timeout cancel a stalled reader without delivering partial XML', async () => {
    const signal = new AbortController();
    const aborted = response(event(delta(xml)), { hang: true });
    const pending = requestPlan({ ...base, stream: true, signal: signal.signal, transport: async () => aborted.value });
    await new Promise(resolve => setTimeout(resolve, 0)); signal.abort();
    await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(aborted.cancelled(), 1);
    const timed = response(event(delta(xml)), { hang: true });
    await assert.rejects(requestPlan({ ...base, stream: true, timeoutMs: 10, transport: async () => timed.value }), { code: 'TIMEOUT' });
    assert.equal(timed.cancelled(), 1);
    const standalone = new AbortController();
    const direct = response(event(delta('OK')), { hang: true });
    const reading = readChatCompletionResponse(direct.value, { signal: standalone.signal });
    standalone.abort(); await assert.rejects(reading, { code: 'ABORTED' }); assert.equal(direct.cancelled(), 1);
});

test('late responses from a transport that ignored cancellation are closed and never parsed', async () => {
    let resolveTransport;
    const pending = requestPlan({ ...base, stream: true, timeoutMs: 10, transport: () => new Promise(resolve => { resolveTransport = resolve; }) });
    await assert.rejects(pending, { code: 'TIMEOUT' });
    const late = response(complete()); resolveTransport(late.value);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(late.cancelled(), 1);
});

test('network failure and invalid UTF-8 are rejected even after a complete-looking partial body', async () => {
    const source = response(event(delta(xml)), { error: new Error('private-story secret-test-key <content>') });
    await assert.rejects(requestPlan({ ...base, stream: true, transport: async () => source.value }), error => error.code === 'NETWORK_ERROR' && !/private-story|secret-test-key|<content>/.test(error.message));
    await assert.rejects(plan(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff])), { code: 'NETWORK_ERROR' });
});

test('stream limits reject oversized events and accumulated content while analysis retains its own display limit', async () => {
    await assert.rejects(plan(`data: ${'x'.repeat(1_000_001)}`), { code: 'OUTPUT_TOO_LARGE' });
    const repeated = Array.from({ length: 5 }, () => event(delta('x'.repeat(450_000)))).join('') + event(finish()) + event('[DONE]');
    await assert.rejects(plan(repeated, {}, { chunkSize: 250_000 }), { code: 'OUTPUT_TOO_LARGE' });
    const result = await plan(event(delta(`${'附'.repeat(100_001)}\n${xml}`, { reasoning_content: '思'.repeat(100_001) })) + event(finish()) + event('[DONE]'));
    assert.equal(result.analysis.reasoning.length, 100_000); assert.equal(result.analysis.supplement.length, 100_000); assert.equal(result.analysis.truncated, true);
    assert.equal(result.raw, `${'附'.repeat(100_001)}\n${xml}`);
});

test('JSON fallback and non-streaming defaults preserve existing behavior; declared SSE is always validated', async () => {
    let streaming;
    const json = { choices: [{ message: { content: xml }, finish_reason: 'stop' }], usage: { total_tokens: 17 } };
    const result = await requestPlan({ ...base, stream: true, transport: async request => { streaming = request.body.stream; return new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } }); } });
    assert.equal(streaming, true); assert.equal(result.raw, xml); assert.equal(result.usage.total_tokens, 17);
    await requestPlan({ ...base, transport: async request => { assert.equal(request.body.stream, false); return new Response(JSON.stringify({ choices: [{ message: { content: xml } }] })); } });
    await assert.rejects(requestPlan({ ...base, stream: false, transport: async () => response(event(delta(xml))).value }), { code: 'OUTPUT_INCOMPLETE' });
    await assert.rejects(requestPlan({ ...base, stream: 'true', transport: async () => { throw new Error('must not send'); } }), { code: 'PARAMETER_INVALID' });
});

test('shared reader can deliver plain connection/diagnosis text without assuming the XML protocol', async () => {
    const source = response(complete('OK'), { hang: true });
    const result = await readChatCompletionResponse(source.value, { stream: true });
    assert.equal(result.choices[0].message.content, 'OK'); assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(source.cancelled(), 1); assert.equal(source.value.body.locked, false);
    await assert.rejects(readChatCompletionResponse({ ok: true, headers: { get: () => 'text/event-stream' } }), { code: 'TRANSPORT_INVALID' });
});
