// @ts-check
/**
 * Style and correctness. The rules that actually define Spark — no floats in
 * the simulation, no I/O in the engine, no upstream dependency reaching
 * downstream — live in `scripts/check-invariants.mjs`, because they are not
 * expressible here without a custom plugin. Run both: `npm run verify` does.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** Modules the simulation core must never reach for. */
const FRAMEWORK_AND_IO = [
  { group: ['node:*'], message: 'The engine does no I/O — it has to run unchanged in a browser.' },
  {
    group: ['express', '@nestjs/*', 'react', 'react-dom', 'pixi.js'],
    message: 'The simulation core has no framework dependency (passport §17).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'replays/**',
      'docs/**',
      'apps/web/test/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // An unused import is usually a half-finished edit, and half-finished
      // edits are what an agent leaves behind most often.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` erases the one guarantee the protocol package exists to provide.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      // A switch over a discriminated union is how the event log stays
      // complete: add a variant without a case and the compiler objects.
      'no-fallthrough': 'error',
    },
  },

  {
    files: ['packages/protocol/src/**/*.ts', 'packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FRAMEWORK_AND_IO }],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Everything the engine needs arrives in the Rules.' },
        { name: 'fetch', message: 'The engine does no I/O.' },
      ],
    },
  },

  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        HTMLElement: 'readonly',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Tests reach into internals on purpose, and the CLI is the I/O shell.
    files: ['**/test/**/*.ts', '**/*.test.ts', 'apps/cli/src/**/*.ts', 'apps/server/src/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  {
    // Nest resolves constructor dependencies from decorator metadata, which
    // needs the class present at runtime. `import type` erases it, and the
    // failure is a null injection at boot rather than a compile error — so the
    // rule is off here rather than waived case by case.
    files: ['apps/server/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },

  {
    files: ['**/*.mjs', '*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly' },
    },
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
);
