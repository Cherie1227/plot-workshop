import { createWorkshopTools } from './tools-ui.js';
import { estimatePromptText } from './lib/prompt-inspector.js';
import { STORY_PACES, RELATIONSHIP_PACES } from './lib/host.js';

/** Mobile-first, dependency-free workbench. No model or preset text is interpreted as HTML. */
const ICONS = {
    book: '<path d="M3 5c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1z"/><path d="M12 6v15M1 8v14h9m13-14v14h-9"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    copy: '<rect x="8" y="5" width="12" height="16" rx="2"/><path d="M15 5V3H4v15h4"/>',
    external: '<path d="M14 3h7v7m0-7L11 13M10 3H3v18h18v-7"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15z"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M9 12h6m-6 4h6"/>',
    chevron: '<path d="m8 4 8 8-8 8"/>',
    settings: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="19" r="2"/>',
    list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
    drag: '<path d="M6 7h12M6 12h12M6 17h12"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    up: '<path d="m6 14 6-6 6 6"/>',
    down: '<path d="m6 10 6 6 6-6"/>',
    leaf: '<path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z"/><circle cx="12" cy="12" r="2"/>',
    corner: '<path d="M2 22V12C2 5 5 2 12 2h10M6 18c0-7 4-12 12-12M4 12c3 1 5-1 4-4M12 4c1 3-1 5-4 4"/>',
    flourish: '<path d="M1 8h21m36 0h21M22 8c8-7 13-7 18 0-5 7-10 7-18 0m18 0c5-7 10-7 18 0-8 7-13 7-18 0M40 2v12"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    power: '<path d="M12 2v10M6.4 5.4a9 9 0 1 0 11.2 0"/>',
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
    const node = el('input', type === 'checkbox' ? 'pw-checkbox-input' : 'pw-input');
    node.type = type;
    node.placeholder = placeholder;
    return node;
}
function decorateCheckbox(wrap, input, caption, showState = true) {
    // Native checked state drives the mark, including reloads and failed-save rollback.
    if (!input.hasAttribute('aria-label')) input.setAttribute('aria-label', caption.textContent);
    const mark = el('span', 'pw-checkbox-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(icon('check'));
    wrap.append(input, mark, caption);
    if (showState) {
        const state = el('span', 'pw-checkbox-state');
        state.setAttribute('aria-hidden', 'true');
        state.append(el('span', 'pw-checkbox-on', '已开启'), el('span', 'pw-checkbox-off', '未开启'));
        wrap.append(state);
    }
    return wrap;
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
function frameOrnaments() {
    const frame = el('span', 'pw-frame-ornaments'); frame.setAttribute('aria-hidden', 'true');
    for (let corner = 0; corner < 4; corner++) frame.append(icon('corner'));
    return frame;
}

export function createWorkbench({ getState, onAction }) {
    if (typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('Workbench needs state and action handlers.');
    const dialog = el('dialog', 'pw-workbench');
    dialog.setAttribute('aria-labelledby', 'pw-title');
    dialog.tabIndex = -1;
    const shell = el('div', 'pw-shell');
    dialog.append(shell);
    // Resolve legacy rgba/hex/hsl host colors through the browser, then keep RGB
    // only. The outer surface must never borrow alpha from the chat theme.
    const hostColorProbe = el('span');
    hostColorProbe.hidden = true;
    hostColorProbe.setAttribute('aria-hidden', 'true');
    hostColorProbe.style.setProperty('color', 'var(--SmartThemeBlurTintColor, #11171e)', 'important');
    dialog.append(hostColorProbe);
    let activeTab = 'outline';
    let planView = 'read';
    let selectedPrompt = null;
    let creatingPrompt = false;
    let promptDraft = null;
    let promptBaseline = '';
    let savingPrompt = false;
    let pendingLeave = null;
    let seenApiProfileId;
    let apiKeyBaseline = '';
    let rememberBaseline = false;
    let pendingApiChange = null;
    let seenPresetId;
    let presetNameDirty = false;
    let pendingPresetChange = null;
    let dirtyPrompt = false;
    let dirtyPlan = false;
    let appearanceDraft = null;
    let appearanceDirty = false;
    let savingAppearance = false;
    let appearanceFeedback = '';
    let worldbookPage = 1;
    let promptListReturn = null;
    let groupRange = null;
    let groupManage = null;
    let groupSaving = false;
    let pendingGroupLeave = null;
    const configDrafts = new Map();
    let keyDraftDirty = false;
    let seenRawPlan;
    let presetSignature = '';
    let planSignature = '';
    let analysisSignature = '';
    let beforeFocus;
    let oldBodyOverflow;
    let ownsScrollLock = false;
    let destroyed = false;
    const groupOpen = new Map();
    const reviewGroupOpen = new Map();
    let importReviewFilter = 'pending';
    const mobile = window.matchMedia('(max-width: 760px)');
    const statusMessage = el('div', 'pw-message');
    statusMessage.setAttribute('role', 'status');
    statusMessage.setAttribute('aria-live', 'polite');

    async function act(type, payload) {
        try {
            statusMessage.textContent = '';
            statusMessage.classList.remove('pw-error');
            const result = await onAction(type, payload);
            if (type === 'importBackup' && result !== false) {
                configDrafts.clear(); keyDraftDirty = false;
                appearanceDirty = false; appearanceDraft = null; appearanceFeedback = '';
            }
            render();
            return result;
        } catch (error) {
            statusMessage.textContent = error?.message || '操作没有完成，请稍后重试。';
            statusMessage.classList.add('pw-error');
            statusMessage.scrollIntoView({ block: 'nearest' });
            return false;
        }
    }
    function isBlocked(state = getState()) { return Boolean(state.busy || state.apiBusy || state.animaChecking || state.libraryBusy || state.update?.phase === 'installing'); }
    function tabTo(tab) {
        if (activeTab === tab) return;
        withUnsavedGuard(() => {
            resetEditor();
            promptListReturn = null;
            activeTab = tab;
            renderTabs();
            body.scrollTop = 0;
        });
    }

    const header = el('header', 'pw-header');
    const brand = el('div', 'pw-brand');
    const title = el('h1', '', 'Vespera');
    title.id = 'pw-title';
    brand.append(title);
    const pageNav = el('nav', 'pw-page-nav');
    pageNav.setAttribute('aria-label', '工作区');
    const pageTabButtons = new Map();
    for (const [id, label] of [['outline', '大纲'], ['presets', '预设'], ['worldbooks', '世界书'], ['config', '配置'], ['settings', '设置'], ['appearance', '美化']]) {
        const node = button(label, () => tabTo(id), { className: 'pw-page-tab' });
        pageTabButtons.set(id, node); pageNav.append(node);
    }
    const themeSelect = el('select', 'pw-input pw-theme-select');
    themeSelect.setAttribute('aria-label', '外观');
    for (const [value, label] of [['light', '日间纸色'], ['dark', '夜间墨色'], ['host', '跟随酒馆'], ['system', '跟随系统']]) {
        const option = el('option', '', label); option.value = value; themeSelect.append(option);
    }
    themeSelect.addEventListener('change', updateAppearanceDraft);
    const closeButton = button('关闭', close, { className: 'pw-close', iconName: 'close' });
    closeButton.setAttribute('aria-label', '关闭');
    const enableButton = button('已启用', () => act('setEnabled', { value: getState().settings?.enabled === false }), { className: 'pw-enable-toggle', iconName: 'power' });
    enableButton.setAttribute('role', 'switch');
    enableButton.setAttribute('aria-label', 'Vespera 总开关');
    const headerArt = el('img', 'pw-header-art'); headerArt.alt = ''; headerArt.src = new URL('./assets/celestial-header.png', import.meta.url).href;
    headerArt.setAttribute('aria-hidden', 'true');
    header.append(headerArt, brand, enableButton, closeButton);
    shell.append(header, pageNav);
    const updateBanner = button('', () => withUnsavedGuard(() => {
        resetEditor(); activeTab = 'settings'; updateSection.open = true; renderTabs(); updateSection.scrollIntoView({ block: 'start' });
    }), { className: 'pw-update-banner' });
    updateBanner.hidden = true; shell.append(updateBanner);
    if (getState().preview) shell.append(el('div', 'pw-preview-banner', '界面预览，不调用真实接口'));

    const body = el('div', 'pw-body');
    const presetsPage = el('section', 'pw-presets-page pw-page');
    const presets = el('section', 'pw-presets');
    presets.setAttribute('aria-label', '规划预设');
    const presetHead = el('div', 'pw-section-heading');
    presetHead.append(icon('leaf'), el('h2', '', '规划预设'));
    const presetSelect = el('select', 'pw-input');
    presetSelect.setAttribute('aria-label', '当前规划预设');
    presetSelect.addEventListener('change', () => {
        const id = presetSelect.value;
        presetSelect.value = getState().activePresetId || 'current';
        guardPresetChange(async () => { resetEditor(); await act(id === 'builtin' ? 'selectPreset' : 'presetSelect', { id }); presetNameDirty = false; render(); });
    });
    const hostPresetDetails = el('details', 'pw-host-catalog pw-advanced');
    hostPresetDetails.append(el('summary', '', '从酒馆导入预设'));
    const hostPresetSelect = el('select', 'pw-input');
    hostPresetSelect.setAttribute('aria-label', '从酒馆导入预设');
    const hostPresetImport = button('导入为副本', () => guardPresetChange(async () => {
        if (!hostPresetSelect.value || isBlocked()) return;
        const result = await act('importHostPreset', { id: hostPresetSelect.value });
        if (result !== false) { resetEditor(); presetNameDirty = false; showImportReview(); render(); }
    }));
    hostPresetSelect.addEventListener('change', () => { hostPresetImport.disabled = isBlocked() || !hostPresetSelect.value; });
    const hostPresetActions = el('div', 'pw-management-actions');
    hostPresetActions.append(button('刷新酒馆目录', () => act('refreshHostCatalog')), hostPresetImport);
    const hostPresetStatus = el('p', 'pw-hint pw-library-status'); hostPresetStatus.setAttribute('role', 'status');
    hostPresetDetails.append(field('从酒馆导入预设', hostPresetSelect), hostPresetActions, el('p', 'pw-hint', '导入为独立副本，不更改酒馆当前主预设。'), hostPresetStatus);
    const importInput = control('file');
    importInput.accept = '.json,application/json';
    importInput.hidden = true;
    importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        if (!file) return;
        if (file.size > 5_000_000) { statusMessage.textContent = '预设超过 5 MB，请缩小文件后再导入。'; importInput.value = ''; return; }
        const result = await act('importPreset', { text: await file.text(), name: file.name.replace(/\.json$/i, '') });
        importInput.value = '';
        if (result !== false) { resetEditor(); showImportReview(); }
        render();
    });
    const presetActions = el('div', 'pw-preset-actions');
    presetActions.append(button('导入 JSON', () => guardPresetChange(() => { resetEditor(); importInput.click(); }), { iconName: 'upload' }), button('导出', () => act('exportPreset'), { iconName: 'download' }));
    const presetManage = el('details', 'pw-preset-manage pw-advanced');
    presetManage.append(el('summary', '', '管理规划预设'));
    const presetNameInput = control('text', '预设名称'); presetNameInput.setAttribute('aria-label', '规划预设名称');
    presetNameInput.addEventListener('input', () => { presetNameDirty = presetNameInput.value !== (getState().preset?.name || ''); renderPresetSaveStatus(); });
    const presetManageActions = el('div', 'pw-management-actions');
    const savePresetName = async type => {
        if (isBlocked() || savingPrompt || groupSaving) return;
        if (groupDraftDirty()) {
            activeTab = 'presets'; renderTabs();
            statusMessage.textContent = '分组修改尚未保存，请先保存或取消分组修改。';
            renderPresetSaveStatus();
            (groupRange ? groupRangePanel : presetGroups.querySelector('.pw-group-manage:not([hidden])'))?.scrollIntoView({ block: 'nearest' });
            return;
        }
        if (dirtyPrompt) {
            activeTab = 'presets'; renderTabs();
            statusMessage.textContent = '此条目有未保存的修改，请先保存条目，再保存预设。';
            renderPresetSaveStatus(); promptSave.scrollIntoView({ block: 'nearest' }); promptSave.focus({ preventScroll: true });
            return;
        }
        const enteredName = presetNameInput.value.trim();
        const name = type === 'presetSaveAs' && enteredName === getState().preset?.name ? undefined : enteredName;
        const result = await act(type, { name });
        if (result !== false) { presetNameDirty = false; render(); }
    };
    const presetSaveButton = button('保存预设', () => savePresetName('presetSave'), { className: 'pw-primary' });
    const presetDeleteNotice = el('div', 'pw-editor-notice pw-delete-notice');
    presetDeleteNotice.setAttribute('role', 'alert'); presetDeleteNotice.hidden = true;
    const presetDeleteActions = el('div', 'pw-notice-actions');
    presetDeleteActions.append(button('取消', () => { presetDeleteNotice.hidden = true; }), button('确认删除预设', () => guardPresetChange(async () => {
        const result = await act('presetDelete', { id: getState().activePresetId });
        if (result !== false) { resetEditor(); presetNameDirty = false; presetDeleteNotice.hidden = true; render(); }
    }), { className: 'pw-danger' }));
    presetDeleteNotice.append(el('p', '', '删除当前规划预设及其条目？这不会删除聊天。'), presetDeleteActions);
    const presetDeleteButton = button('删除', () => { presetDeleteNotice.hidden = false; presetDeleteNotice.scrollIntoView({ block: 'nearest' }); },
        { className: 'pw-danger', iconName: 'trash', title: '删除当前规划预设' });
    presetDeleteButton.setAttribute('aria-label', '删除当前规划预设');
    const presetSelectRow = el('div', 'pw-preset-select-row');
    presetSelectRow.append(field('当前规划预设', presetSelect), presetSaveButton, presetDeleteButton);
    const presetSaveStatus = el('p', 'pw-hint pw-preset-save-status'); presetSaveStatus.setAttribute('role', 'status');
    presetManageActions.append(
        button('另存为', () => guardPresetChange(() => savePresetName('presetSaveAs'), { keepName: true })),
        button('新建预设', () => guardPresetChange(async () => { resetEditor(); const result = await act('presetNew', {}); if (result !== false) { presetNameDirty = false; render(); } })),
        button('恢复内置', () => guardPresetChange(async () => { resetEditor(); await act('selectPreset', { id: 'builtin' }); presetNameDirty = false; render(); }))
    );
    presetManage.append(field('名称', presetNameInput), presetManageActions);
    const importReviewDetails = el('details', 'pw-import-review pw-advanced');
    importReviewDetails.append(el('summary', '', '导入检查'));
    const importReviewMessage = el('p', 'pw-hint pw-format-status');
    const importReviewToolbar = el('div', 'pw-import-review-toolbar');
    const importReviewCount = el('p', 'pw-import-review-count'); importReviewCount.setAttribute('role', 'status');
    const importReviewFilters = el('div', 'pw-import-review-filters'); importReviewFilters.setAttribute('aria-label', '检查条目筛选');
    const reviewFilterButtons = new Map();
    for (const [value, label] of [['pending', '待检查'], ['all', '全部']]) {
        const node = button(label, () => { importReviewFilter = value; renderImportReview(getState()); });
        node.setAttribute('aria-pressed', String(value === importReviewFilter));
        reviewFilterButtons.set(value, node); importReviewFilters.append(node);
    }
    importReviewToolbar.append(importReviewCount, importReviewFilters);
    const importAdjustmentStatus = el('p', 'pw-hint pw-import-adjustment-status');
    const restoreImportButton = button('恢复自动关闭的条目', () => act('restoreImportDisabled'), { className: 'pw-restore-import' });
    const importAdjustment = el('div', 'pw-import-adjustment'); importAdjustment.append(importAdjustmentStatus, restoreImportButton);
    const importReviewItems = el('div', 'pw-import-review-items');
    const importReviewHelp = el('details', 'pw-import-review-help');
    importReviewHelp.append(el('summary', '', '格式与依赖说明'),
        el('p', 'pw-hint', '固定结构：content → plot / characters / segments / end_state。保留标签与层级，故事内容可修改。'),
        el('p', 'pw-hint', '变量和角色宏本身不算冲突；定义需先于引用。上下文占位由酒馆提供，本轮输入和 Anima 记忆自动加入。'));
    importReviewDetails.append(importReviewToolbar, importReviewMessage, importAdjustment, importReviewItems, importReviewHelp);
    const presetUnsaved = el('div', 'pw-editor-notice'); presetUnsaved.hidden = true;
    const presetUnsavedActions = el('div', 'pw-notice-actions');
    presetUnsavedActions.append(button('继续编辑名称', () => { pendingPresetChange = null; presetUnsaved.hidden = true; manageDrawer.hidden = false; presetManage.open = true; presetNameInput.focus(); }), button('放弃名称修改', () => {
        const next = pendingPresetChange; pendingPresetChange = null; presetUnsaved.hidden = true; presetNameDirty = false; next?.();
    }, { className: 'pw-danger' }));
    presetUnsaved.append(el('p', '', '规划预设名称还未保存。'), presetUnsavedActions);
    const newPromptButton = button('新增', () => newPrompt(''), { iconName: 'add', className: 'pw-new-prompt pw-primary', title: '新增条目' });
    newPromptButton.setAttribute('aria-label', '新增条目');
    const undoNotice = el('div', 'pw-undo-notice');
    undoNotice.setAttribute('role', 'status');
    const undoText = el('span');
    const undoButton = button('撤销删除', () => act('undoDeletePrompt'), { className: 'pw-undo-button' });
    undoNotice.append(undoText, undoButton); undoNotice.hidden = true;
    const presetGroups = el('div', 'pw-groups');
    const presetWarnings = el('p', 'pw-hint pw-preset-warnings');
    const groupLeaveNotice = el('div', 'pw-editor-notice pw-group-leave'); groupLeaveNotice.hidden = true;
    const groupLeaveActions = el('div', 'pw-notice-actions');
    groupLeaveActions.append(button('继续分组', () => { pendingGroupLeave = null; groupLeaveNotice.hidden = true; }), button('放弃分组修改', () => {
        const next = pendingGroupLeave; clearGroupFlow(); render(); next?.();
    }, { className: 'pw-danger' }));
    groupLeaveNotice.append(el('p', '', '分组修改尚未保存。继续编辑，或放弃后离开。'), groupLeaveActions);
    const groupRangePanel = el('section', 'pw-group-range'); groupRangePanel.hidden = true;
    groupRangePanel.setAttribute('aria-label', '创建分组');
    const groupRangeHeading = el('div', 'pw-group-range-heading');
    groupRangeHeading.append(el('h3', '', '创建分组'), button('取消分组', cancelGroupRange));
    const groupRangeHint = el('p', 'pw-hint', '按实际预设顺序选择末尾条目，包含两端；可向前选，也可只选起点。');
    const groupRangeStatus = el('p', 'pw-group-range-status'); groupRangeStatus.setAttribute('role', 'status');
    const groupRangeList = el('div', 'pw-group-range-list'); groupRangeList.setAttribute('aria-label', '按实际顺序选择分组终点');
    const groupRangeForm = el('div', 'pw-group-range-form');
    const groupRangeName = control('text', '给新分组起名'); groupRangeName.maxLength = 200; groupRangeName.setAttribute('aria-label', '新分组名称');
    groupRangeName.addEventListener('input', () => {
        if (groupRange) groupRange.name = groupRangeName.value;
        if (groupRangeName.value.trim() && statusMessage.textContent === '请填写分组名称。') statusMessage.textContent = '';
    });
    const groupRangeSave = button('创建分组', saveGroupRange, { className: 'pw-primary' });
    groupRangeForm.append(field('分组名称', groupRangeName), groupRangeSave);
    groupRangePanel.append(groupRangeHeading, groupRangeHint, groupRangeStatus, groupRangeList, groupRangeForm);
    const worldbooksPage = el('section', 'pw-worldbooks-page pw-page');
    const worldbooksHead = el('div', 'pw-page-heading pw-worldbooks-heading');
    worldbooksHead.append(icon('leaf'), el('h2', '', '世界书'), button('刷新目录', () => act('refreshHostCatalog')));
    const worldbooksMounted = el('div', 'pw-mounted-books');
    const extraBooks = el('div', 'pw-extra-books');
    const worldbookStatus = el('p', 'pw-hint pw-library-status'); worldbookStatus.setAttribute('role', 'status');
    const mountedSection = el('details', 'pw-book-section pw-mounted-section');
    const mountedSummary = el('summary', '', '当前挂载 · 0');
    mountedSection.append(mountedSummary, worldbooksMounted);
    const extraSection = el('section', 'pw-book-section');
    const worldbookSearch = control('search', '搜索世界书'); worldbookSearch.setAttribute('aria-label', '搜索世界书');
    const worldbookFilter = el('select', 'pw-input'); worldbookFilter.setAttribute('aria-label', '世界书筛选');
    for (const [value, label] of [['all', '全部'], ['selected', '已选']]) {
        const option = el('option', '', label); option.value = value; worldbookFilter.append(option);
    }
    const clearWorldbookSearch = button('清空搜索', () => { worldbookSearch.value = ''; worldbookPage = 1; renderHostCatalog(getState()); extraSection.scrollIntoView({ block: 'start' }); worldbookSearch.focus({ preventScroll: true }); });
    const worldbookToolbar = el('div', 'pw-worldbook-toolbar'); worldbookToolbar.append(worldbookSearch, clearWorldbookSearch, worldbookFilter);
    for (const [node, event] of [[worldbookSearch, 'input'], [worldbookFilter, 'change']]) node.addEventListener(event, () => { worldbookPage = 1; renderHostCatalog(getState()); });
    const worldbookResultCount = el('p', 'pw-hint pw-worldbook-result-count'); worldbookResultCount.setAttribute('role', 'status');
    const previousWorldbookPage = button('上一页', () => { if (worldbookPage > 1) { worldbookPage--; renderHostCatalog(getState()); extraSection.scrollIntoView({ block: 'start' }); } });
    const nextWorldbookPage = button('下一页', () => { worldbookPage++; renderHostCatalog(getState()); extraSection.scrollIntoView({ block: 'start' }); });
    const worldbookPageNumber = el('span', 'pw-worldbook-page-number'); worldbookPageNumber.setAttribute('aria-live', 'polite');
    const worldbookPagination = el('div', 'pw-worldbook-pagination'); worldbookPagination.append(previousWorldbookPage, worldbookPageNumber, nextWorldbookPage);
    extraSection.append(el('h3', '', '额外加入规划'), worldbookToolbar, worldbookResultCount, extraBooks, worldbookPagination);
    worldbooksPage.append(worldbooksHead, worldbookStatus, mountedSection, extraSection);
    const presetToolbar = el('div', 'pw-preset-toolbar');
    const presetDrawers = el('div', 'pw-preset-drawers');
    const importDrawer = el('section', 'pw-preset-drawer');
    const importHelp = el('section', 'pw-import-help'); importHelp.id = 'pw-import-help'; importHelp.hidden = true;
    const importHelpButton = button('?', () => {
        importHelp.hidden = !importHelp.hidden;
        importHelpButton.setAttribute('aria-expanded', String(!importHelp.hidden));
    }, { className: 'pw-import-help-button', title: '导入预设帮助' });
    importHelpButton.setAttribute('aria-label', '导入预设帮助');
    importHelpButton.setAttribute('aria-expanded', 'false'); importHelpButton.setAttribute('aria-controls', importHelp.id);
    importHelp.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); importHelp.hidden = true; importHelpButton.setAttribute('aria-expanded', 'false'); importHelpButton.focus(); } });
    const importHeading = el('div', 'pw-import-heading'); importHeading.append(el('h3', '', '导入预设'), importHelpButton);
    importHelp.append(el('p', 'pw-hint', '只整理导入的规划副本，酒馆主预设保持原样。'));
    for (const [title, text] of [
        ['保留', '读卡、人物、情感、剧情、视角与用户参与规则。分析输出也可保留，放在 content 外即可，标签名称不限；生成后在“规划分析”查看，不注入正文请求。'],
        ['自动关闭', '名称与内容明确指向额外输出正文、状态栏或逐轮总结的独立条目。导入后列出原因，可一键恢复。'],
        ['人工检查', '混合多种用途或无法明确识别的输出要求保留待检查。变量和角色宏本身不算冲突。文风和八股模块按内容决定：用于正文措辞的部分可关闭，在主预设中保留。'],
        ['篇幅', '正文目标供规划与扩写共享；内置预设按篇幅与推进节奏组织事件，大纲表达长度可单独配置。'],
        ['变量与格式', '变量定义需先于引用，勿整组关闭定义项。固定 content 四字段协议保持启用；脚本和正则不会执行。'],
    ]) { const item = el('div', 'pw-import-help-item'); item.append(el('strong', '', title), el('p', '', text)); importHelp.append(item); }
    importHelp.append(el('p', 'pw-hint', '识别使用本地规则，不调用模型。Vespera 自己导出的预设保留原开关，不重复整理。'));
    importDrawer.append(importHeading, importHelp, presetActions, hostPresetDetails);
    const manageDrawer = el('section', 'pw-preset-drawer'); manageDrawer.append(presetManage);
    const checkDrawer = el('section', 'pw-preset-drawer'); checkDrawer.append(importReviewDetails);
    const drawers = [manageDrawer, importDrawer, checkDrawer];
    function showImportReview() {
        for (const drawer of drawers) drawer.hidden = drawer !== checkDrawer;
        importReviewDetails.open = true;
    }
    function togglePresetDrawer(drawer) {
        const opening = drawer.hidden;
        for (const node of drawers) node.hidden = true;
        drawer.hidden = !opening;
        for (const node of drawer.querySelectorAll(':scope > details')) node.open = true;
    }
    for (const drawer of drawers) { drawer.hidden = true; presetDrawers.append(drawer); }
    presetToolbar.append(button('管理', () => togglePresetDrawer(manageDrawer), { iconName: 'settings' }), button('导入', () => togglePresetDrawer(importDrawer), { iconName: 'upload' }), button('检查', () => togglePresetDrawer(checkDrawer), { iconName: 'file' }), newPromptButton);
    presets.append(presetHead, presetSelectRow, presetDeleteNotice, presetSaveStatus, presetToolbar, presetDrawers, importInput, presetUnsaved, undoNotice, groupLeaveNotice, groupRangePanel, presetGroups, presetWarnings);
    const variableHelp = el('details', 'pw-import-review-help');
    variableHelp.append(el('summary', '', '变量宏用法'),
        el('p', 'pw-hint', '内置、自建和导入预设均可使用。条目按启用顺序展开，先定义再引用；关闭条目或分组不会执行变量操作。'),
        el('p', 'pw-hint', '前面的启用条目：定义与追加'),
        el('pre', 'pw-analysis-text', '{{setvar::本轮规则::保留人物已知与未知的边界。}}\n{{addvar::本轮规则::\n关系变化须有本轮经历支撑。}}'),
        el('p', 'pw-hint', '后面的启用条目：引用'),
        el('pre', 'pw-analysis-text', '本轮必须遵守：\n{{getvar::本轮规则}}'),
        el('p', 'pw-hint', '支持 setvar/getvar、addvar、incvar/decvar、hasvar/deletevar 及对应 global 版本。addvar 追加文本或累加数值；赋值和追加本身不输出内容。'),
        el('p', 'pw-hint', '变量仅在本次规划编译内共享，每次重新展开都会重置，包括 global 版本；不读写酒馆的聊天变量。可在“本轮读取与用量”查看展开结果。'));
    presets.append(variableHelp);
    const inspectionDetails = el('details', 'pw-inspection pw-advanced');
    inspectionDetails.append(el('summary', '', '本轮读取与用量'));
    const inspectButton = button('读取本轮资料', () => act('inspectPrompts', { input: input.value }), { className: 'pw-inspect-button' });
    const inspectionTotal = el('p', 'pw-inspection-total');
    inspectionTotal.setAttribute('role', 'status');
    const inspectionSources = el('div', 'pw-inspection-sources');
    const inspectionEntries = el('div', 'pw-inspection-entries');
    inspectionDetails.append(inspectButton, el('p', 'pw-hint', '读取会调用 Anima 召回，沿用其保留规则；不会生成正文。'), inspectionTotal, inspectionSources,
        el('p', 'pw-hint', '下方按实际发送顺序展开。Token 为估算值，不代表接口计费；关闭条目为 0，未读取显示 —。'), inspectionEntries);
    presets.append(inspectionDetails);

    const main = el('main', 'pw-main');
    const outlinePage = el('section', 'pw-outline-page pw-page');
    const pageHeading = el('div', 'pw-page-heading');
    pageHeading.append(el('h2', '', '本轮大纲'));
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
    const analysisButton = button('规划分析', () => { planView = 'analysis'; render(); }, { className: 'pw-tab' });
    const planTabEntries = [['read', readButton], ['edit', editButton], ['analysis', analysisButton]];
    for (const [key, node] of planTabEntries) {
        node.setAttribute('role', 'tab'); node.id = `pw-${key}-tab`;
        node.setAttribute('aria-controls', `pw-${key}-panel`);
    }
    planTabs.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = planTabEntries.findIndex(([key]) => key === planView);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? planTabEntries.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + planTabEntries.length) % planTabEntries.length;
        planView = planTabEntries[next][0];
        render();
        planTabEntries[next][1].focus();
    });
    planTabs.append(readButton, editButton, analysisButton);
    planHeader.append(el('h3', '', '大纲内容'), planTabs);
    const planReading = el('div', 'pw-plan-reading');
    planReading.id = 'pw-read-panel';
    planReading.setAttribute('role', 'tabpanel');
    planReading.setAttribute('aria-labelledby', 'pw-read-tab');
    const planEditing = el('div', 'pw-plan-editing');
    planEditing.id = 'pw-edit-panel';
    planEditing.setAttribute('role', 'tabpanel');
    planEditing.setAttribute('aria-labelledby', 'pw-edit-tab');
    const planAnalysis = el('section', 'pw-plan-analysis pw-plan-reading');
    planAnalysis.id = 'pw-analysis-panel';
    planAnalysis.setAttribute('role', 'tabpanel');
    planAnalysis.setAttribute('aria-labelledby', 'pw-analysis-tab');
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
    const rerollButton = button('重生成大纲', () => {
        if (isBlocked() || !getState().plan) return;
        if (dirtyPlan) {
            statusMessage.textContent = '大纲有未应用的修改，请先应用修改。';
            planView = 'edit'; render(); return;
        }
        act('rerollPlan', { input: input.value });
    }, { className: 'pw-reroll-plan' });
    const writeButton = button('确认并扩写', () => act('confirmAndWrite'), { className: 'pw-primary', iconName: 'edit' });
    outputActions.append(copyButton, fillButton);
    const primaryPlanActions = el('div', 'pw-output-actions pw-plan-primary-actions');
    primaryPlanActions.append(rerollButton, writeButton);
    const manualHint = el('p', 'pw-hint pw-manual-hint', '填入后不会自动发送；若作为普通聊天消息发送，大纲可能进入历史与记忆。');
    const draftHint = el('p', 'pw-hint pw-draft-hint', '有尚未应用的修改。请先应用修改，再重生成、复制或扩写。');
    planSection.append(planHeader, planReading, planEditing, planAnalysis, outputActions, primaryPlanActions, draftHint, manualHint);
    const failedResponse = el('details', 'pw-plan-failure pw-plan-reading');
    const failedResponseMeta = el('p', 'pw-hint');
    const failedResponseText = el('pre', 'pw-analysis-text');
    const failedReasoningText = el('pre', 'pw-analysis-text');
    const failedReasoningTitle = el('h4', '', '接口分析');
    const failedResponseActions = el('div', 'pw-output-actions');
    failedResponseActions.append(button('复制失败响应', () => act('copyFailedResponse'), { iconName: 'copy' }), button('清除', () => act('clearFailedResponse')));
    failedResponse.append(el('summary', '', '最近失败响应'), failedResponseMeta,
        el('p', 'pw-hint', '仅供排查，未作为大纲使用。只保留在本页，不进入正文请求、聊天、记忆或备份；重新生成、刷新或切换聊天后清除。'),
        el('h4', '', '返回文本'), failedResponseText, failedReasoningTitle, failedReasoningText, failedResponseActions);
    outlinePage.append(pageHeading, steps, inputField, generationActions, failedResponse, planSection);

    const promptEditorPage = el('section', 'pw-prompt-editor-page');
    const promptBack = button('返回', () => withUnsavedGuard(() => { resetEditor(); render(); restorePromptListPosition(); }), { className: 'pw-back', iconName: 'back' });
    const promptName = el('h2');
    const promptHeading = el('div', 'pw-editor-heading');
    promptHeading.append(promptBack, promptName);
    const promptInfo = el('p', 'pw-hint');
    const leaveNotice = el('div', 'pw-editor-notice');
    leaveNotice.setAttribute('role', 'alert');
    leaveNotice.hidden = true;
    const keepEditing = button('继续编辑', () => { pendingLeave = null; leaveNotice.hidden = true; (promptDraft?.marker ? promptNameInput : promptText).focus(); });
    const discardEdits = button('放弃修改', () => {
        const next = pendingLeave;
        resetEditor();
        render();
        next?.();
    }, { className: 'pw-danger' });
    const leaveActions = el('div', 'pw-notice-actions'); leaveActions.append(keepEditing, discardEdits);
    leaveNotice.append(el('p', '', '此条目有未保存的修改。继续编辑，或放弃后离开。'), leaveActions);
    const promptNameInput = control('text', '给条目起个名称');
    promptNameInput.setAttribute('aria-label', '条目名称');
    const promptRole = el('select', 'pw-input');
    promptRole.setAttribute('aria-label', '消息角色');
    for (const [value, label] of [['system', '系统 · system'], ['user', '用户 · user'], ['assistant', '助手 · assistant']]) {
        const option = el('option', '', label); option.value = value; promptRole.append(option);
    }
    const promptGroup = el('select', 'pw-input');
    promptGroup.setAttribute('aria-label', '所属分组');
    const promptMeta = el('div', 'pw-prompt-meta');
    promptMeta.append(field('消息角色', promptRole), field('所属分组', promptGroup));
    const promptText = el('textarea', 'pw-input pw-prompt-editor');
    promptText.rows = 12;
    promptText.spellcheck = false;
    promptText.setAttribute('aria-label', '预设条目内容');
    promptText.placeholder = '在这里编写这一条提示词…';
    const promptContentField = field('提示词正文', promptText);
    promptContentField.classList.add('pw-prompt-content-field');
    for (const node of [promptNameInput, promptText]) node.addEventListener('input', updatePromptDraft);
    for (const node of [promptRole, promptGroup]) node.addEventListener('change', updatePromptDraft);
    const promptSave = button('保存条目', savePrompt, { className: 'pw-primary' });
    const promptCopy = button('复制条目', () => duplicatePrompt(selectedPrompt), { iconName: 'copy' });
    const promptTokenCount = el('span', 'pw-editor-token');
    promptContentField.querySelector('.pw-label').append(promptTokenCount);
    const promptDelete = button('删除条目', () => {
        if (isBlocked() || savingPrompt || creatingPrompt || !selectedPrompt) return;
        deleteNotice.hidden = false;
        deleteNoticeText.textContent = `删除「${getState().preset?.prompts?.find(p => p.identifier === selectedPrompt)?.name || '此条目'}」？${dirtyPrompt ? '未保存的修改也会丢弃。' : ''}删除后可撤销一次。`;
        deleteNotice.scrollIntoView({ block: 'nearest' });
    }, { className: 'pw-danger', iconName: 'trash' });
    const promptActions = el('div', 'pw-prompt-editor-actions');
    promptActions.append(promptSave, promptCopy, promptDelete);
    const deleteNotice = el('div', 'pw-editor-notice pw-delete-notice');
    deleteNotice.setAttribute('role', 'alert'); deleteNotice.hidden = true;
    const deleteNoticeText = el('p');
    const deleteActions = el('div', 'pw-notice-actions');
    const cancelDelete = button('取消', () => { deleteNotice.hidden = true; });
    const confirmDelete = button('确认删除', async () => {
        if (isBlocked() || savingPrompt || !selectedPrompt || creatingPrompt) return;
        savingPrompt = true; renderEditorControls();
        const result = await act('deletePrompt', { id: selectedPrompt });
        savingPrompt = false;
        if (result !== false) { resetEditor(); activeTab = 'presets'; }
        render(); body.scrollTop = 0;
    }, { className: 'pw-danger' });
    deleteActions.append(cancelDelete, confirmDelete);
    deleteNotice.append(deleteNoticeText, deleteActions);
    promptEditorPage.append(promptHeading, leaveNotice, field('条目名称', promptNameInput), promptMeta, promptInfo, promptContentField, deleteNotice, promptActions);
    presetsPage.append(presets, promptEditorPage);
    main.append(outlinePage, presetsPage, worldbooksPage);

    const configPanel = el('section', 'pw-config-page pw-settings pw-page');
    configPanel.setAttribute('aria-label', '配置');
    configPanel.append(el('h2', 'pw-settings-page-title', '配置'));
    const settingsPanel = el('section', 'pw-settings pw-page');
    settingsPanel.setAttribute('aria-label', '设置');
    settingsPanel.append(el('h2', 'pw-settings-page-title', '设置'));
    const settingsFields = {};
    function settingsSection(name, expanded = false, parent = configPanel) {
        const section = el('details', 'pw-settings-section');
        section.append(el('summary', '', name)); section.open = expanded;
        parent.append(section);
        return section;
    }
    function settingInput(section, key, label, type, placeholder, hint, extra = {}) {
        const node = control(type, placeholder);
        Object.assign(node, extra);
        node.addEventListener('input', () => { configDrafts.set(key, node.value); settingsSaveStatus.textContent = '已修改，点击保存设置可保存到当前方案。'; });
        node.addEventListener('change', () => {
            configDrafts.set(key, node.value);
            let value = node.value;
            if (type === 'number') value = value === '' ? '' : Number(value);
            act('settings', { [key]: value });
        });
        section.append(field(label, node, hint));
        settingsFields[key] = node;
        return node;
    }
    const appearancePage = el('section', 'pw-appearance-page pw-page');
    const appearanceHeading = el('div', 'pw-page-heading'); appearanceHeading.append(icon('leaf'), el('h2', '', '美化'));
    const appearanceSection = el('section', 'pw-appearance-section');
    appearanceSection.append(el('h3', '', '主题与阅读'), field('配色', themeSelect));
    appearancePage.append(appearanceHeading, appearanceSection);
    const fontSizeInput = control('number', '12');
    Object.assign(fontSizeInput, { min: '10', max: '24', step: '0.5', inputMode: 'decimal' });
    fontSizeInput.setAttribute('aria-label', '自定义字号（px）');
    const lineHeightInput = control('number', '1.75');
    Object.assign(lineHeightInput, { min: '1.2', max: '2.6', step: '0.05', inputMode: 'decimal' });
    lineHeightInput.setAttribute('aria-label', '行距（倍数）');
    fontSizeInput.addEventListener('input', updateAppearanceDraft);
    lineHeightInput.addEventListener('input', updateAppearanceDraft);
    const appearanceSave = button('保存美化', () => saveAppearance(), { className: 'pw-primary' });
    const appearanceReset = button('恢复默认', () => saveAppearance({ theme: 'system', fontSize: '12', lineHeight: '1.75' }));
    const appearanceActions = el('div', 'pw-appearance-actions'); appearanceActions.append(appearanceSave, appearanceReset);
    const appearanceStatus = el('p', 'pw-hint pw-appearance-status'); appearanceStatus.setAttribute('role', 'status');
    appearanceSection.append(field('自定义字号（px）', fontSizeInput), field('行距（倍数）', lineHeightInput), appearanceActions, appearanceStatus);
    const apiSection = settingsSection('规划连接', true);
    const apiProfileSelect = el('select', 'pw-input'); apiProfileSelect.setAttribute('aria-label', 'API 方案');
    apiProfileSelect.addEventListener('change', () => {
        const id = apiProfileSelect.value; apiProfileSelect.value = getState().activeApiProfileId || '';
        guardApiChange(() => act('apiProfileSelect', { id }));
    });
    const apiProfileRow = el('div', 'pw-profile-select-row');
    apiProfileRow.append(field('API 方案', apiProfileSelect), button('新建', () => guardApiChange(() => act('apiProfileNew')), { iconName: 'add' }));
    const apiProfileManage = el('details', 'pw-api-manage pw-advanced'); apiProfileManage.append(el('summary', '', '管理 API 方案'));
    const apiProfileName = control('text', '方案名称'); apiProfileName.setAttribute('aria-label', 'API 方案名称');
    apiProfileName.addEventListener('input', () => { settingsSaveStatus.textContent = 'API 方案名称尚未保存。'; });
    const apiProfileActions = el('div', 'pw-management-actions');
    const apiProfileDeleteButton = button('删除方案', () => { apiDeleteNotice.hidden = false; });
    apiProfileActions.append(button('保存方案', () => saveApiProfile('apiProfileSave')), button('另存为', () => saveApiProfile('apiProfileSaveAs')), apiProfileDeleteButton);
    const apiDeleteNotice = el('div', 'pw-editor-notice'); apiDeleteNotice.hidden = true;
    const apiDeleteActions = el('div', 'pw-notice-actions');
    apiDeleteActions.append(button('取消', () => { apiDeleteNotice.hidden = true; }), button('确认删除方案', async () => {
        const result = await act('apiProfileDelete', { id: getState().activeApiProfileId });
        if (result !== false) { apiDeleteNotice.hidden = true; render(); }
    }, { className: 'pw-danger' }));
    apiDeleteNotice.append(el('p', '', '删除当前 API 方案？此浏览器为该方案记住的密钥也将清除。'), apiDeleteActions);
    apiProfileManage.append(field('方案名称', apiProfileName), apiProfileActions, apiDeleteNotice);
    const apiUnsavedNotice = el('div', 'pw-editor-notice'); apiUnsavedNotice.hidden = true;
    const apiUnsavedActions = el('div', 'pw-notice-actions');
    apiUnsavedActions.append(button('继续编辑', () => { pendingApiChange = null; apiUnsavedNotice.hidden = true; }), button('放弃并切换', () => {
        const next = pendingApiChange; pendingApiChange = null; apiUnsavedNotice.hidden = true; next?.();
    }, { className: 'pw-danger' }));
    apiUnsavedNotice.append(el('p', '', '当前 API 方案有未保存的更改。可先保存方案，再切换。'), apiUnsavedActions);
    apiSection.append(apiProfileRow, apiProfileManage, apiUnsavedNotice);
    settingInput(apiSection, 'baseUrl', '接口地址', 'url', 'https://…/v1', undefined, { autocomplete: 'url', spellcheck: false });
    const modelInput = settingInput(apiSection, 'model', '模型名称', 'text', '填写模型 ID', undefined, { autocomplete: 'off', spellcheck: false });
    const modelActions = el('div', 'pw-model-actions');
    const fetchModelsButton = button('拉取模型', () => { modelSearch.value = ''; return act('fetchModels', { settings: collectSettings(), apiKey: keyField.value }); });
    const testApiButton = button('测试连接', () => act('testApi', { settings: collectSettings(), apiKey: keyField.value }));
    modelActions.append(fetchModelsButton, testApiButton);
    const modelsSelect = el('select', 'pw-input'); modelsSelect.setAttribute('aria-label', '接口返回的模型'); modelsSelect.hidden = true;
    const modelSearch = control('search', '搜索模型'); modelSearch.setAttribute('aria-label', '搜索模型'); modelSearch.hidden = true;
    modelSearch.addEventListener('input', () => renderModels(getState()));
    const modelSearchStatus = el('p', 'pw-hint pw-model-search-status'); modelSearchStatus.setAttribute('role', 'status'); modelSearchStatus.hidden = true;
    modelsSelect.addEventListener('change', () => {
        if (!modelsSelect.value) return;
        modelInput.value = modelsSelect.value; configDrafts.set('model', modelsSelect.value); act('settings', { model: modelsSelect.value });
    });
    const apiStatus = el('p', 'pw-hint pw-api-status'); apiStatus.setAttribute('role', 'status');
    const keyField = control('password', '填写 API 密钥');
    keyField.autocomplete = 'off';
    keyField.name = 'planning-session-token';
    keyField.spellcheck = false;
    keyField.addEventListener('input', () => { keyDraftDirty = true; settingsSaveStatus.textContent = '密钥已修改；是否记住取决于下方选项。'; });
    keyField.addEventListener('change', () => act('apiKey', { value: keyField.value }));
    apiSection.append(field('API 密钥', keyField, '密钥不保存到预设或导出文件。'));
    const rememberKeyLabel = el('label', 'pw-checkbox-label pw-remember-key');
    const rememberKey = control('checkbox'); rememberKey.setAttribute('aria-label', '在此浏览器记住密钥');
    rememberKey.addEventListener('change', () => saveAllSettings());
    decorateCheckbox(rememberKeyLabel, rememberKey, el('span', '', '在此浏览器记住密钥'));
    apiSection.append(rememberKeyLabel, el('p', 'pw-hint', '默认不记住。仅此浏览器保存，非加密存储，不随预设导出。'), modelActions, modelSearch, modelsSelect, modelSearchStatus, apiStatus, el('p', 'pw-hint', '测试会发送极短请求，可能计费。'));
    const advanced = el('details', 'pw-advanced');
    advanced.append(el('summary', '', '生成参数'));
    const advancedFields = el('div', 'pw-advanced-fields');
    settingInput(advancedFields, 'temperature', '温度', 'number', '使用默认值', undefined, { step: '0.1', min: '0', max: '2', inputMode: 'decimal' });
    settingInput(advancedFields, 'maxTokens', '最大输出 Token', 'number', '留空由接口决定', undefined, { step: '1', min: '1', inputMode: 'numeric' });
    const streamLabel = el('label', 'pw-checkbox-label pw-stream-field');
    const streamInput = control('checkbox'); streamInput.setAttribute('aria-label', '流式接收');
    streamInput.addEventListener('change', () => { configDrafts.set('stream', streamInput.checked); settingsSaveStatus.textContent = '流式设置已修改，请保存方案或保存设置。'; });
    decorateCheckbox(streamLabel, streamInput, el('span', '', '流式接收'));
    settingsFields.stream = streamInput;
    advancedFields.append(streamLabel, el('p', 'pw-hint pw-stream-field', '跟随此 API 方案；完整接收并校验后才注入。输出上限留空时由接口决定。'));
    advanced.append(advancedFields);
    apiSection.append(advanced);
    const lengthSection = settingsSection('正文目标');
    const wordFields = el('div', 'pw-word-fields');
    settingInput(wordFields, 'minWords', '最少字数', 'number', '未设置', undefined, { min: '1', step: '1', inputMode: 'numeric' });
    settingInput(wordFields, 'maxWords', '最多字数', 'number', '未设置', undefined, { min: '1', step: '1', inputMode: 'numeric' });
    lengthSection.append(wordFields, el('p', 'pw-hint', '规划与扩写使用同一份目标'));
    const storyPace = settingSelect(lengthSection, 'storyPace', '剧情推进', Object.entries(STORY_PACES).map(([value, pace]) => [value, pace.label]));
    const storyPaceHint = el('p', 'pw-hint pw-story-pace-hint'); storyPaceHint.id = 'pw-story-pace-hint';
    storyPace.setAttribute('aria-describedby', storyPaceHint.id);
    function renderStoryPaceHint() { storyPaceHint.textContent = (STORY_PACES[storyPace.value] || STORY_PACES.preset).description; }
    storyPace.addEventListener('change', renderStoryPaceHint);
    lengthSection.append(storyPaceHint);
    const relationshipPace = settingSelect(lengthSection, 'relationshipPace', '感情推进', Object.entries(RELATIONSHIP_PACES).map(([value, pace]) => [value, pace.label]));
    const relationshipPaceHint = el('p', 'pw-hint pw-relationship-pace-hint'); relationshipPaceHint.id = 'pw-relationship-pace-hint';
    relationshipPace.setAttribute('aria-describedby', relationshipPaceHint.id);
    function renderRelationshipPaceHint() { relationshipPaceHint.textContent = (RELATIONSHIP_PACES[relationshipPace.value] || RELATIONSHIP_PACES.preset).description + ' 各档都需经历支撑，不跳过关系阶段。'; }
    relationshipPace.addEventListener('change', renderRelationshipPaceHint);
    lengthSection.append(relationshipPaceHint);
    const modeSection = settingsSection('使用方式');
    const modeSelect = el('select', 'pw-input');
    modeSelect.setAttribute('aria-label', '使用方式');
    for (const [value, text] of [['review', '先查看，再扩写'], ['auto', '自动注入并扩写'], ['manual', '只生成大纲，手动使用']]) {
        const opt = el('option', '', text); opt.value = value; modeSelect.append(opt);
    }
    modeSelect.addEventListener('change', () => { configDrafts.set('mode', modeSelect.value); settingsSaveStatus.textContent = '已修改，点击保存设置可确认当前配置。'; act('settings', { mode: modeSelect.value }); });
    const autoLabel = el('label', 'pw-checkbox-label');
    const autoOnSend = control('checkbox');
    autoOnSend.addEventListener('change', () => { configDrafts.set('autoOnSend', autoOnSend.checked); settingsSaveStatus.textContent = '已修改，点击保存设置可确认当前配置。'; act('settings', { autoOnSend: autoOnSend.checked }); });
    decorateCheckbox(autoLabel, autoOnSend, el('span', '', '发送时自动规划'));
    const modeHint = el('p', 'pw-hint');
    const modeField = field('规划时机', modeSelect); modeField.classList.add('pw-mode-field');
    modeSection.append(modeField, autoLabel, modeHint);
    settingSelect(modeSection, 'regeneratePolicy', '酒馆重新生成', [['refresh', '每次重新生成大纲'], ['reuse', '优先沿用大纲，没有则生成']]);
    modeSection.append(el('p', 'pw-hint', '开启自动规划后生效；读取上一条用户输入，保留输入框草稿。'));
    const injectionSection = settingsSection('大纲注入');
    function settingSelect(section, key, label, options) {
        const node = el('select', 'pw-input'); node.setAttribute('aria-label', label);
        node.append(...options.map(([value, text]) => { const option = el('option', '', text); option.value = value; return option; }));
        node.addEventListener('change', () => { configDrafts.set(key, node.value); settingsSaveStatus.textContent = '已修改，点击保存设置可确认当前配置。'; act('settings', { [key]: node.value }); });
        settingsFields[key] = node; section.append(field(label, node)); return node;
    }
    const injectionPosition = settingSelect(injectionSection, 'injectionPosition', '注入位置', [['in_chat', '聊天历史中'], ['before_prompt', '角色/场景提示之前'], ['in_prompt', '角色/场景提示之后']]);
    const injectionDepth = settingInput(injectionSection, 'injectionDepth', '注入深度', 'number', '0', '0 为最靠近本轮回复的位置。', { min: '0', step: '1', inputMode: 'numeric' });
    settingSelect(injectionSection, 'injectionRole', '消息角色', [['system', '系统 · system'], ['user', '用户 · user'], ['assistant', '助手 · assistant']]);
    injectionSection.append(el('p', 'pw-hint', '实际顺序由酒馆主预设组装。'));
    const animaSection = settingsSection('Anima 记忆');
    animaSection.append(el('p', 'pw-anima-description', '使用酒馆中已安装的 Anima，无需另配连接。保留规则沿用原设置。'));
    const animaStatus = el('div', 'pw-anima-status', '尚未检测');
    animaStatus.setAttribute('role', 'status');
    const animaDetect = button('重新检测', () => act('detectAnima'), { className: 'pw-anima-detect' });
    const animaDetection = el('div', 'pw-anima-detection'); animaDetection.append(animaStatus, animaDetect);
    const animaAdvanced = el('details', 'pw-advanced');
    animaAdvanced.append(el('summary', '', '安装目录（通常无需修改）'));
    settingInput(animaAdvanced, 'animaPath', '扩展目录', 'text', '自动检测现有扩展', '自动检测现有扩展；仅安装目录改名或无法识别时手动填写。', { spellcheck: false });
    const detectedPath = el('p', 'pw-hint pw-detected-path');
    animaAdvanced.append(detectedPath);
    animaSection.append(animaDetection, el('p', 'pw-hint', '检测不会召回记忆或消耗保留次数'), animaAdvanced);
    const updateSection = settingsSection('扩展更新', true, settingsPanel);
    const updateVersion = el('p', 'pw-hint');
    const updatePhase = el('p', 'pw-update-phase');
    const updateMessage = el('p', 'pw-hint'); updateMessage.setAttribute('role', 'status');
    const updateCheckedAt = el('p', 'pw-hint');
    const updateLocalNotice = el('p', 'pw-hint pw-update-notice'); updateLocalNotice.setAttribute('role', 'status');
    const updateAutoCheck = control('checkbox');
    const updateAutoCheckLabel = decorateCheckbox(el('label', 'pw-checkbox-label'), updateAutoCheck, el('span', '', '启动时检查更新'));
    const updateAutoInstall = control('checkbox');
    const updateAutoInstallLabel = decorateCheckbox(el('label', 'pw-checkbox-label'), updateAutoInstall, el('span', '', '空闲时自动更新'));
    updateAutoCheck.addEventListener('change', () => act('updatePreferences', { autoCheck: updateAutoCheck.checked }));
    updateAutoInstall.addEventListener('change', () => act('updatePreferences', { autoInstall: updateAutoInstall.checked }));
    const checkUpdateButton = button('检查更新', () => act('checkUpdate'));
    const installUpdateButton = button('立即更新', () => performUpdate('installUpdate'));
    const reloadUpdateButton = button('刷新生效', () => performUpdate('reloadUpdate'), { className: 'pw-primary' });
    const updateActions = el('div', 'pw-management-actions'); updateActions.append(checkUpdateButton, installUpdateButton, reloadUpdateButton);
    updateSection.append(updateVersion, updatePhase, updateMessage, updateCheckedAt, updateAutoCheckLabel, updateAutoInstallLabel, updateActions, updateLocalNotice);
    const logsDetails = el('details', 'pw-runtime-logs pw-advanced');
    const logsSummary = el('summary', '', '运行日志');
    const logActions = el('div', 'pw-management-actions');
    logActions.append(button('复制日志', () => act('copyLogs')), button('导出日志', () => act('exportLogs')), button('清空日志', () => act('clearLogs')));
    const logList = el('div', 'pw-log-list'); logList.setAttribute('role', 'log'); logList.setAttribute('aria-label', '运行日志');
    logsDetails.append(logsSummary, logActions, logList);
    const settingsSaveBar = el('div', 'pw-settings-save');
    const settingsSaveButton = button('保存设置', saveAllSettings, { className: 'pw-primary' });
    const settingsSaveStatus = el('p', 'pw-hint'); settingsSaveStatus.setAttribute('role', 'status');
    settingsSaveBar.append(settingsSaveButton, settingsSaveStatus);
    const workshopTools = createWorkshopTools({ getState, onAction: act });
    outlinePage.append(workshopTools.outlineElement);
    configPanel.append(settingsSaveBar);
    settingsPanel.append(logsDetails, workshopTools.settingsElement);
    main.append(configPanel, settingsPanel, appearancePage);
    body.append(main);
    shell.append(body, statusMessage);

    const footer = el('footer', 'pw-footer');
    const footerDot = el('span', 'pw-status-dot');
    const footerStatus = el('span', '', '准备就绪');
    footerStatus.setAttribute('role', 'status');
    footer.append(footerDot, footerStatus);
    shell.append(footer);
    const reordering = installPromptReordering(presetGroups, { isBlocked: () => isBlocked() || savingPrompt || groupSaving || Boolean(groupRange),
        onMove: ({ id, beforeId }) => movePrompt(id, beforeId) });
    document.body.append(dialog);

    function renderTabs() {
        stepNodes.forEach((node, index) => { node.querySelector('.pw-step-label').textContent = mobile.matches ? ['记忆', '大纲', '确认', '扩写'][index] : ['读取记忆', '生成大纲', '编辑确认', '正文扩写'][index]; });
        dialog.dataset.tab = activeTab;
        dialog.dataset.promptEditor = selectedPrompt || creatingPrompt ? 'true' : 'false';
        for (const [id, node] of pageTabButtons) {
            node.classList.toggle('pw-selected', activeTab === id);
            node.setAttribute('aria-current', activeTab === id ? 'page' : 'false');
        }
        outlinePage.hidden = activeTab !== 'outline';
        presetsPage.hidden = activeTab !== 'presets';
        worldbooksPage.hidden = activeTab !== 'worldbooks';
        configPanel.hidden = activeTab !== 'config';
        settingsPanel.hidden = activeTab !== 'settings';
        appearancePage.hidden = activeTab !== 'appearance';
        promptEditorPage.hidden = activeTab !== 'presets' || !(selectedPrompt || creatingPrompt);
        presets.hidden = mobile.matches && Boolean(selectedPrompt || creatingPrompt);
    }
    function resetEditor() {
        selectedPrompt = null; creatingPrompt = false; dirtyPrompt = false;
        promptDraft = null; promptBaseline = ''; pendingLeave = null;
        leaveNotice.hidden = true; deleteNotice.hidden = true;
    }
    function rememberPromptListPosition(id = null, source = 'presets') {
        if (selectedPrompt || creatingPrompt) return;
        promptListReturn = { top: body.scrollTop, mainTop: main.scrollTop, id, source };
    }
    function restorePromptListPosition() {
        if (!promptListReturn) return;
        body.scrollTop = promptListReturn.top;
        main.scrollTop = promptListReturn.mainTop || 0;
        // Returning from a review must stay in that list, including when the
        // saved edit removes its row from the pending filter.
        if (promptListReturn.source === 'review') return;
        const row = [...presetGroups.querySelectorAll('.pw-prompt-row')].find(node => node.dataset.promptId === promptListReturn.id);
        if (row?.getClientRects().length) row.scrollIntoView({ block: 'nearest' });
    }
    function orderedPrompts(preset = getState().preset) {
        const prompts = new Map((preset?.prompts || []).map(item => [item.identifier, item]));
        const ids = [...new Set([...(preset?.order || []).map(item => typeof item === 'string' ? item : item.identifier), ...prompts.keys()])];
        return ids.filter(id => prompts.has(id)).map(id => prompts.get(id));
    }
    function groupDraftDirty() {
        if (groupRange) return true;
        const original = getState().preset?.groups?.find(item => item.id === groupManage?.id);
        return groupManage?.mode === 'rename' && groupManage.name !== original?.name;
    }
    function clearGroupFlow() {
        groupRange = null; groupManage = null; pendingGroupLeave = null; groupLeaveNotice.hidden = true;
    }
    function focusGroup(id) {
        const group = [...presetGroups.querySelectorAll('.pw-group')].find(node => node.dataset.groupId === id);
        if (group) { group.scrollIntoView({ block: 'nearest' }); group.querySelector('summary')?.focus({ preventScroll: true }); }
    }
    function beginGroupRange(id) {
        if (isBlocked() || savingPrompt || groupSaving || groupRange) return;
        withUnsavedGuard(() => {
            const state = getState(), ids = orderedPrompts().map(item => item.identifier);
            if (!ids.includes(id)) return;
            resetEditor(); groupManage = null;
            groupRange = { presetId: state.activePresetId, startId: id, endId: null, name: '', order: JSON.stringify(ids), returnTop: body.scrollTop };
            for (const menu of presetGroups.querySelectorAll('.pw-row-menu')) menu.hidden = true;
            render(); body.scrollTop = 0;
            const start = [...groupRangeList.querySelectorAll('button')].find(node => node.dataset.promptId === id);
            start?.scrollIntoView({ block: 'nearest' }); start?.focus({ preventScroll: true });
        });
    }
    function cancelGroupRange() {
        if (groupSaving) return;
        const previous = groupRange; clearGroupFlow(); render();
        if (!previous) return;
        body.scrollTop = previous.returnTop;
        const row = [...presetGroups.querySelectorAll('.pw-prompt-row')].find(node => node.dataset.promptId === previous.startId);
        row?.scrollIntoView({ block: 'nearest' }); row?.querySelector('.pw-row-more')?.focus({ preventScroll: true });
    }
    async function saveGroupRange() {
        if (isBlocked() || groupSaving || !groupRange?.endId) return;
        if (!groupRange.name.trim()) { statusMessage.textContent = '请填写分组名称。'; groupRangeName.focus(); return; }
        const draft = { ...groupRange }; groupSaving = true; render();
        const result = await act('createPromptGroup', { startId: draft.startId, endId: draft.endId, name: draft.name.trim(), presetId: draft.presetId });
        groupSaving = false;
        if (result?.id && getState().activePresetId === draft.presetId) {
            clearGroupFlow(); groupOpen.set(result.id, true); presetSignature = ''; render(); focusGroup(result.id);
        } else render();
    }
    function openGroupManagement(id, mode = 'menu') {
        if (isBlocked() || groupSaving || groupRange) return;
        withUnsavedGuard(() => {
            const group = getState().preset?.groups?.find(item => item.id === id);
            if (!group) return;
            resetEditor();
            const closing = groupManage?.id === id && groupManage.mode === mode;
            groupManage = closing ? null : { id, presetId: getState().activePresetId, mode, name: group.name };
            if (!closing) groupOpen.set(id, true);
            presetSignature = ''; render();
            const node = [...presetGroups.querySelectorAll('.pw-group')].find(item => item.dataset.groupId === id);
            node?.querySelector('.pw-group-manage')?.scrollIntoView({ block: 'nearest' });
            if (mode === 'rename') node?.querySelector('.pw-group-manage input')?.focus({ preventScroll: true });
        });
    }
    async function saveGroupManagement(type) {
        if (isBlocked() || groupSaving || !groupManage) return;
        const draft = { ...groupManage };
        if (type === 'renamePromptGroup' && !draft.name.trim()) { statusMessage.textContent = '请填写分组名称。'; return; }
        if (getState().activePresetId !== draft.presetId) { clearGroupFlow(); render(); return; }
        const firstId = getState().preset?.prompts?.find(item => {
            const map = getState().preset.promptGroups?.[item.identifier]; return (typeof map === 'string' ? map : map?.groupId) === draft.id;
        })?.identifier;
        groupSaving = true; render();
        const result = await act(type, { id: draft.id, name: draft.name.trim(), presetId: draft.presetId });
        groupSaving = false;
        if (result !== false) {
            clearGroupFlow();
            if (type === 'dissolvePromptGroup') groupOpen.set('__ungrouped', true);
            presetSignature = ''; render();
            if (type === 'renamePromptGroup') focusGroup(draft.id);
            else [...presetGroups.querySelectorAll('.pw-prompt-row')].find(node => node.dataset.promptId === firstId)?.scrollIntoView({ block: 'nearest' });
        } else render();
    }
    function renderGroupTools(state) {
        const selecting = Boolean(groupRange);
        groupRangePanel.hidden = !selecting;
        for (const node of [presetSelectRow, presetSaveStatus, presetToolbar, presetDrawers, presetGroups]) node.hidden = selecting;
        undoNotice.hidden = selecting || !state.undoDeletion;
        presetWarnings.textContent = (state.preset?.warnings || []).join(' ');
        presetWarnings.hidden = selecting || !presetWarnings.textContent;
        if (!selecting) return;
        const prompts = orderedPrompts(state.preset), ids = prompts.map(item => item.identifier);
        if (state.activePresetId !== groupRange.presetId || JSON.stringify(ids) !== groupRange.order) {
            clearGroupFlow(); statusMessage.textContent = '预设顺序已变化，请重新选择分组范围。'; renderGroupTools(state); return;
        }
        const start = ids.indexOf(groupRange.startId), end = ids.indexOf(groupRange.endId);
        const low = Math.min(start, end), high = Math.max(start, end), count = end < 0 ? 0 : high - low + 1;
        groupRangeStatus.textContent = end < 0 ? `起点：${prompts[start].name || groupRange.startId} · 请选择终点` : `已选 ${count} 条 · 包含起点与终点，发送顺序保持不变`;
        groupRangeForm.hidden = end < 0;
        setInputValue(groupRangeName, groupRange.name);
        const signature = JSON.stringify([ids, groupRange.startId, groupRange.endId]);
        if (groupRangeList.dataset.signature !== signature) {
            const top = groupRangeList.scrollTop;
            groupRangeList.dataset.signature = signature;
            groupRangeList.replaceChildren(...prompts.map((prompt, index) => {
                const name = prompt.name?.split('｜').slice(1).join('｜') || prompt.name || prompt.identifier;
                const node = button('', () => {
                    if (isBlocked() || groupSaving || !groupRange) return;
                    groupRange.endId = prompt.identifier; renderGroupTools(getState());
                    [...groupRangeList.querySelectorAll('button')].find(item => item.dataset.promptId === prompt.identifier)?.focus({ preventScroll: true });
                    groupRangeForm.scrollIntoView({ block: 'nearest' });
                }, { className: 'pw-group-range-row' });
                node.dataset.promptId = prompt.identifier;
                node.setAttribute('aria-label', `以此为终点：${name}`);
                node.setAttribute('aria-pressed', String(end >= 0 && index >= low && index <= high));
                const tags = [index === start ? '起点' : '', index === end ? '终点' : ''].filter(Boolean);
                node.replaceChildren(el('span', 'pw-group-range-number', String(index + 1)), el('span', 'pw-group-range-name', name), el('span', 'pw-group-range-tag', tags.join(' / ')));
                return node;
            }));
            groupRangeList.scrollTop = top;
        }
        for (const node of groupRangePanel.querySelectorAll('button,input')) node.disabled = isBlocked(state) || groupSaving;
    }
    function guardPresetChange(next, { keepName = false } = {}) {
        withUnsavedGuard(() => {
            if (!presetNameDirty || keepName) { next(); return; }
            pendingPresetChange = next; presetUnsaved.hidden = false;
            presetUnsaved.scrollIntoView({ block: 'nearest' });
        });
    }
    function collectSettings() {
        const result = { ...getState().settings };
        for (const [key, node] of Object.entries(settingsFields)) result[key] = node.type === 'checkbox' ? node.checked : node.type === 'number' ? (node.value === '' ? '' : Number(node.value)) : node.value;
        result.mode = modeSelect.value;
        result.autoOnSend = autoOnSend.checked;
        return result;
    }
    function savedAppearance() {
        const settings = getState().settings || {};
        return { theme: settings.theme || 'system', fontSize: String(settings.fontSize || '12'), lineHeight: String(settings.lineHeight || '1.75') };
    }
    function updateAppearanceDraft() {
        appearanceDraft = { theme: themeSelect.value, fontSize: fontSizeInput.value, lineHeight: lineHeightInput.value };
        const saved = savedAppearance();
        appearanceDirty = appearanceDraft.theme !== saved.theme || appearanceDraft.fontSize.trim() === '' || appearanceDraft.lineHeight.trim() === ''
            || Number(appearanceDraft.fontSize) !== Number(saved.fontSize) || Number(appearanceDraft.lineHeight) !== Number(saved.lineHeight);
        appearanceFeedback = '';
        renderAppearance();
    }
    function renderAppearance() {
        if (!appearanceDirty || !appearanceDraft) appearanceDraft = savedAppearance();
        const { theme, fontSize, lineHeight } = appearanceDraft;
        themeSelect.value = theme;
        setInputValue(fontSizeInput, fontSize); setInputValue(lineHeightInput, lineHeight);
        dialog.dataset.theme = ['system', 'light', 'dark', 'host'].includes(theme) ? theme : 'system';
        syncHostSurface();
        const font = Number(fontSize), height = Number(lineHeight);
        const saved = savedAppearance();
        dialog.style.setProperty('--pw-font-size', `${Number.isFinite(font) && font >= 10 && font <= 24 ? font : saved.fontSize}px`);
        dialog.style.setProperty('--pw-line-height', String(Number.isFinite(height) && height >= 1.2 && height <= 2.6 ? height : saved.lineHeight));
        appearanceStatus.textContent = appearanceFeedback || (savingAppearance ? '正在保存…' : appearanceDirty ? '美化修改未保存，当前为预览。' : '美化已保存。');
        appearanceStatus.classList.toggle('pw-error', Boolean(appearanceFeedback));
        for (const node of appearancePage.querySelectorAll('button,input,select')) node.disabled = isBlocked() || savingAppearance;
        appearanceSave.disabled = isBlocked() || savingAppearance || !appearanceDirty;
    }
    function syncHostSurface() {
        if (destroyed || dialog.dataset.theme !== 'host') return;
        const hostColor = getComputedStyle(dialog).getPropertyValue('--SmartThemeBlurTintColor').trim();
        hostColorProbe.style.setProperty('color', '#11171e', 'important');
        if (hostColor) hostColorProbe.style.setProperty('color', hostColor, 'important');
        const color = getComputedStyle(hostColorProbe).color;
        const match = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
        const opaque = match ? `rgb(${match.slice(1, 4).map(value => Math.max(0, Math.min(255, Math.round(Number(value))))).join(', ')})` : 'rgb(17, 23, 30)';
        if (dialog.style.getPropertyValue('--pw-host-opaque-bg') !== opaque) dialog.style.setProperty('--pw-host-opaque-bg', opaque);
    }
    async function saveAppearance(defaults) {
        if (isBlocked() || savingAppearance) return;
        const values = defaults || { theme: themeSelect.value, fontSize: fontSizeInput.value, lineHeight: lineHeightInput.value };
        const font = Number(values.fontSize), height = Number(values.lineHeight);
        if (!String(values.fontSize).trim() || !Number.isFinite(font) || font < 10 || font > 24
            || !String(values.lineHeight).trim() || !Number.isFinite(height) || height < 1.2 || height > 2.6) {
            appearanceFeedback = '字号请填 10–24 px，行距请填 1.2–2.6 倍。'; renderAppearance(); return;
        }
        savingAppearance = true; renderAppearance();
        const result = await act('saveAppearance', { theme: values.theme, fontSize: font, lineHeight: height });
        savingAppearance = false;
        if (result !== false) { appearanceDirty = false; appearanceDraft = null; appearanceFeedback = ''; }
        renderAppearance();
    }
    function apiPayload() {
        return { name: apiProfileName.value.trim(), settings: collectSettings(), apiKey: keyField.value, rememberKey: rememberKey.checked };
    }
    function apiDirty() {
        const state = getState();
        const profile = state.apiProfiles?.find(p => p.id === state.activeApiProfileId);
        if (!profile) return false;
        const draft = apiPayload();
        const changed = ['baseUrl', 'model', 'temperature', 'maxTokens', 'stream'].some(key => String(draft.settings[key] ?? '') !== String(profile[key] ?? ''));
        return changed || draft.name !== profile.name || draft.apiKey !== apiKeyBaseline || draft.rememberKey !== rememberBaseline;
    }
    function hasUnsavedChanges() {
        const state = getState();
        if (groupDraftDirty() || dirtyPrompt || dirtyPlan || presetNameDirty || appearanceDirty || apiDirty()) return true;
        const settings = state.settings || {};
        if (Object.entries(settingsFields).some(([key, node]) => node.type === 'checkbox' ? node.checked !== Boolean(settings[key]) : node.value !== String(settings[key] ?? (['storyPace', 'relationshipPace'].includes(key) ? 'preset' : '')))) return true;
        return modeSelect.value !== (settings.mode || 'review') || autoOnSend.checked !== Boolean(settings.autoOnSend)
            || keyField.value !== (state.apiKey || '');
    }
    async function performUpdate(type) {
        if (isBlocked()) return;
        if (hasUnsavedChanges()) {
            updateLocalNotice.textContent = '有未保存的修改，请先保存后再更新或刷新。';
            updateLocalNotice.scrollIntoView({ block: 'nearest' }); return;
        }
        updateLocalNotice.textContent = '';
        await act(type);
    }
    function guardApiChange(next) {
        if (isBlocked()) return;
        if (!apiDirty()) { next(); return; }
        pendingApiChange = next; apiUnsavedNotice.hidden = false;
        apiUnsavedNotice.scrollIntoView({ block: 'nearest' });
    }
    function markApiSaved() {
        for (const key of ['baseUrl', 'model', 'temperature', 'maxTokens', 'stream']) configDrafts.delete(key);
        keyDraftDirty = false;
        apiKeyBaseline = keyField.value; rememberBaseline = rememberKey.checked;
        apiUnsavedNotice.hidden = true; pendingApiChange = null;
    }
    async function saveApiProfile(type) {
        if (isBlocked()) return;
        const payload = apiPayload();
        if (type === 'apiProfileSaveAs' && payload.name === getState().apiProfiles?.find(p => p.id === getState().activeApiProfileId)?.name) delete payload.name;
        const result = await act(type, payload);
        if (result !== false) { markApiSaved(); render(); }
    }
    async function saveAllSettings() {
        if (isBlocked()) return;
        const payload = apiPayload();
        const result = await act('saveSettings', { settings: payload.settings, apiKey: payload.apiKey, rememberKey: payload.rememberKey, profileName: payload.name });
        if (result !== false) { markApiSaved(); configDrafts.clear(); settingsSaveStatus.textContent = '设置已保存。'; render(); }
        else rememberKey.checked = Boolean(getState().rememberApiKey);
    }
    function withUnsavedGuard(next) {
        if (savingPrompt || groupSaving) return;
        if (groupDraftDirty()) {
            pendingGroupLeave = next; activeTab = 'presets'; groupLeaveNotice.hidden = false;
            renderTabs(); groupLeaveNotice.scrollIntoView({ block: 'nearest' }); return;
        }
        if (!dirtyPrompt) { next(); return; }
        pendingLeave = next;
        activeTab = 'presets';
        leaveNotice.hidden = false; deleteNotice.hidden = true;
        renderTabs();
        leaveNotice.scrollIntoView({ block: 'nearest' });
        keepEditing.focus({ preventScroll: true });
    }
    function draftValues() {
        return { name: promptNameInput.value, content: promptText.value, role: promptRole.value, groupId: promptGroup.value };
    }
    function updatePromptDraft() {
        if (!promptDraft || isBlocked() || savingPrompt) return;
        Object.assign(promptDraft, draftValues());
        dirtyPrompt = JSON.stringify(draftValues()) !== promptBaseline;
        deleteNotice.hidden = true;
        renderEditorControls();
    }
    function loadPromptDraft(prompt, groupId = '') {
        promptDraft = { name: prompt.name || '', content: prompt.content || '', role: prompt.role || 'system', groupId, marker: Boolean(prompt.marker) };
        promptBaseline = JSON.stringify({ name: promptDraft.name, content: promptDraft.content, role: promptDraft.role, groupId });
        dirtyPrompt = false;
    }
    function newPrompt(groupId = '') {
        if (isBlocked() || savingPrompt || groupSaving || groupRange) return;
        rememberPromptListPosition();
        withUnsavedGuard(() => {
            clearGroupFlow(); resetEditor(); creatingPrompt = true; activeTab = 'presets';
            if (groupId && !getState().preset?.groups?.some(group => group.id === groupId)) groupId = '';
            loadPromptDraft({ name: '', content: '', role: 'system' }, groupId);
            render(); body.scrollTop = 0; main.scrollTop = 0;
            promptNameInput.focus({ preventScroll: true });
        });
    }
    function openPrompt(id, source = 'presets') {
        if (isBlocked() || savingPrompt || groupSaving || groupRange || (selectedPrompt === id && !creatingPrompt)) return;
        rememberPromptListPosition(id, source);
        withUnsavedGuard(() => {
            clearGroupFlow(); resetEditor(); selectedPrompt = id; activeTab = 'presets';
            render(); body.scrollTop = 0; main.scrollTop = 0;
            promptName.focus?.({ preventScroll: true });
        });
    }
    async function savePrompt() {
        if (!promptDraft || isBlocked() || savingPrompt) return;
        if (!promptNameInput.value.trim()) {
            statusMessage.textContent = '请填写条目名称。'; statusMessage.classList.add('pw-error'); promptNameInput.focus(); return;
        }
        const isNew = creatingPrompt;
        savingPrompt = true; renderEditorControls();
        const payload = draftValues();
        const result = await act(isNew ? 'createPrompt' : 'editPrompt', isNew ? payload : { id: selectedPrompt, ...payload });
        savingPrompt = false;
        if (result !== false) {
            if (isNew && result?.id) {
                selectedPrompt = result.id;
                if (promptListReturn) promptListReturn.id = result.id;
            }
            if (!isNew || result?.id) {
                creatingPrompt = false; dirtyPrompt = false; promptDraft = null;
                leaveNotice.hidden = true; pendingLeave = null;
                statusMessage.textContent = '条目已保存。';
                statusMessage.classList.remove('pw-error');
            }
        }
        render();
    }
    function duplicatePrompt(id) {
        if (!id || isBlocked() || savingPrompt || groupSaving || groupRange) return;
        const prompt = getState().preset?.prompts?.find(item => item.identifier === id);
        if (prompt?.marker) { statusMessage.textContent = '上下文占位由酒馆提供，不能复制。'; return; }
        withUnsavedGuard(async () => {
            const result = await act('duplicatePrompt', { id });
            if (result?.id) { resetEditor(); openPrompt(result.id); }
        });
    }
    function movePrompt(id, beforeId) {
        if (isBlocked() || savingPrompt || groupSaving || groupRange) return;
        const discardDraft = dirtyPrompt;
        withUnsavedGuard(() => {
            if (discardDraft) resetEditor();
            act('movePrompt', { id, beforeId });
        });
    }
    function requestDeletePrompt(id) {
        if (isBlocked() || savingPrompt || groupSaving || groupRange) return;
        withUnsavedGuard(() => {
            resetEditor(); selectedPrompt = id; activeTab = 'presets'; render();
            promptDelete.click();
        });
    }
    function tokenDisplay(prompt, enabled, state) {
        if (!enabled) return { label: '0', title: '已关闭 · 0 tokens' };
        const entry = state.promptInspection?.entries?.find(item => item.id === prompt.identifier);
        if (!state.inspectionStale && entry && Number.isFinite(entry.tokens)) return { label: `≈${entry.tokens.toLocaleString()}`, title: `本轮展开估算 · ${entry.tokens} tokens` };
        if (!prompt.marker) {
            const count = estimatePromptText({ role: prompt.role || 'system', content: prompt.content || '' });
            return { label: `≈${count.toLocaleString()}`, title: `模板估算，变量尚未展开 · ${count} tokens` };
        }
        return entry && Number.isFinite(entry.tokens) ? { label: `旧 ${entry.tokens.toLocaleString()}`, title: '旧数据，重新读取后更新' } : { label: '—', title: '未读取本轮资料' };
    }
    function renderEditorControls() {
        const state = getState();
        const blocked = isBlocked(state) || savingPrompt;
        promptNameInput.disabled = blocked;
        promptGroup.disabled = blocked;
        promptText.readOnly = Boolean(promptDraft?.marker);
        promptText.disabled = blocked;
        promptRole.disabled = blocked || Boolean(promptDraft?.marker);
        promptSave.disabled = blocked || !dirtyPrompt;
        promptSave.querySelector('span').textContent = savingPrompt ? '处理中…' : '保存条目';
        promptDelete.hidden = creatingPrompt;
        promptDelete.disabled = blocked || !selectedPrompt;
        promptCopy.hidden = creatingPrompt;
        promptCopy.disabled = blocked || !selectedPrompt || Boolean(promptDraft?.marker);
        promptCopy.title = promptDraft?.marker ? '上下文占位由酒馆提供，不能复制' : '复制已保存的条目';
        const editTokens = promptDraft?.marker ? '—' : `≈${estimatePromptText({ role: promptRole.value, content: promptText.value }).toLocaleString()}`;
        promptTokenCount.textContent = `${editTokens} tokens`;
        promptTokenCount.title = promptDraft?.marker ? '读取本轮资料后查看展开用量' : '模板估算，变量尚未展开';
        confirmDelete.disabled = blocked;
        cancelDelete.disabled = blocked;
        promptBack.disabled = savingPrompt;
        const group = state.preset?.groups?.find(g => g.id === promptGroup.value);
        const notes = [];
        if (promptDraft?.marker) notes.push('上下文占位：正文和消息角色由酒馆提供，可修改名称与分组。');
        if (group?.enabled === false) notes.push('此分组已关闭，条目暂不参与请求；开启分组后按条目开关生效。');
        if (dirtyPrompt) notes.push('有未保存的修改。');
        promptInfo.textContent = notes.join(' ');
        promptInfo.hidden = !notes.length;
        renderPresetSaveStatus();
    }
    function renderPresetSaveStatus() {
        presetSaveStatus.textContent = dirtyPrompt ? '条目修改未保存，请先保存条目。' : groupDraftDirty() ? '分组修改尚未保存。' : presetNameDirty ? '预设名称尚未保存。' : '当前预设已保存。';
    }
    function renderPreset(state) {
        const preset = state.preset || { prompts: [], groups: [], order: [] };
        if (seenPresetId !== state.activePresetId) {
            seenPresetId = state.activePresetId; presetNameDirty = false; presetDeleteNotice.hidden = true; presetUnsaved.hidden = true;
            promptListReturn = null;
            reviewGroupOpen.clear(); importReviewFilter = 'pending';
            delete importReviewItems.dataset.signature;
            importReviewItems.replaceChildren();
            clearGroupFlow();
            if (activeTab === 'presets') body.scrollTop = 0;
        }
        if (!presetNameDirty) setInputValue(presetNameInput, preset.name || '');
        undoNotice.hidden = !state.undoDeletion;
        undoText.textContent = state.undoDeletion ? `已删除「${state.undoDeletion.name || '条目'}」` : '';
        const signature = JSON.stringify([state.activePresetId, (state.presetLibrary || []).map(p => [p.id, p.name]), preset.name, preset.prompts, preset.groups, preset.order, preset.promptGroups, state.inspectionStale, groupManage?.id, groupManage?.mode,
            (state.promptInspection?.entries || []).map(entry => [entry.id, entry.tokens, entry.status, entry.order, entry.enabled])]);
        if (signature !== presetSignature) {
            presetSignature = signature;
            const library = state.presetLibrary?.length ? state.presetLibrary : [{ id: 'current', name: preset.name || '第三人称 · 轻度抢话' }];
            presetSelect.replaceChildren(...library.map(p => { const option = el('option', '', p.name); option.value = p.id; return option; }));
            presetSelect.value = state.activePresetId || 'current';
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
            const preferredGroup = groups[0]?.id;
            for (const group of groups) {
                const prompts = promptList.filter(p => group.id === '__ungrouped' ? !groups.some(g => g.id !== '__ungrouped' && g.id === groupFor(p.identifier)) : groupFor(p.identifier) === group.id);
                const details = el('details', 'pw-group');
                details.dataset.groupId = group.id;
                details.open = groupOpen.has(group.id) ? groupOpen.get(group.id) : group.id === preferredGroup;
                details.addEventListener('toggle', () => groupOpen.set(group.id, details.open));
                const summary = el('summary', 'pw-group-summary');
                const nameWrap = el('span', 'pw-group-name'); nameWrap.append(icon('chevron'), el('span', '', group.name.replace(/^\d+\s*/, '')));
                const enabledCount = prompts.filter(prompt => enabledMap.get(prompt.identifier) === true).length;
                const count = el('span', 'pw-group-count', `${group.enabled === false ? 0 : enabledCount} / ${prompts.length}`);
                count.title = '本组启用条目 / 全部条目';
                summary.append(nameWrap, count);
                if (group.id !== '__ungrouped') {
                    const toggle = makeSwitch(`启用分组：${group.name}`, group.enabled !== false, enabled => act('groupToggle', { id: group.id, enabled }));
                    toggle.addEventListener('click', event => event.stopPropagation());
                    summary.append(toggle);
                    const manage = button('', () => openGroupManagement(group.id), { className: 'pw-group-more', iconName: 'more', title: `管理分组：${group.name}` });
                    manage.setAttribute('aria-label', `管理分组：${group.name}`);
                    manage.setAttribute('aria-expanded', String(groupManage?.id === group.id));
                    manage.addEventListener('click', event => event.stopPropagation());
                    summary.append(manage);
                }
                const management = el('div', 'pw-group-manage'); management.hidden = groupManage?.id !== group.id;
                if (!management.hidden) {
                    const actions = el('div', 'pw-group-manage-actions');
                    const dismiss = () => { groupManage = null; pendingGroupLeave = null; groupLeaveNotice.hidden = true; presetSignature = ''; render(); focusGroup(group.id); };
                    if (groupManage.mode === 'rename') {
                        const name = control('text', '分组名称'); name.value = groupManage.name; name.maxLength = 200; name.setAttribute('aria-label', '分组新名称');
                        name.addEventListener('input', () => { if (groupManage?.id === group.id) groupManage.name = name.value; renderPresetSaveStatus(); });
                        management.append(field('分组名称', name));
                        actions.append(button('保存分组名称', () => saveGroupManagement('renamePromptGroup'), { className: 'pw-primary' }), button('取消改名', dismiss));
                    } else if (groupManage.mode === 'dissolve') {
                        management.append(el('p', 'pw-hint', '解散后条目回到未分组，内容和发送顺序保留，已关闭的条目保持关闭。'));
                        actions.append(button('确认解散分组', () => saveGroupManagement('dissolvePromptGroup'), { className: 'pw-danger' }), button('取消解散', dismiss));
                    } else actions.append(button('改名', () => openGroupManagement(group.id, 'rename')), button('解散分组', () => openGroupManagement(group.id, 'dissolve')), button('收起', dismiss));
                    management.append(actions);
                }
                const items = el('div', 'pw-group-items');
                items.classList.toggle('pw-group-off', group.enabled === false);
                for (const [promptIndex, prompt] of prompts.entries()) {
                    const row = el('div', 'pw-prompt-row');
                    row.dataset.promptId = prompt.identifier;
                    row.dataset.groupId = group.id;
                    const label = prompt.name?.split('｜').slice(1).join('｜') || prompt.name || prompt.identifier;
                    const edit = button(label, () => openPrompt(prompt.identifier), { className: 'pw-prompt-name', title: `编辑：${label}` });
                    const entry = state.promptInspection?.entries?.find(item => item.id === prompt.identifier);
                    const enabled = group.enabled !== false && enabledMap.has(prompt.identifier) && enabledMap.get(prompt.identifier) !== false;
                    const position = orderedIds.indexOf(prompt.identifier);
                    const orderText = entry?.enabled && Number.isInteger(entry.order) ? `发送 #${entry.order}` : position < 0 ? '未加入顺序' : `预设 #${position + 1}`;
                    const tokens = tokenDisplay(prompt, enabled, state);
                    const token = el('span', 'pw-row-token', tokens.label); token.title = tokens.title; token.setAttribute('aria-label', tokens.title);
                    edit.setAttribute('aria-label', `编辑：${label}`);
                    edit.setAttribute('aria-description', `${orderText} · ${tokens.title}`);
                    if (prompt.marker) edit.title = `上下文占位：${label}`;
                    const toggle = makeSwitch(`启用条目：${label}`, enabledMap.has(prompt.identifier) ? enabledMap.get(prompt.identifier) !== false : false, enabled => act('promptToggle', { identifier: prompt.identifier, enabled }));
                    const handle = button('', () => {}, { className: 'pw-drag-handle', iconName: 'drag', title: `拖动排序：${label}` });
                    handle.setAttribute('aria-label', `拖动排序：${label}`);
                    const more = button('', () => {
                        const opening = menu.hidden;
                        for (const other of presetGroups.querySelectorAll('.pw-row-menu')) other.hidden = true;
                        for (const other of presetGroups.querySelectorAll('.pw-row-more')) other.setAttribute('aria-expanded', 'false');
                        menu.hidden = !opening; more.setAttribute('aria-expanded', String(opening));
                    }, { className: 'pw-row-more', iconName: 'more', title: `更多操作：${label}` });
                    more.setAttribute('aria-label', `更多操作：${label}`); more.setAttribute('aria-expanded', 'false');
                    const menu = el('div', 'pw-row-menu'); menu.hidden = true;
                    function move(direction) {
                        if (isBlocked()) return;
                        const beforeId = direction < 0 ? prompts[promptIndex - 1]?.identifier : prompts[promptIndex + 2]?.identifier || null;
                        movePrompt(prompt.identifier, beforeId);
                    }
                    const up = button('上移', () => move(-1), { iconName: 'up' }); up.dataset.disabled = String(promptIndex === 0);
                    const down = button('下移', () => move(1), { iconName: 'down' }); down.dataset.disabled = String(promptIndex === prompts.length - 1);
                    const copy = button('复制', () => duplicatePrompt(prompt.identifier), { iconName: 'copy' }); copy.dataset.disabled = String(Boolean(prompt.marker)); copy.title = prompt.marker ? '上下文占位不能复制' : '创建副本';
                    menu.append(button('创建分组', () => beginGroupRange(prompt.identifier), { iconName: 'add' }), button('编辑', () => openPrompt(prompt.identifier), { iconName: 'edit' }), up, down, copy, button('删除', () => requestDeletePrompt(prompt.identifier), { iconName: 'trash', className: 'pw-danger' }));
                    row.classList.toggle('pw-row-inactive', !enabled);
                    row.append(handle, edit, token, toggle, more, menu); items.append(row);
                }
                items.append(button('在此分组新增', () => newPrompt(group.id === '__ungrouped' ? '' : group.id), { iconName: 'add', className: 'pw-group-add' }));
                details.append(summary, management, items, frameOrnaments()); presetGroups.append(details);
            }
            presetWarnings.textContent = (preset.warnings || []).join(' ');
            presetWarnings.hidden = !presetWarnings.textContent;
        }
        if (selectedPrompt || creatingPrompt) {
            const prompt = preset.prompts?.find(p => p.identifier === selectedPrompt);
            if (!creatingPrompt && !prompt) { resetEditor(); return; }
            if (!promptDraft && prompt) {
                const mapping = preset.promptGroups?.[selectedPrompt];
                loadPromptDraft(prompt, typeof mapping === 'string' ? mapping : mapping?.groupId || '');
            }
            promptName.textContent = creatingPrompt ? '新增条目' : '编辑条目';
            const groupValue = promptDraft?.groupId || '';
            const groupOptions = [['', '未分组'], ...(preset.groups || []).map(g => [g.id, `${g.name}${g.enabled === false ? '（已关闭）' : ''}`])];
            const nextGroupSignature = JSON.stringify(groupOptions);
            if (promptGroup.dataset.signature !== nextGroupSignature) {
                promptGroup.replaceChildren(...groupOptions.map(([value, name]) => { const option = el('option', '', name); option.value = value; return option; }));
                promptGroup.dataset.signature = nextGroupSignature;
            }
            setInputValue(promptNameInput, promptDraft?.name);
            setInputValue(promptText, promptDraft?.content);
            setInputValue(promptRole, promptDraft?.role || 'system');
            setInputValue(promptGroup, groupValue);
            renderEditorControls();
        }
    }
    function inspectionStatus(value) {
        const labels = { read: '已读取', ready: '已读取', resolved: '已读取', included: '已读取', sent: '已展开', empty: '空', unread: '未读取', missing: '未读取', stale: '旧数据', disabled: '已关闭', skipped: '未使用' };
        return labels[value] || String(value || '未读取');
    }
    function renderHostCatalog(state) {
        const catalog = state.hostCatalog || {};
        const hostPresets = Array.isArray(catalog.presets) ? catalog.presets : [];
        const presetsSignature = JSON.stringify(hostPresets);
        if (hostPresetSelect.dataset.signature !== presetsSignature) {
            const selected = hostPresetSelect.value;
            const empty = el('option', '', hostPresets.length ? '选择酒馆预设' : '请先刷新酒馆目录'); empty.value = '';
            hostPresetSelect.replaceChildren(empty, ...hostPresets.map(preset => { const option = el('option', '', preset.name); option.value = preset.id; return option; }));
            hostPresetSelect.value = hostPresets.some(preset => preset.id === selected) ? selected : '';
            hostPresetSelect.dataset.signature = presetsSignature;
        }
        const books = Array.isArray(catalog.worldbooks) ? catalog.worldbooks : [];
        const selected = Array.isArray(state.extraWorldbooks) ? state.extraWorldbooks : [];
        const selectedNames = new Set(selected);
        const mounted = books.filter(book => book.mounted);
        const mountedNames = new Set(mounted.map(book => book.name));
        // Existing extra selections remain removable if the host later mounts the same book.
        const available = books.filter(book => !mountedNames.has(book.name) || selectedNames.has(book.name));
        for (const name of selected) if (!books.some(book => book.name === name)) available.push({ name, unavailable: true });
        const query = worldbookSearch.value.trim().toLocaleLowerCase();
        const filtered = available.filter(book => (!query || book.name.toLocaleLowerCase().includes(query)) && (worldbookFilter.value !== 'selected' || selectedNames.has(book.name)));
        const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
        worldbookPage = Math.max(1, Math.min(worldbookPage, pageCount));
        const visible = filtered.slice((worldbookPage - 1) * 20, worldbookPage * 20);
        const booksSignature = JSON.stringify([books, selected, query, worldbookFilter.value, worldbookPage]);
        if (extraBooks.dataset.signature !== booksSignature) {
            const sourceNames = { global: '全局', character: '角色', extra: '角色附加', persona: '用户人格', chat: '当前聊天' };
            worldbooksMounted.replaceChildren(...(mounted.length ? mounted.map(book => {
                const row = el('div', 'pw-mounted-book');
                const sources = Array.isArray(book.sources) ? book.sources.map(source => sourceNames[source] || source).join('、') : '';
                const name = el('span', 'pw-worldbook-name', book.name); name.title = book.name;
                row.append(name);
                if (sources) row.append(el('span', 'pw-worldbook-source', sources));
                row.title = `${book.name}${sources ? ` · ${sources}` : ''}`;
                return row;
            }) : [el('p', 'pw-hint', '当前没有挂载世界书。')]));
            extraBooks.replaceChildren(...(visible.length ? visible.map(book => {
                const label = el('label', 'pw-book-checkbox');
                label.dataset.worldbookName = book.name; label.title = book.name;
                const checkbox = control('checkbox'); checkbox.checked = selectedNames.has(book.name);
                checkbox.disabled = isBlocked(state);
                checkbox.setAttribute('aria-label', `额外世界书：${book.name}`);
                checkbox.addEventListener('change', async () => {
                    if (isBlocked()) return;
                    const names = new Set(getState().extraWorldbooks || []);
                    if (checkbox.checked) names.add(book.name); else names.delete(book.name);
                    await act('extraWorldbooks', { names: [...names] });
                    checkbox.checked = (getState().extraWorldbooks || []).includes(book.name);
                });
                decorateCheckbox(label, checkbox, el('span', 'pw-worldbook-name', book.name), false);
                if (book.unavailable || mountedNames.has(book.name)) label.append(el('span', 'pw-worldbook-label', book.unavailable ? '未找到' : '已挂载'));
                return label;
            }) : [el('p', 'pw-hint', query ? '没有匹配的世界书。' : worldbookFilter.value === 'selected' ? '尚未选择额外世界书。' : '刷新目录后可选择额外世界书。')]));
            extraBooks.dataset.signature = booksSignature;
        }
        mountedSummary.textContent = `当前挂载 · ${mounted.length}`;
        const selectedCount = selected.length;
        worldbookResultCount.textContent = `${filtered.length} 项结果 · 已选 ${selectedCount}`;
        worldbookPageNumber.textContent = `${worldbookPage} / ${pageCount}`;
        previousWorldbookPage.disabled = isBlocked(state) || worldbookPage <= 1;
        nextWorldbookPage.disabled = isBlocked(state) || worldbookPage >= pageCount;
        clearWorldbookSearch.disabled = isBlocked(state) || !worldbookSearch.value;
        previousWorldbookPage.dataset.disabled = String(worldbookPage <= 1);
        nextWorldbookPage.dataset.disabled = String(worldbookPage >= pageCount);
        clearWorldbookSearch.dataset.disabled = String(!worldbookSearch.value);
        worldbookPagination.hidden = filtered.length <= 20;
        const status = state.libraryBusy ? '正在读取酒馆目录…' : typeof state.libraryStatus === 'string' ? state.libraryStatus : state.libraryStatus?.message || '';
        hostPresetStatus.textContent = status; worldbookStatus.textContent = status;
        hostPresetStatus.hidden = !status; worldbookStatus.hidden = !status;
    }
    function renderImportReview(state) {
        const review = state.importReview || {};
        const items = review.items || [];
        const pendingCount = items.filter(item => item.needsReview).length;
        importReviewCount.textContent = `${pendingCount} 项待检查`;
        for (const [value, node] of reviewFilterButtons) node.setAttribute('aria-pressed', String(value === importReviewFilter));
        importReviewMessage.textContent = review.message || '';
        importReviewMessage.hidden = !importReviewMessage.textContent;
        const adjusted = review.autoDisabledCount || 0;
        importAdjustment.hidden = !adjusted;
        importAdjustmentStatus.textContent = `自动关闭 ${adjusted} 项 · 当前仍关闭 ${review.restorableCount || 0} 项`;
        restoreImportButton.dataset.disabled = String(!review.restorableCount);
        restoreImportButton.disabled = isBlocked(state) || !review.restorableCount;
        const groups = review.groups || [];
        const signature = JSON.stringify([state.activePresetId, importReviewFilter, groups]);
        if (importReviewItems.dataset.signature === signature) return;
        const scrollTop = body.scrollTop, mainTop = main.scrollTop;
        for (const group of importReviewItems.querySelectorAll('.pw-review-group')) reviewGroupOpen.set(group.dataset.groupId, group.open);
        importReviewItems.dataset.signature = signature;
        const visibleGroups = groups.map(group => ({ ...group, visibleItems: group.items.filter(item => importReviewFilter === 'all' || item.needsReview) })).filter(group => group.visibleItems.length);
        const labels = { review: '待检查', disabled: '已关闭', format: '格式', info: '依赖', normal: '可用' };
        const nodes = visibleGroups.map((group, index) => {
            const details = el('details', 'pw-review-group'); details.dataset.groupId = group.id;
            details.open = reviewGroupOpen.has(group.id) ? reviewGroupOpen.get(group.id) : index === 0;
            details.addEventListener('toggle', () => { if (details.isConnected) reviewGroupOpen.set(group.id, details.open); });
            const summary = el('summary', 'pw-review-group-summary');
            const name = el('span', 'pw-review-group-name'); name.append(icon('chevron'), el('span', '', group.name));
            const pending = group.items.filter(item => item.needsReview).length;
            const count = el('span', 'pw-review-group-count', importReviewFilter === 'pending' ? `${pending} 项` : `${pending ? `${pending} 待检查 · ` : ''}${group.items.length} 项`);
            summary.append(name, count); details.append(summary);
            for (const item of group.visibleItems) {
                const row = el('div', 'pw-import-review-item'); row.dataset.promptId = item.id; row.dataset.status = item.status;
                const heading = el('div', 'pw-review-item-heading');
                const edit = button(item.name || item.id, () => openPrompt(item.id, 'review'), { iconName: 'edit', className: 'pw-review-edit' });
                const status = el('span', 'pw-review-item-status', item.kind === 'context' ? '上下文' : labels[item.status] || '可用');
                heading.append(edit, status); row.append(heading);
                if (item.reason) row.append(el('p', 'pw-hint', item.reason));
                details.append(row);
            }
            return details;
        });
        importReviewItems.replaceChildren(...(nodes.length ? nodes : [el('p', 'pw-review-empty', importReviewFilter === 'pending' ? '当前没有待检查条目。可切换“全部”查看预设。' : '当前没有检查条目。')]));
        body.scrollTop = scrollTop; main.scrollTop = mainTop;
    }
    function renderUpdate(state) {
        const update = state.update || {};
        const labels = { unchecked: '尚未检查', checking: '正在检查更新', available: '发现新版本', installing: '正在安装更新', installed: '已安装，刷新后生效', current: '当前为最新版本', error: '更新操作失败', unsupported: '当前安装方式不支持更新', deferred: '等待空闲时更新' };
        updateVersion.textContent = update.currentVersion ? `当前版本：${update.currentVersion}` : ''; updateVersion.hidden = !update.currentVersion;
        updatePhase.textContent = labels[update.phase || 'unchecked'] || update.phase;
        updateMessage.textContent = update.message || ''; updateMessage.hidden = !update.message || update.message === updatePhase.textContent;
        const checkedDate = new Date(update.checkedAt);
        updateCheckedAt.textContent = update.checkedAt && Number.isFinite(checkedDate.getTime()) ? `上次检查：${checkedDate.toLocaleString()}` : ''; updateCheckedAt.hidden = !updateCheckedAt.textContent;
        updateAutoCheck.checked = update.autoCheck !== false; updateAutoInstall.checked = update.autoInstall === true;
        checkUpdateButton.disabled = isBlocked(state) || update.phase === 'checking';
        installUpdateButton.disabled = isBlocked(state) || update.phase === 'checking' || !update.available || update.phase === 'installed';
        reloadUpdateButton.hidden = update.phase !== 'installed'; reloadUpdateButton.disabled = isBlocked(state);
        const available = update.available || update.phase === 'available';
        updateBanner.hidden = !available && update.phase !== 'installed';
        updateBanner.querySelector('span').textContent = update.phase === 'installed' ? '更新已安装 · 查看并刷新生效' : '发现新版本 · 查看更新';
        updateBanner.disabled = update.phase === 'installing';
    }
    function inspectionText(message) {
        if (typeof message === 'string') return message;
        const content = message?.content ?? message?.text ?? '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
        return '';
    }
    function renderInspection(state) {
        const inspection = state.promptInspection;
        const signature = JSON.stringify([inspection, state.inspectionStale]);
        if (inspectionEntries.dataset.signature === signature) return;
        inspectionEntries.dataset.signature = signature;
        const total = inspection?.totalTokens;
        inspectionTotal.textContent = inspection ? `${state.inspectionStale ? '旧数据 · ' : ''}本轮总量约 ${Number.isFinite(total) ? total.toLocaleString() : '—'} tokens${inspection.tokenMethod ? ` · ${inspection.tokenMethod}` : ''}` : '尚未读取本轮资料';
        const sources = Array.isArray(inspection?.sources) ? inspection.sources : ['角色卡', '聊天历史', '世界书', 'Anima'].map(name => ({ name, status: 'unread' }));
        inspectionSources.replaceChildren(...sources.map(source => {
            const row = el('div', 'pw-source-row');
            row.append(el('span', 'pw-source-name', `${source.name || '资料'} · ${inspection && state.inspectionStale ? '旧数据' : inspectionStatus(source.status)}`));
            if (source.detail) row.append(el('p', 'pw-hint', source.detail));
            return row;
        }));
        const entries = Array.isArray(inspection?.entries) ? inspection.entries : [];
        inspectionEntries.replaceChildren(...entries.map(entry => {
            const details = el('details', 'pw-inspection-entry');
            const summary = el('summary');
            const count = entry.enabled === false ? '0' : Number.isFinite(entry.tokens) ? `≈${entry.tokens.toLocaleString()}` : '—';
            const order = entry.enabled === false || entry.order == null ? '未发送' : `发送 #${entry.order}`;
            summary.append(el('span', 'pw-inspection-entry-name', `${order} · ${entry.name || entry.id || '条目'}`),
                el('span', 'pw-inspection-entry-meta', `${count} tokens · ${state.inspectionStale ? '旧数据' : inspectionStatus(entry.status)}`));
            details.append(summary);
            const messages = Array.isArray(entry.messages) ? entry.messages : entry.messages ? [entry.messages] : [];
            if (!messages.length) details.append(el('p', 'pw-hint', entry.enabled === false ? '此条目没有发送。' : '没有可展开的文本。'));
            for (const message of messages) {
                const block = el('div', 'pw-inspection-message');
                if (message?.role) block.append(el('span', 'pw-inspection-role', message.role));
                block.append(el('pre', 'pw-inspection-text', inspectionText(message)));
                details.append(block);
            }
            return details;
        }));
    }
    function renderApiProfiles(state) {
        const profiles = state.apiProfiles || [];
        const signature = JSON.stringify(profiles.map(p => [p.id, p.name]));
        if (apiProfileSelect.dataset.signature !== signature) {
            apiProfileSelect.replaceChildren(...(profiles.length ? profiles : [{ id: '', name: '尚无 API 方案' }]).map(profile => {
                const option = el('option', '', profile.name); option.value = profile.id; return option;
            }));
            apiProfileSelect.dataset.signature = signature;
        }
        apiProfileSelect.value = state.activeApiProfileId || '';
        if (seenApiProfileId !== state.activeApiProfileId || seenApiProfileId === undefined) {
            for (const key of ['baseUrl', 'model', 'temperature', 'maxTokens', 'stream']) configDrafts.delete(key);
            keyDraftDirty = false;
            seenApiProfileId = state.activeApiProfileId || '';
            const profile = profiles.find(p => p.id === state.activeApiProfileId);
            apiProfileName.value = profile?.name || '';
            rememberKey.checked = Boolean(state.rememberApiKey);
            apiKeyBaseline = state.apiKey || ''; rememberBaseline = Boolean(state.rememberApiKey);
            apiUnsavedNotice.hidden = true; apiDeleteNotice.hidden = true; pendingApiChange = null;
        }
        renderModels(state);
        apiStatus.textContent = typeof state.apiStatus === 'string' ? state.apiStatus : state.apiStatus?.message || '';
        apiStatus.hidden = !apiStatus.textContent;
        const logs = Array.isArray(state.logs) ? state.logs : [];
        logsSummary.textContent = `运行日志${logs.length ? ` · ${logs.length}` : ''}`;
        const logsSignature = JSON.stringify(logs.map(log => [log.id, log.timestamp, log.level, log.event, log.message]));
        if (logList.dataset.signature !== logsSignature) {
            logList.replaceChildren(...(logs.length ? logs.slice(-100).map(log => {
                const row = el('div', `pw-log-entry${log.level === 'error' ? ' pw-log-error' : ''}`);
                row.append(el('span', 'pw-log-meta', `${String(log.timestamp || '').slice(0, 30)} · ${String(log.level || 'info')} · ${String(log.event || '')}`), el('span', '', String(log.message || '').slice(0, 800)));
                return row;
            }) : [el('p', 'pw-hint', '本页尚无运行日志。')]));
            logList.dataset.signature = logsSignature;
        }
    }
    function renderModels(state) {
        const models = (Array.isArray(state.models) ? state.models.filter(model => typeof model === 'string') : [])
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const sourceSignature = JSON.stringify([state.activeApiProfileId, models]);
        if (modelsSelect.dataset.sourceSignature !== sourceSignature) {
            modelsSelect.dataset.sourceSignature = sourceSignature;
            modelSearch.value = '';
        }
        const query = modelSearch.value.trim().toLocaleLowerCase();
        const filtered = models.filter(model => !query || model.toLocaleLowerCase().includes(query));
        const signature = JSON.stringify(filtered);
        if (modelsSelect.dataset.signature !== signature) {
            const first = el('option', '', filtered.length ? '从接口返回的模型中选择' : '没有匹配的模型'); first.value = '';
            modelsSelect.replaceChildren(first, ...filtered.map(model => { const option = el('option', '', model); option.value = model; return option; }));
            modelsSelect.dataset.signature = signature;
        }
        modelsSelect.value = filtered.includes(modelInput.value) ? modelInput.value : '';
        modelSearch.hidden = !models.length;
        modelsSelect.hidden = !models.length;
        modelSearchStatus.hidden = !models.length || filtered.length > 0;
        modelSearchStatus.textContent = modelSearchStatus.hidden ? '' : '无匹配模型，可手动填写。';
    }
    function renderPlan(state) {
        const failure = state.planningFailure;
        failedResponse.hidden = !failure;
        failedResponseMeta.textContent = failure ? `错误：${failure.code} · 结束原因：${failure.finishReason}${failure.truncated ? ' · 长文本仅保留前后片段' : ''}` : '';
        failedResponseText.textContent = failure?.content || '未返回文本。';
        failedReasoningText.textContent = failure?.reasoning || '';
        failedReasoningTitle.hidden = failedReasoningText.hidden = !failure?.reasoning;
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
                for (const [index, segment] of (plan.segments || []).entries()) block(`事件 ${segment.index || index + 1}`, typeof segment === 'string' ? segment : segment.text || segment.content, 'pw-segment');
                block('本轮结束状态', plan.endState || plan.end_state, 'pw-end-state');
            }
        }
        const analysis = state.planningAnalysis;
        const nextAnalysisSignature = JSON.stringify([analysis || null, Boolean(state.plan)]);
        if (analysisSignature !== nextAnalysisSignature) {
            analysisSignature = nextAnalysisSignature;
            planAnalysis.replaceChildren();
            const reasoning = typeof analysis?.reasoning === 'string' ? analysis.reasoning : '';
            const supplement = typeof analysis?.supplement === 'string' ? analysis.supplement : '';
            if (reasoning || supplement) {
                planAnalysis.append(el('p', 'pw-hint', '仅供查看，不注入正文请求。'));
                if (analysis.edited) planAnalysis.append(el('p', 'pw-hint pw-analysis-notice', '对应生成时的大纲；当前大纲已手动修改。'));
                if (analysis.truncated) planAnalysis.append(el('p', 'pw-hint pw-analysis-notice', '返回的分析较长，此处仅保留部分文本。'));
                for (const [title, text] of [['接口分析', reasoning], ['附加返回', supplement]]) {
                    if (!text) continue;
                    const section = el('section', 'pw-analysis-block');
                    section.append(el('h4', '', title), el('pre', 'pw-analysis-text', text));
                    planAnalysis.append(section);
                }
            } else planAnalysis.append(el('p', 'pw-hint', analysis ? '本次未返回分析文本。' : state.plan ? '本页未保留这份大纲的分析文本。' : '先生成本轮大纲，再查看接口返回的分析文本。'));
        }
        planReading.hidden = planView !== 'read';
        planEditing.hidden = planView !== 'edit';
        planAnalysis.hidden = planView !== 'analysis';
        for (const [key, node] of planTabEntries) {
            node.classList.toggle('pw-selected', planView === key);
            node.setAttribute('aria-selected', String(planView === key));
            node.tabIndex = planView === key ? 0 : -1;
        }
        renderPlanActions();
    }
    function renderPlanActions() {
        const state = getState();
        const noPlan = !state.plan;
        const processing = Boolean((state.busy && !state.awaitingReview) || state.apiBusy || state.animaChecking || state.libraryBusy || state.update?.phase === 'installing');
        rerollButton.hidden = noPlan;
        rerollButton.disabled = state.settings?.enabled === false || noPlan || isBlocked(state) || dirtyPlan;
        rerollButton.title = dirtyPlan ? '请先应用大纲修改' : '';
        copyButton.disabled = noPlan || processing || dirtyPlan;
        fillButton.disabled = noPlan || processing || dirtyPlan;
        writeButton.disabled = state.settings?.enabled === false || noPlan || processing || dirtyPlan;
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
        const enabled = settings.enabled !== false;
        enableButton.setAttribute('aria-checked', String(enabled));
        enableButton.querySelector('span').textContent = enabled ? '已启用' : '已关闭';
        enableButton.title = isBlocked(state) ? '请先完成或取消当前操作' : enabled ? '关闭 Vespera，立即保存' : '启用 Vespera，立即保存';
        enableButton.disabled = isBlocked(state);
        renderAppearance();
        renderApiProfiles(state);
        setInputValue(input, state.input);
        if (!keyDraftDirty) setInputValue(keyField, state.apiKey);
        for (const [key, node] of Object.entries(settingsFields)) if (!configDrafts.has(key)) {
            if (node.type === 'checkbox') node.checked = Boolean(settings[key]);
            else setInputValue(node, settings[key]);
        }
        if (!configDrafts.has('storyPace')) storyPace.value = Object.hasOwn(STORY_PACES, settings.storyPace) ? settings.storyPace : 'preset';
        renderStoryPaceHint();
        if (!configDrafts.has('relationshipPace')) relationshipPace.value = Object.hasOwn(RELATIONSHIP_PACES, settings.relationshipPace) ? settings.relationshipPace : 'preset';
        renderRelationshipPaceHint();
        if (!configDrafts.has('mode')) modeSelect.value = settings.mode || 'review';
        if (!configDrafts.has('autoOnSend')) autoOnSend.checked = Boolean(settings.autoOnSend);
        modeHint.textContent = settings.mode === 'auto' ? '大纲通过格式检查后直接交给主模型。' : settings.mode === 'manual' ? '只生成大纲，不自动注入主请求。' : '大纲生成后暂停，确认后再交给主模型。';
        generateButton.disabled = !enabled || isBlocked(state);
        generateButton.querySelector('span').textContent = state.busy ? '正在处理…' : state.animaChecking ? '检测记忆扩展…' : state.preview ? '载入示例大纲' : '生成大纲';
        cancelButton.disabled = !state.busy;
        input.disabled = isBlocked(state);
        footerStatus.textContent = typeof state.status === 'string' ? state.status : state.status?.message || '准备就绪';
        footerDot.classList.toggle('pw-busy', Boolean(state.busy));
        animaStatus.textContent = typeof state.animaStatus === 'string' ? state.animaStatus : state.animaStatus?.message || '尚未检测';
        detectedPath.textContent = state.animaDetectedPath ? `检测到：${state.animaDetectedPath}` : '';
        detectedPath.hidden = !state.animaDetectedPath;
        const stage = state.stage || (state.busy ? 'planning' : state.plan ? 'review' : 'idle');
        const stages = { idle: -1, memory: 0, recalling: 0, planning: 1, generating: 1, review: 2, ready: 2, writing: 3, complete: 3 };
        const step = stages[stage] ?? -1;
        stepNodes.forEach((node, index) => { node.classList.toggle('pw-step-active', index === step); node.classList.toggle('pw-step-done', index < step); });
        renderPreset(state);
        renderInspection(state);
        renderHostCatalog(state);
        renderImportReview(state);
        for (const node of presets.querySelectorAll('button,input,select,textarea')) node.disabled = isBlocked(state) || savingPrompt || groupSaving || node.dataset.disabled === 'true';
        inspectButton.disabled = !enabled || isBlocked(state);
        for (const node of [...configPanel.querySelectorAll('button,input,select,textarea'), ...settingsPanel.querySelectorAll('button,input,select,textarea')]) node.disabled = isBlocked(state);
        for (const node of worldbooksPage.querySelectorAll('button,input,select,textarea')) node.disabled = isBlocked(state) || node.dataset.disabled === 'true';
        apiProfileDeleteButton.disabled = isBlocked(state) || (state.apiProfiles?.length || 0) <= 1;
        presetDeleteButton.disabled = isBlocked(state) || (state.presetLibrary?.length || 0) <= 1;
        hostPresetImport.disabled = isBlocked(state) || !hostPresetSelect.value;
        animaDetect.disabled = isBlocked(state);
        animaDetect.querySelector('span').textContent = state.animaChecking ? '检测中…' : '重新检测';
        injectionDepth.closest('label').hidden = injectionPosition.value !== 'in_chat';
        renderEditorControls();
        renderUpdate(state);
        renderPlan(state);
        workshopTools.render();
        renderTabs();
        renderGroupTools(state);
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
        withUnsavedGuard(() => { resetEditor(); dialog.close(); });
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
    function beforeUnload(event) {
        if (!hasUnsavedChanges()) return;
        event.preventDefault(); event.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    const hostThemeObserver = typeof MutationObserver === 'function' ? new MutationObserver(syncHostSurface) : null;
    for (const node of [document.documentElement, document.body]) hostThemeObserver?.observe(node, { attributes: true, attributeFilter: ['class', 'style'] });
    function destroy() {
        if (dialog.open) dialog.close();
        afterClose();
        destroyed = true;
        hostThemeObserver?.disconnect();
        workshopTools.destroy();
        reordering.destroy();
        dialog.remove();
        window.visualViewport?.removeEventListener('resize', onViewport);
        window.visualViewport?.removeEventListener('scroll', onViewport);
        window.removeEventListener('resize', onViewport);
        window.removeEventListener('beforeunload', beforeUnload);
    }
    render();
    return { open, close, render, destroy, isOpen: () => dialog.open, hasUnsavedChanges };
}
/**
 * Delegated, handle-only Pointer Events reordering. This helper only paints a
 * proposed drop location; the consumer owns persistence and DOM rendering.
 * Keyboard reordering should be provided by the consumer's move controls.
 */
function installPromptReordering(container, { isBlocked = () => false, onMove } = {}) {
    if (!container?.addEventListener || typeof onMove !== 'function') throw new TypeError('A container and onMove callback are required.');
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const handleStyles = new Map();
    let drag = null, painted = null, destroyed = false, suppressClick = null;
    const rows = groupId => [...container.querySelectorAll('.pw-prompt-row')]
        .filter(row => row.hasAttribute('data-prompt-id') && row.getAttribute('data-group-id') === groupId);
    const blocked = () => destroyed || Boolean(isBlocked());
    const inContainer = node => node && container.contains(node);
    const closest = (node, selector) => node?.closest?.(selector) ?? null;

    function clearPaint() {
        painted?.classList.remove('pw-drop-before', 'pw-drop-after');
        painted = null;
    }
    function restoreHandle(handle, previous) {
        if (previous.value) handle.style.setProperty('touch-action', previous.value, previous.priority);
        else handle.style.removeProperty('touch-action');
    }
    function syncHandles() {
        const current = new Set(container.querySelectorAll('.pw-drag-handle'));
        for (const [handle, previous] of handleStyles) {
            if (!current.has(handle)) { restoreHandle(handle, previous); handleStyles.delete(handle); }
        }
        for (const handle of current) {
            if (!handleStyles.has(handle)) {
                handleStyles.set(handle, { value: handle.style.getPropertyValue('touch-action'), priority: handle.style.getPropertyPriority('touch-action') });
                handle.style.setProperty('touch-action', 'none');
            }
        }
        if (drag && (!inContainer(drag.row) || !inContainer(drag.handle))) finish(false);
    }
    function readProposal(x, y) {
        clearPaint();
        if (!drag?.active || blocked() || !inContainer(drag.row)) return null;
        const target = closest(doc.elementFromPoint(x, y), '.pw-prompt-row');
        if (!inContainer(target) || target === drag.row || target.getAttribute('data-group-id') !== drag.groupId) return null;
        const peers = rows(drag.groupId);
        const ids = peers.map(row => row.getAttribute('data-prompt-id'));
        if (new Set(ids).size !== ids.length || !ids.includes(drag.id)) return null;
        const box = target.getBoundingClientRect();
        const before = y < box.top + box.height / 2;
        const remaining = peers.filter(row => row !== drag.row);
        const index = remaining.indexOf(target);
        if (index < 0) return null;
        const beforeId = before ? target.getAttribute('data-prompt-id') : remaining[index + 1]?.getAttribute('data-prompt-id') ?? null;
        const reordered = ids.filter(id => id !== drag.id);
        const insertion = beforeId === null ? reordered.length : reordered.indexOf(beforeId);
        if (insertion < 0) return null;
        reordered.splice(insertion, 0, drag.id);
        if (reordered.every((id, i) => id === ids[i])) return null;
        painted = target;
        painted.classList.add(before ? 'pw-drop-before' : 'pw-drop-after');
        return { id: drag.id, beforeId, groupId: drag.groupId };
    }
    function finish(commit, event) {
        if (!drag) return;
        const current = drag;
        const proposal = commit && current.active && event && !blocked() ? readProposal(event.clientX, event.clientY) : null;
        drag = null;
        clearPaint();
        current.row.classList.remove('pw-dragging');
        doc.removeEventListener('pointermove', onPointerMove);
        doc.removeEventListener('pointerup', onPointerUp);
        doc.removeEventListener('pointercancel', onPointerCancel);
        current.handle.removeEventListener('lostpointercapture', onCaptureLost);
        try { if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId); } catch { /* A detached handle may already have lost capture. */ }
        if (current.active) suppressClick = { handle: current.handle, until: Date.now() + 400 };
        if (proposal) onMove(proposal);
    }
    function onPointerDown(event) {
        if (drag || blocked() || event.isPrimary === false || event.button !== 0) return;
        const handle = closest(event.target, '.pw-drag-handle');
        const row = closest(handle, '.pw-prompt-row');
        if (!inContainer(handle) || !inContainer(row) || handle.disabled || !row.hasAttribute('data-group-id')) return;
        const id = row.getAttribute('data-prompt-id');
        if (!id) return;
        drag = { row, handle, id, groupId: row.getAttribute('data-group-id'), pointerId: event.pointerId,
            startX: event.clientX, startY: event.clientY, active: false };
        // Document listeners are also a fallback when capture is unsupported.
        doc.addEventListener('pointermove', onPointerMove, { passive: false });
        doc.addEventListener('pointerup', onPointerUp);
        doc.addEventListener('pointercancel', onPointerCancel);
        handle.addEventListener('lostpointercapture', onCaptureLost);
        try { handle.setPointerCapture?.(event.pointerId); } catch { /* Document listeners retain the cancellation path. */ }
    }
    function onPointerMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (blocked() || !inContainer(drag.row)) { finish(false); return; }
        if (!drag.active) {
            if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
            drag.active = true;
            drag.row.classList.add('pw-dragging');
        }
        if (event.cancelable) event.preventDefault();
        readProposal(event.clientX, event.clientY);
    }
    function onPointerUp(event) { if (drag && event.pointerId === drag.pointerId) finish(true, event); }
    function onPointerCancel(event) { if (drag && event.pointerId === drag.pointerId) finish(false); }
    function onCaptureLost(event) { if (drag && event.pointerId === drag.pointerId) finish(false); }
    function onClick(event) {
        if (!suppressClick || Date.now() > suppressClick.until) { suppressClick = null; return; }
        if (closest(event.target, '.pw-drag-handle') !== suppressClick.handle) return;
        event.preventDefault(); event.stopImmediatePropagation(); suppressClick = null;
    }
    const observer = typeof win?.MutationObserver === 'function' ? new win.MutationObserver(syncHandles) : null;
    syncHandles();
    observer?.observe(container, { childList: true, subtree: true });
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('click', onClick, true);
    return {
        destroy() {
            if (destroyed) return;
            destroyed = true; finish(false); suppressClick = null;
            observer?.disconnect();
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('click', onClick, true);
            for (const [handle, previous] of handleStyles) restoreHandle(handle, previous);
            handleStyles.clear();
        },
    };
}
