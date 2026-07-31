// A stream site's *page* URL, turned into something libavformat can open.
//
// `https://www.twitch.tv/videos/2832781833` is a web page. Handed to
// `avformat_open_input` it fetches HTML, finds no demuxer, and comes back with
// "Invalid data found when processing input" — which is libavformat being
// exactly right and is not a useful thing for a person to be told.
//
// One HTTP round trip turns it into an HLS master playlist, and **this build
// already links both halves of what is needed**: `https` is in the protocol
// list and `hls` is in the demuxer list, so once the playlist URL is in hand it
// is an ordinary `-i` and nothing downstream has to learn anything. So the
// resolution belongs here rather than in a tool somebody is sent away to go and
// find.
//
// Three things about it are load-bearing.
//
// **Nothing is downloaded.** What comes back is a URL, and it is handed to the
// input list as a URL. A five-hour VOD costs one HTTP request until something
// asks for a range of it, at which point libavformat pulls exactly the segments
// that range covers. That is the whole reason this is worth doing in the
// application rather than shelling out to a downloader: the ordinary tools
// fetch the entire recording to disk before you can look at a minute of it.
//
// **Every rendition is kept, not just the best one.** One VOD is two different
// jobs — the picture at 1080p60 for the cut, and `Audio Only` at a fraction of
// the bytes for a transcription pass — and a resolver that answered with "the
// best stream" would make the second one cost the first one's bandwidth.
//
// **The signed URL expires.** What Twitch returns is a token with a signature
// and a lifetime; a document that stored the resolved URL would open, tomorrow,
// against a 403. So the *page* URL is what a document keeps and this runs again
// on the way in — which is `resolve()` being cheap by design.
//
// Twitch is the one site here. The shape is a table so that a second one is a
// table entry: match the page, ask its API, return renditions.

/// The public client-id Twitch's own web player sends with every unauthenticated
/// playback request. It identifies the *player*, not a person, and there is no
/// account, key or login anywhere on this path — which is why a VOD anybody can
/// watch in a browser is a VOD this can open.
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

/// The persisted-query hash for `PlaybackAccessToken`. Twitch's GraphQL endpoint
/// takes either a query document or the hash of one it already knows; the hash
/// is what the web player sends and is what this sends for the same reason.
const TWITCH_PAT_HASH =
    '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712';

/// Which sites this can turn a page into a stream for.
///
/// `match` answers with the id if the URL is one of ours and '' otherwise, so
/// adding a site is adding a row rather than editing a chain of `if`s.
const SITES = [
    {
        name: 'Twitch',
        what: 'VOD',
        match: (url) => {
            const m = /(?:^|\/\/)(?:www\.)?twitch\.tv\/videos\/(\d+)/i.exec(url);
            return m ? m[1] : '';
        },
        resolve: twitchVod,
    },
];

/// Is this a page this application knows how to open?
///
/// Deliberately a *recognition* and not a guess: an unknown URL is left exactly
/// as it was typed, because libavformat opens far more URLs than this file knows
/// about and a resolver that swallowed them would be a downgrade.
export function siteFor(url) {
    const s = String(url || '');
    for (const site of SITES) if (site.match(s)) return site;
    return null;
}

export const looksLikePage = (url) => !!siteFor(url);

/// The page, resolved.
///
/// Answers `{ site, id, label, url, renditions }` where `url` is the rendition
/// this application would pick on its own and `renditions` is all of them, best
/// first. Throws with a sentence naming what failed — a person who pasted a link
/// wants to know whether the VOD is private, deleted or merely mistyped, and
/// those are three different messages.
export async function resolve(url) {
    const site = siteFor(url);
    if (!site) throw new Error(`${url} is not a page this application can open`);
    return site.resolve(site, site.match(String(url)), String(url));
}

// ── Twitch ─────────────────────────────────────────────────────────────────

async function twitchVod(site, id, pageUrl) {
    let token;
    try {
        const res = await fetch('https://gql.twitch.tv/gql', {
            method: 'POST',
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                operationName: 'PlaybackAccessToken',
                variables: {
                    isLive: false, login: '', isVod: true,
                    vodID: id, playerType: 'embed',
                },
                extensions: {
                    persistedQuery: { version: 1, sha256Hash: TWITCH_PAT_HASH },
                },
            }),
        });
        if (!res.ok) throw new Error(`Twitch answered ${res.status}`);
        const body = await res.json();
        token = body && body.data && body.data.videoPlaybackAccessToken;
        // **A missing token is the ordinary case, not a fault.** A VOD that is
        // deleted, subscriber-only or from a channel that hides its past
        // broadcasts comes back with `null` here and a 200 — so the sentence has
        // to say what is actually true, which is that this VOD cannot be played
        // without an account rather than that something went wrong.
        if (!token)
            throw new Error(`Twitch will not hand out a playback token for video ${id} ` +
                            '— it may be deleted, private, or subscriber-only');
    } catch (e) {
        throw new Error(`could not ask Twitch about video ${id}: ${e.message || e}`);
    }

    const usher = `https://usher.ttvnw.net/vod/${id}.m3u8` +
        '?allow_source=true&allow_audio_only=true&player=twitchweb' +
        `&sig=${encodeURIComponent(token.signature)}` +
        `&token=${encodeURIComponent(token.value)}`;

    let playlist;
    try {
        const res = await fetch(usher);
        if (!res.ok) throw new Error(`the playlist server answered ${res.status}`);
        playlist = await res.text();
    } catch (e) {
        throw new Error(`could not fetch the playlist for video ${id}: ${e.message || e}`);
    }

    const renditions = parseMaster(playlist);
    if (!renditions.length)
        throw new Error(`video ${id} resolved to a playlist with nothing playable in it`);

    return {
        site: site.name,
        id,
        page: pageUrl,
        label: `${site.name} ${site.what} ${id}`,
        // Best first — see `parseMaster`. The one this application would open.
        url: renditions[0].url,
        renditions,
    };
}

// ── the master playlist ────────────────────────────────────────────────────

/// The renditions in an HLS master playlist, best first.
///
/// **Parsed rather than handed to libavformat**, which is worth saying because
/// everything else in this repository asks libav rather than reading a format
/// itself. The reason is that the choice is the *point*: `hls` opening the
/// master picks one variant by its own rule and gives back a stream, and what
/// this needs is the list — the picture rendition and the audio-only one are two
/// answers to two different jobs on one recording, and a demuxer that has
/// already chosen has thrown the other away.
///
/// The parse is deliberately shallow: a `NAME` if the playlist gives one, the
/// bandwidth if it gives that, and the URL. Anything cleverer would be a second
/// HLS implementation, and there is one in libavformat for the part that
/// matters.
export function parseMaster(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let pendingName = '';
    let pendingBandwidth = 0;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-MEDIA:')) {
            const m = /NAME="([^"]*)"/.exec(line);
            if (m) pendingName = m[1];
            continue;
        }
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const b = /BANDWIDTH=(\d+)/.exec(line);
            pendingBandwidth = b ? Number(b[1]) : 0;
            const v = /VIDEO="([^"]*)"/.exec(line);
            if (!pendingName && v) pendingName = v[1];
            continue;
        }
        if (line.startsWith('#')) continue;
        out.push({
            name: pendingName || `${Math.round(pendingBandwidth / 1000)} kb/s`,
            bandwidth: pendingBandwidth,
            url: line,
            // The one fact about a rendition that changes which job it is for.
            audioOnly: /audio[_-]?only/i.test(pendingName) ||
                       /audio[_-]?only/i.test(line),
        });
        pendingName = '';
        pendingBandwidth = 0;
    }

    // Best first, and audio-only last whatever its bandwidth says: it is the
    // cheapest stream in the list and the only one that is not a picture, so
    // sorting it to the top by size would make the obvious choice the wrong one.
    return out.sort((a, b) => (a.audioOnly ? 1 : 0) - (b.audioOnly ? 1 : 0) ||
                              b.bandwidth - a.bandwidth);
}

/// The rendition to transcribe from: the audio-only one where there is one, and
/// the smallest picture otherwise.
///
/// A transcription reads the soundtrack and nothing else, so pulling 1080p60
/// segments to feed 16 kHz mono into an encoder is paying for a picture that is
/// decoded and thrown away — on a five-hour VOD that is the difference between
/// a few hundred megabytes and a few tens of gigabytes.
export function forListening(resolved) {
    const list = (resolved && resolved.renditions) || [];
    return list.find((r) => r.audioOnly) || list[list.length - 1] || null;
}
