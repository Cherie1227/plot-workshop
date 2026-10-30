import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSettingsBeforeReload } from '../lib/settings-save.js';

function fixture(save) {
    const handlers = new Map(), calls = { save: 0, on: 0, remove: 0 };
    const module = {
        event_types: { SETTINGS_UPDATED: 'settings_updated' },
        eventSource: {
            on(event, listener) { calls.on++; if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(listener); },
            removeListener(event, listener) { calls.remove++; handlers.get(event)?.delete(listener); },
            emit(event) { for (const handler of handlers.get(event) || []) handler(); },
        },
        saveSettings() { calls.save++; return save(module); },
        get settings() { assert.fail('Save confirmation must not inspect or serialize private settings'); },
    };
    return { module, calls, listeners: () => handlers.get('settings_updated')?.size || 0 };
}

test('successful synchronous SETTINGS_UPDATED confirmation resolves and removes its listener', async () => {
    const f = fixture(module => module.eventSource.emit(module.event_types.SETTINGS_UPDATED));
    assert.equal(await saveSettingsBeforeReload(f.module), undefined);
    assert.deepEqual(f.calls, { save: 1, on: 1, remove: 1 }); assert.equal(f.listeners(), 0);
});

test('successful event is not sufficient until the save call itself completes', async () => {
    let finish;
    const f = fixture(module => {
        module.eventSource.emit(module.event_types.SETTINGS_UPDATED);
        return new Promise(resolve => { finish = resolve; });
    });
    let confirmed = false;
    const saving = saveSettingsBeforeReload(f.module).then(() => { confirmed = true; });
    await Promise.resolve(); assert.equal(confirmed, false); assert.equal(f.listeners(), 1);
    finish(); await saving; assert.equal(confirmed, true); assert.equal(f.listeners(), 0);
});

test('swallowed failures, resolved values and early returns cannot masquerade as successful saves', async t => {
    for (const [name, save] of [
        ['swallowed error', async () => { try { throw new Error('private settings body'); } catch { /* Mirrors the host swallowing a failed request. */ } }],
        ['early return', () => undefined],
        ['returned success without event', async () => ({ ok: true })],
    ]) await t.test(name, async () => {
        const f = fixture(save);
        await assert.rejects(saveSettingsBeforeReload(f.module), error => {
            assert.equal(error.code, 'SETTINGS_SAVE_UNCONFIRMED'); assert.doesNotMatch(error.message, /private settings body/); return true;
        });
        assert.equal(f.listeners(), 0); assert.equal(f.calls.remove, 1);
    });
});

test('unrelated events do not count as SETTINGS_UPDATED', async () => {
    const f = fixture(module => module.eventSource.emit('settings_loaded'));
    await assert.rejects(saveSettingsBeforeReload(f.module), { code: 'SETTINGS_SAVE_UNCONFIRMED' });
    assert.equal(f.listeners(), 0);
});

test('thrown and rejected host errors are replaced by a fixed error without private payloads', async t => {
    for (const [name, save] of [
        ['sync throw', () => { throw new Error('SECRET_KEY private setting contents'); }],
        ['async rejection', async () => { throw new Error('SECRET_KEY private setting contents'); }],
        ['event then failure', async module => { module.eventSource.emit(module.event_types.SETTINGS_UPDATED); throw new Error('SECRET_KEY'); }],
    ]) await t.test(name, async () => {
        const f = fixture(save);
        await assert.rejects(saveSettingsBeforeReload(f.module), error => {
            assert.equal(error.code, 'SETTINGS_SAVE_FAILED'); assert.doesNotMatch(error.message, /SECRET_KEY|private setting contents/); return true;
        });
        assert.equal(f.listeners(), 0); assert.equal(f.calls.remove, 1);
    });
});

test('missing save or event interfaces fail before invoking host persistence', async t => {
    for (const missing of ['saveSettings', 'eventSource', 'on', 'removeListener', 'SETTINGS_UPDATED']) {
        await t.test(missing, async () => {
            const f = fixture(() => assert.fail('Unsupported host must not start a save'));
            if (['on', 'removeListener'].includes(missing)) delete f.module.eventSource[missing];
            else if (missing === 'SETTINGS_UPDATED') delete f.module.event_types.SETTINGS_UPDATED;
            else delete f.module[missing];
            await assert.rejects(saveSettingsBeforeReload(f.module), { code: 'SETTINGS_SAVE_UNSUPPORTED' });
            assert.equal(f.calls.save, 0); assert.equal(f.listeners(), 0);
        });
    }
});

test('timeout rejects by 30 seconds, removes listener and ignores a late successful event and resolution', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    let confirmed = false;
    const saving = saveSettingsBeforeReload(f.module).then(() => { confirmed = true; });
    const rejected = assert.rejects(saving, { code: 'SETTINGS_SAVE_TIMEOUT' });
    t.mock.timers.tick(29_999); await Promise.resolve(); assert.equal(f.listeners(), 1);
    t.mock.timers.tick(1); await rejected;
    assert.equal(f.listeners(), 0); assert.equal(f.calls.remove, 1); assert.equal(confirmed, false);
    f.module.eventSource.emit(f.module.event_types.SETTINGS_UPDATED); finish();
    await Promise.resolve(); await Promise.resolve(); assert.equal(confirmed, false); assert.equal(f.listeners(), 0);
});

test('a timed-out save cannot be rescued by an earlier success event while its promise remains pending', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(module => { module.eventSource.emit(module.event_types.SETTINGS_UPDATED); return new Promise(() => {}); });
    const rejected = assert.rejects(saveSettingsBeforeReload(f.module), { code: 'SETTINGS_SAVE_TIMEOUT' });
    t.mock.timers.tick(30_000); await rejected; assert.equal(f.listeners(), 0);
});
