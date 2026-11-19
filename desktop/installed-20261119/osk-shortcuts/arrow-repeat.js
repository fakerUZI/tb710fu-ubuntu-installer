import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class HoldRepeat {
    constructor(action, canRepeat) {
        this._action = action;
        this._canRepeat = canRepeat;
        this._source = 0;
    }
    start() {
        this.stop();
        this._active = true;
        this._action();
        if (!this._active)
            return;
        this._source = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 400, () => {
            this._source = 0;
            if (!this._active || !this._canRepeat())
                return;
            this._action();
            if (!this._active)
                return;
            this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                if (!this._active || !this._canRepeat()) {
                    this._source = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._action();
                return GLib.SOURCE_CONTINUE;
            });
        });
    }
    stop() {
        this._active = false;
        if (this._source)
            GLib.source_remove(this._source);
        this._source = 0;
    }
}

export class ArrowRepeatManager {
    constructor(keyboard) {
        this._keyboard = keyboard;
        this._bindings = new Map();
    }
    _binding(button, action) {
        let window = null;
        const repeat = new HoldRepeat(action, () =>
            Main.keyboard.visible && button.is_mapped() &&
            global.display.focus_window === window);
        const ids = [];
        const item = {repeat, ids, start: () => {
            this.stopAll();
            window = global.display.focus_window;
            button.add_style_pseudo_class('active');
            repeat.start();
        }, stop: () => {
            repeat.stop();
            button.remove_style_pseudo_class('active');
        }};
        ids.push(button.connect('notify::mapped', () => {
            if (!button.is_mapped())
                item.stop();
        }));
        ids.push(button.connect('destroy', () => {
            repeat.stop();
            this._bindings.delete(button);
        }));
        this._bindings.set(button, item);
        return item;
    }
    _outside(button, event) {
        const [x, y] = event.get_coords();
        const [left, top] = button.get_transformed_position();
        const [width, height] = button.get_transformed_size();
        return x < left || x >= left + width || y < top || y >= top + height;
    }
    scan(layout) {
        for (const key of layout.get_children()) {
            const keyval = key._keyval;
            if (keyval < Clutter.KEY_Left || keyval > Clutter.KEY_Down ||
                !Number.isFinite(keyval) || this._bindings.has(key.keyButton))
                continue;
            const controller = this._keyboard._keyboardController;
            const item = this._binding(key.keyButton, () => {
                controller.keyvalPress(keyval);
                controller.keyvalRelease(keyval);
            });
            const press = key._press, release = key._release, cancel = key.cancel;
            key._press = function (...args) {
                press.apply(this, args);
                item.start();
            };
            key._release = function (...args) {
                item.stop();
                // The initial action was sent on press; suppress release's copy.
                this._pressed = false;
                return release.apply(this, args);
            };
            key.cancel = function (...args) {
                item.stop();
                return cancel.apply(this, args);
            };
            item.restore = () => {
                key._press = press;key._release = release;key.cancel = cancel;
            };
            item.ids.push(key.keyButton.connect('captured-event', (_button, event) => {
                if (event.type() === Clutter.EventType.TOUCH_CANCEL) {
                    key.cancel();
                    return Clutter.EVENT_STOP;
                }
                if (event.type() === Clutter.EventType.TOUCH_UPDATE && this._outside(key.keyButton, event))
                    item.stop();
                return Clutter.EVENT_PROPAGATE;
            }));
            item.ids.push(key.keyButton.connect('leave-event', () => {
                item.stop();return Clutter.EVENT_PROPAGATE;
            }));
        }
    }
    bindToolbar(button, action) {
        const item = this._binding(button, action);
        let touchSlot = null;
        item.ids.push(button.connect('button-press-event', () => {
            item.start();return Clutter.EVENT_STOP;
        }));
        item.ids.push(button.connect('button-release-event', () => {
            item.stop();return Clutter.EVENT_STOP;
        }));
        item.ids.push(button.connect('leave-event', () => {
            item.stop();return Clutter.EVENT_PROPAGATE;
        }));
        item.ids.push(button.connect('touch-event', (_button, event) => {
            const type = event.type();
            const slot = event.get_event_sequence()?.get_slot();
            if (type === Clutter.EventType.TOUCH_BEGIN && touchSlot === null) {
                touchSlot = slot;item.start();
            } else if (slot === touchSlot) {
                if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                    touchSlot = null;item.stop();
                } else if (type === Clutter.EventType.TOUCH_UPDATE && this._outside(button, event)) {
                    item.stop();
                }
            }
            return Clutter.EVENT_STOP;
        }));
    }
    stopAll() {
        for (const item of this._bindings.values())
            item.stop();
    }
    destroy() {
        this.stopAll();
        for (const [button, item] of this._bindings) {
            for (const id of item.ids)
                button.disconnect(id);
            item.restore?.();
        }
        this._bindings.clear();
    }
}
