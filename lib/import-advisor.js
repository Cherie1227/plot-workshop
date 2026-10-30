const KNOWN_MACROS = new Set(['setvar', 'setglobalvar', 'getvar', 'getglobalvar', 'user', 'char', 'description', 'personality', 'scenario', 'persona', 'mesexamples', 'user_input', 'currentinput', 'lastusermessage', 'noop', 'trim']);
const RULES = [
    { label: '完整正文输出', name: /正文|小说输出|故事输出|prose|story\s*output|content\s*output/i,
        target: /(?:完整的?\s*)?(?:小说|故事)?正文|完整(?:的)?(?:小说|故事|回复)|\b(?:full|complete)\s+(?:prose|story|response)\b/i },
    { label: '状态栏或状态面板输出', name: /状态栏|状态面板|状态表|角色面板|status(?:\s*(?:bar|panel|block|output))?/i,
        target: /状态栏|状态面板|状态表|角色面板|<status(?:[_-]?(?:bar|panel))?\b|\bstatus\s*(?:bar|panel|block)\b/i },
    { label: '逐轮摘要或记忆写入', name: /摘要|总结|记忆写入|记忆更新|summary|memory\s*(?:write|update|output)/i,
        target: /摘要|总结|记忆|\bsummary\b|\bmemory\b/i, periodic: true },
    { label: '额外思考过程或自检报告输出', name: /思维链|思考|推理|自检|检查报告|校验报告|\bcot\b|chain.of.thought|reasoning|self.check/i,
        target: /思维链|思考过程|推理过程|分析过程|自检报告|检查报告|校验报告|<think(?:ing)?\b|\bchain.of.thought\b|\breasoning(?:\s*process)?\b|self.check\s*report/i },
];
const OUTPUT = /输出|生成|撰写|写出|给出|提供|返回|呈现|展示|显示|附加|附上|追加|添加|插入|打印|列出|扩写|续写|\b(?:emit|output|display|append|print|produce|generate|write|show|return|include)\b/i;
const NEGATION = /不要|不必|不需要|不需|不得|不能|不应|不输出|不生成|不展示|不显示|不提供|不返回|不包含|无需|无须|禁止|严禁|切勿|勿|避免|\b(?:do\s+not|don['’]t|never|must\s+not|should\s+not|no\s+need|without)\b/i;
const DIRECTIVE = /^(?:[\s\d.)）\-*#【】\[\]])*(?:请|必须|务必|需要|应当|应|要|每轮|每次|在|于|最后|接着|然后|正文后|回复后|额外|另行|继续|始终|自动|直接|仅|只|将|把|输出|生成|撰写|写出|给出|提供|返回|呈现|展示|显示|附加|附上|追加|添加|插入|打印|列出|扩写|续写)|\b(?:please|must|shall|should|always|after\s+(?:each|every)|at\s+the\s+end|output|generate|write|append|display|emit|show|include|return)\b/i;
const PERIODIC = /每(?:一)?(?:轮|次)|逐轮|本轮|本次|回复(?:后|末尾|结束)|正文(?:后|末尾|结束)|结尾|\b(?:each|every)\s+(?:turn|reply|response)\b|\bafter\s+(?:the\s+)?(?:reply|response)\b/i;
const MEMORY_WRITE = /(?:写入|保存到|存入|更新|记录到).{0,12}(?:记忆|memory)|(?:记忆|memory).{0,12}(?:写入|保存|更新)|\b(?:write|save|update).{0,20}\bmemory\b/i;
const STYLE = /文风|八股|视角|人称|篇幅|字数|字数范围|段落数|正文长度|叙述风格|叙事风格|\b(?:writing\s*style|point.of.view|word\s*count|prose\s*length)\b/i;
const VARIABLE_DEFINITION = /\{\{\s*set(?:global)?var\s*::|定义变量|变量定义|变量初始化|初始化变量|变量赋值|声明变量|变量声明|(?:^|[\n;；])\s*(?:const|let|var)\s+[\w$]+\s*=/i;
const VARIABLE_READ = /\{\{\s*get(?:global)?var\s*::/i;
const CONTENT_MACRO = /\{\{\s*(?:user|char|description|personality|scenario|persona|mesexamples|user_input|currentinput|lastusermessage)\s*(?:::|\}\})/i;
const NARRATIVE_RULE = /(?:读卡|分析|理解|推演|判断|决定|保持|尊重|遵循|塑造|发展|根据|依据|以).{0,24}(?:人设|人物|角色|性格|动机|情绪|感情|关系|剧情|故事|因果)|(?:人设|人物|角色|性格|动机|情绪|感情|关系|剧情|故事).{0,24}(?:应当|应该|必须|需要|不得|不能|保持|遵循|分析|决定|循序渐进)|(?:生成|编写|输出|制定|规划).{0,16}(?:大纲|情节决策)|\b(?:analy[sz]e|maintain|respect).{0,28}\b(?:character|personality|plot|motivation)\b/i;
const INFORMATIONAL = /(?:资料|原文|记录|示例|例子|例如|比如|引用|用户说|他说|她说)\s*[:：]|是一种|是指|的(?:含义|意思|定义)|曾经|过去曾|\b(?:example|quoted|source\s*text|historical\s*record)\s*:/i;
const INTERNAL_THINKING = /内部|心中|脑中|脑海中|默默|暗中|仅供自己|仅供模型|\b(?:internal(?:ly)?|silent(?:ly)?|private(?:ly)?)\b/i;
const MULTILINE_CONTEXT = /(?:不要|不应|禁止|不必|无需|切勿|勿)[^\n。！？]{0,60}[:：][\t ]*\r?\n|(?:示例|例子|引用|原文|资料)[^\n。！？]{0,20}[:：][\t ]*\r?\n|\b(?:example|quotation|source\s*text|do\s+not|don['’]t|never)[^\n.!?]{0,60}:\s*\r?\n/i;
const DIRECT_TARGET_GAP = /^(?:\s|一[份篇段个]|本[轮次]|完整(?:的)?|详细(?:的)?|全部|最终|额外|相应(?:的)?|你(?:的)?|小说|故事|中文|新(?:的)?|所有|当轮|a|an|the|your|full|complete|final|detailed|this\s+turn)*$/i;
const PLANNING_SUFFIX = /^(?:采用|使用|所需|需要|中|内|的(?:要点|大纲|结构|规划|内容安排)|\s+(?:outline|plan|requirements?|structure)\b)/i;
const STORY_CONTINUITY = /(?:接住|承接|衔接|续接).{0,24}(?:上一轮|上轮|前文|动作|对话|情节)|(?:先|再|接着|然后|必须|需要|请)\s*回应.{0,24}(?:对方|问题|提问|动作)|\b(?:continue|respond\s+to).{0,24}\b(?:previous\s+action|character|question)\b/i;
const OUTPUT_TIMING = /^(?:(?:在|于)?(?:每(?:一)?轮|每次(?:回复)?|本轮|回复|正文)(?:结束|后|末尾|结尾)?|after\s+(?:each|every)\s+(?:turn|reply|response)|at\s+the\s+end(?:\s+of\s+(?:each|every)\s+(?:reply|response))?)$/i;
const FIELD_LIST = /^(?:包含|包括|字段(?:为|有|是|包含|包括)?)[\s:：]*(?:姓名|名称|心情|情绪|位置|时间|地点|日期|年龄|身份|关系|好感度|体力|状态|服饰|当前动作)(?:\s*[、和与及/]\s*(?:姓名|名称|心情|情绪|位置|时间|地点|日期|年龄|身份|关系|好感度|体力|状态|服饰|当前动作))*$/;

function hasPlanningProtocol(content) {
    const text = content.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
    const fields = ['content', 'plot', 'characters', 'segments', 'end_state'];
    return fields.every(name => new RegExp(`<\\s*${name}(?:\\s|>)`, 'i').test(text))
        || (/XML|标签|层级|结构|输出格式|规划|大纲/i.test(text) && fields.every(name => new RegExp(`\\b${name}\\b`, 'i').test(text)));
}

function inspectMacros(content) {
    const names = [...content.matchAll(/\{\{\s*([^:{}\s]+)/g)].map(match => match[1].toLowerCase());
    return names.some(name => !KNOWN_MACROS.has(name) && !name.startsWith('/'));
}

function instructionClauses(content) {
    // Quoted source text, examples and code templates are not output instructions.
    return content.replace(/```[\s\S]*?(?:```|$)/g, '【代码或模板】').replace(/^\s*>.*$/gm, '【引用资料】')
        .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"/g, '【引用资料】')
        .split(/[。！？!?；;\n]+|\.(?:\s+|$)/).map(value => value.trim()).filter(Boolean);
}

function hasDirectTarget(clause, rule) {
    // Co-occurrence alone is insufficient: "给出正文采用的场景" plans a scene,
    // whereas "给出完整正文" requests the prose itself.
    const actions = [...clause.matchAll(new RegExp(OUTPUT.source, 'gi'))];
    for (const target of clause.matchAll(new RegExp(rule.target.source, 'gi'))) {
        if (PLANNING_SUFFIX.test(clause.slice(target.index + target[0].length))) continue;
        if (actions.some(action => action.index + action[0].length <= target.index
            && DIRECT_TARGET_GAP.test(clause.slice(action.index + action[0].length, target.index)))) return true;
    }
    return false;
}

function scanOutput(content) {
    const positive = new Set(), negative = new Set(), ambiguous = new Set();
    const clauses = instructionClauses(content);
    const recognized = new Set();
    let hasOtherClauses = false;
    for (const [clauseIndex, clause] of clauses.entries()) {
        if (INFORMATIONAL.test(clause)) continue;
        const output = OUTPUT.test(clause) || MEMORY_WRITE.test(clause);
        if (!output) continue;
        const subclauses = clause.split(/[，,]/).map(part => part.trim()).filter(Boolean);
        for (const [index, rule] of RULES.entries()) {
            if (!rule.target.test(clause)) continue;
            if (NEGATION.test(clause)) { negative.add(index); continue; }
            if (index === 3 && INTERNAL_THINKING.test(clause)) continue;
            if (!DIRECTIVE.test(clause) && !subclauses.some(part => DIRECTIVE.test(part) && hasDirectTarget(part, rule))) continue;
            if (rule.periodic && !PERIODIC.test(clause) && !MEMORY_WRITE.test(clause)) continue;
            if (!hasDirectTarget(clause, rule) && !(index === 2 && MEMORY_WRITE.test(clause))) { ambiguous.add(index); continue; }
            positive.add(index);
            recognized.add(clauseIndex);
            // Preserve sentence-level negation above, then require each comma
            // subclause to be the output itself, a timing prefix, or a field list.
            if (subclauses.some(part =>
                !OUTPUT_TIMING.test(part) && !FIELD_LIST.test(part)
                && !(DIRECTIVE.test(part) && (hasDirectTarget(part, rule) || (index === 2 && MEMORY_WRITE.test(part)))))) hasOtherClauses = true;
        }
    }
    return { positive, negative, ambiguous, clauses, hasOtherClauses: hasOtherClauses || recognized.size !== clauses.length };
}

/** Conservative, local advice for a normalized preset. Never changes entries,
 * invokes models, resolves macros, or executes content from the imported file. */
export function analyzeImportedPreset(preset) {
    const result = { disable: [], review: [] };
    const prompts = new Map((preset?.prompts || []).map(prompt => [prompt.identifier, prompt]));
    const groups = new Map((preset?.groups || []).map(group => [group.id, group]));
    const seen = new Set();
    for (const entry of preset?.order || []) {
        const id = typeof entry === 'string' ? entry : entry?.identifier;
        const prompt = prompts.get(id);
        if (!prompt || seen.has(id) || entry?.enabled === false || prompt.marker || id === 'outline_output') continue;
        seen.add(id);
        const mapping = preset.promptGroups?.[id];
        const groupId = typeof mapping === 'string' ? mapping : mapping?.groupId;
        if (groups.get(groupId)?.enabled === false) continue;
        const content = typeof prompt.content === 'string' ? prompt.content : '';
        const name = typeof prompt.name === 'string' ? prompt.name : id;
        if (!content.trim() || hasPlanningProtocol(content)) continue;
        const add = (kind, reason) => result[kind].push({ id, name, reason });
        if (VARIABLE_DEFINITION.test(content)) { add('review', '含变量定义或赋值，保留以免影响其他条目的依赖。'); continue; }
        if (VARIABLE_READ.test(content)) { add('review', '含变量读取，展开后可能包含其他规则，需检查后再关闭。'); continue; }
        if (CONTENT_MACRO.test(content)) { add('review', '含角色、输入或其他内容宏，保留以免移除资料依赖。'); continue; }
        if (inspectMacros(content)) { add('review', '含未识别的宏，需人工检查含义与依赖。'); continue; }
        const { positive, negative, ambiguous, clauses, hasOtherClauses } = scanOutput(content);
        if (!positive.size) {
            if (ambiguous.size) add('review', '提到输出与正文或附加模块，但无法确认是否要求直接输出该内容。');
            else if (STYLE.test(name) || STYLE.test(content)) add('review', '涉及文风、视角或篇幅，可能需要适配大纲用途。');
            continue;
        }
        if (positive.has(3)) { add('review', '分析输出可保留查看，请放在 content 标签之外。'); continue; }
        if (MULTILINE_CONTEXT.test(content)) { add('review', '包含多行否定、示例或引用范围，需人工确认哪些内容是实际指令。'); continue; }
        if ([...positive].some(index => negative.has(index))) { add('review', '同类输出同时出现肯定和否定要求，保留等待人工判断。'); continue; }
        if (id === 'main' || /^\s*(?:主提示词|主规则|main\b)/i.test(name) || content.length > 1400 || clauses.length > 16 || positive.size > 1
            || hasOtherClauses || ambiguous.size || NARRATIVE_RULE.test(content) || STORY_CONTINUITY.test(content) || STYLE.test(name) || STYLE.test(content)) {
            add('review', '额外输出要求与人物、剧情、文风或复杂规则混合，不能整项自动关闭。'); continue;
        }
        const index = [...positive][0];
        if (!RULES[index].name.test(name)) { add('review', '正文含额外输出要求，但名称未明确标识独立模块。'); continue; }
        add('disable', `名称和内容均明确要求独立${RULES[index].label}。`);
    }
    return result;
}
