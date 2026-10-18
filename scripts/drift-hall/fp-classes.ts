/**
 * False-positive classes seen in the Drift Hall. Each `false-positive` verdict belongs to the first class whose
 * rules and reason pattern match (the hand check's one-line reason names the cause). `status` moves to 'fixed' (with
 * the version) when a re-run on the same commits no longer reports the class (scripts/drift-hall/compare.ts); the hall
 * then counts those findings as found and fixed. Unmatched false positives fall into `other`.
 */
import type { VerdictRow } from './verdicts.js';

export interface FpClass {
  id: string;
  title: string;
  match: (v: VerdictRow) => boolean;
  status: 'open' | 'fixed';
  fixedIn?: string;
}

const EXAMPLE = ['example-missing-import', 'example-missing-attribute', 'example-missing-argument', 'example-too-many-arguments', 'example-unknown-keyword', 'example-removed'];
const LINKS = ['link-broken', 'anchor-missing'];
const CLI = ['cli-flag-unknown', 'cli-command-unknown', 'command-missing'];
const when = (re: RegExp, rules?: string[]) => (v: VerdictRow) => (!rules || rules.includes(v.rule)) && re.test(v.reason);

export const FP_CLASSES: FpClass[] = [
  {
    id: 'history-pages',
    title: 'Pages about another version: release snapshots and archived docs, migration and upgrade guides, release notes, proposals, design plans, pages that say the API was removed',
    match: (v) => !CLI.includes(v.rule) && /archived|migration|upgrade guide|release notes|changelog|\bbefore\b[` ]*(blocks?|halves|half|side|snippets?|lines?|\(|\/)|\/\/ before|# before|"before|proposal|superseded|design plan|\bplans?\/|historical|history|obsolete|development notes|\/\/ WRONG|labelled|v\d(\.x)? docs|old API|negated|versioned snapshot|doc snapshot|deprecated (warning|banner)|has been removed from|not yet available|proposed example|previous api/i.test(v.reason),
    status: 'open',
  },
  {
    id: 'instance-as-module',
    title: 'An exported instance read as the module of the same name (`initTRPC`, `notifyManager`, a `fastify` app)',
    match: when(/instance|as the submodule|as the module|method named/i, EXAMPLE),
    status: 'open',
  },
  {
    id: 'receiver-type',
    title: "A receiver's type inferred wrong: the wrong overload, a variable rebound later on the page, what `with`/`async with` binds, a container typed as its element",
    match: when(/overload|rebound|__a?enter__|typed the|is a (list|dict)|testclient|applied the|resolves to the|same block|reading is wrong|returned by/i, EXAMPLE),
    status: 'open',
  },
  {
    id: 'typed-arity',
    title: 'Optional parameters declared in a type annotation (`const fn: Fn = (opts) => ...`) read as required',
    match: when(/optional|annotation|typed by/i, ['example-missing-argument', 'example-too-many-arguments']),
    status: 'open',
  },
  {
    id: 'js-exports',
    title: 'JavaScript and TypeScript exports not followed: exports maps and subpaths, `export *` chains, CommonJS `module.exports`, declaration-only types, members added at run time',
    match: (v) => (EXAMPLE.includes(v.rule) && /exports? map|subpath|export \*|re-export|module\.exports|commonjs|declare namespace|type-only|wildcard|exports-map|default export|index\.d\.ts|at run ?time|prototype|is exported|are exported/i.test(v.reason)) || (v.rule === 'example-missing-import' && /\bexports?\b|real subpackage|works/i.test(v.reason)),
    status: 'open',
  },
  {
    id: 'readers-code',
    title: "Example code that is the reader's own: placeholders, elided sketches, the reader's helpers and classes, relative imports, files the guide asks to create",
    match: when(/reader|placeholder|elision|elided|elides|sketch|illustrat|your_tool|foo\/bar|abbreviated|abridged|pseudo-code|template|relative import|same snippet|same `package main`|later, unrelated snippet|conftest|returns? (a|an|the) /i, [...EXAMPLE, 'docstring-param-unknown']),
    status: 'open',
  },
  {
    id: 'site-slugger',
    title: "Heading ids from the docs site's own slugger (MkDocs toc and attr_list `{ #id }`, VitePress, Mintlify, TanStack, gradio, hf doc-builder, pmndrs/docs)",
    match: when(/slug|attr_list|heading ids?|keeps? punctuation|\{ ?#|mkdocs-click|camelcase/i, LINKS),
    status: 'open',
  },
  {
    id: 'generated-anchor',
    title: 'Anchors and pages a docs generator creates (mkdocstrings, [[autodoc]], FAQ compilers, offline bundles, Storybook static files)',
    match: when(/mkdocstrings|autodoc|generat|compiled into|offline bundle|storybook/i, [...LINKS, 'path-missing']),
    status: 'open',
  },
  {
    id: 'site-routing',
    title: 'Links the docs site routes: page URLs with directory URLs, flat or prefix-free routes, redirects, example routes, extensionless pages',
    match: when(/serv(es|ed)|route|redirect|directory url|page url|flat|extensionless/i, [...LINKS, 'path-missing']),
    status: 'open',
  },
  {
    id: 'included-snippet',
    title: 'Snippets included into another page (`--8<--`, `{!file!}`): links resolve from the page that includes them',
    match: when(/snippet included|included (with|into)|--8<--|\{!/i, [...LINKS, 'path-missing']),
    status: 'open',
  },
  {
    id: 'markdown-parse',
    title: 'Markdown read wrong: footnotes as link definitions, `<...>` destinations cut at `)`, Vue bindings, unused or illustrative link definitions',
    match: when(/footnote|angle bracket|cut at|link reference definition|vue (attribute )?bindings?|v-for|syntax|fixture|placeholder|template|test data|openapi/i, [...LINKS, 'example-missing-import']),
    status: 'open',
  },
  {
    id: 'docstring-format',
    title: 'Docstring layouts read as parameter names: `type (name)`, misplaced section headers, continuation lines, quoted sample docstrings',
    match: (v) => v.rule.startsWith('docstring-'),
    status: 'open',
  },
  {
    id: 'cli-model',
    title: 'CLI flags judged against the wrong parser: a subcommand\'s or a forwarded client\'s own options',
    match: (v) => ['cli-flag-unknown', 'cli-command-unknown', 'command-missing'].includes(v.rule),
    status: 'open',
  },
  {
    id: 'another-project',
    title: "Names that belong to another project or to the reader: env vars, paths relative to a package or skill, branch names, check names",
    match: (v) => ['env-unused', 'path-missing', 'symbol-missing', 'line-out-of-range'].includes(v.rule),
    status: 'open',
  },
];

export const OTHER: FpClass = { id: 'other', title: 'Other false positives', match: () => true, status: 'open' };

export function classOf(v: VerdictRow): FpClass {
  return FP_CLASSES.find((c) => c.match(v)) ?? OTHER;
}
