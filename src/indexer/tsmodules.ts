import { posix } from 'node:path';
import type { PyDef, PyModule } from './python.js';
import { npmToken, sanitize } from './typescript.js';

/**
 * An npm package in a repository: a `package.json` with a name that is published, or private
 * but declaring a library's entry points (zustand publishes from its build folder).
 */
export interface NpmPackage {
  dir: string;
  name: string;
  /** Source files the manifest's entry points (main/module/types/exports) map back to, best first. */
  entries: string[];
  /** The entry points as the manifest writes them (repository paths): build output when none exists. */
  written?: string[];
  /** `"private": true`: loses a name clash to a published manifest. */
  private?: boolean;
}

export const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface Manifest {
  name?: string;
  private?: boolean;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  source?: string;
  exports?: unknown;
  engines?: { vscode?: unknown };
}

function exportsEntry(exp: unknown): string[] {
  if (typeof exp === 'string') return [exp];
  if (!exp || typeof exp !== 'object') return [];
  const o = exp as Record<string, unknown>;
  const dot = '.' in o ? o['.'] : o;
  if (typeof dot === 'string') return [dot];
  if (!dot || typeof dot !== 'object') return [];
  const d = dot as Record<string, unknown>;
  return ['source', 'types', 'import', 'module', 'require', 'default', 'node'].flatMap((k) => exportsEntry(d[k]));
}

/** Folders a build writes to: an entry point under one is output, not source. */
const BUILD_DIR = /^(dist|build|lib|out|esm|cjs|es|umd|distribution|bundle|output|compiled|release|types|typings|module)\//;

/**
 * `dist/index.js`, `./lib/main.d.ts`, `./esm/index.mjs`, `./index.js` → the source files they
 * were built from: the path as written, then the same stem under the folders the tsconfig
 * names (`roots`), `src/` and `source/`.
 */
function sourceCandidates(entry: string, roots: readonly string[] = []): string[] {
  const clean = posix.normalize(entry.replace(/^\.\//, '')).replace(/\.d\.(m|c)?ts$/, '').replace(/\.(m|c)?js$/, '').replace(/\.(m|c)?ts$/, '');
  if (clean.startsWith('..') || clean.includes('*')) return [];
  const inner = clean.replace(BUILD_DIR, '').replace(/^(esm|cjs|src)\//, '');
  const stems = [clean, ...(BUILD_DIR.test(clean) || !clean.includes('/') ? [...roots, 'src', 'source'].map((r) => `${r}/${inner}`) : [])];
  return [...new Set(stems)].flatMap((s) => ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx'].map((x) => `${s}${x}`));
}

/** JSON with comments and trailing commas, as `tsconfig.json` is written; undefined when it does not parse. */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      // A string, escapes and all.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

/** Folders a tsconfig may include that are not the library's source. */
const NOT_SOURCE = /(^|\/)(tests?|__tests__|spec|e2e|benchmarks?|examples?|scripts|docs?|website|node_modules|dist|build)(\/|$)/;

/**
 * The source folders a package's `tsconfig.json` names, best first: where `paths` maps the
 * package's own name (zustand: `"zustand": ["./src/index.ts"]`), `rootDir`, then the
 * `include` folders (`src/**\/*` → `src`). Tests, examples and tooling are left out.
 */
export function tsconfigSourceRoots(text: string, name?: string): string[] {
  const c = parseJsonc(text) as { compilerOptions?: { rootDir?: unknown; paths?: Record<string, unknown> }; include?: unknown } | undefined;
  if (!c || typeof c !== 'object') return [];
  const out: string[] = [];
  const add = (p: unknown) => {
    if (typeof p !== 'string') return;
    const named = posix.normalize(p.replace(/^\.\//, '')).split('*')[0]!.replace(/\/+$/, '');
    // An included file (`source/index.ts`) names its folder.
    const dir = /\.[cm]?[jt]sx?$/.test(named) ? posix.dirname(named) : named;
    if (dir && dir !== '.' && !dir.startsWith('..') && !NOT_SOURCE.test(dir)) out.push(dir);
  };
  const own = name ? c.compilerOptions?.paths?.[name] : undefined;
  if (Array.isArray(own)) for (const t of own) if (typeof t === 'string') add(posix.dirname(t));
  add(c.compilerOptions?.rootDir);
  if (Array.isArray(c.include)) for (const i of c.include) add(i);
  return [...new Set(out)];
}

/** Fields only a library's manifest sets (an app or a workspace root may still have the `main` npm init writes). */
function declaresLibrary(m: Manifest): boolean {
  return [m.exports, m.module, m.types, m.typings, m.source].some((x) => x !== undefined && x !== null);
}

/**
 * The package a `package.json` declares, when it is one. `tsconfig` (the `tsconfig.json` beside
 * it, optional) names where the source lives when the entry points are build output.
 */
export function readManifest(dir: string, text: string, tsconfig?: string): NpmPackage | undefined {
  let m: Manifest;
  try {
    m = JSON.parse(text) as Manifest;
  } catch {
    return undefined;
  }
  // A VS Code extension is loaded by the editor, never imported, and often shares the library's name.
  if (!m.name || m.engines?.vscode) return undefined;
  // Private: an app, a docs site or a workspace root, unless it declares a library's entry points
  // (a package published from its build folder, like zustand).
  if (m.private && !declaresLibrary(m)) return undefined;
  const written = [m.source, m.types, m.typings, m.module, ...exportsEntry(m.exports), m.main].filter((x): x is string => typeof x === 'string');
  const roots = tsconfig ? tsconfigSourceRoots(tsconfig, m.name) : [];
  const entries = written.flatMap((w) => sourceCandidates(w, roots));
  entries.push(...roots.flatMap((r) => [`${r}/index.ts`, `${r}/index.tsx`]));
  entries.push(...['src/index.ts', 'src/index.tsx', 'index.ts', 'src/index.js', 'index.js', 'lib/index.js', 'src/main.ts', 'source/index.ts']);
  const prefix = dir ? `${dir}/` : '';
  return {
    dir,
    name: m.name,
    entries: [...new Set(entries.map((e) => `${prefix}${e}`))],
    written: [...new Set(written.map((w) => posix.normalize(`${prefix}${w.replace(/^\.\//, '')}`)))],
    ...(m.private ? { private: true } : {}),
  };
}

/**
 * One package per name: when manifests share a name (an `examples/` copy, a fixture), the shallowest
 * is the package; a published manifest beats a private one at any depth (a private root that
 * shares its name with the package it builds).
 */
export function uniquePackages(packages: NpmPackage[]): NpmPackage[] {
  const rank = (p: NpmPackage) => (p.private ? 1000 : 0) + (p.dir ? p.dir.split('/').length : 0);
  const best = new Map<string, NpmPackage>();
  for (const p of packages) {
    const seen = best.get(p.name);
    if (!seen || rank(p) < rank(seen)) best.set(p.name, p);
  }
  return packages.filter((p) => best.get(p.name) === p);
}

/** The package a file belongs to: the nearest enclosing package directory. */
export function packageOf(path: string, packages: NpmPackage[]): NpmPackage | undefined {
  let best: NpmPackage | undefined;
  for (const p of packages) {
    if (p.dir && !path.startsWith(`${p.dir}/`)) continue;
    if (!best || p.dir.length > best.dir.length) best = p;
  }
  return best;
}

export interface TsModuleName {
  module: string;
  pkg: NpmPackage;
  /** An `index` file: relative imports of its directory resolve to it. */
  isIndex: boolean;
}

/**
 * Module names for a repository's TypeScript/JavaScript files: `js-<package>` plus the
 * path inside the package (a leading `src/` dropped, `index` files naming their
 * directory). Files outside a published package are not library code and get none.
 */
export function tsModuleNames(paths: string[], packages: NpmPackage[]): Map<string, TsModuleName> {
  const out = new Map<string, TsModuleName>();
  const roots = sourceRoots(paths, packages);
  for (const path of paths) {
    if (!TS_EXT.test(path)) continue;
    const pkg = packageOf(path, packages);
    if (!pkg) continue;
    const rel = (pkg.dir ? path.slice(pkg.dir.length + 1) : path).replace(TS_EXT, '');
    const root = roots.get(pkg);
    const parts = (root && rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel.replace(/^src\//, '')).split('/');
    const isIndex = parts.at(-1) === 'index';
    if (isIndex) parts.pop();
    out.set(path, { module: [npmToken(pkg.name), ...parts.map(sanitize)].join('.'), pkg, isIndex });
  }
  return out;
}

/**
 * A package's source folder other than `src/` (dropped from module names like `src/` is), when
 * every entry point the manifest writes is missing (build output) and the one that maps back to
 * source is that folder's index: ky's `distribution/index.js` → `source/index.ts`. A manifest
 * naming a file that exists keeps today's names (`lib/` as a JS source tree stays in them).
 */
function sourceRoots(paths: string[], packages: NpmPackage[]): Map<NpmPackage, string> {
  const have = new Set(paths);
  const out = new Map<NpmPackage, string>();
  for (const pkg of packages) {
    if (!pkg.written?.length || pkg.written.some((w) => have.has(w))) continue;
    const entry = pkg.entries.find((e) => have.has(e));
    const rel = entry && (pkg.dir ? entry.slice(pkg.dir.length + 1) : entry);
    const m = rel ? /^([\w.-]+)\/index\.[cm]?[jt]sx?$/.exec(rel) : null;
    if (m && m[1] !== 'src' && !BUILD_DIR.test(`${m[1]}/`)) out.set(pkg, m[1]!);
  }
  return out;
}

/** Resolve a relative import from a file to the module of the file it names (`./graph`, `./graph.js`, `../util/index`). */
export function relativeResolver(from: string, names: Map<string, TsModuleName>): (spec: string) => string | undefined {
  const dir = posix.dirname(from);
  return (spec) => {
    const base = posix.normalize(posix.join(dir, spec)).replace(/\.(m|c)?js$/, '');
    for (const ext of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs']) {
      const hit = names.get(`${base}${ext}`);
      if (hit) return hit.module;
    }
    return undefined;
  };
}

/**
 * The module a package's name imports (`import { X } from 'falkordb'`): when the entry
 * file isn't already named after the package, a module that re-exports it.
 */
export function packageModules(packages: NpmPackage[], names: Map<string, TsModuleName>): PyModule[] {
  const out: PyModule[] = [];
  for (const pkg of packages) {
    const token = npmToken(pkg.name);
    const entry = pkg.entries.map((e) => names.get(e)).find(Boolean);
    if (!entry || entry.module === token) continue;
    const def: PyDef = { qualname: token, name: token, kind: 'module', lineno: 1, endLineno: 1, signature: '', decorators: [], parent: null, returnExprs: [], bases: [], params: [], isAsync: false };
    out.push({
      module: token,
      path: pkg.dir ? `${pkg.dir}/package.json` : 'package.json',
      defs: [def],
      imports: [{ alias: '*', target: entry.module, lineno: 1, exported: true }],
      bindings: [],
      calls: [],
      idents: [],
      lang: 'ts',
    });
  }
  return out;
}
