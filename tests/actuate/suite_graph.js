import {
    pump,
    waitFor,
    el,
    click,
    type,
    pressKey,
    KEYS,
    dropOn
} from './index.js';

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log((cond ? 'PASS: ' : 'FAIL: ') + what);
    globalThis.assert(cond, what);
}

waitFor('app ready', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
pump(60);

dropOn('#dropzone', ['build/fixtures/landscape.mp4']);
waitFor('clip loaded', () => A.project.clips.length > 0);
pump(60);

const graphBtn = el('#spine').querySelector('[data-stage="graph"]');
ok(graphBtn !== null, 'found spine button for graph');
click(graphBtn);
pump(60);

ok(A.shell.currentStage() === 'graph', 'active stage is graph');
const stageGraph = el('#st-graph');
ok(stageGraph !== null, 'found #st-graph element');
ok(!stageGraph.classList.contains('hidden'), '#st-graph is visible');

const initialPlacement = A.graph.placement();
ok(initialPlacement !== null, 'graph placement available');
const initialZoom = initialPlacement ? initialPlacement.zoom : 1;

click('#gr-zoom-in');
pump(40);
const zoomInPlacement = A.graph.placement();
const zoomInVal = zoomInPlacement ? zoomInPlacement.zoom : initialZoom;
ok(zoomInVal > initialZoom, 'zoom increases on #gr-zoom-in');

click('#gr-zoom-out');
pump(40);
const zoomOutPlacement = A.graph.placement();
const zoomOutVal = zoomOutPlacement ? zoomOutPlacement.zoom : zoomInVal;
ok(zoomOutVal < zoomInVal, 'zoom decreases on #gr-zoom-out');

click('#gr-zoom');
pump(40);
const zoomResetPlacement = A.graph.placement();
const zoomResetVal = zoomResetPlacement ? zoomResetPlacement.zoom : 0;
ok(Math.abs(zoomResetVal - 1) < 1e-4, 'zoom resets to 100% on #gr-zoom');
ok(el('#gr-zoom').textContent === '100%', '#gr-zoom label displays 100%');

click('#gr-fit');
pump(40);
const zoomFitPlacement = A.graph.placement();
ok(zoomFitPlacement !== null && zoomFitPlacement.zoom > 0, 'fit executed on #gr-fit');

const foldBtn = el('#gr-fold');
ok(foldBtn !== null, 'found #gr-fold button');
const foldTextInitial = foldBtn.textContent;
click('#gr-fold');
pump(40);
const foldTextToggled = foldBtn.textContent;
ok(foldTextToggled !== foldTextInitial, 'fold toggles on #gr-fold click');
click('#gr-fold');
pump(40);
ok(foldBtn.textContent === foldTextInitial, 'fold toggles back on second #gr-fold click');

const searchInput = el('#gr-search');
ok(searchInput !== null, 'found #gr-search input');
click(searchInput);
pump(20);
ok(document.activeElement === searchInput, '#gr-search is focused');
type(searchInput, 'crop');
pump(40);
ok(searchInput.value === 'crop', '#gr-search has crop value');
const dimmedNodes = Array.from(document.querySelectorAll('#gr-nodes .gn-dimmed'));
ok(dimmedNodes.length > 0, 'search filter dims non-matching nodes');

click(searchInput);
pump(20);
pressKey(KEYS.ESCAPE);
pump(40);
ok(searchInput.value === '', 'search input cleared after Escape key');

const addBtn = el('#gr-add');
ok(addBtn !== null, 'found #gr-add button');
click(addBtn);
pump(40);
const panelEl = el('#gr-panel');
ok(panelEl !== null, 'found #gr-panel element');
const hasPadSearch = panelEl.querySelector('[data-f="padsearch"]') !== null;
const hasPlaceText = panelEl.textContent.includes('Place');
ok(hasPadSearch || hasPlaceText, 'node palette opens in #gr-panel on #gr-add click');

const renderedNode = document.querySelector('#gr-nodes .gn');
ok(renderedNode !== null, 'rendered node found in #gr-nodes');
click(renderedNode);
pump(40);
ok(panelEl.querySelector('.gp-name') !== null, '#gr-panel updates with node details');

const placement = A.graph.placement();
ok(placement !== null && placement.wires && placement.wires.length > 0, 'wires exist in placement');
if (placement && placement.wires && placement.wires.length > 0) {
    const w = placement.wires[0];
    const vpRect = el('#gr-viewport').getBoundingClientRect();
    const x1 = w.x1 * placement.zoom + placement.panX;
    const y1 = w.y1 * placement.zoom + placement.panY;
    const x2 = w.x2 * placement.zoom + placement.panX;
    const y2 = w.y2 * placement.zoom + placement.panY;
    const reach = Math.max(24, Math.abs(x2 - x1) * 0.45);
    const c1 = x1 + reach;
    const c2 = x2 - reach;
    const t = 0.3, u = 1 - t;
    const posX = u * u * u * x1 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * x2;
    const posY = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;

    click({ x: vpRect.left + posX, y: vpRect.top + posY });
    pump(40);
    ok(panelEl.textContent.includes('Wire'), '#gr-panel updates for selected wire');

    const wiresBefore = placement.wires.length;
    pressKey(KEYS.DELETE);
    pump(40);
    const placementAfter = A.graph.placement();
    ok(placementAfter.wires.length < wiresBefore, 'wire deleted via DELETE key');
}

console.log('All ' + checks + ' checks PASS');
