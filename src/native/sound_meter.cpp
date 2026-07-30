// The measurement itself. See sound_meter.h for what it claims and why.

#include "sound_meter.h"

extern "C" {
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
}

#include <cmath>
#include <cstring>

namespace ffmpegbro {
namespace {

/// Spelled out rather than the `M_PI` of `<cmath>`, which is not in the C++
/// standard and is absent
/// from MSVC's `<cmath>` unless `_USE_MATH_DEFINES` is defined first — a define
/// that would have to be right in every translation unit that ever includes this.
constexpr double kPi = 3.14159265358979323846;

/// The interpolating filter, one set of taps per phase, computed once.
///
/// A windowed sinc, which is the textbook polyphase interpolator and is written
/// out here rather than copied from BS.1770's own coefficient table for one
/// reason: a table of forty-eight numbers in a source file is forty-eight numbers
/// nobody can check. This is a formula whose error was measured (see `kPhases`)
/// and can be measured again after anybody edits it.
///
/// The window is Blackman over the tap support, and the sinc is centred between
/// the two middle samples — so **phase 0 is the sample itself**, exactly, because
/// `sinc` of an integer is zero everywhere but the middle. That is not a saving
/// of three multiplies: it is what makes the sample peak and the true peak the
/// same measurement read at different resolutions rather than two measurements
/// that could disagree about which block they were of.
///
/// Each phase is normalised to sum to one, so a constant reads its own value and
/// not a fraction of it.
const double* phaseTaps(int p) {
    static double taps[kPhases][kTaps];
    static const bool made = [] {
        const double half = kTaps / 2.0;
        for (int phase = 0; phase < kPhases; ++phase) {
            const double d = static_cast<double>(phase) / kPhases;
            double sum = 0.0;
            for (int i = 0; i < kTaps; ++i) {
                // Where this tap's sample sits relative to the point being
                // placed: the point is `d` past the sample at index kTaps/2 - 1.
                const double x = (half - 1.0) + d - static_cast<double>(i);
                const double u = x / half;
                double w = 0.0;
                if (u > -1.0 && u < 1.0)
                    w = 0.42 + 0.5 * std::cos(kPi * u) + 0.08 * std::cos(2.0 * kPi * u);
                const double s = std::fabs(x) < 1e-12
                                     ? 1.0
                                     : std::sin(kPi * x) / (kPi * x);
                taps[phase][i] = s * w;
                sum += taps[phase][i];
            }
            if (sum != 0.0)
                for (int i = 0; i < kTaps; ++i) taps[phase][i] /= sum;
        }
        return true;
    }();
    (void)made;
    return taps[p];
}

/// One sample, whatever libav settled on, scaled to the [-1, 1] a level is quoted
/// in.
///
/// **Read in place rather than converted first.** A live session takes its frames
/// unconverted — the pictures go straight to a decoder that would only have to
/// undo an RGBA pass — and resampling a thousand samples to float purely so they
/// could be measured would be a conversion done for the meter and nothing else.
/// So the five packed formats and their planar twins are read where they are.
inline double sampleAt(const uint8_t* data, AVSampleFormat packed, int i, bool* known) {
    switch (packed) {
        // Unsigned, centred on 128 — the one format whose silence is not zero.
        case AV_SAMPLE_FMT_U8:  return (static_cast<int>(data[i]) - 128) / 128.0;
        case AV_SAMPLE_FMT_S16: return reinterpret_cast<const int16_t*>(data)[i] / 32768.0;
        case AV_SAMPLE_FMT_S32: return reinterpret_cast<const int32_t*>(data)[i] / 2147483648.0;
        case AV_SAMPLE_FMT_FLT: return reinterpret_cast<const float*>(data)[i];
        case AV_SAMPLE_FMT_DBL: return reinterpret_cast<const double*>(data)[i];
        default: *known = false; return 0.0;
    }
}

/// What libav calls channel `i` of this layout, or its number where the layout
/// says nothing.
///
/// **Asked, never listed.** A table of channel names here would be a second
/// answer to a question libavutil answers, and it would be the wrong one the first
/// time a device delivered a layout this build had not thought of — which is the
/// same rule the muxer, encoder and filter lists follow.
std::string channelName(const AVChannelLayout& layout, int i) {
    char buf[64] = {0};
    const enum AVChannel id = av_channel_layout_channel_from_index(&layout, i);
    if (id != AV_CHAN_NONE && av_channel_name(buf, sizeof(buf), id) > 0 && buf[0] &&
        std::strcmp(buf, "NONE") != 0)
        return buf;
    return std::to_string(i + 1);
}

}  // namespace

void SoundMeter::add(const AVFrame* f) {
    if (!f || f->nb_samples <= 0) return;
    const AVSampleFormat packed =
        av_get_packed_sample_fmt(static_cast<AVSampleFormat>(f->format));
    const bool planar = av_sample_fmt_is_planar(static_cast<AVSampleFormat>(f->format));
    const int channels = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : 1;

    // A pad that has been reconfigured is a different signal, so the tails the
    // interpolator is carrying are not about it. Cleared rather than resized, for
    // the reason a filter's state is always cleared on a reconfigure: eleven
    // samples of the previous layout would ring through the first block of the
    // new one.
    if (static_cast<int>(ch_.size()) != channels) {
        ch_.assign(channels, Channel{});
        samples_ = 0;
    }
    for (int c = 0; c < channels; ++c)
        if (ch_[c].name.empty()) ch_[c].name = channelName(f->ch_layout, c);

    bool known = true;
    bool measured = false;
    for (int c = 0; c < channels && known; ++c) {
        // Planar puts each channel in a plane of its own; packed interleaves them,
        // so the stride is the channel count and the offset is the channel.
        const uint8_t* data =
            f->extended_data ? f->extended_data[planar ? c : 0] : nullptr;
        if (!data) continue;
        Channel& ch = ch_[c];
        const int stride = planar ? 1 : channels;
        const int base = planar ? 0 : c;
        // Once per channel, not once per phase per sample: the taps are the same
        // three arrays for the life of the process and looking them up inside the
        // sample loop was a function call per multiply-accumulate group.
        const double* taps[kPhases] = {};
        for (int p = 1; p < kPhases; ++p) taps[p] = phaseTaps(p);
        for (int n = 0; n < f->nb_samples; ++n) {
            const double v = sampleAt(data, packed, base + n * stride, &known);
            // **Nothing is accumulated from a format nothing here reads.** The
            // alternative is a number read off a pointer cast the wrong way, which
            // is a meter that is confidently wrong; a dark meter is a meter
            // somebody can see is not working.
            if (!known) break;
            const double a = std::fabs(v);
            if (a > ch.peak) ch.peak = a;
            if (a > ch.truePeak) ch.truePeak = a;
            ch.power += v * v;

            // The delay line, shifted by one. Twelve doubles moved per sample per
            // channel is a memmove of 96 bytes and measures as noise beside the
            // thirty-six multiplies below it; a ring index would save it and would
            // make the tap loop read the history in a rotation, which is the kind
            // of cleverness that hides an off-by-one in a filter.
            std::memmove(ch.history, ch.history + 1, sizeof(double) * (kTaps - 1));
            ch.history[kTaps - 1] = v;

            // Phase 0 is the sample itself and has already been counted — see
            // `phaseTaps`.
            for (int p = 1; p < kPhases; ++p) {
                double y = 0.0;
                for (int i = 0; i < kTaps; ++i) y += taps[p][i] * ch.history[i];
                const double ay = std::fabs(y);
                if (ay > ch.truePeak) ch.truePeak = ay;
            }
        }
        measured = true;
    }
    // **Counted once for the block, not once per channel**, because the count is
    // what each channel's power is divided by and every channel of one block has
    // the same number of samples in it. Gated on something having been read rather
    // than on the channel count: a plane a decoder did not hand over leaves that
    // channel reading silence, which is honest, and must not make the RMS of the
    // ones beside it wrong.
    if (measured && known) samples_ += f->nb_samples;
    if (!known) {
        // Half a block measured is not a reading. Put it back to nothing so that
        // `take` says "no sound heard" rather than quoting the part that happened
        // to be in a format it understood.
        ch_.clear();
        samples_ = 0;
    }
}

bool SoundMeter::take(std::vector<ChannelLevel>* out) {
    if (samples_ <= 0 || ch_.empty()) return false;
    if (out) {
        out->clear();
        out->reserve(ch_.size());
        for (const Channel& ch : ch_) {
            ChannelLevel l;
            l.name = ch.name;
            l.truePeak = static_cast<float>(ch.truePeak);
            l.peak = static_cast<float>(ch.peak);
            l.rms = static_cast<float>(
                std::sqrt(ch.power / static_cast<double>(samples_)));
            out->push_back(std::move(l));
        }
    }
    // Cleared, and **the history is not**: what has been read is the reading, and
    // the samples the interpolator is carrying are the signal. Clearing those too
    // would put a step at every sixtieth of a second for the filter to ring on.
    for (Channel& ch : ch_) {
        ch.peak = 0.0;
        ch.truePeak = 0.0;
        ch.power = 0.0;
    }
    samples_ = 0;
    return true;
}

} // namespace ffmpegbro
