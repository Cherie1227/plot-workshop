export const INJECTION_KEY = 'plot_workshop_this_turn';

export const DEFAULT_SETTINGS = Object.freeze({
    baseUrl: '', model: '', temperature: '', maxTokens: '',
    minWords: '', maxWords: '', mode: 'review', autoOnSend: false,
    animaPath: '/scripts/extensions/third-party/Anima-Memory-System',
});

export function cleanSettings(input = {}) {
    const result = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(result)) {
        if (key === 'autoOnSend') result[key] = input[key] === true;
        else if (input[key] !== undefined) result[key] = String(input[key]);
    }
    if (!['review', 'auto', 'manual'].includes(result.mode)) result.mode = 'review';
    return result;
}

export function proseTarget(settings) {
    const read = (value, label) => {
        if (value === '' || value == null) return null;
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label}必须是正整数。`);
        return n;
    };
    const min = read(settings.minWords, '最少字数'), max = read(settings.maxWords, '最多字数');
    if (min && max && min > max) throw new Error('最少字数不能超过最多字数。');
    if (!min && !max) return '';
    return `最终正文${min && max ? `目标 ${min}—${max} 字` : min ? `至少 ${min} 字` : `最多 ${max} 字`}。计数包括叙述、对白和标点，不含空白、状态栏或其他附加组件。`;
}

export function assertChat(ctx) {
    if (ctx.groupId != null && ctx.groupId !== '') throw new Error('当前首版支持一对一角色聊天；群聊的多角色轮流生成尚未接入。');
    if (!ctx.chatId || !Array.isArray(ctx.chat) || !ctx.characters?.[ctx.characterId]) throw new Error('请先在酒馆打开一个角色聊天。');
}

export function storySnapshot(ctx, { dropLastInput } = {}) {
    const chat = ctx.chat.map(m => ({ name: m.name, is_user: !!m.is_user, is_system: !!m.is_system, mes: String(m.mes ?? ''), swipe_id: m.swipe_id ?? null }));
    if (dropLastInput !== undefined) {
        if (!chat.at(-1)?.is_user || chat.at(-1).mes !== dropLastInput) throw new Error('当前用户消息与大纲不一致，请重新规划。');
        chat.pop();
    }
    return JSON.stringify({ chatId: ctx.chatId, characterId: ctx.characterId, groupId: ctx.groupId ?? null,
        user: ctx.name1, character: ctx.characters?.[ctx.characterId],
        persona: ctx.powerUserSettings?.persona_description ?? '',
        cardOverrides: Object.fromEntries(Object.entries(ctx.chatMetadata ?? {}).filter(([key]) => ['scenario','mes_example','system_prompt','post_history_instructions','persona'].includes(key))),
        chat });
}

export async function collectPlanningContext(ctx, userInput, { inputAlreadyInChat = false, maxContext } = {}) {
    assertChat(ctx);
    if (typeof ctx.getWorldInfoPrompt !== 'function') throw new Error('当前酒馆未提供世界书扫描接口，请升级到支持此接口的版本。');
    const fields = typeof ctx.getCharacterCardFields === 'function' ? ctx.getCharacterCardFields() : {};
    const character = ctx.characters[ctx.characterId], data = character.data ?? character;
    const description = fields.description ?? data.description ?? character.description ?? '';
    const personality = fields.personality ?? data.personality ?? character.personality ?? '';
    const scenario = fields.scenario ?? data.scenario ?? character.scenario ?? '';
    const persona = fields.persona ?? ctx.powerUserSettings?.persona_description ?? '';
    const history = ctx.chat.map(m => ({ ...m }));
    if (inputAlreadyInChat) {
        if (!history.at(-1)?.is_user || history.at(-1).mes !== userInput) throw new Error('本轮用户输入已经改变，请重新规划。');
        history.pop();
    }
    // Dry scanning avoids advancing worldbook activation/cooldown state for a planning-only call.
    const scan = [...history, { name: ctx.name1, mes: userInput }].map(m => `${m.name || ''}: ${m.mes || ''}`).reverse();
    const beforePrompts = new Map(Object.entries(ctx.extensionPrompts ?? {}).filter(([key]) => key === '2_floating_prompt').map(([key, value]) => [key, { ...value }]));
    const noteMetadata = JSON.stringify(ctx.chatMetadata ?? {});
    const chatAtScan = ctx.chatId;
    let world;
    try { world = await ctx.getWorldInfoPrompt(scan, Number(maxContext || ctx.chatCompletionSettings?.openai_max_context || ctx.maxContext || 8192), true, {
        personaDescription: persona, characterDescription: description, characterPersonality: personality,
        characterDepthPrompt: fields.charDepthPrompt ?? '', scenario, creatorNotes: fields.creatorNotes ?? '', trigger: 'normal',
    }); } finally {
        // Official WI dry-run still appends AN-position entries to Authors Note. Undo only
        // that predictable append, never unrelated edits made while the scan was pending.
        const latestContext = globalThis.SillyTavern?.getContext?.() || ctx;
        const latestChatId = ctx.getCurrentChatId?.() ?? latestContext.chatId;
        if (latestChatId === chatAtScan && JSON.stringify(latestContext.chatMetadata ?? {}) === noteMetadata) {
            for (const [key, previous] of beforePrompts) {
                const current = ctx.extensionPrompts?.[key];
                const expected = `${(world?.anBefore ?? []).join('\n')}\n${previous.value}\n${(world?.anAfter ?? []).join('\n')}`.replace(/(^\n)|(\n$)/g, '');
                const retainsOriginal = String(current?.value ?? '').includes(previous.value);
                if (current && current.value !== previous.value && (current.value === expected || retainsOriginal)) ctx.extensionPrompts[key] = previous;
            }
        }
    }
    if (!world || typeof world.worldInfoBefore !== 'string' || typeof world.worldInfoAfter !== 'string') throw new Error('世界书扫描没有返回有效结果。');
    const additional = [
        ...(world.worldInfoDepth ?? []).map(x => (x.entries ?? []).join('\n')),
        ...(world.worldInfoExamples ?? []).map(x => x.content || ''),
        ...(world.anBefore ?? []), ...(world.anAfter ?? []),
        ...Object.values(world.outletEntries ?? {}).flat(),
    ].filter(x => typeof x === 'string' && x.trim()).join('\n\n');
    return {
        user: String(ctx.name1 || '用户'), char: String(ctx.name2 || character.name || '角色'),
        currentInput: userInput, charDescription: description, charPersonality: personality, scenario,
        personaDescription: persona, dialogueExamples: fields.mesExamples ?? data.mes_example ?? '',
        worldInfoBefore: world.worldInfoBefore,
        worldInfoAfter: [world.worldInfoAfter, additional].filter(Boolean).join('\n\n'),
        chatHistory: history.filter(m => typeof m.mes === 'string').map(m => ({ role: m.is_system ? 'system' : m.is_user ? 'user' : 'assistant', content: `${m.name ? `${m.name}: ` : ''}${m.mes}` })),
    };
}

/** Uses ST's authenticated built-in proxy with this request's own credentials. Never edits main API settings. */
export function createSTTransport(getContext, fetchImpl = fetch) {
    return async ({ url, headers, body, signal }) => {
        const reverseProxy = url.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
        const apiKey = String(headers.Authorization ?? '').replace(/^Bearer\s+/i, '');
        const ctx = getContext();
        if (typeof ctx.getRequestHeaders !== 'function') throw new Error('当前酒馆未提供请求认证接口。');
        return fetchImpl('/api/backends/chat-completions/generate', {
            method: 'POST', credentials: 'same-origin', signal,
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ ...body, chat_completion_source: 'openai', reverse_proxy: reverseProxy, proxy_password: apiKey }),
        });
    };
}

// Host extension prompts undergo macro substitution. Keep generated material inert.
export function inertHostText(text) { return String(text).replace(/\{(?=\{)/g, '{\u200b'); }

export function injectForTurn(ctx, { xml, memory, target, writerRules, valid }) {
    const text = [writerRules, target ? `【本轮共享的正文目标】\n${target}` : '',
        '【本轮已实际读取的 Anima 记忆】\n' + (memory || '本轮读取成功，没有相关结果。'),
        '【本轮已确认大纲；尚未发生，不写入长期记忆】\n' + xml].filter(Boolean).join('\n\n');
    ctx.setExtensionPrompt(INJECTION_KEY, inertHostText(text), 1, 0, false, 0, valid ?? null);
}

export function clearInjection(ctx) {
    ctx.setExtensionPrompt?.(INJECTION_KEY, '', 1, 0, false, 0);
    if (ctx.extensionPrompts) delete ctx.extensionPrompts[INJECTION_KEY];
}
