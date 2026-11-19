import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function isExternalTypingKeyboard(bus, sysfsTarget, keyBits) {
    if (![3, 5].includes(Number.parseInt(bus, 16)) ||
        sysfsTarget.includes('/devices/virtual/input/'))
        return false;
    // These typing keys all belong to the final 64-bit capability word.
    // Concatenating sysfs words loses zero padding and misclassifies pens.
    const lowWord = keyBits.trim().split(/\s+/).at(-1);
    const bits = BigInt(`0x${lowWord}`);
    const typingMask = (1n << 28n) | (1n << 30n) | (1n << 44n) | (1n << 57n);
    return (bits & typingMask) === typingMask;
}

export default class InputPolicy extends Extension {
    enable() {
        this._mode = 'touch';
        this._manual = false;
        this._hadInputFocus = false;
        this._lastNativeFocus = null;
        this._touchGeneration = 0;
        this._handledTouchGeneration = 0;
        this._lastAppTouch = 0;
        this._touchWindow = null;
        this._fcitxPending = false;
        this._fcitxFocused = false;
        this._enabled = true;
        this._cancellable = new Gio.Cancellable();
        this._manager = Main.keyboard;
        this._physicalKeyboardCount = 0;
        this._lastDeviceCheck = 0;
        this._seat = global.stage.context.get_backend().get_default_seat();
        this._deviceAddedId = this._seat.connect('device-added', () => this._refreshPhysicalKeyboards());
        this._deviceRemovedId = this._seat.connect('device-removed', () => this._refreshPhysicalKeyboards());
        // last-device-changed only fires when the device changes, not on
        // repeated taps from the same touchscreen. Track completed app taps.
        this._touchId = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_END)
                return Clutter.EVENT_PROPAGATE;
            const source = global.stage.get_event_actor(event);
            if (!source || !global.window_group.contains(source))
                return Clutter.EVENT_PROPAGATE;
            this._mode = 'touch';
            this._touchGeneration++;
            this._lastAppTouch = GLib.get_monotonic_time() / 1000;
            this._touchWindow = global.display.focus_window;
            return Clutter.EVENT_PROPAGATE;
        });
        this._deviceId = global.backend.connect('last-device-changed', (_backend, device) => {
            const type = device.get_device_type();
            const name = device.get_device_name()?.toLowerCase() ?? '';
            if (type === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE) {
                this._mode = 'touch';
                this._touchGeneration++;
            } else if (type === Clutter.InputDeviceType.POINTER_DEVICE) {
                this._mode = 'pointer';
                this._manager.close();
            } else if (type === Clutter.InputDeviceType.KEYBOARD_DEVICE &&
                !name.includes('virtual') && !name.includes('gpio') &&
                !name.includes('pwrkey') && !name.includes('pmic') &&
                !name.includes('touchscreen')) {
                this._mode = 'keyboard';
                this._manager.close();
            }
        });
        this._originalAddSuggestion = this._manager.addSuggestion;
        const policy = this;
        this._manager.addSuggestion = function (...args) {
            if (!policy._isSensitiveInput())
                return policy._originalAddSuggestion.apply(this, args);
        };
        this._purposeId = Main.inputMethod.connect('notify::content-purpose', () => {
            if (this._isSensitiveInput())
                this._manager.resetSuggestions();
        });
        this._originalManagerOpen = this._manager.open;
        const extension = this;
        this._manager.open = function (...args) {
            if (extension.hasPhysicalKeyboard())
                return;
            extension._manual = true;
            try { return extension._originalManagerOpen.apply(this, args); }
            finally { extension._manual = false; }
        };
        this._originalManagerClose = this._manager.close;
        this._manager.close = function (...args) {
            extension._handledTouchGeneration = extension._touchGeneration;
            return extension._originalManagerClose.apply(this, args);
        };
        this._wrapKeyboard();
        this._refreshPhysicalKeyboards();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (GLib.get_monotonic_time() / 1000 - this._lastDeviceCheck > 1000)
                this._refreshPhysicalKeyboards();
            const focus = Main.inputMethod?.currentFocus;
            let focused = false;
            try { focused = !!focus?.is_focused(); } catch (_e) {}
            const recentlyTouched = this._touchGeneration !== this._handledTouchGeneration;
            const newFocus = focused && (!this._hadInputFocus || focus !== this._lastNativeFocus);
            this._hadInputFocus = focused;
            this._lastNativeFocus = focus;
            if (focused && this._mode === 'touch' && (newFocus || recentlyTouched)) {
                this._handledTouchGeneration = this._touchGeneration;
                this._openForTouch();
            } else if (!focused && recentlyTouched) {
                this._checkQqFocus();
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._settings = this._manager._a11yApplicationsSettings;
        this._settingsId = this._settings.connect('changed::screen-keyboard-enabled', () =>
            this._wrapKeyboard());
        this._diagnostic = Gio.DBusExportedObject.wrapJSObject(
            '<node><interface name="org.tb710fu.OskPolicy"><method name="Status"><arg type="s" direction="out"/></method></interface></node>', this);
        this._diagnostic.export(Gio.DBus.session, '/org/tb710fu/OskPolicy');
    }
    Status() {
        const window = global.display.focus_window;
        const klass = window?.get_wm_class()?.toLowerCase() ?? '';
        const shortcuts = Main.extensionManager.lookup('tb-osk-shortcuts@tb710fu')?.stateObj;
        return JSON.stringify({version: 5, mode: this._mode,
            layout: shortcuts?.getLayoutMetrics?.() ?? null,
            physicalKeyboardCount: this._physicalKeyboardCount,
            preeditVisible: !!(this._manager.visible && shortcuts?._preeditLabel?.visible),
            preeditLength: shortcuts?._preeditLabel?.text?.length ?? 0,
            candidateCount: shortcuts?.getCandidateCount?.() ?? shortcuts?._suggestions?.get_n_children() ?? 0,
            visible: !!this._manager.visible, nativeFocus: this._hadInputFocus,
            touchGeneration: this._touchGeneration, handledGeneration: this._handledTouchGeneration,
            touchAgeMs: this._lastAppTouch ? GLib.get_monotonic_time() / 1000 - this._lastAppTouch : null,
            sameTouchedWindow: window === this._touchWindow,
            qqWindow: ['qq', 'linuxqq'].includes(klass),
            fcitxFocused: this._fcitxFocused, focusRequestPending: this._fcitxPending});
    }
    hasPhysicalKeyboard() {
        return this._physicalKeyboardCount > 0;
    }
    _physicalTypingDevice(device) {
        try {
            const node = device.get_device_node();
            const event = node ? GLib.path_get_basename(node) : '';
            if (!/^event\d+$/.test(event))
                return false;
            const base = `/sys/class/input/${event}`;
            const read = path => {
                const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
                return new TextDecoder().decode(bytes);
            };
            return isExternalTypingKeyboard(read(`${base}/device/id/bustype`),
                GLib.file_read_link(base), read(`${base}/device/capabilities/key`));
        } catch (_error) {
            return false; // Hot-unplug or a virtual/master device with no node.
        }
    }
    _refreshPhysicalKeyboards() {
        this._lastDeviceCheck = GLib.get_monotonic_time() / 1000;
        const oldCount = this._physicalKeyboardCount;
        this._physicalKeyboardCount = this._seat.list_devices()
            .filter(device => this._physicalTypingDevice(device)).length;
        if (this.hasPhysicalKeyboard() && (oldCount === 0 || this._manager.visible))
            this._manager.close();
        else if (oldCount > 0 && !this.hasPhysicalKeyboard())
            this._mode = 'touch';
    }
    _openForTouch() {
        const keyboard = this._manager.keyboardActor;
        if (!this.hasPhysicalKeyboard() && this._mode === 'touch' && keyboard &&
            !this._manager.visible && !keyboard._keyboardRequested)
            this._manager.open(Main.layoutManager.focusIndex);
    }
    _checkQqFocus() {
        const window = global.display.focus_window;
        const klass = window?.get_wm_class()?.toLowerCase() ?? '';
        const age = GLib.get_monotonic_time() / 1000 - this._lastAppTouch;
        if (!this._enabled || this.hasPhysicalKeyboard() || this._fcitxPending || this._mode !== 'touch' ||
            !['qq', 'linuxqq'].includes(klass) || window !== this._touchWindow ||
            this._lastAppTouch === 0 || age > 1200)
            return;
        const generation = this._touchGeneration;
        this._fcitxPending = true;
        // Fcitx exposes only context metadata here (program/frontend/focus),
        // not input text. State() alone can refer to a previously focused IC.
        Gio.DBus.session.call('org.fcitx.Fcitx5', '/controller',
            'org.fcitx.Fcitx.Controller1', 'DebugInfo', null,
            new GLib.VariantType('(s)'), Gio.DBusCallFlags.NO_AUTO_START,
            500, this._cancellable, (connection, result) => {
                this._fcitxPending = false;
                if (!this._enabled)
                    return;
                let focused = false;
                try {
                    const [info] = connection.call_finish(result).deep_unpack();
                    focused = /(?:^|\n)\s*IC \[[^\]]+\] program:(?:gtk\d-im:)?(?:qq|linuxqq) frontend:\S+(?: cap:[0-9a-f]+)? focus:1(?:\n|$)/i.test(info);
                } catch (_error) { /* No daemon or a stale context: fail closed. */ }
                this._fcitxFocused = focused;
                if (!focused || this._mode !== 'touch' ||
                    generation !== this._touchGeneration ||
                    generation <= this._handledTouchGeneration ||
                    window !== global.display.focus_window ||
                    GLib.get_monotonic_time() / 1000 - this._lastAppTouch > 1200)
                    return;
                this._handledTouchGeneration = generation;
                this._openForTouch();
            });
    }
    _isSensitiveInput() {
        const purpose = Main.inputMethod.content_purpose;
        return purpose === Clutter.InputContentPurpose.PASSWORD ||
            purpose === Clutter.InputContentPurpose.PIN;
    }
    _wrapKeyboard() {
        const keyboard = this._manager.keyboardActor;
        if (!keyboard || keyboard === this._keyboard)
            return;
        this._unwrapKeyboard();
        this._keyboard = keyboard;
        this._originalOpen = keyboard.open;
        this._originalClose = keyboard.close;
        const extension = this;
        keyboard.open = function (...args) {
            if (extension.hasPhysicalKeyboard())
                return;
            if (extension._manual || extension._mode === 'touch' ||
                Main.actionMode === Shell.ActionMode.LOCK_SCREEN)
                return extension._originalOpen.apply(this, args);
        };
        keyboard.close = function (...args) {
            extension._handledTouchGeneration = extension._touchGeneration;
            return extension._originalClose.apply(this, args);
        };
    }
    _unwrapKeyboard() {
        if (this._keyboard && this._originalOpen)
            this._keyboard.open = this._originalOpen;
        if (this._keyboard && this._originalClose)
            this._keyboard.close = this._originalClose;
        this._keyboard = null;
        this._originalOpen = null;
        this._originalClose = null;
    }
    disable() {
        this._enabled = false;
        this._diagnostic?.unexport();
        this._diagnostic = null;
        this._cancellable?.cancel();
        if (this._touchId)
            global.stage.disconnect(this._touchId);
        if (this._pollId)
            GLib.source_remove(this._pollId);
        if (this._deviceId)
            global.backend.disconnect(this._deviceId);
        if (this._deviceAddedId)
            this._seat.disconnect(this._deviceAddedId);
        if (this._deviceRemovedId)
            this._seat.disconnect(this._deviceRemovedId);
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._unwrapKeyboard();
        if (this._purposeId)
            Main.inputMethod.disconnect(this._purposeId);
        if (this._manager && this._originalAddSuggestion)
            this._manager.addSuggestion = this._originalAddSuggestion;
        if (this._manager && this._originalManagerOpen)
            this._manager.open = this._originalManagerOpen;
        if (this._manager && this._originalManagerClose)
            this._manager.close = this._originalManagerClose;
    }
}
