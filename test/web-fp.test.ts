import { join } from 'node:path';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/** The web's finding rows (0.8): a "False positive?" report link per finding, beta rules' findings last. */

interface WebFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path: string;
  line: number;
  surface: 'agent' | 'readme' | 'docs' | 'docstring' | 'example' | 'config';
  subject: string;
  fingerprint: string;
  evidence?: { looked: string; url?: string };
  repo?: string;
  lowerConfidence?: boolean;
}

// Imported by path at run time: the root tsconfig doesn't compile the web app's JSX.
const results = (await import(join(import.meta.dirname, '..', 'web', 'src', 'CheckResults.tsx'))) as {
  findingGroups: (findings: WebFinding[]) => [string, WebFinding[]][];
  reportUrl: (f: WebFinding, repo?: string) => string;
  LOWER_CONFIDENCE_TITLE: string;
};
const { findingGroups, LOWER_CONFIDENCE_TITLE, reportUrl } = results;

const f: WebFinding = {
  rule: 'link-broken',
  severity: 'error',
  message: 'The link target `x.md` does not exist.',
  path: 'README.md',
  line: 3,
  surface: 'readme',
  subject: 'x.md',
  fingerprint: 'a',
  repo: 'acme/app',
  evidence: { looked: 'files', url: `https://github.com/acme/app/blob/${'c'.repeat(40)}/README.md#L3` },
};

describe('web finding rows', () => {
  it('web: a report link per finding, beta findings last', () => {
    const u = new URL(reportUrl(f));
    expect(u.searchParams.get('repository')).toBe(`acme/app@${'c'.repeat(40)}`);
    expect(u.searchParams.get('location')).toBe('README.md:3');
    const groups = findingGroups([{ ...f, rule: 'env-unused', severity: 'info', lowerConfidence: true, fingerprint: 'b' }, f]);
    expect(groups.map(([t]) => t)).toEqual(['README and contributing guides', LOWER_CONFIDENCE_TITLE]);
    expect(LOWER_CONFIDENCE_TITLE).toBe('Lower confidence (beta rules)');
  });
});

// The audit page (0.8): beta findings and example lines are folded under one heading and counted nowhere.
const auditPage = (await import(join(import.meta.dirname, '..', 'web', 'src', 'Audit.tsx'))) as {
  AuditReport: FunctionComponent<{ repo: string; summary: string; data: unknown }>;
  AUDIT_LOWER_CONFIDENCE_TITLE: string;
};

describe('web audit page: lower confidence', () => {
  const SHA = 'd'.repeat(40);
  const finding = (rule: string, line: number, message: string, lowerConfidence?: boolean) => ({
    rule,
    severity: lowerConfidence ? 'info' : 'error',
    message,
    repo: 'acme/app',
    path: 'README.md',
    line,
    surface: 'readme',
    subject: `s${line}`,
    fingerprint: `${rule}-${line}`,
    evidence: { looked: 'files', url: `https://github.com/acme/app/blob/${SHA}/README.md#L${line}` },
    ...(lowerConfidence ? { lowerConfidence: true } : {}),
  });
  const mismatch = (line: number, kind: string, detail: string, lowerConfidence?: boolean) => ({
    example: `acme/app:docs/a.md:${line}`,
    url: `https://github.com/acme/app/blob/${SHA}/docs/a.md#L${line}`,
    repo: 'acme/app',
    path: 'docs/a.md',
    heading: 'Guide',
    line,
    kind,
    detail,
    call: 'c',
    symbol: 'app.c',
    ...(lowerConfidence ? { lowerConfidence: true } : {}),
  });
  const data = {
    org: 'gh-acme',
    repos: [{ name: 'acme/app', sha: SHA, symbols: 4, sections: 3, indexVersion: 4, findingsChecked: true }],
    outdatedIndex: false,
    score: 89,
    grade: 'B',
    deductions: [{ points: 3, why: 'Docs references: 1 error' }, { points: 8, why: '1 example calls the code in a way it no longer accepts' }],
    examples: { total: 3, python: 3, linked: 3, mismatched: 1 },
    mismatches: [mismatch(4, 'too-many-arguments', 'COUNTED MISMATCH'), mismatch(9, 'missing-import', 'BETA MISMATCH', true)],
    coverage: { api: 4, documented: 4, percent: 100 },
    undocumented: [],
    runs: [],
    runCounts: { pass: 0, fail: 0, skipped: 0, error: 0 },
    findings: [finding('path-missing', 2, 'TRUSTED FINDING'), finding('anchor-missing', 5, 'BETA FINDING', true)],
    findingCounts: { errors: 1, warnings: 0, infos: 1, byRule: {}, bySurface: { readme: 2 }, lowerConfidence: 1 },
    generatedAt: 0,
  };

  it('folds beta findings and mismatches under "Lower confidence (beta checks)", outside the chips', () => {
    const html = renderToStaticMarkup(createElement(auditPage.AuditReport, { repo: 'acme/app', summary: 's', data }));
    expect(auditPage.AUDIT_LOWER_CONFIDENCE_TITLE).toBe('Lower confidence (beta checks)');
    // The chips count the trusted ones only.
    expect(html).toMatch(/Docs references that no longer match the repository <span class="chip sev breaking">1<\/span>/);
    expect(html).toMatch(/Examples that no longer fit the code <span class="chip sev breaking">1 of 3<\/span>/);
    // One folded <details> (not open) holds both beta kinds, after the counted ones.
    const at = html.indexOf('<details class="changed lower-confidence">');
    expect(at).toBeGreaterThan(0);
    expect(html.match(/<details class="changed lower-confidence"[^>]*>/)![0]).not.toContain('open');
    expect(html.slice(at)).toContain('Lower confidence (beta checks)');
    for (const s of ['TRUSTED FINDING', 'COUNTED MISMATCH']) expect(html.indexOf(s)).toBeLessThan(at);
    for (const s of ['BETA FINDING', 'BETA MISMATCH']) expect(html.indexOf(s)).toBeGreaterThan(at);
    expect(html.slice(at)).toMatch(/Lower confidence \(beta checks\)<\/strong> <span class="muted">\(2\)<\/span>/);
  });

  it('with beta lines only, the counted lists say so and nothing is folded away silently', () => {
    const betaOnly = { ...data, examples: { ...data.examples, mismatched: 0 }, mismatches: [data.mismatches[1]], findings: [data.findings[1]] };
    const html = renderToStaticMarkup(createElement(auditPage.AuditReport, { repo: 'acme/app', summary: 's', data: betaOnly }));
    expect(html).toMatch(/Docs references that no longer match the repository <span class="chip ok">0<\/span>/);
    expect(html).toContain('the beta checks&#x27; lines are below, under Lower confidence.');
    expect(html).not.toContain('Every call in the 3 examples');
    expect(html.indexOf('BETA MISMATCH')).toBeGreaterThan(html.indexOf('<details class="changed lower-confidence">'));
  });
});
