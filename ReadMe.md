<!-- For a friendly, guided walkthrough of this system, see GUIDED_TOUR.md -->

# Federated Wiki Chess Plugin

Looking for the code layout? Check out our [Architecture & Navigation Map](./ARCHITECTURE.md).

Play and record chess games directly on [Federated Wiki](http://fed.wiki) pages. Each game lives in a wiki [item](http://glossary.asia.wiki.org/view/item) as standard [PGN](https://en.wikipedia.org/wiki/Portable_Game_Notation), so moves are stored in the page's [journal](http://glossary.asia.wiki.org/journal.html) and travel with the page across the federation. You can play against the built-in [Stockfish engine](https://github.com/nmrugg/stockfish.js), study a position with the [FEN editor](https://github.com/shaack/cm-fen-editor), or play another person across wikis — claim an open seat (White or Black) on a forked page and continue the game from your own copy. A popup window gives you a larger board that stays in sync with the page and can be installed as a [PWA](https://en.wikipedia.org/wiki/Progressive_web_app) for offline play. (Source: [NPM](https://www.npmjs.com/package/wiki-plugin-chess))

The first word of a chess item's text can be a keyword that chooses a mode of play to switch to. Otherwise the text is parsed as PGN, FEN, or figurine notation. If the item's text is unrecognizable, a menu appears so you can choose how to proceed.

## KEYWORDS:

`CHOOSE` - puts a menu in the chess item to pick which game mode to switch to.

`GAME` - starts a new game with the settings of your choice. Edits to the game are stored as PGN in the chess item text, and actions in the wiki journal.

`POSITION` - opens the FEN position editor.

`PUZZLE` - opens the chess puzzle mode. When online, puzzles are drawn from your wiki farm's shared database (if the farm operator enabled it) or the [Lichess puzzle API](https://database.lichess.org/#puzzles). Active filters (rating, popularity, themes, tags) show in the puzzle header and can be set in item text — see Chess Keyword Examples. A single item can combine those filters with inline JSONL puzzles and `pages=` references to other wiki pages; the first inline puzzle leads the lesson, then **New Puzzle** alternates matching curated and farm/Lichess draws. For **teaching**, a referenced page may host one larger annotated **PGN** (`[FEN]` + mainline `{comments}` + variation comments as soft coaches). Solving does not write the journal unless you opt into **Add to My Training Log** / **Certify Completion**. If you install Federated Wiki Chess as a PWA from the popup window, you can optionally download a copy of the puzzle database to your device for offline play.

`SURVEY` - a chess item with this keyword is on your **My Chess Games** page by default. It helps you track completed and ongoing chess games on your site. Federation **open challenges** are game pages with one open seat; challenge config lives in PGN tags (`MinRating`, `MaxRating`, `ChallengeTarget`, `ChallengeTs`, `CreatorRating`, `ChallengeCreator`, `CreatorColor`). `ChallengeTarget` may be blank for an open federation seek.

`LEADERBOARD` - on the **Chess Leaderboards** page (`chess-leaderboards`). Opens the federated rankings view. Federation gossip (`checkpoint`, `trustedPeers`) lives in hidden `page.chess` metadata — the visible story holds only the keyword item.

---

If you play while signed in to your wiki, moves autosave to the journal (There is a game setting to turn on a move confirmation step if you prefer). You can open the chess app in a larger popup window that stays in sync with the wiki page. You can play in either place and the item text updates on your wiki page. You can install Federated Wiki Chess as a Progressive Web App (PWA) from the popup window for offline play. Fork another wiki's page with a chess game to your site and you can take a seat as White or Black if you are not already a player, then continue from your copy. If both players keep forks of each other's pages, they can play correspondence by watching for updates on each other's sites. When both players enable the game setting to auto-fork each other's moves, the app can upgrade to a direct WebRTC link for real-time play; the journal still records every move.

When you paste text onto the chess app interface (including in a popup or installed PWA), it's parsed to see if it's PGN, FEN, or figurine notation. If the paste is identified as chess data, you are asked if you want to switch to the corresponding mode (GAME, POSITION).

PGN has many "tags" but the `White` and `Black` tags, representing the players, are important to how Federated Wiki Chess works. Each wiki player is identified by their wiki domain in the tag. The name in parentheses is the display name from their site (Which can change). The domain of the site that created the game, with the chess item's ID in brackets, is stored in the `Site` tag.

## Ratings (Glicko-2)

Player ratings use **Glicko-2** (not flat Elo) because federation games are sparse, irregular, and decentralized — each wiki is independent and games are discovered by crawling, not fetched from one server.

Implementation: [federation.js](./src/federation.js) (Glicko-2 + SURVEY crawl/leaderboard/twin audit), [survey.js](./src/survey.js) (IndexedDB ratings, site-survey / open-challenge UI), [leaderboard.js](./src/leaderboard.js) (federated leaderboard gate/table), [game.js](./src/game.js) (player bars).

Each player tracks three numbers: **rating** (`r`), **rating deviation** (`RD` = uncertainty), and **volatility** (`σ`). High RD shows a `?` marker (provisional).

**Everyone starts at 1500.** New players begin at the neutral Glicko-2 prior (`r = 1500`, max RD). There is no self-estimate questionnaire and no engine/puzzle seeding of the federated rating.

**Twin-verified leaderboard.** The ranked board recomputes from games that exist as reconciling records on _both_ players' wikis. One-sided publishes do not count.

**Separate engine track.** A personal vs-Stockfish rating (`engine` field in IndexedDB) updates on every engine game but is never federated or ranked.

**Well-known federation pages.** `my-chess-games` carries a bare `SURVEY` item; `chess-leaderboards` carries `LEADERBOARD`. Federation gossip (`checkpoint`, `trustedPeers`) is stored directly in `page.chess` — not duplicated as journal noise. Open seeks are ordinary game pages whose PGN carries the challenge tags; pending seeks are also indexed on the SURVEY item’s `openChallenges` metadata until accepted.

Further reading: [Glickman's Glicko-2 example (PDF)](https://www.glicko.net/glicko/glicko2.pdf).

## Puzzles

**Client:** [puzzle.js](./src/puzzle.js) drives the board UI and bulk CSV parsing; [chess-core.js](./src/chess-core.js) holds `parsePuzzleRow`, puzzle spec/filters, and `isPuzzleRow` matching (server-safe, shared with tests).

The puzzle mode works out of the box via the online [Lichess puzzle API](https://lichess.org/api) when you have a connection.

#### Shareable filtered and annotated puzzle banks

A `PUZZLE` item can be a small, evolving curriculum rather than one fixed board. Put pool settings on its first line, then add zero or more custom puzzles as **JSONL** (one complete JSON object per physical line):

```text
PUZZLE RANDOM rating=800..1400 themes=fork,pin pages=the-fork,my-annotated-forks
{"id":"club-fork-1","fen":"4k3/8/8/3N4/8/8/8/4K3 w - - 0 1","moves":["d5c7"],"rating":900,"themes":["fork"],"tags":["club-study"],"prompt":"Fork the king and the loose piece.","source":"custom","noSetup":true}
{"id":"game-2026-07-17","fen":"...","moves":["e4e5","g1f3"],"rating":1100,"themes":["fork"],"tags":["old-game"],"gameUrl":"..."}
```

- `RANDOM` skips the chooser. `rating=`, `popularity=`, and Lichess `themes=` filter every source. Multiple themes are OR matches.
- `tags=` filters author-defined JSONL tags. Use Lichess theme ids in `themes` when a custom puzzle should mix with Lichess results.
- The first matching inline puzzle opens first. Later draws alternate between curated puzzles and the farm/on-device/Lichess pool when network-compatible filters are present.
- `pages=slug-one,slug-two` loads chess items from those pages on the current wiki. A referenced item may contain JSONL/CSV puzzles or one fully annotated teaching PGN. References are one level deep, so pages cannot create loops.
- Missing referenced pages do not break the bank. When sharing or forking a curriculum through the federation, fork its referenced pages too if you want those annotations to travel with it.

JSONL fields:

- Required: `fen` and `moves` (UCI coordinates such as `d5c7`; one or more moves).
- Recommended: a stable `id`, Lichess-compatible `themes`, `rating`, and a short `prompt`.
- Optional: `tags`, `popularity`, `gameUrl`, `openingTags`, and `noSetup`.
- Set `noSetup: true` when the learner moves immediately from the supplied FEN. Odd-length move lists infer this automatically. Lichess-style even-length lists normally begin with the opponent’s setup move.

Positions from old games can be curated by saving the position before the tactic as `fen`, converting the continuation to UCI `moves`, and retaining the source in `gameUrl` or an author tag. Keep each JSON object on one line so the chess item remains valid JSONL and easy to copy between wikis.

#### Farm database (shared, server-side)

Wiki farms can opt in to hosting the [Lichess open puzzle database](https://database.lichess.org/#puzzles) (CC0) once on the server instead of relying on the live API for every puzzle draw. The farm does **not** download or serve the shared database unless an operator enables it in wiki config — there is no in-app admin toggle.

**How to enable (farm operators):**

1. Edit the wiki **`config.json`** that your farm process reads.
2. Set **`chess.puzzleDatabase`** to the boolean **`true`** (a string `"true"` does not enable the database).

```json
  "chess": {
    "puzzleDatabase": true
  }
```

3. **Restart** the wiki process so the chess server plugin picks up the change.
4. On first start with the flag enabled, the plugin downloads the full database (~300 MB compressed, ~1 GB indexed) into the plugin's **server** directory: `wiki-plugin-chess/server/` (under your farm's `node_modules` or package install path). Every site on the farm then draws puzzles from `/plugin/chess/puzzle` — one copy on disk, no per-user duplication.
5. **Verify:** `GET /plugin/chess/config` returns `puzzleDatabase.enabled: true`. While installing, `status` is `downloading`, `decompressing`, or `indexing`; when ready, `ready: true` and `puzzles` shows the indexed count. Server logs print `chess: plugin ready (puzzle DB: enabled)`.

With the flag absent or `false`, clients use the Lichess API when online; if neither source works, a dialog explains why.

#### HTTPS farms (production)

Serve Federated Wiki over **HTTPS** in production. The chess PWA, service worker, and Clipboard APIs require a secure context (localhost remains allowed for development).

**Reverse proxy:** if TLS terminates at nginx, Caddy, or a load balancer, forward **`X-Forwarded-Proto: https`** (and the correct `Host`) to the wiki process. The chess install manifest builds its origin from that header so Chrome’s install / “already installed” checks stay on `https://…`.

**Session cookies:** set wiki-server **`secure_cookie: true`** on HTTPS farms so the session cookie is `wikiTlsSession` with Secure/proxy-safe flags. Without it, signed-in owner auth can fail or behave inconsistently behind TLS.

## How the code fits together

The plugin is **three runtimes** with shared pure modules (`chess-core.js`, `federation.js`):

```
Wiki page (shell)                 iframe / popup / PWA (client/index.html)
┌─────────────────┐                 ┌──────────────────────────────────────────┐
│ src/chess.js    │  ─ postMessage ►│ src/chess-app.js (orchestrator)          │
│ iframe, journal │ ◄────────────── │  + game, survey, puzzle, choose-menu,    │
│ cross-wiki crawl│                 │    position, leaderboard                 │
└────────┬────────┘                 │  + board-layout (transport, PWA chrome)  │
         │                          │  + realtime (sync, WebRTC)               │
         │ glicko-worker.js         │  + cm-modules-bundle (board UI)          │
         ▼                          └──────────────────────────────────────────┘
Wiki server (optional)
┌─────────────────────────────┐
│ server/puzzle-server.js     │  farm puzzle DB + STUN config
│ server/pwa-bridge.js        │  installed-PWA HTTP bridge (journal, crawl)
└─────────────────────────────┘
```

**Shell ↔ app:** action names in [`chess-core.js`](./src/chess-core.js) (`MSG`). Same-origin `postMessage` only (`window.origin`).

**App → shell traffic:** submodules call typed [`wiki.*`](./src/board-layout.js) helpers via `shellMessengerFromContext` / `createShellMessenger` in [`board-layout.js`](./src/board-layout.js); [`chess-app.js`](./src/chess-app.js) supplies the orchestrator-only enriched `postToShell`. Payload enrichment and dispatch also live there (`enrichTransport`, `sendTransport`, `shellTransport`). Installed PWA without a wiki parent uses the HTTP bridge in [`server/pwa-bridge.js`](./server/pwa-bridge.js).

**Journal saves:** shell [`chess.js`](./src/chess.js) funnels through `applyChessJournalSave` into the journal planner and page reducer in [`chess-core.js`](./src/chess-core.js). [`federation.js`](./src/federation.js) owns only federation-specific `page.chess` charm/gossip operations.

**Cross-wiki fetch:** shell only — [`createBrowserWikiSiteClient`](./src/federation.js) in the wiki embed; `createPwaBridgeSiteClient` on the server for the PWA bridge.

**Game sync:** pure policy in `chess-core.js`; coordinator gates in [`realtime.js`](./src/realtime.js) (`applySyncedPosition`, remote poll, WebRTC).

Mirror-popup routes relay `REQUEST_RESIGN`, `REQUEST_SWITCH_GAME_MODE`, and `REQUEST_OPEN_POSITION_EDITOR` iframe ↔ popup.

Module map (pillars, LOC, neighborhood / IndexedDB storage): [src/README.md](./src/README.md). For a narrative developer walkthrough, see [GUIDED_TOUR.md](./GUIDED_TOUR.md).

## Item text quick reference

| Item text                                                         | Result                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| _(empty)_                                                         | Start menu in iframe                                                   |
| `CHOOSE`                                                          | Start menu in iframe (explicit)                                        |
| `GAME`                                                            | New game vs Stockfish                                                  |
| `POSITION`                                                        | FEN position editor                                                    |
| `PUZZLE`                                                          | Puzzle Mode; shows the filter chooser first                            |
| `PUZZLE RANDOM`                                                   | Puzzle Mode; draws a puzzle immediately                                |
| `PUZZLE RANDOM rating=1500..2000 popularity=50.. themes=fork,pin` | Draw immediately with filters                                          |
| `PUZZLE RANDOM themes=pin pages=the-pin` + JSONL lines            | Mixed curated + farm/Lichess bank; first inline puzzle leads            |
| `PUZZLE` + annotated PGN                                          | Teaching puzzle: comments + variations coach tries                     |
| `SURVEY`                                                          | Site survey on **My Chess Games** (open seeks + rated + unrated lists) |
| `LEADERBOARD`                                                     | Federated rankings on **Chess Leaderboards**                           |
| FEN string                                                        | Position editor with that FEN                                          |
| PGN with headers                                                  | Playable game                                                          |
| Figurine diagram                                                  | Converted to FEN                                                       |

# Development

### Source module map

Full module table, pillars, and postMessage routing: [src/README.md](./src/README.md).

Shipped starter wiki pages live in [pages/](./pages/) (`my-chess-games`, `chess-leaderboards`, `chess-keyword-examples`, `about-chess-plugin`). See [GUIDED_TOUR.md Ch. 11](./GUIDED_TOUR.md) for developer context.

**Non-negotiables:** no analytics/telemetry; bare keywords (`GAME` / `POSITION` / `PUZZLE` / `CHOOSE`) must not autosave on page load; shell context key is `${pageKey}/${item.id}`; app boot uses `whenDocumentReady()` in `chess-app.js`. Edit `src/`, never hand-edit built `client/*.js` bundles. Ask before adding new files under `src/` (15-module map in [src/README.md](./src/README.md)).

### Tests (`test/`)

| Test                          | Covers                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `architecture-guards.test.js` | 15-module invariant, PWA protocol SSOT, journal gateway wiring, cross-module SSOT                 |
| `build-client.test.js`        | esbuild bundle guards                                                                             |
| `chess-app.test.js`           | Built bundle guards, submodule `wiki.*` routing, player bar HTML in game.js                       |
| `chess-core.test.js`          | Item text, paste, remote moves, puzzles, session FSM, game-sync policy                            |
| `federation.test.js`          | Glicko-2, twin audit, challenge gates, federation consensus                                       |
| `board-layout.test.js`        | Embed wheel, popup metrics, `shellTransport`, `createShellMessenger`, `shellMessengerFromContext` |
| `modals.test.js`              | Modal mount restore / stacking                                                                    |
| `chess-shell.test.js`         | Shell journal helpers (`stripChessItemGhostFlag`, `mapChessSaveActionsForJournal`)                |
| `pwa-bridge.test.js`          | Page reducer, join-challenge materialize, federation crawl, site client `getPage` / `listSlugs`   |
| `puzzle-server.test.js`       | Farm puzzle DB helpers, STUN config                                                               |
| `league-seed.test.js`         | Default wiki pages vs `federation.js` templates                                                   |

Run `npm test` from the plugin root (`test/run.test.js` imports all suites).

## Chess libraries (upstream)

Third-party chess UI code is **not vendored in git**. After `npm install`, `npm run build` bundles npm packages with wiki glue in `src/cm-modules-bundle.js` into `client/cm-modules-bundle.js`.

| Library                                                                      | Role                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [chess-console](https://github.com/shaack/chess-console)                     | In-browser game framework                                          |
| [cm-chessboard](https://github.com/shaack/cm-chessboard)                     | SVG board (via chess-console)                                      |
| [cm-engine-runner](https://github.com/shaack/cm-engine-runner)               | UCI engine worker bridge                                           |
| [cm-fen-editor](https://github.com/shaack/cm-fen-editor)                     | Position setup / FEN editor                                        |
| [cm-web-modules](https://github.com/shaack/cm-web-modules)                   | Shared utilities                                                   |
| [chess-console-stockfish](https://github.com/shaack/chess-console-stockfish) | Stockfish player glue (npm re-export)                              |
| Stockfish WASM                                                               | `client/assets/js/stockfish-18-lite-single.js` + `.wasm` (GPL-3.0) |

**Wiki glue** (`src/cm-modules-bundle.js`) — single esbuild entry with Staunty sprites, history/captured widgets, Stockfish UI, and chess-console prototype patches; never edit `node_modules/`.

### Upgrading cm-\* packages

1. Check release notes for chess-console, cm-fen-editor, cm-engine-runner.
2. Bump versions in root `package.json` **together**: `chess-console`, `chess-console-stockfish`, `cm-engine-runner`, and `cm-web-modules` must stay aligned (Stockfish 18 cluster).
3. `npm install && npm run build && npm test`
4. Smoke-test in wiki: CHOOSE → Stockfish game, POSITION editor, federated lineup, paste PGN/FEN.

`StockfishPlayer` comes from npm unchanged. The consolidated `cm-modules-bundle.js` includes wiki rewrites for engine UI and patches vendored prototypes at bundle load; re-verify after bumps. Rebuild glue only: `node --no-warnings scripts/build-client.js --cm-bundle-only`.

## Build commands

```bash
npm install
npm run build          # test + bundle cm-modules, shell, and app
npm test               # node:test (all suites under test/)
```

Extra developer tooling (league seed/validate, authors, PWA icons, partial rebuilds) is invoked with `node scripts/…` — see `scripts/README.md`. **`dev-tools.js` is the single CLI entry** for those commands.

The **league & ratings system** lives in `scripts/league/` — `seed` writes demo wiki pages to `~/.wiki`; `validate` runs a large in-memory season and prints accuracy/calibration metrics. Both use the same Glicko-2 engine as the plugin. Stockfish parallelism uses `engine-pool.js` and `seed-engine-worker.js` (must stay separate — the seeder `fork()`s one OS process per engine, and Stockfish WASM cannot run in `worker_threads`).

**Built `client/chess.js`, `client/chess-app.js`, and `client/cm-modules-bundle.js` are gitignored** — run `npm run build` after clone or before publishing (`prepublishOnly` runs it automatically).

## Developing with a local wiki

Link the plugin into your wiki package.json:

```json
"wiki-plugin-chess": "../wiki-plugin-chess"
```

Run `npm install && npm run build` in the plugin repo, then run the wiki. Hard-refresh after plugin changes.

## Deploying

For testing before installing to wiki with Plugmatic.

**Always build first.** `client/*.js` is esbuild output — a stale `client/` is the #1 cause of a blank board.

```bash
npm run build && npm test
npm pack    # → wiki-plugin-chess-<version>.tgz
```

Install the tarball into the wiki's `node_modules/wiki-plugin-chess` (path varies by image), then restart the wiki process. On a **farm**, install once — every site on the farm gets the plugin.

## License

**Federated Wiki Chess** (`wiki-plugin-chess`) is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [`LICENSE`](./LICENSE) file for the full license text.

### Third-party components

Bundled and runtime dependencies keep their own copyrights and licenses (typically MIT, Apache-2.0, BSD, ISC, CC0, Font Awesome’s CC BY 4.0 / SIL OFL 1.1 / MIT mix, Stockfish under **GPL-3.0**, and some piece sets under GPL/AGPL/CC). The MIT license applies to this plugin’s original code; third-party material remains under its upstream terms. UI credit lives in **Attributions and Thanks** in the chess app (`client/index.html`).

**Full redistribution notices:** [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) lists shipped libraries and includes the standard MIT license text used by many bundled dependencies.

**Piece sets:** board graphics use committed SVG sprite sheets in `client/assets/pieces/` (Merida default). See attributions in the app.

**GitHub:** set the repository **License** field to **MIT License** so it matches `package.json` (`MIT`).
