/**
 * Remote opponent move detection, WebRTC real-time play, and game sync coordination.
 *
 * §1 Pure realtime helpers (presence, signals) — in chess-core.js
 * §2 Game sync coordinator (single gate for external board updates)
 * §3 Remote poll accept / game-end prompts
 * §4 WebRTC peer channel
 * §5 Shell SET_STATE sync (applySyncedPosition)
 *
 * In-file landmarks use `// # Section Name` for navigation.
 *
 * The wiki shell polls the opponent's forked page and forwards PGN updates via SET_STATE;
 * this module validates continuations, prompts to fork moves in, and optionally upgrades
 * to a direct peer data channel when both players opt in.
 * Initialized from chess-app.js with live getters for reassigned app state.
 */

import {
  getHumanPlayMode,
  HUMAN_PLAY_CORRESPONDENCE,
  isSameDeviceHumanPlay,
  isDemoOrLessonGame,
  getPgnTag,
  normalizeWikiSite,
  opponentWikiSiteFromPgn,
  challengeOpponentWikiSite,
  normalizeFen,
  START_FEN,
  parsePgnParts,
  sanTokens,
  isDecisiveResult,
  gameResultFromPgn,
  seatScoreFromResult,
  formatGameResultSentence,
  getFormat,
  prepareWikiPgn,
  mergePgnWithSavedHeaders,
  mergeGameSettings,
  shouldKeepActiveShellSync,
  isStaleGhostChooseShellSync,
  shouldReinitChessViewFromSync,
  GAME_SYNC_SOURCE,
  gamePlyCount,
  evaluateGameSyncUpdate,
  normalizeRealtimeState,
  isRealtimeSeatReady,
  isRealtimeSeatRtcConsented,
} from './chess-core.js'
import { openConfirmModal, closeActiveModal, openEndRealtimeModal } from './modals.js'
import { openBoardOverlayConfirmModal, shellMessengerFromContext } from './board-layout.js'

function shellMessenger() {
  return shellMessengerFromContext(realtimeCtx)
}

// # Game Sync Coordinator

const gameSyncState = { localPlyEpoch: 0, applying: false }

// Reset local ply epoch from PGN; clears applying flag.
export function resetGameSyncEpoch(pgn = '') {
  gameSyncState.localPlyEpoch = gamePlyCount(pgn)
  gameSyncState.applying = false
}

// Advance local ply epoch to at least the PGN’s ply count.
export function bumpGameSyncEpoch(pgn = '') {
  gameSyncState.localPlyEpoch = Math.max(gameSyncState.localPlyEpoch, gamePlyCount(pgn))
}

// Mark that an external sync apply is in progress.
export function beginGameSyncApply() {
  gameSyncState.applying = true
}

// Clear the external sync applying flag.
export function endGameSyncApply() {
  gameSyncState.applying = false
}

// True while an external board update is being applied.
export function gameSyncApplying() {
  return gameSyncState.applying
}

function shouldAcceptExternalGameUpdate({ localPgn, incomingPgn, source, sameItemText = false }) {
  const verdict = evaluateGameSyncUpdate({
    localPgn,
    incomingPgn,
    source,
    localPlyEpoch: gameSyncState.localPlyEpoch,
    applying: gameSyncState.applying,
    sameItemText,
  })
  if (!verdict.accept && window.wiki?.debug && verdict.reason) {
    console.info(`[wiki-chess] game sync rejected (${source}): ${verdict.reason}`)
  }
  return verdict
}

// Seat that creates the WebRTC offer (White by convention).
export const REALTIME_OFFERER_SEAT = 'White'

// New SAN plies if remote strictly extends local history; else null.
export function remoteMoveContinuation(localSans, remoteSans) {
  const local = Array.isArray(localSans) ? localSans : []
  const remote = Array.isArray(remoteSans) ? remoteSans : []
  if (remote.length <= local.length) return null
  for (let i = 0; i < local.length; i += 1) {
    if (local[i] !== remote[i]) return null
  }
  return remote.slice(local.length)
}

// Setup FEN from PGN FEN tag, or START_FEN.
export function startingPositionFen(pgn) {
  const text = String(pgn || '')
  const fen = text ? getPgnTag(text, 'FEN') : null
  return fen ? normalizeFen(fen) : START_FEN
}

// Reject reason: remote has no new plies.
export const REMOTE_REJECT_NO_NEW_MOVE = 'no-new-move'
// Reject reason: starting FEN differs.
export const REMOTE_REJECT_START_CHANGED = 'start-position-changed'
// Reject reason: shared prefix diverged.
export const REMOTE_REJECT_HISTORY_REWRITTEN = 'history-rewritten'
// Reject reason: more than one new ply (poll path).
export const REMOTE_REJECT_MULTIPLE_PLIES = 'multiple-plies-appended'
// Reject reason: new ply is not the opponent’s color.
export const REMOTE_REJECT_FORGED_SEAT = 'move-forged-for-local-seat'

function startSideToMove(pgn) {
  const fen = getPgnTag(pgn, 'FEN')
  if (fen && fen.trim().split(/\s+/)[1] === 'b') return 'b'
  return 'w'
}

function remotePlyColor(pgn, plyIndex) {
  const start = startSideToMove(pgn)
  const even = plyIndex % 2 === 0
  return even ? start : start === 'w' ? 'b' : 'w'
}

function rejectRemote(reason) {
  return { ok: false, newMoves: null, reason }
}

// # Remote Move Validation

// Validate a single-ply remote continuation for poll accept.
export function validateRemoteContinuation({
  localPgn = '',
  remotePgn = '',
  localSans,
  remoteSans,
  opponentColor,
} = {}) {
  const local = Array.isArray(localSans) ? localSans : []
  const remote = Array.isArray(remoteSans) ? remoteSans : []

  if (startingPositionFen(localPgn) !== startingPositionFen(remotePgn)) {
    return rejectRemote(REMOTE_REJECT_START_CHANGED)
  }
  if (remote.length <= local.length) return rejectRemote(REMOTE_REJECT_NO_NEW_MOVE)

  const newMoves = remoteMoveContinuation(local, remote)
  if (!newMoves) return rejectRemote(REMOTE_REJECT_HISTORY_REWRITTEN)
  if (newMoves.length !== 1) return rejectRemote(REMOTE_REJECT_MULTIPLE_PLIES)

  if (opponentColor === 'w' || opponentColor === 'b') {
    if (remotePlyColor(localPgn, local.length) !== opponentColor) {
      return rejectRemote(REMOTE_REJECT_FORGED_SEAT)
    }
  }
  return { ok: true, newMoves, reason: null }
}

// Validate a remote page before wiki-forking it in. Unlike single-ply continuation,
// a page fork may pull several new moves at once (the whole remote journal).
export function validateRemotePageFork({ localPgn = '', remotePgn = '', localSans, remoteSans, opponentColor } = {}) {
  const local = Array.isArray(localSans) ? localSans : []
  const remote = Array.isArray(remoteSans) ? remoteSans : []

  if (startingPositionFen(localPgn) !== startingPositionFen(remotePgn)) {
    return rejectRemote(REMOTE_REJECT_START_CHANGED)
  }
  if (remote.length <= local.length) return rejectRemote(REMOTE_REJECT_NO_NEW_MOVE)

  const newMoves = remoteMoveContinuation(local, remote)
  if (!newMoves) return rejectRemote(REMOTE_REJECT_HISTORY_REWRITTEN)

  if (opponentColor === 'w' || opponentColor === 'b') {
    if (remotePlyColor(localPgn, local.length) !== opponentColor) {
      return rejectRemote(REMOTE_REJECT_FORGED_SEAT)
    }
  }
  return { ok: true, newMoves, reason: null }
}

// Remote wiki posted a final Result while the local copy is still in progress.
export function validateRemoteGameCompletion({ localPgn = '', remotePgn = '', localSans, remoteSans } = {}) {
  const local = Array.isArray(localSans) ? localSans : []
  const remote = Array.isArray(remoteSans) ? remoteSans : []
  const localResult = String(getPgnTag(localPgn, 'Result') || '*').trim()
  const remoteResult = String(getPgnTag(remotePgn, 'Result') || '*').trim()

  if (isDecisiveResult(localResult)) return rejectRemote(REMOTE_REJECT_NO_NEW_MOVE)
  if (!isDecisiveResult(remoteResult)) return rejectRemote(REMOTE_REJECT_NO_NEW_MOVE)
  if (startingPositionFen(localPgn) !== startingPositionFen(remotePgn)) {
    return rejectRemote(REMOTE_REJECT_START_CHANGED)
  }
  if (remote.length < local.length) return rejectRemote(REMOTE_REJECT_HISTORY_REWRITTEN)
  for (let i = 0; i < local.length; i += 1) {
    if (local[i] !== remote[i]) return rejectRemote(REMOTE_REJECT_HISTORY_REWRITTEN)
  }
  return { ok: true, newMoves: remote.slice(local.length), reason: null }
}

// Classify how to prompt when the opponent's wiki shows a finished game first.
// promptKind: winner-resign | winner-finish | loser-sync | draw-sync
export function classifyRemoteGameEnd({ localPgn = '', remotePgn = '', localSeatColor = 'w' } = {}) {
  const localSans = validationPgnSanList(localPgn)
  const remoteSans = validationPgnSanList(remotePgn)
  if (!localSans || !remoteSans) return { ok: false, reason: 'unreadable pgn' }

  const validation = validateRemoteGameCompletion({
    localPgn,
    remotePgn,
    localSans,
    remoteSans,
  })
  if (!validation.ok) return { ok: false, reason: validation.reason }

  const outcome = gameResultFromPgn(remotePgn)
  if (!outcome.over) return { ok: false, reason: 'not terminal' }

  const score = seatScoreFromResult(outcome.result, localSeatColor)
  let promptKind = 'draw-sync'
  if (score === 1) {
    promptKind = outcome.method === 'resignation' ? 'winner-resign' : 'winner-finish'
  } else if (score === 0) {
    promptKind = 'loser-sync'
  }

  return {
    ok: true,
    promptKind,
    outcome,
    remoteResult: outcome.result,
    newMoves: validation.newMoves,
  }
}

function validationPgnSanList(pgn) {
  try {
    const moves = parsePgnParts(pgn).movetext
    const tokens = sanTokens(moves)
    return tokens.length ? tokens : null
  } catch {
    return null
  }
}

let realtimeCtx

// Bind the realtime module to the chess-app host context.
export function initRealtime(context) {
  realtimeCtx = context
}

let lastWatchedRemoteSite = null
let pendingRemoteText = null
let pendingRemoteEnd = null
let dismissedRemoteText = null
let dismissedRemoteEndText = null
let remoteAcceptPromptOpen = false
let remoteGameEndPromptOpen = false
// Blocks overlapping page-forks (two poll handlers can otherwise stamp duplicate forks).
let remotePageForkInFlight = false
let remoteRealtime = {}
let lastSentPresence = null

const DEFAULT_STUN_SERVERS = ['stun:stun.l.google.com:19302']
let realtimeConfig = { stunServers: DEFAULT_STUN_SERVERS }
let realtimeConfigPromise = null
let rtcPc = null
let rtcChannel = null
let rtcEpoch = 0
let rtcConnected = false
let realtimePromptOpen = false
let realtimeDeclined = false
let localRtcConsented = false
let endRealtimePromptOpen = false
let realtimeBadgeWired = false
let lastProcessedSignalKey = null
let rtcHandshakeTimer = null
let rtcCooldownUntil = 0
const RTC_HANDSHAKE_TIMEOUT_MS = 30000
const RTC_RETRY_COOLDOWN_MS = 60000

// True for correspondence human-vs-human (not same-device / demo lesson).
export function isRemoteHumanGame() {
  const pgn = realtimeCtx.chessState?.PGN || realtimeCtx.chessState?.chessState
  if (!pgn || isSameDeviceHumanPlay(realtimeCtx.chessState)) return false
  if (isDemoOrLessonGame(pgn)) return false
  return getHumanPlayMode(pgn) === HUMAN_PLAY_CORRESPONDENCE
}

function canAcceptRemoteMoves() {
  if (typeof realtimeCtx.canPersistPosition === 'function' && realtimeCtx.canPersistPosition()) {
    return true
  }
  return Boolean(realtimeCtx.chessState?.pageOnThisWiki)
}

function dismissRemoteAcceptPrompt() {
  if (!remoteAcceptPromptOpen) return
  remoteAcceptPromptOpen = false
  closeActiveModal()
}

// Opponent wiki host from seated PGN / challenge tags.
export function remoteOpponentSite() {
  if (!isRemoteHumanGame() || !canAcceptRemoteMoves()) return null
  const pgn = realtimeCtx.chessState?.PGN || realtimeCtx.chessState?.chessState
  const viewing = normalizeWikiSite(realtimeCtx.viewingSite())
  // Once both humans are seated, PGN seat tags are the source of truth.
  const fromPgn = opponentWikiSiteFromPgn(pgn, viewing)
  if (fromPgn) return fromPgn
  const invite = challengeOpponentWikiSite(pgn)
  if (invite && normalizeWikiSite(invite) !== viewing) return invite
  return null
}

// # Remote Watch and Poll

// Tell the shell which remote host to poll (or clear).
export function updateRemoteWatch() {
  if (!realtimeCtx.wikiFrame) return
  const host = remoteOpponentSite()
  if (host === lastWatchedRemoteSite) return
  lastWatchedRemoteSite = host
  shellMessenger()?.remoteWatch({ site: host || null })
}

function localSeatKey() {
  return realtimeCtx.localPlayerSeatColor() === 'b' ? 'Black' : 'White'
}

function opponentSeatKey() {
  return localSeatKey() === 'White' ? 'Black' : 'White'
}

function localRealtimeReady() {
  return isRemoteHumanGame() && canAcceptRemoteMoves() && realtimeCtx.gameSettings().autoAcceptOpponentWikiMoves
}

function localAutoAcceptRealtime() {
  return Boolean(localRealtimeReady() && realtimeCtx.gameSettings().autoAcceptRealtime)
}

// Restore in-memory consent from the saved item (or auto-accept preference) after refresh.
function syncLocalRtcFromSavedState() {
  if (!realtimeCtx.wikiFrame || !isRemoteHumanGame() || !canAcceptRemoteMoves()) {
    localRtcConsented = false
    return false
  }
  if (!localRealtimeReady()) {
    localRtcConsented = false
    return false
  }
  const seat = localSeatKey()
  const saved = normalizeRealtimeState(realtimeCtx.chessState?.realtime)
  if (localAutoAcceptRealtime()) {
    localRtcConsented = true
    return !isRealtimeSeatRtcConsented(saved, seat)
  }
  if (isRealtimeSeatRtcConsented(saved, seat)) {
    // Respect an in-session decline even if the item has not been amended yet.
    if (!realtimeDeclined) localRtcConsented = true
    return realtimeDeclined && !localRtcConsented
  }
  // Session consent from the prompt — keep it until persist round-trips.
  if (localRtcConsented) return !isRealtimeSeatRtcConsented(saved, seat)
  return false
}

function currentRealtimePresence() {
  if (!realtimeCtx.wikiFrame || !isRemoteHumanGame() || !canAcceptRemoteMoves()) return null
  return {
    seat: localSeatKey(),
    ready: Boolean(localRealtimeReady()),
    rtcConsent: localRtcConsented,
  }
}

// Publish local seat ready/consent presence to the shell.
export function sendRealtimePresence({ persist = false } = {}) {
  if (!realtimeCtx.wikiFrame) return
  const needsPersist = syncLocalRtcFromSavedState()
  const presence = currentRealtimePresence()
  const key = presence ? JSON.stringify(presence) : null
  const shouldPersist = persist || needsPersist
  if (key !== lastSentPresence) {
    lastSentPresence = key
    shellMessenger()?.realtimePresence({ presence, persist: shouldPersist })
  } else if (shouldPersist && presence) {
    shellMessenger()?.realtimePresence({ presence, persist: true })
  }
  if (!localRealtimeReady()) {
    realtimeDeclined = false
    localRtcConsented = false
    if (rtcPc) teardownRtc('real-time disabled')
  } else {
    maybeApplyAutoRealtimeConsent()
    maybeOfferRealtime()
    maybeStartRtcHandshake()
  }
  updateRealtimePresenceIndicator()
  updateRealtimeBoardBadge()
}

// Hydrate realtime presence/RTC from restored chessState.
export function initializeRealtimeFromState() {
  const needsPersist = syncLocalRtcFromSavedState()
  sendRealtimePresence({ persist: needsPersist })
}

// Popup/PWA takes over as the sole real-time host — clear any stale wiki signal,
// then pause briefly so the opponent's view can drop the old peer before we offer.
export function claimRealtimeHost() {
  if (!realtimeCtx.wikiFrame || realtimeCtx.followsPopup || !isRemoteHumanGame()) return
  teardownRtc('popup host handoff')
  lastProcessedSignalKey = null
  rtcEpoch += 1
  sendRealtimeSignal(null)
  const needsPersist = syncLocalRtcFromSavedState()
  sendRealtimePresence({ persist: needsPersist || localRtcConsented })
  window.setTimeout(() => {
    if (!isRealtimeHost()) return
    maybeApplyAutoRealtimeConsent()
    maybeOfferRealtime()
    maybeStartRtcHandshake()
  }, 400)
}

function opponentRealtimeReady() {
  return isRemoteHumanGame() && isRealtimeSeatReady(remoteRealtime, opponentSeatKey())
}

function bothPlayersRealtimeReady() {
  return Boolean(localRealtimeReady() && opponentRealtimeReady())
}

function opponentRtcConsented() {
  return isRemoteHumanGame() && isRealtimeSeatRtcConsented(remoteRealtime, opponentSeatKey())
}

let mirroredRtcConnected = false
let mirroredRtcConnecting = false

function isRealtimeHost() {
  return Boolean(realtimeCtx.wikiFrame && !realtimeCtx.followsPopup && isRemoteHumanGame() && canAcceptRemoteMoves())
}

function bothPlayersRtcConsented() {
  return Boolean(localRtcConsented && opponentRtcConsented())
}

function wireRealtimeBoardBadge() {
  if (realtimeBadgeWired) return
  const badge = document.getElementById('wikiChessRealtimeBadge')
  if (!badge) return
  realtimeBadgeWired = true
  badge.addEventListener('click', () => {
    if (badge.hidden || realtimeCtx.followsPopup) return
    promptEndRealtime()
  })
}

function realtimeBoardBadgeWrap() {
  return document.querySelector('.chess-console-board-wrap')
}

// Player labels are rebuilt with innerHTML; detach first so the badge node is not destroyed.
export function shelterRealtimeBoardBadge() {
  const badge = document.getElementById('wikiChessRealtimeBadge')
  const wrap = realtimeBoardBadgeWrap()
  if (!badge || !wrap || badge.parentElement === wrap) return
  wrap.appendChild(badge)
}

function mountRealtimeBoardBadge(badge, visible) {
  const wrap = realtimeBoardBadgeWrap()
  const bar = document.querySelector('.chess-console-board .player.bottom .wiki-chess-player-bar')
  const host = visible && bar ? bar : wrap
  if (!host || badge.parentElement === host) return
  host.appendChild(badge)
}

// Refresh the realtime connection badge on the board.
export function updateRealtimeBoardBadge() {
  wireRealtimeBoardBadge()
  const badge = document.getElementById('wikiChessRealtimeBadge')
  if (!badge) return
  const label = badge.querySelector('.wiki-chess-realtime-badge-label')
  const showConnected = realtimeCtx.followsPopup ? mirroredRtcConnected : rtcConnected
  const showConnecting = realtimeCtx.followsPopup ? mirroredRtcConnecting : Boolean(rtcPc) && !rtcConnected
  if (!isRemoteHumanGame() || !canAcceptRemoteMoves() || (!showConnected && !showConnecting)) {
    badge.hidden = true
    delete badge.dataset.state
    mountRealtimeBoardBadge(badge, false)
    broadcastRealtimeStatus()
    return
  }
  badge.hidden = false
  mountRealtimeBoardBadge(badge, true)
  if (showConnected) {
    badge.dataset.state = 'connected'
    if (label) label.textContent = 'Live'
    badge.title = realtimeCtx.followsPopup
      ? 'Real-time play is active in the popup window'
      : 'Real-time play is active — click to end'
  } else {
    badge.dataset.state = 'connecting'
    if (label) label.textContent = 'Connecting…'
    badge.title = realtimeCtx.followsPopup
      ? 'Connecting for real-time play in the popup window'
      : 'Connecting for real-time play — click to cancel'
  }
  broadcastRealtimeStatus()
}

// Refresh presence dots / consent UI for both seats.
export function updateRealtimePresenceIndicator() {
  const el = document.getElementById('wikiChessRealtimeStatus')
  if (!el) return
  if (!isRemoteHumanGame() || !canAcceptRemoteMoves()) {
    el.hidden = true
    return
  }
  const showConnected = realtimeCtx.followsPopup ? mirroredRtcConnected : rtcConnected
  const showConnecting = realtimeCtx.followsPopup ? mirroredRtcConnecting : Boolean(rtcPc) && !rtcConnected
  if (showConnected) {
    el.hidden = false
    el.textContent = realtimeCtx.followsPopup
      ? 'Real-time connected in the popup window'
      : 'Real-time connected — moves are live'
    el.dataset.state = 'connected'
  } else if (showConnecting) {
    el.hidden = false
    el.textContent = realtimeCtx.followsPopup
      ? 'Connecting for real-time play in the popup window…'
      : 'Connecting for real-time play…'
    el.dataset.state = 'connecting'
  } else if (realtimeCtx.followsPopup) {
    el.hidden = true
    delete el.dataset.state
  } else if (rtcEligible() && bothPlayersRtcConsented()) {
    el.hidden = false
    el.textContent = 'Both players accepted — starting real-time link…'
    el.dataset.state = 'both'
  } else if (localRtcConsented && bothPlayersRealtimeReady() && !opponentRtcConsented()) {
    el.hidden = false
    el.textContent = 'Waiting for opponent to accept real-time…'
    el.dataset.state = 'waiting'
  } else if (bothPlayersRealtimeReady()) {
    el.hidden = false
    el.textContent = 'Both players online — accept the prompt to go real-time'
    el.dataset.state = 'both'
  } else if (opponentRealtimeReady()) {
    el.hidden = false
    el.textContent = 'Opponent is online (auto-fork on)'
    el.dataset.state = 'opponent'
  } else {
    el.hidden = true
    delete el.dataset.state
  }
  updateRealtimeBoardBadge()
}

function rtcEligible() {
  return isRealtimeHost()
}

function broadcastRealtimeStatus() {
  if (!isRealtimeHost()) return
  shellMessenger()?.realtimeStatus({
    connected: rtcConnected,
    connecting: Boolean(rtcPc) && !rtcConnected,
  })
}

// Publish connected/connecting realtime status to the shell (and mirrors).
export function publishRealtimeStatus() {
  broadcastRealtimeStatus()
}

function requestMirroredRealtimeStatus() {
  if (!realtimeCtx.followsPopup || !realtimeCtx.wikiFrame) return
  shellMessenger()?.requestRealtimeStatus()
}

// Keep embed following popup (or not) for realtime mirrors.
export function syncFollowsPopup(followsPopup) {
  if (followsPopup) {
    teardownRtc('playing in popup window')
    mirroredRtcConnected = false
    mirroredRtcConnecting = false
    updateRealtimeBoardBadge()
    updateRealtimePresenceIndicator()
    requestMirroredRealtimeStatus()
    return
  }
  mirroredRtcConnected = false
  mirroredRtcConnecting = false
  initializeRealtimeFromState()
}

// Apply popup/embed-mirrored realtime status payload.
export function applyMirroredRealtimeStatus({ connected, connecting } = {}) {
  mirroredRtcConnected = Boolean(connected)
  mirroredRtcConnecting = Boolean(connecting)
  if (!realtimeCtx.followsPopup) return
  updateRealtimeBoardBadge()
  updateRealtimePresenceIndicator()
}

// Answer a shell request for current realtime status.
export function handleRealtimeStatusRequest() {
  publishRealtimeStatus()
}

function isRealtimeOfferer() {
  return localSeatKey() === REALTIME_OFFERER_SEAT
}

function ensureRealtimeConfig() {
  if (realtimeConfigPromise) return realtimeConfigPromise
  realtimeConfigPromise = fetch(`${location.origin}/plugin/chess/config`)
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => {
      if (cfg && Array.isArray(cfg.stunServers)) realtimeConfig.stunServers = cfg.stunServers
    })
    .catch(() => {
      // Endpoint missing/old server — keep the built-in public STUN default.
    })
  return realtimeConfigPromise
}

// # WebRTC Peer Channel

function newRtcPeerConnection() {
  const iceServers = (realtimeConfig.stunServers || []).map(urls => ({ urls }))
  const pc = new RTCPeerConnection({ iceServers })
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      teardownRtc(`connection ${pc.connectionState}`)
    }
  })
  return pc
}

function waitForIceGathering(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', check)
    setTimeout(finish, timeoutMs)
  })
}

function armHandshakeTimeout() {
  clearTimeout(rtcHandshakeTimer)
  rtcHandshakeTimer = setTimeout(() => {
    if (!rtcConnected) teardownRtc('handshake timed out')
  }, RTC_HANDSHAKE_TIMEOUT_MS)
}

function sendRealtimeSignal(signal) {
  shellMessenger()?.realtimeSignal({
    seat: localSeatKey(),
    signal: signal || null,
    handshaking: Boolean(signal),
  })
}

function wireRtcDataChannel(channel) {
  rtcChannel = channel
  channel.addEventListener('open', () => {
    rtcConnected = true
    clearTimeout(rtcHandshakeTimer)
    sendRealtimeSignal(null)
    updateRealtimePresenceIndicator()
    updateRealtimeBoardBadge()
    rtcSendLocalMove(currentLocalPgn())
  })
  channel.addEventListener('message', e => handleRtcMessage(e.data))
  channel.addEventListener('close', () => teardownRtc('channel closed'))
}

async function startRealtimeAsOfferer() {
  if (rtcPc || !rtcEligible() || !isRealtimeOfferer()) return
  await ensureRealtimeConfig()
  if (rtcPc) return
  try {
    rtcEpoch += 1
    const epoch = rtcEpoch
    const pc = newRtcPeerConnection()
    rtcPc = pc
    updateRealtimePresenceIndicator()
    wireRtcDataChannel(pc.createDataChannel('chess'))
    await pc.setLocalDescription(await pc.createOffer())
    await waitForIceGathering(pc)
    sendRealtimeSignal({ kind: 'offer', sdp: pc.localDescription.sdp, epoch })
    armHandshakeTimeout()
  } catch (err) {
    teardownRtc(`offer failed: ${err?.message || err}`)
  }
}

async function handleRealtimeOffer(offerSig) {
  if (!rtcEligible() || isRealtimeOfferer() || !localRtcConsented) return
  if (rtcPc) {
    if (rtcConnected && rtcEpoch === offerSig.epoch) return
    teardownRtc('accepting new real-time offer')
  }
  await ensureRealtimeConfig()
  if (rtcPc) return
  try {
    rtcEpoch = offerSig.epoch
    const pc = newRtcPeerConnection()
    rtcPc = pc
    updateRealtimePresenceIndicator()
    pc.addEventListener('datachannel', e => wireRtcDataChannel(e.channel))
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSig.sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await waitForIceGathering(pc)
    sendRealtimeSignal({ kind: 'answer', sdp: pc.localDescription.sdp, epoch: offerSig.epoch })
    armHandshakeTimeout()
  } catch (err) {
    teardownRtc(`answer failed: ${err?.message || err}`)
  }
}

async function handleRealtimeAnswer(answerSig) {
  if (!rtcPc || !isRealtimeOfferer()) return
  if (answerSig.epoch !== rtcEpoch) return
  if (rtcPc.signalingState !== 'have-local-offer') return
  try {
    await rtcPc.setRemoteDescription({ type: 'answer', sdp: answerSig.sdp })
  } catch (err) {
    teardownRtc(`set answer failed: ${err?.message || err}`)
  }
}

function processRemoteSignal(signalMap) {
  if (!rtcEligible()) return
  const sig = signalMap?.[opponentSeatKey()]
  if (!sig) {
    if (rtcPc || rtcConnected) teardownRtc('opponent cleared real-time signal')
    return
  }
  const key = `${sig.kind}:${sig.epoch}`
  if (key === lastProcessedSignalKey && rtcPc) return
  if (rtcPc && sig.kind === 'offer' && sig.epoch !== rtcEpoch) {
    teardownRtc('replacing stale real-time offer')
  }
  lastProcessedSignalKey = key
  if (sig.kind === 'offer') handleRealtimeOffer(sig)
  else if (sig.kind === 'answer') handleRealtimeAnswer(sig)
}

function handleRtcMessage(data) {
  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  if (msg?.type === 'move' && typeof msg.pgn === 'string') {
    if (gameSyncApplying()) return
    handleRemoteOpponentState(msg.pgn, undefined, undefined, {
      source: GAME_SYNC_SOURCE.REMOTE_WEBRTC,
    })
  }
}

// Push the local move over the WebRTC data channel when connected.
export function rtcSendLocalMove(text) {
  if (!rtcConnected || !rtcChannel || rtcChannel.readyState !== 'open' || !text) return
  try {
    rtcChannel.send(JSON.stringify({ type: 'move', pgn: text }))
  } catch {
    // Channel went away mid-send — the close/teardown handlers will recover.
  }
}

function teardownRtc(reason) {
  const wasActive = Boolean(rtcPc)
  clearTimeout(rtcHandshakeTimer)
  rtcHandshakeTimer = null
  try {
    rtcChannel?.close()
  } catch {
    // ignore
  }
  try {
    rtcPc?.close()
  } catch {
    // ignore
  }
  rtcChannel = null
  rtcPc = null
  rtcConnected = false
  lastProcessedSignalKey = null
  if (wasActive) {
    if (window.wiki?.debug) console.info('[wiki-chess] real-time link ended:', reason)
    rtcCooldownUntil = Date.now() + RTC_RETRY_COOLDOWN_MS
    sendRealtimeSignal(null)
    updateRealtimePresenceIndicator()
    updateRealtimeBoardBadge()
  }
}

function maybeStartRtcHandshake() {
  if (!rtcEligible() || rtcPc || rtcConnected) return
  if (!bothPlayersRtcConsented() || !isRealtimeOfferer()) return
  if (Date.now() < rtcCooldownUntil) return
  startRealtimeAsOfferer()
}

function maybeApplyAutoRealtimeConsent() {
  if (!rtcEligible() || !bothPlayersRealtimeReady() || !localAutoAcceptRealtime()) return false
  if (localRtcConsented) return true
  localRtcConsented = true
  sendRealtimePresence({ persist: true })
  return true
}

function maybeOfferRealtime() {
  if (!rtcEligible() || rtcPc || rtcConnected) return
  if (!bothPlayersRealtimeReady()) return
  if (maybeApplyAutoRealtimeConsent()) {
    maybeStartRtcHandshake()
    return
  }
  if (localRtcConsented || realtimeDeclined || realtimePromptOpen || Date.now() < rtcCooldownUntil) return
  realtimePromptOpen = true
  openBoardOverlayConfirmModal(openConfirmModal, {
    title: 'Play in real-time?',
    message: 'Both players have auto-fork on. Connect directly so moves appear instantly?',
    notes: [
      'Each player must accept before the live link starts. Moves still save to the page — this only skips the refresh wait.',
    ],
    checkboxLabel: 'Auto-accept real-time next time',
    confirmLabel: 'Go real-time',
    cancelLabel: 'Not now',
    confirmClass: 'btn-primary',
    onConfirm: ({ checkboxChecked: enableAutoRtc } = {}) => {
      realtimePromptOpen = false
      realtimeDeclined = false
      localRtcConsented = true
      if (enableAutoRtc && typeof realtimeCtx.updateGameSettings === 'function') {
        realtimeCtx.updateGameSettings({ autoAcceptRealtime: true })
      } else {
        sendRealtimePresence({ persist: true })
      }
      maybeStartRtcHandshake()
    },
    onCancel: () => {
      realtimePromptOpen = false
      realtimeDeclined = true
      localRtcConsented = false
      sendRealtimePresence({ persist: true })
    },
  })
}

function promptEndRealtime() {
  if (endRealtimePromptOpen || (!rtcConnected && !rtcPc)) return
  endRealtimePromptOpen = true
  openBoardOverlayConfirmModal(openEndRealtimeModal, {
    onConfirm: ({ keepAutoFork } = {}) => {
      endRealtimePromptOpen = false
      teardownRtc('ended by player')
      localRtcConsented = false
      realtimeDeclined = true
      sendRealtimePresence({ persist: true })
      if (keepAutoFork === false && typeof realtimeCtx.updateGameSettings === 'function') {
        realtimeCtx.updateGameSettings({
          autoAcceptOpponentWikiMoves: false,
          autoAcceptRealtime: false,
        })
      }
    },
    onCancel: () => {
      endRealtimePromptOpen = false
    },
  })
}

function pgnSanList(pgn) {
  if (!pgn || getFormat(pgn) !== 'PGN') return null
  try {
    const moves = new realtimeCtx.Pgn(pgn)?.history?.moves
    if (!Array.isArray(moves)) return []
    return moves.map(move => move.san).filter(Boolean)
  } catch {
    return null
  }
}

function currentLocalPgn() {
  if (realtimeCtx.chessConsole?.state?.chess) return realtimeCtx.exportChessText({ liveBoardText: true })
  return realtimeCtx.chessState?.PGN || realtimeCtx.chessState?.chessState || ''
}

function dismissRemoteGameEndPrompt() {
  if (!remoteGameEndPromptOpen) return
  remoteGameEndPromptOpen = false
  closeActiveModal()
}

function remoteGameEndPromptCopy(kind, remotePgn) {
  const outcome = gameResultFromPgn(remotePgn)
  const sentence = formatGameResultSentence({
    result: outcome.result,
    method: outcome.method,
    whiteName: getPgnTag(remotePgn, 'White'),
    blackName: getPgnTag(remotePgn, 'Black'),
  })
  const detail = sentence || 'The game has a final result on their wiki.'
  switch (kind) {
    case 'winner-resign':
      return {
        title: 'Opponent resigned',
        message: `${detail} Fork it onto your wiki to record your win on your ledger.`,
        notes: [
          'Your copy still shows the game as active until you fork their final PGN.',
          'Federated ratings need matching results on both wikis — this is your proof they resigned.',
        ],
        confirmLabel: 'Fork result',
      }
    case 'winner-finish':
      return {
        title: 'Game finished — record your win',
        message: `${detail} Fork the final position onto your site.`,
        notes: [
          'Without your copy, My Chess Games may still list this as active.',
          'Forking stamps 🏁 completion on your wiki journal and enables twin verification.',
        ],
        confirmLabel: 'Fork result',
      }
    case 'loser-sync':
      return {
        title: "Game over on opponent's wiki",
        message: `${detail} Sync the final position to close your copy.`,
        notes: [
          'This does not change the outcome — it aligns your ledger with theirs.',
          'Rated games stay unverified until both wikis carry the same terminal headers.',
        ],
        confirmLabel: 'Fork final position',
      }
    default:
      return {
        title: "Game drawn on opponent's wiki",
        message: `${detail} Fork the agreed result onto your site.`,
        notes: ['Both ledgers should carry the same draw result for ratings.'],
        confirmLabel: 'Fork result',
      }
  }
}

function promptRemoteGameEnd(gameEnd) {
  if (remoteGameEndPromptOpen) return
  const text = pendingRemoteEnd?.text
  if (!text) return
  remoteGameEndPromptOpen = true
  const copy = remoteGameEndPromptCopy(gameEnd.promptKind, text)
  openBoardOverlayConfirmModal(openConfirmModal, {
    title: copy.title,
    message: copy.message,
    notes: copy.notes,
    checkboxLabel: 'Auto-fork game endings. Skip this confirmation next time',
    confirmLabel: copy.confirmLabel,
    cancelLabel: 'Not yet',
    confirmClass: 'btn-primary',
    onConfirm: ({ checkboxChecked: enableAutoEnd } = {}) => {
      remoteGameEndPromptOpen = false
      if (enableAutoEnd && typeof realtimeCtx.updateGameSettings === 'function') {
        realtimeCtx.updateGameSettings({ autoAcceptOpponentWikiGameEnd: true })
        return
      }
      acceptRemoteGameEnd()
    },
    onCancel: () => {
      remoteGameEndPromptOpen = false
      dismissedRemoteEndText = text
      pendingRemoteEnd = null
    },
  })
}

function acceptRemoteGameEnd() {
  const text = pendingRemoteEnd?.text
  if (!text || remotePageForkInFlight) return
  // Claim the lock before clearing pending so a second handler cannot start another fork.
  remotePageForkInFlight = true
  pendingRemoteEnd = null
  dismissedRemoteEndText = null
  dismissRemoteGameEndPrompt()
  const forkSite = remoteOpponentSite()
  if (!forkSite) {
    remotePageForkInFlight = false
    return
  }
  // Page fork only — do not animate first (that autosaves and races the journal put).
  // expectText: wait until the opponent's wiki JSON matches (RTC can beat their autosave).
  shellMessenger()?.forkRemotePage({ site: forkSite, expectText: text })
  window.setTimeout(() => {
    remotePageForkInFlight = false
  }, 12000)
}

// Auto-accept a pending remote game-end when settings allow.
export function maybeAutoAcceptPendingRemoteGameEnd() {
  if (!pendingRemoteEnd || !realtimeCtx.gameSettings().autoAcceptOpponentWikiGameEnd) return
  dismissRemoteGameEndPrompt()
  acceptRemoteGameEnd()
}

// Process polled remote PGN (move accept / game-end prompts).
export function handleRemoteOpponentState(text, realtime, signal, { source = GAME_SYNC_SOURCE.REMOTE_POLL } = {}) {
  if (!isRemoteHumanGame() || !canAcceptRemoteMoves()) return
  if (gameSyncApplying() || remotePageForkInFlight) return
  if (realtime !== undefined) {
    remoteRealtime = realtime || {}
    updateRealtimePresenceIndicator()
    maybeOfferRealtime()
    maybeStartRtcHandshake()
  }
  if (signal !== undefined) processRemoteSignal(signal)
  if (!text) return
  if (realtimeCtx.followsPopup) return

  const localPgn = currentLocalPgn()
  const syncVerdict = shouldAcceptExternalGameUpdate({
    localPgn,
    incomingPgn: text,
    source,
  })
  if (!syncVerdict.accept) return

  const localSeatColor = realtimeCtx.localPlayerSeatColor()

  if (text !== dismissedRemoteEndText) {
    const gameEnd = classifyRemoteGameEnd({ localPgn, remotePgn: text, localSeatColor })
    if (gameEnd.ok) {
      pendingRemoteEnd = { text, ...gameEnd }
      if (realtimeCtx.gameSettings().autoAcceptOpponentWikiGameEnd) {
        dismissRemoteGameEndPrompt()
        acceptRemoteGameEnd()
        return
      }
      promptRemoteGameEnd(gameEnd)
      return
    }
  }

  if (text === dismissedRemoteText) return
  const localSans = pgnSanList(localPgn)
  const remoteSans = pgnSanList(text)
  if (!localSans || !remoteSans) return
  const opponentColor = localSeatColor === 'b' ? 'w' : 'b'
  // Page-fork accept allows one or more new plies (wiki fork pulls the whole page).
  const { ok, newMoves, reason } = validateRemotePageFork({
    localPgn,
    remotePgn: text,
    localSans,
    remoteSans,
    opponentColor,
  })
  if (!ok) {
    if (reason && reason !== REMOTE_REJECT_NO_NEW_MOVE) {
      console.warn(`chess: ignoring suspicious remote update (${reason})`)
      dismissedRemoteText = text
    }
    return
  }
  pendingRemoteText = text
  if (realtimeCtx.gameSettings().autoAcceptOpponentWikiMoves) {
    dismissRemoteAcceptPrompt()
    acceptRemoteMove()
    return
  }
  promptRemoteMove(newMoves)
}

// Auto-accept a pending remote move when settings allow.
export function maybeAutoAcceptPendingRemoteMove() {
  if (!pendingRemoteText || !realtimeCtx.gameSettings().autoAcceptOpponentWikiMoves) return
  dismissRemoteAcceptPrompt()
  acceptRemoteMove()
}

function promptRemoteMove(newMoves) {
  if (remoteAcceptPromptOpen) return
  const text = pendingRemoteText
  remoteAcceptPromptOpen = true
  openBoardOverlayConfirmModal(openConfirmModal, {
    title: 'Opponent moved',
    message: `Your opponent played ${newMoves.join(', ')}. Bring it into your game and continue?`,
    notes: ['This forks their latest move into this page so you can reply.'],
    checkboxLabel: 'Auto-fork opponent moves. Skip this confirmation next time',
    confirmLabel: 'Fork Move',
    cancelLabel: 'Not yet',
    confirmClass: 'btn-primary',
    onConfirm: ({ checkboxChecked: enableAutoFork } = {}) => {
      remoteAcceptPromptOpen = false
      if (enableAutoFork && typeof realtimeCtx.updateGameSettings === 'function') {
        realtimeCtx.updateGameSettings({ autoAcceptOpponentWikiMoves: true })
        return
      }
      acceptRemoteMove()
    },
    onCancel: () => {
      remoteAcceptPromptOpen = false
      dismissedRemoteText = text
      pendingRemoteText = null
    },
  })
}

function acceptRemoteMove() {
  const text = pendingRemoteText
  if (!text || remotePageForkInFlight) return
  // Claim the lock before clearing pending so overlapping poll/RTC handlers cannot
  // both capture the same text and stamp duplicate page forks.
  remotePageForkInFlight = true
  pendingRemoteText = null
  dismissedRemoteText = null
  dismissRemoteAcceptPrompt()
  const forkSite = remoteOpponentSite()
  if (!forkSite) {
    remotePageForkInFlight = false
    return
  }
  // Journal source of truth is the wiki page fork (no pre-animate autosave race).
  // Pass expectText so the shell retries GET until the opponent's wiki has this PGN
  // (real-time can deliver the move before their journal put finishes).
  shellMessenger()?.forkRemotePage({ site: forkSite, expectText: text })
  window.setTimeout(() => {
    remotePageForkInFlight = false
  }, 12000)
}

// # Shell SET STATE Sync

let shellSyncHost = null

// Host supplies chess console, session, and init hooks for applySyncedPosition.
export function initShellSync(host) {
  shellSyncHost = host
}

// Apply an inbound shell SET_STATE to the live board (gated).
export function applySyncedPosition(incoming) {
  const host = shellSyncHost
  if (!host) return

  const chessState = () => host.getChessState()
  const keepActive = () =>
    shouldKeepActiveShellSync(incoming, chessState(), {
      activePage: host.isActivePage,
      hasChessConsole: typeof host.getChessConsole?.() !== 'undefined',
      keepActivePuzzleSession: host.shouldKeepActivePuzzleSession,
    })

  if (keepActive()) {
    host.replaceChessState(host.mergePuzzleShellContext(chessState(), incoming))
    return
  }
  if (incoming?.patchStateOnly && isStaleGhostChooseShellSync(incoming, chessState())) {
    return
  }
  if (host.shouldDeferNewGameSetup?.() && !incoming?.followsPopup) return
  if (host.shouldDeferStockfishSetup?.() && !incoming?.followsPopup) return

  const localPgn = chessState()?.PGN || chessState()?.chessState || ''
  const incomingPgn = incoming?.PGN || incoming?.chessState || ''
  const sameItemText = String(incomingPgn).trim() === String(localPgn).trim()
  const syncVerdict = shouldAcceptExternalGameUpdate({
    localPgn,
    incomingPgn,
    source: GAME_SYNC_SOURCE.SHELL_SET_STATE,
    sameItemText,
  })
  if (!syncVerdict.accept) return

  beginGameSyncApply()
  host.beginSync?.()
  // Successful page-fork SET_STATE — allow the next opponent ply immediately.
  remotePageForkInFlight = false

  try {
    if (shouldReinitChessViewFromSync(incoming)) {
      host.setSessionFollowsPopup(Boolean(incoming.followsPopup))
      host.initializeChess(incoming)
      if (incomingPgn) bumpGameSyncEpoch(incomingPgn)
      return
    }

    host.setSessionFollowsPopup(Boolean(incoming.followsPopup))
    const preservedPlayerColor = chessState()?.playerColor
    const preservedEngineLevel = chessState()?.engineLevel
    const preservedGameSettings = chessState()?.gameSettings
    let synced = incoming
    const chessConsole = host.getChessConsole?.()
    if (chessConsole?.state?.chess && synced && typeof synced === 'object') {
      synced = { ...synced }
      delete synced.bareKeywordGuard
    }
    host.replaceChessState(synced)
    const remoteHuman =
      getHumanPlayMode(chessState()?.PGN || chessState()?.chessState || '') === HUMAN_PLAY_CORRESPONDENCE
    if (remoteHuman) {
      delete chessState().playerColor
    } else if (!chessState().playerColor && preservedPlayerColor) {
      chessState().playerColor = preservedPlayerColor
    }
    if (chessState().engineLevel == null && preservedEngineLevel != null) {
      chessState().engineLevel = preservedEngineLevel
    }
    if (!chessState().gameSettings && preservedGameSettings) {
      chessState().gameSettings = preservedGameSettings
    }
    chessState().gameSettings = mergeGameSettings(chessState().gameSettings, host.loadLocalSettingPrefs?.() || {})

    if (typeof chessConsole === 'undefined') {
      host.initializeChess(incoming)
      if (incomingPgn) bumpGameSyncEpoch(incomingPgn)
      return
    }

    {
      const livePgn = chessState().PGN || chessState().chessState
      chessState().PGN = prepareWikiPgn(
        mergePgnWithSavedHeaders(livePgn, chessState().wikiItemText || livePgn),
        chessState(),
      )
    }
    const board = chessConsole.components.board
    // Same PGN as the live board (own journal echo / shell re-push): never initGame or
    // setPosition(false) — that aborts Stockfish and cancels in-flight piece animations.
    if (sameItemText) {
      if (host.sessionFollowsPopup?.()) {
        board?.chessboard?.disableMoveInput()
      }
      board?.markLastMove()
      board?.markPlayerToMove()
      host.enhancePlayerLabels?.(chessConsole)
      if (incomingPgn) bumpGameSyncEpoch(incomingPgn)
      return
    }
    if (!host.shouldDeferStockfishSetup?.()) {
      const pgn = chessState().PGN || chessState().chessState
      const nextSeat = host.localPlayerSeatColor?.()
      const nextSeatKey = host.wikiInteractiveSeatKey?.(pgn)
      const prevSeatKey = chessConsole._wikiInteractiveSeatKey
      const seatInteractivityChanged = remoteHuman && prevSeatKey != null && prevSeatKey !== nextSeatKey
      if (
        remoteHuman &&
        chessConsole._wikiLocalSeat &&
        (chessConsole._wikiLocalSeat !== nextSeat || seatInteractivityChanged)
      ) {
        const reinit = { ...chessState() }
        host.resetChessApp?.()
        host.initializeChess(reinit)
        if (pgn) bumpGameSyncEpoch(pgn)
        return
      }
      // When Stockfish has the opening move, initGame already calls nextMove — do not
      // call it again below (that used to start a second calculateMove).
      const engineOpens = Boolean(host.shouldRequestEngineMoveAfterInit?.(pgn))
      chessConsole.initGame(host.gameInitProps?.(), engineOpens)
      chessConsole._wikiLocalSeat = nextSeat
      chessConsole._wikiInteractiveSeatKey = nextSeatKey
      chessConsole._wikiSkipNextMoveAfterInit = engineOpens
    }

    if (host.sessionFollowsPopup?.()) {
      board?.chessboard?.disableMoveInput()
    } else if (!host.shouldDeferStockfishSetup?.()) {
      // initGame aborts in-flight Stockfish via StockfishPlayer; then request the seat
      // to move unless initGame already did (engine opens). Without abort, a journal
      // echo of our own ply started a second calculateMove and could hang THINKING.
      if (!chessConsole._wikiSkipNextMoveAfterInit) chessConsole.nextMove()
      chessConsole._wikiSkipNextMoveAfterInit = false
    }
    // Animate single-ply advances; Board.isBulkChessboardChange still snaps full loads.
    // Passing false here used to cancel the engine's slide when a shell echo arrived.
    board?.setPositionOfPlyViewed(true)
    board?.markLastMove()
    board?.markPlayerToMove()
    host.enhancePlayerLabels?.(chessConsole)
    if (incomingPgn) bumpGameSyncEpoch(incomingPgn)
  } catch (e) {
    console.error('Error applying synced position:', e)
  } finally {
    endGameSyncApply()
    host.endSync?.()
    // Keep checkboxes honest after patchStateOnly page-forks (prefs may have re-merged).
    host.syncGameSettingsUI?.()
    host.notifyWikiHeight?.()
  }
}
