import { join } from 'node:path';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PUBLIC_APP_INSTALL_URL } from '../web/src/install-links.js';

/**
 * The install page as static HTML (what a reader without JavaScript, or the first paint, gets):
 * one primary call to action, the Action second, the rest under "More ways" in a fixed order.
 */

const root = join(import.meta.dirname, '..');
// Imported by path at run time: the root tsconfig doesn't compile the web app's JSX.
const page = (await import(join(root, 'web', 'src', 'Install.tsx'))) as {
  InstallPage: FunctionComponent<{ initialRepo?: string; health?: unknown }>;
  MORE_WAYS: { id: string; label: string }[];
};

const APP_URL = 'https://github.com/apps/staleproof/installations/new';
const health = (githubApp?: { enabled: boolean; installUrl?: string }, extra: Record<string, unknown> = {}) => ({
  ok: true,
  version: '9.8.7',
  org: 'falkordb',
  falkordb: '4.22.0',
  agent: { available: false, reason: 'test' },
  busy: false,
  hosted: { enabled: true },
  ...(githubApp ? { githubApp } : {}),
  ...extra,
});
const render = (props: { initialRepo?: string; health?: unknown }) => renderToStaticMarkup(createElement(page.InstallPage, props));
/** The hero: everything before the Action's section. */
const hero = (html: string) => html.slice(0, html.indexOf('id="github"'));
const primaries = (html: string) => [...html.matchAll(/<a class="btn btn-primary[^"]*"[^>]*href="([^"]*)"/g)].map((m) => m[1]);

describe('install page', () => {
  it('makes the GitHub App the one primary button when the server has an App, with one line on what it does', () => {
    const html = render({ health: health({ enabled: true, installUrl: APP_URL }) });
    expect(primaries(html)).toEqual([APP_URL]);
    expect(hero(html)).toContain('Install the GitHub App');
    expect(hero(html)).toMatch(/gets a check that marks the docs, READMEs and agent files it makes wrong/);
    // The Action is second, and says plainly that it is what runs examples today.
    expect(html.indexOf('id="github"')).toBeGreaterThan(html.indexOf('Install the GitHub App'));
    expect(html).toContain('The Action is the way to run docs examples today.');
    expect(html).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it('falls back to the Action as the primary button when the server has no App', () => {
    for (const h of [health(), health({ enabled: false }), health({ enabled: true })]) {
      const html = render({ health: h });
      expect(html).not.toContain('Install the GitHub App');
      expect(html).not.toContain('github.com/apps/');
      expect(hero(html)).toContain('Add the GitHub Action');
      expect(html).not.toContain('The Action is the way to run docs examples today.');
      // The hero's button and the form's (no repository typed yet: disabled, no link), both the Action.
      expect(primaries(html)).toEqual(['#/install']);
      expect(html.match(/class="btn btn-primary/g)).toHaveLength(2);
    }
  });

  it("shows staleproof.dev's App before health answers, so the primary button does not change under the reader", () => {
    expect(primaries(render({}))).toEqual([PUBLIC_APP_INSTALL_URL]);
  });

  it('lists every other way under "More ways", in order', () => {
    const html = render({ health: health({ enabled: true, installUrl: APP_URL }) });
    const more = html.slice(html.indexOf('id="more"'));
    expect(page.MORE_WAYS.map((w) => w.id)).toEqual(['editor', 'claude-code', 'assistant', 'terminal', 'pre-commit', 'init']);
    const at = page.MORE_WAYS.map((w) => more.indexOf(`id="${w.id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The extension on both registries.
    expect(more).toContain('href="https://marketplace.visualstudio.com/items?itemName=staleproof.staleproof"');
    expect(more).toContain('href="https://open-vsx.org/extension/staleproof/staleproof"');
    expect(more).toContain('code --install-extension staleproof.staleproof');
    // The Claude Code plugin's two commands.
    expect(more).toContain('/plugin marketplace add rajkaria/staleproof\n/plugin install staleproof@staleproof');
    // pre-commit, pinned to the server's release; init.
    expect(more).toContain('rev: v9.8.7');
    expect(more).toContain('npx -y staleproof init --yes --dry-run');
  });

  it('keeps the deep links: MCP buttons, the prefilled workflow, docs anchors', () => {
    const html = render({ initialRepo: 'encode/httpx', health: health({ enabled: true, installUrl: APP_URL }) });
    expect(html).toContain('href="cursor://anysphere.cursor-deeplink/mcp/install?name=staleproof&amp;config=');
    expect(html).toContain('href="vscode:mcp/install?');
    expect(html).toContain('claude mcp add --transport http staleproof https://staleproof.dev/api/mcp');
    expect(html).toContain('href="https://github.com/encode/httpx/new/main?filename=.github%2Fworkflows%2Fstaleproof.yml&amp;value=');
    expect(html).toContain('Add to encode/httpx');
    for (const a of ['#/docs/install', '#/docs/editors', '#/docs/claude-code', '#/docs/pre-commit', '#/docs/cli/init']) expect(html).toContain(`href="${a}"`);
  });

  it('leaves the pre-commit pin out when the version is unknown or from a snapshot', () => {
    for (const h of [undefined, health(undefined, { snapshot: { takenAt: 'x' } })]) {
      const html = render({ health: h });
      expect(html).not.toContain('rev: v');
      expect(html).toContain('adds it with the current one');
    }
  });
});
