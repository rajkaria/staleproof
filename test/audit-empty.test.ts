import { describe, expect, it } from 'vitest';
import { auditSummary, coverageSentence, examplesSentence, scoreAudit, type AuditData } from '../src/audit.js';
import { auditMarkdown, auditText } from '../src/format/audit.js';

/** An audit of a repository with nothing to measure: the live pmndrs/zustand audit of 0.6.1, before its entry points mapped to source. */
function emptyAudit(over: Partial<AuditData> = {}): AuditData {
  const examples = { total: 31, python: 0, linked: 0, mismatched: 0 };
  const coverage = { api: 0, documented: 0, percent: 0, unmeasured: 'js-entry-points' as const };
  const runCounts = { pass: 0, fail: 0, skipped: 0, error: 0 };
  const findingCounts = { errors: 0, warnings: 0, infos: 0, byRule: {}, bySurface: {} };
  const { score, grade, deductions } = scoreAudit({ examples, coverage, runCounts, findingCounts });
  return {
    org: 'pmndrs',
    repos: [{ name: 'pmndrs/zustand', sha: 'd7a5583aaaaaaa', symbols: 0, sections: 120, indexVersion: 4, findingsChecked: true }],
    outdatedIndex: false,
    score,
    grade,
    deductions,
    examples,
    mismatches: [],
    coverage,
    undocumented: [],
    runs: [],
    runCounts,
    findings: [],
    findingCounts,
    generatedAt: 0,
    ...over,
  };
}

const plain = (s: string) => s.replace(/\x1b\[\d+m/g, '');

describe('audit empty states', () => {
  it('scores no coverage deduction when there is no public API to measure', () => {
    const d = emptyAudit();
    expect(d.deductions.map((x) => x.why)).not.toContain(expect.stringMatching(/public symbols/));
    expect(d.score).toBe(100);
  });

  it('never says "All 0" or 100% when nothing was measured', () => {
    const d = emptyAudit();
    const summary = auditSummary(d);
    expect(summary).toBe(
      'Docs health 100/100 (A) for pmndrs/zustand. No docs example calls the code (31 examples read), so none was checked against it. ' +
        "API coverage is not measured: Staleproof found no exported symbols, because it could not map the TypeScript/JavaScript package's entry points " +
        '(package.json main, module, exports) to source files. Every docs reference lint checks (paths, links, commands, env vars) matches the repository. ' +
        'The score counts the docs references only.',
    );
    for (const out of [summary, plain(auditText(d, summary)), auditMarkdown(d, summary)]) {
      expect(out).not.toMatch(/All 0|\b0 of 0\b|100%|\(100\)/);
    }
  });

  it('says it plainly in the text report and the Markdown issue body, with a machine-readable "none"', () => {
    const d = emptyAudit();
    const summary = auditSummary(d);
    const text = plain(auditText(d, summary));
    expect(text).toContain('Examples that no longer fit the code\n  none checked: no docs example calls the code (31 examples read)');
    expect(text).toContain("API coverage: not measured\n  Staleproof found no exported symbols, because it could not map the TypeScript/JavaScript package's entry points");
    const md = auditMarkdown(d, summary);
    expect(md).toContain('No docs example calls the code (31 examples read), so none was checked against it.');
    expect(md).toContain('#### API coverage: not measured');
    expect(md).toMatch(/<!-- staleproof:audit score=100 mismatched=0 failing=0 coverage=none -->$/);
  });

  it('a repository with no code examples, or no API in another language', () => {
    const d = emptyAudit({ examples: { total: 0, python: 0, linked: 0, mismatched: 0 }, coverage: { api: 0, documented: 0, percent: 0, unmeasured: 'no-api' } });
    expect(examplesSentence(d)).toBe('The docs have no code examples to check.');
    expect(coverageSentence(d)).toBe('API coverage is not measured: Staleproof found no exported symbols in the indexed code.');
  });

  it('keeps the measured wording when there is something to measure', () => {
    const d = emptyAudit({
      examples: { total: 31, python: 0, linked: 12, mismatched: 0 },
      coverage: { api: 40, documented: 30, percent: 75 },
    });
    expect(examplesSentence(d)).toBe('All 12 examples that call the code fit it.');
    expect(coverageSentence(d)).toBe('30 of 40 public symbols (75%) are named or called by a doc.');
    expect(auditSummary(d)).not.toContain('The score counts');
  });

  it('one example that calls the code reads in the singular', () => {
    const d = emptyAudit({ examples: { total: 3, python: 3, linked: 1, mismatched: 0 } });
    expect(examplesSentence(d)).toBe('The 1 example that calls the code fits it.');
  });
});
