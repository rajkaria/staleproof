import { describe, expect, it } from 'vitest';
import { allClearLine, type PrFindings } from '../src/agent/graph-check.js';
import { checkMarkdown } from '../src/format/markdown.js';
import { allClearText } from '../src/format/text.js';
import type { ClearedSymbol, ImpactData } from '../src/tools/graph-tools.js';

/** fastapi/typer#1972 in graph mode: 4 changed symbols and 1 added, no doc section reached, no docs reference made wrong. */
function typerImpact(over: Partial<ImpactData> = {}): ImpactData {
  return {
    pr: { url: 'https://github.com/fastapi/typer/pull/1972', title: 'Refactor rich utils', repo: 'fastapi/typer', state: 'open', before: 'a'.repeat(40), after: 'b'.repeat(40), docsTouched: [] },
    changed: [
      { symbol: 'typer.rich_utils._get_help_text', change: 'modified' },
      { symbol: 'typer.rich_utils._print_options_panel', change: 'modified' },
      { symbol: 'typer.rich_utils._print_commands_panel', change: 'modified' },
      { symbol: 'typer.rich_utils.rich_format_help', change: 'modified' },
      { symbol: 'typer.rich_utils._make_rich_text', change: 'added' },
    ],
    sections: [],
    totalSections: 0,
    offset: 0,
    truncated: false,
    counts: { breaking: 0, api: 0, behavior: 0 },
    predicted: [],
    mismatched: [],
    ...over,
  };
}

const cleared: ClearedSymbol[] = ['_get_help_text', '_print_options_panel', '_print_commands_panel', 'rich_format_help'].map((name) => ({
  symbol: `typer.rich_utils.${name}`,
  name,
  repo: 'fastapi/typer',
  change: 'modified',
  visibility: name.startsWith('_') ? 'private' : 'public',
  textMatches: 0,
  grep: `git grep -nw ${name} -- '*.md' '*.mdx' '*.rst'`,
}));

const nf = (over: Partial<PrFindings> = {}): PrFindings => ({
  repo: 'fastapi/typer',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  findings: [],
  total: 0,
  fixed: 0,
  summary: { errors: 0, warnings: 0, infos: 0, files: 112, byRule: {}, bySurface: {}, ms: 1 },
  files: 112,
  ms: 1,
  ...over,
});

/** The two sentences 0.6.1 printed as the headline on fastapi/typer#1972. */
const LONG =
  '4 changed symbols (and 1 added) reach 0 doc sections (0 breaking, 0 signature, 0 behavior; 0 in other repositories). ' +
  '4 changed symbols reach no doc within 3 hops (4 also have zero text matches in the docs; 0 share a name with text in the docs but no path resolves to them).';

describe('one-line all-clear', () => {
  it('says it in one plain line when nothing is reached and no docs reference became wrong', () => {
    expect(allClearLine(typerImpact(), nf())).toBe('All clear: the 4 changed symbols reach no docs, and no docs reference became wrong.');
    expect(allClearLine(typerImpact(), nf({ fixed: 2 }))).toBe('All clear: the 4 changed symbols reach no docs, and no docs reference became wrong (2 fixed).');
    expect(allClearLine(typerImpact({ changed: [{ symbol: 'typer.main.run', change: 'signature' }] }), nf())).toBe(
      'All clear: the changed symbol reaches no docs, and no docs reference became wrong.',
    );
  });

  it('only adds symbols, or touches none', () => {
    expect(allClearLine(typerImpact({ changed: [{ symbol: 'a.b', change: 'added' }, { symbol: 'a.c', change: 'added' }] }), nf())).toBe(
      'All clear: this pull request only adds new symbols (2), which cannot make an existing doc false, and no docs reference became wrong.',
    );
    expect(allClearLine(typerImpact({ changed: [] }), nf())).toBe('All clear: this pull request touches no Python, TypeScript or JavaScript symbol, and no docs reference became wrong.');
    const local = typerImpact({ changed: [], pr: { ...typerImpact().pr, state: 'local' } });
    expect(allClearLine(local, nf())).toBe('All clear: these changes touch no Python, TypeScript or JavaScript symbol, and no docs reference became wrong.');
  });

  it('claims nothing about docs references it did not check', () => {
    expect(allClearLine(typerImpact())).toBe('The 4 changed symbols reach no docs.');
  });

  it('is no all-clear when anything is reached, predicted, already mismatched or made wrong', () => {
    const section = { section: 'fastapi/typer:docs/a.md#x', heading: 'X', repo: 'fastapi/typer', path: 'docs/a.md', url: 'u', severity: 'behavior' as const, evidence: [], hops: 1, confidence: 'exact' as const, changes: [], examples: [], crossRepo: false };
    expect(allClearLine(typerImpact({ sections: [section], totalSections: 1 }), nf())).toBeUndefined();
    expect(allClearLine(typerImpact({ predicted: [{ example: 'e', url: 'u', line: 1, call: 'c', detail: 'd', confidence: 'exact' } as never] }), nf())).toBeUndefined();
    expect(allClearLine(typerImpact({ mismatched: [{ example: 'e', url: 'u', line: 1, detail: 'd' } as never] }), nf())).toBeUndefined();
    expect(allClearLine(typerImpact(), nf({ total: 1 }))).toBeUndefined();
  });

  it('the PR comment leads with the line and keeps the cleared list collapsed below it', () => {
    const md = checkMarkdown({ impact: typerImpact(), summary: LONG, cleared, org: 'fastapi', newFindings: nf() });
    const lines = md.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '<!-- staleproof -->',
      '### Staleproof: no docs reach the code this pull request changed',
      '',
      'All clear: the 4 changed symbols reach no docs, and no docs reference became wrong.',
    ]);
    expect(md).not.toContain('reach 0 doc sections');
    expect(md).toContain('<details><summary>Cleared: 4 changed symbol(s) reach no doc within 3 call hops</summary>');
    expect(md).toContain("- `typer.rich_utils.rich_format_help` (modified) — 0 raw text matches in the docs; check with `git grep -nw rich_format_help -- '*.md' '*.mdx' '*.rst'`");
  });

  it('a comment with findings or reached sections keeps the full summary', () => {
    const md = checkMarkdown({ impact: typerImpact(), summary: LONG, cleared, org: 'fastapi', newFindings: nf({ total: 1, findings: [] }) });
    expect(md.split('\n')[3]).toBe(LONG);
  });

  it('the terminal: the line first, the cleared symbols with their grep lines under it', () => {
    const text = allClearText(typerImpact(), cleared, nf())!.replace(/\x1b\[\d+m/g, '');
    expect(text.split('\n')).toEqual([
      'All clear: the 4 changed symbols reach no docs, and no docs reference became wrong.',
      '  Cleared: reach no doc within 3 hops (4)',
      ...cleared.map((c) => `    ✓ ${c.symbol} (${c.change}; ${c.textMatches} raw text matches in docs; check: ${c.grep})`),
    ]);
    expect(allClearText(typerImpact(), cleared, nf({ total: 2 }))).toBeUndefined();
  });
});
