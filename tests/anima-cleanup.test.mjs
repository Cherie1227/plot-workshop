import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimaCleanupGuard } from '../lib/anima-cleanup.js';

const name = '[ANIMA_Chat_History_Container]';
const proof = { chatId: 'chat', bookName: 'book', entries: [{ uid: 1, name, content: 'verified' }] };
const book = { entries: { 1: { uid: 1, comment: name, content: 'verified', order: 100 } }, extensions: { preserved: true } };
const cleaned = () => { const value = structuredClone(book); value.entries[1].content = ''; return value; };

test('cleanup requires both a captured full payload and matching readback proof', () => {
    for (const variant of ['missing snapshot', 'missing proof', 'wrong book', 'wrong chat', 'wrong uid', 'wrong content']) {
        const guard = createAnimaCleanupGuard();
        if (variant !== 'missing snapshot') guard.observe('book', book);
        const verified = structuredClone(proof);
        if (variant === 'wrong book') verified.bookName = 'different';
        if (variant === 'wrong chat') verified.chatId = 'different';
        if (variant === 'wrong uid') verified.entries[0].uid = 2;
        if (variant === 'wrong content') verified.entries[0].content = 'different';
        guard.authorize(variant === 'missing proof' ? null : verified, 'chat');
        assert.equal(guard.consume('book', cleaned(), 'chat'), null, variant);
    }
});

test('cleanup proof snapshots are isolated, survive exact duplicate saves and reset between chats', () => {
    const guard = createAnimaCleanupGuard(), baseline = structuredClone(book);
    guard.observe('book', baseline); baseline.entries[1].content = 'later caller mutation';
    guard.authorize(proof, 'chat');
    const next = cleaned();
    assert.deepEqual(guard.consume('book', next, 'chat'), { cleared: 1 });
    assert.deepEqual(guard.consume('book', next, 'chat'), { cleared: 0 });
    next.extensions.preserved = false;
    assert.equal(guard.consume('book', next, 'chat'), null);
    guard.reset(); guard.authorize(proof, 'chat');
    assert.equal(guard.consume('book', cleaned(), 'chat'), null);
});

test('a verified empty container list permits only an identical delayed save, never a same-name clear', () => {
    const guard = createAnimaCleanupGuard();
    guard.observe('book', book); guard.authorize({ ...proof, entries: [] }, 'chat');
    assert.deepEqual(guard.consume('book', structuredClone(book), 'chat'), { cleared: 0 });
    assert.equal(guard.consume('book', cleaned(), 'chat'), null);
});
