import { normalizeEndpoint, PlannerError } from './planner.js';

// Use ST's authenticated proxy with only this profile's credentials. Never change
// the main connection or fall back to its saved key.
async function request({ getContext, fetchImpl = fetch, baseUrl, apiKey = '', signal, timeoutMs = 30000 }, route, fields) {
    const reverseProxy = normalizeEndpoint(baseUrl).replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
    if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new PlannerError('API 密钥格式无效。', 'KEY_INVALID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw new PlannerError('请求超时设置无效。', 'TIMEOUT_INVALID');
    const ctx = getContext?.();
    if (typeof ctx?.getRequestHeaders !== 'function') throw new PlannerError('当前酒馆未提供请求认证接口。', 'HOST_UNSUPPORTED');
    if (signal?.aborted) throw new PlannerError('操作已取消。', 'ABORTED');
    const controller = new AbortController();
    let timer, onAbort;
    const cancelled = new Promise((_, reject) => {
        onAbort = () => { controller.abort(); reject(new PlannerError('操作已取消。', 'ABORTED')); };
        timer = setTimeout(() => { controller.abort(); reject(new PlannerError('API 请求超时，请检查地址及网络。', 'TIMEOUT')); }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([cancelled, (async () => {
            const response = await fetchImpl(`/api/backends/chat-completions/${route}`, {
                method: 'POST', credentials: 'same-origin', signal: controller.signal,
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ ...fields, chat_completion_source: 'openai', reverse_proxy: reverseProxy, proxy_password: apiKey.trim() }),
            });
            if (!response || typeof response.json !== 'function' || typeof response.ok !== 'boolean') throw new PlannerError('API 未返回有效的 HTTP 响应。', 'RESPONSE_INVALID');
            if (!response.ok) {
                const status = Number(response.status);
                throw new PlannerError(`API 请求失败${Number.isInteger(status) ? `（HTTP ${status}）` : ''}。请检查地址、密钥、模型权限或额度。`, 'HTTP_ERROR');
            }
            let data;
            try { data = await response.json(); } catch { throw new PlannerError('API 没有返回有效 JSON。', 'RESPONSE_INVALID'); }
            // The ST status endpoint can wrap upstream errors in HTTP 200.
            if (data?.error) throw new PlannerError('API 返回错误，请检查地址、密钥及接口支持情况。', 'API_ERROR');
            return data;
        })()]);
    } catch (error) {
        if (error instanceof PlannerError) throw error;
        if (signal?.aborted) throw new PlannerError('操作已取消。', 'ABORTED');
        // Network exceptions can embed the full request and credential. Keep them private.
        throw new PlannerError('API 请求未完成，请检查网络、地址及酒馆服务器。', 'NETWORK_ERROR');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

export async function fetchModelList(options) {
    const data = await request(options, 'status', {});
    if (!Array.isArray(data?.data)) throw new PlannerError('此接口未返回兼容的模型列表，请手动填写模型 ID。', 'MODELS_UNSUPPORTED');
    const models = [...new Set(data.data.map(x => x?.id).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].sort();
    if (!models.length) throw new PlannerError('此接口没有返回可用模型，请手动填写模型 ID。', 'MODELS_EMPTY');
    return models;
}

export async function testApiConnection(options) {
    if (typeof options.model !== 'string' || !options.model.trim()) throw new PlannerError('请先填写或选择模型。', 'MODEL_REQUIRED');
    const data = await request(options, 'generate', {
        model: options.model.trim(), stream: false, max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text || '').join('') : '';
    if (choice?.finish_reason === 'length') throw new PlannerError('接口已响应，但测试输出被截断；尚未确认完整生成成功。可用实际规划请求进一步检查。', 'TEST_TRUNCATED');
    if (choice?.finish_reason === 'content_filter' || !text.trim()) throw new PlannerError('接口已响应，但没有返回可用文本，请检查模型是否支持聊天补全。', 'TEST_EMPTY');
    return { message: '连接成功：所选模型已返回测试文本。' };
}

export async function requestDiagnosis(options) {
    if (typeof options.model !== 'string' || !options.model.trim()) throw new PlannerError('请先选择规划模型。', 'MODEL_REQUIRED');
    if (!Array.isArray(options.messages) || !options.messages.length) throw new PlannerError('诊断缺少本轮资料。', 'MESSAGES_INVALID');
    const data = await request(options, 'generate', {
        model: options.model.trim(), stream: false, max_tokens: 2048,
        messages: [...options.messages, { role: 'user', content: '本次只做用户主动请求的剧情诊断，不生成大纲或正文。遵守已给的人设、已发生事实和人物知情边界；不要用情绪评分或强行推进判断好坏。说明当前可能停滞或矛盾的具体原因，并给出可由用户选择的少量不同方向；不自动采用。只返回 JSON：{"summary":"简短的问题与依据说明","options":[{"title":"方向名称","direction":"可以交给本轮规划模型的具体调整指令"}]}。没有明显问题时如实说明，不编造往事。' }],
    });
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new PlannerError('诊断输出被截断，请重试。', 'OUTPUT_TRUNCATED');
    let raw = choice?.message?.content;
    if (typeof raw !== 'string') throw new PlannerError('诊断未返回可用文本。', 'RESPONSE_INVALID');
    raw = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '');
    let result;
    try { result = JSON.parse(raw); } catch { throw new PlannerError('诊断格式不正确，请重试；未应用任何建议。', 'DIAGNOSIS_INVALID'); }
    if (typeof result?.summary !== 'string' || !result.summary.trim() || result.summary.length > 6000 || !Array.isArray(result.options) || result.options.length > 8 || result.options.some(x => typeof x?.title !== 'string' || !x.title.trim() || x.title.length > 200 || typeof x?.direction !== 'string' || !x.direction.trim() || x.direction.length > 3000)) throw new PlannerError('诊断字段不完整或过长；未应用任何建议。', 'DIAGNOSIS_INVALID');
    return { summary: result.summary.trim(), options: result.options.map(x => ({ title: x.title.trim(), direction: x.direction.trim() })) };
}
