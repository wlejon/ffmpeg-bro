import { locateTools, probe } from '/app/ffmpeg.js';

const tools = await locateTools();
console.log('ok      =', tools.ok, tools.error || '');
if (tools.ok) {
    console.log('ffmpeg  =', tools.ffmpeg.version, tools.ffmpeg.path);
    console.log('ffprobe =', tools.ffprobe.version);
    console.log('gpl     =', tools.ffmpeg.gpl, 'nonfree =', tools.ffmpeg.nonfree);
    console.log('enc     =', Object.entries(tools.ffmpeg.encoders).filter(([,v])=>v).map(([k])=>k).join(' '));
}
