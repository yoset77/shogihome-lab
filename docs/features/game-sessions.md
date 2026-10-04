# Game Sessions

## Player scope

ShogiHome Lab targets users of externally configured USI engines. The upstream
beginner and random built-in players are retired rather than introducing a
second engine execution model for server-owned games. Both default players are
human. Loading legacy browser game settings converts built-in player selections
to the default human settings; existing records and player names in records are
not modified. New requests cannot select a retired built-in player.

## Ownership and scope

The Middle Server owns ordinary Web games: human/LAN players, clocks, legal
moves, termination, takeback, external books, repeated games, position lists,
results, and automatic saving. The browser only requests operations, synchronizes
the confirmed record and clocks, presents search information, and plays sounds.
There is no browser-only fallback game executor. Native USI and ponder are not
supported. Ordinary research and mate-search execution remain browser-owned.

`GameSession` owns a frozen request, `GameController`, monotonic clocks and player
resources. The USI state machine remains in `EngineSession`; game adapters use
internal sessions, not the public relay session registry. Analysis DB writes
continue through the existing engine session writer.

## Disconnect and recovery

- AI-vs-AI games, including repetitions and saving, continue without a browser.
- Disconnect during AI search does not cancel that turn. The next human turn
  pauses before charging time. An already active human turn pauses at disconnect
  or application-heartbeat expiry; time before detection remains charged.
- A timeout established before disconnect or a user operation wins. Pausing does
  not restore time retroactively. Resume preserves exact elapsed/byoyomi time.
- A new socket receives a full snapshot before a resume command enables human
  play. Controller epochs fence out replaced sockets and old commands. A replaced
  tab does not automatically reclaim control; heartbeat expiry is reconnectable.
- Creation uses request/server-instance identifiers. Lost responses are recovered
  by request ID; conflicting retries fail. Expired/unknown sessions and server
  restart do not automatically create a new game.
- Human actions use idempotent request IDs and game/turn generations. Retry keeps
  the original command identity, including through reload. Interrupt remains
  possible during preparation, cancellation and save/repetition transitions.
- HTTP 429 and temporary communication failures preserve linkage and edit locks,
  with exponential backoff respecting Retry-After. Normal updates do not poll
  HTTP. Full HTTP snapshots recover from transport gaps.
- Recovering over another record requires confirmation and a backup. Browser
  record storage is flushed before clearing completion linkage. Runtime search
  data and sub-second file-format precision are excluded from the reload content
  comparison, but preserved in the server snapshot.

## Records, books and saving

Record nodes have stable session IDs, never reused after takeback. Server
checkpoints restore records and both clocks atomically after USI cancellation
settles; old branches/annotations are protected. A repeated game starting from
the current position restores the frozen original tree, not the previous result.
See [Takeback](takeback.md).

External book files and position lists are resolved within `KIFU_DIR` using the
existing file-kind/path validators. Book selection preserves evaluation/depth,
ignore-rate and weighted-choice settings. Invalid moves are excluded and book
search failures fall back to timed engine search. Book handles belong to the
player and are released with it. Research annotations are optional, validated
WebSocket messages tagged with the current node, USI position and turn; stale
annotations never enter a new turn. They do not consume the global HTTP quota.

Each completed record is frozen before advancing. Automatic saves use the
configured server directory and format, existing filename templates and atomic
non-overwrite publishing. Filename collisions select another name. Save failures
warn, retain the complete record, and continue to the next game. Retained-record
UI provides opening/exporting via the normal record workflow, save retry and an
explicit recovery-link release. Link release does not delete server records.

Retention is bounded rather than silently discarding failures: reaching the
unsaved count/byte limit stops safely between games. All session state is volatile;
restart recovery and durable unsaved-record spooling are deliberately excluded.

## Operational limits

Current limits are defined by code and tested: one active game (no queue), at most
two internal game engines, ten terminal sessions retained for 24 hours, 100
unsaved records / 20 MiB per session, and 16 MiB current-record snapshot budget.
The creation body limit is 10 MiB. The shared tree/ply limits apply, and input
reserves node capacity for subsequent play. Heartbeat is sent every five seconds
and expires after thirty seconds; display interpolation is bounded and is not an
authoritative clock. Command and creation ledgers are bounded at 10,000 entries.
Analysis-job and public-relay resource limits are independent and unchanged.

## Verification

- Server clock, controller characterization, takeback, session and API tests.
- Browser synchronization/reload/response-loss/429/storage-failure tests.
- Real HTTP/WebSocket/TCP integration, including cancellation and detached games.
- Optional Rust Wrapper integration uses an isolated config and a fixture USI
  process: set `SHOGIHOME_WRAPPER_EXE` when running `game_integration.spec.ts`.
- Production-build PC/mobile UI was verified against the Rust Wrapper and fixture
  USI engine: board input, takeback, page-close/reload recovery, detached repeated
  games, forced save failures, retained-record opening, and save retry/link release.
- Actual-engine playing strength/performance and restart persistence are not
  covered by the fixture integration tests.
