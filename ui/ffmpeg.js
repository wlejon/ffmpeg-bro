// Finding the ffmpeg tools, and asking them what is in a file.
//
// Nothing here links against ffmpeg. Both functions drive the stock `ffmpeg`
// and `ffprobe` executables over pipes, which is what keeps this app's GPL
// obligations its own and out of the MIT engine underneath it.

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? '.exe' : '';

// Where to look, best first. A bundled copy wins so a self-contained download
// behaves predictably even on a machine that also has an old ffmpeg on PATH.
// The bare name is next, and covers every package manager. The explicit
// directories are last and exist for one common annoyance: the user installed
// ffmpeg but the shell that launched us predates the PATH change.
function candidates(tool) {
    const name = tool + EXE;
    const list = [path.join(bro.appDir, 'bin', name), name];

    if (process.platform === 'win32') {
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        list.push(path.join(pf, 'ffmpeg', 'bin', name));
        if (process.env.LOCALAPPDATA) {
            // winget's default install location.
            list.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet',
                                'Links', name));
        }
    } else {
        list.push('/opt/homebrew/bin/' + name,   // Apple silicon Homebrew
                  '/usr/local/bin/' + name,      // Intel Homebrew, manual installs
                  '/usr/bin/' + name);
    }
    return list;
}

// `<tool> -version` prints the version on line 1 and the build's configure
// flags a few lines down. Both are worth keeping: the flags are how we know
// whether this build actually has x264/NVENC, rather than guessing and letting
// the user discover it when an export fails.
async function identify(candidate) {
    let out;
    try {
        const r = await cp.execFile(candidate, ['-hide_banner', '-version']);
        out = r.stdout;
    } catch (e) {
        return null;                              // not here, or not runnable
    }

    const version = (out.match(/version\s+(\S+)/) || [])[1] || 'unknown';
    const config = (out.match(/configuration:(.*)/) || [])[1] || '';
    const has = (flag) => config.indexOf('--enable-' + flag) !== -1;

    return {
        path: candidate,
        version,
        // What the license actually permits, read off the build rather than
        // assumed. A --enable-gpl build is the one worth having.
        gpl: has('gpl'),
        nonfree: has('nonfree'),
        encoders: {
            x264: has('libx264'),
            x265: has('libx265'),
            svtav1: has('libsvtav1'),
            aom: has('libaom'),
            vpx: has('libvpx'),
            nvenc: has('nvenc'),
            qsv: has('libvpl') || has('libmfx'),
            amf: has('amf'),
            videotoolbox: has('videotoolbox'),
            vaapi: has('vaapi'),
        },
    };
}

// Resolve both tools. Returns { ok, ffmpeg, ffprobe, error } — never throws, so
// the UI can render a "here's how to install it" state instead of a stack.
export async function locateTools() {
    const found = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
        for (const c of candidates(tool)) {
            const info = await identify(c);
            if (info) { found[tool] = info; break; }
        }
    }

    if (!found.ffmpeg || !found.ffprobe) {
        const missing = ['ffmpeg', 'ffprobe'].filter((t) => !found[t]);
        return {
            ok: false,
            error: 'Could not find ' + missing.join(' and ') +
                   '. Install ffmpeg and put it on PATH, or drop the ' +
                   'executables in ' + path.join(bro.appDir, 'bin') + '.',
            ...found,
        };
    }
    return { ok: true, ...found };
}

// "30000/1001" → 29.97. ffprobe reports every rate as a rational, including
// "0/0" for streams that have no meaningful frame rate.
function rational(str) {
    if (!str) return 0;
    const [n, d] = str.split('/').map(Number);
    if (!d) return 0;
    return n / d;
}

// Read what is actually in a file. `file` may be any spelling bro.resolvePath
// accepts; ffprobe gets a real absolute path, passed as its own argv entry so
// a name full of shell metacharacters survives.
export async function probe(tools, file) {
    const abs = bro.resolvePath(file);
    if (!fs.existsSync(abs)) throw new Error('No such file: ' + abs);

    const { stdout } = await cp.execFile(tools.ffprobe.path, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        abs,
    ]);

    const raw = JSON.parse(stdout);
    const streams = raw.streams || [];
    const video = streams.find((s) => s.codec_type === 'video') || null;
    const audio = streams.find((s) => s.codec_type === 'audio') || null;

    return {
        path: abs,
        name: path.basename(abs),
        format: {
            name: (raw.format && raw.format.format_name) || '',
            longName: (raw.format && raw.format.format_long_name) || '',
            duration: Number((raw.format && raw.format.duration) || 0),
            size: Number((raw.format && raw.format.size) || 0),
            bitRate: Number((raw.format && raw.format.bit_rate) || 0),
        },
        video: video && {
            index: video.index,
            codec: video.codec_name,
            profile: video.profile || '',
            width: video.width,
            height: video.height,
            pixFmt: video.pix_fmt,
            // avg_frame_rate is the one to pace playback against; r_frame_rate
            // is the container's nominal rate and lies on variable-rate files.
            fps: rational(video.avg_frame_rate) || rational(video.r_frame_rate),
            // Rotation lives in a side-data entry, and ignoring it is why
            // phone video plays sideways.
            rotation: readRotation(video),
        },
        audio: audio && {
            index: audio.index,
            codec: audio.codec_name,
            channels: audio.channels,
            sampleRate: Number(audio.sample_rate || 0),
            layout: audio.channel_layout || '',
        },
        streams,
        raw,
    };
}

function readRotation(stream) {
    const sd = (stream.side_data_list || []).find((d) => 'rotation' in d);
    if (sd) return ((Number(sd.rotation) % 360) + 360) % 360;
    const tag = stream.tags && stream.tags.rotate;
    return tag ? ((Number(tag) % 360) + 360) % 360 : 0;
}
