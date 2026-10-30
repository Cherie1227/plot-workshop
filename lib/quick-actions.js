const COMMAND_NAME = 'ves-rewrite';
const LABEL = '按大纲重写正文';
const installations = new WeakMap();
const registrations = new WeakMap();

/** Chat-composer shortcut and an optional SillyTavern slash command. */
export function createWriterQuickActions({ getContext, onRewrite, canRewrite, rewriteReason }) {
    if (typeof getContext !== 'function' || typeof onRewrite !== 'function' || typeof canRewrite !== 'function') {
        throw new TypeError('Writer shortcuts need context, rewrite, and availability callbacks.');
    }
    const doc = globalThis.document;
    let active = true;
    let running = false;
    let registeredParser = null;
    let registeredRecord = null;
    let button = null;
    let menuLabel = null;
    const previous = doc && installations.get(doc);
    previous?.destroy();

    function context() {
        try { return getContext() || {}; } catch { return {}; }
    }
    function available() {
        if (!active || running) return false;
        try { return Boolean(canRewrite()); } catch { return false; }
    }
    async function invoke() {
        if (!available()) return;
        running = true;
        refresh();
        try { await onRewrite(); }
        finally { running = false; if (active) refresh(); }
    }
    function releaseCommand() {
        const parser = registeredParser;
        const record = registeredRecord;
        registeredParser = null; registeredRecord = null;
        if (!parser || !record || record.invoke !== invoke) return;
        record.invoke = null;
        // There is no public unregister API. Remove only the exact object we own.
        try {
            if (parser.commands?.[COMMAND_NAME] === record.command) delete parser.commands[COMMAND_NAME];
            if (parser.commands && parser.commands[COMMAND_NAME] !== record.command && registrations.get(parser) === record) registrations.delete(parser);
        } catch { /* A read-only registry keeps an inert callback after destruction. */ }
    }
    function registerCommand() {
        const { SlashCommandParser: parser, SlashCommand } = context();
        if (registeredParser && registeredParser !== parser) releaseCommand();
        if (!parser || typeof parser.addCommandObject !== 'function' || typeof SlashCommand?.fromProps !== 'function') return;
        try {
            let record = registrations.get(parser);
            const current = parser.commands?.[COMMAND_NAME];
            if (current && current !== record?.command) return;
            if (record && parser.commands && current !== record.command) {
                registrations.delete(parser); record = null;
            }
            if (!record) {
                record = { command: null, invoke };
                record.command = SlashCommand.fromProps({
                    name: COMMAND_NAME,
                    callback: async () => { await record.invoke?.(); return ''; },
                    helpString: '沿用本轮大纲重写最后一条正文，不重新规划。',
                });
                parser.addCommandObject(record.command);
                registrations.set(parser, record);
            }
            record.invoke = invoke;
            registeredParser = parser; registeredRecord = record;
        } catch { /* Older hosts still retain the composer/menu button. */ }
    }
    function makeButton() {
        if (!doc?.createElement) return;
        button = doc.createElement('button');
        button.type = 'button';
        button.title = LABEL;
        button.setAttribute('aria-label', LABEL);
        const arrow = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) arrow.setAttribute(key, value);
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M20 7v5h-5M4 17v-5h5M5.5 8a7 7 0 0 1 11.8-2L20 9M4 15l2.7 3A7 7 0 0 0 18.5 16');
        arrow.append(path);
        menuLabel = doc.createElement('span'); menuLabel.textContent = LABEL;
        button.append(arrow, menuLabel);
        button.addEventListener('click', () => {
            invoke().catch(error => {
                const toast = context().toastr || globalThis.toastr;
                if (typeof toast?.error === 'function') toast.error(error?.message || '正文重写失败。');
                else console.error('Vespera: 正文重写失败。', error);
            });
        });
    }
    function mountButton() {
        if (!button) return;
        const form = doc.querySelector('#send_form');
        const left = form?.querySelector('#leftSendForm');
        const menu = doc.querySelector('#extensionsMenu');
        const target = form || menu;
        if (!target) { button.remove(); return; }
        const inMenu = !form;
        button.className = `vespera-rewrite-shortcut${inMenu ? ' vespera-rewrite-shortcut--menu list-group-item flex-container flexGap5' : ''}`;
        menuLabel.hidden = !inMenu;
        if (left?.parentNode) {
            if (left.nextSibling !== button) left.parentNode.insertBefore(button, left.nextSibling);
        } else if (button.parentNode !== target) target.append(button);
    }
    function refresh() {
        if (!active) return;
        registerCommand();
        mountButton();
        if (button) {
            button.disabled = !available();
            button.setAttribute('aria-disabled', String(button.disabled));
            let reason = '';
            if (button.disabled && typeof rewriteReason === 'function') {
                try { reason = rewriteReason() || ''; } catch { reason = ''; }
            }
            button.title = reason || LABEL;
        }
    }
    function destroy() {
        if (!active) return;
        active = false;
        releaseCommand();
        button?.remove();
        if (doc && installations.get(doc) === api) installations.delete(doc);
    }
    const api = { refresh, destroy };
    makeButton();
    if (doc) installations.set(doc, api);
    refresh();
    return api;
}
