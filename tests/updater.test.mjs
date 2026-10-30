import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater } from '../lib/updater.js';

const remote = 'https://github.com/Cherie1227/plot-workshop.git';
const version = { currentBranchName: 'main', currentCommitHash: 'abcdef0123456789', isUpToDate: false, remoteUrl: remote };
const ok = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
    const calls = [], changes = [], guards = [], timers = [];
    let clock = 1000, idle = true, catalog = [{ type: options.scope || 'local', name: 'third-party/renamed-画皮' }], current = { ...version }, updateResult = { shortCommitHash: 'abcdef0', isUpToDate: false, remoteUrl: remote }, transport;
    const updater = createUpdater({ extensionUrl: 'https://st.example/scripts/extensions/third-party/renamed-%E7%94%BB%E7%9A%AE/index.js?v=2', currentVersion: '0.2.0',
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-token' }) }),
        fetchImpl: async (url, init) => {
            calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
            if (transport) return transport(url, init);
            return ok(url.endsWith('/discover') ? catalog : url.endsWith('/version') ? current : updateResult);
        },
        onChange: (state, meta) => changes.push({ ...state, ...meta }), canInstall: async automatic => { guards.push(automatic); return idle; },
        now: () => clock, setIntervalImpl: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; }, clearIntervalImpl: timer => { timer.cleared = true; },
        ...options,
    });
    return { updater, state: updater.state, calls, changes, guards, timers,
        setClock(value) { clock = value; }, setIdle(value) { idle = value; }, setCatalog(value) { catalog = value; }, setVersion(value) { current = value; }, setUpdate(value) { updateResult = value; }, setTransport(value) { transport = value; },
        async tick() { timers[0].callback(); for (let i = 0; i < 8; i++) await flush(); },
    };
}

test('default state and precise renamed local scope; auth headers never become updater state', async () => {
    const f = fixture();
    assert.equal(f.state.autoCheck, true); assert.equal(f.state.autoInstall, false); assert.equal(f.state.phase, 'unchecked');
    await f.updater.check();
    assert.equal(f.state.phase, 'available'); assert.equal(f.state.available, true); assert.equal(f.state.currentVersion, '0.2.0'); assert.equal(f.state.checkedAt, 1000);
    assert.deepEqual(f.calls.map(x => [x.url, x.method, x.body]), [
        ['/api/extensions/discover', 'GET', undefined], ['/api/extensions/version', 'POST', { extensionName: 'renamed-画皮', global: false }],
    ]);
    assert.ok(f.calls.every(x => x.credentials === 'same-origin' && x.headers['X-CSRF-Token'] === 'fixture-token'));
    assert.doesNotMatch(JSON.stringify(f.state), /fixture-token/);
});

test('global install rechecks discovery and remote, updates only exact folder, then requires reload', async () => {
    const f = fixture({ scope: 'global' });
    await f.updater.check(); await f.updater.install();
    assert.equal(f.state.phase, 'installed'); assert.equal(f.state.available, false); assert.match(f.state.message, /刷新/);
    assert.deepEqual(f.calls.map(x => x.url), ['/api/extensions/discover', '/api/extensions/version', '/api/extensions/discover', '/api/extensions/version', '/api/extensions/update']);
    assert.ok(f.calls.filter(x => x.body).every(x => JSON.stringify(x.body) === JSON.stringify({ extensionName: 'renamed-画皮', global: true })));
    assert.deepEqual(f.guards, [false, false]);
    const count = f.calls.length; await f.updater.check(); await f.updater.install(); await f.updater.start(); await f.tick();
    assert.equal(f.calls.length, count); f.updater.destroy();
});

test('foreign repository, credentials, lookalike hosts, ZIP and detached head never update', async t => {
    for (const changed of [
        { remoteUrl: 'https://github.com/another/plot-workshop.git' },
        { remoteUrl: 'https://github.com.evil.test/Cherie1227/plot-workshop.git' },
        { remoteUrl: 'https://secret@github.com/Cherie1227/plot-workshop.git' },
        { remoteUrl: 'https://github.com/Cherie1227/plot-workshop.git?token=secret' },
        { remoteUrl: '', currentCommitHash: '', currentBranchName: '', isUpToDate: true },
        { currentBranchName: 'HEAD' },
    ]) await t.test(JSON.stringify(changed), async () => {
        const f = fixture(); f.setVersion({ ...version, ...changed }); await f.updater.check(); await f.updater.install();
        assert.equal(f.state.phase, 'unsupported'); assert.equal(f.state.available, false); assert.equal(f.calls.filter(x => x.url.endsWith('/update')).length, 0); assert.doesNotMatch(f.state.message, /secret/);
    });
});

test('canonical HTTPS and SSH official repository forms accepted', async () => {
    for (const remoteUrl of [remote, 'https://github.com/cherie1227/plot-workshop', 'git@github.com:Cherie1227/plot-workshop.git', 'ssh://git@github.com/Cherie1227/plot-workshop.git']) {
        const f = fixture(); f.setVersion({ ...version, remoteUrl }); await f.updater.check(); assert.equal(f.state.phase, 'available');
    }
});

test('unknown, ambiguous, wrong type and unsafe installation paths fail closed', async () => {
    for (const catalog of [[], [{ type: 'system', name: 'third-party/renamed-画皮' }], [{ type: 'local', name: 'third-party/renamed-画皮' }, { type: 'global', name: 'third-party/renamed-画皮' }], [{ type: 'local', name: 'third-party/plot-workshop' }]]) {
        const f = fixture(); f.setCatalog(catalog); await f.updater.check(); assert.equal(f.state.phase, 'unsupported'); assert.equal(f.calls.length, 1);
    }
    for (const extensionUrl of ['file:///local/plot-workshop/index.js', 'https://st.example/other/index.js', 'https://st.example/scripts/extensions/third-party/foo%2Fbar/index.js']) {
        const f = fixture({ extensionUrl }); await f.updater.check(); assert.equal(f.state.phase, 'unsupported'); assert.equal(f.calls.length, 0);
    }
});

test('scope or remote changes between check and install prevent update', async () => {
    for (const change of ['scope', 'remote']) {
        const f = fixture(); await f.updater.check();
        if (change === 'scope') f.setCatalog([{ type: 'global', name: 'third-party/renamed-画皮' }]);
        else f.setVersion({ ...version, remoteUrl: 'https://github.com/foreign/repo' });
        await f.updater.install(); assert.equal(f.state.phase, 'unsupported'); assert.ok(!f.calls.some(x => x.url.endsWith('/update')));
    }
});

test('current branch status controls availability without inventing a newer semantic version', async () => {
    const f = fixture(); f.setVersion({ ...version, isUpToDate: true }); await f.updater.check();
    assert.equal(f.state.phase, 'current'); assert.equal(f.state.available, false); assert.equal(f.state.currentVersion, '0.2.0');
    f.setVersion(version); await f.updater.check(); assert.equal(f.state.phase, 'available');
    f.setVersion({ ...version, isUpToDate: true }); await f.updater.install(); assert.equal(f.state.phase, 'current'); assert.ok(!f.calls.some(x => x.url.endsWith('/update')));
});

test('HTTP, malformed JSON, malformed version and transport errors use fixed safe messages', async () => {
    for (const response of [
        () => ({ ok: false, status: 500, json: () => { throw Error('must not read secret'); } }),
        () => ({ ok: false, status: 403, json: () => null }),
        () => ({ ok: true, json: () => { throw Error('secret'); } }),
        () => ok({ unexpected: 'secret' }),
        () => { throw Error('https://private/secret'); },
    ]) {
        const f = fixture(); f.setTransport(response); await f.updater.check(); assert.ok(['error', 'unsupported'].includes(f.state.phase)); assert.doesNotMatch(JSON.stringify(f.state), /secret|private/);
    }
    const f = fixture(); f.setTransport(url => ok(url.endsWith('discover') ? [{ type: 'local', name: 'third-party/renamed-画皮' }] : { isUpToDate: 'false' })); await f.updater.check(); assert.equal(f.state.errorCode, 'RESPONSE_INVALID');
});

test('timeout settles even if fetch ignores abort and failed automatic checks are throttled', async () => {
    const f = fixture({ requestTimeoutMs: 8 }); f.setTransport(() => new Promise(() => {}));
    await f.updater.start(); assert.equal(f.state.errorCode, 'TIMEOUT'); assert.equal(f.calls.length, 1);
    await f.tick(); f.setClock(1000 + 6 * 60 * 60 * 1000 - 1); await f.tick(); assert.equal(f.calls.length, 1); f.updater.destroy();
});

test('automatic checks are six-hour throttled; default does not install; manual checks bypass throttle', async () => {
    const f = fixture(); await f.updater.start(); await f.updater.start();
    assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 30000); assert.equal(f.calls.length, 2);
    await f.tick(); assert.equal(f.calls.length, 2);
    f.setClock(1000 + 6 * 60 * 60 * 1000); await f.tick(); assert.equal(f.calls.length, 4);
    await f.updater.check(); assert.equal(f.calls.length, 6); assert.ok(!f.calls.some(x => x.url.endsWith('/update')));
    f.updater.destroy(); assert.equal(f.timers[0].cleared, true);
});

test('automatic install waits for affirmative idle guard and stops when either preference is off', async () => {
    const f = fixture({ preferences: { autoCheck: true, autoInstall: true } }); f.setIdle(false);
    await f.updater.start(); assert.equal(f.state.phase, 'deferred'); const count = f.calls.length;
    await f.tick(); assert.equal(f.calls.length, count); assert.ok(f.guards.every(x => x === true));
    f.setIdle(true); f.updater.setPreferences({ autoInstall: false }); await f.tick(); assert.equal(f.calls.length, count);
    f.updater.setPreferences({ autoInstall: true, autoCheck: false }); await f.tick(); assert.equal(f.calls.length, count);
    f.updater.setPreferences({ autoCheck: true }); await f.tick(); assert.equal(f.state.phase, 'installed'); assert.equal(f.calls.filter(x => x.url.endsWith('/update')).length, 1);
    f.updater.destroy();
});

test('manual install is also blocked while busy; it never bypasses guard', async () => {
    const f = fixture(); await f.updater.check(); f.setIdle(false); await f.updater.install();
    assert.equal(f.state.phase, 'deferred'); assert.deepEqual(f.guards, [false]); assert.equal(f.calls.length, 2);
    f.setIdle(true); await f.updater.install(); assert.equal(f.state.phase, 'installed');
});

test('turning automatic install off during preflight prevents the update POST', async () => {
    const f = fixture({ preferences: { autoInstall: true } }); await f.updater.check();
    let release; const gate = new Promise(resolve => { release = resolve; });
    f.setTransport(async url => { if (url.endsWith('/version')) { await gate; return ok(version); } return ok([{ type: 'local', name: 'third-party/renamed-画皮' }]); });
    const pending = f.updater.install({ automatic: true }); await flush(); f.updater.setPreferences({ autoInstall: false }); release(); await pending;
    assert.equal(f.state.phase, 'available'); assert.ok(!f.calls.some(x => x.url.endsWith('/update')));
});

test('update HTTP uncertainty disables automatic repetition until successful explicit check', async () => {
    const f = fixture({ preferences: { autoInstall: true } }); await f.updater.check();
    f.setTransport(url => url.endsWith('/update') ? Promise.reject(Error('secret')) : Promise.resolve(ok(url.endsWith('/discover') ? [{ type: 'local', name: 'third-party/renamed-画皮' }] : version)));
    await f.updater.install(); assert.equal(f.state.phase, 'error'); assert.equal(f.state.updateUncertain, true); assert.match(f.state.message, /服务器可能仍在处理/);
    const count = f.calls.length; await f.updater.start(); f.setClock(1000 + 30 * 60 * 60 * 1000); await f.tick(); await f.updater.install(); await f.updater.check({ automatic: true }); assert.equal(f.calls.length, count);
    f.setTransport(null); await f.updater.check(); assert.equal(f.state.phase, 'available'); assert.equal(f.state.updateUncertain, false);
    await f.updater.install(); assert.equal(f.state.phase, 'installed'); f.updater.destroy();
});

test('malformed update result is uncertain and later current server requires refresh', async () => {
    const f = fixture(); await f.updater.check(); f.setUpdate({ isUpToDate: false, remoteUrl: remote }); await f.updater.install(); assert.equal(f.state.updateUncertain, true);
    f.setVersion({ ...version, isUpToDate: true }); await f.updater.check(); assert.equal(f.state.phase, 'installed'); assert.match(f.state.message, /可能已完成.*刷新/);
});

test('destroy cancels checks without late state callbacks and clears interval', async () => {
    const f = fixture(); f.setTransport(() => new Promise(() => {})); const pending = f.updater.start(); await flush();
    const notifications = f.changes.length; f.updater.destroy(); await pending;
    assert.equal(f.state.phase, 'unchecked'); assert.equal(f.state.errorCode, 'ABORTED'); assert.equal(f.changes.length, notifications); assert.equal(f.timers[0].cleared, true); assert.equal(f.calls[0].signal.aborted, true);
    await f.updater.start(); await f.updater.check(); assert.equal(f.calls.length, 1);
});

test('destroy during dispatched update honestly reports possible server-side continuation', async () => {
    const f = fixture(); await f.updater.check();
    f.setTransport(url => url.endsWith('/update') ? new Promise(() => {}) : Promise.resolve(ok(url.endsWith('/discover') ? [{ type: 'local', name: 'third-party/renamed-画皮' }] : version)));
    const pending = f.updater.install(); for (let i = 0; i < 5; i++) await flush();
    assert.equal(f.state.phase, 'installing'); f.updater.destroy(); await pending;
    assert.equal(f.state.updateUncertain, true); assert.match(f.state.message, /服务器更新可能仍在进行/);
});

test('overlapping checks and installs never issue duplicate requests', async () => {
    const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
    f.setTransport(async url => { await gate; return ok(url.endsWith('/discover') ? [{ type: 'local', name: 'third-party/renamed-画皮' }] : version); });
    const first = f.updater.check(); await flush(); await f.updater.check(); await f.updater.install(); assert.equal(f.calls.length, 1); release(); await first; assert.equal(f.calls.length, 2);
});

test('switching auto-check off cancels an automatic request but not a manual check', async () => {
    const f = fixture(); f.setTransport(() => new Promise(() => {})); const pending = f.updater.start(); await flush();
    f.updater.setPreferences({ autoCheck: false }); await pending;
    assert.equal(f.state.phase, 'unchecked'); assert.equal(f.calls[0].signal.aborted, true);
    const count = f.calls.length; await f.tick(); assert.equal(f.calls.length, count); f.updater.destroy();
    const manual = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
    manual.setTransport(async url => { await gate; return ok(url.endsWith('/discover') ? [{ type: 'local', name: 'third-party/renamed-画皮' }] : version); });
    const check = manual.updater.check(); await flush(); manual.updater.setPreferences({ autoCheck: false });
    assert.equal(manual.calls[0].signal.aborted, false); release(); await check; assert.equal(manual.state.phase, 'available');
});

test('update timeout also locks repeat attempts even when transport ignores abort', async () => {
    const f = fixture({ requestTimeoutMs: 8 }); await f.updater.check();
    f.setTransport(url => url.endsWith('/update') ? new Promise(() => {}) : Promise.resolve(ok(url.endsWith('/discover') ? [{ type: 'local', name: 'third-party/renamed-画皮' }] : version)));
    await f.updater.install(); assert.equal(f.state.updateUncertain, true); assert.equal(f.state.errorCode, 'TIMEOUT');
    const count = f.calls.length; await f.updater.install(); assert.equal(f.calls.length, count);
});
