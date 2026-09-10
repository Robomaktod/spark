/**
 * One round: the turn loop, the three action slots, reactions and
 * concentration (passport §5.1, §10, §11).
 *
 * Round is a synchronous state machine. It never does I/O: the caller asks for
 * the current turn packet, hands back an action packet, and the round advances.
 * That keeps the whole simulation testable without a process in sight.
 */
import type {
  ActionsMessage,
  CastArgs,
  CastResult,
  CellView,
  ChannelCommand,
  ConcentrationView,
  ReactAction,
  Rules,
  Side,
  TriggerSpec,
  TurnMessage,
  Vec2,
} from '@spark/protocol';
import { validateActions } from '@spark/protocol';
import { MATERIALS } from '@spark/protocol';
import type { Spellbook } from './spellbook.js';
import type { EngineEvent, Vec } from './events.js';
import { describeEvent, isPublicEvent } from './events.js';
import type { World } from './world.js';
import { Wizard } from './wizard.js';
import { SparkObject, type ResolvedOp } from './objects.js';
import { manifestBlocked, planCast } from './cast.js';
import { applyMove } from './movement.js';
import {
  advanceObjects,
  applyDrag,
  decayHeat,
  hottestUnderFootMilliC,
  phaseChecks,
  settleObjects,
  type PhysicsContext,
} from './physics.js';
import { PathRecorder, type ObjectPath } from './paths.js';
import {
  burnDamageMilliHp,
  concentrationUpkeepMilliMana,
  heatCostMilliMana,
  impulseCostMilliMana,
  keMilliJ,
  worstCaseCostMilliMana,
} from './pricing.js';
import { idivRound, ilen } from './fp.js';
import { facingFromVector, unitVectorMilli } from './shapes.js';
import { Hasher } from './hash.js';
import type { ObjectSnapshot, RoundSnapshot, SideSnapshot } from './snapshot.js';

export type RoundReason = 'hp' | 'turn_cap' | 'double_ko';

export interface RoundConfig {
  readonly rules: Rules;
  readonly world: World;
  readonly spawns: readonly [Vec2, Vec2];
  readonly spellbooks: Readonly<Record<Side, Spellbook>>;
  readonly firstMover: Side;
  readonly round: number;
  readonly game: number;
}

interface ArmedReaction {
  readonly declaration: ReactAction;
  readonly reservedMilli: number;
  /** Turn cycle the reaction was declared on; it expires at the declarer's next turn. */
  readonly declaredOnTurn: number;
  fired: boolean;
}

interface SideState {
  lastCastResult: CastResult;
  rejected: string[];
  pendingCells: Set<number>;
  eventCursor: number;
  reaction: ArmedReaction | null;
  concentrations: number[];
  concentrationPriority: number[];
  opponentCastSinceDeclare: boolean;
}

const SIDES: readonly Side[] = ['A', 'B'];
const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');

export class Round {
  readonly rules: Rules;
  readonly world: World;
  readonly wizards: Record<Side, Wizard>;
  readonly objects: SparkObject[] = [];
  readonly events: EngineEvent[] = [];
  readonly round: number;
  readonly game: number;

  /** Turn cycle, 1..turnCap. Each cycle gives every wizard exactly one turn. */
  turn = 1;
  private order: readonly Side[];
  private slot = 0;
  private nextObjectId = 1;

  finished = false;
  winner: Side | null = null;
  reason: RoundReason = 'turn_cap';

  /** Swept paths from the most recent turn, for smooth playback (web plan §6). */
  lastPaths: ObjectPath[] = [];
  /** Blocks the most recent turn touched, for partial redraws (web plan §5.1). */
  lastDirtyBlocks: number[] = [];

  private readonly state: Record<Side, SideState>;
  private readonly books: Readonly<Record<Side, Spellbook>>;
  /**
   * The terrain this round started with. Keyframes diff against it, so a
   * snapshot carries only what the match changed.
   */
  private readonly initialTerrain: number[];

  constructor(config: RoundConfig) {
    this.rules = config.rules;
    this.world = config.world;
    this.books = config.spellbooks;
    this.round = config.round;
    this.game = config.game;
    this.order = config.firstMover === 'A' ? ['A', 'B'] : ['B', 'A'];

    const [spawnA, spawnB] = config.spawns;
    const facingA = facingFromVector(spawnB[0] - spawnA[0], spawnB[1] - spawnA[1]);
    const facingB = facingFromVector(spawnA[0] - spawnB[0], spawnA[1] - spawnB[1]);
    this.wizards = {
      A: new Wizard('A', spawnA[0], spawnA[1], facingA, config.rules),
      B: new Wizard('B', spawnB[0], spawnB[1], facingB, config.rules),
    };

    const mkState = (): SideState => ({
      lastCastResult: 'none',
      rejected: [],
      pendingCells: new Set(),
      eventCursor: 0,
      reaction: null,
      concentrations: [],
      concentrationPriority: [],
      opponentCastSinceDeclare: false,
    });
    this.state = { A: mkState(), B: mkState() };

    this.events.push({
      t: 'round_start',
      round: this.round,
      game: this.game,
      firstMover: config.firstMover,
    });
    this.world.drainChanged();
    this.initialTerrain = this.world.snapshotSparse();
  }

  /* ---------------------------------------------------------------- */
  /* Keyframes (web plan §4)                                           */
  /* ---------------------------------------------------------------- */

  /** Everything needed to resume this round from exactly here. */
  snapshot(): RoundSnapshot {
    const sideSnapshot = (side: Side): SideSnapshot => {
      const st = this.state[side];
      return {
        lastCastResult: st.lastCastResult,
        concentrations: [...st.concentrations],
        concentrationPriority: [...st.concentrationPriority],
        opponentCastSinceDeclare: st.opponentCastSinceDeclare,
        pendingCells: [...st.pendingCells].sort((a, b) => a - b),
        eventCursor: st.eventCursor,
        reaction: st.reaction
          ? {
              declaration: st.reaction.declaration,
              reservedMilli: st.reaction.reservedMilli,
              declaredOnTurn: st.reaction.declaredOnTurn,
              fired: st.reaction.fired,
            }
          : null,
      };
    };
    const wizardSnapshot = (side: Side): RoundSnapshot['wizards'][Side] => {
      const w = this.wizards[side];
      return {
        x: w.x,
        y: w.y,
        facing: w.facing,
        hpMilli: w.hpMilli,
        manaMilli: w.manaMilli,
        mp: w.mp,
        reservedMilli: w.reservedMilli,
        manaSpentMilli: w.manaSpentMilli,
      };
    };
    return {
      round: this.round,
      game: this.game,
      turn: this.turn,
      slot: this.slot,
      nextObjectId: this.nextObjectId,
      finished: this.finished,
      winner: this.winner,
      reason: this.reason,
      cells: this.world.diffFromSparse(this.initialTerrain),
      wizards: { A: wizardSnapshot('A'), B: wizardSnapshot('B') },
      objects: this.objects.map((o): ObjectSnapshot => ({
        id: o.id,
        owner: o.owner,
        spellId: o.spellId,
        xMilli: o.xMilli,
        yMilli: o.yMilli,
        vxMilli: o.vxMilli,
        vyMilli: o.vyMilli,
        massG: o.massG,
        material: o.material,
        temperatureMilliC: o.temperatureMilliC,
        concentrated: o.concentrated,
        settled: o.settled,
        cells: o.cells.map(([x, y]) => [x, y] as const),
        impact: o.impact
          ? {
              cells: o.impact.cells.map(([x, y]) => [x, y] as const),
              canonicalCellCount: o.impact.canonicalCellCount,
              ops: o.impact.ops.map((op) => ({ op: op.op, value: op.value })),
            }
          : null,
      })),
      sides: { A: sideSnapshot('A'), B: sideSnapshot('B') },
      eventCount: this.events.length,
    };
  }

  /**
   * Rewinds this round to a snapshot. The world is rebuilt from the round's
   * own generated terrain and then the snapshot's diff is applied, so a
   * restore does not depend on what the world happened to contain first.
   */
  restore(snap: RoundSnapshot): void {
    this.world.applySparse(this.initialTerrain, true);
    this.world.applySparse(snap.cells, false);
    this.world.clearDirtyBlocks();
    this.world.drainChanged();

    this.turn = snap.turn;
    this.slot = snap.slot;
    this.nextObjectId = snap.nextObjectId;
    this.finished = snap.finished;
    this.winner = snap.winner;
    this.reason = snap.reason as RoundReason;

    for (const side of SIDES) {
      const w = this.wizards[side];
      const ws = snap.wizards[side];
      w.x = ws.x;
      w.y = ws.y;
      w.facing = ws.facing;
      w.hpMilli = ws.hpMilli;
      w.manaMilli = ws.manaMilli;
      w.mp = ws.mp;
      w.reservedMilli = ws.reservedMilli;
      w.manaSpentMilli = ws.manaSpentMilli;

      const st = this.state[side];
      const ss = snap.sides[side];
      st.lastCastResult = ss.lastCastResult as SideState['lastCastResult'];
      st.concentrations = [...ss.concentrations];
      st.concentrationPriority = [...ss.concentrationPriority];
      st.opponentCastSinceDeclare = ss.opponentCastSinceDeclare;
      st.pendingCells = new Set(ss.pendingCells);
      st.eventCursor = ss.eventCursor;
      st.reaction = ss.reaction
        ? {
            declaration: ss.reaction.declaration as ArmedReaction['declaration'],
            reservedMilli: ss.reaction.reservedMilli,
            declaredOnTurn: ss.reaction.declaredOnTurn,
            fired: ss.reaction.fired,
          }
        : null;
    }

    this.objects.length = 0;
    for (const o of snap.objects) {
      const obj = new SparkObject(
        o.id,
        o.owner,
        o.spellId,
        o.xMilli,
        o.yMilli,
        o.vxMilli,
        o.vyMilli,
        o.massG,
        o.material,
        o.temperatureMilliC,
        o.cells.map(([x, y]) => [x, y] as const),
        o.impact
          ? {
              cells: o.impact.cells.map(([x, y]) => [x, y] as const),
              canonicalCellCount: o.impact.canonicalCellCount,
              ops: o.impact.ops.map((op) => ({ op: op.op as ResolvedOp['op'], value: op.value })),
            }
          : null,
      );
      obj.concentrated = o.concentrated;
      obj.settled = o.settled;
      this.objects.push(obj);
    }

    this.events.length = snap.eventCount;
    this.lastPaths = [];
    this.lastDirtyBlocks = [];
    this.lastEvents = [];
  }

  /** The side whose turn it is. */
  get current(): Side {
    return this.order[this.slot]!;
  }

  private ctx(paths: PathRecorder): PhysicsContext {
    return {
      world: this.world,
      rules: this.rules,
      objects: this.objects,
      wizards: this.wizards,
      events: this.events,
      paths,
      onObjectLost: (obj, reason) => this.releaseConcentration(obj.owner, obj.id, reason),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Turn packet                                                       */
  /* ---------------------------------------------------------------- */

  turnMessage(side: Side): TurnMessage {
    const st = this.state[side];
    const cells: CellView[] = [...st.pendingCells]
      .sort((a, b) => a - b)
      .map((i) => this.world.viewOfIndex(i));
    st.pendingCells.clear();

    const eventLines = this.events.slice(st.eventCursor).filter(isPublicEvent).map(describeEvent);
    st.eventCursor = this.events.length;

    const msg: TurnMessage = {
      type: 'turn',
      round: this.round,
      turn: this.turn,
      youAre: side,
      you: this.wizards[side].selfView(),
      opponent: this.wizards[other(side)].opponentView(),
      cells,
      objects: this.objects.filter((o) => !o.destroyed).map((o) => o.view()),
      concentrations: this.concentrationViews(side),
      lastCastResult: st.lastCastResult,
      rejected: [...st.rejected],
      events: eventLines,
    };
    st.rejected = [];
    return msg;
  }

  private concentrationViews(side: Side): ConcentrationView[] {
    const out: ConcentrationView[] = [];
    for (const id of this.state[side].concentrations) {
      const obj = this.objectById(id);
      if (!obj || obj.destroyed) continue;
      out.push({
        objectId: id,
        upkeep: concentrationUpkeepMilliMana(
          obj.massG,
          obj.material,
          obj.temperatureMilliC,
          this.rules,
        ),
      });
    }
    return out;
  }

  objectById(id: number): SparkObject | undefined {
    return this.objects.find((o) => o.id === id);
  }

  /* ---------------------------------------------------------------- */
  /* Turn resolution                                                   */
  /* ---------------------------------------------------------------- */

  /** Applies one wizard's turn. Pass null when the bot timed out or crashed. */
  submit(actions: ActionsMessage | null): void {
    if (this.finished) throw new Error('Round.submit: the round is already over');
    this.lastPaths = [];
    this.lastDirtyBlocks = [];
    const eventsBefore = this.events.length;
    const side = this.current;
    const st = this.state[side];
    const wizard = this.wizards[side];

    this.events.push({ t: 'turn_start', side, turn: this.turn });

    // A reaction declared on the previous turn expires now, unfired reservation refunded.
    this.expireReaction(side);

    wizard.mp = this.rules.wizard.mpPerTurn;
    st.lastCastResult = 'none';

    if (actions === null) {
      this.events.push({ t: 'timeout', side });
    } else {
      const check = validateActions(actions);
      if (!check.ok) {
        for (const e of check.errors) {
          st.rejected.push(e);
          this.events.push({ t: 'rejected', side, detail: e });
        }
      } else {
        this.applyActions(side, check.value!);
      }
    }

    this.evaluateReactions();
    this.runPhysics();
    this.evaluateReactions();
    this.chargeUpkeepAndRegen(side);
    this.syncDeltas();
    this.checkEnd();
    if (!this.finished) this.advanceSlot();
    this.lastEvents = this.events.slice(eventsBefore);
  }

  /** Events produced by the most recent turn. Stored per turn in the replay. */
  lastEvents: EngineEvent[] = [];

  private applyActions(side: Side, actions: ActionsMessage): void {
    const st = this.state[side];

    if (actions.concentrationPriority) {
      st.concentrationPriority = [...actions.concentrationPriority];
    }

    if (actions.move1) this.applyMoveSlot(side, actions.move1);

    if (actions.cast) {
      st.lastCastResult = this.applyCast(
        side,
        actions.cast.spellId,
        actions.cast.args ?? {},
        actions.cast.concentrate === true,
      );
    } else if (actions.channel) {
      st.lastCastResult = this.applyChannel(side, actions.channel);
    }

    if (actions.move2) this.applyMoveSlot(side, actions.move2);

    if (actions.react) this.declareReaction(side, actions.react);
  }

  private applyMoveSlot(side: Side, move: NonNullable<ActionsMessage['move1']>): void {
    const wizard = this.wizards[side];
    const from: Vec = [wizard.x, wizard.y];
    const outcome = applyMove(this.world, wizard, move, this.rules);
    if (outcome.mpSpent > 0 || outcome.cellsMoved > 0 || outcome.notes.length > 0) {
      this.events.push({
        t: 'move',
        side,
        from,
        to: [wizard.x, wizard.y] as Vec,
        facing: wizard.facing,
        mp: outcome.mpSpent,
        ...(outcome.notes.length > 0 ? { note: outcome.notes.join('; ') } : {}),
      });
    }
    for (const n of outcome.notes) this.state[side].rejected.push(n);
  }

  /* ---------------------------------------------------------------- */
  /* Cast slot                                                         */
  /* ---------------------------------------------------------------- */

  private applyCast(side: Side, spellId: string, args: CastArgs, concentrate: boolean): CastResult {
    const wizard = this.wizards[side];
    const template = this.books[side].get(spellId);
    if (!template) {
      this.fail(side, spellId, `no spell "${spellId}" in the book`);
      return 'unknown_spell';
    }

    const planned = planCast(template, args, wizard, this.world, this.rules);
    if (!planned.ok) {
      this.fail(side, spellId, planned.reason);
      return planned.result;
    }
    const plan = planned.plan;

    if (manifestBlocked(this.world, plan, this.rules)) {
      // Passport §4: mana is fully refunded, the Cast slot is still consumed.
      this.fail(
        side,
        spellId,
        `manifest area at [${plan.manifest[0]},${plan.manifest[1]}] is blocked`,
      );
      return 'blocked';
    }

    if (plan.cost.total > wizard.spendableMilli) {
      this.fail(
        side,
        spellId,
        `costs ${(plan.cost.total / 1000).toFixed(2)} mana, ` +
          `${(wizard.spendableMilli / 1000).toFixed(2)} available`,
      );
      return 'insufficient_mana';
    }

    wizard.spendMana(plan.cost.total);
    const obj = new SparkObject(
      this.nextObjectId++,
      side,
      spellId,
      plan.manifest[0] * 1000 + 500,
      plan.manifest[1] * 1000 + 500,
      plan.vxMilli,
      plan.vyMilli,
      plan.bodyMassG,
      template.body.material,
      plan.bodyTemperatureMilliC,
      plan.bodyCells,
      plan.impact,
    );
    this.objects.push(obj);

    this.events.push({
      t: 'cast',
      side,
      spellId,
      costMilli: plan.cost.total,
      breakdown: {
        manifest: plan.cost.manifest,
        impulse: plan.cost.impulse,
        heat: plan.cost.heat,
        bind: plan.cost.bind,
      },
      at: plan.manifest as Vec,
      dir: [plan.dirX, plan.dirY] as Vec,
      speed: Math.trunc(plan.speedMilli / 1000),
      massG: plan.bodyMassG,
      concentrate,
    });

    if (concentrate) {
      obj.concentrated = true;
      this.state[side].concentrations.push(obj.id);
      this.events.push({ t: 'concentration_start', side, objectId: obj.id });
    }

    this.state[other(side)].opponentCastSinceDeclare = true;
    return 'ok';
  }

  private fail(side: Side, spellId: string, reason: string): void {
    this.state[side].rejected.push(reason);
    this.events.push({ t: 'cast_failed', side, spellId, reason });
  }

  /* ---------------------------------------------------------------- */
  /* Channel commands (passport §10)                                   */
  /* ---------------------------------------------------------------- */

  private applyChannel(side: Side, cmd: ChannelCommand): CastResult {
    const wizard = this.wizards[side];
    const obj = this.objectById(cmd.objectId);
    if (!obj || obj.destroyed || obj.owner !== side || !obj.concentrated) {
      this.state[side].rejected.push(`object ${cmd.objectId} is not one of your concentrations`);
      return 'no_such_object';
    }

    if (cmd.kind === 'release') {
      this.releaseConcentration(side, obj.id, 'released by channel command');
      this.events.push({ t: 'channel', side, objectId: obj.id, kind: 'release', costMilli: 0 });
      return 'ok';
    }

    if (cmd.kind === 'addTemperature') {
      const spec = MATERIALS[obj.material];
      const cost = heatCostMilliMana(
        obj.massG,
        spec.specificHeatMilli,
        cmd.value * 1000,
        this.rules,
      );
      if (cost > wizard.spendableMilli) {
        this.state[side].rejected.push(
          `channel addTemperature costs ${(cost / 1000).toFixed(2)} mana, ${(wizard.spendableMilli / 1000).toFixed(2)} available`,
        );
        return 'insufficient_mana';
      }
      wizard.spendMana(cost);
      obj.temperatureMilliC += cmd.value * 1000;
      this.events.push({
        t: 'channel',
        side,
        objectId: obj.id,
        kind: 'addTemperature',
        costMilli: cost,
      });
      return 'ok';
    }

    // impulse: re-fire it in a new direction, paying 1/2 m dv^2 again.
    const [ux, uy] = unitVectorMilli(cmd.dir[0], cmd.dir[1]);
    if (ux === 0 && uy === 0) {
      this.state[side].rejected.push('channel impulse: direction may not be the zero vector');
      return 'bad_args';
    }
    const targetSpeed = cmd.speed * 1000;
    const nvx = idivRound(ux * targetSpeed, 1000);
    const nvy = idivRound(uy * targetSpeed, 1000);
    const dvx = nvx - obj.vxMilli;
    const dvy = nvy - obj.vyMilli;
    const cost = impulseCostMilliMana(keMilliJ(obj.massG, ilen(dvx, dvy)), this.rules);
    if (cost > wizard.spendableMilli) {
      this.state[side].rejected.push(
        `channel impulse costs ${(cost / 1000).toFixed(2)} mana, ${(wizard.spendableMilli / 1000).toFixed(2)} available`,
      );
      return 'insufficient_mana';
    }
    wizard.spendMana(cost);
    obj.vxMilli = nvx;
    obj.vyMilli = nvy;
    obj.settled = targetSpeed === 0;
    this.events.push({ t: 'channel', side, objectId: obj.id, kind: 'impulse', costMilli: cost });
    return 'ok';
  }

  private releaseConcentration(side: Side, objectId: number, reason: string): void {
    const st = this.state[side];
    const i = st.concentrations.indexOf(objectId);
    if (i < 0) return;
    st.concentrations.splice(i, 1);
    const obj = this.objectById(objectId);
    if (obj) obj.concentrated = false;
    this.events.push({ t: 'concentration_released', side, objectId, reason });
  }

  /* ---------------------------------------------------------------- */
  /* Reactions (passport §11)                                          */
  /* ---------------------------------------------------------------- */

  private declareReaction(side: Side, react: ReactAction): void {
    const wizard = this.wizards[side];
    const template = this.books[side].get(react.spellId);
    if (!template) {
      this.state[side].rejected.push(`react: no spell "${react.spellId}" in the book`);
      return;
    }
    const reserve = worstCaseCostMilliMana(template, this.rules);
    if (reserve > wizard.spendableMilli) {
      this.state[side].rejected.push(
        `react: reserving ${(reserve / 1000).toFixed(2)} mana needs more than the ` +
          `${(wizard.spendableMilli / 1000).toFixed(2)} available`,
      );
      return;
    }
    wizard.reservedMilli += reserve;
    this.state[side].reaction = {
      declaration: react,
      reservedMilli: reserve,
      declaredOnTurn: this.turn,
      fired: false,
    };
    this.state[side].opponentCastSinceDeclare = false;
    this.events.push({
      t: 'react_declared',
      side,
      trigger: react.trigger.kind,
      spellId: react.spellId,
      reservedMilli: reserve,
    });
  }

  private expireReaction(side: Side): void {
    const st = this.state[side];
    const armed = st.reaction;
    if (!armed) return;
    st.reaction = null;
    const wizard = this.wizards[side];
    wizard.reservedMilli = Math.max(0, wizard.reservedMilli - armed.reservedMilli);
    if (!armed.fired) {
      this.events.push({ t: 'react_refund', side, refundMilli: armed.reservedMilli, fired: false });
    }
  }

  /**
   * Evaluates both sides' armed reactions. Each fires at most once.
   *
   * Both sides are checked, not just the acting one: `objectEnteredRadius` and
   * `opponentCast` both describe things that happen on the opponent's turn, so
   * a reaction that only ever fired on its declarer's turn could not trigger at
   * all. See docs/DECISIONS.md, D6.
   */
  private evaluateReactions(): void {
    for (const side of SIDES) {
      const armed = this.state[side].reaction;
      if (!armed || armed.fired) continue;
      if (!this.wizards[side].alive) continue;
      const hit = this.checkTrigger(side, armed.declaration.trigger);
      if (!hit) continue;
      armed.fired = true;
      this.fireReaction(side, armed, hit);
    }
  }

  private checkTrigger(side: Side, trigger: TriggerSpec): { pos: Vec; objectId?: number } | null {
    const wizard = this.wizards[side];
    switch (trigger.kind) {
      case 'opponentCast':
        return this.state[side].opponentCastSinceDeclare
          ? { pos: [this.wizards[other(side)].x, this.wizards[other(side)].y] }
          : null;
      case 'selfHpBelow':
        return wizard.hpMilli < trigger.x * 1000 ? { pos: [wizard.x, wizard.y] } : null;
      case 'opponentWithinRadius': {
        const opp = this.wizards[other(side)];
        return ilen(opp.x - wizard.x, opp.y - wizard.y) <= trigger.r
          ? { pos: [opp.x, opp.y] }
          : null;
      }
      case 'objectEnteredRadius': {
        for (const o of this.objects) {
          if (o.destroyed || o.owner === side) continue;
          if (ilen(o.cellX - wizard.x, o.cellY - wizard.y) <= trigger.r) {
            return { pos: [o.cellX, o.cellY], objectId: o.id };
          }
        }
        return null;
      }
      case 'cellPropertyCrossed': {
        const [x, y] = trigger.pos;
        if (!this.world.inBounds(x, y)) return null;
        const i = this.world.idx(x, y);
        const value =
          trigger.prop === 'temperature'
            ? this.world.temperature[i]!
            : trigger.prop === 'binding'
              ? this.world.binding[i]!
              : trigger.prop === 'height'
                ? this.world.heightMm[i]!
                : this.world.mass[i]!;
        const crossed =
          trigger.dir === 'above' ? value > trigger.threshold : value < trigger.threshold;
        return crossed ? { pos: [x, y] } : null;
      }
    }
  }

  /**
   * Fires from the wand like any cast. Late-bound placeholders resolve here:
   * a `$triggerPos` in a direction slot becomes the aim vector from the wand to
   * the trigger point (passport §11).
   */
  private fireReaction(
    side: Side,
    armed: ArmedReaction,
    hit: { pos: Vec; objectId?: number },
  ): void {
    const wizard = this.wizards[side];
    const wand = wizard.wandCell();
    const resolved: Record<string, number | Vec2> = {};
    const triggerObject = hit.objectId !== undefined ? this.objectById(hit.objectId) : undefined;

    for (const [key, value] of Object.entries(armed.declaration.args ?? {})) {
      if (typeof value === 'string') {
        const target: Vec =
          value === '$selfPos'
            ? [wizard.x, wizard.y]
            : value === '$triggerObject' && triggerObject
              ? [triggerObject.cellX, triggerObject.cellY]
              : hit.pos;
        resolved[key] = [target[0] - wand[0], target[1] - wand[1]] as unknown as Vec2;
      } else {
        resolved[key] = value as number | Vec2;
      }
    }

    const before = wizard.manaMilli;
    // The reservation is released so the cast can draw on it, then whatever the
    // cast did not use stays with the wizard.
    wizard.reservedMilli = Math.max(0, wizard.reservedMilli - armed.reservedMilli);
    const result = this.applyCast(
      side,
      armed.declaration.spellId,
      resolved,
      armed.declaration.concentrate === true,
    );
    const spent = before - wizard.manaMilli;
    if (result === 'ok') {
      this.events.push({
        t: 'react_fired',
        side,
        trigger: armed.declaration.trigger.kind,
        spellId: armed.declaration.spellId,
        costMilli: spent,
      });
    }
    if (spent < armed.reservedMilli) {
      this.events.push({
        t: 'react_refund',
        side,
        refundMilli: armed.reservedMilli - spent,
        fired: true,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Physics, upkeep, regen                                            */
  /* ---------------------------------------------------------------- */

  private runPhysics(): void {
    const recorder = new PathRecorder();
    const ctx = this.ctx(recorder);
    advanceObjects(ctx);
    applyDrag(ctx);
    settleObjects(ctx);
    decayHeat(ctx);
    phaseChecks(ctx);

    for (const side of SIDES) {
      const wizard = this.wizards[side];
      if (!wizard.alive) continue;
      const hottest = hottestUnderFootMilliC(this.world, wizard);
      const burn = burnDamageMilliHp(hottest, this.rules);
      if (burn > 0) {
        wizard.damage(burn);
        this.events.push({ t: 'burn', side, damageMilli: burn, hottestMilliC: hottest });
        if (!wizard.alive) this.events.push({ t: 'death', side });
      }
    }

    // The renderer reuses the engine's own dirty set for partial redraws
    // (web plan §5.1), so hand it over before the set is cleared.
    this.lastDirtyBlocks = [...this.world.dirtyBlockList];
    this.world.clearDirtyBlocks();

    this.lastPaths = recorder.finish((id) => {
      const obj = this.objectById(id);
      return obj && !obj.destroyed ? [obj.xMilli, obj.yMilli] : null;
    });

    for (let i = this.objects.length - 1; i >= 0; i--) {
      if (this.objects[i]!.destroyed) this.objects.splice(i, 1);
    }
  }

  /**
   * Steps 7 and 8. Upkeep is charged before regen, top-down through the bot's
   * priority list; anything unfunded is released and decays normally.
   */
  private chargeUpkeepAndRegen(side: Side): void {
    const wizard = this.wizards[side];
    const st = this.state[side];

    const ordered = [
      ...st.concentrationPriority.filter((id) => st.concentrations.includes(id)),
      ...st.concentrations.filter((id) => !st.concentrationPriority.includes(id)),
    ];

    for (const id of ordered) {
      const obj = this.objectById(id);
      if (!obj || obj.destroyed) {
        this.releaseConcentration(side, id, 'object no longer exists');
        continue;
      }
      const upkeep = concentrationUpkeepMilliMana(
        obj.massG,
        obj.material,
        obj.temperatureMilliC,
        this.rules,
      );
      if (upkeep > wizard.manaMilli) {
        this.releaseConcentration(side, id, 'mana shortfall');
        continue;
      }
      if (upkeep > 0) {
        wizard.spendMana(upkeep);
        this.events.push({ t: 'concentration_upkeep', side, objectId: id, upkeepMilli: upkeep });
      }
    }

    const before = wizard.manaMilli;
    wizard.manaMilli = Math.min(
      this.rules.wizard.manaCapMilli,
      wizard.manaMilli + this.rules.wizard.manaRegenMilli,
    );
    const gained = wizard.manaMilli - before;
    if (gained > 0) this.events.push({ t: 'regen', side, amountMilli: gained });
  }

  private syncDeltas(): void {
    for (const i of this.world.drainChanged()) {
      this.state.A.pendingCells.add(i);
      this.state.B.pendingCells.add(i);
    }
  }

  private checkEnd(): void {
    const aDead = !this.wizards.A.alive;
    const bDead = !this.wizards.B.alive;
    if (aDead || bDead) {
      this.finished = true;
      this.reason = aDead && bDead ? 'double_ko' : 'hp';
      this.winner = aDead && bDead ? null : aDead ? 'B' : 'A';
      this.events.push({
        t: 'round_end',
        round: this.round,
        winner: this.winner,
        reason: this.reason,
      });
    }
  }

  private advanceSlot(): void {
    this.slot++;
    if (this.slot < this.order.length) return;
    this.slot = 0;
    if (this.turn >= this.rules.match.turnCap) {
      // Both alive at the cap is a tie (passport §5.3). The counter stops at the
      // cap rather than running one past it, so the round log reads honestly.
      this.finished = true;
      this.reason = 'turn_cap';
      this.winner = null;
      this.events.push({ t: 'round_end', round: this.round, winner: null, reason: 'turn_cap' });
      return;
    }
    this.turn++;
  }

  /** Deterministic hash of the whole round state (passport §22, M1 gate). */
  stateHash(): string {
    const h = new Hasher();
    h.str('round').int(this.round).int(this.turn).int(this.slot);
    this.world.hashInto(h);
    for (const side of SIDES) this.wizards[side].hashInto(h);
    h.int(this.objects.length);
    for (const o of [...this.objects].sort((a, b) => a.id - b.id)) o.hashInto(h);
    for (const side of SIDES) h.ints(this.state[side].concentrations);
    return h.hex();
  }
}
