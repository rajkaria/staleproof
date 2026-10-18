import { join } from 'node:path';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
// Imported by path at run time: the root tsconfig doesn't compile the web app's JSX.
const { Landing } = (await import(join(root, 'web', 'src', 'Landing.tsx'))) as { Landing: FunctionComponent };

describe('landing page', () => {
  it('says in the hero that agent files are checked too, with a link to the lint docs', () => {
    const html = renderToStaticMarkup(createElement(Landing));
    const hero = html.slice(0, html.indexOf('results-band'));
    expect(hero).toContain('It also checks the files AI coding agents read');
    for (const name of ['<code>AGENTS.md</code>', '<code>CLAUDE.md</code>', 'Cursor and Copilot']) expect(hero).toContain(name);
    expect(hero).toContain('<a href="#/docs/lint">How lint works</a>');
  });
});
