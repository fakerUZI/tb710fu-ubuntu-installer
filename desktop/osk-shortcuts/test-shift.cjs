const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(`${__dirname}/shift-modifier.js`, 'utf8')
    .replace('export class TerminalShiftModifier', 'globalThis.TerminalShiftModifier = class TerminalShiftModifier');
const ctx = {};vm.createContext(ctx);vm.runInContext(source, ctx);
const SHIFT = 0xffe1, LEFT = 0xff51, TAB = 0xff09, TERMINAL = 10;
const events = [], seen = [], purposes = [], selectedLevels = [], disconnected = [];
let fail = false, closed = 0;
const controller = {purpose: TERMINAL,
    keyvalPress(k) {if (fail && k === LEFT) throw Error('input failed');events.push(['down', k]);},
    keyvalRelease(k) {events.push(['up', k]);}};
let row = [{action: 'levelSwitch', iconName: 'osk-shift-symbolic', level: 'shift', width: 2},
    {strings: ['z']}, {action: 'levelSwitch', iconName: 'osk-shift-symbolic', level: 'shift'}];
const caps = [{action: 'levelSwitch', iconName: 'osk-caps-lock-symbolic', level: 'shift'}];
const layout = {get_children: () => []};
const keyboard = {_keyboardController: controller, _modifiers: new Set(), _modifierKeys: {},
    _layers: {default: {}, shift: {}},
    _setActiveLevel(level) {assert(this._layers[level], 'native setter cannot select a missing layer');selectedLevels.push(level);},
    _addRowKeys(keys) {seen.push(keys);},
    _updateLayout(_group, purpose) {purposes.push(purpose);this._addRowKeys(row, layout, true);},
    _updateKeys() {this._addRowKeys(row, layout, true);},
    close() {closed++;}, get_parent() {return true;},
    _setModifierEnabled(k, enabled) {if (enabled) this._modifiers.add(k);else this._modifiers.delete(k);}};
const originals = {add: keyboard._addRowKeys, level: keyboard._setActiveLevel, layout: keyboard._updateLayout, update: keyboard._updateKeys, close: keyboard.close,
    press: controller.keyvalPress, release: controller.keyvalRelease};
const ext = new ctx.TerminalShiftModifier(keyboard, SHIFT, TERMINAL, undefined, [2, 3, 4], {disconnect: id => disconnected.push(id)});
keyboard._layers = {default: {}};keyboard._setActiveLevel('shift');assert.equal(selectedLevels.at(-1), 'default');
keyboard._surroundingTextId = 42;keyboard._updateKeys();assert.deepEqual(disconnected, [42]);assert.equal(keyboard._surroundingTextId, 0);
keyboard._layers = {default: {}, shift: {}};keyboard._setActiveLevel('shift');assert.equal(selectedLevels.at(-1), 'shift');
assert.equal(seen[0][0].action, 'modifier');assert.equal(seen[0][0].label, 'Shift');
assert.equal(seen[0][0].keyval, SHIFT);assert.equal(seen[0][0].width, 2);
assert.equal(seen[0][2], row[2], 'right size-switch key remains native');
assert.equal(row[0].action, 'levelSwitch', 'do not mutate native layout definitions');
keyboard._addRowKeys(caps, layout, true);assert.equal(seen.at(-1), caps, 'upper Caps remains intact');
controller.purpose = 0;keyboard._addRowKeys(row, layout, true);
assert.equal(seen.at(-1), row, 'normal input layout remains intact');controller.purpose = TERMINAL;
controller.purpose = 0;keyboard._updateLayout('us', 0);
assert.equal(purposes.at(-1), TERMINAL);assert.equal(seen.at(-1)[0].action, 'modifier');
assert.equal(controller.purpose, 0, 'visual layout must not change the app input purpose');
keyboard._updateLayout('us', 1);assert.equal(purposes.at(-1), TERMINAL);
for (const purpose of [5, 6, 7, 8, 9]) {
    controller.purpose = purpose;keyboard._updateLayout('us', purpose);
    assert.equal(purposes.at(-1), TERMINAL, 'URL/email/name/password/PIN use the extended layout');
    assert.equal(seen.at(-1)[0].action, 'modifier');assert.equal(controller.purpose, purpose);
}
for (const purpose of [2, 3, 4]) {
    controller.purpose = purpose;keyboard._updateLayout('us', purpose);
    assert.equal(purposes.at(-1), purpose, 'digits/number/phone keep the native numeric keypad');
    assert.equal(seen.at(-1), row);
}
controller.purpose = TERMINAL;
keyboard._setModifierEnabled(SHIFT, true);
for (const key of [LEFT, LEFT, TAB]) {controller.keyvalPress(key);controller.keyvalRelease(key);}
assert.deepEqual(events, [LEFT, LEFT, TAB].flatMap(k => [['down', SHIFT], ['down', k], ['up', k], ['up', SHIFT]]));
assert(keyboard._modifiers.has(SHIFT), 'arrows and Tab preserve the selected modifier');
events.length = 0;
// Native text commit already brackets the character with its modifier set.
for (const k of [SHIFT, 97]) controller.keyvalPress(k);
for (const k of [97, SHIFT]) controller.keyvalRelease(k);
assert.deepEqual(events, [['down', SHIFT], ['down', 97], ['up', 97], ['up', SHIFT]], 'no duplicate Shift around text');
events.length = 0;fail = true;
assert.throws(() => controller.keyvalPress(LEFT), /input failed/);
assert.deepEqual(events, [['down', SHIFT], ['up', SHIFT]], 'failed key cannot leave Shift pressed');fail = false;
keyboard.close();assert.equal(closed, 1);assert(!keyboard._modifiers.has(SHIFT));
events.length = 0;controller.keyvalPress(LEFT);controller.keyvalRelease(LEFT);
assert.deepEqual(events, [['down', LEFT], ['up', LEFT]], 'plain key after clearing');
keyboard._setModifierEnabled(SHIFT, true);keyboard._updateKeys();
assert(!keyboard._modifiers.has(SHIFT), 'layout changes clear selected Shift');
// The extended bottom row must gain a comma without growing or reflowing.
row = [{action: 'modifier', keyval: '0xffe3', label: 'Ctrl'},
    {action: 'levelSwitch', label: '?123', level: 'opt'},
    {action: 'modifier', keyval: '0xffe9', label: 'Alt'},
    {strings: [' '], width: 4},
    {action: 'emoji', iconName: 'osk-emoji-picker-symbolic'},
    {action: 'languageMenu', iconName: 'osk-layout-symbolic'},
    {iconName: 'go-previous-symbolic', keyval: LEFT},
    {iconName: 'go-down-symbolic', keyval: 0xff54},
    {iconName: 'go-next-symbolic', keyval: 0xff53},
    {action: 'hide', iconName: 'osk-hide-symbolic'}];
const native = row.map(key => ({...key}));
keyboard._updateLayout('us', 0);
const bottom = seen.at(-1);
const label = key => key.label ?? key.strings?.[0] ?? key.action ?? key.iconName;
assert.deepEqual(bottom.map(label), ['Ctrl', '?123', 'Alt', 'emoji', ' ', 'languageMenu', ',',
    'go-previous-symbolic', 'go-down-symbolic', 'go-next-symbolic', 'hide'],
'Alt, comma, emoji and language menu reach the thumb-reachable slots');
assert.equal(bottom.reduce((sum, key) => sum + (key.width ?? 1), 0), 13,
    'the bottom row keeps its total width');
assert.equal(bottom.find(key => key.strings?.[0] === ' ').width, 3,
    'the space bar gives one column to the injected Alt');
assert.deepEqual(row, native, 'the native bottom-row definition is not mutated');
const symbolLayout = {mode: 'locked', get_children: () => []};
const positions = new Map();
for (const [toggleLabel, toggleLevel, punctuation] of [
    ['⇧ []{}|', 'opt+shift', ['_', '/']], ['⇧ ?123', 'opt', ['<', '>']],
]) {
    const advanced = toggleLevel === 'opt';
    const toggle = {action: 'levelSwitch', level: toggleLevel, label: advanced ? '?123' : '=/<'};
    const makeKeys = characters => Array.from(characters, value => ({strings: [value]}));
    const rows = [
        [...makeKeys(advanced ? '~`|•√Π÷×¶∆' : '1234567890'), {action: 'delete', width: 1.5}],
        [{strings: [advanced ? '£' : '@'], leftOffset: 0.5},
            ...makeKeys(advanced ? '¢€¥^°={}' : '#$%&-+()'), {iconName: 'osk-enter-symbolic', width: 2}],
        [{...toggle, width: 1.5}, ...makeKeys(advanced ? '\\©®™℅[]' : ['*', '"', "'", ':', ';', '!', '?']),
            {...toggle, width: 3}],
        [{action: 'levelSwitch', level: 'default', label: 'ABC', width: 1.5},
            ...makeKeys(punctuation), {strings: [' '], width: 3}, {strings: [',']}, {strings: ['.', '…']},
            {action: 'emoji'}, {action: 'languageMenu'}, {action: 'hide'}],
    ];
    const original = JSON.stringify(rows);
    const start = seen.length;
    rows.forEach(keys => keyboard._addRowKeys(keys, symbolLayout, true));
    const rendered = seen.slice(start);
    assert.equal(rendered.length, 4, 'keep the four rows used for letter entry');
    assert.equal(JSON.stringify(rows), original, 'native model stays intact');
    const strings = keys => keys.flatMap(key => key.strings ?? []);
    const extra = advanced ? ['≤', '≥', '≠', '±'] : ['='];
    assert.equal(rendered[3][7].strings[0], advanced ? '±' : '=');
    assert(!rendered[3].some(key => key.action === 'languageMenu'));
    assert.deepEqual([...rows.flatMap(strings), ...extra].sort(), rendered.flatMap(strings).sort(),
        'keep all symbols and long-press variants');
    if (advanced) {
        assert.deepEqual(Array.from(rendered[0].slice(1, 4), key => key.strings[0]), ['|', '`', '~']);
        assert.deepEqual(Array.from(rendered[1].slice(1, 3), key => key.strings[0]), ['{', '}']);
        assert.deepEqual(Array.from(rendered[2].slice(1, 7), key => key.strings[0]),
            ['[', ']', '\\', '≤', '≥', '≠']);
        assert.deepEqual(Array.from(rendered[2][7].strings), ['©', '®', '™', '℅']);
    }
    rendered.forEach((keys, rowIndex) => {
        let column = 0;
        keys.forEach(key => {
            column += key.leftOffset ?? 0;
            positions.set(key.label ?? key.iconName, [rowIndex, column]);
            column += key.width ?? 1;
        });
        assert.equal(column, 13, 'use the letter keyboard width');
    });
    for (const [name, position] of [
        ['Tab', [0, 0]], ['中符', [1, 0]], ['Shift', [2, 0]], ['go-up-symbolic', [2, 10]],
        ['Ctrl', [3, 0]], ['ABC', [3, 1]], ['Alt', [3, 2]],
        ['go-previous-symbolic', [3, 9]], ['go-down-symbolic', [3, 10]], ['go-next-symbolic', [3, 11]],
        [toggleLabel, [2, 11]],
    ]) assert.deepEqual(positions.get(name), position);
    assert.equal(parseInt(rendered[0][0].keyval, 16), TAB, 'GNOME reads raw keyvals in base 16');
    assert.equal(rendered[1][0].action, 'tbSymbolLanguage');
    ext._chineseSymbols = true;
    const chineseStart = seen.length;
    rows.forEach(keys => keyboard._addRowKeys(keys, symbolLayout, true));
    const localized = seen.slice(chineseStart);
    assert.equal(localized[1][0].label, '英符');
    assert.equal(localized[1].at(-2).strings[0], '，');
    assert.equal(localized[2].at(-3).strings[0], '。');
    assert.equal(localized[2].at(-3).strings[1], '……');
    assert.equal(localized[0][1].strings[0], advanced ? '|' : '1');
    if (advanced) {
        assert.equal(localized[2][1].strings[0], '【');
        assert(localized[2][1].strings.includes('['), 'ASCII remains accessible in Chinese mode');
    }
    for (const [index, keys] of localized.entries())
        assert.equal(keys.length, rendered[index].length, 'punctuation switch preserves key positions');
    ext._chineseSymbols = false;
    keyboard._addRowKeys(rows[0], layout, true);
    assert.equal(seen.at(-1), rows[0], 'unlocked layout stays intact');
}
row = native.map(key => ({...key}));
ext.destroy();
assert.equal(keyboard._addRowKeys, originals.add);assert.equal(keyboard._updateKeys, originals.update);
assert.equal(keyboard._updateLayout, originals.layout);
assert.equal(keyboard._setActiveLevel, originals.level);
assert.equal(keyboard.close, originals.close);assert.equal(controller.keyvalPress, originals.press);
assert.equal(controller.keyvalRelease, originals.release);assert.equal(seen.at(-1), row);
console.log('Unified text/URL/email/password/terminal layout, numeric-keypad preservation, bottom-row comma, retained Caps, Shift arrows/Tab, native text and restoration passed');
