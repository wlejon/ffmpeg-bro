// Where the render goes.
//
// It was a path and two flags, which was right while a destination was always
// one file. Four muxers say otherwise and each is a different shape:
//
//   | | |
//   |---|---|
//   | one file | what nearly every render is |
//   | a set of files | `image2`, `segment`, `hls`, `dash` — pictures, segments, chunks and the playlist that names them |
//   | a stream | a URL through one of the protocols this build links |
//   | several at once | `-f tee`: one encode, several destinations |
//
// **Which of the four this is, is asked rather than declared.** There is no
// mode control here and no list of segmenting muxers written down, because
// both would be a second answer that could disagree with the first: the muxer
// picker already has the facts. `AVFMT_NOFILE` is libavformat's own way of
// saying "I do not write the file you named me with" — which is exactly what a
// segmenter, a playlist writer and `tee` all are — and a frame pattern in the
// path is what makes `image2` a run rather than one picture. A URL is a URL.
//
// The one name in this file is `tee`, and it is a name rather than a
// capability: `-f tee` *is* the mechanism for several destinations, there is
// one such muxer, and asking a question to discover it would be asking a
// question whose only possible answer is its name.
//
// **The list is edited here too, and that is why the rows are in this file.**
// A `-f tee` argument is a small language with two layers of escaping over it,
// so it is built rather than typed — and it is built in two places, because two
// things in this application open a muxer: a render, and a recording. There is
// one editor for both (`destinationRows`) for the same reason there is one
// `teeSpec`: a second copy would be a second answer to how a `|` is escaped,
// and the two would agree right up until one of them was fixed. Which list it
// is editing and what to call when it changes are the caller's; everything
// about what a destination *is* stays here.
//
// **Why the tee muxer and not two Writers.** Chunk 12 sketched the second and
// the seams do allow it — one `FrameSource`, two `Writer`s — but it would be
// the wrong thing: `tee` means *one encode to several places*, and two Writers
// are two encoders on the same frames. Twice the CPU, twice the heat, and two
// files that are supposed to be the same bitstream in different wrappers are
// two different bitstreams. The muxer does what the name means; the seam stays
// available for the day something wants two genuinely different encodes, which
// is a different feature and is not this one.

import { settings } from './state.js';
import { urlScheme } from '../format.js';
import { el, span, row, head } from '../dom.js';
import { btns, note } from './controls.js';

/// The scheme of a destination, or '' for somewhere on the filesystem.
///
/// The parse is `format.js`'s, so the reading end and the writing end cannot
/// come to different answers about what a string is. The **policy** is here,
/// and it is the renderer's: `isLocalPath` in `export_writer.cpp` treats a
/// `file:` URL as "the long way of writing" a path, because that is what
/// libavformat's `file` protocol is. So it comes back as '' here too — a
/// `file:///C:/out.mp4` render writes a file that can be stat'd and opened, and
/// calling it a stream took the "Open the result" button away from it and made
/// the panel say there was nothing to size.
export function schemeOf(path) {
    const s = urlScheme(path);
    return s === 'file' ? '' : s;
}

export const outputProtocols = () =>
    (bro.ffmpeg.protocols && bro.ffmpeg.protocols.output) || [];

/// Can this build reach that scheme? A URL naming a protocol that is absent
/// fails at open with a message about a filename, which is the least useful
/// place to find out.
export const protocolLinked = (scheme) => outputProtocols().indexOf(scheme) >= 0;

export const isTee = () => settings.container === 'tee';

/// One of `file`, `files`, `stream`, `several`.
///
/// The order matters and is the order the questions come: a `tee` is several
/// whatever its destinations are, a URL is a stream whatever the muxer thinks,
/// and what is left is a set or a file depending on whether the muxer writes
/// what it was named with.
///
/// **There are two `kindOf`s in this application and they are not related.**
/// `ui/inputs.js`'s answers *what an `-i` is* — a file, a sequence, a still, a
/// concat list, a device, a file of cues; this one answers *what shape the
/// output is*. No file imports both and neither should be reached for by the
/// other's callers. They overlap on exactly one sub-fact, `hasFramePattern`,
/// and even there they differ on purpose: the reading end also counts
/// `pattern_type=glob` as a run of pictures, because that is a way of naming
/// one to the `image2` *demuxer*, and there is no such thing at the writing
/// end — a muxer numbers its files and has nothing to match against. A
/// difference between them is not drift to be reconciled.
export function kindOf(muxer, path = settings.path) {
    if (isTee()) return 'several';
    if (schemeOf(path)) return 'stream';
    if (bro.ffmpeg.hasFramePattern(path || '')) return 'files';
    if (muxer && muxer.noFile) return 'files';
    return 'file';
}

/// What the destination is, in one sentence, in libavformat's own terms.
export function describeKind(kind, muxer) {
    switch (kind) {
        case 'several':
            return 'one encode, several destinations — each with its own muxer and its own ' +
                   'options, written as the -f tee argument below';
        case 'stream':
            return 'a URL: the render is pushed through a protocol as it is made, so there ' +
                   'is no file to size and nothing to open at the end';
        case 'files':
            return muxer && muxer.noFile
                ? `${muxer.name} does not write the file it is named with — it opens its own ` +
                  'as it goes, and what you name is the one that says where they are'
                : 'a file per frame — the numbering is in the name, and there is nowhere ' +
                  'else it could be';
        default:
            return 'one file, opened now and closed when the render ends';
    }
}

// ── several destinations ───────────────────────────────────────────────────
//
// The `tee` muxer takes its destinations in the filename, separated by `|`,
// each optionally preceded by `[key=value:key=value]`. That is a small
// language inside an argument, and it has escaping rules of its own — which is
// the awkward part and the reason the spec is *built* here rather than typed.
//
// libavformat splits the slaves with `av_get_token`, which honours a backslash
// and stops at the separator, and reads the bracket with `av_opt_get_key_value`
// on `=` and `:`. So a `|` or a `\` anywhere has to be escaped, and inside a
// bracket a `:` and a `]` do too. Everything here is then quoted once more by
// the command bar for the shell, which is a second and completely separate
// layer — a fact worth knowing, because the two are what make hand-written tee
// arguments notoriously hard to get right.

/// A destination's URL as `tee` will read it.
///
/// **`[` and `]` are deliberately not escaped here, and escaping them would not
/// work.** `tee_write_header` splits the list with `av_get_token` *first* and
/// only then looks at what came back: `parse_slave_opts` tests whether the
/// **first character** of the already-unescaped slave is a `[`. Since
/// `av_get_token` removes a backslash and keeps what follows it, `\[` arrives
/// as `[` and is read as the option bracket exactly as an unescaped one would
/// be. So a destination whose path begins with `[` cannot be written through
/// `tee` at all, and the honest thing is to say so rather than to apply an
/// escape that does nothing and looks like a guard.
export const escapeTarget = (s) => String(s || '').replace(/([\\|])/g, '\\$1');

/// A value inside the `[...]`, where `:` separates one option from the next
/// and `]` ends the list.
export const escapeOption = (s) => String(s || '').replace(/([\\|:\]])/g, '\\$1');

/// A key or a value inside an `AV_OPT_TYPE_DICT` argument — `fifo`'s
/// `format_opts`, and every other option in libav whose value is itself a bag.
///
/// **The third escaping grammar in this file and deliberately not one of the
/// other two.** libavutil reads a dict option with `av_dict_parse_string(…,
/// "=", ":", 0)`, so `=` separates a key from its value and `:` separates one
/// pair from the next, and `av_get_token` unescapes a backslash — which is a
/// different set of characters from `tee`'s slave list (`|` and `\`) and from
/// its bracket (`:`, `]` and `\`). Collapsing the three into one escaper would
/// mean escaping characters that are ordinary in two of the three grammars, and
/// a backslash that arrives where nothing was going to split is a backslash in
/// somebody's filename.
///
/// **The renderer never uses this**, and that is the point of saying so here:
/// `Writer::open` hands `format_opts` an `AVDictionary` through
/// `av_opt_set_dict_val`, where there is no string to escape. This exists for
/// the *printed* command, which has no such call and has to spell the bag out.
export const escapeDictArg = (s) => String(s || '').replace(/([\\:=])/g, '\\$1');

let nextId = 1;
export const newDestination = (over = {}) =>
    Object.assign({ id: nextId++, format: '', path: '', options: {} }, over);

/// The whole `-f tee` argument, or '' when there is nothing to write.
///
/// A destination with no path is skipped rather than written as an empty
/// slave: `[f=mpegts]|out.mkv` is a parse error, and half-typed rows are the
/// normal state of a list somebody is filling in.
export function teeSpec(list = settings.destinations) {
    const parts = [];
    for (const d of list || []) {
        if (!d.path) continue;
        const opts = [];
        // `f` first, because it is the one every destination has and the one
        // that decides what the rest of the bracket means.
        if (d.format) opts.push(`f=${escapeOption(d.format)}`);
        for (const k of Object.keys(d.options || {})) {
            const v = d.options[k];
            if (v === '' || v === undefined) continue;
            opts.push(`${k}=${escapeOption(v)}`);
        }
        parts.push((opts.length ? `[${opts.join(':')}]` : '') + escapeTarget(d.path));
    }
    return parts.join('|');
}

/// The string `render.start` is given as `path`, which for a tee is not a path
/// at all. One place, because there are four callers — the spec, the command
/// bar, the warnings and the progress panel — and a fifth answer built by hand
/// somewhere would be a render going somewhere the screen does not say.
export function outputTarget() {
    return isTee() ? teeSpec() : settings.path;
}

/// The list, as rows: one muxer, one target and its own options each, the built
/// argument underneath, and the button that adds another.
///
/// **One editor, two stages.** The Write stage's destinations and a recording's
/// are the same thing — `tee` is one encode to several muxers, and a recording
/// is a device into a muxer — so they are edited by the same rows. What differs
/// is only what the caller owns: `list` is the array, `changed` is what to call
/// after touching it, `prefix` names the `data-f` handles so two stages' controls
/// are addressable apart, and `first` is the muxer a first row arrives carrying.
///
/// It is shown as well as built, in full, under the list: the whole claim of
/// this application is that nothing reaches ffmpeg unseen, and an argument
/// assembled on your behalf is exactly the thing that has to be visible.
///
/// **`changed` and not a returned value.** These rows edit the objects in place,
/// which is what every other list in this application does — a row is a view of
/// a destination, not a form to be submitted — and the caller redraws.
export function destinationRows({ list, changed, prefix = 'tee', first = 'matroska' }) {
    const rows = [];
    const at = (name, i) => `${prefix}-${name}${i === undefined ? '' : `-${i}`}`;

    (list || []).forEach((d, i) => {
        const target = el('input', {
            cls: 'wide', 'data-f': at('path', i), type: 'text', value: d.path,
            on: { change: () => { d.path = target.value.trim(); changed(); } },
        });
        const muxer = el('input', {
            cls: 'wide', 'data-f': at('format', i), type: 'text', value: d.format,
            placeholder: 'muxer, by name — mpegts, flv, matroska',
            on: { change: () => { d.format = muxer.value.trim(); changed(); } },
        });
        const scheme = schemeOf(d.path);
        rows.push(head(`Destination ${i + 1}`, { cls: 'section-head' }));
        rows.push(row('-f', muxer));
        rows.push(row('To', target));
        if (scheme)
            rows.push(row('', note(protocolLinked(scheme)
                ? `${scheme} · linked in`
                : `${scheme} · not in this build, so this destination will fail at open`)));
        rows.push(row('', btns([
            el('button', { cls: 'tiny', 'data-f': at('drop', i), text: 'Remove',
                           on: { click: () => { list.splice(i, 1); changed(); } } }),
        ])));
    });

    rows.push(row('', btns([
        el('button', { cls: 'tiny', 'data-f': at('add'), text: '+ Destination',
                       // The muxer this stage is set to is the sensible first
                       // answer for the first destination and a poor one for the
                       // second, which is usually the whole reason there is a
                       // second.
                       on: { click: () => {
                           list.push(newDestination({
                               format: list.length ? '' : first, path: '',
                           }));
                           changed();
                       } } }),
    ])));

    const spec = teeSpec(list);
    rows.push(row('-f tee', span(spec || 'nothing to write yet', spec ? 'mono ex-tee' : 'dim')));
    rows.push(row('', note(
        'Built rather than typed: tee separates its destinations with | and reads each ' +
        'one’s options out of [ ], so a | or a \\ in a target and a : or a ] in an option ' +
        'value have to be escaped — and then the shell quotes the lot again, which is a ' +
        'second and separate layer. The command bar prints what runs.')));
    return rows;
}

/// What a person would open to look at the result, or '' when there is nothing
/// to open.
///
/// **A render to a set of files is not "done, here is your file".** For `hls`
/// and `dash` the answer is the playlist, which is the file that was named and
/// is the only thing that says what order the pieces go in. For a numbered run
/// it is the first file, because a run of pictures has no index and `image2`'s
/// pattern is not a name anything can open. For a stream there is nothing:
/// what was sent has gone, and offering to open it would be offering to open a
/// socket. For a tee it is whichever destination is a file — the first one, not
/// because it is more important but because the other is the same render.
export function openable(kind, path = settings.path) {
    if (kind === 'stream') return '';
    if (kind === 'several') {
        const local = (settings.destinations || []).find((d) => d.path && !schemeOf(d.path));
        return local ? localPath(local.path) : '';
    }
    if (kind === 'files' && bro.ffmpeg.hasFramePattern(path)) {
        const start = Number(settings.extraFormat.start_number);
        try {
            return bro.ffmpeg.frameNames(path, Number.isFinite(start) ? start : 1, 1)[0] || '';
        } catch (e) {
            return '';
        }
    }
    return localPath(path);
}

/// The path behind a `file:` URL. The renderer is handed the URL and opens it
/// through libavformat's `file` protocol; anything on this side that wants to
/// *look at* the result wants the path, because bro's `<video src>` resolves
/// anything not starting with `/`, `\` or `x:` against the document.
/// `localPathOf` in `export_writer.cpp` strips the same five characters for the
/// same reason.
export const localPath = (p) =>
    (String(p || '').slice(0, 5).toLowerCase() === 'file:' ? String(p).slice(5) : String(p || ''));
