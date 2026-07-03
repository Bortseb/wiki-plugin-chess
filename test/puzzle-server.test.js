/** Unit tests for server/puzzle-server.js — puzzle DB helpers and STUN config. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  pzstdNextFrameSize,
  parsePuzzleQueryFilters,
  resolveStunServers,
  DEFAULT_STUN_SERVERS,
} from '../server/puzzle-server.js'

describe('puzzle server helpers', () => {
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
    assert.deepEqual(
      resolveStunServers({ chess: { stunServers: ['stun:a:1'] } }, {}),
      ['stun:a:1'],
    )
  })
})
