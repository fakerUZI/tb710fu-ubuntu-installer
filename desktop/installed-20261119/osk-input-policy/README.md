# On-screen keyboard input policy

GNOME 50 on the TB710FU detects UU Remote's uinput keyboard as a keyboard even while it is not in use. Its stock touch-mode policy therefore fails to auto-open the keyboard on touch. This extension keeps GNOME's accessibility keyboard enabled and uses GNOME Shell's last-device-changed signal instead. Touch allows auto-open; a pointer or physical/remote keyboard closes and suppresses auto-open until the next touch. The panel toggle is an explicit override. Lock screen is allowed to open the keyboard regardless of the current mode.

This is based on the **last used input device**, not mere attachment. A touch can therefore bring up the keyboard while a physical keyboard remains connected. It uses private GNOME Shell APIs and is tied to Shell 50; retest after Shell upgrades. The virtual-keyboard name exclusion is heuristic.

On 2026-11-13, the active device showed the keyboard after a synthetic direct touch to a GTK Wayland test entry. A separate synthetic keyboard typed into the field and the on-screen keyboard disappeared. A subsequent touch opened it and an on-screen key typed without closing it. A separate simulated pointer also hid it. These tests do not replace tests with an actual keyboard, an actual UU client, Chromium, and a locked session. The native UU service was running after the session restart. `node test-policy.cjs` tests the policy branching with mocks, not GNOME integration.

Disable with `gnome-extensions disable tb-osk-input-policy@tb710fu` if it interferes with input.

A 250 ms focus check also opens the keyboard after a touch when a Wayland client exposes a focused text input but does not request the input panel. It only triggers on a new focus or a changed touch device, so it should not continually reopen the keyboard after the user hides it. Entering a password or PIN purpose clears existing candidates and prevents new suggestions from being added until the purpose changes.

On 2026-11-13, a Chromium 154 isolated-profile local test page was exercised with simulated touch. Both a normal input and a password input opened the keyboard; switching from simulated hardware keyboard input to the password input cleared the previous candidates. A second test without `--enable-wayland-ime` also opened the keyboard in a normal input. The browser was launched with the system's `/usr/local/bin/chromium` wrapper and an isolated temporary profile. Actual websites, the address bar, physical input devices, the UU client and the lock screen still need end-to-end testing. A GNOME Shell or Chromium upgrade may change the relevant private APIs.

## QQ IBus focus bridge (version 2, 2026-11-15)

The user confirmed that manually opening the OSK in QQ permits Chinese entry
and touch candidate selection, but touching the input field does not open it.
QQ's visible window uses XWayland. Fcitx `Controller1.DebugInfo` reports a
focused `gtk3-im:qq` IBus context; the previous policy only checked Mutter's
native Wayland `Main.inputMethod.currentFocus`. Changing QQ launch flags did
not resolve this, so the experimental user desktop override was removed.

Version 2 tracks actual completed app touches with
`global.stage.get_event_actor(event)` instead of relying solely on changes of
input device. For QQ only, when no native Wayland focus exists, a recent touch
can query Fcitx context metadata asynchronously. It opens the OSK only if a QQ
context has actual `focus:1`, the touched window remains focused, and the request
is still current. It does not read text, clipboard contents or account data.
`State()` alone is insufficient because it can refer to a most-recent context.

Touches on the OSK/candidate controls are excluded. Manual close cancels pending
requests, late replies after changing window or disabling the policy are
ignored, and physical keyboard suppression and native Wayland focus handling
are retained. A read-only `org.tb710fu.OskPolicy.Status` object at
`/org/tb710fu/OskPolicy` on `org.gnome.Shell` exposes only boolean/counter state
for validation; it provides no Shell evaluation or input injection.

`node test-policy.cjs` covers actual QQ IBus focus without native focus,
non-editable app areas, repeated touchscreen taps, candidate exclusion,
manual-close cancellation, stale-window replies, physical keyboards, native
focus changes and disable-time replies. Syntax and installed Clutter APIs were
checked before deployment. A new login is required to load version 2; live
validation is still pending at preparation time.

### Live validation complete

After an authorized display-manager restart with GDM automatic login, policy
version 2 loaded ACTIVE with an empty extension error list. Its diagnostic
reported actual completed app touches and a focused QQ Fcitx context. The user
then confirmed all three live checks: tapping QQ search opens the keyboard,
typing `nihao` produces touch-selectable Chinese candidates, and hiding the
keyboard then tapping the same entry opens it again. No message was sent by the
assistant. The packaged QQ desktop launcher is used; experimental native-IME
flags were not retained.

Scope: architecture (ARM64) does not determine OSK support. Native system text
input focus remains supported generally. The new context-metadata fallback is
intentionally limited to QQ; it does not guarantee auto-opening for unrelated
X11, Qt, Electron or custom-control applications. Those need validation and,
if necessary, a matching focus integration rather than opening on every app
surface touch.

## Version 3 — connected external keyboard mode

Use Clutter seat device-added/removed notifications plus a one-second fallback
rescan. Inspect the input node's sysfs bus and typing-key capabilities. USB (3)
and Bluetooth (5) devices with Enter/A/Z/Space count as typing keyboards,
including Bluetooth UHID under `devices/virtual/misc/uhid`. Plain uinput devices
under `devices/virtual/input` are excluded so remote virtual keyboards do not
permanently suppress the OSK. Consumer controls, mouse buttons and the internal
pen do not qualify. Capability tests read the last 64-bit sysfs word correctly;
joining hex words without padding can incorrectly classify the pen as a keyboard.

While a matching device is connected, touch auto-open and explicit OSK open
requests are suppressed and an existing OSK closes. This leaves Kimpanel's
original floating candidates and the WowType official theme/status active.
Unplugging restores touch mode and entry taps can reopen the OSK. No global
accessibility setting is toggled, so the keyboard actor and clipboard history
remain intact. Diagnostics report only the count, preedit length/visibility and
candidate count, never device identifiers or composition text.

Additional regression tests cover USB/Bluetooth connection without a keypress,
manual/touch suppression, unplug restoration, UHID versus uinput classification,
consumer controls and multiword capability maps. Hardware validation follows
a new login with the user-provided keyboard.


### External keyboard live verification

The user connected a Bluetooth keyboard. Policy diagnostics reported one
physical typing keyboard and an invisible OSK even after touchscreen input;
sysfs independently reported Bluetooth=1, USB=0. The user confirmed that the
virtual keyboard stayed hidden, official WowType floating candidates/status
were normal, and physical-keyboard Chinese selection worked. After disconnect,
the user confirmed that tapping QQ again restored the virtual keyboard, pinyin
line and candidates. The user explicitly deferred real USB testing due to the
single tablet port and will provide results later. USB classification is
implemented and regression-tested, but has not been claimed hardware-validated.
