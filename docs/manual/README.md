# The manual

Everything the application does, stage by stage, in detail — the behaviour half
of the documentation. The repository's README is the short version; this is all
of it. The JS surface that scripts and tests drive is documented separately in
[api.md](../api.md).

**One part per section, and the order is the order of the pipeline.** It was one
file until it was three thousand lines, which is long past the point where a
reader has to scroll to find out whether the thing they want is in here at all.
Nothing was cut in the splitting and nothing was reordered; what changed is that
everything from *Copying instead of encoding* onwards has its own heading now
instead of sitting under **Subtitles**, where it had quietly ended up and where
no reader looking for the command bar would have gone.

- **[How playback works](playback.md)** — what happens between the file and the
  screen, why there is no proxy transcode, and the render itself on the monitor
  instead of the clips
- **[The document](document.md)** — the whole chain as one file, and the only
  part here that is not a stage
- **[Capture](capture.md)** — screens, cameras and microphones; what a live
  session is and what a recording is
- **[Sources](sources.md)** — an input, its streams, the demuxer options that
  decide how it is read, and reading what a data track carries
- **[Finding the material](find.md)** — searching a corpus of transcripts for a
  word or for a stretch of talking, and putting what it finds on the timeline
- **[The timeline](timeline.md)** — clips, tracks, the sync lock, the When lane, and the edits that are about a cut rather than a clip
- **[The picture](picture.md)** — fit, scale, position, crop and the grid
- **[The graph](graph.md)** — the node graph, which is `-filter_complex` with
  somewhere to stand
- **[Output](output.md)** — the Encode and Write stages: encoders, containers,
  where the file goes and how many files there are
- **[Subtitles](subtitles.md)** — the three different things people mean by the
  word, each a different mechanism, and cues of your own
- **[Rendering](rendering.md)** — the packet path, the printed command, the
  report, and what a render costs
- **[The card](card.md)** — hardware decode and encode, with the measurements
- **[Keyboard](keyboard.md)** — every key
- **[Testing](testing.md)** — every suite, what each is about, and how to run
  one on its own
- **[Not yet](not-yet.md)** — an honest inventory of what this does not do

Beside the manual sits **[Use cases](../usecases/README.md)** — twelve ordinary
jobs driven end to end by scripts that record what each one cost, and the work
list that fell out of them.

And **[tools/](../../tools/README.md)** — jobs that drive this same application
through its scripting surface rather than being part of it, the largest being a
searchable corpus of a channel's broadcasts.
