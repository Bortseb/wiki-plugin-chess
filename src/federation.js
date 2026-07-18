/**
 * Neighborhood layer — Glicko-2, twin audit, open seeks, crawl/consensus, page.chess gossip.
 *
 * Conceptual packages (reading map — one file by design; do not split without a project decision):
 *
 *   A · Glicko          rating math, RD decay, PGN Glicko tags, vs-Stockfish track
 *   B · TwinAudit       rated-game discovery, twin reconciliation, seat ratings
 *   C · Gossip          timeline keys, checkpoints, trustedPeers, page.chess charm
 *   D · Challenges      open-seat seeks, accept/join ghosts, lobby partition
 *   E · LeaderboardMeta survey/leaderboard page story helpers, rank display
 *   F · Consensus       runFederationConsensus / consensusFromNetwork (lazy vs audit)
 *   G · Crawl           neighborhood jobs, site-survey deferred work, fetch helpers
 *   H · SiteClient      createBrowserWikiSiteClient (+ PWA twin in server/pwa-bridge.js)
 *
 * Entry points: consensusFromNetwork, orchestrateSiteSurveyDeferredWork, rateGame,
 * buildLeaderboardAsync, createBrowserWikiSiteClient. See also `Glicko`, `Gossip`, …
 * namespace objects at the bottom of this file.
 *
 * Section markers use `// # Section Name` for IDE and GitHub navigation.
 *
 * SPDX-License-Identifier: MIT
 */
import {
  parsePgnParts,
  parsePlayerId,
  normalizeWikiSite,
  formatPgn,
  sanTokens,
  challengeOpponentWikiSite,
  isOpenSeatTag,
  getPgnTag,
  setPgnTag,
  normalizeWikiSiteInput,
  isSurveyItemText,
  playerDisplayLabel,
  openChallengeAcceptParagraph,
  formatPlayerDisplayLabel,
  seatResultBannerName,
  bothSeatsFilled,
  normalizeFen,
  rebuildStoryFromJournal,
  CHESS_CREATE_SYMBOL,
  formatPlayerId,
  resolveSignedInUsername,
  buildJoinAcceptGhost,
  stockfishPlayerId,
  HUMAN_PLAY_CORRESPONDENCE,
  HUMAN_PLAY_SAME_DEVICE,
  normalizeGameSettings,
  isDecisiveResult,
  gameResultFromPgn,
  isPageOpenChallengePgn,
  openSeatSide,
  pgnHasMoves,
  readPeerMissingPgnTag,
  canonicalizePersistedChessText,
  academyPlayTwinSite,
  isAnnotatedGameChessText,
  gamePgnBodyFromItemText,
  asGameItemText,
  pgnThroughPlies,
  ensureStandardPgnHeaders,
  formatPgnParts,
  isOwnCorrespondencePly,
  isLoopbackWikiHost,
  isPlaceholderPgnEvent,
  parseChessItem,
  resolveChessState,
  applyPageAction,
  applyPageActions,
  applyChessSaveToPage,
} from './chess-core.js'
import { Pgn } from 'cm-pgn/src/Pgn.js'

export { parseSurveyKind, isSurveyItemText, SURVEY_KIND_FULL, isLoopbackWikiHost } from './chess-core.js'

// # Glicko Rating Math

// ## Constants

// Starting rating for every new player, and the Glicko-2 scale anchor
// (μ = 0 maps here), so it must stay 1500.
export const DEFAULT_RATING = 1500

// Maximum (and default) Rating Deviation: a fresh or long-idle player is this
// unsure. RD never exceeds this ceiling, so confidence can always recover with play.
export const DEFAULT_RD = 350

// Default volatility (σ): how erratic a player's results are expected to be. Glicko-2
// adjusts it per update; new players start at the standard 0.06.
export const DEFAULT_SIGMA = 0.06

// System constant τ constrains how much volatility can change per period. Smaller =
// steadier. 0.3–1.2 are typical; 0.5 is the canonical default.
export const TAU = 0.5

// Convergence tolerance for the volatility (σ') Illinois-method root-find.
const CONVERGENCE = 1e-6

// Glicko-2 scale factor: μ = (r − 1500) / 173.7178, φ = RD / 173.7178.
export const GLICKO2_SCALE = 173.7178

// Ratings are clamped to a sane band (matching the wider plugin's display range).
export const RATING_FLOOR = 100
export const RATING_CEILING = 3500

// RD can't sensibly drop below a small floor (perfect certainty is never claimed).
export const RD_FLOOR = 30

// One "rating period" of inactivity. Games are irregular, so we measure elapsed
// real time and decay confidence per whole period (7 days) since the last update.
export const RATING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

// Close a Glicko batch after this many verified games (only when also crossing a calendar day).
export const GLICKO_BATCH_GAME_LIMIT = 15

// Auto-block a peer when deleted-loss ratio exceeds this (silent; local IndexedDB only).
export const DELETION_RATIO_THRESHOLD = 0.25
// Min local losses before deletion-ratio auto-block can fire.
export const DELETION_MIN_SAMPLE = 4

// Island pool contraction threshold (player count drop vs last audit).
export const ISLAND_CONTRACTION_RATIO = 0.4

// Valid finished-game results carried in the PGN `Result` tag.
export const WHITE_WIN = '1-0'
export const BLACK_WIN = '0-1'
export const DRAW = '1/2-1/2'

// ## Value Coercion and Validation

// Clamp a raw rating into the plugin display band.
export function clampRating(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_RATING
  return Math.min(RATING_CEILING, Math.max(RATING_FLOOR, Math.round(n)))
}

// Clamp rating deviation between RD_FLOOR and DEFAULT_RD.
export function clampRd(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_RD
  return Math.min(DEFAULT_RD, Math.max(RD_FLOOR, n))
}

// Clamp volatility σ into a defensive positive band.
export function clampSigma(value) {
  const n = Number(value)
  // Volatility is a small positive number; keep it in a defensive band.
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIGMA
  return Math.min(0.5, Math.max(0.01, n))
}

// A usable numeric rating? (rejects NaN, null, out-of-band junk before clamping)
export function isValidRating(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= RATING_FLOOR && n <= RATING_CEILING
}

// ## Player State Record

// Fresh Glicko-2 player record (neutral prior + zero W/L/D).
export function newRatingState({ rating = DEFAULT_RATING, gamesPlayed = 0, updated = 0 } = {}) {
  const r = clampRating(rating)
  return {
    rating: r,
    rd: DEFAULT_RD,
    sigma: DEFAULT_SIGMA,
    gamesPlayed: Math.max(0, Math.trunc(gamesPlayed) || 0),
    peak: r,
    wins: 0,
    losses: 0,
    draws: 0,
    whiteWins: 0,
    whiteLosses: 0,
    whiteDraws: 0,
    blackWins: 0,
    blackLosses: 0,
    blackDraws: 0,
    updated: Number.isFinite(Number(updated)) ? Number(updated) : 0,
  }
}

// Coerce arbitrary stored / federated / hand-edited JSON into a valid state record.
// A peer's published passport (or a PGN header set) may be partial or tampered.
function nonNegInt(value) {
  return Math.max(0, Math.trunc(Number(value)) || 0)
}

// Coerce stored/federated JSON into a valid rating record.
export function normalizeRatingState(raw) {
  if (!raw || typeof raw !== 'object') return newRatingState()
  const gamesPlayed = nonNegInt(raw.gamesPlayed)
  const rating = clampRating(raw.rating)
  return {
    rating,
    rd: clampRd(raw.rd),
    sigma: clampSigma(raw.sigma),
    gamesPlayed,
    peak: isValidRating(raw.peak) ? clampRating(raw.peak) : rating,
    wins: nonNegInt(raw.wins),
    losses: nonNegInt(raw.losses),
    draws: nonNegInt(raw.draws),
    whiteWins: nonNegInt(raw.whiteWins),
    whiteLosses: nonNegInt(raw.whiteLosses),
    whiteDraws: nonNegInt(raw.whiteDraws),
    blackWins: nonNegInt(raw.blackWins),
    blackLosses: nonNegInt(raw.blackLosses),
    blackDraws: nonNegInt(raw.blackDraws),
    updated: Number.isFinite(Number(raw.updated)) ? Number(raw.updated) : 0,
  }
}

// ## Scoring Helpers

// Map PGN Result + seat to 1 / 0 / 0.5 (or null if unfinished).
export function resultToScore(result, seat) {
  const r = String(result || '').trim()
  if (seat !== 'White' && seat !== 'Black') return null
  if (r === DRAW) return 0.5
  if (r === WHITE_WIN) return seat === 'White' ? 1 : 0
  if (r === BLACK_WIN) return seat === 'Black' ? 1 : 0
  return null
}

// Glicko expected score of `state` vs `opponent` (pre-update).
export function expectedScore(state, opponent) {
  const s = normalizeRatingState(state)
  const o = normalizeRatingState(opponent)
  const mu = toMu(s.rating)
  const muOpp = toMu(o.rating)
  const phiOpp = toPhi(o.rd)
  return E(mu, muOpp, phiOpp)
}

// ## Scale Conversions

const toMu = rating => (clampRating(rating) - DEFAULT_RATING) / GLICKO2_SCALE
const toPhi = rd => clampRd(rd) / GLICKO2_SCALE
const fromMu = mu => clampRating(GLICKO2_SCALE * mu + DEFAULT_RATING)
const fromPhi = phi => clampRd(GLICKO2_SCALE * phi)

// g(φ): how much an opponent's RD discounts their result's weight.
const g = phi => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))

// E(μ, μ_j, φ_j): expected score of this player vs opponent j on the Glicko-2 scale.
const E = (mu, muOpp, phiOpp) => 1 / (1 + Math.exp(-g(phiOpp) * (mu - muOpp)))

// ## Time-Step Decay

// Whole rating periods between two timestamps (floor).
export function elapsedRatingPeriods(then, now = Date.now(), periodMs = RATING_PERIOD_MS) {
  const start = Number(then)
  const end = Number(now)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return 0
  if (end <= start) return 0
  return Math.floor((end - start) / periodMs)
}

// Inflate RD for `periods` of inactivity (φ* step).
export function decayRd(rd, sigma, periods) {
  const p = Math.max(0, Math.trunc(Number(periods)) || 0)
  if (p === 0) return clampRd(rd)
  const phi = toPhi(rd)
  const s = clampSigma(sigma)
  const phiStar = Math.sqrt(phi * phi + p * s * s)
  return fromPhi(phiStar)
}

// Apply time-based RD decay to a player state.
export function decayRatingState(state, now = Date.now(), periodMs = RATING_PERIOD_MS) {
  const s = normalizeRatingState(state)
  const periods = elapsedRatingPeriods(s.updated, now, periodMs)
  if (periods <= 0) return s
  return { ...s, rd: decayRd(s.rd, s.sigma, periods) }
}

// ## Volatility Update

// Solve for the new volatility σ' (Glickman step 5). `delta` is the estimated rating
// change, `v` the estimated variance, `phi`/`sigma` the pre-update values.
function computeNewSigma(delta, phi, v, sigma, tau = TAU) {
  const a = Math.log(sigma * sigma)
  const phi2 = phi * phi
  const delta2 = delta * delta

  const f = x => {
    const ex = Math.exp(x)
    const num = ex * (delta2 - phi2 - v - ex)
    const den = 2 * (phi2 + v + ex) ** 2
    return num / den - (x - a) / (tau * tau)
  }

  let A = a
  let B
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v)
  } else {
    let k = 1
    while (f(a - k * tau) < 0) k += 1
    B = a - k * tau
  }

  let fA = f(A)
  let fB = f(B)
  let iterations = 0
  while (Math.abs(B - A) > CONVERGENCE && iterations < 100) {
    const C = A + ((A - B) * fA) / (fB - fA)
    const fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else {
      fA /= 2
    }
    B = C
    fB = fC
    iterations += 1
  }
  return Math.exp(A / 2)
}

// ## Core Update

// Glicko-2 multi-game update; returns new state (+ optional delta).
export function updateRatingState(state, matches, { now, tau = TAU, decay = true } = {}) {
  const base = normalizeRatingState(state)
  const pre = decay && Number.isFinite(Number(now)) ? decayRatingState(base, now) : base
  const games = Array.isArray(matches) ? matches.filter(m => isScore(m?.score)) : []

  // No games this period: confidence-only step. φ already inflated above (if decay);
  // here we still bump RD by one period's σ so an unplayed period widens RD even
  // when `now` wasn't given. Rating and σ unchanged.
  if (games.length === 0) {
    const stepped = decay && Number.isFinite(Number(now)) ? pre : { ...pre, rd: decayRd(pre.rd, pre.sigma, 1) }
    return { ...stepped, delta: 0 }
  }

  const mu = toMu(pre.rating)
  const phi = toPhi(pre.rd)
  const sigma = clampSigma(pre.sigma)

  let vInv = 0 // 1/v accumulator
  let deltaSum = 0 // Σ g(φ_j)(s_j − E)
  for (const m of games) {
    const opp = normalizeRatingState(m.opponent)
    const muOpp = toMu(opp.rating)
    const phiOpp = toPhi(opp.rd)
    const gj = g(phiOpp)
    const ej = E(mu, muOpp, phiOpp)
    vInv += gj * gj * ej * (1 - ej)
    deltaSum += gj * (m.score - ej)
  }

  const v = 1 / vInv
  const delta = v * deltaSum

  const newSigma = computeNewSigma(delta, phi, v, sigma, tau)
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma)
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
  const newMu = mu + newPhi * newPhi * deltaSum

  const rating = fromMu(newMu)
  const wins = games.filter(m => m.score === 1).length
  const losses = games.filter(m => m.score === 0).length
  const draws = games.filter(m => m.score === 0.5).length
  let whiteWins = 0
  let whiteLosses = 0
  let whiteDraws = 0
  let blackWins = 0
  let blackLosses = 0
  let blackDraws = 0
  for (const m of games) {
    if (m.seat === 'White') {
      if (m.score === 1) whiteWins += 1
      else if (m.score === 0) whiteLosses += 1
      else whiteDraws += 1
    } else if (m.seat === 'Black') {
      if (m.score === 1) blackWins += 1
      else if (m.score === 0) blackLosses += 1
      else blackDraws += 1
    }
  }

  return {
    rating,
    rd: fromPhi(newPhi),
    sigma: clampSigma(newSigma),
    gamesPlayed: pre.gamesPlayed + games.length,
    peak: Math.max(pre.peak, rating),
    wins: pre.wins + wins,
    losses: pre.losses + losses,
    draws: pre.draws + draws,
    whiteWins: pre.whiteWins + whiteWins,
    whiteLosses: pre.whiteLosses + whiteLosses,
    whiteDraws: pre.whiteDraws + whiteDraws,
    blackWins: pre.blackWins + blackWins,
    blackLosses: pre.blackLosses + blackLosses,
    blackDraws: pre.blackDraws + blackDraws,
    updated: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    delta: rating - pre.rating,
  }
}

// Rate one finished game for both seats; returns { white, black } or null.
export function rateGame({ white, black, result, now = Date.now() } = {}) {
  const whiteScore = resultToScore(result, 'White')
  const blackScore = resultToScore(result, 'Black')
  if (whiteScore == null || blackScore == null) return null

  const w = decayRatingState(white, now)
  const b = decayRatingState(black, now)

  return {
    white: updateRatingState(w, [{ opponent: b, score: whiteScore, seat: 'White' }], {
      now,
      decay: false,
    }),
    black: updateRatingState(b, [{ opponent: w, score: blackScore, seat: 'Black' }], {
      now,
      decay: false,
    }),
  }
}

// # Glicko Vs-Stockfish Personal Track

// How confident we are in the fixed-strength Stockfish anchor. Its true strength
// really is fixed (we set UCI_Elo), so it's a tight (low-RD) reference opponent.
export const ENGINE_ANCHOR_RD = 60

// Update the local-only vs-Stockfish rating track (never writes a federated prior).
export function rateEngineGame(state, { elo, score, now = Date.now() } = {}) {
  const pre = normalizeRatingState(state)
  if (!isScore(score) || !isValidRating(elo)) return pre
  const anchor = { rating: clampRating(elo), rd: ENGINE_ANCHOR_RD, sigma: DEFAULT_SIGMA }
  return updateRatingState(pre, [{ opponent: anchor, score }], { now, decay: true })
}

function isScore(s) {
  return s === 0 || s === 0.5 || s === 1
}

// ## PGN Glicko Tags
// A rated game stamps each seat's pre-game state into the PGN so the result is a
// self-contained, replayable rating event (no trusted aggregator). Tag names follow
// the spec: [WhiteGlickoRating], [WhiteGlickoRD], [WhiteGlickoVolatility] (+ Black).

export const RATING_TAG = 'Rated'
export const WHITE_RATING_TAG = 'WhiteGlickoRating'
export const BLACK_RATING_TAG = 'BlackGlickoRating'
export const WHITE_RD_TAG = 'WhiteGlickoRD'
export const BLACK_RD_TAG = 'BlackGlickoRD'
export const WHITE_VOLATILITY_TAG = 'WhiteGlickoVolatility'
export const BLACK_VOLATILITY_TAG = 'BlackGlickoVolatility'

const TRUTHY_RATED = /^(yes|true|1|on)$/i

// True when a Rated PGN tag means the game counts for Glicko.
export function isRatedTagValue(value) {
  return TRUTHY_RATED.test(String(value ?? '').trim())
}

// Volatility formatted to 4 decimal places per the spec ("X.XXXX").
export function formatVolatility(sigma) {
  return clampSigma(sigma).toFixed(4)
}

// Integer RD as a tag string.
export function formatRd(rd) {
  return String(Math.round(clampRd(rd)))
}

// Build pre-game Glicko PGN tags for one or both seats.
export function buildGlickoTags({ rated = true, white, black } = {}) {
  const tags = {}
  if (rated) tags[RATING_TAG] = 'yes'
  if (white) {
    const w = normalizeRatingState(white)
    tags[WHITE_RATING_TAG] = String(w.rating)
    tags[WHITE_RD_TAG] = formatRd(w.rd)
    tags[WHITE_VOLATILITY_TAG] = formatVolatility(w.sigma)
  }
  if (black) {
    const b = normalizeRatingState(black)
    tags[BLACK_RATING_TAG] = String(b.rating)
    tags[BLACK_RD_TAG] = formatRd(b.rd)
    tags[BLACK_VOLATILITY_TAG] = formatVolatility(b.sigma)
  }
  return tags
}

// Read a seat’s pre-game Glicko state from PGN tags (or null).
export function readGlickoState(tags, seat) {
  const t = tags && typeof tags === 'object' ? tags : {}
  const ratingTag = seat === 'Black' ? BLACK_RATING_TAG : WHITE_RATING_TAG
  if (!isValidRating(t[ratingTag])) return null
  const rdTag = seat === 'Black' ? BLACK_RD_TAG : WHITE_RD_TAG
  const volTag = seat === 'Black' ? BLACK_VOLATILITY_TAG : WHITE_VOLATILITY_TAG
  return normalizeRatingState({
    rating: t[ratingTag],
    rd: t[rdTag],
    sigma: t[volTag],
  })
}

// True when a tags object marks the game as agreed-rated.
export function readRatedFlag(tags) {
  const t = tags && typeof tags === 'object' ? tags : {}
  return isRatedTagValue(t[RATING_TAG])
}

// RD above this shows as provisional (rating?).
export const PROVISIONAL_RD = 110

// Display rating; appends ? while provisional.
export function formatRatingLabel(state) {
  const s = normalizeRatingState(state)
  return isProvisional(s) ? `${s.rating}?` : `${s.rating}`
}

// True while RD is still above the convergence threshold — too few recent rated
// games to rely on. Discovered opponents (who published Glicko tags from a rated
// game) are judged on RD alone.
export function isProvisional(state) {
  return normalizeRatingState(state).rd > PROVISIONAL_RD
}

// The positive complement of `isProvisional`: an established (reliable) rating that has
// been validated by human games AND whose RD has converged. Used by the leaderboard's
// "established only" filter.
export function isReliable(state) {
  return !isProvisional(state)
}

// # TwinAudit Game Discovery

export function sitesMatch(a, b) {
  const x = String(a || '')
    .trim()
    .toLowerCase()
  const y = String(b || '')
    .trim()
    .toLowerCase()
  if (!x || !y) return false
  if (x === y) return true
  return normalizeWikiSite(x) === normalizeWikiSite(y)
}

export function seatForSite(tags, host) {
  for (const seat of ['White', 'Black']) {
    const parsed = parsePlayerId(tags?.[seat])
    if (parsed && !parsed.isEngine && sitesMatch(parsed.domain, host)) return seat
  }
  return null
}

export function stateFromGamePgn(pgn, host) {
  const { tags } = parsePgnParts(pgn)
  if (!readRatedFlag(tags)) return null
  const seat = seatForSite(tags, host)
  if (!seat) return null
  const state = readGlickoState(tags, seat)
  if (!state) return null
  return { state, updated: pgnTimestamp(tags), source: 'pgn' }
}

export function latestRatedGameForSite(games, host) {
  let best = null
  for (const pgn of Array.isArray(games) ? games : []) {
    const found = stateFromGamePgn(pgn, host)
    if (found && (!best || found.updated >= best.updated)) best = { ...found, pgn }
  }
  return best
}

export function resolveSeatRating({ siteGames = [], twinGames = [], site = '', host = '' } = {}) {
  const best = latestRatedGameForSite(siteGames, site || host)
  if (!best) return { state: null, verified: false, reason: 'no rated game found', updated: 0 }
  const fingerprint = gameFingerprint(best.pgn)
  const twin = (Array.isArray(twinGames) ? twinGames : []).find(
    pgn => fingerprint && gameFingerprint(pgn) === fingerprint,
  )
  const audit = auditTwins(best.pgn, twin)
  return { state: best.state, verified: audit.verified, reason: audit.reason, updated: best.updated }
}

// Parse the PGN Date / UTCDate (+ optional UTCTime) tags into a millisecond
// timestamp; 0 when absent/unparseable (treated as oldest).
export function pgnTimestamp(tags) {
  const t = tags && typeof tags === 'object' ? tags : {}
  const date = String(t.UTCDate || t.Date || '').trim()
  const m = date.match(/^(\d{4})\.(\d{2})\.(\d{2})$/)
  if (!m) return 0
  const time = String(t.UTCTime || '')
    .trim()
    .match(/^(\d{2}):(\d{2}):(\d{2})$/)
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    time ? Number(time[1]) : 0,
    time ? Number(time[2]) : 0,
    time ? Number(time[3]) : 0,
  )
  return Number.isFinite(ms) ? ms : 0
}

// # Gossip Checkpoints and Page Charm

export const TERMINATION_TIMESTAMP_TAG = 'TerminationTimestamp'
export const GAME_HASH_TAG = 'GameHash'

export const TRUSTED_PEERS_CAPTION = 'Trusted peers:'

export const CONSENSUS_SUPERMAJORITY = 0.66
export const FAST_SYNC_INTERVAL_MS = 5 * 60 * 1000

export const RATING_INDEXED_DB_NAME = 'wiki-chess-ratings-v1'
export const RATING_INDEXED_DB_STORE = 'rating-state'

export const CHESS_PAGE_CHARM_VERSION = 1

function emptyChessPageCharm() {
  return {
    version: CHESS_PAGE_CHARM_VERSION,
    federation: { checkpoint: null, trustedPeers: [] },
  }
}

// Gossip checkpoint fields peers read from leaderboard pages (no local sync timestamps).
export function normalizeCheckpointGossip(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null
  const state_hash = String(checkpoint.state_hash || '').trim()
  if (!state_hash) return null
  const out = {
    state_hash,
    last_processed_game_hash: String(checkpoint.last_processed_game_hash || ''),
    last_timeline_key: String(checkpoint.last_timeline_key || ''),
  }
  const islandId = String(checkpoint.island_id || '').trim()
  if (islandId) out.island_id = islandId
  return out
}

// Federation gossip persisted on wiki pages — no UI cache or IndexedDB-only fields.
export function normalizeFederationGossip(federation) {
  if (!federation || typeof federation !== 'object') {
    return { checkpoint: null, trustedPeers: [] }
  }
  return {
    checkpoint: federation.checkpoint !== undefined ? normalizeCheckpointGossip(federation.checkpoint) : null,
    trustedPeers: dedupeSites(Array.isArray(federation.trustedPeers) ? federation.trustedPeers : []),
  }
}

function sanitizeChessPageCharm(meta) {
  const base = mergeChessPageCharm(emptyChessPageCharm(), meta)
  base.federation = normalizeFederationGossip(base.federation)
  return base
}

function federationGossipFingerprint(federation) {
  return JSON.stringify(normalizeFederationGossip(federation))
}

// Normalize chess-charm patches before page persistence.
export function normalizeChessCharmPatch(patch) {
  if (!patch || typeof patch !== 'object') return {}
  const out = {}
  // gameIndex is no longer federated — ignore if present on old patches.
  if (patch.federation !== undefined) {
    const nf = patch.federation && typeof patch.federation === 'object' ? patch.federation : {}
    const fed = {}
    if (nf.checkpoint !== undefined) fed.checkpoint = normalizeCheckpointGossip(nf.checkpoint)
    if (nf.trustedPeers !== undefined) {
      fed.trustedPeers = dedupeSites(Array.isArray(nf.trustedPeers) ? nf.trustedPeers : [])
    }
    if (Object.keys(fed).length) out.federation = fed
  }
  return out
}

const isChessCharmJournalType = type => type === 'chess-charm' || type === 'chess-meta'

export function mergeChessPageCharm(base, patch) {
  const prev = base && typeof base === 'object' ? base : emptyChessPageCharm()
  const next = patch && typeof patch === 'object' ? patch : {}
  const out = { version: CHESS_PAGE_CHARM_VERSION, federation: prev.federation }
  if (next.federation !== undefined) {
    const pf = prev.federation && typeof prev.federation === 'object' ? prev.federation : {}
    const nf = next.federation && typeof next.federation === 'object' ? next.federation : {}
    out.federation = {
      checkpoint: nf.checkpoint !== undefined ? nf.checkpoint : pf.checkpoint || null,
      trustedPeers:
        nf.trustedPeers !== undefined
          ? dedupeSites(Array.isArray(nf.trustedPeers) ? nf.trustedPeers : [])
          : dedupeSites(Array.isArray(pf.trustedPeers) ? pf.trustedPeers : []),
    }
  }
  return out
}

function stripChessCharmJournal(page) {
  if (!Array.isArray(page?.journal)) return false
  const before = page.journal.length
  page.journal = page.journal.filter(action => !isChessCharmJournalType(action?.type))
  return page.journal.length !== before
}

// Read chess maintenance data from page JSON (`page.chess` only).
export function readChessPageCharm(page) {
  if (!page?.chess || typeof page.chess !== 'object') return emptyChessPageCharm()
  return sanitizeChessPageCharm(mergeChessPageCharm(emptyChessPageCharm(), page.chess))
}

export function readFederationCharm(page) {
  return normalizeFederationGossip(readChessPageCharm(page).federation || {})
}

export function buildFederationGossipPatch({ checkpoint, trustedPeers } = {}) {
  const federation = {}
  if (checkpoint !== undefined) federation.checkpoint = checkpoint
  if (trustedPeers !== undefined) federation.trustedPeers = trustedPeers
  return normalizeChessCharmPatch({ federation })
}

// Trusted peers gossiped on publish — federation sites with rated games that
// participated in the crawl (excluding the local hub).
export function deriveGossipTrustedPeers(listed, opts = {}) {
  const localSite = opts.localSite ?? ''
  const previous = opts.previous ?? []
  const local = cleanSite(localSite)
  const participants = dedupeSites(Array.isArray(listed) ? listed : []).filter(h => !sitesMatch(h, local))
  if (participants.length) return participants
  return dedupeSites(Array.isArray(previous) ? previous : [])
}

// Whether an audit's gossip differs from what is already on the leaderboards page.
// Publishes after each audit when checkpoint/trustedPeers changed.
export function shouldPublishFederationGossip(
  publishedFed,
  { checkpoint, trustedPeers } = {},
  { forcePublish = false } = {},
) {
  if (forcePublish) return true
  const prev = normalizeFederationGossip(publishedFed || {})
  const nextCheckpoint = normalizeCheckpointGossip(checkpoint)
  const nextTrusted =
    trustedPeers !== undefined ? dedupeSites(Array.isArray(trustedPeers) ? trustedPeers : []) : prev.trustedPeers
  const next = normalizeFederationGossip({
    checkpoint: nextCheckpoint,
    trustedPeers: nextTrusted,
  })
  return federationGossipFingerprint(prev) !== federationGossipFingerprint(next)
}

// True when a chess-charm patch would change persisted federation gossip.
export function chessCharmPatchWouldChange(page, patch) {
  const normalized = normalizeChessCharmPatch(patch)
  if (!Object.keys(normalized).length) return false
  const prev = readChessPageCharm(page)
  const next = sanitizeChessPageCharm(mergeChessPageCharm(prev, normalized))
  return federationGossipFingerprint(prev.federation) !== federationGossipFingerprint(next.federation)
}

// Persist chess maintenance data in `page.chess` only (no duplicate journal entries).
export function reviseChessCharmOnPage(page, patch) {
  if (!page) return false
  if (!chessCharmPatchWouldChange(page, patch)) return false
  // Wiki owns story/journal. Only patch page.chess (and strip any leftover
  // chess-charm journal noise). Never rebuild story here — that wiped journal-less
  // plugin default pages and is not a normal plugin's job.
  const normalized = normalizeChessCharmPatch(patch)
  const prev = readChessPageCharm(page)
  page.chess = sanitizeChessPageCharm(mergeChessPageCharm(prev, normalized))
  stripChessCharmJournal(page)
  return true
}

function sha256HexSync(message) {
  const msg = new TextEncoder().encode(String(message))
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ])
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const bitLen = msg.length * 8
  const padLen = ((msg.length + 9 + 63) & ~63) >>> 0
  const padded = new Uint8Array(padLen)
  padded.set(msg)
  padded[msg.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padLen - 4, bitLen, false)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h0] = H
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h0 + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h0 = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h0) >>> 0
  }
  return [...H].map(v => v.toString(16).padStart(8, '0')).join('')
}

export function canonicalGameBody(pgn) {
  const { tags } = parsePgnParts(pgn)
  const fp = gameFingerprint(pgn)
  const result = String(tags.Result || '').trim()
  const term = String(tags.Termination || '').trim()
  const ts = String(tags[TERMINATION_TIMESTAMP_TAG] || '').trim()
  const moves = sanPlies(pgn).join(' ')
  return [fp, result, term, ts, moves].join('\n')
}

export function gameSha256Sync(pgn) {
  return sha256HexSync(canonicalGameBody(pgn))
}

export function formatTerminationTimestamp(now = Date.now()) {
  return new Date(now).toISOString()
}

export function stampCompletionTags(pgn, now = Date.now()) {
  let text = setPgnTag(pgn, TERMINATION_TIMESTAMP_TAG, formatTerminationTimestamp(now))
  return setPgnTag(text, GAME_HASH_TAG, gameSha256Sync(text))
}

export function readGameTimelineKey(pgn) {
  const { tags } = parsePgnParts(pgn)
  const ts = String(tags[TERMINATION_TIMESTAMP_TAG] || '').trim() || '1970-01-01T00:00:00.000Z'
  const hash = String(tags[GAME_HASH_TAG] || gameSha256Sync(pgn))
    .trim()
    .toLowerCase()
  return { ts, hash, key: `${ts}|${hash}` }
}

export function compareGameTimeline(a, b) {
  const ka = readGameTimelineKey(a)
  const kb = readGameTimelineKey(b)
  if (ka.ts !== kb.ts) return ka.ts < kb.ts ? -1 : 1
  if (ka.hash !== kb.hash) return ka.hash < kb.hash ? -1 : 1
  return 0
}

export function clonePlayersMap(players) {
  const out = {}
  for (const host of Object.keys(players || {})) {
    out[host] = normalizeRatingState(players[host])
  }
  return out
}

export function filterGamesAfterTimelineKey(games, afterKey) {
  const cursor = String(afterKey || '').trim()
  if (!cursor) return Array.isArray(games) ? games.filter(g => typeof g === 'string' && g.trim()) : []
  return (Array.isArray(games) ? games : []).filter(g => {
    if (typeof g !== 'string' || !g.trim()) return false
    return readGameTimelineKey(g).key > cursor
  })
}

function isTrustedPeersStoryRoster(entry) {
  return (
    entry?.type === 'roster' &&
    (entry.id === TRUSTED_PEERS_ROSTER_ID || String(entry.text || '').startsWith(TRUSTED_PEERS_CAPTION))
  )
}

// Read trusted peers from hidden page.chess metadata.
export function readTrustedPeers(page) {
  return readFederationCharm(page).trustedPeers
}

// Persist trusted peers in page.chess and remove any leftover visible roster item.
export function applyTrustedPeersToPage(page, peers) {
  const hosts = dedupeSites(peers)
  const story = Array.isArray(page?.story) ? page.story : []
  const rosterEntry = story.find(isTrustedPeersStoryRoster)
  if (rosterEntry?.id) applyPageAction(page, { type: 'remove', id: rosterEntry.id })
  return reviseChessCharmOnPage(page, { federation: { trustedPeers: hosts } })
}

export const TRUSTED_PEERS_ROSTER_ID = 'lb-trusted-peers-roster'

export const LEADERBOARD_INTRO_ID = 'a1b2c3d4e5f67890'
export const LEADERBOARD_CHESS_ID = 'b2c3d4e5f6789012'

// Keep in sync with pages/chess-leaderboards (see test/federation.test.js).
export const LEADERBOARD_INTRO_TEXT = 'Rated chess game leaderboards.'

export function computeStateHash(players) {
  const hosts = Object.keys(players || {}).sort()
  const rows = hosts.map(host => {
    const s = normalizeRatingState(players[host])
    return [host, s.rating, Math.round(s.rd), clampSigma(s.sigma).toFixed(4), s.gamesPlayed].join(':')
  })
  return gameSha256Sync(rows.join('\n'))
}

export function checkpointSupermajority(peerCheckpoints, trustedPeers, threshold = CONSENSUS_SUPERMAJORITY) {
  const peers = dedupeSites(trustedPeers || [])
  if (!peers.length) return null
  const tallies = new Map()
  for (const row of Array.isArray(peerCheckpoints) ? peerCheckpoints : []) {
    const host = cleanSite(row?.site ?? row?.host)
    const hash = String(row?.checkpoint?.state_hash || '').trim()
    if (!host || !hash || !peers.includes(host)) continue
    tallies.set(hash, (tallies.get(hash) || 0) + 1)
  }
  let best = null
  for (const [hash, count] of tallies) {
    if (!best || count > best.count) best = { hash, count }
  }
  if (!best) return null
  const need = Math.ceil(peers.length * threshold)
  return best.count >= need ? best.hash : null
}

// # Gossip BlockList and Trusted Peers

// Accept `blockList` from IndexedDB / bridge payloads.
// Returns object|null — map `{ site: { reason, blockedAt? } }` or null
export function coerceBlockListMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  if (meta.blockList && typeof meta.blockList === 'object' && !Array.isArray(meta.blockList)) {
    return meta.blockList
  }
  return null
}

// Normalize blockList from an array of sites or an IndexedDB map `{ site: { reason } }`.
export function normalizeBlockList(raw) {
  if (Array.isArray(raw)) return dedupeSites(raw)
  if (raw && typeof raw === 'object') {
    return dedupeSites(Object.keys(raw).filter(k => raw[k]))
  }
  return []
}

export function blockListSet(raw) {
  return new Set(normalizeBlockList(raw))
}

export function isSiteBlocked(host, blockList) {
  const h = cleanSite(host)
  if (!h) return false
  const blocked = blockListSet(blockList)
  for (const banned of blocked) {
    if (sitesMatch(banned, h)) return true
  }
  return false
}

// Drop open-challenge rows whose site or challenge seats match the blockList.
export function filterOpenChallengesByBlockList(entries, blockList) {
  const blocked = blockListSet(blockList)
  if (!blocked.size) return Array.isArray(entries) ? entries : []
  return (Array.isArray(entries) ? entries : []).filter(row => {
    if (!row) return false
    const site = cleanSite(row.site ?? row.host)
    if (site && [...blocked].some(h => sitesMatch(h, site))) return false
    const creator = cleanSite(row.challenge?.creator?.site ?? row.challenge?.creator?.host)
    if (creator && [...blocked].some(h => sitesMatch(h, creator))) return false
    const target = cleanSite(row.challenge?.challengeTarget)
    if (target && [...blocked].some(h => sitesMatch(h, target))) return false
    return true
  })
}

export function calendarDayKeyFromPgn(pgn) {
  const ts = readGameTimelineKey(pgn).ts
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return 'unknown'
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function findRootOrphanHash(events) {
  const list = Array.isArray(events) ? events : []
  if (!list.length) return ''
  return readGameTimelineKey(list[0].pgn).hash
}

export function computeIslandState(events, players, previous = null) {
  const islandId = findRootOrphanHash(events)
  const playerCount = Object.keys(players || {}).length
  const prevId = String(previous?.islandId || '').trim()
  const prevCount = Number(previous?.playerCount) || 0
  let state = 'connected'
  if (!islandId || playerCount <= 2) state = 'isolated'
  else if (prevId && prevId !== islandId) state = 'shifted'
  else if (prevCount > 0 && playerCount < prevCount * (1 - ISLAND_CONTRACTION_RATIO)) {
    state = 'shifted'
  }
  return {
    islandId,
    playerCount,
    previousIslandId: prevId || islandId,
    state,
  }
}

// Silent auto-block when an opponent deletes too many losses vs the local user.
export function applyDeletionRatioMetrics(findings, metrics = {}, blockList = {}) {
  const nextMetrics = metrics && typeof metrics === 'object' ? { ...metrics } : {}
  const nextBlockList =
    blockList && typeof blockList === 'object' && !Array.isArray(blockList)
      ? { ...blockList }
      : Object.fromEntries(normalizeBlockList(blockList).map(h => [h, { reason: 'user' }]))

  for (const row of Array.isArray(findings) ? findings : []) {
    if (row?.kind !== 'missing-twin') continue
    const peer = cleanSite(row.peerSite)
    if (!peer || row.explicitMark || row.isLocalLoss === false) continue
    const prev = nextMetrics[peer] || { expectedLosses: 0, missingTwins: 0 }
    prev.expectedLosses += 1
    if (row.peerUp && /twin game missing/.test(String(row.reason || ''))) prev.missingTwins += 1
    prev.ratio = prev.expectedLosses > 0 ? prev.missingTwins / prev.expectedLosses : 0
    prev.lastUpdated = new Date().toISOString()
    nextMetrics[peer] = prev
    if (prev.expectedLosses >= DELETION_MIN_SAMPLE && prev.ratio > DELETION_RATIO_THRESHOLD && !nextBlockList[peer]) {
      nextBlockList[peer] = { reason: 'deletion-ratio', blockedAt: new Date().toISOString() }
    }
  }
  return { deletionMetrics: nextMetrics, blockList: nextBlockList }
}

export function buildFetchTargets(opts = {}) {
  const ownSite = opts.localSite ?? ''
  const knownOpponents = opts.knownOpponents ?? []
  const rosterSites = opts.rosterSites ?? []
  const nearbySites = opts.neighborhoodSites ?? []
  const indexSites = opts.indexSites ?? []
  // Personal seeds first so progress UI / early waves surface people you already
  // play before the global chess-plugin index.
  return dedupeSites([ownSite, ...knownOpponents, ...rosterSites, ...nearbySites, ...indexSites])
}

// Dedupe a list of hosts, preserving first-seen order. Blanks dropped. Each entry is
// normalized via cleanSite so scheme-prefixed URLs and bare hosts dedupe together.
export function dedupeSites(hosts) {
  const seen = new Set()
  const out = []
  for (const h of Array.isArray(hosts) ? hosts : []) {
    const host = cleanSite(h)
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push(host)
  }
  return out
}

// Lower-case + trim a host, dropping a leading scheme or trailing path; '' for blanks.
// Ports are preserved (dev wikis are distinguished by :port, like the rating store). Shared
// by the leaderboard + open-challenges libs so their host normalization can't drift apart.
export function cleanSite(host) {
  return String(host ?? '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .trim()
    .toLowerCase()
}

// Wiki `.json` fetches are full page objects with a `story` array.
export function storyFromWikiPage(page) {
  if (Array.isArray(page?.story)) return page.story
  return []
}

export function titleFromWikiPage(page, slug = '') {
  if (page?.title) return String(page.title).trim()
  return String(slug || '').trim()
}

// ## Double-Entry Twin Verification
//
// A cross-wiki game is forked onto BOTH players' sites, so the same game exists as
// two independent PGN records — "twins". Because no central server arbitrates the
// result, a game is only trusted for rating when its twin is found on both sites AND
// the two copies agree move-for-move and on the terminal headers. This is the chess
// analogue of double-entry bookkeeping: two independently kept ledgers must reconcile
// before a number is believed. Every function is defensive: malformed or partial PGNs
// yield a negative verdict rather than throwing.

// Terminal headers that must agree between twins — the recorded outcome and how the
// game ended. The move list proves the play; these prove the agreed result.
const TERMINAL_TAGS = ['Result', 'Termination']

// The host identity behind a seat's player tag, normalized for pairing. We pair on the
// wiki `domain` (the federated host) rather than the display name, since the display
// name can legitimately differ between sites. Falls back to the bare username, then the
// empty string, so a missing/odd tag can never throw.
function seatSite(tag) {
  const parsed = parsePlayerId(tag)
  return String(parsed?.domain || parsed?.username || '')
    .trim()
    .toLowerCase()
}

// Extract the bare SAN move list from a PGN's movetext, ignoring move numbers, results,
// comments, NAGs and variation parens. Deliberately does NOT validate legality: a
// forged/illegal move must still be comparable so divergence can be detected (legality
// is checked separately by replayLegal). The strip chain is shared with chess-core's
// sanTokens so the two never drift apart.
function sanPlies(pgn) {
  return sanTokens(parsePgnParts(pgn).movetext)
}

// Pull the `(id: …)` game id stamped onto the Site tag. Returns '' when no id is present.
const GAME_ID_TAG_RE = /\(id:\s*([^)]+)\)/i
function pgnGameId(tags) {
  const match = String(tags?.Site || '').match(GAME_ID_TAG_RE)
  return match ? match[1].trim() : ''
}

export function gameFingerprint(pgn) {
  try {
    const { tags } = parsePgnParts(pgn)
    const hosts = [seatSite(tags.White), seatSite(tags.Black)].sort()
    const id = pgnGameId(tags)
    const event = String(tags.Event || '').trim()
    const date = String(tags.Date || '').trim()
    return [...hosts, id || event, date].join('|')
  } catch {
    return ''
  }
}

export function compareGameRecords(pgnA, pgnB) {
  const reasons = []
  try {
    const a = sanPlies(pgnA)
    const b = sanPlies(pgnB)
    // Report the first ply where the lines diverge (including the case where one record
    // is a truncated prefix of the other). Everything after a divergence is a downstream
    // consequence, so a single move reason is the meaningful signal.
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i += 1) {
      if (a[i] !== b[i]) {
        reasons.push(`move ${i + 1} diverges`)
        break
      }
    }

    const tagsA = parsePgnParts(pgnA).tags
    const tagsB = parsePgnParts(pgnB).tags
    for (const tag of TERMINAL_TAGS) {
      if (String(tagsA[tag] || '') !== String(tagsB[tag] || '')) {
        reasons.push(`${tag} mismatch`)
      }
    }
  } catch {
    reasons.push('unparseable record')
  }
  return { match: reasons.length === 0, reasons }
}

export function replayLegal(pgn) {
  const text = String(pgn || '').trim()
  if (!text) return { legal: false, plies: 0, reason: 'empty pgn' }
  try {
    // Canonicalize the header/movetext layout (cm-pgn expects a blank line before the
    // moves); a no-op for already well-formed PGNs.
    const parsed = new Pgn(formatPgn(text))
    return { legal: true, plies: parsed.history.moves.length }
  } catch (err) {
    return { legal: false, plies: 0, reason: err && err.message ? err.message : String(err) }
  }
}

export function auditTwins(localPgn, remotePgn) {
  if (!remotePgn || !String(remotePgn).trim()) {
    return { verified: false, reason: 'no twin / one-sided' }
  }
  try {
    if (gameFingerprint(localPgn) !== gameFingerprint(remotePgn)) {
      return { verified: false, reason: 'fingerprint mismatch / not the same game' }
    }

    const comparison = compareGameRecords(localPgn, remotePgn)
    if (!comparison.match) {
      return { verified: false, reason: `records diverge: ${comparison.reasons.join(', ')}` }
    }

    const localReplay = replayLegal(localPgn)
    if (!localReplay.legal) {
      return { verified: false, reason: `local record illegal: ${localReplay.reason}` }
    }
    const remoteReplay = replayLegal(remotePgn)
    if (!remoteReplay.legal) {
      return { verified: false, reason: `remote record illegal: ${remoteReplay.reason}` }
    }

    return { verified: true, reason: 'twin verified' }
  } catch (err) {
    // The public contract is "never throw": fail closed on any unexpected error.
    return { verified: false, reason: `audit error: ${err && err.message ? err.message : String(err)}` }
  }
}

// Soft audit signal: a rated game on `localSite` expects a twin on `peerSite`, the peer
// site responded as up, but the twin PGN is missing. Also true when the owner stamped
// PeerMissing on their own copy.
export function detectMissingTwinFinding(opts = {}) {
  const { localPgn, peerSite = '', peerUp = false, twinPgn = null } = opts
  const ownSite = opts.localSite ?? ''
  const pgn = String(localPgn || '').trim()
  if (!pgn) return null
  const peer = cleanSite(peerSite)
  if (!peer) return null
  const explicit = readPeerMissingPgnTag(pgn)
  const twinMissing = !twinPgn || !String(twinPgn).trim()
  if (!explicit && !(peerUp && twinMissing)) return null
  const { tagFor } = pgnTagReader(pgn)
  const result = String(tagFor('Result') || '').trim()
  if (!result || result === '*') return null
  if (!readRatedFlag(parsePgnParts(pgn).tags)) return null
  let localSeat = null
  for (const seat of ['White', 'Black']) {
    const parsed = parsePlayerId(tagFor(seat))
    if (parsed && !parsed.isEngine && ownSite && sitesMatch(parsed.domain, ownSite)) {
      localSeat = seat
      break
    }
  }
  const localScore = localSeat ? resultToScore(result, localSeat) : null
  return {
    kind: 'missing-twin',
    peerSite: peer,
    localSite: cleanSite(ownSite),
    fingerprint: gameFingerprint(pgn),
    peerUp: Boolean(peerUp),
    explicitMark: explicit,
    isLocalLoss: localScore === 0,
    reason: explicit ? 'owner marked PeerMissing' : 'peer site up but twin game missing',
  }
}

// Collect missing-twin findings across a pool of local rated games.
export function collectMissingTwinFindings(games, opts = {}) {
  const peerStatusBySite = opts.peerStatusBySite ?? {}
  const localSite = opts.localSite ?? ''
  const list = Array.isArray(games) ? games.filter(g => typeof g === 'string' && g.trim()) : []
  const findings = []
  const seen = new Set()
  for (const pgn of list) {
    const { tagFor } = pgnTagReader(pgn)
    const result = String(tagFor('Result') || '').trim()
    if (!result || result === '*') continue
    if (!readRatedFlag(parsePgnParts(pgn).tags)) continue
    const self = cleanSite(localSite)
    let peer = ''
    for (const seat of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(seat))
      if (!parsed || parsed.isEngine) continue
      const host = cleanSite(parsed.domain)
      if (!host) continue
      if (self && sitesMatch(host, self)) continue
      peer = host
      break
    }
    if (!peer) continue
    const status = peerStatusBySite[peer] || {}
    const finding = detectMissingTwinFinding({
      localPgn: pgn,
      peerSite: peer,
      peerUp: status.up === true,
      twinPgn: status.twinPgn || null,
      localSite: self,
    })
    if (!finding) continue
    const key = `${finding.fingerprint}|${finding.peerSite}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push(finding)
  }
  return findings
}

// Build missing-twin findings from a crawled game pool (peer up = host was crawled).
export function missingTwinFindingsFromPool(games, opts = {}) {
  const localSite = opts.localSite ?? ''
  const fetchedSites = opts.fetchedSites ?? []
  const self = cleanSite(localSite)
  const upSites = new Set(dedupeSites(fetchedSites))
  const list = Array.isArray(games) ? games.filter(g => typeof g === 'string' && g.trim()) : []
  const byFp = new Map()
  for (const pgn of list) {
    const fp = gameFingerprint(pgn)
    if (!fp) continue
    if (!byFp.has(fp)) byFp.set(fp, [])
    byFp.get(fp).push(pgn)
  }
  const peerStatusBySite = {}
  for (const pgn of list) {
    const { tagFor } = pgnTagReader(pgn)
    let localSeat = null
    for (const seat of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(seat))
      if (!parsed || parsed.isEngine) continue
      if (self && sitesMatch(parsed.domain, self)) {
        localSeat = seat
        break
      }
    }
    if (!localSeat) continue
    const oppSeat = localSeat === 'White' ? 'Black' : 'White'
    const opp = parsePlayerId(tagFor(oppSeat))
    const peer = opp && !opp.isEngine ? cleanSite(opp.domain) : ''
    if (!peer) continue
    const fp = gameFingerprint(pgn)
    const copies = byFp.get(fp) || []
    const twin = copies.find(other => {
      if (other === pgn) return false
      const { tagFor: t } = pgnTagReader(other)
      for (const seat of ['White', 'Black']) {
        const parsed = parsePlayerId(t(seat))
        if (parsed && !parsed.isEngine && sitesMatch(parsed.domain, peer)) return true
      }
      return false
    })
    const prev = peerStatusBySite[peer] || { up: upSites.has(peer), twinPgn: null }
    peerStatusBySite[peer] = {
      up: prev.up || upSites.has(peer),
      twinPgn: prev.twinPgn || twin || null,
    }
  }
  return collectMissingTwinFindings(list, { peerStatusBySite, localSite: self })
}

// # Challenges Open Seats and Accept
// An "open challenge" is a real game page with one open seat. Seek config lives in
// PGN tags (Rated, ChallengeCreator, CreatorColor, MinRating, MaxRating, ChallengeTarget,
// ChallengeTs, CreatorRating). Accept = normal edit that fills the open seat.

export const CHALLENGE_STATUS_OPEN = 'open'
export const CHALLENGE_STATUS_ACTIVE = 'active'

export const CHALLENGE_COLOR_WHITE = 'white'
export const CHALLENGE_COLOR_BLACK = 'black'
export const CHALLENGE_COLOR_RANDOM = 'random'

const CHALLENGE_COLORS = new Set([CHALLENGE_COLOR_WHITE, CHALLENGE_COLOR_BLACK, CHALLENGE_COLOR_RANDOM])

export const CHALLENGE_REJECT_BELOW_MIN = 'rating-below-min'
export const CHALLENGE_REJECT_ABOVE_MAX = 'rating-above-max'
export const CHALLENGE_REJECT_UNKNOWN_RATING = 'rating-unknown'
export const CHALLENGE_REJECT_NOT_OPEN = 'challenge-not-open'

function normalizeChallengeColor(value) {
  const color = String(value || '')
    .trim()
    .toLowerCase()
  return CHALLENGE_COLORS.has(color) ? color : CHALLENGE_COLOR_RANDOM
}

function normalizeRatingBound(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

function normalizeChallengeParticipant(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null
  return {
    id,
    site: normalizeWikiSiteInput(raw.site ?? raw.host) || parsePlayerId(id)?.domain || '',
    rating: Number.isFinite(raw.rating) ? Math.round(raw.rating) : null,
  }
}

export function normalizeChallengeState(raw) {
  if (!raw || typeof raw !== 'object') return null
  const creator = normalizeChallengeParticipant(raw.creator)
  if (!creator) return null

  const status = raw.status === CHALLENGE_STATUS_ACTIVE ? CHALLENGE_STATUS_ACTIVE : CHALLENGE_STATUS_OPEN
  const cfg = raw.config && typeof raw.config === 'object' ? raw.config : {}
  const minRating = normalizeRatingBound(cfg.minRating)
  const maxRating = normalizeRatingBound(cfg.maxRating)

  const out = {
    status,
    config: {
      rated: Boolean(cfg.rated),
      creatorColor: normalizeChallengeColor(cfg.creatorColor),
      minRating: minRating != null && maxRating != null ? Math.min(minRating, maxRating) : minRating,
      maxRating: minRating != null && maxRating != null ? Math.max(minRating, maxRating) : maxRating,
    },
    creator,
    ts: Number.isFinite(raw.ts) ? raw.ts : 0,
  }
  const opponent = normalizeChallengeParticipant(raw.opponent)
  if (opponent) out.opponent = opponent
  // Blank ChallengeTarget = open federation seek (not directed at one wiki).
  const challengeTarget = normalizeWikiSiteInput(raw.challengeTarget)
  if (challengeTarget) out.challengeTarget = challengeTarget
  return out
}

export function buildOpenChallenge({
  rated = false,
  creatorColor = CHALLENGE_COLOR_RANDOM,
  minRating = null,
  maxRating = null,
  creatorId = '',
  creatorSite = '',
  creatorRating = null,
  challengeTarget = '',
  ts = Date.now(),
} = {}) {
  return normalizeChallengeState({
    status: CHALLENGE_STATUS_OPEN,
    config: { rated, creatorColor, minRating, maxRating },
    creator: { id: creatorId, site: creatorSite, rating: creatorRating },
    challengeTarget,
    ts,
  })
}

// Build an in-memory challenge descriptor from open-seek PGN tags.
export function openChallengeFromPgn(pgn, { fallbackChallenge = null } = {}) {
  const text = String(pgn || '').trim()
  if (!text || !/\[/.test(text)) return normalizeChallengeState(fallbackChallenge)
  const openSide = openSeatSide(text)
  const creatorTag =
    String(getPgnTag(text, 'ChallengeCreator') || '').trim() ||
    (openSide === 'White' ? getPgnTag(text, 'Black') : openSide === 'Black' ? getPgnTag(text, 'White') : '')
  if (!creatorTag || isOpenSeatTag(creatorTag)) {
    return normalizeChallengeState(fallbackChallenge)
  }
  const parsed = parsePlayerId(creatorTag)
  const ratedTag = getPgnTag(text, 'Rated')
  const rated = ratedTag ? ratedTag.toLowerCase() !== 'no' : false
  const colorTag = String(getPgnTag(text, 'CreatorColor') || '')
    .trim()
    .toLowerCase()
  let creatorColor = CHALLENGE_COLOR_RANDOM
  if (colorTag === 'white' || colorTag === CHALLENGE_COLOR_WHITE) creatorColor = CHALLENGE_COLOR_WHITE
  else if (colorTag === 'black' || colorTag === CHALLENGE_COLOR_BLACK) creatorColor = CHALLENGE_COLOR_BLACK
  else if (colorTag === 'random') creatorColor = CHALLENGE_COLOR_RANDOM
  else if (openSide === 'White') creatorColor = CHALLENGE_COLOR_BLACK
  else if (openSide === 'Black') creatorColor = CHALLENGE_COLOR_WHITE
  const minRaw = getPgnTag(text, 'MinRating')
  const maxRaw = getPgnTag(text, 'MaxRating')
  const ratingRaw = getPgnTag(text, 'CreatorRating')
  const tsRaw = getPgnTag(text, 'ChallengeTs')
  const challengeTarget = normalizeWikiSiteInput(getPgnTag(text, 'ChallengeTarget')) || ''
  const bothFilled = bothSeatsFilled(text)
  // Join ghosts seat both players in the PGN; keep/derive opponent so active
  // challenge state is not stripped when re-parsing from tags.
  const fallback = normalizeChallengeState(fallbackChallenge)
  let opponent = fallback?.opponent || null
  if (bothFilled && !opponent) {
    const white = String(getPgnTag(text, 'White') || '').trim()
    const black = String(getPgnTag(text, 'Black') || '').trim()
    const oppId = white === creatorTag ? black : black === creatorTag ? white : ''
    if (oppId && !isOpenSeatTag(oppId)) {
      opponent = { id: oppId, site: parsePlayerId(oppId)?.domain || '' }
    }
  }
  return normalizeChallengeState({
    status: bothFilled ? CHALLENGE_STATUS_ACTIVE : CHALLENGE_STATUS_OPEN,
    config: {
      rated,
      creatorColor,
      minRating: minRaw != null && minRaw !== '' ? Number(minRaw) : null,
      maxRating: maxRaw != null && maxRaw !== '' ? Number(maxRaw) : null,
    },
    creator: {
      id: creatorTag,
      site: parsed?.domain || '',
      rating: ratingRaw != null && ratingRaw !== '' ? Number(ratingRaw) : null,
    },
    opponent,
    challengeTarget,
    ts: tsRaw != null && tsRaw !== '' ? Number(tsRaw) : 0,
  })
}

// Stamp open-challenge fields onto a seek PGN (source of truth for federation).
export function stampOpenChallengePgn(pgn, challenge) {
  const c = normalizeChallengeState(challenge)
  let next = String(pgn || '')
  if (!c) return formatPgn(next)
  if (c.creator?.id) next = setPgnTag(next, 'ChallengeCreator', c.creator.id)
  const color =
    c.config.creatorColor === CHALLENGE_COLOR_BLACK
      ? 'Black'
      : c.config.creatorColor === CHALLENGE_COLOR_WHITE
        ? 'White'
        : 'Random'
  next = setPgnTag(next, 'CreatorColor', color)
  next = setPgnTag(next, 'Rated', c.config.rated ? 'yes' : 'no')
  if (c.config.minRating != null) next = setPgnTag(next, 'MinRating', String(c.config.minRating))
  if (c.config.maxRating != null) next = setPgnTag(next, 'MaxRating', String(c.config.maxRating))
  // Blank = open seek; omit the tag rather than writing an empty value.
  if (c.challengeTarget) next = setPgnTag(next, 'ChallengeTarget', c.challengeTarget)
  if (c.ts) next = setPgnTag(next, 'ChallengeTs', String(c.ts))
  if (c.creator?.rating != null) next = setPgnTag(next, 'CreatorRating', String(c.creator.rating))
  return formatPgn(next)
}

export function isOpenChallenge(challenge) {
  return normalizeChallengeState(challenge)?.status === CHALLENGE_STATUS_OPEN
}

export function challengeRatingGate(challenge, viewerRating) {
  const c = normalizeChallengeState(challenge)
  if (!c || c.status !== CHALLENGE_STATUS_OPEN) {
    return { ok: false, reason: CHALLENGE_REJECT_NOT_OPEN }
  }
  const { minRating, maxRating } = c.config
  if (minRating == null && maxRating == null) return { ok: true, reason: null }

  const rating = Number.isFinite(viewerRating) ? Math.round(viewerRating) : null
  if (rating == null) return { ok: false, reason: CHALLENGE_REJECT_UNKNOWN_RATING }
  if (minRating != null && rating < minRating) {
    return { ok: false, reason: CHALLENGE_REJECT_BELOW_MIN }
  }
  if (maxRating != null && rating > maxRating) {
    return { ok: false, reason: CHALLENGE_REJECT_ABOVE_MAX }
  }
  return { ok: true, reason: null }
}

export function stableSeatHash(idA, idB) {
  const pair = [
    String(idA || '')
      .trim()
      .toLowerCase(),
    String(idB || '')
      .trim()
      .toLowerCase(),
  ]
    .sort()
    .join('|')
  let hash = 2166136261
  for (let i = 0; i < pair.length; i += 1) {
    hash ^= pair.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function resolveChallengeJoinerColor(challenge, creatorId, joinerId) {
  const c = normalizeChallengeState(challenge)
  const pref = c?.config.creatorColor || CHALLENGE_COLOR_RANDOM
  if (pref === CHALLENGE_COLOR_WHITE) return 'b'
  if (pref === CHALLENGE_COLOR_BLACK) return 'w'
  const creatorIsWhite = (stableSeatHash(creatorId, joinerId) & 1) === 0
  return creatorIsWhite ? 'b' : 'w'
}

// Seat both players on a ghost seek PGN for a join ghost — the joiner is shown as
// already seated; forking the page is the acceptance step.
export function buildChallengeJoinGhostPgn(pgn, challenge, joinerId) {
  const c = normalizeChallengeState(challenge)
  const ghostPgn = String(pgn || '').trim()
  const joiner = String(joinerId || '').trim()
  if (!c || !ghostPgn || !joiner) return ghostPgn
  const creatorId = String(c.creator?.id || '').trim()
  if (!creatorId) return ghostPgn
  const joinerColor = resolveChallengeJoinerColor(c, creatorId, joiner)
  const joinerSeat = joinerColor === 'b' ? 'Black' : 'White'
  const creatorSeat = joinerColor === 'b' ? 'White' : 'Black'
  let next = setPgnTag(ghostPgn, joinerSeat, joiner)
  next = setPgnTag(next, creatorSeat, creatorId)
  return formatPgn(next)
}

export function acceptOpenChallenge(
  challenge,
  { joinerId = '', joinerSite = '', joinerRating = null, ts = Date.now() } = {},
) {
  const c = normalizeChallengeState(challenge)
  if (!c) return null
  const opponent = normalizeChallengeParticipant({ id: joinerId, site: joinerSite, rating: joinerRating })
  if (!opponent) return c
  return normalizeChallengeState({ ...c, status: CHALLENGE_STATUS_ACTIVE, opponent, ts })
}

// True when a chess item is an accepted federation open seek (joiner forked in).
export function isAcceptedGhostJoinGame(item) {
  const challenge = normalizeChallengeState(item?.challenge)
  const pgn = String(item?.text || item?.pgn || '').trim()
  if (!challenge || challenge.status !== CHALLENGE_STATUS_ACTIVE) return false
  if (challenge.challengeTarget) return false
  if (!String(challenge.creator?.id || '').trim() || !String(challenge.opponent?.id || '').trim()) {
    return false
  }
  return bothSeatsFilled(pgn)
}

// Undo a joiner's seat claim to recover the ghost board for journal replay.
export function reconstructGhostPgnFromSeated(seatedPgn, challenge) {
  const c = normalizeChallengeState(challenge)
  const seated = String(seatedPgn || '').trim()
  const creatorId = String(c?.creator?.id || '').trim()
  const joinerId = String(c?.opponent?.id || '').trim()
  if (!c || !seated || !creatorId || !joinerId) return ''
  const joinerColor = resolveChallengeJoinerColor(c, creatorId, joinerId)
  const openSeat = joinerColor === 'b' ? 'Black' : 'White'
  return formatPgn(setPgnTag(seated, openSeat, ''))
}

// # Challenges Discovery and Lobby

export function normalizeOpenChallengeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const challenge = normalizeChallengeState(raw.challenge)
  if (!challenge || challenge.status !== CHALLENGE_STATUS_OPEN) return null
  const site = cleanSite(raw.site ?? raw.host ?? challenge.creator?.site ?? challenge.creator?.host)
  const itemId = String(raw.itemId || '').trim()
  const pgn = String(raw.pgn || '').trim()
  const pending = raw.pending === true
  const slug = String(raw.slug || '').trim()
  const challengeTarget = cleanSite(challenge.challengeTarget)
  if (!site || !itemId) return null
  // Federation open seek — ghost item (pending) or a real game page with one open seat.
  if (!challengeTarget) {
    if (pending) {
      if (!pgn) return null
      return {
        site,
        slug: '',
        title: String(raw.title || '').trim() || 'Open challenge',
        itemId,
        challenge,
        pending: true,
        pgn,
        ts: Number.isFinite(challenge.ts) ? challenge.ts : 0,
      }
    }
    if (!slug || !pgn) return null
    return {
      site,
      slug,
      title: String(raw.title || '').trim() || slug,
      itemId,
      challenge,
      pending: false,
      pgn,
      ts: Number.isFinite(challenge.ts) ? challenge.ts : 0,
    }
  }
  // Direct wiki invite — pending on SURVEY metadata, or a real game page until accepted.
  if (pending) {
    if (!pgn) return null
    return {
      site,
      slug: '',
      title: String(raw.title || '').trim() || 'Open challenge',
      itemId,
      challenge,
      pending: true,
      pgn,
      ts: Number.isFinite(challenge.ts) ? challenge.ts : 0,
    }
  }
  if (!slug) return null
  return {
    site,
    slug,
    title: String(raw.title || '').trim() || slug,
    itemId,
    challenge,
    pending: false,
    pgn: '',
    ts: Number.isFinite(challenge.ts) ? challenge.ts : 0,
  }
}

export function harvestPageOpenChallenge(raw) {
  if (!raw || typeof raw !== 'object') return null
  const pgn = String(raw.pgn || '').trim()
  if (!pgn || !isPageOpenChallengePgn(pgn)) return null
  if (pgnHasMoves(pgn)) return null
  const challenge = openChallengeFromPgn(pgn, { fallbackChallenge: raw.challenge })
  if (!challenge || !isOpenChallenge(challenge)) return null
  const site = cleanSite(raw.site ?? raw.host ?? challenge.creator?.site ?? challenge.creator?.host)
  const slug = String(raw.slug || '').trim()
  const itemId = String(raw.itemId || '').trim()
  if (!site || !slug || !itemId) return null
  return normalizeOpenChallengeEntry({
    site,
    slug,
    title: String(raw.title || '').trim() || slug,
    itemId,
    challenge,
    pending: false,
    pgn,
  })
}

export function harvestDirectChallenge(raw) {
  if (!raw || typeof raw !== 'object') return null
  const pgn = String(raw.pgn || '').trim()
  if (!pgn || !/\[/.test(pgn)) return null
  const fromPgn = openChallengeFromPgn(pgn, { fallbackChallenge: raw.challenge })
  if (fromPgn && isOpenChallenge(fromPgn) && fromPgn.challengeTarget) {
    const site = cleanSite(raw.site ?? raw.host ?? fromPgn.creator?.site ?? fromPgn.creator?.host)
    const slug = String(raw.slug || '').trim()
    const itemId = String(raw.itemId || '').trim()
    if (!site || !slug || !itemId) return null
    return normalizeOpenChallengeEntry({
      site,
      slug,
      title: String(raw.title || '').trim() || slug,
      itemId,
      challenge: fromPgn,
      pending: false,
      pgn,
    })
  }
  // Directed invite: PGN ChallengeTarget only.
  if (raw.challenge && isOpenChallenge(raw.challenge) && !raw.challenge.challengeTarget) return null
  const challengeTarget = challengeOpponentWikiSite(pgn)
  if (!challengeTarget) return null
  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')
  const whiteOpen = isOpenSeatTag(white)
  const blackOpen = isOpenSeatTag(black)
  if (whiteOpen === blackOpen) return null
  const creatorTag = whiteOpen ? black : white
  if (!creatorTag || isOpenSeatTag(creatorTag)) return null
  const parsed = parsePlayerId(creatorTag)
  if (!parsed?.domain) return null
  const ratedTag = getPgnTag(pgn, 'Rated')
  const rated = ratedTag ? ratedTag.toLowerCase() !== 'no' : true
  const settings = normalizeGameSettings(raw.gameSettings)
  let creatorColor = whiteOpen ? CHALLENGE_COLOR_BLACK : CHALLENGE_COLOR_WHITE
  if (settings.challengeCreatorColor === CHALLENGE_COLOR_RANDOM) {
    creatorColor = CHALLENGE_COLOR_RANDOM
  }
  const site = cleanSite(raw.site ?? raw.host ?? parsed.domain)
  const slug = String(raw.slug || '').trim()
  const itemId = String(raw.itemId || '').trim()
  if (!site || !slug || !itemId) return null
  const challenge = normalizeChallengeState({
    status: CHALLENGE_STATUS_OPEN,
    config: { rated, creatorColor, minRating: null, maxRating: null },
    creator: { id: creatorTag, site: parsed.domain, rating: null },
    challengeTarget,
    ts: Number.isFinite(raw.ts) ? raw.ts : 0,
  })
  if (!challenge) return null
  return {
    site,
    slug,
    title: String(raw.title || '').trim() || slug,
    itemId,
    challenge,
    ts: challenge.ts || 0,
  }
}

// Joiner forked a ghost seek onto their wiki — the game page carries the same item id
// as the creator's ghost seek item on My Chess Games and an active challenge descriptor.
export function harvestAcceptedGhostGame(raw) {
  if (!raw || typeof raw !== 'object') return null
  const challenge = normalizeChallengeState(raw.challenge)
  if (!challenge || challenge.status !== CHALLENGE_STATUS_ACTIVE) return null
  if (challenge.challengeTarget) return null
  const joinerSite = cleanSite(challenge.opponent?.site ?? challenge.opponent?.host)
  const creatorSite = cleanSite(challenge.creator?.site ?? challenge.creator?.host)
  const pageSite = cleanSite(raw.site ?? raw.host)
  const slug = String(raw.slug || '').trim()
  const itemId = String(raw.itemId || '').trim()
  if (!joinerSite || !creatorSite || !pageSite || !slug || !itemId) return null
  if (!sitesMatch(pageSite, joinerSite) || sitesMatch(pageSite, creatorSite)) return null
  const pgn = String(raw.pgn || '').trim()
  return {
    site: pageSite,
    slug,
    title: String(raw.title || '').trim() || slug,
    itemId,
    challenge,
    pgn,
    pending: false,
    accepted: true,
    ts: Number.isFinite(challenge.ts) ? challenge.ts : 0,
  }
}

// Match federation-discovered acceptances to the creator's own ghost seeks.
export function attachGhostAcceptances(entries, acceptedGames, viewingSite) {
  const self = cleanSite(viewingSite)
  if (!self) return Array.isArray(entries) ? entries : []
  const byGhostId = new Map()
  for (const raw of Array.isArray(acceptedGames) ? acceptedGames : []) {
    const id = String(raw?.itemId || '').trim()
    if (!id || !sitesMatch(raw?.challenge?.creator?.site ?? raw?.challenge?.creator?.host, self)) continue
    byGhostId.set(id, raw)
  }
  return (Array.isArray(entries) ? entries : []).map(entry => {
    if (!entry || !sitesMatch(entry.site ?? entry.host, self) || !entry.pending) return entry
    const acceptance = byGhostId.get(String(entry.itemId || '').trim())
    if (!acceptance) return entry
    const opponentLabel =
      playerDisplayLabel(acceptance.challenge?.opponent?.id || '') || acceptance.site || acceptance.host
    return {
      ...entry,
      accepted: true,
      acceptedGame: {
        site: acceptance.site ?? acceptance.host,
        slug: acceptance.slug,
        title: acceptance.title,
      },
      opponentLabel,
      pgn: acceptance.pgn || entry.pgn,
      challenge: acceptance.challenge || entry.challenge,
    }
  })
}

// Dedupe key: ghost seeks by site+itemId; direct invites by site+slug+itemId.
function entryKey(e) {
  const site = e?.site ?? e?.host
  if (e.pending || !String(e.slug || '').trim()) return `${site}|pending|${e.itemId}`
  return `${site}|${e.slug}|${e.itemId}`
}

function normalizeOpenChallengeAliases(row) {
  if (!row || typeof row !== 'object') return row
  const site = row.site ?? row.host
  const { host: _legacyHost, acceptedGame: rawAcceptedGame, ...rest } = row
  const challenge = normalizeChallengeState(row.challenge)
  const acceptedGame =
    rawAcceptedGame && typeof rawAcceptedGame === 'object'
      ? {
          site: rawAcceptedGame.site ?? rawAcceptedGame.host,
          slug: rawAcceptedGame.slug,
          title: rawAcceptedGame.title,
        }
      : rawAcceptedGame
  return {
    ...rest,
    ...(site == null ? {} : { site }),
    ...(challenge ? { challenge } : {}),
    ...(acceptedGame ? { acceptedGame } : {}),
  }
}

export function mergeOpenChallengeEntries(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row) continue
      const normalized = normalizeOpenChallengeAliases(row)
      const key = entryKey(normalized)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(normalized)
    }
  }
  out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
  return out
}

export function partitionOpenChallenges(entries, { viewingSite = '', viewerRating = null, acceptedGhosts = [] } = {}) {
  const self = cleanSite(viewingSite)
  const rating = Number.isFinite(viewerRating) ? Number(viewerRating) : null
  const seen = new Set()
  const joinable = []
  const mine = []
  const acceptedMine = []
  const directedAtMe = []
  const acceptedRows = Array.isArray(acceptedGhosts) ? acceptedGhosts : []
  const acceptedGhostIds = new Set(acceptedRows.map(row => String(row?.itemId || '').trim()).filter(Boolean))
  const acceptedById = new Map(acceptedRows.map(row => [String(row?.itemId || '').trim(), row]).filter(([id]) => id))
  const enriched = attachGhostAcceptances(entries, acceptedGhosts, viewingSite)
  for (const raw of enriched) {
    const ghostItemId = String(raw?.itemId || '').trim()
    const federationAccepted = ghostItemId && acceptedGhostIds.has(ghostItemId)
    const isAcceptedOwn = Boolean(raw?.accepted && raw?.acceptedGame) || federationAccepted
    // Own seek accepted on a joiner wiki — keep a fork-back row (not a joinable open seat).
    if (isAcceptedOwn) {
      const rawSite = raw?.site ?? raw?.host
      if (!self || !sitesMatch(rawSite, self)) continue
      const creatorSite = cleanSite(raw?.challenge?.creator?.site ?? raw?.challenge?.creator?.host)
      if (creatorSite && !sitesMatch(creatorSite, self)) continue
      const acceptance = acceptedById.get(ghostItemId) || raw
      const key = `${cleanSite(rawSite)}|pending|${ghostItemId || raw.itemId}`
      if (seen.has(key)) continue
      seen.add(key)
      const acceptedSource = raw.acceptedGame || acceptance
      const acceptedGame = {
        site: acceptedSource.site ?? acceptedSource.host,
        slug: acceptedSource.slug,
        title: acceptedSource.title,
      }
      acceptedMine.push({
        site: cleanSite(rawSite),
        slug: String(raw.slug || '').trim(),
        title: String(raw.title || acceptedGame.title || '').trim() || 'Accepted challenge',
        itemId: ghostItemId || String(raw.itemId || '').trim(),
        pending: raw.pending === true,
        accepted: true,
        acceptedGame,
        opponentLabel:
          raw.opponentLabel ||
          playerDisplayLabel(acceptance.challenge?.opponent?.id || '') ||
          acceptedGame.site ||
          acceptedGame.host,
        challenge: acceptance.challenge || raw.challenge,
        pgn: acceptance.pgn || raw.pgn || '',
        ts: Number(raw.ts) || Number(acceptance.ts) || 0,
      })
      continue
    }
    const entry = normalizeOpenChallengeEntry(raw)
    if (!entry) continue
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    if (self && sitesMatch(entry.site, self)) {
      const creatorSite = cleanSite(entry.challenge?.creator?.site ?? entry.challenge?.creator?.host)
      // Forked My Chess Games pages can carry stale open-challenge metadata from another
      // wiki — only seeks whose creator matches this host are authoritative here.
      if (creatorSite && !sitesMatch(creatorSite, self)) continue
      mine.push(entry)
      continue
    }
    const target = cleanSite(entry.challenge?.challengeTarget)
    if (target) {
      if (self && sitesMatch(target, self)) {
        directedAtMe.push({ ...entry, canJoin: true, reason: null })
      }
      continue
    }
    const gate = challengeRatingGate(entry.challenge, rating)
    joinable.push({ ...entry, canJoin: gate.ok, reason: gate.reason })
  }
  const byNewest = (a, b) => (b.ts || 0) - (a.ts || 0)
  joinable.sort(byNewest)
  mine.sort(byNewest)
  acceptedMine.sort(byNewest)
  directedAtMe.sort(byNewest)
  return { joinable, mine, acceptedMine, directedAtMe }
}

// # Challenges Display Helpers

export function formatChallengeRange(min, max) {
  if (min != null && max != null) return `${min}\u2013${max}`
  if (min != null) return `\u2265 ${min}`
  if (max != null) return `\u2264 ${max}`
  return 'any rating'
}

export function challengeColorLabel(creatorColor) {
  if (creatorColor === CHALLENGE_COLOR_WHITE) return 'creator plays White'
  if (creatorColor === CHALLENGE_COLOR_BLACK) return 'creator plays Black'
  return 'random colors'
}

// PWA join-ghost: page chrome replaces the wiki fork banner.
export function shouldDismissChallengeJoinGhostForPwa({
  challengeJoinGhost = false,
  pwaBridgeActive = false,
  pgn = '',
  challenge = null,
} = {}) {
  return Boolean(challengeJoinGhost && pwaBridgeActive && pgn && challenge)
}

// Wiki embed join-ghost: prompt fork onto viewer wiki.
export function shouldShowChallengeJoinGhostForkBanner({
  challengeJoinGhost = false,
  wikiFrame = null,
  pgn = '',
  challenge = null,
} = {}) {
  return Boolean(challengeJoinGhost && wikiFrame && pgn && challenge)
}

// Open seek banner for wiki embed viewers.
export function shouldShowOpenChallengeBanner({
  wikiFrame = null,
  pgn = '',
  challenge = null,
  seatsFilled = false,
} = {}) {
  return Boolean(wikiFrame && pgn && challenge && isOpenChallenge(challenge) && !seatsFilled)
}

// Ghost open seeks advertise a provisional title (`Creator vs Open`) before anyone sits.
// That string is not a real game page title and must not block substituting the joiner.
export function isGhostProposedTitle(title = '') {
  const t = String(title || '').trim()
  if (!t) return false
  const placeholder = '(?:open|you|guest)'
  return new RegExp(`\\b${placeholder}\\s+vs\\s+|\\bvs\\s+${placeholder}\\s*$`, 'i').test(t)
}

// Title for a forkable ghost when joining someone else's open challenge. Prefer a
// custom remote page title when it is already a proper game name; otherwise build
// White vs Black from the same seat resolution as buildChallengeJoinGhostPgn.
// Random seeks must not assume the creator is White — that produced titles like
// "Olga vs Bjorn" when the hash seated Bjorn as White.
// When the remote title still advertises [open-seat] / Open, rebuild White-first.
export function proposeOpenChallengePageTitle(challenge, joinerDisplayName, remoteTitle = '', { joinerId = '' } = {}) {
  const remote = String(remoteTitle || '').trim()
  const joiner = String(joinerDisplayName || 'You').trim() || 'You'
  const creatorId = String(challenge?.creator?.id || '').trim()
  const creatorName = seatResultBannerName(creatorId) || 'Opponent'
  const seatKey = String(joinerId || '').trim() || joiner
  const joinerColor = resolveChallengeJoinerColor(challenge, creatorId, seatKey)
  const whiteVsBlack = joinerColor === 'w' ? `${joiner} vs ${creatorName}` : `${creatorName} vs ${joiner}`

  const boring = new Set([SURVEY_PAGE_TITLE.toLowerCase(), SURVEY_PAGE_SLUG.replace(/-/g, ' '), SURVEY_PAGE_SLUG])
  if (
    remote &&
    !boring.has(remote.toLowerCase()) &&
    !isGhostProposedTitle(remote) &&
    !isAutoBuiltChallengePageTitle(remote)
  ) {
    return remote
  }
  return whiteVsBlack
}

const OPEN_SEAT_TITLE_LABEL = '[open-seat]'

function isGenericChessPageTitle(title = '') {
  const t = String(title || '')
    .trim()
    .toLowerCase()
  return /^(new chess (game|page|position|puzzle)|chess (game|position|puzzle))(\s*\(\d+\))?$/.test(t)
}

// Titles auto-built from the start-game modal — safe to replace while the form changes.
export function isAutoBuiltChallengePageTitle(title = '') {
  const t = String(title || '').trim()
  if (!t) return false
  if (/\bplays\b.+\bvs\b.+\s-\s*(Rated|Casual)\s*$/i.test(t)) return true
  if (/\bchallenges\b.+?\bto\s+(rated|casual)\s+game\s+playing\s+as\b/i.test(t)) return true
  // Joiner-facing open-seek titles: "Play Black vs Frank" / "Play Random vs Frank".
  if (/^Play (White|Black|Random) vs /i.test(t)) return true
  if (/\s+vs\s+\[open-seat\]\s*$/i.test(t)) return true
  if (/^\[open-seat\]\s+vs\s+/i.test(t)) return true
  return false
}

// Generic ghost titles from CHOOSE-menu / paste flows — safe to replace from the modal.
export function isReplaceableGhostPageTitle(title = '') {
  const t = String(title || '').trim()
  if (!t) return true
  if (isGhostProposedTitle(title)) return true
  if (isGenericChessPageTitle(t)) return true
  if (isAutoBuiltChallengePageTitle(t)) return true
  return false
}

// Generic ghost titles from CHOOSE-menu / paste flows — safe to replace from the modal.
export function fallbackWikiSiteDisplayLabel(host) {
  const h = normalizeWikiSiteInput(host)
  if (!h) return ''
  const base = h.split(':')[0]
  const part = base.split('.')[0]
  if (!part || part === 'localhost' || part === 'www') return base
  return part.charAt(0).toUpperCase() + part.slice(1)
}

export function displayNameFromWikiOwnerPayload(payload) {
  if (payload == null) return ''
  const raw =
    typeof payload === 'string' ? payload.trim() : String(payload.name || payload.owner || payload.title || '').trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string') return resolveSignedInUsername(parsed) || parsed
    if (parsed && typeof parsed === 'object') {
      return (
        resolveSignedInUsername(parsed.name || parsed.owner || parsed.title || '') ||
        String(parsed.name || parsed.owner || parsed.title || '').trim()
      )
    }
  } catch {
    /* plain text owner name */
  }
  return resolveSignedInUsername(raw) || raw
}

async function fetchWikiHostResource(host, slug, fetchFn, { allowHttpFallback = false, timeoutMs = 5000 } = {}) {
  return fetchWikiResourceWithProtocolFallback(host, slug, {
    fetchFn,
    allowHttpFallback,
    timeoutMs,
  })
}

async function readWikiSiteOwnerDisplayName(host, fetchFn, opts) {
  const res = await fetchWikiHostResource(host, 'status/owner.json', fetchFn, opts)
  if (!res) return ''
  const text = await res.text()
  return displayNameFromWikiOwnerPayload(text)
}

async function readWikiSiteWelcomeDisplayName(host, fetchFn, opts) {
  const res = await fetchWikiHostResource(host, 'welcome-visitors.json', fetchFn, opts)
  if (!res) return ''
  try {
    const page = await res.json()
    const title = String(page?.title || '').trim()
    if (!title || /^welcome/i.test(title)) return ''
    return resolveSignedInUsername(title) || title
  } catch {
    return ''
  }
}

async function wikiSiteHasSitemap(host, fetchFn, opts) {
  const res = await fetchWikiHostResource(host, 'system/sitemap.json', fetchFn, opts)
  if (!res) return false
  try {
    return Array.isArray(await res.json())
  } catch {
    return false
  }
}

async function readWikiSiteOwnerDisplayNameViaGetPage(host, getPage) {
  try {
    const data = await getPage(host, 'status/owner.json')
    if (data == null) return ''
    return displayNameFromWikiOwnerPayload(typeof data === 'string' ? data : JSON.stringify(data))
  } catch {
    return ''
  }
}

async function readWikiSiteWelcomeDisplayNameViaGetPage(host, getPage) {
  try {
    const page = await getPage(host, 'welcome-visitors.json')
    if (!page || typeof page !== 'object') return ''
    const title = String(page?.title || '').trim()
    if (!title || /^welcome/i.test(title)) return ''
    return resolveSignedInUsername(title) || title
  } catch {
    return ''
  }
}

async function wikiSiteHasSitemapViaGetPage(host, getPage) {
  try {
    const data = await getPage(host, 'system/sitemap.json')
    if (Array.isArray(data)) return data.length >= 0
    // wiki.site sitemap shape: { data: [...], lastModified }
    if (Array.isArray(data?.data)) return true
    return false
  } catch {
    return false
  }
}

export function wikiSiteValidationErrorMessage(error) {
  if (error === 'invalid-format') {
    return 'Enter a wiki domain like username.example.co — not a page path or invalid URL.'
  }
  if (error === 'unreachable') {
    return 'Could not reach a wiki at that address. Check the domain and try again.'
  }
  return 'That does not look like a wiki site.'
}

// Verify a host is a reachable wiki before using its display name in challenge setup.
// Prefer `getPage` (wiki.site / PWA bridge) so HTTPS pages use /proxy/ and avoid CORS.
// `allowHttpFallback` is for Node/server only — browsers must not retry http (mixed content).
export async function probeWikiSite(host, { fetchFn, getPage, allowHttpFallback = false } = {}) {
  const raw = String(host || '').trim()
  if (!raw) return { valid: true, displayName: '' }

  const h = normalizeWikiSiteInput(host)
  if (!h) return { valid: false, error: 'invalid-format', displayName: '' }

  if (typeof getPage === 'function') {
    const displayName =
      (await readWikiSiteOwnerDisplayNameViaGetPage(h, getPage)) ||
      (await readWikiSiteWelcomeDisplayNameViaGetPage(h, getPage))
    if (displayName) return { valid: true, displayName }
    if (await wikiSiteHasSitemapViaGetPage(h, getPage)) {
      return { valid: true, displayName: fallbackWikiSiteDisplayLabel(h) }
    }
    return { valid: false, error: 'unreachable', displayName: '' }
  }

  const fetch = fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetch) return { valid: false, error: 'unreachable', displayName: '' }

  const fetchOpts = { allowHttpFallback }
  const displayName =
    (await readWikiSiteOwnerDisplayName(h, fetch, fetchOpts)) ||
    (await readWikiSiteWelcomeDisplayName(h, fetch, fetchOpts))
  if (displayName) return { valid: true, displayName }

  if (await wikiSiteHasSitemap(h, fetch, fetchOpts)) {
    return { valid: true, displayName: fallbackWikiSiteDisplayLabel(h) }
  }

  return { valid: false, error: 'unreachable', displayName: '' }
}

function resolveMatchupSeatNames({
  opponent = 'engine',
  humanPlayMode = HUMAN_PLAY_CORRESPONDENCE,
  localSeat = 'w',
  stockfishLevel = 1,
  isOpenChallenge = false,
  creatorColor,
  localPlayerName = '',
  opponentWikiSite = '',
  opponentDisplayName = '',
} = {}) {
  const localName = String(localPlayerName || 'You').trim() || 'You'

  if (opponent === 'human' && humanPlayMode === HUMAN_PLAY_SAME_DEVICE) {
    return { whiteName: 'Player 1', blackName: 'Player 2' }
  }

  let opponentName = OPEN_SEAT_TITLE_LABEL
  if (!isOpenChallenge) {
    if (opponent === 'engine') {
      opponentName = stockfishPlayerId(stockfishLevel)
    } else {
      const host = normalizeWikiSiteInput(opponentWikiSite)
      const resolved = String(opponentDisplayName || '').trim()
      opponentName = resolved || (host ? fallbackWikiSiteDisplayLabel(host) : OPEN_SEAT_TITLE_LABEL)
    }
  }

  const resolvedCreatorColor =
    creatorColor === CHALLENGE_COLOR_RANDOM ||
    creatorColor === CHALLENGE_COLOR_WHITE ||
    creatorColor === CHALLENGE_COLOR_BLACK
      ? creatorColor
      : isOpenChallenge
        ? CHALLENGE_COLOR_RANDOM
        : localSeat === 'b'
          ? CHALLENGE_COLOR_BLACK
          : CHALLENGE_COLOR_WHITE

  const effectiveLocalSeat = isOpenChallenge ? (resolvedCreatorColor === CHALLENGE_COLOR_BLACK ? 'b' : 'w') : localSeat

  if (effectiveLocalSeat === 'b') {
    return { whiteName: opponentName, blackName: localName }
  }
  return { whiteName: localName, blackName: opponentName }
}

// Title proposed in the new-game modal. Open federation seeks advertise the colour
// the joiner will play (or Random); other games stay White vs Black.
export function proposeNewGamePageTitle(params = {}) {
  if (params.isOpenChallenge) {
    const hostName = String(params.localPlayerName || 'You').trim() || 'You'
    const color = params.creatorColor
    if (color === CHALLENGE_COLOR_BLACK) return `Play White vs ${hostName}`
    if (color === CHALLENGE_COLOR_WHITE) return `Play Black vs ${hostName}`
    return `Play Random vs ${hostName}`
  }
  const { whiteName, blackName } = resolveMatchupSeatNames(params)
  return `${whiteName} vs ${blackName}`
}

// Human-facing label for an open challenge in survey / lobby lists. Reuses a custom
// stored title when present; otherwise rebuilds from challenge metadata so generic
// page names and older "[open-seat]" auto-titles still read well in My Chess Games.
export function openChallengeDisplayTitle({ challenge, title = '', opponentDisplayName = '' } = {}) {
  const stored = String(title || '').trim()
  const c = normalizeChallengeState(challenge)
  if (!c) return stored || 'Open challenge'

  if (
    stored &&
    !isReplaceableGhostPageTitle(stored) &&
    !isGhostProposedTitle(stored) &&
    !isAutoBuiltChallengePageTitle(stored)
  ) {
    return stored
  }

  const creatorName = seatResultBannerName(c.creator?.id || '') || 'You'
  const challengeTarget = c.challengeTarget || ''
  return proposeNewGamePageTitle({
    opponent: 'human',
    isOpenChallenge: !challengeTarget,
    creatorColor: c.config?.creatorColor || CHALLENGE_COLOR_RANDOM,
    rated: Boolean(c.config?.rated),
    localPlayerName: creatorName,
    opponentWikiSite: challengeTarget,
    opponentDisplayName,
  })
}

export function harvestGhostOpenChallenge(raw) {
  if (!raw || typeof raw !== 'object') return null
  const challenge = normalizeChallengeState(raw.challenge)
  if (!challenge || !isOpenChallenge(challenge)) return null
  const site = cleanSite(raw.site ?? raw.host ?? challenge.creator?.site ?? challenge.creator?.host)
  const itemId = String(raw.itemId || '').trim()
  const pgn = String(raw.pgn || '').trim()
  if (!site || !itemId || !pgn) return null
  return normalizeOpenChallengeEntry({
    site,
    slug: String(raw.slug || '').trim(),
    title: String(raw.title || '').trim() || 'Open challenge',
    itemId,
    challenge,
    pending: true,
    pgn,
  })
}

// Open challenges posted after the survey-metadata change are stored on the SURVEY item
// (`openChallenges`), not as sibling chess boards on My Chess Games.
export function openChallengeSurveyRecord(challenge, { itemId, pgn, title } = {}) {
  const normalized = normalizeChallengeState(challenge)
  const id = String(itemId || '').trim()
  const embeddedPgn = String(pgn || '').trim()
  if (!normalized || !isOpenChallenge(normalized) || !id || !embeddedPgn) return null
  return {
    itemId: id,
    pgn: embeddedPgn,
    title: String(title || '').trim() || 'Open challenge',
    challenge: normalized,
  }
}

export function openChallengeSurveyAuthoritative(pageSite, challenge) {
  const host = cleanSite(pageSite)
  const creatorSite = cleanSite(challenge?.creator?.site ?? challenge?.creator?.host)
  return Boolean(host && creatorSite && sitesMatch(host, creatorSite))
}

// Item ids in SURVEY `openChallenges` whose creator is another wiki (stale fork copies).
export function foreignOpenChallengeItemIds(story, pageSite) {
  const host = cleanSite(pageSite)
  if (!host) return []
  const surveyItem = findSurveyItem(Array.isArray(story) ? story : [])
  const records = Array.isArray(surveyItem?.openChallenges) ? surveyItem.openChallenges : []
  return records
    .filter(row => {
      const creatorSite = cleanSite(row?.challenge?.creator?.site ?? row?.challenge?.creator?.host)
      return creatorSite && !sitesMatch(creatorSite, host)
    })
    .map(row => String(row?.itemId || '').trim())
    .filter(Boolean)
}

export function harvestSurveyOpenChallenges(page, host, slug) {
  const story = Array.isArray(page?.story) ? page.story : []
  const pageSite = cleanSite(host)
  const pageSlug = String(slug || '').trim()
  if (!pageSite) return []
  const out = []
  for (const entry of story) {
    if (entry?.type !== 'chess' || !isSurveyItemText(entry.text)) continue
    const records = Array.isArray(entry.openChallenges) ? entry.openChallenges : []
    for (const raw of records) {
      const challenge = normalizeChallengeState(raw?.challenge)
      if (!openChallengeSurveyAuthoritative(pageSite, challenge)) continue
      const harvested = harvestGhostOpenChallenge({
        site: pageSite,
        slug: pageSlug,
        title: raw?.title,
        itemId: raw?.itemId,
        pgn: raw?.pgn,
        challenge,
      })
      if (harvested) out.push(harvested)
    }
  }
  return out
}

export function applyOpenChallengeSurveyEdit(surveyItem, { add = null, removeIds = [] } = {}) {
  if (!surveyItem || surveyItem.type !== 'chess' || !isSurveyItemText(surveyItem.text)) return null
  const ids = new Set((Array.isArray(removeIds) ? removeIds : []).map(id => String(id || '').trim()).filter(Boolean))
  let list = Array.isArray(surveyItem.openChallenges) ? [...surveyItem.openChallenges] : []
  if (ids.size) list = list.filter(row => !ids.has(String(row?.itemId || '').trim()))
  if (add) {
    const record = openChallengeSurveyRecord(add.challenge, {
      itemId: add.itemId,
      pgn: add.pgn,
      title: add.title,
    })
    if (!record) return null
    const idx = list.findIndex(row => String(row?.itemId || '').trim() === record.itemId)
    if (idx >= 0) list[idx] = record
    else list.push(record)
  }
  const next = { ...surveyItem }
  if (list.length) next.openChallenges = list
  else delete next.openChallenges
  return next
}

// # LeaderboardMeta Survey and Leaderboard Pages
// POSITION / PUZZLE / CHOOSE). A site opts in by publishing one of these.
export const SURVEY_KEYWORD = 'SURVEY'

// Default survey identifier (only the global survey is supported).
export const DEFAULT_SURVEY_ID = 'global'

// The well-known page every participant forks onto their own site: "My Chess Games".
// It carries a single static `SURVEY` chess item. Pending open challenges are indexed
// on that item as `openChallenges` metadata until an opponent accepts and a game page
// is created. Playing a rated game opts the site into federated leaderboards — no
// separate keyword is required.
export const SURVEY_PAGE_SLUG = 'my-chess-games'
export const SURVEY_PAGE_TITLE = 'My Chess Games'

// The well-known federated leaderboards page — one chess item with keyword LEADERBOARD.
export const LEADERBOARD_PAGE_SLUG = 'chess-leaderboards'
export const LEADERBOARD_PAGE_TITLE = 'Chess Leaderboards'
export const LEADERBOARD_PAGE_SLUGS = Object.freeze([LEADERBOARD_PAGE_SLUG])

export function isLeaderboardPageSlug(slug) {
  return (
    String(slug || '')
      .trim()
      .toLowerCase() === LEADERBOARD_PAGE_SLUG
  )
}

// Pick the slug to open: prefer a saved fork over the plugin template stub.
export function pickLeaderboardPageSlug(pagesBySlug) {
  const map = pagesBySlug && typeof pagesBySlug === 'object' ? pagesBySlug : {}
  const page = map[LEADERBOARD_PAGE_SLUG]
  if (page?.story && !page.plugin) return LEADERBOARD_PAGE_SLUG
  if (page?.story) return LEADERBOARD_PAGE_SLUG
  return LEADERBOARD_PAGE_SLUG
}

export const LEADERBOARD_PAGE_STORY = [
  {
    type: 'paragraph',
    id: LEADERBOARD_INTRO_ID,
    text: LEADERBOARD_INTRO_TEXT,
  },
  {
    type: 'chess',
    id: LEADERBOARD_CHESS_ID,
    text: 'LEADERBOARD',
  },
]

// Global federation search index — sites known to publish a chess plugin item.
// Used as the lowest-priority seed source for visible-federation crawls
// (leaderboard survey mode + My Chess Games open-challenge discovery).
// @see http://query.search.federatedwiki.org/#/find=plugins&within=sites&match=and&query=chess
export const CHESS_PLUGIN_INDEX_SEARCH_URL =
  'https://query.search.federatedwiki.org/search?find=plugins&within=sites&match=and&query=chess'

// How long a successful index fetch is reused before refetching.
export const CHESS_PLUGIN_INDEX_TTL_MS = 6 * 60 * 60 * 1000

// Cap wait on the index endpoint so a crawl can still start without it.
export const CHESS_PLUGIN_INDEX_TIMEOUT_MS = 8000

// How long IndexedDB `meta.federationSites` stays "fresh" so open-challenge
// discovery can skip the global chess-plugin index fetch.
export const FEDERATION_SITES_CACHE_TTL_MS = CHESS_PLUGIN_INDEX_TTL_MS

// Throttle progressive open-challenge batch callbacks (ms).
export const CHALLENGE_BATCH_THROTTLE_MS = 150

let chessPluginIndexCache = { hosts: [], fetchedAt: 0, ok: false }

// Normalize a cached federation host list (`{ hosts, updatedAt }` or bare array).
export function normalizeFederationSitesCache(raw, { now = Date.now() } = {}) {
  const hosts = dedupeSites(Array.isArray(raw?.hosts) ? raw.hosts : Array.isArray(raw) ? raw : [])
  const updatedAt = Number(raw?.updatedAt) || 0
  const fresh = hosts.length > 0 && updatedAt > 0 && now - updatedAt < FEDERATION_SITES_CACHE_TTL_MS
  return { hosts, updatedAt, fresh }
}

// Merge newly observed federation hosts into the IndexedDB cache record.
export function mergeFederationSitesCache(prev, hosts, { now = Date.now() } = {}) {
  const prevNorm = normalizeFederationSitesCache(prev, { now })
  return {
    hosts: dedupeSites([...prevNorm.hosts, ...(Array.isArray(hosts) ? hosts : [])]),
    updatedAt: now,
  }
}

// Test helper — clear the in-memory chess-plugin index cache.
export function resetChessPluginIndexCacheForTests() {
  chessPluginIndexCache = { hosts: [], fetchedAt: 0, ok: false }
}

// Parse hostnames from the federation search `/search` JSON (`results` HTML)
// or from a raw HTML/results string.
export function parseChessPluginIndexSites(payload) {
  let html = ''
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed.startsWith('{')) {
      try {
        html = String(JSON.parse(trimmed)?.results ?? '')
      } catch {
        html = payload
      }
    } else {
      html = payload
    }
  } else if (payload && typeof payload === 'object') {
    html = String(payload.results || '')
  }
  if (!html) return []
  const hosts = []
  const re = /\btarget=(?:"|')?([^"'\s>]+)/gi
  let match
  while ((match = re.exec(html)) !== null) {
    hosts.push(match[1])
  }
  return dedupeSites(hosts)
}

// Fetch (or return TTL-cached) hosts that publish a chess plugin item.
// On failure, returns the last successful cache (possibly empty) so crawls
// still proceed with neighbourhood + opponents alone.
export async function fetchChessPluginIndexSites({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  ttlMs = CHESS_PLUGIN_INDEX_TTL_MS,
  url = CHESS_PLUGIN_INDEX_SEARCH_URL,
  timeoutMs = CHESS_PLUGIN_INDEX_TIMEOUT_MS,
} = {}) {
  if (
    chessPluginIndexCache.ok &&
    chessPluginIndexCache.fetchedAt > 0 &&
    now - chessPluginIndexCache.fetchedAt < ttlMs
  ) {
    return [...chessPluginIndexCache.hosts]
  }
  if (typeof fetchImpl !== 'function') {
    return [...chessPluginIndexCache.hosts]
  }
  let timer = null
  try {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (ac && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          ac.abort()
        } catch {
          /* ignore */
        }
      }, timeoutMs)
    }
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac?.signal,
    })
    if (!res?.ok) throw new Error(`chess plugin index HTTP ${res?.status || 0}`)
    const data = typeof res.json === 'function' ? await res.json() : null
    const hosts = parseChessPluginIndexSites(data)
    chessPluginIndexCache = { hosts, fetchedAt: now, ok: true }
    return [...hosts]
  } catch {
    return [...chessPluginIndexCache.hosts]
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Seeds for federation survey / open-challenge crawls (local + opponents + neighbourhood + index).
export function buildSurveyFetchSeeds(localSite, opts = {}) {
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const knownOpponents = opts.knownOpponents ?? []
  const indexSites = opts.indexSites ?? []
  return buildFetchTargets({ localSite, knownOpponents, neighborhoodSites, indexSites })
}

// Build federation crawl seeds for open-challenge / site survey / visible-federation discovery.
// When `indexSites` is omitted, fetches the global chess-plugin site index (TTL-cached)
// unless a fresh `knownFederationSites` cache is provided (IndexedDB).
// Pass `indexSites: []` or `fetchIndex: false` to skip the index (tests / offline).
// Pass `knownOpponents` to skip a local sitemap crawl for opponent priors.
// Pass `deferIndex: true` to never await the global index (use cache/neighbourhood only;
// refresh the index in the background via `refreshFederationSitesFromIndex`).
export async function resolveFetchSeeds(site, localSite, opts = {}) {
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const { indexSites, fetchIndex = true, fetchImpl, deferIndex = false } = opts
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  let knownOpponents = Array.isArray(opts.knownOpponents) ? opts.knownOpponents : null
  if (!knownOpponents) {
    knownOpponents = []
    if (site && host) {
      try {
        const { games } = await fetchSiteContentAsync(site, host)
        knownOpponents = seatSitesInGames(games).filter(h => !sitesMatch(h, host))
      } catch {
        /* local priors optional */
      }
    }
  }
  const cached = normalizeFederationSitesCache(opts.knownFederationSites)
  let index = []
  if (Array.isArray(indexSites)) {
    index = indexSites
  } else if (deferIndex) {
    // Non-blocking: paint/crawl with whatever we already know. Stale is fine —
    // `refreshFederationSitesFromIndex` warms the cache off the UI path.
    index = cached.hosts
  } else if (cached.fresh) {
    // Warm local cache — skip the global index round-trip this open.
    index = cached.hosts
  } else if (fetchIndex !== false) {
    index = await fetchChessPluginIndexSites({ fetchImpl })
    // Keep previously seen hosts even when the public index is thin or flaky.
    index = dedupeSites([...cached.hosts, ...index])
  } else {
    index = cached.hosts
  }
  return buildSurveyFetchSeeds(host, { neighborhoodSites, knownOpponents, indexSites: index })
}

// Background refresh of the global chess-plugin host list into a federationSites cache.
// Never call this on the open-challenge paint path — use after the UI is already live.
export async function refreshFederationSitesFromIndex(prevCache = null, { fetchImpl, now = Date.now() } = {}) {
  const prev = normalizeFederationSitesCache(prevCache, { now })
  const prevSet = new Set(prev.hosts)
  let index = []
  try {
    index = await fetchChessPluginIndexSites({ fetchImpl, now })
  } catch {
    return { cache: prev, newHosts: [], hosts: prev.hosts }
  }
  const cache = mergeFederationSitesCache(prev, index, { now })
  const newHosts = dedupeSites(index).filter(h => h && !prevSet.has(h))
  return { cache, newHosts, hosts: cache.hosts }
}

// Built-in "My Chess Games" template — also shipped as pages/my-chess-games for the
// wiki plugin default. The shell builds a forkable GHOST from this story; league seed
// writes the same story onto demo sites. Keep text/ids in sync with pages/my-chess-games
// (see test/federation.test.js). Fixed item ids so a re-fork stays recognisable.
export const SURVEY_PAGE_STORY = [
  {
    type: 'paragraph',
    id: '913c9902ba83800a',
    text: 'A survey of all your active and completed chess games, as well as open challenges.',
  },
  {
    type: 'chess',
    id: '2f7412bc39cdfc1f',
    text: 'SURVEY',
  },
]

// Slug a page title the same way the wiki client does (`asSlug`): lower-case, spaces
// and punctuation → single dashes, trimmed. Kept local so this module needs no wiki
// dependency; matches SURVEY_PAGE_TITLE → SURVEY_PAGE_SLUG.

export function pageSlug(title) {
  return String(title || '')
    .replace(/\s/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toLowerCase()
}

// Pick a title whose slug is unused on a site. Collisions get ` (2)`, ` (3)`, … like
// league seed game pages.
export function proposeUniquePageTitle(baseTitle, existingSlugs = []) {
  const base = String(baseTitle || '').trim()
  if (!base) return base
  const slugs = new Set(
    (Array.isArray(existingSlugs) ? existingSlugs : [])
      .map(s =>
        String(s || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  )
  if (!slugs.has(pageSlug(base))) return base
  let n = 2
  let candidate = `${base} (${n})`
  while (slugs.has(pageSlug(candidate))) {
    n += 1
    candidate = `${base} (${n})`
  }
  return candidate
}

// Slugs for forked/real pages already visible in the viewer lineup on this wiki. Unforked
// ghosts are skipped — they are not on the sitemap yet and should not bump ghost titles to
// " (2)", " (3)", … Merged with sitemap slugs when proposing a forkable ghost title.
export function collectLineupPageSlugs(localSite, { includeTitles = true } = {}) {
  const slugs = new Set()
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (!host) return []
  try {
    const $ = globalThis.$
    if (typeof $ !== 'function') return []
    $('.page').each((_i, el) => {
      const $page = $(el)
      if ($page.hasClass('ghost')) return
      const site = String($page.data('site') || globalThis.location?.host || '')
        .trim()
        .toLowerCase()
      if (site && site !== 'origin' && site !== 'view' && site !== 'local') {
        if (normalizeWikiSite(site) !== normalizeWikiSite(host)) return
      }
      const id = String($page.attr('id') || '').trim()
      const slug = id.split('_rev')[0]
      if (slug) slugs.add(slug.toLowerCase())
      if (includeTitles) {
        const title = $page.data('data')?.title
        if (title) slugs.add(pageSlug(title))
      }
    })
  } catch {
    /* no DOM */
  }
  return [...slugs]
}

export function hasSurveyPage(sitemap, slug = SURVEY_PAGE_SLUG) {
  const want = String(slug || SURVEY_PAGE_SLUG).toLowerCase()
  return (Array.isArray(sitemap) ? sitemap : []).some(entry => String(entry?.slug || '').toLowerCase() === want)
}

// Tag lines recognized in a SURVEY record body (case-insensitive).
const SURVEY_NAME_LINE = /^(?:name|title)\s*:\s*(.+)$/i

// # LeaderboardMeta Player Discovery

export function ratedSitesInGames(games) {
  const hosts = []
  for (const pgn of Array.isArray(games) ? games : []) {
    const { tagFor } = pgnTagReader(pgn)
    for (const seat of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(seat))
      if (!parsed || parsed.isEngine || !parsed.domain) continue
      const host = cleanSite(parsed.domain)
      // Only a host with a readable rated Glicko-2 record for this seat is a candidate.
      if (host && stateFromGamePgn(pgn, host)) hosts.push(host)
    }
  }
  return dedupeSites(hosts)
}

export function seatSitesInGames(games) {
  const hosts = []
  for (const pgn of Array.isArray(games) ? games : []) {
    const { tagFor } = pgnTagReader(pgn)
    for (const seat of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(seat))
      if (!parsed || parsed.isEngine || !parsed.domain) continue
      const host = cleanSite(parsed.domain)
      if (host) hosts.push(host)
    }
  }
  return dedupeSites(hosts)
}

// True when a host appears as a rated player in the given PGN pool.
export function siteHasRatedGames(games, host) {
  const h = cleanSite(host)
  if (!h) return false
  return ratedSitesInGames(games).some(rh => sitesMatch(rh, h))
}

// Former crawl trust floor: keep a host when hop trust stays at/above this value.
export const HOP_TRUST_FLOOR = 0.51
// Default neighbourhood graph depth (~old 3-hop floor with decay 0.8).
export const DEFAULT_NEIGHBORHOOD_MAX_HOPS = 3
// Per-hop trust multiplier; trust(hop) = decay^hop (hop 0 = 1).
export const DEFAULT_NEIGHBORHOOD_HOP_DECAY = 0.8

export function clampHopDecay(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_NEIGHBORHOOD_HOP_DECAY
  return Math.min(1, Math.max(0.5, Math.round(n * 100) / 100))
}

export function clampMaxHops(value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_NEIGHBORHOOD_MAX_HOPS
  return Math.min(12, Math.max(1, n))
}

// Trust remaining at graph distance `hop` (seeds are hop 0 → 1).
export function hopTrustAt(hop, decay = DEFAULT_NEIGHBORHOOD_HOP_DECAY) {
  const h = Math.max(0, Math.trunc(Number(hop) || 0))
  if (h <= 0) return 1
  return Math.pow(clampHopDecay(decay), h)
}

export function normalizeNeighborhoodGraphOpts(raw = {}) {
  return {
    maxHops: clampMaxHops(raw?.maxHops ?? DEFAULT_NEIGHBORHOOD_MAX_HOPS),
    hopDecay: clampHopDecay(raw?.hopDecay ?? DEFAULT_NEIGHBORHOOD_HOP_DECAY),
    trustFloor: HOP_TRUST_FLOOR,
  }
}

// Preview which hops stay visible for the current dial settings.
// Includes the first weeded hop (if any) so the UI can show where the cut falls.
export function previewHopTrustSchedule(raw = {}) {
  const { maxHops, hopDecay, trustFloor } = normalizeNeighborhoodGraphOpts(raw)
  const rows = []
  for (let hop = 0; hop <= maxHops + 1; hop += 1) {
    const trust = hopTrustAt(hop, hopDecay)
    const overMax = hop > maxHops
    const belowFloor = trust < trustFloor
    rows.push({
      hop,
      trust,
      kept: !overMax && !belowFloor,
      weededReason: overMax ? 'maxHops' : belowFloor ? 'decay' : null,
    })
    if (overMax || belowFloor) break
  }
  return rows
}

// Wiki hosts seated in rated games — used to walk the federation opponent graph.
export function federationOpponentSitesFromGames(games) {
  const out = []
  for (const pgn of Array.isArray(games) ? games : []) {
    if (typeof pgn !== 'string' || !pgn.trim()) continue
    const { tagFor } = pgnTagReader(pgn)
    if (!isRatedTagValue(tagFor('Rated'))) continue
    out.push(...seatSitesInGames([pgn]))
  }
  return dedupeSites(out)
}

// Past rated opponents of any anchor host within a crawled PGN pool.
export function opponentSitesFromGamesForSites(games, anchorSites) {
  const anchors = dedupeSites(anchorSites)
  if (!anchors.length) return []
  const out = new Set()
  for (const pgn of Array.isArray(games) ? games : []) {
    if (typeof pgn !== 'string' || !pgn.trim()) continue
    const { tagFor } = pgnTagReader(pgn)
    if (!isRatedTagValue(tagFor('Rated'))) continue
    const seats = seatSitesInGames([pgn])
    if (!seats.some(h => anchors.some(a => sitesMatch(h, a)))) continue
    for (const h of seats) {
      if (!anchors.some(a => sitesMatch(h, a))) out.add(cleanSite(h))
    }
  }
  return dedupeSites([...out])
}

// Past rated opponents of a host within a crawled PGN pool.
export function pastOpponentSitesFromGames(games, localSite) {
  return opponentSitesFromGamesForSites(games, [localSite])
}

export function neighborhoodOpponentsFromGames(games, localSite, neighborhoodSites = []) {
  return opponentSitesFromGamesForSites(games, dedupeSites([localSite, ...neighborhoodSites]))
}

// Re-assign rank numbers after filtering a sorted leaderboard slice.
export function rerankLeaderboardEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((row, i) => ({
    ...normalizeLeaderboardEntry(row),
    rank: i + 1,
  }))
}

function normalizeLeaderboardEntry(row) {
  if (!row || typeof row !== 'object') return row
  const site = row.site ?? row.host
  const { host: _legacyHost, ...rest } = row
  return site == null ? rest : { ...rest, site }
}

// Filter a visible-federation board without recomputing ratings.
// Past opponents and neighborhood are views over the same canonical federation numbers.
// Membership uses sitesMatch so `frank.localhost` and `frank.localhost:3001` align.
export function filterFederatedLeaderboardEntries(entries, mode, opts = {}) {
  const localSite = opts.localSite ?? ''
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const neighborhoodOpponents = opts.neighborhoodOpponents ?? []
  const pastOpponents = opts.pastOpponents ?? []
  const rows = (Array.isArray(entries) ? entries : []).map(normalizeLeaderboardEntry)
  const m = mode === 'mine' ? 'mine' : mode === 'neighborhood' ? 'neighborhood' : 'survey'
  if (m === 'survey') return rows
  const local = cleanSite(localSite)
  const allowList =
    m === 'neighborhood'
      ? dedupeSites([local, ...neighborhoodSites, ...neighborhoodOpponents, ...pastOpponents])
      : dedupeSites([local, ...pastOpponents])
  return rerankLeaderboardEntries(rows.filter(row => allowList.some(h => sitesMatch(h, row?.site ?? row?.host))))
}

function gameRowPlayerMeta(tagFor) {
  const event = String(tagFor('Event') || '').trim()
  const ratedTag = String(tagFor('Rated') || '').trim()
  const creatorTag = String(tagFor('ChallengeCreator') || '').trim()
  const creatorColor = String(tagFor('CreatorColor') || '').trim()
  return {
    whiteLabel: formatPlayerDisplayLabel(tagFor('White')) || '',
    blackLabel: formatPlayerDisplayLabel(tagFor('Black')) || '',
    event,
    utcDate: String(tagFor('UTCDate') || '').trim(),
    utcTime: String(tagFor('UTCTime') || '').trim(),
    round: String(tagFor('Round') || '').trim(),
    board: String(tagFor('Board') || '').trim(),
    eco: String(tagFor('ECO') || '').trim(),
    opening: String(tagFor('Opening') || '').trim(),
    timeControl: String(tagFor('TimeControl') || '').trim(),
    ratedTag,
    challengeCreator: creatorTag,
    creatorColor,
  }
}

// Skip empty / placeholder Seven Tag Roster values (`-`, `?`).
function meaningfulPgnMetaValue(value) {
  const v = String(value || '').trim()
  if (!v || v === '-' || v === '?' || v === '*') return ''
  return v
}

function formatRoundMetaLabel(round) {
  const v = meaningfulPgnMetaValue(round)
  if (!v) return ''
  if (/^round\b/i.test(v)) return v
  if (/^\d/.test(v)) return `Round ${v}`
  return v
}

function formatBoardMetaLabel(board) {
  const v = meaningfulPgnMetaValue(board)
  if (!v) return ''
  if (/^board\b/i.test(v)) return v
  if (/^\d/.test(v)) return `Board ${v}`
  return v
}

export function formatGameRowMetaLine({
  pgn,
  rated,
  challenge,
  event,
  round,
  board,
  eco,
  opening,
  timeControl,
  ratedTag,
  challengeCreator,
  creatorColor,
  includeRated = true,
  includeColor = true,
} = {}) {
  const parts = []
  const ratedTagValue = ratedTag || (pgn ? getPgnTag(pgn, 'Rated') : '') || ''
  const ratedFromTag = ratedTagValue ? ratedTagValue.toLowerCase() !== 'no' : null
  const isRated =
    rated != null ? Boolean(rated) : challenge?.config?.rated != null ? Boolean(challenge.config.rated) : ratedFromTag
  if (includeRated) {
    if (isRated === true) parts.push('Rated')
    else if (isRated === false) parts.push('Casual')
  }

  // Legacy games stamped the ghost-page slug ("new-chess-page") as their Event —
  // suppress those alongside the generic default.
  const eventLabel = String(event || (pgn ? getPgnTag(pgn, 'Event') : '') || '').trim()
  if (eventLabel && eventLabel !== 'Federated Wiki Chess' && !isPlaceholderPgnEvent(eventLabel)) {
    parts.push(eventLabel)
  }

  const roundLabel = formatRoundMetaLabel(round || (pgn ? getPgnTag(pgn, 'Round') : ''))
  if (roundLabel) parts.push(roundLabel)

  const boardLabel = formatBoardMetaLabel(board || (pgn ? getPgnTag(pgn, 'Board') : ''))
  if (boardLabel) parts.push(boardLabel)

  const ecoLabel = meaningfulPgnMetaValue(eco || (pgn ? getPgnTag(pgn, 'ECO') : ''))
  if (ecoLabel) parts.push(ecoLabel)

  const openingLabel = meaningfulPgnMetaValue(opening || (pgn ? getPgnTag(pgn, 'Opening') : ''))
  if (openingLabel) parts.push(openingLabel)

  const timeControlLabel = meaningfulPgnMetaValue(timeControl || (pgn ? getPgnTag(pgn, 'TimeControl') : ''))
  if (timeControlLabel) parts.push(timeControlLabel)

  const creator = challengeCreator || (pgn ? getPgnTag(pgn, 'ChallengeCreator') : '') || challenge?.creator?.id || ''
  const creatorName = creator ? seatResultBannerName(creator) || playerDisplayLabel(creator) : ''
  if (creatorName) {
    // Rated seeks advertise the poster's rating so opponents can judge the matchup
    // before joining (same CreatorRating stamp used by the open-seek banner).
    const ratingRaw = challenge?.creator?.rating ?? (pgn ? getPgnTag(pgn, 'CreatorRating') : null)
    const creatorRating =
      ratingRaw != null && ratingRaw !== '' && Number.isFinite(Number(ratingRaw)) ? Math.round(Number(ratingRaw)) : null
    parts.push(
      isRated === true && creatorRating != null
        ? `Posted by ${creatorName} (${creatorRating})`
        : `Posted by ${creatorName}`,
    )
  }

  if (includeColor) {
    const colorPref =
      creatorColor || (pgn ? getPgnTag(pgn, 'CreatorColor') : '') || challenge?.config?.creatorColor || ''
    if (/^random$/i.test(String(colorPref))) parts.push('Random colours')
    else if (colorPref === CHALLENGE_COLOR_WHITE) parts.push('Creator plays White')
    else if (colorPref === CHALLENGE_COLOR_BLACK) parts.push('Creator plays Black')
  }

  return parts.join(' · ')
}

// True when the local copy is still `*` but a twin shows the same game finished.
export function syncPendingFromTwin(localPgn, twinPgn) {
  if (!localPgn || !twinPgn) return null
  const localResult = String(getPgnTag(localPgn, 'Result') || '*').trim()
  if (isDecisiveResult(localResult)) return null
  const twinResult = String(getPgnTag(twinPgn, 'Result') || '*').trim()
  if (!isDecisiveResult(twinResult)) return null
  const localSans = sanPlies(localPgn)
  const twinSans = sanPlies(twinPgn)
  if (twinSans.length < localSans.length) return null
  for (let i = 0; i < localSans.length; i += 1) {
    if (localSans[i] !== twinSans[i]) return null
  }
  return {
    twinResult,
    ending: gameResultFromPgn(twinPgn).method || '',
  }
}

async function fetchTwinPgnFromOpponent(site, entry, selfSite) {
  const pgn = entry?.pgn
  if (typeof pgn !== 'string' || !pgn.trim()) return null
  if (isDecisiveResult(getPgnTag(pgn, 'Result') || '*')) return null
  const self = cleanSite(selfSite)
  const { tagFor } = pgnTagReader(pgn)
  let seat = null
  for (const s of ['White', 'Black']) {
    const p = parsePlayerId(tagFor(s))
    if (p && !p.isEngine && self && sitesMatch(p.domain, self)) {
      seat = s
      break
    }
  }
  if (!seat) return null
  const oppSeat = seat === 'White' ? 'Black' : 'White'
  const oppParsed = parsePlayerId(tagFor(oppSeat))
  const oppSite = oppParsed && !oppParsed.isEngine && oppParsed.domain ? cleanSite(oppParsed.domain) : ''
  if (!oppSite || sitesMatch(oppSite, self)) return null
  const slug = String(entry.slug || '').trim()
  const itemId = String(entry.itemId || '').trim()
  if (!slug || !itemId || !site?.getPage) return null
  try {
    const page = await site.getPage(oppSite, `${slug}.json`)
    const chessItem = (page?.story || []).find(row => row?.id === itemId && row?.text)
    return chessItem?.text || null
  } catch {
    return null
  }
}

// Attach opponent-site PGN when the local copy still shows an in-progress Result.
export async function enrichPageGamesWithTwinTerminals(site, pageGames, selfSite) {
  return mapWithConcurrency(Array.isArray(pageGames) ? pageGames : [], SITE_FETCH_CONCURRENCY, async entry => {
    if (entry?.twinPgn) return entry
    const twinPgn = await fetchTwinPgnFromOpponent(site, entry, selfSite)
    return twinPgn ? { ...entry, twinPgn } : entry
  })
}

export function buildMyGamesList(pageGames, selfSite) {
  const self = cleanSite(selfSite)
  const seen = new Set()
  const out = []
  let i = 0
  for (const entry of Array.isArray(pageGames) ? pageGames : []) {
    i += 1
    const pgn = entry?.pgn
    if (typeof pgn !== 'string' || !pgn.trim()) continue
    const { tagFor } = pgnTagReader(pgn)
    let seat = null
    for (const s of ['White', 'Black']) {
      const p = parsePlayerId(tagFor(s))
      if (p && !p.isEngine && self && sitesMatch(p.domain, self)) {
        seat = s
        break
      }
    }
    if (!seat) continue
    const pageSite = cleanSite(entry?.host) || self
    const slug = String(entry?.slug || '').trim()
    const itemId = String(entry?.itemId || '').trim()
    const dedupeKey = `${pageSite}|${slug}|${itemId || gameFingerprint(pgn) || `idx:${i}`}`
    const oppSeat = seat === 'White' ? 'Black' : 'White'
    const oppTag = tagFor(oppSeat)
    const oppParsed = parsePlayerId(oppTag)
    const oppSite = oppParsed && !oppParsed.isEngine && oppParsed.domain ? cleanSite(oppParsed.domain) : ''
    const oppName = seatResultBannerName(oppTag) || ''
    const ratedTag = tagFor('Rated')
    const challenge = normalizeChallengeState(entry?.challenge)
    const date = String(tagFor('Date') || '')
    const ts = Number.isFinite(challenge?.ts)
      ? challenge.ts
      : pgnTimestamp({
          Date: date,
          UTCDate: tagFor('UTCDate'),
          UTCTime: tagFor('UTCTime'),
        })
    const result = String(tagFor('Result') || '').trim()
    const isActive = !result || result === '*'
    if (isActive) {
      if (!bothSeatsFilled(pgn)) continue
      const pending = entry.twinPgn ? syncPendingFromTwin(pgn, entry.twinPgn) : null
      if (pending) {
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        const rated = challenge?.config?.rated ?? (ratedTag ? ratedTag.toLowerCase() !== 'no' : true)
        out.push({
          slug,
          title: String(entry?.title || '').trim() || slug,
          site: pageSite,
          itemId,
          opponent: oppSite,
          opponentName: oppName,
          color: seat === 'White' ? 'w' : 'b',
          active: false,
          syncPending: true,
          syncMethod: pending.ending,
          result: pending.twinResult,
          score: resultToScore(pending.twinResult, seat),
          date,
          ts,
          rated,
          challenge,
          pgn,
          ...gameRowPlayerMeta(tagFor),
        })
        continue
      }
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const rated = challenge?.config?.rated ?? (ratedTag ? ratedTag.toLowerCase() !== 'no' : true)
      out.push({
        slug,
        title: String(entry?.title || '').trim() || slug,
        site: pageSite,
        itemId,
        opponent: oppSite,
        opponentName: oppName,
        color: seat === 'White' ? 'w' : 'b',
        active: true,
        result: '*',
        score: null,
        date,
        ts,
        rated,
        challenge,
        pgn,
        ...gameRowPlayerMeta(tagFor),
      })
      continue
    }
    const fingerprint = gameFingerprint(pgn) || `idx:${i}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const tagSet = parsePgnParts(pgn).tags
    const rated =
      readRatedFlag(tagSet) ||
      Boolean(stateFromGamePgn(pgn, self)) ||
      Boolean(oppSite && stateFromGamePgn(pgn, oppSite))
    out.push({
      slug,
      title: String(entry?.title || '').trim() || slug,
      site: pageSite,
      itemId,
      opponent: oppSite,
      opponentName: oppName,
      color: seat === 'White' ? 'w' : 'b',
      result,
      score: resultToScore(result, seat),
      date,
      ts,
      rated,
      pgn,
      ...gameRowPlayerMeta(tagFor),
    })
  }
  out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || String(b.date).localeCompare(String(a.date)))
  return out
}

// Accepted ghost seeks the creator has not forked onto their wiki yet — the joiner's
// copy is the live game page. Listed under Active games (creatorForkBackPending) and as a
// fork-back row in Open challenges until the creator forks.
export function buildAcceptedGhostGamesList(acceptedGhosts, selfSite) {
  const self = cleanSite(selfSite)
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(acceptedGhosts) ? acceptedGhosts : []) {
    if (!self || !sitesMatch(raw?.challenge?.creator?.site ?? raw?.challenge?.creator?.host, self)) continue
    const gameSite = cleanSite(raw.site ?? raw.host)
    const slug = String(raw.slug || '').trim()
    const itemId = String(raw.itemId || '').trim()
    if (!gameSite || !slug || !itemId) continue
    if (sitesMatch(gameSite, self)) continue
    const key = `${gameSite}|${slug}|${itemId}`
    if (seen.has(key)) continue
    seen.add(key)
    const challenge = normalizeChallengeState(raw.challenge)
    const pgn = String(raw.pgn || '').trim()
    const { tagFor } = pgnTagReader(pgn)
    let seat = null
    for (const s of ['White', 'Black']) {
      const p = parsePlayerId(tagFor(s))
      if (p && !p.isEngine && self && sitesMatch(p.domain, self)) {
        seat = s
        break
      }
    }
    const creatorColor = challenge?.config?.creatorColor
    const color =
      seat === 'White'
        ? 'w'
        : seat === 'Black'
          ? 'b'
          : creatorColor === CHALLENGE_COLOR_WHITE
            ? 'w'
            : creatorColor === CHALLENGE_COLOR_BLACK
              ? 'b'
              : ''
    const oppSite = cleanSite(challenge?.opponent?.site ?? challenge?.opponent?.host) || gameSite
    out.push({
      slug,
      title: String(raw.title || '').trim() || slug,
      site: gameSite,
      itemId,
      opponent: oppSite,
      opponentName: playerDisplayLabel(challenge?.opponent?.id || '') || oppSite,
      color,
      active: true,
      creatorForkBackPending: true,
      result: '*',
      score: null,
      date: String(tagFor('Date') || ''),
      ts: Number.isFinite(challenge?.ts) ? challenge.ts : Number(raw.ts) || 0,
      rated: challenge?.config?.rated !== false,
      challenge,
      pgn,
      ...gameRowPlayerMeta(tagFor),
    })
  }
  return out
}

export function mergeMyGamesLists(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const g of Array.isArray(list) ? list : []) {
      const slug = String(g?.slug || '').trim()
      if (!slug) continue
      const key = `${cleanSite(g.site || '')}|${slug}|${g.itemId || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(g)
    }
  }
  out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || String(b.date).localeCompare(String(a.date)))
  return out
}

// Tiny, dependency-light reader for the White/Black tags of a PGN string, avoiding a
// full parse just to find the seat hosts. Defensive: missing tags read as ''.
function pgnTagReader(pgn) {
  const text = String(pgn || '')
  const tagFor = name => {
    const m = text.match(new RegExp(`\\[${name}\\s+"([^"]*)"\\]`))
    return m ? m[1] : ''
  }
  return { tagFor }
}

function freshestIdentity(games, host) {
  let best = null
  for (const pgn of Array.isArray(games) ? games : []) {
    const { tagFor } = pgnTagReader(pgn)
    for (const seat of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(seat))
      if (!parsed || parsed.isEngine) continue
      if (!sitesMatch(parsed.domain, host)) continue
      const found = stateFromGamePgn(pgn, host)
      const updated = found ? found.updated : 0
      if (!best || updated >= best.updated) {
        best = { name: parsed.username || host, updated }
      }
    }
  }
  return best
}

function emptyColorCareerStats(peak = 0) {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    peak: Number(peak) || 0,
    whiteWins: 0,
    whiteLosses: 0,
    whiteDraws: 0,
    blackWins: 0,
    blackLosses: 0,
    blackDraws: 0,
  }
}

function tallyColorResult(stats, seat, score) {
  if (score === 1) {
    stats.wins += 1
    if (seat === 'White') stats.whiteWins += 1
    else stats.blackWins += 1
  } else if (score === 0) {
    stats.losses += 1
    if (seat === 'White') stats.whiteLosses += 1
    else stats.blackLosses += 1
  } else {
    stats.draws += 1
    if (seat === 'White') stats.whiteDraws += 1
    else stats.blackDraws += 1
  }
}

function aggregateSiteStats(pool, host, currentRating = 0) {
  const seen = new Set()
  const stats = emptyColorCareerStats(currentRating)
  const list = Array.isArray(pool) ? pool : []
  for (let i = 0; i < list.length; i += 1) {
    const pgn = list[i]
    const found = stateFromGamePgn(pgn, host)
    if (!found) continue // not a rated game with this host as a readable seat
    const { tagFor } = pgnTagReader(pgn)

    let seat = null
    for (const s of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(s))
      if (parsed && !parsed.isEngine && sitesMatch(parsed.domain, host)) {
        seat = s
        break
      }
    }
    if (!seat) continue
    const score = resultToScore(tagFor('Result'), seat)
    if (score == null) continue // unfinished — not a completed rated game
    // Dedupe the cross-wiki twin so a game forked on both sites is counted once.
    const fingerprint = gameFingerprint(pgn) || `idx:${i}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    stats.games += 1
    tallyColorResult(stats, seat, score)
    const r = Number(found.state?.rating) || 0
    if (r > stats.peak) stats.peak = r
  }
  return stats
}

// # LeaderboardMeta Ranking Table

// Sortable leaderboard columns. `type` drives compare/filter; `filter` is text|number.
// `shortLabel` is shown when the table wrap is narrow (CSS container query); `title` is hover text.
// `better: 'low'` = #1 is the smallest value (losses); default/`high` = #1 is largest (wins, rating…).
// Kept here (pure, data-only) so the client renders the same set it sorts by.
export const LEADERBOARD_COLUMNS = Object.freeze([
  { id: 'rank', label: '#', type: 'number', filter: 'number', alwaysShow: true },
  { id: 'player', label: 'Name', type: 'text', filter: 'text', field: 'name' },
  {
    id: 'rating',
    label: 'Rating',
    shortLabel: 'Rat',
    type: 'number',
    filter: 'number',
    field: 'rating',
    title: 'Rating',
  },
  { id: 'games', label: 'Games', shortLabel: 'G', type: 'number', filter: 'number', field: 'games', title: 'Games' },
  { id: 'wins', label: 'Wins', shortLabel: 'W', type: 'number', filter: 'number', field: 'wins', title: 'Wins' },
  {
    id: 'losses',
    label: 'Losses',
    shortLabel: 'L',
    type: 'number',
    filter: 'number',
    field: 'losses',
    title: 'Losses',
    better: 'low',
  },
  { id: 'draws', label: 'Draws', shortLabel: 'D', type: 'number', filter: 'number', field: 'draws', title: 'Draws' },
  {
    id: 'peak',
    label: 'Peak',
    shortLabel: 'Pk',
    type: 'number',
    filter: 'number',
    field: 'peak',
    title: 'Peak rating',
  },
  {
    id: 'winrate',
    label: 'Win %',
    shortLabel: 'W%',
    type: 'number',
    filter: 'number',
    field: 'winRate',
    title: 'Win %',
  },
  {
    id: 'whiteWins',
    label: 'W wins',
    shortLabel: 'WW',
    type: 'number',
    filter: 'number',
    field: 'whiteWins',
    title: 'Wins as White',
  },
  {
    id: 'whiteLosses',
    label: 'W losses',
    shortLabel: 'WL',
    type: 'number',
    filter: 'number',
    field: 'whiteLosses',
    title: 'Losses as White',
    better: 'low',
  },
  {
    id: 'blackWins',
    label: 'B wins',
    shortLabel: 'BW',
    type: 'number',
    filter: 'number',
    field: 'blackWins',
    title: 'Wins as Black',
  },
  {
    id: 'blackLosses',
    label: 'B losses',
    shortLabel: 'BL',
    type: 'number',
    filter: 'number',
    field: 'blackLosses',
    title: 'Losses as Black',
    better: 'low',
  },
])

export const DEFAULT_CATEGORY = 'rating'
export const DEFAULT_SORT = Object.freeze({ column: 'rating', dir: 'desc' })

// Preferred first-click / #1 direction for a column: fewest losses, most wins, A→Z names.
export function columnPreferredSortDir(columnId) {
  const col = columnDef(columnId)
  if (!col) return DEFAULT_SORT.dir
  if (col.type === 'text') return 'asc'
  if (col.better === 'low') return 'asc'
  return 'desc'
}

// A win-rate board is meaningless from one or two lucky games, so a player needs at
// least this many rated games before their win rate ranks them (below this they sort
// to the bottom of the win-rate board, though their rate is still shown).
export const WINRATE_MIN_GAMES = 5

function columnDef(columnId) {
  return LEADERBOARD_COLUMNS.find(c => c.id === columnId) || null
}

function entrySortValue(entry, columnId) {
  const col = columnDef(columnId)
  if (!col) return Number(entry?.rating) || 0
  if (columnId === 'rank') return Number(entry?.rank) || 0
  if (columnId === 'player') {
    return String(entry?.name || entry?.site || entry?.host || '').toLowerCase()
  }
  if (columnId === 'winrate') {
    return (Number(entry?.games) || 0) >= WINRATE_MIN_GAMES ? Number(entry?.winRate) || 0 : -1
  }
  const field = col.field || columnId
  if (col.type === 'text') return String(entry?.[field] || '').toLowerCase()
  return Number(entry?.[field]) || 0
}

function entryFilterText(entry, columnId) {
  const col = columnDef(columnId)
  if (!col) return ''
  if (columnId === 'rank') return String(entry?.rank ?? '')
  if (columnId === 'player') {
    const site = String(entry?.site || entry?.host || '').trim()
    const name = String(entry?.name || '').trim()
    const display = leaderboardPlayerDisplayName(entry)
    return `${name} ${display} ${site}`.trim().toLowerCase()
  }
  if (columnId === 'winrate') {
    const value = Number(entry?.winRate) || 0
    return `${value}%`
  }
  const field = col.field || columnId
  return String(entry?.[field] ?? '')
}

// Visible name on the leaderboard Name column (not the domain line).
// When the stored name is just the site host, prefer a short site label (e.g. Olga).
export function leaderboardPlayerDisplayName(entry) {
  const site = String(entry?.site || entry?.host || '').trim()
  const name = String(entry?.name || '').trim()
  if (!name) return fallbackWikiSiteDisplayLabel(site) || site
  if (sitesMatch(name, site) || name.toLowerCase() === site.toLowerCase()) {
    return fallbackWikiSiteDisplayLabel(site) || name
  }
  return name
}

export function filterLeaderboardEntries(entries, filters = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeLeaderboardEntry)
  const active = Object.entries(filters || {}).filter(([, q]) => String(q || '').trim())
  if (!active.length) return list.slice()
  return list.filter(entry =>
    active.every(([columnId, raw]) => {
      const q = String(raw).trim().toLowerCase()
      if (!q) return true
      return entryFilterText(entry, columnId).toLowerCase().includes(q)
    }),
  )
}

function compareLeaderboardEntries(a, b, columnId, dir) {
  const mul = dir === 'asc' ? 1 : -1
  const av = entrySortValue(a, columnId)
  const bv = entrySortValue(b, columnId)
  if (av !== bv) {
    if (typeof av === 'string' || typeof bv === 'string') {
      return mul * String(av).localeCompare(String(bv))
    }
    return mul * (av < bv ? -1 : 1)
  }
  if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0)
  if ((a.rd || 0) !== (b.rd || 0)) return (a.rd || 0) - (b.rd || 0)
  const aSite = a.site ?? a.host ?? ''
  const bSite = b.site ?? b.host ?? ''
  return aSite < bSite ? -1 : aSite > bSite ? 1 : 0
}

function leaderboardEntryKey(entry) {
  return cleanSite(entry?.site ?? entry?.host) || String(entry?.name || '')
}

export function rankLeaderboard(
  entries,
  { category = DEFAULT_CATEGORY, column = null, dir = null, reliableOnly = false, filters = null } = {},
) {
  const sortColumn = column || category || DEFAULT_SORT.column
  const sortDir = dir === 'asc' || dir === 'desc' ? dir : columnPreferredSortDir(sortColumn)
  let list = filterLeaderboardEntries(entries, filters)
  if (reliableOnly) list = list.filter(e => e?.reliable)
  // #1 = best on this column (most wins / highest rating / fewest losses), even if the
  // table is visually reversed so the worst rows are on top.
  const standingDir = columnPreferredSortDir(sortColumn)
  const standingRank = new Map()
  ;[...list]
    .sort((a, b) => compareLeaderboardEntries(a, b, sortColumn, standingDir))
    .forEach((entry, i) => {
      const key = leaderboardEntryKey(entry)
      if (key) standingRank.set(key, i + 1)
    })
  list.sort((a, b) => compareLeaderboardEntries(a, b, sortColumn, sortDir))
  return list.map(entry => ({
    ...entry,
    rank: standingRank.get(leaderboardEntryKey(entry)) || 0,
  }))
}

function resolveSiteInPool(pool, host) {
  const best = latestRatedGameForSite(pool, host)
  if (!best) return null
  const fingerprint = gameFingerprint(best.pgn)
  const selfIndex = pool.indexOf(best.pgn)
  let verified = false
  if (fingerprint) {
    for (let i = 0; i < pool.length; i += 1) {
      if (i === selfIndex) continue
      if (gameFingerprint(pool[i]) !== fingerprint) continue
      if (auditTwins(best.pgn, pool[i]).verified) {
        verified = true
        break
      }
    }
  }
  return { state: best.state, verified, updated: best.updated || 0 }
}

// Does `pgn` have a DISTINCT twin in the pool that reconciles under the double-entry
// audit? That twin is the same game forked onto the opponent's site; its presence is
// what makes a game trustworthy for rating (collusion would need BOTH sites to lie in
// lock-step). A one-sided game (no twin crawled yet) is not verified.
function hasVerifiedTwin(pool, pgn, selfIndex, fingerprint) {
  if (!fingerprint) return false
  for (let j = 0; j < pool.length; j += 1) {
    if (j === selfIndex) continue
    if (gameFingerprint(pool[j]) !== fingerprint) continue
    if (auditTwins(pgn, pool[j]).verified) return true
  }
  return false
}

function recomputeVerifiedRating(pool, host) {
  const list = Array.isArray(pool) ? pool : []
  const verified = []
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const pgn = list[i]
    const found = stateFromGamePgn(pgn, host)
    if (!found) continue // not a rated game with this host as a readable seat
    const { tagFor } = pgnTagReader(pgn)

    let seat = null
    for (const s of ['White', 'Black']) {
      const parsed = parsePlayerId(tagFor(s))
      if (parsed && !parsed.isEngine && sitesMatch(parsed.domain, host)) {
        seat = s
        break
      }
    }
    if (!seat) continue
    const score = resultToScore(tagFor('Result'), seat)
    if (score == null) continue // unfinished
    const fingerprint = gameFingerprint(pgn) || `idx:${i}`
    if (seen.has(fingerprint)) continue // a twin we've already counted
    if (!hasVerifiedTwin(list, pgn, i, gameFingerprint(pgn))) continue // one-sided → excluded
    // The opponent must be a real human seat; use their stamped state as the prior.
    const oppParsed = parsePlayerId(tagFor(seat === 'White' ? 'Black' : 'White'))
    if (!oppParsed || oppParsed.isEngine) continue
    const oppFound = oppParsed.domain ? stateFromGamePgn(pgn, oppParsed.domain) : null
    seen.add(fingerprint)
    verified.push({
      pgn,
      score,
      seat,
      opponent: oppFound ? oppFound.state : newRatingState(),
      updated: found.updated || 0,
    })
  }
  if (!verified.length) return null
  verified.sort((a, b) => compareGameTimeline(a.pgn, b.pgn))

  let state = newRatingState()
  const stats = emptyColorCareerStats()
  for (const g of verified) {
    const when = Date.parse(readGameTimelineKey(g.pgn).ts) || g.updated || Date.now()
    state = updateRatingState(state, [{ opponent: g.opponent, score: g.score, seat: g.seat }], {
      now: when,
      decay: true,
    })
    tallyColorResult(stats, g.seat, g.score)
    if (state.rating > stats.peak) stats.peak = state.rating
  }
  stats.games = verified.length
  stats.peak = Math.max(stats.peak, state.rating)
  const updated =
    Date.parse(readGameTimelineKey(verified[verified.length - 1].pgn).ts) || verified[verified.length - 1].updated || 0
  return {
    state: { ...state, updated },
    verified: true,
    updated,
    stats,
  }
}

export function collectVerifiedTimelineEvents(pool, { blockList = [] } = {}) {
  const list = Array.isArray(pool) ? pool.filter(g => typeof g === 'string' && g.trim()) : []
  const blocked = normalizeBlockList(blockList)
  const events = []
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const pgn = list[i]
    const { tagFor } = pgnTagReader(pgn)
    const result = String(tagFor('Result') || '').trim()
    if (!result || result === '*') continue
    if (!readRatedFlag(parsePgnParts(pgn).tags)) continue
    const fingerprint = gameFingerprint(pgn)
    if (!fingerprint || seen.has(fingerprint)) continue
    if (!hasVerifiedTwin(list, pgn, i, fingerprint)) continue
    const whiteParsed = parsePlayerId(tagFor('White'))
    const blackParsed = parsePlayerId(tagFor('Black'))
    if (!whiteParsed || !blackParsed || whiteParsed.isEngine || blackParsed.isEngine) continue
    const whiteSite = cleanSite(whiteParsed.domain)
    const blackSite = cleanSite(blackParsed.domain)
    if (isSiteBlocked(whiteSite, blocked) || isSiteBlocked(blackSite, blocked)) continue
    seen.add(fingerprint)
    const whiteState = stateFromGamePgn(pgn, whiteSite)?.state || newRatingState()
    const blackState = stateFromGamePgn(pgn, blackSite)?.state || newRatingState()
    const whiteScore = resultToScore(result, 'White')
    const blackScore = resultToScore(result, 'Black')
    if (whiteScore == null || blackScore == null) continue
    events.push({
      pgn,
      fingerprint,
      whiteSite,
      blackSite,
      whiteScore,
      blackScore,
      whiteState,
      blackState,
      key: readGameTimelineKey(pgn).key,
    })
  }
  events.sort((a, b) => compareGameTimeline(a.pgn, b.pgn))
  return events
}

// True when the next event should start a new Glicko batch (7-day gap or 15 games + new day).
export function shouldCloseGlickoBatch(batchEvents, nextEventPgn, batchStartTs) {
  if (!Array.isArray(batchEvents) || !batchEvents.length || !nextEventPgn) return false
  const nextTs = Date.parse(readGameTimelineKey(nextEventPgn).ts) || Date.now()
  const startTs = batchStartTs || Date.parse(readGameTimelineKey(batchEvents[0].pgn).ts) || nextTs
  if (nextTs - startTs >= RATING_PERIOD_MS) return true
  if (batchEvents.length >= GLICKO_BATCH_GAME_LIMIT) {
    const lastDay = calendarDayKeyFromPgn(batchEvents[batchEvents.length - 1].pgn)
    const nextDay = calendarDayKeyFromPgn(nextEventPgn)
    if (nextDay !== lastDay) return true
  }
  return false
}

function applyGlickoBatchToPlayers(players, batchEvents, batchEndTs) {
  if (!batchEvents.length) return players
  const snapshot = clonePlayersMap(players)
  const pending = new Map()

  for (const ev of batchEvents) {
    const wSite = ev.whiteSite
    const bSite = ev.blackSite
    if (!wSite || !bSite) continue
    const wSnap = snapshot[wSite] || normalizeRatingState(ev.whiteState)
    const bSnap = snapshot[bSite] || normalizeRatingState(ev.blackState)
    if (!pending.has(wSite)) pending.set(wSite, [])
    if (!pending.has(bSite)) pending.set(bSite, [])
    pending.get(wSite).push({ opponent: bSnap, score: ev.whiteScore, seat: 'White' })
    pending.get(bSite).push({ opponent: wSnap, score: ev.blackScore, seat: 'Black' })
  }

  for (const [host, matches] of pending) {
    let state = decayRatingState(players[host] || snapshot[host] || newRatingState(), batchEndTs)
    state = updateRatingState(state, matches, { now: batchEndTs, decay: false })
    players[host] = state
  }
  return players
}

export function replayEventsOntoPlayersBatched(events, seedPlayers = {}) {
  const players = clonePlayersMap(seedPlayers)
  const list = Array.isArray(events) ? events : []
  let batch = []
  let batchStartTs = null

  const flush = endTs => {
    if (!batch.length) return
    applyGlickoBatchToPlayers(players, batch, endTs)
    batch = []
    batchStartTs = null
  }

  for (const ev of list) {
    const ts = Date.parse(readGameTimelineKey(ev.pgn).ts) || Date.now()
    if (batch.length && shouldCloseGlickoBatch(batch, ev.pgn, batchStartTs)) {
      const prevTs = Date.parse(readGameTimelineKey(batch[batch.length - 1].pgn).ts) || ts
      flush(prevTs)
    }
    if (!batch.length) batchStartTs = ts
    batch.push(ev)
  }
  if (batch.length) {
    const lastTs = Date.parse(readGameTimelineKey(batch[batch.length - 1].pgn).ts) || Date.now()
    flush(lastTs)
  }

  const last = list.length ? list[list.length - 1] : null
  return {
    players,
    events: list,
    stateHash: computeStateHash(players),
    lastGameHash: last ? readGameTimelineKey(last.pgn).hash : '',
    lastTimelineKey: last ? last.key : '',
    rootOrphanHash: findRootOrphanHash(list),
  }
}

export function replayEventsOntoPlayers(events, seedPlayers = {}) {
  return replayEventsOntoPlayersBatched(events, seedPlayers)
}

export function applyIncrementalTimeline(basePlayers, games, { blockList = [], afterTimelineKey = '' } = {}) {
  const fresh = filterGamesAfterTimelineKey(games, afterTimelineKey)
  const blocked = normalizeBlockList(blockList)
  const events = collectVerifiedTimelineEvents(fresh, { blockList: blocked })
  return replayEventsOntoPlayers(events, basePlayers)
}

function yieldToScheduler() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 80 })
    else setTimeout(resolve, 0)
  })
}

// Resolve the plugin worker URL relative to the parent script (wiki shell).
export function resolveGlickoWorkerUrl() {
  try {
    if (typeof document !== 'undefined') {
      const scripts = document.getElementsByTagName('script')
      for (let i = scripts.length - 1; i >= 0; i -= 1) {
        const src = scripts[i]?.src || ''
        if (!src) continue
        if (/\/plugins\/chess\/chess\.js(\?|$)/i.test(src) || /\/chess\.js(\?|$)/i.test(src)) {
          return new URL('glicko-worker.js', src).href
        }
      }
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof location !== 'undefined') {
      return new URL('/plugins/chess/glicko-worker.js', location.origin).href
    }
  } catch {
    /* ignore */
  }
  return ''
}

// Replay verified timeline events in a Worker when available; fall back to chunked
// main-thread yielding so the UI can paint progress.
export async function recomputeGlobalTimelineOffMain(pool, opts = {}, { onProgress = null } = {}) {
  const games = Array.isArray(pool) ? pool : []
  const blockList = normalizeBlockList(opts.blockList)
  const workerUrl = resolveGlickoWorkerUrl()
  if (typeof Worker !== 'undefined' && workerUrl) {
    try {
      const result = await new Promise((resolve, reject) => {
        let worker
        try {
          worker = new Worker(workerUrl, { type: 'module' })
        } catch (err) {
          reject(err)
          return
        }
        const finish = (fn, payload) => {
          try {
            worker.terminate()
          } catch {
            /* ignore */
          }
          fn(payload)
        }
        worker.onmessage = event => {
          const msg = event.data || {}
          if (msg.type === 'progress') {
            onProgress?.(msg)
            return
          }
          if (msg.type === 'done') {
            finish(resolve, msg.result)
            return
          }
          if (msg.type === 'error') {
            finish(reject, new Error(msg.error || 'Glicko worker failed'))
          }
        }
        worker.onerror = err => finish(reject, err?.error || err || new Error('Glicko worker error'))
        worker.postMessage({ games, blockList, chunkEvents: 48 })
      })
      return result
    } catch {
      /* fall through to async main-thread path */
    }
  }
  return recomputeGlobalTimelineAsync(pool, opts, {
    chunkEvents: 28,
    onProgress,
  })
}

export async function recomputeGlobalTimelineAsync(pool, opts = {}, { chunkEvents = 40, onProgress = null } = {}) {
  const events = collectVerifiedTimelineEvents(pool, opts)
  let players = {}
  const chunks = []
  for (let i = 0; i < events.length; i += chunkEvents) chunks.push(events.slice(i, i + chunkEvents))
  const total = events.length
  for (let c = 0; c < chunks.length; c += 1) {
    const partial = replayEventsOntoPlayers(chunks[c], players)
    players = partial.players
    const done = Math.min((c + 1) * chunkEvents, total)
    onProgress?.({
      type: 'progress',
      eventsDone: done,
      eventsTotal: total,
      message: total > 0 ? `Recomputing ratings ${done}/${total}…` : 'Recomputing ratings…',
    })
    if (c < chunks.length - 1) await yieldToScheduler()
  }
  const last = events.length ? events[events.length - 1] : null
  return {
    players,
    events,
    stateHash: computeStateHash(players),
    lastGameHash: last ? readGameTimelineKey(last.pgn).hash : '',
    lastTimelineKey: last ? last.key : '',
  }
}

function buildConsensusResult(deep, { mode, acceptedHash, queueAudit = false, island = null } = {}) {
  const entries = buildLeaderboardFromPlayers(deep.players, { now: Date.now() })
  const rootOrphanHash = deep.rootOrphanHash || findRootOrphanHash(deep.events)
  const checkpoint = {
    last_global_sync_timestamp: new Date().toISOString(),
    last_processed_game_hash: deep.lastGameHash,
    last_timeline_key: deep.lastTimelineKey,
    state_hash: deep.stateHash,
  }
  if (rootOrphanHash) checkpoint.island_id = rootOrphanHash
  return {
    entries,
    players: deep.players,
    stateHash: deep.stateHash,
    deepStateHash: deep.stateHash,
    lastProcessedGameHash: deep.lastGameHash,
    lastTimelineKey: deep.lastTimelineKey,
    rootOrphanHash,
    island,
    checkpoint,
    mode,
    acceptedHash: acceptedHash || deep.stateHash,
    queueAudit: Boolean(queueAudit),
  }
}

function recomputeGlobalTimeline(pool, { blockList = [] } = {}) {
  const blocked = normalizeBlockList(blockList)
  const events = collectVerifiedTimelineEvents(pool, { blockList: blocked })
  return replayEventsOntoPlayersBatched(events, {})
}

function finalizeDeepConsensusResult(
  deep,
  { peerCheckpoints = [], trustedPeers = [], deepRecompute = false, queueAudit = false, island = null } = {},
) {
  const acceptedHash = checkpointSupermajority(peerCheckpoints, trustedPeers)
  const mode = !deepRecompute && acceptedHash && acceptedHash === deep.stateHash ? 'checkpoint' : 'audit'
  return buildConsensusResult(deep, {
    mode,
    acceptedHash,
    queueAudit,
    island,
  })
}

// # Consensus Lazy Checkpoint and Audit Replay

export function runFederationConsensus({
  games = [],
  trustedPeers = [],
  localCheckpoint = null,
  peerCheckpoints = [],
  localPlayers = null,
  deepRecompute = false,
  blockList = [],
  island = null,
} = {}) {
  const blocked = normalizeBlockList(blockList)
  const acceptedHash = checkpointSupermajority(peerCheckpoints, trustedPeers)
  const localHash = String(localCheckpoint?.state_hash || '').trim()
  const afterKey = String(localCheckpoint?.last_timeline_key || '').trim()
  const newGames = filterGamesAfterTimelineKey(games, afterKey)

  if (!deepRecompute && localPlayers && localHash) {
    if (!newGames.length || localCheckpointStillCurrent(localCheckpoint, games)) {
      return buildConsensusResult(
        {
          players: clonePlayersMap(localPlayers),
          lastGameHash: localCheckpoint?.last_processed_game_hash || '',
          lastTimelineKey: afterKey,
          stateHash: localHash,
          events: [],
          rootOrphanHash: String(localCheckpoint?.island_id || '').trim(),
        },
        {
          mode: acceptedHash && localHash === acceptedHash ? 'lazy' : 'checkpoint',
          acceptedHash: acceptedHash || localHash,
          queueAudit: !acceptedHash,
          island,
        },
      )
    }
    if (acceptedHash && localHash === acceptedHash) {
      const incremental = applyIncrementalTimeline(localPlayers, games, {
        blockList: blocked,
        afterTimelineKey: afterKey,
      })
      return buildConsensusResult(incremental, {
        mode: 'checkpoint',
        acceptedHash,
        island,
      })
    }
    return buildConsensusResult(
      {
        players: clonePlayersMap(localPlayers),
        lastGameHash: localCheckpoint?.last_processed_game_hash || '',
        lastTimelineKey: afterKey,
        stateHash: localHash,
        events: [],
        rootOrphanHash: String(localCheckpoint?.island_id || '').trim(),
      },
      {
        mode: 'lazy',
        acceptedHash,
        queueAudit: true,
        island,
      },
    )
  }

  const deep = recomputeGlobalTimeline(games, { blockList: blocked })
  const nextIsland = computeIslandState(deep.events, deep.players, island)
  return finalizeDeepConsensusResult(deep, {
    peerCheckpoints,
    trustedPeers,
    deepRecompute,
    queueAudit: !acceptedHash || acceptedHash !== deep.stateHash,
    island: nextIsland,
  })
}

// True when the crawled pool ends at the same timeline cursor already stored locally.
export function localCheckpointStillCurrent(localCheckpoint, games) {
  const afterKey = String(localCheckpoint?.last_timeline_key || '').trim()
  const localHash = String(localCheckpoint?.state_hash || '').trim()
  if (!afterKey || !localHash) return false
  const pool = Array.isArray(games) ? games : []
  if (!pool.length) return true
  const newer = filterGamesAfterTimelineKey(pool, afterKey)
  return newer.length === 0
}

export async function runFederationConsensusAsync(opts = {}) {
  if (!opts.deepRecompute && opts.localPlayers && opts.localCheckpoint?.state_hash) {
    const fast = runFederationConsensus({ ...opts, deepRecompute: false })
    if (fast.mode === 'checkpoint' || fast.mode === 'lazy') return fast
  }
  const blocked = normalizeBlockList(opts.blockList)
  const localHash = String(opts.localCheckpoint?.state_hash || '').trim()
  if (
    !opts.deepRecompute &&
    opts.localPlayers &&
    localHash &&
    localCheckpointStillCurrent(opts.localCheckpoint, opts.games)
  ) {
    const acceptedHash = checkpointSupermajority(opts.peerCheckpoints, opts.trustedPeers)
    return buildConsensusResult(
      {
        players: clonePlayersMap(opts.localPlayers),
        lastGameHash: opts.localCheckpoint?.last_processed_game_hash || '',
        lastTimelineKey: String(opts.localCheckpoint?.last_timeline_key || ''),
        stateHash: localHash,
        events: [],
        rootOrphanHash: String(opts.localCheckpoint?.island_id || '').trim(),
      },
      {
        mode: acceptedHash && localHash === acceptedHash ? 'lazy' : 'checkpoint',
        acceptedHash: acceptedHash || localHash,
        queueAudit: !acceptedHash,
        island: opts.island || null,
      },
    )
  }
  const deep = await recomputeGlobalTimelineOffMain(
    opts.games || [],
    { blockList: blocked },
    {
      onProgress: opts.onProgress,
    },
  )
  const nextIsland = computeIslandState(deep.events, deep.players, opts.island)
  return finalizeDeepConsensusResult(deep, {
    peerCheckpoints: opts.peerCheckpoints,
    trustedPeers: opts.trustedPeers,
    deepRecompute: opts.deepRecompute,
    queueAudit:
      !checkpointSupermajority(opts.peerCheckpoints, opts.trustedPeers) ||
      checkpointSupermajority(opts.peerCheckpoints, opts.trustedPeers) !== deep.stateHash,
    island: nextIsland,
  })
}

export function buildLeaderboardFromPlayers(players, { now = Date.now(), games = null } = {}) {
  const pool = Array.isArray(games) ? games : null
  const rows = []
  for (const host of Object.keys(players || {}).sort()) {
    const base = { ...normalizeRatingState(players[host]), updated: players[host]?.updated || 0 }
    const decayed = decayRatingState(base, now)
    const s = normalizeRatingState(players[host])
    const color = pool?.length ? aggregateSiteStats(pool, host, decayed.rating) : null
    rows.push({
      site: host,
      name: host,
      rating: decayed.rating,
      rd: Math.round(decayed.rd),
      provisional: isProvisional(decayed),
      reliable: isReliable(decayed),
      verified: true,
      games: s.gamesPlayed,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      peak: s.peak,
      whiteWins: color ? color.whiteWins : s.whiteWins,
      whiteLosses: color ? color.whiteLosses : s.whiteLosses,
      whiteDraws: color ? color.whiteDraws : s.whiteDraws,
      blackWins: color ? color.blackWins : s.blackWins,
      blackLosses: color ? color.blackLosses : s.blackLosses,
      blackDraws: color ? color.blackDraws : s.blackDraws,
      winRate: s.gamesPlayed > 0 ? Math.round(((s.wins + s.draws * 0.5) / s.gamesPlayed) * 100) : 0,
      updated: base.updated,
      label: formatRatingLabel(decayed),
    })
  }
  rows.sort(compareEntries)
  return rows.map((row, i) => ({ rank: i + 1, ...row }))
}

export function applyLeaderboardConsensusToPage(page, opts = {}) {
  const { checkpoint, trustedPeers, force = false, listed } = opts
  const localSite = opts.localSite
  const prev = readFederationCharm(page)
  let peers = prev.trustedPeers
  if (trustedPeers !== undefined) peers = dedupeSites(trustedPeers)
  else if (listed !== undefined) peers = deriveGossipTrustedPeers(listed, { localSite, previous: peers })
  const rosterEntry = (Array.isArray(page?.story) ? page.story : []).find(isTrustedPeersStoryRoster)
  if (rosterEntry?.id && peers.length) applyPageAction(page, { type: 'remove', id: rosterEntry.id })
  const federation = {
    checkpoint: checkpoint ? normalizeCheckpointGossip(checkpoint) : prev.checkpoint,
    trustedPeers: peers,
  }
  const patch = normalizeChessCharmPatch({ federation })
  if (
    !force &&
    !shouldPublishFederationGossip(prev, {
      checkpoint: federation.checkpoint,
      trustedPeers: federation.trustedPeers,
    })
  ) {
    return false
  }
  return reviseChessCharmOnPage(page, patch)
}

export function buildLeaderboard({ games = [], hosts = null, now = Date.now(), requireVerified = false } = {}) {
  const pool = Array.isArray(games) ? games.filter(g => typeof g === 'string' && g.trim()) : []
  const roster = Array.isArray(hosts) && hosts.length ? dedupeSites(hosts) : ratedSitesInGames(pool)

  const rows = []
  for (const host of roster) {
    let resolved
    if (requireVerified) {
      // Strict board: rating derived solely from twin-verified games (recomputed).
      resolved = recomputeVerifiedRating(pool, host)
      if (!resolved) continue // no verified game → not on the strict board at all
    } else {
      const r = resolveSiteInPool(pool, host)
      if (!r || !r.state) continue // no rated game for this host
      resolved = { state: r.state, updated: r.updated || 0, verified: Boolean(r.verified), stats: null }
    }

    // Decay confidence to `now` from the freshest game's date so a long-idle player
    // reads as appropriately uncertain (their stored state carries no timestamp).
    const base = { ...normalizeRatingState(resolved.state), updated: resolved.updated || 0 }
    const decayed = decayRatingState(base, now)
    const identity = freshestIdentity(pool, host)
    // Career counts (games/wins/peak/…) come from scanning the pool, not the PGN headers
    // (which carry only rating/RD/volatility). The verified path counts only its own set.
    const stats = resolved.stats || aggregateSiteStats(pool, host, decayed.rating)
    const winRate = stats.games > 0 ? Math.round(((stats.wins + stats.draws * 0.5) / stats.games) * 100) : 0
    rows.push({
      site: host,
      name: identity?.name || host,
      rating: decayed.rating,
      rd: Math.round(decayed.rd),
      provisional: isProvisional(decayed),
      reliable: isReliable(decayed),
      verified: Boolean(resolved.verified),
      games: stats.games,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      peak: stats.peak,
      whiteWins: stats.whiteWins || 0,
      whiteLosses: stats.whiteLosses || 0,
      whiteDraws: stats.whiteDraws || 0,
      blackWins: stats.blackWins || 0,
      blackLosses: stats.blackLosses || 0,
      blackDraws: stats.blackDraws || 0,
      winRate,
      updated: resolved.updated || identity?.updated || 0,
      label: formatRatingLabel(decayed),
    })
  }

  rows.sort(compareEntries)
  const entries = rows.map((row, i) => ({ rank: i + 1, ...row }))
  return { entries, generatedAt: now }
}

// Highest rating first; on a tie prefer the more certain (lower RD), then a stable
// host ordering so the board never reshuffles between identical inputs.
function compareEntries(a, b) {
  if (b.rating !== a.rating) return b.rating - a.rating
  if (a.rd !== b.rd) return a.rd - b.rd
  const aSite = a.site ?? a.host ?? ''
  const bSite = b.site ?? b.host ?? ''
  return aSite < bSite ? -1 : aSite > bSite ? 1 : 0
}

export function standingFor(entries, { host = '', rating = null } = {}) {
  const board = Array.isArray(entries) ? entries : []
  const targetHost = cleanSite(host)

  const own = targetHost ? board.find(e => sitesMatch(e.site ?? e.host, targetHost)) : null
  if (own) {
    const total = board.length
    return { rank: own.rank, total, percentile: percentileFor(own.rank, total), listed: true }
  }

  if (rating == null || !Number.isFinite(Number(rating))) return null
  const r = Number(rating)
  // How many already-listed players the newcomer would sit at or above.
  const ahead = board.filter(e => e.rating > r).length
  const rank = ahead + 1
  const total = board.length + 1
  return { rank, total, percentile: percentileFor(rank, total), listed: false }
}

function percentileFor(rank, total) {
  if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 0) return 0
  return Math.round(((total - rank + 1) / total) * 100)
}

// # LeaderboardMeta Survey Item Text

export function parseSurveyRecord(text) {
  if (!isSurveyItemText(text)) return null
  const lines = String(text)
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(l => l.trim())
    .filter(Boolean)

  let name = ''
  for (const line of lines) {
    const nameMatch = line.match(SURVEY_NAME_LINE)
    if (nameMatch) name = nameMatch[1].trim()
  }

  return { survey: DEFAULT_SURVEY_ID, name }
}

export function buildSurveyItemText() {
  return SURVEY_KEYWORD
}

// # SiteClient PWA Bridge Notes

export const RATING_FETCH_MAX_PAGES = 25
// Cap parallel wiki page fetches so sitemap crawls cannot saturate the machine.
export const SITE_FETCH_CONCURRENCY = 4
const SITE_FETCH_MAX_PAGES = 250

// Run `fn` over `items` with at most `concurrency` in flight.
// Prefer this over bare `Promise.all(items.map(...))` for network I/O.
export async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1))
  if (!list.length) return []
  const out = new Array(list.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next
      next += 1
      out[i] = await fn(list[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export function asSitemapArray(res) {
  return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : null
}

export function newItemId() {
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

export function chessPgnsFromPage(page) {
  const story = storyFromWikiPage(page)
  return story
    .filter(entry => entry?.type === 'chess' && typeof entry.text === 'string' && entry.text.trim())
    .map(entry => entry.text)
}

export function chessChallengesFromPage(page, host, slug) {
  const story = Array.isArray(page?.story) ? page.story : []
  const title = String(page?.title || slug || '').trim()
  const out = []
  for (const entry of story) {
    if (entry?.type !== 'chess') continue
    if (typeof entry.text === 'string' && entry.text.trim()) {
      const pageChallenge = harvestPageOpenChallenge({
        host,
        slug,
        title,
        itemId: entry.id,
        pgn: entry.text,
        challenge: entry.challenge,
      })
      if (pageChallenge) out.push(pageChallenge)
      const direct = harvestDirectChallenge({
        host,
        slug,
        title,
        itemId: entry.id,
        pgn: entry.text,
        gameSettings: entry.gameSettings,
        challenge: entry.challenge,
      })
      if (direct) out.push(direct)
    }
  }
  // Pending seeks live on the SURVEY item's `openChallenges` metadata until accepted.
  out.push(...harvestSurveyOpenChallenges(page, host, slug))
  return out
}

export function chessAcceptedGhostsFromPage(page, host, slug) {
  const story = Array.isArray(page?.story) ? page.story : []
  const title = String(page?.title || slug || '').trim()
  const out = []
  for (const entry of story) {
    if (entry?.type !== 'chess' || typeof entry.text !== 'string' || !entry.text.trim()) continue
    const accepted = harvestAcceptedGhostGame({
      host,
      slug,
      title,
      itemId: entry.id,
      pgn: entry.text,
      challenge: entry.challenge,
    })
    if (accepted) out.push(accepted)
  }
  return out
}

export function findSurveyItem(story) {
  return (Array.isArray(story) ? story : []).find(
    entry => entry?.type === 'chess' && typeof entry.text === 'string' && isSurveyItemText(entry.text),
  )
}

export function surveyOpenChallengesChanged(before, after) {
  return JSON.stringify(before?.openChallenges || null) !== JSON.stringify(after?.openChallenges || null)
}

export function buildChallengeJoinStory(item, challenge, creatorSite) {
  const creatorLabel = playerDisplayLabel(challenge?.creator?.id || '') || creatorSite
  const joinerLabel = playerDisplayLabel(challenge?.opponent?.id || '')
  const chessItem = {
    type: 'chess',
    id: item.id,
    text: item.text,
  }
  if (item.gameSettings) chessItem.gameSettings = item.gameSettings
  if (challenge) chessItem.challenge = challenge
  return [
    {
      type: 'paragraph',
      id: newItemId(),
      text: openChallengeAcceptParagraph(joinerLabel, creatorLabel),
    },
    chessItem,
  ]
}

export function resolveJoinerName(hint, localSite, ownerName = '') {
  const bad = name => !String(name || '').trim() || /^(open|you|guest)$/i.test(String(name).trim())
  let name = String(hint || '').trim()
  if (bad(name)) name = resolveSignedInUsername(ownerName) || ''
  if (bad(name) && localSite) {
    const fromSeat = playerDisplayLabel(formatPlayerId('player', localSite))
    if (!bad(fromSeat)) name = fromSeat
  }
  return bad(name) ? 'You' : name
}

// Build a new game page after accepting an open challenge (no wiki ghost UI).
export function buildJoinChallengePage({
  ghostPgn,
  challenge,
  itemId,
  joinerDisplayName,
  joinerSite,
  creatorSite,
  ownerName = '',
  remoteTitle = '',
}) {
  const challengeState = normalizeChallengeState(challenge)
  const baseGhostPgn = String(ghostPgn || '').trim()
  if (!challengeState || !isOpenChallenge(challengeState) || !baseGhostPgn) {
    throw new Error('Invalid open challenge')
  }
  const id = String(itemId || '').trim() || newItemId()
  const joinerName = resolveJoinerName(joinerDisplayName, joinerSite, ownerName)
  const joinerId = formatPlayerId(joinerName, joinerSite)
  const seatedPgn = buildChallengeJoinGhostPgn(baseGhostPgn, challengeState, joinerId)
  const acceptedChallenge = acceptOpenChallenge(challengeState, { joinerId, joinerSite }) || challengeState
  const resolvedRemote = openChallengeDisplayTitle({
    challenge: challengeState,
    title: String(remoteTitle || '').trim(),
  })
  const baseTitle = proposeOpenChallengePageTitle(challengeState, joinerName, resolvedRemote, {
    joinerId,
  })
  const item = {
    type: 'chess',
    id,
    text: seatedPgn,
    challenge: acceptedChallenge,
  }
  const story = buildChallengeJoinStory(item, acceptedChallenge, creatorSite)
  const journalActions = buildJoinAcceptGhost(baseGhostPgn, seatedPgn, {
    itemId: id,
    challenge: acceptedChallenge,
    ts: Number.isFinite(acceptedChallenge?.ts) ? acceptedChallenge.ts : Date.now(),
  })
  return {
    baseTitle,
    slug: null,
    itemId: id,
    seatedPgn,
    challenge: acceptedChallenge,
    story,
    journalActions,
    item,
  }
}

export function materializeJoinChallengePage(payload, { slug, title }) {
  const page = {
    title: title || payload.baseTitle,
    story: [],
    journal: [],
  }
  const ts = Date.now()
  applyPageAction(page, {
    type: 'create',
    item: { title: page.title, story: payload.story },
    date: ts - 3,
  })
  applyPageActions(page, payload.journalActions)
  applyPageAction(page, {
    type: 'edit',
    id: payload.itemId,
    item: payload.item,
    date: ts,
  })
  page.story = rebuildStoryFromJournal(page)
  return { page, slug }
}

export function syncOpenChallengeSurveyOnPage(page, { add = null, removeIds = [] } = {}) {
  const story = Array.isArray(page?.story) ? page.story : []
  const ids = (Array.isArray(removeIds) ? removeIds : []).map(id => String(id || '').trim()).filter(Boolean)
  const surveyItem = findSurveyItem(story)
  if (!surveyItem) return { changed: false, error: 'no-survey-item' }

  for (const id of ids) {
    const entry = story.find(row => row?.id === id)
    if (entry?.type === 'chess' && !isSurveyItemText(entry?.text)) {
      applyPageAction(page, { type: 'remove', id })
    }
  }

  const updated = applyOpenChallengeSurveyEdit(findSurveyItem(page.story), { add, removeIds: ids })
  if (!updated) return { changed: false }
  if (!add && !ids.length) return { changed: false }
  if (!surveyOpenChallengesChanged(surveyItem, updated) && !ids.length) {
    return { changed: false }
  }
  applyPageAction(page, { type: 'edit', id: surveyItem.id, item: updated })
  page.story = rebuildStoryFromJournal(page)
  return { changed: true }
}

const ACADEMY_MOVE_GAP_MS = 60_000

function stableAcademyStartMs(seed = '') {
  let h = 2166136261
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  // Spread across 2024–2025 so sitemap dates look like a lived-in garden, not "now".
  return Date.UTC(2024, 0, 1) + ((h >>> 0) % (450 * 86_400_000))
}

function fenAfterGamePgn(pgnBody) {
  try {
    const pgn = new Pgn(canonicalizePersistedChessText(pgnBody))
    return normalizeFen(pgn?.history?.fen || '') || undefined
  } catch {
    return undefined
  }
}

// Rewrite an academy teaching page so annotated GAME boards carry a play-style
// journal: create → add story items → ⚔ seed → one edit per ply. Twin-site fork
// stamps (`chess-academy-play.localhost`) are optional — curate enables them only
// for the five core model games. Final story matches `story` (GAME items may gain
// Site/Date headers via ensureStandardPgnHeaders).
export function buildAcademyTeachingPageWithJournal(
  { title, story },
  {
    wikiSite = 'chess-academy.localhost',
    twinSite = academyPlayTwinSite(wikiSite),
    stampTwinForks = true,
    startMs,
    seed = title || '',
  } = {},
) {
  const intended = Array.isArray(story) ? story.map(item => ({ ...item })) : []
  const pageTitle = String(title || 'Chess Academy').trim() || 'Chess Academy'
  const page = { title: pageTitle, story: [], journal: [] }
  let t = Number.isFinite(startMs) ? startMs : stableAcademyStartMs(seed)
  const twin = String(twinSite || academyPlayTwinSite(wikiSite)).trim() || academyPlayTwinSite(wikiSite)
  const useTwinForks = stampTwinForks !== false

  applyPageAction(page, {
    type: 'create',
    item: { title: pageTitle, story: [] },
    date: t,
  })
  t += 1_000

  let after = ''
  for (const item of intended) {
    if (!item?.id) continue
    applyPageAction(page, {
      type: 'add',
      item: { type: 'factory', id: item.id },
      id: item.id,
      after,
      date: t,
    })
    t += 500

    if (item.type === 'chess' && isAnnotatedGameChessText(item.text)) {
      const body = gamePgnBodyFromItemText(item.text)
      // Teaching scoresheets opt into the comments banner via `[Comments "on"]`
      // (ordinary GAME boards default that setting off).
      const stamped = setPgnTag(
        ensureStandardPgnHeaders(body, {
          wikiSite,
          itemId: item.id,
          wikiPageTitle: pageTitle,
        }),
        'Comments',
        'on',
      )
      const parts = parsePgnParts(stamped)
      const sans = sanTokens(parts.movetext)
      const seatedBody = formatPgnParts({
        tags: { ...parts.tags, Result: '*' },
        movetext: '',
      })
      const seatedText = asGameItemText(seatedBody)
      const finalText = asGameItemText(stamped)

      applyPageAction(page, {
        type: 'edit',
        id: item.id,
        item: { type: 'chess', id: item.id, text: 'GAME' },
        date: t,
        symbol: CHESS_CREATE_SYMBOL,
      })
      t += 500

      applyChessSaveToPage(page, item.id, seatedText, {
        prevText: 'GAME',
        date: t,
        fen: fenAfterGamePgn(seatedBody),
      })
      t += ACADEMY_MOVE_GAP_MS

      let prevText = seatedText
      for (let ply = 0; ply < sans.length; ply += 1) {
        const partialBody = pgnThroughPlies(stamped, ply)
        const nextText = asGameItemText(partialBody)
        const blackPly = !isOwnCorrespondencePly('white', ply)
        applyChessSaveToPage(page, item.id, nextText, {
          prevText,
          date: t,
          fen: fenAfterGamePgn(partialBody),
          forkSite: useTwinForks && blackPly ? twin : undefined,
        })
        prevText = nextText
        t += ACADEMY_MOVE_GAP_MS
      }

      // Keep story item text in sync with any header stamping above.
      item.text = finalText
      const current = page.story.find(entry => entry?.id === item.id)
      if (current) current.text = finalText
    } else {
      applyPageAction(page, {
        type: 'edit',
        id: item.id,
        item: { ...item },
        date: t,
      })
      t += 500
    }
    after = item.id
  }

  page.story = rebuildStoryFromJournal(page)
  return page
}

// Twin-site journal forks — only these five core model games (curriculum isolation).
export const ACADEMY_TWIN_FORK_GAME_SLUGS = Object.freeze([
  'the-opera-game',
  'the-immortal-game',
  'the-evergreen-game',
  'greek-gift',
  'back-rank-caution',
])

export function academyPageStampsTwinForks(slug) {
  return ACADEMY_TWIN_FORK_GAME_SLUGS.includes(String(slug || '').trim())
}

// # SiteClient Browser Wiki Fetch
// Why two clients: browser shell uses wiki.site callbacks; installed PWA has no iframe parent
// and reads pages over HTTP via createPwaBridgeSiteClient. Both return null on miss/error.

// wiki.site-shaped client for cross-wiki fetch in the wiki shell (browser). PWA bridge uses createPwaBridgeSiteClient.
export function createBrowserWikiSiteClient(wikiRef) {
  return {
    getPage(host, path) {
      return new Promise(resolve => {
        if (typeof wikiRef?.site !== 'function') return resolve(null)
        try {
          wikiRef.site(host).get(path, (err, page) => resolve(err ? null : page))
        } catch {
          resolve(null)
        }
      })
    },
  }
}

export function chessItemStateFromPage(page, itemId) {
  const story = Array.isArray(page?.story) ? page.story : []
  const item = story.find(entry => entry?.id === itemId)
  if (!item || item.type !== 'chess') return null
  const slug = page?.slug
  const text = String(item.text || '').trim()
  const resolved = resolveChessState(parseChessItem(text))
  return {
    itemId,
    pageKey: slug,
    wikiPageName: slug,
    wikiPageTitle: page?.title || slug,
    ...resolved,
    chessState: text,
    gameSettings: item.gameSettings,
    challenge: item.challenge,
    pageOnThisWiki: true,
    ownerCanJournalHere: true,
  }
}

export function buildNewGamePage({ title, text, itemId, ownerName, wikiSite }) {
  const id = String(itemId || '').trim() || newItemId()
  const pageTitle = String(title || 'Chess Game').trim() || 'Chess Game'
  const item = { type: 'chess', id, text }
  const story = [
    {
      type: 'paragraph',
      id: newItemId(),
      text: 'Optional notes about this game — time control, occasion, or opening.',
    },
    item,
  ]
  const page = { title: pageTitle, story: [], journal: [] }
  applyPageAction(page, {
    type: 'create',
    item: { title: pageTitle, story },
    date: Date.now(),
  })
  if (text && text !== 'GAME') {
    applyChessSaveToPage(page, id, text)
  } else {
    applyPageAction(page, { type: 'edit', id, item: { ...item, text: text || 'GAME' } })
    page.story = rebuildStoryFromJournal(page)
  }
  return {
    page,
    itemId: id,
    title: pageTitle,
    ownerName,
    wikiSite,
  }
}

// Site client: getPage(host, slug) → page|null, listSlugs(host) → slug[]
export async function fetchSiteContentAsync(site, host, slug) {
  if (!host || !site?.getPage) {
    return { games: [], hasRatedGames: false, challenges: [], acceptedGhosts: [] }
  }
  const fallback = async () => {
    if (!slug) return { games: [], hasRatedGames: false, challenges: [], acceptedGhosts: [] }
    const page = await site.getPage(host, `${slug}.json`)
    if (!page) return { games: [], hasRatedGames: false, challenges: [], acceptedGhosts: [] }
    const games = chessPgnsFromPage(page)
    return {
      games,
      hasRatedGames: siteHasRatedGames(games, host),
      challenges: chessChallengesFromPage(page, host, slug),
      acceptedGhosts: chessAcceptedGhostsFromPage(page, host, slug),
    }
  }

  let sitemap
  try {
    sitemap = asSitemapArray(await site.getPage(host, 'system/sitemap.json'))
  } catch {
    return fallback()
  }
  if (!sitemap?.length) return fallback()

  let slugs = sitemap
    .slice()
    .sort((a, b) => Number(b?.date ?? 0) - Number(a?.date ?? 0))
    .map(entry => entry?.slug)
    .filter(Boolean)
    .slice(0, RATING_FETCH_MAX_PAGES)
  if (hasSurveyPage(sitemap) && !slugs.includes(SURVEY_PAGE_SLUG)) slugs.push(SURVEY_PAGE_SLUG)
  if (!slugs.length) {
    return { games: [], hasRatedGames: false, challenges: [], acceptedGhosts: [] }
  }

  const games = []
  const challenges = []
  const acceptedGhosts = []
  await mapWithConcurrency(slugs, SITE_FETCH_CONCURRENCY, async pageSlug => {
    try {
      const page = await site.getPage(host, `${pageSlug}.json`)
      if (!page) return
      games.push(...chessPgnsFromPage(page))
      challenges.push(...chessChallengesFromPage(page, host, pageSlug))
      acceptedGhosts.push(...chessAcceptedGhostsFromPage(page, host, pageSlug))
    } catch {
      /* skip host page */
    }
  })
  return {
    games,
    hasRatedGames: siteHasRatedGames(games, host),
    challenges,
    acceptedGhosts,
  }
}

// Open-challenge discovery for one host: fetch only the SURVEY page (`my-chess-games`),
// not the full sitemap. Pending seeks live on SURVEY `openChallenges` metadata.
export async function fetchSiteSurveyChallengesAsync(site, host, slug = SURVEY_PAGE_SLUG) {
  if (!host || !site?.getPage) {
    return { challenges: [], acceptedGhosts: [], ok: false }
  }
  const wanted = String(slug || '').trim()
  const trySlugs = [...new Set([wanted, SURVEY_PAGE_SLUG].filter(Boolean))]
  for (const pageSlug of trySlugs) {
    try {
      const page = await site.getPage(host, `${pageSlug}.json`)
      if (!page) continue
      return {
        challenges: chessChallengesFromPage(page, host, pageSlug),
        acceptedGhosts: chessAcceptedGhostsFromPage(page, host, pageSlug),
        ok: true,
      }
    } catch {
      /* try next slug */
    }
  }
  return { challenges: [], acceptedGhosts: [], ok: false }
}

// Crawl seed hosts for open challenges via SURVEY pages only (no sitemap fan-out, no
// opponent-graph BFS). Optional `onBatch` reports progressive merges (throttled).
export async function fetchChallengesAsync(site, seeds, slug, { blockList = [], onBatch = null } = {}) {
  const seen = new Set()
  const blocked = blockListSet(blockList)
  const challenges = []
  const acceptedGhosts = []
  const responsiveHosts = []

  const batch = dedupeSites(seeds).filter(h => {
    if (seen.has(h)) return false
    if ([...blocked].some(b => sitesMatch(b, h))) return false
    return true
  })
  for (const h of batch) seen.add(h)

  let lastReportAt = 0
  let reportTimer = null
  const emit = done => {
    onBatch?.({
      challenges: challenges.slice(),
      acceptedGhosts: acceptedGhosts.slice(),
      crawled: [...seen],
      responsiveHosts: responsiveHosts.slice(),
      done: Boolean(done),
      partial: !done,
    })
  }
  const scheduleReport = done => {
    if (!onBatch) return
    if (done) {
      if (reportTimer) {
        clearTimeout(reportTimer)
        reportTimer = null
      }
      emit(true)
      return
    }
    const now = Date.now()
    if (now - lastReportAt >= CHALLENGE_BATCH_THROTTLE_MS) {
      lastReportAt = now
      emit(false)
      return
    }
    if (reportTimer) return
    reportTimer = setTimeout(() => {
      reportTimer = null
      lastReportAt = Date.now()
      emit(false)
    }, CHALLENGE_BATCH_THROTTLE_MS)
  }

  if (!batch.length) {
    scheduleReport(true)
    return { challenges, acceptedGhosts, crawled: [...seen], responsiveHosts }
  }

  await mapWithConcurrency(batch, SITE_FETCH_CONCURRENCY, async host => {
    const result = await fetchSiteSurveyChallengesAsync(site, host, slug)
    if (result.ok) responsiveHosts.push(cleanSite(host))
    for (const c of result.challenges) challenges.push(c)
    for (const a of result.acceptedGhosts || []) acceptedGhosts.push(a)
    scheduleReport(false)
  })

  scheduleReport(true)
  return { challenges, acceptedGhosts, crawled: [...seen], responsiveHosts }
}

export async function fetchSitesAsync(site, hosts, slug) {
  const limited = dedupeSites(hosts)
  if (!limited.length) return { games: [], crawled: [] }
  const games = []
  const results = await mapWithConcurrency(limited, SITE_FETCH_CONCURRENCY, host =>
    fetchSiteContentAsync(site, host, slug),
  )
  for (const { games: siteGames } of results) {
    for (const pgn of siteGames) games.push(pgn)
  }
  return { games, crawled: limited }
}

// # Crawl Opponent Graph BFS

export async function fetchFederationGamesAsync(site, seeds, opts = {}) {
  const {
    blockList = [],
    afterTimelineKey = '',
    shouldAbort = null,
    onProgress = null,
    onSiteHub = null,
    fetchReach = 'survey',
    expandGraph = true,
  } = opts
  const localSite = opts.localSite ?? ''
  const seen = new Set()
  const listed = new Set()
  const queued = new Set()
  const allGames = []
  const blocked = normalizeBlockList(blockList)
  const reach = fetchReach === 'mine' ? 'mine' : fetchReach === 'neighborhood' ? 'neighborhood' : 'survey'
  const local = cleanSite(localSite)
  // Neighbourhood (or explicit opts) can restore hop-trust weeding; survey stays unlimited.
  const useHopTrust = opts.useHopTrust === true || opts.maxHops != null || opts.hopDecay != null
  const hopGraph = useHopTrust ? normalizeNeighborhoodGraphOpts(opts) : null
  const hopStatsMap = new Map()
  const bumpHopStat = (hop, field) => {
    let row = hopStatsMap.get(hop)
    if (!row) {
      row = { hop, kept: 0, weededMaxHops: 0, weededDecay: 0 }
      hopStatsMap.set(hop, row)
    }
    row[field] += 1
  }
  let waveNumber = 0

  const finish = () => ({
    games: allGames,
    listed: [...listed],
    crawled: [...seen],
    hopStats: [...hopStatsMap.values()].sort((a, b) => a.hop - b.hop),
    hopGraph,
  })

  const tryEnqueue = (host, hop, next) => {
    const o = cleanSite(host)
    if (!o || seen.has(o) || queued.has(o) || isSiteBlocked(o, blocked)) return
    if (hopGraph) {
      if (hop > hopGraph.maxHops) {
        bumpHopStat(hop, 'weededMaxHops')
        return
      }
      if (hopTrustAt(hop, hopGraph.hopDecay) < hopGraph.trustFloor) {
        bumpHopStat(hop, 'weededDecay')
        return
      }
      bumpHopStat(hop, 'kept')
    }
    queued.add(o)
    next.push({ host: o, hop })
  }

  // Survey / neighbourhood: rated-opponent BFS from seeds. Mine: one hop from local.
  // Optional hop trust (max hops + decay × floor) weeds candidates before they are crawled.
  const fetchWave = async wave => {
    if (shouldAbort?.()) return null
    const batch = (Array.isArray(wave) ? wave : [])
      .map(item =>
        typeof item === 'string' || typeof item === 'number'
          ? { host: cleanSite(item), hop: 0 }
          : { host: cleanSite(item?.host), hop: Math.max(0, Math.trunc(Number(item?.hop) || 0)) },
      )
      .filter(({ host: h }) => h && !seen.has(h) && !isSiteBlocked(h, blocked))
    if (!batch.length) return finish()

    waveNumber += 1
    const next = []
    for (let i = 0; i < batch.length; i += 1) {
      const { host: h, hop } = batch[i]
      if (shouldAbort?.()) return null
      seen.add(h)
      queued.delete(h)
      const remainingInWave = batch.length - (i + 1)
      const queuedEstimate = remainingInWave + next.length
      onProgress?.({
        phase: 'crawl',
        message:
          waveNumber === 1
            ? `Crawling ${h} (${seen.size} done, ${queuedEstimate} queued)…`
            : `Opponent graph hop ${hop} (wave ${waveNumber}): crawling ${h} (${seen.size} done, ${queuedEstimate} queued)…`,
        site: h,
        hostIndex: seen.size,
        hostTotal: seen.size + queuedEstimate,
        wave: waveNumber,
        hop,
        gamesFound: allGames.length,
        discoveredPending: queuedEstimate,
        hopStats: [...hopStatsMap.values()],
      })
      if (onSiteHub) await onSiteHub(h)
      const { games, hasRatedGames } = await collectSiteGamesAsync(site, h, {
        blockList: blocked,
        afterTimelineKey,
      })
      if (shouldAbort?.()) return null
      for (const pgn of games) allGames.push(pgn)
      if (hasRatedGames) listed.add(h)
      if (expandGraph && (reach === 'survey' || reach === 'neighborhood')) {
        for (const opp of federationOpponentSitesFromGames(games)) {
          tryEnqueue(opp, hop + 1, next)
        }
      } else if (expandGraph && reach === 'mine' && hop === 0 && sitesMatch(h, local)) {
        for (const opp of pastOpponentSitesFromGames(games, local)) {
          tryEnqueue(opp, 1, next)
        }
      }
      const queuedAfter = remainingInWave + next.length
      onProgress?.({
        phase: 'crawl',
        message: `Crawled ${h} — ${allGames.length} games · ${next.length} new sites queued via opponent graph`,
        site: h,
        hostIndex: seen.size,
        hostTotal: seen.size + queuedAfter,
        wave: waveNumber,
        hop,
        gamesFound: allGames.length,
        discoveredPending: queuedAfter,
        hopStats: [...hopStatsMap.values()],
      })
    }
    if (!expandGraph) return finish()
    return fetchWave(next)
  }

  // With hop trust: local is hop 0; other *personal* crawl seeds (wiki neighbours /
  // past opponents) start at remoteSeedHop (default 1) so “opponents of opponents”
  // is hop 2 — otherwise seeding every neighbour at hop 0 collapses a connected
  // league into a one-hop blob. Federation-search / index hosts must not be seeded
  // here (see buildLeaderboardAsync); they would all land at hop 1 and defeat max hops.
  const remoteSeedHop = Math.max(0, Math.trunc(Number(opts.remoteSeedHop ?? (hopGraph ? 1 : 0)) || 0))
  const seedWave = []
  for (const seed of dedupeSites(seeds)) {
    const h = cleanSite(seed)
    if (!h || isSiteBlocked(h, blocked)) continue
    const hop = hopGraph && local && sitesMatch(h, local) ? 0 : hopGraph ? remoteSeedHop : 0
    if (hopGraph) {
      if (hop > hopGraph.maxHops) {
        bumpHopStat(hop, 'weededMaxHops')
        continue
      }
      if (hopTrustAt(hop, hopGraph.hopDecay) < hopGraph.trustFloor) {
        bumpHopStat(hop, 'weededDecay')
        continue
      }
      bumpHopStat(hop, 'kept')
    }
    queued.add(h)
    seedWave.push({ host: h, hop })
  }
  return fetchWave(seedWave)
}

export async function fetchSiteGamePagesAsync(site, host) {
  if (!host || !site?.getPage) return { pageGames: [], openChallenges: [] }
  let sitemap
  try {
    sitemap = asSitemapArray(await site.getPage(host, 'system/sitemap.json'))
  } catch {
    return { pageGames: [], openChallenges: [] }
  }
  if (!sitemap?.length) return { pageGames: [], openChallenges: [] }

  let slugs = sitemap
    .slice()
    .sort((a, b) => Number(b?.date ?? 0) - Number(a?.date ?? 0))
    .map(entry => entry?.slug)
    .filter(Boolean)
    .slice(0, SITE_FETCH_MAX_PAGES)
  if (hasSurveyPage(sitemap) && !slugs.includes(SURVEY_PAGE_SLUG)) {
    slugs.push(SURVEY_PAGE_SLUG)
  }
  if (!slugs.length) return { pageGames: [], openChallenges: [] }

  const pageGames = []
  const openChallenges = []
  await mapWithConcurrency(slugs, SITE_FETCH_CONCURRENCY, async slug => {
    try {
      const page = await site.getPage(host, `${slug}.json`)
      if (!page) return
      const story = storyFromWikiPage(page)
      const title = titleFromWikiPage(page, slug)
      for (const item of story) {
        if (item?.type !== 'chess' || typeof item.text !== 'string' || !item.text.trim()) continue
        if (!isSurveyItemText(item.text)) {
          pageGames.push({
            slug,
            title,
            pgn: item.text,
            itemId: item.id,
            challenge: item.challenge,
            host,
          })
        }
        for (const challenge of chessChallengesFromPage({ title, story: [item] }, host, slug)) {
          openChallenges.push({
            slug: challenge.slug,
            title: challenge.title,
            itemId: challenge.itemId,
            pending: challenge.pending,
            pgn: challenge.pgn,
            challenge: challenge.challenge,
            site: challenge.site ?? challenge.host,
          })
        }
      }
    } catch {
      /* skip page */
    }
  })
  return { pageGames, openChallenges }
}

export async function collectSiteGamesAsync(site, host, { blockList = [], afterTimelineKey = '' } = {}) {
  const h = cleanSite(host)
  const blocked = blockListSet(blockList)
  if (!h || isSiteBlocked(h, blocked) || !site?.getPage) {
    return { games: [], hasRatedGames: false }
  }

  const seenFp = new Set()
  const games = []
  const addPgn = pgn => {
    if (typeof pgn !== 'string' || !pgn.trim()) return
    const fp = gameFingerprint(pgn)
    if (seenFp.has(fp)) return
    seenFp.add(fp)
    games.push(pgn.trim())
  }

  const { pageGames } = await fetchSiteGamePagesAsync(site, h)
  for (const row of pageGames) addPgn(row.pgn)

  const filtered = afterTimelineKey ? filterGamesAfterTimelineKey(games, afterTimelineKey) : games
  return {
    games: filtered,
    hasRatedGames: siteHasRatedGames(filtered.length ? filtered : games, h),
  }
}

export async function readLeaderboardHubAsync(site, host) {
  try {
    const page = await site.getPage(host, `${LEADERBOARD_PAGE_SLUG}.json`)
    const story = storyFromWikiPage(page)
    if (!story.length && !page?.chess) {
      return { checkpoint: null, trustedPeers: [] }
    }
    const federation = readFederationCharm(page)
    return {
      checkpoint: federation.checkpoint,
      trustedPeers: readTrustedPeers(page),
    }
  } catch {
    return { checkpoint: null, trustedPeers: [] }
  }
}

// # Consensus Network Orchestrator

export async function consensusFromNetwork(site, seeds, opts = {}) {
  const {
    deepRecompute = false,
    blockList = [],
    localCheckpoint = null,
    localPlayers = null,
    deletionMetrics = null,
    island = null,
    shouldAbort = null,
    onProgress = null,
    fetchReach = 'survey',
    hopGraph: hopGraphRaw = null,
  } = opts
  const localSite = opts.localSite ?? ''
  // Visible-federation dials bound the opponent-graph walk; omit hopGraph for an unlimited crawl.
  const hopGraph = hopGraphRaw && typeof hopGraphRaw === 'object' ? normalizeNeighborhoodGraphOpts(hopGraphRaw) : null
  const startedAt = Date.now()
  const blocked = normalizeBlockList(blockList)
  const report = patch => {
    onProgress?.({
      startedAt,
      elapsedMs: Date.now() - startedAt,
      deepRecompute,
      ...(hopGraph ? { hopGraph } : {}),
      ...patch,
    })
  }
  const hosts = dedupeSites(seeds)
  const hubsRead = new Set(hosts.map(cleanSite))
  const local = cleanSite(localSite)
  // Hop-bounded surveys only need the local hub for gossip / trusted peers — reading a
  // bloated seed list here is what left the UI stuck on “Updating federation ratings…”.
  const hubHosts = hopGraph ? dedupeSites([local].filter(Boolean)) : hosts
  report({
    phase: 'hubs',
    hostTotal: hubHosts.length,
    message:
      hubHosts.length > 1
        ? `Reading federation hubs (0/${hubHosts.length})…`
        : hopGraph
          ? `Starting opponent-graph crawl (max ${hopGraph.maxHops} hops, decay ${hopGraph.hopDecay})…`
          : 'Reading your federation hub…',
  })
  const peerCheckpoints = []
  let trustedPeers = []
  const localHub = local ? await readLeaderboardHubAsync(site, local) : { trustedPeers: [] }
  let hubsDone = 0
  const hubRows = await mapWithConcurrency(hubHosts, SITE_FETCH_CONCURRENCY, async h => {
    if (shouldAbort?.()) return null
    const hub = sitesMatch(h, local) ? localHub : await readLeaderboardHubAsync(site, h)
    hubsDone += 1
    if (hubHosts.length > 1) {
      report({
        phase: 'hubs',
        hostTotal: hubHosts.length,
        hostIndex: hubsDone,
        message: `Reading federation hubs (${hubsDone}/${hubHosts.length})…`,
      })
    }
    return { h, hub }
  })
  if (shouldAbort?.()) return null
  for (const row of hubRows) {
    if (!row) continue
    const { h, hub } = row
    if (sitesMatch(h, local) && hub.trustedPeers?.length) trustedPeers = hub.trustedPeers
    if (hub.checkpoint?.state_hash) peerCheckpoints.push({ site: h, checkpoint: hub.checkpoint })
  }
  if (!trustedPeers.length && localHub.trustedPeers?.length) trustedPeers = localHub.trustedPeers

  const acceptedHash = checkpointSupermajority(peerCheckpoints, trustedPeers)
  const localHash = String(localCheckpoint?.state_hash || '').trim()
  const localPlayersReady = localPlayers && typeof localPlayers === 'object' && Object.keys(localPlayers).length

  if (!hopGraph && !deepRecompute && localPlayersReady && localHash && (!acceptedHash || localHash !== acceptedHash)) {
    const lazy = buildConsensusResult(
      {
        players: clonePlayersMap(localPlayers),
        lastGameHash: localCheckpoint?.last_processed_game_hash || '',
        lastTimelineKey: String(localCheckpoint?.last_timeline_key || ''),
        stateHash: localHash,
        events: [],
        rootOrphanHash: String(localCheckpoint?.island_id || '').trim(),
      },
      {
        mode: 'lazy',
        acceptedHash,
        queueAudit: true,
        island,
      },
    )
    report({ phase: 'done', syncMode: 'lazy', queueAudit: true })
    return {
      ...lazy,
      trustedPeers,
      crawled: 0,
      listed: [],
      timing: { startedAt, totalMs: Date.now() - startedAt, syncMode: 'lazy', queueAudit: true },
      games: [],
      pastOpponents: Object.keys(localPlayers || {}).filter(h => h && !sitesMatch(h, local)),
      missingTwinFindings: [],
      queueAudit: true,
    }
  }

  // Hop-bounded surveys must walk the opponent graph — checkpoint light-fetch cannot weed by hop.
  const canLightFetch =
    !hopGraph && !deepRecompute && localHash && localPlayersReady && acceptedHash && localHash === acceptedHash
  const afterTimelineKey = canLightFetch ? String(localCheckpoint?.last_timeline_key || '').trim() : ''
  report({
    phase: canLightFetch ? 'checkpoint' : deepRecompute ? 'crawl' : 'crawl',
    syncMode: canLightFetch ? 'lazy' : deepRecompute ? 'audit' : 'audit',
    gamesFound: 0,
  })

  const fetchStartedAt = Date.now()
  const fetchResult = await fetchFederationGamesAsync(site, dedupeSites(seeds), {
    blockList: blocked,
    afterTimelineKey,
    shouldAbort,
    fetchReach,
    localSite: local,
    expandGraph: !canLightFetch || deepRecompute || !!hopGraph,
    ...(hopGraph
      ? {
          useHopTrust: true,
          remoteSeedHop: 1,
          maxHops: hopGraph.maxHops,
          hopDecay: hopGraph.hopDecay,
        }
      : {}),
    onProgress: patch => report(patch),
    onSiteHub: async h => {
      const ch = cleanSite(h)
      if (hubsRead.has(ch)) return
      hubsRead.add(ch)
      const hub = sitesMatch(h, local) ? localHub : await readLeaderboardHubAsync(site, h)
      if (sitesMatch(h, local) && hub.trustedPeers?.length) trustedPeers = hub.trustedPeers
      if (hub.checkpoint?.state_hash) peerCheckpoints.push({ site: h, checkpoint: hub.checkpoint })
    },
  })
  if (!fetchResult) return null
  let { games: allGames, listed, crawled: fetchedSites } = fetchResult
  const hopStats = Array.isArray(fetchResult.hopStats) ? fetchResult.hopStats : []
  if (!trustedPeers.length) trustedPeers = fetchedSites.filter(h => !sitesMatch(h, local))
  const fetchMs = Date.now() - fetchStartedAt
  if (shouldAbort?.()) return null

  const pastOpponents = afterTimelineKey
    ? await resolvePastOpponentSitesAsync(site, local, {
        blockList: blocked,
        fetchedGames: allGames,
      })
    : pastOpponentSitesFromGames(allGames, local)
  if (shouldAbort?.()) return null

  const missingTwinFindings = missingTwinFindingsFromPool(allGames, {
    localSite: local,
    fetchedSites,
  })
  const deletionUpdate = applyDeletionRatioMetrics(missingTwinFindings, deletionMetrics, blockList)
  const effectiveBlockList = normalizeBlockList(deletionUpdate.blockList)
  if (effectiveBlockList.length !== blocked.length) {
    allGames = allGames.filter(pgn => {
      const { tagFor } = pgnTagReader(pgn)
      const w = cleanSite(parsePlayerId(tagFor('White'))?.domain)
      const b = cleanSite(parsePlayerId(tagFor('Black'))?.domain)
      return !isSiteBlocked(w, effectiveBlockList) && !isSiteBlocked(b, effectiveBlockList)
    })
  }

  if (canLightFetch && localPlayersReady && localCheckpointStillCurrent(localCheckpoint, allGames)) {
    const consensus = buildConsensusResult(
      {
        players: clonePlayersMap(localPlayers),
        lastGameHash: localCheckpoint?.last_processed_game_hash || '',
        lastTimelineKey: afterTimelineKey,
        stateHash: localHash,
        events: [],
        rootOrphanHash: String(localCheckpoint?.island_id || '').trim(),
      },
      {
        mode: 'lazy',
        acceptedHash: acceptedHash || localHash,
        island,
      },
    )
    const timing = {
      startedAt,
      fetchMs,
      recomputeMs: 0,
      totalMs: Date.now() - startedAt,
      gamesFetched: allGames.length,
      syncMode: 'lazy',
      deepRecompute: false,
      reusedLocal: true,
    }
    report({
      phase: 'done',
      syncMode: 'lazy',
      gamesFound: allGames.length,
      timing,
      hopStats,
      hopGraph,
    })
    return {
      ...consensus,
      trustedPeers,
      crawled: fetchedSites.length,
      listed: [...listed],
      timing,
      games: allGames,
      pastOpponents,
      missingTwinFindings,
      deletionMetrics: deletionUpdate.deletionMetrics,
      blockList: deletionUpdate.blockList,
      hopStats,
      hopGraph,
    }
  }

  report({ phase: 'recompute', gamesFound: allGames.length, fetchMs })
  const recomputeStartedAt = Date.now()
  const consensusOpts = {
    games: allGames,
    trustedPeers,
    peerCheckpoints,
    blockList: effectiveBlockList,
    localCheckpoint,
    localPlayers,
    deepRecompute: deepRecompute || !canLightFetch,
    island,
    onProgress: patch =>
      report({
        phase: 'recompute',
        gamesFound: allGames.length,
        eventsDone: patch?.eventsDone,
        eventsTotal: patch?.eventsTotal,
      }),
  }
  const useAsync = allGames.length > 40
  const consensus = useAsync ? await runFederationConsensusAsync(consensusOpts) : runFederationConsensus(consensusOpts)
  const recomputeMs = Date.now() - recomputeStartedAt
  const timing = {
    startedAt,
    fetchMs,
    recomputeMs,
    totalMs: Date.now() - startedAt,
    gamesFetched: allGames.length,
    syncMode: consensus.mode,
    deepRecompute,
  }
  // Hop-bounded pools are intentionally incomplete vs full-federation checkpoints —
  // never queue a follow-up deep audit (that loops “Updating federation ratings…”).
  const queueAudit = hopGraph ? false : Boolean(consensus.queueAudit)
  report({
    phase: 'done',
    syncMode: consensus.mode,
    gamesFound: allGames.length,
    timing,
    hopStats,
    hopGraph,
    queueAudit,
  })
  return {
    ...consensus,
    trustedPeers,
    crawled: fetchedSites.length,
    listed: [...listed],
    timing,
    games: allGames,
    pastOpponents,
    missingTwinFindings,
    deletionMetrics: deletionUpdate.deletionMetrics,
    blockList: deletionUpdate.blockList,
    queueAudit,
    hopStats,
    hopGraph,
  }
}

// Past opponents for the Past opponents reach — always from this site's full game pages.
async function resolvePastOpponentSitesAsync(site, localSite, { blockList = [], fetchedGames = [] } = {}) {
  const local = cleanSite(localSite)
  const blocked = normalizeBlockList(blockList)
  if (!local) return []
  try {
    const { games: localGames } = await collectSiteGamesAsync(site, local, { blockList: blocked })
    if (localGames.length) return pastOpponentSitesFromGames(localGames, local)
  } catch {
    /* fall through */
  }
  // Fallback: opponents named in the federation crawl pool that involve the local host
  // (useful when local page crawl fails but twins / graph games are present).
  return pastOpponentSitesFromGames(fetchedGames, local)
}

// Enrich a site-survey snapshot with opponent-site twin terminals.
export async function enrichSiteSurveyGamesAsync(site, host, { fetchedGames = [] } = {}) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
  let pageGames = [...(Array.isArray(fetchedGames) ? fetchedGames : [])]
  pageGames = await enrichPageGamesWithTwinTerminals(site, pageGames, h)
  return buildMyGamesList(pageGames, h)
}

// # Crawl Deferred Site Survey Enrich

// Deferred site-survey follow-up shared by wiki shell and PWA bridge.
// Fast-path siteSurvey returns pending flags + `meta.games` (page snapshot).
// Callers request enrich and/or federation challenges via this helper
// (MSG-driven from survey.js). Pass `fetchedGames` (or the fast-path
// `meta.games` rows) to skip a second `fetchSiteGamePagesAsync`.
export async function orchestrateSiteSurveyDeferredWork(site, localSite, opts = {}) {
  const {
    fetchedGames = null,
    localOpenChallenges,
    localOpenSeeks,
    slug,
    seeds = null,
    blockList,
    enrichGames = true,
    fetchChallenges = true,
    shouldAbort = null,
    onBatch = null,
    knownOpponents = null,
    knownFederationSites = null,
  } = opts
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  const aborted = () => typeof shouldAbort === 'function' && shouldAbort()
  const openChallenges = mergeOpenChallengeEntries(
    Array.isArray(localOpenChallenges) ? localOpenChallenges : Array.isArray(localOpenSeeks) ? localOpenSeeks : [],
  )

  const enrichPromise = enrichGames
    ? (async () => {
        if (aborted() || !host) return []
        let pages = Array.isArray(fetchedGames) ? fetchedGames : null
        if (!pages?.length) {
          const crawled = await fetchSiteGamePagesAsync(site, host)
          if (aborted()) return []
          pages = crawled.pageGames
        }
        return enrichSiteSurveyGamesAsync(site, host, { fetchedGames: pages })
      })()
    : Promise.resolve(null)

  const challengesPromise = fetchChallenges
    ? (async () => {
        if (aborted() || !host) {
          return { openChallenges, meta: { unavailable: true, site: host } }
        }
        try {
          const result = await runNeighborhoodJob('challenges', {
            site,
            localSite: host,
            opts: {
              seeds: seeds || undefined,
              slug,
              neighborhoodSites,
              blockList,
              onBatch,
              knownOpponents,
              knownFederationSites,
            },
          })
          if (aborted()) return { openChallenges, meta: null }
          return {
            openChallenges: mergeOpenChallengeEntries(openChallenges, result.entries),
            meta: result.meta,
          }
        } catch {
          return { openChallenges, meta: { unavailable: true, site: host } }
        }
      })()
    : Promise.resolve(null)

  const [games, challenges] = await Promise.all([enrichPromise, challengesPromise])
  return {
    games: Array.isArray(games) ? games : [],
    openChallenges: challenges ? challenges.openChallenges : openChallenges,
    meta: challenges ? challenges.meta : null,
  }
}

export async function buildSiteSurveyAsync(site, localSite, slug, opts = {}) {
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const includeFederationChallenges = opts.includeFederationChallenges ?? true
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  const { pageGames: fetchedGames, openChallenges: localChallenges } = await fetchSiteGamePagesAsync(site, host)
  const fastPath = !includeFederationChallenges
  const pageGames = [...fetchedGames]

  let openChallenges = localChallenges
  let acceptedGhosts = []
  let crawled = []
  if (includeFederationChallenges) {
    const seeds = await resolveFetchSeeds(site, host, { neighborhoodSites })
    const challengeResult = await fetchChallengesAsync(site, seeds, slug)
    acceptedGhosts = challengeResult.acceptedGhosts
    crawled = challengeResult.crawled
    openChallenges = mergeOpenChallengeEntries(localChallenges, challengeResult.challenges)
  }
  const enrichedGames = fastPath ? pageGames : await enrichPageGamesWithTwinTerminals(site, pageGames, host)
  const localGames = buildMyGamesList(enrichedGames, host)
  const remoteAccepted = buildAcceptedGhostGamesList(acceptedGhosts, host)
  const myGames = mergeMyGamesLists(localGames, remoteAccepted)
  const pgns = pageGames.map(g => g.pgn).filter(g => typeof g === 'string' && g.trim())
  const hasRatedGame = siteHasRatedGames(pgns, host)
  const { entries } = buildLeaderboard({ games: pgns, now: Date.now() })
  const generatedAt = Date.now()

  return {
    entries,
    meta: {
      mode: 'site',
      host,
      crawled: crawled.length,
      members: entries.length,
      games: myGames,
      openChallenges,
      generatedAt,
      hasRatedGame,
      openChallengesPending: fastPath,
      siteGamesEnrichmentPending: fastPath,
    },
  }
}

// Pick rating states from a local players map for hosts in `roster`.
function playersForRoster(localPlayers, roster) {
  if (!localPlayers || typeof localPlayers !== 'object') return null
  const players = {}
  for (const rosterSite of dedupeSites(roster)) {
    for (const [key, state] of Object.entries(localPlayers)) {
      if (!key || key.endsWith(':engine') || !state) continue
      if (sitesMatch(key, rosterSite)) {
        players[cleanSite(rosterSite)] = state
        break
      }
    }
  }
  return Object.keys(players).length ? players : null
}

// Past-opponents reach: read only this site's game pages, reuse IndexedDB ratings for
// named opponents — never crawl opponent wikis on open.
export async function buildPastOpponentsBoardAsync(
  site,
  localSite,
  { localPlayers = null, shouldAbort = null, onProgress = null } = {},
) {
  const host = cleanSite(localSite)
  const startedAt = Date.now()
  const report = patch =>
    onProgress?.({
      startedAt,
      elapsedMs: Date.now() - startedAt,
      deepRecompute: false,
      ...patch,
    })
  if (!host) return null

  report({ phase: 'local', message: 'Reading rated games on your site…', syncMode: 'local' })
  if (shouldAbort?.()) return null

  const { pageGames } = await fetchSiteGamePagesAsync(site, host)
  if (shouldAbort?.()) return null
  const localGames = pageGames.map(row => row.pgn).filter(g => typeof g === 'string' && g.trim())
  const pastOpponents = pastOpponentSitesFromGames(localGames, host)
  const roster = dedupeSites([host, ...pastOpponents])

  let surveyEntries = []
  let players = playersForRoster(localPlayers, roster)
  let syncMode = 'local'
  if (players) {
    surveyEntries = buildLeaderboardFromPlayers(players, { games: localGames })
    syncMode = 'idb'
  }
  if (!surveyEntries.length) {
    const built = buildLeaderboard({ games: localGames, hosts: roster, now: Date.now() })
    surveyEntries = built.entries
    syncMode = 'local'
  }

  const filteredEntries = filterFederatedLeaderboardEntries(surveyEntries, 'mine', {
    localSite: host,
    pastOpponents,
  })
  const timing = { startedAt, totalMs: Date.now() - startedAt, syncMode, gamesFetched: localGames.length }
  report({
    phase: 'done',
    message:
      syncMode === 'idb'
        ? `Showing ${filteredEntries.length} past opponents from your saved ratings`
        : `Loaded ${filteredEntries.length} players from your site`,
    syncMode,
    timing,
  })

  return {
    entries: filteredEntries,
    games: localGames,
    meta: {
      mode: 'mine',
      crawled: 1,
      members: filteredEntries.length,
      surveyMembers: filteredEntries.length,
      generatedAt: Date.now(),
      players,
      pastOpponents,
      surveyEntries,
      // Not a view over a federation survey — local games + saved ratings only.
      filteredFromSurvey: false,
      syncMode,
      timing,
    },
  }
}

// Neighbourhood reach: local site + explicitly registered wiki.neighborhood members only.
// No opponent-graph expansion — hop dials / digests live on Visible federation.
// Use “Add my opponents” to grow the roster; empty neighbourhood stays local-only.
export async function buildNeighborhoodBoardAsync(site, localSite, opts = {}) {
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const { localPlayers = null, shouldAbort = null, onProgress = null, blockList = null } = opts
  const host = cleanSite(localSite)
  const neighborhood = dedupeSites(neighborhoodSites)
  const startedAt = Date.now()
  const report = patch =>
    onProgress?.({
      startedAt,
      elapsedMs: Date.now() - startedAt,
      deepRecompute: false,
      ...patch,
    })
  if (!host) return null

  const seeds = dedupeSites([host, ...neighborhood])
  const hasNeighbors = neighborhood.length > 0
  report({
    phase: hasNeighbors ? 'crawl' : 'local',
    message: hasNeighbors
      ? 'Reading rated games from your wiki neighbourhood…'
      : 'Filtering saved ratings for your wiki neighbourhood…',
    syncMode: hasNeighbors ? 'neighborhood' : 'local',
  })
  if (shouldAbort?.()) return null

  const allGames = []
  const seenFp = new Set()
  let crawledHosts = [host]

  if (hasNeighbors) {
    const fetched = await fetchFederationGamesAsync(site, seeds, {
      localSite: host,
      fetchReach: 'neighborhood',
      expandGraph: false,
      blockList,
      shouldAbort,
      onProgress: patch => report({ syncMode: 'neighborhood', ...patch }),
    })
    if (!fetched) return null
    for (const pgn of fetched.games) {
      const fp = gameFingerprint(pgn)
      if (!fp || seenFp.has(fp)) continue
      seenFp.add(fp)
      allGames.push(pgn)
    }
    crawledHosts = dedupeSites(fetched.crawled || [])
  } else {
    const { games } = await collectSiteGamesAsync(site, host, { blockList })
    if (shouldAbort?.()) return null
    for (const pgn of games) {
      const fp = gameFingerprint(pgn)
      if (!fp || seenFp.has(fp)) continue
      seenFp.add(fp)
      allGames.push(pgn)
    }
  }

  const crawled = crawledHosts.length
  // pastOpponents powers “Add my opponents”; the board itself is the curated roster only.
  const pastOpponents = pastOpponentSitesFromGames(allGames, host)
  const roster = dedupeSites([host, ...neighborhood, ...crawledHosts])
  const fromGames = buildLeaderboard({ games: allGames, hosts: roster, now: Date.now() })

  let surveyEntries = []
  let players = null
  let syncMode = hasNeighbors ? 'neighborhood' : 'local'
  if (localPlayers && typeof localPlayers === 'object') {
    // Prefer the full saved federation map so neighbours you have not played still appear
    // when gossip/IndexedDB already knows their rating.
    const allPlayers = {}
    for (const [key, state] of Object.entries(localPlayers)) {
      if (!key || key.endsWith(':engine') || !state) continue
      allPlayers[cleanSite(key)] = state
    }
    if (Object.keys(allPlayers).length) {
      players = allPlayers
      surveyEntries = buildLeaderboardFromPlayers(allPlayers, { games: allGames })
      syncMode = hasNeighbors ? 'neighborhood' : 'idb'
    }
  }
  if (!surveyEntries.length) {
    players = playersForRoster(localPlayers, roster)
    if (players) {
      surveyEntries = buildLeaderboardFromPlayers(players, { games: allGames })
      syncMode = hasNeighbors ? 'neighborhood' : 'idb'
    }
  }
  if (!surveyEntries.length) {
    surveyEntries = fromGames.entries
    syncMode = hasNeighbors ? 'neighborhood' : 'local'
  } else if (fromGames.entries?.length) {
    // Neighbour-site crawls can surface players not yet in IndexedDB — merge them in.
    const have = new Set(surveyEntries.map(row => cleanSite(row?.site ?? row?.host)).filter(Boolean))
    let merged = false
    for (const row of fromGames.entries) {
      const rh = cleanSite(row?.site ?? row?.host)
      if (!rh || have.has(rh)) continue
      if (!roster.some(a => sitesMatch(a, rh))) continue
      surveyEntries.push(row)
      have.add(rh)
      merged = true
    }
    if (merged) {
      surveyEntries.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0))
      surveyEntries = rerankLeaderboardEntries(surveyEntries)
    }
  }

  const filteredEntries = filterFederatedLeaderboardEntries(surveyEntries, 'neighborhood', {
    localSite: host,
    neighborhoodSites: neighborhood,
    neighborhoodOpponents: [],
    pastOpponents: [],
  })
  const timing = {
    startedAt,
    totalMs: Date.now() - startedAt,
    syncMode,
    gamesFetched: allGames.length,
  }
  report({
    phase: 'done',
    message:
      syncMode === 'idb'
        ? `Showing ${filteredEntries.length} neighbourhood players from your saved ratings`
        : syncMode === 'neighborhood'
          ? `Loaded ${filteredEntries.length} neighbourhood players from ${crawled} sites`
          : `Loaded ${filteredEntries.length} neighbourhood players from your site`,
    syncMode,
    timing,
  })

  return {
    entries: filteredEntries,
    games: allGames,
    meta: {
      mode: 'neighborhood',
      crawled,
      members: filteredEntries.length,
      surveyMembers: surveyEntries.length,
      generatedAt: Date.now(),
      players,
      pastOpponents,
      neighborhoodSites: neighborhood,
      neighborhoodOpponents: neighborhood,
      discoveredNeighbors: [],
      surveyEntries,
      filteredFromSurvey: surveyEntries.length !== filteredEntries.length,
      syncMode,
      timing,
    },
  }
}

// # Crawl Neighborhood Job Entry Points

// Build visible-federation consensus, then optionally filter for neighborhood / past opponents.
export async function buildLeaderboardAsync(site, localSite, opts = {}) {
  const {
    mode = 'survey',
    survey = 'global',
    deepRecompute = false,
    localCheckpoint = null,
    localPlayers = null,
    blockList = null,
    deletionMetrics = null,
    island = null,
    shouldAbort = null,
    onProgress = null,
  } = opts
  const neighborhoodSites = opts.neighborhoodSites ?? []
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  const m = mode === 'mine' ? 'mine' : mode === 'neighborhood' ? 'neighborhood' : 'survey'
  const surveyId = String(survey || 'global')
    .trim()
    .toLowerCase()
  const generatedAt = Date.now()
  const neighborhood = dedupeSites(neighborhoodSites)
  if (m === 'mine') {
    return buildPastOpponentsBoardAsync(site, host, { localPlayers, shouldAbort, onProgress })
  }
  if (m === 'neighborhood') {
    return buildNeighborhoodBoardAsync(site, host, {
      neighborhoodSites: neighborhood,
      localPlayers,
      blockList,
      shouldAbort,
      onProgress,
    })
  }
  const hopGraph =
    opts.hopGraph && typeof opts.hopGraph === 'object' ? normalizeNeighborhoodGraphOpts(opts.hopGraph) : null
  // Hop-bounded crawls start at the local site only and discover the rest by walking
  // rated opponents. Never seed wiki.neighborhood, past-opponent dumps, or the
  // federation-search index here — those are hop-1 waves that can crawl the whole farm
  // before max-hops ever applies.
  const seeds = hopGraph
    ? dedupeSites([host])
    : await resolveFetchSeeds(site, host, {
        neighborhoodSites: neighborhood,
        knownOpponents: opts.knownOpponents,
        knownFederationSites: opts.knownFederationSites,
      })
  if (shouldAbort?.()) return null

  const consensus = await consensusFromNetwork(site, seeds, {
    deepRecompute,
    localSite: host,
    localCheckpoint,
    localPlayers,
    blockList,
    deletionMetrics,
    island,
    shouldAbort,
    onProgress,
    fetchReach: m,
    hopGraph,
  })
  if (!consensus) return null

  const pastOpponents = consensus.pastOpponents || pastOpponentSitesFromGames(consensus.games || [], host)
  const neighborhoodOpponents = dedupeSites([
    ...neighborhoodOpponentsFromGames(consensus.games || [], host, neighborhood),
    ...pastOpponents,
  ])
  const surveyEntries = consensus.entries
  const filteredEntries = filterFederatedLeaderboardEntries(surveyEntries, m, {
    localSite: host,
    neighborhoodSites: neighborhood,
    neighborhoodOpponents,
    pastOpponents,
  })

  return {
    entries: filteredEntries,
    games: consensus.games,
    meta: {
      mode: m,
      survey: surveyId,
      crawled: consensus.crawled,
      members: filteredEntries.length,
      surveyMembers: surveyEntries.length,
      generatedAt,
      checkpoint: consensus.checkpoint,
      stateHash: consensus.stateHash,
      lastTimelineKey: consensus.lastTimelineKey,
      syncMode: consensus.mode,
      listed: consensus.listed,
      players: consensus.players,
      timing: consensus.timing,
      trustedPeers: consensus.trustedPeers,
      deletionMetrics: consensus.deletionMetrics,
      blockList: consensus.blockList,
      island: consensus.island,
      queueAudit: consensus.queueAudit,
      neighborhoodSites: neighborhood,
      neighborhoodOpponents,
      pastOpponents,
      surveyEntries,
      filteredFromSurvey: m !== 'survey',
      missingTwinFindings: consensus.missingTwinFindings || [],
      hopGraph: consensus.hopGraph || hopGraph,
      hopStats: Array.isArray(consensus.hopStats) ? consensus.hopStats : [],
    },
  }
}

// Leaderboard gate readiness — a published rated game on this host.
export async function checkLeaderboardReadinessAsync(site, localSite, slug) {
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (!host) return { hasRatedGame: false }
  const { games } = await fetchSiteContentAsync(site, host, slug)
  const hasRatedGame = siteHasRatedGames(games, host)
  return { hasRatedGame }
}

// Unified federation crawl entry — shell postMessage, PWA bridge dispatch, and REST routes.
// Pass pre-resolved `seeds` for challenges when the shell already computed crawl targets.
export async function runNeighborhoodJob(type, job = {}) {
  const { site, opts = {} } = job
  const localSite = job.localSite ?? ''
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  const slug = opts.slug && opts.slug !== 'standalone' ? opts.slug : undefined
  const neighborhoodSites = Array.isArray(opts.neighborhoodSites) ? opts.neighborhoodSites : []

  switch (type) {
    case 'siteSurvey': {
      return buildSiteSurveyAsync(site, host, slug, {
        neighborhoodSites,
        includeFederationChallenges: opts.includeFederationChallenges !== false,
      })
    }
    case 'leaderboard': {
      const mode = opts.mode === 'mine' ? 'mine' : opts.mode === 'neighborhood' ? 'neighborhood' : 'survey'
      return buildLeaderboardAsync(site, host, {
        mode,
        survey: opts.survey,
        neighborhoodSites,
        deepRecompute: opts.deepRecompute === true,
        localCheckpoint: opts.localCheckpoint || null,
        localPlayers: opts.localPlayers || null,
        blockList: opts.blockList,
        deletionMetrics: opts.deletionMetrics,
        island: opts.island,
        hopGraph: opts.hopGraph,
        knownOpponents: opts.knownOpponents,
        knownFederationSites: opts.knownFederationSites,
        shouldAbort: opts.shouldAbort,
        onProgress: opts.onProgress,
      })
    }
    case 'challenges': {
      const seeds =
        opts.seeds ||
        (await resolveFetchSeeds(site, host, {
          neighborhoodSites,
          knownOpponents: opts.knownOpponents,
          knownFederationSites: opts.knownFederationSites,
          fetchIndex: opts.fetchIndex,
          deferIndex: opts.deferIndex !== false,
        }))
      const { challenges, acceptedGhosts, crawled, responsiveHosts } = await fetchChallengesAsync(site, seeds, slug, {
        blockList: opts.blockList,
        onBatch: opts.onBatch,
      })
      return {
        entries: challenges,
        meta: {
          site: host,
          crawled: crawled.length,
          acceptedGhosts,
          responsiveHosts,
        },
        acceptedGhosts,
        crawled,
        responsiveHosts,
      }
    }
    case 'surveyStatus': {
      return checkLeaderboardReadinessAsync(site, host, slug)
    }
    default:
      throw new Error(`Unknown federation job: ${type}`)
  }
}

export function slugsFromSitemap(res) {
  const sitemap = asSitemapArray(res)
  return sitemap?.length ? sitemap.map(e => e?.slug).filter(Boolean) : []
}

export function protocolForSite(host) {
  return isLoopbackWikiHost(host) ? 'http' : 'https'
}

// Port from a host string, or a fallback when the host omits one.
export function loopbackPortForHost(host, fallbackPort = '') {
  const h = cleanSite(host)
  if (!h) return String(fallbackPort || '').trim()
  const parts = h.split(':')
  const last = parts[parts.length - 1]
  if (parts.length > 1 && /^\d+$/.test(last)) return last
  return String(fallbackPort || '').trim()
}

// Farm site directory name under argv.data (hostname without port).
export function farmSiteDirFromSite(host) {
  const h = cleanSite(host)
  if (!h) return ''
  return h.split(':')[0]
}

export function pageUrl(host, slug, protocol = protocolForSite(host)) {
  const clean = String(slug || '').replace(/\.json$/i, '')
  const proto = String(protocol || protocolForSite(host)).replace(/:$/, '')
  return `${proto}://${host}/${clean}.json`
}

// Fetch a wiki JSON resource. With `allowHttpFallback` (Node/PWA bridge only),
// retry once over http when https fails — browsers must leave this false (mixed content).
export async function fetchWikiResourceWithProtocolFallback(
  host,
  slug,
  { fetchFn, allowHttpFallback = false, timeoutMs = 8000 } = {},
) {
  const fetch = fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetch) return null

  const h = String(host || '').trim()
  if (!h) return null

  const preferred = protocolForSite(h)
  const attempt = async protocol => {
    try {
      const res = await fetch(pageUrl(h, slug, protocol), {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res?.ok) return null
      return res
    } catch {
      return null
    }
  }

  const first = await attempt(preferred)
  if (first) return first

  if (allowHttpFallback && preferred === 'https' && !isLoopbackWikiHost(h)) {
    return attempt('http')
  }
  return null
}

// # Namespace Exports

// A · Glicko rating math and PGN Glicko tags.
export const Glicko = Object.freeze({
  DEFAULT_RATING,
  DEFAULT_RD,
  DEFAULT_SIGMA,
  newRatingState,
  updateRatingState,
  rateGame,
  rateEngineGame,
  buildGlickoTags,
  readGlickoState,
  formatRatingLabel,
  isProvisional,
})

// C · page.chess gossip / checkpoints / trusted peers.
export const Gossip = Object.freeze({
  normalizeCheckpointGossip,
  normalizeFederationGossip,
  readFederationCharm,
  buildFederationGossipPatch,
  shouldPublishFederationGossip,
  readTrustedPeers,
  checkpointSupermajority,
})

// D · Open-seat challenges and lobby helpers.
export const Challenges = Object.freeze({
  isOpenChallenge,
  openChallengeFromPgn,
  acceptOpenChallenge,
  buildChallengeJoinGhostPgn,
  filterOpenChallengesByBlockList,
})

// F+G · Consensus orchestrator and crawl/job entry points.
export const Crawl = Object.freeze({
  consensusFromNetwork,
  runFederationConsensus,
  fetchFederationGamesAsync,
  orchestrateSiteSurveyDeferredWork,
  buildLeaderboardAsync,
  runNeighborhoodJob,
})

// H · Browser site client factory (PWA twin lives in server/pwa-bridge.js).
export const SiteClient = Object.freeze({
  createBrowserWikiSiteClient,
  pageUrl,
  fetchWikiResourceWithProtocolFallback,
  probeWikiSite,
})
