// Touch-friendly window controls for droidloom Android windows under GNOME.
//
// Why this exists: mutter does not implement server-side decorations at all,
// and droidloom creates its Wayland toplevels without client-side decorations.
// The result is a borderless window with no titlebar, no edge-resize and no
// touch grab area. On a tablet with no keyboard there is then no way to move,
// resize or fullscreen an Android app.
//
// This extension adds a top-bar entry that appears while a droidloom window is
// focused. It offers fullscreen, maximize, a few sensible sizes and an
// explicit resize mode with fat corner handles (two-finger-precision friendly)
// plus a move handle. Everything is done through Meta.Window so no compositor
// or droidloom changes are needed.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {AndroidNavigation} from './navigation.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HANDLE_SIZE = 28;      // logical px; 56 physical px on the 2x panel
const MOVE_HANDLE_WIDTH = 104;
const DONE_WIDTH = 176;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 240;

const CORNERS = ['nw', 'ne', 'sw', 'se'];

function logMessage(message) {
    log(`[tb-android-windows] ${message}`);
}

// Read the package list from the catalog that droidloom-applications keeps in
// the user's applications directory. Only managed entries are Android apps.
function loadAndroidPackages() {
    const packages = new Set();
    const directory = GLib.build_filenamev([
        GLib.get_user_data_dir(), 'applications',
    ]);
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(directory).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return packages;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (!name.startsWith('droidloom-') || !name.endsWith('.desktop'))
            continue;
        try {
            const [ok, bytes] = GLib.file_get_contents(
                GLib.build_filenamev([directory, name]));
            if (!ok)
                continue;
            const text = new TextDecoder().decode(bytes);
            if (!/^X-Droidloom-Managed=true$/m.test(text))
                continue;
            const match = text.match(/^X-Droidloom-Package=(.+)$/m);
            if (match)
                packages.add(match[1].trim());
        } catch (e) {
            // A race with catalog regeneration: ignore this file.
        }
    }
    enumerator.close(null);
    return packages;
}

export default class AndroidWindowControlsExtension extends Extension {
    enable() {
        this._packages = loadAndroidPackages();
        this._target = null;
        this._windowSignals = [];
        this._handles = null;
        this._doneButton = null;
        this._resizing = false;
        this._drag = null;

        this._indicator = new PanelMenu.Button(0.0, 'TB Android window controls', false);
        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({
            icon_name: 'view-fullscreen-symbolic',
            style_class: 'system-status-icon',
        }));
        box.add_child(new St.Label({
            text: '安卓',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'tb-android-panel-label',
        }));
        this._indicator.add_child(box);
        this._indicator.visible = false;
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._buildMenu();
        this._navigation = new AndroidNavigation(window => this._isAndroidWindow(window));

        this._mappedWindows = new WeakSet(global.get_window_actors()
            .map(actor => actor.meta_window).filter(Boolean));
        this._mapId = global.window_manager.connect('map', (_, actor) =>
            this._maximizeNewAndroidWindow(actor.meta_window));
        this._focusId = global.display.connect(
            'notify::focus-window', () => this._syncTarget());

        // Keep a filled Android window fitting the work area across rotation.
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => {
            this._fitIfOverflowing();
            this._refreshMenu();
        });

        // Keep the package set fresh when apps are installed or removed.
        const directory = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'applications',
        ]);
        try {
            this._fileMonitor = Gio.File.new_for_path(directory).monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._fileMonitorId = this._fileMonitor.connect('changed', () => {
                this._packages = loadAndroidPackages();
                this._syncTarget();
            });
        } catch (e) {
            this._fileMonitor = null;
        }

        this._syncTarget();
        logMessage(`enabled, ${this._packages.size} Android packages`);
    }

    disable() {
        this._stopResize();
        this._untrackWindow();
        this._navigation?.destroy();
        this._navigation = null;

        global.window_manager.disconnect(this._mapId);
        this._mapId = 0;
        this._mappedWindows = null;
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._fileMonitor) {
            if (this._fileMonitorId)
                this._fileMonitor.disconnect(this._fileMonitorId);
            this._fileMonitor.cancel();
            this._fileMonitor = null;
            this._fileMonitorId = 0;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._target = null;
    }

    _maximizeNewAndroidWindow(window) {
        if (!window || this._mappedWindows.has(window))
            return;
        this._mappedWindows.add(window);

        if (window.get_window_type() !== Meta.WindowType.NORMAL || window.get_transient_for() ||
            window.get_client_type() !== Meta.WindowClientType.WAYLAND ||
            window.is_fullscreen() || window.is_maximized() || !window.can_maximize())
            return;
        const pid = window.get_pid();
        if (pid <= 0)
            return;

        // The presenter owns every Android toplevel, even before its package
        // appears in the desktop catalog.
        let executable;
        try {
            executable = GLib.path_get_basename(GLib.file_read_link(`/proc/${pid}/exe`));
        } catch (_) {
            return;
        }
        if (executable === 'droidloom-wayland' || executable === 'droidloom-wayland (deleted)')
            window.maximize();
    }

    _buildMenu() {
        const menu = this._indicator.menu;
        this._fullscreenItem = new PopupMenu.PopupMenuItem('全屏');
        this._fullscreenItem.connect('activate', () => this._toggleFullscreen());
        menu.addMenuItem(this._fullscreenItem);

        this._maximizeItem = new PopupMenu.PopupMenuItem('最大化');
        this._maximizeItem.connect('activate', () => this._toggleMaximize());
        menu.addMenuItem(this._maximizeItem);

        const minimizeItem = new PopupMenu.PopupMenuItem('最小化');
        minimizeItem.connect('activate', () => {
            const window = this._target;
            this._stopResize();
            menu.close();
            window?.minimize();
        });
        menu.addMenuItem(minimizeItem);

        this._sizeMenu = new PopupMenu.PopupSubMenuMenuItem('尺寸');
        menu.addMenuItem(this._sizeMenu);

        const addSizeItem = (label, callback) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', callback);
            this._sizeMenu.menu.addMenuItem(item);
            return item;
        };
        addSizeItem('铺满工作区', () => this._fillWorkArea());
        addSizeItem('竖屏手机 480×800', () => this._setSize(480, 800));
        addSizeItem('左半屏', () => this._halfScreen('left'));
        addSizeItem('右半屏', () => this._halfScreen('right'));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._resizeItem = new PopupMenu.PopupMenuItem('调整大小…');
        this._resizeItem.connect('activate', () => this._toggleResizeMode());
        menu.addMenuItem(this._resizeItem);

        this._closeItem = new PopupMenu.PopupMenuItem('关闭窗口');
        this._closeItem.connect('activate', () => this._closeWindow());
        menu.addMenuItem(this._closeItem);

        menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._refreshMenu();
        });
    }

    _isAndroidWindow(window) {
        if (!window)
            return false;
        const wmClass = window.get_wm_class();
        if (!wmClass)
            return false;
        if (this._packages.has(wmClass))
            return true;
        // Catalog regeneration is asynchronous; droidloom also sets the title
        // to the package name, which makes this a safe fallback.
        return window.get_title() === wmClass &&
            /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(wmClass);
    }

    _syncTarget() {
        const focused = global.display.focus_window;
        const android = this._isAndroidWindow(focused) ? focused : null;

        if (android !== this._target) {
            this._stopResize();
            this._untrackWindow();
            this._target = android;
            if (android) {
                this._trackWindow(android);
                this._fitIfOverflowing();
            }
        }

        if (this._indicator)
            this._indicator.visible = android !== null;
        this._refreshMenu();
    }

    _trackWindow(window) {
        const update = () => {
            this._positionHandles();
            this._refreshMenu();
        };
        for (const signal of [
            'position-changed', 'size-changed', 'notify::fullscreen', 'notify::minimized',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
        ]) {
            this._windowSignals.push(
                [window, window.connect(signal, update)]);
        }
        this._windowSignals.push([
            window,
            window.connect('unmanaged', () => {
                if (this._target === window) {
                    this._stopResize();
                    this._target = null;
                    this._navigation.sync(null);
                    if (this._indicator)
                        this._indicator.visible = false;
                }
            }),
        ]);
    }

    _untrackWindow() {
        for (const [window, id] of this._windowSignals) {
            try {
                window.disconnect(id);
            } catch (e) {
                // The window may already be gone.
            }
        }
        this._windowSignals = [];
    }

    _refreshMenu() {
        this._navigation?.sync(this._resizing ? null : this._target);
        if (!this._indicator || !this._target)
            return;
        const window = this._target;
        this._fullscreenItem.label.text =
            window.is_fullscreen() ? '退出全屏' : '全屏';
        const maximized = window.is_maximized();
        this._maximizeItem.label.text = maximized ? '还原' : '最大化';
        this._resizeItem.setOrnament(
            this._resizing ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        const canControl = !window.is_fullscreen();
        this._sizeMenu.setSensitive(canControl);
    }

    _workArea(window) {
        return window.get_work_area_for_monitor(window.get_monitor());
    }

    // GNOME keeps a normal window's size when the output rotates. A window
    // that was filling the work area would then hang over the edge, so pull it
    // back to the new work area. Small deliberately-windowed apps stay as-is.
    _fitIfOverflowing() {
        const window = this._target;
        if (!window)
            return;
        if (window.is_fullscreen() ||
            window.maximized_horizontally || window.maximized_vertically)
            return;
        const rect = window.get_frame_rect();
        const area = this._workArea(window);
        const overflow = rect.x < area.x || rect.y < area.y ||
            rect.x + rect.width > area.x + area.width ||
            rect.y + rect.height > area.y + area.height;
        if (!overflow)
            return;
        window.move_resize_frame(true, area.x, area.y, area.width, area.height);
        logMessage(`refit after monitor change ${area.width}x${area.height}`);
    }

    _leaveSpecial(window) {
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.maximized_horizontally || window.maximized_vertically)
            window.unmaximize();
    }

    _toggleFullscreen() {
        const window = this._target;
        if (!window)
            return;
        this._stopResize();
        if (window.is_fullscreen()) {
            window.unmake_fullscreen();
            logMessage('left fullscreen');
        } else {
            window.make_fullscreen();
            logMessage('entered fullscreen');
        }
        this._indicator.menu.close();
    }

    _toggleMaximize() {
        const window = this._target;
        if (!window)
            return;
        this._stopResize();
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.is_maximized())
            window.unmaximize();
        else
            window.maximize();
        this._indicator.menu.close();
        this._refreshMenu();
    }

    _fillWorkArea() {
        const window = this._target;
        if (!window)
            return;
        this._stopResize();
        this._leaveSpecial(window);
        const area = this._workArea(window);
        window.move_resize_frame(true, area.x, area.y, area.width, area.height);
        logMessage(`fill work area ${area.width}x${area.height}`);
        this._indicator.menu.close();
    }

    _setSize(width, height) {
        const window = this._target;
        if (!window)
            return;
        this._stopResize();
        this._leaveSpecial(window);
        const area = this._workArea(window);
        const w = Math.min(width, area.width);
        const h = Math.min(height, area.height);
        const x = area.x + Math.round((area.width - w) / 2);
        const y = area.y + Math.round((area.height - h) / 2);
        window.move_resize_frame(true, x, y, w, h);
        logMessage(`set size ${w}x${h}`);
        this._indicator.menu.close();
    }

    _halfScreen(side) {
        const window = this._target;
        if (!window)
            return;
        this._stopResize();
        this._leaveSpecial(window);
        const area = this._workArea(window);
        const w = Math.floor(area.width / 2);
        const x = side === 'left' ? area.x : area.x + w;
        window.move_resize_frame(true, x, area.y, w, area.height);
        logMessage(`${side} half ${w}x${area.height}`);
        this._indicator.menu.close();
    }

    _closeWindow() {
        const window = this._target;
        if (!window)
            return;
        this._stopResize();
        this._indicator.menu.close();
        window.delete(global.get_current_time());
        logMessage('close requested');
    }

    // ---- resize mode ---------------------------------------------------

    _toggleResizeMode() {
        if (this._resizing)
            this._stopResize();
        else
            this._startResize();
        this._indicator.menu.close();
        this._refreshMenu();
    }

    _startResize() {
        const window = this._target;
        if (!window || window.is_fullscreen())
            return;
        if (window.maximized_horizontally || window.maximized_vertically)
            window.unmaximize();

        this._resizing = true;
        this._navigation.sync(null);
        this._handles = new Clutter.Actor({layout_manager: new Clutter.FixedLayout(),
            width: global.stage.width, height: global.stage.height});
        Main.layoutManager.addTopChrome(this._handles);
        this._preview = new St.Widget({
            reactive: false, visible: false, style_class: 'tb-android-resize-preview',
        });
        this._handles.add_child(this._preview);

        this._handleActors = new Map();
        for (const corner of CORNERS) {
            const actor = new St.Widget({
                style_class: 'tb-android-resize-handle',
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                reactive: true,
                visible: true,
            });
            this._attachResizeDrag(actor, corner);
            this._handles.add_child(actor);
            this._handleActors.set(corner, actor);
        }

        this._moveHandle = new St.Widget({
            style_class: 'tb-android-move-handle',
            width: MOVE_HANDLE_WIDTH,
            height: HANDLE_SIZE,
            reactive: true,
            visible: true,
        });
        this._attachMoveDrag(this._moveHandle);
        this._handles.add_child(this._moveHandle);

        this._doneButton = new St.Button({
            label: '完成调整',
            style_class: 'tb-android-done',
            reactive: true,
            visible: true,
        });
        this._doneButton.connect('clicked', () => {
            this._stopResize();
            this._refreshMenu();
        });
        Main.layoutManager.addTopChrome(this._doneButton);
        const stageWidth = global.stage.width;
        const stageHeight = global.stage.height;
        this._doneButton.set_position(
            Math.round((stageWidth - DONE_WIDTH) / 2),
            stageHeight - 64);
        this._doneButton.set_size(DONE_WIDTH, 44);

        this._positionHandles();
        logMessage('resize mode on');
    }

    _stopResize() {
        this._finishDrag(false);
        if (!this._resizing) {
            return;
        }
        this._resizing = false;
        if (this._handles) {
            Main.layoutManager.removeChrome(this._handles);
            this._handles.destroy();
            this._handles = null;
        }
        this._preview = null;
        this._handleActors = null;
        this._moveHandle = null;
        if (this._doneButton) {
            Main.layoutManager.removeChrome(this._doneButton);
            this._doneButton.destroy();
            this._doneButton = null;
        }
        logMessage('resize mode off');
    }

    _positionHandles() {
        if (!this._resizing || !this._target || !this._handles)
            return;
        this._handles.set_size(global.stage.width, global.stage.height);
        const rect = this._target.get_frame_rect();
        const half = HANDLE_SIZE / 2;
        const positions = {
            nw: [rect.x - half, rect.y - half],
            ne: [rect.x + rect.width - half, rect.y - half],
            sw: [rect.x - half, rect.y + rect.height - half],
            se: [rect.x + rect.width - half, rect.y + rect.height - half],
        };
        for (const corner of CORNERS) {
            const actor = this._handleActors.get(corner);
            if (actor)
                actor.set_position(...positions[corner]);
        }
        if (this._moveHandle) {
            this._moveHandle.set_position(
                Math.round(rect.x + (rect.width - MOVE_HANDLE_WIDTH) / 2),
                rect.y - half);
        }
    }

    _attachResizeDrag(actor, corner) {
        this._attachDrag(actor, corner);
    }

    _attachMoveDrag(actor) {
        this._attachDrag(actor, 'move');
    }

    _attachDrag(actor, corner) {
        const E = Clutter.EventType;
        actor.connect('captured-event', (_, event) => {
            const type = event.type();
            const touch = event.get_event_sequence()?.get_slot() ?? null;
            const [x, y] = event.get_coords();
            if (type === E.TOUCH_BEGIN || (type === E.BUTTON_PRESS && event.get_button() === 1)) {
                if (!this._drag && this._target) {
                    const rect = this._target.get_frame_rect();
                    this._drag = {actor, corner, touch, startX: x, startY: y,
                        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                        window: this._target, grab: global.stage.grab(actor)};
                }
                return Clutter.EVENT_STOP;
            }
            const drag = this._drag;
            if (!drag || drag.actor !== actor || drag.touch !== touch)
                return Clutter.EVENT_PROPAGATE;
            if (type === E.TOUCH_CANCEL ||
                (type === E.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape)) {
                this._finishDrag(false);
                return Clutter.EVENT_STOP;
            }
            const release = type === E.TOUCH_END ||
                (type === E.BUTTON_RELEASE && event.get_button() === 1);
            if (!release && type !== E.TOUCH_UPDATE && type !== E.MOTION)
                return Clutter.EVENT_PROPAGATE;
            const dx = x - drag.startX;
            const dy = y - drag.startY;
            if (corner === 'move') {
                this._dragMove(dx, dy);
            } else {
                this._dragResize(dx, dy);
            }
            if (release)
                this._finishDrag(true);
            return Clutter.EVENT_STOP;
        });
    }

    _finishDrag(commit) {
        const drag = this._drag;
        this._drag = null;
        drag?.grab.dismiss();
        this._preview?.hide();
        const rect = drag?.preview;
        if (commit && rect && drag.window === this._target && !drag.window.is_fullscreen()) {
            drag.window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
            logMessage(`resize committed ${rect.width}x${rect.height}`);
        }
    }

    _dragResize(dx, dy) {
        const drag = this._drag;
        if (!drag || !this._target)
            return;
        let {x, y, width, height} = drag;
        const right = x + width;
        const bottom = y + height;

        if (drag.corner.includes('w')) {
            x = Math.min(x + dx, right - MIN_WIDTH);
            width = right - x;
        }
        if (drag.corner.includes('e'))
            width = Math.max(MIN_WIDTH, width + dx);
        if (drag.corner.includes('n')) {
            y = Math.min(y + dy, bottom - MIN_HEIGHT);
            height = bottom - y;
        }
        if (drag.corner.includes('s'))
            height = Math.max(MIN_HEIGHT, height + dy);

        const area = this._workArea(drag.window);
        const top = area.y;
        const left = area.x;
        const x2 = Math.min(x + width, area.x + area.width);
        const y2 = Math.min(y + height, area.y + area.height);
        x = Math.max(left, x);
        y = Math.max(top, y);
        drag.preview = {x: Math.round(x), y: Math.round(y),
            width: Math.round(x2 - x), height: Math.round(y2 - y)};
        this._preview.set_position(drag.preview.x, drag.preview.y);
        this._preview.set_size(drag.preview.width, drag.preview.height);
        this._preview.show();
    }

    _dragMove(dx, dy) {
        const drag = this._drag;
        if (!drag || !this._target)
            return;
        this._target.move_frame(
            true, Math.round(drag.x + dx), Math.round(drag.y + dy));
    }
}
