// The output's soft subtitle tracks, over the picture, as the cues they are.
//
// A *soft* track is written beside the picture rather than into it: the cues
// travel as their own stream and the player draws them. That is the whole point
// of the burn-in control saying which you meant — a burned-in cue is part of the
// picture and a soft one is a stream somebody can switch off — and it is also
// why the viewer had nothing to show for one. bro's `<video>` decodes pictures
// and sound; a stream a player can switch off is neither, and it stays neither.
//
// **What this draws is the cue text and never an imitation of its appearance.**
// A soft track is styled by whatever player opens the file: the font, the size,
// the position, the outline and the margin are that player's, and an ASS track
// carries a `[V4+ Styles]` block that libass reads and a `mov_text` track in a
// phone's player does not. This application cannot know which player, so any
// styled preview would be a claim nobody is in a position to make. Unstyled
// text, bottom-centre, with the interface saying plainly that this is what the
// cues *say* and not how they will *look*, is a claim that is true. That is the
// rule the sound marks shipped under — a label never claims more than was
// measured — applied to a picture instead of a number.
//
// `cueTextOf`'s split is what makes it possible to keep that promise honestly:
// `text` is the words with the override codes taken out, `raw` is the dialogue
// line as the decoder handed it over and `header` is the script's styles. This
// draws `text`. Drawing `raw` would put `{\pos(120,400)}` on the screen as
// characters, and interpreting it would be the imitation.
//
// **It can be turned off, and that is not a convenience.** A soft track is
// precisely the thing a player can turn off — so an overlay that can be turned
// off is a *faithful* preview of one and an overlay that cannot is not. The
// switch is the feature, in the way that `O` showing the render instead of the
// clips is the feature.
//
// **There is no rectangle worked out here.** The cues go over the whole output
// picture, because that is where a player puts them and there is no clip they
// belong to — so the layer is a child of `#stage`, which *is* the canvas, and
// the DOM gives it the rectangle for nothing. `ui/viewer.js` `placement()` is
// the one home for where a *clip* goes and it is not asked, for the same reason
// `output.place()` does not ask it: a thing that is the whole canvas has no
// placement to work out. A second rectangle computed beside `placement()` is
// exactly what that rule exists to prevent, and the way to obey it here is to
// compute none.
//
// **Both kinds of row, one path.** A row on the Write stage reads its cues as
// a copy (`copy:0:2`) or a conversion (`decode:1:0`), and this draws both.
// Either reads a file, on that file's clock — and the map between the two clocks is not
// restated here: `cueWindow()` in ui/export/subtitles.js is where the rule lives
// (a conversion's zero is the in-point exactly, a copy's is the stamp of the cue
// it begins on), and the output's zero is where the render range begins. So a
// cue's timeline moment is `range().start + (cue.start - cueWindow().zero)` and
// nothing here has an opinion about which of those two zeroes applies.
//
// **A track of pictures gets a marker and not a picture.** `dvdsub` and
// `hdmv_pgs_subtitle` carry bitmaps of characters, so there is nothing in one to
// draw as text — `cueText` says so by name rather than answering an empty list,
// and `cueTimes` still says when one is on screen. A line saying that a picture
// cue is there is true and useful; a blank overlay would read as a track that
// failed. Drawing the actual rects is a different piece of work and is in
// docs/manual/not-yet.md as one.

import { settings } from './export/state.js';
import { range } from './export/spec.js';
import { cuesFor, cueTextFor, cueWindow, cueSaying } from './export/subtitles.js';
import { el } from './dom.js';

/// What the note says while the overlay is on and there is something to draw.
///
/// One string, here, because it is the promise this whole module is keeping and
/// a second wording of it — on the button, in the manual, in a warning — would
/// be a second promise to drift from. The button's title and
/// `ui/export/warnings.js` both say the same thing in their own voice and both
/// point back at this behaviour rather than describing it again.
const NOTE = 'the cues as they read — a soft track is styled by whatever player ' +
             'opens the file, so this is what they say and not how they will look';

/// And when there is nothing. An empty overlay is indistinguishable from a
/// broken one, which is the failure this sentence exists to prevent.
const NOTHING = 'no soft subtitle track in this output — a subtitle stream on the ' +
                'Write stage is what puts one there';

let layer = null;       // the lines, over the canvas
let note = null;        // what they are, and what they are not
let on = false;
let last = '';          // the drawing on the screen, so a frame that changed nothing writes nothing

/// The two elements and where they live. Called once, from ui/app.js.
export function initSoftCues(refs) {
    layer = (refs && refs.layer) || null;
    note = (refs && refs.note) || null;
}

export function isOn() { return on; }

/// Show the soft tracks, or stop. Returns true when the mode changed, which is
/// the caller's cue to redraw the button.
export function setOn(value) {
    const next = !!value;
    if (next === on) return false;
    on = next;
    // Forget what was drawn: turning the overlay off empties the layer, and a
    // remembered drawing would leave the next turning-on believing the same
    // lines were still there.
    last = '';
    return true;
}

/// What is on screen at timeline second `t` — `{ lines, why }`.
///
/// `lines` is `[{ kind, text }]` with `kind` one of `'text'` (what a cue says)
/// and `'picture'` (a bitmap cue is there and cannot be drawn). `why` is the
/// sentence for an overlay with nothing to show, or '' when there is a track.
///
/// Exported because it is the whole of the decision and a test should be able to
/// ask it a time rather than read pixels off a stage — `tests/ui_subtitles.js`
/// does exactly that.
export function showingAt(t) {
    const rows = (settings.streams || []).filter((s) => s && s.kind === 'subtitle');
    if (!rows.length) return { lines: [], why: NOTHING };
    const r = range();
    const lines = [];
    for (const row of rows) {
        readLines(lines, row, t, r);
    }
    return { lines, why: '' };
}

/// A row reading a file — carried or converted, and the difference is entirely
/// `cueWindow`'s to state.
///
/// Two calls and both are cached against the input's opening key, so this costs
/// a Map lookup per frame after the first. The first is a read of the file and,
/// for the words, a decoder opened and closed again — which is why the overlay
/// is a mode somebody turns on rather than something running behind it.
function readLines(lines, row, t, r) {
    const list = cuesFor(row);
    if (!list || !list.cues || !list.cues.length) return;
    const w = cueWindow(row, list);
    const words = cueTextFor(row);
    // `textSub: false` is the bitmap answer and is a different thing from a
    // track with no cues in it — see `bro.ffmpeg.cueText` in docs/api.md.
    const pictures = !!(words && words.textSub === false);
    const to = r.end > r.start ? r.end : Infinity;
    for (let i = 0; i < w.kept.length; i++) {
        const c = w.kept[i];
        const at = r.start + (c.start - w.zero);
        // **`end === start` means the packets did not say**, which is not the
        // same as "no time at all" — `cueTimes` documents that difference and
        // this is the one place that has to do something about it. A player
        // holds such a cue until the next one begins, because there is nothing
        // else it could do, and so does this. The sentence under the overlay is
        // what stops that reading as a measurement.
        const next = i + 1 < w.kept.length ? r.start + (w.kept[i + 1].start - w.zero)
                                           : Infinity;
        const ends = c.end > c.start ? r.start + (c.end - w.zero) : next;
        const until = Math.min(ends, to);
        if (t < at - 1e-6 || t >= until - 1e-6) continue;
        if (pictures) {
            lines.push({ kind: 'picture',
                         text: `a ${words.codec} cue is on screen — a picture of ` +
                               'characters, which has no text to show' });
            continue;
        }
        // Joined by *when*, which is `cueSaying`'s whole reason: the two lists
        // are two answers about one set of packets and an mp4 writes an empty
        // sample between its cues, so an index shared between them would be off
        // by however many of those there have been.
        const said = cueSaying(words, c.start);
        if (said) lines.push({ kind: 'text', text: said });
    }
}

/// Draw. Called once a frame from ui/app.js's frame loop.
///
/// The drawing is compared as a string before anything is written, because the
/// answer changes a few times a minute and the loop runs sixty times a second —
/// and a subtitle re-created every frame is an element the renderer re-lays-out
/// every frame for a line that has not moved.
export function tick(t) {
    if (!layer || !note) return;
    const show = on ? showingAt(t) : { lines: [], why: '' };
    // The kind is in the key as well as the words: a bitmap marker and a cue
    // saying the same thing are two different statements and must not be able
    // to compare equal.
    const key = show.lines.map((l) => `${l.kind} ${l.text}`).join('\n') +
                '' + show.why;
    if (key === last) return;
    last = key;

    layer.textContent = '';
    for (const l of show.lines)
        layer.appendChild(el('div', { cls: l.kind === 'picture' ? 'cueline pic' : 'cueline',
                                      text: l.text }));
    layer.classList.toggle('hidden', !show.lines.length);

    // On a chip of its own rather than as bare text: this is the sentence that
    // stops the words above being read as an appearance, so it has to be legible
    // over whatever picture it lands on, and dim grey on a bright frame is not.
    note.textContent = '';
    if (on) note.appendChild(el('div', { cls: 'cuenote-say', text: show.why || NOTE }));
    note.classList.toggle('hidden', !on);
}
