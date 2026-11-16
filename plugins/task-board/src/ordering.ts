// Fractional position keys.
//
// A key is a base-62 fraction written without the leading "0.": "V" is 0.5,
// "k" is about 0.75. Keys compare with plain string comparison (ASCII order of
// the alphabet below matches digit order), so SQLite's default BINARY collation
// sorts them correctly. A new key always fits strictly between two neighbours,
// so a move touches one row and never renumbers a lane.
//
// No key ends in "0": "a" and "a0" would be the same number, and nothing could
// be placed between them.

export const DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const MAX_DIGIT = DIGITS[BASE - 1]!;

const KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/u;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function digitAt(key: string, index: number): number {
  const char = key[index];
  if (char === undefined) return 0;
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new Error(`invalid position key: ${JSON.stringify(key)}`);
  return value;
}

/**
 * A key strictly between `low` and `high`. `low` null means the start of the
 * lane, `high` null the end. Throws when `low >= high`.
 */
export function keyBetween(low: string | null, high: string | null): string {
  if (low !== null && !isValidKey(low)) {
    throw new Error(`invalid position key: ${JSON.stringify(low)}`);
  }
  if (high !== null && !isValidKey(high)) {
    throw new Error(`invalid position key: ${JSON.stringify(high)}`);
  }
  if (low !== null && high !== null && low >= high) {
    throw new Error(`position keys out of order: ${low} >= ${high}`);
  }
  if (high === null) return keyAfter(low ?? "");
  if (low === null) return keyBefore(high);
  return midpoint(low, high);
}

/**
 * The shortest convenient key after `low`: bump the first digit that has room.
 * Appending to a lane grows keys by one character per 61 appends.
 */
function keyAfter(low: string): string {
  if (low.length === 0) return DIGITS[BASE / 2]!;
  for (let index = 0; index < low.length; index += 1) {
    const digit = digitAt(low, index);
    if (digit < BASE - 1) return low.slice(0, index) + DIGITS[digit + 1];
  }
  // All digits are the maximum ("zz"): extend from the bottom so the next 61
  // appends stay at this length.
  return low + DIGITS[1];
}

/** A key before `high`, preferring short keys; mirror of keyAfter. */
function keyBefore(high: string): string {
  for (let index = 0; index < high.length; index += 1) {
    const digit = digitAt(high, index);
    if (digit >= 2) return high.slice(0, index) + DIGITS[digit - 1];
    if (digit === 1 && index < high.length - 1) {
      // "1x…" → "1" is smaller than "1x…" and does not end in "0".
      return high.slice(0, index + 1);
    }
  }
  return midpoint("", high);
}

/**
 * Digit-by-digit midpoint of two fractions, `low < high`. `low` may be "" (0).
 */
function midpoint(low: string, high: string): string {
  // Shared prefix stays; recurse on the rest.
  let shared = 0;
  while (shared < high.length && (low[shared] ?? "0") === high[shared]) {
    shared += 1;
  }
  if (shared > 0) {
    return high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared));
  }
  const lowDigit = digitAt(low, 0);
  const highDigit = high.length > 0 ? digitAt(high, 0) : BASE;
  if (highDigit - lowDigit > 1) {
    return DIGITS[Math.round((lowDigit + highDigit) / 2)]!;
  }
  // Adjacent first digits.
  if (high.length > 1) {
    // high is "d…"; "d" alone is between low ("c…" or less) and high.
    return high.slice(0, 1);
  }
  // high is the single digit lowDigit+1: keep low's first digit, then go above
  // the rest of low.
  return DIGITS[lowDigit] + midpointAbove(low.slice(1));
}

/** A key strictly between fraction `low` and 1. */
function midpointAbove(low: string): string {
  if (low.length === 0) return DIGITS[BASE / 2]!;
  const first = digitAt(low, 0);
  if (first < BASE - 1) {
    const candidate = DIGITS[Math.round((first + BASE) / 2)]!;
    if (candidate > low[0]!) return candidate;
  }
  return MAX_DIGIT + midpointAbove(low.slice(1));
}

/** `count` evenly spread keys, for seeding a fresh lane list. */
export function spreadKeys(count: number): string[] {
  const keys: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < count; index += 1) {
    previous = keyBetween(previous, null);
    keys.push(previous);
  }
  return keys;
}
