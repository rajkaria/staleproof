/**
 * The shape of web/public/drift-hall.json (written by scripts/drift-hall/build.ts, read by web/src/DriftHall.tsx),
 * a validator the test runs on the committed file, and the page's pure helpers. No Node or DOM APIs: the web bundle
 * imports this file. Fields are only ever added.
 */

export type DriftVerdict = 'confirmed' | 'false-positive' | 'unclear';
export type PrStatus = 'drafted' | 'opened' | 'merged';

export interface VerdictCounts {
  confirmed: number;
  falsePositive: number;
  unclear: number;
}

/** A confirmed finding: drift a reader hits, checked by hand at the recorded commit. */
export interface HallFinding {
  /** The finding's fingerprint, first 12 hex digits (the same short form as `excluded`). */
  id: string;
  rule: string;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  message: string;
  /** Staleproof had a verified fix for it, and the fix was checked by hand too. */
  fixAvailable: boolean;
  /** https://github.com/<repo>/blob/<sha>/<file>#L<line> */
  permalink: string;
  /** Why it is drift: an index into the repository's `reasons` (the hand check's one-line reason). */
  why: number;
  /** How the re-run version (`precision.version`) reports it: at warning or error by default, at info (beta), not at all. */
  shownIn?: 'default' | 'beta' | 'gone' | 'not-rerun';
}

/** Precision of one Staleproof version on a set of repositories, by rule. */
export interface PrecisionView {
  version: string;
  byRule: Record<string, VerdictCounts>;
  total: VerdictCounts;
}

/** Repositories linted only after the guards were written: the precision to quote. */
export interface HeldOut extends PrecisionView {
  /** Findings of rules that are beta in the current maturity table (reported at info): not in `byRule`. */
  beta?: PrecisionView;
  resolvedAt: string;
  note: string;
  repos: (Omit<HallRepo, 'pr' | 'agentFiles'> & { agentFiles: string[] })[];
}

export interface HallRepo {
  repo: string;
  sha: string;
  stars: number;
  language: 'python' | 'typescript' | 'go';
  agentFiles: string[];
  /** Docs, READMEs and agent files Staleproof read. */
  filesChecked: number;
  /** Confirmed findings only. */
  findings: HallFinding[];
  /** The hand checks' reasons, shared by the findings with one cause. */
  reasons: string[];
  /** Every judged warning and error of this repository, by verdict. */
  counts: VerdictCounts;
  /** Short fingerprints (12 hex) of the findings judged false-positive or unclear: counted, never listed as drift. */
  excluded: string[];
  /** The upstream docs PR for the confirmed findings; null when there are none to offer. */
  pr: { status: PrStatus; url?: string; title?: string } | null;
}

export interface FalsePositiveClass {
  id: string;
  title: string;
  /** Findings of this class in the corpus (warnings and errors). */
  count: number;
  rules: string[];
  /** One example: repo@sha file:line. */
  example: string;
  status: 'open' | 'fixed';
  /** The Staleproof version that fixed it (all or part of it, see `fixed` and `demoted`). */
  fixedIn?: string;
  /** Findings of this class that version no longer reports. */
  fixed?: number;
  /** Findings of this class that version reports at info level only (a beta rule or a lowered finding). */
  demoted?: number;
}

export interface DriftHallData {
  generatedAt: string;
  staleproofVersion: string;
  corpus: { resolvedAt: string; repos: number; byLanguage: Record<'python' | 'typescript' | 'go', number> };
  totals: VerdictCounts & {
    repos: number;
    reposWithDrift: number;
    filesChecked: number;
    judged: number;
    /** Info-level findings read as a sample (not counted in precision). */
    infosSampled: number;
    /** False positives a later Staleproof no longer reports (`fixedIn` on their class says which). */
    falsePositivesFixed: number;
    /** False positives a later Staleproof reports at info level only. */
    falsePositivesDemoted?: number;
    prsDrafted: number;
    prsOpened: number;
    prsMerged: number;
    /** Distinct causes, one per repository and hand-check reason: a generated page of 450 wrong links is one. */
    causes: VerdictCounts;
  };
  repos: HallRepo[];
  /**
   * The default view: what `version` reports at warning or error (its default), judged; `beta` what it reports at info
   * only; `before` every warning and error of the first run (`before.version`), which the repos' counts and totals are.
   */
  precision: PrecisionView & {
    beta?: PrecisionView;
    before: PrecisionView;
    /** Repositories of the hall the `version` run did not cover (left out of `byRule`). */
    notRerun?: string[];
    note: string;
  };
  heldOut?: HeldOut;
  falsePositiveClasses: FalsePositiveClass[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCounts = (x: unknown): x is VerdictCounts =>
  isObj(x) && (['confirmed', 'falsePositive', 'unclear'] as const).every((k) => Number.isInteger(x[k]) && (x[k] as number) >= 0);

/** Every problem with `data` as a Drift Hall file, or [] when it is sound. */
export function validateDriftHall(data: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(data)) return ['not an object'];
  if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) errs.push('generatedAt is not a date');
  if (typeof data.staleproofVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(data.staleproofVersion)) errs.push('staleproofVersion is not a version');
  if (!Array.isArray(data.repos) || !data.repos.length) return [...errs, 'repos is empty'];
  if (!isObj(data.precision) || !isObj(data.precision.byRule)) errs.push('precision.byRule is missing');
  const sumRules = (v: unknown, at: string): VerdictCounts | undefined => {
    if (!isObj(v) || !isObj(v.byRule)) return void errs.push(`${at}.byRule is missing`);
    const t: VerdictCounts = { confirmed: 0, falsePositive: 0, unclear: 0 };
    for (const [rule, c] of Object.entries(v.byRule)) {
      if (!isCounts(c)) errs.push(`${at}.byRule.${rule}`);
      else for (const k of Object.keys(t) as (keyof VerdictCounts)[]) t[k] += c[k];
    }
    if (!isCounts(v.total)) errs.push(`${at}.total`);
    else for (const k of Object.keys(t) as (keyof VerdictCounts)[]) if (v.total[k] !== t[k]) errs.push(`${at}.total.${k} is not the sum of its rules`);
    return t;
  };
  const sum: VerdictCounts = { confirmed: 0, falsePositive: 0, unclear: 0 };
  const seen = new Set<string>();
  for (const r of data.repos as unknown[]) {
    if (!isObj(r)) {
      errs.push('a repo is not an object');
      continue;
    }
    const name = String(r.repo);
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) errs.push(`${name}: repo is not owner/name`);
    if (seen.has(name)) errs.push(`${name}: listed twice`);
    seen.add(name);
    if (typeof r.sha !== 'string' || !/^[0-9a-f]{40}$/.test(r.sha)) errs.push(`${name}: sha is not a full commit`);
    if (!Number.isInteger(r.stars)) errs.push(`${name}: stars is not a number`);
    if (!['python', 'typescript', 'go'].includes(String(r.language))) errs.push(`${name}: language ${String(r.language)}`);
    if (!Number.isInteger(r.filesChecked)) errs.push(`${name}: filesChecked is not a number`);
    if (!isCounts(r.counts)) errs.push(`${name}: counts`);
    else for (const k of Object.keys(sum) as (keyof VerdictCounts)[]) sum[k] += r.counts[k];
    if (!Array.isArray(r.excluded) || r.excluded.some((x) => typeof x !== 'string')) errs.push(`${name}: excluded`);
    if (r.pr !== null && !(isObj(r.pr) && ['drafted', 'opened', 'merged'].includes(String(r.pr.status)))) errs.push(`${name}: pr`);
    if (isObj(r.pr) && r.pr.status !== 'drafted' && typeof r.pr.url !== 'string') errs.push(`${name}: an opened or merged PR needs its url`);
    if (!Array.isArray(r.findings)) {
      errs.push(`${name}: findings`);
      continue;
    }
    if (isCounts(r.counts) && r.findings.length > r.counts.confirmed) errs.push(`${name}: more findings than confirmed verdicts`);
    if (r.findings.length && r.pr === null) errs.push(`${name}: confirmed findings but no PR entry`);
    for (const f of r.findings as unknown[]) {
      if (!isObj(f)) {
        errs.push(`${name}: a finding is not an object`);
        continue;
      }
      const at = `${name} ${String(f.file)}:${String(f.line)}`;
      for (const k of ['rule', 'file', 'message', 'permalink'] as const) if (typeof f[k] !== 'string' || !f[k]) errs.push(`${at}: ${k}`);
      if (!Number.isInteger(f.why) || !Array.isArray(r.reasons) || typeof r.reasons[f.why as number] !== 'string') errs.push(`${at}: why`);
      if (!['error', 'warning'].includes(String(f.severity))) errs.push(`${at}: severity`);
      if (!Number.isInteger(f.line) || (f.line as number) < 1) errs.push(`${at}: line`);
      if (typeof f.fixAvailable !== 'boolean') errs.push(`${at}: fixAvailable`);
      if (typeof f.id !== 'string' || !/^[0-9a-f]{12}$/.test(f.id)) errs.push(`${at}: id`);
      else if (Array.isArray(r.excluded) && r.excluded.includes(f.id)) errs.push(`${at}: judged false-positive or unclear, but listed as drift`);
      const want = `https://github.com/${name}/blob/${String(r.sha)}/${String(f.file)}#L${String(f.line)}`;
      if (f.permalink !== want) errs.push(`${at}: permalink is not ${want}`);
    }
  }
  if (isObj(data.totals)) {
    for (const k of Object.keys(sum) as (keyof VerdictCounts)[]) if (data.totals[k] !== sum[k]) errs.push(`totals.${k} ${String(data.totals[k])} is not the repos' sum ${sum[k]}`);
    if (data.totals.repos !== data.repos.length) errs.push('totals.repos is not the number of repos');
  } else errs.push('totals is missing');
  if (isObj(data.precision)) {
    sumRules(data.precision, 'precision');
    if (data.precision.beta !== undefined) sumRules(data.precision.beta, 'precision.beta');
    const before = sumRules(data.precision.before, 'precision.before');
    if (before) for (const k of Object.keys(sum) as (keyof VerdictCounts)[]) if (before[k] !== sum[k]) errs.push(`precision.before ${k} sums to ${before[k]}, the repos to ${sum[k]}`);
    if (typeof data.precision.version !== 'string') errs.push('precision.version');
    if (typeof data.precision.note !== 'string' || !data.precision.note) errs.push('precision.note');
  }
  if (data.heldOut !== undefined) {
    const h = data.heldOut;
    const main = sumRules(h, 'heldOut');
    const hb = isObj(h) && h.beta !== undefined ? sumRules(h.beta, 'heldOut.beta') : undefined;
    const t = main && { confirmed: main.confirmed + (hb?.confirmed ?? 0), falsePositive: main.falsePositive + (hb?.falsePositive ?? 0), unclear: main.unclear + (hb?.unclear ?? 0) };
    if (!isObj(h) || !Array.isArray(h.repos)) errs.push('heldOut.repos');
    else {
      const held: VerdictCounts = { confirmed: 0, falsePositive: 0, unclear: 0 };
      for (const r of h.repos as unknown[]) {
        if (!isObj(r) || !isCounts(r.counts) || !Array.isArray(r.findings) || !Array.isArray(r.excluded)) {
          errs.push('heldOut: a repo');
          continue;
        }
        for (const k of Object.keys(held) as (keyof VerdictCounts)[]) held[k] += r.counts[k];
        for (const f of r.findings as { id?: string; permalink?: string; file?: string; line?: number }[]) {
          if (typeof f.id === 'string' && (r.excluded as string[]).includes(f.id)) errs.push(`heldOut ${String(r.repo)} ${String(f.file)}:${String(f.line)}: judged false-positive or unclear, but listed as drift`);
          if (f.permalink !== `https://github.com/${String(r.repo)}/blob/${String(r.sha)}/${String(f.file)}#L${String(f.line)}`) errs.push(`heldOut ${String(r.repo)}: permalink`);
        }
        if ((r.findings as unknown[]).length > r.counts.confirmed) errs.push(`heldOut ${String(r.repo)}: more findings than confirmed verdicts`);
      }
      if (t) for (const k of Object.keys(held) as (keyof VerdictCounts)[]) if (held[k] !== t[k]) errs.push(`heldOut ${k}: repos ${held[k]}, rules (default and beta) ${t[k]}`);
    }
  }
  if (!Array.isArray(data.falsePositiveClasses)) errs.push('falsePositiveClasses is missing');
  return errs;
}

/** Precision: confirmed out of everything decided (unclear verdicts left out), as a whole percent. */
export const precisionOf = (c: VerdictCounts): number | undefined =>
  c.confirmed + c.falsePositive ? Math.round((100 * c.confirmed) / (c.confirmed + c.falsePositive)) : undefined;

/** The findings of one repository grouped by the hand check's reason, largest group first. */
export function groupByReason(r: Pick<HallRepo, 'findings' | 'reasons'>): { why: string; findings: HallFinding[] }[] {
  const groups = new Map<number, HallFinding[]>();
  for (const f of r.findings) groups.set(f.why, [...(groups.get(f.why) ?? []), f]);
  return [...groups.entries()].map(([i, findings]) => ({ why: r.reasons[i] ?? '', findings })).sort((a, b) => b.findings.length - a.findings.length);
}
