// Rendering the timeline to a file — the job, and the one slot it runs in.
//
// What to render is ui/viewer.js's answer, arriving as rectangles already
// computed in canvas pixels (see ffmpeg_export.h). How to produce a frame from
// it is export_timeline.h. How to write one is export_writer.h. What is left
// here is the job: one at a time, on a thread, with a status the UI polls.
//
// **One job at a time** because the UI polls a single slot and chains renders
// off it — the preview runs a lossless reference into a candidate the instant
// the first reports done. That chaining is why the slot is freed *before* the
// terminal status is published, and not after. The slot itself is
// ffmpeg_job.h's, because a recording is a second kind of job in the same one.

#include "ffmpeg_export.h"

#include "export_copy.h"
#include "export_frame.h"
#include "export_subtitle.h"
#include "ffmpeg_capabilities.h"  // isInputDevice, for the clip a device cannot be
#include "ffmpeg_job.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace ffmpegbro {

void runExport(ExportSettings s, std::vector<ExportClip> clips);

MediaInput resolveInput(const ExportSettings& s, int index, const std::string& path) {
    if (index >= 0 && static_cast<size_t>(index) < s.inputs.size()) return s.inputs[index];
    MediaInput in;
    in.path = path;
    return in;
}

int deviceClip(const ExportSettings& s, const std::vector<ExportClip>& clips) {
    for (size_t i = 0; i < clips.size(); ++i)
        if (isInputDevice(resolveInput(s, clips[i].input, clips[i].path).format))
            return static_cast<int>(i);
    return -1;
}

/// What to say about one, in the words both callers use.
///
/// Two of them — `startExport` and the output preview — and one sentence,
/// because the second is the render read by an element and a person who saw two
/// different refusals for one clip would be right to think they were two
/// different faults.
std::string deviceClipRefusal(const ExportSettings& s, const std::vector<ExportClip>& clips,
                              int at) {
    const MediaInput in = resolveInput(s, clips[at].input, clips[at].path);
    return "clip " + std::to_string(at + 1) + " is a live device (-f " + in.format + " -i " +
           in.path + "), and the compositor asks a source what it looks like at an instant. "
           "A device answers only for now: seeking one is Invalid argument, and a trim on "
           "one is a wait of its own length rather than a seek. Record it — a recording is "
           "a file, and a file can be cut";
}

/// One entry of `ExportSettings::passes` applied to the settings it belongs to.
///
/// Every field of a pass is "the render's unless this says otherwise", so this
/// is the whole of what a pass *is* — there is no second spec format and
/// nothing downstream of here can tell it is running inside a multi-pass job.
ExportSettings settingsForPass(const ExportSettings& base, const ExportPass& p) {
    ExportSettings s = base;
    if (!p.filterGraph.empty()) {
        s.filterGraph = p.filterGraph;
        // The inputs travel with the graph they feed. A pass that changes the
        // graph and inherited the old pad list would be naming `[1:v]` at a
        // file the new chains never mention.
        s.filterInputs = p.filterInputs;
    } else if (!p.filterInputs.empty()) {
        s.filterInputs = p.filterInputs;
    }
    if (!p.path.empty()) s.path = p.path;
    if (!p.format.empty()) s.format = p.format;

    // The size, which is the whole of what a proxy pass is. Guarded by `> 0`
    // rather than by a flag because zero is not a frame: there is no render
    // this could be the intended size of, so the absent value can say so
    // itself. `sizeFromGraph` still wins below — a pass that names a size and
    // renders a node of the graph is describing the size of a picture
    // libavfilter has not made yet.
    if (p.width > 0) s.width = p.width;
    if (p.height > 0) s.height = p.height;

    // A pass that names its own encoder starts from an empty option bag: an
    // option table belongs to an encoder, and carrying x264's `preset` onto
    // `wrapped_avframe` is an unknown option — which is an error here, and
    // rightly. A pass that keeps the encoder is adding to what it was set to.
    if (!p.videoCodec.empty() && p.videoCodec != s.videoCodec) {
        s.videoCodec = p.videoCodec;
        s.videoOptions.clear();
        // The named fields are guarded by `hasOption` in the writer, so they
        // are simply ignored by an encoder that has no such control; only the
        // explicit bag can fail, and that is the one being emptied.
    }
    for (const auto& o : p.videoOptions) s.videoOptions.push_back(o);
    for (const auto& o : p.audioOptions) s.audioOptions.push_back(o);

    // **And onto the streams, which is where an option actually reaches an
    // encoder.** `outputStreams` reads `s.videoOptions` only for the render
    // with no stream list — the two the writer synthesises — and every render
    // this application builds carries a list of its own, so a pass whose
    // options stopped at the settings never reached libavcodec at all. That
    // made a two-pass encode two ordinary passes and said nothing: `-pass 1`
    // was dropped where an unrecognised key would have been an error, which is
    // the one outcome this codebase refuses everywhere else.
    //
    // Appended, so a pass wins where it names the same key twice — the same
    // "later wins" rule `applyOptions` already walks the bag by.
    //
    // A copied stream is skipped because it has no encoder to configure, and a
    // codec option on one is refused elsewhere by name; adding one here would
    // be manufacturing that refusal out of a pass the caller wrote correctly.
    for (auto& st : s.streams) {
        if (isCopySource(st.source)) continue;
        if (st.kind == "video") {
            // The same rule the render-level bag follows: an option table
            // belongs to an encoder, so a pass that changes the encoder is also
            // saying that what was set on the old one does not apply. Only for
            // a stream that was taking the render's codec — one that names its
            // own is not what the pass is talking about.
            if (!p.videoCodec.empty() && p.videoCodec != base.videoCodec && st.codec.empty())
                st.options.clear();
            for (const auto& o : p.videoOptions) st.options.push_back(o);
        } else if (st.kind == "audio") {
            for (const auto& o : p.audioOptions) st.options.push_back(o);
        }
    }

    // `-f null -`: run everything, keep nothing. The null muxer is
    // AVFMT_NOFILE, so no file is opened and none is left behind — which is
    // what an analysis pass wants, since what it produces is the file a filter
    // wrote beside the output or the log the encoder kept.
    if (p.discard) {
        s.format = "null";
        s.faststart = false;
        // The `streams` list, if there is one, names encoders and dispositions
        // for a file that is not being written. Cleared so the pass writes the
        // renderer's ordinary one video stream and one audio stream, which is
        // the smallest thing that can carry the frames past the filters.
        s.streams.clear();
        s.chapters.clear();
    }
    return s;
}

/// Every decoder option this render was given, checked before a frame is
/// written.
///
/// **An unknown option is an error, not a shrug** — but the compositor path
/// deliberately renders an unopenable clip as the hole it is, so a mistyped
/// `-skip_frame` would have come out as a black rectangle and a line in the
/// log. That is right for a file that has gone missing and wrong for a setting
/// somebody typed, and the difference cannot be told apart down where the clip
/// is opened.
///
/// So the inputs that carry decoder options are opened here, once, and their
/// decoders with them. It costs a header read per configured input and nothing
/// whatever for every render that sets none, which is all of them until
/// somebody sets one.
bool checkDecoderOptions(const ExportSettings& s, std::string* err) {
    for (const auto& in : s.inputs) {
        if (in.decoderOptions.empty()) continue;
        AVFormatContext* fmt = nullptr;
        if (!openInput(&fmt, in, err)) return false;
        bool ok = true;
        for (unsigned i = 0; i < fmt->nb_streams && ok; ++i) {
            AVStream* st = fmt->streams[i];
            const AVMediaType kind = st->codecpar->codec_type;
            if (kind != AVMEDIA_TYPE_VIDEO && kind != AVMEDIA_TYPE_AUDIO) continue;
            AVCodecContext* dec = nullptr;
            // A stream this build cannot decode at all is not this check's
            // business — the render will say so where it tries to read it —
            // so only an option failure stops anything here.
            std::string why;
            if (!openDecoder(&dec, st->codecpar, st->time_base, in, false, &why)) {
                if (why.find("has no option") != std::string::npos) { *err = why; ok = false; }
            }
            if (dec) avcodec_free_context(&dec);
        }
        avformat_close_input(&fmt);
        if (!ok) return false;
    }
    return true;
}

/// Does this render have to make pictures and sound at all?
///
/// A file whose every stream is copied is a rewrap or a lossless cut: there is
/// no canvas, no mix, no encoder and no frame clock, and building a
/// `FrameSource` for it would open and decode every clip on the timeline in
/// order to hand the result to nobody. An empty stream list is the renderer's
/// usual two, so it composes.
bool composesAnything(const ExportSettings& s) {
    if (s.streams.empty()) return true;
    for (const auto& st : s.streams)
        if ((st.kind == "video" || st.kind == "audio") && !isCopySource(st.source)) return true;
    return false;
}

namespace {

/// A pad's label as a refusal should say it, with the unlabelled pad named
/// rather than left as an empty pair of brackets.
std::string padList(const std::vector<std::string>& labels) {
    std::string out;
    for (const auto& l : labels)
        out += (out.empty() ? "" : ", ") + (l.empty() ? std::string("an unlabelled one")
                                                      : "[" + l + "]");
    return out.empty() ? std::string("none") : out;
}

} // namespace

// See ffmpeg_export.h for why this is here and why both jobs go through it.
bool resolvePads(ExportSettings& s, PadProvider* graph,
                 const std::vector<ExportStream>& resolved,
                 std::vector<std::string>* reads, std::string* err) {
    for (auto& st : s.streams) {
        if (!isPadSource(st.source)) continue;
        const std::string label = padLabelOf(st.source);

        // A cue is not made here and neither is an attachment — there is
        // nothing in this binary that turns a picture into either — so a pad
        // feeding one is a spec that could not mean anything.
        if (st.kind != "video" && st.kind != "audio") {
            *err = "a " + st.kind + " stream cannot be fed from '" + st.source +
                   "' — a graph pad is a picture or a sound, and a " + st.kind +
                   " stream comes out of an input";
            return false;
        }
        if (!graph) {
            *err = "'" + st.source + "' names a pad of a filter graph, and this render has "
                   "no graph in it — the picture comes from the timeline";
            return false;
        }
        if (!graph->hasPad(label)) {
            *err = "this graph has no pad called [" + label + "]: its pictures come out of " +
                   padList(graph->padLabels(false)) + " and its sound out of " +
                   padList(graph->padLabels(true));
            return false;
        }
        const bool audio = graph->padIsAudio(label);
        if (audio != (st.kind == "audio")) {
            *err = "[" + label + "] is " + (audio ? "sound" : "a picture") +
                   ", and the stream fed from it is " +
                   (st.kind == "audio" ? "a sound stream" : "a picture stream");
            return false;
        }
        // Whatever the pad settled on, unless the caller said otherwise — in
        // which case the writer's scaler resizes into it, exactly as it does
        // for a composite-fed stream that named a size of its own.
        if (!audio && st.width <= 0) {
            st.width = graph->padWidth(label);
            st.height = graph->padHeight(label);
        }
        reads->push_back(label);
    }

    if (!graph) return true;

    // **A composite asked of a graph that never said which pad it is.** One
    // picture pad is the canvas whatever it is labelled, so this is only
    // reachable with several — and then the name is the only thing that can
    // decide. Said against the resolved list because that is where the render
    // this application has always written lives: an empty `streams` is one
    // video stream fed from the composite, and it has to be refused too rather
    // than write a file of black.
    if (!graph->hasComposite())
        for (const auto& st : resolved)
            if (st.kind == "video" && st.source == "composite") {
                *err = "this graph ends in " + padList(graph->padLabels(false)) +
                       " and no pad is labelled [vout], so nothing says which of them is "
                       "the picture — label one vout, or map the streams with pad:<label>";
                return false;
            }
    // The same for the mix, and it is asked of what the *caller wrote* rather
    // than of the resolved list. With no `aout` there is no mix, `hasAudio()`
    // is false, and `outputStreams()` has already dropped every mix-fed row as
    // "the timeline is silent" — so by the time the resolved list exists the
    // thing to complain about is gone, and what is left is a file quietly
    // missing a soundtrack somebody asked for.
    if (!graph->hasMix())
        for (const auto& st : s.streams)
            if (st.kind == "audio" && (st.source.empty() || st.source == "mix")) {
                *err = "this graph ends in " + padList(graph->padLabels(true)) +
                       " and no pad is labelled [aout], so nothing says which of them is "
                       "the mix — label one aout, or map the streams with pad:<label>";
                return false;
            }
    return true;
}

// ── Public surface ─────────────────────────────────────────────────────────

bool startExport(const ExportSettings& settings, const std::vector<ExportClip>& clips,
                 std::string* error, uint64_t* jobNumber) {
    ExportSettings s = settings;
    // yuv420p has no half pixels, and an odd canvas is a failure at
    // avcodec_open2 with an unhelpful message. Round rather than refuse —
    // except where the size is the graph's to say, in which case there is
    // nothing here yet to round and `GraphSource::build` does it once it knows.
    if (!s.sizeFromGraph) {
        s.width = std::max(16, s.width & ~1);
        s.height = std::max(16, s.height & ~1);
    }
    if (s.fps < 1.0 || s.fps > 1000.0) s.fps = 30.0;

    if (s.path.empty()) {
        if (error) *error = "no output file";
        return false;
    }
    // A render that copies packets has neither a timeline nor a graph behind
    // it — a rewrap is one input and one muxer — so neither of the two checks
    // below is about it. Its length is the span of what it copies, which is on
    // the input's clock and not on the range's.
    bool copiesAnything = false;
    for (const auto& st : s.streams)
        if (isCopySource(st.source) || isDecodeSource(st.source)) copiesAnything = true;

    // A graph names its own inputs, so it is a render on its own; the clip list
    // is what the *other* path is made of.
    if (clips.empty() && s.filterGraph.empty() && !copiesAnything) {
        if (error) *error = "nothing on the timeline to render";
        return false;
    }
    if (s.endTime <= s.startTime && !copiesAnything) {
        if (error) *error = "the range to render is empty";
        return false;
    }

    // **A device is not a clip**, and this is the end of the seam that says so.
    // A `-t` gives a device a *length* — that is the same rule `-loop 1` and
    // `-stream_loop -1` follow, and it is why the length question above does not
    // catch this one — but a length is not the half that is missing. See
    // `deviceClip` for what is, and for the numbers.
    if (const int at = deviceClip(s, clips); at >= 0) {
        if (error) *error = deviceClipRefusal(s, clips, at);
        return false;
    }

    // ── `-fps_mode`, refused here rather than half-honoured later ──────────
    //
    // Three refusals, all of them before a file is opened, because each is a
    // fact about the *spec* and every one of them would otherwise come out as a
    // file that plays and is timed wrong — the failure that looks like it
    // worked. See `ExportSettings::fpsMode` for what the two values are and why
    // the other three of ffmpeg's are not offered.
    if (!s.fpsMode.empty() && s.fpsMode != "cfr" && s.fpsMode != "vfr") {
        if (error)
            *error = "there is no frame-timing mode called '" + s.fpsMode +
                     "' here — it is cfr, which walks the range at the output rate, or vfr, "
                     "which keeps the filter graph's own frame times";
        return false;
    }
    if (s.fpsMode == "vfr") {
        // **A variable frame rate is a property of the graph path only.** The
        // compositor samples the edit at whatever instant it is asked about, so
        // it has no frame times of its own to keep — and a stack of clips at
        // different rates has no answer to "whose timestamps?" that is not
        // invented, which is exactly the approximation this renderer refuses.
        if (s.filterGraph.empty()) {
            if (error)
                *error = "a variable frame rate is the filter graph's own frame times, and "
                         "this render composites the timeline — the compositor answers for "
                         "any instant it is asked about, so there are no times of its own to "
                         "keep. Put the rate change in the graph, or render at a fixed rate";
            return false;
        }
        if (!composesAnything(s)) {
            if (error)
                *error = "every stream of this render is copied, so no frame is timed here at "
                         "all — a copied packet keeps the timestamp it came with whatever the "
                         "frame timing is set to";
            return false;
        }
        // **A named pad is a second set of moments.** Each sink of a graph
        // produces on its own clock and at its own times; one walk can hand over
        // one timestamp, and stamping a pad's picture with the composite's would
        // put that stream out of step with itself.
        for (const auto& st : s.streams)
            if (st.kind == "video" && isPadSource(st.source)) {
                if (error)
                    *error = "'" + st.source + "' is a second picture leaving the graph at "
                             "its own moments, and one walk over the frames has one timestamp "
                             "to give — so a render that maps a pad cannot keep every pad's "
                             "own frame times. Render at a fixed rate, or write the pads as "
                             "renders of their own";
                return false;
            }
    }

    const uint64_t number = job::claim(s.path, error);
    if (!number) return false;
    if (jobNumber) *jobNumber = number;
    {
        // A render knows how long it is before it starts, which is the whole
        // difference between it and a recording: this number is what makes a
        // percentage and an estimate mean anything, and a job with no end
        // leaves it at zero rather than inventing one. See ffmpeg_capture.h.
        //
        // **Except a paced one**, which knows how long it is in *seconds* and
        // not in frames — how many the graph will make is what nobody knows
        // until it has made them. Zero here for the same reason a recording
        // with no `-t` leaves it at zero, and the progress comes from time.
        ExportStatus st = job::status();
        st.framesTotal = s.fpsMode == "vfr"
            ? 0
            : std::max<int64_t>(1, std::llround((s.endTime - s.startTime) * s.fps));
        job::publish(st);
    }
    job::run([s, clips] { runExport(s, clips); });
    return true;
}

ExportStatus exportStatus() { return job::status(); }

void cancelExport() { job::stop(); }

void waitForExport() { job::wait(); }

} // namespace ffmpegbro
