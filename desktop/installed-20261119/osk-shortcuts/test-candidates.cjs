const fs = require('fs'), vm = require('vm'), assert = require('assert');
const context = {Pango: {EllipsizeMode: {END: 3}}};vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/candidate-row.js`, 'utf8').replace(/^import .*;\n/gm, '')
    .replace('export class CandidateRow', 'globalThis.CandidateRow = class CandidateRow'), context);
let children = [], resets = 0, adds = 0, widthSets = 0, styleSets = 0;
const suggestions = {get_children: () => children, set_style() {styleSets++;}};
const manager = {resetSuggestions() {resets++;children = [];}, addSuggestion(label, callback) {
    adds++;let width = 0;
    children.push({label, callback, get width() {return width;}, set width(value) {width = value;widthSets++;},
        set_style() {styleSets++;}, remove_all_transitions() {}, get_child: () => ({clutter_text: {}})});
}};
const row = new context.CandidateRow(manager, suggestions), selected = [], pages = [];
const onSelect = index => selected.push(index), onPage = direction => pages.push(direction);
row.setWidth(823);row.update(['你','你好','你们','你是','你要'], false, true, onSelect, onPage);
assert.equal(adds, 7);assert.equal(row.visibleCount(), 6);
const originals = [...children], widths = children.map(b => b.width);
assert.deepEqual(widths, [44,129,129,129,129,129,44]);
const positions = () => {let x = 12;return children.map(b => {const left = x+2;x += b.width+4+6;return left;});};
const x = positions(), writes = widthSets, styles = styleSets;
for (const [words, prev, next] of [
    [['你好','你号','拟好','逆号','泥好'],true,true],
    [['你'],false,false],
    [[],false,false],
    [['中文','中文输入','中午','中心','中国'],false,true],
]) {
    row.update(words,prev,next,onSelect,onPage);row.setWidth(823);
    assert(children.every((b,i) => b===originals[i]), 'updates reuse the same native touch actors');
    assert.deepEqual(children.map(b => b.width),widths);assert.deepEqual(positions(),x);
}
assert.equal(adds,7);assert.equal(widthSets,writes);assert.equal(styleSets,styles);
children[1].callback();assert.deepEqual(selected,[0]);children[6].callback();assert.deepEqual(pages,[1]);
row.update(['一'],true,false,onSelect,onPage);children[0].callback();children[5].callback();children[6].callback();
assert.deepEqual(pages,[1,-1]);assert.deepEqual(selected,[0]);assert.equal(children[5].opacity,0);assert.equal(children[5].reactive,false);
row.update([],false,false,onSelect,onPage);assert(!row.active);assert.equal(row.visibleCount(),0);
children[1].callback();assert.deepEqual(selected,[0]);assert(children.every(b => b.opacity===0 && !b.reactive));
row.setWidth(727);assert.deepEqual(children.map(b => b.width),[44,110,110,110,110,110,44]);
manager.resetSuggestions();row.update(['新','新词'],false,true,onSelect,onPage);assert.equal(adds,14);assert(row.ownsSuggestions());
row.destroy();assert.equal(children.length,0);assert(!row.active);

// All table signals in a single frame coalesce to the final table before paint.
const pending = new Map();let nextId = 0, updates = 0, finalTable;
const Main = {inputMethod: {content_purpose: 0}}, GLib = {SOURCE_REMOVE: false};
const c = {Extension: class {}, Clutter: {}, Main, GLib, Meta: {LaterType: {BEFORE_REDRAW: 4}},
    global: {compositor: {get_laters: () => ({add(_type,cb) {pending.set(++nextId,cb);return nextId;}})}}};
vm.createContext(c);vm.runInContext(fs.readFileSync(`${__dirname}/extension.js`, 'utf8').replace(/^import .*;\n/gm, '')
    .replace('export default class OskShortcuts', 'globalThis.OskShortcuts = class OskShortcuts'),c);
const ext = new c.OskShortcuts();Object.assign(ext,{_candidateRow:{setWidth() {},update(...args) {updates++;finalTable=args[0];}},
    _slot:{width:823},_syncWidth(){},_syncRow(){}});
ext.setCandidateTable([],false,false,onSelect,onPage);ext.setCandidateTable(['第一批'],false,true,onSelect,onPage);
ext.setCandidateTable(['最终候选'],false,true,onSelect,onPage);
assert.equal(pending.size,1);assert.equal(updates,0);[...pending.values()][0]();
assert.equal(updates,1);assert.deepEqual(Array.from(finalTable),['最终候选']);
console.log('Fixed five slots/page positions, actor reuse, no repeat sizing, hidden-slot safety, clear/reopen and before-paint coalescing passed');
