import assert from 'node:assert/strict';
import { test as runTest } from 'node:test';
import { createWriterQuickActions } from '../lib/quick-actions.js';

class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.attributes = {}; this.events = new Map(); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentNode = this; } }
    insertBefore(node, next) { node.remove(); const index = this.children.indexOf(next); if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); node.parentNode = this; }
    remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    addEventListener(name, handler) { this.events.set(name, [...this.events.get(name) || [], handler]); }
    click() { if (!this.disabled) for (const handler of this.events.get('click') || []) handler(); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { const found = []; for (const child of this.children) { if (selector[0] === '#' ? child.id === selector.slice(1) : child.className?.split(' ').includes(selector.slice(1))) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
}
class Document extends Node {
    constructor() { super('document'); }
    createElement(tag) { return new Node(tag); }
    createElementNS(_namespace, tag) { return new Node(tag); }
}
function host({ menuOnly = false, parser = true } = {}) {
    const doc = new Document(); globalThis.document = doc;
    const form = doc.createElement('form'); form.id = 'send_form';
    const left = doc.createElement('div'); left.id = 'leftSendForm'; form.append(left);
    const send = doc.createElement('button'); send.id = 'send_but'; form.append(send);
    const menu = doc.createElement('div'); menu.id = 'extensionsMenu';
    doc.append(...(menuOnly ? [menu] : [form, menu]));
    let registrations = 0;
    const Parser = { commands: {}, addCommandObject(command) { registrations++; this.commands[command.name] = command; } };
    const context = parser ? { SlashCommandParser: Parser, SlashCommand: { fromProps: props => ({ aliases: [], ...props }) } } : {};
    return { doc, form, left, send, menu, Parser, context, count: () => registrations, button: () => doc.querySelector('.vespera-rewrite-shortcut') };
}
async function test(name, run) {
    await runTest(name, async () => {
        const previous = globalThis.document;
        try { await run(); }
        finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
    });
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('composer button and one no-argument command; repeated refresh does not register twice', async () => {
    const h = host(); let calls = 0; let eligible = true;
    const actions = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { calls++; }, canRewrite: () => eligible });
    const button = h.button();
    assert.equal(h.left.nextSibling, button); assert.equal(button.nextSibling, h.send); assert.equal(button.type, 'button');
    assert.equal(button.title, '按大纲重写正文'); assert.equal(button.getAttribute('aria-label'), button.title);
    assert.equal(calls, 0); actions.refresh(); actions.refresh(); assert.equal(h.count(), 1);
    eligible = false; actions.refresh(); assert.equal(button.disabled, true);
    assert.equal(await h.Parser.commands['ves-rewrite'].callback({}, 'ignored'), ''); assert.equal(calls, 0);
    eligible = true; actions.refresh(); button.click(); await flush(); assert.equal(calls, 1);
    assert.equal(await h.Parser.commands['ves-rewrite'].callback(), ''); assert.equal(calls, 2);
    actions.destroy();
});
test('in-flight guard and destruction deactivate retained command callbacks', async () => {
    const h = host(); let calls = 0; let resolve;
    const actions = createWriterQuickActions({ getContext: () => h.context, onRewrite: () => { calls++; return new Promise(done => { resolve = done; }); }, canRewrite: () => true });
    const command = h.Parser.commands['ves-rewrite']; const pending = command.callback();
    assert.equal(h.button().disabled, true); h.button().click(); await command.callback(); assert.equal(calls, 1);
    actions.destroy(); assert.equal(h.button(), null); assert.equal(h.Parser.commands['ves-rewrite'], undefined);
    resolve(); await pending; await command.callback(); assert.equal(calls, 1);
});
test('foreign commands are neither overwritten nor removed', async () => {
    const h = host(); const foreign = { callback: () => 'foreign' }; h.Parser.commands['ves-rewrite'] = foreign;
    let calls = 0; const actions = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { calls++; }, canRewrite: () => true });
    h.button().click(); await flush(); assert.equal(calls, 1); assert.equal(h.count(), 0);
    actions.destroy(); assert.equal(h.Parser.commands['ves-rewrite'], foreign);
});
test('a replacement command survives destruction of our original registration', async () => {
    const h = host(); let calls = 0;
    const actions = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { calls++; }, canRewrite: () => true });
    const old = h.Parser.commands['ves-rewrite']; const replacement = {}; h.Parser.commands['ves-rewrite'] = replacement;
    actions.refresh(); actions.destroy(); assert.equal(h.Parser.commands['ves-rewrite'], replacement);
    await old.callback(); assert.equal(calls, 0);
});
test('missing command APIs use menu fallback and move to composer when available', async () => {
    const h = host({ menuOnly: true, parser: false });
    const actions = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => {}, canRewrite: () => false });
    const button = h.button(); assert.equal(button.parentNode, h.menu); assert.equal(button.children[1].hidden, false);
    h.doc.append(h.form); actions.refresh(); assert.equal(h.left.nextSibling, button); assert.equal(button.children[1].hidden, true);
    assert.equal(h.doc.querySelectorAll('.vespera-rewrite-shortcut').length, 1); actions.destroy();
});
test('late APIs and repeated installation keep one live button and command', async () => {
    const h = host(); let current = {}; let oldCalls = 0; let newCalls = 0;
    const first = createWriterQuickActions({ getContext: () => current, onRewrite: async () => { oldCalls++; }, canRewrite: () => true });
    assert.equal(h.count(), 0); current = h.context; first.refresh(); assert.equal(h.count(), 1);
    const old = h.Parser.commands['ves-rewrite'];
    const second = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { newCalls++; }, canRewrite: () => true });
    assert.equal(h.doc.querySelectorAll('.vespera-rewrite-shortcut').length, 1); first.refresh(); first.destroy();
    await old.callback(); await h.Parser.commands['ves-rewrite'].callback(); assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
    second.destroy();
});
test('read-only or opaque command registries leave inert callbacks and safely reuse them', async () => {
    const h = host(); let calls = 0;
    const first = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { calls++; }, canRewrite: () => true });
    const command = h.Parser.commands['ves-rewrite']; Object.freeze(h.Parser.commands); first.destroy();
    await command.callback(); assert.equal(calls, 0);
    const second = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { calls++; }, canRewrite: () => true });
    assert.equal(h.count(), 1); await command.callback(); assert.equal(calls, 1); second.destroy();
});
test('no DOM is supported and failed availability stays disabled', async () => {
    const h = host(); delete globalThis.document;
    const actions = createWriterQuickActions({ getContext: () => h.context, onRewrite: async () => { throw new Error('must not run'); }, canRewrite: () => { throw new Error('not ready'); } });
    assert.equal(await h.Parser.commands['ves-rewrite'].callback(), ''); actions.destroy();
});

