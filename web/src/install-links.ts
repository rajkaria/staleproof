/** The install page's links and files, kept free of React so they are unit-tested. */
import { PRODUCT, REPO_URL } from './docs/manifest.js';

export const ACTION = 'rajkaria/staleproof@v1';
export const WORKFLOW_PATH = '.github/workflows/staleproof.yml';

/** `owner/name` from what someone pastes: a repository or pull request URL, or `owner/name`. */
export function repoFromInput(input: string): string | undefined {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/.exec(input.trim());
  if (!m || m[1] === 'pull') return undefined;
  return `${m[1]}/${m[2]}`;
}

export interface WorkflowOptions {
  withRepos: string[];
  agent: boolean;
  failOnBreaks: boolean;
  /** Also audit the whole docs every week (the action's audit mode) and keep one issue up to date. */
  weeklyAudit?: boolean;
}

/** The workflow file the one-click link commits. */
export function workflowYaml(opts: WorkflowOptions): string {
  const inputs: string[] = [];
  if (opts.withRepos.length) inputs.push(`          also-index: ${opts.withRepos.join(' ')}`);
  if (opts.agent) inputs.push('          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}');
  if (opts.failOnBreaks) inputs.push('          fail-on: breaks');
  return [
    `# ${PRODUCT}: a comment on every pull request with the docs it can make false,`,
    '# and the docs examples run before and after it. No database or secrets to set up.',
    `# ${REPO_URL}`,
    `name: ${PRODUCT}`,
    'on:',
    '  pull_request:',
    ...(opts.weeklyAudit ? ['  schedule:', "    - cron: '0 6 * * 1'", '  workflow_dispatch:'] : []),
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    ...(opts.weeklyAudit ? ['  issues: write'] : []),
    '',
    'jobs:',
    '  docs:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${ACTION}`,
    ...(inputs.length ? ['        with:', ...inputs] : []),
    '',
  ].join('\n');
}

/** GitHub's "new file" page with the workflow filled in: one click on Commit installs it. */
export function newWorkflowUrl(repo: string, branch: string, yaml: string): string {
  return `https://github.com/${repo}/new/${encodeURIComponent(branch)}?filename=${encodeURIComponent(WORKFLOW_PATH)}&value=${encodeURIComponent(yaml)}`;
}

/** staleproof.dev's GitHub App (github.com/apps/staleproof). */
export const PUBLIC_APP_INSTALL_URL = 'https://github.com/apps/staleproof/installations/new';

/**
 * The install page's primary button: the App, when this server has one. Before /api/health
 * answers (and on a host whose health never loads) the page assumes staleproof.dev's App, so the
 * primary call to action does not jump from the Action to the App a moment after the page opens.
 */
export function appInstallUrl(health?: { githubApp?: { enabled: boolean; installUrl?: string } }): string | undefined {
  if (!health) return PUBLIC_APP_INSTALL_URL;
  return health.githubApp?.enabled ? health.githubApp.installUrl : undefined;
}

/** The VS Code / Cursor extension (editors/vscode), on both registries. */
export const EXTENSION_ID = 'staleproof.staleproof';
export const EXTENSION_LINKS = {
  marketplace: `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`,
  openVsx: `https://open-vsx.org/extension/${EXTENSION_ID.replace('.', '/')}`,
  command: `code --install-extension ${EXTENSION_ID}`,
};

/** The Claude Code plugin, from this repository's marketplace (docs/claude-code.md). */
export const CLAUDE_PLUGIN_COMMANDS = ['/plugin marketplace add rajkaria/staleproof', '/plugin install staleproof@staleproof'];

/** The `.pre-commit-config.yaml` entry (docs/pre-commit.md), pinned to a release tag. */
export function preCommitYaml(version: string): string {
  return ['repos:', `  - repo: ${REPO_URL}`, `    rev: v${version.replace(/^v/, '')}`, '    hooks:', '      - id: staleproof', ''].join('\n');
}

export function mcpLinks(url: string) {
  const b64 = btoa(JSON.stringify({ url }));
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=staleproof&config=${encodeURIComponent(b64)}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'staleproof', type: 'http', url }))}`,
    claudeCode: `claude mcp add --transport http staleproof ${url}`,
    json: JSON.stringify({ mcpServers: { staleproof: { url } } }, null, 2),
  };
}

