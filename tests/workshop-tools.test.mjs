import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_MAX_BYTES, VERSION_LIMIT, makeVersion, sanitizeBackup } from '../lib/workshop-tools.js';
import { createWorkshopTools } from '../tools-ui.js';

const xml = '<content><plot>他在门口等候。</plot><characters><character name="林澄"><emotion>不安，但没有贸然猜测。</emotion><response>问候对方，并说明自己来意。</response></character></characters><segments><segment index="1">他把伞放到门边，等对方回应。</segment></segments><end_state>仍在门口。</end_state></content>';
const preset = () => ({ name: '规划', prompts: [{ identifier: 'one', name: '提示词', content: '只规划本轮。', role: 'system', enabled: false }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'one', enabled: false }] }], extensions: { plot_workshop: { schema_version: 1, preserve_prompt_selection: true }, executable: { script: 'never execute', key: 'preset-secret' } } });
const backup = () => ({ format: 'huapi-backup', version: 1, settings: {}, apiProfiles: [], presetLibrary: [], versions: [] });

test('backup drops retired pace settings and keeps supported fields', () => {
    const source = backup();
    source.settings = { storyPace: 'fast', relationshipPace: 'slow', minWords: '1200' };
    const restored = sanitizeBackup(source).settings;
    assert.equal(restored.storyPace, undefined);
    assert.equal(restored.relationshipPace, undefined);
    assert.equal(restored.minWords, '1200');
});

test('backup preserves stream mode per API and rejects non-boolean switches', () => {
    const source = backup();
    source.settings.stream = false;
    source.apiProfiles = [{ id: 'one', name: '一', stream: false }, { id: 'two', name: '二', stream: true }];
    const actual = sanitizeBackup(source);
    assert.equal(actual.settings.stream, false);
    assert.deepEqual(actual.apiProfiles.map(profile => profile.stream), [false, true]);
    assert.equal(sanitizeBackup(backup()).settings.stream, true);
    for (const stream of ['false', 0, null, {}]) {
        assert.throws(() => sanitizeBackup({ ...source, settings: { stream } }), /布尔值/);
        assert.throws(() => sanitizeBackup({ ...source, apiProfiles: [{ id: 'x', name: 'x', stream }] }), /布尔值/);
    }
});

test('versions are unique, canonical and contain no surrounding analysis or extra state', () => {
    const first = makeVersion({ xml: `analysis before\n${xml}\nextra after`, input: '我回来了。', label: '第一版', rawMemory: 'secret memory' });
    const next = makeVersion({ xml, input: '我回来了。', label: '编辑版', parentId: first.id }, [first]);
    assert.notEqual(first.id, next.id); assert.equal(next.parentId, first.id);
    assert.ok(Number.isFinite(Date.parse(first.createdAt)));
    assert.ok(first.xml.startsWith('<content>')); assert.ok(first.xml.endsWith('</content>'));
    assert.doesNotMatch(first.xml, /analysis before|extra after/);
    assert.deepEqual(Object.keys(first), ['id', 'createdAt', 'label', 'xml', 'input', 'parentId']);
    assert.throws(() => makeVersion({ xml: '<content>' }), /截断|闭合/);
    assert.throws(() => makeVersion({ xml, label: 'x'.repeat(121) }), /过长/);
    assert.throws(() => makeVersion({ xml, input: {} }), /必须是文本/);
});

test('backup only returns whitelisted data and strips credentials, logs, memory and executable settings', () => {
    const source = backup();
    source.settings = { baseUrl: 'https://example.test/v1', apiKey: 'settings-secret', headers: { Authorization: 'hidden' }, model: 'planner', minWords: '1500', maxWords: '2000' };
    source.apiProfiles = [{ id: 'api1', name: '本地方案', baseUrl: 'http://localhost:3000/v1', model: 'other', temp: 0.8, maxTokens: '2000', key: 'key-secret', password: 'password-secret', headers: { Authorization: 'auth-secret' } }];
    source.presetLibrary = [{ id: 'p1', name: '保持关闭条目', preset: preset(), key: 'entry-secret' }];
    source.versions = [{ ...makeVersion({ xml }), memory: 'raw-memory-secret', anchor: 'host-state-secret' }];
    source.rawMemory = 'root-memory-secret'; source.logs = ['log-secret']; source.apiKey = 'root-key-secret'; source.director = { instruction: 'removed-secret' };
    const result = sanitizeBackup(JSON.stringify(source));
    assert.deepEqual(Object.keys(result), ['settings', 'apiProfiles', 'presetLibrary', 'versions', 'extraWorldbooks']);
    assert.equal(result.apiProfiles[0].temperature, '0.8'); assert.equal(result.settings.minWords, '1500');
    assert.equal(result.presetLibrary[0].preset.extensions.plot_workshop.preserve_prompt_selection, true);
    assert.equal(result.presetLibrary[0].preset.prompt_order[0].order[0].enabled, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|rawMemory|headers|password|executable|anchor/);
    assert.equal(source.apiProfiles[0].key, 'key-secret', 'sanitizer must not mutate input');
});

test('backup preserves only legitimate preset selection marker and retains groups', () => {
    const source = backup(), data = preset();
    data.extensions.plot_workshop = { schema_version: 2, preserve_prompt_selection: true };
    data.extensions.baibaiToolkit = { presetPromptGroups: { groups: [{ id: 'g', name: '内容', enabled: false }], prompts: { one: { groupId: 'g' } } } };
    source.presetLibrary = [{ id: 'p', name: '分组', preset: data }];
    const result = sanitizeBackup(source).presetLibrary[0].preset;
    assert.equal(result.extensions.plot_workshop, undefined);
    assert.equal(result.extensions.baibaiToolkit.presetPromptGroups.groups[0].enabled, false);
    assert.equal(result.extensions.baibaiToolkit.presetPromptGroups.prompts.one.groupId, 'g');
});

test('backup rejects unknown formats, malformed data, oversize UTF-8 files and excessive lists', () => {
    assert.throws(() => sanitizeBackup({ ...backup(), version: 2 }), /不.*支持/);
    assert.throws(() => sanitizeBackup('{'), /有效的 JSON/);
    assert.throws(() => sanitizeBackup({ ...backup(), extra: '中'.repeat(Math.ceil(BACKUP_MAX_BYTES / 3)) }), /5 MB/);
    assert.throws(() => sanitizeBackup({ ...backup(), apiProfiles: Array(31).fill({}) }), /最多 30/);
    assert.throws(() => sanitizeBackup({ ...backup(), presetLibrary: Array(21).fill({}) }), /最多 20/);
    assert.throws(() => sanitizeBackup({ ...backup(), versions: Array(VERSION_LIMIT + 1).fill({}) }), /最多 50/);
    assert.throws(() => sanitizeBackup({ ...backup(), settings: [] }), /对象/);
    assert.throws(() => sanitizeBackup({ ...backup(), settings: { model: {} } }), /格式或长度/);
});

test('backup rejects credentials embedded in endpoint URLs and invalid numeric settings', () => {
    for (const baseUrl of ['https://user:secret@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1#secret', 'javascript:alert(1)', '/relative']) {
        assert.throws(() => sanitizeBackup({ ...backup(), settings: { baseUrl } }));
    }
    for (const settings of [{ temperature: 3 }, { maxTokens: '1.2' }, { minWords: '2000', maxWords: '1500' }, { injectionDepth: '1.1' }, { injectionRole: 'admin' }, { autoOnSend: 'true' }]) {
        assert.throws(() => sanitizeBackup({ ...backup(), settings }));
    }
});

test('backup validates version XML, stable IDs, UTC timestamps and acyclic parent relationships', () => {
    const a = makeVersion({ xml }), b = makeVersion({ xml, parentId: a.id }, [a]);
    const source = { ...backup(), versions: [a, b] };
    assert.equal(sanitizeBackup(source).versions[1].id, b.id);
    assert.throws(() => sanitizeBackup({ ...source, versions: [a, a] }), /重复/);
    assert.throws(() => sanitizeBackup({ ...source, versions: [{ ...a, xml: '<content>' }] }), /截断|闭合/);
    assert.throws(() => sanitizeBackup({ ...source, versions: [{ ...a, createdAt: 'tomorrow' }] }), /UTC/);
    assert.throws(() => sanitizeBackup({ ...source, versions: [{ ...a, createdAt: '2026-02-31T12:00:00.000Z' }] }), /日期/);
    assert.throws(() => sanitizeBackup({ ...source, versions: [{ ...a, parentId: b.id }, b] }), /循环/);
});

// Minimal DOM contract double. Source and model strings are never evaluated or parsed as HTML.
class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = {}; this.events = new Map(); this._text = ''; this.value = ''; this.disabled = false; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Untrusted HTML must never be used.'); }
    append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(event, handler) { if (!this.events.has(event)) this.events.set(event, new Set()); this.events.get(event).add(handler); }
    removeEventListener(event, handler) { this.events.get(event)?.delete(handler); }
    async fire(event, details = {}) { for (const handler of this.events.get(event) || []) await handler({ target: this, ...details }); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]); }
    contains(item) { return item === this || this.children.some(child => child.contains(item)); }
    closest(selector) { if (selector === '[data-diagnosis-index]' && this.dataset.diagnosisIndex !== undefined) return this; return this.parentElement?.closest(selector) || null; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
}
function uiFixture(state = {}) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    const actions = [];
    const view = createWorkshopTools({ getState: () => state, onAction: async (type, payload) => { actions.push([type, payload]); } });
    const button = (label, root = view.outlineElement) => root.querySelectorAll('button').find(item => item.textContent === label);
    return { view, state, actions, button, finish() { view.destroy(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; } };
}

test('tools UI renders preview safely without adding director controls or a duplicate character panel', () => {
    const fixture = uiFixture({ plan: { characters: [{ name: '<img onerror=x>', emotion: '未变', response: '停留' }] }, promptPreview: { planner: [{ role: 'user', content: '<script>unsafe</script>' }], writer: 'temporary only', valid: false, message: '输入已变' } });
    try {
        assert.match(fixture.view.outlineElement.textContent, /不是酒馆最终组装的完整请求/);
        assert.doesNotMatch(fixture.view.outlineElement.textContent, /导演|人物状态|<img onerror=x>/);
        const previews = fixture.view.outlineElement.querySelectorAll('textarea').filter(item => item.readOnly);
        assert.ok(previews.some(item => item.value === '[user]\n<script>unsafe</script>'));
        assert.match(fixture.view.outlineElement.textContent, /预览已过期/);
    } finally { fixture.finish(); }
});

test('tools UI dispatches preview, diagnosis and backup actions without autonomous generation', async () => {
    const fixture = uiFixture();
    try {
        await fixture.button('刷新实际内容预览').fire('click');
        await fixture.button('诊断当前剧情').fire('click');
        await fixture.button('导出备份', fixture.view.settingsElement).fire('click');
        assert.deepEqual(fixture.actions.map(item => item[0]), ['previewPrompts', 'diagnose', 'exportBackup']);
    } finally { fixture.finish(); }
});

test('tools UI disables mutations during any busy state, keeps comparison readable and removes event handlers', async () => {
    const version = makeVersion({ xml });
    const fixture = uiFixture({ planVersions: [version], busy: true });
    try {
        assert.equal(fixture.button('恢复选中版本').disabled, true);
        await fixture.button('恢复选中版本').fire('click'); assert.equal(fixture.actions.length, 0);
        assert.ok(fixture.view.outlineElement.querySelectorAll('textarea').some(item => item.readOnly && item.value === version.xml));
        for (const key of ['apiBusy', 'animaChecking', 'libraryBusy']) {
            fixture.state.busy = false; fixture.state[key] = true; fixture.view.render();
            assert.equal(fixture.button('诊断当前剧情').disabled, true); fixture.state[key] = false;
        }
        fixture.view.render(); await fixture.button('恢复选中版本').fire('click');
        assert.deepEqual(fixture.actions.at(-1), ['restoreVersion', { id: version.id }]);
        const oldButton = fixture.button('诊断当前剧情'); fixture.view.destroy();
        await oldButton.fire('click'); assert.equal(fixture.actions.length, 1);
    } finally { fixture.finish(); }
});

test('tools UI rejects oversized backup before reading and imports bounded file text only', async () => {
    const fixture = uiFixture();
    try {
        const file = fixture.view.settingsElement.querySelectorAll('input')[0];
        let reads = 0;
        file.files = [{ size: BACKUP_MAX_BYTES + 1, text: async () => { reads++; return 'never'; } }];
        await file.fire('change'); assert.equal(reads, 0); assert.equal(fixture.actions.length, 0);
        const encoded = JSON.stringify(backup());
        file.files = [{ size: encoded.length, text: async () => encoded }];
        await file.fire('change'); assert.deepEqual(fixture.actions[0], ['importBackup', { text: encoded }]);
    } finally { fixture.finish(); }
});

test('diagnosis choices only dispatch a selected input suggestion and never generate or add hidden directives', async () => {
    const fixture = uiFixture({ input: '现有输入', diagnosis: { summary: '保留当前停顿。', options: [{ title: '<script>choice</script>', direction: '让他说明来意。' }] } });
    try {
        const apply = fixture.button('填入本轮输入');
        assert.ok(apply); assert.match(fixture.view.outlineElement.textContent, /<script>choice<\/script>/);
        const list = apply.parentElement.parentElement;
        await list.fire('click', { target: apply });
        await Promise.resolve();
        assert.deepEqual(fixture.actions, [['applyDiagnosis', { index: 0 }]]);
        assert.equal(fixture.state.input, '现有输入', 'the controller owns how to append input');
        fixture.state.busy = true; fixture.view.render();
        await list.fire('click', { target: apply });
        assert.equal(fixture.actions.length, 1);
    } finally { fixture.finish(); }
});
