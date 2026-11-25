# dsh-self-evolve

Hermes-style self-editing for DeepSeek Harness: the agent updates its own
memory, persona and skills from inside a chat, with the same guarantees Hermes
Agent has (atomic batches, a budget on the final result, recoverable deletes).

## Tools

| Tool | Writes | Reads |
|---|---|---|
| `memory` | `~/.dsh/MEMORY.md` (target `memory`), the `SYNC:USER` block of `~/.dsh/AGENTS.md` (target `user`) | `view` returns the entries |
| `persona_update` | the `SYNC:PERSONA` block (`persona`) and `SYNC:SOUL` block (`soul`) of `~/.dsh/AGENTS.md`; a plain AGENTS.md without markers is itself the persona | `view` returns the text and its section outline |
| `skill_manage` | skills in every root DSH scans (`~/.dsh/skills`, `~/.agents/skills`, project `.dsh/skills` + `.agents/skills`, custom dirs) | `view` returns the raw SKILL.md and file list |

`memory` keeps the Hermes call shape: `{ target, operations: [{ action: add | patch | remove, content?, old_text? }] }`
applied atomically, the character budget checked only on the final result.

**Automatic condensation.** When a batch with `add` operations would put a
store over its character limit, `memory` shortens the store first through the
Harness LLM service — the calling session's own model — and then applies the
batch in the same write. Patches and removes are not rescued this way: they
address text in the store as it is, and a condensed store no longer has it, so
a growing patch that overflows is rejected whole and the agent curates.
The model sees one entry per call: the store's biggest entries are rewritten
one at a time, each told its own size, the size to reach and the paths, hosts,
ports, versions and numbers it must keep verbatim, until the batch fits. A call
asks for at most a tenth of the entry, so the loss spreads over several
entries instead of gutting one. That
is the least lossy trim the batch allows: an entry's wording is compressed,
never its facts, and a store only just over its limit is cut only just enough.
The result's `condensed` field reports the calls and the size before and after,
and the first instruction, the entries sent and the answer are kept as
`<snapshot>.condense.json` beside the history snapshot. A rewritten entry is
written only when it parses, is smaller than the one given, is not far shorter
than it had to be and keeps most of its concrete tokens; otherwise the add is rejected exactly as it would be
without condensation and `condense.error` names the reason, so the agent
condenses the entries itself.

**Periodic memory review.** Waiting for the add that overflows a store means
the first the agent hears of it is the trim. So a store at or above
`reviewFillShare` of its budget (default 85%) is put in front of the session
with its live usage — characters, limit, percentage, entry count — as one
user-role notice at the start of a turn: on the first turn the session runs
with such a store, and after that at most once every `reviewEveryTurns` turns
(default 10),
and the agent curates with the `memory` tool it already has: drop stale,
superseded or duplicated entries, merge restatements, tighten wording, keep
paths, ports, versions and numbers verbatim. The notice is step-local (source
kind `self-evolve-review`), never a session event, so it does not rewrite the
transcript; a subagent session never gets it; a store below its share and a
wake with nothing claimed stay silent. `reviewEveryTurns: 0` turns it off. This
is the Hermes `memory.nudge_interval` idea carried by the running session
instead of a forked reviewer agent.

**Background review.** With `backgroundReview: true` the plugin runs a
post-turn learning pass on the durable `turn/end` session event (a completed or
max-tokens turn only, never aborted/error/blocked), at most once every
`backgroundEveryTurns` turns (default 3). It derives the finished turn, asks the
host LLM for a JSON operations list, and applies only guarded `memory`
add/patch and `skill_manage` create/edit operations through the same atomic
write paths. It never deletes, never edits persona/soul/user, never wakes the
session, and a failed call, unparseable answer or rejected operation leaves
every store untouched.

**Stale-entry curator.** With `curator: true` an entry whose **text has not
changed** for `curatorStaleDays` (14) is a candidate; at `curatorDeepDays` (30)
it goes to a deep archive instead. Nothing is ever deleted: the entry is moved
out of the active store into a dated file under
`~/.dsh/self-evolve/archive/` (`memory-YYYY-MM-DD.md`,
`memory-deep-YYYY-MM-DD.md`), with a snapshot of the store taken first. A
**pin** bypasses the age entirely — `{ "action": "pin", "old_text": "…" }` on
the `memory` tool, `unpin` releases it — and pins live in
`~/.dsh/self-evolve/curator-<target>.json`, keyed by the entry text, so editing
an entry drops its pin. The automatic pass is tied to pressure: below
`curatorTriggerShare` (0.9) of the store's limit it only refreshes the state
file and reports `below_share`, so a small, deliberately curated store is never
touched. `{ "action": "curate" }` forces one pass now. This is Hermes'
`curator.py` reduced to its deterministic half: no model call, no consolidation
fork, and archive instead of delete.

**Skill curator.** The same policy for skills, on Hermes' schedule:

- **Only curator-managed skills are candidates.** A skill becomes managed the
  moment `skill_manage` creates or edits it; the rest of the shared hub is
  reported by `scan` as `unmanaged_ignored` and never touched.
- **Inactivity-triggered, no cron.** A run is observed at the start of a turn
  when the last one is older than `skillCuratorIntervalHours` (168 h) and the
  agent has been idle for `skillCuratorMinIdleHours` (2 h). The first
  observation only seeds the clock, so an install never mutates the library on
  its first tick; `pause` / `resume` (alone) stop and restart it.
- **Three states, never delete.** Hermes' `active → stale → archived`: an
  unpinned skill unchanged for `curatorStaleDays` (14) is only **marked** stale
  in the state file — the file does not move, and any write or pin revives it.
  At `curatorDeepDays` (30) it is **moved** into
  `~/.dsh/self-evolve/archive/skills/<date>/` and named in that tree's
  `INDEX.md`; a restore is one move back. One run archives at most
  `skillCuratorBatch` (10).
- **Every run leaves a report** in `~/.dsh/self-evolve/reports/<date>.md`:
  trigger, duration, what was marked, revived and archived, with paths — and
  `health` exposes `lastRunSummary` / `lastReportPath`.
- **Consolidation is opt-in** (`skillCuratorConsolidate: false`): the scheduled
  pass asks the configured `condenseProvider`/`condenseModel` to fold
  overlapping managed skills into one umbrella, then archives the sources. The
  `consolidate` action runs it on demand.

`skill_manage { "action": "scan" }` shows what would go without changing
anything (`skillCuratorScanLimit`, 20 rows, total always reported); `pin` /
`unpin` (with `name`) keep a skill out of every pass.

**Skill nudge.** Hermes keeps a separate `skills.creation_nudge_interval`;
here `skillNudgeEveryTurns` (10) adds one step-local notice on the first step of
every Nth user turn asking whether the session produced a reusable procedure
worth a `skill_manage` write. It carries its own source kind
(`self-evolve-skill-nudge`), never fires in a subagent session or on a wake with
nothing claimed, and `0` turns it off.

`skill_manage` takes `{ operations: [{ name, action: create | patch | edit | write_file | remove_file | delete | view, ... }] }`;
any failure rolls back every skill the batch touched, and `delete` moves the skill to
`~/.dsh/self-evolve/trash/skills/` instead of unlinking it.

Every write first saves a snapshot of the previous content under
`~/.dsh/self-evolve/history/<store>/` (20 per store, configurable). Skills inside
the installation (`$DSH_INSTALL_DIR`, `node_modules`, `.system`) are read-only:
edits there would be lost on upgrade.

## Where a change takes effect

- Persona / soul / user block — `dsh-agent-instructions` re-probes `~/.dsh/AGENTS.md`
  before every step, so the updated text enters the next step of the running session
  and every new session.
- Memory — the file is read at session start (or whenever the agent reads it).
- Skills — the body is re-read on every load; a new or renamed skill reaches the
  catalog on the next step through the skill provider's watcher.

## Hermes mirror

`mirrorCommand` (default `~/.agent-shared/sync-agents.py` in this profile's bundle
patch) runs after each write. The script is the existing two-way mirror between
`~/.dsh/{AGENTS.md,MEMORY.md}` and `~/.hermes/{config.yaml,SOUL.md,memories/}`; its
last output line is reported in the tool result as `mirror.summary`.

## Configuration (`cordis.patch.yml` row `self-evolve`)

| Key | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` / `~/.dsh` | Harness home |
| `dataDir` | `<dshHome>/self-evolve` | history + trash |
| `agentsMd` | `<dshHome>/AGENTS.md` | persona / soul / user blocks |
| `memoryFile` | `<dshHome>/MEMORY.md` | memory store |
| `memoryMirrors` | `[]` | extra files written with the memory text |
| `userFile` | — | user store when AGENTS.md has no `SYNC:USER` block |
| `personaStart/End`, `soulStart/End`, `userStart/End` | `SYNC:*` markers | block markers |
| `memoryCharLimit` / `userCharLimit` | `12000` / `6000` | budget in characters, 0 = unlimited |
| `autoCondense` | `true` | shorten an over-limit store with the model, then apply the batch, instead of rejecting the add |
| `condenseProvider` / `condenseModel` | session's model | provider route and model of the condensation calls; set both to pin them |
| `condenseTimeoutMs` | `120000` | time budget of one whole condensation |
| `reviewEveryTurns` | `10` | periodic memory review: the notice repeats every N user turns, 0 = off |
| `reviewFillShare` | `0.85` | store usage share (0..1) from which the review speaks |
| `backgroundReview` | `false` | post-turn learning pass: derive the turn, ask the model for guarded memory/skill operations, apply them through the same write paths |
| `backgroundProvider` / `backgroundModel` | session's model | provider route and model of the background call; set both to pin them |
| `backgroundEveryTurns` | `3` | run the background pass at most once every N completed user turns, 0 = off |
| `backgroundTimeoutMs` | `30000` | time budget of one background model call |
| `curator` | `false` | stale-entry archiving: move an unchanged, unpinned entry out of the store into a dated archive file (never delete) |
| `curatorStaleDays` | `14` | age after which an unchanged entry becomes an archive candidate |
| `curatorDeepDays` | `30` | age after which it goes to the deep archive |
| `curatorTriggerShare` | `0.9` | store usage share below which the automatic pass archives nothing; `curate` ignores it |
| `skillCurator` | `false` | skill archiving: move an unchanged, unpinned skill into the archive tree (never delete) |
| `skillCuratorMaxSkills` | `0` | ceiling for the scheduled pass: it runs only while the managed library is larger; `0` = no ceiling |
| `skillCuratorIntervalHours` | `168` | hours between scheduled runs (Hermes default: 7 days) |
| `skillCuratorMinIdleHours` | `2` | idle hours the agent needs before a scheduled run happens |
| `skillCuratorScanLimit` | `20` | rows the `scan` action returns; the total is always reported |
| `skillCuratorBatch` | `10` | most skills one run may archive, so a single call never sweeps the library |
| `skillCuratorConsolidate` | `false` | opt-in LLM consolidation: fold overlapping managed skills into one umbrella, archive the sources |
| `skillCuratorProvider` / `skillCuratorModel` | — / — | route for consolidation; falls back to `condenseProvider`/`condenseModel`, then to the session's own model |
| `skillNudgeEveryTurns` | `10` | every N user turns, one notice asking whether a reusable procedure belongs in a skill |
| `memoryEnabled`, `userProfileEnabled`, `skillsEnabled`, `personaEnabled` | `true` | tool / target switches |
| `skillsProjectDir` | `.agents/skills` | where `scope: project` creates skills |
| `customSkillDirs` | `[]` | extra roots searched for existing skills |
| `maxContentBytes` | `262144` | largest single write |
| `viewMaxChars` | `20000` | view truncation |
| `historyMax` | `20` | snapshots per store / skill, 0 = none |
| `mirrorCommand` | `[]` | post-write command |
| `mirrorTimeoutMs` | `8000` | its time budget |
| `promptNote` | `''` | one system-prompt sentence about using the tools |
| `routePrefix` | `/api/self-evolve` | `GET <prefix>/health` |

## Tests

```sh
node --test test/
```

Runs on a throwaway HOME; the last case also compiles and runs the tool
definitions against the installed `@deepseek-ai/dsh-tools` when reachable.

Two invariants the tests pin down:

- **Tool arguments are read-only.** The host hands `execute` a deep-frozen
  copy of the call (`deepFreeze(snapshotJsonValue(...))` in the dsh-tools
  pipeline), so a tool must never assign to an operation object; normalize into
  a copy instead. Writing to it fails every live call with
  `Cannot assign to read only property`.
- **The `after` hook is registered after the tests.** Under
  `--test-name-pattern` a root hook registered before them starts while the
  matching test is still running and would delete HOME from under it.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Muhamad Rian Santoso.
