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

const ANALYSIS_LIMIT = 100_000;

function returnedText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
    return '';
}

function withoutOuterFence(value) {
    const text = value.trim();
    const opening = /^[\t ]*(`{3,}|~{3,})[\t ]*(?:[\w.+-]+)?[\t ]*\r?\n/.exec(text);
    if (!opening) return text;
    const fence = `${opening[1][0]}{${opening[1].length},}`;
    const closing = new RegExp(`\\r?\\n[\\t ]*${fence}[\\t ]*$`).exec(text);
    if (!closing || closing.index < opening[0].length) return text;
    const inside = text.slice(opening[0].length, closing.index);
    // A fence that already closes inside the response is not a single outer wrapper.
    if (new RegExp(`^[\\t ]*${fence}[\\t ]*\\r?$`, 'm').test(inside)) return text;
    return inside;
}

function limitAnalysis(text) {
    const truncated = text.length > ANALYSIS_LIMIT;
    let value = truncated ? text.slice(0, ANALYSIS_LIMIT) : text;
    if (truncated && /[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    return { text: value, truncated };
}

function returnedAnalysis(message, raw) {
    const reasoning = limitAnalysis((returnedText(message?.reasoning_content).trim() || returnedText(message?.reasoning).trim()));
    const source = withoutOuterFence(raw);
    // parseContent has already validated one unique block. Its xml is canonical,
    // so remove the original source span rather than comparing serialized text.
    const start = /<content(?=[\s/>])/.exec(source);
    const end = /<\/content\s*>/.exec(source);
    const supplement = limitAnalysis((source.slice(0, start.index) + source.slice(end.index + end[0].length)).trim());
    return { reasoning: reasoning.text, supplement: supplement.text, truncated: reasoning.truncated || supplement.truncated };
}

const MAX_STREAM_BYTES = 16_000_000;
const MAX_STREAM_TEXT = 4_000_000;
const MAX_EVENT_TEXT = 1_000_000;
const TIMEOUT_CODES = new Set(['timeout', 'timeout_error', 'request_timeout', 'upstream_timeout', 'gateway_timeout', 'etimedout', 'esockettimedout', '408', '504', '524']);
const TIMEOUT_MESSAGES = new Set(['request timeout', 'request timed out', 'request timed out.', 'the request timed out.', 'gateway timeout', 'gateway timeout.', 'upstream request timeout', 'upstream request timed out.', 'connection timed out.', 'a timeout occurred', '请求超时', '上游请求超时']);

function apiError(error) {
    const codes = [error?.code, error?.type, error?.status, error?.status_code].filter(value => typeof value === 'string' || typeof value === 'number');
    const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    if (codes.some(value => TIMEOUT_CODES.has(String(value).trim().toLowerCase())) || TIMEOUT_MESSAGES.has(message.trim().toLowerCase()) || /^status code (408|504|524)$/i.test(message.trim())) {
        return new PlannerError('上游 API 等待响应超时，尚未获得完整结果。请稍后重试或检查中转的超时设置。', 'UPSTREAM_TIMEOUT');
    }
    return new PlannerError('API 返回错误，请检查连接和模型设置。服务器原始错误未展示。', 'API_ERROR');
}

function streamIncomplete() { return new PlannerError('流式响应提前结束或缺少有效完成标记，未交付不完整结果。请重新请求。', 'OUTPUT_INCOMPLETE'); }
function streamLimit() { return new PlannerError('流式响应超过本地大小限制，已停止接收；未交付不完整结果。', 'OUTPUT_TOO_LARGE'); }

/** Reads declared JSON or OpenAI-compatible SSE, without exposing upstream error bodies.
 * The returned object uses the normal ChatCompletion shape; callers still own
 * finish_reason-specific UI and their final content/schema validation. */
export async function readChatCompletionResponse(response, { stream = false, signal } = {}) {
    if (signal?.aborted) {
        try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* A late transport response must not stay open. */ }
        throw new PlannerError('操作已取消。', 'ABORTED');
    }
    if (!response || typeof response.ok !== 'boolean') throw new PlannerError('请求通道没有返回有效的 HTTP 响应。', 'TRANSPORT_INVALID');
    let reader;
    const cancel = () => {
        try { Promise.resolve(reader ? reader.cancel() : response.body?.cancel?.()).catch(() => {}); } catch { /* Cleanup must not reveal transport details. */ }
    };
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { cancel(); rejectAbort(new PlannerError('操作已取消。', 'ABORTED')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let closed = false;
    try {
        if (signal?.aborted) onAbort();
        if (!response.ok) {
            const status = Number(response.status);
            if ([408, 504, 524].includes(status)) throw new PlannerError(`API 网关等待上游响应超时（HTTP ${status}），尚未获得完整结果。`, 'UPSTREAM_TIMEOUT');
            throw new PlannerError(Number.isInteger(status) ? `API 请求失败（HTTP ${status}）。请检查连接、模型权限和额度；服务器原始错误未展示。` : 'API 请求失败。', 'HTTP_ERROR');
        }
        // Some proxies ignore stream=true and return a complete JSON response.
        const type = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        if (type !== 'text/event-stream') {
            if (typeof response.json !== 'function') throw new PlannerError('请求通道没有返回有效的 HTTP 响应。', 'TRANSPORT_INVALID');
            let data;
            try { data = await Promise.race([response.json(), aborted]); }
            catch (error) {
                if (signal?.aborted) throw new PlannerError('操作已取消。', 'ABORTED');
                throw new PlannerError(stream ? 'API 未返回有效 JSON 或声明的流式响应。' : 'API 未返回有效 JSON。', 'RESPONSE_INVALID');
            }
            if (data?.error) throw apiError(data.error);
            closed = true;
            return data;
        }
        if (typeof response.body?.getReader !== 'function') throw new PlannerError('请求通道未提供可读取的流式响应。', 'TRANSPORT_INVALID');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const message = { role: 'assistant', content: '', reasoning_content: '', reasoning: '' };
        const usage = {};
        let buffer = '', dataLines = [], eventName = '', eventSize = 0, bytes = 0, textSize = 0, events = 0;
        let finishReason = null, doneMarker = false, terminalFailure = false;
        function event() {
            if (!dataLines.length) { eventName = ''; return; }
            const dataText = dataLines.join('\n');
            const name = eventName;
            dataLines = []; eventName = ''; eventSize = 0;
            if (++events > 100_000) throw streamLimit();
            if (dataText.trim() === '[DONE]') { doneMarker = true; return; }
            let data;
            try { data = JSON.parse(dataText); }
            catch {
                if (name === 'error') throw apiError(dataText);
                throw new PlannerError('流式响应含有无效事件，未交付不完整结果。', 'RESPONSE_INVALID');
            }
            if (name === 'error' || data?.error) throw apiError(data?.error ?? data);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PlannerError('流式响应事件格式无效。', 'RESPONSE_INVALID');
            for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (Number.isFinite(data.usage?.[field])) usage[field] = data.usage[field];
            const choices = data.choices;
            if (choices !== undefined && !Array.isArray(choices)) throw new PlannerError('流式响应的 choices 格式无效。', 'RESPONSE_INVALID');
            const choice = choices?.find(item => item?.index === 0) ?? (choices?.length === 1 && choices[0]?.index == null ? choices[0] : null);
            if (!choice) return;
            const delta = choice.delta || {};
            for (const field of ['content', 'reasoning_content', 'reasoning']) {
                const value = delta[field];
                if (field === 'content' && value != null && typeof value !== 'string' && (!Array.isArray(value) || value.some(part => part?.type !== 'text' || typeof part.text !== 'string'))) throw new PlannerError('流式响应返回了不支持的内容类型。', 'RESPONSE_INVALID');
                const text = returnedText(value);
                if (!text) continue;
                if (finishReason !== null) throw streamIncomplete();
                textSize += text.length;
                if (textSize > MAX_STREAM_TEXT || (field === 'content' && message.content.length + text.length > 2_000_000)) throw streamLimit();
                message[field] += text;
            }
            if (choice.finish_reason != null) {
                if (!['stop', 'length', 'content_filter'].includes(choice.finish_reason) || (finishReason !== null && finishReason !== choice.finish_reason)) throw streamIncomplete();
                finishReason = choice.finish_reason;
                // These outcomes cannot become usable later; do not turn a known
                // output limit into a misleading timeout while waiting for DONE.
                terminalFailure = finishReason !== 'stop';
            }
        }
        function line(value) {
            if (value.length > MAX_EVENT_TEXT) throw streamLimit();
            if (!value) { event(); return; }
            if (value.startsWith(':')) return;
            const separator = value.indexOf(':');
            const field = separator < 0 ? value : value.slice(0, separator);
            let text = separator < 0 ? '' : value.slice(separator + 1);
            if (text.startsWith(' ')) text = text.slice(1);
            if (field === 'data') {
                eventSize += text.length + 1;
                if (eventSize > MAX_EVENT_TEXT) throw streamLimit();
                dataLines.push(text);
            } else if (field === 'event') eventName = text;
        }
        function consume(final = false) {
            while (!doneMarker && !terminalFailure) {
                const match = /[\r\n]/.exec(buffer);
                if (!match || (!final && match[0] === '\r' && match.index === buffer.length - 1)) break;
                const length = match[0] === '\r' && buffer[match.index + 1] === '\n' ? 2 : 1;
                const value = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + length);
                line(value);
            }
            if (buffer.length > MAX_EVENT_TEXT && !doneMarker && !terminalFailure) throw streamLimit();
            if (final && !doneMarker && !terminalFailure) { if (buffer) line(buffer); buffer = ''; event(); }
        }
        while (!doneMarker && !terminalFailure) {
            const chunk = await Promise.race([reader.read(), aborted]);
            if (signal?.aborted) throw new PlannerError('操作已取消。', 'ABORTED');
            if (chunk.done) {
                closed = true; buffer += decoder.decode(); consume(true); break;
            }
            if (!(chunk.value instanceof Uint8Array)) throw new PlannerError('流式响应未返回有效字节数据。', 'RESPONSE_INVALID');
            bytes += chunk.value.byteLength;
            if (bytes > MAX_STREAM_BYTES) throw streamLimit();
            buffer += decoder.decode(chunk.value, { stream: true }); consume();
        }
        if (finishReason === null) throw streamIncomplete();
        return { choices: [{ index: 0, message, finish_reason: finishReason }], usage };
    } catch (error) {
        if (signal?.aborted) throw new PlannerError('操作已取消。', 'ABORTED');
        if (error instanceof PlannerError) throw error;
        throw new PlannerError('读取 API 响应时连接中断或数据无效，未交付不完整结果。', 'NETWORK_ERROR');
    } finally {
        signal?.removeEventListener('abort', onAbort);
        if (!closed) cancel();
        try { reader?.releaseLock(); } catch { /* Cancellation may still be settling. */ }
    }
}

/** transport receives {url,headers,body,signal}; it must return a Fetch-compatible Response. */
export async function requestPlan({ baseUrl, apiKey = '', model, messages, signal, timeoutMs = 120000, temperature, maxTokens, stream = false, transport, DOMParser } = {}) {
    const url = normalizeEndpoint(baseUrl);
    if (typeof model !== 'string' || !model.trim()) throw new PlannerError('请填写规划模型名称。', 'MODEL_REQUIRED');
    if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new PlannerError('API 密钥格式无效。', 'KEY_INVALID');
    if (!Array.isArray(messages) || !messages.length || messages.some(m => !['system', 'user', 'assistant'].includes(m?.role) || typeof m.content !== 'string')) throw new PlannerError('规划请求的消息格式无效。', 'MESSAGES_INVALID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw new PlannerError('超时设置必须在 0—900000 毫秒之间。', 'TIMEOUT_INVALID');
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new PlannerError('temperature 必须在 0—2 之间。', 'PARAMETER_INVALID');
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) throw new PlannerError('maxTokens 必须是正整数。', 'PARAMETER_INVALID');
    if (typeof stream !== 'boolean') throw new PlannerError('流式设置必须为布尔值。', 'PARAMETER_INVALID');
    if (signal?.aborted) throw new PlannerError('规划已取消。', 'ABORTED');
    const controller = new AbortController();
    const headers = { 'Content-Type': 'application/json', ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}) };
    const body = { model: model.trim(), messages: messages.map(({ role, content }) => ({ role, content })), stream };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    const send = transport ?? (request => fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: request.signal }));
    if (typeof send !== 'function') throw new PlannerError('transport 必须是请求函数。');
    let timer;
    let onAbort;
    let cancellationError;
    const cancelled = new Promise((_, reject) => {
        timer = setTimeout(() => { cancellationError = new PlannerError('规划请求超时。尚未产生可注入的大纲。', 'TIMEOUT'); controller.abort(); reject(cancellationError); }, timeoutMs);
        onAbort = () => { cancellationError = new PlannerError('规划已取消。', 'ABORTED'); controller.abort(); reject(cancellationError); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const result = await Promise.race([
            (async () => {
                const response = await send({ url, headers, body, signal: controller.signal });
                const data = await readChatCompletionResponse(response, { stream, signal: controller.signal });
                const choice = data?.choices?.[0];
                if (choice?.finish_reason === 'length') {
                    const limit = maxTokens === undefined ? '当前未指定输出上限，由接口决定。' : `当前指定输出上限为 ${maxTokens} tokens。`;
                    throw new PlannerError(`规划输出达到接口报告的长度上限，可能被截断。${limit}请核对返回用量、模型限制与输出要求后重新规划。`, 'OUTPUT_TRUNCATED');
                }
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
                return { ...parsed, raw, usage, analysis: returnedAnalysis(choice.message, raw) };
            })(),
            cancelled,
        ]);
        return result;
    } catch (error) {
        if (cancellationError) throw cancellationError;
        if (error instanceof PlannerError || error?.name === 'ContentError') throw error;
        if (signal?.aborted) throw new PlannerError('规划已取消。', 'ABORTED');
        const message = redactSecrets(error?.message || '未知网络错误', [apiKey, apiKey.trim()]).slice(0, 300);
        throw new PlannerError(`规划请求未完成：${message}`, 'NETWORK_ERROR');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
