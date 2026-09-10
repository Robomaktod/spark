/**
 * Colour for the arena layers.
 *
 * Materials are muted so the overlays read on top of them: the terrain is
 * context, and the thing a player is trying to see is usually heat, height or
 * coverage (web plan §5.2).
 */
import type { MaterialId, Rules } from '@spark/protocol';
import { MATERIALS } from '@spark/protocol';

export type RGB = readonly [number, number, number];

export const MATERIAL_RGB: Readonly<Record<MaterialId, RGB>> = {
  air: [16, 20, 26],
  water: [28, 62, 104],
  ice: [150, 200, 224],
  wood: [104, 76, 46],
  plasma: [148, 62, 168],
  stone: [104, 110, 120],
  rubble: [82, 74, 66],
};

/** Wizards, so the same two colours mean the same two bots everywhere. */
export const SIDE_RGB = { A: [93, 180, 245] as RGB, B: [245, 162, 93] as RGB };

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/**
 * Temperature ramp. Anchored on the two thresholds a player actually cares
 * about: freezing, and the 60 C above which a cell burns.
 */
export function heatRGB(milliC: number, rules: Rules): RGB {
  const c = milliC / 1000;
  const burn = rules.damage.burnThresholdMilliC / 1000;
  if (c <= 0) return mix([70, 160, 220], [200, 245, 255], Math.min(1, -c / 200));
  if (c < burn) return mix([70, 160, 220], [40, 44, 50], Math.min(1, c / burn));
  if (c < 300) return mix([120, 90, 40], [255, 140, 50], (c - burn) / (300 - burn));
  if (c < 1200) return mix([255, 140, 50], [255, 232, 150], (c - 300) / 900);
  return [255, 255, 235];
}

/** Alpha for the heat overlay: ambient cells stay invisible so hot ones pop. */
export function heatAlpha(milliC: number, rules: Rules): number {
  const delta = Math.abs(milliC - rules.arena.ambientMilliC) / 1000;
  if (delta < 3) return 0;
  return Math.min(0.92, 0.16 + delta / 220);
}

/**
 * Height ramp, banded at the two thresholds that decide the game: what stops a
 * projectile, and what stops a wizard.
 */
export function heightRGB(mm: number, rules: Rules): RGB {
  if (mm > rules.arena.flightAltitudeMm) return [236, 108, 108];
  if (mm > 0) return [96, 150, 108];
  return [0, 0, 0];
}

export function heightAlpha(mm: number, rules: Rules): number {
  if (mm > rules.arena.flightAltitudeMm) return 0.62;
  if (mm > 0) return 0.34;
  return 0;
}

/** Base terrain colour, darkened slightly where the matter is thin. */
export function terrainRGB(material: MaterialId, massG: number): RGB {
  const base = MATERIAL_RGB[material];
  if (material === 'air') return base;
  const density = MATERIALS[material].densityGPerCell;
  const fill = Math.max(0.35, Math.min(1, massG / Math.max(1, density)));
  return mix(MATERIAL_RGB.air, base, fill);
}

export const cssRGB = (c: RGB, alpha = 1): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;

export const hexRGB = (c: RGB): number => (c[0] << 16) | (c[1] << 8) | c[2];
