[← The manual](README.md)

# The document

The one part of this manual that is not about a stage. A document is the whole
chain at once — every input, every clip, the canvas, the graph you wired and
what the Encode and Write stages are set to — held as one object, written to
one file, and opened again.

| | |
|---|---|
| `Ctrl`+`S` | save (`Ctrl`+`Shift`+`S` to save somewhere else) |
| `Ctrl`+`O` | open one, or add a media file |
| `Ctrl`+`N` | start again |
| `Ctrl`+`Z` | undo (`Ctrl`+`Shift`+`Z` or `Ctrl`+`Y` to redo) |

The name is in the top bar, with a dot beside it while there is something
unsaved. A document named on the command line opens as one:
`ffmpeg-bro my-edit.fbro`.

`Ctrl`+`O` takes a media file as well as a `.fbro`, and does the obvious thing
with each: a document replaces what you have open, a media file is added to the
edit you already have. The dialog offers the extensions this build's demuxers
claim, plus **All files** for the formats that claim none.

## What is in it

A `.fbro` file is indented JSON, on purpose: it describes an edit, it belongs in
a repository beside the footage, and a diff of one should be readable. It holds:

- **Inputs** — one per file or device you brought in, in the order they were
  added: the path, any forced demuxer or decoder options, hardware decode,
  trim/offset/loop settings. Reopening a document reopens each input exactly as
  it was configured.
- **Clips** — where each one sits on the timeline, which input it is cut from,
  its in-point, length, [speed](timeline.md#speed), geometry and level. A
  clip's name, size, frame rate and other details are read back from its input
  each time, not stored, so they always match the actual file.

  A [generator clip](timeline.md#a-generator-laid-out-like-a-clip) — `color`,
  `testsrc` and the like — stores the filter and its parameters instead of an
  input, plus the length you gave it, since a generator has no natural length of
  its own. A generator this build does not have is skipped on open with a
  message saying so, the same as a clip whose file has moved.
- **Canvas** — the output size, the timeline's rate, and stacked or grid layout.
- **Tracks** — per-track settings, currently just the [sync
  lock](timeline.md#the-sync-lock) (whether an `Alt`-drag ripples that track
  alone or every locked track together). A document from before track locks
  existed opens with none set.

- **Graph** — everything you inserted, locked, placed and wired on the
  [Graph](graph.md) stage.
- **Output** — what [Encode and Write](output.md) are set to, plus three things
  that only mean something inside this edit: chapters, the render range, and
  the output path.
- **Session** — where you were in it: the selected clip, the playhead, the
  stage, and the timeline's zoom.

Your encoder, container, quality and render size are remembered separately, in
your local settings rather than in the document — the next render is nearly
always the last one again, on whatever you open next. Chapters, the render
range and the output path stay in the document instead, because they belong to
this particular edit and would mean nothing carried into another one.

## Where you were in it

Open a document and it comes back where it was left: the clip that was selected
is selected, the playhead is where it was standing, the timeline is at the zoom
it was at, and you are on the stage the last save was made from. That is true
of a document somebody else handed you as well as your own — a `.fbro` is a
handoff of work in progress, so opening one moves you to where that work had
got to.

Restoring the session is **not an undo step** and does **not mark the document
unsaved**: scrubbing around after opening costs nothing and leaves the dot
alone.

A document with no session saved — an old one, a hand-edited one, or one naming
a clip that no longer exists — opens at the top of the timeline, fitted, with
nothing selected, rather than guessing.

## What `Ctrl`+`N` keeps

A new document empties the timeline, the inputs and the graph, and clears the
chapters, the render range and the output path, because each names something
about the edit that has just gone. Your encoder, container, quality and render
size stay, since those are habits rather than facts about one edit.

## Ids, and why they are written down

A clip and an input each keep the same id across a save and reopen. Filters
inserted on the Graph stage, source nodes, stream-copy settings and the saved
session all refer to a clip or an input by that id — so if ids were renumbered
on open, a filter could silently end up on the wrong shot, or a source node
could silently point at the wrong file. Nothing would look wrong on screen.

## When a file has moved

A document names files it does not contain. If one cannot be found when the
document is opened, its input comes back showing the error libav gives, the
same way a broken input looks on the [Sources](sources.md) stage — and the
clips cut from it are not laid out on the timeline. The document still
describes them; fix the path and open it again to bring them back. Nothing is
lost by this.

## Undo

Undo is a stack of saved states, so going back a step opens the previous one
rather than reversing a specific action.

- **A gesture is one step.** Dragging a clip, or holding a slider, produces one
  undo step for the whole gesture, not one per intermediate position — so `Ctrl`+`Z`
  after a drag returns to before the drag started, not partway through it.
- **A change that changes nothing is not a step.** Undo never adds a step that
  visibly does nothing when reversed.
- **`Ctrl`+`Z` only changes what is in front of you.** There are two separate
  histories: the edit (clips, inputs, canvas, graph) on the timeline-related
  stages, and the Encode and Write stages' settings on those two. A press on one
  never touches the other, and the button reads *nothing to undo on this stage*
  when its own history is empty. Arriving on the Encode stage and having it fill
  in a path, size and codecs from the timeline is not itself a step — undoing
  there goes back through your own changes, not to a blank form.
- **Locking a track is one step**, because it changes what the next `Alt`-drag
  does to the rest of the timeline, even though it is a setting rather than a
  clip edit.

Undo never moves the playhead, the selection, the current stage or the
timeline's zoom — those are restored from the session on open, not tracked as
edit history, so reversing a crop while you are looking at a shot two minutes in
leaves you looking at that shot. Opening a document starts the undo history
over; undoing across an open would otherwise land in the middle of a different
edit.

Undo is fast even on a large project: going back a step reuses whatever is
already unchanged rather than rebuilding it, so a crop reversed with `Ctrl`+`Z`
does not reopen every clip's decoder.

## What it is not

It is not a container for media. Nothing is copied, embedded or cached; a
document is a description of a render, and every frame it refers to lives where
it always did.

It is not a full snapshot of the running application. Besides the edit and the
session described above — where you were, four numbers and a name — nothing
about what has been analysed, what a render last said, or what a preview was
showing is written.

And it is not a version history. Undo is a stack held while the application is
running; closing it and opening the file again gives you the file, not the last
hundred things you did to it.
