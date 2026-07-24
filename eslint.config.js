'use strict';

// Automated enforcement of the CLAUDE.md "Code Style" rules that prettier and lunte can't
// check. Deliberately NO recommended preset — lunte owns correctness linting and prettier owns
// formatting; this config only backs the house style. Wired into `npm run lint`.
const styleRules = {
  // always brace if/else/for/while bodies
  curly: ['error', 'all'],
  // always strict equality
  eqeqeq: ['error', 'always'],
  // const/let, never var (Google TS baseline)
  'no-var': 'error',
  // one statement per line: no comma-operator statement chaining
  'no-sequences': 'error',
  // avoid deeply nested conditionals — same spirit for ternaries
  'no-nested-ternary': 'error',
  'max-depth': ['error', 4],
  // no single-letter names, with the sanctioned idioms as exceptions:
  // i/j/k loop indices, sort-comparator a/b, geometry locals x/y, brittle's
  // test param t, and _ for unused params. Property names (SQL columns,
  // protocol/geo fields) are not ours to rename.
  'id-length': [
    'error',
    {
      min: 2,
      exceptions: ['i', 'j', 'k', 'a', 'b', 't', 'x', 'y', '_'],
      properties: 'never'
    }
  ],
  // never setInterval — use a self-rescheduling setTimeout (CLAUDE.md Code Style)
  'no-restricted-globals': [
    'error',
    {
      name: 'setInterval',
      message:
        'Use a self-rescheduling setTimeout that re-arms as its last step (CLAUDE.md).'
    },
    {
      name: 'clearInterval',
      message:
        'Pairs with setInterval — use clearTimeout with the self-rescheduling pattern.'
    }
  ]
};

// Named exports only (Google TS baseline). Only meaningful for ESM files.
const namedExportsOnly = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ExportDefaultDeclaration',
      message: 'Use named exports (CLAUDE.md Code Style / Google TS baseline).'
    }
  ]
};

module.exports = [
  {
    ignores: ['**/node_modules/**', 'out/**']
  },
  // Bare/Node CJS: the OTA updater (app.cjs, workers/main.cjs) + build script.
  {
    files: ['**/*.cjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: styleRules
  },
  // ESM surfaces: the CLI entry, shared modules, and every command (.mjs).
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: { ...styleRules, ...namedExportsOnly }
  }
];
