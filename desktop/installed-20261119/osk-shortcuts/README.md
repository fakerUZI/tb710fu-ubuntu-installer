# GNOME 50 tablet keyboard shortcuts

Extension UUID: `tb-osk-shortcuts@tb710fu` (version 7).

A single row above the letter grid alternates between native Chinese candidates
and grouped Tab, Select All, Cut, Copy, Paste, Clipboard, Undo, Redo and four-way cursor buttons.
The toolbar disappears when native suggestions contain candidates and returns
when they clear, including after selection. The original suggestion object is
preserved: Kimpanel and GNOME still populate it through their normal APIs.

Editing actions send standard keyboard shortcuts to the current application
using GNOME's own virtual keyboard controller. The clipboard panel records up
to 20 recent distinct text entries in memory using the Shell clipboard API.
It never writes history to disk; disabling the extension clears history.
Password/PIN focus, locked sessions and password-manager MIME hints are excluded
from recording. Buttons cannot take keyboard focus. Touch uses the same
TOUCH_BEGIN pattern as GNOME's native candidate buttons; pointer activation uses
St.Button's normal clicked signal. A short pressed highlight confirms contact.

The toolbar uses dark graphite surfaces, symbolic icons, rounded buttons and a
blue Paste action, matching GNOME's always-dark OSK in both desktop themes.
The shared slot has a stable measured height, retaining the letter grid's space
without displaying separate shortcut and candidate rows. GNOME 50.1's previous
height request is cleared before relayout to avoid accumulating height.
Monitor changes recompute layout; accessibility/touch-mode keyboard recreation
reattaches the row.

Install the directory's three extension files under the user's GNOME extension
directory and enable the UUID. A new module requires desktop login reload.
Disabling restores the native suggestion row and original layout method.

Validation: two GTK fields exercise all nine actions, checking selection, Tab
focus, a copy/paste round trip, cut, undo/redo and exact caret positions. Native
candidate generation and selection test both shared-row transitions. Tablet
screenshots are private deployment artifacts rather than publication inputs.

Final tablet verification on 2026-11-15: all nine editing actions passed again;
composing nihao replaced shortcuts with native candidates, committing 你好
restored shortcuts, and the shared slot stayed 62 logical px with a total
keyboard height of 349 logical px on the 1600×1000 desktop. The user explicitly
confirmed physical touch works and the shortcuts/candidates switch correctly.
Temporary diagnostic extension, GTK test window and runtime screenshots were
removed. Fcitx, WowType OSK integration and automatic brightness remain active.


Version 4 adds a Clipboard button, a scrollable history panel with touch-to-paste,
Clear and Return to keyboard controls. Selecting history updates the system
clipboard and sends standard Paste to the focused application. Clear removes
history and empties the system text clipboard. The letter grid is temporarily
replaced by history, while the shared candidate/shortcut row stays in place.
Pressing another editing action or hiding the OSK closes the history panel.

WowType PageSize is 8. The companion Kimpanel patch sizes/ellipsizes native
candidate previews, reserving space for CSS padding, margins and page arrows.
Selecting a truncated preview commits the original full candidate.

Final validation on 2026-11-15: prior editing actions passed; Up/Down moved between
lines in a GTK TextView; two distinct copies appeared in history; selecting an
item pasted its exact full text and restored the letter grid; Clear emptied
history; eight candidates fit the shared row and selecting 你好 restored the
toolbar. User explicitly confirmed physical touch, clipboard, arrow keys and
eight candidates all work. Temporary checks and screenshots were removed from
the device, preserving the enabled production extensions and session history.


Version 5 adds a current-state Chinese/English switch to the first toolbar
group and repurposes the native bottom language key for the same action, so
it stays reachable while candidates replace the toolbar. Both call Fcitx's
controller Toggle method and read back State asynchronously; keyboard Ctrl+Space
also remains available. Long press on the bottom language key retains access
to GNOME's original layout menu. The module restores native key contents and
menu handling when disabled.

Undo/Redo use compact symbolic buttons, and Tab/arrows use narrower touch
targets to keep the expanded toolbar within portrait width. Clipboard and
primary editing actions retain their labels.

Version 5 verification (2026-11-15): after a full tablet reboot the production
extension loaded with 13 toolbar controls and four native language-key instances.
Measured group width is 893 logical px, plus 32 px outer padding, fitting the
1000 px portrait width. The existing nine editing actions passed against GTK
fields. Fcitx State=2 agrees with the Chinese label. The user explicitly
confirmed both new language-switch entries work with Chinese and English input,
and approved the layout. An additional automated check refused to send inputs
when the user had switched to another application; no arbitrary input injection
was enabled. Temporary verification tools and window were removed afterward.

Boot cleanup in the same session: internal UFS reports SMART capability
unavailable, and smartd exited with code 17 (no devices to monitor). Disabled
smartmontools.service, retaining its package. Seven orphan Snap mount units
pointed to missing images and snapd had no registered snaps; the unit files were
archived under root-only /var/backups/tb710fu-boot-services-20261115 before removal.
After a full reboot, systemctl --failed is empty and smartmontools has no journal
entries for the new boot. This is service configuration validation, not a full
storage health diagnosis. No firmware, boot image or partition writes were made.


Version 6/7 adds a one-tap Screenshot action. It temporarily closes the OSK,
blocks auto-open during capture, saves a private PNG under the XDG Pictures
directory's 截图 subdirectory, copies image/png to the system clipboard, notifies
the user and restores the keyboard. Saved captures appear as thumbnail cards
in Clipboard, with View and Paste actions. Existing captures in that directory
are rediscovered on login (up to the shared 20-entry history limit). Clear drops
history without deleting saved PNG files. Loupe is installed and associated with
image/png so View can open full images. Clipboard entries are now either text
strings or {kind: image, path} records; image data is loaded only when pasted.

The shared row and clipboard panel follow the allocated AspectContainer width
and centering. Hidden grid allocation changes must be ignored: hiding the grid
reports a narrower width with the old horizontal position. Width is frozen while
Clipboard is open and updated only from a visible, centered native allocation.
Compact icons and spacing keep all 14 actions within the letter grid.

Validation on 2026-11-15: screenshot produced a 3200x2000 PNG with mode 0600;
image/png was present on the clipboard and the screenshot excluded the keyboard.
Sustained Clipboard display preserved centering and width across layout polls;
thumbnail selection restored image/png and View opened the full image in Loupe.
Final visible row, toolbar and native grid measured 825 logical px at x=387;
button groups use 784 px. User explicitly confirmed sustained panel alignment,
image thumbnails and View all work. Temporary diagnostic tools were removed.

During deployment the device twice hit a kernel Oops in ath12k_tb710fu_ce_poll_work
via the receive/GRO path, followed by a UFS ungate-worker fault and blocked ext4
writeback. The user rebooted; Wi-Fi was temporarily disabled to finish validation
over USB. Kernel evidence remains in ignored private artifacts. No kernel/boot
image changes were made as part of this UI fix; Wi-Fi driver stability remains
a separate unresolved device issue.

Final user decision: keep Wi-Fi disabled and address the driver in a later task.
Do not re-enable it merely to validate this keyboard UI. The screenshot/layout
work is complete and user-confirmed; the Wi-Fi kernel fault is not fixed here.

## Version 8 — composition/pinyin line

The shared candidate area now has a single-line, ellipsized composition label
above the original eight-candidate row. It follows Kimpanel's UpdatePreeditText /
ShowPreedit messages, with UpdateAux / ShowAux as the engine's fallback format.
The original suggestions object and its touch candidate callbacks are retained.
The row stays aligned with the letter grid; extra preedit height is added to the
keyboard while preserving the existing portrait/landscape height limit. Updating
preedit text alone does not relayout the keyboard; candidate table batches
queue one coalesced height update. The shortcut
bar returns after composition/candidates clear. Sensitive-purpose and lock-screen
composition is hidden. Only active composition is held in memory, with no log.

WowType 0.4.0 routes preedit to the application when Fcitx's global
`Behavior/PreeditEnabledByDefault=True`. To show it in the candidate area instead,
set that one field to `False` in `~/.config/fcitx5/config` and reload Fcitx config.
This uses the existing ARM64 engine; no compilation or package modification.
The application receives committed Chinese after candidate selection. With a
physical keyboard, the same composition is shown in the official themed
floating panel. Preserve all other Fcitx settings; a private backup was taken.

`node test-preedit.cjs` verifies preedit and auxiliary composition, clearing,
eight-candidate sharing, sensitive-input suppression and stable typing layout.


## Version 9 — candidate height after preedit

A live screenshot of version 8 revealed that preedit could arrive before the
candidate buttons. The row was measured while empty, then kept that height,
clipping the lower half of the candidate text. Version 9 schedules a coalesced
idle measurement on both composition visibility and candidate visibility
transitions. Measurement occurs after reset/refill, with both rows populated.
The pending layout source is cancelled during detach. The regression test now
explicitly adds candidates after preedit and verifies the deferred height update.

After loading version 9, the user confirmed complete candidate glyphs. A fresh
screenshot also confirmed the pinyin line and eight candidate words plus paging
control, with no vertical clipping and alignment to the letter grid. Full
screenshots contain private account data and are kept only in private artifacts.
The temporary screenshot shortcut and virtual input device were restored/removed.

## Version 10 — five candidates and fixed shared height

The current WowType page size is **5**, superseding the earlier eight-candidate
setting. Only `PageSize` in the user's WowType config was changed, with a private
backup retained; the engine's addon configuration was reloaded through Fcitx.
Paging and native touch selection remain intact.

The toolbar and the pinyin/candidate frame now each reserve the same 80 logical
pixel height. A nested frame centers the natural pinyin/candidate content inside
that allocation. Composition, candidate arrival, reset/refill and commit only
change content visibility; they no longer queue keyboard height measurements.
The native keyboard still handles monitor size and orientation changes. Existing
letter-grid width alignment, clipboard, screenshot and hardware keyboard handoff
are preserved.

`node test-preedit.cjs` covers candidates arriving after pinyin, five-candidate
sharing, reset/refill, clearing on commit, auxiliary composition and sensitive
fields. It verifies equal reserved heights and no keyboard relayout on content
transitions. Input-policy regression checks also pass. Policy version 4 adds
read-only layout dimensions to its existing status method for live validation;
it does not change touch or physical keyboard behavior.

Live validation on 2026-11-15: shortcuts v10 and policy v4 are ACTIVE. During
repeated typing/selection transitions, the shared row, toolbar and candidate
frame all stayed at 80 logical px. While visible, the keyboard stayed at 333 px
and its letter grid at 727 x 253 px, both before and during composition. The
populated candidate row reported six actors (five candidates and one page
control). Hiding/reopening the keyboard was observed separately; its hidden
grid allocation is not used as a composition-transition measurement.

The user subsequently confirmed five complete candidates, working selection and
smooth transitions back to the toolbar.

## Version 11 — terminal Shift modifier

In terminal-purpose layouts, only the lower-left size-switch key is replaced
with a labelled `Shift` modifier. The upper Caps key and the right size-switch
key remain native. Other input-purpose layouts are unchanged. The native key
handler registers Shift in GNOME's modifier set and shows its latched state in
blue. Arrows/Tab and toolbar key events are bracketed with Shift when selected;
text commits already forward that set and receive no duplicate modifier events.
Arrows retain Shift for repeated selection; native text commit clears modifiers
after use. Tapping Shift again, hiding the keyboard or rebuilding the layout
clears it. A virtual Shift is held only around the actual key event sequence.

`node test-shift.cjs` checks terminal-only replacement, preserved Caps/right key,
repeated Shift+arrows, Shift+Tab, native text forwarding, error cleanup, state
clearing on hide/layout changes and restoration on disable. The fixed-row and
preedit regression test remains passing. Device interaction validation follows
deployment; screenshots are private.

The user confirmed v11's Shift function works, then requested a larger label and
long-press direction keys. Version 12 uses an explicit 24 px Shift label and adds
the same hold behavior to native keyboard arrows and toolbar arrows: one action
on press, repeat after 400 ms, then every 60 ms. Native release's original single
action is suppressed to prevent an extra movement. Release, cancellation,
pointer/touch moving outside, unmapping, hiding, layout destruction and focus
changes stop repetition. Only one arrow repeats at a time. Each repeated action
still passes through the Shift-aware controller.

`node test-arrow-repeat.cjs` verifies tap/hold timing, no duplicate release,
touch slot 0 and unrelated fingers, mouse release, cancellation, focus/hide guards
and restoration on disable. Existing Shift and preedit regression tests pass.

Live v12 validation: extension ACTIVE with no related JS errors. A dedicated
editable terminal-purpose test field recorded repeated arrow events roughly
60 ms apart, with only event counts/times inspected and no typed text logged.
The user confirmed the larger Shift label, long press in both arrow locations,
stopping on release and Shift selection all work. The temporary test window and
device-side check/screenshot scripts were removed; the screenshot keybinding
was restored to its original setting. No firmware or partition writes occurred.

## Version 13 — one extended layout for ordinary text fields and terminals

At the user's request, NORMAL and ALPHA text fields now use the same extended
keyboard model as terminal fields, including Ctrl, Alt, Tab, the labelled Shift
modifier and long-press arrows. This maps only the visual `_updateLayout`
argument; the real application's input purpose remains unchanged for Fcitx,
password handling, suggestions and input hints. Numeric, phone, password, PIN,
email and URL purposes retain their existing dedicated models. The original
layout method is restored on disable. Candidate count and fixed shared-row
height remain unchanged.

Shift regression tests now verify normal/alpha visual mapping, preserved app
purpose and unchanged dedicated-purpose layout arguments. Arrow/preedit tests
also pass. This revision is deployed alongside WowType OSK v2, which fixes
Backspace when composition is displayed in the shared panel.

After loading v13 with WowType OSK v2, the user confirmed that an ordinary
normal-purpose text field shows the same extended layout and that pinyin and
committed Chinese can both be deleted. The dedicated verification window and
device-side script were removed after validation.

## Version 14 — URL and email fields use the extended layout

The user reported that Chrome still showed a different keyboard. The earlier
NORMAL/ALPHA mapping excluded URL and EMAIL purposes, which can be used by
browser address bars and web fields. These two purposes now also request the
extended visual model, retaining the actual application purpose and all
existing composition, fixed-row, modifier and arrow-repeat behavior. Dedicated
numeric/phone/password/PIN models stay unchanged. Regression coverage now
includes both URL and EMAIL alongside normal and terminal fields.

A temporary timing-only diagnostic extension was prepared to distinguish input
engine latency, keyboard rebuild/layout work and main-loop stalls. It records
durations/counts only, with no input text, field contents or window titles.

Live v14 validation: the user confirmed matching layouts in Chrome's ordinary,
URL and email fields and reported smooth input. A short timing sample measured
input-engine calls at 58.4 ms mean / 94.5 ms maximum, candidate fitting at 0.1 ms
mean / 1.2 ms maximum and UI timer delay at 2.8 ms mean, with an occasional
66.5 ms maximum. The largest measured input-path component was the engine
round trip, not candidate fitting. This short sample does not establish a
single cause for all earlier intermittent stalls. Available memory was about
3.6 GiB, and the short vmstat sample showed no ongoing swap traffic. The timing
probe was disabled and removed after measurement; private duration-only results
were retained. No input text was collected. No Chrome flags were changed.

## Version 15 — larger ten-action toolbar without duplicate arrows

At the user's request, the top toolbar no longer includes left/up/down/right;
the extended keyboard's lower arrow keys retain long-press and Shift behavior.
The remaining ten actions use larger 16 px labels, 18 px icons and larger touch
targets. Expandable groups and buttons fill the toolbar's grid-aligned width.
At normal wide allocation, all action names are shown; smaller widths reduce
selected labels responsively to avoid overflow. Responsive style changes
are cached rather than reapplied on every width poll. The shared toolbar and
pinyin/candidate frame retain their fixed 80 px height.

The existing read-only layout status adds toolbar/grid width and position
metrics and action count for verification. `test-toolbar.cjs` verifies the ten
actions, removal of duplicate arrows and responsive labels. Preedit/fixed-height,
extended-purpose, Shift, arrow-repeat and composition-delete regressions pass.

## Version 16 — remove duplicate Tab and repair numeric page switching

The user requested removing the top Tab action as the extended keyboard already
provides one. The wide toolbar now contains nine actions: language, select all,
cut, copy, paste, clipboard, undo, redo and screenshot. Lower Tab/arrow keys and
their modifier/repeat behavior remain unchanged.

A private live screenshot then showed a blank numeric grid and toolbar overflow
in WowType's numeric page-size field. The journal identified a late native
capitalization/surrounding-text reply selecting `shift` after switching to a
one-level numeric model. Native `_setActiveLevel()` dereferenced the missing
page and aborted drawing. Layout rebuilding now disconnects pending native
surrounding-text callbacks, and level selection falls back to an existing
default page when the requested page does not exist. Pending callbacks are
also disconnected on extension detach; original methods are restored normally.

Keypads below 400 logical px show four icon shortcuts (select all, copy, paste,
clipboard), with empty groups hidden. This keeps the toolbar within the native
numeric grid width instead of forcing nine text actions into a narrow row.
Returning to a text field restores all nine actions and larger labels. The
shared 80 px height stays unchanged. The keyboard's actual input purpose is
included in read-only geometry diagnostics for numeric validation.

Regression tests reproduce a missing shift page, check callback cancellation,
preserve normal uppercase and special-purpose models, and verify compact
keypad actions plus full toolbar restoration. Other keyboard regressions pass.

Live v16 validation: the extension loaded ACTIVE. The user confirmed numeric
keyboards, input/deletion, compact keypad shortcuts and the larger nine-action
toolbar all work. During ordinary text/URL/email switching, normal visible
allocations measured 823 logical px for both toolbar and key grid, with matching
x=388 and an 80 px shared-row height. No new missing-page JS error appeared in
the final log sample. The temporary page included numeric and number inputs;
its server and device-side test/screenshot scripts were removed after testing.
The timing probe remains removed, and the screenshot binding was restored.

## Version 17 — candidates update in fixed slots before paint

The user reported horizontal motion of the five candidates while typing. The
old Kimpanel adapter cleared/recreated native buttons and calculated their
widths; the shared-row poll then calculated widths again from a different
allocation. Candidate/page-count changes also changed the centering and sizes.

`CandidateRow` now owns one persistent set of native touch buttons: five equal
word slots and two fixed paging slots. Missing words/pages reserve their space
with zero opacity and disabled interaction. Label updates reuse the actors and
never resize them. Width changes only occur for actual keyboard-width changes,
with no allocation transitions. Table/reset signals received in one frame are
coalesced through Meta BEFORE_REDRAW so only the final table is displayed.

The Kimpanel adapter delegates to the shared helper, removing its competing
width calculation and per-update destruction. It retains native candidates
when the optional helper is absent, guards stale selection callbacks and keeps
the official floating panel for physical keyboard use. Candidate tap callbacks
remain GNOME's native ones. Policy v5 reports visible candidate count rather
than counting reserved invisible paging/word slots.

Tests cover actor identity, fixed positions across changing word/page counts,
clear/reopen, invisible-slot safety, idempotent sizing and before-paint batching.
Adapter tests cover delegate/fallback, stale callbacks, sensitive fields and
floating-panel preservation. Applying the Kimpanel patch twice produced the
same result. Existing row-height, toolbar, layout, Shift, arrow, hardware policy
and composition-delete regression checks pass.

Live v17 validation: shortcuts, Kimpanel and policy loaded ACTIVE. While composing,
the live row reported five slots at 129 logical px each, 44 px paging slots and
an 823 x 80 px shared allocation. Clearing composition returned to the toolbar
with zero visible candidates; hidden-actor width measurements are not used as
visible-row geometry. The user confirmed repeated typing/deletion/selection no
longer moves the candidates and touch selection works. The final log sample
contained no JS errors; Fcitx remained active. The temporary verification window
and script were removed.

## Version 18 — close the landscape bottom pixel gap

A private full-screen capture showed one physical row of browser content below
the keyboard. The monitor is 1000 logical px high; the native one-third keyboard
height is fractional, while its actor allocation rounds to pixels. The show
animation used that fractional height and left the last physical row uncovered.
The relayout wrapper now rounds the final keyboard height upward before the
native show animation uses it. The shared candidate/toolbar height and all
input controls remain unchanged. Version 18 loaded ACTIVE and read-only status
reported the integral 334 px keyboard height. A fresh post-fix screenshot was
not obtained before the user's request to close out; the screenshot helper
produced no new saved image, and the stale pre-fix image was not counted as
verification. The temporary helper was removed and its keybinding restored.
