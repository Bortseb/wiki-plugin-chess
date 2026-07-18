/*
 * Federated Wiki Chess — server-side plugin (puzzle database + config).
 *
 * A wiki farm can download the full Lichess puzzle database (CC0) **once** to a
 * shared spot on disk and serve random/filtered puzzles to every wiki on the
 * farm. This avoids bundling the ~300 MB database in the plugin while still
 * giving visitors a deep puzzle pool. When the farm has no database, the client
 * falls back to the Lichess API — see src/puzzle.js (bundled in chess-app.js).
 *
 * Design notes:
 *   - The database is the Lichess `lichess_db_puzzle.csv.zst`. It is compressed
 *     with pzstd (multiple zstd frames, each preceded by a 12-byte skippable
 *     frame). Node's streaming zstd can't skip those frames, so we decode frame
 *     by frame with zstdDecompressSync (Node ≥ 22.15 / 23.8; older farms degrade
 *     gracefully — the endpoint returns 503 and the client uses the API).
 *   - We never hold the ~1 GB CSV in memory: after decompressing to disk we build
 *     a compact array of line-start byte offsets (Uint32) and answer each request
 *     by seeking to a random offset. Theme/rating filters use rejection sampling.
 *   - Opt-in via `chess.puzzleDatabase: true` in the wiki config.json. When enabled and the
 *     database is not yet on disk, the plugin downloads it on server start — no
 *     in-app admin UI. Files live under this plugin's server directory
 *     (`server/` — shared by every wiki on the farm).
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { parsePuzzleRow, puzzleMatchesFilters } from '../src/chess-core.js'
import { reviseChessCharmOnPage } from '../src/federation.js'

const DB_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst'
const PZSTD_SKIPPABLE_MASK = 0xfffffff0
const PZSTD_SKIPPABLE_MAGIC = 0x184d2a50
// Guard against an implausibly large CSV (offsets are stored as Uint32).
const MAX_INDEXABLE_BYTES = 0xffffffff

const state = {
  status: 'idle', // idle | downloading | decompressing | indexing | ready | error
  error: null,
  offsets: null, // Uint32Array of line-start byte offsets into the CSV
  fd: null, // open read handle on the decompressed CSV
  downloadedAt: null,
  dir: null,
}

const zstdAvailable = () => typeof zlib.zstdDecompressSync === 'function'

// # Pure Helpers

export function pzstdNextFrameSize(header12) {
  if (!header12 || header12.length < 12) return null
  const magic = header12.readUInt32LE(0)
  if ((magic & PZSTD_SKIPPABLE_MASK) !== PZSTD_SKIPPABLE_MAGIC) return null
  return header12.readUInt32LE(8)
}

export function parsePuzzleQueryFilters(query = {}) {
  const filters = {}
  const themes = String(query.themes || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (themes.length) filters.themes = themes
  for (const [param, key] of [
    ['minRating', 'minRating'],
    ['maxRating', 'maxRating'],
    ['minPopularity', 'minPopularity'],
    ['maxPopularity', 'maxPopularity'],
  ]) {
    const value = Number(query[param])
    if (Number.isFinite(value)) filters[key] = value
  }
  return filters
}

// True when a download request should export a filtered CSV instead of the full archive.
export function queryHasPuzzleFilters(filters = {}) {
  return Object.keys(filters).length > 0
}

// Sample the indexed CSV to estimate a filtered offline export size.
export async function estimateFilteredPuzzleDatabase(
  { offsets, fd, readLine },
  filters = {},
  { fullBytes = 0, sampleSize = 500 } = {},
) {
  const totalCount = offsets?.length ? Math.max(0, offsets.length - 1) : 0
  if (!queryHasPuzzleFilters(filters) || !offsets?.length || !fd) {
    return {
      totalCount,
      filteredCount: totalCount,
      fullBytes,
      filteredBytes: fullBytes,
      matchRatio: 1,
    }
  }
  const n = offsets.length
  let matches = 0
  let tried = 0
  for (let i = 0; i < sampleSize; i++) {
    const idx = 1 + Math.floor(Math.random() * Math.max(1, n - 1))
    const line = await readLine(fd, offsets[idx])
    const puzzle = parsePuzzleRow(line)
    if (!puzzle) continue
    tried++
    if (puzzleMatchesFilters(puzzle, filters)) matches++
  }
  const matchRatio = tried > 0 ? matches / tried : 0
  const filteredCount = Math.round(totalCount * matchRatio)
  const filteredBytes = Math.max(4096, Math.round(fullBytes * matchRatio))
  return { totalCount, filteredCount, fullBytes, filteredBytes, matchRatio }
}

// Stream a filter-scoped CSV export. Read the decompressed CSV sequentially —
// per-line seeks over ~millions of offsets are far too slow and look "stalled"
// in the PWA download UI.
async function streamFilteredPuzzleDatabase(res, filters) {
  if (state.status !== 'ready' || !state.dir || !state.offsets?.length) {
    res.status(503).json({ error: 'Farm puzzle database is not ready', status: state.status })
    return
  }
  const csvPath = paths(state.dir).csv
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="lichess_db_puzzle_filtered.csv"')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const input = fs.createReadStream(csvPath, { encoding: 'utf8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
  let isHeader = true
  try {
    for await (const line of rl) {
      if (isHeader) {
        isHeader = false
        if (!res.write(`${line}\n`)) await once(res, 'drain')
        continue
      }
      const puzzle = parsePuzzleRow(line)
      if (!puzzle || !puzzleMatchesFilters(puzzle, filters)) continue
      if (!res.write(`${line}\n`)) await once(res, 'drain')
    }
    res.end()
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(err?.message || err) })
      return
    }
    res.destroy(err)
  } finally {
    rl.close()
    input.destroy()
  }
}

export const DEFAULT_STUN_SERVERS = ['stun:stun.l.google.com:19302']

export function resolveStunServers(argv = {}, env = process.env) {
  const fromEnv = String(env?.WIKI_CHESS_STUN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (fromEnv.length) return fromEnv
  const configured = argv?.chess?.stunServers
  if (Array.isArray(configured)) {
    // An explicitly configured array (even empty) is authoritative.
    return configured.map(s => String(s).trim()).filter(Boolean)
  }
  return DEFAULT_STUN_SERVERS.slice()
}

export function puzzleToClientJson(puzzle) {
  return {
    id: puzzle.id,
    fen: puzzle.fen,
    moves: puzzle.moves,
    rating: puzzle.rating,
    // Included so the client can verify a popularity filter against farm results.
    popularity: puzzle.popularity,
    themes: puzzle.themes,
    gameUrl: puzzle.gameUrl,
    source: 'farm',
  }
}

export function reviseChessPageCharmOnPage(page, patch) {
  return reviseChessCharmOnPage(page, patch)
}

export const PUZZLE_DB_ARCHIVE_NAME = 'lichess_db_puzzle.csv.zst'

// True when a decompressed CSV and its offset index are present in `dir`.
export function databaseFilesPresent(dir, fsImpl = fs) {
  if (!dir) return false
  const p = paths(dir)
  return fsImpl.existsSync(p.csv) && fsImpl.existsSync(p.idx)
}

// Path to the compressed archive on disk, when the farm has finished downloading it.
export function puzzleDatabaseArchivePath(dir, fsImpl = fs) {
  if (!dir) return null
  const zst = path.join(dir, PUZZLE_DB_ARCHIVE_NAME)
  return fsImpl.existsSync(zst) ? zst : null
}

const PLUGIN_SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))

// Resolve the puzzle database install directory (`<plugin>/server`).
// The plugin server folder is shared across every site on a wiki farm.
export function resolvePuzzleDatabaseLocations(_argv = {}) {
  return { installDir: PLUGIN_SERVER_DIR }
}

// Return the puzzle database directory (creates under installDir when missing).
export function pickPuzzleDatabaseDir(locations) {
  return locations.installDir
}

// Whether the farm should download the database on server start.
export function resolvePuzzleDatabaseEnabled(argv = {}) {
  return argv?.chess?.puzzleDatabase === true
}

// Client-visible puzzle-database status (exposed on /plugin/chess/config).
export function puzzleDatabasePublicStatus(state, { enabled, zstd }) {
  return {
    enabled,
    status: state.status,
    ready: state.status === 'ready',
    puzzles: state.offsets ? Math.max(0, state.offsets.length - 1) : 0,
    error: state.error,
    zstd,
    installing: ['downloading', 'decompressing', 'indexing'].includes(state.status),
  }
}

// # Database Build Pipeline

function paths(dir) {
  return {
    zst: path.join(dir, PUZZLE_DB_ARCHIVE_NAME),
    csv: path.join(dir, 'lichess_db_puzzle.csv'),
    idx: path.join(dir, 'lichess_db_puzzle.idx'),
  }
}

async function downloadDb(zstPath) {
  const res = await fetch(DB_URL)
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
  const tmp = `${zstPath}.part`
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
  await fsp.rename(tmp, zstPath)
}

// Decode the pzstd container one frame at a time, streaming the plain CSV to disk
// so we never hold the whole archive (or its ~1 GB expansion) in memory.
async function decompressDb(zstPath, csvPath) {
  const inFd = await fsp.open(zstPath, 'r')
  const out = fs.createWriteStream(`${csvPath}.part`)
  try {
    const { size } = await inFd.stat()
    const header = Buffer.alloc(12)
    let pos = 0
    while (pos + 12 <= size) {
      await inFd.read(header, 0, 12, pos)
      const frameSize = pzstdNextFrameSize(header)
      if (frameSize == null) throw new Error(`unexpected frame at byte ${pos}`)
      const start = pos + 12
      if (start + frameSize > size) break // trailing/truncated frame
      const frame = Buffer.alloc(frameSize)
      await inFd.read(frame, 0, frameSize, start)
      const plain = zlib.zstdDecompressSync(frame)
      if (!out.write(plain)) await once(out, 'drain')
      pos = start + frameSize
    }
  } finally {
    await inFd.close()
    out.end()
    await once(out, 'finish')
  }
  await fsp.rename(`${csvPath}.part`, csvPath)
}

// One pass over the CSV recording the byte offset of every line start.
async function buildIndex(csvPath, idxPath) {
  const fd = await fsp.open(csvPath, 'r')
  const offsets = []
  try {
    const { size } = await fd.stat()
    if (size > MAX_INDEXABLE_BYTES) throw new Error('CSV too large to index as Uint32')
    const buf = Buffer.alloc(1 << 20)
    let filePos = 0
    let atLineStart = true
    while (filePos < size) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, filePos)
      if (!bytesRead) break
      for (let i = 0; i < bytesRead; i++) {
        if (atLineStart) {
          offsets.push(filePos + i)
          atLineStart = false
        }
        if (buf[i] === 0x0a) atLineStart = true
      }
      filePos += bytesRead
    }
  } finally {
    await fd.close()
  }
  const arr = Uint32Array.from(offsets)
  await fsp.writeFile(idxPath, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
  return arr
}

async function openReady(dir) {
  const p = paths(dir)
  const idxBuf = await fsp.readFile(p.idx)
  const offsets = new Uint32Array(idxBuf.buffer, idxBuf.byteOffset, Math.floor(idxBuf.byteLength / 4))
  const fd = await fsp.open(p.csv, 'r')
  state.offsets = offsets
  state.fd = fd
  state.status = 'ready'
  state.error = null
}

let building = null
async function buildDb(dir, { force = false } = {}) {
  if (building) return building
  if (!zstdAvailable()) {
    state.status = 'error'
    state.error = 'zstd-unavailable (needs Node ≥ 22.15)'
    return
  }
  building = (async () => {
    const p = paths(dir)
    try {
      await fsp.mkdir(dir, { recursive: true })
      if (force || !fs.existsSync(p.zst)) {
        state.status = 'downloading'
        await downloadDb(p.zst)
      }
      state.status = 'decompressing'
      await decompressDb(p.zst, p.csv)
      state.status = 'indexing'
      if (state.fd) {
        await state.fd.close().catch(() => {})
        state.fd = null
      }
      await buildIndex(p.csv, p.idx)
      await openReady(dir)
      state.downloadedAt = new Date().toISOString()
    } catch (err) {
      state.status = 'error'
      state.error = String(err?.message || err)
    } finally {
      building = null
    }
  })()
  return building
}

// # Random Puzzle Serving

async function readLineAt(fd, offset) {
  let size = 512
  for (let attempt = 0; attempt < 6; attempt++) {
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fd.read(buf, 0, size, offset)
    const nl = buf.indexOf(0x0a)
    if (nl !== -1) return buf.toString('utf8', 0, nl).replace(/\r$/, '')
    if (bytesRead < size) return buf.toString('utf8', 0, bytesRead).replace(/\r$/, '') // EOF
    size *= 4
  }
  return null
}

async function randomPuzzle(filters = {}) {
  if (state.status !== 'ready' || !state.offsets || !state.fd) return null
  const n = state.offsets.length
  if (!n) return null
  const wanted = filters.themes ? new Set(filters.themes) : null
  let fallback = null
  for (let i = 0; i < 80; i++) {
    const idx = Math.floor(Math.random() * n)
    const line = await readLineAt(state.fd, state.offsets[idx])
    const puzzle = parsePuzzleRow(line)
    if (!puzzle) continue // header row or malformed
    fallback = puzzle
    if (filters.minRating != null && puzzle.rating < filters.minRating) continue
    if (filters.maxRating != null && puzzle.rating > filters.maxRating) continue
    if (filters.minPopularity != null && puzzle.popularity < filters.minPopularity) continue
    if (filters.maxPopularity != null && puzzle.popularity > filters.maxPopularity) continue
    if (wanted && !puzzle.themes.some(t => wanted.has(t))) continue
    return puzzle
  }
  return fallback // filters too tight — still return a puzzle rather than nothing
}

// # Plugin Entry Point

export function startServer(params) {
  const { app, argv } = params
  const puzzleDatabaseEnabled = resolvePuzzleDatabaseEnabled(argv)
  const dir = pickPuzzleDatabaseDir(resolvePuzzleDatabaseLocations(argv))
  state.dir = dir

  if (puzzleDatabaseEnabled) {
    if (databaseFilesPresent(dir)) {
      openReady(dir).catch(err => {
        state.status = 'error'
        state.error = String(err?.message || err)
      })
    } else {
      buildDb(dir).catch(() => {})
    }
  }

  const cors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    next()
  }

  const pwaCors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    next()
  }

  // In-scope manifest URL (/plugins/chess/) — Chrome is picky about installability.
  const serveChessManifest = async (req, res) => {
    const { chessPwaManifest } = await import('./pwa-bridge.js')
    res.type('application/manifest+json')
    res.json(chessPwaManifest(req, argv))
  }
  app.get('/plugins/chess/manifest.webmanifest', pwaCors, serveChessManifest)
  app.get('/plugins/chess/manifest.json', pwaCors, serveChessManifest)

  // Installed-PWA wiki bridge — dynamic import on first use only.
  let pwaBridgeRouter = null
  app.use('/plugin/chess/pwa', pwaCors, async (req, res, next) => {
    try {
      if (!pwaBridgeRouter) {
        const { createPwaBridgeRouter } = await import('./pwa-bridge.js')
        pwaBridgeRouter = createPwaBridgeRouter({
          argv,
          securityhandler: app.securityhandler,
          pagehandler: app.pagehandler,
          sitemaphandler: app.sitemaphandler,
          searchhandler: app.searchhandler,
        })
      }
      return pwaBridgeRouter(req, res, next)
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  const stunServers = resolveStunServers(argv)
  app.get('/plugin/chess/config', cors, (req, res) => {
    res.json({
      stunServers,
      puzzleDatabase: puzzleDatabasePublicStatus(state, {
        enabled: puzzleDatabaseEnabled,
        zstd: zstdAvailable(),
      }),
    })
  })

  app.get('/plugin/chess/puzzle-database/estimate', cors, async (req, res) => {
    try {
      const filters = parsePuzzleQueryFilters(req.query)
      let fullBytes = 0
      const archivePath = puzzleDatabaseArchivePath(dir)
      if (archivePath) {
        fullBytes = (await fsp.stat(archivePath)).size
      } else {
        try {
          const head = await fetch(DB_URL, { method: 'HEAD' })
          fullBytes = Number(head.headers.get('Content-Length')) || 302_000_000
        } catch {
          fullBytes = 302_000_000
        }
      }
      const estimate = await estimateFilteredPuzzleDatabase(
        { offsets: state.offsets, fd: state.fd, readLine: readLineAt },
        filters,
        { fullBytes },
      )
      res.json({
        ...estimate,
        hasFilters: queryHasPuzzleFilters(filters),
        filterLabel: filters,
      })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  app.get('/plugin/chess/puzzle-database', cors, async (req, res) => {
    try {
      const filters = parsePuzzleQueryFilters(req.query)
      if (queryHasPuzzleFilters(filters)) {
        await streamFilteredPuzzleDatabase(res, filters)
        return
      }
      const archivePath = puzzleDatabaseArchivePath(dir)
      if (archivePath) {
        const stat = await fsp.stat(archivePath)
        res.setHeader('Content-Type', 'application/zstd')
        res.setHeader('Content-Length', String(stat.size))
        res.setHeader('Content-Disposition', `attachment; filename="${PUZZLE_DB_ARCHIVE_NAME}"`)
        fs.createReadStream(archivePath).pipe(res)
        return
      }
      // Farm archive not on disk yet — proxy from Lichess (browsers cannot fetch it directly).
      const upstream = await fetch(DB_URL)
      if (!upstream.ok || !upstream.body) {
        res.status(503).json({
          error: 'Puzzle database archive is not available yet',
          status: state.status,
        })
        return
      }
      res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/zstd')
      const len = upstream.headers.get('Content-Length')
      if (len) res.setHeader('Content-Length', len)
      res.setHeader('Content-Disposition', `attachment; filename="${PUZZLE_DB_ARCHIVE_NAME}"`)
      await pipeline(Readable.fromWeb(upstream.body), res)
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: String(err?.message || err) })
      }
    }
  })

  app.get('/plugin/chess/puzzle', cors, async (req, res) => {
    if (!puzzleDatabaseEnabled) {
      res.status(404).json({
        error: 'Farm puzzle database is disabled (set chess.puzzleDatabase: true in wiki config)',
      })
      return
    }
    try {
      const puzzle = await randomPuzzle(parsePuzzleQueryFilters(req.query))
      if (!puzzle) {
        res.status(503).json({ status: state.status, error: state.error })
        return
      }
      res.json(puzzleToClientJson(puzzle))
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  app.put('/plugin/chess/revise-page-charm', cors, (req, res) => {
    if (!app.securityhandler?.isAuthorized?.(req)) {
      res.status(401).send('must be owner')
      return
    }
    const { slug, patch } = req.body || {}
    if (!slug || !patch || typeof patch !== 'object') {
      res.status(400).json({ error: 'Missing slug or patch' })
      return
    }
    if (!app.pagehandler?.get || !app.pagehandler?.put) {
      res.status(503).send('page handler unavailable')
      return
    }
    app.pagehandler.get(String(slug), (err, page, status) => {
      if (err) {
        res.status(500).send(String(err))
        return
      }
      if (status === 404 || !page) {
        res.status(404).send('Page not found')
        return
      }
      if (!reviseChessPageCharmOnPage(page, patch)) {
        res.status(200).send('unchanged')
        return
      }
      app.pagehandler.put(String(slug), page, putErr => {
        if (putErr) {
          res.status(500).send(String(putErr))
          return
        }
        res.status(200).send('ok')
      })
    })
  })

  console.log('chess: plugin ready (puzzle DB:', puzzleDatabaseEnabled ? 'enabled' : 'disabled', ')')
  console.log('chess: real-time STUN servers:', stunServers.length ? stunServers.join(', ') : '(none — LAN only)')
}
