/**
 * Shared chess logic — item/PGN parsing, mode keywords, journal planning, MSG, session FSM, sync policy.
 *
 * Conceptual packages (reading map — one file by design):
 *
 *   1 · Keywords        GAME/POSITION/PUZZLE/CHOOSE/SURVEY/LEADERBOARD item modes
 *   2 · ChessRules      FEN/PGN/figurine validation + format detection (`ChessRules`)
 *   3 · Paste           clipboard capture / ghost fork meta (`Paste`)
 *   4 · PuzzlePool      filters, CSV/JSONL rows, adaptive coach
 *   5 · Journal         autosave guards, page actions, save planning (`Journal`)
 *   6 · Identity        wiki player ids, PGN tags, board labels
 *   7 · Session         app lifecycle FSM (iframe / popup / PWA)
 *   8 · MsgSync         MSG contract + pure game-sync / presence helpers
 *
 * Section markers use `// # Section Name` for IDE and GitHub navigation.
 *
 * SPDX-License-Identifier: MIT
 */

// # Stockfish Rating Constants

export const STOCKFISH_MIN_ELO = 1320
export const STOCKFISH_MAX_ELO = 3190

export const STOCKFISH_LEVEL_ELO = Object.freeze({
  1: 1320,
  2: 1420,
  3: 1520,
  4: 1620,
  5: 1710,
  6: 1810,
  7: 1910,
  8: 2010,
  9: 2110,
  10: 2210,
  11: 2300,
  12: 2400,
  13: 2500,
  14: 2600,
  15: 2700,
  16: 2800,
  17: 2890,
  18: 2990,
  19: 3090,
  20: 3190,
})

export function stockfishLevelElo(level) {
  const n = Math.max(1, Math.min(20, parseInt(String(level), 10) || 1))
  return STOCKFISH_LEVEL_ELO[n]
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// # Keywords and Item Modes

const MODE_KEYWORDS = new Set(['GAME', 'POSITION', 'PUZZLE', 'CHOOSE', 'SURVEY', 'LEADERBOARD'])

// The only survey item form: bare `SURVEY` on My Chess Games.
export const SURVEY_KIND_FULL = 'full'

export function parseSurveyKind(text) {
  const firstLine = String(text || '')
    .trim()
    .split(/\r?\n/)[0]
    ?.trim()
  if (!firstLine) return null
  const tokens = firstLine.split(/\s+/).map(t => t.toUpperCase())
  if (tokens[0] !== 'SURVEY') return null
  if (tokens.length !== 1) return null
  if (tokens.includes('RATED')) return null
  return SURVEY_KIND_FULL
}

export function isSurveyItemText(text) {
  return parseSurveyKind(text) === SURVEY_KIND_FULL
}

// The only leaderboard item form: bare `LEADERBOARD` on the Chess Leaderboards plugin page.
export const LEADERBOARD_KIND_FULL = 'full'

export function parseLeaderboardKind(text) {
  const firstLine = String(text || '')
    .trim()
    .split(/\r?\n/)[0]
    ?.trim()
  if (!firstLine) return null
  const tokens = firstLine.split(/\s+/).map(t => t.toUpperCase())
  if (tokens[0] !== 'LEADERBOARD') return null
  return LEADERBOARD_KIND_FULL
}

export function isLeaderboardItemText(text) {
  return parseLeaderboardKind(text) === LEADERBOARD_KIND_FULL
}

// Bare SURVEY / LEADERBOARD journal items — wiki embeds that must not follow popup/PWA.
export function isMaintenanceChessItemText(text) {
  return isSurveyItemText(text) || isLeaderboardItemText(text)
}

// True when restored/session state is a SURVEY or LEADERBOARD maintenance view.
export function isMaintenanceChessState(state) {
  if (!state || typeof state !== 'object') return false
  if (isMaintenanceChessItemText(state.chessState || state.PGN || '')) return true
  return (
    state.format === 'SURVEY' ||
    state.format === 'LEADERBOARD' ||
    state.gameType === 'survey' ||
    state.gameType === 'leaderboard' ||
    state.mode === 'SURVEY' ||
    state.mode === 'LEADERBOARD' ||
    state.mode === 'FULL'
  )
}

export function parseItemMode(text) {
  const first = String(text || '')
    .trim()
    .split(/\s+/)[0]
    ?.toUpperCase()
  return MODE_KEYWORDS.has(first) ? first : 'NONE'
}

export function stripModePrefix(text, mode = parseItemMode(text)) {
  if (mode === 'NONE') return String(text || '').trim()
  const trimmed = String(text || '').trim()
  const upper = trimmed.toUpperCase()
  if (upper === mode) return ''
  if (upper.startsWith(mode) && trimmed.length > mode.length && /\s/.test(trimmed.charAt(mode.length))) {
    return trimmed.slice(mode.length).trimStart()
  }
  return trimmed
}

// Patterns used to recognize a chess notation from raw chess-item text.
// Order matters in getFormat(): PGN headers/movetext are checked before figurine
// glyphs and the looser FEN "7 slashes" rule, so a tagged game or a PGN that
// carries a [FEN "..."] setup tag is not mistaken for figurine notation or bare FEN.
const FIGURINE_PIECE_GLYPH = /[\u2654-\u265F]/ // any ♔..♟ chess-piece codepoint
const PGN_HEADER_TAG = /\[[A-Za-z]\w*\s+"[^"]*"\s*\]/ // a real [Tag "value"] header
const PGN_OPENING_MOVE = /(^|\n)\s*1\.\s*[A-Za-z]/ // movetext that begins "1. e4"

export function getFormat(text) {
  const content = String(text || '').trim()
  if (!content) return 'EMPTY'

  // Prefer PGN when headers or movetext are present, even if comments or
  // annotations also contain figurine codepoints — otherwise journal glyphs and
  // other PGN-only paths mis-classify the save as FIGURINE/UNKNOWN.
  const looksLikePgn = PGN_HEADER_TAG.test(content) || PGN_OPENING_MOVE.test(content)
  if (looksLikePgn) return 'PGN'

  if (FIGURINE_PIECE_GLYPH.test(content)) return 'FIGURINE'

  // A FEN position lists 8 board ranks joined by "/", i.e. exactly 7 separators.
  const rankSeparatorCount = (content.match(/\//g) || []).length
  if (rankSeparatorCount === 7) return 'FEN'

  return 'UNKNOWN'
}

// # ChessRules Validation and Format Detection

// True when the placement field of a FEN (the eight slash-separated ranks) is well formed.
export function isValidFenPlacement(placement) {
  const ranks = String(placement || '').split('/')
  if (ranks.length !== 8) return false
  for (const rank of ranks) {
    let count = 0
    for (const ch of rank) {
      if (/[prnbqkPRNBQK]/.test(ch)) count += 1
      else if (/[1-8]/.test(ch)) count += Number.parseInt(ch, 10)
      else return false
    }
    if (count !== 8) return false
  }
  return true
}

// True when a full FEN string can be loaded as a chess position.
export function isValidFenString(fen) {
  const parts = normalizeFen(fen).split(' ')
  if (parts.length < 4) return false
  const [placement, active, castling, ep] = parts
  if (!isValidFenPlacement(placement)) return false
  if (!/^[wb]$/.test(active)) return false
  if (castling !== '-' && !/^[KQkq]+$/.test(castling)) return false
  if (ep !== '-' && !/^[a-h][36]$/.test(ep)) return false
  return true
}

// When a FEN carries an en-passant target but the scoresheet has no prior ply
// (academy teach drills often start mid-position), recover the double-step that
// created that target so the board can mark / animate it.
// EP target on rank 6 → Black just played file7→file5; rank 3 → White file2→file4.
export function lastMoveFromEnPassantTarget(fen) {
  const parts = normalizeFen(fen).split(/\s+/)
  const ep = parts[3]
  if (!ep || ep === '-' || !/^[a-h][36]$/.test(ep)) return null
  const file = ep[0]
  if (ep[1] === '6') return { from: `${file}7`, to: `${file}5`, color: 'b' }
  return { from: `${file}2`, to: `${file}4`, color: 'w' }
}

function expandFenPlacementSquares(placement) {
  let out = ''
  for (const ch of String(placement || '')) {
    if (ch === '/') continue
    if (ch >= '1' && ch <= '8') out += '.'.repeat(Number(ch))
    else out += ch
  }
  return out
}

function compressFenPlacementSquares(squares) {
  const ranks = []
  for (let r = 0; r < 8; r++) {
    let rank = ''
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const ch = squares[r * 8 + f]
      if (ch === '.') {
        empty += 1
        continue
      }
      if (empty) {
        rank += String(empty)
        empty = 0
      }
      rank += ch
    }
    if (empty) rank += String(empty)
    ranks.push(rank)
  }
  return ranks.join('/')
}

function fenSquareIndex(square) {
  const file = String(square || '').charCodeAt(0) - 97
  const rank = 8 - Number(String(square || '')[1])
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1
  return rank * 8 + file
}

// Color ('w' | 'b') of the piece on `square` in a FEN, or null when the square is
// empty or the FEN/square is malformed.
export function fenPieceColorAt(fen, square) {
  const expanded = expandFenPlacementSquares(normalizeFen(fen).split(/\s+/)[0])
  if (expanded.length !== 64) return null
  const idx = fenSquareIndex(square)
  if (idx < 0) return null
  const ch = expanded[idx]
  if (ch === '.') return null
  return ch === ch.toUpperCase() ? 'w' : 'b'
}

// FEN one ply earlier: pawn back on its starting double-step square, no EP target.
export function fenBeforeEnPassantDoubleStep(fen) {
  const move = lastMoveFromEnPassantTarget(fen)
  if (!move) return null
  const parts = normalizeFen(fen).split(/\s+/)
  if (parts.length < 4) return null
  const expanded = expandFenPlacementSquares(parts[0])
  if (expanded.length !== 64) return null
  const fromIdx = fenSquareIndex(move.from)
  const toIdx = fenSquareIndex(move.to)
  if (fromIdx < 0 || toIdx < 0) return null
  const expect = move.color === 'b' ? 'p' : 'P'
  if (expanded[toIdx] !== expect || expanded[fromIdx] !== '.') return null
  const next = expanded.split('')
  next[fromIdx] = expect
  next[toIdx] = '.'
  const castling = parts[2] || '-'
  const half = parts[4] || '0'
  const full = parts[5] || '1'
  return `${compressFenPlacementSquares(next.join(''))} ${move.color} ${castling} - ${half} ${full}`
}

// True when text looks like PGN the engine can load (headers and/or movetext).
export function isValidPgnText(text) {
  const content = String(text ?? '').trim()
  if (!content) return false
  try {
    const parts = parsePgnParts(content)
    const hasHeaders = Object.keys(parts.tags || {}).length > 0
    return hasHeaders || pgnHasMoves(content)
  } catch {
    return false
  }
}

// True when figurine notation converts to a loadable FEN.
export function isValidFigurineText(text) {
  if (!FIGURINE_PIECE_GLYPH.test(text)) return false
  try {
    return isValidFenString(figurineToFEN(text))
  } catch {
    return false
  }
}

// Whether clipboard / edited text is real chess data we can load (not just heuristics).
export function isPasteContentValid(text, detected = detectClipboardChessFormat(text)) {
  const content = String(detected?.content ?? text ?? '').trim()
  if (!content || !detected?.format) return false
  switch (detected.format) {
    case 'FEN':
      return isValidFenString(content)
    case 'FIGURINE':
      return isValidFigurineText(content)
    case 'PGN':
      return isValidPgnText(content)
    default:
      return false
  }
}

// Whether item text is safe to persist from the wiki textarea editor (keywords, specs, or loadable chess data).
export function isEditableChessItemText(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false

  const mode = parseItemMode(trimmed)
  if (mode === 'CHOOSE') return /^CHOOSE$/i.test(trimmed)
  if (mode !== 'NONE') {
    const content = stripModePrefix(trimmed, mode)
    if (!content) return true
    if (mode === 'SURVEY' || mode === 'LEADERBOARD') return true
    if (mode === 'PUZZLE') {
      if (parsePuzzleBankContent(content)) return true
      // Annotated PGN teach puzzles (comments + variations).
      if (/\[[^\]]+\]/.test(content) || /^\s*1\./m.test(content)) return true
      if (isPuzzleRow(content)) return true
      if (/\bRANDOM\b/i.test(content)) return true
      if (/rating=|popularity=|pop=|themes?=|theme=|tags?=|tag=|adaptive=|solved=|failed=|next=|done=/i.test(content)) return true
      const fmt = getFormat(content)
      return fmt === 'FEN' ? isValidFenString(content) : false
    }
    if (mode === 'POSITION') {
      return !content || (getFormat(content) === 'FEN' && isValidFenString(content))
    }
    return isPasteContentValid(content) || isPasteContentValid(trimmed)
  }

  if (/^Chess item created /i.test(trimmed)) return true
  return isPasteContentValid(trimmed)
}

// # Paste Capture and Ghost Metadata

export function detectClipboardChessFormat(rawText) {
  const text = String(rawText ?? '').trim()
  if (!text) return { format: 'EMPTY', content: '', mode: 'NONE' }

  // A pasted bare keyword (GAME/POSITION/PUZZLE/CHOOSE) falls through to UNKNOWN
  // here, so isPasteActionable() treats it as "not chess data we can load".
  return { format: getFormat(text), content: text, mode: 'NONE' }
}

// Whether pasted clipboard content can replace item text
export function isPasteActionable(detected, rawText) {
  if (!detected?.format) return false
  const text = rawText ?? detected.content ?? ''
  return isPasteContentValid(text, detected)
}

// Journal item text to store after the user confirms a paste
export function resolvePasteItemText(rawText, detected = detectClipboardChessFormat(rawText)) {
  const trimmed = String(rawText ?? '').trim()
  if (!trimmed || !isPasteContentValid(trimmed, detected)) return ''

  const { format, content } = detected
  if (format === 'FEN') return content.trim()
  if (format === 'FIGURINE') return figurineToFEN(content)
  return trimmed // PGN
}

// One-line paste confirmation copy shown in the modal
export function pasteConfirmMessage(detected) {
  if (!detected) return ''
  const { format } = detected
  if (format === 'FEN') {
    return 'You pasted FEN data. Do you want to switch to that position here?'
  }
  if (format === 'FIGURINE') {
    return 'You pasted figurine notation. Do you want to switch to that position here?'
  }
  if (format === 'PGN') {
    return 'You pasted PGN data. Do you want to switch to that game here?'
  }
  return 'Do you want to switch to the pasted content here?'
}

export function pasteApplyLabel(canPersist) {
  return canPersist ? 'Replace in this item' : 'Load in this item'
}

// Shared label for paste → fork-new-page (also on `Paste.CREATE_NEW_LABEL`).
export const PASTE_CREATE_NEW_LABEL = 'Create new page'

export function pasteCreateNewLabel(payload) {
  return payload?.actionable ? PASTE_CREATE_NEW_LABEL : ''
}

// SURVEY / LEADERBOARD plugin pages must not be overwritten by paste — only fork a ghost.
export function pasteCanReplaceCurrentItem(currentText) {
  const trimmed = String(currentText ?? '').trim()
  return !isSurveyItemText(trimmed) && !isLeaderboardItemText(trimmed)
}

// Title and chess-item text for a forkable ghost page spawned from paste.
export function buildPasteGhostMeta(payload) {
  if (!payload?.actionable || !payload?.itemText) return null
  const isPosition = payload.format === 'FEN' || payload.format === 'FIGURINE'
  return {
    title: isPosition ? 'New Chess Position' : 'New Chess Game',
    chessText: payload.itemText,
  }
}

// Build paste payload for wiki item bar and iframe paste handlers
export function createPasteCapturePayload(text, surface = 'app') {
  const trimmed = String(text ?? '').trim()
  const detected = detectClipboardChessFormat(trimmed)
  const actionable = isPasteContentValid(trimmed, detected)
  const itemText = actionable ? resolvePasteItemText(trimmed, detected) : ''
  return {
    text: trimmed,
    itemText,
    surface,
    detected,
    format: detected.format,
    capturedAt: Date.now(),
    actionable,
    message: actionable ? pasteConfirmMessage(detected) : "That doesn't look like chess data we can load.",
  }
}

// The placement / side-to-move / castling / en-passant fields of a FEN — i.e. what
// actually defines the position. The trailing half-move and full-move counters are
// dropped because the FEN editor (and other tools) often rewrite them, which would
// otherwise make an identical position look like a different paste.
export function fenPositionKey(fen) {
  return normalizeFen(fen).split(' ').slice(0, 4).join(' ')
}

// Reduce chess item text to a comparable signature so two texts that load the same
// game/position compare equal despite cosmetic differences. The mode keyword is
// stripped, and only the *content that matters* is kept:
//   - FEN / figurine → the position-defining fields (ignoring move clocks).
//   - PGN → the starting position plus the move list, NOT the headers. Player
//     names, dates, event tags and the wiki's own bookkeeping tags differ between a
//     freshly exported game and the copied item text, so comparing them too would
//     stop an otherwise-identical game from being recognised as "already loaded".
export function chessContentSignature(text) {
  const parsed = parseChessItem(text)
  const content = String(parsed.content || '').trim()
  if (!content) return ''
  try {
    if (parsed.format === 'FEN') return `FEN:${fenPositionKey(content)}`
    if (parsed.format === 'FIGURINE') return `FEN:${fenPositionKey(figurineToFEN(content))}`
    if (parsed.format === 'PGN') {
      const parts = parsePgnParts(normalizeExportPgn(formatPgn(content)))
      const setupFen = parts.tags?.FEN && !isStandardStartFen(parts.tags.FEN) ? fenPositionKey(parts.tags.FEN) : ''
      const moves = String(parts.movetext || '')
        .replace(/\s+/g, ' ')
        .trim()
      return `PGN:${setupFen}|${moves}`
    }
  } catch {
    return `RAW:${content}`
  }
  return `RAW:${content}`
}

// True when applying the pasted content would not change what's already loaded —
// i.e. the paste is a no-op the caller can acknowledge instead of "switch here".
export function pasteMatchesCurrent(payload, currentText) {
  if (!payload?.actionable) return false
  const pasted = chessContentSignature(payload.itemText || payload.text)
  if (!pasted) return false
  return pasted === chessContentSignature(currentText)
}

export function parseChessItem(rawText) {
  const mode = parseItemMode(rawText)
  const content = stripModePrefix(rawText, mode)
  const format = getFormat(content)
  const showStartMenu = mode === 'CHOOSE' || (mode === 'NONE' && (format === 'EMPTY' || format === 'UNKNOWN'))

  return { mode, content, format, showStartMenu, rawText: String(rawText || '') }
}

// ISO 8601 local date-time with numeric UTC offset (e.g. 2026-06-22T14:30:00-07:00)
export function formatLocalISO8601(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = n => String(n).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`
}

// Placeholder item text for a new chess item before the user picks a mode
export function defaultNewChessItemLabel(date = new Date()) {
  return `Chess item created ${formatLocalISO8601(date)}`
}

// # PuzzlePool Filters Rows and Adaptive Coach

// One UCI move: from-square, to-square, optional promotion piece.
const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/

// True when `text` is a single Lichess-format puzzle row (PuzzleId,FEN,Moves,…):
// a board-shaped FEN in column 2 and at least two UCI moves in column 3. This lets
// an authored "PUZZLE\n<row>" item be told apart from a bare FEN, whose 7 slashes
// would otherwise make getFormat() mis-read the whole row as a position.
export function isPuzzleRow(text) {
  const line =
    String(text || '')
      .trim()
      .split(/\r?\n/)[0] || ''
  const cols = line.split(',')
  if (cols.length < 3) return false
  if (((cols[1] || '').match(/\//g) || []).length !== 7) return false
  const moves = String(cols[2] || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return moves.length >= 2 && moves.every(m => UCI_MOVE_RE.test(m))
}

// The optional modifier that turns a bare "PUZZLE" keyword (which asks Puzzle Mode
// to show the filter chooser first) into "draw a random puzzle immediately".
const PUZZLE_RANDOM_KEYWORD = 'RANDOM'

// Parse a numeric "lo..hi" range token. Either bound may be omitted ("1500..",
// "..2000"); a single number ("1500") is read as the lower bound. The ".." form is
// used (not "-") so negative popularity values stay unambiguous (e.g. "-50..50").
// Returns { min, max } with only the present bounds set, or null if nothing parsed.
function parsePuzzleRange(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const out = {}
  if (raw.includes('..')) {
    const [loStr = '', hiStr = ''] = raw.split('..')
    const lo = Number(loStr.trim())
    const hi = Number(hiStr.trim())
    if (loStr.trim() !== '' && Number.isFinite(lo)) out.min = lo
    if (hiStr.trim() !== '' && Number.isFinite(hi)) out.max = hi
  } else {
    const n = Number(raw)
    if (Number.isFinite(n)) out.min = n
  }
  return Object.keys(out).length ? out : null
}

function normalizePuzzleIdList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
  const seen = new Set()
  const out = []
  for (const id of raw) {
    const key = String(id || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function normalizePuzzlePageList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
  const seen = new Set()
  const out = []
  for (const value of raw) {
    const slug = String(value || '')
      .trim()
      .toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out
}

export function parsePuzzleSpec(content) {
  const result = { random: false, adaptive: false, filters: {} }
  const text = String(content || '').trim()
  if (!text) return result

  // Only the first line carries RANDOM / key=value tokens; further lines are a
  // multiline puzzle bank (JSONL or CSV rows), not filter text.
  const firstLine = text.split(/\r?\n/)[0] || ''
  for (const token of firstLine.split(/\s+/)) {
    if (!result.random && token.toUpperCase() === PUZZLE_RANDOM_KEYWORD) {
      result.random = true
      result.filters.random = true
      continue
    }
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    const key = token.slice(0, eq).toLowerCase()
    const value = token.slice(eq + 1)
    if (key === 'adaptive') {
      const on = /^(1|true|yes)$/i.test(String(value || '').trim())
      result.adaptive = on
      if (on) result.filters.adaptive = true
    } else if (key === 'rating') {
      const range = parsePuzzleRange(value)
      if (range?.min != null) result.filters.minRating = range.min
      if (range?.max != null) result.filters.maxRating = range.max
    } else if (key === 'popularity' || key === 'pop') {
      const range = parsePuzzleRange(value)
      if (range?.min != null) result.filters.minPopularity = range.min
      if (range?.max != null) result.filters.maxPopularity = range.max
    } else if (key === 'themes' || key === 'theme') {
      const themes = value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
      if (themes.length) result.filters.themes = [...(result.filters.themes || []), ...themes]
    } else if (key === 'tags' || key === 'tag') {
      const tags = value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
      if (tags.length) result.filters.tags = [...(result.filters.tags || []), ...tags]
    } else if (key === 'pages' || key === 'page') {
      const pageSlugs = normalizePuzzlePageList(value)
      if (pageSlugs.length) {
        result.filters.pageSlugs = [...(result.filters.pageSlugs || []), ...pageSlugs]
      }
    } else if (key === 'solved') {
      const ids = normalizePuzzleIdList(value)
      if (ids.length) result.filters.solvedIds = ids
    } else if (key === 'failed') {
      const ids = normalizePuzzleIdList(value)
      if (ids.length) result.filters.failedIds = ids
    } else if (key === 'next') {
      const next = normalizePuzzlePageList(value)[0] || String(value || '').trim().toLowerCase()
      if (next) result.filters.next = next
    } else if (key === 'done') {
      result.filters.done = /^(1|true|yes)$/i.test(String(value || '').trim())
    }
  }
  return result
}

export function formatPuzzleSpec(filters = {}) {
  const f = filters || {}
  const tokens = []
  if (f.adaptive) tokens.push('adaptive=true')
  if (f.done) tokens.push('done=1')
  if (f.next) tokens.push(`next=${String(f.next).trim()}`)
  if (f.minRating != null || f.maxRating != null) {
    tokens.push(`rating=${f.minRating ?? ''}..${f.maxRating ?? ''}`)
  }
  if (f.minPopularity != null || f.maxPopularity != null) {
    tokens.push(`popularity=${f.minPopularity ?? ''}..${f.maxPopularity ?? ''}`)
  }
  if (Array.isArray(f.themes) && f.themes.length) {
    tokens.push(`themes=${f.themes.join(',')}`)
  }
  if (Array.isArray(f.tags) && f.tags.length) {
    tokens.push(`tags=${f.tags.join(',')}`)
  }
  const pageSlugs = normalizePuzzlePageList(f.pageSlugs)
  if (pageSlugs.length) tokens.push(`pages=${pageSlugs.join(',')}`)
  const solved = normalizePuzzleIdList(f.solvedIds)
  if (solved.length) tokens.push(`solved=${solved.join(',')}`)
  const failed = normalizePuzzleIdList(f.failedIds)
  if (failed.length) tokens.push(`failed=${failed.join(',')}`)
  return tokens.join(' ')
}

// Full PUZZLE item text for a chosen filter selection. Filters are appended after the
// keyword so they persist + copy-paste; a selection with no narrowed bounds is marked
// RANDOM so it still skips the filter chooser instead of reading as a bare "PUZZLE".
export function buildPuzzleItemText(filters = {}) {
  const spec = formatPuzzleSpec(filters)
  const prefix = filters?.random ? `PUZZLE ${PUZZLE_RANDOM_KEYWORD}` : 'PUZZLE'
  if (spec) return `${prefix} ${spec}`
  return `PUZZLE ${PUZZLE_RANDOM_KEYWORD}`
}

// Puzzle-bank body after any leading filter / adaptive spec line.
export function puzzleBankBodyText(itemText) {
  const parsed = parseChessItem(itemText)
  if (parsed.mode !== 'PUZZLE') return String(itemText || '').trim()
  const lines = String(parsed.content || '')
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  if (isPuzzleSpecLine(lines[0])) return lines.slice(1).join('\n')
  return lines.join('\n')
}

// Rewrite the PUZZLE filter line while preserving a multiline bank / teach-PGN body.
// Adaptive coach + lesson `done=` / `next=` progress live here so FedWiki Local Changes
// (yellow page JSON) can export and later restore academy progress.
export function rewritePuzzleItemText(itemText, filters = {}) {
  const body = puzzleBankBodyText(itemText)
  const head = buildPuzzleItemText(filters)
  return body ? `${head}\n${body}` : head
}

// Gentle starter window when adaptive=true has no rating= clause.
export const ADAPTIVE_COACH_DEFAULT_RATING = Object.freeze({ min: 400, max: 700 })

// Clamp and slide an adaptive coach rating window after a solve or fail.
export function scaleAdaptivePuzzleRating(filters = {}, outcome = 'solved', step = 50) {
  const f = { ...(filters || {}) }
  const fallbackMin = ADAPTIVE_COACH_DEFAULT_RATING.min
  const fallbackMax = ADAPTIVE_COACH_DEFAULT_RATING.max
  const width = Math.max(
    step,
    (typeof f.maxRating === 'number' ? f.maxRating : fallbackMax) -
      (typeof f.minRating === 'number' ? f.minRating : fallbackMin),
  )
  let min = typeof f.minRating === 'number' ? f.minRating : fallbackMin
  let max = typeof f.maxRating === 'number' ? f.maxRating : min + width
  const delta = outcome === 'solved' ? step : -step
  min += delta
  max += delta
  const lo = PUZZLE_RATING_BOUNDS.min
  const hi = PUZZLE_RATING_BOUNDS.max
  if (min < lo) {
    max += lo - min
    min = lo
  }
  if (max > hi) {
    min -= max - hi
    max = hi
  }
  if (min < lo) min = lo
  if (max - min < step) max = Math.min(hi, min + step)
  f.minRating = min
  f.maxRating = max
  return f
}

// Append a puzzle id to solved= or failed= (and remove it from the other list).
export function recordAdaptivePuzzleOutcome(filters = {}, outcome = 'solved', puzzleId) {
  const id = String(puzzleId || '').trim()
  const f = { ...(filters || {}), adaptive: true }
  if (!id) return f
  const solved = new Set(normalizePuzzleIdList(f.solvedIds))
  const failed = new Set(normalizePuzzleIdList(f.failedIds))
  if (outcome === 'solved') {
    solved.add(id)
    failed.delete(id)
  } else {
    failed.add(id)
    solved.delete(id)
  }
  f.solvedIds = [...solved]
  f.failedIds = [...failed]
  return scaleAdaptivePuzzleRating(f, outcome)
}

// Progress fields carried on a PUZZLE item's first-line spec (exportable via page JSON).
export function puzzleItemProgressFromText(itemText) {
  const parsed = parseChessItem(itemText)
  if (parsed.mode !== 'PUZZLE') {
    return { done: false, next: '', adaptive: false, solvedIds: [], failedIds: [] }
  }
  const spec = parsePuzzleSpec(parsed.content)
  const f = spec.filters || {}
  return {
    done: Boolean(f.done),
    next: String(f.next || '').trim().toLowerCase(),
    adaptive: Boolean(spec.adaptive || f.adaptive),
    minRating: typeof f.minRating === 'number' ? f.minRating : undefined,
    maxRating: typeof f.maxRating === 'number' ? f.maxRating : undefined,
    solvedIds: normalizePuzzleIdList(f.solvedIds),
    failedIds: normalizePuzzleIdList(f.failedIds),
  }
}

// Merge progress into item text without dropping teach-PGN / JSONL body lines.
export function markPuzzleItemProgress(itemText, patch = {}) {
  const parsed = parseChessItem(itemText)
  if (parsed.mode !== 'PUZZLE') return String(itemText || '')
  const spec = parsePuzzleSpec(parsed.content)
  const filters = { ...(spec.filters || {}) }
  if (spec.adaptive) filters.adaptive = true
  if (patch.done != null) filters.done = Boolean(patch.done)
  if (patch.next != null) {
    const next = String(patch.next || '').trim().toLowerCase()
    if (next) filters.next = next
    else delete filters.next
  }
  if (Array.isArray(patch.solvedIds)) filters.solvedIds = normalizePuzzleIdList(patch.solvedIds)
  if (Array.isArray(patch.failedIds)) filters.failedIds = normalizePuzzleIdList(patch.failedIds)
  if (typeof patch.minRating === 'number') filters.minRating = patch.minRating
  if (typeof patch.maxRating === 'number') filters.maxRating = patch.maxRating
  if (patch.adaptive != null) filters.adaptive = Boolean(patch.adaptive)
  return rewritePuzzleItemText(parsed.rawText || itemText, filters)
}

// Summarize Local Changes / lineup pages into per-slug academy progress.
export function academyProgressFromLocalPages(pages = []) {
  const bySlug = {}
  for (const page of Array.isArray(pages) ? pages : []) {
    const slug = String(page?.slug || '')
      .trim()
      .toLowerCase()
    if (!slug) continue
    let done = false
    let next = ''
    let adaptive = null
    for (const item of Array.isArray(page?.story) ? page.story : []) {
      if (item?.type !== 'chess') continue
      const prog = puzzleItemProgressFromText(item.text)
      if (prog.done) done = true
      if (prog.next && !next) next = prog.next
      if (prog.adaptive) {
        adaptive = {
          minRating: prog.minRating,
          maxRating: prog.maxRating,
          solvedIds: prog.solvedIds,
          failedIds: prog.failedIds,
        }
      }
    }
    bySlug[slug] = { done, next, adaptive, title: String(page?.title || '').trim() }
  }
  return bySlug
}

// Walk `next=` links, skipping pages already marked done in local page JSON.
export function resolveSmartAcademyNext(startNext, progressBySlug = {}, { maxHops = 24 } = {}) {
  let slug = String(startNext || '')
    .trim()
    .toLowerCase()
  const seen = new Set()
  for (let i = 0; i < maxHops && slug; i++) {
    if (seen.has(slug)) break
    seen.add(slug)
    const prog = progressBySlug[slug]
    if (!prog?.done) return slug
    slug = String(prog.next || '')
      .trim()
      .toLowerCase()
  }
  return slug || null
}

// Theme ids (Lichess) → Academy page titles used for [[inline wiki links]].
export const PUZZLE_THEME_ACADEMY_PAGES = Object.freeze({
  fork: 'The Fork',
  pin: 'The Pin',
  skewer: 'The Skewer',
  discoveredAttack: 'Discovered Attack',
  doubleCheck: 'Double Check',
  deflection: 'Deflection',
  attraction: 'Decoy and Attraction',
  intermezzo: 'Zwischenzug (Intermezzo)',
  clearance: 'Clearance',
  interference: 'Interference',
  trappedPiece: 'Trapped Piece',
  capturingDefender: 'Capture the Defender',
  xRayAttack: 'X-Ray Attack',
  quietMove: 'Quiet Move',
  sacrifice: 'Sacrifice',
  hangingPiece: 'Hanging Piece',
  pieceMove: 'How Pieces Move',
  advancedPawn: 'Advanced Pawn',
  attackingF2F7: 'Attacking f2 and f7',
  kingsideAttack: 'Kingside Attack',
  queensideAttack: 'Queenside Attack',
  mateIn1: 'Mate in One',
  mateIn2: 'Mate in Two',
  backRankMate: 'Back Rank Mate',
  smotheredMate: 'Smothered Mate',
  anastasiaMate: 'Anastasia’s Mate',
  arabianMate: 'Arabian Mate',
  operaMate: 'Opera Mate',
  epauletteMate: 'Epaulette Mate',
  zugzwang: 'Zugzwang',
  promotion: 'Promotion Ideas',
  enPassant: 'En Passant',
  castling: 'Castling',
  exposedKing: 'King Safety',
})

// Deduped Academy concept links for a puzzle's theme list.
export function academyLinksForPuzzleThemes(themes = []) {
  const seen = new Set()
  const out = []
  for (const raw of themes || []) {
    const id = String(raw || '').trim()
    const title = PUZZLE_THEME_ACADEMY_PAGES[id]
    if (!title || seen.has(title)) continue
    seen.add(title)
    out.push({ theme: id, title })
  }
  return out
}

export const PUZZLE_RATING_BOUNDS = { min: 400, max: 3000, step: 50 }
export const PUZZLE_POPULARITY_BOUNDS = { min: 0, max: 100, step: 5 }

// Lichess puzzle theme ids with human labels (from lila PuzzleTheme.scala).
export const PUZZLE_THEME_OPTIONS = Object.freeze([
  { id: 'mix', label: 'Healthy mix' },
  { id: 'opening', label: 'Opening' },
  { id: 'middlegame', label: 'Middlegame' },
  { id: 'endgame', label: 'Endgame' },
  { id: 'rookEndgame', label: 'Rook endgame' },
  { id: 'bishopEndgame', label: 'Bishop endgame' },
  { id: 'pawnEndgame', label: 'Pawn endgame' },
  { id: 'knightEndgame', label: 'Knight endgame' },
  { id: 'queenEndgame', label: 'Queen endgame' },
  { id: 'queenRookEndgame', label: 'Queen and rook endgame' },
  { id: 'advancedPawn', label: 'Advanced pawn' },
  { id: 'attackingF2F7', label: 'Attacking f2 or f7' },
  { id: 'capturingDefender', label: 'Capture the defender' },
  { id: 'discoveredAttack', label: 'Discovered attack' },
  { id: 'doubleCheck', label: 'Double check' },
  { id: 'exposedKing', label: 'Exposed king' },
  { id: 'fork', label: 'Fork' },
  { id: 'hangingPiece', label: 'Hanging piece' },
  { id: 'kingsideAttack', label: 'Kingside attack' },
  { id: 'pin', label: 'Pin' },
  { id: 'queensideAttack', label: 'Queenside attack' },
  { id: 'sacrifice', label: 'Sacrifice' },
  { id: 'skewer', label: 'Skewer' },
  { id: 'trappedPiece', label: 'Trapped piece' },
  { id: 'attraction', label: 'Attraction' },
  { id: 'clearance', label: 'Clearance' },
  { id: 'collinearMove', label: 'Collinear move' },
  { id: 'discoveredCheck', label: 'Discovered check' },
  { id: 'defensiveMove', label: 'Defensive move' },
  { id: 'deflection', label: 'Deflection' },
  { id: 'interference', label: 'Interference' },
  { id: 'intermezzo', label: 'Intermezzo' },
  { id: 'quietMove', label: 'Quiet move' },
  { id: 'xRayAttack', label: 'X-Ray attack' },
  { id: 'zugzwang', label: 'Zugzwang' },
  { id: 'mate', label: 'Checkmate' },
  { id: 'mateIn1', label: 'Mate in 1' },
  { id: 'mateIn2', label: 'Mate in 2' },
  { id: 'mateIn3', label: 'Mate in 3' },
  { id: 'mateIn4', label: 'Mate in 4' },
  { id: 'mateIn5', label: 'Mate in 5 or more' },
  { id: 'anastasiaMate', label: "Anastasia's mate" },
  { id: 'arabianMate', label: 'Arabian mate' },
  { id: 'backRankMate', label: 'Back rank mate' },
  { id: 'balestraMate', label: 'Balestra mate' },
  { id: 'blindSwineMate', label: 'Blind Swine mate' },
  { id: 'bodenMate', label: "Boden's mate" },
  { id: 'cornerMate', label: 'Corner mate' },
  { id: 'doubleBishopMate', label: 'Double bishop mate' },
  { id: 'dovetailMate', label: 'Dovetail mate' },
  { id: 'epauletteMate', label: 'Epaulette mate' },
  { id: 'hookMate', label: 'Hook mate' },
  { id: 'killBoxMate', label: 'Kill box mate' },
  { id: 'pillsburysMate', label: "Pillsbury's mate" },
  { id: 'morphysMate', label: "Morphy's mate" },
  { id: 'operaMate', label: 'Opera mate' },
  { id: 'swallowstailMate', label: "Swallow's tail mate" },
  { id: 'triangleMate', label: 'Triangle mate' },
  { id: 'vukovicMate', label: 'Vuković mate' },
  { id: 'smotheredMate', label: 'Smothered mate' },
  { id: 'castling', label: 'Castling' },
  { id: 'enPassant', label: 'En passant' },
  { id: 'promotion', label: 'Promotion' },
  { id: 'underPromotion', label: 'Underpromotion' },
  { id: 'equality', label: 'Equality' },
  { id: 'advantage', label: 'Advantage' },
  { id: 'crushing', label: 'Crushing' },
  { id: 'oneMove', label: 'One-move puzzle' },
  { id: 'short', label: 'Short puzzle' },
  { id: 'long', label: 'Long puzzle' },
  { id: 'veryLong', label: 'Very long puzzle' },
  { id: 'master', label: 'Master games' },
  { id: 'masterVsMaster', label: 'Master vs Master games' },
  { id: 'superGM', label: 'Super GM games' },
])

// Quick-pick theme ids shown as badges on the puzzle filter modal.
export const PUZZLE_COMMON_THEME_IDS = Object.freeze([
  'fork',
  'pin',
  'skewer',
  'discoveredAttack',
  'hangingPiece',
  'sacrifice',
  'trappedPiece',
  'deflection',
  'backRankMate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'opening',
  'middlegame',
  'endgame',
  'promotion',
  'crushing',
  'advantage',
])

const PUZZLE_THEME_BY_ID = new Map(PUZZLE_THEME_OPTIONS.map(t => [t.id, t]))
const PUZZLE_THEME_BY_LOWER = new Map(
  PUZZLE_THEME_OPTIONS.flatMap(t => [
    [t.id.toLowerCase(), t.id],
    [t.label.toLowerCase(), t.id],
  ]),
)

// Human label for a Lichess puzzle theme id (falls back to the raw id).
export function puzzleThemeLabel(id) {
  return PUZZLE_THEME_BY_ID.get(id)?.label || id
}

// Resolve typed or pasted theme text to a canonical Lichess theme id.
export function resolvePuzzleThemeKey(raw) {
  const q = String(raw || '').trim()
  if (!q) return null
  const exact = PUZZLE_THEME_BY_LOWER.get(q.toLowerCase())
  if (exact) return exact
  const lower = q.toLowerCase()
  const partial = PUZZLE_THEME_OPTIONS.find(
    t => t.id.toLowerCase().includes(lower) || t.label.toLowerCase().includes(lower),
  )
  return partial?.id || null
}

// True when the player narrowed rating, popularity, themes, or tags (not an unfiltered pool).
export function hasActivePuzzleFilters(filters = {}) {
  const f = filters || {}
  if (f.random) return true
  if (f.adaptive) return true
  if (Array.isArray(f.themes) && f.themes.length) return true
  if (Array.isArray(f.tags) && f.tags.length) return true
  if (Array.isArray(f.pageSlugs) && f.pageSlugs.length) return true
  if (Array.isArray(f.solvedIds) && f.solvedIds.length) return true
  if (Array.isArray(f.failedIds) && f.failedIds.length) return true
  if (f.next) return true
  if (f.done) return true
  return ['minRating', 'maxRating', 'minPopularity', 'maxPopularity'].some(key => typeof f[key] === 'number')
}

// Human-readable summary for the puzzle bar and download dialogs.
export function formatPuzzleFiltersLabel(filters = {}) {
  const f = filters || {}
  const parts = []
  if (typeof f.minRating === 'number' || typeof f.maxRating === 'number') {
    const lo = f.minRating ?? PUZZLE_RATING_BOUNDS.min
    const hi = f.maxRating ?? PUZZLE_RATING_BOUNDS.max
    parts.push(`Rating ${lo}–${hi}`)
  }
  if (typeof f.minPopularity === 'number' || typeof f.maxPopularity === 'number') {
    const lo = f.minPopularity ?? PUZZLE_POPULARITY_BOUNDS.min
    const hi = f.maxPopularity ?? PUZZLE_POPULARITY_BOUNDS.max
    parts.push(`Popularity ${lo}–${hi}`)
  }
  if (Array.isArray(f.themes) && f.themes.length) {
    parts.push(`Themes: ${f.themes.map(puzzleThemeLabel).join(', ')}`)
  }
  if (Array.isArray(f.tags) && f.tags.length) {
    parts.push(`Tags: ${f.tags.join(', ')}`)
  }
  return parts.join(' · ')
}

function splitPuzzleCsvTokens(value) {
  return String(value || '')
    .split(' ')
    .map(s => s.trim())
    .filter(Boolean)
}

// Parse one Lichess puzzle-database CSV row (server-safe; no DOM imports).
export function parsePuzzleRow(line) {
  const cols = String(line || '').split(',')
  if (cols.length < 8) return null
  const [id, fen, moves, rating, ratingDeviation, popularity, nbPlays, themes, gameUrl, openingTags] = cols
  const moveList = splitPuzzleCsvTokens(moves)
  // Lichess rows are setup+solution (≥2). Academy teach / one-move drills often
  // serialize a single player-first ply through popup resume (buildPuzzleRow) —
  // reject only when there are no moves at all; normalizePuzzlePlayModel marks
  // odd-length lists as noSetup/teach.
  if (!id || !fen || moveList.length < 1) return null
  return normalizePuzzlePlayModel({
    id,
    fen,
    moves: moveList,
    rating: Number(rating) || 0,
    ratingDeviation: Number(ratingDeviation) || 0,
    popularity: Number(popularity) || 0,
    nbPlays: Number(nbPlays) || 0,
    themes: splitPuzzleCsvTokens(themes),
    gameUrl: gameUrl || '',
    openingTags: splitPuzzleCsvTokens(openingTags),
  })
}

function normalizePuzzleTagList(value) {
  if (Array.isArray(value)) {
    return value.map(t => String(t || '').trim()).filter(Boolean)
  }
  return String(value || '')
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean)
}

// Combined theme + arbitrary tags on a puzzle (for `tags=` filter matching).
export function puzzleTagList(puzzle) {
  if (!puzzle) return []
  const tags = normalizePuzzleTagList(puzzle.tags)
  const themes = normalizePuzzleTagList(puzzle.themes)
  if (!tags.length) return themes
  if (!themes.length) return tags
  const seen = new Set(tags)
  for (const theme of themes) {
    if (!seen.has(theme)) tags.push(theme)
  }
  return tags
}

// Lichess CSV/API banks use an **even** move count: `moves[0]` is the opponent’s
// setup ply, then the learner (opposite of FEN side-to-move) solves.
//
// Academy “player-first” drills often use an **odd** count: FEN side-to-move is the
// learner and `moves[0]` is their first solution ply (mate-in-two lines, one-movers).
// Treating those as Lichess setup auto-plays the win and forces the viewer to defend.
export function normalizePuzzlePlayModel(puzzle) {
  if (!puzzle || typeof puzzle !== 'object') return puzzle
  const moves = Array.isArray(puzzle.moves) ? puzzle.moves : []
  if (puzzle.teach || puzzle.noSetup) {
    return { ...puzzle, noSetup: true, teach: true }
  }
  if (moves.length > 0 && moves.length % 2 === 1) {
    return { ...puzzle, noSetup: true, teach: true }
  }
  return puzzle
}

// Solver color after normalizePuzzlePlayModel.
export function puzzlePlayerColorFromPuzzle(puzzle) {
  const p = normalizePuzzlePlayModel(puzzle) || puzzle
  const active = String(p?.fen || '').split(/\s+/)[1]
  if (p?.teach || p?.noSetup) return active === 'b' ? 'b' : 'w'
  return active === 'w' ? 'b' : 'w'
}

// Shorter alias for puzzlePlayerColorFromPuzzle.
export const puzzlePlayerColor = puzzlePlayerColorFromPuzzle

// Whether a parsed puzzle row satisfies active pool filters.
export function puzzleMatchesFilters(puzzle, filters = {}) {
  if (!puzzle) return false
  const f = filters || {}
  if (typeof f.minRating === 'number' && (puzzle.rating || 0) < f.minRating) return false
  if (typeof f.maxRating === 'number' && (puzzle.rating || 0) > f.maxRating) return false
  if (typeof f.minPopularity === 'number' || typeof f.maxPopularity === 'number') {
    if (typeof puzzle.popularity !== 'number') return false
    if (typeof f.minPopularity === 'number' && puzzle.popularity < f.minPopularity) return false
    if (typeof f.maxPopularity === 'number' && puzzle.popularity > f.maxPopularity) return false
  }
  if (Array.isArray(f.themes) && f.themes.length) {
    const wanted = new Set(f.themes)
    if (!Array.isArray(puzzle.themes) || !puzzle.themes.some(theme => wanted.has(theme))) return false
  }
  if (Array.isArray(f.tags) && f.tags.length) {
    const wanted = new Set(f.tags)
    if (!puzzleTagList(puzzle).some(tag => wanted.has(tag))) return false
  }
  return true
}

// True when a single line is a JSONL puzzle object with fen + ≥2 UCI moves.
export function isPuzzleJsonLine(text) {
  return Boolean(parsePuzzleJsonLine(text))
}

// Parse one JSONL puzzle line into the same shape as parsePuzzleRow.
export function parsePuzzleJsonLine(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('{')) return null
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const fen = String(obj.fen || obj.FEN || '').trim()
  const moveList = Array.isArray(obj.moves)
    ? obj.moves.map(m => String(m || '').trim()).filter(Boolean)
    : String(obj.moves || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
  if (!fen || moveList.length < 1 || !moveList.every(m => UCI_MOVE_RE.test(m))) return null
  let noSetup = Boolean(obj.noSetup || obj.teach)
  // Odd-length move lists are player-first Academy drills (see normalizePuzzlePlayModel).
  if (!noSetup && moveList.length % 2 === 1) noSetup = true
  if (!noSetup && moveList.length < 2) return null
  if ((fen.match(/\//g) || []).length !== 7) return null
  const themes = normalizePuzzleTagList(obj.themes)
  const tags = normalizePuzzleTagList(obj.tags)
  return normalizePuzzlePlayModel({
    id: String(obj.id || '').trim() || `jsonl-${fen.slice(0, 12)}`,
    fen,
    moves: moveList,
    rating: Number(obj.rating) || 0,
    ratingDeviation: Number(obj.ratingDeviation) || 0,
    popularity: Number(obj.popularity) || 0,
    nbPlays: Number(obj.nbPlays) || 0,
    themes,
    tags,
    gameUrl: String(obj.gameUrl || '').trim(),
    openingTags: normalizePuzzleTagList(obj.openingTags),
    prompt: String(obj.prompt || '').trim() || undefined,
    source: obj.source || 'embedded',
    noSetup: noSetup || undefined,
    teach: noSetup || undefined,
  })
}

// True when the first line of content looks like filter tokens only (not a puzzle body line).
export function isPuzzleSpecLine(text) {
  const line = String(text || '').trim()
  if (!line) return false
  if (isPuzzleRow(line) || isPuzzleJsonLine(line)) return false
  const spec = parsePuzzleSpec(line)
  return Boolean(spec.random || spec.adaptive) || hasActivePuzzleFilters(spec.filters)
}

// Parse PUZZLE item body into an embedded bank (JSONL and/or CSV lines).
// Returns { puzzles, prompt, filters } or null when there is no embedded puzzle body.
export function parsePuzzleBankContent(content) {
  const lines = String(content || '')
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) return null

  let filters = {}
  let start = 0
  if (isPuzzleSpecLine(lines[0])) {
    filters = parsePuzzleSpec(lines[0]).filters || {}
    start = 1
  }

  const puzzles = []
  const trailing = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    const jsonPuzzle = parsePuzzleJsonLine(line)
    if (jsonPuzzle) {
      puzzles.push({ ...jsonPuzzle, source: 'embedded' })
      continue
    }
    if (isPuzzleRow(line)) {
      const csvPuzzle = parsePuzzleRow(line)
      if (csvPuzzle) {
        puzzles.push({
          ...csvPuzzle,
          tags: puzzleTagList(csvPuzzle),
          source: 'embedded',
        })
        continue
      }
    }
    trailing.push(line)
  }

  if (!puzzles.length) return null

  // Single puzzle + non-puzzle trailing lines → author prompt (legacy).
  let prompt
  if (puzzles.length === 1 && trailing.length) {
    prompt = trailing.join('\n')
    if (prompt) puzzles[0].prompt = prompt
  }

  return { puzzles, prompt, filters }
}

// True when PUZZLE content embeds one or more puzzle lines (CSV or JSONL).
export function hasPuzzleBankContent(content) {
  return Boolean(parsePuzzleBankContent(content)?.puzzles?.length)
}

// Clipboard / paste looks like a multiline puzzle bank authors can insert into item text.
// Used by the chess item editor so paste inserts into the textarea instead of the FEN/PGN modal.
export function looksLikePuzzleBankPaste(text) {
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) return false
  let start = 0
  if (/^PUZZLE\b/i.test(lines[0])) {
    start = 1
    if (lines.length === 1) return false
  }
  if (looksLikeTeachPuzzlePgn(lines.slice(start).join('\n'))) return true
  let puzzleLines = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (isPuzzleJsonLine(line) || isPuzzleRow(line)) puzzleLines += 1
  }
  return puzzleLines >= 1
}

// True when PUZZLE body looks like an annotated teaching PGN (headers or movetext).
export function looksLikeTeachPuzzlePgn(text) {
  const body = String(text || '').trim()
  if (!body) return false
  if (/^\[(?:Event|FEN|SetUp|Site|White|Black)\b/m.test(body)) return true
  return /^\s*1\./m.test(body) && /\{[^}]+\}/.test(body)
}

export function puzzleFiltersToSearchParams(filters = {}, params = new URLSearchParams()) {
  const f = filters || {}
  if (f.themes?.length) params.set('themes', f.themes.join(','))
  if (f.tags?.length) params.set('tags', f.tags.join(','))
  for (const [key, param] of [
    ['minRating', 'minRating'],
    ['maxRating', 'maxRating'],
    ['minPopularity', 'minPopularity'],
    ['maxPopularity', 'maxPopularity'],
  ]) {
    if (typeof f[key] === 'number') params.set(param, String(f[key]))
  }
  return params
}

// Rough human size for download estimates (decimal MB/GB).
export function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `~${Math.round(bytes / 1_000_000)} MB`
  if (bytes >= 1_000) return `~${Math.round(bytes / 1_000)} KB`
  return `~${bytes} B`
}

// # Journal Autosave Guards and Save Planning

export function isBareModeKeyword(text) {
  const mode = parseItemMode(text)
  if (mode === 'NONE' || mode === 'CHOOSE') return false
  return stripModePrefix(text, mode) === ''
}

// True when autosave text is still only the bare keyword (no user edit yet)
export function isUnseatedFreshGamePgn(text) {
  if (!text || getFormat(text) !== 'PGN') return false
  if (pgnHasMoves(text)) return false
  return isOpenSeatTag(getPgnTag(text, 'White')) && isOpenSeatTag(getPgnTag(text, 'Black'))
}

function seatTagIsOpen(pgn, seat) {
  const tag = getPgnTag(pgn, seat)
  if (isOpenSeatTag(tag)) return true
  if (tag != null && String(tag).trim()) return false
  const opp = seat === 'White' ? 'Black' : 'White'
  const oppTag = getPgnTag(pgn, opp)
  return Boolean(String(oppTag || '').trim()) && !isOpenSeatTag(oppTag)
}

// True when exactly one seat is open and the other holds a human (non-engine) player.
export function hasOneCreatorOpenSeat(pgn) {
  if (!pgn || getFormat(pgn) !== 'PGN') return false
  if (bothSeatsFilled(pgn)) return false
  const whiteOpen = seatTagIsOpen(pgn, 'White')
  const blackOpen = seatTagIsOpen(pgn, 'Black')
  if (whiteOpen && blackOpen) return false
  return whiteOpen || blackOpen
}

export function openSeatSide(pgn) {
  if (!hasOneCreatorOpenSeat(pgn)) return null
  if (seatTagIsOpen(pgn, 'White')) return 'White'
  if (seatTagIsOpen(pgn, 'Black')) return 'Black'
  return null
}

// A real game page advertising an open seat for a remote human opponent (not vs Stockfish).
export function isPageOpenChallengePgn(pgn) {
  if (!hasOneCreatorOpenSeat(pgn)) return false
  if (parseStockfishLevel(getPgnTag(pgn, 'White')) != null) return false
  if (parseStockfishLevel(getPgnTag(pgn, 'Black')) != null) return false
  if (getHumanPlayMode(pgn) === HUMAN_PLAY_SAME_DEVICE) return false
  return true
}

// Keep a forkable ghost page in the lineup until both seats are filled.
export function keepGhostUntilSeatsFilled(pgn) {
  return hasOneCreatorOpenSeat(pgn)
}

export function shouldIgnoreKeywordAutosave(keyword, text) {
  if (!keyword) return false
  if (typeof text !== 'string') return false
  if (!text || String(text).trim() === keyword) return true
  // A move-less "GAME" board is normally not worth persisting yet — but only while
  // BOTH seats are still open (the freshly created open board). Once a player has
  // seated themselves (chose an opponent/colour or claimed a seat) the game start
  // must persist right away so the chosen seats survive a re-render, even before the
  // first move; otherwise the item stays a bare "GAME" keyword and reopens both seats.
  if (keyword === 'GAME' && isUnseatedFreshGamePgn(text)) return true
  return false
}

// Shared guard for shell, PWA bridge, and server save paths.
export function shouldPersistChessItemText({ itemText, nextText, bareKeywordGuard } = {}) {
  if (!nextText || typeof nextText !== 'string') return false
  if (isSurveyItemText(itemText) && itemText !== nextText) return false
  if (isLeaderboardItemText(itemText) && itemText !== nextText) return false
  if (bareKeywordGuard && shouldIgnoreKeywordAutosave(bareKeywordGuard, nextText)) return false
  // Opening the popup exports "CHOOSE" for a fresh item whose wiki text is still empty.
  // That is navigation-only — never journal a bare CHOOSE over an unconfigured item.
  if (String(nextText).trim() === 'CHOOSE' && isNewChessItem(itemText)) return false
  return true
}

// Strip create-preview ghost flags before journal put (shell save gateway).
export function stripCreatePreviewFlag(item) {
  if (!item || typeof item !== 'object') return item
  const story = Array.isArray(item.story) ? item.story : null
  const storyNeedsStrip = Boolean(
    story?.some(entry => entry?.createPreviewPendingJournal || entry?.openChallengeSetupPending),
  )
  const topNeedsStrip = Boolean(item.createPreviewPendingJournal || item.openChallengeSetupPending)
  if (!topNeedsStrip && !storyNeedsStrip) return item
  const next = { ...item }
  delete next.createPreviewPendingJournal
  delete next.openChallengeSetupPending
  if (storyNeedsStrip) {
    next.story = story.map(entry => stripCreatePreviewFlag(entry))
  }
  return next
}

// Drop the in-memory ghost bootstrap `create` before the slug'd materialize create is
// put. FedWiki needs that bootstrap entry while the page is create-editable; once we
// fork/materialize, keeping it would leave two creates in the journal (ghost + origin).
export function clearGhostBootstrapJournal(page) {
  if (!page || typeof page !== 'object') return page
  if (!Array.isArray(page.journal) || page.journal.length === 0) return page
  const onlyBootstrapCreate = page.journal.length === 1 && page.journal[0]?.type === 'create' && !page.journal[0]?.id
  if (!onlyBootstrapCreate) return page
  page.journal = []
  return page
}

// Optionally strip ghost flags from journal actions before shell put.
export function mapChessSaveActionsForJournal(actions, { stripGhost = false } = {}) {
  if (!actions?.length) return []
  if (!stripGhost) return actions
  return actions.map(action => (action?.item ? { ...action, item: stripCreatePreviewFlag(action.item) } : action))
}

export function withChessSymbol(action, prevText, nextText) {
  const symbol = chessJournalSymbol(prevText, nextText)
  if (symbol) action.symbol = symbol
  return action
}

export function attachPositionFen(action, fen) {
  const normalized = normalizeFen(fen)
  if (!normalized || normalized.split(' ').length < 4) return action
  action.fen = normalized
  action.fenKey = fenPositionKey(normalized)
  return action
}

// Apply a wiki-style page fork: replace local story/journal with the remote page, then stamp fork.
export function adoptRemoteWikiPage(localPage, remotePage, remoteSite, date = Date.now()) {
  if (!localPage || typeof localPage !== 'object') throw new Error('Invalid local page')
  if (!remotePage || typeof remotePage !== 'object') throw new Error('Invalid remote page')
  const host = String(remoteSite || '').trim()
  if (!host) throw new Error('Missing remote host')
  const ts = Number.isFinite(date) ? date : Date.now()
  localPage.title = remotePage.title || localPage.title
  localPage.story = JSON.parse(JSON.stringify(remotePage.story || []))
  localPage.journal = JSON.parse(JSON.stringify(remotePage.journal || []))
  localPage.journal.push({ type: 'fork', site: host, date: ts })
  return localPage
}

// Apply one ordinary FedWiki journal action to a page object (mutates page).
export function applyPageAction(page, action) {
  if (!page || !action?.type) throw new Error('Invalid page action')
  page.story ||= []
  page.journal ||= []
  const date = Number.isFinite(action.date) ? action.date : Date.now()
  const entry = { ...action, date }
  if (entry.fork) {
    page.journal.push({ type: 'fork', site: entry.fork, date: date - 1 })
    delete entry.fork
  }
  switch (entry.type) {
    case 'move':
      if (entry.id) {
        const ids = () => page.story.map(para => para.id)
        const targetIdx = entry.order.indexOf(entry.id)
        if (targetIdx < 0) throw new Error('Ignoring move. Try reload.')
        const itemIdx = ids().indexOf(entry.id)
        if (itemIdx < 0) throw new Error('Ignoring move. Try reload.')
        const item = page.story[itemIdx]
        page.story.splice(itemIdx, 1)
        const after = targetIdx > 0 ? entry.order[targetIdx - 1] : null
        const insertAt = after ? ids().indexOf(after) + 1 : 0
        page.story.splice(insertAt, 0, item)
      } else {
        page.story = entry.order.map(id => {
          const match = page.story.find(para => id === para.id)
          if (!match) throw new Error('Ignoring move. Try reload.')
          return match
        })
      }
      break
    case 'add': {
      const idx = page.story.map(para => para.id).indexOf(entry.after) + 1
      page.story.splice(idx, 0, entry.item)
      break
    }
    case 'remove':
      page.story = page.story.filter(para => para?.id !== entry.id)
      break
    case 'edit':
      page.story = page.story.map(para => (para.id === entry.id ? entry.item : para))
      break
    case 'create':
    case 'fork':
      page.story = page.story.length ? page.story : Array.isArray(entry.item?.story) ? entry.item.story.slice() : []
      break
    default:
      throw new Error('Unfamiliar action ignored')
  }
  page.journal.push(entry)
  return page
}

export function applyPageActions(page, actions) {
  for (const action of actions) applyPageAction(page, action)
  return page
}

export function buildChessEditAction(item, itemId, prevText, text, fen) {
  const persisted = canonicalizePersistedChessText(text)
  const nextItem = {
    type: item?.type || 'chess',
    id: itemId,
    text: persisted,
  }
  if (item?.id && item.id !== itemId) nextItem.id = itemId
  return attachPositionFen(
    withChessSymbol(
      {
        type: 'edit',
        id: itemId,
        item: nextItem,
      },
      prevText,
      persisted,
    ),
    fen,
  )
}

// Plan the journal actions needed to save one chess item text update.
export function buildChessSaveActions(
  page,
  itemId,
  text,
  { fen, prevText: explicitPrev, forkSite, localSeat, opponentSite, viewingSite } = {},
) {
  const story = Array.isArray(page?.story) ? page.story : []
  const item = story.find(entry => entry?.id === itemId)
  if (!item || item.type !== 'chess') return null
  const prevText = explicitPrev ?? item.text ?? ''
  const nextText = canonicalizePersistedChessText(text)
  if (prevText === nextText) return []

  if (shouldSplitOpenSeatGameJournal(prevText, nextText)) {
    const baseItem = { type: 'chess', id: itemId }
    const swordsAction = attachPositionFen(
      withChessSymbol(
        {
          type: 'edit',
          id: itemId,
          symbol: CHESS_CREATE_SYMBOL,
          item: { ...baseItem, text: 'GAME' },
        },
        prevText,
        'GAME',
      ),
      fen,
    )
    const seatAction = attachPositionFen(
      withChessSymbol(
        {
          type: 'edit',
          id: itemId,
          item: { ...baseItem, text: nextText },
        },
        'GAME',
        nextText,
      ),
      fen,
    )
    return [swordsAction, seatAction]
  }

  const journalCtx =
    localSeat && opponentSite
      ? { localSeat, opponentSite }
      : resolveCorrespondenceJournalContext(nextText, { viewingSite })
  const steps = journalCtx ? planCorrespondenceJournalSteps(prevText, nextText, journalCtx) : null

  if (steps?.length) {
    const actions = []
    let stepPrev = prevText
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const action = buildChessEditAction(
        item,
        itemId,
        stepPrev,
        step.text,
        index === steps.length - 1 ? fen : undefined,
      )
      const host = step.forkSite || (steps.length === 1 ? forkSite : undefined)
      if (host) action.fork = host
      actions.push(action)
      stepPrev = action.item.text
    }
    return actions
  }

  const action = buildChessEditAction(item, itemId, prevText, nextText, fen)
  if (forkSite) action.fork = forkSite
  return [action]
}

// Plan and apply a chess-item save to an in-memory wiki page.
export function applyChessSaveToPage(page, itemId, text, options = {}) {
  const actions = buildChessSaveActions(page, itemId, text, options)
  if (!actions) return { changed: false, error: 'item-not-found' }
  if (!actions.length) return { changed: false }
  for (const action of actions) {
    if (options.forkSite && !action.fork && actions[0] === action) action.fork = options.forkSite
    if (Number.isFinite(options.date)) action.date = options.date
    applyPageAction(page, action)
  }
  page.story = rebuildStoryFromJournal(page)
  return { changed: true }
}

// True when the item still needs a mode choice (empty, placeholder, or unknown text)
export function isNewChessItem(text) {
  return parseChessItem(text).showStartMenu
}

// Apply saved item text onto a chessObj (autosave, popup export)
export function mergeItemTextIntoChessObj(chessObj, text) {
  const parsed = parseChessItem(text)
  const resolved = resolveChessState(parsed)
  const next = {
    ...chessObj,
    mode: parsed.mode,
    chessState: text,
    ...resolved,
  }
  if (resolved.showStartMenu) {
    next.showStartMenu = true
    next.format = 'MENU'
    delete next.PGN
    delete next.FEN
    delete next.gameType
    delete next.needsSeed
    delete next.bareKeywordGuard
  } else {
    next.showStartMenu = false
    if (resolved.bareKeywordGuard) {
      next.bareKeywordGuard = resolved.bareKeywordGuard
    } else {
      delete next.bareKeywordGuard
    }
    // Spreading a prior position-editor shell state can leave a stale FEN on a PGN
    // game; that makes popup boot open the position editor instead of the game.
    if (resolved.format === 'PGN' || resolved.PGN) {
      delete next.FEN
      if (next.gameType === 'position') delete next.gameType
      if (next.mode === 'POSITION') next.mode = parsed.mode === 'NONE' ? 'GAME' : parsed.mode
    }
  }
  return next
}

// # Identity Piece Sets and Board Preferences
// Sprites live in client/assets/pieces/*.svg (cm-chessboard sprite format).
// Piece-set sprites live in client/assets/pieces/ (committed SVG sheets).

export const PIECE_SET_STORAGE_KEY = 'wiki-chess-piece-set'
export const DEFAULT_PIECE_SET_ID = 'merida'

// Legacy localStorage key name (migrated into IndexedDB `wiki-chess-ui-v1`).
// Bootstrap 5.3 color mode preference (site-wide — not journal).
// `auto` follows OS prefers-color-scheme; `light` / `dark` are explicit.
export const COLOR_THEME_STORAGE_KEY = 'wiki-chess-color-theme'
export const COLOR_THEME_IDS = Object.freeze(['auto', 'light', 'dark'])
export const DEFAULT_COLOR_THEME_ID = 'auto'

export function normalizeColorThemeId(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
  return COLOR_THEME_IDS.includes(id) ? id : DEFAULT_COLOR_THEME_ID
}

export function nextColorThemeId(value) {
  const id = normalizeColorThemeId(value)
  const i = COLOR_THEME_IDS.indexOf(id)
  return COLOR_THEME_IDS[(i + 1) % COLOR_THEME_IDS.length]
}

export function resolveColorTheme(preference, prefersDark = false) {
  const id = normalizeColorThemeId(preference)
  if (id === 'light' || id === 'dark') return id
  return prefersDark ? 'dark' : 'light'
}

export const PIECE_SETS = Object.freeze([
  Object.freeze({
    id: 'merida',
    label: 'Merida',
    spriteFile: 'pieces/merida.svg',
    license: 'GPL-2.0-or-later',
    licenseUrl: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
    sourceName: 'Lichess Merida',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/merida',
    description: 'Default Lichess Merida pieces — clear silhouettes at play scale.',
  }),
  Object.freeze({
    id: 'celtic',
    label: 'Celtic',
    spriteFile: 'pieces/celtic.svg',
    license: 'MIT',
    licenseUrl: 'https://opensource.org/licenses/MIT',
    sourceName: 'Lichess Celtic',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/celtic',
    description: 'Celtic-style pieces by Maurizio Monge (via Lichess).',
  }),
  Object.freeze({
    id: 'cburnett',
    label: 'Cburnett',
    spriteFile: 'pieces/cburnett.svg',
    license: 'GPL-2.0-or-later',
    licenseUrl: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
    sourceName: 'Lichess Cburnett',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/cburnett',
    description: 'Colin M. L. Burnett pieces as packaged by Lichess.',
  }),
  Object.freeze({
    id: 'chessnut',
    label: 'Chessnut',
    spriteFile: 'pieces/chessnut.svg',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    sourceName: 'Lichess Chessnut',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/chessnut',
    description: 'Classic wood-style pieces from Lichess.',
  }),
  Object.freeze({
    id: 'kiwen-suwi',
    label: 'Kiwen Suwi',
    spriteFile: 'pieces/kiwen-suwi.svg',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourceName: 'Lichess Kiwen Suwi',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/kiwen-suwi',
    description: 'Geometric Kiwen Suwi pieces from Lichess.',
  }),
  Object.freeze({
    id: 'kosal',
    label: 'Kosal',
    spriteFile: 'pieces/kosal.svg',
    license: 'AGPL-3.0-or-later',
    licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
    sourceName: 'Lichess Kosal',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/kosal',
    description: 'Kosal pieces from Lichess (Lila AGPL default).',
  }),
  Object.freeze({
    id: 'mpchess',
    label: 'mpchess',
    spriteFile: 'pieces/mpchess.svg',
    license: 'GPL-3.0-or-later',
    licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html',
    sourceName: 'Lichess mpchess',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/mpchess',
    description: 'mpchess pieces by Maxime Chupin (via Lichess).',
  }),
  Object.freeze({
    id: 'pixel',
    label: 'Pixel',
    spriteFile: 'pieces/pixel.svg',
    license: 'AGPL-3.0-or-later',
    licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
    sourceName: 'Lichess Pixel',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/pixel',
    description: 'Pixel-art pieces from Lichess.',
  }),
  Object.freeze({
    id: 'shapes',
    label: 'Shapes',
    spriteFile: 'pieces/shapes.svg',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceName: 'Lichess Shapes',
    sourceUrl: 'https://github.com/lichess-org/lila/tree/master/public/piece/shapes',
    description:
      'Abstract shape pieces by flugsio (via Lichess). Stay upright for opposite-sides play — never flipped.',
  }),
])

// Former Wikipedia/cm-chessboard sprite id — map to Lichess Cburnett.
const PIECE_SET_ALIASES = Object.freeze({ standard: 'cburnett' })

export function normalizePieceSetId(raw) {
  let id = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (PIECE_SET_ALIASES[id]) id = PIECE_SET_ALIASES[id]
  if (PIECE_SETS.some(set => set.id === id)) return id
  return DEFAULT_PIECE_SET_ID
}

export function getPieceSetById(raw) {
  const id = normalizePieceSetId(raw)
  return PIECE_SETS.find(set => set.id === id) || PIECE_SETS.find(set => set.id === DEFAULT_PIECE_SET_ID)
}

// Shapes are readable from both seats; in-place glyph flip is never applied.
export function pieceSetAllowsInPlaceFlip(raw) {
  return normalizePieceSetId(raw) !== 'shapes'
}

// Default in-item game settings (stored on wiki item JSON, not in journal text)

export const DEFAULT_GAME_SETTINGS = Object.freeze({
  confirmMoves: false,
  // Pass-and-play: re-orient the whole board after each move (hand-around / self-play).
  // Off by default — hand-around setup or the settings panel opts in. Only applies to
  // same-device human games (see shouldRotateBoardForSideToMove). Personal preference is
  // IndexedDB-global; page authors can force via `[SameDeviceFlip]`. Finished games suppress
  // flip in-session so archived boards do not keep rotating.
  sameDeviceFlip: false,
  // Opposite-sides tabletop: rotate glyphs 180° when the far seat is to move (board stays put).
  // Independent of sameDeviceFlip — see shouldFlipPiecesInPlace. Same lifecycle as above.
  sameDeviceFlipPieces: false,
  // When 'random', directed wiki challenges resolve colours when the invitee accepts.
  challengeCreatorColor: '',
  // Auto-accept a legal move detected on the remote opponent's wiki page instead
  // of prompting to fork it in. Only meaningful for remote (different-device) games.
  autoAcceptOpponentWikiMoves: false,
  // Auto-fork a decisive result the opponent posted (resignation, checkmate, draw agreed).
  autoAcceptOpponentWikiGameEnd: false,
  // Skip the real-time consent prompt and connect when both players are online.
  autoAcceptRealtime: false,
  // Silence the move/capture/check sound effects.
  muteMoveSounds: false,
  // Show move comments below the board (and allow adding notes when the viewer can journal).
  // Off by default for ordinary games — opt in via `[Comments "on"]` (or Academy site defaults).
  enableComments: false,
  // Always unwrap comments below the board when this is on (Academy hosts default this on).
  // Pair with enableComments; either flag can surface the panel.
  showAnnotationsBelow: false,
})

// True for the Chess Academy farm wiki (e.g. chess-academy.localhost).
export function isChessAcademyWikiSite(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .includes('chess-academy')
}

// Site-wide game-setting defaults layered under personal IndexedDB prefs + PGN tags.
// Academy teaching pages surface annotated model-game comments below the board.
export function siteGameSettingDefaults(host) {
  if (isChessAcademyWikiSite(host)) return { showAnnotationsBelow: true }
  return {}
}

// Shared on/off parser for showcase PGN tags (`[Comments]`, `[ConfirmMoves]`, …).
export function parseOnOffPgnTag(pgn, tagName) {
  const raw = String(getPgnTag(pgn, tagName) || '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  if (raw === 'on' || raw === 'yes' || raw === 'true' || raw === '1') return 'on'
  if (raw === 'off' || raw === 'no' || raw === 'false' || raw === '0') return 'off'
  return null
}

// Optional PGN override for the comments / annotations banner.
// `[Comments "on"]` → enable move comments + show annotations below by default.
// `[Comments "off"]` → keep both off (overrides Academy site defaults when present).
export function parseCommentsTag(pgn) {
  return parseOnOffPgnTag(pgn, 'Comments')
}

// Teaching / walkthrough scoresheets (`[Demo "1"]` or `[Lesson "1"]`) are not live
// games — hide Resign, skip remote human sync, etc. Result may still be "*" so the
// board can replay the model line.
export function isDemoOrLessonGame(pgn) {
  for (const tag of ['Demo', 'Lesson']) {
    const raw = String(getPgnTag(pgn, tag) || '')
      .trim()
      .toLowerCase()
    if (!raw) continue
    if (raw === '1' || raw === 'on' || raw === 'yes' || raw === 'true' || raw === 'demo' || raw === 'lesson') {
      return true
    }
  }
  return false
}

// Per-scoresheet game-setting defaults from PGN tags (win over site + personal prefs).
// Annotated teaching games use `[Comments "on"]` so ordinary GAME boards stay banner-off.
// Academy / showcase pages may also set ConfirmMoves / SameDeviceFlip(+Pieces).
export function pgnGameSettingDefaults(pgn) {
  const out = {}
  const comments = parseCommentsTag(pgn)
  if (comments === 'on') {
    out.enableComments = true
    out.showAnnotationsBelow = true
  } else if (comments === 'off') {
    out.enableComments = false
    out.showAnnotationsBelow = false
  }
  const confirm = parseOnOffPgnTag(pgn, 'ConfirmMoves')
  if (confirm === 'on') out.confirmMoves = true
  else if (confirm === 'off') out.confirmMoves = false
  const flip = parseOnOffPgnTag(pgn, 'SameDeviceFlip')
  if (flip === 'on') out.sameDeviceFlip = true
  else if (flip === 'off') out.sameDeviceFlip = false
  const flipPieces = parseOnOffPgnTag(pgn, 'SameDeviceFlipPieces')
  if (flipPieces === 'on') out.sameDeviceFlipPieces = true
  else if (flipPieces === 'off') out.sameDeviceFlipPieces = false
  return out
}

// True when movetext contains at least one non-empty PGN brace comment.
export function pgnHasMoveComments(text) {
  return /\{[^}]+\}/.test(String(text || ''))
}

// Optional PGN override for initial board ply after load.
// `[StartView "start"]` → ply 0; `[StartView "end"]` → tip (last ply).
export function parseStartViewTag(pgn) {
  const raw = String(getPgnTag(pgn, 'StartView') || '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  if (raw === 'start' || raw === 'begin' || raw === 'beginning' || raw === '0') return 'start'
  if (raw === 'end' || raw === 'tip' || raw === 'last') return 'end'
  return null
}

// chess-console `initGame({ pgn })` jumps the board to the last ply (tip).
// Rewind to ply 0 only for teaching scoresheets (brace comments) or when
// `[StartView "start"]` requests it. Finished games stay at the end unless
// they look like annotated lessons (or an explicit start tag).
export function shouldViewLoadedGameFromStart(pgn) {
  if (!pgnHasMoves(pgn)) return false
  const view = parseStartViewTag(pgn)
  if (view === 'start') return true
  if (view === 'end') return false
  return pgnHasMoveComments(pgn)
}

// Default academy twin host used for Black-side fork stamps on teaching journals.
export const ACADEMY_PLAY_TWIN_SITE = 'chess-academy-play.localhost'

// Companion wiki host for synthetic correspondence forks (fed stamps on teaching GAME journals).
export function academyPlayTwinSite(wikiSite = 'chess-academy.localhost') {
  const host = normalizeWikiSite(wikiSite) || 'chess-academy.localhost'
  if (host === ACADEMY_PLAY_TWIN_SITE) return 'chess-academy.localhost'
  if (host.startsWith('chess-academy')) {
    return host.replace(/^chess-academy/, 'chess-academy-play')
  }
  return `play.${host}`
}

// True when item text is a GAME (or bare PGN) scoresheet with at least one move —
// the kind of academy example that should carry a play-style journal.
export function isAnnotatedGameChessText(text) {
  const mode = parseItemMode(text)
  if (mode === 'POSITION' || mode === 'PUZZLE' || mode === 'CHOOSE') return false
  if (mode === 'SURVEY' || mode === 'LEADERBOARD') return false
  const body = mode === 'GAME' ? stripModePrefix(text, 'GAME') : String(text || '').trim()
  if (!body) return false
  return getFormat(body) === 'PGN' && pgnHasMoves(body)
}

// Strip optional GAME keyword; returns PGN body (may be empty).
export function gamePgnBodyFromItemText(text) {
  const mode = parseItemMode(text)
  if (mode === 'GAME') return stripModePrefix(text, 'GAME')
  return String(text || '').trim()
}

// Prefix PGN body with the GAME keyword for academy item.text.
export function asGameItemText(pgnBody) {
  const body = String(pgnBody || '').trim()
  if (!body) return 'GAME'
  if (/^GAME\b/i.test(body)) return body
  return `GAME\n${body}`
}

// Normalize settings from item JSON or postMessage
export function normalizeGameSettings(raw) {
  const settings = { ...DEFAULT_GAME_SETTINGS }
  if (!raw || typeof raw !== 'object') return settings
  if (typeof raw.confirmMoves === 'boolean') settings.confirmMoves = raw.confirmMoves
  if (typeof raw.sameDeviceFlip === 'boolean') settings.sameDeviceFlip = raw.sameDeviceFlip
  if (typeof raw.sameDeviceFlipPieces === 'boolean') {
    settings.sameDeviceFlipPieces = raw.sameDeviceFlipPieces
  }
  const autoAcceptOpponentWikiMoves = raw.autoAcceptOpponentWikiMoves ?? raw.autoAcceptRemoteMoves
  if (typeof autoAcceptOpponentWikiMoves === 'boolean') {
    settings.autoAcceptOpponentWikiMoves = autoAcceptOpponentWikiMoves
  }
  const autoAcceptOpponentWikiGameEnd = raw.autoAcceptOpponentWikiGameEnd ?? raw.autoAcceptRemoteGameEnd
  if (typeof autoAcceptOpponentWikiGameEnd === 'boolean') {
    settings.autoAcceptOpponentWikiGameEnd = autoAcceptOpponentWikiGameEnd
  }
  if (typeof raw.autoAcceptRealtime === 'boolean') {
    settings.autoAcceptRealtime = raw.autoAcceptRealtime
  }
  if (typeof raw.muteMoveSounds === 'boolean') settings.muteMoveSounds = raw.muteMoveSounds
  if (typeof raw.enableComments === 'boolean') settings.enableComments = raw.enableComments
  if (typeof raw.showAnnotationsBelow === 'boolean') {
    settings.showAnnotationsBelow = raw.showAnnotationsBelow
  }
  if (typeof raw.challengeCreatorColor === 'string') {
    const color = raw.challengeCreatorColor.trim().toLowerCase()
    if (color === 'random' || color === 'white' || color === 'black') {
      settings.challengeCreatorColor = color
    }
  }
  return settings
}

export function mergeGameSettings(prev, patch) {
  return normalizeGameSettings({ ...normalizeGameSettings(prev), ...(patch || {}) })
}

// Remote wiki chess items often ship `gameSettings: null` (prefs are local-only).
// Never treat null/missing as "reset to defaults" when adopting a forked page —
// that unchecks auto-fork in the UI while in-flight accepts still behave as on.
export function coalesceAdoptedGameSettings(remoteGameSettings, previousGameSettings) {
  if (remoteGameSettings != null && typeof remoteGameSettings === 'object') {
    return normalizeGameSettings(remoteGameSettings)
  }
  if (previousGameSettings != null && typeof previousGameSettings === 'object') {
    return normalizeGameSettings(previousGameSettings)
  }
  return normalizeGameSettings(undefined)
}

// # Journal Action Symbols
// The wiki renders a small flag per saved journal action, preferring `action.symbol`
// when present (else a default glyph per action type — see wiki-client). We classify
// each chess save so its journal entry shows a fitting glyph instead of the generic
// edit mark: a new game, a seat claim, or — for a move — the actual piece and colour
// that just moved.

// New game / match start (crossed swords — deliberately not a chess piece).
export const CHESS_CREATE_SYMBOL = '⚔'
// A player claimed or changed a seat: a filled ring for Black, a hollow ring for
// White (not the ⚑ flag — that's a wiki page fork).
export const CHESS_SEAT_WHITE_SYMBOL = '◎'
export const CHESS_SEAT_BLACK_SYMBOL = '⦿'
// Game finished — Result left '*' for a decisive score or agreed draw (checkered flag).
export const CHESS_COMPLETE_SYMBOL = '🏁'

// Unicode chess pieces by colour, so a move's flag shows what actually moved.
const PIECE_GLYPHS = {
  w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
  b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
}

// Movetext only: drop [Tag "..."] pairs and collapse whitespace, so two PGNs can be
// compared for "did the moves change?" independent of header/seat edits.
function pgnMovetextOnly(pgn) {
  const mode = parseItemMode(pgn)
  const body = mode === 'GAME' ? stripModePrefix(pgn, 'GAME') : String(pgn || '')
  return body
    .split('\n')
    .filter(line => !/^\s*\[/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Split movetext into SAN tokens, stripping move numbers, results, comments, NAGs,
// and variation parens. Good enough for this app's linear games. Exported so the
// twin-audit in chess-discovery.js (sanPlies) reuses this single source of truth
// rather than re-declaring the same strip chain.
export function sanTokens(movetext) {
  return String(movetext || '')
    .replace(/\{[^}]*\}/g, ' ') // {comments}
    .replace(/\$\d+/g, ' ') // $NAGs
    .replace(/[()]/g, ' ') // variation parens (rare here)
    .replace(/\d+\.(\.\.)?/g, ' ') // move numbers: "1." / "1..."
    .replace(/\b(?:1-0|0-1|1\/2-1\/2)\b|\*/g, ' ') // results
    .split(/\s+/)
    .filter(Boolean)
}

function pgnSans(pgn) {
  if (!pgn || getFormat(pgn) !== 'PGN') return []
  return sanTokens(parsePgnParts(pgn).movetext)
}

// Build linear movetext through a ply index (inclusive), for correspondence journal steps.
export function buildMovetextThroughSans(sans, throughIndex) {
  let movetext = ''
  for (let i = 0; i <= throughIndex; i += 1) {
    if (i % 2 === 0) movetext += `${Math.floor(i / 2) + 1}. ${sans[i]} `
    else movetext += `${sans[i]} `
  }
  return movetext.trim()
}

// Slice a saved PGN down to an earlier ply while preserving headers from the final position.
export function pgnThroughPlies(pgn, throughPlyIndex) {
  const parts = parsePgnParts(pgn)
  const sans = sanTokens(parts.movetext)
  if (throughPlyIndex < 0 || throughPlyIndex >= sans.length) return canonicalizePersistedChessText(pgn)
  const tags = { ...parts.tags }
  const atGameEnd = throughPlyIndex === sans.length - 1
  const result = String(tags.Result || '').trim()
  let movetext = buildMovetextThroughSans(sans, throughPlyIndex)
  if (atGameEnd && result && result !== '*' && isDecisiveResult(result)) {
    movetext = `${movetext} ${result}`.trim()
  } else {
    tags.Result = '*'
  }
  return formatPgnParts({ tags, movetext })
}

export function isOwnCorrespondencePly(localSeat, plyIndex) {
  const isWhiteMove = plyIndex % 2 === 0
  if (localSeat === 'white') return isWhiteMove
  if (localSeat === 'black') return !isWhiteMove
  return false
}

// Plan one journal put per new ply — opponent plies carry forkSite (auto-fork), own plies are native.
export function planCorrespondenceJournalSteps(prevText, nextText, { localSeat, opponentSite } = {}) {
  if (!localSeat || !opponentSite || getFormat(nextText) !== 'PGN') return null

  const prevSans = pgnSans(prevText)
  const nextSans = pgnSans(nextText)
  if (nextSans.length <= prevSans.length) return null

  for (let i = 0; i < prevSans.length; i += 1) {
    if (prevSans[i] !== nextSans[i]) return null
  }

  const steps = []
  for (let plyIndex = prevSans.length; plyIndex < nextSans.length; plyIndex += 1) {
    steps.push({
      text: pgnThroughPlies(nextText, plyIndex),
      forkSite: isOwnCorrespondencePly(localSeat, plyIndex) ? undefined : opponentSite,
    })
  }
  return steps.length ? steps : null
}

// Side to move at the start of the game (Black if a SetUp FEN says so), so move
// colours come out right even for games begun from a custom position.
function startSideToMove(pgn) {
  const fen = getPgnTag(pgn, 'FEN')
  if (fen && fen.trim().split(/\s+/)[1] === 'b') return 'b'
  return 'w'
}

// The piece-letter (KQRBN, or P for a pawn) of a SAN move; castling moves the king.
function sanPieceLetter(san) {
  if (/^(?:O-O|0-0)/.test(san)) return 'K'
  const c = san[0]
  return 'KQRBN'.includes(c) ? c : 'P'
}

// Glyph for the most recent move in a PGN — the piece and colour that moved — or
// null if there are no moves / it can't be parsed.
export function movedPieceSymbol(pgn) {
  const tokens = sanTokens(pgnMovetextOnly(pgn))
  if (!tokens.length) return null
  const idx = tokens.length - 1
  const start = startSideToMove(pgn)
  const color = idx % 2 === 0 ? start : start === 'w' ? 'b' : 'w'
  return PIECE_GLYPHS[color][sanPieceLetter(tokens[idx])] || null
}

// Which seat's player tag changed between two PGNs. When both change in one save,
// prefer the seat that was open and is now filled (a join), then any newly filled
// seat on game creation. Returns 'White' | 'Black' | null.
function seatTagValue(pgn, seat) {
  const tag = getPgnTag(pgn, seat)
  if (isOpenSeatTag(tag)) return ''
  return String(tag || '').trim()
}

function primarySeatChange(prevText, nextText) {
  const changed = []
  for (const seat of ['White', 'Black']) {
    if (seatTagValue(prevText, seat) !== seatTagValue(nextText, seat)) changed.push(seat)
  }
  if (!changed.length) return null
  for (const seat of changed) {
    if (isOpenSeatTag(getPgnTag(prevText, seat)) && !isOpenSeatTag(getPgnTag(nextText, seat))) {
      return seat
    }
  }
  for (const seat of changed) {
    if (!isOpenSeatTag(getPgnTag(nextText, seat))) return seat
  }
  return changed[0]
}

function changedSeat(prevText, nextText) {
  return primarySeatChange(prevText, nextText)
}

function newlyFilledSeats(prevText, nextText) {
  const filled = []
  for (const seat of ['White', 'Black']) {
    const wasEmpty = seatTagValue(prevText, seat) === ''
    const nowFilled = seatTagValue(nextText, seat) !== ''
    if (wasEmpty && nowFilled) filled.push(seat)
  }
  return filled
}

// True when neither side is still an open/unclaimed seat.
export function bothSeatsFilled(pgn) {
  if (!pgn || getFormat(pgn) !== 'PGN') return false
  return !isOpenSeatTag(getPgnTag(pgn, 'White')) && !isOpenSeatTag(getPgnTag(pgn, 'Black'))
}

function becameComplete(prevText, nextText) {
  const prevResult = String(getPgnTag(prevText, 'Result') || '*').trim()
  const nextResult = String(getPgnTag(nextText, 'Result') || '*').trim()
  return !isDecisiveResult(prevResult) && isDecisiveResult(nextResult)
}

// Classify a chess item save by diffing previous vs next text. Returns
// 'create' | 'move' | 'seat' | 'complete' | 'edit' ('edit' = wiki default glyph).
export function classifyChessSave(prevText, nextText) {
  if (getFormat(nextText) !== 'PGN') return 'edit'
  // No prior game (blank, or a bare GAME keyword) → this save creates the game.
  if (getFormat(prevText) !== 'PGN') return 'create'
  // New game started over an existing one: a fresh move-less PGN replaces a game that
  // already had moves or a fully seated lineup (toolbar "+" / new-game modal).
  if (!pgnHasMoves(nextText) && (pgnHasMoves(prevText) || bothSeatsFilled(prevText))) {
    return 'create'
  }
  if (pgnMovetextOnly(prevText) !== pgnMovetextOnly(nextText)) return 'move'
  if (becameComplete(prevText, nextText)) return 'complete'
  return changedSeat(prevText, nextText) ? 'seat' : 'edit'
}

// The journal flag glyph for a save: the moved piece for a move, distinct marks for
// create / seat (hollow ring = White seat, filled ring = Black seat), or null (wiki
// default edit mark) for anything else.
export function chessJournalSymbol(prevText, nextText) {
  switch (classifyChessSave(prevText, nextText)) {
    case 'create': {
      // Restart over an existing PGN always gets crossed swords (another game-start mark).
      if (getFormat(prevText) === 'PGN') return CHESS_CREATE_SYMBOL
      const filled = newlyFilledSeats(prevText, nextText)
      if (filled.length === 1) {
        return filled[0] === 'Black' ? CHESS_SEAT_BLACK_SYMBOL : CHESS_SEAT_WHITE_SYMBOL
      }
      return CHESS_CREATE_SYMBOL
    }
    case 'seat':
      return primarySeatChange(prevText, nextText) === 'Black' ? CHESS_SEAT_BLACK_SYMBOL : CHESS_SEAT_WHITE_SYMBOL
    case 'move':
      return movedPieceSymbol(nextText)
    case 'complete':
      return CHESS_COMPLETE_SYMBOL
    default:
      return null
  }
}

// True once the saved game has left the starting position (journal should be moves + forks).
export function chessGameHasStarted(pgn) {
  return getFormat(pgn) === 'PGN' && pgnHasMoves(pgn)
}

function applyJournalActionToStory(page, action) {
  if (!action || action.type === 'fork') return
  if (!page.story) page.story = []
  const order = () => page.story.map(entry => entry?.id)
  const add = (after, item) => {
    const index = order().indexOf(after) + 1
    page.story.splice(index, 0, item)
  }
  const remove = () => {
    const index = order().indexOf(action.id)
    if (index !== -1) page.story.splice(index, 1)
  }
  switch (action.type) {
    case 'create':
      if (action.item?.story) page.story = action.item.story.slice()
      break
    case 'add':
      add(action.after, action.item)
      break
    case 'edit': {
      const index = order().indexOf(action.id)
      if (index !== -1) page.story.splice(index, 1, action.item)
      else page.story.push(action.item)
      break
    }
    case 'move': {
      const index = action.order.indexOf(action.id)
      const after = action.order[index - 1]
      const moved = page.story[order().indexOf(action.id)]
      remove()
      add(after, moved)
      break
    }
    case 'remove':
      remove()
      break
  }
}

export function rebuildStoryFromJournal({ title = '', journal = [] } = {}) {
  const page = { title, story: [] }
  for (const action of journal) applyJournalActionToStory(page, action)
  return page.story
}

export function shouldSplitOpenSeatGameJournal(prevText, nextText) {
  if (getFormat(nextText) !== 'PGN' || bothSeatsFilled(nextText)) return false
  const whiteOpen = isOpenSeatTag(getPgnTag(nextText, 'White'))
  const blackOpen = isOpenSeatTag(getPgnTag(nextText, 'Black'))
  if (!whiteOpen && !blackOpen) return false
  const seatSymbol = chessJournalSymbol(prevText, nextText)
  if (seatSymbol !== CHESS_SEAT_WHITE_SYMBOL && seatSymbol !== CHESS_SEAT_BLACK_SYMBOL) {
    return false
  }
  if (getFormat(prevText) === 'PGN') {
    if (pgnHasMoves(prevText) || bothSeatsFilled(prevText)) return false
  }
  return true
}

function ghostStoryItemId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(8)
      crypto.getRandomValues(bytes)
      return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* fall through */
  }
  let s = ''
  while (s.length < 16) s += Math.floor(Math.random() * 16).toString(16)
  return s.slice(0, 16)
}

// Title, intro copy, and chess-item keyword for a forkable ghost page spawned from the
// CHOOSE menu (Play New Game / Set Up a Position / Chess Puzzle).
export function buildCreatePreviewMeta(kind, { puzzleText } = {}) {
  switch (kind) {
    case 'game':
      return {
        title: 'New Chess Game',
        paragraph: 'A new chess game.',
        chessText: 'GAME',
      }
    case 'position':
      return {
        title: 'New Chess Position',
        paragraph: 'A new chess position.',
        chessText: 'POSITION',
      }
    case 'puzzle': {
      const chessText = String(puzzleText || '').trim() || 'PUZZLE'
      return {
        title: 'New Chess Puzzle',
        paragraph: 'A random puzzle from the Lichess.org puzzle database.',
        chessText,
      }
    }
    case 'choose':
      return {
        title: 'New Chess page',
        chessText: 'CHOOSE',
      }
    default:
      return null
  }
}

export function buildCreatePreviewStory(meta, { itemId, paragraphId, openChallengeSetupPending = false } = {}) {
  if (!meta?.chessText) return []
  const chessId = String(itemId || '').trim() || ghostStoryItemId()
  const story = []
  if (meta.paragraph && !openChallengeSetupPending) {
    const paraId = String(paragraphId || '').trim() || ghostStoryItemId()
    story.push({ type: 'paragraph', id: paraId, text: meta.paragraph })
  }
  const chessItem = {
    type: 'chess',
    id: chessId,
    text: meta.chessText,
    createPreviewPendingJournal: true,
  }
  if (openChallengeSetupPending) chessItem.openChallengeSetupPending = true
  story.push(chessItem)
  return story
}

// Synthetic journal for a challenge-join ghost: crossed swords when the game starts,
// then the creator's seat ring when they posted the open challenge.
export function buildOpenChallengeGhostJournal(pgn, { itemId, challenge } = {}) {
  const id = String(itemId || '').trim()
  if (!id || !pgn) return []
  const ts = Number.isFinite(challenge?.ts) ? challenge.ts : Date.now()
  const seatedItem = { type: 'chess', id, text: pgn }
  const normalized = challenge && typeof challenge === 'object' ? challenge : null
  if (normalized) seatedItem.challenge = normalized
  const seatSymbol = chessJournalSymbol('GAME', pgn)
  const actions = []
  if (seatSymbol === CHESS_SEAT_WHITE_SYMBOL || seatSymbol === CHESS_SEAT_BLACK_SYMBOL) {
    actions.push({
      type: 'edit',
      id,
      symbol: CHESS_CREATE_SYMBOL,
      item: { type: 'chess', id, text: 'GAME' },
      date: ts - 1,
    })
    actions.push({
      type: 'edit',
      id,
      symbol: seatSymbol,
      item: seatedItem,
      date: ts,
    })
  } else {
    actions.push({
      type: 'edit',
      id,
      symbol: seatSymbol || CHESS_CREATE_SYMBOL,
      item: seatedItem,
      date: ts,
    })
  }
  return actions
}

// Synthetic journal replayed after a join ghost is forked: crossed swords when the
// creator started the game, their seat ring on the ghost board, then the joiner's seat
// ring once both players are seated.
export function buildJoinAcceptGhost(ghostPgn, seatedPgn, { itemId, challenge, ts } = {}) {
  const id = String(itemId || '').trim()
  const baseGhostPgn = String(ghostPgn || '').trim()
  const seated = String(seatedPgn || '').trim()
  if (!id || !baseGhostPgn || !seated) return []
  const baseTs = Number.isFinite(ts) ? ts : Date.now()
  const accepted = challenge && typeof challenge === 'object' ? { ...challenge } : null
  const ghostChallenge = accepted ? { ...accepted, status: 'open', opponent: undefined } : null
  const ghostItem = { type: 'chess', id, text: baseGhostPgn }
  if (ghostChallenge) ghostItem.challenge = ghostChallenge
  const seatedItem = { type: 'chess', id, text: seated }
  if (accepted) seatedItem.challenge = accepted

  const creatorSeatSymbol = chessJournalSymbol('GAME', baseGhostPgn)
  const joinerSeatSymbol = chessJournalSymbol(baseGhostPgn, seated)
  const actions = [
    {
      type: 'edit',
      id,
      symbol: CHESS_CREATE_SYMBOL,
      item: { type: 'chess', id, text: 'GAME' },
      date: baseTs - 2,
    },
  ]
  if (creatorSeatSymbol === CHESS_SEAT_WHITE_SYMBOL || creatorSeatSymbol === CHESS_SEAT_BLACK_SYMBOL) {
    actions.push({
      type: 'edit',
      id,
      symbol: creatorSeatSymbol,
      item: ghostItem,
      date: baseTs - 1,
    })
  }
  actions.push({
    type: 'edit',
    id,
    symbol:
      joinerSeatSymbol === CHESS_SEAT_WHITE_SYMBOL || joinerSeatSymbol === CHESS_SEAT_BLACK_SYMBOL
        ? joinerSeatSymbol
        : CHESS_SEAT_BLACK_SYMBOL,
    item: seatedItem,
    date: baseTs,
  })
  return actions
}

// Pass-and-play board rotation. Turning the board after each move only makes sense
// when two humans share one device, so it is gated behind same-device human play
// (decided at game setup). Off unless `sameDeviceFlip` is explicitly enabled
// (hand-around start or settings panel).
export function shouldRotateBoardForSideToMove(state = {}) {
  if (!isSameDeviceHumanPlay(state)) return false
  const settings = normalizeGameSettings(state.gameSettings)
  return settings.sameDeviceFlip === true
}

// Opposite-sides tabletop: when enabled, glyphs rotate 180° in place for the far
// seat's turn (board sides stay fixed). Not pass-and-play board reorientation
// (`shouldRotateBoardForSideToMove`). Callers must also check
// pieceSetAllowsInPlaceFlip — Shapes never rotate.
export function shouldFlipPiecesInPlace(state = {}) {
  if (!isSameDeviceHumanPlay(state)) return false
  const settings = normalizeGameSettings(state.gameSettings)
  return settings.sameDeviceFlipPieces === true
}

export function resolveChessState(parsed) {
  const { mode, content, format, showStartMenu } = parsed

  if (showStartMenu) {
    return {
      showStartMenu: true,
      format: 'MENU',
      mode: mode === 'CHOOSE' ? 'CHOOSE' : mode === 'NONE' ? undefined : mode,
      chessState: mode === 'CHOOSE' ? 'CHOOSE' : content,
    }
  }

  if (mode === 'SURVEY') {
    if (parseSurveyKind(parsed.rawText?.trim() || content || '') === SURVEY_KIND_FULL) {
      return {
        format: 'SURVEY',
        gameType: 'survey',
        mode: 'FULL',
        chessState: parsed.rawText?.trim() || content || 'SURVEY',
      }
    }
    return {
      showStartMenu: true,
      format: 'MENU',
      mode: 'SURVEY',
      chessState: parsed.rawText?.trim() || content || 'SURVEY',
    }
  }

  if (mode === 'LEADERBOARD') {
    if (parseLeaderboardKind(parsed.rawText?.trim() || content || '') === LEADERBOARD_KIND_FULL) {
      return {
        format: 'LEADERBOARD',
        gameType: 'leaderboard',
        mode: 'LEADERBOARD',
        chessState: parsed.rawText?.trim() || content || 'LEADERBOARD',
      }
    }
    return {
      showStartMenu: true,
      format: 'MENU',
      mode: 'LEADERBOARD',
      chessState: parsed.rawText?.trim() || content || 'LEADERBOARD',
    }
  }

  if (mode === 'PUZZLE') {
    // An embedded puzzle bank: "PUZZLE\n<CSV row|JSONL…>" (one or more lines).
    // Carry the body verbatim so Puzzle Mode solves these instead of a pool pick.
    if (content && (isPuzzleRow(content) || hasPuzzleBankContent(content) || looksLikeTeachPuzzlePgn(content))) {
      return {
        format: 'PUZZLE',
        gameType: 'puzzle',
        mode: 'PUZZLE',
        chessState: parsed.rawText?.trim() || `PUZZLE\n${content.trim()}`,
      }
    }
    const hasFen = content && getFormat(content) === 'FEN' && !looksLikePuzzleBankPaste(content)
    return {
      format: 'PUZZLE',
      gameType: 'puzzle',
      mode: 'PUZZLE',
      chessState: parsed.rawText?.trim() || (hasFen ? `PUZZLE\n${content}` : 'PUZZLE'),
      ...(hasFen ? { FEN: content } : {}),
      bareKeywordGuard: hasFen ? undefined : 'PUZZLE',
    }
  }

  switch (format) {
    case 'FIGURINE':
      return {
        format: 'FIGURINE',
        chessState: content,
        FEN: figurineToFEN(content),
      }
    case 'FEN':
      return {
        format: 'FEN',
        chessState: content,
        FEN: content,
      }
    case 'PGN':
      return {
        format: 'PGN',
        chessState: content,
        PGN: content,
      }
    case 'EMPTY':
      if (mode === 'POSITION') {
        return {
          format: 'FEN',
          chessState: '',
          FEN: START_FEN,
          gameType: 'position',
          bareKeywordGuard: 'POSITION',
        }
      }
      if (mode === 'PUZZLE') {
        return {
          format: 'PUZZLE',
          chessState: 'PUZZLE',
          gameType: 'puzzle',
          bareKeywordGuard: 'PUZZLE',
        }
      }
      return {
        format: 'PGN',
        chessState: '',
        // A bare GAME keyword opens a fresh board with two empty seats and the
        // start-game modal; any other empty item still seeds an engine game.
        gameType: mode === 'GAME' ? 'open' : 'engine',
        bareKeywordGuard: mode === 'GAME' ? 'GAME' : undefined,
        needsSeed: mode === 'GAME' ? undefined : true,
      }
    case 'UNKNOWN':
    default:
      // Unrecognized non-empty content seeds an engine game, regardless of keyword.
      return {
        format: 'PGN',
        chessState: content,
        gameType: 'engine',
        needsSeed: true,
      }
  }
}

// True when the item is a puzzle (Puzzle Mode, `#puzzle`), not a saved game
export function isPuzzleState(state = {}) {
  if (state.showStartMenu) return false
  if (state.gameType === 'puzzle' || state.format === 'PUZZLE') return true
  return state.mode === 'PUZZLE' && !state.FEN && !state.PGN
}

// Repair saved/restored state where PUZZLE item text was stored as PGN.
export function normalizeRestoredChessSession(state) {
  if (!state || typeof state !== 'object') return state
  const out = { ...state }
  if (out.followsPopup === undefined && out.followPopup !== undefined) {
    out.followsPopup = Boolean(out.followPopup)
  }
  delete out.followPopup
  if (out.signedInDisplayName === undefined && out.ownerName !== undefined) {
    out.signedInDisplayName = out.ownerName
  }
  delete out.autoSave
  delete out.localPersist
  delete out.canSaveToWiki
  delete out.pwaLocalOnly
  delete out.mirrorMode
  delete out.syncOnly
  delete out.ownerName
  delete out.keywordOnly
  delete out.chessItemGhostPendingJournal
  const pgnText = String(out.PGN || '').trim()
  if (pgnText && parseItemMode(pgnText) === 'PUZZLE' && !out.chessState) {
    out.chessState = pgnText
    delete out.PGN
  }
  const text = String(out.chessState || out.PGN || '').trim()
  if (isPuzzleState(out)) {
    delete out.PGN
    if (!out.chessState && parseItemMode(text) === 'PUZZLE') out.chessState = text
    return out
  }
  if (parseItemMode(text) === 'PUZZLE') {
    const resolved = resolveChessState(parseChessItem(text))
    return { ...out, ...resolved, chessState: resolved.chessState || text, PGN: undefined }
  }
  return out
}

const PIECE_MAP = {
  '♔': 'K',
  '♕': 'Q',
  '♖': 'R',
  '♗': 'B',
  '♘': 'N',
  '♙': 'P',
  '♚': 'k',
  '♛': 'q',
  '♜': 'r',
  '♝': 'b',
  '♞': 'n',
  '♟': 'p',
}

const PIECE_REGEX = /([♔♕♖♗♘♙♚♛♜♝♞♟])([a-h][1-8])/g

// Convert a figurine board diagram (e.g. "♔e1 ♟a7 …") into a FEN string.
// We build an 8x8 grid, place each piece on its square, then encode each rank the
// way FEN does: a letter per piece and a single digit for each run of empties.
export function figurineToFEN(positionText) {
  const EMPTY = '1'
  const board = Array(8)
    .fill()
    .map(() => Array(8).fill(EMPTY))

  for (const [, piece, square] of positionText.matchAll(PIECE_REGEX)) {
    const file = square.charCodeAt(0) - 'a'.charCodeAt(0) // 'a'..'h' -> column 0..7
    const rank = 8 - parseInt(square[1], 10) // '8'..'1' -> row 0..7 (FEN runs top-down)
    board[rank][file] = PIECE_MAP[piece] || EMPTY
  }

  const placement = board
    .map(row => {
      let fenRank = ''
      let emptyRun = 0
      for (const cell of row) {
        if (cell === EMPTY) {
          emptyRun += 1
          continue
        }
        // Flush the pending empty squares as a single count before the piece.
        if (emptyRun > 0) {
          fenRank += emptyRun
          emptyRun = 0
        }
        fenRank += cell
      }
      if (emptyRun > 0) fenRank += emptyRun // trailing empties at the rank's end
      return fenRank
    })
    .join('/')

  // A figurine diagram only describes piece placement, so append default
  // side-to-move / castling / clock fields to make a syntactically valid FEN.
  return `${placement} w KQkq - 0 1`
}

// # Identity Player IDs PGN Tags and Labels

const GENERIC_NAMES = /^(|player|your name|spieler|joueur|unknown|testpgn|asdasd|white|black)$/i

export function formatPlayerId(username, wikiSite) {
  const user = (username || 'player').trim()
  const host = (wikiSite || 'localhost').trim()
  return `${host} (${user})`
}

// Default display name for an unauthenticated guest player. A guest seat is a plain
// editable name with no wiki host — it lives in the local PGN (and the preferred name
// is remembered in IndexedDB). On a site the visitor does not own, the seat rides the
// yellow Local Changes fork rather than the origin journal. Authenticated wiki owners
// get a federated "host (name)" seat instead.
export const GUEST_PLAYER_NAME = 'Guest'

// Plain guest display name (no wiki host) for the local seat of an unauthenticated viewer.
export function guestSeatName(guestName) {
  return String(guestName || '').trim() || GUEST_PLAYER_NAME
}

// True when a PGN seat is still a plain guest display name (no wiki domain) matching the
// remembered guest name — used to keep moves unlocked after sign-in until the seat is
// rewritten to a federated wiki identity.
export function isPlainGuestSeatTag(playerTag, guestName) {
  if (!playerTag || isOpenSeatTag(playerTag)) return false
  if (parseStockfishLevel(playerTag) != null) return false
  const parsed = parsePlayerId(playerTag)
  if (parsed?.domain) return false
  const trimmed = String(playerTag).trim()
  const guestId = guestSeatName(guestName)
  return trimmed === guestId || trimmed === GUEST_PLAYER_NAME
}

// Rewrite a plain guest seat to the signed-in wiki identity. Returns the (possibly
// unchanged) PGN. Upgrades at most one seat — White preferred when both match.
export function upgradeGuestSeatTagsToWikiIdentity(
  pgn,
  { signedInDisplayName, ownerName, wikiSite, guestName } = {},
) {
  if (!pgn || !/\[/.test(pgn)) return pgn
  const displayName = resolveSignedInUsername(signedInDisplayName || ownerName)
  if (!displayName) return pgn
  const localId = formatPlayerId(displayName, wikiSite || 'localhost')
  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')
  if (isPlainGuestSeatTag(white, guestName)) return formatPgn(setPgnTag(pgn, 'White', localId))
  if (isPlainGuestSeatTag(black, guestName)) return formatPgn(setPgnTag(pgn, 'Black', localId))
  return pgn
}

// The PGN tag the local viewer should occupy when they sit down:
//  - authenticated owner   -> federated wiki seat "host (name)"
//  - unauthenticated guest  -> a plain editable display name (no host)

export function localPlayerSeatId({ signedInDisplayName, ownerName, wikiSite, pageOnThisWiki = true, guestName } = {}) {
  if (pageOnThisWiki) {
    return formatPlayerId(
      resolveSignedInUsername(signedInDisplayName || ownerName) || 'player',
      wikiSite || 'localhost',
    )
  }
  return guestSeatName(guestName)
}

// Normalize user input (URL or host:port) to a wiki site host for PGN tags
export function normalizeWikiSiteInput(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).host
    } catch {
      return ''
    }
  }
  return value
    .replace(/^\/+|\/+$/g, '')
    .split('/')[0]
    .trim()
}

// Board label for an unclaimed human seat (PGN tag is blank)
export const OPEN_SEAT_LABEL = 'Open Seat'

// Open seat in PGN — blank tag; directed invite target is PGN ChallengeTarget.
export function openSeatPgnTag() {
  return ''
}

// Blank PGN seat tags count as open
export function isOpenSeatTag(playerId) {
  if (playerId == null) return false
  return !String(playerId).trim()
}

// Wiki site a directed challenge is aimed at (PGN ChallengeTarget).
// Blank or missing = open federation seek.
export function challengeTargetFromPgn(pgn) {
  return normalizeWikiSiteInput(getPgnTag(pgn, 'ChallengeTarget')) || ''
}

// Remove a PGN header tag (e.g. stale ChallengeTarget after accept).
export function clearPgnTag(pgn, tag) {
  const name = String(tag || '').trim()
  if (!name || !String(pgn || '').trim()) return formatPgn(pgn)
  const parts = parsePgnParts(pgn)
  if (!(name in parts.tags)) return formatPgn(pgn)
  delete parts.tags[name]
  return formatPgnParts(parts)
}

// Directed-invite target for an open seat — PGN ChallengeTarget only.
// Returns null when blank (open federation seek).
export function challengeOpponentWikiSite(pgn) {
  return challengeTargetFromPgn(pgn) || null
}

// Drop ChallengeTarget when it equals the viewing wiki (joiner leftover after accept).
export function stripSelfChallengeTarget(pgn, viewingSite) {
  const target = challengeTargetFromPgn(pgn)
  const viewing = normalizeWikiSite(viewingSite)
  if (!target || !viewing || normalizeWikiSite(target) !== viewing) return formatPgn(pgn)
  return clearPgnTag(pgn, 'ChallengeTarget')
}

// True when this seat invites the viewing wiki site to fork and claim
export function isOpenWikiChallengeSeat(playerId, viewingSite, challengeTarget) {
  if (!viewingSite || !isOpenSeatTag(playerId) || !challengeTarget) return false
  return normalizeWikiSite(challengeTarget) === normalizeWikiSite(viewingSite)
}

// White or Black seat that is still an open wiki challenge (guest, unclaimed)
export function opponentChallengeSeat(pgn, ctx = {}) {
  const siteCtx = {
    signedInDisplayName: ctx.signedInDisplayName || ctx.ownerName,
    wikiSite: pgnStampSite(ctx),
  }
  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')
  if (isLocalWikiPlayer(white, siteCtx) && isOpenSeatTag(black)) return 'Black'
  if (isLocalWikiPlayer(black, siteCtx) && isOpenSeatTag(white)) return 'White'
  return null
}

// Blank a seat to the open-challenge tag.
export function openChallengeSeat(pgn, seat) {
  if (seat !== 'White' && seat !== 'Black') return formatPgn(pgn)
  return formatPgn(setPgnTag(pgn, seat, openSeatPgnTag()))
}

// Stamp or clear the PeerMissing mark on a player's own game copy.
export function setPeerMissingPgnTag(pgn, missing = true) {
  if (missing) return formatPgn(setPgnTag(pgn, 'PeerMissing', 'yes'))
  const parts = parsePgnParts(pgn)
  delete parts.tags.PeerMissing
  return formatPgnParts(parts)
}

export function readPeerMissingPgnTag(pgn) {
  const raw = String(getPgnTag(pgn, 'PeerMissing') || '')
    .trim()
    .toLowerCase()
  return raw === 'yes' || raw === 'true' || raw === '1'
}

// Plain-text board / UI label: display name first, hostname secondary
// (matches My Chess Games seat rows).
export function formatPlayerDisplayLabel(name) {
  if (isOpenSeatTag(name)) return OPEN_SEAT_LABEL
  const parsed = parsePlayerId(name)
  if (!parsed) return String(name || '').trim()
  if (parsed.isEngine) {
    const level = parseStockfishLevel(parsed.username)
    return level != null ? stockfishDisplayLabel(level) : parsed.username
  }
  if (parsed.domain) return `${parsed.username} (${wikiSiteLinkLabel(parsed.domain)})`
  return parsed.full
}

// Human-facing seat name for the game-result banner. Wiki seats show just the display
// name ("Frank"); engines keep the full label including level and Elo
// ("Stockfish Level 6 (1810)") — their trailing "(rating)" is not a wiki display name.
export function seatResultBannerName(tag) {
  if (!tag || isOpenSeatTag(tag)) return formatPlayerDisplayLabel(tag)
  const parsed = parsePlayerId(tag)
  if (!parsed) return String(tag).trim()
  if (parsed.isEngine) return formatPlayerDisplayLabel(tag)
  return parsed.username
}

// Rewrite wiki player tags to the canonical host (name) form
export function canonicalWikiPlayerTag(name, _wikiSite) {
  const parsed = parsePlayerId(name)
  if (!parsed || parsed.isEngine) return name
  if (!parsed.domain) return name
  return formatPlayerId(parsed.username, parsed.domain)
}

// Wiki host for PGN tags — prefers shell-provided host, else current page
export function pgnStampSite(ctx = {}) {
  // Owned pages edit on the wiki in the address bar (localhost:3001), not the fork origin (ff.localhost).
  if (ctx.pageOnThisWiki && typeof globalThis.location !== 'undefined' && globalThis.location.host) {
    return globalThis.location.host
  }
  if (ctx.wikiSite) return ctx.wikiSite
  if (typeof globalThis.location !== 'undefined') return globalThis.location.host
  return 'localhost'
}

// Normalize FEN whitespace for comparison
export function normalizeFen(fen) {
  return String(fen || '')
    .trim()
    .replace(/\s+/g, ' ')
}

// True when FEN is the normal chess starting position (not a custom setup)
export function isStandardStartFen(fen) {
  return normalizeFen(fen) === START_FEN
}

// Remove SetUp/FEN tags when the position is the standard start (or FEN is absent)
export function stripDefaultSetupFen(pgn) {
  if (!pgn || !/\[/.test(pgn)) return pgn
  const parts = parsePgnParts(pgn)
  const fen = parts.tags.FEN
  if (!fen || isStandardStartFen(fen)) {
    delete parts.tags.SetUp
    delete parts.tags.FEN
  }
  return formatPgnParts(parts)
}

// Normalize player tags and canonicalize PGN layout for cm-pgn
export function prepareWikiPgn(pgn, ctx = {}) {
  const { signedInDisplayName = ctx.ownerName, wikiPageName, wikiPageTitle, wikiSiteUrl, itemId, pageOnThisWiki } = ctx
  let out = pgn
  const preserveLocalNames = canEditHumanPlayerNames(pgn, ctx)
  if (pageOnThisWiki && !preserveLocalNames) {
    out = normalizePgnPlayers(pgn, {
      signedInDisplayName,
      wikiSite: pgnStampSite(ctx),
    })
  } else if (pgn && /\[/.test(pgn)) {
    out = normalizePgnPlayersReadOnly(pgn)
  }
  out = ensureStandardPgnHeaders(out, { wikiPageName, wikiPageTitle, wikiSiteUrl, itemId })
  out = stripDefaultSetupFen(out)
  return formatPgn(out)
}

export function pgnHasMoves(pgn) {
  const movetext = parsePgnParts(pgn).movetext?.trim()
  if (!movetext || isCommentOrResultOnlyMovetext(movetext)) return false
  return /^\d+\./.test(movetext)
}

// True when movetext has no SAN — empty, a result token, and/or brace comments only.
// cm-pgn rejects leading `{comment}` / `{comment} *` with no moves; strip before parse.
export function isCommentOrResultOnlyMovetext(movetext) {
  const t = String(movetext || '').trim()
  if (!t || t === '*' || t === '""' || t === "''") return true
  const withoutComments = t
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!withoutComments) return true
  return /^(?:\*|1-0|0-1|1\/2-1\/2)$/.test(withoutComments)
}

// # Move Comments and Annotations
// cm-pgn stores a single string per move and re-wraps it in one `{ … }` when
// rendering. PGN brace comments do not nest, so any `{`/`}` the author types
// would terminate the comment early and corrupt the movetext. We also collapse
// newlines/tabs so the saved game stays a single tidy line in the wiki item.

export function sanitizeMoveCommentText(text) {
  return String(text == null ? '' : text)
    .replace(/[{}]/g, '') // braces can't appear inside a non-nesting comment
    .replace(/\s+/g, ' ')
    .trim()
}

// Multiple authors are joined with " · " (not a bare space) so the UI can split a
// merged comment back into "name + note" pairs even when a note contains spaces.
// The separator is stripped from names/notes below so it stays unambiguous.
export const MOVE_COMMENT_SEPARATOR = ' · '

// One annotator's note, e.g. "Ada: nice knight". The name is kept inside the
// comment (stripped of separators) so several people can share one move's
// comment without breaking the single `{ … }` wrapper cm-pgn produces.
export function formatMoveComment(name, text) {
  const body = sanitizeMoveCommentText(text).replace(/·/g, ' ').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const who = sanitizeMoveCommentText(name).replace(/[:·]/g, '').replace(/\s+/g, ' ').trim()
  return who ? `${who}: ${body}` : body
}

// Append a new note to a move's existing comment, returning a single string that
// is safe to assign to a cm-chess move's `commentAfter`.
export function appendMoveComment(existing, name, text) {
  const entry = formatMoveComment(name, text)
  const prev = sanitizeMoveCommentText(existing)
  if (!entry) return prev
  return prev ? `${prev}${MOVE_COMMENT_SEPARATOR}${entry}` : entry
}

// Repair cm-chess renderPgn quirks before saving or syncing.
// Also collapses accidental duplicated leading header blocks (headers pasted
// twice before movetext) so journal entries stay compact.
export function normalizeExportPgn(pgn) {
  if (!pgn || !/\[/.test(pgn)) return pgn
  const tags = {}
  let rest = String(pgn || '').trim()
  // parsePgnParts already merges consecutive tag blocks separated by blank
  // lines; loop in case a stray non-tag line split two header runs.
  for (let guard = 0; guard < 8; guard += 1) {
    const parts = parsePgnParts(rest)
    if (!Object.keys(parts.tags).length) break
    Object.assign(tags, parts.tags)
    rest = String(parts.movetext || '').trim()
    if (!/^\[/.test(rest)) break
  }
  if (isCommentOrResultOnlyMovetext(rest)) rest = ''
  return formatPgnParts({ tags, movetext: rest })
}

// Canonical PGN (or passthrough) for anything written to a chess item / journal.
export function canonicalizePersistedChessText(text) {
  const raw = String(text ?? '')
  const mode = parseItemMode(raw)
  const body = mode === 'GAME' ? stripModePrefix(raw, 'GAME') : raw
  const source = getFormat(body) === 'PGN' ? body : raw
  if (getFormat(source) !== 'PGN') return raw
  const canon = normalizeExportPgn(formatPgn(source))
  // Keep the GAME keyword so academy teaching items stay in game mode after saves.
  return mode === 'GAME' ? asGameItemText(canon) : canon
}

// PGN header tag for the side played by Stockfish (White or Black)
export function enginePgnSeat(whiteIsStockfish, blackIsStockfish) {
  if (whiteIsStockfish) return 'White'
  if (blackIsStockfish) return 'Black'
  return null
}

export function parsePlayerId(name) {
  if (!name) return null
  const trimmed = String(name).trim()
  const engine = trimmed.match(/^(stockfish level\s*\d+)$/i)
  if (engine) {
    return {
      username: engine[1],
      domain: null,
      full: trimmed,
      isEngine: true,
    }
  }
  // Display label from stockfishDisplayLabel — must not be parsed as wiki "host (name)".
  const engineWithElo = trimmed.match(/^(stockfish level\s*\d+)\s+\(\d+\)$/i)
  if (engineWithElo) {
    return {
      username: engineWithElo[1],
      domain: null,
      full: trimmed,
      isEngine: true,
    }
  }
  const hostFirst = trimmed.match(/^(.+?)\s+\(([^)]+)\)\s*$/)
  if (hostFirst) {
    return {
      username: hostFirst[2].trim(),
      domain: hostFirst[1].trim(),
      full: trimmed,
      isEngine: false,
    }
  }
  return { username: trimmed, domain: null, full: trimmed, isEngine: false }
}

export function isGenericPlayerName(name) {
  if (!name || !String(name).trim()) return true
  return GENERIC_NAMES.test(String(name).trim())
}

// Plain signed-in display name from wiki ownerName (handles host-first form)
export function resolveSignedInUsername(ownerName) {
  const raw = String(ownerName || '').trim()
  if (!raw) return ''
  const parsed = parsePlayerId(raw)
  if (parsed && !parsed.isEngine) return parsed.username
  return raw
}

// Compare wiki hosts ignoring port (ff.localhost vs ff.localhost:3001)
export function normalizeWikiSite(host) {
  if (!host) return ''
  return String(host).split('/')[0].split(':')[0].toLowerCase()
}

// Page `data-site` from a federated lineup (null when the page is on the current wiki)
export function parseWikiPageSite(pageSite) {
  if (!pageSite || pageSite === 'view' || pageSite === 'origin' || pageSite === 'local') {
    return null
  }
  return String(pageSite).trim() || null
}

// Wiki host for a chess item — remote lineup pages keep their origin site
export function resolveWikiSiteFromPageSite(pageSite, locationHost) {
  const remote = parseWikiPageSite(pageSite)
  if (remote) return remote
  const host = locationHost ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.host : 'localhost')
  return host || 'localhost'
}

// True once the security plugin has resolved whether the viewer owns this wiki.
// While undefined, FedWiki's pageHandler treats the user as a non-owner and forks
// origin edits into localStorage (yellow halo).
export function isWikiOwnerAuthResolved(isOwnerFlag) {
  return typeof isOwnerFlag !== 'undefined'
}

export function isBrowserLocalForkPageSite(pageSite, { isLocalClass = false } = {}) {
  return Boolean(isLocalClass || pageSite === 'local')
}

// Guest-only local persistence — never while owner auth is still loading (undefined
// isOwner is treated as non-owner by pageHandler and would wrongly fork to local).
// Create-preview lineup ghosts are included so a guest starting same-device (or any)
// play can materialize the page into a yellow-halo local fork without wiki owner login.
export function canOfferGuestLocalPersist({
  isOwnerFlag,
  isOwner = false,
  isPageOnCurrentWiki = false,
  isGhost = false,
  isCreatePreview = false,
  pageSite = '',
  locationHost = '',
} = {}) {
  if (!isWikiOwnerAuthResolved(isOwnerFlag) || isOwner) return false
  if (isPageOnCurrentWiki) return false
  if (isGhost && !isCreatePreview) return false
  const page = String(pageSite || '').trim()
  const loc = String(locationHost || '').trim()
  if (!page || !loc) return false
  return normalizeWikiSite(page) === normalizeWikiSite(loc)
}

// Hold origin-server journal puts until isOwner is known — avoids yellow-halo forks
// for signed-in owners during the async client-settings fetch.
export function shouldDeferOriginJournalPut({ isOwnerFlag, pageSite, isLocalPage = false, forkSite = '' } = {}) {
  if (forkSite || isLocalPage) return false
  if (isWikiOwnerAuthResolved(isOwnerFlag)) return false
  if (pageSite === 'local') return false
  return parseWikiPageSite(pageSite) == null
}

// Poll until fn returns true, or maxTries exhausted. fn receives 1-based try count.
export function pollWindowUntil(fn, { interval = 250, maxTries = 8, initialDelay = 150 } = {}) {
  let tries = 0
  const tick = () => {
    tries += 1
    if (fn(tries) !== false) return
    if (tries >= maxTries) return
    setTimeout(tick, interval)
  }
  setTimeout(tick, initialDelay)
}

// True when a WIKI_TAB_READY payload matches the installed PWA's current chess item.
export function pwaMatchesLinkedWikiTab(app = {}, tab = {}) {
  const appItemId = String(app.itemId || '').trim()
  const tabItemId = String(tab.itemId || '').trim()
  if (!appItemId || !tabItemId || appItemId !== tabItemId) return false
  const appSlug = String(app.slug || app.pageKey || '').trim()
  const tabSlug = String(tab.slug || tab.pageKey || '').trim()
  if (!appSlug || !tabSlug || appSlug === 'standalone' || appSlug === 'page') return true
  return appSlug === tabSlug
}

// Derived UI flags for PWA page chrome (halo, title input/link, save).
export function localSessionUiPolicy({
  isStandalone = false,
  isPwaJournalless = false,
  sessionResolved = false,
  sessionReachable = false,
  signedIn: _signedIn = false,
  showStartMenu = false,
  hasWikiPageTitle = false,
  hasWikiPageSlug = false,
  pendingJoinOrItem = false,
  canJournal = false,
} = {}) {
  const titleEditable = Boolean(pendingJoinOrItem || isPwaJournalless)
  const hasPageContext = Boolean(hasWikiPageTitle || hasWikiPageSlug || isPwaJournalless || pendingJoinOrItem)
  // Link only when the wiki page already exists (slug) and the title is no longer editable.
  const titleAsLink = Boolean(!titleEditable && !isPwaJournalless && hasWikiPageSlug)
  return {
    showHalo: Boolean(isStandalone && isPwaJournalless && sessionResolved && !canJournal),
    showPwaPageChrome: Boolean(isStandalone && !showStartMenu && hasPageContext),
    showSaveToWiki: Boolean(isPwaJournalless && sessionResolved && sessionReachable),
    titleEditable,
    titleAsLink,
  }
}

// True when the signed-in user may edit/autosave this page on the wiki in the address bar

export function isEditableWikiPage(pageSite, { isOwner = false, isGhost = false, locationHost } = {}) {
  if (!isOwner || isGhost) return false
  const remote = parseWikiPageSite(pageSite)
  const host = locationHost ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.host : '')
  if (!remote) return true
  return normalizeWikiSite(remote) === normalizeWikiSite(host)
}

// Stockfish tag cleanup only — preserves White/Black wiki player tags as stored in the journal
export function normalizePgnPlayersReadOnly(pgn) {
  if (!pgn || !/\[/.test(pgn)) return pgn
  let white = getPgnTag(pgn, 'White')
  let black = getPgnTag(pgn, 'Black')
  const levelWhite = parseStockfishLevel(white)
  if (levelWhite != null) white = stockfishPlayerId(levelWhite)
  const levelBlack = parseStockfishLevel(black)
  if (levelBlack != null) black = stockfishPlayerId(levelBlack)
  let normalized = pgn
  if (white != null) normalized = setPgnTag(normalized, 'White', white)
  if (black != null) normalized = setPgnTag(normalized, 'Black', black)
  return formatPgn(normalized)
}

export function isLocalWikiPlayer(playerId, { signedInDisplayName, ownerName, wikiSite } = {}) {
  void signedInDisplayName
  void ownerName
  if (!playerId || parseStockfishLevel(playerId) != null) return false
  const host = wikiSite || (typeof globalThis.location !== 'undefined' ? globalThis.location.host : 'localhost')
  return playerTagOnViewingWikiSite(playerId, host)
}

function isOtherWikiPlayer(playerId, { signedInDisplayName, ownerName, wikiSite } = {}) {
  void signedInDisplayName
  void ownerName
  if (!playerId || parseStockfishLevel(playerId) != null) return false
  if (isGenericPlayerName(playerId)) return false
  const parsed = parsePlayerId(playerId)
  if (!parsed?.domain) return false
  return !playerTagOnViewingWikiSite(playerId, wikiSite)
}

// True when a human seat on an owned page should use the editor wiki host (not a foreign domain)
function shouldRealignHumanSeatToEditorWiki(tag, oppositeTag, editorHost) {
  if (!tag || isOpenSeatTag(tag)) return false
  if (parseStockfishLevel(tag) != null) return false
  if (playerTagOnViewingWikiSite(tag, editorHost)) return false
  if (parseStockfishLevel(oppositeTag) != null || isOpenSeatTag(oppositeTag)) return true
  if (isWikiLinkedPlayerTag(oppositeTag) && !playerTagOnViewingWikiSite(oppositeTag, editorHost)) {
    return false
  }
  const parsed = parsePlayerId(tag)
  return !parsed?.domain
}

export function getSeatClaimOffer(
  pgn,
  { signedInDisplayName, ownerName, wikiSite, pageOnThisWiki, guestName, wikiJoinId } = {},
) {
  if (!pgn || !/\[/.test(pgn)) return null
  if (getHumanPlayMode(pgn) === HUMAN_PLAY_SAME_DEVICE) return null

  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')

  // An unauthenticated guest can only sit down in an open seat, and only as a plain
  // guest name (no wiki challenge / takeover). Their game stays local — never journaled.
  // A signed-in wiki owner browsing a remote challenge in their lineup uses `wikiJoinId`
  // for the same open-seat-only rule, but keeps their federated seat name.
  if (!pageOnThisWiki) {
    const localId = wikiJoinId || guestSeatName(guestName)
    const guestHoldsSeat = white === localId || black === localId
    const options = []
    for (const [seat, tag] of [
      ['White', white],
      ['Black', black],
    ]) {
      if (guestHoldsSeat || !isOpenSeatTag(tag)) continue
      options.push({ seat, current: tag || '', challenge: false })
    }
    return options.length ? { localId, options } : null
  }

  const displayName = signedInDisplayName || ownerName
  if (!displayName) return null
  const challengeTarget = challengeOpponentWikiSite(pgn)

  const viewerHoldsSeat =
    isLocalWikiPlayer(white, { signedInDisplayName: displayName, wikiSite }) ||
    isLocalWikiPlayer(black, { signedInDisplayName: displayName, wikiSite })

  const claimableSeat = tag => {
    if (isLocalWikiPlayer(tag, { signedInDisplayName: displayName, wikiSite })) return false
    if (isOpenSeatTag(tag)) {
      // Seated page owner is waiting for an opponent — they invite via the open-seat
      // label, not "Take seat" on their own wiki copy.
      if (viewerHoldsSeat && getHumanPlayMode(pgn) === HUMAN_PLAY_CORRESPONDENCE) return false
      return true
    }
    // Taking over someone else's wiki seat is only for the third-party fork case.
    return !viewerHoldsSeat && isOtherWikiPlayer(tag, { signedInDisplayName: displayName, wikiSite })
  }

  const options = []
  for (const [seat, tag] of [
    ['White', white],
    ['Black', black],
  ]) {
    if (!claimableSeat(tag)) continue
    options.push({
      seat,
      current: tag || '',
      challenge: isOpenWikiChallengeSeat(tag, wikiSite, challengeTarget),
    })
  }
  if (!options.length) return null

  const localId = formatPlayerId(resolveSignedInUsername(displayName) || 'player', wikiSite || 'localhost')
  return { localId, options }
}

// Replace White or Black in PGN with the local viewer (owner wiki seat or guest name)

export function claimSeat(
  pgn,
  seat,
  { signedInDisplayName, ownerName, wikiSite, pageOnThisWiki = true, guestName, wikiJoinId } = {},
) {
  if (seat !== 'White' && seat !== 'Black') return formatPgn(pgn)
  const localId =
    wikiJoinId ||
    localPlayerSeatId({
      signedInDisplayName: signedInDisplayName || ownerName,
      wikiSite,
      pageOnThisWiki,
      guestName,
    })
  const updated = formatPgn(setPgnTag(pgn, seat, localId))
  // A guest's plain-name seat must skip owner-identity normalization, which would
  // otherwise realign it to the wiki host / owner. Authenticated owners keep it.
  if (!pageOnThisWiki) return updated
  return normalizePgnPlayers(updated, {
    signedInDisplayName: signedInDisplayName || ownerName,
    wikiSite,
  })
}

export function faviconUrl(domain) {
  if (!domain) return null
  const host = domain.split('/')[0]
  const hostName = host.split(':')[0]
  const hostPort = host.includes(':') ? host.split(':').slice(1).join(':') : null

  if (typeof globalThis.location !== 'undefined') {
    const { hostname, port, protocol } = globalThis.location
    const sameServer =
      normalizeWikiSite(hostName) === normalizeWikiSite(hostname) ||
      (hostname.endsWith('.localhost') && hostName.endsWith('.localhost'))

    if (sameServer) {
      const portSuffix = hostPort || port ? `:${hostPort || port}` : ''
      return `${protocol}//${hostName}${portSuffix}/favicon.png`
    }
  }

  const portSuffix = hostPort ? `:${hostPort}` : ''
  return `//${hostName}${portSuffix}/favicon.png`
}

export const WIKI_HOME_PAGE_SLUG = 'welcome-visitors'

// Hostname (no port) that may be served over plain HTTP in local/LAN setups.
function isHttpOkHostname(name) {
  const host = String(name || '')
    .trim()
    .toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host === '::1') return true
  if (/\.(localhost|local)$/i.test(host)) return true
  // IPv4 loopback, RFC1918 private, and link-local (phone → laptop over Wi‑Fi).
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

// True when a wiki host is local loopback, *.localhost / *.local, or a private LAN IP.
export function isLoopbackWikiHost(host) {
  const h = String(host || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
  if (!h) return false
  // IPv4 host:port — take the name before the port. Bracketed IPv6 is uncommon in farm hosts.
  const name = /^\[[^\]]+\]/.test(h) ? h.slice(1, h.indexOf(']')) : h.split(':')[0]
  return isHttpOkHostname(name)
}

export function protocolForWikiSite(host) {
  return isLoopbackWikiHost(host) ? 'http' : 'https'
}

function cleanWikiSite(host) {
  return String(host || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .trim()
}

// Hostname for visible link text — omits port except on loopback wikis where it identifies the site.
export function wikiSiteLinkLabel(host) {
  const cleaned = cleanWikiSite(host)
  if (!cleaned) return ''
  const colon = cleaned.indexOf(':')
  if (colon === -1) return cleaned
  const hostname = cleaned.slice(0, colon)
  const port = cleaned.slice(colon + 1)
  if (isLoopbackWikiHost(cleaned)) return cleaned
  if (port === '80' || port === '443') return hostname
  return hostname
}

// Named window target for cross-wiki navigation (matches wiki fork journal links).
export function wikiSiteLinkTarget(host) {
  const cleaned = cleanWikiSite(host)
  return cleaned ? cleaned.split(':')[0] : '_blank'
}

// Full URL to a wiki page — used for player-site links from the chess iframe.
export function wikiSitePageUrl(host, slug = WIKI_HOME_PAGE_SLUG) {
  const cleaned = cleanWikiSite(host)
  if (!cleaned) return ''
  const page = String(slug || WIKI_HOME_PAGE_SLUG)
    .replace(/\.json$/i, '')
    .replace(/\.html$/i, '')
  return `${protocolForWikiSite(cleaned)}://${cleaned}/${page}.html`
}

export function playerWikiSiteLinkHtml(domain, username, { className = 'wiki-chess-wiki-site-link' } = {}) {
  if (!domain) return ''
  const href = wikiSitePageUrl(domain)
  const label = wikiSiteLinkLabel(domain)
  const target = wikiSiteLinkTarget(domain)
  const domainLink = `<a class="${className}" href="${escapeHtml(href)}" target="${escapeHtml(target)}" rel="noopener noreferrer" title="Visit ${escapeHtml(label)}">${escapeHtml(label)}</a>`
  // Display name first; domain secondary (matches My Chess Games seat rows).
  if (!username) return domainLink
  return `${escapeHtml(username)} <span class="wiki-chess-wiki-site-label">${domainLink}</span>`
}

// Prefer PGN [White]/[Black] tags — player.name can lag or omit @wikiSite.
// Returns the canonical host-first wiki tag (`host (name)`), not a display label —
// playerBarHtml / playerFaviconHtml / parsePlayerId all expect that form. Display
// order (name first) is applied in playerWikiSiteLinkHtml.
// Engine seats show level only here; UCI Elo is rendered beside the name in the player bar.
export function boardPlayerLabelFromPgn(player, console) {
  if (isStockfishPlayer(player)) {
    return stockfishPlayerId(player.state.level)
  }
  const tags = console?.state?.chess?.pgn?.header?.tags
  if (tags && console?.playerWhite && console?.playerBlack) {
    if (player === console.playerWhite()) {
      const tag = tags.White || boardPlayerLabel(player)
      const level = parseStockfishLevel(tag)
      if (level != null) return stockfishPlayerId(level)
      return tag
    }
    if (player === console.playerBlack()) {
      const tag = tags.Black || boardPlayerLabel(player)
      const level = parseStockfishLevel(tag)
      if (level != null) return stockfishPlayerId(level)
      return tag
    }
  }
  return boardPlayerLabel(player)
}

export function getPgnTag(pgn, tag) {
  const re = new RegExp(`\\[${tag}\\s+"([^"]*)"]`, 'i')
  const match = pgn.match(re)
  return match ? match[1] : null
}

const PGN_HEADER_ORDER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'SetUp', 'FEN']

const PGN_TAG_PREFIX_RE = /^\[(\w+)\s+"([^"]*)"\]\s*/

// Split PGN into header tags and movetext (handles inline tag blocks)
export function parsePgnParts(pgn) {
  const tags = {}
  // Academy item text is often `GAME\n[Event…]…` — strip the mode keyword so tags
  // and movetext parse the same as a bare scoresheet (journal glyphs, has-moves, etc.).
  const mode = parseItemMode(pgn)
  const text = (mode === 'GAME' ? stripModePrefix(pgn, 'GAME') : String(pgn || '')).trim()
  if (!text) return { tags, movetext: '' }

  let pos = 0
  while (pos < text.length) {
    const match = text.slice(pos).match(PGN_TAG_PREFIX_RE)
    if (!match) break
    tags[match[1]] = match[2]
    pos += match[0].length
  }
  return { tags, movetext: text.slice(pos).trim() }
}

// Rebuild PGN with one tag per line and a blank line before movetext
export function formatPgnParts({ tags, movetext }) {
  const used = new Set()
  let header = ''
  for (const tag of PGN_HEADER_ORDER) {
    if (tags[tag] != null) {
      header += `[${tag} "${tags[tag]}"]\n`
      used.add(tag)
    }
  }
  for (const tag of Object.keys(tags)) {
    if (!used.has(tag)) header += `[${tag} "${tags[tag]}"]\n`
  }
  if (!movetext) return header.trimEnd()
  return `${header}\n${movetext}`
}

// Canonicalize PGN header layout for cm-pgn (requires blank line before moves)
export function formatPgn(pgn) {
  if (!pgn || !/\[/.test(pgn)) return pgn
  const parts = parsePgnParts(pgn)
  if (!Object.keys(parts.tags).length) return pgn
  if (isCommentOrResultOnlyMovetext(parts.movetext)) {
    parts.movetext = ''
  }
  return formatPgnParts(parts)
}

export function setPgnTag(pgn, tag, value) {
  const text = String(pgn || '')
  if (!/\[/.test(text)) {
    return formatPgnParts({ tags: { [tag]: value }, movetext: text.trim() })
  }
  const parts = parsePgnParts(text)
  parts.tags[tag] = value
  return formatPgnParts(parts)
}

// # Game Result and Outcome Copy
// The PGN `Result` tag carries the score; the standard `Termination` tag (PGN spec)
// flags HOW/why a game ended — but ONLY for the spec's enumerated values: "abandoned",
// "adjudication", "death", "emergency", "normal", "rules infraction", "time forfeit",
// "unterminated". Crucially the spec has NO value for resignation / checkmate /
// agreement / stalemate: a game decided under the normal rules is just "normal", and
// which of those it was is not recorded by PGN at all.
//
// So the plugin DERIVES the human "how" from the result + the live board:
//   - a checkmate / stalemate on the board is read directly;
//   - this is a clock-less correspondence app (no game is ever lost on time), so a
//     DECISIVE game that ended "normal" with no mate on the board can only have been a
//     resignation — we infer it.
// An explicit non-"normal" Termination (abandoned, time forfeit on an imported PGN,
// adjudication, …) always wins over the inference. These helpers are pure so the result
// banner reads the same everywhere.

export const RESULT_WHITE_WIN = '1-0'
export const RESULT_BLACK_WIN = '0-1'
export const RESULT_DRAW = '1/2-1/2'

export function isDecisiveResult(result) {
  const r = String(result || '').trim()
  return r === RESULT_WHITE_WIN || r === RESULT_BLACK_WIN || r === RESULT_DRAW
}

export function seatScoreFromResult(result, seatColor) {
  const seat = seatColor === 'b' || seatColor === 'Black' ? 'Black' : 'White'
  if (!isDecisiveResult(result)) return null
  if (result === RESULT_DRAW) return 0.5
  if (result === RESULT_WHITE_WIN) return seat === 'White' ? 1 : 0
  return seat === 'Black' ? 1 : 0
}

function pgnMovetextHasCheckmate(pgn) {
  return /#/.test(parsePgnParts(pgn).movetext || '')
}

export function gameResultFromPgn(pgn) {
  return describeGameResult(pgn, { isCheckmate: pgnMovetextHasCheckmate(pgn) })
}

// Standard PGN Termination value for an ordinary, rules-decided game (resignation,
// checkmate, agreement…). This is what the resign flow and the seed stamp; the specific
// cause is then derived (board + clock-less inference), never invented in the tag.
export const TERMINATION_NORMAL = 'normal'

// Map a `Termination` tag value onto a method token the UI knows how to phrase. The
// standard "normal"/"unterminated" carry no specific cause, so they return '' and let
// the caller infer from the board. Non-standard but common values (resignation,
// agreement, stalemate, threefold…) that appear in imported/real-world PGNs are also
// recognized so an explicit cause is honoured when present.
export function normalizeTermination(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  if (!v || v === 'normal' || v === 'unterminated') return ''
  // Standard PGN values.
  if (v.includes('abandon')) return 'abandoned'
  if (v.includes('adjudicat')) return 'adjudication'
  if (v.includes('rules') || v.includes('infraction') || (v.includes('forfeit') && !v.includes('time')))
    return 'forfeit'
  if (v.includes('time')) return 'time' // "time forfeit"
  if (v.includes('death') || v.includes('emergency')) return 'default'
  // Non-standard but common in real-world PGNs (Lichess/chess.com style): honour them.
  if (v.includes('checkmate') || v === 'mate') return 'checkmate'
  if (v.includes('resign')) return 'resignation'
  if (v.includes('stalemate')) return 'stalemate'
  if (v.includes('agree')) return 'agreement'
  if (v.includes('insufficient')) return 'insufficient'
  if (v.includes('repetition') || v.includes('threefold')) return 'repetition'
  if (v.includes('fifty')) return 'fifty-move'
  return ''
}

export function describeGameResult(pgn, { isCheckmate = false, isStalemate = false } = {}) {
  const result = getPgnTag(pgn, 'Result')
  const whiteWin = result === RESULT_WHITE_WIN
  const blackWin = result === RESULT_BLACK_WIN
  const draw = result === RESULT_DRAW
  if (!whiteWin && !blackWin && !draw) {
    return { over: false, result: result || '*', draw: false, winnerColor: null, method: '' }
  }
  let method = normalizeTermination(getPgnTag(pgn, 'Termination'))
  // No explicit cause in the tag ("normal" / missing): derive it.
  if (!method) {
    if (isCheckmate) method = 'checkmate'
    else if (draw)
      method = isStalemate ? 'stalemate' : '' // can't tell agreement from a draw tag
    // A decisive, rules-decided game with no mate on a clock-less board = resignation.
    else method = 'resignation'
  }
  return {
    over: true,
    result,
    draw,
    winnerColor: whiteWin ? 'w' : blackWin ? 'b' : null,
    method,
  }
}

const RESULT_METHOD_PHRASE = {
  checkmate: 'by checkmate',
  resignation: 'by resignation',
  time: 'on time',
  abandoned: 'by abandonment',
  adjudication: 'by adjudication',
  forfeit: 'by forfeit',
  default: 'by default',
}

const DRAW_METHOD_PHRASE = {
  stalemate: 'by stalemate',
  agreement: 'by agreement',
  insufficient: 'by insufficient material',
  repetition: 'by threefold repetition',
  'fifty-move': 'by the fifty-move rule',
  adjudication: 'by adjudication',
}

export function formatGameResultSentence({ result, method = '', whiteName, blackName } = {}) {
  const white = String(whiteName || '').trim() || 'White'
  const black = String(blackName || '').trim() || 'Black'
  if (result === RESULT_DRAW) {
    const phrase = DRAW_METHOD_PHRASE[method]
    return phrase ? `Draw ${phrase}` : 'Draw'
  }
  if (result === RESULT_WHITE_WIN || result === RESULT_BLACK_WIN) {
    const winner = result === RESULT_WHITE_WIN ? white : black
    const phrase = RESULT_METHOD_PHRASE[method]
    return phrase ? `${winner} won ${phrase}` : `${winner} won`
  }
  return ''
}

// PGN Date tag value (YYYY.MM.DD)
export function pgnDateTag(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

// Standard PGN UTCDate/UTCTime tag values — the game's start instant, so same-day
// games stay distinguishable in game lists.
export function pgnUtcDateTag(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

export function pgnUtcTimeTag(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const h = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  const s = String(d.getUTCSeconds()).padStart(2, '0')
  return `${h}:${min}:${s}`
}

// Local Date instance for a game's start, from its UTCDate/UTCTime tags. null when
// the tags are missing or unparseable (games created before start times were stamped).
export function gameStartInstant({ utcDate, utcTime } = {}) {
  const dm = String(utcDate || '')
    .trim()
    .match(/^(\d{4})\.(\d{2})\.(\d{2})$/)
  const tm = String(utcTime || '')
    .trim()
    .match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!dm || !tm) return null
  const d = new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] || 0)))
  return Number.isNaN(d.getTime()) ? null : d
}

// Full wiki origin URL for PGN Site tags (protocol + host)
export function buildWikiSiteUrl(wikiSite) {
  if (wikiSite && /^https?:\/\//i.test(String(wikiSite))) {
    return String(wikiSite).replace(/\/$/, '')
  }
  if (typeof globalThis.location !== 'undefined') {
    const host = wikiSite || globalThis.location.host
    return `${globalThis.location.protocol}//${host}`
  }
  const host = wikiSite || 'localhost'
  return `http://${host}`
}

// Page titles are "White vs Black" matchups — not tournament/event names.
export function pageTitleLooksLikeMatchup(title = '') {
  const t = String(title || '').trim()
  if (!t) return false
  if (/\bplays\b[\s\S]+\bvs\b/i.test(t)) return true
  return /\s+vs\s+/i.test(t)
}

// Ghost pages spawned from CHOOSE / "New Chess Page" carry placeholder titles ("New
// Chess Game") and slugs ("new-chess-page", possibly dedup-suffixed) — never real
// event names, so game lists must not show them.
export function isPlaceholderPgnEvent(value = '') {
  const v = String(value || '').trim()
  if (!v) return false
  return /^new[\s-]chess[\s-](game|position|puzzle|page)(?:[\s-]*\(?\d+\)?)?$/i.test(v)
}

export function resolvePgnEvent({ wikiPageTitle, wikiPageName, pgnEvent } = {}) {
  if (pgnEvent != null && String(pgnEvent).trim()) return String(pgnEvent).trim()

  const title = wikiPageTitle != null ? String(wikiPageTitle).trim() : ''
  if (title && !pageTitleLooksLikeMatchup(title) && !isPlaceholderPgnEvent(title)) return title

  const slug =
    wikiPageName && wikiPageName !== 'page' && wikiPageName !== 'standalone' ? String(wikiPageName).trim() : ''
  if (slug && !isPlaceholderPgnEvent(slug)) return slug

  return 'Federated Wiki Chess'
}

export function resolvePgnSite({ wikiSiteUrl, wikiSite, itemId } = {}) {
  const origin = buildWikiSiteUrl(wikiSiteUrl || wikiSite)
  const id = itemId && itemId !== 'standalone' ? String(itemId).trim() : null
  return id ? `${origin} (id: ${id})` : origin
}

export function ensureStandardPgnHeaders(pgn, ctx = {}) {
  if (!pgn || !/\[/.test(pgn)) return pgn

  const parts = parsePgnParts(pgn)
  const tags = { ...parts.tags }
  const { wikiPageTitle, wikiPageName } = ctx
  if (!tags.Event) {
    tags.Event = resolvePgnEvent({
      wikiPageTitle: pageTitleLooksLikeMatchup(wikiPageTitle) ? '' : wikiPageTitle,
      wikiPageName,
      pgnEvent: ctx.pgnEvent,
    })
  }
  if (!tags.Site) {
    tags.Site = resolvePgnSite(ctx)
  }
  if (!tags.Date) {
    tags.Date = pgnDateTag()
  }
  if (!tags.Round) {
    tags.Round = '-'
  }
  if (!tags.Result) {
    tags.Result = '*'
  }

  return formatPgnParts({ tags, movetext: parts.movetext })
}

// Re-apply saved header tags when a live export omits them (e.g. cm-pgn renderPgn)
export function mergePgnWithSavedHeaders(exported, savedPgn) {
  if (!exported || !/\[/.test(exported)) return exported
  const savedTags = parsePgnParts(savedPgn).tags
  const parts = parsePgnParts(exported)
  for (const tag of [
    'Event',
    'Site',
    'Date',
    'Round',
    'Result',
    'HumanPlay',
    'Comments',
    'Demo',
    'Lesson',
    'StartView',
    'Termination',
    'Rated',
    'ChallengeCreator',
    'CreatorColor',
    'MinRating',
    'MaxRating',
    'ChallengeTarget',
    'ChallengeTs',
    'CreatorRating',
    'PeerMissing',
  ]) {
    const saved = savedTags[tag]
    const exported = parts.tags[tag]
    if (!saved) continue
    // cm-pgn keeps Result "*" while a game is in progress; prefer a decisive saved
    // result (resignation, checkmate, …) so autosave does not wipe a just-recorded ending.
    if (tag === 'Result' && saved !== '*' && (!exported || exported === '*')) {
      parts.tags[tag] = saved
      continue
    }
    if (!exported) {
      parts.tags[tag] = saved
    }
  }
  // An open seat is stored as an empty tag (e.g. [Black ""]), but the board's PGN
  // library (cm-pgn) drops any tag with an empty value, so it disappears from a board
  // re-render. Restore an empty seat from the source PGN — checking presence, not
  // truthiness, since "" is intentional. Without this a dropped open seat reads as a
  // missing seat downstream and gets back-filled with a Stockfish opponent (see
  // normalizePgnPlayers), turning a human game into a game vs the engine on reload.
  for (const seat of ['White', 'Black']) {
    if (parts.tags[seat] == null && savedTags[seat] != null) {
      parts.tags[seat] = savedTags[seat]
    }
  }
  return formatPgnParts(parts)
}

export const STOCKFISH_MAX_LEVEL = 20

// Bundled engine version, mirroring the worker asset `stockfish-18-lite-single.js`.
// Single-sourced here so the UI label and the worker filename can't drift apart.
export const STOCKFISH_VERSION = '18'

export function stockfishPlayerId(level) {
  const n = Math.max(1, Math.min(STOCKFISH_MAX_LEVEL, parseInt(level, 10) || 1))
  return `Stockfish Level ${n}`
}

export function parseStockfishLevel(name) {
  const match = String(name || '').match(/^stockfish level\s*(\d+)/i)
  return match ? parseInt(match[1], 10) : null
}

// Compact Stockfish label with Elo, e.g. "Stockfish Level 3 (1520)". Used in result
// banners and lists where there is no separate rating badge. Board player bars use
// `stockfishPlayerId` for the name and show Elo beside it via `.wiki-chess-rating`.
export function stockfishDisplayLabel(level) {
  return `${stockfishPlayerId(level)} (${stockfishLevelElo(level)})`
}

export function isStockfishPlayer(player) {
  return player?.state?.level != null
}

export function boardPlayerLabel(player) {
  if (isStockfishPlayer(player)) {
    return stockfishPlayerId(player.state.level)
  }
  const fromName = parseStockfishLevel(player?.name)
  if (fromName != null) return stockfishPlayerId(fromName)
  return player?.name || ''
}

export function defaultOpponentId() {
  return stockfishPlayerId(1)
}

export function buildSetupPgn(fen, tags = {}) {
  let pgn = `[SetUp "1"]\n[FEN "${fen}"]`
  for (const [tag, value] of Object.entries(tags)) {
    pgn = setPgnTag(pgn, tag, value)
  }
  return pgn
}

// Whether a PGN player tag is seated on the wiki site being viewed
export function playerTagOnViewingWikiSite(playerId, viewingSite) {
  if (!playerId || !viewingSite || parseStockfishLevel(playerId) != null) return false
  const parsed = parsePlayerId(playerId)
  if (!parsed?.domain) return false
  return normalizeWikiSite(parsed.domain) === normalizeWikiSite(viewingSite)
}

export function resolveLocalPlayerColor(pgn, ctx = {}) {
  if (getHumanPlayMode(pgn) === HUMAN_PLAY_SAME_DEVICE) {
    return 'w'
  }
  const { wikiSite, pageOnThisWiki } = ctx
  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')
  // A guest has no wiki domain to match on, so find the plain-name seat they hold.
  if (ctx.isGuest) {
    const guestId = guestSeatName(ctx.guestName)
    return black === guestId && white !== guestId ? 'b' : 'w'
  }
  // Signed in mid-game: seat may still be the plain guest name until upgraded.
  if (isPlainGuestSeatTag(black, ctx.guestName) && !isPlainGuestSeatTag(white, ctx.guestName)) {
    return 'b'
  }
  if (isPlainGuestSeatTag(white, ctx.guestName)) {
    return 'w'
  }
  const viewingSite = pgnStampSite({ wikiSite, pageOnThisWiki })
  const whiteOnSite = playerTagOnViewingWikiSite(white, viewingSite)
  const blackOnSite = playerTagOnViewingWikiSite(black, viewingSite)

  if (whiteOnSite && blackOnSite) return 'w'
  if (blackOnSite) return 'b'
  if (whiteOnSite) return 'w'
  return 'w'
}

// True when a player tag uses the canonical host (name) wiki identity
export function isWikiLinkedPlayerTag(name) {
  const parsed = parsePlayerId(name)
  if (!parsed || parsed.isEngine) return false
  return Boolean(parsed.domain)
}

// Plain seat names (not Stockfish, not host (name) wiki seats) may be click-edited
// on the board; the rename lands in the journal on the next saved move.
export function isManuallyEditablePlayerTag(name) {
  if (name == null || isOpenSeatTag(name)) return false
  if (parseStockfishLevel(name) != null) return false
  return !isWikiLinkedPlayerTag(name)
}

function humanDisplayName(ownerName, fallback = 'Player 1') {
  const name = String(ownerName || '').trim()
  if (name && !isGenericPlayerName(name)) return name
  return fallback
}

// Human vs human with plain names — not federated wiki seats (guest / foreign host)
export function canEditHumanPlayerNames(pgn, ctx = {}) {
  if (!pgn || !/\[/.test(pgn)) return false
  const white = getPgnTag(pgn, 'White')
  const black = getPgnTag(pgn, 'Black')
  if (parseStockfishLevel(white) != null || parseStockfishLevel(black) != null) return false

  if (getHumanPlayMode(pgn) === HUMAN_PLAY_SAME_DEVICE) return true

  const guestSeat = [white, black].some(tag => isOpenSeatTag(tag))
  if (guestSeat) return false

  const { signedInDisplayName = ctx.ownerName, wikiSite, pageOnThisWiki } = ctx
  const siteCtx = {
    signedInDisplayName,
    wikiSite: pgnStampSite({ wikiSite, pageOnThisWiki }),
  }
  if (isOtherWikiPlayer(white, siteCtx) || isOtherWikiPlayer(black, siteCtx)) return false

  const plainName = tag => {
    const parsed = parsePlayerId(tag)
    return parsed && !parsed.isEngine && !parsed.domain && !isGenericPlayerName(tag)
  }
  return plainName(white) && plainName(black)
}

// Update a White/Black header with a plain display name (no wiki host wrapper)
export function setHumanPlayerName(pgn, seat, displayName) {
  if (seat !== 'White' && seat !== 'Black') return formatPgn(pgn)
  const name = String(displayName || '').trim()
  if (!name) return formatPgn(pgn)
  return formatPgn(setPgnTag(pgn, seat, name))
}

export function playerDisplayLabel(name) {
  if (!name) return ''
  const parsed = parsePlayerId(name)
  if (!parsed) return String(name)
  if (parsed.isEngine) return parsed.username
  if (parsed.domain) return `${parsed.username} (${wikiSiteLinkLabel(parsed.domain)})`
  return parsed.full
}

// First-paragraph / chrome lead when someone accepts a federation open challenge.
export function openChallengeAcceptParagraph(joinerLabel, creatorLabel) {
  const joiner = String(joinerLabel || '').trim() || 'You'
  const creator = String(creatorLabel || '').trim() || 'another wiki'
  const verb = /^you$/i.test(joiner) ? 'accept' : 'accepts'
  return `${joiner} ${verb} an open challenge from ${creator}.`
}

export function playerDisplayLabelHtml(name) {
  if (!name) return ''
  const parsed = parsePlayerId(name)
  if (!parsed) return escapeHtml(String(name))
  if (parsed.isEngine) return escapeHtml(parsed.username)
  if (parsed.domain) return playerWikiSiteLinkHtml(parsed.domain, parsed.username)
  return escapeHtml(parsed.full)
}

export const HUMAN_PLAY_CORRESPONDENCE = 'correspondence'
export const HUMAN_PLAY_SAME_DEVICE = 'same-device'

// Map start-modal colour dropdown values (human/engine picker or open-challenge picker).
export function parseStartModalColorChoice(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  if (v === 'random') {
    return { localSeat: 'w', creatorColor: 'random', isRandom: true }
  }
  if (v === 'b' || v === 'black') {
    return { localSeat: 'b', creatorColor: 'black', isRandom: false }
  }
  return { localSeat: 'w', creatorColor: 'white', isRandom: false }
}

// Map start-modal / PGN play-mode values onto the two canonical modes.
export function normalizeHumanPlayMode(mode) {
  return mode === HUMAN_PLAY_SAME_DEVICE ? HUMAN_PLAY_SAME_DEVICE : HUMAN_PLAY_CORRESPONDENCE
}

// Which sections of the shared start-game modal to show for a given opponent mode.
export function positionStartModalFields({
  opponent = 'engine',
  humanPlayMode = HUMAN_PLAY_CORRESPONDENCE,
  opponentWikiSite = '',
  // Survey "Post open challenge" hides same-device — that flow is challenge-only.
  hideHumanPlayChoice = false,
} = {}) {
  // Challenge-only setup always means networked correspondence.
  const effectiveMode = hideHumanPlayChoice ? HUMAN_PLAY_CORRESPONDENCE : humanPlayMode
  const playChosen =
    effectiveMode === HUMAN_PLAY_SAME_DEVICE ||
    effectiveMode === HUMAN_PLAY_CORRESPONDENCE ||
    effectiveMode === 'remote'
  const playMode = playChosen ? normalizeHumanPlayMode(effectiveMode) : null
  const isEngine = opponent === 'engine'
  const isHumanRemote = opponent === 'human' && playMode === HUMAN_PLAY_CORRESPONDENCE
  const isSameDevice = opponent === 'human' && playMode === HUMAN_PLAY_SAME_DEVICE
  const rawWikiSite = String(opponentWikiSite || '').trim()
  const normalizedWikiSite = normalizeWikiSiteInput(opponentWikiSite)
  const wikiInputInvalidFormat = isHumanRemote && Boolean(rawWikiSite) && !normalizedWikiSite
  // Human on different devices = post a challenge (open if no wiki target, directed if set).
  const isChallengePost = isHumanRemote && !wikiInputInvalidFormat
  const isOpenChallenge = isChallengePost && !rawWikiSite
  return {
    showChallengeWrap: isChallengePost,
    showLevelWrap: isEngine,
    // Engine games always track the personal vs-Stockfish rating (no picker). Same-device is
    // always casual; remote human challenges use positionChallengeRated instead.
    showRatedWrap: false,
    // Always offer same-device vs remote when playing a human (unless challenge-only setup).
    showHumanPlayWrap: opponent === 'human' && !hideHumanPlayChoice,
    // Orientation / flip / piece set — only after Same device is chosen.
    showSameDeviceWrap: isSameDevice,
    showOpponentWikiWrap: isHumanRemote,
    showHumanColorWrap: isEngine,
    showHumanHint: isHumanRemote,
    playModeChosen: Boolean(playMode),
    isEngine,
    isChallenge: isChallengePost,
    isChallengePost,
    isOpenChallenge,
    isSameDevice,
    isRemote: isHumanRemote,
    rawWikiSite,
    normalizedWikiSite,
    wikiInputInvalidFormat,
    hasWikiSiteIntent: Boolean(rawWikiSite),
  }
}

// Write `[HumanPlay]` — switch how two humans share the game (e.g. to pass-and-play
// when one wiki player ends up holding both seats for self-play).
export function setHumanPlayMode(pgn, mode) {
  const value = mode === HUMAN_PLAY_SAME_DEVICE ? HUMAN_PLAY_SAME_DEVICE : HUMAN_PLAY_CORRESPONDENCE
  return formatPgn(setPgnTag(pgn, 'HumanPlay', value))
}

// Read `[HumanPlay]` from PGN — how two humans share the game
export function getHumanPlayMode(pgn) {
  const tag = getPgnTag(pgn, 'HumanPlay')
  if (tag === HUMAN_PLAY_SAME_DEVICE) return HUMAN_PLAY_SAME_DEVICE
  if (tag === HUMAN_PLAY_CORRESPONDENCE || tag === 'remote') return HUMAN_PLAY_CORRESPONDENCE
  return HUMAN_PLAY_CORRESPONDENCE
}

// Same-device human play (opposite-sides tabletop or pass-around pass-and-play)
export function isSameDeviceHumanPlay(pgnOrState) {
  if (pgnOrState && typeof pgnOrState === 'object') {
    if (pgnOrState.humanPlayMode === HUMAN_PLAY_SAME_DEVICE) return true
    if (pgnOrState.humanPlayMode === HUMAN_PLAY_CORRESPONDENCE || pgnOrState.humanPlayMode === 'remote') {
      return false
    }
    const pgn = pgnOrState.PGN || pgnOrState.chessState
    if (pgn) return getHumanPlayMode(pgn) === HUMAN_PLAY_SAME_DEVICE
    return false
  }
  return getHumanPlayMode(pgnOrState) === HUMAN_PLAY_SAME_DEVICE
}

// Wiki site of the remote human opponent from seated PGN tags.
// Ignores engines and open seats; never returns the viewing site.
export function opponentWikiSiteFromPgn(pgn, viewingSite) {
  if (!pgn || getFormat(pgn) !== 'PGN') return null
  const viewing = normalizeWikiSite(viewingSite)
  if (!viewing) return null
  for (const seat of ['White', 'Black']) {
    const tag = getPgnTag(pgn, seat)
    if (!tag || isOpenSeatTag(tag)) continue
    const parsed = parsePlayerId(tag)
    if (!parsed || parsed.isEngine || !parsed.domain) continue
    if (normalizeWikiSite(parsed.domain) === viewing) continue
    return parsed.domain
  }
  return null
}

// Local seat + opponent wiki host for correspondence journal fork planning.
export function resolveCorrespondenceJournalContext(pgn, { viewingSite, humanPlayMode } = {}) {
  if (!pgn || getFormat(pgn) !== 'PGN') return null
  if (humanPlayMode === HUMAN_PLAY_SAME_DEVICE || isSameDeviceHumanPlay(pgn)) return null
  if (getHumanPlayMode(pgn) !== HUMAN_PLAY_CORRESPONDENCE) return null

  const viewing = normalizeWikiSite(viewingSite)
  if (!viewing) return null

  let localSeat = null
  for (const seat of ['White', 'Black']) {
    const tag = getPgnTag(pgn, seat)
    if (!tag || isOpenSeatTag(tag)) continue
    const parsed = parsePlayerId(tag)
    if (!parsed || parsed.isEngine || !parsed.domain) continue
    if (normalizeWikiSite(parsed.domain) === viewing) {
      localSeat = seat === 'White' ? 'white' : 'black'
      break
    }
  }

  // Seated PGN tags win. ChallengeTarget is only a fallback while the opponent seat
  // is still open — never trust a target that equals this wiki (joiners inherit
  // ChallengeTarget=themselves from the invite).
  const fromPgn = opponentWikiSiteFromPgn(pgn, viewing)
  let inviteSite = challengeOpponentWikiSite(pgn)
  if (inviteSite && normalizeWikiSite(inviteSite) === viewing) inviteSite = null
  const opponentSite = fromPgn || inviteSite

  if (!localSeat || !opponentSite) return null
  if (normalizeWikiSite(opponentSite) === viewing) return null
  return { localSeat, opponentSite }
}

export function buildStartPgn({
  gameType = 'engine',
  signedInDisplayName,
  ownerName,
  wikiSite,
  wikiSiteUrl,
  wikiPageName,
  wikiPageTitle: _wikiPageTitle,
  pgnEvent,
  itemId,
  stockfishLevel = 1,
  localSeat = 'w',
  humanPlayMode = HUMAN_PLAY_CORRESPONDENCE,
  rated = true,
  fen = START_FEN,
  pageOnThisWiki = true,
  guestName,
  challengeCreator = '',
  creatorColorPref = '',
  minRating = null,
  maxRating = null,
  challengeTarget = '',
  challengeTs = null,
  creatorRating = null,
} = {}) {
  const host = wikiSite || 'localhost'
  // The seat the person starting the game sits in: their wiki identity if they're
  // the authenticated owner, otherwise a plain editable guest name.
  const displayName = signedInDisplayName || ownerName
  const localId = localPlayerSeatId({
    signedInDisplayName: displayName,
    wikiSite: host,
    pageOnThisWiki,
    guestName,
  })
  const openSeat = openSeatPgnTag()
  let white
  let black
  switch (gameType) {
    case 'open':
      // Two empty seats — the player picks opponent/colour in the start-game modal.
      white = openSeat
      black = openSeat
      break
    case 'human':
      if (humanPlayMode === HUMAN_PLAY_SAME_DEVICE) {
        white = pageOnThisWiki ? humanDisplayName(displayName, 'Player 1') : guestSeatName(guestName)
        black = 'Player 2'
      } else if (localSeat === 'b') {
        white = openSeat
        black = localId
      } else {
        white = localId
        black = openSeat
      }
      break
    case 'engine':
    default:
      if (localSeat === 'b') {
        white = stockfishPlayerId(stockfishLevel)
        black = localId
      } else {
        white = localId
        black = stockfishPlayerId(stockfishLevel)
      }
  }
  const startedAt = new Date()
  const tags = {
    Event: resolvePgnEvent({ pgnEvent, wikiPageName }),
    Site: resolvePgnSite({ wikiSiteUrl, wikiSite, itemId }),
    Date: pgnDateTag(startedAt),
    UTCDate: pgnUtcDateTag(startedAt),
    UTCTime: pgnUtcTimeTag(startedAt),
    Round: '-',
    Result: '*',
    White: white,
    Black: black,
  }
  const creator = String(challengeCreator || '').trim()
  if (creator) tags.ChallengeCreator = creator
  const colorPref = String(creatorColorPref || '').trim()
  if (colorPref) tags.CreatorColor = colorPref
  if (minRating != null && Number.isFinite(Number(minRating))) {
    tags.MinRating = String(Math.round(Number(minRating)))
  }
  if (maxRating != null && Number.isFinite(Number(maxRating))) {
    tags.MaxRating = String(Math.round(Number(maxRating)))
  }
  // Blank ChallengeTarget = open seek (anyone); set only when directed.
  const directed = normalizeWikiSiteInput(challengeTarget)
  if (directed) tags.ChallengeTarget = directed
  if (challengeTs != null && Number.isFinite(Number(challengeTs))) {
    tags.ChallengeTs = String(Math.round(Number(challengeTs)))
  }
  if (creatorRating != null && Number.isFinite(Number(creatorRating))) {
    tags.CreatorRating = String(Math.round(Number(creatorRating)))
  }
  if (gameType === 'human') {
    tags.HumanPlay = humanPlayMode === HUMAN_PLAY_SAME_DEVICE ? HUMAN_PLAY_SAME_DEVICE : HUMAN_PLAY_CORRESPONDENCE
  }
  // Record rated/casual so it travels with the game (and to the opponent's forked copy).
  // Engine games always track the personal vs-Stockfish rating. Same-device is always casual.
  if (gameType === 'engine' || gameType === 'human') {
    const isRated =
      gameType === 'engine' || (rated && !(gameType === 'human' && humanPlayMode === HUMAN_PLAY_SAME_DEVICE))
    tags.Rated = isRated ? 'yes' : 'no'
  }
  // Stamp the engine seat's real strength (the UCI_Elo it plays at) as a standard
  // WhiteElo/BlackElo header. The human seat is left blank — vs-Stockfish rating is
  // local-only, not a federated Glicko-2 value to publish in the PGN.
  const whiteEngineLevel = parseStockfishLevel(white)
  const blackEngineLevel = parseStockfishLevel(black)
  if (whiteEngineLevel != null) tags.WhiteElo = String(stockfishLevelElo(whiteEngineLevel))
  if (blackEngineLevel != null) tags.BlackElo = String(stockfishLevelElo(blackEngineLevel))
  if (!isStandardStartFen(fen)) {
    return buildSetupPgn(fen, tags)
  }
  return formatPgnParts({ tags, movetext: '' })
}

export function normalizePgnPlayers(pgn, { signedInDisplayName, ownerName, wikiSite } = {}) {
  if (!pgn || !/\[/.test(pgn)) return pgn

  const effectiveSite = wikiSite || 'localhost'
  const displayName = resolveSignedInUsername(signedInDisplayName || ownerName) || 'player'
  const localId = formatPlayerId(displayName, effectiveSite)
  let white = getPgnTag(pgn, 'White')
  let black = getPgnTag(pgn, 'Black')
  const humanRemote = getHumanPlayMode(pgn) === HUMAN_PLAY_CORRESPONDENCE
  const siteCtx = { wikiSite: effectiveSite }

  // cm-pgn drops `[Black ""]` / `[White ""]`; restore an open seat when the seated
  // human is already known so we don't back-fill Stockfish (see mergePgnWithSavedHeaders).
  if (humanRemote) {
    if (black == null && (isOpenSeatTag(white) || white === localId || isLocalWikiPlayer(white, siteCtx))) {
      black = openSeatPgnTag()
    }
    if (white == null && (isOpenSeatTag(black) || black === localId || isLocalWikiPlayer(black, siteCtx))) {
      white = openSeatPgnTag()
    }
  }

  const whiteOpen = isOpenSeatTag(white)
  const blackOpen = isOpenSeatTag(black)
  const localOnWhite = white === localId || isLocalWikiPlayer(white, siteCtx)
  const localOnBlack = black === localId || isLocalWikiPlayer(black, siteCtx)

  if (!whiteOpen && isGenericPlayerName(white)) {
    if (humanRemote && localOnBlack) {
      white = openSeatPgnTag()
    } else {
      white = localId
    }
  }
  if (!blackOpen && isGenericPlayerName(black)) {
    if (humanRemote && localOnWhite) {
      black = openSeatPgnTag()
    } else {
      black = white === localId ? defaultOpponentId() : localId
    }
  }

  const levelWhite = parseStockfishLevel(white)
  if (levelWhite != null) white = stockfishPlayerId(levelWhite)
  const levelBlack = parseStockfishLevel(black)
  if (levelBlack != null) black = stockfishPlayerId(levelBlack)

  const refreshDisplayNameOnEditorHost = tag => {
    const parsed = parsePlayerId(tag)
    if (!parsed || parsed.isEngine || !parsed.domain) return tag
    if (!playerTagOnViewingWikiSite(tag, effectiveSite)) return tag
    return formatPlayerId(displayName, parsed.domain)
  }

  const alignHumanSeat = (tag, oppositeTag) => {
    if (shouldRealignHumanSeatToEditorWiki(tag, oppositeTag, effectiveSite)) {
      return localId
    }
    return refreshDisplayNameOnEditorHost(tag)
  }

  // Resolve White first, then resolve Black against the *already-updated* White.
  // The realign decision for one seat depends on the opponent seat, so feeding the
  // new White into Black's call keeps the two seats consistent in one pass.
  white = alignHumanSeat(white, black)
  black = alignHumanSeat(black, white)

  let normalized = pgn
  normalized = setPgnTag(normalized, 'White', canonicalWikiPlayerTag(white, effectiveSite))
  normalized = setPgnTag(normalized, 'Black', canonicalWikiPlayerTag(black, effectiveSite))
  return formatPgn(normalized)
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// # MsgSync PostMessage Contract

// Stable key for deciding whether a chess embed can be reattached without reloading its iframe.
export function chessItemEmitKey({ pageKey = 'page', itemId = '', itemText = '', ghostPreview = false } = {}) {
  if (ghostPreview) return `${pageKey}/${itemId}:ghost-preview`
  return `${pageKey}/${itemId}:${String(itemText ?? '').trim()}`
}

// Shell GET_STATE replies after the first boot, or while another item is textEditing, must use patchStateOnly so the iframe does not fully re-init and steal focus from the open editor.
export function shouldRespondWithPatchStateOnly({ initialShellStateSent = false, wikiItemEditing = false } = {}) {
  return Boolean(initialShellStateSent || wikiItemEditing)
}

// # Session Lifecycle FSM

export const SESSION_PHASE = Object.freeze({
  BOOT: 'boot',
  SETUP: 'setup',
  ACTIVE: 'active',
})

export const SESSION_ACTION = Object.freeze({
  SHELL_STATE_RECEIVED: 'shell-state-received',
  ENTER_SETUP: 'enter-setup',
  EXIT_SETUP: 'exit-setup',
  DISMISS_SETUP_ITEM: 'dismiss-setup-item',
  DISMISS_OPEN_CHALLENGE_ITEM: 'dismiss-open-challenge-item',
  CLEAR_PENDING_MODAL: 'clear-pending-modal',
  SET_MENU_RESUME_SNAPSHOT: 'set-menu-resume-snapshot',
  BEGIN_SYNC: 'begin-sync',
  END_SYNC: 'end-sync',
  SET_FOLLOWS_POPUP: 'set-follows-popup',
  BUMP_CONSOLE_GENERATION: 'bump-console-generation',
  RESET_SESSION: 'reset-session',
  LOAD_CHESS_STATE: 'load-chess-state',
  PATCH_CHESS_STATE: 'patch-chess-state',
  REPLACE_CHESS_STATE: 'replace-chess-state',
  SET_VIEW: 'set-view',
})

function emptySetupState() {
  return {
    origin: null,
    dismissedItemId: null,
    openChallengeDismissedItemId: null,
    pendingModalOpts: null,
    menuResumeSnapshot: undefined,
  }
}

export function createInitialChessSession() {
  return {
    phase: SESSION_PHASE.BOOT,
    syncing: false,
    followsPopup: false,
    consoleGeneration: 0,
    setup: null,
    view: null,
    chess: null,
  }
}

export function reduceChessSession(state, action) {
  if (!action?.type) return state
  const next = {
    ...state,
    setup: state.setup ? { ...state.setup } : null,
  }

  switch (action.type) {
    case SESSION_ACTION.SHELL_STATE_RECEIVED:
      if (next.phase === SESSION_PHASE.BOOT) next.phase = SESSION_PHASE.ACTIVE
      return next
    case SESSION_ACTION.ENTER_SETUP:
      next.phase = SESSION_PHASE.SETUP
      next.setup = {
        ...emptySetupState(),
        origin: action.origin ?? null,
        pendingModalOpts: action.pendingModalOpts ?? null,
        menuResumeSnapshot: action.menuResumeSnapshot !== undefined ? action.menuResumeSnapshot : undefined,
        dismissedItemId: action.dismissedItemId ?? null,
        openChallengeDismissedItemId:
          action.openChallengeDismissedItemId ?? next.setup?.openChallengeDismissedItemId ?? null,
      }
      return next
    case SESSION_ACTION.EXIT_SETUP:
      next.phase = SESSION_PHASE.ACTIVE
      if (next.setup) {
        next.setup.origin = null
        next.setup.pendingModalOpts = null
        if (action.clearDismissed) {
          next.setup.dismissedItemId = null
          next.setup.openChallengeDismissedItemId = null
        }
      }
      return next
    case SESSION_ACTION.DISMISS_SETUP_ITEM:
      if (!next.setup) next.setup = emptySetupState()
      next.setup.dismissedItemId = action.itemId ?? null
      next.setup.origin = null
      next.setup.pendingModalOpts = null
      next.phase = SESSION_PHASE.ACTIVE
      return next
    case SESSION_ACTION.DISMISS_OPEN_CHALLENGE_ITEM:
      if (!next.setup) next.setup = emptySetupState()
      next.setup.openChallengeDismissedItemId = action.itemId ?? null
      return next
    case SESSION_ACTION.CLEAR_PENDING_MODAL:
      if (next.setup) next.setup.pendingModalOpts = null
      return next
    case SESSION_ACTION.SET_MENU_RESUME_SNAPSHOT:
      if (!next.setup) next.setup = emptySetupState()
      next.setup.menuResumeSnapshot = action.snapshot
      return next
    case SESSION_ACTION.BEGIN_SYNC:
      next.syncing = true
      return next
    case SESSION_ACTION.END_SYNC:
      next.syncing = false
      return next
    case SESSION_ACTION.SET_FOLLOWS_POPUP:
      next.followsPopup = Boolean(action.followsPopup)
      return next
    case SESSION_ACTION.BUMP_CONSOLE_GENERATION:
      next.consoleGeneration += 1
      return next
    case SESSION_ACTION.RESET_SESSION:
      return createInitialChessSession()
    case SESSION_ACTION.LOAD_CHESS_STATE: {
      const chess =
        action.normalized ??
        normalizeRestoredChessSession(action.payload && typeof action.payload === 'object' ? action.payload : {})
      next.chess = chess
      next.view = action.view ?? resolveChessViewMode(chess)
      return next
    }
    case SESSION_ACTION.REPLACE_CHESS_STATE:
      next.chess = action.chess && typeof action.chess === 'object' ? { ...action.chess } : action.chess
      next.view = action.view ?? resolveChessViewMode(next.chess)
      return next
    case SESSION_ACTION.PATCH_CHESS_STATE:
      if (!next.chess || typeof next.chess !== 'object') next.chess = {}
      next.chess = { ...next.chess, ...action.patch }
      if (action.refreshView !== false) next.view = resolveChessViewMode(next.chess)
      return next
    case SESSION_ACTION.SET_VIEW:
      next.view = action.view ?? null
      return next
    default:
      return state
  }
}

export function sessionInSetup(state) {
  return state?.phase === SESSION_PHASE.SETUP
}

export function sessionHasReceivedInitialState(state) {
  return state?.phase !== SESSION_PHASE.BOOT
}

export function sessionShouldDeferNewGameSetup(state) {
  return sessionInSetup(state)
}

export function sessionShouldDeferStockfishSetup(_state, chessState) {
  return Boolean(chessState?.awaitingStockfishSetup)
}

export function sessionBlocksAutosave(state) {
  return Boolean(state?.syncing || state?.followsPopup)
}

// Mute only while applying a remote sync — linked followers may play (and hear) locally.
export function sessionBlocksSounds(state) {
  return Boolean(state?.syncing)
}

export function sessionShouldDismissSetupForItem(state, itemId) {
  const id = String(itemId || '').trim()
  if (!id) return false
  const dismissed = String(state?.setup?.dismissedItemId || '').trim()
  const openDismissed = String(state?.setup?.openChallengeDismissedItemId || '').trim()
  return id === dismissed || id === openDismissed
}

export function sessionShouldReopenGameSetup(state, itemState) {
  return (
    itemState?.bareKeywordGuard === 'GAME' &&
    !sessionInSetup(state) &&
    !sessionShouldDismissSetupForItem(state, itemState?.itemId)
  )
}

export function sessionConsoleGeneration(state) {
  return Number(state?.consoleGeneration) || 0
}

// Primary UI surface for an incoming chess item / restored session.
export const CHESS_VIEW = Object.freeze({
  MENU: 'menu',
  GAME: 'game',
  POSITION: 'position',
  PUZZLE: 'puzzle',
  SURVEY: 'survey',
  LEADERBOARD: 'leaderboard',
})

// Classify shell/PWA state so initializeChessCore can route without a long if-chain.
export function resolveChessViewMode(state = {}) {
  if (state.gameType === 'survey' || state.format === 'SURVEY' || state.mode === 'FULL') {
    return CHESS_VIEW.SURVEY
  }
  if (state.gameType === 'leaderboard' || state.format === 'LEADERBOARD' || state.mode === 'LEADERBOARD') {
    return CHESS_VIEW.LEADERBOARD
  }
  if (isPuzzleState(state)) {
    return CHESS_VIEW.PUZZLE
  }
  if (state.showStartMenu) {
    return CHESS_VIEW.MENU
  }
  if (
    String(state.chessState || '')
      .trim()
      .toUpperCase() === 'CHOOSE'
  ) {
    return CHESS_VIEW.MENU
  }
  // Prefer a live PGN game over a leftover FEN (Object.assign on the shell cannot
  // clear keys after "Start Game from Position", so FEN may still be present).
  if (state.PGN) {
    return CHESS_VIEW.GAME
  }
  if (state.FEN || state.gameType === 'position' || state.mode === 'POSITION') {
    return CHESS_VIEW.POSITION
  }
  if (
    !state.PGN &&
    !state.FEN &&
    state.gameType !== 'puzzle' &&
    state.gameType !== 'position' &&
    state.gameType !== 'survey' &&
    !isPuzzleState(state)
  ) {
    return CHESS_VIEW.MENU
  }
  return null
}

// App-side session controller — wraps reduceChessSession with lifecycle helpers.
// Keeps popup-follow/sync/setup flags out of the mutable chessState blob.
export function createChessSessionController({ onFollowPopupChange } = {}) {
  let state = createInitialChessSession()
  const dispatch = action => {
    state = reduceChessSession(state, action)
    return state
  }

  return {
    getState: () => state,
    dispatch,
    followsPopup: () => state.followsPopup,
    setFollowsPopup(followsPopup) {
      const value = Boolean(followsPopup)
      dispatch({ type: SESSION_ACTION.SET_FOLLOWS_POPUP, followsPopup: value })
      onFollowPopupChange?.(value)
      return value
    },
    shouldDeferNewGameSetup: () => sessionShouldDeferNewGameSetup(state),
    pendingNewGameSetupModalOpts: () => state.setup?.pendingModalOpts ?? null,
    clearPendingNewGameSetupModal: () => dispatch({ type: SESSION_ACTION.CLEAR_PENDING_MODAL }),
    menuResumeSnapshotBeforeNewGame: () => state.setup?.menuResumeSnapshot,
    setMenuResumeSnapshotBeforeNewGame: snapshot =>
      dispatch({ type: SESSION_ACTION.SET_MENU_RESUME_SNAPSHOT, snapshot }),
    exitNewGameSetup: ({ clearDismissed = false } = {}) =>
      dispatch({ type: SESSION_ACTION.EXIT_SETUP, clearDismissed }),
    dismissNewGameSetupItem: itemId => dispatch({ type: SESSION_ACTION.DISMISS_SETUP_ITEM, itemId: itemId ?? null }),
    markShellStateReceived: () => dispatch({ type: SESSION_ACTION.SHELL_STATE_RECEIVED }),
    isNewGameSetupActive: () => sessionInSetup(state),
    newGameSetupOrigin: () => state.setup?.origin ?? null,
    dismissedNewGameSetupItemId: () => state.setup?.dismissedItemId ?? null,
    dismissOpenChallengeSetupItem: itemId => dispatch({ type: SESSION_ACTION.DISMISS_OPEN_CHALLENGE_ITEM, itemId }),
    clearNewGameSetupForGameStart() {
      dispatch({ type: SESSION_ACTION.EXIT_SETUP, clearDismissed: true })
      dispatch({ type: SESSION_ACTION.CLEAR_PENDING_MODAL })
      dispatch({ type: SESSION_ACTION.SET_MENU_RESUME_SNAPSHOT, snapshot: undefined })
    },
    enterSetup: payload => dispatch({ type: SESSION_ACTION.ENTER_SETUP, ...payload }),
    beginSync: () => dispatch({ type: SESSION_ACTION.BEGIN_SYNC }),
    endSync: () => dispatch({ type: SESSION_ACTION.END_SYNC }),
    bumpConsoleGeneration: () => dispatch({ type: SESSION_ACTION.BUMP_CONSOLE_GENERATION }),
    reset: () => dispatch({ type: SESSION_ACTION.RESET_SESSION }),
    getChessState: () => state.chess,
    viewMode: () => state.view,
    loadChessState(payload) {
      dispatch({ type: SESSION_ACTION.LOAD_CHESS_STATE, payload })
      return state.chess
    },
    replaceChessState(chess, { view } = {}) {
      dispatch({ type: SESSION_ACTION.REPLACE_CHESS_STATE, chess, view })
      return state.chess
    },
    patchChessState(patch, { refreshView = true } = {}) {
      dispatch({ type: SESSION_ACTION.PATCH_CHESS_STATE, patch, refreshView })
      return state.chess
    },
    setView(view) {
      dispatch({ type: SESSION_ACTION.SET_VIEW, view })
      return state.view
    },
  }
}

// Shared shell/PWA decision for whether an app-reported text change should journal.
// Returns { persist: false } or { persist: true, saveText, kind, clearKeywordOnly }.
export function planChessShellPersist({
  itemText,
  nextText,
  bareKeywordGuard,
  gameType,
  revert = false,
  lastJournalWasItemEdit = true,
  isSurveyItem = false,
  isLeaderboardItem = false,
} = {}) {
  if (isSurveyItem || isLeaderboardItem) return { persist: false, reason: 'maintenance-item' }
  if (revert && !lastJournalWasItemEdit) return { persist: false, reason: 'stale-revert' }
  const saveText = String(nextText || '').trim()
  if (
    !shouldPersistChessItemText({
      itemText,
      nextText: saveText,
      bareKeywordGuard,
    })
  ) {
    return { persist: false, reason: 'guard' }
  }
  if (gameType === 'puzzle') {
    return { persist: true, saveText, kind: 'puzzle', clearKeywordOnly: true }
  }
  if (gameType === 'position' && getFormat(saveText) === 'FEN') {
    return { persist: true, saveText, kind: 'position', clearKeywordOnly: true }
  }
  return { persist: true, saveText, kind: 'game', clearKeywordOnly: true }
}

// # MsgSync Realtime Presence Helpers

const REALTIME_SEATS = ['White', 'Black']

export function normalizeRealtimeState(raw) {
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const seat of REALTIME_SEATS) {
      const entry = raw[seat]
      if (entry && typeof entry === 'object') {
        const normalized = {
          ready: Boolean(entry.ready),
          ts: Number.isFinite(entry.ts) ? entry.ts : 0,
        }
        if (entry.rtcConsent !== undefined) normalized.rtcConsent = Boolean(entry.rtcConsent)
        out[seat] = normalized
      }
    }
  }
  return out
}

export function setRealtimeSeat(realtime, seat, ready, ts = Date.now(), rtcConsent = undefined) {
  const next = normalizeRealtimeState(realtime)
  if (seat !== 'White' && seat !== 'Black') return next
  const prev = next[seat]
  const entry = { ready: Boolean(ready), ts: Number.isFinite(ts) ? ts : 0 }
  if (rtcConsent !== undefined) entry.rtcConsent = Boolean(rtcConsent)
  else if (prev?.rtcConsent !== undefined) entry.rtcConsent = prev.rtcConsent
  next[seat] = entry
  return next
}

export function isRealtimeSeatReady(realtime, seat) {
  return Boolean(normalizeRealtimeState(realtime)[seat]?.ready)
}

export function isRealtimeSeatRtcConsented(realtime, seat) {
  return Boolean(normalizeRealtimeState(realtime)[seat]?.rtcConsent)
}

export function normalizeRealtimeSignal(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = raw.kind === 'offer' || raw.kind === 'answer' ? raw.kind : null
  const sdp = typeof raw.sdp === 'string' && raw.sdp.trim() ? raw.sdp : null
  if (!kind || !sdp) return null
  return { kind, sdp, epoch: Number.isFinite(raw.epoch) ? raw.epoch : 0 }
}

export function normalizeRealtimeSignalMap(raw) {
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const seat of REALTIME_SEATS) {
      const sig = normalizeRealtimeSignal(raw[seat])
      if (sig) out[seat] = sig
    }
  }
  return out
}

// # MsgSync Game Sync Policy

// Sources for evaluateGameSyncUpdate — wired in realtime.js.
export const GAME_SYNC_SOURCE = Object.freeze({
  SHELL_SET_STATE: 'shell-set-state',
  REMOTE_POLL: 'remote-poll',
  REMOTE_WEBRTC: 'remote-webrtc',
  LOCAL_MOVE: 'local-move',
})

// Ply count from PGN movetext (SAN tokens).
export function gamePlyCount(pgn) {
  const { movetext } = parsePgnParts(String(pgn || ''))
  return sanTokens(movetext).length
}

// Prefer the chess text with more plies (durable local snapshot vs wiki/shell).
// When ply counts tie, prefer `preferred` (usually the live/local copy).
export function preferRicherGameText(preferred, other) {
  const a = String(preferred || '')
  const b = String(other || '')
  if (!a.trim()) return b
  if (!b.trim()) return a
  const aPly = gamePlyCount(a)
  const bPly = gamePlyCount(b)
  if (aPly !== bPly) return aPly > bPly ? a : b
  return a
}

// Normalized movetext for comparing whether two PGNs differ only in headers.
export function chessMovetextKey(pgn) {
  const { movetext } = parsePgnParts(String(pgn || ''))
  return sanTokens(movetext).join(' ')
}

// True when a remote wiki page's chess item matches the PGN we intend to fork in.
export function remotePageMatchesExpect(remotePage, itemId, expectText) {
  if (!expectText) return true
  const id = String(itemId || '').trim()
  const story = Array.isArray(remotePage?.story) ? remotePage.story : []
  const item = id ? story.find(entry => entry?.id === id) : story.find(entry => entry?.type === 'chess')
  return chessMovetextKey(item?.text || '') === chessMovetextKey(expectText)
}

// Pure gate for external board updates. Returns whether the incoming PGN may apply now.
// Why separate from realtime.js: policy stays testable without DOM; realtime owns state + prompts.
// `localPlyEpoch` is the highest ply the app has committed locally (see realtime.js).
export function evaluateGameSyncUpdate({
  localPgn = '',
  incomingPgn = '',
  source = '',
  localPlyEpoch = 0,
  applying = false,
  sameItemText = false,
} = {}) {
  const localPly = gamePlyCount(localPgn)
  const incomingPly = gamePlyCount(incomingPgn)

  if (sameItemText) {
    return { accept: true, reason: null, localPly, incomingPly }
  }

  if (applying && source !== GAME_SYNC_SOURCE.LOCAL_MOVE) {
    return { accept: false, reason: 'sync-in-progress', localPly, incomingPly }
  }

  if (source === GAME_SYNC_SOURCE.LOCAL_MOVE) {
    return { accept: true, reason: null, localPly, incomingPly }
  }

  if (incomingPly < localPlyEpoch) {
    return { accept: false, reason: 'stale-ply', localPly, incomingPly }
  }

  if (source === GAME_SYNC_SOURCE.SHELL_SET_STATE && incomingPly >= localPly) {
    return { accept: true, reason: null, localPly, incomingPly }
  }

  if (
    (source === GAME_SYNC_SOURCE.REMOTE_POLL || source === GAME_SYNC_SOURCE.REMOTE_WEBRTC) &&
    incomingPly <= localPly
  ) {
    return { accept: false, reason: 'local-ahead', localPly, incomingPly }
  }

  return { accept: true, reason: null, localPly, incomingPly }
}

// Shell ↔ app postMessage contract. Every envelope is `{ action, …fields }`.
// High-traffic payloads (keep handlers / PWA bridge in sync when these change):
//   get-state / set-state — itemId, pageKey; set-state also PGN|FEN|chessState|itemText, applying?
//   state-exported — itemId, pageKey, text|PGN|FEN
//   realtime-presence / realtime-signal — itemId, pageKey, realtime|signal, fromSeat?, toSeat?
//   remote-opponent-state — itemId, pageKey, PGN|chessState|itemText
//   viewer-context — ownerName, isOwner, isAuthenticated, wikiSite
//   leaderboard-data / survey-* / rating-state — requestId?, partial?, error?, plus job payload
//   apply-linked-board — itemId, pageKey, PGN|chessState
//   paste-capture — text, format?
// Sync gate (not a wire MSG): evaluateGameSyncUpdate({ localPgn, incomingPgn, source, localPlyEpoch, applying, sameItemText })
//   → { accept, reason, localPly, incomingPly }; source ∈ GAME_SYNC_SOURCE
export const MSG = Object.freeze({
  // ── App → shell ────────────────────────────────────────────────────────────
  GET_STATE: 'get-state',
  POPUP_READY: 'popup-ready',
  POPUP_CLOSED: 'popup-closed',
  // Wiki tab → PWA opener: this page's chess item is ready to follow the PWA host.
  WIKI_TAB_READY: 'wiki-tab-ready',
  PWA_INSTALLED: 'pwa-installed',
  RESIZE: 'resize',
  GAME_READY: 'game-ready',
  GAME_SETTINGS_CHANGED: 'game-settings-changed',
  CHALLENGE_CHANGED: 'challenge-changed',
  SHELL_SESSION_FLAGS: 'shell-session-flags',
  MODE_CHANGED: 'mode-changed',
  POSITION_CHANGED: 'position-changed',
  SAVE_POSITION: 'save-position',
  STATE_EXPORTED: 'state-exported',
  PASTE_APPLY: 'paste-apply',
  REMOTE_WATCH: 'remote-watch',
  FORK_REMOTE_PAGE: 'fork-remote-page',
  REALTIME_PRESENCE: 'realtime-presence',
  REALTIME_SIGNAL: 'realtime-signal',
  REALTIME_STATUS: 'realtime-status',
  REQUEST_REALTIME_STATUS: 'request-realtime-status',
  DISCOVER_RATINGS: 'discover-ratings',
  FINALIZE_MATCH: 'finalize-match',
  BUILD_LEADERBOARD: 'build-leaderboard',
  BUILD_CHALLENGES: 'build-challenges',
  OPEN_SURVEY_PAGE: 'open-survey-page',
  OPEN_LEADERBOARD_PAGE: 'open-leaderboard-page',
  OPEN_GAME_PAGE: 'open-game-page',
  // App → shell: ghost page of FedWiki reference items (crawl site/game hits).
  SHOW_CRAWL_HITS_PAGE: 'show-crawl-hits-page',
  CREATE_PREVIEW: 'create-preview',
  UPDATE_GHOST_PAGE_TITLE: 'update-ghost-page-title',
  SYNC_GHOST_PREVIEW_TEXT: 'sync-ghost-preview-text',
  CREATE_PASTE_PREVIEW: 'create-paste-preview',
  CHESS_ITEM_GHOST_SHOWN: 'chess-item-ghost-shown',
  SURVEY_STATUS: 'survey-status',
  REGISTER_NEIGHBORS: 'register-neighbors',
  OPEN_ITEM_EDITOR: 'open-item-editor',
  FETCH_UI: 'fetch-ui',
  // App → shell: full-viewport OK alert on the parent wiki window (crawl complete, etc.).
  ALERT_UI: 'alert-ui',
  EMBED_WHEEL_SCROLL: 'embed-wheel-scroll',
  REQUEST_RESIGN: 'request-resign',
  REQUEST_SWITCH_GAME_MODE: 'request-switch-game-mode',
  REQUEST_SIGN_IN: 'request-sign-in',
  REQUEST_VIEWER_CONTEXT: 'request-viewer-context',
  LOOKUP_SITE_DISPLAY: 'lookup-site-display',
  FETCH_PUZZLE_PAGES: 'fetch-puzzle-pages',
  FETCH_LOCAL_ACADEMY_PROGRESS: 'fetch-local-academy-progress',

  // ── Shell → app ────────────────────────────────────────────────────────────
  SET_STATE: 'set-state',
  VIEWER_CONTEXT: 'viewer-context',
  GET_EXPORT: 'get-export',
  PASTE_CAPTURE: 'paste-capture',
  REMOTE_OPPONENT_STATE: 'remote-opponent-state',
  RATING_STATE: 'rating-state',
  LEADERBOARD_DATA: 'leaderboard-data',
  LEADERBOARD_PROGRESS: 'leaderboard-progress',
  SURVEY_OPEN_CHALLENGES_DATA: 'survey-open-challenges-data',
  BUILD_SITE_SURVEY_ENRICH: 'build-site-survey-enrich',
  SURVEY_SITE_GAMES_DATA: 'survey-site-games-data',
  SURVEY_STATE: 'survey-state',
  ABANDON_FETCHES: 'abandon-fetches',
  CHALLENGE_JOIN_FORKED: 'challenge-join-forked',
  SITE_DISPLAY: 'site-display',
  PUZZLE_PAGES_DATA: 'puzzle-pages-data',
  LOCAL_ACADEMY_PROGRESS_DATA: 'local-academy-progress-data',

  // ── Shell ↔ app relays (active popup / linked PWA routes iframe ↔ host) ───
  // REQUEST_RESIGN, REQUEST_SWITCH_GAME_MODE,
  // APPLY_LINKED_BOARD (follower move → journal host)

  // ── Linked-surface board relay (follower → host) ───────────────────────────
  APPLY_LINKED_BOARD: 'apply-linked-board',
})

// Lookup-table dispatch shared by wiki shell and chess-app inbound handlers.
export function createMessageDispatcher(handlers = {}) {
  return (action, ...args) => {
    const handler = handlers[action]
    if (!handler) return false
    handler(...args)
    return true
  }
}

// Pure sync-only policy: keep the active chess view when saved item text is unchanged.
// `ctx.activePage(id)` returns whether that page is visible; `keepActivePuzzleSession`
// mirrors puzzle.js's shouldKeepActivePuzzleSession.
// Stale CHOOSE replay from preview story while the app already switched modes in-place.
export function isStaleGhostChooseShellSync(incoming, prev) {
  if (!incoming?.patchStateOnly || !prev) return false
  const incomingText = String(incoming?.chessState || incoming?.PGN || '').trim()
  const replayingChoose =
    incoming.showStartMenu ||
    incoming.mode === 'CHOOSE' ||
    (incoming.format === 'MENU' && /^CHOOSE$/i.test(incomingText))
  if (!replayingChoose) return false
  if (isPuzzleState(prev)) return true
  if (prev.mode === 'POSITION' || prev.gameType === 'position') return true
  if (
    (prev.mode === 'GAME' || prev.gameType === 'open' || prev.gameType === 'human' || prev.gameType === 'engine') &&
    (prev.PGN || getFormat(prev.chessState) === 'PGN')
  ) {
    return true
  }
  return false
}

export function shouldKeepActiveShellSync(incoming, prev, ctx = {}) {
  const { activePage = () => false, hasChessConsole = false, keepActivePuzzleSession = () => false } = ctx
  if (!incoming?.patchStateOnly) return false
  if (keepActivePuzzleSession(incoming, prev)) return true
  if (isStaleGhostChooseShellSync(incoming, prev)) {
    if (isPuzzleState(prev) && activePage('puzzle')) return true
    if ((prev?.mode === 'POSITION' || prev?.gameType === 'position') && activePage('position')) {
      return true
    }
    if (
      activePage('game') &&
      (prev?.PGN ||
        getFormat(prev?.chessState) === 'PGN' ||
        prev?.bareKeywordGuard === 'GAME' ||
        prev?.gameType === 'open')
    ) {
      return true
    }
  }
  if (prev?.browsingStartMenu) return true
  if (prev?.showStartMenu && activePage('start')) return true

  // My Chess Games / Chess Leaderboards embeds never follow popup/PWA into CHOOSE or a game.
  if (isMaintenanceChessState(prev) && activePage('leaderboard')) return true

  const nextText = String(incoming?.chessState || incoming?.PGN || '').trim()
  const prevText = String(prev?.chessState || prev?.PGN || '').trim()
  const sameItemText = nextText === prevText

  if (
    incoming?.gameType === 'survey' ||
    incoming?.format === 'SURVEY' ||
    incoming?.mode === 'SURVEY' ||
    incoming?.mode === 'FULL'
  ) {
    return sameItemText && activePage('leaderboard')
  }

  if (incoming?.gameType === 'leaderboard' || incoming?.format === 'LEADERBOARD' || incoming?.mode === 'LEADERBOARD') {
    return sameItemText && activePage('leaderboard')
  }

  if (
    incoming?.format === 'FEN' ||
    incoming?.gameType === 'position' ||
    incoming?.mode === 'POSITION' ||
    (!incoming?.PGN && incoming?.FEN) ||
    (!incoming?.PGN && incoming?.chessState && getFormat(incoming.chessState) === 'FEN')
  ) {
    return activePage('position')
  }

  if (hasChessConsole && (incoming?.PGN || incoming?.chessState) && activePage('game')) {
    if (sameItemText) return true
    const prevPgn = prev?.PGN || prev?.chessState || ''
    const nextPgn = incoming?.PGN || incoming?.chessState || ''
    // Auth/item resync can rewrite headers without a new move — don't re-init the board.
    if (chessMovetextKey(prevPgn) === chessMovetextKey(nextPgn)) return true
  }

  return false
}

// Decide whether SET_STATE sync should re-init the whole chess view instead of patching.
export function shouldReinitChessViewFromSync(incoming) {
  if (!incoming || typeof incoming !== 'object') return true
  if (
    incoming.format === 'FEN' ||
    incoming.gameType === 'position' ||
    incoming.mode === 'POSITION' ||
    incoming.gameType === 'survey' ||
    incoming.mode === 'SURVEY' ||
    incoming.format === 'SURVEY' ||
    isPuzzleState(incoming) ||
    (!incoming.PGN && incoming.FEN) ||
    (!incoming.PGN && incoming.chessState && getFormat(incoming.chessState) === 'FEN')
  ) {
    return true
  }
  if (!incoming.PGN && !incoming.chessState) return true
  return false
}

// # Namespace Exports

// Prefer these namespaces (or `import * as Module`) at new call sites.
// Flat named exports remain for tests and gradual migration — do not add new flat aliases.

// FEN / PGN / clipboard format validation and detection.
export const ChessRules = Object.freeze({
  getFormat,
  isValidFenPlacement,
  isValidFenString,
  isValidPgnText,
  isValidFigurineText,
  isPasteContentValid,
  isEditableChessItemText,
  detectClipboardChessFormat,
  fenPositionKey,
  chessContentSignature,
  normalizeFen,
  lastMoveFromEnPassantTarget,
  fenPieceColorAt,
  fenBeforeEnPassantDoubleStep,
  START_FEN,
})

// Paste capture, confirmation copy, and ghost-fork metadata.
export const Paste = Object.freeze({
  detect: detectClipboardChessFormat,
  isContentValid: isPasteContentValid,
  // Deprecated: Prefer isContentValid / isPasteContentValid — same check.
  isActionable: isPasteActionable,
  resolveItemText: resolvePasteItemText,
  confirmMessage: pasteConfirmMessage,
  applyLabel: pasteApplyLabel,
  createNewLabel: pasteCreateNewLabel,
  canReplaceCurrentItem: pasteCanReplaceCurrentItem,
  buildGhostMeta: buildPasteGhostMeta,
  capture: createPasteCapturePayload,
  matchesCurrent: pasteMatchesCurrent,
  CREATE_NEW_LABEL: PASTE_CREATE_NEW_LABEL,
})

// Journal planning, page reducers, ghost/bootstrap helpers (pillar #3).
export const Journal = Object.freeze({
  shouldIgnoreKeywordAutosave,
  shouldPersistChessItemText,
  stripCreatePreviewFlag,
  clearGhostBootstrapJournal,
  mapChessSaveActionsForJournal,
  withChessSymbol,
  attachPositionFen,
  adoptRemoteWikiPage,
  applyPageAction,
  applyPageActions,
  buildChessEditAction,
  buildChessSaveActions,
  applyChessSaveToPage,
})

// 4 · Puzzle pool filters, row parse, adaptive coach helpers.
export const PuzzlePool = Object.freeze({
  parsePuzzleSpec,
  buildPuzzleItemText,
  parsePuzzleRow,
  parsePuzzleBankContent,
  puzzleMatchesFilters,
  puzzlePlayerColor,
  hasActivePuzzleFilters,
  formatPuzzleFiltersLabel,
  recordAdaptivePuzzleOutcome,
  puzzleItemProgressFromText,
  markPuzzleItemProgress,
  academyProgressFromLocalPages,
  resolveSmartAcademyNext,
})

// 7 · App session lifecycle controller helpers.
export const Session = Object.freeze({
  createChessSessionController,
  createInitialChessSession,
  reduceChessSession,
  resolveChessViewMode,
  CHESS_VIEW,
  SESSION_PHASE,
  SESSION_ACTION,
  sessionHasReceivedInitialState,
  sessionBlocksAutosave,
  sessionBlocksSounds,
  sessionInSetup,
  sessionShouldDeferNewGameSetup,
  sessionShouldDeferStockfishSetup,
  sessionShouldReopenGameSetup,
  sessionConsoleGeneration,
  planChessShellPersist,
})

// 8 · postMessage contract + pure sync policy.
export const MsgSync = Object.freeze({
  MSG,
  createMessageDispatcher,
  evaluateGameSyncUpdate,
  shouldReinitChessViewFromSync,
  preferRicherGameText,
  gamePlyCount,
  GAME_SYNC_SOURCE,
  chessItemEmitKey,
  shouldRespondWithPatchStateOnly,
  normalizeRealtimeState,
  setRealtimeSeat,
  isRealtimeSeatReady,
  isRealtimeSeatRtcConsented,
  normalizeRealtimeSignal,
  normalizeRealtimeSignalMap,
})
