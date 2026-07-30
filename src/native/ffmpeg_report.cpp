// The render's back-channel. See ffmpeg_report.h for why it is shaped this way.

#include "ffmpeg_report.h"

extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/dict.h>
#include <libavutil/log.h>
}

#include "util/log.h"

#include <chrono>
#include <cstdarg>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace ffmpegbro {
namespace {

// What is worth keeping — which is more than is worth printing.
//
// A custom callback is handed every level libav ever emits, whatever
// `av_log_get_level()` says, because that check lives in the *default* callback
// this one replaces. So the console keeps the level the backend sets (warnings
// and up) and the report keeps everything down to info: an encoder announcing
// the profile it settled on is noise on a console and the first thing you want
// when a file will not play on a phone. Below this — verbose, debug, trace — is
// a decoder narrating every packet, and the comparison happens before anything
// is formatted, so a graph running at trace level costs one test per line.
constexpr int kCapture = AV_LOG_INFO;

// Five hundred lines is several times what a render that went badly has to say
// — libav is terse, and the noisy case is one filter repeating itself, which
// the drop count states plainly rather than hiding behind a longer buffer.
constexpr size_t kLogSlots = 512;

// Eight thousand samples. `cropdetect` attaches four values a frame, so this is
// half a minute of a busy graph *if nobody is draining* — and the consumer
// drains from its animation frame, so in practice the ring holds one frame's
// worth. It is sized for the case where the UI is not looking, not for the
// whole series: keeping the series is the consumer's job, and a native buffer
// big enough to hold an hour of `ebur128` would be a memory leak with a
// justification attached.
constexpr size_t kMetaSlots = 8192;

/// A fixed ring whose records are numbered rather than moved.
///
/// The numbering is what makes the drain a cursor: seq N is seq N for the life
/// of the process, so two consumers reading at different rates cannot disturb
/// each other and neither can be given the same record twice. Slots are reused
/// in place, so the `std::string`s inside them keep whatever capacity they grew
/// to and the steady state allocates nothing.
template <class T>
struct Ring {
    std::vector<T> slots;
    uint64_t written = 0;

    explicit Ring(size_t n) : slots(n) {}

    /// The lowest sequence number still in the ring.
    uint64_t oldest() const {
        return written > slots.size() ? written - slots.size() + 1 : 1;
    }
    /// The slot the next record goes in. Fill it, then `commit()`.
    T& staging() { return slots[written % slots.size()]; }
    void commit() { ++written; }

    void drain(uint64_t since, int max, std::vector<T>& out,
               uint64_t* cursor, uint64_t* dropped) const {
        const uint64_t low = oldest();
        uint64_t from = since == 0 ? low : since;
        *dropped = 0;
        // A caller who has been away long enough for the ring to have wrapped
        // is told how much it lost. A caller who has never asked (`since` 0)
        // has lost nothing it was promised, so starting up is not a "drop".
        if (from < low) { *dropped = low - from; from = low; }
        uint64_t to = written;
        if (to >= from && to - from + 1 > static_cast<uint64_t>(max))
            to = from + static_cast<uint64_t>(max) - 1;
        for (uint64_t s = from; s <= to; ++s)
            out.push_back(slots[(s - 1) % slots.size()]);
        *cursor = to >= from ? to + 1 : from;
    }
};

struct Channel {
    std::mutex mu;
    Ring<LogRecord> logs{kLogSlots};
    Ring<MetaRecord> meta{kMetaSlots};
    std::chrono::steady_clock::time_point began = std::chrono::steady_clock::now();
    bool installed = false;

    // The render whose name goes on everything said right now. Read from the
    // log callback on arbitrary threads, so it is written under the same lock
    // and copied rather than referenced.
    uint64_t job = 0;
    uint64_t jobs = 0;

    /// What the fifo muxer said about losing and regaining its destination.
    /// Under the same lock as everything else here, because it is written from
    /// fifo's own thread and read from the render's. See `WriteRecovery`.
    WriteRecovery recovery;

    // libav writes some lines in pieces — `av_dump_format` is the worst
    // offender, and an encoder's summary is not much better. A chunk with no
    // trailing newline is a line that is not finished, which
    // `av_log_format_line2` reports back through `print_prefix`. Held here and
    // flushed on the newline, or when a different component starts talking,
    // because a report full of three-character records would be worse than one
    // that occasionally splits a line.
    std::string pending;
    std::string pendingSource;
    int pendingLevel = 0;
    uint64_t pendingJob = 0;
    double pendingAt = 0.0;
};

Channel& channel() {
    static Channel c;
    return c;
}

double now(const Channel& c) {
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - c.began).count();
}

/// Called with the lock held.
void commitLog(Channel& c, uint64_t job, double at, int level,
               const std::string& source, const std::string& text) {
    if (text.empty()) return;
    LogRecord& r = c.logs.staging();
    r.seq = c.logs.written + 1;
    r.job = job;
    r.at = at;
    r.level = level;
    r.source = source;
    r.text = text;
    c.logs.commit();
}

/// Called with the lock held.
void flushPending(Channel& c) {
    if (c.pending.empty()) return;
    commitLog(c, c.pendingJob, c.pendingAt, c.pendingLevel, c.pendingSource, c.pending);
    c.pending.clear();
    c.pendingSource.clear();
}

/// Who said it. The `AVClass` at the head of every libav context is how ffmpeg
/// itself labels its own log lines: `item_name` gives an encoder's codec name,
/// a filter's instance name and a muxer's format name, which is the difference
/// between "a warning" and "a warning from libx264".
const char* sourceOf(void* ptr) {
    if (!ptr) return "";
    AVClass* const* holder = static_cast<AVClass* const*>(ptr);
    const AVClass* cls = *holder;
    if (!cls) return "";
    const char* name = cls->item_name ? cls->item_name(ptr) : nullptr;
    if (!name || !*name) name = cls->class_name;
    return name ? name : "";
}

/// How many `LogQuiet` guards this thread is inside. Per-thread on purpose:
/// asking libav a question on the UI thread must not cost the render thread
/// its words.
thread_local int g_quiet = 0;

void capture(void* ptr, int level, const char* fmt, va_list vl) {
    if (g_quiet > 0) return;
    // The console and the report want different amounts of the same stream, and
    // this is the only place that can serve both: `av_log_set_level` governs
    // what is *printed* — warnings and errors, so that a windowed build's log
    // is readable — while the report keeps everything down to info whether or
    // not anybody is looking. libav writes to stderr by default, which for a
    // windowed build goes nowhere, so the printing half routes into bro's
    // logger with everything else.
    const bool print = level <= av_log_get_level();
    if (!print && level > kCapture) return;

    char line[1024];
    int prefix = 0;                 // no prefix: the source is a field of its own
    {
        va_list copy;
        va_copy(copy, vl);
        av_log_format_line2(ptr, level, fmt, copy, line, sizeof(line), &prefix);
        va_end(copy);
    }
    if (!line[0]) return;

    // `av_log_format_line2` leaves `prefix` set when the message ended with a
    // newline — which is precisely "this line is complete".
    const bool complete = prefix != 0;
    size_t len = std::strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    if (!len) return;

    const char* src = sourceOf(ptr);

    // **The one place a recovery can be counted**, because the fifo muxer keeps
    // no counter and publishes nothing. These three strings are
    // libavformat/fifo.c's own, verbatim: `Recovery successful` and
    // `Recovery failed: <err>` at AV_LOG_INFO, `FIFO queue full` at
    // AV_LOG_WARNING. Matched on the front of the line so the error text and any
    // future suffix do not matter, and only for a line the fifo muxer itself
    // said — an AVFormatContext's `item_name` is its format's name, so `src` is
    // exactly "fifo" and a filter or an encoder using the same word cannot be
    // mistaken for one. The prefixes are the fragile part of this and they are
    // the only fragile part: a libav that reworded them makes the count read
    // zero, which is the safe direction and is what the render's note says when
    // there is nothing to report.
    if (src && std::strcmp(src, "fifo") == 0) {
        Channel& c = channel();
        std::lock_guard<std::mutex> lock(c.mu);
        if (std::strncmp(line, "Recovery successful", 19) == 0) ++c.recovery.recovered;
        else if (std::strncmp(line, "Recovery failed", 15) == 0) ++c.recovery.failed;
        else if (std::strncmp(line, "FIFO queue full", 15) == 0) ++c.recovery.overflowed;
    }

    if (print) {
        if (level <= AV_LOG_ERROR)        LOG_ERROR("ffmpeg: %s", line);
        else if (level <= AV_LOG_WARNING) LOG_WARN("ffmpeg: %s", line);
        else                              LOG_INFO("ffmpeg: %s", line);
    }
    if (level > kCapture) return;

    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    const double at = now(c);
    if (!c.pending.empty() &&
        (c.pendingLevel != level || c.pendingSource != src || c.pending.size() > 4000))
        flushPending(c);
    if (c.pending.empty()) {
        c.pendingSource = src;
        c.pendingLevel = level;
        c.pendingJob = c.job;
        c.pendingAt = at;
    }
    c.pending.append(line, len);
    if (complete) flushPending(c);
}

} // namespace

LogQuiet::LogQuiet() { g_quiet++; }
LogQuiet::~LogQuiet() { g_quiet--; }

void installLogCapture() {
    Channel& c = channel();
    {
        std::lock_guard<std::mutex> lock(c.mu);
        if (c.installed) return;
        c.installed = true;
        c.began = std::chrono::steady_clock::now();
    }
    av_log_set_callback(capture);
}

uint64_t beginRenderReport() {
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    // Whatever was half-said belongs to whoever was speaking, not to the render
    // about to start.
    flushPending(c);
    // Zeroed with the job number rather than at the end of one, so that a render
    // reading its own tally reads what happened during *it*.
    c.recovery = WriteRecovery{};
    c.job = ++c.jobs;
    return c.job;
}

void endRenderReport() {
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    flushPending(c);
    c.job = 0;
}

WriteRecovery writeRecovery() {
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    return c.recovery;
}

uint64_t currentRenderJob() {
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    return c.job;
}

void reportNote(int level, const char* source, const std::string& text) {
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    flushPending(c);
    commitLog(c, c.job, now(c), level, source ? source : "render", text);
}

void reportFrameMetadata(bool audio, double at, const AVDictionary* meta) {
    if (!meta) return;
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    const AVDictionaryEntry* e = nullptr;
    while ((e = av_dict_iterate(meta, e))) {
        if (!e->key || !e->value) continue;
        MetaRecord& r = c.meta.staging();
        r.seq = c.meta.written + 1;
        r.job = c.job;
        r.at = at;
        r.stream = audio ? "audio" : "video";
        r.key = e->key;
        r.value = e->value;
        c.meta.commit();
    }
}

ReportDrain drainReport(uint64_t sinceLog, uint64_t sinceMeta, int max) {
    if (max <= 0) max = 512;
    ReportDrain out;
    Channel& c = channel();
    std::lock_guard<std::mutex> lock(c.mu);
    // What a render said last is usually the thing worth reading, and libav's
    // last word before a failure routinely arrives without its newline. Flushed
    // on the way out rather than left waiting for a line that may never come.
    flushPending(c);
    c.logs.drain(sinceLog, max, out.logs, &out.logCursor, &out.logsDropped);
    c.meta.drain(sinceMeta, max, out.meta, &out.metaCursor, &out.metaDropped);
    out.job = c.job;
    return out;
}

const char* logLevelName(int level) {
    if (level <= AV_LOG_PANIC) return "panic";
    if (level <= AV_LOG_FATAL) return "fatal";
    if (level <= AV_LOG_ERROR) return "error";
    if (level <= AV_LOG_WARNING) return "warning";
    if (level <= AV_LOG_INFO) return "info";
    if (level <= AV_LOG_VERBOSE) return "verbose";
    if (level <= AV_LOG_DEBUG) return "debug";
    return "trace";
}

int logCapacity() { return static_cast<int>(kLogSlots); }

} // namespace ffmpegbro
