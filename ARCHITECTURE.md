# Architecture & Navigation Map

Looking for how the Federated Wiki Chess plugin is structured? This file is the high-level map. In-source landmarks use Markdown headings inside comments (`// # Section Name`, `// ## Sub-section Name`) so you can jump from here into the owning region in an IDE outline or on GitHub.

For a narrative walkthrough see [GUIDED_TOUR.md](./GUIDED_TOUR.md). For the fixed 15-module table and pillars see [src/README.md](./src/README.md).

## How to read these links

Section banners look like:

```js
// # Move Validation Rules
```

Relative links below use lowercase, hyphenated anchors derived from that title (for example `#move-validation-rules`). Prefer keeping files whole and partitioning with these banners rather than splitting into many tiny modules.

## Three runtimes

| Runtime | Entry | Role |
| ------- | ----- | ---- |
| **Shell** | [`src/chess.js`](./src/chess.js) | Wiki iframe/popup host, journal save gateway, all cross-wiki fetch |
| **App** | [`src/chess-app.js`](./src/chess-app.js) + mode modules | Board UI, Stockfish, FEN editor, puzzles, survey/leaderboard |
| **Server** | [`server/puzzle-server.js`](./server/puzzle-server.js), [`server/pwa-bridge.js`](./server/pwa-bridge.js) | Farm puzzle DB; installed-PWA HTTP bridge |

Shell ↔ app talk over `postMessage` (`MSG` in chess-core). Same origin only. The shell never imports `cm-modules-bundle.js`.

## Four pillars

1. **Game sync** — pure policy in [MsgSync Game Sync Policy](./src/chess-core.js#msgsync-game-sync-policy); coordinator + WebRTC in [`realtime.js`](./src/realtime.js#game-sync-coordinator).
2. **Wiki transport** — [Wiki Transport](./src/board-layout.js#wiki-transport) (`createShellMessenger` / `shellTransport` / `PWA`).
3. **Journal gateway** — planning in [Journal Autosave Guards and Save Planning](./src/chess-core.js#journal-autosave-guards-and-save-planning); shell apply in [Journal Save Gateway](./src/chess.js#journal-save-gateway); federation charm/gossip in [`federation.js`](./src/federation.js#gossip-checkpoints-and-page-charm).
4. **Neighborhood (federation)** — Glicko/crawl/consensus in [`federation.js`](./src/federation.js#glicko-rating-math); IndexedDB UI in [`survey.js`](./src/survey.js#indexeddb-rating-store).

## Source modules

### Shared core — [`src/chess-core.js`](./src/chess-core.js)

Pure logic (no DOM): keywords, validation, paste/journal planning, session FSM, MSG/sync.

| Section | Link |
| ------- | ---- |
| Stockfish rating constants | [Stockfish Rating Constants](./src/chess-core.js#stockfish-rating-constants) |
| Keywords / item modes | [Keywords and Item Modes](./src/chess-core.js#keywords-and-item-modes) |
| FEN/PGN validation (`ChessRules`) | [ChessRules Validation and Format Detection](./src/chess-core.js#chessrules-validation-and-format-detection) |
| Paste / ghost meta (`Paste`) | [Paste Capture and Ghost Metadata](./src/chess-core.js#paste-capture-and-ghost-metadata) |
| Puzzle pool / coach (`PuzzlePool`) | [PuzzlePool Filters Rows and Adaptive Coach](./src/chess-core.js#puzzlepool-filters-rows-and-adaptive-coach) |
| Journal planning (`Journal`) | [Journal Autosave Guards and Save Planning](./src/chess-core.js#journal-autosave-guards-and-save-planning) |
| Piece sets | [Identity Piece Sets and Board Preferences](./src/chess-core.js#identity-piece-sets-and-board-preferences) |
| Journal action symbols | [Journal Action Symbols](./src/chess-core.js#journal-action-symbols) |
| Player IDs / PGN tags | [Identity Player IDs PGN Tags and Labels](./src/chess-core.js#identity-player-ids-pgn-tags-and-labels) |
| Move comments | [Move Comments and Annotations](./src/chess-core.js#move-comments-and-annotations) |
| Game result copy | [Game Result and Outcome Copy](./src/chess-core.js#game-result-and-outcome-copy) |
| MSG contract | [MsgSync PostMessage Contract](./src/chess-core.js#msgsync-postmessage-contract) |
| Session FSM | [Session Lifecycle FSM](./src/chess-core.js#session-lifecycle-fsm) |
| Presence helpers | [MsgSync Realtime Presence Helpers](./src/chess-core.js#msgsync-realtime-presence-helpers) |
| Sync policy | [MsgSync Game Sync Policy](./src/chess-core.js#msgsync-game-sync-policy) |
| Namespace exports | [Namespace Exports](./src/chess-core.js#namespace-exports) |

### Wiki shell — [`src/chess.js`](./src/chess.js)

| Section | Link |
| ------- | ---- |
| Item live registry | [Plugin Boot and Item Live Registry](./src/chess.js#plugin-boot-and-item-live-registry) |
| Ghost / create-preview | [Ghost Pages and Create Preview](./src/chess.js#ghost-pages-and-create-preview) |
| Iframe sizing | [Iframe Embed Sizing and Scroll](./src/chess.js#iframe-embed-sizing-and-scroll) |
| Factory editor | [Factory Editor and Unconfigured Item](./src/chess.js#factory-editor-and-unconfigured-item) |
| Journal save | [Journal Save Gateway](./src/chess.js#journal-save-gateway) |
| Realtime persistence | [Realtime Item Persistence](./src/chess.js#realtime-item-persistence) |
| Shell paste | [Paste Capture Shell](./src/chess.js#paste-capture-shell) |
| Popup / PWA launch | [Popup and PWA Launch](./src/chess.js#popup-and-pwa-launch) |
| Remote opponent watch | [Remote Opponent Watch](./src/chess.js#remote-opponent-watch) |
| Rating discovery | [Federated Rating Discovery](./src/chess.js#federated-rating-discovery) |
| Leaderboard fetch | [Federated Leaderboard and Neighborhood Fetch](./src/chess.js#federated-leaderboard-and-neighborhood-fetch) |
| App → shell handlers | [Shell App Message Handlers](./src/chess.js#shell-app-message-handlers) |
| Factory export | [Factory Expand Export](./src/chess.js#factory-expand-export) |

### App orchestrator — [`src/chess-app.js`](./src/chess-app.js)

| Section | Link |
| ------- | ---- |
| Session / shell messenger | [Session Controller and Shell Messenger](./src/chess-app.js#session-controller-and-shell-messenger) |
| Survey UI factory | [Survey UI App Factory](./src/chess-app.js#survey-ui-app-factory) |
| Piece-set UI | [Piece Set Preferences and Pickers](./src/chess-app.js#piece-set-preferences-and-pickers) |
| New-game lifecycle | [New Game Setup Lifecycle](./src/chess-app.js#new-game-setup-lifecycle) |
| PWA session | [PWA Local Session and Materialize](./src/chess-app.js#pwa-local-session-and-materialize) |
| Local settings | [Local Settings and Preferences](./src/chess-app.js#local-settings-and-preferences) |
| Color theme | [Color theme (Bootstrap data-bs-theme)](./src/chess-app.js#color-theme-bootstrap-data-bs-theme) |
| Auth / viewer | [Auth Lock and Viewer Context](./src/chess-app.js#auth-lock-and-viewer-context) |
| Boot | [Boot and Document Ready](./src/chess-app.js#boot-and-document-ready) |
| Shell → app handlers | [App Shell Message Handlers](./src/chess-app.js#app-shell-message-handlers) |
| Journal / ghosts | [Journal Gateway and Ghost Sync](./src/chess-app.js#journal-gateway-and-ghost-sync) |
| Puzzle authoring entry | [Puzzle Authoring Entry](./src/chess-app.js#puzzle-authoring-entry) |
| View routing | [View Routing and Initialize Chess](./src/chess-app.js#view-routing-and-initialize-chess) |

### Federation — [`src/federation.js`](./src/federation.js)

Large file by design (fixed module set). Packages stay in one file; use banners + bottom namespaces (`Glicko`, `Gossip`, `Challenges`, `Crawl`, `SiteClient`).

| Section | Link |
| ------- | ---- |
| Glicko math | [Glicko Rating Math](./src/federation.js#glicko-rating-math) |
| Vs-Stockfish track | [Glicko Vs-Stockfish Personal Track](./src/federation.js#glicko-vs-stockfish-personal-track) |
| Twin audit | [TwinAudit Game Discovery](./src/federation.js#twinaudit-game-discovery) |
| Gossip / charm | [Gossip Checkpoints and Page Charm](./src/federation.js#gossip-checkpoints-and-page-charm) |
| Block list | [Gossip BlockList and Trusted Peers](./src/federation.js#gossip-blocklist-and-trusted-peers) |
| Challenges | [Challenges Open Seats and Accept](./src/federation.js#challenges-open-seats-and-accept) |
| Challenge lobby | [Challenges Discovery and Lobby](./src/federation.js#challenges-discovery-and-lobby) |
| Challenge display | [Challenges Display Helpers](./src/federation.js#challenges-display-helpers) |
| Leaderboard pages | [LeaderboardMeta Survey and Leaderboard Pages](./src/federation.js#leaderboardmeta-survey-and-leaderboard-pages) |
| Player discovery | [LeaderboardMeta Player Discovery](./src/federation.js#leaderboardmeta-player-discovery) |
| Ranking helpers | [LeaderboardMeta Ranking Table](./src/federation.js#leaderboardmeta-ranking-table) |
| Consensus replay | [Consensus Lazy Checkpoint and Audit Replay](./src/federation.js#consensus-lazy-checkpoint-and-audit-replay) |
| SURVEY item text | [LeaderboardMeta Survey Item Text](./src/federation.js#leaderboardmeta-survey-item-text) |
| Site client notes | [SiteClient PWA Bridge Notes](./src/federation.js#siteclient-pwa-bridge-notes) |
| Browser site client | [SiteClient Browser Wiki Fetch](./src/federation.js#siteclient-browser-wiki-fetch) |
| Crawl BFS | [Crawl Opponent Graph BFS](./src/federation.js#crawl-opponent-graph-bfs) |
| Consensus orchestrator | [Consensus Network Orchestrator](./src/federation.js#consensus-network-orchestrator) |
| Deferred enrich | [Crawl Deferred Site Survey Enrich](./src/federation.js#crawl-deferred-site-survey-enrich) |
| Job entry points | [Crawl Neighborhood Job Entry Points](./src/federation.js#crawl-neighborhood-job-entry-points) |
| Namespaces | [Namespace Exports](./src/federation.js#namespace-exports) |

### Board layout & transport — [`src/board-layout.js`](./src/board-layout.js)

| Section | Link |
| ------- | ---- |
| PWA detect / install | [PWA Detection and Install](./src/board-layout.js#pwa-detection-and-install) |
| Embed wheel | [Embed Wheel and Popup Metrics](./src/board-layout.js#embed-wheel-and-popup-metrics) · [Popup and PWA Window Sizes](./src/board-layout.js#popup-and-pwa-window-sizes) |
| Board fit | [Board Fit and Resize](./src/board-layout.js#board-fit-and-resize) · [Drawer Open Memory](./src/board-layout.js#drawer-open-memory) |
| Modal mount | [Wiki Iframe Modal Mount](./src/board-layout.js#wiki-iframe-modal-mount) |
| Paste | [Paste Capture](./src/board-layout.js#paste-capture) |
| PWA lifecycle | [PWA and Popup Lifecycle](./src/board-layout.js#pwa-and-popup-lifecycle) |
| Page title chrome | [PWA Page Title Chrome](./src/board-layout.js#pwa-page-title-chrome) |
| HTTP bridge client | [PWA HTTP Bridge](./src/board-layout.js#pwa-http-bridge) |
| Wiki transport | [Wiki Transport](./src/board-layout.js#wiki-transport) |
| Namespaces | [Namespace Exports](./src/board-layout.js#namespace-exports) |

### GAME mode — [`src/game.js`](./src/game.js)

| Section | Link |
| ------- | ---- |
| Host accessors | [Host Accessors and App Proxy](./src/game.js#host-accessors-and-app-proxy) |
| Seats / console | [Console Init and Seat Claim](./src/game.js#console-init-and-seat-claim) |
| Stockfish toolbar | [Stockfish Toolbar and Engine Moves](./src/game.js#stockfish-toolbar-and-engine-moves) |
| Start-game modal | [Start Game and Position Modal](./src/game.js#start-game-and-position-modal) |
| Challenge banner | [Open Challenge Banner](./src/game.js#open-challenge-banner) |
| Result / resign | [Game Result Banner and Resignation](./src/game.js#game-result-banner-and-resignation) |
| Player bars | [Player Bar HTML and Labels](./src/game.js#player-bar-html-and-labels) |
| Export / pass-and-play | [Export Share and Pass and Play](./src/game.js#export-share-and-pass-and-play) |
| Autosave wire | [Journal Autosave Wiring](./src/game.js#journal-autosave-wiring) |
| Move comments UI | [Move Comments and Annotation Panel](./src/game.js#move-comments-and-annotation-panel) |
| Console create | [Console Create and Board Init](./src/game.js#console-create-and-board-init) |

### Other app modules

| Module | Highlights |
| ------ | ---------- |
| [`realtime.js`](./src/realtime.js) | [Game Sync Coordinator](./src/realtime.js#game-sync-coordinator) · [Remote Move Validation](./src/realtime.js#remote-move-validation) · [Remote Watch and Poll](./src/realtime.js#remote-watch-and-poll) · [WebRTC Peer Channel](./src/realtime.js#webrtc-peer-channel) · [Shell SET STATE Sync](./src/realtime.js#shell-set-state-sync) |
| [`puzzle.js`](./src/puzzle.js) | [Puzzle Pool and Solver State](./src/puzzle.js#puzzle-pool-and-solver-state) · [Puzzle Authoring](./src/puzzle.js#puzzle-authoring) · [Puzzle Mode UI](./src/puzzle.js#puzzle-mode-ui) · [Puzzle Sources](./src/puzzle.js#puzzle-sources) · [Installed PWA Local Puzzle Database](./src/puzzle.js#installed-pwa-local-puzzle-database) |
| [`survey.js`](./src/survey.js) | [Federation Sync Loop](./src/survey.js#federation-sync-loop) · [IndexedDB Rating Store](./src/survey.js#indexeddb-rating-store) · [Rating Helpers](./src/survey.js#rating-helpers) · [Stockfish Calibration](./src/survey.js#stockfish-calibration) · [First Game Recovery](./src/survey.js#first-game-recovery) · [Rating Entry Points](./src/survey.js#rating-entry-points) · [Finalize Control](./src/survey.js#finalize-control) · [Leaderboard Browse Shell](./src/survey.js#leaderboard-browse-shell) · [Leaderboard Entry Points](./src/survey.js#leaderboard-entry-points) · [Open Challenges Lobby](./src/survey.js#open-challenges-lobby) |
| [`leaderboard.js`](./src/leaderboard.js) | [Opt In Gate](./src/leaderboard.js#opt-in-gate-and-federated-entry-points) · [Hop Graph Dials](./src/leaderboard.js#visible-federation-hop-graph-dials) · [Past Opponents Neighbourhood Promotion](./src/leaderboard.js#past-opponents-neighbourhood-promotion) · [Ranking Table](./src/leaderboard.js#federated-ranking-table-and-layout) |
| [`modals.js`](./src/modals.js) | [Modal Stack](./src/modals.js#modal-stack-and-mount-restore) · [Auth Gated Controls](./src/modals.js#auth-gated-controls) · [Confirm and Paste](./src/modals.js#confirm-and-paste-modals) · [Challenge and Seat](./src/modals.js#challenge-and-seat-modals) · [Puzzle and Leaderboard Modals](./src/modals.js#puzzle-and-leaderboard-modals) |
| [`choose-menu.js`](./src/choose-menu.js) | [Init and Menu Chrome Sync](./src/choose-menu.js#init-and-menu-chrome-sync) · [Return Resume and Cancel Navigation](./src/choose-menu.js#return-resume-and-cancel-navigation) · [Mode Switches](./src/choose-menu.js#mode-switches) |
| [`position.js`](./src/position.js) | [Init and Board Lifecycle](./src/position.js#init-and-board-lifecycle) · [FEN Input Sync and Live Edit Guard](./src/position.js#fen-input-sync-and-live-edit-guard) · [Save Flip and Mode Entry](./src/position.js#save-flip-and-mode-entry) |
| [`cm-modules-bundle.js`](./src/cm-modules-bundle.js) | Chess-console / cm-\* wiki glue ([Bundle Re Exports](./src/cm-modules-bundle.js#bundle-re-exports)) |
| [`glicko-worker.js`](./src/glicko-worker.js) | [Worker Message Handler](./src/glicko-worker.js#worker-message-handler) |

## Server

| Module | Highlights |
| ------ | ---------- |
| [`server/puzzle-server.js`](./server/puzzle-server.js) | [Pure Helpers](./server/puzzle-server.js#pure-helpers) · [Database Build Pipeline](./server/puzzle-server.js#database-build-pipeline) · [Random Puzzle Serving](./server/puzzle-server.js#random-puzzle-serving) · [Plugin Entry Point](./server/puzzle-server.js#plugin-entry-point) |
| [`server/pwa-bridge.js`](./server/pwa-bridge.js) | [Request Helpers](./server/pwa-bridge.js#request-helpers-and-indexeddb-payload) · [PWA Site Client Factory](./server/pwa-bridge.js#pwa-site-client-factory) · [Journal Routes](./server/pwa-bridge.js#journal-routes) · [Federation Crawl Routes](./server/pwa-bridge.js#federation-crawl-routes) |
| [`server/server.js`](./server/server.js) | [Plugin Server Entry](./server/server.js#plugin-server-entry) |

## Organization rules (summary)

- Keep the **fixed module set** in [src/README.md](./src/README.md); extend an existing file instead of adding one-off helpers.
- Prefer **cohesive namespaces** (`ChessRules`, `Paste`, `Journal`, `Glicko`, `PWA`, `Transport`, …) over scattered free functions.
- Partition large files with `// # Section Name` / `// ## Sub-section Name` and **map new sections here** with relative `#anchor` links.
- Edit `src/` and `server/` sources; never hand-edit built `client/*.js` bundles.

## Non-negotiables

- No analytics/telemetry.
- Bare keywords (`GAME` / `POSITION` / `PUZZLE` / `CHOOSE`) must not autosave on page load — only after user action.
- Shell context key: `${pageKey}/${item.id}` (not item id alone).
- App boot: `whenDocumentReady()` in chess-app ([Boot and Document Ready](./src/chess-app.js#boot-and-document-ready)).
