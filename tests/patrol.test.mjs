import test from 'node:test';
import assert from 'node:assert/strict';
import { patrolStory } from '../lib/patrol.js';
import { parseContent } from '../lib/content.js';
import { normalizePreset, compilePreset } from '../lib/preset.js';

const para = '窗外的雨一直下，街灯在湿漉漉的路面上拉出长长的影子，空气里有潮湿的泥土味道。';
const fresh = '码头传来汽笛声，货轮解开缆绳驶向外海，水手把一箱贴着封条的仪器搬进货舱。';
const user = text => ({ is_user: true, is_system: false, mes: text });
const assistant = text => ({ is_user: false, is_system: false, mes: text });
const stallChat = () => [
    user(para.repeat(8)), assistant(para.repeat(8)),
    user(para.repeat(8)), assistant(para.repeat(8)),
    user(para.repeat(8)), assistant(para.repeat(8)),
];
const tierPreset = (orderEnabled, groupsEnabled = true) => ({
    groups: [{ id: 'outline_tiers', enabled: groupsEnabled }, { id: 'outline_tone', enabled: groupsEnabled }],
    promptGroups: { tier_a: 'outline_tiers', tone_a: 'outline_tone', main: '' },
    order: [{ identifier: 'tier_a', enabled: orderEnabled }, { identifier: 'tone_a', enabled: false }, { identifier: 'main', enabled: true }],
});
const longChat = () => Array.from({ length: 12 }, (_, i) => (i % 2 ? assistant(`回复 ${i}`) : user(`输入 ${i}`)));

test('patrol flags consecutive prose rounds with almost no new information', () => {
    const notices = patrolStory({ chat: stallChat(), rounds: 2 });
    assert.ok(notices.some(text => text.includes('原地空转')));
});

test('patrol stays quiet when the latest prose brings new information', () => {
    const chat = stallChat();
    chat[chat.length - 1] = assistant(fresh.repeat(8));
    const notices = patrolStory({ chat, rounds: 2 });
    assert.ok(!notices.some(text => text.includes('原地空转')));
});

test('patrol requires enough consecutive rounds and enough baseline', () => {
    const short = [user(para.repeat(8)), assistant(para.repeat(8))];
    assert.deepEqual(patrolStory({ chat: short, rounds: 2 }), []);
    const notices = patrolStory({ chat: stallChat(), rounds: 3 });
    assert.ok(!notices.some(text => text.includes('原地空转')), 'early rounds lack a large enough baseline');
});

test('patrol flags a rewritten outline with the same plot and unchanged end state', () => {
    const previousPlanXml = '<content><plot>接过信，仍保留戒备。</plot><characters>不涉及</characters><segments><segment index="1">接信。</segment></segments><end_state>信未拆开，等待回应。</end_state></content>';
    const currentPlan = { plot: '接过信，仍保留戒备。', endState: '信未拆开，等待回应。' };
    const notices = patrolStory({ chat: [], currentPlan, previousPlanXml });
    assert.ok(notices.some(text => text.includes('同一件事')));
    const moved = patrolStory({ chat: [], currentPlan: { plot: '接过信，仍保留戒备。', endState: '信已拆开，约定明晚在码头见面。' }, previousPlanXml });
    assert.ok(!moved.some(text => text.includes('同一件事')));
    assert.deepEqual(patrolStory({ chat: [], currentPlan, previousPlanXml: '不是大纲' }), []);
    const v2Previous = '<content><direction>接过信，仍保留戒备。</direction><beats><beat index="1"><event>接信。</event></beat></beats><anchors>无</anchors><end_state>信未拆开，等待回应。</end_state></content>';
    assert.ok(patrolStory({ chat: [], currentPlan, previousPlanXml: v2Previous }).some(text => text.includes('同一件事')));
});

test('patrol reads V3 background without treating its absent end_state as an unchanged ending', () => {
    const xml = '<content><background>雨夜，双方仍误认彼此身份。</background><characters><character name="江敛之"><state>他仍在旁观。</state><change>荒谬感中生出了兴致。</change><relationship>现实关系处于初识，虚拟扮演尚未形成真实好感。</relationship><choice>他选择配合但暂不坦白。</choice></character></characters><direction>扮演关系与身份谜团继续发酵。</direction></content>';
    const currentPlan = parseContent(xml);
    assert.deepEqual(patrolStory({ chat: [], currentPlan, previousPlanXml: xml }), []);
    const v1 = '<content><plot>雨夜，双方仍误认彼此身份。</plot><characters>不涉及</characters><segments><segment index="1">继续对话。</segment></segments><end_state>误认仍未解除。</end_state></content>';
    assert.deepEqual(patrolStory({ chat: [], currentPlan, previousPlanXml: v1 }), []);
});

test('patrol suggests manual tiers only for long chats with every tier disabled', () => {
    const notices = patrolStory({ chat: longChat(), preset: tierPreset(false), rounds: 2 });
    assert.ok(notices.some(text => text.includes('档位')));
    assert.ok(!patrolStory({ chat: longChat(), preset: tierPreset(true), rounds: 2 }).some(text => text.includes('档位')));
    assert.ok(!patrolStory({ chat: longChat(), preset: tierPreset(false, false), rounds: 2 }).some(text => text.includes('未启用')), 'group-level off means the user chose this');
    assert.deepEqual(patrolStory({ chat: stallChat(), preset: tierPreset(false), rounds: 2 }).filter(text => text.includes('档位')), []);
});

test('inspection note compiles once before the current input, only when carried', () => {
    const preset = normalizePreset({ prompts: [{ identifier: 'plan', name: 'plan', content: '规划', role: 'system' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'plan', enabled: true }] }] });
    const context = { user: '苏青', char: '林澄', currentInput: '她递出信。', animaMemory: '记忆', animaStatus: 'success' };
    const carried = compilePreset(preset, { context: { ...context, inspectionNote: '剧情可能在原地空转。' } });
    const noteIndex = carried.messages.findIndex(message => message.content.includes('【本地巡检提示】'));
    const inputIndex = carried.messages.findIndex(message => message.content.includes('【本轮当前 user_input】'));
    assert.ok(noteIndex !== -1 && inputIndex !== -1 && noteIndex < inputIndex);
    assert.equal(carried.messages.filter(message => message.content.includes('【本地巡检提示】')).length, 1);
    const plain = compilePreset(preset, { context });
    assert.ok(!JSON.stringify(plain.messages).includes('本地巡检提示'));
});
