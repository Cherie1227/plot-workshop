const installations = new WeakMap();
const LABEL = 'Vespera';

/** Independent top-bar button. The caller owns the extension-settings fallback. */
export function createWorkbenchEntryPoints({ document: doc = globalThis.document, onOpen } = {}) {
    if (typeof onOpen !== 'function') throw new TypeError('Workbench entry points need an onOpen callback.');
    if (!doc?.createElement) return { destroy() {} };
    installations.get(doc)?.destroy();

    let active = true;
    const wrapper = doc.createElement('div');
    wrapper.id = 'vespera-top-entry';
    wrapper.className = 'vespera-top-entry';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'vespera-top-entry-button';
    button.title = LABEL;
    button.setAttribute('aria-label', LABEL);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    svg.classList.add('vespera-top-entry-icon');
    const orbit = doc.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    for (const [key, value] of Object.entries({ cx: '12', cy: '12', rx: '10', ry: '4.4', transform: 'rotate(-30 12 12)' })) orbit.setAttribute(key, value);
    const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [key, value] of Object.entries({ cx: '12', cy: '12', r: '7.3' })) ring.setAttribute(key, value);
    const star = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    star.setAttribute('d', 'M12 8.3l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1zM19.5 3v2M18.5 4h2');
    svg.append(orbit, ring, star);
    button.append(svg);
    wrapper.append(button);

    const stop = event => event.stopPropagation();
    const keyboard = event => {
        if (['Enter', ' ', 'Spacebar'].includes(event.key)) event.stopPropagation();
        // Keep native button activation. Calling onOpen here as well would open twice.
    };
    const open = event => {
        event.preventDefault();
        event.stopPropagation();
        if (active) onOpen();
    };
    const listeners = [['click', open], ['pointerdown', stop], ['mousedown', stop], ['touchstart', stop], ['keydown', keyboard], ['keyup', keyboard]];
    for (const [type, listener] of listeners) button.addEventListener(type, listener);

    function mount() {
        if (!active) return;
        const holder = doc.querySelector('#top-settings-holder');
        if (!holder) { wrapper.remove(); return; }
        if (button.parentNode !== wrapper) wrapper.append(button);
        if (wrapper.parentNode !== holder) holder.append(wrapper);
    }
    const Observer = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(mount) : null;
    function destroy() {
        if (!active) return;
        active = false;
        observer?.disconnect();
        for (const [type, listener] of listeners) button.removeEventListener(type, listener);
        wrapper.remove();
        if (installations.get(doc) === api) installations.delete(doc);
    }
    const api = { destroy };
    installations.set(doc, api);
    mount();
    // Only child changes matter. Stable parents make our own append settle after
    // one follow-up callback; ordinary text/attribute updates are not observed.
    observer?.observe(doc, { childList: true, subtree: true });
    return api;
}
