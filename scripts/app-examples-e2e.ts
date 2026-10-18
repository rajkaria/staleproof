/**
 * End-to-end check of the GitHub App's example runs (0.8.0) against a real Vercel Sandbox.
 * The tests use a fake sandbox; this is what proves the real one behaves as the runner assumes.
 *
 *   # credentials: either the project's OIDC token (12 h) ...
 *   vercel link && vercel env pull .env.local
 *   npx tsx --env-file=.env.local scripts/app-examples-e2e.ts
 *   # ... or an access token
 *   VERCEL_TOKEN=... VERCEL_TEAM_ID=team_... VERCEL_PROJECT_ID=prj_... npx tsx scripts/app-examples-e2e.ts
 *
 *   --smoke              only step 1 (the sandbox's facts), no graph needed
 *   --pr <url>           the pull request for step 2 (default FalkorDB/falkordb-py#262)
 *   --example <id>       the example to run (default: the ones graph mode selects, else README.md:4)
 *   --expect <verdict>   fail unless the first example's verdict is this (default `fixes` for the default PR)
 *   --region <region>    sandbox region (default STALEPROOF_SANDBOX_REGION, else the project's)
 *
 * Step 1 creates a sandbox and checks what the runner relies on: the image's tools, network on
 * for installs, `deny-all` refusing egress and DNS while loopback still works, `timeout`'s exit
 * code, a large upload, and that the sandbox is gone after `destroy()`.
 * Step 2 indexes the pull request's repository into a scratch graph on a **local** FalkorDB
 * (FALKORDB_URL, default redis://localhost:6379; a remote one is refused), runs the examples
 * before and after in the sandbox with VercelSandboxRunner, prints the verdicts and the report's
 * before/after table, and drops the graph. GITHUB_TOKEN is used, if set, only to read archives here.
 * Nothing secret is printed.
 */
import { setting, loadConfig } from '../src/config.js';
import { checkMarkdown } from '../src/format/markdown.js';
import { GraphStore } from '../src/graph/client.js';
import { ensureIndexed } from '../src/indexer/ensure.js';
import { ingestPullRequest } from '../src/pr/ingest.js';
import { parsePrUrl } from '../src/pr/github.js';
import { sandboxCredentials, vercelSandboxClient, VercelSandboxRunner, type SandboxVm } from '../src/runner/vercel-sandbox.js';
import { examplesToRun, runBeforeAfter, runsAtCommits } from '../src/sandbox/before-after.js';
import { clearanceTool, impactTool } from '../src/tools/graph-tools.js';
import type { ToolContext } from '../src/tools/types.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DEFAULT_PR = 'https://github.com/FalkorDB/falkordb-py/pull/262';
const prUrl = opt('pr') ?? DEFAULT_PR;
const expected = opt('expect') ?? (prUrl === DEFAULT_PR ? 'fixes' : undefined);
const region = opt('region') ?? setting('SANDBOX_REGION');

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail = '') => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${check}${detail ? `: ${detail}` : ''}`);
};

async function run(vm: SandboxVm, script: string, timeoutMs = 120_000) {
  const r = await vm.runCommand({ cmd: 'bash', args: ['-c', script], timeoutMs });
  return { code: r.exitCode, out: (await r.stdout()).trim(), err: (await r.stderr()).trim() };
}

async function smoke(): Promise<void> {
  const { credentials, reason } = sandboxCredentials();
  if (!credentials) throw new Error(`no sandbox credentials: ${reason}`);
  console.log(`step 1: sandbox facts (credentials: ${credentials.kind}${region ? `, region ${region}` : ''})`);
  const client = vercelSandboxClient({ credentials, ...(region ? { region } : {}) });
  const t0 = Date.now();
  const vm = await client.create({ timeoutMs: 300_000, vcpus: 2 });
  record('Sandbox.create (persistent: false, allow-all)', true, `${Date.now() - t0} ms`);
  try {
    const os = await run(vm, 'uname -sm; . /etc/os-release && echo "$PRETTY_NAME"; python3 --version; node --version; id -un');
    record('image: OS, python3, node', os.code === 0, os.out.replace(/\n/g, ' | '));
    const tools = await run(vm, 'for t in bash tar gzip env timeout git uv curl sudo; do printf "%s=%s " "$t" "$(command -v $t || echo missing)"; done');
    record('image: tools the runner uses (bash tar env timeout; uv is installed when missing)', !/(bash|tar|env|timeout)=missing/.test(tools.out), tools.out);
    const online = await run(vm, `python3 -c "import urllib.request; print(urllib.request.urlopen('https://pypi.org/simple/', timeout=15).status)"`);
    record('allow-all: egress works (installs)', online.code === 0, online.out || online.err.split('\n').pop() || '');
    await vm.setNetwork('deny-all');
    const offline = await run(vm, `python3 -c "import urllib.request; urllib.request.urlopen('https://pypi.org/simple/', timeout=10)"`, 60_000);
    record('deny-all: egress refused', offline.code !== 0, offline.err.split('\n').pop() ?? '');
    const dns = await run(vm, 'getent hosts pypi.org', 30_000);
    record('deny-all: DNS refused', dns.code !== 0, dns.out || `exit ${dns.code}`);
    const loop = await run(vm, `python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); c=socket.create_connection(s.getsockname(), timeout=5); print('loopback ok')"`, 30_000);
    record('deny-all: loopback (the scratch FalkorDB) still works', loop.code === 0, loop.out || loop.err.split('\n').pop() || '');
    await vm.setNetwork('allow-all');
    const again = await run(vm, `python3 -c "import urllib.request; print(urllib.request.urlopen('https://pypi.org/simple/', timeout=15).status)"`);
    record('back to allow-all: egress works again', again.code === 0, again.out);
    const to = await run(vm, 'timeout -k 2 2s sleep 30; echo "exit=$?"', 60_000);
    record('`timeout` exits 124 when it stops a program', /exit=124/.test(to.out), to.out);
    const blob = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251);
    await vm.writeFiles([{ path: '/vercel/sandbox/.staleproof/e2e/blob.bin', content: blob }]);
    const size = await run(vm, 'wc -c < /vercel/sandbox/.staleproof/e2e/blob.bin');
    record('writeFiles: a 5 MB upload, parent folders created', size.out === String(blob.byteLength), `${size.out} bytes`);
    await run(vm, 'setsid nohup sleep 300 >/dev/null 2>&1 < /dev/null & echo started');
    const alive = await run(vm, 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = sleep ] && { echo alive; exit 0; }; done; echo gone');
    record('a daemon started by one command is still running in the next (the scratch FalkorDB)', alive.out === 'alive', alive.out);
    const killed = await vm.runCommand({ cmd: 'sleep', args: ['60'], timeoutMs: 3000 });
    record('runCommand timeoutMs kills the command', killed.exitCode !== 0, `exit ${killed.exitCode}`);
  } finally {
    await vm.destroy();
    record('destroy(): delete with its snapshots', true);
  }
}

async function examples(): Promise<void> {
  const { credentials, reason } = sandboxCredentials();
  if (!credentials) throw new Error(`no sandbox credentials: ${reason}`);
  const config = loadConfig();
  if (!/^\w+:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(config.falkordbUrl.replace(/\/\/[^@/]*@/, '//'))) {
    throw new Error('step 2 writes a scratch graph: point FALKORDB_URL at a local FalkorDB (npx staleproof db start), never the cloud one');
  }
  const pr = parsePrUrl(prUrl);
  console.log(`\nstep 2: ${pr.url} in a real sandbox (graph on ${config.falkordbUrl.replace(/\/\/[^@/]*@/, '//')})`);
  const store = await GraphStore.connect(config.falkordbUrl);
  const graph = store.org(`e2e-app-examples-${Date.now()}`);
  const runner = new VercelSandboxRunner({
    client: vercelSandboxClient({ credentials, ...(region ? { region } : {}) }),
    ...(config.githubToken ? { token: config.githubToken } : {}),
    timeoutMs: 900_000,
    log: (m) => console.log(`  ${m}`),
  });
  try {
    await ensureIndexed(graph, config, [pr.fullName], (p) => 'message' in p && console.log(`  ${p.message}`));
    await ingestPullRequest(graph, config, pr.url);
    const ctx: ToolContext = { graph, config, log: (m) => console.log(`  ${m}`) };
    const impact = await impactTool.run(ctx, { pr_url: pr.url });
    const picked = opt('example') ? [opt('example')!] : await examplesToRun(graph, impact.data, 3);
    const ids = picked.length ? picked : [`${pr.fullName}:README.md:4`];
    console.log(`  examples: ${ids.join(', ')}`);
    const started = Date.now();
    const verdicts: string[] = [];
    for (const id of ids) {
      const r = await runBeforeAfter(ctx, pr.url, id, runner.runExample);
      verdicts.push(r.verdict);
      record(`${id}: ${r.verdict}`, r.verdict !== 'error', r.runs.map((x) => `${x.side} ${x.status}${x.error ? ` (${x.error})` : x.reason ? ` (${x.reason.split('\n')[0]})` : ''}`).join('; '));
    }
    console.log(`  ${ids.length} example(s) in ${Math.round((Date.now() - started) / 1000)} s (this is what the webhook's maxDuration must cover, plus the graph check)`);
    if (expected) record(`first verdict is ${expected}`, verdicts[0] === expected, verdicts[0] ?? 'none');
    const clearance = await clearanceTool.run(ctx, { pr_url: pr.url });
    const report = checkMarkdown({ impact: impact.data, summary: impact.summary, cleared: clearance.data.cleared, runs: await runsAtCommits(ctx, pr.url), org: graph.name });
    const table = report.split('\n').filter((l) => l.startsWith('| Example | Before') || (l.startsWith('|') && /passes|fail|broken|not run|not installed|breaks|fixed/.test(l)));
    console.log(`\n${table.join('\n')}\n`);
  } finally {
    await runner.close();
    record('runner.close(): the sandbox is destroyed', !runner.started);
    await graph.drop().catch(() => undefined);
    await store.close();
  }
}

try {
  await smoke();
  if (!flag('smoke')) await examples();
} catch (err) {
  record('e2e', false, (err as Error).message);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.check).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
