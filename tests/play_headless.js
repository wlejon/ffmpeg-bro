// Drive the player end to end: real ffmpeg, real frames, real audio ring.
//
// Headless has no audio device, so the ring only drains when advanceTime
// renders. Advance by the REAL elapsed time each pass so it drains at the rate
// a device would. Date.now() is the real clock here; performance.now() is
// virtual and moves ONLY when advanceTime says so, so driving the loop from it
// would just feed itself zeros.
import { locateTools } from '/app/ffmpeg.js';
import { Player } from '/app/player.js';

const tools = await locateTools();
if (!tools.ok) { console.log('SKIP:', tools.error); }
else {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const audio = new AudioContext();
    const p = new Player({ tools, canvas, audio });
    p.onstatus = (m) => console.log('[ffmpeg]', m);

    const info = await p.open('C:/Users/jonny/AppData/Local/Temp/claude/D--projects-bro/2d6cc033-cfb4-455d-a464-6ba2971560a8/scratchpad/media/clip.mp4');
    console.log('opened', info.name, info.video.width + 'x' + info.video.height,
                info.video.fps + 'fps', info.format.duration + 's',
                '| audio', info.audio.codec, info.audio.channels + 'ch @', audio.sampleRate);

    p.play();
    const t0 = Date.now();
    let last = t0, ticks = 0;
    while (p.playing && Date.now() - t0 < 12000) {
        wallSleep(4);
        const now = Date.now();
        if (now > last) { advanceTime(now - last); last = now; }
        p.tick();
        if (++ticks % 150 === 0) {
            const s = p.stats;
            const a = audio.getStreamStats(p._stream);
            console.log('t=' + p.time.toFixed(2), 'shown=' + s.shown, 'dec=' + s.decoded,
                        'drop=' + s.dropped, 'q=' + s.queued,
                        a ? '| played=' + (a.playedFrames/audio.sampleRate).toFixed(2) +
                            ' under=' + (a.underrunFrames/audio.sampleRate).toFixed(2) +
                            ' buf=' + (a.bufferedFrames/audio.sampleRate).toFixed(2) : '| no audio');
        }
    }
    const s = p.stats;
    console.log('FINAL time=' + p.time.toFixed(2) + 's wall=' + ((Date.now()-t0)/1000).toFixed(2) + 's',
                'shown=' + s.shown, 'dec=' + s.decoded, 'drop=' + s.dropped,
                '| expected ~' + Math.round(info.format.duration * info.video.fps) + ' frames');
    screenshot('C:/Users/jonny/AppData/Local/Temp/claude/D--projects-bro/2d6cc033-cfb4-455d-a464-6ba2971560a8/scratchpad/play_frame.png');
    p.stop();
}
