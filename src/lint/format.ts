import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { falsePositiveUrl, FP_FORM_URL } from '../format/fp-link.js';
import { packageVersion } from '../pkg.js';
import { isLowerConfidence, LOWER_CONFIDENCE_NOTE, LOWER_CONFIDENCE_TITLE, reportedSeverity } from './maturity.js';
import { RULES } from './rules.js';
import { SEVERITY_RANK, type Finding, type LintResult, type Severity, type Surface } from './types.js';

export type LintFormat = 'text' | 'json' | 'sarif' | 'github' | 'markdown';
export const LINT_FORMATS: LintFormat[] = ['text', 'json', 'sarif', 'github', 'markdown'];

export const SURFACE_TITLE: Record<Surface, string> = {
  agent: 'AI agent instructions',
  readme: 'README and contributing guides',
  docs: 'Docs',
  example: 'Code examples',
  docstring: 'Docstrings',
  config: 'Configuration',
};

/** How the formats that link each finding (Markdown, SARIF) build the "False positive?" link. */
export interface LintFormatOptions {
  /** Markdown: a heading above the findings. */
  heading?: string;
  /**
   * The repository is private: report links carry only the rule, the message's shape and the version.
   * Default: what the GitHub Actions event says (`repository.private`), else not private.
   */
  private?: boolean;
  /** The text of a line of the checkout, for the link's "line it flagged" (see `lineReader`). */
  lineText?: (path: string, line: number) => string | undefined;
  /**
   * Markdown: a "False positive?" link on every finding. `formatLint` (the CLI's and the API's markdown) turns
   * it on; other callers (the PR comment) choose.
   */
  falsePositiveLinks?: boolean;
}

/** The footer of a text report with findings: how to report a wrong one. */
export const FALSE_POSITIVE_FOOTER = `False positive? Report it in one click: ${FP_FORM_URL} (the rule, file:line and message are enough).`;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function lintSummaryLine(r: LintResult): string {
  const s = r.summary;
  if (!r.findings.length) return `No stale references in ${plural(s.files, 'file')} (${s.ms} ms).`;
  const parts = [s.errors && plural(s.errors, 'error'), s.warnings && plural(s.warnings, 'warning'), s.infos && `${s.infos} info`].filter(Boolean);
  const lower = s.lowerConfidence ?? r.findings.filter(isLowerConfidence).length;
  return `${parts.join(', ')} in ${plural(new Set(r.findings.map((f) => f.path)).size, 'file')} (${plural(s.files, 'file')} checked, ${s.ms} ms)${lower ? `; ${lower} of them lower confidence` : ''}.`;
}

/**
 * Group findings by section title, in the order the findings already have (agent files first);
 * lower-confidence findings (beta rules) last, in a group of their own.
 */
function groups(findings: Finding[]): [string, Finding[]][] {
  const out = new Map<string, Finding[]>();
  const lower: Finding[] = [];
  for (const f of findings) {
    if (isLowerConfidence(f)) {
      lower.push(f);
      continue;
    }
    const title = SURFACE_TITLE[f.surface];
    const list = out.get(title) ?? [];
    list.push(f);
    out.set(title, list);
  }
  if (lower.length) out.set(LOWER_CONFIDENCE_TITLE, lower);
  return [...out];
}

/** The commit a finding was found at: the result's, else the one in its evidence link. */
function shaOf(r: LintResult, f: Finding): string | undefined {
  return r.sha ?? /\/blob\/([0-9a-f]{7,40})\//.exec(f.evidence?.url ?? '')?.[1];
}

/** The "False positive?" link of one finding. */
export function findingFalsePositiveUrl(r: LintResult, f: Finding, opts: LintFormatOptions = {}): string {
  const priv = opts.private ?? repositoryIsPrivate() ?? false;
  return falsePositiveUrl({
    rule: f.rule,
    message: f.message,
    path: f.path,
    line: f.line,
    repo: f.repo ?? r.repo,
    sha: shaOf(r, f),
    lineText: priv ? undefined : opts.lineText?.(f.path, f.line),
    version: packageVersion(),
    private: priv,
  });
}

/** The text report; `footer` adds how to report a false positive when there are findings (`formatLint` does). */
export function formatText(r: LintResult, opts: { footer?: boolean } = {}): string {
  const out: string[] = [];
  for (const [title, list] of groups(r.findings)) {
    out.push(title);
    if (title === LOWER_CONFIDENCE_TITLE) out.push(`  ${LOWER_CONFIDENCE_NOTE}`);
    out.push('');
    let lastPath = '';
    for (const f of list) {
      if (f.path !== lastPath) {
        out.push(`  ${f.path}`);
        lastPath = f.path;
      }
      out.push(`    ${f.line}:${f.column}  ${f.severity.padEnd(7)}  ${f.message}  [${f.rule}]`);
      if (f.fix?.verified) out.push(`             fix: ${f.fix.description}`);
    }
    out.push('');
  }
  for (const w of r.warnings) out.push(`warning: ${w}`);
  if (opts.footer && r.findings.length) out.push(FALSE_POSITIVE_FOOTER);
  out.push(lintSummaryLine(r));
  return out.join('\n');
}

export function formatJson(r: LintResult): string {
  return JSON.stringify({ ...r, tool: { name: 'staleproof', version: packageVersion(), falsePositives: FP_FORM_URL } }, null, 2);
}

/** GitHub workflow commands: each finding becomes an annotation on the file and line. */
export function formatGithub(r: LintResult): string {
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s: string) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const level: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'notice' };
  return r.findings
    .map(
      (f) =>
        `::${level[f.severity]} file=${prop(f.path)},line=${f.line},col=${f.column},endLine=${f.endLine},endColumn=${f.endColumn},title=${prop(`Staleproof ${f.rule}${isLowerConfidence(f) ? ' (beta, lower confidence)' : ''}`)}::${esc(f.message + (f.fix?.verified ? ` Fix: ${f.fix.description}` : ''))}`,
    )
    .join('\n');
}

/** SARIF 2.1.0, for GitHub code scanning and other SARIF viewers. */
export function formatSarif(r: LintResult, opts: LintFormatOptions = {}): string {
  const level: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' };
  const used = RULES.filter((x) => r.findings.some((f) => f.rule === x.id));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Staleproof',
            version: packageVersion(),
            informationUri: 'https://staleproof.dev',
            rules: used.map((x) => {
              const report = `${FP_FORM_URL}&rule=${x.id}`;
              const beta = x.maturity === 'beta' ? ' Beta rule: reported at note level, never fails a check until `[rules]` in .staleproof.toml opts it in.' : '';
              return {
                id: x.id,
                shortDescription: { text: x.summary },
                fullDescription: { text: x.why },
                helpUri: `https://staleproof.dev/#/docs/rules#${x.id}`,
                help: {
                  text: `${x.summary} ${x.why}${beta} False positive? Report it: ${report}`,
                  markdown: `${x.summary} ${x.why}${beta}\n\n[False positive? Report it](${report}): it becomes a regression test.`,
                },
                defaultConfiguration: { level: level[reportedSeverity(x).severity] },
                // `precision` is the rule property GitHub code scanning reads (CodeQL's convention).
                properties: { maturity: x.maturity, precision: x.maturity === 'beta' ? 'medium' : 'high', tags: ['documentation', 'staleproof'] },
              };
            }),
          },
        },
        results: r.findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: used.findIndex((x) => x.id === f.rule),
          level: level[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
                region: { startLine: f.line, startColumn: f.column, endLine: f.endLine, endColumn: f.endColumn },
              },
            },
          ],
          partialFingerprints: { 'staleproof/v1': f.fingerprint },
          properties: { falsePositiveUrl: findingFalsePositiveUrl(r, f, opts), ...(isLowerConfidence(f) ? { lowerConfidence: true } : {}) },
          ...(f.fix?.verified
            ? {
                fixes: [
                  {
                    description: { text: f.fix.description },
                    artifactChanges: f.fix.edits.map((e) => ({
                      artifactLocation: { uri: e.path },
                      replacements: [
                        {
                          deletedRegion: { startLine: e.line, startColumn: e.column, endLine: e.endLine, endColumn: e.endColumn },
                          insertedContent: { text: e.newText },
                        },
                      ],
                    })),
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/**
 * Per-finding "False positive?" links go on the first FP_LINKS_MAX findings, and on no more than FP_LINKS_BUDGET
 * characters of links in all: a GitHub comment holds at most 65,536 characters and one prefilled link can be up to
 * MAX_URL_LENGTH (src/format/fp-link.ts). Past either, one "False positive? Report it" line closes the section.
 */
export const FP_LINKS_MAX = 20;
export const FP_LINKS_BUDGET = 20_000;

/** A Markdown section for a PR comment, an issue or a job summary; with `falsePositiveLinks`, a small "False positive?" link per finding (FP_LINKS_MAX). */
export function formatMarkdown(r: LintResult, opts: LintFormatOptions = {}): string {
  const out: string[] = [];
  if (opts.heading) out.push(opts.heading, '');
  if (!r.findings.length) {
    out.push(lintSummaryLine(r));
    return out.join('\n');
  }
  const linkOpts = opts.falsePositiveLinks ? { ...opts, private: opts.private ?? repositoryIsPrivate() ?? false } : opts;
  let links = 0;
  let linkChars = 0;
  let unlinked = 0;
  for (const [title, list] of groups(r.findings)) {
    out.push(`**${title}**`, '');
    if (title === LOWER_CONFIDENCE_TITLE) out.push(`<sub>${LOWER_CONFIDENCE_NOTE}</sub>`, '');
    for (const f of list) {
      const where = `${f.path}:${f.line}`;
      const link = f.evidence?.url ? `[\`${where}\`](${f.evidence.url})` : `\`${where}\``;
      let report = '';
      if (opts.falsePositiveLinks) {
        const url = links < FP_LINKS_MAX ? findingFalsePositiveUrl(r, f, linkOpts) : '';
        if (url && linkChars + url.length <= FP_LINKS_BUDGET) {
          report = ` · [False positive?](${url})`;
          links++;
          linkChars += url.length;
        } else {
          links = FP_LINKS_MAX;
          unlinked++;
        }
      }
      out.push(`- ${link} ${f.message} <sub>${f.rule}${report}</sub>${f.fix?.verified ? ` Fix: ${f.fix.description}` : ''}`);
    }
    out.push('');
  }
  out.push(`<sub>${lintSummaryLine(r)}</sub>`);
  // The findings past the per-finding links share one report line.
  if (unlinked) out.push('', `<sub>False positive? [Report it](${FP_FORM_URL}).</sub>`);
  return out.join('\n');
}

export function formatLint(r: LintResult, format: LintFormat, opts: LintFormatOptions = {}): string {
  switch (format) {
    case 'json':
      return formatJson(r);
    case 'sarif':
      return formatSarif(r, opts);
    case 'github':
      return formatGithub(r);
    case 'markdown':
      return formatMarkdown(r, { ...opts, falsePositiveLinks: opts.falsePositiveLinks ?? true });
    default:
      return formatText(r, { footer: true });
  }
}

/** Exit code for `--fail-on`: 1 when any finding is at or above the level. Lower-confidence findings never fail. */
export function lintExitCode(r: LintResult, failOn: Severity | 'never'): number {
  if (failOn === 'never') return 0;
  return r.findings.some((f) => !isLowerConfidence(f) && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
}

/**
 * Lines of a checkout, for the "False positive?" links (`LintFormatOptions.lineText`): each file read once,
 * nothing outside the checkout, `undefined` for what cannot be read.
 */
export function lineReader(dir: string): (path: string, line: number) => string | undefined {
  const root = resolve(dir);
  const files = new Map<string, string[] | undefined>();
  return (path, line) => {
    const full = resolve(join(root, path));
    const rel = relative(root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    if (!files.has(rel)) {
      let lines: string[] | undefined;
      try {
        lines = readFileSync(full, 'utf8').split(/\r?\n/);
      } catch {
        lines = undefined;
      }
      files.set(rel, lines);
    }
    return files.get(rel)?.[line - 1];
  };
}

/**
 * Whether the repository is private, from the GitHub Actions event payload (`repository.private`); `undefined`
 * outside GitHub Actions or when the payload cannot be read. Report links from a private repository carry no
 * path or file text.
 */
export function repositoryIsPrivate(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { repository?: { private?: unknown } };
    return typeof event.repository?.private === 'boolean' ? event.repository.private : undefined;
  } catch {
    return undefined;
  }
}
