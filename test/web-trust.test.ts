import { join } from 'node:path';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * First-run trust on the web (0.7): an audit with nothing to measure never shows "0 of 0" or
 * 100%, and a check with nothing to report leads with one line, the cleared symbols folded under it.
 */

const root = join(import.meta.dirname, '..');
// Imported by path at run time: the root tsconfig doesn't compile the web app's JSX.
const audit = (await import(join(root, 'web', 'src', 'Audit.tsx'))) as {
  AuditReport: FunctionComponent<{ repo: string; summary: string; data: unknown }>;
  unmeasuredCoverage: (c: { api: number; documented: number; percent: number; unmeasured?: string }) => string | undefined;
};
const results = (await import(join(root, 'web', 'src', 'CheckResults.tsx'))) as {
  CheckResults: FunctionComponent<{ view: unknown; packageRepo: (q: string) => string | undefined }>;
  allClearLine: (impact: unknown, nf?: { total: number; fixed: number }) => string | undefined;
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const emptyAudit = {
  org: 'pmndrs',
  repos: [{ name: 'pmndrs/zustand', sha: 'd7a5583aaaa', symbols: 0, sections: 120, indexVersion: 4, findingsChecked: true }],
  outdatedIndex: false,
  score: 100,
  grade: 'A',
  deductions: [],
  examples: { total: 31, python: 0, linked: 0, mismatched: 0 },
  mismatches: [],
  coverage: { api: 0, documented: 0, percent: 0, unmeasured: 'js-entry-points' },
  undocumented: [],
  runs: [],
  runCounts: { pass: 0, fail: 0, skipped: 0, error: 0 },
  findings: [],
  generatedAt: 0,
};

describe('web audit: nothing to measure', () => {
  it('says no example calls the code and coverage is not measured, never 0 of 0 or 100%', () => {
    const html = renderToStaticMarkup(createElement(audit.AuditReport, { repo: 'pmndrs/zustand', summary: 's', data: emptyAudit }));
    const t = text(html);
    expect(t).toContain('none checked');
    expect(t).toContain('No docs example calls the code (31 examples read), so none was checked against it.');
    expect(t).toContain("Not measured. Staleproof found no exported symbols, because it could not map the TypeScript/JavaScript package's entry points");
    expect(t).not.toMatch(/0 of 0|100%|Every call in the 0/);
    expect(html).not.toContain('coverage-bar');
  });

  it('a measured audit keeps its bar and percentage', () => {
    const data = { ...emptyAudit, examples: { total: 31, python: 0, linked: 12, mismatched: 0 }, coverage: { api: 40, documented: 30, percent: 75 } };
    const t = text(renderToStaticMarkup(createElement(audit.AuditReport, { repo: 'pmndrs/zustand', summary: 's', data })));
    expect(t).toContain('0 of 12');
    expect(t).toContain('75% — 30 of 40 public symbols');
    expect(audit.unmeasuredCoverage({ api: 0, documented: 0, percent: 0 })).toBe('Staleproof found no exported symbols in the indexed code.');
  });
});

describe('web check: one-line all-clear', () => {
  const impact = {
    pr: { url: 'https://github.com/fastapi/typer/pull/1972', title: 'Refactor rich utils', repo: 'fastapi/typer', state: 'open', before: 'a'.repeat(40), after: 'b'.repeat(40), docsTouched: [] },
    changed: [
      { symbol: 'typer.rich_utils._get_help_text', change: 'modified' },
      { symbol: 'typer.rich_utils.rich_format_help', change: 'modified' },
      { symbol: 'typer.rich_utils._print_options_panel', change: 'modified' },
      { symbol: 'typer.rich_utils._print_commands_panel', change: 'modified' },
      { symbol: 'typer.rich_utils._make_rich_text', change: 'added' },
    ],
    sections: [],
    totalSections: 0,
    offset: 0,
    truncated: false,
    counts: { breaking: 0, api: 0, behavior: 0 },
    predicted: [],
    mismatched: [],
    newFindings: { base: 'a'.repeat(40), head: 'b'.repeat(40), findings: [], total: 0, fixed: 0, files: 112 },
  };
  const LONG = '4 changed symbols (and 1 added) reach 0 doc sections (0 breaking, 0 signature, 0 behavior; 0 in other repositories).';
  const view = {
    items: [],
    live: { text: '', thinking: '' },
    runs: {},
    verdicts: {},
    decisions: {},
    bodies: {},
    queued: false,
    pr: impact.pr.url,
    model: 'graph-only (no model)',
    impact,
    cleared: [{ symbol: 'typer.rich_utils.rich_format_help', name: 'rich_format_help', repo: 'fastapi/typer', change: 'modified', visibility: 'public', textMatches: 0, grep: "git grep -nw rich_format_help -- '*.md'" }],
    finished: { type: 'check_finished', checkId: 'c1', status: 'done', summary: LONG, steps: 4, toolCalls: 4, toolOrder: [], verdicts: 0, missing: [], usage: { input: 0, output: 0, cacheRead: 0 }, at: 0 },
  };

  it('a stored check from before 0.7 reads as one line, with the cleared symbols folded under it', () => {
    const html = renderToStaticMarkup(createElement(results.CheckResults, { view, packageRepo: () => undefined }));
    const t = text(html);
    expect(t).toContain('All clear: the 4 changed symbols reach no docs, and no docs reference became wrong.');
    expect(t).not.toContain('reach 0 doc sections');
    expect(t).not.toContain('Impacted doc sections (0)');
    expect(html).toMatch(/<details class="changed cleared-all"><summary>Cleared: 1 changed symbol reaches no doc within 3 call hops<\/summary>/);
    expect(t).toContain("git grep -nw rich_format_help -- '*.md'");
  });

  it('a check that found something keeps its summary and sections', () => {
    const found = { ...view, impact: { ...impact, newFindings: { ...impact.newFindings, total: 1 } } };
    const t = text(renderToStaticMarkup(createElement(results.CheckResults, { view: found, packageRepo: () => undefined })));
    expect(t).toContain(LONG);
    expect(t).toContain('Impacted doc sections (0)');
    expect(results.allClearLine(impact)).toBe('The 4 changed symbols reach no docs.');
  });
});
