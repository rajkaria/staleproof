/**
 * Summaries of the hand-checked verdicts for the precision record and the hand-off:
 *
 *   npx tsx scripts/drift-hall/report.ts
 *
 * Prints counts by rule and verdict and by repository, and writes .ocean/drift-hall/false-positives.tsv (every
 * false positive with its class, repo@sha, file:line, rule and reason) and .ocean/drift-hall/confirmed.tsv.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classOf } from './fp-classes.js';
import { CORPUS } from './repos.js';
import { compile, DRIFT_DIR, type VerdictRow } from './verdicts.js';

const { rows, unjudged } = compile();
const judged = rows.filter((r) => !r.sampled && !r.duplicateOf);
const key = (v: VerdictRow['verdict']) => (v === 'confirmed' ? 'C' : v === 'false-positive' ? 'FP' : 'U');

const table = (by: (r: VerdictRow) => string) => {
  const m = new Map<string, Record<'C' | 'FP' | 'U', number>>();
  for (const r of judged) {
    const k = by(r);
    const e = m.get(k) ?? { C: 0, FP: 0, U: 0 };
    e[key(r.verdict)]++;
    m.set(k, e);
  }
  return [...m.entries()].sort((a, b) => b[1].C + b[1].FP + b[1].U - (a[1].C + a[1].FP + a[1].U));
};
const pct = (e: { C: number; FP: number }) => (e.C + e.FP ? `${Math.round((100 * e.C) / (e.C + e.FP))}%` : '–');

console.log('| Rule | Confirmed | False positive | Unclear | Precision |\n|---|---|---|---|---|');
for (const [k, e] of table((r) => r.rule)) console.log(`| \`${k}\` | ${e.C} | ${e.FP} | ${e.U} | ${pct(e)} |`);
const all = judged.reduce((a, r) => (a[key(r.verdict)]++, a), { C: 0, FP: 0, U: 0 });
console.log(`| **all** | ${all.C} | ${all.FP} | ${all.U} | ${pct(all)} |\n`);

console.log('| Repo @ sha | Stars | Files | Confirmed | False positive | Unclear |\n|---|---|---|---|---|---|');
for (const r of CORPUS) {
  const mine = judged.filter((v) => v.repo === r.repo);
  const e = mine.reduce((a, v) => (a[key(v.verdict)]++, a), { C: 0, FP: 0, U: 0 });
  const left = unjudged.get(r.repo)?.length ?? 0;
  console.log(`| ${r.repo} @ ${r.sha.slice(0, 9)} | ${r.stars} | ${mine.length || left ? '' : '0 findings'} | ${e.C} | ${e.FP} | ${e.U}${left ? ` (+${left} unjudged)` : ''} |`);
}

console.log('\nFalse-positive classes:');
for (const [k, e] of table((r) => (r.verdict === 'false-positive' ? classOf(r).id : '-')).filter(([k]) => k !== '-')) console.log(`  ${k}: ${e.FP}`);

const tsv = (list: VerdictRow[], withClass: boolean) =>
  ['class\trepo\tsha\tfile\tline\trule\tsubject\treason']
    .concat(list.map((r) => [withClass ? classOf(r).id : 'confirmed', r.repo, r.sha.slice(0, 9), r.path, r.line, r.rule, r.subject.replace(/\s+/g, ' '), r.reason].join('\t')))
    .join('\n') + '\n';
writeFileSync(join(DRIFT_DIR, 'false-positives.tsv'), tsv(judged.filter((r) => r.verdict === 'false-positive').sort((a, b) => classOf(a).id.localeCompare(classOf(b).id) || a.repo.localeCompare(b.repo)), true));
writeFileSync(join(DRIFT_DIR, 'confirmed.tsv'), tsv(judged.filter((r) => r.verdict === 'confirmed'), false));
console.log(`\nwrote false-positives.tsv and confirmed.tsv (${all.FP} and ${all.C} rows); ${[...unjudged.values()].reduce((n, f) => n + f.length, 0)} warnings/errors unjudged`);

// Precision by rule and the repository's language, for rule maturity decisions (src/lint/maturity.ts).
const langOf = new Map(CORPUS.map((r) => [r.repo, r.language]));
console.log('\n| Rule | Python C/FP | TS/JS C/FP | Go C/FP |\n|---|---|---|---|');
for (const [rule] of table((r) => r.rule)) {
  const cell = (lang: string) => {
    const list = judged.filter((r) => r.rule === rule && langOf.get(r.repo) === lang);
    const c = list.filter((r) => r.verdict === 'confirmed').length;
    const fp = list.filter((r) => r.verdict === 'false-positive').length;
    return list.length ? `${c}/${fp} (${pct({ C: c, FP: fp })})` : '–';
  };
  console.log(`| \`${rule}\` | ${cell('python')} | ${cell('typescript')} | ${cell('go')} |`);
}
// Distinct causes: one per (repo, reason) pair, so a 450-link generated page counts once.
const causes = (v: VerdictRow['verdict']) => new Set(judged.filter((r) => r.verdict === v).map((r) => `${r.repo}|${r.reason}`)).size;
console.log(`\ndistinct causes: ${causes('confirmed')} confirmed, ${causes('false-positive')} false-positive, ${causes('unclear')} unclear`);
