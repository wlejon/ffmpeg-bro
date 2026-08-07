# PLAN: a UI that leads, with no prose in it

Written 2026-08-07, from a full UX audit (code read of every `ui/` surface plus
live screenshots of every stage — `out/ux-00…09-*.png`). This plan is executed
by subagents, one thread at a time, per the working rules at the bottom.

## The rule

**No instructional prose in the application, and no tooltips that explain.**
The UI itself must lead into what it does. Explaining in tooltips is a crutch
used instead of thinking through actual UI elements — so the fix for a control
nobody understands is a better control, not a sentence about the control.
Tooltips may return as a *later polish pass*, after the UI is good without
them. That pass is not part of this plan.

What counts as what — every prose site gets exactly one of these dispositions,
recorded in the inventory (Thread 0):

| Kind | Test | Disposition |
|---|---|---|
| **Instruction** | Tells you how to operate the app ("Drag a node's title bar…", "Type to search…", "drop a file", gesture hints, recipes) | **Delete.** Replace with an affordance: a visible control, a cursor change, a context menu, a handle, an empty-state action button. |
| **Explanation** | Teaches a concept — how ffmpeg works, why a mechanism exists, what a term means ("A soft track is styled by whatever player opens it…", the two-pass paragraph, every `why()` fold) | **Delete from the UI.** The manual (`docs/manual/`) is its home; move anything not already there in the same commit. |
| **Statement** | A changing fact about *this* render/input/action: a refusal reason, a warning, a measured result, a count | **Keep, as data**: one line maximum, structured (chip/badge/row, not paragraph), anchored to the control it is about. Never folded, never a tooltip. |
| **Build-reported string** | Text libav supplies: option help, encoder long names, device descriptions | **Keep as secondary text.** It is data from the build, not authored prose. |
| **Shortcut-name titles** | `title="Mute (M)"` — a name and a key, no sentence | Keep (it is a label, not an explanation). Everything longer goes. |

Consequences the implementer must accept up front:

- **The `explain.js` fold system is retired.** Its rule (explanations fold,
  statements don't) was right, but under the new rule explanations leave the
  application entirely. `why()`/`explained()` content moves to the manual;
  `ex-note`/`ex-copy-note` *statements* stay, one line, anchored.
- **This means building a lot more UI.** Where a paragraph was doing a
  control's job (dshow source syntax, the range strip's invisible drag zones,
  `Repeat: -1`), the replacement is a real control, not a shorter sentence.
- CLAUDE.md gains this rule (Thread 0) so future work inherits it.

## Current prose census (what is being removed)

From the audit, the load to clear:

- `ui/sources.js`: 51 `title:` sites (several 600+ chars), on-screen paragraphs
  in `waitingRows`, dead documented features (local copy, `readRows` stub).
- `ui/capture.js`: paragraph tooltips on device rows / `Stop after` / meters /
  quality; 4 permanent paragraphs (tee, Also-write ×2, opening note); record
  refusal essays that are unreachable code.
- `ui/graph/panel.js` + `view.js`: four-paragraph empty-state essay, palette
  hint sentences, `movie=` path-escaping essay, drift paragraph, wire-panel
  sentences; `index.html` graph toolbar with the Cues-button 3-line tooltip.
- `ui/export/*`: 14 permanent `note()` paragraphs on Encode, 13 `why()` fold
  sections on Write, sticky `chosenNote`, warning list of undifferentiated
  sentences.
- `ui/index.html`: `#dropzone` prose, `tl-hint` gesture line, long titles on
  `#btn-cues`, `#src-path`, stream-template buttons.
- `ui/inspector.js`, `ui/softcues.js`, `ui/measure.js`, `ui/report.js`:
  speed/pitch paragraph, cue-layer caption, measure refusal sentences.

## Thread 0 — foundation: the rule, the feedback channel, the inventory

Everything else depends on this; do it first.

1. **Global toast layer.** `#osd` lives inside `#st-compose`'s viewer
   (`ui/index.html:171`) so `flash()` (`ui/app.js:2265`) is invisible on five
   of six stages — "Recording failed", "Recorded take1.mkv", measure results
   all go to a hidden element. Move the flash target to a body-level layer
   visible on every stage (positioning: over whatever stage is up, not inside
   any). Keep the single-writer `flash()` API.
2. **Prose inventory.** Produce `PROSE-INVENTORY.md` (repo root, deleted when
   the plan completes): every `title:`/`title="` over one clause, every
   `note(`, `gp-hint`, `tiny-note`, `dim` prose div, with file:line, its text's
   first words, its kind per the table above, and its disposition (the
   replacement UI, named). Threads 2–8 consume their sections and tick them
   off; the final sweep (Thread 9) asserts the file is empty of undispositioned
   rows. Build it by grep, not memory: `grep -n "title:" ui/*.js ui/*/*.js`,
   `grep -n "title=\"" ui/index.html`, `grep -n "note(\|gp-hint\|tiny-note"`.
3. **CLAUDE.md**: add the rule as a convention ("No instructional prose in the
   UI…" — the table above, condensed), so every later agent inherits it.
4. **Line-drift caution**: all file:line refs in this plan were taken 2026-08-07;
   re-grep before editing, do not trust the numbers.

## Thread 1 — typed option controls (shared mechanism, build once)

The raw AVOption table is the single biggest "ffmpeg-coded" surface and it is
rendered in **two implementations, five places**: `ui/opttable.js`
(Sources demuxer/decoder/protocol columns, Encode advanced, Write muxer
options, Capture device options) and `ui/graph/panel.js` `optionRow`
(filter options). Today a row is `name / C-type / [min…max] / help / bare text
box`, with ranges like `[-1…9223372036854776000]` printed verbatim.

Build one control synthesizer from AVOption metadata and use it from both:

- enum constants → `<select>` (exists; keep `default (…)` entry).
- boolean → toggle.
- int/float with a *sane* range (both ends finite, span printable) → slider +
  number field; insane ranges (INT/INT64 limits — extend `rangeOf`'s
  suppression) → number field alone, no range text.
- `image_size` → W × H pair; `video_rate`/`duration` → structured field
  matching the app's existing clock/rate fields; `color` → swatch + field;
  `rational` → number pair.
- The option's **name stays ffmpeg's** (it is the real key — the app's honesty
  convention) and libav's help string stays as the secondary line (data, not
  prose). What goes: the C type name and the machine-limit ranges as text.
- Unknown-key-is-an-error behaviour is unchanged; add **inline validation** so
  a value outside a finite range is marked at the field, before the render.
- Keep "empty until searched" for 200-option tables, but the empty state
  becomes the set-options list + a search field with a count placeholder
  (`search 217 options…`) — no sentence.

Everything here still comes from the registry — **no hardcoded capability
lists** (curated *ordering* is allowed; capability claims are not).

## Thread 2 — Graph stage

The mechanics (pan/zoom/marquee/wiring/fold/minimap in `ui/graph/view.js`) are
sound; do not rebuild them. The work is the surfaces around them:

1. **Toolbar.** The nine controls crowded into the right end of the bottom
   status bar (`index.html` `.gr-bar`) become a proper toolbar at the top of
   the stage, grouped and labeled: `[+ Add node] [Collapse ▾]` |
   `[Previews ⏻] [At playhead]` | `[− 100% +] [Fit] [Re-layout]`. The bottom
   bar keeps the status readout, search and legend only. `At playhead` and
   `Previews` currently have no tooltip and no visible state beyond a class —
   give Previews a pressed state and At-playhead a readout of the range it set.
2. **Empty-selection panel.** Delete the four-paragraph essay
   (`panel.js` `empty()`, incl. the watermark recipe — recipe goes to
   `docs/manual/graph.md`). Replace with: the graph summary the stage already
   computes (`graphSummary()`: nodes, chains, inputs, yours, locks — as a stat
   block), primary actions (`+ Add node`, `Collapse`), and the
   `Clear my filters and locks` button when the overlay is non-empty.
3. **Gesture discoverability by affordance, not text.**
   - Cursors: grab/grabbing on background pan, crosshair while wiring,
     move on card headers, ew-resize on the card corner. If bro's DOM subset
     lacks CSS cursors, **fix it in bro** (the standing convention), not here.
   - Socket hover: enlarge/highlight the socket and show its stream kind badge.
   - Context menus (plain DOM, no engine gap): right-click background → Add
     node here / Fit / Re-layout / Collapse; node → Insert after · Preview ▶ ·
     Measure to here · Delete · Unlock; wire → Insert filter · Delete ·
     Give back. Same actions as today, reachable without knowing gestures.
4. **Palette.** Replace flat alphabetical lists. Sections, in order: **Your
   files** (document inputs — already first), **An output**, **Common**
   (existing `COMMON`/`MULTI` curated ordering — precedent allows curation of
   *prominence*), then **by pad shape** (Video, Audio, Sources, Multi-input,
   counts on each), with search across everything. Row = name (mono) + pad
   shape badge + libav description (data — stays). Delete the hint sentences
   ("A few to start with…", "It lands unwired…"); the section structure and a
   search-count placeholder carry that information.
5. **Derived chains fold by default** per clip at any graph size (today
   folding auto-engages only past `FOLD_OVER` nodes). A fold card carries the
   clip's name, its filter count, and the open control; a two-clip edit shows
   ~6 cards, not 18. User's explicit unfold still wins (`foldChoice` rule
   unchanged).
6. **Prose deletions with UI replacements**, per inventory:
   - `movie`/`amovie` essay → path field with inline validation (colon/comma
     escaping performed *for* the user on commit, shown escaped in mono) and
     an action chip `Use as an input instead` that does the conversion.
   - Drift paragraph → one-line problem chip (`size 320x240 ≠ render 640x360`)
     + the existing `Match the render` button.
   - Wire panel sentences → the `yours`/`derived` badge it already has, the
     two action buttons, and nothing else.
   - Named-output paragraphs → name field with inline validation (charset,
     reserved `vout`/`aout` as field errors) and a `Map it on Write →` button.
   - Insert-`+` stays hover-revealed (n8n precedent) but also appears on the
     selected wire, so selection is a second route to it.

## Thread 3 — Compose / timeline

1. **Cursors over hidden edits.** Trim zones (6px edges) get ew-resize, clip
   body gets grab, roll gets its own cursor at a butt joint; wiring this up
   may need the same bro cursor support as Thread 2.
2. **Context menu on clips**: Split at playhead · Delete · Speed ▸ · Track ▸ —
   the keyboard-only edits (`Ctrl+A`, `Delete`, `S`) become reachable by mouse.
3. **Delete the `tl-hint` gesture line** and the `#btn-cues` 3-line tooltip
   (label + pressed state + the cue layer itself is the affordance; concept
   text → manual). `#dropzone` prose shrinks to "Drop media here" + icon.
4. **Crop gets a button** beside Split/Grid/Output (today `C`-key-only,
   announced by a flash).
5. **Generator `<select>` labelled "add…" becomes an `Add generator…` button**
   opening the same sectioned source browser as the graph palette (shared
   component from Thread 2.4).
6. **Inspector speed paragraph** → segmented speed control (exists) + one
   statement chip (`pitch follows speed`) + an action `Keep pitch` that
   inserts the `atempo` node the paragraph currently tells the user to go
   build by hand. Copied-stream restriction becomes the control's disabled
   state with a one-line reason.
7. **Timeline zoom label** (`18× 0:00–0:01`) is fine as data; verify a fresh
   document opens fit-to-edit (the tour screenshot showed a 1s window on an
   18s edit after adds from Sources; if reproducible interactively, fix).

## Thread 4 — Sources

1. **A file browser.** The app has no way to browse for media — typing a path
   or OS-drop are the only routes. Add `Browse…` beside `Add`. The engine has
   `showOpenFolderDialog` (used for the copy folder); if no *file* dialog
   exists in bro, that is a bro fix (convention), not a workaround.
2. **A drop target on the stage itself.** Empty state says "drop a file" but
   the drop zone lives on Compose, and a drop while on Sources silently makes
   a *clip*. Dropping on Sources adds an **input** (not a clip), with a
   visible drop ring; the empty-state text shrinks to match the now-true
   affordance.
3. **Join mode gets a face.** Keep the multi-select, add a pinned mode banner
   (`Join: pick 2+ inputs  [Join] [Cancel]`), flip the `Join…` button to
   `Cancel` while in the mode, and name the act one thing (Join) everywhere —
   `Read end to end` becomes the row's *result* text, not a third name.
4. **The window as a control.** `Start at`/`Stop at`/`Length` become a
   dual-handle range bar over the input's probed duration with the numeric
   fields beside it; `Repeat` becomes a stepper with an `∞` toggle (deleting
   the `-1 means forever` tooltip); `Delay by` keeps its field.
5. **`.src-set` flag text → chips.** `-f matroska -probesize 5000000` becomes
   one chip per setting; exact values preserved (the command bar remains the
   canonical printed form).
6. **Feedback for re-open.** `Re-probe`/option changes currently show nothing
   on success: add a probing spinner on the card, and highlight stream-readout
   lines that changed on the answer.
7. **Delete dead surfaces** (and their manual text in the same commit): the
   local-copy UI (`localCopyButtons`/`localCopySection` — gated on
   `input.origin`/`renditions` which nothing sets; `docs/manual/sources.md`
   §"Saving a stream") and the `readRows` stub with its ~50 lines of comments.
8. **Tooltip strip per inventory**; the `whyAt` mismatch (`'A device cannot
   be cut'` has no entry, so the tooltip repeats the label) dissolves with the
   tooltips — the one-line `.src-why` statement stays, and where the fix is on
   another stage the statement gains a jump button (`→ Capture`).
9. Keyboard: list rows become focusable buttons (up/down arrows move the
   selection; Enter = Use on the timeline).

## Thread 5 — Encode

1. **Delete all 14 permanent `note()` paragraphs**; concepts → manual. The
   controls that leaned on them get real treatment:
   - **Quality slider**: end labels (`smaller file` ← → `higher quality`),
     tick at the default, direction visually normalized; readout keeps the
     real value (`crf 20`).
   - **Speed** (x264 preset): slider with end labels (`fastest encode` ← →
     `best compression`); values remain the encoder's own.
   - **Two-pass / Capped**: sub-controls labelled with units and a single
     statement line of *this render's* numbers (statement, keeps).
   - **Frame timing**: segmented control keeps the mono `-fps_mode cfr`
     readout (exact, data); the 3-branch paragraph goes.
2. **Range strip**: drawn in/out handles, pointer cursor, and numeric in/out
   clock fields beside `Whole timeline`. The 10px invisible drag zones stop
   being the only route.
3. **Advanced**: the `▸ Advanced` toggle moves to the head of the column it
   opens (right side), and its open state persists via the workspace store
   (through `store.adopt`, like the explain state did).
4. **`Choose for me`** → `Pick a codec for this render`; result shown by
   highlighting the changed control + a one-line statement chip that clears on
   the next settings change (no sticky sentence).
5. **Preview idle prose** → the button says what it does:
   `Compare 2 s encoded vs. lossless`, and the stat line stays (measurement =
   statement).
6. `(not in mp4)` codec entries: keep selectable (deliberate), but the row
   gains the same anchored error treatment as Thread 6.1 the moment it is
   picked.

## Thread 6 — Write

1. **Warnings get severity and anchors.** Split `warnings()` into
   `{level: 'error'|'caution', text, anchor}`: errors (muxer will refuse the
   codec, odd dimensions with yuv420p, two versions → one path, `image2`
   without a pattern) **block Export** (extend `begin()`), draw red, and jump
   to their anchored control on click; cautions stay orange. Kill the
   spine-card tooltip of joined warnings — the spine keeps its `warn` state,
   the rail is the list.
2. **Retire the `why()`/ⓘ system** (13 sections): content to
   `docs/manual/output.md`/`rendering.md`; `ex-note` statements stay.
3. **Disclosure headers stop lying**: `▸ Also write · 0`, `▸ Chapters`,
   `▸ File metadata` get a constant `+` button; the `▸` only ever discloses.
4. **Two `Export` buttons → one meaning.** The Compose toolbar's
   `#btn-export` (which *navigates*) becomes `Encode…`; the orange `#ex-go`
   keeps `Export`.
5. **`Back` stops mutating into `Stop the …`**: a render/preview holding the
   job slot gets its own `Stop` button beside a `Back` that always navigates.
6. **Raw-flag row labels** (`-f`, `-start_number`, `expr:`, `-f tee`) get
   plain labels (`Container`, `First number`, `Expression`, `Destinations`);
   exact strings remain the command bar's job. The capture stage's matching
   `-f` label is Thread 7's copy of this item.
7. Failed launch: the progress panel's raw exception gains a `Back` button.

## Thread 7 — Capture

1. **Device rows lead with what a thing is**: kind icon (screen / camera /
   mic / virtual) derived from `kinds`, human name first (already), demuxer
   name as a mono badge. The *card* stops titling itself `dshow` — its title
   is the source description; the demuxer is a badge.
2. **The `Source` field stops requiring dshow syntax.** For demuxers that
   enumerate: a picker (video source select + optional audio source select)
   that composes `video=…:audio=…` internally, with a free-text fallback
   field for the rest. The `What dshow can see` heading becomes `Sources`,
   and the hardcoded hint button (`Use "desktop"`) becomes the enumerationless
   demuxer's default source, pre-filled.
3. **Region**: visible corner handles + a dim rect overlay on the live
   picture with W×H×X,Y fields in the row; delete `· Drag to crop`.
4. **Meters** named by device (pad id as mono badge); `over` latch gets a
   clear button rather than a bare clickable light.
5. **Record refusals**: delete the unreachable long-form flashes; the
   one-line blocker chips stay and gain a jump where the fix lives elsewhere
   (`Needs a graph → [Build]` — the button the graph strip already has).
6. **Also write**: `+ File` always visible; the four-line paragraphs go;
   `-f` → `Container` (mirrors Thread 6.6).
7. **Active card**: always-on highlight ring + the right column header names
   the card it is editing (today: a dim `Editing [0]` note that only appears
   with ≥2 cards).
8. Tooltip strip per inventory (device rows, Stop after, meters, quality,
   pad pickers, Stop waiting).

## Thread 8 — global keyboard & chrome

1. **Shortcuts work from every stage.** The main `switch` in `app.js` is
   reachable only from Compose, so `D` gets you to Capture and nothing but
   `Esc`/`[`/spine gets you back. Stage-specific handlers (graph, encode) keep
   first refusal; the navigation and document keys go global.
2. **Fix the lies and the gaps**: `#btn-loop` claims `(L)` while `L` shuttles
   — give Loop a real key or drop the claim; surface `J/K/L`, `K`,
   `Shift+←/→` on the transport controls' titles (shortcut-name titles are
   allowed); `Ctrl+Y` and `Ctrl+Shift+S` join the tooltips of the buttons
   that own them; spine cards show their key letters (`Capture D`, dim).
3. **Report drawer becomes findable**: the `▸` + "Nothing to report yet"
   headline becomes a tab with count badges (`Report · 3 warnings · 2
   series`), and the measure offers row (`Crop`, `Black`, `Scenes`, …) gets
   labels + result cards as its feedback (the flash channel from Thread 0
   covers the rest). Measure refusal sentences shrink to statement + the
   settable control (`reset=0`, `peak=true` become buttons that set it).
4. **`#filename` vs `#doc-name`** merge into one "what am I working on"
   statement in the top bar.

## Thread 9 — docs sweep and close

Docs move with code in every thread (the manual absorbs each deleted
explanation in the same commit — extend the relevant `docs/manual/` part, keep
manual voice: what a user does, not internals). This thread is the final
sweep:

1. `PROSE-INVENTORY.md` has no undispositioned rows; delete it.
2. Fix `docs/manual/playback.md`'s wrong `[`/`]` claim; `keyboard.md` gains
   every real shortcut; remove manual sections describing deleted surfaces
   (local copy, readRows) — "narrow the entry honestly rather than deleting
   or faking it" where a capability was *reduced* rather than removed.
3. A closing screenshot tour (the script pattern in the audit) re-run and
   eyeballed against the rule: any sentence on screen must be a statement.

## Working rules for the implementing agents

- **One thread at a time, in order** (0 → 1 → 2 … → 9); all threads edit
  shared files (`index.html`, `style.css`, `app.js`) and the manual, so
  concurrency buys merge races, not speed. Run subagents on Sonnet, heavily
  instructed; give each: CLAUDE.md (read twice), this plan's thread verbatim,
  the inventory section it owns, the hazards below by name, and
  build/test/commit instructions. Verify each thread independently
  (`git log`, clean tree, run the suites yourself).
- **Commit to main** (unpublished repo, no branches). Subjects are a sentence
  in present tense stating the new behaviour.
- **Build & test**: `cmake --build build --config Release`, then the full
  `ctest --test-dir build -C Release` after anything structural — the ui_*
  suites assert on labels and DOM shape and **will** break; updating them to
  the new UI is part of each thread, keeping the "runs against any real file,
  skips absent fixtures" property.
- **Hazards, by name** (each has bitten before — the source comments say how):
  - Stage views are `display:none`, never unmounted: a measurement of zero
    means "not on screen"; never rebuild a view that holds a `<video>`.
  - Redraws go through `needs()`/`drawPending()` marking in `app.js` — never
    add a direct whole-edit redraw to a change listener.
  - `put()` rebuilds destroy focus; follow the `noteFocus`/`restoreFocus`
    pattern (`panel.js`, `card.js`) for any rebuilt column with fields in it.
  - `change` fires on departure-from-edited-field (bro's `value_change.h`);
    suites synthesize events and cannot see real interleaving — a field that
    can commit on `input` should.
  - One home per fact: meters (`sound_meter.h`/`levels.js`/`meter.js`),
    rotation, fps — do not grow a second one while building new UI.
  - Ask libav, never hardcode a capability list. Curated *ordering*
    (`COMMON`/`MULTI`) is fine; capability claims are not.
  - Persisted UI state (Thread 5.3 etc.) goes through `store.adopt()` — the
    one sanitizer — and `ui/.storage.json` is gitignored; never commit it.
  - Ids (`in3`, `clip:7/after-scale`) are load-bearing document content; new
    UI must not renumber or invent parallel ids.
  - If a DOM/engine capability is missing (cursors, file dialog, context-menu
    plumbing), **fix it in bro**, don't route around it here — and check what
    *this* bro implements before assuming a gap.
- **Scope discipline**: this plan removes prose and builds the UI that
  replaces it. It does not restyle for its own sake, does not rename working
  mechanisms, and does not add features beyond the named replacements. A
  tooltips-as-polish pass happens after, separately, and only then.
