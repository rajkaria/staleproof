import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GraphStore } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import type { Checkout } from '../src/indexer/repo.js';
import { makeGitOrg } from './helpers.js';

/**
 * `staleproof check --fail-on-predicted` (the pre-push hook) through src/cli.ts: a prediction of a beta example check
 * (src/lint/maturity.ts) is listed, lower confidence, and fails nothing unless the docs' repository opts the rule in
 * with `[rules]` (read from the graph, as indexed). The Action's `fail-on: predicted` reads the same `predicted=` count.
 */
const ROOT = join(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const U = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;
const PLAIN = `test-check-predicted-${U}`;
const OPTED = `test-check-predicted-optin-${U}`;

describe('check --fail-on-predicted and beta example checks', () => {
  let store: GraphStore;
  let org: { root: string; checkouts: Checkout[] };
  const dir = (name: string) => org.checkouts.find((c) => c.repo === `acme/${name}`)!.dir;
  const check = (graph: string, extra: string[] = []) => {
    const r = spawnSync(TSX, [join(ROOT, 'src', 'cli.ts'), '--db', inject('falkordbUrl'), '--org', graph, 'check', '--no-index', '--repo', 'acme/mini-client', '--base', 'HEAD', '--fail-on-predicted', ...extra], {
      cwd: dir('mini-client'),
      encoding: 'utf8',
      timeout: 300_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  beforeAll(async () => {
    store = await GraphStore.connect(inject('falkordbUrl'));
    org = await makeGitOrg();
    await indexOrg(store.org(PLAIN), org.checkouts);
    // The same organisation, with the docs repository opting the beta rule in (stored on its Repo node at index time).
    await writeFile(join(dir('mini-docs'), '.staleproof.toml'), '[rules]\n"example-missing-argument" = "warning"\n');
    await indexOrg(store.org(OPTED), org.checkouts);
    // The working tree makes `timeout` a required keyword: mini-docs' example no longer passes it (missing-argument).
    const path = join(dir('mini-client'), 'miniclient', 'graph.py');
    await writeFile(path, (await readFile(path, 'utf8')).replace('def query(self, q: str, params=None):', 'def query(self, q: str, params=None, *, timeout: float):'));
  }, 300_000);
  afterAll(async () => {
    for (const g of [PLAIN, OPTED]) await store.org(g).drop();
    await store.close();
    await rm(org.root, { recursive: true, force: true });
  });

  it('a beta-only prediction exits 0 by default and is listed as lower confidence', () => {
    const r = check(PLAIN);
    expect(r.err).not.toMatch(/Error:/);
    expect(r.code).toBe(0);
    const md = check(PLAIN, ['--format', 'markdown']);
    expect(md.code).toBe(0);
    expect(md.out).toContain('**Predicted to break, lower confidence (beta rules)**');
    expect(md.out).toContain('`Graph.query` requires `timeout`');
    expect(md.out).not.toContain('predicted to break 1 docs example');
    expect(md.out).toMatch(/<!-- staleproof:counts breaks=0 predicted=0 sections=\d+ mismatched=\d+ -->/);
  });

  it('exits 1 when the docs repository opts the rule in at warning, and counts it for the Action', () => {
    const r = check(OPTED);
    expect(r.code).toBe(1);
    const md = check(OPTED, ['--format', 'markdown']);
    expect(md.code).toBe(1);
    expect(md.out).toContain('### Staleproof: these changes are predicted to break 1 docs example');
    expect(md.out).not.toContain('lower confidence (beta rules)**');
    expect(md.out).toMatch(/<!-- staleproof:counts breaks=0 predicted=1 sections=\d+ mismatched=\d+ -->/);
  });
});
