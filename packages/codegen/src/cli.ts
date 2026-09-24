#!/usr/bin/env node
import { cac } from 'cac';

import { generate } from './generate';
import { loadSchema } from './loader';

const cli = cac('chanx-codegen');

cli
  .command('[schema]', 'Generate a typed client from a chanx AsyncAPI 3 schema')
  .option('-s, --schema <input>', 'URL or path to the AsyncAPI document')
  .option('-o, --out <dir>', 'Output directory', { default: 'src/generated' })
  .option('--validation <mode>', 'none | zod', { default: 'none' })
  .option('--emit <target>', 'ts | js (js writes .js alongside .d.ts)', { default: 'ts' })
  .option('--reuse-from <glob>', 'Glob of files declaring types to reuse (repeatable)')
  .option('--reuse-strict', 'Emit compile-time assertions that reused types still match')
  .option('--ambient', 'Skip reused types without importing them (global script output)')
  .option('--alias <mapping>', 'Import path rewrite, e.g. src/=@/ (repeatable)')
  .option('--no-format', 'Skip prettier formatting')
  .action(async (positional: string | undefined, flags: Record<string, unknown>) => {
    const input = (flags.schema as string | undefined) ?? positional;
    if (!input) {
      console.error('Pass a schema: chanx-codegen <url|path> -o src/generated');
      process.exit(1);
    }

    const alias = Object.fromEntries(
      toArray(flags.alias).map((entry) => {
        const index = entry.indexOf('=');
        if (index === -1)
          throw new Error(`--alias expects prefix=replacement, got "${entry}"`);
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );

    console.log(`Loading ${input}`);
    const document = await loadSchema(input);
    console.log(
      `  ${document.info?.title ?? 'untitled'} ${document.info?.version ?? ''}`,
    );

    const result = await generate(document, {
      outDir: flags.out as string,
      validation: flags.validation as 'none' | 'zod',
      emit: flags.emit as 'ts' | 'js',
      reuseFrom: toArray(flags.reuseFrom),
      reuseStrict: Boolean(flags.reuseStrict),
      ambient: Boolean(flags.ambient),
      alias,
      format: flags.format !== false,
    });

    console.log(
      `  ${result.channels} channels, ${result.topics} topics, ${result.generatedTypes} types`,
    );
    if (result.reusedTypes.length) {
      console.log(
        `  reused ${result.reusedTypes.length}: ${result.reusedTypes.join(', ')}`,
      );
      if (!flags.reuseStrict) {
        console.log('  (pass --reuse-strict to check the reused shapes still match)');
      }
    }
    for (const file of result.files) console.log(`  wrote ${file}`);
  });

function toArray(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

cli.help();
cli.parse();
