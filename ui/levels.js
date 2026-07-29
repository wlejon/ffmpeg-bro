// The scale sound is drawn on, wherever it is drawn.
//
// One home, because there are two places and they are answering the same
// question. A1 draws the mix of the timeline; the Capture stage draws what a
// live session's microphone is doing right now. A person looking at one and
// then the other is comparing them, and two scales that disagreed by a decibel
// would make that comparison a lie — quietly, since neither is labelled with
// its own floor.
//
// **Decibels relative to full scale, floor to ceiling.** Amplitude is the wrong
// scale to judge sound by eye and it was the scale here. Hearing is roughly
// logarithmic, so a linear lane spends half its height on the top 6 dB and
// crushes everything from a quiet dialogue line down to silence into the last
// few pixels — where all of the decisions actually are. On this scale a halving
// of amplitude is the same distance wherever it happens.

/// Silence, at the bottom of whatever is drawn.
///
/// -60 rather than lower because below it there is nothing to judge: a bucket
/// at -70 dBFS and one at -90 are both "silent" to the person looking, and
/// drawing the difference would spend a third of the height on it.
export const DB_FLOOR = -60;

/// **Above 0 dBFS on purpose.** A mix is a sum and a sum can exceed full scale,
/// and that is the single most useful thing either drawing can say. Clamping at
/// 1.0 draws an over as exactly full height — identical to a peak that just
/// touches, and therefore invisible. +6 gives an over somewhere to go and puts
/// the full-scale line about a tenth of the way down from the top, which is
/// where a meter puts it.
export const DB_CEIL = 6;

/// Amplitude → how far along the scale to draw it, 0 at the floor and below,
/// 1 at the ceiling and above.
///
/// Exported and checkable, because the drawing is not: the values a test pins
/// are the ones the eye is being asked to read off.
export function dbHeight(amp) {
    const a = Math.abs(amp);
    if (!(a > 0)) return 0;
    const db = 20 * Math.log10(a);
    if (db <= DB_FLOOR) return 0;
    if (db >= DB_CEIL) return 1;
    return (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
}

/// Where full scale falls — the fraction the clipping line is drawn at, and the
/// height a reading has to beat to be over.
export const ZERO_DBFS = dbHeight(1);

/// The number to put beside a meter. dBFS, with `-inf` for silence rather than
/// the -1734 that `20*log10` of a denormal produces.
export function dbLabel(amp) {
    const a = Math.abs(amp);
    if (!(a > 0)) return '-∞';
    const db = 20 * Math.log10(a);
    if (db <= DB_FLOOR) return `<${DB_FLOOR}`;
    return (db >= 0 ? '+' : '') + db.toFixed(1);
}
