const fs = require('fs'), vm = require('vm'), assert = require('assert');
const timers = new Map();let nextId = 0;
const GLib = {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    timeout_add_once(_p, ms, callback) {timers.set(++nextId, {ms, callback, once: true});return nextId;},
    timeout_add(_p, ms, callback) {timers.set(++nextId, {ms, callback});return nextId;},
    source_remove(id) {timers.delete(id);}};
const tick = () => {
    const [id, timer] = timers.entries().next().value;
    if (timer.once) timers.delete(id);
    const keep = timer.callback();
    if (!timer.once && !keep) timers.delete(id);
};
const Clutter = {KEY_Left: 65361, KEY_Down: 65364, EVENT_STOP: 1, EVENT_PROPAGATE: 0,
    EventType: {TOUCH_BEGIN: 1, TOUCH_END: 2, TOUCH_CANCEL: 3, TOUCH_UPDATE: 4}};
const Main = {keyboard: {visible: true}}, global = {display: {focus_window: {}}};
const context = {GLib, Clutter, Main, global};vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/arrow-repeat.js`, 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export class (\w+)/g, 'globalThis.$1 = class $1'), context);
class Button {
    constructor() {this.signals = new Map();this.next = 0;this.mapped = true;}
    connect(name, cb) {this.signals.set(++this.next, {name, cb});return this.next;}
    disconnect(id) {this.signals.delete(id);}
    emit(name, ...args) {for (const item of [...this.signals.values()]) if (item.name === name) item.cb(this, ...args);}
    add_style_pseudo_class() {} remove_style_pseudo_class() {}
    is_mapped() {return this.mapped;}
    get_transformed_position() {return [0, 0];} get_transformed_size() {return [100, 50];}
}
const events = [], controller = {keyvalPress: k => events.push(['down', k]), keyvalRelease: k => events.push(['up', k])};
const button = new Button();
const key = {_keyval: 65361, keyButton: button,
    _press() {this._pressed = true;},
    _release() {if (this._pressed) {controller.keyvalPress(this._keyval);controller.keyvalRelease(this._keyval);}this._pressed = false;},
    cancel() {this._pressed = false;}};
const original = {press: key._press, release: key._release, cancel: key.cancel};
const manager = new context.ArrowRepeatManager({_keyboardController: controller});
manager.scan({get_children: () => [key]});manager.scan({get_children: () => [key]});
key._press();assert.equal(events.length, 2);assert.equal([...timers.values()][0].ms, 400);
key._release();assert.equal(events.length, 2, 'short tap sends exactly one key');assert.equal(timers.size, 0);
key._press();tick();assert.equal([...timers.values()][0].ms, 60);tick();
assert.equal(events.length, 8, 'held key repeats after delay');key._release();assert.equal(events.length, 8);assert.equal(timers.size, 0);
key._press();key.cancel();assert.equal(timers.size, 0);
key._press();Main.keyboard.visible = false;tick();assert.equal(timers.size, 0);Main.keyboard.visible = true;
key._press();global.display.focus_window = {};tick();assert.equal(timers.size, 0, 'focus switch stops repeat');
key._press();button.mapped = false;button.emit('notify::mapped');assert.equal(timers.size, 0);button.mapped = true;
key._press();button.emit('captured-event', {type: () => Clutter.EventType.TOUCH_CANCEL});assert.equal(timers.size, 0);
let actions = 0;const toolbar = new Button();manager.bindToolbar(toolbar, () => actions++);
const touch = (type, slot = 0, x = 10) => ({type: () => type, get_event_sequence: () => ({get_slot: () => slot}), get_coords: () => [x, 10]});
toolbar.emit('touch-event', touch(1));assert.equal(actions, 1);
toolbar.emit('touch-event', touch(1, 1));assert.equal(actions, 1, 'second finger cannot restart held arrow');
toolbar.emit('touch-event', touch(2, 1));assert.equal(timers.size, 1, 'unrelated finger release is ignored');
tick();assert.equal(actions, 2);toolbar.emit('touch-event', touch(2));assert.equal(timers.size, 0);
toolbar.emit('touch-event', touch(1));toolbar.emit('touch-event', touch(4, 0, 150));assert.equal(timers.size, 0);
toolbar.emit('touch-event', touch(2));toolbar.emit('button-press-event');tick();toolbar.emit('button-release-event');assert.equal(timers.size, 0);
key._press();manager.destroy();assert.equal(timers.size, 0);assert.equal(key._press, original.press);assert.equal(key._release, original.release);assert.equal(key.cancel, original.cancel);
assert.equal(button.signals.size, 0);assert.equal(toolbar.signals.size, 0);
let stopped;stopped = new context.HoldRepeat(() => stopped.stop(), () => true);stopped.start();assert.equal(timers.size, 0, 'synchronous teardown during first action cannot restart timer');
console.log('Arrow short tap, delayed repeat, no release duplicate, touch/mouse cancellation, focus/hide guards and teardown passed');
