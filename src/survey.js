/**
 * SURVEY client UI — Glicko-2 ratings, My Chess Games / site survey, open-challenge lobby.
 *
 * §1 IndexedDB rating store
 * §2 In-game rating discovery & finalize
 * §3 Shared #leaderboard browse shell (request/response, caches, site-survey views)
 * §4 Open challenges lobby
 *
 * Federated-only UI (gate, hop dials, ranking table) lives in leaderboard.js and registers
 * via registerLeaderboardUi — imports stay one-way (leaderboard.js → survey.js).
 *
 * Shell-only neighborhood fetches are triggered via wiki.buildLeaderboard / wiki.fetchUi; this module
 * manages federated rating state in IndexedDB and orchestrates the shared browse shell.
 *
 * In-file landmarks use `// # Section Name` for navigation.
 */

import {
  parseSurveyRecord,
  DEFAULT_CATEGORY,
  DEFAULT_SORT,
  columnPreferredSortDir,
  DEFAULT_SURVEY_ID,
  LEADERBOARD_PAGE_SLUG,
  LEADERBOARD_PAGE_TITLE,
  isLeaderboardPageSlug,
  pageSlug,
  partitionOpenChallenges,
  formatChallengeRange,
  buildOpenChallenge,
  stampOpenChallengePgn,
  openChallengeDisplayTitle,
  formatGameRowMetaLine,
  isOpenChallenge,
  challengeJoinGate,
  CHALLENGE_COLOR_BLACK,
  CHALLENGE_REJECT_OWNERS_ONLY,
  CHALLENGE_REJECT_WRONG_SITE,
  sitesMatch,
  rateGame,
  rateEngineGame,
  resultToScore,
  buildGlickoTags,
  newRatingState,
  normalizeRatingState,
  formatRatingLabel,
  isProvisional,
  stateFromGamePgn,
  isRatedTagValue,
  WHITE_WIN,
  BLACK_WIN,
  DRAW,
  stampCompletionTags,
  cleanSite,
  RATING_INDEXED_DB_NAME,
  RATING_INDEXED_DB_STORE,
  FAST_SYNC_INTERVAL_MS,
  computeStateHash,
  filterFederatedLeaderboardEntries,
  filterOpenChallengesByBlockList,
  mergeOpenChallengeEntries,
  mergeMyGamesLists,
  buildAcceptedGhostGamesList,
  buildLeaderboardFromPlayers,
  coerceBlockListMeta,
  harvestGhostOpenChallenge,
  openChallengeUsesJoinGhost,
  mergeFederationSitesCache,
  normalizeFederationSitesCache,
  refreshFederationSitesFromIndex,
  fetchFarmPeerSites,
  normalizeNeighborhoodGraphOpts,
  shouldShowIslandNotice,
  normalizeSiteCrawlCache,
  pruneSiteCrawlCache,
  formatCrawlEtaLabel,
  buildCrawlHits,
  crawlHitSiteReferences,
  crawlHitGameReferences,
} from './federation.js'
import {
  getPgnTag,
  getFormat,
  formatPgn,
  setPgnTag,
  parsePlayerId,
  parseStockfishLevel,
  stockfishLevelElo,
  isOpenSeatTag,
  isSameDeviceHumanPlay,
  getHumanPlayMode,
  HUMAN_PLAY_CORRESPONDENCE,
  playerDisplayLabel,
  formatPlayerDisplayLabel,
  wikiSiteLinkLabel,
  normalizeWikiSite,
  gameStartInstant,
  formatLocalISO8601,
} from './chess-core.js'
import {
  openChallengeEditModal,
  openAlertModal,
  closeActiveModal,
  clearViewportBlockingModals,
  setAuthGatedButton,
  installAuthGatedClickGuard,
} from './modals.js'
import { ensureMountContentVisible, openWithEmbeddedMount, shellMessengerFromContext } from './board-layout.js'

let ctx

function shellMessenger() {
  return shellMessengerFromContext(ctx)
}

export function initSurveyUi(context) {
  ctx = context
  void initRatingIndexedDb().then(() => {
    warmFederationSitesCacheInBackground()
  })
  startFederationSyncLoop()
}

// Seat-row kings reference inlined `#wk`/`#bk` (see seatKingPreviewHtml). Those symbols
// only exist after ensurePieceSpriteCached — normally a board load. My Chess Games never
// mounts a board, so prefetch here and repaint once if the first paint raced the fetch.
let seatKingSpritesEnsuring = null

function pieceSpritesReady() {
  return Boolean(document.querySelector('#cm-chessboard-sprite svg'))
}

function ensureSeatKingSpritesThenRefresh() {
  if (pieceSpritesReady() || typeof ctx?.ensurePieceSprites !== 'function') return
  if (seatKingSpritesEnsuring) return
  seatKingSpritesEnsuring = Promise.resolve(ctx.ensurePieceSprites())
    .catch(() => {})
    .finally(() => {
      seatKingSpritesEnsuring = null
      if (pieceSpritesReady() && isLeaderboardPageVisible()) renderLeaderboard()
    })
}

let federationSyncTimer = null
let deepAuditUnloadBound = false

function deepAuditUnloadHandler(event) {
  // Warn for deep audits and any in-flight Visible-federation crawl — closing cancels it.
  if (!lbLoading) return
  const surveyCrawl =
    viewKind === 'federatedLeaderboard' && (lbDeepRefresh || mode === 'survey' || !!lbProgress?.hopGraph)
  if (!surveyCrawl && !lbDeepRefresh) return
  event.preventDefault()
  event.returnValue = ''
  return ''
}

function bindDeepAuditUnload(active) {
  if (typeof window === 'undefined') return
  if (active && !deepAuditUnloadBound) {
    window.addEventListener('beforeunload', deepAuditUnloadHandler)
    deepAuditUnloadBound = true
  } else if (!active && deepAuditUnloadBound) {
    window.removeEventListener('beforeunload', deepAuditUnloadHandler)
    deepAuditUnloadBound = false
  }
}

function surveyBackgroundSyncDue() {
  const last = Number(indexedDbMemory.meta?.lastGlobalSyncAt)
  if (!Number.isFinite(last) || last <= 0) return !lbBoardCache.survey
  return Date.now() - last >= FAST_SYNC_INTERVAL_MS
}

function siteSurveyRefreshDue() {
  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  if (!host) return true
  try {
    const raw = sessionStorage.getItem(siteSurveyCacheStorageKey(host))
    if (!raw) return true
    const { at } = JSON.parse(raw)
    return Date.now() - Number(at) > SITE_SURVEY_CACHE_TTL_MS
  } catch {
    return true
  }
}

// # Federation Sync Loop

function tickFederationBackgroundSync() {
  if (typeof document !== 'undefined' && document.hidden) return
  // Keep the federation host cache warm even when the lobby is not open.
  warmFederationSitesCacheInBackground()
  if (!isLeaderboardPageVisible()) return
  // My Chess Games (site view): refresh the local site crawl only — never the federated survey graph.
  if (viewKind === 'siteSurvey') {
    if (siteProbeKind !== 'all' || !siteSurveyRefreshDue()) return
    requestBoard({ force: true, deepRecompute: false, background: true, syncSurvey: false })
    return
  }
  // Federated leaderboard board: soft checkpoint sync when stale; deep audit is user-initiated only.
  // Background federation sync runs only while the user is on the full survey reach.
  // Skip while a hop-bounded crawl is already in flight — it would abort the crawl and
  // leave the spinner on the start message.
  if (viewKind !== 'federatedLeaderboard') return
  if (mode !== 'survey') return
  if (lbLoading) return
  if (!surveyBackgroundSyncDue()) return
  requestBoard({
    force: !lbBoardCache.survey,
    deepRecompute: false,
    background: true,
    syncSurvey: true,
  })
}

function startFederationSyncLoop() {
  if (typeof window === 'undefined' || federationSyncTimer != null) return
  federationSyncTimer = window.setInterval(tickFederationBackgroundSync, FAST_SYNC_INTERVAL_MS)
}

// # IndexedDB Rating Store

const STORE_PREFIX = 'wiki-chess-rating:'

const indexedDbMemory = {
  players: {},
  meta: {},
  ready: null,
}

function indexedDbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openRatingIndexedDb() {
  if (indexedDbMemory.ready) return indexedDbMemory.ready
  indexedDbMemory.ready = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const req = indexedDB.open(RATING_INDEXED_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('players')) db.createObjectStore('players')
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains(RATING_INDEXED_DB_STORE)) db.createObjectStore(RATING_INDEXED_DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return indexedDbMemory.ready
}

async function initRatingIndexedDb() {
  const db = await openRatingIndexedDb()
  if (!db) return
  const tx = db.transaction(['players', 'meta', RATING_INDEXED_DB_STORE], 'readonly')
  const players = await new Promise((resolve, reject) => {
    const req = tx.objectStore('players').get('all')
    req.onsuccess = () => resolve(req.result || {})
    req.onerror = () => reject(req.error)
  })
  const meta = await new Promise((resolve, reject) => {
    const req = tx.objectStore('meta').get('checkpoint')
    req.onsuccess = () => resolve(req.result || {})
    req.onerror = () => reject(req.error)
  })
  indexedDbMemory.players = players && typeof players === 'object' ? players : {}
  indexedDbMemory.meta = meta && typeof meta === 'object' ? meta : {}
  await indexedDbTxDone(tx)
}

async function persistRatingPlayers() {
  const db = await openRatingIndexedDb()
  if (!db) return
  const tx = db.transaction(['players', 'meta'], 'readwrite')
  tx.objectStore('players').put(indexedDbMemory.players, 'all')
  tx.objectStore('meta').put(indexedDbMemory.meta, 'checkpoint')
  await indexedDbTxDone(tx)
}

function federationIndexedDbPayload() {
  return {
    blockList: indexedDbMemory.meta?.blockList || null,
    deletionMetrics: indexedDbMemory.meta?.deletionMetrics || null,
    island: indexedDbMemory.meta?.island || null,
    knownFederationSites: indexedDbMemory.meta?.federationSites || null,
    knownOpponents: Array.isArray(indexedDbMemory.meta?.pastOpponents) ? indexedDbMemory.meta.pastOpponents : [],
    siteCrawlCache: normalizeSiteCrawlCache(indexedDbMemory.meta?.siteCrawlCache),
  }
}

let siteCrawlCachePersistTimer = null
function rememberSiteCrawlCache(cache) {
  const next = pruneSiteCrawlCache({
    ...normalizeSiteCrawlCache(indexedDbMemory.meta?.siteCrawlCache),
    ...normalizeSiteCrawlCache(cache),
  })
  indexedDbMemory.meta.siteCrawlCache = next
  if (typeof window === 'undefined') {
    void persistRatingPlayers()
    return
  }
  if (siteCrawlCachePersistTimer) clearTimeout(siteCrawlCachePersistTimer)
  siteCrawlCachePersistTimer = window.setTimeout(() => {
    siteCrawlCachePersistTimer = null
    void persistRatingPlayers()
  }, 400)
}

export function readNeighborhoodHopGraph() {
  return normalizeNeighborhoodGraphOpts(indexedDbMemory.meta?.neighborhoodGraph || {})
}

export function persistNeighborhoodHopGraph(raw) {
  const next = normalizeNeighborhoodGraphOpts(raw)
  indexedDbMemory.meta.neighborhoodGraph = next
  void persistRatingPlayers()
  return next
}

// Remember hosts that answered a SURVEY-page challenge probe (skips global index next time).
let federationSitesPersistTimer = null
function rememberFederationSites(hosts) {
  const list = Array.isArray(hosts) ? hosts : []
  if (!list.length) return
  indexedDbMemory.meta.federationSites = mergeFederationSitesCache(indexedDbMemory.meta.federationSites, list)
  // Debounce IDB writes so progressive batches never stall the UI on disk I/O.
  if (typeof window === 'undefined') {
    void persistRatingPlayers()
    return
  }
  if (federationSitesPersistTimer) clearTimeout(federationSitesPersistTimer)
  federationSitesPersistTimer = window.setTimeout(() => {
    federationSitesPersistTimer = null
    void persistRatingPlayers()
  }, 750)
}

// Soft-refresh the global chess-plugin index into IndexedDB without touching the lobby UI.
let federationSitesWarmInFlight = false
function warmFederationSitesCacheInBackground() {
  if (federationSitesWarmInFlight) return
  const cached = normalizeFederationSitesCache(indexedDbMemory.meta?.federationSites)
  if (cached.fresh) return
  federationSitesWarmInFlight = true
  void refreshFederationSitesFromIndex(cached)
    .then(refreshed => {
      if (refreshed?.hosts?.length) rememberFederationSites(refreshed.hosts)
    })
    .catch(() => {
      /* index is best-effort */
    })
    .finally(() => {
      federationSitesWarmInFlight = false
    })
}

async function persistOwnRecord(host, record) {
  const h = normalizeSite(host)
  if (!h || !record) return
  const db = await openRatingIndexedDb()
  if (!db) return
  const tx = db.transaction(RATING_INDEXED_DB_STORE, 'readwrite')
  tx.objectStore(RATING_INDEXED_DB_STORE).put(record, ratingKey(h))
  await indexedDbTxDone(tx)
  void persistRatingPlayers()
}

function ratingKey(host) {
  return `${STORE_PREFIX}${normalizeWikiSite(host)}`
}

function normalizeSite(host) {
  return normalizeWikiSite(host)
}

const indexedDbLocalRecords = new Map()

function readRecord(_storage, host) {
  const h = normalizeSite(host)
  if (indexedDbLocalRecords.has(h)) return indexedDbLocalRecords.get(h)
  const state = indexedDbMemory.players[h]
  if (!state) return null
  const record = { ...normalizeRatingState(state), opponents: indexedDbMemory.meta?.opponents?.[h] || [] }
  const engine = indexedDbMemory.players[`${h}:engine`]
  if (engine) record.engine = normalizeRatingState(engine)
  indexedDbLocalRecords.set(h, record)
  return record
}

function writeRecord(_storage, host, state, opponents, engine = undefined) {
  const h = normalizeSite(host)
  const keep = engine !== undefined ? engine : readRecord(null, h)?.engine
  const record = { ...state, opponents: Array.isArray(opponents) ? opponents : [] }
  if (keep) record.engine = normalizeRatingState(keep)
  indexedDbLocalRecords.set(h, record)
  indexedDbMemory.players[h] = normalizeRatingState(state)
  if (keep) indexedDbMemory.players[`${h}:engine`] = normalizeRatingState(keep)
  indexedDbMemory.meta.opponents ||= {}
  indexedDbMemory.meta.opponents[h] = record.opponents
  void persistOwnRecord(h, record)
  return record
}

function cleanOpponents(raw, selfSite) {
  if (!Array.isArray(raw)) return []
  const self = normalizeSite(selfSite)
  const seen = new Set()
  const out = []
  for (const entry of raw) {
    const h = normalizeSite(entry)
    if (!h || h === self || seen.has(h)) continue
    seen.add(h)
    out.push(h)
  }
  return out
}

function loadOwnState(storage, host) {
  const record = readRecord(storage, host)
  if (!record) return null
  return normalizeRatingState(record)
}

function saveOwnState(storage, host, state) {
  const normalized = normalizeRatingState(state)
  const existing = readRecord(storage, host)
  const opponents = cleanOpponents(existing?.opponents, host)
  writeRecord(storage, host, normalized, opponents)
  return normalized
}

function loadOrSeed(storage, host) {
  const existing = loadOwnState(storage, host)
  if (existing) return existing
  return saveOwnState(storage, host, newRatingState())
}

function recordOpponent(storage, host, opponentSite) {
  const record = readRecord(storage, host)
  const state = normalizeRatingState(record)
  const opponents = cleanOpponents(record?.opponents, host)
  const candidate = normalizeSite(opponentSite)
  const self = normalizeSite(host)
  if (candidate && candidate !== self && !opponents.includes(candidate)) {
    opponents.push(candidate)
  }
  writeRecord(storage, host, state, opponents)
  return opponents
}

function loadEngineState(storage, host) {
  const record = readRecord(storage, host)
  if (!record || !record.engine) return null
  return normalizeRatingState(record.engine)
}

function saveEngineState(storage, host, engineState) {
  const existing = readRecord(storage, host)
  const state = normalizeRatingState(existing)
  const opponents = cleanOpponents(existing?.opponents, host)
  const engine = normalizeRatingState(engineState)
  writeRecord(storage, host, state, opponents, engine)
  return engine
}

// Last discovered state per seat plus the shell's per-seat audit verdict, shown in
// the player bars and used as the opponent's prior when rating a finished game. The
// per-seat `vsStockfish` flag marks a bar that is showing the player's personal
// vs-Stockfish reference rating (an engine game) rather than a federated rating.
const emptyDiscovered = () => ({
  white: null,
  black: null,
  verified: { white: false, black: false },
  vsStockfish: { white: false, black: false },
})
let discovered = emptyDiscovered()
// De-dupe the discovery crawl: only re-ask when the matchup/item actually changes.
let lastDiscoverKey = null
// When autosave is off (the page isn't ours), the rating-stamped final PGN waits here
// for the player to press Finalize.
let pendingFinalizeText = null
// Deferred recovery of published Glicko state when local store is empty: we write a
// neutral 1500 prior immediately so play is never gated, then adopt published history
// (if any) once discovery replies. Null when nothing is pending.
let pendingRecoverySite = null

export function ownRatingValue(host) {
  const store = storage()
  if (!store || !host) return null
  const state = loadOwnState(store, host)
  return state && Number.isFinite(state.rating) ? Math.round(state.rating) : null
}

export function ownGamesPlayed(host) {
  const store = storage()
  if (!store || !host) return 0
  const state = loadOwnState(store, host)
  return state && Number.isFinite(state.gamesPlayed) ? state.gamesPlayed : 0
}

export function isCurrentGameRated() {
  return Boolean(eligibleGame())
}

export function isCurrentEngineGame() {
  return Boolean(localEngineSeat())
}

export function isCurrentRatedEngineGame() {
  return isCurrentEngineGame() && !isUnratedGame()
}

export function currentGameFormatInfo() {
  const state = ctx?.chessState
  const pgn = currentPgn()
  if (!state || !pgn || state.showStartMenu) return null
  if (
    state.gameType === 'puzzle' ||
    state.gameType === 'position' ||
    state.format === 'FEN' ||
    state.mode === 'POSITION' ||
    state.mode === 'PUZZLE'
  ) {
    return null
  }
  if (getFormat(pgn) !== 'PGN') return null

  if (isSameDeviceHumanPlay(state)) {
    return {
      rated: false,
      label: 'Casual',
      detail: 'same-device games are never rated',
    }
  }

  const unrated =
    isUnratedGame(pgn) ||
    (state.challenge && typeof state.challenge === 'object' && state.challenge.config?.rated === false)

  const whiteTag = getPgnTag(pgn, 'White')
  const blackTag = getPgnTag(pgn, 'Black')
  const isEngine = parseStockfishLevel(whiteTag) != null || parseStockfishLevel(blackTag) != null

  if (unrated) {
    return {
      rated: false,
      label: 'Casual',
      detail: isEngine ? 'no rating will change' : 'not counted toward federated Glicko-2 ratings or leaderboards',
    }
  }

  if (isEngine) {
    return {
      rated: true,
      label: 'Rated',
      detail: 'updates your personal vs-Stockfish reference rating (not leaderboards)',
    }
  }

  if (getHumanPlayMode(pgn) === HUMAN_PLAY_CORRESPONDENCE) {
    return {
      rated: true,
      label: 'Rated',
      detail: 'counts toward federated Glicko-2 ratings and leaderboards',
    }
  }

  return { rated: true, label: 'Rated', detail: 'counts toward ratings' }
}

// # Rating Helpers

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function currentPgn() {
  return ctx?.chessState?.PGN || ctx?.chessState?.chessState || ''
}

// A game the player explicitly started as casual from the new-game modal carries a
// falsy `[Rated]` tag. Only an explicit "yes" opts the game into rating effects.
function isUnratedGame(pgn = currentPgn()) {
  const tag = getPgnTag(pgn, 'Rated')
  if (tag == null || String(tag).trim() === '') return true
  return !isRatedTagValue(tag)
}

// A game is RATED when it's a cross-wiki, human-vs-human game on an embedded wiki page
// where both seats are real wiki players (not an engine, not an open/empty seat, not
// pass-and-play on one device). Returns the two seat hosts + tags, or null.
function eligibleGame(pgn = currentPgn()) {
  const state = ctx?.chessState
  if (!ctx?.wikiFrame || ctx?.followsPopup || !state || !pgn) return null
  if (
    state.gameType === 'puzzle' ||
    state.gameType === 'position' ||
    state.format === 'FEN' ||
    state.mode === 'POSITION' ||
    state.mode === 'PUZZLE'
  ) {
    return null
  }
  if (isSameDeviceHumanPlay(state)) return null
  if (getHumanPlayMode(pgn) !== HUMAN_PLAY_CORRESPONDENCE) return null
  // A game started as casual from the new-game modal ([Rated "no"]) never affects Glicko-2,
  // even though it is otherwise an eligible cross-wiki human game.
  if (isUnratedGame(pgn)) return null
  // An open challenge explicitly created as "Unrated" never affects Glicko-2, even
  // though it is otherwise an eligible cross-wiki human game.
  if (state.challenge && typeof state.challenge === 'object' && state.challenge.config?.rated === false) {
    return null
  }

  const whiteTag = getPgnTag(pgn, 'White')
  const blackTag = getPgnTag(pgn, 'Black')
  if (!whiteTag || !blackTag || isOpenSeatTag(whiteTag) || isOpenSeatTag(blackTag)) return null

  const white = parsePlayerId(whiteTag)
  const black = parsePlayerId(blackTag)
  if (!white || !black || white.isEngine || black.isEngine) return null

  const whiteSite = String(white.domain || '')
    .trim()
    .toLowerCase()
  const blackSite = String(black.domain || '')
    .trim()
    .toLowerCase()
  if (!whiteSite || !blackSite) return null

  return { whiteSite, blackSite, whiteTag, blackTag }
}

function viewingSite() {
  const host = ctx?.viewingSite?.() || ctx?.pgnStampSite?.() || ctx?.chessState?.wikiSite || ''
  return normalizeSite(host)
}

// The host key under which the LOCAL player's own state is stored. Prefer the wiki
// being viewed (iframe location / PWA host) when it matches a seat — that is stable
// on first paint before PGN-driven seat resolution is ready. Fall back to the local
// seat color when the viewer is a guest or neither seat is on this host.
function viewerRatingSiteKey(elig) {
  const viewing = viewingSite()
  if (viewing) {
    if (sitesMatch(elig.whiteSite, viewing)) return normalizeSite(elig.whiteSite)
    if (sitesMatch(elig.blackSite, viewing)) return normalizeSite(elig.blackSite)
  }
  const localSeat = ctx.localPlayerSeatColor()
  const tag = localSeat === 'w' ? elig.whiteTag : elig.blackTag
  return normalizeSite(parsePlayerId(tag)?.domain)
}

// Published Glicko-2 state for a host: discovery crawl first, then the current item's
// PGN tags (a finished rated game on screen proves prior history even when the crawl
// window missed older pages or returned before sitemap pages loaded).
function publishedRatingForRecovery(data, ownSite) {
  if (!ownSite) return null
  const elig = eligibleGame()
  if (elig) {
    if (sitesMatch(elig.whiteSite, ownSite) && data?.white) {
      return normalizeRatingState(data.white)
    }
    if (sitesMatch(elig.blackSite, ownSite) && data?.black) {
      return normalizeRatingState(data.black)
    }
  }
  const pgn = currentPgn()
  if (pgn && !isUnratedGame(pgn)) {
    const fromPgn = stateFromGamePgn(pgn, ownSite)
    if (fromPgn?.state) return fromPgn.state
  }
  return null
}

// Mirror the local viewer's stored state into the player bar for the seat they own.
// Keyed by wiki host — never by `localPlayerSeatColor()`, which can disagree with
// `ownSiteFor` on first paint and would clobber the opponent's discovered rating.
function applyOwnStateToDiscovered(ownSite, ownState, elig) {
  if (!ownSite || !ownState || !elig) return
  if (sitesMatch(elig.whiteSite, ownSite)) {
    discovered.white = ownState
    discovered.verified.white = true
  } else if (sitesMatch(elig.blackSite, ownSite)) {
    discovered.black = ownState
    discovered.verified.black = true
  }
}

function canAutosave() {
  return Boolean(ctx?.chessState?.pageOnThisWiki && ctx?.wikiFrame && !ctx?.followsPopup)
}

// # Stockfish Calibration

// A game where the LOCAL player (a real wiki player) faces Stockfish on an embedded page
// — the human-vs-engine analogue of `eligibleGame`, but without requiring a result so it
// also works mid-game. Returns the human's host + seat + the engine's UI level, or null.
function localEngineSeat(pgn = currentPgn()) {
  const state = ctx?.chessState
  if (!ctx?.wikiFrame || ctx?.followsPopup || !state || !pgn) return null
  if (
    state.gameType === 'puzzle' ||
    state.gameType === 'position' ||
    state.format === 'FEN' ||
    state.mode === 'POSITION' ||
    state.mode === 'PUZZLE'
  ) {
    return null
  }
  const whiteTag = getPgnTag(pgn, 'White')
  const blackTag = getPgnTag(pgn, 'Black')
  const whiteLevel = parseStockfishLevel(whiteTag)
  const blackLevel = parseStockfishLevel(blackTag)
  // Exactly one seat must be the engine (a human-vs-Stockfish game).
  if ((whiteLevel != null) === (blackLevel != null)) return null

  const engineSeat = whiteLevel != null ? 'w' : 'b'
  const humanSeat = engineSeat === 'w' ? 'b' : 'w'
  // Only ever act on the LOCAL player's own seat, keyed by a resolvable wiki host.
  if (ctx.localPlayerSeatColor() !== humanSeat) return null
  const humanTag = humanSeat === 'w' ? whiteTag : blackTag
  const host = String(parsePlayerId(humanTag)?.domain || '')
    .trim()
    .toLowerCase()
  if (!host) return null

  return { site: host, humanSeat, engineLevel: engineSeat === 'w' ? whiteLevel : blackLevel }
}

// A FINISHED local engine game (a `localEngineSeat` plus a decisive/drawn result), or
// null. Engine games update only the personal vs-Stockfish track — see
// `handleEngineGameOver`.
function engineCalibrationGame(pgn = currentPgn()) {
  const seat = localEngineSeat(pgn)
  if (!seat) return null
  const result = getPgnTag(pgn, 'Result')
  if (result !== WHITE_WIN && result !== BLACK_WIN && result !== DRAW) return null
  return { ...seat, result }
}

// Show the player's standalone vs-Stockfish reference rating in their own bar during an
// engine game (it isn't a federated rating, so it's flagged separately). No-op unless
// this is the local player's engine game and they have a stored engine rating.
function showOwnEngineRating() {
  const seat = localEngineSeat()
  if (!seat) return
  const store = storage()
  const engineState = store ? loadEngineState(store, seat.site) : null
  if (!engineState) return
  const color = seat.humanSeat === 'w' ? 'white' : 'black'
  discovered[color] = engineState
  discovered.vsStockfish[color] = true
  ctx.refreshPlayerLabels()
}

// Game-over handling for an engine game: update the personal vs-Stockfish track only.
// Engine results never seed or change the federated human Glicko-2 rating.
function handleEngineGameOver({ host, humanSeat, engineLevel, result }) {
  const store = storage()
  if (!store) return
  const score = resultToScore(result, humanSeat === 'w' ? 'White' : 'Black')
  if (score == null) return
  const elo = stockfishLevelElo(engineLevel)
  const now = Date.now()
  const color = humanSeat === 'w' ? 'white' : 'black'

  const engineAfter = rateEngineGame(loadEngineState(store, host) || newRatingState(), {
    elo,
    score,
    now,
  })
  saveEngineState(store, host, engineAfter)

  discovered[color] = engineAfter
  discovered.vsStockfish[color] = true
  ctx.refreshPlayerLabels()
}

// # First Game Recovery

// When there is no local rating for this host, write a neutral 1500 prior immediately
// (play is never gated) and defer adoption of any published rated history until
// discovery replies (`resolvePendingRecovery`).
function maybeSeedLocalRating(ownSite) {
  const store = storage()
  if (!store || !ownSite) return
  if (loadOwnState(store, ownSite)) return
  loadOrSeed(store, ownSite)
  pendingRecoverySite = ownSite
}

// Once discovery has reported: adopt published Glicko-2 state if present; otherwise
// keep the neutral 1500 prior written by `maybeSeedLocalRating`.
function resolvePendingRecovery(data) {
  if (!pendingRecoverySite) return
  pendingRecoverySite = null
  const store = storage()
  if (!store) return
  const elig = eligibleGame()
  const ownSite = elig ? viewerRatingSiteKey(elig) : null
  if (!ownSite) return
  // A game-over between the discovery request and this reply may already have written real
  // played state (gamesPlayed > 0); never clobber that with a discovered snapshot.
  if ((loadOwnState(store, ownSite)?.gamesPlayed || 0) > 0) return

  const published = publishedRatingForRecovery(data, ownSite)
  if (!published) return

  // Returning player, or a recovered local loss: adopt the published Glicko-2 state as the
  // local authoritative record (overwriting the neutral prior). The PGN headers carry only
  // rating/RD/volatility, not the running game count, so floor gamesPlayed at 1.
  saveOwnState(store, ownSite, { ...published, gamesPlayed: Math.max(1, published.gamesPlayed) })
}

// # Rating Entry Points

export function onGameInit() {
  const elig = eligibleGame()
  if (!elig) {
    discovered = emptyDiscovered()
    lastDiscoverKey = null
    pendingFinalizeText = null
    hideFinalizeControl()
    // An engine game isn't federated, but a RATED one updates the player's personal
    // vs-Stockfish reference rating. A casual ([Rated "no"]) engine game touches no rating.
    if (!isUnratedGame()) {
      showOwnEngineRating()
    }
    return
  }

  const ownSite = viewerRatingSiteKey(elig)
  maybeSeedLocalRating(ownSite)

  const key = `${elig.whiteSite}|${elig.blackSite}|${ctx.chessState?.itemId || ''}`
  const matchupChanged = key !== lastDiscoverKey
  // A new matchup: drop the previous game's numbers so a stale opponent rating never
  // lingers on the board between the crawl request and its reply.
  if (matchupChanged) {
    discovered = emptyDiscovered()
  }

  // Seed the local seat's display from our own authoritative stored state right away
  // (discovery is for the opponent; we already know ourselves).
  const store = storage()
  const ownState = store ? loadOwnState(store, ownSite) : null
  if (ownState) applyOwnStateToDiscovered(ownSite, ownState, elig)

  if (matchupChanged) {
    lastDiscoverKey = key
    shellMessenger()?.discoverRatings({
      white: { site: elig.whiteSite },
      black: { site: elig.blackSite },
    })
  }
  ctx.refreshPlayerLabels()
}

export function handleRatingState(data) {
  if (!data) return
  discovered.white = data.white ? normalizeRatingState(data.white) : discovered.white
  discovered.black = data.black ? normalizeRatingState(data.black) : discovered.black
  discovered.verified = {
    white: Boolean(data.verified?.white),
    black: Boolean(data.verified?.black),
  }

  // Adopt published history (if any) over the neutral prior when the local store was empty.
  resolvePendingRecovery(data)

  const elig = eligibleGame()
  if (elig) {
    const store = storage()
    const ownSite = viewerRatingSiteKey(elig)
    const ownState = store ? loadOwnState(store, ownSite) : null
    if (ownState) applyOwnStateToDiscovered(ownSite, ownState, elig)
  }
  ctx.refreshPlayerLabels()
}

export function onGameOver() {
  const pgn = ctx?.exportChessText?.() || currentPgn()
  // A casual game (engine or human) the player marked unrated touches no rating track.
  if (isUnratedGame(pgn)) return
  // A rated game vs Stockfish isn't federated; it only updates the vs-Stockfish track.
  const calib = engineCalibrationGame(pgn)
  if (calib) {
    handleEngineGameOver(calib)
    return
  }
  const elig = eligibleGame(pgn)
  if (!elig) return
  const result = getPgnTag(pgn, 'Result')
  if (result !== WHITE_WIN && result !== BLACK_WIN && result !== DRAW) return

  const store = storage()
  if (!store) return

  const localSeat = ctx.localPlayerSeatColor()
  const ownSite = viewerRatingSiteKey(elig)
  const oppSite = localSeat === 'w' ? elig.blackSite : elig.whiteSite

  const finalizedPgn = stampCompletionTags(pgn)
  const completedAt = Date.parse(getPgnTag(finalizedPgn, 'TerminationTimestamp')) || Date.now()

  const ownState = loadOrSeed(store, ownSite)
  const oppDiscovered = localSeat === 'w' ? discovered.black : discovered.white
  const oppState = oppDiscovered ? normalizeRatingState(oppDiscovered) : newRatingState()

  const white = localSeat === 'w' ? ownState : oppState
  const black = localSeat === 'w' ? oppState : ownState
  const rated = rateGame({ white, black, result, now: completedAt })
  if (!rated) return

  const ownNew = localSeat === 'w' ? rated.white : rated.black
  saveOwnState(store, ownSite, ownNew)
  recordOpponent(store, ownSite, oppSite)
  indexedDbMemory.players[ownSite] = ownNew

  const tags = buildGlickoTags({ rated: true, white: rated.white, black: rated.black })
  let stamped = finalizedPgn
  for (const [tag, value] of Object.entries(tags)) {
    stamped = setPgnTag(stamped, tag, String(value))
  }

  discovered.white = rated.white
  discovered.black = rated.black
  if (ctx.chessState) ctx.chessState.PGN = stamped

  if (canAutosave()) {
    pendingFinalizeText = null
    hideFinalizeControl()
    ctx.putJournal(stamped)
  } else {
    pendingFinalizeText = stamped
    showFinalizeControl()
  }
  ctx.refreshPlayerLabels()
}

export function finalizeMatch() {
  if (!pendingFinalizeText) return
  shellMessenger()?.finalizeMatch({ text: pendingFinalizeText })
  pendingFinalizeText = null
  hideFinalizeControl()
}

export function ratingForSeat(seat) {
  const state = seat === 'Black' ? discovered.black : discovered.white
  if (!state) return { text: '', title: '' }
  // An engine game shows the player's personal vs-Stockfish track, not a federated
  // rating: it's never ranked, so it's labelled distinctly.
  const vsStockfish = seat === 'Black' ? discovered.vsStockfish?.black : discovered.vsStockfish?.white
  if (vsStockfish) {
    return {
      text: formatRatingLabel(state),
      title: "Your rating vs Stockfish — for your reference only; engine games don't factor into your primary rating",
    }
  }
  const verified = seat === 'Black' ? discovered.verified?.black : discovered.verified?.white
  const provisional = isProvisional(state)
  const parts = []
  if (provisional) parts.push('provisional (still calibrating)')
  if (!verified) parts.push('unverified — no matching twin found across wikis')
  return {
    text: formatRatingLabel(state),
    title: parts.length ? `Glicko-2 rating — ${parts.join('; ')}` : 'Glicko-2 rating',
  }
}

// # Finalize Control

function finalizeControl() {
  return typeof document !== 'undefined' ? document.getElementById('wiki-chess-finalize') : null
}

function showFinalizeControl() {
  const el = finalizeControl()
  if (!el) return
  el.hidden = false
  el.removeAttribute('aria-hidden')
  if (!el.dataset.wired) {
    el.dataset.wired = 'true'
    el.addEventListener('click', finalizeMatch)
  }
  ctx?.notifyWikiHeight?.()
}

function hideFinalizeControl() {
  const el = finalizeControl()
  if (!el || el.hidden) return
  el.hidden = true
  el.setAttribute('aria-hidden', 'true')
  ctx?.notifyWikiHeight?.()
}

// # Leaderboard Browse Shell

// Current view state.
//   viewKind: 'federatedLeaderboard' = the gated, aggregated leaderboard (CHOOSE menu);
//             'siteSurvey' = the per-site survey probe rendered on a SURVEY page.
//   mode:     the build-leaderboard reach — 'mine' | 'neighborhood' | 'survey' | 'site'.
//   survey:   survey id when in survey mode.
//   entries/meta: the last shell reply.
let viewKind = 'federatedLeaderboard'
let mode = 'mine'
let survey = DEFAULT_SURVEY_ID
let lbEntries = []
let lbMeta = null
let lbLoading = false
// Live neighborhood fetch progress from the shell (object | null).
let lbProgress = null
// True when the current request is a full deep recompute (no checkpoint shortcut).
let lbDeepRefresh = false
let lbBackground = false
// Foreground Visible-federation crawl — show a whole-window OK alert when it finishes,
// even if the user left #leaderboard or switched plugin modes meanwhile.
let notifySurveyCrawlOnComplete = false
// Shown for the whole Visible-federation crawl (status + footer), not only the first paint.
const SURVEY_CRAWL_KEEP_OPEN_HINT =
  'Leave this open — the crawl keeps running in the background. Do not close this tab or window.'
// Per-mode cache of the last shell reply: { entries, meta } or null for each board.
const lbBoardCache = { mine: null, neighborhood: null, survey: null }
const SITE_SURVEY_CACHE_TTL_MS = 5 * 60 * 1000

function siteSurveyCacheStorageKey(host) {
  return `wiki-chess-site-survey:${normalizeWikiSite(host)}`
}

function storeSiteSurveyCache(entries, meta) {
  const host = String(meta?.site ?? ctx?.viewingSite?.() ?? '')
    .trim()
    .toLowerCase()
  if (!host || !meta || !Array.isArray(meta.games)) return
  try {
    const { openChallengesLocal: _local, ...metaRest } = meta
    sessionStorage.setItem(
      siteSurveyCacheStorageKey(host),
      JSON.stringify({
        at: Date.now(),
        entries: Array.isArray(entries) ? entries : [],
        meta: { ...metaRest, openChallengesPending: false },
      }),
    )
  } catch {
    /* sessionStorage unavailable or quota exceeded */
  }
}

// Merge a newly posted seek into the session cache without clearing rated-games rows.
function patchSiteSurveyCacheOpenChallenge(entry) {
  const host = String(entry?.site || ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  if (!host || !entry) return
  try {
    const raw = sessionStorage.getItem(siteSurveyCacheStorageKey(host))
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed?.meta || !Array.isArray(parsed.meta.games)) return
    parsed.meta.openChallenges = mergeOpenChallengeEntries(
      [entry],
      Array.isArray(parsed.meta.openChallenges) ? parsed.meta.openChallenges : [],
    )
    delete parsed.meta.openChallengesPending
    parsed.at = Date.now()
    sessionStorage.setItem(siteSurveyCacheStorageKey(host), JSON.stringify(parsed))
  } catch {
    /* sessionStorage unavailable or quota exceeded */
  }
}

// Drop a canceled seek from the session cache without clearing rated-games rows.
function removeSiteSurveyCacheOpenChallenge(itemId) {
  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  const id = String(itemId || '').trim()
  if (!host || !id) return
  try {
    const raw = sessionStorage.getItem(siteSurveyCacheStorageKey(host))
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed?.meta || !Array.isArray(parsed.meta.games)) return
    const list = Array.isArray(parsed.meta.openChallenges) ? parsed.meta.openChallenges : []
    parsed.meta.openChallenges = list.filter(e => String(e?.itemId || '').trim() !== id)
    delete parsed.meta.openChallengesPending
    parsed.at = Date.now()
    sessionStorage.setItem(siteSurveyCacheStorageKey(host), JSON.stringify(parsed))
  } catch {
    /* sessionStorage unavailable or quota exceeded */
  }
}

function loadSiteSurveyCache() {
  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  if (!host) return false
  try {
    const raw = sessionStorage.getItem(siteSurveyCacheStorageKey(host))
    if (!raw) return false
    const { at, entries, meta } = JSON.parse(raw)
    // Empty games[] is not a usable snapshot (often a pre-crawl / failed probe). Treat as miss
    // so open does a visible crawl instead of priming empty categories.
    if (
      !meta ||
      !Array.isArray(meta.games) ||
      !meta.games.length ||
      Date.now() - Number(at) > SITE_SURVEY_CACHE_TTL_MS
    ) {
      return false
    }
    lbEntries = Array.isArray(entries) ? entries : []
    lbMeta = meta
    if (meta.hasRatedGame != null) siteHasRatedGame = !!meta.hasRatedGame
    return true
  } catch {
    return false
  }
}

function isSiteSurveyAllSurface() {
  return viewKind === 'siteSurvey' && siteProbeKind === 'all'
}

// When true, the next cache prime paints only — skip federation crawl / board refresh.
let skipNextSiteSurveyRefresh = false
// One-shot: empty My Chess Games after open → force a visible re-crawl (stale cache / reseed).
let siteSurveyEmptyAutoRefreshDone = false

// Past-opponents already auto-retries an empty board; My Chess Games needs the same for
// empty `meta.games` (session cache after hard refresh / league reseed can look "done"
// while a silent background crawl is still running — or never found the new pages).
// Returns boolean — true when a forced board request was started
function maybeAutoRefreshEmptySiteSurvey() {
  if (siteSurveyEmptyAutoRefreshDone) return false
  if (!isSiteSurveyAllSurface()) return false
  if (lbLoading) return false
  if (lbMeta?.unavailable || lbMeta?.wrongPage) return false
  if (Array.isArray(lbMeta?.games) && lbMeta.games.length > 0) return false
  siteSurveyEmptyAutoRefreshDone = true
  requestBoard({ force: true, refreshOpenChallenges: true })
  return true
}

// Show a cached My Chess Games snapshot immediately, then refresh in the background.
function primeSiteSurveyFromCache() {
  if (!isSiteSurveyAllSurface() || !loadSiteSurveyCache()) return false
  const hasGames = Array.isArray(lbMeta?.games) && lbMeta.games.length > 0
  if (skipNextSiteSurveyRefresh) {
    lbLoading = false
    skipNextSiteSurveyRefresh = false
    openChallengesLoading = false
    renderLeaderboard()
    return true
  }
  // Empty session snapshot is not authoritative — fall through to a foreground crawl
  // instead of painting zero games with a silent background refresh (no status spinner).
  if (!hasGames) return false
  lbLoading = false
  openChallengesLoading = true
  renderLeaderboard()
  beginDeferredSiteSurveyWork()
  requestBoard({ background: true, force: true })
  return true
}

let category = DEFAULT_CATEGORY
let sortColumn = DEFAULT_SORT.column
let sortDir = DEFAULT_SORT.dir
// Active per-column filter text, keyed by column id.
let columnFilters = {}
let reliableOnly = false
let fromSurveyItem = false
let siteProbeKind = 'all'
let lbWired = false
let boardRequestSeq = 0
let openChallengesLoading = false
let surveyOpenChallengesSeq = 0

let siteHasRatedGame = false
let checkingRatedStatus = false
// One-shot: empty Past opponents + site has rated games → force local re-read.
let mineEmptyAutoRefreshDone = false
let mineEmptyRatedProbePending = false
let chooseMenuSurveyBrowse = false

// Federated-only leaderboard UI (gate, hop dials, ranking table) lives in leaderboard.js.
// It registers its render/wiring hooks here; imports stay one-way (leaderboard.js → survey.js).
let leaderboardUi = null

export function registerLeaderboardUi(api) {
  leaderboardUi = api || null
}

// Live read view of the shared #leaderboard browse state for leaderboard.js.
export function lbSnapshot() {
  return {
    viewKind,
    mode,
    survey,
    lbEntries,
    lbMeta,
    lbLoading,
    lbProgress,
    lbBackground,
    lbDeepRefresh,
    sortColumn,
    sortDir,
    category,
    reliableOnly,
    columnFilters,
    siteProbeKind,
    fromSurveyItem,
    siteHasRatedGame,
    checkingRatedStatus,
    mineEmptyAutoRefreshDone,
    mineEmptyRatedProbePending,
    lbBoardCache,
  }
}

// Apply cross-module writes to the shared browse state from leaderboard.js.
export function setLbState(patch = {}) {
  if ('viewKind' in patch) viewKind = patch.viewKind
  if ('mode' in patch) mode = patch.mode
  if ('survey' in patch) survey = patch.survey
  if ('fromSurveyItem' in patch) fromSurveyItem = patch.fromSurveyItem
  if ('lbLoading' in patch) lbLoading = patch.lbLoading
  if ('lbEntries' in patch) lbEntries = patch.lbEntries
  if ('lbMeta' in patch) lbMeta = patch.lbMeta
  if ('siteHasRatedGame' in patch) siteHasRatedGame = patch.siteHasRatedGame
  if ('checkingRatedStatus' in patch) checkingRatedStatus = patch.checkingRatedStatus
  if ('mineEmptyAutoRefreshDone' in patch) mineEmptyAutoRefreshDone = patch.mineEmptyAutoRefreshDone
  if ('mineEmptyRatedProbePending' in patch) mineEmptyRatedProbePending = patch.mineEmptyRatedProbePending
}

export function isPrimaryEmbedSurface() {
  // Must be the wiki iframe (not popup/PWA with window.opener as wikiFrame).
  return Boolean(ctx?.isWikiEmbed && ctx?.wikiFrame && !ctx?.followsPopup)
}

export function isInAppSurveySurface() {
  // Wiki iframe embeds stay on the wiki surface even when the parent wiki is an installed
  // PWA (display-mode:standalone matches in nested frames and used to hide "New Chess Page").
  // Do not key off isPrimaryEmbedSurface — a follower embed (followsPopup) is still a wiki
  // iframe, not an in-app PWA/popup surface.
  if (ctx?.isWikiEmbed) return false
  return Boolean(ctx?.pwaBridgeActive || ctx?.isPwaStandalone || ctx?.isWikiPopup)
}

function canShowSiteSurveyActions() {
  return fromSurveyItem || chooseMenuSurveyBrowse
}

function canPostOpenChallenge() {
  return Boolean(ctx?.canPublish?.())
}

export function resetChooseMenuSurveyBrowse() {
  chooseMenuSurveyBrowse = false
}

const surveySectionOpen = new Map()
const SURVEY_SECTION_OPEN_KEY = 'wiki-chess-survey-section-open'

function loadSurveySectionOpenMemory() {
  try {
    const raw = sessionStorage.getItem(SURVEY_SECTION_OPEN_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [sectionId, open] of Object.entries(parsed)) {
      if (typeof open === 'boolean') surveySectionOpen.set(sectionId, open)
    }
  } catch {
    /* sessionStorage unavailable or quota exceeded */
  }
}

function persistSurveySectionOpenMemory() {
  try {
    sessionStorage.setItem(SURVEY_SECTION_OPEN_KEY, JSON.stringify(Object.fromEntries(surveySectionOpen)))
  } catch {
    /* sessionStorage unavailable or quota exceeded */
  }
}

loadSurveySectionOpenMemory()

// Only refresh memory when we already have a remembered value — otherwise the first
// render would seed "closed" from markup and ignore defaultOpen.
function rememberSurveySectionOpen(sectionId) {
  const details = el(sectionId)?.querySelector('.wiki-chess-lb-survey-details')
  if (!details || !surveySectionOpen.has(sectionId)) return
  surveySectionOpen.set(sectionId, details.open)
  persistSurveySectionOpenMemory()
}

function restoreSurveySectionOpen(sectionId, { defaultOpen = true } = {}) {
  const details = el(sectionId)?.querySelector('.wiki-chess-lb-survey-details')
  if (!details) return
  const saved = surveySectionOpen.get(sectionId)
  details.open = saved !== undefined ? saved : defaultOpen
}

function wireSurveySectionDetails(sectionId) {
  const details = el(sectionId)?.querySelector('.wiki-chess-lb-survey-details')
  if (!details || details.dataset.surveyWired) return
  details.dataset.surveyWired = 'true'
  details.addEventListener('toggle', () => {
    surveySectionOpen.set(sectionId, details.open)
    persistSurveySectionOpenMemory()
    ctx?.notifyWikiHeight?.()
  })
}

function updateSurveySectionHeading(section, label, count) {
  const titleEl = section.querySelector('.wiki-chess-lb-survey-section-title')
  if (titleEl) titleEl.textContent = label
  const countEl = section.querySelector('.wiki-chess-lb-survey-section-count')
  if (countEl) {
    if (count > 0) {
      countEl.textContent = ` (${count})`
      countEl.hidden = false
    } else {
      countEl.textContent = ''
      countEl.hidden = true
    }
  }
}

function openMyChessGamesInWiki() {
  // Any wiki iframe (including follower mode) opens the lineup page — never paint
  // My Chess Games inside Chess Leaderboards / another maintenance embed.
  if (!ctx?.isWikiEmbed || !ctx?.wikiFrame) return
  shellMessenger()?.openSurveyPage({ view: true })
}

const MY_CHESS_GAMES_WIKI_BUTTON_IDS = [
  'wikiChessMyGamesNav',
  'positionMyGamesBtn',
  'puzzleMyGamesBtn',
  'wikiChessLbMyGames',
]

const LEADERBOARD_WIKI_BUTTON_IDS = ['wikiChessLbOpenPage']

let myChessGamesWikiButtonsWired = false

// Wire every static "open My Chess Games in the wiki lineup" button (footer + leaderboard).
export function wireMyChessGamesWikiButtons() {
  if (myChessGamesWikiButtonsWired) return
  myChessGamesWikiButtonsWired = true
  // Popup / installed PWA: stay in-app (same as CHOOSE → My Chess Games). Embed opens the wiki page.
  const open = () => openMyChessGamesFromChooseMenu()
  for (const id of MY_CHESS_GAMES_WIKI_BUTTON_IDS) {
    document.getElementById(id)?.addEventListener('click', open)
  }
  for (const id of LEADERBOARD_WIKI_BUTTON_IDS) {
    document.getElementById(id)?.addEventListener('click', () => leaderboardUi?.openLeaderboardInWiki?.())
  }
}

function openSiteSurveyFromChooseMenu() {
  ctx?.clearBrowseStartMenuState?.()
  chooseMenuSurveyBrowse = true
  fromSurveyItem = true
  viewKind = 'siteSurvey'
  mode = 'site'
  siteProbeKind = 'all'
  survey = DEFAULT_SURVEY_ID
  siteSurveyEmptyAutoRefreshDone = false
  ctx.changePage('leaderboard')
  // Installed PWA: chrome still showed the previous play-page title after changePage
  // re-enabled it — retarget to My Chess Games before painting the lobby.
  ctx.adoptPwaSurveyPage?.()
  wireLeaderboardView()
  if (primeSiteSurveyFromCache()) return
  skipNextSiteSurveyRefresh = false
  requestBoard()
}

export function openMyChessGamesFromChooseMenu() {
  // Popup / installed PWA: open the in-app site survey (do not bounce to the paired wiki tab).
  if (isInAppSurveySurface()) {
    openSiteSurveyFromChooseMenu()
    return
  }
  // Wiki iframe (active or follower): open My Chess Games in the lineup — never swap the
  // current embed (e.g. Chess Leaderboards) into an in-iframe site-survey view.
  if (ctx?.isWikiEmbed) {
    openMyChessGamesInWiki()
    return
  }
  openSiteSurveyFromChooseMenu()
}

// # Leaderboard Entry Points

// Past opponents can paint empty from stale IndexedDB/cache after a league re-seed while the
// sitemap still has rated games. Force one local-site refresh when that happens.
// Returns boolean — true when a forced board request was started
export function maybeAutoRefreshEmptyPastOpponents() {
  if (mineEmptyAutoRefreshDone) return false
  if (viewKind !== 'federatedLeaderboard' || mode !== 'mine') return false
  if (lbEntries.length) return false
  if (lbMeta?.wrongPage || lbMeta?.unavailable) return false

  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  if (viewerHasRatedGame(host)) {
    mineEmptyAutoRefreshDone = true
    mineEmptyRatedProbePending = false
    lbBoardCache.mine = null
    requestBoard({ force: true })
    return true
  }

  if (!mineEmptyRatedProbePending && !checkingRatedStatus && canProbeSurveyStatus()) {
    mineEmptyRatedProbePending = true
    checkingRatedStatus = true
    shellMessenger()?.surveyStatus()
  }
  return false
}

export function canProbeSurveyStatus() {
  if (ctx?.pwaBridgeActive) return true
  return Boolean(ctx?.wikiFrame && !ctx?.followsPopup)
}

export function viewerHasRatedGame(host) {
  if (siteHasRatedGame) return true
  return host ? (ctx?.ownGamesPlayed?.(host) || 0) > 0 : false
}

function showSurveyNewPageFailed() {
  const status = el('wikiChessLbStatus')
  if (!status) return
  status.hidden = false
  status.className = 'wiki-chess-lb-status alert alert-warning py-2 px-3 mb-2'
  status.textContent = ctx?.canPublish?.()
    ? 'Could not open a new chess page. Try again or refresh the wiki page.'
    : 'Sign in on your wiki to add a new chess page.'
  ctx?.notifyWikiHeight?.()
}

export function ensureLeaderboardShellInteractive() {
  clearViewportBlockingModals()
  ensureMountContentVisible('#leaderboard .container-fluid')
  const toolbar = el('wikiChessLbToolbar')
  if (toolbar) {
    toolbar.hidden = false
    toolbar.style.removeProperty('display')
    toolbar.style.removeProperty('pointer-events')
  }
}

export function showLeaderboardForItem() {
  resetChooseMenuSurveyBrowse()
  fromSurveyItem = true
  viewKind = 'siteSurvey'
  mode = 'site'
  siteProbeKind = 'all'
  siteSurveyEmptyAutoRefreshDone = false
  const raw = ctx?.chessState?.chessState || ctx?.chessState?.PGN || 'SURVEY'
  const parsed = parseSurveyRecord(raw)
  survey = parsed?.survey || DEFAULT_SURVEY_ID
  ensureLeaderboardShellInteractive()
  ctx.changePage('leaderboard')
  ctx.adoptPwaSurveyPage?.()
  wireLeaderboardView()
  if (primeSiteSurveyFromCache()) return
  skipNextSiteSurveyRefresh = false
  requestBoard()
}

export function handleLeaderboardProgress(data) {
  if (!data || Number(data.seq) !== boardRequestSeq) return
  lbProgress = data
  if (data?.siteCrawlCache && typeof data.siteCrawlCache === 'object') {
    rememberSiteCrawlCache(data.siteCrawlCache)
  }
  const now = Date.now()
  if (
    handleLeaderboardProgress._lastPaint &&
    now - handleLeaderboardProgress._lastPaint < 250 &&
    data.phase !== 'done' &&
    data.phase !== 'recompute'
  ) {
    // Still refresh hop weeded counts while crawling.
    if (Array.isArray(data.hopStats) && mode === 'survey') leaderboardUi?.renderHopGraphPanel?.()
    return
  }
  handleLeaderboardProgress._lastPaint = now
  if (isLeaderboardPageVisible()) renderLeaderboard()
}

export function handleLeaderboardData(data) {
  if (!data) return
  const entries = Array.isArray(data.entries) ? data.entries : []
  const meta = data.meta || null
  if (meta?.hasRatedGame != null) {
    siteHasRatedGame = !!meta.hasRatedGame
    checkingRatedStatus = false
  }
  if (meta?.players && typeof meta.players === 'object') {
    indexedDbMemory.players = { ...indexedDbMemory.players, ...meta.players }
    indexedDbMemory.meta.checkpoint = meta?.checkpoint || indexedDbMemory.meta.checkpoint
    indexedDbMemory.meta.stateHash = meta?.stateHash || computeStateHash(meta.players)
    if (meta?.checkpoint?.last_global_sync_timestamp) {
      const parsed = Date.parse(meta.checkpoint.last_global_sync_timestamp)
      if (Number.isFinite(parsed)) indexedDbMemory.meta.lastGlobalSyncAt = parsed
    }
    if (meta?.lastTimelineKey) indexedDbMemory.meta.lastTimelineKey = meta.lastTimelineKey
    if (meta?.syncMode) indexedDbMemory.meta.lastSyncMode = meta.syncMode
    if (Array.isArray(meta?.pastOpponents)) indexedDbMemory.meta.pastOpponents = meta.pastOpponents
    {
      const blocked = coerceBlockListMeta(meta)
      if (blocked) indexedDbMemory.meta.blockList = blocked
    }
    if (meta?.deletionMetrics && typeof meta.deletionMetrics === 'object') {
      indexedDbMemory.meta.deletionMetrics = meta.deletionMetrics
    }
    if (meta?.island && typeof meta.island === 'object') {
      indexedDbMemory.meta.island = meta.island
    }
    if (meta?.siteCrawlCache && typeof meta.siteCrawlCache === 'object') {
      rememberSiteCrawlCache(meta.siteCrawlCache)
    }
    void persistRatingPlayers()
  } else if (entries.length) {
    const players = {}
    for (const row of entries) {
      const site = row?.site
      if (!site) continue
      players[cleanSite(site)] = normalizeRatingState({
        rating: row.rating,
        rd: row.rd,
        gamesPlayed: row.games,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        peak: row.peak,
        whiteWins: row.whiteWins,
        whiteLosses: row.whiteLosses,
        whiteDraws: row.whiteDraws,
        blackWins: row.blackWins,
        blackLosses: row.blackLosses,
        blackDraws: row.blackDraws,
        updated: row.updated,
      })
    }
    indexedDbMemory.players = { ...indexedDbMemory.players, ...players }
    indexedDbMemory.meta.checkpoint = meta?.checkpoint || indexedDbMemory.meta.checkpoint
    indexedDbMemory.meta.stateHash = meta?.stateHash || computeStateHash(players)
    if (meta?.checkpoint?.last_global_sync_timestamp) {
      const parsed = Date.parse(meta.checkpoint.last_global_sync_timestamp)
      if (Number.isFinite(parsed)) indexedDbMemory.meta.lastGlobalSyncAt = parsed
    }
    if (meta?.lastTimelineKey) indexedDbMemory.meta.lastTimelineKey = meta.lastTimelineKey
    if (meta?.syncMode) indexedDbMemory.meta.lastSyncMode = meta.syncMode
    if (Array.isArray(meta?.pastOpponents)) indexedDbMemory.meta.pastOpponents = meta.pastOpponents
    {
      const blocked = coerceBlockListMeta(meta)
      if (blocked) indexedDbMemory.meta.blockList = blocked
    }
    if (meta?.deletionMetrics && typeof meta.deletionMetrics === 'object') {
      indexedDbMemory.meta.deletionMetrics = meta.deletionMetrics
    }
    if (meta?.island && typeof meta.island === 'object') {
      indexedDbMemory.meta.island = meta.island
    }
    if (meta?.siteCrawlCache && typeof meta.siteCrawlCache === 'object') {
      rememberSiteCrawlCache(meta.siteCrawlCache)
    }
    void persistRatingPlayers()
  } else if (meta?.siteCrawlCache && typeof meta.siteCrawlCache === 'object') {
    rememberSiteCrawlCache(meta.siteCrawlCache)
  }
  // Always cache the canonical visible-federation board; mode views are filters over it.
  if (meta?.surveyEntries?.length) storeSurveyBoardCache(meta.surveyEntries, meta)
  else if (meta?.mode === 'survey' && entries.length) storeSurveyBoardCache(entries, meta)

  const storeKey = boardCacheKey(
    meta?.mode === 'mine' || meta?.mode === 'neighborhood' || meta?.mode === 'survey' ? meta.mode : mode,
  )
  if (storeKey) storeBoardCache(storeKey, entries, meta)

  const seqMatches = Number(data.seq) === boardRequestSeq
  if (!seqMatches) {
    if (meta?.surveyEntries?.length || meta?.mode === 'survey') {
      if (mode !== 'survey' && isLeaderboardPageVisible()) applySurveyFilterFromCache(mode, meta)
    }
    return
  }
  const wasBackground = lbBackground
  const shouldNotifySurveyCrawl = notifySurveyCrawlOnComplete && !wasBackground
  notifySurveyCrawlOnComplete = false
  lbLoading = false
  lbProgress = null
  lbDeepRefresh = false
  lbBackground = false
  bindDeepAuditUnload(false)
  if (mode !== 'survey' && (meta?.surveyEntries?.length || meta?.mode === 'survey')) {
    applySurveyFilterFromCache(mode, meta)
  } else {
    // Fast-path site survey meta lists only seeks stored on this site. Carry previously
    // discovered federation seeks over so Refresh does not blank the Open challenges
    // section while the deferred crawl re-verifies them; keep the pristine local list
    // aside so the crawl's final reply still prunes stale remote entries.
    if (meta?.openChallengesPending && Array.isArray(lbMeta?.openChallenges) && lbMeta.openChallenges.length) {
      meta.openChallengesLocal = Array.isArray(meta.openChallenges) ? meta.openChallenges : []
      meta.openChallenges = mergeOpenChallengeEntries(meta.openChallengesLocal, lbMeta.openChallenges)
    }
    lbEntries = entries
    lbMeta = meta
  }
  if (viewKind === 'siteSurvey' && meta?.mode === 'site' && Array.isArray(meta.games)) {
    storeSiteSurveyCache(lbEntries, lbMeta)
  }
  if (viewKind === 'siteSurvey' && meta?.unavailable && isInAppSurveySurface()) {
    schedulePendingSiteSurveyRetry()
  }
  // Empty My Chess Games after a silent background crawl → one visible re-crawl.
  // (Foreground opens already show a spinner; empty cache is rejected at load time.)
  if (wasBackground && maybeAutoRefreshEmptySiteSurvey()) return
  if (viewKind === 'siteSurvey' && siteProbeKind === 'all' && meta?.openChallengesPending) {
    beginDeferredSiteSurveyWork(data.seq)
  } else if (!meta?.openChallengesPending) {
    openChallengesLoading = false
  }
  if (shouldNotifySurveyCrawl) notifyVisibleFederationCrawlComplete()
  if (!isLeaderboardPageVisible()) {
    // Crawl finished while the user was elsewhere — drop shell unload/loading chrome.
    bindDeepAuditUnload(false)
    if (ctx?.wikiFrame && !ctx?.followsPopup) {
      shellMessenger()?.fetchUi({ loading: false, deep: false, warnUnload: false })
    }
    return
  }
  renderLeaderboard()
  // Hop-bounded visible-federation crawls never match full-federation checkpoints;
  // following queueAudit would restart a deep sync that wipes hop stats and loops.
  if (seqMatches && meta?.queueAudit && !meta?.hopGraph) {
    requestBoard({
      deepRecompute: true,
      background: true,
      syncSurvey: mode === 'survey',
    })
  }
}

function notifyVisibleFederationCrawlComplete() {
  const title = 'Visible federation crawl complete'
  const message =
    'The Visible federation crawl finished. Return to Chess Leaderboards anytime to see the updated ratings.'
  // Wiki embed: parent-window overlay so it grabs attention even on another lineup page
  // or after leaveFederationViews() cleared in-iframe modals.
  if (ctx?.wikiFrame && !isInAppSurveySurface()) {
    shellMessenger()?.alertUi({ title, message, okLabel: 'OK' })
    return
  }
  openAlertModal({ title, message, okLabel: 'OK' })
}

// Kick deferred site-survey enrich + open-challenge crawl (shell or PWA bridge).
function beginDeferredSiteSurveyWork(boardSeq = null) {
  openChallengesLoading = true
  const boardSeqNum = Number(boardSeq)
  if (Number.isFinite(boardSeqNum)) {
    surveyOpenChallengesSeq = boardSeqNum
  } else {
    surveyOpenChallengesSeq += 1
  }
  const seq = surveyOpenChallengesSeq
  // Prefer the pristine local-only list: the shell folds `localOpenChallenges` into every
  // crawl reply (including the final one), so carried-over remote seeks in
  // `lbMeta.openChallenges` would never be pruned if sent here.
  const localOpenChallenges = Array.isArray(lbMeta?.openChallengesLocal)
    ? lbMeta.openChallengesLocal
    : Array.isArray(lbMeta?.openChallenges)
      ? lbMeta.openChallenges
      : Array.isArray(lbMeta?.openSeeks)
        ? lbMeta.openSeeks
        : []
  const localSite = String(ctx?.viewingSite?.() || (typeof location !== 'undefined' ? location.host : '') || '')
    .trim()
    .toLowerCase()
  // Farm peers: browser calls wiki-plugin-present; shell/PWA only receive the host list.
  void fetchFarmPeerSites({ localSite })
    .catch(() => [])
    .then(farmPeerSites => {
      shellMessenger()?.buildChallenges({
        seq,
        forSiteSurvey: true,
        localOpenChallenges,
        farmPeerSites: Array.isArray(farmPeerSites) ? farmPeerSites : [],
        ...federationIndexedDbPayload(),
      })
    })
  if (lbMeta?.siteGamesEnrichmentPending) {
    // Reuse fast-path meta.games so enrich skips a second site crawl.
    const fetchedGames = Array.isArray(lbMeta.games) ? lbMeta.games : []
    shellMessenger()?.enrichSiteSurvey({
      seq: Number.isFinite(boardSeqNum) ? boardSeqNum : boardRequestSeq,
      fetchedGames,
    })
  }
}

function creatorForkBackPendingGamesFromMeta(meta = lbMeta) {
  const host = cleanSite(meta?.site ?? ctx?.viewingSite?.() ?? '')
  const ghosts = Array.isArray(meta?.acceptedGhosts) ? meta.acceptedGhosts : []
  return buildAcceptedGhostGamesList(ghosts, host)
}

// Keep remote "fork back" rows when local enrich replaces the games list.
function mergeSiteSurveyGames(localGames, meta = lbMeta) {
  return mergeMyGamesLists(localGames, creatorForkBackPendingGamesFromMeta(meta))
}

export function handleSurveySiteGamesData(data) {
  if (!data || viewKind !== 'siteSurvey' || siteProbeKind !== 'all') return
  if (Number.isFinite(Number(data.seq)) && Number(data.seq) !== boardRequestSeq) return
  if (lbMeta && Array.isArray(data.games)) {
    lbMeta.games = mergeSiteSurveyGames(data.games, lbMeta)
    delete lbMeta.siteGamesEnrichmentPending
    storeSiteSurveyCache(lbEntries, lbMeta)
  }
  if (!isLeaderboardPageVisible()) return
  renderLeaderboard()
}

export function handleSurveyOpenChallengesData(data) {
  if (!data || viewKind !== 'siteSurvey' || siteProbeKind !== 'all') return
  if (Number.isFinite(Number(data.seq)) && Number(data.seq) !== surveyOpenChallengesSeq) return
  const partial = data.partial === true || data.meta?.partial === true
  const background = data.meta?.background === true
  // Background index follow-ups must never re-open the loading spinner.
  if (!partial && !background) openChallengesLoading = false
  let acceptedGhostsUpdated = false
  if (lbMeta) {
    if (Array.isArray(data.openChallenges)) {
      lbMeta.openChallenges =
        partial || background
          ? mergeOpenChallengeEntries(
              Array.isArray(lbMeta.openChallenges) ? lbMeta.openChallenges : [],
              data.openChallenges,
            )
          : data.openChallenges
    } else if (Array.isArray(data.entries)) {
      lbMeta.openChallenges = mergeOpenChallengeEntries(
        Array.isArray(lbMeta.openChallenges) ? lbMeta.openChallenges : [],
        data.entries,
      )
    }
    const acceptedGhosts = Array.isArray(data.meta?.acceptedGhosts)
      ? data.meta.acceptedGhosts
      : Array.isArray(data.acceptedGhosts)
        ? data.acceptedGhosts
        : null
    if (acceptedGhosts) {
      acceptedGhostsUpdated = true
      lbMeta.acceptedGhosts = acceptedGhosts
      const localGames = Array.isArray(lbMeta.games) ? lbMeta.games.filter(g => !g?.creatorForkBackPending) : []
      lbMeta.games = mergeSiteSurveyGames(localGames, lbMeta)
    }
    if (data.meta?.crawled != null) lbMeta.federationFetched = data.meta.crawled
    if (!partial && !background) {
      delete lbMeta.openChallengesPending
      delete lbMeta.openChallengesLocal
    }
    if (viewKind === 'siteSurvey' && siteProbeKind === 'all' && Array.isArray(lbMeta.games)) {
      storeSiteSurveyCache(lbEntries, lbMeta)
    }
  }
  rememberFederationSites(data.meta?.responsiveHosts)
  rememberFederationSites(data.meta?.federationSitesCache)
  if (!isLeaderboardPageVisible()) return
  // Progressive / background challenge fills must not rebuild survey chrome (e.g. New Chess
  // Page) — that drops :hover and makes the toolbar flash while the list grows.
  if (partial || background) {
    if (acceptedGhostsUpdated) {
      renderGames()
    } else if (!renderSiteSurveyOpenChallenges()) {
      renderLeaderboard()
      return
    }
    ctx?.notifyWikiHeight?.()
    return
  }
  renderLeaderboard()
}

// Tear down gate/modals when leaving #leaderboard — keep in-flight Visible-federation
// crawls running so the user can browse elsewhere and return to a finished board.
export function leaveFederationViews() {
  leaderboardUi?.closeGate?.()
  clearViewportBlockingModals()
  checkingRatedStatus = false
  // Do not abandonFetches / bump boardRequestSeq — late progress and data still apply
  // to IndexedDB and board caches while the wiki tab stays open.
  if (ctx?.wikiFrame && !ctx?.followsPopup && lbLoading) {
    const warnUnload =
      lbDeepRefresh || (viewKind === 'federatedLeaderboard' && (mode === 'survey' || !!lbProgress?.hopGraph))
    shellMessenger()?.fetchUi({ loading: true, deep: lbDeepRefresh, warnUnload })
  }
}

// Shell edit / explicit cancel — crawl is aborted; do not alert on a late orphan reply.
export function abandonInFlightFetches() {
  notifySurveyCrawlOnComplete = false
  lbLoading = false
  lbProgress = null
  lbDeepRefresh = false
  lbBackground = false
  bindDeepAuditUnload(false)
  leaveFederationViews()
  if (ctx?.wikiFrame && !ctx?.followsPopup) {
    shellMessenger()?.fetchUi({ loading: false, deep: false, warnUnload: false })
  }
}

export function isLeaderboardLoading() {
  return lbLoading && isLeaderboardPageVisible()
}

export function boardCacheKey(m = mode) {
  return viewKind === 'federatedLeaderboard' && (m === 'mine' || m === 'neighborhood' || m === 'survey') ? m : null
}

export function applyBoardCache(key) {
  const hit = lbBoardCache[key]
  if (!hit) return false
  lbEntries = hit.entries
  lbMeta = hit.meta
  return true
}

function storeBoardCache(key, entries, meta) {
  if (!key) return
  lbBoardCache[key] = {
    entries: Array.isArray(entries) ? [...entries] : [],
    meta: meta ? { ...meta } : null,
  }
}

function shouldCheckSurveyStatus() {
  return viewKind === 'federatedLeaderboard' || (viewKind === 'siteSurvey' && fromSurveyItem)
}

function requestSurveyStatus() {
  if (!shouldCheckSurveyStatus()) return
  checkingRatedStatus = true
  shellMessenger()?.surveyStatus()
}

function canRequestShellSurveyFetch() {
  if (!ctx?.wikiFrame) return false
  // The popup is the active chess surface — it must crawl even when the embed follows it.
  if (ctx.isWikiPopup && viewKind === 'siteSurvey') return true
  // Follower mode only disables interactive play in the embed; federation crawls are
  // shell-driven read-only work and must still run for ghost previews and CHOOSE items.
  return true
}

function storeSurveyBoardCache(entries, meta) {
  const prev = lbBoardCache.survey?.meta || {}
  const surveyEntries = Array.isArray(meta?.surveyEntries) ? meta.surveyEntries : entries
  if (!surveyEntries.length && !meta?.players) return
  storeBoardCache('survey', surveyEntries, {
    ...prev,
    ...(meta || {}),
    pastOpponents:
      Array.isArray(meta?.pastOpponents) && meta.pastOpponents.length ? meta.pastOpponents : prev.pastOpponents,
    neighborhoodSites:
      Array.isArray(meta?.neighborhoodSites) && meta.neighborhoodSites.length
        ? meta.neighborhoodSites
        : prev.neighborhoodSites,
    neighborhoodOpponents:
      Array.isArray(meta?.neighborhoodOpponents) && meta.neighborhoodOpponents.length
        ? meta.neighborhoodOpponents
        : prev.neighborhoodOpponents,
    mode: 'survey',
    members: surveyEntries.length,
  })
}

export function applySurveyFilterFromCache(m = mode, overlay = null) {
  const hit = lbBoardCache.survey
  if (!hit?.entries?.length) return false
  const meta = { ...(hit.meta || {}), ...(overlay || {}) }
  // Neighbourhood is the curated wiki.neighborhood roster — transitive opponents stay
  // available for “Add my opponents”, not auto-painted onto this board.
  const neighborhoodSites = meta.neighborhoodSites ?? []
  lbEntries = filterFederatedLeaderboardEntries(hit.entries, m, {
    localSite: String(ctx?.viewingSite?.() || '')
      .trim()
      .toLowerCase(),
    neighborhoodSites,
    neighborhoodOpponents: m === 'neighborhood' ? [] : meta.neighborhoodOpponents || [],
    pastOpponents: m === 'neighborhood' ? [] : meta.pastOpponents || [],
  })
  lbMeta = {
    ...meta,
    mode: m,
    members: lbEntries.length,
    surveyMembers: hit.entries.length,
    filteredFromSurvey: m !== 'survey',
    ...(m === 'neighborhood' ? { neighborhoodSites, neighborhoodOpponents: neighborhoodSites } : {}),
  }
  return true
}

// Paint immediately from IndexedDB when a neighborhood fetch has not run yet this session.
export function primeBoardFromIndexedDb() {
  if (viewKind !== 'federatedLeaderboard') return false
  const players = indexedDbMemory.players
  if (!players || typeof players !== 'object') return false
  const ratingPlayers = {}
  for (const [key, state] of Object.entries(players)) {
    if (!key || key.endsWith(':engine')) continue
    ratingPlayers[cleanSite(key)] = state
  }
  if (!Object.keys(ratingPlayers).length) return false
  const localSite = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  const surveyEntries = buildLeaderboardFromPlayers(ratingPlayers)
  if (!surveyEntries.length) return false
  const pastOpponents = Array.isArray(indexedDbMemory.meta?.pastOpponents)
    ? indexedDbMemory.meta.pastOpponents
    : surveyEntries.map(row => row.site).filter(h => h && !sitesMatch(h, localSite))
  const meta = {
    mode: 'survey',
    generatedAt: indexedDbMemory.meta?.lastGlobalSyncAt || Date.now(),
    checkpoint: indexedDbMemory.meta?.checkpoint || null,
    stateHash: indexedDbMemory.meta?.stateHash || computeStateHash(ratingPlayers),
    players: ratingPlayers,
    pastOpponents,
    surveyEntries,
    members: surveyEntries.length,
    fromIndexedDb: true,
  }
  storeSurveyBoardCache(surveyEntries, meta)
  applySurveyFilterFromCache(mode)
  lbLoading = false
  return true
}

export function requestBoard({
  force = false,
  deepRecompute = false,
  background = false,
  syncSurvey = false,
  refreshOpenChallenges = false,
  extraNeighborhoodSites = null,
  restart = false,
} = {}) {
  const effectiveMode = syncSurvey ? 'survey' : mode
  // Returning to the leaderboard (or a soft reopen) must not abort an in-flight crawl.
  // Explicit Refresh / hop-dial recrawl pass restart: true.
  if (
    lbLoading &&
    !restart &&
    !deepRecompute &&
    effectiveMode === mode &&
    (viewKind === 'federatedLeaderboard' || viewKind === 'siteSurvey')
  ) {
    ensureLeaderboardShellInteractive()
    if (!background) renderLeaderboard()
    return
  }
  boardRequestSeq += 1
  const seq = boardRequestSeq
  if (refreshOpenChallenges && isSiteSurveyAllSurface()) {
    openChallengesLoading = true
    surveyOpenChallengesSeq = seq
  }
  lbBackground = background
  lbDeepRefresh = deepRecompute && effectiveMode === 'survey'
  const neighborhoodExtras = Array.isArray(extraNeighborhoodSites) ? extraNeighborhoodSites.filter(Boolean) : []
  const showProgress = !background && (lbDeepRefresh || effectiveMode === 'survey' || effectiveMode === 'neighborhood')
  const hopDial = effectiveMode === 'survey' ? readNeighborhoodHopGraph() : null
  // Arm once per foreground Visible-federation crawl; cleared when LEADERBOARD_DATA arrives.
  if (!background && viewKind === 'federatedLeaderboard' && effectiveMode === 'survey') {
    notifySurveyCrawlOnComplete = true
  } else if (!background) {
    notifySurveyCrawlOnComplete = false
  }
  lbProgress = showProgress
    ? {
        phase: 'start',
        message:
          effectiveMode === 'neighborhood'
            ? neighborhoodExtras.length
              ? 'Reading rated games from newly added neighbours…'
              : 'Reading rated games from your wiki neighbourhood…'
            : effectiveMode === 'mine'
              ? 'Reading rated games on your site…'
              : hopDial
                ? `Walking visible federation (max ${hopDial.maxHops} hops, decay ${hopDial.hopDecay})… ${SURVEY_CRAWL_KEEP_OPEN_HINT}`
                : `Updating federation ratings… ${SURVEY_CRAWL_KEEP_OPEN_HINT}`,
        deepRecompute: lbDeepRefresh,
        startedAt: Date.now(),
        elapsedMs: 0,
        ...(hopDial ? { hopGraph: hopDial } : {}),
      }
    : effectiveMode === 'mine' && !background
      ? {
          phase: 'start',
          message: 'Reading rated games on your site…',
          deepRecompute: false,
          startedAt: Date.now(),
          elapsedMs: 0,
        }
      : null
  ensureLeaderboardShellInteractive()
  const bridgeSiteSurvey = viewKind === 'siteSurvey' && ctx?.pwaBridgeActive
  const bridgeFederatedBoard = viewKind === 'federatedLeaderboard' && ctx?.pwaBridgeActive
  const pendingPwaSurvey =
    viewKind === 'siteSurvey' && isInAppSurveySurface() && !ctx?.wikiFrame && !ctx?.pwaBridgeActive
  if (!canRequestShellSurveyFetch() && !bridgeSiteSurvey && !bridgeFederatedBoard) {
    bindDeepAuditUnload(false)
    lbDeepRefresh = false
    if (pendingPwaSurvey) {
      lbLoading = true
      lbEntries = []
      lbMeta = null
      renderLeaderboard()
      schedulePendingSiteSurveyRetry()
      return
    }
    lbLoading = false
    lbEntries = []
    lbMeta = { unavailable: true }
    renderLeaderboard()
    return
  }
  const key = boardCacheKey()
  if (!force && !syncSurvey && effectiveMode !== 'survey' && applySurveyFilterFromCache(effectiveMode)) {
    bindDeepAuditUnload(false)
    lbDeepRefresh = false
    lbLoading = false
    if (effectiveMode === 'mine' && maybeAutoRefreshEmptyPastOpponents()) return
    if (!background) renderLeaderboard()
    return
  }
  if (!force && key && applyBoardCache(key)) {
    bindDeepAuditUnload(false)
    lbDeepRefresh = false
    lbLoading = false
    if (effectiveMode === 'mine' && maybeAutoRefreshEmptyPastOpponents()) return
    if (!background) renderLeaderboard()
    if (bridgeSiteSurvey || bridgeFederatedBoard) {
      if (lbMeta?.hasRatedGame != null) siteHasRatedGame = !!lbMeta.hasRatedGame
    } else {
      requestSurveyStatus()
    }
    return
  }
  const isSiteAll = isSiteSurveyAllSurface()
  if (isSiteAll && !force && loadSiteSurveyCache()) {
    lbLoading = false
    if (!background) renderLeaderboard()
  }
  if (!background) {
    if (isSiteAll) {
      lbLoading = !Array.isArray(lbMeta?.games) || !lbMeta.games.length
      if (!force && !lbMeta?.games?.length) {
        lbEntries = []
        lbMeta = null
      }
    } else {
      lbLoading = true
      // Keep the previous board visible during Refresh so rank-by / filter controls stay
      // useful while a new crawl runs; mode switches still clear (force is false).
      if (!force) {
        lbEntries = []
        lbMeta = null
      }
    }
    renderLeaderboard()
  } else {
    lbLoading = true
    renderLeaderboard()
  }
  const warnUnload =
    lbLoading &&
    (lbDeepRefresh || (effectiveMode === 'survey' && viewKind === 'federatedLeaderboard'))
  bindDeepAuditUnload(warnUnload)
  if (bridgeSiteSurvey || bridgeFederatedBoard) {
    if (lbMeta?.hasRatedGame != null) siteHasRatedGame = !!lbMeta.hasRatedGame
    else checkingRatedStatus = false
  } else {
    requestSurveyStatus()
  }
  shellMessenger()?.buildLeaderboard({
    mode: effectiveMode,
    survey,
    seq,
    deepRecompute: effectiveMode === 'survey' ? deepRecompute : false,
    localCheckpoint: indexedDbMemory.meta?.checkpoint || null,
    localPlayers: indexedDbMemory.players,
    ...(neighborhoodExtras.length ? { extraNeighborhoodSites: neighborhoodExtras } : {}),
    ...(effectiveMode === 'survey' ? { hopGraph: readNeighborhoodHopGraph() } : {}),
    ...federationIndexedDbPayload(),
  })
}

let pendingSiteSurveyRetryTimer = null

function schedulePendingSiteSurveyRetry() {
  if (pendingSiteSurveyRetryTimer != null) return
  pendingSiteSurveyRetryTimer = window.setTimeout(() => {
    pendingSiteSurveyRetryTimer = null
    if (viewKind !== 'siteSurvey' || !isLeaderboardPageVisible()) return
    const needsRetry = lbLoading || lbMeta?.unavailable
    if (!needsRetry) return
    if (ctx?.pwaBridgeActive || canRequestShellSurveyFetch()) {
      requestBoard({ force: true })
    } else if (isInAppSurveySurface() && !ctx?.wikiFrame) {
      schedulePendingSiteSurveyRetry()
    }
  }, 600)
}

function leaderboardPage() {
  return typeof document !== 'undefined' ? document.getElementById('leaderboard') : null
}

function isLeaderboardPageVisible() {
  const root = leaderboardPage()
  if (!root) return false
  if (root.classList.contains('wiki-page-active')) return true
  return root.style.display === 'block'
}

function el(id) {
  return typeof document !== 'undefined' ? document.getElementById(id) : null
}

function syncReachModeButtons() {
  const modes = el('wikiChessLbModes')
  if (!modes) return
  const hideNeighborhood = isInAppSurveySurface()
  for (const btn of modes.querySelectorAll('[data-lb-reach]')) {
    const reach = btn.getAttribute('data-lb-reach')
    if (reach === 'neighborhood') btn.hidden = hideNeighborhood
    const active = reach === mode
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-pressed', String(active))
  }
  if (hideNeighborhood && mode === 'neighborhood') {
    mode = 'survey'
  }
}

function siteSurveySeekEntry(itemId) {
  const id = String(itemId || '').trim()
  if (!id) return null
  const filtered = filterOpenChallengesByBlockList(
    Array.isArray(lbMeta?.openChallenges) ? lbMeta.openChallenges : [],
    lbMeta?.blockList || indexedDbMemory.meta?.blockList,
  )
  const { acceptedMine, mine, joinable, directedAtMe } = partitionOpenChallenges(filtered, {
    viewingSite: ctx?.viewingSite?.() || lbMeta?.site || '',
    viewerRating: ctx?.viewerRating?.(),
    acceptedGhosts: lbMeta?.acceptedGhosts || [],
    isAuthenticatedOwner: Boolean(ctx?.isAuthenticatedOwner?.()),
  })
  return [...acceptedMine, ...directedAtMe, ...mine, ...joinable].find(row => String(row?.itemId || '') === id) || null
}

export function wireLeaderboardView() {
  const root = leaderboardPage()
  if (!root) return
  installAuthGatedClickGuard(root)
  syncReachModeButtons()
  leaderboardUi?.ensureLeaderboardTableHead?.()

  if (lbWired) {
    renderLeaderboard()
    return
  }
  lbWired = true
  for (const btn of root.querySelectorAll('[data-lb-reach]')) {
    btn.addEventListener('click', () => {
      const reach = btn.getAttribute('data-lb-reach')
      const next = reach === 'mine' ? 'mine' : reach === 'neighborhood' ? 'neighborhood' : 'survey'
      if (viewKind !== 'federatedLeaderboard' || next === mode) return
      mode = next
      leaderboardUi?.cancelScheduledHopGraphRecrawl?.()
      if (mode === 'survey' && !survey) survey = DEFAULT_SURVEY_ID
      // Apply the view filter before painting — otherwise Neighborhood / Past opponents
      // briefly (or permanently) show the previous reach's rows.
      if (mode === 'survey') {
        const painted = applyBoardCache('survey') || applySurveyFilterFromCache('survey') || primeBoardFromIndexedDb()
        if (painted) {
          // Keep the cached board; do not auto-kick a hop-bounded crawl (user hits Refresh /
          // dials). Background sync on this path was aborting in-flight walks.
          syncReachModeButtons()
          renderLeaderboard()
          return
        }
        requestBoard({ force: true })
      } else if (!applySurveyFilterFromCache(mode)) {
        requestBoard()
      } else if (mode === 'mine' && maybeAutoRefreshEmptyPastOpponents()) {
        syncReachModeButtons()
        return
      }
      syncReachModeButtons()
      renderLeaderboard()
    })
  }
  el('wikiChessLbReliable')?.addEventListener('change', e => {
    reliableOnly = !!e.target.checked
    renderLeaderboard()
  })
  el('wikiChessLbRefresh')?.addEventListener('click', () => {
    leaderboardUi?.cancelScheduledHopGraphRecrawl?.()
    // Soft refresh: past opponents re-read this site only; visible federation uses checkpoints.
    requestBoard({
      force: true,
      restart: true,
      deepRecompute: false,
      syncSurvey: mode === 'survey',
      refreshOpenChallenges: isSiteSurveyAllSurface(),
    })
  })
  el('wikiChessLbAddOpponents')?.addEventListener('click', () => leaderboardUi?.addPastOpponentsToNeighborhood?.())
  el('wikiChessLbAddPeers')?.addEventListener('click', () => leaderboardUi?.addFarmPeersToNeighborhood?.())
  leaderboardUi?.wireHopGraphDials?.()
  el('wikiChessLbBack')?.addEventListener('click', () => {
    closeActiveModal({ discardSuspended: true, restoreMount: false })
    if (chooseMenuSurveyBrowse) resetChooseMenuSurveyBrowse()
    if (fromSurveyItem) fromSurveyItem = false
    ctx?.returnToStartMenu?.()
  })
  el('wikiChessLbGames')?.addEventListener('click', e => {
    // A click that ends a drag-to-select gesture keeps the selection instead of
    // navigating away (mousedown collapses any earlier selection, so a non-collapsed
    // selection inside the list here can only come from the drag that just ended).
    const selection = window.getSelection?.()
    if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return
    // Shift+click matches FedWiki [[links]]: append to the lineup instead of replacing
    // pages to the right of My Chess Games (wiki.doInternalLink with a null $page).
    const append = Boolean(e.shiftKey)
    const seekLink = e.target.closest?.('[data-ch-item-id]')
    if (seekLink) {
      const itemId = seekLink.getAttribute('data-ch-item-id') || ''
      const entry = siteSurveySeekEntry(itemId)
      if (seekLink.getAttribute('data-ch-accepted') === 'true') {
        if (entry) dispatchOpenChallengeSeekClick(seekLink, entry, { append })
        return
      }
      if (seekLink.getAttribute('data-ch-own') === 'true') {
        if (entry) openOwnOpenChallengeModal(entry)
        return
      }
      if (seekLink.getAttribute('data-ch-joinable') === 'true' && entry) {
        dispatchOpenChallengeSeekClick(seekLink, entry, { append })
      }
      return
    }
    const link = e.target.closest?.('[data-game-slug]')
    if (!link) return
    e.preventDefault()
    const slug = link.getAttribute('data-game-slug')
    const host = link.getAttribute('data-game-host') || ''
    const itemId = link.getAttribute('data-game-item-id') || ''
    const title = link.getAttribute('data-game-title') || ''
    if (!slug) return
    ctx?.clearBrowseStartMenuState?.()
    shellMessenger()?.openGamePage({
      slug,
      ...(host ? { site: host } : {}),
      ...(itemId ? { itemId } : {}),
      ...(title ? { title } : {}),
      ...(append ? { append: true } : {}),
    })
  })
  const head = el('wikiChessLbHead')
  head?.addEventListener('click', e => {
    if (e.target.closest?.('.wiki-chess-lb-player-search')) return
    const btn = e.target.closest?.('[data-lb-sort]')
    if (!btn) return
    const next = btn.getAttribute('data-lb-sort') || DEFAULT_SORT.column
    if (next === sortColumn) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      sortColumn = next
      category = next
      sortDir = columnPreferredSortDir(next)
    }
    renderLeaderboard()
  })
  head?.addEventListener('input', e => {
    const input = e.target.closest?.('[data-lb-filter="player"]')
    if (!input) return
    const value = String(input.value || '')
    if (value.trim()) columnFilters.player = value
    else delete columnFilters.player
    input.closest?.('.wiki-chess-lb-player-search')?.classList.toggle('has-value', Boolean(value.trim()))
    renderLeaderboard()
  })
  head?.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    const input = e.target.closest?.('[data-lb-filter="player"]')
    if (!input) return
    e.preventDefault()
    e.stopPropagation()
    if (input.value) {
      input.value = ''
      delete columnFilters.player
      input.closest?.('.wiki-chess-lb-player-search')?.classList.remove('has-value')
      renderLeaderboard()
    }
    input.blur()
  })
  leaderboardUi?.wireLeaderboardTableResize?.()
}

export function isOnLeaderboardPluginPage() {
  const slug = String(ctx?.chessState?.wikiPageName || '')
    .trim()
    .toLowerCase()
  const title = String(ctx?.chessState?.wikiPageTitle || '').trim()
  if (!slug && !title) return true
  if (isLeaderboardPageSlug(slug)) return true
  return title ? pageSlug(title) === LEADERBOARD_PAGE_SLUG : false
}

function shouldShowMyChessGamesBack() {
  // PWA / popup always open leaderboards from the choose menu — keep Back to menu.
  if (isInAppSurveySurface()) return true
  // Bare LEADERBOARD on the Chess Leaderboards plugin page is the landing view — no menu to return to.
  if (viewKind === 'federatedLeaderboard' && isOnLeaderboardPluginPage() && !lbMeta?.wrongPage) return false
  if (viewKind !== 'siteSurvey' || siteProbeKind !== 'all') return true
  if (chooseMenuSurveyBrowse) return true
  return !fromSurveyItem
}

function reconcileSurveyNavButtons(isAllProbe) {
  const backBtn = el('wikiChessLbBack')
  const refresh = el('wikiChessLbRefresh')
  const addOpponents = el('wikiChessLbAddOpponents')
  const topActions = el('wikiChessLbActions')
  const siteActions = el('wikiChessLbSiteSurveyActions')
  if (!topActions || !siteActions) return

  siteActions.hidden = !isAllProbe
  topActions.hidden = isAllProbe

  if (isAllProbe) {
    if (backBtn && backBtn.parentElement !== siteActions) {
      siteActions.insertBefore(backBtn, siteActions.firstChild)
    }
    if (refresh && refresh.parentElement !== siteActions) {
      const surveyAction = siteActions.querySelector('[data-survey-action]')
      if (surveyAction) siteActions.insertBefore(refresh, surveyAction)
      else siteActions.appendChild(refresh)
    }
    if (addOpponents) addOpponents.hidden = true
    return
  }

  if (backBtn && backBtn.parentElement !== topActions) {
    topActions.insertBefore(backBtn, topActions.firstChild)
  }
  const refreshHome = topActions.querySelector('.wiki-chess-lb-actions-center') || topActions
  if (refresh && refresh.parentElement !== refreshHome) {
    const updating = el('wikiChessLbUpdating')
    if (updating && updating.parentElement === refreshHome) {
      refreshHome.insertBefore(refresh, updating)
    } else {
      refreshHome.insertBefore(refresh, refreshHome.firstChild)
    }
  }
  // Add-opponents stays under the view filters (not in the top nav row).
}

export function renderLeaderboard() {
  const root = leaderboardPage()
  if (!root) return
  if (!isLeaderboardPageVisible()) return
  ensureSeatKingSpritesThenRefresh()
  const isSite = viewKind === 'siteSurvey'
  const isUnratedProbe = isSite && siteProbeKind === 'unrated'
  const isAllProbe = isSite && siteProbeKind === 'all'

  const statusEl = el('wikiChessLbStatus')
  if (statusEl) {
    statusEl.classList.toggle('is-loading', lbLoading)
    if (lbLoading) statusEl.setAttribute('aria-busy', 'true')
    else statusEl.removeAttribute('aria-busy')
  }

  const heading = el('wikiChessLbHeading')
  if (heading) {
    if (isSite) {
      heading.textContent = isAllProbe ? 'My Chess Games' : isUnratedProbe ? 'Unrated Games' : 'Rated Games'
    } else {
      heading.innerHTML = `<i class="fas fa-trophy fa-fw" aria-hidden="true"></i> ${LEADERBOARD_PAGE_TITLE}`
    }
  }
  const modes = el('wikiChessLbModes')
  if (modes) modes.hidden = isSite || lbMeta?.wrongPage
  const siteIntro = el('wikiChessLbSiteIntro')
  if (siteIntro) {
    siteIntro.hidden = !isSite || isAllProbe
    if (isSite && !isAllProbe) {
      siteIntro.textContent = isUnratedProbe
        ? 'Every unrated game published on this site — newest first, each linking to the page where it was played. Unrated games never affect ratings or appear on the federated leaderboards.'
        : 'Every rated game published on this site — newest first, each linking to the page where it was played. These are the games other wikis rank on the federated leaderboards. Fork this page onto your own site and include a SURVEY item to take part.'
    }
  }
  const controls = el('wikiChessLbControls')
  if (controls) controls.hidden = isSite || lbMeta?.wrongPage

  const backBtn = el('wikiChessLbBack')
  if (backBtn) backBtn.hidden = !shouldShowMyChessGamesBack()

  const lbMyGames = el('wikiChessLbMyGames')
  // In-app surfaces (PWA / popup) already expose "Back to menu" — skip the wiki lineup link.
  if (lbMyGames) {
    lbMyGames.classList.toggle('d-none', !isPrimaryEmbedSurface() || isInAppSurveySurface())
  }

  const lbOpenPage = el('wikiChessLbOpenPage')
  if (lbOpenPage) {
    const showLbOpenPage = isPrimaryEmbedSurface() && !!lbMeta?.wrongPage
    lbOpenPage.classList.toggle('d-none', !showLbOpenPage)
    lbOpenPage.classList.toggle('btn-primary', showLbOpenPage)
    lbOpenPage.classList.toggle('btn-outline-primary', !showLbOpenPage)
  }

  reconcileSurveyNavButtons(isAllProbe)
  leaderboardUi?.renderHopGraphPanel?.()
  leaderboardUi?.renderAddOpponentsToNeighborhoodButton?.()
  leaderboardUi?.renderAddPeersToNeighborhoodButton?.()
  renderSiteSurveyActions()
  leaderboardUi?.renderLbUpdating?.()

  leaderboardUi?.renderLbControls?.()
  renderLbStatus()
  leaderboardUi?.renderStanding?.()
  leaderboardUi?.renderLbTable?.()
  renderGames()
  renderSurveyUpdate()
  ctx?.notifyWikiHeight?.()
  if (ctx?.wikiFrame && !ctx?.followsPopup) {
    const warnUnload =
      lbLoading &&
      (lbDeepRefresh || (viewKind === 'federatedLeaderboard' && (mode === 'survey' || !!lbProgress?.hopGraph)))
    shellMessenger()?.fetchUi({ loading: lbLoading, deep: lbDeepRefresh, warnUnload })
  }
}

function renderIslandNotice() {
  const notice = el('wikiChessLbIslandNotice')
  if (!notice) return
  const isAllProbe = viewKind === 'siteSurvey' && siteProbeKind === 'all'
  const island = lbMeta?.island || indexedDbMemory.meta?.island
  if (!isAllProbe || !shouldShowIslandNotice(island)) {
    notice.hidden = true
    notice.textContent = ''
    return
  }
  const state = String(island?.state || '').trim()
  notice.hidden = false
  notice.textContent =
    state === 'isolated'
      ? 'Your rating pool looks disconnected from the wider federation — ratings here may only reflect this island.'
      : 'The federation pool you are connected to may have shifted — cross-wiki ratings may not match peers yet.'
}

function formatCrawlDuration(ms) {
  const sec = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`
  const min = Math.floor(sec / 60)
  const rem = Math.round(sec % 60)
  return rem ? `${min}m ${rem}s` : `${min}m`
}

function renderSurveyUpdate() {
  const wrap = el('wikiChessLbSurveyUpdate')
  if (!wrap) return
  const isFederated = viewKind === 'federatedLeaderboard' && mode === 'survey'
  // Keep the leave-open line for the whole Visible-federation crawl, even if the user
  // switches to Past opponents / Neighborhood while it runs.
  const surveyCrawlInFlight = lbLoading && notifySurveyCrawlOnComplete
  if (!isFederated && !surveyCrawlInFlight) {
    wrap.hidden = true
    wrap.replaceChildren()
    return
  }

  if (surveyCrawlInFlight || (lbLoading && isFederated)) {
    const hostsDone = Math.max(0, Number(lbProgress?.hostIndex) || 0)
    const hostTotal = Math.max(hostsDone, Number(lbProgress?.hostTotal) || 0)
    const gamesFound = Math.max(0, Number(lbProgress?.gamesFound) || 0)
    const eta = formatCrawlEtaLabel(lbProgress?.elapsedMs, hostsDone, hostTotal)
    const stats = lbProgress?.crawlStats || {}
    const cacheHits = Math.max(0, Number(stats.cacheHits) || 0)
    const parts = [
      hostTotal > 0 ? `Sites ${hostsDone}/${hostTotal}` : null,
      gamesFound ? `${gamesFound} games found` : null,
      cacheHits ? `${cacheHits} cache hit${cacheHits === 1 ? '' : 's'}` : null,
      eta || null,
    ].filter(Boolean)
    wrap.hidden = false
    wrap.textContent = (parts.length ? `${parts.join(' · ')}. ` : '') + SURVEY_CRAWL_KEEP_OPEN_HINT
    return
  }

  const stats = lbMeta?.crawlStats || null
  const timing = lbMeta?.timing || null
  if (!stats && !timing) {
    wrap.hidden = true
    wrap.replaceChildren()
    return
  }
  const hits = resolveCrawlHits()
  const sites = Math.max(
    0,
    hits.sites.length || Number(lbMeta?.crawled) || Number(stats?.sitesCrawled) || 0,
  )
  const games = Math.max(0, hits.games.length || Number(timing?.gamesFetched) || 0)
  const cacheHits = Math.max(
    0,
    hits.cacheHitSites.length || Number(stats?.cacheHits) || 0,
  )
  const pagesFetched = Math.max(0, Number(stats?.pagesFetched) || 0)
  const duration = timing?.totalMs != null ? formatCrawlDuration(timing.totalMs) : ''
  const parts = []
  if (sites) {
    parts.push(
      crawlStatLink({
        kind: 'sites',
        label: `${sites} site${sites === 1 ? '' : 's'} crawled`,
        enabled: hits.sites.length > 0 && canShowCrawlHitsGhost(),
      }),
    )
  }
  if (games) {
    parts.push(
      crawlStatLink({
        kind: 'games',
        label: `${games} game${games === 1 ? '' : 's'} found`,
        enabled: hits.games.length > 0 && canShowCrawlHitsGhost(),
      }),
    )
  }
  if (cacheHits) {
    parts.push(
      crawlStatLink({
        kind: 'cache',
        label: `${cacheHits} site${cacheHits === 1 ? '' : 's'} reused from cache`,
        enabled: hits.cacheHitSites.length > 0 && canShowCrawlHitsGhost(),
      }),
    )
  }
  if (pagesFetched) parts.push(document.createTextNode(`${pagesFetched} page${pagesFetched === 1 ? '' : 's'} fetched`))
  if (duration) parts.push(document.createTextNode(`in ${duration}`))
  if (!parts.length) {
    wrap.hidden = true
    wrap.replaceChildren()
    return
  }
  wrap.hidden = false
  wrap.replaceChildren()
  wrap.append(document.createTextNode('Last crawl: '))
  parts.forEach((part, i) => {
    if (i) wrap.append(document.createTextNode(' · '))
    wrap.append(part)
  })
  wrap.append(document.createTextNode('.'))
}

function canShowCrawlHitsGhost() {
  return Boolean(ctx?.wikiFrame && !isInAppSurveySurface())
}

function resolveCrawlHits() {
  const raw = lbMeta?.crawlHits
  if (raw && typeof raw === 'object') {
    return {
      sites: Array.isArray(raw.sites) ? raw.sites.map(cleanSite).filter(Boolean) : [],
      cacheHitSites: Array.isArray(raw.cacheHitSites) ? raw.cacheHitSites.map(cleanSite).filter(Boolean) : [],
      games: Array.isArray(raw.games) ? raw.games : [],
    }
  }
  const sites = Array.isArray(lbMeta?.crawledSites)
    ? lbMeta.crawledSites
    : Array.isArray(lbMeta?.listed)
      ? lbMeta.listed
      : []
  return buildCrawlHits({
    sites,
    cacheHitSites: lbMeta?.crawlStats?.cacheHitSites,
    siteCrawlCache: lbMeta?.siteCrawlCache || indexedDbMemory.meta?.siteCrawlCache,
  })
}

function crawlStatLink({ kind, label, enabled }) {
  if (!enabled) return document.createTextNode(label)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn btn-link btn-sm p-0 align-baseline wiki-chess-lb-crawl-stat-link'
  btn.textContent = label
  btn.title = 'Open a ghost page listing these crawl hits'
  btn.addEventListener('click', () => openCrawlHitsGhost(kind))
  return btn
}

function openCrawlHitsGhost(kind) {
  if (!canShowCrawlHitsGhost()) return
  const hits = resolveCrawlHits()
  let title = 'Crawl hits'
  let intro = ''
  let references = []
  if (kind === 'games') {
    references = crawlHitGameReferences(hits.games)
    title = `Games found (${references.length})`
    intro = `Chess game pages discovered in the last Visible federation crawl (${references.length}).`
  } else if (kind === 'cache') {
    references = crawlHitSiteReferences(hits.cacheHitSites)
    title = `Sites reused from cache (${references.length})`
    intro = `Sites whose sitemap cache was reused in the last Visible federation crawl (${references.length}).`
  } else {
    references = crawlHitSiteReferences(hits.sites)
    title = `Sites crawled (${references.length})`
    intro = `Wiki sites visited in the last Visible federation crawl (${references.length}).`
  }
  if (!references.length) return
  shellMessenger()?.showCrawlHitsPage({ title, intro, references })
}

function renderSiteSurveyActions() {
  const siteActions = el('wikiChessLbSiteSurveyActions')
  if (!siteActions) return
  // My Chess Games site survey — spawns the standard CHOOSE-menu ghost (same as a CHOOSE item).
  // Wiki iframe / shell only: the installed PWA uses Post open challenge instead.
  const hide =
    isInAppSurveySurface() || !canShowSiteSurveyActions() || viewKind !== 'siteSurvey' || siteProbeKind !== 'all'
  if (hide) {
    for (const btn of siteActions.querySelectorAll('[data-survey-action]')) {
      btn.remove()
    }
    return
  }

  const canCreate = !!ctx?.wikiFrame && !ctx?.followsPopup
  const canPublish = !!ctx?.canPublish?.()
  // Reuse the existing button so progressive open-challenge re-renders do not drop :hover.
  let btn = siteActions.querySelector('[data-survey-action="new-chess-page"]')
  if (!btn) {
    btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.surveyAction = 'new-chess-page'
    btn.className = 'btn btn-sm btn-outline-primary wiki-chess-action-btn'
    btn.innerHTML = '<i class="fas fa-plus fa-fw" aria-hidden="true"></i> New Chess Page'
    btn.addEventListener('click', () => ctx.createChooseMenuGhostPage?.(showSurveyNewPageFailed))
    siteActions.appendChild(btn)
  }
  btn.disabled = !canCreate
  btn.title = !canCreate
    ? 'Open My Chess Games on your wiki to add a new chess page.'
    : canPublish
      ? 'Open a new page that starts with the usual CHOOSE menu.'
      : 'Preview a new chess page below; sign in when you are ready to fork it into your wiki.'
}

// # Open Challenges Lobby

function siteSurveyOpenChallengeRows() {
  const openChallengesRaw = Array.isArray(lbMeta?.openChallenges) ? lbMeta.openChallenges : []
  const openChallengesFiltered = filterOpenChallengesByBlockList(
    openChallengesRaw,
    lbMeta?.blockList || indexedDbMemory.meta?.blockList,
  )
  const {
    joinable: seekJoinable,
    mine: seekMine,
    acceptedMine: seekAccepted,
    directedAtMe: seekDirected,
  } = partitionOpenChallenges(openChallengesFiltered, {
    viewingSite: ctx?.viewingSite?.() || lbMeta?.site || '',
    viewerRating: ctx?.viewerRating?.(),
    acceptedGhosts: lbMeta?.acceptedGhosts || [],
    isAuthenticatedOwner: Boolean(ctx?.isAuthenticatedOwner?.()),
  })
  return [...seekAccepted, ...seekDirected, ...seekMine, ...seekJoinable]
}

// Update only the Open challenges section — used by progressive crawl fills.
function renderSiteSurveyOpenChallenges() {
  if (viewKind !== 'siteSurvey' || siteProbeKind !== 'all') return false
  const wrap = el('wikiChessLbGames')
  if (!wrap) return false
  wrap.hidden = false
  const scroll = el('wikiChessLbSectionSeeks')?.querySelector('.wiki-chess-lb-games-scroll')
  const prevScrollTop = scroll?.scrollTop ?? 0
  renderSurveySection('wikiChessLbSectionSeeks', 'wikiChessLbSeeks', 'Open challenges', siteSurveyOpenChallengeRows(), {
    kind: 'seeks',
    showWhenEmpty: true,
    emptyText: 'No open challenges found across the federation yet.',
    showPostChallenge: canShowSiteSurveyActions(),
    loading: openChallengesLoading,
    loadingText: openChallengesLoading
      ? 'Searching neighbourhood, farm peers, and past opponents for open challenges…'
      : '',
  })
  if (scroll) scroll.scrollTop = prevScrollTop
  return true
}

function renderGames() {
  const wrap = el('wikiChessLbGames')
  if (!wrap) return
  const isAllProbe = viewKind === 'siteSurvey' && siteProbeKind === 'all'
  const allGames = viewKind === 'siteSurvey' && Array.isArray(lbMeta?.games) ? lbMeta.games : []
  const activeGames = allGames.filter(g => g.active)
  const completedGames = allGames.filter(g => !g.active)
  const ratedGames = completedGames.filter(g => g.rated)
  const unratedGames = completedGames.filter(g => !g.rated)
  const games = siteProbeKind === 'unrated' ? unratedGames : siteProbeKind === 'all' ? ratedGames : ratedGames

  if (isAllProbe) {
    wrap.hidden = false
    renderIslandNotice()
    const note = el('wikiChessLbGamesNote')
    if (note) note.hidden = true
    const gamesHeading = wrap.querySelector('.wiki-chess-lb-games-heading')
    if (gamesHeading) gamesHeading.hidden = true
    renderSiteSurveyOpenChallenges()
    renderSurveySection('wikiChessLbSectionActive', 'wikiChessLbGamesActive', 'My Active Games', activeGames, {
      kind: 'games',
    })
    renderSurveySection('wikiChessLbSectionRated', 'wikiChessLbGamesRated', 'Rated games', ratedGames, {
      kind: 'games',
      showWhenEmpty: true,
      emptyText: 'No rated games on this site yet.',
    })
    renderSurveySection('wikiChessLbSectionUnrated', 'wikiChessLbGamesUnrated', 'Unrated games', unratedGames, {
      kind: 'games',
      showWhenEmpty: true,
      emptyText: 'No unrated games on this site yet.',
    })
    return
  }

  if (!activeGames.length && !games.length) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false

  const note = el('wikiChessLbGamesNote')
  if (note) {
    note.hidden = false
    note.textContent =
      activeGames.length && games.length
        ? 'Active games are in progress; completed games can be replayed from their pages.'
        : activeGames.length
          ? 'Click an active game to open it on the wiki where it lives.'
          : 'Click any game to open and replay it on the page where it was played.'
  }

  const gamesHeading = wrap.querySelector('.wiki-chess-lb-games-heading')
  if (gamesHeading) {
    gamesHeading.hidden = false
    gamesHeading.textContent = siteProbeKind === 'unrated' ? 'Your unrated games' : 'Your games'
  }

  for (const sectionId of [
    'wikiChessLbSectionSeeks',
    'wikiChessLbSectionActive',
    'wikiChessLbSectionRated',
    'wikiChessLbSectionUnrated',
  ]) {
    el(sectionId)?.setAttribute('hidden', '')
  }

  renderSurveySection('wikiChessLbSectionActive', 'wikiChessLbGamesActive', 'My Active Games', activeGames, {
    kind: 'games',
  })
  if (siteProbeKind === 'unrated') {
    renderSurveySection('wikiChessLbSectionUnrated', 'wikiChessLbGamesUnrated', 'Unrated games', games, {
      kind: 'games',
    })
  } else {
    renderSurveySection('wikiChessLbSectionRated', 'wikiChessLbGamesRated', 'Rated games', games, { kind: 'games' })
  }
}

function createPostOpenChallengeButton() {
  const canPost = canPostOpenChallenge()
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn btn-sm btn-outline-primary wiki-chess-action-btn'
  btn.innerHTML = '<i class="fas fa-plus fa-fw" aria-hidden="true"></i> Post challenge'
  setAuthGatedButton(btn, canPost, {
    titleWhenDisabled: 'Sign in on your wiki to post an open challenge.',
  })
  btn.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    if (!canPostOpenChallenge()) return
    ctx?.startOpenChallengeSetup?.('survey')
  })
  return btn
}

function renderPostChallengeInHeader(summary) {
  if (summary.querySelector('.wiki-chess-lb-survey-section-post')) return
  const wrap = document.createElement('span')
  wrap.className = 'wiki-chess-lb-survey-section-post'
  wrap.appendChild(createPostOpenChallengeButton())
  summary.appendChild(wrap)
}

function renderSurveySection(
  sectionId,
  listId,
  label,
  rows,
  {
    kind = 'games',
    showWhenEmpty = false,
    emptyText = '',
    showPostChallenge = false,
    defaultOpen = true,
    loading = false,
    loadingText = '',
  } = {},
) {
  const section = el(sectionId)
  const list = el(listId)
  if (!section || !list) return
  rememberSurveySectionOpen(sectionId)
  wireSurveySectionDetails(sectionId)
  const summary = section.querySelector('.wiki-chess-lb-survey-section-heading') || section.querySelector('summary')
  const scroll = section.querySelector('.wiki-chess-lb-games-scroll')
  const has = Array.isArray(rows) && rows.length > 0
  section.hidden = !has && !showWhenEmpty && !showPostChallenge && !loading
  list.replaceChildren()
  scroll?.querySelector('.wiki-chess-lb-survey-empty')?.remove()
  scroll?.querySelector('.wiki-chess-lb-survey-loading')?.remove()
  if (showPostChallenge && kind === 'seeks' && summary) renderPostChallengeInHeader(summary)
  else summary?.querySelector('.wiki-chess-lb-survey-section-post')?.remove()
  updateSurveySectionHeading(section, label, has ? rows.length : 0)
  if (has) {
    if (kind === 'seeks') {
      for (const row of rows) list.appendChild(siteSeekRowFor(row))
    } else {
      for (const g of rows) {
        const li = document.createElement('li')
        li.className = 'wiki-chess-lb-game-row'
        li.appendChild(gameLinkFor(g))
        list.appendChild(li)
      }
    }
  }
  if (loading && loadingText && scroll) {
    const loadingEl = document.createElement('p')
    loadingEl.className = 'wiki-chess-lb-survey-loading text-muted small mb-0'
    loadingEl.setAttribute('aria-live', 'polite')
    loadingEl.setAttribute('aria-busy', 'true')
    loadingEl.innerHTML = `<i class="fas fa-spinner fa-spin fa-fw" aria-hidden="true"></i> ${loadingText}`
    // Keep above the rows so progressive fills don't bury the status under the fold.
    scroll.insertBefore(loadingEl, list)
    restoreSurveySectionOpen(sectionId, { defaultOpen })
    return
  }
  if (!has) {
    if (showWhenEmpty && emptyText && scroll) {
      const empty = document.createElement('p')
      empty.className = 'wiki-chess-lb-survey-empty text-muted small mb-0'
      empty.textContent = emptyText
      scroll.appendChild(empty)
    }
    restoreSurveySectionOpen(sectionId, { defaultOpen })
    return
  }
  restoreSurveySectionOpen(sectionId, { defaultOpen })
}

function gameOpponentLabel(g) {
  const name = String(g.opponentName || '').trim()
  const host = String(g.opponent || '').trim()
  if (name) return name
  if (host) return host
  return ''
}

function gamePrimaryLabel(g) {
  const title = String(g.title || '').trim()
  const opp = gameOpponentLabel(g)
  if (!opp) return title || 'Game'
  if (!title) return `vs ${opp}`
  if (title.toLowerCase().includes(opp.toLowerCase())) return title
  return `${title} vs ${opp}`
}

function boardSeatLabels(g) {
  let white = String(g.whiteLabel || '').trim()
  let black = String(g.blackLabel || '').trim()
  let whiteTag = ''
  let blackTag = ''
  const pgn = g.pgn
  if (pgn) {
    whiteTag = getPgnTag(pgn, 'White') || ''
    blackTag = getPgnTag(pgn, 'Black') || ''
    if (!white) white = formatPlayerDisplayLabel(whiteTag) || ''
    if (!black) black = formatPlayerDisplayLabel(blackTag) || ''
  }
  return { white, black, whiteTag, blackTag }
}

function appendPlayerNameEl(parent, label, rawTag) {
  parent.className = 'wiki-chess-lb-game-seat-name'
  const parsed = rawTag ? parsePlayerId(rawTag) : null
  const engineLevel = parseStockfishLevel(parsed?.isEngine ? parsed.username : label)
  if (engineLevel != null) {
    parent.append('Stockfish ')
    const detail = document.createElement('span')
    detail.className = 'wiki-chess-wiki-site-label'
    detail.textContent = `Level ${engineLevel} (${stockfishLevelElo(engineLevel)})`
    parent.appendChild(detail)
    return
  }
  if (parsed?.domain && !parsed.isEngine) {
    parent.append(`${parsed.username} `)
    const domain = document.createElement('span')
    domain.className = 'wiki-chess-wiki-site-label'
    domain.textContent = wikiSiteLinkLabel(parsed.domain)
    parent.appendChild(domain)
    return
  }
  parent.textContent = label
}

function appendGamePlayers(text, g) {
  const { white, black, whiteTag, blackTag } = boardSeatLabels(g)
  if (white || black) {
    const players = document.createElement('span')
    players.className = 'wiki-chess-lb-game-players'
    players.setAttribute('role', 'group')
    players.setAttribute('aria-label', 'Players')
    const result = String(g.result || '').trim()
    const winnerColor = !g.active && result === WHITE_WIN ? 'w' : !g.active && result === BLACK_WIN ? 'b' : null

    for (const [label, colorName, colorChar, rawTag] of [
      [white, 'White', 'w', whiteTag],
      [black, 'Black', 'b', blackTag],
    ]) {
      if (!label) continue
      const row = document.createElement('span')
      row.className = 'wiki-chess-lb-game-seat-row'
      const tag = document.createElement('span')
      tag.className = 'wiki-chess-lb-game-seat-tag'
      tag.setAttribute('aria-label', colorName)
      const kingHtml = ctx?.seatKingPreviewHtml?.(colorChar)
      if (kingHtml) tag.innerHTML = kingHtml
      else tag.textContent = colorName === 'Black' ? '♚' : '♔'
      const name = document.createElement('span')
      appendPlayerNameEl(name, label, rawTag)
      row.append(tag, name)
      if (winnerColor && colorChar === winnerColor) {
        const winner = document.createElement('span')
        winner.className = 'wiki-chess-lb-game-winner'
        winner.textContent = 'Winner!'
        row.appendChild(winner)
      }
      players.appendChild(row)
    }

    text.appendChild(players)
    return
  }
  const opp = document.createElement('span')
  opp.className = 'wiki-chess-lb-game-opp'
  opp.textContent = gamePrimaryLabel(g)
  text.appendChild(opp)
}

function appendGameMeta(text, g) {
  const sub = document.createElement('span')
  sub.className = 'wiki-chess-lb-game-sub'
  if (g.creatorForkBackPending) {
    sub.classList.add('text-muted')
    sub.textContent = `accepted on ${g.site} — fork their copy to play`
    text.appendChild(sub)
    return
  }
  const metaLine = formatGameRowMetaLine({ ...g, includeRated: false })
  if (metaLine) {
    const metaEl = document.createElement('span')
    metaEl.className = 'wiki-chess-lb-game-meta'
    metaEl.textContent = metaLine
    sub.appendChild(metaEl)
  }
  if (sub.childNodes.length) text.appendChild(sub)
}

// PGN Date "YYYY.MM.DD" → compact list label "YY-MM-DD".
function formatGameDateShort(date) {
  const m = String(date || '')
    .trim()
    .match(/^(\d{4})\.(\d{2})\.(\d{2})$/)
  if (!m) return String(date || '').trim()
  return `${m[1].slice(-2)}-${m[2]}-${m[3]}`
}

function formatLocalDateShort(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function gameEndInstant(g) {
  const endRaw =
    (g.pgn ? getPgnTag(g.pgn, 'TerminationTimestamp') : '') || g.terminationTimestamp || ''
  const endMs = Date.parse(String(endRaw).trim())
  return Number.isFinite(endMs) ? new Date(endMs) : null
}

// Compact labels under the badge: start (+ end when TerminationTimestamp is known).
// Same local calendar day collapses to one line; hover still carries both instants.
function gameDateLabelParts(g) {
  const utcDate = g.utcDate || (g.pgn ? getPgnTag(g.pgn, 'UTCDate') : '') || ''
  const utcTime = g.utcTime || (g.pgn ? getPgnTag(g.pgn, 'UTCTime') : '') || ''
  const start = gameStartInstant({ utcDate, utcTime })
  let startShort = start ? formatLocalDateShort(start) : ''
  if (!startShort) {
    const date = String(g.date || '').trim()
    if (date) startShort = formatGameDateShort(date)
    else if (utcDate) startShort = formatGameDateShort(utcDate)
  }
  const end = gameEndInstant(g)
  const endShort = end ? formatLocalDateShort(end) : ''
  if (startShort && endShort && startShort !== endShort) return { startShort, endShort }
  return { startShort: startShort || endShort, endShort: '' }
}

// Hover details for the date column: full start/end instants when the PGN carries them.
function gameDateHoverTitle(g) {
  const lines = []
  const utcDate = g.utcDate || (g.pgn ? getPgnTag(g.pgn, 'UTCDate') : '') || ''
  const utcTime = g.utcTime || (g.pgn ? getPgnTag(g.pgn, 'UTCTime') : '') || ''
  const start = gameStartInstant({ utcDate, utcTime })
  if (start) {
    lines.push(`Started: ${formatLocalISO8601(start)}`)
  } else {
    const date = String(g.date || '').trim()
    if (date) lines.push(`Started: ${date}`)
  }
  const end = gameEndInstant(g)
  if (end) lines.push(`Ended: ${formatLocalISO8601(end)}`)
  return lines.join('\n')
}

function gameLinkFor(g) {
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'wiki-chess-lb-game-link'
  link.setAttribute('data-game-slug', g.slug || '')
  if (g.site) link.setAttribute('data-game-host', g.site)
  if (g.itemId) link.setAttribute('data-game-item-id', g.itemId)
  if (g.title) link.setAttribute('data-game-title', g.title)
  if (!g.slug) link.disabled = true

  const body = document.createElement('span')
  body.className = 'wiki-chess-lb-game-body'

  const result = document.createElement('span')
  const score = g.score
  if (g.syncPending) {
    const outcome = score === 1 ? 'win' : score === 0 ? 'loss' : score === 0.5 ? 'draw' : 'open'
    result.className = `wiki-chess-lb-game-result is-pending is-${outcome}`
    result.textContent = 'Sync'
    result.title = "Finished on opponent's wiki — fork the result to close your copy"
  } else if (g.active) {
    result.className = `wiki-chess-lb-game-result ${g.creatorForkBackPending ? 'is-draw' : 'is-open'}`
    result.textContent = g.creatorForkBackPending ? 'Fork' : 'Active'
  } else {
    const outcome = score === 1 ? 'win' : score === 0 ? 'loss' : score === 0.5 ? 'draw' : 'open'
    result.className = `wiki-chess-lb-game-result is-${outcome}`
    result.textContent = score === 1 ? 'Win' : score === 0 ? 'Loss' : score === 0.5 ? 'Draw' : '—'
  }

  const resultCol = document.createElement('span')
  resultCol.className = 'wiki-chess-lb-game-result-col'
  resultCol.appendChild(result)
  // Compact start (+ end) under the badge; exact local times on hover.
  const { startShort, endShort } = gameDateLabelParts(g)
  if (startShort) {
    const dateEl = document.createElement('span')
    dateEl.className = 'wiki-chess-lb-game-date'
    if (endShort) {
      dateEl.classList.add('is-range')
      dateEl.textContent = `${startShort}\n${endShort}`
    } else {
      dateEl.textContent = startShort
    }
    const hover = gameDateHoverTitle(g)
    if (hover) dateEl.title = hover
    resultCol.appendChild(dateEl)
  }

  const text = document.createElement('span')
  text.className = 'wiki-chess-lb-game-text'
  appendGamePlayers(text, g)
  appendGameMeta(text, g)

  body.append(resultCol, text)
  link.appendChild(body)
  return link
}

function refreshOpenChallengeLists() {
  window.setTimeout(() => {
    if (!isSiteSurveyAllSurface() || !isLeaderboardPageVisible()) return
    // Kick the seek crawl directly. Do not requestBoard({ refreshOpenChallenges })
    // — that assigns surveyOpenChallengesSeq to the board seq before BUILD_CHALLENGES
    // starts, which orphans any in-flight crawl and can leave the loading line stuck.
    beginDeferredSiteSurveyWork()
    if (!renderSiteSurveyOpenChallenges()) renderLeaderboard()
  }, 400)
}

export function refreshSurveyOpenChallenges() {
  refreshOpenChallengeLists()
}

// Return to My Chess Games without re-crawling — used after aborting Post challenge
// setup (the list was just painted seconds earlier) and after posting a seek locally.
export function keepSiteSurveySnapshotOnReturn() {
  skipNextSiteSurveyRefresh = true
  openChallengesLoading = false
}

// After the owner posts a seek, paint it in Open Challenges immediately instead of
// waiting for a federation crawl to rediscover their own survey-metadata row.
export function addPostedOpenChallengeLocally({ itemId, pgn, title, challenge, site, slug } = {}) {
  const entry = harvestGhostOpenChallenge({
    itemId,
    pgn,
    title,
    challenge,
    site: site || ctx?.viewingSite?.() || challenge?.creator?.site,
    slug,
  })
  if (!entry) return false

  if (lbMeta && typeof lbMeta === 'object') {
    lbMeta.openChallenges = mergeOpenChallengeEntries([entry], lbMeta.openChallenges || [])
    if (Array.isArray(lbMeta.openChallengesLocal)) {
      lbMeta.openChallengesLocal = mergeOpenChallengeEntries([entry], lbMeta.openChallengesLocal)
    }
    delete lbMeta.openChallengesPending
    if (Array.isArray(lbMeta.games)) storeSiteSurveyCache(lbEntries, lbMeta)
  }
  // Always patch session cache so return-to-survey primes the new seek even if
  // in-memory lbMeta was cleared while the post modal was open.
  patchSiteSurveyCacheOpenChallenge(entry)

  openChallengesLoading = false

  // Returning to My Chess Games after post must not re-crawl to "find" this seek.
  keepSiteSurveySnapshotOnReturn()

  if (isLeaderboardPageVisible()) renderLeaderboard()
  return true
}

// After the owner cancels a seek, drop it from Open Challenges immediately instead of
// re-crawling the federation for replacements.
function removePostedOpenChallengeLocally(itemId) {
  const id = String(itemId || '').trim()
  if (!id) return false

  if (lbMeta && typeof lbMeta === 'object') {
    const list = Array.isArray(lbMeta.openChallenges) ? lbMeta.openChallenges : []
    lbMeta.openChallenges = list.filter(e => String(e?.itemId || '').trim() !== id)
    if (Array.isArray(lbMeta.openChallengesLocal)) {
      lbMeta.openChallengesLocal = lbMeta.openChallengesLocal.filter(e => String(e?.itemId || '').trim() !== id)
    }
    delete lbMeta.openChallengesPending
    if (Array.isArray(lbMeta.games)) storeSiteSurveyCache(lbEntries, lbMeta)
  }
  removeSiteSurveyCacheOpenChallenge(id)

  openChallengesLoading = false

  if (isLeaderboardPageVisible()) {
    if (!renderSiteSurveyOpenChallenges()) renderLeaderboard()
  }
  return true
}

// Re-render publish controls (and re-probe site survey in PWA) after auth/bridge arrives.
export function refreshSurveyIfVisible() {
  if (!isLeaderboardPageVisible()) return
  if (viewKind === 'siteSurvey' && isInAppSurveySurface()) {
    if (ctx?.pwaBridgeActive || canRequestShellSurveyFetch()) {
      if (lbLoading || lbMeta?.unavailable || !Array.isArray(lbMeta?.games)) {
        requestBoard({ force: true })
      } else {
        maybeAutoRefreshEmptySiteSurvey()
      }
      // Still re-render below so auth-gated Post challenge enables without a page reload.
    }
  }
  renderLeaderboard()
}

function canManageOpenChallenge(entry) {
  if (!ctx?.canPublish?.() || !entry?.challenge) return false
  const creatorId = String(entry.challenge.creator?.id || '')
    .trim()
    .toLowerCase()
  const viewerId = String(ctx?.viewerSeatId?.() || '')
    .trim()
    .toLowerCase()
  if (creatorId && viewerId) return creatorId === viewerId
  const viewingSite = String(ctx.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  const entrySite = String(entry.site ?? '')
    .trim()
    .toLowerCase()
  return Boolean(viewingSite && entrySite && sitesMatch(entrySite, viewingSite))
}

function shouldGhostJoinOpenChallenge(entry, { pgn = '', host: _host = '' } = {}) {
  if (canManageOpenChallenge(entry)) return false
  const challenge = entry?.challenge
  const ghostPgn = String(entry?.pgn || pgn || '').trim()
  if (!challenge || !isOpenChallenge(challenge) || !ghostPgn) return false
  // Pending survey-metadata seeks → join ghost. Page-backed (slug) → open real page.
  return openChallengeUsesJoinGhost(entry)
}

function dispatchOpenChallengeSeekClick(link, entry, { append = false } = {}) {
  const isAccepted = Boolean(entry?.accepted && entry?.acceptedGame?.slug)
  const slug = isAccepted ? entry.acceptedGame.slug : link.getAttribute('data-ch-slug') || ''
  const host = isAccepted
    ? (entry.acceptedGame.site ?? link.getAttribute('data-ch-host') ?? '')
    : link.getAttribute('data-ch-host') || ''
  const itemId = link.getAttribute('data-ch-item-id') || ''
  const title = isAccepted
    ? entry.acceptedGame.title || entry.title || link.getAttribute('data-ch-title') || ''
    : link.getAttribute('data-ch-title') || ''
  const pending = link.getAttribute('data-ch-pending') === 'true'
  const pgn = link.getAttribute('data-ch-pgn') || ''
  if (!slug && !(pending && pgn)) return
  const challenge = entry?.challenge
  const ghost = shouldGhostJoinOpenChallenge(entry, { slug, pgn, host })
  const ghostSite = String(challenge?.creator?.site ?? host ?? '').trim()
  shellMessenger()?.openGamePage({
    slug: ghost ? '' : slug,
    site: ghost ? ghostSite : host,
    itemId: entry?.itemId || itemId,
    title: isAccepted ? entry.acceptedGame?.title || title : entry?.title || title,
    ghost,
    pgn: entry?.pgn || pgn,
    challenge,
    ...(append ? { append: true } : {}),
  })
}

function applySurveyOpenChallengeEdit(entry, { rated, creatorColor, minRating, maxRating }) {
  const challenge = entry?.challenge
  if (!challenge || !entry.itemId || !entry.pgn) return

  const updated = buildOpenChallenge({
    rated,
    creatorColor,
    minRating,
    maxRating,
    creatorId: challenge.creator?.id || '',
    creatorSite: challenge.creator?.site ?? '',
    creatorRating: challenge.creator?.rating ?? null,
    challengeTarget: challenge.challengeTarget || '',
    ts: challenge.ts || Date.now(),
  })
  if (!updated) return

  const creatorSeat = updated.config.creatorColor === CHALLENGE_COLOR_BLACK ? 'Black' : 'White'
  const openSeat = creatorSeat === 'Black' ? 'White' : 'Black'
  const current = formatPgn(entry.pgn)
  let next = setPgnTag(current, creatorSeat, updated.creator.id)
  next = formatPgn(setPgnTag(next, openSeat, ''))
  next = stampOpenChallengePgn(next, updated)

  shellMessenger()?.challengeChanged({
    challenge: updated,
    ghost: {
      itemId: entry.itemId,
      pgn: next,
      title: openChallengeDisplayTitle({
        challenge: updated,
        title: entry.title,
      }),
    },
  })
  refreshOpenChallengeLists()
}

function openOwnOpenChallengeModal(entry) {
  if (!entry?.challenge || !entry.itemId || !entry.pgn) return
  const cfg = entry.challenge.config || {}
  openWithEmbeddedMount(
    openChallengeEditModal,
    {
      title: entry.title || 'Open challenge',
      rated: cfg.rated,
      creatorColor: cfg.creatorColor,
      minRating: cfg.minRating,
      maxRating: cfg.maxRating,
      onSave: params => applySurveyOpenChallengeEdit(entry, params),
      onCancelChallenge: () => {
        shellMessenger()?.challengeChanged({
          challenge: null,
          ghostItemId: entry.itemId,
        })
        removePostedOpenChallengeLocally(entry.itemId)
        // Nested confirm discard restores mount; belt-and-suspenders if that path missed.
        ensureMountContentVisible('#leaderboard .container-fluid')
        ctx?.notifyWikiHeight?.()
      },
    },
    () => ctx?.notifyWikiHeight?.(),
  )
}

function appendOpenChallengeEventHeader(link, entry) {
  const label = openChallengeDisplayTitle({
    challenge: entry?.challenge,
    title: entry?.title,
    opponentDisplayName: entry?.opponentLabel,
  })
  if (!label) return
  const event = document.createElement('span')
  event.className = 'wiki-chess-lb-game-event'
  event.textContent = label
  link.appendChild(event)
}

function openChallengeSubline(entry, { accepted = false, directed = false } = {}) {
  const challenge = entry?.challenge
  const cfg = challenge?.config || {}
  const isAccepted = accepted || Boolean(entry?.accepted)
  const isDirect = directed || Boolean(challenge?.challengeTarget)
  // Badge already shows Rated/Casual; title already shows joiner colour / Random.
  const pgnMeta = formatGameRowMetaLine({
    pgn: entry?.pgn,
    rated: cfg.rated,
    challenge,
    includeRated: false,
    includeColor: false,
  })
  if (isAccepted) {
    const gameSite = entry.acceptedGame?.site ?? entry.site ?? ''
    return [
      `Accepted by ${entry.opponentLabel || playerDisplayLabel(challenge?.opponent?.id || '') || gameSite}`,
      'fork their copy to play',
      pgnMeta,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (isDirect) {
    return [challenge?.challengeTarget, formatChallengeRange(cfg.minRating, cfg.maxRating), pgnMeta]
      .filter(Boolean)
      .join(' · ')
  }
  return [formatChallengeRange(cfg.minRating, cfg.maxRating), pgnMeta].filter(Boolean).join(' · ')
}

function siteSeekRowFor(entry) {
  const challenge = entry.challenge
  const cfg = challenge?.config || {}
  const own = canManageOpenChallenge(entry) || Boolean(entry?.accepted)
  const isAccepted = Boolean(entry?.accepted && entry?.acceptedGame?.slug)
  const gate =
    challenge && !isAccepted
      ? challengeJoinGate(challenge, {
          viewerRating: ctx?.viewerRating?.(),
          isAuthenticatedOwner: Boolean(ctx?.isAuthenticatedOwner?.()),
          viewingSite: ctx?.viewingSite?.() || '',
        })
      : { ok: false }
  const canJoin = !own && !isAccepted && gate.ok
  const li = document.createElement('li')
  li.className = 'wiki-chess-lb-game-row'
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'wiki-chess-lb-game-link'
  const gameSite = isAccepted
    ? (entry.acceptedGame?.site ?? entry.site ?? '')
    : (entry.site ?? ctx?.viewingSite?.() ?? '')
  const gameSlug = isAccepted ? entry.acceptedGame?.slug || entry.slug || '' : entry.slug || ''
  link.setAttribute('data-ch-slug', gameSlug)
  link.setAttribute('data-ch-host', gameSite)
  link.setAttribute('data-ch-item-id', entry.itemId || '')
  link.setAttribute(
    'data-ch-title',
    isAccepted
      ? entry.acceptedGame?.title || entry.title || ''
      : openChallengeDisplayTitle({ challenge, title: entry.title }),
  )
  link.setAttribute('data-ch-pending', entry.pending ? 'true' : 'false')
  link.setAttribute('data-ch-pgn', entry.pgn || '')
  if (isAccepted) link.setAttribute('data-ch-accepted', 'true')
  if (own) link.setAttribute('data-ch-own', 'true')
  else if (canJoin) link.setAttribute('data-ch-joinable', 'true')
  if (!gameSlug && !(entry.pending && entry.pgn)) link.disabled = true

  if (isAccepted) {
    const badge = document.createElement('span')
    badge.className = 'wiki-chess-lb-game-result is-draw'
    badge.textContent = 'Fork'
    const text = document.createElement('span')
    text.className = 'wiki-chess-lb-game-text'
    const who = document.createElement('span')
    who.className = 'wiki-chess-lb-game-opp'
    who.textContent =
      entry.acceptedGame?.title ||
      openChallengeDisplayTitle({
        challenge,
        title: entry.title,
        opponentDisplayName: entry.opponentLabel,
      }) ||
      'Accepted challenge'
    text.appendChild(who)
    const sub = document.createElement('span')
    sub.className = 'wiki-chess-lb-game-sub text-muted'
    sub.textContent = openChallengeSubline(entry, { accepted: true })
    text.appendChild(sub)
    const body = document.createElement('span')
    body.className = 'wiki-chess-lb-game-body'
    const resultCol = document.createElement('span')
    resultCol.className = 'wiki-chess-lb-game-result-col'
    resultCol.appendChild(badge)
    body.append(resultCol, text)
    link.appendChild(body)
  } else {
    appendOpenChallengeEventHeader(link, entry)

    const body = document.createElement('span')
    body.className = 'wiki-chess-lb-game-body'

    const resultCol = document.createElement('span')
    resultCol.className = 'wiki-chess-lb-game-result-col'
    const badge = document.createElement('span')
    badge.className = `wiki-chess-lb-game-result ${cfg.rated ? 'is-open' : 'is-draw'}`
    badge.textContent = cfg.rated ? 'Rated' : 'Casual'
    resultCol.appendChild(badge)

    const text = document.createElement('span')
    text.className = 'wiki-chess-lb-game-text'
    const sub = document.createElement('span')
    sub.className = 'wiki-chess-lb-game-sub text-muted'
    const subText = openChallengeSubline(entry)
    if (subText) sub.textContent = subText
    if (subText) text.appendChild(sub)

    body.append(resultCol, text)
    link.appendChild(body)
  }

  const note = document.createElement('span')
  note.className = 'wiki-chess-ch-note'
  if (isAccepted) {
    note.classList.add('is-joinable')
    note.textContent = 'Fork back \u203a'
  } else if (own) {
    note.textContent = 'Manage \u203a'
  } else if (canJoin) {
    note.classList.add('is-joinable')
    note.textContent = 'Join \u203a'
  } else {
    note.classList.add('is-blocked')
    note.textContent = challengeRejectNote(gate.reason, cfg, challenge)
  }
  link.appendChild(note)
  li.appendChild(link)
  return li
}

function renderLbStatus() {
  const status = el('wikiChessLbStatus')
  if (!status) return
  const isSite = viewKind === 'siteSurvey'
  if (lbLoading && lbBackground) {
    status.hidden = true
    return
  }
  status.hidden = false
  if (lbLoading) {
    let msg = lbProgress?.message
    if (!msg) {
      msg = isSite
        ? 'Loading your chess games…'
        : mode === 'survey'
          ? 'Updating federation ratings…'
          : mode === 'neighborhood'
            ? 'Filtering saved ratings for your wiki neighbourhood…'
            : 'Reading rated games on your site…'
    }
    if (lbProgress && mode === 'survey' && !isSite) {
      const hostsDone = Math.max(0, Number(lbProgress.hostIndex) || 0)
      const hostTotal = Math.max(hostsDone, Number(lbProgress.hostTotal) || 0)
      const eta = formatCrawlEtaLabel(lbProgress.elapsedMs, hostsDone, hostTotal)
      // Shell progress messages replace the start copy — keep ETA + leave-open hint attached.
      if (eta && !String(msg).includes(eta)) {
        msg = `${String(msg).replace(/\u2026$/, '')} — ${eta}`
      }
      if (!String(msg).includes('Leave this open')) {
        msg = `${msg} ${SURVEY_CRAWL_KEEP_OPEN_HINT}`
      }
    }
    status.innerHTML = `<i class="fas fa-spinner fa-spin fa-fw" aria-hidden="true"></i> ${msg}`
    return
  }
  if (lbMeta?.wrongPage) {
    status.hidden = false
    status.textContent = `Open the ${LEADERBOARD_PAGE_TITLE} page on your wiki instead of adding a LEADERBOARD item elsewhere.`
    return
  }
  if (lbMeta?.unavailable) {
    status.textContent = isSite
      ? 'Open this page on its wiki to run the survey probe.'
      : 'Open this game on your wiki to build the leaderboards.'
    return
  }
  if (isSite) {
    const allGames = Array.isArray(lbMeta?.games) ? lbMeta.games : []
    const activeGames = allGames.filter(g => g.active)
    const completedGames = allGames.filter(g => !g.active)
    if (siteProbeKind === 'all') {
      status.hidden = true
      return
    }
    status.hidden = false
    const games =
      siteProbeKind === 'unrated' ? completedGames.filter(g => !g.rated) : completedGames.filter(g => g.rated)
    if (!activeGames.length && !games.length) {
      status.textContent =
        siteProbeKind === 'unrated'
          ? 'No unrated games published on this site yet.'
          : 'No rated games published on this site yet.'
      return
    }
    const activeNote = activeGames.length
      ? `${activeGames.length} active ${activeGames.length === 1 ? 'game' : 'games'}`
      : ''
    const syncPending = allGames.filter(g => g.syncPending)
    const syncNote = syncPending.length ? `${syncPending.length} awaiting sync` : ''
    if (!games.length) {
      status.textContent = [activeNote, syncNote].filter(Boolean).join(' · ') || 'No completed games yet.'
      if (status.textContent !== 'No completed games yet.') status.textContent += '.'
      return
    }
    const wins = games.filter(g => g.score === 1).length
    const losses = games.filter(g => g.score === 0).length
    const draws = games.filter(g => g.score === 0.5).length
    const total = games.length
    const kind = siteProbeKind === 'unrated' ? 'unrated' : 'rated'
    const completedNote = `${total} completed ${kind} ${total === 1 ? 'game' : 'games'} · ${wins}–${losses}–${draws} W–L–D`
    status.textContent = activeNote ? `${activeNote} · ${completedNote}.` : `${completedNote}.`
    if (syncNote) {
      status.textContent = `${status.textContent.replace(/\.$/, '')} · ${syncNote}.`
    }
    return
  }
  const players = lbEntries.length
  const sites = Number(lbMeta?.crawled) || 0
  const surveyMembers = Number(lbMeta?.surveyMembers) || players
  if (!players) {
    status.textContent =
      mode === 'survey'
        ? 'No rated players found yet.'
        : mode === 'neighborhood'
          ? 'No rated opponents of your wiki neighbourhood appear in the visible federation yet.'
          : 'No past opponents found yet. Play a rated cross-wiki game to appear here.'
    return
  }
  const noun = players === 1 ? 'player' : 'players'
  // Past opponents never loads the federation crawl — only neighborhood (as a view over a
  // cached survey board) may cite the visible-federation member count.
  const filterNote =
    lbMeta?.filteredFromSurvey && mode === 'neighborhood' && surveyMembers > players
      ? ` (filtered from ${surveyMembers} in visible federation)`
      : ''
  const twinCount = Array.isArray(lbMeta?.missingTwinFindings) ? lbMeta.missingTwinFindings.length : 0
  const twinNote =
    twinCount > 0 ? ` ${twinCount} game${twinCount === 1 ? '' : 's'} missing a twin copy on a peer site.` : ''
  status.textContent = `${players} rated ${noun} across ${sites} ${sites === 1 ? 'site' : 'sites'}${filterNote}.${twinNote}`
}

function challengeRejectNote(reason, cfg, challenge) {
  if (reason === 'rating-below-min') return `Min ${cfg.minRating}`
  if (reason === 'rating-above-max') return `Max ${cfg.maxRating}`
  if (reason === 'rating-unknown') return 'Rating required'
  if (reason === CHALLENGE_REJECT_OWNERS_ONLY) {
    if (challenge?.challengeTarget) return "Sign in as that wiki's owner"
    return 'Owners only'
  }
  if (reason === CHALLENGE_REJECT_WRONG_SITE) return 'Wrong wiki'
  return "Can't join"
}
