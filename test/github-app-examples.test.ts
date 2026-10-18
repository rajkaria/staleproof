import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { GitHubAppEnv } from '../src/app/env.js';
import {
  decideExamples,
  EXAMPLES_CHECK_NAME,
  examplesConclusion,
  examplesNote,
  examplesSetup,
  examplesTitle,
  runsTable,
  type AppExamplesOptions,
} from '../src/app/examples.js';
import { withNote } from '../src/app/pr-check.js';
import { registerGitHubAppRoutes } from '../src/app/routes.js';
import type { HandleResult } from '../src/app/service.js';
import { readRunExamples } from '../src/app/settings.js';
import { signBody } from '../src/app/webhook.js';
import type { Config } from '../src/config.js';
import type { ExampleRunRow } from '../src/format/report.js';
import { COMMENT_MARKER } from '../src/format/markdown.js';
import { GraphStore } from '../src/graph/client.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import { FakeGitHub, ghPull, testKeys } from './fixtures/github-app/fake-github.js';
import { FakeSandbox, traceback, type ProgramRun } from './fixtures/sandbox/fake-sandbox.js';
import { testConfig } from './helpers.js';

/**
 * The App runs the affected docs examples before and after a pull request (0.8.0), end to end
 * with the real check on a private repository, a fake GitHub and a fake Vercel Sandbox: the
 * "Staleproof" check run completes first, then "Staleproof · examples" reports the same
 * before/after table as the Action's report. Without a sandbox, with `[app] run-examples = false`,
 * or when the sandbox fails or runs out of time, the App does what it did before and says the
 * examples run in the Action; nothing fails because of a sandbox.
 */

const U = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `b3corp${U}`;
const REPO = `${OWNER}/greeter`;
const REPO_OFF = `${OWNER}/greeter-off`;
const REPO_TWO = `${OWNER}/greeter-two`;
const REPO_OPT = `${OWNER}/greeter-opt`;
const APP_ID = '4545';
const INST = 700_000_000 + Math.floor(Math.random() * 1e8);
const REGISTRY = `test-b3-app-${U}`;
const HOSTED_REGISTRY = `test-b3-hosted-${U}`;
const CURATED = `test-b3-curated-${U}`;
const keys = testKeys();
const ENV: GitHubAppEnv = { appId: APP_ID, privateKey: keys.privateKey, webhookSecret: 'whsec-examples', slug: 'staleproof-test' };

let store: GraphStore;
let config: Config;
let home: string;
let root: string;
const graphsToDrop = new Set<string>([REGISTRY, HOSTED_REGISTRY, CURATED, `ghp-${INST}`, `gh-${OWNER}`]);

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const USAGE = '# Usage\n\n## Greeting\n\nSay hello:\n\n```python\nfrom greeter import greet\n\nprint(greet("Ada"))\n```\n';

/** A Python package whose docs call `greet(name)`, and a pull request that adds a required parameter. */
async function makeRepo(name: string, extra: Record<string, string> = {}): Promise<{ dir: string; base: string; head: string }> {
  const dir = join(root, name);
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'greeter'), { recursive: true });
  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "greeter"\nversion = "0.1.0"\n');
  await writeFile(join(dir, 'greeter', '__init__.py'), 'def greet(name):\n    """Say hello."""\n    return f"Hello, {name}"\n');
  await writeFile(join(dir, 'docs', 'usage.md'), USAGE);
  await writeFile(join(dir, 'README.md'), '# Greeter\n\nSee [usage](docs/usage.md).\n');
  for (const [f, text] of Object.entries(extra)) await writeFile(join(dir, f), text);
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  const base = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', '-b', 'feature');
  await writeFile(join(dir, 'greeter', '__init__.py'), 'def greet(name, punctuation):\n    """Say hello."""\n    return f"Hello, {name}{punctuation}"\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'greet takes the punctuation');
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', 'main');
  return { dir, base, head };
}

let repo: { dir: string; base: string; head: string };
let repoOff: { dir: string; base: string; head: string };
let repoTwo: { dir: string; base: string; head: string };
let repoOpt: { dir: string; base: string; head: string };

beforeAll(async () => {
  store = await GraphStore.connect(inject('falkordbUrl'));
  home = await mkdtemp(join(tmpdir(), 'staleproof-b3-home-'));
  root = await mkdtemp(join(tmpdir(), 'staleproof-b3-repos-'));
  config = testConfig({ home });
  repo = await makeRepo('greeter');
  repoOff = await makeRepo('greeter-off', { '.staleproof.toml': '[app]\nrun-examples = false\n' });
  repoTwo = await makeRepo('greeter-two', { 'CHANGES.md': '# Changes\n' });
  // Opts the beta example check in: its predicted breaks count again.
  repoOpt = await makeRepo('greeter-opt', { '.staleproof.toml': '[rules]\n"example-missing-argument" = "warning"\n' });
});

afterAll(async () => {
  for (const g of graphsToDrop) await store.org(g).drop();
  await store.close();
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

/** Passes before the pull request, fails after it (the call no longer fits the signature). */
const breaksAtHead = (run: ProgramRun) =>
  run.installed.some((i) => i.endsWith(`@${repo.head}`))
    ? { exitCode: 1, stderr: traceback("TypeError: greet() missing 1 required positional argument: 'punctuation'") }
    : { exitCode: 0, stdout: 'Hello, Ada\n' };

function harness(examples: AppExamplesOptions) {
  const gh = new FakeGitHub(APP_ID, keys.publicKey, 'staleproof-test');
  gh.gitRepos.set(REPO.toLowerCase(), { dir: repo.dir, private: true, installation: INST });
  gh.gitRepos.set(REPO_OFF.toLowerCase(), { dir: repoOff.dir, private: true, installation: INST });
  gh.gitRepos.set(REPO_TWO.toLowerCase(), { dir: repoTwo.dir, private: true, installation: INST });
  gh.gitRepos.set(REPO_OPT.toLowerCase(), { dir: repoOpt.dir, private: true, installation: INST });
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const workspaces = new Workspaces(store, config, store.org(CURATED), { registry: HOSTED_REGISTRY, fetchImpl: gh.fetch });
  const app = new Hono();
  registerGitHubAppRoutes(app, { store, config, workspaces, env: ENV, registry: REGISTRY, fetchImpl: gh.fetch, waitUntil: (p) => pending.push(p), log: (m) => logs.push(m), examples });
  const open = async (name: string, number: number, r: { base: string; head: string }): Promise<HandleResult> => {
    const pull = { ...ghPull({ repo: name, number, base: r.base, head: r.head }), base: { sha: r.base, ref: 'main', repo: { full_name: name, private: true, default_branch: 'main' } } };
    pull.head.repo = { full_name: name, private: true, default_branch: 'main' };
    gh.pulls.set(`${name.toLowerCase()}#${number}`, pull);
    const payload = { action: 'opened', number, pull_request: pull, repository: { full_name: name, private: true, default_branch: 'main' }, installation: { id: INST } };
    const body = JSON.stringify(payload);
    // Earlier background work (an examples phase) is awaited through its own promise.
    pending.splice(0);
    const res = await app.request('/api/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signBody(ENV.webhookSecret, body) },
      body,
    });
    expect(res.status).toBe(202);
    return (await pending.shift()) as HandleResult;
  };
  const runs = (name: string) => [...gh.checkRuns.values()].filter((r) => r.repo.toLowerCase() === name.toLowerCase());
  // The latest of each (a re-run creates new ones).
  const mainRun = (name: string) => runs(name).filter((r) => r.created.name === 'Staleproof').at(-1)!;
  const examplesRun = (name: string) => runs(name).filter((r) => r.created.name === EXAMPLES_CHECK_NAME).at(-1);
  return { gh, logs, pending, open, mainRun, examplesRun };
}

const runCount = async () => (await store.org(`ghp-${INST}`).run<{ n: number }>('MATCH (r:Run) RETURN count(r) AS n')).rows[0]?.n ?? 0;

describe('the App runs the affected examples', () => {
  it('without a sandbox on the server, behaves as before and says the examples run in the Action', async () => {
    const box = new FakeSandbox(breaksAtHead);
    const h = harness({ enabled: false, client: box });
    const result = await h.open(REPO, 1, repo);
    const check = result.checks![0]!;
    expect(h.logs.join('\n')).not.toMatch(/check failed/);
    expect(check.examples).toBe('not-run');
    expect(check.examplesDone).toBeUndefined();
    const final = h.mainRun(REPO).updates.at(-1)!;
    expect(final.status).toBe('completed');
    // The graph check found the example (the call no longer fits the signature), but static example checks are beta
    // (src/lint/maturity.ts): listed, never counted, so the title has nothing to report.
    expect(final.output.title).toBe('No docs problems found (1 doc section reached)');
    expect(final.output.summary).toContain('Predicted to break');
    expect(final.output.summary).toContain('The docs example this pull request reaches was not run: the App on this server does not run examples, and the [GitHub Action](https://staleproof.dev/#/docs/github-action) runs examples before and after a pull request.');
    // No examples check run, no sandbox, nothing recorded, and no comment: a beta prediction is nothing to say
    // under `comment = "findings"` (the check run's summary carries it).
    expect(h.examplesRun(REPO)).toBeUndefined();
    expect(box.created).toBe(0);
    expect(h.pending).toHaveLength(0);
    expect(await runCount()).toBe(0);
    expect(h.gh.comments.get(`${REPO.toLowerCase()}#1`)?.[0]).toBeUndefined();
    expect(final.output.summary.startsWith(COMMENT_MARKER)).toBe(true);
    expect(h.logs.join('\n')).toMatch(/examples not run: the server switch STALEPROOF_APP_RUN_EXAMPLES is off/);
  });

  it('a repository that opts the beta example check in at warning: its predicted break counts, as in the audit', async () => {
    const box = new FakeSandbox(breaksAtHead);
    const h = harness({ enabled: false, client: box });
    const result = await h.open(REPO_OPT, 1, repoOpt);
    expect(result.checks![0]!.examples).toBe('not-run');
    const final = h.mainRun(REPO_OPT).updates.at(-1)!;
    expect(final.output.title).toMatch(/1 example predicted to break/);
    expect(final.conclusion).toBe('neutral');
    // Something to say: the comment is posted.
    expect(h.gh.comments.get(`${REPO_OPT.toLowerCase()}#1`)?.[0]?.body.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('with [app] run-examples = false, leaves the examples to the Action', async () => {
    const box = new FakeSandbox(breaksAtHead);
    const h = harness({ enabled: true, client: box });
    const result = await h.open(REPO_OFF, 1, repoOff);
    expect(result.checks![0]!.examples).toBe('not-run');
    expect(h.mainRun(REPO_OFF).updates.at(-1)!.output.summary).toContain('is not run by the App for this repository (`[app] run-examples = false`)');
    expect(h.examplesRun(REPO_OFF)).toBeUndefined();
    expect(box.created).toBe(0);
  });

  it('when the sandbox cannot start, completes the examples check as neutral and records nothing', async () => {
    const box = new FakeSandbox(breaksAtHead);
    box.failCreate = 'Sandbox creation is paused until the next billing cycle';
    const h = harness({ enabled: true, client: box });
    const result = await h.open(REPO, 2, repo);
    const check = result.checks![0]!;
    expect(check.examples).toBe('running');
    const summary = await check.examplesDone!;
    expect(summary.error).toMatch(/creating the sandbox: Sandbox creation is paused/);
    const ex = h.examplesRun(REPO)!;
    const final = ex.updates.at(-1)!;
    expect(final).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect(final.output.title).toBe('Examples not run: the sandbox could not run them');
    expect(final.output.summary).toContain('Staleproof could not run the examples in a sandbox: creating the sandbox: Sandbox creation is paused until the next billing cycle. Nothing about the docs follows from that');
    expect(final.output.summary).toContain('https://staleproof.dev/#/docs/github-action');
    // The graph check is unchanged and says where the results come; a beta prediction alone never makes it neutral.
    const main = h.mainRun(REPO).updates.at(-1)!;
    expect(main.conclusion).toBe('success');
    expect(main.output.summary).toContain(`runs before and after it in a sandbox: the results come in the **${EXAMPLES_CHECK_NAME}** check.`);
    expect(await runCount()).toBe(0);
  });

  it('when the time runs out, stops the sandbox and completes the examples check as neutral', async () => {
    const box = new FakeSandbox(
      (run) =>
        new Promise((_, reject) => {
          run.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        }),
    );
    const h = harness({ enabled: true, client: box, budgetMs: 300, minMs: 0 });
    const result = await h.open(REPO, 3, repo);
    const summary = await result.checks![0]!.examplesDone!;
    expect(summary.error).toMatch(/the examples took longer than the 0 s left for them/);
    const final = h.examplesRun(REPO)!.updates.at(-1)!;
    expect(final).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect(final.output.summary).toContain('Staleproof could not run the examples in a sandbox: the examples took longer');
    expect(box.created).toBe(1);
    expect(box.destroyed).toBe(1);
    expect(await runCount()).toBe(0);
  });

  it('runs the example before and after: passes before, fails after, reported as breaks with the Action’s table', async () => {
    const box = new FakeSandbox(breaksAtHead);
    const h = harness({ enabled: true, client: box });
    const result = await h.open(REPO, 4, repo);
    const check = result.checks![0]!;
    // The graph check is complete before the examples run.
    const main = h.mainRun(REPO);
    expect(main.updates.at(-1)!.status).toBe('completed');
    expect(check.examples).toBe('running');
    const summary = await check.examplesDone!;
    expect(summary.error).toBeUndefined();
    expect(summary.results.map((r) => r.verdict)).toEqual(['breaks']);

    const ex = h.examplesRun(REPO)!;
    expect(ex.created).toMatchObject({ name: EXAMPLES_CHECK_NAME, head_sha: repo.head, status: 'in_progress', external_id: '4' });
    const final = ex.updates.at(-1)!;
    expect(final).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect(final.output.title).toBe('1 docs example before and after: 1 breaks');
    expect(final.output.summary).toContain(`| Example | Before (\`${repo.base.slice(0, 7)}\`) | After (\`${repo.head.slice(0, 7)}\`) | Result |`);
    expect(final.output.summary).toContain("| passes | `TypeError: greet() missing 1 required positional argument: 'punctuation'` | **breaks**: passes before this PR, fails after |");

    // The comment is the whole report, now with the table, and says the pull request breaks the example. The graph
    // check alone had nothing to say (its prediction is a beta check's), so the break creates the comment.
    const comment = h.gh.comments.get(`${REPO.toLowerCase()}#4`)?.at(-1);
    expect(summary.comment).toBe('created');
    expect(comment?.body).toContain('### Staleproof: this pull request breaks 1 docs example');
    expect(comment?.body).toContain('**breaks**: passes before this PR, fails after');
    expect(comment?.body).toContain('<!-- staleproof:app -->');

    // Recorded in the installation's graph, at both commits; one sandbox, destroyed.
    expect(await runCount()).toBe(2);
    expect(box.created).toBe(1);
    expect(box.destroyed).toBe(1);
    expect(box.commands.filter((c) => c.cmd === 'env').every((c) => c.network === 'deny-all')).toBe(true);
    // The installation token read the private archives here and went nowhere else.
    for (const t of h.gh.tokens) {
      expect(box.everything()).not.toContain(t);
      expect(h.logs.join('\n')).not.toContain(t);
      expect(JSON.stringify(final)).not.toContain(t);
      expect(comment?.body).not.toContain(t);
    }
    const archives = h.gh.calls.filter((c) => /\/repos\/[^/]+\/[^/]+\/tarball\/[0-9a-f]{40}$/.test(c.path));
    expect(archives.length).toBeGreaterThanOrEqual(2);

    // A re-run of the same head answers the examples from the graph: no new sandbox.
    const again = await h.open(REPO, 4, repo);
    expect(h.mainRun(REPO).updates.at(-1)!.output.title).toMatch(/1 example broken \(passes before, fails after\)/);
    const second = await again.checks![0]!.examplesDone!;
    expect(second.results[0]!.runs.every((r) => r.cached)).toBe(true);
    expect(box.created).toBe(1);
  });
});

describe('a newer push', () => {
  it('stops the older head’s examples: their check is cancelled and their sandbox destroyed', async () => {
    let calls = 0;
    const box = new FakeSandbox(
      (run) =>
        new Promise((resolve, reject) => {
          if (++calls > 1) return resolve({ exitCode: 0 });
          run.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        }),
    );
    const h = harness({ enabled: true, client: box });
    const first = await h.open(REPO_TWO, 1, repoTwo);
    const firstDone = first.checks![0]!.examplesDone!;
    // Wait until the first example is running in the sandbox, then push again.
    for (let i = 0; i < 200 && calls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    const second = await h.open(REPO_TWO, 1, repoTwo);
    const stopped = await firstDone;
    expect(stopped).toMatchObject({ conclusion: 'cancelled', title: 'Stopped: a newer push is being checked' });
    expect(stopped.comment).toBeUndefined();
    expect(box.destroyed).toBeGreaterThanOrEqual(1);
    const next = await second.checks![0]!.examplesDone!;
    expect(next.conclusion).toBe('success');
    expect(box.created).toBe(box.destroyed);
  });
});

describe('the examples phase, piece by piece', () => {
  const row = (verdict: ExampleRunRow['verdict']): ExampleRunRow => ({ example: `a/b:docs/x.md:${verdict}`, url: 'u', verdict });

  it('decides whether to run, and what the check run says otherwise', async () => {
    const plan = { prUrl: 'p', candidates: ['a/b:docs/x.md:0', 'a/b:docs/x.md:1'], ctx: { graph: { run: async () => ({ rows: [{ lang: 'python' }] }) } }, render: async () => ({ report: '', runs: [] }) } as never;
    const budget = { withinDailyBudget: async () => true };
    const box = new FakeSandbox();
    const on = examplesSetup({ enabled: true, client: box, maxDurationMs: 300_000 }, {});
    expect(await decideExamples(on, { runExamples: true }, undefined, budget, Date.now())).toMatchObject({ run: false, why: 'none' });
    expect(await decideExamples(on, { runExamples: false }, plan, budget, Date.now())).toMatchObject({ run: false, why: 'setting' });
    expect(await decideExamples(examplesSetup({}, {}), { runExamples: true }, plan, budget, Date.now())).toMatchObject({ run: false, why: 'server' });
    // Switched on, but no credentials on this server.
    const noCreds = await decideExamples(examplesSetup({ enabled: true }, {}), { runExamples: true }, plan, budget, Date.now());
    expect(noCreds).toMatchObject({ run: false, why: 'server', reason: expect.stringMatching(/no Vercel Sandbox credentials/) });
    // The switch and the limits from the environment.
    const env = examplesSetup({}, { STALEPROOF_APP_RUN_EXAMPLES: 'on', STALEPROOF_APP_MAX_DURATION_S: '800', STALEPROOF_APP_EXAMPLE_CHECKS_PER_DAY: '5', VERCEL_OIDC_TOKEN: 'eyJ.a.b' });
    expect(env).toMatchObject({ enabled: true, perDay: 5, budgetMs: 600_000 });
    expect(env.invocationEnd(1000)).toBe(801_000);
    expect(env.client().client).toBeDefined();
    // Vercel says when the invocation ends; elsewhere there is no limit unless one is set.
    expect(examplesSetup({ deadline: () => new Date(5000) }, {}).invocationEnd(0)).toBe(5000);
    expect(examplesSetup({}, { VERCEL: '1' }).invocationEnd(0)).toBe(300_000);
    expect(examplesSetup({}, {}).invocationEnd(0)).toBe(Number.POSITIVE_INFINITY);
    // Too little of the invocation left, the daily budget used up.
    const started = Date.now() - 260_000;
    expect(await decideExamples(on, { runExamples: true }, plan, budget, started)).toMatchObject({ run: false, why: 'time' });
    expect(await decideExamples(on, { runExamples: true }, plan, { withinDailyBudget: async () => false }, Date.now())).toMatchObject({ run: false, why: 'budget' });
    // JS/TS examples only: left to the Action.
    const jsPlan = { ...(plan as object), ctx: { graph: { run: async () => ({ rows: [{ lang: 'ts' }] }) } } } as never;
    expect(await decideExamples(on, { runExamples: true }, jsPlan, budget, Date.now())).toMatchObject({ run: false, why: 'js' });
    const go = await decideExamples(on, { runExamples: true }, plan, budget, Date.now());
    expect(go).toMatchObject({ run: true, candidates: ['a/b:docs/x.md:0', 'a/b:docs/x.md:1'], note: examplesNote(2, 'run') });
    expect(go.run && go.budgetMs).toBeLessThanOrEqual(300_000 - 25_000);
  });

  it('writes the notes', () => {
    expect(examplesNote(1, 'run')).toBe(`The docs example this pull request reaches runs before and after it in a sandbox: the results come in the **${EXAMPLES_CHECK_NAME}** check.`);
    expect(examplesNote(3, 'server')).toMatch(/^The 3 docs examples this pull request reaches were not run: the App on this server does not run examples/);
    expect(examplesNote(2, 'setting')).toContain('are not run by the App for this repository');
  });

  it('puts a note above the report’s footer', () => {
    expect(withNote('# R\n\nbody\n<sub>footer</sub>\n<!-- counts -->', 'A note.')).toBe('# R\n\nbody\n\nA note.\n\n<sub>footer</sub>\n<!-- counts -->');
    expect(withNote('# R', undefined)).toBe('# R');
    expect(withNote('# R', 'N.')).toBe('# R\n\nN.');
  });

  it('takes the before/after table out of a report', () => {
    const report = ['### Staleproof: x', '', 'summary', '', '| Example | Before (`aaaaaaa`) | After (`bbbbbbb`) | Result |', '|---|---|---|---|', '| [x.md:0](u) | passes | `E` | **breaks** |', '', '| Change | Doc section |'].join('\n');
    expect(runsTable(report)).toBe(['| Example | Before (`aaaaaaa`) | After (`bbbbbbb`) | Result |', '|---|---|---|---|', '| [x.md:0](u) | passes | `E` | **breaks** |'].join('\n'));
    expect(runsTable('no table')).toBeUndefined();
  });

  it('titles and concludes: failure only when a break meets fail-on', () => {
    expect(examplesTitle([row('breaks'), row('passes'), row('passes')])).toBe('3 docs examples before and after: 1 breaks, 2 passes');
    expect(examplesTitle([row('skipped')])).toBe('1 docs example before and after: 1 not run');
    expect(examplesConclusion([row('breaks')], 'never')).toBe('neutral');
    expect(examplesConclusion([row('breaks')], 'predicted')).toBe('failure');
    expect(examplesConclusion([row('breaks')], 'breaks')).toBe('failure');
    expect(examplesConclusion([row('passes'), row('already-broken')], 'predicted')).toBe('success');
    expect(examplesConclusion([row('error'), row('skipped')], 'predicted')).toBe('neutral');
    expect(examplesConclusion([], 'never')).toBe('neutral');
  });

  it('reads [app] run-examples from .staleproof.toml and pyproject.toml', () => {
    expect(readRunExamples('[app]\nrun-examples = false\n', '.staleproof.toml')).toBe(false);
    expect(readRunExamples('[tool.staleproof.app]\nrun-examples = true\n', 'pyproject.toml')).toBe(true);
    expect(readRunExamples('[app]\ncomment = "always"\n', '.staleproof.toml')).toBeUndefined();
    const warnings: string[] = [];
    expect(readRunExamples('[app]\nrun-examples = "no"\n', '.staleproof.toml', warnings)).toBeUndefined();
    expect(warnings).toEqual(['.staleproof.toml: app.run-examples must be a boolean; ignored']);
  });
});
