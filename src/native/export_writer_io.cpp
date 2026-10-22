// Frame encoding, packet muxing, FIFO wrapping, and I/O tracking for Writer. See export_writer.h.

#include "export_writer.h"

#include "ffmpeg_sequence.h"

#include "util/log.h"

extern "C" {
#include <libavutil/opt.h>
}

#include <algorithm>
#include <cstring>
#include <filesystem>

namespace ffmpegbro {
namespace {

/// The path behind a `file:` URL, which is what `std::filesystem` wants.
std::string localPathOf(const std::string& url) {
    if (url.rfind("file:", 0) == 0) return url.substr(5);
    return url;
}

} // namespace

int Writer::ioOpen(AVFormatContext* s, AVIOContext** pb, const char* url, int flags,
                   AVDictionary** options) {
    auto* self = static_cast<Writer*>(s->opaque);

    // The muxer's own options for this file, plus the protocol's. They are
    // merged into a copy rather than into the caller's dictionary because
    // libavformat reads what is left of *its* dictionary afterwards, and a
    // protocol option it never asked about would look to it like one it failed
    // to consume.
    AVDictionary* merged = nullptr;
    if (options && *options) av_dict_copy(&merged, *options, 0);
    // `protocolOpts_` is written once in `open()` and only read after that, so
    // it needs no lock even when fifo's thread is the one calling this.
    if (self && self->protocolOpts_) av_dict_copy(&merged, self->protocolOpts_, 0);

    const int rc = avio_open2(pb, url, flags, &s->interrupt_callback, &merged);
    if (rc >= 0 && self) self->noteOpened(url, *pb, merged);

    // Give the caller back only what the protocol did *not* take, which is what
    // `io_open` is defined to do and what the caller then goes on to hand to
    // its own `avformat_write_header`. `tee` is the one that notices: its slave
    // options go through here on the way to a muxer, and a protocol option
    // still sitting in the bag afterwards is reported by the slave as an
    // unknown muxer option.
    if (options && *options) {
        AVDictionary* keep = nullptr;
        const AVDictionaryEntry* e = nullptr;
        while ((e = av_dict_iterate(*options, e)))
            if (av_dict_get(merged, e->key, nullptr, 0)) av_dict_set(&keep, e->key, e->value, 0);
        av_dict_free(options);
        *options = keep;
    }
    av_dict_free(&merged);
    return rc;
}

int Writer::ioClose(AVFormatContext* s, AVIOContext* pb) {
    auto* self = static_cast<Writer*>(s->opaque);
    std::string url;
    int64_t sent = 0;
    if (self && pb) {
        std::lock_guard<std::mutex> guard(self->piecesMu_);
        const auto it = self->live_.find(pb);
        if (it != self->live_.end()) {
            url = it->second;
            sent = avio_tell(pb);
            self->live_.erase(it);
        }
    }
    const int rc = avio_close(pb);
    // After the close, not before: a file's real size is a question for the
    // filesystem once the last buffer has gone down, and for an mp4 that
    // +faststart rewrote it is not the write position at all.
    if (self && !url.empty()) self->noteClosed(url, sent);
    return rc;
}

void Writer::noteOpened(const std::string& url, AVIOContext* pb, AVDictionary* leftover) {
    std::lock_guard<std::mutex> guard(piecesMu_);
    live_[pb] = url;

    // A file opened twice is one file. `hls` rewrites its playlist every
    // segment and `segment` with `-segment_wrap` comes back round to the first
    // name, and counting either as new would report a render that wrote forty
    // files when it wrote four.
    for (auto& p : wrote_) if (p.url == url) return;
    Piece p;
    p.url = url;
    p.file = isLocalPath(url);
    wrote_.push_back(p);

    // Whatever the protocol did not take. An unknown key is an error here for
    // the reason it is an error at every other option bag in this binary — a
    // render that succeeded while ignoring what it was told is the worst of the
    // three outcomes — but a callback cannot refuse, so the first one is
    // carried out to `open()`.
    if (!protocolErr_.empty() || !protocolOpts_) return;
    const AVDictionaryEntry* e = nullptr;
    while ((e = av_dict_iterate(protocolOpts_, e))) {
        if (av_dict_get(leftover, e->key, nullptr, 0))
            protocolErr_ = std::string("nothing that writes '") + url +
                           "' has an option '" + e->key + "'";
    }
}

void Writer::noteClosed(const std::string& url, int64_t sent) {
    std::lock_guard<std::mutex> guard(piecesMu_);
    for (auto& p : wrote_) {
        if (p.url != url) continue;
        if (p.file) {
            std::error_code ec;
            const auto size = std::filesystem::file_size(
                std::filesystem::path(localPathOf(url)), ec);
            p.bytes = ec ? sent : static_cast<int64_t>(size);
        } else {
            p.bytes = sent;
        }
        return;
    }
}

int64_t Writer::piecesWritten() const {
    // Read from the render thread while a fifo wrapping may be opening files on
    // its own; see `piecesMu_`.
    std::lock_guard<std::mutex> guard(piecesMu_);
    int64_t n = 0;
    for (const auto& p : wrote_) if (p.url != settings_.path) ++n;
    return n;
}

std::vector<Writer::Piece> Writer::pieces() const {
    std::lock_guard<std::mutex> guard(piecesMu_);
    return wrote_;
}

// A muxer may write the file it was named with under a working name and rename
// it into place. hlsenc does exactly that with its playlist — `out/hls.m3u8` is
// opened as `out/hls.m3u8.tmp` — so the one URL `piecesWritten()` is supposed to
// exclude arrives spelt differently and is counted as an extra segment.
//
// The answer is asked of the filesystem rather than written down, because a
// suffix is a convention of one muxer and there is no call that reports it: the
// working name is *gone* by the time everything has closed, and the destination
// is *there* with nothing in the list claiming to have written it. Those two
// facts together are what a rename is, and nothing else in this binary produces
// them — a segment, a chunk, a picture and a tee slave are all still on disk.
//
// Local files only. A URL cannot be stat'd, and a protocol that renames is not a
// thing that exists.
void Writer::resolveRenames() {
    if (settings_.path.empty()) return;
    // From `finish()`, after fifo's thread has been joined by
    // `avformat_write_trailer` — but taken anyway, because "the thread has
    // certainly gone by here" is exactly the reasoning that stops being true.
    std::lock_guard<std::mutex> guard(piecesMu_);
    std::error_code ec;
    if (!std::filesystem::exists(std::filesystem::path(localPathOf(settings_.path)), ec) || ec)
        return;
    for (const auto& p : wrote_) if (p.url == settings_.path) return;

    // **Exactly one, or none.** A render that is missing several of the files it
    // opened is not one rename — it is `hls_flags delete_segments` doing what it
    // was asked, or somebody clearing the folder underneath the render — and
    // guessing which of them became the destination would be worse than leaving
    // the count one high. Ambiguity here reads as "no rename happened", which is
    // the answer this was before.
    Piece* missing = nullptr;
    for (auto& p : wrote_) {
        if (!p.file) continue;
        if (std::filesystem::exists(std::filesystem::path(localPathOf(p.url)), ec) && !ec)
            continue;
        if (missing) return;
        missing = &p;
    }
    if (!missing) return;

    missing->url = settings_.path;
    const auto size =
        std::filesystem::file_size(std::filesystem::path(localPathOf(settings_.path)), ec);
    if (!ec) missing->bytes = static_cast<int64_t>(size);
}

/// Put the `fifo` in front of the muxer, told what to wrap and how to recover.
///
/// **Named options, libav's own defaults.** The five keys here are the
/// mechanism — `fifo` is one muxer with one option table and there is nothing to
/// discover — but every *value* is either what the caller asked for or nothing
/// at all, so that what a field is left blank means is `muxerOptions("fifo")`'s
/// answer and not a number written down twice. `attempt_recovery` is the one
/// that is always set, because a fifo with it off is a queue and not a recovery
/// and this whole setting is spelt "keep trying".
bool Writer::applyFifo(const ExportSettings& s, std::string* err) {
    auto set = [&](const char* key, const std::string& value) {
        const int rc = av_opt_set(oc_, key, value.c_str(), AV_OPT_SEARCH_CHILDREN);
        if (rc < 0 && err->empty())
            *err = std::string("the fifo muxer would not take ") + key + "=" + value +
                   ": " + avErr(rc);
        return rc >= 0;
    };
    *err = std::string();

    // What it wraps. Named rather than left to `fifo_init`'s own
    // `av_guess_format`, although that is the same call `format_` was resolved
    // by: a render that says `-f flv` means flv, and a fifo guessing from the
    // URL would quietly write something else the moment a stream key ended in
    // `.m3u8`.
    set("fifo_format", format_->name);
    set("attempt_recovery", "1");
    if (s.fifo.queueSize > 0) set("queue_size", std::to_string(s.fifo.queueSize));
    // In seconds here and in microseconds to libav, which is what an
    // AV_OPT_TYPE_DURATION takes as a bare number.
    if (s.fifo.waitSeconds >= 0)
        set("recovery_wait_time",
            std::to_string(static_cast<int64_t>(s.fifo.waitSeconds * 1e6)));
    if (s.fifo.maxAttempts > 0)
        set("max_recovery_attempts", std::to_string(s.fifo.maxAttempts));
    if (s.fifo.dropOnOverflow) set("drop_pkts_on_overflow", "1");
    // fifo refuses `restart_with_keyframe` unless something can be dropped, so
    // this is stated the way the muxer states it rather than silently ignored.
    if (s.fifo.restartWithKeyframe) {
        if (!s.fifo.dropOnOverflow) {
            *err = "restarting on a keyframe needs the queue to be allowed to drop "
                   "packets — a fifo that blocks instead has nothing to skip past";
            return false;
        }
        set("restart_with_keyframe", "1");
    }
    return err->empty();
}

/// The protocol half of the option bag, checked against what was actually
/// opened. One place, because it is asked at two different moments now: right
/// after `write_header` for an ordinary render, and at the end of one behind a
/// fifo, whose destination is opened on a thread of its own.
bool Writer::checkProtocolOptions(std::string* err) {
    std::lock_guard<std::mutex> guard(piecesMu_);
    if (!protocolErr_.empty()) { *err = protocolErr_; return false; }

    // A key that reached nothing at all is the same failure one step earlier:
    // the muxer did not know it, and there was no destination to hand it down
    // to — which is what `-f null -` is, and what `-movflags` on it would be.
    // Silence here is the "succeeded while ignoring what it was told" outcome
    // that every other option bag in this binary refuses.
    //
    // **Behind a fifo, "nothing was opened" is its own failure and a worse
    // one.** It is not evidence about options — saying "the muxer has no option
    // 'timeout'" about a render that spent a minute failing to reach an address
    // would name the wrong thing entirely — it is a render that produced no
    // output at all. And libav will not say so: `fifo_write_trailer` hands back
    // whatever the consumer thread's trailer returned, which for a header that
    // was never written is zero, so a render whose destination never came up
    // **reports success**. That is precisely the outcome this whole setting is
    // arranged against, so it is caught here, where the one thing that knows
    // whether anything was ever opened is written down.
    if (wrapped_ && wrote_.empty()) {
        *err = "never reached '" + settings_.path +
               "' — the fifo went on trying and the destination did not come up, so "
               "nothing was written";
        return false;
    }
    if (wrote_.empty() && protocolOpts_) {
        const AVDictionaryEntry* e = av_dict_iterate(protocolOpts_, nullptr);
        *err = std::string("the ") + format_->name + " muxer has no option '" + e->key +
               "', and it opens nothing for a protocol to have one";
        return false;
    }
    return true;
}

void Writer::stampOf(const Out& o, const FrameAt& at, int64_t* pts, double* t) const {
    // Absent is the fixed-rate walk, where the frame's number *is* its
    // timestamp — the encoder's time base is `1/fps` and there is nothing to
    // convert. Present, it is already on that time base, because the clock the
    // frames arrived on is the clock the encoder was opened with.
    *pts = at.pts == AV_NOPTS_VALUE ? at.n : at.pts;
    // Where the picture is in the *output*, which is what `-force_key_frames` is
    // written against: seconds from the start of the file, not from the start of
    // the timeline. Whoever knows the range subtracted its start before the
    // times got here.
    const AVRational tb = o.enc ? o.enc->time_base : AVRational{0, 1};
    *t = tb.num > 0 && tb.den > 0 ? double(*pts) * av_q2d(tb)
                                  : (settings_.fps > 0 ? double(at.n) / settings_.fps : 0.0);
}

/// One picture into one stream. The body both write paths share, because what
/// differs between the canvas and a pad is only which streams are handed which
/// picture — everything from the scaler down is the same act.
bool Writer::writeVideoInto(Out& o, const Rgba& canvas, const FrameAt& at, std::string* err) {
    if (!ensureScaler(o, canvas.width, canvas.height, err)) return false;
    if (av_frame_make_writable(o.vframe) < 0) {
        *err = "cannot write to the encoder's frame";
        return false;
    }

    const uint8_t* src[4] = {canvas.data.data(), nullptr, nullptr, nullptr};
    const int srcStride[4] = {canvas.stride, 0, 0, 0};
    if (sws_scale(o.toEncoder, src, srcStride, 0, canvas.height,
                  o.vframe->data, o.vframe->linesize) <= 0) {
        *err = "colour conversion failed";
        return false;
    }
    int64_t pts = 0;
    double t = 0;
    stampOf(o, at, &pts, &t);
    o.vframe->pts = pts;
    o.vframe->pict_type =
        o.keys.wants(at.n, t) ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    o.vframe->flags = (o.vframe->flags & ~(AV_FRAME_FLAG_INTERLACED |
                                           AV_FRAME_FLAG_TOP_FIELD_FIRST)) |
                      o.frameFlags;
    return encode(o, o.vframe, err);
}

bool Writer::writeVideo(const Rgba& canvas, const FrameAt& at, std::string* err) {
    for (auto& out : outs_) {
        Out& o = *out;
        // Composite-fed only. A pad-fed stream is a different picture and is
        // handed its own through `writeVideoTo`; giving it the canvas here
        // would write the canvas twice and never write the pad at all.
        if (o.desc.kind != "video" || o.copied || isPadSource(o.desc.source)) continue;
        if (!writeVideoInto(o, canvas, at, err)) return false;
    }
    return true;
}

bool Writer::writeVideoTo(size_t desc, const Rgba& picture, const FrameAt& at,
                          std::string* err) {
    for (auto& out : outs_) {
        if (out->descIndex != desc) continue;
        return writeVideoInto(*out, picture, at, err);
    }
    // The stream was resolved away, which is the same "nothing to write it to
    // and nothing wrong" `writeCopiedPacket` answers with.
    return true;
}

bool Writer::writeVideoFrame(AVFrame* frame, const FrameAt& at, std::string* err) {
    if (!frame) { *err = "no picture to write"; return false; }
    for (auto& out : outs_) {
        Out& o = *out;
        if (o.desc.kind != "video" || o.copied) continue;
        // The frame belongs to the graph and is handed to every stream in turn;
        // what is written on it is only what is not pixels, which is the same
        // three things `writeVideo` writes and none of them a copy.
        int64_t pts = 0;
        double t = 0;
        stampOf(o, at, &pts, &t);
        frame->pts = pts;
        frame->pict_type = o.keys.wants(at.n, t) ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
        frame->flags = (frame->flags & ~(AV_FRAME_FLAG_INTERLACED |
                                         AV_FRAME_FLAG_TOP_FIELD_FIRST)) | o.frameFlags;
        if (!encode(o, frame, err)) return false;
    }
    return true;
}

/// One block of interleaved float into one stream's resampler and fifo.
bool Writer::writeAudioInto(Out& o, const float* interleaved, int frames, std::string* err) {
    {
        const int maxOut = static_cast<int>(av_rescale_rnd(
            swr_get_delay(o.swr, o.enc->sample_rate) + frames,
            o.enc->sample_rate, settings_.audioSampleRate, AV_ROUND_UP));
        if (av_frame_make_writable(o.aconv) < 0) {
            *err = "cannot write to the resampler's frame";
            return false;
        }
        if (maxOut > o.aconv->nb_samples) {
            av_frame_unref(o.aconv);
            o.aconv->format = o.enc->sample_fmt;
            o.aconv->sample_rate = o.enc->sample_rate;
            av_channel_layout_copy(&o.aconv->ch_layout, &o.enc->ch_layout);
            // Slack past what the resample can produce — see kSwrSlack in
            // export_frame.h. It was a bare `+ 64` here, which is the same
            // decision taken separately and is how a number like this comes to
            // differ between two of the four places it is needed.
            o.aconv->nb_samples = maxOut + static_cast<int>(kSwrSlack);
            if (av_frame_get_buffer(o.aconv, 0) < 0) {
                *err = "out of memory resampling the sound";
                return false;
            }
        }

        const auto* in = reinterpret_cast<const uint8_t*>(interleaved);
        const int written = swr_convert(o.swr, o.aconv->extended_data, o.aconv->nb_samples,
                                        &in, frames);
        if (written < 0) { *err = "audio resample failed"; return false; }
        if (written == 0) return true;

        if (av_audio_fifo_write(o.fifo, reinterpret_cast<void* const*>(o.aconv->extended_data),
                                written) < written) {
            *err = "audio buffer full";
            return false;
        }
        if (!drainFifo(o, false, err)) return false;
    }
    return true;
}

bool Writer::writeAudio(const float* interleaved, int frames, std::string* err) {
    if (frames <= 0) return true;
    for (auto& out : outs_) {
        Out& o = *out;
        // Mix-fed only, for the reason `writeVideo` is composite-fed only: a
        // pad's sound is a different soundtrack and arrives through
        // `writeAudioTo`.
        if (o.desc.kind != "audio" || o.copied || isPadSource(o.desc.source)) continue;
        if (!writeAudioInto(o, interleaved, frames, err)) return false;
    }
    return true;
}

bool Writer::writeAudioTo(size_t desc, const float* interleaved, int frames,
                          std::string* err) {
    if (frames <= 0) return true;
    for (auto& out : outs_) {
        if (out->descIndex != desc) continue;
        return writeAudioInto(*out, interleaved, frames, err);
    }
    return true;
}

bool Writer::finish(std::string* err) {
    if (finished_) return true;
    finished_ = true;

    // **Every step runs, and the trailer goes down whatever happened before
    // it.** Returning at the first failure was the obvious shape and it is the
    // wrong one: a render stopped after a second or two has an audio FIFO
    // holding less than one encoder frame, draining it can fail, and the file
    // was then closed with no moov at all — so "I stopped it" left an mp4 that
    // opens nowhere, losing the whole of what had been rendered to save the
    // last few milliseconds of sound. Whichever step failed is still reported;
    // it just no longer takes the index with it.
    std::string failure;
    auto note = [&failure](const std::string& e) {
        if (failure.empty()) failure = e.empty() ? "the file could not be finished" : e;
    };

    // Audio first, then video, which is the order this did when there was one
    // of each. It matters only in that changing it for no reason would change
    // the interleaving of a file that is otherwise byte for byte what it was.
    std::string step;
    // A copied stream has no encoder to flush, but it may still have a
    // bitstream filter holding a packet — `dump_extra` buffers one — so the
    // chain gets its end-of-stream here for the same reason `encode()` gives it
    // one on the encoded path. Without this the last packet of a rewrap is
    // simply missing, which is a file that plays and is short.
    for (auto& out : outs_) {
        if (!out->copied || !out->bsf) continue;
        step.clear();
        av_bsf_send_packet(out->bsf, nullptr);
        if (!drainBsf(*out, &step)) note(step);
    }
    for (auto& out : outs_) {
        if (out->desc.kind != "audio" || out->copied) continue;
        step.clear();
        // Whatever is left is shorter than a full encoder frame; the encoder
        // pads it rather than dropping the last few milliseconds.
        if (!drainFifo(*out, true, &step)) note(step);
        else if (!encode(*out, nullptr, &step)) note(step);
    }
    for (auto& out : outs_) {
        if (out->desc.kind != "video" || out->copied) continue;
        step.clear();
        if (!encode(*out, nullptr, &step)) note(step);
        // A pass-1 log that nothing was written to means this encoder does not
        // use libavcodec's statistics pair and keeps its own file somewhere of
        // its choosing — so `-passlogfile` did not reach it and pass 2 will
        // read an empty log. Said out loud rather than discovered as a pass 2
        // that refuses, because the fix is the encoder's own option and only
        // the name of the encoder points at it.
        if (out->statsLog && !out->statsWritten && out->enc)
            LOG_WARN("export: %s keeps its own two-pass statistics file, so "
                     "-passlogfile did not reach it", out->enc->codec->name);
    }

    if (headerWritten_) {
        int rc = av_write_trailer(oc_);
        if (rc < 0) note(std::string("cannot finish the file: ") + avErr(rc));
        // Behind a fifo the trailer is what joins the muxing thread, so this is
        // the first moment at which "was every option taken?" has an answer at
        // all. See the note where the unwrapped render asks it.
        if (wrapped_) {
            std::string why;
            if (!checkProtocolOptions(&why)) note(why);
        }
    }
    const std::string path = settings_.path;
    // Asked of the muxer while it still exists, because a numbered output does
    // not have to start at one and only image2 knows what it was told.
    int64_t startNumber = 1;
    if (oc_ && oc_->priv_data)
        av_opt_get_int(oc_->priv_data, "start_number", 0, &startNumber);
    close();

    // After every close and therefore after every rename: a working name that
    // became the destination stops being a piece here, before anything counts
    // them or adds up their sizes.
    resolveRenames();

    // How big it came out is asked of what was opened, not of avio_tell and not
    // of the path.
    //
    // +faststart rewrites the whole file after the trailer goes down, so the
    // position left behind bears no relation to the result — an mp4 that is
    // three quarters of a megabyte on disk reported itself as three kilobytes.
    // A render into `out%04d.png`, into `hls`, into `segment` or through `tee`
    // has the opposite problem: there is no file called what the muxer was
    // named, so stat'ing the path reported nothing at all. Every destination
    // was measured as it was closed, which covers all four and needs to know
    // nothing about anybody's numbering.
    bytes_ = 0;
    for (const auto& p : wrote_) bytes_ += p.bytes;

    // The fallback, for a muxer that wrote its files by some route that never
    // reached `io_open`. It is a walk of a numbered run, which is what the
    // measurement used to be for every render.
    if (wrote_.empty()) bytes_ = sizeOnDisk(path, startNumber);

    if (!failure.empty()) { *err = failure; return false; }
    return true;
}

int64_t Writer::sizeOnDisk(const std::string& path, int64_t startNumber) {
    std::error_code ec;
    if (!hasFramePattern(path)) {
        const auto size = std::filesystem::file_size(std::filesystem::path(path), ec);
        return ec ? 0 : static_cast<int64_t>(size);
    }
    // image2 numbers contiguously from wherever it was told to start, so the
    // first name that is not there is the end of what was written.
    int64_t total = 0;
    std::string err;
    for (int64_t n = startNumber;; ++n) {
        const auto names = frameFilenames(path, n, 1, &err);
        if (names.empty()) break;
        const auto size = std::filesystem::file_size(std::filesystem::path(names[0]), ec);
        if (ec) break;
        total += static_cast<int64_t>(size);
    }
    return total;
}

int64_t Writer::bytesSoFar() const {
    if (bytes_) return bytes_;
    // What has been closed, plus how far into what is still open. A segmenter
    // half way through its fifth segment has four measured files and a write
    // position, and adding them is the only reading of "how big is it so far"
    // that does not jump backwards every time a segment rolls over.
    int64_t total = 0;
    for (const auto& p : wrote_) total += p.bytes;
    for (const auto& [pb, url] : live_) total += avio_tell(pb);
    if (!total && oc_ && oc_->pb) return avio_tell(oc_->pb);
    return total;
}

bool Writer::writeCopiedPacket(size_t desc, AVPacket* pkt, std::string* err) {
    for (auto& out : outs_) {
        if (out->descIndex != desc) continue;
        return writePacket(*out, pkt, err);
    }
    // The stream was resolved away — an audio stream on a silent render is the
    // one case — so there is nothing to write it to and nothing wrong.
    return true;
}

bool Writer::writeSubtitle(size_t desc, AVSubtitle* sub, int64_t fromMs, int64_t toMs,
                           std::string* err) {
    for (auto& out : outs_) {
        Out& o = *out;
        if (o.descIndex != desc) continue;
        if (!o.enc || o.copied) return true;

        // A copy of the struct, not of what it points at: the rects belong to
        // the caller, which frees them, and every encoder here only reads them.
        // `start_display_time` has to be zero — `avcodec_encode_subtitle`
        // refuses anything else outright — so the offset it was carrying has
        // already been folded into the two milliseconds above.
        AVSubtitle one = *sub;
        one.pts = 0;
        one.start_display_time = 0;
        one.end_display_time = static_cast<uint32_t>(std::max<int64_t>(0, toMs - fromMs));

        const int size = avcodec_encode_subtitle(o.enc, o.subBuf.data(),
                                                 static_cast<int>(o.subBuf.size()), &one);
        if (size < 0) {
            *err = std::string("the ") + o.enc->codec->name +
                   " encoder would not write a subtitle cue";
            return false;
        }
        // Zero is an ordinary answer and not a failure: `mov_text` writes
        // nothing for a cue whose text came out empty, and a zero-length packet
        // in an mp4 is a text track with a hole in it.
        if (size == 0) return true;

        av_packet_unref(pkt_);
        if (av_new_packet(pkt_, size) < 0) { *err = "out of memory"; return false; }
        std::memcpy(pkt_->data, o.subBuf.data(), size_t(size));
        pkt_->stream_index = o.st->index;
        pkt_->pts = pkt_->dts = fromMs;
        pkt_->duration = std::max<int64_t>(0, toMs - fromMs);
        pkt_->flags |= AV_PKT_FLAG_KEY;
        return writePacket(o, pkt_, err);
    }
    return true;
}

bool Writer::drainFifo(Out& o, bool flushTail, std::string* err) {
    while (av_audio_fifo_size(o.fifo) >= o.frameSize ||
           (flushTail && av_audio_fifo_size(o.fifo) > 0)) {
        const int want = std::min(o.frameSize, av_audio_fifo_size(o.fifo));
        if (av_frame_make_writable(o.aframe) < 0) {
            *err = "cannot write to the audio frame";
            return false;
        }
        // `extended_data`, not `data`. `av_audio_fifo_read` writes one pointer
        // per channel for a planar sample format and `AVFrame::data` is eight
        // entries, so anything past 7.1 writes past the end of the array —
        // which `writeAudio` above already gets right, so the file disagreed
        // with itself. No encoder this build offers is reachable with more than
        // eight channels today; whoever adds a surround picker would have found
        // this the hard way.
        if (av_audio_fifo_read(o.fifo, reinterpret_cast<void* const*>(o.aframe->extended_data),
                               want) < want) {
            *err = "audio buffer underrun";
            return false;
        }
        // A short final frame is legal; the encoder pads it itself.
        o.aframe->nb_samples = want;
        o.aframe->pts = o.audioPts;
        o.audioPts += want;
        if (!encode(o, o.aframe, err)) return false;
        o.aframe->nb_samples = o.frameSize;
    }
    return true;
}

bool Writer::encode(Out& o, AVFrame* frame, std::string* err) {
    if (!o.enc) return true;
    int rc = avcodec_send_frame(o.enc, frame);
    if (rc < 0 && rc != AVERROR_EOF) {
        *err = std::string("encode failed: ") + avErr(rc);
        return false;
    }
    for (;;) {
        av_packet_unref(pkt_);
        rc = avcodec_receive_packet(o.enc, pkt_);
        if (rc == AVERROR(EAGAIN)) return true;
        // The encoder has nothing more, ever. Its bitstream filters may still
        // be holding a packet, so the chain gets its end-of-stream here — a
        // filter that buffers would otherwise lose its last packet, which for
        // `dump_extra` is the difference between a file that plays and a file
        // that plays with the last GOP missing.
        if (rc == AVERROR_EOF) {
            if (!o.bsf) return true;
            av_bsf_send_packet(o.bsf, nullptr);
            return drainBsf(o, err);
        }
        if (rc < 0) { *err = std::string("encode failed: ") + avErr(rc); return false; }

        // Pass 1's statistics, appended as the encoder produces them. This is
        // the whole of the handoff to pass 2 for every encoder that does not
        // keep a log of its own.
        if (o.statsLog && o.enc->stats_out) {
            std::fputs(o.enc->stats_out, o.statsLog);
            o.statsWritten = true;
        }

        if (!writePacket(o, pkt_, err)) return false;
    }
}

/// A write that failed, said in terms of where it was going.
///
/// **A destination that is not a file fails in ways a file does not.** A socket
/// can be closed by the far end half way through a render, a stream key can be
/// rejected after the connection is up, a network can go away — none of which
/// is a defect in this application, and all of which used to arrive as "cannot
/// write to the file" about something that was never a file. The destination is
/// named because it is the actionable half: with a `tee` there are several of
/// them and libav's own message, which lands beside this one on the report
/// channel, is the only thing that says which.
std::string Writer::writeFailure(int rc) const {
    // A `tee` argument is a list and not a path, so it is never the first of
    // these however local its destinations happen to be.
    const bool several = format_ && format_->name &&
                         std::strcmp(format_->name, "tee") == 0;
    if (!several && isLocalPath(settings_.path))
        return "cannot write to the file: " + avErr(rc);
    return "the destination stopped accepting the render — '" + settings_.path + "': " +
           avErr(rc) + ". Whatever had already been written is closed properly; what "
           "happens next is the protocol's, not this application's.";
}

bool Writer::writePacket(Out& o, AVPacket* pkt, std::string* err) {
    if (!o.bsf) {
        av_packet_rescale_ts(pkt, o.srcTimeBase, o.st->time_base);
        pkt->stream_index = o.st->index;
        const int rc = av_interleaved_write_frame(oc_, pkt);
        if (rc < 0) { *err = writeFailure(rc); return false; }
        return true;
    }

    // Fed in the encoder's time base, which is what `time_base_in` was set to,
    // and what comes out is in `time_base_out` — a `setts` that changes the
    // rate changes that, so the rescale on the far side reads it rather than
    // assuming.
    const int rc = av_bsf_send_packet(o.bsf, pkt);
    if (rc < 0) {
        *err = std::string("the bitstream filter would not take a packet: ") + avErr(rc);
        return false;
    }
    return drainBsf(o, err);
}

bool Writer::drainBsf(Out& o, std::string* err) {
    if (!o.bsf || !o.bsfPkt) return true;
    for (;;) {
        av_packet_unref(o.bsfPkt);
        const int rc = av_bsf_receive_packet(o.bsf, o.bsfPkt);
        if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
        if (rc < 0) {
            *err = std::string("a bitstream filter failed: ") + avErr(rc);
            return false;
        }
        av_packet_rescale_ts(o.bsfPkt, o.bsf->time_base_out, o.st->time_base);
        o.bsfPkt->stream_index = o.st->index;
        const int w = av_interleaved_write_frame(oc_, o.bsfPkt);
        if (w < 0) { *err = writeFailure(w); return false; }
    }
}

} // namespace ffmpegbro
