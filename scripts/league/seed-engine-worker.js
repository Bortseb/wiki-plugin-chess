/**
 * Forked child process for the league seeder's parallel Stockfish pool.
 *
 * Parent: scripts/dev-tools.js → scripts/league/index.js (`EnginePool` forks one of these per CPU core).
 * Child: owns a single Stockfish instance and plays whole games on demand.
 *
 * Must stay separate from dev-tools.js because:
 *   - `fork()` needs its own entry file
 *   - stockfish WASM refuses to initialize in worker_threads
 *
 * IPC: parent sends `{ type: 'play', id, whiteElo, blackElo, opts }`;
 * child replies `{ type: 'result', id, game }` or `{ type: 'error', id, message }`.
 */
import { createEngine, playEngineGame } from './engine-pool.js'
let enginePromise = null
const engine = async () => {
  if (!enginePromise) enginePromise = createEngine()
  return enginePromise
}

process.on('message', async msg => {
  if (msg?.type !== 'play') return
  const { id, whiteElo, blackElo, opts } = msg
  try {
    const eng = await engine()
    const game = await playEngineGame(eng, whiteElo, blackElo, {
      ...opts,
      onProgress: progress => {
        process.send({ type: 'progress', id, ply: progress.ply, turn: progress.turn, score: progress.score })
      },
    })
    process.send({ type: 'result', id, game })
  } catch (err) {
    process.send({ type: 'error', id, message: String(err?.message || err) })
  }
})

// Tell the pool this child's engine is up and ready to accept games.
engine().then(
  () => process.send({ type: 'ready' }),
  err => process.send({ type: 'fatal', message: String(err?.message || err) }),
)
