/**
 * A false-positive report → a regression fixture (docs/false-positives.md).
 *
 *   npx tsx scripts/fp-to-fixture.ts --issue 41
 *   npx tsx scripts/fp-to-fixture.ts --repo pmndrs/zustand --sha <40-hex> --rule anchor-missing \
 *     --file docs/reference/hooks/use-store.md --line 20,21 [--slug angle-brackets] [--why "…"] \
 *     [--pending "…"] [--include <path>…] [--code <folder>…] [--from <checkout at that sha>] [--max-severity info]
 *     [--guard] [--keep-all] [--force]
 *
 * It clones the public repository at the commit (shallow), confirms the reported findings are there, and
 * copies only the page and the files those findings depend on into `test/fixtures/fp/<rule>-<slug>/repo/`,
 * with an `expected.json` that says "no finding <rule> at <file>:<line>". It then lints the fixture alone: when
 * the findings come back there too (the rule is not fixed yet) the fixture is marked `pending`, and
 * test/fp-corpus.test.ts expects them back until the fix lands, then fails until `pending` is removed.
 *
 * `--guard` builds the fixture of a false positive that is already fixed (it no longer reproduces), so the fix
 * stays: the lines stand for the findings that were reported.
 *
 * Path segments that start with a dot are stored as `dot.<name>` (`.github` → `dot.github`, `.gitignore` →
 * `dot.gitignore`), so nothing in a fixture configures this repository; `materialize` puts them back. The
 * repository's root LICENSE file is always copied with the rest.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FP_LABELS, FP_REPO, type FpField } from '../src/format/fp-link.js';
import { loadRepoConfig, type RepoConfig } from '../src/indexer/repo-config.js';
import { lintRepo } from '../src/lint/engine.js';
import { isRuleId, RULE_BY_ID } from '../src/lint/rules.js';
import { SEVERITY_RANK, type Finding, type RuleId, type Severity } from '../src/lint/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FP_FIXTURES = join(ROOT, 'test', 'fixtures', 'fp');

/** One reported false positive: where, which rule, which lines. */
export interface FpCase {
  issue?: number;
  issueUrl?: string;
  repo: string;
  sha: string;
  rule: RuleId;
  file: string;
  lines: number[];
  why?: string;
  version?: string;
  slug?: string;
  /** Extra repository files to copy (paths), when the defaults are not enough. */
  include?: string[];
  /** Folders whose code files are offered to the fixture (then dropped where not needed), for a large package. */
  code?: string[];
  /** Why the fixture still fails, when it is known (otherwise found by linting it). */
  pending?: string;
  /** The finding may come back at this severity or lower (a true note, e.g. "works only on the docs site"), never above. */
  maxSeverity?: Severity;
}

/** test/fixtures/fp/<case>/expected.json */
export interface FixtureExpected {
  /** "no finding <rule> [above <severity>] at <file>:<line>[, …]" */
  summary: string;
  issue?: number;
  issueUrl?: string;
  source: { repo: string; sha: string; urls: string[] };
  why?: string;
  /**
   * Findings that must not come back (the message is what was reported, for people). With `maxSeverity`, one may
   * come back at that severity or lower, never above. Judged with the rule opted in at its own severity, so a
   * beta rule's info level never hides a false positive.
   */
  absent: { rule: RuleId; file: string; line: number; message: string; maxSeverity?: Severity }[];
  /** Set while the rule is not fixed: the corpus test expects these findings back until it is. */
  pending?: string;
  /** The repository files the fixture holds (as in the repository, not as stored). */
  files: string[];
  /** The Staleproof version that built it. */
  builtWith?: string;
}

export interface Fixture {
  dir: string;
  name: string;
  expected: FixtureExpected;
}

// ---------------------------------------------------------------------------------------------- reading reports

/** The fields of a submitted issue form: `### <label>` sections, `_No response_` read as empty. */
export function parseIssueBody(body: string): Partial<Record<Exclude<FpField, 'share'>, string>> & { share?: boolean } {
  const byLabel = new Map<string, string>();
  const parts = body.replace(/\r\n/g, '\n').split(/^### (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) byLabel.set(parts[i]!.trim(), (parts[i + 1] ?? '').trim());
  const out: Partial<Record<Exclude<FpField, 'share'>, string>> & { share?: boolean } = {};
  for (const [field, label] of Object.entries(FP_LABELS) as [FpField, string][]) {
    const raw = byLabel.get(label);
    if (raw === undefined) continue;
    if (field === 'share') {
      out.share = /^- \[[xX]\] I can share/m.test(raw);
      continue;
    }
    if (!raw || raw === '_No response_') continue;
    // A `render:` textarea comes back fenced.
    const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(raw);
    out[field] = fenced ? fenced[1]! : raw;
  }
  return out;
}

function parseLines(spec: string): number[] {
  const lines: number[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`line must be N, N,M or N-M (got ${spec})`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b; n++) lines.push(n);
  }
  return [...new Set(lines)].sort((x, y) => x - y);
}

export function caseFromFields(f: { repo: string; sha: string; rule: string; file: string; line: string; why?: string; slug?: string; include?: string[]; pending?: string; version?: string; issue?: number; issueUrl?: string; maxSeverity?: string }): FpCase {
  if (f.maxSeverity && !(f.maxSeverity in SEVERITY_RANK)) throw new Error(`max severity must be error, warning or info (got ${f.maxSeverity})`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(f.repo)) throw new Error(`repo must be owner/name (got ${f.repo})`);
  if (!/^[0-9a-f]{40}$/.test(f.sha)) throw new Error(`sha must be a full commit sha, 40 hex characters (got ${f.sha})`);
  if (!isRuleId(f.rule)) throw new Error(`unknown rule ${f.rule}`);
  const file = posix.normalize(f.file.replace(/^\.?\//, ''));
  if (!file || file.startsWith('..')) throw new Error(`file must be a repository path (got ${f.file})`);
  return {
    repo: f.repo,
    sha: f.sha,
    rule: f.rule,
    file,
    lines: parseLines(f.line),
    ...(f.why ? { why: f.why } : {}),
    ...(f.slug ? { slug: f.slug } : {}),
    ...(f.include?.length ? { include: f.include } : {}),
    ...(f.pending ? { pending: f.pending } : {}),
    ...(f.version ? { version: f.version } : {}),
    ...(f.issue ? { issue: f.issue } : {}),
    ...(f.issueUrl ? { issueUrl: f.issueUrl } : {}),
    ...(f.maxSeverity ? { maxSeverity: f.maxSeverity as Severity } : {}),
  };
}

/** A submitted false-positive issue as a case; throws when it cannot be reproduced from public code. */
export function caseFromIssue(issue: { number: number; url: string; body: string }): FpCase {
  const f = parseIssueBody(issue.body);
  if (!f.rule || !isRuleId(f.rule)) throw new Error(`issue #${issue.number}: unknown rule ${f.rule ?? '(none)'}`);
  const repo = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/.exec(f.repository ?? '');
  if (!repo) throw new Error(`issue #${issue.number}: the report names no public repository at a commit (${f.repository ?? 'none'}); reproduce it by hand from the rule and the message`);
  const loc = /^(.+?):(\d+(?:[-,]\d+)*)$/.exec(f.location ?? '');
  if (!loc) throw new Error(`issue #${issue.number}: the report has no file and line (${f.location ?? 'none'})`);
  return caseFromFields({ repo: repo[1]!, sha: repo[2]!, rule: f.rule, file: loc[1]!, line: loc[2]!, why: f.why, version: f.version, issue: issue.number, issueUrl: issue.url || undefined });
}

/** `<rule>-<repository name>-<slug or page>`, lower case, dashes only. */
export function slugFor(c: Pick<FpCase, 'rule' | 'repo' | 'file'>, slug?: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const name = clean(c.repo.split('/')[1] ?? c.repo);
  const tail = clean(slug ?? basename(c.file).replace(/\.[^.]+$/, ''));
  return `${c.rule}-${tail.startsWith(`${name}-`) || tail === name ? tail : `${name}-${tail}`}`;
}

// ------------------------------------------------------------------------------------------------- storing files

export function storedPath(path: string): string {
  return path
    .split('/')
    .map((s) => (s.startsWith('.') ? `dot${s}` : s))
    .join('/');
}

export function restoredPath(path: string): string {
  return path
    .split('/')
    .map((s) => (s.startsWith('dot.') ? s.slice(3) : s))
    .join('/');
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=fp@staleproof.dev', '-c', 'user.name=staleproof-fp', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 }).trim();

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

/** The fixture's repository as a git checkout in a temporary folder (dot names restored, one commit). */
export async function materialize(fixtureDir: string): Promise<string> {
  const tree = await mkdtemp(join(tmpdir(), 'staleproof-fp-'));
  for (const stored of await walk(join(fixtureDir, 'repo'))) {
    const dest = join(tree, restoredPath(stored));
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(fixtureDir, 'repo', stored), dest);
  }
  git(tree, 'init', '-q', '-b', 'main');
  git(tree, 'add', '-A', '-f');
  git(tree, 'commit', '-q', '-m', 'fixture', '--allow-empty');
  return tree;
}

export async function readFixture(dir: string): Promise<Fixture> {
  const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')) as FixtureExpected;
  return { dir, name: basename(dir), expected };
}

/** Every fixture of the corpus, by name. */
export async function readCorpus(root = FP_FIXTURES): Promise<Fixture[]> {
  if (!existsSync(root)) return [];
  const out: Fixture[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(root, e.name, 'expected.json'))) out.push(await readFixture(join(root, e.name)));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function lintOptionsFor(rules: RuleId[]) {
  return { rules, examples: rules.some((r) => r.startsWith('example-')), cache: false as const };
}

/** The checkout's own config with these rules opted in at their own severity (beta rules judged as if trusted). */
async function optedIn(dir: string, rules: RuleId[]): Promise<RepoConfig> {
  const base = await loadRepoConfig(dir);
  return { ...base, rules: { ...Object.fromEntries(rules.map((r) => [r, RULE_BY_ID.get(r)!.severity])), ...base.rules } };
}

/** Lint the fixture alone: the findings at the places it guards, at any severity. */
export async function lintFixture(fx: Fixture): Promise<Finding[]> {
  const tree = await materialize(fx.dir);
  const rules = [...new Set(fx.expected.absent.map((a) => a.rule))];
  const r = await lintRepo({ dir: tree, repo: fx.expected.source.repo, sha: fx.expected.source.sha, config: await optedIn(tree, rules), ...lintOptionsFor(rules) });
  return r.findings.filter((f) => fx.expected.absent.some((a) => a.rule === f.rule && a.file === f.path && a.line === f.line));
}

/** The findings the fixture says must not come back that did (above `maxSeverity` where it allows one). */
export function violations(fx: Fixture, found: Finding[]): Finding[] {
  return found.filter((f) =>
    fx.expected.absent.some((a) => a.rule === f.rule && a.file === f.path && a.line === f.line && (!a.maxSeverity || SEVERITY_RANK[f.severity] > SEVERITY_RANK[a.maxSeverity])),
  );
}

/** Lint the fixture alone and return the findings it says must not come back that did. */
export async function checkFixture(fx: Fixture): Promise<Finding[]> {
  return violations(fx, await lintFixture(fx));
}

// ------------------------------------------------------------------------------------------------ choosing files

const MANIFESTS = /^(package\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg|setup\.py|go\.mod|Cargo\.toml|\.staleproof\.toml|\.gitignore|Makefile|justfile|Justfile|Taskfile\.ya?ml)$/;
const DOCS_CONFIG = /^(docs\/)?(mkdocs\.ya?ml|docusaurus\.config\.[cm]?[jt]s|astro\.config\.[cm]?[jt]s|conf\.py|_config\.ya?ml|mint\.json|docs\.json|\.vitepress\/config\.[cm]?[jt]s|vocs\.config\.[cm]?[jt]sx?)$/;
const CODE = /\.(py|pyi|[cm]?[jt]sx?|go)$/;
/** The repository's license travels with the files copied from it. */
const LICENSE = /^(LICEN[CS]E|COPYING)([.-][\w.-]+)?$/i;
const ENV_EXAMPLE = /(^|\/)\.env\.[\w.-]*(example|sample|template|dist)[\w.-]*$|(^|\/)\.env\.local\.example$/;
/** Copy a package's whole source when it is this small; otherwise only files that name the subject. */
const SMALL_CODE = 512 * 1024;

function sizeOf(dir: string, files: string[]): number {
  return files.reduce((n, f) => n + (existsSync(join(dir, f)) ? statSync(join(dir, f)).size : 0), 0);
}

/** Files of the checkout that mention `word` (whole word, any case), via git grep. */
function mentioning(dir: string, word: string, cap = 20): string[] {
  if (!/^[\w.$-]{2,}$/.test(word)) return [];
  try {
    return git(dir, 'grep', '-l', '-i', '-w', '-F', '-e', word).split('\n').filter(Boolean).slice(0, cap);
  } catch {
    return [];
  }
}

/** Repository paths a finding's subject names (link targets, paths, `page.md#anchor`), as they resolve. */
function namedPaths(f: Finding, files: Set<string>): string[] {
  const raw = f.subject.replace(/#.*$/, '').replace(/:\d+$/, '');
  if (!raw) return [];
  const out = [posix.normalize(posix.join(posix.dirname(f.path), raw)), posix.normalize(raw.replace(/^\//, ''))];
  return out.filter((p) => files.has(p));
}

/**
 * The files a finding depends on: the page; the root manifests and config that steer the checks (package
 * manifests, `.gitignore`, `.staleproof.toml`, Make/just/Task files, the docs site's config); what the subject
 * names (a link target, the page of an anchor); env example files and the files naming the variable (env
 * rules); the package's code, or the files naming the subject when it is large (code rules); `include`.
 */
export function dependencyFiles(dir: string, files: string[], findings: Finding[], include: string[] = []): string[] {
  const all = new Set(files);
  const pick = new Set<string>(include.filter((p) => all.has(p)));
  for (const f of files) if ((!f.includes('/') && (MANIFESTS.test(f) || LICENSE.test(f))) || DOCS_CONFIG.test(f)) pick.add(f);
  for (const f of findings) {
    pick.add(f.path);
    // Manifests of the page's folders (a nested package.json, Makefile).
    for (let d = posix.dirname(f.path); d !== '.' && d !== '/'; d = posix.dirname(d)) for (const m of files) if (posix.dirname(m) === d && MANIFESTS.test(posix.basename(m))) pick.add(m);
    for (const p of namedPaths(f, all)) pick.add(p);
    if (f.rule.startsWith('env-')) {
      for (const e of files) if (ENV_EXAMPLE.test(e)) pick.add(e);
      for (const m of mentioning(dir, f.subject)) pick.add(m);
    }
    if (f.rule.startsWith('example-') || f.rule.startsWith('docstring-') || f.rule === 'symbol-missing' || f.rule.startsWith('cli-')) {
      const code = files.filter((x) => CODE.test(x) && !/(^|\/)(node_modules|dist|build|test|tests|__tests__|examples?|fixtures?)\//.test(x) && !/\.(test|spec)\.[jt]sx?$/.test(x));
      if (sizeOf(dir, code) <= SMALL_CODE) for (const c of code) pick.add(c);
      else for (const m of mentioning(dir, f.subject.split('.').pop() ?? f.subject, 40)) if (CODE.test(m)) pick.add(m);
    }
  }
  return [...pick].filter((p) => all.has(p)).sort();
}

// ------------------------------------------------------------------------------------------------------- building

async function checkoutAt(c: FpCase, from: string | undefined, log: (s: string) => void): Promise<string> {
  if (from) {
    const head = git(from, 'rev-parse', 'HEAD');
    if (head !== c.sha) throw new Error(`${from} is at ${head.slice(0, 12)}, not ${c.sha.slice(0, 12)}`);
    return from;
  }
  // Only public repositories: the fixture is published with this repository.
  const isPrivate = execFileSync('gh', ['api', `repos/${c.repo}`, '--jq', '.private'], { encoding: 'utf8' }).trim();
  if (isPrivate !== 'false') throw new Error(`${c.repo} is not a public repository: no fixture is made from it`);
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-fp-clone-'));
  log(`cloning ${c.repo}@${c.sha.slice(0, 12)} (depth 1)`);
  git(dir, 'init', '-q');
  git(dir, 'fetch', '-q', '--depth', '1', `https://github.com/${c.repo}.git`, c.sha);
  git(dir, 'checkout', '-q', 'FETCH_HEAD');
  return dir;
}

export interface BuildOptions {
  /** An existing checkout at the case's commit, instead of cloning. */
  from?: string;
  /** Where fixtures go (default test/fixtures/fp). */
  root?: string;
  force?: boolean;
  log?: (s: string) => void;
  /** Recorded in expected.json. */
  version?: string;
  /** The finding is already fixed: build the fixture anyway, as a guard that it stays fixed. */
  guard?: boolean;
  /** Keep every selected file (skip dropping the code files the findings do not need). */
  keepAll?: boolean;
}

/** The findings at the guarded places are exactly the reported ones (same messages, nothing more). */
function sameFindings(findings: readonly Finding[], absent: FixtureExpected['absent']): boolean {
  const at = findings.filter((f) => absent.some((a) => a.rule === f.rule && a.file === f.path && a.line === f.line));
  return at.length === absent.length && absent.every((a) => at.some((f) => f.rule === a.rule && f.path === a.file && f.line === a.line && f.message === a.message));
}

/** At most this many lints while dropping files. */
const MINIMIZE_BUDGET = 150;

/**
 * The selected files minus the code files the findings do not need: chunks of them are dropped while the
 * findings still come back from a tree of the rest (halving the chunk down to single files). The page, the
 * manifests and config, and `include` always stay.
 */
async function minimize(checkout: string, picked: string[], c: FpCase, absent: FixtureExpected['absent'], log: (s: string) => void): Promise<string[]> {
  const optional = picked.filter((p) => CODE.test(p) && p !== c.file && !c.include?.includes(p));
  if (!optional.length) return picked;
  const required = picked.filter((p) => !optional.includes(p));
  const rules = [...new Set(absent.map((a) => a.rule))];
  let runs = 0;
  const reproduces = async (paths: string[]): Promise<boolean> => {
    runs++;
    const tree = await mkdtemp(join(tmpdir(), 'staleproof-fp-min-'));
    for (const p of paths) {
      await mkdir(dirname(join(tree, p)), { recursive: true });
      await cp(join(checkout, p), join(tree, p));
    }
    git(tree, 'init', '-q', '-b', 'main');
    git(tree, 'add', '-A', '-f');
    git(tree, 'commit', '-q', '-m', 'min', '--allow-empty');
    const r = await lintRepo({ dir: tree, repo: c.repo, sha: c.sha, config: await optedIn(tree, rules), ...lintOptionsFor(rules) });
    await rm(tree, { recursive: true, force: true });
    return sameFindings(r.findings, absent);
  };
  if (await reproduces(required)) {
    log(`no code file is needed: dropped ${optional.length}`);
    return required;
  }
  let keep = [...optional];
  for (let size = Math.ceil(keep.length / 2); ; size = Math.ceil(size / 2)) {
    for (let i = 0; i < keep.length && runs < MINIMIZE_BUDGET; ) {
      const without = [...keep.slice(0, i), ...keep.slice(i + size)];
      if (await reproduces([...required, ...without])) keep = without;
      else i += size;
    }
    if (size === 1 || runs >= MINIMIZE_BUDGET) break;
  }
  log(`kept ${keep.length} of ${optional.length} code files (${runs} lints)`);
  return [...required, ...keep].sort();
}

/** Build the fixture of a case; returns where it went and whether the findings come back from it today. */
export async function buildFixture(c: FpCase, opts: BuildOptions = {}): Promise<{ dir: string; expected: FixtureExpected; reproduces: boolean }> {
  const log = opts.log ?? ((s: string) => console.error(s));
  const name = slugFor(c, c.slug);
  const dir = join(opts.root ?? FP_FIXTURES, name);
  if (existsSync(dir) && !opts.force) throw new Error(`${dir} already exists (--force replaces it)`);
  const checkout = await checkoutAt(c, opts.from, log);

  const files = git(checkout, 'ls-files', '-z').split('\0').filter(Boolean);
  if (!files.includes(c.file)) throw new Error(`${c.file} is not a file of ${c.repo}@${c.sha.slice(0, 12)}`);
  const full = await lintRepo({ dir: checkout, repo: c.repo, sha: c.sha, config: await optedIn(checkout, [c.rule]), ...lintOptionsFor([c.rule]) });
  let reported = full.findings.filter((f) => f.rule === c.rule && f.path === c.file && c.lines.includes(f.line));
  const missing = c.lines.filter((l) => !reported.some((f) => f.line === l));
  if (missing.length && !opts.guard) throw new Error(`no ${c.rule} finding at ${missing.map((l) => `${c.file}:${l}`).join(', ')} with this Staleproof at ${c.sha.slice(0, 12)} (already fixed, or another line? --guard keeps a fixed one from coming back)`);
  if (opts.guard) {
    // Already fixed: the fixture guards the fix. The lines stand for the findings that were reported.
    const stub = (line: number): Finding => ({ rule: c.rule, severity: 'info', message: '(reported before the fix; see why)', path: c.file, line, column: 1, endLine: line, endColumn: 1, surface: 'docs', subject: '', fingerprint: '' });
    reported = [...reported, ...missing.map(stub)];
  }

  let picked = dependencyFiles(checkout, files, reported, c.include);
  if (c.code?.length) {
    const under = (f: string) => c.code!.some((d) => f.startsWith(`${d.replace(/\/+$/, '')}/`));
    // The package manifests above each folder name the package its code is.
    const manifests = files.filter((m) => MANIFESTS.test(posix.basename(m)) && c.code!.some((d) => d.startsWith(`${posix.dirname(m) === '.' ? '' : `${posix.dirname(m)}/`}`)));
    picked = [...new Set([...picked, ...manifests, ...files.filter((f) => CODE.test(f) && under(f) && !/(^|\/)(test|tests|__tests__)\//.test(f) && !/\.(test|spec)\.[jt]sx?$/.test(f))])].sort();
  }
  const write = async (paths: string[]) => {
    await rm(join(dir, 'repo'), { recursive: true, force: true });
    await mkdir(join(dir, 'repo'), { recursive: true });
    for (const p of paths) {
      const dest = join(dir, 'repo', storedPath(p));
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(checkout, p), dest);
    }
  };
  const absent = reported.map((f) => ({ rule: f.rule, file: f.path, line: f.line, message: f.message, ...(c.maxSeverity ? { maxSeverity: c.maxSeverity } : {}) }));
  const expected: FixtureExpected = {
    summary: `no finding ${c.rule}${c.maxSeverity ? ` above ${c.maxSeverity}` : ''} at ${[...new Set(absent.map((a) => `${a.file}:${a.line}`))].join(', ')}`,
    ...(c.issue ? { issue: c.issue } : {}),
    ...(c.issueUrl ? { issueUrl: c.issueUrl } : {}),
    source: { repo: c.repo, sha: c.sha, urls: c.lines.map((l) => `https://github.com/${c.repo}/blob/${c.sha}/${c.file}#L${l}`) },
    ...(c.why ? { why: c.why } : {}),
    absent,
    files: picked,
    ...(opts.version ? { builtWith: opts.version } : {}),
  };
  await write(picked);
  await writeFile(join(dir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);

  // The fixture must reproduce what the full checkout reports: widen to every code file once if it does not.
  let found = await lintFixture({ dir, name, expected });
  if (opts.guard) {
    const back = violations({ dir, name, expected }, found);
    log(`${relative(process.cwd(), dir) || dir}: ${picked.length} file${picked.length === 1 ? '' : 's'}, ${expected.summary} (guard: ${back.length ? `${back.length} still reported in the fixture` : 'passes'})`);
    return { dir, expected, reproduces: back.length > 0 };
  }
  if (!sameFindings(found, absent)) {
    const code = files.filter((f) => CODE.test(f));
    if (sizeOf(checkout, code) <= 4 * SMALL_CODE) {
      log(`the selected files do not reproduce every finding; adding the ${code.length} code files`);
      picked = [...new Set([...picked, ...code])].sort();
      expected.files = picked;
      await write(picked);
      await writeFile(join(dir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
      found = await lintFixture({ dir, name, expected });
    }
  }
  if (sameFindings(found, absent) && !opts.keepAll) {
    const minimal = await minimize(checkout, picked, c, absent, log);
    if (minimal.length < picked.length) {
      picked = minimal;
      expected.files = picked;
      await write(picked);
      await writeFile(join(dir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
      found = await lintFixture({ dir, name, expected });
    }
  }
  const back = violations({ dir, name, expected }, found);
  const reproduces = sameFindings(found, absent);
  if (!reproduces) {
    // Never leave a fixture that does not show what it guards.
    await rm(dir, { recursive: true, force: true });
    throw new Error(`the fixture does not reproduce the ${absent.length} reported finding${absent.length === 1 ? '' : 's'} exactly (it has ${found.length} there; nothing written): name the files they depend on with --include, or a package folder with --code`);
  } else if (!back.length) {
    log(`the fixture passes already (every finding at or below its max severity): it guards the fix`);
  } else {
    expected.pending = c.pending ?? `reproduces with Staleproof ${opts.version ?? 'today'}: the corpus expects these findings back until ${c.rule} is fixed, then remove this field`;
    await writeFile(join(dir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  }
  log(`${relative(process.cwd(), dir) || dir}: ${picked.length} file${picked.length === 1 ? '' : 's'}, ${expected.summary}${expected.pending ? ' (pending)' : ''}`);
  return { dir, expected, reproduces };
}

// ----------------------------------------------------------------------------------------------------------- CLI

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      issue: { type: 'string' },
      repo: { type: 'string' },
      sha: { type: 'string' },
      rule: { type: 'string' },
      file: { type: 'string' },
      line: { type: 'string' },
      slug: { type: 'string' },
      why: { type: 'string' },
      pending: { type: 'string' },
      include: { type: 'string', multiple: true },
      from: { type: 'string' },
      force: { type: 'boolean' },
      guard: { type: 'boolean' },
      'max-severity': { type: 'string' },
      'keep-all': { type: 'boolean' },
      code: { type: 'string', multiple: true },
    },
  });
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  let c: FpCase;
  if (values.issue) {
    const raw = execFileSync('gh', ['issue', 'view', values.issue, '--repo', FP_REPO, '--json', 'number,url,body'], { encoding: 'utf8' });
    c = caseFromIssue(JSON.parse(raw) as { number: number; url: string; body: string });
    if (values.slug) c.slug = values.slug;
    if (values.include?.length) c.include = values.include;
    if (values.pending) c.pending = values.pending;
    if (values.code?.length) c.code = values.code;
  } else {
    for (const k of ['repo', 'sha', 'rule', 'file', 'line'] as const) if (!values[k]) throw new Error(`--${k} is required without --issue`);
    c = caseFromFields({ repo: values.repo!, sha: values.sha!, rule: values.rule!, file: values.file!, line: values.line!, why: values.why, slug: values.slug, include: values.include, pending: values.pending, maxSeverity: values['max-severity'] });
    if (values.code?.length) c.code = values.code;
  }
  const r = await buildFixture(c, { from: values.from ? resolve(values.from) : undefined, force: values.force, guard: values.guard, keepAll: values['keep-all'], version: pkg.version });
  // A new report must reproduce in its fixture; a guard must not.
  if (values.guard ? r.reproduces : !r.reproduces) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
