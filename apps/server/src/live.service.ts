/**
 * The live relay (web plan §3, §4).
 *
 * The CLI runs the match and streams **action packets**, never world state.
 * Browsers run the same engine and simulate each turn as its packet arrives, so
 * live and replay share one rendering path. A viewer joining mid-match gets the
 * packets so far in one burst and fast-simulates to catch up.
 *
 * This relay holds no simulation of its own — it is a fan-out and nothing more.
 */
import { Injectable, Logger } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { finaliseLive, type ReplayFile, type ReplayTurn } from '@spark/replay';
import { keyMatches } from './access.js';
import { ReplaysService } from './replays.service.js';

export interface LiveSummary {
  readonly id: string;
  readonly bots: { readonly A: string; readonly B: string };
  readonly seed: string;
  readonly turnCount: number;
  readonly startedAt: string;
}

interface LiveMatch {
  readonly id: string;
  header: ReplayFile;
  turns: ReplayTurn[];
  readonly startedAt: string;
  readonly watchers: Set<WebSocket>;
}

@Injectable()
export class LiveService {
  private readonly log = new Logger('live');
  private readonly matches = new Map<string, LiveMatch>();
  private wss: WebSocketServer | null = null;

  constructor(private readonly replays: ReplaysService) {}

  /**
   * Attaches to the HTTP server's upgrade path directly rather than going
   * through a Nest gateway adapter: the wire format here is the replay's own
   * `{type, ...}` envelope, and routing it through a second envelope would only
   * add a translation layer for both ends to get wrong.
   */
  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/live') return;
      if (!keyMatches(url.searchParams.get('key') ?? undefined)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const produce = url.searchParams.get('produce');
        const watch = url.searchParams.get('watch');
        if (produce) this.acceptProducer(ws, produce);
        else if (watch) this.acceptWatcher(ws, watch);
        else ws.close(1008, 'specify produce or watch');
      });
    });
  }

  /** The CLI end: one socket per match in progress. */
  private acceptProducer(ws: WebSocket, id: string): void {
    ws.on('message', (raw) => {
      let msg: { type?: string; replay?: ReplayFile; turn?: ReplayTurn };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === 'header' && msg.replay) {
        const match: LiveMatch = {
          id,
          header: msg.replay,
          turns: [],
          startedAt: new Date().toISOString(),
          watchers: new Set(),
        };
        const existing = this.matches.get(id);
        if (existing) for (const w of existing.watchers) match.watchers.add(w);
        this.matches.set(id, match);
        this.log.log(
          `live match ${id} started: ${msg.replay.bots.A.name} vs ${msg.replay.bots.B.name}`,
        );
        this.broadcast(match, { type: 'header', replay: match.header });
        return;
      }

      const match = this.matches.get(id);
      if (!match) return;

      if (msg.type === 'turn' && msg.turn) {
        match.turns.push(msg.turn);
        this.broadcast(match, { type: 'turn', turn: msg.turn });
        return;
      }

      if (msg.type === 'end') {
        // The finished replay lands in storage, so the live link becomes a
        // permanent one without anyone uploading anything twice.
        if (msg.replay) {
          try {
            this.replays.save(msg.replay);
          } catch (err) {
            this.log.warn(`could not store ${id}: ${(err as Error).message}`);
          }
        }
        this.broadcast(match, { type: 'end' });
        this.matches.delete(id);
        this.log.log(`live match ${id} finished`);
      }
    });

    ws.on('close', () => {
      const match = this.matches.get(id);
      if (!match) return;
      // The producer went away without an `end` frame: the CLI was stopped, or
      // it crashed. The turns it did play are real, and whoever is holding the
      // link should get to watch them rather than a 404 — so store what there
      // is, marked partial.
      if (match.turns.length > 0) {
        try {
          this.replays.save(finaliseLive(match.header, match.turns));
          this.log.warn(
            `live match ${id} was cut short after ${match.turns.length} turns; stored as partial`,
          );
        } catch (err) {
          this.log.warn(`could not store the partial match ${id}: ${(err as Error).message}`);
        }
      }
      this.broadcast(match, { type: 'end' });
      this.matches.delete(id);
    });
  }

  /** A browser: replay everything so far, then follow along. */
  private acceptWatcher(ws: WebSocket, id: string): void {
    const match = this.matches.get(id);
    if (!match) {
      ws.close(1008, 'no such live match');
      return;
    }
    match.watchers.add(ws);
    ws.on('close', () => match.watchers.delete(ws));

    // Catch-up burst: the header, then every turn already played.
    this.send(ws, { type: 'header', replay: match.header });
    for (const turn of match.turns) this.send(ws, { type: 'turn', turn });
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  private broadcast(match: LiveMatch, payload: unknown): void {
    for (const ws of match.watchers) this.send(ws, payload);
  }

  list(): LiveSummary[] {
    return [...this.matches.values()].map((m) => ({
      id: m.id,
      bots: { A: m.header.bots.A.name, B: m.header.bots.B.name },
      seed: m.header.seed,
      turnCount: m.turns.length,
      startedAt: m.startedAt,
    }));
  }

  shutdown(): void {
    this.wss?.close();
  }
}
