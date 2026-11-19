const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(`${__dirname}/extension.js`, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class OskShortcuts', 'globalThis.OskShortcuts = class OskShortcuts');
const context = {Extension: class {}, Clutter: {}};vm.createContext(context);
vm.runInContext(source+'\nglobalThis.entries = GROUPS.flat();', context);
const entries = context.entries;
assert.equal(entries.length, 9);
assert(!entries.some(e => ['left','up','down','right'].includes(e.id)), 'toolbar arrows removed');
assert.deepEqual(Array.from(entries, e => e.id), ['language','select-all','cut','copy','paste','clipboard','undo','redo','screenshot']);
const ext = new context.OskShortcuts(), classes = new Set();let changes = 0;
Object.assign(ext, {_toolbarLayoutKey: null,
    _toolbarGroups: [{actor: {}, ids: ['language']},
        {actor: {}, ids: ['select-all','cut','copy','paste','clipboard']},
        {actor: {}, ids: ['undo','redo','screenshot']}],
    _buttons: new Map(entries.map(e => [e.id, {_tbLabel: {visible: !e.compact}}])),
    _bar: {add_style_class_name(c) {classes.add(c);changes++;}, remove_style_class_name(c) {classes.delete(c);changes++;}}});
ext._syncToolbarLayout(823);
assert([...ext._buttons.values()].every(b => b._tbLabel.visible), 'wide toolbar shows action labels');
const previous = changes;ext._syncToolbarLayout(823);assert.equal(changes, previous, 'stable width does not invalidate styles each poll');
ext._syncToolbarLayout(727);
for (const e of entries) assert.equal(ext._buttons.get(e.id)._tbLabel.visible, !e.compact);
ext._syncToolbarLayout(600);assert(classes.has('tb-osk-toolbar-narrow'));
for (const e of entries) assert.equal(ext._buttons.get(e.id)._tbLabel.visible, !e.icon && !e.compact);
ext._syncToolbarLayout(823);assert(!classes.has('tb-osk-toolbar-narrow'));
assert([...ext._buttons.values()].every(b => b._tbLabel.visible));
ext._syncToolbarLayout(253);
assert.deepEqual([...ext._buttons.entries()].filter(([,b]) => b.visible).map(([id]) => id), ['select-all','copy','paste','clipboard']);
assert.deepEqual(ext._toolbarGroups.map(g => g.actor.visible), [false,true,false]);
ext._syncToolbarLayout(823);assert([...ext._buttons.values()].every(b => b.visible && b._tbLabel.visible));
assert(ext._toolbarGroups.every(g => g.actor.visible));
console.log('Nine toolbar actions, no duplicate Tab/arrows, narrow keypad actions, width restoration and cached style updates passed');
