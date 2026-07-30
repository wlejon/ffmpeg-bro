// How loud a block of sound is — the one measurement, wherever sound is metered.
//
// There are three places in this binary that want to know: a capture session's
// device pads, a capture session's graph pads, and the render behind the output
// preview. All three hand over an `AVFrame` and all three want the same answer,
// so the answer lives here rather than three times. It used to live once, as a
// static in ffmpeg_capture.cpp called `measureSound`, which was the right shape
// for as long as only a capture session had sound to measure.
//
// Three decisions are in this file, and each is a claim the meters make about
// themselves.
//
// **Per channel, not one number for the block.** A mono summary is the reading a
// waveform is drawn from, and it hides the one fault a meter is there to catch
// that nothing else can: a stereo pair with a dead side, or a mix whose centre
// channel is ten decibels hot. However many channels the sound has, that many
// readings come back — and they are *named*, by `av_channel_name` on the frame's
// own layout, because "which channel is over" is a question about `FL`/`FC`/`LFE`
// and not about an index somebody has to count out.
//
// **A true peak, not a sample peak — 4× oversampled.** A block's loudest
// *sample* is not its loudest *moment*: the samples are points on a waveform that
// exists between them, and a signal every sample of which is inside full scale
// can pass through +1.5 dBFS on the way. That is not a curiosity, it is what
// clips a converter and what makes a limiter set by a sample-peak meter still
// distort — which is exactly why ITU-R BS.1770 defines its true-peak measurement
// as a 4× oversampled one. So the samples are interpolated and the loudest point
// on the *interpolated* signal is the reading. See `kPhases`.
//
// The sample peak is kept as well, and reported beside it. Not for hedging: the
// distance between the two is itself a reading — a mix with a decibel of
// inter-sample peak in it has been through something that squared its waveform
// off — and having both is what makes it possible to say honestly which is being
// drawn.
//
// **Accumulated until read, and read once.** A block is about a thousand samples
// and a meter looks sixty times a second, so several blocks pass between
// readings: the peak is the loudest of them and the power is summed over all of
// them, so the RMS covers the same stretch the peak does. `take` clears, which is
// what makes this a reading of what has happened *since you last looked* rather
// than a high-water mark for the session — and is why there can be exactly one
// caller.
#pragma once

extern "C" {
#include <libavutil/frame.h>
}

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// How finely the signal between the samples is looked at: **four times the
/// sample rate**, which is BS.1770's own answer and is a choice with a known
/// error either side of it.
///
/// It cannot read *high*: the interpolating filter's overshoot on a steady sine
/// is under 0.001 dB at every frequency and phase measured (100 Hz to 24 kHz in
/// 100 Hz steps, 32 phases each). It can read *low*, and by an amount that is
/// arithmetic rather than a property of the filter: a 4× grid puts its points
/// every `360·f/4fs` degrees of a sine's cycle, so the worst it can miss the top
/// of one by is `cos(180·f/4fs)` — 0.3 dB at 16 kHz, 0.7 dB at 24 kHz, and
/// nothing worth writing down below 8 kHz where the sound a person is metering
/// actually is. 8× would halve that and cost twice as much per sample on every
/// device of every session; the reason to stop at four is that it is the number
/// the standard everybody's other meter implements stopped at.
///
/// The one place it reads high on purpose is a sound that starts *abruptly* — a
/// session's first block, a hard-gated take — where the filter rings on what is
/// mathematically a step and reads about 1 dB over. Every oversampling meter does
/// that, because a step is not a band-limited signal and has no true peak to be
/// wrong about.
constexpr int kPhases = 4;

/// How many input samples the interpolator looks at to place one point between
/// two of them.
///
/// Twelve, which is the ordinary size for this: the filter is a windowed sinc,
/// and the window is what stops the truncation from rippling — the numbers above
/// are the measurement of that working. Six was audibly wrong in the sense that
/// matters here (0.1 dB of overshoot, which would make a meter read an over that
/// was not there); twenty-four was indistinguishable from twelve and costs twice
/// as much on every sample of every channel.
constexpr int kTaps = 12;

/// One channel's reading, over whatever stretch the caller last cleared.
struct ChannelLevel {
    /// libav's own name for it — `FL`, `FR`, `FC`, `LFE`, `BL`… — taken from the
    /// frame's channel layout. A number (`1`, `2`, …) where the layout is
    /// unspecified, which is what a device that never said what its channels mean
    /// produces and is not a reason to refuse to draw it.
    std::string name;
    /// The loudest point on the interpolated signal, which is the reading a meter
    /// labelled "true peak" may be labelled with. Above 1.0 is an over.
    float truePeak = 0.0f;
    /// And the loudest actual sample, which is the weaker of the two readings and
    /// is here so that the difference can be said out loud.
    float peak = 0.0f;
    /// Root mean square over the same stretch — the body of the meter, where the
    /// peaks are its edge.
    float rms = 0.0f;
};

/// One pad's meter: hand it every block, ask it for the reading.
///
/// **It has state between blocks and that is the point.** The interpolator needs
/// the samples either side of the point it is placing, so eleven samples of each
/// channel are carried from one block into the next — without which every block
/// boundary would be a step for the filter to ring on, and a meter would read an
/// over every thousand samples. The state is kept per channel and thrown away
/// when the layout changes, because a pad that has been reconfigured is a
/// different signal.
///
/// Not thread-safe on its own: it is held inside `LivePadTap`, whose lock is what
/// makes "the session measures while the UI reads" safe. See live_tap.h.
class SoundMeter {
public:
    /// Measure one block. Formats this cannot read are ignored — see the note in
    /// the implementation about why that leaves a dark meter rather than a wrong
    /// one.
    void add(const AVFrame* f);

    /// The reading since the last call, **and this clears it**. False when no
    /// sound has been through at all since — which is not silence, and is why the
    /// caller is told rather than handed zeros: a device that has stopped
    /// delivering would otherwise read as one delivering quiet.
    bool take(std::vector<ChannelLevel>* out);

private:
    /// One channel: what it has done since the last read, and the tail of it the
    /// interpolator still needs.
    struct Channel {
        std::string name;
        double peak = 0.0;       ///< loudest sample
        double truePeak = 0.0;   ///< loudest interpolated point
        double power = 0.0;      ///< sum of sample², for the RMS
        /// The last `kTaps` samples, oldest first, newest at the end.
        double history[kTaps] = {};
    };

    std::vector<Channel> ch_;
    int64_t samples_ = 0;   ///< per channel, since the last read
};

} // namespace ffmpegbro
