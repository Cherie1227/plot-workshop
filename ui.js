/** Mobile-first, dependency-free workbench. No model or preset text is interpreted as HTML. */
const ICONS = {
    book: '<path d="M3 5c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1z"/><path d="M12 6v15M1 8v14h9m13-14v14h-9"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    copy: '<rect x="8" y="5" width="12" height="16" rx="2"/><path d="M15 5V3H4v15h4"/>',
    external: '<path d="M14 3h7v7m0-7L11 13M10 3H3v18h18v-7"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15z"/>',
    file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M9 12h6m-6 4h6"/>',
    chevron: '<path d="m8 4 8 8-8 8"/>',
    settings: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="19" r="2"/>',
    list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}
function icon(name) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.65');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.innerHTML = ICONS[name] || ICONS.file;
    return node;
}
function button(text, callback, { className = '', iconName, title } = {}) {
    const node = el('button', `pw-button ${className}`.trim());
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    node.append(el('span', '', text));
    if (title) node.title = title;
    node.addEventListener('click', callback);
    return node;
}
function field(label, input, hint) {
    const wrap = el('label', 'pw-field');
    wrap.append(el('span', 'pw-label', label), input);
    if (hint) wrap.append(el('span', 'pw-hint', hint));
    return wrap;
}
function control(type, placeholder = '') {
    const node = el('input', 'pw-input');
    node.type = type;
    node.placeholder = placeholder;
    return node;
}
function setInputValue(node, value) {
    if (document.activeElement !== node && node.value !== String(value ?? '')) node.value = value ?? '';
}
function makeSwitch(label, value, change) {
    const wrap = el('label', 'pw-switch');
    const input = control('checkbox');
    input.checked = value;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => change(input.checked));
    wrap.append(input, el('span', 'pw-switch-track'));
    return wrap;
}

export function createWorkbench({ getState, onAction }) {
    if (typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('Workbench needs state and action handlers.');
    const dialog = el('dialog', 'pw-workbench');
    dialog.setAttribute('aria-labelledby', 'pw-title');
    dialog.tabIndex = -1;
    const shell = el('div', 'pw-shell');
    dialog.append(shell);
    let activeTab = 'outline';
    let planView = 'read';
    let selectedPrompt = null;
    let dirtyPrompt = false;
    let dirtyPlan = false;
    let seenRawPlan;
    let presetSignature = '';
    let planSignature = '';
    let beforeFocus;
    let oldBodyOverflow;
    let ownsScrollLock = false;
    let destroyed = false;
    const groupOpen = new Map();
    const mobile = window.matchMedia('(max-width: 760px)');
    const statusMessage = el('div', 'pw-message');
    statusMessage.setAttribute('role', 'status');
    statusMessage.setAttribute('aria-live', 'polite');

    async function act(type, payload) {
        try {
            statusMessage.textContent = '';
            const result = await onAction(type, payload);
            render();
            return result;
        } catch (error) {
            statusMessage.textContent = error?.message || '操作没有完成，请稍后重试。';
            statusMessage.classList.add('pw-error');
            statusMessage.scrollIntoView({ block: 'nearest' });
            return false;
        }
    }
    function tabTo(tab) {
        activeTab = tab;
        if (tab !== 'presets') selectedPrompt = null;
        renderTabs();
    }

    const header = el('header', 'pw-header');
    const brand = el('div', 'pw-brand');
    brand.append(icon('book'));
    const title = el('h1', '', '剧情工坊');
    title.id = 'pw-title';
    brand.append(title);
    const desktopTabs = el('nav', 'pw-desktop-tabs');
    desktopTabs.setAttribute('aria-label', '工作区');
    const topOutline = button('本轮大纲', () => tabTo('outline'), { className: 'pw-tab' });
    const topPresets = button('预设管理', () => tabTo('presets'), { className: 'pw-tab' });
    desktopTabs.append(topOutline, topPresets);
    const closeButton = button('关闭', close, { className: 'pw-close', iconName: 'close' });
    header.append(brand, desktopTabs, closeButton);
    shell.append(header);
    if (getState().preview) shell.append(el('div', 'pw-preview-banner', '界面预览，不调用真实接口'));

    const body = el('div', 'pw-body');
    const presets = el('aside', 'pw-presets');
    presets.setAttribute('aria-label', '规划预设');
    const presetHead = el('div', 'pw-section-heading');
    presetHead.append(el('h2', '', '规划预设'));
    const presetSelect = el('select', 'pw-input');
    presetSelect.setAttribute('aria-label', '规划预设');
    presetSelect.addEventListener('change', () => { if (presetSelect.value === 'builtin') act('selectPreset', { id: 'builtin' }); });
    const importInput = control('file');
    importInput.accept = '.json,application/json';
    importInput.hidden = true;
    importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { statusMessage.textContent = '预设超过 8 MB，请缩小文件后再导入。'; return; }
        await act('importPreset', { text: await file.text(), name: file.name.replace(/\.json$/i, '') });
        importInput.value = '';
        selectedPrompt = null;
        render();
    });
    const presetActions = el('div', 'pw-preset-actions');
    presetActions.append(button('导入 JSON', () => importInput.click(), { iconName: 'upload' }), button('导出', () => act('exportPreset'), { iconName: 'download' }));
    const presetGroups = el('div', 'pw-groups');
    const presetWarnings = el('p', 'pw-hint pw-preset-warnings');
    presets.append(presetHead, presetSelect, importInput, presetActions, presetGroups, el('p', 'pw-hint', '条目可编辑，可单独关闭'), presetWarnings);

    const main = el('main', 'pw-main');
    const outlinePage = el('section', 'pw-outline-page');
    const pageHeading = el('div', 'pw-page-heading');
    const pageSubtitle = el('p', '', '先决定人物与剧情，再交给主模型成文');
    pageHeading.append(el('h2', '', '本轮大纲'), pageSubtitle);
    const steps = el('ol', 'pw-steps');
    const stepNodes = ['读取记忆', '生成大纲', '编辑确认', '正文扩写'].map((name, i) => {
        const item = el('li');
        item.append(el('span', 'pw-step-dot', i + 1), el('span', 'pw-step-label', name));
        steps.append(item);
        return item;
    });
    const input = el('textarea', 'pw-input pw-user-input');
    input.rows = 3;
    input.placeholder = '从酒馆输入框读取，或在这里编辑…';
    input.setAttribute('aria-label', '本轮输入');
    input.addEventListener('input', () => act('input', { value: input.value }));
    const inputField = field('本轮输入', input);
    const generationActions = el('div', 'pw-generate-actions');
    const generateButton = button('生成大纲', () => act('generate', { input: input.value }), { className: 'pw-primary' });
    const cancelButton = button('取消', () => act('cancel'));
    generationActions.append(generateButton, cancelButton);
    const planSection = el('section', 'pw-plan-section');
    const planHeader = el('div', 'pw-plan-heading');
    const planTabs = el('div', 'pw-plan-tabs');
    planTabs.setAttribute('role', 'tablist');
    planTabs.setAttribute('aria-label', '大纲显示方式');
    const readButton = button('阅读', () => { planView = 'read'; render(); }, { className: 'pw-tab' });
    const editButton = button('编辑', () => { planView = 'edit'; render(); }, { className: 'pw-tab' });
    readButton.setAttribute('role', 'tab'); editButton.setAttribute('role', 'tab');
    readButton.id = 'pw-read-tab'; editButton.id = 'pw-edit-tab';
    readButton.setAttribute('aria-controls', 'pw-read-panel'); editButton.setAttribute('aria-controls', 'pw-edit-panel');
    planTabs.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        planView = event.key === 'Home' ? 'read' : event.key === 'End' ? 'edit' : planView === 'read' ? 'edit' : 'read';
        render();
        (planView === 'read' ? readButton : editButton).focus();
    });
    planTabs.append(readButton, editButton);
    planHeader.append(el('h3', '', '大纲内容'), planTabs);
    const planReading = el('div', 'pw-plan-reading');
    planReading.id = 'pw-read-panel';
    planReading.setAttribute('role', 'tabpanel');
    planReading.setAttribute('aria-labelledby', 'pw-read-tab');
    const planEditing = el('div', 'pw-plan-editing');
    planEditing.id = 'pw-edit-panel';
    planEditing.setAttribute('role', 'tabpanel');
    planEditing.setAttribute('aria-labelledby', 'pw-edit-tab');
    const planXml = el('textarea', 'pw-input pw-xml-editor');
    planXml.rows = 15;
    planXml.spellcheck = false;
    planXml.setAttribute('aria-label', '编辑完整的大纲 XML');
    planXml.placeholder = '<content>…</content>';
    planXml.addEventListener('input', () => { dirtyPlan = true; renderPlanActions(); });
    const planEditHint = el('p', 'pw-hint', '可修改剧情内容。请保留标签结构，应用后会检查格式。');
    const applyPlanButton = button('应用修改', async () => {
        const result = await act('applyPlanEdit', { xml: planXml.value });
        if (result !== false) { dirtyPlan = false; planView = 'read'; render(); }
    }, { className: 'pw-primary' });
    planEditing.append(planXml, planEditHint, applyPlanButton);
    const outputActions = el('div', 'pw-output-actions');
    const copyButton = button('复制大纲', () => act('copy'), { iconName: 'copy' });
    const fillButton = button('填入输入框', () => act('fillInput'), { iconName: 'external' });
    const writeButton = button('确认并扩写', () => act('confirmAndWrite'), { className: 'pw-primary', iconName: 'edit' });
    outputActions.append(copyButton, fillButton, writeButton);
    const manualHint = el('p', 'pw-hint pw-manual-hint', '填入后不会自动发送；若作为普通聊天消息发送，大纲可能进入历史与记忆。');
    const draftHint = el('p', 'pw-hint pw-draft-hint', '有尚未应用的修改。请先应用修改，再复制或扩写。');
    planSection.append(planHeader, planReading, planEditing, outputActions, draftHint, manualHint);
    outlinePage.append(pageHeading, steps, inputField, generationActions, planSection);

    const promptEditorPage = el('section', 'pw-prompt-editor-page');
    const promptBack = button('返回预设条目', () => { selectedPrompt = null; dirtyPrompt = false; render(); }, { className: 'pw-back' });
    const promptName = el('h2');
    const promptInfo = el('p', 'pw-hint');
    const promptText = el('textarea', 'pw-input pw-prompt-editor');
    promptText.rows = 20;
    promptText.spellcheck = false;
    promptText.setAttribute('aria-label', '预设条目内容');
    promptText.addEventListener('input', () => { dirtyPrompt = true; promptSave.disabled = false; });
    const promptSave = button('保存条目', async () => {
        const result = await act('editPrompt', { id: selectedPrompt, content: promptText.value });
        if (result !== false) { dirtyPrompt = false; promptSave.disabled = true; statusMessage.textContent = '条目已保存。'; }
    }, { className: 'pw-primary' });
    promptEditorPage.append(promptBack, promptName, promptInfo, promptText, promptSave);
    const presetIntro = el('section', 'pw-preset-intro');
    presetIntro.append(el('h2', '', '预设管理'), el('p', '', '打开左侧分组，选择条目即可编辑。'), el('p', 'pw-hint', '导入只读取提示词与分组，不运行预设附带脚本。'));
    main.append(outlinePage, promptEditorPage, presetIntro);

    const settingsPanel = el('aside', 'pw-settings');
    settingsPanel.setAttribute('aria-label', '设置');
    settingsPanel.append(el('h2', 'pw-settings-page-title', '设置'));
    const settingsFields = {};
    function settingsSection(name) {
        const section = el('section', 'pw-settings-section');
        section.append(el('h2', '', name));
        settingsPanel.append(section);
        return section;
    }
    function settingInput(section, key, label, type, placeholder, hint, extra = {}) {
        const node = control(type, placeholder);
        Object.assign(node, extra);
        node.addEventListener('change', () => {
            let value = node.value;
            if (type === 'number') value = value === '' ? null : Number(value);
            act('settings', { [key]: value });
        });
        section.append(field(label, node, hint));
        settingsFields[key] = node;
        return node;
    }
    const apiSection = settingsSection('规划模型');
    settingInput(apiSection, 'baseUrl', '接口地址', 'url', 'https://…/v1', undefined, { autocomplete: 'url', spellcheck: false });
    settingInput(apiSection, 'model', '模型名称', 'text', '填写模型 ID', undefined, { autocomplete: 'off', spellcheck: false });
    const keyField = control('password', '仅本次页面会话使用');
    keyField.autocomplete = 'off';
    keyField.name = 'planning-session-token';
    keyField.spellcheck = false;
    keyField.addEventListener('change', () => act('apiKey', { value: keyField.value }));
    apiSection.append(field('API 密钥', keyField, '密钥不保存到预设或导出文件。'));
    const advanced = el('details', 'pw-advanced');
    advanced.append(el('summary', '', '生成参数'));
    const advancedFields = el('div', 'pw-advanced-fields');
    settingInput(advancedFields, 'temperature', '温度', 'number', '使用默认值', undefined, { step: '0.1', min: '0', max: '2', inputMode: 'decimal' });
    settingInput(advancedFields, 'maxTokens', '最大输出 Token', 'number', '使用默认值', undefined, { step: '1', min: '1', inputMode: 'numeric' });
    advanced.append(advancedFields);
    apiSection.append(advanced);
    const lengthSection = settingsSection('正文篇幅');
    const wordFields = el('div', 'pw-word-fields');
    settingInput(wordFields, 'minWords', '最少字数', 'number', '未设置', undefined, { min: '1', step: '1', inputMode: 'numeric' });
    settingInput(wordFields, 'maxWords', '最多字数', 'number', '未设置', undefined, { min: '1', step: '1', inputMode: 'numeric' });
    lengthSection.append(wordFields, el('p', 'pw-hint', '规划与扩写使用同一份目标'));
    const modeSection = settingsSection('使用方式');
    const modeSelect = el('select', 'pw-input');
    modeSelect.setAttribute('aria-label', '使用方式');
    for (const [value, text] of [['review', '先查看，再扩写'], ['auto', '自动注入并扩写'], ['manual', '只生成大纲，手动使用']]) {
        const opt = el('option', '', text); opt.value = value; modeSelect.append(opt);
    }
    modeSelect.addEventListener('change', () => act('settings', { mode: modeSelect.value }));
    const autoLabel = el('label', 'pw-checkbox-label');
    const autoOnSend = control('checkbox');
    autoOnSend.addEventListener('change', () => act('settings', { autoOnSend: autoOnSend.checked }));
    autoLabel.append(autoOnSend, el('span', '', '发送时自动规划'));
    const modeHint = el('p', 'pw-hint');
    const modeField = field('规划时机', modeSelect); modeField.classList.add('pw-mode-field');
    modeSection.append(modeField, autoLabel, modeHint);
    const animaSection = settingsSection('Anima 记忆');
    animaSection.append(el('p', 'pw-anima-description', '读取本轮有效记忆，沿用 Anima 保留规则'));
    const animaStatus = el('div', 'pw-anima-status', '尚未检查');
    animaStatus.setAttribute('role', 'status');
    const animaAdvanced = el('details', 'pw-advanced');
    animaAdvanced.append(el('summary', '', 'Anima 路径'));
    settingInput(animaAdvanced, 'animaPath', '扩展目录', 'text', 'third-party/Anima-Memory-System', '由已安装的 Anima 扩展提供记忆。', { spellcheck: false });
    animaSection.append(animaStatus, animaAdvanced);
    body.append(presets, main, settingsPanel);
    shell.append(body, statusMessage);

    const footer = el('footer', 'pw-footer');
    const footerDot = el('span', 'pw-status-dot');
    const footerStatus = el('span', '', '准备就绪');
    footerStatus.setAttribute('role', 'status');
    footer.append(footerDot, footerStatus);
    shell.append(footer);
    const mobileTabs = el('nav', 'pw-mobile-tabs');
    mobileTabs.setAttribute('aria-label', '工作区');
    const mobileTabButtons = new Map();
    for (const [id, text, iconName] of [['outline', '大纲', 'file'], ['presets', '预设', 'list'], ['settings', '设置', 'settings']]) {
        const tab = button(text, () => tabTo(id), { className: 'pw-mobile-tab', iconName });
        mobileTabButtons.set(id, tab); mobileTabs.append(tab);
    }
    shell.append(mobileTabs);
    document.body.append(dialog);

    function renderTabs() {
        pageSubtitle.textContent = mobile.matches ? '先规划，再成文' : '先决定人物与剧情，再交给主模型成文';
        stepNodes.forEach((node, index) => { node.querySelector('.pw-step-label').textContent = mobile.matches ? ['记忆', '大纲', '确认', '扩写'][index] : ['读取记忆', '生成大纲', '编辑确认', '正文扩写'][index]; });
        if (mobile.matches && promptEditorPage.parentElement !== presets) presets.append(promptEditorPage);
        if (!mobile.matches && promptEditorPage.parentElement !== main) main.insertBefore(promptEditorPage, presetIntro);
        dialog.dataset.tab = activeTab;
        dialog.dataset.promptEditor = selectedPrompt ? 'true' : 'false';
        topOutline.classList.toggle('pw-selected', activeTab === 'outline');
        topPresets.classList.toggle('pw-selected', activeTab === 'presets');
        topOutline.setAttribute('aria-current', activeTab === 'outline' ? 'page' : 'false');
        topPresets.setAttribute('aria-current', activeTab === 'presets' ? 'page' : 'false');
        for (const [id, node] of mobileTabButtons) {
            node.classList.toggle('pw-selected', activeTab === id);
            node.setAttribute('aria-current', activeTab === id ? 'page' : 'false');
        }
        outlinePage.hidden = activeTab !== 'outline';
        promptEditorPage.hidden = activeTab !== 'presets' || !selectedPrompt;
        presetIntro.hidden = activeTab !== 'presets' || Boolean(selectedPrompt);
    }
    function openPrompt(id) {
        selectedPrompt = id;
        activeTab = 'presets';
        dirtyPrompt = false;
        render();
        main.scrollTop = 0;
        if (mobile.matches) promptEditorPage.scrollIntoView({ block: 'start' });
        promptName.focus?.({ preventScroll: true });
    }
    function renderPreset(state) {
        const preset = state.preset || { prompts: [], groups: [], order: [] };
        const signature = JSON.stringify([preset.name, preset.prompts, preset.groups, preset.order, preset.promptGroups]);
        if (signature !== presetSignature) {
            presetSignature = signature;
            const opt = el('option', '', preset.name || '第三人称 · 轻度抢话'); opt.value = 'current';
            const builtin = el('option', '', '恢复内置规划预设'); builtin.value = 'builtin';
            presetSelect.replaceChildren(opt, builtin);
            presetSelect.value = 'current';
            const groups = [...(preset.groups || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
            const orderedIds = (preset.order || []).map(entry => typeof entry === 'string' ? entry : entry.identifier);
            const promptList = [...(preset.prompts || [])].sort((a, b) => {
                const ia = orderedIds.indexOf(a.identifier), ib = orderedIds.indexOf(b.identifier);
                return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
            });
            const enabledMap = new Map((preset.order || []).map(entry => [entry.identifier, entry.enabled]));
            const mapping = preset.promptGroups || {};
            function groupFor(id) { return typeof mapping[id] === 'string' ? mapping[id] : mapping[id]?.groupId; }
            if (promptList.some(p => !groups.some(g => g.id === groupFor(p.identifier)))) groups.push({ id: '__ungrouped', name: '未分组条目', enabled: true });
            presetGroups.replaceChildren();
            const preferredGroup = groups.find(g => g.name?.includes('第三人称'))?.id || groups[0]?.id;
            for (const group of groups) {
                const prompts = promptList.filter(p => group.id === '__ungrouped' ? !groups.some(g => g.id !== '__ungrouped' && g.id === groupFor(p.identifier)) : groupFor(p.identifier) === group.id);
                if (!prompts.length) continue;
                const details = el('details', 'pw-group');
                details.open = groupOpen.has(group.id) ? groupOpen.get(group.id) : group.id === preferredGroup;
                details.addEventListener('toggle', () => groupOpen.set(group.id, details.open));
                const summary = el('summary', 'pw-group-summary');
                const nameWrap = el('span', 'pw-group-name'); nameWrap.append(icon('chevron'), el('span', '', group.name.replace(/^\d+\s*/, '')));
                summary.append(nameWrap);
                if (group.id !== '__ungrouped') {
                    const toggle = makeSwitch(`启用分组：${group.name}`, group.enabled !== false, enabled => act('groupToggle', { id: group.id, enabled }));
                    toggle.addEventListener('click', event => event.stopPropagation());
                    summary.append(toggle);
                }
                const items = el('div', 'pw-group-items');
                items.classList.toggle('pw-group-off', group.enabled === false);
                for (const prompt of prompts) {
                    const row = el('div', 'pw-prompt-row');
                    const label = prompt.name?.split('｜').slice(1).join('｜') || prompt.name || prompt.identifier;
                    const edit = button(label, () => openPrompt(prompt.identifier), { className: 'pw-prompt-name', title: `编辑：${label}` });
                    if (prompt.marker) edit.title = `上下文占位：${label}`;
                    const toggle = makeSwitch(`启用条目：${label}`, enabledMap.has(prompt.identifier) ? enabledMap.get(prompt.identifier) !== false : false, enabled => act('promptToggle', { identifier: prompt.identifier, enabled }));
                    row.append(edit, toggle); items.append(row);
                }
                details.append(summary, items); presetGroups.append(details);
            }
            presetWarnings.textContent = (preset.warnings || []).join(' ');
            presetWarnings.hidden = !presetWarnings.textContent;
        }
        if (selectedPrompt) {
            const prompt = preset.prompts?.find(p => p.identifier === selectedPrompt);
            if (!prompt) { selectedPrompt = null; return; }
            promptName.textContent = prompt.name || prompt.identifier;
            promptInfo.textContent = prompt.marker ? '这是酒馆上下文占位。内容由插件从当前聊天读取，可在列表中启用或关闭。' : '修改只影响规划预设，不改动酒馆主模型预设。';
            if (!dirtyPrompt) promptText.value = prompt.content || '';
            promptText.disabled = Boolean(prompt.marker);
            promptSave.disabled = Boolean(prompt.marker) || !dirtyPrompt;
        }
    }
    function renderPlan(state) {
        const raw = state.rawPlan || state.plan?.xml || '';
        if (raw !== seenRawPlan) {
            seenRawPlan = raw;
            planXml.value = raw;
            dirtyPlan = false;
        }
        const signature = JSON.stringify(state.plan || null);
        if (signature !== planSignature) {
            planSignature = signature;
            planReading.replaceChildren();
            const plan = state.plan;
            planReading.classList.toggle('pw-is-empty', !plan);
            if (!plan) {
                const empty = el('div', 'pw-empty');
                empty.append(icon('file'), el('h4', '', '等待生成本轮大纲'), el('p', '', '生成后可修改，也可以复制到酒馆输入框'));
                planReading.append(empty);
            } else {
                function block(label, text, className = '') {
                    const section = el('section', `pw-story-block ${className}`);
                    section.append(el('h4', '', label), el('p', '', text || '不涉及'));
                    planReading.append(section);
                }
                block('本轮剧情', plan.plot);
                const characters = el('details', 'pw-character-details');
                characters.open = !mobile.matches;
                characters.append(el('summary', '', '人物情感与回应'));
                for (const character of plan.characters || []) {
                    const person = el('section', 'pw-person');
                    person.append(el('h5', '', character.name), el('p', '', character.emotion), el('p', '', character.response));
                    characters.append(person);
                }
                if (!(plan.characters || []).length) characters.append(el('p', '', '不涉及'));
                planReading.append(characters);
                for (const [index, segment] of (plan.segments || []).entries()) block(`片段 ${segment.index || index + 1}`, typeof segment === 'string' ? segment : segment.text || segment.content, 'pw-segment');
                block('本轮结束状态', plan.endState || plan.end_state, 'pw-end-state');
            }
        }
        planReading.hidden = planView !== 'read';
        planEditing.hidden = planView !== 'edit';
        readButton.classList.toggle('pw-selected', planView === 'read');
        editButton.classList.toggle('pw-selected', planView === 'edit');
        readButton.setAttribute('aria-selected', String(planView === 'read'));
        editButton.setAttribute('aria-selected', String(planView === 'edit'));
        readButton.tabIndex = planView === 'read' ? 0 : -1;
        editButton.tabIndex = planView === 'edit' ? 0 : -1;
        renderPlanActions();
    }
    function renderPlanActions() {
        const state = getState();
        const noPlan = !state.plan;
        const processing = state.busy && !state.awaitingReview;
        copyButton.disabled = noPlan || processing || dirtyPlan;
        fillButton.disabled = noPlan || processing || dirtyPlan;
        writeButton.disabled = noPlan || processing || dirtyPlan;
        writeButton.hidden = state.settings?.mode === 'manual';
        applyPlanButton.disabled = processing || !planXml.value.trim();
        planXml.disabled = Boolean(processing);
        draftHint.hidden = !dirtyPlan;
        manualHint.hidden = noPlan;
    }
    function render() {
        if (destroyed) return;
        const state = getState();
        const settings = state.settings || {};
        setInputValue(input, state.input);
        setInputValue(keyField, state.apiKey);
        for (const [key, node] of Object.entries(settingsFields)) setInputValue(node, settings[key]);
        modeSelect.value = settings.mode || 'review';
        autoOnSend.checked = Boolean(settings.autoOnSend);
        modeHint.textContent = settings.mode === 'auto' ? '大纲通过格式检查后直接交给主模型。' : settings.mode === 'manual' ? '只生成大纲，不自动注入主请求。' : '大纲生成后暂停，确认后再交给主模型。';
        generateButton.disabled = Boolean(state.busy);
        generateButton.querySelector('span').textContent = state.busy ? '正在处理…' : state.preview ? '载入示例大纲' : '生成大纲';
        cancelButton.disabled = !state.busy;
        input.disabled = Boolean(state.busy);
        footerStatus.textContent = typeof state.status === 'string' ? state.status : state.status?.message || '准备就绪';
        footerDot.classList.toggle('pw-busy', Boolean(state.busy));
        animaStatus.textContent = typeof state.animaStatus === 'string' ? state.animaStatus : state.animaStatus?.message || '尚未检查';
        const stage = state.stage || (state.busy ? 'planning' : state.plan ? 'review' : 'idle');
        const stages = { idle: -1, memory: 0, recalling: 0, planning: 1, generating: 1, review: 2, ready: 2, writing: 3, complete: 3 };
        const step = stages[stage] ?? -1;
        stepNodes.forEach((node, index) => { node.classList.toggle('pw-step-active', index === step); node.classList.toggle('pw-step-done', index < step); });
        renderPreset(state);
        for (const node of presets.querySelectorAll('button,input,select,textarea')) node.disabled = Boolean(state.busy) || (node === promptText && Boolean(state.preset?.prompts?.find(p => p.identifier === selectedPrompt)?.marker)) || (node === promptSave && !dirtyPrompt);
        for (const node of settingsPanel.querySelectorAll('button,input,select,textarea')) node.disabled = Boolean(state.busy);
        renderPlan(state);
        renderTabs();
    }
    function onViewport() {
        // Visual viewport keeps the close control and navigation reachable above the mobile keyboard.
        const viewport = window.visualViewport;
        if (viewport && mobile.matches) {
            dialog.style.setProperty('--pw-viewport-height', `${viewport.height}px`);
            dialog.style.setProperty('--pw-viewport-top', `${viewport.offsetTop}px`);
        } else {
            dialog.style.removeProperty('--pw-viewport-height');
            dialog.style.removeProperty('--pw-viewport-top');
        }
        renderTabs();
    }
    function open() {
        if (destroyed || dialog.open) return;
        beforeFocus = document.activeElement;
        oldBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        ownsScrollLock = true;
        render();
        onViewport();
        dialog.showModal();
        dialog.focus({ preventScroll: true });
    }
    function close() {
        if (!dialog.open) return;
        dialog.close();
    }
    function afterClose() {
        if (!ownsScrollLock) return;
        document.body.style.overflow = oldBodyOverflow ?? '';
        ownsScrollLock = false;
        if (beforeFocus?.isConnected) beforeFocus.focus({ preventScroll: true });
    }
    dialog.addEventListener('close', afterClose);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const focusables = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[hidden]'));
        const first = focusables[0], last = focusables.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    window.visualViewport?.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('scroll', onViewport);
    window.addEventListener('resize', onViewport);
    function destroy() {
        close();
        afterClose();
        destroyed = true;
        dialog.remove();
        window.visualViewport?.removeEventListener('resize', onViewport);
        window.visualViewport?.removeEventListener('scroll', onViewport);
        window.removeEventListener('resize', onViewport);
    }
    render();
    return { open, close, render, destroy };
}
