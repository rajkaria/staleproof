import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { falsePositiveUrl, FP_LABELS } from '../src/format/fp-link.js';
import { buildFixture, caseFromFields, caseFromIssue, checkFixture, materialize, parseIssueBody, readFixture, restoredPath, slugFor, storedPath, type FixtureExpected } from '../scripts/fp-to-fixture.js';
import { gitIn } from './helpers.js';

const SHA = 'd7a5583cffd80af515f7dfb69583c95cbdc9e2ce';

/** An issue body as GitHub renders a submitted issue form. */
function issueBody(over: Partial<Record<keyof typeof FP_LABELS, string>> = {}): string {
  const v: Record<keyof typeof FP_LABELS, string> = {
    rule: 'env-unused',
    repository: `pmndrs/zustand@${SHA}`,
    location: 'CONTRIBUTING.md:82',
    message: '`MDX` is documented but no code reads it.',
    text: '```text\n   1. Create a `.env` file with `MDX=docs/zustand/docs`.\n```',
    why: 'pmndrs/docs reads it: the step is done in that checkout.',
    version: '0.8.0',
    share: '- [X] I can share this repository publicly (we may clone it at this commit and copy the files the finding depends on into the fixture)',
    ...over,
  };
  return (Object.keys(FP_LABELS) as (keyof typeof FP_LABELS)[]).map((k) => `### ${FP_LABELS[k]}\n\n${v[k]}`).join('\n\n');
}

describe('reading a false-positive report', () => {
  it('parses the issue form sections back into fields', () => {
    const f = parseIssueBody(issueBody({ location: '_No response_' }));
    expect(f.rule).toBe('env-unused');
    expect(f.repository).toBe(`pmndrs/zustand@${SHA}`);
    expect(f.location).toBeUndefined();
    expect(f.text).toBe('   1. Create a `.env` file with `MDX=docs/zustand/docs`.');
    expect(f.share).toBe(true);
    expect(parseIssueBody(issueBody({ share: '- [ ] I can share this repository publicly' })).share).toBe(false);
  });

  it('turns an issue into a case: repository, commit, file, lines', () => {
    const c = caseFromIssue({ number: 41, url: 'https://github.com/rajkaria/staleproof/issues/41', body: issueBody() });
    expect(c).toMatchObject({ issue: 41, repo: 'pmndrs/zustand', sha: SHA, rule: 'env-unused', file: 'CONTRIBUTING.md', lines: [82], why: 'pmndrs/docs reads it: the step is done in that checkout.' });
  });

  it('refuses a report it cannot reproduce from public code', () => {
    expect(() => caseFromIssue({ number: 1, url: '', body: issueBody({ repository: 'private repository (not shared)' }) })).toThrow(/public repository at a commit/);
    expect(() => caseFromIssue({ number: 1, url: '', body: issueBody({ repository: 'local working tree' }) })).toThrow(/public repository at a commit/);
    expect(() => caseFromIssue({ number: 1, url: '', body: issueBody({ location: '_No response_' }) })).toThrow(/file and line/);
    expect(() => caseFromIssue({ number: 1, url: '', body: issueBody({ rule: 'not-a-rule' }) })).toThrow(/unknown rule/);
  });

  it('reads what the "False positive?" link prefills, end to end', () => {
    const url = new URL(falsePositiveUrl({ rule: 'anchor-missing', message: 'm', repo: 'a/b', sha: SHA, path: 'docs/x.md', line: 20 }));
    const body = (['rule', 'repository', 'location', 'message', 'why'] as const).map((k) => `### ${FP_LABELS[k]}\n\n${url.searchParams.get(k) ?? 'because'}`).join('\n\n');
    expect(caseFromIssue({ number: 2, url: '', body })).toMatchObject({ repo: 'a/b', sha: SHA, rule: 'anchor-missing', file: 'docs/x.md', lines: [20] });
  });

  it('takes explicit fields, several lines included', () => {
    expect(caseFromFields({ repo: 'pmndrs/zustand', sha: SHA, rule: 'anchor-missing', file: 'docs/a.md', line: '20,21' }).lines).toEqual([20, 21]);
    expect(caseFromFields({ repo: 'pmndrs/zustand', sha: SHA, rule: 'anchor-missing', file: 'docs/a.md', line: '20-22' }).lines).toEqual([20, 21, 22]);
    expect(() => caseFromFields({ repo: 'pmndrs/zustand', sha: 'main', rule: 'anchor-missing', file: 'docs/a.md', line: '1' })).toThrow(/full commit sha/);
  });

  it('names fixtures after the rule, repository and page', () => {
    expect(slugFor({ rule: 'anchor-missing', repo: 'pmndrs/zustand', file: 'docs/reference/hooks/use-store.md' })).toBe('anchor-missing-zustand-use-store');
    expect(slugFor({ rule: 'env-unused', repo: 'pmndrs/zustand', file: 'CONTRIBUTING.md' }, 'other checkout')).toBe('env-unused-zustand-other-checkout');
  });

  it('stores dot files under a visible name, so the fixture never configures this repository', () => {
    expect(storedPath('.github/workflows/docs.yml')).toBe('dot.github/workflows/docs.yml');
    expect(storedPath('docs/.vitepress/config.ts')).toBe('docs/dot.vitepress/config.ts');
    expect(storedPath('a/b.md')).toBe('a/b.md');
    expect(restoredPath('dot.github/workflows/docs.yml')).toBe('.github/workflows/docs.yml');
    expect(restoredPath(storedPath('.env.example'))).toBe('.env.example');
  });
});

describe('building and checking a fixture', () => {
  let src: string;
  let out: string;

  beforeAll(async () => {
    // A small public-looking repository with one env-unused finding (a beta rule: still reported, at info).
    src = await mkdtemp(join(tmpdir(), 'staleproof-fp-src-'));
    await writeFile(join(src, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }));
    await mkdir(join(src, 'src'), { recursive: true });
    await writeFile(join(src, 'src', 'index.js'), 'export const url = process.env.DEMO_URL;\n');
    await writeFile(join(src, 'src', 'unrelated.js'), 'export const x = 1;\n');
    await writeFile(join(src, 'README.md'), '# Demo\n\n| Variable | Description |\n|---|---|\n| `DEMO_URL` | Your server. |\n| `DEMO_TOKEN` | Your token. |\n');
    await writeFile(join(src, '.gitignore'), 'node_modules\n');
    await writeFile(join(src, 'LICENSE'), 'MIT License\n');
    gitIn(src, 'init', '-q', '-b', 'main');
    gitIn(src, 'add', '-A');
    gitIn(src, 'commit', '-q', '-m', 'init');
    out = await mkdtemp(join(tmpdir(), 'staleproof-fp-out-'));
  });

  it('copies only the page and what the finding depends on, and records what must not come back', async () => {
    const sha = gitIn(src, 'rev-parse', 'HEAD');
    const c = caseFromFields({ repo: 'acme/demo', sha, rule: 'env-unused', file: 'README.md', line: '6', why: 'DEMO_TOKEN is read by the deploy service.', slug: 'demo-token' });
    const r = await buildFixture(c, { from: src, root: out, log: () => {} });
    expect(r.dir).toBe(join(out, 'env-unused-demo-token'));
    expect(r.reproduces).toBe(true);
    const files = r.expected.files;
    expect(files).toContain('README.md');
    expect(files).toContain('package.json');
    expect(files).toContain('.gitignore');
    // The source's license travels with its files.
    expect(files).toContain('LICENSE');
    expect(files).not.toContain('src/unrelated.js');
    expect(existsSync(join(r.dir, 'repo', 'dot.gitignore'))).toBe(true);
    const expected = JSON.parse(await readFile(join(r.dir, 'expected.json'), 'utf8')) as FixtureExpected;
    expect(expected.summary).toBe('no finding env-unused at README.md:6');
    expect(expected.absent).toEqual([{ rule: 'env-unused', file: 'README.md', line: 6, message: '`DEMO_TOKEN` is documented but no code reads it.' }]);
    expect(expected.source).toMatchObject({ repo: 'acme/demo', sha });
    // Reproduces today, so it is pending until the rule is fixed.
    expect(expected.pending).toMatch(/reproduces/);
  });

  it('checks a fixture: the findings that came back', async () => {
    const fx = await readFixture(join(out, 'env-unused-demo-token'));
    const back = await checkFixture(fx);
    expect(back.map((f) => `${f.rule} ${f.path}:${f.line}`)).toEqual(['env-unused README.md:6']);
    const tree = await materialize(fx.dir);
    expect(existsSync(join(tree, '.gitignore'))).toBe(true);
    expect(gitIn(tree, 'ls-files')).toContain('README.md');
  });

  it('refuses a finding that is not there at that commit, and an existing fixture', async () => {
    const sha = gitIn(src, 'rev-parse', 'HEAD');
    await expect(buildFixture(caseFromFields({ repo: 'acme/demo', sha, rule: 'env-unused', file: 'README.md', line: '5' }), { from: src, root: out, log: () => {} })).rejects.toThrow(/no env-unused finding at README.md:5/);
    await expect(buildFixture(caseFromFields({ repo: 'acme/demo', sha, rule: 'env-unused', file: 'README.md', line: '6', slug: 'demo-token' }), { from: src, root: out, log: () => {} })).rejects.toThrow(/already exists/);
  });
});
