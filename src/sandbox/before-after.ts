import type { ExampleRunRow } from '../format/report.js';
import type { OrgGraph } from '../graph/client.js';
import { exampleAtCommit, installSet, loadExample, recordSkippedRun, type ExampleForRun, type RunRecord } from '../runner/index.js';
import type { ExampleRunner } from '../runner/vercel-sandbox.js';
import type { ImpactData } from '../tools/graph-tools.js';
import { verdictOf, type RunExampleData } from '../tools/run-example.js';
import type { ToolContext } from '../tools/types.js';

/**
 * Examples before and after a pull request with any runner that fits the runner interface
 * (`runExample` in src/runner/index.ts, or `VercelSandboxRunner.runExample`): the selection
 * graph mode uses, and the `run_example` tool's two runs and verdict. Results land in the graph
 * as `Run` nodes linked to the pull request, so `loadRuns` and `checkMarkdown` render the same
 * before/after table the Action's report has.
 */

/**
 * The examples graph mode runs for a pull request (`runGraphCheck`): those predicted to break
 * first (a run turns the prediction into proof), then those of exactly linked sections, without
 * the ones the docs mark `skip` or `expect-error`; at most `max`.
 */
export async function examplesToRun(graph: OrgGraph, impact: Pick<ImpactData, 'predicted' | 'sections'>, max = 3): Promise<string[]> {
  const candidates = [
    ...new Set([
      ...(impact.predicted ?? []).filter((p) => p.confidence === 'exact').map((p) => p.example),
      ...impact.sections.filter((s) => s.confidence === 'exact').flatMap((s) => s.examples),
    ]),
  ];
  if (!candidates.length || max <= 0) return [];
  const marked = new Set(
    (await graph.run<{ id: string }>(`MATCH (e:CodeExample) WHERE e.id IN $ids AND coalesce(e.directive, '') <> '' RETURN e.id AS id`, { ids: candidates })).rows.map((r) => r.id),
  );
  return candidates.filter((e) => !marked.has(e)).slice(0, max);
}

/**
 * One example at the commit before the pull request and at the pull request, through `runner`:
 * the steps of the `run_example` tool with `pr_url` (src/tools/run-example.ts). A page the pull
 * request edits is run as it leaves it on the after side; a `before` run that is skipped stops
 * there; the verdict is `verdictOf`.
 */
export async function runBeforeAfter(ctx: ToolContext, prUrl: string, exampleId: string, runner: ExampleRunner): Promise<RunExampleData> {
  const example = await loadExample(ctx.graph, exampleId);
  if (!example) throw new Error(`no code example ${exampleId}`);
  if (example.directive) {
    const reason =
      example.directive === 'expect-error'
        ? 'the docs mark this example as failing on purpose (expect-error), so a run proves nothing'
        : 'the docs or the repository config mark this example skip';
    const run: RunRecord = { id: `run-directive-${example.id}`, example: example.id, status: 'skipped', reason, stdout: '', durationMs: 0, stitched: [], installed: [], side: 'current', cached: false, createdAt: Date.now() };
    return { example: example.id, url: example.url, verdict: 'skipped', runs: [run], editedByPr: false };
  }
  const pr = (
    await ctx.graph.run<{ repo: string; before: string; after: string; docs: string[] | null }>(
      `MATCH (pr:PullRequest {url: $url}) RETURN pr.repo AS repo, pr.before_sha AS before, pr.after_sha AS after, pr.docs_touched AS docs`,
      { url: prUrl },
    )
  ).rows[0];
  if (!pr) throw new Error(`${prUrl} has not been checked yet; call impact first`);
  const repos = await installSet(ctx.graph, [...new Set([...example.usedRepos, pr.repo])]);
  let after: ExampleForRun | null | undefined = example;
  let editedByPr = false;
  if (example.repo === pr.repo && (pr.docs ?? []).includes(example.path)) {
    const indexed =
      repos.find((r) => r.repo === example.repo)?.sha ?? (await ctx.graph.run<{ sha: string }>(`MATCH (r:Repo {name: $repo}) RETURN r.sha AS sha`, { repo: example.repo })).rows[0]?.sha;
    const edited = indexed ? await exampleAtCommit(ctx.config, example, indexed, pr.after, ctx.checkouts?.[example.repo]).catch(() => undefined) : undefined;
    if (edited !== undefined) {
      after = edited;
      editedByPr = edited === null || edited.code !== example.code;
    }
  }
  const runs: RunRecord[] = [];
  for (const side of ['before', 'after'] as const) {
    const ex = side === 'after' ? after : example;
    if (ex === null) {
      runs.push(await recordSkippedRun(ctx.graph, example.id, side, 'this pull request removes the example from its page', pr.after, prUrl));
      break;
    }
    runs.push(await runner(ctx.graph, ctx.config, ex, repos, { shas: { [pr.repo]: side === 'before' ? pr.before : pr.after }, side, prUrl, log: ctx.log, checkouts: ctx.checkouts, fresh: ctx.freshRuns }));
    if (runs[0]!.status === 'skipped') break;
  }
  return { example: example.id, url: example.url, verdict: verdictOf(runs), runs, editedByPr };
}

/**
 * `loadRuns` (src/format/report.ts) kept to the pull request's current commits: the latest run
 * on each side whose installed commits include the pull request's repository at that side's
 * commit. A pull request pushed to again keeps its `AT` edges to the earlier head's runs, which
 * must not be shown under the new head.
 */
export async function runsAtCommits(ctx: ToolContext, prUrl: string): Promise<ExampleRunRow[]> {
  const pr = (await ctx.graph.run<{ repo: string; before: string; after: string }>(`MATCH (pr:PullRequest {url: $url}) RETURN pr.repo AS repo, pr.before_sha AS before, pr.after_sha AS after`, { url: prUrl })).rows[0];
  if (!pr) return [];
  const rows = (
    await ctx.graph.run<{ example: string; url: string; side: 'before' | 'after'; status: string; error: string; reason: string; installed: string[] | null; at: number }>(
      `MATCH (r:Run)-[:AT]->(:PullRequest {url: $url})
       MATCH (r)-[:OF]->(e:CodeExample)
       RETURN e.id AS example, e.url AS url, r.side AS side, r.status AS status, r.error AS error, r.reason AS reason, r.installed AS installed, r.created_at AS at
       ORDER BY at ASC`,
      { url: prUrl },
    )
  ).rows;
  const atCommit = (installed: string[] | null, sha: string) => !installed?.length || installed.includes(`${pr.repo}@${sha}`);
  const byExample = new Map<string, ExampleRunRow>();
  for (const r of rows) {
    if (r.side !== 'before' && r.side !== 'after') continue;
    if (!atCommit(r.installed, r.side === 'before' ? pr.before : pr.after)) continue;
    const row = byExample.get(r.example) ?? { example: r.example, url: r.url, verdict: 'passes' as const };
    row[r.side] = { status: r.status, error: r.error ?? '', reason: r.reason ?? '' };
    byExample.set(r.example, row);
  }
  for (const row of byExample.values()) {
    const records = (['before', 'after'] as const).filter((side) => row[side]).map((side) => ({ side, status: row[side]!.status, error: row[side]!.error }) as unknown as RunRecord);
    row.verdict = verdictOf(records);
  }
  return [...byExample.values()];
}
