import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDocs, auditFindingsOf, auditTool, publicApi, scoreAudit } from '../src/audit.js';
import { auditMarkdown, auditText } from '../src/format/audit.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg, INDEX_VERSION } from '../src/indexer/index.js';
import { maturityOf } from '../src/lint/maturity.js';
import type { RuleId } from '../src/lint/types.js';
import type { ToolContext } from '../src/tools/types.js';
import { FIXTURE_REPOS, STALE_DOCS, testConfig, testGraph } from './helpers.js';

describe('docs audit (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('audit'));
    await indexOrg(graph, [...FIXTURE_REPOS, STALE_DOCS]);
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => done());

  it('scores the whole graph: beta example checks listed but not counted, coverage, deductions', async () => {
    const r = await auditDocs(ctx);
    expect(r.data.repos.map((x) => x.name)).toEqual(['acme/mini-client', 'acme/mini-docs', 'acme/mini-sdk', 'acme/stale-docs']);
    // Every static example kind is beta (src/lint/maturity.ts, 0.8.0) and no fixture opts one in: none is counted.
    expect(r.data.examples).toEqual({ total: 9, python: 8, linked: 8, mismatched: 0 });
    expect(r.data.mismatches.map((m) => `${m.example.split(':').slice(1).join(':')} L${m.line} ${m.kind}`)).toEqual([
      'docs/stale.md:0 L8 missing-import',
      'docs/stale.md:0 L10 unknown-keyword',
      'docs/stale.md:1 L19 too-many-arguments',
      'docs/stale.md:1 L20 missing-attribute',
      'docs/stale.md:2 L31 unknown-keyword',
    ]);
    expect(r.data.mismatches[0]).toMatchObject({ heading: 'Upgrading guide > Connect', url: 'https://github.com/acme/stale-docs/blob/fixture/docs/stale.md#L8' });
    // Beta kinds (src/lint/maturity.ts) are listed, flagged lowerConfidence, and not counted in `mismatched`.
    expect(r.data.mismatches.map((m) => m.lowerConfidence === true)).toEqual(r.data.mismatches.map((m) => maturityOf(`example-${m.kind}` as RuleId) === 'beta'));
    expect(r.data.coverage).toEqual({ api: 14, documented: 10, percent: 71.4 });
    // The API is what the packages export (minisdk exports only Rag, so Connection is internal).
    // Called from another repository first (minisdk uses the async client), then classes, then by callers.
    expect(r.data.undocumented.map((u) => `${u.qualname} ${u.crossRepoCallers}/${u.callers}`)).toEqual([
      'miniclient.asyncio.client.AsyncClient 1/1',
      'miniclient.asyncio.client.AsyncClient.select_graph 1/1',
      'miniclient.asyncio.client.AsyncGraph.query 1/1',
      'miniclient.asyncio.client.AsyncGraph 0/1',
    ]);
    expect(r.data.deductions.map((d) => d.points)).toEqual([9]);
    expect(r.data).toMatchObject({ score: 91, grade: 'A' });
    expect(r.summary).toBe(
      'Docs health 91/100 (A) for 4 repositories. No example that calls the code is known not to fit it (8 checked); 5 lines from beta checks are listed apart, not counted. 10 of 14 public symbols (71.4%) are named or called by a doc.',
    );
    expect(r.queries.map((q) => q.name)).toEqual(['auditRepos', 'auditExamples', 'auditMismatches', 'auditRuns', 'auditSymbols', 'auditFindings']);
    // The fixtures are plain folders, not git checkouts or tarball listings: their docs references were not linted.
    expect(r.data.findings).toEqual([]);
    expect(r.data.repos.every((x) => x.findingsChecked === false)).toBe(true);
  });

  it('scopes to repositories: their docs, and examples elsewhere that call their code', async () => {
    const r = await auditTool.run(ctx, { repos: ['acme/mini-sdk'] });
    expect(r.data.repos.map((x) => x.name)).toEqual(['acme/mini-sdk']);
    // quickstart.py in mini-sdk, rag.mdx (mini-docs) and stale.md:2 (stale-docs) call minisdk.
    expect(r.data.examples).toMatchObject({ total: 3, mismatched: 0 });
    expect(r.data.mismatches.map((m) => `${m.detail} ${m.lowerConfidence === true}`)).toEqual(['`Rag.ask` has no parameter `top_k` true']);
    await expect(auditTool.run(ctx, { repos: ['acme/nope'] })).rejects.toThrow('not indexed in the');
  });

  it('says when a repository was indexed by an older Staleproof', async () => {
    expect((await auditDocs(ctx, { repos: ['acme/mini-sdk'] })).data.outdatedIndex).toBe(false);
    await graph.run(`MATCH (r:Repo {name: 'acme/mini-sdk'}) REMOVE r.index_version`);
    try {
      const r = await auditDocs(ctx, { repos: ['acme/mini-sdk'] });
      expect(r.data.outdatedIndex).toBe(true);
      expect(r.summary).toContain('Indexed by an older Staleproof');
    } finally {
      await graph.run(`MATCH (r:Repo {name: 'acme/mini-sdk'}) SET r.index_version = $v`, { v: INDEX_VERSION });
    }
  });

  it('renders text and markdown with the badge for a single repository', async () => {
    const r = await auditDocs(ctx, { repos: ['acme/mini-client'] });
    const md = auditMarkdown(r.data, r.summary);
    expect(md.startsWith('<!-- staleproof-audit -->\n### Staleproof docs audit: ')).toBe(true);
    expect(md).toContain('| [docs/stale.md:1 line 20](https://github.com/acme/stale-docs/blob/fixture/docs/stale.md#L20) | Upgrading guide > Query | `g.read_only` | `Graph` has no attribute `read_only` |');
    expect(md).toContain('[![docs health](https://staleproof.dev/api/badge/acme/mini-client.svg)](https://staleproof.dev/#/audit?repo=acme%2Fmini-client)');
    expect(md).toMatch(/<!-- staleproof:audit score=89 mismatched=0 failing=0 coverage=63\.6 -->$/);
    // The beta checks' lines are listed under their own title, after the counted ones (none here).
    expect(md.indexOf('**Lower confidence (beta rules)**')).toBeGreaterThan(0);
    expect(md.indexOf('**Lower confidence (beta rules)**')).toBeLessThan(md.indexOf('`Graph` has no attribute `read_only`'));
    expect(md).toContain('False positive? [Report it](https://github.com/rajkaria/staleproof/issues/new?template=false-positive.yml)');
    expect(auditText(r.data, r.summary)).toContain('`Client` has no parameter `hostname`');
  });
});

describe('docs audit: a repository opts a beta rule in (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;
  let dir: string;

  beforeAll(async () => {
    // The stale docs with `[rules] "example-unknown-keyword" = "warning"`: that rule is trusted there, the other beta kinds are not.
    dir = await mkdtemp(join(tmpdir(), 'staleproof-audit-optin-'));
    await cp(STALE_DOCS.dir, dir, { recursive: true });
    await writeFile(join(dir, '.staleproof.toml'), '[rules]\n"example-unknown-keyword" = "warning"\n"example-missing-import" = "info"\n');
    ({ graph, done } = await testGraph('audit-optin'));
    await indexOrg(graph, [...FIXTURE_REPOS, { ...STALE_DOCS, dir }]);
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => {
    await done();
    await rm(dir, { recursive: true, force: true });
  });

  it('counts and scores a beta rule opted in at warning or error like a stable one; info is no opt-in for the score', async () => {
    const r = await auditDocs(ctx);
    expect(r.data.mismatches.map((m) => `${m.example.split(':').slice(1).join(':')} L${m.line} ${m.kind} ${m.lowerConfidence ? 'beta' : 'counted'}`)).toEqual([
      'docs/stale.md:0 L8 missing-import beta',
      'docs/stale.md:0 L10 unknown-keyword counted',
      'docs/stale.md:1 L19 too-many-arguments beta',
      'docs/stale.md:1 L20 missing-attribute beta',
      'docs/stale.md:2 L31 unknown-keyword counted',
    ]);
    // stale.md:0 and :2 have an opted-in line; stale.md:1 has beta lines only.
    expect(r.data.examples).toMatchObject({ linked: 8, mismatched: 2 });
    expect(r.data.deductions[0]).toEqual({ points: 16, why: '2 examples call the code in a way it no longer accepts (8 each, at most 50)' });
    expect(r.data).toMatchObject({ score: 75, grade: 'C' });
    // The repository's settings decide for its own docs' examples, in a scoped audit too.
    expect((await auditDocs(ctx, { repos: ['acme/mini-sdk'] })).data.examples).toMatchObject({ mismatched: 1 });
    // The stored settings never reach the report.
    expect(JSON.stringify(r.data)).not.toContain('ruleSettings');
  });
});

describe('publicApi and scoreAudit', () => {
  const row = (qualname: string, kind = 'function', path = 'pkg/mod.py') => ({
    id: `r:${qualname}`, qualname, name: qualname.split('.').pop()!, kind, repo: 'r', path, lineno: 1, signature: '', docs: 0, callers: 0, callerRepos: [],
    visibility: qualname.split('.').pop()!.startsWith('_') ? 'private' : 'public',
  });

  it('keeps Python-public names only', () => {
    const api = publicApi([
      row('pkg.mod.run'),
      row('pkg.mod._helper'),
      row('pkg._internal.run'),
      row('pkg.mod.run.inner'),
      row('pkg.mod.Graph', 'class'),
      row('pkg.mod.Graph.query', 'method'),
      row('pkg.mod.Graph._send', 'method'),
      row('tests.test_mod.test_run', 'function', 'tests/test_mod.py'),
    ]);
    expect(api.map((a) => a.qualname)).toEqual(['pkg.mod.run', 'pkg.mod.Graph', 'pkg.mod.Graph.query']);
  });

  it('lists beta findings apart and never deducts for them, from new and old graphs', () => {
    const row = (rule: string, severity: string, lowerConfidence?: boolean | null) => ({ rule, severity, message: 'm', repo: 'a/b', path: 'README.md', line: 1, column: 1, endLine: 1, endColumn: 2, surface: 'readme', subject: 's', evidence: null, fix: null, heading: null, fingerprint: rule, lowerConfidence });
    // anchor-missing is a beta rule (src/lint/maturity.ts); its trusted severity is warning.
    const { findings, counts } = auditFindingsOf([row('anchor-missing', 'warning', null), row('anchor-missing', 'warning', false), row('link-broken', 'error', null)] as never);
    expect(findings.filter((f) => f.lowerConfidence).map((f) => f.rule)).toEqual(['anchor-missing']); // the old graph's row
    expect(counts).toMatchObject({ errors: 1, warnings: 1, infos: 1, lowerConfidence: 1 }); // the opted-in anchor-missing (stored false) still counts
    expect(scoreAudit({ examples: { total: 0, python: 0, linked: 0, mismatched: 0 }, coverage: { api: 0, documented: 0, percent: 0 }, runCounts: { pass: 0, fail: 0, skipped: 0, error: 0 }, findingCounts: counts }).deductions.find((d) => /Docs references/.test(d.why))?.points).toBe(4);
  });

  it('scores 100 for fitting examples and full coverage, with capped deductions', () => {
    expect(scoreAudit({ examples: { total: 1, python: 1, linked: 1, mismatched: 0 }, coverage: { api: 4, documented: 4, percent: 100 }, runCounts: { pass: 1, fail: 0, skipped: 0, error: 0 } })).toEqual({
      score: 100,
      grade: 'A',
      deductions: [],
    });
    const bad = scoreAudit({ examples: { total: 20, python: 20, linked: 20, mismatched: 10 }, coverage: { api: 10, documented: 0, percent: 0 }, runCounts: { pass: 0, fail: 9, skipped: 0, error: 0 } });
    expect(bad.deductions.map((d) => d.points)).toEqual([50, 30, 30]);
    expect(bad).toMatchObject({ score: 0, grade: 'F' });
  });
});
