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
