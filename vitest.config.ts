import { defineConfig } from 'vitest/config';

/**
 * Solid needs the `solid` and `browser` conditions: under plain Node resolution
 * `solid-js` loads its server build, where every signal is an inert stub and the
 * binding's reactivity silently does nothing.
 *
 * Those conditions cannot be global, because `browser` also sends `ws` to its browser
 * stub and breaks the Node end-to-end test. Hence one project each.
 */
const solidConditions = ['solid', 'browser', 'import', 'module', 'default'];

const solidTests = 'packages/client/tests/solid.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { conditions: solidConditions },
        ssr: { resolve: { conditions: solidConditions } },
        test: {
          name: 'solid',
          environment: 'node',
          include: [solidTests],
          server: { deps: { inline: [/solid-js/] } },
        },
      },
      {
        test: {
          name: 'default',
          environment: 'node',
          include: ['packages/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.tsx'],
          exclude: ['**/node_modules/**', solidTests],
        },
      },
    ],
  },
});
