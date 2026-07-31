// UC09 — "Give me the full-size one for the archive and a small one for the
// web, out of the same edit."
//
// A house rule for anybody who delivers video: one master, one proxy, same cut.
// The application does this properly and for the right reason — two sizes cannot
// come out of one encoder, so it is two passes over the frames rather than a
// `tee` — and a version is built by recursing through the same `buildSpec()`
// that builds the render, so it is what the app *would* render at that size
// rather than the master scaled afterwards. That is a better answer than most
// tools give.
//
// What it costs is finding it. It is called `Also write`, it is a `· 0` fold in
// the destination band, and the word people arrive looking for is on the *other*
// control — `tee`, which is the one that cannot do this.
//
// Usage: ffmpeg-bro-headless ui/ tests/usecases/uc09_master_and_proxy.js -- <file>

import { journey, pump, press, type, f, q, exportAndWait, wrote, describe,
         freshWorkspace,
         openDocument } from './journey.js';

const A = globalThis.__ffmpegBro;
const MASTER = 'out/uc09-master.mp4';
const PROXY = 'out/uc09-proxy.mp4';

const J = journey({
    id: 'UC09',
    title: 'A master and a small proxy out of one edit',
    who: 'somebody who delivers a full-size file and a web-size file every time',
    wants: 'both files from one press, cut identically',
    shell: A.shell,
});

freshWorkspace(A);

J.step('open the recording', () => {
    openDocument(A, 'untouched');
});

J.step('go to Write and name the master', () => {
    A.shell.goTo('write');
    pump(400);
    type(f('path'), MASTER, 'the path field');
});

J.step('find "Also write · 0" and open it', {
    needs: ['versions'],
    hidden: 'a counted fold in the destination band, below Choose…',
    friction: '"Also write" is the name of the thing that does this. "Several ' +
              'destinations (tee)" is in the container picker and is the thing ' +
              'that cannot — it is one encode to several muxers, so it cannot ' +
              'change the size. Somebody looking for "two outputs" meets the ' +
              'wrong one first, because it is the one in the picker they were ' +
              'already using.',
}, () => {
    const fold = f('versions');
    assert(fold, 'there is no "Also write" control');
    fold.click();
    pump(300);
});

J.step('set the proxy size and where it goes', {
    needs: ['versions'],
}, () => {
    const w = f('ver-w-0');
    assert(w, 'the version has no width field');
    type(w, 320, 'the version width');
    type(f('ver-path-0'), PROXY, 'the version path');
});

J.step('press Export once', () => {
    const p = exportAndWait();
    assert(p.state === 'done', `the render ${p.state}: ${p.error || ''}`);
});

const master = wrote(MASTER);
const proxy = wrote(PROXY);
const widthOf = (pr) => {
    const v = pr && pr.streams.find((s) => s.kind === 'video');
    return v ? v.width : 0;
};

J.got('two files at two sizes from one press',
      !!master && !!proxy && widthOf(proxy) < widthOf(master),
      `master ${widthOf(master)}px (${describe(master)}), proxy ${widthOf(proxy)}px`);

// Credit where it is due: one side of the size is enough.
J.friction('giving only a width and letting the height follow the aspect is ' +
           'right — a proxy is "720 high" far more often than "1280 by 720" — ' +
           'and the panel states the size it worked out rather than leaving it ' +
           'to be discovered.');

J.shortfall('a name that says what it is',
            '"Also write" and "several destinations (tee)" are two answers to ' +
            '"I want two outputs" and the difference between them — one encode ' +
            'to several places, versus several encodes of one edit — is the ' +
            'whole of which one somebody needs. Both are on the Write stage and ' +
            'the wrong one is the more prominent.');

J.finish();
