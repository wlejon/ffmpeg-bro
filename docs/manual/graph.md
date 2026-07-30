[← The manual](README.md)

# The graph

`N` opens the Graph stage, which is the edit drawn as the filtergraph that
performs it. Every trim, every scale, every overlay, named the way ffmpeg names
them, wired the way ffmpeg wires them — and the same chains the command bar
prints along the bottom, laid out so they can be read.

It is **derived from the timeline and rebuilt whenever the timeline moves**.
Nothing on this screen invents a graph; it asks for one on every change and
draws the answer, which is what makes it a picture of the edit as it is now
rather than a copy of the edit as it was.

## Getting around it

It works the way a node editor works. Nothing here is invented — Blender, Nuke,
Houdini, Unreal and n8n all agree on this much, and knowing one of them should
be enough to use this.

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
| `Fit`, or `0` | frame the whole graph |
| the percentage | back to 1:1 |
| `Re-layout` | give every node back to the layout |
| `Delete` | remove a selected node of yours, or cut a selected wire |
| `Esc` | clear the selection, then leave the stage |

Nodes carry a socket for **every pad the filter has**, not one per wire that
arrived — which matters most at `overlay`, whose two inputs are the canvas and
the clip and are not interchangeable, and which is what makes an empty pad
something you can see and aim at rather than something invisible. An input pad
that has nothing on it is drawn hollow. **Where you put a node is remembered**, against the node rather
than against a position, so it survives the graph being rebuilt by the next
timeline edit; a placed node does not move for anything except you and
`Re-layout`. Zoomed out far enough that the values stop being readable the cards
become their names and their pictures, and the minimap in the corner is where
you are.

## Putting a filter in it

Hover a wire that can take one and it offers a `+`. Click it and pick a filter out of
**libavfilter's own list** — five hundred of them in this build, searchable by
name and by what libavfilter says each one does; there is no list of supported
filters written down anywhere in this application. The filter appears on the
wire, selected, with its whole option table beside it, read out of the filter's
own `AVClass` exactly as the encoder's advanced column is read out of an
encoder's.

What is *set* is on the card and can be typed there; what the filter *has* is in
the column, because `scale` has thirty options and a card with thirty rows is not
a card. Typing on either locks the node — see below.

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
conversion is the one chain that exists in the printed command and not in the
graph this binary runs — the writer does it here — so a filter placed there
would sit in the encoder's colour in the command you copied and in RGBA in the
render you got. One insert point producing two pictures is worse than one fewer
insert point. It is attached at the very end, after everything you did, which is
what makes wiring anything behind it unreachable rather than something to be
warned about.

## Wiring it yourself

Splicing is one in and one out, and most of libavfilter is not. `overlay` reads
two pads, `amix` reads as many as you say, `split` writes several, `concat` does
both — none of which can be dropped *onto* a wire, because there is nothing for
the second pad to read. So they are placed and then wired:

- **Drag from a socket to a socket.** Either end first; a wire from an input
  back to an output is the same connection. **An input pad holds one wire**, so
  dropping on an occupied pad replaces what was there — which is how a filter
  gets *between* two derived nodes in one gesture rather than a delete and two
  connects.
- **Let a wire go over empty canvas** and the palette opens on what can take
  that pad, out of libavfilter's own registry. What you pick lands where you
  let go and arrives already wired. `Add node` is the same palette with
  nothing in the air.
- **Click a wire to select it, `Delete` to cut it.** Cutting a wire the
  derivation made is *remembered*: the skeleton is rebuilt from the timeline on
  every edit and would put it straight back, so the absence has to be written
  down. `Give it back` in the column hands the pad to the derivation again.

A filter whose pad count is a number — `amix=inputs=3`, `concat=n=3:v=1:a=1`,
`xstack` — grows and loses sockets as you change it, because the count is an
ordinary option in the column beside the graph. **A wire whose pad stops
existing does not vanish.** It is kept, reported by name — *amix has 2 inputs,
so your wire at input 3 has nowhere to land* — and put back the moment the count
goes up again, because a mistyped number should not be lost work.

## A node that makes something out of nothing

Some filters read no pad at all. `color` is a rectangle, `testsrc` and
`smptebars` are test cards, `sine` is a tone, `anullsrc` is silence,
`mandelbrot` is what it says — and there are about thirty of them in this build.
They are **discovered, not listed**: a source here is simply a filter
libavfilter declares with no input pads, so a build that gains one gains it in
the palette without an edit.

`Add node` opens on them, and so does letting a wire go from an *input* pad —
which is the short way round, because what you get back is already wired to the
pad you were trying to fill.

A generator arrives carrying **the size and the frame rate the render is**, read
out of the filter's own option table. That is not decoration: a graph whose last
pad is a different size from the render is refused rather than quietly rescaled,
so filling it in at the moment of placing means the ordinary case simply agrees.

It does not chase them afterwards, and **the node says so where the numbers
are**. Change the output size and the generator's column carries both — *this
`testsrc` was placed carrying the render's numbers and they have changed since:
size 640x360, and the render is 1280x720* — with `Match the render` beside it,
which writes what placing it today would have written. That is one press and not
a binding, for the reason `Follow the clip` on a copied stream is one: a value
that silently rewrote itself would stop being the value you typed.

**It states the disagreement rather than predicting a failure**, and the
difference is the point. Whether a particular generator's size reaches the
output depends on what is wired after it — a `color` feeding an `overlay` as a
badge is *meant* to be its own size, and a `scale` in between settles it either
way — so the note says what the two numbers are and where each came from, which
cannot be wrong, and leaves the refusal at render time to be the authority on
what the graph actually does. It is drawn in the accent rather than the red the
rest of the node's problems use, because everything else in that box is
something ffmpeg will reject and this may be perfectly fine.

**A generator has no length.** It goes on producing for as long as it is asked
to, so with clips on the timeline the render's range is what stops it, and with
nothing on the timeline its own `duration`/`d` is the only thing that can — the
same rule a still and a `-stream_loop -1` follow, and zero still means nobody
knows. Say nothing and the stage says so: *the range is empty — with nothing on
the timeline, a source's own duration (d) is the only thing that says how long a
render would be*.

**A render with nothing on the timeline is a real render.** `ffmpeg -f lavfi -i
testsrc -t 5 out.mp4` is a thing people do every day, and a `testsrc` wired to
`video out` writes a file here with no clip involved. With no clips there is no
derived black canvas either — a rectangle nothing is laid over would be a source
nothing reads the moment you wire your own to the sink — so `video out` is empty
until you fill it, and the stage says which pad it is waiting on.

### A generator that is a clip instead

The same filters can be laid out on the timeline — see [a generator, laid out like
a clip](timeline.md#a-generator-laid-out-like-a-clip) — and one that has been is a
different thing on this stage, in the one way that matters here: **its node is
derived**. It sits at the head of that clip's chain, exactly where the clip's `-i`
would be for a file, with the same `trim`, `setpts`, `crop`, `scale` and `overlay`
below it as any other clip; it is rebuilt on every timeline edit, and deleting the
bar deletes it. So it takes no `-i` number — a file beside it is still `[0:v]` —
and it is not in the graph you have made: `Clear` leaves it exactly where it is,
because it belongs to the edit.

A generator you place *here* stays what it has always been: a node, with no lane,
no bar and no in point, kept in the graph you made and surviving every timeline
edit. The two do not interfere, and which you want is a real choice — a `color`
feeding an `overlay` as a badge is a piece of the graph, and a colour card with a
title on it for four seconds is a shot.

The insert points on a generator clip are the ones every clip has, under the same
names, so a `drawtext` over a colour card is placed the way a `drawtext` over a shot
is — and the program monitor shows it, because a generator's clip is played through
its own `-f lavfi -i` and a filter on it is a chain over that input like any other.

**Refused rather than approximated**, the way everything on this stage is: a filter
with an input pad cannot be what a clip is cut from, a sound source is not a
picture, and a filter this build does not have is named. All three say so instead of
deriving a graph with an empty socket in it.

## A file the graph reads

A watermark, a logo bug, a picture-in-picture insert and a sound bed are one
shape: a file the *graph* reads that nothing on the timeline is cut from.

ffmpeg writes that two ways — `-i logo.png` with `[1:v]overlay`, and
`movie=logo.png,overlay` — and **this application reaches for the first**. The
reason is that everything deciding *how a file is opened* belongs to the `-i`:
the forced demuxer, `-probesize`, `-loop`, `-ss`, `-t`, `-stream_loop`, and for
a URL the whole protocol option table. A `movie` node carries a filename and a
seek point, so making it the mechanism would mean rebuilding all of that inside
a filter argument, badly, beside an input model that already has it. It also
keeps the Sources stage honest: that stage claims to be every file this render
opens, and a `movie=` names one that never appears there and cannot be probed
with the options in force.

So the palette's Sources list **leads with the inputs you already have**.
Picking one places a node that is that input — a file, with a socket per stream
the probe found, numbered as the `-i` it will be. Everything about how it opens
stays on the Sources stage, and the card there says `read by the graph` and
refuses to be removed out from under the node naming it.

Placing a logo over the picture is then two nodes and two wires:

1. `Add node` → the logo file. It lands on the canvas.
2. Drag from the composite's output into empty canvas → pick `overlay`. It
   lands wired to overlay's first input, which is what it draws *onto*.
3. Drag the logo's picture socket onto overlay's second input.
4. Drag overlay's output onto `video out`.

**A socket per stream the probe found** includes a third kind, on a file whose
subtitle track is *pictures* of characters: `dvdsub` and `hdmv_pgs_subtitle` grow
an orange **cues** socket, and a wire from it into an `overlay` is what draws them
— see [Drawing them, when they are pictures](subtitles.md#drawing-them-when-they-are-pictures).
A text track grows none, because drawing characters is libass's job and that is
the `subtitles` filter rather than a pad.

`movie` and `amovie` are still there — they are ordinary filters with no inputs
and the palette offers every one of those — and if you use one, the file it
names is listed on the Sources stage under **Opened by the graph**, with what
that costs said plainly and an offer to make it an `-i` instead. Two things to
know if you do: nothing on the Sources stage reaches it, and a path with a drive
letter in it has to have its colon escaped (`C\:/logo.png`) because a colon
separates filter arguments.

## An end of your own

`video out` and `sound out` are the derivation's two ends, and a render maps them
because they are the render's picture and its soundtrack. A graph can have more ends
than that. **Drag forwards out of an output pad** and the palette leads with *an
output* — the forward analogue of dragging backwards for a file or a generator, and
the one answer to "where does this go" that is not another filter. It lands wired and
already named, and the name is editable the moment it arrives, because the panel is
showing the node you just made. `out2`, `out3` — not `out1`, because `vout` and `aout`
are the derivation's own names for the composite and the mix, so the first one anybody
adds is the second thing this render writes.

The name is the whole of it: it becomes the pad label the chain feeding it is printed
with.

What that buys is that something can ask for the pad by name. A stream on the Write
stage is fed from `pad:<label>`, so a second video stream at a different crop is an
`overlay` branch ending in an output of its own and a row that names it — and a
recording writes one, which is above under [Capture](capture.md). Rename it and
everything reading it moves with it; the identity is the node, and the name is what
ffmpeg reads.

It is a pad label, so the rules are ffmpeg's and each is refused on the node: letters,
digits and underscores only, because a filtergraph reads anything else as the end of
the name; not `vout` or `aout`, which would leave nothing to say which pad the
render's own picture comes out of; not the same name twice, which ffmpeg rejects as
*Label found twice*; and not fed straight from an `-i`, because `[1:v]` is a demuxer's
stream with no chain to put a label on the end of — one `null` in between is enough.

**Video out may then be left empty.** Once an output of that kind is fed, a graph
whose whole picture leaves by name is a legitimate graph and the stage stops asking
for the composite's pad. The stream list on the Write stage is where it is decided
what actually gets written.

## When it will not run

A graph you are half way through wiring is a graph that will not run, and that
is a normal state to be in — the moment between placing a node and connecting it
is exactly it. So the stage draws it and **says what is wrong on the node it is
about**: the card is outlined, the reason is on it, the column beside it says the
same thing with room, the bar along the bottom counts them, and the Graph card
on the spine reads `will not run` from whichever stage you are on.

What is refused, each naming the node:

| | |
|---|---|
| an input pad with nothing on it | `overlay has nothing wired to its input 2 of 2` |
| a pad read twice | `hflip's output is read by 2 filters — put a split in between` |
| an output nothing reads | `nothing reads split's output 2 of 2` |
| a picture wire in a sound pad | `a picture wire arrives at amix's input 2 of 2, which takes sound` |
| a loop | `these feed each other in a circle: hflip → vflip` |
| a filter this build does not have | `libavfilter in this build has no filter called "unsharpenator"` |
| nothing mapped | `nothing is wired to video out, so the render has no picture to write` |
| a wire on a pad that stopped existing | *see above* |

**A render is refused rather than approximated.** The command bar prints the
reason instead of a filtergraph, and the export goes through the internal
compositor *without your filters* and says so on the Encode stage — which is the
honest outcome, because the alternative is a file that succeeded and is not what
you asked for. Every one of these is a shape ffmpeg itself rejects; the whole
value of printing a command is that it can be taken elsewhere and run.

## Seeing what each node produces

A node card says what a filter is *set to*. What it does not say is what comes out
of it, which is the thing you actually want — `crop=iw*0.8:ih*0.5:iw*0.1:ih*0.25`
is a claim about a picture, and a claim about a picture is either right or it is a
bug you find at the end of a render.

So every node on the picture side plays its own output, looping. **Drag the corner
of a card** to make it as big as helps, and the media fills it — and re-renders at
the new size, so a bigger card is a sharper picture rather than a stretched one.
The size is remembered per node.

These are real renders, not simulations: the graph is cut off at the chosen node,
ended with a scale that fits the card, and run through the same libavfilter path
an export takes. What a card shows is what that pad hands its consumer. The rules
that make it affordable are worth knowing, because they are what you will notice:

- **One at a time, and always behind an export.** There is one render slot. A node
  preview is the least important thing in the application and waits for everything
  else, so a nine-node graph fills in over a second or two rather than at once.
- **Nothing renders until the graph holds still.** Dragging a value walks through
  fifty of them; only the one you stop on is rendered.
- **Only what the node depends on.** Previewing the first filter of a two-clip edit
  opens one file, not two — and each input seeks to its own window, so a node on a
  clip forty minutes in costs the same as one at the top.
- **Taken from where the playhead was** when you opened the stage, not followed
  live. `At playhead` re-takes it; `Previews` turns the whole thing off.

`video out` gets one too — it is the pad the muxer maps, which makes it the one node
on the screen that means *the render*. Audio nodes have no picture, and show none
rather than a black rectangle.

## Playing a node

A couple of seconds on a loop answers "is the crop right". It does not answer "does
this hold up over a shot", which is usually what a filter is being judged on. **The
▶ in the corner of a picture** plays that node forward, from where the previews were
taken to the end of what would be written.

Every second of it is a real render, which is the whole point and also the
constraint: an expensive graph cannot be played at speed. So the range is rendered
in pieces, ahead of the picture, and each piece plays at its own rate. When the
renderer keeps up, that is real time. When it does not, the picture waits for the
next piece and the readout says what rate is actually being sustained — `0.42×`,
waits included. That number is a fact about your filter, and it is the reason
nothing here quietly drops frames instead: a smooth picture that had skipped nine
frames in ten would make a slow filter look fast.

Pressing play starts on the frame already in the card, because the still is the
first piece. One node plays at a time — there is one render slot, and two would not
be two playbacks so much as two stutters.

**A bar under the picture is where in the range it is, and clicking or dragging it
moves the picture there.** The lighter part of the bar is how far the pieces already
in hand reach, and it is the one thing on this stage that says a seek is free:
somewhere inside it costs nothing but telling the element where to be, and past the
end of it costs exactly what playing there costs, because every second here is a
real render. Nothing is thrown away when you move — a piece the renderer is halfway
through still lands and is kept — so going back over something you have just watched
is instant, which is what you want when the thing worth seeing twice is the thing
you just saw.

The rate readout starts over from a seek. Output seconds per wall second is a fact
about playback, and the seconds spent deciding where to look are not playback;
without that, jumping four minutes into a range would read as four minutes rendered
in an instant. The picture moves on the press and again on release rather than on
every pixel of a drag: a seek re-points which piece is wanted, and re-pointing that
sixty times a second is sixty renders begun and abandoned.

The column beside the graph has the other half of the same question. **`Measure
to here`** runs the graph as far as the selected node and no further, keeping
nothing but what the filters on the way said — the ancestors only, the same
saving as a preview, and at the node's own size rather than a card's. See
[Measuring, and doing something about it](rendering.md#measuring-and-doing-something-about-it).

## When it is on

A filter does not have to run for the whole render. ffmpeg's timeline support is
one option — `enable`, an expression evaluated per frame — and the **When** strip
in the column beside the graph is where it is set: the render's range as a ruler,
the spans the expression describes drawn on it, and ends you drag. `Another span`
adds one; each span is `between`, `from` or `until`, with its moments in fields
beside it. The card carries the answer in one line.

**`enable` turns a filter on and off. It does not interpolate a value.** That is
a real limit and it is worth being plain about, because "keyframes" is the word
people reach for and this is not that: a blur that comes on at ten seconds comes
on at full strength. What ffmpeg *does* have for animating a value is expressions
in a filter's own options — `crop`'s `x` and `y`, `overlay`'s, `drawtext`'s, some
of them with an `eval` option choosing between once and per-frame — which are
evaluated every frame and genuinely do move. Those are reachable here as ordinary
option text and are not surfaced as anything better than that.

The strip is a **reading of the expression, not a copy of it**. It is parsed on
every draw and nothing is written until you drag or type, which is the same
arrangement the Quality slider and the advanced option editor have: one
mechanism, nothing to drift. The expression itself is in a field under the strip
and on the card, quoted — `enable='between(t,1,2)'` — because a filtergraph
separates filters with commas.

So an expression the strip cannot draw is **left exactly as you typed it**. It
can draw `between(t,a,b)`, `gt(t,a)`, `gte(t,a)`, `lt(t,b)` and `lte(t,b)` added
together, and that is all; `mod(t,4)`, anything written against `n` or `pos`,
arithmetic inside a span, or any of the rest of ffmpeg's expression evaluator
makes the strip stand down and say which part of it it gave up on. It does not
approximate and it does not rewrite.

**A filter with no timeline support is offered no control at all**, because
there is nothing for one to do: libavfilter checks the flag and refuses the
graph outright — *Timeline ('enable' option) not supported with filter 'scale'*
— rather than ignoring it. Which filters have it is read off the registry, so
there is no list here either. One set the other way, typed raw or moved onto a
filter that cannot take it, is reported against that node before the render
rather than after.

`t` is seconds into the render, measured from the start of the range — the same
clock the whole graph runs on, because every derived chain begins
`setpts=PTS-STARTPTS+offset/TB`. A filter spliced in *before* that, at a clip's
`after decode` point, sees the source file's own timestamps instead, and the
strip says so and rules itself in the source's seconds: on a clip cut from twenty
seconds in, the numbers are the file's twenty-first second and not the render's
first, because that is what libavfilter will evaluate.

**The playhead is on the strip, and on the card's line too.** It moves as you
scrub, in the same accent the timeline's own is drawn in, because the two are
the same moment and reading them as different things is the confusion the mark
removes. That is what turns a shape into an answer: playing the node tells you
whether the filter is on *now*, and only a mark against the span tells you
whether it covers the shot. The card carries one as well, since that is where
several nodes are on screen at once and "which of these is on here" is a
question about all of them.

Outside the range it is **hidden rather than pinned to an edge** — past the end
of what is being rendered there is nothing for the strip to say, and a mark
parked at 100% would be saying there is. On a node that reads the file before
the edit's clock is applied the mark goes through the clip under the playhead,
which is the only honest mapping between the two clocks; where no clip of that
file is under the playhead the render is not touching it at that instant, and
again nothing is drawn.

It is moved in place from the frame loop rather than redrawn. The strip lives in
the properties column, and rebuilding that sixty times a second would replace
every control in it under whatever hand was on one — the same rule the node
cards' playback readout follows.

Playing the node (▶, above) still answers the other half: the readout over the
picture says `on` or `off` as the playhead crosses the boundary.

**And it can place an edge, not just report one.** `⇤` and `⇥` beside a span's
numbers take that end to where the playhead is standing, and `On from here` adds
a span that comes on there and stays on — which is the whole of what a single
press can know, since where it should go off again is a second decision. One
button per end rather than one per span: which end you mean is the entire
question, and a `between` whose far edge jumped when you meant the near one is
worse than no button at all. The line under them says which second a press would
use, in both the ruler's timecode and the `t=` the field will hold.

They go through the same mapping the mark does — one function, so a button
cannot place an edge at a second the mark is not drawn at — and therefore
through the same refusal: where the playhead is off this node's clock the mark
is hidden, the buttons go dim, and the line says which of the two reasons it is.
A press on a dim one writes nothing rather than reaching for the nearest
plausible number.

### And the span is on the timeline, where the shot is

A strip in this column answers "does this span cover the render". The question
people actually have is "does this blur cover the *shot*", and that one can only
be answered where the shot is — so every span that exists is also drawn on the
**When lane** on the timeline, under the video tracks, with both ends draggable
and the whole span movable. See [the When lane](timeline.md#the-when-lane) for the
gesture. It is the same data read from the other side: a drag there and a drag
here go through the same two functions, so they cannot come to mean different
things, and either of them is one press of `Ctrl`+`Z`.

**The lane is there because spans are**, not because a stage is open. An edit with
none carries no lane; a span made here is on the timeline the moment you go back
to it; taking the last one off takes the lane away again. That is the same rule
the video lanes follow — how many there are is a property of the edit.

**One row per node, named.** A `hue` on one shot and a `drawtext` over the whole
canvas are two rows, each carrying the filter's name and what it is on — `hue ·
V1 shot.mp4` — in a colour of its own. Rows rather than one shared strip, because
two spans from different nodes that overlap in time have to *both* stay reachable
by the pointer, and one drawn over the other is one you cannot get at. The rows
are ordered by the clip they are about, so a drag never reorders them underneath
your hand.

Two things are not on it, and each for a reason that is already stated above. A
filter on a file the **graph** reads on its own account — a watermark, a logo bug
— is written in that file's own timestamps and no clip is cut from it, so there is
no second of the edit its `t=5` corresponds to: it has a strip here and no row
there. And `enable` set on a filter with no timeline support is a graph that will
not build, which is reported on its node rather than drawn as a region you could
drag.

## Locks

Every value on a derived node can be typed into, and **typing into one locks
that node**. The skeleton around it still regenerates: move the clip, trim it,
crop it, and everything except the thing you set follows. A value you typed
that the next drag silently reverted is worse than the edit not applying,
because at least the second one is visible.

So every place that could disagree says which one won. The node is badged, the
Graph card on the spine counts the locks, the panel beside the graph says what
the lock outranks, and **the control it took over is marked in the properties
panel** — faded, with a dot, and a tooltip naming the node to unlock. `Unlock`
hands it back to the derivation.

A filter you insert and a value you lock are pinned to a **named point**
(`clip:7/after-scale`), never to a position, so they survive the rebuild. A node
you placed carries an id of its own, and a wire is written as the two pads it
joins — each named the same way, by anchor or by id — so hand-made structure
survives it too. They survive moving and trimming the clip; splitting a clip
copies the filters and the locks to both halves, because a cut should not change
how either half looks, and does *not* copy the wires, because an input pad holds
one wire and a copy of one would be a second producer arriving at a pad that
already has one. A clip trimmed out of the rendered range takes its nodes and
wires with it and brings them back; deleting the clip takes them for good.

They are remembered in two places, and the difference between them matters.
`localStorage` holds the **workspace** — one key, one machine, whatever was last
on the screen — and a [document](document.md) holds an **edit** somebody named
and saved. Both read the same data; what they disagree about is a node naming
one of your inputs, which only the document can bring back, because only the
document brings the inputs back with it. A graph restored from the workspace
drops those nodes on purpose: the ids would name whichever file happened to be
third that run.

`Ctrl`+`Z` reaches all of it, and this is the stage the absence was felt most
on — a wire is work in the way a slider position is not. A node placed, a wire
drawn, a pad cut and a value locked are each a step; see
[Undo](document.md#undo).

## What changes when there is one

A render with a filter of your own in it goes through **libavfilter** instead of
the internal compositor, and nothing has to be switched on for that: the spec
the application builds carries the graph, and `ffmpeg_export.cpp` picks its
`FrameSource` on whether that field is empty. The two paths are measured against
each other on every `ctest` run — the same edit rendered both ways, compared as
PSNR, 43 dB and holding — so this is a choice about what is *expressible*, not
about which is better.

One consequence worth knowing: the command bar stops calling its filtergraph a
translation, because on this path it is not one: those are the chains
libavfilter parses, all but the last.

## A filter in the viewer

The program monitor shows them. A clip with filters of its own plays them: its
`<video>` is pointed at the clip's input **with the clip's chain on it**, which
libav opens as one demuxer, one decoder and one filtergraph, and hands over as
frames. It is the same mechanism a `-f lavfi` input and a live capture pad
already reach the screen by; `src/native/playback_filter.h` is the whole of it.

What runs is the filters *you* put there, in the order the graph runs them —
the derivation's own `trim`, `crop`, `scale` and opacity are left out, because
the viewer already does every one of those with the playhead, the crop window,
the placement rectangle and a style. The conversions are not left out: a
`negate` spliced in after the derivation's `format=rgba` inverts red, green and
blue, and the same filter handed the decoder's yuv420p would invert luma and
chroma, so `format` is kept and `scale` is kept at the picture's own size with
its colour arguments untouched.

`enable=` comes on where it will come on in the render — and *where* in the
chain decides which clock that is, because the derivation's own `setpts` sits
between the two points a filter can be inserted at. A filter put in **after the
decode** sees the file's own timestamps; one put in **after the scale** sees the
moment the edit puts that frame at. That is what the render does, so the
playback chain carries the same `setpts`, written as the constant it comes to,
and the view takes the whole of it back off at the end so the playhead is still
counting the file. A clip laid down twelve seconds into the edit from three
seconds into its file plays `setpts=PTS+9/TB` in the middle of its chain.

**A filter that resizes the picture resizes the clip.** A `crop` or a `scale` put
on a clip does not only change its pixels — it changes how big that clip's
picture *is*, and the layout asks the chain what it produced before it asks the
file. So half the width in is half the width on the screen: the picture is fitted
in the shape the filter made it rather than stretched back to the shape the file
was. The render follows without being told, because there is one layout
implementation — the rectangle the monitor drew the clip in is the rectangle the
spec carries, and the derivation's own `scale` sizes the clip into it.

Two things it will not show, and both keep the `fx` badge rather than drawing
something nearly right:

| | |
|---|---|
| a **resize below the point where the clip is placed** | the derivation's `scale` is where a clip stops being its own size and becomes a rectangle on the canvas. The render lays whatever comes out below that node over the canvas *at its own size*, at the rectangle's top-left, which is not a rectangle the viewer has any way to place. Press `O` to see it: placing is what the render does. The badge says both sizes. |
| filters that are **not one run** | a fork, or a node wired in by hand from somewhere else. Playback is one stream through one chain, and half a graph shown as though it were all of it is worse than the badge. |

One chain is refused more than it has to be: a resize on the way *in* combined
with any filter of yours below the `scale`. The view reports one size for the
whole chain, so from that number there is no telling which of the two resized
it — and guessing wrong puts the picture in a rectangle the render never uses.

A chain libavfilter will not take is refused the same way, with libav's own
sentence on the picture — which means a mistyped filter argument is reported
when you type it rather than when you render.

Both of those refusals, and everything else this way of showing a filter cannot
reach — a filter over the whole canvas, a generator with no clip — are what
`O` is for: **[the output on the program monitor](playback.md#the-output-instead-of-the-clips)**
plays the render itself rather than one element per clip, so what it shows has
no such exceptions. This is the cheap way, exact for everything a clip does on
its own; that is the real render, and it costs a render.
