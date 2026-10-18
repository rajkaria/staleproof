import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maturityOf } from '../src/lint/maturity.js';
import type { RuleId } from '../src/lint/types.js';
import { groupByReason, precisionOf, validateDriftHall, type DriftHallData } from '../scripts/drift-hall/schema.js';

const root = join(import.meta.dirname, '..');
const hallFile = join(root, 'web', 'public', 'drift-hall.json');
const verdictsFile = join(root, '.ocean', 'drift-hall', 'verdicts.jsonl');

const load = (): DriftHallData => JSON.parse(readFileSync(hallFile, 'utf8')) as DriftHallData;

/** A minimal valid hall: one repository, one confirmed finding, one false positive. */
function sample(): DriftHallData {
  const sha = 'a'.repeat(40);
  return {
    generatedAt: '2026-10-18T06:00:00.000Z',
    staleproofVersion: '0.8.0',
    corpus: { resolvedAt: '2026-10-18T01:36:25.817Z', repos: 1, byLanguage: { python: 1, typescript: 0, go: 0 } },
    totals: {
      repos: 1,
      reposWithDrift: 1,
      filesChecked: 3,
      judged: 2,
      confirmed: 1,
      falsePositive: 1,
      unclear: 0,
      infosSampled: 0,
      falsePositivesFixed: 0,
      prsDrafted: 1,
      prsOpened: 0,
      prsMerged: 0,
      causes: { confirmed: 1, falsePositive: 1, unclear: 0 },
    },
    repos: [
      {
        repo: 'acme/app',
        sha,
        stars: 10,
        language: 'python',
        agentFiles: ['AGENTS.md'],
        filesChecked: 3,
        findings: [
          {
            id: '0123456789ab',
            rule: 'path-missing',
            severity: 'error',
            file: 'AGENTS.md',
            line: 4,
            message: '`src/old.py` does not exist in the repository.',
            fixAvailable: false,
            permalink: `https://github.com/acme/app/blob/${sha}/AGENTS.md#L4`,
            why: 0,
          },
        ],
        reasons: ['The file moved to src/new.py'],
        counts: { confirmed: 1, falsePositive: 1, unclear: 0 },
        excluded: ['ba9876543210'],
        pr: { status: 'drafted', title: 'docs: fix a stale path in AGENTS.md' },
      },
    ],
    precision: {
      version: '0.8.0',
      byRule: { 'path-missing': { confirmed: 1, falsePositive: 0, unclear: 0 } },
      total: { confirmed: 1, falsePositive: 0, unclear: 0 },
      beta: { version: '0.8.0', byRule: { 'anchor-missing': { confirmed: 0, falsePositive: 1, unclear: 0 } }, total: { confirmed: 0, falsePositive: 1, unclear: 0 } },
      before: {
        version: '0.6.1',
        byRule: { 'path-missing': { confirmed: 1, falsePositive: 0, unclear: 0 }, 'anchor-missing': { confirmed: 0, falsePositive: 1, unclear: 0 } },
        total: { confirmed: 1, falsePositive: 1, unclear: 0 },
      },
      note: 'The guards were written against these repositories.',
    },
    heldOut: {
      version: '0.8.0',
      byRule: { 'link-broken': { confirmed: 1, falsePositive: 1, unclear: 0 } },
      total: { confirmed: 1, falsePositive: 1, unclear: 0 },
      resolvedAt: '2026-10-18T04:50:00.000Z',
      note: 'Linted only after the guards were written.',
      repos: [
        {
          repo: 'acme/held',
          sha: 'b'.repeat(40),
          stars: 5,
          language: 'go',
          agentFiles: [],
          filesChecked: 2,
          counts: { confirmed: 1, falsePositive: 1, unclear: 0 },
          findings: [
            {
              id: 'aaaaaaaaaaaa',
              rule: 'link-broken',
              severity: 'error',
              file: 'README.md',
              line: 3,
              message: 'The link target `x.md` does not exist.',
              fixAvailable: false,
              permalink: `https://github.com/acme/held/blob/${'b'.repeat(40)}/README.md#L3`,
              why: 0,
            },
          ],
          reasons: ['x.md was deleted'],
          excluded: ['bbbbbbbbbbbb'],
        },
      ],
    },
    falsePositiveClasses: [{ id: 'site-slugger', title: 'Site sluggers', count: 1, rules: ['anchor-missing'], example: 'acme/app@aaaaaaaaa docs/a.md:3', status: 'open' }],
  };
}

describe('drift hall schema', () => {
  it('accepts a sound file', () => {
    expect(validateDriftHall(sample())).toEqual([]);
  });

  it('rejects a false-positive or unclear finding listed as drift', () => {
    const d = sample();
    d.repos[0]!.excluded.push('0123456789ab');
    expect(validateDriftHall(d)).toContain('acme/app AGENTS.md:4: judged false-positive or unclear, but listed as drift');
  });

  it('rejects counts that do not add up, bad permalinks and missing PR entries', () => {
    const d = sample();
    d.totals.falsePositive = 0;
    d.repos[0]!.findings[0]!.permalink = 'https://github.com/acme/app/blob/main/AGENTS.md#L4';
    d.repos[0]!.pr = null;
    const errs = validateDriftHall(d);
    expect(errs.some((e) => e.startsWith('totals.falsePositive'))).toBe(true);
    expect(errs.some((e) => e.includes('permalink is not'))).toBe(true);
    expect(errs).toContain('acme/app: confirmed findings but no PR entry');
  });

  it('rejects more listed findings than confirmed verdicts, and precision that does not match the repos or its total', () => {
    const d = sample();
    d.repos[0]!.findings.push({ ...d.repos[0]!.findings[0]!, id: 'cccccccccccc', line: 5, permalink: `https://github.com/acme/app/blob/${'a'.repeat(40)}/AGENTS.md#L5` });
    d.precision.before.byRule['path-missing']!.confirmed = 3;
    d.precision.byRule['path-missing']!.confirmed = 2;
    const errs = validateDriftHall(d);
    expect(errs).toContain('acme/app: more findings than confirmed verdicts');
    expect(errs.some((e) => e.startsWith('precision.before confirmed'))).toBe(true);
    expect(errs).toContain('precision.total.confirmed is not the sum of its rules');
  });

  it('rejects a held-out false positive listed as drift, and held-out counts that do not add up', () => {
    const d = sample();
    d.heldOut!.repos[0]!.excluded.push('aaaaaaaaaaaa');
    d.heldOut!.repos[0]!.counts.unclear = 1;
    const errs = validateDriftHall(d);
    expect(errs).toContain('heldOut acme/held README.md:3: judged false-positive or unclear, but listed as drift');
    expect(errs).toContain('heldOut unclear: repos 1, rules (default and beta) 0');
  });
});

describe('drift hall page helpers', () => {
  it('groups findings by reason, largest first, and computes precision without unclear verdicts', () => {
    const r = sample().repos[0]!;
    const f = r.findings[0]!;
    r.findings = [f, { ...f, id: 'dddddddddddd', why: 1 }, { ...f, id: 'eeeeeeeeeeee', why: 1 }];
    r.reasons.push('Two of a kind');
    expect(groupByReason(r).map((g) => [g.why, g.findings.length])).toEqual([
      ['Two of a kind', 2],
      ['The file moved to src/new.py', 1],
    ]);
    expect(precisionOf({ confirmed: 3, falsePositive: 1, unclear: 9 })).toBe(75);
    expect(precisionOf({ confirmed: 0, falsePositive: 0, unclear: 2 })).toBeUndefined();
  });
});

describe.skipIf(!existsSync(hallFile))('web/public/drift-hall.json', () => {
  it('is a valid Drift Hall file', () => {
    expect(validateDriftHall(load())).toEqual([]);
  });

  it('lists only confirmed findings: no false positive or unclear verdict appears as drift', () => {
    const hall = load();
    for (const r of hall.repos) {
      const listed = new Set(r.findings.map((f) => f.id));
      expect(r.excluded.filter((id) => listed.has(id)), r.repo).toEqual([]);
      expect(r.findings.length, r.repo).toBeLessThanOrEqual(r.counts.confirmed);
      expect(r.excluded.length, r.repo).toBe(r.counts.falsePositive + r.counts.unclear);
    }
  });

  it('follows the current rule maturity: no beta rule in a default view, no stable rule in a beta view', () => {
    const hall = load();
    const beta = (rule: string) => maturityOf(rule as RuleId) === 'beta';
    for (const view of [hall.precision, hall.heldOut].filter((v) => v !== undefined)) {
      expect(Object.keys(view.byRule).filter(beta), 'default view').toEqual([]);
      expect(Object.keys(view.beta?.byRule ?? {}).filter((r) => !beta(r)), 'beta view').toEqual([]);
    }
  });

  it('keeps the held-out set apart: none of its repositories is in the hall', () => {
    const hall = load();
    const inHall = new Set(hall.repos.map((r) => r.repo));
    for (const r of hall.heldOut?.repos ?? []) expect(inHall.has(r.repo), r.repo).toBe(false);
  });

  // The hand checks live in .ocean/ (local only): when present, every listed finding must be a confirmed verdict.
  it.skipIf(!existsSync(verdictsFile))('matches the hand-checked verdicts', () => {
    const rows = readFileSync(verdictsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { repo: string; fingerprint: string; verdict: string; sampled?: boolean });
    const verdict = new Map(rows.filter((v) => !v.sampled).map((v) => [`${v.repo}|${v.fingerprint.slice(0, 12)}`, v.verdict]));
    for (const r of load().repos) {
      for (const f of r.findings) expect(verdict.get(`${r.repo}|${f.id}`), `${r.repo} ${f.file}:${f.line}`).toBe('confirmed');
      for (const id of r.excluded) expect(['false-positive', 'unclear'], `${r.repo} ${id}`).toContain(verdict.get(`${r.repo}|${id}`));
    }
  });
});
