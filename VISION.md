# Where Staleproof goes next

Docs drift because nothing connects a merge to the paragraphs it falsifies, and the paragraph is usually in another
repository. Staleproof's graph makes that connection; the plan is to make it routine.

**Shipped.** What used to be on this page and is live now:

- On every pull request: the [GitHub App](docs/github-app.md) (public and private repositories, no workflow file,
  suggestions and an Apply fixes button) and the [GitHub Action](docs/github-action.md) on the GitHub Marketplace
  (examples run before and after; a weekly audit issue, a weekly fix pull request and a release gate).
- Before a pull request: [`staleproof lint`](docs/lint.md) and [`fix`](docs/fix.md) over the docs, READMEs and the
  files AI coding agents read; the [VS Code and Cursor extension](docs/editors.md) on the Visual Studio Marketplace and
  Open VSX; the [Claude Code plugin](docs/claude-code.md); [pre-commit hooks](docs/pre-commit.md); MCP tools for coding
  agents.
- Private repositories on the hosted service, through the App: one graph per installation that no public endpoint
  can read.
- Languages: TypeScript and JavaScript examples run as well as Python ones (Sphinx docs are read too); Go is indexed
  and its examples are checked; monorepos are split into packages. Docs are audited with no pull request at all.
- Teams: the ["checked against" stamp](docs/verified-stamp.md) for docs sites, CODEOWNERS routing and the digest.

**Month 1 — run it where it hurts.** The GitHub App and Action on FalkorDB's client, SDK and docs repositories and on
five open-source libraries with separate docs repositories. Measure verdict precision against what maintainers accept
and reject (`staleproof verdict accept|reject` already records it on the graph) and publish the number.

**Month 3 — the demand side.** Link GitHub issues and discussions to the symbols they ask about. "Asked about but
undocumented" is the same graph walked from the other end: symbols with many questions and no doc within three hops.
Staleproof opens those docs PRs too.

**Month 6 — hosted for teams.** staleproof.dev already indexes any public repository on first use into a graph of
its own, and the App already keeps private repositories in a graph per installation. Next: one graph per organisation
on managed FalkorDB, Go examples run like the others, more languages (Java), and decisions imported from ADRs and PR
review threads.

**Business.** Free for open source. Per-repository subscription for private repositories; devtools companies already
pay developer-relations teams to do this by hand after every release.
