# Drift Hall

The Drift Hall is Staleproof's public precision record: `staleproof lint` run on about sixty popular open-source repositories that Staleproof's own tests were never tuned on, every error and warning checked by hand at a pinned commit, the confirmed drift listed with a link to the line, and every false positive counted by rule and by cause instead of hidden. This page explains how the corpus was chosen, how each finding was judged, how to read the numbers on [staleproof.dev/#/drift](https://staleproof.dev/#/drift), how the fixes are offered to maintainers, and how to reproduce the run.

## Why a hall

A checker that is wrong costs more than one that misses: one false alarm teaches a team to ignore the next real one. Precision measured on repositories a tool's authors picked and tuned against says little, so the hall measures it on repositories Staleproof did not choose, and shows its own mistakes next to its findings.

## The corpus

About sixty repositories (roughly thirty Python, twenty-five TypeScript and JavaScript, five Go), chosen for being popular, active and documented, with a preference for projects that keep AI agent files (`AGENTS.md`, `CLAUDE.md`, Cursor rules), since those are read on every agent session. None of them is one of the repositories in Staleproof's earlier precision runs. Each one is pinned to the head of its default branch on the day of the run, with its star count at that time; [scripts/drift-hall/repos.ts](../scripts/drift-hall/repos.ts) holds the list.

## The run

[scripts/drift-hall/run.ts](../scripts/drift-hall/run.ts) fetches each repository at its recorded commit (shallow, blob-less, with enough history for `lint` to say where a deleted or renamed path went) and runs the graph-free check:

```bash
npx -y staleproof lint <checkout> --format json --fail-on never --repo <owner/name>
```

That covers paths, links, anchors, commands, the repository's own CLI and flags, environment variables, symbols, docstrings and the static checks of docs examples ([Lint](lint.md) has every rule). No graph, no network, no account; nothing is sent to the repositories.

## How each finding was judged

Every error- and warning-level finding was read against the repository at the pinned commit: the doc line, and the thing it names (the file, the heading, the script, the signature, the export). Info-level findings were sampled. Each gets one verdict and a one-line reason:

| Verdict | Meaning |
|---|---|
| confirmed | A reader following the docs where they are read hits the problem: the link 404s, the anchor does not land, the example raises, the path or command does not exist, the docstring names a parameter the function does not have |
| false-positive | It works where it is read, or the text is not a claim about this repository |
| unclear | The repository alone cannot settle it (for example, whether a docs framework falls back to English for an untranslated page) |

The bar is the project's own docs site, not GitHub's rendering: a link that works on the site through its own heading slugger, site-root paths, redirects, generated API pages or included snippets is a **false positive of Staleproof**, not drift. Repeated findings with one cause (a generator writing a whole page of links the same wrong way) were checked one by one with a script that tests the cause for each finding, and read by eye in samples; anything the script could not settle was read individually.

## Reading the numbers

The page leads with the **default view**: of the findings the current version reports at warning or error (what a
check fails on, and what costs audit score), how many were drift. Beta rules report at info only; their precision is
shown apart, and so is every warning and error of the first run ("before", 0.6.1), from before the guards. Default and
beta follow the current rule maturity table: `path-missing` and `line-out-of-range` moved to beta after the held-out
check below found them wrong on new repositories, so their findings count as beta even where the re-run, linted before
the move, reported them at warning or error (the JSON's `note` says so; nothing is re-linted for it).

**The guards were written against these same repositories.** Each false-positive cause found here became a guard (a
fixture from the hall's case, with the true finding next to it), so the hall after the guards measures how well they fit
this corpus, not how Staleproof does on a repository it has never seen. That is what the held-out check is for.


- **Confirmed drift** counts findings, not causes: one generated page with 400 wrong links is 400 findings and one fix. The page groups each repository's findings by reason, so causes are visible.
- **Precision** for a rule is confirmed out of confirmed plus false positives; unclear verdicts are left out of it.
- **False positives** are grouped by cause (a site slugger Staleproof did not know, a snippet included into another page, a footnote read as a link, an example that calls the reader's own code). Each cause is a bug in a rule and goes to the rule's owner; when a release fixes one, the hall says so and counts its findings as found and fixed.
- A finding in a file that is a link to another (`CLAUDE.md` pointing at `AGENTS.md`), or repeated in a docs site's frozen copy of the page for an older release (`docs/v1.15.28/`, `versioned_docs/version-2.30/`), is counted once, under the current page or else the newest copy. Those copies are judged on their merits: an example that was already broken when its release shipped is drift for that release's readers.

## The held-out check

Eighteen more popular repositories (Python, TypeScript and JavaScript, Go), in none of the hall, the earlier precision
runs or the rule-maturity sweep, were pinned and linted only after the guards were written, and every warning and error
was hand-checked the same way ([scripts/drift-hall/heldout.ts](../scripts/drift-hall/heldout.ts)). Its precision, by
rule and with the counts (the sample is small), is the number to quote; its false positives go back into the same loop.
On it, `path-missing` was wrong 12 times out of 12 (removal records, another repository's paths, plans), which is why it
is beta in 0.8.0.

## Fixes offered to maintainers

For each repository with confirmed drift, one small docs pull request is drafted: at most about five fixes, each with a permalink to the line at the checked commit and the evidence (what the code or the target actually is), described as docs drift, ending with "Found with Staleproof". Fixes come from `staleproof fix` where Staleproof had a verified fix that was also right on review, otherwise by hand. Nothing is opened automatically: each pull request is reviewed and opened by a person, and the hall shows it as drafted, open or merged.

## The data

[staleproof.dev/drift-hall.json](https://staleproof.dev/drift-hall.json) is the page's data, built by [scripts/drift-hall/build.ts](../scripts/drift-hall/build.ts):

| Field | Holds |
|---|---|
| `generatedAt`, `staleproofVersion` | When it was built, and the Staleproof version that linted |
| `corpus` | When the commits were resolved, how many repositories, by language |
| `totals` | Repositories checked and with drift, files checked, findings judged, confirmed, false positives, unclear, infos sampled, false positives since fixed, pull requests drafted, open and merged |
| `repos[]` | `repo`, `sha`, `stars`, `language`, `agentFiles`, `filesChecked`, `counts` (by verdict), `findings[]` (confirmed only: `rule`, `severity`, `file`, `line`, `message`, `fixAvailable`, `permalink` at the sha, `why`), `reasons`, `excluded` (short fingerprints of the false-positive and unclear findings) and `pr` (`status`: `drafted`, `opened` or `merged`, `url`, `title`) |
| `precision` | The default view of the current version (`version`, `byRule`, `total`), its `beta` view (info only), `before` (every warning and error of the first run, which the repositories' counts are), `notRerun` and the note above |
| `heldOut` | The held-out repositories (pinned sha, counts, confirmed findings with permalinks, excluded fingerprints), `byRule` and `total` |
| `falsePositiveClasses[]` | Each cause: title, count, rules, an example, `open` or `fixed` (with the version) |

Only confirmed findings are listed as findings; a test checks that no false-positive or unclear verdict appears among them.

## Reproduce it

```bash
npx tsx scripts/drift-hall/resolve.ts            # record each repository's commit and stars (gh CLI, read-only)
npx tsx scripts/drift-hall/run.ts --clones /tmp/drift-hall --jobs 3
npx tsx scripts/drift-hall/verdicts.ts           # compile the hand checks, list what is still unjudged
npx tsx scripts/drift-hall/build.ts              # write web/public/drift-hall.json

# a newer Staleproof on the same commits, and the held-out set
npx tsx scripts/drift-hall/run.ts --clones /tmp/drift-hall --no-fixes --raw /tmp/drift-next
npx tsx scripts/drift-hall/compare.ts /tmp/drift-next           # false positives gone, confirmed lost, new findings
npx tsx scripts/drift-hall/run.ts --clones /tmp/held-out --no-fixes --held-out
npx tsx scripts/drift-hall/verdicts.ts --held-out               # list what is left to judge
npx tsx scripts/drift-hall/build.ts --next /tmp/drift-next --next-version 0.8.0
```

The hand checks themselves are judgments, kept with their one-line reasons; re-running the lint at the same commits gives the same findings for the same Staleproof version.

## Limits

- One commit per repository, one day. Docs move; the permalinks keep the evidence at the commit that was checked.
- Very large documentation trees can exceed lint's default memory or time on a shared machine; a repository that could not be linted is shown as not checked, never as clean.
- Translations are judged on their merits when Staleproof reports them, though lint is meant to skip translated pages; links from a translation to a page that exists only in English stay unclear unless the docs framework's fallback is known.
- The hall measures precision, not recall: drift Staleproof does not report is not counted.

## Related

- [Lint docs and agent files](lint.md): every rule, and how each one avoids false positives.
- [Fix stale docs](fix.md): the verified fixes the drafts start from.
- [Docs audit](audit.md): the same checks for one repository, with a health score.
