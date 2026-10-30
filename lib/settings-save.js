const SAVE_TIMEOUT_MS = 30_000;
const messages = {
    SETTINGS_SAVE_UNSUPPORTED: '当前酒馆缺少可确认的设置保存接口，已停止刷新。请先通过酒馆保存设置。',
    SETTINGS_SAVE_UNCONFIRMED: '酒馆未确认设置保存成功，已停止刷新。请检查连接后重试。',
    SETTINGS_SAVE_FAILED: '酒馆保存设置失败，已停止刷新。请检查连接后重试。',
    SETTINGS_SAVE_TIMEOUT: '等待酒馆保存设置超时，已停止刷新。迟到的保存结果不会自动刷新页面。',
};
class SettingsSaveError extends Error {
    constructor(code) { super(messages[code]); this.name = 'SettingsSaveError'; this.code = code; }
}

/**
 * ST's saveSettings can resolve after a swallowed failure or early return.
 * Require its completion and SETTINGS_UPDATED while this attempt is active.
 * The host event has no request ID: this is a silent-failure guard, not a
 * transaction guarantee against other concurrent host saves. No settings data
 * is inspected or retained, and this function never reloads the page itself.
 */
export async function saveSettingsBeforeReload(scriptModule) {
    const source = scriptModule?.eventSource;
    const event = scriptModule?.event_types?.SETTINGS_UPDATED;
    if (typeof scriptModule?.saveSettings !== 'function' || typeof source?.on !== 'function'
        || typeof source?.removeListener !== 'function' || typeof event !== 'string' || !event) {
        throw new SettingsSaveError('SETTINGS_SAVE_UNSUPPORTED');
    }
    let active = true, observedSuccess = false, timer;
    const onSuccess = () => { if (active) observedSuccess = true; };
    try {
        source.on(event, onSuccess);
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new SettingsSaveError('SETTINGS_SAVE_TIMEOUT')), SAVE_TIMEOUT_MS);
        });
        await Promise.race([Promise.resolve(scriptModule.saveSettings()), timeout]);
        if (!observedSuccess) throw new SettingsSaveError('SETTINGS_SAVE_UNCONFIRMED');
    } catch (error) {
        throw error instanceof SettingsSaveError ? error : new SettingsSaveError('SETTINGS_SAVE_FAILED');
    } finally {
        active = false;
        clearTimeout(timer);
        // A nonstandard event emitter may fail removal; a late callback still
        // has no effect because active is already false.
        try { source.removeListener(event, onSuccess); } catch { /* Never expose host error payloads. */ }
    }
}
