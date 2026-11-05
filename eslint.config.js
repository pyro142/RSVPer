import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['node_modules/', '.wrangler/', 'public/vendor/', '_reference/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // Never build HTML from strings on the server; responses are JSON or static.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser scripts: plain JS, no build step.
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, confetti: 'readonly', turnstile: 'readonly' },
    },
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent / DOM APIs (XSS).' },
        { property: 'outerHTML', message: 'Use textContent / DOM APIs (XSS).' },
        { property: 'insertAdjacentHTML', message: 'Use DOM APIs (XSS).' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js', 'vitest.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
