import test from 'node:test';
import assert from 'node:assert/strict';
import { getHostCatalog, readHostPreset, readExtraWorldbooks } from '../lib/host-library.js';

function fixture() {
    const calls = [], presets = [{ prompts: [{ identifier: 'rule', content: '规划' }], prompt_order: [{ character_id: 100001, order: [] }], extensions: { data: { note: 'preserved' } }, temperature: 0.5 }, { prompts: [], name: 'second' }];
    const names = ['global', 'character', 'extra', 'persona', 'chat', 'reference', 'empty'];
    const books = {
        reference: { entries: { 0: { uid: 0, content: '未触发关键词也作为明确参考提供。', key: ['absent'], constant: false, probability: 0 }, 1: { uid: 1, disable: true, content: '不会读取' }, 2: { uid: 2, disable: false, comment: '宏原文', content: '{{setvar::x::evil}} <script>literal</script>' } } },
        empty: { entries: {} },
    };
    const manager = { getPresetList(api) { calls.push(['presetList', api]); return { presets, preset_names: { '规划 A': 0, '规划 B': 1 } }; },
        selectPreset() { throw new Error('must never select'); }, getPresetSettings() { throw new Error('must never read current API settings'); }, savePreset() { throw new Error('must never save'); } };
    const context = { chatId: 'chat-a', characterId: 0, characters: [{ avatar: '林.澄.png', data: { extensions: { world: 'character' } } }],
        chatMetadata: { world_info: 'chat' }, powerUserSettings: { persona_description_lorebook: 'persona' }, mainApi: 'textgenerationwebui',
        getWorldInfoNames() { calls.push(['names']); return [...names]; },
        getPresetManager(api) { calls.push(['manager', api]); return manager; },
        loadWorldInfo: async name => { calls.push(['load', name]); return books[name] ?? null; },
        substituteParams() { throw new Error('must never expand macros'); }, saveWorldInfo() { throw new Error('must never write'); },
        getWorldInfoPrompt() { throw new Error('must never scan or advance timed effects'); },
    };
    const worldInfoModule = { selected_world_info: ['global'], world_info: { charLore: [{ name: '林.澄', extraBooks: ['extra'] }] }, METADATA_KEY: 'world_info' };
    return { context, worldInfoModule, manager, calls, names, presets, books };
}
const extras = (f, names, options = {}) => readExtraWorldbooks({ context: f.context, names, mountedNames: ['global', 'character', 'extra', 'persona', 'chat'], ...options });

test('catalog labels every official mount source without loading or modifying books', () => {
    const f = fixture();
    const before = JSON.stringify(f.worldInfoModule);
    const result = getHostCatalog(f);
    assert.equal(result.status, 'ready'); assert.equal(result.mountsKnown, true);
    for (const source of ['global', 'character', 'extra', 'persona', 'chat']) {
        const book = result.worldbooks.find(item => item.name === source);
        assert.deepEqual(book.sources, [source]); assert.equal(book.mounted, true);
    }
    assert.equal(result.worldbooks.find(item => item.name === 'reference').mounted, false);
    assert.equal(result.presets[0].id, 'openai:' + encodeURIComponent('规划 A'));
    assert.ok(f.calls.every(call => call[0] !== 'load'));
    assert.equal(JSON.stringify(f.worldInfoModule), before);
});

test('catalog deduplicates shared mounts while retaining all sources and missing mounted names', () => {
    const f = fixture(); f.worldInfoModule.selected_world_info.push('chat', 'gone');
    const result = getHostCatalog(f);
    assert.deepEqual(result.worldbooks.find(item => item.name === 'chat').sources, ['global', 'chat']);
    assert.equal(result.worldbooks.find(item => item.name === 'gone').available, false);
    assert.equal(result.worldbooks.find(item => item.name === 'gone').mounted, true);
    assert.equal(result.status, 'partial'); assert.match(result.message, /不在当前目录/);
});

test('missing preset API leaves mounted worldbook catalog readable', () => {
    const f = fixture(); delete f.context.getPresetManager;
    const result = getHostCatalog(f);
    assert.equal(result.status, 'partial'); assert.ok(result.worldbooks.length); assert.equal(result.mountsKnown, true);
    assert.deepEqual(result.presets, []); assert.match(result.message, /预设目录/);
});

test('unknown mounts are never mislabeled as an unmounted worldbook list', () => {
    const f = fixture(); delete f.worldInfoModule;
    const result = getHostCatalog(f);
    assert.equal(result.status, 'partial'); assert.equal(result.mountsKnown, false);
    assert.deepEqual(result.worldbooks, []); assert.equal(result.presets.length, 2); assert.match(result.message, /挂载信息/);
});

test('catalog can work without a selected chat or character and does not use stale group character', () => {
    const f = fixture(); delete f.context.characterId; delete f.context.chatId; f.context.chatMetadata = {};
    assert.equal(getHostCatalog(f).status, 'ready');
    f.context.characterId = 0; f.context.groupId = 'group';
    assert.equal(getHostCatalog(f).worldbooks.find(item => item.name === 'character').mounted, false);
});

test('read saved OpenAI preset by stable name ID, preserving complete data as a clone', () => {
    const f = fixture(); const { id } = getHostCatalog(f).presets[0];
    const result = readHostPreset({ context: f.context, id });
    assert.deepEqual(result, f.presets[0]); result.extensions.data.note = 'changed';
    assert.equal(f.presets[0].extensions.data.note, 'preserved');
    assert.equal(f.context.mainApi, 'textgenerationwebui');
    assert.ok(f.calls.filter(call => call[0] === 'manager' || call[0] === 'presetList').every(call => call[1] === 'openai'));
    f.manager.getPresetList = () => ({ presets: [f.presets[1], f.presets[0]], preset_names: { '规划 B': 0, '规划 A': 1 } });
    assert.deepEqual(readHostPreset({ context: f.context, id }), f.presets[0]);
});

test('preset directory supports official array names, rejects missing and malformed records', () => {
    const f = fixture(); f.manager.getPresetList = () => ({ presets: [JSON.stringify(f.presets[0])], preset_names: ['array name'] });
    const item = getHostCatalog(f).presets[0]; assert.equal(item.name, 'array name');
    assert.deepEqual(readHostPreset({ context: f.context, id: item.id }), f.presets[0]);
    assert.throws(() => readHostPreset({ context: f.context, id: 'openai:missing' }), /已不存在/);
    assert.throws(() => readHostPreset({ context: f.context, id: 'textgen:array' }), /聊天补全/);
    f.manager.getPresetList = () => ({ presets: [], preset_names: { broken: 10 } });
    assert.equal(getHostCatalog(f).status, 'partial');
});

test('extra books explicitly include all enabled content, skip mounted books and keep macros literal', async () => {
    const f = fixture(), before = JSON.stringify(f.books);
    const result = await extras(f, ['global', 'reference', 'reference', 'empty']);
    assert.deepEqual(result.books, [{ name: 'reference', count: 2 }, { name: 'empty', count: 0 }]);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[1].content, '{{setvar::x::evil}} <script>literal</script>');
    assert.match(result.text, /不代表酒馆关键词扫描命中/); assert.match(result.text, /没有启用条目/);
    assert.doesNotMatch(result.text, /不会读取/);
    assert.deepEqual(f.calls.filter(call => call[0] === 'load'), [['load', 'reference'], ['load', 'empty']]);
    assert.equal(JSON.stringify(f.books), before);
});

test('empty selection and mounted-only selection need no book read API', async () => {
    const f = fixture(); delete f.context.loadWorldInfo;
    assert.deepEqual(await extras(f, []), { text: '', books: [], entries: [] });
    assert.deepEqual(await extras(f, ['chat']), { text: '', books: [], entries: [] });
    await assert.rejects(extras(f, ['reference']), /读取接口/);
    await assert.rejects(extras(f, ['reference'], { mountedNames: undefined }), /完整挂载列表/);
});

test('missing books and unsuccessful reads stop the whole operation rather than silently dropping data', async () => {
    const f = fixture(); await assert.rejects(extras(f, ['missing']), /不在酒馆目录/);
    f.books.reference = null; await assert.rejects(extras(f, ['reference']), /读取失败/);
    f.context.loadWorldInfo = async () => { throw new Error('sensitive endpoint failure'); };
    await assert.rejects(extras(f, ['reference']), error => error.code === 'HOST_WORLDBOOK_READ_FAILED' && !error.message.includes('sensitive'));
});

test('script extensions and automation metadata are rejected; disabled entries remain excluded', async () => {
    for (const mutate of [
        book => book.extensions = { helper: { scripts: [{ content: 'not executed' }] } },
        book => book.entries[0].script = 'not executed',
        book => book.entries[0].automationId = 'action',
    ]) {
        const f = fixture(); mutate(f.books.reference); await assert.rejects(extras(f, ['reference']), error => error.code === 'HOST_SCRIPT_UNSUPPORTED');
    }
    const f = fixture(); f.books.reference.entries[1].script = 'disabled';
    assert.equal((await extras(f, ['reference'])).entries.length, 2);
});

test('malformed entry content and uncertain enabled state are explicit failures', async () => {
    const f = fixture(); f.books.reference.entries[0].content = {};
    await assert.rejects(extras(f, ['reference']), /缺少文本/);
    f.books.reference.entries[0].content = 'safe'; f.books.reference.entries[0].disable = {};
    await assert.rejects(extras(f, ['reference']), /启用状态/);
});

test('pre-abort performs no read and mid-load abort never starts the next book', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(extras(f, ['reference'], { signal: controller.signal }), error => error.code === 'ABORTED');
    assert.equal(f.calls.length, 0);
    const next = new AbortController(); let resolve;
    f.context.loadWorldInfo = name => { f.calls.push(['load', name]); return new Promise(done => resolve = done); };
    const pending = extras(f, ['reference', 'empty'], { signal: next.signal });
    await Promise.resolve(); next.abort();
    await assert.rejects(pending, error => error.code === 'ABORTED');
    resolve(f.books.reference); await Promise.resolve();
    assert.deepEqual(f.calls.filter(call => call[0] === 'load'), [['load', 'reference']]);
});

test('chat switch during asynchronous read discards results', async () => {
    const f = fixture(); let currentId = f.context.chatId; f.context.getCurrentChatId = () => currentId;
    f.context.loadWorldInfo = async () => { currentId = 'different-chat'; return f.books.reference; };
    await assert.rejects(extras(f, ['reference']), error => error.code === 'HOST_CONTEXT_CHANGED');
});

test('oversized selection and content fail explicitly without truncation', async () => {
    const f = fixture(); await assert.rejects(extras(f, Array.from({ length: 101 }, (_, i) => 'book' + i)), /最多.*100/);
    f.books.reference = { entries: { 0: { content: 'x'.repeat(10 * 1024 * 1024 + 1) } } };
    await assert.rejects(extras(f, ['reference']), /超过 10 MB/);
});
