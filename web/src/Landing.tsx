import { useState, type ReactNode } from 'react';
import { PACKAGE, PRODUCT, REPO_URL, SITE_URL } from './docs/manifest';
import { CodeBlock, CopyButton, Icon } from './layout';

/**
 * The home page's static content. It renders the same in the browser and at
 * build time (scripts/prerender.ts writes it into index.html, so crawlers and
 * LLMs that don't run JavaScript read the whole page). The live parts — the
 * demo and the graph stats — come in as slots and are absent at build time.
 *
 * Every number here is from docs/FACTS.md or the Drift Hall (web/public/drift-hall.json).
 */
export function Landing({ demo, stats }: { demo?: ReactNode; stats?: ReactNode }) {
  return (
    <div className="landing">
      <Hero />
      <Proof />
      <section id="try" className="band try-band">
        <div className="wrap">
          <SectionHead eyebrow="Try it" title="Check any pull request" lede="Paste a pull request from any public Python, TypeScript or JavaScript repository. The first check indexes it in seconds." />
          <Modes />
          {stats}
          {demo ?? <StaticDemo />}
        </div>
      </section>
      <Who />
      <Why />
      <HowItWorks />
      <Integrations />
      <Compare />
      <Faq />
      <FinalCta />
    </div>
  );
}

function SectionHead({ eyebrow, title, lede, center }: { eyebrow: string; title: ReactNode; lede?: ReactNode; center?: boolean }) {
  return (
    <div className={`section-head${center ? ' center' : ''}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {lede && <p className="lede">{lede}</p>}
    </div>
  );
}

const PR = 'https://github.com/FalkorDB/falkordb-py/pull/262';
const INSTALL_CMD = `npx -y ${PACKAGE} check ${PR}`;

function Hero() {
  return (
    <section className="hero-band">
      <div className="hero-bg" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <h1>
            Docs that stay <span className="grad">true to your code.</span>
          </h1>
          <p className="lede">
            {PRODUCT} follows every pull request through a graph of your code and docs to the paragraphs it makes false, runs the examples to prove it, and
            writes the fix.
          </p>
          <p className="hero-agents">
            It also checks the files AI coding agents read: a stale command, link or env var in <code>AGENTS.md</code>, <code>CLAUDE.md</code> or your Cursor and
            Copilot rules is flagged like any other doc. <a href="#/docs/lint">How lint works</a>
          </p>
          <div className="cta-row">
            <a className="btn btn-primary btn-lg" href="#/install">
              <Icon name="github" /> Add to GitHub
            </a>
            <a className="btn btn-ghost btn-lg" href="#/try">
              <Icon name="play" /> Check a pull request
            </a>
          </div>
          <div className="install">
            <span className="prompt">$</span>
            <code>{INSTALL_CMD}</code>
            <CopyButton text={INSTALL_CMD} label="Copy command" />
          </div>
          <ul className="hero-facts" aria-label="At a glance">
            <li>
              <Icon name="check" size={14} /> Open source, MIT
            </li>
            <li>
              <Icon name="check" size={14} /> No model key needed
            </li>
            <li>
              <Icon name="check" size={14} /> Python · TypeScript · JavaScript · Go
            </li>
          </ul>
        </div>
        <Trace />
      </div>
    </section>
  );
}

/** The first-screen proof: falkordb-py#262, drawn as the graph and the runs saw it. */
function Trace() {
  return (
    <figure className="trace" aria-label="Worked example: falkordb-py pull request 262">
      <figcaption className="trace-head">
        <span className="trace-pr">
          <Icon name="pr" size={15} /> FalkorDB/falkordb-py#262
        </span>
        <span className="trace-title">fix: only forward accepted kwargs from Is_Cluster</span>
      </figcaption>
      <ol className="flow">
        <li className="node is-changed">
          <span className="node-kind">changed</span>
          <code>Is_Cluster</code>
        </li>
        <li className="node">
          <span className="node-kind">called by</span>
          <code>FalkorDB.__init__</code>
        </li>
        <li className="node is-doc">
          <span className="node-kind">used in</span>
          <code>README · Asynchronous Example</code>
        </li>
      </ol>
      <div className="runs">
        <div className="run-row fail">
          <span className="run-side">before</span>
          <span className="run-status">fails</span>
          <code>TypeError: unexpected keyword argument 'himport_registry'</code>
        </div>
        <div className="run-row pass">
          <span className="run-side">after</span>
          <span className="run-status">passes</span>
          <code>exit 0</code>
        </div>
      </div>
      <p className="trace-verdict">
        <Icon name="check" size={15} />
        <span>
          No doc names <code>Is_Cluster</code>, so a search finds nothing. The call graph finds the README.
        </span>
      </p>
    </figure>
  );
}

function Proof() {
  const tiles: { value: string; label: ReactNode; foot: string; href: string }[] = [
    { value: '33 / 34', label: <>findings confirmed real on 18 repositories {PRODUCT} had never seen</>, foot: 'Drift Hall · held-out', href: '#/drift' },
    { value: '41 of 43', label: <>doc sections one pull request falsified were in other repositories</>, foot: 'falkordb-py#276', href: '#/docs/facts' },
    { value: '0 / 47', label: <>of the sections the graph reaches would be found by a grep for the changed names</>, foot: 'falkordb-py #262 · #267 · #276', href: '#/docs/facts' },
    { value: '~1 ms', label: <>to answer "which paragraphs can this change make false?" on FalkorDB</>, foot: 'impact query', href: '#/model' },
  ];
  return (
    <section className="band results-band" aria-labelledby="results-title">
      <div className="wrap">
        <div className="results-head">
          <h2 id="results-title">Measured, not promised</h2>
          <a href="#/drift">
            Every false positive is counted in the open on the Drift Hall <Icon name="arrow" size={14} />
          </a>
        </div>
        <div className="tiles">
          {tiles.map((t) => (
            <a key={t.value} className="tile" href={t.href}>
              <div className="tile-value">{t.value}</div>
              <div className="tile-label">{t.label}</div>
              <div className="tile-foot">{t.foot}</div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Modes() {
  return (
    <div className="modes-explainer">
      <div>
        <Icon name="graph" />
        <div>
          <strong>Graph mode</strong>
          <p>Impact, clearance, ranking and example runs in a fixed order. No model, no key, deterministic.</p>
        </div>
      </div>
      <div>
        <Icon name="model" />
        <div>
          <strong>Agent mode</strong>
          <p>A model reads each affected section and writes a verdict or an edit for every one.</p>
        </div>
      </div>
    </div>
  );
}

/** Shown where the live demo goes when the page is read without JavaScript. */
function StaticDemo() {
  const prs = [
    ['FalkorDB/falkordb-py#262', 'fix: only forward accepted kwargs from Is_Cluster to redis.Redis', PR],
    ['FalkorDB/falkordb-py#267', 'test: assert the client parses execution plans, and fix a plan parser bug', 'https://github.com/FalkorDB/falkordb-py/pull/267'],
    ['FalkorDB/falkordb-py#276', 'fix(asyncio): prevent connection pool kwargs mutation and await schema refresh', 'https://github.com/FalkorDB/falkordb-py/pull/276'],
  ];
  return (
    <div className="static-demo">
      <p className="muted">The interactive demo needs JavaScript. These are the pull requests it opens with:</p>
      <ul>
        {prs.map(([ref, title, url]) => (
          <li key={ref}>
            <a href={url}>{ref}</a> — {title}
          </li>
        ))}
      </ul>
    </div>
  );
}

const AUDIENCES: { icon: string; who: string; body: ReactNode; proof: ReactNode; via: [string, string] }[] = [
  {
    icon: 'repos',
    who: 'Library and SDK maintainers',
    body: <>Your client, the SDK built on it and the docs site are three repositories. A change in the first surfaces the pages in the other two.</>,
    proof: <>41 of 43 sections falkordb-py#276 reached were in other repositories.</>,
    via: ['GitHub App', '#/docs/github-app'],
  },
  {
    icon: 'bot',
    who: 'Teams coding with AI agents',
    body: (
      <>
        Claude Code, Cursor and Copilot read <code>AGENTS.md</code> and <code>CLAUDE.md</code>. {PRODUCT} keeps those files true, and answers your agent over
        MCP before it changes a function.
      </>
    ),
    proof: <>docs_for_symbol, check_changes and the docs patch, in the same session as the code.</>,
    via: ['MCP server', '#/docs/mcp'],
  },
  {
    icon: 'people',
    who: 'DevRel and docs teams',
    body: <>Know what a release falsified, most-read page first, and ship one patch with the evidence behind every edit.</>,
    proof: <>An audit lists the public API no page covers, and every example that no longer fits the code.</>,
    via: ['Audit a repository', '#/audit'],
  },
  {
    icon: 'pr',
    who: 'Open-source maintainers',
    body: <>A docs check on every pull request: the sections it can make false, the path for each, and a button that applies the fix.</>,
    proof: <>Beta rules only inform. Nothing fails a check until the Drift Hall shows it at 80% precision or better.</>,
    via: ['GitHub Action', '#/docs/github-action'],
  },
];

function Who() {
  return (
    <section className="band" id="use-cases">
      <div className="wrap">
        <SectionHead eyebrow="Who it's for" title="Anyone whose docs live apart from their code" />
        <div className="audiences">
          {AUDIENCES.map((a) => (
            <article key={a.who} className="audience">
              <span className="card-icon">
                <Icon name={a.icon} />
              </span>
              <h3>{a.who}</h3>
              <p>{a.body}</p>
              <p className="proof">{a.proof}</p>
              <a className="audience-link" href={a.via[1]}>
                {a.via[0]} <Icon name="arrow" size={14} />
              </a>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Why() {
  return (
    <section className="band alt" id="why">
      <div className="wrap">
        <SectionHead eyebrow="Why it works" title="Three things a search can't do" />
        <div className="reasons">
          <article className="reason">
            <ReachGraphic />
            <h3>It follows calls, not names</h3>
            <p>Up to three call hops from the changed function, across repositories, to the docs that use it. Grep stops at the name.</p>
          </article>
          <article className="reason">
            <RunGraphic />
            <h3>It runs the example, before and after</h3>
            <p>Each affected example runs at both commits in a sandbox. "This PR broke it" is a test result, not a guess.</p>
          </article>
          <article className="reason">
            <ReceiptGraphic />
            <h3>Every finding carries its receipt</h3>
            <p>The path from the change to the paragraph is shown on every hit. No path, no edit: the tool refuses.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

/** A changed function reaching a doc through two callers, while a search for its name misses it. */
function ReachGraphic() {
  return (
    <svg className="reason-art" viewBox="0 0 320 150" role="img" aria-label="A changed function reaches a README through two callers; grep finds nothing">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5 0 10z" className="art-edge-fill" />
        </marker>
      </defs>
      <g className="art-edges">
        <path d="M70 78 L122 54" markerEnd="url(#arr)" />
        <path d="M70 78 L122 104" markerEnd="url(#arr)" />
        <path d="M178 54 L232 78" markerEnd="url(#arr)" />
        <path d="M178 104 L232 78" markerEnd="url(#arr)" />
      </g>
      <g className="art-node changed">
        <circle cx="46" cy="78" r="22" />
        <text x="46" y="82">Δ fn</text>
      </g>
      <g className="art-node">
        <circle cx="150" cy="48" r="20" />
        <text x="150" y="52">caller</text>
      </g>
      <g className="art-node">
        <circle cx="150" cy="110" r="20" />
        <text x="150" y="114">caller</text>
      </g>
      <g className="art-node doc">
        <rect x="236" y="56" width="70" height="44" rx="9" />
        <text x="271" y="74">README</text>
        <text x="271" y="90" className="art-sub">§ example</text>
      </g>
      <g className="art-grep">
        <text x="46" y="128">grep "fn"</text>
        <path d="M14 123 L78 123" />
        <text x="46" y="143" className="art-sub">0 results</text>
      </g>
    </svg>
  );
}

/** Two example runs, one failing before the change and one passing after it. */
function RunGraphic() {
  return (
    <svg className="reason-art" viewBox="0 0 320 150" role="img" aria-label="The example fails before the pull request and passes after it">
      <g className="art-term">
        <rect x="12" y="14" width="296" height="122" rx="12" />
        <circle cx="30" cy="30" r="4" />
        <circle cx="44" cy="30" r="4" />
        <circle cx="58" cy="30" r="4" />
      </g>
      <g className="art-line">
        <text x="28" y="60">
          <tspan className="art-prompt">$</tspan> run README#async <tspan className="art-dim">@ base</tspan>
        </text>
        <text x="28" y="80" className="art-fail">
          ✕ TypeError: unexpected keyword argument
        </text>
        <text x="28" y="106">
          <tspan className="art-prompt">$</tspan> run README#async <tspan className="art-dim">@ pr</tspan>
        </text>
        <text x="28" y="126" className="art-pass">
          ✓ exit 0
        </text>
      </g>
    </svg>
  );
}

/** A finding with the evidence path attached, and the refusal when there is none. */
function ReceiptGraphic() {
  return (
    <svg className="reason-art" viewBox="0 0 320 150" role="img" aria-label="A finding with its evidence path; without a path, no edit">
      <g className="art-card">
        <rect x="14" y="16" width="292" height="74" rx="12" />
        <text x="30" y="40" className="art-strong">
          README · Asynchronous Example
        </text>
        <text x="30" y="60" className="art-sub">
          stale · the kwargs it passes are no longer accepted
        </text>
        <g className="art-path">
          <rect x="30" y="68" width="258" height="14" rx="7" />
          <text x="159" y="78.5">Is_Cluster → FalkorDB.__init__ → README</text>
        </g>
      </g>
      <g className="art-refuse">
        <rect x="14" y="102" width="292" height="34" rx="10" />
        <text x="30" y="123">
          <tspan className="art-fail">✕</tspan> no graph path to this paragraph → no edit proposed
        </text>
      </g>
    </svg>
  );
}

function HowItWorks() {
  const steps: { icon: string; title: string; body: ReactNode }[] = [
    { icon: 'layers', title: 'Index', body: <>Code, docs and examples from every repository go into one FalkorDB graph, with the calls between them.</> },
    { icon: 'path', title: 'Trace', body: <>From each changed function, walk the callers to the sections that use them. The rest is cleared, with proof.</> },
    { icon: 'play', title: 'Prove', body: <>Run each affected example at the commit before the PR and at the PR, in a sandbox.</> },
    { icon: 'doc', title: 'Fix', body: <>Every section gets a verdict, and a <code>git apply</code>-able patch with the evidence. Decisions are remembered for the next PR.</> },
  ];
  return (
    <section className="band" id="how-it-works">
      <div className="wrap">
        <SectionHead eyebrow="How it works" title="From a pull request to a proven docs fix" />
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.title} className="step">
              <div className="step-num">
                <span className="card-icon">
                  <Icon name={s.icon} />
                </span>
                <span>{String(i + 1).padStart(2, '0')}</span>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="impact-query">
          <div className="impact-copy">
            <h3>The question is a graph question</h3>
            <p>"Which paragraphs, in which repositories, can this change make false?" is reachability over call edges. One Cypher pattern answers it.</p>
            <a href="#/model">
              The graph model and every query <Icon name="arrow" size={14} />
            </a>
          </div>
          <CodeBlock
            lang="cypher"
            title="impact (excerpt)"
            code={`MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
RETURN d.id, length(p) AS hops,
       [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence`}
          />
        </div>
      </div>
    </section>
  );
}

const INTEGRATIONS: { id: string; icon: string; label: string; title: string; body: ReactNode; lang: string; file?: string; code: string; doc: string }[] = [
  {
    id: 'app',
    icon: 'github',
    label: 'GitHub App',
    title: 'Install once, every pull request is checked',
    body: <>No workflow file and no secrets. Each PR gets a check with annotations, suggestions, and an Apply fixes button.</>,
    lang: 'text',
    file: 'github.com/apps/staleproof',
    code: `1. Install the app on your repositories
2. Open a pull request
3. Read the "Staleproof" check: the docs it can make false,
   the path for each, and the fix as a suggestion`,
    doc: '#/docs/github-app',
  },
  {
    id: 'action',
    icon: 'pr',
    label: 'GitHub Action',
    title: 'One step, no inputs',
    body: <>The job starts its own FalkorDB, indexes the repository, runs the affected examples before and after, and posts one comment.</>,
    lang: 'yaml',
    file: '.github/workflows/staleproof.yml',
    code: `on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1`,
    doc: '#/docs/github-action',
  },
  {
    id: 'cli',
    icon: 'terminal',
    label: 'CLI',
    title: 'From nothing to a checked pull request',
    body: <>No install and no Docker: the first check starts FalkorDB locally and indexes the repository. <code>lint</code> needs no graph at all.</>,
    lang: 'bash',
    code: `$ npx -y ${PACKAGE} lint            # paths, links, commands, env, symbols
$ npx -y ${PACKAGE} check ${PR}
$ npx -y ${PACKAGE} fix             # applies only verified fixes`,
    doc: '#/docs/cli',
  },
  {
    id: 'mcp',
    icon: 'bot',
    label: 'MCP',
    title: 'Ask Claude Code or Cursor before you change a function',
    body: <>The hosted server needs nothing installed and indexes any public repository on first use. Every result lists the Cypher it ran.</>,
    lang: 'bash',
    code: `$ claude mcp add --transport http staleproof ${SITE_URL}/api/mcp

> Which docs depend on Is_Cluster? Which examples do my edits break?`,
    doc: '#/docs/mcp',
  },
  {
    id: 'editor',
    icon: 'box',
    label: 'VS Code',
    title: 'Diagnostics as you type',
    body: <>Findings from unsaved text, fixes as code actions, hover and go-to-definition from a doc to the code it names. Cursor, Windsurf, Zed, Neovim and JetBrains too.</>,
    lang: 'bash',
    code: `$ code --install-extension staleproof.staleproof`,
    doc: '#/docs/editors',
  },
  {
    id: 'api',
    icon: 'api',
    label: 'API',
    title: 'Stream a check over server-sent events',
    body: <><code>serve</code> runs this web app and its JSON API; the package also exports the indexer, the tools and both check modes as a library.</>,
    lang: 'bash',
    code: `$ npx -y ${PACKAGE} serve --port 8080
$ curl -N localhost:8080/api/check \\
    -H 'content-type: application/json' \\
    -d '{"pr_url": "${PR}", "mode": "graph"}'`,
    doc: '#/docs/http-api',
  },
];

function Integrations() {
  const [active, setActive] = useState(INTEGRATIONS[0]!.id);
  return (
    <section className="band alt" id="integrations">
      <div className="wrap">
        <SectionHead eyebrow="Install" title="Six ways in, one npm package" lede="Pick the one that matches where your docs break." />
        <div className="tabs" role="tablist" aria-label="Integrations">
          {INTEGRATIONS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={active === t.id}
              aria-controls={`panel-${t.id}`}
              className={active === t.id ? 'on' : ''}
              onClick={() => setActive(t.id)}
            >
              <Icon name={t.icon} size={16} /> {t.label}
            </button>
          ))}
        </div>
        {INTEGRATIONS.map((t) => (
          <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={active !== t.id} className="tabpanel">
            <div className="tabpanel-copy">
              <h3>{t.title}</h3>
              <p>{t.body}</p>
              <a className="btn btn-ghost btn-sm" href={t.doc}>
                {t.label} guide <Icon name="arrow" size={14} />
              </a>
            </div>
            <CodeBlock lang={t.lang} title={t.file ?? t.lang} code={t.code} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Compare() {
  const rows: [string, string, string, string][] = [
    ['Finds docs that reach the change through other functions', 'Only the names you search for', 'Similar text, not reachability', 'Up to 3 call hops, any repository'],
    ['Proves a change broke an example', 'No', 'No', 'Runs it before and after'],
    ['Says why a paragraph is flagged', 'The matching line', 'A similarity score', 'The evidence path'],
    ['Noise on 4 checked pull requests', '227 unrelated matches', '—', 'Only sections the change reaches'],
  ];
  return (
    <section className="band" id="compare">
      <div className="wrap">
        <SectionHead eyebrow="Compared" title="Why not grep, or a vector store?" />
        <div className="table-wrap">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">grep / code search</th>
                <th scope="col">Vector search</th>
                <th scope="col" className="us">
                  {PRODUCT}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([q, a, b, c]) => (
                <tr key={q}>
                  <th scope="row">{q}</th>
                  <td>{a}</td>
                  <td>{b}</td>
                  <td className="us">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export const FAQ: [string, ReactNode][] = [
  [
    'Do I need an LLM API key?',
    <>No. Graph mode runs impact, clearance, ranking and example runs with no model. Agent mode adds a model that reads each section and writes the verdicts and edits; it needs <code>ANTHROPIC_API_KEY</code> or any Anthropic-compatible endpoint.</>,
  ],
  [
    'Which languages does it understand?',
    <>Code: Python, TypeScript, JavaScript and Go, across repositories. Docs: Markdown, MDX and reStructuredText. Python examples are run before and after a pull request; JavaScript and TypeScript examples are checked statically.</>,
  ],
  [
    'Do I need a pull request?',
    <>No. <a href="#/audit">Audit</a> any public repository to see which examples no longer fit the code today, run <code>lint</code> in a pre-commit hook, or ask over MCP which docs depend on a function before you change it.</>,
  ],
  [
    'Does my code leave my machine?',
    <>With the CLI, the Action or the editor extension, indexing, the graph and example runs stay where you run them; private repositories work with a token. Graph mode sends nothing to a model. The hosted site and MCP server index public repositories only.</>,
  ],
  [
    'Will it open pull requests on its own?',
    <>No. It proposes edits as suggestions, a <code>git apply</code>-able patch, or one fix PR you opt into. Nothing is pushed without you.</>,
  ],
  [
    'What does it cost?',
    <>Nothing: it is MIT licensed. You run FalkorDB (locally, in Docker, or on FalkorDB Cloud's free tier) and pay your model provider only in agent mode.</>,
  ],
];

function Faq() {
  return (
    <section className="band alt" id="faq">
      <div className="wrap narrow">
        <SectionHead eyebrow="FAQ" title="Questions developers ask first" center />
        <div className="faq">
          {FAQ.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
        <p className="center muted">
          More in <a href="#/docs/troubleshooting">Troubleshooting and FAQ</a>.
        </p>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="band cta-band">
      <div className="wrap cta-inner">
        <h2>Check your next pull request before your readers do.</h2>
        <p>Install once. Every pull request after that gets its docs impact, with proof.</p>
        <div className="cta-row center">
          <a className="btn btn-primary btn-lg" href="#/install">
            <Icon name="github" /> Add to GitHub
          </a>
          <a className="btn btn-ghost btn-lg" href={REPO_URL} target="_blank" rel="noreferrer">
            <Icon name="github" /> Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
