import { useEffect, useMemo, useState } from 'react';
import { groupByReason, precisionOf, type DriftHallData as HallData, type HallFinding, type HallRepo } from '../../scripts/drift-hall/schema';
import { PACKAGE, PRODUCT } from './docs/manifest';

const LANG: Record<HallRepo['language'], string> = { python: 'Python', typescript: 'TypeScript / JavaScript', go: 'Go' };
const PR_LABEL: Record<NonNullable<HallRepo['pr']>['status'], string> = { drafted: 'PR drafted', opened: 'PR open', merged: 'PR merged' };
const stars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/** Text with `code spans` (the hand checks' reasons and Staleproof's messages use them) rendered as code. */
function Ticks({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/);
  return <>{parts.map((p, i) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}

/** staleproof.dev/#/drift: the Drift Hall, read from web/public/drift-hall.json (written by scripts/drift-hall/build.ts). */
export function DriftHallPage() {
  const [data, setData] = useState<HallData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch('/drift-hall.json')
      .then((r) => (r.ok ? (r.json() as Promise<HallData>) : Promise.reject(new Error(`drift-hall.json: ${r.status}`))))
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <section className="drift-hall wrap page-pad">
      <style>{CSS}</style>
      <span className="eyebrow">Drift Hall</span>
      <h1>Docs drift in famous repositories, checked by hand</h1>
      <p className="lede">
        {PRODUCT} read the docs, READMEs and AI agent files of popular open-source projects it did not choose for its own tests, at a pinned commit. Every error and warning it
        reported was then checked by hand against the repository: the drift is listed here with a link to the line, and every false positive is counted below, not hidden.
      </p>
      {error && <div className="banner err">The Drift Hall data could not be loaded ({error}).</div>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <Hall data={data} />}
    </section>
  );
}

function Hall({ data }: { data: HallData }) {
  const t = data.totals;
  const p = data.precision;
  const shown = precisionOf(p.total);
  const held = data.heldOut;
  const heldP = held ? precisionOf(held.total) : undefined;
  const before = precisionOf(p.before.total);
  const [lang, setLang] = useState<'all' | HallRepo['language']>('all');
  const [onlyDrift, setOnlyDrift] = useState(true);
  const repos = useMemo(() => data.repos.filter((r) => (lang === 'all' || r.language === lang) && (!onlyDrift || r.findings.length)), [data, lang, onlyDrift]);
  return (
    <>
      <div className="dh-stats" aria-label="Drift Hall in numbers">
        <Stat
          value={shown === undefined ? '–' : `${shown}%`}
          label={`precision of what ${PRODUCT} ${p.version} shows`}
          sub={`warnings and errors, the default; ${p.total.confirmed.toLocaleString('en-US')} confirmed, ${p.total.falsePositive} false positives${p.version !== p.before.version && before !== undefined ? `; ${before}% in ${p.before.version}` : ''}`}
          tone="good"
        />
        {held && (
          <Stat
            value={heldP === undefined ? '–' : `${heldP}%`}
            label="held-out precision"
            sub={`${held.repos.length} repositories linted only after the guards: ${held.total.confirmed} confirmed, ${held.total.falsePositive} false positive${held.total.falsePositive === 1 ? '' : 's'} by default${held.beta && held.beta.total.confirmed + held.beta.total.falsePositive ? `; beta rules ${held.beta.total.confirmed}/${held.beta.total.falsePositive} at info` : ''}`}
          />
        )}
        <Stat value={t.confirmed} label="confirmed drift" sub={`${t.causes.confirmed} distinct causes in ${t.reposWithDrift} of ${t.repos} repositories`} tone="drift" />
        <Stat
          value={t.falsePositive}
          label={`false positives found in ${p.before.version}`}
          sub={`${t.causes.falsePositive} distinct causes in ${data.falsePositiveClasses.length} classes${fixedNote(data)}`}
          tone="fp"
        />
        <Stat value={t.prsDrafted + t.prsOpened + t.prsMerged} label={t.prsOpened + t.prsMerged ? 'fixes offered' : 'fixes drafted'} sub={`${t.prsMerged} merged · ${t.prsOpened} open · ${t.prsDrafted} drafted, not sent yet`} />
      </div>
      <p className="dh-note">
        <strong>Read this first.</strong> <Ticks text={p.note} />
        {p.notRerun?.length ? ` Not re-run with ${p.version} (their size): ${p.notRerun.join(', ')}; the ${p.version} figures leave them out.` : ''}
      </p>

      <div className="dh-method">
        <h2>Method</h2>
        <ul>
          <li>
            <strong>Repositories we did not pick for our own tests.</strong> {data.corpus.repos} popular, active projects with real docs, most with <code>AGENTS.md</code>,{' '}
            <code>CLAUDE.md</code> or Cursor rules; none of them is one {PRODUCT}'s precision runs were tuned on. Each is pinned to a commit, and every link below points at that
            commit.
          </li>
          <li>
            <strong>Every finding hand-checked.</strong> Each error and warning was read against the repository: the doc line and what it names (the file, heading, script,
            signature). A link that works on the project's own docs site (its slugger, site-root paths, generated pages) counts as a false positive of {PRODUCT}, not drift.
            Info-level findings were sampled.
          </li>
          <li>
            <strong>False positives counted, not hidden.</strong> They make the precision figures below, grouped by cause; each cause goes to the rule's owner to fix.
            Copies of one page (a linked agent file, a docs site's frozen copy per release) count once.
          </li>
          <li>
            <strong>Fixes offered to maintainers.</strong> One small, respectful docs pull request per repository, opened by hand. Run it yourself:{' '}
            <code>npx -y {PACKAGE} lint</code>.
          </li>
        </ul>
      </div>

      <div className="dh-head">
        <h2>Repositories</h2>
        <div className="dh-filters">
          <label>
            <span className="sr-only">Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
              <option value="all">All languages</option>
              {(Object.keys(LANG) as HallRepo['language'][]).map((l) => (
                <option key={l} value={l}>
                  {LANG[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="dh-check">
            <input type="checkbox" checked={onlyDrift} onChange={(e) => setOnlyDrift(e.target.checked)} /> Only with drift
          </label>
        </div>
      </div>
      <ul className="dh-repos">
        {repos.map((r) => (
          <RepoRow key={r.repo} r={r} />
        ))}
        {!repos.length && <li className="muted">No repository matches.</li>}
      </ul>

      <h2>Precision by rule</h2>
      <p className="muted small">
        Each judged warning and error, by the rule that reported it: what {PRODUCT} {p.version} reports by default (warnings and errors), what it reports only at info
        (beta rules, which never fail a check or cost score), and every warning and error of {p.before.version} before the guards. Precision is confirmed out of confirmed plus
        false positives; unclear verdicts are left out.
      </p>
      <RuleTable data={data} />

      {held && <HeldOutSection held={held} />}

      <h2>False positives, by cause</h2>
      <p className="muted small">What {PRODUCT} got wrong in these repositories. Each cause is a bug in a rule, routed to its fix; fixed causes say in which version.</p>
      <ul className="dh-fp">
        {data.falsePositiveClasses.map((c) => (
          <li key={c.id}>
            <div className="dh-fp-top">
              <strong>
                <Ticks text={c.title} />
              </strong>
              <span className={`chip ${c.status === 'fixed' ? 'ok' : 'sev api'}`}>{classStatus(c)}</span>
            </div>
            <div className="muted small">
              {c.count} finding{c.count === 1 ? '' : 's'} · {c.rules.join(', ')} · e.g. <code>{c.example}</code>
            </div>
          </li>
        ))}
      </ul>

      <p className="muted small dh-foot">
        Data: <a href="/drift-hall.json">drift-hall.json</a> · {PRODUCT} {data.staleproofVersion} · built {data.generatedAt.slice(0, 10)} · commits resolved{' '}
        {data.corpus.resolvedAt.slice(0, 10)} · how it is made: <a href="#/docs/drift-hall">Drift Hall</a>
      </p>
    </>
  );
}

/** "; 120 fixed and 400 lowered to info in 0.8.0" once a later version was run on the same commits. */
function fixedNote(data: HallData): string {
  const t = data.totals;
  const version = data.falsePositiveClasses.find((c) => c.fixedIn)?.fixedIn;
  const parts = [t.falsePositivesFixed ? `${t.falsePositivesFixed.toLocaleString('en-US')} fixed` : '', t.falsePositivesDemoted ? `${t.falsePositivesDemoted.toLocaleString('en-US')} lowered to info` : ''].filter(Boolean);
  return parts.length ? `; ${parts.join(' and ')}${version ? ` in ${version}` : ''}` : '';
}

function classStatus(c: HallData['falsePositiveClasses'][number]): string {
  if (c.status === 'fixed') return `fixed in ${c.fixedIn ?? 'a later version'}`;
  const done = [c.fixed ? `${c.fixed} fixed` : '', c.demoted ? `${c.demoted} now info` : ''].filter(Boolean);
  return done.length ? `open · ${done.join(', ')}${c.fixedIn ? ` in ${c.fixedIn}` : ''}` : 'open';
}

/** "31 Python, 25 TS/JS, 5 Go", over the repositories actually linted (and how many of the corpus could not be). */
function checkedLanguages(data: HallData): string {
  const n = (l: HallRepo['language']) => data.repos.filter((r) => r.language === l).length;
  const missing = data.corpus.repos - data.repos.length;
  return `${n('python')} Python, ${n('typescript')} TS/JS, ${n('go')} Go${missing ? ` (${missing} of ${data.corpus.repos} could not be linted)` : ''}`;
}

type Counts = HallData['precision']['total'];
const cell = (c: Counts | undefined) => {
  if (!c) return <span className="muted">–</span>;
  const pr = precisionOf(c);
  return (
    <>
      <strong>{pr === undefined ? '–' : `${pr}%`}</strong>{' '}
      <span className="muted small">
        {c.confirmed}/{c.falsePositive}
        {c.unclear ? ` (+${c.unclear}?)` : ''}
      </span>
    </>
  );
};

/** One row per rule: the default view, the beta view and the before view side by side. */
function RuleTable({ data }: { data: HallData }) {
  const p = data.precision;
  const rules = [...new Set([...Object.keys(p.byRule), ...Object.keys(p.beta?.byRule ?? {}), ...Object.keys(p.before.byRule)])].sort((a, b) => {
    const rank = (r: string) => (p.byRule[r] ? 0 : p.beta?.byRule[r] ? 1 : 2);
    const n = (r: string) => (p.before.byRule[r]?.confirmed ?? 0) + (p.before.byRule[r]?.falsePositive ?? 0);
    return rank(a) - rank(b) || n(b) - n(a);
  });
  return (
    <div className="dh-table-wrap">
      <table className="dh-table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>{p.version} default</th>
            <th>{p.version} beta (info)</th>
            <th>{p.before.version} before</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule}>
              <td>
                <a href={`#/docs/rules/${rule}`}>
                  <code>{rule}</code>
                </a>
              </td>
              <td>{cell(p.byRule[rule])}</td>
              <td>{cell(p.beta?.byRule[rule])}</td>
              <td>{cell(p.before.byRule[rule])}</td>
            </tr>
          ))}
          <tr className="dh-total">
            <td>all</td>
            <td>{cell(p.total)}</td>
            <td>{cell(p.beta?.total)}</td>
            <td>{cell(p.before.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function HeldOutSection({ held }: { held: NonNullable<HallData['heldOut']> }) {
  const order = (byRule: Record<string, Counts>) => Object.entries(byRule).sort((a, b) => b[1].confirmed + b[1].falsePositive - (a[1].confirmed + a[1].falsePositive));
  const rules = order(held.byRule);
  const beta = order(held.beta?.byRule ?? {});
  return (
    <>
      <h2>Held-out check</h2>
      <p className="muted small">
        <Ticks text={held.note} /> {held.repos.length} repositories, pinned {held.resolvedAt.slice(0, 10)}, {PRODUCT} {held.version}; a small sample, so each figure carries its
        counts.
      </p>
      <div className="dh-table-wrap">
        <table className="dh-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Precision</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(([rule, c]) => (
              <tr key={rule}>
                <td>
                  <code>{rule}</code>
                </td>
                <td>{cell(c)}</td>
              </tr>
            ))}
            <tr className="dh-total">
              <td>all, by default</td>
              <td>{cell(held.total)}</td>
            </tr>
            {beta.map(([rule, c]) => (
              <tr key={rule}>
                <td>
                  <code>{rule}</code> <span className="muted small">beta, info</span>
                </td>
                <td>{cell(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="dh-repos">
        {held.repos.map((r) => (
          <RepoRow key={r.repo} r={{ ...r, pr: null }} />
        ))}
      </ul>
    </>
  );
}

function Stat({ value, label, sub, tone }: { value: number | string; label: string; sub?: string; tone?: 'drift' | 'fp' | 'good' }) {
  return (
    <div className={`dh-stat${tone ? ` ${tone}` : ''}`}>
      <span className="dh-stat-num">{typeof value === 'number' ? value.toLocaleString('en-US') : value}</span>
      <span className="dh-stat-label">{label}</span>
      {sub && <span className="dh-stat-sub muted small">{sub}</span>}
    </div>
  );
}

const FIRST = 5;

function RepoRow({ r }: { r: HallRepo }) {
  const [all, setAll] = useState<Record<number, boolean>>({});
  const groups = groupByReason(r);
  const head = (
    <>
      <span className="dh-repo-name">
        <strong>{r.repo}</strong>
        <span className="muted small">
          {' '}
          ★ {stars(r.stars)} · {LANG[r.language]}
        </span>
      </span>
      <span className="dh-repo-counts small">
        <span className={`chip ${r.counts.confirmed ? 'sev breaking' : 'ok'}`}>{r.counts.confirmed} drift</span>
        <span className="chip muted">{r.counts.falsePositive} false positive{r.counts.falsePositive === 1 ? '' : 's'}</span>
        {r.counts.unclear > 0 && <span className="chip muted">{r.counts.unclear} unclear</span>}
        {r.findings.length > 0 && <span className="dh-toggle" aria-hidden="true" />}
        {r.pr && (
          <span className={`chip ${r.pr.status === 'merged' ? 'ok' : 'muted'}`}>
            {r.pr.url ? (
              <a href={r.pr.url} target="_blank" rel="noreferrer">
                {PR_LABEL[r.pr.status]}
              </a>
            ) : (
              PR_LABEL[r.pr.status]
            )}
          </span>
        )}
      </span>
    </>
  );
  const meta = (
    <p className="muted small dh-repo-meta">
      <a href={`https://github.com/${r.repo}/tree/${r.sha}`} target="_blank" rel="noreferrer">
        <code>{r.sha.slice(0, 9)}</code>
      </a>{' '}
      · {r.filesChecked} files checked{r.agentFiles.length ? ` · agent files: ${r.agentFiles.join(', ')}` : ''}
      {r.pr?.title ? ` · ${r.pr.status === 'drafted' ? 'draft' : 'PR'}: “${r.pr.title}”` : ''}
    </p>
  );
  if (!r.findings.length)
    return (
      <li className="dh-repo">
        <div className="dh-repo-sum">{head}</div>
        {meta}
      </li>
    );
  return (
    <li className="dh-repo">
      <details>
        <summary className="dh-repo-sum">{head}</summary>
        {meta}
        {groups.map((g, gi) => {
          const shown = all[gi] ? g.findings : g.findings.slice(0, FIRST);
          return (
            <div key={gi} className="dh-group">
              <p className="dh-why">
                {g.findings.length > 1 && <strong>{g.findings.length} × </strong>}
                <Ticks text={g.why} />
              </p>
              <ul className="mismatch-list">
                {shown.map((f) => (
                  <li key={f.id}>
                    <div className="mm-top">
                      <a href={f.permalink} target="_blank" rel="noreferrer">
                        <code>{f.file}</code> line {f.line}
                      </a>
                      <span>
                        <span className={`chip ${f.severity === 'error' ? 'sev breaking' : 'sev api'}`}>{f.rule}</span>
                        {f.fixAvailable && <span className="chip ok">fix verified</span>}
                        {f.shownIn === 'beta' && <span className="chip muted">info (beta) now</span>}
                        {f.shownIn === 'gone' && <span className="chip muted">not reported now</span>}
                      </span>
                    </div>
                    <div className="mm-detail">
                      <Ticks text={f.message} />
                    </div>
                  </li>
                ))}
              </ul>
              {g.findings.length > FIRST && (
                <button type="button" className="link small" onClick={() => setAll((a) => ({ ...a, [gi]: !a[gi] }))}>
                  {all[gi] ? 'Show fewer' : `Show all ${g.findings.length}`}
                </button>
              )}
            </div>
          );
        })}
      </details>
    </li>
  );
}

const CSS = `
.drift-hall h1 { margin: 6px 0 10px; }
.drift-hall h2 { margin: 34px 0 10px; }
.dh-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 8px 0 8px; }
.dh-stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow); min-width: 0; }
.dh-stat-num { font-size: 1.9em; font-weight: 750; line-height: 1.1; letter-spacing: -0.02em; color: var(--text); }
.dh-stat.drift .dh-stat-num { color: var(--breaking); }
.dh-stat.fp .dh-stat-num { color: var(--api); }
.dh-stat.good .dh-stat-num { color: var(--ok); }
.dh-note { margin: 14px 0 0; padding: 10px 14px; border-radius: var(--radius); background: var(--api-bg); color: var(--text); font-size: 0.92em; }
.dh-total td { font-weight: 600; border-top: 1px solid var(--border-strong); }
.dh-stat-label { font-weight: 600; }
.dh-stat-sub { overflow-wrap: anywhere; }
.dh-method { margin-top: 22px; padding: 4px 18px 6px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-alt); }
.dh-method h2 { margin: 12px 0 4px; font-size: 1.05em; }
.dh-method ul { margin: 6px 0 10px; padding-left: 18px; }
.dh-method li { margin: 6px 0; color: var(--text-2); }
.dh-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.dh-head h2 { margin-bottom: 6px; }
.dh-filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.dh-filters select { font: inherit; padding: 6px 10px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); }
.dh-check { display: inline-flex; gap: 6px; align-items: center; font-size: 0.92em; }
.dh-repos { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 10px; }
.dh-repo { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 10px 14px; min-width: 0; overflow-wrap: anywhere; }
.dh-repo summary { cursor: pointer; list-style: none; }
.dh-repo summary::-webkit-details-marker { display: none; }
.dh-repo-sum { display: flex; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; align-items: center; }
.dh-repo details[open] > summary { margin-bottom: 4px; }
.dh-toggle { order: 9; width: 18px; height: 18px; display: inline-grid; place-items: center; color: var(--muted); }
.dh-toggle::before { content: ''; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform 0.15s; }
.dh-repo details[open] .dh-toggle::before { transform: rotate(45deg); }
.dh-repo-name { min-width: 0; }
.dh-repo-counts { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.dh-repo-counts .chip { margin-left: 0; }
.dh-repo-counts .chip a { color: inherit; }
.dh-repo-meta { margin: 6px 0 0; }
.dh-group { margin-top: 12px; }
.dh-why { margin: 0 0 4px; font-size: 0.92em; color: var(--text-2); }
.dh-group .mismatch-list { margin: 6px 0; }
.dh-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.dh-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.dh-table th, .dh-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.dh-table tbody tr:last-child td { border-bottom: 0; }
.dh-table td:not(:first-child), .dh-table th:not(:first-child) { text-align: right; }
.dh-table td .small { font-weight: 400; }
.dh-bar { display: inline-block; vertical-align: middle; width: 56px; height: 6px; margin-left: 8px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.dh-bar > span { display: block; height: 100%; background: var(--ok); }
.dh-fp { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 8px; }
.dh-fp li { padding: 10px 12px; border: 1px solid var(--border); border-left: 3px solid var(--api); border-radius: var(--radius); background: var(--surface); overflow-wrap: anywhere; }
.dh-fp-top { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: baseline; margin-bottom: 2px; }
.dh-foot { margin-top: 28px; }
.drift-hall .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 980px) { .dh-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .dh-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .dh-stat { padding: 12px; }
  .dh-stat-num { font-size: 1.5em; }
  .dh-table th, .dh-table td { padding: 6px 8px; }
  .dh-bar { display: none; }
}
`;
