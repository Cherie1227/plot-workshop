import { BACKUP_MAX_BYTES } from './lib/workshop-tools.js';

/** Data-only tools; all generation, recall, persistence and restore decisions belong to the controller. */
export function createWorkshopTools({ getState, onAction }) {
    if (typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('Workshop tools need state and action handlers.');
    let destroyed = false, pending = 0, versionSignature = '', diagnosisSignature = '';
    const listeners = [];
    const mutations = [];
    const node = (tag, className = '', text) => {
        const item = document.createElement(tag);
        item.className = className;
        if (text !== undefined) item.textContent = String(text);
        return item;
    };
    const listen = (item, event, handler) => { item.addEventListener(event, handler); listeners.push(() => item.removeEventListener(event, handler)); };
    const hint = text => node('p', 'pw-hint', text);
    const field = (label, input, description) => {
        const wrap = node('label', 'pw-field');
        wrap.append(node('span', 'pw-label', label), input);
        if (description) wrap.append(node('span', 'pw-hint', description));
        return wrap;
    };
    const section = (parent, title) => {
        const details = node('details', 'pw-advanced');
        details.append(node('summary', '', title)); parent.append(details);
        return details;
    };
    const textarea = (rows, { readonly = false, maxLength } = {}) => {
        const item = node('textarea', 'pw-input'); item.rows = rows; item.readOnly = readonly;
        if (maxLength) item.maxLength = maxLength;
        if (!readonly) mutations.push(item);
        return item;
    };
    const option = (value, label) => { const item = node('option', '', label); item.value = value; return item; };
    const busy = () => { const state = getState(); return !!(state.busy || state.apiBusy || state.animaChecking || state.libraryBusy || state.update?.phase === 'installing' || pending); };
    const outlineElement = node('div', 'pw-tools');
    const settingsElement = node('div', 'pw-tools-settings');
    const notice = hint(''); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const settingsNotice = hint(''); settingsNotice.setAttribute('role', 'status'); settingsNotice.setAttribute('aria-live', 'polite');
    async function dispatch(type, payload = {}, target = notice) {
        if (destroyed || busy()) return;
        target.textContent = ''; pending++; updateDisabled();
        try { return await onAction(type, payload); }
        catch { target.textContent = '操作未完成，请查看当前状态后重试。'; }
        finally { pending--; if (!destroyed) render(); }
    }
    const button = (label, handler, { mutation = true } = {}) => {
        const item = node('button', 'pw-button', label); item.type = 'button';
        listen(item, 'click', handler);
        if (mutation) mutations.push(item);
        return item;
    };

    const previewSection = section(outlineElement, '提示词与注入预览');
    previewSection.append(hint('显示插件整理的规划消息，以及本插件加入正文请求的部分；不是酒馆最终组装的完整请求。内容仅在当前页面查看，不进入运行日志。'));
    const previewMessage = hint('尚未生成预览。');
    const plannerPreview = textarea(8, { readonly: true }), writerPreview = textarea(8, { readonly: true });
    previewSection.append(button('刷新实际内容预览', () => dispatch('previewPrompts')), previewMessage,
        field('发送给规划模型的消息', plannerPreview), field('加入主模型请求的临时内容', writerPreview));

    const versionsSection = section(outlineElement, '大纲版本与比较');
    versionsSection.append(hint('恢复只替换工作台中的大纲，不删除聊天，也不回滚 Anima 记忆或记忆保留次数。恢复后需重新确认当前上下文。'));
    const selectedVersion = node('select', 'pw-input'), comparisonVersion = node('select', 'pw-input');
    const oldText = textarea(8, { readonly: true }), compareText = textarea(8, { readonly: true });
    const versionGrid = node('div', 'pw-advanced-fields');
    const left = node('div'), right = node('div');
    left.append(field('查看的版本', selectedVersion), field('版本内容', oldText));
    right.append(field('比较的版本', comparisonVersion), field('对照内容', compareText));
    versionGrid.append(left, right);
    const versionMessage = hint('还没有保存的大纲版本。');
    const restoreButton = button('恢复选中版本', () => { if (selectedVersion.value) return dispatch('restoreVersion', { id: selectedVersion.value }); });
    versionsSection.append(versionMessage, versionGrid, restoreButton);
    function updateComparison() {
        const versions = getState().planVersions || [];
        const selected = versions.find(item => item.id === selectedVersion.value), comparison = versions.find(item => item.id === comparisonVersion.value);
        oldText.value = selected?.xml || '';
        compareText.value = comparison?.xml || '';
        restoreButton.disabled = busy() || !selected;
    }
    listen(selectedVersion, 'change', updateComparison); listen(comparisonVersion, 'change', updateComparison);

    const diagnosisSection = section(outlineElement, '剧情诊断与备选方向');
    diagnosisSection.append(hint('手动诊断会额外调用规划 API。建议由你选择，采用后填入本轮输入，可继续修改再重新规划；不会自动发送、扩写或改变剧情。'));
    diagnosisSection.append(button('诊断当前剧情', () => dispatch('diagnose')));
    const diagnosisSummary = hint('尚未诊断。'), diagnosisOptions = node('div');
    diagnosisSection.append(diagnosisSummary, diagnosisOptions);
    listen(diagnosisOptions, 'click', event => {
        const control = event.target.closest?.('[data-diagnosis-index]');
        if (!control || !diagnosisOptions.contains(control)) return;
        const index = Number(control.dataset.diagnosisIndex);
        if (Number.isSafeInteger(index) && index >= 0 && index < (getState().diagnosis?.options?.length || 0)) dispatch('applyDiagnosis', { index });
    });
    outlineElement.append(notice);

    const backupSection = section(settingsElement, '设置与大纲备份');
    backupSection.append(hint('备份包括规划/API 方案设置与保存的大纲版本。密钥、运行日志和原始 Anima 记忆不纳入；大纲与预设本身可能包含私人剧情，请妥善保存。'));
    backupSection.append(button('导出备份', () => dispatch('exportBackup', {}, settingsNotice)));
    const file = node('input', 'pw-input'); file.type = 'file'; file.accept = '.json,application/json'; mutations.push(file);
    backupSection.append(field('导入Vespera备份', file, '最多 5 MB；仅接受 huapi-backup v1。导入后旧大纲需要重新确认。'));
    listen(file, 'change', async () => {
        if (destroyed || busy()) { file.value = ''; return; }
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > BACKUP_MAX_BYTES) { settingsNotice.textContent = '备份文件超过 5 MB。'; file.value = ''; return; }
        pending++; updateDisabled();
        let content;
        try { content = await selected.text(); }
        catch { settingsNotice.textContent = '无法读取备份文件，请重试。'; }
        finally { pending--; file.value = ''; }
        if (!destroyed && content !== undefined) await dispatch('importBackup', { text: content }, settingsNotice);
        else if (!destroyed) updateDisabled();
    });
    backupSection.append(settingsNotice);

    function updateDisabled() {
        const blocked = busy();
        for (const item of mutations) item.disabled = blocked;
        for (const item of diagnosisOptions.querySelectorAll('button')) item.disabled = blocked;
        restoreButton.disabled = blocked || !selectedVersion.value;
    }
    const messageText = messages => {
        if (typeof messages === 'string') return messages;
        if (!Array.isArray(messages)) return '';
        return messages.map(item => `[${String(item?.role || 'message')}]\n${typeof item?.content === 'string' ? item.content : '（无文本内容）'}`).join('\n\n');
    };
    function render() {
        if (destroyed) return;
        const state = getState();
        const preview = state.promptPreview;
        previewMessage.textContent = preview ? `${preview.valid === false ? '预览已过期，请刷新。' : ''}${preview.message || ''}` : '尚未生成预览。';
        plannerPreview.value = messageText(preview?.planner);
        writerPreview.value = messageText(preview?.writer);
        const versions = Array.isArray(state.planVersions) ? state.planVersions : [];
        const signature = JSON.stringify(versions.map(item => [item.id, item.label, item.createdAt, item.xml]));
        if (versionSignature !== signature) {
            const keep = selectedVersion.value, compare = comparisonVersion.value;
            selectedVersion.replaceChildren(option('', '选择版本')); comparisonVersion.replaceChildren(option('', '选择对照版本'));
            for (const item of [...versions].reverse()) {
                const label = `${item.label || '大纲版本'} · ${item.createdAt || ''}`;
                selectedVersion.append(option(item.id, label)); comparisonVersion.append(option(item.id, label));
            }
            selectedVersion.value = versions.some(item => item.id === keep) ? keep : versions.at(-1)?.id || '';
            comparisonVersion.value = versions.some(item => item.id === compare) ? compare : versions.at(-2)?.id || '';
            versionMessage.textContent = versions.length ? `已保存 ${versions.length} 个大纲版本；下方逐份并排查看，不会自动合并。` : '还没有保存的大纲版本。';
            versionSignature = signature; updateComparison();
        }
        const diagnosis = state.diagnosis;
        const nextDiagnosisSignature = JSON.stringify(diagnosis ?? null);
        if (diagnosisSignature !== nextDiagnosisSignature) {
            diagnosisSummary.textContent = diagnosis?.summary || '尚未诊断。'; diagnosisOptions.replaceChildren();
            for (const [index, item] of (Array.isArray(diagnosis?.options) ? diagnosis.options : []).entries()) {
                const card = node('div', 'pw-field');
                card.append(node('strong', 'pw-label', item.title || `方向 ${index + 1}`), node('p', 'pw-hint', item.direction || '未提供具体方向。'));
                const apply = node('button', 'pw-button', '填入本轮输入'); apply.type = 'button'; apply.dataset.diagnosisIndex = String(index); card.append(apply); diagnosisOptions.append(card);
            }
            diagnosisSignature = nextDiagnosisSignature;
        }
        updateDisabled();
    }
    render();
    return { outlineElement, settingsElement, render, destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const dispose of listeners) dispose();
        outlineElement.remove(); settingsElement.remove();
    } };
}
