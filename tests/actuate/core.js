export function pump(ms = 40) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) {
        globalThis.wallSleep(20);
        globalThis.advanceTime(20);
        globalThis.flush();
    }
}

export function waitFor(what, predicate, timeoutMs = 20000) {
    if (typeof what === 'function') {
        timeoutMs = predicate || 20000;
        predicate = what;
        what = 'condition';
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    globalThis.assert(false, 'timed out waiting for ' + what);
    return false;
}

export function el(idOrSel) {
    if (!idOrSel) return null;
    if (typeof idOrSel === 'object') return idOrSel;
    const str = String(idOrSel);
    if (str.startsWith('#')) {
        const byId = document.getElementById(str.slice(1));
        if (byId) return byId;
    }
    const direct = document.getElementById(str);
    if (direct) return direct;
    return document.querySelector(str);
}

export function rectOf(target) {
    const node = el(target);
    globalThis.assert(node, 'target not found: ' + target);
    return node.getBoundingClientRect();
}

export function centerOf(target) {
    if (target && typeof target === 'object' && 'x' in target && 'y' in target && !target.nodeType) {
        return { x: target.x, y: target.y };
    }
    const r = rectOf(target);
    return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2
    };
}

export function click(target, opts = {}) {
    let center;
    let node = null;
    if (target && typeof target === 'object' && 'x' in target && 'y' in target && !target.nodeType) {
        center = { x: target.x, y: target.y };
    } else {
        node = el(target);
        globalThis.assert(node, 'click target not found: ' + target);
        const rect = node.getBoundingClientRect();
        globalThis.assert(rect.width > 0 && rect.height > 0, 'click target has zero size: ' + target);
        center = {
            x: rect.x + (opts.x !== undefined ? opts.x : rect.width / 2),
            y: rect.y + (opts.y !== undefined ? opts.y : rect.height / 2)
        };
    }
    const btn = opts.button !== undefined ? opts.button : 0;
    globalThis.mouseMove(center.x, center.y);
    globalThis.mouseDown(center.x, center.y, btn);
    globalThis.mouseUp(center.x, center.y, btn);
    globalThis.flush();
    pump(opts.idle !== undefined ? opts.idle : 40);
    return node;
}

export function drag(fromTarget, toTargetOrOffset, steps = 10, opts = {}) {
    let start;
    if (fromTarget && typeof fromTarget === 'object' && 'x' in fromTarget && 'y' in fromTarget && !fromTarget.nodeType) {
        start = { x: fromTarget.x, y: fromTarget.y };
    } else {
        const node = el(fromTarget);
        const rect = node.getBoundingClientRect();
        start = {
            x: rect.x + (opts.fromX !== undefined ? opts.fromX : rect.width / 2),
            y: rect.y + (opts.fromY !== undefined ? opts.fromY : rect.height / 2)
        };
    }
    let end;
    if (toTargetOrOffset && typeof toTargetOrOffset === 'object' && ('dx' in toTargetOrOffset || 'dy' in toTargetOrOffset)) {
        end = {
            x: start.x + (toTargetOrOffset.dx || 0),
            y: start.y + (toTargetOrOffset.dy || 0)
        };
    } else if (toTargetOrOffset && typeof toTargetOrOffset === 'object' && ('x' in toTargetOrOffset) && ('y' in toTargetOrOffset) && !toTargetOrOffset.nodeType) {
        end = {
            x: toTargetOrOffset.x,
            y: toTargetOrOffset.y
        };
    } else {
        end = centerOf(toTargetOrOffset);
    }
    const count = Math.max(1, steps);
    globalThis.mouseMove(start.x, start.y);
    globalThis.mouseDown(start.x, start.y, 0);
    for (let i = 1; i <= count; i++) {
        const curX = start.x + (end.x - start.x) * (i / count);
        const curY = start.y + (end.y - start.y) * (i / count);
        globalThis.mouseMove(curX, curY);
        pump(10);
    }
    globalThis.mouseUp(end.x, end.y, 0);
    globalThis.flush();
    pump(40);
}

export function wheel(target, dy, dx = 0) {
    const center = centerOf(target);
    globalThis.mouseMove(center.x, center.y);
    globalThis.wheel(center.x, center.y, dy, dx || 0);
    globalThis.flush();
    pump(40);
}
