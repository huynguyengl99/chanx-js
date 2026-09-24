import { isAbsolute, relative, resolve } from 'node:path';

export interface ReuseOptions {
  /** Globs scanned for types that already exist, e.g. `src/types/backend/**\/*.ts`. */
  reuseFrom?: string[];
  /** Explicit overrides: type name to module specifier. Wins over the scan. */
  reuseMap?: Record<string, string>;
  /**
   * Treat found types as ambient globals and emit no imports, matching a setup where
   * generated files are non-module scripts merged into the global scope.
   */
  ambient?: boolean;
  /** Path prefix rewrites applied to import specifiers, e.g. `{ "src/": "@/" }`. */
  alias?: Record<string, string>;
}

export interface ReuseResolution {
  /** Type names that exist elsewhere and must not be generated. */
  skip: Set<string>;
  /** Module specifier to the names imported from it. Empty in ambient mode. */
  imports: Map<string, Set<string>>;
  /** Where each reused name was found, for the report and the strict check. */
  sources: Map<string, string>;
}

function applyAlias(
  path: string,
  alias: Record<string, string> | undefined,
): string | null {
  if (!alias) return null;
  const prefixes = Object.keys(alias).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) return alias[prefix] + path.slice(prefix.length);
  }
  return null;
}

function toSpecifier(
  filePath: string,
  outDir: string,
  alias: Record<string, string> | undefined,
): string {
  const fromCwd = relative(process.cwd(), filePath).replace(/\\/g, '/');
  const withoutExtension = fromCwd.replace(/\.(d\.)?tsx?$/, '');

  const aliased = applyAlias(withoutExtension, alias);
  if (aliased) return aliased;

  let relativePath = relative(resolve(outDir), filePath).replace(/\\/g, '/');
  relativePath = relativePath.replace(/\.(d\.)?tsx?$/, '');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function isInside(filePath: string, dir: string): boolean {
  const path = relative(resolve(dir), filePath);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/**
 * Find types the project already declares so they are referenced rather than regenerated.
 *
 * Uses the TypeScript AST rather than a line regex: `export type X`, `interface X` and
 * indented declarations are all real cases a regex over `^type\s+(\w+)\s*=` misses.
 * `ts-morph` is loaded only here, so a run without `reuseFrom` never pays for it.
 */
export async function resolveReuse(
  wanted: ReadonlySet<string>,
  outDir: string,
  options: ReuseOptions,
): Promise<ReuseResolution> {
  const skip = new Set<string>();
  const imports = new Map<string, Set<string>>();
  const sources = new Map<string, string>();

  const addImport = (specifier: string, name: string) => {
    if (options.ambient) return;
    let names = imports.get(specifier);
    if (!names) {
      names = new Set();
      imports.set(specifier, names);
    }
    names.add(name);
  };

  if (options.reuseFrom?.length) {
    const { Project } = await import('ts-morph');
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false },
    });
    project.addSourceFilesAtPaths(options.reuseFrom);

    for (const file of project.getSourceFiles()) {
      // The output directory holds the last run's generated types, not reusable ones.
      if (isInside(file.getFilePath(), outDir)) continue;
      // An import of a non-exported type fails to compile. Ambient scripts export
      // nothing and are referenced without imports, so there every declaration counts.
      const declared = [
        ...file.getTypeAliases(),
        ...file.getInterfaces(),
        ...file.getEnums(),
        ...file.getClasses(),
      ]
        .filter((declaration) => options.ambient || declaration.isExported())
        .map((declaration) => declaration.getName() ?? '');
      for (const name of declared) {
        if (!name || !wanted.has(name) || skip.has(name)) continue;
        skip.add(name);
        sources.set(name, file.getFilePath());
        addImport(toSpecifier(file.getFilePath(), outDir, options.alias), name);
      }
    }
  }

  for (const [name, specifier] of Object.entries(options.reuseMap ?? {})) {
    if (!wanted.has(name)) continue;
    skip.add(name);
    sources.set(name, specifier);
    addImport(specifier, name);
  }

  return { skip, imports, sources };
}

export function renderImports(imports: Map<string, Set<string>>): string {
  if (imports.size === 0) return '';
  const lines = [...imports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, names]) => {
      const sorted = [...names].sort();
      return `import type { ${sorted.join(', ')} } from '${specifier}';`;
    });
  return `${lines.join('\n')}\n\n`;
}
