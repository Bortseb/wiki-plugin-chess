# Scripts

Node tooling for **wiki-plugin-chess**. npm scripts stay host/publish-facing (`build`, `test`, `prepublishOnly`); everything else is run with `node` directly.

## Layout

| File / folder                  | Role                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `build-client.js`              | Production build — esbuild bundles, Sass, Stockfish copy, cache-bust (`npm run build`)       |
| `dev-tools.js`                 | **Single CLI entry** for developer commands                                                  |
| `league/`                      | Rated-season simulator — seed writes `~/.wiki` demo pages; validate runs Monte Carlo metrics |
| `league/index.js`              | League seed + validate logic (imports plugin `src/federation.js` Glicko-2)                   |
| `league/engine-pool.js`        | Parallel Stockfish pool for seeding                                                          |
| `league/seed-engine-worker.js` | Forked child for one engine (must stay separate — WASM + `fork()`)                           |
| `pwa-icons.js`                 | Generate chess-themed PWA PNGs under `client/`                                               |

Chess Academy garden tooling (if present) lives under gitignored `chess-learning-site/` — see that folder’s README.

## npm scripts (host / publish)

```bash
npm run build    # test + build-client.js
npm test         # node:test suites
```

`prepublishOnly` runs `build` automatically on publish.

## Developer CLI

```bash
node --no-warnings scripts/build-client.js --cm-bundle-only   # cm-modules bundle only
node scripts/dev-tools.js league seed --players=28 --rounds=8
node scripts/dev-tools.js league validate --players=400
node scripts/dev-tools.js authors
node scripts/dev-tools.js pwa-icons
```

To wipe built client artifacts before a full rebuild, remove the outputs listed in `build-client.js` (or delete `client/chess*.js`, `client/cm-modules-bundle.js*`, `client/glicko-worker.js*`, copied Stockfish assets, and `client/assets/styles/cm-modules.css*`), then `npm run build`.

## Flags

### `league seed`

Writes a rated demo season to `~/.wiki` (Stockfish by default).

| Flag                  | Default              | Description                                                                                           |
| --------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `--players=N`         | `28`                 | Roster size (clamped 2–100). Omit for the classic cohort.                                             |
| `--rounds=N`          | `8`                  | Season length (each player plays `games-per-round` games/round).                                      |
| `--games-per-round=N` | `3`                  | Pairing passes per round.                                                                             |
| `--islands=N`         | `1`                  | Split the roster into N islands. Each island runs an Island Cup; a subset also plays one global Open. |
| `--bridges=N`         | `1`                  | Rated bridge games between each adjacent island (chain 0↔1↔2…). `0` = fully disconnected islands.   |
| `--global-share=N`    | `0.55`               | Fraction of each island that also enters the global Open (rest = local-only). Islands>1 only.         |
| `--sparse-islands=N`  | `1`                  | How many non-hub islands get a thinned Island Cup + fewer friendlies (sparser edges).                 |
| `--sparse-factor=N`   | `0.4`                | Round / games-per-round multiplier on sparse islands (0.2–1).                                         |
| `--bad-actors=N`      | `0`                  | Randomize N bad-actor hosts (never Rob); everyone else distrusts them. Alias: `--cheaters=N`.         |
| `--seed=N`            | `1`                  | PRNG seed (reproducible runs).                                                                        |
| `--port=N`            | `3001`               | Local farm port used in site hostnames.                                                               |
| `--wiki-root=PATH`    | `~/.wiki`            | Wiki farm data root.                                                                                  |
| `--engines=N`         | CPU count − 2 (1–16) | Parallel Stockfish workers.                                                                           |
| `--engine-ms=N`       | `24`                 | Per-move think time in ms (min 5).                                                                    |
