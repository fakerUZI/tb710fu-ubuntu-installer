// Use the extended layout in ordinary text fields as well as terminals.
// Keep its upper Caps key and replace only the lower-left Shift.
// Native modifier registration supplies touch handling and the latched state.
export class TerminalShiftModifier {
    constructor(keyboard, shiftKeyval, terminalPurpose, onKeysAdded, textPurposes = [], inputMethod = null) {
        this._keyboard = keyboard;
        this._shift = shiftKeyval;
        this._controller = keyboard._keyboardController;
        this._inputMethod = inputMethod;
        this._injected = new Set();
        this._down = false;
        const extension = this;
        this._setActiveLevel = keyboard._setActiveLevel;
        keyboard._setActiveLevel = function (level) {
            // A late capitalization reply from a text field can arrive after
            // switching to a one-level numeric model. Never select a missing page.
            const target = this._layers?.[level] ? level : 'default';
            if (!this._layers?.[target])
                return;
            return extension._setActiveLevel.call(this, target);
        };
        this._updateLayout = keyboard._updateLayout;
        const extendedPurposes = new Set([terminalPurpose, ...textPurposes]);
        keyboard._updateLayout = function (group, purpose) {
            extension._buildingExtendedLayout = extendedPurposes.has(purpose);
            try {
                return extension._updateLayout.call(this, group,
                    extension._buildingExtendedLayout ? terminalPurpose : purpose);
            } finally {
                extension._buildingExtendedLayout = false;
            }
        };
        this._addRowKeys = keyboard._addRowKeys;
        keyboard._addRowKeys = function (keys, layout, emojiVisible) {
            const first = keys[0];
            if ((this._keyboardController.purpose === terminalPurpose || extension._buildingExtendedLayout) &&
                first?.action === 'levelSwitch' &&
                first.iconName === 'osk-shift-symbolic') {
                keys = [{action: 'modifier', keyval: shiftKeyval,
                    label: 'Shift', width: first.width, height: first.height,
                    leftOffset: first.leftOffset}, ...keys.slice(1)];
            }
            extension._addRowKeys.call(this, keys, layout, emojiVisible);
            for (const key of layout.get_children()) {
                if (key.keyButton?.get_label() === 'Shift') {
                    key.keyButton.add_style_class_name('tb-osk-shift-modifier');
                    key.keyButton.accessible_name = 'Shift 组合键，点按开启或取消';
                }
            }
            onKeysAdded?.(layout);
        };
        this._updateKeys = keyboard._updateKeys;
        keyboard._updateKeys = function (...args) {
            extension._clear();
            if (this._surroundingTextId && inputMethod) {
                inputMethod.disconnect(this._surroundingTextId);
                this._surroundingTextId = 0;
            }
            // Discard registrations from the layout about to be destroyed.
            this._modifierKeys[shiftKeyval] = [];
            return extension._updateKeys.apply(this, args);
        };
        this._close = keyboard.close;
        keyboard.close = function (...args) {
            extension._clear();
            return extension._close.apply(this, args);
        };
        this._press = this._controller.keyvalPress;
        this._release = this._controller.keyvalRelease;
        this._controller.keyvalPress = keyval => this._keyPress(keyval);
        this._controller.keyvalRelease = keyval => this._keyRelease(keyval);
        keyboard._updateKeys();
    }
    _keyPress(keyval) {
        if (keyval === this._shift) {
            this._press.call(this._controller, keyval);
            this._down = true;
            return;
        }
        // GNOME forwards modifiers for text commits, but not raw arrow/Tab keys.
        if (this._keyboard._modifiers.has(this._shift) && !this._down) {
            this._press.call(this._controller, this._shift);
            this._down = true;
            this._injected.add(keyval);
        }
        try {
            this._press.call(this._controller, keyval);
        } catch (error) {
            this._releaseInjected(keyval);
            throw error;
        }
    }
    _keyRelease(keyval) {
        try {
            this._release.call(this._controller, keyval);
        } finally {
            if (keyval === this._shift)
                this._down = false;
            else
                this._releaseInjected(keyval);
        }
    }
    _releaseInjected(keyval) {
        if (!this._injected.delete(keyval))
            return;
        try {
            this._release.call(this._controller, this._shift);
        } finally {
            this._down = false;
        }
    }
    _clear() {
        if (this._keyboard._modifiers.has(this._shift))
            this._keyboard._setModifierEnabled(this._shift, false);
        if (this._injected.size)
            this._release.call(this._controller, this._shift);
        this._injected.clear();
        this._down = false;
    }
    destroy() {
        this._clear();
        const keyboard = this._keyboard;
        if (keyboard._surroundingTextId && this._inputMethod) {
            this._inputMethod.disconnect(keyboard._surroundingTextId);
            keyboard._surroundingTextId = 0;
        }
        keyboard._addRowKeys = this._addRowKeys;
        keyboard._updateKeys = this._updateKeys;
        keyboard._updateLayout = this._updateLayout;
        keyboard._setActiveLevel = this._setActiveLevel;
        keyboard.close = this._close;
        this._controller.keyvalPress = this._press;
        this._controller.keyvalRelease = this._release;
        keyboard._modifierKeys[this._shift] = [];
        if (keyboard.get_parent())
            keyboard._updateKeys();
    }
}
