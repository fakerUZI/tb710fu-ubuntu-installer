import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {TerminalShiftModifier} from './shift-modifier.js';
import {ArrowRepeatManager} from './arrow-repeat.js';
import {CandidateRow} from './candidate-row.js';

const SHARED_ROW_HEIGHT = 80;

const GROUPS = [
    [
        {id: 'language', label: '中', hint: '切换中英文（Ctrl+空格）', action: 'language', language: true},
    ],
    [
        {id: 'select-all', label: '全选', icon: 'edit-select-all-symbolic', key: Clutter.KEY_a, ctrl: true, compact: true},
        {id: 'cut', label: '剪切', icon: 'edit-cut-symbolic', key: Clutter.KEY_x, ctrl: true, compact: true},
        {id: 'copy', label: '复制', icon: 'edit-copy-symbolic', key: Clutter.KEY_c, ctrl: true},
        {id: 'paste', label: '粘贴', icon: 'edit-paste-symbolic', key: Clutter.KEY_v, ctrl: true, primary: true},
        {id: 'clipboard', label: '剪贴板', icon: 'edit-paste-symbolic', action: 'clipboard'},
    ],
    [
        {id: 'undo', label: '撤销', icon: 'edit-undo-symbolic', key: Clutter.KEY_z, ctrl: true, compact: true},
        {id: 'redo', label: '重做', icon: 'edit-redo-symbolic', key: Clutter.KEY_z, ctrl: true, shift: true, compact: true},
        {id: 'screenshot', label: '截图', hint: '截图并保存、复制图片', action: 'screenshot', screenshot: true},
    ],
];

export default class OskShortcuts extends Extension {
    enable() {
        this._bar = null;
        this._disabled = false;
        this._preedit = '';
        this._auxPreedit = '';
        this._showPreedit = false;
        this._showAuxPreedit = false;
        this._compositionText = '';
        this._preeditSignal = Gio.DBus.session.signal_subscribe(null,
            'org.kde.kimpanel.inputmethod', null, null, null,
            Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, signal, args) =>
                this._onPreeditSignal(signal, args.deep_unpack()));
        this._preeditPurposeId = Main.inputMethod.connect('notify::content-purpose', () =>
            this._refreshComposition());
        this._preeditWatch = Gio.bus_watch_name(Gio.BusType.SESSION, 'org.fcitx.Fcitx5',
            Gio.BusNameWatcherFlags.NONE, null, () => {
                this._preedit = this._auxPreedit = '';
                this._showPreedit = this._showAuxPreedit = false;
                this._refreshComposition();
            });
        this._history = [];
        this._loadSavedScreenshots();
        this._languageKeys = new Map();
        this._languageState = 0;
        this._clipboardRead = 0;
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_selection, type, owner) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !owner)
                return;
            const types = owner.get_mimetypes();
            if (types.includes('x-kde-passwordManagerHint'))
                return;
            this._readClipboard();
        });
        this._buttons = new Map();
        this._visibilityId = Main.keyboard.connect('visibility-changed', () => {
            this._attach();
            this._refreshLanguage();
            this._syncWidth();
            if (!Main.keyboard.visible) {
                this._arrowRepeat?.stopAll();
                this._closeClipboard();
            }
        });
        this._monitorId = Main.layoutManager.connect('monitors-changed', () => this._keyboard?._relayout());
        this._attach();
        // The keyboard actor can be recreated by accessibility/touch-mode changes.
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
            this._attach();
            this._scanLanguageKeys();
            this._refreshLanguage();
            this._syncWidth();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _attach() {
        const keyboard = Main.keyboard.keyboardActor;
        if (!keyboard || !keyboard._keyboardController || this._keyboard === keyboard)
            return;
        try {
            this._detach();
        } catch (error) {
            // A rebuilt keyboard leaves disposed actors behind. Never let the
            // cleanup abort the attach, or the toolbar stays gone until relogin.
            logError(error, 'tb-osk-shortcuts: detach failed, forcing reattach');
            this._keyboard = null;
        }
        this._keyboard = keyboard;
        // A rebuilt keyboard actor can leave an event source that is already
        // gone; the native maybeHandleEvent then calls contains() on null every
        // frame and floods the journal. Skip only the unresolvable case.
        if (!Main.keyboard._tbMaybeHandleEvent) {
            Main.keyboard._tbMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
            Main.keyboard.maybeHandleEvent = function (event) {
                if (!global.stage.get_event_actor(event))
                    return false;
                return this._tbMaybeHandleEvent.call(this, event);
            };
        }
        this._toolbarLayoutKey = null;
        this._toolbarGroups = [];
        this._arrowRepeat = new ArrowRepeatManager(keyboard);
        this._shiftModifier = new TerminalShiftModifier(keyboard,
            Clutter.KEY_Shift_L, Clutter.InputContentPurpose.TERMINAL,
            layout => this._arrowRepeat.scan(layout),
            // Only these keep GNOME's native numeric keypad; every other purpose
            // is switched to the extended layout by TerminalShiftModifier.
            [Clutter.InputContentPurpose.DIGITS, Clutter.InputContentPurpose.NUMBER,
                Clutter.InputContentPurpose.PHONE],
            Main.inputMethod);
        const bar = new St.BoxLayout({
            style_class: 'tb-osk-shortcuts', x_expand: true,
        });
        const contents = new St.BoxLayout({
            style_class: 'tb-osk-shortcut-groups', x_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(contents);
        for (const entries of GROUPS) {
            const group = new St.BoxLayout({style_class: 'tb-osk-shortcut-group', x_expand: true});
            for (const entry of entries) {
                const button = this._makeButton(entry);
                group.add_child(button);
                this._buttons.set(entry.id, button);
            }
            contents.add_child(group);
            this._toolbarGroups.push({actor: group, ids: entries.map(entry => entry.id)});
        }
        // Share one slot with the native candidate row. Keep its original
        // object intact: Kimpanel and GNOME still populate it through their APIs.
        this._suggestions = keyboard._suggestions;
        this._candidateRow = new CandidateRow(Main.keyboard, this._suggestions);
        this._suggestionIndex = keyboard.get_children().indexOf(this._suggestions);
        const slot = new St.Widget({
            style_class: 'tb-osk-shared-row', x_expand: false, x_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        const candidateBox = new St.BoxLayout({
            style_class: 'tb-osk-composition', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const candidateFrame = new St.Widget({
            style_class: 'tb-osk-candidate-frame', x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._preeditLabel = new St.Label({
            text: this._compositionText, style_class: 'tb-osk-preedit',
            x_expand: true, reactive: false,
        });
        this._preeditLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._preeditLabel.clutter_text.single_line_mode = true;
        this._suggestions.x_expand = true;
        this._suggestions.y_align = Clutter.ActorAlign.CENTER;
        bar.y_align = Clutter.ActorAlign.CENTER;
        keyboard.remove_child(this._suggestions);
        candidateBox.add_child(this._preeditLabel);
        candidateBox.add_child(this._suggestions);
        candidateFrame.add_child(candidateBox);
        slot.add_child(candidateFrame);
        slot.add_child(bar);
        keyboard.insert_child_at_index(slot, Math.max(0, this._suggestionIndex));
        this._bar = bar;
        this._slot = slot;
        this._candidateBox = candidateBox;
        this._candidateFrame = candidateFrame;
        this._applySharedRowSize();
        this._childAddedId = this._suggestions.connect('child-added', () => this._syncRow());
        this._childRemovedId = this._suggestions.connect('child-removed', () => this._syncRow());
        this._originalRelayout = keyboard._relayout;
        const extension = this;
        keyboard._relayout = function (...args) {
            this.set_height(-1);
            extension._applySharedRowSize();
            extension._originalRelayout.apply(this, args);
            // The show animation translates by this height, while allocation
            // rounds it to pixels. A fractional third-screen height can expose
            // one physical row of the app below the keyboard in landscape.
            const monitor = Main.layoutManager.keyboardMonitor;
            const baseHeight = monitor ? monitor.height / (monitor.width > monitor.height ? 3 : 4) : this.height;
            this.height = Math.ceil(Math.max(this.height, baseHeight));
        };
        this._originalKeyboardOpen = keyboard.open;
        keyboard.open = (...args) => {
            if (!this._screenshotBusy)
                return this._originalKeyboardOpen.apply(keyboard, args);
        };
        this._aspectWidthId = keyboard._aspectContainer.connect('notify::width', () => this._syncWidth());
        this._originalLanguageMenu = keyboard._popupLanguageMenu;
        const extensionForLanguage = this;
        keyboard._popupLanguageMenu = function (key) {
            if (extensionForLanguage._languageLongPressedKey === key) {
                extensionForLanguage._languageLongPressedKey = null;
                return;
            }
            extensionForLanguage._toggleLanguage();
        };
        this._scanLanguageKeys();
        this._createClipboardPanel();
        this._refreshComposition();
        this._syncRow();
        keyboard._relayout();
        this._syncWidth();
    }
    _applySharedRowSize() {
        // Reserve both pinyin and candidates even while the toolbar is shown.
        // Content changes must never change the keyboard's outer allocation.
        for (const actor of [this._slot, this._bar, this._candidateFrame]) {
            if (actor && actor.height !== SHARED_ROW_HEIGHT)
                actor.height = SHARED_ROW_HEIGHT;
        }
    }
    getLayoutMetrics() {
        return {sharedHeight: this._slot?.height ?? 0,
            inputPurpose: Main.inputMethod.content_purpose,
            toolbarHeight: this._bar?.height ?? 0,
            candidateHeight: this._candidateFrame?.height ?? 0,
            sharedWidth: this._slot?.width ?? 0,
            toolbarWidth: this._bar?.width ?? 0,
            toolbarContentWidth: this._bar?.get_first_child()?.width ?? 0,
            toolbarButtonCount: this._buttons?.size ?? 0,
            toolbarX: this._bar?.get_transformed_position()[0] ?? 0,
            gridX: this._keyboard?._aspectContainer?.get_transformed_position()[0] ?? 0,
            keyboardHeight: this._keyboard?.height ?? 0,
            gridHeight: this._keyboard?._aspectContainer?.height ?? 0,
            gridWidth: this._keyboard?._aspectContainer?.width ?? 0,
            candidateSlots: this._candidateRow?.ownsSuggestions() ? 5 : 0,
            candidateWidths: this._candidateRow?.ownsSuggestions() ? this._candidateRow._buttons.map(b => b.width) : [],
            showingToolbar: !!this._bar?.visible};
    }
    _syncRow() {
        if (!this._bar || !this._suggestions)
            return;
        const hasCandidates = this._candidateRow?.ownsSuggestions() ?
            this._candidateRow.active : this._suggestions.get_n_children() > 0;
        const hasPreedit = !!this._compositionText;
        this._preeditLabel.visible = hasPreedit;
        if (hasCandidates || hasPreedit)
            this._closeClipboard();
        this._bar.visible = !hasCandidates && !hasPreedit;
        this._candidateFrame.visible = hasCandidates || hasPreedit;
        this._candidateBox.visible = hasCandidates || hasPreedit;
        this._suggestions.visible = hasCandidates;
    }
    setCandidateTable(texts, hasPrev, hasNext, onSelect, onPage) {
        if (!this._candidateRow)
            return;
        this._pendingCandidateTable = [texts, hasPrev, hasNext, onSelect, onPage];
        if (this._candidateLater)
            return;
        this._candidateLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._candidateLater = 0;
            const table = this._pendingCandidateTable;
            this._pendingCandidateTable = null;
            if (!this._candidateRow || !table)
                return GLib.SOURCE_REMOVE;
            this._syncWidth();
            this._candidateRow.setWidth(this._alignedWidth || this._slot.width);
            this._candidateRow.update(...table);
            this._syncRow();
            return GLib.SOURCE_REMOVE;
        });
    }
    getCandidateCount() {
        return this._candidateRow?.ownsSuggestions() ? this._candidateRow.visibleCount() :
            this._suggestions?.get_n_children() ?? 0;
    }
    _onPreeditSignal(signal, args) {
        if (this._disabled)
            return;
        switch (signal) {
        case 'UpdatePreeditText': this._preedit = args[0]; break;
        case 'ShowPreedit': this._showPreedit = args[0]; break;
        case 'UpdateAux': this._auxPreedit = args[0]; break;
        case 'ShowAux': this._showAuxPreedit = args[0]; break;
        default: return;
        }
        this._refreshComposition();
    }
    _refreshComposition() {
        const purpose = Main.inputMethod.content_purpose;
        const sensitive = purpose === Clutter.InputContentPurpose.PASSWORD ||
            purpose === Clutter.InputContentPurpose.PIN ||
            Main.actionMode === Shell.ActionMode.LOCK_SCREEN;
        this._compositionText = sensitive ? '' :
            (this._showPreedit ? this._preedit : this._showAuxPreedit ? this._auxPreedit : '');
        if (this._preeditLabel) {
            this._preeditLabel.text = this._compositionText;
            this._syncRow();
        }
    }
    _makeButton(entry) {
        const button = new St.Button({
            accessible_name: entry.hint ?? entry.label,
            can_focus: false, reactive: true, track_hover: true,
            x_expand: true,
            style_class: `tb-osk-action${entry.primary ? ' tb-osk-action-primary' : ''}${entry.arrow ? ' tb-osk-action-arrow' : ''}${entry.compact ? ' tb-osk-action-compact' : ''}${entry.language ? ' tb-osk-language-toggle' : ''}${entry.tab ? ' tb-osk-action-tab' : ''}${entry.screenshot ? ' tb-osk-action-screenshot' : ''}`,
        });
        const content = new St.BoxLayout({
            style_class: 'tb-osk-action-content',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        if (entry.icon)
            content.add_child(new St.Icon({icon_name: entry.icon, style_class: 'tb-osk-action-icon'}));
        button._tbLabel = new St.Label({text: entry.label, visible: !entry.compact,
            y_align: Clutter.ActorAlign.CENTER});
        content.add_child(button._tbLabel);
        button.set_child(content);
        if (entry.arrow)
            this._arrowRepeat.bindToolbar(button, () => this._send(entry));
        else
            this._bindAction(button, () => this._send(entry));
        return button;
    }
    _bindAction(button, action) {
        let feedbackId = 0;
        button.connect('clicked', action);
        button.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            button.add_style_pseudo_class('active');
            if (feedbackId)
                GLib.source_remove(feedbackId);
            feedbackId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 150, () => {
                feedbackId = 0;
                button.remove_style_pseudo_class('active');
            });
            action();
            return Clutter.EVENT_STOP;
        });
        button.connect('destroy', () => {
            if (feedbackId)
                GLib.source_remove(feedbackId);
            feedbackId = 0;
        });
    }
    _fcitxCall(method) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call('org.fcitx.Fcitx5', '/controller',
                'org.fcitx.Fcitx.Controller1', method, null, null,
                Gio.DBusCallFlags.NO_AUTO_START, 1500, null, (bus, result) => {
                    try { resolve(bus.call_finish(result).deep_unpack()); }
                    catch (error) { reject(error); }
                });
        });
    }
    async _refreshLanguage() {
        if (this._disabled || this._languageQueryPending || !Main.keyboard.visible)
            return;
        this._languageQueryPending = true;
        try {
            const [state] = await this._fcitxCall('State');
            if (!this._disabled)
                this._setLanguageState(state);
        } catch (_error) {
            if (!this._disabled)
                this._setLanguageState(0);
        } finally {
            this._languageQueryPending = false;
        }
    }
    _setLanguageState(state) {
        this._languageState = state;
        const text = state === 2 ? '中' : state === 1 ? 'EN' : '中/EN';
        const button = this._buttons.get('language');
        if (button?._tbLabel) {
            button._tbLabel.text = text;
            button.accessible_name = state === 2 ? '当前中文，点按切换英文' : '当前英文，点按切换中文';
            if (state === 2)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        for (const {key, label} of this._languageKeys.values()) {
            label.text = text;
            key.keyButton.accessible_name = button?.accessible_name ?? '切换中英文';
            if (state === 2)
                key.keyButton.add_style_class_name('tb-osk-language-chinese');
            else
                key.keyButton.remove_style_class_name('tb-osk-language-chinese');
        }
    }
    async _toggleLanguage() {
        if (this._languageTogglePending || this._disabled)
            return;
        this._closeClipboard();
        this._languageTogglePending = true;
        try {
            await this._fcitxCall('Toggle');
            const [state] = await this._fcitxCall('State');
            if (!this._disabled)
                this._setLanguageState(state);
        } catch (_error) {
            // The same shortcut also works if the controller is restarting.
            if (!this._disabled)
                this._send({key: Clutter.KEY_space, ctrl: true});
        } finally {
            this._languageTogglePending = false;
        }
    }
    _scanLanguageKeys() {
        const keyboard = this._keyboard;
        if (!keyboard?._layers)
            return;
        const visit = actor => {
            if (actor._icon?.icon_name === 'osk-layout-symbolic' &&
                actor.keyButton && !this._languageKeys.has(actor)) {
                const icon = actor._icon;
                const box = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                actor.keyButton.set_child(null);
                box.add_child(icon);
                icon.hide();
                const label = new St.Label({text: '中/EN', y_align: Clutter.ActorAlign.CENTER});
                box.add_child(label);
                actor.keyButton.set_child(box);
                actor.keyButton.add_style_class_name('tb-osk-language-key');
                const item = {key: actor, icon, box, label};
                item.longPressId = actor.connect('long-press', () => {
                    this._languageLongPressedKey = actor;
                    this._originalLanguageMenu.call(keyboard, actor);
                });
                item.destroyId = actor.connect('destroy', () => this._languageKeys.delete(actor));
                this._languageKeys.set(actor, item);
            }
            for (const child of actor.get_children())
                visit(child);
        };
        for (const layer of Object.values(keyboard._layers))
            visit(layer);
        this._setLanguageState(this._languageState);
    }
    _restoreLanguageKeys() {
        for (const item of this._languageKeys.values()) {
            item.key.disconnect(item.longPressId);
            item.key.disconnect(item.destroyId);
            item.key.keyButton.set_child(null);
            item.box.remove_child(item.icon);
            item.key.keyButton.set_child(item.icon);
            item.icon.show();
            item.key.keyButton.remove_style_class_name('tb-osk-language-key');
            item.key.keyButton.remove_style_class_name('tb-osk-language-chinese');
            item.box.destroy();
        }
        this._languageKeys.clear();
    }
    _syncWidth() {
        const grid = this._keyboard?._aspectContainer;
        if (!grid || !this._slot || grid.width < 100 || this._clipboardOpen ||
            !grid.visible || !Main.keyboard.visible)
            return;
        const [gridX] = grid.get_transformed_position();
        const [keyboardX] = this._keyboard.get_transformed_position();
        // Hidden actors retain an old position while reporting a new width.
        // Wait for a real centered allocation before updating the shared row.
        if (Math.abs(gridX - keyboardX - (this._keyboard.width - grid.width) / 2) > 1)
            return;
        const width = Math.round(grid.width);
        this._alignedWidth = width;
        this._syncToolbarLayout(width);
        if (Math.abs(this._slot.width - width) > 1)
            this._slot.width = width;
        if (this._clipboardPanel && Math.abs(this._clipboardPanel.width - width) > 1)
            this._clipboardPanel.width = width;
        this._fitCandidates(width);
    }
    _syncToolbarLayout(width) {
        const roomy = width >= 800;
        const narrow = width < 640;
        const keypad = width < 400;
        const keypadActions = new Set(['select-all', 'copy', 'paste', 'clipboard']);
        const key = `${roomy}:${narrow}:${keypad}`;
        if (this._toolbarLayoutKey === key)
            return;
        this._toolbarLayoutKey = key;
        if (narrow)
            this._bar.add_style_class_name('tb-osk-toolbar-narrow');
        else
            this._bar.remove_style_class_name('tb-osk-toolbar-narrow');
        for (const entry of GROUPS.flat()) {
            const button = this._buttons.get(entry.id);
            if (button)
                button.visible = !keypad || keypadActions.has(entry.id);
            const label = button?._tbLabel;
            if (label)
                label.visible = !((entry.compact && !roomy) || (entry.icon && narrow));
        }
        for (const group of this._toolbarGroups)
            group.actor.visible = group.ids.some(id => this._buttons.get(id)?.visible);
    }
    _fitCandidates(width) {
        if (!this._suggestions)
            return;
        if (this._candidateRow?.ownsSuggestions()) {
            this._candidateRow.setWidth(width);
            return;
        }
        const buttons = this._suggestions.get_children();
        if (!buttons.length)
            return;
        this._suggestions.set_style('spacing: 6px; padding: 6px 12px;');
        const isPage = button => button.label === '‹' || button.label === '›';
        const pageButtons = buttons.filter(isPage).length;
        const overhead = 24 + buttons.length * 4 + Math.max(0, buttons.length - 1) * 6;
        const itemWidth = Math.min(160, Math.floor((width - overhead - pageButtons * 44) /
            Math.max(1, buttons.length - pageButtons)));
        for (const button of buttons) {
            button.set_style('min-width: 24px; padding: 6px 8px; margin: 0 2px;');
            button.width = isPage(button) ? 44 : Math.max(40, itemWidth);
            const label = button.get_child();
            if (label?.clutter_text)
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
    }
    _delay(milliseconds) {
        return new Promise(resolve => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, milliseconds, resolve));
    }
    async _takeScreenshot() {
        if (this._screenshotBusy || this._disabled)
            return;
        const keyboard = this._keyboard;
        const restoreKeyboard = Main.keyboard.visible;
        const button = this._buttons.get('screenshot');
        this._screenshotBusy = true;
        if (button)
            button.reactive = false;
        this._closeClipboard();
        try {
            Main.keyboard.close();
            await this._delay(650);
            const stream = Gio.MemoryOutputStream.new_resizable();
            const shot = new Shell.Screenshot();
            try {
                await new Promise((resolve, reject) => {
                    shot.screenshot(false, stream, (source, result) => {
                        try { source.screenshot_finish(result); resolve(); }
                        catch (error) { reject(error); }
                    });
                });
            } finally {
                stream.close(null);
            }
            const bytes = stream.steal_as_bytes();
            const directory = this._screenshotDirectory();
            GLib.mkdir_with_parents(directory, 0o700);
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S_%f');
            const path = GLib.build_filenamev([directory, `截图_${stamp}.png`]);
            const file = Gio.File.new_for_path(path);
            file.replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.PRIVATE, null);
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            this._lastScreenshotPath = path;
            this._rememberScreenshot(path);
            Main.notify('截图已保存', `已保存到“图片/截图”，并复制到剪贴板。`);
        } catch (error) {
            Main.notify('截图未完成', error.message);
        } finally {
            this._screenshotBusy = false;
            if (button && !this._disabled)
                button.reactive = true;
            if (!this._disabled && restoreKeyboard && keyboard === this._keyboard && Main.inputMethod.currentFocus)
                Main.keyboard.open(Main.layoutManager.focusIndex);
        }
    }
    _screenshotDirectory() {
        const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
            GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
        return GLib.build_filenamev([pictures, '截图']);
    }
    _loadSavedScreenshots() {
        const directory = Gio.File.new_for_path(this._screenshotDirectory());
        try {
            const files = [];
            const enumerator = directory.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name();
                if (info.get_file_type() === Gio.FileType.REGULAR && /^截图_.*\.png$/.test(name))
                    files.push(name);
            }
            enumerator.close(null);
            this._history = files.sort().reverse().slice(0, 20).map(name => ({
                kind: 'image', path: directory.get_child(name).get_path(),
            }));
        } catch (_error) {
            // No screenshot directory before the first capture.
        }
    }
    _rememberScreenshot(path) {
        this._history = [{kind: 'image', path},
            ...this._history.filter(item => typeof item === 'string' || item.path !== path)].slice(0, 20);
        if (this._clipboardOpen)
            this._renderHistory();
    }
    _viewScreenshot(path) {
        this._closeClipboard();
        Main.keyboard.close();
        try {
            const file = Gio.File.new_for_path(path);
            const viewer = GioUnix.DesktopAppInfo.new('org.gnome.Loupe.desktop');
            if (viewer)
                viewer.launch([file], null);
            else
                Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
        } catch (error) {
            Main.notify('无法打开截图', error.message);
        }
    }
    _pasteScreenshot(path) {
        try {
            const [bytes] = Gio.File.new_for_path(path).load_bytes(null);
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            this._closeClipboard();
            this._send({key: Clutter.KEY_v, ctrl: true});
        } catch (error) {
            Main.notify('无法粘贴截图', error.message);
        }
    }
    _renderScreenshotItem(item, index) {
        const card = new St.BoxLayout({style_class: 'tb-osk-clipboard-image', x_expand: true});
        const file = Gio.File.new_for_path(item.path);
        const thumbnail = new St.Button({can_focus: false, reactive: true, style_class: 'tb-osk-screenshot-preview',
            accessible_name: '查看截图', child: new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: 72})});
        this._bindAction(thumbnail, () => this._viewScreenshot(item.path));
        card.add_child(thumbnail);
        const details = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'tb-osk-screenshot-details'});
        details.add_child(new St.Label({text: `${String(index + 1).padStart(2, '0')}  截图`,
            style_class: 'tb-osk-screenshot-title'}));
        const caption = new St.Label({text: file.get_basename().replace(/^截图_|\.png$/g, ''),
            style_class: 'tb-osk-screenshot-caption', x_expand: true});
        caption.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        details.add_child(caption);
        card.add_child(details);
        for (const [label, action] of [['查看', () => this._viewScreenshot(item.path)],
            ['粘贴', () => this._pasteScreenshot(item.path)]]) {
            const button = new St.Button({label, can_focus: false, reactive: true,
                style_class: 'tb-osk-action', y_align: Clutter.ActorAlign.CENTER});
            this._bindAction(button, action);
            card.add_child(button);
        }
        this._clipboardList.add_child(card);
    }
    _isSensitive() {
        const purpose = Main.inputMethod.content_purpose;
        return Main.sessionMode.isLocked ||
            purpose === Clutter.InputContentPurpose.PASSWORD ||
            purpose === Clutter.InputContentPurpose.PIN;
    }
    _readClipboard() {
        const generation = ++this._clipboardRead;
        if (this._disabled || this._isSensitive())
            return;
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (this._disabled || generation !== this._clipboardRead ||
                this._isSensitive() || !text || !text.trim() || text.length > 65536)
                return;
            this._history = [text, ...this._history.filter(item => item !== text)].slice(0, 20);
            if (this._clipboardOpen)
                this._renderHistory();
        });
    }
    _createClipboardPanel() {
        const panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tb-osk-clipboard-panel', x_expand: false, y_expand: true, x_align: Clutter.ActorAlign.CENTER,
        });
        const header = new St.BoxLayout({style_class: 'tb-osk-clipboard-header', x_expand: true});
        this._clipboardTitle = new St.Label({
            text: '剪贴板', style_class: 'tb-osk-clipboard-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._clipboardTitle);
        header.add_child(this._makeButton({label: '清空', icon: 'edit-clear-all-symbolic', action: 'clipboard-clear'}));
        header.add_child(this._makeButton({label: '返回键盘', icon: 'input-keyboard-symbolic', action: 'clipboard-close'}));
        panel.add_child(header);
        this._clipboardList = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tb-osk-clipboard-list', x_expand: true,
        });
        const scroll = new St.ScrollView({
            style_class: 'tb-osk-clipboard-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scroll.set_child(this._clipboardList);
        panel.add_child(scroll);
        this._keyboard.add_child(panel);
        panel.hide();
        this._clipboardPanel = panel;
    }
    _renderHistory() {
        if (!this._clipboardList)
            return;
        this._clipboardList.destroy_all_children();
        this._clipboardTitle.text = `剪贴板 · ${this._history.length} 条`;
        if (!this._history.length) {
            this._clipboardList.add_child(new St.Label({
                text: '复制文字或截图后会显示在这里', style_class: 'tb-osk-clipboard-empty',
            }));
            return;
        }
        this._history.forEach((entry, index) => {
            if (typeof entry !== 'string') {
                this._renderScreenshotItem(entry, index);
                return;
            }
            const text = entry;
            const button = new St.Button({
                can_focus: false, reactive: true, track_hover: true, x_expand: true,
                style_class: 'tb-osk-clipboard-item', accessible_name: `粘贴第 ${index + 1} 条`,
            });
            const row = new St.BoxLayout({style_class: 'tb-osk-clipboard-item-content', x_expand: true});
            row.add_child(new St.Label({text: String(index + 1).padStart(2, '0'), style_class: 'tb-osk-clipboard-index'}));
            const preview = new St.Label({
                text: text.replace(/\n/g, ' ↵ ').replace(/\s+/g, ' ').slice(0, 120),
                x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            });
            preview.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(preview);
            row.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'tb-osk-action-icon'}));
            button.set_child(row);
            this._bindAction(button, () => {
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
                this._closeClipboard();
                this._send({key: Clutter.KEY_v, ctrl: true});
            });
            this._clipboardList.add_child(button);
        });
    }
    _openClipboard() {
        if (!this._clipboardPanel)
            return;
        this._syncWidth();
        this._clipboardOpen = true;
        if (this._alignedWidth) {
            this._slot.width = this._alignedWidth;
            this._clipboardPanel.width = this._alignedWidth;
        }
        this._keyboard._aspectContainer.hide();
        this._clipboardPanel.show();
        this._buttons.get('clipboard')?.add_style_pseudo_class('checked');
        this._renderHistory();
        this._readClipboard();
    }
    _closeClipboard() {
        if (!this._clipboardOpen)
            return;
        this._clipboardOpen = false;
        this._clipboardPanel?.hide();
        this._keyboard?._aspectContainer.show();
        this._buttons.get('clipboard')?.remove_style_pseudo_class('checked');
    }
    _terminalFocused() {
        const window = global.display.focus_window;
        if (!window)
            return false;
        let ident = '';
        try {
            ident = [window.get_wm_class(), window.get_gtk_application_id?.(),
                window.get_sandboxed_app_id?.()].filter(Boolean).join(' ');
        } catch (_error) {
            return false;
        }
        return /terminal|console|ptyxis|kgx|kitty|alacritty|wezterm|foot/
            .test(ident.toLowerCase());
    }

    _send(entry) {
        // Terminals bind paste to Ctrl+Shift+V; a plain Ctrl+V is quoted-insert.
        if (entry.ctrl && !entry.shift && entry.key === Clutter.KEY_v &&
            this._terminalFocused())
            entry = {...entry, shift: true};
        if (entry.action === 'screenshot') {
            this._takeScreenshot();
            return;
        }
        if (entry.action === 'language') {
            this._toggleLanguage();
            return;
        }
        if (entry.action === 'clipboard') {
            if (this._clipboardOpen)
                this._closeClipboard();
            else
                this._openClipboard();
            return;
        }
        if (entry.action === 'clipboard-close') {
            this._closeClipboard();
            return;
        }
        if (entry.action === 'clipboard-clear') {
            this._history = [];
            this._clipboardRead++;
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
            this._renderHistory();
            return;
        }
        this._closeClipboard();
        const controller = this._keyboard?._keyboardController;
        if (!controller)
            return;
        if (entry.ctrl)
            controller.keyvalPress(Clutter.KEY_Control_L);
        if (entry.shift)
            controller.keyvalPress(Clutter.KEY_Shift_L);
        try {
            controller.keyvalPress(entry.key);
            controller.keyvalRelease(entry.key);
        } finally {
            if (entry.shift)
                controller.keyvalRelease(Clutter.KEY_Shift_L);
            if (entry.ctrl)
                controller.keyvalRelease(Clutter.KEY_Control_L);
        }
    }
    _detach() {
        const keyboard = this._keyboard;
        this._closeClipboard();
        this._restoreLanguageKeys();
        this._arrowRepeat?.destroy();
        this._arrowRepeat = null;
        this._shiftModifier?.destroy();
        this._shiftModifier = null;
        if (keyboard && this._originalKeyboardOpen)
            keyboard.open = this._originalKeyboardOpen;
        this._originalKeyboardOpen = null;
        if (keyboard && this._aspectWidthId) {
            try {
                keyboard._aspectContainer?.disconnect(this._aspectWidthId);
            } catch (_error) {
                // The AspectContainer was disposed together with an older
                // keyboard actor; there is nothing left to disconnect.
            }
        }
        this._aspectWidthId = 0;
        if (keyboard && this._originalLanguageMenu)
            keyboard._popupLanguageMenu = this._originalLanguageMenu;
        this._originalLanguageMenu = null;
        this._clipboardPanel?.destroy();
        this._clipboardPanel = this._clipboardList = this._clipboardTitle = null;
        if (this._suggestions) {
            if (this._childAddedId)
                this._suggestions.disconnect(this._childAddedId);
            if (this._childRemovedId)
                this._suggestions.disconnect(this._childRemovedId);
        }
        this._childAddedId = this._childRemovedId = 0;
        if (this._candidateLater)
            global.compositor.get_laters().remove(this._candidateLater);
        this._candidateLater = 0;
        this._pendingCandidateTable = null;
        this._candidateRow?.destroy();
        this._candidateRow = null;
        if (keyboard && this._originalRelayout)
            keyboard._relayout = this._originalRelayout;
        if (this._candidateBox && this._suggestions?.get_parent() === this._candidateBox) {
            this._candidateBox.remove_child(this._suggestions);
            if (keyboard?.get_parent()) {
                this._suggestions.show();
                keyboard.insert_child_at_index(this._suggestions, Math.max(0, this._suggestionIndex));
            }
        }
        this._slot?.destroy();
        this._slot = this._bar = this._suggestions = null;
        this._candidateBox = this._candidateFrame = this._preeditLabel = null;
        this._buttons.clear();
        this._toolbarGroups = [];
        if (keyboard?.get_parent()) {
            keyboard.set_height(-1);
            keyboard._relayout();
        }
        this._keyboard = null;
        this._originalRelayout = null;
    }
    disable() {
        this._disabled = true;
        if (this._preeditSignal)
            Gio.DBus.session.signal_unsubscribe(this._preeditSignal);
        if (this._preeditWatch)
            Gio.bus_unwatch_name(this._preeditWatch);
        if (this._preeditPurposeId)
            Main.inputMethod.disconnect(this._preeditPurposeId);
        this._preeditSignal = this._preeditWatch = this._preeditPurposeId = 0;
        this._compositionText = this._preedit = this._auxPreedit = '';
        this._clipboardRead++;
        if (this._ownerId)
            this._selection.disconnect(this._ownerId);
        this._ownerId = 0;
        this._history = [];
        if (this._visibilityId)
            Main.keyboard.disconnect(this._visibilityId);
        if (this._pollId)
            GLib.source_remove(this._pollId);
        if (this._monitorId)
            Main.layoutManager.disconnect(this._monitorId);
        this._monitorId = 0;
        this._visibilityId = 0;
        this._pollId = 0;
        this._detach();
    }
}
