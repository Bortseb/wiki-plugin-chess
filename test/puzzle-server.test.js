/** Unit tests for server/puzzle-server.js — puzzle DB helpers and STUN config. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  pzstdNextFrameSize,
  parsePuzzleQueryFilters,
  resolveStunServers,
  resolvePuzzleDatabaseEnabled,
  resolvePuzzleDatabaseLocations,
  puzzleDatabasePublicStatus,
  puzzleDatabaseArchivePath,
  PUZZLE_DB_ARCHIVE_NAME,
  queryHasPuzzleFilters,
  estimateFilteredPuzzleDatabase,
  DEFAULT_STUN_SERVERS,
} from '../server/puzzle-server.js'

const pluginServerDir = path.dirname(fileURLToPath(new URL('../server/puzzle-server.js', import.meta.url)))

describe('server · puzzle-server', () => {
  it('reads the next frame size from a pzstd skippable header', () => {
    const header = Buffer.alloc(12)
    header.writeUInt32LE(0x184d2a50, 0)
    header.writeUInt32LE(4, 4)
    header.writeUInt32LE(123456, 8)
    assert.equal(pzstdNextFrameSize(header), 123456)
    assert.equal(pzstdNextFrameSize(Buffer.alloc(4)), null)
  })

  it('parses puzzle query filters', () => {
    assert.deepEqual(
      parsePuzzleQueryFilters({
        themes: 'mateIn2, fork ,',
        minRating: '1200',
        maxRating: 'x',
      }),
      {
        themes: ['mateIn2', 'fork'],
        minRating: 1200,
      },
    )
  })

  it('resolves STUN servers from config or the default', () => {
    assert.deepEqual(resolveStunServers({}, {}), DEFAULT_STUN_SERVERS)
    assert.deepEqual(resolveStunServers({ chess: { stunServers: ['stun:a:1'] } }, {}), ['stun:a:1'])
  })

  it('resolves the puzzle database directory to the plugin server folder', () => {
    const { installDir } = resolvePuzzleDatabaseLocations({})
    assert.equal(installDir, pluginServerDir)
    assert.equal(resolvePuzzleDatabaseLocations({ commons: '/tmp/commons' }).installDir, pluginServerDir)
  })

  it('requires chess.puzzleDatabase: true in wiki config to enable the farm database', () => {
    assert.equal(resolvePuzzleDatabaseEnabled({}), false)
    assert.equal(resolvePuzzleDatabaseEnabled({ chess: {} }), false)
    assert.equal(resolvePuzzleDatabaseEnabled({ chess: { puzzleDatabase: false } }), false)
    assert.equal(resolvePuzzleDatabaseEnabled({ chess: { puzzleDatabase: 'true' } }), false)
    assert.equal(resolvePuzzleDatabaseEnabled({ chess: { puzzleDatabase: true } }), true)
  })

  it('locates the compressed puzzle archive on disk when present', () => {
    const dir = path.join('/tmp', 'chess-puzzles')
    const archive = path.join(dir, PUZZLE_DB_ARCHIVE_NAME)
    const fsImpl = {
      existsSync: p => p === archive,
    }
    assert.equal(puzzleDatabaseArchivePath(dir, fsImpl), archive)
    assert.equal(puzzleDatabaseArchivePath(dir, { existsSync: () => false }), null)
  })

  it('detects when puzzle download filters are active', () => {
    assert.equal(queryHasPuzzleFilters({}), false)
    assert.equal(queryHasPuzzleFilters({ minRating: 1200 }), true)
  })

  it('estimates filtered download size from a sample ratio', async () => {
    const lines = [
      'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl',
      'a,fen,m,1500,80,90,1,fork,url',
      'b,fen,m,2500,80,90,1,pin,url',
    ]
    const offsets = new Uint32Array([0, lines[0].length + 1, lines[0].length + lines[1].length + 2])
    const readLine = async (_fd, offset) => {
      if (offset === offsets[1]) return lines[1]
      if (offset === offsets[2]) return lines[2]
      return lines[0]
    }
    const estimate = await estimateFilteredPuzzleDatabase(
      { offsets, fd: {}, readLine },
      { minRating: 1000, maxRating: 2000 },
      // Sampling is random over the two rows; a small sample can hit only the
      // matching row and make filteredBytes == fullBytes (flaky). 64 draws make
      // "all matches" vanishingly unlikely.
      { fullBytes: 1_000_000, sampleSize: 64 },
    )
    assert.equal(estimate.fullBytes, 1_000_000)
    assert.ok(estimate.filteredBytes < estimate.fullBytes)
    assert.ok(estimate.filteredCount <= estimate.totalCount)
  })

  it('exposes puzzle database status with enabled flag from wiki config', () => {
    const status = puzzleDatabasePublicStatus(
      { status: 'ready', offsets: new Uint32Array([0, 100]), error: null },
      { enabled: true, zstd: true },
    )
    assert.equal(status.enabled, true)
    assert.equal(status.ready, true)
    assert.equal(status.puzzles, 1)

    const disabled = puzzleDatabasePublicStatus(
      { status: 'idle', offsets: null, error: null },
      { enabled: false, zstd: true },
    )
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.ready, false)
  })
})
