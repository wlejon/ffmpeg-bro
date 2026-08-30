---
name: Bug report
about: something in the application is wrong, refuses, crashes, or writes the wrong file
labels: bug
---

**What you did** (which stage, which controls, in order):

**What you expected, and what happened instead:**

**The command bar's line.** Every stage prints the real ffmpeg invocation for
what you built. Paste it, and say whether running that line in a shell does the
same thing:

```
```

(If it does, the bug is in what this application asked ffmpeg for. If it does
not, the bug is in how this application runs it. That one answer usually halves
the search.)

**The Report stage (`R`)**, if a render was involved: what libav said, and what
any filter measured.

```
```

**The file, if a specific one is involved.** `ffprobe` on it, or a screenshot of
the Sources stage (`I`) showing its streams:

```
```

**Environment:**
- ffmpeg-bro version (nightly date, or `git rev-parse --short HEAD`):
- OS:
- GPU and driver, if hardware encoding or decoding is involved:
