// Reads a file so the timeline can show what is inside it: the sound as an
// envelope, the picture as a strip of frames. Both are decodes, which is why
// they happen here and not on the thread drawing the UI — a five-minute file is
// a third of a second of audio analysis and over a second of frame grabbing,
// and the player would sit frozen through all of it.
//
// bro.media is installed in worker realms for exactly this.
//
// **One job is one half of one span**, rather than one job being a whole clip.
// A clip read over a link is read a window at a time and the two halves are not
// the same size of job — the strip of a six-hour recording is twenty-four seeks
// and six seconds, the envelope of the same six hours is sixteen minutes of
// continuous decoding — so pairing them would make the cheap half wait for the
// expensive one every time. `ui/analysis.js` decides what to ask for; this
// answers exactly what was asked.
//
// Every reply carries the clip id, the half, the span and the token back,
// because by the time it lands the timeline may have moved on and the answer
// may be about a source the clip no longer reads.

onmessage = (e) => {
    const job = e.data || {};
    const reply = {
        clip: job.clip, half: job.half, token: job.token,
        from: job.from || 0, to: job.to || 0, n: job.n || 0, done: true,
    };
    if (!job.path) { reply.error = 'nothing to read'; postMessage(reply); return; }

    // `to` of zero is the whole file, which is what bro.media takes it to mean
    // as well — so the whole-file case is not a branch here, it is the absence
    // of two numbers.
    const opts = { from: job.from || 0, to: job.to || 0 };

    try {
        if (job.half === 'sound') {
            opts.buckets = job.n || 2048;
            reply.peaks = bro.media.peaks(job.path, opts);
        } else {
            opts.count = job.n || 24;
            opts.height = job.height || 96;
            reply.thumbs = bro.media.thumbnails(job.path, opts);
        }
    } catch (err) {
        reply.error = String((err && err.message) || err);
    }
    postMessage(reply);
};
