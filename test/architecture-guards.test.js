/** Static architecture and build guard checks. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('guards · architecture', () => {
  it('src/ contains exactly 15 JavaScript modules', () => {
    const count = readdirSync(join(root, 'src')).filter(f => f.endsWith('.js')).length
    assert.equal(count, 15)
  })

  it('position.js owns POSITION FEN-editor mode and does not import chess-app', () => {
    const pos = readFileSync(join(root, 'src/position.js'), 'utf8')
    const app = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    const game = readFileSync(join(root, 'src/game.js'), 'utf8')
    assert.match(pos, /export function initPosition\(/)
    assert.match(pos, /export function isPositionEditorMode\(/)
    assert.match(pos, /export function shouldPreserveLivePositionEdits\(/)
    assert.match(pos, /export function savePositionToWiki\(/)
    assert.match(pos, /export function startPositionFromMenu\(/)
    assert.match(pos, /ensurePositionEditorBoard/)
    assert.match(pos, /reloadFenEditorPieceSet/)
    assert.doesNotMatch(pos, /from ['"]\.\/chess-app\.js['"]/)
    assert.doesNotMatch(pos, /function wirePositionEditor\(/)
    assert.match(app, /from ['"]\.\/position\.js['"]/)
    assert.match(app, /initPosition\(/)
    assert.match(game, /export function wirePositionEditor\(/)
    assert.match(app, /wirePositionEditor/)
  })

  it('game.js owns GAME mode UI and does not import chess-app', () => {
    const game = readFileSync(join(root, 'src/game.js'), 'utf8')
    const app = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(game, /export function initGame\(/)
    assert.match(game, /export async function createWikiChessConsole\(/)
    assert.match(game, /export function finishGameBoardInit\(/)
    assert.match(game, /export function startNewGameFromMenu\(/)
    assert.match(game, /export function playerBarHtml\(/)
    assert.match(game, /export function wirePositionEditor\(/)
    assert.doesNotMatch(game, /from ['"]\.\/chess-app\.js['"]/)
    assert.doesNotMatch(game, /postToShell\(\{\s*action:\s*MSG\./)
    // commentCtx exposes chessConsole directly — commentCtx.app throws and aborts
    // finishGameBoardInit on Academy / [Comments "on"] pages (settings stay hidden).
    assert.doesNotMatch(game, /commentCtx\.app\b/)
    assert.match(app, /from ['"]\.\/game\.js['"]/)
    assert.match(app, /initGame\(/)
    assert.doesNotMatch(app, /function createWikiChessConsole\(/)
    assert.doesNotMatch(app, /function playerBarHtml\(/)
  })

  it('leaderboard.js owns federated UI via one-way import and survey hooks', () => {
    const lb = readFileSync(join(root, 'src/leaderboard.js'), 'utf8')
    const survey = readFileSync(join(root, 'src/survey.js'), 'utf8')
    const app = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(lb, /export function initLeaderboardUi\(/)
    assert.match(lb, /export function openLeaderboardFromChooseMenu\(/)
    assert.match(lb, /export function showLeaderboardBoardForItem\(/)
    assert.match(lb, /export function handleSurveyState\(/)
    assert.match(lb, /registerLeaderboardUi\(/)
    assert.match(lb, /from ['"]\.\/survey\.js['"]/)
    assert.doesNotMatch(lb, /from ['"]\.\/chess-app\.js['"]/)
    assert.match(survey, /export function registerLeaderboardUi\(/)
    assert.match(survey, /leaderboardUi\?\.renderStanding/)
    assert.match(survey, /leaderboardUi\?\.renderLbTable/)
    assert.match(survey, /leaderboardUi\?\.renderHopGraphPanel/)
    assert.doesNotMatch(survey, /from ['"]\.\/leaderboard\.js['"]/)
    assert.doesNotMatch(survey, /function renderStanding\(/)
    assert.doesNotMatch(survey, /function renderLbTable\(/)
    assert.doesNotMatch(survey, /function renderHopGraphPanel\(/)
    assert.match(app, /from ['"]\.\/leaderboard\.js['"]/)
    assert.match(app, /initLeaderboardUi\(/)
  })

  it('service-worker.js passes node syntax check', () => {
    execSync('node --check client/service-worker.js', { cwd: root, stdio: 'pipe' })
  })

  it('board-layout defines PWA protocol helpers and index.html boots early', () => {
    const layout = readFileSync(join(root, 'src/board-layout.js'), 'utf8')
    const index = readFileSync(join(root, 'client/index.html'), 'utf8')
    assert.match(layout, /export const PWA_BRIDGE_BASE/)
    assert.match(layout, /export function ensurePwaProtocol/)
    assert.match(layout, /export function registerChessServiceWorker/)
    assert.match(layout, /export function matchInstalledChessPwa/)
    assert.match(layout, /export function initInstallNudge/)
    assert.match(layout, /export async function queryChessPwaInstalled/)
    assert.match(index, /href="\/plugins\/chess\/manifest\.json"/)
    assert.match(index, /href="icon-120\.png"/)
    assert.doesNotMatch(index, /createObjectURL/)
    assert.match(index, /wiki-chess-sw-ready-reload/)
    assert.match(index, /navigator\.serviceWorker[\s\S]*register\('\/plugins\/chess\/service-worker\.js'/)
    assert.doesNotMatch(index, /type="module"[\s\S]*register\('\/plugins\/chess\/service-worker\.js'/)
    assert.match(index, /wiki-chess-pwa-installed:/)
    const chessApp = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(chessApp, /initInstallNudge\(\)/)
    assert.doesNotMatch(layout, /from '\.\.\/client\/pwa-protocol\.js'/)
  })

  it('server builds an installable host-specific manifest with site favicon icons', () => {
    const src = readFileSync(join(root, 'server/pwa-bridge.js'), 'utf8')
    assert.match(src, /export function buildChessInstallManifest/)
    assert.match(src, /export function chessInstallManifestIcons/)
    assert.match(src, /export function resolveWikiFaviconPath/)
    assert.match(src, /export function wikiFaviconRevision/)
    assert.match(src, /\/favicon\.png/)
    assert.match(src, /favicon\.png\?v=/)
    assert.match(src, /icon-512\.png/)
    assert.match(src, /icon-192\.png/)
  })

  it('installed PWA awaits /session before boot so auth is not wiped by initializeChess', () => {
    const src = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(src, /await (?:BoardLayout\.)?fetchPwaSession\(\)/)
    assert.match(src, /Boot \/ local-session restore often omit auth flags[\s\S]*viewerAuthenticated/)
    assert.match(src, /Popup \/ direct tab: auth arrives via shell SET_STATE/)
  })

  it('survey.js keys hosts with normalizeWikiSite', () => {
    const src = readFileSync(join(root, 'src/survey.js'), 'utf8')
    assert.match(src, /normalizeWikiSite/)
    assert.match(src, /function normalizeSite\(host\) {\s*\n\s*return normalizeWikiSite\(host\)/)
  })

  it('chess-app bundle does not import chess.js directly', () => {
    const src = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.doesNotMatch(src, /from ['"]\.\/chess\.js['"]/)
    assert.doesNotMatch(src, /from ['"]\.\.\/src\/chess\.js['"]/)
  })

  it('chess.js does not import realtime.js (app-layer module)', () => {
    const src = readFileSync(join(root, 'src/chess.js'), 'utf8')
    assert.doesNotMatch(src, /from ['"]\.\/realtime\.js['"]/)
  })

  it('chess-core.js owns pure realtime presence helpers', () => {
    const core = readFileSync(join(root, 'src/chess-core.js'), 'utf8')
    assert.match(core, /export function normalizeRealtimeState/)
    assert.match(core, /export function setRealtimeSeat/)
    assert.match(core, /export function normalizeRealtimeSignalMap/)
  })

  it('StockfishPlayer falls back on bestmove (none) instead of hanging the turn', () => {
    const src = readFileSync(join(root, 'src/cm-modules-bundle.js'), 'utf8')
    assert.match(src, /bestmove\\s\+\\\(none\\\)/)
    assert.match(src, /ENGINE_SEARCH_ABORTED/)
    assert.match(src, /pickLegalFallbackMove/)
    assert.match(src, /playing legal fallback/)
  })

  it('chess.js routes saves through the chess-core journal gateway', () => {
    const shell = readFileSync(join(root, 'src/chess.js'), 'utf8')
    const core = readFileSync(join(root, 'src/chess-core.js'), 'utf8')
    const federation = readFileSync(join(root, 'src/federation.js'), 'utf8')
    assert.match(shell, /buildChessSaveActions\(raw, item\.id, persisted/)
    assert.match(shell, /canonicalizePersistedChessText/)
    assert.match(shell, /mapChessSaveActionsForJournal/)
    assert.match(shell, /syncGhostPreviewChessItemText/)
    assert.match(shell, /isCreatePreviewPage\(ctx\)/)
    assert.match(shell, /enqueuePageJournalPuts/)
    assert.match(shell, /ensureUniqueCreateActionSlug/)
    assert.match(shell, /waitForJournalPutApplied/)
    assert.doesNotMatch(shell, /skipSeedEditAfterCreate/)
    assert.doesNotMatch(shell, /const mapChessSaveActionsForJournal =/)
    assert.doesNotMatch(shell, /const stripCreatePreviewFlag =/)
    assert.match(core, /export function buildChessSaveActions\(/)
    assert.match(core, /export function applyPageAction\(/)
    assert.doesNotMatch(federation, /export function buildChessSaveActions\(/)
    assert.doesNotMatch(federation, /export function applyPageAction\(/)
  })

  it('board-layout popup state key uses pwaStoragePrefix SSOT (session handoff only)', () => {
    const layout = readFileSync(join(root, 'src/board-layout.js'), 'utf8')
    assert.doesNotMatch(layout, /setupStoragePrefix/)
    assert.match(
      layout,
      /function popupStateStorageKey\(\) {\s*\n\s*return `\$\{pwaStoragePrefix\(restorePwaContext\(\)\)\}PopupState`/,
    )
    assert.match(layout, /export function rememberPopupState/)
    assert.doesNotMatch(layout, /WikiChess-playSnapshot/)
    assert.doesNotMatch(layout, /mergeIncomingWithPlaySnapshot/)
  })

  it('shell journal wait treats yellow-halo journal DOM as applied', () => {
    const src = readFileSync(join(root, 'src/chess.js'), 'utf8')
    assert.match(src, /Failed origin puts yellow-halo/)
    assert.match(src, /\.journal \.action/)
  })

  it('refreshed popup re-adopts by itemId when pageKey drifts', () => {
    const src = readFileSync(join(root, 'src/chess.js'), 'utf8')
    assert.match(src, /fall back to itemId alone/)
    assert.match(src, /if \(!fallback\) fallback = itemLive/)
  })

  it('PWA resume uses IndexedDB local-session SSOT; persistPwaState clears session for ephemeral seeks', () => {
    const layout = readFileSync(join(root, 'src/board-layout.js'), 'utf8')
    const chessApp = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    const game = readFileSync(join(root, 'src/game.js'), 'utf8')
    assert.match(layout, /export async function savePwaLocalSession/)
    assert.match(layout, /export async function loadPwaLocalSession/)
    assert.match(layout, /PWA_LOCAL_SESSION_IDB_NAME = 'wiki-chess-pwa-session'/)
    assert.doesNotMatch(layout, /wiki-chess-pwa-local-session/)
    assert.doesNotMatch(layout, /clearPwaPersistedState/)
    assert.match(
      layout,
      /export function persistPwaState\(\) \{\s*\n\s*if \(!pwaCtx\.isPwaStandalone\) return\s*\n\s*const pgn = pwaCtx\.exportChessText\(\)\s*\n\s*if \(!pgn \|\| getFormat\(pgn\) !== 'PGN'\) return\s*\n[\s\S]*?void clearPwaLocalSession\(\)/,
    )
    assert.doesNotMatch(chessApp, /localStorage\.setItem\(`\$\{prefix\}GameSettings`/)
    assert.match(game, /(?:app\.)?chessConsole\.persistence\.save = \(\) => \{\}/)
    assert.match(chessApp, /savePwaLocalSession\(/)
  })

  it('reportPwaInstalled routes through queryChessPwaInstalled', () => {
    const layout = readFileSync(join(root, 'src/board-layout.js'), 'utf8')
    const reportFn = layout.match(/export async function reportPwaInstalled\(\) \{[\s\S]*?\n\}/)?.[0]
    assert.ok(reportFn, 'reportPwaInstalled export not found')
    assert.match(reportFn, /await queryChessPwaInstalled\(\)/)
    assert.doesNotMatch(reportFn, /getInstalledRelatedApps/)
    assert.doesNotMatch(reportFn, /isChessPwaInstalledLocally/)
  })

  it('chess-app boot layout has no unreachable else after embed/popup/direct-tab', () => {
    const chessApp = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(
      chessApp,
      /if \(isWikiEmbed\) \{[\s\S]*?\} else if \(isPopupLayout\) \{[\s\S]*?\} else \{\s*\n\s*document\.documentElement\.classList\.add\('wiki-direct-tab'\)/,
    )
    assert.doesNotMatch(
      chessApp,
      /else if \(!isWikiEmbed\) \{[\s\S]*?wiki-direct-tab[\s\S]*?\} else \{[\s\S]*?wiki-chess-drawer/,
    )
  })

  it('persists auto-fork game-end preference in local prefs keys', () => {
    const src = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(src, /PREFERENCE_SETTING_KEYS = \[[\s\S]*'autoAcceptOpponentWikiGameEnd'/)
  })

  it('page-fork coalesces null remote gameSettings instead of resetting defaults', () => {
    const shell = readFileSync(join(root, 'src/chess.js'), 'utf8')
    assert.match(shell, /coalesceAdoptedGameSettings/)
    assert.match(shell, /patchStateOnly:\s*true/)
    const core = readFileSync(join(root, 'src/chess-core.js'), 'utf8')
    assert.match(core, /export function coalesceAdoptedGameSettings/)
  })

  it('SURVEY / LEADERBOARD wiki embeds never follow popup or PWA', () => {
    const core = readFileSync(join(root, 'src/chess-core.js'), 'utf8')
    assert.match(core, /export function isMaintenanceChessItemText/)
    assert.match(core, /export function isMaintenanceChessState/)
    assert.match(core, /isMaintenanceChessState\(prev\) && activePage\('leaderboard'\)/)
    const shell = readFileSync(join(root, 'src/chess.js'), 'utf8')
    assert.match(shell, /const isMaintenanceChessCtx = ctx =>/)
    assert.match(
      shell,
      /const beginPopupLaunch = ctx => \{\s*\n\s*\/\/ Survey\/leaderboard[\s\S]*?if \(isMaintenanceChessCtx\(ctx\)\) return/,
    )
    assert.match(
      shell,
      /announceWikiTabToChessOpener = ctx => \{\s*\n\s*\/\/ My Chess Games[\s\S]*?if \(isMaintenanceChessCtx\(ctx\)\) return/,
    )
    const app = readFileSync(join(root, 'src/chess-app.js'), 'utf8')
    assert.match(app, /lockedMaintenance/)
    assert.match(app, /isMaintenanceChessState\(chessState\(\)\)/)
  })

  it('remote accept page-forks without animating first (avoids autosave race)', () => {
    const realtime = readFileSync(join(root, 'src/realtime.js'), 'utf8')
    assert.match(realtime, /remotePageForkInFlight/)
    assert.doesNotMatch(realtime, /lastAcceptedRemoteMovetext/)
    assert.doesNotMatch(realtime, /function tryAnimateRemoteMove/)
    assert.match(realtime, /function acceptRemoteMove\(\) \{[\s\S]*?remotePageForkInFlight = true/)
    assert.match(realtime, /forkRemotePage\(\{ host: forkSite, expectText: text \}\)/)
    const shell = readFileSync(join(root, 'src/chess.js'), 'utf8')
    assert.match(shell, /remoteForkInFlight/)
    assert.match(shell, /remotePageMatchesExpect/)
    assert.match(shell, /expectText/)
  })
})
