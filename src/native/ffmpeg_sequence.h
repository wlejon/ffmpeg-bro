// Files that are one input.
//
// An `-i` is usually a file. Three of ffmpeg's inputs are not: a numbered run
// of images read by `image2`, a single still held for a chosen length, and a
// list of files read end to end by the `concat` demuxer. Each is *assembled*
// rather than opened, and what has to exist before libavformat can be asked
// anything is the assembly — the pattern, or the list file.
//
// **Almost nothing here is new machinery.** `-framerate`, `-start_number`,
// `-pattern_type` and `-loop` are options of the `image2` demuxer and travel in
// `MediaInput::options` exactly as they are written on a command line; `safe`
// and `auto_convert` are the `concat` demuxer's. So the input model already
// said all of it. What it could not do was work out, from a drop of three
// hundred files, that they are one input — and that is what this file is.
//
// **Three things called concat, and they are not each other.** The `concat`
// *demuxer* here reads several files as one input, before any decoding, and
// needs them to be encoded compatibly. The `concat` *filter* (chunk 7) joins
// decoded streams inside the graph and does not care what they were. And a
// timeline with two clips laid end to end is neither: it is an edit, and it
// renders through the compositor. A person reaching for "join these two files"
// can mean any of the three, so wherever one of them is offered, say which.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// One numbered run of files, seen as the single `-i` it is.
///
/// The frame rate is deliberately not here. A sequence has no rate of its own —
/// three hundred PNGs are three hundred pictures and nothing on disk says how
/// long each is on screen — so `-framerate` is a *decision*, taken on the
/// input, and inventing one here would be the application quietly making it.
struct ImageSequence {
    std::string dir;         ///< the folder they are in
    std::string pattern;     ///< the path to hand `-i`, with `%0Nd` or `%d` in it
    std::string prefix;      ///< what comes before the number, without the folder
    std::string suffix;      ///< what comes after it, extension included
    int digits = 0;          ///< the zero-padded width, or 0 for unpadded (`%d`)
    int64_t start = 0;       ///< the lowest number present
    int64_t end = 0;         ///< the highest
    int count = 0;           ///< how many files are actually there
    int missing = 0;         ///< how many numbers between start and end are not
    std::string first;       ///< the full path of the lowest-numbered file
};

/// What a drop of files and folders amounts to.
///
/// Everything that is not part of a run comes back in `singles`, in the order
/// it was given, because `logo.png` beside three hundred frames is an ordinary
/// thing to find and dropping it into the sequence would be the worst outcome.
struct SequenceScan {
    std::vector<ImageSequence> sequences;
    std::vector<std::string> singles;
};

/// Group paths — files, folders, or a mixture — into the inputs they are.
///
/// The rules, and each one is a refusal to guess rather than a limitation:
///
///   - **The number is the last run of digits in the name.** `shot2_0007.png`
///     is frame 7 of `shot2_`, not frame 2 of `shot`, which is what every
///     camera, renderer and DCC on earth means by it.
///   - **A run of one file is not a sequence.** It is a still, and a still is
///     a different input with a different question attached to it.
///   - **Zero padding is meaningful and unpadded numbering is not.** If any
///     member is written `007`, then `07` and `0007` are different sequences
///     and are reported as such; if nothing is padded, `1` … `342` is one
///     sequence written `%d` however wide the numbers got.
///   - **A gap is reported, never closed.** `image2` stops at the first
///     missing number, so a run of 300 files with 12 absent is
///     not 300 frames, and pretending otherwise would show a length nothing
///     will render.
///   - **Folders are read one level deep and never crossed.** Two levels of
///     folder is a project layout; a sequence spanning two folders is not a
///     thing `image2` can open.
///   - **Only files with an image extension take part**, and the extensions
///     are libavformat's own (see `imageExtensions`).
SequenceScan scanForSequences(const std::vector<std::string>& paths);

/// The extensions libavformat associates with still images, lowercased.
///
/// Two sources, both asked rather than written down: the `image2` muxer's own
/// extension list — which is the canonical answer to "what does libavformat
/// think a numbered picture is called" — and the name of every `*_pipe`
/// demuxer with the suffix taken off, which is how `webp` and `psd` get in
/// (the muxer writes neither, and both are perfectly ordinary things to have
/// three hundred of).
const std::vector<std::string>& imageExtensions();

/// Whether this build's `image2` can do `pattern_type=glob`.
///
/// The one capability in this repository that cannot be enumerated. `glob` is
/// in the demuxer's option table on every build because the table is
/// unconditional; whether it *works* is `HAVE_GLOB` at compile time, reported
/// as `ENOSYS` from `read_header` and from nowhere else. So it is asked by
/// trying, once, behind a `LogQuiet` — and offering the option on a build that
/// answers no would be offering a pattern type that fails at open with a
/// sentence about a file.
bool globPatternsSupported();

/// The filenames `image2` will actually write for a pattern, from
/// `startNumber`, `count` of them.
///
/// `av_get_frame_filename2` is the same function the muxer uses, so this is
/// not a reimplementation of `%04d` — it is the answer. `%04d` is exactly the
/// sort of thing somebody gets wrong once and then never trusts again, which
/// is why the Write stage shows what will be on disk rather than the pattern
/// that produces it.
///
/// Empty with `*err` set when the pattern has no usable specifier in it.
std::vector<std::string> frameFilenames(const std::string& pattern, int64_t startNumber,
                                        int count, std::string* err);

/// True when `path` carries a frame-number specifier `image2` can write into.
bool hasFramePattern(const std::string& path);

/// One entry in a `concat` list: a file, and how long it is if that is known.
struct ConcatEntry {
    std::string path;
    double duration = 0.0;
};

/// Write a `concat` demuxer list file naming `files`, in order.
///
/// The header line is `ffconcat version 1.0`, which is what makes the file
/// probe as a concat list rather than having to be forced with `-f concat`;
/// the paths are quoted the way that demuxer's own parser unquotes them, and
/// are written exactly as given because **the demuxer resolves a relative
/// entry against the list file's own directory** rather than against the
/// process. Absolute paths still need `-safe 0`, which is the demuxer's option
/// and the caller's business.
///
/// **A `duration` is written whenever one is known, and that is not
/// decoration.** Without it the concat demuxer reports no duration at all
/// until it has read to the end — it opens the first file at header time and
/// the rest as it reaches them — so a joined input would lay out on the
/// timeline as zero seconds long. The numbers come from probing each file,
/// which the caller has already done to be able to offer them.
bool writeConcatList(const std::string& path, const std::vector<ConcatEntry>& files,
                     std::string* err);

} // namespace ffmpegbro
