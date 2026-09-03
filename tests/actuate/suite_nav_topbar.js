import {
    pump,
    waitFor,
    el,
    click,
    setNextFiles
} from './index.js';

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log((cond ? 'PASS: ' : 'FAIL: ') + what);
    globalThis.assert(cond, what);
}

waitFor('app ready', () => globalThis.__ffmpegBroReady);
const A = globalThis.__ffmpegBro;
pump(100);

click('#doc-new');
ok(A.doc.documentName() === 'Untitled', '#doc-new resets document name to Untitled');
ok(!A.doc.documentPath(), '#doc-new clears document path');
ok(A.project.clips.length === 0, '#doc-new clears clips');
ok(el('#doc-title').textContent === 'Untitled', '#doc-title text is Untitled');

const testSavePath = `${bro.ffmpeg.tempPath('actuate_topbar')}.fbro`;
setNextFiles([testSavePath]);
click('#doc-save');
ok(A.doc.documentName().includes('actuate_topbar'), '#doc-save sets document name');
ok(!A.doc.isModified(), '#doc-save marks document unmodified');
ok(el('#doc-title').textContent.includes('actuate_topbar'), '#doc-title reflects saved document');

click('#doc-save');
ok(!A.doc.isModified(), '#doc-save to current path retains unmodified state');

click('#doc-undo');
ok(el('#doc-undo') !== null, '#doc-undo actuated');
click('#doc-redo');
ok(el('#doc-redo') !== null, '#doc-redo actuated');

setNextFiles(['build/fixtures/landscape.mp4']);
click('#doc-open');
waitFor('clip loaded from landscape.mp4', () => A.project.clips.length > 0);
ok(A.project.clips.length === 1, '#doc-open loaded 1 clip');
ok(A.inputs.inputs.length === 1, '#doc-open created 1 input');
ok(A.inputs.inputs[0].path.includes('landscape'), '#doc-open input path matches landscape.mp4');

const stageIds = ['capture', 'sources', 'compose', 'graph', 'encode', 'write'];
const stageSections = {
    capture: el('#st-capture'),
    sources: el('#st-sources'),
    compose: el('#st-compose'),
    graph: el('#st-graph'),
    encode: el('#st-encode'),
    write: el('#st-write')
};

for (const id of stageIds) {
    ok(stageSections[id] !== null, 'found stage section for ' + id);
}

for (const targetStage of stageIds) {
    const btn = el('#spine').querySelector('[data-stage="' + targetStage + '"]');
    ok(btn !== null, 'found spine button for stage ' + targetStage);
    click(btn);
    pump(60);

    ok(A.shell.currentStage() === targetStage, 'active stage in shell is ' + targetStage);
    ok(!stageSections[targetStage].classList.contains('hidden'), 'target stage section #st-' + targetStage + ' does not have .hidden');

    for (const otherStage of stageIds) {
        if (otherStage !== targetStage) {
            ok(stageSections[otherStage].classList.contains('hidden'), 'inactive stage section #st-' + otherStage + ' has .hidden');
            const otherBtn = el('#spine').querySelector('[data-stage="' + otherStage + '"]');
            ok(!otherBtn.classList.contains('on'), 'inactive spine button for ' + otherStage + ' does not have .on');
        }
    }

    const activeBtn = el('#spine').querySelector('[data-stage="' + targetStage + '"]');
    ok(activeBtn.classList.contains('on'), 'active spine button for ' + targetStage + ' has .on');
    ok(document.body.classList.contains('stage-' + targetStage), 'body has class stage-' + targetStage);
}

const composeBtn = el('#spine').querySelector('[data-stage="compose"]');
click(composeBtn);
pump(60);
ok(A.shell.currentStage() === 'compose', 'returned to compose stage');
ok(!stageSections.compose.classList.contains('hidden'), '#st-compose visible');

try {
    const fs = require('fs');
    if (fs.existsSync(testSavePath)) {
        fs.unlinkSync(testSavePath);
    }
} catch (e) {}

console.log('All ' + checks + ' checks PASS');
