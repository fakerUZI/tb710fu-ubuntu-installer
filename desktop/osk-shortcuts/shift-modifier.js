const SYMBOL_LANGUAGE = 'tbSymbolLanguage';
const CHINESE_PUNCTUATION = new Map([
    [',', ['，']], ['.', ['。', '……']], [';', ['；']], [':', ['：']],
    ['!', ['！']], ['?', ['？']], ['/', ['、', '／']], ['~', ['～']],
    ['(', ['（']], [')', ['）']], ['[', ['【', '［']], [']', ['】', '］']],
    ['{', ['｛']], ['}', ['｝']], ['<', ['《', '〈']], ['>', ['》', '〉']],
    ['"', ['“', '”']], ["'", ['‘', '’']],
]);

function useChinesePunctuation(keys) {
    return keys.map(key => {
        const punctuation = CHINESE_PUNCTUATION.get(key.strings?.[0]);
        return punctuation
            ? {...key, strings: [...new Set([...punctuation, ...key.strings])]}
            : key;
    });
}

function leadWithSymbols(keys, symbols) {
    const preferred = symbols.map(symbol => keys.find(key => key.strings?.[0] === symbol));
    return preferred.every(Boolean)
        ? [...preferred, ...keys.filter(key => !preferred.includes(key))]
        : keys;
}

function arrangeAdvancedSymbols(keys) {
    const ordered = leadWithSymbols(keys, ['[', ']', '\\', '©', '®', '™', '℅']);
    if (ordered === keys || ordered.length !== 7)
        return keys;
    const [left, right, slash, ...marks] = ordered;
    return [left, right, slash, {strings: ['≤']}, {strings: ['≥']}, {strings: ['≠']},
        {...marks[0], strings: marks.flatMap(key => key.strings)}];
}

function alignSymbolRow(keys, shiftKeyval, chineseSymbols) {
    const first = keys[0];
    const last = keys.at(-1);
    if (keys.length === 11 && last.action === 'delete') {
        const symbols = leadWithSymbols(keys.slice(0, -1), ['|', '`', '~']);
        return [{label: 'Tab', keyval: '0xff09'}, ...symbols, {...last, width: 2}];
    }
    if (keys.length === 10 && last.iconName === 'osk-enter-symbolic') {
        // The comma moves here from the space row, keeping punctuation full-size.
        const symbols = leadWithSymbols(
            [{...first, leftOffset: 0}, ...keys.slice(1, -1)], ['{', '}']);
        return [{label: chineseSymbols ? '英符' : '中符', action: SYMBOL_LANGUAGE},
            ...symbols, {strings: [',']}, last];
    }
    if (keys.length === 9 && ['opt', 'opt+shift'].includes(first.level) &&
        first.action === 'levelSwitch' && last.action === 'levelSwitch' && first.level === last.level) {
        const advancedPage = last.level === 'opt';
        const symbols = keys.slice(1, -1);
        const pageSwitch = advancedPage ? '⇧ ?123' : chineseSymbols ? '⇧ 【】|' : '⇧ []{}|';
        // The right Shift position changes pages. The left Shift still works for shortcuts.
        return [{label: 'Shift', action: 'modifier', keyval: shiftKeyval, width: 2},
            ...(advancedPage ? arrangeAdvancedSymbols(symbols) : symbols), {strings: ['.', '…']},
            {iconName: 'go-up-symbolic', keyval: '0xff52'}, {...last, label: pageSwitch, width: 2}];
    }
    const [, left, right, space, comma, period, emoji, language, hide] = keys;
    if (keys.length === 9 && first.action === 'levelSwitch' && first.level === 'default' &&
        space.strings?.[0] === ' ' && comma.strings?.[0] === ',' && period.strings?.[0] === '.' &&
        emoji.action === 'emoji' && language.action === 'languageMenu' && hide.action === 'hide') {
        return [
            {label: 'Ctrl', keyval: '0xffe3', action: 'modifier'},
            {...first, width: 1},
            {label: 'Alt', keyval: '0xffe9', action: 'modifier'},
            left,
            {...space, width: 2},
            right,
            emoji,
            language,
            {iconName: 'go-previous-symbolic', keyval: '0xff51'},
            {iconName: 'go-down-symbolic', keyval: '0xff54'},
            {iconName: 'go-next-symbolic', keyval: '0xff53'},
            hide,
        ];
    }
    return keys;
}

// Use the extended layout for every text purpose, not only terminals.
// Keep its upper Caps key and replace only the lower-left Shift.
// Native modifier registration supplies touch handling and the latched state.
export class TerminalShiftModifier {
    constructor(keyboard, shiftKeyval, terminalPurpose, onKeysAdded, nativePurposes = [], inputMethod = null) {
        this._keyboard = keyboard;
        this._shift = shiftKeyval;
        this._controller = keyboard._keyboardController;
        this._inputMethod = inputMethod;
        this._injected = new Set();
        this._down = false;
        this._chineseSymbols = false;
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
        // Only digit/number/phone purposes keep GNOME's numeric keypad, which is
        // what verification codes and amounts need. Every other purpose gets the
        // extended layout: the us, email and url layouts have no Ctrl, Shift or
        // Alt row at all, and password/PIN fields are still text.
        const numericPurposes = new Set(nativePurposes);
        keyboard._updateLayout = function (group, purpose) {
            extension._buildingExtendedLayout = !numericPurposes.has(purpose);
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
            // A plain row refresh rebuilds every key without going through
            // _updateLayout, so fall back to the purpose the controller holds.
            // Without it the injected Shift reverts to the native level switch.
            const extended = extension._buildingExtendedLayout ||
                this._keyboardController?.purpose === terminalPurpose;
            if (extended &&
                first?.action === 'levelSwitch' &&
                first.iconName === 'osk-shift-symbolic') {
                // The extended layout's lower-left key is a level switch, not a
                // modifier, so Ctrl+Shift+V can never be pressed there. Replace
                // it with a real Shift and keep the native row untouched.
                keys = [{action: 'modifier', keyval: shiftKeyval,
                    label: 'Shift', width: first.width, height: first.height,
                    leftOffset: first.leftOffset}, ...keys.slice(1)];
            }
            // The extended bottom row ships Ctrl/?123/Alt and no Shift. Chinese
            // input needs a comma on every press, so the row becomes:
            //   Ctrl ?123 Alt , [space] emoji -> ...
            // Alt takes the space freed by the injected Shift and the comma takes
            // Alt's old slot. The key count and total width stay unchanged.
            if (extended &&
                keys.some(key => key.action === 'modifier' && key.label === 'Ctrl') &&
                !keys.some(key => key.action === 'modifier' && key.label === 'Shift')) {
                const altIndex = keys.findIndex(key => key.action === 'modifier' && key.label === 'Alt');
                if (altIndex > 0) {
                    keys = [...keys];
                    const altKey = keys[altIndex];
                    keys[altIndex] = {strings: [','], label: ',', width: altKey.width};
                    keys.splice(altIndex, 0,
                        {action: 'modifier', keyval: altKey.keyval, label: 'Alt'});
                    const spaceIndex = keys.findIndex(key => key.strings?.[0] === ' ' && key.width > 1);
                    if (spaceIndex >= 0)
                        keys[spaceIndex] = {...keys[spaceIndex], width: keys[spaceIndex].width - 1};
                    // Both thumbs rest on the space bar, so the two keys they use
                    // most go beside it: emoji on the left, language menu on the
                    // right. The comma moves to the former emoji slot. The three
                    // keys are one column wide, so rotating them keeps the row.
                    const commaIndex = keys.findIndex(key => key.strings?.[0] === ',');
                    const emojiIndex = keys.findIndex(key => key.action === 'emoji');
                    const langIndex = keys.findIndex(key => key.action === 'languageMenu');
                    if (commaIndex >= 0 && emojiIndex >= 0 && langIndex >= 0) {
                        const commaKey = keys[commaIndex];
                        const emojiKey = keys[emojiIndex];
                        const langKey = keys[langIndex];
                        keys[commaIndex] = {...emojiKey, width: commaKey.width ?? 1};
                        keys[emojiIndex] = {...langKey, width: emojiKey.width ?? 1};
                        keys[langIndex] = {...commaKey, width: langKey.width ?? 1};
                    }
                }
            }
            if (layout.mode === 'locked') {
                const aligned = alignSymbolRow(keys, shiftKeyval, extension._chineseSymbols);
                keys = aligned !== keys && extension._chineseSymbols
                    ? useChinesePunctuation(aligned)
                    : aligned;
            }
            extension._addRowKeys.call(this, keys, layout, emojiVisible);
            const actors = layout.get_children();
            if (keys[0]?.action === SYMBOL_LANGUAGE) {
                const toggle = actors.find(key => key.keyButton?.get_label() === keys[0].label);
                if (toggle) {
                    toggle.keyButton.accessible_name =
                        extension._chineseSymbols ? '切换到英文标点' : '切换到中文标点';
                    toggle.connect('released', () =>
                        extension._toggleSymbolLanguage(layout).catch(error => console.error(error)));
                }
            }
            for (const key of actors) {
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
    async _toggleSymbolLanguage(layout) {
        // Rebuild after the released signal has finished using its key actor.
        await Promise.resolve();
        const keyboard = this._keyboard;
        if (this._destroyed || keyboard._currentPage !== layout)
            return;
        const level = Object.keys(keyboard._layers).find(name => keyboard._layers[name] === layout);
        if (!level)
            return;
        this._chineseSymbols = !this._chineseSymbols;
        keyboard._updateKeys();
        keyboard._setActiveLevel(level);
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
        this._destroyed = true;
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
