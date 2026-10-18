import { cp, mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../src/indexer/repo-config.js';
import { lintRepo } from '../src/lint/engine.js';
import { lintExitCode } from '../src/lint/format.js';
import { BETA_RULES, isLowerConfidence, MATURITY, maturityOf, reportedSeverity, storedLowerConfidence, trusted } from '../src/lint/maturity.js';
import { RULE_BY_ID, RULES } from '../src/lint/rules.js';
import type { LintResult } from '../src/lint/types.js';
import { FIXTURES, gitIn } from './helpers.js';

/** The claims fixture as a git repository (one commit is enough: maturity does not read history). */
async function claimsRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-maturity-'));
  await cp(join(FIXTURES, 'claims'), dir, { recursive: true, filter: (src) => !src.endsWith('findings.json') });
  await rename(join(dir, 'gitignore.txt'), join(dir, '.gitignore'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('rule maturity (registry)', () => {
  it('gives every rule a maturity and the evidence for it', () => {
    for (const r of RULES) {
      expect(['stable', 'beta']).toContain(r.maturity);
      expect(r.maturity).toBe(MATURITY[r.id].maturity);
      // Evidence, not a label: which repositories, what was found.
      expect(r.maturityWhy.length, r.id).toBeGreaterThan(60);
      expect(r.maturityWhy).toBe(MATURITY[r.id].why);
    }
    expect(Object.keys(MATURITY).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  it('pins the beta list: changing it is a decision with evidence (.ocean/PRECISION.md)', () => {
    expect(RULES.filter((r) => r.maturity === 'beta').map((r) => r.id)).toEqual([...BETA_RULES]);
    // 0.8.0, from the Drift Hall (63 fresh repositories): a rule is stable at 80% precision or more there.
    // path-missing and line-out-of-range: beta after the held-out check (18 fresh repositories, 0 true findings).
    expect([...BETA_RULES]).toEqual([
      'path-missing',
      'line-out-of-range',
      'anchor-missing',
      'cli-flag-unknown',
      'symbol-missing',
      'example-unknown-keyword',
      'example-too-many-arguments',
      'example-missing-argument',
      'example-missing-import',
      'example-missing-attribute',
    ]);
    expect(maturityOf('path-missing')).toBe('beta');
    expect(maturityOf('link-broken')).toBe('stable');
    expect(maturityOf('env-unused')).toBe('stable');
  });

  it('keeps the registry severity as the severity a rule earns when it is trusted', () => {
    expect(RULE_BY_ID.get('env-unused')!.severity).toBe('warning');
    expect(RULE_BY_ID.get('symbol-missing')!.severity).toBe('error');
  });
});

describe('reportedSeverity', () => {
  it('reports a beta rule at info, lower confidence, until the config opts it in', () => {
    const beta = { severity: 'warning' as const, maturity: 'beta' as const };
    expect(reportedSeverity(beta)).toEqual({ severity: 'info', lowerConfidence: true });
    expect(reportedSeverity(beta, 'error')).toEqual({ severity: 'error', lowerConfidence: false });
    expect(reportedSeverity(beta, 'warning')).toEqual({ severity: 'warning', lowerConfidence: false });
    // Naming the rule at all is a decision about it: `info` opts in at info.
    expect(reportedSeverity(beta, 'info')).toEqual({ severity: 'info', lowerConfidence: false });
  });

  it('leaves stable rules at their severity, or the configured one', () => {
    const stable = { severity: 'error' as const, maturity: 'stable' as const };
    expect(reportedSeverity(stable)).toEqual({ severity: 'error', lowerConfidence: false });
    expect(reportedSeverity(stable, 'warning')).toEqual({ severity: 'warning', lowerConfidence: false });
  });

  it("lowers to a check's own cap for one finding, which config never raises", () => {
    const stable = { severity: 'warning' as const, maturity: 'stable' as const };
    expect(reportedSeverity(stable, undefined, 'info')).toEqual({ severity: 'info', lowerConfidence: false });
    expect(reportedSeverity(stable, 'error', 'info')).toEqual({ severity: 'info', lowerConfidence: false });
    expect(reportedSeverity(stable, 'info', 'warning')).toEqual({ severity: 'info', lowerConfidence: false });
    expect(reportedSeverity({ severity: 'warning', maturity: 'beta' }, undefined, 'warning')).toEqual({ severity: 'info', lowerConfidence: true });
  });

  it('reads stored findings: the stored flag, else (graphs indexed before 0.8) the rule maturity', () => {
    expect(storedLowerConfidence('symbol-missing', true)).toBe(true);
    expect(storedLowerConfidence('symbol-missing', false)).toBe(false);
    expect(storedLowerConfidence('symbol-missing', null)).toBe(true);
    expect(storedLowerConfidence('symbol-missing', undefined)).toBe(true);
    expect(storedLowerConfidence('env-unused', undefined)).toBe(false);
    expect(storedLowerConfidence('link-broken', undefined)).toBe(false);
    expect(storedLowerConfidence('path-missing', undefined)).toBe(true);
    expect(storedLowerConfidence('not-a-rule', undefined)).toBe(false);
  });
});

describe('lint with beta rules', () => {
  let dir: string;
  let result: LintResult;
  let optedIn: LintResult;

  beforeAll(async () => {
    dir = await claimsRepo();
    result = await lintRepo({ dir, repo: 'acme/claims-demo' });
    // Every beta rule opted back in at the severity it has when trusted.
    const toml = `[rules]\n${[...BETA_RULES].map((id) => `"${id}" = "${RULE_BY_ID.get(id)!.severity}"`).join('\n')}\n`;
    optedIn = await lintRepo({ dir, repo: 'acme/claims-demo', config: parseRepoConfig(toml, '.staleproof.toml') });
  });

  it('reports beta findings at info, marked lower confidence, and nothing else changes', () => {
    const beta = result.findings.filter((f) => maturityOf(f.rule) === 'beta');
    expect(beta.map((f) => f.rule).sort()).toEqual([
      'anchor-missing',
      'anchor-missing',
      'cli-flag-unknown',
      'cli-flag-unknown',
      'example-unknown-keyword',
      'line-out-of-range',
      'path-missing',
      'path-missing',
      'symbol-missing',
    ]);
    for (const f of beta) {
      expect(f.severity).toBe('info');
      expect(f.lowerConfidence).toBe(true);
      expect(isLowerConfidence(f)).toBe(true);
    }
    for (const f of result.findings.filter((x) => maturityOf(x.rule) === 'stable')) {
      expect(f.lowerConfidence).toBeUndefined();
      expect(f.severity).toBe(RULE_BY_ID.get(f.rule)!.severity);
    }
    expect(result.summary.lowerConfidence).toBe(beta.length);
  });

  it('never changes a fingerprint, a place or a message', () => {
    const key = (r: LintResult) => r.findings.map((f) => `${f.fingerprint} ${f.rule} ${f.path}:${f.line}:${f.column} ${f.message}`).sort();
    expect(key(result)).toEqual(key(optedIn));
  });

  it('opted in, a beta rule is trusted: its own severity, no flag', () => {
    const beta = optedIn.findings.filter((f) => maturityOf(f.rule) === 'beta');
    expect(beta.length).toBeGreaterThan(0);
    for (const f of beta) {
      expect(f.severity).toBe(RULE_BY_ID.get(f.rule)!.severity);
      expect(f.lowerConfidence).toBeUndefined();
    }
    expect(optedIn.summary.lowerConfidence ?? 0).toBe(0);
  });

  it('counts lower-confidence findings in the summary as the infos they are reported as', () => {
    const infos = result.findings.filter((f) => f.severity === 'info').length;
    expect(result.summary.infos).toBe(infos);
    expect(result.summary.errors + result.summary.warnings + result.summary.infos).toBe(result.findings.length);
  });

  it('never fails --fail-on with a lower-confidence finding, at any level', () => {
    const onlyBeta: LintResult = { ...result, findings: result.findings.filter(isLowerConfidence) };
    expect(onlyBeta.findings.length).toBeGreaterThan(0);
    for (const level of ['error', 'warning', 'info'] as const) expect(lintExitCode(onlyBeta, level)).toBe(0);
    expect(trusted(onlyBeta.findings)).toEqual([]);
    // Opted in, the same findings fail at their level.
    const opted: LintResult = { ...optedIn, findings: optedIn.findings.filter((f) => maturityOf(f.rule) === 'beta') };
    expect(lintExitCode(opted, 'warning')).toBe(1);
  });
});
