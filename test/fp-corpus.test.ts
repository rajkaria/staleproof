import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFixture, readCorpus, storedPath } from '../scripts/fp-to-fixture.js';
import { MATURITY, maturityOf } from '../src/lint/maturity.js';
import { isRuleId } from '../src/lint/rules.js';

/**
 * The false-positive corpus (docs/false-positives.md): every reported false positive, reduced to the files it
 * depends on (test/fixtures/fp/<rule>-<slug>/), linted on its own. A finding a fixture says must not come back
 * fails the suite. A fixture marked `pending` is a known false positive whose fix has not landed: its findings
 * are expected back, and the test fails once they are gone, so the marker is removed and the guard goes live.
 */
const corpus = await readCorpus();

describe('false-positive corpus (test/fixtures/fp)', () => {
  it('has fixtures, each naming its source, its files and the findings it guards', () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const fx of corpus) {
      const e = fx.expected;
      expect(e.source.repo, fx.name).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(e.source.sha, fx.name).toMatch(/^[0-9a-f]{40}$/);
      expect(e.absent.length, fx.name).toBeGreaterThan(0);
      expect(e.why, `${fx.name}: say why the finding is wrong`).toBeTruthy();
      expect(fx.name.startsWith(`${e.absent[0]!.rule}-`), fx.name).toBe(true);
      const max = e.absent[0]!.maxSeverity;
      expect(e.summary).toBe(`no finding ${e.absent[0]!.rule}${max ? ` above ${max}` : ''} at ${[...new Set(e.absent.map((a) => `${a.file}:${a.line}`))].join(', ')}`);
      for (const a of e.absent) {
        expect(isRuleId(a.rule), a.rule).toBe(true);
        expect(e.files, `${fx.name}: ${a.file}`).toContain(a.file);
      }
      for (const f of e.files) expect(existsSync(join(fx.dir, 'repo', storedPath(f))), `${fx.name}: ${f}`).toBe(true);
    }
  });

  it('cites only fixtures that exist in the maturity evidence', () => {
    const names = corpus.map((fx) => fx.name);
    for (const [rule, m] of Object.entries(MATURITY)) {
      for (const [, list] of m.why.matchAll(/[Ff]ixtures? ((?:`[\w*-]+`(?:,? (?:and )?)?)+)/g)) {
        for (const [, cited] of list!.matchAll(/`([\w*-]+)`/g)) {
          const prefix = cited!.replace(/\*$/, '');
          expect(names.some((n) => (cited!.endsWith('*') ? n.startsWith(prefix) : n === cited)), `${rule} cites ${cited}`).toBe(true);
        }
      }
    }
  });

  it('a stable rule ships no unfixed false positive it does not own up to (MATURITY[rule].open)', () => {
    for (const fx of corpus.filter((x) => x.expected.pending)) {
      const rule = fx.expected.absent[0]!.rule;
      if (maturityOf(rule) === 'beta') continue;
      expect(MATURITY[rule].open ?? [], `${fx.name} is a known false positive of the stable rule ${rule}: land its guard, list it in MATURITY['${rule}'].open, or make the rule beta`).toContain(fx.name);
    }
    for (const [rule, m] of Object.entries(MATURITY)) {
      for (const name of m.open ?? []) {
        const fx = corpus.find((x) => x.name === name);
        expect(fx, `${rule} lists ${name}, which is not in the corpus`).toBeDefined();
        expect(fx!.expected.pending, `${name} passes now: remove it from MATURITY['${rule}'].open`).toBeTruthy();
      }
    }
  });

  for (const fx of corpus) {
    const where = [...new Set(fx.expected.absent.map((a) => `${a.file}:${a.line}`))].join(', ');
    if (fx.expected.pending) {
      it(`${fx.name}: known, not fixed yet (${where})`, async () => {
        const back = await checkFixture(fx);
        expect(back.length, `${fx.name} no longer reproduces: the fix landed, so remove "pending" from its expected.json`).toBeGreaterThan(0);
      });
    } else {
      it(`${fx.name}: ${fx.expected.summary}`, async () => {
        const back = await checkFixture(fx);
        expect(back.map((f) => `${f.rule} ${f.path}:${f.line} ${f.message}`)).toEqual([]);
      });
    }
  }
});
