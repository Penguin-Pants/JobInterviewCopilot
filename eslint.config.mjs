import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Two rules here are guardrails, not style (TASK-001, TASK-011, NFR-002).
 *
 * 1. No filesystem imports anywhere on the reachable audio path. Transferring
 *    the PCM ArrayBuffer neuters the worker's reference, it does not stop a
 *    downstream adapter from persisting the bytes it receives. The ban must
 *    therefore cover the STT layer too, not just where the audio starts.
 * 2. No deep imports into src/main/rag/*. Only the rag.ts facade is importable
 *    from outside, so "the RAG engine must not know about sessions" is enforced
 *    by the linter rather than by convention.
 */
const AUDIO_PATH_FILES = [
  'src/renderer/audio-worker/**/*.ts',
  // The worklet itself. It handles raw PCM and ships as a plain asset, so the
  // glob has to name it: `**/*.ts` does not reach a `.js` file in public/.
  'src/renderer/public/pcm-processor.js',
  'src/main/audio.ts',
  'src/main/audio-host.ts',
  'src/main/ai/stt.ts',
  'src/main/ai/stt/**/*.ts',
];

const FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'original-fs'];

/**
 * The worklet runs in the AudioWorkletGlobalScope, which has its own globals and
 * is not the window. It ships as a plain asset rather than through the bundler,
 * because a `blob:` module URL is blocked by the renderer's `script-src`.
 */
const AUDIO_WORKLET_GLOBALS = {
  AudioWorkletProcessor: 'readonly',
  registerProcessor: 'readonly',
  currentTime: 'readonly',
  sampleRate: 'readonly',
};

export default [
  {
    files: ['src/renderer/public/pcm-processor.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: AUDIO_WORKLET_GLOBALS,
    },
  },
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    // Node scripts run outside the app bundle and use Node globals directly.
    files: [
      'scripts/**/*.mjs',
      'scripts/**/*.cjs',
      'spike/**/*.cjs',
      'spike/**/*.js',
      '*.config.ts',
      '*.config.mjs',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        document: 'readonly',
        AudioContext: 'readonly',
        Float32Array: 'readonly',
        Date: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        window: 'readonly',
        document: 'readonly',
        globalThis: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'src/main/rag/index',
              message: 'Import the rag.ts facade, not its internals (CMP-06).',
            },
          ],
          patterns: [
            {
              group: ['**/main/rag/*', '../rag/*', './rag/*'],
              message:
                'Deep import into the RAG engine is forbidden. Only src/main/rag.ts is public (CMP-06, TASK-001).',
            },
          ],
        },
      ],
    },
  },
  {
    // The RAG facade and the RAG internals are allowed to import each other.
    files: ['src/main/rag.ts', 'src/main/rag/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // NFR-002: no filesystem access anywhere audio bytes can reach.
    files: AUDIO_PATH_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FS_MODULES.map((name) => ({
            name,
            message:
              'Audio bytes must never reach the filesystem (NFR-002, ADR-019). This file is on the reachable audio path.',
          })),
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
