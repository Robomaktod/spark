/**
 * Rendering a round to text.
 *
 * Passport §16 sets the bar: an observer watching the ASCII replay should be
 * able to say why a wizard died without reading the JSON. That is why a frame
 * carries the event lines under the map, not just the map.
 */
import type { MaterialId, Side } from '@spark/protocol';
import type { Round } from '@spark/engine';
import { concentrationUpkeepMilliMana } from '@spark/engine';

const ESC = String.fromCharCode(27);

const GLYPH: Readonly<Record<MaterialId, string>> = {
  air: ' ',
  water: '~',
  ice: '*',
  wood: 'w',
  plasma: '%',
  stone: '#',
  rubble: ':',
};

const FACING_GLYPH = ['>', '\\', 'v', '/', '<', '\\', '^', '/'];

/** ANSI colour by temperature, dropped entirely when the terminal is not a TTY. */
function colourFor(milliC: number, ambientMilliC: number, colour: boolean): [string, string] {
  if (!colour) return ['', ''];
  const d = milliC - ambientMilliC;
  const wrap = (code: string): [string, string] => [ESC + '[' + code + 'm', ESC + '[0m'];
  if (d > 500_000) return wrap('97;41');
  if (d > 150_000) return wrap('91');
  if (d > 40_000) return wrap('33');
  if (d < -150_000) return wrap('96');
  if (d < -40_000) return wrap('94');
  return ['', ''];
}

export interface RenderOptions {
  readonly cols: number;
  readonly rows: number;
  readonly colour: boolean;
}

interface Marker {
  glyph: string;
  priority: number;
  milliC: number;
}

/**
 * Draws the arena, downsampled so a 200x200 map fits a terminal. Each character
 * covers a scale x scale patch and shows whatever mattered most in it: a wizard
 * beats an object, an object beats terrain, terrain beats air.
 */
export function renderMap(round: Round, options: RenderOptions): string[] {
  const world = round.world;
  const scale = Math.max(
    1,
    Math.ceil(Math.max(world.width / options.cols, world.height / options.rows)),
  );
  const outW = Math.ceil(world.width / scale);
  const outH = Math.ceil(world.height / scale);

  const grid: Marker[] = [];
  for (let i = 0; i < outW * outH; i++) {
    grid.push({ glyph: ' ', priority: -1, milliC: world.ambientMilliC });
  }

  const put = (x: number, y: number, glyph: string, priority: number, milliC: number): void => {
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
    const cur = grid[Math.floor(y / scale) * outW + Math.floor(x / scale)]!;
    if (priority >= cur.priority) {
      cur.glyph = glyph;
      cur.priority = priority;
      cur.milliC = milliC;
    }
  };

  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const i = world.idx(x, y);
      const mat = world.materialOfIndex(i);
      const t = world.temperature[i]!;
      if (mat === 'air' && world.heightMm[i] === 0 && t === world.ambientMilliC) continue;
      const tall = world.heightMm[i]! > 1000;
      put(x, y, mat === 'air' ? '.' : GLYPH[mat], mat === 'air' ? 0 : tall ? 2 : 1, t);
    }
  }

  for (const obj of round.objects) {
    if (obj.destroyed) continue;
    const glyph = String(obj.id % 10);
    for (const [x, y] of obj.occupiedCells()) put(x, y, glyph, 5, obj.temperatureMilliC);
  }

  for (const side of ['A', 'B'] as const) {
    const w = round.wizards[side];
    if (!w.alive) continue;
    for (const [x, y] of w.footprintCells()) put(x, y, side.toLowerCase(), 8, world.ambientMilliC);
    const [wx, wy] = w.wandCell();
    put(wx, wy, FACING_GLYPH[w.facing]!, 7, world.ambientMilliC);
    put(w.x, w.y, side, 9, world.ambientMilliC);
  }

  const lines: string[] = [];
  for (let y = 0; y < outH; y++) {
    let line = '';
    for (let x = 0; x < outW; x++) {
      const m = grid[y * outW + x]!;
      const [on, off] = colourFor(m.milliC, world.ambientMilliC, options.colour);
      line += on + m.glyph + off;
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

function bar(value: number, max: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

/** HP, mana, MP and the active concentrations, which is the side panel §16 asks for. */
export function renderPanel(round: Round, names: Readonly<Record<Side, string>>): string[] {
  const rules = round.rules;
  const lines: string[] = [];
  for (const side of ['A', 'B'] as const) {
    const w = round.wizards[side];
    const held = round.objects
      .filter((o) => !o.destroyed && o.concentrated && o.owner === side)
      .map((o) => {
        const upkeep = concentrationUpkeepMilliMana(o.massG, o.material, o.temperatureMilliC, rules);
        return '#' + o.id + '@' + (upkeep / 1000).toFixed(1);
      });
    lines.push(
      side +
        ' ' +
        names[side].slice(0, 14).padEnd(14) +
        ' HP ' +
        bar(w.hpMilli, rules.wizard.hpMilli, 12) +
        (w.hpMilli / 1000).toFixed(0).padStart(4) +
        '  MANA ' +
        bar(w.manaMilli, rules.wizard.manaCapMilli, 10) +
        (w.manaMilli / 1000).toFixed(0).padStart(4) +
        '  MP ' +
        String(w.mp).padStart(2) +
        '  [' +
        String(w.x).padStart(3) +
        ',' +
        String(w.y).padStart(3) +
        '] f' +
        w.facing +
        (held.length > 0 ? '  holding ' + held.join(' ') : ''),
    );
  }
  return lines;
}

export const LEGEND =
  'legend  A/B wizard (lowercase = footprint, arrow = wand)   0-9 objects   ' +
  '# stone  : rubble  ~ water  * ice  % plasma  . disturbed air';
