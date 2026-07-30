// Subtitle streams that are decoded and written again. See export_subtitle.h.

#include "export_subtitle.h"

#include "export_copy.h"
#include "export_writer.h"

#include "util/log.h"

extern "C" {
#include <libavutil/mathematics.h>
}

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>

namespace ffmpegbro {

bool parseDecodeSource(const std::string& source, int* input, int* stream) {
    if (!isDecodeSource(source)) return false;
    const size_t a = source.find(':');
    const size_t b = source.find(':', a + 1);
    if (b == std::string::npos) return false;
    const std::string in = source.substr(a + 1, b - a - 1);
    const std::string st = source.substr(b + 1);
    if (in.empty() || st.empty()) return false;
    for (char c : in) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    for (char c : st) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    *input = std::atoi(in.c_str());
    *stream = std::atoi(st.c_str());
    return true;
}

/// Where this input's zero is, for a track of cues.
///
/// **Two clocks meet in this file and they were not the same one.** A cue
/// arrives carrying the container's raw presentation time; `Tap::from` and
/// `Tap::to` are the window somebody asked for, on the input's own clock, and
/// the seek is made in those terms. The comparison that decides whether a cue
/// is in the window was made between the two, so the zeros differed by exactly
/// `-ss` — a subtitle input trimmed three seconds in wrote every cue three
/// seconds late and dropped none of the ones that were no longer in the input.
/// With no window on an input the difference is zero, which is why every test
/// in the suite passed and why this reaches a person as "the subtitles are
/// late by however far I trimmed" rather than as anything failing.
///
/// **This is `SourceVideo`'s and `SourceAudio`'s epoch, deliberately**, and not
/// the `streamZero` a copied stream is measured from. Cues are written into the
/// same output the composite and the mix go into, so they have to be placed on
/// the clock those are placed on, which is `inputEpoch` over the *container's*
/// start. `streamZero` counts from a stream's own first packet, and that exists
/// to undo the reorder delay a decode timestamp begins before the container's
/// start_time — a correction for a clock this path is not on, since `sub.pts`
/// is a presentation time and cues do not reorder. In practice the two agree on
/// every subtitle track measurable here (an .srt reports no container start at
/// all, and mov_text and Matroska both put their stream's origin at zero); what
/// separates them is a container that genuinely starts late, which is mpegts,
/// where the picture is already being placed the way this places the cues.
double cueEpoch(AVFormatContext* fmt, const MediaInput& in) {
    return inputEpoch(in, fmt->start_time != AV_NOPTS_VALUE
                              ? fmt->start_time / double(AV_TIME_BASE) : 0.0);
}

// ── What a cue says ────────────────────────────────────────────────────────

// See export_subtitle.h for why the split counts fields from the front and why
// the override codes come out.
std::string assDialogueText(const std::string& line) {
    size_t at = 0;
    // Nine fields before the words in the old shape (`Layer,Start,End,Style,
    // Name,MarginL,MarginR,MarginV,Effect`), eight in the one libavcodec emits
    // now (`ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect`).
    int fields = 8;
    if (line.compare(0, 9, "Dialogue:") == 0) { at = 9; fields = 9; }
    for (int i = 0; i < fields; ++i) {
        const size_t comma = line.find(',', at);
        // Fewer commas than a dialogue line has fields: not one. The whole of
        // it is then the best answer there is, which is better than nothing at
        // all for a format this build has not seen before.
        if (comma == std::string::npos) { at = 0; break; }
        at = comma + 1;
    }

    std::string out;
    for (size_t i = at; i < line.size(); ++i) {
        const char c = line[i];
        if (c == '{') {
            const size_t close = line.find('}', i + 1);
            // Unterminated: libass reads the rest of the line as override and
            // draws none of it, so neither does this.
            if (close == std::string::npos) break;
            i = close;
            continue;
        }
        if (c == '\\' && i + 1 < line.size()) {
            const char n = line[i + 1];
            if (n == 'N' || n == 'n') { out += '\n'; ++i; continue; }
            if (n == 'h') { out += ' '; ++i; continue; }
            // A brace that is text rather than the start of a block.
            if (n == '{' || n == '}') { out += n; ++i; continue; }
        }
        out += c;
    }
    return out;
}

/// One decoded cue's rects, joined into the words a person would read.
///
/// Both kinds of text rect, because both exist: `SUBTITLE_ASS` is what every
/// decoder in this build produces and `SUBTITLE_TEXT` is the plain-text rect an
/// older one could hand over. A `SUBTITLE_BITMAP` rect is skipped rather than
/// described — a track made of those never reaches here, since `cueTextOf`
/// settles that with `AV_CODEC_PROP_TEXT_SUB` before it opens a decoder, and one
/// arriving anyway is a rect with no words in it.
std::string cueWords(const AVSubtitle& sub) {
    std::string out;
    for (unsigned i = 0; i < sub.num_rects; ++i) {
        const AVSubtitleRect* r = sub.rects[i];
        if (!r) continue;
        std::string one;
        if (r->type == SUBTITLE_ASS && r->ass) one = assDialogueText(r->ass);
        else if (r->type == SUBTITLE_TEXT && r->text) one = r->text;
        if (one.empty()) continue;
        if (!out.empty()) out += '\n';
        out += one;
    }
    return out;
}

bool cueTextOf(const MediaInput& in, int stream, double from, double to, int max,
               CueText* out, std::string* err) {
    AVFormatContext* fmt = nullptr;
    if (!openInput(&fmt, in, err)) return false;

    if (stream < 0) stream = av_find_best_stream(fmt, AVMEDIA_TYPE_SUBTITLE, -1, -1, nullptr, 0);
    if (stream < 0 || static_cast<unsigned>(stream) >= fmt->nb_streams ||
        fmt->streams[stream]->codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
        // The same two sentences `cueTimesOf` answers with, because they are
        // answers to the same mistake: a stream named as the wrong kind is
        // actionable, and "no cues" sends somebody looking through a file.
        *err = in.path + (stream >= 0 && static_cast<unsigned>(stream) < fmt->nb_streams
                              ? " stream " + std::to_string(stream) + " is not subtitles"
                              : " has no subtitle stream to read cues from");
        avformat_close_input(&fmt);
        return false;
    }

    AVStream* st = fmt->streams[stream];
    const double epoch = streamZero(st, in);
    const double limit = inputLimit(in);
    if (max <= 0) max = 500;
    if (to <= 0.0 || (limit > 0.0 && to > limit)) to = limit;
    out->stream = stream;
    out->from = from;
    out->to = to;

    // **Asked, never listed.** Which family a subtitle codec is in is
    // libavcodec's own property, and it is the same question that decides
    // whether such a track can be written as text or burned in — so it is asked
    // here in the same words `SubtitleStreams::build` asks it, and a build that
    // gains a text codec gains it in this answer.
    const AVCodecDescriptor* d = avcodec_descriptor_get(st->codecpar->codec_id);
    out->codec = d && d->name ? d->name : avcodec_get_name(st->codecpar->codec_id);
    out->text = d && (d->props & AV_CODEC_PROP_TEXT_SUB);
    if (!out->text) {
        // Nothing is opened and nothing is read. A picture of characters has no
        // characters in it, and a caller told so by name can say *why* the
        // column is empty, which is the whole reason this field exists.
        out->complete = true;
        avformat_close_input(&fmt);
        return true;
    }

    AVCodecContext* dec = nullptr;
    if (!openDecoder(&dec, st->codecpar, st->time_base, in, false, err)) {
        avformat_close_input(&fmt);
        return false;
    }

    // Everything but this stream discarded, so a two-hour file's pictures are
    // not handed back to be thrown away one at a time. The same line
    // `SubtitleStreams::build` has, for the same reason.
    for (unsigned i = 0; i < fmt->nb_streams; ++i)
        fmt->streams[i]->discard = (static_cast<int>(i) == stream) ? AVDISCARD_DEFAULT
                                                                  : AVDISCARD_ALL;
    // Backward, and on the subtitle stream itself — the two decisions every
    // seek in this renderer makes. Landing early costs cues that are then
    // dropped by the window test below; landing late loses cues the caller
    // asked for.
    if (from > 0.0)
        av_seek_frame(fmt, stream, inputSeekTarget(st->time_base, in, from),
                      AVSEEK_FLAG_BACKWARD);

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) {
        *err = "out of memory";
        avcodec_free_context(&dec);
        avformat_close_input(&fmt);
        return false;
    }
    for (;;) {
        av_packet_unref(pkt);
        if (av_read_frame(fmt, pkt) < 0) { out->complete = true; break; }
        if (pkt->stream_index != stream) continue;
        // `dts` is the stamp that is always there, which is `stampOf`'s reason
        // in export_copy.cpp; for a cue the two are the same number, since
        // nothing about a subtitle reorders.
        const int64_t stamp = pkt->dts != AV_NOPTS_VALUE ? pkt->dts : pkt->pts;
        if (stamp == AV_NOPTS_VALUE) continue;
        const double t = stamp * av_q2d(st->time_base) - epoch;
        if (to > 0.0 && t > to + 1e-6) { out->complete = true; break; }
        if (t < from - 1e-6) continue;

        AVSubtitle sub{};
        int got = 0;
        if (avcodec_decode_subtitle2(dec, &sub, &got, pkt) < 0) {
            // One unreadable cue is not a reason to lose the rest of them — the
            // same treatment the render's own subtitle path gives it.
            LOG_WARN("cueText: a cue in %s would not decode", in.path.c_str());
            continue;
        }
        if (!got) continue;

        CueLine line;
        // The **packet's** moment, not `start_display_time`'s. Every text
        // format times its cue with the packet and leaves the display offsets
        // at zero, and this list is drawn against `cueTimes`, whose entries are
        // the packets. An offset added here would move the words off the marks.
        line.start = t;
        line.end = pkt->duration > 0 ? t + pkt->duration * av_q2d(st->time_base) : t;
        if (sub.end_display_time > sub.start_display_time)
            line.end = std::max(line.end, t + sub.end_display_time / 1000.0);
        line.text = cueWords(sub);
        avsubtitle_free(&sub);
        // A cue whose words come out empty is not listed. An mp4 writes a
        // sample *between* its cues — two bytes, nothing on screen — and a
        // panel full of blanks is exactly what this call exists instead of; the
        // packet list is where those samples are visible, and it says so.
        if (line.text.empty()) continue;
        out->cues.push_back(std::move(line));
        if (static_cast<int>(out->cues.size()) >= max) break;
    }

    // **The decoder does not outlive the call.** See the note in the header:
    // this is the whole of "a second cost, paid when it is asked for".
    av_packet_free(&pkt);
    avcodec_free_context(&dec);
    avformat_close_input(&fmt);
    return true;
}

SubtitleStreams::Tap::~Tap() {
    if (pkt) av_packet_free(&pkt);
    if (dec) avcodec_free_context(&dec);
    if (fmt) avformat_close_input(&fmt);
}

SubtitleStreams::~SubtitleStreams() = default;

bool SubtitleStreams::build(const ExportSettings& s,
                            const std::vector<ExportStream>& streams, std::string* err) {
    for (size_t i = 0; i < streams.size(); ++i) {
        const ExportStream& desc = streams[i];
        if (!isDecodeSource(desc.source)) continue;
        if (desc.kind != "subtitle") {
            // The seam is deliberately narrow. Video and audio are *composed*
            // here — the canvas and the mix — and a second route into them that
            // decoded one input's stream straight into an encoder would be a
            // second answer to what the output looks like. Nothing stops it
            // later; nothing pretends it works now.
            *err = "'" + desc.source + "' decodes an input stream, which this build does "
                   "for subtitles — a " + desc.kind + " stream comes from the composite, "
                   "the mix, or copy:<input>:<stream>";
            return false;
        }

        int index = -1, stream = -1;
        if (!parseDecodeSource(desc.source, &index, &stream)) {
            *err = "'" + desc.source + "' is not an input and a stream in it — "
                   "decode:<input>:<stream>";
            return false;
        }

        auto tap = std::make_unique<Tap>();
        tap->desc = i;
        tap->in = resolveInput(s, index, "");
        if (tap->in.path.empty()) {
            *err = "'" + desc.source + "' names input " + std::to_string(index) +
                   ", and this render has " + std::to_string(s.inputs.size()) + " of them";
            return false;
        }
        if (!openInput(&tap->fmt, tap->in, err)) return false;
        if (stream < 0 || static_cast<unsigned>(stream) >= tap->fmt->nb_streams) {
            *err = tap->in.path + " has " + std::to_string(tap->fmt->nb_streams) +
                   " streams, so there is no stream " + std::to_string(stream) + " to read";
            return false;
        }
        AVStream* st = tap->fmt->streams[stream];
        if (st->codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
            const char* got = av_get_media_type_string(st->codecpar->codec_type);
            *err = "stream " + std::to_string(stream) + " of " + tap->in.path + " is " +
                   (got ? got : "not a subtitle stream") + ", and this row is a subtitle stream";
            return false;
        }

        // **Pictures of text are not text.** Refused here, by name, rather than
        // as whatever the encoder says when it is handed a bitmap rect: the two
        // families are both called subtitles and only libavcodec's own property
        // tells them apart.
        const AVCodecDescriptor* d = avcodec_descriptor_get(st->codecpar->codec_id);
        if (d && !(d->props & AV_CODEC_PROP_TEXT_SUB)) {
            *err = std::string("stream ") + std::to_string(stream) + " of " + tap->in.path +
                   " is " + d->name + ", which is pictures of text rather than text — it can "
                   "be copied into a container that holds it, or burned into the picture with "
                   "a subtitles filter, but it cannot be converted";
            return false;
        }

        if (!openDecoder(&tap->dec, st->codecpar, st->time_base, tap->in, false, err))
            return false;
        tap->pkt = av_packet_alloc();
        if (!tap->pkt) { *err = "out of memory"; return false; }

        tap->zero = cueEpoch(tap->fmt, tap->in);
        tap->from = std::max(0.0, desc.copyFrom);
        tap->to = desc.copyTo;
        const double limit = inputLimit(tap->in);
        if (limit > 0.0 && (tap->to <= 0.0 || tap->to > limit)) tap->to = limit;
        if (tap->to > tap->from) span_ = std::max(span_, tap->to - tap->from);

        // Everything but this stream discarded, so the demuxer does not hand
        // back every video packet of a two-hour file to have it thrown away one
        // at a time. A subtitle track is a few kilobytes in a gigabyte.
        for (unsigned k = 0; k < tap->fmt->nb_streams; ++k)
            tap->fmt->streams[k]->discard =
                k == static_cast<unsigned>(stream) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
        tap->stream = stream;

        // The window's start, sought backward for the reason every seek in this
        // renderer is: landing before it only costs cues that are then dropped,
        // and landing after it drops cues the render wanted.
        if (tap->from > 0.0) {
            const int64_t target = inputSeekTarget(st->time_base, tap->in, tap->from);
            if (av_seek_frame(tap->fmt, stream, target, AVSEEK_FLAG_BACKWARD) < 0)
                LOG_WARN("subtitles: %s would not seek to %.3f s; reading from the start",
                         tap->in.path.c_str(), tap->from);
        }

        taps_.push_back(std::move(tap));
    }
    return true;
}

const AVCodecContext* SubtitleStreams::decoderFor(size_t desc) const {
    for (const auto& t : taps_) if (t->desc == desc) return t->dec;
    return nullptr;
}

bool SubtitleStreams::done() const {
    for (const auto& t : taps_) if (!t->finished) return false;
    return true;
}

bool SubtitleStreams::pumpTo(double until, Writer& w, std::string* err) {
    for (auto& t : taps_) {
        if (t->finished) continue;
        if (!pumpTap(*t, until, w, err)) return false;
    }
    double at = 0.0;
    for (const auto& t : taps_) at = std::max(at, t->at);
    position_ = at;
    return true;
}

bool SubtitleStreams::pumpTap(Tap& t, double until, Writer& w, std::string* err) {
    while (true) {
        if (until > 0.0 && t.at >= until) return true;

        const int rc = av_read_frame(t.fmt, t.pkt);
        if (rc == AVERROR_EOF) { t.finished = true; return true; }
        if (rc < 0) {
            // A read error part way through a subtitle track is worth the same
            // treatment a truncated file gets everywhere else here: stop this
            // stream, keep the render. What was written is a shorter set of
            // cues, which is legible; a failed render is not.
            LOG_WARN("subtitles: %s stopped being readable; keeping what was decoded",
                     t.in.path.c_str());
            t.finished = true;
            return true;
        }
        if (t.pkt->stream_index != t.stream) { av_packet_unref(t.pkt); continue; }

        AVSubtitle sub{};
        int got = 0;
        const int used = avcodec_decode_subtitle2(t.dec, &sub, &got, t.pkt);
        av_packet_unref(t.pkt);
        if (used < 0) {
            // One unreadable cue is not a reason to lose the rest of them.
            LOG_WARN("subtitles: a cue in %s would not decode", t.in.path.c_str());
            continue;
        }
        if (!got) continue;

        // Where this cue is, on the input's own clock. `sub.pts` is
        // AV_TIME_BASE_Q and the display times are milliseconds relative to it,
        // which is libavcodec's arrangement rather than one chosen here; the
        // epoch is what turns the container's timestamp into the input's, and
        // it has to come off before anything is compared with `from` or `to`.
        const double base =
            (sub.pts != AV_NOPTS_VALUE ? sub.pts / double(AV_TIME_BASE) : 0.0) - t.zero;
        const double start = base + sub.start_display_time / 1000.0;
        const double end = base + sub.end_display_time / 1000.0;
        // How far this tap has read, in *output* seconds — which is the clock
        // `pumpTo` is driven on, since it is called with the time of the frame
        // the writer has just written.
        t.at = std::max(t.at, start - t.from);

        const bool before = start < t.from - 1e-6;
        const bool after = t.to > 0.0 && start > t.to + 1e-6;
        if (after) {
            avsubtitle_free(&sub);
            t.finished = true;
            return true;
        }
        if (before) { avsubtitle_free(&sub); continue; }

        const int64_t fromMs = std::llround((start - t.from) * 1000.0);
        const int64_t toMs = std::llround((std::max(start, end) - t.from) * 1000.0);
        const bool ok = w.writeSubtitle(t.desc, &sub, fromMs, toMs, err);
        avsubtitle_free(&sub);
        if (!ok) return false;
        ++cues_;
    }
}

} // namespace ffmpegbro
