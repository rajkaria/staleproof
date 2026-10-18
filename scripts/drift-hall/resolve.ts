/**
 * Writes scripts/drift-hall/repos.ts: the Drift Hall corpus with each repository's commit and star count, read
 * from GitHub with the `gh` CLI (read-only calls). Edit CANDIDATES here, then run it again:
 *
 *   npx tsx scripts/drift-hall/resolve.ts [--held-out]
 *
 * A repository already in repos.ts keeps its recorded sha unless `--refresh` is passed, so a re-run never moves the
 * commits the verdicts were made at.
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CORPUS, type DriftRepo, type DriftLanguage } from './repos.js';

const run = promisify(execFile);

/** The corpus: popular, active repositories with real docs, most with AI agent files. None is in PRECISION.md. */
const CANDIDATES: { repo: string; language: DriftLanguage }[] = [
  // Python
  ...[
    'fastapi/typer', 'fastapi/fastapi', 'fastapi/sqlmodel', 'pallets/click', 'psf/requests', 'Kludex/starlette',
    'Kludex/uvicorn', 'Textualize/rich', 'Textualize/textual', 'huggingface/smolagents', 'huggingface/huggingface_hub',
    'langchain-ai/langchain', 'langchain-ai/langgraph', 'openai/openai-python', 'openai/openai-agents-python',
    'anthropics/claude-agent-sdk-python', 'crewAIInc/crewAI', 'marimo-team/marimo', 'PrefectHQ/fastmcp',
    'PrefectHQ/prefect', '567-labs/instructor', 'agno-agi/agno', 'aio-libs/aiohttp', 'deepset-ai/haystack',
    'google/adk-python', 'mem0ai/mem0', 'pydantic/logfire', 'scrapy/scrapy', 'microsoft/markitdown',
    'gradio-app/gradio', 'pytest-dev/pytest',
  ].map((repo) => ({ repo, language: 'python' as const })),
  // TypeScript and JavaScript
  ...[
    'pmndrs/zustand', 'pmndrs/jotai', 'TanStack/query', 'TanStack/router', 'honojs/hono', 'trpc/trpc',
    'drizzle-team/drizzle-orm', 'vitest-dev/vitest', 'vitejs/vite', 'sveltejs/svelte', 'vuejs/core',
    'remix-run/react-router', 'shadcn-ui/ui', 'excalidraw/excalidraw', 'axios/axios', 'google-gemini/gemini-cli',
    'openai/openai-node', 'anthropics/anthropic-sdk-typescript', 'langchain-ai/langchainjs',
    'modelcontextprotocol/inspector', 'statelyai/xstate', 'elysiajs/elysia', 'h3js/h3', 'nuxt/nuxt',
    'withastro/astro', 'fastify/fastify', 'expressjs/express',
  ].map((repo) => ({ repo, language: 'typescript' as const })),
  // Go
  ...['cli/cli', 'gofiber/fiber', 'labstack/echo', 'gin-gonic/gin', 'spf13/viper'].map((repo) => ({ repo, language: 'go' as const })),
];

/**
 * The held-out set: popular repositories in none of the hall, PRECISION.md or C's sweep, linted only after the guards
 * were written (2026-10-18 10:20 IST), so their precision is the one to quote. `--held-out` writes heldout.ts.
 */
const HELD_OUT_CANDIDATES: { repo: string; language: DriftLanguage }[] = [
  ...['stanfordnlp/dspy', 'python-poetry/poetry', 'encode/django-rest-framework', 'letta-ai/letta', 'pallets/jinja', 'pallets/werkzeug', 'ollama/ollama-python'].map(
    (repo) => ({ repo, language: 'python' as const }),
  ),
  ...['modelcontextprotocol/servers', 'TanStack/table', 'nitrojs/nitro', 'vercel/swr', 'withastro/starlight', 'reduxjs/redux-toolkit', 'yargs/yargs'].map(
    (repo) => ({ repo, language: 'typescript' as const }),
  ),
  ...['junegunn/fzf', 'charmbracelet/bubbletea', 'urfave/cli', 'golang-migrate/migrate'].map((repo) => ({ repo, language: 'go' as const })),
];

const AGENT_FILE = /^(AGENTS\.md|AGENT\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.cursor|\.claude|\.windsurfrules|\.clinerules)$/;

async function gh(path: string, jq: string): Promise<string> {
  const { stdout } = await run('gh', ['api', path, '--jq', jq], { maxBuffer: 1 << 24 });
  return stdout.trim();
}

async function resolve(c: { repo: string; language: DriftLanguage }, refresh: boolean): Promise<DriftRepo> {
  const known = CORPUS.find((r) => r.repo.toLowerCase() === c.repo.toLowerCase());
  const meta = JSON.parse(await gh(`repos/${c.repo}`, '{full_name, stargazers_count, default_branch}')) as {
    full_name: string;
    stargazers_count: number;
    default_branch: string;
  };
  const sha = known && !refresh ? known.sha : await gh(`repos/${meta.full_name}/commits/${meta.default_branch}`, '.sha');
  const root = (await gh(`repos/${meta.full_name}/contents/?ref=${sha}`, '[.[].name] | join("\\n")')).split('\n');
  return {
    repo: meta.full_name,
    language: c.language,
    branch: meta.default_branch,
    sha,
    stars: meta.stargazers_count,
    agentFiles: root.filter((n) => AGENT_FILE.test(n)).sort(),
  };
}

const refresh = process.argv.includes('--refresh');
const heldOut = process.argv.includes('--held-out');
const out: DriftRepo[] = [];
const list = heldOut ? HELD_OUT_CANDIDATES : CANDIDATES;
// A few at a time: polite to the API, still quick.
for (let i = 0; i < list.length; i += 8) {
  out.push(...(await Promise.all(list.slice(i, i + 8).map((c) => resolve(c, refresh || heldOut)))));
}
const resolvedAt = new Date().toISOString();
if (heldOut) {
  const held = `/**
 * The Drift Hall's held-out set: popular repositories that are in none of the hall's corpus, .ocean/PRECISION.md or
 * C's sweep, pinned and linted only after the guards were written against the hall. Their precision is the number to
 * quote. Written by scripts/drift-hall/resolve.ts --held-out (${resolvedAt}).
 */
import type { DriftRepo } from './repos.js';

export const HELD_OUT_RESOLVED_AT = ${JSON.stringify(resolvedAt)};

export const HELD_OUT: DriftRepo[] = ${JSON.stringify(out, null, 2)};
`;
  await writeFile(join(import.meta.dirname, 'heldout.ts'), held);
  console.log(`wrote heldout.ts: ${out.length} repositories`);
  process.exit(0);
}
const body = `/**
 * The Drift Hall corpus: popular, active repositories Staleproof did not choose for its own precision runs (none
 * of them is in .ocean/PRECISION.md), each pinned to the commit the findings were checked at. Written by
 * scripts/drift-hall/resolve.ts (${resolvedAt}); stars are the count at that time.
 */
export type DriftLanguage = 'python' | 'typescript' | 'go';

export interface DriftRepo {
  /** owner/name as GitHub spells it. */
  repo: string;
  language: DriftLanguage;
  branch: string;
  /** The commit linted and hand-checked; permalinks point at it. */
  sha: string;
  stars: number;
  /** AI agent files at the repository root at that commit. */
  agentFiles: string[];
}

export const RESOLVED_AT = ${JSON.stringify(resolvedAt)};

export const CORPUS: DriftRepo[] = ${JSON.stringify(out, null, 2)};
`;
await writeFile(join(import.meta.dirname, 'repos.ts'), body);
console.log(`wrote repos.ts: ${out.length} repositories (${out.filter((r) => r.agentFiles.length).length} with agent files)`);
