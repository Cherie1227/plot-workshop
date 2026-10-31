// 故事巡检：纯本地规则检测，不调用模型。
// 结果只作为大纲页提示；用户明确带入时才作为一次性备注进入下一轮规划请求。

const TIER_GROUPS = new Set(['outline_tiers', 'outline_tone']);
const MIN_PROSE_LENGTH = 200;
const MIN_BASELINE_LENGTH = 400;
const NEW_INFO_FLOOR = 0.08;
const PLOT_SAME = 0.65;
const END_SAME = 0.5;
const LONG_CHAT_FLOORS = 12;

function normalizeText(text) {
    return String(text || '').replace(/[^\p{L}\p{N}]+/gu, '');
}
function grams(text, size = 3) {
    const clean = normalizeText(text);
    const set = new Set();
    for (let i = 0; i + size <= clean.length; i++) set.add(clean.slice(i, i + size));
    return set;
}
function newInfoRate(text, baseline) {
    const set = grams(text);
    if (!set.size) return 1;
    let fresh = 0;
    for (const gram of set) if (!baseline.has(gram)) fresh += 1;
    return fresh / set.size;
}
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared += 1;
    return shared / (a.size + b.size - shared);
}
/** Reads plot/end_state without full validation; unparseable input simply skips the rule. */
function outlineParts(xml) {
    const text = String(xml || '');
    const pick = tag => {
        const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    return { plot: pick('plot') || pick('direction'), endState: pick('end_state') };
}

/**
 * @param {object} input
 * @param {Array} input.chat 酒馆聊天数组（使用 mes/is_user/is_system 字段）。
 * @param {object|null} input.currentPlan 当前待确认大纲（parseContent 结果，含 plot/endState）。
 * @param {string} input.previousPlanXml 上一楼已写大纲的 XML（正文回执携带）。
 * @param {object|null} input.preset 当前规划预设（normalized 结构）。
 * @param {number} input.rounds 连续轮数阈值（2—5）。
 * @returns {string[]} 巡检提示；空数组表示没有发现问题。
 */
export function patrolStory({ chat = [], currentPlan = null, previousPlanXml = '', preset = null, rounds = 2 } = {}) {
    const notices = [];
    const messages = (Array.isArray(chat) ? chat : []).filter(item => item && typeof item.mes === 'string' && !item.is_system);
    const windowSize = Math.min(5, Math.max(2, Number(rounds) || 2));

    // 规则一：最近数轮正文新信息密度过低。基线是该层之前的全部聊天，
    // 包含被转述的用户输入（转述开场必然复用输入，不计为新信息）。
    const tail = [];
    for (let i = messages.length - 1; i >= 0 && tail.length < windowSize; i--) if (!messages[i].is_user) tail.unshift(i);
    if (tail.length >= windowSize && tail.every(index => {
        const text = String(messages[index].mes || '');
        if (normalizeText(text).length < MIN_PROSE_LENGTH) return false;
        const baselineText = messages.slice(0, index).map(item => item.mes).join('\n');
        return normalizeText(baselineText).length >= MIN_BASELINE_LENGTH && newInfoRate(text, grams(baselineText)) < NEW_INFO_FLOOR;
    })) notices.push(`最近 ${tail.length} 轮正文几乎没有新信息（新人物、地点、物件、事件），剧情可能在原地空转。`);

    // 规则二：本轮大纲与上一楼已写大纲核心问题相同，且结尾状态无实质变化。
    const currentPlot = typeof currentPlan?.plot === 'string' ? currentPlan.plot : '';
    const currentEnd = typeof currentPlan?.endState === 'string' ? currentPlan.endState : '';
    if (currentPlot && previousPlanXml) {
        const previous = outlineParts(previousPlanXml);
        if (previous.plot && jaccard(grams(currentPlot), grams(previous.plot)) > PLOT_SAME
            && jaccard(grams(currentEnd), grams(previous.endState)) > END_SAME) {
            notices.push('本轮大纲与上一楼已写大纲的核心问题相同、结尾状态也没有实质变化：同一件事已经谈了几轮。');
        }
    }

    // 规则三：长聊且「档位」「基调」分组全部未启用。整组被关闭视为用户的主动选择，不提示。
    if (preset && messages.length >= LONG_CHAT_FLOORS) {
        try {
            const groups = new Map((preset.groups || []).map(group => [group.id, group]));
            const mapping = preset.promptGroups || {};
            const anyGroupOn = [...TIER_GROUPS].some(id => groups.get(id)?.enabled !== false);
            const anyTier = (preset.order || []).some(entry => TIER_GROUPS.has(mapping[entry.identifier])
                && entry.enabled !== false && groups.get(mapping[entry.identifier])?.enabled !== false);
            if (anyGroupOn && !anyTier) notices.push(`已进行 ${messages.length} 楼，仍未启用任何推进/情绪档位或故事基调；节奏不合预期时，可在预设页对应分组中手动选择。`);
        } catch { /* 预设结构异常由预设页报告，巡检不重复。 */ }
    }
    return notices;
}
