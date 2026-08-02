# Source module map

Deep-link navigation map (section banners → anchors): [ARCHITECTURE.md](../ARCHITECTURE.md).  
For a narrative developer walkthrough, see [GUIDED_TOUR.md](../GUIDED_TOUR.md).

Fifteen JavaScript modules under `src/` — treat this as a fixed set. Extend an existing module rather than adding new source files unless there is an explicit architectural decision to do so (open an issue or discuss in your PR first).

| Source                 | ~LOC | Built to `client/`                  | Runtime              | Role                                                                                                                                                      |
| ---------------------- | ---- | ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chess.js`             | 5470 | `chess.js`                          | Wiki shell           | iframe/popup embed, journal save gateway, **all cross-wiki fetch**, `shellAppMessageHandlers`                                                             |
| `chess-app.js`         | 4500 | `chess-app.js`                      | iframe / popup / PWA | UI orchestrator — boot, view router, auth/PWA session, journal gateway, init hosts (`import * as` mode modules)                                           |
| `game.js`              | 4240 | _(inlined in chess-app)_            | App                  | GAME mode — console, seats, start-game modal, player bars, challenges, resign, comments                                                                   |
| `chess-core.js`        | 5310 | _(inlined in bundles)_              | Shared               | PGN/FEN/keywords, `MSG`, game-sync policy (pure), realtime presence helpers, session FSM, journal planning; namespaces `ChessRules` / `Paste` / `Journal` |
| `federation.js`        | 7440 | _(inlined in bundles)_              | Shared               | Glicko-2, federation crawl/consensus, site-survey deferred orchestration, charm/gossip page operations, browser site client                               |
| `glicko-worker.js`     | 50   | `glicko-worker.js`                  | Wiki shell Worker    | Off-main-thread Glicko timeline replay                                                                                                                    |
| `survey.js`            | 3640 | _(inlined in chess-app)_            | App                  | IndexedDB ratings, site-survey / open-challenge UI, shared `#leaderboard` browse shell                                                                    |
| `leaderboard.js`       | 1370 | _(inlined in chess-app)_            | App                  | Federated leaderboard UI (gate, hop dials, ranking table) — registers into survey                                                                         |
| `puzzle.js`            | 3730 | _(inlined in chess-app)_            | App                  | Puzzle solving + authoring UI, bulk CSV parse (`parsePuzzlesCsv`), on-device puzzle DB                                                                    |
| `board-layout.js`      | 3390 | _(inlined in chess.js + chess-app)_ | Shell + app          | Board fit, embed/PWA sizing, PWA protocol + page chrome, paste, `shellTransport` / `PWA` / `Transport`                                                    |
| `choose-menu.js`       | 540  | _(inlined in chess-app)_            | App                  | CHOOSE menu / game-lifecycle navigation                                                                                                                   |
| `position.js`          | 250  | _(inlined in chess-app)_            | App                  | POSITION mode — FEN editor board, save/flip, entry from CHOOSE                                                                                            |
| `realtime.js`          | 1330 | _(inlined in chess-app)_            | App                  | Game sync coordinator, remote poll, WebRTC, `applySyncedPosition`                                                                                         |
| `modals.js`            | 1790 | _(inlined in bundles)_              | Shell + app          | Shared modal/dialog library                                                                                                                               |
| `cm-modules-bundle.js` | 1470 | `cm-modules-bundle.js`              | App (runtime import) | chess-console + cm-\* wiki glue                                                                                                                           |

~LOC = total file lines, rounded. Refresh when a module shifts by more than ~50 lines.

## Architecture pillars (in-file subsystems)

1. **Game sync coordinator** — `evaluateGameSyncUpdate` in `chess-core.js` (pure); state + gates in `realtime.js`. Realtime / WebRTC accelerates noticing and publishing the same journal forks — it is not a separate game protocol.
2. **Wiki transport** — `createShellMessenger` / `shellMessengerFromContext` / `shellTransport` / `sendTransport` in `board-layout.js`; single enriched `postToShell` in `chess-app.js`
3. **Journal gateway** — journal planning, page actions, fork adoption, and ghost helpers in `chess-core.js`; shell `applyChessJournalSave` in `chess.js`; federation-only charm/gossip page operations in `federation.js`
4. **Neighborhood (federation)** — Glicko + consensus + site fetches in `federation.js`; IndexedDB-primary UI in `survey.js` (see below)

### Conceptual packages (reading aids inside hotspots)

Large modules stay one file (15-module cap). Use `// # Section Name` banners (see [ARCHITECTURE.md](../ARCHITECTURE.md)) and namespace objects as a map:

| Module            | Packages / namespaces                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `chess-core.js`   | Keywords · `ChessRules` · `Paste` · `PuzzlePool` · `Journal` · Identity · `Session` · `MsgSync`       |
| `federation.js`   | `Glicko` · TwinAudit · `Gossip` · `Challenges` · LeaderboardMeta · Consensus · `Crawl` · `SiteClient` |
| `board-layout.js` | `PWA` · `Transport` (+ `shellTransport`)                                                              |

## Neighborhood storage (IndexedDB-primary)

- **Local source of truth for UI:** [`survey.js`](survey.js) owns per-site rating state in IndexedDB (`RATING_INDEXED_DB_NAME` / `RATING_INDEXED_DB_STORE`), the fast sync loop, shared `#leaderboard` browse shell, and site-survey / open-challenge views. Federated-only gate/table UI lives in [`leaderboard.js`](leaderboard.js) (one-way import + `registerLeaderboardUi` hooks). IndexedDB `meta` also holds local-only `blockList`, `deletionMetrics`, `island`, `federationSites` (cached hosts that answered SURVEY-page probes), and `siteCrawlCache` (per-host sitemap + games snapshots — never gossiped). [`federationIndexedDbPayload()`](survey.js) attaches that meta to neighborhood fetch requests. [`leaveFederationViews()`](survey.js) tears down gate/modals without abandoning in-flight Visible-federation crawls. Island UI on My Chess Games is gated by [`shouldShowIslandNotice()`](federation.js) (sparse first-contact is not an island).
- **Shell fetch path:** app triggers neighborhood jobs via `wiki.buildLeaderboard` / `wiki.crawlUi` → [`chess.js`](chess.js) async fetchers in [`federation.js`](federation.js) (`buildLeaderboardAsync`, `buildSiteSurveyAsync`, `runNeighborhoodJob`, …). Site-survey deferred enrich + challenges use [`orchestrateSiteSurveyDeferredWork()`](federation.js) (MSG `BUILD_SITE_SURVEY_ENRICH` / `BUILD_CHALLENGES` with `forSiteSurvey`). Enrich reuses fast-path `meta.games` as `crawledGames` so the deferred pass skips a second site page crawl. Open-challenge discovery fetches each seed’s `my-chess-games` only (progressive `partial` replies). Seed order via [`buildFetchTargets()`](federation.js) / [`resolveFetchSeeds()`](federation.js): **local → opponents → neighbourhood → farm peers → IndexedDB `federationSites` / plugin index**, with `deferIndex` so the first wave never waits on the global index (background refresh via [`refreshFederationSitesFromIndex()`](federation.js)). Farm peers are discovered only in the browser via wiki-plugin-present (`GET /plugin/present/roll` / [`fetchFarmPeerSites()`](federation.js) / [`parsePresentRollSites()`](federation.js); soft-fails when present is not installed). The client passes `farmPeerSites` into `BUILD_CHALLENGES` / neighborhood jobs; [`pwa-bridge.js`](../server/pwa-bridge.js) forwards that list and does **not** re-discover peers. Neighbourhood mode can also **Add peers** from that same present roll into the curated `wiki.neighborhood` roster, mirroring **Add my opponents**. **Survey gameIndex + open challenges:** My Chess Games publishes `page.chess.gameIndex` (`active` / `completed` / `challenges` / `peers` — refs + hashes, no PGNs) and pending seeks in `page.chess.openChallenges` (journal-free). Journal saves and league seed maintain the catalog; federation game crawls read that catalog only. Local My Chess Games / past-opponents pass `rebuildIfEmpty` so an empty or unreadable catalog is seeded once from the sitemap and then persisted. Accept / seat-fill retires the matching seek; survey also prunes seeks whose page game already has both seats filled.
- **PWA bridge path:** installed app without iframe parent uses HTTP routes in [`server/pwa-bridge.js`](../server/pwa-bridge.js) with `createPwaBridgeSiteClient` (Node site client; browser uses `createBrowserWikiSiteClient`). Bridge dispatch forwards the same IndexedDB meta via [`federationIndexedDbOptsFromPayload`](../server/pwa-bridge.js), forwards client-supplied `farmPeerSites` (does not call present’s roll), and calls the same deferred orchestrator.
- **Consensus orchestrator:** [`consensusFromNetwork()`](federation.js) is the primary neighborhood entry — Choice A (lazy checkpoint piggyback when supermajority + hash match) vs Choice B (opponent-graph BFS audit + batched Glicko replay). [`runFederationConsensus()`](federation.js) / [`finalizeDeepConsensusResult()`](federation.js) label sync results (`lazy` / `checkpoint` / `audit`). Published gossip is `checkpoint` + `trustedPeers` only. **Visible-federation** crawls (Chess Leaderboards hop dials) pass `hopGraph` (`maxHops` / `hopDecay` / `HOP_TRUST_FLOOR`); after the local-seeded opponent-graph walk they also sitemap-crawl federation-search index hosts as non-expanding leaves ([`resolveFederationIndexLeafHosts()`](federation.js)) so published/forked games on indexed farms still surface without defeating hop bounds. **audit** crawls omit that bound and filter only with the local IndexedDB `blockList`.

## PWA client surface (`client/` + `board-layout.js`)

Not extra `src/` modules; install/session protocol lives in [`board-layout.js`](board-layout.js) and is guarded in [`architecture-guards.test.js`](../test/architecture-guards.test.js):

| File                       | Role                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/board-layout.js` §4   | `PWA_BRIDGE_BASE`, `matchInstalledChessPwa`, `initInstallNudge`, `fetchPwaSession` / `bridgeFetch`, service worker registration |
| `client/index.html`        | App shell; `#install-nudge` banner; early SW + manifest link                                                                    |
| `client/service-worker.js` | App-shell offline cache                                                                                                         |
| `server/pwa-bridge.js`     | Same-origin HTTP journal + federation bridge for installed PWA **and** direct `/plugins/chess/` tab (`GET /session`, save, crawl) |

## postMessage routing

- Action names live in `chess-core.js` (`MSG`); dispatch uses `createMessageDispatcher()` (shared lookup table).
- High-traffic payload shapes are documented in the comment block above `MSG` in `chess-core.js` (no separate types file).
- **App → shell:** prefer `wiki.*` semantic helpers — `createShellMessenger` / `shellMessengerFromContext` / `shellTransport` / `sendTransport` in `board-layout.js`; orchestrator-only enriched `postToShell` in `chess-app.js` (never raw `postToShell({ action: MSG.* })` in submodules). Enrichment: `enrichTransport()`; dispatch: `sendTransport()` / `shellTransport.*`.
- Init hosts pass the semantic `wiki` transport API.
- **Shell → app:** `initInboundShellMessageBridge()` in `board-layout.js` → `appShellMessageHandlers` in `chess-app.js`.
- Shell handles app requests via `shellAppMessageHandlers` in `chess.js` (same dispatcher pattern).
- Background SET_STATE reconciliation: `applySyncedPosition()` in `realtime.js` (`initShellSync` host from `chess-app.js`).
- Cross-wiki fetch: `createBrowserWikiSiteClient(wiki)` in `federation.js` (shell); `createPwaBridgeSiteClient` in `server/pwa-bridge.js` (shell-less HTTP bridge).

## Non-negotiables

- No analytics/telemetry.
- Bare keywords (`GAME` / `POSITION` / `PUZZLE` / `CHOOSE`) must not autosave on page load — only after user action.
- Shell context key: `${pageKey}/${item.id}` (not item id alone).
- App boot: `whenDocumentReady()` in `chess-app.js`.
- Edit `src/`; never hand-edit built `client/*.js` bundles. Run `npm test` after logic changes; `npm run build` before shipping client changes.
- Do not grow past the 15 modules in this file without an explicit project decision.

Full build and deploy notes: [ReadMe.md](../ReadMe.md#development).
