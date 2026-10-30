import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelList, testApiConnection, requestDiagnosis } from '../lib/api.js';

const options = { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }) }), baseUrl: 'https://example.invalid/v1/chat/completions', apiKey: 'private-test-key', model: 'fixture-model' };
const ok = data => ({ ok: true, json: async () => data });
test('models use ST proxy and independent credentials; IDs deduplicated', async () => {
    let sent;
    const models = await fetchModelList({ ...options, fetchImpl: async (url, init) => { sent = { url, ...init, body: JSON.parse(init.body) }; return ok({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, {}] }); } });
    assert.deepEqual(models, ['a', 'b']);
    assert.equal(sent.url, '/api/backends/chat-completions/status');
    assert.equal(sent.body.reverse_proxy, 'https://example.invalid/v1');
    assert.equal(sent.body.proxy_password, options.apiKey);
    assert.equal(sent.body.chat_completion_source, 'openai');
    assert.equal(sent.headers['X-CSRF-Token'], 'fixture');
    assert.equal(sent.credentials, 'same-origin');
});
test('connection test generates a small independent request without story context', async () => {
    let sent;
    assert.match((await testApiConnection({ ...options, fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return ok({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }); } })).message, /连接成功/);
    assert.equal(sent.url, '/api/backends/chat-completions/generate');
    assert.equal(sent.body.model, 'fixture-model');
    assert.equal(sent.body.stream, false);
    assert.equal(sent.body.max_tokens, 64);
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
});
test('wrapped upstream errors, empty lists and invalid JSON are not successes', async () => {
    for (const [data, code] of [[{ error: 'private-test-key' }, 'API_ERROR'], [{ data: [] }, 'MODELS_EMPTY'], [{ models: [] }, 'MODELS_UNSUPPORTED']]) {
        await assert.rejects(fetchModelList({ ...options, fetchImpl: async () => ok(data) }), e => e.code === code && !e.message.includes(options.apiKey));
    }
    await assert.rejects(fetchModelList({ ...options, fetchImpl: async () => ({ ok: true, json: () => { throw Error(options.apiKey); } }) }), { code: 'RESPONSE_INVALID' });
});
test('errors do not expose upstream bodies or network exception secrets', async () => {
    await assert.rejects(fetchModelList({ ...options, fetchImpl: async () => { throw Error(options.apiKey); } }), e => e.code === 'NETWORK_ERROR' && !e.message.includes(options.apiKey));
    await assert.rejects(fetchModelList({ ...options, fetchImpl: async () => ({ ok: false, status: 401, json: () => { throw Error('must not read'); } }) }), { code: 'HTTP_ERROR' });
});
test('empty/truncated completions are distinguished from successful generation', async () => {
    for (const [choice, code] of [[{ message: { content: '' } }, 'TEST_EMPTY'], [{ message: { content: 'O' }, finish_reason: 'length' }, 'TEST_TRUNCATED']]) {
        await assert.rejects(testApiConnection({ ...options, fetchImpl: async () => ok({ choices: [choice] }) }), { code });
    }
});
test('timeouts and cancellation settle even if transport ignores abort', async () => {
    const fetchImpl = () => new Promise(() => {});
    await assert.rejects(fetchModelList({ ...options, fetchImpl, timeoutMs: 10 }), { code: 'TIMEOUT' });
    const controller = new AbortController();
    const promise = fetchModelList({ ...options, fetchImpl, signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, { code: 'ABORTED' });
});
test('invalid URL/model/key rejected before network access', async () => {
    const fetchImpl = () => { throw Error('unexpected'); };
    await assert.rejects(fetchModelList({ ...options, fetchImpl, baseUrl: 'https://x.test?key=secret' }), { code: 'ENDPOINT_INVALID' });
    await assert.rejects(fetchModelList({ ...options, fetchImpl, apiKey: 'a\nb' }), { code: 'KEY_INVALID' });
    await assert.rejects(testApiConnection({ ...options, fetchImpl, model: '' }), { code: 'MODEL_REQUIRED' });
});
test('diagnosis returns validated choices without adopting them', async () => {
    const result = { summary: '当前缺少新的信息。', options: [{ title: '增加信息', direction: '让角色先询问来意。' }] };
    let sent;
    const actual = await requestDiagnosis({ ...options, messages: [{ role: 'user', content: 'fixture context' }], fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body); return ok({ choices: [{ message: { content: JSON.stringify({ ...result, apiKey: 'discarded' }) } }] });
    } });
    assert.deepEqual(actual, result);
    assert.equal(sent.messages[0].content, 'fixture context');
    const instruction = sent.messages.at(-1).content;
    const contract = JSON.parse(instruction.slice(instruction.indexOf('{'), instruction.lastIndexOf('}') + 1));
    assert.deepEqual(Object.keys(contract), ['summary', 'options']);
    assert.deepEqual(Object.keys(contract.options[0]), ['title', 'direction']);
    for (const content of ['not JSON', '{"summary":"x","options":[{"title":"x"}]}']) {
        await assert.rejects(requestDiagnosis({ ...options, messages: sent.messages, fetchImpl: async () => ok({ choices: [{ message: { content } }] }) }), { code: 'DIAGNOSIS_INVALID' });
    }
});
