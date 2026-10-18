import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  appInstallUrl,
  CLAUDE_PLUGIN_COMMANDS,
  EXTENSION_ID,
  EXTENSION_LINKS,
  mcpLinks,
  newWorkflowUrl,
  preCommitYaml,
  PUBLIC_APP_INSTALL_URL,
  repoFromInput,
  workflowYaml,
} from '../web/src/install-links.js';
import { parseRoute } from '../web/src/route.js';

describe('install page links', () => {
  it('reads a repository from what people paste', () => {
    expect(repoFromInput('encode/httpx')).toBe('encode/httpx');
    expect(repoFromInput('https://github.com/encode/httpx')).toBe('encode/httpx');
    expect(repoFromInput('github.com/encode/httpx.git')).toBe('encode/httpx');
    expect(repoFromInput('https://github.com/encode/httpx/pull/3571')).toBe('encode/httpx');
    expect(repoFromInput('  pallets/click/  ')).toBe('pallets/click');
    expect(repoFromInput('httpx')).toBeUndefined();
    expect(repoFromInput('')).toBeUndefined();
  });

  it('writes the same zero-config workflow as examples/, and adds only the options chosen', async () => {
    const plain = workflowYaml({ withRepos: [], agent: false, failOnBreaks: false });
    const example = await readFile(join(import.meta.dirname, '..', 'examples', 'staleproof.yml'), 'utf8');
    const body = (y: string) => y.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(body(plain)).toEqual(body(example));
    expect(plain).not.toContain('with:');

    const all = workflowYaml({ withRepos: ['acme/docs', 'acme/sdk'], agent: true, failOnBreaks: true });
    for (const y of [plain, all]) expect(() => parse(y, { strict: true })).not.toThrow();
    expect(all).toContain('      - uses: rajkaria/staleproof@v1\n        with:\n          also-index: acme/docs acme/sdk\n');
    expect(all).toContain('          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n');
    expect(all).toContain('          fail-on: breaks\n');
    const audited = workflowYaml({ withRepos: [], agent: false, failOnBreaks: false, weeklyAudit: true });
    expect(audited).toContain("on:\n  pull_request:\n  schedule:\n    - cron: '0 6 * * 1'\n  workflow_dispatch:\n");
    expect(audited).toContain('  pull-requests: write\n  issues: write\n');
    // Every input the page can write is one the action declares.
    const action = await readFile(join(import.meta.dirname, '..', 'action.yml'), 'utf8');
    for (const input of ['also-index', 'anthropic-api-key', 'fail-on']) expect(action).toContain(`\n  ${input}:`);
  });

  it("opens GitHub's new-file page with the workflow filled in", () => {
    const yaml = workflowYaml({ withRepos: [], agent: false, failOnBreaks: false });
    const url = new URL(newWorkflowUrl('encode/httpx', 'master', yaml));
    expect(url.origin + url.pathname).toBe('https://github.com/encode/httpx/new/master');
    expect(url.searchParams.get('filename')).toBe('.github/workflows/staleproof.yml');
    expect(url.searchParams.get('value')).toBe(yaml);
  });

  it('builds the MCP install links for the server the page came from', () => {
    const links = mcpLinks('https://staleproof.dev/api/mcp');
    const cursor = new URL(links.cursor);
    expect(cursor.protocol).toBe('cursor:');
    expect(cursor.searchParams.get('name')).toBe('staleproof');
    expect(JSON.parse(atob(cursor.searchParams.get('config')!))).toEqual({ url: 'https://staleproof.dev/api/mcp' });
    expect(JSON.parse(decodeURIComponent(links.vscode.replace('vscode:mcp/install?', '')))).toEqual({ name: 'staleproof', type: 'http', url: 'https://staleproof.dev/api/mcp' });
    expect(links.claudeCode).toBe('claude mcp add --transport http staleproof https://staleproof.dev/api/mcp');
    expect(JSON.parse(links.json)).toEqual({ mcpServers: { staleproof: { url: 'https://staleproof.dev/api/mcp' } } });
  });
});

describe('install page options', () => {
  const read = (...p: string[]) => readFile(join(import.meta.dirname, '..', ...p), 'utf8');

  it('picks the App as the primary button only when the server reports one with an install link', async () => {
    const url = 'https://github.com/apps/acme-staleproof/installations/new';
    expect(appInstallUrl({ githubApp: { enabled: true, installUrl: url } })).toBe(url);
    expect(appInstallUrl({ githubApp: { enabled: true } })).toBeUndefined();
    expect(appInstallUrl({ githubApp: { enabled: false } })).toBeUndefined();
    expect(appInstallUrl({})).toBeUndefined();
    // Before health answers: staleproof.dev's own App.
    expect(appInstallUrl(undefined)).toBe(PUBLIC_APP_INSTALL_URL);
    // The slug GitHub gave the App registered from github-app.json (its name, lower-cased).
    const app = JSON.parse(await read('github-app.json')) as { name: string };
    expect(PUBLIC_APP_INSTALL_URL).toBe(`https://github.com/apps/${app.name.toLowerCase()}/installations/new`);
  });

  it('names the extension the way editors/vscode publishes it, on both registries', async () => {
    const pkg = JSON.parse(await read('editors', 'vscode', 'package.json')) as { name: string; publisher: string };
    expect(EXTENSION_ID).toBe(`${pkg.publisher}.${pkg.name}`);
    expect(EXTENSION_LINKS).toEqual({
      marketplace: 'https://marketplace.visualstudio.com/items?itemName=staleproof.staleproof',
      openVsx: 'https://open-vsx.org/extension/staleproof/staleproof',
      command: 'code --install-extension staleproof.staleproof',
    });
  });

  it('shows the Claude Code plugin commands and the pre-commit entry exactly as the docs give them', async () => {
    const claude = await read('docs', 'claude-code.md');
    expect(claude).toContain(`\`\`\`text\n${CLAUDE_PLUGIN_COMMANDS.join('\n')}\n\`\`\``);
    const market = JSON.parse(await read('.claude-plugin', 'marketplace.json')) as { name: string; plugins: { name: string }[] };
    expect(CLAUDE_PLUGIN_COMMANDS[1]).toBe(`/plugin install ${market.plugins[0]!.name}@${market.name}`);

    const preCommit = await read('docs', 'pre-commit.md');
    const block = /```yaml\n(repos:\n[\s\S]*?)```/.exec(preCommit)![1]!;
    const rev = /rev: v([\d.]+)/.exec(block)![1]!;
    const lines = (y: string) => y.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(lines(preCommitYaml(rev))).toEqual(lines(block));
    expect(preCommitYaml('v1.2.3')).toContain('    rev: v1.2.3\n');
    expect(() => parse(preCommitYaml('1.2.3'), { strict: true })).not.toThrow();
  });
});

describe('routes', () => {
  it('parses the install page and check deep links', () => {
    expect(parseRoute('#/install')).toEqual({ page: 'install', repo: undefined });
    expect(parseRoute('#/install?repo=encode%2Fhttpx')).toEqual({ page: 'install', repo: 'encode/httpx' });
    expect(parseRoute(`#/try?pr=${encodeURIComponent('https://github.com/a/b/pull/1')}`)).toEqual({ page: 'home', section: 'try', pr: 'https://github.com/a/b/pull/1' });
    expect(parseRoute('#/try')).toEqual({ page: 'home', section: 'try' });
    expect(parseRoute('#/check/chk-1')).toEqual({ page: 'check', id: 'chk-1' });
    expect(parseRoute('#/docs/mcp/hosted')).toEqual({ page: 'docs', slug: 'mcp', anchor: 'hosted' });
    expect(parseRoute('#/audit?repo=encode%2Fhttpx')).toEqual({ page: 'audit', repo: 'encode/httpx' });
    expect(parseRoute('#/audit')).toEqual({ page: 'audit', repo: undefined });
    expect(parseRoute('#/nowhere')).toEqual({ page: 'home' });
  });

  it('routes #/drift to the Drift Hall', () => {
    expect(parseRoute('#/drift')).toEqual({ page: 'drift' });
    expect(parseRoute('#/drift-hall')).toEqual({ page: 'drift' });
    expect(parseRoute('#/drift/')).toEqual({ page: 'drift' });
  });
});
