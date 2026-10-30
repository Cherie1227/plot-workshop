import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchEntryPoints } from '../lib/entry-points.js';

class Event {
    constructor(type, extra = {}) { Object.assign(this, { type, bubbles: true, defaultPrevented: false, stopped: false }, extra); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
}
class Node {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
        this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.style = {}; this.hidden = false;
        this.classList = { add: value => { this.className = `${this.className} ${value}`.trim(); } };
    }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); this.ownerDocument?.changed(this); } }
    insertBefore(node, anchor) {
        assert.ok(this.children.includes(anchor)); node.remove(); node.parentNode = this;
        this.children.splice(this.children.indexOf(anchor), 0, node); this.ownerDocument?.changed(this);
    }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; this.ownerDocument?.changed(parent); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) {
        event.target ||= this;
        for (let node = this; node; node = event.bubbles && !event.stopped ? node.parentNode : null) {
            event.currentTarget = node;
            for (const listener of [...node.listeners.get(event.type) || []]) listener(event);
        }
        return !event.defaultPrevented;
    }
    click() { this.dispatchEvent(new Event('click')); }
    querySelectorAll(selector) {
        const match = node => selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector.toUpperCase();
        return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Document extends Node {
    constructor() {
        super('document'); this.ownerDocument = this; this.observers = new Set(); this.pending = new Set(); this.callbacks = 0;
        const doc = this;
        this.defaultView = { getComputedStyle: node => ({ display: node.style.display || 'block', visibility: node.style.visibility || 'visible' }), MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe(target, options) { assert.equal(target, doc); assert.deepEqual(options, { childList: true, subtree: true }); doc.observers.add(this); }
            disconnect() { doc.observers.delete(this); doc.pending.delete(this); }
        } };
        this.body = this.createElement('body'); this.append(this.body);
    }
    createElement(tag) { return new Node(tag, this); }
    createElementNS(_namespace, tag) { return this.createElement(tag); }
    changed(node) {
        for (let current = node; current; current = current.parentNode) {
            if (current === this) { for (const observer of this.observers) this.pending.add(observer); return; }
        }
    }
    flush() {
        for (let count = 0; this.pending.size; count++) {
            assert.ok(count < 10, 'observer mutations must settle');
            const pending = [...this.pending]; this.pending.clear();
            for (const observer of pending) if (this.observers.has(observer)) { this.callbacks++; observer.callback([]); }
        }
    }
}
function fixture({ top = true } = {}) {
    const document = new Document();
    const holder = document.createElement('div'); holder.id = 'top-settings-holder';
    const drawer = document.createElement('div'); drawer.className = 'drawer'; holder.append(drawer);
    if (top) document.body.append(holder);
    const menu = document.createElement('div'); menu.id = 'extensionsMenu'; document.body.append(menu);
    return { document, holder, drawer, menu, button: () => document.querySelector('.vespera-top-entry-button') };
}

test('mounts an independent accessible button and never adds a magic-wand menu item', () => {
    const h = fixture(); let opens = 0;
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen: () => opens++ });
    const button = h.button(), wrapper = button.parentNode;
    assert.equal(wrapper.parentNode, h.holder);
    assert.equal(wrapper.id, 'vespera-top-entry');
    assert.equal(button.type, 'button'); assert.equal(button.title, 'Vespera'); assert.equal(button.getAttribute('aria-label'), 'Vespera');
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(wrapper.querySelector('.drawer-toggle'), null); assert.equal(wrapper.querySelector('.drawer-icon'), null);
    assert.equal(h.menu.children.length, 0); assert.equal(h.holder.children[0], h.drawer); assert.equal(opens, 0);
    button.click(); assert.equal(opens, 1); entry.destroy();
});

test('click and pointer events cannot trigger ancestor drawer handlers; native Enter/Space activation opens once', () => {
    const h = fixture(); let opens = 0, hostEvents = 0;
    for (const type of ['click', 'pointerdown', 'mousedown', 'touchstart', 'keydown', 'keyup']) h.holder.addEventListener(type, () => hostEvents++);
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen: () => opens++ });
    const button = h.button();
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
        const event = new Event(type); button.dispatchEvent(event); assert.equal(event.defaultPrevented, false, 'pointer focus/default behavior is preserved');
    }
    button.querySelector('path').dispatchEvent(new Event('click')); assert.equal(opens, 1); assert.equal(hostEvents, 0);
    for (const key of ['Enter', ' ']) {
        const before = opens, down = new Event('keydown', { key }), up = new Event('keyup', { key });
        assert.equal(button.dispatchEvent(down), true, 'native keyboard default is not cancelled');
        assert.equal(opens, before, 'keydown does not also invoke the callback');
        if (key === 'Enter') button.click(); // Native button default on Enter keydown.
        assert.equal(button.dispatchEvent(up), true);
        if (key === ' ') button.click(); // Native button default on Space keyup.
        assert.equal(opens, before + 1);
    }
    assert.equal(hostEvents, 0);
    button.dispatchEvent(new Event('keydown', { key: 'Escape' })); assert.equal(hostEvents, 1);
    entry.destroy();
});

test('places the entry third from the right while preserving every other slot order', () => {
    const h = fixture();
    for (let i = 0; i < 8; i++) h.holder.append(h.document.createElement('div'));
    const original = [...h.holder.children];
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen() {} });
    const wrapper = h.button().parentNode;
    assert.equal(h.holder.children.at(-3), wrapper);
    assert.deepEqual(h.holder.children.filter(node => node !== wrapper), original);
    h.document.body.append(h.document.createElement('p')); h.document.flush();
    assert.equal(h.document.callbacks, 1, 'an unrelated mutation does not move the entry again');
    entry.destroy();
});

test('hidden slots do not count, but a hidden toolbar retains its planned slot order', () => {
    const h = fixture();
    const visible = [h.drawer];
    for (let i = 0; i < 3; i++) { const node = h.document.createElement('div'); visible.push(node); h.holder.append(node); }
    for (const type of ['hidden', 'display', 'visibility']) {
        const node = h.document.createElement('div');
        if (type === 'hidden') node.hidden = true;
        else node.style[type] = type === 'display' ? 'none' : 'hidden';
        h.holder.append(node);
    }
    h.holder.style.display = 'none';
    const original = [...h.holder.children];
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen() {} });
    const wrapper = h.button().parentNode;
    assert.equal(wrapper.nextElementSibling, visible.at(-2));
    assert.deepEqual(h.holder.children.filter(node => node !== wrapper), original);
    entry.destroy();
});

test('new or removed toolbar slots update the placement without duplicate entries or observer loops', () => {
    const h = fixture();
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen() {} });
    const wrapper = h.button().parentNode;
    const added = h.document.createElement('div'); h.holder.append(added); h.document.flush();
    assert.equal(h.holder.children.at(-3), wrapper);
    const last = h.document.createElement('div'); h.holder.append(last); h.document.flush();
    assert.equal(h.holder.children.at(-3), wrapper);
    assert.deepEqual(h.holder.children.filter(node => node !== wrapper), [h.drawer, added, last]);
    added.remove(); h.document.flush();
    assert.equal(h.holder.children.at(-3), wrapper);
    assert.equal(h.document.querySelectorAll('.vespera-top-entry').length, 1);
    entry.destroy();
});

test('repeated initialization replaces the previous registration without duplicate callbacks or buttons', () => {
    const h = fixture(); let oldCalls = 0, newCalls = 0;
    const old = createWorkbenchEntryPoints({ document: h.document, onOpen: () => oldCalls++ }); const oldButton = h.button();
    const current = createWorkbenchEntryPoints({ document: h.document, onOpen: () => newCalls++ });
    h.document.flush();
    assert.equal(h.document.querySelectorAll('.vespera-top-entry').length, 1); assert.equal(h.document.observers.size, 1);
    oldButton.click(); h.button().click(); assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
    old.destroy(); assert.ok(h.button()); current.destroy(); assert.equal(h.button(), null);
});

test('late and replaced top bars receive the same button without mutation loops', () => {
    const h = fixture({ top: false }); let calls = 0;
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen: () => calls++ });
    assert.equal(h.button(), null); assert.equal(h.menu.children.length, 0);
    h.document.body.append(h.holder); h.document.flush(); const button = h.button(); assert.ok(button);
    const before = h.document.callbacks;
    h.document.body.append(h.document.createElement('p')); h.document.flush(); assert.equal(h.document.callbacks, before + 1);
    h.holder.remove(); h.document.flush(); assert.equal(button.parentNode.parentNode, null);
    const nextHolder = h.document.createElement('div'); nextHolder.id = 'top-settings-holder'; h.document.body.append(nextHolder); h.document.flush();
    assert.equal(h.button(), button); assert.equal(button.parentNode.parentNode, nextHolder); assert.equal(calls, 0);
    button.remove(); h.document.flush(); assert.equal(h.button(), button, 'host child replacement is repaired');
    entry.destroy();
});

test('destroy removes bindings and observers, including when the top bar never appeared', () => {
    const h = fixture(); let calls = 0;
    const entry = createWorkbenchEntryPoints({ document: h.document, onOpen: () => calls++ }); const button = h.button();
    entry.destroy(); entry.destroy(); h.document.flush();
    assert.equal(h.button(), null); assert.equal(h.document.observers.size, 0); assert.equal(h.document.pending.size, 0);
    button.click(); assert.equal(calls, 0);
    assert.ok([...button.listeners.values()].every(set => set.size === 0));
    h.document.body.append(h.document.createElement('aside')); h.document.flush(); assert.equal(h.button(), null);
    const late = fixture({ top: false }); const unmounted = createWorkbenchEntryPoints({ document: late.document, onOpen() {} });
    unmounted.destroy(); late.document.body.append(late.holder); late.document.flush(); assert.equal(late.button(), null);
});

test('a missing DOM is harmless while an invalid callback is rejected', () => {
    assert.doesNotThrow(() => createWorkbenchEntryPoints({ document: null, onOpen() {} }).destroy());
    assert.throws(() => createWorkbenchEntryPoints({ document: null }), TypeError);
});
