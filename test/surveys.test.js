/** Unit tests for src/surveys.js — Glicko-2, twin audit, open-challenge gates. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  newRatingState,
  rateGame,
  auditTwins,
  buildOpenChallenge,
  challengeRatingGate,
  CHALLENGE_REJECT_BELOW_MIN,
  CHALLENGE_REJECT_ABOVE_MAX,
  CHALLENGE_REJECT_UNKNOWN_RATING,
  BLACK_WIN,
} from '../src/surveys.js'

const TWIN_PGN = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]

1. e4 e5 2. Nf3 Nc6 *`

describe('surveys', () => {
  describe('Glicko-2 rateGame', () => {
    it('raises the winner and lowers the loser', () => {
      const strong = newRatingState({ rating: 1800 })
      const weak = newRatingState({ rating: 1200 })
      const upset = rateGame({ white: strong, black: weak, result: BLACK_WIN })
      assert.ok(upset.white.rating < strong.rating)
      assert.ok(upset.black.rating > weak.rating)
    })

    it('moves ratings toward each other on a draw', () => {
      const high = newRatingState({ rating: 1700 })
      const low = newRatingState({ rating: 1300 })
      const draw = rateGame({ white: high, black: low, result: '1/2-1/2' })
      assert.ok(draw.white.rating < high.rating)
      assert.ok(draw.black.rating > low.rating)
    })

    it('returns null for an unknown result', () => {
      const a = newRatingState({ rating: 1500 })
      const b = newRatingState({ rating: 1500 })
      assert.equal(rateGame({ white: a, black: b, result: '*' }), null)
    })
  })

  describe('twin audit', () => {
    it('verifies matching forked records', () => {
      const audit = auditTwins(TWIN_PGN, TWIN_PGN)
      assert.equal(audit.verified, true)
      assert.equal(audit.reason, 'twin verified')
    })

    it('rejects divergent movetext', () => {
      const divergent = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]

1. e4 c5 *`
      const audit = auditTwins(TWIN_PGN, divergent)
      assert.equal(audit.verified, false)
      assert.match(audit.reason, /diverge|fingerprint|illegal/)
    })

    it('rejects a missing remote twin', () => {
      const audit = auditTwins(TWIN_PGN, '')
      assert.equal(audit.verified, false)
      assert.match(audit.reason, /no twin/)
    })
  })

  describe('challenge rating gate', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'alice.localhost (Alice)',
      creatorHost: 'alice.localhost',
      minRating: 1200,
      maxRating: 1800,
      creatorRating: 1500,
    })

    it('accepts a viewer inside the range', () => {
      assert.deepEqual(challengeRatingGate(challenge, 1500), { ok: true, reason: null })
    })

    it('rejects viewers below the minimum or above the maximum', () => {
      assert.equal(challengeRatingGate(challenge, 1100).reason, CHALLENGE_REJECT_BELOW_MIN)
      assert.equal(challengeRatingGate(challenge, 1900).reason, CHALLENGE_REJECT_ABOVE_MAX)
    })

    it('rejects viewers with unknown ratings when bounds are set', () => {
      assert.equal(challengeRatingGate(challenge, null).reason, CHALLENGE_REJECT_UNKNOWN_RATING)
    })
  })
})
