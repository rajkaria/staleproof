import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { negated } from '../src/lint/check-commands.js';
import { inOtherCheckout } from '../src/lint/check-env.js';
import { checkLinks } from '../src/lint/check-paths.js';
import { lintRepo, workingFiles } from '../src/lint/engine.js';
import { RepoFacts } from '../src/lint/facts.js';
import { scanClaims } from '../src/lint/scan.js';
import type { RuleId } from '../src/lint/types.js';
import { git, put } from './fix-helpers.js';

/**
 * The 0.8.0 guards from the Drift Hall (63 fresh repositories, every finding hand-checked) and the corpus of
 * reported false positives (test/fixtures/fp). Each guard is shown next to a true finding of the same shape that
 * still fires: precision over recall, never silence.
 */

/** A git repository (lint reads hidden folders like `.claude/` and `.cursor/` from git's file list), one commit plus `history`. */
async function repo(files: Record<string, string>, history?: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-guards-'));
  await put(dir, files);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  await history?.(dir);
  return dir;
}

/** `rule path:line subject` of every finding of the rules. */
async function lint(dir: string, rules: RuleId[]): Promise<string[]> {
  const config = { ignore: [], skipExamples: [], rules: Object.fromEntries(rules.map((r) => [r, 'warning'])) } as never;
  const r = await lintRepo({ dir, repo: 'acme/demo', examples: false, rules, config });
  return r.findings.map((f) => `${f.rule} ${f.path}:${f.line} ${f.subject}`);
}

const paths = (files: Record<string, string>, history?: (dir: string) => Promise<void>) => repo(files, history).then((d) => lint(d, ['path-missing']));

describe('path-missing: names that are not claims about this repository', () => {
  it('a placeholder segment is a template (zod: `../NNNN/results.md`, instructor: `your_provider.md`); a real missing path still fires', async () => {
    expect(
      await paths({
        'docs/integrations/a.md': '# A\n',
        'scripts/run.sh': '',
        '.claude/skills/triage/SKILL.md': [
          'Cross-link with a relative `../NNNN/results.md`.',
          'Add documentation in `docs/integrations/your_provider.md`.',
          'Notes go in `notes/YYYY-MM-DD.md`.',
          'Run `scripts/gone.sh` first.',
          '',
        ].join('\n'),
      }),
    ).toEqual(['path-missing .claude/skills/triage/SKILL.md:4 scripts/gone.sh']);
  });

  it('check, label and branch names; a record of the change that removed a path; where another tool looks', async () => {
    expect(
      await paths({
        'license/README.md': '',
        'ui-v2/src/a.ts': '',
        '.github/workflows/ci.yml': '',
        'AGENTS.md': [
          'Until it is signed the `license/cla` check stays red.',
          '- Branch naming: `ui-v2/feature-description`',
          '| Version updates | Deleting `.github/dependabot.yml` outright (#2235) |',
          'Copilot CLI discovers `.claude/skills/` alongside `.github/skills/`, so a session finds them.',
          '',
          'The text is in `license/cla`.',
          'Keep `ui-v2/feature-description` short.',
          'Dependencies are updated by `.github/dependabot.yml`.',
          'Our skills live in `.github/skills/`.',
          // A gone-word without the change that did it is no record: the claims fixture's "ours removed `lib/removed.ts`".
          'Ours removed `.github/labeler.yml`.',
          '',
        ].join('\n'),
      }),
    ).toEqual([
      'path-missing AGENTS.md:6 license/cla',
      'path-missing AGENTS.md:7 ui-v2/feature-description',
      'path-missing AGENTS.md:8 .github/dependabot.yml',
      'path-missing AGENTS.md:9 .github/skills',
      'path-missing AGENTS.md:10 .github/labeler.yml',
    ]);
  });

  it('a sibling directory outside the repository on purpose (inspector: `../mcp-inspector-v2-2661`)', async () => {
    expect(
      await paths({
        '.claude/skills/pr-flow/SKILL.md': [
          'The worktree is a **sibling** directory named for the checkout plus the issue number',
          '(`../mcp-inspector-v2-2661`), never a directory inside the repo.',
          '',
          'Then read `../pr-notes/notes.md`.',
          '',
        ].join('\n'),
      }),
    ).toEqual(['path-missing .claude/skills/pr-flow/SKILL.md:4 ../pr-notes/notes.md']);
  });

  it('a module path written without its extension (prefect: `models/__init__`)', async () => {
    expect(
      await paths({
        'src/server/models/__init__.py': '',
        'src/server/AGENTS.md': 'A model imported early in `models/__init__` triggers a circular import; see `models/gone`.\n',
      }),
    ).toEqual(['path-missing src/server/AGENTS.md:1 models/gone']);
  });

  it('a path relative to a package or skill the paragraph names (prefect, mem0)', async () => {
    expect(
      await paths({
        'src/integrations/prefect-snowflake/prefect_snowflake/experimental/workers/spcs.py': '',
        'src/integrations/prefect-aws/prefect_aws/x.py': '',
        'src/integrations/experimental/README.md': '',
        'skills/mem0-integrate/references/pipeline.md': '',
        'skills/references/README.md': '',
        'skills/other/SKILL.md': '',
        'src/integrations/AGENTS.md': [
          "Exception: `prefect-snowflake`'s `experimental/workers/spcs.py` is the GA path.",
          '',
          "And `prefect-aws`'s `experimental/workers/ecs.py` too.",
          '',
        ].join('\n'),
        'skills/AGENTS.md': [
          '`mem0-integrate` is the one skill that needed splitting: it was 620 lines, now',
          '220, with the ten-step mechanics in `references/pipeline.md` and the two',
          'prompts in `references/prompts.md`.',
          '',
        ].join('\n'),
      }),
    ).toEqual(['path-missing skills/AGENTS.md:3 references/prompts.md', 'path-missing src/integrations/AGENTS.md:3 experimental/workers/ecs.py']);
  });

  it("an import path relative to the code an agent file governs: `../fixtures` below it, a Cursor rule's globs", async () => {
    expect(
      await paths({
        'ui-v2/e2e/fixtures/index.ts': '',
        'ui-v2/e2e/AGENTS.md': '1. Import from `../fixtures` (includes `test`, `expect`).\n2. Never import `../helpers`.\n',
        'packages/tanstack/test/__helpers.tsx': '',
        'packages/tanstack/src/index.ts': '',
        '.cursor/rules/tanstack-tests.mdc': [
          '---',
          "globs: ['packages/tanstack/**/*.test.tsx']",
          '---',
          '',
          '- Import `testReactResource` from `./__helpers`, the client from `../src`.',
          '- Not from `./__mocks`.',
          '',
        ].join('\n'),
      }),
    ).toEqual(['path-missing .cursor/rules/tanstack-tests.mdc:6 ./__mocks', 'path-missing ui-v2/e2e/AGENTS.md:2 ../helpers']);
  });

  it('a path like its siblings is a pattern (instructor: `tests/llm/test_provider/evals/`)', async () => {
    expect(
      await paths({
        'tests/llm/test_gemini/evals/a.py': '',
        'tests/llm/test_writer/evals/b.py': '',
        'CLAUDE.md': '- Evaluation tests in `tests/llm/test_provider/evals/` assess models.\n- Fixtures in `tests/llm/test_provider/fixtures/`.\n',
      }),
    ).toEqual(['path-missing CLAUDE.md:2 tests/llm/test_provider/fixtures']);
  });

  it("templates and pages of history: a CLI's AGENTS.md template, changelogs, plans, issue drafts (a deleted path in a guide still fires)", async () => {
    const found = await paths(
      {
        'lib/removed.ts': 'export {};\n',
        'lib/kept.ts': 'export {};\n',
        'cli/templates/AGENTS.md': 'Read the installed `crewai_core/platform_apps.py` module and `lib/removed.ts`.\n',
        'changelogs/0.29.0.md': '# 0.29.0\n\nSee `lib/removed.ts`.\n',
        'specification/v2_plan.md': '# Plan\n\nMove `lib/removed.ts`.\n',
        'github_issue.md': '# Issue\n\n- `lib/removed.ts` (11 calls)\n',
        'docs/guide.md': '# Guide\n\nThe helpers are in `lib/removed.ts`.\n',
      },
      async (dir) => {
        git(dir, 'rm', '-q', 'lib/removed.ts');
        git(dir, 'commit', '-q', '-m', 'drop');
      },
    );
    expect(found).toEqual(['path-missing docs/guide.md:3 lib/removed.ts']);
  });
});

describe('link-broken: links a docs site serves', () => {
  const links = (files: Record<string, string>) => repo(files).then((d) => lint(d, ['link-broken']));

  it('a Vue binding is not a link (vite, axios); a plain href still is', async () => {
    expect(
      await links({
        'docs/acknowledgements.md': '<a v-if="dep.funding" :href="dep.funding">x</a>\n<img v-bind:src="sponsor.imageUrl">\n<a href="missing.md">m</a>\n',
      }),
    ).toEqual(['link-broken docs/acknowledgements.md:3 docs/missing.md']);
  });

  it('a fragment the site includes links from the including page (sqlmodel, textual snippets)', async () => {
    expect(
      await links({
        'docs/tutorial/create-db-and-table.md': '# Create\n',
        'docs/styles/border_title_align.md': '# Align\n',
        'docs_src/tutorial/app/annotations/en/test_main_003.md': 'See [Create](../create-db-and-table.md) and [Gone](../no-such-page.md).\n',
        'docs/snippets/see_also_border.md': '- [border-title-align](./border_title_align.md)\n- [nothing](./nothing.md)\n',
      }),
    ).toEqual([
      'link-broken docs_src/tutorial/app/annotations/en/test_main_003.md:1 docs_src/tutorial/app/annotations/no-such-page.md',
      'link-broken docs/snippets/see_also_border.md:2 docs/snippets/nothing.md',
    ]);
  });

  it('pages served without their order prefix route extensionless links (svelte, gradio); a missing .md still fires', async () => {
    expect(
      await links({
        'documentation/docs/02-runes/02-$state.md': 'See [await](await-expressions) and [kit](../kit) and [old](old-page.md).\n',
        'documentation/docs/02-runes/03-await-expressions.md': '# await\n',
      }),
    ).toEqual(['link-broken documentation/docs/02-runes/02-$state.md:1 documentation/docs/02-runes/old-page.md']);
  });

  it('a page named after a code file (react-router `entry.server.tsx.md`)', async () => {
    expect(
      await links({
        'docs/api/conventions/entry.server.tsx.md': '# entry.server.tsx\n',
        'docs/api/conventions/entry.client.tsx.md': 'See [server](./entry.server.tsx) and [config](./react-router.config.ts).\n',
      }),
    ).toEqual(['link-broken docs/api/conventions/entry.client.tsx.md:1 docs/api/conventions/react-router.config.ts']);
  });

  it("doc-builder redirects, the English folder's for a translation (huggingface_hub)", async () => {
    expect(
      await links({
        'docs/source/en/_redirects.yml': '# Moved\nguides/webhooks_server: guides/webhooks\nhow-to-model-cards: guides/model-cards\n',
        'docs/source/en/_toctree.yml': '- title: x\n',
        'docs/source/en/guides/webhooks.md': '# Webhooks\n',
        'docs/source/en/guides/overview.md': '<a href="./webhooks_server">x</a> and <a href="./gone_page">y</a>\n',
        'docs/source/ko/package_reference/cards.md': '[cards](../how-to-model-cards) and [other](../how-to-gone)\n',
      }),
    ).toEqual(['link-broken docs/source/en/guides/overview.md:1 docs/source/en/guides/gone_page', 'link-broken docs/source/ko/package_reference/cards.md:1 docs/source/ko/how-to-gone']);
  });

  it("Storybook staticDirs, a generated page's omitted files, placeholder targets and templates", async () => {
    expect(
      await links({
        '.storybook/main.ts': 'export default { staticDirs: ["../js/storybook/public"] };\n',
        'js/storybook/public/gradio.svg': '<svg/>',
        'js/storybook/Introduction.mdx': '<img src="./gradio.svg" alt="Logo" />\n<img src="./missing.svg" />\n',
        'skills/setup-offline.md': [
          '# Offline',
          '',
          'This build omits the other `./references/...` deep-dive files to stay shorter.',
          '',
          'See [integrations](./references/python/integrations.md) and [notes](./notes/a.md).',
          '',
        ].join('\n'),
        'docs/en/translation-banner.md': '[English version](ENGLISH_VERSION_URL) and [text](url)\n',
        'libs/google/README.md': 'Replaces [ChatGoogleGenerativeAI](google_generative_ai).\n',
        'decisions/template.md': 'Superseded by [0005](0005-example.md)\n',
      }),
    ).toEqual([
      'link-broken libs/google/README.md:1 libs/google/google_generative_ai',
      'link-broken js/storybook/Introduction.mdx:2 js/storybook/missing.svg',
      'link-broken skills/setup-offline.md:5 skills/notes/a.md',
    ]);
  });

  it('a MkDocs site split over several config files routes extensionless links (textual); a TanStack docs config too', async () => {
    expect(
      await links({
        'mkdocs-nav.yml': 'nav: []\n',
        'docs/styles/align.md': '<a href="../../css_types/color">color</a> and [gone](./gone.md)\n',
        // A host without its scheme is no route: broken on the site too (textual's blog, confirmed in the hall).
        'docs/blog/post.md': 'Built on [Rich](github.com/textualize/rich).\n',
      }),
    ).toEqual(['link-broken docs/blog/post.md:1 docs/blog/github.com/textualize/rich', 'link-broken docs/styles/align.md:1 docs/styles/gone.md']);
    expect(
      await links({
        'docs/config.json': '{"sections": []}\n',
        'docs/framework/angular/installation.md': '[simple](./examples/simple) and [gone](./gone.md)\n',
      }),
    ).toEqual(['link-broken docs/framework/angular/installation.md:1 docs/framework/angular/gone.md']);
  });

  it('a link in an MDX comment over several lines renders nothing (zod); the next link is read', async () => {
    const text = ['{/* For convenience, you can also use the [`.or` method](#or):', '', '```ts', 'x.or(y);', '``` */}', '', 'See [gone](./gone.md).', ''].join('\n');
    expect(scanClaims('docs/api.mdx', text).links.map((l) => `${l.line} ${l.text}`)).toEqual(['7 ./gone.md']);
    // In Markdown `{/*` is text, and a fence line with text after it does not close the block (CommonMark).
    expect(scanClaims('docs/api.md', text).links.map((l) => `${l.line} ${l.text}`)).toEqual(['1 #or']);
  });
});

describe('anchor-missing: headings after a comment that closes on a fence line, and no fixes a site would undo', () => {
  it('finds the heading after ``` --> (zod home.md); a missing one still fires', async () => {
    const dir = await repo({
      'docs/home.md': ['- [Recursive](#recursive-types)', '- [Nowhere](#nowhere)', '', '<!--', '```ts', 'type T = 1;', '```  -->', '', '## Recursive types', ''].join('\n'),
    });
    expect(await lint(dir, ['anchor-missing'])).toEqual(['anchor-missing docs/home.md:2 #nowhere']);
  });

  it("ids a docs site gives headings: MkDocs `{ #id }` (fastapi), hf doc-builder `[[id]]` and its slugs, generated API anchors", async () => {
    const dir = await repo({
      'docs/en/docs/help.md': ['# Help { #help }', '', '- [Help](#help)', '- [Newsletter](#subscribe)', '- [Gone](#gone)', '', '## Subscribe to the newsletter { #subscribe .wide }', ''].join('\n'),
      'docs/source/_toctree.yml': '- title: x\n',
      'docs/source/ko/installation.md': ['# 설치 방법 [[installation]]', '', '- [check](#check-installation)', '- [token](#hftoken)', '- [nope](#nope)', '', '## 설치 확인 [[check-installation]]', '', '## HF_TOKEN', ''].join('\n'),
      'docs/source/en/index.md': '- [CodeAgent](./reference/agents.md#smolagents.CodeAgent)\n- [Missing](./reference/agents.md#no-such-section)\n',
      'docs/source/en/reference/agents.md': '# Agents\n\n[[autodoc]] CodeAgent\n',
    });
    expect(await lint(dir, ['anchor-missing'])).toEqual([
      'anchor-missing docs/en/docs/help.md:5 #gone',
      'anchor-missing docs/source/en/index.md:2 docs/source/en/reference/agents.md#no-such-section',
      'anchor-missing docs/source/ko/installation.md:5 #nope',
    ]);
  });

  it('offers no closest-heading fix on a site that builds its own heading ids (MkDocs); on GitHub it does', async () => {
    const page = '# Page\n\n- [Install](#instal)\n\n## Install\n';
    for (const [config, fix] of [
      [{}, true],
      [{ 'mkdocs.yml': 'site_name: x\n' }, false],
    ] as const) {
      const dir = await repo({ 'docs/page.md': page, ...config });
      const facts = new RepoFacts(dir, new Set(await workingFiles(dir)));
      const out = await checkLinks(scanClaims('docs/page.md', page), facts);
      expect(out.map((f) => f.rule)).toEqual(['anchor-missing']);
      expect(out[0]!.candidates?.length ? true : false, JSON.stringify(config)).toBe(fix);
    }
  });
});

describe('command-missing and cli-command-unknown: output and claims that a command is not there', () => {
  const commands = (files: Record<string, string>) => repo(files).then((d) => lint(d, ['command-missing']));

  it('`make a/b/c` is shorthand for existing targets (logfire); a missing one in the list still fires', async () => {
    expect(
      await commands({
        Makefile: 'format:\n\techo f\nlint:\n\techo l\ntypecheck:\n\techo t\n',
        'AGENTS.md': 'You can also run `make format/lint/typecheck` to run them, or `make format/docs`.\n',
      }),
    ).toEqual(['command-missing AGENTS.md:1 make format/docs']);
  });

  it('a sentence that says the command is not there is accurate (inspector `npm run ci`); telling you to run it still fires', async () => {
    expect(
      await commands({
        'package.json': JSON.stringify({ name: 'demo', scripts: { check: 'x' } }),
        'AGENTS.md': [
          '- There is deliberately **no `npm run ci`**: that name collided with the `npm ci` built-in.',
          '- `npm run ci` now fails with npm\'s missing-script error.',
          '- Before pushing, run `npm run ci`.',
          '',
        ].join('\n'),
      }),
    ).toEqual(['command-missing AGENTS.md:3 npm run ci']);
    const doc = scanClaims('a.md', 'there is no `npm run x`\n');
    const at = (col: number) => ({ text: 'x', line: 1, column: col, endColumn: col + 1, dynamic: false }) as never;
    expect(negated(doc, at(14), at(22))).toBe(true);
    expect(negated(scanClaims('a.md', 'then run `npm run x`\n'), at(11), at(19))).toBe(false);
  });

  it('a block introduced as output, or holding listing rows, is not commands (crewAI `uv tool list`)', async () => {
    expect(
      await commands({
        'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'x' } }),
        'README.md': [
          'Verify the install:',
          '',
          '```shell',
          'npm run verify-install',
          '```',
          '',
          'You should see something like:',
          '',
          '```shell',
          'npm run nothing-here',
          '```',
          '',
          '```shell',
          'crewai v0.102.0',
          '- crewai',
          '```',
          '',
        ].join('\n'),
      }),
    ).toEqual(['command-missing README.md:4 npm run verify-install']);
  });
});

describe('cli-command-unknown: a name two packages install, a version after the name', () => {
  const cli = 'import click\n\n@click.group()\ndef cli():\n    pass\n\n@cli.command()\ndef infra():\n    pass\n';
  const files = (extra: Record<string, string>) => ({
    'libs/agno/pyproject.toml': '[project]\nname = "agno"\n[project.scripts]\nagno = "agno.cli:cli"\n',
    'libs/agno/agno/__init__.py': '',
    'libs/agno/agno/cli.py': cli,
    'README.md': 'Run `agno infra` or `agno deploy`. Versions: `agno 3.0.0a2`, `agno v1.2.3`.\n',
    ...extra,
  });

  it('judges the one program of that name; a version after it is a listing, not a command', async () => {
    expect(await repo(files({})).then((d) => lint(d, ['cli-command-unknown']))).toEqual(['cli-command-unknown README.md:1 agno deploy']);
  });

  it('two packages installing different programs named `agno` (agno, agnoctl): neither is judged', async () => {
    const agnoctl = { 'libs/agnoctl/pyproject.toml': '[project]\nname = "agnoctl"\n[project.scripts]\nagno = "agnoctl.main:app"\n', 'libs/agnoctl/agnoctl/main.py': 'app = None\n' };
    expect(await repo(files(agnoctl)).then((d) => lint(d, ['cli-command-unknown']))).toEqual([]);
    // The same entry point declared twice (crewAI's two pyprojects) is one program, still judged.
    const same = { 'lib/cli/pyproject.toml': '[project]\nname = "agno-cli"\n[project.scripts]\nagno = "agno.cli:cli"\n' };
    expect(await repo(files(same)).then((d) => lint(d, ['cli-command-unknown']))).toEqual(['cli-command-unknown README.md:1 agno deploy']);
  });
});

describe('example checks (beta in 0.8.0): overload results, arity from a declared function type', () => {
  const examples = async (files: Record<string, string>, rules: RuleId[]) => {
    const dir = await repo(files);
    const config = { ignore: [], skipExamples: [], rules: Object.fromEntries(rules.map((r) => [r, 'error'])) } as never;
    const r = await lintRepo({ dir, repo: 'acme/demo', rules, config });
    return r.findings.map((f) => `${f.rule} ${f.path}:${f.line} ${f.message}`);
  };

  it("a call to an @overload'ed factory has no known result unless every overload agrees (instructor's from_provider)", async () => {
    const code = [
      'from typing import Literal, overload',
      '',
      'class Decisions:',
      '    def create(self, *, context): ...',
      '',
      'class Client:',
      '    def create(self, *, messages, model): ...',
      '',
      '@overload',
      'def from_provider(name: str, *, mode: Literal[1]) -> Decisions: ...',
      '@overload',
      'def from_provider(name: str) -> Client: ...',
      'def from_provider(name, mode=None):',
      '    return Decisions() if mode else Client()',
      '',
      '@overload',
      'def make(name: str) -> Client: ...',
      '@overload',
      'def make(name: int) -> Client: ...',
      'def make(name):',
      '    return Client()',
      '',
    ].join('\n');
    const readme = ['# Demo', '', '```python', 'import demo', 'c = demo.from_provider("openai/x")', 'c.create(messages=[], model="m")', 'd = demo.make("x")', 'd.create(messages=[], modle="m")', '```', ''].join('\n');
    expect(await examples({ 'pyproject.toml': '[project]\nname = "demo"\n', 'demo/__init__.py': code, 'README.md': readme }, ['example-unknown-keyword'])).toEqual([
      'example-unknown-keyword README.md:8 `Client.create` has no parameter `modle`.',
    ]);
  });

  it('`export const f: F = (a, b) => …` takes its optional parameters from F: not judged; an untyped arrow still is', async () => {
    const code = [
      'type Redirect = (url: string, init?: number) => Response;',
      'export const replace: Redirect = (url, init) => new Response(url);',
      'export const plain = (url: string, init: number) => new Response(url);',
      '',
    ].join('\n');
    const readme = ['# Demo', '', '```ts', "import { replace, plain } from 'demo';", "replace('/new');", "plain('/new');", '```', ''].join('\n');
    expect(await examples({ 'package.json': JSON.stringify({ name: 'demo', main: 'src/index.ts' }), 'src/index.ts': code, 'README.md': readme }, ['example-missing-argument'])).toEqual([
      'example-missing-argument README.md:6 `plain` requires `init`, which the example does not pass.',
    ]);
  });

  it('tabs: an alternative tab with no import of its own is not judged against the default tab (zod Mini); the default tab is', async () => {
    const code = 'export const string = () => 1;\nexport const minimum = undefined as never;\n';
    const mini = 'export const string = () => 1;\nexport const minimum = (n: number) => n;\n';
    const page = [
      '# API',
      '',
      '```ts',
      "import * as z from 'demo';",
      '```',
      '',
      '<Tabs groupId="lib" items={["Classic", "Mini"]}>',
      '<Tab value="Classic">',
      '```ts',
      'z.string();',
      'z.maximum(1);',
      '```',
      '</Tab>',
      '<Tab value="Mini">',
      '```ts',
      'z.string().check(z.maximum(1));',
      '```',
      '</Tab>',
      '</Tabs>',
      '',
    ].join('\n');
    const files = { 'package.json': JSON.stringify({ name: 'demo', main: 'src/index.ts', exports: { '.': './src/index.ts', './mini': './src/mini.ts' } }), 'src/index.ts': code, 'src/mini.ts': mini, 'docs/api.mdx': page };
    expect(await examples(files, ['example-missing-attribute'])).toEqual(['example-missing-attribute docs/api.mdx:11 `demo` has no `maximum`.']);
  });

  it('JS exports: names bound by destructuring and exported by a list (execa), a re-export from a missing file, a `.d.ts` path', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'demo', type: 'module', main: 'index.js' }),
      'index.js': "const make = () => ({});\nconst {sendMessage, getOneMessage} = make();\nexport {sendMessage, getOneMessage};\nexport {Generated} from './generated/types.js';\nexport const kept = 1;\n",
      'other/package.json': JSON.stringify({ name: 'other', type: 'module', main: 'index.js' }),
      'other/index.js': "export * from './built.js';\nexport const one = 1;\n",
      'README.md': [
        '# Demo',
        '',
        '```js',
        "import {sendMessage, getOneMessage, Generated, kept, gone} from 'demo';",
        "import {anything} from 'other';",
        "import type {HotPayload} from 'demo/types/hot.d.ts';",
        '```',
        '',
      ].join('\n'),
    };
    expect(await examples(files, ['example-missing-import'])).toEqual(['example-missing-import README.md:4 `demo` has no `gone`.']);
  });

  it("a function the page defines is the reader's code: not judged (jotai's tutorial, vite's preset); the repository's still is", async () => {
    const readme = [
      '# Build your own',
      '',
      '```js',
      'const atom = (initialValue) => ({ init: initialValue });',
      '```',
      '',
      '```js',
      'const derived = atom(null, (get, set) => set(1));',
      "import { plain } from 'demo';",
      "plain('/new');",
      '```',
      '',
    ].join('\n');
    const code = 'export const plain = (url: string, init: number) => url;\n';
    expect(await examples({ 'package.json': JSON.stringify({ name: 'demo', main: 'src/index.ts' }), 'src/index.ts': code, 'README.md': readme }, ['example-too-many-arguments', 'example-missing-argument'])).toEqual([
      'example-missing-argument README.md:10 `plain` requires `init`, which the example does not pass.',
    ]);
  });
});

describe('env-unused: variables of another repository’s checkout', () => {
  const contributing = [
    '## Docs',
    '',
    'Separately, clone the `pmndrs/docs` repository.',
    '',
    'Inside the `pmndrs/docs` directory: create a `.env` file with',
    '',
    '`MDX=docs` and `HOME_REDIRECT=/getting-started`',
    '',
    '## Tests',
    '',
    'Set `ZUSTAND_TEST=1`.',
  ];
  it('is not judged in a section that works inside another repository (zustand CONTRIBUTING.md)', () => {
    expect(inOtherCheckout(contributing, 7, 'pmndrs/zustand', new Set(['package.json']))).toBe(true);
    // The next section is this repository's again.
    expect(inOtherCheckout(contributing, 11, 'pmndrs/zustand', new Set(['package.json']))).toBe(false);
    // A fork of this repository is this repository; a folder of it is not another checkout.
    expect(inOtherCheckout(['Clone `you/zustand` first.', '`MDX=1`'], 2, 'pmndrs/zustand', new Set())).toBe(false);
    expect(inOtherCheckout(['cd into `docs/site` and set', '`MDX=1`'], 2, 'pmndrs/zustand', new Set(['docs/site/a.md']))).toBe(false);
  });

  it('lint: the other checkout is quiet, the same variable in this repository still fires', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({ name: 'zustand' }),
      'src/index.ts': 'export const a = process.env.ZUSTAND_TEST;\n',
      'CONTRIBUTING.md': [...contributing, '', '## Release', '', 'Set `HOME_REDIRECT=/x` before the release.', ''].join('\n'),
    });
    const r = await lintRepo({ dir, repo: 'pmndrs/zustand', examples: false, rules: ['env-unused'] });
    expect(r.findings.map((f) => `${f.path}:${f.line} ${f.subject} ${f.severity}`)).toEqual(['CONTRIBUTING.md:15 HOME_REDIRECT warning']);
  });
});
