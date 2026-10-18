import { fromRepl, JS_LANGS, pseudoModule } from '../indexer/docs.js';
import { scanDoc } from '../indexer/markdown.js';
import { matchesAny } from '../indexer/repo-config.js';
import { directoriesOf, olderOrTranslatedDocs } from '../indexer/repo.js';
import type { ExtractMemo, ParsedRepo } from '../indexer/index.js';
import { extractGoExample, goImportSpecs } from '../indexer/go.js';
import { extractPython } from '../indexer/python.js';
import type { Mismatch, SymbolTable } from '../indexer/resolve.js';
import { extractTs } from '../indexer/typescript.js';
import type { RawFinding } from './engine.js';

/**
 * The tab each line of a page sits in, by the tab's label: MDX/Docusaurus `<Tab value="Zod Mini">`, `<TabItem
 * value="…">`, `<Tab label="…">`, MkDocs `=== "…"`. Tabs with the same label are one reader's path through the page
 * (zod's "Zod" and "Zod Mini", synchronized by `groupId`), so their blocks share bindings; other tabs' do not.
 */
export function tabsOf(text: string): (string | undefined)[] {
  const lines = text.split('\n');
  const out: (string | undefined)[] = [undefined];
  let jsx: string | undefined;
  let mk: { label: string; indent: number } | undefined;
  for (const line of lines) {
    const open = /<(?:Tab|TabItem)\b[^>]*?\b(?:value|label|title)=(?:"([^"]*)"|'([^']*)'|\{["']([^"']*)["']\})/.exec(line);
    if (open) jsx = open[1] ?? open[2] ?? open[3];
    const mkOpen = /^(\s*)===\+?\s+"([^"]*)"/.exec(line);
    if (mkOpen) mk = { label: mkOpen[2]!, indent: mkOpen[1]!.length };
    else if (mk && line.trim() && line.length - line.trimStart().length <= mk.indent) mk = undefined;
    out.push(jsx ?? mk?.label);
    if (/<\/(?:Tab|TabItem)>/.test(line)) jsx = undefined;
  }
  return out;
}

/** Per-tab accumulation of a page's code: shared blocks go to every tab, a tab's block only to its own. */
class TabbedCode {
  private shared = '';
  private readonly tabs = new Map<string, string>();
  private readonly ownImports = new Set<string>();
  private first?: string;
  /**
   * A block in an alternative tab (not the page's first, default tab) that imports nothing in its own tab path
   * leans on the reader knowing that tab's module (zod's "Zod Mini" blocks use `z` from `zod/mini`, imported
   * nowhere on the page): the shared bindings would judge it against the default tab's import, so it is not judged.
   */
  unjudgeable(tab: string | undefined): boolean {
    return tab !== undefined && tab !== this.first && !this.ownImports.has(tab);
  }
  add(code: string, tab: string | undefined): string {
    if (tab !== undefined && /^\s*(?:import\s|from\s+[\w.]+\s+import\s|(?:const|let|var)\s.*=\s*require\()/m.test(code)) this.ownImports.add(tab);
    const join = (a: string) => (a ? `${a}\n${code}` : code);
    if (tab === undefined) {
      this.shared = join(this.shared);
      for (const [k, v] of this.tabs) this.tabs.set(k, join(v));
      // After a tab group, the page reads on with its first tab (the default one).
      return this.first !== undefined ? this.tabs.get(this.first)! : this.shared;
    }
    this.first ??= tab;
    const next = join(this.tabs.get(tab) ?? this.shared);
    this.tabs.set(tab, next);
    return next;
  }
}

export interface ExampleMismatch {
  path: string;
  /** Line in the docs page. */
  line: number;
  mismatch: Mismatch;
}

/**
 * The static example checks the indexer stores as MISMATCH edges, computed in memory
 * for one repository's docs pages: Python and JS/TS blocks are resolved cumulatively
 * per page (a later fragment sees an earlier block's bindings), exactly as at index time.
 */
export async function exampleMismatches(
  p: ParsedRepo,
  pages: { path: string; text: string }[],
  table: SymbolTable,
  codeRepos: Set<string>,
  /** The local parse cache: example blocks parsed once per content. */
  memo?: ExtractMemo,
): Promise<ExampleMismatch[]> {
  const extractPy = (source: string, o: Parameters<typeof extractPython>[1]) => (memo ? memo.extract('python', source, o, (x) => extractPython(source, x)) : extractPython(source, o));
  const extractJs = (source: string, o: Parameters<typeof extractTs>[1]) => (memo ? memo.extract('ts', source, o, (x) => extractTs(source, x)) : extractTs(source, o));
  const repo = p.checkout.repo;
  const out: ExampleMismatch[] = [];
  const keep = (m: Mismatch) => codeRepos.has(m.target.split(':')[0]!);
  const dirs = directoriesOf([...p.files.map((f) => f.path), ...pages.map((pg) => pg.path)]);
  for (const page of pages) {
    const doc = scanDoc(page.path, page.text);
    // Versioned copies of older docs and translated READMEs are not judged against today's code.
    const skipPage = matchesAny(page.path, p.config?.skipExamples ?? []) || olderOrTranslatedDocs(page.path, dirs);
    const tabs = tabsOf(page.text);
    const py = new TabbedCode();
    const js = new TabbedCode();
    let goImports: string[] = [];
    for (const ex of doc.examples) {
      const judged = !ex.directive && !skipPage;
      const tab = tabs[ex.lineno];
      if (ex.lang === 'python') {
        const code = fromRepl(ex.code);
        const acc = py.add(code, tab);
        const startLine = acc.split('\n').length - code.split('\n').length + 1;
        if (!judged || py.unjudgeable(tab)) continue;
        const mod = await extractPy(acc, { module: pseudoModule(repo, page.path), path: page.path }).catch(() => undefined);
        if (!mod) continue;
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const m of table.checkModule(repo, mod, startLine).filter(keep)) out.push({ path: page.path, line: ex.lineno + (m.line - startLine), mismatch: m });
        } finally {
          dispose();
        }
      } else if (JS_LANGS.has(ex.lang)) {
        const jsAcc = js.add(ex.code, tab);
        const startLine = jsAcc.split('\n').length - ex.code.split('\n').length + 1;
        if (!judged || js.unjudgeable(tab)) continue;
        const mod = await extractJs(jsAcc, { module: `${pseudoModule(repo, page.path)}_js`, path: page.path, tsx: true }).catch(() => undefined);
        if (!mod) continue;
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const m of table.checkModule(repo, mod, startLine).filter(keep)) out.push({ path: page.path, line: ex.lineno + (m.line - startLine), mismatch: m });
        } finally {
          dispose();
        }
      } else if (ex.lang === 'go') {
        // Each Go block is its own program; a fragment without imports gets the page's earlier ones.
        const earlier = goImports;
        goImports = [...goImports, ...goImportSpecs(ex.code)];
        if (!judged) continue;
        const mod = await extractGoExample(ex.code, { module: `${pseudoModule(repo, page.path)}_go`, path: page.path, earlierImports: earlier }).catch(() => undefined);
        if (!mod) continue;
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const m of table.checkModule(repo, mod, 1).filter(keep)) out.push({ path: page.path, line: ex.lineno + m.line - 1, mismatch: m });
        } finally {
          dispose();
        }
      }
    }
  }
  return out;
}

/** An example mismatch as a lint finding, located on the call as written in the page. */
export function exampleFinding(e: ExampleMismatch, lines: string[]): RawFinding {
  const text = lines[e.line - 1] ?? '';
  const needle = e.mismatch.text || e.mismatch.name.split('.').pop() || '';
  const at = needle ? text.indexOf(needle) : -1;
  const column = at >= 0 ? at + 1 : Math.max(1, text.length - text.trimStart().length + 1);
  const endColumn = at >= 0 ? at + 1 + needle.length : text.length + 1;
  const detail = e.mismatch.detail.replace(/\.?$/, '.');
  return {
    rule: `example-${e.mismatch.kind}` as RawFinding['rule'],
    span: { text: needle, line: e.line, column, endColumn },
    subject: e.mismatch.name,
    message: detail,
    looked: e.mismatch.target.replace(/^[^:]+:/, ''),
    target: e.mismatch.target,
  };
}
