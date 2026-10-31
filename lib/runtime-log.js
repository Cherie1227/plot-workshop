// Current-page diagnostics only. Callers supply fixed status text, never chat,
// prompts, provider bodies, headers, or Error objects. This module does not read
// any host state or persist/export anything unless text() is explicitly called.
const LEVELS = new Set(['debug', 'info', 'success', 'warn', 'error']);
const META_FIELDS = new Set([
    'stage', 'model', 'method', 'durationMs', 'duration', 'status', 'statusCode',
    'count', 'attempt', 'source', 'mode', 'position', 'depth', 'role', 'version', 'reason', 'targetId',
    'characters', 'promptCount', 'messageCount', 'animaStatus', 'injectionPosition',
    'injectionDepth', 'injectionRole', 'enabled', 'success', 'reused', 'code', 'retrievalSkipped',
]);
const MESSAGE_LIMIT = 600;
const META_LIMIT = 160;

export function createRuntimeLog({ getSecrets = () => [], limit = 200 } = {}) {
    const capacity = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
    const entries = [];
    const knownSecrets = new Set();
    let nextId = 0;

    function rememberSecrets() {
        let values;
        try { values = typeof getSecrets === 'function' ? getSecrets() : []; }
        catch { values = []; }
        if (typeof values === 'string') values = [values];
        if (values instanceof Set) values = [...values];
        if (!Array.isArray(values)) return;
        for (const value of values) {
            if (typeof value !== 'string' || !value) continue;
            knownSecrets.add(value);
            if (value.trim()) knownSecrets.add(value.trim());
            try { knownSecrets.add(encodeURIComponent(value)); } catch { /* Invalid unicode: keep the literal form. */ }
            knownSecrets.add(JSON.stringify(value).slice(1, -1));
        }
    }

    function redact(value, maxLength) {
        let text = value;
        // Redact BEFORE truncation, so truncating inside a known key cannot leak
        // its prefix. Retain known keys after edits and clear() for later errors.
        for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
            if (secret) text = text.split(secret).join('[REDACTED]');
        }
        text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
            .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
            .replace(/\b(api[-_ ]?key|authorization|access[-_ ]?token|token|secret|password|proxy_password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
            .replace(/[\r\n]+/g, ' ⏎ ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
    }

    function redactExisting() {
        for (const entry of entries) {
            entry.event = redact(entry.event, 64);
            entry.message = redact(entry.message, MESSAGE_LIMIT);
            for (const key of Object.keys(entry.details)) {
                if (typeof entry.details[key] === 'string') entry.details[key] = redact(entry.details[key], META_LIMIT);
            }
        }
    }

    function metadata(details) {
        const safe = {};
        if (!details || typeof details !== 'object' || Array.isArray(details)) return safe;
        for (const key of META_FIELDS) {
            // Do not invoke getters or serialize nested request/response objects.
            const descriptor = Object.getOwnPropertyDescriptor(details, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
            const value = descriptor.value;
            if (typeof value === 'string') safe[key] = redact(value, META_LIMIT);
            else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
            else if (typeof value === 'boolean') safe[key] = value;
        }
        return safe;
    }

    function add(level, event, message, details) {
        rememberSecrets();
        redactExisting();
        const entry = {
            id: ++nextId,
            timestamp: new Date().toISOString(),
            level: LEVELS.has(level) ? level : 'info',
            event: typeof event === 'string' ? redact(event, 64) : 'event',
            message: typeof message === 'string' ? redact(message, MESSAGE_LIMIT) : '[已省略非文本消息]',
            details: metadata(details),
        };
        entries.push(entry);
        if (entries.length > capacity) entries.splice(0, entries.length - capacity);
        return entry;
    }

    function clear() { entries.splice(0, entries.length); }

    function text() {
        rememberSecrets();
        redactExisting();
        return entries.map(entry => {
            const details = Object.keys(entry.details).length ? ` ${JSON.stringify(entry.details)}` : '';
            return `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.event}: ${entry.message}${details}`;
        }).join('\n');
    }

    return { entries, add, clear, text };
}
