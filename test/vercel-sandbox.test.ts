import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { checkMarkdown } from '../src/format/markdown.js';
import { runExample } from '../src/runner/index.js';
import { prepareExample } from '../src/runner/prepare.js';
import {
  downloadArchive,
  JS_NOT_HERE,
  pickProjectDir,
  redact,
  runKey,
  sandboxCredentials,
  SandboxUnavailableError,
  venvKey,
  VercelSandboxRunner,
} from '../src/runner/vercel-sandbox.js';
import { examplesToRun, runBeforeAfter, runsAtCommits } from '../src/sandbox/before-after.js';
import type { ImpactData } from '../src/tools/graph-tools.js';
import type { ToolContext } from '../src/tools/types.js';
import { FAKE_TARBALL, FakeSandbox, traceback } from './fixtures/sandbox/fake-sandbox.js';
import { testConfig, testGraph } from './helpers.js';

/**
 * The Vercel Sandbox runner against a fake sandbox, on a hand-made graph: the same run key,
 * records and verdicts as the local runner, installs with the network on and examples with it
 * off, the sandbox destroyed afterwards, and no token in the sandbox, a record or a log line.
 */

const REPO = 'acme/greeter';
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const HEAD2 = 'd'.repeat(40);
const PR = `https://github.com/${REPO}/pull/7`;
const PR2 = `https://github.com/${REPO}/pull/8`;
const CODE = 'from greeter import greet\n\nprint(greet("Ada"))\n';
const EX = `${REPO}:docs/usage.md:0`;
const JS_EX = `${REPO}:docs/usage.md:1`;
const SKIP_EX = `${REPO}:docs/usage.md:2`;
const TOKEN = 'ghs_privateInstallationToken0123456789';

let graph: OrgGraph;
let done: () => Promise<void>;
let ctx: ToolContext;

/** codeload has nothing for a private repository; the API serves its tarball to the token only. */
function githubFetch(calls: { url: string; auth?: string }[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    calls.push({ url, ...(auth ? { auth } : {}) });
    if (url.startsWith('https://codeload.github.com/')) return new Response('Not Found', { status: 404 });
    if (url.startsWith('https://api.github.com/') && auth === `Bearer ${TOKEN}`) return new Response(FAKE_TARBALL, { status: 200 });
    return new Response('{"message":"Bad credentials"}', { status: 401 });
  };
}

/** Passes until the head commit is installed, then fails the way a changed signature does. */
const breaksAtHead = (run: { installed: string[] }) =>
  run.installed.some((i) => i.endsWith(`@${HEAD}`) || i.endsWith(`@${HEAD2}`))
    ? { exitCode: 1, stderr: traceback("TypeError: greet() missing 1 required positional argument: 'punctuation'") }
    : { exitCode: 0, stdout: 'Hello, Ada\n' };

beforeAll(async () => {
  ({ graph, done } = await testGraph('vsandbox'));
  ctx = { graph, config: testConfig() };
  await graph.run(
    `CREATE (r:Repo {name: $repo, sha: $base, packages: ['greeter']})
     CREATE (s:Symbol {id: $sym, repo: $repo, name: 'greet'})
     CREATE (e:CodeExample {id: $ex, repo: $repo, path: 'docs/usage.md', index: 0, lang: 'python', code: $code, url: $url, status: 'live', directive: ''})
     CREATE (j:CodeExample {id: $js, repo: $repo, path: 'docs/usage.md', index: 1, lang: 'js', code: "import { greet } from 'greeter';\\nconsole.log(greet('Ada'));", url: $url, status: 'live', directive: ''})
     CREATE (k:CodeExample {id: $skip, repo: $repo, path: 'docs/usage.md', index: 2, lang: 'python', code: 'print(1)', url: $url, status: 'live', directive: 'skip'})
     CREATE (e)-[:USES]->(s), (j)-[:USES]->(s)
     CREATE (:PullRequest {url: $pr, repo: $repo, before_sha: $base, after_sha: $head, docs_touched: []})
     CREATE (:PullRequest {url: $pr2, repo: $repo, before_sha: $base, after_sha: $head2, docs_touched: []})`,
    { repo: REPO, base: BASE, head: HEAD, head2: HEAD2, sym: `${REPO}:greeter.greet`, ex: EX, js: JS_EX, skip: SKIP_EX, code: CODE, url: `https://github.com/${REPO}/blob/main/docs/usage.md`, pr: PR, pr2: PR2 },
  );
});

afterAll(async () => {
  await done();
});

describe('the Vercel Sandbox runner', () => {
  it('runs an example before and after: passes before, fails after, so the pull request breaks it', async () => {
    const box = new FakeSandbox(breaksAtHead);
    const logs: string[] = [];
    const calls: { url: string; auth?: string }[] = [];
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch(calls), log: (m) => logs.push(m) });
    const r = await runBeforeAfter({ ...ctx, log: (m) => logs.push(m) }, PR, EX, runner.runExample);
    await runner.close();

    expect(r.verdict).toBe('breaks');
    expect(r.runs.map((x) => [x.side, x.status])).toEqual([
      ['before', 'pass'],
      ['after', 'fail'],
    ]);
    expect(r.runs[1]!.error).toBe("TypeError: greet() missing 1 required positional argument: 'punctuation'");
    expect(r.runs[1]!.installed).toEqual([`${REPO}@${HEAD}`]);
    // The same run key as the local runner, recorded on the Run node and linked to the pull request.
    const prepared = prepareExample({ id: EX, lang: 'python', code: CODE }, []);
    expect(r.runs[0]!.id).toBe(`run-${runKey(prepared.code, [`${REPO}@${BASE}`])}`);
    const stored = (await graph.run<{ id: string; status: string; side: string }>(`MATCH (r:Run)-[:AT]->(:PullRequest {url: $pr}) RETURN r.id AS id, r.status AS status, r.side AS side ORDER BY side DESC`, { pr: PR })).rows;
    expect(stored.map((s) => [s.side, s.status])).toEqual([
      ['before', 'pass'],
      ['after', 'fail'],
    ]);

    // One sandbox, destroyed; installs with the network on, examples with it off.
    expect(box.created).toBe(1);
    expect(box.destroyed).toBe(1);
    expect(box.createOptions[0]).toMatchObject({ vcpus: 2 });
    const installs = box.commands.filter((c) => c.cmd.endsWith('/uv') && c.args?.[0] === 'pip');
    const programs = box.commands.filter((c) => c.cmd === 'env');
    expect(installs).toHaveLength(2);
    expect(installs.every((c) => c.network === 'allow-all')).toBe(true);
    expect(programs).toHaveLength(2);
    expect(programs.every((c) => c.network === 'deny-all')).toBe(true);
    // The example runs as the local sandbox runs it: nothing inherited, the shim, the entry point, a timeout.
    expect(programs[0]!.args).toEqual(expect.arrayContaining(['-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'STALEPROOF_SCRATCH_PORT=6390', 'timeout', '30s', '-s', '_run_example.py']));
    expect(box.files.some((f) => f.path.endsWith('/_shim/sitecustomize.py') && String(f.content).includes('outbound network is disabled'))).toBe(true);
    expect(box.files.some((f) => f.path.endsWith('/example.py') && f.content === prepared.code)).toBe(true);
    // The private archive was read here with the token (codeload first, then the API); the sandbox never saw the token.
    expect(calls.filter((c) => c.url.startsWith('https://api.github.com/')).every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(box.everything()).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).toMatch(/running acme\/greeter:docs\/usage\.md:0 in the sandbox/);

    // The before/after table of the Action's report, from what was recorded.
    const runs = await runsAtCommits(ctx, PR);
    expect(runs).toEqual([expect.objectContaining({ example: EX, verdict: 'breaks' })]);
    const report = checkMarkdown({ impact: impactOf(PR, HEAD), summary: '', cleared: [], runs, org: 'test' });
    expect(report).toContain(`| Example | Before (\`${BASE.slice(0, 7)}\`) | After (\`${HEAD.slice(0, 7)}\`) | Result |`);
    expect(report).toContain("| [docs/usage.md:0](https://github.com/acme/greeter/blob/main/docs/usage.md) | passes | `TypeError: greet() missing 1 required positional argument: 'punctuation'` | **breaks**: passes before this PR, fails after |");
  });

  it('answers an identical run from the graph without a sandbox', async () => {
    const box = new FakeSandbox(breaksAtHead);
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch() });
    const r = await runBeforeAfter(ctx, PR, EX, runner.runExample);
    await runner.close();
    expect(r.verdict).toBe('breaks');
    expect(r.runs.every((x) => x.cached)).toBe(true);
    expect(box.created).toBe(0);
  });

  it('keeps the table to the pull request’s current commits after a new push', async () => {
    // Pull request 8 at HEAD2: its own runs only, never the ones recorded for another head.
    await graph.run(`MATCH (r:Run)-[:AT]->(:PullRequest {url: $pr}) MATCH (p:PullRequest {url: $pr2}) MERGE (r)-[:AT]->(p)`, { pr: PR, pr2: PR2 });
    const before = await runsAtCommits(ctx, PR2);
    // Only the before run (BASE) matches; the after run was at HEAD, not HEAD2.
    expect(before).toEqual([expect.objectContaining({ example: EX, before: expect.objectContaining({ status: 'pass' }) })]);
    expect(before[0]!.after).toBeUndefined();
  });

  it('records a timeout as the local runner does', async () => {
    const box = new FakeSandbox(() => ({ exitCode: 124, stdout: 'still going' }));
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch() });
    const r = await runner.runExample(graph, ctx.config, await example(EX), [{ repo: REPO, sha: BASE }], { shas: { [REPO]: HEAD2 }, side: 'after', fresh: true });
    await runner.close();
    expect(r).toMatchObject({ status: 'timeout', reason: 'no exit after 30s' });
    expect(box.destroyed).toBe(1);
  });

  it('records an install that fails as an error run, with the installer’s output', async () => {
    const box = new FakeSandbox();
    box.failInstall = `  × No solution found when resolving dependencies:\n  ╰─▶ Because greeter==0.1.0 depends on falkordb>=9 and you require greeter, we can conclude that your requirements are unsatisfiable.`;
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch() });
    const r = await runner.runExample(graph, ctx.config, await example(EX), [{ repo: REPO, sha: BASE }], { shas: { [REPO]: HEAD2 }, side: 'after', fresh: true });
    await runner.close();
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/^dependency conflict: greeter==0\.1\.0 requires falkordb>=9/);
    expect(box.destroyed).toBe(1);
  });

  it('throws SandboxUnavailableError and records nothing when there is no sandbox', async () => {
    const box = new FakeSandbox();
    box.failCreate = 'Sandbox creation is paused: the Hobby plan quota is used up';
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch() });
    const ex = await example(EX);
    const before = (await graph.run<{ n: number }>('MATCH (r:Run) RETURN count(r) AS n')).rows[0]!.n;
    await expect(runner.runExample(graph, ctx.config, ex, [{ repo: REPO, sha: 'e'.repeat(40) }], { side: 'before', fresh: true })).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(runner.runExample(graph, ctx.config, ex, [{ repo: REPO, sha: 'e'.repeat(40) }], { side: 'before', fresh: true })).rejects.toThrow(/creating the sandbox: Sandbox creation is paused/);
    await runner.close();
    expect((await graph.run<{ n: number }>('MATCH (r:Run) RETURN count(r) AS n')).rows[0]!.n).toBe(before);
    expect(box.destroyed).toBe(0);
  });

  it('stops when its signal aborts (the deadline), without recording', async () => {
    const ctl = new AbortController();
    const box = new FakeSandbox(async (run) => {
      ctl.abort(new Error('the examples took longer than the 60 s left for them'));
      throw new DOMException('aborted', 'AbortError');
    });
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch(), signal: ctl.signal });
    await expect(runner.runExample(graph, ctx.config, await example(EX), [{ repo: REPO, sha: 'f'.repeat(40) }], { side: 'before', fresh: true })).rejects.toThrow(
      /the examples took longer than the 60 s left for them/,
    );
    await runner.close();
    expect(box.destroyed).toBe(1);
    expect((await graph.run<{ n: number }>(`MATCH (r:Run) WHERE 'acme/greeter@${'f'.repeat(40)}' IN r.installed RETURN count(r) AS n`)).rows[0]!.n).toBe(0);
  });

  it('never lets a token reach a record or a log line, even when the program prints one', async () => {
    const box = new FakeSandbox(() => ({ exitCode: 1, stdout: `token=${TOKEN}\n`, stderr: traceback(`RuntimeError: leaked ${TOKEN} and ghp_${'x'.repeat(36)}`) }));
    const logs: string[] = [];
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch(), log: (m) => logs.push(m) });
    const r = await runner.runExample(graph, ctx.config, await example(EX), [{ repo: REPO, sha: '9'.repeat(40) }], { side: 'before', fresh: true, log: (m) => logs.push(m) });
    await runner.close();
    expect(r.status).toBe('fail');
    const recorded = (await graph.run<{ props: Record<string, unknown> }>('MATCH (r:Run {id: $id}) RETURN properties(r) AS props', { id: r.id })).rows[0]!.props;
    const all = JSON.stringify([r, recorded, logs]);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(`ghp_${'x'.repeat(36)}`);
    expect(r.error).toBe('RuntimeError: leaked *** and ***');
    expect(r.stdout).toBe('token=***\n');
    expect(box.everything()).not.toContain(TOKEN);
  });

  it('leaves JavaScript examples to the Action: skipped, not recorded, no sandbox', async () => {
    const box = new FakeSandbox();
    const runner = new VercelSandboxRunner({ client: box, token: TOKEN, fetchImpl: githubFetch() });
    const r = await runBeforeAfter(ctx, PR, JS_EX, runner.runExample);
    await runner.close();
    expect(r.verdict).toBe('skipped');
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.reason).toBe(JS_NOT_HERE);
    expect(box.created).toBe(0);
    expect((await graph.run<{ n: number }>('MATCH (r:Run)-[:OF]->(:CodeExample {id: $id}) RETURN count(r) AS n', { id: JS_EX })).rows[0]!.n).toBe(0);
  });

  it('selects the examples graph mode runs: predicted first, exact sections next, never one marked skip', async () => {
    const impact = { predicted: [{ example: EX, confidence: 'exact' }], sections: [{ confidence: 'exact', examples: [SKIP_EX, JS_EX, EX] }, { confidence: 'by-name', examples: ['other:x.md:0'] }] } as unknown as ImpactData;
    expect(await examplesToRun(graph, impact)).toEqual([EX, JS_EX]);
    expect(await examplesToRun(graph, impact, 1)).toEqual([EX]);
    expect(await examplesToRun(graph, { predicted: [], sections: [] })).toEqual([]);
  });
});

describe('the runner’s pieces', () => {
  it('uses the local runner’s run key', async () => {
    // A skipped example records without a sandbox: its id carries the key the local runner computed.
    const bash = { id: `${REPO}:docs/usage.md:9`, lang: 'bash', code: 'echo hi', repo: REPO, path: 'docs/usage.md', url: 'u', directive: null, usedRepos: [], earlier: [] };
    await graph.run(`CREATE (:CodeExample {id: $id, repo: $repo, path: 'docs/usage.md', index: 9, lang: 'bash', code: 'echo hi', status: 'live'})`, { id: bash.id, repo: REPO });
    const local = await runExample(graph, ctx.config, bash, [{ repo: REPO, sha: BASE }], { fresh: true });
    const prepared = prepareExample(bash, []);
    expect(local.id).toBe(`run-${runKey(prepared.code, [`${REPO}@${BASE}`], prepared.skip)}`);
    expect(venvKey([`${REPO}@${BASE}`])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('picks the Python project directory the way projectSubdir does', () => {
    expect(pickProjectDir(['./pyproject.toml', './docs/setup.py'])).toBe('.');
    expect(pickProjectDir(['./tests/pyproject.toml', './src/pkg/setup.py', './lib/pyproject.toml'])).toBe('lib');
    expect(pickProjectDir(['./examples/a/setup.py'])).toBe('.');
    expect(pickProjectDir([])).toBe('.');
  });

  it('redacts tokens', () => {
    expect(redact(`a ${TOKEN} b`, [TOKEN])).toBe('a *** b');
    expect(redact(`x ghs_${'A1'.repeat(15)} y github_pat_${'a_'.repeat(15)}`)).toBe('x *** y ***');
    expect(redact('nothing here', ['short'])).toBe('nothing here');
  });

  it('finds credentials: the OIDC token, or an access token with its team and project', () => {
    expect(sandboxCredentials({}).credentials).toBeUndefined();
    expect(sandboxCredentials({}).reason).toMatch(/no Vercel Sandbox credentials/);
    expect(sandboxCredentials({ VERCEL_OIDC_TOKEN: 'eyJ.x.y' }).credentials).toEqual({ kind: 'oidc' });
    expect(sandboxCredentials({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team_1', VERCEL_PROJECT_ID: 'prj_1' }).credentials).toEqual({ kind: 'token', token: 't', teamId: 'team_1', projectId: 'prj_1' });
    expect(sandboxCredentials({ VERCEL_TOKEN: 't' }).reason).toMatch(/must be set together/);
    // On Vercel the token comes with the request.
    const key = Symbol.for('@vercel/request-context');
    (globalThis as Record<symbol, unknown>)[key] = { get: () => ({ headers: { 'x-vercel-oidc-token': 'eyJ.from.request' } }) };
    try {
      expect(sandboxCredentials({}).credentials).toEqual({ kind: 'oidc' });
    } finally {
      delete (globalThis as Record<symbol, unknown>)[key];
    }
  });

  it('downloads an archive: codeload for a public repository, the API with the token otherwise, within the size limit', async () => {
    const calls: { url: string; auth?: string }[] = [];
    expect(await downloadArchive(REPO, BASE, { token: TOKEN, fetchImpl: githubFetch(calls) })).toEqual(FAKE_TARBALL);
    expect(calls.map((c) => c.url)).toEqual([`https://codeload.github.com/${REPO}/tar.gz/${BASE}`, `https://api.github.com/repos/${REPO}/tarball/${BASE}`]);
    await expect(downloadArchive(REPO, BASE, { fetchImpl: githubFetch() })).rejects.toThrow(`downloading ${REPO}@bbbbbbb failed: 404`);
    await expect(downloadArchive(REPO, BASE, { token: TOKEN, fetchImpl: githubFetch(), maxBytes: 4 })).rejects.toThrow(/over the 0 MB/);
  });
});

async function example(id: string) {
  const { loadExample } = await import('../src/runner/index.js');
  return (await loadExample(graph, id))!;
}

function impactOf(url: string, after: string): ImpactData {
  return {
    pr: { url, title: 't', repo: REPO, state: 'open', before: BASE, after, docsTouched: [] },
    changed: [],
    sections: [],
    totalSections: 0,
    offset: 0,
    truncated: false,
    counts: { breaking: 0, api: 0, behavior: 0 },
    predicted: [],
    mismatched: [],
  };
}
