const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(`${__dirname}/extension.js`, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class OskShortcuts', 'globalThis.OskShortcuts = class OskShortcuts');
const Main = {inputMethod: {content_purpose: 0}, actionMode: 1};
const context = {Extension: class {}, Main, GLib: {}, Clutter: {InputContentPurpose: {PASSWORD: 8, PIN: 9}}, Shell: {ActionMode: {LOCK_SCREEN: 4}}};
vm.createContext(context);vm.runInContext(source, context);
const ext = new context.OskShortcuts();
let count = 0, layouts = 0;
Object.assign(ext, {_disabled: false, _preedit: '', _auxPreedit: '', _showPreedit: false, _showAuxPreedit: false, _compositionText: '',
    _slot: {width: 825}, _preeditLabel: {text: '', visible: false},
    _bar: {visible: true, width: 825, get_first_child: () => ({width: 807}), get_transformed_position: () => [387, 0]},
    _candidateBox: {visible: false}, _candidateFrame: {visible: false},
    _suggestions: {get_n_children: () => count, visible: false}, _keyboard: {height: 400,
        _aspectContainer: {height: 320, width: 825, get_transformed_position: () => [387, 0]},
        _relayout() {layouts++;}}, _closeClipboard() {}});
const suggestions = ext._suggestions;
ext._applySharedRowSize();
const stableGeometry = () => {
    const metrics = ext.getLayoutMetrics();
    assert.equal(metrics.sharedHeight, 80);
    assert.equal(metrics.toolbarHeight, metrics.sharedHeight);
    assert.equal(metrics.candidateHeight, metrics.sharedHeight);
    assert.equal(metrics.keyboardHeight, 400);
    assert.equal(metrics.gridHeight, 320);
    assert.equal(metrics.gridWidth, 825);
    assert.equal(metrics.toolbarWidth, metrics.gridWidth);assert.equal(metrics.toolbarX, metrics.gridX);
    assert.equal(layouts, 0, 'content transitions must not relayout the keyboard');
};
stableGeometry();
ext._onPreeditSignal('UpdatePreeditText', ['ni hao', '']);
assert.equal(ext._preeditLabel.text, '', 'hidden preedit must not be shown early');
ext._onPreeditSignal('ShowPreedit', [true]);
assert.equal(ext._preeditLabel.text, 'ni hao');assert(ext._preeditLabel.visible);assert(!ext._bar.visible);
stableGeometry();
count = 5;ext._syncRow();assert(ext._suggestions.visible);assert.equal(ext._suggestions, suggestions);assert(ext._candidateFrame.visible);
stableGeometry();
ext._onPreeditSignal('UpdatePreeditText', ['ni haoma', '']);
assert.equal(ext._preeditLabel.text, 'ni haoma');stableGeometry();
count = 0;ext._syncRow();stableGeometry();count = 5;ext._syncRow();stableGeometry();
Main.inputMethod.content_purpose = 8;ext._refreshComposition();assert.equal(ext._preeditLabel.text, '');assert(!ext._preeditLabel.visible);
Main.inputMethod.content_purpose = 0;ext._onPreeditSignal('ShowPreedit', [false]);count = 0;ext._syncRow();assert(ext._bar.visible);assert(!ext._candidateBox.visible);
assert(!ext._candidateFrame.visible);stableGeometry();
ext._onPreeditSignal('UpdateAux', ["zhong'wen", '']);ext._onPreeditSignal('ShowAux', [true]);assert.equal(ext._preeditLabel.text, "zhong'wen");
ext._onPreeditSignal('ShowAux', [false]);assert.equal(ext._preeditLabel.text, '');assert(ext._bar.visible);
Main.actionMode = 4;ext._onPreeditSignal('ShowPreedit', [true]);assert.equal(ext._preeditLabel.text, '', 'lock-screen preedit stays hidden');
ext._disabled = true;ext._onPreeditSignal('UpdatePreeditText', ['ignored', '']);assert.equal(ext._preeditLabel.text, '');
stableGeometry();
console.log('Five-candidate sharing, preedit/auxiliary composition, clear-on-commit, sensitive fields and fixed-height transitions without relayout passed');
