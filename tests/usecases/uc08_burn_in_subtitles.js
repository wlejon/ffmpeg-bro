// UC08 — "Put the subtitles on the video so they show up on Instagram."
//
// The word "subtitle" means three different things and this application is one
// of the very few that is honest about it: a **soft track** the player draws, a
// **burn-in** that paints characters into the picture, and a **bitmap track**
// whose cues are already pictures. Only the second survives a social platform,
// and only the second is what "put the subtitles on the video" means.
//
// The good news is that the app has a control that does exactly this and puts it
// where the file is — `Burn in` on the subtitle input's card. What it costs is
// knowing that the answer is on the *Sources* stage, on the card of the file you
// added, when the thing you want to change is the picture.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc08_burn_in_subtitles.js
//            -- <video> <cues.srt>

import { journey, pump, press, type, f, q, qq, exportAndWait, wrote, describe,
         freshWorkspace } from './journey.js';

const args = (globalThis.scriptArgs || []).filter((a) => a !== '--');
const media = args[0];
const cues = args[1];
assert(media && cues, 'pass a video and a .srt: ... uc08_burn_in_subtitles.js -- <v> <srt>');

const A = globalThis.__ffmpegBro;
const OUT = 'out/uc08-burned.mp4';

const J = journey({
    id: 'UC08',
    title: 'Burn subtitles into the picture',
    who: 'somebody posting a clip where nobody turns the sound on',
    wants: 'the words visible in the video itself, on any player, with no track ' +
           'to switch on',
    shell: A.shell,
});

freshWorkspace(A);

J.step('drop the video on the window', () => {
    dropFiles(400, 300, [media]);
    pump(1800);
    assert(A.project.clips.length === 1, 'the video did not become a clip');
});

// **The natural gesture does nothing, silently.** Dropping a `.srt` on the
// window is what anybody would try first, and it adds no input, lays out no
// clip, and says nothing at all. Verified rather than asserted: the count before
// and after is the same.
let droppedSrtDidAnything = false;
J.step('drop the .srt on the window the same way', {
    friction: 'nothing happens. No input, no clip, no message, no refusal — ' +
              'the same window that accepts a video ignores a subtitle file ' +
              'without saying it has.',
}, () => {
    const before = A.inputs.inputs.length;
    dropFiles(400, 300, [cues]);
    pump(1800);
    droppedSrtDidAnything = A.inputs.inputs.length > before;
});

// So it has to be added the other way: the Sources stage has a path field and an
// Add button, and that route works and probes the file properly.
J.step('go to Sources and add the file by typing its path', {
    friction: 'the route that works is a text field and an Add button on the ' +
              'Sources stage — which is a fine control and is not the one ' +
              'anybody reaches for after dragging a file onto a window.',
}, () => {
    A.shell.goTo('sources');
    pump(400);
    type(document.getElementById('src-path'), cues, 'the Sources path field');
    press('#src-add', 'the Add button');
    pump(600);
    assert(A.inputs.inputs.length >= 2,
           `expected two inputs, got ${A.inputs.inputs.length}`);
});

J.step('select the subtitle input\'s card', () => {
    const sub = A.inputs.inputs.find((i) => A.inputs.kindOf(i) === 'subtitles');
    assert(sub, 'the cue file is not among the inputs');
    const card = q(`[data-input="${sub.id}"]`);
    assert(card, 'the cue file has no card');
    card.click();
    pump(300);
});

// **The right control, in a place nobody would look for it.** "Make the words
// appear on the picture" is a thing you do to the *picture*; the control is on
// the card of the *file*, on the stage about reading files.
J.step('press "Burn in" on the card', {
    needs: ['filterGraph'],
    hidden: 'on the subtitle input\'s card, on the Sources stage',
    friction: 'the control is on the file\'s card rather than anywhere the ' +
              'picture is. Compose is where the picture is arranged and Graph ' +
              'is where filters live; this is on neither, and pressing it moves ' +
              'you to Graph, which is the first time the person learns a filter ' +
              'graph is involved at all.',
}, () => {
    const burn = f('srcburn');
    assert(burn, 'the subtitle input does not offer to burn itself in');
    burn.click();
    pump(600);
});

J.step('land on the Graph stage, where a node has appeared', {
    needs: ['filterGraph'],
    friction: 'the press succeeded and moved the stage. What is now on screen ' +
              'is a node graph — correct, and a lot to be shown in exchange for ' +
              'pressing one button labelled "Burn in".',
}, () => {
    const inserted = A.graph.overlay.inserts().filter((r) => r.filter === 'subtitles');
    assert(inserted.length === 1, `expected one subtitles filter, got ${inserted.length}`);
});

J.step('go to Write, name the file and Export', () => {
    A.shell.goTo('write');
    pump(400);
    type(f('path'), OUT, 'the path field');
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const out = wrote(OUT);
const noSubtitleTrack = !!out && !out.streams.some((s) => s.kind === 'subtitle');

J.got('a video with the words painted into the picture and no subtitle track',
      !!out && !!out.video && noSubtitleTrack, describe(out));

J.friction('the three meanings of "subtitle" are genuinely distinguished here, ' +
           'which almost nothing else does — a soft track, a burn-in and a ' +
           'bitmap track are three mechanisms and the app never pretends they ' +
           'are one setting.');

if (!droppedSrtDidAnything)
    J.shortfall('anything at all from dropping the subtitle file on the window',
                'the gesture that opens a video ignores a .srt completely — no ' +
                'input, no clip, no refusal, no message. It is the first thing ' +
                'anybody tries and it fails in the one way a UI must never fail, ' +
                'which is silently. The file is perfectly readable: added through ' +
                'the Sources path field it probes, is recognised as subtitles ' +
                'from what libavformat found rather than from its name, and ' +
                'works.');

J.shortfall('the choice between them offered where the question is asked',
            'the person knows one thing: whether the words have to survive being ' +
            're-uploaded. That question is never put. Instead there is + Subtitle ' +
            'on the Write stage (soft) and Burn in on the Sources stage ' +
            '(painted), in different places, and which one they needed is ' +
            'discovered by getting it wrong.');

J.finish();
