import { describe, expect, it } from "vitest";
import { isValidKey, keyBetween, spreadKeys } from "../src/ordering";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("keyBetween", () => {
  it("orders keys between their neighbours as plain strings", () => {
    const a = keyBetween(null, null);
    expect(a).toBe("V");
    const b = keyBetween(a, null);
    const c = keyBetween(null, a);
    const d = keyBetween(c, a);
    expect([c, d, a, b]).toEqual([c, d, a, b].slice().sort());
    for (const key of [a, b, c, d]) expect(isValidKey(key)).toBe(true);
  });

  it("handles adjacent digits, shared prefixes and the alphabet edges", () => {
    const cases: Array<[string | null, string | null]> = [
      ["V", "W"],
      ["V", "VV"],
      ["Vz", "W"],
      ["zz", null],
      [null, "1"],
      [null, "01"],
      ["1", "2"],
      ["0V", "1"],
      ["a5", "a6"],
      ["az", "b"],
    ];
    for (const [low, high] of cases) {
      const key = keyBetween(low, high);
      expect(isValidKey(key), `${low} ${high} -> ${key}`).toBe(true);
      if (low !== null) expect(key > low, `${key} > ${low}`).toBe(true);
      if (high !== null) expect(key < high, `${key} < ${high}`).toBe(true);
    }
  });

  it("rejects out-of-order and malformed keys", () => {
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a", "a")).toThrow();
    expect(() => keyBetween("a0", null)).toThrow();
    expect(() => keyBetween("a!", null)).toThrow();
  });

  it("stays sorted and valid under 5000 random inserts", () => {
    const random = seeded(42);
    const keys: string[] = [];
    for (let step = 0; step < 5_000; step += 1) {
      const index = Math.floor(random() * (keys.length + 1));
      const key = keyBetween(keys[index - 1] ?? null, keys[index] ?? null);
      keys.splice(index, 0, key);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(keys.slice().sort());
    expect(keys.every(isValidKey)).toBe(true);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(40);
  });

  it("keeps keys short when always appending or always prepending", () => {
    let last: string | null = null;
    for (let step = 0; step < 1_000; step += 1) last = keyBetween(last, null);
    expect(last!.length).toBeLessThanOrEqual(20);
    let first: string | null = null;
    for (let step = 0; step < 1_000; step += 1) first = keyBetween(null, first);
    expect(first!.length).toBeLessThanOrEqual(40);
  });

  it("degrades gracefully when inserting at the same spot repeatedly", () => {
    const low = keyBetween(null, null);
    let high = keyBetween(low, null);
    for (let step = 0; step < 500; step += 1) {
      const key = keyBetween(low, high);
      expect(key > low && key < high).toBe(true);
      high = key;
    }
    expect(high.length).toBeLessThan(120);
  });

  it("spreads seed keys in order", () => {
    const keys = spreadKeys(10);
    expect(keys).toEqual(keys.slice().sort());
  });
});
