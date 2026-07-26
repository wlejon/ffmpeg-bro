import { locateTools, probe } from '/app/ffmpeg.js';
const tools = await locateTools();
for (const f of ['C:/Users/jonny/AppData/Local/Temp/claude/D--projects-bro/2d6cc033-cfb4-455d-a464-6ba2971560a8/scratchpad/media/clip.mp4', 'C:/Users/jonny/AppData/Local/Temp/claude/D--projects-bro/2d6cc033-cfb4-455d-a464-6ba2971560a8/scratchpad/media/awkward & name (v2).mp4']) {
    const info = await probe(tools, f);
    console.log(info.name, '|', info.format.name, info.format.duration.toFixed(2) + 's',
                '|', info.video.codec, info.video.width + 'x' + info.video.height,
                info.video.fps.toFixed(3) + 'fps', info.video.pixFmt, 'rot' + info.video.rotation,
                '| audio', info.audio.codec, info.audio.channels + 'ch', info.audio.sampleRate);
}
