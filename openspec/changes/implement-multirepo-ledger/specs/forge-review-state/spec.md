# Spec: forge-review-state

Traces to: D55 (an overlay that ships off), D56 (batching by owner), D57 (a count is a fact or it
is silence), D58 (the forge asymmetry), D59 (the key is `(host, owner)`), D60 (detection is the
query), D61 (no token, ever), D62 (three moments and no other), D53 (the remote URL as a hint), and
the cross-cutting D1 (`forge` may not depend on `read`), D13 (the pinned child runner), D23 (line 3
carries the count), D63 (activation order) and D65 (every outbound path).

---

## ADDED Requirements

### Requirement: The layer ships off, and nothing leaves the machine until it is switched on

The system SHALL default `multirepoLedger.forge.enabled` to `false`. While it is `false` the system
SHALL NOT spawn `gh` or `glab`, SHALL NOT probe for their presence, SHALL NOT read any remote for
the purpose of grouping repositories into queries, and SHALL render nothing at all in the review
position of any row.

Switching the setting on SHALL take effect in the running window. Switching it off SHALL cancel any
query in flight, SHALL discard its answer rather than rendering it, and SHALL return every review
position to rendering nothing.

#### Scenario: A default installation makes no forge call
- **WHEN** the extension is installed with default settings
- **AND** the list has rendered forty repositories with their last commits
- **THEN** no `gh` or `glab` process SHALL have been spawned
- **AND** the output channel SHALL record no forge command

#### Scenario: The off state is empty, not zero
- **WHEN** `multirepoLedger.forge.enabled` is `false`
- **THEN** line 3 of every row SHALL carry the HEAD state and, where it applies, the kind marker
- **AND** SHALL NOT carry `0`, a dash, or an empty placeholder where a count would go

#### Scenario: Switching it on needs no reload
- **WHEN** the user sets `multirepoLedger.forge.enabled` to `true` with the list already populated
- **THEN** the batched queries SHALL be planned and issued in the same window
- **AND** the review position of every row whose owner is being asked SHALL show the pending form

#### Scenario: Switching it off cancels what is running
- **WHEN** `multirepoLedger.forge.enabled` is set to `false` while a query is in flight
- **THEN** the child process SHALL be killed
- **AND** its answer SHALL NOT be rendered on any row
- **AND** every review position SHALL render nothing

---

### Requirement: One query per distinct owner, and never one per repository

The system SHALL issue one batched query per distinct owner or group, and SHALL NOT issue a query
scoped to a single repository under any circumstance, including as a fallback when a batched query
did not cover a repository.

The queries are `gh search prs --owner <owner> --state open --limit <n> --json
repository,number,title,url,isDraft,updatedAt` and `glab mr list --group <group> --state opened
--per-page <n> --output json`, and each SHALL be written to the output channel exactly as it was
run. GitHub allows thirty search requests a minute, so a per-repository query over a directory of
forty repositories exceeds the limit inside a single pass and renders a board where the first rows
carry counts and the rest carry nothing — which reads as a defect in the extension rather than as a
limit on the host, and appears only on directories large enough to be the reason somebody installed
it.

#### Scenario: Forty repositories, three owners, three queries
- **WHEN** the layer is on and the list holds forty repositories spanning three distinct owners on
  one host
- **THEN** exactly three forge queries SHALL be issued
- **AND** the output channel SHALL record all three commands verbatim
- **AND** every one of the forty rows SHALL take its review state from the query for its own owner

#### Scenario: Twenty repositories under one owner cost one query
- **WHEN** twenty repositories share one owner on one host
- **THEN** one query SHALL be issued
- **AND** all twenty rows SHALL be filled from that single answer

#### Scenario: A repository the batch did not cover is not asked about on its own
- **WHEN** a batched query succeeds but names no open request for a particular repository in that
  namespace
- **THEN** the system SHALL NOT issue a further query scoped to that repository
- **AND** the row SHALL report what the covering query established, and nothing more

---

### Requirement: Queries are serialised, and a rate limit is never retried automatically

The system SHALL issue the batched queries through one queue, in order, with at most one forge
child process running at a time.

When a CLI reports a rate limit, every owner whose query has not yet run SHALL report silence with
`rate limited` as the stated reason, the system SHALL NOT retry, and the next attempt SHALL be the
user's next explicit Refresh.

#### Scenario: Only one query runs at a time
- **WHEN** three owners are to be asked
- **THEN** the second query SHALL NOT start before the first has exited or been cancelled
- **AND** the third SHALL NOT start before the second has

#### Scenario: A rate limit stops the queue and states itself
- **WHEN** the first owner's query succeeds and the second reports a rate limit
- **THEN** the repositories under the first owner SHALL keep the counts that query established
- **AND** every repository under the second and third owners SHALL show the dimmed reason
  `rate limited`
- **AND** no repository SHALL show `0`
- **AND** no further query SHALL be issued until the user invokes Refresh

#### Scenario: Refresh is the only way back
- **WHEN** a pass has ended with owners reporting `rate limited`
- **AND** the user does nothing
- **THEN** no forge query SHALL be issued at any later moment
- **WHEN** the user then invokes `multirepoLedger.refresh`
- **THEN** one query per distinct owner SHALL be issued again

---

### Requirement: A truncated answer is silence for the whole namespace, never a smaller number

The system SHALL set the result limit explicitly rather than relying on a CLI default, and SHALL
treat an answer as truncated when its returned row count equals the limit that was requested **or**
any limit the CLI reports having applied. Testing only against the requested limit is not enough: if
the CLI or the host caps results below the request, the returned count never equals the request,
truncation is never detected, and every repository in the namespace shows a number that is short —
which happens only for the largest owners, the ones with the most to lose.

The requested limit SHALL be written to the output channel beside the returned row count, so a short
answer can be diagnosed from the log without re-running the query.

When an answer is truncated, every repository in that namespace SHALL report `answer truncated` and
none SHALL show a number. A lower bound rendered as a count is a wrong number, which is worse than
an absent one.

#### Scenario: The answer fills the requested limit exactly
- **WHEN** a query is issued with a limit of `n` and returns exactly `n` rows
- **THEN** every repository in that namespace SHALL show the dimmed reason `answer truncated`
- **AND** no repository in that namespace SHALL show a count, including the repositories that were
  named in the returned rows

#### Scenario: The CLI applies a lower ceiling of its own
- **WHEN** a query is issued with a limit of `n`, the CLI reports applying a maximum of `m` below
  `n`, and the answer returns exactly `m` rows
- **THEN** the answer SHALL be treated as truncated
- **AND** every repository in that namespace SHALL show `answer truncated`
- **AND** the output channel SHALL record both the requested limit and the returned row count

#### Scenario: The answer is under the limit
- **WHEN** a query issued with a limit of `n` returns fewer than `n` rows
- **THEN** each repository named in those rows SHALL show its count
- **AND** each repository in that namespace named in none of them SHALL show `0`

#### Scenario: A GitLab listing that hits its page limit
- **WHEN** `glab mr list --group <group> --per-page <n>` returns a page holding exactly `n` merge
  requests
- **THEN** every repository in that group SHALL show `answer truncated`
- **AND** none SHALL show a merge-request count

---

### Requirement: An answer is applied only to repositories on the host it was asked of

The system SHALL key every forge result by `(host, owner)`, and SHALL apply a query's answer only
to repositories whose remote names the same host the query ran against.

A `gh` answer SHALL never populate a row whose remote points at a GitLab host, and an answer from
one GitHub host SHALL never populate a row pointing at another. This is the invariant that stops
the most plausible wrong number this extension could produce.

For a GitHub host other than `github.com`, the system SHALL run the query with `GH_HOST` set to
that host in the child's environment.

#### Scenario: The same organisation name on two hosts
- **WHEN** the directory holds `github.com/acme/api` and `github.example.com/acme/api`
- **AND** `gh` is signed in to `github.com` only
- **THEN** the `github.com` query's answer SHALL populate only the `github.com/acme/api` row
- **AND** the `github.example.com/acme/api` row SHALL show the dimmed reason
  `github.example.com not signed in`
- **AND** SHALL NOT show the count established for `github.com/acme/api`, and SHALL NOT show `0`

#### Scenario: A GitHub answer never reaches a GitLab row
- **WHEN** the directory holds repositories on `github.com` and on `gitlab.company.example`
- **AND** the `gh` query succeeds and the `glab` query fails
- **THEN** the GitLab rows SHALL show the dimmed reason for their own failure
- **AND** SHALL NOT show any number derived from the `gh` answer

#### Scenario: A non-default GitHub host is asked by name
- **WHEN** a repository's remote names `github.example.com`
- **THEN** the query for that owner SHALL be spawned with `GH_HOST=github.example.com` in the
  child's environment
- **AND** the command and the host SHALL be written to the output channel

---

### Requirement: The forge is decided per repository, from that repository's own remote

The system SHALL decide which adapter applies, and which owner a repository belongs to, from that
repository's own remote URL, and SHALL NOT decide it once for the directory. A directory may hold
personal repositories on one host, work repositories on another, a mirror with no remote at all,
and a fork whose remotes point at two hosts.

The remote is the one the branch's upstream names; failing that `origin`; failing that the sole
remote when there is exactly one. When none of those names a remote, no host and no owner can be
established for that repository.

A repository whose host matches no adapter SHALL be carried by its ordinary local row — its HEAD
state, its divergence against whatever upstream exists, and its last commit — with no number and no
forge placeholder.

#### Scenario: A directory that mixes forges, accounts and hosts
- **WHEN** the directory holds a personal repository on `github.com`, a work repository in a group
  on `gitlab.company.example`, a mirror with no remote at all, and a fork whose `origin` is on
  `github.com` and whose upstream is on `github.example.com`
- **THEN** the personal repository SHALL be asked about through `gh` against `github.com`
- **AND** the work repository SHALL be asked about through `glab` against its group
- **AND** the mirror SHALL show the dimmed reason `no remote`
- **AND** the fork SHALL be grouped by the remote its upstream names, not by `origin`

#### Scenario: A self-hosted forge nobody has an adapter for
- **WHEN** a repository's remote names a host that matches neither adapter
- **THEN** the row SHALL show its last commit, its divergence and its HEAD state as it does with
  the layer off
- **AND** SHALL NOT show a review count
- **AND** SHALL NOT show `0`

#### Scenario: A repository with no remote at all
- **WHEN** a repository's configuration names no remote
- **THEN** the row SHALL show the dimmed reason `no remote`
- **AND** SHALL NOT show `0`

---

### Requirement: Grouping costs no git process, and its remote parse can only fail to silence

The system SHALL establish the host and owner of each repository by reading that repository's git
directory configuration file directly, and SHALL NOT spawn a git process per repository to do it.

That parse is a hint rather than an authority: `include`, `includeIf` and `url.<base>.insteadOf`
can put the effective URL somewhere the parse does not see. The consequence SHALL be bounded to
silence — a repository the parse grouped wrongly, or could not group at all, SHALL report an
unestablished count, and SHALL NOT receive the count belonging to another namespace.

#### Scenario: Enabling the layer spawns no additional git process
- **WHEN** `multirepoLedger.forge.enabled` is switched on with forty repositories on the board
- **THEN** the output channel SHALL record one forge command per distinct owner
- **AND** SHALL record no additional `git` invocation attributable to the forge layer

#### Scenario: A URL the direct parse cannot resolve
- **WHEN** a repository's configuration carries its remote URL through an `include` directive, or
  rewrites it with `url.<base>.insteadOf`
- **AND** the parse therefore yields a host and owner git would not have used
- **THEN** the repository SHALL report an unestablished count with its reason
- **AND** SHALL NOT be filled from the answer of any namespace it does not belong to

---

### Requirement: A count is a fact or it is silence, and zero is only ever a fact

The review state of a repository SHALL be exactly one of: not asked, because the layer is off; a
query covering it is outstanding; a count established by a successful query; or unestablished,
carrying the reason it is unestablished.

`0` SHALL render only in the third of those. A repository whose count the system has not
established SHALL NOT render `0`, SHALL NOT be ordered as though its count were zero, and SHALL NOT
be folded into a total a reader could subtract from.

#### Scenario: An established zero is shown
- **WHEN** a query covering a repository's namespace succeeds, is not truncated, and names no open
  request for that repository
- **THEN** the row SHALL show `0` with that forge's own term

#### Scenario: An unestablished count is never zero
- **WHEN** the query covering a repository failed for any reason
- **THEN** the row SHALL show the dimmed reason for that failure
- **AND** SHALL NOT show `0`

#### Scenario: No ordering treats an unestablished count as zero
- **WHEN** the user opens the sort picker
- **THEN** no offered sort mode SHALL order the list by review count
- **AND** the order of the rows SHALL be unchanged by whether any query has answered

#### Scenario: The header states how many could not be asked
- **WHEN** the layer is on and four repositories report an unestablished count
- **THEN** the header SHALL state that four repositories could not be asked
- **AND** SHALL NOT report zero open requests for any of them

---

### Requirement: While an answer is outstanding the row says so

While a batched query covering a repository is outstanding, the row SHALL show a dimmed pending
form in the review position — the GitHub term followed by an ellipsis on a GitHub remote, the
GitLab term on a GitLab one — and SHALL NOT show a number.

Every pending position SHALL resolve to either an established count or a stated reason. A
repository's local facts SHALL render before any query is issued and SHALL NOT wait on one.

#### Scenario: The board is complete before the network is asked
- **WHEN** the layer is on and the extension has just started
- **THEN** each row SHALL show its last commit, divergence and HEAD state as soon as its own git
  read lands
- **AND** the review position SHALL show the dimmed pending form until the query for its owner
  answers

#### Scenario: The pending form is neither a zero nor a blank
- **WHEN** a query for an owner is in flight
- **THEN** no repository under that owner SHALL show `0`
- **AND** none SHALL show an empty review position indistinguishable from the layer being off

#### Scenario: Every pending position resolves
- **WHEN** a query in flight exits, by success, by failure or by being killed
- **THEN** every row it covered SHALL show either a count or a dimmed reason
- **AND** none SHALL remain in the pending form

---

### Requirement: Presence and authentication are learned from the query, and nothing ever prompts

The system SHALL detect that a CLI is absent from the first spawn that fails with `ENOENT`, and
SHALL remember that for the window rather than discovering it again per repository.

The system SHALL NOT run an authentication probe. Authentication SHALL be established by the
batched query itself, and its failure classified from the exit code and standard error into a
stated reason.

Forge children SHALL be spawned through the same runner as every git child: without a shell, with
piped standard input, output and error, and with no terminal, so a CLI that would prompt for a
credential cannot. No command that starts an authentication flow SHALL ever be run.

#### Scenario: A missing CLI is discovered once
- **WHEN** `glab` is not on `PATH` and eight repositories on a GitLab host are on the board
- **THEN** at most one `glab` spawn SHALL be attempted
- **AND** all eight rows SHALL show the dimmed reason naming the missing CLI
- **AND** none SHALL show `0`

#### Scenario: An unauthenticated host states itself
- **WHEN** `gh` is installed but holds no credentials for the host a query runs against
- **THEN** the query SHALL fail without prompting
- **AND** the rows in that namespace SHALL show `not signed in`, naming the host when it is not the
  default one
- **AND** the exit code SHALL be written to the output channel

#### Scenario: No authentication probe is run
- **WHEN** the layer is on and a pass issues its queries
- **THEN** the output channel SHALL record only the batched query commands
- **AND** SHALL record no `gh auth status`, no `gh auth login` and no `glab auth login`

#### Scenario: A CLI that wants to prompt fails instead
- **WHEN** a CLI would ordinarily prompt on a terminal for a credential
- **THEN** the child SHALL have no terminal to prompt on
- **AND** the query SHALL exit rather than block
- **AND** the affected rows SHALL show a stated reason

---

### Requirement: The two forges answer different questions, and the row does not pretend otherwise

The system SHALL treat a GitHub search over an owner as covering every repository in that owner's
namespace, so a repository the answer does not name has an established count of zero.

**That coverage is an assumption and is not yet verified.** A search returns what the authenticated
credential can see, so a repository the credential lacks the scope to read is named in no result row
for a reason that has nothing to do with how many requests are open on it. Until the assumption is
checked against a real host with a deliberately under-scoped credential, it is recorded as an
assumption in the design's Risks section and as a task, and if the check refutes it the established
zero on the GitHub side is withdrawn rather than kept.

The system SHALL NOT treat a GitLab group listing as covering anything outside that group. A
project in a personal namespace, or one sitting outside any group, SHALL report an unestablished
count with its reason, SHALL NOT report zero, and SHALL NOT be followed by a per-project query.

Any non-zero exit, any output that cannot be parsed, and any flag a CLI does not recognise SHALL
resolve to an unestablished count with the exit code written to the output channel.

#### Scenario: A GitHub repository with nothing open
- **WHEN** the owner's search succeeds, is not truncated, and names no request for one of that
  owner's repositories
- **THEN** that row SHALL show `0` with the GitHub term

#### Scenario: A GitLab project outside any group
- **WHEN** a repository sits in a personal namespace on a GitLab host and the group query cannot
  cover it
- **THEN** the row SHALL show an unestablished count with its reason
- **AND** SHALL NOT show `0`
- **AND** no per-project query SHALL be issued for it
- **AND** the output channel SHALL name what would have answered

#### Scenario: A CLI flag a future release renamed
- **WHEN** `glab` exits non-zero reporting an unrecognised flag
- **THEN** every repository in that namespace SHALL show an unestablished count
- **AND** the exit code SHALL be written to the output channel
- **AND** no number SHALL be rendered from the partial or unparseable output

#### Scenario: Each forge's own word is used
- **WHEN** a count is rendered on a row whose remote is a GitHub host
- **THEN** the row SHALL use the GitHub term for a pull request
- **AND** SHALL NOT use the GitLab term on that row, nor the GitHub term on a GitLab row

---

### Requirement: No credential is ever asked for, read, stored or logged

The extension SHALL contribute no setting naming a token, SHALL NOT read `GH_TOKEN`,
`GITHUB_TOKEN` or `GITLAB_TOKEN`, SHALL write nothing to `SecretStorage`, SHALL never pass a flag
that prints a token, and SHALL never write a token to the output channel.

The only environment variable the system SHALL set for a forge child is `GH_HOST`, whose value is a
hostname.

#### Scenario: The settings UI offers no token field
- **WHEN** the user opens the settings for this extension
- **THEN** the only forge-related setting SHALL be `multirepoLedger.forge.enabled`
- **AND** no setting for a token, a credential, an account or an API base URL SHALL be offered

#### Scenario: The log holds commands and exit codes, not secrets
- **WHEN** several queries have run, some succeeding and some failing
- **THEN** the output channel SHALL hold each command as it was run and each exit code
- **AND** SHALL hold no token, and no value read from the ambient environment

#### Scenario: Nothing is stored
- **WHEN** the layer has run queries against two hosts
- **THEN** no entry SHALL have been written to `SecretStorage`

---

### Requirement: Queries are issued at three moments and at no other

The system SHALL issue forge queries when the layer is enabled and the list is first populated,
when the user invokes Refresh, and when `multirepoLedger.forge.enabled` is switched on. It SHALL NOT
issue one on a file-watcher event, and SHALL NOT issue one on a timer.

#### Scenario: Working in a terminal generates no network traffic
- **WHEN** the user commits in a terminal in a watched repository
- **AND** the watcher pass re-reads that repository's row
- **THEN** the row's last commit, divergence and HEAD state SHALL update
- **AND** no forge query SHALL be issued
- **AND** the review position SHALL keep the count the last query established

#### Scenario: An idle window asks nothing
- **WHEN** the layer is on and the window is left open and untouched for an hour
- **THEN** no forge query SHALL be issued after the first pass

#### Scenario: A count states its own age
- **WHEN** a count established earlier in the session is still on the row
- **THEN** its tooltip SHALL say when it was fetched

---

### Requirement: Results live in memory for the life of the window and are written nowhere

The system SHALL hold forge results in memory only, and SHALL NOT write repository names, owners or
counts to any file.

#### Scenario: A reload starts from nothing
- **WHEN** the window is reloaded with the layer still on
- **THEN** no count from the previous session SHALL be rendered
- **AND** each review position SHALL show the pending form until the new pass answers

#### Scenario: Nothing is persisted
- **WHEN** queries have run against two owners
- **THEN** no file naming those repositories, owners or counts SHALL have been created in the
  extension's storage

---

### Requirement: A forge failure never changes a local fact, and a local state never changes a forge fact

The system SHALL join review state onto the model as an overlay keyed by repository path. A forge
failure SHALL leave every local fact on the row unchanged, and the state of a repository's HEAD,
working tree or history SHALL NOT change what the forge layer reports about it.

#### Scenario: The board survives a forge outage
- **WHEN** every forge query fails
- **THEN** every row SHALL still show its last commit's date and subject, its divergence and its
  HEAD state
- **AND** the list SHALL still sort by the mode in force
- **AND** only the review position SHALL differ from a successful pass

#### Scenario: The layer can be removed entirely
- **WHEN** `src/forge/` is deleted from the source tree
- **THEN** `npm run compile` SHALL succeed
- **AND** the list SHALL still discover, read and render every repository

#### Scenario: A repository with no commits still has a review state
- **WHEN** a repository is on an unborn branch and its remote names an owner that answered
- **THEN** line 2 SHALL say there are no commits yet
- **AND** the review position SHALL show what the query established for it

#### Scenario: A repository mid-rebase or with a detached HEAD is asked about like any other
- **WHEN** a repository is mid-rebase, or has a detached HEAD
- **THEN** its review state SHALL be decided by its remote and its owner's answer alone
- **AND** SHALL NOT be suppressed, and SHALL NOT be reported as zero

#### Scenario: A bare repository is grouped from its own configuration
- **WHEN** a bare repository on the board names a remote in its configuration
- **THEN** it SHALL be grouped into that owner's query like any other repository
- **AND** the absence of a working tree SHALL NOT change its review state

#### Scenario: A submodule shown as its own row is grouped from its own remote
- **WHEN** `multirepoLedger.includeSubmodules` is on and a submodule has a row
- **THEN** its owner SHALL be taken from its own configuration, not from the superproject's
- **AND** the superproject's answer SHALL NOT populate its review position

#### Scenario: A repository git refused is never reported as having nothing open
- **WHEN** git refuses a repository for dubious ownership
- **THEN** the row SHALL keep the refusal it states
- **AND** SHALL NOT report `0` open requests

#### Scenario: An excluded repository is in no query
- **WHEN** a repository's path is listed in `multirepoLedger.exclude`
- **THEN** it SHALL contribute no owner to the query plan
- **AND** SHALL appear in no count and in no header sentence

#### Scenario: No git on PATH
- **WHEN** `git` is absent from `PATH` and the layer is on
- **THEN** the list SHALL show the single explained state for the whole board
- **AND** no row SHALL show a review count or a review-count reason

#### Scenario: A query that never answers
- **WHEN** a forge child does not answer before the runner's timeout, or its output is truncated at
  the runner's output cap
- **THEN** every repository in that namespace SHALL show an unestablished count with a stated
  reason
- **AND** SHALL NOT show a number derived from the partial output

#### Scenario: A slow or unreachable filesystem under a root
- **WHEN** a repository's git directory sits on a mount that does not answer, so its configuration
  cannot be read
- **THEN** no host or owner SHALL be established for it
- **AND** the row SHALL show the dimmed reason rather than a count
- **AND** the queries for every other owner SHALL still be issued

---

## Open against design

Three things this capability needs that no decision settles, and one thing the design has since
settled. Each is written above the way the design implies; none is invented as a decision.

- **A host that matches no adapter has no reason string.** D57's reason set is closed and holds
  `gh not installed`, `not signed in`, `<host> not signed in`, `rate limited`, `answer truncated`
  and `no remote`; none of them fits a repository on a self-hosted forge this extension has no
  adapter for. D59 says the layer reports nothing for such a repository and the local-only fallback
  carries the row, so this spec renders nothing there. If a dimmed reason is wanted instead, the
  reason set needs one more member and D57 should say so.
- **A forge query has no guard of its own.** D3's 10 s per-process timeout and 32 MiB output cap are
  guards sized for a local git read, and D13 makes the forge layer inherit that runner. Nothing
  decides whether a network-bound query gets its own, longer guard. This spec requires only that a
  query which does not answer resolves to a stated reason and never to a number.
- **The header sentence is not a chip.** D57 says the header can state that four repositories could
  not be asked, but D30's chips are keyed to D29's closed state set, which contains no forge state,
  so nothing decides whether that sentence filters the list the way a chip does. This spec requires
  the sentence and does not require a filter behind it.

**Settled in the design since this file was written:** the count's label. D23 wrote `2 PRs` where
D57's table wrote `3 PR`; D23 now carries D57's unpluralised form, so the pure row module has one
rule to implement. This spec continues to require each forge's own term and to forbid one forge's
term on the other's row.
