import type { RuleSetting } from '../indexer/repo-config.js';
import type { OrgGraph } from './client.js';
import * as Q from './queries.js';

/**
 * Each repository's `[rules]` as it was indexed (`Repo.rule_settings`, since 0.8), so a check counts a beta example
 * rule the repository opts in (src/lint/maturity.ts `exampleKindCounts`). A graph indexed earlier has none: maturity
 * alone decides there.
 */
export async function ruleSettingsOf(graph: OrgGraph, repos: readonly string[]): Promise<Map<string, Record<string, RuleSetting>>> {
  const out = new Map<string, Record<string, RuleSetting>>();
  if (!repos.length) return out;
  const rows = await graph.run<{ name: string; ruleSettings: string | null }>(Q.repoRuleSettings, { repos: [...repos] }).catch(() => ({ rows: [] as { name: string; ruleSettings: string | null }[] }));
  for (const r of rows.rows) {
    try {
      if (r.ruleSettings) out.set(r.name, JSON.parse(r.ruleSettings) as Record<string, RuleSetting>);
    } catch {
      // An unreadable value is no opt-in.
    }
  }
  return out;
}
