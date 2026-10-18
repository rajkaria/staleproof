/**
 * "False positive?": a link that opens Staleproof's false-positive issue form
 * (.github/ISSUE_TEMPLATE/false-positive.yml) with the finding filled in, so a reader who sees a wrong
 * finding reports it in one click. Each report becomes a regression fixture (scripts/fp-to-fixture.ts,
 * test/fp-corpus.test.ts; docs/false-positives.md).
 *
 * Pure and dependency-free, so the CLI, the PR comment, the GitHub App, the editor and the web app build the
 * same link.
 */

export const FP_REPO = 'rajkaria/staleproof';
export const FP_TEMPLATE = 'false-positive.yml';
export const FP_NEW_ISSUE = `https://github.com/${FP_REPO}/issues/new`;
/** The form with nothing filled in (the text report's footer names it). */
export const FP_FORM_URL = `${FP_NEW_ISSUE}?template=${FP_TEMPLATE}`;

/** The form's field ids: the query parameters that prefill them, and what scripts/fp-to-fixture.ts reads back. */
export const FP_FIELDS = {
  rule: 'rule',
  repository: 'repository',
  location: 'location',
  message: 'message',
  text: 'text',
  version: 'version',
  why: 'why',
  share: 'share',
} as const;
export type FpField = (typeof FP_FIELDS)[keyof typeof FP_FIELDS];

/** The form's labels: an issue body has one `### <label>` section per field. */
export const FP_LABELS: Record<FpField, string> = {
  rule: 'Rule',
  repository: 'Repository and commit',
  location: 'File and line',
  message: 'What Staleproof said',
  text: 'The line it flagged',
  version: 'Staleproof version',
  why: 'Why it is not wrong',
  share: 'Sharing',
};

/** The repository field when the finding came from a checkout with no known `owner/name@sha`. */
export const LOCAL_TREE = 'local working tree';
/** The repository field of a private repository's report: nothing about it is shared. */
export const PRIVATE_REPO = 'private repository (not shared)';

/** GitHub answers 414 above about 8 KB; browsers and chat clients cut long links earlier. */
export const MAX_URL_LENGTH = 4000;
/** The flagged line, in code points. */
export const MAX_LINE_TEXT = 200;

export interface FpLinkInput {
  rule: string;
  /** The finding's message, as shown. */
  message: string;
  /** Repository-relative path of the stale text. */
  path?: string;
  line?: number;
  /** `owner/name` (anything without a slash counts as unknown). */
  repo?: string;
  /** The commit the finding was found at. */
  sha?: string;
  /** The text of the flagged line, when the caller has it (the editor, the App, the CLI). */
  lineText?: string;
  /** The Staleproof version that reported it. */
  version?: string;
  /**
   * The repository is private (the App's `ghp-` workspaces, the Action on a private repository, or a finding
   * marked private): the link then carries only the rule, the message's shape and the version.
   */
  private?: boolean;
}

/** Cut to `max` code points, the last one an ellipsis; never splits a character. */
export function truncateText(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Generic file names that say nothing about a repository: kept in a message's shape. */
const GENERIC_FILES = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Makefile',
  'justfile',
  'Taskfile.yml',
  'Cargo.toml',
  'go.mod',
  '.env.example',
  '.env.sample',
  '.env.template',
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
]);

/**
 * A finding's message with everything that could name a private repository's contents replaced by `…`:
 * code spans (names, paths, commands), URLs, paths and file names, commit ids, identifiers and the lists a
 * message spells out. What is left says which kind of finding it was.
 */
export function messageShape(message: string): string {
  const files = /(?<![\w.])\.?[\w-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]{0,7}(?![\w-])/g;
  return message
    .replace(/`[^`]*`/g, '`…`')
    .replace(/https?:\/\/[^\s)]+/g, '…')
    .replace(/(?<![\w`])[\w.@-]*[\\/][\w.@/\\-]*[\w/]/g, '…')
    .replace(files, (m) => (GENERIC_FILES.has(m) ? m : '…'))
    .replace(/\b[0-9a-f]{7,40}\b/g, '…')
    .replace(/\(([\w ]+): [^()]*\)/g, '($1: …)')
    .replace(/\bdocuments [^`]+? but not\b/g, 'documents … but not')
    .replace(/\b\w*_\w*\b|\b[a-z]+[A-Z][\w$]*\b/g, '…')
    .replace(/(?:…, )+…/g, '…');
}

function repositoryField(f: FpLinkInput): string {
  if (f.private) return PRIVATE_REPO;
  if (!f.repo?.includes('/')) return LOCAL_TREE;
  return f.sha ? `${f.repo}@${f.sha}` : `${f.repo} (${LOCAL_TREE})`;
}

/** encodeURIComponent, plus the characters it leaves that end a Markdown link or confuse chat clients. */
function encode(v: string): string {
  return encodeURIComponent(v).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function query(params: [string, string | undefined][]): string {
  return params
    .filter((p): p is [string, string] => p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => `${k}=${encode(v)}`)
    .join('&');
}

/**
 * The new-issue URL of the false-positive form, prefilled with the rule, `repo@sha` (or "local working tree"),
 * `file:line`, the message, the flagged line (truncated) and the version. Private repositories share only the
 * rule, the message's shape and the version. Never longer than MAX_URL_LENGTH: the flagged line, then the
 * message, then the location are shortened or dropped until it fits.
 */
export function falsePositiveUrl(f: FpLinkInput): string {
  const priv = f.private === true;
  const location = priv || !f.path ? undefined : f.line ? `${f.path}:${f.line}` : f.path;
  const message = priv ? messageShape(f.message) : f.message.trim();
  const text = priv || !f.lineText?.trim() ? undefined : truncateText(f.lineText.replace(/[\r\n]+$/, ''), MAX_LINE_TEXT);
  const build = (o: { location?: string; message?: string; text?: string }) => {
    const title = o.location && f.path && !priv && f.path.length <= 120 ? `False positive: ${f.rule} in ${f.path}` : `False positive: ${f.rule}`;
    return `${FP_FORM_URL}&${query([
      ['title', title],
      [FP_FIELDS.rule, f.rule],
      [FP_FIELDS.repository, repositoryField(f)],
      [FP_FIELDS.location, o.location],
      [FP_FIELDS.message, o.message],
      [FP_FIELDS.text, o.text],
      [FP_FIELDS.version, f.version],
    ])}`;
  };
  const tries: { location?: string; message?: string; text?: string }[] = [
    { location, message, text },
    { location, message, text: text && truncateText(text, 80) },
    { location, message },
    { location, message: truncateText(message, 300) },
    { location, message: truncateText(messageShape(message), 200) },
    { location: location && truncateText(location, 200), message: truncateText(messageShape(message), 200) },
    {},
  ];
  for (const t of tries) {
    const url = build(t);
    if (url.length <= MAX_URL_LENGTH) return url;
  }
  return FP_FORM_URL;
}
