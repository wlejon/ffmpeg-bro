// Filling in what a clip looks and sounds like.
//
// bro.media decodes the whole file twice more than the player does — every
// audio sample for the envelope, a frame every few seconds for the strip — so
// it runs in a worker and the lanes fill in as the answers arrive. One worker,
// one queue: adding a second clip while the first is still being read waits
// its turn rather than fighting it for the disk.

import { project, changed, hasPicture } from './project.js';

let worker = null;
let queued = 0;

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('analyze-worker.js');
    worker.onmessage = (e) => receive(e.data);
    return worker;
}

function receive(msg) {
    if (!msg) return;
    const clip = project.clips.find((c) => c.id === msg.clip);
    if (msg.done) queued = Math.max(0, queued - 1);
    // A clip that was deleted while its analysis was running: the result has
    // nowhere to go, which is fine — it cost nothing extra to let it finish.
    if (!clip) return;
    if (msg.error) { console.log(`analysis (${msg.kind}) ${clip.name}: ${msg.error}`); return; }

    if (msg.kind === 'peaks') {
        clip.peaks = msg.peaks;
        changed('analysis');
    } else if (msg.kind === 'thumbs' && msg.thumbs) {
        const t = msg.thumbs;
        const img = new ImageData(new Uint8ClampedArray(t.data.buffer || t.data),
                                  t.width * t.count, t.height);
        createImageBitmap(img).then((bitmap) => {
            // times are seconds into the file, which is what lets the strip be
            // placed by time rather than in even slots — the only thing that
            // stays honest once the timeline can zoom.
            clip.film = {
                bitmap, width: t.width, height: t.height,
                count: t.count, times: t.times,
            };
            changed('analysis');
        });
    }
}

/// Read a clip. Thumbnail count is a property of the file, not of the current
/// zoom: re-grabbing on every zoom step would decode the file again for each
/// notch. One per two seconds, within sane bounds, is dense enough that the
/// strip still reads when zoomed in and cheap enough on a long file.
export function analyzeClip(clip) {
    const count = Math.max(8, Math.min(120, Math.round(clip.length / 2)));
    queued++;
    ensureWorker().postMessage({
        clip: clip.id,
        // The input's token rather than its path, so a filmstrip is of the file
        // as the input opens it — `bro.media` goes through the same backend
        // registry `<video>` does, and resolves a token the same way.
        path: clip.src || clip.path,
        buckets: Math.max(600, Math.min(6000, Math.round(clip.length * 12))),
        // A file with no picture in it has no filmstrip, and asking for one is
        // a whole-file decode that ends in an error. The worker already keeps
        // the two halves apart so a failed strip cannot take the waveform down
        // with it — this is about not spending the decode at all, and about
        // not putting a line in the log for something that was never wrong.
        count: hasPicture(clip) ? count : 0,
        height: 96,
    });
}

/// How many clips are still being read, for the status line.
export function pending() { return queued; }
