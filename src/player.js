// Playing a file by showing exactly what ffmpeg decoded.
//
// There is no proxy transcode and no intermediate file anywhere in here. Two
// ffmpeg processes decode the source — one to raw RGBA frames, one to raw
// float PCM — and both stream down a pipe. The frames go straight into the
// canvas and the samples straight into bro's live audio ring, so what reaches
// the screen is the decoder's output at full quality, not a re-encode of it.
//
// Sync model: audio is the master clock. The audio ring reports how many
// seconds it has actually consumed, which is the only clock in the system tied
// to something the user can hear. Video frames carry a presentation time and
// are held until that clock reaches them; a frame already past is dropped
// rather than shown late. Nothing tries to speed audio up or slow it down.

import { probe } from '/app/src/ffmpeg.js';

const cp = require('child_process');

// How many decoded frames to keep ahead of the clock. Enough to ride out a
// slow frame or a GC pause, small enough that a seek feels immediate — and
// small enough that 4K RGBA (33 MB/frame) does not become a memory problem.
const QUEUE_TARGET = 8;

export class Player {
    constructor({ tools, canvas, audio }) {
        this.tools = tools;
        this.canvas = canvas;
        this.ctx2d = canvas.getContext('2d');
        this.audio = audio || null;

        this.info = null;
        this.playing = false;

        // Media time, in seconds from the start of the file. Survives
        // pause/seek; the feeds are respawned relative to it.
        this.time = 0;

        this._videoProc = null;
        this._audioProc = null;
        this._stream = null;          // broaudio live PCM stream id
        this._frames = [];            // {pts, data} awaiting their moment
        this._frameBuf = null;        // partial frame being reassembled
        this._fill = 0;
        this._pcmCarry = new Uint8Array(0);   // bytes of a split float sample
        this._epoch = 0;              // media time the current feeds started at
        this._wallStart = 0;          // fallback clock origin
        this._frameIndex = 0;
        this._stats = { shown: 0, dropped: 0, decoded: 0 };

        this.onstatus = null;         // (message) => void
    }

    // ── opening ────────────────────────────────────────────────────────────

    async open(file) {
        this.stop();
        this.info = await probe(this.tools, file);
        if (!this.info.video) throw new Error('No video stream in ' + this.info.name);

        // The canvas holds one decoded frame at native resolution; CSS scales
        // it to fit. Scaling here instead would mean ffmpeg or the CPU
        // resampling every frame for no gain in what the user sees.
        this.canvas.width = this.info.video.width;
        this.canvas.height = this.info.video.height;
        this._frameBuf = new Uint8Array(this.info.video.width * this.info.video.height * 4);

        this.time = 0;
        this._paint(null);
        return this.info;
    }

    get duration() {
        return this.info ? this.info.format.duration : 0;
    }

    // ── transport ──────────────────────────────────────────────────────────

    play() {
        if (!this.info || this.playing) return;
        this.playing = true;
        this._startFeeds(this.time);
    }

    pause() {
        if (!this.playing) return;
        this.time = this._clock();      // freeze where we actually are
        this.playing = false;
        this._stopFeeds();
    }

    seek(seconds) {
        const t = Math.max(0, Math.min(seconds, this.duration));
        const wasPlaying = this.playing;
        this._stopFeeds();
        this.time = t;
        if (wasPlaying) this._startFeeds(t);
        else this._scrubFrame(t);
    }

    stop() {
        this.playing = false;
        this._stopFeeds();
        this.time = 0;
    }

    // ── the feeds ──────────────────────────────────────────────────────────

    _startFeeds(from) {
        const v = this.info.video;
        this._epoch = from;
        this._wallStart = performance.now() / 1000;
        this._primed = false;
        this._lastClock = from;
        this._audioDone = false;
        this._handoff = null;
        this._frameIndex = 0;
        this._frames.length = 0;
        this._fill = 0;
        this._pcmCarry = new Uint8Array(0);

        // -ss before -i seeks by keyframe then decodes forward to the exact
        // time, which is both fast and accurate. -re makes ffmpeg decode at
        // real time instead of as fast as it can: that is what stops a 3 GB/s
        // pipe from racing ahead of playback and filling memory with frames
        // nobody has watched yet.
        const seek = from > 0 ? ['-ss', String(from)] : [];

        const frameBytes = v.width * v.height * 4;
        this._videoProc = cp.spawn(this.tools.ffmpeg.path, [
            '-hide_banner', '-loglevel', 'error',
            ...seek,
            '-re',
            '-i', this.info.path,
            '-an',
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            'pipe:1',
        ], {
            stdio: 'pipe',
            // Sized in whole frames. Too small costs throughput; too large
            // just delays the backpressure that -re already provides.
            highWaterMark: frameBytes * 4,
        });
        this._videoProc.stdout.on('data', (bytes) => this._onVideoBytes(bytes));
        this._videoProc.stderr.on('data', (b) => this._onToolError(b));
        this._videoProc.on('close', () => { this._videoProc = null; });

        if (this.info.audio && this.audio) this._startAudio(seek);
    }

    _startAudio(seek) {
        const channels = Math.min(2, this.info.audio.channels || 1);
        this._channels = channels;
        this._stream = this.audio.createStream(channels);

        // The ring takes samples at the ENGINE rate only, so ffmpeg does the
        // resampling — it is better at it than we would be, and it costs
        // nothing extra in a pass that is already running.
        this._audioProc = cp.spawn(this.tools.ffmpeg.path, [
            '-hide_banner', '-loglevel', 'error',
            ...seek,
            '-re',
            '-i', this.info.path,
            '-vn',
            '-f', 'f32le',
            '-ar', String(this.audio.sampleRate),
            '-ac', String(channels),
            'pipe:1',
        ], { stdio: 'pipe', highWaterMark: 1 << 20 });

        this._audioProc.stdout.on('data', (bytes) => this._onPcmBytes(bytes));
        this._audioProc.stderr.on('data', (b) => this._onToolError(b));
        this._audioProc.on('close', () => { this._audioProc = null; });
    }

    _stopFeeds() {
        if (this._videoProc) { this._videoProc.kill('SIGKILL'); this._videoProc = null; }
        if (this._audioProc) { this._audioProc.kill('SIGKILL'); this._audioProc = null; }
        if (this._stream !== null && this.audio) {
            this.audio.closeStream(this._stream);
            this._stream = null;
        }
        this._frames.length = 0;
    }

    _onToolError(bytes) {
        const msg = new TextDecoder().decode(bytes).trim();
        if (msg && this.onstatus) this.onstatus(msg);
    }

    // ── raw video: bytes in, frames out ────────────────────────────────────
    //
    // A pipe read has nothing to do with a frame boundary: one read can carry
    // half a frame or six frames. Refill a single frame-sized buffer and cut a
    // frame out every time it comes up full.

    _onVideoBytes(chunk) {
        const frameBytes = this._frameBuf.length;
        const fps = this.info.video.fps || 30;
        let off = 0;

        while (off < chunk.length) {
            const take = Math.min(frameBytes - this._fill, chunk.length - off);
            this._frameBuf.set(chunk.subarray(off, off + take), this._fill);
            this._fill += take;
            off += take;

            if (this._fill === frameBytes) {
                this._fill = 0;
                this._stats.decoded++;
                // Constant-rate output: -f rawvideo emits frames at the
                // stream's own rate, so the index IS the timestamp.
                const pts = this._epoch + this._frameIndex++ / fps;
                this._frames.push({ pts, data: this._frameBuf.slice() });
                // Never let a stall turn into unbounded memory. -re should
                // keep this from triggering; if it does, the machine is not
                // keeping up and the oldest frame is the one to lose.
                while (this._frames.length > QUEUE_TARGET * 2) {
                    this._frames.shift();
                    this._stats.dropped++;
                }
            }
        }
    }

    // ── raw audio: bytes in, samples into the ring ─────────────────────────

    _onPcmBytes(chunk) {
        // f32le is 4 bytes per sample and a read can split one, so carry the
        // remainder into the next chunk rather than misaligning everything
        // after it.
        let bytes = chunk;
        if (this._pcmCarry.length) {
            const merged = new Uint8Array(this._pcmCarry.length + chunk.length);
            merged.set(this._pcmCarry, 0);
            merged.set(chunk, this._pcmCarry.length);
            bytes = merged;
        }
        const usable = bytes.length - (bytes.length % 4);
        this._pcmCarry = bytes.slice(usable);
        if (!usable) return;

        // Copy into an aligned buffer: a Float32Array view needs its offset to
        // be a multiple of 4, and a pipe read gives no such guarantee.
        const aligned = bytes.slice(0, usable);
        const samples = new Float32Array(aligned.buffer, aligned.byteOffset, usable / 4);
        this.audio.pushStreamSamples(this._stream, samples);
    }

    // ── the clock, and the frame it selects ────────────────────────────────

    _clock() {
        const t = this._readClock();
        // A media clock must never go backwards. Every source below can, for
        // its own reason, so enforce it in one place rather than trusting
        // three of them.
        if (t > this._lastClock) this._lastClock = t;
        return this._lastClock;
    }

    _readClock() {
        if (this._stream !== null && this.audio && !this._audioDone) {
            const s = this.audio.getStreamStats(this._stream);
            if (s) {
                // Only REAL audio counts. A starved ring keeps emitting
                // silence and counting it as played, so the raw position runs
                // away from the picture during any hiccup — and at startup,
                // where the ring sits empty for as long as ffmpeg takes to
                // open the file, that alone put the clock most of a second
                // ahead of the first frame.
                const heard = (s.playedFrames - s.underrunFrames) / this.audio.sampleRate;

                // Once the audio process is gone and the ring has drained,
                // this number stops being a clock: playedFrames freezes while
                // underrunFrames climbs forever, so the difference SHRINKS.
                // Hand over to the wall clock from wherever audio left off.
                if (!this._audioProc && s.bufferedFrames <= 0) {
                    this._audioDone = true;
                    this._handoff = {
                        at: performance.now() / 1000,
                        media: this._epoch + Math.max(0, heard),
                    };
                } else if (heard > 0) {
                    return this._epoch + heard;
                }
            }
        }

        if (this._handoff) {
            return this._handoff.media + (performance.now() / 1000 - this._handoff.at);
        }
        if (!this.playing) return this.time;
        return this._epoch + (performance.now() / 1000 - this._wallStart);
    }

    // Call once per displayed frame. Shows the newest frame whose time has
    // come and discards any that are already late.
    tick() {
        if (!this.playing) return;

        // Don't start the clock until there is something to show. Spawning
        // ffmpeg, opening the file and decoding to the first frame takes a few
        // hundred milliseconds; a clock started at spawn time has already run
        // past those frames by the time they arrive, and the run opens by
        // throwing away everything it just decoded.
        if (!this._primed) {
            const feedsDone = !this._videoProc && !this._audioProc;
            if (this._frames.length < 2 && !feedsDone) return;
            this._primed = true;
            this._wallStart = performance.now() / 1000;
            if (this._handoff) this._handoff.at = this._wallStart;
        }

        const now = this._clock();
        let due = null;
        while (this._frames.length && this._frames[0].pts <= now) {
            if (due) this._stats.dropped++;
            due = this._frames.shift();
        }
        if (due) { this._paint(due.data); this._stats.shown++; }

        this.time = now;

        // Both feeds gone and nothing left to show: that is the end of the
        // file, not a stall.
        if (!this._videoProc && !this._audioProc && !this._frames.length) {
            this.playing = false;
            this.time = this.duration;
            if (this.onended) this.onended();
        }
    }

    // A single frame at a given time, for scrubbing while paused. No -re here:
    // we want the one frame as fast as ffmpeg can produce it.
    _scrubFrame(t) {
        const v = this.info.video;
        const proc = cp.spawn(this.tools.ffmpeg.path, [
            '-hide_banner', '-loglevel', 'error',
            '-ss', String(t),
            '-i', this.info.path,
            '-frames:v', '1',
            '-an',
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            'pipe:1',
        ], { stdio: 'pipe', highWaterMark: v.width * v.height * 4 * 2 });

        const buf = new Uint8Array(v.width * v.height * 4);
        let fill = 0;
        proc.stdout.on('data', (bytes) => {
            const take = Math.min(buf.length - fill, bytes.length);
            buf.set(bytes.subarray(0, take), fill);
            fill += take;
        });
        proc.on('close', () => { if (fill === buf.length) this._paint(buf); });
    }

    // ── painting ───────────────────────────────────────────────────────────

    _paint(rgba) {
        const { width, height } = this.canvas;
        if (!rgba) {
            this.ctx2d.fillStyle = '#000';
            this.ctx2d.fillRect(0, 0, width, height);
            return;
        }
        // A view, not a copy: ImageData wraps the same bytes the pipe filled.
        const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
        this.ctx2d.putImageData(new ImageData(clamped, width, height), 0, 0);
    }

    get stats() {
        return { ...this._stats, queued: this._frames.length };
    }
}
