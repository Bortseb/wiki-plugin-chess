import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCorrespondenceGamePage,
  pushGameTwins,
  applyCompletedGameIndexToSurveyPage,
  applyFederationCharmToLeaderboardPage,
  gamePresentation,
  uniqueGameTitles,
  parseSeedArgs,
  buildPopulation,
  formatSimDuration,
  buildSeedFlagLines,
  formatSeedCommandLine,
  normalizeLeagueSeedFarmMeta,
  buildLeagueSeedFarmMeta,
  rosterChangedFromFarmMeta,
  SEED_ROSTER_SIZE,
  DEFAULT_SEED_PLAYERS,
  SEED_MIN_PLAYERS,
  SEED_MAX_PLAYERS,
} from '../scripts/league/index.js'
import { parsePgnParts, rebuildStoryFromJournal } from '../src/chess-core.js'
import { readChessPageCharm } from '../src/federation.js'

function revisionStory(journal, revIndex) {
  const story = rebuildStoryFromJournal({
    title: 'Test',
    journal: journal.slice(0, revIndex + 1),
  })
  return story.find(item => item.type === 'chess')?.text || ''
}

function makeSeat(name, host) {
  return { name, host, games: [] }
}

describe('devtools · league-seed', () => {
  describe('formatSimDuration', () => {
    it('formats compact elapsed clocks', () => {
      assert.equal(formatSimDuration(0), '0s')
      assert.equal(formatSimDuration(4500), '4s')
      assert.equal(formatSimDuration(125_000), '2m 05s')
      assert.equal(formatSimDuration(3_720_000), '1h 02m')
    })
  })

  describe('seed flag readout', () => {
    it('lists effective flags with explanations', () => {
      const opts = parseSeedArgs([
        '--players=12',
        '--islands=3',
        '--bridges=2',
        '--bad-actors=2',
        '--global-share=0.5',
        '--engine-ms=36',
        '--reset',
      ])
      const players = buildPopulation(opts, () => 0.5)
      const rows = buildSeedFlagLines(opts, players)
      const byFlag = Object.fromEntries(rows.map(r => [r.flag, r]))
      assert.equal(byFlag['--players'].value, '12')
      assert.equal(byFlag['--islands'].value, '3')
      assert.equal(byFlag['--bridges'].value, '2')
      assert.equal(byFlag['--bad-actors'].value, '2')
      assert.ok(byFlag['--global-share'].why.includes('local-only'))
      assert.ok(byFlag['--engine-ms'].why.includes('think time'))
      assert.equal(byFlag['--reset'].value, 'on')
      const cli = formatSeedCommandLine(opts, players)
      assert.ok(cli.includes('league seed'))
      assert.ok(cli.includes('--islands=3'))
      assert.ok(cli.includes('--bad-actors=2'))
      assert.ok(cli.includes('--engine-ms=36'))
    })
  })

  describe('buildCorrespondenceGamePage', () => {
    const base = {
      title: 'Tessa vs Frank',
      intro: 'Rated game replay.',
      introId: 'intro1',
      itemId: 'chess1',
      opponentSite: 'tessa.localhost:3001',
      baseTags: {
        Event: 'Tessa vs Frank',
        White: 'tessa.localhost:3001 (Tessa)',
        Black: 'frank.localhost:3001 (Frank)',
        Result: '1-0',
      },
      result: '1-0',
      startMs: 1_700_000_000_000,
    }

    it("stamps the final result on both seats when the last ply is the opponent's", () => {
      const base = {
        Event: 'Tessa vs Frank',
        White: 'tessa.localhost:3001 (Tessa)',
        Black: 'frank.localhost:3001 (Frank)',
        Result: '1-0',
      }
      const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']
      for (const side of ['white', 'black']) {
        const page = buildCorrespondenceGamePage({
          ...base,
          side,
          title: 'Tessa vs Frank',
          intro: 'Rated game replay.',
          introId: 'intro1',
          itemId: 'chess1',
          opponentSite: side === 'white' ? 'frank.localhost:3001' : 'tessa.localhost:3001',
          sans,
          baseTags: base,
          result: '1-0',
          startMs: 1_700_000_000_000,
        })
        const pgn = page.story.find(item => item.id === 'chess1')?.text || ''
        assert.equal(parsePgnParts(pgn).tags.Result, '1-0')
      }
    })

    it('stores fork sites as bare hostnames for wiki journal rendering', () => {
      const { journal } = buildCorrespondenceGamePage({
        ...base,
        side: 'black',
        sans: ['e4', 'e5', 'Nf3'],
      })
      const forks = journal.filter(e => e.type === 'fork')
      assert.ok(forks.length > 0)
      for (const fork of forks) {
        assert.ok(typeof fork.site === 'string' && fork.site.length > 0)
        assert.ok(!fork.site.startsWith('http'))
      }
    })

    it('records forks on both seats during correspondence play', () => {
      const sans = ['e4', 'e5', 'Nf3', 'Nc6']
      const white = buildCorrespondenceGamePage({ ...base, side: 'white', sans })
      const black = buildCorrespondenceGamePage({
        ...base,
        side: 'black',
        ownerSite: 'frank.localhost:3001',
        opponentSite: 'tessa.localhost:3001',
        sans,
      })
      const whiteForks = white.journal.filter(e => e.type === 'fork').length
      const blackForks = black.journal.filter(e => e.type === 'fork').length
      assert.ok(whiteForks > 0, 'white journal should fork opponent updates')
      assert.ok(blackForks > 0, 'black journal should fork opponent updates')
      // Page-fork lockstep: each side adopts the other after every opposing move.
      assert.ok(whiteForks >= 2, 'white forks black moves (and may carry copied forks)')
      assert.ok(blackForks >= 2, 'black forks white at accept and later white moves')
    })

    it("inherits white's opening journal before the accept fork on black's page", () => {
      const sans = ['e4', 'e5', 'Nf3']
      const black = buildCorrespondenceGamePage({
        ...base,
        side: 'black',
        ownerSite: 'frank.localhost:3001',
        opponentSite: 'tessa.localhost:3001',
        sans,
      })
      const acceptForkIdx = black.journal.findIndex(
        action => action.type === 'fork' && action.site === 'tessa.localhost:3001',
      )
      assert.ok(acceptForkIdx > 0, 'accept fork should follow inherited white history')
      const inherited = black.journal.slice(0, acceptForkIdx)
      assert.ok(
        inherited.some(action => action.type === 'edit' && action.symbol === '♙'),
        'white e4 is native before accept',
      )
      const laterFork = black.journal.findIndex(
        (action, idx) => action.type === 'fork' && action.site === 'tessa.localhost:3001' && idx > acceptForkIdx,
      )
      assert.ok(laterFork >= 0, 'later white moves are page-forked after accept')
    })

    it('keeps intro copy above the chess item when the journal is replayed', () => {
      const page = buildCorrespondenceGamePage({
        ...base,
        itemId: 'chess-item-01',
        introId: 'intro-item-01',
        sans: [],
        result: '1-0',
      })
      assert.equal(page.story[0]?.id, 'intro-item-01')
      assert.equal(page.story[1]?.id, 'chess-item-01')
      const chessAdd = page.journal.find(action => action.type === 'add' && action.id === 'chess-item-01')
      assert.equal(chessAdd?.after, 'intro-item-01')
    })

    it('records opponent move glyphs when fork-merging before own moves', () => {
      const page = buildCorrespondenceGamePage({
        ...base,
        side: 'black',
        opponentSite: 'tessa.localhost:3001',
        sans: ['d4', 'Nf6'],
      })
      const opponentGlyph = page.journal.find(action => action.type === 'edit' && action.symbol === '♙')
      const ownGlyph = page.journal.find(action => action.type === 'edit' && action.symbol === '♞')
      assert.ok(opponentGlyph, 'fork merge should journal the opponent pawn (d4)')
      assert.ok(ownGlyph, 'seat should journal its own knight reply (Nf6)')
    })

    it('records opponent move glyphs on the white seat too', () => {
      const page = buildCorrespondenceGamePage({
        ...base,
        side: 'white',
        opponentSite: 'frank.localhost:3001',
        sans: ['e4', 'e5', 'Nf3'],
      })
      const ownOpen = page.journal.find(action => action.type === 'edit' && action.symbol === '♙')
      const opponentReply = page.journal.find(action => action.type === 'edit' && action.symbol === '♟')
      const ownReply = page.journal.find(action => action.type === 'edit' && action.symbol === '♘')
      assert.ok(ownOpen, 'white should journal e4')
      assert.ok(opponentReply, 'white should journal black e5 after fork merge')
      assert.ok(ownReply, 'white should journal Nf3')
    })

    it('replays the first knight edit to the matching partial movetext', () => {
      const sans = ['d4', 'Nf6', 'Bf4']
      const page = buildCorrespondenceGamePage({
        ...base,
        side: 'black',
        opponentSite: 'frank.localhost:3001',
        sans,
      })
      const knightEditIndex = page.journal.findIndex(action => action.type === 'edit' && action.symbol === '♞')
      assert.ok(knightEditIndex >= 0, 'black Nf6 edit should carry a knight glyph')
      const pgn = revisionStory(page.journal, knightEditIndex)
      assert.match(pgn, /1\.\s*d4\s+Nf6/)
    })

    it('stores FEN snapshots on move edits', () => {
      const page = buildCorrespondenceGamePage({
        ...base,
        side: 'white',
        sans: ['e4'],
      })
      const moveEdit = page.journal.find(action => action.type === 'edit' && action.symbol === '♙')
      assert.ok(moveEdit?.fen, 'move edit should record board FEN')
      assert.ok(moveEdit?.fenKey, 'move edit should record a transposition key')
    })

    it('keeps one chess item id in story edits and the Site tag', () => {
      const itemId = 'a1b2c3d4e5f60789'
      const page = buildCorrespondenceGamePage({
        ...base,
        itemId,
        baseTags: {
          ...base.baseTags,
          Site: `http://tessa.localhost:3001 (id: ${itemId})`,
        },
        sans: ['e4', 'e5', 'Nf3'],
      })
      assert.equal(page.story.length, 2)
      assert.equal(page.story[0]?.type, 'paragraph')
      assert.equal(page.story[1]?.type, 'chess')
      assert.ok(!page.story.some(item => item.type === 'code'))
      const chess = page.story.find(item => item.type === 'chess')
      assert.equal(chess?.id, itemId)
      const { tags } = parsePgnParts(chess.text)
      assert.match(String(tags.Site || ''), new RegExp(`\\(id:\\s*${itemId}\\)`, 'i'))
      const editIds = page.journal
        .filter(action => action.type === 'edit' && action.item?.type === 'chess')
        .map(action => action.id)
      assert.ok(editIds.length > 0)
      assert.ok(editIds.every(id => id === itemId))
    })
  })

  describe('pushGameTwins', () => {
    it('assigns the same item ids to forked twins', () => {
      const white = makeSeat('Tessa', 'tessa.localhost:3001')
      const black = makeSeat('Frank', 'frank.localhost:3001')
      pushGameTwins(white, black, {
        uid: 'gameuid',
        itemId: 'sharedchessitem01',
        introId: 'sharedintroitem01',
        pgn: '[Site "http://tessa.localhost:3001 (id: sharedchessitem01)"]\n*',
      })
      assert.equal(white.games.length, 1)
      assert.equal(black.games.length, 1)
      assert.equal(white.games[0].itemId, 'sharedchessitem01')
      assert.equal(black.games[0].itemId, 'sharedchessitem01')
      assert.equal(white.games[0].introId, 'sharedintroitem01')
      assert.equal(black.games[0].introId, 'sharedintroitem01')
    })
  })

  describe('game page naming (hop convention)', () => {
    const day = Date.UTC(2026, 5, 3)

    it('titles matchups as White vs Black only', () => {
      const rated = gamePresentation({
        white: 'Ada',
        black: 'Bjorn',
        dateMs: day,
        rated: true,
        tournament: null,
      })
      assert.equal(rated.title, 'Ada vs Bjorn')
      assert.match(rated.intro, /^Rated game\. Played /)

      const casual = gamePresentation({
        white: 'Ada',
        black: 'Bjorn',
        dateMs: day,
        rated: false,
        tournament: null,
      })
      assert.equal(casual.title, 'Ada vs Bjorn')
      assert.match(casual.intro, /^Casual game \(unrated\)\. Played /)

      const tourney = gamePresentation({
        white: 'Ada',
        black: 'Bjorn',
        dateMs: day,
        rated: true,
        tournament: { name: 'FedWiki Open Championship' },
        round: 3,
        board: 2,
      })
      assert.equal(tourney.title, 'Ada vs Bjorn')
      assert.equal(tourney.intro, 'FedWiki Open Championship, round 3, board 2. Played 2026.06.03.')
    })

    it('adds a numeric suffix when the same matchup slug collides', () => {
      const games = [
        { uid: 'b', white: 'Ada', black: 'Bjorn', dateMs: day, rated: true, tournament: null },
        { uid: 'a', white: 'Ada', black: 'Bjorn', dateMs: day, rated: true, tournament: null },
      ]
      const rows = uniqueGameTitles(games)
      assert.equal(rows[0].title, 'Ada vs Bjorn (2)')
      assert.equal(rows[0].slug, 'ada-vs-bjorn-2')
      assert.equal(rows[1].title, 'Ada vs Bjorn')
      assert.equal(rows[1].slug, 'ada-vs-bjorn')
    })
  })

  describe('seed page.chess metadata', () => {
    it('does not write gameIndex on My Chess Games (survey lists games by crawl)', () => {
      const surveyPage = { title: 'My Chess Games', story: [{ type: 'chess', id: 's1', text: 'SURVEY' }], journal: [] }
      assert.equal(
        applyCompletedGameIndexToSurveyPage(surveyPage, 'frank.localhost:3001', [
          { slug: 'game-a', itemId: 'c1' },
          { slug: 'game-b', itemId: 'c2' },
        ]),
        false,
      )
      assert.equal(surveyPage.chess?.gameIndex, undefined)
      assert.equal(
        surveyPage.journal.some(entry => entry.type === 'chess-charm'),
        false,
      )
    })

    it('writes federation checkpoint on Chess Leaderboards', () => {
      const page = {
        title: 'Chess Leaderboards',
        story: [{ type: 'chess', id: 'lb', text: 'LEADERBOARD' }],
        journal: [],
      }
      applyFederationCharmToLeaderboardPage(page, {
        checkpoint: {
          state_hash: 'abc123',
          last_timeline_key: '2026-01-01|deadbeef',
          last_processed_game_hash: 'deadbeef',
          last_global_sync_timestamp: '2026-01-01T00:00:00.000Z',
        },
        entries: [{ site: 'frank.localhost:3001', rating: 1500, rd: 80 }],
      })
      const meta = readChessPageCharm(page)
      assert.equal(meta.federation.checkpoint.state_hash, 'abc123')
      assert.equal(
        page.journal.some(entry => entry.type === 'chess-charm'),
        false,
      )
      assert.equal(page.chess?.federation?.checkpoint?.state_hash, 'abc123')
      assert.equal(page.chess?.federation?.topTiers, undefined)
    })
  })

  describe('league seed metadata', () => {
    it('normalizes farm roster snapshots', () => {
      const meta = normalizeLeagueSeedFarmMeta({
        version: 1,
        seed: 7,
        players: 28,
        rosterDirs: ['localhost', 'alice.localhost'],
        rosterSites: ['localhost:3001', 'alice.localhost:3001'],
        generatedAt: '2026-07-09T00:00:00.000Z',
      })
      assert.equal(meta.players, 28)
      assert.deepEqual(meta.rosterDirs, ['localhost', 'alice.localhost'])
    })

    it('detects roster shrink as a change requiring reset', () => {
      const prev = buildLeagueSeedFarmMeta({ seed: 1 }, [
        { dir: 'localhost', host: 'localhost:3001' },
        { dir: 'alice.localhost', host: 'alice.localhost:3001' },
      ])
      const next = [{ dir: 'localhost', host: 'localhost:3001' }]
      assert.equal(rosterChangedFromFarmMeta(prev, next), true)
    })

    it('ignores unchanged rosters for auto-reset', () => {
      const players = [
        { dir: 'localhost', host: 'localhost:3001' },
        { dir: 'alice.localhost', host: 'alice.localhost:3001' },
      ]
      const prev = buildLeagueSeedFarmMeta({ seed: 1 }, players)
      assert.equal(rosterChangedFromFarmMeta(prev, players), false)
    })

    it('treats player-count changes as roster changes', () => {
      const prev = buildLeagueSeedFarmMeta({ seed: 1 }, [
        { dir: 'localhost', host: 'localhost:3001' },
        { dir: 'alice.localhost', host: 'alice.localhost:3001' },
        { dir: 'bjorn.localhost', host: 'bjorn.localhost:3001' },
      ])
      const next = [
        { dir: 'localhost', host: 'localhost:3001' },
        { dir: 'alice.localhost', host: 'alice.localhost:3001' },
      ]
      assert.equal(rosterChangedFromFarmMeta(prev, next), true)
    })
  })

  describe('seed --players', () => {
    function stubRng() {
      let i = 0
      return () => {
        i += 1
        return ((i * 37) % 1000) / 1000
      }
    }

    it('defaults to the classic 28-player cohort', () => {
      const opts = parseSeedArgs([])
      assert.equal(opts.players, null)
      const players = buildPopulation(opts, stubRng())
      assert.equal(DEFAULT_SEED_PLAYERS, 28)
      assert.equal(players.length, DEFAULT_SEED_PLAYERS)
      assert.equal(players[0].name, 'Rob')
      assert.equal(players[players.length - 1].name, 'Yara')
    })

    it('honours --players within the built-in roster', () => {
      const opts = parseSeedArgs(['--players=5'])
      assert.equal(opts.players, 5)
      const players = buildPopulation(opts, stubRng())
      assert.equal(players.length, 5)
      assert.deepEqual(
        players.map(p => p.name),
        ['Rob', 'Bishop', 'Ada', 'Alice', 'Bjorn'],
      )
    })

    it('fills --players=100 with real names from the extended roster', () => {
      assert.equal(SEED_ROSTER_SIZE, SEED_MAX_PLAYERS)
      const opts = parseSeedArgs(['--players=100'])
      const players = buildPopulation(opts, stubRng())
      assert.equal(players.length, 100)
      assert.equal(players[0].name, 'Rob')
      assert.equal(players[27].name, 'Yara')
      assert.equal(players[28].name, 'Anya')
      assert.equal(players[99].name, 'Zoe')
      assert.ok(players.every(p => !/^Player[A-Z]\d+$/.test(p.name)))
    })

    it('keeps the original name order at the front of the roster', () => {
      const players = buildPopulation(parseSeedArgs(['--players=100']), stubRng())
      assert.deepEqual(
        players.slice(0, 28).map(p => p.name),
        [
          'Rob',
          'Bishop',
          'Ada',
          'Alice',
          'Bjorn',
          'Carmen',
          'Deepak',
          'Elif',
          'Frank',
          'Gita',
          'Hugo',
          'Ivy',
          'Jonas',
          'Kira',
          'Liam',
          'Mira',
          'Niko',
          'Olga',
          'Pavel',
          'Qadir',
          'Rosa',
          'Sami',
          'Tessa',
          'Ulf',
          'Vivi',
          'Wes',
          'Xander',
          'Yara',
        ],
      )
    })

    it('clamps --players to the allowed range', () => {
      assert.equal(parseSeedArgs(['--players=1']).players, SEED_MIN_PLAYERS)
      assert.equal(parseSeedArgs(['--players=999']).players, SEED_MAX_PLAYERS)
      assert.equal(buildPopulation(parseSeedArgs(['--players=1']), stubRng()).length, SEED_MIN_PLAYERS)
      assert.equal(buildPopulation(parseSeedArgs(['--players=999']), stubRng()).length, SEED_MAX_PLAYERS)
    })

    it('partitions the roster into islands', () => {
      const opts = parseSeedArgs(['--players=12', '--islands=3', '--bridges=2'])
      assert.equal(opts.islands, 3)
      assert.equal(opts.bridges, 2)
      const players = buildPopulation(opts, stubRng())
      assert.equal(players.length, 12)
      const islands = new Set(players.map(p => p.island))
      assert.deepEqual(
        [...islands].sort((a, b) => a - b),
        [0, 1, 2],
      )
      assert.equal(players[0].island, 0)
      assert.ok(players[0].islandName)
      const meta = buildLeagueSeedFarmMeta(opts, players)
      assert.equal(meta.islands, 3)
      assert.equal(meta.bridges, 2)
      assert.equal(meta.islandRoster.length, 3)
      assert.equal((meta.badActors || []).length, 0)
    })

    it('splits global Open vs local-only and marks sparse islands', () => {
      const opts = parseSeedArgs([
        '--players=12',
        '--islands=3',
        '--global-share=0.5',
        '--sparse-islands=1',
        '--sparse-factor=0.4',
      ])
      assert.equal(opts.globalShare, 0.5)
      assert.equal(opts.sparseIslands, 1)
      const players = buildPopulation(opts, stubRng())
      const hub = players.find(p => p.existing) || players[0]
      assert.equal(hub.globalEligible, true)
      assert.equal(hub.localOnly, false)
      const localOnly = players.filter(p => p.localOnly)
      const globalField = players.filter(p => p.globalEligible)
      assert.ok(localOnly.length >= 1, 'some players stay local-only')
      assert.ok(globalField.length >= 2, 'global Open needs a field')
      assert.equal(localOnly.length + globalField.length, players.length)
      assert.ok(!localOnly.some(p => p.host === hub.host))
      const sparseIslands = new Set(players.filter(p => p.islandSparse).map(p => p.island))
      assert.equal(sparseIslands.size, 1)
      assert.ok(!sparseIslands.has(0), 'hub island stays dense')
      const meta = buildLeagueSeedFarmMeta(opts, players)
      assert.equal(meta.globalPlayers.length, globalField.length)
      assert.equal(meta.localOnlyPlayers.length, localOnly.length)
      assert.deepEqual(meta.sparseIslands, [...sparseIslands])
    })

    it('randomizes --bad-actors into distrust (never hub)', () => {
      const opts = parseSeedArgs(['--players=12', '--islands=3', '--bad-actors=2'])
      assert.equal(opts.badActors, 2)
      assert.equal(parseSeedArgs(['--cheaters=3']).badActors, 3)
      const players = buildPopulation(opts, stubRng())
      const bad = players.filter(p => p.badActor)
      assert.equal(bad.length, 2)
      const hub = players.find(p => p.existing) || players[0]
      assert.ok(hub)
      assert.equal(hub.badActor, false)
      assert.ok(!bad.some(p => p.host === hub.host), 'hub is never a bad actor')
      assert.deepEqual(hub.distrust.slice().sort(), bad.map(p => p.host).sort())
      for (const p of bad) assert.deepEqual(p.distrust, [])
      const meta = buildLeagueSeedFarmMeta(opts, players)
      assert.equal(meta.badActors.length, 2)
      assert.ok(Object.keys(meta.distrust || {}).length > 0)
    })
  })
})
