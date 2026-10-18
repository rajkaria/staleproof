import type { RuleSetting } from '../indexer/repo-config.js';
import { SEVERITY_RANK, type Finding, type RuleId, type Severity } from './types.js';

/**
 * How far a rule has earned trust (docs/false-positives.md).
 *
 * - `stable`: hand-checked on the real repositories of the precision runs and the Drift Hall (staleproof.dev/#/drift), with true
 *   findings and no known false positive at its severity that is not fixed and guarded by a fixture in
 *   `test/fixtures/fp/`.
 * - `beta`: still earning it. Its findings are reported at `info` and marked `lowerConfidence`: shown, in their
 *   own "Lower confidence" group, but they never fail `--fail-on`, the Action, the App or a hook, and never lower
 *   the audit score. `[rules] "<id>" = "error" | "warning"` in `.staleproof.toml` opts a beta rule back in.
 *
 * A rule moves to `stable` when its known false positives have fixtures that pass and a precision run on fresh
 * repositories finds no new ones; it moves back to `beta` when a reported false positive cannot be fixed in the
 * release that reports it.
 */
export type Maturity = 'stable' | 'beta';

export interface RuleMaturity {
  maturity: Maturity;
  /** The evidence: repositories, findings, false positives and what closed them. */
  why: string;
  /**
   * A stable rule's known false positives that are not fixed yet: corpus fixtures marked `pending`. Each must be
   * fixed (its guard lands and the fixture passes) or the rule made beta before a release ships it as stable;
   * test/fp-corpus.test.ts keeps this list and the corpus in step.
   */
  open?: string[];
}

/** Every rule's maturity, with the evidence. A rule id missing here is a type error. */
export const MATURITY: Record<RuleId, RuleMaturity> = {
  'path-missing': {
    maturity: 'beta',
    why: 'Hand-checked on 8 repositories (the 0.4 precision runs: httpx, flask, TypeScript, python-sdk, codex, pydantic-ai, vercel/ai, this one): every final finding true (codex 3, pydantic-ai 5), 20 verified fixes on pydantic-ai; true again on pmndrs/valtio (2, a deleted Next.js route its README names). First-run false positives (other projects\' paths in docs, skill-relative paths) closed by guards: a docs page needs git-history evidence. Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 7 true, 32 false; the 0.8.0 guards leave 7 true, 0 false: placeholder segments (`../NNNN/results.md`, `your_provider.md`), pages of history (changelogs, plans, proposals, decision records, issue drafts) and templates (`templates/AGENTS.md`), check, label and branch names (`license/cla`), paths the sentence says are gone, where another tool looks (`.github/skills/`), sibling folders outside the repository, module paths without their extension, paths relative to a package or skill the paragraph names or to the code an agent file governs (`../fixtures`, a Cursor rule\'s `globs`), a path like its siblings (`test_provider/evals`). Fixture `path-missing-zod-placeholder`. But the held-out check (Oct 18: 18 popular repositories in none of the hall or the earlier runs, linted only after those guards were written, every warning and error hand-checked) found 0 true, 12 false: mostly records of a removal without a PR reference, another repository\'s paths, and plans. Beta in 0.8.0 under the 80% rule.',
  },
  'line-out-of-range': {
    maturity: 'beta',
    why: 'A line count on a file path-missing resolved in this repository, so it shares that rule\'s guards. No finding, true or false, on the 8 the 0.4 precision runs repositories or the 14 of the Oct 18 sweep (zustand, zod, jotai, typer, ky, click, starlette, rich, black, sqlmodel, execa, valtio, hono, vite). The held-out check (Oct 18: 18 fresh repositories, hand-checked) found 0 true, 1 false and 2 unclear, and no true finding on any of the 81 repositories checked: beta in 0.8.0 under the 80% rule.',
  },
  'link-broken': {
    maturity: 'stable',
    why: 'True findings on TypeScript (1), vercel/ai (25, 31 verified fixes), colinhacks/zod (3) and pmndrs/jotai (3, a renamed docs folder). First-run false positives (mkdocstrings-generated pages, translations, docs-root links) closed by guards. Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 586 true, 418 false (58%), almost all docs-site routing; the 0.8.0 guards leave 586 true, 9 false (98%), none of the true ones lost: MkDocs configs split over files (textual\'s raw-HTML hrefs) and TanStack\'s `docs/*/config.json` count as docs sites, pages served without their order prefix (svelte, gradio), `entry.server.tsx.md` pages, doc-builder `_redirects.yml` (the English one for translations), Storybook `staticDirs`, fragments a site includes (snippets, `docs_src/` annotations), Vue bindings (`:href`), placeholder targets, templates, sample data, prefixes a generated page says it omits. A host written without its scheme (textual\'s `github.com/textualize/rich`) is still reported on a docs site. Left: svelte\'s compiler messages (7), react-router 2. Fixtures `link-broken-vite-vue-bound-href`, `link-broken-sqlmodel-included-fragment`.',
  },
  'anchor-missing': {
    maturity: 'beta',
    why: 'True findings on httpx (6) and zod (5), but more false ones on fresh repositories (Oct 18 sweep): pmndrs/zustand 8 of 8 (its docs site keeps punctuation in heading ids, and `<#a-(b)-c>` was cut at the first `)`; 0.7.0 reads the whole destination and reports a heading found under another slugger at info, with no fix), colinhacks/zod about 12 of 18 (headings after a code block that closes its HTML comment on the fence line, ``` -->, and links inside MDX comments: both fixed in 0.8.0). Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 148 true, 249 false (37%), most from docs-site sluggers (MkDocs attr_list and toc, VitePress, Mintlify, TanStack, hf doc-builder). Fixtures `anchor-missing-zustand-*`, `anchor-missing-zod-*`. After the 0.8.0 guards, on the 61 hall repositories other than crewAI and haystack, above info (a heading under another slugger is an info note with no fix): 134 true, 23 false (85%), from 109 false: MkDocs attr_list ids (`{ #id }`, fastapi 35, marimo 12), hf doc-builder `[[id]]` ids and slugs (`HF_TOKEN` → `hftoken`, huggingface_hub 30), generated API anchors (`[[autodoc]]`, `:::`, smolagents 10). Still beta for 0.8.0 (decided before this measurement; crewAI\'s 207 anchors are not judged): a candidate for stable.',
  },
  'command-missing': {
    maturity: 'stable',
    why: 'the 0.5 precision runs: 22 repositories, 1 300+ invocations judged, 5 findings, all true (codex 1, cline 4); 17 verified fixes on simulated renames; nothing false on the 14 repositories of the Oct 18 sweep. Every first-run false positive (go-task\'s users\' tasks, another project\'s layout after `cd`) closed by a guard. Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 13 true, 7 false (65%); the 0.8.0 guards (`make format/lint/typecheck` shorthand for existing targets, a sentence that says the command is not there, blocks introduced as output) leave 13 true, 2 false (87%): nuxt\'s and express\'s scripts of the reader\'s generated app.',
  },
  'cli-command-unknown': {
    maturity: 'stable',
    why: 'the 0.5 precision runs: the CLI models of 13 repositories (click, typer, argparse, commander) judged against 1 300+ invocations with no false positive left (none either on the Oct 18 sweep: typer, click, black, rich); first-run ones (log lines like `staleproof mcp:`, an unrelated parser reached through `main()`) closed by guards. Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 7 true, 6 false (54%), all crewAI\'s `uv tool list` output (`crewai v0.102.0`) in a shell block; 0.8.0 reads a block introduced as output, or holding listing rows, as output: 7 true, 0 false.',
  },
  'cli-flag-unknown': {
    maturity: 'beta',
    why: 'the 0.5 precision runs: 22 repositories and 1 300+ invocations, leaf options judged (llm, datasette, sqlite-utils, hatch), no false positive left after the guards. But the Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift) found 6 true, 245 false (2%): commander subcommands defined in other modules and mounted with `addCommand` (shadcn-ui 110), a launcher that forwards argv to sub-CLIs (modelcontextprotocol/inspector 134), two CLIs with one name (mem0). Beta until the CLI model follows them (src/lint/facts-cli.ts).',
  },
  'env-unused': {
    maturity: 'stable',
    why: 'Every application in the 0.5 precision runs had first-run false positives, each closed by a per-ecosystem guard (pydantic-ai 11, vercel/ai 67, uvicorn\'s FORWARDED_ALLOW_IPS, Blaxel\'s BL_REGION). Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 67 true, 11 false (86%), so stable again (C had made it beta in 0.8 on one repository): pmndrs/zustand\'s `MDX` and `HOME_REDIRECT` in CONTRIBUTING.md, read by the pmndrs/docs checkout the step tells you to make, are guarded (a variable set in another repository\'s checkout is not judged), fixture `env-unused-zustand-other-checkout`; left: variables of another product the docs configure (LiteLLM\'s in adk-python, TAVILY_API_KEY in langgraph).',
  },
  'env-undocumented': {
    maturity: 'stable',
    why: 'Already info. the 0.5 precision runs: every info on flask, python-sdk, codex, openai-agents-js, OpenHands and vercel/chatbot checked, samples on vercel/ai, browser-use and cline: all true; test-runner variables (PLAYWRIGHT) and test configs closed by guards.',
  },
  'symbol-missing': {
    maturity: 'beta',
    why: 'No true finding on any real repository before the Drift Hall: all 36 of its first-run findings (python-sdk 28, pydantic-ai 7, flask 1) were false and became guards (a package name bound as a variable, members need a call, history per sentence). Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 7 true, 28 false (20%), the false ones in release notes and proposals (scrapy\'s `docs/news.rst`, `sep/`).',
  },
  'docstring-param-unknown': {
    maturity: 'stable',
    why: '27 true errors, each checked: vercel/ai 2, OpenHands 1, cline 13, zod 1 (`ZodDiscriminatedUnion.create` `@param types`), Textualize/rich 9, vitejs/vite 1; none false on the Oct 18 sweep. First-run false positives (a `# noqa` comment hiding a parameter, `_x` for `x`, inline object fields, JSDoc in prose) closed by guards. Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift): 172 true, 18 false (91%): type-first entries (`int (size)`), section headers indented inside `Args:`, nameless JSDoc `@param {object} A server address`, sample docstrings in a code block.',
  },
  'docstring-param-undocumented': {
    maturity: 'stable',
    why: 'Already info. Hand-checked on flask (4), python-sdk (13), codex, cline, openai-agents-js, pallets/click (11): all true once docstrings that document a minority of parameters on purpose were left out (at least half must be documented).',
  },
  'example-unknown-keyword': {
    maturity: 'beta',
    why: 'Static example checks since 0.3: every finding on the 8 original repositories real drift; the 0.5 language runs regression runs unchanged. But the Drift Hall (Oct 18: 63 repositories Staleproof was never tuned on, every warning and error hand-checked, staleproof.dev/#/drift) found 13 true, 876 false (1%): the first `@overload` taken without overload resolution made every `instructor.from_provider(...)` client the wrong class (567-labs/instructor 851), receivers typed wrong (`with X() as y`, `await`, containers). After the 0.8.0 guards, on the 61 hall repositories other than crewAI and haystack: 9 true, 882 false before, 9 true, 30 false after (23%): an overloaded call\'s result is known only when every overload agrees, and a name on a docs page is its latest binding above the line. Left: history pages (fastmcp\'s `docs/v2`, mem0), receivers of `with` and `await`.',
  },
  'example-too-many-arguments': {
    maturity: 'beta',
    why: 'True: vercel/ai 4 (constructors that dropped `settings`). zod\'s 14 first-run false positives (API listings, versioned docs) closed by guards. Drift Hall: 11 true, 21 false (34%). After the 0.8.0 guards, on the 61 hall repositories other than crewAI and haystack: 5 true, 21 false before, 3 true, 7 false after (30%): a function the page defines itself is the reader\'s code and is not judged (pmndrs/jotai\'s tutorial that rebuilds `atom`, fixture `example-too-many-arguments-jotai-tutorial`), which also drops 2 true findings (a snippet calling its own function wrongly: TanStack/router, react-router).',
  },
  'example-missing-argument': {
    maturity: 'beta',
    why: 'True on flask and pmndrs/jotai (`useFocusAtom(anAtom)` without `keyFn`, a hook the page defines, no longer judged in 0.8.0); the zero-argument calls of API listings are guarded (zod). Drift Hall: 21 true, 856 false (2%). After the 0.8.0 guards, on the 61 hall repositories other than crewAI and haystack: 9 true, 855 false before, 5 true, 37 false after (12%): overloads that disagree (instructor 456), arity from a declared function type (`export const f: F = (a, b) => …`, TanStack/router 315), functions the page defines (vitejs/vite\'s preset shadowed by an import, fixture `example-missing-argument-vite-shadowed-by-import`).',
  },
  'example-missing-import': {
    maturity: 'beta',
    why: 'True: pmndrs/jotai 4 (`atomFamily` and `loadable` left `jotai/utils` in v3), pmndrs/valtio 1 (a typo). But JavaScript and TypeScript exports are not modelled completely: Drift Hall 175 true, 1 818 false (9%): `exports` maps and subpaths, `export *` chains, CommonJS and `export =` typings, unbuilt `dist/` entries. After the 0.8.0 guards, on the 61 hall repositories other than crewAI and haystack: 77 true, 1 660 false before, 77 true, 1 624 false after (5%): names bound by destructuring and exported by a list (execa 24), re-exports from files the checkout lacks, `.d.ts` subpaths (vite). Still open: types only a hand-written `index.d.ts` declares (declaration files are not indexed). Fixtures `example-missing-import-*`.',
  },
  'example-missing-attribute': {
    maturity: 'beta',
    why: 'Drift Hall: 24 true, 676 false (3%), mostly an exported instance read as the module of the same name (trpc\'s `initTRPC`, TanStack/query\'s managers). After the 0.8.0 guards, on the 61 hall repositories other than crewAI and haystack: 24 true, 679 false before, 24 true, 594 false after (4%): an alternative tab with no import of its own (zod\'s "Zod Mini" blocks on api.mdx, 18) is not judged against the default tab\'s import, fixture `example-missing-attribute-zod-mini-tabs`; vitejs/vite 2 (`ModuleRunner.import`, a method the class defines) still open.',
  },
  'example-removed': {
    maturity: 'stable',
    why: 'Reported only by pull request checks, from the graph: an example calls a symbol the pull request removes or renames, read from the diff itself. No false positive reported yet.',
  },
};

/** Beta rules, in registry order. */
export const BETA_RULES: readonly RuleId[] = (Object.keys(MATURITY) as RuleId[]).filter((id) => MATURITY[id].maturity === 'beta');

export function maturityOf(rule: RuleId): Maturity {
  return MATURITY[rule]?.maturity ?? 'stable';
}

/**
 * Whether a static example check of this kind (`example-<kind>`: a MISMATCH edge in the audit, a predicted break in
 * a pull request check or a hook) counts: its rule is stable, or the repository's `[rules]` opts it in at
 * `warning` or `error`. Otherwise it is listed apart and never fails, blocks or lowers a score.
 */
export function exampleKindCounts(kind: string, rules?: Partial<Record<string, RuleSetting>> | null): boolean {
  const rule = `example-${kind}`;
  const setting = rules?.[rule];
  return maturityOf(rule as RuleId) !== 'beta' || setting === 'warning' || setting === 'error';
}

/** The registry's rules with their maturity attached (src/lint/rules.ts). */
export function withMaturity<T extends { id: RuleId }>(rules: T[]): (T & { maturity: Maturity; maturityWhy: string })[] {
  return rules.map((r) => ({ ...r, maturity: MATURITY[r.id].maturity, maturityWhy: MATURITY[r.id].why }));
}

/**
 * The severity a finding is reported at, and whether it is lower confidence: a `[rules]` setting wins and
 * makes the rule trusted (naming a rule is a decision about it), else a beta rule reports at `info`, lower
 * confidence, else the rule's own severity. `cap`, a check's own ceiling for one finding (an anchor that another
 * docs site resolves), lowers the result and is never raised by config. The fingerprint never depends on this.
 */
export function reportedSeverity(rule: { severity: Severity; maturity: Maturity }, setting?: RuleSetting, cap?: Severity): { severity: Severity; lowerConfidence: boolean } {
  const capped = (s: Severity): Severity => (cap && SEVERITY_RANK[cap] < SEVERITY_RANK[s] ? cap : s);
  if (setting && setting !== 'off') return { severity: capped(setting), lowerConfidence: false };
  if (rule.maturity === 'beta') return { severity: 'info', lowerConfidence: true };
  return { severity: capped(rule.severity), lowerConfidence: false };
}

export function isLowerConfidence(f: Pick<Finding, 'lowerConfidence'>): boolean {
  return f.lowerConfidence === true;
}

/** The findings that may fail a check or lower a score. */
export function trusted<T extends Pick<Finding, 'lowerConfidence'>>(findings: readonly T[]): T[] {
  return findings.filter((f) => !isLowerConfidence(f));
}

/**
 * For findings read back from a graph (audit, PR checks): the stored flag when the graph has it, else (indexed
 * before 0.8) the rule's maturity today. Unknown rules are trusted, as before.
 */
export function storedLowerConfidence(rule: string, stored: boolean | null | undefined): boolean {
  if (typeof stored === 'boolean') return stored;
  return (MATURITY as Record<string, RuleMaturity | undefined>)[rule]?.maturity === 'beta';
}

/** The title of the group lower-confidence findings are listed under, after the others. */
export const LOWER_CONFIDENCE_TITLE = 'Lower confidence (beta rules)';

/** One line under that title. */
export const LOWER_CONFIDENCE_NOTE =
  'Shown for review: these rules are still earning trust, so their findings never fail a check or lower the score. Opt a rule in with `[rules] "<id>" = "warning"` in .staleproof.toml.';
