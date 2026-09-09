/**
 * Running a bot as an OS process (passport §14.1, §14.5).
 *
 * One process per match. The engine writes one JSON object per line to stdin
 * and reads one per line from stdout; stderr is captured as the debug log and
 * surfaced in the replay.
 *
 * Isolation caveat: this runner enforces the timeout, the memory ceiling (for
 * Node bots) and a stripped environment. Dropping privileges to a separate uid,
 * denying network and mounting the filesystem read-only need OS support and are
 * not done here — see README, "Sandboxing is not finished".
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { EngineToBot, Rules, SpellbookMessage } from '@spark/protocol';

export interface BotSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly cwd?: string;
}

export class BotTimeout extends Error {}

export class BotProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private queue: string[] = [];
  private waiter: ((line: string) => void) | null = null;
  private stderrLines: string[] = [];
  private exited = false;

  /** Replayed verbatim after a restart, because a restarted bot knows nothing. */
  private handshakeLog: EngineToBot[] = [];

  constructor(
    readonly spec: BotSpec,
    private readonly rules: Rules,
  ) {}

  start(): void {
    const [cmd, ...args] = this.spec.command;
    if (!cmd) throw new Error(`bot ${this.spec.name}: empty command`);

    // A deliberately small environment: a bot gets no inherited secrets.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: this.spec.cwd ?? process.cwd(),
      NODE_OPTIONS: `--max-old-space-size=${this.rules.limits.memoryMb}`,
      SPARK_BOT: '1',
    };

    const child = spawn(cmd, args, {
      cwd: this.spec.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = false;
    this.queue = [];
    this.waiter = null;

    const finish = (): void => {
      this.exited = true;
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        w('');
      }
    };
    child.on('exit', finish);
    // A bot that dies mid-turn leaves its stdin unwritable. Writing to it raises
    // EPIPE asynchronously, which would otherwise take the runner down with it;
    // a dead bot forfeits its turn, it does not end the match.
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.stderr.setEncoding('utf8');
    const errReader = createInterface({ input: child.stderr, crlfDelay: Infinity });
    errReader.on('line', (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > 500) this.stderrLines.shift();
    });

    child.stdout.setEncoding('utf8');
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => {
      const text = line.trim();
      if (text.length === 0) return;
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        w(text);
      } else {
        this.queue.push(text);
      }
    });
  }

  /** Fire-and-forget. Handshake messages are remembered so a restart can replay them. */
  send(msg: EngineToBot, remember = false): void {
    if (remember) this.handshakeLog.push(msg);
    const child = this.child;
    if (!child || this.exited || !child.stdin.writable) return;
    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      // The bot went away between the check and the write. Its turn is lost.
    }
  }

  /** Sends a message and waits for one line back, or null if the bot ran out of time. */
  async ask<T>(msg: EngineToBot, timeoutMs: number): Promise<T | null> {
    if (!this.child || this.exited) return null;
    this.send(msg);
    const line = await this.readLine(timeoutMs);
    if (line === null) return null;
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }

  private readLine(timeoutMs: number): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.exited) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter) {
          this.waiter = null;
          resolve(null);
        }
      }, timeoutMs);
      this.waiter = (line: string) => {
        clearTimeout(timer);
        resolve(line.length === 0 ? null : line);
      };
    });
  }

  /**
   * Passport §14.5: on timeout the turn is forfeited, the process is killed and
   * restarted, and the bot loses its persistent memory. Painful, not fatal.
   */
  async restart(): Promise<void> {
    await this.close();
    const log = this.handshakeLog;
    this.handshakeLog = [];
    this.start();
    for (const msg of log) {
      this.send(msg, true);
      if (msg.type === 'init') {
        // Drain the book it offers; the locked one from before still stands.
        await this.readLine(this.rules.limits.startupMs);
      }
    }
  }

  async requestSpellbook(): Promise<SpellbookMessage | null> {
    return this.ask<SpellbookMessage>(
      { type: 'init', protocolVersion: '0.1.0', rules: this.rules },
      this.rules.limits.startupMs,
    );
  }

  /** Records init in the handshake log after the book has been accepted. */
  rememberInit(): void {
    this.handshakeLog.push({ type: 'init', protocolVersion: '0.1.0', rules: this.rules });
  }

  drainStderr(): string[] {
    const out = this.stderrLines;
    this.stderrLines = [];
    return out;
  }

  async close(): Promise<void> {
    this.reader?.close();
    this.reader = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 200);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
