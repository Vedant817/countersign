/**
 * Countersign — ESLint flat config (spec §8.0, §8.10).
 *
 * Two rules here are load-bearing, not cosmetic:
 *
 *  1. `no-restricted-imports` inside **packages/gate** bans `ai` and `@ai-sdk/*`. The Gate is the
 *     deterministic policy enforcement point; an LLM must never be able to influence it
 *     (spec §8.10 "Rules", core invariant I-1 in §3.1).
 *  2. `@typescript-eslint/no-explicit-any` is an **error** everywhere (spec §8.0 rule 7: "no `any`").
 *
 * Money discipline (spec §0: money is integer minor units, never floats) is **not** enforced here,
 * because no static rule catches `Number(m.minor) / 100` without also flagging legitimate work. It is
 * enforced where it can be: `packages/core`'s boundary schemas refuse floats at runtime, and
 * `scripts/check-money-discipline.mjs` (run by `pnpm lint` in CI) scans the money-bearing packages
 * for the float idioms that actually cause incidents.
 *
 * Run with: pnpm lint
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

const LLM_RUNTIME_BAN = ['ai', 'ai/*', '@ai-sdk/*', 'openai', '@anthropic-ai/*', 'ollama']

const GATE_LLM_BAN = [
  {
    files: ['packages/gate/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: LLM_RUNTIME_BAN,
              message:
                'packages/gate is the deterministic policy enforcement point and must not import an LLM ' +
                'runtime. Spec §8.10: "No LLM anywhere in M10, enforced by a lint rule". ' +
                'Move the language-shaped work to packages/compiler or packages/agent.',
            },
          ],
        },
      ],
    },
  },
]

/**
 * The Defender's router gets a *narrower* ban than the Gate, and the difference is the whole design.
 *
 * Spec §8.15 is a rules table and §8.16 requires a 40-case eval at 100%, which is only achievable
 * because the router is a pure function. Judge question 20 asks "what stops the AI from filing a bogus
 * dispute against a good customer?" — the answer is that the model never chooses the posture.
 *
 * So the ban covers **the files that decide the posture** — `rules`, `router`, `rationale` — and not the
 * whole package. WP-15c's drafter lives in the same package and *must* be able to call a model to write
 * the notes; banning the package would force that work somewhere dishonest, and a lint rule nobody can
 * satisfy gets deleted.
 *
 * A file-scoped ban is still a real control: it fails in an editor while you write the line, which a CI
 * test cannot do. `packages/defender/test/router.test.ts` asserts the same boundary structurally, so
 * removing this rule does not silently open the hole.
 */
const ROUTER_LLM_BAN = [
  {
    files: [
      'packages/defender/src/rules.ts',
      'packages/defender/src/router.ts',
      'packages/defender/src/rationale.ts',
      'packages/defender/src/types.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: LLM_RUNTIME_BAN,
              message:
                'This file decides the dispute posture and must stay a pure function. Spec §8.15 is a ' +
                'rules table and §8.16 requires 100% on the 40-case eval, which is only reachable ' +
                'because nothing here is generated. The model may plan evidence and draft notes in ' +
                'planner.ts / drafter.ts — it may not choose whether to contest. ' +
                'See docs/DECISIONS.md D-023.',
            },
          ],
        },
      ],
    },
  },
]

/** Files that legitimately touch Node-only or browser-only globals. */
const nodeGlobals = {
  ...globals.node,
  ...globals.es2023,
}

const browserGlobals = {
  ...globals.browser,
  crypto: 'readonly',
  indexedDB: 'readonly',
  CryptoKey: 'readonly',
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.artifacts/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // --- correctness ---
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // AGENTS.md engineering rule 7: "no `any`".
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'no-implicit-coercion': ['error', { boolean: false }],
    },
  },

  // --- browser surfaces (apps/web components + client libs) ---
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
  },

  // --- tests may use console and non-null assertions freely ---
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/tests/**', '**/vitest.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  // --- scripts are operational CLIs: console is the point ---
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
    rules: { 'no-console': 'off' },
  },

  // --- generated ---
  {
    files: ['packages/db/src/migrations/**', '**/drizzle/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },

  ...GATE_LLM_BAN,
  ...ROUTER_LLM_BAN,
)
