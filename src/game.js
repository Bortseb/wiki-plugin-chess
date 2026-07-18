/**
 * GAME mode — board console, seats, start-game modal, player bars, challenges, resign.
 *
 * §1 Init & host context
 * §2 Seat claim / player wiring / Stockfish toolbar
 * §3 New-game & start-from-position setup modal
 * §4 Move confirmation, player bars, challenge & result banners
 * §5 Share / export controls, pass-and-play, journal autosave wire
 * §6 Move comments / annotation panel
 * §7 Console create / finishGameBoardInit / configurePlayer
 *
 * In-file landmarks use `// # Section Name` for navigation.
 *
 * Wired from chess-app.js via initGame(). Never imports chess-app.js.
 */

import {
  ChessConsole,
  Board,
  GameStateOutput,
  History,
  CapturedPieces,
  HistoryControl,
  GameControl,
  Persistence,
  Sound,
  StockfishGameControl,
  StockfishPlayer,
  StockfishStateView,
  LocalPlayer,
  ChessConsolePlayer,
  FEN,
  createStauntyFigures,
  ensurePieceSpriteCached,
  setConsolePiecesFlipped,
  renderSanFigures,
  Observe,
} from './cm-modules-bundle.js'
import {
  formatPgn,
  getFormat,
  getSeatClaimOffer,
  claimSeat,
  formatPlayerId,
  buildStartPgn,
  stockfishPlayerId,
  stockfishLevelElo,
  boardPlayerLabelFromPgn,
  parseStockfishLevel,
  STOCKFISH_MAX_LEVEL,
  STOCKFISH_VERSION,
  getPgnTag,
  prepareWikiPgn,
  pgnHasMoves,
  shouldViewLoadedGameFromStart,
  enginePgnSeat,
  resolveLocalPlayerColor,
  isSameDeviceHumanPlay,
  HUMAN_PLAY_CORRESPONDENCE,
  HUMAN_PLAY_SAME_DEVICE,
  getHumanPlayMode,
  setHumanPlayMode,
  setHumanPlayerName,
  playerDisplayLabel,
  playerDisplayLabelHtml,
  playerWikiSiteLinkHtml,
  faviconUrl,
  normalizeWikiSiteInput,
  opponentChallengeSeat,
  openChallengeSeat,
  challengeOpponentWikiSite,
  clearPgnTag,
  OPEN_SEAT_LABEL,
  isOpenSeatTag,
  openSeatPgnTag,
  START_FEN,
  mergeGameSettings,
  pieceSetAllowsInPlaceFlip,
  shouldRotateBoardForSideToMove,
  shouldFlipPiecesInPlace,
  parsePlayerId,
  playerTagOnViewingWikiSite,
  escapeHtml,
  appendMoveComment,
  sanitizeMoveCommentText,
  MOVE_COMMENT_SEPARATOR,
  localPlayerSeatId,
  setPgnTag,
  formatPlayerDisplayLabel,
  seatResultBannerName,
  describeGameResult,
  formatGameResultSentence,
  TERMINATION_NORMAL,
  bothSeatsFilled,
  isPageOpenChallengePgn,
  positionStartModalFields,
  normalizeHumanPlayMode,
  parseStartModalColorChoice,
  sessionBlocksAutosave,
  sessionBlocksSounds,
  sessionConsoleGeneration,
  normalizeGameSettings,
  isGenericPlayerName,
  normalizePieceSetId,
  DEFAULT_PIECE_SET_ID,
} from './chess-core.js'
import {
  buildOpenChallenge,
  isOpenChallenge,
  normalizeChallengeState,
  challengeRatingGate,
  resolveChallengeJoinerColor,
  acceptOpenChallenge,
  stampOpenChallengePgn,
  CHALLENGE_COLOR_WHITE,
  CHALLENGE_COLOR_BLACK,
  CHALLENGE_COLOR_RANDOM,
  CHALLENGE_REJECT_BELOW_MIN,
  CHALLENGE_REJECT_ABOVE_MAX,
  CHALLENGE_REJECT_UNKNOWN_RATING,
  proposeNewGamePageTitle,
  isReplaceableGhostPageTitle,
  fallbackWikiSiteDisplayLabel,
  probeWikiSite,
  wikiSiteValidationErrorMessage,
  openChallengeDisplayTitle,
  formatChallengeRange,
  challengeColorLabel,
  shouldDismissChallengeJoinGhostForPwa,
  shouldShowChallengeJoinGhostForkBanner,
  shouldShowOpenChallengeBanner,
} from './federation.js'
import {
  CANCEL_OPEN_CHALLENGE_CONFIRM,
  openChallengeEditModal,
  openChallengePublishConfirmModal,
  openOpenSeatModal,
  openCommentModal,
  restoreEmbeddedMount,
} from './modals.js'
import {
  openWithEmbeddedMount,
  isWikiEmbedded,
  mountWikiEmbedBodyDialog,
  requestWikiEmbedScrollIntoView,
  shellMessengerFromContext,
  beginPwaModalWindow,
  schedulePwaModalWindowFit,
  endPwaModalWindow,
  bridgeFetch,
  scheduleFitPlayerBars,
  configureBoardCoordinateMode,
  fitPopupBoard,
  fitEmbedBoard,
  scheduleBoardResize,
  notifyPwaPlayLayoutReady,
  rememberPwaContext,
  persistPwaState,
  updatePwaPageChrome,
} from './board-layout.js'
import {
  onGameInit,
  onGameOver,
  ratingForSeat,
  currentGameFormatInfo,
  addPostedOpenChallengeLocally,
  keepSiteSurveySnapshotOnReturn,
} from './survey.js'
import { returnToStartMenu, clearBrowseStartMenuState, confirmLeaveOngoingGame } from './choose-menu.js'

import { bumpGameSyncEpoch, shelterRealtimeBoardBadge, updateRealtimeBoardBadge } from './realtime.js'

let app

function shellMessenger() {
  return shellMessengerFromContext(app)
}

// Bind GAME-mode module to the chess-app host context.
export function initGame(appContext) {
  app = appContext
}

// # Host Accessors and App Proxy

function chessState() {
  return app.chessState
}
function sessionFollowsPopup() {
  return app.sessionFollowsPopup()
}
function shouldDeferNewGameSetup() {
  return app.shouldDeferNewGameSetup()
}
function getPendingNewGameSetupModalOpts() {
  return app.getPendingNewGameSetupModalOpts()
}
function clearPendingNewGameSetupModal() {
  return app.clearPendingNewGameSetupModal()
}
function getMenuResumeSnapshotBeforeNewGame() {
  return app.getMenuResumeSnapshotBeforeNewGame()
}
function setMenuResumeSnapshotBeforeNewGame(v) {
  return app.setMenuResumeSnapshotBeforeNewGame(v)
}
function exitNewGameSetup(opts) {
  return app.exitNewGameSetup(opts)
}
function dismissNewGameSetupItem(itemId) {
  return app.dismissNewGameSetupItem(itemId)
}
function isNewGameSetupActive() {
  return app.isNewGameSetupActive()
}
function getNewGameSetupOrigin() {
  return app.getNewGameSetupOrigin()
}
function dismissOpenChallengeSetupItem(itemId) {
  return app.dismissOpenChallengeSetupItem(itemId)
}
function clearNewGameSetupForGameStart() {
  return app.clearNewGameSetupForGameStart()
}

let chessConsoleInitPromise = null
let journalAutosaveWired = false
let newGameStartFen = null
let startModalWasOpenChallenge = null
let startModalChallengeOnly = false
let startModalBaseTitle = ''
let startModalBaseLead = ''
let startModalPageTitleDirty = false
let startModalPageTitlePinned = false
let startModalGhostTitleTimer = 0
let startModalOpponentLookupTimer = 0
let startModalOpponentLookupGen = 0
let startModalOpponentDisplayName = ''
let startModalOpponentWikiValid = true
let startModalOpponentWikiError = ''
let startModalOpponentWikiChecking = false
let whitePlayerKind
let blackPlayerKind
let wikiHistoryComponent
let wikiCapturedComponent

const wiki = new Proxy(
  {},
  {
    get(_t, prop) {
      const messenger = shellMessenger()
      const value = messenger?.[prop]
      return typeof value === 'function' ? value.bind(messenger) : value
    },
  },
)
function exportChessText(...args) {
  return app.exportChessText(...args)
}
function putJournal(...args) {
  return app.putJournal(...args)
}
function initializeChess(...args) {
  return app.initializeChess(...args)
}
function resetChessApp(...args) {
  return app.resetChessApp(...args)
}
function pickAppStateBasics(...args) {
  return app.pickAppStateBasics(...args)
}
function pgnStampSite(...args) {
  return app.pgnStampSite(...args)
}
function viewingSite(...args) {
  return app.viewingSite(...args)
}
function isGuestViewer(...args) {
  return app.isGuestViewer(...args)
}
function guestPlayerName(...args) {
  return app.guestPlayerName(...args)
}
function rememberGuestPlayerName(...args) {
  return app.rememberGuestPlayerName(...args)
}
function resolvedViewerOwnerName(...args) {
  return app.resolvedViewerOwnerName(...args)
}
function viewerCanJournalAsOwner(...args) {
  return app.viewerCanJournalAsOwner(...args)
}
function syncViewerAuthFromParent(...args) {
  return app.syncViewerAuthFromParent(...args)
}
function canWriteJournalHere(...args) {
  return app.canWriteJournalHere(...args)
}
function viewerWikiJoinId(...args) {
  return app.viewerWikiJoinId(...args)
}
function canPersistPosition(...args) {
  return app.canPersistPosition(...args)
}
function journalBlocksAutosave(...args) {
  return app.journalBlocksAutosave(...args)
}
function commitKeywordItem(...args) {
  return app.commitKeywordItem(...args)
}
function postShellSessionFlags(...args) {
  return app.postShellSessionFlags(...args)
}
function notifyWikiHeight(...args) {
  return app.notifyWikiHeight(...args)
}
function notifyWikiPositionChanged(...args) {
  return app.notifyWikiPositionChanged(...args)
}
function notifyWikiMoveUndone(...args) {
  return app.notifyWikiMoveUndone(...args)
}
function isPwaJournalless(...args) {
  return app.isPwaJournalless(...args)
}
function persistLocalSession(...args) {
  return app.persistLocalSession(...args)
}
function isActivePage(...args) {
  return app.isActivePage(...args)
}
function openEmbeddedConfirmModal(...args) {
  return app.openEmbeddedConfirmModal(...args)
}
function flushGhostChessItemSyncIfReady(...args) {
  return app.flushGhostChessItemSyncIfReady(...args)
}
function clearActiveGhostPageTitleKey(...args) {
  return app.clearActiveGhostPageTitleKey(...args)
}
function clearOpenChallengeSetupFlag(...args) {
  return app.clearOpenChallengeSetupFlag(...args)
}
function returnToSurveyItemView(...args) {
  return app.returnToSurveyItemView(...args)
}
function isCreatePreviewContext(...args) {
  return app.isCreatePreviewContext(...args)
}
function syncLinkedPageTitleInputs(...args) {
  return app.syncLinkedPageTitleInputs(...args)
}
function shouldShowStartModalPageTitleField(...args) {
  if (!app.shouldShowStartModalPageTitleField(...args)) return false
  // Challenge posts (open or directed): the real wiki page title is set when someone accepts.
  const opponent = document.getElementById('positionOpponent')?.value || ''
  const humanPlayMode = readStartModalHumanPlayMode()
  const opponentWikiSite = document.getElementById('positionOpponentWiki')?.value || ''
  const fields = positionStartModalFields({
    opponent,
    humanPlayMode,
    opponentWikiSite,
    hideHumanPlayChoice: startModalChallengeOnly,
  })
  return !fields.isChallengePost
}
function enableGuestLocalStoragePersistForPlay(...args) {
  return app.enableGuestLocalStoragePersistForPlay(...args)
}
function confirmGuestLocalSameDevicePlay(...args) {
  return app.confirmGuestLocalSameDevicePlay(...args)
}
function shouldOfferGuestLocalSameDevicePlay(...args) {
  return app.shouldOfferGuestLocalSameDevicePlay(...args)
}
function loadPieceSetPreference(...args) {
  return app.loadPieceSetPreference(...args)
}
function savePieceSetPreference(...args) {
  return app.savePieceSetPreference(...args)
}
function applySessionPieceSetOverride(...args) {
  return app.applySessionPieceSetOverride(...args)
}
function getPieceSetFile(...args) {
  return app.getPieceSetFile(...args)
}
function getPieceSpritesUrl(...args) {
  return app.getPieceSpritesUrl(...args)
}
function syncPieceSetPickersUI(...args) {
  return app.syncPieceSetPickersUI(...args)
}
function seatKingPreviewHtml(...args) {
  return app.seatKingPreviewHtml(...args)
}
function gameSettings(...args) {
  return app.gameSettings(...args)
}
function persistGameSettings(...args) {
  return app.persistGameSettings(...args)
}
function syncGameSettingsUI(...args) {
  return app.syncGameSettingsUI(...args)
}
function ensureEphemeralFlipPrefsForGameLifecycle(...args) {
  return app.ensureEphemeralFlipPrefsForGameLifecycle(...args)
}
function syncFooterNavVisibility(...args) {
  return app.syncFooterNavVisibility(...args)
}
function scheduleAuthLockLayout(...args) {
  return app.scheduleAuthLockLayout(...args)
}
function copyTextToClipboard(...args) {
  return app.copyTextToClipboard(...args)
}
function exportCurrentFen(...args) {
  return app.exportCurrentFen(...args)
}
function wikiItemId(...args) {
  return app.wikiItemId(...args)
}
function ownRatingValue(...args) {
  return app.ownRatingValue(...args)
}
function requestViewerContextFromShell(...args) {
  return app.requestViewerContextFromShell(...args)
}
function applyViewerContextFromShell(...args) {
  return app.applyViewerContextFromShell(...args)
}
function liveParentAuth(...args) {
  return app.liveParentAuth(...args)
}
function resolveGhostPageTitleKey(...args) {
  return app.resolveGhostPageTitleKey(...args)
}
function populatePieceSetPickers(...args) {
  return app.populatePieceSetPickers(...args)
}
function showsPwaPageTitleChrome(...args) {
  return app.showsPwaPageTitleChrome(...args)
}
function schedulePwaChessItemRetitle(...args) {
  return app.schedulePwaChessItemRetitle(...args)
}

const commentCtx = {
  get chessConsole() {
    return app.chessConsole
  },
  get chessState() {
    return app.chessState
  },
  get wikiHistoryComponent() {
    return wikiHistoryComponent
  },
  gameSettings,
  localViewerSeatTag,
  notifyWikiPositionChanged,
}

// Clear GAME runtime flags (autosave wire, modal title dirtiness, …).
export function resetGameRuntimeState() {
  chessConsoleInitPromise = null
  journalAutosaveWired = false
  wikiHistoryComponent = undefined
  wikiCapturedComponent = undefined
  whitePlayerKind = undefined
  blackPlayerKind = undefined
}

// Record whether journal autosave listeners are attached.
export function setJournalAutosaveWired(value) {
  journalAutosaveWired = Boolean(value)
}

// Pin/unpin the start-modal page title field.
export function setStartModalPageTitlePinned(value) {
  startModalPageTitlePinned = Boolean(value)
}

// Mark the start-modal page title as user-edited.
export function setStartModalPageTitleDirty(value) {
  startModalPageTitleDirty = Boolean(value)
}

// Return the WikiHistory console component (if mounted).
export function getWikiHistoryComponent() {
  return wikiHistoryComponent
}

// Return the WikiCapturedPieces console component (if mounted).
export function getWikiCapturedComponent() {
  return wikiCapturedComponent
}

// extracted from chess-app.js
const hostDisplayLookupWaiters = new Map()
let hostDisplayLookupGen = 0

// Resolve an async site-display-name lookup for player bars.
export function fulfillSiteDisplayLookup({ requestId, displayName, valid, error } = {}) {
  const waiter = hostDisplayLookupWaiters.get(requestId)
  if (!waiter) return
  hostDisplayLookupWaiters.delete(requestId)
  waiter({ displayName, valid, error })
}

async function probeWikiSiteForChallenge(host) {
  const raw = String(host || '').trim()
  if (!raw) return { valid: true, displayName: '' }
  const normalized = normalizeWikiSiteInput(host)
  if (!normalized) return { valid: false, error: 'invalid-format', displayName: '' }

  if (app.pwaBridgeActive) {
    try {
      const data = await bridgeFetch(`/lookup-host-display?host=${encodeURIComponent(normalized)}`)
      return {
        valid: data?.valid !== false,
        displayName: String(data?.displayName || '').trim(),
        error: data?.valid === false ? String(data?.error || 'unreachable').trim() : '',
      }
    } catch {
      return { valid: false, error: 'unreachable', displayName: '' }
    }
  }
  if (app.wikiFrame) {
    const requestId = ++hostDisplayLookupGen
    return new Promise(resolve => {
      const timer = window.setTimeout(() => {
        hostDisplayLookupWaiters.delete(requestId)
        resolve({ valid: false, error: 'unreachable', displayName: '' })
      }, 8000)
      hostDisplayLookupWaiters.set(requestId, result => {
        window.clearTimeout(timer)
        resolve({
          valid: result?.valid !== false,
          displayName: String(result?.displayName || '').trim(),
          error: result?.valid === false ? String(result?.error || 'unreachable').trim() : '',
        })
      })
      shellMessenger()?.lookupSiteDisplay({ site: normalized, requestId })
    })
  }
  return probeWikiSite(host)
}

// extracted from chess-app.js
export function localPlayerSeatColor() {
  if (shouldRotateBoardForSideToMove(chessState())) {
    if (app.chessConsole?.state?.chess) {
      return app.chessConsole.state.chess.turn()
    }
    return 'w'
  }
  const pgn = chessState()?.PGN || chessState()?.chessState
  if (pgn && getHumanPlayMode(pgn) === HUMAN_PLAY_CORRESPONDENCE) {
    return resolveLocalPlayerColor(pgn, localPlayerColorCtx())
  }
  const chosen = chessState()?.playerColor
  if (chosen === 'b' || chosen === 'black') return 'b'
  if (chosen === 'w' || chosen === 'white') return 'w'
  if (pgn) {
    return resolveLocalPlayerColor(pgn, localPlayerColorCtx())
  }
  return 'w'
}

function localPlayerColorCtx() {
  return {
    signedInDisplayName: chessState()?.signedInDisplayName,
    wikiSite: viewingSite(),
    // In the embedded iframe / popup the board always loads on the current wiki, so
    // an owner's seat matches location.host. A guest has no domain to match, so we
    // resolve their colour by the plain-name seat they hold instead.
    pageOnThisWiki: app.wikiFrame ? true : chessState()?.pageOnThisWiki,
    isGuest: isGuestViewer(),
    guestName: guestPlayerName(),
  }
}

function viewerControlsSeat(playerTag) {
  if (isSameDeviceHumanPlay(chessState())) return true
  if (!playerTag || isOpenSeatTag(playerTag)) return false
  if (parseStockfishLevel(playerTag) != null) return false
  // Standalone window (installed PWA or index.html opened directly): there is no
  // wiki page behind us (no parent iframe, no opener), so no wiki owner identity
  // exists to match a host seat against. The local human is simply the player, so
  // they own any non-engine seat — otherwise the board gets no LocalPlayer and the
  // game (e.g. vs Stockfish) can't be played at all.
  if (!app.wikiFrame) return true
  // A guest owns the plain-name seat matching their remembered guest name (no wiki
  // domain to match on), or a wiki-linked seat on this host when the display name
  // in the tag matches their guest name (local fork of a rated cross-wiki game).
  if (isGuestViewer()) {
    const guest = guestPlayerName()
    if (playerTag.trim() === guest) return true
    const parsed = parsePlayerId(playerTag)
    return Boolean(parsed?.domain && parsed.username === guest && playerTagOnViewingWikiSite(playerTag, viewingSite()))
  }
  // Owners and local-fork guests persist through pageOnThisWiki / guestLocalStoragePersist; match the
  // seat whose wiki host is the one being viewed (not every visitor on that host).
  return (
    playerTagOnViewingWikiSite(playerTag, viewingSite()) &&
    Boolean(viewerCanJournalAsOwner() || chessState()?.guestLocalStoragePersist)
  )
}

function localViewerSeatTag(pgn = chessState()?.PGN || chessState()?.chessState) {
  if (!pgn) return null
  const color = localPlayerSeatColor()
  return color === 'b' ? getPgnTag(pgn, 'Black') : getPgnTag(pgn, 'White')
}

function shouldWireLocalInputPlayer() {
  const pgn = chessState()?.PGN || chessState()?.chessState
  if (!pgn || isSameDeviceHumanPlay(chessState())) return false
  if (getHumanPlayMode(pgn) !== HUMAN_PLAY_CORRESPONDENCE) return false
  const tag = localViewerSeatTag(pgn)
  return Boolean(tag && viewerControlsSeat(tag))
}

function ensureRemoteHumanSeatWiring() {
  if (!app.chessConsole || sessionFollowsPopup()) return
  if (!shouldWireLocalInputPlayer()) {
    app.chessConsole._wikiInteractiveSeatKey = wikiInteractiveSeatKey()
    return
  }
  if (app.chessConsole.player instanceof LocalPlayer) {
    app.chessConsole._wikiInteractiveSeatKey = wikiInteractiveSeatKey()
    return
  }
  const reinit = { ...chessState() }
  resetChessApp()
  initializeChess(reinit)
}

// Seat key the viewer may edit (`White`/`Black`) for this PGN.
export function wikiInteractiveSeatKey(pgn = chessState()?.PGN || chessState()?.chessState) {
  if (!pgn || getHumanPlayMode(pgn) !== HUMAN_PLAY_CORRESPONDENCE) return ''
  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')
  const owner = chessState()?.signedInDisplayName || ''
  const host = viewingSite()
  return [owner, host, viewerControlsSeat(white) ? 'w' : '', viewerControlsSeat(black) ? 'b' : ''].join('|')
}

// Props bag passed into ChessConsole / player construction.
export function gameInitProps() {
  const props = {
    pgn: chessState().PGN,
    playerColor: localPlayerSeatColor(),
  }
  if (chessState()?.engineLevel != null) {
    props.engineLevel = chessState().engineLevel
  }
  return props
}

// After initGame loads a PGN at the tip, rewind teaching scoresheets to ply 0.
export function maybeRewindLoadedGameToStart(console = app.chessConsole, pgn = chessState()?.PGN) {
  if (!console?.state?.chess || !shouldViewLoadedGameFromStart(pgn)) return
  console.state.plyViewed = 0
  console.components?.board?.setPositionOfPlyViewed?.(false)
}

// Replay the last ply only after the console board has painted at a stable size.
// On page load the iframe/popup is still negotiating its height (fitEmbedBoard /
// fitPopupBoard run after init), so animating immediately gets lost in the resize.
function revealLastMoveWhenBoardSettles(chessConsole = app.chessConsole) {
  const board = chessConsole?.components?.board
  if (typeof board?.revealLastMoveAnimated !== 'function') return
  let lastWidth = -1
  let lastHeight = -1
  let stableFrames = 0
  let framesLeft = 90 // ~1.5s cap so a stalled layout still reveals eventually
  const step = () => {
    if (chessConsole !== app.chessConsole) return
    const rect = document.querySelector('.chess-console-board .chessboard')?.getBoundingClientRect()
    const width = rect ? Math.round(rect.width) : 0
    const height = rect ? Math.round(rect.height) : 0
    if (width > 0 && width === lastWidth && height === lastHeight) stableFrames += 1
    else stableFrames = 0
    lastWidth = width
    lastHeight = height
    framesLeft -= 1
    if ((width > 0 && stableFrames >= 3) || framesLeft <= 0) {
      void board.revealLastMoveAnimated()
      return
    }
    window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step)
}

// True when Stockfish should move immediately after init.
export function shouldRequestEngineMoveAfterInit(pgn = chessState()?.PGN || chessState()?.chessState) {
  if (pgnHasMoves(pgn)) return false
  // Only auto-play when Stockfish has the opening move (human plays Black). When the
  // human is White, initGame must not request an engine move before autosave is wired.
  if (parseStockfishLevel(getPgnTag(pgn, 'White')) != null) return true
  return false
}

// # Console Init and Seat Claim

// extracted from chess-app.js
function getSeatClaimContext() {
  if (!app.wikiFrame || !chessState()?.PGN || isSameDeviceHumanPlay(chessState())) return null
  if (chessState()?.challengeJoinGhost) return null
  syncViewerAuthFromParent()
  const signedInDisplayName = resolvedViewerOwnerName()
  const journalHere = canWriteJournalHere()
  const wikiJoinId = journalHere ? undefined : viewerWikiJoinId() || undefined
  let offer = getSeatClaimOffer(chessState().PGN, {
    signedInDisplayName,
    wikiSite: viewingSite(),
    pageOnThisWiki: journalHere,
    wikiJoinId,
    guestName: guestPlayerName(),
  })
  if (!offer) return null
  const seatId = journalHere || wikiJoinId ? wikiJoinId || viewerWikiJoinId() : ''
  if (seatId && offer.localId !== seatId) {
    offer = { ...offer, localId: seatId }
  }
  return offer
}

async function resolveSeatClaimContext() {
  syncViewerAuthFromParent()
  let offer = getSeatClaimContext()
  const guestId = guestPlayerName()
  if (offer && viewerCanJournalAsOwner() && offer.localId && offer.localId !== guestId) {
    return offer
  }
  const fresh = await requestViewerContextFromShell()
  applyViewerContextFromShell(fresh)
  syncViewerAuthFromParent()
  offer = getSeatClaimContext()
  return offer
}

// Build the in-app confirm modal copy for claiming/taking over a seat. Returns
// the params handed to openEmbeddedConfirmModal, varying by whether the seat is a
// challenge, an open seat ("sit down"), or an occupied seat ("take over").
function seatClaimModalParams(seat, offer) {
  const opt = offer.options.find(entry => entry.seat === seat)
  if (opt?.challenge) {
    return {
      title: `Accept challenge as ${seat}?`,
      message: `You will play as ${offer.localId} on your forked copy of this page.`,
      confirmLabel: `Play ${seat}`,
    }
  }
  // An open seat (blank current tag) is "sit down", not "take over".
  if (!opt?.current || isOpenSeatTag(opt.current)) {
    if (isGuestViewer() && chessState()?.guestLocalStoragePersist) {
      return {
        title: `Take the ${seat} seat?`,
        message: `You are not signed in as this wiki's owner. Sign in (or claim the wiki if prompted) to play as your wiki identity, or take the seat locally as ${offer.localId}.`,
        confirmLabel: `Play as ${offer.localId}`,
        notes: ['Guest moves stay in this browser only. Sign in as owner to save to the wiki journal.'],
      }
    }
    return {
      title: `Take the ${seat} seat?`,
      message: `You will play as ${offer.localId}.`,
      confirmLabel: 'Take seat',
    }
  }
  const currentLabel = opt.current.replace(/@engine$/i, '') || 'the current player'
  return {
    title: `Take over as ${seat}?`,
    message: `You will play as ${offer.localId}, replacing ${currentLabel}.`,
    confirmLabel: 'Take over',
    confirmClass: 'btn-danger',
  }
}

// Ask the shell to open wiki sign-in for journal/auth-gated actions.
export function requestWikiSignIn() {
  if (app.wikiFrame) {
    wiki.requestSignIn()
    return
  }
  if (!app.pwaBridgeActive) return
  window.open(`${location.protocol}//${location.host}/`, '_blank', 'noopener')
}

function confirmSeatClaim(seat, offer, onConfirm) {
  const params = seatClaimModalParams(seat, offer)
  const altActions =
    isGuestViewer() && chessState()?.guestLocalStoragePersist
      ? [
          {
            label: 'Sign in as owner',
            title: 'Open the wiki sign-in or claim dialog, then take this seat under your wiki identity.',
            onClick: requestWikiSignIn,
          },
        ]
      : []
  openEmbeddedConfirmModal({
    ...params,
    cancelLabel: 'Cancel',
    altActions,
    onConfirm,
  })
}

function wireSeatClaimButtons(board) {
  if (board._wikiClaimWired || !app.wikiFrame) return
  const host = board.elements.playerBottom?.closest('.chess-console-board')
  if (!host) return
  board._wikiClaimWired = true
  host.addEventListener('click', event => {
    const btn = event.target.closest('.wiki-claim-seat-btn')
    if (!btn) return
    event.preventDefault()
    const seat = btn.dataset.wikiSeat
    if (seat !== 'White' && seat !== 'Black') return
    void (async () => {
      const offer = await resolveSeatClaimContext()
      if (!offer) return
      confirmSeatClaim(seat, offer, () => applySeatClaim(seat))
    })()
  })
}

function maybeFinalizeOpenChallengeAfterSeatClaim(seat, pgn) {
  const challenge = currentChallenge()
  if (!challenge || !isOpenChallenge(challenge) || !bothSeatsFilled(pgn)) return
  const joinerId = getPgnTag(pgn, seat)
  if (!joinerId || isOpenSeatTag(joinerId)) return
  const accepted = acceptOpenChallenge(challenge, {
    joinerId,
    joinerSite: viewingSite(),
    joinerRating: ownRatingValue(viewingSite()),
  })
  if (!accepted) return
  chessState().challenge = accepted
  wiki.challengeChanged({ challenge: accepted, ghostItemId: wikiItemId() })
  updateChallengeBanner()
}

function maybePublishPageOpenChallenge(pgn) {
  if (!pgn || !chessState()?.pageOnThisWiki || (!app.wikiFrame && !app.pwaBridgeActive)) return
  if (isCreatePreviewContext()) return
  if (!isPageOpenChallengePgn(pgn)) return
  if (challengeOpponentWikiSite(pgn)) return
  const existing = currentChallenge()
  if (existing && isOpenChallenge(existing)) return
  const whiteOpen = isOpenSeatTag(getPgnTag(pgn, 'White'))
  const creatorSeat = whiteOpen ? 'Black' : 'White'
  const creatorId = getPgnTag(pgn, creatorSeat)
  if (!creatorId || !viewerControlsSeat(creatorId)) return
  const ratedTag = getPgnTag(pgn, 'Rated')
  const rated = ratedTag ? ratedTag.toLowerCase() !== 'no' : false
  const challenge = buildOpenChallenge({
    rated,
    creatorColor: creatorSeat === 'White' ? CHALLENGE_COLOR_WHITE : CHALLENGE_COLOR_BLACK,
    creatorId,
    creatorSite: pgnStampSite(),
    creatorRating: ownRatingValue(pgnStampSite()),
  })
  chessState().challenge = challenge
  wiki.challengeChanged({ challenge })
}

function applySeatClaim(seat) {
  syncViewerAuthFromParent()
  // A guest claiming a seat remembers their name in this browser for next time.
  if (isGuestViewer()) rememberGuestPlayerName(guestPlayerName())
  let claimed = claimSeat(chessState().PGN, seat, {
    signedInDisplayName: chessState().signedInDisplayName || liveParentAuth().ownerName,
    wikiSite: pgnStampSite(),
    ...localSeatIdentityContext(),
  })
  const settings = normalizeGameSettings(chessState()?.gameSettings)
  if (
    settings.challengeCreatorColor === CHALLENGE_COLOR_RANDOM &&
    challengeOpponentWikiSite(claimed) &&
    getHumanPlayMode(claimed) === HUMAN_PLAY_CORRESPONDENCE
  ) {
    const white = getPgnTag(claimed, 'White')
    const black = getPgnTag(claimed, 'Black')
    const creatorId = isOpenSeatTag(white) ? black : white
    const joinerId = localSeatId()
    if (creatorId && joinerId && !isOpenSeatTag(creatorId)) {
      const joinerColor = resolveChallengeJoinerColor(
        { config: { creatorColor: CHALLENGE_COLOR_RANDOM } },
        creatorId,
        joinerId,
      )
      const joinerSeat = joinerColor === 'b' ? 'Black' : 'White'
      const creatorSeat = joinerColor === 'b' ? 'White' : 'Black'
      claimed = formatPgn(setPgnTag(setPgnTag(claimed, joinerSeat, joinerId), creatorSeat, creatorId))
    }
  }
  // Self-play: if the viewer now holds both seats, switch to pass-and-play so the
  // board rotates and the single player can move for both sides on one screen.
  const holdsBothSeats =
    viewerControlsSeat(getPgnTag(claimed, 'White')) && viewerControlsSeat(getPgnTag(claimed, 'Black'))
  if (holdsBothSeats && getHumanPlayMode(claimed) !== HUMAN_PLAY_SAME_DEVICE) {
    claimed = setHumanPlayMode(claimed, HUMAN_PLAY_SAME_DEVICE)
  }
  chessState().PGN = claimed
  chessState().chessState = chessState().PGN
  // Keep the cached play-mode in step with the PGN (self-play flips it to same-device).
  chessState().humanPlayMode = getHumanPlayMode(claimed)
  if (chessState().humanPlayMode === HUMAN_PLAY_SAME_DEVICE) chessState().playerColor = 'w'
  chessState().showStartMenu = false
  chessState().gameSettings = mergeGameSettings(chessState().gameSettings, {
    challengeCreatorColor: '',
  })
  persistGameSettings(chessState().gameSettings)
  let claimedPgn = clearPgnTag(chessState().PGN, 'ChallengeTarget')
  chessState().PGN = claimedPgn
  chessState().chessState = claimedPgn
  delete chessState().parsedPGN
  resetChessApp()
  initializeChess(chessState())
  maybeFinalizeOpenChallengeAfterSeatClaim(seat, claimedPgn)
  putJournal(claimedPgn)
  maybePublishPageOpenChallenge(claimedPgn)
}

// # Stockfish Toolbar and Engine Moves

function wireStockfishUI(console, enginePlayer) {
  if (!enginePlayer?.state) {
    if (app.chessConsole === console) {
      window.setTimeout(() => wireStockfishUI(console, enginePlayerForConsole(console)), 50)
    }
    return
  }
  const controlHost = console.componentContainers?.controlButtons
  const hasToolbarNewGame = Boolean(controlHost?.querySelector('.startNewGame'))
  if (console._wikiStockfishWired && hasToolbarNewGame) {
    console._wikiStockfishStateView?.updateThinkingIndicator?.()
    return
  }
  if (console._wikiStockfishWired && !hasToolbarNewGame) {
    console._wikiStockfishWired = false
  }
  if (!console._wikiStockfishWired) {
    console._wikiStockfishWired = true
    const gameControl = new StockfishGameControl(console, { player: enginePlayer })
    // Toolbar "new game" opens our custom setup dialog (pick opponent + options,
    // start fresh from the opening position) instead of the stock color-only dialog.
    gameControl.showNewGameDialog = () => openNewGameSetupPanel()
    console._wikiStockfishStateView = new StockfishStateView(console, enginePlayer, {
      thinkingPlacement: 'player-label',
      playerBarSelector: '.wiki-chess-player-bar',
      thinkingSlotSelector: '.wiki-chess-thinking',
      scoreSlotSelector: '.wiki-chess-engine-score',
    })
  }
  console._wikiStockfishStateView?.updateThinkingIndicator?.()
}

function wireHumanGameControl(console) {
  const controlHost = console.componentContainers?.controlButtons
  const hasToolbarNewGame = Boolean(controlHost?.querySelector('.startNewGame'))
  if (console._wikiGameControlWired && hasToolbarNewGame) return
  if (console._wikiGameControlWired && !hasToolbarNewGame) {
    console._wikiGameControlWired = false
  }
  if (!console._wikiGameControlWired && !hasToolbarNewGame) {
    console._wikiGameControlWired = true
    const gameControl = new GameControl(console, {})
    // Same custom new-game setup dialog for human games as for Stockfish games.
    gameControl.showNewGameDialog = () => openNewGameSetupPanel()
  }
}

function wireGameToolbar(console) {
  if (whitePlayerKind === 'stockfish' || blackPlayerKind === 'stockfish') {
    wireStockfishUI(console, enginePlayerForConsole(console))
  } else {
    wireHumanGameControl(console)
  }
}

// Open the shared start-game setup modal. `fen` null means "start from the FEN
// editor's current board" (the position-editor flow); a FEN string means "start
// a fresh game from that position" (the toolbar + new-game flow).
// `defaultOpponent` pre-selects the opponent pick ('engine' | 'human'); omit to
// start with only the Stockfish / Human choice buttons.
// `hideOpponentSelect` hides those buttons when the caller already chose the mode
// (e.g. "Post open challenge" from the site survey).
function openStartGameModal({ title, lead, fen = null, defaultOpponent = null, hideOpponentSelect = false } = {}) {
  const modal = document.getElementById('wikiFenStartModal')
  if (!modal) return
  newGameStartFen = fen
  startModalWasOpenChallenge = null
  startModalChallengeOnly = hideOpponentSelect
  startModalBaseTitle = title || ''
  startModalBaseLead = lead || ''
  resetStartModalPageTitleState()
  startModalPageTitlePinned = !isReplaceableGhostPageTitle(chessState()?.wikiPageTitle)
  const opponentSelect = document.getElementById('positionOpponent')
  if (opponentSelect) {
    if (hideOpponentSelect) opponentSelect.value = 'human'
    else if (defaultOpponent === 'engine' || defaultOpponent === 'human') {
      opponentSelect.value = defaultOpponent
    } else {
      opponentSelect.value = ''
    }
  }
  applyPositionStartModalDefaults()
  wirePositionEditor()
  const titleEl = document.getElementById('wiki-fen-start-title')
  const leadEl = document.getElementById('wiki-fen-start-lead')
  if (titleEl && title) titleEl.textContent = title
  if (leadEl) {
    if (lead) {
      leadEl.hidden = false
      leadEl.textContent = lead
    } else {
      leadEl.hidden = true
      leadEl.textContent = ''
    }
  }
  const opponentWrap = document.getElementById('positionOpponentWrap')
  if (opponentWrap) {
    opponentWrap.hidden = hideOpponentSelect
    if (!hideOpponentSelect) opponentWrap.style.removeProperty('display')
  }
  updatePositionOpponentUI()
  if (isWikiEmbedded()) {
    mountWikiEmbedBodyDialog(modal)
  } else if (app.isPopupLayout) {
    const panel = modal.querySelector('.wiki-stockfish-setup-panel')
    beginPwaModalWindow(panel)
    schedulePwaModalWindowFit(panel)
  }
  modal.hidden = false
  syncStartModalPageTitleField()
  const wireStartModalKeys = () => {
    const onKey = event => {
      if (event.key === 'Escape') closePositionStartModal()
    }
    document.addEventListener('keydown', onKey, true)
    modal._cleanup = () => document.removeEventListener('keydown', onKey, true)
  }
  modal._resumeKeyHandler = wireStartModalKeys
  wireStartModalKeys()
  window.requestAnimationFrame(() => {
    const scrollTarget = modal.querySelector('.wiki-stockfish-setup-panel') || modal
    scrollTarget.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
    requestWikiEmbedScrollIntoView()
    const opponent = readStartModalOpponent()
    const focusEl = opponent
      ? modal.querySelector('#positionStartGameBtn')
      : modal.querySelector('#positionOpponentEngineBtn')
    focusEl?.focus({ preventScroll: true })
    notifyWikiHeight()
  })
}

// # Start Game and Position Modal

// Open the start-from-position (FEN→GAME) modal.
export function openPositionStartPanel() {
  openStartGameModal({
    title: 'Start game from position',
    lead: 'Choose who plays the other side.',
    fen: null,
  })
}

// Toolbar "+" during a game: start a brand-new game from the standard starting
// position, letting the player pick opponent and options first.
function showNewGameSetupModal({ defaultOpponent = null } = {}) {
  openStartGameModal({
    title: 'Start a new game',
    lead: 'Choose your opponent and start a fresh game.',
    fen: START_FEN,
    defaultOpponent,
  })
}

function openNewGameSetupPanel({ defaultOpponent = null, skipLeaveConfirm = false } = {}) {
  if (skipLeaveConfirm) {
    showNewGameSetupModal({ defaultOpponent })
    return
  }
  confirmLeaveOngoingGame({
    title: 'Start a new game?',
    message: 'This will end the current game by changing the chess item.',
    messageRated: 'This will end the rated game by changing the chess item.',
    proceedNoteRated: 'Confirming resigns for you (a loss and rating update) before opening the new-game setup.',
    confirmLabel: 'Start new game',
    confirmLabelRated: 'Resign & start new',
    onProceed: () => showNewGameSetupModal({ defaultOpponent }),
  })
}

// Default new-game / open-challenge form values (start menu + post open challenge).
function applyPositionStartModalDefaults() {
  const humanPlay = document.getElementById('positionHumanPlay')
  if (humanPlay) humanPlay.value = ''
  const challengeRated = document.getElementById('positionChallengeRated')
  if (challengeRated) challengeRated.value = 'unrated'
  const challengeColor = document.getElementById('positionChallengeColor')
  if (challengeColor) challengeColor.value = CHALLENGE_COLOR_RANDOM
  const challengeMin = document.getElementById('positionChallengeMin')
  if (challengeMin) challengeMin.value = ''
  const challengeMax = document.getElementById('positionChallengeMax')
  if (challengeMax) challengeMax.value = ''
  const opponentWiki = document.getElementById('positionOpponentWiki')
  if (opponentWiki) opponentWiki.value = ''
  const humanColor = document.getElementById('positionHumanColor')
  if (humanColor) humanColor.value = 'random'
  const stockfishLevel = document.getElementById('positionStockfishLevel')
  if (stockfishLevel) stockfishLevel.value = '1'
  applyStartModalSameDeviceDefaults()
}

function resetPositionStartModalUi() {
  const opponentSelect = document.getElementById('positionOpponent')
  if (opponentSelect) opponentSelect.value = ''
  applyPositionStartModalDefaults()
  resetStartModalPageTitleState()
  startModalChallengeOnly = false
  startModalBaseTitle = ''
  startModalBaseLead = ''
  const opponentWrap = document.getElementById('positionOpponentWrap')
  if (opponentWrap) {
    opponentWrap.hidden = false
    opponentWrap.style.removeProperty('display')
  }
  const titleEl = document.getElementById('wiki-fen-start-title')
  const leadEl = document.getElementById('wiki-fen-start-lead')
  if (titleEl) titleEl.textContent = 'Start game from position'
  if (leadEl) {
    leadEl.hidden = false
    leadEl.textContent = 'Choose who plays the other side.'
  }
  updatePositionOpponentUI()
}

// Close the start-from-position modal.
export function closePositionStartModal() {
  const modal = document.getElementById('wikiFenStartModal')
  if (!modal || modal.hidden) return
  modal._cleanup?.()
  modal._cleanup = null
  if (isWikiEmbedded()) {
    restoreEmbeddedMount()
    modal.classList.remove('wiki-stockfish-setup-embedded')
    if (modal.parentElement !== document.body) document.body.appendChild(modal)
  } else if (app.isPopupLayout) {
    endPwaModalWindow()
  }
  modal.hidden = true
  newGameStartFen = null
  startModalWasOpenChallenge = null
  resetStartModalPageTitleState()
  resetPositionStartModalUi()
  clearPendingNewGameSetupModal()
  // Cancelling the modal while it sat over a fresh "Play New Game" / GAME board:
  // from the CHOOSE menu we bounce back to the menu; from a bare GAME keyword we
  // leave the two-empty-seat board in place (and remember not to re-open here).
  if (isNewGameSetupActive()) {
    const origin = getNewGameSetupOrigin()
    exitNewGameSetup()
    if (origin === 'menu') {
      // Restore the menu's original resume state (undefined for a bare CHOOSE
      // keyword) rather than snapshotting the throwaway two-empty-seat board.
      const overrideSnapshot = getMenuResumeSnapshotBeforeNewGame()
      setMenuResumeSnapshotBeforeNewGame(undefined)
      returnToStartMenu({ overrideSnapshot, useOverride: true })
      return
    }
    if (origin === 'survey') {
      if (chessState()?.itemId) dismissOpenChallengeSetupItem(chessState().itemId)
      clearOpenChallengeSetupFlag()
      clearActiveGhostPageTitleKey()
      // Aborting Post challenge — keep the seeks list we had moments ago; no re-crawl.
      keepSiteSurveySnapshotOnReturn()
      returnToSurveyItemView()
      return
    }
    dismissNewGameSetupItem(chessState()?.itemId ?? null)
  }
  notifyWikiHeight()
}

function openPendingNewGameSetupModal() {
  const pendingNewGameSetupModalOpts = getPendingNewGameSetupModalOpts()
  if (!shouldDeferNewGameSetup() || !pendingNewGameSetupModalOpts) return
  const { defaultOpponent, hideOpponentSelect, title, lead } = pendingNewGameSetupModalOpts
  if (title || lead) {
    openStartGameModal({
      title: title || 'Start a new game',
      lead: lead ?? 'Choose your opponent and start a fresh game.',
      fen: START_FEN,
      defaultOpponent,
      hideOpponentSelect,
    })
  } else {
    openNewGameSetupPanel({ skipLeaveConfirm: true, defaultOpponent })
  }
}

// Defer until after changePage + the first board paint so the in-flow modal mount is stable.
function scheduleNewGameSetupModal() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!shouldDeferNewGameSetup()) return
      openPendingNewGameSetupModal()
    })
  })
}

function ensureNewGameSetupModalOpen() {
  if (!shouldDeferNewGameSetup()) return
  const modal = document.getElementById('wikiFenStartModal')
  if (modal && !modal.hidden) return
  openPendingNewGameSetupModal()
}

// Render a fresh board with two empty seats, then immediately open the shared
// start-game modal on top of it. Used by both the CHOOSE "Play New Game" button
// and the bare GAME keyword.
export function enterNewGameSetup(
  state,
  origin,
  { defaultOpponent = null, hideOpponentSelect = false, title, lead, menuResumeSnapshot } = {},
) {
  app.chessSession.enterSetup({
    origin,
    pendingModalOpts: { defaultOpponent, hideOpponentSelect, title, lead },
    menuResumeSnapshot: menuResumeSnapshot !== undefined ? menuResumeSnapshot : undefined,
    dismissedItemId: null,
  })
  // Tear down any prior board (e.g. vs Stockfish) so the open-seat setup and the
  // seated game after "Start Game" don't inherit stale engine wiring.
  resetChessApp()
  initializeChess(state)
  scheduleNewGameSetupModal()
}

// extracted from chess-app.js
export function startNewGameFromMenu() {
  const menuResumeSnapshot = chessState()?.resumeSnapshot
  clearBrowseStartMenuState()
  const host = pgnStampSite()
  const pgn = prepareWikiPgn(buildStartPgn({ gameType: 'open', ...wikiPgnContext(host) }), chessState())
  const state = {
    ...pickAppStateBasics(),
    format: 'PGN',
    PGN: pgn,
    chessState: 'GAME',
    gameType: 'open',
    mode: 'GAME',
    bareKeywordGuard: 'GAME',
    showStartMenu: false,
  }
  postShellSessionFlags({ bareKeywordGuard: 'GAME' })
  // The shell rendered this item as the CHOOSE menu (no footer buttons); tell it
  // we're now showing a game board so its footer matches.
  wiki.modeChanged({
    chessObj: {
      gameType: 'open',
      mode: 'GAME',
      format: 'PGN',
      showStartMenu: false,
      bareKeywordGuard: 'GAME',
      PGN: pgn,
      chessState: 'GAME',
    },
  })
  enterNewGameSetup(state, 'menu', { menuResumeSnapshot })
  requestWikiEmbedScrollIntoView()
}

// extracted from chess-app.js
function enginePlayerForConsole(console) {
  if (whitePlayerKind !== 'stockfish' && blackPlayerKind !== 'stockfish') return null
  return console.opponent
}

function syncStockfishTagToPgn(console) {
  const tag = enginePgnSeat(whitePlayerKind === 'stockfish', blackPlayerKind === 'stockfish')
  if (!tag) return
  const enginePlayer = enginePlayerForConsole(console)
  const level = enginePlayer?.state?.level
  if (!level) return
  const tags = console.state.chess?.pgn?.header?.tags
  if (tags) {
    tags[tag] = stockfishPlayerId(level)
    tags[tag === 'White' ? 'WhiteElo' : 'BlackElo'] = String(stockfishLevelElo(level))
  }
}

// In-app move confirmation (chess.com style): hide the toolbar in the controls area
// and show a big green check / gray ✕ in its place. Resolves true to play the move,
// false to take it back. Falls back to a plain confirm() if the bar isn't in the DOM.
let cancelPendingMoveConfirm = null

function requestMoveConfirmation(label) {
  return new Promise(resolve => {
    const controls = document.querySelector('#game .wiki-chess-controls')
    const buttons = controls?.querySelector('.control-buttons')
    const bar = controls?.querySelector('.wiki-chess-move-confirm')
    const okBtn = bar?.querySelector('.wiki-chess-move-confirm-ok')
    const cancelBtn = bar?.querySelector('.wiki-chess-move-cancel')
    if (!buttons || !bar || !okBtn || !cancelBtn) {
      resolve(window.confirm(`Play ${label}?`))
      return
    }

    // Take back any confirmation still on screen before showing this one.
    if (cancelPendingMoveConfirm) cancelPendingMoveConfirm()

    const close = result => {
      cancelPendingMoveConfirm = null
      document.removeEventListener('keydown', onKey, true)
      okBtn.onclick = null
      cancelBtn.onclick = null
      bar.hidden = true
      buttons.style.display = ''
      notifyWikiHeight()
      resolve(result)
    }
    const onKey = event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        close(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close(false)
      }
    }

    cancelPendingMoveConfirm = () => close(false)
    okBtn.title = `Play ${label}`
    okBtn.setAttribute('aria-label', `Play ${label}`)
    okBtn.onclick = () => close(true)
    cancelBtn.onclick = () => close(false)
    buttons.style.display = 'none'
    bar.hidden = false
    document.addEventListener('keydown', onKey, true)
    notifyWikiHeight()
    okBtn.focus({ preventScroll: true })
  })
}

function patchPlayerMoveConfirmation(player) {
  if (!player || player._wikiMoveConfirmPatched) return
  if (typeof player.validateMoveAndPromote !== 'function') return
  player._wikiMoveConfirmPatched = true
  const orig = player.validateMoveAndPromote.bind(player)

  // While the confirmation is on screen we leave the dragged piece sitting on its
  // target square (chess.com style). If the move is cancelled we have to put the
  // board back to the real game position, since nothing was actually played.
  const revertBoardToGameState = () => {
    player.app.chessConsole?.components?.board?.setPositionOfPlyViewed?.(true)
  }

  player.validateMoveAndPromote = (fen, squareFrom, squareTo, callback) => {
    // Stays undefined unless we synchronously decide to hold a legal move for
    // confirmation. When set, we return true so cm-chessboard keeps the piece on
    // the target square instead of snapping it back while the player decides.
    let keepPieceOnBoard
    const upstreamResult = orig(fen, squareFrom, squareTo, moveResult => {
      // No confirmation needed (illegal move, or the setting is off): defer to
      // upstream's normal apply/reject handling unchanged.
      if (!moveResult || !gameSettings().confirmMoves) {
        callback(moveResult)
        return
      }
      keepPieceOnBoard = true
      const label = moveResult.san || `${squareFrom}-${squareTo}`
      requestMoveConfirmation(label).then(confirmed => {
        if (confirmed) {
          // Play it through the normal pipeline: updates game state, publishes
          // legalMove, triggers the engine's reply, and autosaves.
          callback(moveResult)
          return
        }
        // IMPORTANT: do not call callback(null) here. Upstream's handler would then
        // re-play this (still legal) move via moveResponse({from, to}), which is what
        // caused a cancelled move to land in the journal. Instead, leave the move
        // unplayed (it's still this player's turn) and just put the piece back.
        revertBoardToGameState()
      })
    })
    return keepPieceOnBoard ?? upstreamResult
  }
}

function wireMoveConfirmation(console) {
  if (!console || console._wikiMoveConfirmWired) return
  console._wikiMoveConfirmWired = true
  patchPlayerMoveConfirmation(console.playerWhite?.())
  patchPlayerMoveConfirmation(console.playerBlack?.())
}

// Patch cm-chessboard player labels with wiki bars (once).
export function enhancePlayerLabels(console) {
  const board = console.components.board
  if (!board || board._wikiLabelsPatched) return
  board._wikiLabelsPatched = true
  wireSeatClaimButtons(board)
  wireEditablePlayerNames(board)
  wireChallengeSeatEdit(board)

  board.setPlayerNames = function () {
    window.clearTimeout(board.setPlayerNamesDebounce)
    board.setPlayerNamesDebounce = window.setTimeout(() => {
      renderWikiPlayerLabels(board, console)
    }, 0)
  }

  console.messageBroker.subscribe('game/init', () => {
    syncStockfishTagToPgn(console)
    board.setPlayerNames()
    notifyWikiHeight()
  })

  renderWikiPlayerLabels(board, console)
}

function playerSeatColor(player, console) {
  if (player === console.playerWhite()) return 'w'
  if (player === console.playerBlack()) return 'b'
  return 'w'
}

// Re-render the player bars (used by survey.js when a rating-state reply
// changes the numbers a bar should show). Debounced via the board's
// own setPlayerNames when available.
export function refreshPlayerLabels() {
  const board = app.chessConsole?.components?.board
  if (!board) return
  if (typeof board.setPlayerNames === 'function') board.setPlayerNames()
  else renderWikiPlayerLabels(board, app.chessConsole)
  updateChallengeBanner()
}

// Update rated/casual/format chip in the player bars.
export function refreshGameFormatInPlayerBar() {
  const board = app.chessConsole?.components?.board
  if (!board) return
  if (typeof board.setPlayerNames === 'function') board.setPlayerNames()
  else renderWikiPlayerLabels(board, app.chessConsole)
}

// # Open Challenge Banner

function currentChallenge() {
  return normalizeChallengeState(chessState()?.challenge)
}

// Why this viewer can't join, as user-facing copy (mirrors challengeRatingGate).
function challengeRejectMessage(reason, challenge) {
  const { minRating, maxRating } = challenge.config
  if (reason === CHALLENGE_REJECT_BELOW_MIN) {
    return `Your rating is below this challenge's minimum of ${minRating}.`
  }
  if (reason === CHALLENGE_REJECT_ABOVE_MAX) {
    return `Your rating is above this challenge's maximum of ${maxRating}.`
  }
  if (reason === CHALLENGE_REJECT_UNKNOWN_RATING) {
    return 'This challenge has a rating requirement, but you have no rating yet. Play a rated game first.'
  }
  return "You can't join this challenge."
}

// Does the local viewer already hold a seat on this board (i.e. they are the
// challenge creator, or have already joined)?
function viewerHoldsChallengeSeat(pgn) {
  return viewerControlsSeat(getPgnTag(pgn, 'White')) || viewerControlsSeat(getPgnTag(pgn, 'Black'))
}

function challengeJoinForkHintLearned() {
  try {
    return localStorage.getItem('wiki-chess-learned:challenge-join-fork') === '1'
  } catch {
    return false
  }
}

function learnChallengeJoinForkHint() {
  try {
    localStorage.setItem('wiki-chess-learned:challenge-join-fork', '1')
  } catch {
    /* private mode */
  }
  dismissChallengeJoinGhostBanner()
}

// Hide the join-challenge ghost banner after accept.
export function dismissChallengeJoinGhostBanner() {
  const banner = document.getElementById('wikiChessChallengeBanner')
  if (!banner) return
  if (!banner.hidden) {
    banner.hidden = true
    banner.innerHTML = ''
    notifyWikiHeight()
  }
  refreshGameFormatInPlayerBar()
}

function wireChallengeJoinGhostBanner(banner) {
  if (banner._wikiJoinGhostWired) return
  banner._wikiJoinGhostWired = true
  banner.addEventListener('click', event => {
    if (event.target.closest('[data-wiki-challenge-join-dismiss]')) {
      event.preventDefault()
      learnChallengeJoinForkHint()
    }
  })
}

function hideChallengeBanner(banner) {
  if (!banner.hidden) {
    banner.hidden = true
    banner.innerHTML = ''
    notifyWikiHeight()
  }
  refreshGameFormatInPlayerBar()
}

function renderJoinGhostBanner(banner, challenge) {
  const creatorLabel = playerDisplayLabelHtml(challenge.creator?.id || '')
  wireChallengeJoinGhostBanner(banner)
  banner.innerHTML = `
      <div class="wiki-chess-challenge-head">
        <span class="wiki-chess-challenge-title"><i class="fas fa-code-branch fa-fw" aria-hidden="true"></i> Accept this challenge</span>
        <span class="wiki-chess-challenge-from">from ${creatorLabel}</span>
      </div>
      <div class="wiki-chess-challenge-actions">
        <p class="wiki-chess-challenge-status">Fork this page onto your wiki to accept.</p>
        <button type="button" class="btn btn-outline-secondary btn-sm wiki-chess-action-btn" data-wiki-challenge-join-dismiss="true">Got it</button>
      </div>`
  banner.hidden = false
  notifyWikiHeight()
  refreshGameFormatInPlayerBar()
}

function renderOpenChallengeBanner(banner, challenge) {
  wireChallengeBanner(banner)
  const cfg = challenge.config
  const ratedLabel = cfg.rated ? 'Rated' : 'Unrated'
  const colorLabel = challengeColorLabel(cfg.creatorColor)
  const rangeLabel = formatChallengeRange(cfg.minRating, cfg.maxRating)
  const creatorLabel = playerDisplayLabelHtml(challenge.creator.id)
  const creatorRating =
    challenge.creator.rating != null
      ? ` <span class="wiki-chess-challenge-rating">(${challenge.creator.rating})</span>`
      : ''
  const pgn = chessState()?.PGN || chessState()?.chessState || ''

  const meta = `
    <div class="wiki-chess-challenge-meta">
      <span class="wiki-chess-challenge-tag">${ratedLabel}</span>
      <span class="wiki-chess-challenge-tag">${escapeHtml(colorLabel)}</span>
      <span class="wiki-chess-challenge-tag">Rating: ${escapeHtml(rangeLabel)}</span>
    </div>`

  let action
  if (viewerHoldsChallengeSeat(pgn)) {
    const editBtn = isGuestViewer()
      ? ''
      : `<button type="button" class="btn btn-outline-primary btn-sm wiki-chess-action-btn" data-wiki-challenge-edit="true"><i class="fas fa-pen fa-fw" aria-hidden="true"></i> Edit challenge</button>`
    action = `<p class="wiki-chess-challenge-status">Waiting for an opponent to join…</p>
      <button type="button" class="btn btn-outline-secondary btn-sm wiki-chess-action-btn" data-wiki-challenge-cancel="true">Cancel challenge</button>
      ${editBtn}`
  } else {
    const viewerRating = ownRatingValue(viewingSite())
    const gate = challengeRatingGate(challenge, viewerRating)
    const canClaim = Boolean(getSeatClaimContext()?.options.length)
    if (gate.ok && canClaim) {
      action = `<button type="button" class="btn btn-primary btn-sm wiki-chess-action-btn wiki-chess-challenge-join" data-wiki-challenge-join="true">
        <i class="fas fa-chess-knight fa-fw" aria-hidden="true"></i> Join game</button>`
    } else if (!gate.ok) {
      action = `<button type="button" class="btn btn-primary btn-sm wiki-chess-action-btn" disabled>Join game</button>
        <p class="wiki-chess-challenge-reason">${escapeHtml(challengeRejectMessage(gate.reason, challenge))}</p>`
    } else {
      action = `<p class="wiki-chess-challenge-reason">Open this page on your own wiki to join this challenge.</p>`
    }
  }

  banner.innerHTML = `
    <div class="wiki-chess-challenge-head">
      <span class="wiki-chess-challenge-title"><i class="fas fa-bullhorn fa-fw" aria-hidden="true"></i> Open challenge</span>
      <span class="wiki-chess-challenge-from">from ${creatorLabel}${creatorRating}</span>
    </div>
    ${meta}
    <div class="wiki-chess-challenge-actions">${action}</div>`
  banner.hidden = false
  notifyWikiHeight()
  refreshGameFormatInPlayerBar()
}

function updateChallengeBanner() {
  const banner = document.getElementById('wikiChessChallengeBanner')
  if (!banner) return
  const challenge = currentChallenge()
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  const joinCtx = {
    challengeJoinGhost: chessState()?.challengeJoinGhost,
    pwaBridgeActive: app.pwaBridgeActive,
    wikiFrame: app.wikiFrame,
    pgn,
    challenge,
  }

  if (shouldDismissChallengeJoinGhostForPwa(joinCtx)) {
    dismissChallengeJoinGhostBanner()
    updatePwaPageChrome()
    return
  }

  if (shouldShowChallengeJoinGhostForkBanner(joinCtx)) {
    if (challengeJoinForkHintLearned()) {
      dismissChallengeJoinGhostBanner()
      return
    }
    renderJoinGhostBanner(banner, challenge)
    return
  }

  if (!shouldShowOpenChallengeBanner({ ...joinCtx, seatsFilled: bothSeatsFilled(pgn) })) {
    hideChallengeBanner(banner)
    return
  }

  renderOpenChallengeBanner(banner, challenge)
}

function wireChallengeBanner(banner) {
  if (banner._wikiChallengeWired) return
  banner._wikiChallengeWired = true
  banner.addEventListener('click', event => {
    if (event.target.closest('[data-wiki-challenge-join]')) {
      event.preventDefault()
      acceptOpenChallengeAsViewer()
    } else if (event.target.closest('[data-wiki-challenge-cancel]')) {
      event.preventDefault()
      cancelOpenChallenge()
    } else if (event.target.closest('[data-wiki-challenge-edit]')) {
      event.preventDefault()
      editOpenChallenge()
    }
  })
}

// Join an open challenge: resolve colours deterministically (so the creator and
// joiner clients agree), seat both players, flip the descriptor to active, and drop
// into the normal game loop. The accepting client owns its forked page, so the seated
// board + active descriptor autosave to their wiki for the creator to pick up.
function acceptOpenChallengeAsViewer() {
  const challenge = currentChallenge()
  const pgn = chessState()?.PGN
  if (!challenge || !isOpenChallenge(challenge) || !pgn) return

  const creatorId = challenge.creator.id
  const joinerId = localSeatId()
  const viewerSite = viewingSite()
  const viewerRating = ownRatingValue(viewerSite)
  if (!challengeRatingGate(challenge, viewerRating).ok) return

  const joinerColor = resolveChallengeJoinerColor(challenge, creatorId, joinerId)
  const joinerSeat = joinerColor === 'b' ? 'Black' : 'White'
  const creatorSeat = joinerColor === 'b' ? 'White' : 'Black'
  let next = setPgnTag(pgn, joinerSeat, joinerId)
  next = formatPgn(setPgnTag(next, creatorSeat, creatorId))
  next = clearPgnTag(next, 'ChallengeTarget')

  const accepted = acceptOpenChallenge(challenge, {
    joinerId,
    joinerSite: viewerSite,
    joinerRating: viewerRating,
  })

  if (isGuestViewer()) rememberGuestPlayerName(guestPlayerName())
  chessState().PGN = next
  chessState().chessState = next
  chessState().humanPlayMode = getHumanPlayMode(next)
  chessState().challenge = accepted
  chessState().showStartMenu = false
  // Drop leftover challengeCreatorColor — invite target was cleared from PGN above.
  chessState().gameSettings = mergeGameSettings(chessState().gameSettings, {
    challengeCreatorColor: '',
  })
  persistGameSettings(chessState().gameSettings)
  delete chessState().parsedPGN
  resetChessApp()
  initializeChess(chessState())
  putJournal(next)
  wiki.challengeChanged({ challenge: accepted, ghostItemId: wikiItemId() })
}

// Creator withdrew the seek: clear the descriptor so the board stops advertising it.
// The seated board stays — it just becomes an ordinary open-seat game.
function cancelOpenChallenge() {
  if (!chessState()) return
  openEmbeddedConfirmModal({
    ...CANCEL_OPEN_CHALLENGE_CONFIRM,
    onConfirm: executeCancelOpenChallenge,
  })
}

function executeCancelOpenChallenge() {
  if (!chessState()) return
  delete chessState().challenge
  wiki.challengeChanged({ challenge: null })
  updateChallengeBanner()
}

// Creator edits the terms of their open seek (format, colour, rating window) without
// re-running the new-game setup. Owner-only — a guest can't journal a descriptor change.
function editOpenChallenge() {
  const challenge = currentChallenge()
  const pgn = chessState()?.PGN || chessState()?.chessState
  if (!chessState() || isGuestViewer() || !pgn || !challenge || !isOpenChallenge(challenge)) return
  const cfg = challenge.config
  openWithEmbeddedMount(
    openChallengeEditModal,
    {
      rated: cfg.rated,
      creatorColor: cfg.creatorColor,
      minRating: cfg.minRating,
      maxRating: cfg.maxRating,
      onSave: applyChallengeEdit,
    },
    notifyWikiHeight,
  )
}

// Apply edited challenge terms. The rating window / format live only in the descriptor
// (persisted via CHALLENGE_CHANGED), so a range-only change needs no board rewrite. A
// colour change re-seats the creator on the chosen side (White for 'random', as on
// creation) and opens the other seat, which does autosave the board.
function applyChallengeEdit({ rated, creatorColor, minRating, maxRating }) {
  const challenge = currentChallenge()
  const pgn = chessState()?.PGN || chessState()?.chessState
  if (!chessState() || !pgn || !challenge || !isOpenChallenge(challenge)) return

  const updated = buildOpenChallenge({
    rated,
    creatorColor,
    minRating,
    maxRating,
    creatorId: challenge.creator.id,
    creatorSite: challenge.creator.site ?? challenge.creator.host,
    creatorRating: challenge.creator.rating,
    ts: challenge.ts || Date.now(),
  })
  if (!updated) return

  const creatorSeat = updated.config.creatorColor === CHALLENGE_COLOR_BLACK ? 'Black' : 'White'
  const openSeat = creatorSeat === 'Black' ? 'White' : 'Black'
  const current = formatPgn(pgn)
  let next = setPgnTag(current, creatorSeat, updated.creator.id)
  next = formatPgn(setPgnTag(next, openSeat, ''))
  const seatChanged = next !== current

  chessState().challenge = updated
  if (seatChanged) {
    chessState().PGN = next
    chessState().chessState = next
    delete chessState().parsedPGN
    resetChessApp()
    initializeChess(chessState())
    putJournal(next)
  }
  wiki.challengeChanged({ challenge: updated })
  updateChallengeBanner()
}

// # Game Result Banner and Resignation

// Live board terminal-state flags, read defensively (the cm-chess API may be absent
// very early in boot). Used to describe natural endings (checkmate/stalemate) that have
// no explicit PGN Termination tag.
function boardOutcomeFlags() {
  const chess = app.chessConsole?.state?.chess
  const read = fn => {
    try {
      return typeof fn === 'function' ? Boolean(fn.call(chess)) : false
    } catch {
      return false
    }
  }
  return {
    isCheckmate: read(chess?.inCheckmate),
    isStalemate: read(chess?.inStalemate),
  }
}

// The current game's structured outcome (over / winner / method), or a not-over result
// when there is no game or it is still in progress.
export function currentGameOutcome() {
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  if (!pgn || getFormat(pgn) !== 'PGN' || chessState()?.showStartMenu) {
    return { over: false, result: '*', draw: false, winnerColor: null, method: '' }
  }
  return describeGameResult(pgn, boardOutcomeFlags())
}

// True when the board is on the tip of the game (not stepped back in history).
// Matches GameStateOutput: loaded finished games often rest on ply 0.
function viewingFinalPly() {
  const state = app.chessConsole?.state
  if (!state?.chess || typeof state.plyViewed !== 'number') return true
  const plyCount = typeof state.chess.plyCount === 'function' ? state.chess.plyCount() : 0
  return state.plyViewed >= plyCount
}

// The blue banner shown for any finished game (decisive or drawn), describing the
// outcome and how it ended. Driven by the PGN Result/Termination tags + the live board,
// so it appears the same whether a game just ended here or a completed game was loaded.
// Only shown while viewing the final position (same rule as the check/game-over banner).
export function updateResultBanner() {
  const banner = document.getElementById('wikiChessResultBanner')
  if (!banner) return

  const onGame = isActivePage('game')
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  const outcome = onGame ? currentGameOutcome() : { over: false }
  const show = Boolean(outcome.over && viewingFinalPly())

  document.getElementById('game')?.classList.toggle('wiki-chess-game-over', Boolean(outcome.over))
  // Finished same-device games drop live flip prefs (archived default = don't flip).
  if (outcome.over) ensureEphemeralFlipPrefsForGameLifecycle()

  if (!show) {
    if (!banner.hidden) {
      banner.hidden = true
      banner.innerHTML = ''
      notifyWikiHeight()
    }
    return
  }

  const sentence = formatGameResultSentence({
    result: outcome.result,
    method: outcome.method,
    whiteName: seatResultBannerName(getPgnTag(pgn, 'White')),
    blackName: seatResultBannerName(getPgnTag(pgn, 'Black')),
  })
  const icon = outcome.draw ? 'fa-handshake' : 'fa-trophy'
  banner.classList.toggle('is-draw', Boolean(outcome.draw))
  banner.innerHTML = `
    <span class="wiki-chess-result-icon"><i class="fas ${icon} fa-fw" aria-hidden="true"></i></span>
    <span class="wiki-chess-result-text">${escapeHtml(sentence)}</span>
    <span class="wiki-chess-result-score">${escapeHtml(outcome.result)}</span>`
  banner.hidden = false
  notifyWikiHeight()
}

// Whether the local viewer holds a seat in the live game on the board (ignoring popup
// follower mode). Follower views, replays, the position editor, puzzles, and finished games never
// qualify.
export function viewerHoldsResignableSeat() {
  if (!app.chessConsole || !isActivePage('game')) return false
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  if (!pgn || getFormat(pgn) !== 'PGN' || chessState()?.showStartMenu) return false
  if (currentGameOutcome().over) return false

  const whiteTag = getPgnTag(pgn, 'White')
  const blackTag = getPgnTag(pgn, 'Black')
  if (parseStockfishLevel(whiteTag) != null || parseStockfishLevel(blackTag) != null) return true
  if (isSameDeviceHumanPlay(chessState())) return true
  if (getHumanPlayMode(pgn) === HUMAN_PLAY_CORRESPONDENCE) {
    const tag = localViewerSeatTag(pgn)
    return Boolean(tag && viewerControlsSeat(tag))
  }
  return true
}

// Resign from the popup, or ask the shell to forward to the open game window when this
// embed is the read-only follower.
export function executeResignFromViewer({ onAfter } = {}) {
  if (!viewerHoldsResignableSeat()) return
  if (sessionFollowsPopup()) {
    wiki.requestResign()
    return
  }
  resignCurrentGame()
  onAfter?.()
}

// Show/hide the footer Resign button when the viewer holds a seat (including in follower
// mode, where clicking forwards the action to the open game window).
export function updateResignControl() {
  const btn = document.getElementById('resignGameBtn')
  if (!btn) return
  btn.classList.toggle('d-none', !viewerHoldsResignableSeat())
}

// HTML for the rated/casual pill on the top player bar (in-flow, upper right).
function gameFormatBadgeHtml() {
  if (!isActivePage('game')) return ''
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  const challenge = currentChallenge()
  if (app.wikiFrame && pgn && challenge && isOpenChallenge(challenge)) return ''
  const format = currentGameFormatInfo()
  if (!format) return ''
  const icon = format.rated ? 'fa-trophy' : 'fa-coffee'
  const cls = format.rated ? 'is-rated' : 'is-casual'
  const title = `${format.label} — ${format.detail}`
  return `<span class="wiki-chess-game-format-badge ${cls}" title="${escapeHtml(title)}" aria-label="Game format: ${escapeHtml(format.label)}"><i class="fas ${icon} fa-fw" aria-hidden="true"></i><span class="wiki-chess-game-format-badge-label">${escapeHtml(format.label)}</span></span>`
}

// Confirm, then resign. The resigning side is the local player's seat (the side to move
// for pass-and-play). Resigning is a loss for that side, recorded as a decisive Result
// plus `Termination "resignation"`, then run through the normal game-over pipeline
// (rating + autosave) so it persists and rates exactly like a board ending.
export function promptResign() {
  if (!viewerHoldsResignableSeat()) return
  const seat = localPlayerSeatColor()
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  const winnerTag = seat === 'b' ? getPgnTag(pgn, 'White') : getPgnTag(pgn, 'Black')
  const winnerName = formatPlayerDisplayLabel(winnerTag)
  const format = currentGameFormatInfo()
  const isEngine =
    parseStockfishLevel(getPgnTag(pgn, 'White')) != null || parseStockfishLevel(getPgnTag(pgn, 'Black')) != null
  const notes = []
  if (format) {
    notes.push(format.rated ? `Rated game — ${format.detail}.` : `Casual game — ${format.detail}.`)
  }
  notes.push('This ends the game now and records it as a loss for you. It cannot be undone.')
  if (format?.rated) {
    notes.push(
      isEngine
        ? 'Resigning updates your personal vs-Stockfish reference rating (not leaderboards).'
        : 'Resigning updates federated Glicko-2 ratings and leaderboards the same as a normal loss.',
    )
  } else if (isEngine) {
    notes.push('No rating will change.')
  }
  if (sessionFollowsPopup()) {
    notes.push('The open game window will record your resignation.')
  }
  openEmbeddedConfirmModal({
    title: isEngine ? 'Resign vs Stockfish?' : 'Resign game?',
    message: winnerName
      ? isEngine
        ? `Resign and let ${winnerName} win?`
        : `Resign and award the game to ${winnerName}?`
      : 'Resign this game?',
    notes,
    confirmLabel: 'Resign',
    cancelLabel: 'Keep playing',
    confirmClass: 'btn-danger',
    onConfirm: () => executeResignFromViewer(),
  })
}

// Stamp resignation result onto the current game for `seat`.
export function resignCurrentGame(seat = localPlayerSeatColor()) {
  if (!app.chessConsole) return
  const result = seat === 'w' ? '0-1' : '1-0'

  // Stamp the live chess header so the board's own PGN render carries the result token,
  // then build the persisted text and tag it. Per the PGN spec a resignation is an
  // ordinary rules-decided ending, so the standard `Termination "normal"` is written;
  // the banner derives "by resignation" from a decisive result with no mate on the
  // (clock-less) board. We set both the header (for export/history) and the exported
  // string (belt-and-suspenders) so the game-over hooks below read a decisive result.
  const tags = app.chessConsole.state?.chess?.pgn?.header?.tags
  if (tags) {
    tags.Result = result
    tags.Termination = TERMINATION_NORMAL
  }
  let text = exportChessText()
  text = setPgnTag(text, 'Result', result)
  text = setPgnTag(text, 'Termination', TERMINATION_NORMAL)
  if (chessState()) {
    chessState().PGN = text
    chessState().chessState = text
  }

  // Run the same two effects a natural game-over triggers, in the same order: ratings
  // first (stamps post-game Glicko-2 + autosaves / stages the finalize for async play),
  // then the position autosave. Both read the now-decisive PGN.
  try {
    onGameOver()
  } catch (err) {
    console.error('Resign rating update failed:', err)
  }
  notifyWikiPositionChanged(text)
  persistPwaState()

  updateResultBanner()
  updateResignControl()
  updateExportControls()
  notifyWikiHeight()
}

// Subscribe a freshly built console to the game-lifecycle events that change whether a
// result banner / resign button should show. Idempotent per console.
function wireGameStatus(console) {
  if (!console || console._wikiStatusWired) return
  console._wikiStatusWired = true
  // Per-move: only status chrome. Rebuilding player bars here remounts the realtime
  // badge and re-fits fonts, which thrashing the board ResizeObserver (subtle jiggle
  // in the wiki iframe on local and remote moves).
  const refreshStatus = () => {
    updateResultBanner()
    updateResignControl()
    syncFooterNavVisibility()
  }
  const refresh = () => {
    refreshStatus()
    refreshGameFormatInPlayerBar()
    updateChallengeBanner()
  }
  console.messageBroker.subscribe('game/init', refresh)
  console.messageBroker.subscribe('game/over', refresh)
  console.messageBroker.subscribe('game/move/legal', refreshStatus)
  console.messageBroker.subscribe('game/move/undone', refreshStatus)
  // History scrubbing: result banner only at the tip (loaded games often start on ply 0).
  Observe.property(console.state, 'plyViewed', refreshStatus)
  refresh()
}

// # Player Bar HTML and Labels

// HTML for a player name control (editable / open-seat variants).
export function playerLabelHtml(name, { editable = false, challengeEditable = false, seat = null, open = false } = {}) {
  if (open || isOpenSeatTag(name)) {
    const label = `<span class="wiki-chess-player-text wiki-chess-open-seat">${OPEN_SEAT_LABEL}</span>`
    if (challengeEditable && seat) {
      return `<button type="button" class="wiki-chess-player wiki-chess-open-seat-btn wiki-chess-challenge-editable text-start" data-wiki-seat="${seat}" title="Click to set the opponent's wiki site — they accept by forking this page on their wiki">${label}<span class="wiki-chess-open-seat-hint">click to invite a wiki</span></button>`
    }
    return `<span class="wiki-chess-player" title="Open seat — no player yet">${label}</span>`
  }

  const parsed = parsePlayerId(name)
  if (!parsed) return ''

  let label
  if (parsed.isEngine) {
    label = escapeHtml(parsed.full)
  } else if (parsed.domain) {
    label = playerWikiSiteLinkHtml(parsed.domain, parsed.username)
  } else {
    label = escapeHtml(parsed.full)
  }

  const inner = `<span class="wiki-chess-player-text">${label}</span>`

  if (challengeEditable && seat) {
    return `<button type="button" class="wiki-chess-player wiki-chess-challenge-editable btn btn-link p-0 align-baseline text-start" data-wiki-seat="${seat}" title="Click to set opponent wiki site — they accept by forking this page">${inner}</button>`
  }

  if (editable && seat) {
    return `<button type="button" class="wiki-chess-player wiki-chess-player-editable btn btn-link p-0 align-baseline text-start" data-wiki-seat="${seat}" title="Click to edit name">${inner}</button>`
  }

  return `<span class="wiki-chess-player">${inner}</span>`
}

// HTML for the site favicon chip beside a player name.
export function playerFaviconHtml(name, { open = false } = {}) {
  if (open || isOpenSeatTag(name)) return ''
  const parsed = parsePlayerId(name)
  if (!parsed || parsed.isEngine || !parsed.domain) return ''
  const icon = faviconUrl(parsed.domain)
  if (!icon) return ''
  return `<img class="wiki-chess-favicon" src="${icon}" alt="" onerror="this.classList.add('wiki-chess-favicon-missing')">`
}

// Full top/bottom player bar HTML (name, rating, claim, format).
export function playerBarHtml(
  name,
  {
    seatColor = 'w',
    claimSeat = null,
    engineScore = false,
    editable = false,
    challengeEditable = false,
    seat = null,
    open = false,
    ratingText = '',
    ratingTitle = '',
    gameFormatHtml = '',
  } = {},
) {
  const isBlack = seatColor === 'b'
  const colorName = isBlack ? 'Black' : 'White'
  const turnLabel = isBlack ? 'Black to move' : 'White to move'
  const claimLabel = claimSeat?.challenge ? 'Accept challenge' : 'Take seat'
  let claimTitle = ''
  if (claimSeat?.challenge) {
    claimTitle = `Accept this challenge as ${claimSeat.seat} (${escapeHtml(claimSeat.localId || 'you')})`
  } else if (claimSeat) {
    claimTitle = `Take this seat as ${escapeHtml(claimSeat.localId || 'you')}`
  }
  const claimHtml =
    claimSeat?.seat === 'White' || claimSeat?.seat === 'Black'
      ? `<button type="button" class="btn btn-outline-primary btn-sm wiki-chess-action-btn wiki-claim-seat-btn${claimSeat.challenge ? ' wiki-accept-challenge-btn' : ''}" data-wiki-seat="${claimSeat.seat}" title="${claimTitle}">${claimLabel}</button>`
      : ''
  const scoreHtml = engineScore ? '<span class="wiki-chess-engine-score" aria-live="polite"></span>' : ''
  const ratingHtml = ratingText
    ? `<span class="wiki-chess-rating" title="${escapeHtml(ratingTitle || 'Glicko-2 rating')}">${escapeHtml(ratingText)}</span>`
    : ''
  const seatKingHtml = `<span class="wiki-chess-seat-king" aria-label="${colorName}">${seatKingPreviewHtml(isBlack ? 'b' : 'w', 26)}</span>`
  const barClass = engineScore ? 'wiki-chess-player-bar wiki-chess-player-bar--engine' : 'wiki-chess-player-bar'
  return `<span class="${barClass}">
    ${playerFaviconHtml(name, { open })}
    ${seatKingHtml}
    ${playerLabelHtml(name, { editable, challengeEditable, seat, open })}
    ${ratingHtml}
    ${claimHtml}
    <span class="wiki-chess-turn" data-color="${isBlack ? 'b' : 'w'}" title="${turnLabel}" aria-label="${turnLabel}">
      <span class="wiki-chess-turn-hourglass" aria-hidden="true">
        <span class="wiki-chess-hourglass wiki-chess-hourglass-top">⏳</span>
        <span class="wiki-chess-hourglass wiki-chess-hourglass-bottom">⌛</span>
      </span>
    </span>
    <span class="wiki-chess-thinking" aria-hidden="true">💭</span>
    ${scoreHtml}
    ${gameFormatHtml}
  </span>`
}

function playerRowHtml(player, console, offer, { showGameFormat = false } = {}) {
  const seat = player === console.playerWhite() ? 'White' : player === console.playerBlack() ? 'Black' : null
  // Only offer "Take seat" for seats the viewer can actually claim. A seat the
  // viewer already owns is excluded from offer.options, so without this guard an
  // open opponent seat (which makes `offer` truthy) would wrongly stamp a claim
  // button onto the viewer's own seat too.
  const seatOption = offer && seat ? offer.options.find(entry => entry.seat === seat) : null
  const claimSeat = seatOption
    ? {
        seat,
        localId: offer.localId,
        current: seatOption.current,
        challenge: seatOption.challenge,
      }
    : null
  const enginePlayer = enginePlayerForConsole(console)
  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  const seatCtx = {
    ...chessState(),
    wikiSite: pgnStampSite(),
    pageOnThisWiki: chessState()?.pageOnThisWiki,
  }
  const challengeSeat = opponentChallengeSeat(pgn, seatCtx)
  const seatTag = seat ? getPgnTag(pgn, seat) : ''
  const open = Boolean(seat && isOpenSeatTag(seatTag))
  // Filled seats are NOT click-to-edit: once a player is seated, their name is fixed
  // (the wiki author edits the PGN directly if a correction is needed). The lone
  // exception is a guest renaming their OWN seat — they have no PGN to edit, so this
  // is how they self-identify. Empty seats stay editable via the claim/invite flow.
  const guestOwnSeat = Boolean(seat) && isGuestViewer() && viewerControlsSeat(seatTag)
  // Engine seats show UCI Elo in the rating badge (not baked into the name). Human seats
  // use federated / vs-Stockfish reference ratings from ratingForSeat.
  const engineLevel =
    player === enginePlayer ? (player?.state?.level ?? parseStockfishLevel(seatTag)) : parseStockfishLevel(seatTag)
  let rating = null
  if (seat) {
    if (engineLevel != null) {
      const elo = stockfishLevelElo(engineLevel)
      rating =
        elo != null
          ? {
              text: String(elo),
              title: 'Approximate Stockfish playing strength (UCI_Elo)',
            }
          : null
    } else {
      rating = ratingForSeat(seat)
    }
  }
  return playerBarHtml(boardPlayerLabelFromPgn(player, console), {
    seatColor: playerSeatColor(player, console),
    claimSeat,
    engineScore: player === enginePlayer,
    editable: guestOwnSeat && seat,
    challengeEditable: challengeSeat === seat,
    seat,
    open,
    ratingText: rating?.text || '',
    ratingTitle: rating?.title || '',
    gameFormatHtml: showGameFormat ? gameFormatBadgeHtml() : '',
  })
}

// Mount/update wiki player bars on the board component.
export function renderWikiPlayerLabels(board, console) {
  let bottomPlayer
  let topPlayer
  if (shouldRotateBoardForSideToMove(chessState())) {
    bottomPlayer = console.state.orientation === 'w' ? console.playerWhite() : console.playerBlack()
    topPlayer = console.state.orientation === 'w' ? console.playerBlack() : console.playerWhite()
  } else if (console.props.playerColor === console.state.orientation) {
    bottomPlayer = console.player
    topPlayer = console.opponent
  } else {
    bottomPlayer = console.opponent
    topPlayer = console.player
  }
  const offer = getSeatClaimContext()
  shelterRealtimeBoardBadge()
  board.elements.playerBottom.innerHTML = playerRowHtml(bottomPlayer, console, offer)
  board.elements.playerTop.innerHTML = playerRowHtml(topPlayer, console, offer, { showGameFormat: true })
  console._wikiStockfishStateView?.updateThinkingIndicator()
  console._wikiStockfishStateView?.refreshScore()
  updateRealtimeBoardBadge()
  scheduleFitPlayerBars()
}

function wireChallengeSeatEdit(board) {
  if (board._wikiChallengeEditWired) return
  const host = board.elements.playerBottom?.closest('.chess-console-board')
  if (!host) return
  board._wikiChallengeEditWired = true
  host.addEventListener('click', event => {
    const btn = event.target.closest('.wiki-chess-challenge-editable')
    if (!btn) return
    event.preventDefault()
    const seat = btn.dataset.wikiSeat
    if (seat !== 'White' && seat !== 'Black') return
    openOpenSeatDialog(seat)
  })
}

// Modal offering the two ways to fill an open seat: sit down yourself (when this
// viewer can claim it — i.e. they have a wiki identity on this page), or name the
// wiki site of a player to invite (they accept by forking the page).
function openOpenSeatDialog(seat) {
  if (seat !== 'White' && seat !== 'Black') return
  if (!app.chessConsole || !chessState()?.pageOnThisWiki) return

  const pgn = chessState()?.PGN || chessState()?.chessState || ''
  const currentSite = challengeOpponentWikiSite(pgn) || ''
  const offer = getSeatClaimContext()
  const canClaim = Boolean(offer?.options.some(opt => opt.seat === seat))

  openWithEmbeddedMount(
    openOpenSeatModal,
    {
      seat,
      canClaim,
      currentSite,
      onClaim: () => applySeatClaim(seat),
      onInvite: host => {
        const normalized = normalizeWikiSiteInput(host)
        if (!normalized) return false
        applyChallengeOpponentWiki(seat, normalized)
      },
    },
    notifyWikiHeight,
  )
}

function applyChallengeOpponentWiki(seat, wikiSiteInput) {
  if (!app.chessConsole || (seat !== 'White' && seat !== 'Black')) return
  const challengeTarget = normalizeWikiSiteInput(wikiSiteInput)
  let pgn = exportChessText()
  pgn = openChallengeSeat(pgn, seat)
  if (challengeTarget) pgn = setPgnTag(pgn, 'ChallengeTarget', challengeTarget)
  else pgn = clearPgnTag(pgn, 'ChallengeTarget')
  pgn = prepareWikiPgn(pgn, chessState())

  const tag = getPgnTag(pgn, seat)
  const player = seat === 'White' ? app.chessConsole.playerWhite() : app.chessConsole.playerBlack()
  player.name = isOpenSeatTag(tag) ? OPEN_SEAT_LABEL : tag
  const tags = app.chessConsole.state.chess?.pgn?.header?.tags
  if (tags) tags[seat] = tag

  chessState().PGN = pgn
  chessState().chessState = pgn
  // Invite target is PGN ChallengeTarget only.
  renderWikiPlayerLabels(app.chessConsole.components.board, app.chessConsole)
  putJournal(pgn)
  persistPwaState()
}

function wireEditablePlayerNames(board) {
  if (board._wikiNameEditWired) return
  const host = board.elements.playerBottom?.closest('.chess-console-board')
  if (!host) return
  board._wikiNameEditWired = true
  host.addEventListener('click', event => {
    const btn = event.target.closest('.wiki-chess-player-editable')
    if (!btn || host.querySelector('.wiki-chess-player-input')) return
    event.preventDefault()
    const seat = btn.dataset.wikiSeat
    if (seat !== 'White' && seat !== 'Black') return
    beginPlayerNameEdit(btn, seat)
  })
}

function beginPlayerNameEdit(button, seat) {
  if (!app.chessConsole) return
  const currentTag =
    seat === 'White'
      ? getPgnTag(chessState()?.PGN || exportChessText(), 'White')
      : getPgnTag(chessState()?.PGN || exportChessText(), 'Black')
  const currentLabel = playerDisplayLabel(currentTag || button.textContent || '')

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'wiki-chess-player-input form-control form-control-sm'
  input.value = currentLabel
  input.maxLength = 64
  input.setAttribute('aria-label', `Edit ${seat} player name`)
  button.replaceWith(input)
  input.focus({ preventScroll: true })
  input.select()

  const cancel = () => {
    if (!input.isConnected) return
    renderWikiPlayerLabels(app.chessConsole.components.board, app.chessConsole)
  }

  const commit = () => {
    if (!input.isConnected) return
    const next = input.value.trim()
    if (next && next !== currentLabel) {
      applyHumanPlayerName(seat, next)
    } else {
      cancel()
    }
  }

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  })
  input.addEventListener('blur', () => window.setTimeout(commit, 0))
}

function applyHumanPlayerName(seat, displayName) {
  if (!app.chessConsole || (seat !== 'White' && seat !== 'Black')) return
  const name = String(displayName || '').trim()
  if (!name) return

  // A guest renaming their own seat: remember the new name in this browser so future
  // games default to it. The PGN still updates locally; putJournal is a no-op for guests.
  if (isGuestViewer()) {
    const seatTag = getPgnTag(chessState()?.PGN || exportChessText(), seat)
    if (viewerControlsSeat(seatTag)) rememberGuestPlayerName(name)
  }

  let pgn = exportChessText()
  pgn = setHumanPlayerName(pgn, seat, name)
  pgn = prepareWikiPgn(pgn, chessState())

  const player = seat === 'White' ? app.chessConsole.playerWhite() : app.chessConsole.playerBlack()
  player.name = name
  const tags = app.chessConsole.state.chess?.pgn?.header?.tags
  if (tags) tags[seat] = name

  chessState().PGN = pgn
  chessState().chessState = pgn

  renderWikiPlayerLabels(app.chessConsole.components.board, app.chessConsole)
  putJournal(pgn)
  persistPwaState()
}

// # Export Share and Pass and Play

async function shareGamePgn(button) {
  const text = exportChessText({ liveBoardText: true })
  if (!text || getFormat(text) !== 'PGN') return false
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Chess game',
        text,
      })
      return true
    } catch (err) {
      if (err?.name === 'AbortError') return false
      console.warn('Share failed, falling back to copy:', err)
    }
  }
  return copyTextToClipboard(text, button)
}

// Refresh FEN/PGN export button enabled state + payloads.
export function updateExportControls() {
  const shareRow = document.getElementById('wikiChessShareActions')
  const copyPgnBtn = document.getElementById('copyGamePgnBtn')
  const onGamePage = document.getElementById('game')?.style.display !== 'none'
  // liveBoardText bypasses the bare-keyword gate so a live-but-unsaved GAME item (item
  // text still just "GAME") reports its real PGN — otherwise Copy/Share PGN would
  // stay hidden until the first move autosaves and clears bareKeywordGuard.
  const text = exportChessText({ liveBoardText: true })
  const hasPgn = onGamePage && text && getFormat(text) === 'PGN'
  const canShare = hasPgn && typeof navigator.share === 'function'
  if (shareRow) {
    // Group uses `display: contents`; only toggle visibility, not the flex display.
    shareRow.classList.toggle('d-none', !canShare)
  }
  if (copyPgnBtn) {
    copyPgnBtn.classList.toggle('d-none', !hasPgn)
  }
}

// Attach click handlers for FEN/PGN export controls.
export function wireExportControls() {
  if (document.body._wikiExportWired) return
  document.body._wikiExportWired = true

  document.getElementById('copyGamePgnBtn')?.addEventListener('click', () => {
    copyTextToClipboard(exportChessText({ liveBoardText: true }), document.getElementById('copyGamePgnBtn'))
  })
  document.getElementById('copyGameFenBtn')?.addEventListener('click', () => {
    copyTextToClipboard(exportCurrentFen(), document.getElementById('copyGameFenBtn'))
  })
  document.getElementById('shareGamePgnBtn')?.addEventListener('click', () => {
    shareGamePgn(document.getElementById('shareGamePgnBtn'))
  })
}

// extracted from chess-app.js
export function patchSoundForSync(console) {
  if (!console.sound || console.sound._wikiSyncPatched) return
  console.sound._wikiSyncPatched = true
  const play = console.sound.play.bind(console.sound)
  console.sound.play = soundName => {
    // Suppress sounds while applying a synced board from another view, and when the
    // player has muted move sounds. Linked followers may still hear their own moves.
    if (sessionBlocksSounds(app.chessSession.getState())) return
    if (gameSettings().muteMoveSounds) return
    return play(soundName)
  }
}

// Flip board for same-device pass-and-play side to move.
export function applyPassAndPlayOrientation() {
  if (!app.chessConsole || !shouldRotateBoardForSideToMove(chessState())) return
  const turn = app.chessConsole.state.chess.turn()
  if (app.chessConsole.state.orientation !== turn) {
    app.chessConsole.state.orientation = turn
  } else {
    const board = app.chessConsole.components.board
    if (board) renderWikiPlayerLabels(board, app.chessConsole)
  }
}

// In-place piece flip for opposite-sides piece sets.
export function applyOppositeSidesPieceFlip() {
  if (!app.chessConsole) return
  const on = shouldFlipPiecesInPlace(chessState()) && pieceSetAllowsInPlaceFlip(loadPieceSetPreference())
  if (on && app.chessConsole.state.orientation !== 'w') {
    // Opposite-sides piece flip assumes white stays at the bottom; only glyphs rotate.
    app.chessConsole.state.orientation = 'w'
  }
  setConsolePiecesFlipped(app.chessConsole, on)
}

function wirePassAndPlayFlip(console) {
  if (!console || console._wikiPassAndPlayWired) return
  console._wikiPassAndPlayWired = true

  const refresh = () => {
    if (shouldRotateBoardForSideToMove(chessState())) applyPassAndPlayOrientation()
    applyOppositeSidesPieceFlip()
  }

  console.messageBroker.subscribe('game/move/legal', refresh)
  console.messageBroker.subscribe('game/move/undone', refresh)
  console.messageBroker.subscribe('game/init', refresh)

  Observe.property(console.state, 'plyViewed', refresh)

  refresh()
}

// # Journal Autosave Wiring

// Subscribe console moves to journal autosave / shell save.
export function wireJournalAutosave(console) {
  if (journalAutosaveWired) return
  if (!app.wikiFrame && !app.pwaBridgeActive) return
  journalAutosaveWired = true
  // Ratings run BEFORE the autosave on game/over: onGameOver stamps the post-game
  // Glicko-2 headers into chessState().PGN so the autosave that follows persists them.
  console.messageBroker.subscribe('game/init', onGameInit)
  console.messageBroker.subscribe('game/over', onGameOver)
  const onPositionChange = () => {
    if (isPwaJournalless()) persistLocalSession()
    else notifyWikiPositionChanged()
  }
  console.messageBroker.subscribe('game/move/legal', () => {
    bumpGameSyncEpoch(exportChessText())
    onPositionChange()
  })
  console.messageBroker.subscribe('game/over', onPositionChange)
  console.messageBroker.subscribe('game/move/undone', () => {
    if (isPwaJournalless()) persistLocalSession()
    else notifyWikiMoveUndone()
  })
}

// extracted from chess-app.js

// # Move Comments and Annotation Panel

function viewedCommentMove() {
  if (!commentCtx.chessConsole?.state?.chess) return null
  const ply = commentCtx.chessConsole.state.plyViewed || 0
  if (ply < 1) return null
  const moves = commentCtx.chessConsole.state.chess.history()
  return moves[ply - 1] || null
}

function moveLabelForPly(ply, move) {
  if (!move) return ''
  const moveNumber = Math.floor((ply - 1) / 2) + 1
  return `${moveNumber}${ply % 2 === 1 ? '.' : '...'} ${move.san}`
}

function moveLabelHtml(ply, move) {
  if (!move) return ''
  const moveNumber = Math.floor((ply - 1) / 2) + 1
  const dots = ply % 2 === 1 ? '.' : '…'
  const color = ply % 2 === 1 ? 'w' : 'b'
  const figures = commentCtx.chessConsole?.props?.figures
  const san = figures ? renderSanFigures(move.san, color, figures) : escapeHtml(move.san)
  return `<span class="wiki-chess-annotation-move">${moveNumber}${dots}&nbsp;${san}</span>`
}

const SAN_PIECE_MOVE = /\b([KQRBN])((?:[a-h]?[1-8]?)x?[a-h][1-8](?:=[QRBN])?[+#]?)/g
function renderCommentFigures(escapedBody, color, figures) {
  if (!figures) return escapedBody
  const suffix = color === 'b' ? 'b' : 'w'
  return escapedBody.replace(SAN_PIECE_MOVE, (whole, piece, rest) => {
    const fig = figures[`${piece}${suffix}`]
    return fig ? `${fig}${rest}` : whole
  })
}

function commentNotesHtml(comment, color, { prominent = false } = {}) {
  const figures = commentCtx.chessConsole?.props?.figures
  const segments = String(comment || '')
    .split(MOVE_COMMENT_SEPARATOR)
    .map(s => s.trim())
    .filter(Boolean)
  return segments
    .map(seg => {
      const idx = seg.indexOf(': ')
      const name = idx > 0 ? seg.slice(0, idx) : ''
      const body = idx > 0 ? seg.slice(idx + 2) : seg
      const who = name ? `<span class="wiki-chess-annotation-author">${escapeHtml(name)}</span>` : ''
      const bodyHtml = renderCommentFigures(escapeHtml(body), color, figures)
      // Teaching notes (no "Name: …" prefix) drop quote chrome in prominent mode so
      // lesson prose reads as body text rather than a dialogue bubble.
      const bodyClass =
        prominent && !name
          ? 'wiki-chess-annotation-body wiki-chess-annotation-body--prose'
          : 'wiki-chess-annotation-body'
      return `<span class="wiki-chess-annotation-note">${who}<span class="${bodyClass}">${bodyHtml}</span></span>`
    })
    .join('')
}

function moveCommentText(move) {
  if (!move) return ''
  return [move.commentBefore, move.commentMove, move.commentAfter].filter(Boolean).join(' ').trim()
}

function currentAnnotatorName() {
  const tag = commentCtx.localViewerSeatTag()
  const label = tag ? playerDisplayLabel(tag) : ''
  if (label && !isGenericPlayerName(label)) return label
  if (commentCtx.chessState?.signedInDisplayName && !isGenericPlayerName(commentCtx.chessState.signedInDisplayName)) {
    return commentCtx.chessState.signedInDisplayName
  }
  return 'Player'
}

function canAddMoveComments() {
  // Annotations only persist through the wiki journal — require the viewer's own
  // signed-in wiki page, not a guest browse of Academy / someone else's site.
  if (!app.wikiFrame && !app.pwaBridgeActive) return true
  if (!canWriteJournalHere()) return false
  if (isGuestViewer()) return false
  return Boolean(resolvedViewerOwnerName())
}

// Refresh brace-comment / annotation UI under the board.
export function updateAnnotationPanel() {
  const bar = document.getElementById('wikiChessAnnotation')
  if (!bar) return
  const onGamePage = document.getElementById('game')?.style.display !== 'none'
  const settings = commentCtx.gameSettings()
  const reading = settings.enableComments || settings.showAnnotationsBelow
  const canAdd = canAddMoveComments() && settings.enableComments
  const hide = () => {
    const wasVisible = !bar.hasAttribute('hidden')
    bar.setAttribute('hidden', '')
    bar.classList.remove('wiki-chess-annotation--prominent')
    if (wasVisible) notifyWikiHeight()
  }
  if (!onGamePage || commentCtx.chessState?.mode === 'PUZZLE' || !reading) {
    hide()
    return
  }
  const move = viewedCommentMove()
  if (!move) {
    hide()
    return
  }
  const comment = moveCommentText(move)
  // Readers (Academy / remote visitors) only see the bar when the ply has a note —
  // no empty "Add comment" chrome for every uncommented move.
  if (!comment && !canAdd) {
    hide()
    return
  }
  bar.removeAttribute('hidden')
  bar.classList.add('wiki-chess-annotation--prominent')
  const addBtn = document.getElementById('addCommentBtn')
  if (addBtn) addBtn.hidden = !canAdd
  const textEl = document.getElementById('wikiChessAnnotationText')
  if (!textEl) return
  const ply = commentCtx.chessConsole.state.plyViewed
  const moveColor = ply % 2 === 1 ? 'w' : 'b'
  const labelHtml = moveLabelHtml(ply, move)
  textEl.classList.toggle('wiki-chess-annotation-empty', !comment)
  textEl.innerHTML = comment
    ? `${labelHtml}${commentNotesHtml(comment, moveColor, { prominent: true })}`
    : `${labelHtml}<span class="wiki-chess-annotation-placeholder">No comment yet.</span>`
  notifyWikiHeight()
}

function openGameCommentModal() {
  if (!canAddMoveComments()) return
  const move = viewedCommentMove()
  if (!move) return
  openCommentModal({
    moveLabel: moveLabelForPly(commentCtx.chessConsole.state.plyViewed, move),
    annotatorName: currentAnnotatorName(),
    existing: moveCommentText(move),
    onSubmit: addCommentToViewedMove,
  })
}

function addCommentToViewedMove(text) {
  const move = viewedCommentMove()
  if (!move) return
  const clean = sanitizeMoveCommentText(text)
  if (!clean) return
  move.commentAfter = appendMoveComment(move.commentAfter, currentAnnotatorName(), clean)
  commentCtx.wikiHistoryComponent?.redraw()
  updateAnnotationPanel()
  commentCtx.notifyWikiPositionChanged()
}

function wireGameComments(console) {
  const addBtn = document.getElementById('addCommentBtn')
  if (addBtn && !addBtn._wikiCommentWired) {
    addBtn._wikiCommentWired = true
    addBtn.addEventListener('click', openGameCommentModal)
  }
  if (!console || console._wikiCommentsWired) {
    updateAnnotationPanel()
    return
  }
  console._wikiCommentsWired = true
  console.messageBroker.subscribe('game/move/legal', updateAnnotationPanel)
  console.messageBroker.subscribe('game/move/undone', updateAnnotationPanel)
  console.messageBroker.subscribe('game/init', updateAnnotationPanel)
  Observe.property(console.state, 'plyViewed', updateAnnotationPanel)
  updateAnnotationPanel()
}

function seedWikiIfNeeded() {
  syncViewerAuthFromParent()
  if (sessionFollowsPopup()) return
  if (
    !app.wikiFrame ||
    !canPersistPosition() ||
    sessionBlocksAutosave(app.chessSession.getState()) ||
    journalBlocksAutosave()
  )
    return
  if (!chessState()?.needsSeed) return
  const text = exportChessText()
  if (text) {
    wiki.gameReady({
      text,
      bareKeywordGuard: chessState()?.bareKeywordGuard,
    })
  }
}

// Stamp-site + player id context for prepareWikiPgn / buildStartPgn.
export function wikiPgnContext(host = pgnStampSite()) {
  return {
    signedInDisplayName: chessState()?.signedInDisplayName,
    wikiSite: host,
    wikiSiteUrl: chessState()?.wikiSiteUrl,
    wikiPageName: chessState()?.wikiPageName,
    wikiPageTitle: chessState()?.wikiPageTitle,
    itemId: wikiItemId(),
  }
}

// Who sits in the seat the local viewer chooses when starting/claiming a game:
// the authenticated owner's wiki identity, or an unauthenticated guest's plain name.
function localSeatIdentityContext() {
  const journalHere = canWriteJournalHere()
  const wikiJoinId = journalHere ? undefined : viewerWikiJoinId() || undefined
  return {
    pageOnThisWiki: journalHere,
    wikiJoinId,
    guestName: guestPlayerName(),
  }
}

function startGameFromPosition({
  gameType = 'engine',
  stockfishLevel = 1,
  localSeat = 'w',
  humanPlayMode = HUMAN_PLAY_CORRESPONDENCE,
  opponentWikiSite = '',
  challengeCreatorColor = '',
  rated = true,
  fen,
  seedNow = false,
} = {}) {
  syncViewerAuthFromParent()
  // An explicit FEN (toolbar "new game" passes the standard start position) wins;
  // otherwise fall back to the position editor's current board.
  const startFen = fen || app.fenEditor?.state?.fen?.toString()
  if (!startFen) return
  clearNewGameSetupForGameStart()
  clearBrowseStartMenuState()
  // Full teardown of any existing board. The open two-seat board built while the
  // setup modal was shown leaves app.chessConsole AND chessConsoleInitPromise set; a
  // partial reset (nulling only app.chessConsole) would let createWikiChessConsole
  // short-circuit on the stale promise and never build the seated board, so the
  // chosen seats never render. resetChessApp clears the promise and DOM too.
  resetChessApp()
  journalAutosaveWired = false
  const host = pgnStampSite()
  const directedSite = gameType === 'human' ? normalizeWikiSiteInput(opponentWikiSite) || '' : ''
  const seededPgn = buildStartPgn({
    gameType,
    stockfishLevel,
    // The chosen colour applies to engine games too now, not just human challenges.
    localSeat,
    humanPlayMode: gameType === 'human' ? humanPlayMode : HUMAN_PLAY_CORRESPONDENCE,
    rated,
    fen: startFen,
    challengeTarget: directedSite,
    ...wikiPgnContext(host),
    ...localSeatIdentityContext(),
  })
  delete chessState().awaitingStockfishSetup
  if (gameType === 'human') {
    chessState().gameSettings = mergeGameSettings(chessState()?.gameSettings, {
      challengeCreatorColor: challengeCreatorColor === CHALLENGE_COLOR_RANDOM ? CHALLENGE_COLOR_RANDOM : '',
    })
  }
  // Same-device guests: force local (yellow-halo) persist so seats/moves materialize
  // without wiki owner sign-in and so FedWiki ghost fade drops on first seed.
  if (gameType === 'human' && humanPlayMode === HUMAN_PLAY_SAME_DEVICE && isGuestViewer()) {
    enableGuestLocalStoragePersistForPlay()
  }
  initializeChess({
    format: 'PGN',
    signedInDisplayName: chessState()?.signedInDisplayName,
    wikiSite: host,
    wikiSiteUrl: chessState()?.wikiSiteUrl,
    wikiPageName: chessState()?.wikiPageName,
    wikiPageTitle: chessState()?.wikiPageTitle,
    pageOnThisWiki: chessState()?.pageOnThisWiki,
    guestLocalStoragePersist: chessState()?.guestLocalStoragePersist,
    ownerCanJournalHere: chessState()?.ownerCanJournalHere,
    viewerCanClaimWikiSeat: chessState()?.viewerCanClaimWikiSeat,
    // Keep ghost materialize flags through the board rebuild so seedNow still
    // journals an origin create (not a yellow-halo edit on a missing slug).
    createPreviewPendingJournal: chessState()?.createPreviewPendingJournal,
    wikiGhostPage: chessState()?.wikiGhostPage,
    gameSettings: chessState()?.gameSettings,
    gameType,
    humanPlayMode: gameType === 'human' ? humanPlayMode : undefined,
    needsSeed: true,
    PGN: seededPgn,
  })
  postShellSessionFlags({ bareKeywordGuard: false, awaitingStockfishSetup: false })
  if (seedNow) {
    putJournal(seededPgn)
    // Only clear needsSeed when the write could land (owner journal or guest yellow
    // halo). Guests who could not persist yet keep needsSeed for seedWikiIfNeeded.
    if (canPersistPosition()) delete chessState().needsSeed
  }
  maybePublishPageOpenChallenge(seededPgn)
  // We may have arrived here from the position editor, where the shell was told
  // (via mode-changed) to show "Save position to wiki". Tell it we're now a game so
  // it drops that button — symmetric with switchToPositionEditorFromGame.
  //
  // Seed immediately for bare GAME/POSITION keywords and create-preview ghosts so
  // chosen seats stick and the lineup ghost materializes (drops FedWiki opacity).
  // When seedNow is false (e.g. replacing an existing saved game from the toolbar),
  // GAME_READY persists once the board is ready (needsSeed below).
  wiki.modeChanged({
    chessObj: {
      gameType,
      mode: 'GAME',
      format: 'PGN',
      // Already journaled above when seedNow; otherwise GAME_READY persists seats.
      needsSeed: !seedNow,
    },
  })
}

// The local viewer's seat identity — their federated "host (name)" when they own
// this page, otherwise a plain guest name. Used to seat the board and to label the
// creator/opponent of an open challenge.
function localSeatId() {
  return localPlayerSeatId({
    signedInDisplayName: chessState()?.signedInDisplayName,
    wikiSite: pgnStampSite(),
    ...localSeatIdentityContext(),
  })
}

// CHOOSE / new-game → "Open challenge": post a seek any qualifying wiki player can accept.
// Only an authenticated page owner can create one. Seek fields live in the ghost PGN
// (ChallengeTarget / rating tags); the shell stores the seek on My Chess Games survey metadata
// until an opponent accepts — then a properly titled game page is created.
// Create closes the setup modal first; Cancel on this confirm must unwind to survey/menu
// without re-crawling open challenges (the list was current when Post was opened).
function abortOpenChallengePublish({ setupOrigin = null } = {}) {
  if (chessState()?.itemId) dismissOpenChallengeSetupItem(chessState().itemId)
  clearOpenChallengeSetupFlag()
  clearActiveGhostPageTitleKey()
  if (setupOrigin === 'survey') {
    keepSiteSurveySnapshotOnReturn()
    returnToSurveyItemView()
    return
  }
  const overrideSnapshot = getMenuResumeSnapshotBeforeNewGame()
  setMenuResumeSnapshotBeforeNewGame(undefined)
  returnToStartMenu({ overrideSnapshot, useOverride: true })
}

function confirmOpenChallenge(params) {
  const directed = Boolean(normalizeWikiSiteInput(params?.challengeTarget))
  openWithEmbeddedMount(
    openChallengePublishConfirmModal,
    {
      directed,
      challengeTarget: directed ? normalizeWikiSiteInput(params.challengeTarget) : '',
      onConfirm: () => finishOpenChallenge(params),
      onCancel: () => abortOpenChallengePublish(params),
    },
    notifyWikiHeight,
  )
}

function newGhostItemId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = new Uint8Array(8)
      crypto.getRandomValues(a)
      return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* fall through */
  }
  let s = ''
  while (s.length < 16) s += Math.floor(Math.random() * 16).toString(16)
  return s.slice(0, 16)
}

function isOpenChallengeGhostPage() {
  return Boolean(
    chessState()?.createPreviewPendingJournal ||
      chessState()?.openChallengeSetupPending ||
      resolveGhostPageTitleKey() ||
      chessState()?.wikiGhostPage,
  )
}

function finishOpenChallenge({
  rated = false,
  creatorColor = CHALLENGE_COLOR_RANDOM,
  minRating = '',
  maxRating = '',
  challengeTarget = '',
  fen,
  seedNow = false,
  setupOrigin = null,
  title = '',
} = {}) {
  const startFen = fen || app.fenEditor?.state?.fen?.toString() || START_FEN
  // Blank ChallengeTarget = open federation seek (anyone can accept).
  const directedChallengeTarget = normalizeWikiSiteInput(challengeTarget) || ''
  if (!chessState()?.pageOnThisWiki) {
    // Guests can't journal a challenge to a page they don't own. Fall back to a plain
    // local game vs the engine rather than silently doing nothing.
    startGameFromPosition({ gameType: 'engine', fen: startFen, seedNow })
    return
  }
  clearNewGameSetupForGameStart()
  const resume = getMenuResumeSnapshotBeforeNewGame()
  setMenuResumeSnapshotBeforeNewGame(undefined)
  clearBrowseStartMenuState()

  const host = pgnStampSite()
  const creatorId = localSeatId()
  const challenge = buildOpenChallenge({
    rated,
    creatorColor,
    minRating,
    maxRating,
    creatorId,
    creatorSite: host,
    creatorRating: ownRatingValue(host),
    challengeTarget: directedChallengeTarget,
  })
  const postingFromSurvey = setupOrigin === 'survey'
  const onGhostPage = isOpenChallengeGhostPage()
  const ghostItemId = newGhostItemId()
  const ghostTitle = openChallengeDisplayTitle({ challenge, title })
  const localSeat = challenge?.config.creatorColor === CHALLENGE_COLOR_BLACK ? 'b' : 'w'
  const creatorColorPref =
    creatorColor === CHALLENGE_COLOR_RANDOM ? 'Random' : creatorColor === CHALLENGE_COLOR_BLACK ? 'Black' : 'White'
  const seededPgn = buildStartPgn({
    gameType: 'human',
    localSeat,
    humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
    rated,
    fen: startFen,
    signedInDisplayName: chessState()?.signedInDisplayName,
    wikiSite: host,
    wikiSiteUrl: chessState()?.wikiSiteUrl,
    wikiPageName: '',
    itemId: ghostItemId,
    pageOnThisWiki: true,
    challengeCreator: creatorId,
    creatorColorPref,
    minRating: challenge?.config.minRating,
    maxRating: challenge?.config.maxRating,
    challengeTarget: challenge?.challengeTarget || '',
    challengeTs: challenge?.ts || Date.now(),
    creatorRating: challenge?.creator?.rating,
    ...localSeatIdentityContext(),
  })
  const stampedPgn = stampOpenChallengePgn(seededPgn, challenge)

  clearOpenChallengeSetupFlag()
  clearActiveGhostPageTitleKey()
  if (chessState()?.itemId) dismissOpenChallengeSetupItem(chessState().itemId)

  wiki.challengeChanged({
    challenge,
    openMyChessGames: false,
    dismissGhostPage: onGhostPage,
    ghost: { itemId: ghostItemId, pgn: stampedPgn, title: ghostTitle },
  })

  if (postingFromSurvey) {
    // Own seek is already known — paint it locally; do not federation-crawl to rediscover it.
    addPostedOpenChallengeLocally({
      itemId: ghostItemId,
      pgn: stampedPgn,
      title: ghostTitle,
      challenge,
      site: host,
    })
    returnToSurveyItemView()
  } else if (!onGhostPage) {
    returnToStartMenu({ overrideSnapshot: resume, useOverride: true })
    postShellSessionFlags({ bareKeywordGuard: 'CHOOSE' })
    // The setup modal may have journaled a throwaway GAME/engine board — restore CHOOSE.
    if (canPersistPosition()) {
      wiki.positionChanged({ text: 'CHOOSE' })
    }
  }
}

function readStartModalOpponent() {
  const value = document.getElementById('positionOpponent')?.value
  return value === 'engine' || value === 'human' ? value : ''
}

function syncOpponentPickButtons(opponent = readStartModalOpponent()) {
  for (const btn of document.querySelectorAll('.wiki-opponent-pick-btn')) {
    const selected = btn.dataset.opponent === opponent
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false')
    btn.classList.toggle('btn-primary', selected)
    btn.classList.toggle('btn-outline-primary', !selected)
  }
}

function syncHumanPlayPickButtons(mode = readStartModalHumanPlayMode()) {
  for (const btn of document.querySelectorAll('.wiki-human-play-pick-btn')) {
    const selected = Boolean(mode) && normalizeHumanPlayMode(btn.dataset.humanPlay) === mode
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false')
    btn.classList.toggle('btn-primary', selected)
    btn.classList.toggle('btn-outline-primary', !selected)
  }
}

function readStartModalOrientation() {
  const raw = document.getElementById('positionSameDeviceOrientation')?.value
  if (raw === 'opposite-sides' || raw === 'hand-around') return raw
  return ''
}

// '' until chosen on opposite-sides; unused for hand-around.
function readStartModalFlipChoice() {
  if (readStartModalOrientation() !== 'opposite-sides') return ''
  const raw = document.getElementById('positionSameDeviceFlip')?.value
  if (raw === 'true') return true
  if (raw === 'false') return false
  return ''
}

// Pass-around (= hand-around) starts with pass-and-play board flip on.
function readStartModalSameDeviceFlip() {
  return readStartModalOrientation() === 'hand-around'
}

// Opposite sides → Flip pieces: rotate glyphs in place (not board reorientation).
function readStartModalSameDeviceFlipPieces() {
  return readStartModalOrientation() === 'opposite-sides' && readStartModalFlipChoice() === true
}

// Don't flip (opposite-sides, upright) → Shapes for both seats. Dialog-level default
// only — an auto-recommended set is applied for this session, never persisted as the
// site-wide piece set (see beginSeatedGame). Flip pieces / pass-around / not yet
// chosen → saved preference or Merida.
function recommendedSameDevicePieceSetId() {
  if (readStartModalFlipChoice() === false) return 'shapes'
  return loadPieceSetPreference() || DEFAULT_PIECE_SET_ID
}

function readStartModalSameDevicePieceId() {
  const picker = document.getElementById('positionSameDevicePiecePicker')
  return normalizePieceSetId(picker?.dataset.selectedPieceSet || recommendedSameDevicePieceSetId())
}

function isSameDeviceSetupComplete() {
  if (readStartModalHumanPlayMode() !== HUMAN_PLAY_SAME_DEVICE) return true
  const orient = readStartModalOrientation()
  if (!orient) return false
  if (orient === 'opposite-sides' && readStartModalFlipChoice() === '') return false
  return Boolean(document.getElementById('positionSameDevicePiecePicker')?.dataset.selectedPieceSet)
}

function applyRecommendedSameDevicePieceSet({ force = false } = {}) {
  const picker = document.getElementById('positionSameDevicePiecePicker')
  if (!picker) return
  const recommended = recommendedSameDevicePieceSetId()
  if (force || !picker.dataset.selectedPieceSet || picker.dataset.pieceSetFromRecommend !== 'manual') {
    picker.dataset.selectedPieceSet = recommended
    picker.dataset.pieceSetFromRecommend = 'auto'
  }
  populatePieceSetPickers()
  // Always start collapsed — same height as the other pick buttons until the player opens it.
  const chooser = picker.querySelector('.wiki-chess-piece-set-chooser')
  if (chooser) chooser.open = false
  const hint = document.getElementById('positionSameDevicePieceHint')
  if (hint) {
    hint.hidden = false
    hint.textContent =
      recommended === 'shapes'
        ? 'Shapes stay readable from both seats. Open to pick another set.'
        : 'Merida is the default. Open to pick another set — Shapes work well from both seats if you prefer not to flip.'
  }
}

function syncSameDeviceOrientButtons(orientation = readStartModalOrientation()) {
  for (const btn of document.querySelectorAll('.wiki-same-device-orient-btn')) {
    const selected = Boolean(orientation) && btn.dataset.orientation === orientation
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false')
    btn.classList.toggle('btn-primary', selected)
    btn.classList.toggle('btn-outline-primary', !selected)
  }
  const hint = document.getElementById('positionSameDeviceOrientHint')
  if (hint) {
    if (!orientation) {
      hint.hidden = true
    } else {
      hint.hidden = false
      hint.textContent =
        orientation === 'opposite-sides'
          ? 'Sit facing each other across the board.'
          : 'Pass one device between turns — the board flips to face whoever moves next.'
    }
  }
}

function syncSameDeviceFlipButtons(flipChoice = readStartModalFlipChoice()) {
  for (const btn of document.querySelectorAll('.wiki-same-device-flip-btn')) {
    const btnFlip = btn.dataset.flip === 'true'
    const selected = flipChoice !== '' && btnFlip === flipChoice
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false')
    btn.classList.toggle('btn-primary', selected)
    btn.classList.toggle('btn-outline-primary', !selected)
  }
  const hint = document.getElementById('positionSameDeviceFlipHint')
  if (hint) {
    if (flipChoice === '') {
      hint.hidden = true
    } else {
      hint.hidden = false
      hint.textContent =
        flipChoice === true
          ? 'After each move, pieces rotate 180° in place to face whoever moves next. The board stays put.'
          : 'Pieces stay upright for the near player’s view. Shapes work well from both seats.'
    }
  }
}

// Progressive same-device steps: orientation → (flip if opposite) + piece set right away.
function syncSameDeviceProgressiveUI() {
  const orient = readStartModalOrientation()
  const flipChoice = readStartModalFlipChoice()
  syncSameDeviceOrientButtons(orient)

  const flipWrap = document.getElementById('positionSameDeviceFlipToggleWrap')
  if (flipWrap) flipWrap.hidden = orient !== 'opposite-sides'
  if (orient === 'opposite-sides') syncSameDeviceFlipButtons(flipChoice)

  const showPiece = Boolean(orient)
  const pieceWrap = document.getElementById('positionSameDevicePieceWrap')
  if (pieceWrap) pieceWrap.hidden = !showPiece
  if (showPiece) applyRecommendedSameDevicePieceSet({ force: false })
}

function applyStartModalSameDeviceDefaults() {
  const orientEl = document.getElementById('positionSameDeviceOrientation')
  if (orientEl) orientEl.value = ''
  const flipEl = document.getElementById('positionSameDeviceFlip')
  if (flipEl) flipEl.value = ''
  const picker = document.getElementById('positionSameDevicePiecePicker')
  if (picker) {
    delete picker.dataset.selectedPieceSet
    delete picker.dataset.pieceSetFromRecommend
    const chooser = picker.querySelector('.wiki-chess-piece-set-chooser')
    if (chooser) chooser.open = false
  }
  const flipWrap = document.getElementById('positionSameDeviceFlipToggleWrap')
  if (flipWrap) flipWrap.hidden = true
  const pieceWrap = document.getElementById('positionSameDevicePieceWrap')
  if (pieceWrap) pieceWrap.hidden = true
  syncSameDeviceOrientButtons('')
  syncSameDeviceFlipButtons('')
}

function readStartModalHumanPlayMode() {
  const raw = document.getElementById('positionHumanPlay')?.value
  if (raw === HUMAN_PLAY_SAME_DEVICE || raw === HUMAN_PLAY_CORRESPONDENCE) {
    return normalizeHumanPlayMode(raw)
  }
  return ''
}

function readStartModalColorChoice(modalFields) {
  if (modalFields.isChallengePost) {
    const raw = document.getElementById('positionChallengeColor')?.value || CHALLENGE_COLOR_RANDOM
    if (raw === CHALLENGE_COLOR_WHITE) return parseStartModalColorChoice('w')
    if (raw === CHALLENGE_COLOR_BLACK) return parseStartModalColorChoice('b')
    return parseStartModalColorChoice('random')
  }
  return parseStartModalColorChoice(document.getElementById('positionHumanColor')?.value || 'random')
}

function readStartModalSelections() {
  const opponent = readStartModalOpponent() || 'engine'
  const opponentWikiSite = document.getElementById('positionOpponentWiki')?.value || ''
  const playFromControl = readStartModalHumanPlayMode()
  const modalFields = positionStartModalFields({
    opponent,
    humanPlayMode: playFromControl,
    opponentWikiSite,
    hideHumanPlayChoice: startModalChallengeOnly,
  })
  const humanPlayMode = modalFields.isChallengePost ? HUMAN_PLAY_CORRESPONDENCE : playFromControl
  const colorChoice = readStartModalColorChoice(modalFields)
  // Engine: always rated (vs-Stockfish track). Challenge posts: modal picker. Else casual.
  const rated = modalFields.isChallengePost
    ? document.getElementById('positionChallengeRated')?.value === 'rated'
    : opponent === 'engine'
  return {
    opponent,
    humanPlayMode,
    opponentWikiSite,
    modalFields,
    stockfishLevel: parseInt(document.getElementById('positionStockfishLevel')?.value, 10) || 1,
    localSeat: colorChoice.localSeat,
    creatorColor: colorChoice.creatorColor,
    colorIsRandom: colorChoice.isRandom,
    rated,
    opponentDisplayName: startModalOpponentDisplayName,
  }
}

function proposeStartModalPageTitle() {
  const selections = readStartModalSelections()
  const {
    opponent,
    humanPlayMode,
    modalFields,
    stockfishLevel,
    localSeat,
    creatorColor,
    rated,
    opponentWikiSite,
    opponentDisplayName,
  } = selections
  let opponentDisplayNameForTitle = opponentDisplayName
  if (modalFields.isChallengePost) {
    opponentDisplayNameForTitle = ''
  } else if (modalFields.hasWikiSiteIntent) {
    if (modalFields.wikiInputInvalidFormat || !startModalOpponentWikiValid) {
      opponentDisplayNameForTitle = '[wiki site]'
    } else if (startModalOpponentWikiChecking) {
      opponentDisplayNameForTitle = '…'
    }
  }
  return proposeNewGamePageTitle({
    opponent,
    humanPlayMode,
    localSeat,
    stockfishLevel,
    isOpenChallenge: modalFields.isChallengePost || modalFields.isOpenChallenge,
    creatorColor,
    rated,
    opponentWikiSite: modalFields.normalizedWikiSite || opponentWikiSite,
    opponentDisplayName: opponentDisplayNameForTitle,
    localPlayerName: seatResultBannerName(localSeatId()) || guestPlayerName() || 'You',
  })
}

function updateOpponentWikiFieldFeedback() {
  const input = document.getElementById('positionOpponentWiki')
  const hint = document.getElementById('positionOpponentWikiHint')
  const errorEl = document.getElementById('positionOpponentWikiError')
  if (!input) return

  const showError = Boolean(!startModalOpponentWikiValid && startModalOpponentWikiError)
  input.classList.toggle('is-invalid', showError)
  if (errorEl) {
    errorEl.textContent = showError ? startModalOpponentWikiError : ''
    errorEl.hidden = !showError
  }
  if (!hint) return
  if (showError) {
    hint.textContent = ''
    return
  }
  if (startModalOpponentWikiChecking && normalizeWikiSiteInput(input.value)) {
    hint.textContent = 'Checking that wiki site…'
    return
  }
  hint.textContent = normalizeWikiSiteInput(input.value)
    ? 'They fork this page on that wiki and click Accept challenge.'
    : 'Optional — leave blank for an open challenge anyone in the federation can join, or enter a wiki domain to challenge one site.'
}

// Enable start-modal submit when seats/settings are valid.
export function updateStartModalSubmitEnabled() {
  const startBtn = document.getElementById('positionStartGameBtn')
  if (!startBtn) return
  const opponent = readStartModalOpponent()
  const humanPlayMode = readStartModalHumanPlayMode()
  const opponentWikiSite = document.getElementById('positionOpponentWiki')?.value || ''
  const fields = positionStartModalFields({
    opponent,
    humanPlayMode,
    opponentWikiSite,
    hideHumanPlayChoice: startModalChallengeOnly,
  })
  const blockWikiSite =
    fields.showOpponentWikiWrap &&
    fields.hasWikiSiteIntent &&
    (fields.wikiInputInvalidFormat || startModalOpponentWikiChecking || !startModalOpponentWikiValid)
  const blockHumanPlay = opponent === 'human' && !startModalChallengeOnly && !humanPlayMode
  const blockSameDevice = !isSameDeviceSetupComplete()
  startBtn.hidden = !opponent
  startBtn.disabled = !opponent || blockHumanPlay || blockSameDevice || Boolean(blockWikiSite)
}

function scheduleOpponentDisplayNameLookup(host, { invalidFormat = false } = {}) {
  const raw = String(host || '').trim()
  const normalized = normalizeWikiSiteInput(host)
  window.clearTimeout(startModalOpponentLookupTimer)

  if (!raw) {
    startModalOpponentDisplayName = ''
    startModalOpponentWikiValid = true
    startModalOpponentWikiError = ''
    startModalOpponentWikiChecking = false
    syncStartModalPageTitleField()
    updateOpponentWikiFieldFeedback()
    updateStartModalSubmitEnabled()
    return
  }

  if (invalidFormat || !normalized) {
    startModalOpponentDisplayName = ''
    startModalOpponentWikiValid = false
    startModalOpponentWikiError = wikiSiteValidationErrorMessage('invalid-format')
    startModalOpponentWikiChecking = false
    syncStartModalPageTitleField()
    updateOpponentWikiFieldFeedback()
    updateStartModalSubmitEnabled()
    return
  }

  startModalOpponentWikiChecking = true
  startModalOpponentWikiError = ''
  updateOpponentWikiFieldFeedback()
  updateStartModalSubmitEnabled()

  startModalOpponentLookupTimer = window.setTimeout(() => {
    void (async () => {
      const gen = ++startModalOpponentLookupGen
      let result = { valid: false, error: 'unreachable', displayName: '' }
      try {
        result = await probeWikiSiteForChallenge(host)
      } catch {
        /* handled below */
      }
      if (gen !== startModalOpponentLookupGen) return
      startModalOpponentWikiChecking = false
      startModalOpponentWikiValid = result.valid
      if (result.valid) {
        startModalOpponentDisplayName = result.displayName || fallbackWikiSiteDisplayLabel(normalized)
        startModalOpponentWikiError = ''
      } else {
        startModalOpponentDisplayName = ''
        startModalOpponentWikiError = wikiSiteValidationErrorMessage(result.error)
      }
      syncStartModalPageTitleField()
      updateOpponentWikiFieldFeedback()
      updateStartModalSubmitEnabled()
    })()
  }, 400)
}

function shouldSyncGhostPageTitleToWiki() {
  if (app.pwaBridgeActive) return false
  if (!app.wikiFrame || sessionFollowsPopup()) return false
  return (
    isCreatePreviewContext() ||
    isReplaceableGhostPageTitle(chessState()?.wikiPageTitle) ||
    Boolean(chessState()?.wikiGhostPage)
  )
}

// Push ghost page title edits to the shell (debounced unless immediate).
export function postGhostPageTitleToWiki(title, { immediate = false } = {}) {
  if (!shouldSyncGhostPageTitleToWiki()) return
  const next = String(title || '').trim()
  if (!next) return
  chessState().wikiPageTitle = next
  window.clearTimeout(startModalGhostTitleTimer)
  const pageKey = resolveGhostPageTitleKey()
  const send = () =>
    wiki.updateGhostPageTitle({
      title: next,
      ...(pageKey ? { pageKey } : {}),
    })
  if (immediate) send()
  else startModalGhostTitleTimer = window.setTimeout(send, 250)
}

function postStartModalGhostPageTitle(title, { immediate = false } = {}) {
  postGhostPageTitleToWiki(title, { immediate })
}

function syncStartModalPageTitleField(proposedTitle) {
  const proposed = String(proposedTitle || proposeStartModalPageTitle()).trim()
  const modal = document.getElementById('wikiFenStartModal')
  const modalOpen = modal && !modal.hidden
  const showModalField = shouldShowStartModalPageTitleField()
  const showPwaChrome = showsPwaPageTitleChrome()
  const syncWikiGhost = shouldSyncGhostPageTitleToWiki()
  // wirePositionEditor() calls updatePositionOpponentUI() on every position-editor
  // entry; only push the modal's auto-built *game* title while that modal is open (or
  // during CHOOSE → Play New Game setup), not when browsing position/puzzle ghosts.
  const applyModalProposedTitle = modalOpen || isNewGameSetupActive()

  if (modalOpen && !startModalPageTitleDirty) {
    if (!startModalPageTitlePinned || isReplaceableGhostPageTitle(chessState()?.wikiPageTitle)) {
      chessState().wikiPageTitle = proposed
    }
  }

  if (!startModalPageTitleDirty && applyModalProposedTitle) {
    if (showPwaChrome) syncLinkedPageTitleInputs(proposed)
    if (showModalField) syncLinkedPageTitleInputs(proposed)
    if (syncWikiGhost) postStartModalGhostPageTitle(proposed)
    if (
      app.pwaBridgeActive &&
      chessState()?.pwaChessItemPending &&
      chessState()?.pwaChessItemContext?.kind === 'game' &&
      isReplaceableGhostPageTitle(chessState()?.wikiPageTitle)
    ) {
      schedulePwaChessItemRetitle(proposed)
    }
  }

  if (!modalOpen || !showModalField) return
  const input = document.getElementById('positionStartPageTitle')
  if (!input || startModalPageTitleDirty) return
  const currentTitle = String(chessState()?.wikiPageTitle || '').trim()
  if (!startModalPageTitlePinned || !currentTitle || isReplaceableGhostPageTitle(currentTitle)) {
    if (input.value !== proposed) input.value = proposed
  } else if (!input.value) {
    input.value = currentTitle
  }
}

function readStartModalPageTitle() {
  const pwaInput = document.getElementById('wikiChessPwaPageTitle')
  if (showsPwaPageTitleChrome() && pwaInput) {
    const manual = String(pwaInput.value || '').trim()
    if (manual) return manual
  }
  const input = document.getElementById('positionStartPageTitle')
  if (shouldShowStartModalPageTitleField() && input) {
    const manual = String(input?.value || '').trim()
    if (manual) return manual
  }
  return proposeStartModalPageTitle()
}

function applyStartModalPageTitle() {
  const title = readStartModalPageTitle()
  if (!title) return
  chessState().wikiPageTitle = title
  window.clearTimeout(startModalGhostTitleTimer)
  postStartModalGhostPageTitle(title, { immediate: true })
}

function resetStartModalPageTitleState() {
  startModalPageTitleDirty = false
  startModalPageTitlePinned = false
  startModalOpponentDisplayName = ''
  startModalOpponentWikiValid = true
  startModalOpponentWikiError = ''
  startModalOpponentWikiChecking = false
  window.clearTimeout(startModalGhostTitleTimer)
  window.clearTimeout(startModalOpponentLookupTimer)
  startModalOpponentLookupGen += 1
  const input = document.getElementById('positionStartPageTitle')
  if (input) input.value = ''
  const wikiInput = document.getElementById('positionOpponentWiki')
  if (wikiInput) wikiInput.classList.remove('is-invalid')
  const wikiError = document.getElementById('positionOpponentWikiError')
  if (wikiError) {
    wikiError.textContent = ''
    wikiError.hidden = true
  }
}

function syncStartModalColorPickers({ preferChallenge = false } = {}) {
  const humanColor = document.getElementById('positionHumanColor')
  const challengeColor = document.getElementById('positionChallengeColor')
  if (!humanColor || !challengeColor) return
  if (preferChallenge) {
    const choice = parseStartModalColorChoice(humanColor.value || 'random')
    if (choice.creatorColor === CHALLENGE_COLOR_BLACK) challengeColor.value = CHALLENGE_COLOR_BLACK
    else if (choice.creatorColor === CHALLENGE_COLOR_WHITE) challengeColor.value = CHALLENGE_COLOR_WHITE
    else challengeColor.value = CHALLENGE_COLOR_RANDOM
    return
  }
  const raw = challengeColor.value || CHALLENGE_COLOR_RANDOM
  if (raw === CHALLENGE_COLOR_WHITE) humanColor.value = 'w'
  else if (raw === CHALLENGE_COLOR_BLACK) humanColor.value = 'b'
  else humanColor.value = 'random'
}

function updatePositionOpponentUI() {
  const opponent = readStartModalOpponent()
  syncOpponentPickButtons(opponent)
  const humanPlayMode = readStartModalHumanPlayMode()
  syncHumanPlayPickButtons(humanPlayMode)
  const opponentWikiSite = document.getElementById('positionOpponentWiki')?.value || ''
  const fields = positionStartModalFields({
    opponent,
    humanPlayMode,
    opponentWikiSite,
    hideHumanPlayChoice: startModalChallengeOnly,
  })
  const levelWrap = document.getElementById('positionStockfishLevelWrap')
  const humanColorWrap = document.getElementById('positionHumanColorWrap')
  const humanPlayWrap = document.getElementById('positionHumanPlayWrap')
  const humanHint = document.getElementById('positionHumanHint')
  const opponentWikiWrap = document.getElementById('positionOpponentWikiWrap')
  const challengeWrap = document.getElementById('positionChallengeWrap')
  const titleEl = document.getElementById('wiki-fen-start-title')
  const leadEl = document.getElementById('wiki-fen-start-lead')
  // Human remote challenges use open-challenge format/color/rating-range fields until
  // an opponent accepts. Engine games always track vs-Stockfish rating (no format picker).
  if (challengeWrap) challengeWrap.hidden = !fields.showChallengeWrap
  if (levelWrap) levelWrap.hidden = !fields.showLevelWrap
  if (humanPlayWrap) humanPlayWrap.hidden = !fields.showHumanPlayWrap
  const sameDeviceWrap = document.getElementById('positionSameDeviceWrap')
  if (sameDeviceWrap) sameDeviceWrap.hidden = !fields.showSameDeviceWrap
  if (fields.showSameDeviceWrap) {
    syncSameDeviceProgressiveUI()
  } else {
    applyStartModalSameDeviceDefaults()
  }
  if (opponentWikiWrap) opponentWikiWrap.hidden = !fields.showOpponentWikiWrap
  updateOpponentWikiFieldFeedback()
  if (humanColorWrap) humanColorWrap.hidden = !fields.showHumanColorWrap
  if (startModalWasOpenChallenge !== fields.isChallengePost) {
    if (startModalWasOpenChallenge === true && !fields.isChallengePost && fields.showHumanColorWrap) {
      syncStartModalColorPickers()
    } else if (startModalWasOpenChallenge === false && fields.isChallengePost) {
      syncStartModalColorPickers({ preferChallenge: true })
    }
    startModalWasOpenChallenge = fields.isChallengePost
  }
  // Make clear that remote human play posts a challenge (open unless a wiki is named).
  if (!startModalChallengeOnly && titleEl && leadEl) {
    if (fields.isChallengePost) {
      titleEl.textContent = fields.isOpenChallenge ? 'Create an open challenge' : 'Create a challenge'
      leadEl.hidden = false
      leadEl.textContent = fields.isOpenChallenge
        ? 'This posts an open challenge to the federation. Anyone who meets your terms can accept and start the game.'
        : 'This creates a challenge for that wiki. They fork the page and accept to sit down.'
    } else if (startModalBaseTitle || startModalBaseLead) {
      titleEl.textContent = startModalBaseTitle || titleEl.textContent
      if (startModalBaseLead) {
        leadEl.hidden = false
        leadEl.textContent = startModalBaseLead
      } else {
        leadEl.hidden = true
        leadEl.textContent = ''
      }
    }
  }
  const titleWrap = document.getElementById('positionStartPageTitleWrap')
  if (titleWrap) titleWrap.hidden = !shouldShowStartModalPageTitleField()
  const startBtn = document.getElementById('positionStartGameBtn')
  if (startBtn) {
    startBtn.textContent = fields.isChallengePost
      ? fields.isOpenChallenge
        ? 'Create open challenge'
        : 'Create challenge'
      : 'Start Game'
  }
  if (humanHint) {
    if (!fields.showHumanHint) {
      humanHint.hidden = true
    } else if (fields.isChallengePost) {
      const target = fields.normalizedWikiSite
      if (fields.isOpenChallenge) {
        humanHint.textContent =
          'Open challenge — listed in the federation browser until someone accepts. A game page is created when they sit down.'
        humanHint.hidden = false
      } else if (
        target &&
        !fields.wikiInputInvalidFormat &&
        (startModalOpponentWikiValid || startModalOpponentWikiChecking)
      ) {
        humanHint.innerHTML = `Directed challenge — for <strong>${escapeHtml(target)}</strong>. They fork this page on that wiki and click <em>Accept challenge</em>.`
        humanHint.hidden = false
      } else {
        humanHint.hidden = true
      }
    } else {
      humanHint.hidden = true
    }
  }
  if (fields.showOpponentWikiWrap) {
    scheduleOpponentDisplayNameLookup(opponentWikiSite, {
      invalidFormat: fields.wikiInputInvalidFormat,
    })
  } else {
    startModalOpponentDisplayName = ''
    startModalOpponentWikiValid = true
    startModalOpponentWikiError = ''
    startModalOpponentWikiChecking = false
  }
  syncStartModalPageTitleField()
  updateStartModalSubmitEnabled()
  notifyWikiHeight()
}

// Wire FEN editor save/start-from-position controls for GAME flow.
export function wirePositionEditor() {
  const levelSelect = document.getElementById('positionStockfishLevel')
  const opponentSelect = document.getElementById('positionOpponent')
  const startBtn = document.getElementById('positionStartGameBtn')
  if (!levelSelect || !opponentSelect || !startBtn || opponentSelect._wikiWired) return
  opponentSelect._wikiWired = true

  levelSelect.innerHTML = ''
  for (let level = 1; level <= STOCKFISH_MAX_LEVEL; level++) {
    const option = document.createElement('option')
    option.value = String(level)
    option.textContent = `Level ${level} · ~${stockfishLevelElo(level)} Elo`
    if (level === 1) option.selected = true
    levelSelect.appendChild(option)
  }

  const versionEl = document.getElementById('positionStockfishVersion')
  if (versionEl) versionEl.textContent = `Engine: Stockfish ${STOCKFISH_VERSION}`

  document.querySelectorAll('.wiki-opponent-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.opponent
      if (next !== 'engine' && next !== 'human') return
      opponentSelect.value = next
      updatePositionOpponentUI()
    })
  })
  document.querySelectorAll('.wiki-human-play-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = normalizeHumanPlayMode(btn.dataset.humanPlay)
      const humanPlay = document.getElementById('positionHumanPlay')
      if (!humanPlay) return
      humanPlay.value = next
      applyStartModalSameDeviceDefaults()
      updatePositionOpponentUI()
    })
  })
  document.querySelectorAll('.wiki-same-device-orient-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.orientation === 'hand-around' ? 'hand-around' : 'opposite-sides'
      const orientEl = document.getElementById('positionSameDeviceOrientation')
      if (orientEl) orientEl.value = next
      const flipEl = document.getElementById('positionSameDeviceFlip')
      if (flipEl) flipEl.value = ''
      const picker = document.getElementById('positionSameDevicePiecePicker')
      if (picker) {
        delete picker.dataset.selectedPieceSet
        delete picker.dataset.pieceSetFromRecommend
      }
      applyRecommendedSameDevicePieceSet({ force: true })
      syncSameDeviceProgressiveUI()
      updateStartModalSubmitEnabled()
      notifyWikiHeight()
    })
  })
  document.querySelectorAll('.wiki-same-device-flip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const flipOn = btn.dataset.flip === 'true'
      const flipEl = document.getElementById('positionSameDeviceFlip')
      if (flipEl) flipEl.value = flipOn ? 'true' : 'false'
      // Don't flip → Shapes; Flip pieces (and pass-around) → Merida.
      applyRecommendedSameDevicePieceSet({ force: true })
      syncSameDeviceProgressiveUI()
      updateStartModalSubmitEnabled()
      notifyWikiHeight()
    })
  })
  opponentSelect.addEventListener('change', updatePositionOpponentUI)
  document.getElementById('positionHumanColor')?.addEventListener('change', updatePositionOpponentUI)
  document.getElementById('positionHumanPlay')?.addEventListener('change', updatePositionOpponentUI)
  document.getElementById('positionOpponentWiki')?.addEventListener('input', updatePositionOpponentUI)
  levelSelect.addEventListener('change', updatePositionOpponentUI)
  document.getElementById('positionChallengeRated')?.addEventListener('change', updatePositionOpponentUI)
  document.getElementById('positionChallengeColor')?.addEventListener('change', updatePositionOpponentUI)
  const pageTitleInput = document.getElementById('positionStartPageTitle')
  if (pageTitleInput && !pageTitleInput._wikiWired) {
    pageTitleInput._wikiWired = true
    pageTitleInput.addEventListener('input', () => {
      startModalPageTitleDirty = true
      startModalPageTitlePinned = false
      const next = pageTitleInput.value
      chessState().wikiPageTitle = next
      syncLinkedPageTitleInputs(next, { fromModal: true })
      postStartModalGhostPageTitle(next)
    })
  }

  // Modal dismissal: Cancel button and backdrop both carry the dismiss hook.
  document
    .getElementById('wikiFenStartModal')
    ?.querySelectorAll('[data-wiki-fen-start-dismiss]')
    .forEach(el => el.addEventListener('click', () => closePositionStartModal()))

  startBtn.addEventListener('click', () => {
    // Capture which position to start from before closing resets the flag.
    const fen = newGameStartFen
    // Persist seated boards immediately so seats (and create-preview materialize) stick.
    // Capture before commitKeywordItem / closePositionStartModal clear these flags.
    const seedNow =
      chessState()?.bareKeywordGuard === 'GAME' ||
      chessState()?.bareKeywordGuard === 'POSITION' ||
      isCreatePreviewContext()
    const opponent = opponentSelect.value
    const opponentWikiSite = document.getElementById('positionOpponentWiki')?.value || ''
    const playFromControl = readStartModalHumanPlayMode()
    const modalFields = positionStartModalFields({
      opponent,
      humanPlayMode: playFromControl,
      opponentWikiSite,
      hideHumanPlayChoice: startModalChallengeOnly,
    })
    const humanPlayMode = modalFields.isChallengePost ? HUMAN_PLAY_CORRESPONDENCE : playFromControl
    if (
      modalFields.showOpponentWikiWrap &&
      modalFields.hasWikiSiteIntent &&
      (modalFields.wikiInputInvalidFormat || startModalOpponentWikiChecking || !startModalOpponentWikiValid)
    ) {
      updateOpponentWikiFieldFeedback()
      document.getElementById('positionOpponentWiki')?.focus({ preventScroll: true })
      return
    }
    const isChallengePost = modalFields.isChallengePost
    const setupOrigin = getNewGameSetupOrigin()
    applyStartModalPageTitle()
    // Capture open-challenge title and terms before closePositionStartModal() resets the
    // opponent dropdown to engine and clears challenge fields (otherwise the stored title
    // becomes "… vs Stockfish …" and rated/color/range revert to defaults).
    const openChallengeTitle = String(chessState()?.wikiPageTitle || readStartModalPageTitle() || '').trim()
    const openChallengeRated = document.getElementById('positionChallengeRated')?.value === 'rated'
    const openChallengeCreatorColor = document.getElementById('positionChallengeColor')?.value || CHALLENGE_COLOR_RANDOM
    const openChallengeMinRating = document.getElementById('positionChallengeMin')?.value ?? ''
    const openChallengeMaxRating = document.getElementById('positionChallengeMax')?.value ?? ''
    const openChallengeTarget = modalFields.normalizedWikiSite || ''
    // closePositionStartModal resets color/rated/opponent — read start choices first.
    const colorChoice = readStartModalColorChoice(modalFields)
    const stockfishLevel = parseInt(levelSelect.value, 10) || 1
    // Engine games always track vs-Stockfish rating; same-device is always casual.
    const rated = opponent === 'engine'
    const sameDeviceFlip = readStartModalSameDeviceFlip()
    let sameDeviceFlipPieces = readStartModalSameDeviceFlipPieces()
    const sameDevicePieceSetId =
      opponent === 'human' && humanPlayMode === HUMAN_PLAY_SAME_DEVICE ? readStartModalSameDevicePieceId() : null
    // Read before closePositionStartModal() resets the picker's dataset.
    const sameDevicePieceSetIsManual =
      document.getElementById('positionSameDevicePiecePicker')?.dataset.pieceSetFromRecommend === 'manual'
    // Shapes never use in-place glyph flip (shadows stay seat-correct either way).
    if (sameDevicePieceSetId && !pieceSetAllowsInPlaceFlip(sameDevicePieceSetId)) {
      sameDeviceFlipPieces = false
    }

    const beginSeatedGame = () => {
      // Confirming is not a cancel: clear the new-game-setup guard up front so
      // closePositionStartModal() doesn't bounce us back to the menu / board.
      exitNewGameSetup()
      if (!isChallengePost) setMenuResumeSnapshotBeforeNewGame(undefined)
      closePositionStartModal()
      if (sameDevicePieceSetId) {
        // Manual pick → persist as the viewer's piece set. Auto-recommended (e.g.
        // Don't flip → Shapes) → session-only, so the site default stays Merida.
        if (sameDevicePieceSetIsManual) savePieceSetPreference(sameDevicePieceSetId)
        else applySessionPieceSetOverride(sameDevicePieceSetId)
        syncPieceSetPickersUI()
      }
      if (opponent === 'human' && humanPlayMode === HUMAN_PLAY_SAME_DEVICE) {
        chessState().gameSettings = mergeGameSettings(chessState()?.gameSettings, {
          sameDeviceFlip,
          sameDeviceFlipPieces,
        })
        persistGameSettings(chessState().gameSettings)
        if (isGuestViewer()) enableGuestLocalStoragePersistForPlay()
      }
      commitKeywordItem()
      const gameType = opponent === 'human' ? 'human' : 'engine'
      let localSeat = colorChoice.localSeat
      if (colorChoice.isRandom && gameType === 'engine') {
        localSeat = Math.random() < 0.5 ? 'w' : 'b'
      }
      startGameFromPosition({
        gameType,
        stockfishLevel,
        localSeat,
        humanPlayMode,
        opponentWikiSite: normalizeWikiSiteInput(opponentWikiSite),
        challengeCreatorColor: colorChoice.isRandom ? CHALLENGE_COLOR_RANDOM : '',
        rated,
        fen,
        seedNow,
      })
    }

    if (isChallengePost) {
      exitNewGameSetup()
      closePositionStartModal()
      confirmOpenChallenge({
        title: openChallengeTitle,
        rated: openChallengeRated,
        creatorColor: openChallengeCreatorColor,
        minRating: openChallengeMinRating,
        maxRating: openChallengeMaxRating,
        challengeTarget: openChallengeTarget,
        fen,
        seedNow,
        setupOrigin,
      })
      return
    }
    if (opponent === 'human' && humanPlayMode === HUMAN_PLAY_SAME_DEVICE && shouldOfferGuestLocalSameDevicePlay()) {
      // Keep the start modal open until they confirm local-only play (or cancel).
      confirmGuestLocalSameDevicePlay(beginSeatedGame)
      return
    }
    beginSeatedGame()
  })

  updatePositionOpponentUI()
}

// extracted from chess-app.js
export function consoleSeatSignature(pgn) {
  if (!pgn || !/\[/.test(pgn)) return ''
  const seatKind = tag => {
    if (isOpenSeatTag(tag)) return 'open'
    if (parseStockfishLevel(tag) != null) return 'engine'
    return 'human'
  }
  return `${seatKind(getPgnTag(pgn, 'White'))}|${seatKind(getPgnTag(pgn, 'Black'))}`
}

// True when next PGN seat/engine config requires a new ChessConsole.
export function needsChessConsoleRebuild(nextPgn) {
  if (!app.chessConsole?._wikiSeatSignature) return false
  return app.chessConsole._wikiSeatSignature !== consoleSeatSignature(nextPgn)
}

function resolvedPgnSeatTag(parsedPGN, seat) {
  const sourcePgn = chessState()?.PGN || chessState()?.chessState || ''
  const fromParsed = parsedPGN?.header?.tags?.[seat]
  if (fromParsed != null && String(fromParsed).trim()) return fromParsed
  const fromSource = getPgnTag(sourcePgn, seat)
  return fromSource != null ? fromSource : openSeatPgnTag()
}

// # Console Create and Board Init

// Create (or reuse) the wiki ChessConsole for the parsed PGN.
export async function createWikiChessConsole(parsedPGN) {
  if (app.chessConsole) return app.chessConsole
  if (chessConsoleInitPromise) return chessConsoleInitPromise

  const setupGen = sessionConsoleGeneration(app.chessSession.getState())
  chessConsoleInitPromise = (async () => {
    await ensurePieceSpriteCached(getPieceSpritesUrl())
    if (setupGen !== sessionConsoleGeneration(app.chessSession.getState())) return null

    const localColor = localPlayerSeatColor()
    const whiteTag = resolvedPgnSeatTag(parsedPGN, 'White')
    const blackTag = resolvedPgnSeatTag(parsedPGN, 'Black')
    const white = configurePlayer(whiteTag, {
      interactive: viewerControlsSeat(whiteTag),
    })
    const black = configurePlayer(blackTag, {
      interactive: viewerControlsSeat(blackTag),
    })
    if (setupGen !== sessionConsoleGeneration(app.chessSession.getState())) return null
    whitePlayerKind = white.kind
    blackPlayerKind = black.kind

    let playerSlot
    let opponentSlot
    if (isSameDeviceHumanPlay(chessState())) {
      playerSlot = white
      opponentSlot = black
    } else {
      playerSlot = localColor === 'b' ? black : white
      opponentSlot = localColor === 'b' ? white : black
    }

    const console = new ChessConsole(
      document.getElementById('console-container'),
      playerSlot.player,
      opponentSlot.player,
      {
        figures: createStauntyFigures(getPieceSpritesUrl(), 18),
      },
    )
    if (setupGen !== sessionConsoleGeneration(app.chessSession.getState())) return null
    app.chessConsole = console
    app.chessConsole._wikiSeatSignature = consoleSeatSignature(chessState()?.PGN || chessState()?.chessState)
    app.chessConsole._wikiLocalSeat = localColor
    app.chessConsole._wikiInteractiveSeatKey = wikiInteractiveSeatKey(chessState()?.PGN || chessState()?.chessState)

    const itemId = new URLSearchParams(location.search).get('itemId') || 'standalone'
    const pageKey = new URLSearchParams(location.search).get('pageKey') || 'standalone'
    // Persistence supplies loadValue/saveValue for Stockfish dialog prefs (newGameColor).
    // Resume PGN for wiki/PWA is wiki journal + savePwaLocalSession — do not dual-write
    // WikiChess-*Pgn/PlayerColor on every board change.
    new Persistence(app.chessConsole, { savePrefix: `WikiChess-${pageKey}-${itemId}` })
    if (app.wikiFrame || app.isPwaStandalone) {
      app.chessConsole.persistence.save = () => {}
    }

    new Board(app.chessConsole, {
      assetsUrl: './assets/',
      // Inline sprites — external `<use href="….svg#wk">` drops Merida gradients on Chrome/Android.
      assetsCache: true,
      position: FEN.empty,
      style: {
        cssClass: 'green',
        borderType: 'frame',
        showCoordinates: true,
        pieces: { file: getPieceSetFile() },
      },
    }).initialized.then(() => {
      if (setupGen !== sessionConsoleGeneration(app.chessSession.getState())) return
      enhancePlayerLabels(app.chessConsole)
      // Wire journal autosave before initGame so Stockfish's opening reply (when the
      // human plays Black) is not missed while the engine move is being applied.
      wireJournalAutosave(app.chessConsole)
      if (app.wikiFrame || app.isPwaStandalone) {
        app.chessConsole.messageBroker.publish('game/load')
        // Only auto-request when Stockfish has the opening move. Human turns
        // (same-device, human-as-White vs engine, correspondence) get nextMove in
        // finishGameBoardInit so LocalPlayer can enable board input.
        const engineOpens = shouldRequestEngineMoveAfterInit(chessState().PGN)
        app.chessConsole.initGame(gameInitProps(), engineOpens)
        app.chessConsole._wikiNextMoveRequested = engineOpens
        maybeRewindLoadedGameToStart(app.chessConsole, chessState().PGN)
        // Games that stay at the tip: replay the last ply so visitors see how the
        // current position was reached (markers alone hide double-steps / captures).
        if (app.chessConsole.state.plyViewed > 0) {
          revealLastMoveWhenBoardSettles(app.chessConsole)
        }
      } else {
        app.chessConsole.persistence.load()
      }
      finishGameBoardInit()
    })
    wikiHistoryComponent = new History(app.chessConsole, { spriteUrl: getPieceSpritesUrl() })
    new HistoryControl(app.chessConsole)
    wikiCapturedComponent = new CapturedPieces(app.chessConsole, { spriteUrl: getPieceSpritesUrl() })
    new GameStateOutput(app.chessConsole)
    new Sound(app.chessConsole, { soundSpriteFile: './assets/sounds/chess_console_sounds.mp3' })
    patchSoundForSync(app.chessConsole)
    return app.chessConsole
  })()

  try {
    const console = await chessConsoleInitPromise
    if (!console) {
      chessConsoleInitPromise = null
      return null
    }
    return console
  } catch (err) {
    chessConsoleInitPromise = null
    app.chessConsole = undefined
    throw err
  }
}

// Post-console wiring: bars, autosave, layout fit, presence, banners.
export function finishGameBoardInit() {
  const board = app.chessConsole.components.board
  if (board && !board._wikiLabelsPatched) {
    enhancePlayerLabels(app.chessConsole)
  } else if (board) {
    renderWikiPlayerLabels(board, app.chessConsole)
  }
  wireJournalAutosave(app.chessConsole)
  wirePassAndPlayFlip(app.chessConsole)
  wireMoveConfirmation(app.chessConsole)
  wireGameComments(app.chessConsole)
  wireGameStatus(app.chessConsole)
  syncGameSettingsUI()
  // Guest same-device pages (incl. create-preview ghosts) may boot before the shell
  // flips guestLocalStoragePersist — enable so seedWikiIfNeeded can materialize.
  if (isSameDeviceHumanPlay(chessState()) && isGuestViewer()) {
    enableGuestLocalStoragePersistForPlay()
  }
  seedWikiIfNeeded()
  if (app.isPopupLayout) {
    fitPopupBoard()
    window.setTimeout(fitPopupBoard, 0)
    notifyPwaPlayLayoutReady()
  } else if (app.isWikiEmbed) {
    fitEmbedBoard()
    window.setTimeout(fitEmbedBoard, 0)
    window.setTimeout(fitEmbedBoard, 100)
  } else {
    scheduleBoardResize()
  }
  wireGameToolbar(app.chessConsole)
  configureBoardCoordinateMode()
  document.getElementById('game')?.classList.remove('wiki-awaiting-stockfish-setup')
  rememberPwaContext()
  persistPwaState()
  updateExportControls()
  ensureRemoteHumanSeatWiring()
  updateChallengeBanner()
  updatePwaPageChrome()
  ensureNewGameSetupModalOpen()
  // When initGame skipped nextMove (human to move), enable LocalPlayer input now.
  // Same-device pass-and-play was previously skipped via shouldWireLocalInputPlayer(),
  // leaving both seats unable to drag pieces.
  if (app.chessConsole && !app.chessConsole._wikiNextMoveRequested && !sessionFollowsPopup()) {
    app.chessConsole.nextMove()
    app.chessConsole._wikiNextMoveRequested = true
  }
  notifyWikiHeight()
  syncFooterNavVisibility()
  scheduleAuthLockLayout()
  flushGhostChessItemSyncIfReady()
}

function configurePlayer(name, { interactive = true } = {}) {
  const level = parseStockfishLevel(name)
  if (level != null && level >= 1 && level <= STOCKFISH_MAX_LEVEL) {
    return {
      player: {
        name,
        type: StockfishPlayer,
        props: {
          worker: './assets/js/stockfish-18-lite-single.js',
          level,
          debug: false,
        },
      },
      kind: 'stockfish',
    }
  }

  const playerName = isOpenSeatTag(name)
    ? OPEN_SEAT_LABEL
    : name || formatPlayerId(chessState()?.signedInDisplayName, pgnStampSite())
  if (!interactive) {
    return {
      player: {
        name: playerName,
        type: ChessConsolePlayer,
      },
      kind: 'remote',
    }
  }
  return {
    player: {
      name: playerName,
      type: LocalPlayer,
    },
    kind: undefined,
  }
}
