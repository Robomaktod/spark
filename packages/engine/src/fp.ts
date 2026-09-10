/**
 * Integer maths. Passport §13: no float anywhere in the simulation.
 *
 * Every routine here takes and returns safe integers. Where an intermediate
 * product can leave the 2^53 range (kinetic energy is mass x velocity squared)
 * the routine goes through BigInt, so the result is exact on every engine on
 * every machine rather than exact-until-it-isn't.
 */

/** Thrown when a caller hands the engine a value that cannot be integer maths. */
export class FixedPointError extends Error {}

export function assertInt(v: number, what: string): number {
  if (!Number.isSafeInteger(v))
    throw new FixedPointError(`${what}: expected a safe integer, got ${v}`);
  return v;
}

/** Floor division that rounds toward negative infinity for every sign of input. */
export function idiv(a: number, b: number): number {
  if (b === 0) throw new FixedPointError('idiv: division by zero');
  const q = Math.trunc(a / b);
  return a % b !== 0 && a < 0 !== b < 0 ? q - 1 : q;
}

/** Division rounded half away from zero. */
export function idivRound(a: number, b: number): number {
  if (b === 0) throw new FixedPointError('idivRound: division by zero');
  const neg = a < 0 !== b < 0;
  const q = Math.floor((Math.abs(a) * 2 + Math.abs(b)) / (2 * Math.abs(b)));
  return neg ? -q : q;
}

/** (a * b) / d, exact through BigInt, floored toward negative infinity. */
export function mulDiv(a: number, b: number, d: number): number {
  if (d === 0) throw new FixedPointError('mulDiv: division by zero');
  const n = BigInt(a) * BigInt(b);
  const den = BigInt(d);
  let q = n / den;
  if (n % den !== 0n && n < 0n !== den < 0n) q -= 1n;
  return toSafeNumber(q, 'mulDiv');
}

/** (a * b) / d, exact through BigInt, rounded half away from zero. */
export function mulDivRound(a: number, b: number, d: number): number {
  if (d === 0) throw new FixedPointError('mulDivRound: division by zero');
  const n = BigInt(a) * BigInt(b);
  const den = BigInt(d);
  const neg = n < 0n !== den < 0n;
  const an = n < 0n ? -n : n;
  const ad = den < 0n ? -den : den;
  const q = (an * 2n + ad) / (ad * 2n);
  return toSafeNumber(neg ? -q : q, 'mulDivRound');
}

export function toSafeNumber(v: bigint, what: string): number {
  if (v > 9007199254740991n || v < -9007199254740991n) {
    throw new FixedPointError(`${what}: result ${v} leaves the safe integer range`);
  }
  return Number(v);
}

/**
 * Integer square root of a BigInt, floored. Exact for any non-negative input.
 *
 * The float seed only accelerates convergence; the trailing correction loops
 * make the result exact regardless of what Math.sqrt returned, so this stays
 * deterministic across engines.
 */
export function isqrtBig(n: bigint): bigint {
  if (n < 0n) throw new FixedPointError('isqrt: negative input');
  if (n < 2n) return n;
  // invariant-ok(determinism): float seed only; the loops below correct it exactly
  let r = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (r <= 0n) r = 1n;
  for (let i = 0; i < 64; i++) {
    const next = (r + n / r) >> 1n;
    if (next === r) break;
    r = next;
  }
  while (r * r > n) r -= 1n;
  while ((r + 1n) * (r + 1n) <= n) r += 1n;
  return r;
}

/** Integer square root, floored. Exact for every non-negative safe integer. */
export function isqrt(n: number): number {
  assertInt(n, 'isqrt');
  return Number(isqrtBig(BigInt(n)));
}

/**
 * Euclidean length of an integer vector, floored.
 *
 * Goes through BigInt because the protocol lets a bot hand the engine any safe
 * integer as a direction, and squaring one of those leaves the safe range long
 * before anything else notices.
 */
export function ilen(x: number, y: number): number {
  const bx = BigInt(Math.trunc(x));
  const by = BigInt(Math.trunc(y));
  return toSafeNumber(isqrtBig(bx * bx + by * by), 'ilen');
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/**
 * cos(d degrees) x1000 for integer d in 0..90. Written out as literals rather
 * than computed from Math.cos, because Math.cos is not specified to give the
 * same bits on every engine and determinism is a hard requirement.
 */
// Ten per line so the table can be checked against a reference table.
// prettier-ignore
export const COS_MILLI_0_TO_90: readonly number[] = [
  1000, 1000, 999, 999, 998, 996, 995, 993, 990, 988,
  985, 982, 978, 974, 970, 966, 961, 956, 951, 946,
  940, 934, 927, 921, 914, 906, 899, 891, 883, 875,
  866, 857, 848, 839, 829, 819, 809, 799, 788, 777,
  766, 755, 743, 731, 719, 707, 695, 682, 669, 656,
  643, 629, 616, 602, 588, 574, 559, 545, 530, 515,
  500, 485, 469, 454, 438, 423, 407, 391, 375, 358,
  342, 326, 309, 292, 276, 259, 242, 225, 208, 191,
  174, 156, 139, 122, 105, 87, 70, 52, 35, 17,
  0,
];

/** cos(d degrees) x1000 for any integer d, folded into 0..90. */
export function cosMilli(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  if (d <= 90) return COS_MILLI_0_TO_90[d]!;
  if (d <= 180) return -COS_MILLI_0_TO_90[180 - d]!;
  if (d <= 270) return -COS_MILLI_0_TO_90[d - 180]!;
  return COS_MILLI_0_TO_90[360 - d]!;
}
