// Playing a node, rather than looking at one.
//
// A still of a pad answers "is the crop right". It does not answer "does this
// hold up over a shot", which is the question a filter is usually being judged
// on and the reason the picture in a card is a couple of seconds on a loop
// rather than one frame. Pressing play is that same question asked of the whole
// range: the graph runs forward from where the previews were taken to the end of
// what would be written, and the card shows it as it arrives.
//
// **The renderer is the bottleneck, and this says so out loud.** Every second of
// picture on this stage is a real render through libavfilter — there is no
// preview-only path anywhere in the application — so a graph with an expensive
// filter in it *cannot* be played at speed, and the only question is what to do
// about that. Dropping frames silently would make a slow filter look fast and a
// broken one look intermittent. Rendering something cheaper would mean showing a
// picture the render will not produce, which is the one thing this stage must
// never do. So: the range is cut into pieces, each piece is rendered ahead of
// the picture, and each piece plays at its own rate. When the renderer keeps up
// that is real time. When it does not the picture waits, and the readout says
// what rate is actually being sustained — a readout saying 0.4× is a fact about
// your filter, where a smooth picture that had quietly skipped nine frames in
// ten would be a lie about it.
//
// **Nothing here renders anything.** This is the bookkeeping — which piece is on
// screen, which is worth asking for next, how far behind real time the whole
// thing is running — and `preview.js`, which owns the one render slot the host
// has, asks it what to do. Splitting it that way is what keeps the slot in one
// place: a second module starting renders of its own would race the stills for
// it, be refused, and have no way of knowing why.
//
// One node plays at a time, for the same reason. Nine cards playing at once is
// nine renders at once against one slot, which is not nine ninths of the speed —
// it is one of them playing and eight of them stuttering.
//
// **Scrubbing is free where the piece is in hand and a render where it is not,
// and the bar says which.** A playback is already a list of pieces covering the
// range, made on demand and *kept* — so moving the picture is choosing a piece
// and a moment inside it, which for anything already rendered costs a
// `currentTime` write and nothing else. Going back is therefore instant, which
// is the half of scrubbing that matters when a filter is being judged: the thing
// you need to see twice is the thing you just saw. Forward into unrendered
// seconds costs exactly what playing into them costs, and the bar draws how far
// the ready run extends so that the difference is visible before it is felt.
//
// Nothing is thrown away on a seek. A piece the renderer is halfway through
// still belongs to this playback — `holds()` answers on membership, not on
// position — so it lands, is kept, and is there if the picture comes back past
// it. The only thing a seek resets is the **rate measurement**, because a rate
// is output seconds per wall second *of playback* and the seconds spent
// deciding where to look are not playback. `mark` is where the current
// measurement started; without it, jumping four minutes in would read as four
// minutes rendered in an instant.

/// How far in front of the picture to render. Two pieces is enough to cover the
/// gap between one finishing and the next being wanted while still giving up
/// quickly when the graph changes; more only means more work thrown away.
const AHEAD = 2;

let s = null;

/// The node being played, or null. The view asks every frame, so this has to be
/// the cheapest question in the file.
export function playingKey() { return s ? s.key : null; }

export function isPlaying(key) { return !!s && !!key && s.key === key; }

/// Begin. `seconds` is how much of the timeline one rendered piece covers, which
/// is the still preview's own window length — so when the two agree, the still
/// already on the card *is* the first piece and playback starts on the frame the
/// button was pressed rather than after a render.
export function start(key, from, until, seconds, seed) {
    stop();
    const len = Math.max(0.25, Number(seconds) || 2);
    if (!(until > from + 1e-3)) return false;
    s = { key, from, until, len, segs: [], at: 0, pos: 0,
          mark: from, into: null, wall: Date.now(), done: false };
    const first = ensure(0);
    if (first && seed && seed.path && Math.abs(seed.seconds - (first.to - first.from)) < 1e-6) {
        first.state = 'ready';
        first.path = seed.path;
    }
    return true;
}

export function stop() { s = null; }

/// The pieces, made as they are needed rather than up front: a ten-minute range
/// at two seconds a piece is three hundred records, all but four of which would
/// describe work nobody is going to wait for.
function ensure(i) {
    if (!s || i < 0) return null;
    for (let k = s.segs.length; k <= i; k++) {
        const a = s.from + k * s.len;
        if (a >= s.until - 1e-3) return null;
        s.segs.push({ i: k, from: a, to: Math.min(s.until, a + s.len),
                      state: 'pending', path: '', reason: '' });
    }
    return s.segs[i] || null;
}

/// What is worth rendering next, or null when everything within reach is either
/// in hand or already going. Asked by `preview.js` before it picks a still,
/// because a picture you are watching outranks a picture you might look at.
export function want() {
    if (!s) return null;
    for (let i = s.at; i <= s.at + AHEAD; i++) {
        const seg = ensure(i);
        if (!seg) return null;
        if (seg.state === 'pending') return seg;
    }
    return null;
}

/// Claimed by the renderer. A state of its own rather than a flag, so that a
/// piece being worked on can never be handed out twice.
export function began(seg) { if (seg) seg.state = 'rendering'; }

export function finished(seg, path) {
    if (!seg) return;
    seg.state = 'ready';
    seg.path = path;
}

export function failed(seg, reason) {
    if (!seg) return;
    seg.state = 'failed';
    seg.reason = reason || 'render failed';
}

/// Whether a piece still belongs to the playback that asked for it. A render
/// takes seconds and the button can be pressed again in that time; writing a
/// piece of the last run into this one would show the wrong seconds of the
/// timeline with nothing on screen saying so.
export function holds(seg) { return !!s && s.segs.indexOf(seg) >= 0; }

export function current() { return s ? s.segs[s.at] || null : null; }

export function next() { return s ? s.segs[s.at + 1] || null : null; }

/// Where the picture is inside the piece on screen, told to us by the view —
/// which is the only thing holding the `<video>`. Feeding the rate from the
/// element's own clock rather than from a timer is what makes a stall count
/// against it: a video that is not advancing is not playing, whatever the wall
/// clock thinks.
export function report(pos) {
    if (!s) return;
    const seg = s.segs[s.at];
    if (!seg) return;
    s.pos = Math.max(0, Math.min(Number(pos) || 0, seg.to - seg.from));
}

/// The piece on screen has run out. Moves on whether or not the next one is
/// ready: the view holds the last frame while it is not, and `want()` is already
/// pointed at it.
export function advance() {
    if (!s) return 'idle';
    s.pos = 0;
    const following = ensure(s.at + 1);
    if (!following) { s.done = true; return 'ended'; }
    s.at += 1;
    return following.state === 'ready' ? 'moved' : 'waiting';
}

/// Put the picture at `t` seconds of the timeline. False for a `t` there is no
/// piece for, which is a range shorter than one piece and nothing else.
///
/// **A piece and a moment inside it**, which is what makes this cheap: the piece
/// is `ensure`d rather than rendered here — `want()` will ask for it on the next
/// frame if it is new — and the moment is handed to the view as `into`, because
/// the element is the only thing that can be told where to be and the view is
/// the only thing holding one. Where the piece is already in hand this is the
/// whole cost of a seek.
export function seek(t) {
    if (!s) return false;
    const want = Math.max(s.from, Math.min(Number(t) || 0, s.until - 1e-3));
    const i = Math.max(0, Math.floor((want - s.from) / s.len));
    const seg = ensure(i);
    if (!seg) return false;
    s.at = i;
    s.pos = Math.max(0, Math.min(want - seg.from, seg.to - seg.from));
    s.into = s.pos;
    // A playback that had run off the end is running again, at wherever this is.
    s.done = false;
    // The rate starts over from here. See the note at the top of the file: the
    // seconds spent deciding where to look are not playback.
    s.mark = seg.from + s.pos;
    s.wall = Date.now();
    return true;
}

/// Where inside the piece on screen the picture has been *asked* to be, or null.
///
/// Read and then cleared by the view, which is the one thing holding the
/// `<video>`. Null rather than the current position, so that the view can tell a
/// request apart from the ordinary state of playing — writing `currentTime`
/// every frame would stop the picture dead.
export function requested() {
    return s && s.into !== null && s.into !== undefined ? s.into : null;
}

export function granted() { if (s) s.into = null; }

/// How far the picture can go without waiting for a render: the end of the
/// unbroken run of ready pieces from the one on screen.
///
/// **The run and not the count.** Two ready pieces with a pending one between
/// them is one second of buffer, not two, and a bar drawn off the total would
/// promise seconds that are going to stall.
export function readyUntil() {
    if (!s) return 0;
    let end = s.segs[s.at] ? s.segs[s.at].from : s.from;
    for (let i = s.at; i < s.segs.length; i++) {
        if (s.segs[i].state !== 'ready') break;
        end = s.segs[i].to;
    }
    return end;
}

/// What to say about it. `rate` is output seconds shown per second of wall
/// clock, measured from the moment play was pressed — or from the last seek, see
/// the note at the top — and including every wait, which is the number somebody
/// deciding whether a filter is affordable actually wants, rather than the
/// renderer's throughput with the stalls taken out.
///
/// `at` is worked out from the piece on screen rather than accumulated, so that
/// it is right after a seek without a second place having to be told about one.
export function stats() {
    if (!s) return null;
    const wall = Math.max(0.001, (Date.now() - s.wall) / 1000);
    const cur = s.segs[s.at] || null;
    const at = (cur ? cur.from : s.from) + s.pos;
    return {
        key: s.key,
        at,
        from: s.from,
        until: s.until,
        ready: readyUntil(),
        played: at - s.from,
        wall,
        rate: Math.max(0, at - s.mark) / wall,
        // Under a second there is nothing to average and every graph looks slow,
        // because the first piece is a render nobody has waited for yet.
        settled: wall > 1.5,
        done: s.done,
        waiting: !!cur && cur.state !== 'ready' && cur.state !== 'failed',
        failed: cur && cur.state === 'failed' ? cur.reason : '',
    };
}
