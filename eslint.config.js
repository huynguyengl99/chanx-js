import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/tests/__fixtures__/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // React-only. The other bindings expose functions named `useChannel` too, and a
    // Vue `setup()` calling one is not a React hook violation.
    files: ['packages/client/src/react/**', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A connection only exists once the effect has run, and a shared socket may
      // already be open, so it never fires an initial status change. Publishing both
      // from the effect is the one correct order here.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
