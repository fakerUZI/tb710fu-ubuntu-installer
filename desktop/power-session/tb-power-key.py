#!/usr/bin/python3
"""Power short press locks before blanking, and wakes the locked screen.

用户级修正版（原文件 /usr/local/bin/tb-gnome-power-button.py 只读）。

修正点：判断"屏幕是否已经关掉"不再看 Mutter.DisplayConfig.PowerSaveMode。
GNOME 的熄屏由 gsd-power 自己关掉 DRM 输出（blank 回调）完成，从不更新那个
属性，所以它长期停在 0。原逻辑于是每次熄屏后的第一次按键都执行"关屏"分支
（屏幕本来就是黑的，看不出变化），第二次才执行"开屏" —— 表现为必须按两次。
这里改用与 tb-panel-guard 相同的真实判据：DSI 输出的 dpms 状态 + 背光 bl_power。
"""
import glob
import os
import select
import struct
import subprocess
import sys
import time
from pathlib import Path

EVENT = struct.Struct('@llHHi')
POWER = 116
LONG_SECONDS = 1.0
BACKLIGHT = Path('/sys/class/backlight/sy7758-backlight')
if not BACKLIGHT.is_dir():
    _found = sorted(glob.glob('/sys/class/backlight/*'))
    if _found:
        BACKLIGHT = Path(_found[0])


def call(*args):
    try:
        result = subprocess.run(('busctl', '--user', 'call', *args), timeout=5,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                check=False)
        if result.returncode:
            print('desktop action failed:', result.stderr.decode(errors='replace').strip(), flush=True)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print('desktop action error:', exc, flush=True)


def lock():
    """Confirm the graphical session lock without waiting for a lit curtain.

    GNOME's ScreenSaver.Lock reply waits for lock-screen-shown; on an already
    locked/off display that signal may never recur. logind's Lock signal calls
    the same GNOME lock path, then we verify its actual state on both buses.
    """
    display = subprocess.run(
        ('loginctl', 'show-user', str(os.getuid()), '-p', 'Display', '--value'),
        timeout=2, check=True, capture_output=True, text=True).stdout.strip()
    if not display:
        raise RuntimeError('No graphical session found; lock was not confirmed')
    def confirmed():
        active = subprocess.run(
            ('busctl', '--user', 'call', 'org.gnome.ScreenSaver',
             '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'GetActive'),
            timeout=2, check=True, capture_output=True, text=True).stdout.strip()
        locked = subprocess.run(
            ('loginctl', 'show-session', display, '-p', 'LockedHint', '--value'),
            timeout=2, check=True, capture_output=True, text=True).stdout.strip()
        return active == 'b true' and locked == 'yes'
    if confirmed():
        return
    subprocess.run(('loginctl', 'lock-session', display), timeout=3, check=True,
                   capture_output=True, text=True)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if confirmed():
            return
        time.sleep(.05)
    raise RuntimeError('GNOME did not confirm a locked session')


def backlight_power(action):
    subprocess.run(('/usr/local/bin/tb-backlight-power', action),
                   timeout=3, check=True, stdout=subprocess.DEVNULL)


def set_power_save(mode):
    result = subprocess.run(
        ('busctl', '--user', 'set-property', 'org.gnome.Mutter.DisplayConfig',
         '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig',
         'PowerSaveMode', 'i', str(mode)),
        timeout=3, capture_output=True, text=True, check=False)
    if result.returncode:
        raise subprocess.SubprocessError(result.stderr.strip())


def panel_is_off():
    """真实屏幕状态：DSI 输出被合成器关闭，或背光已被切断。"""
    for path in sorted(glob.glob('/sys/class/drm/card*-DSI-1/dpms')):
        try:
            if Path(path).read_text().strip().lower() != 'on':
                return True
        except OSError:
            continue
    try:
        return int((BACKLIGHT / 'bl_power').read_text().strip()) != 0
    except (OSError, ValueError):
        return False


def short_press():
    """Lock before switching off; powering on never requests an unlock."""
    try:
        was_off = panel_is_off()
        lock()
        if was_off:
            set_power_save(0)
            backlight_power('on')
        else:
            set_power_save(3)
            backlight_power('off')
        print('tb-power-key: locked screen ' + ('on' if was_off else 'off'), flush=True)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print('power button action failed:', exc, flush=True)


def shutdown_dialog():
    backlight_power('on')
    # The local menu requires an explicit selection; it has no shutdown timer.
    call('org.tb.PowerMenu', '/org/tb/PowerMenu', 'org.tb.PowerMenu', 'Open')


def find_power_key():
    override = os.environ.get('TB_POWER_KEY_DEVICE')
    keys = [override] if override else sorted(glob.glob('/dev/input/by-path/*:pwrkey-event'))
    if not keys:
        raise RuntimeError('power key not found')
    return keys[0]


def main():
    if '--status' in sys.argv:
        print('panel_off=%s dpms=%s bl_power=%s brightness=%s' % (
            panel_is_off(),
            [Path(p).read_text().strip() for p in sorted(glob.glob('/sys/class/drm/card*-DSI-1/dpms'))],
            (BACKLIGHT / 'bl_power').read_text().strip() if (BACKLIGHT / 'bl_power').exists() else '?',
            (BACKLIGHT / 'brightness').read_text().strip() if (BACKLIGHT / 'brightness').exists() else '?'))
        return

    key = find_power_key()
    fds = {os.open(key, os.O_RDONLY | os.O_NONBLOCK): 'power'}
    lid_override = os.environ.get('TB_LID_DEVICE')
    if lid_override:
        fds[os.open(lid_override, os.O_RDONLY | os.O_NONBLOCK)] = 'lid'
    for name in ([] if lid_override or os.environ.get('TB_DISABLE_LID') else glob.glob('/sys/class/input/event*/device/name')):
        try:
            path = Path(name)
            if path.read_text().strip() == 'gpio-keys' and int((path.parent / 'capabilities/sw').read_text().strip(), 16) & 1:
                event = path.parts[-3]
                fds[os.open('/dev/input/' + event, os.O_RDONLY | os.O_NONBLOCK)] = 'lid'
                break
        except (OSError, ValueError):
            continue
    print('tb-power-key: ready (confirmed lock, ver 3)', flush=True)
    pressed = None
    long_done = False
    while True:
        timeout = max(0, LONG_SECONDS - (time.monotonic() - pressed)) if pressed is not None and not long_done else None
        ready, _, _ = select.select(list(fds), [], [], timeout)
        if not ready and pressed is not None and not long_done:
            long_done = True
            shutdown_dialog()
            continue
        for fd in ready:
            try:
                data = os.read(fd, EVENT.size * 16)
            except BlockingIOError:
                continue
            if not data:
                raise OSError('input disconnected')
            for offset in range(0, len(data) - EVENT.size + 1, EVENT.size):
                _, _, event_type, code, value = EVENT.unpack_from(data, offset)
                if fds[fd] == 'power' and event_type == 1 and code == POWER:
                    if value == 1 and pressed is None:
                        pressed, long_done = time.monotonic(), False
                    elif value == 0 and pressed is not None:
                        if not long_done:
                            short_press()
                        pressed, long_done = None, False
                elif fds[fd] == 'lid' and (event_type, code, value) == (5, 0, 1):
                    lock()


if __name__ == '__main__':
    main()
