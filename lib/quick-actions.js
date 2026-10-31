const COMMAND_NAME = 'ves-rewrite';
const installations = new WeakMap();
const registrations = new WeakMap();

/** Optional SillyTavern slash command; no chat-composer UI is installed. */
export function createWriterQuickActions({ getContext, onRewrite, canRewrite }) {
    if (typeof getContext !== 'function' || typeof onRewrite !== 'function' || typeof canRewrite !== 'function') {
        throw new TypeError('Writer shortcuts need context, rewrite, and availability callbacks.');
    }
    let active = true;
    let running = false;
    let registeredParser = null;
    let registeredRecord = null;

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
        try { await onRewrite(); }
        finally { running = false; }
    }
    function releaseCommand() {
        const parser = registeredParser;
        const record = registeredRecord;
        registeredParser = null; registeredRecord = null;
        if (!parser || !record || record.invoke !== invoke) return;
        record.invoke = null;
        if (installations.get(parser) === api) installations.delete(parser);
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
            const previous = installations.get(parser);
            if (previous && previous !== api) previous.destroy();
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
            installations.set(parser, api);
        } catch { /* The slash command is optional on older hosts. */ }
    }
    function refresh() {
        if (active) registerCommand();
    }
    function destroy() {
        if (!active) return;
        active = false;
        releaseCommand();
    }
    const api = { refresh, destroy };
    refresh();
    return api;
}
