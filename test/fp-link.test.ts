import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  falsePositiveUrl,
  FP_FIELDS,
  FP_FORM_URL,
  FP_LABELS,
  LOCAL_TREE,
  MAX_LINE_TEXT,
  MAX_URL_LENGTH,
  messageShape,
  PRIVATE_REPO,
  truncateText,
} from '../src/format/fp-link.js';

const ROOT = join(import.meta.dirname, '..');
const SHA = 'd7a5583cffd80af515f7dfb69583c95cbdc9e2ce';

/** The prefilled fields of a link, decoded. */
function fields(url: string): Record<string, string> {
  const u = new URL(url);
  expect(`${u.origin}${u.pathname}`).toBe('https://github.com/rajkaria/staleproof/issues/new');
  return Object.fromEntries(u.searchParams.entries());
}

const zustand = {
  rule: 'env-unused',
  message: '`MDX` is documented but no code reads it.',
  repo: 'pmndrs/zustand',
  sha: SHA,
  path: 'CONTRIBUTING.md',
  line: 82,
  lineText: '   1. Create a `.env` file in the root directory with the next environment variables: `MDX=docs/zustand/docs` and `HOME_REDIRECT=/getting-started/introduction`.\n',
  version: '0.8.0',
};

describe('falsePositiveUrl', () => {
  it('opens the false-positive issue form with the finding filled in', () => {
    const url = falsePositiveUrl(zustand);
    expect(url.startsWith(`${FP_FORM_URL}&`)).toBe(true);
    expect(fields(url)).toEqual({
      template: 'false-positive.yml',
      title: 'False positive: env-unused in CONTRIBUTING.md',
      rule: 'env-unused',
      repository: `pmndrs/zustand@${SHA}`,
      location: 'CONTRIBUTING.md:82',
      message: '`MDX` is documented but no code reads it.',
      text: zustand.lineText.trimEnd(),
      version: '0.8.0',
    });
  });

  it('says "local working tree" when the repository or commit is unknown', () => {
    expect(fields(falsePositiveUrl({ ...zustand, repo: 'zustand', sha: undefined })).repository).toBe(LOCAL_TREE);
    expect(fields(falsePositiveUrl({ ...zustand, repo: undefined, sha: undefined })).repository).toBe(LOCAL_TREE);
    expect(fields(falsePositiveUrl({ ...zustand, sha: undefined })).repository).toBe(`pmndrs/zustand (${LOCAL_TREE})`);
  });

  it('is safe inside a Markdown link: no raw parentheses, quotes or spaces', () => {
    const url = falsePositiveUrl({ ...zustand, message: "`mytool` has no command `sync` (commands: pull, push) — it's gone!" });
    expect(url).not.toMatch(/[()'!*\s]/);
    expect(fields(url).message).toBe("`mytool` has no command `sync` (commands: pull, push) — it's gone!");
  });

  it('leaves out what it does not know', () => {
    const f = fields(falsePositiveUrl({ rule: 'link-broken', message: 'The link target `x.md` does not exist.' }));
    expect(f).toEqual({
      template: 'false-positive.yml',
      title: 'False positive: link-broken',
      rule: 'link-broken',
      repository: LOCAL_TREE,
      message: 'The link target `x.md` does not exist.',
    });
  });

  it('shares no path or file content for a private repository: rule, message shape, version', () => {
    const f = fields(falsePositiveUrl({ ...zustand, private: true }));
    expect(f).toEqual({
      template: 'false-positive.yml',
      title: 'False positive: env-unused',
      rule: 'env-unused',
      repository: PRIVATE_REPO,
      message: '`…` is documented but no code reads it.',
      version: '0.8.0',
    });
    const url = falsePositiveUrl({ ...zustand, private: true });
    for (const secret of ['CONTRIBUTING', 'MDX', 'zustand', 'pmndrs', SHA.slice(0, 7), 'environment variables', '82']) expect(decodeURIComponent(url)).not.toContain(secret);
  });

  it('truncates the flagged line, by code points, never inside a character', () => {
    const long = `${'é'.repeat(150)}${'😀'.repeat(150)}`;
    const text = fields(falsePositiveUrl({ ...zustand, lineText: long })).text!;
    expect([...text].length).toBe(MAX_LINE_TEXT);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('abcdef', 4)).toBe('abc…');
  });

  it(`stays under ${MAX_URL_LENGTH} characters whatever the finding holds`, () => {
    const huge = {
      ...zustand,
      message: `\`${'x'.repeat(5000)}\` is documented but no code reads it. ${'and more '.repeat(400)}`,
      lineText: '“quoted” ✓ '.repeat(2000),
      path: `docs/${'very-long-folder/'.repeat(60)}page.md`,
    };
    const url = falsePositiveUrl(huge);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    const f = fields(url);
    // The rule and the version always survive; the location too when it fits.
    expect(f.rule).toBe('env-unused');
    expect(f.version).toBe('0.8.0');
    expect(f.repository).toBe(`pmndrs/zustand@${SHA}`);
    // A URL GitHub accepts decodes without error.
    expect(() => decodeURIComponent(url)).not.toThrow();
    // Ordinary findings are never cut.
    expect(falsePositiveUrl(zustand).length).toBeLessThan(1000);
  });
});

describe('messageShape', () => {
  it('keeps the sentence and hides names, paths, commits and lists', () => {
    expect(messageShape('`MDX` is documented but no code reads it.')).toBe('`…` is documented but no code reads it.');
    expect(messageShape('`REDIS_TLS` is read in src/db.ts but not listed in .env.example.')).toBe('`…` is read in … but not listed in .env.example.');
    expect(messageShape('`mytool` has no command `sync` (commands: pull, push).')).toBe('`…` has no command `…` (commands: …).');
    expect(messageShape('`connect` documents host, port but not `tls`.')).toBe('`…` documents … but not `…`.');
    expect(messageShape('`connect` has no parameter `timeout_ms` (parameters: host, port, timeout).')).toBe('`…` has no parameter `…` (parameters: …).');
    expect(messageShape('`src/cli.ts` has 523 lines; line 812 does not exist.')).toBe('`…` has 523 lines; line 812 does not exist.');
    expect(messageShape('`codex-rs/x` does not exist; it was deleted in 431ebeaef7.')).toBe('`…` does not exist; it was deleted in ….');
    expect(messageShape('`lint:docs` is not a script in package.json.')).toBe('`…` is not a script in package.json.');
    expect(messageShape('See https://github.com/acme/secret/blob/main/a.md for why.')).toBe('See … for why.');
    expect(messageShape('`Client` has no member queryV2 or query_v2.')).toBe('`…` has no member … or ….');
  });
});

describe('the issue form', () => {
  it('has a field for every prefilled value, with the ids and labels the link and fp-to-fixture use', async () => {
    const form = parse(await readFile(join(ROOT, '.github/ISSUE_TEMPLATE/false-positive.yml'), 'utf8')) as {
      name: string;
      description: string;
      title: string;
      labels: string[];
      body: { type: string; id?: string; attributes: { label?: string; value?: string; options?: { label: string }[] }; validations?: { required?: boolean } }[];
    };
    expect(form.name).toBe('False positive');
    expect(form.labels).toContain('false-positive');
    const byId = new Map(form.body.filter((b) => b.id).map((b) => [b.id!, b]));
    for (const id of Object.values(FP_FIELDS)) {
      expect(byId.has(id), id).toBe(true);
      expect(byId.get(id)!.attributes.label).toBe(FP_LABELS[id]);
    }
    // Prefill works for inputs and textareas only.
    for (const id of ['rule', 'repository', 'location', 'message', 'text', 'version']) expect(['input', 'textarea']).toContain(byId.get(id)!.type);
    expect(byId.get('rule')!.validations?.required).toBe(true);
    expect(byId.get('why')!.validations?.required).toBe(true);
    const share = byId.get('share')!;
    expect(share.type).toBe('checkboxes');
    expect(share.attributes.options?.[0]?.label).toMatch(/^I can share this repository publicly/);
    const prose = form.body.filter((b) => b.type === 'markdown').map((b) => b.attributes.value ?? '').join('\n');
    expect(prose).toMatch(/regression/i);
    expect(prose).toMatch(/private/i);
  });

  it('every link field is one the form has', () => {
    const f = fields(falsePositiveUrl(zustand));
    const known = new Set<string>(['template', 'title', ...Object.values(FP_FIELDS)]);
    for (const k of Object.keys(f)) expect(known.has(k), k).toBe(true);
  });
});
