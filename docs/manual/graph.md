[← The manual](README.md)

# The graph

`N` opens the Graph stage, which is the edit drawn as the filtergraph that
performs it. Every trim, every scale, every overlay, named the way ffmpeg names
them, wired the way ffmpeg wires them — the same chains the command bar prints
along the bottom, laid out so they can be read.

It is derived from the timeline and rebuilt on every change. Nothing on this
screen invents a graph; it asks for one and draws the answer, which is what
makes it a picture of the edit as it is now rather than a copy of the edit as
it was.

## When there is too much of it to read

A big edit derives far more nodes than a screen can show usefully — nobody
reads the ninth `trim` of a seventy-five-clip timeline; what you came here to
find out is which clip is which and what somebody put in the middle of one.
So above about thirteen clips **each clip's derived run is drawn as one
card** — `-i`, `trim`, `setpts`, `scale`, `format` and the sound beside them,
named in the order they run. `Collapse` on the bar is the switch; press it
again, or `Expand`, to open it back up.

It only changes what is *drawn*. The whole graph is still derived, still
printed along the bottom, still what gets rendered — the filter count on the
bar is the render's, not the screen's. Three things it will not do:

- **A run holding work of yours stays open.** A value you locked or a filter
  you inserted is never folded away where you cannot see it. The bar says how
  many stayed open and why.
- **A filter you inserted is never inside a fold.** It is drawn as itself, on
  the wire you put it on, downstream of the fold.
- **It says what it folded.** `75 clips collapsed` sits on the bar beside the
  counts.

`Open` on a folded card puts that one clip's run back; the rest stay folded. A
fold has no preview picture, because a preview is a render of one pad and a
fold stands for several — open it and every node in it gets the picture it
always had.

## Getting around it

It works the way a node editor works: Blender, Nuke, Houdini, Unreal and n8n
all agree on this much, and knowing one of them should be enough to use this.

| | |
|---|---|
| drag the background | select what the band covers |
| middle-drag | pan, from anywhere including over a node |
| wheel | zoom about the pointer |
| drag a node's title bar | place it — and everything else selected with it |
| click a value on a card | change it |
| hover a wire | its `+` |
| drag socket → socket | make a wire |
| drag a socket onto empty canvas | the palette, filtered to what can take that pad |
| click a wire | select it; `Delete` cuts it |
| `Add filter` | place one on the canvas with nothing wired to it |
| `Collapse` / `Expand` | each clip's derived run as one card, or all of them |
| `Open` on a folded card | that one clip's run back |
| `Fit`, or `0` | frame the whole graph |
| the percentage | back to 1:1 |
| `Re-layout` | give every node back to the layout |
| `Delete` | remove a selected node of yours, or cut a selected wire |
| `Esc` | clear the selection, then leave the stage |
| `Ctrl`+`F` | find a node by name |

Nodes carry a socket for **every pad the filter has**, not one per wire that
arrived — which matters most at `overlay`, whose two inputs are the canvas and
the clip and are not interchangeable. An input pad with nothing on it is drawn
hollow. **Where you put a node is remembered**, against the node rather than a
position, so it survives the graph being rebuilt by the next timeline edit; a
placed node does not move for anything except you and `Re-layout`. Zoomed out
far enough that the values stop being readable, the cards shrink to their
names and their pictures, and the minimap in the corner shows where you are.

A dot beside a wire's colour says what it carries — blue for picture, green
for sound, orange for subtitle cues. **Find a node** (`Ctrl`+`F`) dims
everything that does not match what you type against a node's name, its
filter and its clip, and pans to it when there is exactly one match.

## Putting a filter in it

Hover a wire that can take one and it offers a `+`. Click it and pick a filter
out of **libavfilter's own list** — five hundred of them in this build,
searchable by name and by what libavfilter says each one does. The filter
appears on the wire, selected, with its whole option table beside it.

What is *set* is on the card and can be typed there; what the filter *has* is
in the column, because `scale` has thirty options and a card with thirty rows
is not a card. Typing on either locks the node — see [Locks](#locks) below.

There are five places a filter can go, and they are five different pictures:

| Point | What is on the wire there |
|---|---|
| after decode | the source at its own size, format and colour |
| after scale | the clip as it will be composited — RGBA, at the size it occupies |
| after compositing | the whole canvas, before the encoder's colour |
| clip audio | one clip's sound, before it is trimmed and placed |
| after mixing | the whole soundtrack |

Two filters at one point run in the order you added them.

There is deliberately **no point after the output colour conversion**. That
conversion happens in the writer rather than in the graph this binary runs,
so a filter placed there would sit in the encoder's colour in the command you
copied and in RGBA in the render you got — one insert point producing two
pictures, which is worse than one fewer insert point.

## Wiring it yourself

Splicing is one in and one out, and most of libavfilter is not. `overlay`
reads two pads, `amix` reads as many as you say, `split` writes several,
`concat` does both — none of which can be dropped *onto* a wire, so they are
placed and then wired:

- **Drag from a socket to a socket.** Either end first; a wire from an input
  back to an output is the same connection. **An input pad holds one wire**,
  so dropping on an occupied pad replaces what was there — which is how a
  filter gets *between* two derived nodes in one gesture.
- **Let a wire go over empty canvas** and the palette opens on what can take
  that pad, out of libavfilter's own registry. What you pick lands where you
  let go and arrives already wired. `Add node` is the same palette with
  nothing in the air.
- **Click a wire to select it, `Delete` to cut it.** Cutting a wire the
  derivation made is remembered — the skeleton is rebuilt from the timeline on
  every edit and would put it straight back, so the absence is written down.
  `Give it back` in the column hands the pad to the derivation again.

A filter whose pad count is a number — `amix=inputs=3`, `concat=n=3:v=1:a=1`,
`xstack` — grows and loses sockets as you change it, because the count is an
ordinary option in the column beside the graph. **A wire whose pad stops
existing does not vanish.** It is kept, reported by name — *amix has 2 inputs,
so your wire at input 3 has nowhere to land* — and put back the moment the
count goes up again.

## A node that makes something out of nothing

Some filters read no pad at all. `color` is a rectangle, `testsrc` and
`smptebars` are test cards, `sine` is a tone, `anullsrc` is silence,
`mandelbrot` is what it says — about thirty of them in this build, discovered
from libavfilter's own registry rather than listed by hand.

`Add node` opens on them, and so does letting a wire go from an *input* pad —
which is the short way round, because what you get back is already wired to
the pad you were trying to fill.

A generator arrives carrying **the size and the frame rate the render is**.
That is not decoration: a graph whose last pad is a different size from the
render is refused rather than quietly rescaled, so filling it in at the
moment of placing means the ordinary case simply agrees. It does not chase
the render afterwards, though — change the output size and the generator's
column carries both numbers, with `Match the render` beside it to update to
what placing it today would have written.

**A generator has no length.** It goes on producing for as long as it is
asked to, so with clips on the timeline the render's range is what stops it;
with nothing on the timeline its own `duration`/`d` option is the only thing
that can. Say nothing and the stage says so.

**A render with nothing on the timeline is a real render.** `ffmpeg -f lavfi
-i testsrc -t 5 out.mp4` is a thing people do every day, and a `testsrc`
wired to `video out` writes a file here with no clip involved. With no clips
there is no derived black canvas either, so `video out` is empty until you
fill it.

### A generator that is a clip instead

The same filters can be laid out on the timeline — see [a generator, laid out
like a clip](timeline.md#a-generator-laid-out-like-a-clip) — and one that has
been is a different thing on this stage: **its node is derived**. It sits at
the head of that clip's chain, with the same `trim`, `setpts`, `crop`,
`scale` and `overlay` below it as any other clip; it is rebuilt on every
timeline edit, and deleting the bar deletes it. So it takes no `-i` number,
and it is not in the graph you have made — `Clear` leaves it exactly where it
is, because it belongs to the edit.

A generator you place *here* stays a node with no lane, no bar and no in
point, kept in the graph you made and surviving every timeline edit. Which you
want is a real choice: a `color` feeding an `overlay` as a badge is a piece of
the graph, and a colour card with a title on it for four seconds is a shot.
The insert points on a generator clip are the ones every clip has.

**Refused rather than approximated**: a filter with an input pad cannot be
what a clip is cut from, a sound source is not a picture, and a filter this
build does not have is named.

## A file the graph reads

A watermark, a logo bug, a picture-in-picture insert and a sound bed are one
shape: a file the *graph* reads that nothing on the timeline is cut from.

This application places such a file as an ordinary `-i` node rather than
libavfilter's `movie=` filter, because everything deciding *how a file is
opened* — a forced demuxer, `-probesize`, `-loop`, `-ss`, `-t`,
`-stream_loop`, and for a URL the whole protocol option table — belongs to
the `-i`. It also keeps the Sources stage honest: that stage claims to be
every file this render opens.

So the palette's Sources list **leads with the inputs you already have**.
Picking one places a node that is that input — a file, with a socket per
stream the probe found, numbered as the `-i` it will be. Everything about how
it opens stays on the Sources stage, and the card there says `read by the
graph` and refuses to be removed out from under the node naming it.

Placing a logo over the picture is then two nodes and two wires:

1. `Add node` → the logo file. It lands on the canvas.
2. Drag from the composite's output into empty canvas → pick `overlay`. It
   lands wired to overlay's first input, which is what it draws *onto*.
3. Drag the logo's picture socket onto overlay's second input.
4. Drag overlay's output onto `video out`.

**A socket per stream the probe found** includes a third kind, on a file
whose subtitle track is *pictures* of characters: `dvdsub` and
`hdmv_pgs_subtitle` grow an orange **cues** socket, and a wire from it into an
`overlay` is what draws them — see [Drawing them, when they are
pictures](subtitles.md#drawing-them-when-they-are-pictures). A text track
grows none, because drawing characters is the `subtitles` filter's job rather
than a pad.

`movie` and `amovie` are still there in the palette as ordinary filters with
no inputs, and if you use one, the file it names is listed on the Sources
stage under **Opened by the graph**, with an offer to make it an `-i`
instead. Two things to know if you do: nothing on the Sources stage reaches
it, and a path with a drive letter in it has to have its colon escaped
(`C\:/logo.png`), because a colon separates filter arguments.

## An end of your own

`video out` and `sound out` are the derivation's two ends, and a render maps
them because they are the render's picture and its soundtrack. A graph can
have more ends than that. **Drag forwards out of an output pad** and the
palette leads with *an output*. It lands wired and already named, and the
name is editable the moment it arrives. `out2`, `out3` — not `out1`, because
`vout` and `aout` are the derivation's own names for the composite and the
mix.

The name becomes the pad label the chain feeding it is printed with, so
something can ask for the pad by name: a stream on the Write stage can be fed
from `pad:<label>`, and a recording writes one too — see
[Capture](capture.md). Rename it and everything reading it moves with it,
because the identity is the node and the name is what ffmpeg reads.

The naming rules are ffmpeg's: letters, digits and underscores only; not
`vout` or `aout`; not the same name twice; and not fed straight from an `-i`,
since `[1:v]` has no chain to put a label on the end of — one `null` in
between is enough.

**Video out may then be left empty.** Once an output of that kind is fed, a
graph whose whole picture leaves by name is a legitimate graph and the stage
stops asking for the composite's pad. The stream list on the Write stage
decides what actually gets written.

## When it will not run

A graph you are half way through wiring is a graph that will not run, and
that is a normal state to be in. The stage draws it and **says what is wrong
on the node it is about**: the card is outlined, the reason is on it, the
column beside it says the same thing with room, the bar along the bottom
counts them, and the Graph card on the spine reads `will not run` from
whichever stage you are on.

| | |
|---|---|
| an input pad with nothing on it | `overlay has nothing wired to its input 2 of 2` |
| a pad read twice | `hflip's output is read by 2 filters — put a split in between` |
| an output nothing reads | `nothing reads split's output 2 of 2` |
| a picture wire in a sound pad | `a picture wire arrives at amix's input 2 of 2, which takes sound` |
| a loop | `these feed each other in a circle: hflip → vflip` |
| a filter this build does not have | `libavfilter in this build has no filter called "unsharpenator"` |
| nothing mapped | `nothing is wired to video out, so the render has no picture to write` |
| a wire on a pad that stopped existing | see above |

**A render is refused rather than approximated.** The command bar prints the
reason instead of a filtergraph, and the export goes through the internal
compositor *without your filters* and says so on the Encode stage — the
honest outcome, because the alternative is a file that succeeded and is not
what you asked for.

## Seeing what each node produces

A node card says what a filter is *set to*. What it does not say is what
comes out of it — `crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25` is a claim about a
picture, and a claim about a picture is either right or it is a bug you find
at the end of a render.

So every node on the picture side plays its own output, looping. **Drag the
corner of a card** to make it as big as helps, and the media fills it and
re-renders at the new size. The size is remembered per node.

These are real renders, not simulations, run through the same libavfilter
path an export takes. Some rules keep it affordable:

- **One at a time, and always behind an export.** A node preview waits for
  everything else.
- **Only for the cards on the screen**, plus a margin — panning brings the
  rest in as they arrive.
- **Nothing renders until the graph holds still.** Dragging a value walks
  through many of them; only the one you stop on is rendered.
- **Only what the node depends on.** Previewing the first filter of a
  two-clip edit opens one file, not two.
- **Taken from where the playhead was** when you opened the stage, not
  followed live. `At playhead` re-takes it; `Previews` turns the whole thing
  off.

`video out` gets one too — it is the pad the muxer maps, which makes it the
one node on the screen that means *the render*. Audio nodes have no picture,
and show none rather than a black rectangle.

## Playing a node

A couple of seconds on a loop answers "is the crop right". It does not
answer "does this hold up over a shot". **The ▶ in the corner of a picture**
plays that node forward, from where the preview was taken to the end of what
would be written.

Every second of it is a real render, so an expensive graph cannot be played
at speed. The range is rendered in pieces ahead of the picture, and each
piece plays at its own rate: when the renderer keeps up, that is real time;
when it does not, the picture waits and the readout says what rate is
actually being sustained — `0.42×`, waits included — rather than quietly
dropping frames to look smooth.

Pressing play starts on the frame already in the card. One node plays at a
time.

**A bar under the picture is where in the range it is**, and clicking or
dragging it moves the picture there. The lighter part of the bar is how far
the pieces already in hand reach — a seek inside it costs nothing, and past
the end of it costs exactly what playing there costs. Nothing already
rendered is thrown away when you move, so going back over something you have
just watched is instant.

The rate readout starts over from a seek, since the seconds spent deciding
where to look are not playback. The picture moves on the press and again on
release, not on every pixel of a drag.

The column beside the graph has the other half of the same question.
**`Measure to here`** runs the graph as far as the selected node and no
further, keeping the ancestors only, at the node's own size. See [Measuring,
and doing something about it](rendering.md#measuring-and-doing-something-about-it).

## When it is on

A filter does not have to run for the whole render. ffmpeg's `enable` option
is an expression evaluated per frame, and the **When** strip in the column
beside the graph is where it is set: the render's range as a ruler, the spans
the expression describes drawn on it, and ends you drag. `Another span` adds
one; each span is `between`, `from` or `until`, with its moments in fields
beside it. The card carries the answer in one line.

**`enable` turns a filter on and off. It does not interpolate a value.** A
blur that comes on at ten seconds comes on at full strength — that is not
"keyframes". What ffmpeg *does* have for animating a value is an expression
in a filter's own option, evaluated every frame; that gets a strip of its
own, see [What a value does over time](#what-a-value-does-over-time) below.

The strip is a **reading of the expression, not a copy of it**: it is parsed
on every draw and nothing is written until you drag or type. The expression
itself is in a field under the strip and on the card, quoted —
`enable='between(t,1,2)'`.

An expression the strip cannot draw is **left exactly as you typed it**. It
can draw `between(t,a,b)`, `gt(t,a)`, `gte(t,a)`, `lt(t,b)` and `lte(t,b)`
added together; anything else — `mod(t,4)`, an expression against `n` or
`pos`, arithmetic inside a span — makes the strip stand down and say which
part it gave up on, without approximating or rewriting.

**A filter with no timeline support is offered no control at all**, because
libavfilter checks the flag and refuses the graph outright — *Timeline
('enable' option) not supported with filter 'scale'*. One set the other way,
or moved onto a filter that cannot take it, is reported against that node
before the render rather than after.

`t` is seconds into the render, measured from the start of the range. A
filter spliced in *before* that, at a clip's `after decode` point, sees the
source file's own timestamps instead, and the strip says so and rules itself
in the source's seconds.

**The playhead is drawn on the strip, and on the card's line too**, in the
same accent the timeline's own playhead uses. Outside the render's range it
is **hidden rather than pinned to an edge**, since there is nothing for the
strip to say there. On a node reading the file before the edit's clock is
applied, the mark goes through the clip under the playhead — where no clip of
that file is under the playhead, nothing is drawn.

**`⇤` and `⇥` beside a span's numbers** take that end to where the playhead
is standing, and `On from here` adds a span that comes on there and stays on.
Where the playhead is off this node's clock, the mark is hidden and the
buttons go dim rather than writing a number that is not where you meant.

### And the span is on the timeline, where the shot is

A strip in this column answers "does this span cover the render". Whether a
blur covers the *shot* can only be answered where the shot is — so every span
that exists is also drawn on the **When lane** on the timeline, under the
video tracks, with both ends draggable and the whole span movable. See [the
When lane](timeline.md#the-when-lane). A drag on either side moves the same
data, and either is one press of `Ctrl`+`Z`.

**The lane is there because spans are**, not because a stage is open. An edit
with none carries no lane; a span made here is on the timeline the moment you
go back to it; taking the last one off takes the lane away again.

**One row per node, named** — `hue · V1 shot.mp4` — in a colour of its own,
so two overlapping spans from different nodes both stay reachable by the
pointer.

Two things are not on it. A filter on a file the **graph** reads on its own
account — a watermark, a logo bug — is on that file's own timestamps and no
clip is cut from it, so it has a strip here and no row there. And `enable`
set on a filter with no timeline support is a graph that will not build,
reported on its node rather than drawn as a draggable region.

## What a value does over time

`enable` says when a filter is on. This says what its values do while it is.

ffmpeg has no keyframes and no interpolation in its timeline support. What it
has instead is **an option written as an expression, re-read for every
picture** — `crop=x='lerp(0,160,clip(t/2,0,1))'` pans the crop window across
the shot, `rotate=a='t*PI/6'` turns, `volume='0.5+0.5*sin(2*PI*t)'` breathes.

An option that holds an expression gets a **Value over time** section in the
column beside the graph: the render's range as a ruler, the value drawn as a
curve on it, the playhead marked, and a line saying what the value is where
the playhead stands. The card carries the answer in one line — `x 0→160`.

**The curve is libav's own arithmetic** — the same evaluator libavfilter
calls on the option itself — so what is drawn is what the render performs
rather than a second opinion about it. Which options can hold one is decided
the same way: an option that libav types as a **string**, whose current
value the evaluator can **parse** as an expression, offers `Vary over time`.

### Points, and reading them back

`Vary over time` writes a two-point ramp holding the value it already had —
flat, so nothing moves until you move an end. Each point is a moment and a
value in fields, `⇤` puts a point where the playhead is standing, `Another
point` adds one, and `Hold it still` takes the whole thing back to a number.

**Anything the editor writes, it reads back.** It writes one shape and parses
exactly that shape; anything else — including a hand-edited version of its
own output — comes back as "not points": the editor stands down and says so,
the curve carries on being drawn from libav's evaluation, and your text is
left exactly as you wrote it.

Between two points the value holds at its ends rather than shooting off.
Points are sorted before they are printed, so dragging one past its neighbour
is a curve of the same shape rather than a division by a negative span.

### `eval`, and what it is actually a signal for

A handful of filters (`scale`, `overlay`, `pad`, `volume`, `eq`, `fftfilt`,
`perspective`, `vignette`, `scale2ref`) carry an `eval` option choosing
between evaluating an expression once, when the graph is built, or on every
frame. It is not a sign of which filters have expressions — `crop`,
`drawtext`, `zoompan`, `rotate` and `geq` have none of the most
expression-shaped filters there are and no `eval` at all. Where a filter has
one and it is not set to evaluate per frame, the section says so and offers
the press that fixes it, because an expression on a value that is only read
once will not animate.

### What it will not draw, and why

**A variable this application has no number for.** `t` is the only one it
supplies. An expression using `in_w`, `main_h` or `text_w` — values that
depend on the chain above the node — or `n` — a frame count, ambiguous
between the timeline's rate and the encoder's — parses correctly but is
refused a curve by name.

**A filter that means something else by `t`.** `drawbox` and `drawgrid` use
their own `t` for box thickness rather than time; an expression of `t` on
one of them is refused a curve and told why.

In every case the expression still goes to the render exactly as written.
Refusing to draw a curve is not refusing to run it.

## Locks

Every value on a derived node can be typed into, and **typing into one locks
that node**. The skeleton around it still regenerates: move the clip, trim
it, crop it, and everything except the thing you set follows.

Every place that could disagree says which one won. The node is badged, the
Graph card on the spine counts the locks, the panel beside the graph says
what the lock outranks, and **the control it took over is marked in the
properties panel** — faded, with a dot, and a tooltip naming the node to
unlock. `Unlock` hands it back to the derivation.

A filter you insert and a value you lock survive the clip being moved and
trimmed. Splitting a clip copies the filters and the locks to both halves
(a cut should not change how either half looks) but does not copy the wires
(an input pad holds one wire). A clip trimmed out of the rendered range takes
its nodes and wires with it and brings them back; deleting the clip takes
them for good.

They are remembered in two places. `localStorage` holds the **workspace** —
whatever was last on the screen — and a [document](document.md) holds an
**edit** somebody named and saved. A graph restored from the workspace drops
any node naming one of your inputs, because only the document brings the
inputs back with it and the ids would otherwise name whichever file happened
to be third that run.

`Ctrl`+`Z` reaches all of it: a node placed, a wire drawn, a pad cut and a
value locked are each a step. See [Undo](document.md#undo).

## What changes when there is one

A render with a filter of your own in it goes through **libavfilter**
instead of the internal compositor, and nothing has to be switched on for
that — it happens automatically the moment the graph carries one.

One consequence worth knowing: the command bar stops calling its filtergraph
a translation, because on this path it is not one — those are the exact
chains libavfilter parses, all but the last. Everything past the compositor
in the printed command is **exact** (literally what the render sets); the
composition itself, when there is no filter of yours in it, is only
**equivalent** (the renderer composites RGBA rather than building that
graph).

## A filter in the viewer

The program monitor shows them. A clip with filters of its own plays them:
its `<video>` is pointed at the clip's input **with the clip's chain on
it** — the same mechanism a `-f lavfi` input and a live capture pad already
reach the screen by.

What runs is the filters *you* put there, in the order the graph runs them —
the derivation's own `trim`, `crop`, `scale` and opacity are left out,
because the viewer already does every one of those with the playhead, the
crop window, the placement rectangle and a style. The colour-format
conversions are not left out: a `negate` spliced in after the derivation's
`format=rgba` inverts red, green and blue as it does in the render, rather
than the decoder's raw yuv420p.

`enable=` comes on where it will come on in the render, and *where* in the
chain decides which clock that is: a filter put in **after the decode** sees
the file's own timestamps; one put in **after the scale** sees the moment the
edit puts that frame at.

**A filter that resizes the picture resizes the clip.** A `crop` or a `scale`
put on a clip changes how big that clip's picture *is* on screen, fitted in
the shape the filter made it rather than stretched back to the shape the file
was. The render follows without being told, because there is one layout
implementation.

Two things it will not show, and both keep the `fx` badge rather than drawing
something nearly right:

| | |
|---|---|
| a **resize below the point where the clip is placed** | the render lays whatever comes out below that node over the canvas at its own size, at the rectangle's top-left, which the viewer has no way to place. Press `O` to see it. |
| filters that are **not one run** | a fork, or a node wired in by hand from somewhere else. Playback is one stream through one chain. |

A resize on the way *in* combined with any filter of yours below the `scale`
is refused for the same reason: the view cannot tell which of the two
resized the picture, and guessing wrong would put it in the wrong rectangle.

A chain libavfilter will not take is refused the same way, with libav's own
message on the picture — so a mistyped filter argument is reported when you
type it rather than when you render.

Both of those refusals, and anything else this way of showing a filter
cannot reach — a filter over the whole canvas, a generator with no clip —
are what `O` is for: **[the output on the program
monitor](playback.md#the-output-instead-of-the-clips)** plays the render
itself rather than one element per clip, so what it shows has no such
exceptions. This is the cheap way, exact for everything a clip does on its
own; that is the real render, and it costs a render.
