// Everything that is running, in one place.
//
// Four kinds of work run in this window at the same time and every one of them
// was visible only where it lived: a pull and a transcription on their own
// Recordings row, a cut as a line along the bottom of its card, the render as a
// percentage written into the button that started it — and a proxy nowhere at
// all. So "is anything still going?" was a question answered by walking the
// window, and answered wrongly whenever the thing still going was on the tab
// that was not showing. A download is minutes and a transcription is hours;
// closing the window on one is losing it.
//
// **This is a view and decides nothing.** `acquire.inFlight()` and
// `cuts.running()` each say what their own jobs are doing, in their own words,
// because each of them owns those states; the render is polled by `app.js`,
// which owns that poll, and arrives here through a hook. This file concatenates
// the three and draws them. A second table of state→sentence here is exactly the
// second home the rest of this repository is written to avoid.
//
// **A stop offered here is the same stop the row offers**, and every one of them
// is a call back into the file that owns the job — nothing here knows what
// stopping means. Where a job cannot be stopped there is no button and no
// explanation: `joining` and `resolving` are seconds to a minute, and a proxy
// asked for again on the next frame would make a stop a lie.

import { el, div, put } from '../ui/dom.js';
import * as acquire from './acquire.js';
import * as cuts from './cuts.js';

let nodes = null;
let hooks = null;

/// Whether the panel is showing. **Not remembered between sessions**: it is a
/// question about this minute — what is running *now* — and a panel that came
/// back open over an empty list would be chrome rather than an answer.
let open = false;

/// What was drawn last, so the frame loop can draw only when it changed. Same
/// discipline as `acquire.tick()`, one storey up: this list is rebuilt whole by
/// `put()` and a percentage moves every few seconds, not sixty times each.
let stamp = '';

/// Wired once. A second `initFlight` is a caller handing over another source of
/// jobs — which is what a suite does, having no render of its own to poll — and
/// a second listener on the one button would make every press two presses.
let wired = false;

export function initFlight(refs, h) {
    nodes = refs;
    hooks = h || {};
    if (wired) return;
    wired = true;
    nodes.button.addEventListener('click', () => toggle());
}

/// Every job running anywhere in this window, in the order they were started in
/// — getting, then reading, then cutting, then the render.
///
/// The order is by *kind* rather than by age on purpose: a pull and a
/// transcription are things somebody chose and is waiting for, and a proxy is
/// housekeeping. Sorting by age would put an hour of transcription underneath a
/// four-second proxy of a clip just dropped in.
export function jobs() {
    const out = [...acquire.inFlight(), ...cuts.running()];
    const rendering = hooks.render && hooks.render();
    if (rendering) out.push(rendering);
    return out;
}

/// How many. The header button is this number and nothing else.
export function count() { return jobs().length; }

export function isOpen() { return open; }

/// Show the list, or stop showing it.
export function toggle(on) {
    open = typeof on === 'boolean' ? on : !open;
    stamp = '';
    draw();
}

/// Draw if anything moved. From the frame loop.
export function tick() {
    const list = jobs();
    const now = `${open}|` + list.map((j) => `${j.key}:${j.note}`).join('|');
    if (now === stamp) return;
    stamp = now;
    draw(list);
}

function draw(list) {
    if (!nodes) return;
    const running = list || jobs();
    const n = running.length;

    // **The button is not permanent chrome.** With nothing running it says
    // nothing, because a control that reads `0 running` all day is a control the
    // eye learns to skip — and this one has to be noticed on the one afternoon
    // it says `3`.
    nodes.button.hidden = !n && !open;
    nodes.button.textContent = n ? `${n} running` : 'nothing running';
    nodes.button.classList.toggle('on', open);
    nodes.button.title = 'What is running';

    nodes.panel.hidden = !open;
    if (!open) return;

    put(nodes.panel, () => {
        if (!n) return [el('div', { cls: 'fl-empty dim', text: 'nothing running' })];
        return running.map((j) => {
            const kids = [
                el('span', { cls: 'kind', text: j.kind }),
                el('span', { cls: 'name', text: j.name }),
                el('span', { cls: 'note mono dim', text: j.note }),
            ];
            if (j.stop)
                kids.push(el('button', {
                    cls: 'tiny', text: 'Stop', title: 'Stop this',
                    on: { click: () => { j.stop(); stamp = ''; draw(); } },
                }));
            else
                // The width of the button that is not there, so that eight rows
                // of numbers line up as a column rather than as eight lengths.
                kids.push(el('span', { cls: 'fl-gap' }));
            kids.push(div('getbar', [
                el('div', { cls: 'fill',
                            style: { width: `${(j.progress || 0) * 100}%` } }),
            ]));
            return div('fl-row', kids);
        });
    });
}
