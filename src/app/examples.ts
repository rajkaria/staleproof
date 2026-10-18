import { getDeadline } from '@vercel/functions';
import { setting } from '../config.js';
import { JS_LANGS } from '../indexer/docs.js';
import type { ExampleRunRow } from '../format/report.js';
import { JS_NOT_HERE, sandboxCredentials, SandboxUnavailableError, vercelSandboxClient, VercelSandboxRunner, type SandboxClient } from '../runner/vercel-sandbox.js';
import { runBeforeAfter } from '../sandbox/before-after.js';
import type { RunExampleData } from '../tools/run-example.js';
import { truncate, type CheckOutcome, type ResolvedAppConfig } from './checks.js';
import type { ExamplePlan } from './checker.js';
import type { InstallationClient } from './github-app.js';
import type { AppRegistry } from './registry.js';

/**
 * The App's second phase: once the "Staleproof" check run is complete (graph results, fast,
 * as before), the docs examples graph mode selects (at most 3, predicted breaks first) run at
 * the pull request's base and head commits in a Vercel Sandbox (src/runner/vercel-sandbox.ts),
 * with the selection, verdicts and before/after table of the Action's report (src/sandbox/
 * before-after.ts, `checkMarkdown`). Their results go to a second check run, "Staleproof ·
 * examples", and the pull request comment is brought up to date.
 *
 * A second check run, not the first one updated: the graph check's conclusion stays final the
 * moment it is shown (branch protection on "Staleproof" never waits on a sandbox and never flips
 * minutes later); the examples check is visibly in progress while it runs, can be made required on
 * its own, and whatever goes wrong in a sandbox stays in it.
 *
 * It runs only when the server switch is on (`STALEPROOF_APP_RUN_EXAMPLES=on`), the server has
 * Sandbox credentials (the function's OIDC token on Vercel, or VERCEL_TOKEN + VERCEL_TEAM_ID +
 * VERCEL_PROJECT_ID), the repository does not set `[app] run-examples = false`, time is left in
 * this invocation and the daily budget allows. Otherwise the App does what it did before and the
 * check run says the examples run in the GitHub Action. A sandbox that fails or times out ends the
 * examples check as `neutral`, never `failure`.
 */

export const EXAMPLES_CHECK_NAME = 'Staleproof · examples';
const DETAILS_URL = 'https://staleproof.dev/#/docs/github-app';
const ACTION_DOCS = 'https://staleproof.dev/#/docs/github-action';
/** Left at the end of the invocation for completing the check run and the comment. */
const REPORT_MARGIN_MS = 25_000;

export interface AppExamplesOptions {
  /** The server switch (default: `STALEPROOF_APP_RUN_EXAMPLES` is `on`, `true` or `1`). */
  enabled?: boolean;
  /** The sandbox (default: `@vercel/sandbox` with this server's credentials, when it has some). */
  client?: SandboxClient;
  /**
   * The function's `maxDuration`, for when Vercel does not say when the invocation ends (`getDeadline()` from
   * `@vercel/functions` does on Vercel): default `STALEPROOF_APP_MAX_DURATION_S`, else 300 s on Vercel and no limit elsewhere.
   */
  maxDurationMs?: number;
  /** When the invocation ends (default `getDeadline()`; tests). */
  deadline?: () => Date | undefined;
  /** At most this long for the examples of one pull request (default `STALEPROOF_APP_EXAMPLES_BUDGET_S`, else 600 s). */
  budgetMs?: number;
  /** Fewer than this left in the invocation: not started (default 60 s). */
  minMs?: number;
  /** Example checks per day across installations (default `STALEPROOF_APP_EXAMPLE_CHECKS_PER_DAY`, else 200). */
  perDay?: number;
  /** Examples per pull request (default 3, as graph mode). */
  maxRuns?: number;
  /** Sandbox vCPUs (default 2) and region (default `STALEPROOF_SANDBOX_REGION`, else the project's). */
  vcpus?: number;
  region?: string;
}

export interface ExamplesSetup {
  enabled: boolean;
  /** The sandbox client, or why there is none (credentials are looked up per check: on Vercel they come with the request). */
  client(): { client?: SandboxClient; reason?: string };
  /** When this invocation is stopped (waitUntil work included), for a check that started at `startedAt`. */
  invocationEnd(startedAt: number): number;
  budgetMs: number;
  minMs: number;
  perDay: number;
  maxRuns: number;
  vcpus: number;
}

const num = (v: string | undefined): number | undefined => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

export function examplesSetup(o: AppExamplesOptions = {}, env: NodeJS.ProcessEnv = process.env): ExamplesSetup {
  const region = o.region ?? setting('SANDBOX_REGION', env);
  return {
    enabled: o.enabled ?? /^(on|true|1|yes)$/i.test(setting('APP_RUN_EXAMPLES', env) ?? ''),
    client: () => {
      if (o.client) return { client: o.client };
      const c = sandboxCredentials(env);
      return c.credentials ? { client: vercelSandboxClient({ credentials: c.credentials, ...(region ? { region } : {}) }) } : { reason: c.reason };
    },
    invocationEnd: (startedAt) => {
      let end: Date | undefined;
      try {
        end = (o.deadline ?? getDeadline)();
      } catch {
        end = undefined;
      }
      if (end && Number.isFinite(end.getTime())) return end.getTime();
      const max = o.maxDurationMs ?? (num(setting('APP_MAX_DURATION_S', env)) ?? 0) * 1000;
      return max ? startedAt + max : env.VERCEL ? startedAt + 300_000 : Number.POSITIVE_INFINITY;
    },
    budgetMs: o.budgetMs ?? (num(setting('APP_EXAMPLES_BUDGET_S', env)) ?? 600) * 1000,
    minMs: o.minMs ?? 60_000,
    perDay: o.perDay ?? num(setting('APP_EXAMPLE_CHECKS_PER_DAY', env)) ?? 200,
    maxRuns: o.maxRuns ?? 3,
    vcpus: o.vcpus ?? 2,
  };
}

export type ExamplesDecision =
  | { run: true; client: SandboxClient; budgetMs: number; candidates: string[]; note: string }
  | { run: false; why: 'none' | NotRun; reason: string; note?: string };

type NotRun = 'setting' | 'server' | 'time' | 'budget' | 'js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The line the "Staleproof" check run carries about the examples (none when no example is affected). */
export function examplesNote(n: number, why: 'run' | NotRun): string {
  const examples = `${n === 1 ? 'The docs example' : `The ${n} docs examples`} this pull request reaches`;
  const action = `the [GitHub Action](${ACTION_DOCS}) runs examples before and after a pull request`;
  switch (why) {
    case 'run':
      return `${examples} ${n === 1 ? 'runs' : 'run'} before and after it in a sandbox: the results come in the **${EXAMPLES_CHECK_NAME}** check.`;
    case 'setting':
      return `${examples} ${n === 1 ? 'is' : 'are'} not run by the App for this repository (\`[app] run-examples = false\`); ${action}.`;
    case 'server':
      return `${examples} ${n === 1 ? 'was' : 'were'} not run: the App on this server does not run examples, and ${action}.`;
    case 'time':
      return `${examples} ${n === 1 ? 'was' : 'were'} not run this time (no time was left for a sandbox in this check): re-run the check, or use the GitHub Action, which runs them before and after (${ACTION_DOCS}).`;
    case 'js':
      return `${examples} ${n === 1 ? 'is' : 'are'} JavaScript or TypeScript, which the App does not run yet; ${action}.`;
    case 'budget':
      return `${examples} ${n === 1 ? 'was' : 'were'} not run today (the App's daily budget for example runs is used up): re-run the check tomorrow, or use the GitHub Action, which runs them before and after (${ACTION_DOCS}).`;
  }
}

/** Whether this check's examples run in a sandbox, and what the check run says about them. */
export async function decideExamples(
  setup: ExamplesSetup | undefined,
  cfg: Pick<ResolvedAppConfig, 'runExamples'>,
  plan: ExamplePlan | undefined,
  registry: Pick<AppRegistry, 'withinDailyBudget'>,
  startedAt: number,
  now = Date.now(),
): Promise<ExamplesDecision> {
  const candidates = plan?.candidates.slice(0, setup?.maxRuns ?? 3) ?? [];
  const n = candidates.length;
  if (!n) return { run: false, why: 'none', reason: 'no affected example to run' };
  const no = (why: NotRun, reason: string): ExamplesDecision => ({ run: false, why, reason, note: examplesNote(n, why) });
  if (!cfg.runExamples) return no('setting', '[app] run-examples = false');
  if (!setup?.enabled) return no('server', 'the server switch STALEPROOF_APP_RUN_EXAMPLES is off');
  const { client, reason } = setup.client();
  if (!client) return no('server', reason ?? 'no sandbox client');
  const budgetMs = Math.min(setup.budgetMs, setup.invocationEnd(startedAt) - REPORT_MARGIN_MS - now);
  if (budgetMs < setup.minMs) return no('time', `${Math.max(0, Math.round(budgetMs / 1000))} s left in this invocation`);
  // Only Python examples run in the sandbox: a pull request reaching JS/TS examples only keeps them for the Action.
  const langs = (await plan!.ctx.graph.run<{ lang: string }>(`MATCH (e:CodeExample) WHERE e.id IN $ids RETURN e.lang AS lang`, { ids: candidates })).rows;
  if (langs.length && langs.every((l) => JS_LANGS.has(l.lang))) return no('js', 'only JavaScript/TypeScript examples are affected');
  if (!(await registry.withinDailyBudget('sandbox-examples', setup.perDay, now))) return no('budget', `more than ${setup.perDay} example checks today`);
  return { run: true, client, budgetMs, candidates, note: examplesNote(n, 'run') };
}

/** The before/after table of a report (`checkMarkdown`'s runs table), or undefined when it has none. */
export function runsTable(report: string): string | undefined {
  const lines = report.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| Example | Before ('));
  if (start < 0) return undefined;
  let end = start;
  while (end + 1 < lines.length && lines[end + 1]!.startsWith('|')) end++;
  return lines.slice(start, end + 1).join('\n');
}

const ORDER: [ExampleRunRow['verdict'], string][] = [
  ['breaks', 'breaks'],
  ['fixes', 'fixed'],
  ['changed-failure', 'fails differently'],
  ['already-broken', 'already broken'],
  ['passes', 'passes'],
  ['fails', 'fails'],
  ['skipped', 'not run'],
  ['error', 'not installed'],
];

/** "3 docs examples before and after: 1 breaks, 2 passes". */
export function examplesTitle(rows: readonly ExampleRunRow[]): string {
  const parts = ORDER.map(([v, label]) => [rows.filter((r) => r.verdict === v).length, label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return `${plural(rows.length, 'docs example')} before and after: ${parts.join(', ')}`.slice(0, 255);
}

/** `failure` only when the pull request breaks an example and `[app] fail-on` asks for it; never for a sandbox problem. */
export function examplesConclusion(rows: readonly ExampleRunRow[], failOn: string): 'success' | 'neutral' | 'failure' {
  const breaks = rows.filter((r) => r.verdict === 'breaks').length;
  if (breaks) return failOn === 'predicted' || failOn === 'breaks' ? 'failure' : 'neutral';
  return rows.some((r) => r.verdict !== 'skipped' && r.verdict !== 'error') ? 'success' : 'neutral';
}

/** One examples phase per pull request: a newer push stops the older one (its sandbox is destroyed). */
const phases = new Map<string, AbortController>();

class Superseded extends Error {}

export function supersedeExamples(key: string): void {
  phases.get(key)?.abort(new Superseded('a newer push is being checked'));
  phases.delete(key);
}

export interface ExamplesPhase {
  client: InstallationClient;
  repo: string;
  number: number;
  headSha: string;
  cfg: ResolvedAppConfig;
  plan: ExamplePlan;
  outcome: CheckOutcome;
  decision: Extract<ExamplesDecision, { run: true }>;
  vcpus?: number;
  /** The comment body for a report (phase one's: fixes outside the diff, the App's marker). */
  commentBody(report: string): string;
  /** Keep the pull request comment (phase one's policy and comment). */
  keepComment(outcome: CheckOutcome, body: string): Promise<string | undefined>;
  log: (msg: string) => void;
}

export interface ExamplesSummary {
  checkRunId?: number;
  conclusion?: string;
  title?: string;
  results: RunExampleData[];
  /** Why the sandbox could not run (all or some of) the examples. */
  error?: string;
  comment?: string;
}

/** Run the examples in a sandbox and report them on the "Staleproof · examples" check run. Never throws. */
export async function runExamplesCheck(p: ExamplesPhase): Promise<ExamplesSummary> {
  const key = `${p.repo.toLowerCase()}#${p.number}`;
  supersedeExamples(key);
  const ctl = new AbortController();
  phases.set(key, ctl);
  const timer = setTimeout(() => ctl.abort(new Error(`the examples took longer than the ${Math.round(p.decision.budgetMs / 1000)} s left for them`)), p.decision.budgetMs);
  timer.unref?.();
  const { candidates } = p.decision;
  const results: RunExampleData[] = [];
  let checkRunId: number | undefined;
  let error: string | undefined;
  let runner: VercelSandboxRunner | undefined;
  try {
    const run = await p.client.post<{ id: number }>(`/repos/${p.repo}/check-runs`, {
      name: EXAMPLES_CHECK_NAME,
      head_sha: p.headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      external_id: String(p.number),
      details_url: DETAILS_URL,
      output: {
        title: `Running ${plural(candidates.length, 'docs example')} before and after`,
        summary: `Staleproof is running ${candidates.map((c) => `\`${c.split(':').slice(1).join(':')}\``).join(', ')} at the commit before this pull request and at the pull request, in a sandbox with the network off.`,
      },
    });
    checkRunId = run.id;
    p.log(`${p.repo}#${p.number}: examples check run ${run.id} started (${candidates.length} example(s), ${Math.round(p.decision.budgetMs / 1000)} s)`);
    const token = await p.client.token();
    runner = new VercelSandboxRunner({
      client: p.decision.client,
      token,
      fetchImpl: p.client.fetchImpl,
      signal: ctl.signal,
      timeoutMs: p.decision.budgetMs + 30_000,
      ...(p.vcpus ? { vcpus: p.vcpus } : {}),
      log: (m) => p.log(`${p.repo}#${p.number}: ${m}`),
    });
    for (const id of candidates) {
      try {
        results.push(await runBeforeAfter({ ...p.plan.ctx, log: (m) => p.log(`${p.repo}#${p.number}: ${runner!.scrubbed(m)}`) }, p.plan.prUrl, id, runner.runExample));
      } catch (err) {
        error = runner.scrubbed((err as Error).message);
        if (err instanceof SandboxUnavailableError) break;
      }
    }
  } catch (err) {
    error = runner ? runner.scrubbed((err as Error).message) : (err as Error).message;
  } finally {
    clearTimeout(timer);
    if (phases.get(key) === ctl) phases.delete(key);
    await runner?.close();
  }
  if (!checkRunId) {
    p.log(`${p.repo}#${p.number}: examples not run: ${error}`);
    return { results, ...(error ? { error } : {}) };
  }

  let rows: ExampleRunRow[] = [];
  let report = p.outcome.report;
  try {
    const rendered = await p.plan.render();
    report = rendered.report;
    rows = rendered.runs.filter((r) => candidates.includes(r.example));
  } catch (err) {
    error ??= `the results could not be read back: ${(err as Error).message}`;
  }
  const notHere = results.filter((r) => r.runs.some((x) => x.reason === JS_NOT_HERE)).map((r) => r.example);
  // A newer push stopped this one before anything ran: `cancelled`, as GitHub shows a superseded run.
  const superseded = ctl.signal.reason instanceof Superseded;
  const conclusion = superseded && !rows.length ? 'cancelled' : examplesConclusion(rows, p.cfg.failOn);
  const title = rows.length
    ? examplesTitle(rows)
    : superseded
      ? 'Stopped: a newer push is being checked'
      : error
        ? 'Examples not run: the sandbox could not run them'
        : 'No example could be run here';
  const short = (sha: string) => sha.slice(0, 7);
  const lines: string[] = [];
  const table = runsTable(report);
  if (rows.length && table) {
    lines.push(`The docs examples this pull request reaches, run at the commit before it and at \`${short(p.headSha)}\` in a Vercel Sandbox (the repositories installed from source, a scratch FalkorDB on localhost:6379, the network off while each example runs):`, '', table, '');
  }
  if (notHere.length) lines.push(`Not run here: ${notHere.map((e) => `\`${e.split(':').slice(1).join(':')}\``).join(', ')} (${JS_NOT_HERE}).`, '');
  if (superseded && !rows.length) lines.push('A newer push to this pull request is being checked; its own **Staleproof · examples** check runs the examples.', '');
  else if (error) {
    lines.push(
      rows.length
        ? `The sandbox stopped before every example ran: ${error.split('\n')[0]!.slice(0, 300)}. The [GitHub Action](${ACTION_DOCS}) runs examples before and after a pull request.`
        : `Staleproof could not run the examples in a sandbox: ${error.split('\n')[0]!.slice(0, 300)}. Nothing about the docs follows from that; the [GitHub Action](${ACTION_DOCS}) runs examples before and after a pull request.`,
      '',
    );
  }
  if (!rows.length && !error && !notHere.length) lines.push('None of the affected examples could be run (see the Staleproof check for the pages).', '');
  lines.push(`<sub>A run with the same program and commits is recorded and not repeated; re-run this check from the Checks tab to try again.</sub>`);
  try {
    await p.client.patch(`/repos/${p.repo}/check-runs/${checkRunId}`, {
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: { title, summary: truncate(lines.join('\n')) },
    });
  } catch (err) {
    p.log(`${p.repo}#${p.number}: examples check run ${checkRunId} not completed: ${(err as Error).message}`);
  }

  // The comment is the whole report, now with the before/after table; never for a head that moved on.
  let comment: string | undefined;
  if (rows.length) {
    try {
      const pull = await p.client.get<{ head: { sha: string }; state: string }>(`/repos/${p.repo}/pulls/${p.number}`, { allow404: true });
      if (pull && pull.state === 'open' && pull.head.sha === p.headSha && !superseded) {
        const breaks = rows.filter((r) => r.verdict === 'breaks').length;
        comment = await p.keepComment({ ...p.outcome, report, ...(breaks ? { breaks } : {}) }, p.commentBody(report));
      } else comment = 'moved';
    } catch (err) {
      p.log(`${p.repo}#${p.number}: comment not updated with the examples: ${(err as Error).message}`);
    }
  }
  p.log(`${p.repo}#${p.number}: examples ${conclusion} (${title})${error ? `; ${error.split('\n')[0]}` : ''}`);
  return { checkRunId, conclusion, title, results, ...(error ? { error } : {}), ...(comment ? { comment } : {}) };
}
