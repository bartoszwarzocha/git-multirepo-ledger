# Repo Ledger — brief for the session that builds this

Read this first, then `openspec/project.md` and `openspec/config.yaml`. Between them they are the
whole brief. Nothing else needs to be reconstructed.

## What we are building

A VS Code extension that watches **a directory containing many git repositories** and shows their
state at a glance. The user's own words (Polish, translated verbatim — this is the requirement,
not a paraphrase):

> "A list showing the latest commits in each repo, and the history of each repo at the bottom.
> So: the top part is a list of repos in the directory with a multi-line view (1: repo name,
> 2: last commit, 3: branches, MR); the bottom part (after clicking a repo at the top) is the
> repo's history."

That is three lines per repository in a top list, and a history pane below it driven by the
selection.

## Decisions already taken with the user — do not reopen these

| Decision | Detail |
|---|---|
| **Name and location** | `repo-ledger`, display name **Repo Ledger**, at `E:\AI\repo-ledger`. The user chose this over `git-repo-radar` and `multi-repo-monitor`. |
| **MR/PR source** | The `gh` and `glab` CLIs when present and authenticated, with a local-only fallback (unmerged branches, ahead/behind) when they are not. **Off by default** — it touches the network. Chosen over local-only, over `git ls-remote`, and over an API token. |
| **Layout** | Two views in one Activity Bar container: a webview list on top, the history pane below. This is the pattern the sibling project already proves. |
| **Code sharing** | Copy from the sibling project. **No monorepo.** Two Marketplace extensions with a shared package is a publishing coupling neither needs. |
| **Publisher, licence, engine** | `bartosz-warzocha`, MIT, VS Code `^1.104` — same as the sibling. |

## The sibling project is the house style

`E:\AI\openspec-ledger` is a finished, published extension by the same author. **Read it before
writing anything.** It is not a reference — it is the register this project must be written in.

Start with `src/util/git.ts`, `src/evidence/git.ts`, `src/view/nodes.ts`, `src/view/overviewPanel.ts`
and `src/model/types.ts`. What to absorb:

- TypeScript strict, ESM, `.ts` extensions in import specifiers, esbuild bundle, **no runtime dependencies**.
- Tests are `node --test "src/**/*.test.ts"` — plain `node:test`, no framework, no extension host.
- **Pure logic lives outside anything that imports `vscode`.** The modules that import `vscode`
  contain no decisions worth testing; every label, ordering, filter and judgement is decided in a
  pure module and unit-tested there.
- Comments say **why**, in full sentences, including the alternative that was rejected and what
  would go wrong with it. Read a few before writing one.
- Anything that shells out shows its exact command. Anything uncertain reports silence, never a
  guess. Anything that touches the network or private data ships **disabled**.
- Nothing on the activation path: work is scheduled after `activate()` returns.

Copy `src/util/git.ts`, `src/util/fsx.ts` and `src/util/log.ts` close to verbatim. Adapt
`src/discovery/search.ts` and `src/discovery/vscodeSearch.ts` — they walk for `openspec`
directories and must walk for `.git` instead, which changes more than the string (`.git` is in the
default exclude list, and finding one means *not* descending into it).

## The governing constraint

**This is published.** It runs on layouts, hardware and networks its author will never see.
`openspec/project.md` has the full statement; the short version is that nothing may be assumed
about repository count, nesting, git latency, core count, whether a repository answers at all,
whether `git`/`gh`/`glab` exist or are authenticated, or whether every repository belongs to one
account and forge.

## What the previous session got wrong — do not repeat it

The session that created this repository made two mistakes that cost the user time. They are
recorded here because they are easy to repeat.

1. **It measured the development machine and turned the results into the design.** A concurrency
   tuned to that machine's core count, a spawn cost from its disk, its repository count and
   nesting depth all went into the founding documents as if they were requirements. They are not.
   Measurements are smoke tests; a number from one machine never becomes a constant, a threshold
   or an argument. Derive it or make it a setting.
2. **It went spelunking through the user's disk for design input, repeatedly, and narrated it.**
   The user's own repository layout, git identities and working directories are *not* the
   specification. Ask the user a question rather than investigating them, and do not turn an
   incidental finding into a headline before establishing its cause.

The user's summary of both: *"the new extension is to be universal, exactly like OpenSpec Ledger."*

## What is already in this repository

```
LICENSE               MIT, Bartosz Warzocha — copied from the sibling
.editorconfig         copied verbatim
.gitattributes        copied verbatim
.gitignore            copied verbatim
openspec/project.md   what this is, what exists already, the governing constraint
openspec/config.yaml  the OpenSpec context and the proposal/spec/design/task rules
openspec/specs/       empty
CLAUDE.md             this file
```

Two commits, nothing pushed, no remote configured.

**There is no code yet.** No `package.json`, no `tsconfig.json`, no `esbuild.js`, no
`eslint.config.js`, no `.vscode/`, no `.github/`, no `src/`. That is the first job.

## Suggested first moves

1. Scaffold from the sibling: `package.json` (name, displayName, publisher, engine, categories,
   keywords for this domain, the same `scripts` and `devDependencies`), `tsconfig.json`,
   `esbuild.js`, `eslint.config.js`, `.vscodeignore`, `.vscode/launch.json`, `.vscode/tasks.json`,
   `.github/workflows/ci.yml`. Quote the sibling's `devDependencies` as they stand rather than
   inventing versions. End with `npm install` and a green `npm run compile`.
2. Write the OpenSpec change under `openspec/changes/<name>/` — `proposal.md`, `design.md`,
   `tasks.md` and the spec deltas — following the rules in `openspec/config.yaml`. This project is
   itself an OpenSpec project; the sibling's `openspec/changes/implement-openspec-ledger/` is the
   model for shape and depth. Its design decisions are numbered D1–D16; this project starts its
   own numbering at D1.
3. Then discovery and the row read, because every surface renders their output. Each group of
   tasks ends in something runnable or testable.

## Open questions for the user — ask, do not investigate

- The row is three lines in a **narrow sidebar**. Which field gets dropped first when it does not
  fit? The sibling solves this by moving the least useful field to a dimmed trailing span.
- Does the history pane need the commit graph (the `--graph` lanes), or is a dated list enough for
  a first version?
- Should clicking a commit in the history open its diff? If so, this needs research into the
  built-in `vscode.git` extension's exported API versus its internal commands, and a fallback.
- Does the top list need sorting, and by what — name, most recently committed, most divergent,
  dirtiest?
- Is a repository nested inside another repository shown as one row or two?
- UI language is **English**, matching the sibling. Confirm before writing user-facing strings.

## Working agreement

- Do not commit or push unless asked.
- Verify by running things, not by reasoning about them — but verify *the code*, not the user's
  machine.
- When something is genuinely ambiguous, ask one short question. Do not investigate around it.
