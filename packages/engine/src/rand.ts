/**
 * Deterministic PRNG. Used only by map generation (passport §13: no randomness
 * after the map exists). BigInt throughout so the 64-bit mixing is exact.
 */
const MASK64 = (1n << 64n) - 1n;

export class Rng {
  private state: bigint;

  constructor(seed: string | number | bigint) {
    this.state = Rng.seedFrom(seed);
  }

  static seedFrom(seed: string | number | bigint): bigint {
    if (typeof seed === 'bigint') return seed & MASK64;
    if (typeof seed === 'number') return BigInt(Math.trunc(seed)) & MASK64;
    // FNV-1a over the seed string, so a human-readable seed is usable.
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < seed.length; i++) {
      h ^= BigInt(seed.charCodeAt(i) & 0xff);
      h = (h * 0x100000001b3n) & MASK64;
    }
    return h === 0n ? 0x9e3779b97f4a7c15n : h;
  }

  /** splitmix64. */
  next64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  /** Uniform integer in [0, bound). Rejection-sampled, so no modulo bias. */
  int(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound <= 0)
      throw new Error('Rng.int: bound must be positive');
    const b = BigInt(bound);
    const limit = (MASK64 / b) * b;
    for (;;) {
      const r = this.next64();
      if (r < limit) return Number(r % b);
    }
  }

  /** Uniform integer in [lo, hi], inclusive. */
  range(lo: number, hi: number): number {
    if (hi < lo) throw new Error('Rng.range: hi below lo');
    return lo + this.int(hi - lo + 1);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[this.int(items.length)]!;
  }
}
