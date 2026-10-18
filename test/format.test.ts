import { describe, expect, it } from 'vitest';
import { checkMarkdown, newFindingsMarkdown } from '../src/format/markdown.js';
import { FP_LINKS_BUDGET, FP_LINKS_MAX } from '../src/lint/format.js';
import type { Finding, LintSummary } from '../src/lint/types.js';
import type { ImpactData } from '../src/tools/graph-tools.js';

const impact: ImpactData = {
  pr: { url: 'https://github.com/acme/c/pull/1', title: 'x', repo: 'acme/c', state: 'merged', before: 'aaaaaaaaaa', after: 'bbbbbbbbbb', docsTouched: [] },
  changed: [{ symbol: 'c.Graph.ro_query', change: 'renamed', renamedTo: 'c.Graph.read_query' }],
  sections: [
    {
      section: 'acme/docs:a.mdx#reads', heading: 'Guide > Reads | queries', repo: 'acme/docs', path: 'a.mdx', url: 'https://github.com/acme/docs/blob/s/a.mdx#L3',
      severity: 'breaking', evidence: ['c.Graph.ro_query', 'acme/docs:a.mdx#reads'], hops: 1, confidence: 'exact',
      changes: [{ symbol: 'c.Graph.ro_query', change: 'renamed', before: 'def ro_query(self)', after: 'def read_query(self)' }], examples: [], crossRepo: true,
    },
  ],
  totalSections: 1,
  offset: 0,
  truncated: false,
  counts: { breaking: 1, api: 0, behavior: 0 },
  predicted: [],
  mismatched: [],
};

describe('checkMarkdown', () => {
  it('renders the PR comment', () => {
    const md = checkMarkdown({
      impact,
      summary: '1 changed symbols reach 1 doc sections.',
      cleared: [{ symbol: 'c.Graph._send', name: '_send', repo: 'acme/c', change: 'modified', visibility: 'private', textMatches: 0, grep: "git grep -nw _send -- '*.md' '*.mdx'" }],
      verdicts: [
        { section: 'acme/docs:a.mdx#reads', repo: 'acme/docs', path: 'a.mdx', heading: 'Guide > Reads | queries', lineno: 3, endLineno: 9, url: 'https://github.com/acme/docs/blob/s/a.mdx#L3', id: 'v1', verdict: 'stale', status: 'proposed', reason: 'ro_query was renamed.', newText: 'x', oldText: 'y', evidence: [], cites: [], runs: [] },
      ],
      org: 'acme',
    });
    expect(md).toBe(
      [
        '<!-- staleproof -->',
        '### Staleproof: 1 doc section this pull request can make false',
        '',
        '1 changed symbols reach 1 doc sections.',
        '',
        '| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |',
        '|---|---|---|---|---|',
        '| **breaking** | [Guide > Reads \\| queries](https://github.com/acme/docs/blob/s/a.mdx#L3) | acme/docs | `c.Graph.ro_query` ← `acme/docs:a.mdx#reads` | 1 (exact) |',
        '',
        '<details><summary>Cleared: 1 changed symbol(s) reach no doc within 3 call hops</summary>',
        '',
        "- `c.Graph._send` (modified) — 0 raw text matches in the docs; check with `git grep -nw _send -- '*.md' '*.mdx'`",
        '',
        '</details>',
        '',
        '#### Verdicts',
        '',
        '| Verdict | Section | Reason |',
        '|---|---|---|',
        '| stale | [Guide > Reads \\| queries](https://github.com/acme/docs/blob/s/a.mdx#L3) | ro_query was renamed. |',
        '',
        'Proposed edits: `npx staleproof patch https://github.com/acme/c/pull/1`',
        '',
        '<sub>[Staleproof](https://github.com/rajkaria/staleproof) · FalkorDB graph `acme` · aaaaaaa..bbbbbbb</sub>',
        '<!-- staleproof:counts breaks=0 predicted=0 sections=1 mismatched=0 -->',
      ].join('\n'),
    );
  });

  it('leads with the examples the pull request breaks, before and after', () => {
    const md = checkMarkdown({
      impact,
      summary: 's',
      cleared: [],
      runs: [
        { example: 'acme/docs:a.mdx:0', url: 'https://github.com/acme/docs/blob/s/a.mdx#L5', verdict: 'breaks', before: { status: 'pass', error: '', reason: '' }, after: { status: 'fail', error: "AttributeError: 'Graph' object has no attribute 'ro_query'", reason: '' } },
        { example: 'acme/docs:a.mdx:1', url: 'https://github.com/acme/docs/blob/s/a.mdx#L9', verdict: 'skipped', before: { status: 'skipped', error: '', reason: 'needs an LLM provider (OpenAI(); x)' } },
      ],
      org: 'acme',
    });
    const lines = md.split('\n');
    expect(lines[1]).toBe('### Staleproof: this pull request breaks 1 docs example');
    expect(md).toContain('| Example | Before (`aaaaaaa`) | After (`bbbbbbb`) | Result |');
    expect(md).toContain("| [a.mdx:0](https://github.com/acme/docs/blob/s/a.mdx#L5) | passes | `AttributeError: 'Graph' object has no attribute 'ro_query'` | **breaks**: passes before this PR, fails after |");
    expect(md).toContain('| [a.mdx:1](https://github.com/acme/docs/blob/s/a.mdx#L9) | skipped (needs an LLM provider (OpenAI(); x)) | — | not run |');
  });

  it('says so when no doc reaches the change', () => {
    const md = checkMarkdown({ impact: { ...impact, sections: [], totalSections: 0, counts: { breaking: 0, api: 0, behavior: 0 } }, summary: 's', cleared: [], org: 'acme' });
    expect(md.split('\n')[1]).toBe('### Staleproof: no docs reach the code this pull request changed');
  });

  it('says when the pull request edits the page of an example', () => {
    const md = checkMarkdown({
      impact: { ...impact, pr: { ...impact.pr, repo: 'acme/docs', docsTouched: ['a.mdx'] } },
      summary: 's',
      cleared: [],
      runs: [{ example: 'acme/docs:a.mdx:0', url: 'u', verdict: 'breaks', before: { status: 'pass', error: '', reason: '' }, after: { status: 'fail', error: 'E', reason: '' } }],
      org: 'acme',
    });
    expect(md.split('\n')[1]).toBe('### Staleproof: this pull request breaks 1 docs example');
    expect(md).toContain('**breaks**: passes before this PR, fails after (after: the page as this PR edits it) |');
    const fixed = checkMarkdown({ impact: { ...impact, pr: { ...impact.pr, repo: 'acme/docs', docsTouched: ['a.mdx'] } }, summary: 's', cleared: [], org: 'acme' });
    expect(fixed.split('\n')[1]).toBe('### Staleproof: the doc section this pull request reaches is on pages it edits');
    expect(md).toContain('(page edited in this PR)');
    expect(md).toContain(
      'This pull request also edits `a.mdx`: examples on those pages are run after the change as the pull request leaves them; the sections above are linked as they are on the default branch.',
    );
  });

  // Found in the GitHub App end-to-end run (2026-10-17): the App runs no example and its
  // report had no sections, yet it said examples were run and pointed at "the sections above".
  it('says only what applies to the pages the pull request edits', () => {
    const edits = { ...impact.pr, repo: 'acme/docs', docsTouched: ['README.md', 'a.mdx'] };
    const none = { sections: [], totalSections: 0, counts: { breaking: 0, api: 0, behavior: 0 } };
    const passes = { example: 'acme/docs:a.mdx:0', url: 'u', verdict: 'passes' as const, before: { status: 'pass' as const, error: '', reason: '' }, after: { status: 'pass' as const, error: '', reason: '' } };
    // Graph mode, no doc reached: no example ran, no section listed, nothing to say about the edited pages.
    const graphOnly = checkMarkdown({ impact: { ...impact, ...none, pr: edits }, summary: 's', cleared: [], org: 'acme' });
    expect(graphOnly).not.toContain('also edits');
    // A section on an edited page and no runs (graph mode, the GitHub App): the links note only.
    const sectionsOnly = checkMarkdown({ impact: { ...impact, pr: edits }, summary: 's', cleared: [], org: 'acme' });
    expect(sectionsOnly).toContain('This pull request also edits `README.md`, `a.mdx`: the sections above are linked as they are on the default branch.');
    expect(sectionsOnly).not.toContain('are run after the change');
    // A run on an edited page and no section listed: the runs note only.
    const runsOnly = checkMarkdown({ impact: { ...impact, ...none, pr: edits }, summary: 's', cleared: [], runs: [passes], org: 'acme' });
    expect(runsOnly).toContain('This pull request also edits `README.md`, `a.mdx`: examples on those pages are run after the change as the pull request leaves them.');
    expect(runsOnly).not.toContain('sections above');
    // Sections and runs only on pages the pull request does not edit: nothing to say about its edits.
    const elsewhere = checkMarkdown({ impact: { ...impact, pr: { ...edits, docsTouched: ['other.md'] } }, summary: 's', cleared: [], runs: [passes], org: 'acme' });
    expect(elsewhere).not.toContain('also edits');
  });
});

describe('newFindingsMarkdown', () => {
  const sha = 'b'.repeat(40);
  const finding: Finding = {
    rule: 'path-missing',
    severity: 'error',
    message: 'The file `docs/setup.md` does not exist.',
    repo: 'acme/app',
    path: 'AGENTS.md',
    line: 6,
    column: 23,
    endLine: 6,
    endColumn: 36,
    surface: 'agent',
    subject: 'docs/setup.md',
    evidence: { looked: 'files', url: `https://github.com/acme/app/blob/${sha}/AGENTS.md#L6` },
    fingerprint: 'f1',
  };
  const summary: LintSummary = { errors: 1, warnings: 0, infos: 0, files: 3, byRule: { 'path-missing': 1 }, bySurface: { agent: 1 }, ms: 1 };

  it('links each finding to the false-positive form, and shares nothing of a private repository', () => {
    const pf = { repo: 'acme/app', base: 'a'.repeat(40), head: sha, total: 1, fixed: 0, files: 3, ms: 1, findings: [finding], summary };
    expect(newFindingsMarkdown(pf)).toContain('[False positive?](https://github.com/rajkaria/staleproof/issues/new?template=false-positive.yml&');
    const priv = decodeURIComponent(newFindingsMarkdown(pf, 'this pull request', { private: true }));
    expect(priv).toContain('private repository (not shared)');
    expect(priv).not.toContain(`location=${finding.path}`);
  });

  it('a long comment: per-finding links on the first 20 findings, then one report line; the links never push it past GitHub\'s 65,536', () => {
    // 50 findings (the most a stored check keeps), each with a long message (about 300 characters).
    const many = Array.from({ length: 50 }, (_, i): Finding => ({
      ...finding,
      path: `docs/page-${i}.md`,
      line: i + 1,
      message: `The file \`docs/a-much-longer-path-${i}/${'nested/'.repeat(10)}setup.md\` does not exist; ${'it moved more than once, and the docs still name the old place. '.repeat(3)}`,
      evidence: { looked: 'files', url: `https://github.com/acme/app/blob/${sha}/docs/page-${i}.md#L${i + 1}` },
      fingerprint: `f${i}`,
    }));
    const pf = { repo: 'acme/app', base: 'a'.repeat(40), head: sha, total: 50, fixed: 0, files: 60, ms: 1, findings: many, summary: { ...summary, errors: 50 } };
    const md = newFindingsMarkdown(pf);
    const links = [...md.matchAll(/\[False positive\?\]\((https:[^)\s]+)\)/g)].map((m) => m[1]!);
    expect(FP_LINKS_MAX).toBe(20);
    expect(links).toHaveLength(20);
    // The first 20 findings in the order shown, and nothing after them.
    expect(links.map((u) => new URL(u).searchParams.get('location'))).toEqual(many.slice(0, 20).map((f) => `${f.path}:${f.line}`));
    expect(md.trimEnd().endsWith('<sub>False positive? [Report it](https://github.com/rajkaria/staleproof/issues/new?template=false-positive.yml).</sub>')).toBe(true);
    expect(md.match(/False positive\? \[Report it\]/g)).toHaveLength(1);
    expect(links.join('').length).toBeLessThanOrEqual(FP_LINKS_BUDGET);
    expect(md.length).toBeLessThan(65_536);
    // Worst case: links near the URL cap (a long path, a message of characters that encode to 9 each). The budget bounds what they add.
    const huge = many.map((f, i) => ({ ...f, path: `docs/${'deep/'.repeat(20)}page-${i}.md`, message: '中'.repeat(5000) }));
    const big = newFindingsMarkdown({ ...pf, findings: huge });
    const bigLinks = [...big.matchAll(/\[False positive\?\]\((https:[^)\s]+)\)/g)].map((m) => m[1]!);
    expect(bigLinks.length).toBeLessThan(20);
    expect(bigLinks.join('').length).toBeLessThanOrEqual(FP_LINKS_BUDGET);
    expect(big).toContain('False positive? [Report it]');
    // A short list keeps a link on every finding and no extra line.
    expect(newFindingsMarkdown({ ...pf, total: 3, findings: many.slice(0, 3) })).not.toContain('False positive? [Report it]');
  });
});
