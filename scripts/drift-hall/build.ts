/**
 * Writes web/public/drift-hall.json from the corpus, the raw lint outputs and the hand-checked verdicts:
 *
 *   npx tsx scripts/drift-hall/verdicts.ts && npx tsx scripts/drift-hall/build.ts [--interim <preview.json>]
 *     [--next <raw dir of a re-run> --next-version 0.8.0]
 *
 * Only confirmed findings are listed as findings. False positives and unclear verdicts are counted (per repository
 * and per rule) and named by short fingerprint, never listed as drift. A finding in a file that is a link to another
 * (CLAUDE.md -> AGENTS.md) is counted once.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classOf, FP_CLASSES, OTHER } from './fp-classes.js';
import { PRS } from './prs.js';
import { CORPUS, RESOLVED_AT } from './repos.js';
import { validateDriftHall, type DriftHallData, type FalsePositiveClass, type HallFinding, type HallRepo, type HeldOut, type PrecisionView, type VerdictCounts } from './schema.js';
import { compare, type Comparison } from './compare.js';
import { maturityOf } from '../../src/lint/maturity.js';
import type { RuleId } from '../../src/lint/types.js';
import { HELD_OUT_RESOLVED_AT } from './heldout.js';
import { compile, DRIFT_DIR, HALL, HELD, loadLint, readJudgments, slug, sourceFiles, type VerdictRow } from './verdicts.js';

const root = join(import.meta.dirname, '..', '..');
const SURFACE_ORDER = ['agent', 'readme', 'docs', 'example', 'docstring', 'config'];

const zero = (): VerdictCounts => ({ confirmed: 0, falsePositive: 0, unclear: 0 });
const bump = (c: VerdictCounts, v: VerdictRow['verdict']) => {
  if (v === 'confirmed') c.confirmed++;
  else if (v === 'false-positive') c.falsePositive++;
  else c.unclear++;
};

/** Distinct causes of a verdict: one per repository and hand-check reason. */
const causes = (rows: VerdictRow[], v: VerdictRow['verdict']) => new Set(rows.filter((r) => r.verdict === v).map((r) => `${r.repo}|${r.reason}`)).size;

/** The draft PR's title: the first `# ` heading of .ocean/drift-hall/patches/<slug>.md. */
function draftTitle(repo: string): string | undefined {
  const f = join(DRIFT_DIR, 'patches', `${slug(repo)}.md`);
  if (!existsSync(f)) return undefined;
  return /^#\s+(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1]?.trim();
}

/** A re-run of the same commits by a newer Staleproof: its judged warnings and errors, and the raw outputs. */
export interface NextRun {
  version: string;
  dir: string;
  result: Comparison;
  /** Verdict rows of what it reports at warning or error (compiled against its raw outputs). */
  shown: VerdictRow[];
}

const view = (version: string, rows: VerdictRow[]): PrecisionView => {
  const byRule: Record<string, VerdictCounts> = {};
  const total = zero();
  for (const v of rows) {
    bump((byRule[v.rule] ??= zero()), v.verdict);
    bump(total, v.verdict);
  }
  return { version, byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => a[0].localeCompare(b[0]))), total };
};

/** The baseline run's version, as its raw outputs record it. */
function rawVersion(rawDir: string, repos: { repo: string }[]): string {
  for (const r of repos) {
    const v = (loadLint(r.repo, rawDir) as { tool?: { version?: string } } | undefined)?.tool?.version;
    if (v) return v;
  }
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

export function buildHall(
  rows: VerdictRow[],
  opts: { now?: Date; interim?: boolean; next?: NextRun; heldOut?: { version: string; rows: VerdictRow[] } } = {},
): DriftHallData {
  const now = opts.now ?? new Date();
  const version = rawVersion(HALL.rawDir, CORPUS);
  const judged = rows.filter((r) => !r.sampled && !r.duplicateOf);
  // How the re-run reports each judged finding, by fingerprint: warning/error (default), info (beta) or not at all.
  const nextSeverity = new Map<string, string>();
  const rerun = new Set<string>();
  if (opts.next) {
    for (const r of CORPUS) {
      const lint = loadLint(r.repo, opts.next.dir);
      if (!lint) continue;
      rerun.add(r.repo);
      for (const f of lint.findings) nextSeverity.set(`${r.repo}|${f.fingerprint}`, f.severity);
    }
  }
  const shownIn = (v: VerdictRow): HallFinding['shownIn'] => {
    if (!opts.next) return undefined;
    if (!rerun.has(v.repo)) return 'not-rerun';
    const sev = nextSeverity.get(`${v.repo}|${v.fingerprint}`);
    return sev === undefined ? 'gone' : sev === 'info' || isBeta(v.rule) ? 'beta' : 'default';
  };
  const repos: HallRepo[] = [];
  const byRule: Record<string, VerdictCounts> = {};
  for (const r of CORPUS) {
    const lint = loadLint(r.repo);
    if (!lint) continue;
    const mine = judged.filter((v) => v.repo === r.repo);
    const counts = zero();
    for (const v of mine) {
      bump(counts, v.verdict);
      bump((byRule[v.rule] ??= zero()), v.verdict);
    }
    const reasons: string[] = [];
    const reasonOf = (why: string) => (reasons.includes(why) ? reasons.indexOf(why) : reasons.push(why) - 1);
    const findings = mine
      .filter((v) => v.verdict === 'confirmed')
      .sort((a, b) => SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface) || a.path.localeCompare(b.path) || a.line - b.line)
      .map((v) => ({
        id: v.fingerprint.slice(0, 12),
        rule: v.rule,
        severity: v.severity as 'error' | 'warning',
        file: v.path,
        line: v.line,
        message: v.message,
        fixAvailable: !!(v.fix?.verified && v.fix.correct === true),
        permalink: `https://github.com/${r.repo}/blob/${r.sha}/${v.path}#L${v.line}`,
        why: reasonOf(v.reason),
        ...(opts.next ? { shownIn: shownIn(v) } : {}),
      }));
    const known = PRS[r.repo];
    const title = known?.title ?? draftTitle(r.repo);
    if (findings.length && !known && !title && !opts.interim) throw new Error(`${r.repo} has ${findings.length} confirmed findings but no PR draft (.ocean/drift-hall/patches/${slug(r.repo)}.md)`);
    repos.push({
      repo: r.repo,
      sha: r.sha,
      stars: r.stars,
      language: r.language,
      agentFiles: r.agentFiles,
      filesChecked: lint.summary.files,
      findings,
      reasons,
      counts,
      excluded: mine.filter((v) => v.verdict !== 'confirmed').map((v) => v.fingerprint.slice(0, 12)),
      pr: findings.length ? { status: known?.status ?? 'drafted', ...(known?.url ? { url: known.url } : {}), ...(title ? { title } : {}) } : null,
    });
  }
  repos.sort((a, b) => b.stars - a.stars);

  // With a re-run by a newer Staleproof on the same commits (compare.ts): which false positives it no longer reports
  // as warnings or errors, gone or lowered to info.
  const key = (v: { repo: string; fingerprint: string }) => `${v.repo}|${v.fingerprint}`;
  const gone = new Set((opts.next?.result.fixed ?? []).map(key));
  const lowered = new Set((opts.next?.result.demoted ?? []).filter((v) => v.verdict === 'false-positive').map(key));
  const classes = new Map<string, FalsePositiveClass>();
  let fixed = 0;
  let demoted = 0;
  for (const v of judged.filter((x) => x.verdict === 'false-positive')) {
    const c = classOf(v);
    const entry = classes.get(c.id) ?? { id: c.id, title: c.title, count: 0, rules: [], example: `${v.repo}@${v.sha.slice(0, 9)} ${v.path}:${v.line}`, status: c.status, ...(c.fixedIn ? { fixedIn: c.fixedIn } : {}) };
    entry.count++;
    if (!entry.rules.includes(v.rule)) entry.rules.push(v.rule);
    if (gone.has(key(v))) {
      entry.fixed = (entry.fixed ?? 0) + 1;
      fixed++;
    } else if (lowered.has(key(v))) {
      entry.demoted = (entry.demoted ?? 0) + 1;
      demoted++;
    } else if (c.status === 'fixed') fixed++;
    classes.set(c.id, entry);
  }
  if (opts.next) {
    for (const e of classes.values()) {
      if ((e.fixed ?? 0) + (e.demoted ?? 0) > 0) e.fixedIn = opts.next.version;
      if ((e.fixed ?? 0) === e.count) e.status = 'fixed';
    }
  }
  const order = [...FP_CLASSES, OTHER].map((c) => c.id);
  const sum = (k: keyof VerdictCounts) => repos.reduce((n, r) => n + r.counts[k], 0);
  const byLanguage = { python: 0, typescript: 0, go: 0 };
  for (const r of CORPUS) byLanguage[r.language]++;
  return {
    generatedAt: now.toISOString(),
    staleproofVersion: version,
    corpus: { resolvedAt: RESOLVED_AT, repos: CORPUS.length, byLanguage },
    totals: {
      repos: repos.length,
      reposWithDrift: repos.filter((r) => r.findings.length).length,
      filesChecked: repos.reduce((n, r) => n + r.filesChecked, 0),
      judged: judged.length,
      confirmed: sum('confirmed'),
      falsePositive: sum('falsePositive'),
      unclear: sum('unclear'),
      infosSampled: rows.filter((r) => r.sampled).length,
      falsePositivesFixed: fixed,
      falsePositivesDemoted: demoted,
      prsDrafted: repos.filter((r) => r.pr?.status === 'drafted').length,
      prsOpened: repos.filter((r) => r.pr?.status === 'opened').length,
      prsMerged: repos.filter((r) => r.pr?.status === 'merged').length,
      causes: {
        confirmed: causes(judged, 'confirmed'),
        falsePositive: causes(judged, 'false-positive'),
        unclear: causes(judged, 'unclear'),
      },
    },
    repos,
    precision: precisionViews(judged, version, opts.next, rerun),
    ...(opts.heldOut ? { heldOut: heldOutSection(opts.heldOut.version, opts.heldOut.rows) } : {}),
    falsePositiveClasses: [...classes.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
  };
}

/** A rule the current maturity table (src/lint/maturity.ts) marks beta: it reports at info, lower confidence. */
const isBeta = (rule: string) => maturityOf(rule as RuleId) === 'beta';

const NOTE =
  'The guards were written against these same repositories (for 0.8.0, 2026-10-18), so the hall after them measures how well they fit this corpus; the held-out set, linted only after the guards, is the precision to quote. Default and beta follow the current rule maturity table (src/lint/maturity.ts): a finding of a rule that is beta there counts as beta even where the re-run, linted before that rule moved to beta, reported it at warning or error; nothing was re-linted for it.';

function precisionViews(judged: VerdictRow[], baseline: string, next: NextRun | undefined, rerun: Set<string>): DriftHallData['precision'] {
  const before = view(baseline, judged);
  if (!next) return { ...before, before, note: 'Every warning and error of this run, hand-checked.' };
  const reported = next.shown.filter((v) => !v.sampled && !v.duplicateOf);
  const shown = reported.filter((v) => !isBeta(v.rule));
  const severity = new Map<string, string>();
  for (const repo of rerun) for (const f of loadLint(repo, next.dir)?.findings ?? []) severity.set(`${repo}|${f.fingerprint}`, f.severity);
  const beta = judged.filter((v) => {
    const sev = rerun.has(v.repo) ? severity.get(`${v.repo}|${v.fingerprint}`) : undefined;
    return sev === 'info' || (sev !== undefined && isBeta(v.rule));
  });
  const notRerun = CORPUS.filter((r) => loadLint(r.repo) && !rerun.has(r.repo)).map((r) => r.repo);
  return { ...view(next.version, shown), beta: view(next.version, beta), before, ...(notRerun.length ? { notRerun } : {}), note: NOTE };
}

function heldOutSection(version: string, rows: VerdictRow[]): HeldOut {
  const judged = rows.filter((r) => !r.sampled && !r.duplicateOf);
  const repos: HeldOut['repos'] = [];
  for (const r of HELD.corpus) {
    const lint = loadLint(r.repo, HELD.rawDir);
    if (!lint) continue;
    const mine = judged.filter((v) => v.repo === r.repo);
    const counts = zero();
    for (const v of mine) bump(counts, v.verdict);
    const reasons: string[] = [];
    const reasonOf = (why: string) => (reasons.includes(why) ? reasons.indexOf(why) : reasons.push(why) - 1);
    repos.push({
      repo: r.repo,
      sha: r.sha,
      stars: r.stars,
      language: r.language,
      agentFiles: r.agentFiles,
      filesChecked: lint.summary.files,
      counts,
      findings: mine
        .filter((v) => v.verdict === 'confirmed')
        .map((v) => ({
          id: v.fingerprint.slice(0, 12),
          rule: v.rule,
          severity: v.severity as 'error' | 'warning',
          file: v.path,
          line: v.line,
          message: v.message,
          fixAvailable: false,
          permalink: `https://github.com/${r.repo}/blob/${r.sha}/${v.path}#L${v.line}`,
          why: reasonOf(v.reason),
        })),
      reasons,
      excluded: mine.filter((v) => v.verdict !== 'confirmed').map((v) => v.fingerprint.slice(0, 12)),
    });
  }
  repos.sort((a, b) => b.stars - a.stars);
  return {
    ...view(version, judged.filter((v) => !isBeta(v.rule))),
    beta: view(version, judged.filter((v) => isBeta(v.rule))),
    resolvedAt: HELD_OUT_RESOLVED_AT,
    note: 'Popular repositories in none of the hall, the earlier precision runs or the maturity sweep, pinned and linted only after the guards were written; every warning and error hand-checked. This is the precision to quote. Rules beta in the current maturity table (path-missing and line-out-of-range moved there after this check) are shown apart.',
    repos,
  };
}

function main(): void {
  if (!sourceFiles().length) throw new Error('no verdicts: .ocean/drift-hall/verdicts.src is missing (the hand checks live there, locally)');
  const { rows, unjudged } = compile();
  const left = [...unjudged.values()].reduce((n, fs) => n + fs.length, 0);
  // --interim <file>: a preview while verdicts and drafts are still being written (never web/public).
  const interim = process.argv.includes('--interim') ? process.argv[process.argv.indexOf('--interim') + 1] : undefined;
  // --next <raw dir> --next-version <v>: a re-run of run.ts (--raw) by a newer Staleproof on the same commits; the
  // false positives it no longer reports as warnings or errors are counted as fixed (or lowered to info) in <v>.
  const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const nextDir = arg('--next');
  let next: NextRun | undefined;
  if (nextDir) {
    const nextVersion = arg('--next-version') ?? 'the next version';
    const compiled = compile(readJudgments(), { ...HALL, rawDir: nextDir });
    const open = [...compiled.unjudged.values()].reduce((n, fs) => n + fs.length, 0);
    if (open && !interim) throw new Error(`--next: ${open} warnings/errors of the re-run are not judged (npx tsx scripts/drift-hall/verdicts.ts --raw ${nextDir})`);
    next = { version: nextVersion, dir: nextDir, result: compare(nextDir, rows), shown: compiled.rows };
    console.log(`--next: ${next.result.reposCompared} repositories re-linted; ${next.result.fixed.length} false positives gone, ${next.result.demoted.filter((v) => v.verdict === 'false-positive').length} lowered to info; ${next.result.lost.length} confirmed findings gone (check them)`);
  }
  // The held-out set, when its verdicts exist (.ocean/drift-hall/held-out/).
  let heldOut: { version: string; rows: VerdictRow[] } | undefined;
  if (sourceFiles(HELD.dir).length) {
    const held = compile(readJudgments(sourceFiles(HELD.dir)), HELD);
    const open = [...held.unjudged.values()].reduce((n, fs) => n + fs.length, 0);
    if (open && !interim) throw new Error(`held-out: ${open} warnings/errors are not judged (npx tsx scripts/drift-hall/verdicts.ts --held-out)`);
    // The held-out set is linted by the same working tree as --next; it carries that label when one is given.
    heldOut = { version: arg('--next-version') ?? rawVersion(HELD.rawDir, HELD.corpus), rows: held.rows };
  }
  const data = buildHall(rows, { interim: !!interim, next, heldOut });
  const errs = validateDriftHall(data);
  if (errs.length) throw new Error(`drift-hall.json would be invalid:\n${errs.join('\n')}`);
  const out = interim ?? join(root, 'web', 'public', 'drift-hall.json');
  writeFileSync(out, `${JSON.stringify(data)}\n`);
  const t = data.totals;
  console.log(
    `wrote ${out}: ${t.repos} repos, ${t.judged} judged (${t.confirmed} confirmed, ${t.falsePositive} false positives, ${t.unclear} unclear), ${t.reposWithDrift} with drift, ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`,
  );
  if (left) console.log(`warning: ${left} warnings/errors are not judged yet (npx tsx scripts/drift-hall/verdicts.ts lists them)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
