// Single-pass and multi-pass export execution loops. See ffmpeg_export.h.

#include "ffmpeg_export.h"

#include "export_copy.h"
#include "export_frame.h"
#include "export_graph.h"
#include "export_subtitle.h"
#include "export_timeline.h"
#include "export_writer.h"
#include "ffmpeg_job.h"
#include "ffmpeg_report.h"

#include "util/log.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

ExportSettings settingsForPass(const ExportSettings& base, const ExportPass& p);
bool checkDecoderOptions(const ExportSettings& s, std::string* err);
bool composesAnything(const ExportSettings& s);

namespace {

void setStatus(const ExportStatus& s) { job::publish(s); }

/// One walk over the range: ask the edit what the output looks like at this
/// instant, hand it to the writer, say how far along it is. Every step past
/// "how far along" belongs to something else, which is what keeps this readable
/// as the sequence it is.
///
/// **There are two loops here and only one of them is about frames.** A copied
/// stream is not fed per output frame — it is packets arriving on the input's
/// own clock — so it is pumped *beside* the frame loop, up to the time of the
/// frame just written, which is what keeps the muxer's interleaving sane
/// without a second sorting stage. A render with nothing composed in it has no
/// frame loop at all and the packets drive the job.
///
/// **The frame loop asks two different sources for its next frame, and stays one
/// loop.** `-fps_mode cfr` walks the grid and asks the edit what it looks like at
/// `t`; `vfr` asks the source for the frame it has and takes the time with it
/// (`FrameSource`'s paced pull). Everything past that — the pads, the sound, the
/// copied packets, the status — is the same act in both, which is why the two
/// answers are five lines at the top of the body rather than a second loop with
/// one word changed in every line of it. Which walk it is, is decided once — the
/// `paced` flag below — and read from there.
///
/// It leaves `st` carrying a terminal state only when the *job* is over —
/// failure or cancellation. A pass that finished cleanly leaves it Running, so
/// the next one carries on and the terminal status is published once, at the
/// bottom of `runExport`, after the last file has been closed.
void runPass(ExportSettings s, std::vector<ExportClip> clips, ExportStatus& st,
             const std::function<double()>& secondsSince) {
    const double base = double(st.pass - 1) / double(std::max(1, st.passCount));
    const double share = 1.0 / double(std::max(1, st.passCount));

    st.path = s.path;
    st.stage = "opening";
    st.framesDone = 0;
    st.progress = base;
    const double span = std::max(0.0, s.endTime - s.startTime);
    const int64_t total = std::max<int64_t>(1, std::llround(span * s.fps));
    st.framesTotal = total;
    setStatus(st);

    std::string err;
    if (!checkDecoderOptions(s, &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "render", err);
        return;
    }

    const bool composes = composesAnything(s);

    // Which of the two answers to "what does the output look like at t" this
    // render uses, and the only line in the job that knows there are two.
    std::unique_ptr<FrameSource> source;
    // The same object as `source` where the render goes through libavfilter,
    // and null everywhere else. Held because a `pad:` stream is a question
    // about the *graph* — which pads there are, how big each one is — and
    // `FrameSource` deliberately knows nothing about pads it has not been
    // asked for.
    GraphSource* graph = nullptr;
    if (!composes) {
        // Nothing to compose: every stream is packets. The frame source is not
        // built at all, so a rewrap of a two-hour file does not open a decoder.
    } else if (!s.filterGraph.empty()) {
        auto g = std::make_unique<GraphSource>(s);
        if (!g->build(&err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            st.elapsedSec = secondsSince();
            setStatus(st);
            LOG_ERROR("export failed: %s", err.c_str());
            reportNote(AV_LOG_ERROR, "render", err);
            return;
        }
        // What the graph turned out to be. The writer is opened next and has
        // to be opened for the picture it will actually be handed, which for a
        // node half-way down a graph is not something anything outside
        // libavfilter could have said before it was configured.
        if (s.sizeFromGraph) { s.width = g->outWidth(); s.height = g->outHeight(); }
        graph = g.get();
        source = std::move(g);
    } else {
        source = std::make_unique<TimelineSource>(s, std::move(clips));
    }

    // ── which of the two walks this render is ──────────────────────────────
    //
    // `cfr` steps the range forward at the output rate and stamps each frame
    // with its number; `vfr` takes the frames the source makes and the times it
    // says they are. Asked *of the source* rather than worked out from the spec,
    // because whether there are frame times to keep is libavfilter's answer and
    // nothing outside it knows until the graph is configured — a graph with no
    // pad naming itself the picture has no clock to read at all.
    //
    // `startExport` has already refused `vfr` for a render with no graph in it
    // and for one that composes nothing, so what is left here is the graph that
    // never said which pad is the composite.
    const AVRational clock =
        source && s.fpsMode == "vfr" ? source->pacedClock() : AVRational{0, 1};
    const bool paced = clock.num > 0 && clock.den > 0;
    if (s.fpsMode == "vfr" && !paced) {
        st.state = ExportStatus::State::Failed;
        st.error = "a variable frame rate is the graph's own frame times, and this graph "
                   "never said which of its pads the picture is — so there is no clock to "
                   "read them on. Label one pad vout, or render at a fixed rate";
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", st.error.c_str());
        reportNote(AV_LOG_ERROR, "render", st.error);
        return;
    }

    const bool wantAudio = source && source->hasAudio();

    // The packet path, opened before the writer because a copied stream is
    // described to the muxer out of its input stream's own parameters and there
    // is nowhere else to get them from. `outputStreams` is asked with the same
    // `wantAudio` on both sides, so a copy's index means the same stream here
    // and in the writer.
    std::vector<ExportStream> resolved = outputStreams(s, wantAudio);

    // Which streams read a pad of the graph by name, and what that costs the
    // rest of the job: a size for each, a refusal for anything that cannot
    // work, and — the part that has to happen before the first tick — telling
    // the graph which sound pads somebody is listening to, since the ones
    // nobody is are thrown away as they arrive.
    {
        std::vector<std::string> reads;
        if (!resolvePads(s, graph, resolved, &reads, &err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            st.elapsedSec = secondsSince();
            setStatus(st);
            LOG_ERROR("export failed: %s", err.c_str());
            reportNote(AV_LOG_ERROR, "render", err);
            return;
        }
        if (graph) graph->readPads(reads);
        // Again, because the sizes just written into `s.streams` are part of
        // what the list resolves to and the copy above was taken before them.
        if (!reads.empty()) resolved = outputStreams(s, wantAudio);
    }

    // The streams a pad feeds, by the index the writer numbers them with. Held
    // as a list rather than looked up per frame: it is walked once per output
    // frame and it never changes.
    struct PadStream { size_t desc; std::string label; };
    std::vector<PadStream> padVideo, padAudio;
    for (size_t i = 0; i < resolved.size(); ++i) {
        if (!isPadSource(resolved[i].source)) continue;
        (resolved[i].kind == "audio" ? padAudio : padVideo)
            .push_back({i, padLabelOf(resolved[i].source)});
    }

    CopyStreams copies;
    SubtitleStreams subs;
    // The subtitle path, built alongside the packet path and for the same
    // reason: the writer opens a subtitle encoder *against its decoder* — the
    // ASS header and the frame size both come from there — so the readers have
    // to exist before the file is described.
    if (!copies.build(s, resolved, &err) || !subs.build(s, resolved, &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "render", err);
        return;
    }

    Writer writer;
    // The pool the composite is going to arrive in, or null for every render
    // whose canvas is RGBA in system memory. Asked before the writer opens
    // because an encoder that takes frames off a device is opened against the
    // device's pool; asked of the source rather than worked out from the
    // settings because only libavfilter knows whether the last pad kept its
    // pictures on the card.
    AVBufferRef* const hwFrames = source ? source->hwFrames() : nullptr;
    // And the clock the pictures arrive on, for the same reason and at the same
    // moment: a video encoder that will carry the graph's own timestamps has to
    // be *opened* on the base they are exact in, and by the first frame the
    // header has gone down. `{0, 1}` is the fixed-rate walk, which is `1/fps`.
    if (!writer.open(s, wantAudio, &err, &copies, &subs, hwFrames,
                     paced ? clock : AVRational{0, 1})) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        setStatus(st);
        LOG_ERROR("export failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "render", err);
        return;
    }

    std::vector<float> mix, padMix;
    const int rate = s.audioSampleRate;
    const int channels = s.audioChannels;
    int64_t samplesWritten = 0;

    /// Every soundtrack this file has, brought up to `outSeconds` into the
    /// output.
    ///
    /// **One home for the accumulator, because there are two callers and they
    /// have to agree.** The count is taken from the start of the render rather
    /// than per frame, so rounding never loses or repeats a sample at a frame
    /// boundary — and the paced walk needs the same block twice, once per frame
    /// and once for the tail the last frame's own duration is, which as two
    /// copies of this would be two places for that guarantee to drift. One count
    /// for every soundtrack, because they are all the same seconds of the same
    /// render; what differs is only where each one's samples come from.
    auto soundUpTo = [&](double outSeconds) {
        if (!source || (!writer.hasAudio() && padAudio.empty())) return true;
        const int64_t upTo = std::llround(outSeconds * rate);
        const int frames = static_cast<int>(std::max<int64_t>(0, upTo - samplesWritten));
        if (frames <= 0) return true;
        const double from = s.startTime + double(samplesWritten) / rate;
        // Only where a stream is fed by the mix. `hasAudio()` counts exactly
        // those, which is what keeps a render whose only sound comes off a pad
        // from decoding every clip's soundtrack to hand it to nobody.
        if (writer.hasAudio()) {
            mix.assign(static_cast<size_t>(frames) * channels, 0.0f);
            source->mixInto(mix.data(), from, frames, rate, channels);
            if (!writer.writeAudio(mix.data(), frames, &err)) return false;
        }
        for (const auto& p : padAudio) {
            // Its own buffer, because it is its own soundtrack: summed into the
            // mix's it would be one stream carrying both.
            padMix.assign(static_cast<size_t>(frames) * channels, 0.0f);
            if (!source->padMixInto(p.label, padMix.data(), from, frames, rate, channels))
                continue;
            if (!writer.writeAudioTo(p.desc, padMix.data(), frames, &err)) return false;
        }
        samplesWritten = upTo;
        return true;
    };

    st.stage = composes ? "rendering" : "copying";
    // A copy is not measured in output frames: what it writes is packets, and
    // how many there are is not a thing anybody knows before reading them. Zero
    // is the honest answer, the same one an endless input gives — the progress
    // below comes from the copy's own clock instead.
    if (!composes) { st.framesTotal = 0; }
    // **And neither is a paced walk**, for the same reason and with the same
    // honest zero: how many frames the graph will make between here and the end
    // of the range is what nobody knows until it has made them. `ExportStatus::
    // framesTotal` documents zero as "nobody knows"; the progress below is
    // computed against *time*, which both walks have, rather than against a
    // count one of them has to invent.
    if (paced) { st.framesTotal = 0; }
    // Which is why the *unit* has to be said out loud now: with two reasons for
    // a zero total, the total no longer distinguishes packets from frames. See
    // `ExportStatus::countingPackets`.
    st.countingPackets = !composes;
    setStatus(st);

    // Where the frame in hand is, on both walks: seconds into the output, and —
    // paced — the timestamp the file will carry.
    double at = 0.0;
    int64_t stamp = AV_NOPTS_VALUE;
    int64_t firstPts = AV_NOPTS_VALUE;   ///< the source's own zero
    int64_t lastRel = AV_NOPTS_VALUE;    ///< the last one written, shifted
    double lastGap = 0.0;                ///< between the last two written
    int64_t held = 0;                    ///< dropped for not advancing
    bool rangeRanOut = false;            ///< the walk stopped at `-t`, not at the content

    for (int64_t n = 0; composes; ++n) {
        if (job::stopping()) {
            st.state = ExportStatus::State::Cancelled;
            st.stage = "cancelled";
            break;
        }

        if (!paced) {
            if (n >= total) break;
            at = double(n) / s.fps;
        } else {
            // **Take frames until one arrives whose time advances.** An `fps`
            // filter holding a frame, and an `overlay` whose framesync repeats
            // an input, both hand over pictures stamped where the last one was
            // — and an encoder given a timestamp that does not move drops the
            // frame silently or fails outright. So the drop happens here, where
            // it can be counted and said. That *is* what ffmpeg's `vfr` means;
            // passing them on regardless is `passthrough`, which is why only one
            // of the two is offered (see ExportSettings::fpsMode).
            bool more = false, stampless = false;
            int64_t rel = 0;
            for (;;) {
                int64_t pts = AV_NOPTS_VALUE;
                more = source->nextFrame(&pts);
                if (!more) break;
                if (pts == AV_NOPTS_VALUE) { stampless = true; break; }
                // **The output's zero is the first frame's own moment**, which
                // is what ffmpeg does without `-copyts`. For an export the two
                // are already the same number — the graph is built with the
                // range's start as its origin — but a preview renders a window
                // out of the middle with the graph's clock offset to match, and
                // a file whose first picture is stamped ten seconds in is ten
                // seconds of nothing.
                if (firstPts == AV_NOPTS_VALUE) firstPts = pts;
                rel = pts - firstPts;
                if (lastRel == AV_NOPTS_VALUE || rel > lastRel) break;
                ++held;
            }
            if (!more) break;               // the graph has run out
            if (stampless) {
                st.state = ExportStatus::State::Failed;
                st.error = "libavfilter handed over a picture with no timestamp on it, and a "
                           "variable frame rate is those timestamps — nothing here can invent "
                           "one. Render at a fixed rate instead";
                break;
            }
            at = double(rel) * av_q2d(clock);
            // `-t`: the range said how long to write for. The grid walk stops
            // after `total` frames, which is every frame strictly inside the
            // span, and this is that same statement about times that are not on
            // a grid.
            if (at >= span) { rangeRanOut = true; break; }
            lastGap = lastRel == AV_NOPTS_VALUE ? 0.0 : double(rel - lastRel) * av_q2d(clock);
            lastRel = rel;
            stamp = rel;
        }
        const double t = s.startTime + at;

        FrameSource& timeline = *source;
        if (writer.takesNativeFrames()) {
            // The picture never comes down. There is no canvas to ask for and
            // nothing to convert: the frame the graph made on the card goes
            // straight to an encoder that was opened against the pool it lives
            // in. `-shortest` is not consulted, because such a render has no
            // black frame to write — black would have to be made in system
            // memory and uploaded once a frame, which is exactly the cost this
            // path exists to avoid — so it ends when its graph does.
            AVFrame* f = const_cast<AVFrame*>(paced ? timeline.nativeNow()
                                                    : timeline.nativeAt(t));
            if (!f) break;
            if (!writer.writeVideoFrame(f, {n, stamp}, &err)) {
                st.state = ExportStatus::State::Failed;
                st.error = err;
                break;
            }
        } else {
            // At `t` on the grid, and already in hand on the paced walk —
            // `nextFrame` advanced the source, and `canvasAt` would advance it
            // again and convert the frame after the one it was told about.
            const Rgba* canvas = paced ? timeline.canvasNow() : &timeline.canvasAt(t);
            if (!canvas) break;
            // `-shortest`: the range said how long to write for and the content
            // has run out first. Asked after the canvas rather than before it
            // because the graph does not know its last input has ended until it
            // has tried to pull — so this is the frame that discovered it, and
            // not writing it is the whole of what `-shortest` does.
            if (s.shortest && timeline.exhausted(t)) break;
            if (!writer.writeVideo(*canvas, {n, stamp}, &err)) {
                st.state = ExportStatus::State::Failed;
                st.error = err;
                break;
            }
            // The graph's other pictures, on the tick just performed. Asked
            // after it and never before: one tick advances every pad together,
            // and a pad pulled on its own would be a stream whose frames are out
            // of step with the canvas. Never on the paced walk — a render whose
            // video streams read named pads is refused, because the pads leave
            // the graph at their own moments and one walk has no timestamp that
            // is all of theirs.
            for (const auto& p : padVideo) {
                const Rgba* picture = timeline.padAt(p.label);
                if (!picture) continue;      // refused before the render started
                if (!writer.writeVideoTo(p.desc, *picture, {n, stamp}, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    break;
                }
            }
            if (st.state != ExportStatus::State::Running) break;
        }

        // The samples this frame covers. On the grid it covers up to the *next*
        // frame, which is `(n + 1)/fps`; paced, the next frame's time is not
        // known until it has been pulled, so a frame covers up to its own moment
        // and the tail below writes the last one's duration. The accumulator
        // inside `soundUpTo` is what makes those the same guarantee.
        if (!soundUpTo(paced ? at : double(n + 1) / s.fps)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            break;
        }

        // The copied streams and the subtitles, caught up to the frame just
        // written. Beside the frame loop rather than after it:
        // `av_interleaved_write_frame` queues a stream that runs ahead of its
        // neighbours, so writing a whole copied track first would hold an hour
        // of packets in memory before the first encoded frame went down. A cue
        // arrives on the input's own timeline rather than on the output's frame
        // grid and is pumped on the same clock for the same reason.
        //
        // Zero is "everything you have" to both pumps, so the paced walk's first
        // frame — which is at zero by construction — asks for nothing rather
        // than for the lot.
        const double until = paced ? at : double(n + 1) / s.fps;
        if (until > 0.0) {
            if (!copies.empty() && !copies.pumpTo(until, writer, &err)) {
                st.state = ExportStatus::State::Failed;
                st.error = err;
                break;
            }
            if (!subs.empty() && !subs.pumpTo(until, writer, &err)) {
                st.state = ExportStatus::State::Failed;
                st.error = err;
                break;
            }
        }

        st.framesDone = n + 1;
        // Across the whole job, not across this pass. The person watching
        // started one render; a bar that reached the end and went back to zero
        // would be reporting the machine's business rather than theirs.
        //
        // **Against time on the paced walk, because there is no count to be a
        // fraction of.** A percentage computed against a frame total nobody
        // knows would be a number that looks like it worked; the range's length
        // is a fact either way.
        st.progress = base + share * (paced ? (span > 0 ? std::min(1.0, at / span) : 1.0)
                                            : double(n + 1) / double(total));
        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        // Polled by the UI at frame rate; a lock per output frame is nothing
        // next to encoding one.
        if ((n & 3) == 0 || (!paced && n + 1 == total)) {
            st.bytesWritten = writer.bytesSoFar();
            st.piecesWritten = writer.piecesWritten();
            setStatus(st);
        }
    }

    // **The tail of the sound, on the walk that did not know where its last
    // frame ended.**
    //
    // On the grid every frame covered up to the next one, so the last one
    // covered up to the end of the range and nothing is owed. Paced, each frame
    // covered up to its own moment, which leaves whatever the last frame lasts
    // unwritten — and the tail is what the *reason the walk stopped* says it is,
    // which is the same rule the fixed-rate walk follows without having to state
    // it:
    //
    //   - the range ran out, so the sound covers the range. `-t` is a decision
    //     somebody made, and a file that came out three hundredths short of it
    //     because the graph's last picture happened to fall early is not the
    //     length that was asked for. It is also what ffmpeg's own `-t` does: the
    //     soundtrack is trimmed to the duration, not to the last frame.
    //   - the content ran out, so the sound stops where the pictures did — the
    //     last frame plus however long the one before it lasted, which is the
    //     only thing here that says how long a last frame is. That is what the
    //     grid walk does when `-shortest` or an exhausted graph breaks it early.
    if (paced && lastRel != AV_NOPTS_VALUE && st.state == ExportStatus::State::Running) {
        const double last = double(lastRel) * av_q2d(clock);
        const double gap = lastGap > 0 ? lastGap : (s.fps > 0 ? 1.0 / s.fps : 0.0);
        if (!soundUpTo(rangeRanOut ? span : std::min(span, last + gap))) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
        }
    }

    // Said once, and only when it happened. A repeated timestamp is a filter
    // doing its job — `fps` holding a frame, an `overlay` whose framesync
    // repeated an input — and how many pictures that cost is the difference
    // between the file somebody expected and the one they got.
    if (held > 0) {
        char dropped[192];
        std::snprintf(dropped, sizeof(dropped),
                      "%lld picture%s left the graph on a timestamp that did not advance and "
                      "%s dropped, which is what a variable frame rate means",
                      static_cast<long long>(held), held == 1 ? "" : "s",
                      held == 1 ? "was" : "were");
        LOG_WARN("export: %s", dropped);
        reportNote(AV_LOG_WARNING, "render", dropped);
    }

    // The other loop: a render with nothing composed in it is driven by the
    // packets themselves. There is no output frame rate to walk, no canvas and
    // no encoder — the job is over when every copied stream has reached the end
    // of what it was asked for.
    //
    // **The clock this loop keeps is its own**, and that is not fussiness. It
    // used to advance by half a second past wherever the copy had reached,
    // which works while packets are dense and hangs the moment they are not: a
    // subtitle track with a cue a second in writes its first cue at output zero
    // and then has nothing to write until 4 s, so the position stays at zero,
    // the window stays at half a second, and the loop asks the same question
    // forever. A local clock is monotonic by construction and the pumps below
    // simply have nothing to do in the seconds where nothing happens.
    double upTo = 0.0;
    if (!composes && st.state == ExportStatus::State::Running) {
        while (!copies.done() || !subs.done()) {
            if (job::stopping()) {
                st.state = ExportStatus::State::Cancelled;
                st.stage = "cancelled";
                break;
            }
            // Half a second at a time, so a Stop is answered promptly and the
            // status moves; the number is a polling interval and nothing else
            // depends on it.
            upTo += 0.5;
            if (!copies.pumpTo(upTo, writer, &err) || !subs.pumpTo(upTo, writer, &err)) {
                st.state = ExportStatus::State::Failed;
                st.error = err;
                break;
            }
            st.framesDone = copies.packets() + subs.cues();
            const double span = std::max(copies.span(), subs.span());
            st.progress = base + share *
                (span > 0 ? std::min(1.0, std::max(0.0, std::max(copies.position(),
                                                                 subs.position()) / span))
                          : 0.0);
            st.elapsedSec = secondsSince();
            st.bytesWritten = writer.bytesSoFar();
            st.piecesWritten = writer.piecesWritten();
            setStatus(st);
        }
    }

    // Whatever the copy still owes. The frame loop stops at the range's last
    // frame and a copied stream's own `copyTo` is what says where it ends, so
    // the two need not agree — and a rewrap whose tail was silently dropped
    // because the encoded half ran out first would be a file that is short.
    if (st.state == ExportStatus::State::Running &&
        ((!copies.empty() && !copies.pumpTo(0, writer, &err)) ||
         (!subs.empty() && !subs.pumpTo(0, writer, &err)))) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
    }

    const bool aborted = st.state == ExportStatus::State::Failed ||
                         st.state == ExportStatus::State::Cancelled;
    // Published only while the job is still *running*.
    //
    // A cancelled or failed render already carries its terminal state by the
    // time it gets here, and saying so before the trailer has been written
    // tells everything watching that the job is over while the file is not —
    // for however long finishing takes, which for an mp4 with `+faststart` is
    // a whole second pass over it. The obvious next act on seeing "stopped" is
    // to open what was made, and it opens a file with no moov in it: the
    // failure reads as a cancelled render having skipped the index, which is
    // the one thing this code goes out of its way to do. Anything terminal is
    // announced once, at the bottom, after the writer has closed the file.
    if (!aborted) { st.stage = "finishing"; setStatus(st); }

    // Finish the file even when cancelled: a half-written mp4 with no index is
    // not playable, and "I stopped it" should still leave the part that was
    // rendered watchable.
    std::string finishErr;
    if (!writer.finish(&finishErr)) {
        // A stopped render is not a failed one, so this does not change the
        // status it reports — but it is not nothing either, and swallowing it
        // entirely is how a file that came out unopenable came to look like a
        // clean cancellation.
        if (aborted) {
            LOG_WARN("export: %s (while finishing a stopped render)", finishErr.c_str());
            reportNote(AV_LOG_WARNING, "render",
                       finishErr + " (while finishing a stopped render)");
        } else {
            st.state = ExportStatus::State::Failed;
            st.error = finishErr;
        }
    }
    st.bytesWritten = writer.bytesSoFar();
    st.piecesWritten = writer.piecesWritten();
    if (!aborted) st.progress = base + share;
    st.elapsedSec = secondsSince();
}

} // namespace

/// The job: every pass in turn, and one terminal status at the bottom.
///
/// **The passes share the slot rather than taking one each.** A two-pass render
/// is one thing to whoever started it — one Stop, one status, one file — and
/// giving the second pass its own claim would mean a window between them where
/// `render.start` would be accepted, which is exactly the race the export
/// preview's chaining already lives in.
void runExport(ExportSettings s, std::vector<ExportClip> clips) {
    job::Held slot;
    const auto began = std::chrono::steady_clock::now();
    const std::function<double()> secondsSince = [&began] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
    };

    // An empty list is one pass that overrides nothing, which is every render
    // written before passes existed — so there is one loop here rather than a
    // fast path and a slow one that could come to disagree.
    std::vector<ExportPass> passes = s.passes;
    if (passes.empty()) passes.push_back(ExportPass{});

    ExportStatus st;
    st.state = ExportStatus::State::Running;
    st.path = s.path;
    st.passCount = static_cast<int>(passes.size());

    std::string lastPath = s.path;
    for (size_t i = 0; i < passes.size(); ++i) {
        st.pass = static_cast<int>(i) + 1;
        st.passLabel = passes[i].label;
        const ExportSettings ps = settingsForPass(s, passes[i]);
        lastPath = ps.path;
        // The stack this pass composites. A pass that says nothing about it
        // renders the render's, which is every pass of a two-pass encode —
        // there the two walks are the same picture and only the encoder
        // differs. A pass at its own size brings its own rectangles, because
        // they are in output pixels and cannot mean the same thing at two.
        runPass(ps, passes[i].clips.empty() ? clips : passes[i].clips, st, secondsSince);
        if (st.state != ExportStatus::State::Running) break;
    }
    // What the file is called is the last pass's, not the first's: an analysis
    // pass that wrote nothing must not leave the status pointing at a path
    // nothing was written to.
    st.path = lastPath;

    if (st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Done;
        st.stage = "done";
        st.progress = 1.0;
    }
    st.elapsedSec = secondsSince();

    // Free the slot *before* publishing the terminal status, not after.
    //
    // Anything watching poll() will act the instant it sees "done", and the
    // obvious thing to do next is start another render — which the export
    // workspace's preview does, chaining a lossless reference into the
    // candidate. With the flag cleared afterwards there is a window, short but
    // perfectly reachable, where the status says finished and the next start is
    // refused with "an export is already running". The `job::Held` guard still
    // covers every path that leaves without getting here; storing false twice
    // costs nothing.
    job::release();
    setStatus(st);

    // **A render that had to reconnect is not a render that did not.** Said
    // before the "wrote …" line and again inside it, because the failure this
    // exists to prevent is a file with a gap in it reported as a plain success —
    // and the line somebody reads is the one that says what was written. The
    // same shape as the paced walk's count of pictures it dropped: a number, at
    // the end, from the one place that has it. Zero for every render that is not
    // wrapped in a `fifo`, because nothing else says those words. See
    // `WriteRecovery` in ffmpeg_report.h for why this is counted out of the log.
    char recovery[320];
    recovery[0] = 0;
    {
        const WriteRecovery r = writeRecovery();
        if (r.recovered > 0 || r.overflowed > 0) {
            std::snprintf(recovery, sizeof(recovery),
                          "the destination dropped and was reconnected %lld time%s"
                          "%s%s — what was written while it was gone is not in the "
                          "output, so this file has %s in it",
                          static_cast<long long>(r.recovered),
                          r.recovered == 1 ? "" : "s",
                          r.failed > 0 ? " (after failed attempts)" : "",
                          r.overflowed > 0 ? ", and the queue filled" : "",
                          r.recovered == 1 ? "a gap" : "gaps");
            LOG_WARN("export: %s", recovery);
            reportNote(AV_LOG_WARNING, "render", recovery);
        }
    }

    // The report's last word about this render, said after the file is closed
    // and the slot is free, so that a surface reading the channel sees the same
    // ordering a surface reading the status does.
    char said[512];
    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("export: wrote %s (%lld frames, %.1f s, %.1f MB)", st.path.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
        std::snprintf(said, sizeof(said), "wrote %s — %lld frames in %.1f s, %.1f MB%s%s",
                      st.path.c_str(), static_cast<long long>(st.framesDone), st.elapsedSec,
                      st.bytesWritten / 1048576.0,
                      st.passCount > 1 ? " (the last of its passes)" : "",
                      recovery[0] ? ", with a reconnection in it" : "");
        reportNote(AV_LOG_INFO, "render", said);
    } else if (st.state == ExportStatus::State::Failed) {
        LOG_ERROR("export failed: %s", st.error.c_str());
        reportNote(AV_LOG_ERROR, "render", st.error);
    } else if (st.state == ExportStatus::State::Cancelled) {
        // "of N" only where N is a number somebody knows. A copy is measured in
        // packets and a paced walk does not know how many frames it was going to
        // write, so both leave `framesTotal` at zero — and "stopped after 40 of
        // 0 frames" is the sort of sentence this codebase is otherwise careful
        // not to print.
        if (st.framesTotal > 0)
            std::snprintf(said, sizeof(said),
                          "stopped after %lld of %lld frames; %s was closed properly and plays",
                          static_cast<long long>(st.framesDone),
                          static_cast<long long>(st.framesTotal), st.path.c_str());
        else
            std::snprintf(said, sizeof(said),
                          "stopped after %lld frames; %s was closed properly and plays",
                          static_cast<long long>(st.framesDone), st.path.c_str());
        reportNote(AV_LOG_WARNING, "render", said);
    }
}

} // namespace ffmpegbro
