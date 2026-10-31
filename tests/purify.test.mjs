import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContent } from '../lib/content.js';
import { polishMessages, validatePolish, POLISH_SYSTEM_PROMPT } from '../lib/purify.js';

const original = parseContent('<content><plot>世界背景：旧城。\n本轮方向：递信。</plot><characters><character name="林澄"><emotion>戒备被一句话撬开。</emotion><response>接过信。</response></character><character name="苏青"><emotion>平静。</emotion><response>递信。</response></character></characters><segments><segment index="1">递信。【逐字保留】“给你。”【口吻】短句。</segment><segment index="2">他拆信。</segment></segments><end_state>本轮状态：信已交出。</end_state></content>');

test('polish messages pin the rewrite task and carry the outline verbatim', () => {
    const messages = polishMessages(original.xml);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, original.xml);
    assert.match(POLISH_SYSTEM_PROMPT, /只改语言，不改内容/);
    assert.match(POLISH_SYSTEM_PROMPT, /逐字照抄/);
});

test('language-only rewrites pass validation', () => {
    const purified = parseContent('<content><plot>世界背景：旧城。\n本轮方向：递信。</plot><characters><character name="林澄"><emotion>戒备有所松动。</emotion><response>接过信。</response></character><character name="苏青"><emotion>平静。</emotion><response>递信。</response></character></characters><segments><segment index="1">她把信递过去。【逐字保留】“给你。”【口吻】短句。</segment><segment index="2">他拆开信。</segment></segments><end_state>本轮状态：信已交出。</end_state></content>');
    assert.equal(validatePolish(original, purified), true);
});

test('changed cast, segment count or handoff markers fall back to the original', () => {
    const droppedCharacter = parseContent('<content><plot>世界背景：旧城。\n本轮方向：递信。</plot><characters><character name="林澄"><emotion>戒备。</emotion><response>接信。</response></character></characters><segments><segment index="1">递信。【逐字保留】“给你。”【口吻】短句。</segment><segment index="2">拆信。</segment></segments><end_state>本轮状态：信已交出。</end_state></content>');
    assert.equal(validatePolish(original, droppedCharacter), false);
    const mergedSegments = parseContent('<content><plot>世界背景：旧城。\n本轮方向：递信。</plot><characters><character name="林澄"><emotion>戒备。</emotion><response>接信。</response></character><character name="苏青"><emotion>平静。</emotion><response>递信。</response></character></characters><segments><segment index="1">递信并拆信。【逐字保留】“给你。”【口吻】短句。</segment></segments><end_state>本轮状态：信已交出。</end_state></content>');
    assert.equal(validatePolish(original, mergedSegments), false);
    const droppedMarker = parseContent('<content><plot>世界背景：旧城。\n本轮方向：递信。</plot><characters><character name="林澄"><emotion>戒备。</emotion><response>接信。</response></character><character name="苏青"><emotion>平静。</emotion><response>递信。</response></character></characters><segments><segment index="1">递信。【逐字保留】“给你。”</segment><segment index="2">拆信。</segment></segments><end_state>本轮状态：信已交出。</end_state></content>');
    assert.equal(validatePolish(original, droppedMarker), false);
    assert.equal(validatePolish(original, null), false);
});

test('content-v2 polish preserves optional beat fields and rejects dropped choices', () => {
    const v2 = parseContent('<content><direction>雨夜各自的事务交汇。</direction><beats><beat index="1"><event>店员承认录错订单。</event><emotion>她从侥幸转为紧张。</emotion></beat><beat index="2"><event>外卖员来取餐。</event><choice>常客主动留下帮忙。</choice></beat></beats><anchors>【口吻】店员说话直接。</anchors><end_state>众人开始各自行动。</end_state></content>');
    const rewritten = parseContent('<content><direction>雨夜里，众人的事务发生交汇。</direction><beats><beat index="1"><event>店员向店主说明自己录错了订单。</event><emotion>她不再侥幸，开始紧张。</emotion></beat><beat index="2"><event>外卖员进店取走订单。</event><choice>常客自愿留下帮忙。</choice></beat></beats><anchors>【口吻】店员说话直接。</anchors><end_state>众人各自开始下一步。</end_state></content>');
    assert.equal(validatePolish(v2, rewritten), true);
    const droppedChoice = parseContent('<content><direction>雨夜各自的事务交汇。</direction><beats><beat index="1"><event>店员承认录错订单。</event><emotion>她从侥幸转为紧张。</emotion></beat><beat index="2"><event>外卖员来取餐，常客主动留下帮忙。</event></beat></beats><anchors>【口吻】店员说话直接。</anchors><end_state>众人开始各自行动。</end_state></content>');
    assert.equal(validatePolish(v2, droppedChoice), false);
    assert.equal(validatePolish(original, v2), false);
});

test('content-v3 polish preserves mandatory emotional and choice fields', () => {
    const v3 = parseContent('<content><background>雨夜，误认仍未澄清。</background><characters><character name="江敛之"><state>他旁观陌生人的角色扮演要求。</state><change>对方生硬的提示词先让他觉得荒谬，亲昵称呼又带来轻微不适；他随后生出兴致，但仍没有真实亲密感。</change><choice>他选择配合扮演，保留调侃与试探，暂不坦白身份。</choice></character></characters><direction>扮演关系与身份谜团继续发酵。</direction></content>');
    const rewritten = parseContent('<content><background>雨夜里，双方的身份误认尚未解除。</background><characters><character name="江敛之"><state>他正在旁观一个陌生人提出的角色扮演要求。</state><change>生硬的提示词使他感到荒谬，亲昵称呼又令他略有不适；之后他产生了兴致，尚未形成真实的亲密感。</change><choice>他愿意参与扮演，同时继续调侃和试探，暂时不说明真实身份。</choice></character></characters><direction>扮演关系继续发展，身份谜团也持续存在。</direction></content>');
    assert.equal(validatePolish(v3, rewritten), true);
    for (const field of ['state', 'change', 'choice']) {
        const damaged = structuredClone(v3);
        delete damaged.characters[0][field];
        assert.equal(validatePolish(v3, damaged), false, field);
    }
    assert.equal(validatePolish(v3, null), false);
});
