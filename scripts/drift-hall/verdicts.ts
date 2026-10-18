/**
 * Compiles the hand-checked verdicts into .ocean/drift-hall/verdicts.jsonl, one line per judged finding with the
 * finding itself, so the data never drifts from the raw lint output it judges.
 *
 *   npx tsx scripts/drift-hall/verdicts.ts            # write verdicts.jsonl, list what is still unjudged
 *   npx tsx scripts/drift-hall/verdicts.ts --todo <owner/name> [--info]   # print the unjudged findings of one repo
 *   [--held-out]   the held-out set (.ocean/drift-hall/held-out/); [--raw <dir>] judge a re-run's outputs instead
 *
 * The sources, .ocean/drift-hall/verdicts.src and every .ocean/drift-hall/verdicts.d/*.src (read in name order
 * after it), hold one judgment per line:
 *
 *   owner/name | rule=anchor-missing path=docs/a.md line=23 subject~^#i’ve | false-positive | why, in one line
 *
 * Filters are `key=value` (exact) or `key~regex` over rule, path, line, column, subject, severity and message, ANDed. A line
 * applies to every matching finding at warning or error level (info too when the filter names `severity=info`, and
 * then the verdict is marked sampled). Later lines win, so a group verdict can be followed by its exceptions.
 * Optional further columns: `fix=ok` or `fix=wrong` judges the verified fix the finding carries; `dup=<path>` marks a
 * finding in a file that is a link to (or a generated copy of) another, so the hall lists it once. A line starting
 * with `#` is a comment.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, LintResult } from '../../src/lint/types.js';
import { HELD_OUT } from './heldout.js';
import { CORPUS, type DriftRepo } from './repos.js';

export type Verdict = 'confirmed' | 'false-positive' | 'unclear';

export interface VerdictRow {
  repo: string;
  sha: string;
  rule: Finding['rule'];
  severity: Finding['severity'];
  surface: Finding['surface'];
  path: string;
  line: number;
  column: number;
  subject: string;
  message: string;
  fingerprint: string;
  verdict: Verdict;
  reason: string;
  /** Info-level findings are sampled, not all judged. */
  sampled?: boolean;
  fix?: { description: string; verified: boolean; correct?: boolean };
  /** The same text in another file this one links to or is generated from: listed once, under that file. */
  duplicateOf?: string;
}

const root = join(import.meta.dirname, '..', '..');
export const DRIFT_DIR = join(root, '.ocean', 'drift-hall');
/** A set of repositories with its own verdict sources and raw lint outputs: the hall, or the held-out set. */
export interface DriftSet {
  corpus: DriftRepo[];
  /** Holds verdicts.src, verdicts.d/ and verdicts.jsonl. */
  dir: string;
  /** The raw lint outputs judged (a re-run's folder to judge what a newer Staleproof reports). */
  rawDir: string;
}
export const HALL: DriftSet = { corpus: CORPUS, dir: DRIFT_DIR, rawDir: join(DRIFT_DIR, 'raw') };
export const HELD: DriftSet = { corpus: HELD_OUT, dir: join(DRIFT_DIR, 'held-out'), rawDir: join(DRIFT_DIR, 'held-out', 'raw') };
const VERDICTS: Verdict[] = ['confirmed', 'false-positive', 'unclear'];

export const slug = (repo: string) => repo.replace('/', '__');

export function loadLint(repo: string, rawDir = HALL.rawDir): LintResult | undefined {
  const f = join(rawDir, `${slug(repo)}.lint.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as LintResult) : undefined;
}

interface Judgment {
  repo: string;
  test: (f: Finding) => boolean;
  info: boolean;
  verdict: Verdict;
  reason: string;
  fix?: boolean;
  dup?: string;
  line: number;
  file: string;
}

function parseFilter(text: string, at: string): { test: (f: Finding) => boolean; info: boolean } {
  const parts = text.trim().split(/\s+(?=\w+[=~])/).filter(Boolean);
  const tests: ((f: Finding) => boolean)[] = [];
  let info = false;
  for (const p of parts) {
    const m = /^(\w+)([=~])(.*)$/.exec(p);
    if (!m) throw new Error(`${at}: bad filter ${p}`);
    const [, key, op, value] = m as unknown as [string, string, string, string];
    if (!['rule', 'path', 'line', 'column', 'subject', 'severity', 'message'].includes(key)) throw new Error(`${at}: unknown filter key ${key} (fix= and dup= go in their own columns after the reason)`);
    if (key === 'severity' && value === 'info') info = true;
    const get = (f: Finding) => String((f as unknown as Record<string, unknown>)[key]);
    if (op === '=') tests.push((f) => get(f) === value);
    else {
      const re = new RegExp(value, 'u');
      tests.push((f) => re.test(get(f)));
    }
  }
  return { test: (f) => tests.every((t) => t(f)), info };
}

export function sourceFiles(dir = DRIFT_DIR): string[] {
  const d = join(dir, 'verdicts.d');
  const more = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.src')).sort().map((f) => join(d, f)) : [];
  return [join(dir, 'verdicts.src'), ...more].filter((f) => existsSync(f));
}

export function readJudgments(files = sourceFiles(), corpus: DriftRepo[] = [...CORPUS, ...HELD_OUT]): Judgment[] {
  const out: Judgment[] = [];
  for (const file of files) {
    const name = file.slice(DRIFT_DIR.length + 1);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const at = `${name}:${i + 1}`;
        const cols = line.split(' | ').map((c) => c.trim());
        if (cols.length < 4) throw new Error(`${at}: need repo | filter | verdict | reason`);
        const [repo, filter, verdict, ...rest] = cols as [string, string, string, ...string[]];
        if (!VERDICTS.includes(verdict as Verdict)) throw new Error(`${at}: verdict must be ${VERDICTS.join(', ')}`);
        if (!corpus.some((r) => r.repo === repo)) throw new Error(`${at}: ${repo} is not in the corpus`);
        let fix: boolean | undefined;
        let dup: string | undefined;
        // Trailing `fix=` / `dup=` columns; anything else (a reason that itself contains " | ") is the reason.
        while (rest.length > 1 && /^(fix=(ok|wrong)|dup=\S+)$/.test(rest.at(-1)!)) {
          const x = rest.pop()!;
          if (x.startsWith('fix=')) fix = x === 'fix=ok';
          else dup = x.slice(4);
        }
        const reason = rest.join(' | ');
        out.push({ repo, ...parseFilter(filter, at), verdict: verdict as Verdict, reason, fix, dup, line: i + 1, file: name });
      });
  }
  return out;
}

/** Every judged finding of every linted corpus repository. */
export function compile(
  judgments = readJudgments(),
  set: DriftSet = HALL,
): { rows: VerdictRow[]; unjudged: Map<string, Finding[]>; unused: Judgment[] } {
  const rows: VerdictRow[] = [];
  const unjudged = new Map<string, Finding[]>();
  const used = new Set<Judgment>();
  for (const r of set.corpus) {
    const lint = loadLint(r.repo, set.rawDir);
    if (!lint) continue;
    const mine = judgments.filter((j) => j.repo === r.repo);
    for (const f of lint.findings) {
      let hit: Judgment | undefined;
      for (const j of mine) if ((f.severity !== 'info' || j.info) && j.test(f)) hit = j;
      if (!hit) {
        if (f.severity !== 'info') unjudged.set(r.repo, [...(unjudged.get(r.repo) ?? []), f]);
        continue;
      }
      used.add(hit);
      rows.push({
        repo: r.repo,
        sha: r.sha,
        rule: f.rule,
        severity: f.severity,
        surface: f.surface,
        path: f.path,
        line: f.line,
        column: f.column,
        subject: f.subject,
        message: f.message,
        fingerprint: f.fingerprint,
        verdict: hit.verdict,
        reason: hit.reason,
        ...(f.severity === 'info' ? { sampled: true } : {}),
        ...(f.fix ? { fix: { description: f.fix.description, verified: f.fix.verified, ...(hit.fix !== undefined ? { correct: hit.fix } : {}) } } : {}),
        ...(hit.dup ? { duplicateOf: hit.dup } : {}),
      });
    }
  }
  markLinkedDuplicates(rows);
  markVersionCopies(rows);
  return { rows, unjudged, unused: judgments.filter((j) => !used.has(j)) };
}

/** A docs path with its version folder taken out: the page a versioned copy is a copy of. */
export function unversioned(path: string): string {
  return path
    .replace(/(^|\/)(\w+)_versioned_docs\/version-[^/]+\//, '$1$2/') // Docusaurus plugin instance: reference_versioned_docs/version-2.30/ -> reference/
    .replace(/(^|\/)versioned_docs\/version-[^/]+\//, '$1docs/') // Docusaurus: versioned_docs/version-2.30/ -> docs/
    .replace(/(^|\/)(docs?)\/(v\d+(\.\d+)*|edge|latest|next)\//, '$1$2/'); // Mintlify/folder versions: docs/v1.15.28/ and docs/edge/ -> docs/
}

const versionRank = (path: string): number[] => {
  if (unversioned(path) === path) return [Infinity];
  if (/(^|\/)(edge|next|latest)\//.test(path)) return [1e9];
  const v = /(?:version-|\/v)(\d+(?:\.\d+)*)\//.exec(path)?.[1];
  return v ? v.split('.').map(Number) : [0];
};
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/**
 * Versioned copies of one page (a docs site keeps a frozen copy per release: docs/v1.15.28/, versioned_docs/version-2.30/)
 * repeat the same finding once per copy. The same claim (rule, subject, message, its occurrence on the page) with the same
 * verdict is counted once, under the current page or else the newest copy; the others get `duplicateOf`.
 */
export function markVersionCopies(rows: VerdictRow[]): void {
  const occurrence = new Map<string, number>();
  const groups = new Map<string, VerdictRow[]>();
  for (const r of [...rows].sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)) {
    if (r.duplicateOf || r.sampled) continue;
    const onPage = `${r.repo}|${r.path}|${r.rule}|${r.subject}|${r.message}`;
    const n = occurrence.get(onPage) ?? 0;
    occurrence.set(onPage, n + 1);
    const key = `${r.repo}|${unversioned(r.path)}|${r.rule}|${r.subject}|${r.message}|${n}|${r.verdict}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let keep = list[0]!;
    for (const r of list) if (newer(versionRank(r.path), versionRank(keep.path))) keep = r;
    for (const r of list) if (r !== keep && unversioned(r.path) !== r.path) r.duplicateOf = keep.path;
  }
}

/**
 * A finding in a file that is a symbolic link to another file of the repository (CLAUDE.md -> AGENTS.md), with the
 * same rule, line and subject as a finding there, is one claim: mark it `duplicateOf` the target so the hall counts it
 * once. The links come from .ocean/drift-hall/links.json (`git ls-files -s` mode 120000 in each clone).
 */
export function markLinkedDuplicates(rows: VerdictRow[], file = join(DRIFT_DIR, 'links.json')): void {
  if (!existsSync(file)) return;
  const links = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
  const at = new Set(rows.map((r) => `${r.repo}|${r.path}|${r.rule}|${r.line}|${r.subject}`));
  for (const r of rows) {
    const target = links[r.repo]?.[r.path];
    if (target && !r.duplicateOf && at.has(`${r.repo}|${target}|${r.rule}|${r.line}|${r.subject}`)) r.duplicateOf = target;
  }
}

export function readVerdicts(file = join(DRIFT_DIR, 'verdicts.jsonl')): VerdictRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as VerdictRow);
}

function main(): void {
  // --held-out: the held-out set; --raw <dir>: judge a re-run's outputs (what a newer Staleproof reports) instead.
  const base = process.argv.includes('--held-out') ? HELD : HALL;
  const rawArg = process.argv.indexOf('--raw');
  const set: DriftSet = { ...base, rawDir: rawArg >= 0 ? process.argv[rawArg + 1]! : base.rawDir };
  const judgments = readJudgments(sourceFiles(set.dir));
  const todo = process.argv.indexOf('--todo');
  if (todo >= 0) {
    const repo = process.argv[todo + 1]!;
    const withInfo = process.argv.includes('--info');
    const { unjudged } = compile(judgments, set);
    const lint = loadLint(repo, set.rawDir);
    const list = withInfo ? (lint?.findings ?? []).filter((f) => f.severity === 'info') : (unjudged.get(repo) ?? []);
    for (const f of list) {
      const fix = f.fix ? ` FIX(${f.fix.verified ? 'verified' : 'hint'}): ${f.fix.description}` : '';
      console.log(`${f.severity[0]} ${f.rule} ${f.path}:${f.line}:${f.column} [${f.subject}] ${f.message}${fix}`);
    }
    return;
  }
  const { rows, unjudged, unused } = compile(judgments, set);
  if (set.rawDir === base.rawDir) writeFileSync(join(set.dir, 'verdicts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v && !r.sampled).length;
  console.log(`${set.rawDir === base.rawDir ? 'wrote' : 'judged (not written)'} ${join(set.dir, 'verdicts.jsonl').slice(DRIFT_DIR.length - 10)}: ${rows.length} rows (${count('confirmed')} confirmed, ${count('false-positive')} false positives, ${count('unclear')} unclear; ${rows.filter((r) => r.sampled).length} infos sampled)`);
  for (const j of unused) console.log(`unused judgment, ${j.file}:${j.line} (${j.repo})`);
  const linted = existsSync(set.rawDir) ? readdirSync(set.rawDir).filter((f) => f.endsWith('.lint.json')).length : 0;
  const left = [...unjudged.entries()].filter(([, fs]) => fs.length);
  console.log(`${linted} repositories linted; ${left.length} with unjudged warnings or errors`);
  for (const [repo, fs] of left) console.log(`  ${repo}: ${fs.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
