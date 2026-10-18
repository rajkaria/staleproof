import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLinks } from '../src/lint/check-paths.js';
import { lintRepo } from '../src/lint/engine.js';
import { RepoFacts } from '../src/lint/facts.js';
import { addFixes } from '../src/lint/fixes.js';
import { scanClaims, type LinkClaim } from '../src/lint/scan.js';
import { worktreeTree } from '../src/lint/sources.js';
import { put } from './fix-helpers.js';

/** pmndrs/zustand docs/reference/hooks/use-store.md lines 20-21 (angle-bracket destinations with parentheses). */
const USE_STORE_20 = '  - [Using scoped (non-global) vanilla store in React](<#using-scoped-(non-global)-vanilla-store-in-react>)';
const USE_STORE_21 = '  - [Using dynamic scoped (non-global) vanilla stores in React](<#using-dynamic-scoped-(non-global)-vanilla-stores-in-react>)';
/** pmndrs/zustand docs/reference/apis/create-store.md line 23 and its heading (line 343). */
const CREATE_STORE_23 = '  - [I’ve updated the state, but the screen doesn’t update](#i’ve-updated-the-state,-but-the-screen-doesn’t-update)';
const CREATE_STORE_343 = '### I’ve updated the state, but the screen doesn’t update';

const linksOf = (path: string, text: string) => scanClaims(path, text).links;
/** Each link as `line:column text`, and the text must be exactly what the columns cover. */
function placed(path: string, text: string): string[] {
  const lines = text.split('\n');
  return linksOf(path, text).map((l: LinkClaim) => {
    expect(lines[l.line - 1]!.slice(l.column - 1, l.endColumn - 1)).toBe(l.text);
    return `${l.line}:${l.column} ${l.kind} ${l.text}`;
  });
}

describe('link destinations (CommonMark)', () => {
  it('reads angle-bracket destinations whole: parentheses and the zustand regression lines', () => {
    const text = `${USE_STORE_20}\n${USE_STORE_21}\n`;
    expect(placed('docs/use-store.md', text)).toEqual([
      `1:${USE_STORE_20.indexOf('#') + 1} inline #using-scoped-(non-global)-vanilla-store-in-react`,
      `2:${USE_STORE_21.indexOf('#') + 1} inline #using-dynamic-scoped-(non-global)-vanilla-stores-in-react`,
    ]);
  });

  it('reads angle-bracket destinations with spaces, and titles after them', () => {
    expect(placed('a.md', '[x](<my page.md>) and [y](< other doc.md > "Title") and [z](<b.md> (t)) [q](<c.md>(t))')).toEqual([
      '1:6 inline my page.md',
      '1:28 inline  other doc.md ',
      '1:62 inline b.md',
    ]);
  });

  it('keeps balanced parentheses in plain destinations and stops at the closing one', () => {
    expect(placed('a.md', '[w](https://en.wikipedia.org/wiki/Foo_(bar)) see [d](docs/a_(b).md) (c) [e](x.md)')).toEqual([
      '1:5 inline https://en.wikipedia.org/wiki/Foo_(bar)',
      '1:54 inline docs/a_(b).md',
      '1:77 inline x.md',
    ]);
    expect(placed('a.md', '[t](a.md "Title (1)") [u](b.md \'T\') [v](c.md (T)) [n](d(e)f(g).md)')).toEqual([
      '1:5 inline a.md',
      '1:27 inline b.md',
      '1:41 inline c.md',
      '1:55 inline d(e)f(g).md',
    ]);
  });

  it('is not a link: spaces in a plain destination, an unclosed bracket or parenthesis, an empty destination, code', () => {
    expect(linksOf('a.md', '[a](b c) [d](<e) [f]() [g](<>) [h](i(j.md) `[k](l.md)` ``[m](n.md)``')).toEqual([]);
  });

  it('reference definitions: angle brackets with spaces, parentheses, titles', () => {
    expect(placed('a.md', ['[one]: <my file.md> "T"', '[two]: ./a_(b).md', '   [three]: <#scoped-(x)> \'t\'', '[four]:   plain.md (title)'].join('\n'))).toEqual([
      '1:9 reference my file.md',
      '2:8 reference ./a_(b).md',
      '3:14 reference #scoped-(x)',
      '4:11 reference plain.md',
    ]);
  });

  it("HTML links keep the other quote and parentheses: href=\"it's (1).md\"", () => {
    expect(placed('a.md', '<a href="it\'s (1).md">x</a> <img src=\'a "b".png\'> <a href="">e</a>')).toEqual(['1:10 html it\'s (1).md', '1:39 html a "b".png']);
  });

  it('reStructuredText: the target between < and > whole, with its column', () => {
    const text = 'See `Scoped (non-global) stores <guide.html#scoped-(non-global)>`_ and `the API <api reference.rst>`__.';
    expect(placed('docs/index.rst', text)).toEqual(['1:34 inline guide.html#scoped-(non-global)', '1:82 inline api reference.rst']);
  });
});

describe('anchors under another slugger (zustand)', () => {
  let dir: string;
  it('lint reports the other-slugger anchors at info, the missing one at the rule level', async () => {
    const r = await lintRepo({ dir, rules: ['anchor-missing'], examples: false });
    expect(r.findings.map((f) => `${f.path}:${f.line} ${f.severity}`)).toEqual([
      'docs/reference/apis/create-store.md:3 info',
      'docs/reference/hooks/use-store.md:4 info',
      'docs/reference/hooks/use-store.md:5 info',
      'docs/reference/hooks/use-store.md:6 warning',
      'docs/reference/middlewares/devtools.md:3 info',
      'docs/reference/middlewares/devtools.md:4 info',
    ]);
    expect(r.summary).toMatchObject({ infos: 5, warnings: 1, errors: 0 });
    // A configured level caps it; it never raises an info.
    const strict = await lintRepo({ dir, rules: ['anchor-missing'], examples: false, config: { rules: { 'anchor-missing': 'error' } } as never });
    expect(strict.findings.map((f) => f.severity)).toEqual(['info', 'info', 'info', 'error', 'info', 'info']);
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staleproof-links-'));
    await put(dir, {
      'docs/reference/hooks/use-store.md': [
        '# useStore',
        '',
        '- [Usage](#usage)',
        USE_STORE_20,
        USE_STORE_21,
        '- [Nowhere](#no-such-heading)',
        '',
        '## Usage',
        '',
        '### Using scoped (non-global) vanilla store in React',
        '',
        'Text.',
        '',
        '### Using dynamic scoped (non-global) vanilla stores in React',
        '',
        'Text.',
        '',
      ].join('\n'),
      'docs/reference/apis/create-store.md': ['# createStore', '', CREATE_STORE_23, '', '## Troubleshooting', '', CREATE_STORE_343, '', 'Text.', ''].join('\n'),
      'docs/reference/middlewares/devtools.md': [
        '# devtools',
        '',
        "- [Action names are labeled as 'anonymous'](#all-action-names-are-labeled-as-'anonymous')",
        "- [The other page](../apis/create-store.md#i’ve-updated-the-state,-but-the-screen-doesn’t-update)",
        '',
        "### All action names are labeled as 'anonymous'",
        '',
      ].join('\n'),
    });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const facts = () =>
    new RepoFacts(dir, new Set(['docs/reference/hooks/use-store.md', 'docs/reference/apis/create-store.md', 'docs/reference/middlewares/devtools.md']));
  const check = async (path: string) => {
    const f = facts();
    return checkLinks(scanClaims(path, (await f.text(path))!), f);
  };

  it('says the heading exists, gives its GitHub anchor, at info severity; the subject is the anchor as written', async () => {
    const out = await check('docs/reference/apis/create-store.md');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'anchor-missing',
      severity: 'info',
      subject: '#i’ve-updated-the-state,-but-the-screen-doesn’t-update',
      message:
        'The heading “I’ve updated the state, but the screen doesn’t update” is on this page, but its GitHub anchor is `#ive-updated-the-state-but-the-screen-doesnt-update`: ' +
        '`#i’ve-updated-the-state,-but-the-screen-doesn’t-update` works only on a docs site whose slugger keeps punctuation.',
      candidates: ['ive-updated-the-state-but-the-screen-doesnt-update'],
    });
    expect(out[0]!.span).toMatchObject({ line: 3, column: CREATE_STORE_23.indexOf('#') + 1, endColumn: CREATE_STORE_23.length });
  });

  it('the full angle-bracket anchors are judged (not cut at the first parenthesis); an ordinary missing anchor is unchanged', async () => {
    const out = await check('docs/reference/hooks/use-store.md');
    expect(out.map((f) => [f.span.line, f.subject, f.severity ?? 'rule default', f.candidates?.length === 1 ? f.candidates[0] : '…'])).toEqual([
      [4, '#using-scoped-(non-global)-vanilla-store-in-react', 'info', 'using-scoped-non-global-vanilla-store-in-react'],
      [5, '#using-dynamic-scoped-(non-global)-vanilla-stores-in-react', 'info', 'using-dynamic-scoped-non-global-vanilla-stores-in-react'],
      [6, '#no-such-heading', 'rule default', '…'],
    ]);
    expect(out[2]!.message).toBe('This page has no heading `#no-such-heading`.');
    expect(out[2]).not.toHaveProperty('severity');
  });

  it('a heading with an explicit id is no other-slugger case: a link spelling its text stays broken', async () => {
    await put(dir, { 'docs/ids.md': ['# Ids', '', '- [Setup](#set-up)', '', '## Set up {#install}', ''].join('\n') });
    const f = new RepoFacts(dir, new Set(['docs/ids.md']));
    const out = await checkLinks(scanClaims('docs/ids.md', (await f.text('docs/ids.md'))!), f);
    expect(out.map((x) => [x.subject, x.severity ?? 'rule default', x.message])).toEqual([['#set-up', 'rule default', 'This page has no heading `#set-up`.']]);
  });

  it('names the other page when the anchor points there', async () => {
    const out = await check('docs/reference/middlewares/devtools.md');
    expect(out.map((f) => f.message)).toEqual([
      "The heading “All action names are labeled as 'anonymous'” is on this page, but its GitHub anchor is `#all-action-names-are-labeled-as-anonymous`: " +
        "`#all-action-names-are-labeled-as-'anonymous'` works only on a docs site whose slugger keeps punctuation.",
      'The heading “I’ve updated the state, but the screen doesn’t update” is in `docs/reference/apis/create-store.md`, but its GitHub anchor is ' +
        '`#ive-updated-the-state-but-the-screen-doesnt-update`: `#i’ve-updated-the-state,-but-the-screen-doesn’t-update` works only on a docs site whose slugger keeps punctuation.',
    ]);
    expect(out[1]!.subject).toBe('docs/reference/apis/create-store.md#i’ve-updated-the-state,-but-the-screen-doesn’t-update');
  });

  it('offers the GitHub anchor as a verified fix, inside the angle brackets too', async () => {
    const result = await lintRepo({ dir, rules: ['anchor-missing'], examples: false });
    const fixed = await addFixes(result, worktreeTree(dir));
    const byLine = (path: string, line: number) => fixed.findings.find((f) => f.path === path && f.line === line)?.fix;
    expect(byLine('docs/reference/apis/create-store.md', 3)).toMatchObject({
      description: "Rename to `#ive-updated-the-state-but-the-screen-doesnt-update` (the heading's GitHub anchor)",
      edits: [{ line: 3, column: CREATE_STORE_23.indexOf('#') + 2, endColumn: CREATE_STORE_23.length, newText: 'ive-updated-the-state-but-the-screen-doesnt-update' }],
      verified: true,
    });
    expect(byLine('docs/reference/hooks/use-store.md', 4)).toMatchObject({
      edits: [{ column: USE_STORE_20.indexOf('#') + 2, endColumn: USE_STORE_20.lastIndexOf('>') + 1, newText: 'using-scoped-non-global-vanilla-store-in-react' }],
      verified: true,
    });
    expect(byLine('docs/reference/middlewares/devtools.md', 4)).toMatchObject({ edits: [{ newText: 'ive-updated-the-state-but-the-screen-doesnt-update' }], verified: true });
  });
});
