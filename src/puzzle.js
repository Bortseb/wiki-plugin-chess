/**
 * PUZZLE mode — solver, author editor, Lichess API / farm DB fetch, and filter UI.
 *
 * §1 Puzzle pool parsing & filters
 * §2 Solver console & session
 * §3 Puzzle authoring board
 * §4 Lichess / farm fetch & download UI
 *
 * In-file landmarks use `// # Section Name` for navigation.
 */

import {
  ChessConsole,
  ChessConsolePlayer,
  Board,
  FEN,
  Sound,
  LocalPlayer,
  Chess,
  createStauntyFigures,
  ensurePieceSpriteCached,
  reloadConsoleBoardPieceSet,
  Pgn,
} from './cm-modules-bundle.js'
import {
  parseChessItem,
  parsePuzzleSpec,
  buildPuzzleItemText,
  rewritePuzzleItemText,
  puzzleBankBodyText,
  recordAdaptivePuzzleOutcome,
  academyLinksForPuzzleThemes,
  markPuzzleItemProgress,
  puzzleItemProgressFromText,
  academyProgressFromLocalPages,
  resolveSmartAcademyNext,
  START_FEN,
  escapeHtml,
  isPuzzleState,
  hasActivePuzzleFilters,
  formatPuzzleFiltersLabel,
  formatByteSize,
  PUZZLE_RATING_BOUNDS,
  PUZZLE_POPULARITY_BOUNDS,
  PUZZLE_THEME_OPTIONS,
  PUZZLE_COMMON_THEME_IDS,
  parsePuzzleRow,
  parsePuzzleBankContent,
  parsePuzzleJsonLine,
  isPuzzleRow,
  isPuzzleJsonLine,
  isPuzzleSpecLine,
  puzzleMatchesFilters,
  puzzleFiltersToSearchParams,
  normalizePuzzlePlayModel,
  puzzlePlayerColorFromPuzzle,
} from './chess-core.js'
export { parsePuzzleRow, parsePuzzleBankContent, parsePuzzleJsonLine }
import {
  openPuzzleFilterModal,
  openPuzzleUnavailableModal,
  openLocalPuzzleDownloadModal,
  setAuthGatedButton,
  WIKI_AUTH_REQUIRED_TITLE,
} from './modals.js'
import { embeddedModalMount, shellMessengerFromContext } from './board-layout.js'

function refitBoardForContext(ctx, { optional = false } = {}) {
  if (ctx.isPopupLayout) {
    if (optional) ctx.fitPopupBoard?.()
    else ctx.fitPopupBoard()
  } else if (ctx.isWikiEmbed) {
    if (optional) ctx.fitEmbedBoard?.()
    else ctx.fitEmbedBoard()
  } else if (optional) {
    ctx.scheduleBoardResize?.()
  } else {
    ctx.scheduleBoardResize()
  }
}

// # Puzzle Pool and Solver State

const CSV_HEADER_PREFIX = 'PuzzleId,'

function buildPuzzleRow({
  id,
  fen,
  moves,
  rating = 0,
  ratingDeviation = 0,
  popularity = 0,
  nbPlays = 0,
  themes = [],
  gameUrl = '',
  openingTags = [],
} = {}) {
  const joinTokens = value => (Array.isArray(value) ? value.join(' ') : String(value || '').trim())
  const safe = value =>
    String(value == null ? '' : value)
      .replace(/,/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return [
    safe(id),
    safe(fen),
    safe(joinTokens(moves)),
    String(Number(rating) || 0),
    String(Number(ratingDeviation) || 0),
    String(Number(popularity) || 0),
    String(Number(nbPlays) || 0),
    safe(joinTokens(themes)),
    safe(gameUrl),
    safe(joinTokens(openingTags)),
  ].join(',')
}

function generatePuzzleId(now = Date.now(), rand = Math.random) {
  const stamp = Number(typeof now === 'function' ? now() : now) || 0
  const noise = Math.floor((typeof rand === 'function' ? rand() : rand) * 1296)
  return (stamp.toString(36) + noise.toString(36).padStart(2, '0')).slice(-8)
}

function sanLineToMovetext(sanLine) {
  const sans = String(sanLine || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  let out = ''
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) out += `${i / 2 + 1}. `
    out += `${sans[i]} `
  }
  return out.trim()
}

export function parsePuzzlesCsv(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(CSV_HEADER_PREFIX)) continue
    const puzzle = parsePuzzleRow(line)
    if (puzzle) out.push(puzzle)
  }
  return out
}

export function selectPuzzle(puzzles, options = {}) {
  const { themes, minRating, maxRating, minPopularity, maxPopularity, exclude, random = Math.random } = options
  const wanted = themes && themes.length ? new Set(themes) : null
  const skip = exclude ? new Set(exclude) : null
  const pool = (Array.isArray(puzzles) ? puzzles : []).filter(p => {
    if (skip && skip.has(p.id)) return false
    if (typeof minRating === 'number' && p.rating < minRating) return false
    if (typeof maxRating === 'number' && p.rating > maxRating) return false
    if (typeof minPopularity === 'number' && p.popularity < minPopularity) return false
    if (typeof maxPopularity === 'number' && p.popularity > maxPopularity) return false
    if (wanted && !p.themes.some(t => wanted.has(t))) return false
    return true
  })
  if (!pool.length) return null
  return pool[Math.floor(random() * pool.length) % pool.length]
}

function pieceCountFromFen(fen) {
  const board = String(fen || '').split(/\s+/)[0]
  return (board.match(/[^1-8/]/g) || []).length
}

export function parseEmbeddedPuzzleContent(content) {
  const teach = parseTeachPuzzleFromPgn(content)
  if (teach) return teach
  const bank = parsePuzzleBankContent(content)
  if (!bank?.puzzles?.length) return null
  const puzzle = bank.puzzles[0]
  puzzle.source = 'embedded'
  if (bank.prompt && !puzzle.prompt) puzzle.prompt = bank.prompt
  return puzzle
}

// Collect concrete puzzles from referenced wiki pages. References are deliberately
// one level deep: a page may host annotated PGN or JSONL, but its own pages= links
// are not followed, preventing cycles across the federation.
export function puzzlesFromReferencedPages(pages = []) {
  const puzzles = []
  const seen = new Set()
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageSlug = String(page?.slug || '').trim()
    const pageTitle = String(page?.title || pageSlug).trim()
    for (const item of Array.isArray(page?.story) ? page.story : []) {
      if (item?.type !== 'chess') continue
      const parsed = parseChessItem(item.text)
      if (parsed.mode !== 'PUZZLE' || !parsed.content) continue
      const teach = parseTeachPuzzleFromPgn(parsed.content)
      const bank = teach ? { puzzles: [teach] } : parsePuzzleBankContent(parsed.content)
      for (const puzzle of bank?.puzzles || []) {
        const key = `${puzzle.id || ''}\n${puzzle.fen || ''}\n${(puzzle.moves || []).join(' ')}`
        if (seen.has(key)) continue
        seen.add(key)
        puzzles.push({
          ...puzzle,
          source: 'wiki-page',
          sourcePageSlug: pageSlug,
          sourcePageTitle: pageTitle,
        })
      }
    }
  }
  return puzzles
}

// Teach puzzle from annotated PGN (comments + variations as coaching replies).
//
// Example:
//   PUZZLE
//   [Event "How the Knight Moves"]
//   [FEN "4k3/8/8/8/3N4/8/8/4K3 w - - 0 1"]
//   [SetUp "1"]
//
//   1. Nc6 {Two up, one sideways — the knight’s L.} (1. Ne2 {One-and-one is not an L from d4.}) *
//
// Sibling first-ply tries must each get their own parentheses — packing
// `(1. Ne2 {…} 1. Nf3 {…})` makes cm-pgn treat Nf3 as Black’s reply and throw.
function normalizeTeachPgnVariations(pgn) {
  return String(pgn).replace(/\(([^()]*)\)/g, (full, inner) => {
    const moveRe = /(\d+\.(?:\.\.)?\s+(?:O-O-O|O-O|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?))(\s*\{[^}]*\})?/g
    const moves = []
    let m
    while ((m = moveRe.exec(inner))) {
      moves.push((m[1] + (m[2] || '')).trim())
    }
    if (moves.length <= 1) return full
    if (!moves.every(x => /^1\.(?!\.)\s+/.test(x))) return full
    return moves.map(x => `(${x})`).join(' ')
  })
}

export function parseTeachPuzzleFromPgn(raw) {
  let text = String(raw || '').trim()
  if (!text) return null
  if (/^PUZZLE\b/i.test(text)) text = text.replace(/^PUZZLE\b/i, '').trim()
  const lines = text.split(/\r?\n/)
  if (lines[0] && !lines[0].startsWith('[') && !/^\s*1\./.test(lines[0]) && isPuzzleSpecLine(lines[0])) {
    text = lines.slice(1).join('\n').trim()
  }
  if (!text.startsWith('[') && !/^\s*1\./m.test(text)) return null
  const firstBody =
    text
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(Boolean) || ''
  if (isPuzzleJsonLine(firstBody) || isPuzzleRow(firstBody)) return null

  text = normalizeTeachPgnVariations(text)

  let pgn
  try {
    pgn = new Pgn(text, { sloppy: true })
  } catch {
    // Last resort: drop variations so a broken coaching aside doesn't blank the lesson.
    const stripped = text.replace(/\([^()]*\)/g, ' ').replace(/[ \t]+\n/g, '\n')
    try {
      pgn = new Pgn(normalizeTeachPgnVariations(stripped), { sloppy: true })
    } catch {
      return null
    }
  }
  const main = pgn?.history?.moves
  if (!Array.isArray(main) || !main.length) return null
  const fen = String(pgn.header?.tags?.FEN || START_FEN).trim()
  const moves = []
  const comments = {}
  const wrongHints = {}

  const collectHint = (move, map) => {
    if (!move?.uci) return
    const msg = String(move.commentAfter || move.commentMove || move.commentBefore || '').trim()
    if (msg) map[normalizeUci(move.uci)] = msg
  }

  for (const move of main) {
    if (!move?.uci) continue
    moves.push(normalizeUci(move.uci))
    collectHint(move, comments)
    for (const variation of move.variations || []) {
      const alt = Array.isArray(variation) ? variation[0] : null
      if (!alt?.uci) continue
      if (normalizeUci(alt.uci) === normalizeUci(move.uci)) continue
      collectHint(alt, wrongHints)
      if (!wrongHints[normalizeUci(alt.uci)]) {
        wrongHints[normalizeUci(alt.uci)] = 'Not the idea — try another move.'
      }
    }
  }
  if (!moves.length) return null

  const event = String(pgn.header?.tags?.Event || '').trim()
  const prompt = String(main[0]?.commentBefore || '').trim() || event || 'Find the teaching move.'

  return {
    id: String(pgn.header?.tags?.PuzzleId || event || `teach-${moves[0]}`).trim(),
    fen,
    moves,
    rating: Number(pgn.header?.tags?.Rating) || 0,
    themes: [],
    tags: ['teach', ...(event ? [event] : [])],
    prompt,
    comments,
    wrongHints,
    teach: true,
    noSetup: true,
    source: 'embedded',
    pgn: text,
  }
}

// Human-readable label for where a puzzle was loaded from (puzzle bar UI).
export function formatPuzzleSourceLabel(source, { itemEmbedded = false } = {}) {
  if (itemEmbedded || source === 'embedded') return 'Saved in this item'
  switch (source) {
    case 'wiki-page':
      return 'Curated wiki page'
    case 'farm':
      return 'Farm database'
    case 'local':
      return 'On-device copy'
    case 'lichess-api':
      return 'Lichess API'
    default:
      return ''
  }
}

// Hover / tooltip text explaining the puzzle source badge.
export function formatPuzzleSourceTitle(source, { itemEmbedded = false } = {}) {
  if (itemEmbedded || source === 'embedded') {
    return 'This exact puzzle is saved in the chess item on the wiki page — not drawn from a random pool.'
  }
  switch (source) {
    case 'wiki-page':
      return 'Curated from a referenced Federated Wiki page.'
    case 'farm':
      return 'From the Lichess open puzzle database installed on this wiki farm.'
    case 'local':
      return 'Drawn from the puzzle database downloaded to this device for offline play.'
    case 'lichess-api':
      return 'Fetched live from the Lichess puzzle API — requires an internet connection to lichess.org.'
    default:
      return ''
  }
}

// CSS modifier for the per-puzzle source badge in the puzzle bar.
export function puzzleSourceBadgeClass(source, { itemEmbedded = false } = {}) {
  if (itemEmbedded || source === 'embedded') return 'wiki-puzzle-source-badge-embedded'
  switch (source) {
    case 'wiki-page':
      return 'wiki-puzzle-source-badge-embedded'
    case 'farm':
      return 'wiki-puzzle-source-badge-farm'
    case 'local':
      return 'wiki-puzzle-source-badge-local'
    case 'lichess-api':
      return 'wiki-puzzle-source-badge-lichess'
    default:
      return 'wiki-puzzle-source-badge-unknown'
  }
}

// Copy for the modal shown when no puzzle could be loaded from any source.
export function puzzleUnavailableCopy(reason, ctx = {}) {
  const farmStatus = ctx.farmDbConfig?.status || 'unknown'
  switch (reason) {
    case 'no-match':
      return {
        title: 'No puzzles match your filters',
        message:
          'The farm database and Lichess API are reachable, but nothing in the current rating or popularity range matched. Widen the range or clear filters and try again.',
        showEditFilters: true,
        showRetry: true,
      }
    case 'popularity-needs-farm':
      return {
        title: 'Popularity filter needs the farm database',
        message:
          'Popularity scores exist only in the farm puzzle database. Ask your farm operator to set chess.puzzleDatabase: true in wiki config, or remove the popularity filter and use the Lichess API instead.',
        showEditFilters: true,
        showRetry: false,
      }
    case 'farm-installing':
      return {
        title: 'Farm puzzle database is still installing',
        message: `The shared puzzle database on this farm is still being prepared (${farmStatus}). This can take a while on first setup. Wait a few minutes and try again.`,
        showEditFilters: false,
        showRetry: true,
      }
    case 'offline-no-sources':
      return {
        title: 'Puzzles need a network connection',
        message: ctx.pwaBridgeActive
          ? 'You are offline and no puzzle database is stored on this device. Connect to the internet, or choose Download for offline play in this installed app and wait for the download to finish.'
          : 'You are offline and this wiki farm has no local puzzle database enabled. Connect to the internet so puzzles can load from the Lichess API, or ask your farm operator to enable chess.puzzleDatabase in wiki config.',
        showEditFilters: false,
        showRetry: true,
      }
    case 'offline-local-installing':
      return {
        title: 'Offline puzzle download in progress',
        message:
          'The puzzle database is still downloading or being prepared on this device. Wait for it to finish, then try again.',
        showEditFilters: false,
        showRetry: true,
      }
    case 'offline-farm-unavailable':
      return {
        title: 'Could not reach the farm puzzle database',
        message: ctx.localPuzzleDownloadReady
          ? 'You appear to be offline and could not reach the wiki farm. Connect to the network, or wait until the on-device puzzle database is ready for fully offline play.'
          : 'You appear to be offline. The farm database is only available while this device can reach the wiki server. Connect to the network, or use Download for offline play in this installed app.',
        showEditFilters: false,
        showRetry: true,
      }
    case 'api-unavailable':
      return {
        title: 'Could not reach Lichess',
        message: ctx.canUseFarm
          ? 'The Lichess puzzle API did not respond and the farm database did not return a puzzle either. Check your connection or try again in a moment.'
          : 'The Lichess puzzle API at lichess.org did not respond. Check your internet connection and firewall, or ask your farm operator to enable the shared farm puzzle database (chess.puzzleDatabase in wiki config).',
        showEditFilters: false,
        showRetry: true,
      }
    case 'sources-unavailable':
      return {
        title: 'Could not load a puzzle',
        message:
          'Neither the farm puzzle database nor the Lichess API returned a puzzle. The farm database may still be indexing, or both services may be temporarily unavailable.',
        showEditFilters: false,
        showRetry: true,
      }
    default:
      return {
        title: 'Could not load a puzzle',
        message:
          'No puzzle could be loaded from the farm database or the Lichess API. Check your connection and try again.',
        showEditFilters: false,
        showRetry: true,
      }
  }
}

// Copy for the offline puzzle download dialog on an installed PWA.
export function localPuzzleDownloadModalCopy({ downloadStatus, filters = {}, estimate = null } = {}) {
  const filterLabel = formatPuzzleFiltersLabel(filters)
  const hasFilters = hasActivePuzzleFilters(filters)
  const fullBytes = estimate?.fullBytes ?? 302_000_000
  const filteredBytes = estimate?.filteredBytes ?? null
  const notes = [
    'Downloads come from your wiki farm (browsers cannot fetch database.lichess.org directly).',
    'When indexing finishes on your device, puzzles draw from your on-device copy (online or offline).',
    'If the local copy cannot satisfy your filters, the app falls back to your wiki farm and the Lichess API.',
  ]
  const status = downloadStatus?.status
  if (status === 'downloading' || status === 'indexing') {
    notes.unshift('A download or index build is already in progress on this device.')
  } else if (status === 'downloaded' || status === 'ready') {
    notes.unshift('A puzzle database is already on this device — confirming replaces it.')
  } else if (status === 'error') {
    notes.unshift(`The last download failed (${downloadStatus.error || 'unknown error'}).`)
  }
  if (hasFilters && filterLabel) {
    notes.unshift(`Current puzzle filters: ${filterLabel}.`)
  }
  let message = `Download the full Lichess puzzle database (${formatByteSize(fullBytes)} compressed)?`
  if (hasFilters && filteredBytes != null) {
    const countNote =
      estimate?.filteredCount != null && estimate?.totalCount != null
        ? ` — about ${estimate.filteredCount.toLocaleString()} of ${estimate.totalCount.toLocaleString()} puzzles`
        : ''
    message = `Download the full database (${formatByteSize(fullBytes)}), or a filtered export matching your current settings (${formatByteSize(filteredBytes)}${countNote})?`
  }
  return {
    title: 'Download puzzles for offline play?',
    message,
    notes,
    hasFilters,
    fullLabel: `Full database (${formatByteSize(fullBytes)})`,
    filteredLabel: hasFilters && filteredBytes != null ? `Filtered export (${formatByteSize(filteredBytes)})` : null,
  }
}

// Copy for confirming removal of the on-device puzzle database.
export function localPuzzleDownloadDisableCopy() {
  return {
    title: 'Remove offline puzzles?',
    message: 'Delete the puzzle database from this device?',
    notes: [
      "About 300 MB to 1 GB of puzzle data will be removed from this device's storage.",
      'You can still play puzzles online via your wiki farm and the Lichess API while connected.',
      'You can download the database again using Download for offline play.',
    ],
    confirmLabel: 'Remove offline puzzles',
    confirmClass: 'btn-danger',
  }
}

// True while a local offline puzzle download or index build is in flight.
export function isLocalPuzzleDownloadInProgress() {
  return ['downloading', 'indexing', 'downloaded'].includes(getLocalPuzzleDownloadStatus().status)
}

function formatEmbeddedPuzzleContent(row, prompt) {
  const line = String(row || '').trim()
  const text = String(prompt || '').trim()
  return text ? `${line}\n${text}` : line
}

function suggestPuzzlePrompts({
  setupColor = 'w',
  moveCount = 0,
  solverMoveCount = 0,
  inCheck = false,
  lastMoveIsCheck = false,
  lastMoveIsCapture = false,
  endsInCheckmate = false,
  pieceCount = 32,
} = {}) {
  const setup = setupColor === 'b' ? 'Black' : 'White'
  const solver = setupColor === 'b' ? 'White' : 'Black'
  const phase = pieceCount <= 12 ? 'endgame' : pieceCount <= 22 ? 'middlegame' : 'opening'
  const out = []
  const add = (...items) => {
    for (const item of items) {
      const text = String(item || '').trim()
      if (text && !out.includes(text)) out.push(text)
    }
  }

  if (moveCount === 0) {
    add(
      `Find the best move for ${solver}.`,
      'Find the winning tactic.',
      'Can you find the only move?',
      'Find the best continuation.',
    )
    if (phase === 'endgame') add('Find the winning endgame move.', 'Convert your advantage.')
    else if (phase === 'middlegame') add('Find the best tactical move.', 'Exploit the weakness in the position.')
    else add('Find the best opening tactic.')
    add('Find the fork.', 'Find the pin.', 'Win material with a tactic.', 'Deliver checkmate.')
    return out.slice(0, 4)
  }

  if (moveCount === 1) {
    add(
      'Find the best reply.',
      `How does ${solver} punish that move?`,
      'Find the refutation.',
      `Find the best move for ${solver}.`,
    )
    if (inCheck) add(`${solver} is in check — find the best move.`, 'Defend and counterattack.')
    if (lastMoveIsCapture) add('Recapture — or find something better!')
    if (lastMoveIsCheck) add('Answer the check — and win!')
    add('Find the winning tactic.', 'Find the only move.', 'Win material.')
    return out.slice(0, 4)
  }

  if (endsInCheckmate) {
    if (solverMoveCount === 1) add('Deliver checkmate!', 'Mate in one — find the winning move.')
    else if (solverMoveCount === 2) add('Mate in two — find the winning sequence.', 'Find the forced mate.')
    else if (solverMoveCount >= 3)
      add(`Mate in ${solverMoveCount} — find the winning sequence.`, 'Find the forced mate.')
  } else if (solverMoveCount === 1) {
    add('Find the best move.', 'Win material or deliver mate.', 'Find the crushing move.')
  } else if (solverMoveCount >= 2) {
    add('Find the winning combination.', 'Find the best continuation.')
  }

  if (moveCount % 2 === 1) {
    add(`Now play ${solver}'s move — the solver must find this.`)
  } else {
    add(`${setup}'s reply is played — save now or extend the line.`)
  }

  if (phase === 'endgame') add('Find the winning endgame resource.')
  add(
    'Find the fork.',
    'Find the pin.',
    'Find the skewer.',
    'Win with a discovered attack.',
    'Exploit the hanging piece.',
    'Find the back-rank mate.',
    'Find the crushing move.',
  )
  return out.slice(0, 4)
}

function normalizeUci(uci) {
  return String(uci || '')
    .trim()
    .toLowerCase()
}

export function createPuzzleSolver(puzzle) {
  puzzle = normalizePuzzlePlayModel(puzzle) || puzzle
  const teach = Boolean(puzzle?.teach || puzzle?.noSetup)
  const minMoves = teach ? 1 : 2
  if (!puzzle || !Array.isArray(puzzle.moves) || puzzle.moves.length < minMoves) {
    throw new Error('createPuzzleSolver: invalid puzzle')
  }
  const setupMove = teach ? null : puzzle.moves[0]
  const solution = teach ? puzzle.moves.map(normalizeUci) : puzzle.moves.slice(1).map(normalizeUci)
  let index = 0
  let status = 'idle'

  const isPlayerTurn = () => status === 'solving' && index % 2 === 0
  const expectedMove = () => (index < solution.length ? solution[index] : null)
  const isFinalPlayerPly = () => index === solution.length - 1

  return {
    puzzle,
    setupMove,
    solution,
    teach,
    playerColor: puzzlePlayerColorFromPuzzle(puzzle),
    get status() {
      return status
    },
    get solved() {
      return status === 'solved'
    },
    get failed() {
      return status === 'failed'
    },
    isPlayerTurn,
    expectedMove,
    get remainingPlayerMoves() {
      let n = 0
      for (let i = index; i < solution.length; i += 2) n++
      return n
    },
    start() {
      if (status === 'idle') status = 'solving'
      return this
    },
    exportState() {
      return { index, status }
    },
    importState({ index: nextIndex = 0, status: nextStatus = 'solving' } = {}) {
      index = nextIndex
      status = nextStatus
      return this
    },
    submitMove(uci, { isCheckmate = false } = {}) {
      if (!isPlayerTurn()) return { status: 'ignored', reason: 'not-player-turn' }
      const expected = expectedMove()
      const played = normalizeUci(uci)
      const correct = played === normalizeUci(expected) || (isCheckmate && isFinalPlayerPly())
      if (!correct) {
        const coach = puzzle.wrongHints?.[played]
        if (teach) {
          // Academy teach-PGN: never hard-fail. A hard fail leaves the wrong ply on
          // the board, asks PuzzlePlayer (empty queue) to reply, and freezes input —
          // only Retry recovers. Soft-coach every try (variation text or default).
          return {
            status: 'coach',
            expected,
            message: coach || 'Not the idea — try another move.',
          }
        }
        status = 'failed'
        return { status: 'wrong', expected, message: coach || undefined }
      }
      const praise = puzzle.comments?.[played]
      index++
      if (index >= solution.length) {
        status = 'solved'
        return { status: 'solved', message: praise }
      }
      const opponentMove = solution[index]
      index++
      if (index >= solution.length) {
        status = 'solved'
      }
      return { status: status === 'solved' ? 'solved' : 'continue', opponentMove, message: praise }
    },
    // Illegal drop (piece onto a square it cannot reach) — one-chance hard fail.
    failIllegal() {
      if (status === 'solved' || status === 'failed') return { status: 'ignored', reason: 'already-done' }
      if (status !== 'solving') return { status: 'ignored', reason: 'not-solving' }
      status = 'failed'
      return {
        status: 'wrong',
        reason: 'illegal',
        message: 'That square is not a legal move for that piece.',
      }
    },
  }
}

export function invalidatePuzzleConsoles() {
  ctx.chessConsole = undefined
  puzzleConsoleReady = null
  authorConsoleReady = null
  puzzleBootPromise = null
  puzzleBootKey = null
  const puzzleContainer = document.getElementById('puzzle-console-container')
  if (puzzleContainer) puzzleContainer.innerHTML = ''
  const authorContainer = document.getElementById('author-console-container')
  if (authorContainer) authorContainer.innerHTML = ''
}

export async function reloadPuzzleBoardForPieceSet() {
  const chessConsole = ctx.chessConsole
  if (chessConsole?.components?.board?.chessboard) {
    await reloadConsoleBoardPieceSet(chessConsole, {
      piecesFile: pieceSetFile(),
      assetsUrl: './assets/',
      reenableMoveInput: true,
    })
    chessConsole.props.figures = createStauntyFigures(pieceSpritesUrl(), 18)
    refitBoardForContext(ctx, { optional: true })
    ctx.notifyWikiHeight?.()
    return
  }

  // Board not built yet — full (re)boot picks up the new piece set from pieceSetFile().
  const authorActive = isPuzzleAuthorActive()
  const authorFen = authorStartFen
  const snap = authorActive ? null : capturePuzzleResumeSnapshot()
  invalidatePuzzleConsoles()
  if (authorActive) {
    await createPuzzleFromPosition(authorFen || START_FEN)
    return
  }
  if (snap?.puzzleResume?.currentPuzzleRow || snap?.puzzleResume?.embeddedRow) {
    await resumePuzzleSession(snap)
    return
  }
  await startPuzzle()
}

const STAUNTY_PIECES_URL = './assets/pieces/merida.svg'

function pieceSpritesUrl() {
  return ctx.getPieceSpritesUrl?.() || STAUNTY_PIECES_URL
}

function pieceSetFile() {
  return ctx.getPieceSetFile?.() || 'pieces/merida.svg'
}

let ctx

function shellMessenger() {
  return shellMessengerFromContext(ctx)
}

export function initPuzzleMode(context) {
  ctx = context
  // Offline download can finish (or resume after reload) outside Puzzle mode — keep a
  // cross-mode float + unload guard alive for the whole app session.
  void ensureLocalPuzzleMetaLoaded().then(() => {
    updateLocalPuzzleDownloadUI()
    if (ctx.pwaBridgeActive) {
      resumeLocalPuzzleDownloadIfNeeded({ onProgress: updateLocalPuzzleDownloadUI })
    }
  })
}

// # Puzzle Authoring
// The start position plus the UCI line recorded while the author plays out the
// puzzle on the author board.
let authorConsoleReady = null
let authorStartFen = ''
let authorMoves = []
let authorPromptEdited = false

export function isPuzzleAuthorActive() {
  const page = document.getElementById('puzzle-author')
  if (!page) return false
  if (page.classList.contains('wiki-page-active')) return true
  return page.style.display === 'block'
}

export function hasUnsavedPuzzleAuthorWork() {
  if (!isPuzzleAuthorActive()) return false
  return authorMoves.length > 0 || authorPromptEdited
}

export function getPuzzleAuthorStartFen() {
  return authorStartFen || ''
}

export function abandonPuzzleAuthoring() {
  ctx.chessConsole = undefined
  authorConsoleReady = null
  authorMoves = []
  authorStartFen = ''
  authorPromptEdited = false
}

function authorSetupColor() {
  return String(authorStartFen).split(/\s+/)[1] === 'b' ? 'b' : 'w'
}

export function createPuzzleFromPosition() {
  const fen = ctx.fenEditor?.state?.fen?.toString()
  if (!fen) return
  authorStartFen = fen
  authorMoves = []
  authorPromptEdited = false
  embeddedPuzzle = null
  embeddedPuzzleBank = null
  mixedPuzzlePool = false
  preferNetworkPuzzle = false
  ctx.chessConsole = undefined
  authorConsoleReady = null
  ctx.changePage('puzzle-author')
  // Neutralize the shell's POSITION footer ("Save position to wiki", etc.) while
  // authoring — same trick the puzzle/game switches use. No journal write happens.
  shellMessenger()?.modeChanged({
    chessObj: { gameType: 'puzzle', mode: 'PUZZLE', format: 'PUZZLE', showStartMenu: false },
  })
  ensureAuthorConsole()
    .then(() => {
      wirePuzzleAuthorControls()
      resetAuthorBoard()
    })
    .catch(error => console.error('Failed to start puzzle author board:', error))
}

// A board the author plays both sides on: two LocalPlayers, minimal single-column
// template (mirrors ensurePuzzleConsole). We record each legal move into authorMoves.
async function ensureAuthorConsole() {
  if (ctx.chessConsole) return ctx.chessConsole
  if (authorConsoleReady) return authorConsoleReady
  authorConsoleReady = (async () => {
    await ensurePieceSpriteCached(pieceSpritesUrl())
    const container = document.getElementById('author-console-container')
    // The author console is rebuilt fresh on every entry into "Create puzzle"
    // (createPuzzleFromPosition / cancelPuzzleAuthoring both clear the cached
    // promise). ChessConsole only injects its template when the container has no
    // existing `.chess-console`, so a leftover board from the previous session
    // would stack a second board instead of being replaced. Clear it first.
    if (container) container.innerHTML = ''
    const white = { type: LocalPlayer, name: 'White', props: {} }
    const black = { type: LocalPlayer, name: 'Black', props: {} }
    ctx.chessConsole = new ChessConsole(container, white, black, {
      figures: createStauntyFigures(pieceSpritesUrl(), 18),
      template:
        '<div class="chess-console wiki-puzzle-console">' +
        '<div class="chess-console-center"><div class="chess-console-board"></div>' +
        '<div class="chess-console-notifications"></div></div></div>',
    })
    installPuzzleInsufficientMaterialPlay(ctx.chessConsole)
    // Board init syncs to chessConsole.state.chess (defaults to start); prime empty first.
    syncPuzzleConsoleEmptyBoard(ctx.chessConsole)
    await new Board(ctx.chessConsole, {
      assetsUrl: './assets/',
      assetsCache: true,
      position: FEN.empty,
      style: {
        cssClass: 'green',
        borderType: 'frame',
        showCoordinates: true,
        pieces: { file: pieceSetFile() },
      },
    }).initialized
    new Sound(ctx.chessConsole, { soundSpriteFile: './assets/sounds/chess_console_sounds.mp3' })
    ctx.patchSoundForSync(ctx.chessConsole)
    ctx.chessConsole.messageBroker.subscribe('game/move/legal', onAuthorMove)
    return ctx.chessConsole
  })()
  return authorConsoleReady
}

function authorSolverColor() {
  return puzzlePlayerColorFromPuzzle({ fen: authorStartFen })
}

function resetAuthorBoard() {
  if (!ctx.chessConsole) return
  authorMoves = []
  authorPromptEdited = false
  const solverColor = authorSolverColor()
  // initGame alone does not clear cm-chessboard move input. If input is still
  // marked enabled from the previous line, LocalPlayer.moveRequest skips
  // enableMoveInput and the board stays locked with a stale callback.
  ctx.chessConsole.components?.board?.chessboard?.disableMoveInput?.()
  ctx.chessConsole.initGame({ pgn: puzzleSetupPgn(authorStartFen), playerColor: solverColor }, true)
  orientPuzzleBoard(solverColor)
  renderAuthorMoves()
  updateAuthorStatus()
  renderAuthorPromptSuggestions({ autoFillPrompt: true })
  refitBoardForContext(ctx)
  ctx.notifyWikiHeight()
  ctx.notifyPwaPlayLayoutReady?.()
}

function onAuthorMove(data) {
  const mr = data?.moveResult || {}
  if (!mr.from || !mr.to) return
  authorMoves.push(`${mr.from}${mr.to}${mr.promotion || ''}`)
  renderAuthorMoves()
  updateAuthorStatus()
  renderAuthorPromptSuggestions()
}

function renderAuthorMoves() {
  const el = document.getElementById('puzzleAuthorMoves')
  if (!el) return
  const history = ctx.chessConsole?.state?.chess?.history?.() || []
  const sans = history.map(m => (typeof m === 'string' ? m : m?.san)).filter(Boolean)
  if (!sans.length) {
    el.textContent = ''
    return
  }
  // Label each ply by its role so the author can see what they're building:
  // the first move is the setup, then solver / opponent alternate.
  el.innerHTML = sans
    .map((san, i) => {
      const role = i === 0 ? 'Setup' : i % 2 === 1 ? 'Solve' : 'Reply'
      return `<span class="wiki-author-move wiki-author-move-${role.toLowerCase()}">${escapeHtml(
        role,
      )} ${escapeHtml(san)}</span>`
    })
    .join(' ')
}

function updateAuthorStatus() {
  const el = document.getElementById('puzzleAuthorStatus')
  const saveBtn = document.getElementById('puzzleAuthorSaveBtn')
  const n = authorMoves.length
  const setupName = authorSetupColor() === 'w' ? 'White' : 'Black'
  const solverName = authorSetupColor() === 'w' ? 'Black' : 'White'
  let msg = ''
  if (n === 0) {
    msg = `${setupName} plays the setup move from the top — then ${solverName} (you) finds the replies from this side.`
  } else if (n % 2 === 1) {
    msg = `Now play ${solverName}'s move — this is the move the solver must find.`
  } else {
    msg = `${setupName}'s reply played. Continue the line, or save now (solver finds ${n / 2} move${
      n / 2 === 1 ? '' : 's'
    }).`
  }
  if (el) el.textContent = msg
  // A well-formed puzzle ends on the solver's move: setup + an odd-length solution,
  // i.e. an even total of at least two moves.
  const canSaveLine = n >= 2 && n % 2 === 0
  if (saveBtn) {
    const canPublish = Boolean(ctx.canPublish?.())
    if (ctx.pwaBridgeActive && !canPublish) {
      setAuthGatedButton(saveBtn, false, {
        titleWhenDisabled: ctx.pwaAuthGateTitle?.() || WIKI_AUTH_REQUIRED_TITLE,
      })
    } else {
      setAuthGatedButton(saveBtn, canSaveLine)
    }
  }
  ctx.notifyWikiHeight()
}

function authorBoardContext() {
  const chess = ctx.chessConsole?.state?.chess
  const history = chess?.history?.({ verbose: true }) || []
  const last = history[history.length - 1]
  const solverMoveCount = authorMoves.length <= 1 ? 0 : Math.floor((authorMoves.length - 1) / 2)
  return {
    setupColor: authorSetupColor(),
    moveCount: authorMoves.length,
    solverMoveCount,
    inCheck: Boolean(chess?.inCheck?.()),
    lastMoveIsCheck: Boolean(last?.san?.includes('+') || last?.san?.includes('#')),
    lastMoveIsCapture: Boolean(last?.captured),
    endsInCheckmate: Boolean(chess?.inCheckmate?.()),
    pieceCount: pieceCountFromFen(chess?.fen?.() || authorStartFen),
  }
}

function getAuthorPrompt() {
  return document.getElementById('puzzleAuthorPrompt')?.value.trim() || ''
}

function setAuthorPrompt(value, { edited = false } = {}) {
  const input = document.getElementById('puzzleAuthorPrompt')
  if (input) input.value = value
  if (edited) authorPromptEdited = true
}

function renderAuthorPromptSuggestions({ autoFillPrompt = false } = {}) {
  const host = document.getElementById('puzzleAuthorPromptSuggestions')
  if (!host) return
  const suggestions = suggestPuzzlePrompts(authorBoardContext())
  host.innerHTML = suggestions
    .map(
      text =>
        `<button type="button" class="wiki-puzzle-prompt-chip" data-prompt="${escapeHtml(
          text,
        )}">${escapeHtml(text)}</button>`,
    )
    .join('')
  if (autoFillPrompt && !authorPromptEdited && suggestions.length) setAuthorPrompt(suggestions[0])
  ctx.notifyWikiHeight()
}

function savePuzzleAuthoring() {
  if (authorMoves.length < 2 || authorMoves.length % 2 !== 0) return
  const row = buildPuzzleRow({
    id: generatePuzzleId(),
    fen: authorStartFen,
    moves: authorMoves,
    rating: 0,
    themes: ['custom'],
  })
  const prompt = getAuthorPrompt()
  const puzzle = parseEmbeddedPuzzleContent(formatEmbeddedPuzzleContent(row, prompt))
  if (!puzzle) {
    console.error('Authored puzzle row was invalid:', row)
    return
  }
  const text = prompt ? `PUZZLE\n${row}\n${prompt}` : `PUZZLE\n${row}`
  embeddedPuzzle = puzzle
  ctx.chessState = {
    ...(ctx.chessState || {}),
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState: text,
    FEN: undefined,
    PGN: undefined,
    bareKeywordGuard: undefined,
  }
  // Persist the new item text, then drop the author board and play the puzzle.
  ctx.putJournal(text)
  shellMessenger()?.modeChanged({
    chessObj: { gameType: 'puzzle', mode: 'PUZZLE', format: 'PUZZLE', showStartMenu: false },
  })
  ctx.chessConsole = undefined
  authorConsoleReady = null
  puzzleConsoleReady = null
  startPuzzle()
}

function cancelPuzzleAuthoring() {
  const fen = authorStartFen || START_FEN
  ctx.chessConsole = undefined
  authorConsoleReady = null
  shellMessenger()?.modeChanged({
    chessObj: { gameType: 'position', mode: 'POSITION', format: 'FEN', FEN: fen, showStartMenu: false },
  })
  ctx.initializeChess({
    ...ctx.pickAppStateBasics(),
    format: 'FEN',
    FEN: fen,
    gameType: 'position',
    needsSeed: false,
  })
}

function wirePuzzleAuthorControls() {
  const page = document.getElementById('puzzle-author')
  if (!page || page._wikiAuthorWired) return
  page._wikiAuthorWired = true
  page.querySelector('#puzzleAuthorSaveBtn')?.addEventListener('click', () => savePuzzleAuthoring())
  page.querySelector('#puzzleAuthorCancelBtn')?.addEventListener('click', () => cancelPuzzleAuthoring())
  page
    .querySelector('#puzzleAuthorChooseModeBtn')
    ?.addEventListener('click', () => ctx.confirmSwitchGameModeFromEditor())
  page.querySelector('#puzzleAuthorPrompt')?.addEventListener('input', () => {
    authorPromptEdited = true
  })
  page.querySelector('#puzzleAuthorPromptSuggestions')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-prompt]')
    if (!chip) return
    setAuthorPrompt(chip.getAttribute('data-prompt') || '', { edited: true })
    document.getElementById('puzzleAuthorPrompt')?.focus({ preventScroll: true })
  })
}

// # Puzzle Mode UI

let puzzleSolver = null
// Teach soft-coach leaves Retry disabled (failed stays false). Track coach so Retry can reset.
let puzzleCoachActive = false
// Total solver moves at the start of the current puzzle — lets the turn prompt tell
// the opening move ("Your turn") from a mid-solve step ("✓ Correct! Your move").
let puzzleTotalPlayerMoves = 0
let puzzleConsoleReady = null
const puzzleSeenIds = new Set() // avoid repeating puzzles within a session
// Concrete puzzles curated by the item itself or referenced wiki pages.
let embeddedPuzzle = null
let embeddedPuzzleBank = null
let mixedPuzzlePool = false
let preferNetworkPuzzle = false
let puzzlePageRequestSeq = 0
const pendingPuzzlePageRequests = new Map()

// Player-chosen puzzle pool filters (rating + popularity), gathered by the filter
// modal before a (new) puzzle is drawn. null/{} means "any". Only bounds the player
// actually narrowed are stored, so a full-range pick behaves like no filter.
let puzzleFilters = null
// The wiki shell re-sends SET_STATE several times on load (GET_STATE retries, auth
// sync). Without coalescing, each one re-enters startPuzzle and races loadNextPuzzle.
let puzzleBootKey = ''
let puzzleBootPromise = null
let puzzleLoadGeneration = 0
// cm-chess needs a full FEN; cm-chessboard accepts the piece-placement-only form.
const PUZZLE_BOARD_EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1'

function embeddedBankIsRotating() {
  return Array.isArray(embeddedPuzzleBank) && embeddedPuzzleBank.length > 1
}

function puzzleIsCurated(puzzle = puzzleSolver?.puzzle) {
  return puzzle?.source === 'embedded' || puzzle?.source === 'wiki-page'
}

function adaptiveLoggedIds(filters = activePuzzleFilters()) {
  const f = filters || {}
  return new Set([
    ...(Array.isArray(f.solvedIds) ? f.solvedIds : []),
    ...(Array.isArray(f.failedIds) ? f.failedIds : []),
  ])
}

function isAdaptiveCoachMode() {
  return Boolean(activePuzzleFilters()?.adaptive)
}

function pickFromEmbeddedBank(excludeId = null) {
  if (!Array.isArray(embeddedPuzzleBank) || !embeddedPuzzleBank.length) return null
  const filters = activePuzzleFilters()
  const matching = embeddedPuzzleBank.filter(p => puzzleMatchesFilters(p, filters))
  const pool = matching.length ? matching : mixedPuzzlePool ? [] : embeddedPuzzleBank
  if (!pool.length) return null
  const logged = isAdaptiveCoachMode() ? adaptiveLoggedIds(filters) : null
  const unseen = pool.filter(p => p.id !== excludeId && !puzzleSeenIds.has(p.id) && !(logged && logged.has(p.id)))
  const fresh = logged
    ? pool.filter(p => p.id !== excludeId && !logged.has(p.id))
    : pool.filter(p => p.id !== excludeId)
  const choices = unseen.length ? unseen : fresh
  const pickFrom = choices.length ? choices : pool.filter(p => p.id !== excludeId)
  const finalPool = pickFrom.length ? pickFrom : pool
  // Adaptive coach climbs gradually: always offer the easiest remaining draw.
  if (isAdaptiveCoachMode()) {
    const ranked = [...finalPool].sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0))
    return ranked[0] || pool[0] || null
  }
  return finalPool[Math.floor(Math.random() * finalPool.length)] || pool[0] || null
}

function syncPuzzleConsoleEmptyBoard(chessConsole) {
  if (!chessConsole?.state?.chess) return
  chessConsole.state.chess.load(PUZZLE_BOARD_EMPTY_FEN)
  chessConsole.state.plyViewed = 0
}

async function showEmptyPuzzleBoard() {
  const chessConsole = ctx.chessConsole
  const chessboard = chessConsole?.components?.board?.chessboard
  if (!chessboard) return
  chessboard.disableMoveInput?.()
  chessConsole.opponent?.reset?.()
  // Keep the current puzzle visible while the next one loads — clearing the board
  // first made every "New puzzle" click flash empty pieces.
  const placement = chessboard.getPosition?.()
  const isEmpty = !placement || placement === FEN.empty
  if (!isEmpty) return
  syncPuzzleConsoleEmptyBoard(chessConsole)
  await chessboard.setPosition(FEN.empty, false)
}

function puzzleItemBootKey() {
  return String(ctx.chessState?.chessState || '').trim()
}

function clearPuzzleBootCoalescing() {
  puzzleBootKey = ''
  puzzleBootPromise = null
}

function puzzlePageVisible() {
  const page = document.getElementById('puzzle')
  return Boolean(
    page &&
      (page.classList.contains('wiki-page-active') || page.style.display === 'block' || !page.hasAttribute('hidden')),
  )
}

function puzzleLoadErrorVisible() {
  const errEl = document.getElementById('puzzle-load-error')
  return Boolean(errEl && !errEl.hasAttribute('hidden'))
}

function showPuzzleLoadedUi() {
  document.getElementById('puzzle-loaded')?.removeAttribute('hidden')
  document.getElementById('puzzle-load-error')?.setAttribute('hidden', '')
}

// The wiki shell re-pushes SET_STATE while auth resolves and on GET_STATE retries.
// A puzzle item must not restart its fetch loop when the item text is unchanged.
export function shouldKeepActivePuzzleSession(next, prev = ctx.chessState) {
  if (!isPuzzleState(next)) return false
  const nextKey = String(next?.chessState || '').trim()
  const prevKey = String(prev?.chessState || '').trim()
  if (nextKey !== prevKey) {
    // Adaptive coach / lesson progress rewrites first-line tokens on the same body — keep the board.
    const nextBody = puzzleBankBodyText(nextKey)
    const prevBody = puzzleBankBodyText(prevKey)
    if (nextBody && nextBody === prevBody) return true
    return false
  }
  // Prior boot failed — allow a fresh startPuzzle() when the shell re-pushes SET_STATE
  // (common after navigating away and returning to an Academy lesson item).
  if (puzzleLoadErrorVisible()) return false
  if (puzzleBootPromise) return true
  if (!puzzlePageVisible()) return false
  // Console was torn down (mode switch / reset) while the puzzle page stayed mounted.
  if (!ctx.chessConsole && !puzzleConsoleReady) return false
  if (puzzleSolver?.puzzle) return true
  if (ctx.chessConsole?.components?.board?.chessboard?.view) return true
  const statusEl = document.getElementById('puzzle-status')
  return Boolean(statusEl?.textContent?.includes('Loading puzzle'))
}

export function mergePuzzleShellContext(prev, incoming) {
  const out = { ...(prev && typeof prev === 'object' ? prev : {}) }
  for (const key of [
    'pageOnThisWiki',
    'ownerCanJournalHere',
    'guestLocalStoragePersist',
    'signedInDisplayName',
    'wikiSite',
    'wikiSiteUrl',
    'wikiPageName',
    'wikiPageTitle',
    'itemId',
    'viewerCanClaimWikiSeat',
    'viewerSeatId',
    'viewerAuthenticated',
    'followsPopup',
  ]) {
    if (incoming?.[key] !== undefined) out[key] = incoming[key]
  }
  return out
}

function puzzleLoadFailureReason({ filters, online, canUseFarm, anyFilteredCandidate, localOptIn }) {
  if (filtersNeedFarmPopularity(filters) && !canUseFarm) return 'popularity-needs-farm'
  if (farmDbConfig?.installing) return 'farm-installing'
  if (anyFilteredCandidate && Object.keys(filters).length) return 'no-match'
  if (!online) {
    if (localOptIn) {
      const localStatus = getLocalPuzzleDownloadStatus().status
      if (localStatus === 'downloading' || localStatus === 'indexing' || localStatus === 'downloaded')
        return 'offline-local-installing'
    }
    if (!canUseFarm && !localOptIn) return 'offline-no-sources'
    if (!canUseFarm) return 'offline-no-sources'
    return 'offline-farm-unavailable'
  }
  if (canUseFarm && online) return 'sources-unavailable'
  return 'api-unavailable'
}

async function resolveNextPuzzle(filters = {}) {
  const online = navigator.onLine !== false
  const canUseFarm = canUseFarmPuzzles()
  const localOptIn = Boolean(ctx.localPuzzleDownloadEnabled?.())
  // When popularity is filtered, keep trying the farm route — the API cannot satisfy it.
  const attempts = filtersNeedFarmPopularity(filters) && canUseFarm ? PUZZLE_FETCH_ATTEMPTS * 2 : PUZZLE_FETCH_ATTEMPTS
  let anyFilteredCandidate = false

  // Prefer the on-device copy whenever it is ready; when offline but still
  // downloading, fetchLocalPuzzle is a no-op and we fall through to farm/API.
  if (localOptIn && (localPuzzleDownloadReady() || !online)) {
    const local = await fetchLocalPuzzle(filters)
    if (local) {
      if (puzzlePassesFilters(local, filters)) return { puzzle: local }
      anyFilteredCandidate = true
    }
  }

  for (let i = 0; i < attempts; i++) {
    if (canUseFarm) {
      const farm = await fetchFarmPuzzle(filters)
      if (farm) {
        if (puzzlePassesFilters(farm, filters)) return { puzzle: farm }
        anyFilteredCandidate = true
      }
    }
    if (online && !filtersNeedFarmPopularity(filters)) {
      const api = await fetchApiPuzzle(filters)
      if (api) {
        if (puzzlePassesFilters(api, filters)) return { puzzle: api }
        anyFilteredCandidate = true
      }
    }
    // Farm DB may still be opening on first page load; a later attempt often succeeds.
    if (i + 1 < attempts) await new Promise(r => setTimeout(r, 350))
  }

  return {
    puzzle: null,
    failure: puzzleLoadFailureReason({ filters, online, canUseFarm, anyFilteredCandidate, localOptIn }),
  }
}

function activePuzzleFilters() {
  return puzzleFilters || {}
}

// Item text for the current puzzle filter selection (used when spawning a PUZZLE ghost page).
export function puzzleFilterItemText() {
  return buildPuzzleItemText(activePuzzleFilters())
}

// Build the stored filter from the modal's chosen ranges, dropping any bound left at
// its extreme (so "full range" doesn't needlessly exclude sourced puzzles).
function normalizePuzzleFilters(values) {
  const rating = values?.rating || {}
  const popularity = values?.popularity || {}
  const filters = {}
  if (rating.low > PUZZLE_RATING_BOUNDS.min) filters.minRating = rating.low
  if (rating.high < PUZZLE_RATING_BOUNDS.max) filters.maxRating = rating.high
  if (popularity.low > PUZZLE_POPULARITY_BOUNDS.min) filters.minPopularity = popularity.low
  if (popularity.high < PUZZLE_POPULARITY_BOUNDS.max) filters.maxPopularity = popularity.high
  const themes = Array.isArray(values?.themes) ? values.themes.filter(Boolean) : []
  if (themes.length) filters.themes = themes
  return filters
}

// True when a puzzle satisfies the active rating/popularity bounds. A puzzle missing
// the popularity field (e.g. the Lichess API doesn't expose it) fails a popularity
// filter, so we fall through to a source that can honour it (the farm database).
function puzzlePassesFilters(puzzle, filters = activePuzzleFilters()) {
  return puzzleMatchesFilters(puzzle, filters)
}

async function puzzleFilterCountLabel(values) {
  try {
    const est = await fetchLocalPuzzleDownloadEstimate(normalizePuzzleFilters(values))
    const n = Number(est.filteredCount ?? est.totalCount ?? 0)
    if (!n) {
      // Farm DB not indexed yet (or disabled) — Play still draws from Lichess/API when online.
      return 'Farm puzzle count unavailable — Play may still load puzzles from the network.'
    }
    if (est.hasFilters && est.matchRatio != null && est.matchRatio < 1) {
      return `About ${n.toLocaleString()} puzzles match`
    }
    return `${n.toLocaleString()} puzzles match`
  } catch {
    return 'Puzzle count unavailable — Play may still load puzzles from the network.'
  }
}

// Open the filter modal, then run `onChosen` once the player commits a selection.
// Cancelling runs `onCancel` if given, otherwise leaves the current view untouched
// (no puzzle load, no mode switch).
export function promptPuzzleFilters(onChosen, { onCancel } = {}) {
  const f = puzzleFilters || {}
  const { mount, embedded, restore } = embeddedModalMount()
  openPuzzleFilterModal({
    intro: 'Choose which puzzles to draw from. Narrow the range, pick themes, or leave it wide for any puzzle.',
    ranges: [
      {
        key: 'rating',
        label: 'Rating',
        min: PUZZLE_RATING_BOUNDS.min,
        max: PUZZLE_RATING_BOUNDS.max,
        step: PUZZLE_RATING_BOUNDS.step,
        low: f.minRating ?? PUZZLE_RATING_BOUNDS.min,
        high: f.maxRating ?? PUZZLE_RATING_BOUNDS.max,
      },
      {
        key: 'popularity',
        label: 'Popularity',
        min: PUZZLE_POPULARITY_BOUNDS.min,
        max: PUZZLE_POPULARITY_BOUNDS.max,
        step: PUZZLE_POPULARITY_BOUNDS.step,
        low: f.minPopularity ?? PUZZLE_POPULARITY_BOUNDS.min,
        high: f.maxPopularity ?? PUZZLE_POPULARITY_BOUNDS.max,
      },
    ],
    themes: {
      selected: Array.isArray(f.themes) ? f.themes : [],
      options: PUZZLE_THEME_OPTIONS,
      common: PUZZLE_COMMON_THEME_IDS,
    },
    mount,
    embedded,
    onLayoutChange: ctx.notifyWikiHeight,
    onFilterCount: puzzleFilterCountLabel,
    onSubmit: values => {
      restore?.()
      const preserved = {}
      for (const key of ['random', 'adaptive', 'tags', 'pageSlugs', 'solvedIds', 'failedIds']) {
        if (f[key] != null) preserved[key] = f[key]
      }
      puzzleFilters = { ...preserved, ...normalizePuzzleFilters(values) }
      mixedPuzzlePool =
        Boolean(embeddedPuzzleBank?.length || puzzleFilters.pageSlugs?.length) &&
        !puzzleFilters.adaptive &&
        Boolean(
          puzzleFilters.random ||
            puzzleFilters.themes?.length ||
            typeof puzzleFilters.minRating === 'number' ||
            typeof puzzleFilters.maxRating === 'number' ||
            typeof puzzleFilters.minPopularity === 'number' ||
            typeof puzzleFilters.maxPopularity === 'number',
        )
      updatePuzzleFiltersDisplay()
      onChosen?.()
    },
    onCancel: () => {
      restore?.()
      ctx.notifyWikiHeight()
      onCancel?.()
    },
  })
}

// chess.js marks K vs K (and K+minor vs K) as game-over draws. Academy teach boards
// often use those positions so learners can practice a single piece move — still allow
// puzzle input when the only terminal reason is insufficient material.
export function isInsufficientMaterialSoftDraw(chess) {
  if (!chess?.gameOver?.()) return false
  if (chess.inCheckmate?.() || chess.inStalemate?.()) return false
  return Boolean(chess.insufficientMaterial?.())
}

// Patch a puzzle/author ChessConsole so soft-draw positions still accept plies.
function installPuzzleInsufficientMaterialPlay(chessConsole) {
  if (!chessConsole || chessConsole._wikiInsufficientMaterialPlay) return
  chessConsole._wikiInsufficientMaterialPlay = true

  const softDraw = () => isInsufficientMaterialSoftDraw(chessConsole.state.chess)

  const origPlayerToMove = chessConsole.playerToMove.bind(chessConsole)
  chessConsole.playerToMove = function wikiPlayerToMove() {
    if (softDraw()) {
      return this.state.chess.turn() === 'w' ? this.playerWhite() : this.playerBlack()
    }
    return origPlayerToMove()
  }

  const human = chessConsole.player
  const origMoveRequest = human.moveRequest.bind(human)
  human.moveRequest = function wikiMoveRequest(fen, moveResponse) {
    const chess = this.chessConsole.state.chess
    if (chess.gameOver() && !softDraw()) return
    if (softDraw()) {
      this.premoveManager?.initContextMenu?.()
      const chessboard = this.chessConsole.components?.board?.chessboard
      if (chessboard && !chessboard.isMoveInputEnabled()) {
        const color = chess.turn() === 'w' ? 'w' : 'b'
        chessboard.enableMoveInput(event => this.chessboardMoveInputCallback(event, moveResponse), color)
      }
      return
    }
    return origMoveRequest(fen, moveResponse)
  }

  const origHandleMoveResponse = chessConsole.handleMoveResponse.bind(chessConsole)
  chessConsole.handleMoveResponse = function wikiHandleMoveResponse(move) {
    const result = origHandleMoveResponse(move)
    // Upstream treats insufficient-material as terminal and skips nextMove; keep the
    // turn loop alive so teach one-movers, coach undos, and multi-ply soft draws work.
    if (result && softDraw()) this.nextMove()
    return result
  }
}

// Scripted opponent: replays the puzzle line, one move per request.
class PuzzlePlayer extends ChessConsolePlayer {
  constructor(chessConsole, name, props = {}) {
    super(chessConsole, name)
    this._queue = props.firstMove ? [props.firstMove] : []
    this._delay = props.delay ?? 320
  }
  reset(firstMove) {
    this._queue = firstMove ? [firstMove] : []
  }
  enqueue(uci) {
    if (uci) this._queue.push(uci)
  }
  moveRequest(fen, moveResponse) {
    const uci = this._queue.shift()
    if (!uci) return // nothing scripted (solved, failed, or waiting on the human)
    window.setTimeout(() => moveResponse(uciToMove(uci)), this._delay)
  }
}

function uciToMove(uci) {
  const s = String(uci || '')
  const move = { from: s.slice(0, 2), to: s.slice(2, 4) }
  if (s.length > 4) move.promotion = s.slice(4, 5).toLowerCase()
  return move
}

function puzzleSetupPgn(fen) {
  // cm-pgn's parser rejects a lone "*" result when there are no moves, so the
  // movetext is left empty — the FEN headers alone set up the position.
  return `[SetUp "1"]\n[FEN "${fen}"]\n\n`
}

// PGN with the scripted setup move already played — lands on the human's turn in one
// board draw instead of pre-setup FEN then a second redraw when the opponent moves.
export function puzzleStartPgn(puzzle) {
  puzzle = normalizePuzzlePlayModel(puzzle) || puzzle
  const fen = puzzle?.fen
  if (!fen) throw new Error('puzzleStartPgn: invalid puzzle')
  if (puzzle?.teach || puzzle?.noSetup || !puzzle?.moves?.[0]) {
    return puzzleSetupPgn(fen)
  }
  const setupUci = puzzle.moves[0]
  const chess = new Chess({ fen })
  const result = chess.move(uciToMove(setupUci))
  if (!result?.san) throw new Error('puzzleStartPgn: invalid setup move')
  return buildPuzzleReplayPgn(fen, [result.san])
}

function initPuzzleBoard(puzzle, solver) {
  const chessConsole = ctx.chessConsole
  const board = chessConsole?.components?.board
  if (board) {
    board._suppressPositionUpdates = true
    // Drop any pending animated redraw from the previous puzzle before we swap.
    clearTimeout(board.setPositionOfPlyViewedDebounced)
    board._revealLastMoveGen = (board._revealLastMoveGen || 0) + 1
  }
  try {
    chessConsole.opponent.reset()
    chessConsole.initGame({ pgn: puzzleStartPgn(puzzle), playerColor: solver.playerColor }, true)
  } finally {
    if (board) board._suppressPositionUpdates = false
  }
  // Face the solver before the setup-move reveal so a black-to-play puzzle does not
  // flip mid-animation. Then snap to the pre-setup ply and animate the opponent's
  // last move (so visitors see e.g. the pawn double-step that enables en passant).
  orientPuzzleBoard(solver.playerColor)
  if (typeof board?.revealLastMoveAnimated === 'function') {
    void board.revealLastMoveAnimated()
    return
  }
  // Fallback: snap instantly (no debounce) so the previous puzzle's pieces do not
  // morph into the next — that multi-piece animation reads as the whole board shaking.
  const fen = chessConsole.state.chess.fenOfPly(chessConsole.state.plyViewed)
  const chessboard = board?.chessboard
  if (chessboard && fen) {
    clearTimeout(board.setPositionOfPlyViewedDebounced)
    void chessboard.setPosition(fen, false)
  } else {
    board?.setPositionOfPlyViewed(false)
  }
  board?.markLastMove?.()
}

// # Puzzle Sources
// Tier 2: wiki farm shared server database (same-origin /plugin/chess/puzzle).
// Tier 1: Lichess puzzle API when online.

// Convert a Lichess puzzle-API response into our internal puzzle shape, which is
// identical to a CSV row: { fen (before the setup move), moves: [setup, …solution] }.
// The API gives the game as SAN plus `initialPly`; replaying to that ply yields the
// position, and the game's next (and last) recorded move is the setup move.
function adaptLichessApiPuzzle(json) {
  const puzzle = json?.puzzle
  const game = json?.game
  if (!puzzle || !game || !Array.isArray(puzzle.solution) || !puzzle.solution.length) return null
  let moves
  try {
    moves = new Pgn(sanLineToMovetext(game.pgn), { sloppy: true }).history.moves
  } catch {
    return null
  }
  const ply = Number(puzzle.initialPly)
  if (!moves.length || !Number.isInteger(ply) || ply < 0 || ply >= moves.length) return null
  const setup = moves[ply]
  if (!setup?.from || !setup?.to) return null
  const fen = ply >= 1 ? moves[ply - 1].fen : START_FEN
  if (!fen) return null
  const setupUci = `${setup.from}${setup.to}${setup.promotion || ''}`.toLowerCase()
  return {
    id: puzzle.id || `lichess-${Date.now().toString(36)}`,
    fen,
    moves: [setupUci, ...puzzle.solution.map(m => String(m).toLowerCase())],
    rating: Number(puzzle.rating) || 0,
    themes: Array.isArray(puzzle.themes) ? puzzle.themes : [],
    gameUrl: game.id ? `https://lichess.org/${game.id}` : '',
    source: 'lichess-api',
  }
}

async function fetchFarmPuzzle(filters = {}) {
  // Wiki iframe, popup, and installed PWA: same-origin farm route when the farm has
  // chess.puzzleDatabase enabled. Non-PWA standalone tabs skip farm.
  if (!canUseFarmPuzzles()) return null
  try {
    const params = new URLSearchParams()
    if (filters.themes?.length) params.set('themes', filters.themes.join(','))
    if (typeof filters.minRating === 'number') params.set('minRating', String(filters.minRating))
    if (typeof filters.maxRating === 'number') params.set('maxRating', String(filters.maxRating))
    if (typeof filters.minPopularity === 'number') params.set('minPopularity', String(filters.minPopularity))
    if (typeof filters.maxPopularity === 'number') params.set('maxPopularity', String(filters.maxPopularity))
    const qs = params.toString()
    const res = await fetchPuzzleJson(`/plugin/chess/puzzle${qs ? `?${qs}` : ''}`, {
      cache: 'no-store',
    })
    if (!res?.ok) return null
    const data = await res.json()
    if (!data?.fen || !Array.isArray(data.moves) || data.moves.length < 2) return null
    data.source = 'farm'
    return data
  } catch {
    return null
  }
}

async function fetchApiPuzzle(filters = {}) {
  try {
    const params = new URLSearchParams()
    // Lichess accepts one theme at a time via `angle`; when the item lists several
    // (e.g. themes=fork,pin) we pick the first and still accept any listed theme
    // in puzzlePassesFilters below.
    const angle = filters.angle || filters.themes?.[0]
    if (angle) params.set('angle', angle)
    if (filters.difficulty) params.set('difficulty', filters.difficulty)
    const qs = params.toString()
    const res = await fetchPuzzleJson(`https://lichess.org/api/puzzle/next${qs ? `?${qs}` : ''}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res?.ok) return null
    return adaptLichessApiPuzzle(await res.json())
  } catch {
    return null
  }
}

// Popularity exists only in the farm CSV — the Lichess API has no equivalent field.
function filtersNeedFarmPopularity(filters = {}) {
  return typeof filters.minPopularity === 'number' || typeof filters.maxPopularity === 'number'
}

// # Installed PWA Local Puzzle Database
// Separate from the wiki farm's shared server-side database. Browsers cannot fetch
// database.lichess.org (CORS), so downloads are same-origin from /plugin/chess/puzzle-database.

const LOCAL_PUZZLE_CACHE_NAME = 'wiki-chess-local-puzzles-v1'
const LOCAL_PUZZLE_INDEXED_DB_NAME = 'wiki-chess-local-puzzles'
const LOCAL_PUZZLE_INDEXED_DB_STORE = 'index'
const LOCAL_PUZZLE_OPFS_CSV = 'wiki-chess-puzzles.csv'
const PZSTD_SKIPPABLE_MASK = 0xfffffff0
const PZSTD_SKIPPABLE_MAGIC = 0x184d2a50

function localPuzzleDownloadUrl({ filters = null, scoped = false } = {}) {
  const url = new URL('/plugin/chess/puzzle-database', location.origin)
  if (scoped && filters) puzzleFiltersToSearchParams(filters, url.searchParams)
  return url.href
}

function localPuzzleDownloadEstimateUrl(filters = {}) {
  const url = new URL('/plugin/chess/puzzle-database/estimate', location.origin)
  puzzleFiltersToSearchParams(filters, url.searchParams)
  return url.href
}

export function isLocalPuzzleDownloadOptIn() {
  return Boolean(ctx?.localPuzzleDownloadEnabled?.())
}

export function setLocalPuzzleDownloadOptIn(enabled) {
  ctx?.setLocalPuzzleDownloadEnabled?.(Boolean(enabled))
}

// In-memory mirror of IDB `status` — sync reads for UI; writes flush to IndexedDB.
let localPuzzleStatusMemory = { status: 'idle' }
let localPuzzleMetaReady = null

function readLocalPuzzleStatus() {
  return localPuzzleStatusMemory && typeof localPuzzleStatusMemory === 'object'
    ? localPuzzleStatusMemory
    : { status: 'idle' }
}

function writeLocalPuzzleStatus(status) {
  localPuzzleStatusMemory = status && typeof status === 'object' ? { ...status } : { status: 'idle' }
  void persistLocalPuzzleStatus(localPuzzleStatusMemory)
  syncLocalPuzzleDownloadUnloadGuard()
}

function getLocalPuzzleDownloadStatus() {
  return readLocalPuzzleStatus()
}

function localPuzzleDownloadReady() {
  return readLocalPuzzleStatus().status === 'ready'
}

let localPuzzleDownloadUnloadWired = false

function onLocalPuzzleDownloadBeforeUnload(event) {
  if (!isLocalPuzzleDownloadInProgress()) return
  event.preventDefault()
  event.returnValue = ''
}

function syncLocalPuzzleDownloadUnloadGuard() {
  const needed = isLocalPuzzleDownloadInProgress()
  if (needed && !localPuzzleDownloadUnloadWired) {
    window.addEventListener('beforeunload', onLocalPuzzleDownloadBeforeUnload)
    localPuzzleDownloadUnloadWired = true
    return
  }
  if (!needed && localPuzzleDownloadUnloadWired) {
    window.removeEventListener('beforeunload', onLocalPuzzleDownloadBeforeUnload)
    localPuzzleDownloadUnloadWired = false
  }
}

let activeLocalPuzzleDownload = null
let localPuzzleIndexCacheUrl = null

function pzstdNextFrameSize(buffer, offset = 0) {
  if (buffer.length - offset < 12) return null
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 12)
  const magic = view.getUint32(0, true)
  if ((magic & PZSTD_SKIPPABLE_MASK) !== PZSTD_SKIPPABLE_MAGIC) return null
  return view.getUint32(8, true)
}

function indexLineBytes(chunk, baseOffset, offsets, state) {
  for (let i = 0; i < chunk.length; i++) {
    if (state.atLineStart) {
      offsets.push(baseOffset + i)
      state.atLineStart = false
    }
    if (chunk[i] === 10) state.atLineStart = true
  }
}

function openLocalPuzzleIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const req = indexedDB.open(LOCAL_PUZZLE_INDEXED_DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LOCAL_PUZZLE_INDEXED_DB_STORE)) {
        req.result.createObjectStore(LOCAL_PUZZLE_INDEXED_DB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function indexedDbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function persistLocalPuzzleStatus(status) {
  try {
    const db = await openLocalPuzzleIdb()
    if (!db) return
    const tx = db.transaction(LOCAL_PUZZLE_INDEXED_DB_STORE, 'readwrite')
    tx.objectStore(LOCAL_PUZZLE_INDEXED_DB_STORE).put(status, 'status')
    await indexedDbTxDone(tx)
  } catch {
    /* IndexedDB may be unavailable */
  }
}

async function ensureLocalPuzzleMetaLoaded() {
  if (localPuzzleMetaReady) return localPuzzleMetaReady
  localPuzzleMetaReady = (async () => {
    try {
      const db = await openLocalPuzzleIdb()
      if (!db) return
      const tx = db.transaction(LOCAL_PUZZLE_INDEXED_DB_STORE, 'readonly')
      const store = tx.objectStore(LOCAL_PUZZLE_INDEXED_DB_STORE)
      const status = await new Promise((resolve, reject) => {
        const req = store.get('status')
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
      const cacheUrl = await new Promise((resolve, reject) => {
        const req = store.get('cacheUrl')
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
      await indexedDbTxDone(tx)
      if (status && typeof status === 'object') localPuzzleStatusMemory = status
      if (cacheUrl) localPuzzleIndexCacheUrl = cacheUrl
    } catch {
      /* IndexedDB may be unavailable */
    }
  })()
  return localPuzzleMetaReady
}

async function saveLocalPuzzleOffsets(offsets, cacheUrl) {
  const db = await openLocalPuzzleIdb()
  if (!db) return
  const tx = db.transaction(LOCAL_PUZZLE_INDEXED_DB_STORE, 'readwrite')
  const store = tx.objectStore(LOCAL_PUZZLE_INDEXED_DB_STORE)
  store.put(offsets, 'offsets')
  if (cacheUrl) store.put(cacheUrl, 'cacheUrl')
  store.put(localPuzzleStatusMemory, 'status')
  await indexedDbTxDone(tx)
  localPuzzleIndexCacheUrl = cacheUrl || null
}

async function loadLocalPuzzleOffsets() {
  await ensureLocalPuzzleMetaLoaded()
  const db = await openLocalPuzzleIdb()
  if (!db) return null
  const tx = db.transaction(LOCAL_PUZZLE_INDEXED_DB_STORE, 'readonly')
  const store = tx.objectStore(LOCAL_PUZZLE_INDEXED_DB_STORE)
  const offsets = await new Promise((resolve, reject) => {
    const req = store.get('offsets')
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
  const cacheUrl = await new Promise((resolve, reject) => {
    const req = store.get('cacheUrl')
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
  localPuzzleIndexCacheUrl = cacheUrl || localPuzzleIndexCacheUrl
  return offsets
}

async function clearLocalPuzzleIndex() {
  localPuzzleIndexCacheUrl = null
  localPuzzleStatusMemory = { status: 'idle' }
  try {
    const db = await openLocalPuzzleIdb()
    if (db) {
      const tx = db.transaction(LOCAL_PUZZLE_INDEXED_DB_STORE, 'readwrite')
      tx.objectStore(LOCAL_PUZZLE_INDEXED_DB_STORE).clear()
      await indexedDbTxDone(tx)
    }
  } catch {
    /* best effort */
  }
  try {
    if (typeof navigator.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory()
      await root.removeEntry(LOCAL_PUZZLE_OPFS_CSV)
    }
  } catch {
    /* file may not exist */
  }
}

async function readLineAtBlob(blob, offset) {
  let readSize = 512
  for (let attempt = 0; attempt < 6; attempt++) {
    const chunk = await blob.slice(offset, offset + readSize).text()
    const nl = chunk.indexOf('\n')
    if (nl !== -1) return chunk.slice(0, nl).replace(/\r$/, '')
    if (chunk.length < readSize) return chunk.replace(/\r$/, '')
    readSize *= 4
  }
  return null
}

async function readLineAtOpfs(offset) {
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(LOCAL_PUZZLE_OPFS_CSV)
  const blob = await handle.getFile()
  return readLineAtBlob(blob, offset)
}

async function readLocalPuzzleLine(offset) {
  if (typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory()
      await root.getFileHandle(LOCAL_PUZZLE_OPFS_CSV)
      return readLineAtOpfs(offset)
    } catch {
      /* fall through to cache */
    }
  }
  const cacheUrl = localPuzzleIndexCacheUrl
  if (!cacheUrl) return null
  const cache = await caches.open(LOCAL_PUZZLE_CACHE_NAME)
  const cached = await cache.match(cacheUrl)
  if (!cached) return null
  return readLineAtBlob(await cached.blob(), offset)
}

async function indexCsvBlob(blob, { onProgress } = {}) {
  const offsets = []
  const state = { atLineStart: true }
  if (blob.size > 40_000_000 && typeof navigator.storage?.getDirectory === 'function') {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(LOCAL_PUZZLE_OPFS_CSV, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    const reader = blob.stream().getReader()
    let filePos = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
      indexLineBytes(value, filePos, offsets, state)
      filePos += value.byteLength
    }
    await writable.close()
    return Uint32Array.from(offsets)
  }
  const text = await blob.text()
  for (let i = 0; i < text.length; i++) {
    if (state.atLineStart) {
      offsets.push(i)
      state.atLineStart = false
    }
    if (text.charCodeAt(i) === 10) state.atLineStart = true
  }
  onProgress?.()
  return Uint32Array.from(offsets)
}

async function indexZstdBlobToOpfs(blob, { onProgress } = {}) {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error(
      'This device cannot index the full puzzle archive without private file storage. Try a filtered download instead.',
    )
  }
  const { decompress } = await import('fzstd')
  const buffer = new Uint8Array(await blob.arrayBuffer())
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(LOCAL_PUZZLE_OPFS_CSV, { create: true })
  const writable = await handle.createWritable({ keepExistingData: false })
  const offsets = []
  const state = { atLineStart: true }
  let filePos = 0
  let pos = 0
  while (pos + 12 <= buffer.length) {
    const frameSize = pzstdNextFrameSize(buffer, pos)
    if (frameSize == null) throw new Error(`unexpected pzstd frame at byte ${pos}`)
    const start = pos + 12
    if (start + frameSize > buffer.length) break
    const plain = decompress(buffer.subarray(start, start + frameSize))
    await writable.write(plain)
    indexLineBytes(plain, filePos, offsets, state)
    filePos += plain.length
    pos = start + frameSize
    const progress = Math.min(99, Math.round((pos / buffer.length) * 100))
    writeLocalPuzzleStatus({ ...getLocalPuzzleDownloadStatus(), indexProgress: progress })
    onProgress?.(getLocalPuzzleDownloadStatus())
  }
  await writable.close()
  return Uint32Array.from(offsets)
}

async function prepareLocalPuzzleIndex({ onProgress } = {}) {
  const prior = getLocalPuzzleDownloadStatus()
  if (prior.status === 'ready') return prior

  const scoped = prior.scope === 'filtered' && prior.filters
  const cacheUrl = localPuzzleDownloadUrl({ filters: prior.filters, scoped: Boolean(scoped) })
  const cache = await caches.open(LOCAL_PUZZLE_CACHE_NAME)
  const cached = await cache.match(cacheUrl)
  if (!cached) {
    writeLocalPuzzleStatus({ status: 'error', error: 'Downloaded puzzle database not found in cache.' })
    onProgress?.(getLocalPuzzleDownloadStatus())
    return getLocalPuzzleDownloadStatus()
  }

  writeLocalPuzzleStatus({
    ...prior,
    status: 'indexing',
    indexProgress: 0,
  })
  onProgress?.(getLocalPuzzleDownloadStatus())

  try {
    const blob = await cached.blob()
    const isCsv =
      prior.scope === 'filtered' || blob.type.includes('csv') || (!blob.type.includes('zstd') && prior.scope !== 'full')
    const offsets = isCsv ? await indexCsvBlob(blob, { onProgress }) : await indexZstdBlobToOpfs(blob, { onProgress })
    await saveLocalPuzzleOffsets(offsets, cacheUrl)
    const ready = {
      status: 'ready',
      scope: prior.scope || 'full',
      filters: prior.filters || null,
      puzzleCount: Math.max(0, offsets.length - 1),
      indexedAt: new Date().toISOString(),
      receivedBytes: prior.receivedBytes,
      totalBytes: prior.totalBytes,
      downloadedAt: prior.downloadedAt,
    }
    writeLocalPuzzleStatus(ready)
    onProgress?.(ready)
    return ready
  } catch (err) {
    writeLocalPuzzleStatus({
      status: 'error',
      error: String(err?.message || err),
      scope: prior.scope,
      filters: prior.filters || null,
    })
    onProgress?.(getLocalPuzzleDownloadStatus())
    throw err
  }
}

async function readLocalPuzzleDownloadError(res) {
  let msg = `download HTTP ${res.status}`
  try {
    const data = await res.clone().json()
    if (data?.error) msg = String(data.error)
  } catch {
    if (res.status === 404) {
      msg =
        'Puzzle download is not available on this wiki server yet. Restart the wiki after updating the chess plugin, then try again.'
    }
  }
  return msg
}

function friendlyLocalPuzzleDownloadError(err) {
  const msg = String(err?.message || err)
  if (msg === 'Failed to fetch') {
    return (
      'Could not reach the wiki server to download the puzzle database. ' +
      'Make sure you are online and connected to this wiki farm, then try again.'
    )
  }
  return msg
}

async function fetchLocalPuzzleDownloadEstimate(filters = {}) {
  const res = await fetch(localPuzzleDownloadEstimateUrl(filters), { cache: 'no-store' })
  if (!res.ok) throw new Error(await readLocalPuzzleDownloadError(res))
  return res.json()
}

async function startLocalPuzzleDownload({ scope = 'full', filters = null, estimatedBytes = null, onProgress } = {}) {
  if (activeLocalPuzzleDownload) return activeLocalPuzzleDownload
  if (!('caches' in globalThis)) {
    writeLocalPuzzleStatus({ status: 'error', error: 'Cache storage is not available in this browser.' })
    return null
  }

  const scoped = scope === 'filtered' && filters
  const downloadUrl = localPuzzleDownloadUrl({ filters, scoped: Boolean(scoped) })

  activeLocalPuzzleDownload = (async () => {
    writeLocalPuzzleStatus({
      status: 'downloading',
      progress: 0,
      scope,
      filters: scoped ? filters : null,
      estimatedBytes: typeof estimatedBytes === 'number' ? estimatedBytes : null,
    })
    try {
      const res = await fetch(downloadUrl, { cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(await readLocalPuzzleDownloadError(res))

      const total = Number(res.headers.get('Content-Length')) || 0
      const reader = res.body.getReader()
      const chunks = []
      let received = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        const progress =
          total > 0
            ? Math.min(100, Math.round((received / total) * 100))
            : typeof estimatedBytes === 'number' && estimatedBytes > 0
              ? Math.min(99, Math.round((received / estimatedBytes) * 100))
              : null
        writeLocalPuzzleStatus({
          status: 'downloading',
          progress,
          receivedBytes: received,
          totalBytes: total || null,
          estimatedBytes: typeof estimatedBytes === 'number' ? estimatedBytes : null,
          scope,
          filters: scoped ? filters : null,
        })
        onProgress?.(getLocalPuzzleDownloadStatus())
      }

      const contentType = res.headers.get('Content-Type') || (scoped ? 'text/csv; charset=utf-8' : 'application/zstd')
      const blob = new Blob(chunks, { type: contentType })
      const cache = await caches.open(LOCAL_PUZZLE_CACHE_NAME)
      await cache.put(downloadUrl, new Response(blob, { status: 200, statusText: 'OK' }))

      writeLocalPuzzleStatus({
        status: 'downloaded',
        receivedBytes: received,
        totalBytes: total || received,
        downloadedAt: new Date().toISOString(),
        scope,
        filters: scoped ? filters : null,
      })
      onProgress?.(getLocalPuzzleDownloadStatus())
      await prepareLocalPuzzleIndex({ onProgress })
      return getLocalPuzzleDownloadStatus()
    } catch (err) {
      writeLocalPuzzleStatus({
        status: 'error',
        error: friendlyLocalPuzzleDownloadError(err),
        scope,
        filters: scoped ? filters : null,
      })
      onProgress?.(getLocalPuzzleDownloadStatus())
      throw err
    } finally {
      activeLocalPuzzleDownload = null
    }
  })()

  return activeLocalPuzzleDownload
}

async function clearLocalPuzzleDownload() {
  activeLocalPuzzleDownload = null
  setLocalPuzzleDownloadOptIn(false)
  if ('caches' in globalThis) {
    try {
      await caches.delete(LOCAL_PUZZLE_CACHE_NAME)
    } catch {
      /* best effort */
    }
  }
  await clearLocalPuzzleIndex()
  writeLocalPuzzleStatus({ status: 'idle' })
}

function resumeLocalPuzzleDownloadIfNeeded({ onProgress } = {}) {
  void ensureLocalPuzzleMetaLoaded().then(() => {
    if (!isLocalPuzzleDownloadOptIn()) return
    const status = getLocalPuzzleDownloadStatus()
    if (status.status === 'ready') {
      void loadLocalPuzzleOffsets()
      return
    }
    if (status.status === 'downloading') {
      void startLocalPuzzleDownload({
        scope: status.scope || 'full',
        filters: status.filters || null,
        onProgress,
      })
      return
    }
    if (status.status === 'downloaded' || status.status === 'indexing') {
      void prepareLocalPuzzleIndex({ onProgress })
    }
  })
}

function localPuzzleToClient(puzzle) {
  return {
    id: puzzle.id,
    fen: puzzle.fen,
    moves: puzzle.moves,
    rating: puzzle.rating,
    popularity: puzzle.popularity,
    themes: puzzle.themes,
    gameUrl: puzzle.gameUrl,
    source: 'local',
  }
}

async function fetchLocalPuzzle(filters = {}) {
  if (!localPuzzleDownloadReady()) return null
  const offsets = await loadLocalPuzzleOffsets()
  if (!offsets?.length) return null
  const n = offsets.length
  let fallback = null
  for (let i = 0; i < 80; i++) {
    const idx = Math.floor(Math.random() * n)
    if (idx === 0 && n > 1) continue
    const line = await readLocalPuzzleLine(offsets[idx])
    const puzzle = parsePuzzleRow(line)
    if (!puzzle) continue
    fallback = puzzle
    if (!puzzleMatchesFilters(puzzle, filters)) continue
    return localPuzzleToClient(puzzle)
  }
  if (!fallback || !puzzleMatchesFilters(fallback, filters)) return null
  return localPuzzleToClient(fallback)
}

const PUZZLE_FETCH_ATTEMPTS = 2
const PUZZLE_FETCH_TIMEOUT_MS = 5000

async function fetchPuzzleJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(PUZZLE_FETCH_TIMEOUT_MS),
    })
    return res
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return null
    throw error
  }
}

function farmPuzzleClientEligible() {
  // Wiki iframe/popup and installed PWA can use the farm route when online.
  return Boolean(ctx.wikiFrame || ctx.pwaBridgeActive)
}

function canUseFarmPuzzles() {
  if (!farmPuzzleClientEligible()) return false
  // Farm operator must opt in via `chess.puzzleDatabase: true` in wiki config.json.
  return Boolean(farmDbConfig?.enabled)
}

async function ensurePuzzleConsole() {
  if (ctx.chessConsole) return ctx.chessConsole
  // A mode switch routes through resetChessApp(), which clears the shared
  // `chessConsole` but leaves the cached `puzzleConsoleReady` promise in place. Returning
  // that promise without re-adopting it would leave the module-level `chessConsole`
  // undefined, so the next loadNextPuzzle() throws inside startSolverForPuzzle() and the
  // board sticks on "Loading puzzle…". Re-assign `chessConsole` from the cached console.
  if (puzzleConsoleReady) {
    try {
      ctx.chessConsole = await puzzleConsoleReady
      return ctx.chessConsole
    } catch (error) {
      puzzleConsoleReady = null
      throw error
    }
  }
  puzzleConsoleReady = (async () => {
    await ensurePieceSpriteCached(pieceSpritesUrl())
    const container = document.getElementById('puzzle-console-container')
    if (container) container.innerHTML = ''
    // Empty names: a puzzle board has no useful "Puzzle"/"You" labels (the CSS also
    // hides the player rows, but blank names guarantee no text even on a stale cache).
    const human = { type: LocalPlayer, name: '', props: {} }
    const opponent = { type: PuzzlePlayer, name: '', props: {} }
    ctx.chessConsole = new ChessConsole(container, human, opponent, {
      figures: createStauntyFigures(pieceSpritesUrl(), 18),
      // Minimal single-column template — no history/captured/control columns.
      template:
        '<div class="chess-console wiki-puzzle-console">' +
        '<div class="chess-console-center"><div class="chess-console-board"></div>' +
        '<div class="chess-console-notifications"></div></div></div>',
    })
    installPuzzleInsufficientMaterialPlay(ctx.chessConsole)
    // Board init syncs to chessConsole.state.chess (defaults to start); prime empty first.
    syncPuzzleConsoleEmptyBoard(ctx.chessConsole)
    await new Board(ctx.chessConsole, {
      assetsUrl: './assets/',
      assetsCache: true,
      position: FEN.empty,
      style: {
        cssClass: 'green',
        borderType: 'frame',
        showCoordinates: true,
        pieces: { file: pieceSetFile() },
      },
    }).initialized
    new Sound(ctx.chessConsole, { soundSpriteFile: './assets/sounds/chess_console_sounds.mp3' })
    ctx.patchSoundForSync(ctx.chessConsole)
    ctx.chessConsole.messageBroker.subscribe('game/move/legal', onPuzzleLegalMove)
    ctx.chessConsole.messageBroker.subscribe('game/move/illegal', onPuzzleIllegalMove)
    wirePuzzleTurnPrompt(ctx.chessConsole)
    refitBoardForContext(ctx, { optional: true })
    return ctx.chessConsole
  })()
  return puzzleConsoleReady
}

function onPuzzleLegalMove(data) {
  if (!puzzleSolver || !ctx.chessConsole) return
  if (data.playerMoved !== ctx.chessConsole.player) return // only judge the human's moves
  const mr = data.moveResult || {}
  const uci = `${mr.from}${mr.to}${mr.promotion || ''}`
  const isCheckmate = ctx.chessConsole.state.chess.inCheckmate()
  const result = puzzleSolver.submitMove(uci, { isCheckmate })
  if (result.status !== 'ignored') {
    updatePuzzleControlVisibility()
  }
  if (result.status === 'coach') {
    puzzleCoachActive = true
    updatePuzzleStatus('coach', result.message)
    updatePuzzleControlVisibility()
    try {
      ctx.chessConsole.state.chess.undo()
      // handleMoveResponse already bumped plyViewed with the rejected ply — sync so
      // LocalPlayer’s first re-enable click does not only “jump to live” and no-op.
      ctx.chessConsole.state.plyViewed = ctx.chessConsole.state.chess.plyCount()
      const board = ctx.chessConsole.components?.board
      const fen = ctx.chessConsole.state.chess.fenOfPly(ctx.chessConsole.state.plyViewed)
      if (board?.chessboard && fen) void board.chessboard.setPosition(fen, false)
      board?.markLastMove?.()
      // Ask LocalPlayer for another move — coach undoes the ply without advancing the turn loop.
      ctx.chessConsole.nextMove?.()
    } catch {
      // Board may already match; coaching text still explains the try.
    }
    return
  }
  if (result.status === 'continue' || result.status === 'solved') {
    puzzleCoachActive = false
  }
  if (result.status === 'continue') {
    ctx.chessConsole.opponent.enqueue(result.opponentMove)
    updatePuzzleStatus('continue', result.message)
  } else if (result.status === 'solved') {
    updatePuzzleStatus('solved', result.message)
    if (isAdaptiveCoachMode()) {
      lockPuzzleBoardInput()
      persistAdaptivePuzzleOutcome('solved')
    } else {
      markLessonProgressOnSolve()
    }
    void renderPuzzleNextGuide(document.getElementById('puzzle-status'))
  } else if (result.status === 'wrong') {
    updatePuzzleStatus('wrong', result.message)
    if (isAdaptiveCoachMode()) {
      lockPuzzleBoardInput()
      persistAdaptivePuzzleOutcome('failed')
    }
  }
}

// Adaptive coach: dropping onto an illegal square is a logged failure (browser-local only).
function onPuzzleIllegalMove(data) {
  if (!isAdaptiveCoachMode() || !puzzleSolver || !ctx.chessConsole) return
  if (puzzleSolver.solved || puzzleSolver.failed) return
  if (data?.playerMoved && data.playerMoved !== ctx.chessConsole.player) return
  const move = data?.move || {}
  const from = String(move.from || '').trim()
  const to = String(move.to || '').trim()
  // Require a real drop (from→to). Selecting a piece with no moves only has `from`.
  if (!from || !to || from === to) return
  const result = puzzleSolver.failIllegal?.()
  if (!result || result.status === 'ignored') return
  updatePuzzleControlVisibility()
  lockPuzzleBoardInput()
  updatePuzzleStatus('wrong', result.message)
  persistAdaptivePuzzleOutcome('failed', { reason: 'illegal' })
}

// Read an item-embedded puzzle bank ("PUZZLE\n<CSV|JSONL…>") out of the resolved
// state, or null when the item is a bare PUZZLE keyword (draws from farm/API).
function loadEmbeddedPuzzleBank(state) {
  const text = state?.chessState || ''
  if (!text) return null
  const parsed = parseChessItem(text)
  if (parsed.mode !== 'PUZZLE' || !parsed.content) return null
  const teach = parseTeachPuzzleFromPgn(parsed.content)
  if (teach) return { puzzles: [teach], filters: {} }
  return parsePuzzleBankContent(parsed.content)
}

function puzzleSpecEnablesNetworkPool(spec = {}) {
  if (spec.adaptive) return false
  const f = spec.filters || {}
  return Boolean(
    spec.random ||
      f.themes?.length ||
      typeof f.minRating === 'number' ||
      typeof f.maxRating === 'number' ||
      typeof f.minPopularity === 'number' ||
      typeof f.maxPopularity === 'number',
  )
}

export function receivePuzzlePagesData(data = {}) {
  const requestId = String(data.requestId || '')
  const pending = pendingPuzzlePageRequests.get(requestId)
  if (!pending) return false
  pendingPuzzlePageRequests.delete(requestId)
  window.clearTimeout(pending.timer)
  pending.resolve(Array.isArray(data.pages) ? data.pages : [])
  return true
}

function requestPuzzlePages(pageSlugs = []) {
  const slugs = [...new Set((Array.isArray(pageSlugs) ? pageSlugs : []).filter(Boolean))]
  const wiki = shellMessengerFromContext(ctx)
  if (!slugs.length || !wiki?.fetchPuzzlePages) return Promise.resolve([])
  const requestId = `puzzle-pages-${Date.now().toString(36)}-${++puzzlePageRequestSeq}`
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      pendingPuzzlePageRequests.delete(requestId)
      resolve([])
    }, 5000)
    pendingPuzzlePageRequests.set(requestId, { resolve, timer })
    wiki.fetchPuzzlePages({ requestId, slugs })
  })
}

async function addReferencedPuzzlePages(pageSlugs = []) {
  const pages = await requestPuzzlePages(pageSlugs)
  const referenced = puzzlesFromReferencedPages(pages)
  if (!referenced.length) return
  const existing = Array.isArray(embeddedPuzzleBank) ? embeddedPuzzleBank : []
  const seen = new Set(existing.map(p => `${p.id || ''}\n${p.fen || ''}\n${(p.moves || []).join(' ')}`))
  for (const puzzle of referenced) {
    const key = `${puzzle.id || ''}\n${puzzle.fen || ''}\n${(puzzle.moves || []).join(' ')}`
    if (seen.has(key)) continue
    seen.add(key)
    existing.push(puzzle)
  }
  embeddedPuzzleBank = existing
  if (!embeddedPuzzle) {
    embeddedPuzzle =
      existing.find(puzzle => puzzleMatchesFilters(puzzle, activePuzzleFilters())) ||
      (mixedPuzzlePool ? null : existing[0])
  }
}

function parseEmbeddedPuzzle(state) {
  const bank = loadEmbeddedPuzzleBank(state)
  if (!bank?.puzzles?.length) return null
  embeddedPuzzleBank = bank.puzzles
  if (bank.filters && Object.keys(bank.filters).length && puzzleFilters === null) {
    puzzleFilters = { ...bank.filters }
    if (bank.filters.adaptive) puzzleFilters.adaptive = true
  }
  const filters = bank.filters || {}
  const firstMatch = bank.puzzles.find(puzzle => puzzleMatchesFilters(puzzle, filters))
  const networkEnabled = puzzleSpecEnablesNetworkPool({
    random: Boolean(filters.random),
    adaptive: Boolean(filters.adaptive),
    filters,
  })
  return firstMatch || (networkEnabled ? null : bank.puzzles[0])
}

// The RANDOM modifier + any item-specified filters from a bare "PUZZLE" item, e.g.
// "PUZZLE RANDOM rating=1500..2000". Defaults (bare "PUZZLE") to { random: false }.
function puzzleSpecFromState(state) {
  const parsed = parseChessItem(state?.chessState || '')
  if (parsed.mode !== 'PUZZLE') return { random: false, filters: {} }
  return parsePuzzleSpec(parsed.content)
}

// True when a PUZZLE item already carries a saved selection — the RANDOM marker
// and/or one or more filter tokens. Such an item draws straight away instead of
// opening the chooser; only a truly bare "PUZZLE" prompts.
function specHasSavedSettings(spec) {
  return Boolean(spec?.random) || Boolean(spec?.adaptive) || Object.keys(spec?.filters || {}).length > 0
}

// Write the active filter selection back into the item text ("PUZZLE rating=…",
// or "PUZZLE RANDOM" when nothing is narrowed) so the choice persists across reloads
// and can be copy-pasted to other items. Adaptive coach progress (`solved=` / `failed=` /
// rating window) and lesson `done=` also land here — on the academy that becomes
// yellow Local Changes page JSON (exportable / re-importable), not a side store.
function persistPuzzleFiltersToItem() {
  const filters = { ...activePuzzleFilters() }
  if (isAdaptiveCoachMode()) filters.adaptive = true
  const prev = ctx.chessState?.chessState || ''
  // Never overwrite a teach-PGN lesson with a bare filter line — use markLessonProgress.
  if (/\[FEN\s+"/i.test(prev) || (/\[Event\s+"/i.test(prev) && /^\s*1\./m.test(prev))) return
  const text =
    embeddedPuzzleBank?.length || puzzleBankBodyText(prev)
      ? rewritePuzzleItemText(prev, filters)
      : buildPuzzleItemText(filters)
  if (String(prev).trim() === text.trim()) return
  ctx.chessState = {
    ...(ctx.chessState || {}),
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState: text,
    FEN: undefined,
    PGN: undefined,
    bareKeywordGuard: undefined,
  }
  ctx.putJournal(text)
}

function lockPuzzleBoardInput() {
  ctx.chessConsole?.components?.board?.chessboard?.disableMoveInput?.()
}

function persistAdaptivePuzzleOutcome(outcome, { reason } = {}) {
  void reason
  if (!isAdaptiveCoachMode()) return
  const id = String(puzzleSolver?.puzzle?.id || '').trim()
  if (!id) return
  puzzleFilters = recordAdaptivePuzzleOutcome(activePuzzleFilters(), outcome, id)
  persistPuzzleFiltersToItem()
  updatePuzzleFiltersDisplay()
}

function authoredNextSlug() {
  const fromFilters = String(activePuzzleFilters()?.next || '').trim().toLowerCase()
  if (fromFilters) return fromFilters
  return String(puzzleItemProgressFromText(ctx.chessState?.chessState || '').next || '')
    .trim()
    .toLowerCase()
}

function markLessonProgressOnSolve() {
  const prev = String(ctx.chessState?.chessState || '')
  if (!prev.trim()) return
  const next = authoredNextSlug()
  const text = markPuzzleItemProgress(prev, { done: true, ...(next ? { next } : {}) })
  if (text.trim() === prev.trim()) return
  const prog = puzzleItemProgressFromText(text)
  if (prog.next && puzzleFilters) puzzleFilters.next = prog.next
  if (puzzleFilters) puzzleFilters.done = true
  ctx.chessState = {
    ...(ctx.chessState || {}),
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState: text,
    FEN: undefined,
    PGN: undefined,
    bareKeywordGuard: undefined,
  }
  ctx.putJournal(text)
}

let pendingAcademyProgressRequests = new Map()
let academyProgressRequestSeq = 0
let cachedAcademyProgressBySlug = null

export function receiveLocalAcademyProgressData(data = {}) {
  const requestId = String(data.requestId || '')
  const pending = pendingAcademyProgressRequests.get(requestId)
  if (!pending) return false
  pendingAcademyProgressRequests.delete(requestId)
  window.clearTimeout(pending.timer)
  const pages = Array.isArray(data.pages) ? data.pages : []
  cachedAcademyProgressBySlug = academyProgressFromLocalPages(pages)
  pending.resolve(cachedAcademyProgressBySlug)
  return true
}

function requestLocalAcademyProgress() {
  const wiki = shellMessengerFromContext(ctx)
  if (!wiki?.fetchLocalAcademyProgress) return Promise.resolve(cachedAcademyProgressBySlug || {})
  const requestId = `academy-progress-${Date.now().toString(36)}-${++academyProgressRequestSeq}`
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      pendingAcademyProgressRequests.delete(requestId)
      resolve(cachedAcademyProgressBySlug || {})
    }, 2500)
    pendingAcademyProgressRequests.set(requestId, { resolve, timer })
    wiki.fetchLocalAcademyProgress({ requestId })
  })
}

async function resolveNextSuggestionSlug() {
  const start = authoredNextSlug()
  if (!start) return null
  const progress = await requestLocalAcademyProgress()
  return resolveSmartAcademyNext(start, progress || {}) || start
}

async function renderPuzzleNextGuide(container) {
  if (!container) return
  const existing = container.querySelector('.wiki-puzzle-next-guide')
  if (existing) existing.remove()
  const slug = await resolveNextSuggestionSlug()
  if (!slug) return
  const title =
    cachedAcademyProgressBySlug?.[slug]?.title ||
    slug
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  const guide = document.createElement('div')
  guide.className = 'wiki-puzzle-next-guide'
  guide.appendChild(document.createTextNode('Next: '))
  const a = document.createElement('a')
  a.href = '#'
  a.className = 'wiki-puzzle-concept-link'
  a.dataset.wikiTitle = title
  a.textContent = `[[${title}]]`
  a.setAttribute('title', `Open ${title} in the wiki lineup`)
  guide.appendChild(a)
  container.appendChild(guide)
}

function puzzleRowWithPrompt(row, prompt) {
  const line = String(row || '').trim()
  const text = String(prompt || '').trim()
  return text ? `${line}\n${text}` : line
}

function puzzleFromResumeRow(row, prompt) {
  const content = puzzleRowWithPrompt(row, prompt)
  return parseEmbeddedPuzzleContent(content) || parsePuzzleJsonLine(content) || parsePuzzleRow(content)
}

function buildPuzzleReplayPgn(fen, sans) {
  const moves = Array.isArray(sans) ? sans.filter(Boolean) : []
  if (!moves.length) return puzzleSetupPgn(fen)
  return `${puzzleSetupPgn(fen)}${sanLineToMovetext(moves.join(' '))}`
}

function updatePuzzleStatusFromProgress(progress) {
  if (!progress) {
    updatePuzzleStatus('turn')
    return
  }
  if (progress.status === 'solved') updatePuzzleStatus('solved')
  else if (progress.status === 'failed') updatePuzzleStatus('wrong')
  else if (puzzleSolver?.isPlayerTurn?.()) {
    const midSolve =
      typeof puzzleTotalPlayerMoves === 'number' && puzzleSolver.remainingPlayerMoves < puzzleTotalPlayerMoves
    updatePuzzleStatus(midSolve ? 'turn-continue' : 'turn')
  } else {
    updatePuzzleStatus('turn-continue')
  }
}

// Snapshot the active puzzle session so "Switch game mode" can offer Cancel.
export function capturePuzzleResumeSnapshot() {
  const chessState = ctx.chessState?.chessState
  const currentPuzzle = puzzleSolver?.puzzle
  const itemEmbedded = currentPuzzle?.source === 'embedded'
  return {
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState,
    puzzleResume: {
      filters: puzzleFilters,
      embeddedRow: itemEmbedded ? buildPuzzleRow(currentPuzzle) : null,
      prompt: currentPuzzle?.prompt || null,
      currentPuzzleRow: currentPuzzle ? buildPuzzleRow(currentPuzzle) : null,
      currentPuzzleSource: currentPuzzle?.source || null,
      progress: puzzleSolver?.exportState?.() ?? null,
      historySans: ctx.chessConsole?.state?.chess?.history?.() ?? [],
      puzzleTotalPlayerMoves,
      seenIds: [...puzzleSeenIds],
    },
  }
}

function resumeSolverForPuzzle(puzzle, resume = {}) {
  const progress = resume.progress
  puzzleSolver = createPuzzleSolver(puzzle)
  if (progress?.status && progress.status !== 'idle') puzzleSolver.importState(progress)
  else puzzleSolver.start()
  puzzleTotalPlayerMoves =
    typeof resume.puzzleTotalPlayerMoves === 'number'
      ? resume.puzzleTotalPlayerMoves
      : puzzleSolver.remainingPlayerMoves

  const historySans = Array.isArray(resume.historySans) ? resume.historySans : []
  ctx.chessConsole.components?.board?.chessboard?.disableMoveInput?.()
  if (historySans.length) {
    const board = ctx.chessConsole.components?.board
    if (board) {
      board._suppressPositionUpdates = true
      clearTimeout(board.setPositionOfPlyViewedDebounced)
      board._revealLastMoveGen = (board._revealLastMoveGen || 0) + 1
    }
    try {
      ctx.chessConsole.opponent.reset()
      ctx.chessConsole.initGame(
        { pgn: buildPuzzleReplayPgn(puzzle.fen, historySans), playerColor: puzzleSolver.playerColor },
        true,
      )
    } finally {
      if (board) board._suppressPositionUpdates = false
    }
    orientPuzzleBoard(puzzleSolver.playerColor)
    if (typeof board?.revealLastMoveAnimated === 'function') {
      void board.revealLastMoveAnimated()
    } else {
      const fen = ctx.chessConsole.state.chess.fenOfPly(ctx.chessConsole.state.plyViewed)
      if (board?.chessboard && fen) {
        clearTimeout(board.setPositionOfPlyViewedDebounced)
        void board.chessboard.setPosition(fen, false)
      } else {
        board?.setPositionOfPlyViewed(false)
      }
      board?.markLastMove?.()
    }
  } else {
    initPuzzleBoard(puzzle, puzzleSolver)
  }
  orientPuzzleBoard(puzzleSolver.playerColor)
  renderPuzzleMeta(puzzle, puzzleSolver)
  resetPuzzleReveal()
  updatePuzzleStatusFromProgress(progress)
  updatePuzzleControlVisibility()
  refitBoardForContext(ctx)
  ctx.notifyWikiHeight()
  ctx.notifyPwaPlayLayoutReady?.()
}

// Restore a puzzle session captured by capturePuzzleResumeSnapshot().
export async function resumePuzzleSession(snap) {
  const resume = snap?.puzzleResume || {}
  puzzleFilters = resume.filters ?? null
  updatePuzzleFiltersDisplay()
  puzzleSeenIds.clear()
  for (const id of resume.seenIds || []) puzzleSeenIds.add(id)

  embeddedPuzzle = null
  embeddedPuzzleBank = null
  mixedPuzzlePool = false
  preferNetworkPuzzle = false
  // Prefer item text (teach PGN / JSONL bank) over CSV round-trip from buildPuzzleRow —
  // CSV drops wrongHints/comments and historically rejected single-move teach rows.
  const bank = loadEmbeddedPuzzleBank(snap)
  if (bank?.puzzles?.length) {
    embeddedPuzzleBank = bank.puzzles
    embeddedPuzzle = bank.puzzles[0]
  } else if (resume.embeddedRow) {
    embeddedPuzzle = puzzleFromResumeRow(resume.embeddedRow, resume.prompt)
    if (embeddedPuzzle) embeddedPuzzleBank = [embeddedPuzzle]
  }
  const spec = puzzleSpecFromState(snap)
  mixedPuzzlePool =
    Boolean(embeddedPuzzleBank?.length || spec.filters?.pageSlugs?.length) && puzzleSpecEnablesNetworkPool(spec)
  await addReferencedPuzzlePages(spec.filters?.pageSlugs)

  ctx.changePage('puzzle')
  showPuzzleLoadedUi()
  try {
    await ensurePuzzleConsole()
  } catch (error) {
    console.error('Failed to resume puzzle board:', error)
    showPuzzleLoadError()
    return
  }
  wirePuzzleControls()
  await refreshFarmDbConfig()

  const puzzleRow = resume.currentPuzzleRow || resume.embeddedRow
  if (puzzleRow || embeddedPuzzle) {
    let puzzle = puzzleRow ? puzzleFromResumeRow(puzzleRow, resume.embeddedRow ? null : resume.prompt) : null
    if (embeddedPuzzleBank?.length) {
      const match = puzzle?.id ? embeddedPuzzleBank.find(p => String(p.id) === String(puzzle.id)) : null
      if (match) puzzle = match
      else if (!puzzle) puzzle = embeddedPuzzleBank[0]
    } else if (!puzzle) {
      puzzle = embeddedPuzzle
    }
    if (!puzzle) {
      console.error('Failed to resume puzzle: could not parse resume snapshot')
      showPuzzleLoadError()
      return
    }
    if (resume.embeddedRow || resume.currentPuzzleSource === 'embedded') {
      puzzle.source = 'embedded'
    } else if (resume.currentPuzzleSource) {
      puzzle.source = resume.currentPuzzleSource
    }
    resumeSolverForPuzzle(puzzle, resume)
    return
  }

  await startPuzzle()
}

export async function startPuzzle() {
  const bootKey = puzzleItemBootKey()
  if (puzzleBootPromise && puzzleBootKey === bootKey) return puzzleBootPromise
  puzzleBootKey = bootKey
  puzzleBootPromise = startPuzzleInner().finally(() => {
    if (puzzleBootKey === bootKey) {
      puzzleBootPromise = null
    }
  })
  return puzzleBootPromise
}

async function startPuzzleInner() {
  ctx.changePage('puzzle')
  embeddedPuzzle = null
  embeddedPuzzleBank = null
  mixedPuzzlePool = false
  preferNetworkPuzzle = false
  embeddedPuzzle = parseEmbeddedPuzzle(ctx.chessState)
  const spec = puzzleSpecFromState(ctx.chessState)
  if (specHasSavedSettings(spec) && puzzleFilters === null) {
    puzzleFilters = { ...spec.filters }
    if (spec.adaptive) puzzleFilters.adaptive = true
  }
  // Adaptive: lead with the easiest puzzle still inside the rating window.
  if (isAdaptiveCoachMode() && Array.isArray(embeddedPuzzleBank) && embeddedPuzzleBank.length) {
    const lead = pickFromEmbeddedBank(null)
    if (lead) embeddedPuzzle = lead
  }
  mixedPuzzlePool =
    Boolean(embeddedPuzzleBank?.length || spec.filters?.pageSlugs?.length) && puzzleSpecEnablesNetworkPool(spec)
  preferNetworkPuzzle = false
  await addReferencedPuzzlePages(spec.filters?.pageSlugs)
  // Reveal the puzzle area before building the board so cm-chessboard measures a
  // sized container (a board built while display:none renders at zero size).
  showPuzzleLoadedUi()
  ctx.ensureMountContentVisible?.('#puzzle .container-fluid')
  try {
    await ensurePuzzleConsole()
  } catch (error) {
    console.error('Failed to start puzzle board:', error)
    showPuzzleLoadError()
    return
  }
  ctx.flushGhostChessItemSyncIfReady?.()
  wirePuzzleControls()
  await refreshFarmDbConfig()
  // A bare "PUZZLE" keyword opens the filter chooser first so the player picks a
  // rating/popularity range before any puzzle is drawn. Once they commit, the chosen
  // filters are written back into the item text ("PUZZLE rating=1500..2000", or
  // "PUZZLE RANDOM" for an unfiltered pick) so the setting persists and can be
  // copy-pasted to other items. An item that already carries a spec — the RANDOM
  // marker and/or any filter tokens — skips the chooser and draws immediately,
  // adopting those filters for the session ("Edit Puzzle Filters" reopens the chooser).
  // Inline JSONL and pages= references form a curated pool; when the same first line
  // also enables a network pool, New Puzzle alternates curated and sourced draws.
  // Academy teach-PGN items (`[FEN …]` / `[Event …]`) must never open the chooser —
  // a parse failure should surface as a load error, not wipe the lesson into filters.
  if (!embeddedPuzzle) {
    const rawText = String(ctx.chessState?.chessState || '')
    const looksTeach = /\[FEN\s+"/i.test(rawText) || /\[Event\s+"/i.test(rawText) || /\[SetUp\s+"/i.test(rawText)
    if (looksTeach) {
      console.error('Teach PUZZLE item failed to parse; not opening filter chooser')
      showPuzzleLoadError()
      return
    }
    if (specHasSavedSettings(spec)) {
      updatePuzzleFiltersDisplay()
    } else if (puzzleFilters === null) {
      // A truly bare "PUZZLE": let the player choose once, persist the choice into
      // the item, then draw. Cancelling falls back to an unfiltered puzzle so the
      // board is never left empty.
      promptPuzzleFilters(
        () => {
          persistPuzzleFiltersToItem()
          updatePuzzleFiltersDisplay()
          loadNextPuzzle()
        },
        { onCancel: () => loadNextPuzzle() },
      )
      return
    }
  }
  // The source (farm / API) is resolved lazily by loadNextPuzzle so the
  // "Loading…" status shows while we reach the network.
  await loadNextPuzzle()
}

// Build the solver for `puzzle`, prime the scripted opponent, and lay it on the board.
function startSolverForPuzzle(puzzle) {
  if (!ctx.chessConsole) {
    console.error('Failed to start a puzzle: chess console is not ready')
    showPuzzleLoadError()
    return
  }
  showPuzzleLoadedUi()
  puzzleCoachActive = false
  puzzleSolver = createPuzzleSolver(puzzle).start()
  puzzleTotalPlayerMoves = puzzleSolver.remainingPlayerMoves
  renderPuzzleMeta(puzzle, puzzleSolver)
  resetPuzzleReveal()
  // initGame alone does not clear cm-chessboard move input. If input is still
  // marked enabled from a prior puzzle (retry, new puzzle, mode switch), LocalPlayer
  // skips enableMoveInput and the board stays locked with a stale callback.
  ctx.chessConsole.components?.board?.chessboard?.disableMoveInput?.()
  initPuzzleBoard(puzzle, puzzleSolver)
  updatePuzzleControlVisibility()
  // Face the board from the solver's side — a black-to-play puzzle shows black at the
  // bottom. `initGame` sets `state.orientation`, but assigning it its current value
  // won't re-fire the observer (and can leave the rendered board out of sync), so flip
  // the board explicitly.
  orientPuzzleBoard(puzzleSolver.playerColor)
  // ensurePuzzleConsole already fitted the board; re-fitting on every New Puzzle
  // races iframe height updates and jiggles the board in the wiki embed.
  ctx.notifyWikiHeight()
  ctx.notifyPwaPlayLayoutReady?.()
  // wirePuzzleTurnPrompt normally flips the status from "Loading…" to "Your turn"
  // once the scripted setup move lands; nudge it if that event was missed.
  window.setTimeout(() => {
    if (!puzzleSolver || puzzleSolver.solved || puzzleSolver.failed) return
    const statusEl = document.getElementById('puzzle-status')
    if (!statusEl?.textContent?.includes('Loading puzzle')) return
    if (puzzleSolver.isPlayerTurn?.()) updatePuzzleStatus('turn')
  }, 900)
}

// Orient the puzzle board so the solver sits at the bottom. Sets the console state
// (drives any labels/captured views) and flips the actual cm-chessboard, guarding the
// "one turn in queue" rule so a flip already enqueued by the state observer wins.
function orientPuzzleBoard(color) {
  if (!ctx.chessConsole) return
  ctx.chessConsole.state.orientation = color
  const chessboard = ctx.chessConsole.components?.board?.chessboard
  if (chessboard && !chessboard.boardTurning && chessboard.getOrientation() !== color) {
    chessboard.setOrientation(color)
  }
}

async function loadNextPuzzle() {
  const loadGeneration = ++puzzleLoadGeneration
  // Keep the source badge through the load — clearing it shifts the meta row above
  // the board and makes the board jump in the wiki iframe.
  updatePuzzleStatus('thinking') // keep "Loading…" up while we reach a source
  await showEmptyPuzzleBoard()
  if (loadGeneration !== puzzleLoadGeneration) return
  let puzzle
  let failure
  try {
    const currentId = puzzleSolver?.puzzle?.id
    if (!currentId && embeddedPuzzle) {
      // The first inline puzzle is the lesson's lead; referenced pages are appended.
      puzzle = embeddedPuzzle
      preferNetworkPuzzle = mixedPuzzlePool
    } else if (mixedPuzzlePool) {
      if (preferNetworkPuzzle) {
        const result = await resolveNextPuzzle(activePuzzleFilters())
        puzzle = result.puzzle
        failure = result.failure
        if (!puzzle) puzzle = pickFromEmbeddedBank(currentId)
      } else {
        puzzle = pickFromEmbeddedBank(currentId)
        if (!puzzle) {
          const result = await resolveNextPuzzle(activePuzzleFilters())
          puzzle = result.puzzle
          failure = result.failure
        }
      }
      if (puzzle) {
        const curated = puzzle.source === 'embedded' || puzzle.source === 'wiki-page'
        preferNetworkPuzzle = curated
        if (curated) embeddedPuzzle = puzzle
      }
    } else if (embeddedBankIsRotating()) {
      puzzle = pickFromEmbeddedBank(currentId || embeddedPuzzle?.id)
      embeddedPuzzle = puzzle
    } else if (embeddedPuzzle) {
      puzzle = embeddedPuzzle
    } else {
      const result = await resolveNextPuzzle(activePuzzleFilters())
      puzzle = result.puzzle
      failure = result.failure
    }
  } catch (error) {
    if (loadGeneration !== puzzleLoadGeneration) return
    console.error('Failed to load a puzzle:', error)
    showPuzzleLoadError()
    return
  }
  if (loadGeneration !== puzzleLoadGeneration) return
  if (!puzzle) {
    updatePuzzleStatus('unavailable')
    showPuzzleUnavailableModal(failure || 'unknown')
    return
  }
  if (puzzle.id) puzzleSeenIds.add(puzzle.id)
  try {
    startSolverForPuzzle(puzzle)
  } catch (error) {
    // Building the solver / laying the puzzle on the board must never leave the screen
    // stuck on "Loading puzzle…"; surface the error instead so the controls stay usable.
    console.error('Failed to start a puzzle:', error)
    showPuzzleLoadError()
  }
}

function showPuzzleUnavailableModal(failure) {
  const { mount, embedded, restore } = embeddedModalMount()
  const copy = puzzleUnavailableCopy(failure, {
    farmDbConfig,
    canUseFarm: canUseFarmPuzzles(),
    pwaBridgeActive: ctx.pwaBridgeActive,
    localPuzzleDownloadReady: localPuzzleDownloadReady(),
  })
  openPuzzleUnavailableModal({
    ...copy,
    mount,
    embedded,
    onLayoutChange: ctx.notifyWikiHeight,
    onEditFilters: () => {
      restore?.()
      promptPuzzleFilters(() => {
        persistPuzzleFiltersToItem()
        loadNextPuzzle()
      })
    },
    onRetry: () => {
      restore?.()
      loadNextPuzzle()
    },
    onDismiss: () => {
      restore?.()
      ctx.notifyWikiHeight()
    },
  })
}

function updatePuzzleSourceBadge(puzzle) {
  const el = document.getElementById('puzzle-source-badge')
  if (!el) return
  const itemEmbedded = puzzle?.source === 'embedded'
  const source = itemEmbedded ? 'embedded' : puzzle?.source
  const label = formatPuzzleSourceLabel(source, { itemEmbedded })
  if (!label) {
    el.hidden = true
    el.textContent = ''
    el.className = 'wiki-puzzle-source-badge'
    el.removeAttribute('aria-label')
    el.removeAttribute('title')
    return
  }
  const title = formatPuzzleSourceTitle(source, { itemEmbedded })
  el.hidden = false
  el.textContent = label
  el.className = `wiki-puzzle-source-badge ${puzzleSourceBadgeClass(source, { itemEmbedded })}`
  el.setAttribute('aria-label', `Puzzle source: ${label}`)
  if (title) el.setAttribute('title', title)
  else el.removeAttribute('title')
}

function renderPuzzleMeta(puzzle, solver) {
  const ratingEl = document.getElementById('puzzle-rating')
  if (ratingEl) ratingEl.textContent = puzzle.rating ? String(puzzle.rating) : '—'
  const themesEl = document.getElementById('puzzle-themes')
  if (themesEl) {
    if (puzzle.teach) {
      themesEl.textContent = 'lesson'
    } else {
      // Hide the specific tactical motif so it isn't a spoiler; show only neutral phase tags.
      const shown = (puzzle.themes || []).filter(t => ['opening', 'middlegame', 'endgame'].includes(t))
      themesEl.textContent = shown.length ? shown.join(', ') : 'tactics'
    }
  }
  // We deliberately don't surface a "source game" link: players shouldn't be nudged
  // out to another site mid-puzzle, and the position is already in front of them.
  const attribution = document.querySelector('#puzzle-loaded .wiki-puzzle-attribution')
  if (attribution) attribution.style.display = puzzleIsCurated(puzzle) ? 'none' : ''
  updatePuzzleSourceBadge(puzzle)
  const colorEl = document.getElementById('puzzle-color')
  if (colorEl) colorEl.textContent = solver.playerColor === 'w' ? 'White' : 'Black'
}

function renderPuzzleThemeGuideLinks(container) {
  if (!container || !isAdaptiveCoachMode()) return
  const links = academyLinksForPuzzleThemes(puzzleSolver?.puzzle?.themes || [])
  if (!links.length) return
  const guide = document.createElement('span')
  guide.className = 'wiki-puzzle-theme-guide'
  guide.appendChild(document.createTextNode(' · Study: '))
  links.forEach((link, i) => {
    if (i > 0) guide.appendChild(document.createTextNode(' '))
    const a = document.createElement('a')
    a.href = '#'
    a.className = 'wiki-puzzle-concept-link'
    a.dataset.wikiTitle = link.title
    a.textContent = `[[${link.title}]]`
    a.setAttribute('title', `Open ${link.title} in the wiki lineup`)
    guide.appendChild(a)
  })
  container.appendChild(guide)
}

function updatePuzzleStatus(state, message = '') {
  const el = document.getElementById('puzzle-status')
  if (!el) return
  el.classList.remove('wiki-puzzle-status-ok', 'wiki-puzzle-status-bad', 'wiki-puzzle-status-info')
  const color = puzzleSolver?.playerColor === 'w' ? 'White' : 'Black'
  const note = String(message || '').trim()
  const adaptive = isAdaptiveCoachMode()
  const PUZZLE_STATUS = {
    thinking: () => ({
      text: `Loading puzzle…${farmDbLoadingSuffix()}`,
      cls: 'wiki-puzzle-status-info',
    }),
    unavailable: () => ({
      text: 'Could not load a puzzle — see the dialog for details.',
      cls: 'wiki-puzzle-status-bad',
    }),
    turn: () => {
      const custom = puzzleSolver?.puzzle?.prompt
      return {
        text: custom || `Your turn — find the best move for ${color}.`,
        cls: 'wiki-puzzle-status-info',
      }
    },
    'turn-continue': () => {
      const custom = puzzleSolver?.puzzle?.prompt
      return {
        text: custom ? `✓ Correct! ${custom}` : `✓ Correct! Your move — find the best move for ${color}.`,
        cls: 'wiki-puzzle-status-ok',
      }
    },
    continue: () => ({
      text: note || 'Correct! Keep going…',
      cls: 'wiki-puzzle-status-ok',
    }),
    coach: () => ({
      text: note || 'Try another idea.',
      cls: 'wiki-puzzle-status-info',
    }),
    solved: () => ({
      text: note
        ? `✓ ${note}`
        : adaptive
          ? '✓ Solved! Progress saved on this page — New Puzzle for the next challenge.'
          : '✓ Solved! Well done.',
      cls: 'wiki-puzzle-status-ok',
    }),
    wrong: () => ({
      text:
        note ||
        (adaptive
          ? '✗ Not this time — attempt saved on this page. Use New Puzzle for the next one.'
          : '✗ This is not correct, Try again!'),
      cls: 'wiki-puzzle-status-bad',
    }),
  }
  const resolved = PUZZLE_STATUS[state]?.() || { text: '', cls: 'wiki-puzzle-status-info' }
  el.textContent = resolved.text
  el.classList.add(resolved.cls)
  if (
    adaptive &&
    (state === 'turn' ||
      state === 'turn-continue' ||
      state === 'continue' ||
      state === 'solved' ||
      state === 'wrong' ||
      state === 'coach')
  ) {
    renderPuzzleThemeGuideLinks(el)
  }
  if (state === 'solved') {
    void renderPuzzleNextGuide(el)
  }
  const nextBtn = document.getElementById('puzzleNextBtn')
  if (nextBtn) nextBtn.classList.toggle('btn-primary', state === 'solved' || state === 'wrong')
  ctx.notifyWikiHeight()
}

// Replay the solution UCI line from the solver's start position and collect SAN
// (same algebraic notation as PGN / the move list). Falls back to [] on failure.
function solutionSansForReveal(solver) {
  const puzzle = solver?.puzzle
  const fen = puzzle?.fen
  const ucis = solver?.solution
  if (!fen || !Array.isArray(ucis) || !ucis.length) return []
  try {
    const chess = new Chess({ fen })
    if (!solver.teach && puzzle.moves?.[0]) {
      if (!chess.move(uciToMove(normalizeUci(puzzle.moves[0])))) return []
    }
    const sans = []
    for (const uci of ucis) {
      const result = chess.move(uciToMove(uci))
      if (!result?.san) break
      sans.push(result.san)
    }
    return sans
  } catch {
    return []
  }
}

// Show the puzzle's solution line on demand. The failure message no longer spoils the
// answer, so this is the only place it's revealed. Prefer SAN (e.g. "Your move Bf3
// Reply Re4 Your move Bxe4"); fall back to coordinates if replay fails.
function revealPuzzleSolution() {
  const el = document.getElementById('puzzle-solution')
  if (!el || !puzzleSolver) return
  const sans = solutionSansForReveal(puzzleSolver)
  const plies = puzzleSolver.solution
    .map((uci, i) => {
      const move = sans[i] || `${uci.slice(0, 2)}–${uci.slice(2, 4)}${uci.slice(4)}`
      const role = i % 2 === 0 ? 'Your move' : 'Reply'
      return `<span class="wiki-puzzle-solution-move"><span class="wiki-puzzle-dim">${role}</span> ${escapeHtml(move)}</span>`
    })
    .join(' ')
  el.innerHTML = `<strong>Solution:</strong> ${plies}`
  el.hidden = false
  const btn = document.getElementById('puzzleRevealBtn')
  if (btn) btn.disabled = true
  ctx.notifyWikiHeight()
}

// Hide any revealed solution and re-arm the reveal button (run whenever a puzzle starts).
function resetPuzzleReveal() {
  const el = document.getElementById('puzzle-solution')
  if (el) {
    el.hidden = true
    el.textContent = ''
  }
  const btn = document.getElementById('puzzleRevealBtn')
  if (btn) btn.disabled = false
}

function canPersistPuzzle() {
  if (ctx.pwaBridgeActive) {
    return Boolean(ctx.chessState?.pageOnThisWiki || ctx.chessState?.ownerCanJournalHere)
  }
  return Boolean(ctx.wikiFrame && (ctx.chessState?.pageOnThisWiki || ctx.chessState?.ownerCanJournalHere))
}

// "New puzzle" only makes sense for the rotating puzzle pool; an item-embedded puzzle
// is a single fixed puzzle. "Save this puzzle" pins the current random puzzle to the
// item — so it's offered only for a pool puzzle on an editable item (autosave on a
// normal page, or ownerCanJournalHere on a forkable chess-item ghost).
// Show/hide a control reliably: inline display:none always wins, and clearing it +
// dropping the `hidden` attribute guarantees it shows regardless of how `[hidden]`
// and Bootstrap's `.btn` display rules order in the cascade.
function setPuzzleControlShown(el, show) {
  if (!el) return
  el.style.display = show ? '' : 'none'
  if (show) el.removeAttribute('hidden')
  else el.setAttribute('hidden', '')
}

function updatePuzzleControlVisibility() {
  const page = document.getElementById('puzzle')
  if (!page) return
  const currentCurated = puzzleIsCurated()
  const canRotate = mixedPuzzlePool || !currentCurated || embeddedBankIsRotating()
  setPuzzleControlShown(page.querySelector('#puzzleNextBtn'), canRotate)
  setPuzzleControlShown(
    page.querySelector('#puzzleEditFiltersBtn'),
    (mixedPuzzlePool || !currentCurated || embeddedBankIsRotating()) && !isAdaptiveCoachMode(),
  )
  const saveBtn = page.querySelector('#puzzleSaveBtn')
  // Adaptive coach: one attempt per draw — no silent retries that skip logging.
  // Otherwise keep Retry in the first grid slot, but only enable it after a hard fail
  // (enabled-looking Retry on a fresh board reads as "already stuck").
  const retryBtn = page.querySelector('#puzzleRetryBtn')
  const showRetry = !isAdaptiveCoachMode()
  const enableRetry = Boolean(puzzleSolver?.failed || puzzleCoachActive)
  setPuzzleControlShown(retryBtn, showRetry)
  if (retryBtn) {
    retryBtn.disabled = !enableRetry
    retryBtn.title = enableRetry
      ? 'Reset this puzzle and try again'
      : 'Retry becomes available after a failed attempt'
  }
  const canSave = canPersistPuzzle()
  const showSave = !currentCurated && (canSave || ctx.pwaBridgeActive)
  setPuzzleControlShown(saveBtn, showSave)
  if (saveBtn && showSave) {
    if (canSave) setAuthGatedButton(saveBtn, true)
    else {
      setAuthGatedButton(saveBtn, false, {
        titleWhenDisabled: ctx.pwaAuthGateTitle?.() || WIKI_AUTH_REQUIRED_TITLE,
      })
    }
  }
}

// Re-run control visibility when shell auth/ownerCanJournalHere arrives after the puzzle loads.
export function refreshPuzzleControlVisibility() {
  updatePuzzleControlVisibility()
  updatePuzzleFiltersDisplay()
  updateLocalPuzzleDownloadUI()
}

function updatePuzzleFiltersDisplay() {
  const el = document.getElementById('puzzle-filters-badge')
  if (!el) return
  if (puzzleIsCurated() && !mixedPuzzlePool) {
    el.hidden = true
    el.textContent = ''
    return
  }
  const label = formatPuzzleFiltersLabel(activePuzzleFilters())
  if (!hasActivePuzzleFilters(activePuzzleFilters()) || !label) {
    el.hidden = true
    el.textContent = ''
    el.removeAttribute('title')
    return
  }
  el.hidden = false
  el.textContent = label
  el.title = `Puzzle pool filters: ${label}`
  el.setAttribute('aria-label', `Active puzzle filters: ${label}`)
}

function formatLocalPuzzleDownloadProgressDetail(status) {
  if (typeof status.progress === 'number') return ` (${status.progress}%)`
  const received = status.receivedBytes
  if (typeof received === 'number' && received > 0) {
    const recv = formatByteSize(received).replace(/^~/, '')
    const total =
      typeof status.totalBytes === 'number' && status.totalBytes > 0
        ? formatByteSize(status.totalBytes).replace(/^~/, '')
        : typeof status.estimatedBytes === 'number' && status.estimatedBytes > 0
          ? `~${formatByteSize(status.estimatedBytes).replace(/^~/, '')}`
          : null
    return total ? ` (${recv} / ${total})` : ` (${recv})`
  }
  return ''
}

function localPuzzleDownloadProgressMessage(status) {
  if (status.status === 'downloading') {
    const detail = formatLocalPuzzleDownloadProgressDetail(status)
    const scope = status.scope === 'filtered' ? 'filtered puzzle export' : 'full puzzle database'
    if (!detail) {
      return status.scope === 'filtered'
        ? 'Scanning farm database for matching puzzles…'
        : `Starting download of ${scope}…`
    }
    return `Downloading ${scope}${detail}…`
  }
  if (status.status === 'indexing') {
    const pct = typeof status.indexProgress === 'number' ? ` (${status.indexProgress}%)` : ''
    return `Preparing offline puzzles${pct}…`
  }
  if (status.status === 'downloaded') {
    return 'Download complete — preparing offline puzzle index…'
  }
  return null
}

function setLocalPuzzleDownloadHint(hint, { loading = false, message = '' } = {}) {
  if (!hint) return
  if (!message) {
    hint.hidden = true
    hint.textContent = ''
    hint.removeAttribute('aria-busy')
    return
  }
  hint.hidden = false
  if (loading) {
    hint.setAttribute('aria-busy', 'true')
    hint.innerHTML = `<i class="fas fa-spinner fa-spin fa-fw" aria-hidden="true"></i> ${message}`
    return
  }
  hint.removeAttribute('aria-busy')
  hint.textContent = message
}

function ensureLocalPuzzleDownloadFloat() {
  let el = document.getElementById('puzzle-local-download-float')
  if (el) return el
  el = document.createElement('div')
  el.id = 'puzzle-local-download-float'
  el.className = 'wiki-puzzle-download-float'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.hidden = true
  el.innerHTML = '<p class="wiki-puzzle-download-float-msg mb-0" id="puzzle-local-download-float-msg"></p>'
  document.body.appendChild(el)
  return el
}

let localPuzzleDownloadFloatHideTimer = 0

function updateLocalPuzzleDownloadFloat(status) {
  const float = ensureLocalPuzzleDownloadFloat()
  const msg = float.querySelector('#puzzle-local-download-float-msg') || float
  if (localPuzzleDownloadFloatHideTimer) {
    window.clearTimeout(localPuzzleDownloadFloatHideTimer)
    localPuzzleDownloadFloatHideTimer = 0
  }
  const progressMessage = localPuzzleDownloadProgressMessage(status)
  if (progressMessage) {
    float.dataset.active = '1'
    float.hidden = false
    msg.setAttribute('aria-busy', 'true')
    msg.innerHTML = `<i class="fas fa-spinner fa-spin fa-fw" aria-hidden="true"></i> ${progressMessage}`
    return
  }
  if (status.status === 'ready' && float.dataset.active === '1') {
    float.dataset.active = ''
    float.hidden = false
    msg.removeAttribute('aria-busy')
    const count = status.puzzleCount
    msg.innerHTML = `<i class="fas fa-check fa-fw" aria-hidden="true"></i> ${
      count ? `${Number(count).toLocaleString()} puzzles available offline` : 'Offline puzzles ready'
    }`
    localPuzzleDownloadFloatHideTimer = window.setTimeout(() => {
      float.hidden = true
      localPuzzleDownloadFloatHideTimer = 0
    }, 4000)
    return
  }
  if (status.status === 'error' && float.dataset.active === '1') {
    float.dataset.active = ''
    float.hidden = false
    msg.removeAttribute('aria-busy')
    msg.textContent = `Download failed: ${status.error || 'unknown error'}`
    localPuzzleDownloadFloatHideTimer = window.setTimeout(() => {
      float.hidden = true
      localPuzzleDownloadFloatHideTimer = 0
    }, 6000)
    return
  }
  float.hidden = true
  msg.textContent = ''
  msg.removeAttribute('aria-busy')
}

function updateLocalPuzzleDownloadUI() {
  const status = getLocalPuzzleDownloadStatus()
  updateLocalPuzzleDownloadFloat(status)

  const wrap = document.getElementById('puzzle-offline-optin-wrap')
  const btn = document.getElementById('puzzle-local-puzzles-btn')
  const hint = document.getElementById('puzzle-local-download-hint')
  if (!wrap || !btn) return
  const show = Boolean(ctx.pwaBridgeActive)
  wrap.hidden = !show
  if (!show) return
  const ready = status.status === 'ready'
  const inProgress = ['downloading', 'indexing', 'downloaded'].includes(status.status)
  btn.textContent = ready ? 'Remove local copy' : 'Download for offline play'
  btn.className = ready
    ? 'btn btn-sm btn-outline-danger wiki-chess-action-btn'
    : 'btn btn-sm btn-outline-primary wiki-chess-action-btn'
  btn.disabled = inProgress
  btn.title = ready
    ? 'Delete the puzzle database stored on this device'
    : 'Download the Lichess puzzle database for offline play'
  if (!hint) return
  // In-progress copy lives on the cross-mode float; keep the puzzle-page hint for
  // ready/error so the Offline button still has a stable status line.
  if (inProgress) {
    setLocalPuzzleDownloadHint(hint)
    return
  }
  if (status.status === 'ready') {
    const count = status.puzzleCount
    setLocalPuzzleDownloadHint(hint, {
      message: count ? `${Number(count).toLocaleString()} puzzles available offline` : 'Offline puzzles ready',
    })
    return
  }
  if (status.status === 'error') {
    setLocalPuzzleDownloadHint(hint, {
      message: `Download failed: ${status.error || 'unknown error'}`,
    })
    return
  }
  setLocalPuzzleDownloadHint(hint)
}

function applyLocalPuzzleDownloadToggle(enabled, { scope = 'full', filters = null, estimatedBytes = null } = {}) {
  if (enabled) {
    ctx.setLocalPuzzleDownloadEnabled?.(true)
    void startLocalPuzzleDownload({
      scope,
      filters: scope === 'filtered' ? filters || activePuzzleFilters() : null,
      estimatedBytes,
      onProgress: updateLocalPuzzleDownloadUI,
    }).finally(() => updateLocalPuzzleDownloadUI())
  } else {
    void clearLocalPuzzleDownload().finally(() => updateLocalPuzzleDownloadUI())
  }
}

async function confirmLocalPuzzleDownloadToggle(wantEnabled) {
  if (!wantEnabled) {
    const copy = localPuzzleDownloadDisableCopy()
    const openModal = ctx.openEmbeddedConfirmModal
    if (typeof openModal !== 'function') {
      applyLocalPuzzleDownloadToggle(false)
      return
    }
    openModal({
      ...copy,
      cancelLabel: 'Cancel',
      onConfirm: () => applyLocalPuzzleDownloadToggle(false),
    })
    return
  }

  const filters = activePuzzleFilters()
  let estimate = null
  if (hasActivePuzzleFilters(filters)) {
    try {
      estimate = await fetchLocalPuzzleDownloadEstimate(filters)
    } catch {
      estimate = null
    }
  }
  const copy = localPuzzleDownloadModalCopy({
    downloadStatus: getLocalPuzzleDownloadStatus(),
    filters,
    estimate,
  })
  const { mount, embedded, restore } = embeddedModalMount()
  const layout = () => {
    ctx.notifyWikiHeight?.()
    ctx.requestWikiEmbedScrollIntoView?.()
  }
  openLocalPuzzleDownloadModal({
    ...copy,
    mount,
    embedded,
    onLayoutChange: layout,
    onCancel: () => restore?.(),
    onDownloadFull: () => {
      restore?.()
      applyLocalPuzzleDownloadToggle(true, {
        scope: 'full',
        estimatedBytes: estimate?.fullBytes ?? null,
      })
    },
    onDownloadFiltered: copy.filteredLabel
      ? () => {
          restore?.()
          applyLocalPuzzleDownloadToggle(true, {
            scope: 'filtered',
            filters,
            estimatedBytes: estimate?.filteredBytes ?? null,
          })
        }
      : undefined,
  })
}

function wirePuzzleControls() {
  const page = document.getElementById('puzzle')
  if (!page) return
  // Runs on every entry (not just the first) since the same page serves both kinds.
  updatePuzzleControlVisibility()
  updatePuzzleFiltersDisplay()
  updateLocalPuzzleDownloadUI()
  resumeLocalPuzzleDownloadIfNeeded({ onProgress: updateLocalPuzzleDownloadUI })
  if (page._wikiPuzzleWired) return
  page._wikiPuzzleWired = true
  // "New Puzzle" draws another puzzle with the current filters; the chooser lives on
  // its own "Edit Puzzle Filters" button so a new puzzle doesn't re-prompt every time.
  page.querySelector('#puzzleNextBtn')?.addEventListener('click', () => loadNextPuzzle())
  page.querySelector('#puzzleEditFiltersBtn')?.addEventListener('click', () =>
    promptPuzzleFilters(() => {
      persistPuzzleFiltersToItem()
      // Keep the puzzle in progress if it still satisfies the new filters; only draw
      // a fresh one when the current puzzle has fallen outside the chosen ranges.
      // (puzzleFilters is already updated to the new selection, so the default
      // activePuzzleFilters() inside puzzlePassesFilters checks against the new bounds.)
      const current = puzzleSolver?.puzzle
      if (current && puzzlePassesFilters(current)) {
        ctx.notifyWikiHeight()
        return
      }
      loadNextPuzzle()
    }),
  )
  page.querySelector('#puzzleRetryBtn')?.addEventListener('click', () => {
    // Re-play the current puzzle from the start.
    if (!puzzleSolver) return loadNextPuzzle()
    if (!puzzleIsCurated()) puzzleSeenIds.add(puzzleSolver.puzzle.id)
    startSolverForPuzzle(puzzleSolver.puzzle)
  })
  page.querySelector('#puzzleRevealBtn')?.addEventListener('click', () => revealPuzzleSolution())
  page.querySelector('#puzzleSaveBtn')?.addEventListener('click', () => saveCurrentPuzzleToItem())
  page.querySelector('#puzzleChooseModeBtn')?.addEventListener('click', () => ctx.proceedReturnToStartMenu())
  page.querySelector('#puzzle-local-puzzles-btn')?.addEventListener('click', () => {
    const ready = getLocalPuzzleDownloadStatus().status === 'ready'
    void confirmLocalPuzzleDownloadToggle(!ready)
  })
  page.querySelector('#puzzle-status')?.addEventListener('click', event => {
    const link = event.target?.closest?.('a.wiki-puzzle-concept-link')
    if (!link) return
    event.preventDefault()
    const title = String(link.dataset.wikiTitle || link.textContent || '')
      .replace(/^\[\[|\]\]$/g, '')
      .trim()
    if (!title) return
    // Federated Wiki doInternalLink asSlugs the title (same as lineup [[links]]).
    shellMessenger()?.openGamePage({ slug: title })
  })
}

// Farm puzzle-database indicator — when `chess.puzzleDatabase` is enabled in the wiki
// in the wiki config the server downloads to server/ on start; the puzzle bar shows a
// badge while installing and when puzzles are served from that shared database.
let farmDbConfig = null
let farmDbPollTimer = null

async function refreshFarmDbConfig() {
  if (!farmPuzzleClientEligible()) return
  try {
    const res = await fetchPuzzleJson('/plugin/chess/config', { cache: 'no-store' })
    if (!res?.ok) throw new Error()
    const cfg = await res.json()
    farmDbConfig = cfg.puzzleDatabase || null
  } catch {
    farmDbConfig = null
  }
  updateFarmDbBadge()
  if (farmDbPollTimer) {
    clearTimeout(farmDbPollTimer)
    farmDbPollTimer = null
  }
  if (farmDbConfig?.installing) {
    farmDbPollTimer = window.setTimeout(refreshFarmDbConfig, 4000)
  }
}

function updateFarmDbBadge() {
  const badge = document.getElementById('puzzle-farm-db-badge')
  if (!badge) return
  const db = farmDbConfig
  if (db?.enabled && db.installing) {
    badge.textContent = `Installing farm database (${db.status})`
    badge.classList.add('wiki-puzzle-farm-db-badge-busy')
    badge.hidden = false
    return
  }
  badge.hidden = true
  badge.classList.remove('wiki-puzzle-farm-db-badge-busy')
}

function farmDbLoadingSuffix() {
  if (!farmDbConfig?.installing) return ''
  return ` — farm puzzle database (${farmDbConfig.status})`
}

// Pin the random puzzle currently on the board to the item: write its Lichess CSV row
// as "PUZZLE\n<row>" so this exact puzzle (not a random one) loads from now on.
function saveCurrentPuzzleToItem() {
  const puzzle = puzzleSolver?.puzzle
  if (!puzzle || puzzleIsCurated(puzzle)) return
  const text = `PUZZLE\n${buildPuzzleRow(puzzle)}`
  embeddedPuzzle = { ...puzzle, source: 'embedded' }
  ctx.chessState = {
    ...(ctx.chessState || {}),
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState: text,
    FEN: undefined,
    PGN: undefined,
    bareKeywordGuard: undefined,
  }
  ctx.putJournal(text)
  shellMessenger()?.modeChanged({
    chessObj: { gameType: 'puzzle', mode: 'PUZZLE', format: 'PUZZLE', showStartMenu: false },
  })
  // Now embedded: drop "New puzzle" and the source/attribution, and confirm on the button.
  updatePuzzleControlVisibility()
  renderPuzzleMeta(puzzle, puzzleSolver)
  const saveBtn = document.getElementById('puzzleSaveBtn')
  if (saveBtn) {
    setPuzzleControlShown(saveBtn, true)
    saveBtn.disabled = true
    saveBtn.innerHTML = '<i class="fas fa-check fa-fw" aria-hidden="true"></i> Saved to this item'
  }
  ctx.notifyWikiHeight()
}

// Once the opponent has played the setup move it becomes the human's turn; nudge the
// status line. Driven from the move-request topic so it fires after the setup move.
function wirePuzzleTurnPrompt(chessConsole) {
  chessConsole.messageBroker.subscribe('game/moveRequest', data => {
    if (puzzleSolver && !puzzleSolver.solved && !puzzleSolver.failed) {
      if (data.playerToMove === chessConsole.player) {
        // First move of the puzzle vs. a later step (keeps the "✓ Correct" feedback up).
        const midSolve = puzzleSolver.remainingPlayerMoves < puzzleTotalPlayerMoves
        updatePuzzleStatus(midSolve ? 'turn-continue' : 'turn')
      }
    }
  })
}

function showPuzzleLoadError() {
  clearPuzzleBootCoalescing()
  document.getElementById('puzzle-loaded')?.setAttribute('hidden', '')
  document.getElementById('puzzle-load-error')?.removeAttribute('hidden')
  ctx.notifyWikiHeight()
}

// A puzzle item is restored from the `puzzle` URL param that launchPopup adds. The
// value carries the whole PUZZLE directive verbatim — a bare "PUZZLE", a
// "PUZZLE RANDOM [filters]" line, or an "PUZZLE\n<Lichess row>" — so puzzle mode
// restores exactly what the item asked for. Returns the initial state, or null when
// this isn't a puzzle.
export function puzzleStateFromUrl(extra = {}) {
  const params = new URLSearchParams(location.search)
  if (!params.has('puzzle')) return null
  const directive = (params.get('puzzle') || '').trim()
  const chessState = directive && /^PUZZLE\b/i.test(directive) ? directive : 'PUZZLE'
  return {
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState,
    showStartMenu: false,
    ...extra,
  }
}

// Embedded-modal mounting helpers (isWikiEmbedded / embeddedModalMount) live in
// ./board-layout.js, shared with the leaderboard gate modal.
