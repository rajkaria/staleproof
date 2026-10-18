# Install

Every way to use Staleproof, in the order the site's install page, [staleproof.dev/#/install](https://staleproof.dev/#/install), offers them: the GitHub App first (one click, no workflow file), the GitHub Action second (the way to run docs examples today), then the website, your editor, Claude Code, an MCP server for your AI assistant, the CLI, a pre-commit hook and `staleproof init`, which sets several of them up at once. Each section says what it needs, what it does, and what it does not do.

| Way | Needs | Runs examples | Repositories |
|---|---|---|---|
| [GitHub App](#github-app-no-workflow-file) | Installing the App on the repository | No | Public and private |
| [GitHub Action](#github-action-one-click) | A workflow file in the repository | Yes, before and after each pull request | Public and private |
| [Website](#website-no-install) | A browser | No | Public |
| [Editors](#editors-while-you-type) | VS Code, Cursor or another LSP-capable editor; Node.js 20+, git | No | Any local checkout |
| [Claude Code plugin](#claude-code-plugin) | Claude Code; Node.js 20+, git | No | Any local checkout |
| [MCP, hosted](#mcp-hosted-no-install) | An MCP client | No | Public |
| [MCP, local](#mcp-local) | Node.js 20+, git, uv or `python3` | Yes | Public and private (with `GITHUB_TOKEN`) |
| [CLI](#cli-one-command) | Node.js 20+, git, uv or `python3` | Yes | Public and private (with `GITHUB_TOKEN`) |
| [pre-commit](#pre-commit-on-every-commit) | pre-commit, lefthook or husky; Node.js 20+ | No | Any local checkout |
| [`staleproof init`](#staleproof-init-set-it-all-up) | Node.js 20+, git | Sets up the ones above | Any local checkout |

## GitHub App: no workflow file

Click **Install the GitHub App** on [staleproof.dev/#/install](https://staleproof.dev/#/install) (it opens [github.com/apps/staleproof](https://github.com/apps/staleproof)), pick the repositories, and click **Install**: no YAML, no secrets. The next pull request is checked.

- **What it does.** Every pull request gets a **Staleproof** check run with the docs references it makes wrong (as annotations), the doc sections its code changes reach and the examples predicted to break, a comment only when there is something to say, each verified fix inside the diff as a one-click suggestion, and an **Apply fixes** button on the check run that commits the rest to the pull request's branch. Private repositories are read with the installation's token and indexed into a graph no public endpoint can read. Once a day it can keep a fix pull request and an audit issue up to date (`[app] fix-prs`, `audit-issue`).
- **What it does not do.** It runs no examples and has no agent mode: the [GitHub Action](github-action.md) does both, in your own CI. The two work side by side; a suggestion one of them already posted on the same lines is not posted again.

Permissions, private code and the `[app]` settings: [GitHub App](github-app.md).

## GitHub Action: one click

The Action is listed on the GitHub Marketplace as [Staleproof docs check](https://github.com/marketplace/actions/staleproof-docs-check). On [staleproof.dev/#/install](https://staleproof.dev/#/install), type the repository and click **Add to owner/repo**. GitHub opens its "new file" page with `.github/workflows/staleproof.yml` filled in; click **Commit changes**. Options on the page add a docs repository to index with it (`also-index`), agent mode (needs an `ANTHROPIC_API_KEY` repository secret), failing the check when an example breaks (`fail-on: breaks`), and a weekly audit of the whole docs kept in one issue. Or copy [examples/staleproof.yml](../examples/staleproof.yml) yourself:

```yaml
name: Staleproof
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
```

- **What it does.** On every pull request the job starts a FalkorDB, indexes the repository, checks the change (the docs references it makes wrong, as annotations, and the examples predicted to break), runs up to 3 affected examples at the commit before the pull request and at the pull request, posts the verified fixes inside the diff as suggestions (`suggestions`, on by default), and posts one comment (kept up to date) with the report; the report also goes to the job summary. Other workflows of the same action: a weekly docs audit kept in one issue ([examples/staleproof-audit.yml](../examples/staleproof-audit.yml)), a weekly fix pull request (`mode: fix`, [examples/staleproof-fix.yml](../examples/staleproof-fix.yml)) and a release gate (`mode: release`, [examples/staleproof-release.yml](../examples/staleproof-release.yml)). Private repositories work with the workflow's default token.
- **What it does not do.** It changes no files on the pull request's branch. The fix pull request is opened by the workflow's token only when the repository allows it: turn on **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General → Workflow permissions), or pass a token of your own as `github-token` ([Fix stale docs](fix.md#a-weekly-fix-pull-request)). Without `falkordb-url` it keeps nothing between runs. Pull requests from forks get a read-only token: the report lands in the job summary, not as a comment, and no suggestion is posted.

Inputs, outputs and the comment format: [GitHub Action](github-action.md).

## Website: no install

Open [staleproof.dev](https://staleproof.dev) and paste the URL of a pull request in a public GitHub repository, or open `https://staleproof.dev/#/try?pr=<pull request URL>`, which starts the check directly.

- **What it does.** The first check of a repository downloads it and indexes it on the fly into the workspace graph of its owner (`gh-<owner>`), together with any repositories you name next to it (a docs site, an SDK; up to 4 per workspace), then checks the pull request in graph mode and streams the trace: the impacted doc sections with their evidence paths, the cleared symbols and the ranking. Agent mode is offered when the server has a model key, within a daily budget.
- **Audit a repository.** [staleproof.dev/#/audit](https://staleproof.dev/#/audit) audits a public repository with no pull request: every docs example checked against the code it calls, API coverage, a 0-100 health score and the README badge ([Docs audit](audit.md)).
- **What it does not do.** It does not run examples: the hosted service has no sandbox. For FalkorDB's own repositories it shows the runs recorded earlier. It reads public repositories only, and leaves nothing on your repository: no comment, no pull request.

## Editors: while you type

Install **Staleproof** (`staleproof.staleproof`) from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=staleproof.staleproof) in VS Code, or from [Open VSX](https://open-vsx.org/extension/staleproof/staleproof) in Cursor, Windsurf and VSCodium; from a shell, `code --install-extension staleproof.staleproof`.

- **What it does.** The same findings as `staleproof lint`, from the unsaved text, with the verified fixes as quick fixes, and hover from a docs code span to the code. The extension runs `staleproof lsp`, a language server that Neovim, Zed, Helix and JetBrains IDEs can run too.
- **What it does not do.** It reads the files, git and the local parse cache only: no graph, no network, no example runs.

Setup for each editor: [Editors (LSP)](editors.md).

## Claude Code plugin

In Claude Code:

```text
/plugin marketplace add rajkaria/staleproof
/plugin install staleproof@staleproof
```

- **What it does.** After each edit, Claude hears which docs and agent files the edit made wrong; before it stops, it is asked to fix them, once. The plugin also adds a skill and the commands `/staleproof:check`, `/staleproof:fix`, `/staleproof:audit` and `/staleproof:docs-for`.
- **What it does not do.** Nothing leaves the machine: the hooks read the checkout and git. Without the plugin, `npx -y staleproof init --claude` (or `--cursor` for Cursor) writes the same hooks into the project's settings.

Hooks, output and configuration: [Claude Code plugin](claude-code.md).

## MCP, hosted: no install

The hosted MCP server speaks Streamable HTTP at `https://staleproof.dev/api/mcp`. Add it to your client:

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http staleproof https://staleproof.dev/api/mcp` |
| Cursor | The **Add to Cursor** button on the install page, or `{"mcpServers": {"staleproof": {"url": "https://staleproof.dev/api/mcp"}}}` in `~/.cursor/mcp.json` |
| VS Code | The **Add to VS Code** button on the install page, or `code --add-mcp '{"name":"staleproof","type":"http","url":"https://staleproof.dev/api/mcp"}'` |
| Claude Desktop and claude.ai | Add a custom connector with the URL `https://staleproof.dev/api/mcp` |

- **What it does.** `check_pull_request` returns the whole report for a pull request in one call; the graph tools behind it (`impact`, `read_section`, `decisions_for`, `rank_sections` and the rest) answer follow-up questions. Before a pull request, `docs_for_symbol` lists the docs that depend on a function and `check_changes` checks edited files; `audit_docs` audits a repository's docs. Any public repository is indexed on first use.
- **What it does not do.** `run_example` is not offered and no example is executed. Private repositories cannot be read.

## MCP, local

```bash
claude mcp add staleproof -- npx -y staleproof mcp
```

- **What it does.** Serves all fourteen tools over stdio, `run_example` included, from your machine. With no `FALKORDB_URL` it starts a local FalkorDB; the tools index the repository they are about the first time they see it. `check_changes` can read the working tree of your checkout directly. Private repositories work with `GITHUB_TOKEN` in the server's environment (`-e GITHUB_TOKEN=<token>`).
- **What it does not do.** It writes nothing to GitHub. The first start installs falkordblite, which takes a minute.

Other clients, the tools and security notes: [MCP server](mcp.md).

## CLI: one command

```bash
npx -y staleproof check https://github.com/<owner>/<repo>/pull/<n> --no-agent
```

- **What it needs.** Node.js 20 or newer, git, and uv (recommended) or `python3` 3.12 or newer for the local FalkorDB and the example runs.
- **What it does.** With no `FALKORDB_URL` it starts a local FalkorDB (falkordblite, no Docker), indexes the pull request's repository at its default branch head into a graph named after the owner, checks the pull request, and runs up to 3 affected examples before and after it in a sandbox. Later checks of the same repository reuse the graph. Add `--with <owner/docs>` for docs that live in another repository, and set `GITHUB_TOKEN` for a private repository.
- **Agent mode.** Without `--no-agent`, `check` runs the agent when model credentials are set: `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `STALEPROOF_MODEL` for an Anthropic-compatible provider. Without them it prints a note and runs graph mode.
- **Before a pull request, and with none.** `npx -y staleproof lint` checks the docs and agent files of a checkout in seconds, with no graph and no network, and `npx -y staleproof fix` applies the fixes it can verify; `npx -y staleproof check` with no URL checks your uncommitted and unpushed changes (`--fail-on-predicted` for a pre-push hook); `npx -y staleproof audit <owner/repo>` audits the docs as they are.
- **What it does not do.** It opens no pull request unless you run `patch --open-pr` or `fix-pr`.

The full walkthrough: [Quickstart](getting-started.md). Every command: [CLI](cli.md).

## pre-commit: on every commit

In `.pre-commit-config.yaml`, with `rev` set to the latest release tag (the page linked below has it filled in):

```yaml
repos:
  - repo: https://github.com/rajkaria/staleproof
    rev: v<version>
    hooks:
      - id: staleproof
```

Then `pre-commit install`.

- **What it does.** On `git commit`, it lints what the commit contains (the git index) against `HEAD` and fails when the staged changes make a docs reference wrong: a renamed script the README still runs, a link `AGENTS.md` still follows to a page that moved. An optional `staleproof-predicted` hook on `git push` fails when a docs example is predicted to break.
- **What it does not do.** It reads only the local clone; nothing is fetched or sent.

lefthook, husky, a plain git hook and why the hooks run the published package: [Pre-commit hooks](pre-commit.md).

## `staleproof init`: set it all up

```bash
npx -y staleproof init
```

- **What it does.** Detects the GitHub repository, languages, docs folders, agent files and a separate docs repository the README links to, then offers each file and writes the ones you accept: `.staleproof.toml`, the workflow (the pull request check plus a weekly audit), the docs health badge in the README, the pre-commit (or lefthook, or husky) hook, `.staleproof/` in `.gitignore`, and the extension recommendation in `.vscode/extensions.json`. `--claude` and `--cursor` add the agent hooks.
- **What it does not do.** `--dry-run` prints every file and change and writes nothing; run again, it leaves what is in place alone.

Every option: [CLI](cli.md#init).

## Related

- [Quickstart](getting-started.md)
- [GitHub App](github-app.md)
- [GitHub Action](github-action.md)
- [Editors (LSP)](editors.md)
- [Claude Code plugin](claude-code.md)
- [Pre-commit hooks](pre-commit.md)
- [MCP server](mcp.md)
- [CLI](cli.md)
- [Deploy](DEPLOY.md): run the hosted service yourself
