# False positives

A wrong finding is a bug in Staleproof, never in your docs. Every finding can be reported in one click; each
report becomes a regression fixture that every release runs, so the same false positive cannot come back; and a
rule that has not earned trust yet reports at info, where it can never fail a check or lower a score.

## The promise

- **Report it in one click.** Wherever findings are listed, a "False positive?" link opens a GitHub issue on
  [rajkaria/staleproof](https://github.com/rajkaria/staleproof/issues/new?template=false-positive.yml) with the
  rule, the repository and commit, the file and line, the message, the flagged line and the Staleproof version
  already filled in. You add one sentence: why it is not wrong.
- **It never comes back.** The report becomes a fixture in `test/fixtures/fp/`: the page and only the files the
  finding depends on, and an `expected.json` that says "no finding `<rule>` at `<file>:<line>`". The test suite
  lints every fixture, and a release cannot ship while one of those findings comes back.
- **Trust is earned.** A rule is `stable` only when its findings have been hand-checked on real repositories
  it was never tuned on and they were mostly right. Stable rules still make mistakes: each one reported becomes a
  fixture. Until a rule earns it, it is `beta`: still shown, in its own group, but it cannot fail your CI or
  lower your docs score.

## Report a wrong finding

| Where | What you get |
|---|---|
| `staleproof lint` (text) | One line at the end of a report with findings: the form's address. Never a link per finding, and nothing at all when there is nothing to report. |
| `staleproof lint --format markdown`, the pull request comment, the GitHub App's check summary | `False positive?` after each finding, prefilled. |
| `--format sarif` (GitHub code scanning) | The rule's help says how to report; each result carries its prefilled link in `properties.falsePositiveUrl`. |
| `--format json` | `tool.falsePositives` is the form; build per-finding links with `falsePositiveUrl()` from `src/format/fp-link.ts`. |
| The editor (`staleproof lsp`, VS Code, Cursor, Zed) | A quick fix on every diagnostic: **Staleproof: report a false positive**, which opens the prefilled form. |
| staleproof.dev (audit, pull request check) | `False positive?` on each finding row. |

The form asks for the rule, `owner/name@sha` (or "local working tree"), `file:line`, what Staleproof said, the
line it flagged, why it is not wrong, the version, and whether you can share the repository publicly.

### Private repositories

The issue is public, so a link made for a private repository carries only the rule, the shape of the message
(names, paths and lists replaced by `…`) and the version: no path, no file text, no repository name. Staleproof
knows a repository is private in the GitHub App (its private workspaces) and in the GitHub Action (the event says
so). The editor and a local `staleproof lint` cannot tell; the form reminds you to leave out what you cannot
share, and you see every field before you submit. Without a public repository we cannot copy files into a
fixture, so a private report is reproduced by hand from the rule and the message.

## What happens next

1. **Reproduce.** `scripts/fp-to-fixture.ts --issue <number>` reads the issue, clones the public repository at the
   commit (shallow), and checks that the finding is there.
2. **Fixture.** It copies the page and the files the finding depends on (manifests, the link's target, the code an
   example calls, the files that name an env var) into `test/fixtures/fp/<rule>-<slug>/repo/`, drops every code
   file the finding does not need, and lints the fixture alone to confirm it shows the same finding. While the
   rule is not fixed the fixture is marked `pending`: the suite expects the finding back.
3. **Fix.** The rule is fixed. `test/fp-corpus.test.ts` then fails on the pending fixture ("no longer
   reproduces: remove `pending`"), the marker goes, and the fixture is a live guard.
4. **Release.** The fix ships with its guard; the issue gets the version that fixed it. From then on every
   change to Staleproof runs the fixture.

A rule whose report cannot be fixed in the release that receives it becomes `beta` for that release.

Maintainers can also make a fixture from explicit fields:

```bash
npx tsx scripts/fp-to-fixture.ts --repo pmndrs/zustand --sha <40-hex sha> --rule env-unused \
  --file CONTRIBUTING.md --line 82 --slug other-checkout --why "pmndrs/docs reads these, not zustand"
```

`--from <checkout>` reuses a clone at that commit, `--include <path>` adds a file the selection missed, `--code
<folder>` offers a large package's code (then trimmed to what the finding needs), `--max-severity info` accepts the
finding back as an info note (a link that works on the docs site but not on GitHub), and `--guard` keeps an
already fixed false positive fixed.

## How maturity works

Every rule in [Lint rules](rules.md) is `stable` or `beta`.

| | stable | beta |
|---|---|---|
| Severity | its own (`error`, `warning`, `info`) | `info`, marked `lowerConfidence` |
| Listed | with the other findings | last, under "Lower confidence (beta rules)" |
| `staleproof lint --fail-on`, `staleproof check --fail-on-predicted`, the Action's `fail-on`, the App's `fail-on`, the coding-agent hooks | can fail | never fails, at any level |
| Docs audit score | deducted | never deducted |
| Fingerprint | unchanged | unchanged |

A beta finding is still worth a look, but check it before you act on it: on repositories they were not tuned on,
some beta rules are wrong more often than right. Opt a rule in when you have checked it on your repository, in
`.staleproof.toml` (or `[tool.staleproof.rules]` in `pyproject.toml`):

```toml
[rules]
"anchor-missing" = "warning"
```

Any level opts it in: its findings then count like every other rule's at that level (the docs audit counts a beta
example check's lines at `warning` or `error`). `"off"` still turns a rule off.

The beta rules today, and why (the counts are in [Lint rules](rules.md), from `src/lint/maturity.ts`):

- **`path-missing`**: right on the repositories it was tuned on, but a held-out check on fresh repositories found
  no true finding: a removal recorded without a pull request reference, another repository's paths, and plans
  that name files not written yet.
- **`line-out-of-range`**: it shares `path-missing`'s guards, and no true finding has been seen on any
  repository checked so far.
- **`anchor-missing`**: docs sites that build heading ids their own way: MkDocs `attr_list` ids (`{ #id }`),
  hf doc-builder ids and slugs, generated API anchors (`[[autodoc]]`, `:::`). A heading found under another
  slugger is reported as an info note with no fix. The zod causes (a code block that closes an HTML comment on its
  fence line, links inside MDX comments) are fixed in 0.8.0.
- **`cli-flag-unknown`**: the CLI model does not follow every way a CLI is put together yet: commander
  subcommands defined in other modules and mounted with `addCommand`, a launcher that forwards its arguments to
  other CLIs, two CLIs with one name.
- **`symbol-missing`**: few true findings on real repositories so far; the false ones were in release notes and
  proposals, which name what is gone on purpose.
- **`example-unknown-keyword`**: the receiver of a call is not always typed right (`with X() as y`, `await`),
  and pages of history (a `docs/v2` folder) still get judged. An overloaded call is judged only when every
  overload agrees.
- **`example-too-many-arguments`**: still more false than true findings on fresh repositories. A function the
  page defines itself is the reader's code and is no longer judged (pmndrs/jotai's tutorial that rebuilds `atom`).
- **`example-missing-argument`**: overloads that disagree, an arity that comes from a declared function type
  (`export const f: F = (a, b) => …`), functions the page defines (vitejs/vite's preset shadowed by an import).
- **`example-missing-import`**: JavaScript and TypeScript exports are not modelled completely yet: `exports` maps
  and subpaths, `export *` chains, CommonJS and `export =` typings, unbuilt `dist/` entries, and types only a
  hand-written `index.d.ts` declares.
- **`example-missing-attribute`**: an exported instance read as the module of the same name (trpc's
  `initTRPC`, TanStack/query's managers), and a method the class defines (vitejs/vite's `ModuleRunner.import`).
  Alternative tabs with no import of their own (zod's "Zod Mini" blocks) are no longer judged against the default
  tab's import.

A stable rule can still get a report. Its fixture is then listed as open against the rule in
`src/lint/maturity.ts`, and a release either ships the fix or ships the rule as beta. What a precision run finds and a release does not fix
yet is written in the rule's evidence in [Lint rules](rules.md).

The evidence for every rule, stable ones included, is in `src/lint/maturity.ts` and printed in
[Lint rules](rules.md). A rule moves to stable when its fixtures pass and a precision run on fresh repositories,
every finding hand-checked, finds it mostly right.
