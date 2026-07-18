/**
 * Chess app — full board UI loaded inside the wiki iframe, popup window, or PWA.
 *
 * §1 Boot & view routing (initializeChessCore)
 * §2 PWA session orchestration (page chrome DOM in board-layout.js §4)
 * §3 Auth lock & viewer context
 * §4 Journal gateway & shared export helpers
 * §5 postMessage app handlers
 *
 * In-file landmarks use `// # Section Name` for navigation.
 *
 * SPDX-License-Identifier: MIT
 *
 * Bundled to client/chess-app.js (imports client/cm-modules-bundle.js at runtime).
 * Orchestrates game, survey, leaderboard, puzzle, choose-menu, position, board-layout (transport + PWA chrome), and realtime.
 * GAME mode UI lives in game.js (player bars, console, start-game modal).
 */

import * as Game from './game.js'
import * as Realtime from './realtime.js'
import * as Puzzle from './puzzle.js'
import * as ChooseMenu from './choose-menu.js'
import * as Position from './position.js'
import * as Survey from './survey.js'
import * as Leaderboard from './leaderboard.js'
import * as BoardLayout from './board-layout.js'

import {
  I18n,
  Pgn,
  createStauntyFigures,
  stauntySpriteId,
  ensurePieceSpriteCached,
  clearPieceSpriteCache,
  reloadConsoleBoardPieceSet,
} from './cm-modules-bundle.js'
import {
  formatPgn,
  getFormat,
  formatPlayerId,
  buildStartPgn,
  normalizeFen,
  pgnStampSite as resolvePgnStampSite,
  prepareWikiPgn,
  mergePgnWithSavedHeaders,
  pgnHasMoves,
  normalizeExportPgn,
  canonicalizePersistedChessText,
  isSameDeviceHumanPlay,
  getHumanPlayMode,
  isPuzzleState,
  normalizeRestoredChessSession,
  playerDisplayLabel,
  stripSelfChallengeTarget,
  GUEST_PLAYER_NAME,
  guestSeatName,
  START_FEN,
  parseChessItem,
  resolveChessState,
  normalizeGameSettings,
  mergeGameSettings,
  siteGameSettingDefaults,
  pgnGameSettingDefaults,
  PIECE_SETS,
  PIECE_SET_STORAGE_KEY,
  DEFAULT_PIECE_SET_ID,
  normalizePieceSetId,
  getPieceSetById,
  COLOR_THEME_STORAGE_KEY,
  DEFAULT_COLOR_THEME_ID,
  normalizeColorThemeId,
  nextColorThemeId,
  resolveColorTheme,
  pieceSetAllowsInPlaceFlip,
  shouldRotateBoardForSideToMove,
  resolveSignedInUsername,
  escapeHtml,
  buildCreatePreviewMeta,
  shouldPersistChessItemText,
  CHESS_VIEW,
  createChessSessionController,
  resolveChessViewMode,
  isMaintenanceChessState,
  isMaintenanceChessItemText,
  sessionShouldDeferStockfishSetup,
  sessionHasReceivedInitialState,
  sessionBlocksAutosave,
  sessionShouldReopenGameSetup,
  createMessageDispatcher,
  localSessionUiPolicy,
  pwaMatchesLinkedWikiTab,
  MSG,
} from './chess-core.js'
import {
  isReplaceableGhostPageTitle,
  buildJoinChallengePage,
  SURVEY_PAGE_SLUG,
  SURVEY_PAGE_TITLE,
  SURVEY_PAGE_STORY,
  LEADERBOARD_PAGE_SLUG,
  LEADERBOARD_PAGE_TITLE,
  LEADERBOARD_CHESS_ID,
} from './federation.js'
import { openConfirmModal, closeActiveModal, restoreEmbeddedMount, WIKI_AUTH_REQUIRED_TITLE } from './modals.js'
export { confirmSwitchGameModeFromEditor } from './choose-menu.js'

const chessSession = createChessSessionController({ onFollowPopupChange: Realtime.syncFollowsPopup })

const sessionFollowsPopup = () => chessSession.followsPopup()
const setSessionFollowsPopup = followsPopup => chessSession.setFollowsPopup(followsPopup)
const shouldDeferNewGameSetup = () => chessSession.shouldDeferNewGameSetup()
const getPendingNewGameSetupModalOpts = () => chessSession.pendingNewGameSetupModalOpts()
const clearPendingNewGameSetupModal = () => chessSession.clearPendingNewGameSetupModal()
const getMenuResumeSnapshotBeforeNewGame = () => chessSession.menuResumeSnapshotBeforeNewGame()
const setMenuResumeSnapshotBeforeNewGame = value => chessSession.setMenuResumeSnapshotBeforeNewGame(value)
const exitNewGameSetup = opts => chessSession.exitNewGameSetup(opts)
const dismissNewGameSetupItem = itemId => chessSession.dismissNewGameSetupItem(itemId)
const markShellStateReceived = () => chessSession.markShellStateReceived()
const isNewGameSetupActive = () => chessSession.isNewGameSetupActive()
const getNewGameSetupOrigin = () => chessSession.newGameSetupOrigin()
const dismissOpenChallengeSetupItem = itemId => chessSession.dismissOpenChallengeSetupItem(itemId)
const clearNewGameSetupForGameStart = () => chessSession.clearNewGameSetupForGameStart()

// # Session Controller and Shell Messenger

// Live chess item state — sole source of truth via chessSession (no separate global).
function chessState() {
  return chessSession.getChessState()
}

function setChessState(next) {
  chessSession.loadChessState(next)
}

function replaceChessState(next) {
  chessSession.replaceChessState(next)
}

function postToShell(msg) {
  const payload = BoardLayout.enrichTransport(msg, {
    itemId: wikiItemId(),
    pageKey: wikiPageSlug(),
  })
  BoardLayout.sendTransport(payload, {
    itemId: wikiItemId(),
    pageKey: wikiPageSlug(),
    signedInDisplayName: resolvedViewerOwnerName(),
    onContextUpdate: applyViewerContextFromShell,
  })
  if (pwaBridgeActive) syncWikiContext()
}

const wiki = BoardLayout.createShellMessenger(postToShell)

Game.initGame({
  get chessConsole() {
    return chessConsole
  },
  set chessConsole(value) {
    chessConsole = value
  },
  get fenEditor() {
    return fenEditor
  },
  get chessState() {
    return chessSession.getChessState()
  },
  setChessState,
  get chessSession() {
    return chessSession
  },
  sessionFollowsPopup,
  setSessionFollowsPopup,
  shouldDeferNewGameSetup,
  getPendingNewGameSetupModalOpts,
  clearPendingNewGameSetupModal,
  getMenuResumeSnapshotBeforeNewGame,
  setMenuResumeSnapshotBeforeNewGame,
  exitNewGameSetup,
  dismissNewGameSetupItem,
  isNewGameSetupActive,
  getNewGameSetupOrigin,
  dismissOpenChallengeSetupItem,
  clearNewGameSetupForGameStart,
  get wikiFrame() {
    return wikiFrame
  },
  get isWikiEmbed() {
    return isWikiEmbed
  },
  get isWikiPopup() {
    return isWikiPopup
  },
  get isPopupLayout() {
    return isPopupLayout
  },
  get isPwaStandalone() {
    return isPwaStandalone
  },
  get pwaBridgeActive() {
    return pwaBridgeActive
  },
  wiki,
  postToShell,
  exportChessText,
  putJournal,
  initializeChess,
  resetChessApp,
  pickAppStateBasics,
  pgnStampSite,
  viewingSite,
  isGuestViewer,
  guestPlayerName,
  rememberGuestPlayerName,
  resolvedViewerOwnerName,
  viewerCanJournalAsOwner,
  syncViewerAuthFromParent,
  canWriteJournalHere,
  viewerWikiJoinId,
  canPersistPosition,
  canReachWikiForSave,
  journalBlocksAutosave,
  commitKeywordItem,
  postShellSessionFlags,
  notifyWikiHeight,
  notifyWikiPositionChanged,
  notifyWikiMoveUndone,
  isPwaJournalless,
  persistLocalSession,
  changePage,
  isActivePage,
  openEmbeddedConfirmModal,
  syncGhostChessItemAfterModeBoot,
  flushGhostChessItemSyncIfReady,
  clearActiveGhostPageTitleKey,
  clearOpenChallengeSetupFlag,
  returnToSurveyItemView,
  isCreatePreviewContext,
  canSpawnLineupGhostPage,
  syncLinkedPageTitleInputs,
  shouldShowStartModalPageTitleField,
  enableGuestLocalStoragePersistForPlay,
  confirmGuestLocalSameDevicePlay,
  shouldOfferGuestLocalSameDevicePlay,
  loadPieceSetPreference,
  savePieceSetPreference,
  applySessionPieceSetOverride,
  getPieceSetFile,
  getPieceSpritesUrl,
  syncPieceSetPickersUI,
  seatKingPreviewHtml,
  gameSettings,
  persistGameSettings,
  syncGameSettingsUI,
  ensureEphemeralFlipPrefsForGameLifecycle,
  syncFooterNavVisibility,
  scheduleAuthLockLayout,
  copyTextToClipboard,
  exportCurrentFen,
  currentPositionFen,
  wikiItemId,
  wikiPageSlug,
  rememberPopupState: BoardLayout.rememberPopupState,
  getPwaWikiContext: BoardLayout.getPwaWikiContext,
  syncLocalOnlyHalo,
  hasPersistedWikiPageSlug,
  showChessInitError,
  showErrorPage,
  wireStartMenu,
  loadLocalSettingPrefs,
  replaceChessState,
  ownRatingValue: Survey.ownRatingValue,
  applySyncedPosition: Realtime.applySyncedPosition,
  requestViewerContextFromShell,
  applyViewerContextFromShell,
  liveParentAuth,
  resolveGhostPageTitleKey,
  populatePieceSetPickers,
  showsPwaPageTitleChrome,
  schedulePwaChessItemRetitle,
})

// # Survey UI App Factory

function buildSurveyUiApp() {
  return {
    get chessConsole() {
      return chessConsole
    },
    get chessState() {
      return chessState()
    },
    get wikiFrame() {
      return wikiFrame
    },
    get followsPopup() {
      return sessionFollowsPopup()
    },
    localPlayerSeatColor: Game.localPlayerSeatColor,
    postToShell,
    wiki,
    exportChessText,
    putJournal,
    refreshPlayerLabels: Game.refreshPlayerLabels,
    notifyWikiHeight,
    changePage,
    returnToStartMenu: ChooseMenu.returnToStartMenu,
    clearBrowseStartMenuState: ChooseMenu.clearBrowseStartMenuState,
    pgnStampSite,
    ownRatingValue: Survey.ownRatingValue,
    ownGamesPlayed: Survey.ownGamesPlayed,
    canPublish: () => Boolean(chessState()?.ownerCanJournalHere || chessState()?.pageOnThisWiki),
    pwaAuthGateTitle,
    startOpenChallengeSetup,
    createChooseMenuGhostPage(onFailure) {
      requestExternalCreatePreview('choose', { onFailure })
    },
    viewingSite: () => viewingSite(),
    viewerSeatId: () => String(chessState()?.viewerSeatId || '').trim(),
    viewerRating: () => Survey.ownRatingValue(viewingSite()),
    get pwaBridgeActive() {
      return pwaBridgeActive
    },
    get isPwaStandalone() {
      return isPwaStandalone
    },
    get isWikiPopup() {
      return isWikiPopup
    },
    get isWikiEmbed() {
      return isWikiEmbed
    },
    seatKingPreviewHtml,
    ensurePieceSprites: () => ensurePieceSpriteCached(getPieceSpritesUrl()),
    adoptPwaSurveyPage,
    adoptPwaLeaderboardPage,
  }
}

const surveyUiApp = buildSurveyUiApp()
Survey.initSurveyUi(surveyUiApp)
Leaderboard.initLeaderboardUi(surveyUiApp)

// Give the real-time / remote-opponent module a live view of app state.
// Variables that are reassigned over the app's lifetime are exposed as getters; the
// rest are stable hoisted-function callbacks. Read only when a realtime function
// runs, well after these bindings are initialized.
Realtime.initRealtime({
  Pgn,
  get chessConsole() {
    return chessConsole
  },
  get chessState() {
    return chessSession.getChessState()
  },
  get followsPopup() {
    return sessionFollowsPopup()
  },
  get wikiFrame() {
    return wikiFrame
  },
  get isWikiEmbed() {
    return isWikiEmbed
  },
  get isWikiPopup() {
    return isWikiPopup
  },
  gameSettings,
  viewingSite,
  localPlayerSeatColor: Game.localPlayerSeatColor,
  postToShell,
  wiki,
  exportChessText,
  isPositionEditorMode: Position.isPositionEditorMode,
  persistPwaState: BoardLayout.persistPwaState,
  notifyWikiHeight,
  applyPastedItemText,
  putJournal,
  canPersistPosition,
  updateGameSettings(partial) {
    const next = mergeGameSettings(gameSettings(), partial)
    persistGameSettings(next)
    syncGameSettingsUI()
    Realtime.maybeAutoAcceptPendingRemoteMove()
    Realtime.maybeAutoAcceptPendingRemoteGameEnd()
    Realtime.sendRealtimePresence()
    notifyWikiHeight()
  },
})

Realtime.initShellSync({
  getChessState: () => chessState(),
  replaceChessState,
  setSessionFollowsPopup,
  sessionFollowsPopup,
  shouldDeferNewGameSetup,
  shouldDeferStockfishSetup,
  initializeChess,
  resetChessApp,
  beginSync: () => chessSession.beginSync(),
  endSync: () => chessSession.endSync(),
  getChessConsole: () => chessConsole,
  mergePuzzleShellContext: Puzzle.mergePuzzleShellContext,
  shouldKeepActivePuzzleSession: Puzzle.shouldKeepActivePuzzleSession,
  isActivePage,
  localPlayerSeatColor: Game.localPlayerSeatColor,
  wikiInteractiveSeatKey: Game.wikiInteractiveSeatKey,
  gameInitProps: Game.gameInitProps,
  shouldRequestEngineMoveAfterInit: Game.shouldRequestEngineMoveAfterInit,
  enhancePlayerLabels: Game.enhancePlayerLabels,
  loadLocalSettingPrefs,
  syncGameSettingsUI,
  notifyWikiHeight,
})

// Give the puzzle (solving / authoring) module a live view of the app state it needs.
// The solver/author build their own ChessConsole into the shared `chessConsole`
// slot and rewrite `chessState()` when saving a puzzle, so those two are exposed as
// getter+setter pairs; the other reassigned bindings are live getters and the rest
// are stable hoisted-function callbacks. Read only when a puzzle function runs, well
// after these bindings are initialized.
Puzzle.initPuzzleMode({
  get chessConsole() {
    return chessConsole
  },
  set chessConsole(value) {
    chessConsole = value
  },
  get chessState() {
    return chessSession.getChessState()
  },
  set chessState(value) {
    setChessState(value)
  },
  get fenEditor() {
    return fenEditor
  },
  get isPopupLayout() {
    return isPopupLayout
  },
  get isPwaStandalone() {
    return isPwaStandalone
  },
  get pwaBridgeActive() {
    return pwaBridgeActive
  },
  canPublish: () => Boolean(chessState()?.ownerCanJournalHere || chessState()?.pageOnThisWiki),
  pwaAuthGateTitle,
  localPuzzleDownloadEnabled: Puzzle.isLocalPuzzleDownloadOptIn,
  setLocalPuzzleDownloadEnabled: Puzzle.setLocalPuzzleDownloadOptIn,
  get isWikiEmbed() {
    return isWikiEmbed
  },
  get wikiFrame() {
    return wikiFrame
  },
  changePage,
  postToShell,
  wiki,
  patchSoundForSync: Game.patchSoundForSync,
  putJournal,
  initializeChess,
  pickAppStateBasics,
  wikiSite: pgnStampSite,
  fitPopupBoard: BoardLayout.fitPopupBoard,
  fitEmbedBoard: BoardLayout.fitEmbedBoard,
  scheduleBoardResize: BoardLayout.scheduleBoardResize,
  notifyPwaPlayLayoutReady: BoardLayout.notifyPwaPlayLayoutReady,
  notifyWikiHeight,
  returnToStartMenu: ChooseMenu.returnToStartMenu,
  proceedReturnToStartMenu: ChooseMenu.proceedReturnToStartMenu,
  flushGhostChessItemSyncIfReady,
  confirmSwitchGameModeFromEditor: ChooseMenu.confirmSwitchGameModeFromEditor,
  openEmbeddedConfirmModal,
  getPieceSpritesUrl,
  getPieceSetFile,
  ensureMountContentVisible: BoardLayout.ensureMountContentVisible,
})

// Give the board-layout / resize module a live view of the app state it needs. The
// board-fit math only ever reads `chessConsole` and the layout flags, so they're live
// getters; `postToShell`/`wiki`/`whenDocumentReady` are stable hoisted-function callbacks. The
// module owns its own popup-resize bookkeeping internally.
BoardLayout.initBoardLayout({
  get chessConsole() {
    return chessConsole
  },
  get fenEditor() {
    return fenEditor
  },
  get isPopupLayout() {
    return isPopupLayout
  },
  get isWikiEmbed() {
    return isWikiEmbed
  },
  get isPwaStandalone() {
    return isPwaStandalone
  },
  get wikiFrame() {
    return wikiFrame
  },
  postToShell,
  wiki,
  whenDocumentReady,
  hideAppLoadingScreen,
})

// Give the PWA/popup context+lifecycle module a live view of the app state it needs.
// The window-identity flags and `receivedInitialState` are live getters; the rest are
// stable hoisted-function callbacks. The module owns its own storage bookkeeping.
BoardLayout.initPwaPopup({
  get isPwaStandalone() {
    return isPwaStandalone
  },
  get isWikiPopup() {
    return isWikiPopup
  },
  get wikiFrame() {
    return wikiFrame
  },
  get receivedInitialState() {
    return sessionHasReceivedInitialState(chessSession.getState())
  },
  initializeChess,
  exportChessText,
  wikiItemId,
  localPlayerSeatColor: Game.localPlayerSeatColor,
  gameSettings,
  postToShell,
  wiki,
  isolatePwaLocalWikiContext,
})

BoardLayout.initPwaPageChrome({
  get chessState() {
    return chessState()
  },
  get pwaBridgeActive() {
    return pwaBridgeActive
  },
  get pwaSessionResolved() {
    return pwaSessionResolved
  },
  get pwaSessionReachable() {
    return pwaSessionReachable
  },
  isPwaJournalless,
  getPwaWikiContext: BoardLayout.getPwaWikiContext,
  onPageTitleInput: handlePwaPageTitleInput,
  onPutJournal: () => requestPwaSaveToWiki(),
  onOpenWikiPage: href => openLinkedWikiPage(href),
  canWriteJournalHere,
  pwaAuthGateTitle,
  syncLocalOnlyHalo,
  notifyWikiHeight,
})

BoardLayout.initPasteHandling({
  exportChessText,
  getAppState: () => chessState(),
  canCreatePasteGhost: () => canSpawnLineupGhostPage(),
  requestPastePreview: payload => {
    if (!wikiFrame || !payload?.itemText) return
    wiki.createPastePreview({
      itemText: payload.itemText,
      format: payload.format,
    })
    BoardLayout.ensureMountContentVisible('#leaderboard .container-fluid')
    window.scheduleWikiHeightReport?.()
  },
})

// CHOOSE menu / game-lifecycle (see ./choose-menu.js). Live getters for reassigned
// bindings; new-game setup flags are mutable via getter/setter pairs.
ChooseMenu.initStartMenu({
  get chessState() {
    return chessSession.getChessState()
  },
  set chessState(value) {
    setChessState(value)
  },
  get chessConsole() {
    return chessConsole
  },
  get followsPopup() {
    return sessionFollowsPopup()
  },
  setFollowsPopup(followsPopup) {
    setSessionFollowsPopup(followsPopup)
  },
  get wikiFrame() {
    return wikiFrame
  },
  get isPwaStandalone() {
    return isPwaStandalone
  },
  get isWikiPopup() {
    return isWikiPopup
  },
  get pwaBridgeActive() {
    return pwaBridgeActive
  },
  canPublish: () => Boolean(chessState()?.ownerCanJournalHere || chessState()?.pageOnThisWiki),
  pwaAuthGateTitle,
  get newGameSetupActive() {
    return isNewGameSetupActive()
  },
  set newGameSetupActive(value) {
    if (!value) exitNewGameSetup()
  },
  get newGameSetupOrigin() {
    return getNewGameSetupOrigin()
  },
  set newGameSetupOrigin(_value) {
    /* managed by ENTER_SETUP / EXIT_SETUP */
  },
  get menuResumeSnapshotBeforeNewGame() {
    return getMenuResumeSnapshotBeforeNewGame()
  },
  set menuResumeSnapshotBeforeNewGame(value) {
    setMenuResumeSnapshotBeforeNewGame(value)
  },
  get newGameSetupDismissedItem() {
    return chessSession.dismissedNewGameSetupItemId()
  },
  set newGameSetupDismissedItem(value) {
    if (value != null) dismissNewGameSetupItem(value)
  },
  postToShell,
  wiki,
  initializeChess,
  exportChessText,
  resetChessApp,
  openEmbeddedConfirmModal,
  pickAppStateBasics,
  wikiItemId,
  closePositionStartModal: Game.closePositionStartModal,
  isPositionEditorMode: Position.isPositionEditorMode,
  exportCurrentFen,
  currentPositionFen,
  isActivePage,
  currentGameOutcome: Game.currentGameOutcome,
  viewerHoldsResignableSeat: Game.viewerHoldsResignableSeat,
  executeResignFromViewer: Game.executeResignFromViewer,
  capturePuzzleResumeSnapshot: Puzzle.capturePuzzleResumeSnapshot,
  resumePuzzleSession: Puzzle.resumePuzzleSession,
  requestWikiEmbedScrollIntoView: BoardLayout.requestWikiEmbedScrollIntoView,
  flushGameBeforeBrowse,
})

// POSITION mode / FEN editor (see ./position.js). The FEN editor board instance
// stays owned here (many game/export helpers read it), so it's exposed as a
// getter/setter pair; the rest are stable hoisted-function host callbacks.
Position.initPosition({
  get fenEditor() {
    return fenEditor
  },
  set fenEditor(value) {
    fenEditor = value
  },
  get chessState() {
    return chessSession.getChessState()
  },
  get wikiFrame() {
    return wikiFrame
  },
  get pwaBridgeActive() {
    return pwaBridgeActive
  },
  get isWikiEmbed() {
    return isWikiEmbed
  },
  get isPopupLayout() {
    return isPopupLayout
  },
  get followsPopup() {
    return sessionFollowsPopup()
  },
  wiki,
  getPieceSetFile,
  getPieceSpritesUrl,
  isActivePage,
  exportChessText,
  canPersistPosition,
  canWriteJournalHere,
  isPwaJournalless,
  requestPwaSaveToWiki,
  initializeChess,
  pickAppStateBasics,
  clearBrowseStartMenuState: ChooseMenu.clearBrowseStartMenuState,
  wirePositionEditor: Game.wirePositionEditor,
  syncGhostChessItemAfterModeBoot,
  setStartModalPageTitlePinned: Game.setStartModalPageTitlePinned,
  notifyWikiHeight,
  notifyPwaPlayLayoutReady: BoardLayout.notifyPwaPlayLayoutReady,
  flushGhostChessItemSyncIfReady,
})

// ChessConsole instance (from cm-modules-bundle), set once the board boots.
let chessConsole
// FenEditor instance (from cm-modules-bundle), set when the FEN editor opens.
let fenEditor
// whitePlayerKind / blackPlayerKind / wikiHistoryComponent / wikiCapturedComponent — game.js

// # Piece Set Preferences and Pickers

// Guests always start on Merida; intentional picks last only for this page session.
// Owners persist their last intentional choice in localStorage across games.
let guestSessionPieceSetId = null

// Auto-recommended set for the current play session (e.g. Don't flip → Shapes in the
// same-device setup). Renders this app instance's boards but is never persisted, so the
// site-wide default stays Merida. Cleared by any intentional pick (savePieceSetPreference).
let sessionPieceSetOverrideId = null

function applySessionPieceSetOverride(id) {
  sessionPieceSetOverrideId = normalizePieceSetId(id)
}

function loadPieceSetPreference() {
  if (sessionPieceSetOverrideId) return sessionPieceSetOverrideId
  if (isGuestViewer()) {
    return guestSessionPieceSetId || DEFAULT_PIECE_SET_ID
  }
  try {
    const raw = localStorage.getItem(PIECE_SET_STORAGE_KEY)
    if (raw == null) return DEFAULT_PIECE_SET_ID
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return normalizePieceSetId(parsed)
    } catch {
      /* legacy bare piece-set id */
    }
    return normalizePieceSetId(raw)
  } catch {
    return DEFAULT_PIECE_SET_ID
  }
}

function savePieceSetPreference(id) {
  const nextId = normalizePieceSetId(id)
  sessionPieceSetOverrideId = null
  if (isGuestViewer()) {
    guestSessionPieceSetId = nextId
    return
  }
  try {
    localStorage.setItem(PIECE_SET_STORAGE_KEY, JSON.stringify(nextId))
  } catch {
    /* localStorage can be unavailable */
  }
}

function getPieceSetFile() {
  return getPieceSetById(loadPieceSetPreference()).spriteFile
}

function getPieceSpritesUrl() {
  return `./assets/${getPieceSetFile()}`
}

// One of each piece; black on light squares, white on dark (green).
const PIECE_SET_PREVIEW_PIECES = [
  ['b', 'K'],
  ['w', 'Q'],
  ['b', 'R'],
  ['w', 'B'],
  ['b', 'N'],
  ['w', 'P'],
]

// Matches cm-chessboard green theme (.cm-chessboard.green).
const PIECE_SET_BOARD_LIGHT = '#E0DDCC'
const PIECE_SET_BOARD_DARK = '#4c946a'

function piecePreviewUseHtml(spriteFile, colorChar, letter, size, squareTone) {
  const pieceId = stauntySpriteId(colorChar, letter)
  const href = `./assets/${spriteFile}#${pieceId}`
  const toneClass =
    squareTone === 'dark' ? 'wiki-chess-piece-set-preview-square-dark' : 'wiki-chess-piece-set-preview-square-light'
  const bg = squareTone === 'dark' ? PIECE_SET_BOARD_DARK : PIECE_SET_BOARD_LIGHT
  return (
    `<span class="wiki-chess-piece-set-preview-piece ${toneClass}">` +
    `<svg class="wiki-chess-piece-set-preview-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">` +
    `<rect width="40" height="40" fill="${bg}"/>` +
    `<use href="${escapeHtml(href)}" xlink:href="${escapeHtml(href)}" width="40" height="40"/>` +
    '</svg></span>'
  )
}

function pieceSetPreviewPiecesHtml(spriteFile, pieces, size = 20) {
  return pieces
    .map(([color, letter], index) =>
      piecePreviewUseHtml(spriteFile, color, letter, size, index % 2 === 0 ? 'light' : 'dark'),
    )
    .join('')
}

function pieceSetSummaryPreviewHtml(set, { size = 20, nameFirst = false } = {}) {
  const preview = `<span class="wiki-chess-piece-set-current-preview">${pieceSetPreviewPiecesHtml(set.spriteFile, PIECE_SET_PREVIEW_PIECES, size)}</span>`
  const name = `<span class="wiki-chess-piece-set-current-name">${escapeHtml(set.label)}</span>`
  return nameFirst ? name + preview : preview + name
}

// Seat-row king icon. Prefer in-document `#wk` / `#bk` (same sprite the board cached) so
// Chrome does not drop Merida’s gradient fills on external `<use href="….svg#wk">`.
// Render the full 40×40 sprite cell like a board square — the cell already centers the
// king ink vertically, so flex-centering the cell centers the king (no crop/nudge).
function seatKingPreviewHtml(colorChar, size = 20) {
  const color = colorChar === 'b' ? 'b' : 'w'
  const pieceId = stauntySpriteId(color, 'K')
  const href = `#${pieceId}`
  return (
    `<span class="wiki-chess-piece-set-preview-piece">` +
    `<svg class="wiki-chess-piece-set-preview-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">` +
    `<use href="${escapeHtml(href)}" xlink:href="${escapeHtml(href)}" width="40" height="40"/>` +
    '</svg></span>'
  )
}

function syncPieceSetPickerCurrent(picker) {
  const currentEl = picker.querySelector('.wiki-chess-piece-set-current')
  if (!currentEl) return
  const selected = pieceSetSelectionForPicker(picker)
  const set = getPieceSetById(selected)
  const startPicker = picker.classList.contains('wiki-chess-piece-set-picker-start')
  currentEl.innerHTML = pieceSetSummaryPreviewHtml(set, {
    // Start modal: larger previews; board settings: match expanded option size (26px).
    size: startPicker ? 32 : 26,
    nameFirst: true,
  })
}

function pieceSetSelectionForPicker(picker) {
  if (picker?.hasAttribute('data-wiki-piece-set-defer') && picker.dataset.selectedPieceSet) {
    return normalizePieceSetId(picker.dataset.selectedPieceSet)
  }
  return loadPieceSetPreference()
}

function populatePieceSetPickers() {
  removeStaleBoardSpriteWrapper()
  const pickers = document.querySelectorAll('.wiki-chess-piece-set-picker')
  if (!pickers.length) return
  pickers.forEach((picker, pickerIndex) => {
    const optionsEl = picker.querySelector('.wiki-chess-piece-set-options')
    if (!optionsEl) return
    const selected = pieceSetSelectionForPicker(picker)
    const groupName = `pieceSet-${pickerIndex}`
    // Match Game settings dropdown option previews (26px).
    const previewSize = 26
    optionsEl.innerHTML = PIECE_SETS.map(set => {
      const checked = set.id === selected ? ' checked' : ''
      const previewHtml = pieceSetPreviewPiecesHtml(set.spriteFile, PIECE_SET_PREVIEW_PIECES, previewSize)
      return (
        `<label class="wiki-chess-piece-set-option">` +
        `<input class="wiki-chess-piece-set-input visually-hidden" type="radio" name="${groupName}" value="${escapeHtml(set.id)}"${checked}>` +
        `<span class="wiki-chess-piece-set-option-label">` +
        `<span class="wiki-chess-piece-set-option-name">${escapeHtml(set.label)}</span>` +
        `<span class="wiki-chess-piece-set-option-preview">${previewHtml}</span>` +
        '</span></label>'
      )
    }).join('')
  })
  syncPieceSetPickersUI()
}

function removeStaleBoardSpriteWrapper() {
  document.getElementById('cm-chessboard-sprite')?.remove()
}

function syncPieceSetPickersUI() {
  document.querySelectorAll('.wiki-chess-piece-set-picker').forEach(picker => {
    const selected = pieceSetSelectionForPicker(picker)
    picker.querySelectorAll('.wiki-chess-piece-set-input').forEach(input => {
      input.checked = input.value === selected
      input.closest('.wiki-chess-piece-set-option')?.classList.toggle('is-selected', input.checked)
    })
    syncPieceSetPickerCurrent(picker)
  })
}

function closePieceSetChoosers() {
  document.querySelectorAll('.wiki-chess-piece-set-chooser[open]').forEach(chooser => {
    chooser.open = false
  })
}

async function reloadGameBoardForPieceSet() {
  if (!chessConsole?.components?.board?.chessboard) return
  await reloadConsoleBoardPieceSet(chessConsole, {
    piecesFile: getPieceSetFile(),
    assetsUrl: './assets/',
    // Linked followers stay playable; journal still goes through the host surface.
    reenableMoveInput: true,
  })
  Game.applyOppositeSidesPieceFlip()
  chessConsole.props.figures = createStauntyFigures(getPieceSpritesUrl(), 18)
  const wikiHistoryComponent = Game.getWikiHistoryComponent()
  const wikiCapturedComponent = Game.getWikiCapturedComponent()
  if (wikiHistoryComponent) {
    wikiHistoryComponent.props.spriteUrl = getPieceSpritesUrl()
    wikiHistoryComponent.redraw()
  }
  if (wikiCapturedComponent) {
    wikiCapturedComponent.spriteUrl = getPieceSpritesUrl()
    wikiCapturedComponent.redraw()
  }
  Game.renderWikiPlayerLabels(chessConsole.components.board, chessConsole)
  BoardLayout.configureBoardCoordinateMode()
  if (isPopupLayout) {
    BoardLayout.fitPopupBoard()
  } else if (isWikiEmbed) {
    BoardLayout.fitEmbedBoard()
    window.setTimeout(BoardLayout.fitEmbedBoard, 0)
  } else {
    BoardLayout.scheduleBoardResize()
  }
}

async function reloadActiveBoardForPieceSet() {
  await ensurePieceSpriteCached(getPieceSpritesUrl())
  const activePage = ['game', 'position', 'puzzle', 'puzzle-author'].find(id => {
    const el = document.getElementById(id)
    return el && (el.classList.contains('wiki-page-active') || el.style.display === 'block')
  })
  if (activePage === 'game' && chessConsole) {
    await reloadGameBoardForPieceSet()
    return
  }
  if (activePage === 'position' && fenEditor) {
    await Position.reloadFenEditorPieceSet()
    return
  }
  if (activePage === 'puzzle' || activePage === 'puzzle-author') {
    await Puzzle.reloadPuzzleBoardForPieceSet()
  }
}

async function applyPieceSetChange(id) {
  const nextId = normalizePieceSetId(id)
  closePieceSetChoosers()
  if (nextId === loadPieceSetPreference()) {
    syncPieceSetPickersUI()
    return
  }
  savePieceSetPreference(nextId)
  // Shapes never rotate; clear the opposite-sides flip so Merida/etc. do not
  // suddenly start flipping after switching away and back.
  if (!pieceSetAllowsInPlaceFlip(nextId) && gameSettings().sameDeviceFlipPieces) {
    persistGameSettings(mergeGameSettings(gameSettings(), { sameDeviceFlipPieces: false }))
  }
  syncPieceSetPickersUI()
  syncGameSettingsUI()
  clearPieceSpriteCache()
  try {
    await reloadActiveBoardForPieceSet()
  } catch (err) {
    console.error('Failed to reload board for piece set change:', err)
  }
  Survey.refreshSurveyIfVisible()
  notifyWikiHeight()
}

function wirePieceSetPickers() {
  populatePieceSetPickers()
  if (document.body._wikiPieceSetPickersWired) {
    syncPieceSetPickersUI()
    return
  }
  document.body._wikiPieceSetPickersWired = true
  document.addEventListener(
    'toggle',
    event => {
      const chooser = event.target
      if (!(chooser instanceof HTMLDetailsElement) || !chooser.classList.contains('wiki-chess-piece-set-chooser')) {
        return
      }
      if (chooser.open) {
        document.querySelectorAll('.wiki-chess-piece-set-chooser[open]').forEach(other => {
          if (other !== chooser) other.open = false
        })
      }
      notifyWikiHeight()
    },
    true,
  )
  document.addEventListener('change', event => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('wiki-chess-piece-set-input')) {
      return
    }
    const picker = input.closest('.wiki-chess-piece-set-picker')
    if (picker?.hasAttribute('data-wiki-piece-set-defer')) {
      picker.dataset.selectedPieceSet = normalizePieceSetId(input.value)
      picker.dataset.pieceSetFromRecommend = 'manual'
      syncPieceSetPickersUI()
      Game.updateStartModalSubmitEnabled()
      notifyWikiHeight()
      return
    }
    applyPieceSetChange(input.value)
  })
  syncPieceSetPickersUI()
}

// chessConsoleInitPromise / journalAutosaveWired — game.js
// How long a refreshed popup waits for its opener tab to answer popup-ready before
// falling back to its locally-saved game (or the CHOOSE menu).
const POPUP_OPENER_TIMEOUT_MS = 1500
const VIEWER_CONTEXT_RETRY_DELAYS_MS = [400, 1000, 2500, 5000]
// When the start-game modal is opened as "new game" (toolbar +) rather than from
// the FEN editor, this holds the position to start from (the standard start
// position). null means "use the FEN editor's current board" instead.
// start-modal mutable state — game.js

// Popup/PWA auto-resize state, the columns breakpoint, and the board fit math live
// in src/board-layout.js (initialized via BoardLayout.initBoardLayout below).

// # New Game Setup Lifecycle

// Lifecycle flags live in chessSession (see reduceChessSession in chess-core.js).
// Ghost spawned outside the CHOOSE menu (e.g. survey "New Chess Page") — no resume snapshot.
let pendingExternalCreatePreview = null
// Lineup ghost targeted by live title sync when the iframe still embeds off-page (e.g. CHOOSE
// menu on the source item while a preview page sits beside it in the wiki lineup).
let activeGhostPageTitleKey = null

function setActiveGhostPageTitleKey(pageKey) {
  const key = String(pageKey || '').trim()
  activeGhostPageTitleKey = key || null
}

function clearActiveGhostPageTitleKey() {
  activeGhostPageTitleKey = null
}

// moved to game.js

// # PWA Local Session and Materialize

async function ensurePwaGamePage({ text, title, itemId } = {}) {
  const result = await BoardLayout.bridgeFetch('/create-game', {
    method: 'POST',
    body: { text, title, itemId },
  })
  if (result.slug && result.itemId) {
    BoardLayout.setPwaWikiContext({ slug: result.slug, itemId: result.itemId, title: result.title })
  }
  return result
}

let pwaChallengeJoinGen = 0
let pwaChallengeJoinTitleTimer = 0
let pwaChallengeJoinPayload = null
let pwaChessItemGen = 0
let pwaChessItemTitleTimer = 0

function schedulePwaRetitle({ isPending, getTimer, setTimer, run, title, onTitle }) {
  if (!isPending()) return
  const next = String(title || '').trim()
  if (!next) return
  onTitle?.(next)
  window.clearTimeout(getTimer())
  setTimer(
    window.setTimeout(() => {
      if (!isPending()) return
      void run(next)
    }, 700),
  )
}

async function runPwaMaterialize({
  bumpGen,
  getGen,
  pageTitle,
  fetchResult,
  isSuccess,
  onSuccess,
  onError,
  warnLabel,
  finalizeSuccess,
  afterError,
}) {
  const gen = bumpGen()
  BoardLayout.updatePwaPageChromeStatus('creating')
  try {
    const result = await fetchResult()
    if (gen !== getGen()) return
    if (!isSuccess(result)) return

    const savedTitle = result.title || pageTitle
    BoardLayout.setPwaWikiContext({ slug: result.slug, itemId: result.itemId, title: savedTitle })
    onSuccess(result, savedTitle, pageTitle)
    finalizeSuccess(result, savedTitle, pageTitle)
  } catch (err) {
    if (gen !== getGen()) return
    onError?.(err)
    console.warn(warnLabel, err)
    BoardLayout.updatePwaPageChromeStatus('error', err)
    afterError?.(err)
  }
}

async function startPwaOpenChallengeJoinPreview(msg) {
  const ghostPgn = String(msg.pgn || '').trim()
  const challenge = msg.challenge
  const creatorSite = String(msg.site || '')
    .trim()
    .toLowerCase()
  const surveyItemId = String(msg.itemId || '').trim()
  if (!ghostPgn || !challenge) return

  let session = {}
  try {
    session = await BoardLayout.fetchPwaSession()
  } catch {
    /* preview still works unsigned */
  }

  const joinerDisplayName = resolvedViewerOwnerName() || session.signedInDisplayName || session.ownerName || ''
  const joinerSite = viewingSite()
  let payload
  try {
    payload = buildJoinChallengePage({
      ghostPgn,
      challenge,
      itemId: surveyItemId,
      joinerDisplayName,
      joinerSite,
      creatorSite,
      signedInDisplayName: joinerDisplayName,
      remoteTitle: String(msg.title || '').trim(),
    })
  } catch (err) {
    console.warn('wiki-chess PWA challenge preview:', err)
    return
  }

  pwaChallengeJoinPayload = payload
  const creatorLabel = playerDisplayLabel(payload.challenge?.creator?.id || '') || creatorSite || 'another wiki'
  const joinerLabel = playerDisplayLabel(payload.challenge?.opponent?.id || '') || joinerSite || 'You'

  const previewState = {
    ...session,
    itemId: payload.itemId,
    PGN: payload.seatedPgn,
    chessState: payload.seatedPgn,
    challenge: payload.challenge,
    challengeJoinGhost: true,
    pwaChallengeJoinPending: true,
    pwaWikiPageChrome: true,
    pwaChallengeJoinContext: {
      ghostPgn,
      challenge,
      creatorSite,
      surveyItemId,
      creatorLabel,
      joinerLabel,
      proposedTitle: payload.baseTitle,
    },
    wikiPageTitle: payload.baseTitle,
    showStartMenu: false,
    pageOnThisWiki: false,
    ownerCanJournalHere: false,
    gameType: 'game',
    format: 'PGN',
  }

  BoardLayout.deliverInboundShellMessage({
    action: MSG.SET_STATE,
    itemId: payload.itemId,
    chessObj: previewState,
  })
  void runPwaChallengeJoinMaterialize(payload.baseTitle)
}

function schedulePwaChallengeJoinRetitle(title) {
  schedulePwaRetitle({
    isPending: () => chessState()?.pwaChallengeJoinPending,
    getTimer: () => pwaChallengeJoinTitleTimer,
    setTimer: id => {
      pwaChallengeJoinTitleTimer = id
    },
    run: runPwaChallengeJoinMaterialize,
    title,
    onTitle: next => {
      chessState().wikiPageTitle = next
    },
  })
}

async function runPwaChallengeJoinMaterialize(title) {
  const ctx = chessState()?.pwaChallengeJoinContext
  const payload = pwaChallengeJoinPayload
  if (!ctx || !payload) return

  const pageTitle = String(title || ctx.proposedTitle || payload.baseTitle).trim()
  await runPwaMaterialize({
    bumpGen: () => ++pwaChallengeJoinGen,
    getGen: () => pwaChallengeJoinGen,
    pageTitle,
    fetchResult: () =>
      BoardLayout.bridgeFetch('/join-challenge', {
        method: 'POST',
        body: {
          pgn: ctx.ghostPgn,
          challenge: ctx.challenge,
          host: ctx.creatorSite,
          itemId: ctx.surveyItemId,
          title: pageTitle,
          joinerDisplayName: resolvedViewerOwnerName(),
        },
      }),
    isSuccess: result => Boolean(result.slug && result.itemId && result.chessObj),
    onSuccess: (result, savedTitle) => {
      if (chessState()) {
        Object.assign(chessState(), {
          ...result.chessObj,
          itemId: result.itemId,
          wikiPageName: result.slug,
          wikiPageTitle: savedTitle,
          PGN: result.chessObj.PGN || payload.seatedPgn,
          chessState: result.chessObj.chessState || payload.seatedPgn,
          challenge: result.chessObj.challenge || payload.challenge,
          pageOnThisWiki: true,
          ownerCanJournalHere: true,
        })
        delete chessState().challengeJoinGhost
        delete chessState().pwaChallengeJoinPending
      }
      pwaChallengeJoinPayload = null
      BoardLayout.deliverInboundShellMessage({ action: MSG.CHALLENGE_JOIN_FORKED, itemId: result.itemId })
      Survey.refreshSurveyOpenChallenges()
    },
    warnLabel: 'wiki-chess PWA join-challenge:',
    finalizeSuccess: (_result, savedTitle) => {
      BoardLayout.updatePwaPageChromeStatus('saved', null, savedTitle)
      syncWikiContext()
      if (chessConsole) Game.wireJournalAutosave(chessConsole)
      Game.updateExportControls()
      notifyWikiHeight()
    },
  })
}

function schedulePwaChessItemRetitle(title) {
  schedulePwaRetitle({
    isPending: () => chessState()?.pwaChessItemPending,
    getTimer: () => pwaChessItemTitleTimer,
    setTimer: id => {
      pwaChessItemTitleTimer = id
    },
    run: materializeChessItem,
    title,
  })
}

async function materializeChessItem(title) {
  const ctx = chessState()?.pwaChessItemContext
  if (!ctx) return

  const pageTitle = String(title || ctx.proposedTitle).trim()
  await runPwaMaterialize({
    bumpGen: () => ++pwaChessItemGen,
    getGen: () => pwaChessItemGen,
    pageTitle,
    fetchResult: () => ensurePwaGamePage({ text: ctx.chessText, title: pageTitle }),
    isSuccess: result => Boolean(result.slug && result.itemId),
    onSuccess: (result, savedTitle) => {
      if (chessState()) {
        if (result.chessObj && typeof result.chessObj === 'object') {
          Object.assign(chessState(), {
            itemId: result.itemId,
            wikiPageName: result.slug,
            wikiPageTitle: savedTitle,
            pageOnThisWiki: result.chessObj.pageOnThisWiki ?? chessState().pageOnThisWiki,
            ownerCanJournalHere: result.chessObj.ownerCanJournalHere ?? chessState().ownerCanJournalHere,
          })
        } else {
          chessState().itemId = result.itemId
          chessState().wikiPageName = result.slug
          chessState().wikiPageTitle = savedTitle
        }
        delete chessState().pwaChessItemPending
        delete chessState().pwaJournalless
        void BoardLayout.clearPwaLocalSession()
        syncLocalOnlyHalo()
      }
    },
    warnLabel: 'wiki-chess PWA create-game:',
    finalizeSuccess: (_result, savedTitle) => {
      syncWikiContext()
      if (chessConsole) Game.wireJournalAutosave(chessConsole)
      Game.updateExportControls()
      BoardLayout.updatePwaPageChromeStatus('saved', null, savedTitle)
      BoardLayout.updatePwaPageChrome()
      notifyWikiHeight()
    },
  })
}

function isPwaJournalless() {
  return BoardLayout.isPwaJournallessSession({
    pwaBridgeActive,
    pwaJournalless: chessState()?.pwaJournalless,
    pwaChessItemPending: chessState()?.pwaChessItemPending,
  })
}

function syncLocalOnlyHalo() {
  // ownerCanJournalHere is sign-in capability, not "already writing to a wiki page".
  // While journalless, nothing is on the wiki yet — keep the yellow halo visible.
  const policy = localSessionUiPolicy({
    isStandalone: isPwaStandalone,
    isPwaJournalless: isPwaJournalless(),
    sessionResolved: pwaSessionResolved,
    canJournal: Boolean(chessState()?.ownerCanJournalHere) && !isPwaJournalless(),
  })
  BoardLayout.applyLocalOnlyHalo(isPwaStandalone, policy.showHalo)
}

function persistLocalSession() {
  if (!isPwaJournalless() || !chessState()) return
  if (isPuzzleState(chessState())) {
    const snap = Puzzle.capturePuzzleResumeSnapshot()
    void BoardLayout.savePwaLocalSession(
      normalizeRestoredChessSession({ ...chessState(), ...snap, pwaJournalless: true }),
    )
    BoardLayout.updatePwaPageChrome()
    return
  }
  const text = exportChessText({ liveBoardText: true })
  if (text) {
    if (getFormat(text) === 'PGN') {
      chessState().PGN = text
      chessState().chessState = text
    } else if (getFormat(text) === 'FEN') {
      chessState().FEN = text
      chessState().chessState = text
    }
  }
  void BoardLayout.savePwaLocalSession(normalizeRestoredChessSession({ ...chessState(), pwaJournalless: true }))
  BoardLayout.updatePwaPageChrome()
}

function flushGameBeforeBrowse() {
  if (!pwaBridgeActive) return
  if (Position.isPositionEditorMode()) {
    if (isPwaJournalless()) persistLocalSession()
    else if (canPersistPosition()) {
      const fen = exportCurrentFen()
      if (fen) putJournal(fen)
    }
    return
  }
  if (!chessConsole?.state?.chess) return
  notifyWikiPositionChanged(exportChessText({ liveBoardText: true }))
}

function isolatePwaLocalWikiContext() {
  if (chessState()) {
    delete chessState().itemId
    delete chessState().wikiPageName
    delete chessState().wikiGhostPage
    delete chessState().createPreviewPendingJournal
  }
  BoardLayout.setPwaWikiContext({ slug: 'standalone', itemId: 'standalone' })
}

function startPwaLocalSession(kind, { puzzleText } = {}) {
  const meta = buildCreatePreviewMeta(kind, { puzzleText })
  if (!chessState()) setChessState({})
  chessState().pwaJournalless = true
  chessState().pwaWikiPageChrome = true
  chessState().pwaChessItemContext = meta
    ? {
        kind,
        chessText: meta.chessText || puzzleText || kind.toUpperCase(),
        proposedTitle: meta.title,
        lead: meta.paragraph || '',
      }
    : { kind }
  chessState().wikiPageTitle = meta?.title || ''
  delete chessState().pwaChessItemPending
  isolatePwaLocalWikiContext()
  applyCreatePreviewFallback({ kind, puzzleText })
  syncLocalOnlyHalo()
  BoardLayout.updatePwaPageChrome()
  persistLocalSession()
}

async function requestPwaSaveToWiki() {
  if (!pwaBridgeActive || !isPwaJournalless()) return
  if (!canWriteJournalHere()) {
    Game.requestWikiSignIn()
    return
  }
  const ctx = chessState()?.pwaChessItemContext
  const text = exportChessText({ liveBoardText: true }) || ctx?.chessText || 'CHOOSE'
  const pageTitle = String(chessState()?.wikiPageTitle || ctx?.proposedTitle || 'Chess').trim()
  if (!chessState()) setChessState({})
  chessState().pwaChessItemPending = true
  chessState().pwaChessItemContext = {
    ...(ctx || {}),
    chessText: text,
    proposedTitle: pageTitle,
  }
  await runPwaMaterialize({
    bumpGen: () => ++pwaChessItemGen,
    getGen: () => pwaChessItemGen,
    pageTitle,
    fetchResult: () => ensurePwaGamePage({ text, title: pageTitle }),
    isSuccess: result => Boolean(result.slug && result.itemId),
    onSuccess: (result, savedTitle) => {
      delete chessState().pwaJournalless
      delete chessState().pwaChessItemPending
      void BoardLayout.clearPwaLocalSession()
      Object.assign(chessState(), {
        itemId: result.itemId,
        wikiPageName: result.slug,
        wikiPageTitle: savedTitle,
        pageOnThisWiki: result.chessObj?.pageOnThisWiki ?? true,
        ownerCanJournalHere: result.chessObj?.ownerCanJournalHere ?? true,
      })
      const currentText = exportChessText({ liveBoardText: true })
      if (currentText && currentText !== text) {
        putJournal(currentText)
      }
      syncLocalOnlyHalo()
    },
    onError: () => {
      delete chessState().pwaChessItemPending
    },
    warnLabel: 'wiki-chess PWA save-to-wiki:',
    finalizeSuccess: (_result, savedTitle) => {
      syncWikiContext()
      Game.setJournalAutosaveWired(false)
      if (chessConsole) Game.wireJournalAutosave(chessConsole)
      BoardLayout.updatePwaPageChromeStatus('saved', null, savedTitle)
      BoardLayout.updatePwaPageChrome()
      refreshPwaAuthLock()
    },
    afterError: () => {
      BoardLayout.updatePwaPageChrome()
    },
  })
}

function hasPersistedWikiPageSlug() {
  const slug = String(wikiPageSlug() || chessState()?.wikiPageName || '').trim()
  return Boolean(slug && slug !== 'standalone' && slug !== 'page')
}

function showsPwaPageTitleChrome() {
  return Boolean(
    pwaBridgeActive &&
      !chessState()?.showStartMenu &&
      chessState()?.pwaWikiPageChrome &&
      (chessState()?.wikiPageTitle ||
        isPwaJournalless() ||
        chessState()?.pwaChessItemPending ||
        chessState()?.pwaChallengeJoinPending ||
        hasPersistedWikiPageSlug()),
  )
}

function shouldShowStartModalPageTitleField() {
  return showsPwaPageTitleChrome()
}

function syncLinkedPageTitleInputs(next, { fromModal = false, fromPwa = false } = {}) {
  const title = String(next ?? '').trim()
  if (!title) return
  if (!fromModal) {
    const modalInput = document.getElementById('positionStartPageTitle')
    if (shouldShowStartModalPageTitleField() && modalInput && modalInput.value !== title) {
      modalInput.value = title
    }
  }
  if (!fromPwa) {
    const pwaInput = document.getElementById('wikiChessPwaPageTitle')
    if (showsPwaPageTitleChrome() && pwaInput && pwaInput.value !== title) {
      pwaInput.value = title
    }
  }
}

function handlePwaPageTitleInput(next) {
  Game.setStartModalPageTitleDirty(true)
  Game.setStartModalPageTitlePinned(false)
  if (chessState()?.pwaChallengeJoinPending) {
    chessState().wikiPageTitle = next
    syncLinkedPageTitleInputs(next, { fromPwa: true })
    schedulePwaChallengeJoinRetitle(next)
    BoardLayout.updatePwaPageChrome()
    return
  }
  if (isPwaJournalless()) {
    chessState().wikiPageTitle = next
    syncLinkedPageTitleInputs(next, { fromPwa: true })
    persistLocalSession()
    BoardLayout.updatePwaPageChrome()
    return
  }
  if (chessState()?.pwaChessItemPending) {
    chessState().wikiPageTitle = next
    syncLinkedPageTitleInputs(next, { fromPwa: true })
    schedulePwaChessItemRetitle(next)
    BoardLayout.updatePwaPageChrome()
  }
}

const isWikiEmbed = window.parent !== window.self
const isWikiPopup = Boolean(window.opener)
const isPwaStandalone = BoardLayout.isInstalledPwa()
// Popup window or installed PWA — share large-board layout logic
const isPopupLayout = isWikiPopup || isPwaStandalone
// Parent wiki page or popup opener — receives postMessage traffic
const wikiFrame = window.opener || (isWikiEmbed ? window.parent : null)
// Installed PWA wiki bridge — standalone display without wiki parent/opener (see bootInstalledPwa)
let pwaBridgeActive = isPwaStandalone && !isWikiPopup && !isWikiEmbed

BoardLayout.initPwaTransport({
  getWikiFrame: () => wikiFrame,
  isPwaBridgeActive: () => pwaBridgeActive,
  deliverInboundShellMessage: BoardLayout.deliverInboundShellMessage,
  onOpenChallengeJoinPreview: msg => void startPwaOpenChallengeJoinPreview(msg),
  getPwaWikiContext: BoardLayout.getPwaWikiContext,
})

if (isWikiEmbed) {
  document.documentElement.classList.add('wiki-embedded')
  document.body.classList.add('wiki-embedded')
  BoardLayout.setupWikiEmbedHeight()
  setupWikiItemEditForward()
} else if (isPopupLayout) {
  document.documentElement.classList.add('wiki-popup')
  document.body.classList.add('wiki-popup')
  if (isPwaStandalone) {
    document.documentElement.classList.add('wiki-pwa')
    document.body.classList.add('wiki-pwa')
    // Installed PWA window tab: match the wiki site flag (shortcut icon comes from manifest).
    useOriginSiteFavicon()
  }
  BoardLayout.setupPopupLayout()
} else {
  document.documentElement.classList.add('wiki-direct-tab')
  document.body.classList.add('wiki-direct-tab')
}

if (isWikiPopup && wikiFrame) {
  window.addEventListener('beforeunload', () => {
    wikiFrame.postMessage({ action: MSG.POPUP_CLOSED }, window.origin)
  })
}

// Installed PWA ↔ wiki-tab reverse link (PWA is opener/host; wiki embed follows).
let pwaLinkedWikiWindow = null
let pwaLinkedWikiPoll = 0
let pwaLinkedWikiReady = false

function clearPwaLinkedWiki() {
  pwaLinkedWikiReady = false
  pwaLinkedWikiWindow = null
  if (pwaLinkedWikiPoll) {
    window.clearInterval(pwaLinkedWikiPoll)
    pwaLinkedWikiPoll = 0
  }
}

function monitorPwaLinkedWikiClosed() {
  if (pwaLinkedWikiPoll) window.clearInterval(pwaLinkedWikiPoll)
  pwaLinkedWikiPoll = window.setInterval(() => {
    if (!pwaLinkedWikiWindow || pwaLinkedWikiWindow.closed) clearPwaLinkedWiki()
  }, 1000)
}

// Open (or focus) the journaled wiki page without noopener so we remain window.opener.
function openLinkedWikiPage(href) {
  const url = String(href || '').trim()
  if (!pwaBridgeActive || !url || url === '#') return null
  const slug = String(wikiPageSlug() || 'page').trim() || 'page'
  let win = null
  try {
    win = window.open(url, `wiki-chess-linked-${slug}`)
  } catch {
    win = null
  }
  if (!win) return null
  pwaLinkedWikiWindow = win
  pwaLinkedWikiReady = false
  monitorPwaLinkedWikiClosed()
  return win
}

function mirrorBoardToLinkedWiki({ text } = {}) {
  const win = pwaLinkedWikiWindow
  if (!win || win.closed || !pwaBridgeActive || !pwaLinkedWikiReady) return
  const itemId = wikiItemId()
  if (!itemId || itemId === 'standalone') return
  const raw = text || exportChessText({ liveBoardText: true })
  if (!raw) return
  const persisted = canonicalizePersistedChessText(raw)
  try {
    win.postMessage(
      {
        action: MSG.POSITION_CHANGED,
        itemId,
        pageKey: wikiPageSlug(),
        text: persisted,
        mirrorOnly: true,
      },
      window.origin,
    )
  } catch {
    /* tab may have navigated cross-origin */
  }
}

function completePwaLinkedWikiHandshake(event) {
  if (!pwaBridgeActive) return
  const itemId = wikiItemId()
  if (
    !pwaMatchesLinkedWikiTab(
      { itemId, slug: wikiPageSlug() },
      {
        itemId: event.data?.itemId,
        pageKey: event.data?.pageKey,
        slug: event.data?.slug,
      },
    )
  ) {
    return
  }
  const win = event.source
  if (!win || win.closed) return
  pwaLinkedWikiWindow = win
  monitorPwaLinkedWikiClosed()
  try {
    win.postMessage(
      {
        action: MSG.POPUP_READY,
        itemId,
        pageKey: event.data?.pageKey || wikiPageSlug(),
      },
      window.origin,
    )
  } catch {
    return
  }
  pwaLinkedWikiReady = true
  mirrorBoardToLinkedWiki()
}

if (pwaBridgeActive) {
  window.addEventListener('beforeunload', () => {
    try {
      if (pwaLinkedWikiWindow && !pwaLinkedWikiWindow.closed) {
        pwaLinkedWikiWindow.postMessage({ action: MSG.POPUP_CLOSED }, window.origin)
      }
    } catch {
      /* ignore */
    }
  })
}

// Installed PWA only — popup/tab browsing keeps the bundled chess favicon from index.html.
function useOriginSiteFavicon(faviconRev) {
  const rev = String(faviconRev || '').trim()
  const href = rev ? `/favicon.png?v=${encodeURIComponent(rev)}` : '/favicon.png'
  document.querySelectorAll('link[rel~="icon"]').forEach(link => {
    if (link.getAttribute('href') === href) return
    link.setAttribute('href', href)
  })
}

function pgnStampSite() {
  if (chessState()?.pageOnThisWiki && typeof location !== 'undefined' && location.host) {
    return location.host
  }
  return resolvePgnStampSite(chessState())
}

// Viewing site in the address bar — who is actually playing on this screen (iframe loads on current wiki)
function viewingSite() {
  if ((isWikiEmbed || isWikiPopup) && typeof location !== 'undefined' && location.host) {
    return location.host
  }
  return pgnStampSite()
}

// # Local Settings and Preferences

// Personal UI preferences that persist in the browser (localStorage) instead of
// the wiki journal — toggling them must not create a page edit. Directed-invite
// ChallengeTarget stays in the PGN (not here) so opponents see it when they fork.
const PREFERENCE_SETTING_KEYS = [
  'confirmMoves',
  // Live same-device flip — stored per item for refresh mid-game; cleared when the
  // game ends (archived boards default back to don't flip).
  'sameDeviceFlip',
  'sameDeviceFlipPieces',
  'autoAcceptOpponentWikiMoves',
  'autoAcceptOpponentWikiGameEnd',
  'autoAcceptRealtime',
  'muteMoveSounds',
  'enableComments',
  'showAnnotationsBelow',
]

// Comment banner prefs are easy to pollute: older builds defaulted enableComments
// on and every settings persist rewrote the whole prefs blob. v2 drops those
// sticky keys once; afterwards they are only written when the user toggles them.
const LOCAL_PREFS_VERSION = 2
const COMMENT_PREF_KEYS = ['enableComments', 'showAnnotationsBelow']

function localSettingsKey() {
  return `wiki-chess-prefs:${wikiItemId() || 'default'}`
}

// # Color theme (Bootstrap data-bs-theme)

const COLOR_THEME_META_LIGHT = '#99DAFF'
const COLOR_THEME_META_DARK = '#212529'

const COLOR_THEME_UI = Object.freeze({
  auto: {
    icon: 'fa-adjust',
    label: 'Color theme: auto (system)',
  },
  light: {
    icon: 'fa-sun',
    label: 'Color theme: light',
  },
  dark: {
    icon: 'fa-moon',
    label: 'Color theme: dark',
  },
})

let colorThemeMediaQuery = null
let colorThemeMediaHandler = null

function osPrefersDarkTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function loadColorThemePreference() {
  try {
    const raw = localStorage.getItem(COLOR_THEME_STORAGE_KEY)
    if (raw == null) return DEFAULT_COLOR_THEME_ID
    try {
      return normalizeColorThemeId(JSON.parse(raw))
    } catch {
      return normalizeColorThemeId(raw)
    }
  } catch {
    return DEFAULT_COLOR_THEME_ID
  }
}

function saveColorThemePreference(themeId) {
  const next = normalizeColorThemeId(themeId)
  try {
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* localStorage can be unavailable */
  }
  return next
}

function syncColorThemeMediaListener(preference) {
  if (colorThemeMediaQuery && colorThemeMediaHandler) {
    try {
      colorThemeMediaQuery.removeEventListener('change', colorThemeMediaHandler)
    } catch {
      /* older Safari */
      try {
        colorThemeMediaQuery.removeListener(colorThemeMediaHandler)
      } catch {
        /* ignore */
      }
    }
  }
  colorThemeMediaQuery = null
  colorThemeMediaHandler = null
  if (normalizeColorThemeId(preference) !== 'auto') return
  try {
    colorThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    colorThemeMediaHandler = () => applyColorThemePreference('auto', { persist: false })
    colorThemeMediaQuery.addEventListener('change', colorThemeMediaHandler)
  } catch {
    /* matchMedia unavailable */
  }
}

function applyColorThemePreference(preference, { persist = true } = {}) {
  const pref = normalizeColorThemeId(preference)
  if (persist) saveColorThemePreference(pref)
  const resolved = resolveColorTheme(pref, osPrefersDarkTheme())
  document.documentElement.setAttribute('data-bs-theme', resolved)
  document.documentElement.setAttribute('data-wiki-color-theme', pref)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? COLOR_THEME_META_DARK : COLOR_THEME_META_LIGHT)
  syncColorThemeToggleUI(pref)
  syncColorThemeMediaListener(pref)
  return pref
}

function syncColorThemeToggleUI(preference = loadColorThemePreference()) {
  const pref = normalizeColorThemeId(preference)
  const btn = document.getElementById('wikiChessThemeToggle')
  if (!btn) return
  const ui = COLOR_THEME_UI[pref] || COLOR_THEME_UI.auto
  const icon = btn.querySelector('.wiki-chess-theme-toggle-icon')
  if (icon) {
    icon.classList.remove('fa-adjust', 'fa-sun', 'fa-moon')
    icon.classList.add(ui.icon)
  }
  btn.setAttribute('aria-label', ui.label)
  btn.title = ui.label
  btn.dataset.theme = pref
}

function wireColorThemeToggle() {
  if (document.body._wikiColorThemeWired) return
  document.body._wikiColorThemeWired = true
  applyColorThemePreference(loadColorThemePreference(), { persist: false })
  const btn = document.getElementById('wikiChessThemeToggle')
  if (!btn) return
  btn.addEventListener('click', () => {
    applyColorThemePreference(nextColorThemeId(loadColorThemePreference()))
  })
}

function omitCommentPreferenceFlags(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const out = { ...raw }
  for (const key of COMMENT_PREF_KEYS) delete out[key]
  return out
}

// The local viewer is a "guest" when they're browsing a wiki page (embedded iframe
// or popup) that isn't theirs to save — an unauthenticated visitor. Guests still
// play locally and their seat name rides along in the PGN they see, but it never
// persists to the wiki journal. (The installed PWA / standalone window has no wiki
// owner context, so it is never treated as a guest seat.)
// # Auth Lock and Viewer Context

function liveParentAuth() {
  const targets = []
  if (wikiFrame) targets.push(wikiFrame)
  if (window.top && !targets.includes(window.top)) targets.push(window.top)
  let frame = window.parent
  while (frame) {
    if (!targets.includes(frame)) targets.push(frame)
    if (frame === frame.parent) break
    try {
      frame = frame.parent
    } catch {
      break
    }
  }
  for (const target of targets) {
    try {
      const auth = {
        isOwner: Boolean(target.isOwner),
        isAuthenticated: Boolean(target.isAuthenticated),
        ownerName: String(target.ownerName || '').trim(),
      }
      if (auth.isOwner || auth.isAuthenticated || auth.ownerName) return auth
    } catch {
      // Cross-origin frame in the parent chain — try the next candidate.
    }
  }
  return {}
}

function applyViewerContextFromShell(payload) {
  if (!payload || typeof payload !== 'object') return
  payload = normalizeRestoredChessSession(payload)
  if (!chessState()) setChessState({})
  const hadJournalAccess = canWriteJournalHere()
  const signedInDisplayName = payload.signedInDisplayName || payload.ownerName
  if (signedInDisplayName) chessState().signedInDisplayName = signedInDisplayName
  if (typeof payload.pageOnThisWiki === 'boolean') chessState().pageOnThisWiki = payload.pageOnThisWiki
  if (typeof payload.ownerCanJournalHere === 'boolean') chessState().ownerCanJournalHere = payload.ownerCanJournalHere
  if (typeof payload.guestLocalStoragePersist === 'boolean')
    chessState().guestLocalStoragePersist = payload.guestLocalStoragePersist
  if (typeof payload.viewerCanClaimWikiSeat === 'boolean') {
    chessState().viewerCanClaimWikiSeat = payload.viewerCanClaimWikiSeat
  }
  if (payload.viewerSeatId) chessState().viewerSeatId = payload.viewerSeatId
  if (typeof payload.viewerAuthenticated === 'boolean') {
    chessState().viewerAuthenticated = payload.viewerAuthenticated
  }
  if (payload.faviconRev != null) {
    chessState().faviconRev = payload.faviconRev
    if (isPwaStandalone) useOriginSiteFavicon(payload.faviconRev)
  }
  if (isPuzzleState(chessState())) Puzzle.refreshPuzzleControlVisibility()
  Survey.refreshSurveyIfVisible()
  refreshPwaAuthLock()
  syncPwaAuthGatedControls()
  Game.updateAnnotationPanel()
  if (!hadJournalAccess && canWriteJournalHere() && chessConsole?.state?.chess) {
    notifyWikiPositionChanged()
  }
}

function viewerAuthPayloadChanged(payload) {
  if (!payload || typeof payload !== 'object') return false
  payload = normalizeRestoredChessSession(payload)
  const cur = chessState() || {}
  for (const key of [
    'pageOnThisWiki',
    'ownerCanJournalHere',
    'guestLocalStoragePersist',
    'signedInDisplayName',
    'viewerCanClaimWikiSeat',
    'viewerSeatId',
    'viewerAuthenticated',
    'faviconRev',
  ]) {
    if (payload[key] !== undefined && payload[key] !== cur[key]) return true
  }
  return false
}

// Popup, installed PWA, and direct /plugins/chess/ tab — anywhere without the wiki footer lock.
function showAuthLockSurface() {
  return !isWikiEmbed
}

const PWA_AUTH_LOCK_PAGES = new Set(['start', 'game', 'position', 'puzzle', 'puzzle-author', 'leaderboard'])

const AUTH_LOCK_BOARD_PAGES = new Set(['game', 'position', 'puzzle', 'puzzle-author'])

const AUTH_LOCK_BOARD_SELECTOR = {
  game: '#game .chess-console-board .player.bottom',
  position: '#position .wiki-fen-under-board',
  puzzle: '#puzzle-console-container .chess-console-board',
  'puzzle-author': '#author-console-container .chess-console-board',
}

let pwaSessionReachable = true
let pwaSessionResolved = false
let pwaAuthLockEl = null
let pwaAuthLockPage = null

function setAuthLockIcon(btn, locked) {
  const icon = btn.querySelector('.wiki-chess-auth-lock-icon')
  if (!icon) return
  icon.classList.toggle('fa-lock', locked)
  icon.classList.toggle('fa-lock-open', !locked)
}

function ensurePwaAuthLockEl() {
  if (pwaAuthLockEl) return pwaAuthLockEl
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.id = 'wikiChessAuthLock'
  btn.className = 'wiki-chess-auth-lock wiki-chess-auth-lock-corner'
  btn.hidden = true
  const icon = document.createElement('i')
  icon.className = 'fas fa-lock fa-fw wiki-chess-auth-lock-icon'
  icon.setAttribute('aria-hidden', 'true')
  btn.appendChild(icon)
  btn.addEventListener('click', () => {
    if (!canWriteJournalHere()) Game.requestWikiSignIn()
  })
  pwaAuthLockEl = btn
  return btn
}

function authLockBoardAnchor(page) {
  const selector = AUTH_LOCK_BOARD_SELECTOR[page]
  if (!selector) return null
  const pageEl = document.getElementById(page)
  if (!pageEl || pageEl.style.display === 'none') return null
  return pageEl.querySelector(selector)
}

function layoutAuthLock() {
  if (!showAuthLockSurface()) return
  const btn = ensurePwaAuthLockEl()
  const page = pwaAuthLockPage
  if (!page || !PWA_AUTH_LOCK_PAGES.has(page)) {
    btn.hidden = true
    return
  }

  const boardMount = AUTH_LOCK_BOARD_PAGES.has(page) ? authLockBoardAnchor(page) : null
  if (boardMount) {
    boardMount.classList.add('wiki-chess-auth-lock-mount')
    btn.classList.remove('wiki-chess-auth-lock-corner')
    btn.classList.add('wiki-chess-auth-lock-on-board')
    btn.classList.toggle('wiki-chess-auth-lock-inline', page === 'game')
    btn.classList.toggle('wiki-chess-auth-lock-below-board', page === 'puzzle' || page === 'puzzle-author')
    btn.classList.toggle('wiki-chess-auth-lock-in-row', page === 'position')
    btn.style.removeProperty('top')
    btn.style.removeProperty('right')
    btn.style.removeProperty('left')
    btn.style.removeProperty('transform')
    if (btn.parentElement !== boardMount) boardMount.appendChild(btn)
    return
  }

  btn.classList.remove(
    'wiki-chess-auth-lock-on-board',
    'wiki-chess-auth-lock-inline',
    'wiki-chess-auth-lock-below-board',
    'wiki-chess-auth-lock-in-row',
  )
  btn.classList.add('wiki-chess-auth-lock-corner')
  if (btn.parentElement !== document.body) document.body.appendChild(btn)
  btn.style.removeProperty('top')
  btn.style.removeProperty('right')
  btn.style.removeProperty('left')
  btn.style.removeProperty('transform')
}

function scheduleAuthLockLayout() {
  layoutAuthLock()
  window.requestAnimationFrame(layoutAuthLock)
  for (const delay of [0, 50, 150, 400, 900]) {
    window.setTimeout(layoutAuthLock, delay)
  }
}

function pwaAuthGateTitle() {
  if (!pwaBridgeActive) return WIKI_AUTH_REQUIRED_TITLE
  if (!pwaSessionResolved) return 'Checking sign-in status…'
  if (!pwaSessionReachable) {
    return 'Offline — reconnect, then sign in to save changes to your wiki'
  }
  if (isPwaJournalless()) {
    return 'Sign in on your wiki to save this to your journal — available again once you authenticate.'
  }
  return WIKI_AUTH_REQUIRED_TITLE
}

function syncPwaAuthGatedControls() {
  if (!pwaBridgeActive) return
  ChooseMenu.syncChooseMenuAuthGatedButtons()
  Puzzle.refreshPuzzleControlVisibility()
  Position.updatePositionSaveButton()
}

function refreshPwaAuthLock() {
  const finish = () => {
    syncLocalOnlyHalo()
    BoardLayout.updatePwaPageChrome()
  }
  if (!showAuthLockSurface()) {
    finish()
    return
  }
  const btn = ensurePwaAuthLockEl()
  if (!btn.querySelector('.wiki-chess-auth-lock-icon')) {
    finish()
    return
  }

  if (!pwaAuthLockPage || !PWA_AUTH_LOCK_PAGES.has(pwaAuthLockPage)) {
    btn.hidden = true
    finish()
    return
  }

  if (btn.parentElement !== document.body) document.body.appendChild(btn)
  btn.hidden = false

  if (!pwaSessionResolved) {
    setAuthLockIcon(btn, true)
    btn.title = 'Checking sign-in status…'
    btn.disabled = true
    btn.setAttribute('aria-label', btn.title)
    scheduleAuthLockLayout()
    syncPwaAuthGatedControls()
    finish()
    return
  }

  if (!pwaSessionReachable) {
    setAuthLockIcon(btn, true)
    btn.title = 'Offline — reconnect, then sign in to save changes to your wiki'
    btn.disabled = false
    btn.setAttribute('aria-label', btn.title)
    scheduleAuthLockLayout()
    syncPwaAuthGatedControls()
    finish()
    return
  }

  if (canWriteJournalHere()) {
    const name = resolvedViewerOwnerName() || String(chessState()?.signedInDisplayName || '').trim() || 'wiki owner'
    setAuthLockIcon(btn, false)
    if (isPwaJournalless()) {
      btn.title = `Signed in as ${name} — saved on this device only until you tap Save to wiki`
    } else {
      btn.title = `Signed in as ${name} — changes save to your wiki`
    }
    btn.disabled = true
    btn.setAttribute('aria-label', btn.title)
    scheduleAuthLockLayout()
    syncPwaAuthGatedControls()
    finish()
    return
  }

  if (isPwaJournalless()) {
    setAuthLockIcon(btn, true)
    btn.title = pwaBridgeActive
      ? 'Sign in to save this session to your wiki'
      : 'Playing locally — sign in to save this activity to your wiki'
    btn.disabled = false
    btn.setAttribute('aria-label', btn.title)
    scheduleAuthLockLayout()
    syncPwaAuthGatedControls()
    finish()
    return
  }

  setAuthLockIcon(btn, true)
  btn.title = pwaBridgeActive
    ? 'Sign in to save changes to your wiki'
    : 'Wiki owner sign-on — open wiki to sign in so changes stick'
  btn.disabled = false
  btn.setAttribute('aria-label', btn.title)
  scheduleAuthLockLayout()
  syncPwaAuthGatedControls()
  finish()
}

function mountPwaAuthLock(page) {
  pwaAuthLockPage = page
  refreshPwaAuthLock()
}

async function refreshPwaSessionFromBridge() {
  if (!pwaBridgeActive) return
  try {
    const session = await BoardLayout.fetchPwaSession()
    pwaSessionReachable = true
    pwaSessionResolved = true
    if (viewerAuthPayloadChanged(session)) {
      applyViewerContextFromShell(session)
    } else {
      refreshPwaAuthLock()
    }
  } catch {
    pwaSessionReachable = false
    pwaSessionResolved = true
    refreshPwaAuthLock()
  }
}

function wirePwaAuthLock() {
  if (!showAuthLockSurface() || document.body._wikiPwaAuthWired) return
  document.body._wikiPwaAuthWired = true
  window.addEventListener('resize', scheduleAuthLockLayout, { passive: true })
  // After signing in via the wiki tab, re-check session when this surface is focused.
  if (pwaBridgeActive) {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshPwaSessionFromBridge()
    }
    window.addEventListener('focus', () => {
      void refreshPwaSessionFromBridge()
    })
    document.addEventListener('visibilitychange', onVisible)
  } else {
    // Popup / direct tab: auth arrives via shell SET_STATE / VIEWER_CONTEXT, not /session.
    pwaSessionResolved = true
    pwaSessionReachable = true
  }
  refreshPwaAuthLock()
}

function requestViewerContextFromShell(timeoutMs = 500) {
  if (!wikiFrame) return Promise.resolve(null)
  return new Promise(resolve => {
    const itemId = chessState()?.itemId || wikiItemId()
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onReply)
      resolve(null)
    }, timeoutMs)
    const onReply = event => {
      if (event.origin !== window.origin) return
      if (event.data?.action !== MSG.VIEWER_CONTEXT) return
      if (itemId && event.data?.itemId && event.data.itemId !== itemId) return
      window.clearTimeout(timer)
      window.removeEventListener('message', onReply)
      resolve(event.data)
    }
    window.addEventListener('message', onReply)
    wiki.requestViewerContext(itemId)
  })
}

function resolvedViewerOwnerName() {
  const live = liveParentAuth()
  return resolveSignedInUsername(live.ownerName || chessState()?.signedInDisplayName)
}

function viewerCanJournalAsOwner() {
  if (chessState()?.pageOnThisWiki || chessState()?.ownerCanJournalHere || chessState()?.viewerCanClaimWikiSeat) {
    return true
  }
  const live = liveParentAuth()
  if (!live.isAuthenticated || !live.isOwner) return false
  return Boolean(resolvedViewerOwnerName())
}

function syncViewerAuthFromParent() {
  if (!wikiFrame) return
  const live = liveParentAuth()
  if (!live.isAuthenticated || !live.isOwner) return
  const name = resolvedViewerOwnerName()
  if (!name) return
  if (!chessState()) setChessState({})
  if (live.ownerName) chessState().signedInDisplayName = live.ownerName
  chessState().viewerCanClaimWikiSeat = true
  chessState().viewerSeatId = formatPlayerId(name, viewingSite())
}

function isGuestViewer() {
  return Boolean(wikiFrame) && !viewerCanJournalAsOwner()
}

// Guest display name remembered across games in this browser (not per-item, and
// never journaled). Defaults to "Guest" until the visitor edits their seat name.
// Stored as a JSON string (not a bare word) because FedWiki's "Local Changes" plugin
// blindly JSON.parses every localStorage key — a raw "Guest" value would throw there and
// blank out the whole Local Changes list, hiding legitimate local page edits.
const GUEST_NAME_STORAGE_KEY = 'wiki-chess-guest-name'

function readStoredGuestName() {
  const raw = localStorage.getItem(GUEST_NAME_STORAGE_KEY)
  if (raw == null) return raw
  const parsed = JSON.parse(raw)
  return typeof parsed === 'string' ? parsed : null
}

function guestPlayerName() {
  try {
    return guestSeatName(readStoredGuestName())
  } catch {
    return GUEST_PLAYER_NAME
  }
}

function rememberGuestPlayerName(name) {
  try {
    localStorage.setItem(GUEST_NAME_STORAGE_KEY, JSON.stringify(guestSeatName(name)))
  } catch {
    // localStorage can be unavailable (private mode); the name just won't persist.
  }
}

function loadLocalSettingPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(localSettingsKey()) || '{}')
    const version = Number(parsed?.prefsVersion) || 1
    const prefs = {}
    for (const key of PREFERENCE_SETTING_KEYS) {
      if (typeof parsed?.[key] === 'boolean') prefs[key] = parsed[key]
    }
    if (version < LOCAL_PREFS_VERSION) {
      // Drop comment flags baked in under the old enableComments:true default.
      for (const key of COMMENT_PREF_KEYS) delete prefs[key]
      try {
        localStorage.setItem(localSettingsKey(), JSON.stringify({ ...prefs, prefsVersion: LOCAL_PREFS_VERSION }))
      } catch {
        // private mode — migration is best-effort
      }
    }
    return prefs
  } catch {
    return {}
  }
}

function saveLocalSettingPrefs(settings, { persistCommentPrefs = false } = {}) {
  try {
    let prev = {}
    try {
      prev = JSON.parse(localStorage.getItem(localSettingsKey()) || '{}') || {}
    } catch {
      prev = {}
    }
    const prefs = { ...prev, prefsVersion: LOCAL_PREFS_VERSION }
    for (const key of PREFERENCE_SETTING_KEYS) {
      if (COMMENT_PREF_KEYS.includes(key) && !persistCommentPrefs) continue
      if (typeof settings?.[key] === 'boolean') prefs[key] = settings[key]
    }
    localStorage.setItem(localSettingsKey(), JSON.stringify(prefs))
  } catch {
    // localStorage can be unavailable (private mode); preferences just won't persist.
  }
}

function gameSettings() {
  // Site defaults < PGN `[Comments]` < item JSON (non-comment) < local prefs.
  // Comment flags are omitted from the session/item layer so an old shell default
  // or a prior persist cannot force the banner on without a tag or user toggle.
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  return mergeGameSettings(
    mergeGameSettings(
      mergeGameSettings(siteGameSettingDefaults(viewingSite()), pgnGameSettingDefaults(pgn)),
      omitCommentPreferenceFlags(chessState()?.gameSettings),
    ),
    loadLocalSettingPrefs(),
  )
}

function persistGameSettings(settings = gameSettings(), { persistCommentPrefs = false } = {}) {
  const normalized = normalizeGameSettings(settings)
  const prev = normalizeGameSettings(chessState()?.gameSettings)
  chessState().gameSettings = normalized
  // Preference toggles persist locally — survive a refresh with no journal entry.
  // Comment banner keys only rewrite when the user toggles those checkboxes.
  saveLocalSettingPrefs(normalized, { persistCommentPrefs })
  // Session-only item mirror for challengeCreatorColor (invite target is PGN ChallengeTarget).
  if (wikiFrame && chessState()?.pageOnThisWiki && prev.challengeCreatorColor !== normalized.challengeCreatorColor) {
    wiki.gameSettingsChanged({ gameSettings: normalized })
  }
}

// Same-device flip is a live-play preference (localStorage per item). Once the game
// has a final result, drop it so archived boards default to don't flip. Cleared once
// per item per session — the settings panel can re-enable flip for review afterward.
let ephemeralFlipResetKey = null

function ensureEphemeralFlipPrefsForGameLifecycle() {
  const key = String(wikiItemId() || 'default')
  const over = Boolean(Game.currentGameOutcome()?.over)
  if (!over) {
    if (ephemeralFlipResetKey === key) ephemeralFlipResetKey = null
    return
  }
  if (!isSameDeviceHumanPlay(chessState())) return
  if (ephemeralFlipResetKey === key) return
  ephemeralFlipResetKey = key

  const prefs = loadLocalSettingPrefs()
  const stateSettings = normalizeGameSettings(chessState()?.gameSettings)
  if (
    !stateSettings.sameDeviceFlip &&
    !stateSettings.sameDeviceFlipPieces &&
    !prefs.sameDeviceFlip &&
    !prefs.sameDeviceFlipPieces
  ) {
    return
  }

  const next = mergeGameSettings(gameSettings(), {
    sameDeviceFlip: false,
    sameDeviceFlipPieces: false,
  })
  persistGameSettings(next)
  if (chessConsole) {
    settleBoardAfterPassAndPlayToggle()
    Game.applyOppositeSidesPieceFlip()
  }
  syncGameSettingsUI()
}

function syncSameDeviceSettingRow(el, { enabled, checked, disabledTitle }) {
  if (!el) return
  el.disabled = !enabled
  el.checked = Boolean(enabled && checked)
  const row = el.closest('.form-check')
  if (!row) return
  row.classList.toggle('wiki-chess-setting-disabled', !enabled)
  if (!enabled && disabledTitle) row.title = disabledTitle
  else row.removeAttribute('title')
}

function readSameDeviceFlipMode() {
  const checked = document.querySelector('input[name="settingSameDeviceFlipMode"]:checked')
  const value = checked?.value
  if (value === 'board' || value === 'pieces' || value === 'none') return value
  return 'none'
}

function syncSameDeviceFlipModeGroup({ sameDevice, shapesSelected, settings }) {
  const group = document.getElementById('settingSameDeviceFlipModeGroup')
  const noneEl = document.getElementById('settingSameDeviceFlipNone')
  const flipEl = document.getElementById('settingSameDeviceFlip')
  const flipPiecesEl = document.getElementById('settingSameDeviceFlipPieces')
  const piecesEnabled = sameDevice && !shapesSelected
  // Prefer board flip when both flags somehow co-exist; otherwise pieces, else none.
  let mode = 'none'
  if (sameDevice) {
    if (settings.sameDeviceFlip) mode = 'board'
    else if (settings.sameDeviceFlipPieces && piecesEnabled) mode = 'pieces'
  }
  syncSameDeviceSettingRow(noneEl, {
    enabled: sameDevice,
    checked: mode === 'none',
    disabledTitle: 'Same-device turn orientation is only available when both players share one device.',
  })
  syncSameDeviceSettingRow(flipEl, {
    enabled: sameDevice,
    checked: mode === 'board',
    disabledTitle: 'Pass-and-play is only available when both players share one device (chosen at game setup).',
  })
  syncSameDeviceSettingRow(flipPiecesEl, {
    enabled: piecesEnabled,
    checked: mode === 'pieces',
    disabledTitle: shapesSelected
      ? 'Shapes pieces stay upright for both seats — flip in place is not used.'
      : 'Flip pieces in place is only available for same-device games (opposite sides at game setup).',
  })
  if (!group) return
  group.classList.toggle('wiki-chess-setting-disabled', !sameDevice)
  if (!sameDevice) {
    group.title = 'Same-device turn orientation is only available when both players share one device.'
  } else {
    group.removeAttribute('title')
  }
}

function syncGameSettingsUI() {
  const settings = gameSettings()
  const panel = document.getElementById('wikiChessGameSettings')
  const confirmEl = document.getElementById('settingConfirmMoves')
  const onGamePage = document.getElementById('game')?.style.display !== 'none'
  const show = onGamePage && Boolean(chessConsole)
  if (panel) panel.hidden = !show
  if (confirmEl) confirmEl.checked = settings.confirmMoves
  // Same-device-only affordances: visible but greyed out for remote/engine games.
  // Title sits on the row since a disabled input doesn't reliably show its own tooltip.
  const sameDevice = isSameDeviceHumanPlay(chessState())
  const shapesSelected = !pieceSetAllowsInPlaceFlip(loadPieceSetPreference())
  syncSameDeviceFlipModeGroup({ sameDevice, shapesSelected, settings })
  // Auto-accept only applies to remote (different-device) human games — hide it otherwise.
  const autoAcceptRow = document.getElementById('settingAutoAcceptRemoteRow')
  const autoAcceptEl = document.getElementById('settingAutoAcceptRemote')
  const autoEndRow = document.getElementById('settingAutoAcceptRemoteEndRow')
  const autoEndEl = document.getElementById('settingAutoAcceptRemoteEnd')
  const autoRtcRow = document.getElementById('settingAutoAcceptRealtimeRow')
  const autoRtcEl = document.getElementById('settingAutoAcceptRealtime')
  if (autoAcceptRow) autoAcceptRow.hidden = !Realtime.isRemoteHumanGame()
  if (autoEndRow) autoEndRow.hidden = !Realtime.isRemoteHumanGame()
  if (autoRtcRow) autoRtcRow.hidden = !Realtime.isRemoteHumanGame()
  if (autoAcceptEl) autoAcceptEl.checked = settings.autoAcceptOpponentWikiMoves
  if (autoEndEl) autoEndEl.checked = settings.autoAcceptOpponentWikiGameEnd
  if (autoRtcEl) {
    autoRtcEl.checked = settings.autoAcceptRealtime
    autoRtcEl.disabled = !settings.autoAcceptOpponentWikiMoves
  }
  Realtime.updateRealtimePresenceIndicator()
  const muteEl = document.getElementById('settingMuteMoveSounds')
  if (muteEl) muteEl.checked = settings.muteMoveSounds
  const commentsEl = document.getElementById('settingEnableComments')
  if (commentsEl) commentsEl.checked = settings.enableComments
  const annotationsEl = document.getElementById('settingShowAnnotationsBelow')
  if (annotationsEl) annotationsEl.checked = settings.showAnnotationsBelow
  syncBoardSettingsUI()
  syncPieceSetPickersUI()
}

function syncBoardSettingsUI() {
  const onPosition = document.getElementById('position')?.style.display !== 'none'
  const onPuzzle =
    document.getElementById('puzzle')?.style.display !== 'none' ||
    document.getElementById('puzzle-author')?.style.display !== 'none'
  document.querySelectorAll('.wiki-chess-board-settings-drawer').forEach(panel => {
    panel.hidden = !(onPosition || onPuzzle)
  })
}

function settleBoardAfterPassAndPlayToggle() {
  if (!chessConsole) return
  if (shouldRotateBoardForSideToMove(chessState())) {
    Game.applyPassAndPlayOrientation()
    return
  }
  // Pass-and-play turned off mid-game: settle the board to a fixed orientation
  // (local seat at the bottom) rather than leaving it rotated mid-flip.
  const seat = Game.localPlayerSeatColor()
  if (chessConsole.state.orientation !== seat) {
    chessConsole.state.orientation = seat
  } else {
    const board = chessConsole.components.board
    if (board) Game.renderWikiPlayerLabels(board, chessConsole)
  }
}

function wireGameSettingsPanel() {
  if (document.body._wikiGameSettingsWired) return
  document.body._wikiGameSettingsWired = true

  const panel = document.getElementById('wikiChessGameSettings')
  const confirmEl = document.getElementById('settingConfirmMoves')
  const flipModeGroup = document.getElementById('settingSameDeviceFlipModeGroup')
  const autoAcceptEl = document.getElementById('settingAutoAcceptRemote')
  const autoEndEl = document.getElementById('settingAutoAcceptRemoteEnd')
  const autoRtcEl = document.getElementById('settingAutoAcceptRealtime')
  const muteEl = document.getElementById('settingMuteMoveSounds')
  const commentsEl = document.getElementById('settingEnableComments')
  const annotationsEl = document.getElementById('settingShowAnnotationsBelow')

  const onChange = () => {
    const flipMode = readSameDeviceFlipMode()
    const next = mergeGameSettings(gameSettings(), {
      confirmMoves: Boolean(confirmEl?.checked),
      sameDeviceFlip: flipMode === 'board',
      sameDeviceFlipPieces: flipMode === 'pieces',
      autoAcceptOpponentWikiMoves: Boolean(autoAcceptEl?.checked),
      autoAcceptOpponentWikiGameEnd: Boolean(autoEndEl?.checked),
      autoAcceptRealtime: Boolean(autoRtcEl?.checked) && Boolean(autoAcceptEl?.checked),
      muteMoveSounds: Boolean(muteEl?.checked),
      enableComments: Boolean(commentsEl?.checked),
      showAnnotationsBelow: Boolean(annotationsEl?.checked),
    })
    persistGameSettings(next, { persistCommentPrefs: true })
    settleBoardAfterPassAndPlayToggle()
    Game.applyOppositeSidesPieceFlip()
    // Show/hide the annotation bar immediately when the toggle changes.
    Game.updateAnnotationPanel()
    // Turning auto-accept on should immediately fork in any move already waiting.
    Realtime.maybeAutoAcceptPendingRemoteMove()
    Realtime.maybeAutoAcceptPendingRemoteGameEnd()
    // Refresh real-time readiness / auto-consent after settings change.
    Realtime.sendRealtimePresence()
    notifyWikiHeight()
    syncGameSettingsUI()
  }

  confirmEl?.addEventListener('change', onChange)
  flipModeGroup?.addEventListener('change', onChange)
  autoAcceptEl?.addEventListener('change', onChange)
  autoEndEl?.addEventListener('change', onChange)
  autoRtcEl?.addEventListener('change', onChange)
  muteEl?.addEventListener('change', onChange)
  annotationsEl?.addEventListener('change', onChange)
  commentsEl?.addEventListener('change', onChange)
  panel?.addEventListener('toggle', () => notifyWikiHeight())
}

// moved to game.js

function shouldDeferStockfishSetup(state = chessState()) {
  return sessionShouldDeferStockfishSetup(chessSession.getState(), state)
}

function pickAppStateBasics(state = chessState()) {
  const localOnly = Boolean(state?.pwaJournalless)
  const basics = {
    signedInDisplayName: state?.signedInDisplayName || state?.ownerName,
    wikiSite: state?.wikiSite,
    wikiSiteUrl: state?.wikiSiteUrl,
    wikiPageName: state?.wikiPageName,
    wikiPageTitle: state?.wikiPageTitle,
    itemId: state?.itemId,
    pageOnThisWiki: state?.pageOnThisWiki,
    guestLocalStoragePersist: state?.guestLocalStoragePersist,
    ownerCanJournalHere: state?.ownerCanJournalHere,
    viewerCanClaimWikiSeat: state?.viewerCanClaimWikiSeat,
    viewerSeatId: state?.viewerSeatId,
    viewerAuthenticated: state?.viewerAuthenticated,
    wikiGhostPage: state?.wikiGhostPage,
    createPreviewPendingJournal: state?.createPreviewPendingJournal,
  }
  // Keep PWA page chrome / materialize flags across CHOOSE → game/position/puzzle boots
  // so create-game can finish and the title can become a wiki-page link.
  if (state?.pwaWikiPageChrome) basics.pwaWikiPageChrome = true
  if (state?.pwaChessItemContext) basics.pwaChessItemContext = state.pwaChessItemContext
  if (state?.pwaChessItemPending) basics.pwaChessItemPending = true
  if (state?.pwaChallengeJoinPending) basics.pwaChallengeJoinPending = true
  if (state?.pwaChallengeJoinContext) basics.pwaChallengeJoinContext = state.pwaChallengeJoinContext
  if (localOnly) {
    basics.pwaJournalless = true
    // Local-only PWA sessions must not inherit wiki item linkage for autosave routing.
    delete basics.itemId
    delete basics.wikiPageName
    delete basics.wikiGhostPage
    delete basics.createPreviewPendingJournal
  }
  return basics
}

// Board fit / layout / resize (popup/PWA window auto-resize, wiki-embed height
// reporting, board coordinate mode) were extracted to src/board-layout.js
// and are initialized via BoardLayout.initBoardLayout below.

// # Boot and Document Ready

function whenDocumentReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true })
  } else {
    fn()
  }
}

function requestWikiState() {
  if (!wikiFrame) return
  wiki.getState()
}

// The security plugin resolves isOwner asynchronously (client-settings.json). The
// chess iframe can load first with pageOnThisWiki=false and stay stuck as "Guest" until
// the shell pushes a fresh SET_STATE.
function maybeRefreshStaleViewerState() {
  if (!wikiFrame || isWikiPopup) return
  syncViewerAuthFromParent()
  if (viewerCanJournalAsOwner() && resolvedViewerOwnerName()) return
  requestWikiState()
}

// PWA + popup context / state / lifecycle live in board-layout.js and are
// initialized via BoardLayout.initPwaPopup below.

whenDocumentReady(() => {
  // Seat-row kings on My Chess Games use in-document `#wk`/`#bk`. Prefetch even when no
  // board mounts this session so survey rows are not blank SVG placeholders.
  void ensurePieceSpriteCached(getPieceSpritesUrl()).catch(() => {})
  Game.wireExportControls()
  wireGameSettingsPanel()
  wirePieceSetPickers()
  wireColorThemeToggle()
  wireFooterActions()
  const intent = BoardLayout.resolveBootIntent({
    hasWikiFrame: Boolean(wikiFrame),
    isWikiPopup,
    isPwaStandalone,
  })
  if (intent === 'Embed') {
    wirePwaAuthLock()
    requestWikiState()
    void requestViewerContextFromShell().then(applyViewerContextFromShell)
    for (const delay of VIEWER_CONTEXT_RETRY_DELAYS_MS) {
      window.setTimeout(maybeRefreshStaleViewerState, delay)
    }
    BoardLayout.reportPwaInstalled()
    window.addEventListener('focus', BoardLayout.reportPwaInstalled)
    return
  }
  if (intent === 'WikiPopup') {
    void BoardLayout.registerServiceWorker()
    BoardLayout.initInstallNudge()
    const params = new URLSearchParams(location.search)
    wiki.popupReady({
      itemId: params.get('itemId'),
      pageKey: params.get('pageKey'),
    })
    window.setTimeout(BoardLayout.restorePopupWithoutOpener, POPUP_OPENER_TIMEOUT_MS)
    wirePwaAuthLock()
    return
  }
  if (intent === 'InstalledPwa') {
    BoardLayout.markChessPwaInstalled()
    void bootInstalledPwa()
    return
  }
  void BoardLayout.registerServiceWorker()
  wirePwaAuthLock()
  BoardLayout.initInstallNudge()
  BoardLayout.bootStandalone()
})

async function bootInstalledPwa() {
  BoardLayout.setPwaContextChangedHandler(syncWikiContext)
  await BoardLayout.registerServiceWorker()
  ChooseMenu.syncChooseMenuFederationButtons()
  syncPwaAuthGatedControls()
  Puzzle.refreshPuzzleControlVisibility()
  Survey.refreshSurveyIfVisible()
  wirePwaAuthLock()

  const params = new URLSearchParams(location.search)
  const pageKey = params.get('pageKey') || 'standalone'
  const itemId = params.get('itemId') || 'standalone'
  BoardLayout.setPwaWikiContext({ slug: pageKey, itemId })

  if (pwaBridgeActive) {
    // Resolve wiki auth before BoardLayout.bootPwa/initializeChess so a later state replace cannot
    // wipe signed-in flags and leave the padlock stuck locked.
    try {
      const session = normalizeRestoredChessSession(await BoardLayout.fetchPwaSession())
      pwaSessionReachable = true
      pwaSessionResolved = true
      applyViewerContextFromShell(session)
      if (!chessState()) setChessState({})
      chessState().signedInDisplayName =
        session.signedInDisplayName || session.ownerName || chessState().signedInDisplayName
      chessState().pageOnThisWiki = session.pageOnThisWiki
      chessState().ownerCanJournalHere = session.ownerCanJournalHere
      chessState().viewerCanClaimWikiSeat = session.viewerCanClaimWikiSeat
      chessState().viewerAuthenticated = session.viewerAuthenticated
      if (session.faviconRev != null) chessState().faviconRev = session.faviconRev
    } catch {
      pwaSessionReachable = false
      pwaSessionResolved = true
      refreshPwaAuthLock()
    }
    if (pageKey !== 'standalone' && itemId !== 'standalone') {
      try {
        const data = await BoardLayout.loadPwaGameState(pageKey, itemId)
        if (data?.chessObj) {
          markShellStateReceived()
          initializeChess({
            ...data.chessObj,
            itemId: data.itemId || itemId,
            pwaJournalless: false,
          })
          hideAppLoadingScreen()
          wiki.requestViewerContext(itemId)
          return
        }
      } catch {
        /* fall through to menu */
      }
    }
    wiki.requestViewerContext(itemId)
  }

  if (!sessionHasReceivedInitialState(chessSession.getState())) {
    await BoardLayout.bootPwa()
  }
}

// # App Shell Message Handlers

const appShellMessageHandlers = {
  [MSG.WIKI_TAB_READY](event) {
    whenDocumentReady(() => completePwaLinkedWikiHandshake(event))
  },
  [MSG.SET_STATE](event) {
    whenDocumentReady(() => {
      const replaceInPlace = Boolean(event.data?.replaceInPlace)
      const incoming = event.data?.chessObj
      let state = normalizeRestoredChessSession(incoming && typeof incoming === 'object' ? incoming : {})
      if (event.data?.itemId) {
        state.itemId = event.data.itemId
      }
      applyWikiItemTextFromShell(event.data?.wikiItemText, state)
      if (shouldDeferNewGameSetup()) {
        hideAppLoadingScreen()
        return
      }
      if (shouldDeferStockfishSetup(state) && !state.patchStateOnly && !replaceInPlace) {
        hideAppLoadingScreen()
        return
      }
      markShellStateReceived()

      // Wiki SURVEY/LEADERBOARD embeds never follow popup/PWA into CHOOSE or a game.
      const prev = chessState()
      const wikiItemText = String(event.data?.wikiItemText ?? prev?.chessState ?? '')
      const lockedMaintenance =
        Boolean(wikiFrame) &&
        !isWikiPopup &&
        (isMaintenanceChessItemText(wikiItemText) || isMaintenanceChessState(prev))
      if (lockedMaintenance) {
        const incomingMaintenance =
          isMaintenanceChessItemText(String(state.chessState || state.PGN || '')) || isMaintenanceChessState(state)
        setSessionFollowsPopup(false)
        if (!incomingMaintenance) {
          if (viewerAuthPayloadChanged(state)) applyViewerContextFromShell(state)
          hideAppLoadingScreen()
          if (wikiFrame && !isWikiPopup) notifyWikiHeight()
          return
        }
        // Same maintenance view — strip follower flag; continue with normal apply/boot.
        if (incoming) incoming.followsPopup = false
        state.followsPopup = false
      }

      if (state.patchStateOnly) {
        setSessionFollowsPopup(Boolean(incoming?.followsPopup))
        // Auth/owner flags can change without item text changing (sign-in without reload).
        // Detect before Realtime.applySyncedPosition merges them into chessState.
        const authDirty = viewerAuthPayloadChanged(state)
        const refreshAuthFromShell = () => {
          if (authDirty) applyViewerContextFromShell(state)
        }
        if (chessState()?.browsingStartMenu) {
          refreshAuthFromShell()
          hideAppLoadingScreen()
          notifyWikiHeight()
          return
        }
        if (chessState()?.showStartMenu && isActivePage('start')) {
          refreshAuthFromShell()
          hideAppLoadingScreen()
          notifyWikiHeight()
          return
        }
        Realtime.applySyncedPosition(state)
        refreshAuthFromShell()
      } else {
        if (replaceInPlace) {
          exitNewGameSetup()
          clearPendingNewGameSetupModal()
          setSessionFollowsPopup(Boolean(incoming?.followsPopup))
        } else {
          setSessionFollowsPopup(false)
        }
        if (sessionShouldReopenGameSetup(chessSession.getState(), state)) {
          if (state.openChallengeSetupPending) {
            enterOpenChallengeSetup(state)
          } else {
            Game.enterNewGameSetup(state, 'keyword')
          }
        } else {
          initializeChess(state)
        }
      }
      // Session handoff only — journal page JSON from the shell is SSOT on refresh.
      BoardLayout.rememberPopupState({
        ...state,
        itemId: state.itemId || wikiItemId(),
      })
      hideAppLoadingScreen()
      if (wikiFrame && !isWikiPopup) notifyWikiHeight()
    })
  },
  [MSG.GET_EXPORT]() {
    // Mirror mode before export so autosave cannot race the popup handoff.
    // Survey/leaderboard embeds never enter follower mode.
    if (!isMaintenanceChessState(chessState())) {
      setSessionFollowsPopup(true)
    }
    const exportedFen = currentPositionFen()
    wiki.stateExported({
      text: exportChessText({ liveBoardText: true }),
      format: chessState()?.format,
      chessObj: exportLiveAppStateForShell(),
      ...(exportedFen ? { fen: exportedFen } : {}),
    })
  },
  [MSG.REMOTE_OPPONENT_STATE](event) {
    whenDocumentReady(() =>
      Realtime.handleRemoteOpponentState(event.data?.text, event.data?.realtime, event.data?.signal),
    )
  },
  [MSG.REALTIME_STATUS](event) {
    whenDocumentReady(() => Realtime.applyMirroredRealtimeStatus(event.data))
  },
  [MSG.REQUEST_REALTIME_STATUS]() {
    whenDocumentReady(() => Realtime.handleRealtimeStatusRequest())
  },
  [MSG.RATING_STATE](event) {
    whenDocumentReady(() => Survey.handleRatingState(event.data))
  },
  [MSG.SURVEY_STATE](event) {
    whenDocumentReady(() => Leaderboard.handleSurveyState(event.data))
  },
  [MSG.CHESS_ITEM_GHOST_SHOWN](event) {
    whenDocumentReady(() => {
      handleExternalCreatePreviewResult(event.data)
    })
  },
  [MSG.LEADERBOARD_DATA](event) {
    whenDocumentReady(() => Survey.handleLeaderboardData(event.data))
  },
  [MSG.LEADERBOARD_PROGRESS](event) {
    whenDocumentReady(() => Survey.handleLeaderboardProgress(event.data))
  },
  [MSG.SURVEY_OPEN_CHALLENGES_DATA](event) {
    whenDocumentReady(() => Survey.handleSurveyOpenChallengesData(event.data))
  },
  [MSG.SURVEY_SITE_GAMES_DATA](event) {
    whenDocumentReady(() => Survey.handleSurveySiteGamesData(event.data))
  },
  [MSG.CHALLENGE_JOIN_FORKED]() {
    whenDocumentReady(() => {
      if (chessState()) {
        delete chessState().challengeJoinGhost
        // Joiner may still carry ChallengeTarget=self from the creator's directed invite.
        const pgn = chessState().PGN || chessState().chessState || ''
        const scrubbed = stripSelfChallengeTarget(pgn, viewingSite())
        if (scrubbed !== formatPgn(pgn)) {
          chessState().PGN = scrubbed
          chessState().chessState = scrubbed
        }
        chessState().gameSettings = mergeGameSettings(chessState().gameSettings, {
          challengeCreatorColor: '',
        })
        persistGameSettings(chessState().gameSettings)
      }
      Game.dismissChallengeJoinGhostBanner()
      BoardLayout.updatePwaPageChrome()
      Realtime.updateRemoteWatch()
    })
  },
  [MSG.ABANDON_FETCHES]() {
    Survey.leaveFederationViews()
  },
  [MSG.REQUEST_RESIGN]() {
    whenDocumentReady(() => {
      if (Game.viewerHoldsResignableSeat()) {
        Game.resignCurrentGame()
      }
    })
  },
  [MSG.APPLY_LINKED_BOARD](event) {
    whenDocumentReady(() => applyLinkedBoardFromFollower(event.data?.text))
  },
  [MSG.REQUEST_SWITCH_GAME_MODE]() {
    whenDocumentReady(() => ChooseMenu.handleMirrorSwitchGameModeRequest())
  },
  [MSG.REQUEST_OPEN_POSITION_EDITOR](event) {
    whenDocumentReady(() => ChooseMenu.handleMirrorOpenPositionEditorRequest(event.data?.fen))
  },
  [MSG.SITE_DISPLAY](event) {
    Game.fulfillSiteDisplayLookup({
      requestId: event.data?.requestId,
      displayName: String(event.data?.displayName || '').trim(),
      valid: event.data?.valid !== false,
      error: String(event.data?.error || '').trim(),
    })
  },
  [MSG.PUZZLE_PAGES_DATA](event) {
    Puzzle.receivePuzzlePagesData(event.data)
  },
  [MSG.PASTE_CAPTURE](event) {
    const text = event.data?.text
    if (!text || !String(text).trim()) return
    whenDocumentReady(() => {
      const canPersist = Boolean(wikiFrame && chessState()?.pageOnThisWiki)
      BoardLayout.confirmPasteFromText(text, {
        surface: 'iframe',
        canPersist,
        persistLabel: canPersist
          ? undefined
          : 'This page is not yours to edit — the board will update here but the wiki item text will not be saved.',
        onApply: confirmed => {
          if (chessState()) chessState().lastPasteCapture = confirmed
          applyPastedItemText(confirmed)
        },
      })
    })
  },
}

const dispatchAppShellMessage = createMessageDispatcher(appShellMessageHandlers)
BoardLayout.initInboundShellMessageBridge({ dispatch: dispatchAppShellMessage })

function syncWikiContext() {
  if (!pwaBridgeActive || !chessState()) return
  const ctx = BoardLayout.getPwaWikiContext()
  if (!ctx.slug || ctx.slug === 'standalone') return
  chessSession.patchChessState({
    itemId: ctx.itemId || chessState().itemId,
    wikiPageName: ctx.slug,
    wikiPageTitle: ctx.title || chessState().wikiPageTitle || ctx.slug,
    pageOnThisWiki: chessState().pageOnThisWiki ?? true,
    ownerCanJournalHere: chessState().ownerCanJournalHere ?? true,
  })
}

// Retarget installed-PWA wiki chrome to a well-known page (My Chess Games / Leaderboards).
function adoptPwaWikiPage({ slug, title, itemId } = {}) {
  if (!pwaBridgeActive || !chessState()) return false
  const nextSlug = String(slug || '').trim()
  const nextTitle = String(title || '').trim()
  const nextItemId = String(itemId || '').trim()
  if (!nextSlug || !nextTitle || !nextItemId) return false

  const prevSlug = String(chessState().wikiPageName || '').trim()
  const prevTitle = String(chessState().wikiPageTitle || '').trim()
  if (prevSlug !== nextSlug || prevTitle !== nextTitle) BoardLayout.clearPwaPageChromeStatus()

  chessState().wikiPageName = nextSlug
  chessState().wikiPageTitle = nextTitle
  chessState().itemId = nextItemId
  chessState().pwaWikiPageChrome = true
  delete chessState().pwaChessItemContext
  delete chessState().pwaChessItemPending
  BoardLayout.setPwaWikiContext({ slug: nextSlug, itemId: nextItemId, title: nextTitle })
  BoardLayout.updatePwaPageChrome()
  return true
}

function adoptPwaSurveyPage() {
  const itemId = SURVEY_PAGE_STORY.find(entry => entry?.type === 'chess')?.id
  return adoptPwaWikiPage({
    slug: SURVEY_PAGE_SLUG,
    title: SURVEY_PAGE_TITLE,
    itemId,
  })
}

function adoptPwaLeaderboardPage() {
  return adoptPwaWikiPage({
    slug: LEADERBOARD_PAGE_SLUG,
    title: LEADERBOARD_PAGE_TITLE,
    itemId: LEADERBOARD_CHESS_ID,
  })
}

function hideAppLoadingScreen() {
  const el = document.getElementById('wiki-chess-loading')
  if (!el || el.hidden) return
  el.hidden = true
  el.setAttribute('aria-hidden', 'true')
}

function notifyWikiHeight() {
  hideAppLoadingScreen()
  window.scheduleWikiHeightReport?.()
}

function openEmbeddedConfirmModal(opts = {}) {
  BoardLayout.openWithEmbeddedMount(openConfirmModal, opts, () => {
    notifyWikiHeight()
    BoardLayout.requestWikiEmbedScrollIntoView()
  })
}

function resetChessApp() {
  chessSession.bumpConsoleGeneration()
  ephemeralFlipResetKey = null
  Game.resetGameRuntimeState()
  Puzzle.invalidatePuzzleConsoles()
  if (chessConsole) {
    chessConsole._wikiStockfishWired = false
    chessConsole._wikiGameControlWired = false
    chessConsole._wikiStockfishStateView = undefined
    try {
      chessConsole.components?.board?.chessboard?.destroy?.()
    } catch {
      /* ignore stale board teardown */
    }
  }
  const container = document.getElementById('console-container')
  if (container) {
    container
      .querySelectorAll(
        '.chess-console-board, .buttons-grid, .chess-console-history, .chess-console-captured, .wiki-chess-captured-summary, .chess-console-notifications',
      )
      .forEach(el => {
        el.innerHTML = ''
      })
  }
  chessConsole = undefined
}

function viewerWikiJoinId() {
  if (!viewerCanJournalAsOwner()) return ''
  const name = resolvedViewerOwnerName()
  if (!name) return ''
  return chessState().viewerSeatId || formatPlayerId(name, viewingSite())
}

function canWriteJournalHere() {
  return Boolean(chessState()?.pageOnThisWiki || chessState()?.ownerCanJournalHere)
}

// moved to game.js

// CHOOSE → "Play New Game": seed a local two-empty-seat board and open the modal.
function commitGhostChessItemText(text) {
  const nextText = String(text || '').trim()
  if (!nextText || !isCreatePreviewContext()) return
  const parsed = parseChessItem(nextText)
  const resolved = resolveChessState(parsed)
  if (chessState()) {
    chessState().chessState = nextText
    Object.assign(chessState(), resolved)
    if (resolved.bareKeywordGuard) {
      chessState().bareKeywordGuard = resolved.bareKeywordGuard
    } else {
      delete chessState().bareKeywordGuard
    }
  }
  if (resolved.bareKeywordGuard) {
    postShellSessionFlags({ bareKeywordGuard: resolved.bareKeywordGuard })
  } else {
    postShellSessionFlags({ bareKeywordGuard: false })
  }
  wiki.syncGhostPreviewText({ text: nextText })
}

// # Journal Gateway and Ghost Sync

let pendingGhostChessItemSync = null

function scheduleGhostChessItemSync({ itemText, title } = {}) {
  if (!itemText && !title) return
  pendingGhostChessItemSync = { itemText, title }
}

function flushGhostChessItemSyncIfReady() {
  if (!pendingGhostChessItemSync || !isCreatePreviewContext()) return
  const { itemText, title } = pendingGhostChessItemSync
  pendingGhostChessItemSync = null
  if (itemText) commitGhostChessItemText(itemText)
  if (title) Game.postGhostPageTitleToWiki(title, { immediate: true })
}

// moved to game.js

function syncGhostChessItemAfterModeBoot({ itemText, title } = {}) {
  scheduleGhostChessItemSync({ itemText, title })
}

function startPuzzleFromMenu({ puzzleText } = {}) {
  ChooseMenu.clearBrowseStartMenuState()
  const meta = buildCreatePreviewMeta('puzzle', { puzzleText })
  const puzzleTitle = meta?.title || 'New Chess Puzzle'
  const itemText = meta?.chessText || puzzleText || 'PUZZLE'
  chessState().wikiPageTitle = puzzleTitle
  Game.setStartModalPageTitlePinned(true)
  initializeChess({
    ...pickAppStateBasics(),
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState: itemText,
    wikiPageTitle: puzzleTitle,
    showStartMenu: false,
  })
  wiki.modeChanged({
    chessObj: {
      gameType: 'puzzle',
      mode: 'PUZZLE',
      format: 'PUZZLE',
      chessState: itemText,
      showStartMenu: false,
    },
  })
  syncGhostChessItemAfterModeBoot({ itemText, title: puzzleTitle })
}

function applyCreatePreviewFallback({ kind, puzzleText } = {}) {
  switch (kind) {
    case 'game':
      Game.startNewGameFromMenu()
      break
    case 'position':
      Position.startPositionFromMenu()
      break
    case 'puzzle':
      startPuzzleFromMenu({ puzzleText })
      break
    default:
      break
  }
}

function clearOpenChallengeSetupFlag() {
  if (chessState()?.openChallengeSetupPending) delete chessState().openChallengeSetupPending
  wiki.shellSessionFlags({ clearOpenChallengeSetupPending: true })
}

const OPEN_CHALLENGE_SETUP_MODAL = {
  title: 'Post open challenge',
  lead: '',
}

function enterOpenChallengeSetup(state) {
  Game.enterNewGameSetup(state, 'survey', {
    defaultOpponent: 'human',
    hideOpponentSelect: true,
    openChallengeSetup: true,
    ...OPEN_CHALLENGE_SETUP_MODAL,
  })
}

function openSurveyOpenChallengeModal() {
  const host = pgnStampSite()
  const pgn = prepareWikiPgn(buildStartPgn({ gameType: 'open', ...Game.wikiPgnContext(host) }), chessState())
  enterOpenChallengeSetup({
    ...pickAppStateBasics(),
    format: 'PGN',
    PGN: pgn,
    chessState: 'GAME',
    gameType: 'open',
    mode: 'GAME',
    bareKeywordGuard: 'GAME',
    showStartMenu: false,
  })
}

function returnToSurveyItemView() {
  const surveyText = String(chessState()?.surveyItemText || chessState()?.chessState || 'SURVEY').trim() || 'SURVEY'
  const surveyItemId = SURVEY_PAGE_STORY.find(entry => entry?.type === 'chess')?.id
  resetChessApp()
  exitNewGameSetup()
  const basics = pickAppStateBasics()
  // Retarget away from the challenge-setup / play page so PWA chrome shows My Chess Games.
  if (pwaBridgeActive && surveyItemId) {
    basics.wikiPageName = SURVEY_PAGE_SLUG
    basics.wikiPageTitle = SURVEY_PAGE_TITLE
    basics.itemId = surveyItemId
    basics.pwaWikiPageChrome = true
    delete basics.pwaChessItemContext
    delete basics.pwaChessItemPending
    delete basics.pwaChallengeJoinContext
    delete basics.pwaChallengeJoinPending
    BoardLayout.clearPwaPageChromeStatus()
    BoardLayout.setPwaWikiContext({
      slug: SURVEY_PAGE_SLUG,
      itemId: surveyItemId,
      title: SURVEY_PAGE_TITLE,
    })
  }
  initializeChess({
    ...basics,
    format: 'SURVEY',
    chessState: surveyText,
    gameType: 'survey',
    mode: 'FULL',
    showStartMenu: false,
    bareKeywordGuard: false,
  })
  postShellSessionFlags({ bareKeywordGuard: false })
  wiki.modeChanged({
    chessObj: {
      format: 'SURVEY',
      gameType: 'survey',
      mode: 'FULL',
      chessState: surveyText,
      showStartMenu: false,
    },
  })
}

function handleExternalCreatePreviewResult(data) {
  if (!pendingExternalCreatePreview) return
  const pending = pendingExternalCreatePreview
  pendingExternalCreatePreview = null
  if (data?.success) {
    if (data?.ghostPageKey) setActiveGhostPageTitleKey(data.ghostPageKey)
    return
  }
  pending.onFailure?.()
}

function requestExternalCreatePreview(kind, { onFailure } = {}) {
  if (!wikiFrame || sessionFollowsPopup()) {
    onFailure?.()
    return
  }
  pendingExternalCreatePreview = { kind, onFailure }
  wiki.createPreview({ kind })
}

// Popup and installed PWA show one chess screen — wiki lineup ghosts are invisible
// there. A forkable ghost page already *is* the new page — switch the current item
// in place rather than forking again.
function isCreatePreviewContext() {
  if (chessState()?.createPreviewPendingJournal || chessState()?.wikiGhostPage) return true
  if (!wikiFrame || isPopupLayout) return false
  if (!isReplaceableGhostPageTitle(chessState()?.wikiPageTitle)) return false
  if (chessState()?.showStartMenu || chessState()?.mode === 'CHOOSE') return true
  // In-place ghost switches (CHOOSE → position/puzzle) keep a replaceable title until
  // the player commits — mode-specific retitles must still reach the lineup ghost page.
  if (chessState()?.mode === 'POSITION' || chessState()?.gameType === 'position') return true
  if (chessState()?.mode === 'PUZZLE' || chessState()?.gameType === 'puzzle') return true
  return false
}

function resolveGhostPageTitleKey() {
  if (activeGhostPageTitleKey) return activeGhostPageTitleKey
  const urlKey = String(new URLSearchParams(location.search).get('pageKey') || '').trim()
  if (urlKey && urlKey !== 'standalone' && urlKey !== 'page') return urlKey
  return null
}

// Paste onto SURVEY/LEADERBOARD (and similar) may spawn a lineup ghost; popup/PWA
// and pages that already are create-preview ghosts cannot.
function canSpawnLineupGhostPage() {
  if (isCreatePreviewContext()) return false
  return Boolean(wikiFrame && !isPopupLayout)
}

// CHOOSE menu → switch this item in place. Installed PWA always starts device-local
// (same as wiki: bare keywords / open boards do not hit the origin until a real persist).
// Signed-in sessions promote via Save to wiki or the first putJournal that passes
// shouldPersistChessItemText (seats, moves, puzzle filters, …).
function startChessItemFromChooseMenu(kind, { puzzleText } = {}) {
  if (pwaBridgeActive) {
    startPwaLocalSession(kind, { puzzleText })
    return
  }
  applyCreatePreviewFallback({ kind, puzzleText })
}

// Site survey → "Post open challenge": open the shared new-game modal with the
// open-challenge section already selected. Confirm creates a real open-seat game
// page (PGN tags carry seek config).
function startOpenChallengeSetup(_origin = 'survey') {
  if (pwaBridgeActive && !canWriteJournalHere()) return
  if (chessState()) {
    chessState().surveyItemText =
      String(chessState().chessState || chessState().surveyItemText || 'SURVEY').trim() || 'SURVEY'
  }
  openSurveyOpenChallengeModal()
}

// # Puzzle Authoring Entry
//
// The author sets up a position in the FEN editor and records the puzzle line on a
// dedicated board. We store the result in the exact Lichess format Puzzle Mode reads,
// so the rules match: the FEN is the position *before* the setup move, the first move
// the author plays is that setup move (auto-played for the solver), and the remaining
// moves alternate solver / opponent. The item text becomes "PUZZLE\n<CSV row>".

// Puzzle solving + authoring were extracted to src/puzzle.js
// (initialized via Puzzle.initPuzzleMode below). The solver/author build their own
// ChessConsole into the shared `chessConsole` slot, so the context exposes that (and
// `chessState()`) as a getter+setter pair.

function isActivePage(pageId) {
  const page = document.getElementById(pageId)
  if (!page) return false
  return getComputedStyle(page).display !== 'none'
}

function playViewIsReady(page) {
  if (!isActivePage(page)) return false
  switch (page) {
    case 'game':
      return Boolean(chessConsole?.components?.board?.chessboard?.view)
    case 'position':
      return Boolean(fenEditor?.chessboard?.view)
    case 'puzzle':
    case 'puzzle-author':
      return Boolean(document.getElementById('puzzle-console-container')?.querySelector('.chessboard'))
    default:
      return false
  }
}

// Double-click inside the iframe does not bubble to the wiki item in the parent page.
// While a federated crawl is loading on the leaderboard view, forward
// dblclick to the shell so the viewer can interrupt and edit the item text.
function setupWikiItemEditForward() {
  if (!wikiFrame) return
  document.addEventListener('dblclick', event => {
    if (sessionFollowsPopup()) return
    if (event.target.closest('input, textarea, button, a, label, select, [contenteditable="true"], .wiki-modal-root')) {
      return
    }
    if (!isActivePage('leaderboard') || !Survey.isLeaderboardLoading()) return
    event.preventDefault()
    wiki.openItemEditor()
  })
}

const CHOOSE_MODE_BTN_HTML = '<i class="fas fa-exchange-alt fa-fw" aria-hidden="true"></i> Switch Game Mode'
const BACK_TO_MENU_BTN_HTML = '<i class="fas fa-arrow-left fa-fw" aria-hidden="true"></i> Back to menu'

function syncChooseModeButton(chooseBtn, { onGame, hideCompletedRatedNav }) {
  if (!chooseBtn) return
  // Wiki embed/popup: hide mode switch on finished rated games so viewers are not nudged
  // to overwrite journal results. Installed PWA only: offer "Back to menu" (in-app nav).
  const showInAppBackToMenu = pwaBridgeActive && hideCompletedRatedNav
  chooseBtn.classList.toggle('d-none', !onGame || (hideCompletedRatedNav && !pwaBridgeActive))
  const navLabel = showInAppBackToMenu ? 'back' : 'switch'
  if (chooseBtn.dataset.navLabel === navLabel) return
  chooseBtn.dataset.navLabel = navLabel
  chooseBtn.innerHTML = showInAppBackToMenu ? BACK_TO_MENU_BTN_HTML : CHOOSE_MODE_BTN_HTML
  chooseBtn.classList.toggle('btn-outline-secondary', showInAppBackToMenu)
  chooseBtn.classList.toggle('btn-outline-primary', !showInAppBackToMenu)
}

function syncFooterNavVisibility() {
  const gameNav = document.querySelector('#game .wiki-chess-nav-actions')
  const onGame = isActivePage('game')
  const onPosition = isActivePage('position')
  const chooseBtn = document.getElementById('chooseModeBtn')
  const editBtn = document.getElementById('editPositionBtn')
  const myGamesBtn = document.getElementById('wikiChessMyGamesNav')
  const hideCompletedRatedNav = ChooseMenu.hideGameNavForCompletedRated()
  const showMyGamesNav = (isWikiEmbed || isWikiPopup) && !sessionFollowsPopup()
  if (gameNav) {
    // The group lays out via `display: contents` (see .wiki-chess-actions in CSS) so
    // its buttons join the shared action row. Only toggle d-none, never d-flex.
    gameNav.classList.toggle('d-none', !onGame)
  }
  syncChooseModeButton(chooseBtn, { onGame, hideCompletedRatedNav })
  if (editBtn) {
    editBtn.classList.toggle('d-none', !onGame || !chessConsole || hideCompletedRatedNav)
  }
  if (myGamesBtn) {
    myGamesBtn.classList.toggle('d-none', !onGame || !showMyGamesNav)
  }
  const positionMyGamesBtn = document.getElementById('positionMyGamesBtn')
  if (positionMyGamesBtn) {
    positionMyGamesBtn.classList.toggle('d-none', !onPosition || !showMyGamesNav)
  }
  const puzzleMyGamesBtn = document.getElementById('puzzleMyGamesBtn')
  if (puzzleMyGamesBtn) {
    puzzleMyGamesBtn.classList.toggle('d-none', !isActivePage('puzzle') || !showMyGamesNav)
  }
  const fenActions = document.querySelector('#position .wiki-chess-fen-actions')
  if (fenActions) {
    fenActions.classList.toggle('d-none', !onPosition)
  }
  if (onPosition) Position.updatePositionSaveButton()
}

function wireFooterActions() {
  if (document.body._wikiFooterWired) return
  document.body._wikiFooterWired = true

  document.getElementById('chooseModeBtn')?.addEventListener('click', () => ChooseMenu.switchGameModeFromGame())
  Survey.wireMyChessGamesWikiButtons()
  document.getElementById('editPositionBtn')?.addEventListener('click', () => ChooseMenu.openPositionEditorFromGame())
  document.getElementById('resignGameBtn')?.addEventListener('click', () => Game.promptResign())
  document
    .getElementById('positionChooseModeBtn')
    ?.addEventListener('click', () => ChooseMenu.confirmSwitchGameModeFromEditor())
  document.getElementById('positionStartGameActionBtn')?.addEventListener('click', () => Game.openPositionStartPanel())
  document.getElementById('positionCreatePuzzleBtn')?.addEventListener('click', () => Puzzle.createPuzzleFromPosition())
  document.getElementById('positionSaveToWikiBtn')?.addEventListener('click', () => Position.savePositionToWiki())
  document.getElementById('positionFlipBoardBtn')?.addEventListener('click', () => Position.flipPositionBoard())
  document
    .getElementById('wikiChessErrorBackBtn')
    ?.addEventListener('click', () => ChooseMenu.proceedReturnToStartMenu())
}

// moved to game.js

function exportCurrentFen() {
  if (chessConsole?.state?.chess) {
    return chessConsole.state.chess.fenOfPly(chessConsole.state.plyViewed)
  }
  if (fenEditor?.state?.fen) {
    return fenEditor.state.fen.toString()
  }
  return chessState()?.FEN || ''
}

async function copyTextToClipboard(text, button) {
  const value = String(text || '').trim()
  if (!value) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      flashCopyButton(button)
      return true
    }
  } catch {
    /* Android / non-secure contexts often block async clipboard — fall back below */
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    textarea.remove()
    if (ok) {
      flashCopyButton(button)
      return true
    }
  } catch (err) {
    console.error('Failed to copy:', err)
  }
  return false
}

function flashCopyButton(button) {
  if (!button) return
  const icon = button.querySelector('i')
  if (!icon?.classList.contains('fa-copy')) return
  icon.classList.replace('fa-copy', 'fa-check')
  window.setTimeout(() => {
    icon.classList.replace('fa-check', 'fa-copy')
  }, 2000)
}

function commitKeywordItem() {
  if (!chessState()?.bareKeywordGuard) return false
  delete chessState().bareKeywordGuard
  chessState().needsSeed = false
  postShellSessionFlags({ bareKeywordGuard: false })
  return true
}

function journalBlocksAutosave() {
  return Boolean(chessState()?.bareKeywordGuard) || sessionFollowsPopup()
}

function postShellSessionFlags(flags = {}) {
  if (!wikiFrame) return
  wiki.shellSessionFlags(flags)
}

function exportLiveAppStateForShell() {
  if (!chessState()) return {}
  if (chessState().gameType === 'puzzle' || chessState().format === 'PUZZLE' || chessState().mode === 'PUZZLE') {
    const snap = Puzzle.capturePuzzleResumeSnapshot()
    if (snap?.puzzleResume?.currentPuzzleRow || snap?.puzzleResume?.embeddedRow) {
      return { ...pickAppStateBasics(), ...snap }
    }
  }
  const out = { ...pickAppStateBasics() }
  for (const key of [
    'format',
    'mode',
    'gameType',
    'showStartMenu',
    'browsingStartMenu',
    'PGN',
    'FEN',
    'chessState',
    'bareKeywordGuard',
    'needsSeed',
    'humanPlayMode',
    'playerColor',
    'engineLevel',
    'gameSettings',
    'awaitingStockfishSetup',
  ]) {
    if (chessState()[key] !== undefined) out[key] = chessState()[key]
  }
  return out
}

function exportChessText({ liveBoardText = false } = {}) {
  // Resume snapshots exist only so Cancel can restore the previous session — never
  // for opening/replacing a popup (that would boot the old game instead of CHOOSE).
  if (
    !liveBoardText &&
    chessState()?.resumeSnapshot?.text &&
    (chessState()?.showStartMenu || chessState()?.browsingStartMenu)
  ) {
    return chessState().resumeSnapshot.text
  }
  if (chessState()?.showStartMenu) {
    return chessState().mode === 'CHOOSE' ? 'CHOOSE' : chessState().chessState || ''
  }
  // The shell can re-sync bareKeywordGuard from item text ("GAME") while a live game is in
  // progress. Once the board is running, always export the seated PGN from the engine.
  if (!liveBoardText && chessState()?.bareKeywordGuard && !chessConsole?.state?.chess) {
    return chessState().bareKeywordGuard
  }
  if (!liveBoardText && chessState()?.awaitingStockfishSetup) {
    return chessState().mode === 'CHOOSE' ? 'CHOOSE' : chessState().chessState || ''
  }
  if (chessState()?.gameType === 'puzzle' || chessState()?.format === 'PUZZLE' || chessState()?.mode === 'PUZZLE') {
    // Keep an item-embedded puzzle ("PUZZLE\n<Lichess row>") intact so a popup or
    // refresh reloads the same puzzle; a bare keyword stays a sample-pool puzzle.
    const cs = String(chessState()?.chessState || '').trim()
    return /^PUZZLE\s*\r?\n/i.test(cs) ? cs : 'PUZZLE'
  }
  const fallback = chessState()?.PGN || chessState()?.FEN || chessState()?.chessState || ''
  let text = fallback
  if (chessConsole?.state?.chess) {
    const rendered = normalizeExportPgn(formatPgn(chessConsole.state.chess.renderPgn()))
    if (rendered && getFormat(rendered) === 'PGN') {
      if (pgnHasMoves(rendered) || !pgnHasMoves(fallback)) {
        text = rendered
      }
    }
  } else if (fenEditor?.state?.fen) {
    text = fenEditor.state.fen.toString()
  }
  if (text && /\[/.test(text) && getFormat(text) === 'PGN') {
    text = normalizeExportPgn(mergePgnWithSavedHeaders(text, fallback))
    text = prepareWikiPgn(text, chessState())
  }
  return text
}

// The FEN of the position now on the board, read straight from the live engine
// (cm-chess) or, in the position editor, from the FEN editor. This is the
// authoritative "resulting position" of the move we're about to persist, so we
// embed it on the journal action rather than re-deriving it from PGN downstream.
function currentPositionFen() {
  try {
    if (typeof chessConsole?.state?.chess?.fen === 'function') {
      return normalizeFen(chessConsole.state.chess.fen())
    }
    if (fenEditor?.state?.fen) {
      return normalizeFen(fenEditor.state.fen.toString())
    }
  } catch {
    // Engine not ready or position invalid — fall through and omit the FEN.
  }
  return ''
}

function viewerOwnerAuthStillLoading() {
  if (!wikiFrame) return false
  try {
    return typeof wikiFrame.isOwner === 'undefined'
  } catch {
    return false
  }
}

// Whether the current game should be written back through the wiki shell at all. An owner
// persists to the wiki/journal (pageOnThisWiki); a guest on the current wiki persists to the
// browser via FedWiki's native local-page fork (guestLocalStoragePersist) so the game survives reload
// and shows up in "Local Changes" with an (X) to discard. The shell routes both through
// wiki.pageHandler.put, which already picks server-vs-localStorage by ownership, so the
// app just needs to allow the write in both cases. Federation-only features (open
// challenges, real-time, cross-wiki rating discovery) stay gated on pageOnThisWiki alone.
// While isOwner is still loading, allow writes so the shell can defer the journal put
// until auth resolves — never treat the owner as a guestLocalStoragePersist guest in that window.
function canPersistPosition() {
  if (isPwaJournalless()) return false
  if (pwaBridgeActive) {
    return Boolean(chessState()?.pageOnThisWiki || chessState()?.ownerCanJournalHere)
  }
  if (viewerOwnerAuthStillLoading()) return Boolean(wikiFrame)
  if (viewerCanJournalAsOwner() || Boolean(chessState()?.guestLocalStoragePersist)) return true
  // Guest on a create-preview ghost: allow materialize → yellow-halo local fork even if
  // the first SET_STATE arrived before guestLocalStoragePersist flipped on.
  return Boolean(wikiFrame && isGuestViewer() && isCreatePreviewContext())
}

// Guest same-device: offer browser-local (yellow halo) play instead of requiring wiki owner.
function shouldOfferGuestLocalSameDevicePlay() {
  if (!wikiFrame || !isGuestViewer()) return false
  return Boolean(chessState()?.guestLocalStoragePersist || isCreatePreviewContext())
}

function enableGuestLocalStoragePersistForPlay() {
  if (!chessState()) return
  chessState().guestLocalStoragePersist = true
}

function confirmGuestLocalSameDevicePlay(onConfirm) {
  openEmbeddedConfirmModal({
    title: 'Play on this device?',
    message:
      "You are not signed in as this wiki's owner. Continue and both sides move freely here — progress saves in this browser only (yellow local page / Local Changes).",
    confirmLabel: 'Continue on this device',
    cancelLabel: 'Cancel',
    notes: ['Sign in as owner if you want this game written to the wiki journal instead of local storage.'],
    altActions: [
      {
        label: 'Sign in as owner',
        title: 'Open the wiki sign-in or claim dialog, then start the game under your wiki identity.',
        onClick: Game.requestWikiSignIn,
      },
    ],
    onConfirm: () => {
      enableGuestLocalStoragePersistForPlay()
      onConfirm?.()
    },
  })
}

function canReachWikiForSave() {
  return Boolean(wikiFrame || (pwaBridgeActive && !isPwaJournalless()))
}

function persistedWikiItemText() {
  const tracked = chessState()?.wikiItemText
  if (tracked !== undefined && tracked !== null) return String(tracked)
  return String(chessState()?.chessState || chessState()?.PGN || '')
}

function applyWikiItemTextFromShell(wikiItemText, state = null) {
  if (wikiItemText === undefined) return
  const text = String(wikiItemText)
  if (state && typeof state === 'object') state.wikiItemText = text
  if (chessState()) chessState().wikiItemText = text
}

function wikiItemId() {
  const pwaCtx = pwaBridgeActive ? BoardLayout.getPwaWikiContext().itemId : null
  return chessState()?.itemId || pwaCtx || new URLSearchParams(location.search).get('itemId') || undefined
}

function wikiPageSlug() {
  const pwaCtx = pwaBridgeActive ? BoardLayout.getPwaWikiContext().slug : null
  return chessState()?.wikiPageName || pwaCtx || new URLSearchParams(location.search).get('pageKey') || undefined
}

function putJournal(text, { forkSite } = {}) {
  syncViewerAuthFromParent()
  if (sessionFollowsPopup()) {
    relayLinkedBoardToHost(text)
    return
  }
  const persisted = text ? canonicalizePersistedChessText(text) : text
  if (chessState()?.pwaChessItemPending || chessState()?.pwaChallengeJoinPending) {
    // Materialize/join in flight — keep the latest board text for the create payload.
    if (persisted && chessState()?.pwaChessItemContext) {
      chessState().pwaChessItemContext.chessText = persisted
    }
    return
  }
  if (isPwaJournalless()) {
    if (persisted) {
      if (getFormat(persisted) === 'PGN') {
        chessState().PGN = persisted
        chessState().chessState = persisted
      } else if (getFormat(persisted) === 'FEN') {
        chessState().FEN = persisted
        chessState().chessState = persisted
      }
    }
    // Match wiki journal gates: only create a wiki page when this text would persist.
    if (
      persisted &&
      canWriteJournalHere() &&
      shouldPersistChessItemText({
        itemText: persistedWikiItemText(),
        nextText: persisted,
        bareKeywordGuard: chessState()?.bareKeywordGuard,
      })
    ) {
      void requestPwaSaveToWiki()
      return
    }
    persistLocalSession()
    return
  }
  if (sessionBlocksAutosave(chessSession.getState()) || !canReachWikiForSave() || !canPersistPosition() || !persisted)
    return
  if (
    !shouldPersistChessItemText({
      itemText: persistedWikiItemText(),
      nextText: persisted,
      bareKeywordGuard: chessState()?.bareKeywordGuard,
    })
  ) {
    return
  }
  const fen = currentPositionFen()
  const pageTitle = String(chessState()?.wikiPageTitle || '').trim()
  // Session handoff for popup reload; durability is the wiki journal (yellow-halo if origin fails).
  BoardLayout.rememberPopupState({
    ...(chessState() || {}),
    format: getFormat(persisted) || chessState()?.format || 'PGN',
    PGN: getFormat(persisted) === 'PGN' ? persisted : chessState()?.PGN,
    FEN: getFormat(persisted) === 'FEN' ? persisted : chessState()?.FEN,
    chessState: persisted,
    itemId: wikiItemId() || chessState()?.itemId,
    pageKey: wikiPageSlug(),
  })
  wiki.positionChanged({
    text: persisted,
    bareKeywordGuard: chessState()?.bareKeywordGuard,
    ...(fen ? { fen } : {}),
    ...(forkSite ? { forkSite } : {}),
    // Shell applies title only while the page is still a create-preview ghost.
    ...(pageTitle ? { title: pageTitle } : {}),
  })
  mirrorBoardToLinkedWiki({ text: persisted })
  // Push the move over the real-time link too (if connected) for instant delivery.
  Realtime.rtcSendLocalMove(persisted)
}

// Follower surface moved — send board to the journal host (popup / linked PWA).
function relayLinkedBoardToHost(text) {
  if (!wikiFrame) return
  const persisted = text ? canonicalizePersistedChessText(text) : ''
  if (!persisted) return
  const fen = currentPositionFen()
  wiki.positionChanged({
    text: persisted,
    relayToLinkedHost: true,
    bareKeywordGuard: chessState()?.bareKeywordGuard,
    ...(fen ? { fen } : {}),
  })
}

// Linked host: apply a board state played on another surface, then journal once.
function applyLinkedBoardFromFollower(text) {
  if (sessionFollowsPopup()) return
  const persisted = String(text || '').trim()
  if (!persisted) return
  const format = getFormat(persisted)
  const incoming = normalizeRestoredChessSession({
    ...(chessState() || {}),
    chessState: persisted,
    ...(format === 'PGN' ? { PGN: persisted } : {}),
    ...(format === 'FEN' ? { FEN: persisted } : {}),
    patchStateOnly: true,
    followsPopup: false,
  })
  Realtime.applySyncedPosition(incoming)
  putJournal(persisted)
}

function gameHasExportedMoves() {
  if (!chessConsole?.state?.chess) return false
  const rendered = normalizeExportPgn(formatPgn(chessConsole.state.chess.renderPgn()))
  return Boolean(rendered && pgnHasMoves(rendered))
}

function notifyWikiPositionChanged(explicitText) {
  syncViewerAuthFromParent()
  if (isPwaJournalless()) {
    persistLocalSession()
    Game.updateExportControls()
    return
  }
  if (Position.isPositionEditorMode()) return
  // Move-less open-seat boards are not worth persisting yet; seated games seed via GAME_READY.
  if (chessState()?.bareKeywordGuard === 'GAME' && !gameHasExportedMoves()) return
  commitKeywordItem()
  // Broker callbacks (game/move/legal, game/over) pass a move/event object — only an
  // explicit PGN string (e.g. resign) should bypass exportChessText().
  const text =
    typeof explicitText === 'string' && explicitText.trim()
      ? canonicalizePersistedChessText(explicitText)
      : exportChessText()
  if (text && getFormat(text) === 'PGN') {
    chessState().PGN = text
    chessState().chessState = text
  }
  // Linked follower: play locally, journal via the host surface only.
  if (sessionFollowsPopup()) {
    relayLinkedBoardToHost(text)
    Game.updateExportControls()
    return
  }
  if (sessionBlocksAutosave(chessSession.getState()) || !canReachWikiForSave() || !canPersistPosition()) return
  if (journalBlocksAutosave()) return
  putJournal(text)
  Game.updateExportControls()
}

// moved to game.js

// A take-back during a live game. We persist the reverted position so the saved
// game matches the board, but flag it as a revert: the shell only rolls the page
// back when the last journal entry was this game's own move, so we never silently
// discard a remote opponent's move or an unrelated edit that landed since.
function notifyWikiMoveUndone() {
  if (isPwaJournalless()) {
    persistLocalSession()
    Game.updateExportControls()
    return
  }
  if (sessionBlocksAutosave(chessSession.getState()) || !canReachWikiForSave() || !canPersistPosition()) return
  if (Position.isPositionEditorMode()) return
  if (journalBlocksAutosave()) return
  const text = exportChessText()
  if (!text) return
  const fen = currentPositionFen()
  BoardLayout.rememberPopupState({
    ...(chessState() || {}),
    format: 'PGN',
    PGN: text,
    chessState: text,
    itemId: wikiItemId() || chessState()?.itemId,
    pageKey: wikiPageSlug(),
  })
  wiki.positionChanged({ text, revert: true, ...(fen ? { fen } : {}) })
  Game.updateExportControls()
}

// moved to game.js

function handleStartMenuAction(event) {
  const btn = event.target.closest('button')
  if (!btn || btn.disabled || btn.classList.contains('is-disabled')) return
  if (btn.getAttribute('aria-disabled') === 'true') return

  if (btn.classList.contains('wiki-start-game')) {
    startChessItemFromChooseMenu('game')
  } else if (btn.classList.contains('wiki-start-position')) {
    startChessItemFromChooseMenu('position')
  } else if (btn.classList.contains('wiki-start-puzzle')) {
    // Pick the puzzle pool filters first; only start once the player commits
    // (cancelling the filter modal leaves them on the CHOOSE menu).
    Puzzle.promptPuzzleFilters(() => {
      startChessItemFromChooseMenu('puzzle', { puzzleText: Puzzle.puzzleFilterItemText() })
    })
  } else if (btn.classList.contains('wiki-start-my-games')) {
    Survey.openMyChessGamesFromChooseMenu()
  } else if (btn.classList.contains('wiki-start-leaderboard')) {
    // Open the opt-in gate first; don't drop the resume snapshot yet. Cancelling the
    // gate must leave the CHOOSE menu's Cancel button able to return to the game we
    // came from. The browse state is cleared only once the board is actually viewed
    // (in survey.js viewBoard), matching the puzzle path which clears on commit.
    Leaderboard.openLeaderboardFromChooseMenu()
  } else if (btn.classList.contains('wiki-start-cancel')) {
    ChooseMenu.cancelStartMenu()
  }
}

function wireStartMenu() {
  const page = document.getElementById('start')
  if (!page) return
  // Runs on every open: the Cancel button only appears when we got here from an
  // in-progress game/position (resumeSnapshot). The CHOOSE keyword opens the menu
  // with nothing to cancel back to, so it stays hidden there.
  const cancelRow = page.querySelector('.wiki-start-cancel-row')
  if (cancelRow) cancelRow.hidden = !chessState()?.resumeSnapshot
  ChooseMenu.syncChooseMenuFederationButtons()
  ChooseMenu.syncChooseMenuAuthGatedButtons()
  BoardLayout.ensureStartMenuVisible()

  const actions = page.querySelector('.wiki-chess-start-actions')
  if (!actions || actions._chooseMenuWired) return
  actions._chooseMenuWired = true
  actions.addEventListener('click', handleStartMenuAction)
}

// moved to game.js

// # View Routing and Initialize Chess

function initializeChess(incoming) {
  const bootPgn = incoming?.PGN || incoming?.chessState || ''
  Realtime.resetGameSyncEpoch(bootPgn)
  initializeChessCore(incoming)
  if (chessState()?.pwaJournalless) {
    chessState().pwaWikiPageChrome = true
    syncLocalOnlyHalo()
    BoardLayout.updatePwaPageChrome()
  } else if (pwaBridgeActive && (chessState()?.wikiPageTitle || hasPersistedWikiPageSlug())) {
    chessState().pwaWikiPageChrome = true
    BoardLayout.updatePwaPageChrome()
  }
  // Session handoff for popup reload; journal page JSON remains SSOT.
  const seeded = chessState()?.PGN || chessState()?.chessState || bootPgn
  if (seeded && (wikiItemId() || chessState()?.itemId)) {
    BoardLayout.rememberPopupState({
      ...(chessState() || {}),
      chessState: seeded,
      PGN: getFormat(seeded) === 'PGN' ? seeded : chessState()?.PGN,
      itemId: wikiItemId() || chessState()?.itemId,
      pageKey: wikiPageSlug(),
    })
  }
  // Start/stop watching the opponent's wiki for their next move. Runs on every
  // (re)init so leaving a game for the menu/position editor stops the poll, and
  // entering a remote game (or forking a move in) refreshes the watched host.
  Realtime.updateRemoteWatch()
  if (isWikiPopup && wikiFrame && !sessionFollowsPopup() && Realtime.isRemoteHumanGame()) {
    Realtime.claimRealtimeHost()
  } else {
    Realtime.initializeRealtimeFromState()
  }
}

function initializeChessCore(incoming) {
  const prev = chessState()
  let next = normalizeRestoredChessSession(incoming && typeof incoming === 'object' ? incoming : {})
  // Boot / local-session restore often omit auth flags. Keep the bridge/shell session
  // so the padlock does not flip back to locked after a signed-in /session response.
  if (prev) {
    for (const key of [
      'pageOnThisWiki',
      'ownerCanJournalHere',
      'guestLocalStoragePersist',
      'signedInDisplayName',
      'viewerCanClaimWikiSeat',
      'viewerSeatId',
      'viewerAuthenticated',
      'faviconRev',
    ]) {
      if (next[key] === undefined && prev[key] !== undefined) next[key] = prev[key]
    }
  }

  if (isPuzzleState(next) && (next.puzzleResume?.currentPuzzleRow || next.puzzleResume?.embeddedRow)) {
    setChessState({
      ...next,
      gameSettings: mergeGameSettings(next.gameSettings, loadLocalSettingPrefs()),
    })
    void Puzzle.resumePuzzleSession(next)
    return
  }

  if (isPuzzleState(next) && Puzzle.shouldKeepActivePuzzleSession(next, prev)) {
    replaceChessState(Puzzle.mergePuzzleShellContext(prev, next))
    chessState().gameSettings = mergeGameSettings(chessState().gameSettings, loadLocalSettingPrefs())
    Puzzle.refreshPuzzleControlVisibility()
    return
  }

  setChessState(next)
  // Browser preferences (confirm moves, flip, auto-accept) override the item's
  // journaled values so a refresh restores the player's last toggle.
  chessState().gameSettings = mergeGameSettings(chessState().gameSettings, loadLocalSettingPrefs())
  // Same-device flip is live-only: finished games default back to don't flip.
  ensureEphemeralFlipPrefsForGameLifecycle()
  // Directed-invite ChallengeTarget often equals the joiner after accept; scrub so it
  // cannot poison fork stamps / remote watch.
  {
    const pgn = chessState().PGN || chessState().chessState || ''
    const scrubbed = stripSelfChallengeTarget(pgn, viewingSite())
    if (scrubbed !== pgn) {
      chessState().PGN = scrubbed
      chessState().chessState = scrubbed
    }
  }

  if (chessState().PGN && !chessState().humanPlayMode) {
    chessState().humanPlayMode = getHumanPlayMode(chessState().PGN)
  }

  if (!chessState().PGN && !chessState().FEN && !chessState().showStartMenu) {
    if (resolveChessViewMode(chessState()) === CHESS_VIEW.MENU) {
      chessState().showStartMenu = true
      chessState().format = chessState().format || 'MENU'
    }
  }

  const viewMode = resolveChessViewMode(chessState())

  if (viewMode === CHESS_VIEW.SURVEY) {
    chessState().showStartMenu = false
    Survey.showLeaderboardForItem()
    return
  }

  if (viewMode === CHESS_VIEW.LEADERBOARD) {
    chessState().showStartMenu = false
    Leaderboard.showLeaderboardBoardForItem()
    return
  }

  if (viewMode === CHESS_VIEW.POSITION && !chessState().FEN) {
    chessState().FEN = START_FEN
    chessState().format = 'FEN'
    chessState().showStartMenu = false
    chessState().gameType = 'position'
  }

  if (viewMode === CHESS_VIEW.MENU) {
    changePage('start')
    wireStartMenu()
    return
  }

  const i18n = new I18n()
  i18n.load({
    de: { playerName: 'Spieler' },
    en: { playerName: 'Player' },
    fr: { playerName: 'Joueur' },
  })

  if (viewMode === CHESS_VIEW.PUZZLE) {
    chessState().showStartMenu = false
    Puzzle.startPuzzle()
    return
  }

  if (viewMode === CHESS_VIEW.POSITION) {
    if (!chessState().FEN && chessState().chessState && getFormat(chessState().chessState) === 'FEN') {
      chessState().FEN = chessState().chessState
    }
    if (!chessState().FEN) chessState().FEN = START_FEN
    chessState().format = 'FEN'
    chessState().showStartMenu = false
    const keepLiveEdits = Position.shouldPreserveLivePositionEdits(chessState().FEN)
    changePage('position')
    void Position.ensurePositionEditorBoard({ fen: chessState().FEN, keepLiveEdits })
    return
  }

  if (chessState().PGN) {
    try {
      chessState().PGN = prepareWikiPgn(chessState().PGN, chessState())
      chessState().parsedPGN = new Pgn(chessState().PGN)
      changePage('game')

      if (chessConsole && Game.needsChessConsoleRebuild(chessState().PGN)) {
        resetChessApp()
      }

      if (!chessConsole) {
        Game.createWikiChessConsole(chessState().parsedPGN)
          .then(console => {
            if (!console && isActivePage('game')) {
              showChessInitError(new Error('Board setup was interrupted — try again'))
            }
          })
          .catch(err => {
            console.error('Failed to initialize chess console:', err)
            showChessInitError(err)
          })
      } else {
        chessState().PGN = prepareWikiPgn(chessState().PGN, chessState())
        chessConsole._wikiSeatSignature = Game.consoleSeatSignature(chessState().PGN)
        chessConsole.initGame(Game.gameInitProps())
        chessConsole._wikiNextMoveRequested = true
        Game.maybeRewindLoadedGameToStart(chessConsole, chessState().PGN)
        Game.finishGameBoardInit()
      }
    } catch (e) {
      console.error('Error parsing PGN:', e)
      chessState().parsedPGN = null
      showErrorPage({
        title: 'Could not load this game',
        message: 'The saved PGN could not be parsed. Try editing the item text or start a new game from the menu.',
        detail: e?.message ? String(e.message) : undefined,
        technical: chessState().PGN ? `Provided PGN:\n${chessState().PGN}` : undefined,
      })
    }
  } else if (chessState().showStartMenu) {
    changePage('start')
    wireStartMenu()
  }
  notifyWikiHeight()
}

document.getElementById('copyFenBtn')?.addEventListener('click', () => {
  const fenInput = document.getElementById('fenInputOutput')
  copyTextToClipboard(fenInput?.value, document.getElementById('copyFenBtn'))
})

function showErrorPage({ title, message, detail, technical } = {}) {
  changePage('error')
  const errorPage = document.querySelector('.page#error')
  if (!errorPage) return
  errorPage.replaceChildren()

  const wrap = document.createElement('div')
  wrap.className = 'container-fluid py-3 wiki-chess-error-page'

  const heading = document.createElement('h1')
  heading.className = 'wiki-chess-error-title h4'
  heading.textContent = title || 'Something went wrong'
  wrap.appendChild(heading)

  if (message) {
    const lead = document.createElement('p')
    lead.className = 'wiki-chess-error-message'
    lead.textContent = message
    wrap.appendChild(lead)
  }

  if (detail) {
    const detailEl = document.createElement('p')
    detailEl.className = 'wiki-chess-error-detail text-muted small mb-0'
    detailEl.textContent = detail
    wrap.appendChild(detailEl)
  }

  if (technical) {
    const pre = document.createElement('pre')
    pre.className = 'wiki-chess-error-technical small text-muted mt-2 mb-0'
    pre.textContent = technical
    wrap.appendChild(pre)
  }

  const actions = document.createElement('div')
  actions.className = 'wiki-chess-error-actions mt-3'
  const backBtn = document.createElement('button')
  backBtn.type = 'button'
  backBtn.className = 'btn btn-sm btn-outline-primary wiki-chess-action-btn'
  backBtn.innerHTML = '<i class="fas fa-arrow-left fa-fw" aria-hidden="true"></i> Back to menu'
  backBtn.addEventListener('click', () => ChooseMenu.returnToStartMenu())
  actions.appendChild(backBtn)
  wrap.appendChild(actions)

  errorPage.appendChild(wrap)
  backBtn.focus({ preventScroll: true })
  notifyWikiHeight()
}

function showChessInitError(err) {
  showErrorPage({
    title: 'Chess board failed to load',
    message: 'Try a hard refresh (Ctrl+Shift+R). If this persists, check the browser console.',
    detail: err?.message ? String(err.message) : undefined,
  })
}

const PLAY_VIEW_PAGES = new Set(['game', 'position', 'puzzle', 'puzzle-author'])

function changePage(page) {
  // Skip the all-pages hide/show flash once a play view is mounted; still run the
  // first show so the iframe can measure height and clear the shell loading overlay.
  const skipHideShow = PLAY_VIEW_PAGES.has(page) && playViewIsReady(page)

  const leavingFederation = isActivePage('leaderboard') && page !== 'leaderboard'
  let pageShown = false
  try {
    if (!skipHideShow) {
      closeActiveModal({ discardSuspended: true, restoreMount: false })
      restoreEmbeddedMount()
    }
    if (leavingFederation) Survey.leaveFederationViews()
    if (page !== 'game' && chessState()) {
      if (!chessState().pwaChallengeJoinPending) {
        delete chessState().pwaChallengeJoinContext
        pwaChallengeJoinPayload = null
      }
      // Keep persistence chrome on play views (game/position/puzzle); clear only when
      // leaving those surfaces (e.g. start menu) and no create/join is still pending.
      if (!PLAY_VIEW_PAGES.has(page) && !chessState().pwaChallengeJoinPending && !chessState().pwaChessItemPending) {
        delete chessState().pwaWikiPageChrome
        delete chessState().pwaChessItemContext
      }
    }
    if (!skipHideShow) {
      BoardLayout.ensureMountContentVisible('#game .container-fluid')
      BoardLayout.ensureMountContentVisible('#position .container-fluid')
      BoardLayout.ensureMountContentVisible('#start .container-fluid')
      BoardLayout.ensureMountContentVisible('#puzzle .container-fluid')
      BoardLayout.ensureMountContentVisible('#puzzle-author .container-fluid')
      const pages = document.getElementsByClassName('page')
      Array.prototype.forEach.call(pages, el => {
        el.style.display = 'none'
        el.classList.remove('wiki-page-active')
      })
      const active = document.getElementById(page)
      if (!active) return
      if (isPopupLayout && (page === 'game' || page === 'position')) {
        // Popup game/position pages use flex layout via CSS — clear inline display so the class can apply.
        active.style.display = ''
        active.classList.add('wiki-page-active')
      } else {
        active.style.display = 'block'
        if (isPopupLayout && page === 'leaderboard') {
          active.classList.add('wiki-page-active')
        }
      }
    }
    pageShown = true
    if (page === 'start') {
      BoardLayout.ensureStartMenuVisible()
      wireStartMenu()
      ChooseMenu.syncChooseMenuFederationButtons()
      if (isPopupLayout) {
        if (isPwaStandalone) {
          void BoardLayout.clearPwaLocalSession()
          delete chessState()?.pwaJournalless
          syncLocalOnlyHalo()
        }
        BoardLayout.fitChooseMenuWindow()
      }
    } else if (isPopupLayout) BoardLayout.fitPwaPlayWindow(page)
    if (!skipHideShow) {
      if (isPopupLayout) BoardLayout.fitPopupBoard()
      else if (isWikiEmbed) BoardLayout.fitEmbedBoard()
      else BoardLayout.scheduleBoardResize()
    }
    Game.updateExportControls()
    syncGameSettingsUI()
    syncFooterNavVisibility()
    Game.updateResultBanner()
    Game.updateResignControl()
    Game.refreshGameFormatInPlayerBar()
    mountPwaAuthLock(page)
    if (page === 'start' || page === 'position' || page === 'puzzle' || page === 'puzzle-author') {
      syncPwaAuthGatedControls()
    }
    BoardLayout.updatePwaPageChrome()
  } finally {
    if (pageShown) notifyWikiHeight()
  }
}

function pasteCaptureSurface() {
  if (isWikiEmbed) return 'iframe'
  if (isWikiPopup) return 'popup'
  return 'pwa'
}

function applyPastedItemText(payload) {
  const text = payload?.itemText
  if (!text || !payload?.actionable) return

  const parsed = parseChessItem(text)
  const resolved = resolveChessState(parsed)

  resetChessApp()

  // Pasting while the new-game setup modal is open switches modes; clear the setup
  // guard so a later Cancel on that modal does not yank the user back to CHOOSE.
  exitNewGameSetup()
  clearPendingNewGameSetupModal()
  setMenuResumeSnapshotBeforeNewGame(undefined)
  Game.closePositionStartModal()

  const next = {
    ...(chessState() || {}),
    chessState: text,
    ...resolved,
  }
  delete next.bareKeywordGuard
  delete next.needsSeed
  delete next.awaitingStockfishSetup
  delete next.patchStateOnly
  delete next.followsPopup
  delete next.parsedPGN

  if (resolved.showStartMenu) {
    next.showStartMenu = true
    next.format = 'MENU'
    delete next.PGN
    delete next.FEN
    delete next.gameType
  } else if (resolved.format === 'PUZZLE' || next.mode === 'PUZZLE') {
    next.showStartMenu = false
    next.format = 'PUZZLE'
    next.gameType = 'puzzle'
    delete next.PGN
    delete next.FEN
  } else if (resolved.format === 'FEN' || resolved.format === 'FIGURINE' || next.gameType === 'position') {
    next.FEN = next.FEN || resolved.FEN || text
    next.format = 'FEN'
    next.gameType = 'position'
    next.showStartMenu = false
    delete next.PGN
  } else if (resolved.format === 'PGN' || next.PGN) {
    next.PGN = prepareWikiPgn(text, next)
    next.format = 'PGN'
    next.showStartMenu = false
    delete next.FEN
    if (resolved.gameType) next.gameType = resolved.gameType
  }

  replaceChessState(next)
  setSessionFollowsPopup(false)
  chessSession.endSync()

  initializeChess(chessState())
  BoardLayout.persistPwaState()

  if (wikiFrame && canPersistPosition()) {
    wiki.pasteApply({
      text,
      bareKeywordGuard: chessState()?.bareKeywordGuard,
      ...(payload.forkSite ? { forkSite: payload.forkSite } : {}),
    })
  }

  notifyWikiHeight()
  BoardLayout.requestWikiEmbedScrollIntoView()
}

whenDocumentReady(() => {
  BoardLayout.wireDocumentPasteCapture({
    surface: pasteCaptureSurface(),
    getCanPersist: () => Boolean(wikiFrame && chessState()?.pageOnThisWiki),
    persistLabel: !wikiFrame
      ? 'You are not connected to a wiki page from this window. Confirming will update the board here only (PWA / standalone).'
      : !chessState()?.pageOnThisWiki
        ? 'This page is not yours to edit — the board will update here but the wiki item text will not be saved.'
        : undefined,
    onApply: payload => {
      if (chessState()) chessState().lastPasteCapture = payload
      applyPastedItemText(payload)
    },
  })
})
