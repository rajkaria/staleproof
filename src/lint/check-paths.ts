import { posix } from 'node:path';
import { normalizeRepoPath, type RepoFacts } from './facts.js';
import type { ScannedDoc, Span } from './scan.js';
import type { RawFinding } from './engine.js';
import type { Severity } from './types.js';

/** A link finding: `severity` lowers the rule's level for this one finding (an anchor another docs site may still resolve). */
export type LinkFinding = RawFinding & { severity?: Severity };

/** Output and generated directories docs may rightly name before they exist. */
const GENERATED = /^(dist|build|out|target|coverage|node_modules|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.venv|venv|__pycache__|site|_build|public\/build)(\/|$)/;
/** The sentence says the path is created, not that it exists. */
const CREATED = /\b(creat(e|es|ed|ing)|generat(e|es|ed|ing)|writ(e|es|ten|ing)|output(s|ted)?|produc(e|es|ed)|emit(s|ted)?|will be|download(s|ed)?|sav(e|es|ed) (to|as|in)|scaffold(s|ed)?|touch|mkdir|new file|add (a|an|the) file)\b/i;
const EXT = /\.[A-Za-z0-9]{1,8}$/;
/** Folders a docs site is built from. */
const DOCS_ROOTS = ['docs', 'doc', 'documentation', 'website/docs', 'site/docs', 'docs/src', 'docs/content'];
const TEST_DIR = /(^|\/)(tests?|__tests__|fixtures?|testdata|spec|e2e)\//;
/**
 * A path segment that stands for a name the reader fills in: `NNNN` (an issue number), `XXX`, `YYYY`,
 * `YYYY-MM-DD`, `your_provider`, `my-app`. A path holding one is a template, never a claim (zod's triage skill:
 * "cross-link with a relative `../NNNN/results.md`").
 */
const PLACEHOLDER_SEGMENT = /^(?:([A-Z])\1{2,}|Y{2,4}(?:-MM(?:-DD)?)?|(?:your|my)[_-][\w.-]*)$/;
/**
 * Pages that record the repository as it was: release notes and changelogs, plans, proposals, decision
 * records, a drafted issue. A path they name may rightly be gone (drizzle's `changelogs/`, mem0's
 * `docs/changelog/`, inspector's `*_plan.md`, instructor's `github_issue.md`).
 */
const HISTORY_PAGE =
  /(^|\/)(changelogs?|release[-_]?notes|releases|news|proposals?|rfcs?|adrs?|decisions|plans|sep)\/|(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|RELEASES?|RELEASE[-_]NOTES)([-_.][^/]*)?$|[-_.](plan|proposal|rfc)\.(md|mdx|markdown|rst)$|(^|\/)([^/]*[-_])?issues?([-_][^/]*)?\.(md|mdx)$/i;
/**
 * A page that is a template for another project or document: an `AGENTS.md` in a `templates/` folder that a CLI
 * copies into the user's project (crewAI), a decision-record `template.md`, a `*_template.md` a skill fills in.
 * Its paths and links describe what the copy will have.
 */
const TEMPLATE_PAGE = /(^|\/)(templates?|_templates|scaffolds?|cookiecutter[^/]*|\{\{[^/]*\}\})\/|(^|\/)([^/]*[-_.])?template\.(md|mdx|markdown)$/i;
/** The words right after a span that make it a name of something else: "the `license/cla` check stays red". */
const NAMED_AFTER = /^`?\s*(?:status\s+)?(?:check|label|branch|tag)s?\b/i;
/** The words right before it: "Branch naming: `ui-v2/feature-description`". */
const NAMED_BEFORE = /\b(?:branch(?:es)?|branch[- ]nam(?:e|es|ing)|labels?|tags?)\s*:?\s*`?$/i;
/**
 * A record of the change that removed the path (history, not a claim that it exists): a gone-word and the pull
 * request, issue or commit that did it on the same line ("Deleting `.github/dependabot.yml` outright (#2235)").
 * A gone-word alone is not enough: "ours removed `lib/removed.ts`" still claims the docs are current.
 */
const GONE_REF = /(?:^|[\s(\[])(?:#\d+|[0-9a-f]{7,40})\b|\b(?:PR|pull request|commit)\b/;
const GONE = /\b(?:delet(?:ed|ing)|remov(?:ed|ing)|dropp(?:ed|ing)|retired|replaced the old|moved (?:away )?from|renamed from|no longer (?:exists?|used|there)|used to (?:be|live))\b/i;
/** Where another tool looks, not what this repository has: "Copilot CLI discovers `.claude/skills/` alongside `.github/skills/`". */
const TOOL_LOOKUP = /\b(?:discover(?:s|ed)?|looks? (?:in|for|at|under)|search(?:es)? (?:in|for)|reads? (?:from|skills|rules)|alongside|loads? from|picks? up)\b/i;
/** A directory outside the repository the page means on purpose: "a **sibling** directory ... `../mcp-inspector-v2-2661`". */
const OUTSIDE = /\b(?:sibling|worktree|outside (?:the|this) repo(?:sitory)?|next to (?:the|this) (?:repo(?:sitory)?|checkout))\b/i;
/** File extensions a module path leaves out (`models/__init__`, `./__helpers`). */
const MODULE_EXTS = ['.py', '.pyi', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs'];

export interface PathRef {
  path: string;
  line?: number;
}

/**
 * The repository path a code span names, if it names one: `src/cli.ts`, `docs/`,
 * `./scripts/x.sh:12`, `src/a.ts#L40`. Not paths: URLs, absolute and home paths,
 * placeholders (`path/to/<file>`, `{name}`, `*.ts`), commands, package scopes, bare
 * file names.
 */
export function pathInSpan(text: string): PathRef | undefined {
  let t = text.trim().replace(/^["']|["']$/g, '');
  if (!t || /\s/.test(t) || t.length > 200) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[A-Za-z0-9_./-]+:\d+(?::\d+)?$/.test(t)) return undefined;
  if (/^(\/|~|\$|-|@|\\)/.test(t) || t.includes('://')) return undefined;
  let line: number | undefined;
  const lm = /^(.*?)(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(t);
  if (lm && lm[1]) {
    t = lm[1];
    line = Number(lm[2] ?? lm[3]);
  }
  if (/[<>{}*?[\]|,;=%$!`'"()\\:#&^]/.test(t) || t.includes('...')) return undefined;
  if (!t.includes('/')) return undefined;
  if (!/^(\.{1,2}\/)*[\w@.+-]+(\/[\w@.+-]+)*\/?$/.test(t)) return undefined;
  // Dotted identifiers and versions (`a.b/c` is fine, `1.2/3` is a ratio or date).
  if (/^\d/.test(t)) return undefined;
  return { path: t, ...(line ? { line } : {}) };
}

/** Where a path written in `docPath` can point: repository root first, then the page's directory. */
function candidates(ref: string, docPath: string): string[] {
  const docDir = posix.dirname(docPath);
  const explicit = ref.startsWith('./') || ref.startsWith('../');
  const join = (dir: string) => normalizeRepoPath(posix.join(dir === '.' ? '' : dir, ref));
  const rootRel = normalizeRepoPath(ref);
  // Skills and packages name paths from their own folder (`scripts/x.py` next to SKILL.md):
  // try the page's folder and each folder above it.
  const ancestors: (string | undefined)[] = [];
  for (let d = posix.dirname(docDir); d !== '.' && d !== '/'; d = posix.dirname(d)) ancestors.push(join(d));
  // `./scripts/test` in a nested page is usually a command run from the root; `a/b` is root first.
  const order = explicit
    ? [join(docDir), ...(ref.startsWith('./') ? [...ancestors, rootRel] : [])]
    : [rootRel, join(docDir), ...ancestors];
  return [...new Set(order.filter((x): x is string => x !== undefined))];
}

/** Judge a plain `a/b` only when `a` is something in the repository (else it is a slug, a MIME type, a branch name). */
function rooted(ref: string, docPath: string, facts: RepoFacts): boolean {
  if (ref.startsWith('./') || ref.startsWith('../')) return true;
  const first = ref.split('/')[0]!;
  const docDir = posix.dirname(docPath);
  return facts.topLevel.has(first) || facts.exists(docDir === '.' ? first : `${docDir}/${first}`);
}

export interface PathClaim {
  span: Span;
  ref: PathRef;
  candidates: string[];
  /** Its first folder is in the repository; otherwise only git history can make it a finding. */
  rooted: boolean;
}

/** Path claims of a page that `checkPaths` will judge (also used to batch the git-ignore lookup). */
export function pathClaims(doc: ScannedDoc, facts: RepoFacts): PathClaim[] {
  const out: PathClaim[] = [];
  for (const span of doc.spans) {
    const ref = pathInSpan(span.text);
    if (!ref) continue;
    const cands = candidates(ref.path, doc.path);
    if (!cands.length || cands.every((c) => GENERATED.test(c))) continue;
    out.push({ span, ref, candidates: cands, rooted: rooted(ref.path, doc.path, facts) });
  }
  return out;
}

/**
 * What is known about a path that does not exist: renamed (and to what), deleted in
 * history, or a file of the same name elsewhere (moved). Undefined when the
 * repository never had it.
 */
function whatHappened(path: string, facts: RepoFacts, sameName: boolean): { movedTo?: string; deletedIn?: string } | undefined {
  const movedTo = facts.movedTo(path);
  if (movedTo) return { movedTo };
  const under = facts.deleted.has(path) ? undefined : [...facts.deleted.keys()].find((d) => d.startsWith(`${path}/`));
  const deletedIn = facts.deleted.get(path) ?? (under ? facts.deleted.get(under) : undefined);
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (sameName && EXT.test(name)) {
    // Same name elsewhere under the same top-level directory, outside tests and fixtures: moved.
    const top = path.split('/')[0];
    const inTests = TEST_DIR.test(path);
    const same = facts.withBasename(name).filter((f) => f.split('/')[0] === top && (inTests || !TEST_DIR.test(f)));
    if (same.length === 1) return { movedTo: same[0] };
  }
  if (deletedIn) return { deletedIn };
  return undefined;
}

/** Facts derived once per repository for the guards below. */
interface Derived {
  dirsByName?: Map<string, string[]>;
  redirects: Map<string, Promise<Set<string>>>;
  staticDirs?: string[];
}
const DERIVED = new WeakMap<RepoFacts, Derived>();
function derived(facts: RepoFacts): Derived {
  let d = DERIVED.get(facts);
  if (!d) DERIVED.set(facts, (d = { redirects: new Map() }));
  return d;
}

const nameKey = (s: string) => s.toLowerCase().replace(/-/g, '_');

/** Directories of the repository by base name (`-` and `_` alike, any case). */
function dirsNamed(facts: RepoFacts, name: string): string[] {
  const d = derived(facts);
  if (!d.dirsByName) {
    d.dirsByName = new Map();
    for (const dir of facts.dirs) {
      const k = nameKey(dir.slice(dir.lastIndexOf('/') + 1));
      const list = d.dirsByName.get(k) ?? [];
      list.push(dir);
      d.dirsByName.set(k, list);
    }
  }
  return d.dirsByName.get(nameKey(name)) ?? [];
}

/** A file or folder at `path`, or a module there written without its extension (`models/__init__`, `./__helpers`). */
function existsAsModule(path: string, facts: RepoFacts): boolean {
  return facts.exists(path) || (!EXT.test(path) && MODULE_EXTS.some((e) => facts.exists(`${path}${e}`)));
}

/** Some file or folder under `base` is `rest` or ends with it (as a module too). */
function endsUnder(base: string, rest: string, facts: RepoFacts): boolean {
  if (!rest) return false;
  const root = base === '' || base === '.' ? '' : `${base}/`;
  if (existsAsModule(`${root}${rest}`, facts)) return true;
  const tails = [`/${rest}`, ...(EXT.test(rest) ? [] : MODULE_EXTS.map((e) => `/${rest}${e}`))];
  const hit = (p: string) => p.startsWith(root) && tails.some((t) => p.endsWith(t));
  for (const f of facts.files) if (hit(f)) return true;
  for (const d of facts.dirs) if (hit(d)) return true;
  return false;
}

/** The lines of the paragraph holding `line` (1-based), bounded by blank lines and headings. */
function paragraphOf(doc: ScannedDoc, line: number): { from: number; to: number } {
  const blank = (i: number) => !(doc.lines[i - 1] ?? '').trim() || /^\s{0,3}#{1,6}\s/.test(doc.lines[i - 1] ?? '');
  let from = line;
  while (from > 1 && !blank(from - 1)) from--;
  let to = line;
  while (to < doc.lines.length && !blank(to + 1)) to++;
  return { from, to };
}

/** The static folders a Cursor rule's `globs:` frontmatter targets (`packages/upgrade/**\/*.test.tsx` → `packages/upgrade`). */
function globBases(doc: ScannedDoc): string[] | undefined {
  if (doc.lines[0]?.trim() !== '---') return undefined;
  const end = doc.lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const fm = doc.lines.slice(1, end > 0 ? end : 0);
  const at = fm.findIndex((l) => /^globs\s*:/.test(l));
  if (at < 0) return undefined;
  let raw = fm[at]!.replace(/^globs\s*:/, '');
  for (let i = at + 1; i < fm.length && /^\s+-\s/.test(fm[i]!); i++) raw += `,${fm[i]!.replace(/^\s+-\s/, '')}`;
  const globs = raw
    .replace(/[[\]]/g, '')
    .split(',')
    .map((g) => g.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const bases = globs.map((g) => {
    const parts = g.replace(/^\.\//, '').split('/');
    const i = parts.findIndex((p) => /[*?{[]/.test(p));
    return parts.slice(0, i < 0 ? parts.length - 1 : i).join('/');
  });
  return bases.length ? [...new Set(bases)] : undefined;
}

/** Why a missing path is not a claim about this repository, when it is not. */
function notAClaim(doc: ScannedDoc, span: Span, ref: PathRef, paragraph: string): string | undefined {
  const line = doc.lines[span.line - 1] ?? '';
  if (HISTORY_PAGE.test(doc.path)) return 'a page of history';
  if (TEMPLATE_PAGE.test(doc.path)) return 'a template for another project';
  if (ref.path.split('/').some((s) => PLACEHOLDER_SEGMENT.test(s.replace(/\.[^.]+$/, '')))) return 'a placeholder';
  if (NAMED_AFTER.test(line.slice(span.endColumn - 1)) || NAMED_BEFORE.test(line.slice(0, span.column - 1))) return 'a check, label or branch name';
  // The prose only: a path's own words (`lib/removed.ts`) say nothing.
  const prose = line.replace(/(`+)(?:[^`]|[^`].*?[^`])\1(?!`)/g, ' ');
  if (GONE.test(prose) && GONE_REF.test(prose)) return 'a record of its removal';
  if (/^\.[\w-]+\//.test(ref.path) && TOOL_LOOKUP.test(prose)) return 'where another tool looks';
  if (ref.path.startsWith('../') && OUTSIDE.test(paragraph)) return 'outside the repository on purpose';
  return undefined;
}

/**
 * Where a missing path resolves after all: a module written without its extension; a path relative to a package
 * or skill the same paragraph names (`prefect-snowflake`'s `experimental/workers/spcs.py`, the `mem0-integrate`
 * skill's `references/pipeline.md`); in an agent file, an import path relative to the code the file governs
 * (`../fixtures` from a test below `ui-v2/e2e/`, a Cursor rule's `./__helpers` from the files its `globs` match).
 */
function resolvesElsewhere(doc: ScannedDoc, span: Span, ref: PathRef, cands: string[], facts: RepoFacts, surface: string, para: { from: number; to: number }): boolean {
  if (cands.some((c) => existsAsModule(c.replace(/\/+$/, ''), facts))) return true;
  const rest = ref.path.replace(/^(\.{1,2}\/)+/, '').replace(/\/+$/, '');
  const names = doc.spans
    .filter((s) => s !== span && s.line >= para.from && s.line <= para.to && /^[\w.@-]+$/.test(s.text.replace(/['’]s$/, '')))
    .map((s) => s.text.replace(/['’]s$/, '').replace(/^@[\w.-]+\//, ''));
  for (const n of names) for (const d of dirsNamed(facts, n)) if (endsUnder(d, rest, facts)) return true;
  if (surface !== 'agent') return false;
  const docDir = posix.dirname(doc.path);
  if (ref.path.startsWith('../') && docDir !== '.' && endsUnder(docDir, rest, facts)) return true;
  if (ref.path.startsWith('./') || ref.path.startsWith('../')) {
    for (const base of globBases(doc) ?? []) if (endsUnder(base, rest, facts)) return true;
  }
  return false;
}

/**
 * A path like its siblings' (`tests/llm/test_provider/evals/` where `test_gemini/evals` and `test_writer/evals`
 * exist): a pattern for any of them. Only with something below the varying segment, so a missing file next to
 * similar files still counts.
 */
function patternOfSiblings(path: string, facts: RepoFacts): boolean {
  const parts = path.replace(/\/+$/, '').split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = parts.slice(0, i).join('/');
    if (!facts.exists(parent) || facts.exists([...parts.slice(0, i + 1)].join('/'))) continue;
    const seg = parts[i]!;
    const cut = seg.search(/[_-]/);
    if (cut <= 0 || cut === seg.length - 1) return false;
    const prefix = `${parent ? `${parent}/` : ''}${seg.slice(0, cut + 1)}`;
    const rest = parts.slice(i + 1).join('/');
    const siblings = [...facts.dirs].filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes('/') && facts.exists(`${d}/${rest}`));
    return siblings.length >= 2;
  }
  return false;
}

export async function checkPaths(doc: ScannedDoc, facts: RepoFacts, claims: PathClaim[], surface: 'agent' | 'readme' | 'docs' = 'docs'): Promise<RawFinding[]> {
  const out: RawFinding[] = [];
  for (const { span, ref, candidates: cands, rooted: isRooted } of claims) {
    const found = cands.find((c) => facts.exists(c));
    if (!found) {
      if (CREATED.test(doc.lines[span.line - 1] ?? '')) continue;
      const para = paragraphOf(doc, span.line);
      if (notAClaim(doc, span, ref, doc.lines.slice(para.from - 1, para.to).join(' '))) continue;
      if (resolvesElsewhere(doc, span, ref, cands, facts, surface, para)) continue;
      const shown = ref.path.replace(/\/+$/, '');
      // Agent instructions describe this repository; docs often describe the reader's or another
      // project's layout, so there a missing path counts only when this repository had it.
      // A file of the same name elsewhere is a hint, not evidence: used for agent files only.
      const history = cands.map((c) => whatHappened(c.replace(/\/+$/, ''), facts, surface === 'agent')).find(Boolean);
      if (!history && (surface !== 'agent' || !isRooted)) continue;
      if (!history && cands.some((c) => patternOfSiblings(c, facts))) continue;
      const message = history?.movedTo
        ? `\`${shown}\` does not exist; it moved to \`${history.movedTo}\`.`
        : history?.deletedIn
          ? `\`${shown}\` does not exist; it was deleted in ${history.deletedIn}.`
          : `\`${shown}\` does not exist in the repository.`;
      out.push({
        rule: 'path-missing',
        span,
        subject: shown,
        message,
        looked: cands.length > 1 ? `the repository root and ${posix.dirname(doc.path)}/` : 'the repository files',
        target: cands[0],
        ...(history?.movedTo ? { candidates: [history.movedTo] } : {}),
      });
      continue;
    }
    if (ref.line && !facts.isDir(found) && !HISTORY_PAGE.test(doc.path)) {
      const count = await facts.lineCount(found);
      if (count !== undefined && ref.line > count) {
        out.push({
          rule: 'line-out-of-range',
          span,
          subject: `${found}:${ref.line}`,
          message: `\`${found}\` has ${count} lines; line ${ref.line} does not exist.`,
          looked: found,
          target: found,
        });
      }
    }
  }
  return out;
}

/** Link targets that are not files of this repository. */
function externalLink(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith('//') ||
    target.startsWith('/') ||
    /[{}<>$]|\{\{/.test(target) ||
    target.startsWith('@')
  );
}

/** A link written as a host name without `https://`: `github.com/textualize/rich`, `www.example.org`. */
const SCHEMELESS_HOST = /^(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|dev|ai|app|co|sh|me|so)(?:\/|$)/i;

export interface LinkCandidates {
  file: string | undefined;
  anchor: string;
  /** Files the link may resolve to, in order. */
  tries: string[];
}

export function linkTarget(target: string, docPath: string, docsFramework: boolean): LinkCandidates | undefined {
  if (externalLink(target)) return undefined;
  const hash = target.indexOf('#');
  let file = hash >= 0 ? target.slice(0, hash) : target;
  const anchor = hash >= 0 ? target.slice(hash + 1) : '';
  file = file.replace(/\?.*$/, '');
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep it as written
  }
  if (!file) return { file: undefined, anchor, tries: [] };
  const docDir = posix.dirname(docPath);
  const base = normalizeRepoPath(posix.join(docDir === '.' ? '' : docDir, file));
  if (base === undefined) return undefined;
  const tries = [base];
  if (!EXT.test(file) || /\.(html?)$/.test(file)) {
    const stem = base.replace(/\.html?$/, '').replace(/\/+$/, '');
    tries.push(`${stem}.md`, `${stem}.mdx`, `${stem}.rst`, `${stem}/index.md`, `${stem}/index.mdx`, `${stem}/README.md`, `${stem}/readme.md`);
  } else if (!/\.(mdx?|rst|markdown)$/i.test(file)) {
    // A page named after a code file (react-router's `entry.server.tsx.md`), linked as the site serves it.
    tries.push(`${base}.md`, `${base}.mdx`);
  }
  // Framework sites route extensionless links themselves; only a link with an extension is a file reference there.
  // A host name without its scheme (`[Rich](github.com/textualize/rich)`) is no route: it is a broken link everywhere.
  if (docsFramework && !EXT.test(file) && !SCHEMELESS_HOST.test(file)) return { file: undefined, anchor: '', tries: [] };
  return { file: base, anchor, tries };
}

/**
 * A fragment the docs site includes into other pages (`--8<-- "snippets/x.md"`, `{!./docs_src/…!}`, mkdocs code
 * annotations, `_includes/`, `partials/`): its links are written from the page that includes it.
 */
const FRAGMENT_PAGE = /(^|\/)(docs_src|_?snippets?|_includes|includes|_?partials?)\/|\/annotations\//i;
/** Sample data scanned as docs (a Notion export a loader's tests read). */
const DATA_PAGE = /(^|\/)(example_data|test_?data|__fixtures__|fixtures?)\//i;
/** A page whose site serves it without its order prefix (`01-overview.md` at `/docs/overview`: svelte, gradio). */
const NUMBERED = /^\d+[-_][^/]/;
/** A placeholder link target: `[English version](ENGLISH_VERSION_URL)`, `[text](url)` in a prompt, `[_]: _`. */
const PLACEHOLDER_LINK = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|url|URL|link|href|path|_+)$/;

/** Keys of a doc-builder `_redirects.yml` (`old/route: new/route`): routes the site still serves. */
function redirectKeys(file: string, facts: RepoFacts): Promise<Set<string>> {
  const cache = derived(facts).redirects;
  let p = cache.get(file);
  if (!p) {
    p = facts.text(file).then((text) => new Set([...(text ?? '').matchAll(/^([^#\s][^:]*):\s*\S/gm)].map((m) => m[1]!.trim().replace(/\/+$/, ''))));
    cache.set(file, p);
  }
  return p;
}

/** The link is a route a `_redirects.yml` in the page's folder or above serves (huggingface_hub's docs). */
async function redirected(docPath: string, written: string, facts: RepoFacts): Promise<boolean> {
  const target = normalizeRepoPath(posix.join(posix.dirname(docPath), written));
  if (!target) return false;
  for (let d = posix.dirname(docPath); ; d = posix.dirname(d)) {
    const dir = d === '.' || d === '/' ? '' : d;
    const file = `${dir ? `${dir}/` : ''}_redirects.yml`;
    const rel = (dir ? posix.relative(dir, target) : target).replace(/\.(mdx?|html?)$/, '').replace(/\/+$/, '');
    if (facts.files.has(file) && (await redirectKeys(file, facts)).has(rel)) return true;
    // A translation's folder (`docs/source/ko/`) serves the English folder's redirects too.
    const lang = /^(.*\/)?([a-z]{2}(?:-[a-z]{2,4})?)$/.exec(dir);
    const english = lang && lang[2] !== 'en' ? `${lang[1] ?? ''}en/_redirects.yml` : undefined;
    if (english && facts.files.has(english) && (await redirectKeys(english, facts)).has(rel)) return true;
    if (!dir) return false;
  }
}

/** Folders Storybook serves at its root (`staticDirs` in `.storybook/main.*`), as repository paths. */
async function storybookStatic(facts: RepoFacts): Promise<string[]> {
  const d = derived(facts);
  if (!d.staticDirs) {
    d.staticDirs = [];
    for (const f of facts.files) {
      if (!/(^|\/)\.storybook\/main\.[cm]?[jt]s$/.test(f)) continue;
      const m = /staticDirs\s*:\s*\[([^\]]*)\]/.exec((await facts.text(f)) ?? '');
      for (const s of m ? m[1]!.matchAll(/["']([^"']+)["']/g) : []) {
        const p = normalizeRepoPath(posix.join(posix.dirname(f), s[1]!));
        if (p !== undefined) d.staticDirs.push(p);
      }
    }
  }
  return d.staticDirs;
}

/** Path prefixes a generated page says it leaves out ("This build omits the other `./references/...` files": pydantic/logfire). */
function omitted(doc: ScannedDoc): string[] {
  const out: string[] = [];
  for (const s of doc.spans) {
    if (!/\b(?:omit(?:s|ted)?|not (?:bundled|included|shipped))\b/i.test(doc.lines[s.line - 1] ?? '')) continue;
    const m = /^(?:\.\/)?([\w.-]+(?:\/[\w.-]+)*\/)(?:\.\.\.|…)?$/.exec(s.text);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Why a link that resolves to no file is not broken where its site serves it, when it is not. */
async function routedBySite(doc: ScannedDoc, written: string, facts: RepoFacts): Promise<boolean> {
  if (TEMPLATE_PAGE.test(doc.path) || DATA_PAGE.test(doc.path) || PLACEHOLDER_LINK.test(written)) return true;
  const rest = written.replace(/^(\.{1,2}\/)+/, '').replace(/\/+$/, '');
  if (FRAGMENT_PAGE.test(doc.path) && rest && [...facts.files].some((f) => f === rest || f.endsWith(`/${rest}`))) return true;
  const extensionless = !EXT.test(posix.basename(rest));
  if (extensionless && doc.path.split('/').some((s) => NUMBERED.test(s))) return true;
  if (await redirected(doc.path, written, facts)) return true;
  if (omitted(doc).some((prefix) => written.replace(/^\.\//, '').startsWith(prefix))) return true;
  if (/\.(svg|png|jpe?g|gif|webp|ico)$/i.test(rest) && (await storybookStatic(facts)).some((s) => facts.exists(`${s}/${rest}`))) return true;
  return false;
}

/** Whether a site, not GitHub, builds this page's heading ids (MkDocs, VitePress, Docusaurus …; hf doc-builder's `_toctree.yml`). */
function siteSlugger(docPath: string, facts: RepoFacts): boolean {
  if (facts.docsFramework) return true;
  for (let d = posix.dirname(docPath); d !== '.' && d !== '/' && d !== ''; d = posix.dirname(d)) if (facts.files.has(`${d}/_toctree.yml`)) return true;
  return false;
}

export async function checkLinks(doc: ScannedDoc, facts: RepoFacts): Promise<LinkFinding[]> {
  const out: LinkFinding[] = [];
  for (const link of doc.links) {
    const t = linkTarget(link.text, doc.path, facts.docsFramework);
    if (!t) continue;
    let resolved: string | undefined = doc.path;
    if (t.file !== undefined) {
      resolved = t.tries.find((c) => facts.exists(c));
      // A docs site generates pages into folders the repository does not have (API reference, plugins).
      if (!resolved && facts.docsFramework && !facts.exists(posix.dirname(t.file)) && !SCHEMELESS_HOST.test(link.text)) continue;
      // A root page included into a docs site (CONTRIBUTING.md) links relative to the docs folder.
      if (!resolved && DOCS_ROOTS.some((root) => facts.exists(`${root}/${link.text.split('#')[0]!.replace(/^\.\//, '')}`))) continue;
      if (!resolved && (await routedBySite(doc, link.text.split('#')[0]!.replace(/\?.*$/, ''), facts))) continue;
      if (!resolved) {
        const written = link.text.split('#')[0]!.replace(/\?.*$/, '');
        const fromRoot = normalizeRepoPath(written);
        const rootHit = fromRoot !== undefined && posix.dirname(doc.path) !== '.' && facts.exists(fromRoot) ? fromRoot : undefined;
        const up = rootHit ? posix.relative(posix.dirname(doc.path), rootHit) : undefined;
        out.push({
          rule: 'link-broken',
          span: link,
          subject: t.file,
          message: rootHit
            ? `The link is relative to this page, so it points to \`${t.file}\`, which does not exist; \`${rootHit}\` is at the repository root (link \`${up}\`).`
            : `The link target \`${t.file}\` does not exist.`,
          looked: t.tries.length > 1 ? t.tries.slice(0, 3).join(', ') : t.file,
          target: t.file,
          ...(up ? { candidates: [up] } : {}),
        });
        continue;
      }
    } else if (!link.text.startsWith('#')) continue;
    const anchor = t.anchor;
    if (!anchor || /^L\d+/.test(anchor) || anchor.startsWith(':~:') || /\.rst$/i.test(resolved)) continue;
    const anchors = await facts.anchors(resolved);
    if (!anchors) continue;
    let wanted = anchor;
    try {
      wanted = decodeURIComponent(anchor);
    } catch {
      // as written
    }
    if (anchors.has(wanted.toLowerCase())) continue;
    // An API reference generated on the site (hf doc-builder `[[autodoc]] CodeAgent`, mkdocstrings `::: pkg.mod`)
    // gives each object a dotted id (`#smolagents.CodeAgent`, `#textual.color--named-colors`) no heading shows.
    if (/^[\w-]+(?:\.[\w-]+)+(?:--[\w-]+)?$/.test(wanted) && /^\s*(?:\[\[autodoc\]\]|:::)\s+\S/m.test((await facts.text(resolved)) ?? '')) continue;
    const where = resolved === doc.path ? 'This page' : `\`${resolved}\``;
    // The subject is the anchor as written either way (fingerprints are frozen at version 1).
    const subject = `${resolved === doc.path ? '' : resolved}#${anchor}`;
    // The heading is there under another slugger (zustand's site keeps `’`, `,` and `(`): the
    // link works on that site and not on GitHub, so it is told apart and never lowers a score.
    const heading = await facts.headingForAnchor(resolved, wanted);
    if (heading && heading.anchor !== wanted.toLowerCase()) {
      const how = /[^\p{L}\p{N}\s_-]/u.test(wanted) ? 'whose slugger keeps punctuation' : 'that builds anchors another way';
      out.push({
        rule: 'anchor-missing',
        severity: 'info',
        span: link,
        subject,
        message:
          `The heading “${heading.title}” is ${resolved === doc.path ? 'on this page' : `in \`${resolved}\``}, but its GitHub anchor is \`#${heading.anchor}\`: ` +
          `\`#${anchor}\` works only on a docs site ${how}.`,
        looked: `headings of ${resolved}`,
        target: resolved,
        // No fix: the link works on the site, and the GitHub anchor would break it there (an empty list says so to the fixer).
        candidates: [],
      });
      continue;
    }
    out.push({
      rule: 'anchor-missing',
      span: link,
      subject,
      message: `${where} has no heading \`#${anchor}\`.`,
      looked: `headings of ${resolved}`,
      target: resolved,
      // A site that builds its own heading ids (MkDocs, hf doc-builder) may resolve it: no closest-heading fix there.
      candidates: siteSlugger(resolved, facts) ? [] : [...anchors],
    });
  }
  return out;
}
