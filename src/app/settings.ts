import { parse } from 'smol-toml';
import { parseRepoName } from '../indexer/repo.js';
import { CONFIG_FILES, EMPTY_CONFIG, parseRepoConfig, type RepoConfig } from '../indexer/repo-config.js';
import { resolveAppConfig, type ResolvedAppConfig } from './checks.js';
import type { InstallationClient } from './github-app.js';

/**
 * A repository's `[app]` settings, read from its default branch (never from the pull
 * request: a pull request must not be able to turn its own check off). `.staleproof.toml`
 * wins over `[tool.staleproof]` in `pyproject.toml`, as everywhere else.
 */
export async function loadAppSettings(client: InstallationClient, repo: string, ref: string): Promise<{ app: ResolvedAppConfig; config: RepoConfig; warnings: string[] }> {
  let config: RepoConfig = EMPTY_CONFIG;
  let runExamples: boolean | undefined;
  const warnings: string[] = [];
  for (const file of CONFIG_FILES) {
    const text = await client.fileText(repo, file, ref);
    if (text === undefined) continue;
    try {
      config = parseRepoConfig(text, file);
    } catch (err) {
      warnings.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    runExamples = readRunExamples(text, file, warnings);
    if (file === '.staleproof.toml' || config !== EMPTY_CONFIG) break;
  }
  // `run-examples` is read here (readRunExamples): until the repository config parser knows the key, it reports it as unknown.
  warnings.push(...(config.warnings ?? []).filter((w) => !/unknown key app\.run-examples;/.test(w)));
  const app = resolveAppConfig(config.app);
  const alsoIndex: string[] = [];
  for (const r of app.alsoIndex) {
    try {
      alsoIndex.push(parseRepoName(r));
    } catch {
      warnings.push(`app.also-index: "${r}" is not owner/name; ignored`);
    }
  }
  return { app: { ...app, alsoIndex, runExamples: runExamples ?? app.runExamples }, config, warnings };
}

/**
 * `[app] run-examples` (`[tool.staleproof.app]` in pyproject.toml): `false` keeps the App from
 * running this repository's docs examples in a sandbox; the default is to run them when the
 * server can (src/app/examples.ts). Undefined when the file does not set it.
 */
export function readRunExamples(text: string, file: string, warnings: string[] = []): boolean | undefined {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const root = file.endsWith('pyproject.toml') ? ((doc.tool as Record<string, unknown> | undefined)?.staleproof as Record<string, unknown> | undefined) : doc;
  const app = root?.app;
  if (!app || typeof app !== 'object' || Array.isArray(app)) return undefined;
  const v = (app as Record<string, unknown>)['run-examples'];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  warnings.push(`${file}: app.run-examples must be a boolean; ignored`);
  return undefined;
}
