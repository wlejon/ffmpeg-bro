// Transport icons, drawn rather than typed.
//
// These were text glyphs — ▮◀ ◀▮ ▶ ❙❙ — and text is the wrong tool for them.
// A glyph is sized by the font, not by you: ▮◀ is two characters wide and ↻ is
// one, so no two buttons came out the same width, and each character brings its
// own idea of where the baseline is, so nothing lined up vertically either. A
// path in a fixed viewBox has neither problem. It also means skip and step can
// finally be told apart at a glance — skip gets the double chevron, step gets
// the single one against a bar.
//
// bro parses SVG paths through Skia, so the whole grammar including elliptical
// arcs is available; `currentColor` picks up the button's text colour, which is
// what makes the primary and toggled states work without a second icon.

const ICONS = {
    // |◀◀  jump to the start
    start: '<path d="M2.4 3.2h1.8v9.6H2.4z"/>' +
           '<path d="M9.0 3.2v9.6L4.7 8z"/>' +
           '<path d="M13.8 3.2v9.6L9.5 8z"/>',
    // ▶▶|  jump to the end
    end:   '<path d="M11.8 3.2h1.8v9.6h-1.8z"/>' +
           '<path d="M7.0 3.2v9.6L11.3 8z"/>' +
           '<path d="M2.2 3.2v9.6L6.5 8z"/>',
    // ◀|  one frame back
    prev:  '<path d="M9.6 3.2v9.6L3.2 8z"/>' +
           '<path d="M10.8 3.2h1.9v9.6h-1.9z"/>',
    // |▶  one frame on
    next:  '<path d="M6.4 3.2v9.6L12.8 8z"/>' +
           '<path d="M3.3 3.2h1.9v9.6H3.3z"/>',

    play:  '<path d="M4.6 2.8v10.4L13.4 8z"/>',
    pause: '<path d="M4.4 3h2.7v10H4.4z"/><path d="M8.9 3h2.7v10H8.9z"/>',

    // Two arcs chasing each other. Stroked, so it stays legible at 14px where a
    // filled ring would close up.
    loop:  '<path d="M3.4 8A4.6 4.6 0 0 1 8 3.4h3.4" fill="none" ' +
             'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
           '<path d="M9.9 1.5 13.2 3.4 9.9 5.3z"/>' +
           '<path d="M12.6 8A4.6 4.6 0 0 1 8 12.6H4.6" fill="none" ' +
             'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
           '<path d="M6.1 14.5 2.8 12.6 6.1 10.7z"/>',

    volume: '<path d="M2 6.2h2.6L7.8 3.3v9.4L4.6 9.8H2z"/>' +
            '<path d="M9.8 5.6a3.4 3.4 0 0 1 0 4.8" fill="none" ' +
              'stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
            '<path d="M11.9 3.5a6.4 6.4 0 0 1 0 9" fill="none" ' +
              'stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    muted:  '<path d="M2 6.2h2.6L7.8 3.3v9.4L4.6 9.8H2z"/>' +
            '<path d="M10.2 6 14 9.8M14 6l-3.8 3.8" fill="none" ' +
              'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',

    // Four corner brackets — the shape means "the picture, and nothing else".
    full:   '<path d="M2 2h5v1.7H3.7V7H2zM14 2H9v1.7h3.3V7H14zM2 14h5v-1.7H3.7V9H2z' +
              'M14 14H9v-1.7h3.3V9H14z"/>',

    // A padlock, for the sync lock on a track head. Two icons rather than one
    // lit and one dim, because "these tracks ripple together" is a claim about
    // the clips and a colour alone is the sort of state somebody reads past: the
    // shackle is shut or it is standing open. Drawn at 12px, where the body has
    // to be a filled rectangle — a stroked one closes up.
    lock:   '<path d="M3.6 7.2h8.8v6.6H3.6z"/>' +
            '<path d="M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0v1.8" fill="none" ' +
              'stroke="currentColor" stroke-width="1.5"/>',
    unlock: '<path d="M3.6 7.2h8.8v6.6H3.6z"/>' +
            '<path d="M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0" fill="none" ' +
              'stroke="currentColor" stroke-width="1.5"/>',

    zoomOut: '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
             '<path d="M4.9 7h4.2" fill="none" stroke="currentColor" stroke-width="1.5" ' +
               'stroke-linecap="round"/>' +
             '<path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" stroke-width="1.7" ' +
               'stroke-linecap="round"/>',
    zoomIn:  '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
             '<path d="M4.9 7h4.2M7 4.9v4.2" fill="none" stroke="currentColor" stroke-width="1.5" ' +
               'stroke-linecap="round"/>' +
             '<path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" stroke-width="1.7" ' +
               'stroke-linecap="round"/>',
};

/// The markup for one icon, sized to the button's icon slot.
export function icon(name, size = 15) {
    const body = ICONS[name];
    if (!body) return '';
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" ` +
           `fill="currentColor">${body}</svg>`;
}

/// Fill in every `data-icon` button in the document. Called once at startup so
/// the markup stays declarative — index.html says which icon, not what it is.
export function paintIcons(root = document) {
    for (const e of root.querySelectorAll('[data-icon]')) {
        e.innerHTML = icon(e.getAttribute('data-icon'));
    }
}

/// Swap the icon on a button that has two states.
///
/// `size` is optional and is the same default `icon()` has, so the two-state
/// buttons in the markup are unaffected; it is here for a control smaller than
/// the transport's, which the track heads are — a 15px glyph in a lane 18px high
/// touches the lane above it.
export function setIcon(el, name, size) {
    if (el.getAttribute('data-icon') === name) return;
    el.setAttribute('data-icon', name);
    el.innerHTML = icon(name, size);
}
