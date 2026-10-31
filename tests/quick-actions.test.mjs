import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWriterQuickActions } from '../lib/quick-actions.js';

function host({ parser = true } = {}) {
    let registrations = 0;
    let creations = 0;
    const Parser = { commands: {}, addCommandObject(command) { registrations++; this.commands[command.name] = command; } };
    const context = parser ? { SlashCommandParser: Parser, SlashCommand: { fromProps: props => ({ aliases: [], ...props }) } } : {};
    const document = {
        createElement() { creations++; return {}; },
        createElementNS() { creations++; return {}; },
        querySelector() { return null; },
    };
    return { Parser, context, document, count: () => registrations, creations: () => creations };
}

function install(h, { available = () => true, onRewrite = async () => {} } = {}) {
    return createWriterQuickActions({ getContext: () => h.context, onRewrite, canRewrite: available });
}

test('registers one no-argument command without creating composer or menu UI', async () => {
    const previous = globalThis.document;
    const h = host(); globalThis.document = h.document;
    let calls = 0; let eligible = true;
    try {
        const actions = install(h, { available: () => eligible, onRewrite: async () => { calls++; } });
        assert.equal(h.creations(), 0);
        assert.equal(h.Parser.commands['ves-rewrite'].helpString, '沿用本轮大纲重写最后一条正文，不重新规划。');
        actions.refresh(); actions.refresh(); assert.equal(h.count(), 1);
        eligible = false;
        assert.equal(await h.Parser.commands['ves-rewrite'].callback({}, 'ignored'), ''); assert.equal(calls, 0);
        eligible = true;
        assert.equal(await h.Parser.commands['ves-rewrite'].callback(), ''); assert.equal(calls, 1);
        actions.destroy();
    } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('in-flight guard and destruction deactivate retained command callbacks', async () => {
    const h = host(); let calls = 0; let resolve;
    const actions = install(h, { onRewrite: () => { calls++; return new Promise(done => { resolve = done; }); } });
    const command = h.Parser.commands['ves-rewrite']; const pending = command.callback();
    await command.callback(); assert.equal(calls, 1);
    actions.destroy(); assert.equal(h.Parser.commands['ves-rewrite'], undefined);
    resolve(); await pending; await command.callback(); assert.equal(calls, 1);
});

test('foreign commands are neither overwritten nor removed', async () => {
    const h = host(); const foreign = { callback: () => 'foreign' }; h.Parser.commands['ves-rewrite'] = foreign;
    const actions = install(h);
    assert.equal(h.count(), 0);
    actions.refresh(); actions.destroy(); assert.equal(h.Parser.commands['ves-rewrite'], foreign);
});

test('a replacement command survives destruction of our original registration', async () => {
    const h = host(); let calls = 0;
    const actions = install(h, { onRewrite: async () => { calls++; } });
    const old = h.Parser.commands['ves-rewrite']; const replacement = {}; h.Parser.commands['ves-rewrite'] = replacement;
    actions.refresh(); actions.destroy(); assert.equal(h.Parser.commands['ves-rewrite'], replacement);
    await old.callback(); assert.equal(calls, 0);
});

test('late APIs and repeated installation keep one live command', async () => {
    const h = host(); let current = {}; let oldCalls = 0; let newCalls = 0;
    const first = createWriterQuickActions({ getContext: () => current, onRewrite: async () => { oldCalls++; }, canRewrite: () => true });
    assert.equal(h.count(), 0); current = h.context; first.refresh(); assert.equal(h.count(), 1);
    const old = h.Parser.commands['ves-rewrite'];
    const second = install(h, { onRewrite: async () => { newCalls++; } });
    first.refresh(); first.destroy();
    await old.callback(); await h.Parser.commands['ves-rewrite'].callback(); assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
    second.destroy();
});

test('read-only or opaque command registries leave inert callbacks and safely reuse them', async () => {
    const h = host(); let calls = 0;
    const first = install(h, { onRewrite: async () => { calls++; } });
    const command = h.Parser.commands['ves-rewrite']; Object.freeze(h.Parser.commands); first.destroy();
    await command.callback(); assert.equal(calls, 0);
    const second = install(h, { onRewrite: async () => { calls++; } });
    assert.equal(h.count(), 1); await command.callback(); assert.equal(calls, 1); second.destroy();
});

test('missing command APIs are safe and failed availability stays disabled', async () => {
    const h = host({ parser: false });
    const actions = install(h, { available: () => { throw new Error('not ready'); }, onRewrite: async () => { throw new Error('must not run'); } });
    actions.refresh(); actions.destroy();
    const ready = host();
    const inactive = install(ready, { available: () => { throw new Error('not ready'); }, onRewrite: async () => { throw new Error('must not run'); } });
    assert.equal(await ready.Parser.commands['ves-rewrite'].callback(), ''); inactive.destroy();
});
