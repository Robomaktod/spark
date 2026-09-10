/**
 * Playback state.
 *
 * Small and mostly imperative, which is why the web plan chose Zustand: the
 * ReplayPlayer and the Pixi renderer are both mutable objects that live outside
 * React, and the store's job is to tell React when something worth re-rendering
 * changed — not to own the simulation.
 */
import { create } from 'zustand';
import type { ReplayFile, ReplayTurn } from '@spark/replay';
import { ReplayPlayer } from '@spark/replay';
import type { Frame } from '@spark/replay';
import { DEFAULT_OVERLAYS, type Overlays } from '../arena/ArenaRenderer.js';

export type PlayState = 'paused' | 'playing';

export interface ViewerState {
  replay: ReplayFile | null;
  player: ReplayPlayer | null;
  frame: Frame | null;
  /** Position within the current turn, in milli-turns, for interpolation. */
  subTurn: number;
  index: number;
  playState: PlayState;
  speed: number;
  overlays: Overlays;
  follow: boolean;
  live: boolean;
  error: string | null;

  load: (replay: ReplayFile, live?: boolean) => void;
  appendLiveTurn: (turn: ReplayTurn) => void;
  seek: (index: number) => void;
  stepTurn: (delta: number) => void;
  setPlayState: (state: PlayState) => void;
  setSpeed: (speed: number) => void;
  toggleOverlay: (key: keyof Overlays) => void;
  setFollow: (on: boolean) => void;
  setSubTurn: (t: number) => void;
  advance: (deltaMs: number) => void;
}

/** One turn of playback at 1x, in milliseconds. */
const TURN_MS = 700;

export const useViewer = create<ViewerState>((set, get) => ({
  replay: null,
  player: null,
  frame: null,
  subTurn: 1000,
  index: -1,
  playState: 'paused',
  speed: 1,
  overlays: { ...DEFAULT_OVERLAYS },
  follow: true,
  live: false,
  error: null,

  load(replay, live = false) {
    const player = new ReplayPlayer(replay);
    let frame: Frame | null = null;
    let error: string | null = null;
    try {
      frame = player.step(true);
    } catch (err) {
      error = (err as Error).message;
    }
    set({
      replay,
      player,
      frame,
      index: player.position,
      subTurn: 1000,
      playState: live ? 'playing' : 'paused',
      live,
      error,
    });
  },

  appendLiveTurn(turn) {
    const { player, replay } = get();
    if (!player || !replay) return;
    player.append([turn]);
    set({ replay: player.replay });
    // A live viewer stays pinned to the newest turn unless the user scrubbed back.
    if (get().index >= player.turnCount - 2) get().seek(player.turnCount - 1);
  },

  seek(index) {
    const { player } = get();
    if (!player) return;
    try {
      const frame = player.seek(index);
      set({ frame, index: player.position, subTurn: 1000, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  stepTurn(delta) {
    const { index } = get();
    get().seek(index + delta);
  },

  setPlayState(playState) {
    set({ playState });
  },

  setSpeed(speed) {
    set({ speed });
  },

  toggleOverlay(key) {
    set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } }));
  },

  setFollow(on) {
    set({ follow: on });
  },

  setSubTurn(t) {
    set({ subTurn: Math.max(0, Math.min(1000, t)) });
  },

  /** Drives playback from the render loop. */
  advance(deltaMs) {
    const { playState, speed, subTurn, player, index } = get();
    if (playState !== 'playing' || !player) return;
    const next = subTurn + (deltaMs / TURN_MS) * 1000 * speed;
    if (next < 1000) {
      set({ subTurn: next });
      return;
    }
    if (index + 1 >= player.turnCount) {
      // Live matches wait for the next packet; recorded ones stop at the end.
      if (!get().live) set({ playState: 'paused', subTurn: 1000 });
      else set({ subTurn: 1000 });
      return;
    }
    try {
      const frame = player.step(false);
      set({ frame, index: player.position, subTurn: next - 1000 });
    } catch (err) {
      set({ error: (err as Error).message, playState: 'paused' });
    }
  },
}));
