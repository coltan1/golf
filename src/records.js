/**
 * records.js — what you did last time, and the best you have ever done.
 *
 * A round of golf against nobody has no stakes. The score at the end is a
 * number with nothing to compare it to, so a bad start makes the rest of the
 * round pointless and a good one has nothing to lose. Both of those end with
 * the tab closed.
 *
 * The fix is not to add pressure — it is to give every single hole something
 * at stake that survives the round going wrong. Two things do that:
 *
 *   YOUR BEST. Per hole and per course, kept between visits. Hole seven has a
 *     three on it whatever your card says, and that three is worth chasing on
 *     its own.
 *   YOUR STREAK. Consecutive holes at par or better. It is short-lived and it
 *     is yours, and it makes the eighth hole of a ruined round matter.
 *
 * Deliberately not built: streaks that punish a day off, rewards for showing
 * up rather than for playing well, or anything that is better the longer it is
 * left running. Those make a game hard to stop rather than good to play, and
 * they are somebody else's idea of engagement.
 */

const KEY = 'sunnylinks.records.v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private mode */ }
}

let db = load();

const courseOf = (id) => (db[id] ??= { holes: {}, round: null, rounds: 0 });

// ---------------------------------------------------------------- holes
/** The fewest strokes ever taken on this hole, or null. */
export function bestHole(courseId, holeIndex) {
  return courseOf(courseId).holes[holeIndex] ?? null;
}

/**
 * File a hole. Returns what happened, so the caller can say so.
 *
 * `first` and `beaten` are told apart on purpose: a first score on a hole is
 * not an achievement and announcing it as one devalues the times it is.
 */
export function recordHole(courseId, holeIndex, strokes) {
  const c = courseOf(courseId);
  const was = c.holes[holeIndex] ?? null;
  const first = was === null;
  const beaten = !first && strokes < was;
  if (first || beaten) { c.holes[holeIndex] = strokes; save(db); }
  return { first, beaten, best: c.holes[holeIndex], previous: was };
}

// ---------------------------------------------------------------- rounds
/** Best completed round on this course, relative to par, or null. */
export function bestRound(courseId) {
  return courseOf(courseId).round ?? null;
}

export function roundsPlayed(courseId) {
  return courseOf(courseId).rounds ?? 0;
}

export function recordRound(courseId, toPar) {
  const c = courseOf(courseId);
  const was = c.round ?? null;
  const first = was === null;
  const beaten = !first && toPar < was;
  c.rounds = (c.rounds ?? 0) + 1;
  if (first || beaten) c.round = toPar;
  save(db);
  return { first, beaten, best: c.round, previous: was };
}

// ---------------------------------------------------------------- streak
//
// In memory only, and gone when the tab closes. A streak that survives being
// away is a debt you come back to rather than a run you are on, and the whole
// value of this one is that it is happening now.
let streak = 0;
let bestStreak = 0;

export function streakNow() { return streak; }
export function streakBest() { return bestStreak; }

/** Par or better keeps it alive; anything else ends it. Returns the new run. */
export function scoreStreak(strokes, par) {
  if (strokes <= par) {
    streak += 1;
    bestStreak = Math.max(bestStreak, streak);
  } else {
    streak = 0;
  }
  return streak;
}

export function resetStreak() { streak = 0; }

/** Wipe everything. For the console, and for anyone who wants a clean slate. */
export function clearRecords() {
  db = {};
  streak = 0;
  bestStreak = 0;
  save(db);
}
