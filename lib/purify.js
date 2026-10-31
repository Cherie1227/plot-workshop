/** Language polish pass: a fast model rewrites the finished outline into plain
 * expository prose while content, structure and handoff markers must stay
 * identical. Anything suspicious falls back to the planner's original text. */

export const POLISH_SYSTEM_PROMPT = `你是文本改写器，任务是把一份剧情大纲的语言改写为平实直述的说明文。只改语言，不改内容。

必须原样保留：
- 全部事实、决定、因果关系、情绪方向与程度、信息边界（谁知道什么、不知道或误解什么）
- content 的 XML 标签结构、字段名称、层级、顺序与 index 编号
- 【呈现】【口吻】【逐字保留】等交接标记及其紧跟的内容
- 【逐字保留】指定的原句与口吻锚点引文：逐字照抄，一个标点都不动
- 人名、称呼、时间、地点与数字

改写要求：
- 比喻、意象与氛围形容改为直述（“钝感被一句称呼撬开”→“他生出兴致”）
- 量化修辞写满（“三分主动”→“略占主动”）
- “不是……而是……”式否定对比改为正面陈述；作为事实的否定陈述仍保持否定
- 排比、连续短句碎句、破折号补充说明改为通顺的说明句
- 鉴赏式形容改为事实写法（“空得像白纸的资料页”→“资料页没有朋友圈，只有签名”）

禁止：增删人物、事件、条件或约束；把否定改成肯定；合并或拆分事件节点；改动标记内容；输出大纲以外的任何文字。
只输出改写后的 content XML。`;

export function polishMessages(xml) {
    return [
        { role: 'system', content: POLISH_SYSTEM_PROMPT },
        { role: 'user', content: xml },
    ];
}

const HANDOFF_MARKERS = ['【呈现】', '【口吻】', '【逐字保留】'];

function countOccurrences(text, needle) {
    let count = 0, index = 0;
    while ((index = text.indexOf(needle, index)) !== -1) { count++; index += needle.length; }
    return count;
}

/** Structural equivalence between the parsed original and purified outlines.
 * Language may differ freely; the skeleton and handoff markers may not. */
export function validatePolish(original, purified) {
    if (!original || !purified || original.version !== purified.version) return false;
    const names = plan => (plan.characters ?? []).map(character => character.name).sort().join('');
    if (names(original) !== names(purified)) return false;
    if ((original.segments ?? []).length !== (purified.segments ?? []).length) return false;
    if (original.version === 2) {
        const fields = plan => (plan.beats ?? []).map(beat => ['event', beat.emotion !== undefined ? 'emotion' : '', beat.choice !== undefined ? 'choice' : ''].filter(Boolean).join(',')).join('|');
        if (fields(original) !== fields(purified)) return false;
    }
    for (const marker of HANDOFF_MARKERS) {
        if (countOccurrences(original.xml, marker) !== countOccurrences(purified.xml, marker)) return false;
    }
    return true;
}
