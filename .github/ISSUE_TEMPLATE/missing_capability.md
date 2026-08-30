---
name: Something ffmpeg can do that this cannot
about: ffmpeg performs it from a command line and this application has no way to ask for it
labels: enhancement
---

**The ffmpeg command that does it today:**

```
```

**Where it belongs in the pipeline.** The navigation is ffmpeg's own model:
Capture, Sources, Compose, Graph, Encode, Write. Which of those would you have
gone looking for it on?

**What you are actually trying to produce** (the file, the stream, the result,
not the flag): a real job is worth more than a feature name, because it usually
turns out there are two ways to ask for it and one of them fits the model here.

**Is it already listed?** [docs/manual/not-yet.md](../../docs/manual/not-yet.md)
is the honest list of what does not work yet. If it is there, say so and add
what you need from it, rather than opening a duplicate.
