const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../lib/anima.js'), 'utf8');
const defaultPath = '/scripts/extensions/third-party/Anima-Memory-System';
const manifest = (version = '3.3.6') => ({ version, display_name: 'Anima Memory System', generate_interceptor: 'Anima_RAG_Interceptor', js: 'index.js' });
let passed = 0;

async function fixture() {
    const data = {
        context: { extensionNames: [], extensionSettings: { anima_memory_system: {}, disabledExtensions: [] } },
        official: {}, manifests: { [defaultPath]: manifest() }, scripts: [], requests: [],
        imports: 0, helperCalls: 0, nativeCalls: 0,
    };
    data.context.getExtensionManifest = name => data.official[name] || null;
    const helper = {};
    for (const name of ['getChatWorldbookName', 'getWorldbook', 'getVariables', 'updateWorldbookWith', 'createWorldbookEntries', 'getOrCreateChatWorldbook']) {
        helper[name] = () => { data.helperCalls++; throw new Error('Detection must not invoke TavernHelper methods'); };
    }
    const global = vm.createContext({
        URL, JSON, Date, Map, Set, Promise, Error, Number, String, Array, RegExp, AbortController,
        setTimeout, clearTimeout, location: { origin: 'https://tavern.example' },
        SillyTavern: { getContext: () => data.context }, TavernHelper: helper,
        Anima_RAG_Interceptor: () => { data.nativeCalls++; throw new Error('Detection must not invoke Anima'); },
        document: { querySelectorAll: selector => { assert.equal(selector, 'script[src]'); return data.scripts.map(src => ({ src })); } },
        fetch: async (url, options) => {
            data.requests.push({ url, options });
            assert.equal(options.method, 'GET');
            assert.equal(options.credentials, 'same-origin');
            assert.equal(options.redirect, 'error');
            assert.equal(new URL(url).origin, 'https://tavern.example');
            assert.ok(url.endsWith('/manifest.json'));
            if (data.failFetch) throw new Error('Network unavailable');
            const key = new URL(url).pathname.replace(/\/manifest\.json$/, '');
            const body = data.manifests[key];
            return { ok: !!body, status: body ? 200 : 404, url, json: async () => body };
        },
    });
    const module = new vm.SourceTextModule(source, {
        context: global,
        importModuleDynamically: () => { data.imports++; throw new Error('Detection must not import Anima modules'); },
    });
    await module.link(() => { throw new Error('No static imports expected'); });
    await module.evaluate();
    return { data, global, detect: settings => module.namespace.detectInstalledAnima({ context: data.context, settings }) };
}

async function test(name, run) {
    const f = await fixture();
    await run(f);
    assert.equal(f.data.imports, 0);
    assert.equal(f.data.helperCalls, 0);
    assert.equal(f.data.nativeCalls, 0);
    passed++;
    process.stdout.write(`PASS ${name}\n`);
}

(async () => {
    await test('ready without any selected chat; no Anima execution or memory access', async f => {
        const before = JSON.stringify(f.data.context);
        const result = await f.detect();
        assert.equal(result.status, 'ready'); assert.equal(result.frontendPath, defaultPath);
        assert.equal(f.data.context.chatId, undefined); assert.equal(JSON.stringify(f.data.context), before);
        assert.equal(f.data.requests.length, 1);
    });
    await test('official manifests identify renamed installation without importing modules', async f => {
        f.data.context.extensionNames = ['third-party/MyMemory'];
        f.data.official['third-party/MyMemory'] = manifest();
        const result = await f.detect();
        assert.equal(result.status, 'ready'); assert.equal(result.frontendPath, '/scripts/extensions/third-party/MyMemory');
        assert.equal(f.data.requests.length, 0);
    });
    await test('loaded same-origin entry script discovers renamed folder without an official list', async f => {
        f.data.manifests = { '/scripts/extensions/third-party/Memory-renamed': manifest() };
        f.data.scripts = ['https://tavern.example/scripts/extensions/third-party/Memory-renamed/index.js?v=12'];
        const result = await f.detect();
        assert.equal(result.status, 'ready'); assert.equal(result.frontendPath, '/scripts/extensions/third-party/Memory-renamed');
        assert.equal(f.data.requests.length, 1);
    });
    await test('explicit custom path wins over another detected installation', async f => {
        const custom = '/scripts/extensions/third-party/Chosen';
        f.data.manifests[custom] = manifest();
        f.data.context.extensionNames = ['third-party/Another']; f.data.official['third-party/Another'] = manifest();
        const result = await f.detect({ frontendPath: custom });
        assert.equal(result.status, 'ready'); assert.equal(result.frontendPath, custom); assert.equal(f.data.requests.length, 1);
    });
    await test('bad explicit path is reported rather than silently replaced', async f => {
        const result = await f.detect({ frontendPath: '/scripts/extensions/third-party/Wrong' });
        assert.equal(result.status, 'not_found'); assert.match(result.message, /指定目录/);
        assert.equal(f.data.requests.length, 1);
    });
    await test('unsupported Anima version is distinguished from missing installation', async f => {
        f.data.manifests[defaultPath] = manifest('3.4.0');
        const result = await f.detect(); assert.equal(result.status, 'unsupported'); assert.equal(result.version, '3.4.0');
    });
    await test('missing native interceptor means installed but not ready', async f => {
        delete f.global.Anima_RAG_Interceptor;
        const result = await f.detect(); assert.equal(result.status, 'not_ready'); assert.match(result.message, /拦截器/);
    });
    await test('missing Anima configuration is distinguished from missing manifest', async f => {
        delete f.data.context.extensionSettings.anima_memory_system;
        const result = await f.detect(); assert.equal(result.status, 'not_ready'); assert.match(result.message, /配置尚未初始化/);
    });
    await test('missing TavernHelper dependency is identified without invoking helper methods', async f => {
        delete f.global.TavernHelper.getVariables;
        const result = await f.detect(); assert.equal(result.status, 'not_ready'); assert.match(result.message, /酒馆助手/); assert.match(result.message, /getVariables/);
    });
    await test('disabled official installation is not reported ready', async f => {
        f.data.context.extensionNames = ['third-party/PausedAnima']; f.data.official['third-party/PausedAnima'] = manifest();
        f.data.context.extensionSettings.disabledExtensions = ['third-party/PausedAnima'];
        const result = await f.detect(); assert.equal(result.status, 'not_ready'); assert.match(result.message, /未启用/);
    });
    await test('multiple real Anima manifests require explicit selection', async f => {
        f.data.context.extensionNames = ['third-party/One', 'third-party/Two'];
        f.data.official['third-party/One'] = manifest(); f.data.official['third-party/Two'] = manifest();
        const result = await f.detect(); assert.equal(result.status, 'ambiguous'); assert.equal(result.frontendPath, undefined);
    });
    await test('foreign script URLs and arbitrary non-extension scripts are never queried', async f => {
        f.data.scripts = ['https://evil.example/scripts/extensions/third-party/Anima/index.js', 'https://tavern.example/script.js'];
        const result = await f.detect(); assert.equal(result.status, 'ready'); assert.equal(f.data.requests.length, 1);
        assert.equal(f.data.requests[0].url, `https://tavern.example${defaultPath}/manifest.json`);
    });
    await test('cross-origin explicit path is rejected with no request', async f => {
        const result = await f.detect({ frontendPath: 'https://evil.example/scripts/extensions/third-party/Anima' });
        assert.equal(result.status, 'not_found'); assert.equal(f.data.requests.length, 0);
    });
    await test('missing installation and unreadable manifest have different statuses', async f => {
        f.data.manifests = {}; delete f.global.Anima_RAG_Interceptor; delete f.data.context.extensionSettings.anima_memory_system;
        assert.equal((await f.detect()).status, 'not_found');
        f.data.failFetch = true; assert.equal((await f.detect()).status, 'not_ready');
    });
    await test('known unrelated official manifests do not trigger guessed directory probes', async f => {
        f.data.context.extensionNames = ['third-party/OtherExtension'];
        f.data.official['third-party/OtherExtension'] = { version: '1', display_name: 'Other Extension', js: 'main.js' };
        assert.equal((await f.detect()).status, 'ready');
        assert.equal(f.data.requests.length, 1); assert.equal(f.data.requests[0].url, `https://tavern.example${defaultPath}/manifest.json`);
    });
    process.stdout.write(`${passed} detection tests passed; no external requests, imports, recalls or memory writes.\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
