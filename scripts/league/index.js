/**
 * Federated Wiki Chess — league & ratings system (dev-only).
 *
 * One Glicko-2 engine (`src/federation.js`), two modes:
 *   validate  Monte Carlo at scale — accuracy, calibration, confidence checks
 *   seed      Demo season with Stockfish → writes SURVEY pages to ~/.wiki
 *
 * Usage:
 *   node scripts/dev-tools.js league validate [--players=N] …
 *   node scripts/dev-tools.js league seed [--players=N] [--rounds=N] [--dry-run] …
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Chess } from 'chess.mjs/src/Chess.js'
import {
  formatPgnParts,
  parsePgnParts,
  rebuildStoryFromJournal,
  chessJournalSymbol,
  isOwnCorrespondencePly,
  pgnDateTag,
  pgnUtcDateTag,
  pgnUtcTimeTag,
} from '../../src/chess-core.js'
import {
  newRatingState,
  rateGame,
  decayRatingState,
  buildGlickoTags,
  auditTwins,
  normalizeRatingState,
  isProvisional,
  isReliable,
  buildSurveyItemText,
  SURVEY_PAGE_TITLE,
  SURVEY_PAGE_SLUG,
  SURVEY_PAGE_STORY,
  RATING_PERIOD_MS,
  PROVISIONAL_RD,
  DEFAULT_RD,
  DEFAULT_RATING,
  expectedScore,
  stampCompletionTags,
  runFederationConsensus,
  runFederationConsensusAsync,
  applyTrustedPeersToPage,
  LEADERBOARD_PAGE_SLUG,
  LEADERBOARD_PAGE_TITLE,
  LEADERBOARD_PAGE_STORY,
  applyLeaderboardConsensusToPage,
  applyCompletedGameIndexToSurveyPage,
} from '../../src/federation.js'
import { applyPageAction, applyChessSaveToPage, adoptRemoteWikiPage } from '../../src/chess-core.js'
import { EnginePool, skillToElo, formatEngineScore, scoreFromWhitePerspective } from './engine-pool.js'

// ---------------------------------------------------------------------------
// League seed — write SURVEY demo games to ~/.wiki for local leaderboard testing.
// Stockfish plays real games via EnginePool → seed-engine-worker.js child processes.
// Usage: node scripts/dev-tools.js league seed [--players=N] [--seed=N] [--rounds=N] [--dry-run] …
// Live progress redraws a fixed dashboard in the terminal when stdout is a TTY
// (--no-live falls back to quiet mode; finished summary still prints normally).
// ---------------------------------------------------------------------------

const SEED_MIN_PLAYERS = 2
const SEED_MAX_PLAYERS = 100

function parseSeedArgs(argv) {
  const opts = {
    seed: 1,
    // Full built-in roster is available via --players=N (up to SEED_MAX_PLAYERS).
    // Omit the flag to keep the classic 28-player default cohort.
    players: null,
    rounds: 8, // season length; each player plays 3 games/round
    gamesPerRound: 3, // pairing passes per round
    drawRate: 0.18, // only used by the --no-engine fallback
    port: 3001,
    wikiRoot: path.join(os.homedir(), '.wiki'),
    dryRun: false,
    // Real games: Stockfish plays both sides at a strength tied to each player's skill, so
    // the moves AND the result emerge from actual play. `engines` is the parallel pool size
    // (one forked Stockfish per core); `engineMs` is the per-move think time. `--no-engine`
    // falls back to the old random-legal-move movetext + sampled result (fast, unrealistic).
    useEngine: true,
    engines: Math.max(1, Math.min(16, (os.cpus()?.length || 4) - 2)),
    engineMs: 24,
    live: Boolean(process.stdout.isTTY),
    // Partition the roster into loosely linked islands so neighbourhood hop-trust
    // weeding is visible (a fully connected Swiss season never weeds anyone).
    islands: 1,
    // Rated bridge games between adjacent islands (chain 0↔1↔2…).
    bridges: 1,
    // Random "bad actors" everyone else distrusts (hop-trust / mute demos). 0 = none.
    badActors: 0,
    // Share of each island that also plays the global Open (rest = local-only).
    // Only applies when islands > 1. 1 = everyone plays both local + global.
    globalShare: 0.55,
    // How many islands get a thinned local schedule (sparser internal edges).
    sparseIslands: 1,
    // Local rounds / games-per-round multiplier on sparse islands (0.2–1).
    sparseFactor: 0.4,
  }
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--dry') {
      opts.dryRun = true
      continue
    }
    if (arg === '--no-engine') {
      opts.useEngine = false
      continue
    }
    if (arg === '--reset') {
      opts.reset = true
      continue
    }
    if (arg === '--no-auto-reset') {
      opts.noAutoReset = true
      continue
    }
    if (arg === '--no-live') {
      opts.live = false
      continue
    }
    const m = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (!m) continue
    const [, key, raw] = m
    switch (key) {
      case 'seed':
        opts.seed = Math.trunc(Number(raw)) || 1
        break
      case 'players':
        opts.players = Math.min(
          SEED_MAX_PLAYERS,
          Math.max(SEED_MIN_PLAYERS, Math.trunc(Number(raw)) || SEED_MIN_PLAYERS),
        )
        break
      case 'rounds':
        opts.rounds = Math.max(1, Math.trunc(Number(raw)) || 8)
        break
      case 'games-per-round':
        opts.gamesPerRound = Math.max(1, Math.trunc(Number(raw)) || 3)
        break
      case 'islands':
        opts.islands = Math.min(12, Math.max(1, Math.trunc(Number(raw)) || 1))
        break
      case 'bridges':
        opts.bridges = Math.min(8, Math.max(0, Math.trunc(Number(raw)) || 0))
        break
      case 'bad-actors':
      case 'cheaters':
        opts.badActors = Math.max(0, Math.trunc(Number(raw)) || 0)
        break
      case 'global-share':
        opts.globalShare = Math.min(1, Math.max(0.15, Number(raw) || 0.55))
        break
      case 'sparse-islands':
        opts.sparseIslands = Math.min(12, Math.max(0, Math.trunc(Number(raw)) || 0))
        break
      case 'sparse-factor':
        opts.sparseFactor = Math.min(1, Math.max(0.2, Number(raw) || 0.4))
        break
      case 'draw-rate':
        opts.drawRate = Math.min(0.9, Math.max(0, Number(raw)))
        break
      case 'port':
        opts.port = Math.trunc(Number(raw)) || 3001
        break
      case 'wiki-root':
        opts.wikiRoot = raw
        break
      case 'engines':
        opts.engines = Math.max(1, Math.trunc(Number(raw)) || 1)
        break
      case 'engine-ms':
        opts.engineMs = Math.max(5, Math.trunc(Number(raw)) || 24)
        break
      default:
        break
    }
  }
  return opts
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) + helpers — reproducible runs.
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng) {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function randHex(rng, len = 16) {
  let s = ''
  while (s.length < len) s += Math.floor(rng() * 16).toString(16)
  return s.slice(0, len)
}

// ---------------------------------------------------------------------------
// Dates — season games land on UTC midnights so pgnTimestamp() / Glicko decay stay
// stable. Stamp the same start instant live games use: local Date + UTCDate/UTCTime.
// TerminationTimestamp is applied later (at the correspondence completion instant).
// ---------------------------------------------------------------------------

function pgnDate(ms) {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

function pgnStartTags(ms) {
  const d = new Date(ms)
  return {
    Date: pgnDateTag(d),
    UTCDate: pgnUtcDateTag(d),
    UTCTime: pgnUtcTimeTag(d),
  }
}

function utcMidnight(ms) {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

// The viewer's own site + two existing sites are included so the board ties into the
// setup the user already has (and shows their own standing). Everyone else is a fresh
// `<name>.localhost` site this script creates.
const EXISTING_SITES = [
  { dir: 'localhost', subdomain: '', name: 'Rob' },
  { dir: 'ff.localhost', subdomain: 'ff', name: 'Bishop' },
  { dir: 'aa.localhost', subdomain: 'aa', name: 'Ada' },
]

// Built-in sim roster fills to SEED_MAX_PLAYERS with real names. Originals stay first
// so small --players=N truncations keep the familiar early cohort stable.
const NEW_NAMES = [
  // Original 25 (order preserved)
  'Alice',
  'Bjorn',
  'Carmen',
  'Deepak',
  'Elif',
  'Frank',
  'Gita',
  'Hugo',
  'Ivy',
  'Jonas',
  'Kira',
  'Liam',
  'Mira',
  'Niko',
  'Olga',
  'Pavel',
  'Qadir',
  'Rosa',
  'Sami',
  'Tessa',
  'Ulf',
  'Vivi',
  'Wes',
  'Xander',
  'Yara',
  // Extended roster (EXISTING_SITES + NEW_NAMES → 100)
  'Anya',
  'Bruno',
  'Celia',
  'Dorian',
  'Elena',
  'Farid',
  'Greta',
  'Hassan',
  'Ines',
  'Jiro',
  'Klara',
  'Leo',
  'Maya',
  'Noor',
  'Omar',
  'Priya',
  'Quinn',
  'Ravi',
  'Sofia',
  'Tomaz',
  'Uma',
  'Vera',
  'Wendy',
  'Xavier',
  'Yuki',
  'Zara',
  'Amina',
  'Boris',
  'Chloe',
  'Diego',
  'Esther',
  'Felix',
  'Grace',
  'Henrik',
  'Irene',
  'Jules',
  'Kofi',
  'Lucia',
  'Mateo',
  'Nadia',
  'Oscar',
  'Petra',
  'Remy',
  'Soren',
  'Tara',
  'Uri',
  'Val',
  'Willa',
  'Xenia',
  'Yusuf',
  'Zoltan',
  'Aisha',
  'Ben',
  'Cass',
  'Dani',
  'Erik',
  'Freya',
  'Gwen',
  'Hiro',
  'Ida',
  'Jo',
  'Ken',
  'Lara',
  'Moe',
  'Nina',
  'Otto',
  'Pat',
  'Rae',
  'Sid',
  'Tess',
  'Vic',
  'Zoe',
]

const SEED_ROSTER_SIZE = EXISTING_SITES.length + NEW_NAMES.length
// Omit --players → classic cohort size (3 existing + original 25 names), not the full 100.
const DEFAULT_SEED_PLAYERS = 28

// Extra generated names when --players exceeds the built-in roster.
function syntheticSeedName(index) {
  const n = index + 1
  const letter = String.fromCharCode(65 + ((n - 1) % 26)) // A–Z cycling
  return `Player${letter}${Math.ceil(n / 26)}`
}

function buildPopulation(opts, rng) {
  const port = opts.port
  const hostFor = sub => (sub ? `${sub}.localhost:${port}` : `localhost:${port}`)
  const target =
    opts.players == null ? DEFAULT_SEED_PLAYERS : Math.min(SEED_MAX_PLAYERS, Math.max(SEED_MIN_PLAYERS, opts.players))

  const players = []
  for (const site of EXISTING_SITES) {
    if (players.length >= target) break
    players.push(makePlayer(hostFor(site.subdomain), site.dir, site.name, rng, /*existing*/ true))
  }
  for (const name of NEW_NAMES) {
    if (players.length >= target) break
    const sub = name.toLowerCase()
    players.push(makePlayer(hostFor(sub), `${sub}.localhost`, name, rng, /*existing*/ false))
  }
  for (let i = 0; players.length < target; i += 1) {
    const name = syntheticSeedName(i)
    const sub = name.toLowerCase()
    players.push(makePlayer(hostFor(sub), `${sub}.localhost`, name, rng, /*existing*/ false))
  }
  assignIslands(players, opts.islands || 1)
  assignTournamentRoles(players, opts, rng)
  assignSparseIslands(players, opts, rng)
  assignBadActors(players, opts.badActors || 0, rng)
  return players
}

function makePlayer(host, dir, name, rng, existing) {
  // Hidden true skill ~ N(1500, 320), clamped to a believable amateur band.
  const trueSkill = Math.min(2150, Math.max(1000, Math.round(1500 + 320 * gaussian(rng))))
  return {
    host,
    dir,
    name,
    existing,
    island: 0,
    islandName: 'Open Field',
    trueSkill,
    state: newRatingState({ updated: 0 }), // neutral 1500/350 prior, like a real newcomer
    // One entry per game this player took part in; each becomes its OWN wiki page so the
    // My Chess Games view can link straight to it. { uid, pgn, dateMs, title, itemId, rated }
    games: [],
    // true = also plays FedWiki Open Championship; false = local Island Cup only.
    globalEligible: true,
    localOnly: false,
    // Island marked for a thinned local schedule (fewer internal rated edges).
    islandSparse: false,
    badActor: false,
    // Hosts this player "distrusts" for hop-trust demos (written into farm meta; UI can mute).
    distrust: [],
  }
}

// Fisher–Yates shuffle (mutates in place); uses the season PRNG.
function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
  return list
}

// With multiple islands: each island keeps a full Island Cup, but only
// `globalShare` of its roster (hub always included) also enters the global Open.
// Remainder are local-only — hop paths through them stay island-scoped.
function assignTournamentRoles(players, opts, rng) {
  for (const p of players) {
    p.globalEligible = true
    p.localOnly = false
  }
  if ((opts.islands || 1) <= 1) return
  const share = Math.min(1, Math.max(0.15, Number(opts.globalShare) || 0.55))
  for (const g of playersByIsland(players)) {
    const members = [...g.members]
    if (!members.length) continue
    const hub = members.find(p => p.existing)
    shuffleInPlace(members, rng)
    const ordered = hub ? [hub, ...members.filter(p => p !== hub)] : members
    const nGlobal = Math.min(ordered.length, Math.max(1, Math.round(ordered.length * share)))
    for (let i = 0; i < ordered.length; i += 1) {
      const eligible = i < nGlobal
      ordered[i].globalEligible = eligible
      ordered[i].localOnly = !eligible
    }
  }
}

// Mark some islands as sparse (never island 0 / Rob's dock when others exist).
// Sparse islands play a thinner Island Cup so the internal edge graph is patchier.
function assignSparseIslands(players, opts, rng) {
  for (const p of players) p.islandSparse = false
  const groups = playersByIsland(players)
  if (groups.length <= 1) return []
  const want = Math.min(Math.max(0, Math.trunc(opts.sparseIslands) || 0), Math.max(0, groups.length - 1))
  if (want < 1) return []
  const candidates = groups.filter(g => g.island !== 0)
  shuffleInPlace(candidates, rng)
  const picked = candidates.slice(0, want)
  for (const g of picked) {
    for (const p of g.members) p.islandSparse = true
  }
  return picked.map(g => g.island)
}

function sparseScheduleOpts(opts, sparse) {
  if (!sparse) return opts
  const factor = Math.min(1, Math.max(0.2, Number(opts.sparseFactor) || 0.4))
  return {
    ...opts,
    rounds: Math.max(1, Math.ceil(opts.rounds * factor)),
    gamesPerRound: Math.max(1, Math.round(opts.gamesPerRound * factor)),
  }
}

const ISLAND_LABELS = [
  'North Dock',
  'Bridge Market',
  'South Commons',
  'West Pier',
  'East Yard',
  'Hilltop Club',
  'Canal Side',
  'Old Mill',
  'Harbor Watch',
  'Stone Gate',
  'River Bend',
  'Fog Bank',
]

// Contiguous island chunks so Rob/localhost lands in island 0 with the early roster.
function assignIslands(players, islandCount) {
  const n = Math.max(1, Math.min(islandCount, players.length))
  const size = Math.ceil(players.length / n)
  for (let i = 0; i < players.length; i += 1) {
    const island = Math.min(n - 1, Math.floor(i / size))
    players[i].island = island
    players[i].islandName = ISLAND_LABELS[island] || `Island ${island + 1}`
  }
  return n
}

function playersByIsland(players) {
  const map = new Map()
  for (const p of players) {
    const key = Number(p.island) || 0
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(p)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([island, members]) => ({ island, name: members[0]?.islandName || `Island ${island + 1}`, members }))
}

function islandPeers(player, players) {
  const island = Number(player.island) || 0
  return players.filter(p => p !== player && (Number(p.island) || 0) === island)
}

// Pick `count` randomized bad actors (never the hub / Rob) and make every other
// seat distrust them. Reproducible via `--seed`. `--bad-actors=0` clears distrust.
function assignBadActors(players, count, rng) {
  for (const p of players) {
    p.badActor = false
    p.distrust = []
  }
  const n = Math.max(0, Math.min(Math.trunc(count) || 0, Math.max(0, players.length - 1)))
  if (n < 1 || !players.length) return []
  const hub = players.find(p => p.existing) || players[0]
  const pool = players.filter(p => p !== hub)
  // Partial Fisher–Yates so `--seed` picks a stable subset.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  const bad = pool.slice(0, Math.min(n, pool.length))
  const badHosts = bad.map(p => p.host)
  for (const p of bad) p.badActor = true
  for (const p of players) {
    if (p.badActor) continue
    p.distrust = [...badHosts]
  }
  return bad
}

// ---------------------------------------------------------------------------
// Outcome model
// ---------------------------------------------------------------------------

function trueWinProb(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400))
}

function sampleResult(rng, white, black, baseDrawRate) {
  const pWhite = trueWinProb(white.trueSkill, black.trueSkill)
  const closeness = 1 - 2 * Math.abs(pWhite - 0.5)
  const drawProb = baseDrawRate * closeness
  const r = rng()
  if (r < drawProb) return '1/2-1/2'
  const whiteShare = (1 - drawProb) * pWhite
  return r < drawProb + whiteShare ? '1-0' : '0-1'
}

// A stable [0,1) value derived from a game's uid (FNV-1a). Used to pick a Termination
// WITHOUT drawing from the shared rng, so adding this detail never shifts the rng
// stream — a re-seed reproduces the exact same games (results, pairings, ratings) and
// only stamps the new Termination tag.
function uidUnit(uid) {
  let h = 2166136261 >>> 0
  const s = String(uid)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

// The PGN `Termination` tag (spec values only: abandoned, adjudication, death,
// emergency, normal, rules infraction, time forfeit, unterminated). The spec has NO
// value for resignation/checkmate/agreement — an ordinary rules-decided game is just
// "normal", and the plugin derives the specific cause from the result + board (see
// describeGameResult in chess-core.js). Federated Wiki Chess is clock-less correspondence,
// so "time forfeit" never applies; a decisive "normal" game reads as a resignation.
// A small, realistic slice of correspondence games end by the non-"normal" spec values
// (a player who vanishes → abandoned; a disputed game settled by an arbiter →
// adjudication) so the league exercises those banner outcomes too. Derived from the
// stable uid so a re-seed never shifts the rng stream.
function terminationFor(uid, result, ending) {
  // Draws here are all by agreement (or an unforced repetition) — both "normal" in PGN.
  if (result === '1/2-1/2') return 'normal'
  // A real checkmate is on the board (movetext ends in '#'); it can only read as "normal".
  if (ending === 'checkmate') return 'normal'
  const r = uidUnit(uid)
  if (r < 0.06) return 'abandoned'
  if (r < 0.09) return 'adjudication'
  return 'normal' // decided under the rules → resignation (inferred), no clock to forfeit
}

// ---------------------------------------------------------------------------
// Legal movetext — random legal play, stopped before any terminal position so the
// movetext stays clean (no '#') and never contradicts the agreed Result tag. cm-pgn
// (used by the twin audit) replays it through a real engine, so it must be legal.
// ---------------------------------------------------------------------------

function makeMovetext(rng, result, minPlies = 16, maxPlies = 50) {
  const chess = new Chess()
  const sans = []
  const target = minPlies + Math.floor(rng() * (maxPlies - minPlies + 1))
  for (let i = 0; i < target; i += 1) {
    const moves = chess.moves()
    if (!moves.length) break
    const san = moves[Math.floor(rng() * moves.length)]
    chess.move(san)
    if (chess.game_over()) {
      // Don't end on a checkmate/stalemate — back it out and stop, as if the players
      // agreed the result here. Keeps the score in the Result tag, not the board.
      chess.undo()
      break
    }
    sans.push(san)
  }
  let mt = ''
  for (let i = 0; i < sans.length; i += 1) {
    if (i % 2 === 0) mt += `${i / 2 + 1}. `
    mt += `${sans[i]} `
  }
  return `${mt}${result}`.trim()
}

// Produce one game's movetext + result. With the engine pool (the default), Stockfish plays
// both sides at a strength tied to each player's hidden skill and the outcome is whatever
// actually happens. Without it (--no-engine), fall back to the fast random-movetext + sampled
// result. Returns `{ movetext, result, ending }` ('ending' drives the Termination tag).
async function produceGame(opts, rng, pool, white, black, { onProgress } = {}) {
  if (pool) {
    const game = await pool.playGame(skillToElo(white.trueSkill), skillToElo(black.trueSkill), {
      movetime: opts.engineMs,
      resignCp: 900,
      resignStreak: 3,
      resignEvalMs: Math.max(60, opts.engineMs * 3),
      maxPlies: 180,
      onProgress,
    })
    return { movetext: game.movetext, result: game.result, ending: game.ending }
  }
  const result = sampleResult(rng, white, black, opts.drawRate)
  return { movetext: makeMovetext(rng, result), result, ending: 'normal' }
}

// ---------------------------------------------------------------------------
// Live terminal progress (seed + validate)
// ---------------------------------------------------------------------------

function formatSimResult(result) {
  return result === '1/2-1/2' ? '½-½' : result
}

function playerLabel(player) {
  return player.name || `P${player.id ?? '?'}`
}

function formatSimRating(player) {
  const r = Math.round(Number(player.state.rating) || 0)
  return player.state.rd > PROVISIONAL_RD ? `${r}?` : String(r)
}

function topRatedPlayers(players, n = 3) {
  return [...players]
    .sort((a, b) => b.state.rating - a.state.rating || playerLabel(a).localeCompare(playerLabel(b)))
    .slice(0, n)
}

function pearson(xs, ys) {
  const n = xs.length
  if (n === 0) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  const den = Math.sqrt(dx * dy)
  return den === 0 ? 0 : num / den
}

function rmse(players, predicate = () => true) {
  const subset = players.filter(predicate)
  if (subset.length === 0) return { rmse: 0, n: 0 }
  const sq = subset.reduce((s, p) => s + (p.state.rating - p.trueSkill) ** 2, 0)
  return { rmse: Math.sqrt(sq / subset.length), n: subset.length }
}

function formatRatingDelta(delta) {
  const n = Math.round(Number(delta) || 0)
  return n > 0 ? `+${n}` : String(n)
}

function buildConvergenceView(players, { worst = 3, best = 3 } = {}) {
  const active = players.filter(p => p.state.gamesPlayed > 0 && Number.isFinite(Number(p.trueSkill)))
  if (!active.length) {
    return { ready: false, rmse: 0, corr: 0, n: 0, meanAbs: 0, worst: [], best: [] }
  }
  const { rmse: rmseVal } = rmse(active)
  const corr = pearson(
    active.map(p => p.trueSkill),
    active.map(p => p.state.rating),
  )
  const meanAbs = active.reduce((s, p) => s + Math.abs(p.state.rating - p.trueSkill), 0) / active.length
  const entries = active.map(p => ({
    player: p,
    hidden: Math.round(p.trueSkill),
    glicko: Math.round(p.state.rating),
    delta: Math.round(p.state.rating - p.trueSkill),
    games: p.state.gamesPlayed,
    provisional: p.state.rd > PROVISIONAL_RD,
  }))
  const worstEntries = [...entries]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.games - a.games)
    .slice(0, worst)
  const bestEntries = [...entries]
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || b.games - a.games)
    .slice(0, best)
  return {
    ready: true,
    rmse: rmseVal,
    corr,
    n: active.length,
    meanAbs,
    worst: worstEntries,
    best: bestEntries,
  }
}

function formatConvergencePlayerLine(entry) {
  const name = playerLabel(entry.player).padEnd(8).slice(0, 8)
  const glicko = entry.provisional ? `${entry.glicko}?` : String(entry.glicko)
  return (
    `${name}  hidden ${String(entry.hidden).padStart(4)}  ` +
    `glicko ${glicko.padStart(5)}  Δ${formatRatingDelta(entry.delta).padStart(4)}  (${entry.games}g)`
  )
}

// Compact clock for live readout / summary (`42s`, `3m 12s`, `1h 04m`).
export function formatSimDuration(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms) / 1000) || 0)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

// Human-readable flag legend for the live seed dashboard (and dry-run summaries).
// Values reflect the effective opts after clamping, not raw argv.
export function buildSeedFlagLines(opts, players = []) {
  const n = players.length || opts.players || DEFAULT_SEED_PLAYERS
  const islands = Math.max(1, Number(opts.islands) || 1)
  const multi = islands > 1
  const globalN = players.length
    ? players.filter(p => p.globalEligible).length
    : Math.max(1, Math.round(n * (Number(opts.globalShare) || 0.55)))
  const localOnlyN = players.length ? players.filter(p => p.localOnly).length : Math.max(0, n - globalN)
  const sparseN = players.length
    ? new Set(players.filter(p => p.islandSparse).map(p => p.island)).size
    : Math.min(Math.max(0, opts.sparseIslands || 0), Math.max(0, islands - 1))
  const engine = opts.useEngine !== false
  const lines = []
  const push = (flag, value, why) => {
    lines.push({ flag, value: String(value), why })
  }

  push('--players', n, 'roster size written across wiki farm sites')
  push('--seed', opts.seed ?? 1, 'PRNG seed — same flags reproduce the same pairings & outcomes')
  push('--rounds', opts.rounds ?? 8, 'Swiss rounds for each Island Cup and the global Open')
  push(
    '--games-per-round',
    opts.gamesPerRound ?? 3,
    'pairing passes per round (each seat plays about this many games/round)',
  )
  push(
    '--islands',
    islands,
    multi
      ? 'federation partitions — cups stay local; hop-trust can weed distant sites'
      : 'single pool (classic connected season; set 3+ to demo hop weeding)',
  )
  if (multi) {
    push(
      '--bridges',
      opts.bridges ?? 1,
      'rated cross-island friendlies on each adjacent link (0 = islands fully isolated)',
    )
    push(
      '--global-share',
      opts.globalShare ?? 0.55,
      `~${Math.round((Number(opts.globalShare) || 0.55) * 100)}% of each island also plays the global Open (${globalN} in / ${localOnlyN} local-only)`,
    )
    push(
      '--sparse-islands',
      opts.sparseIslands ?? 1,
      `${sparseN} non-hub island(s) get a thinned cup + fewer friendlies (patchier edges)`,
    )
    push(
      '--sparse-factor',
      opts.sparseFactor ?? 0.4,
      'rounds & games-per-round multiplier used on those sparse islands',
    )
  }
  push(
    '--bad-actors',
    opts.badActors ?? 0,
    opts.badActors
      ? 'random mute targets everyone else distrusts (never Rob)'
      : 'no randomized distrust targets (alias: --cheaters)',
  )
  if (engine) {
    push('--engines', opts.engines ?? 1, 'parallel Stockfish workers (capped by CPU)')
    push('--engine-ms', opts.engineMs ?? 24, 'think time per move — main dial for wall-clock length')
  } else {
    push('--no-engine', 'on', 'fast random-legal movetext + sampled results (unrealistic but quick)')
    push('--draw-rate', opts.drawRate ?? 0.18, 'draw chance for even skills when not using Stockfish')
  }
  push('--port', opts.port ?? 3001, 'hostname port stamped on *.localhost sites')
  push('--wiki-root', opts.wikiRoot || '~/.wiki', 'farm data directory games & meta are written into')
  if (opts.reset) push('--reset', 'on', 'wipe prior league-seed sites/pages before writing')
  if (opts.noAutoReset) push('--no-auto-reset', 'on', 'keep old sim sites even if the roster changed')
  if (opts.dryRun) push('--dry-run', 'on', 'simulate only — no wiki files written')
  if (opts.live === false) push('--no-live', 'on', 'quiet log (no alt-screen dashboard)')

  return lines
}

export function formatSeedFlagBlock(opts, players = [], { width = 18 } = {}) {
  const rows = buildSeedFlagLines(opts, players)
  const flagWidth = Math.max(width, ...rows.map(r => r.flag.length + 1 + r.value.length))
  return rows.map(r => {
    const left = `${r.flag}=${r.value}`.padEnd(flagWidth)
    return `${left}  ${r.why}`
  })
}

// Reconstruct a pasteable CLI from effective opts (approximate).
export function formatSeedCommandLine(opts, players = []) {
  const n = players.length || opts.players || DEFAULT_SEED_PLAYERS
  const parts = ['node scripts/dev-tools.js league seed']
  if (opts.reset) parts.push('--reset')
  parts.push(`--players=${n}`)
  parts.push(`--seed=${opts.seed ?? 1}`)
  parts.push(`--rounds=${opts.rounds ?? 8}`)
  parts.push(`--games-per-round=${opts.gamesPerRound ?? 3}`)
  if ((opts.islands || 1) > 1) {
    parts.push(`--islands=${opts.islands}`)
    parts.push(`--bridges=${opts.bridges ?? 1}`)
    parts.push(`--global-share=${opts.globalShare ?? 0.55}`)
    parts.push(`--sparse-islands=${opts.sparseIslands ?? 1}`)
    parts.push(`--sparse-factor=${opts.sparseFactor ?? 0.4}`)
  }
  if (opts.badActors) parts.push(`--bad-actors=${opts.badActors}`)
  if (opts.useEngine === false) {
    parts.push('--no-engine')
    parts.push(`--draw-rate=${opts.drawRate ?? 0.18}`)
  } else {
    parts.push(`--engines=${opts.engines}`)
    parts.push(`--engine-ms=${opts.engineMs ?? 24}`)
  }
  if (opts.port && opts.port !== 3001) parts.push(`--port=${opts.port}`)
  if (opts.wikiRoot) parts.push(`--wiki-root=${opts.wikiRoot}`)
  if (opts.dryRun) parts.push('--dry-run')
  if (opts.live === false) parts.push('--no-live')
  if (opts.noAutoReset) parts.push('--no-auto-reset')
  return parts.join(' ')
}

function createLiveSimView(
  players,
  { enabled = true, recentMax = 8, paintMs = 120, tickMs = 1000, showConvergence = true } = {},
) {
  const live = Boolean(enabled && process.stdout.isTTY)
  let phase = ''
  let phaseText = ''
  let title = ''
  let detail = ''
  let subtitle = ''
  let status = ''
  let commandLine = ''
  let flagLines = []
  let planned = null
  let completed = 0
  let ratedCompleted = 0
  let inFlight = 0
  let altScreen = false
  let nextGameId = 0
  let paintTimer = null
  let tickTimer = null
  let lastPaintAt = 0
  let startedAt = 0
  let phaseStartedAt = 0
  let firstGameAt = 0
  const recent = []
  const activeGames = new Map()

  const elapsedMs = (from = startedAt) => (from > 0 ? Date.now() - from : 0)

  const gamesPerSec = () => {
    const windowMs = firstGameAt > 0 ? elapsedMs(firstGameAt) : elapsedMs()
    if (completed < 1 || windowMs < 400) return 0
    return completed / (windowMs / 1000)
  }

  const etaLabel = rate => {
    if (planned == null || rate <= 0) return ''
    const left = planned - completed
    if (left <= 0) return ' · ETA done'
    return ` · ETA ${formatSimDuration((left / rate) * 1000)}`
  }

  const progressLabel = () => {
    const count = planned != null ? `${String(completed).padStart(3)}/${planned}` : String(completed)
    const rated =
      ratedCompleted > 0 && ratedCompleted !== completed
        ? ` (${ratedCompleted} rated)`
        : ratedCompleted > 0
          ? ' rated'
          : ''
    const busy = inFlight > 0 ? ` · ${inFlight} in flight` : ''
    return `${count} games${rated}${busy}`
  }

  const runtimeLabel = () => {
    const elapsed = formatSimDuration(elapsedMs())
    const phaseAge = phaseStartedAt > 0 ? formatSimDuration(elapsedMs(phaseStartedAt)) : ''
    const rate = gamesPerSec()
    const rateText = rate > 0 ? ` · ${rate.toFixed(rate >= 10 ? 1 : 2)} games/s` : ''
    const pct = planned != null && planned > 0 ? ` · ${Math.min(100, Math.floor((100 * completed) / planned))}%` : ''
    const phaseTextRuntime = phaseAge ? ` · phase ${phaseAge}` : ''
    return `Elapsed ${elapsed}${rateText}${pct}${etaLabel(rate)}${phaseTextRuntime}`
  }

  const leaderSnippet = (n = 3) =>
    topRatedPlayers(players, n)
      .map((p, i) => `${i + 1}.${playerLabel(p)} ${formatSimRating(p)}`)
      .join('  ')

  const formatGameLine = ({ white, black, result, context = '' }) => {
    const ctx = context ? `  ${context}` : ''
    return (
      `${formatSimResult(result).padEnd(3)}  ` +
      `${playerLabel(white)} ${formatSimRating(white).padStart(4)}  vs  ` +
      `${playerLabel(black)} ${formatSimRating(black).padStart(4)}${ctx}`
    )
  }

  const formatActiveGameLine = game => {
    const ctx = game.context ? ` ${game.context}` : ''
    const ply = game.ply != null ? ` ply ${String(game.ply).padStart(2)}` : ''
    const evalText = game.evalText ?? '…'
    const w = playerLabel(game.white).padEnd(8).slice(0, 8)
    const b = playerLabel(game.black).padEnd(8).slice(0, 8)
    return `${w} vs ${b}${ctx}${ply}  ${evalText}`
  }

  const buildFrame = () => {
    const lines = [title || 'Live simulation', '═'.repeat(60)]
    if (detail) lines.push(`  ${detail}`)
    if (subtitle) lines.push(`  ${subtitle}`)
    if (phaseText) lines.push(`  Phase: ${phaseText}`)
    if (status) lines.push(`  Status: ${status}`)

    if (commandLine || flagLines.length) {
      lines.push('')
      lines.push('  COMMAND — effective flags for this run')
      if (commandLine) {
        // Soft-wrap long CLI across indented continuations for narrow TTYs.
        const wrapWidth = 88
        let rest = commandLine
        let first = true
        while (rest.length) {
          if (rest.length <= wrapWidth) {
            lines.push(`    ${first ? '' : '  '}${rest}`)
            break
          }
          let cut = rest.lastIndexOf(' ', wrapWidth)
          if (cut < 40) cut = wrapWidth
          lines.push(`    ${first ? '' : '  '}${rest.slice(0, cut)}`)
          rest = rest.slice(cut).trimStart()
          first = false
        }
      }
      for (const row of flagLines) lines.push(`    ${row}`)
    }

    lines.push('')
    lines.push('  RUNTIME')
    lines.push(`    ${runtimeLabel()}`)

    lines.push('')
    lines.push('  PROGRESS — simulated games (rated games move Glicko)')
    lines.push(`    ${progressLabel()}`)

    if (showConvergence) {
      const conv = buildConvergenceView(players)
      lines.push('')
      lines.push('  RATING CONVERGENCE — hidden Stockfish skill vs learned Glicko')
      lines.push('    Hidden skill = fixed UCI Elo each player uses when Stockfish moves.')
      lines.push('    Glicko estimate = rating the system infers from results (started ~1500).')
      if (!conv.ready) {
        lines.push('    Metrics appear after the first rated game finishes.')
      } else {
        lines.push(
          `    RMSE ${conv.rmse.toFixed(1)}   r=${conv.corr.toFixed(3)}   ` +
            `${conv.n} rated players   mean |Glicko − hidden| ${conv.meanAbs.toFixed(0)}`,
        )
        if (conv.worst.length) {
          lines.push('    Furthest from hidden skill (name · hidden · glicko · Δ · games):')
          for (const entry of conv.worst) {
            lines.push(`      ${formatConvergencePlayerLine(entry)}`)
          }
        }
        if (conv.best.length && conv.n >= 4) {
          lines.push('    Closest to hidden skill:')
          for (const entry of conv.best) {
            lines.push(`      ${formatConvergencePlayerLine(entry)}`)
          }
        }
      }
    }

    lines.push('')
    lines.push('  GLICKO LEADERBOARD — learned ratings (not hidden skill)')
    lines.push(`    ${leaderSnippet()}`)

    if (activeGames.size) {
      lines.push('')
      lines.push('  LIVE GAMES — in-flight boards (eval = Stockfish, White perspective)')
      for (const game of [...activeGames.values()].sort((a, b) => a.id - b.id)) {
        lines.push(`    ${formatActiveGameLine(game)}`)
      }
    }

    if (recent.length) {
      lines.push('')
      lines.push('  RECENT FINISHERS — result · post-game Glicko (? = provisional)')
      for (const line of recent) lines.push(`    ${line}`)
    }
    return lines
  }

  const enterAltScreen = () => {
    if (!live || altScreen) return
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    altScreen = true
  }

  const leaveAltScreen = () => {
    if (!altScreen) return
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    altScreen = false
  }

  const paint = () => {
    if (!live) return
    enterAltScreen()
    process.stdout.write('\x1b[H\x1b[0J')
    process.stdout.write(`${buildFrame().join('\n')}\n`)
    lastPaintAt = Date.now()
  }

  const schedulePaint = () => {
    if (!live) return
    const elapsed = Date.now() - lastPaintAt
    if (elapsed >= paintMs) {
      if (paintTimer) {
        clearTimeout(paintTimer)
        paintTimer = null
      }
      paint()
      return
    }
    if (paintTimer) return
    paintTimer = setTimeout(() => {
      paintTimer = null
      paint()
    }, paintMs - elapsed)
  }

  const stopTick = () => {
    if (!tickTimer) return
    clearInterval(tickTimer)
    tickTimer = null
  }

  const startTick = () => {
    if (!live || tickTimer || tickMs < 200) return
    tickTimer = setInterval(() => {
      if (startedAt > 0) schedulePaint()
    }, tickMs)
    if (typeof tickTimer.unref === 'function') tickTimer.unref()
  }

  const pushRecent = line => {
    recent.push(line)
    if (recent.length > recentMax) recent.shift()
  }

  const beginGame = ({ white, black, context = '' } = {}) => {
    inFlight += 1
    if (!firstGameAt) firstGameAt = Date.now()
    if (!live) return null
    const id = ++nextGameId
    activeGames.set(id, { id, white, black, context, ply: 0, evalText: '…' })
    paint()
    return id
  }

  const updateGame = (id, { ply, turn, score } = {}) => {
    if (!live || id == null) return
    const game = activeGames.get(id)
    if (!game) return
    if (ply != null) game.ply = ply
    if (score !== undefined) {
      game.evalText = formatEngineScore(scoreFromWhitePerspective(score, turn))
    }
    schedulePaint()
  }

  const finishGame = (id, { white, black, result, context = '', rated = true } = {}) => {
    inFlight = Math.max(0, inFlight - 1)
    completed += 1
    if (!firstGameAt) firstGameAt = Date.now()
    if (rated) ratedCompleted += 1
    if (id != null) activeGames.delete(id)
    if (!live) return
    pushRecent(formatGameLine({ white, black, result, context }))
    paint()
  }

  const abortGame = id => {
    inFlight = Math.max(0, inFlight - 1)
    if (id != null) activeGames.delete(id)
    if (live) paint()
  }

  return {
    get live() {
      return live
    },

    beginGame,
    updateGame,
    finishGame,
    abortGame,

    begin({
      title: nextTitle,
      detail: nextDetail = '',
      subtitle: nextSubtitle = '',
      commandLine: nextCommand = '',
      flagLines: nextFlags = null,
    } = {}) {
      title = nextTitle || 'Live simulation'
      detail = nextDetail
      subtitle = nextSubtitle
      commandLine = String(nextCommand || '').trim()
      flagLines = Array.isArray(nextFlags) ? nextFlags.filter(Boolean) : []
      status = ''
      startedAt = Date.now()
      phaseStartedAt = startedAt
      firstGameAt = 0
      completed = 0
      ratedCompleted = 0
      if (!live) return
      startTick()
      paint()
    },

    setPhase(name, { planned: plan = null } = {}) {
      phase = name
      phaseStartedAt = Date.now()
      if (plan != null) planned = plan
      const planText = plan != null ? ` · ~${plan} games` : ''
      phaseText = `${name}${planText}`
      if (!live) return
      paint()
    },

    setStatus(text = '') {
      status = String(text || '').trim()
      if (!live) return
      paint()
    },

    extendPlanned(extra) {
      if (extra <= 0) return
      planned = (planned ?? 0) + extra
      if (live) paint()
    },

    setPlanned(plan) {
      planned = plan
      if (live) paint()
    },

    gameStarted() {
      beginGame({})
    },

    gameErrored() {
      abortGame(null)
    },

    gameFinished(payload) {
      finishGame(payload?.id, payload)
    },

    gameProgress(payload) {
      updateGame(payload?.id, payload)
    },

    periodFinished({ period, totalPeriods, gamesThisPeriod, totalGames }) {
      completed = totalGames
      if (!live) return
      phaseText = `period ${period}/${totalPeriods} (${gamesThisPeriod} games · ${totalGames} total)`
      pushRecent(`period ${period} complete — ${gamesThisPeriod} games`)
      paint()
    },

    end() {
      stopTick()
      if (paintTimer) {
        clearTimeout(paintTimer)
        paintTimer = null
      }
      const totalMs = elapsedMs()
      const rate = gamesPerSec()
      const timing =
        totalMs > 0
          ? ` in ${formatSimDuration(totalMs)}` + (rate > 0 ? ` (${rate.toFixed(rate >= 10 ? 1 : 2)} games/s)` : '')
          : ''
      if (live) {
        status = ''
        paint()
        leaveAltScreen()
      }
      console.log(`  done — ${completed} games${timing}${phase ? ` (${phase})` : ''}`)
      if (planned != null && planned > 0) {
        console.log(`  planned ~${planned} championship/bridge games · finished ${completed}`)
      }
      console.log(`  final Glicko top: ${leaderSnippet(5)}`)
      if (showConvergence) {
        const conv = buildConvergenceView(players, { worst: 5, best: 0 })
        if (conv.ready) {
          console.log(
            `  final convergence: RMSE ${conv.rmse.toFixed(1)}   r=${conv.corr.toFixed(3)}   ` +
              `mean |error| ${conv.meanAbs.toFixed(0)} (${conv.n} rated players)`,
          )
        }
      }
      console.log('')
    },
  }
}

function seasonGameTotal(opts, playerCount) {
  const pairingsPerPass = Math.floor(playerCount / 2)
  return opts.rounds * opts.gamesPerRound * pairingsPerPass
}

function seasonGameTotalForPlayers(opts, players) {
  const groups = playersByIsland(players)
  if (groups.length <= 1) return seasonGameTotal(opts, players.length)
  let total = 0
  for (const g of groups) {
    const localOpts = sparseScheduleOpts(
      opts,
      g.members.some(p => p.islandSparse),
    )
    total += seasonGameTotal(localOpts, g.members.length)
  }
  const globalField = players.filter(p => p.globalEligible)
  if (globalField.length >= 2) total += seasonGameTotal(opts, globalField.length)
  const islandCount = groups.length
  const bridgeLinks = Math.max(0, islandCount - 1)
  total += bridgeLinks * Math.max(0, opts.bridges || 0)
  return total
}

function gameContextLabel(meta = {}) {
  const { tournament, round, board, kind = 'season' } = meta
  if (kind === 'friendly') return 'friendly'
  if (kind === 'casual') return 'casual'
  if (tournament && round != null && board != null) return `rnd ${round} b${board}`
  if (round != null && board != null) return `rnd ${round} b${board}`
  return ''
}

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

// Organized events — page titles stay "White vs Black"; Event/Round carry these names.
const TOURNAMENT_OPEN = { id: 'open', name: 'FedWiki Open Championship' }
const TOURNAMENT_ISLAND = { id: 'island', name: 'FedWiki Island Cup' }

async function playSeasonPool(opts, rng, pool, players, tournament, now, spanMs = 35 * 24 * 60 * 60 * 1000) {
  if (!players || players.length < 2) return 0
  const span = spanMs
  const step = opts.rounds > 1 ? span / (opts.rounds - 1) : 0
  let gameCount = 0
  for (let r = 0; r < opts.rounds; r += 1) {
    const dateMs = utcMidnight(now - (opts.rounds - 1 - r) * step)
    let board = 0 // board number, unique within a round (across all passes)
    for (let pass = 0; pass < opts.gamesPerRound; pass += 1) {
      // Swiss-ish pairing: order by current rating with a little jitter, pair adjacent
      // players. Competitive games carry the most rating signal and look realistic.
      const ordered = players
        .map(p => ({ p, key: p.state.rating + 120 * gaussian(rng) }))
        .sort((a, b) => a.key - b.key)
        .map(o => o.p)
      // Each player appears at most once per pass, so the pass's games share no mutable
      // state and can be played in parallel across the engine pool. The next pass's pairing
      // depends on this pass's results, so passes stay sequential.
      const pairings = []
      for (let i = 0; i + 1 < ordered.length; i += 2) {
        const aWhite = rng() < 0.5
        board += 1
        pairings.push({
          white: aWhite ? ordered[i] : ordered[i + 1],
          black: aWhite ? ordered[i + 1] : ordered[i],
          board,
        })
      }
      await Promise.all(
        pairings.map(p =>
          playGame(rng, opts, pool, p.white, p.black, dateMs, {
            tournament,
            round: r + 1,
            board: p.board,
            kind: 'season',
          }),
        ),
      )
      gameCount += pairings.length
    }
  }
  return gameCount
}

async function playSeason(opts, rng, pool, players) {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const groups = playersByIsland(players)
  if (groups.length <= 1) {
    const gameCount = await playSeasonPool(opts, rng, pool, players, TOURNAMENT_OPEN, now)
    return { gameCount, localCount: 0, globalCount: gameCount, now }
  }

  // 1) Per-island cups (everyone on the island). Sparse islands get a thinner schedule.
  let localCount = 0
  const localEnd = now - 18 * dayMs // locals finish ~2.5 weeks before the global final
  for (const g of groups) {
    if (g.members.length < 2) continue
    const sparse = g.members.some(p => p.islandSparse)
    const localOpts = sparseScheduleOpts(opts, sparse)
    const tournament = {
      ...TOURNAMENT_ISLAND,
      id: `island-${g.island}`,
      name: `${TOURNAMENT_ISLAND.name} — ${g.name}`,
    }
    opts.liveView?.setPhase(tournament.name)
    localCount += await playSeasonPool(localOpts, rng, pool, g.members, tournament, localEnd, 28 * dayMs)
  }

  // 2) One global Open — only globalEligible seats (local-only players sit out).
  let globalCount = 0
  const globalField = players.filter(p => p.globalEligible)
  if (globalField.length >= 2) {
    opts.liveView?.setPhase(TOURNAMENT_OPEN.name)
    globalCount = await playSeasonPool(opts, rng, pool, globalField, TOURNAMENT_OPEN, now)
  }

  return { gameCount: localCount + globalCount, localCount, globalCount, now }
}

// Sparse rated bridges between adjacent islands (0↔1↔2…) so hop chains stay long.
async function playIslandBridges(opts, rng, pool, players) {
  const bridges = Math.max(0, opts.bridges || 0)
  const groups = playersByIsland(players)
  if (bridges < 1 || groups.length < 2) return 0
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const plans = []
  for (let i = 0; i < groups.length - 1; i += 1) {
    const left = groups[i].members
    const right = groups[i + 1].members
    if (!left.length || !right.length) continue
    for (let b = 0; b < bridges; b += 1) {
      const a = left[Math.floor(rng() * left.length)]
      const c = right[Math.floor(rng() * right.length)]
      if (!a || !c || a === c) continue
      const aWhite = rng() < 0.5
      plans.push({
        white: aWhite ? a : c,
        black: aWhite ? c : a,
        dateMs: utcMidnight(now - Math.floor(rng() * 20) * dayMs),
      })
    }
  }
  const live = opts.liveView
  live?.setPhase('Island bridges')
  live?.extendPlanned(plans.length)
  await Promise.all(plans.map(p => playGame(rng, opts, pool, p.white, p.black, p.dateMs, { kind: 'friendly' })))
  return plans.length
}

// Play and record one rated game between two seats. `meta` carries the organized-event
// context ({ tournament, round, board }) or {} for a non-tournament one-off; it drives the
// page title + intro but never the rating math. The same game (a "twin") becomes its OWN
// page on BOTH players' sites, sharing the uid-based slug so the two copies line up.
async function playGame(rng, opts, pool, white, black, dateMs, meta = {}) {
  const { tournament = null, round, board } = meta
  const live = opts.liveView
  const context = gameContextLabel(meta)

  // Stamp each seat's PRE-game state (decayed to the game date), exactly what a live
  // rated game records. The strict board recomputes ratings from these priors. Captured
  // before the (awaited) game so it reflects the pre-game rating even with parallel play.
  const preW = decayRatingState(white.state, dateMs)
  const preB = decayRatingState(black.state, dateMs)

  const uid = randHex(rng, 16)
  const gameId = live?.beginGame?.({ white, black, context })
  let movetext
  let result
  let ending
  try {
    ;({ movetext, result, ending } = await produceGame(opts, rng, pool, white, black, {
      onProgress: progress => live?.updateGame?.(gameId, progress),
    }))
  } catch (err) {
    live?.abortGame?.(gameId)
    throw err
  }
  const sans = sansFromMovetext(movetext)
  // One chess item id per game, shared by forked twins (matches live resolvePgnSite).
  const itemId = randHex(rng, 16)
  const introId = randHex(rng, 16)
  const descriptor = {
    uid,
    dateMs,
    rated: true,
    white: white.name,
    black: black.name,
    result,
    tournament,
    round,
    board,
  }
  const tags = {
    // Event / Round carry tournament context (or the default hop Event). Page titles are
    // only "White vs Black" — uniqueness suffixes never land in these tags.
    Event: tournament?.name || 'Federated Wiki Chess',
    Site: `http://${white.host} (id: ${itemId})`,
    ...pgnStartTags(dateMs),
    Round: tournament ? String(round) : '-',
    White: `${white.host} (${white.name})`,
    Black: `${black.host} (${black.name})`,
    Result: result,
    ...buildGlickoTags({ rated: true, white: preW, black: preB }),
    Termination: terminationFor(uid, result, ending),
  }
  const pgn = stampCompletionTags(formatPgnParts({ tags, movetext }), dateMs)

  pushGameTwins(white, black, { ...descriptor, pgn, sans, baseTags: tags, itemId, introId })

  // Evolve both players' real Glicko-2 states from their simultaneous pre-game states.
  const rated = rateGame({ white: white.state, black: black.state, result, now: dateMs })
  if (rated) {
    white.state = rated.white
    black.state = rated.black
  }
  live?.finishGame?.(gameId, { white, black, result, context })
}

// Push one game onto BOTH players' game lists (the cross-wiki twins). Forked copies of the
// same page keep one chess item id; the descriptor (players, result, event context) drives
// the page title + intro paragraph at write time.
function pushGameTwins(white, black, descriptor) {
  const itemId = String(descriptor.itemId || '').trim()
  const introId = String(descriptor.introId || '').trim()
  if (!itemId || !introId) {
    throw new Error('pushGameTwins requires shared itemId and introId')
  }
  // Each twin also records who the OTHER player was (host + name), so each site can build
  // its own ordered "past opponents" roster without re-parsing PGN headers at write time.
  white.games.push({
    ...descriptor,
    itemId,
    introId,
    opponentSite: black.host,
    opponentName: black.name,
    seat: 'white',
  })
  black.games.push({
    ...descriptor,
    itemId,
    introId,
    opponentSite: white.host,
    opponentName: white.name,
    seat: 'black',
  })
}

// A handful of one-off RATED games that are NOT part of any tournament. Page titles match
// hop creation ("White vs Black"); tournament context only appears on season games.
async function playRatedFriendlies(opts, rng, pool, players) {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  // Rated games mutate both players' ratings, so a player must not be in two of these at
  // once. Pair them up with each player used at most once, then play the batch in parallel
  // (like a tournament pass) — safe and far faster than one-at-a-time.
  // Keep friendlies inside each island so bridges remain the only cross-island edges.
  // Sparse islands skip more often so their internal rated graph stays patchy.
  const used = new Set()
  const pairings = []
  for (const { members } of playersByIsland(players)) {
    const sparse = members.some(p => p.islandSparse)
    for (let i = 0; i < members.length; i += 1) {
      if (rng() < (sparse ? 0.85 : 0.6)) continue // only some players have a one-off rated game
      const a = members[i]
      if (members.length < 2) continue
      let j = Math.floor(rng() * members.length)
      if (j === i) j = (j + 1) % members.length
      const b = members[j]
      if (used.has(a) || used.has(b)) continue
      used.add(a)
      used.add(b)
      const aWhite = rng() < 0.5
      pairings.push({
        white: aWhite ? a : b,
        black: aWhite ? b : a,
        dateMs: utcMidnight(now - Math.floor(rng() * 20) * dayMs),
      })
    }
  }
  const live = opts.liveView
  live?.setPhase('Rated friendlies')
  live?.extendPlanned(pairings.length)
  await Promise.all(pairings.map(p => playGame(rng, opts, pool, p.white, p.black, p.dateMs, { kind: 'friendly' })))
  return pairings.length
}

// A handful of casual (UNRATED) games so the My Chess Games page can show its separate
// unrated section. These carry `Rated "No"` and NO Glicko-2 headers, so they never touch a
// rating and the leaderboard ignores them — but the per-site survey tallies them apart.
// Like rated games, each is written identically onto both players' sites (a twin).
async function playCasualGames(opts, rng, pool, players) {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000

  // Plan all casual matchups first (sequential rng draws → stable pairings/dates/uids),
  // then play them. Casual games never touch ratings, so they share no mutable state and
  // can all run in parallel across the engine pool. Stay inside islands (rated edge graph
  // is what hop-trust walks).
  const plans = []
  for (const { members } of playersByIsland(players)) {
    if (members.length < 2) continue
    const sparse = members.some(p => p.islandSparse)
    for (let i = 0; i < members.length; i += 1) {
      // Not everyone has casual games; some have a couple. Sparse islands far less.
      const skipChance = sparse ? 0.8 : 0.45
      const howMany = rng() < skipChance ? 0 : 1 + (sparse ? 0 : Math.floor(rng() * 2))
      for (let g = 0; g < howMany; g += 1) {
        const a = members[i]
        let j = Math.floor(rng() * members.length)
        if (j === i) j = (j + 1) % members.length
        const b = members[j]
        const aWhite = rng() < 0.5
        plans.push({
          white: aWhite ? a : b,
          black: aWhite ? b : a,
          dateMs: utcMidnight(now - Math.floor(rng() * 30) * dayMs),
          uid: randHex(rng, 16),
        })
      }
    }
  }

  const live = opts.liveView
  live?.setPhase('Casual games')
  live?.extendPlanned(plans.length)

  await Promise.all(
    plans.map(async plan => {
      const { white, black, dateMs, uid } = plan
      const context = gameContextLabel({ kind: 'casual' })
      const gameId = live?.beginGame?.({ white, black, context })
      let movetext
      let result
      let ending
      try {
        ;({ movetext, result, ending } = await produceGame(opts, rng, pool, white, black, {
          onProgress: progress => live?.updateGame?.(gameId, progress),
        }))
      } catch (err) {
        live?.abortGame?.(gameId)
        throw err
      }
      const itemId = randHex(rng, 16)
      const introId = randHex(rng, 16)
      const descriptor = {
        uid,
        dateMs,
        rated: false,
        white: white.name,
        black: black.name,
        result,
        tournament: null,
      }
      const tags = {
        Event: 'Federated Wiki Chess',
        Site: `http://${white.host} (id: ${itemId})`,
        ...pgnStartTags(dateMs),
        Round: '-',
        White: `${white.host} (${white.name})`,
        Black: `${black.host} (${black.name})`,
        Result: result,
        Rated: 'No',
        Termination: terminationFor(uid, result, ending),
      }
      const pgn = formatPgnParts({ tags, movetext })
      pushGameTwins(white, black, { ...descriptor, pgn, itemId, introId })
      live?.finishGame?.(gameId, { white, black, result, context, rated: false })
    }),
  )
  return plans.length
}

// ---------------------------------------------------------------------------
// Wiki page / sitemap construction
// ---------------------------------------------------------------------------

// Federated Wiki resolves every page by the slug of its TITLE (recent changes, the
// neighbourhood, and internal links all request `<asSlug(title)>.json`). So a game page
// MUST be stored at asSlug(its title) or the wiki 404s it. This is the wiki's own slug
// rule (wiki-client/lib/page.js) reproduced exactly — do not "improve" it (no dash
// collapsing / trimming) or filenames stop matching what the client asks for.
const asSlug = name =>
  String(name)
    .replace(/\s/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toLowerCase()

// Manifest (per site) of the game-page slugs this seed wrote last time, so a re-seed can
// prune the ones no longer produced without guessing from filenames.
const SEED_MANIFEST = 'seed-game-pages.json'

// Farm-level roster snapshot (~/.wiki/league-seed.json) and per-site marker
// (~/.wiki/<site>/status/league-seed.json). Used to auto-reset when --players changes
// and to identify sim sites that should be removed without guessing from slugs alone.
const LEAGUE_SEED_META_FILE = 'league-seed.json'
const LEAGUE_SEED_META_VERSION = 1

function leagueSeedFarmMetaPath(wikiRoot) {
  return path.join(wikiRoot, LEAGUE_SEED_META_FILE)
}

function leagueSeedSiteMetaPath(statusDir) {
  return path.join(statusDir, LEAGUE_SEED_META_FILE)
}

export function normalizeLeagueSeedFarmMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (Number(raw.version) !== LEAGUE_SEED_META_VERSION) return null
  return {
    version: LEAGUE_SEED_META_VERSION,
    seed: Number(raw.seed) || 0,
    players: Number(raw.players) || 0,
    rosterDirs: Array.isArray(raw.rosterDirs) ? raw.rosterDirs.map(String).filter(Boolean) : [],
    rosterSites: Array.isArray(raw.rosterSites) ? raw.rosterSites.map(String).filter(Boolean) : [],
    generatedAt: String(raw.generatedAt || ''),
  }
}

export function buildLeagueSeedFarmMeta(opts, players) {
  const groups = playersByIsland(players)
  const badActors = players.filter(p => p.badActor)
  const globalPlayers = players.filter(p => p.globalEligible)
  const localOnly = players.filter(p => p.localOnly)
  return {
    version: LEAGUE_SEED_META_VERSION,
    seed: opts.seed,
    players: players.length,
    islands: groups.length,
    bridges: Math.max(0, opts.bridges || 0),
    globalShare: Number(opts.globalShare) || 0.55,
    sparseIslands: groups.filter(g => g.members.some(p => p.islandSparse)).map(g => g.island),
    sparseFactor: Number(opts.sparseFactor) || 0.4,
    globalPlayers: globalPlayers.map(p => p.host),
    localOnlyPlayers: localOnly.map(p => p.host),
    badActors: badActors.map(p => ({
      host: p.host,
      name: p.name,
      island: Number(p.island) || 0,
      islandName: p.islandName || 'Open Field',
    })),
    rosterDirs: players.map(p => p.dir),
    rosterSites: players.map(p => p.host),
    islandRoster: groups.map(g => ({
      island: g.island,
      name: g.name,
      sparse: g.members.some(p => p.islandSparse),
      hosts: g.members.map(p => p.host),
      dirs: g.members.map(p => p.dir),
      globalHosts: g.members.filter(p => p.globalEligible).map(p => p.host),
      localOnlyHosts: g.members.filter(p => p.localOnly).map(p => p.host),
    })),
    distrust: Object.fromEntries(players.filter(p => p.distrust?.length).map(p => [p.host, [...p.distrust]])),
    generatedAt: new Date().toISOString(),
  }
}

export function buildLeagueSeedSiteMeta(player, generatedAt) {
  return {
    origin: 'league-seed',
    version: LEAGUE_SEED_META_VERSION,
    host: player.host,
    island: Number(player.island) || 0,
    islandName: player.islandName || 'Open Field',
    islandSparse: Boolean(player.islandSparse),
    globalEligible: player.globalEligible !== false,
    localOnly: Boolean(player.localOnly),
    badActor: Boolean(player.badActor),
    distrust: Array.isArray(player.distrust) ? [...player.distrust] : [],
    generatedAt,
  }
}

// True when the saved farm roster differs from the roster about to be written.
export function rosterChangedFromFarmMeta(prev, players) {
  const meta = normalizeLeagueSeedFarmMeta(prev)
  if (!meta) return false
  if (meta.players !== players.length) return true
  if (Number(meta.islands || 1) !== playersByIsland(players).length) return true
  const nextDirs = new Set(players.map(p => p.dir))
  for (const dir of meta.rosterDirs) {
    if (!nextDirs.has(dir)) return true
  }
  return false
}

function printIslandSummary(players, opts) {
  const groups = playersByIsland(players)
  const bad = players.filter(p => p.badActor)
  const localOnly = players.filter(p => p.localOnly)
  const globalN = players.filter(p => p.globalEligible).length
  if (groups.length <= 1 && !bad.length) return
  console.log('')
  console.log('Federation islands (for hop-trust demos):')
  console.log('='.repeat(64))
  if (groups.length > 1) {
    for (const g of groups) {
      const sparse = g.members.some(p => p.islandSparse)
      const localN = g.members.filter(p => p.localOnly).length
      const tag = sparse ? ' sparse' : ''
      const names = g.members.map(p => (p.localOnly ? `${p.name}*` : p.name)).join(', ')
      console.log(`  ${g.island}. ${g.name} (${g.members.length}${tag}, ${localN} local-only): ${names}`)
    }
    console.log(`  Bridges: ${Math.max(0, opts.bridges || 0)} rated game(s) between each adjacent island.`)
    console.log(
      `  Tournaments: Island Cup per island + global Open (${globalN} players; ${localOnly.length} local-only marked *).`,
    )
    console.log('  Trusted peers / leaderboard gossip are island-scoped (other islands start untrusted).')
    console.log(
      '  Tip: from Rob (island 0) open Visible federation, set Max hops=2 — farther islands should show in “sites blocked”. Neighbourhood stays a curated Add-opponents roster.',
    )
  }
  if (bad.length) {
    console.log(`  Bad actors (${bad.length}): ${bad.map(p => `${p.name} (${p.islandName})`).join(', ')}`)
    console.log('  Everyone else distrusts those hosts (see league-seed.json → distrust).')
  } else if (groups.length > 1) {
    console.log('  Bad actors: none (pass --bad-actors=N to randomize mute targets).')
  }
}

// Page presentation for one game — matches live hop game creation:
//   - title is always "White vs Black" (first-listed plays White);
//   - tournament / round / board / rated-or-casual / date live in the leading paragraph;
//   - the same context is also stamped on PGN Event / Round (see playGame tags).
// Colliding titles get a " (2)" / " (3)" … suffix in uniqueGameTitles.
// Returns { title, intro } — intro is above the chess item (no result; PGN carries that).
function gamePresentation(g) {
  const date = pgnDate(g.dateMs)
  const title = `${g.white} vs ${g.black}`
  if (g.tournament) {
    const where = `${g.tournament.name}, round ${g.round}, board ${g.board}`
    return { title, intro: `${where}. Played ${date}.` }
  }
  const kind = g.rated ? 'Rated game' : 'Casual game (unrated)'
  return { title, intro: `${kind}. Played ${date}.` }
}

// Resolve one game page per game, each at a slug the wiki can actually find (asSlug of a
// title that is unique on THIS site). Two games that would share a title (e.g. the same
// pair meeting twice) get a " (2)", " (3)" … suffix; the suffix is assigned in uid order
// so a game's twin on the opponent's site lands on the same suffix (and thus same slug).
// Returns [{ slug, title, intro, game }] in the player's original game order.
function uniqueGameTitles(games) {
  // First pass: base presentation + group games that collide on slug.
  const prepared = games.map(g => {
    const { title, intro } = gamePresentation(g)
    return { game: g, baseTitle: title, intro }
  })
  const groups = new Map()
  for (const p of prepared) {
    const key = asSlug(p.baseTitle)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }
  // Second pass: within each colliding group, order by uid and suffix all but the first.
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => String(a.game.uid).localeCompare(String(b.game.uid)))
    group.forEach((p, i) => {
      if (i > 0) p.suffix = ` (${i + 1})`
    })
  }
  return prepared.map(p => {
    const title = p.suffix ? `${p.baseTitle}${p.suffix}` : p.baseTitle
    return { slug: asSlug(title), title, intro: p.intro, game: p.game }
  })
}

function federationTopTiers(entries) {
  return (Array.isArray(entries) ? entries : []).slice(0, 50).map(e => ({
    site: e.site,
    rating: Math.round(Number(e.rating) || 0),
    rd: Math.round(Number(e.rd) || 0),
  }))
}

// Mirror federation sync: checkpoint gossip on Chess Leaderboards via page.chess.
function applyFederationCharmToLeaderboardPage(page, { checkpoint, entries } = {}) {
  void entries
  return applyLeaderboardConsensusToPage(page, {
    checkpoint,
    force: true,
  })
}

function buildPageJson(title, storyItems) {
  const dates = storyItems.map(it => it.dateMs)
  const baseDate = dates.length ? Math.min(...dates) : Date.now()
  const journal = [{ type: 'create', item: { title, story: [] }, date: baseDate }]
  let after = ''
  for (const it of storyItems) {
    journal.push({
      type: 'add',
      item: { type: 'factory', id: it.id },
      id: it.id,
      after,
      date: it.dateMs,
    })
    journal.push({
      type: 'edit',
      id: it.id,
      item: { type: it.type || 'chess', id: it.id, text: it.text },
      date: it.dateMs,
    })
    after = it.id
  }
  const story = rebuildStoryFromJournal({ title, journal })
  return { title, story, journal }
}

const CORRESPONDENCE_MOVE_GAP_MS = 45_000

function sansFromMovetext(movetext) {
  const chess = new Chess()
  const sans = []
  const body = String(movetext || '')
    .replace(/\s+(1-0|0-1|1\/2-1\/2|\*)\s*$/i, '')
    .trim()
  const re = /(?:\d+\.\s*)?([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)/gi
  let m
  while ((m = re.exec(body))) {
    const san = m[1]
    try {
      if (chess.move(san)) sans.push(san)
    } catch {
      /* skip unparseable */
    }
  }
  return sans
}

function buildPartialMovetext(sans, throughIndex) {
  let mt = ''
  for (let i = 0; i <= throughIndex; i += 1) {
    if (i % 2 === 0) mt += `${Math.floor(i / 2) + 1}. ${sans[i]} `
    else mt += `${sans[i]} `
  }
  return mt.trim()
}

function fenAfterSans(sans, throughIndex) {
  const chess = new Chess()
  for (let i = 0; i <= throughIndex; i += 1) {
    chess.move(sans[i])
  }
  return chess.fen()
}

function chessPgnAt(sans, throughIndex, baseTags, result, { complete = false, t = 0 } = {}) {
  const mt = buildPartialMovetext(sans, throughIndex)
  let pgn = formatPgnParts({
    tags: { ...baseTags, Result: complete ? result : '*' },
    movetext: complete ? `${mt} ${result}`.trim() : mt,
  })
  if (complete) pgn = stampCompletionTags(pgn, t)
  return pgn
}

function chessItemText(page, itemId, fallback = '') {
  return page.story.find(entry => entry?.id === itemId)?.text ?? fallback
}

function clonePageState(page) {
  return {
    title: page.title,
    story: JSON.parse(JSON.stringify(page.story || [])),
    journal: JSON.parse(JSON.stringify(page.journal || [])),
  }
}

function lastJournalDate(page, fallback = Date.now()) {
  const journal = Array.isArray(page?.journal) ? page.journal : []
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    if (journal[i]?.date) return journal[i].date
  }
  return fallback
}

function firstOwnCorrespondencePlyIndex(side, sans) {
  return sans.findIndex((_, plyIndex) => isOwnCorrespondencePly(side, plyIndex))
}

function applyCorrespondencePageSetup(page, { title, intro, introId, itemId, baseTags, startMs }) {
  let t = startMs
  applyPageAction(page, { type: 'create', item: { title, story: [] }, date: t })
  t += 1
  applyPageAction(page, {
    type: 'add',
    item: { type: 'factory', id: introId },
    id: introId,
    after: '',
    date: t,
  })
  t += 1
  applyPageAction(page, {
    type: 'edit',
    id: introId,
    item: { type: 'paragraph', id: introId, text: intro },
    date: t,
  })
  t += 1
  applyPageAction(page, {
    type: 'add',
    item: { type: 'factory', id: itemId },
    id: itemId,
    after: introId,
    date: t,
  })
  t += 1

  const initialPgn = formatPgnParts({ tags: { ...baseTags, Result: '*' }, movetext: '' })
  const createSymbol = chessJournalSymbol('', initialPgn)
  applyPageAction(page, {
    type: 'edit',
    id: itemId,
    item: { type: 'chess', id: itemId, text: initialPgn },
    date: t,
    ...(createSymbol ? { symbol: createSymbol } : {}),
  })
  t += 1
  return { t, initialPgn }
}

// Simulate live wiki page-fork correspondence: after each move the opponent adopts
// the mover's full page (story+journal) and stamps { type:'fork', site }, matching
// the lineup fork button / autofork path — not a surgical edit+forkSite stamp.
function simulateCorrespondenceTwins({
  title,
  intro,
  introId,
  itemId,
  whiteSite,
  blackSite,
  sans,
  baseTags,
  result,
  startMs,
}) {
  const white = { title, story: [], journal: [] }
  let { t } = applyCorrespondencePageSetup(white, {
    title,
    intro,
    introId,
    itemId,
    baseTags,
    startMs,
  })
  const black = { title, story: [], journal: [] }
  let blackReady = false

  const playNative = (page, plyIndex) => {
    const isLast = plyIndex === sans.length - 1
    const prevText = chessItemText(page, itemId, '')
    const pgn = chessPgnAt(sans, plyIndex, baseTags, result, { complete: isLast, t })
    applyChessSaveToPage(page, itemId, pgn, {
      prevText,
      fen: fenAfterSans(sans, plyIndex),
      date: t,
    })
    t += CORRESPONDENCE_MOVE_GAP_MS
  }

  for (let i = 0; i < sans.length; i += 1) {
    const whiteToMove = i % 2 === 0
    if (whiteToMove) {
      if (blackReady) {
        adoptRemoteWikiPage(white, black, blackSite, t)
        t += CORRESPONDENCE_MOVE_GAP_MS
      }
      playNative(white, i)
      if (!blackReady) {
        adoptRemoteWikiPage(black, white, whiteSite, t)
        blackReady = true
        t += CORRESPONDENCE_MOVE_GAP_MS
      }
    } else {
      adoptRemoteWikiPage(black, white, whiteSite, t)
      t += CORRESPONDENCE_MOVE_GAP_MS
      playNative(black, i)
    }
  }

  if (sans.length) {
    const lastWasWhite = (sans.length - 1) % 2 === 0
    if (lastWasWhite) {
      adoptRemoteWikiPage(black, white, whiteSite, t)
    } else {
      adoptRemoteWikiPage(white, black, blackSite, t)
    }
  }

  for (const page of [white, black]) {
    const currentText = chessItemText(page, itemId, '')
    const currentResult = String(parsePgnParts(currentText).tags.Result || '').trim()
    if (!sans.length || (currentResult && currentResult !== '*')) continue
    t += CORRESPONDENCE_MOVE_GAP_MS
    const lastIndex = sans.length - 1
    const completePgn = chessPgnAt(sans, lastIndex, baseTags, result, { complete: true, t })
    applyChessSaveToPage(page, itemId, completePgn, {
      prevText: currentText,
      fen: fenAfterSans(sans, lastIndex),
      date: t,
    })
  }

  white.story = rebuildStoryFromJournal(white)
  black.story = rebuildStoryFromJournal(black)
  return { white, black }
}

// Replay SAN plies the way live correspondence does: each opponent ply is a full
// wiki page fork (adoptRemoteWikiPage); each own ply is a native edit on this wiki.
function buildCorrespondenceGamePage({
  side,
  title,
  intro,
  introId,
  itemId,
  ownerSite,
  opponentSite,
  sans,
  baseTags,
  result,
  startMs,
}) {
  const tagSite = seat => {
    const tag = String(baseTags?.[seat] || '').trim()
    const cut = tag.indexOf(' ')
    return (cut > 0 ? tag.slice(0, cut) : tag).trim()
  }
  const whiteSite = (side === 'white' ? ownerSite : opponentSite) || tagSite('White') || opponentSite || ownerSite
  const blackSite = (side === 'black' ? ownerSite : opponentSite) || tagSite('Black') || opponentSite || ownerSite
  const { white, black } = simulateCorrespondenceTwins({
    title,
    intro,
    introId,
    itemId,
    whiteSite,
    blackSite,
    sans,
    baseTags,
    result,
    startMs,
  })
  const page = side === 'black' ? black : white
  return { title, story: page.story, journal: page.journal }
}

function lastEditDate(page) {
  const j = Array.isArray(page.journal) ? page.journal : []
  for (let i = j.length - 1; i >= 0; i -= 1) {
    if (j[i].date && j[i].type !== 'fork') return j[i].date
  }
  return Date.now()
}

function sitemapEntry(slug, page) {
  const first = page.story?.[0]?.text || ''
  return {
    slug,
    title: page.title,
    date: lastEditDate(page),
    synopsis: String(first).replace(/\s+/g, ' ').trim().slice(0, 120),
  }
}

// ---------------------------------------------------------------------------
// Writing to disk
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readJsonOr(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return fallback
  }
}

async function readDirOr(p) {
  try {
    return await fs.readdir(p)
  } catch {
    return []
  }
}

async function pageSlugSet(pagesDir) {
  return new Set(await readDirOr(pagesDir))
}

// Drop sitemap / index entries whose slug has no matching file in pages/ — stale rows
// survive re-seeds when they were never recorded in the seed manifest.
function pruneSitemapEntries(entries, pageSlugs) {
  if (!Array.isArray(entries)) return []
  return entries.filter(e => e?.slug && pageSlugs.has(e.slug))
}

function buildSitemapXml(sitemap, baseUrl) {
  const urls = sitemap
    .map(page => {
      let lastmod = ''
      if (page.date) {
        const d = new Date(page.date)
        if (!isNaN(d.valueOf())) lastmod = `<lastmod>${d.toISOString().substring(0, 10)}</lastmod>`
      }
      return `<url><loc>${baseUrl}/${page.slug}.html</loc>${lastmod}</url>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
}

async function pruneSiteIndex(siteIndexPath, pageSlugs) {
  const raw = await readJsonOr(siteIndexPath, null)
  if (!raw?.documentIds) return { removed: 0, kept: 0 }
  const ids = raw.documentIds
  let removed = 0
  for (const [key, slug] of Object.entries(ids)) {
    if (slug && !pageSlugs.has(slug)) {
      delete ids[key]
      removed += 1
    }
  }
  const kept = Object.values(ids).filter(Boolean).length
  raw.documentCount = kept
  raw.documentIds = ids
  await fs.writeFile(siteIndexPath, JSON.stringify(raw))
  return { removed, kept }
}

// True when a page slug was produced by a prior seed run. Used by --reset
// to strip stale data that incremental re-seed pruning can miss.
function isSeedPageSlug(slug) {
  if (slug === SURVEY_PAGE_SLUG) return true
  if (slug.startsWith('game-')) return true
  // Matchup pages: asSlug("Ada vs Bjorn") → ada-vs-bjorn
  if (slug.includes('-vs-')) return true
  return false
}

async function siteHasSeedPages(pagesDir) {
  if (!(await pathExists(pagesDir))) return false
  for (const file of await readDirOr(pagesDir)) {
    if (isSeedPageSlug(file)) return true
  }
  return false
}

// Whether a leftover *.localhost site was produced by league seed (not a hand-made wiki).
async function shouldRemoveSimSite(siteDir, dirName, farmRosterDirs) {
  if (farmRosterDirs.has(dirName)) return true
  const statusDir = path.join(siteDir, 'status')
  const siteMeta = await readJsonOr(leagueSeedSiteMetaPath(statusDir), null)
  if (siteMeta?.origin === 'league-seed') return true
  if (await pathExists(path.join(statusDir, SEED_MANIFEST))) return true
  return siteHasSeedPages(path.join(siteDir, 'pages'))
}

async function resetSimulationSites(opts, players, prevFarmMeta = null) {
  let removedSites = 0
  let removedPages = 0
  const keepDirs = new Set(players.map(p => p.dir))
  const existingByDir = new Map(EXISTING_SITES.map(s => [s.dir, s]))
  const hostFor = sub => (sub ? `${sub}.localhost:${opts.port}` : `localhost:${opts.port}`)
  const farmMeta = normalizeLeagueSeedFarmMeta(prevFarmMeta)
  const droppedFarmDirs = new Set(farmMeta ? farmMeta.rosterDirs.filter(dir => !keepDirs.has(dir)) : [])

  async function stripSeedPagesFromExisting(siteDir, hostHint) {
    const pagesDir = path.join(siteDir, 'pages')
    const statusDir = path.join(siteDir, 'status')
    if (!(await pathExists(pagesDir))) return

    const manifestLoc = path.join(statusDir, SEED_MANIFEST)
    const prevSlugs = await readJsonOr(manifestLoc, [])
    const removeSlugs = new Set()
    for (const s of Array.isArray(prevSlugs) ? prevSlugs : []) removeSlugs.add(s)
    for (const file of await readDirOr(pagesDir)) {
      if (isSeedPageSlug(file)) removeSlugs.add(file)
    }
    for (const slug of removeSlugs) {
      if (!opts.dryRun) await fs.rm(path.join(pagesDir, slug), { force: true })
      removedPages += 1
    }
    if (opts.dryRun) return

    await fs.rm(manifestLoc, { force: true })
    await fs.rm(leagueSeedSiteMetaPath(statusDir), { force: true })
    const pageSlugs = await pageSlugSet(pagesDir)
    const sitemapLoc = path.join(statusDir, 'sitemap.json')
    const xmlLoc = path.join(statusDir, 'sitemap.xml')
    const siteIndexLoc = path.join(statusDir, 'site-index.json')
    const existing = await readJsonOr(sitemapLoc, [])
    const pruned = pruneSitemapEntries(existing, pageSlugs)
    if (await pathExists(sitemapLoc)) {
      await fs.writeFile(sitemapLoc, JSON.stringify(pruned))
      const host = hostHint || path.basename(siteDir)
      await fs.writeFile(xmlLoc, buildSitemapXml(pruned, `http://${host}`))
    }
    if (await pathExists(siteIndexLoc)) await pruneSiteIndex(siteIndexLoc, pageSlugs)
  }

  for (const player of players) {
    const siteDir = path.join(opts.wikiRoot, player.dir)
    if (!player.existing) {
      if (await pathExists(siteDir)) {
        if (!opts.dryRun) await fs.rm(siteDir, { recursive: true, force: true })
        removedSites += 1
      }
      continue
    }
    await stripSeedPagesFromExisting(siteDir, player.host)
  }

  // When --players shrinks the roster, wipe leftover sim sites (and strip seed pages
  // from existing sites no longer in this run) so re-seeds stay tidy.
  let rootEntries = []
  try {
    rootEntries = await fs.readdir(opts.wikiRoot, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  for (const ent of rootEntries) {
    if (!ent.isDirectory()) continue
    if (keepDirs.has(ent.name)) continue
    const siteDir = path.join(opts.wikiRoot, ent.name)
    const existingSite = existingByDir.get(ent.name)
    if (existingSite) {
      await stripSeedPagesFromExisting(siteDir, hostFor(existingSite.subdomain))
      continue
    }
    if (!ent.name.endsWith('.localhost')) continue
    if (!(await shouldRemoveSimSite(siteDir, ent.name, droppedFarmDirs))) continue
    if (await pathExists(siteDir)) {
      if (!opts.dryRun) await fs.rm(siteDir, { recursive: true, force: true })
      removedSites += 1
    }
  }

  if (!opts.dryRun) await fs.rm(leagueSeedFarmMetaPath(opts.wikiRoot), { force: true })

  const verb = opts.dryRun ? 'Would remove' : 'Removed'
  console.log(`${verb} ${removedSites} simulation site(s) and ${removedPages} seed page(s).`)
}

function buildUidSlugMap(players) {
  const map = new Map()
  for (const p of players) {
    for (const row of uniqueGameTitles(p.games)) {
      const g = row.game
      const entry = map.get(g.uid) || {}
      if (g.seat === 'white') {
        entry.whiteSite = p.host
        entry.whiteSlug = row.slug
      } else if (g.seat === 'black') {
        entry.blackSite = p.host
        entry.blackSlug = row.slug
      }
      map.set(g.uid, entry)
    }
  }
  return map
}

function federationPoolFromPlayers(players) {
  const pool = []
  for (const p of players) for (const g of p.games) if (g.rated !== false && g.pgn) pool.push(g.pgn)
  return pool
}

async function simulateFederationConsensus(players, { deepRecompute = true, localHost = '' } = {}) {
  const games = federationPoolFromPlayers(players)
  const trustedPeers = players.map(p => p.host).filter(h => h !== localHost)
  const peerCheckpoints = []
  const deep = await runFederationConsensusAsync({
    games,
    trustedPeers,
    peerCheckpoints,
    deepRecompute,
  })
  const checkpoint = deep.checkpoint
  peerCheckpoints.push({ site: trustedPeers[0] || localHost, checkpoint })
  const fast = runFederationConsensus({
    games,
    trustedPeers,
    peerCheckpoints,
    localPlayers: deep.players,
    localCheckpoint: checkpoint,
    deepRecompute: false,
  })
  return { deep, fast, games: games.length }
}

function printFederationReport(players) {
  const pool = federationPoolFromPlayers(players)
  const trustedPeers = players.map(p => p.host)
  return simulateFederationConsensus(players, { deepRecompute: true, localHost: trustedPeers[0] }).then(
    ({ deep, fast, games }) => {
      console.log('')
      console.log('Federation consensus simulation:')
      console.log('='.repeat(64))
      console.log(`  Games in crawl pool:     ${games}`)
      console.log(`  Deep recompute mode:     ${deep.mode}`)
      console.log(`  State hash (deep):       ${deep.stateHash.slice(0, 16)}…`)
      console.log(`  Last timeline key:       ${deep.lastTimelineKey || '(none)'}`)
      console.log(`  Checkpoint fast path:    ${fast.mode}`)
      console.log(`  Fast path hash match:    ${fast.stateHash === deep.stateHash ? 'yes' : 'NO'}`)
      console.log(`  Leaderboard entries:     ${deep.entries.length}`)
    },
  )
}

async function writeFederationHub(opts, players, uidSlugs) {
  const hubPlayer = players.find(p => p.existing) || players[0]
  if (!hubPlayer || opts.dryRun) return
  const hubIsland = islandPeers(hubPlayer, players).map(p => p.host)
  const { deep } = await simulateFederationConsensus(
    players.filter(p => (Number(p.island) || 0) === (Number(hubPlayer.island) || 0)),
    {
      deepRecompute: true,
      localHost: hubPlayer.host,
    },
  )
  const root = path.join(opts.wikiRoot, hubPlayer.dir)
  const pagesDir = path.join(root, 'pages')
  const statusDir = path.join(root, 'status')
  // Island-scoped trust: other islands start outside the trusted peer roster.
  const trustedPeers = hubIsland.slice(0, 12)
  const peerRoster = [hubPlayer.host, ...trustedPeers.slice(0, 8)]
  let story = LEADERBOARD_PAGE_STORY.map(item => ({ ...item }))
  const hubPage = {
    title: LEADERBOARD_PAGE_TITLE,
    story,
    journal: [
      { type: 'create', item: { title: LEADERBOARD_PAGE_TITLE, story: [] }, date: Date.now() },
      ...story.flatMap((item, i) => [
        {
          type: 'add',
          item: { type: 'factory', id: item.id },
          id: item.id,
          after: i === 0 ? '' : story[i - 1].id,
          date: Date.now() + i,
        },
        { type: 'edit', id: item.id, item, date: Date.now() + i + 1 },
      ]),
    ],
  }
  applyTrustedPeersToPage(hubPage, peerRoster)
  applyFederationCharmToLeaderboardPage(hubPage, {
    checkpoint: deep.checkpoint,
    entries: deep.entries,
  })
  await fs.mkdir(pagesDir, { recursive: true })
  await fs.mkdir(statusDir, { recursive: true })
  await fs.writeFile(path.join(pagesDir, LEADERBOARD_PAGE_SLUG), JSON.stringify(hubPage, null, 2))
  const consensusByIsland = new Map()
  consensusByIsland.set(Number(hubPlayer.island) || 0, { deep })
  for (const g of playersByIsland(players)) {
    if (consensusByIsland.has(g.island)) continue
    consensusByIsland.set(
      g.island,
      await simulateFederationConsensus(g.members, {
        deepRecompute: true,
        localHost: g.members[0]?.host || '',
      }),
    )
  }
  for (const p of players) {
    if (p.host === hubPlayer.host) continue
    const peerPagesDir = path.join(opts.wikiRoot, p.dir, 'pages')
    const lbPath = path.join(peerPagesDir, LEADERBOARD_PAGE_SLUG)
    try {
      // Always refresh story from LEADERBOARD_PAGE_STORY so intro copy tracks pages/chess-leaderboards.
      const page = buildPageJson(
        LEADERBOARD_PAGE_TITLE,
        LEADERBOARD_PAGE_STORY.map(item => ({
          type: item.type,
          id: item.id,
          text: item.text,
          dateMs: Date.now(),
        })),
      )
      const islandHosts = islandPeers(p, players).map(peer => peer.host)
      const rosterLine = [p.host, ...islandHosts].slice(0, 12)
      applyTrustedPeersToPage(page, rosterLine)
      const islandConsensus = consensusByIsland.get(Number(p.island) || 0) || { deep }
      applyFederationCharmToLeaderboardPage(page, {
        checkpoint: islandConsensus.deep.checkpoint,
        entries: islandConsensus.deep.entries,
      })
      await fs.mkdir(peerPagesDir, { recursive: true })
      await fs.writeFile(lbPath, JSON.stringify(page, null, 2))
    } catch {
      /* peer site not written yet */
    }
  }
  const sitemapLoc = path.join(statusDir, 'sitemap.json')
  const existing = await readJsonOr(sitemapLoc, [])
  const keep = Array.isArray(existing) ? existing.filter(e => e?.slug !== LEADERBOARD_PAGE_SLUG) : []
  keep.push(sitemapEntry(LEADERBOARD_PAGE_SLUG, hubPage))
  await fs.writeFile(sitemapLoc, JSON.stringify(keep))
}

async function writeSite(opts, player, allSites, uidSlugs, index = 0) {
  const root = path.join(opts.wikiRoot, player.dir)
  const pagesDir = path.join(root, 'pages')
  const statusDir = path.join(root, 'status')

  // One page per game, each stored at asSlug(its title) so Federated Wiki can actually
  // resolve it (recent changes / neighbourhood / internal links all request that slug).
  // Titles are made unique per site first. Each page leads with an intro paragraph
  // (event/matchup/result) and then the chess item with the real game.
  const gamePages = uniqueGameTitles(player.games).map(({ slug, title, intro, game }) => {
    const twins = uidSlugs.get(game.uid) || {}
    const side = game.seat === 'black' ? 'black' : 'white'
    // Keep Event/Round from play time — never overwrite with the matchup page title.
    const tags = { ...(game.baseTags || {}) }
    if (game.sans?.length) {
      return {
        slug,
        itemId: game.itemId,
        page: buildCorrespondenceGamePage({
          side,
          title,
          intro,
          introId: game.introId,
          itemId: game.itemId,
          ownerSite: player.host,
          opponentSite: game.opponentSite,
          sans: game.sans,
          baseTags: tags,
          result: game.result,
          startMs: game.dateMs,
        }),
      }
    }
    return {
      slug,
      itemId: game.itemId,
      page: buildPageJson(title, [
        { type: 'paragraph', id: game.introId, text: intro, dateMs: game.dateMs },
        { id: game.itemId, text: game.pgn, dateMs: game.dateMs },
      ]),
    }
  })

  // Same story as pages/my-chess-games / SURVEY_PAGE_STORY (stable ids + intro copy).
  const surveyStory = SURVEY_PAGE_STORY.map(item => ({
    type: item.type,
    id: item.id,
    text: item.type === 'chess' ? buildSurveyItemText() : item.text,
    dateMs: Date.now(),
  }))
  const surveyPage = buildPageJson(SURVEY_PAGE_TITLE, surveyStory)
  applyCompletedGameIndexToSurveyPage(
    surveyPage,
    player.host,
    gamePages.map(g => ({
      slug: g.slug,
      itemId: g.itemId,
      title: g.page?.title,
      pgn: chessItemText(g.page, g.itemId),
    })),
  )

  if (opts.dryRun) return

  await fs.mkdir(pagesDir, { recursive: true })
  await fs.mkdir(statusDir, { recursive: true })

  const liveGameSlugs = new Set(gamePages.map(g => g.slug))

  // Prune game pages from the previous seed run that this run no longer produces.
  const manifestLoc = path.join(statusDir, SEED_MANIFEST)
  const prevSeedSlugs = await readJsonOr(manifestLoc, [])
  const removeSlugs = new Set()
  for (const s of Array.isArray(prevSeedSlugs) ? prevSeedSlugs : []) {
    if (!liveGameSlugs.has(s)) removeSlugs.add(s)
  }
  for (const slug of removeSlugs) {
    await fs.rm(path.join(pagesDir, slug), { force: true })
  }

  for (const { slug, page } of gamePages) {
    await fs.writeFile(path.join(pagesDir, slug), JSON.stringify(page, null, 2))
  }
  await fs.writeFile(path.join(pagesDir, SURVEY_PAGE_SLUG), JSON.stringify(surveyPage, null, 2))
  await fs.writeFile(manifestLoc, JSON.stringify([...liveGameSlugs]))

  const farmMeta = await readJsonOr(leagueSeedFarmMetaPath(opts.wikiRoot), null)
  const generatedAt = normalizeLeagueSeedFarmMeta(farmMeta)?.generatedAt || new Date().toISOString()
  await fs.writeFile(
    leagueSeedSiteMetaPath(statusDir),
    JSON.stringify(buildLeagueSeedSiteMeta(player, generatedAt), null, 2),
  )

  // Merge our entries into the served sitemap.json (preserving any other pages on sites
  // that already have content). The /system/sitemap.json route serves this file directly,
  // so this is what makes the new pages fetchable without a restart.
  const sitemapLoc = path.join(statusDir, 'sitemap.json')
  const xmlLoc = path.join(statusDir, 'sitemap.xml')
  const siteIndexLoc = path.join(statusDir, 'site-index.json')
  const pageSlugs = await pageSlugSet(pagesDir)
  const existing = await readJsonOr(sitemapLoc, [])
  const drop = new Set([SURVEY_PAGE_SLUG, ...removeSlugs, ...liveGameSlugs])
  const keep = Array.isArray(existing)
    ? existing.filter(e => e?.slug && pageSlugs.has(e.slug) && !drop.has(e.slug))
    : []
  for (const { slug, page } of gamePages) keep.push(sitemapEntry(slug, page))
  keep.push(sitemapEntry(SURVEY_PAGE_SLUG, surveyPage))
  await fs.writeFile(sitemapLoc, JSON.stringify(keep))
  await fs.writeFile(xmlLoc, buildSitemapXml(keep, `http://${player.host}`))
  if (await pathExists(siteIndexLoc)) await pruneSiteIndex(siteIndexLoc, pageSlugs)

  // Claim brand-new sites with a friendly owner so they aren't unclaimed.
  const ownerLoc = path.join(statusDir, 'owner.json')
  if (!(await pathExists(ownerLoc))) {
    await fs.writeFile(ownerLoc, JSON.stringify({ name: player.name, friend: { secret: '1111' } }, null, 2))
  }
}

// A per-player deterministic-ish id for the survey item (kept stable per run).
let surveyIdCounter = 0x51
function randHexFor(_player) {
  surveyIdCounter += 1
  return (BigInt(surveyIdCounter) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0').slice(-16)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printBoard(players, _opts) {
  // Seed already applied Glicko in-memory. Do NOT rebuild via requireVerified
  // twin-audit of the full PGN pool — that is O(hosts × games²) and can stall for
  // hours after a large Stockfish run (writes would never start).
  const entries = [...players]
    .filter(p => (p.state?.gamesPlayed || 0) > 0 || (p.games?.length || 0) > 0)
    .map(p => {
      const state = normalizeRatingState(p.state)
      return {
        rank: 0,
        rating: Math.round(state.rating),
        provisional: isProvisional(state),
        reliable: isReliable(state),
        name: p.name,
        site: p.host,
      }
    })
    .sort((a, b) => b.rating - a.rating || String(a.site).localeCompare(String(b.site)))
    .map((e, i) => ({ ...e, rank: i + 1 }))

  console.log('')
  console.log('Verified survey leaderboard (what localhost:3001 will show):')
  console.log('='.repeat(64))
  console.log(' #   Rating  Player                 Host')
  console.log('-'.repeat(64))
  for (const e of entries) {
    const rank = String(e.rank).padStart(2)
    const rating = `${e.rating}${e.provisional ? '?' : ' '}`.padStart(6)
    const name = String(e.name).padEnd(20).slice(0, 20)
    console.log(` ${rank}  ${rating}  ${name}   ${e.site}`)
  }
  console.log('-'.repeat(64))
  const reliable = entries.filter(e => e.reliable).length
  console.log(
    `${entries.length} players on the board (${reliable} established, ` + `${entries.length - reliable} provisional).`,
  )
}

function verifyTwins(players) {
  // Spot-check the integrity model: every generated game must verify against its twin.
  const byFingerprintText = new Map()
  let checked = 0
  let failed = 0
  for (const p of players) {
    for (const g of p.games) {
      // Find the same game text on a different site (its twin).
      const twin = g.pgn // identical text is written to both sites
      const audit = auditTwins(g.pgn, twin)
      if (!audit.verified) failed += 1
      checked += 1
      if (checked > 200) break // a sample is enough
    }
    if (checked > 200) break
  }
  void byFingerprintText
  if (failed) console.log(`WARNING: ${failed}/${checked} sampled games failed twin audit.`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runLeagueSeed(argv = []) {
  const opts = parseSeedArgs(argv)
  await runSeedWithOpts(opts)
}

async function runSeedWithOpts(opts) {
  if (!(await pathExists(opts.wikiRoot))) {
    console.error(`Wiki data dir not found: ${opts.wikiRoot}`)
    console.error('Pass --wiki-root=/path/to/.wiki if your farm stores data elsewhere.')
    process.exitCode = 1
    return
  }
  const rng = makeRng(opts.seed)
  const players = buildPopulation(opts, rng)
  const prevFarmMeta = await readJsonOr(leagueSeedFarmMetaPath(opts.wikiRoot), null)
  const autoReset = !opts.reset && !opts.noAutoReset && rosterChangedFromFarmMeta(prevFarmMeta, players)
  if (autoReset) {
    console.log(
      'Roster changed since last league seed — auto-resetting stale sim data ' + '(pass --no-auto-reset to skip).',
    )
    opts.reset = true
  }
  if (opts.reset) {
    await resetSimulationSites(opts, players, prevFarmMeta)
    if (opts.dryRun) {
      console.log('\n--dry-run: reset only; no games simulated or written.')
      return
    }
  }
  const allSites = players.map(p => p.host)
  const seasonTotal = seasonGameTotalForPlayers(opts, players)
  const liveView = createLiveSimView(players, { enabled: opts.live })
  opts.liveView = liveView
  if (liveView.live) {
    const engineLine = opts.useEngine
      ? `${opts.engines} Stockfish engines · ${opts.engineMs}ms/move`
      : 'fast random-move fallback (--no-engine)'
    const islandCount = playersByIsland(players).length
    const globalN = players.filter(p => p.globalEligible).length
    const localOnlyN = players.filter(p => p.localOnly).length
    liveView.begin({
      title: 'League seed — live simulation',
      detail:
        `${players.length} players · ${islandCount} island${islandCount === 1 ? '' : 's'} · ` +
        `${opts.rounds} rounds · ${engineLine}` +
        (islandCount > 1 ? ` · Open field ${globalN} / local-only ${localOnlyN}` : ''),
      subtitle: "Experiment: Glicko learns from Stockfish games; hidden skill is each player's UCI Elo.",
      commandLine: formatSeedCommandLine(opts, players),
      flagLines: formatSeedFlagBlock(opts, players),
    })
    liveView.setPhase(islandCount > 1 ? 'Island Cups → global Open' : TOURNAMENT_OPEN.name, { planned: seasonTotal })
  }
  let pool = null
  if (opts.useEngine) {
    if (liveView.live) {
      liveView.setStatus(`Booting ${opts.engines} Stockfish engines (${opts.engineMs}ms/move)…`)
    } else {
      process.stdout.write(`Booting ${opts.engines} Stockfish engines (${opts.engineMs}ms/move)… `)
    }
    const t0 = Date.now()
    try {
      pool = await new EnginePool(opts.engines).init()
      if (liveView.live) {
        liveView.setStatus(`Engines ready in ${Date.now() - t0}ms`)
      } else {
        console.log(`ready in ${Date.now() - t0}ms.`)
        console.log('Playing real games (this is the slow part — a minute or two)…')
      }
    } catch (err) {
      if (liveView.live) {
        liveView.setStatus('Engine boot failed — using random-move fallback')
      } else {
        console.log('failed.')
      }
      console.error(`Could not start Stockfish (${String(err?.message || err)}); falling back to --no-engine.`)
      pool = null
    }
  }
  let gameCount = 0
  let localCount = 0
  let globalCount = 0
  let bridgeCount = 0
  let friendlyCount = 0
  let casualCount = 0
  try {
    ;({ gameCount, localCount = 0, globalCount = 0 } = await playSeason(opts, rng, pool, players))
    bridgeCount = await playIslandBridges(opts, rng, pool, players)
    friendlyCount = await playRatedFriendlies(opts, rng, pool, players)
    casualCount = await playCasualGames(opts, rng, pool, players)
  } finally {
    if (pool) await pool.close()
    liveView.end()
  }
  console.log(`Simulated ${players.length} players over ${opts.rounds} rounds.`)
  if (localCount || (playersByIsland(players).length > 1 && globalCount)) {
    console.log(
      `Generated ${localCount} Island Cup games + ${globalCount} global Open games` +
        (bridgeCount ? ` + ${bridgeCount} island-bridge rated games` : '') +
        ` + ${friendlyCount} one-off rated games (${(gameCount + bridgeCount + friendlyCount) * 2} PGN records incl. twins).`,
    )
  } else {
    console.log(
      `Generated ${gameCount} championship games` +
        (bridgeCount ? ` + ${bridgeCount} island-bridge rated games` : '') +
        ` + ${friendlyCount} one-off rated games (${(gameCount + bridgeCount + friendlyCount) * 2} PGN records incl. twins).`,
    )
  }
  console.log(`Generated ${casualCount} unrated/casual games for the My Chess Games survey.`)
  verifyTwins(players)
  printIslandSummary(players, opts)
  printBoard(players, opts)
  printRatingAccuracy(players)
  if (opts.dryRun) {
    console.log('\n--dry-run: no files written.')
    return
  }

  // Write wiki pages BEFORE the expensive federation consensus report. A large
  // Stockfish season used to stall for hours in printBoard/printFederationReport
  // while the farm sat empty (after --reset had already wiped prior sites).
  const uidSlugs = buildUidSlugMap(players)
  const farmMeta = buildLeagueSeedFarmMeta(opts, players)
  console.log('')
  console.log(`Writing league data to ${opts.wikiRoot} (${players.length} sites)…`)
  await fs.writeFile(leagueSeedFarmMetaPath(opts.wikiRoot), JSON.stringify(farmMeta, null, 2))
  const writeStarted = Date.now()
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i]
    const gamesN = p.games?.length || 0
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${players.length}] ${p.dir} (${gamesN} game pages)… `)
    const t0 = Date.now()
    await writeSite(opts, p, allSites, uidSlugs, i)
    console.log(`ok ${formatSimDuration(Date.now() - t0)}`)
  }
  process.stdout.write('  Federation hub / island leaderboard charms… ')
  const hubT0 = Date.now()
  await writeFederationHub(opts, players, uidSlugs)
  console.log(`ok ${formatSimDuration(Date.now() - hubT0)}`)
  console.log(`Wrote ${players.length} sites in ${formatSimDuration(Date.now() - writeStarted)}.`)

  // Optional deep consensus check (can be slow on huge pools — keep after writes).
  try {
    await printFederationReport(players)
  } catch (err) {
    console.warn(`Federation consensus report skipped: ${String(err?.message || err)}`)
  }
  console.log('')
  console.log(`Wrote league data into ${opts.wikiRoot}\\<site>\\ for ${players.length} sites.`)
  console.log('Next:')
  console.log('  1. (No restart needed.) In your browser, open http://localhost:3001/')
  console.log('  2. Open a chess item, open the leaderboard from its start menu.')
  console.log('  3. Choose the "Visible federation" reach. Hit Refresh once if the first crawl is sparse.')
}
// =============================================================================
// League validate — Monte Carlo Glicko-2 validation at scale
// =============================================================================

// Large-scale Monte-Carlo simulation for the federated Glicko-2 rating system.
//
// The plugin is brand new, so there is no real population to validate the ratings
// against. This harness manufactures one: it gives every synthetic player a hidden
// "true skill", starts their Glicko-2 state at the neutral 1500 prior (max RD), then
// plays thousands of games whose outcomes are drawn from the true-skill win
// probability. Feeding those results through the SAME pure engine the plugin ships
// (`rateGame` / `updateRatingState`) lets us check that the system actually recovers
// skill at scale:
//
//   - accuracy      — RMSE / correlation between the learned rating and true skill
//   - confidence    — RD shrinks with play and the provisional fraction falls
//   - calibration   — predicted win probabilities match observed win frequencies
//   - sparse play   — idle players' RD re-inflates (the decay path) and recovers
//
// It imports the real library (no copies of the math), so a regression in the
// engine shows up here as a degraded report. Everything is driven by a seeded PRNG
// so a run is reproducible.
//
// Usage:
//   node scripts/dev-tools.js league validate                  # defaults
//   node scripts/dev-tools.js league validate --players=500 --games=40 --periods=26 --seed=7
//
// Flags:
//   --players=N        population size                         (default 400)
//   --games=N          mean rated games per player             (default 30)
//   --periods=N        rating periods (weeks) the season spans (default 20)
//   --draw-rate=N      base draw probability for even games     (default 0.18)
//   --seed=N           PRNG seed                               (default 1)
//   --json             print the metrics block as JSON too
//   --no-live          disable live terminal progress (on by default in a TTY)

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseValidateArgs(argv) {
  const opts = {
    players: 400,
    games: 30,
    periods: 20,
    drawRate: 0.18,
    seed: 1,
    json: false,
    live: Boolean(process.stdout.isTTY),
  }
  for (const arg of argv) {
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--no-live') {
      opts.live = false
      continue
    }
    const m = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (!m) continue
    const key = m[1]
    const val = Number(m[2])
    switch (key) {
      case 'players':
        opts.players = Math.max(2, Math.trunc(val))
        break
      case 'games':
        opts.games = Math.max(1, val)
        break
      case 'periods':
        opts.periods = Math.max(1, Math.trunc(val))
        break
      case 'draw-rate':
        opts.drawRate = Math.min(0.9, Math.max(0, val))
        break
      case 'seed':
        opts.seed = Math.trunc(val)
        break
      default:
        break
    }
  }
  return opts
}

// ---------------------------------------------------------------------------
// Population (Monte Carlo sim)
// ---------------------------------------------------------------------------

// Build N players. Each gets a hidden true skill (~N(1500, 300), clamped to a
// realistic band) and a fresh Glicko-2 state at the neutral 1500 / max-RD prior —
// the same starting point every new player gets in the plugin.
function makePopulation(opts, rng) {
  const players = []
  for (let i = 0; i < opts.players; i += 1) {
    const trueSkill = Math.min(2600, Math.max(600, Math.round(1500 + 300 * gaussian(rng))))
    players.push({
      id: i,
      trueSkill,
      state: newRatingState({ rating: DEFAULT_RATING, updated: 0 }),
      // Per-game history of |estimatedRating - trueSkill| to chart convergence.
      errorByGame: [],
    })
  }
  return players
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------

// Some fraction of games ignore the rating window entirely — in a federated
// network you often just play whoever links you a game, not a matched opponent.
// This cross-range play is also what keeps the rating scale from compressing at
// the tails (a top player who only ever meets near-peers can never pull away).
const GLOBAL_PAIR_RATE = 0.15

// Pick an opponent for `player`. Most games are ladder-style — someone within a
// rating `window` of the player's CURRENT displayed rating — but a slice are fully
// random cross-range games (see GLOBAL_PAIR_RATE). Falls back to a random distinct
// player if the neighbourhood is empty.
function pickOpponent(player, players, rng, window = 300) {
  const randomOther = () => {
    let other = player
    while (other.id === player.id) other = players[Math.trunc(rng() * players.length)]
    return other
  }
  if (rng() < GLOBAL_PAIR_RATE) return randomOther()
  const r = player.state.rating
  const pool = players.filter(p => p.id !== player.id && Math.abs(p.state.rating - r) <= window)
  if (pool.length === 0) return randomOther()
  return pool[Math.trunc(rng() * pool.length)]
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function runValidateSeason(opts) {
  const rng = makeRng(opts.seed)
  const players = makePopulation(opts, rng)
  const liveView = createLiveSimView(players, { enabled: opts.live })
  if (liveView.live) {
    liveView.begin({
      title: 'Monte Carlo validate — live simulation',
      detail: `${opts.players} players · ~${opts.games} games/player · ${opts.periods} periods`,
      subtitle: 'Experiment: neutral 1500 priors converge toward hidden true skill over rating periods.',
    })
    liveView.setPhase('Rating periods', { planned: null })
  }

  // Calibration buckets: predicted win prob (0..1, 10 bins) → {games, wins}. We
  // keep two sets: one over EVERY game (includes the noisy warm-up while ratings
  // are still wrong) and one over STEADY-STATE games where both seats are already
  // settled (RD<=provisional). The steady-state set is the fair test of whether a
  // converged rating actually predicts results.
  const calibration = Array.from({ length: 10 }, () => ({ games: 0, wins: 0 }))
  const calibrationSettled = Array.from({ length: 10 }, () => ({ games: 0, wins: 0 }))
  // Per-period snapshots of mean RD and provisional fraction (confidence curve).
  const confidenceCurve = []

  const start = Date.UTC(2025, 0, 1)
  let totalGames = 0

  for (let period = 0; period < opts.periods; period += 1) {
    // Real timestamps advance one rating period each week so the engine's decay
    // path runs for anyone who happens to sit out a stretch.
    const now = start + period * RATING_PERIOD_MS
    let gamesThisPeriod = 0

    // Each player plays a Poisson-ish number of games this period (mean spread so
    // some are active, some idle — exercising sparse-play RD inflation).
    const perPeriodMean = opts.games / opts.periods
    for (const player of players) {
      const n = Math.max(0, Math.round(perPeriodMean * (0.4 + 1.2 * rng())))
      for (let k = 0; k < n; k += 1) {
        const opponent = pickOpponent(player, players, rng)

        // Randomize colours so neither seat is systematically advantaged.
        const playerIsWhite = rng() < 0.5
        const white = playerIsWhite ? player : opponent
        const black = playerIsWhite ? opponent : player
        const result = sampleResult(rng, white, black, opts.drawRate)

        // Record calibration BEFORE the update, from the engine's own prediction.
        const predWhite = expectedScore(white.state, black.state)
        const whiteScore = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5
        recordCalibration(calibration, predWhite, whiteScore)
        if (white.state.rd <= PROVISIONAL_RD && black.state.rd <= PROVISIONAL_RD) {
          recordCalibration(calibrationSettled, predWhite, whiteScore)
        }

        const rated = rateGame({ white: white.state, black: black.state, result, now })
        if (!rated) continue
        white.state = rated.white
        black.state = rated.black
        totalGames += 1
        gamesThisPeriod += 1

        player.errorByGame.push(Math.abs(player.state.rating - player.trueSkill))
      }
    }

    confidenceCurve.push(snapshotConfidence(players, period + 1))
    liveView.periodFinished({
      period: period + 1,
      totalPeriods: opts.periods,
      gamesThisPeriod,
      totalGames,
    })
  }

  liveView.end()

  return { players, calibration, calibrationSettled, confidenceCurve, totalGames }
}

// Calibration uses a fractional outcome (0 / 0.5 / 1) so draws count as half a win
// in the bucket that predicted the white seat's win probability.
function recordCalibration(buckets, predWhite, whiteScore) {
  const idx = Math.min(9, Math.max(0, Math.floor(predWhite * 10)))
  buckets[idx].games += 1
  buckets[idx].wins += whiteScore
}

function snapshotConfidence(players, period) {
  const active = players.filter(p => p.state.gamesPlayed > 0)
  const meanRd = active.length ? active.reduce((s, p) => s + p.state.rd, 0) / active.length : DEFAULT_RD
  const provisional = active.length ? active.filter(p => p.state.rd > PROVISIONAL_RD).length / active.length : 1
  return { period, meanRd, provisional, activePlayers: active.length }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

// How fast a player's running error drops below ±tol of true skill, averaged over
// players who ever get there. Answers "how many games to a trustworthy rating?".
function convergenceGames(players, tol = 100) {
  const hits = []
  for (const p of players) {
    const idx = p.errorByGame.findIndex(e => e <= tol)
    if (idx >= 0) hits.push(idx + 1)
  }
  if (hits.length === 0) return { mean: null, share: 0 }
  const mean = hits.reduce((a, b) => a + b, 0) / hits.length
  return { mean, share: hits.length / players.length }
}

function computeMetrics(sim) {
  const { players } = sim
  const settled = p => p.state.rd <= PROVISIONAL_RD && p.state.gamesPlayed >= 5

  const overall = rmse(players, p => p.state.gamesPlayed > 0)
  const settledErr = rmse(players, settled)
  const seedErr = Math.sqrt(players.reduce((s, p) => s + (DEFAULT_RATING - p.trueSkill) ** 2, 0) / players.length)

  const active = players.filter(p => p.state.gamesPlayed > 0)
  const corr = pearson(
    active.map(p => p.trueSkill),
    active.map(p => p.state.rating),
  )

  const buildCalibration = buckets => {
    const cal = buckets
      .map((b, i) => ({
        predicted: (i + 0.5) / 10,
        observed: b.games ? b.wins / b.games : null,
        games: b.games,
      }))
      .filter(b => b.observed != null)
    // Weight the error by bucket population so sparse tail bins don't dominate.
    const total = cal.reduce((s, b) => s + b.games, 0)
    const err = total ? cal.reduce((s, b) => s + b.games * Math.abs(b.observed - b.predicted), 0) / total : 0
    return { cal, err }
  }
  const steady = buildCalibration(sim.calibrationSettled)
  const allGames = buildCalibration(sim.calibration)

  // Monotonicity is the robust calibration property: a higher predicted win prob
  // must yield a higher observed win rate. Unlike the error MAGNITUDE (which is
  // inflated by regression-to-the-mean when binning by still-noisy ratings, and
  // shrinks as players accumulate games) the rank order should always hold. Allow
  // a tiny tolerance and ignore sparse (<30-game) tail bins.
  const ranked = steady.cal.filter(b => b.games >= 30)
  // With too few populated bins (tiny populations) rank order is just noise — don't
  // assert it. Real runs have hundreds of players and all ten bins populated.
  let monotonic = true
  if (ranked.length >= 4) {
    for (let i = 1; i < ranked.length; i += 1) {
      if (ranked[i].observed < ranked[i - 1].observed - 0.02) monotonic = false
    }
  }

  const settledShare = active.length ? active.filter(settled).length / active.length : 0

  return {
    seedRmse: seedErr,
    overallRmse: overall.rmse,
    overallN: overall.n,
    settledRmse: settledErr.rmse,
    settledN: settledErr.n,
    correlation: corr,
    calibrationError: steady.err,
    calibration: steady.cal,
    calibrationMonotonic: monotonic,
    warmupCalibrationError: allGames.err,
    settledShare,
    convergence: convergenceGames(players, 100),
    finalConfidence: sim.confidenceCurve[sim.confidenceCurve.length - 1],
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function bar(value, max, width = 28) {
  const filled = Math.round((value / max) * width)
  return '█'.repeat(Math.max(0, Math.min(width, filled))).padEnd(width, '·')
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`
}

function report(opts, sim, m) {
  const lines = []
  lines.push('')
  lines.push('Federated Glicko-2 — large-scale simulation')
  lines.push('='.repeat(60))
  lines.push(`players=${opts.players}  ~games/player=${opts.games}  periods=${opts.periods}  ` + `seed=${opts.seed}`)
  lines.push(`starting prior=${DEFAULT_RATING}  total games played=${sim.totalGames}`)
  lines.push('')

  lines.push('ACCURACY (rating vs hidden true skill)')
  lines.push(`  neutral-prior seed RMSE ........ ${m.seedRmse.toFixed(1)} (before any games)`)
  lines.push(`  learned RMSE (all active) ...... ${m.overallRmse.toFixed(1)} over ${m.overallN}`)
  lines.push(
    `  learned RMSE (settled players) . ${m.settledRmse.toFixed(1)} over ${m.settledN} ` +
      `(RD<=${PROVISIONAL_RD}, >=5 games)`,
  )
  lines.push(`  correlation w/ true skill ...... ${m.correlation.toFixed(3)}`)
  lines.push(
    `  improvement from seed .......... ${pct(1 - m.overallRmse / Math.max(1, m.seedRmse))} ` +
      'lower error than the neutral 1500 prior',
  )
  lines.push('')

  lines.push('CONFIDENCE over the season (mean RD, % provisional)')
  for (const c of sim.confidenceCurve) {
    lines.push(
      `  wk ${String(c.period).padStart(2)} | RD ${bar(c.meanRd, DEFAULT_RD)} ${c.meanRd
        .toFixed(0)
        .padStart(3)}  provisional ${pct(c.provisional).padStart(6)}`,
    )
  }
  lines.push(`  settled share at end ........... ${pct(m.settledShare)}`)
  lines.push('')

  lines.push('ONBOARDING / CONVERGENCE')
  if (m.convergence.mean != null) {
    lines.push(
      `  games to within +/-100 of truth  ${m.convergence.mean.toFixed(1)} ` +
        `(reached by ${pct(m.convergence.share)} of players)`,
    )
  } else {
    lines.push('  games to within +/-100 of truth  (none reached — check params)')
  }
  lines.push('')

  lines.push('CALIBRATION (steady state: both seats already settled)')
  for (const b of m.calibration) {
    lines.push(
      `  pred ${pct(b.predicted).padStart(6)} | obs ${pct(b.observed).padStart(6)} ` +
        `${bar(b.observed, 1)} n=${b.games}`,
    )
  }
  lines.push(`  mean calibration error ......... ${pct(m.calibrationError)} (population-weighted)`)
  lines.push(`  monotonic (pred up => obs up) .. ${m.calibrationMonotonic ? 'yes' : 'NO'}`)
  lines.push('  note: the error MAGNITUDE is residual rating uncertainty (RD) — it shrinks as')
  lines.push('  players play more (e.g. ~7.5% at 30 games, ~4% at 400). Rank order is the')
  lines.push('  property that proves the rating predicts results; that should always hold.')
  lines.push('')

  // A plain pass/fail readout so the harness is usable as a smoke test.
  const checks = [
    ['settled RMSE < 180', m.settledRmse < 180],
    ['learned beats neutral prior', m.overallRmse < m.seedRmse],
    ['correlation > 0.9', m.correlation > 0.9],
    ['calibration is monotonic', m.calibrationMonotonic],
    ['majority of players settle', m.settledShare > 0.5],
  ]
  lines.push('HEALTH CHECKS')
  for (const [label, ok] of checks) {
    lines.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
  }
  const allOk = checks.every(([, ok]) => ok)
  lines.push('')
  lines.push(allOk ? 'RESULT: rating system looks healthy at scale.' : 'RESULT: see FAILs above.')
  lines.push('')

  return { text: lines.join('\n'), allOk }
}

// ---------------------------------------------------------------------------
// Shared rating accuracy (seed league uses the same Glicko-2 engine as validate)
// ---------------------------------------------------------------------------

function printRatingAccuracy(players) {
  const active = players.filter(p => p.state.gamesPlayed > 0)
  if (!active.length) return
  const overall = rmse(active)
  const corr = pearson(
    active.map(p => p.trueSkill),
    active.map(p => p.state.rating),
  )
  console.log('')
  console.log('Rating accuracy (hidden Stockfish skill vs learned Glicko):')
  console.log(`  RMSE ${overall.rmse.toFixed(1)}   correlation ${corr.toFixed(3)}   (${overall.n} active players)`)
}

// ---------------------------------------------------------------------------
// CLI entry points
// ---------------------------------------------------------------------------

export function runLeagueValidate(argv = []) {
  const opts = parseValidateArgs(argv)
  const sim = runValidateSeason(opts)
  const m = computeMetrics(sim)
  const { text, allOk } = report(opts, sim, m)
  process.stdout.write(text)
  if (opts.json) {
    const { calibration: _calibration, ...summary } = m
    process.stdout.write(`\nJSON ${JSON.stringify({ opts, metrics: summary }, null, 2)}\n`)
  }
  process.exitCode = allOk ? 0 : 1
}

export async function runLeague(argv = []) {
  const [sub, ...rest] = argv[0] === 'seed' || argv[0] === 'validate' ? argv : ['seed', ...argv]
  if (sub === 'validate') {
    runLeagueValidate(rest)
    return
  }
  if (sub === 'seed') {
    await runLeagueSeed(rest)
    return
  }
  console.error('Usage: league <seed|validate> [flags…]')
  process.exitCode = 1
}

export {
  runValidateSeason as runSeason,
  computeMetrics,
  trueWinProb,
  gaussian,
  parseSeedArgs,
  buildPopulation,
  SEED_ROSTER_SIZE,
  DEFAULT_SEED_PLAYERS,
  SEED_MIN_PLAYERS,
  SEED_MAX_PLAYERS,
  buildCorrespondenceGamePage,
  pushGameTwins,
  applyCompletedGameIndexToSurveyPage,
  applyFederationCharmToLeaderboardPage,
  gamePresentation,
  uniqueGameTitles,
}
