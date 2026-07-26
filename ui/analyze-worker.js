// Reads a file twice more than the player does — once for every audio sample,
// once for a frame every few seconds — so the timeline can show what is inside
// it. Both are full-file decodes, which is why they happen here and not on the
// thread drawing the UI: a five-minute file is a third of a second of audio
// analysis and over a second of frame grabbing, and the player would sit
// frozen through all of it.
//
// bro.media is installed in worker realms for exactly this.
//
// Jobs arrive one per clip and are handled in order. Each reply carries the
// clip id back, because by the time it lands the timeline may have moved on.

onmessage = (e) => {
    const job = e.data || {};
    if (!job.path) return;
    const id = job.clip;

    // Audio first: it is the faster of the two and the more useful, so the
    // waveform appears while the frames are still being grabbed.
    try {
        const peaks = bro.media.peaks(job.path, { buckets: job.buckets || 2048 });
        postMessage({ clip: id, kind: 'peaks', peaks });
    } catch (err) {
        postMessage({ clip: id, kind: 'peaks', error: String(err && err.message || err) });
    }

    try {
        const thumbs = bro.media.thumbnails(job.path, {
            count: job.count || 32,
            height: job.height || 72,
        });
        postMessage({ clip: id, kind: 'thumbs', thumbs, done: true });
    } catch (err) {
        postMessage({ clip: id, kind: 'thumbs', done: true,
                      error: String(err && err.message || err) });
    }
};
