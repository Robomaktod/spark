/**
 * FNV-1a 64-bit state hashing. The M1 gate is "same input -> identical state
 * hash across 1000 turns" (passport §22), so the hash has to be a stable
 * function of the world, computed the same way on every machine.
 */
const MASK64 = (1n << 64n) - 1n;
const PRIME = 0x100000001b3n;
const OFFSET = 0xcbf29ce484222325n;

export class Hasher {
  private h = OFFSET;

  byte(b: number): this {
    this.h = ((this.h ^ BigInt(b & 0xff)) * PRIME) & MASK64;
    return this;
  }

  /** Feeds a safe integer as 8 little-endian bytes, sign included. */
  int(v: number): this {
    let x = BigInt(Math.trunc(v)) & MASK64;
    for (let i = 0; i < 8; i++) {
      this.byte(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  str(s: string): this {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 0xff).byte((c >> 8) & 0xff);
    }
    return this.byte(0);
  }

  ints(arr: ArrayLike<number>): this {
    this.int(arr.length);
    for (let i = 0; i < arr.length; i++) this.int(arr[i] as number);
    return this;
  }

  get value(): bigint {
    return this.h;
  }

  hex(): string {
    return this.h.toString(16).padStart(16, '0');
  }
}
