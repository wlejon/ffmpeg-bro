# PLAN: Finish the no-prose UI

This is the second plan for the same directive. The first pass (commits
207dad2…c5c27de) landed about half of it and claimed all of it; this plan is
written against the repo as it stands at c5c27de, so **trust the greps below,
not the first pass's commit messages**. What is genuinely done is listed so no
thread redoes it; what was claimed and not done is a thread here; and four
controls the first pass shipped are dead on arrival and are the first thread,
because a button that does nothing is worse than the prose it replaced.

## The rule

**No instructional prose or explaining tooltips in the UI. The UI itself must
lead into what it does.** Every sentence currently in the UI gets exactly one
of these dispositions — decided sentence by sentence, never file by file:

| Kind | Test | Disposition |
|---|---|---|
| **Instruction** | Tells the user *how to operate* ("drag to…", "press X to…", "use this when…") | Delete. Replace with an affordance: a control, a cursor, a handle, a context menu, a structured picker, inline validation. |
| **Explanation** | Teaches a *concept* (how ffmpeg works, what a codec is, why an option exists) | Delete from the UI. If the sentence is worth keeping, it moves to `docs/manual/` in the same commit. |
| **Statement** | A *changing fact*: a refusal with its reason, a warning, a measured result, a count | Keep — one line, structured, anchored to the control it is about. Never folded. |
| **libav-reported string** | Option help, encoder long names, device descriptions — data from the build | Keep, as a secondary line. This is data, not authored prose. |
| **Shortcut-name title** | `title="Mute (M)"` — a name and a key, nothing more | Keep. |

The trap that consumed the first pass: reclassifying instructions as
statements to keep them, and trimming essays to shorter essays. A tooltip that
says what a thing *is* in one sentence is still an explanation. The question
is always "what UI would make this sentence unnecessary?" — and if the answer
is "a lot of UI", build the UI.

## The verification contract

The first pass reported "removed instructional tooltips" over a file that
still has 51 of them, and "retired why() fold system" over 25 live callers.
So every thread here ships under this contract, and **a thread that cannot
show its evidence is not done**:

1. **Every removal claim carries its grep.** "Removed the `-framerate` essay"
   means the commit message or the thread report shows the grep that now
   returns nothing. Tooltips are multi-line string concatenations, so the
   only census that works is:

   ```
   grep -rn -A3 "title: '" ui/*.js ui/*/*.js | grep "' +"
   ```

   (single-line greps miss every essay — that is how 77 of them survived a
   "verification" pass).
2. **Every new control is wired before it is committed.** For each new
   element: the grep showing its id/class referenced from JS, and a headless
   screenshot or suite assertion showing it doing its job. A button with no
   listener is a failed thread, not a partial one.
3. **Build + full suite after every thread**: `cmake --build build --config
   Release && ctest --test-dir build -C Release`. All 26 suites pass at
   c5c27de; a thread may not lower that.
4. **Docs move in the same commit** (CLAUDE.md rule). A deleted explanation
   that was true moves to `docs/manual/`; a changed behaviour updates the
   part that describes it.

## What is already done — do not redo

- `#osd` toast is at body level (`ui/index.html:617`); feedback is visible on
  every stage. CLAUDE.md carries the no-prose rule.
- `buildOptionRow()` in `ui/opttable.js` synthesizes typed controls from
  AVOption metadata (bool toggles, enum selects, sliders with sane-range
  gating). **Use it** for any option surface a thread touches; do not build a
  second synthesizer.
- Graph has a grouped top toolbar (`.gr-toolbar`, `ui/index.html:285`) and the
  empty panel is a stat block, not an essay.
- Compose has a Crop button (`#btn-crop`), the "Encode…" rename, and the
  pitch chip. Sources has flag chips and list keyboard navigation.
- Single-string paragraph tooltips were trimmed. The multi-line ones were not
  (see contract point 1).

---

## Thread A — the four dead controls

These are regressions the first pass shipped. Each is either wired for real
or deleted; nothing stays on screen dead.

**A1. `#doc-title`** (`ui/index.html:23`) — an editable input reading
"Untitled" that no JS references, while the real readouts it was meant to
replace (`#filename`, `#doc-name`) are `class="hidden"` and still written by
`ui/app.js:80` and `ui/app.js:869`. Decide what a document's name *is* before
wiring: the name is the `.fbro` path chosen at save, and nothing renames a
file from the title bar — so an editable input promises an action that does
not exist. Replace it with one **readout** (name + unsaved marker), delete
the two hidden duplicates, and point both writers at it. If instead a rename
path is built, it must actually rename (save-as flow), not just edit a label.

**A2. `Browse…`** (`ui/index.html:110`) — no click handler anywhere in the
repo. The blocker is that bro's DOM subset may have no file-open dialog.
Check bro first (`../bro`); **a gap here is fixed in bro, not routed around**
(CLAUDE.md), so if a native open-dialog binding is a contained addition to
bro, add it there and wire the button. If it is not contained, delete the
button — drag-and-drop (A-adjacent, Thread B3) and the path field are the
ways in until bro grows the dialog. Dead is not an option.

**A3. `+ Add generator…`** (`ui/index.html:254`) — the handler at
`ui/app.js:2012` adds `pictureSources()[0]` blindly; the old `<select>` was
deleted from the HTML so its wiring at `ui/app.js:2019` is dead code against
a missing element, and the user *lost* the ability to choose a generator.
Build the picker the name promises: clicking opens a list of
`generators.pictureSources()` — name plus libav description (data, allowed)
— and choosing one adds it. Delete the dead `gen-pick` block.

**A4. `Keep pitch`** (`ui/inspector.js:263`) — calls
`hooks.addFilter('atempo')` at line 265 and no caller in the codebase ever
supplies `addFilter`. Supply it: the inspector's host wires a hook that adds
a user `atempo` node anchored to the clip's chain through the graph model
(`ui/graph/model.js` — user nodes carry `anchor`, never `derived`). Verify
the node lands with the right anchor id (ids are load-bearing document
content) and survives a document round-trip. If that is genuinely out of
reach, delete the button.

## Thread B — Sources

`ui/sources.js` still has **51 `title:` sites**, most of them the multi-line
essays (the movie-filter essay at ~361, colon-escaping at ~735, `-framerate`
at ~842, `-loop 1` at ~888). This is the stage the first pass barely touched.

**B1. Census and disposition.** Every `title:` in the file through the
table above. The image-sequence essays die by becoming controls: a
`-framerate` field with inline validation, a pattern/type picker, a loop
toggle — the option row synthesizer from `ui/opttable.js` where AVOption
metadata exists.

**B2. The escaping essays die by the app doing the escaping.** A tooltip
explaining colon-escaping in filter paths exists because the user is being
asked to write ffmpeg syntax. The field takes a plain path; the code escapes.

**B3. The stage is a drop target.** Dropping files anywhere on Sources calls
`addInput` per file. (Check what drop events bro's subset delivers before
writing handlers; if the events are missing, that is a bro fix or a
documented deferral, not a silent dead zone.)

**B4. Join mode is visible.** When Join is armed, the stage says so with a
state the user can see and cancel — a banner/chip with the pending input and
an ✕ — not a mode held only in a variable.

**B5. The read window is a control.** The in/out window over a long input
becomes a dual-handle range bar over the duration, with the numeric fields
kept beside it.

**B6. Leftover surfaces.** `localCopySection`/`localCopyButtons`/`readRows`
(`ui/sources.js:477,483,1160,1203`) predate the ffmpeg-only pass; the
transcript read rows left the UI. Verify what each renders today; delete
what nothing reaches, keep what the envelope-source facts in CLAUDE.md still
need. Re-probe gets `#osd` feedback.

## Thread C — Encode

**C1. Fix the slider label layout.** The first pass's "end labels" are
stacked text lines above/below the controls, leaving three-line-tall rows
with orphaned words floating under selects. Labels go *at the ends of the
slider track* (a flex row: label — slider — label), one line per row.

**C2. The remaining `note()` prose** (10 sites left in `ui/export/`) through
the disposition table. The preview pane's idle prose and the sticky sentence
`Choose for me` leaves behind (`ui/export/form.js:985–1007`) are
instructions; the button is the affordance and the note goes.

**C3. The render range is a strip with handles** — draggable in/out on a
strip of the timeline extent, numeric fields beside it — replacing
text-only entry.

**C4. Advanced stays where it was put.** The Advanced toggle's state
persists through the workspace store (`store.adopt()` is the sanitizer both
persistence paths go through — use it).

## Thread D — Write

**D1. Warnings get severity.** `ui/export/warnings.js` returns flat strings
and `ui/export.js:337` prints them all alike. Split `{ level: 'error' |
'caution', text }`: an **error** (a spec the render will refuse) disables
the Export button with the reason on the button's row; a **caution** warns
and lets go. The suite that covers warnings asserts the blocking.

**D2. Retire `why()`/`explained()` for real.** 25 callers live in
`ui/export/` outside `explain.js`. Each folded explanation either moves to
`docs/manual/` or becomes a control/label that makes it unnecessary;
statements (`ex-note`/`ex-copy-note`) stay unfolded per the table. When the
callers are gone, `ui/export/explain.js` is deleted — the definition of done
is `grep -rn "why(\|explained(" ui/export/ ui/export.js` returning nothing
and the file gone.

**D3. Labels say what the control is.** The `-f` and `-start_number` rows
get English labels ("Container", "First frame number") with the flag as the
secondary line if kept at all. Disclosure headers carry their counts
("Streams · 3"), constant `+`/`▸` affordance.

## Thread E — Capture

**E1. 35 `title:` sites** through the disposition table.

**E2. A structured source picker.** `sourceArg()` (`ui/capture.js:1612`)
composes dshow's `video=…:audio=…` syntax — today the user meets that syntax.
The picker presents devices by kind (data from `bro.ffmpeg` device
enumeration — ask libav, never hardcode) and composes the string internally.

**E3. The last `-f` row** (`ui/capture.js:1971`, the Also-write row) says
"Container" like the recording rows at 1851/1863 already do.

**E4. Region capture gets handles** (drag a rectangle rather than type
coordinates), and a blocker row gets a button that jumps to the thing that
blocks (the session, the device) rather than a sentence describing it.

## Thread F — Graph and Compose finish

**F1. The 12 `gp-hint` sites in `ui/graph/panel.js`** through the table.

**F2. Context menus exist.** Zero `contextmenu` handlers in `ui/` today
despite a commit subject claiming one. Right-click a node: disable/enable,
delete, anchor; right-click empty canvas: add node here. **First verify bro's
subset dispatches `contextmenu`** — if it does not, fix it in bro (the
`Document.dispatchEvent` precedent) or defer with a note in the plan, never
ship a handler that can't fire.

**F3. Derived chains fold by default per clip.** `ui/graph/view.js:991`
still gates folding on a global node-count threshold (`FOLD_OVER`). A
derivation chain is one card per clip unless opened; user nodes never fold.

**F4. Cursors say what dragging does** — resize/move/wire cursors on the
graph and on Compose clip edges (check which CSS cursors bro's renderer
honors before relying on them).

## Thread G — Keyboard and chrome

**G1. Keys work outside Compose.** The switch at `ui/app.js:1663` returns
early for graph/exporter stages, so space-to-play works on one stage of six.
Transport keys (space, J/K/L-style, arrows) work anywhere they are
meaningful; stage-local keys stay stage-local.

**G2. The Loop lie dies.** `#btn-loop` is titled "Loop (L)"
(`ui/index.html:199`) while `case 'l'` at `ui/app.js:1753` calls
`nudgeRate(1)`. Either L loops or the title stops saying it does. Pick one;
the button and the key must agree.

**G3. The spine shows its keys.** Each stage chip carries its shortcut as
data (`1`–`6` or whatever G1 lands on), drawn by `ui/shell.js` — the spine
is rebuilt whole, so the hint is part of the render, not a patch.

**G4. The report drawer is findable.** `ui/report.js` still opens on
"Nothing to report yet" behind a `▸`. It becomes a visible tab with a badge
count when reports exist; empty states name the channel.

## Thread H — Docs and closing

**H1. Docs sweep**: every manual part touched by threads A–G says what the
user now does; the stale `[`/`]` claim in `docs/manual/playback.md` is
corrected.

**H2. The closing inventory is empty.** All of these return nothing:

```
grep -rn -A3 "title: '" ui/*.js ui/*/*.js | grep "' +"      # tooltip essays
grep -rn "why(\|explained(" ui/export/ ui/export.js          # the fold system
grep -c "gp-hint" ui/graph/panel.js                          # panel hints
```

and the per-file `title:` counts are down to shortcut names and libav
strings only (the report says the final counts and what each survivor is).

**H3. The screenshot tour** (`ffmpeg-bro-headless ui/ <tour.js> -- <media>`)
walks all six stages with two fixtures loaded and the shots are compared
against the pass's claims — every new control visible, no dead element
present.

---

## Working rules

- **Threads run sequentially**, one heavily-instructed subagent each, in
  A→H order (A unblocks nothing but is the user-facing bleed; B–E are
  independent in content but share files with each other at the edges — do
  not parallelize into one worktree).
- **Commit to main**, one or few commits per thread, subjects a present-tense
  sentence of the new behaviour ("The Sources stage accepts dropped files",
  not "add drop target").
- Hazards, by name, that bit before:
  - `put()` rebuilds destroy focus — use the noteFocus/restoreFocus pattern
    around any list a user types into.
  - Redraws are marked, not called: `needs()`/`drawPending()` in `ui/app.js`.
    A new listener that redraws directly on the model channel re-creates the
    12.9 s frame.
  - `change` on a text input is *departure from an edited field* (bro's
    semantics) — a field that can commit on `input` should.
  - Stage views are `display:none`, never unmounted — a measurement of zero
    means "not on screen", not "empty".
  - Everything read from `localStorage` or a document goes through
    `store.adopt()` / the document reader's sanitizing.
  - Ids (`in3`, `clip:7/after-scale`) are document content other files write
    down — never renumber.
  - **Ask libav, never hardcode a list** — device kinds, containers, options
    all come from `bro.ffmpeg` enumeration; curated *ordering* is fine.
- Suites: `ctest --test-dir build -C Release -R <name> --output-on-failure`;
  fixtures generate into `build/fixtures/` automatically. Headless drives:
  `./build/Release/ffmpeg-bro-headless ui/ tests/ui_sources.js -- <file>`
  from the repo root.
