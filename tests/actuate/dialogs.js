import { centerOf, pump } from './core.js';

export function setNextFiles(paths) {
    const arr = Array.isArray(paths) ? paths : [paths];
    globalThis.setPickedFiles(arr);
}

export function setNextDialog(accept = true) {
    globalThis.setDialogAnswer(accept);
}

export function dropOn(target, paths) {
    const center = centerOf(target);
    const arr = Array.isArray(paths) ? paths : [paths];
    globalThis.dropFiles(center.x, center.y, arr);
    globalThis.flush();
    pump(40);
}
