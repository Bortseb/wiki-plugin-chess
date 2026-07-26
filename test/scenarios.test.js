/**
 * Multi-step scenario tests — GAME sync, journal autosave, puzzle solve path.
 * These stitch pure helpers the way the app uses them across a short user journey.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MSG,
  GAME_SYNC_SOURCE,
  evaluateGameSyncUpdate,
  preferRicherGameText,
  gamePlyCount,
  buildStartPgn,
  claimSeat,
  shouldIgnoreKeywordAutosave,
  shouldPersistChessItemText,
  buildChessSaveActions,
  parsePuzzleRow,
  puzzleMatchesFilters,
  buildPuzzleItemText,
  markPuzzleItemProgress,
  recordAdaptivePuzzleOutcome,
  puzzleItemProgressFromText,
  Journal,
  MsgSync,
  PuzzlePool,
  Session,
} from '../src/chess-core.js'
import { parsePuzzlesCsv, createPuzzleSolver } from '../src/puzzle.js'

// Same fixture as chess-core.test.js — keep moves/ids aligned with createPuzzleSolver tests.
const MATE_IN_2_ROW =
  '0042j,3r2k1/4nppp/pq1p1b2/1p2P3/2r2P2/2P1NR2/PP1Q2BP/3R2K1 b - - 0 24,d6e5 d2d8 b6d8 d1d8,555,106,92,1446,backRankMate mate mateIn2 middlegame short,https://lichess.org/DuM2FZjg/black#48,'

describe('scenarios', () => {
  describe('GAME sync journey', () => {
    const localPgn = '[Event "?"]\n\n1. e4 e5 2. Nf3 *'
    const remoteAhead = '[Event "?"]\n\n1. e4 e5 2. Nf3 Nc6 *'
    const remoteStale = '[Event "?"]\n\n1. e4 *'

    it('local move commits, stale remote is rejected, ahead remote is accepted', () => {
      // 1. Local player publishes a move — always accepted (epoch advances in realtime).
      const localMove = evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: localPgn,
        source: GAME_SYNC_SOURCE.LOCAL_MOVE,
        localPlyEpoch: gamePlyCount(localPgn),
      })
      assert.equal(localMove.accept, true)
      const epoch = localMove.incomingPly
      assert.equal(epoch, 3)

      // 2. Stale poll behind the local epoch must not rewind the board.
      const stale = evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: remoteStale,
        source: GAME_SYNC_SOURCE.REMOTE_POLL,
        localPlyEpoch: epoch,
      })
      assert.equal(stale.accept, false)
      assert.equal(stale.reason, 'stale-ply')

      // 3. Shell SET_STATE with a richer remote line is accepted.
      const ahead = evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: remoteAhead,
        source: GAME_SYNC_SOURCE.SHELL_SET_STATE,
        localPlyEpoch: epoch,
      })
      assert.equal(ahead.accept, true)
      assert.equal(preferRicherGameText(localPgn, remoteAhead), remoteAhead)

      // 4. While applying, remote polls stay gated (except local moves).
      const busy = evaluateGameSyncUpdate({
        localPgn: remoteAhead,
        incomingPgn: remoteAhead,
        source: GAME_SYNC_SOURCE.REMOTE_WEBRTC,
        applying: true,
      })
      assert.equal(busy.accept, false)
      assert.equal(busy.reason, 'sync-in-progress')
    })

    it('MsgSync namespace exposes the same sync gate as flat exports', () => {
      assert.equal(MsgSync.MSG.SET_STATE, MSG.SET_STATE)
      assert.equal(MsgSync.GAME_SYNC_SOURCE.REMOTE_POLL, GAME_SYNC_SOURCE.REMOTE_POLL)
      const verdict = MsgSync.evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: remoteAhead,
        source: MsgSync.GAME_SYNC_SOURCE.SHELL_SET_STATE,
        localPlyEpoch: 3,
      })
      assert.equal(verdict.accept, true)
    })
  })

  describe('journal autosave journey', () => {
    const ctx = { ownerName: 'alice', wikiSite: 'alice.localhost' }

    it('bare GAME stays silent until a real seat claim, then journals', () => {
      // Page load with keyword-only item — must not write.
      assert.equal(shouldIgnoreKeywordAutosave('GAME', 'GAME'), true)
      assert.equal(
        shouldPersistChessItemText({
          itemText: 'GAME',
          nextText: 'GAME',
          bareKeywordGuard: 'GAME',
        }),
        false,
      )

      // Opening an unseated open board still looks like keyword-only noise.
      const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
      assert.equal(shouldIgnoreKeywordAutosave('GAME', openBoard), true)
      assert.equal(
        Journal.shouldPersistChessItemText({
          itemText: 'GAME',
          nextText: openBoard,
          bareKeywordGuard: 'GAME',
        }),
        false,
      )

      // Claiming a seat is a user action — autosave may proceed.
      const seated = claimSeat(openBoard, 'White', ctx)
      assert.equal(shouldIgnoreKeywordAutosave('GAME', seated), false)
      assert.equal(
        Journal.shouldPersistChessItemText({
          itemText: 'GAME',
          nextText: seated,
          bareKeywordGuard: 'GAME',
        }),
        true,
      )

      const page = {
        title: 'Friendly Game',
        story: [{ type: 'chess', id: 'item1', text: 'GAME' }],
      }
      const actions = Journal.buildChessSaveActions(page, 'item1', seated)
      assert.ok(Array.isArray(actions))
      assert.ok(actions.length >= 1)
      assert.equal(
        actions.some(a => a.type === 'edit' && String(a.item?.text || '').includes('[')),
        true,
      )
      // Flat export stays wired for shell/tests.
      assert.equal(buildChessSaveActions(page, 'item1', seated).length, actions.length)
    })

    it('Session sync flag blocks autosave until END_SYNC', () => {
      const boot = Session.createInitialChessSession()
      assert.equal(Session.sessionBlocksAutosave(boot), false)
      assert.equal(Session.sessionHasReceivedInitialState(boot), false)

      const active = Session.reduceChessSession(boot, {
        type: Session.SESSION_ACTION.SHELL_STATE_RECEIVED,
      })
      assert.equal(Session.sessionHasReceivedInitialState(active), true)

      const syncing = Session.reduceChessSession(active, {
        type: Session.SESSION_ACTION.BEGIN_SYNC,
      })
      assert.equal(Session.sessionBlocksAutosave(syncing), true)

      const done = Session.reduceChessSession(syncing, {
        type: Session.SESSION_ACTION.END_SYNC,
      })
      assert.equal(Session.sessionBlocksAutosave(done), false)
    })
  })

  describe('puzzle solve journey', () => {
    it('parse → filter → solve → persist progress on the item text', () => {
      const csv = `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
${MATE_IN_2_ROW}`
      const pool = parsePuzzlesCsv(csv)
      assert.equal(pool.length, 1)

      const puzzle = parsePuzzleRow(MATE_IN_2_ROW)
      assert.equal(puzzleMatchesFilters(puzzle, { themes: ['mateIn2'], maxRating: 600 }), true)
      assert.equal(PuzzlePool.puzzleMatchesFilters(puzzle, { themes: ['mateIn1'] }), false)

      const itemText = buildPuzzleItemText({ themes: ['mateIn2'], adaptive: true })
      assert.match(itemText, /^PUZZLE\b/)
      assert.match(itemText, /adaptive=true/)

      const solver = createPuzzleSolver(puzzle).start()
      assert.equal(solver.submitMove('d2d8').status, 'continue')
      assert.equal(solver.submitMove('d1d8').status, 'solved')

      const filtersAfter = recordAdaptivePuzzleOutcome(
        { themes: ['mateIn2'], adaptive: true },
        'solved',
        puzzle.id,
      )
      assert.ok(filtersAfter.solvedIds.includes(puzzle.id))

      const progressed = markPuzzleItemProgress(itemText, {
        done: false,
        solvedIds: filtersAfter.solvedIds,
        adaptive: true,
      })
      const progress = puzzleItemProgressFromText(progressed)
      assert.equal(progress.adaptive, true)
      assert.ok(progress.solvedIds.includes(puzzle.id))
      assert.match(PuzzlePool.markPuzzleItemProgress(itemText, { done: true }), /done=1/)
    })
  })
})
