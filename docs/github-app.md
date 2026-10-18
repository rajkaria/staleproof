# GitHub App

The Staleproof GitHub App checks every pull request without a workflow file: install it on a repository, public or private, and each pull request gets a **Staleproof** check run with the docs references it makes wrong (as annotations on the lines), the doc sections its code changes reach and the examples predicted to break, plus a comment when there is something to say and one-click suggestions for the fixes Staleproof can verify. It runs on staleproof.dev's hosted service in graph mode: nothing to configure, no secrets, no database. It can also run the docs examples a pull request reaches, before and after it, in a sandbox, when the server has that switched on ([Examples in a sandbox](#examples-in-a-sandbox)); staleproof.dev turns it on after its end-to-end run, and until then the [Action](github-action.md) is the way to run examples. This page is for maintainers choosing between the App and the [GitHub Action](github-action.md): what the App does, the permissions it asks for and why, what happens to a private repository's code, the `[app]` settings, and how to run your own copy.

## Install it

Click **Install the GitHub App** on [staleproof.dev/#/install](https://staleproof.dev/#/install), the page's first button, or open [github.com/apps/staleproof](https://github.com/apps/staleproof) directly; pick the account and the repositories, and click **Install**. That is all: the next pull request is checked. Nothing is indexed at install time; the first pull request of a repository indexes it (a minute or two for a mid-size repository), and later ones reuse the index.

## On every pull request

When a pull request is opened, pushed to, reopened or marked ready for review:

1. A check run named **Staleproof** starts (`in progress`) on the head commit.
2. Staleproof indexes the repository if needed, reads the pull request's diff, and runs the hosted graph check: the doc sections the changed code reaches with the evidence path for each, the examples whose calls no longer fit the changed code ("predicted to break"), and **Docs this pull request makes wrong**, the paths, links, anchors, commands, CLI flags, env vars and docstrings in the docs, READMEs and AI agent files that were true at the base commit and are not at the head ([Lint](lint.md)).
3. The check run completes:
   - **Summary**: the same Markdown report the Action posts as its comment.
   - **Annotations**: one per new finding, on its line in the Files tab (errors as failures, warnings as warnings, info as notices), sent 50 per request as the Checks API requires.
   - **Conclusion**: `success` when the pull request makes nothing wrong and breaks no example, `neutral` when it does (the default never blocks a merge), or `failure` when `[app] fail-on` says so.
   - **Apply fixes**: a button when some findings have a verified fix (see [Fixes](#fixes)).
4. **A comment**, only when there is something to say: new findings or examples predicted to break. It is the report, kept up to date in place on every push (one comment per pull request, found by its hidden marker). When a later push clears everything, the comment is edited to **All clear** rather than deleted, so the history of the review stays readable. `[app] comment` changes this.
5. **Suggestions**: each verified fix whose lines are in the pull request's diff becomes a GitHub suggestion in one review, which the author commits with one click. A later push updates a suggestion on the same lines instead of adding another. When the [Action](github-action.md) runs on the repository too, a suggestion it already posted for the same findings, on the same lines and with the same text, counts as already there, so the App does not post it again (and the Action does the same for the App's); comments by people never count.
6. **Examples, before and after**, when the server has example runs switched on (staleproof.dev does not yet): when the changed code reaches docs examples, up to 3 of them (those predicted to break first, as in the Action) run at the pull request's base and head commits in a [sandbox](#examples-in-a-sandbox), after the Staleproof check run is complete. Their results come in a second check run, **Staleproof · examples**, with the before/after table of the Action's report, and the comment is updated with the same table. An example that passes before and fails after is something to say: it gets a comment under `comment = "findings"`.

Drafts are skipped until they are marked ready (or set `[app] drafts = true`). **Re-run** on the Checks tab, for one check run or the whole suite, runs the check again on the current head.

The App runs graph mode: no model judges the sections, so the report says "can make false" where the Action in agent mode would say "stale". Use the [Action](github-action.md) for agent mode, and for example runs before and after while the App's server has them switched off.

### Fixes

A fix is attached to a finding only when the right answer is unambiguous (a script, file or flag renamed in the same pull request, a single close match) and is **verified**: applied in memory and linted again, the finding is gone and nothing new appears ([Fix](fix.md)).

- **Inside the diff**: a suggestion on the line.
- **Outside the diff** (a README the pull request did not touch still names the renamed script): listed in the comment with `npx staleproof fix`, and the check run's **Apply fixes** button commits them all to the pull request's branch, as one commit by the App on top of the head the check ran on. If the branch moved since, nothing is written and the check run says so; the new head has its own check and button. Branch protection that refuses the App is reported the same way. The App never force-pushes.
- **Pull requests from forks**: the App cannot push to a fork, so there is no button; the check run's details carry the fixes as a patch (`git apply` it, or run `npx staleproof fix` in the checkout).

### Examples in a sandbox

When the server has it switched on (`STALEPROOF_APP_RUN_EXAMPLES=on`, see [Run your own App](#run-your-own-app)), the **Staleproof · examples** check run is the Action's example runs ([Example runner](example-runner.md)) on the App's server, in a [Vercel Sandbox](https://vercel.com/docs/sandbox) (a Firecracker microVM) instead of the Actions runner. staleproof.dev ships with it off and turns it on after its end-to-end run; until then its Staleproof check run says the examples run in the Action, and the [Action](github-action.md) runs them.

- **Which examples**: the ones graph mode selects, at most 3: examples predicted to break first, then the examples of exactly linked sections, never one the docs mark `skip` or `expect-error`. Each runs at the pull request's base commit and at its head; an edited page is run as the pull request leaves it.
- **How**: one sandbox per check, created when the first example needs it and deleted at the end (nothing is kept). Each repository is read at its commit by the App's server, private ones with the installation's token, and uploaded into the sandbox: the token never enters it. With network: Python 3.12 and a virtualenv per set of commits (the repositories installed from source with uv), and a scratch FalkorDB. Without network (no egress, no DNS): each example, through the same entry point, network shim and environment as the Action's sandbox, with the same timeout (`STALEPROOF_RUN_TIMEOUT_MS`, 30 s).
- **Verdicts**: the same as everywhere: `breaks` (passes before, fails after), `fixes`, `passes`, `already-broken`, `changed-failure`, not run (skipped, with the reason), not installed. A run with the same program and commits is recorded and answered again without a sandbox, so a re-run of the check is fast.
- **Conclusion**: `neutral` when the pull request breaks an example, `failure` when it does and `[app] fail-on = "predicted"`, `success` when the examples ran and none breaks. A sandbox that cannot start or runs out of time ends the check `neutral` with the reason: it never fails a pull request.
- **When examples are not run**, the Staleproof check run says why and that the Action runs them: the repository sets `run-examples = false`, the server does not run examples (the switch is off, as on staleproof.dev for now), the check had no time left (a repository's first pull request is indexed first), or the day's budget is used up. JavaScript and TypeScript examples run in the Action and the CLI only, for now.
- **Private repositories**: the runs (status, error line, the end of the output, the commits installed) are kept in the installation's own graph, like everything else the App records; the sandbox and the archives are gone after the check.

## Pushes to the default branch

A push to the default branch refreshes the repository's index, at most once every 5 minutes per repository. A push in between marks the index dirty; the next pull request check (or the daily job) refreshes it first.

## The daily job

Once a day the App visits each installed repository (least recently visited first) and, when its `[app]` settings ask:

- `fix-prs = true`: lints the default branch, applies every verified fix and opens or updates one pull request from the branch `staleproof/fix-docs` titled "Staleproof: fix N stale docs references", closing it when nothing is left ([Fix](fix.md)).
- `audit-issue = true`: audits the docs and keeps one issue up to date, the same issue as the Action's `mode: audit` ([Docs audit](audit.md)): opened when examples no longer fit the code, fail when run, or docs references no longer match the repository; updated while they do; closed with "All clear" when nothing is left.

## Configuration

The App reads the `[app]` table of `.staleproof.toml` (or `[tool.staleproof.app]` in `pyproject.toml`) **on the default branch**, never from the pull request, so a pull request cannot switch its own check off. Every key is optional:

```toml
[app]
comment = "findings"       # findings | always | never
fail-on = "never"          # never | findings | predicted
suggestions = true         # verified fixes as review suggestions
drafts = false             # check draft pull requests too
also-index = []            # other repositories indexed with this one, e.g. ["acme/docs"]
fix-prs = false            # daily: the staleproof/fix-docs pull request
audit-issue = false        # daily: keep the audit issue
run-examples = true        # run the affected docs examples before and after, in a sandbox (when the server runs examples)
```

| Key | Default | Effect |
|---|---|---|
| `comment` | `"findings"` | `findings`: comment only when the pull request makes a docs reference wrong or an example is predicted to break, and edit the comment to "All clear" once it no longer does. `always`: keep the report in a comment on every pull request. `never`: the check run only |
| `fail-on` | `"never"` | `findings`: the check run fails when the pull request makes an **error**-level docs reference wrong. Beta rules never fail the check unless `[rules]` opts them in. `predicted`: it fails when an example is predicted to break by a stable check, or by a beta one the repository opts in at `warning` or `error`. The **Staleproof · examples** check fails when an example breaks and `fail-on` is `predicted`. `never`: it is `neutral` at worst. Make the check required in branch protection to block merges on it |
| `suggestions` | `true` | Post verified fixes inside the diff as review suggestions |
| `drafts` | `false` | Check draft pull requests (otherwise they are checked when marked ready) |
| `also-index` | `[]` | Repositories indexed together with this one, so docs in another repository (a docs site, an SDK's docs) are linked to this repository's code. For a private repository they may be other repositories of the same installation; one the installation cannot read is left out. For a public repository they must be public |
| `fix-prs` | `false` | Open and update the daily docs fix pull request |
| `audit-issue` | `false` | Keep the daily audit issue |
| `run-examples` | `true` | Run the docs examples a pull request reaches before and after it in a sandbox (the **Staleproof · examples** check), when the server has example runs switched on (staleproof.dev does not yet). `false`: the Staleproof check says they run in the Action |

Lint settings (`[lint]`, `[rules]`, `ignore`) apply as everywhere else ([Configuration](configuration.md#repository-configuration)).

## Permissions and why

| Permission | Access | Why |
|---|---|---|
| Checks | write | Create and complete the Staleproof check run (and Staleproof · examples, when the server runs examples), the annotations and the Apply fixes button |
| Contents | write | Read the repository (its archive at both commits, the compare view, `.staleproof.toml`); commit fixes when you click **Apply fixes**, and push the `staleproof/fix-docs` branch when `fix-prs` is on. The App writes nothing else: only to the pull request's branch on your click, and only to `staleproof/*` branches on its own |
| Pull requests | write | Read pull requests, post the review with suggestions, and open the docs fix pull request |
| Issues | write | The pull request comment (pull request comments are issue comments) and the audit issue |
| Metadata | read | Required by GitHub for every App |

Events: `pull_request`, `push`, `check_run`, `check_suite`, plus `installation` and `installation_repositories`, which every App receives.

## Private repositories

- **Read with the installation's token**, which GitHub issues per installation and which expires within an hour; the App keeps it in memory until a minute before it expires and never writes it to a log, a graph or a comment.
- **Indexed into a graph of their own**, `ghp-<installation id>`, on Staleproof's FalkorDB, never into the public workspace of the owner (`gh-<owner>`). No public endpoint can address it: the website, `/api/check`, `/api/audit`, `/api/lint`, `/api/badge`, `/api/mcp` and the checked stamp refuse it and answer as if the repository were unknown, and the list of recent checks never includes it. **Results appear only on GitHub**: the check run, the comment, the suggestions and the issue.
- **What the graph holds**: what the index of any repository holds ([Graph model](GRAPH-MODEL.md)): files, symbols and signatures, doc sections and their text, examples, the lint findings, pull requests and check traces. The source archive is extracted to a temporary folder for indexing and deleted right after.
- **How long**: the same limits as the hosted workspaces. Up to 4 repositories per installation graph (the least recently used leaves it when a fifth arrives), 20 MB of graph, 3000 code and docs files and a 150 MB archive per repository; the least recently used workspaces are dropped when the server fills up, and indexed again on the next pull request.
- **Removing it**: removing a repository from the installation drops the installation's private graph; uninstalling the App drops it and everything the App recorded about the installation.
- A repository that was public and indexed in the hosted service is dropped from the public workspace the first time the App sees it private.

## App or Action?

| | GitHub App | [GitHub Action](github-action.md) |
|---|---|---|
| Setup | Install; no YAML | A workflow file |
| Runs on | staleproof.dev | Your Actions minutes |
| Private repositories | Yes, indexed on Staleproof's server (above) | Yes, nothing leaves the runner except what you send |
| Docs references made wrong, annotations | Yes | Yes |
| Doc sections reached, examples predicted to break | Yes | Yes |
| **Examples run before and after** | When the server has it switched on (not yet on staleproof.dev): Python, in a sandbox, up to 3 per pull request | Yes, Python and JS/TS, on the runner |
| Agent mode (a model judges each section, proposes the edits) | No | Yes, with your key |
| Suggestions for verified fixes | Yes | Yes (`suggestions: true`) |
| Apply fixes button | Yes | No (`npx staleproof fix`) |
| Docs fix pull request, audit issue | Daily, by `[app]` settings | On your schedule (`mode: fix`, `mode: audit`) |
| Limits | 4 repositories per installation graph, 20 MB of graph, 3000 files | The runner's |

Both can run on one repository; they keep separate comments.

## Run your own App

For a self-hosted Staleproof server ([Deploy](DEPLOY.md)):

1. `npx tsx scripts/github-app-register.ts` (add `--org <org>` for an organisation, `--name` if "Staleproof" is taken). It serves a page on localhost that sends [github-app.json](../github-app.json) to GitHub; click **Create GitHub App**, and GitHub returns to the script, which writes the App's id, private key (base64) and webhook secret, plus a new `CRON_SECRET`, to the git-ignored `.env.app` and prints the commands below. Nothing secret is printed. Change the webhook URL in `github-app.json` first if your server is not staleproof.dev, and give the host that answers without a redirect (`staleproof.dev` here; `www.` redirects to it): GitHub does not follow redirects when it delivers a webhook.
2. Copy them to the server's environment, without printing them:

   ```bash
   grep '^GITHUB_APP_ID=' .env.app | cut -d= -f2- | tr -d '\n' | vercel env add GITHUB_APP_ID production
   grep '^GITHUB_APP_PRIVATE_KEY=' .env.app | cut -d= -f2- | tr -d '\n' | vercel env add GITHUB_APP_PRIVATE_KEY production
   grep '^GITHUB_APP_WEBHOOK_SECRET=' .env.app | cut -d= -f2- | tr -d '\n' | vercel env add GITHUB_APP_WEBHOOK_SECRET production
   grep '^GITHUB_APP_SLUG=' .env.app | cut -d= -f2- | tr -d '\n' | vercel env add GITHUB_APP_SLUG production
   grep '^CRON_SECRET=' .env.app | cut -d= -f2- | tr -d '\n' | vercel env add CRON_SECRET production
   ```

3. Redeploy. `/api/health` then reports `githubApp: { enabled: true, appSlug, installUrl }` and the install page shows the button.

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID` | The App's numeric id |
| `GITHUB_APP_PRIVATE_KEY` | Its private key: the PEM, the PEM with `\n` on one line, or base64 |
| `GITHUB_APP_WEBHOOK_SECRET` | Every delivery's `X-Hub-Signature-256` is checked against it (HMAC-SHA256, constant time) |
| `GITHUB_APP_SLUG` | Optional: shows the install button (`github.com/apps/<slug>`) |
| `CRON_SECRET` | Protects `GET /api/github/cron`; Vercel Cron sends it as a bearer token. Without it the daily job is off |

To run examples in a sandbox, the server needs Vercel Sandbox: on Vercel the function's OIDC token is used (Settings → Security → OIDC federation on); elsewhere set an access token with its team and project. Then switch it on:

| Variable | Meaning |
|---|---|
| `STALEPROOF_APP_RUN_EXAMPLES` | `on` runs the affected examples in a sandbox (off by default) |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Sandbox credentials off Vercel (all three) |
| `STALEPROOF_APP_EXAMPLE_CHECKS_PER_DAY` | Checks with example runs per day, across installations (default 200) |
| `STALEPROOF_APP_EXAMPLES_BUDGET_S` | At most this long for one pull request's examples (default 600) |
| `STALEPROOF_APP_MAX_DURATION_S` | The function's time limit when the platform does not say (on Vercel it does) |
| `STALEPROOF_SANDBOX_REGION` | The sandbox region (default: the project's) |

The examples run after the webhook answered, within the function's time limit: set `maxDuration` to 800 on Vercel Pro (300 is Hobby's maximum, which leaves a few minutes after the graph check). Ship `scripts/falkordb-local.sh` with the function (`includeFiles`).

Without the first three, `POST /api/github/webhook` and `GET /api/github/cron` answer 404 and nothing else changes. The webhook answers `202` at once and does the work in the background (on Vercel through `waitUntil`, within the function's `maxDuration`); payloads over 25 MB are refused, and a delivery id seen in the last 24 hours is ignored, so redelivering an event from the App's settings does nothing.

## Related

- [GitHub Action](github-action.md): the same check in your own CI, with example runs and agent mode.
- [Lint](lint.md) and [Rules](rules.md): what "docs references made wrong" checks.
- [Fix](fix.md): how fixes are found and verified.
- [HTTP API](http-api.md#post-apigithubwebhook): the webhook and cron routes.
