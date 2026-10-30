import { parseContent } from './content.js';

export class PlannerError extends Error {
    constructor(message, code = 'PLANNER_FAILED') { super(message); this.name = 'PlannerError'; this.code = code; }
}

export function redactSecrets(value, secrets = []) {
    let text = String(value ?? '');
    for (const secret of secrets.filter(x => typeof x === 'string' && x)) text = text.split(secret).join('[已隐藏]');
    return text
        .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
        .replace(/((?:api[_-]?key|authorization|token|password)\s*[=:]\s*)[^\s&"'<>]+/gi, '$1[已隐藏]');
}

export function normalizeEndpoint(baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new PlannerError('API 地址无效，请输入完整的 http 或 https 地址。', 'ENDPOINT_INVALID'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new PlannerError('API 地址只允许 http/https，且不能包含账号、密码、查询参数或片段。密钥请单独填写。', 'ENDPOINT_INVALID');
    }
    let path = url.pathname.replace(/\/+$/, '');
    if (!path) path = '/v1';
    if (!path.endsWith('/chat/completions')) path += '/chat/completions';
    url.pathname = path;
    return url.toString();
}

/** transport receives {url,headers,body,signal}; it must return a Fetch-compatible Response. */
export async function requestPlan({ baseUrl, apiKey = '', model, messages, signal, timeoutMs = 120000, temperature, maxTokens, transport, DOMParser } = {}) {
    const url = normalizeEndpoint(baseUrl);
    if (typeof model !== 'string' || !model.trim()) throw new PlannerError('请填写规划模型名称。', 'MODEL_REQUIRED');
    if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new PlannerError('API 密钥格式无效。', 'KEY_INVALID');
    if (!Array.isArray(messages) || !messages.length || messages.some(m => !['system', 'user', 'assistant'].includes(m?.role) || typeof m.content !== 'string')) throw new PlannerError('规划请求的消息格式无效。', 'MESSAGES_INVALID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw new PlannerError('超时设置必须在 0—900000 毫秒之间。', 'TIMEOUT_INVALID');
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new PlannerError('temperature 必须在 0—2 之间。', 'PARAMETER_INVALID');
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) throw new PlannerError('maxTokens 必须是正整数。', 'PARAMETER_INVALID');
    if (signal?.aborted) throw new PlannerError('规划已取消。', 'ABORTED');
    const controller = new AbortController();
    const headers = { 'Content-Type': 'application/json', ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}) };
    const body = { model: model.trim(), messages: messages.map(({ role, content }) => ({ role, content })), stream: false };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    const send = transport ?? (request => fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: request.signal }));
    if (typeof send !== 'function') throw new PlannerError('transport 必须是请求函数。');
    let timer;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PlannerError('规划请求超时。尚未产生可注入的大纲。', 'TIMEOUT')); }, timeoutMs);
        onAbort = () => { controller.abort(); reject(new PlannerError('规划已取消。', 'ABORTED')); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const result = await Promise.race([
            (async () => {
                const response = await send({ url, headers, body, signal: controller.signal });
                if (!response || typeof response.json !== 'function' || typeof response.ok !== 'boolean') throw new PlannerError('请求通道没有返回有效的 HTTP 响应。', 'TRANSPORT_INVALID');
                if (!response.ok) {
                    const code = Number(response.status);
                    throw new PlannerError(Number.isInteger(code) ? `规划 API 请求失败（HTTP ${code}）。请检查连接、模型权限和额度；服务器原始错误未展示，以免泄露凭据。` : '规划 API 请求失败。', 'HTTP_ERROR');
                }
                let data;
                try { data = await response.json(); } catch { throw new PlannerError('规划 API 未返回有效 JSON。', 'RESPONSE_INVALID'); }
                if (data?.error) throw new PlannerError('规划 API 返回错误，请检查连接和模型设置。服务器原始错误未展示。', 'API_ERROR');
                const choice = data?.choices?.[0];
                if (choice?.finish_reason === 'length') throw new PlannerError('规划输出达到模型输出上限，可能被截断。请提高输出上限后重新规划。', 'OUTPUT_TRUNCATED');
                if (choice?.finish_reason === 'content_filter') throw new PlannerError('规划模型未完成输出。', 'OUTPUT_INCOMPLETE');
                let raw = choice?.message?.content;
                if (Array.isArray(raw)) {
                    if (raw.some(x => x?.type !== 'text' || typeof x.text !== 'string')) throw new PlannerError('规划 API 返回了不支持的内容类型。', 'RESPONSE_INVALID');
                    raw = raw.map(x => x.text).join('');
                }
                if (typeof raw !== 'string' || !raw.trim()) throw new PlannerError('规划 API 没有返回可用的正文内容。', 'OUTPUT_EMPTY');
                const parsed = parseContent(raw, { DOMParser });
                const usage = {};
                for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (Number.isFinite(data.usage?.[name])) usage[name] = data.usage[name];
                return { ...parsed, raw, usage };
            })(),
            cancelled,
        ]);
        return result;
    } catch (error) {
        if (error instanceof PlannerError || error?.name === 'ContentError') throw error;
        if (signal?.aborted) throw new PlannerError('规划已取消。', 'ABORTED');
        const message = redactSecrets(error?.message || '未知网络错误', [apiKey, apiKey.trim()]).slice(0, 300);
        throw new PlannerError(`规划请求未完成：${message}`, 'NETWORK_ERROR');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
