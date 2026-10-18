import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: ['.dependency-cruiser.cjs', 'dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/extensions': ['error', 'never'],
      'import/no-default-export': 'error',
      'import/no-cycle': 'error',
      'no-console': 'warn',
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
      ],
    },
  },
  {
    files: ['src/lambdas/**/*.ts'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  {
    files: ['src/server.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.config.{js,ts,mjs}'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
];
