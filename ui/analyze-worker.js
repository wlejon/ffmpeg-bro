// Reads a file twice more than the player does — once for every audio sample,
// once for a frame every few seconds — so the timeline can show what is inside
// it. Both are full-file decodes, which is why they happen here and not on the
// thread drawing the UI: a five-minute file is a third of a second of audio
// analysis and over a second of frame grabbing, and the player would sit
// frozen through all of it.
//
// bro.media is installed in worker realms for exactly this.

onmessage = (e) => {
    const job = e.data || {};
    const path = job.path;
    if (!path) return;

    // Audio first: it is the faster of the two and the more useful, so the
    // waveform appears while the frames are still being grabbed.
    try {
        const peaks = bro.media.peaks(path, { buckets: job.buckets || 2048 });
        postMessage({ token: job.token, kind: 'peaks', peaks });
    } catch (err) {
        postMessage({ token: job.token, kind: 'peaks', error: String(err && err.message || err) });
    }

    try {
        const thumbs = bro.media.thumbnails(path, {
            count: job.count || 32,
            height: job.height || 72,
        });
        postMessage({ token: job.token, kind: 'thumbs', thumbs });
    } catch (err) {
        postMessage({ token: job.token, kind: 'thumbs', error: String(err && err.message || err) });
    }
};
