/** Unit tests for src/chess-core.js — format detection, keywords, PGN helpers, puzzle pool. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getFormat,
  figurineToFEN,
  parseChessItem,
  parseItemMode,
  resolveChessState,
  mergeItemTextIntoChessObj,
  formatPlayerId,
  parsePlayerId,
  buildStartPgn,
  getPgnTag,
  normalizePgnPlayers,
  shouldIgnoreKeywordAutosave,
  claimSeat,
  detectClipboardChessFormat,
  isPasteActionable,
  resolvePasteItemText,
  createPasteCapturePayload,
  pasteMatchesCurrent,
  validateRemoteContinuation,
  remoteMoveContinuation,
  REMOTE_REJECT_NO_NEW_MOVE,
  REMOTE_REJECT_START_CHANGED,
  REMOTE_REJECT_HISTORY_REWRITTEN,
  REMOTE_REJECT_MULTIPLE_PLIES,
  REMOTE_REJECT_FORGED_SEAT,
  parsePuzzleRow,
  parsePuzzlesCsv,
  selectPuzzle,
  puzzlePlayerColor,
  createPuzzleSolver,
} from '../src/chess-core.js'

const MATE_IN_2_ROW =
  '0042j,3r2k1/4nppp/pq1p1b2/1p2P3/2r2P2/2P1NR2/PP1Q2BP/3R2K1 b - - 0 24,d6e5 d2d8 b6d8 d1d8,555,106,92,1446,backRankMate mate mateIn2 middlegame short,https://lichess.org/DuM2FZjg/black#48,'

const MATE_IN_1_ROW =
  '00GRa,1r3rk1/2p1Nppb/p2nq3/1p2p1Pp/4Qn1P/2P1N3/PPB2P1K/3R2R1 b - - 5 28,e6e7 e4h7,438,118,96,1203,kingsideAttack mate mateIn1 middlegame oneMove,https://lichess.org/QiJhfG8J/black#56,'

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const STARTING_FIGURINE = `♜a8 ♞b8 ♝c8 ♛d8 ♚e8 ♝f8 ♞g8 ♜h8
♟a7 ♟b7 ♟c7 ♟d7 ♟e7 ♟f7 ♟g7 ♟h7


♙a2 ♙b2 ♙c2 ♙d2 ♙e2 ♙f2 ♙g2 ♙h2
♖a1 ♘b1 ♗c1 ♕d1 ♔e1 ♗f1 ♘g1 ♖h1`

describe('chess-core', () => {
  it('detects figurine, FEN, PGN, empty, and unknown text', () => {
    assert.equal(getFormat(STARTING_FIGURINE), 'FIGURINE')
    assert.equal(getFormat(STARTING_FEN), 'FEN')
    assert.equal(getFormat('[White "a"]\n[Black "b"]'), 'PGN')
    assert.equal(getFormat('1. e4 e5'), 'PGN')
    assert.equal(getFormat(''), 'EMPTY')
    assert.equal(getFormat('hello world'), 'UNKNOWN')
  })

  it('converts a figurine diagram to FEN', () => {
    const fen = figurineToFEN(STARTING_FIGURINE)
    assert.ok(fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'))
  })

  it('reads mode keywords from item text', () => {
    assert.equal(parseItemMode('GAME'), 'GAME')
    assert.equal(parseItemMode('position'), 'POSITION')
    assert.equal(parseItemMode('PUZZLE'), 'PUZZLE')
    assert.equal(parseItemMode('CHOOSE'), 'CHOOSE')
    assert.equal(parseItemMode('1. e4'), 'NONE')
  })

  it('shows the start menu for CHOOSE and empty items', () => {
    assert.equal(parseChessItem('CHOOSE').showStartMenu, true)
    assert.equal(parseChessItem('').showStartMenu, true)
    assert.equal(parseChessItem('GAME').showStartMenu, false)
    assert.equal(parseChessItem('[White "a"]\n\n1. e4').showStartMenu, false)
  })

  it('resolves GAME, POSITION, and PUZZLE keywords', () => {
    const game = resolveChessState(parseChessItem('GAME'))
    assert.equal(game.gameType, 'open')
    assert.equal(game.format, 'PGN')

    const position = resolveChessState(parseChessItem('POSITION'))
    assert.equal(position.gameType, 'position')
    assert.equal(position.format, 'FEN')

    const puzzle = resolveChessState(parseChessItem('PUZZLE'))
    assert.equal(puzzle.gameType, 'puzzle')
    assert.equal(puzzle.format, 'PUZZLE')
  })

  it('formats and parses wiki player ids', () => {
    assert.equal(formatPlayerId('Rob', 'localhost:3001'), 'localhost:3001 (Rob)')
    const player = parsePlayerId('ff.localhost:3001 (Rob)')
    assert.equal(player.username, 'Rob')
    assert.equal(player.domain, 'ff.localhost:3001')
    assert.equal(parsePlayerId('Stockfish Level 3').isEngine, true)
  })

  it('builds a starting PGN for a game vs Stockfish', () => {
    const pgn = buildStartPgn({ gameType: 'engine', ownerName: 'alice', wikiHost: 'ff.localhost' })
    assert.equal(getPgnTag(pgn, 'White'), 'ff.localhost (alice)')
    assert.equal(getPgnTag(pgn, 'Black'), 'Stockfish Level 3')
  })

  it('fills in missing player tags', () => {
    const pgn = normalizePgnPlayers(`[SetUp "1"]\n[FEN "${STARTING_FEN}"]`, {
      ownerName: 'FF FF',
      wikiHost: 'ff.localhost',
    })
    assert.equal(getPgnTag(pgn, 'White'), 'ff.localhost (FF FF)')
    assert.equal(getPgnTag(pgn, 'Black'), 'Stockfish Level 3')
  })

  it('claims an open seat', () => {
    const pgn = buildStartPgn({ gameType: 'open', ownerName: 'alice', wikiHost: 'ff.localhost' })
    const claimed = claimSeat(pgn, 'Black', { ownerName: 'bob', wikiHost: 'bb.localhost' })
    assert.equal(getPgnTag(claimed, 'Black'), 'bb.localhost (bob)')
  })

  it('clears the start menu once a real PGN is saved', () => {
    const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
    const merged = mergeItemTextIntoChessObj({ showStartMenu: true, format: 'MENU' }, pgn)
    assert.equal(merged.showStartMenu, false)
    assert.equal(merged.format, 'PGN')
  })

  it('ignores autosave of the bare GAME keyword', () => {
    const ctx = { ownerName: 'alice', wikiHost: 'alice.example.com' }
    assert.equal(shouldIgnoreKeywordAutosave('GAME', 'GAME'), true)
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    assert.equal(shouldIgnoreKeywordAutosave('GAME', openBoard), true)
    const engine = buildStartPgn({ gameType: 'engine', ...ctx })
    assert.equal(shouldIgnoreKeywordAutosave('GAME', engine), false)
  })

  it('persists a seated open game before the first move', () => {
    const ctx = { ownerName: 'alice', wikiHost: 'aa.localhost' }
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    const seated = claimSeat(openBoard, 'White', ctx)
    assert.equal(shouldIgnoreKeywordAutosave('GAME', seated), false)
  })

  describe('paste capture', () => {
    it('treats FEN and PGN as actionable paste', () => {
      const fenDetected = detectClipboardChessFormat(STARTING_FEN)
      assert.equal(fenDetected.format, 'FEN')
      assert.equal(isPasteActionable(fenDetected), true)
      assert.equal(resolvePasteItemText(STARTING_FEN, fenDetected), STARTING_FEN)

      const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
      const pgnDetected = detectClipboardChessFormat(pgn)
      assert.equal(pgnDetected.format, 'PGN')
      assert.equal(resolvePasteItemText(pgn, pgnDetected), pgn)
    })

    it('rejects bare keywords and unknown text', () => {
      const keyword = detectClipboardChessFormat('GAME')
      assert.equal(isPasteActionable(keyword), false)
      assert.equal(createPasteCapturePayload('GAME').actionable, false)

      const unknown = detectClipboardChessFormat('hello world')
      assert.equal(isPasteActionable(unknown), false)
    })

    it('converts figurine paste to FEN item text', () => {
      const payload = createPasteCapturePayload(STARTING_FIGURINE)
      assert.equal(payload.actionable, true)
      assert.ok(payload.itemText.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'))
    })

    it('detects when pasted content matches what is already loaded', () => {
      const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
      const payload = createPasteCapturePayload(pgn)
      assert.equal(pasteMatchesCurrent(payload, pgn), true)
      assert.equal(pasteMatchesCurrent(payload, '[White "x"]\n[Black "y"]\n\n1. d4 d5'), false)
    })
  })

  describe('remote move validation', () => {
    const BASE_PGN = '[White "a"]\n[Black "b"]\n\n'

    it('accepts a single new opponent move', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['e4', 'e5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, true)
      assert.deepEqual(result.newMoves, ['e5'])
    })

    it('rejects when there is no new move', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['e4'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_NO_NEW_MOVE)
    })

    it('rejects a rewritten history', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['d4', 'd5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_HISTORY_REWRITTEN)
      assert.equal(remoteMoveContinuation(['e4'], ['d4', 'd5']), null)
    })

    it('rejects multiple plies appended at once', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: [],
        remoteSans: ['e4', 'e5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_MULTIPLE_PLIES)
    })

    it('rejects a move forged for the local seat', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: [],
        remoteSans: ['e4'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_FORGED_SEAT)
    })

    it('rejects when the starting position changed', () => {
      const customFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: `[SetUp "1"]\n[FEN "${customFen}"]\n\n`,
        localSans: [],
        remoteSans: ['e5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_START_CHANGED)
    })
  })

  describe('puzzle pool', () => {
    it('parses a Lichess CSV row', () => {
      const p = parsePuzzleRow(MATE_IN_2_ROW)
      assert.equal(p.id, '0042j')
      assert.deepEqual(p.moves, ['d6e5', 'd2d8', 'b6d8', 'd1d8'])
      assert.equal(p.rating, 555)
      assert.ok(p.themes.includes('mateIn2'))
    })

    it('skips the header and bad rows when parsing a CSV', () => {
      const csv = `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
${MATE_IN_2_ROW}
garbage,too,few
${MATE_IN_1_ROW}`
      const puzzles = parsePuzzlesCsv(csv)
      assert.equal(puzzles.length, 2)
    })

    it('derives the solver color from the FEN side to move', () => {
      assert.equal(puzzlePlayerColor(parsePuzzleRow(MATE_IN_2_ROW)), 'w')
    })

    it('filters selection by theme and rating', () => {
      const puzzles = [parsePuzzleRow(MATE_IN_2_ROW), parsePuzzleRow(MATE_IN_1_ROW)]
      assert.equal(selectPuzzle(puzzles, { themes: ['mateIn1'] }).id, '00GRa')
      assert.equal(selectPuzzle(puzzles, { maxRating: 500 }).id, '00GRa')
    })

    it('walks a correct solution to solved', () => {
      const solver = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      assert.equal(solver.submitMove('d2d8').status, 'continue')
      assert.equal(solver.submitMove('d1d8').status, 'solved')
      assert.equal(solver.solved, true)
    })

    it('marks the puzzle failed on a wrong move', () => {
      const solver = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      assert.equal(solver.submitMove('c4c3').status, 'wrong')
      assert.equal(solver.failed, true)
    })

    it('exports and imports in-progress solver state', () => {
      const solver = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      solver.submitMove('d2d8')
      const saved = solver.exportState()
      assert.equal(saved.index, 2)
      assert.equal(saved.status, 'solving')
      solver.importState({ index: 0, status: 'solving' })
      assert.equal(solver.exportState().index, 0)
      solver.importState(saved)
      assert.equal(solver.submitMove('d1d8').status, 'solved')
    })
  })
})
