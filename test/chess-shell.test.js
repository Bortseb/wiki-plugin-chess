/** Shell save-gateway helpers — pure logic extracted from src/chess.js for unit tests. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripCreatePreviewFlag,
  mapChessSaveActionsForJournal,
  clearGhostBootstrapJournal,
  shouldSplitOpenSeatGameJournal,
  buildStartPgn,
  claimSeat,
  keepGhostUntilSeatsFilled,
  buildChessSaveActions,
} from '../src/chess-core.js'

describe('shell · journal gateway', () => {
  it('stripCreatePreviewFlag removes pending flags', () => {
    const item = {
      type: 'chess',
      id: 'g1',
      text: 'GAME',
      createPreviewPendingJournal: true,
      openChallengeSetupPending: true,
    }
    const next = stripCreatePreviewFlag(item)
    assert.equal(next.createPreviewPendingJournal, undefined)
    assert.equal(next.openChallengeSetupPending, undefined)
    assert.equal(item.createPreviewPendingJournal, true)
  })

  it('stripCreatePreviewFlag clears flags nested under create.item.story', () => {
    const item = {
      title: 'New Chess Position',
      story: [
        {
          type: 'chess',
          id: 'g1',
          text: 'POSITION',
          createPreviewPendingJournal: true,
        },
      ],
    }
    const next = stripCreatePreviewFlag(item)
    assert.equal(next.story[0].createPreviewPendingJournal, undefined)
    assert.equal(item.story[0].createPreviewPendingJournal, true)
  })

  it('clearGhostBootstrapJournal drops the id-less ghost create', () => {
    const page = {
      title: 'Ghost',
      story: [{ type: 'chess', id: 'g1', text: 'POSITION' }],
      journal: [{ type: 'create', item: { title: 'Ghost', story: [] }, date: 1 }],
    }
    clearGhostBootstrapJournal(page)
    assert.deepEqual(page.journal, [])
  })

  it('clearGhostBootstrapJournal keeps a slug materialize create', () => {
    const page = {
      journal: [
        {
          type: 'create',
          id: 'bjorn-vs-stockfish-level-3',
          item: { title: 'Game', story: [] },
          date: 1,
        },
      ],
    }
    clearGhostBootstrapJournal(page)
    assert.equal(page.journal.length, 1)
    assert.equal(page.journal[0].id, 'bjorn-vs-stockfish-level-3')
  })

  it('mapChessSaveActionsForJournal optionally strips ghost flags from journal items', () => {
    const actions = [
      {
        type: 'edit',
        item: {
          story: [{ type: 'chess', id: 'g1', text: 'GAME' }],
          createPreviewPendingJournal: true,
        },
      },
    ]
    const stripped = mapChessSaveActionsForJournal(actions, { stripGhost: true })
    assert.equal(stripped[0].item.createPreviewPendingJournal, undefined)
    const passthrough = mapChessSaveActionsForJournal(actions, { stripGhost: false })
    assert.equal(passthrough[0].item.createPreviewPendingJournal, true)
  })

  it('routes open-seat first save through split journal actions', () => {
    const ctx = { ownerName: 'host', wikiSite: 'host.localhost', pageOnThisWiki: true }
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    const nextText = claimSeat(openBoard, 'White', ctx)
    const prevText = 'GAME'
    assert.equal(shouldSplitOpenSeatGameJournal(prevText, nextText), true)
    const page = {
      story: [{ type: 'chess', id: 'g1', text: prevText }],
      journal: [],
    }
    const actions = buildChessSaveActions(page, 'g1', nextText)
    assert.equal(actions.length, 2)
    assert.match(actions[1].item.text, /host\.localhost \(host\)/)
  })

  it('does not keep engine ghosts until seats fill — materialize may create immediately', () => {
    const pgn = buildStartPgn({
      gameType: 'engine',
      stockfishLevel: 3,
      localSeat: 'w',
      signedInDisplayName: 'Olga',
      wikiSite: 'olga.localhost:3001',
      pageOnThisWiki: true,
    })
    assert.equal(keepGhostUntilSeatsFilled(pgn), false)
    assert.equal(shouldSplitOpenSeatGameJournal('POSITION', pgn), false)
  })

  it('splits autosave when opponent and own plies arrive in one PGN update', () => {
    const prevText = `[White "olga.localhost:3001 (Olga)"]
[Black "rosa.localhost:3001 (Rosa)"]
[HumanPlay "remote"]
[Result "*"]

1. e4`
    const nextText = `[White "olga.localhost:3001 (Olga)"]
[Black "rosa.localhost:3001 (Rosa)"]
[HumanPlay "remote"]
[Result "*"]

1. e4 e5 2. Nf3`
    const page = {
      story: [{ type: 'chess', id: 'g1', text: prevText }],
      journal: [],
    }
    const actions = buildChessSaveActions(page, 'g1', nextText, {
      viewingSite: 'olga.localhost:3001',
    })
    assert.equal(actions.length, 2)
    assert.equal(actions[0].fork, 'rosa.localhost:3001')
    assert.match(actions[0].item.text, /1\.\s*e4\s+e5/)
    assert.equal(actions[1].fork, undefined)
    assert.match(actions[1].item.text, /2\.\s*Nf3/)
  })

  it('collapses duplicated PGN headers before writing journal edits', () => {
    const headers = `[Event "Federated Wiki Chess"]
[Site "http://olga.localhost:3001 (id: g1)"]
[Date "2026.07.10"]
[Round "-"]
[White "bjorn.localhost:3001 (Bjorn)"]
[Black "olga.localhost:3001 (Olga)"]
[Result "*"]
[HumanPlay "remote"]
[Rated "yes"]`
    const prevText = `${headers}

1. e4 e5 2. Nf3`
    const dupNext = `${headers}

${headers}

1. e4 e5 2. Nf3 Nc6`
    assert.equal((dupNext.match(/\[Event /g) || []).length, 2)
    const page = {
      story: [{ type: 'chess', id: 'g1', text: prevText }],
      journal: [],
    }
    const actions = buildChessSaveActions(page, 'g1', dupNext, {
      viewingSite: 'bjorn.localhost:3001',
    })
    assert.ok(actions.length >= 1)
    for (const action of actions) {
      const text = action.item.text
      assert.equal((text.match(/\[Event /g) || []).length, 1, text)
      assert.equal((text.match(/\[Rated /g) || []).length, 1, text)
    }
  })
})
