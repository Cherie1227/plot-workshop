import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLog } from '../lib/runtime-log.js';

test('runtime log preserves array identity while bounding entries and clearing', () => {
    const log = createRuntimeLog({ limit: 2 }), reference = log.entries;
    log.add('info', 'one', '第一条'); log.add('success', 'two', '第二条'); log.add('warn', 'three', '第三条');
    assert.equal(log.entries, reference); assert.deepEqual(log.entries.map(e => e.event), ['two', 'three']);
    assert.equal(log.entries[1].id, 3); assert.equal(log.entries[1].level, 'warn');
    assert.ok(!Number.isNaN(Date.parse(log.entries[0].timestamp)));
    log.clear(); assert.equal(log.entries, reference); assert.equal(reference.length, 0); assert.equal(log.text(), '');
});

test('details only include whitelisted scalar metadata and never invoke getters', () => {
    let getterCalls = 0;
    const details = { stage: 'planning', model: 'planner', method: 'POST', durationMs: 52, success: true,
        prompt: 'private prompt', input: 'private user input', response: 'private prose', apiKey: 'private key', headers: { Authorization: 'Bearer hidden' },
        messageCount: 4, position: ['not scalar'], source: { text: 'not scalar' }, count: Infinity };
    Object.defineProperty(details, 'status', { enumerable: true, get() { getterCalls++; return 'hidden'; } });
    const log = createRuntimeLog();
    const entry = log.add('info', 'request.complete', '请求已完成', details);
    assert.deepEqual(entry.details, { stage: 'planning', model: 'planner', method: 'POST', durationMs: 52, messageCount: 4, success: true });
    assert.equal(getterCalls, 0);
    const exported = log.text();
    for (const value of ['private prompt', 'private user input', 'private prose', 'private key', 'Authorization', 'not scalar']) assert.ok(!exported.includes(value));
});

test('non-text message objects and dialogue arrays are not serialized', () => {
    const log = createRuntimeLog();
    const secretObject = { messages: [{ role: 'user', content: '聊天正文' }], toString() { throw new Error('must not stringify'); } };
    log.add('info', 'request', secretObject, secretObject);
    log.add('error', 'failed', new Error('响应中的私人内容'), [{ role: 'assistant', content: '规划正文' }]);
    assert.equal(log.entries[0].message, '[已省略非文本消息]');
    for (const value of ['聊天正文', '私人内容', '规划正文']) assert.ok(!log.text().includes(value));
});

test('current and previously known keys are redacted in every text field', () => {
    let keys = ['first-key-123'];
    const log = createRuntimeLog({ getSecrets: () => keys });
    log.add('info', 'first-key-123.event', '使用 first-key-123', { model: 'model-first-key-123', source: 'first-key-123' });
    keys = ['second-key-456'];
    log.add('error', 'retry', 'first-key-123 与 second-key-456 均不可见', { code: 'second-key-456' });
    const exported = log.text();
    assert.ok(!exported.includes('first-key-123')); assert.ok(!exported.includes('second-key-456')); assert.ok(exported.includes('[REDACTED]'));
    log.clear(); keys = [];
    log.add('warn', 'after.clear', 'first-key-123 second-key-456');
    assert.ok(!log.text().includes('first-key-123')); assert.ok(!log.text().includes('second-key-456'));
});

test('newly declared keys redact existing entries before export without replacing state reference', () => {
    let keys = [];
    const log = createRuntimeLog({ getSecrets: () => keys }), reference = log.entries;
    log.add('info', 'old', 'latent-key-123', { model: 'latent-key-123' });
    keys = ['latent-key-123'];
    const exported = log.text();
    assert.ok(!exported.includes('latent-key-123')); assert.equal(reference, log.entries);
    assert.equal(reference[0].message, '[REDACTED]'); assert.equal(reference[0].details.model, '[REDACTED]');
});

test('keys are redacted before truncation including URL-encoded forms', () => {
    const key = 'special+key/123=';
    const log = createRuntimeLog({ getSecrets: () => [key] });
    log.add('info', 'x'.repeat(100), `${'a'.repeat(595)}${key} tail`, { source: encodeURIComponent(key), model: 'm'.repeat(300) });
    const entry = log.entries[0];
    assert.ok(entry.message.length <= 600); assert.ok(entry.event.length <= 64); assert.ok(entry.details.model.length <= 160);
    assert.ok(!entry.message.includes('special')); assert.equal(entry.details.source, '[REDACTED]');
});

test('standard credential labels and authorization schemes are redacted without known keys', () => {
    const log = createRuntimeLog();
    log.add('error', 'auth', 'Bearer opaque-token-123 api_key=plain-key-456 password="password-value" sk-privatekey123456');
    const exported = log.text();
    for (const value of ['opaque-token-123', 'plain-key-456', 'password-value', 'sk-privatekey123456']) assert.ok(!exported.includes(value));
});

test('exports contain only bounded in-memory entries and require no browser storage', () => {
    const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('No persistence allowed'); } });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('No persistence allowed'); } });
    try {
        const log = createRuntimeLog({ limit: 1 });
        log.add('invalid', 'old', '不应导出'); log.add('info', 'new', '准备就绪', { status: 'ready' });
        assert.equal(log.entries[0].level, 'info'); assert.match(log.text(), /INFO new: 准备就绪/); assert.ok(!log.text().includes('不应导出'));
        log.clear(); assert.equal(log.text(), '');
    } finally {
        if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else delete globalThis.localStorage;
        if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession); else delete globalThis.sessionStorage;
    }
});
