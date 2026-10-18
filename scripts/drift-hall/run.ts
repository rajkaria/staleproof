/**
 * Drift Hall run: clone every corpus repository at its recorded commit and lint it with this checkout's CLI.
 * Raw outputs go to .ocean/drift-hall/raw/<owner>__<name>.lint.json (the CLI's JSON, verified fixes attached) with a
 * .meta.json beside it (time, exit status, the CLI's stderr).
 *
 *   npx tsx scripts/drift-hall/run.ts --clones <dir> [--jobs 3] [--no-fixes] [--force] [--timeout <minutes>] [--raw <dir>] [--held-out] [owner/name ...]
 *
 * Clones are shallow (`--depth 200`) and blob-less: lint reads deletions and renames from that history without file
 * contents, and the checkout fetches only the files of the recorded commit. Nothing is written to the clones except
 * the parse cache, which ignores itself in git. Lint needs no graph and no network.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HELD_OUT } from './heldout.js';
import { CORPUS, type DriftRepo } from './repos.js';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..', '..');
export const RAW_DIR = join(root, '.ocean', 'drift-hall', 'raw');
/** The held-out set's raw outputs (scripts/drift-hall/heldout.ts). */
export const HELD_OUT_RAW_DIR = join(root, '.ocean', 'drift-hall', 'held-out', 'raw');

/** `owner/name` → `owner__name`, the file and folder name used everywhere in the Drift Hall. */
export const slug = (repo: string) => repo.replace('/', '__');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

/** A clone of `r` at exactly `r.sha`; an existing clone at that commit is reused. */
export async function cloneAt(r: DriftRepo, clones: string, depth = 200): Promise<string> {
  const dir = join(clones, slug(r.repo));
  if (existsSync(join(dir, '.git'))) {
    const head = await git(dir, ['rev-parse', 'HEAD']).catch(() => '');
    if (head === r.sha) return dir;
    throw new Error(`${dir} is at ${head || 'no commit'}, not ${r.sha}: move it away and run again`);
  }
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['remote', 'add', 'origin', `https://github.com/${r.repo}.git`]);
  // Fetching the recorded commit by sha (GitHub allows it) keeps the run reproducible after the branch moves.
  await git(dir, ['fetch', '-q', `--depth=${depth}`, '--filter=blob:none', 'origin', r.sha]);
  await git(dir, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', r.sha]);
  return dir;
}

export interface RunMeta {
  repo: string;
  sha: string;
  ms: number;
  exitCode: number;
  fixes: boolean;
  stderr: string;
  error?: string;
}

async function lintOne(r: DriftRepo, clones: string, fixes: boolean, minutes = 15, rawDir = RAW_DIR): Promise<RunMeta> {
  const out = join(rawDir, `${slug(r.repo)}.lint.json`);
  const t0 = Date.now();
  let dir: string;
  try {
    dir = await cloneAt(r, clones);
  } catch (err) {
    return { repo: r.repo, sha: r.sha, ms: Date.now() - t0, exitCode: -1, fixes, stderr: '', error: `clone: ${(err as Error).message}` };
  }
  const args = ['tsx', join(root, 'src', 'cli.ts'), 'lint', dir, '--format', 'json', '--fail-on', 'never', '--repo', r.repo, '--out', out];
  if (fixes) args.push('--fixes');
  const t1 = Date.now();
  try {
    const { stderr } = await run('npx', args, { cwd: root, maxBuffer: 256 << 20, timeout: minutes * 60_000 });
    return { repo: r.repo, sha: r.sha, ms: Date.now() - t1, exitCode: 0, fixes, stderr: stderr.slice(-4000) };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message: string; killed?: boolean };
    return {
      repo: r.repo,
      sha: r.sha,
      ms: Date.now() - t1,
      exitCode: typeof e.code === 'number' ? e.code : -1,
      fixes,
      stderr: (e.stderr ?? '').slice(-4000),
      error: e.killed ? `timed out after ${minutes} minutes` : e.message.split('\n')[0],
    };
  }
}

async function main(): Promise<void> {
  const clones = arg('--clones') ?? join(tmpdir(), 'drift-hall-clones');
  const jobs = Number(arg('--jobs') ?? 3);
  const fixes = !process.argv.includes('--no-fixes');
  const force = process.argv.includes('--force');
  const minutes = Number(arg('--timeout') ?? 15);
  // --raw <dir>: write elsewhere, e.g. a re-run with a newer Staleproof to compare against the verdicts (compare.ts).
  // --held-out: the held-out set (heldout.ts) instead of the hall's corpus.
  const heldOut = process.argv.includes('--held-out');
  const corpus = heldOut ? HELD_OUT : CORPUS;
  const rawDir = arg('--raw') ?? (heldOut ? HELD_OUT_RAW_DIR : RAW_DIR);
  const named = process.argv.slice(2).filter((a, i, all) => a.includes('/') && !['--clones', '--raw'].includes(all[i - 1] ?? '') && !a.startsWith('/') && !a.startsWith('.'));
  const todo = corpus.filter((r) => !named.length || named.some((n) => n.toLowerCase() === r.repo.toLowerCase())).filter(
    (r) => force || !existsSync(join(rawDir, `${slug(r.repo)}.lint.json`)),
  );
  await mkdir(rawDir, { recursive: true });
  await mkdir(clones, { recursive: true });
  console.log(`linting ${todo.length} repositories (${jobs} at a time, fixes ${fixes ? 'on' : 'off'}), clones in ${clones}`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++]!;
      let meta = await lintOne(r, clones, fixes, minutes, rawDir);
      // --fixes lints twice more; a repository too big for that is linted without it.
      if (meta.error && fixes && !meta.error.startsWith('clone')) meta = { ...(await lintOne(r, clones, false, minutes, rawDir)), stderr: `${meta.error}; retried without --fixes\n${meta.stderr}` };
      await writeFile(join(rawDir, `${slug(r.repo)}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
      let line = meta.error ?? '';
      if (!meta.error) {
        const res = JSON.parse(await readFile(join(rawDir, `${slug(r.repo)}.lint.json`), 'utf8')) as { summary: { errors: number; warnings: number; infos: number; files: number } };
        line = `${res.summary.files} files, ${res.summary.errors} errors, ${res.summary.warnings} warnings, ${res.summary.infos} infos`;
      }
      console.log(`${r.repo}@${r.sha.slice(0, 9)}: ${line} (${(meta.ms / 1000).toFixed(1)} s)`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
