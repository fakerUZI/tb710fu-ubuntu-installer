const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(`${__dirname}/extension.js`, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class InputPolicy', 'globalThis.InputPolicy = class InputPolicy');
let listener, poll, purposeChanged, captured, now = 10000, closed = 0, opened = 0, added = 0, cleared = 0;
const pending = [];
let externalDevices = [];
const seatListeners = new Map();
const seat = {list_devices: () => externalDevices, connect(name, cb) {seatListeners.set(name, cb); return 20 + seatListeners.size;}, disconnect() {}};
const entries = new Map();
const keyboard = {open() { opened++; }, close() {}};
const manager = {
    keyboardActor: keyboard, addSuggestion() { added++; }, resetSuggestions() { cleared++; },
    _a11yApplicationsSettings: {connect() { return 7; }, disconnect() {}},
    open() { keyboard.open(); }, close() { closed++; },
};
const types = {TOUCHSCREEN_DEVICE: 1, POINTER_DEVICE: 2, KEYBOARD_DEVICE: 3};
const context = {
    GLib: {PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, timeout_add: (_priority, _interval, callback) => { poll = callback; return 9; }, source_remove() {}, get_monotonic_time: () => now * 1000, VariantType: class {}, path_get_basename: p => p.split('/').at(-1), file_read_link: p => entries.get(p.split('/').at(-1)).link},
    Gio: {File: {new_for_path: path => ({load_contents() {const e = entries.get(path.match(/event\d+/)?.[0]); if (!e) throw Error('removed');return [true, Buffer.from(path.endsWith('/bustype') ? e.bus : e.keys)];}})}, Cancellable: class {cancel() {}}, DBusExportedObject: {wrapJSObject: () => ({export() {}, unexport() {}})}, DBusCallFlags: {NO_AUTO_START: 1}, DBus: {session: {call(...args) {pending.push(args[9]);}}}},
    TextDecoder,
    Clutter: {InputDeviceType: types, EventType: {TOUCH_END: 30}, EVENT_PROPAGATE: 0, InputContentPurpose: {PASSWORD: 8, PIN: 9}}, Shell: {ActionMode: {LOCK_SCREEN: 4}},
    Main: {keyboard: manager, extensionManager: {lookup: () => null}, layoutManager: {focusIndex: 0}, actionMode: 1, inputMethod: {content_purpose: 0, connect(_name, callback) { purposeChanged = callback; return 8; }, disconnect() {}}}, Extension: class {},
    global: {backend: {connect(_signal, callback) { listener = callback; return 1; }, disconnect() {}}, stage: {context: {get_backend: () => ({get_default_seat: () => seat})}, connect(_signal, callback) {captured = callback; return 2;}, disconnect() {}, get_event_actor: event => event.get_source()}, window_group: {contains: source => source === 'app'}, display: {focus_window: {get_wm_class: () => 'QQ'}}},
};
vm.createContext(context);
vm.runInContext(source, context);
const extension = new context.InputPolicy();
extension.enable();
const device = (type, name) => listener(null, {get_device_type: () => type, get_device_name: () => name});
keyboard.open(); assert.equal(opened, 1);
device(types.POINTER_DEVICE, 'uu-remote-linux pointer'); keyboard.open(); assert.equal(opened, 1);
device(types.TOUCHSCREEN_DEVICE, 'NVTCapacitiveTouchScreen'); keyboard.open(); assert.equal(opened, 2);
device(types.KEYBOARD_DEVICE, 'uu-remote-linux keyboard'); keyboard.open(); assert.equal(opened, 2);
manager.open(); assert.equal(opened, 3);
device(types.KEYBOARD_DEVICE, 'Virtual keyboard'); keyboard.open(); assert.equal(opened, 3);
context.Main.inputMethod.content_purpose = 8;
purposeChanged(); assert.equal(cleared, 1);
manager.addSuggestion('secret'); assert.equal(added, 0);
context.Main.inputMethod.content_purpose = 0;
manager.addSuggestion('normal'); assert.equal(added, 1);
context.Main.actionMode = 4; keyboard.open(); assert.equal(opened, 4);
extension.disable(); context.Main.actionMode = 1; keyboard.open(); assert.equal(opened, 5);
assert.equal(closed, 2);

const policy = new context.InputPolicy();
policy.enable();
const tap = (source = 'app') => {
    now += 100;
    captured(null, {type: () => 30, get_source: () => source});
};
const answer = info => {
    assert(pending.length, 'focus request is pending');
    pending.shift()({call_finish: () => ({deep_unpack: () => [info]})}, {});
};
const focused = '  IC [test] program:gtk3-im:qq frontend:ibus focus:1\n';
const unfocused = '  IC [test] program:gtk3-im:qq frontend:ibus focus:0\n';
let before = opened;
tap(); poll(); answer(focused);
assert.equal(opened, before + 1, 'QQ IBus focus opens OSK without a Wayland focus');
keyboard.close(); poll();
assert.equal(pending.length, 0, 'hiding OSK does not immediately reopen it');
before = opened;
tap(); poll(); answer(focused);
assert.equal(opened, before + 1, 'repeated touch from the same device reopens OSK');
before = opened;
tap('keyboard'); poll();
assert.equal(pending.length, 0, 'touches on OSK/candidate controls are excluded');
tap(); poll(); answer(unfocused);
assert.equal(opened, before, 'a non-editable QQ surface must not open OSK');
now += 1300; poll();
assert.equal(pending.length, 0, 'old touches cannot trigger delayed popups');
tap(); poll(); keyboard.close(); answer(focused);
assert.equal(opened, before, 'manual hide cancels a pending focus request');
tap(); poll();
const qq = context.global.display.focus_window;
context.global.display.focus_window = {get_wm_class: () => 'Other'};
answer(focused);
assert.equal(opened, before, 'stale focus response cannot open OSK over another app');
context.global.display.focus_window = qq;
tap(); poll(); device(types.KEYBOARD_DEVICE, 'physical keyboard'); answer(focused);
assert.equal(opened, before, 'physical keyboard input suppresses pending auto-open');
device(types.TOUCHSCREEN_DEVICE, 'NVTCapacitiveTouchScreen');
context.Main.inputMethod.currentFocus = {is_focused: () => true};
poll();
assert.equal(opened, before + 1, 'native Wayland focus retains auto-open');
context.Main.inputMethod.currentFocus = {is_focused: () => true};
poll();
assert.equal(opened, before + 2, 'native focus-object changes are detected');
context.Main.inputMethod.currentFocus = null;
tap(); poll(); before = opened; policy.disable(); answer(focused);
assert.equal(opened, before, 'disabled policy ignores pending replies');
console.log('OSK policy: native focus, QQ IBus touch, candidate exclusion, hide, stale response and keyboard suppression passed');

const keyBits = ((1n << 28n) | (1n << 30n) | (1n << 44n) | (1n << 57n)).toString(16);
assert(context.isExternalTypingKeyboard('0003', '../../devices/platform/usb/input/event80', keyBits));
assert(context.isExternalTypingKeyboard('0005', '../../devices/virtual/misc/uhid/input/event80', keyBits), 'Bluetooth UHID is a real keyboard');
assert(!context.isExternalTypingKeyboard('0003', '../../devices/virtual/input/input80/event80', keyBits), 'uinput remote keyboard is excluded');
assert(!context.isExternalTypingKeyboard('001c', '../../devices/platform/pen/input/event80', keyBits));
assert(!context.isExternalTypingKeyboard('0003', '../../devices/platform/usb/input/event80', '10000000'), 'consumer keys are not a typing keyboard');
assert(!context.isExternalTypingKeyboard('0003', '../../devices/platform/usb/input/event80', '1234567 0'), 'high bitmap words cannot shift into low typing keys');

const hardware = new context.InputPolicy();hardware.enable();
const usb = {get_device_type: () => types.KEYBOARD_DEVICE, get_device_node: () => '/dev/input/event80'};
entries.set('event80', {bus: '0003', link: '../../devices/platform/usb/input/event80', keys: keyBits});
externalDevices = [usb];seatListeners.get('device-added')();
assert(hardware.hasPhysicalKeyboard());
before = opened;manager.open();keyboard.open();tap();poll();
assert.equal(opened, before, 'a connected keyboard suppresses both manual and touch opening');
assert.equal(pending.length, 0, 'no QQ query is needed while hardware is connected');
externalDevices = [];seatListeners.get('device-removed')();
tap();poll();answer(focused);
assert.equal(opened, before + 1, 'unplug restores touch input and QQ focus integration');
entries.get('event80').bus = '0005';entries.get('event80').link = '../../devices/virtual/misc/uhid/input/event80';
externalDevices = [usb];seatListeners.get('device-added')();
assert.equal(JSON.parse(hardware.Status()).physicalKeyboardCount, 1);
before = opened;tap();manager.open();assert.equal(opened, before, 'Bluetooth suppresses touch even without any keypress');
entries.get('event80').link = '../../devices/virtual/input/input80/event80';hardware._refreshPhysicalKeyboards();
assert(!hardware.hasPhysicalKeyboard(), 'virtual USB-labelled devices do not suppress OSK');
hardware.disable();
console.log('USB/Bluetooth presence, unplug restoration, virtual input exclusion and bitmap filtering passed');
