// What libavfilter says about a filter, asked once.
//
// **There is no list of filters in this application.** `bro.ffmpeg.filters` is
// libavfilter's own registry — names and pad shapes, built at startup because it
// is small — and `bro.ffmpeg.filterOptions(name)` walks one filter's `AVClass`
// for its option table: names, types, ranges, defaults, enum constants and help
// text. A filter that this ffmpeg gains, this application gains.
//
// Cached here rather than at each point of use because there are now two, and
// they must agree. The card draws a `<select>` where an option has constants and
// an `<input>` where it does not; the panel decides the same thing about the same
// option; two caches would be two answers to what a filter takes, arrived at from
// the same data by different routes. The option tables are also the reason the
// caching is not optional — `filterOptions` is built on demand precisely because
// building all five hundred at startup was most of a second, and a card rebuilt
// on every keystroke would spend it a character at a time.

const optionCache = new Map();
const infoCache = new Map();

/// One filter's option table, or an empty list. Plenty of filters have none —
/// `hflip`, `negate`, `null` — and that is an answer, not a failure.
export function optionsOf(name) {
    if (!name) return [];
    if (!optionCache.has(name)) {
        let list = [];
        try { list = bro.ffmpeg.filterOptions(name) || []; } catch (e) { list = []; }
        optionCache.set(name, list);
    }
    return optionCache.get(name);
}

/// The registry entry: `{ name, description, inputs, outputs, … }`, or null.
export function infoOf(name) {
    if (!infoCache.size) {
        for (const f of allFilters()) infoCache.set(f.name, f);
    }
    return infoCache.get(name) || null;
}

export function allFilters() {
    return (typeof bro !== 'undefined' && bro.ffmpeg && bro.ffmpeg.filters) || [];
}

/// One option out of a filter's table, by name.
export function optionOf(filter, name) {
    return optionsOf(filter).find((o) => o.name === name) || null;
}
