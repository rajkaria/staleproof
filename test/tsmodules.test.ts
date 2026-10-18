import { describe, expect, it } from 'vitest';
import { packageModules, readManifest, tsconfigSourceRoots, tsModuleNames, uniquePackages } from '../src/indexer/tsmodules.js';

/** pmndrs/zustand's package.json: private (published from the build folder), entry points that are all build output. */
const ZUSTAND = {
  name: 'zustand',
  private: true,
  type: 'commonjs',
  main: './index.js',
  types: './index.d.ts',
  exports: {
    './package.json': './package.json',
    '.': {
      'react-native': { types: './index.d.ts', default: './index.js' },
      import: { types: './esm/index.d.mts', default: './esm/index.mjs' },
      default: { types: './index.d.ts', default: './index.js' },
    },
    './*': { import: { types: './esm/*.d.mts', default: './esm/*.mjs' }, default: { types: './*.d.ts', default: './*.js' } },
  },
  files: ['**'],
};
const ZUSTAND_FILES = ['src/index.ts', 'src/vanilla.ts', 'src/react.ts', 'src/middleware.ts', 'src/middleware/persist.ts', 'src/vanilla/shallow.ts'];

const modulesOf = (paths: string[], manifests: [string, object][]) => {
  const pkgs = uniquePackages(manifests.map(([dir, m]) => readManifest(dir, JSON.stringify(m))).filter((p) => p !== undefined));
  const names = tsModuleNames(paths, pkgs);
  return { pkgs, names, list: [...names].map(([p, n]) => `${p} → ${n.module}`) };
};

describe('TypeScript packages whose entry points are build output', () => {
  it('a private package that declares library entry points (zustand) maps them back to src/', () => {
    const { names, list, pkgs } = modulesOf(ZUSTAND_FILES, [['', ZUSTAND]]);
    expect(list).toEqual([
      'src/index.ts → js-zustand',
      'src/vanilla.ts → js-zustand.vanilla',
      'src/react.ts → js-zustand.react',
      'src/middleware.ts → js-zustand.middleware',
      'src/middleware/persist.ts → js-zustand.middleware.persist',
      'src/vanilla/shallow.ts → js-zustand.vanilla.shallow',
    ]);
    // src/index.ts is the package itself: no re-exporting package module needed.
    expect(packageModules(pkgs, names)).toEqual([]);
  });

  it('a private package with no entry points is still an app, a docs site or a workspace root', () => {
    expect(readManifest('', JSON.stringify({ name: 'site', private: true }))).toBeUndefined();
    expect(readManifest('', JSON.stringify({ name: 'monorepo', private: true, main: 'index.js', workspaces: ['packages/*'] }))).toBeUndefined();
    expect(readManifest('website', JSON.stringify({ name: 'docs', private: true, scripts: { build: 'next build' } }))).toBeUndefined();
  });

  it('maps a build folder other than dist back to the source folder the repository has (ky: distribution → source)', () => {
    const ky = { name: 'ky', main: './distribution/index.js', types: './distribution/index.d.ts', exports: { types: './distribution/index.d.ts', default: './distribution/index.js' } };
    const { list, pkgs, names } = modulesOf(['source/index.ts', 'source/core/Ky.ts', 'source/utils/merge.ts'], [['', ky]]);
    expect(list).toEqual(['source/index.ts → js-ky', 'source/core/Ky.ts → js-ky.core.Ky', 'source/utils/merge.ts → js-ky.utils.merge']);
    expect(packageModules(pkgs, names)).toEqual([]);
  });

  it('keeps a source folder in the name when the manifest names a file that exists (a lib/ source tree)', () => {
    const { list } = modulesOf(['lib/index.js', 'lib/util.js'], [['', { name: 'oldjs', main: 'lib/index.js' }]]);
    expect(list).toEqual(['lib/index.js → js-oldjs.lib', 'lib/util.js → js-oldjs.lib.util']);
  });

  it('jotai: dist/ entries map back to src/ as before', () => {
    const jotai = { name: 'jotai', main: './dist/index.js', types: './dist/index.d.ts', exports: { '.': { 'types@>=5.5': './dist/index.d.ts', default: './dist/index.js' } } };
    const { list } = modulesOf(['src/index.ts', 'src/vanilla.ts', 'src/vanilla/utils.ts'], [['', jotai]]);
    expect(list).toEqual(['src/index.ts → js-jotai', 'src/vanilla.ts → js-jotai.vanilla', 'src/vanilla/utils.ts → js-jotai.vanilla.utils']);
  });

  it('a root entry file maps to src/ with the same stem (`./zustand.js` → `src/zustand.ts`)', () => {
    const pkg = readManifest('', JSON.stringify({ name: 'lib', main: './lib.js' }))!;
    expect(pkg.entries.indexOf('src/lib.ts')).toBeGreaterThanOrEqual(0);
    expect(pkg.entries.indexOf('src/lib.ts')).toBeLessThan(pkg.entries.indexOf('src/index.ts'));
  });

  it('reads the source folders a tsconfig names (comments and trailing commas as tsc allows): paths of its own name, rootDir, include', () => {
    // pmndrs/zustand's tsconfig.json (trimmed), with its comment.
    const zustand = `{
  "compilerOptions": {
    "strict": true,
    "skipLibCheck": true /* FIXME remove this once redux-devtools/extension fixes it */,
    "paths": { "zustand": ["./src/index.ts"], "zustand/*": ["./src/*.ts"] },
  },
  // tests are type-checked too
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}`;
    expect(tsconfigSourceRoots(zustand, 'zustand')).toEqual(['src']);
    expect(tsconfigSourceRoots('{ "extends": "@sindresorhus/tsconfig", "include": ["source"] }', 'ky')).toEqual(['source']);
    expect(tsconfigSourceRoots('{ "compilerOptions": { "rootDir": "./lib-src", "outDir": "dist" }, "include": ["lib-src", "test", "examples/**/*", "**/*.ts"] }')).toEqual(['lib-src']);
    expect(tsconfigSourceRoots('not json')).toEqual([]);
    expect(tsconfigSourceRoots('{ "include": ["./source/index.ts", "./source/types/*.d.ts"] }')).toEqual(['source', 'source/types']);
    // The folder it names maps the build output back, and is dropped from module names like src/.
    const pkg = readManifest('', JSON.stringify({ name: 'odd', main: './dist/index.js' }), '{ "compilerOptions": { "rootDir": "lib-src" } }')!;
    expect(pkg.entries.slice(0, 3)).toEqual(['dist/index.ts', 'dist/index.tsx', 'dist/index.mts']);
    expect(pkg.entries.indexOf('lib-src/index.ts')).toBeLessThan(pkg.entries.indexOf('src/index.ts'));
    expect([...tsModuleNames(['lib-src/index.ts', 'lib-src/a/b.ts'], [pkg])].map(([p, n]) => `${p} → ${n.module}`)).toEqual(['lib-src/index.ts → js-odd', 'lib-src/a/b.ts → js-odd.a.b']);
  });

  it('on a name clash the shallowest wins, and a published manifest beats a private one at any depth', () => {
    const pkgs = uniquePackages(
      [
        readManifest('', JSON.stringify({ ...ZUSTAND, name: 'core' })),
        readManifest('packages/core', JSON.stringify({ name: 'core', main: './dist/index.js' })),
        readManifest('examples/core', JSON.stringify({ name: 'core', main: './dist/index.js' })),
        readManifest('', JSON.stringify({ name: 'root-lib', exports: './dist/index.js' })),
        readManifest('fixtures/root-lib', JSON.stringify({ name: 'root-lib', exports: './dist/index.js' })),
      ].filter((p) => p !== undefined),
    );
    expect(pkgs.map((p) => `${p.name}@${p.dir}`)).toEqual(['core@packages/core', 'root-lib@']);
  });
});
