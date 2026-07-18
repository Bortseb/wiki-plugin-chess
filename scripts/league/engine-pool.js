/**
 * Stockfish engine pool for league seeding (parallel forked workers).
 *
 * Parent: scripts/league/index.js (`EnginePool` forks one child per CPU core).
 * Child: scripts/league/seed-engine-worker.js — must stay separate for `fork()` + WASM limits.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { Chess } from 'chess.mjs/src/Chess.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const initEngine = require('stockfish')

const ELO_MIN = 1320
const ELO_MAX = 2850

export function skillToElo(trueSkill) {
  const v = Math.round(Number(trueSkill) || 1500)
  return Math.min(ELO_MAX, Math.max(ELO_MIN, v))
}

class Engine {
  constructor(raw) {
    this.raw = raw
    this.pending = null
    raw.listener = line => this.#onLine(String(line))
  }

  #onLine(line) {
    const p = this.pending
    if (!p) return
    if (p.onInfo) p.onInfo(line)
    if (p.doneRe.test(line)) {
      this.pending = null
      p.resolve(line)
    }
  }

  #send(cmd) {
    this.raw.sendCommand(cmd)
  }

  #await(cmd, doneRe, onInfo) {
    return new Promise(resolve => {
      this.pending = { doneRe, onInfo, resolve }
      this.#send(cmd)
    })
  }

  async init() {
    await this.#await('uci', /^uciok\b/)
    this.#send('setoption name UCI_LimitStrength value true')
    this.#send('setoption name Hash value 16')
    await this.#await('isready', /^readyok\b/)
  }

  async #searchPosition(moves, elo, movetime, fen = null) {
    this.#send(`setoption name UCI_Elo value ${elo}`)
    const pos = fen
      ? `position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`
      : moves.length
        ? `position startpos moves ${moves.join(' ')}`
        : 'position startpos'
    this.#send(pos)
    let score = null
    const line = await this.#await(`go movetime ${movetime}`, /^bestmove\b/, info => {
      const m = /\bscore (cp|mate) (-?\d+)/.exec(info)
      if (m) score = m[1] === 'mate' ? { mate: Number(m[2]) } : { cp: Number(m[2]) }
    })
    const move = line.split(/\s+/)[1]
    return { move: move && move !== '(none)' ? move : null, score }
  }

  async search(moves, elo, movetime) {
    return this.#searchPosition(moves, elo, movetime)
  }

  // Stable position assessment (stronger Elo / longer think than per-move play).
  async evalPosition(moves, elo, movetime) {
    return this.#searchPosition(moves, elo, movetime)
  }

  // Full-strength analysis from an arbitrary FEN (Academy puzzle audit).
  // Temporarily disables UCI_LimitStrength; restores limited mode afterward for league play.
  async analyzeFen(fen, { movetime = 200, multipv = 1 } = {}) {
    const pv = Math.max(1, Math.min(5, Math.trunc(multipv) || 1))
    this.#send('setoption name UCI_LimitStrength value false')
    this.#send(`setoption name MultiPV value ${pv}`)
    this.#send(`position fen ${fen}`)
    const pvs = new Map()
    const line = await this.#await(`go movetime ${movetime}`, /^bestmove\b/, info => {
      const mpv = /\bmultipv (\d+)\b/.exec(info)
      const sc = /\bscore (cp|mate) (-?\d+)/.exec(info)
      const pvM = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(info)
      if (!sc || !pvM) return
      const idx = mpv ? Number(mpv[1]) : 1
      pvs.set(idx, {
        move: pvM[1],
        score: sc[1] === 'mate' ? { mate: Number(sc[2]) } : { cp: Number(sc[2]) },
      })
    })
    this.#send('setoption name MultiPV value 1')
    this.#send('setoption name UCI_LimitStrength value true')
    const ranked = [...pvs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    const best = line.split(/\s+/)[1]
    const move = best && best !== '(none)' ? best : ranked[0]?.move || null
    return { move, score: ranked[0]?.score || null, pvs: ranked }
  }

  quit() {
    try {
      this.#send('quit')
    } catch {
      /* ignore */
    }
  }
}

const ENGINE_MODULE = 'stockfish/bin/stockfish-18-lite-single.js'

export async function createEngine() {
  try {
    delete require.cache[require.resolve(ENGINE_MODULE)]
  } catch {
    /* fall back to whatever initEngine resolves */
  }
  const raw = await initEngine('lite-single')
  const engine = new Engine(raw)
  await engine.init()
  return engine
}

function isLosing(score, resignCp) {
  if (!score) return false
  if (typeof score.mate === 'number') return score.mate < 0
  return typeof score.cp === 'number' && score.cp <= -resignCp
}

// UCI scores are from the side to move; normalize to white's perspective.
export function scoreFromWhitePerspective(score, turn) {
  if (!score) return null
  if (typeof score.mate === 'number') {
    const mate = turn === 'w' ? score.mate : -score.mate
    return { mate }
  }
  if (typeof score.cp === 'number') {
    const cp = turn === 'w' ? score.cp : -score.cp
    return { cp }
  }
  return null
}

export function formatEngineScore(scoreWhite) {
  if (!scoreWhite) return '…'
  if (typeof scoreWhite.mate === 'number') {
    const n = scoreWhite.mate
    if (n > 0) return `M${n} W`
    if (n < 0) return `M${Math.abs(n)} B`
    return 'M0'
  }
  if (typeof scoreWhite.cp !== 'number') return '…'
  const pawns = scoreWhite.cp / 100
  if (Math.abs(pawns) < 0.05) return '≈0'
  const lead = pawns > 0 ? 'W' : 'B'
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)} ${lead}`
}

export async function playEngineGame(
  engine,
  whiteElo,
  blackElo,
  {
    movetime = 30,
    maxPlies = 200,
    resignCp = 900,
    resignStreak = 3,
    resignEvalMs = 80,
    resignEvalElo = null,
    onProgress = null,
  } = {},
) {
  const chess = new Chess()
  const uciMoves = []
  const sans = []
  let ending = 'cap'
  let result = '1/2-1/2'
  const streak = { w: 0, b: 0 }
  const evalElo = resignEvalElo ?? Math.max(whiteElo, blackElo, 1800)

  for (let ply = 0; ply < maxPlies; ply += 1) {
    const turn = chess.turn()
    const elo = turn === 'w' ? whiteElo : blackElo

    // Resignation: evaluate the position on the board before this player moves.
    // Using the post-move score from the player-strength search was the main bug:
    // at 24ms / limited Elo that eval is noisy and often wrong (e.g. a side still
    // materially ahead but flagged as losing after a shallow blunder line).
    const { score: posScore } = await engine.evalPosition(uciMoves, evalElo, resignEvalMs)
    if (onProgress) onProgress({ ply: sans.length, turn, score: posScore })
    if (isLosing(posScore, resignCp)) {
      streak[turn] += 1
      if (streak[turn] >= resignStreak) {
        ending = 'resign'
        result = turn === 'w' ? '0-1' : '1-0'
        break
      }
    } else {
      streak[turn] = 0
    }

    const { move } = await engine.search(uciMoves, elo, movetime)
    if (!move) {
      ending = chess.in_checkmate() ? 'checkmate' : 'draw'
      result = chess.in_checkmate() ? (turn === 'w' ? '0-1' : '1-0') : '1/2-1/2'
      break
    }

    const applied = chess.move({
      from: move.slice(0, 2),
      to: move.slice(2, 4),
      promotion: move[4] || undefined,
    })
    if (!applied) {
      ending = 'draw'
      result = '1/2-1/2'
      break
    }
    uciMoves.push(move)
    sans.push(applied.san)

    if (chess.game_over()) {
      ending = chess.in_checkmate() ? 'checkmate' : 'draw'
      result = chess.in_checkmate() ? (turn === 'w' ? '1-0' : '0-1') : '1/2-1/2'
      break
    }
  }

  let mt = ''
  for (let i = 0; i < sans.length; i += 1) {
    if (i % 2 === 0) mt += `${i / 2 + 1}. `
    mt += `${sans[i]} `
  }
  return { movetext: `${mt}${result}`.trim(), result, plies: sans.length, ending }
}

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-engine-worker.js')

export class EnginePool {
  constructor(size = 4) {
    this.size = Math.max(1, Math.trunc(size) || 1)
    this.children = []
    this.idle = []
    this.queue = []
    this.jobs = new Map()
    this.nextId = 1
  }

  async init() {
    await Promise.all(Array.from({ length: this.size }, () => this.#spawn()))
    return this
  }

  #spawn() {
    return new Promise((resolve, reject) => {
      const child = fork(WORKER_PATH, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
      let ready = false
      child.on('message', msg => {
        if (msg?.type === 'ready') {
          ready = true
          this.idle.push(child)
          this.#drain()
          resolve()
        } else if (msg?.type === 'fatal') {
          if (!ready) reject(new Error(msg.message))
        } else if (msg?.type === 'progress') {
          const job = this.jobs.get(msg.id)
          if (!job?.onProgress) return
          job.onProgress({ ply: msg.ply, turn: msg.turn, score: msg.score })
        } else if (msg?.type === 'result' || msg?.type === 'error') {
          const job = this.jobs.get(msg.id)
          if (!job) return
          this.jobs.delete(msg.id)
          this.idle.push(child)
          if (msg.type === 'result') job.resolve(msg.game)
          else job.reject(new Error(msg.message))
          this.#drain()
        }
      })
      child.on('error', err => {
        if (!ready) reject(err)
      })
      this.children.push(child)
    })
  }

  #drain() {
    while (this.idle.length && this.queue.length) {
      const child = this.idle.shift()
      const task = this.queue.shift()
      const id = this.nextId++
      this.jobs.set(id, { resolve: task.resolve, reject: task.reject, child, onProgress: task.onProgress })
      child.send({
        type: 'play',
        id,
        whiteElo: task.whiteElo,
        blackElo: task.blackElo,
        opts: task.opts,
      })
    }
  }

  playGame(whiteElo, blackElo, opts = {}) {
    const { onProgress, ...engineOpts } = opts
    return new Promise((resolve, reject) => {
      this.queue.push({ whiteElo, blackElo, opts: engineOpts, onProgress, resolve, reject })
      this.#drain()
    })
  }

  async close() {
    for (const child of this.children) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    this.children = []
    this.idle = []
  }
}
