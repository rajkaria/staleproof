import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FP_FORM_URL } from '../src/format/fp-link.js';
import { formatGithub, formatJson, formatLint, formatMarkdown, formatSarif, formatText, lineReader, lintExitCode, lintSummaryLine, repositoryIsPrivate } from '../src/lint/format.js';
import { LOWER_CONFIDENCE_TITLE } from '../src/lint/maturity.js';
import type { Finding, LintResult } from '../src/lint/types.js';

const SHA = 'd7a5583cffd80af515f7dfb69583c95cbdc9e2ce';

function finding(over: Partial<Finding>): Finding {
  return {
    rule: 'path-missing',
    severity: 'error',
    message: '`src/settings.ts` does not exist in the repository.',
    repo: 'acme/app',
    path: 'AGENTS.md',
    line: 4,
    column: 21,
    endLine: 4,
    endColumn: 36,
    surface: 'agent',
    subject: 'src/settings.ts',
    evidence: { looked: 'the repository files', url: `https://github.com/acme/app/blob/${SHA}/AGENTS.md#L4` },
    fingerprint: 'f1',
    ...over,
  };
}

const stable = finding({});
const docs = finding({ rule: 'link-broken', message: 'The link target `docs/deploy.md` does not exist.', path: 'docs/guide.md', line: 9, surface: 'docs', subject: 'docs/deploy.md', fingerprint: 'f2', evidence: { looked: 'files' } });
const beta = finding({
  rule: 'env-unused',
  severity: 'info',
  message: '`MDX` is documented but no code reads it.',
  path: 'CONTRIBUTING.md',
  line: 82,
  column: 88,
  endLine: 82,
  endColumn: 91,
  surface: 'readme',
  subject: 'MDX',
  fingerprint: 'f3',
  lowerConfidence: true,
});

const result: LintResult = {
  version: 1,
  repo: 'acme/app',
  sha: SHA,
  findings: [stable, beta, docs],
  summary: { errors: 2, warnings: 0, infos: 1, files: 7, byRule: { 'path-missing': 1, 'link-broken': 1, 'env-unused': 1 }, bySurface: { agent: 1, readme: 1, docs: 1 }, ms: 12, lowerConfidence: 1 },
  warnings: [],
};
const clean: LintResult = { version: 1, repo: 'acme/app', sha: SHA, findings: [], summary: { errors: 0, warnings: 0, infos: 0, files: 7, byRule: {}, bySurface: {}, ms: 3 }, warnings: [] };

describe('lint formats: lower confidence', () => {
  it('text: beta findings in their own group, last, with what it means', () => {
    const text = formatText(result);
    const lines = text.split('\n');
    const group = lines.indexOf(LOWER_CONFIDENCE_TITLE);
    expect(group).toBeGreaterThan(lines.indexOf('Docs'));
    expect(lines[group + 1]).toMatch(/never fail a check or lower the score/);
    expect(text.indexOf('`MDX` is documented')).toBeGreaterThan(group >= 0 ? text.indexOf(LOWER_CONFIDENCE_TITLE) : Infinity);
    // The README group is empty without it, so it is not shown.
    expect(lines).not.toContain('README and contributing guides');
    expect(text).toContain('82:88  info     `MDX` is documented but no code reads it.  [env-unused]');
  });

  it('summary line counts lower-confidence findings, and only when there are some', () => {
    expect(lintSummaryLine(result)).toBe('2 errors, 1 info in 3 files (7 files checked, 12 ms); 1 of them lower confidence.');
    const noBeta: LintResult = { ...result, findings: [stable, docs], summary: { ...result.summary, infos: 0, lowerConfidence: undefined } };
    expect(lintSummaryLine(noBeta)).toBe('2 errors in 2 files (7 files checked, 12 ms).');
    expect(lintSummaryLine(clean)).toBe('No stale references in 7 files (3 ms).');
  });

  it('markdown: a lower-confidence section after the others', () => {
    const md = formatMarkdown(result);
    expect(md.indexOf(`**${LOWER_CONFIDENCE_TITLE}**`)).toBeGreaterThan(md.indexOf('**Docs**'));
    expect(md.indexOf('`MDX` is documented')).toBeGreaterThan(md.indexOf(`**${LOWER_CONFIDENCE_TITLE}**`));
  });

  it('SARIF: beta rules default to note with lower precision; results carry the flag', () => {
    // The driver lists the rules the results use: add a finding of a beta rule.
    const anchorFinding = finding({ rule: 'anchor-missing', severity: 'info', message: 'This page has no heading `#x`.', path: 'docs/guide.md', line: 3, surface: 'docs', subject: '#x', fingerprint: 'f4', lowerConfidence: true });
    const sarif = JSON.parse(formatSarif({ ...result, findings: [...result.findings, anchorFinding] }));
    const rules = sarif.runs[0].tool.driver.rules as { id: string; defaultConfiguration: { level: string }; properties: { maturity: string; precision: string } }[];
    // anchor-missing is beta (src/lint/maturity.ts); env-unused is stable since 0.8.0's Drift Hall run.
    const anchor = rules.find((r) => r.id === 'anchor-missing')!;
    expect(anchor.defaultConfiguration.level).toBe('note');
    expect(anchor.properties).toMatchObject({ maturity: 'beta', precision: 'medium' });
    expect(rules.find((r) => r.id === 'env-unused')!).toMatchObject({ defaultConfiguration: { level: 'warning' }, properties: { maturity: 'stable', precision: 'high' } });
    expect(rules.find((r) => r.id === 'link-broken')!.properties).toMatchObject({ maturity: 'stable', precision: 'high' });
    const results = sarif.runs[0].results as { ruleId: string; level: string; properties: { lowerConfidence?: boolean } }[];
    expect(results.find((r) => r.ruleId === 'env-unused')).toMatchObject({ level: 'note', properties: { lowerConfidence: true } });
    expect(results.find((r) => r.ruleId === 'path-missing')!.properties.lowerConfidence).toBeUndefined();
  });

  it('GitHub annotations say a beta finding is lower confidence', () => {
    const gh = formatGithub(result).split('\n');
    expect(gh[0]).toBe('::error file=AGENTS.md,line=4,col=21,endLine=4,endColumn=36,title=Staleproof path-missing::`src/settings.ts` does not exist in the repository.');
    expect(gh[1]).toBe('::notice file=CONTRIBUTING.md,line=82,col=88,endLine=82,endColumn=91,title=Staleproof env-unused (beta%2C lower confidence)::`MDX` is documented but no code reads it.');
  });

  it('exit codes ignore lower-confidence findings at every level', () => {
    const onlyBeta: LintResult = { ...result, findings: [beta] };
    expect(lintExitCode(onlyBeta, 'info')).toBe(0);
    expect(lintExitCode(result, 'error')).toBe(1);
    expect(lintExitCode({ ...result, findings: [{ ...beta, lowerConfidence: undefined }] }, 'info')).toBe(1);
  });
});

describe('lint formats: "False positive?"', () => {
  it('text: one footer line with the form, never a link per finding', () => {
    const text = formatLint(result, 'text');
    const footer = text.split('\n').filter((l) => l.includes(FP_FORM_URL));
    expect(footer).toEqual([`False positive? Report it in one click: ${FP_FORM_URL} (the rule, file:line and message are enough).`]);
    expect(text.split('\n').at(-1)).toBe(lintSummaryLine(result));
    expect(text).not.toContain('issues/new?template=false-positive.yml&');
  });

  it('text and markdown: nothing in all-clear output', () => {
    expect(formatLint(clean, 'text')).toBe('No stale references in 7 files (3 ms).');
    expect(formatLint(clean, 'markdown')).toBe('No stale references in 7 files (3 ms).');
    expect(formatGithub(clean)).toBe('');
  });

  it('callers of formatText and formatMarkdown (the PR report) choose: no footer, no links by default', () => {
    expect(formatText(result)).not.toContain(FP_FORM_URL);
    expect(formatMarkdown(result)).not.toContain('False positive?');
    expect(formatMarkdown(result)).toContain('<sub>path-missing</sub>');
    expect(formatText(result, { footer: true })).toContain(FP_FORM_URL);
    expect(formatMarkdown(result, { falsePositiveLinks: true })).toContain('<sub>path-missing · [False positive?](');
  });

  it('markdown: a small prefilled link on every finding', () => {
    const md = formatLint(result, 'markdown', { lineText: (p, l) => (p === 'AGENTS.md' && l === 4 ? 'Config lives in `src/settings.ts`.' : undefined) });
    const rows = md.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatch(/<sub>[a-z-]+ · \[False positive\?\]\(https:\/\/github\.com\/rajkaria\/staleproof\/issues\/new\?template=false-positive\.yml&[^)\s]+\)<\/sub>/);
    const link = new URL(/\[False positive\?\]\(([^)]+)\)/.exec(rows[0]!)![1]!);
    expect(link.searchParams.get('rule')).toBe('path-missing');
    expect(link.searchParams.get('repository')).toBe(`acme/app@${SHA}`);
    expect(link.searchParams.get('location')).toBe('AGENTS.md:4');
    expect(link.searchParams.get('text')).toBe('Config lives in `src/settings.ts`.');
    expect(link.searchParams.get('version')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('markdown for a private repository: links carry no path or text', () => {
    const md = formatMarkdown(result, { falsePositiveLinks: true, private: true, lineText: () => 'secret line' });
    const urls = [...md.matchAll(/\[False positive\?\]\(([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]!));
    expect(urls).toHaveLength(3);
    for (const u of urls) {
      expect(u).not.toContain('AGENTS.md');
      expect(u).not.toContain('secret line');
      expect(u).not.toContain('acme/app');
      expect(u).toContain('private repository (not shared)');
    }
  });

  it('SARIF: rule help names the form with the rule filled in; each result its own link', () => {
    const sarif = JSON.parse(formatSarif(result, { lineText: () => 'a line' }));
    const rule = sarif.runs[0].tool.driver.rules.find((r: { id: string }) => r.id === 'path-missing');
    expect(rule.helpUri).toBe('https://staleproof.dev/#/docs/rules#path-missing');
    expect(rule.help.text).toContain(`${FP_FORM_URL}&rule=path-missing`);
    expect(rule.help.markdown).toContain(`[False positive? Report it](${FP_FORM_URL}&rule=path-missing)`);
    const res = sarif.runs[0].results[0];
    expect(new URL(res.properties.falsePositiveUrl).searchParams.get('text')).toBe('a line');
  });

  it('JSON names the form; findings stay as lint returned them', () => {
    const json = JSON.parse(formatJson(result));
    expect(json.tool.falsePositives).toBe(FP_FORM_URL);
    expect(json.findings).toEqual(result.findings);
  });

  it('formatLint passes the options through', () => {
    const md = formatLint(result, 'markdown', { private: true });
    expect(decodeURIComponent(md)).not.toContain('location=AGENTS.md');
  });
});

describe('lineReader and repositoryIsPrivate', () => {
  it('reads lines of the checkout, once per file, and nothing outside it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-lines-'));
    await writeFile(join(dir, 'a.md'), 'one\r\ntwo\nthree');
    const read = lineReader(dir);
    expect(read('a.md', 2)).toBe('two');
    expect(read('a.md', 1)).toBe('one');
    expect(read('a.md', 9)).toBeUndefined();
    expect(read('missing.md', 1)).toBeUndefined();
    expect(read('../etc/passwd', 1)).toBeUndefined();
  });

  it('knows a private repository from the GitHub Actions event, and nothing elsewhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-event-'));
    const priv = join(dir, 'private.json');
    const pub = join(dir, 'public.json');
    await writeFile(priv, JSON.stringify({ repository: { private: true } }));
    await writeFile(pub, JSON.stringify({ repository: { private: false } }));
    expect(repositoryIsPrivate({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: priv })).toBe(true);
    expect(repositoryIsPrivate({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: pub })).toBe(false);
    expect(repositoryIsPrivate({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: join(dir, 'none.json') })).toBeUndefined();
    expect(repositoryIsPrivate({ GITHUB_EVENT_PATH: priv })).toBeUndefined();
    expect(repositoryIsPrivate({})).toBeUndefined();
  });
});
