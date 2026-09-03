import { click, pump } from './core.js';

export function focus(target) {
    return click(target);
}

export function type(target, text, opts = {}) {
    if (target) {
        focus(target);
    }
    const str = String(text);
    if (opts.perChar) {
        for (const ch of str) {
            globalThis.textInput(ch);
            pump(opts.charDelay !== undefined ? opts.charDelay : 10);
        }
    } else {
        globalThis.textInput(str);
    }
    if (opts.blur) {
        globalThis.mouseMove(1, 1);
        globalThis.mouseDown(1, 1, 0);
        globalThis.mouseUp(1, 1, 0);
        globalThis.flush();
        pump(20);
    }
    pump(opts.idle !== undefined ? opts.idle : 40);
}

export function pressKey(keycode, mod = 0) {
    const code = typeof keycode === 'string' ? keycode.charCodeAt(0) : keycode;
    globalThis.keyDown(code, 0, mod || 0);
    globalThis.keyUp(code, 0, mod || 0);
    globalThis.flush();
    pump(40);
}

export const KEYS = {
    BACKSPACE: 0x08,
    TAB: 0x09,
    RETURN: 0x0d,
    ENTER: 0x0d,
    ESCAPE: 0x1b,
    SPACE: 0x20,
    DELETE: 0x7f,
    UP: 1073741906,
    DOWN: 1073741905,
    LEFT: 1073741904,
    RIGHT: 1073741903,
    HOME: 1073741898,
    END: 1073741901
};

export const MODS = {
    NONE: 0,
    SHIFT: 0x0001,
    CTRL: 0x0040,
    ALT: 0x0100
};
