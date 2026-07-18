/**
 * Web Worker — Glicko-2 timeline replay off the wiki shell main thread.
 * Built to client/glicko-worker.js; posted messages: { games, blockList?, chunkEvents? }.
 */
import {
  collectVerifiedTimelineEvents,
  replayEventsOntoPlayersBatched,
  computeStateHash,
  readGameTimelineKey,
  normalizeBlockList,
} from './federation.js'

// # Worker Message Handler

self.onmessage = event => {
  const data = event.data || {}
  try {
    const pool = Array.isArray(data.games) ? data.games : []
    const blockList = normalizeBlockList(data.blockList)
    const chunkEvents = Math.max(10, Math.trunc(Number(data.chunkEvents) || 48))
    const events = collectVerifiedTimelineEvents(pool, { blockList })
    let players = {}
    const total = events.length
    for (let i = 0; i < events.length; i += chunkEvents) {
      const slice = events.slice(i, i + chunkEvents)
      const partial = replayEventsOntoPlayersBatched(slice, players)
      players = partial.players
      const done = Math.min(i + chunkEvents, total)
      self.postMessage({
        type: 'progress',
        eventsDone: done,
        eventsTotal: total,
        message: total > 0 ? `Recomputing ratings ${done}/${total}…` : 'Recomputing ratings…',
      })
    }
    const last = events.length ? events[events.length - 1] : null
    self.postMessage({
      type: 'done',
      result: {
        players,
        stateHash: computeStateHash(players),
        lastGameHash: last ? readGameTimelineKey(last.pgn).hash : '',
        lastTimelineKey: last ? last.key : '',
      },
    })
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: String(err?.message || err || 'Glicko worker failed'),
    })
  }
}
