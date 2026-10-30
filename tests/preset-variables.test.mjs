import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreset, normalizePreset } from '../lib/preset.js';

const context = { currentInput: '她递出信。', char: '林澄', animaStatus: 'empty', animaMemory: '' };
function preset(contents, extra = {}) {
    return normalizePreset({ prompts: contents.map((content, i) => ({ identifier: `p${i}`, name: `条目 ${i}`, content })),
        order: contents.map((_, i) => ({ identifier: `p${i}`, enabled: true })), ...extra });
}
function compile(contents, options = {}) { return compilePreset(preset(contents), { context, ...options }); }
const promptText = result => result.entries.filter(entry => entry.kind === 'prompt').flatMap(entry => entry.messages.map(message => message.content)).join('\n');

test('text additions preserve multiline values, separators and nested context across entries', () => {
    const result = compile([
        '{{setvar::rules::保留{{char}}的戒备。}}{{setglobalvar::rules::独立规则。}}',
        '{{addvar::rules::\n  不越过已知::未知的边界。 }}{{addglobalvar::rules::\n保留原有约定。}}',
        '本轮规则：\n{{getvar::rules}}\n全局规则：\n{{getglobalvar::rules}}',
    ]);
    assert.equal(promptText(result), '本轮规则：\n保留林澄的戒备。\n  不越过已知::未知的边界。 \n全局规则：\n独立规则。\n保留原有约定。');
    assert.deepEqual(result.entries.slice(0, 2).map(entry => entry.messages), [[], []]);
    assert.deepEqual(result.warnings, []);
});

test('add/inc/dec support numbers, missing variables, strings and JSON arrays in both dictionaries', () => {
    for (const scope of ['', 'global']) {
        const result = compile([
            `{{add${scope}var::n::2.5}}{{add${scope}var::n::-1}}n={{inc${scope}var::n}}/{{dec${scope}var::n}}`,
            `{{add${scope}var::text::甲}}{{add${scope}var::text::乙}}text={{get${scope}var::text}}`,
            `{{set${scope}var::list::["甲"]}}{{add${scope}var::list::乙}}list={{get${scope}var::list}}`,
            `missing={{dec${scope}var::missing}}`,
        ]);
        assert.equal(promptText(result), 'n=2.5/1.5\ntext=甲乙\nlist=["甲","乙"]\nmissing=-1');
        assert.deepEqual(result.warnings, []);
    }
});

test('existence distinguishes empty values from deleted or missing values and supports aliases', () => {
    for (const scope of ['', 'global']) {
        const exists = scope ? 'globalvarexists' : 'varexists';
        const result = compile([
            `{{has${scope}var::x}}/{{set${scope}var::x::}}{{has${scope}var::x}}/{{${exists}::x}}`,
            `{{delete${scope}var::x}}{{has${scope}var::x}}/{{set${scope}var::x::0}}{{flush${scope}var::x}}{{${exists}::x}}`,
        ]);
        assert.equal(promptText(result), 'false/true/true\nfalse/false');
        assert.deepEqual(result.warnings, []);
    }
});

test('single-argument spaces and legacy colon forms work case-insensitively with dynamic names', () => {
    const result = compile([
        '{{SETVAR::key::计数}}{{setvar::{{getvar key}}::1}}{{ADDVAR::计数::2}}',
        '{{GETVAR 计数}}/{{incvar:计数}}/{{decvar 计数}}/{{HASVAR:计数}}',
        '{{setglobalvar::g::全局}}{{getglobalvar g}}/{{globalvarexists g}}{{flushglobalvar g}}/{{hasglobalvar g}}',
        '{{setvar::copy::{{getvar 计数}}}}{{getvar:copy}}',
    ]);
    assert.equal(promptText(result), '3/4/3/true\n全局/true/false\n3');
});

test('disabled entries and groups cannot append, increment or delete earlier values', () => {
    const p = preset([
        '{{setvar::n::1}}{{setglobalvar::rules::保留}}',
        '{{incvar::n}}{{deleteglobalvar::rules}}',
        '{{addvar::n::9}}{{addglobalvar::rules::错误}}',
        '{{getvar::n}}/{{getglobalvar::rules}}',
    ], {
        order: ['p0', 'p1', 'p2', 'p3'].map(identifier => ({ identifier, enabled: identifier !== 'p1' })),
        groups: [{ id: 'off', name: '关闭组', enabled: false }], promptGroups: { p2: 'off' },
    });
    assert.equal(promptText(compilePreset(p, { context })), '1/保留');
});

test('each compilation starts fresh and never mutates the supplied local/global dictionaries', () => {
    const variables = { n: '10', text: '旧' }, globalVariables = { n: '20' };
    const contents = ['{{incvar::n}}/{{incglobalvar::n}}{{addvar::text::新}}{{deleteglobalvar::n}}'];
    for (let i = 0; i < 2; i++) {
        assert.equal(promptText(compile(contents, { variables, globalVariables })), '11/21');
        assert.equal(promptText(compile(contents)), '1/1');
    }
    assert.deepEqual(variables, { n: '10', text: '旧' });
    assert.deepEqual(globalVariables, { n: '20' });
});

test('commented variable changes and variable-looking context stay literal', () => {
    const result = compile([
        '{{setvar::n::1}}{{// {{incvar::n}}}}{{//}}忽略{{deletevar::n}}{{///}}{{getvar::n}}',
        '{{setvar::text::{{char}}}}{{addvar::text::安全}}{{getvar::text}}',
    ], { context: { ...context, char: '{{incvar::n}}' } });
    assert.equal(promptText(result), '1\n{{incvar::n}}安全');
    assert.equal(result.variables.n, '1');
});

test('prototype-like keys are ordinary private variable names', () => {
    const result = compile(['{{hasvar::constructor}}{{addvar::__proto__::安全}}{{incvar::constructor}}/{{getvar::__proto__}}{{deletevar::constructor}}/{{hasvar::constructor}}']);
    assert.equal(promptText(result), 'false1/安全/false');
    assert.equal(Object.getPrototypeOf(result.variables), null);
    assert.equal(Object.prototype.polluted, undefined);
});

test('malformed operations identify their entry and unsupported syntax remains explicit', () => {
    for (const content of ['{{addvar::x}}', '{{incvar}}', '{{hasglobalvar::}}', '{{deletevar::x::extra}}', '{{getvar::x::extra}}']) {
        assert.throws(() => compile([content]), error => error.code === 'MACRO_INVALID' && error.message.startsWith('条目「条目 0」：'));
    }
    for (const content of ['{{random::a::b}}', '{{unknown x}}', '{{.x}}', '{{if::true}}yes{{/if}}']) {
        assert.throws(() => compile([content]), { code: 'MACRO_UNSUPPORTED' });
    }
    const missing = compile(['{{getvar::x}}/{{getglobalvar x}}']);
    assert.equal(promptText(missing), '/');
    assert.ok(missing.warnings.some(warning => warning.includes('尚未在此预设中赋值')));
});

test('runaway additions and non-finite arithmetic fail before a request can be sent', () => {
    assert.throws(() => compile(['{{addvar::x::{{getvar::x}}}}'], { variables: { x: 'x'.repeat(1_000_001) } }), { code: 'MACRO_LIMIT' });
    assert.throws(() => compile(['{{setvar::n::1e308}}{{addvar::n::1e308}}']), { code: 'MACRO_INVALID' });
});
