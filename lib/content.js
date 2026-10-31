export class ContentError extends Error {
    constructor(message, code = 'CONTENT_INVALID') { super(message); this.name = 'ContentError'; this.code = code; }
}

function fail(message, code) { throw new ContentError(message, code); }
function assert(value, message, code) { if (!value) fail(message, code); }
export function escapeXml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

function decodeXml(text) {
    assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text), 'XML 含有无效字符。');
    return text.replace(/&([^;\s<&]*);|&/g, (match, entity) => {
        const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (Object.prototype.hasOwnProperty.call(names, entity)) return names[entity];
        if (entity && /^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
            const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            assert(point === 9 || point === 10 || point === 13 || (point >= 0x20 && point <= 0xD7FF) || (point >= 0xE000 && point <= 0xFFFD) || (point >= 0x10000 && point <= 0x10FFFF), 'XML 字符实体无效。');
            return String.fromCodePoint(point);
        }
        fail('XML 含有未转义的 & 或不支持的实体。');
    });
}

// Deliberately bounded XML grammar: no DTD, external entities, comments, PI or CDATA.
// The content protocol requires plain escaped text, so both browser and Node validate identically.
function readXml(xml) {
    const document = { name: '#document', attrs: {}, children: [] };
    const stack = [document];
    let position = 0;
    while (position < xml.length) {
        if (xml[position] !== '<') {
            const end = xml.indexOf('<', position);
            const text = xml.slice(position, end < 0 ? xml.length : end);
            assert(!text.includes(']]>'), 'XML 文本中出现无效结束标记。');
            stack.at(-1).children.push(decodeXml(text));
            position = end < 0 ? xml.length : end;
            continue;
        }
        let quote = null;
        let end = position + 1;
        for (; end < xml.length; end++) {
            const char = xml[end];
            if (quote) { if (char === quote) quote = null; }
            else if (char === '"' || char === "'") quote = char;
            else if (char === '>') break;
        }
        assert(end < xml.length && !quote, 'XML 标签被截断。', 'CONTENT_TRUNCATED');
        const token = xml.slice(position, end + 1);
        position = end + 1;
        if (token.startsWith('</')) {
            const match = /^<\/([A-Za-z_][\w.-]*)\s*>$/.exec(token);
            assert(match && stack.length > 1 && stack.at(-1).name === match[1], 'XML 标签未正确配对。');
            stack.pop();
            continue;
        }
        const match = /^<([A-Za-z_][\w.-]*)([\s\S]*?)(\/?)>$/.exec(token);
        assert(match, 'XML 仅允许协议标签与转义后的文本；不支持声明、注释或 CDATA。');
        const attrs = Object.create(null);
        let rest = match[2];
        while (rest.trim()) {
            const attr = /^\s+([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
            assert(attr && !Object.prototype.hasOwnProperty.call(attrs, attr[1]), 'XML 属性无效或重复。');
            attrs[attr[1]] = decodeXml(attr[2] ?? attr[3]);
            rest = rest.slice(attr[0].length);
        }
        const node = { name: match[1], attrs, children: [] };
        stack.at(-1).children.push(node);
        if (!match[3]) stack.push(node);
        assert(stack.length < 16, 'XML 嵌套层级过多。');
    }
    assert(stack.length === 1, 'XML 未完整闭合。', 'CONTENT_TRUNCATED');
    return document;
}

function elements(node) {
    assert(node.children.filter(x => typeof x === 'string').every(x => !x.trim()), `${node.name} 中不能混入字段以外的文本。`);
    return node.children.filter(x => typeof x !== 'string');
}
function attributes(node, expected = []) {
    assert(Object.keys(node.attrs).length === expected.length && expected.every(x => Object.prototype.hasOwnProperty.call(node.attrs, x)), `${node.name} 的属性不符合协议。`);
}
function childrenNamed(node, names) {
    const children = elements(node);
    assert(children.length === names.length && children.every((child, index) => child.name === names[index]), `${node.name} 的字段缺失、重复或顺序错误。`);
    return children;
}
function textOnly(node) {
    assert(node.children.every(x => typeof x === 'string'), `${node.name} 必须是文本，不允许额外嵌套标签。`);
    const result = node.children.join('').trim();
    assert(result, `${node.name} 不能为空。`);
    return result;
}

/** Locate the original source span, ignoring plain-text mentions of the root tag.
 * A document starts with XML children. Never choose between competing documents
 * or salvage a nested/truncated document by silently dropping its outer fields. */
export function extractContent(response) {
    assert(typeof response === 'string' && response.length <= 2_000_000, '规划结果必须是有效且大小合理的文本。');
    const spans = [];
    let active = null, firstOpen = null, firstClose = null;
    for (const token of response.matchAll(/<\/?content(?=[\s/>])[^<>]*>/g)) {
        if (token[0].startsWith('</')) {
            if (!/^<\/content\s*>$/.test(token[0])) continue;
            if (firstOpen !== null && firstClose === null) firstClose = token.index + token[0].length;
            if (active !== null) {
                spans.push({ start: active, end: token.index + token[0].length });
                active = null;
            }
            continue;
        }
        firstOpen ??= token.index;
        assert(active === null, '大纲内出现嵌套的 content 标签，请只输出一份完整大纲。', 'CONTENT_INVALID');
        const after = response.slice(token.index + token[0].length);
        if (/^\s*<(?:[A-Za-z_!?]|\/content(?=[\s>]))/.test(after)) active = token.index;
    }
    assert(spans.length + Number(active !== null) <= 1, '返回了多份大纲或多个大纲起始结构，无法确定应采用哪一份。请只输出一份大纲。', 'CONTENT_MULTIPLE');
    assert(active === null, '大纲 content 被截断或没有正确闭合，请重新生成。', 'CONTENT_TRUNCATED');
    if (spans.length) return { ...spans[0], xml: response.slice(spans[0].start, spans[0].end) };
    assert(firstOpen !== null || /<content(?=[\s/>]|$)/.test(response), '返回文本中未找到 content 大纲标签，请检查规划预设的输出格式条目是否启用。', 'CONTENT_MISSING');
    assert(firstOpen !== null && firstClose !== null, '大纲 content 被截断或没有正确闭合，请重新生成。', 'CONTENT_TRUNCATED');
    return { start: firstOpen, end: firstClose, xml: response.slice(firstOpen, firstClose) };
}

function parseContentV2(root) {
    const [directionNode, beatsNode, anchorsNode, endNode] = childrenNamed(root, ['direction', 'beats', 'anchors', 'end_state']);
    for (const node of [directionNode, beatsNode, anchorsNode, endNode]) attributes(node);
    const direction = textOnly(directionNode), anchors = textOnly(anchorsNode), endState = textOnly(endNode);
    const nodes = elements(beatsNode);
    assert(nodes.length && nodes.every(n => n.name === 'beat'), 'beats 必须包含具体的 beat。');
    const beats = nodes.map((node, index) => {
        attributes(node, ['index']);
        assert(node.attrs.index === String(index + 1), 'beat 的 index 必须从 1 开始连续编号。');
        const fields = elements(node), signature = fields.map(field => field.name).join(',');
        assert(['event', 'event,emotion', 'event,choice', 'event,emotion,choice'].includes(signature),
            'beat 必须包含 event，emotion 与 choice 可按此顺序选填。');
        for (const field of fields) attributes(field);
        const beat = { index: index + 1, event: textOnly(fields[0]) };
        for (const field of fields.slice(1)) beat[field.name] = textOnly(field);
        beat.text = [`事件：${beat.event}`, beat.emotion ? `情绪：${beat.emotion}` : '', beat.choice ? `核心选择：${beat.choice}` : ''].filter(Boolean).join('\n');
        return beat;
    });
    const canonical = [
        '<content>', `<direction>${escapeXml(direction)}</direction>`, '<beats>',
        ...beats.map(beat => [`<beat index="${beat.index}">`, `<event>${escapeXml(beat.event)}</event>`,
            beat.emotion ? `<emotion>${escapeXml(beat.emotion)}</emotion>` : '',
            beat.choice ? `<choice>${escapeXml(beat.choice)}</choice>` : '', '</beat>'].filter(Boolean).join('\n')),
        '</beats>', `<anchors>${escapeXml(anchors)}</anchors>`, `<end_state>${escapeXml(endState)}</end_state>`, '</content>',
    ].join('\n');
    // plot/characters/segments remain as compatibility views for patrol, polish,
    // saved versions and older callers. The injected XML keeps the native v2 form.
    return { xml: canonical, version: 2, contract: 'content-v2.0', direction, plot: direction,
        characters: [], beats, segments: beats, anchors, endState };
}

/** Extracts one complete content. Text before/after it is discarded and never injected. */
export function parseContent(response, { DOMParser: Parser = globalThis.DOMParser } = {}) {
    const { xml } = extractContent(response);
    const doc = readXml(xml);
    if (typeof Parser === 'function') {
        const browserDoc = new Parser().parseFromString(xml, 'application/xml');
        assert(!browserDoc.querySelector?.('parsererror') && browserDoc.documentElement?.nodeName === 'content', '浏览器 XML 校验未通过。');
    }
    const [root] = childrenNamed(doc, ['content']);
    attributes(root);
    if (elements(root)[0]?.name === 'direction') return parseContentV2(root);
    const [plotNode, charactersNode, segmentsNode, endNode] = childrenNamed(root, ['plot', 'characters', 'segments', 'end_state']);
    for (const node of [plotNode, charactersNode, segmentsNode, endNode]) attributes(node);
    const plot = textOnly(plotNode);
    const endState = textOnly(endNode);
    let characters = [];
    if (charactersNode.children.every(x => typeof x === 'string') && charactersNode.children.join('').trim() === '不涉及') {
        characters = [];
    } else {
        const names = new Set();
        const nodes = elements(charactersNode);
        assert(nodes.length && nodes.every(n => n.name === 'character'), 'characters 应包含 character，或明确填写“不涉及”。');
        characters = nodes.map(node => {
            attributes(node, ['name']);
            const name = node.attrs.name.trim();
            assert(name && !names.has(name), '人物姓名不能为空或重复。');
            names.add(name);
            const [emotion, responseNode] = childrenNamed(node, ['emotion', 'response']);
            attributes(emotion); attributes(responseNode);
            return { name, emotion: textOnly(emotion), response: textOnly(responseNode) };
        });
    }
    const nodes = elements(segmentsNode);
    assert(nodes.length && nodes.every(n => n.name === 'segment'), 'segments 必须包含具体的 segment。');
    const segments = nodes.map((node, index) => {
        attributes(node, ['index']);
        assert(node.attrs.index === String(index + 1), 'segment 的 index 必须从 1 开始连续编号。');
        return { index: index + 1, text: textOnly(node) };
    });
    const canonical = [
        '<content>', `<plot>${escapeXml(plot)}</plot>`, '<characters>',
        ...(characters.length ? characters.map(c => `<character name="${escapeXml(c.name)}">\n<emotion>${escapeXml(c.emotion)}</emotion>\n<response>${escapeXml(c.response)}</response>\n</character>`) : ['不涉及']),
        '</characters>', '<segments>',
        ...segments.map(s => `<segment index="${s.index}">${escapeXml(s.text)}</segment>`),
        '</segments>', `<end_state>${escapeXml(endState)}</end_state>`, '</content>',
    ].join('\n');
    return { xml: canonical, version: 1, contract: 'content-v1.2', plot, characters, segments, endState };
}

function stableStringify(value, ancestors = new Set()) {
    if (value === null || typeof value !== 'object') {
        assert(['string', 'number', 'boolean'].includes(typeof value) || value === null, '快照只能包含 JSON 数据。');
        assert(typeof value !== 'number' || Number.isFinite(value), '快照数字无效。');
        return JSON.stringify(value);
    }
    assert(!ancestors.has(value), '快照不能包含循环引用。');
    ancestors.add(value);
    const serialized = Array.isArray(value)
        ? `[${value.map(x => stableStringify(x, ancestors)).join(',')}]`
        : `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k], ancestors)}`).join(',')}}`;
    ancestors.delete(value);
    return serialized;
}

// SHA-256 fallback for LAN HTTP pages where WebCrypto is unavailable. This fingerprint
// only identifies stale work, but keeping the same digest across environments is useful.
function sha256(bytes) {
    const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const state = new Int32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes); padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000), false);
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0, false);
    const rotate = (value, count) => (value >>> count) | (value << (32 - count));
    const words = new Int32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const x = words[i - 15], y = words[i - 2];
            const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
            const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
            words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
        }
        let [a,b,c,d,e,f,g,h] = state;
        for (let i = 0; i < 64; i++) {
            const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const t1 = (h + s1 + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
            const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
        }
        [a,b,c,d,e,f,g,h].forEach((value, i) => { state[i] = (state[i] + value) | 0; });
    }
    return Array.from(state, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Include chat id, history, currentInput, card, memory/settings revisions in the caller's snapshot. */
export async function snapshotHash(snapshot, { crypto = globalThis.crypto } = {}) {
    const bytes = new TextEncoder().encode(stableStringify(snapshot));
    if (!crypto?.subtle?.digest) return sha256(bytes);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
