/**
 * The arena renderer (web plan §5.1).
 *
 * Terrain and the pixel overlays are drawn into 200x200 offscreen canvases and
 * uploaded as nearest-neighbour textures, rather than as forty thousand tile
 * sprites. One cell is one pixel, so a full repaint is a single small texture
 * upload and an overlay is just another buffer of the same shape. Forward steps
 * repaint only the blocks the engine marked dirty; a seek repaints everything.
 *
 * Objects, trails, coverage and the wizards are vector layers on top, because
 * they move within a turn and want sub-cell positions.
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { MaterialId, Rules, Side } from '@spark/protocol';
import type { EngineEvent, ObjectPath, Round } from '@spark/engine';
import { positionAt } from '@spark/engine';
import {
  SIDE_RGB,
  heatAlpha,
  heatRGB,
  heightAlpha,
  heightRGB,
  hexRGB,
  terrainRGB,
} from './palette.js';
import { manaByDistance } from './manaField.js';

export interface Overlays {
  heat: boolean;
  height: boolean;
  trails: boolean;
  coverage: boolean;
  mana: boolean;
  grid: boolean;
}

export const DEFAULT_OVERLAYS: Overlays = {
  heat: true,
  height: false,
  trails: true,
  coverage: true,
  mana: false,
  grid: false,
};

/** One turn of history the renderer needs beyond the current world state. */
export interface RenderFrame {
  /** Position in the replay, so the renderer can tell a step from a seek. */
  readonly index: number;
  readonly round: Round;
  readonly paths: readonly ObjectPath[];
  readonly events: readonly EngineEvent[];
  readonly dirtyBlocks: readonly number[];
}

interface Layer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly image: ImageData;
  readonly texture: Texture;
  readonly sprite: Sprite;
}

/**
 * The mana field is measured with the passport's own worked example — a 7.2 kg
 * ice knife — so the rings are denominated in something a player already has a
 * feel for. A lighter probe costs so little to throw that the whole map falls
 * inside one band and the overlay says nothing.
 */
const MANA_PROBE_MASS_G = 7200;
const MANA_PROBE_MATERIAL: MaterialId = 'ice';
const TRAIL_TURNS = 3;
/** One contour ring per this much mana. */
const MANA_BAND_MILLI = 5_000;

function makeLayer(width: number, height: number): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas context unavailable');
  const image = ctx.createImageData(width, height);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  const sprite = new Sprite(texture);
  return { canvas, ctx, image, texture, sprite };
}

export class ArenaRenderer {
  private app: Application | null = null;
  private readonly camera = new Container();
  private terrain!: Layer;
  private heat!: Layer;
  private height!: Layer;
  private mana!: Layer;
  private grid = new Graphics();
  private trails = new Graphics();
  private coverage = new Graphics();
  private objects = new Graphics();
  private wizards = new Graphics();

  private width = 0;
  private heightCells = 0;
  private rules: Rules | null = null;

  private overlays: Overlays = { ...DEFAULT_OVERLAYS };
  private frame: RenderFrame | null = null;
  private paintedRound = -1;
  private paintedIndex = -2;
  private trailHistory: { paths: readonly ObjectPath[]; age: number }[] = [];
  private manaLookup: (number | null)[] = [];

  /** Camera state, in screen pixels per cell. */
  private zoom = 3;
  private panX = 0;
  private panY = 0;
  private follow = true;

  async mount(host: HTMLElement, rules: Rules): Promise<void> {
    this.rules = rules;
    this.width = rules.arena.width;
    this.heightCells = rules.arena.height;

    const app = new Application();
    await app.init({
      background: 0x05070a,
      antialias: false,
      resizeTo: host,
      preference: 'webgl',
    });
    this.app = app;
    host.appendChild(app.canvas);

    this.terrain = makeLayer(this.width, this.heightCells);
    this.heat = makeLayer(this.width, this.heightCells);
    this.height = makeLayer(this.width, this.heightCells);
    this.mana = makeLayer(this.width, this.heightCells);

    for (const layer of [this.terrain, this.heat, this.height, this.mana]) {
      this.camera.addChild(layer.sprite);
    }
    this.camera.addChild(this.mana.sprite);
    this.camera.addChild(this.grid, this.trails, this.coverage, this.objects, this.wizards);
    app.stage.addChild(this.camera);

    this.manaLookup = manaByDistance(
      Math.ceil(Math.hypot(this.width, this.heightCells)),
      MANA_PROBE_MASS_G,
      MANA_PROBE_MATERIAL,
      rules,
    );
    this.applyCamera();
  }

  destroy(): void {
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  get ready(): boolean {
    return this.app !== null;
  }

  setOverlays(overlays: Overlays): void {
    this.overlays = { ...overlays };
    if (this.frame) this.draw(this.frame, 1000, true);
  }

  setFollow(on: boolean): void {
    this.follow = on;
  }

  panBy(dx: number, dy: number): void {
    this.follow = false;
    this.panX += dx;
    this.panY += dy;
    this.applyCamera();
  }

  zoomAt(factor: number, screenX: number, screenY: number): void {
    const before = this.zoom;
    this.zoom = Math.max(0.6, Math.min(14, this.zoom * factor));
    // Keep the cell under the cursor under the cursor.
    const k = this.zoom / before;
    this.panX = screenX - (screenX - this.panX) * k;
    this.panY = screenY - (screenY - this.panY) * k;
    this.follow = false;
    this.applyCamera();
  }

  /** Cell under a point in canvas coordinates, or null if outside the arena. */
  cellAt(screenX: number, screenY: number): readonly [number, number] | null {
    const x = Math.floor((screenX - this.panX) / this.zoom);
    const y = Math.floor((screenY - this.panY) / this.zoom);
    if (x < 0 || y < 0 || x >= this.width || y >= this.heightCells) return null;
    return [x, y];
  }

  private applyCamera(): void {
    this.camera.scale.set(this.zoom);
    this.camera.position.set(this.panX, this.panY);
  }

  /** Frames both wizards and everything in flight (web plan §5.1). */
  private frameTheAction(round: Round): void {
    const app = this.app;
    if (!app) return;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const side of ['A', 'B'] as const) {
      const w = round.wizards[side];
      xs.push(w.x);
      ys.push(w.y);
    }
    for (const o of round.objects) {
      if (o.destroyed) continue;
      xs.push(o.cellX);
      ys.push(o.cellY);
    }
    const pad = 26;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    const w = app.screen.width;
    const h = app.screen.height;
    this.zoom = Math.max(0.6, Math.min(14, Math.min(w / (maxX - minX), h / (maxY - minY))));
    this.panX = w / 2 - ((minX + maxX) / 2) * this.zoom;
    this.panY = h / 2 - ((minY + maxY) / 2) * this.zoom;
    this.applyCamera();
  }

  /**
   * Draws a turn. `tMilliTurns` interpolates within it, so objects slide along
   * their swept paths instead of teleporting once per turn (web plan §6).
   */
  draw(frame: RenderFrame, tMilliTurns: number, repaintAll = false): void {
    if (!this.app || !this.rules) return;
    const changed = frame !== this.frame;
    if (changed) {
      this.trailHistory.unshift({ paths: frame.paths, age: 0 });
      this.trailHistory = this.trailHistory.slice(0, TRAIL_TURNS).map((h, i) => ({ ...h, age: i }));
    }
    this.frame = frame;

    // The dirty set only describes what a *forward step* touched. A new round
    // is a freshly generated world and a seek restores one wholesale, so
    // anything that is not the next turn in sequence needs a full repaint —
    // otherwise the terrain never appears at all.
    const sequential = frame.index === this.paintedIndex + 1 && this.paintedRound === frame.round.round;
    if (repaintAll || changed || !sequential) {
      const blocks = repaintAll || !sequential ? null : frame.dirtyBlocks;
      this.paintedRound = frame.round.round;
      this.paintedIndex = frame.index;
      this.paintTerrain(frame.round, blocks);
      this.paintHeat(frame.round, blocks);
      this.paintHeight(frame.round, blocks);
      this.paintMana(frame.round);
      this.paintGrid(frame.round);
    }

    this.paintTrails(frame.round);
    this.paintCoverage(frame);
    this.paintObjects(frame, tMilliTurns);
    this.paintWizards(frame.round);

    if (this.follow) this.frameTheAction(frame.round);
  }

  /* ---------------------------------------------------------------- */
  /* Pixel layers                                                      */
  /* ---------------------------------------------------------------- */

  /** Runs a painter over whole cells, or just the engine's dirty blocks. */
  private eachCell(
    round: Round,
    blocks: readonly number[] | null,
    paint: (i: number, x: number, y: number) => void,
  ): void {
    const world = round.world;
    if (!blocks) {
      for (let y = 0; y < this.heightCells; y++) {
        for (let x = 0; x < this.width; x++) paint(world.idx(x, y), x, y);
      }
      return;
    }
    for (const block of blocks) {
      for (const { i, x, y } of world.blockCells(block)) paint(i, x, y);
    }
  }

  private put(layer: Layer, x: number, y: number, r: number, g: number, b: number, a: number): void {
    const o = (y * this.width + x) * 4;
    const data = layer.image.data;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = Math.round(a * 255);
  }

  private flush(layer: Layer): void {
    layer.ctx.putImageData(layer.image, 0, 0);
    layer.texture.source.update();
  }

  private paintTerrain(round: Round, blocks: readonly number[] | null): void {
    const world = round.world;
    this.eachCell(round, blocks, (i, x, y) => {
      const mat = world.materialOfIndex(i);
      const [r, g, b] = terrainRGB(mat, world.mass[i]!);
      this.put(this.terrain, x, y, r, g, b, 1);
    });
    this.flush(this.terrain);
  }

  private paintHeat(round: Round, blocks: readonly number[] | null): void {
    const rules = this.rules!;
    const world = round.world;
    const on = this.overlays.heat;
    this.eachCell(round, blocks, (i, x, y) => {
      if (!on) {
        this.put(this.heat, x, y, 0, 0, 0, 0);
        return;
      }
      const t = world.temperature[i]!;
      const alpha = heatAlpha(t, rules);
      if (alpha <= 0) {
        this.put(this.heat, x, y, 0, 0, 0, 0);
        return;
      }
      const [r, g, b] = heatRGB(t, rules);
      this.put(this.heat, x, y, r, g, b, alpha);
    });
    this.flush(this.heat);
  }

  private paintHeight(round: Round, blocks: readonly number[] | null): void {
    const rules = this.rules!;
    const world = round.world;
    const on = this.overlays.height;
    this.eachCell(round, blocks, (i, x, y) => {
      if (!on) {
        this.put(this.height, x, y, 0, 0, 0, 0);
        return;
      }
      const mm = world.heightMm[i]!;
      const alpha = heightAlpha(mm, rules);
      const [r, g, b] = heightRGB(mm, rules);
      this.put(this.height, x, y, r, g, b, alpha);
    });
    this.flush(this.height);
  }

  /**
   * The mana field: what a probe shot costs to land at each cell, measured from
   * A's wand.
   *
   * Drawn as contour rings rather than a colour wash. A wash over forty
   * thousand cells drowns the terrain and the other overlays — which is the
   * "overlay overload" the web plan warns about — and it does not answer the
   * question a player actually has, which is "where does the next twenty mana
   * get me?". Rings answer that directly.
   */
  private paintMana(round: Round): void {
    const on = this.overlays.mana;
    if (!on) {
      this.mana.image.data.fill(0);
      this.flush(this.mana);
      return;
    }
    const wand = round.wizards.A.wandCell();
    const bandMilliMana = MANA_BAND_MILLI;
    const bandAt = (x: number, y: number): number => {
      const d = Math.round(Math.hypot(x - wand[0], y - wand[1]));
      const cost = this.manaLookup[d];
      if (cost === null || cost === undefined) return -1;
      return Math.floor(cost / bandMilliMana);
    };

    for (let y = 0; y < this.heightCells; y++) {
      for (let x = 0; x < this.width; x++) {
        const band = bandAt(x, y);
        // Out of reach at any speed: the edge of what this spell can ever do.
        if (band < 0) {
          this.put(this.mana, x, y, 190, 70, 70, 0.22);
          continue;
        }
        const isContour = band !== bandAt(x - 1, y) || band !== bandAt(x, y - 1);
        if (!isContour) {
          this.put(this.mana, x, y, 0, 0, 0, 0);
          continue;
        }
        // Cheap rings green, expensive rings amber.
        const k = Math.min(1, (band * bandMilliMana) / 120_000);
        this.put(this.mana, x, y, Math.round(90 + 160 * k), Math.round(215 - 110 * k), 100, 0.85);
      }
    }
    this.flush(this.mana);
  }

  private paintGrid(round: Round): void {
    const g = this.grid;
    g.clear();
    if (!this.overlays.grid) return;
    const block = round.world.blockSize;
    for (let x = 0; x <= this.width; x += block) {
      g.moveTo(x, 0).lineTo(x, this.heightCells);
    }
    for (let y = 0; y <= this.heightCells; y += block) {
      g.moveTo(0, y).lineTo(this.width, y);
    }
    g.stroke({ color: 0x39434f, width: 0.06, alpha: 0.8 });
  }

  /* ---------------------------------------------------------------- */
  /* Vector layers                                                     */
  /* ---------------------------------------------------------------- */

  private paintTrails(round: Round): void {
    const g = this.trails;
    g.clear();
    if (!this.overlays.trails) return;
    for (const entry of this.trailHistory) {
      const alpha = 0.55 * (1 - entry.age / TRAIL_TURNS);
      if (alpha <= 0.02) continue;
      for (const path of entry.paths) {
        const colour = hexRGB(SIDE_RGB[path.owner]);
        for (const s of path.segments) {
          g.moveTo(s.from[0] / 1000, s.from[1] / 1000).lineTo(s.to[0] / 1000, s.to[1] / 1000);
        }
        g.stroke({ color: colour, width: 0.5, alpha });
      }
    }
    void round;
  }

  /**
   * The coverage overlay: on a hit, which of the impact shape's cells landed on
   * the wizard. That fraction *is* the damage multiplier (passport §8), so it is
   * the difference between a graze and a miss.
   */
  private paintCoverage(frame: RenderFrame): void {
    const g = this.coverage;
    g.clear();
    if (!this.overlays.coverage) return;
    for (const e of frame.events) {
      if (e.t !== 'impact_wizard') continue;
      const covered = new Set(e.footprint.map(([x, y]) => `${x},${y}`));
      for (const [dx, dy] of e.shape) {
        const x = e.at[0] + dx;
        const y = e.at[1] + dy;
        const hit = covered.has(`${x},${y}`);
        g.rect(x, y, 1, 1).fill({ color: hit ? 0xff5c5c : 0xffffff, alpha: hit ? 0.6 : 0.16 });
      }
      for (const [x, y] of e.footprint) {
        g.rect(x, y, 1, 1).stroke({ color: 0xffffff, width: 0.08, alpha: 0.5 });
      }
    }
  }

  private paintObjects(frame: RenderFrame, tMilliTurns: number): void {
    const g = this.objects;
    g.clear();

    const drawn = new Set<number>();
    for (const path of frame.paths) {
      const at = positionAt(path, tMilliTurns);
      if (!at) continue;
      drawn.add(path.objectId);
      const colour = hexRGB(SIDE_RGB[path.owner]);
      const cx = at[0] / 1000;
      const cy = at[1] / 1000;
      for (const [dx, dy] of path.cells) {
        g.rect(cx + dx - 0.5, cy + dy - 0.5, 1, 1).fill({ color: colour, alpha: 0.95 });
      }
    }

    // Objects that did not move this turn — settled matter a concentration is
    // still holding — have no path, so draw them where they sit.
    for (const o of frame.round.objects) {
      if (o.destroyed || drawn.has(o.id)) continue;
      const colour = hexRGB(SIDE_RGB[o.owner]);
      for (const [x, y] of o.occupiedCells()) {
        g.rect(x, y, 1, 1).fill({ color: colour, alpha: o.concentrated ? 0.85 : 0.6 });
      }
      if (o.concentrated) {
        g.circle(o.cellX + 0.5, o.cellY + 0.5, 2.4).stroke({ color: colour, width: 0.22, alpha: 0.75 });
      }
    }
  }

  private paintWizards(round: Round): void {
    const g = this.wizards;
    g.clear();
    const rules = this.rules!;
    for (const side of ['A', 'B'] as const) {
      const w = round.wizards[side];
      if (!w.alive) continue;
      const colour = hexRGB(SIDE_RGB[side]);
      const r = rules.wizard.footprintRadius;
      g.rect(w.x - r, w.y - r, r * 2 + 1, r * 2 + 1).fill({ color: colour, alpha: 0.28 });
      g.rect(w.x - r, w.y - r, r * 2 + 1, r * 2 + 1).stroke({ color: colour, width: 0.3, alpha: 1 });
      const wand = w.wandCell();
      g.moveTo(w.x + 0.5, w.y + 0.5)
        .lineTo(wand[0] + 0.5, wand[1] + 0.5)
        .stroke({ color: colour, width: 0.35, alpha: 0.9 });
      g.circle(wand[0] + 0.5, wand[1] + 0.5, 0.9).fill({ color: colour, alpha: 0.95 });
    }
  }

  /** What the mana field is measuring, for the rail's caption. */
  static readonly manaProbe = {
    massG: MANA_PROBE_MASS_G,
    material: MANA_PROBE_MATERIAL,
    bandMana: MANA_BAND_MILLI / 1000,
  };

  sideColour(side: Side): string {
    const c = SIDE_RGB[side];
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }
}
