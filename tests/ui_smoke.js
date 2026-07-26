// Load the real app UI, drop a file on it, and check the wiring reaches the
// player. app.js does its tool discovery behind a top-level await, so wait for
// that to land before dropping — otherwise the listener isn't registered yet.
function pump(ms) { const n = Math.ceil(ms / 20); for (let i = 0; i < n; i++) { wallSleep(20); advanceTime(20); flush(); } }

for (let i = 0; i < 100 && document.getElementById('toolstatus').textContent.indexOf('looking') === 0; i++) pump(50);
console.log('tools :', document.getElementById('toolstatus').textContent);

dropFiles(400, 300, ['C:/Users/jonny/AppData/Local/Temp/claude/D--projects-bro/2d6cc033-cfb4-455d-a464-6ba2971560a8/scratchpad/media/clip.mp4']);
pump(1500);

const info = document.getElementById('mediainfo').textContent.replace(/\s+/g, ' ').trim();
const cv = document.getElementById('video');
console.log('info  :', info.slice(0, 220));
console.log('canvas:', cv.className, cv.width + 'x' + cv.height);
console.log('button:', document.getElementById('playpause').disabled ? 'disabled' : 'enabled');

// Play a couple of seconds through the real UI path.
document.getElementById('playpause').click();
pump(2500);
console.log('after play — timecode:', document.getElementById('timecode').textContent,
            '| button:', document.getElementById('playpause').textContent);
screenshot('C:/Users/jonny/AppData/Local/Temp/claude/D--projects-bro/2d6cc033-cfb4-455d-a464-6ba2971560a8/scratchpad/ui_loaded.png');
