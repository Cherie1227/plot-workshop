const CONTAINERS = new Set(['[ANIMA_Chat_History_Container]', '[ANIMA_Knowledge_Container]']);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const validBook = data => data && typeof data === 'object' && !Array.isArray(data)
    && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries);

/** Page-local proof for the reviewed Anima container cleanup, never persisted. */
export function createAnimaCleanupGuard() {
    const snapshots = new Map();
    let proof = null;
    return {
        observe(name, data) {
            if (typeof name !== 'string' || !name || !validBook(data)) return false;
            try {
                snapshots.delete(name); snapshots.set(name, structuredClone(data));
                if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
                return true;
            } catch { snapshots.delete(name); return false; }
        },
        authorize(verified, chatId) {
            proof = null;
            if (!verified || verified.chatId !== chatId || typeof verified.bookName !== 'string'
                || !Array.isArray(verified.entries)) return;
            const baseline = snapshots.get(verified.bookName);
            if (!baseline) return;
            const entries = new Map();
            for (const entry of verified.entries) {
                if (!Number.isInteger(entry?.uid) || entry.uid < 0 || entries.has(entry.uid) || !CONTAINERS.has(entry.name)
                    || typeof entry.content !== 'string' || !entry.content.trim()) return;
                const actual = baseline.entries[String(entry.uid)];
                if (!actual || actual.uid !== entry.uid || (actual.comment ?? actual.name) !== entry.name || actual.content !== entry.content) return;
                entries.set(entry.uid, entry.content);
            }
            proof = { chatId, name: verified.bookName, baseline: structuredClone(baseline), entries };
        },
        consume(name, data, chatId) {
            if (!proof || proof.chatId !== chatId || proof.name !== name || !validBook(data)) return null;
            try {
                const expected = structuredClone(proof.baseline);
                let cleared = 0;
                for (const [uid, content] of proof.entries) {
                    const before = expected.entries[String(uid)], after = data.entries[String(uid)];
                    if (before?.content === content && after?.content === '') { before.content = ''; cleared++; }
                }
                // Every other entry and every field, including book metadata,
                // must remain identical. A same-name entry is not a proof.
                if (canonical(expected) !== canonical(data)) return null;
                proof.baseline = structuredClone(data);
                return { cleared };
            } catch { return null; }
        },
        invalidate() { proof = null; },
        reset() { proof = null; snapshots.clear(); },
    };
}
