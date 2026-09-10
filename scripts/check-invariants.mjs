#!/usr/bin/env node
/**
 * Spark's invariants, enforced.
 *
 * A linter catches style. This catches the four things that, if they break,
 * break the game rather than the code review:
 *
 *   determinism   no floating point anywhere the simulation can see it
 *   purity        the engine does no I/O and knows about no framework
 *   layering      packages depend only on what they are allowed to
 *   protocol      the wire package stays dependency-free
 *
 * Every one of these is a rule the design documents state and the type system
 * cannot express. They are here because an agent reading `docs/CODING-RULES.md`
 * will believe it, and an agent that skips the docs will still be stopped.
 *
 * Escape hatch, on the offending line or the line above it:
 *
 *   // invariant-ok(determinism): seeds a Newton iteration, corrected exactly below
 *
 * The reason is mandatory and is meant to be read by a human. If you cannot
 * write one, the rule is telling you something.
 *
 * Usage: node scripts/check-invariants.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/** Math functions that take integers to integers. Everything else returns a float. */
const INTEGER_SAFE_MATH = new Set(['floor', 'ceil', 'abs', 'max', 'min', 'trunc', 'sign', 'round']);

/**
 * Directories whose code runs inside the simulation, or describes it on the
 * wire. Passport §13: no float anywhere in the simulation, and none crossing
 * the bot boundary.
 */
const DETERMINISTIC = ['packages/protocol/src', 'packages/engine/src', 'packages/replay/src'];

/** Passport §17: the engine is a pure simulation core. No I/O, no framework. */
const PURE = ['packages/protocol/src', 'packages/engine/src'];

/**
 * What each package may declare as a dependency. The point is the direction:
 * nothing upstream may reach downstream, and the engine may never depend on a
 * framework — that is what let it ship to the browser unchanged.
 */
const ALLOWED_DEPENDENCIES = {
  'packages/protocol': [],
  'packages/engine': ['@spark/protocol'],
  'packages/replay': ['@spark/protocol', '@spark/engine'],
  'packages/sdk-ts': ['@spark/protocol', '@spark/engine'],
  'apps/cli': ['@spark/protocol', '@spark/engine', '@spark/replay', 'ws'],
  'apps/viewer-ascii': ['@spark/protocol', '@spark/engine', '@spark/replay'],
};

const findings = [];

function report(rule, file, line, text, why) {
  findings.push({ rule, file, line, text: text.trim().slice(0, 100), why });
}

/* ------------------------------------------------------------------ */
/* Source scanning                                                     */
/* ------------------------------------------------------------------ */

/**
 * Blanks out comments and string bodies, keeping every character position so
 * line and column numbers still line up. Without this the checker fires on
 * every prose mention of `Math.cos` and every `"0.1.0"` version string, and a
 * checker that cries wolf gets switched off.
 */
function stripCommentsAndStrings(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === quote) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function sourceFiles(dir) {
  const root = join(REPO, dir);
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) found.push(path);
    }
  };
  try {
    walk(root);
  } catch {
    // A directory that does not exist yet is not a violation.
  }
  return found;
}

/** True when this line, or the one above it, waives this rule with a reason. */
function waived(rawLines, index, rule) {
  const pattern = new RegExp(`invariant-ok\\(${rule}\\)\\s*:\\s*\\S`);
  return pattern.test(rawLines[index] ?? '') || pattern.test(rawLines[index - 1] ?? '');
}

const DETERMINISM_PATTERNS = [
  {
    // Math.random, Math.sqrt, Math.hypot, Math.cos — anything that is not
    // integer-in, integer-out.
    regex: /\bMath\.([a-zA-Z]+)/g,
    accept: (m) => INTEGER_SAFE_MATH.has(m[1]),
    why: 'Math beyond floor/ceil/abs/max/min/trunc/sign/round returns a float, and float results are not identical across engines',
  },
  {
    regex: /\b\d[\d_]*\.\d/g,
    why: 'a decimal literal is a float; scale it to an integer instead (passport §13 — 1 unit = 1/1000 base unit)',
  },
  {
    regex: /(?<![\w.$])\.\d/g,
    why: 'a decimal literal is a float; scale it to an integer instead',
  },
  {
    regex: /\b\d[\d_]*(?:\.\d+)?e-\d/gi,
    why: 'a negative exponent is a fractional literal; scale it to an integer instead',
  },
  {
    regex: /\bparseFloat\b|\bNumber\.parseFloat\b/g,
    why: 'parseFloat produces a float; the protocol carries integers only',
  },
  {
    regex: /\.toFixed\(/g,
    why: 'toFixed implies a float; formatting belongs in a viewer, not in the simulation',
  },
  {
    regex: /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/g,
    why: 'wall-clock time makes a run depend on when it happened; the simulation must depend only on its inputs',
  },
];

const PURITY_PATTERNS = [
  {
    regex: /from\s+['"]node:[a-z/]+['"]/g,
    why: 'the engine does no I/O (passport §17); it has to run unchanged in a browser',
  },
  {
    regex: /\brequire\s*\(/g,
    why: 'the engine is ESM only, and requiring a module is I/O',
  },
  {
    regex: /(?<![\w.$])process\.[a-z]/g,
    why: 'the engine may not read its environment; everything it needs arrives in the Rules',
  },
  {
    regex: /(?<![\w.$])console\.[a-z]/g,
    why: 'the engine reports through the event log, not through a stream it does not own',
  },
  {
    regex: /(?<![\w.$])fetch\s*\(/g,
    why: 'the engine does no I/O',
  },
];

function scan(dirs, patterns, rule) {
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const raw = readFileSync(file, 'utf8');
      const rawLines = raw.split('\n');
      const codeLines = stripCommentsAndStrings(raw).split('\n');
      codeLines.forEach((code, index) => {
        for (const pattern of patterns) {
          pattern.regex.lastIndex = 0;
          let match;
          while ((match = pattern.regex.exec(code)) !== null) {
            if (pattern.accept?.(match)) continue;
            if (waived(rawLines, index, rule)) continue;
            report(rule, relative(REPO, file), index + 1, rawLines[index] ?? '', pattern.why);
          }
        }
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Package layering                                                    */
/* ------------------------------------------------------------------ */

function checkLayering() {
  for (const [pkg, allowed] of Object.entries(ALLOWED_DEPENDENCIES)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(REPO, pkg, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const dep of declared) {
      if (allowed.includes(dep)) continue;
      report(
        'layering',
        `${pkg}/package.json`,
        1,
        `depends on ${dep}`,
        allowed.length === 0
          ? `${pkg} must have no dependencies at all (passport §17)`
          : `${pkg} may depend only on ${allowed.join(', ')} — see docs/ARCHITECTURE.md`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */

scan(DETERMINISTIC, DETERMINISM_PATTERNS, 'determinism');
scan(PURE, PURITY_PATTERNS, 'purity');
checkLayering();

if (asJson) {
  process.stdout.write(JSON.stringify({ ok: findings.length === 0, findings }, null, 2) + '\n');
} else if (findings.length === 0) {
  process.stdout.write('invariants hold: determinism, purity, layering\n');
} else {
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  for (const [rule, list] of byRule) {
    process.stdout.write(`\n${rule} — ${list.length} violation${list.length === 1 ? '' : 's'}\n`);
    for (const f of list) {
      process.stdout.write(`  ${f.file}:${f.line}\n    ${f.text}\n    ${f.why}\n`);
    }
  }
  process.stdout.write(
    `\n${findings.length} violation${findings.length === 1 ? '' : 's'}. ` +
      `Fix them, or waive one on its line with "// invariant-ok(<rule>): <reason>".\n`,
  );
}

process.exitCode = findings.length === 0 ? 0 : 1;
