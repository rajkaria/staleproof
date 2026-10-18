/**
 * The Drift Hall as a regression harness: lint the same commits with a newer Staleproof and compare its findings
 * with the hand-checked verdicts, by fingerprint (line-independent).
 *
 *   npx tsx scripts/drift-hall/run.ts --clones <dir> --no-fixes --raw /tmp/drift-next   # lint again with this checkout
 *   npx tsx scripts/drift-hall/compare.ts /tmp/drift-next [--json out.json]
 *
 * Reports, per rule and in total: false positives now gone (fixed), confirmed findings now gone (lost recall: a
 * regression unless the fix was meant to drop them), unclear ones gone, and new findings no verdict covers (to judge).
 * A rule whose subjects changed format shows up as both "gone" and "new"; read the lists before trusting the counts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, LintResult } from '../../src/lint/types.js';
import { classOf } from './fp-classes.js';
import { CORPUS } from './repos.js';
import { readVerdicts, slug, type VerdictRow } from './verdicts.js';

export interface Comparison {
  fixed: VerdictRow[];
  /** Still reported, but now at info level (a beta rule, or a check that lowers one finding's severity). */
  demoted: VerdictRow[];
  lost: VerdictRow[];
  unclearGone: VerdictRow[];
  fresh: (Finding & { repo: string })[];
  reposCompared: number;
}

/** Compare the verdicts with a re-run's raw lint outputs in `rawDir` (repositories missing there are skipped). */
export function compare(rawDir: string, verdicts: VerdictRow[] = readVerdicts()): Comparison {
  const out: Comparison = { fixed: [], demoted: [], lost: [], unclearGone: [], fresh: [], reposCompared: 0 };
  const judged = verdicts.filter((v) => !v.sampled);
  for (const r of CORPUS) {
    const f = join(rawDir, `${slug(r.repo)}.lint.json`);
    if (!existsSync(f)) continue;
    out.reposCompared++;
    const now = JSON.parse(readFileSync(f, 'utf8')) as LintResult;
    const seen = new Set(now.findings.map((x) => x.fingerprint));
    const info = new Set(now.findings.filter((x) => x.severity === 'info').map((x) => x.fingerprint));
    const mine = judged.filter((v) => v.repo === r.repo);
    const known = new Set(mine.map((v) => v.fingerprint));
    for (const v of mine) {
      if (info.has(v.fingerprint) && v.severity !== 'info') out.demoted.push(v);
      if (seen.has(v.fingerprint)) continue;
      if (v.verdict === 'false-positive') out.fixed.push(v);
      else if (v.verdict === 'confirmed') out.lost.push(v);
      else out.unclearGone.push(v);
    }
    for (const x of now.findings) if (x.severity !== 'info' && !known.has(x.fingerprint)) out.fresh.push({ ...x, repo: r.repo });
  }
  return out;
}

function main(): void {
  const rawDir = process.argv[2];
  if (!rawDir) throw new Error('usage: compare.ts <raw dir of a re-run> [--json out.json]');
  const c = compare(rawDir);
  const byRule = new Map<string, { fixed: number; lost: number; fresh: number; fpInfo: number; cInfo: number }>();
  const bump = (rule: string, k: 'fixed' | 'lost' | 'fresh' | 'fpInfo' | 'cInfo') => {
    const e = byRule.get(rule) ?? { fixed: 0, lost: 0, fresh: 0, fpInfo: 0, cInfo: 0 };
    e[k]++;
    byRule.set(rule, e);
  };
  for (const v of c.fixed) bump(v.rule, 'fixed');
  for (const v of c.lost) bump(v.rule, 'lost');
  for (const x of c.fresh) bump(x.rule, 'fresh');
  for (const v of c.demoted) if (v.verdict !== 'unclear') bump(v.rule, v.verdict === 'confirmed' ? 'cInfo' : 'fpInfo');
  console.log(`${c.reposCompared} repositories compared`);
  console.log('| Rule | False positives gone | False positives now info | Confirmed gone | Confirmed now info | New (unjudged) |\n|---|---|---|---|---|---|');
  for (const [rule, e] of [...byRule.entries()].sort()) console.log(`| \`${rule}\` | ${e.fixed} | ${e.fpInfo} | ${e.lost} | ${e.cInfo} | ${e.fresh} |`);
  const classes = new Map<string, number>();
  for (const v of c.fixed) classes.set(classOf(v).id, (classes.get(classOf(v).id) ?? 0) + 1);
  console.log(`\nfalse positives gone by class: ${[...classes.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  for (const v of c.lost.slice(0, 40)) console.log(`LOST ${v.repo} ${v.path}:${v.line} ${v.rule} [${v.subject}] ${v.reason}`);
  for (const x of c.fresh.slice(0, 40)) console.log(`NEW  ${x.repo} ${x.path}:${x.line} ${x.rule} [${x.subject}] ${x.message}`);
  const j = process.argv.indexOf('--json');
  if (j >= 0) writeFileSync(process.argv[j + 1]!, JSON.stringify(c, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
