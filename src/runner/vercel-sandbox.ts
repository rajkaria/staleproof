import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Config } from '../config.js';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { JS_LANGS } from '../indexer/docs.js';
import { packageRoot } from '../pkg.js';
import type { ExampleForRun, RunOptions, RunRecord, RunStatus, runExample } from './index.js';
import { prepareJsExample } from './js.js';
import { errorLine, extractTraceback, isFragmentFailure, prepareExample } from './prepare.js';
import { installFailure } from './sandbox.js';

/**
 * Docs examples run in a Vercel Sandbox (a Firecracker microVM) instead of on this host. It is
 * what lets the GitHub App, which runs in a Vercel Function with no git, uv or Python, run the
 * affected examples before and after a pull request the way the GitHub Action does.
 *
 * `VercelSandboxRunner.runExample` has the signature of `runExample` (src/runner/index.ts) and
 * keeps its contract: the same prepared program (`prepareExample`), the same run key (so a run
 * recorded by the Action or the CLI answers here and the other way round), the same statuses,
 * fragment rule, error lines and `Run` node. Only where the program runs differs:
 *
 * 1. One sandbox per check, created on the first run that needs one, destroyed by `close()`
 *    (and by its own timeout if this process dies first). `persistent: false`: nothing is kept.
 * 2. Each repository is read at its commit **here**, as an archive (the installation token for a
 *    private repository; GitHub only ever sees it), and uploaded into the sandbox. No token ever
 *    enters the sandbox, and every string recorded or logged is scrubbed of the tokens anyway.
 * 3. With network: uv, then one virtualenv per (Python 3.12, sorted repo@sha list), installed from
 *    source like `ensureVenv`, and the scratch FalkorDB (`scripts/falkordb-local.sh`, the same
 *    falkordblite pin) on 127.0.0.1:6390.
 * 4. Network off (`deny-all`, DNS included) while the example runs, through the same entry point
 *    and socket shim as the local sandbox (python/run_example.py, python/sitecustomize.py), with
 *    the same environment (`env -i`), and `timeout` for `STALEPROOF_RUN_TIMEOUT_MS`.
 *
 * JavaScript and TypeScript examples are not run here yet: they come back skipped and are not
 * recorded, so the Action or the CLI still runs them. Anything wrong with the sandbox itself (no
 * credentials, a quota, the deadline) throws `SandboxUnavailableError` and records nothing.
 */

/** The runner interface the CLI, the Action and the agent use (src/runner/index.ts). */
export type ExampleRunner = typeof runExample;

/** The subset of a Vercel Sandbox the runner uses (tests pass a fake). */
export interface SandboxVm {
  runCommand(c: SandboxCommand): Promise<SandboxCommandResult>;
  writeFiles(files: { path: string; content: string | Uint8Array }[], opts?: { signal?: AbortSignal }): Promise<void>;
  /** `allow-all` while installing, `deny-all` (no egress, no DNS) while an example runs. */
  setNetwork(policy: 'allow-all' | 'deny-all', opts?: { signal?: AbortSignal }): Promise<void>;
  /** Stop and delete the sandbox and its snapshots. */
  destroy(): Promise<void>;
}

export interface SandboxCommand {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Killed with SIGKILL after this long (enforced by the sandbox). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  durationMs?: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

export interface SandboxClient {
  create(opts: { timeoutMs: number; vcpus: number; signal?: AbortSignal }): Promise<SandboxVm>;
}

/** How this server authenticates to Vercel Sandbox. */
export type SandboxCredentials = { kind: 'token'; token: string; teamId: string; projectId: string } | { kind: 'oidc' };

/** The sandbox is not there or not usable: nothing about the docs, nothing is recorded. */
export class SandboxUnavailableError extends Error {}

/** A recorded `error` run (the repositories could not be read or installed), as the local runner records them. */
class PrepareError extends Error {}

const ROOT = '/vercel/sandbox/.staleproof';
const TOOLS = `${ROOT}/tools`;
const SCRATCH_PORT = 6390;
const PYTHON_VERSION = '3.12';
const MAX_OUTPUT = 64 * 1024;
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;

/** Why a JS/TS example is not run here (never recorded, so a host that can run it still will). */
export const JS_NOT_HERE = "the App's sandbox runs Python examples; JavaScript and TypeScript examples run in the GitHub Action and the CLI";

/**
 * The credentials this server has for Vercel Sandbox, or why it has none. On Vercel the
 * function's OIDC token (the `x-vercel-oidc-token` request header, or `VERCEL_OIDC_TOKEN`) is
 * enough and the SDK reads it itself; elsewhere an access token with its team and project.
 */
export function sandboxCredentials(env: NodeJS.ProcessEnv = process.env): { credentials?: SandboxCredentials; reason?: string } {
  const token = env.VERCEL_TOKEN?.trim();
  const teamId = env.VERCEL_TEAM_ID?.trim();
  const projectId = env.VERCEL_PROJECT_ID?.trim();
  if (token && teamId && projectId) return { credentials: { kind: 'token', token, teamId, projectId } };
  if (env.VERCEL_OIDC_TOKEN?.trim() || requestOidcToken()) return { credentials: { kind: 'oidc' } };
  if (token || teamId || projectId) return { reason: 'VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID must be set together' };
  return { reason: 'no Vercel Sandbox credentials (no OIDC token on this deployment, no VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID)' };
}

/** The OIDC token Vercel sends with the current request (read the way `@vercel/oidc` reads it). */
function requestOidcToken(): string | undefined {
  const ctx = (globalThis as Record<symbol, { get?: () => { headers?: Record<string, string> } } | undefined>)[Symbol.for('@vercel/request-context')];
  const header = ctx?.get?.()?.headers?.['x-vercel-oidc-token'];
  return typeof header === 'string' && header ? header : undefined;
}

/** A `SandboxClient` backed by `@vercel/sandbox` (loaded on first use, so the CLI never pays for it). */
export function vercelSandboxClient(opts: { credentials: SandboxCredentials; region?: string }): SandboxClient {
  return {
    async create(o) {
      const { Sandbox } = await import('@vercel/sandbox');
      const c = opts.credentials;
      const params = {
        timeout: o.timeoutMs,
        resources: { vcpus: o.vcpus },
        persistent: false,
        networkPolicy: 'allow-all' as const,
        ...(opts.region ? { region: opts.region } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(c.kind === 'token' ? { token: c.token, teamId: c.teamId, projectId: c.projectId } : {}),
      };
      const sandbox = await Sandbox.create(params);
      return {
        async runCommand(cmd) {
          const r = await sandbox.runCommand({
            cmd: cmd.cmd,
            args: cmd.args ?? [],
            ...(cmd.cwd ? { cwd: cmd.cwd } : {}),
            ...(cmd.env ? { env: cmd.env } : {}),
            ...(cmd.timeoutMs ? { timeoutMs: cmd.timeoutMs } : {}),
            ...(cmd.signal ? { signal: cmd.signal } : {}),
          });
          return { exitCode: r.exitCode, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}), stdout: () => r.stdout(), stderr: () => r.stderr() };
        },
        writeFiles: (files, wo) => sandbox.writeFiles(files, wo),
        setNetwork: (policy, so) => sandbox.update({ networkPolicy: policy }, so),
        async destroy() {
          try {
            await sandbox.delete({ deleteOrphanSnapshots: true });
          } catch {
            await sandbox.stop().catch(() => undefined);
          }
        },
      };
    },
  };
}

/** The run key of src/runner/index.ts: the prepared program, the sorted repo@sha list, the skip reason. */
export function runKey(code: string, installed: readonly string[], skip?: string): string {
  return createHash('sha1').update(JSON.stringify({ code, installed, skip: skip ?? '' })).digest('hex').slice(0, 20);
}

/** The virtualenv key of `ensureVenv` (src/runner/sandbox.ts). */
export function venvKey(spec: readonly string[]): string {
  return createHash('sha1').update(JSON.stringify([PYTHON_VERSION, ...spec])).digest('hex').slice(0, 16);
}

/** `projectSubdir`'s rule on a file list: the shallowest pyproject.toml/setup.py outside tests, docs, examples and benchmarks. */
export function pickProjectDir(files: readonly string[]): string {
  const candidates = files
    .map((f) => f.replace(/^\.\//, ''))
    .filter((f) => /(^|\/)(pyproject\.toml|setup\.py)$/.test(f))
    .filter((f) => !/(^|\/)(tests?|docs|examples?|benchmarks?)\//.test(f))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return candidates[0] ? posix.dirname(candidates[0]) : '.';
}

const TOKEN_SHAPES = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** Every given secret, and anything shaped like a GitHub token, replaced by `***`. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out.replace(TOKEN_SHAPES, '***');
}

/**
 * A repository at a commit as a gzipped tarball, read here (never in the sandbox): codeload for
 * a public repository, the API's tarball endpoint with the token when codeload does not have it.
 */
export async function downloadArchive(repo: string, sha: string, o: { token?: string; fetchImpl?: typeof fetch; maxBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const f = o.fetchImpl ?? fetch;
  const max = o.maxBytes ?? MAX_ARCHIVE_BYTES;
  const get = (url: string, token?: string) =>
    f(url, {
      headers: { 'User-Agent': 'staleproof', ...(token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : {}) },
      redirect: 'follow',
      ...(o.signal ? { signal: o.signal } : {}),
    });
  const label = `${repo}@${sha.slice(0, 7)}`;
  let res = await get(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(sha)}`);
  if (res.status === 404 && o.token) {
    await res.body?.cancel().catch(() => undefined);
    res = await get(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(sha)}`, o.token);
  }
  if (!res.ok || !res.body) throw new PrepareError(`downloading ${label} failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new PrepareError(`${label} is a ${Math.round(declared / 1048576)} MB archive, over the ${Math.round(max / 1048576)} MB limit`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new PrepareError(`${label} is over the ${Math.round(max / 1048576)} MB archive limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface VercelSandboxRunnerOptions {
  client: SandboxClient;
  /** Reads private repositories' archives (the installation token). Never sent to the sandbox, never recorded. */
  token?: string;
  fetchImpl?: typeof fetch;
  /** Aborts everything (the check's deadline, a newer push). */
  signal?: AbortSignal;
  /** The sandbox's lifetime: it is gone after this long whatever happens here (default 10 minutes). */
  timeoutMs?: number;
  vcpus?: number;
  maxArchiveBytes?: number;
  /** More strings no record or log line may contain. */
  secrets?: string[];
  log?: (msg: string) => void;
}

type Base = Omit<RunRecord, 'id' | 'status' | 'stdout' | 'durationMs'>;

/** Docs examples run in one Vercel Sandbox; `runExample` fits the runner interface, `close()` destroys the sandbox. */
export class VercelSandboxRunner {
  private vm?: Promise<{ vm: SandboxVm; uv: string; bin: string }>;
  private created?: SandboxVm;
  private network: 'allow-all' | 'deny-all' = 'allow-all';
  private readonly sources = new Map<string, Promise<string>>();
  private readonly venvs = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private runs = 0;
  private closed = false;
  /** Commands run in the sandbox (for the report's numbers and tests). */
  executed = 0;

  constructor(private readonly opts: VercelSandboxRunnerOptions) {}

  private get secrets(): string[] {
    return [...(this.opts.token ? [this.opts.token] : []), ...(this.opts.secrets ?? [])];
  }

  private scrub(s: string): string {
    return redact(s, this.secrets);
  }

  /** `s` without this runner's tokens (for callers that log what it threw). */
  scrubbed(s: string): string {
    return this.scrub(s);
  }

  private log(msg: string): void {
    this.opts.log?.(this.scrub(msg));
  }

  /** The runner interface of src/runner/index.ts. */
  readonly runExample: ExampleRunner = (graph, config, example, repos, opts = {}) => this.run(graph, config, example, repos, opts);

  /** Whether a sandbox was created (and so has to be destroyed). */
  get started(): boolean {
    return !!this.created;
  }

  /** Destroy the sandbox (safe to call twice; the runner refuses work afterwards). */
  async close(): Promise<void> {
    this.closed = true;
    await this.vm?.catch(() => undefined);
    const vm = this.created;
    this.created = undefined;
    if (vm) await vm.destroy().catch((err) => this.log(`could not destroy the sandbox: ${(err as Error).message}`));
  }

  private async run(graph: OrgGraph, config: Config, example: ExampleForRun, repos: { repo: string; sha: string }[], opts: RunOptions): Promise<RunRecord> {
    const js = JS_LANGS.has(example.lang);
    const prepared = js ? prepareJsExample(example, example.earlier) : prepareExample(example, example.earlier);
    const targets = repos.map((r) => ({ repo: r.repo, sha: opts.shas?.[r.repo] ?? r.sha }));
    const installed = targets.map((t) => `${t.repo}@${t.sha}`).sort();
    const key = runKey(prepared.code, installed, prepared.skip);
    const side = opts.side ?? 'current';

    if (!opts.fresh) {
      const prev = (await graph.run<{ props: Record<string, unknown> }>(Q.cachedRun, { key })).rows[0];
      if (prev && prev.props.status !== 'error') {
        const record = fromProps(prev.props, side);
        if (opts.prUrl) await graph.run(Q.linkRunToPr, { id: record.id, pr: opts.prUrl });
        return { ...record, cached: true };
      }
    }

    const base: Base = { example: example.id, stitched: prepared.stitched, installed, side, cached: false, createdAt: Date.now() };
    let record: RunRecord;
    if (prepared.skip) {
      record = { id: `run-${key}`, ...base, status: 'skipped', reason: prepared.skip, stdout: '', durationMs: 0 };
    } else if (js) {
      // Not recorded: the Action or the CLI can still run it.
      return { id: `run-${key}-unavailable`, ...base, status: 'skipped', reason: JS_NOT_HERE, stdout: '', durationMs: 0 };
    } else if (targets.length === 0) {
      record = { id: `run-${key}`, ...base, status: 'skipped', reason: 'uses no symbol from an indexed repository', stdout: '', durationMs: 0 };
    } else {
      record = await this.serial(() => this.execute(key, base, prepared.code, targets, config, example.id, opts.log));
    }
    await graph.run(Q.upsertRun, {
      id: record.id,
      example: example.id,
      props: {
        id: record.id,
        key,
        example: example.id,
        status: record.status,
        reason: record.reason ?? '',
        error: record.error ?? '',
        traceback: record.traceback ?? '',
        stdout: record.stdout,
        duration_ms: record.durationMs,
        stitched: record.stitched,
        installed: record.installed,
        side: record.side,
        created_at: record.createdAt,
      },
    });
    if (opts.prUrl) await graph.run(Q.linkRunToPr, { id: record.id, pr: opts.prUrl });
    return record;
  }

  /** One sequence of commands at a time: the scratch database and the network policy are shared. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async execute(key: string, base: Base, code: string, targets: { repo: string; sha: string }[], config: Config, exampleId: string, log?: (m: string) => void): Promise<RunRecord> {
    try {
      const box = await this.ensureVm();
      const python = await this.ensureVenv(box, targets, log);
      log?.(`running ${exampleId} in the sandbox against ${base.installed.join(', ')}`);
      const r = await this.runProgram(box, python, code, config.runTimeoutMs);
      const stdout = this.scrub(r.stdout);
      const stderr = this.scrub(r.stderr);
      const traceback = extractTraceback(stderr);
      const id = `run-${key}`;
      if (r.timedOut) return { id, ...base, status: 'timeout', reason: `no exit after ${config.runTimeoutMs / 1000}s`, stdout: tail(stdout), durationMs: r.durationMs };
      if (r.code === 0) return { id, ...base, status: 'pass', stdout: tail(stdout), durationMs: r.durationMs };
      if (isFragmentFailure(code, traceback)) {
        return { id, ...base, status: 'skipped', reason: `fragment: ${errorLine(traceback)} (the page never defines it)`, traceback, stdout: tail(stdout), durationMs: r.durationMs };
      }
      return { id, ...base, status: 'fail', error: errorLine(traceback) ?? stderr.trim().split('\n').pop(), traceback: traceback ?? tail(stderr), stdout: tail(stdout), durationMs: r.durationMs };
    } catch (err) {
      if (err instanceof SandboxUnavailableError) throw err;
      return { id: `run-${key}-err-${Date.now()}`, ...base, status: 'error', reason: this.scrub((err as Error).message).slice(0, 2000), stdout: '', durationMs: 0 };
    }
  }

  private alive(): void {
    if (this.closed) throw new SandboxUnavailableError('the sandbox was closed');
    if (this.opts.signal?.aborted) throw new SandboxUnavailableError(abortReason(this.opts.signal));
  }

  /** A call into the sandbox: anything it throws is the sandbox's problem, not the docs'. */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    this.alive();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SandboxUnavailableError) throw err;
      if (this.opts.signal?.aborted) throw new SandboxUnavailableError(abortReason(this.opts.signal));
      throw new SandboxUnavailableError(this.scrub(`${what}: ${(err as Error).message}`));
    }
  }

  private async command(box: SandboxVm, c: SandboxCommand): Promise<{ code: number | null; stdout: string; stderr: string; durationMs?: number }> {
    const r = await this.call(`running ${c.cmd} in the sandbox`, () => box.runCommand({ ...c, ...(this.opts.signal ? { signal: this.opts.signal } : {}) }));
    this.executed++;
    const [stdout, stderr] = await this.call('reading command output', () => Promise.all([r.stdout(), r.stderr()]));
    return { code: r.exitCode, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) };
  }

  private async setNetwork(box: SandboxVm, policy: 'allow-all' | 'deny-all'): Promise<void> {
    if (this.network === policy) return;
    await this.call(`switching the network to ${policy}`, () => box.setNetwork(policy, this.opts.signal ? { signal: this.opts.signal } : undefined));
    this.network = policy;
  }

  /** The sandbox, created once: uv and the scratch FalkorDB ready, network on. */
  private ensureVm(): Promise<{ vm: SandboxVm; uv: string; bin: string }> {
    this.vm ??= (async () => {
      this.alive();
      const files = await deployedFiles();
      const vm = await this.call('creating the sandbox', () => this.opts.client.create({ timeoutMs: this.opts.timeoutMs ?? 600_000, vcpus: this.opts.vcpus ?? 2, ...(this.opts.signal ? { signal: this.opts.signal } : {}) }));
      this.created = vm;
      if (this.closed) throw new SandboxUnavailableError('the sandbox was closed');
      this.log('sandbox created');
      await this.call('uploading the runner', () =>
        vm.writeFiles([
          { path: `${ROOT}/falkordb-local.sh`, content: files.falkordb },
          { path: `${ROOT}/python/run_example.py`, content: files.entry },
          { path: `${ROOT}/python/sitecustomize.py`, content: files.shim },
        ]),
      );
      const setup = [
        'set -eu',
        `mkdir -p ${ROOT}/src ${ROOT}/venvs ${ROOT}/runs`,
        `if ! command -v uv >/dev/null 2>&1; then python3 -m venv ${TOOLS} >&2 && ${TOOLS}/bin/pip install -q uv >&2; fi`,
        `export PATH="${TOOLS}/bin:$PATH"`,
        'echo "uv=$(command -v uv)"',
        `STALEPROOF_HOME=${ROOT} bash ${ROOT}/falkordb-local.sh start ${SCRATCH_PORT} >&2`,
        `echo "bin=$(STALEPROOF_HOME=${ROOT} bash ${ROOT}/falkordb-local.sh bin)"`,
      ].join('\n');
      const r = await this.command(vm, { cmd: 'bash', args: ['-c', setup], timeoutMs: 600_000 });
      const uv = /^uv=(\S+)$/m.exec(r.stdout)?.[1];
      const bin = /^bin=(\S+)$/m.exec(r.stdout)?.[1];
      if (r.code !== 0 || !uv || !bin) throw new SandboxUnavailableError(this.scrub(`preparing the sandbox (uv, the scratch FalkorDB) failed: ${r.stderr.trim().slice(-600) || `exit ${r.code}`}`));
      return { vm, uv, bin };
    })();
    return this.vm;
  }

  /** A repository's source at a commit, unpacked in the sandbox; returns its Python project directory. */
  private ensureSource(box: { vm: SandboxVm }, repo: string, sha: string): Promise<string> {
    const id = `${repo}@${sha}`;
    let p = this.sources.get(id);
    if (!p) {
      p = (async () => {
        const dir = `${ROOT}/src/${repo.replace('/', '__')}@${sha}`;
        this.alive();
        const archive = await downloadArchive(repo, sha, { token: this.opts.token, fetchImpl: this.opts.fetchImpl, maxBytes: this.opts.maxArchiveBytes, signal: this.opts.signal }).catch((err: Error) => {
          if (this.opts.signal?.aborted) throw new SandboxUnavailableError(abortReason(this.opts.signal));
          throw err instanceof PrepareError ? err : new PrepareError(`downloading ${repo}@${sha.slice(0, 7)} failed: ${err.message}`);
        });
        await this.call('uploading the source', () => box.vm.writeFiles([{ path: `${dir}.tar.gz`, content: archive }], this.opts.signal ? { signal: this.opts.signal } : undefined));
        const unpack = 'set -eu; mkdir -p "$1"; tar -xzf "$1.tar.gz" -C "$1" --strip-components=1; rm -f "$1.tar.gz"; cd "$1"; find . \\( -name pyproject.toml -o -name setup.py \\) -not -path "*/node_modules/*" -print';
        const r = await this.command(box.vm, { cmd: 'bash', args: ['-c', unpack, 'unpack', dir], timeoutMs: 300_000 });
        if (r.code !== 0) throw new PrepareError(`unpacking ${repo}@${sha.slice(0, 7)} failed: ${r.stderr.trim().slice(-600)}`);
        const sub = pickProjectDir(r.stdout.split('\n').filter(Boolean));
        return sub === '.' ? dir : `${dir}/${sub}`;
      })();
      this.sources.set(id, p);
      p.catch(() => this.sources.delete(id));
    }
    return p;
  }

  /** `ensureVenv` in the sandbox: one virtualenv per (Python 3.12, sorted repo@sha list), every repository installed from source. */
  private ensureVenv(box: { vm: SandboxVm; uv: string }, targets: { repo: string; sha: string }[], log?: (m: string) => void): Promise<string> {
    const spec = targets.map((t) => `${t.repo}@${t.sha}`).sort();
    const key = venvKey(spec);
    let p = this.venvs.get(key);
    if (!p) {
      p = (async () => {
        const dirs: string[] = [];
        for (const t of targets) dirs.push(await this.ensureSource(box, t.repo, t.sha));
        log?.(`building the sandbox environment for ${spec.join(', ')}`);
        await this.setNetwork(box.vm, 'allow-all');
        const venv = `${ROOT}/venvs/${key}`;
        const mk = await this.command(box.vm, { cmd: box.uv, args: ['venv', '-q', '--python', PYTHON_VERSION, venv], timeoutMs: 300_000 });
        if (mk.code !== 0) throw new PrepareError(`uv venv failed: ${mk.stderr.trim()}`);
        const inst = await this.command(box.vm, { cmd: box.uv, args: ['pip', 'install', '-q', '--python', `${venv}/bin/python`, ...dirs], timeoutMs: 600_000 });
        if (inst.code !== 0) throw new PrepareError(installFailure(spec, inst.stderr));
        return `${venv}/bin/python`;
      })();
      this.venvs.set(key, p);
      p.catch(() => this.venvs.delete(key));
    }
    return p;
  }

  /** `runInSandbox` in the sandbox: a fresh directory, the same entry point, shim and environment, no network. */
  private async runProgram(box: { vm: SandboxVm; bin: string }, python: string, code: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
    const files = await deployedFiles();
    const work = `${ROOT}/runs/${++this.runs}`;
    await this.setNetwork(box.vm, 'deny-all');
    // FLUSHALL, then GRAPH.UDF FLUSH (FLUSHALL keeps UDF libraries), as flushScratchDb does.
    const flush = `set -eu; mkdir -p "$1/_shim"; out=$("$2/redis-cli" -p ${SCRATCH_PORT} FLUSHALL); [ "$out" = OK ] || { echo "FLUSHALL answered: $out" >&2; exit 1; }; "$2/redis-cli" -p ${SCRATCH_PORT} GRAPH.UDF FLUSH >/dev/null 2>&1 || true`;
    const fl = await this.command(box.vm, { cmd: 'bash', args: ['-c', flush, 'flush', work, box.bin], timeoutMs: 60_000 });
    if (fl.code !== 0) throw new PrepareError(`the scratch FalkorDB in the sandbox could not be flushed: ${fl.stderr.trim().slice(-300)}`);
    await this.call('uploading the example', () =>
      box.vm.writeFiles(
        [
          { path: `${work}/example.py`, content: code },
          { path: `${work}/_run_example.py`, content: files.entry },
          { path: `${work}/_shim/sitecustomize.py`, content: files.shim },
        ],
        this.opts.signal ? { signal: this.opts.signal } : undefined,
      ),
    );
    const env = [
      'PATH=/usr/bin:/bin',
      `HOME=${work}`,
      `TMPDIR=${work}`,
      'LANG=C.UTF-8',
      `PYTHONPATH=${work}/_shim`,
      'PYTHONDONTWRITEBYTECODE=1',
      'PYTHONUNBUFFERED=1',
      'STALEPROOF_SCRATCH_HOST=127.0.0.1',
      `STALEPROOF_SCRATCH_PORT=${SCRATCH_PORT}`,
    ];
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const started = Date.now();
    const r = await this.command(box.vm, { cmd: 'env', args: ['-i', ...env, 'timeout', '-k', '2', `${secs}s`, python, '-s', '_run_example.py'], cwd: work, timeoutMs: timeoutMs + 15_000 });
    const wall = Date.now() - started;
    // `timeout` exits 124 when it stopped the program; 137 is the SIGKILL after the grace period (or the sandbox's own limit).
    const timedOut = r.code === 124 || ((r.code === 137 || r.code === null) && wall >= timeoutMs);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut, durationMs: r.durationMs ?? wall };
  }
}

let deployed: Promise<{ falkordb: string; entry: string; shim: string }> | undefined;

/** The files the sandbox needs from this package; a deployment without them cannot run examples. */
function deployedFiles(): Promise<{ falkordb: string; entry: string; shim: string }> {
  deployed ??= (async () => {
    const root = packageRoot();
    const read = async (rel: string) => {
      try {
        return await readFile(join(root, rel), 'utf8');
      } catch {
        throw new SandboxUnavailableError(`${rel} is not deployed with this server (add it to the function's includeFiles)`);
      }
    };
    const [falkordb, entry, shim] = await Promise.all([read('scripts/falkordb-local.sh'), read('python/run_example.py'), read('python/sitecustomize.py')]);
    return { falkordb, entry, shim };
  })();
  deployed.catch(() => (deployed = undefined));
  return deployed;
}

function abortReason(signal: AbortSignal): string {
  const r = signal.reason as unknown;
  return r instanceof Error ? r.message : typeof r === 'string' ? r : 'the example runs were stopped';
}

function fromProps(p: Record<string, unknown>, side: RunRecord['side']): RunRecord {
  return {
    id: String(p.id),
    example: String(p.example),
    status: p.status as RunStatus,
    reason: (p.reason as string) || undefined,
    error: (p.error as string) || undefined,
    traceback: (p.traceback as string) || undefined,
    stdout: String(p.stdout ?? ''),
    durationMs: Number(p.duration_ms ?? 0),
    stitched: (p.stitched as string[]) ?? [],
    installed: (p.installed as string[]) ?? [],
    side,
    cached: true,
    createdAt: Number(p.created_at ?? 0),
  };
}

function tail(s: string, n = 4000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}
