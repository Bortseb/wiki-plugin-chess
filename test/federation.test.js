/** Unit tests for src/federation.js — Glicko-2, twin audit, open-challenge gates. */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newRatingState,
  rateGame,
  auditTwins,
  buildOpenChallenge,
  challengeRatingGate,
  challengeJoinGate,
  challengeVisibleToViewer,
  resolveJoinerSeatId,
  shouldDismissChallengeJoinGhostForPwa,
  shouldShowChallengeJoinGhostForkBanner,
  shouldShowOpenChallengeBanner,
  isOpenChallenge,
  proposeOpenChallengePageTitle,
  proposeNewGamePageTitle,
  openChallengeDisplayTitle,
  resolveChallengeJoinerColor,
  formatGameRowMetaLine,
  proposeUniquePageTitle,
  collectLineupPageSlugs,
  isGhostProposedTitle,
  isReplaceableGhostPageTitle,
  resolveStartModalPageTitle,
  buildChallengeJoinGhostPgn,
  acceptOpenChallenge,
  reconstructGhostPgnFromSeated,
  harvestAcceptedGhostGame,
  partitionOpenChallenges,
  buildMyGamesList,
  syncPendingFromTwin,
  buildAcceptedGhostGamesList,
  mergeMyGamesLists,
  pageSlug,
  harvestGhostOpenChallenge,
  harvestPageOpenChallenge,
  harvestSurveyOpenChallenges,
  openChallengeSurveyRecord,
  openChallengeUsesJoinGhost,
  isOpenChallengeCreatePreviewContext,
  chessChallengesFromPage,
  foreignOpenChallengeItemIds,
  applyOpenChallengeSurveyEdit,
  applyOpenChallengeRecordsEdit,
  syncOpenChallengeSurveyOnPage,
  readSurveyOpenChallengeRecords,
  buildSurveyItemText,
  parseSurveyRecord,
  readTrustedPeers,
  applyTrustedPeersToPage,
  filterFederatedLeaderboardEntries,
  sitesMatch,
  pastOpponentSitesFromGames,
  opponentSitesFromGamesForSites,
  neighborhoodOpponentsFromGames,
  buildFetchTargets,
  buildSurveyFetchSeeds,
  farmPeerParentKey,
  filterSiblingFarmPeers,
  farmPeerHostsFromDataDirs,
  fetchFarmPeerSites,
  parsePresentRollSites,
  parseChessPluginIndexSites,
  fetchChessPluginIndexSites,
  resetChessPluginIndexCacheForTests,
  resolveFetchSeeds,
  resolveFederationIndexLeafHosts,
  CHESS_PLUGIN_INDEX_TTL_MS,
  refreshFederationSitesFromIndex,
  LEADERBOARD_PAGE_STORY,
  LEADERBOARD_PAGE_TITLE,
  SURVEY_PAGE_TITLE,
  SURVEY_PAGE_STORY,
  applyLeaderboardConsensusToPage,
  buildFederationGossipPatch,
  reviseChessCharmOnPage,
  chessCharmPatchWouldChange,
  shouldPublishFederationGossip,
  deriveGossipTrustedPeers,
  stampOpenChallengePgn,
  openChallengeFromPgn,
  detectMissingTwinFinding,
  missingTwinFindingsFromPool,
  normalizeChessCharmPatch,
  readChessPageCharm,
  isSurveyItemText,
  CHALLENGE_STATUS_ACTIVE,
  CHALLENGE_COLOR_WHITE,
  CHALLENGE_COLOR_BLACK,
  CHALLENGE_COLOR_RANDOM,
  CHALLENGE_REJECT_BELOW_MIN,
  CHALLENGE_REJECT_ABOVE_MAX,
  CHALLENGE_REJECT_UNKNOWN_RATING,
  CHALLENGE_REJECT_OWNERS_ONLY,
  CHALLENGE_REJECT_WRONG_SITE,
  probeWikiSite,
  wikiSiteValidationErrorMessage,
  protocolForSite,
  pageUrl,
  fetchWikiResourceWithProtocolFallback,
  isLoopbackWikiHost,
  runFederationConsensus,
  applyIncrementalTimeline,
  localCheckpointStillCurrent,
  shouldCloseGlickoBatch,
  filterOpenChallengesByBlockList,
  applyDeletionRatioMetrics,
  computeIslandState,
  shouldShowIslandNotice,
  ISLAND_CONTRACTION_RATIO,
  readGameTimelineKey,
  GLICKO_BATCH_GAME_LIMIT,
  stampCompletionTags,
  clonePlayersMap,
  BLACK_WIN,
  WHITE_WIN,
  createBrowserWikiSiteClient,
  buildPastOpponentsBoardAsync,
  buildLeaderboardAsync,
  buildLeaderboard,
  rankLeaderboard,
  filterLeaderboardEntries,
  leaderboardPlayerDisplayName,
  columnPreferredSortDir,
  LEADERBOARD_COLUMNS,
  mapWithConcurrency,
  fetchSiteGamePagesAsync,
  gameIndexHasUnreadableEntries,
  filterOpenChallengesStillSeeking,
  readGameIndex,
  normalizeGameIndexEntry,
  fetchFederationGamesAsync,
  collectSiteGamesAsync,
  fetchChallengesAsync,
  mergeFederationSitesCache,
  normalizeFederationSitesCache,
  FEDERATION_SITES_CACHE_TTL_MS,
  SITE_FETCH_CONCURRENCY,
  HOST_FETCH_CONCURRENCY,
  sitemapSnapshotForCrawl,
  diffSitemapSnapshots,
  formatCrawlEtaLabel,
  estimateCrawlEtaSeconds,
  pruneSiteCrawlCache,
  normalizeSiteCrawlCache,
  buildCrawlHits,
  crawlHitSiteReferences,
  crawlHitGameReferences,
  orchestrateSiteSurveyDeferredWork,
  hopTrustAt,
  previewHopTrustSchedule,
  normalizeNeighborhoodGraphOpts,
  HOP_TRUST_FLOOR,
  DEFAULT_NEIGHBORHOOD_HOP_DECAY,
  buildAcademyTeachingPageWithJournal,
} from '../src/federation.js'
import { applyPageAction, normalizeWikiSite, setPeerMissingPgnTag, readPeerMissingPgnTag } from '../src/chess-core.js'

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function readDefaultPage(slug) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'pages', slug), 'utf8'))
}

function storyFingerprint(story) {
  return (Array.isArray(story) ? story : []).map(item => ({
    type: item.type,
    id: item.id,
    text: item.text,
  }))
}

const TWIN_PGN = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]

1. e4 e5 2. Nf3 Nc6 *`

describe('lib · federation', () => {
  describe('crawl hits for Last crawl ghost pages', () => {
    it('lists only games from crawled hosts and builds site/game references', () => {
      const cache = {
        'alice.localhost': {
          site: 'alice.localhost',
          updatedAt: 1,
          sitemap: [{ slug: 'game-one', date: 1 }],
          games: [
            {
              slug: 'game-one',
              title: 'Game One',
              pgn: '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 *',
              site: 'alice.localhost',
            },
          ],
        },
        'bob.localhost': {
          site: 'bob.localhost',
          updatedAt: 1,
          sitemap: [{ slug: 'other-game', date: 1 }],
          games: [
            {
              slug: 'other-game',
              title: 'Other Game',
              pgn: '[White "Carol"]\n[Black "Dave"]\n\n1. d4 *',
              site: 'bob.localhost',
            },
          ],
        },
      }
      const hits = buildCrawlHits({
        sites: ['alice.localhost'],
        cacheHitSites: ['alice.localhost', 'carol.localhost'],
        siteCrawlCache: cache,
      })
      assert.deepEqual(hits.sites, ['alice.localhost'])
      assert.deepEqual(hits.cacheHitSites, ['alice.localhost'])
      assert.equal(hits.games.length, 1)
      assert.equal(hits.games[0].slug, 'game-one')
      assert.match(hits.games[0].text, /Alice vs Bob/)

      const siteRefs = crawlHitSiteReferences(hits.sites)
      assert.equal(siteRefs[0].slug, 'welcome-visitors')
      assert.equal(siteRefs[0].site, 'alice.localhost')

      const gameRefs = crawlHitGameReferences(hits.games)
      assert.equal(gameRefs[0].title, 'Game One')
      assert.equal(gameRefs[0].site, 'alice.localhost')
    })

    it('returns empty games when no crawled sites are supplied', () => {
      const hits = buildCrawlHits({
        sites: [],
        siteCrawlCache: {
          'alice.localhost': {
            site: 'alice.localhost',
            updatedAt: 1,
            sitemap: [],
            games: [{ slug: 'x', title: 'X', pgn: '1. e4 *', site: 'alice.localhost' }],
          },
        },
      })
      assert.deepEqual(hits.sites, [])
      assert.deepEqual(hits.games, [])
    })
  })

  describe('federated leaderboard filters', () => {
    const board = [
      { rank: 1, site: 'alice.localhost', rating: 1600 },
      { rank: 2, site: 'bob.localhost', rating: 1500 },
      { rank: 3, site: 'carol.localhost', rating: 1400 },
    ]

    it('filters neighborhood as a view over visible federation ratings', () => {
      const filtered = filterFederatedLeaderboardEntries(board, 'neighborhood', {
        localSite: 'alice.localhost',
        neighborhoodSites: ['bob.localhost'],
        neighborhoodOpponents: ['carol.localhost'],
      })
      assert.deepEqual(
        filtered.map(r => r.site),
        ['alice.localhost', 'bob.localhost', 'carol.localhost'],
      )
      assert.deepEqual(
        filtered.map(r => r.rank),
        [1, 2, 3],
      )
      assert.equal(filtered[0].rating, 1600)
    })

    it('includes local past opponents in the neighbourhood view', () => {
      const filtered = filterFederatedLeaderboardEntries(board, 'neighborhood', {
        localSite: 'alice.localhost',
        neighborhoodSites: [],
        pastOpponents: ['bob.localhost', 'carol.localhost'],
      })
      assert.deepEqual(
        filtered.map(r => r.site),
        ['alice.localhost', 'bob.localhost', 'carol.localhost'],
      )
    })

    it('filters past opponents as a view over visible federation ratings', () => {
      const filtered = filterFederatedLeaderboardEntries(board, 'mine', {
        localSite: 'alice.localhost',
        pastOpponents: ['carol.localhost'],
      })
      assert.deepEqual(
        filtered.map(r => r.site),
        ['alice.localhost', 'carol.localhost'],
      )
      assert.equal(filtered[1].rating, 1400)
    })

    it('matches hosts ignoring port when filtering reach views', () => {
      const withPorts = [
        { rank: 1, site: 'alice.localhost:3001', rating: 1600 },
        { rank: 2, site: 'bob.localhost:3001', rating: 1500 },
        { rank: 3, site: 'carol.localhost:3001', rating: 1400 },
      ]
      const neighborhood = filterFederatedLeaderboardEntries(withPorts, 'neighborhood', {
        localSite: 'alice.localhost',
        neighborhoodSites: [],
      })
      assert.deepEqual(
        neighborhood.map(r => r.site),
        ['alice.localhost:3001'],
      )

      const past = filterFederatedLeaderboardEntries(withPorts, 'mine', {
        localSite: 'alice.localhost:3001',
        pastOpponents: ['carol.localhost'],
      })
      assert.deepEqual(
        past.map(r => r.site),
        ['alice.localhost:3001', 'carol.localhost:3001'],
      )
    })

    it('derives past opponents from rated games involving the local host', () => {
      const games = [
        `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Rated "Yes"]
*`,
        `[White "carol.localhost (Carol)"]
[Black "dave.localhost (Dave)"]
[Rated "Yes"]
*`,
      ]
      assert.deepEqual(pastOpponentSitesFromGames(games, 'alice.localhost'), ['bob.localhost'])
    })

    it('derives neighbourhood opponents from rated games involving any neighbourhood site', () => {
      const games = [
        `[White "bob.localhost (Bob)"]
[Black "carol.localhost (Carol)"]
[Rated "Yes"]
*`,
        `[White "alice.localhost (Alice)"]
[Black "dave.localhost (Dave)"]
[Rated "Yes"]
*`,
      ]
      assert.deepEqual(neighborhoodOpponentsFromGames(games, 'alice.localhost', ['bob.localhost']), [
        'carol.localhost',
        'dave.localhost',
      ])
      assert.deepEqual(opponentSitesFromGamesForSites(games, ['bob.localhost']), ['carol.localhost'])
    })
  })

  describe('trusted peers roster', () => {
    it('stores trusted peers in page.chess federation metadata', () => {
      const page = {
        title: 'Chess Leaderboards',
        story: LEADERBOARD_PAGE_STORY.map(entry => ({ ...entry })),
        journal: [],
      }
      applyTrustedPeersToPage(page, ['alice.localhost', 'bob.localhost'])
      assert.deepEqual(readTrustedPeers(page), ['alice.localhost', 'bob.localhost'])
    })

    it('stores federation checkpoint in page.chess without changing the visible story', () => {
      const page = { title: 'Chess Leaderboards', story: [], journal: [] }
      const items = [
        { type: 'paragraph', id: 'a1b2c3d4e5f67890', text: 'Old intro.' },
        { type: 'chess', id: 'b2c3d4e5f6789012', text: 'LEADERBOARD' },
      ]
      for (const item of items) {
        applyPageAction(page, {
          type: 'add',
          after: page.story[page.story.length - 1]?.id || '',
          item,
        })
      }
      const storyBefore = page.story.map(entry => entry.id)
      applyLeaderboardConsensusToPage(page, {
        checkpoint: { state_hash: 'keep-me' },
      })
      assert.deepEqual(
        page.story.map(entry => entry.id),
        storyBefore,
      )
      assert.equal(page.chess?.federation?.checkpoint?.state_hash, 'keep-me')
      assert.equal(
        page.journal.find(entry => entry.type === 'move'),
        undefined,
      )
    })

    it('reads trusted peers from page.chess', () => {
      const page = {
        title: 'Chess Leaderboards',
        story: [],
        journal: [],
        chess: { federation: { trustedPeers: ['alice.localhost'] } },
      }
      assert.deepEqual(readTrustedPeers(page), ['alice.localhost'])
      assert.deepEqual(
        buildSurveyFetchSeeds('me.localhost', {
          neighborhoodSites: ['neighbor.localhost'],
          knownOpponents: ['opp.localhost'],
          indexSites: ['chess.viki.wiki', 'neighbor.localhost', 'me.localhost'],
        }),
        ['me.localhost', 'opp.localhost', 'neighbor.localhost', 'chess.viki.wiki'],
      )
      assert.deepEqual(
        buildSurveyFetchSeeds('me.localhost', {
          neighborhoodSites: ['neighbor.localhost'],
        }),
        ['me.localhost', 'neighbor.localhost'],
      )
      assert.deepEqual(
        buildFetchTargets({
          localSite: 'me.localhost',
          neighborhoodSites: ['neighbor.localhost'],
        }),
        ['me.localhost', 'neighbor.localhost'],
      )
    })

    it('stores federation maintenance data in page.chess instead of visible story blocks', () => {
      const page = { title: 'Chess Leaderboards', story: [], journal: [] }
      for (const item of LEADERBOARD_PAGE_STORY) {
        applyPageAction(page, {
          type: 'add',
          after: page.story[page.story.length - 1]?.id || '',
          item: { ...item },
        })
      }
      applyLeaderboardConsensusToPage(page, {
        checkpoint: { state_hash: 'abc', last_timeline_key: '2026-01-01|deadbeef' },
      })
      assert.equal(page.chess?.federation?.checkpoint?.state_hash, 'abc')
      assert.equal(page.chess?.federation?.blocklist, undefined)
      assert.equal(page.chess?.federation?.topTiers, undefined)
      assert.equal(
        page.story.find(entry => String(entry.text || '').startsWith('Checkpoint:')),
        undefined,
      )
    })

    it('stores gossip in page.chess only, not duplicate chess-charm journal entries', () => {
      const page = { title: 'Chess Leaderboards', story: [], journal: [] }
      applyLeaderboardConsensusToPage(page, {
        checkpoint: {
          state_hash: 'abc',
          last_timeline_key: '2026-01-01|deadbeef',
          last_global_sync_timestamp: '2026-01-01T00:00:00.000Z',
        },
        force: true,
      })
      assert.equal(page.journal.filter(entry => entry.type === 'chess-charm').length, 0)
      applyLeaderboardConsensusToPage(page, {
        checkpoint: {
          state_hash: 'abc',
          last_timeline_key: '2026-01-01|deadbeef',
          last_global_sync_timestamp: '2026-04-08T12:00:00.000Z',
        },
      })
      assert.equal(page.journal.filter(entry => entry.type === 'chess-charm').length, 0)
      assert.equal(page.chess?.federation?.checkpoint?.last_global_sync_timestamp, undefined)
    })

    it('does not persist top tiers or leaderboard rows in page gossip', () => {
      const page = { title: 'Chess Leaderboards', story: [], journal: [] }
      applyLeaderboardConsensusToPage(page, {
        checkpoint: { state_hash: 'abc123' },
        force: true,
      })
      const patch = buildFederationGossipPatch({
        checkpoint: { state_hash: 'abc123' },
      })
      assert.equal(chessCharmPatchWouldChange(page, patch), false)
    })

    it('publishes page gossip when the checkpoint fingerprint changes', () => {
      const page = { title: 'Chess Leaderboards', story: [], journal: [] }
      applyLeaderboardConsensusToPage(page, {
        checkpoint: { state_hash: 'hash-a', last_timeline_key: '2026-01-01|aaaa' },
        force: true,
      })
      assert.equal(
        shouldPublishFederationGossip(readChessPageCharm(page).federation, {
          checkpoint: { state_hash: 'hash-a', last_timeline_key: '2026-01-01|aaaa' },
        }),
        false,
      )
      assert.equal(
        applyLeaderboardConsensusToPage(page, {
          checkpoint: { state_hash: 'hash-a', last_timeline_key: '2026-01-01|aaaa' },
        }),
        false,
      )
      assert.equal(
        shouldPublishFederationGossip(readChessPageCharm(page).federation, {
          checkpoint: { state_hash: 'hash-b', last_timeline_key: '2026-01-02|bbbb' },
        }),
        true,
      )
      assert.equal(
        applyLeaderboardConsensusToPage(page, {
          checkpoint: { state_hash: 'hash-b', last_timeline_key: '2026-01-02|bbbb' },
        }),
        true,
      )
    })

    it('derives trusted peers from federation participants on publish', () => {
      assert.deepEqual(deriveGossipTrustedPeers(['alice.localhost', 'bob.localhost'], { localSite: 'me.localhost' }), [
        'alice.localhost',
        'bob.localhost',
      ])
      assert.deepEqual(deriveGossipTrustedPeers([], { localSite: 'me.localhost', previous: ['alice.localhost'] }), [
        'alice.localhost',
      ])
    })

    it('revises page.chess without touching story or journal', () => {
      const story = LEADERBOARD_PAGE_STORY.map(entry => ({ ...entry }))
      const page = { title: 'Chess Leaderboards', story, journal: [] }
      assert.equal(
        reviseChessCharmOnPage(page, {
          federation: { trustedPeers: ['alice.localhost:3001'] },
        }),
        true,
      )
      assert.equal(page.story, story)
      assert.equal(page.story.length, LEADERBOARD_PAGE_STORY.length)
      assert.deepEqual(page.journal, [])
      assert.deepEqual(page.chess?.federation?.trustedPeers, ['alice.localhost:3001'])
    })

    it('normalizeChessCharmPatch keeps gameIndex catalog patches', () => {
      const patch = normalizeChessCharmPatch({
        gameIndex: { active: [{ site: 'a.localhost', slug: 'g1', itemId: 'c1' }], challenges: [], completed: [] },
        federation: { trustedPeers: ['bob.localhost'] },
      })
      assert.equal(patch.gameIndex?.active?.length, 1)
      assert.equal(patch.gameIndex.active[0].slug, 'g1')
      assert.deepEqual(patch.federation?.trustedPeers, ['bob.localhost'])
    })

    it('reviseChessCharmOnPage persists survey gameIndex without journal noise', () => {
      const page = {
        title: SURVEY_PAGE_TITLE,
        story: SURVEY_PAGE_STORY.map(entry => ({ ...entry })),
        journal: [],
      }
      assert.equal(
        reviseChessCharmOnPage(page, {
          gameIndex: {
            completed: [{ site: 'a.localhost', slug: 'g1', itemId: 'c1', gameHash: 'abc', rated: true }],
            active: [],
            challenges: [],
          },
        }),
        true,
      )
      assert.equal(page.journal.length, 0)
      assert.equal(page.chess?.gameIndex?.completed?.[0]?.slug, 'g1')
      assert.equal(page.chess.gameIndex.completed[0].gameHash, 'abc')
    })
  })

  describe('open-challenge PGN tags', () => {
    it('round-trips stampOpenChallengePgn / openChallengeFromPgn', () => {
      const seekPgn = `[White "alice.localhost (Alice)"]
[Black ""]
[Result "*"]

*`
      const challenge = buildOpenChallenge({
        rated: true,
        creatorColor: CHALLENGE_COLOR_WHITE,
        minRating: 1200,
        maxRating: 1800,
        creatorId: 'alice.localhost (Alice)',
        creatorSite: 'alice.localhost',
        creatorRating: 1500,
        challengeTarget: 'bob.localhost:3001',
        ts: 1_700_000_000_000,
      })
      const stamped = stampOpenChallengePgn(seekPgn, challenge)
      assert.match(stamped, /\[ChallengeCreator "alice\.localhost \(Alice\)"\]/)
      assert.match(stamped, /\[CreatorColor "White"\]/)
      assert.match(stamped, /\[Rated "yes"\]/)
      assert.match(stamped, /\[MinRating "1200"\]/)
      assert.match(stamped, /\[MaxRating "1800"\]/)
      assert.match(stamped, /\[ChallengeTarget "bob\.localhost:3001"\]/)
      assert.match(stamped, /\[ChallengeTs "1700000000000"\]/)
      assert.match(stamped, /\[CreatorRating "1500"\]/)
      const parsed = openChallengeFromPgn(stamped)
      assert.equal(parsed?.status, 'open')
      assert.equal(parsed?.config?.rated, true)
      assert.equal(parsed?.config?.creatorColor, CHALLENGE_COLOR_WHITE)
      assert.equal(parsed?.config?.minRating, 1200)
      assert.equal(parsed?.config?.maxRating, 1800)
      assert.equal(parsed?.creator?.id, 'alice.localhost (Alice)')
      assert.equal(parsed?.creator?.rating, 1500)
      assert.equal(parsed?.challengeTarget, 'bob.localhost:3001')
      assert.equal(parsed?.ts, 1_700_000_000_000)
    })

    it('allows blank ChallengeTarget for open federation seeks', () => {
      const seekPgn = `[White "alice.localhost (Alice)"]
[Black ""]
[Result "*"]

*`
      const challenge = buildOpenChallenge({
        rated: true,
        creatorColor: CHALLENGE_COLOR_WHITE,
        creatorId: 'alice.localhost (Alice)',
        creatorSite: 'alice.localhost',
        challengeTarget: '',
        ts: 1_700_000_000_000,
      })
      const stamped = stampOpenChallengePgn(seekPgn, challenge)
      assert.doesNotMatch(stamped, /\[ChallengeTarget/)
      const parsed = openChallengeFromPgn(stamped)
      assert.equal(parsed?.challengeTarget, undefined)
      assert.equal(parsed?.status, 'open')
    })

    it('derives opponent when both seats are filled (join ghost)', () => {
      const seated = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "*"]
[ChallengeCreator "alice.localhost (Alice)"]
[CreatorColor "White"]
[Rated "yes"]
[ChallengeTs "1700000000000"]

*`
      const parsed = openChallengeFromPgn(seated)
      assert.equal(parsed?.status, 'active')
      assert.equal(parsed?.creator?.id, 'alice.localhost (Alice)')
      assert.equal(parsed?.opponent?.id, 'bob.localhost (Bob)')
      assert.equal(parsed?.opponent?.site, 'bob.localhost')
    })

    it('preserves opponent from fallbackChallenge when re-parsing', () => {
      const seated = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "*"]
[ChallengeCreator "alice.localhost (Alice)"]
[CreatorColor "White"]
[Rated "yes"]

*`
      const fallback = acceptOpenChallenge(
        buildOpenChallenge({
          rated: true,
          creatorColor: CHALLENGE_COLOR_WHITE,
          creatorId: 'alice.localhost (Alice)',
          creatorSite: 'alice.localhost',
        }),
        { joinerId: 'bob.localhost (Bob)', joinerSite: 'bob.localhost', joinerRating: 1400 },
      )
      const parsed = openChallengeFromPgn(seated, { fallbackChallenge: fallback })
      assert.equal(parsed?.opponent?.id, 'bob.localhost (Bob)')
      assert.equal(parsed?.opponent?.rating, 1400)
    })
  })

  describe('missing-twin findings', () => {
    const localRated = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "1-0"]
[Rated "Yes"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 1-0`

    it('detects a missing twin when the peer is up', () => {
      const finding = detectMissingTwinFinding({
        localPgn: localRated,
        peerSite: 'bob.localhost',
        peerUp: true,
        twinPgn: null,
        localSite: 'alice.localhost',
      })
      assert.equal(finding?.kind, 'missing-twin')
      assert.equal(finding?.peerSite, 'bob.localhost')
      assert.equal(finding?.explicitMark, false)
    })

    it('detects an explicit PeerMissing mark', () => {
      const marked = setPeerMissingPgnTag(localRated, true)
      assert.equal(readPeerMissingPgnTag(marked), true)
      const finding = detectMissingTwinFinding({
        localPgn: marked,
        peerSite: 'bob.localhost',
        peerUp: false,
        twinPgn: null,
        localSite: 'alice.localhost',
      })
      assert.equal(finding?.explicitMark, true)
      assert.match(finding?.reason || '', /PeerMissing/)
    })

    it('builds findings from a crawled pool without a twin copy', () => {
      const findings = missingTwinFindingsFromPool([localRated], {
        localSite: 'alice.localhost',
        fetchedSites: ['bob.localhost'],
      })
      assert.equal(findings.length, 1)
      assert.equal(findings[0].peerSite, 'bob.localhost')
    })

    it('skips findings when a twin copy is present in the pool', () => {
      const twin = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "1-0"]
[Rated "Yes"]
[Site "bob.localhost"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 1-0`
      const findings = missingTwinFindingsFromPool([localRated, twin], {
        localSite: 'alice.localhost',
        fetchedSites: ['bob.localhost'],
      })
      assert.equal(findings.length, 0)
    })
  })

  describe('static SURVEY item', () => {
    it('parses name from a body line', () => {
      const text = 'SURVEY\nname: Spring Open'
      const rec = parseSurveyRecord(text)
      assert.equal(rec.survey, 'global')
      assert.equal(rec.name, 'Spring Open')
    })

    it('defaults to the global survey', () => {
      const text = buildSurveyItemText()
      assert.equal(text, 'SURVEY')
      const rec = parseSurveyRecord(text)
      assert.equal(rec.survey, 'global')
    })

    it('does not treat SURVEY RATED as a survey item', () => {
      assert.equal(parseSurveyRecord('SURVEY RATED'), null)
      assert.equal(isSurveyItemText('SURVEY RATED'), false)
    })

    it('does not treat named survey keywords as survey items', () => {
      assert.equal(parseSurveyRecord('SURVEY club'), null)
      assert.equal(isSurveyItemText('SURVEY club'), false)
    })
  })

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

    it('tallies wins and losses by colour', () => {
      const a = newRatingState({ rating: 1500 })
      const b = newRatingState({ rating: 1500 })
      const whiteWin = rateGame({ white: a, black: b, result: WHITE_WIN })
      assert.equal(whiteWin.white.whiteWins, 1)
      assert.equal(whiteWin.white.blackWins, 0)
      assert.equal(whiteWin.black.blackLosses, 1)
      assert.equal(whiteWin.black.whiteLosses, 0)
      const blackWin = rateGame({ white: whiteWin.white, black: whiteWin.black, result: BLACK_WIN })
      assert.equal(blackWin.white.whiteWins, 1)
      assert.equal(blackWin.white.whiteLosses, 1)
      assert.equal(blackWin.white.blackLosses, 0)
      assert.equal(blackWin.black.blackWins, 1)
      assert.equal(blackWin.black.blackLosses, 1)
    })
  })

  describe('interactive leaderboard columns', () => {
    const sample = [
      {
        site: 'alice.localhost',
        name: 'Alice',
        rating: 1800,
        rd: 50,
        reliable: true,
        games: 10,
        wins: 6,
        losses: 3,
        draws: 1,
        peak: 1850,
        winRate: 65,
        whiteWins: 4,
        whiteLosses: 1,
        blackWins: 2,
        blackLosses: 2,
      },
      {
        site: 'bob.localhost',
        name: 'Bob',
        rating: 1600,
        rd: 80,
        reliable: true,
        games: 8,
        wins: 5,
        losses: 2,
        draws: 1,
        peak: 1620,
        winRate: 69,
        whiteWins: 1,
        whiteLosses: 2,
        blackWins: 4,
        blackLosses: 0,
      },
      {
        site: 'cara.localhost',
        name: 'Cara',
        rating: 1400,
        rd: 120,
        reliable: false,
        games: 3,
        wins: 1,
        losses: 2,
        draws: 0,
        peak: 1410,
        winRate: 33,
        whiteWins: 0,
        whiteLosses: 1,
        blackWins: 1,
        blackLosses: 1,
      },
    ]

    it('exposes colour and career columns', () => {
      const ids = LEADERBOARD_COLUMNS.map(c => c.id)
      assert.ok(ids.includes('whiteWins'))
      assert.ok(ids.includes('blackLosses'))
      assert.ok(ids.includes('wins'))
    })

    it('defines short labels for narrow table headers', () => {
      const byId = Object.fromEntries(LEADERBOARD_COLUMNS.map(c => [c.id, c]))
      assert.equal(byId.player.label, 'Name')
      assert.equal(byId.rating.label, 'Rating')
      assert.equal(byId.rating.shortLabel, 'Rat')
      assert.equal(byId.games.shortLabel, 'G')
      assert.equal(byId.wins.shortLabel, 'W')
      assert.equal(byId.losses.shortLabel, 'L')
      assert.equal(byId.draws.shortLabel, 'D')
      assert.equal(byId.peak.shortLabel, 'Pk')
      assert.equal(byId.winrate.shortLabel, 'W%')
      assert.equal(byId.whiteWins.shortLabel, 'WW')
      assert.equal(byId.whiteLosses.shortLabel, 'WL')
      assert.equal(byId.blackWins.shortLabel, 'BW')
      assert.equal(byId.blackLosses.shortLabel, 'BL')
      assert.equal(byId.whiteWins.title, 'Wins as White')
    })

    it('shows a display name when the stored name is just the site host', () => {
      assert.equal(leaderboardPlayerDisplayName({ name: 'olga.localhost', site: 'olga.localhost' }), 'Olga')
      assert.equal(leaderboardPlayerDisplayName({ name: 'Alice', site: 'alice.localhost' }), 'Alice')
      const byDisplay = filterLeaderboardEntries([{ name: 'olga.localhost', site: 'olga.localhost', rating: 1500 }], {
        player: 'olg',
      })
      assert.equal(byDisplay.length, 1)
    })

    it('sorts by an arbitrary column and filters by text', () => {
      const byBlackWins = rankLeaderboard(sample, { column: 'blackWins', dir: 'desc' })
      assert.equal(byBlackWins[0].site, 'bob.localhost')
      assert.equal(byBlackWins[0].rank, 1)
      const filtered = filterLeaderboardEntries(sample, { player: 'car' })
      assert.equal(filtered.length, 1)
      assert.equal(filtered[0].site, 'cara.localhost')
      const rankedFiltered = rankLeaderboard(sample, {
        column: 'rating',
        filters: { player: 'alice' },
        reliableOnly: true,
      })
      assert.equal(rankedFiltered.length, 1)
      assert.equal(rankedFiltered[0].site, 'alice.localhost')
    })

    it('renumbers # by how good the active stat is, even when the table is reversed', () => {
      assert.equal(columnPreferredSortDir('wins'), 'desc')
      assert.equal(columnPreferredSortDir('losses'), 'asc')
      const ascRating = rankLeaderboard(sample, { column: 'rating', dir: 'asc' })
      // Lowest rating on top, but Alice still owns #1 for rating.
      assert.equal(ascRating[0].site, 'cara.localhost')
      assert.equal(ascRating[0].rank, 3)
      assert.equal(ascRating[ascRating.length - 1].site, 'alice.localhost')
      assert.equal(ascRating[ascRating.length - 1].rank, 1)
      const byWins = rankLeaderboard(sample, { column: 'wins', dir: 'desc' })
      assert.equal(byWins[0].rank, 1)
      assert.equal(byWins[1].rank, 2)
      assert.equal(byWins[2].rank, 3)
      const lossesAsc = rankLeaderboard(sample, { column: 'losses', dir: 'asc' })
      // Fewest losses = #1 (Bob and Cara tie at 2; Alice has 3).
      assert.equal(lossesAsc[0].rank, 1)
      const lossesDesc = rankLeaderboard(sample, { column: 'losses', dir: 'desc' })
      assert.equal(lossesDesc[0].site, 'alice.localhost')
      assert.equal(lossesDesc[0].rank, 3)
    })

    it('counts colour results when building from a game pool', () => {
      const whitePgn = [
        '[Event "Rated"]',
        '[Site "alice.localhost"]',
        '[Date "2024.01.01"]',
        '[White "alice.localhost (Alice)"]',
        '[Black "bob.localhost (Bob)"]',
        '[Result "1-0"]',
        '[Rated "Yes"]',
        '[WhiteGlickoRating "1500"]',
        '[WhiteGlickoRD "350"]',
        '[WhiteGlickoVolatility "0.0600"]',
        '[BlackGlickoRating "1500"]',
        '[BlackGlickoRD "350"]',
        '[BlackGlickoVolatility "0.0600"]',
        '',
        '1. e4 e5 1-0',
      ].join('\n')
      const blackPgn = [
        '[Event "Rated"]',
        '[Site "alice.localhost"]',
        '[Date "2024.01.02"]',
        '[White "bob.localhost (Bob)"]',
        '[Black "alice.localhost (Alice)"]',
        '[Result "0-1"]',
        '[Rated "Yes"]',
        '[WhiteGlickoRating "1500"]',
        '[WhiteGlickoRD "350"]',
        '[WhiteGlickoVolatility "0.0600"]',
        '[BlackGlickoRating "1500"]',
        '[BlackGlickoRD "350"]',
        '[BlackGlickoVolatility "0.0600"]',
        '',
        '1. e4 e5 0-1',
      ].join('\n')
      const { entries } = buildLeaderboard({
        games: [whitePgn, blackPgn],
        hosts: ['alice.localhost', 'bob.localhost'],
      })
      const alice = entries.find(e => e.site === 'alice.localhost')
      assert.ok(alice)
      assert.equal(alice.whiteWins, 1)
      assert.equal(alice.blackWins, 1)
      assert.equal(alice.wins, 2)
    })
  })

  describe('challenge rating gate', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'alice.localhost (Alice)',
      creatorSite: 'alice.localhost',
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

  describe('challenge join auth gate', () => {
    it('blocks guests from rated seeks and hides them from anonymous browsers', () => {
      const rated = buildOpenChallenge({
        rated: true,
        creatorId: 'alice.localhost (Alice)',
        creatorSite: 'alice.localhost',
      })
      assert.equal(
        challengeJoinGate(rated, { viewerRating: 1500, isAuthenticatedOwner: false }).reason,
        CHALLENGE_REJECT_OWNERS_ONLY,
      )
      assert.equal(challengeVisibleToViewer(rated, { isAuthenticatedOwner: false }), false)
      assert.equal(challengeVisibleToViewer(rated, { isAuthenticatedOwner: true }), true)
      assert.deepEqual(challengeJoinGate(rated, { viewerRating: 1500, isAuthenticatedOwner: true }), {
        ok: true,
        reason: null,
      })
    })

    it('hides all open seeks from guests and requires owner auth to join', () => {
      const casual = buildOpenChallenge({
        rated: false,
        creatorId: 'alice.localhost (Alice)',
        creatorSite: 'alice.localhost',
      })
      assert.equal(challengeVisibleToViewer(casual, { isAuthenticatedOwner: false }), false)
      assert.equal(challengeVisibleToViewer(casual, { isAuthenticatedOwner: true }), true)
      assert.equal(
        challengeJoinGate(casual, { isAuthenticatedOwner: false }).reason,
        CHALLENGE_REJECT_OWNERS_ONLY,
      )
      assert.deepEqual(challengeJoinGate(casual, { isAuthenticatedOwner: true }), {
        ok: true,
        reason: null,
      })
    })

    it('blocks guests from directed wiki invites and wrong-site owners', () => {
      const directed = buildOpenChallenge({
        rated: false,
        creatorId: 'rob.chess.aolc.cc (Rob)',
        creatorSite: 'rob.chess.aolc.cc',
        challengeTarget: 'ward.chess.aolc.cc',
      })
      assert.equal(challengeVisibleToViewer(directed, { isAuthenticatedOwner: false }), false)
      assert.equal(
        challengeJoinGate(directed, {
          isAuthenticatedOwner: false,
          viewingSite: 'ward.chess.aolc.cc',
        }).reason,
        CHALLENGE_REJECT_OWNERS_ONLY,
      )
      assert.deepEqual(
        challengeJoinGate(directed, {
          isAuthenticatedOwner: true,
          viewingSite: 'ward.chess.aolc.cc',
        }),
        { ok: true, reason: null },
      )
      assert.equal(
        challengeJoinGate(directed, {
          isAuthenticatedOwner: true,
          viewingSite: 'eve.chess.aolc.cc',
        }).reason,
        CHALLENGE_REJECT_WRONG_SITE,
      )
    })

    it('stamps rated/creator tags without an AllowGuests header', () => {
      const casual = buildOpenChallenge({
        rated: false,
        creatorId: 'alice.localhost (Alice)',
        creatorSite: 'alice.localhost',
      })
      const rated = buildOpenChallenge({
        rated: true,
        creatorId: 'alice.localhost (Alice)',
        creatorSite: 'alice.localhost',
      })
      const casualPgn = stampOpenChallengePgn('[White "alice.localhost (Alice)"]\n[Black ""]\n*', casual)
      const ratedPgn = stampOpenChallengePgn('[White "alice.localhost (Alice)"]\n[Black ""]\n*', rated)
      assert.doesNotMatch(casualPgn, /AllowGuests/)
      assert.doesNotMatch(ratedPgn, /AllowGuests/)
      assert.match(casualPgn, /\[Rated "no"\]/)
      assert.match(ratedPgn, /\[Rated "yes"\]/)
    })

    it('never wraps an unauthenticated joiner with the public site owner name', () => {
      assert.equal(
        resolveJoinerSeatId('', 'chess.aolc.cc', 'Wiki Cafe Owner', {
          isAuthenticatedOwner: false,
          guestName: 'Guest',
        }),
        'Guest',
      )
      assert.equal(
        resolveJoinerSeatId('Guest', 'chess.aolc.cc', 'Wiki Cafe Owner', { isAuthenticatedOwner: false }),
        'Guest',
      )
      assert.equal(
        resolveJoinerSeatId('', 'local.test', 'Bob', { isAuthenticatedOwner: true }),
        'local.test (Bob)',
      )
    })
  })

  describe('challenge banner predicates', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'alice.localhost (Alice)',
      creatorSite: 'alice.localhost',
      creatorRating: 1500,
    })
    const pgn = '[White "Alice"]\n[Black "Open"]\n*'

    it('dismisses join ghost for PWA bridge sessions', () => {
      assert.equal(
        shouldDismissChallengeJoinGhostForPwa({
          challengeJoinGhost: true,
          pwaBridgeActive: true,
          pgn,
          challenge,
        }),
        true,
      )
      assert.equal(
        shouldDismissChallengeJoinGhostForPwa({
          challengeJoinGhost: true,
          pwaBridgeActive: false,
          pgn,
          challenge,
        }),
        false,
      )
    })

    it('shows fork banner for wiki embed join ghost', () => {
      assert.equal(
        shouldShowChallengeJoinGhostForkBanner({
          challengeJoinGhost: true,
          wikiFrame: {},
          pgn,
          challenge,
        }),
        true,
      )
    })

    it('shows open seek banner only for open challenges with empty seats', () => {
      assert.equal(
        shouldShowOpenChallengeBanner({
          wikiFrame: {},
          pgn,
          challenge,
          seatsFilled: false,
        }),
        true,
      )
      assert.equal(
        shouldShowOpenChallengeBanner({
          wikiFrame: {},
          pgn,
          challenge,
          seatsFilled: true,
        }),
        false,
      )
      assert.equal(isOpenChallenge(challenge), true)
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

  describe('proposeOpenChallengePageTitle', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'frank.localhost (Frank)',
      creatorSite: 'frank.localhost',
      creatorColor: CHALLENGE_COLOR_WHITE,
    })

    it('builds a player vs player title when the remote page is My Chess Games', () => {
      assert.equal(proposeOpenChallengePageTitle(challenge, 'Elif', 'My Chess Games'), 'Frank vs Elif')
    })

    it('puts the joiner first when the creator plays Black', () => {
      const black = buildOpenChallenge({
        creatorId: 'frank.localhost (Frank)',
        creatorSite: 'frank.localhost',
        creatorColor: CHALLENGE_COLOR_BLACK,
      })
      assert.equal(proposeOpenChallengePageTitle(black, 'Elif', 'My Chess Games'), 'Elif vs Frank')
    })

    it('keeps a proper remote game page title', () => {
      assert.equal(
        proposeOpenChallengePageTitle(challenge, 'Elif', 'Frank vs Guest · 2026.07.03'),
        'Frank vs Guest · 2026.07.03',
      )
    })

    it('substitutes the joiner for [open-seat] in an auto-built open-seek title', () => {
      assert.equal(proposeOpenChallengePageTitle(challenge, 'Olga', 'Frank vs [open-seat]'), 'Frank vs Olga')
      assert.equal(
        proposeOpenChallengePageTitle(challenge, 'Olga', 'Frank plays Random vs [open-seat] - Casual'),
        'Frank vs Olga',
      )
    })

    it('replaces a ghost seek title with the joiner name', () => {
      const elifChallenge = buildOpenChallenge({
        creatorId: 'elif.localhost (Elif)',
        creatorSite: 'elif.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      assert.equal(proposeOpenChallengePageTitle(elifChallenge, 'Frank', 'Elif vs Open'), 'Elif vs Frank')
    })

    it('orders White vs Black for random seeks from the same seat hash as the board', () => {
      const challenge = buildOpenChallenge({
        creatorId: 'olga.localhost:3001 (Olga)',
        creatorSite: 'olga.localhost:3001',
        creatorColor: CHALLENGE_COLOR_RANDOM,
      })
      const joinerId = 'bjorn.localhost:3001 (Bjorn)'
      const joinerColor = resolveChallengeJoinerColor(challenge, challenge.creator.id, joinerId)
      const title = proposeOpenChallengePageTitle(challenge, 'Bjorn', 'Olga vs [open-seat]', {
        joinerId,
      })
      assert.equal(title, joinerColor === 'w' ? 'Bjorn vs Olga' : 'Olga vs Bjorn')
      // This pairing hashes the joiner to White — title must not keep creator-first.
      assert.equal(joinerColor, 'w')
      assert.equal(title, 'Bjorn vs Olga')
    })
  })

  describe('isGhostProposedTitle', () => {
    it('detects provisional open-seek titles', () => {
      assert.equal(isGhostProposedTitle('Elif vs Open'), true)
      assert.equal(isGhostProposedTitle('Open vs Elif'), true)
      assert.equal(isGhostProposedTitle('Frank vs You'), true)
      assert.equal(isGhostProposedTitle('Frank vs Guest · 2026.07.03'), false)
    })

    it('builds a join ghost title when the ghost title has Open first', () => {
      const elifChallenge = buildOpenChallenge({
        creatorId: 'elif.localhost (Elif)',
        creatorSite: 'elif.localhost',
        creatorColor: CHALLENGE_COLOR_BLACK,
      })
      assert.equal(proposeOpenChallengePageTitle(elifChallenge, 'Frank', 'Open vs Elif'), 'Frank vs Elif')
    })
  })

  describe('proposeNewGamePageTitle', () => {
    it('builds engine game titles as White vs Black', () => {
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'engine',
          localSeat: 'w',
          stockfishLevel: 3,
          rated: true,
          localPlayerName: 'Frank',
        }),
        'Frank vs Stockfish Level 3',
      )
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'engine',
          localSeat: 'b',
          stockfishLevel: 3,
          rated: false,
          localPlayerName: 'Frank',
        }),
        'Stockfish Level 3 vs Frank',
      )
    })

    it('builds open-challenge titles with the joiner colour (or Random)', () => {
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'human',
          isOpenChallenge: true,
          creatorColor: CHALLENGE_COLOR_RANDOM,
          rated: true,
          localPlayerName: 'Frank',
        }),
        'Play Random vs Frank',
      )
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'human',
          isOpenChallenge: true,
          creatorColor: CHALLENGE_COLOR_BLACK,
          rated: false,
          localPlayerName: 'Frank',
        }),
        'Play White vs Frank',
      )
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'human',
          isOpenChallenge: true,
          creatorColor: CHALLENGE_COLOR_WHITE,
          rated: true,
          localPlayerName: 'Frank',
        }),
        'Play Black vs Frank',
      )
    })

    it('uses the resolved opponent display name for directed wiki challenges', () => {
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'human',
          localSeat: 'w',
          rated: false,
          opponentWikiSite: 'ff.localhost:3001',
          opponentDisplayName: 'Bishop',
          localPlayerName: 'Frank',
        }),
        'Frank vs Bishop',
      )
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'human',
          localSeat: 'b',
          rated: true,
          opponentWikiSite: 'ff.localhost:3001',
          localPlayerName: 'Frank',
        }),
        'Ff vs Frank',
      )
      assert.equal(
        proposeNewGamePageTitle({
          opponent: 'human',
          localSeat: 'w',
          creatorColor: CHALLENGE_COLOR_RANDOM,
          rated: true,
          opponentWikiSite: 'tessa.localhost:3001',
          localPlayerName: 'Frank',
        }),
        'Frank vs Tessa',
      )
    })
  })

  describe('probeWikiSite', () => {
    it('accepts blank input without probing', async () => {
      const result = await probeWikiSite('   ')
      assert.equal(result.valid, true)
      assert.equal(result.displayName, '')
    })

    it('rejects malformed wiki addresses before any fetch', async () => {
      const result = await probeWikiSite('https://[bad')
      assert.equal(result.valid, false)
      assert.equal(result.error, 'invalid-format')
      assert.match(wikiSiteValidationErrorMessage(result.error), /wiki domain/i)
    })

    it('accepts a wiki when owner.json resolves', async () => {
      const result = await probeWikiSite('alice.example.co', {
        fetchFn: async url => {
          if (String(url).includes('status/owner.json')) {
            return { ok: true, text: async () => '"Alice"' }
          }
          return { ok: false }
        },
      })
      assert.equal(result.valid, true)
      assert.equal(result.displayName, 'Alice')
    })

    it('rejects hosts with no wiki endpoints', async () => {
      const result = await probeWikiSite('missing.example.co', {
        fetchFn: async () => ({ ok: false }),
      })
      assert.equal(result.valid, false)
      assert.equal(result.error, 'unreachable')
    })

    it('probes via getPage (wiki.site / proxy path) when provided', async () => {
      const result = await probeWikiSite('bob.example.co', {
        getPage: async (host, path) => {
          assert.equal(host, 'bob.example.co')
          if (path === 'status/owner.json') return { name: 'Bob' }
          return null
        },
      })
      assert.equal(result.valid, true)
      assert.equal(result.displayName, 'Bob')
    })

    it('retries http when allowHttpFallback is set and https fails', async () => {
      const urls = []
      const result = await probeWikiSite('http-only.example.co', {
        allowHttpFallback: true,
        fetchFn: async url => {
          urls.push(String(url))
          if (String(url).startsWith('http://') && String(url).includes('status/owner.json')) {
            return { ok: true, text: async () => '"Plain"' }
          }
          return { ok: false }
        },
      })
      assert.equal(result.valid, true)
      assert.equal(result.displayName, 'Plain')
      assert.ok(urls.some(u => u.startsWith('https://')))
      assert.ok(urls.some(u => u.startsWith('http://')))
    })

    it('does not retry http without allowHttpFallback', async () => {
      const urls = []
      const result = await probeWikiSite('http-only.example.co', {
        fetchFn: async url => {
          urls.push(String(url))
          return { ok: false }
        },
      })
      assert.equal(result.valid, false)
      assert.ok(urls.every(u => u.startsWith('https://')))
      assert.ok(!urls.some(u => u.startsWith('http://')))
    })
  })

  describe('protocolForSite / pageUrl / fetchWikiResourceWithProtocolFallback', () => {
    it('aligns protocolForSite with isLoopbackWikiHost', () => {
      assert.equal(protocolForSite('fox.localhost:3001'), 'http')
      assert.equal(protocolForSite('127.0.0.1:3000'), 'http')
      assert.equal(protocolForSite('wiki.local'), 'http')
      assert.equal(protocolForSite('192.168.68.62:3001'), 'http')
      assert.equal(isLoopbackWikiHost('fox.localhost:3001'), true)
      assert.equal(isLoopbackWikiHost('192.168.68.62:3001'), true)
      assert.equal(protocolForSite('chess.example.co'), 'https')
      assert.equal(pageUrl('chess.example.co', 'welcome-visitors'), 'https://chess.example.co/welcome-visitors.json')
      assert.equal(
        pageUrl('chess.example.co', 'welcome-visitors', 'http'),
        'http://chess.example.co/welcome-visitors.json',
      )
    })

    it('falls back from https to http only when allowHttpFallback is true', async () => {
      const urls = []
      const res = await fetchWikiResourceWithProtocolFallback('remote.example.co', 'welcome-visitors', {
        allowHttpFallback: true,
        fetchFn: async url => {
          urls.push(String(url))
          if (String(url).startsWith('http://')) {
            return {
              ok: true,
              json: async () => ({ title: 'Welcome' }),
            }
          }
          return { ok: false }
        },
      })
      assert.ok(res)
      assert.deepEqual(urls, [
        'https://remote.example.co/welcome-visitors.json',
        'http://remote.example.co/welcome-visitors.json',
      ])
    })

    it('does not attempt https for loopback hosts', async () => {
      const urls = []
      await fetchWikiResourceWithProtocolFallback('dev.localhost:3001', 'welcome-visitors', {
        allowHttpFallback: true,
        fetchFn: async url => {
          urls.push(String(url))
          return { ok: false }
        },
      })
      assert.deepEqual(urls, ['http://dev.localhost:3001/welcome-visitors.json'])
    })
  })

  describe('openChallengeDisplayTitle', () => {
    it('rebuilds a joiner-facing title from metadata when the stored title is generic', () => {
      const challenge = buildOpenChallenge({
        rated: true,
        creatorColor: CHALLENGE_COLOR_RANDOM,
        creatorId: 'frank.localhost:3001 (Frank)',
        creatorSite: 'frank.localhost:3001',
      })
      assert.equal(openChallengeDisplayTitle({ challenge, title: 'Chess Game (2)' }), 'Play Random vs Frank')
    })

    it('rebuilds older [open-seat] auto-titles from seek colour metadata', () => {
      const challenge = buildOpenChallenge({
        rated: false,
        creatorColor: CHALLENGE_COLOR_WHITE,
        creatorId: 'bjorn.localhost:3001 (Bjorn)',
        creatorSite: 'bjorn.localhost:3001',
      })
      assert.equal(openChallengeDisplayTitle({ challenge, title: 'Bjorn vs [open-seat]' }), 'Play Black vs Bjorn')
    })

    it('keeps a stored custom title', () => {
      const title = 'Frank vs Bishop'
      const challenge = buildOpenChallenge({
        rated: false,
        creatorColor: CHALLENGE_COLOR_WHITE,
        creatorId: 'frank.localhost:3001 (Frank)',
        creatorSite: 'frank.localhost:3001',
      })
      assert.equal(openChallengeDisplayTitle({ challenge, title }), title)
    })
  })

  describe('formatGameRowMetaLine', () => {
    it('summarizes rated status, event, and challenge creator from PGN tags', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Event "Spring Open"]
[Rated "yes"]
[ChallengeCreator "frank.localhost (Frank)"]
[CreatorColor "Random"]`,
        rated: true,
      })
      assert.match(line, /Rated/)
      assert.match(line, /Spring Open/)
      assert.match(line, /Posted by Frank/)
      assert.match(line, /Random colours/)
    })

    it('includes the poster rating on rated open challenges', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Rated "yes"]
[ChallengeCreator "bjorn.localhost:3001 (Bjorn)"]
[CreatorRating "1240"]
[CreatorColor "Random"]`,
        rated: true,
      })
      assert.match(line, /Posted by Bjorn \(1240\)/)
    })

    it('omits poster rating on casual open challenges even when stamped', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Rated "no"]
[ChallengeCreator "bjorn.localhost:3001 (Bjorn)"]
[CreatorRating "1240"]
[CreatorColor "Random"]`,
        rated: false,
      })
      assert.match(line, /Posted by Bjorn/)
      assert.doesNotMatch(line, /Posted by Bjorn \(\d+\)/)
    })

    it('can omit rated status when the parent section already conveys it', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Event "Spring Open"]
[Rated "yes"]`,
        rated: true,
        includeRated: false,
      })
      assert.doesNotMatch(line, /Rated|Casual/)
      assert.match(line, /Spring Open/)
    })

    it('can omit colour when the row title already conveys it', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Rated "yes"]
[ChallengeCreator "bjorn.localhost:3001 (Bjorn)"]
[CreatorColor "Random"]`,
        rated: true,
        includeRated: false,
        includeColor: false,
      })
      assert.doesNotMatch(line, /Rated|Casual|Random colours|Creator plays/)
      assert.match(line, /Posted by Bjorn/)
    })

    it('includes round and other optional PGN tags when present', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Event "FedWiki Open Championship"]
[Round "4"]
[Board "2"]
[ECO "C50"]
[Opening "Italian Game"]
[TimeControl "15+10"]
[Rated "yes"]`,
        includeRated: false,
      })
      assert.match(line, /FedWiki Open Championship/)
      assert.match(line, /Round 4/)
      assert.match(line, /Board 2/)
      assert.match(line, /C50/)
      assert.match(line, /Italian Game/)
      assert.match(line, /15\+10/)
    })

    it('skips placeholder round values', () => {
      const line = formatGameRowMetaLine({
        pgn: `[Event "Friendly"]
[Round "-"]`,
        includeRated: false,
      })
      assert.equal(line, 'Friendly')
    })
  })

  describe('isReplaceableGhostPageTitle', () => {
    it('treats generic ghost titles and open placeholders as replaceable', () => {
      assert.equal(isReplaceableGhostPageTitle('New Chess Game'), true)
      assert.equal(isReplaceableGhostPageTitle('New Chess page'), true)
      assert.equal(isReplaceableGhostPageTitle('New Chess Position'), true)
      assert.equal(isReplaceableGhostPageTitle('New Chess Puzzle'), true)
      assert.equal(isReplaceableGhostPageTitle('Chess Game (2)'), true)
      assert.equal(isReplaceableGhostPageTitle('Frank vs Open'), true)
      assert.equal(isReplaceableGhostPageTitle('Frank vs [open-seat]'), true)
      assert.equal(isReplaceableGhostPageTitle('Play Black vs Frank'), true)
      assert.equal(isReplaceableGhostPageTitle('Play Random vs Frank'), true)
      assert.equal(isReplaceableGhostPageTitle('Frank vs Stockfish Level 1'), true)
      assert.equal(isReplaceableGhostPageTitle('Stockfish Level 3 vs Frank'), true)
      assert.equal(isReplaceableGhostPageTitle('Player 1 vs Player 2'), true)
      assert.equal(isReplaceableGhostPageTitle('Spring Open R3: Alice vs Bob'), false)
    })
  })

  describe('resolveStartModalPageTitle', () => {
    it('refreshes stale open-seek titles when switching to an engine proposal', () => {
      assert.equal(
        resolveStartModalPageTitle({
          proposed: 'Wiki vs Stockfish Level 1',
          fieldTitle: 'Play Random vs Wiki',
        }),
        'Wiki vs Stockfish Level 1',
      )
    })

    it('refreshes replaceable auto-titles even if the field was marked dirty', () => {
      assert.equal(
        resolveStartModalPageTitle({
          proposed: 'Wiki vs Stockfish Level 1',
          fieldTitle: 'Play Random vs Wiki',
          dirty: true,
        }),
        'Wiki vs Stockfish Level 1',
      )
    })

    it('keeps a custom non-replaceable title', () => {
      assert.equal(
        resolveStartModalPageTitle({
          proposed: 'Wiki vs Stockfish Level 1',
          fieldTitle: 'Spring Open R3: Alice vs Bob',
        }),
        'Spring Open R3: Alice vs Bob',
      )
    })

    it('uses the proposal when the field is empty', () => {
      assert.equal(
        resolveStartModalPageTitle({
          proposed: 'Wiki vs Stockfish Level 1',
          fieldTitle: '',
        }),
        'Wiki vs Stockfish Level 1',
      )
    })
  })

  describe('proposeUniquePageTitle', () => {
    it('returns the base title when the slug is free', () => {
      assert.equal(proposeUniquePageTitle('Elif vs Frank', []), 'Elif vs Frank')
    })

    it('adds a numeric suffix when the slug already exists', () => {
      const taken = pageSlug('Elif vs Frank')
      assert.equal(proposeUniquePageTitle('Elif vs Frank', [taken]), 'Elif vs Frank (2)')
      assert.equal(proposeUniquePageTitle('Elif vs Frank', [taken, pageSlug('Elif vs Frank (2)')]), 'Elif vs Frank (3)')
    })

    it('merges lineup and sitemap slugs when picking a title', () => {
      const taken = pageSlug('New Chess Game')
      assert.equal(
        proposeUniquePageTitle('New Chess Game', [taken, pageSlug('New Chess Game (2)')]),
        'New Chess Game (3)',
      )
    })
  })

  describe('collectLineupPageSlugs', () => {
    it('ignores unforked ghost pages so repeated ghosts keep the base title', () => {
      const domPages = [
        {
          ghost: true,
          id: 'new-chess-game_rev1',
          title: 'New Chess Game',
          site: 'localhost:3001',
        },
        {
          ghost: false,
          id: 'my-chess-games_rev1',
          title: 'My Chess Games',
          site: 'localhost:3001',
        },
      ]
      let currentPage = null
      const prev$ = globalThis.$
      const prevLocation = globalThis.location
      globalThis.location = { host: 'localhost:3001' }
      globalThis.$ = sel => {
        if (sel === '.page') {
          return {
            each(fn) {
              domPages.forEach((page, i) => {
                currentPage = page
                fn(i, {})
              })
            },
          }
        }
        const page = currentPage
        return {
          hasClass(cls) {
            return cls === 'ghost' && !!page?.ghost
          },
          data(key) {
            if (key === 'site') return page?.site
            if (key === 'data') return page ? { title: page.title } : undefined
            return undefined
          },
          attr(name) {
            return name === 'id' ? page?.id : undefined
          },
        }
      }
      try {
        const slugs = collectLineupPageSlugs('localhost:3001')
        assert.ok(!slugs.includes(pageSlug('New Chess Game')))
        assert.ok(slugs.includes('my-chess-games'))
        assert.ok(slugs.includes(pageSlug('My Chess Games')))
        assert.equal(proposeUniquePageTitle('New Chess Game', slugs), 'New Chess Game')
      } finally {
        globalThis.$ = prev$
        globalThis.location = prevLocation
      }
    })
  })

  describe('ghost open challenge harvest', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'frank.localhost (Frank)',
      creatorSite: 'frank.localhost',
      creatorColor: CHALLENGE_COLOR_WHITE,
    })
    const pgn = `[Event "Frank vs Open"]
[White "frank.localhost (Frank)"]
[Black ""]

*`

    it('harvests a pending ghost chess item', () => {
      const entry = harvestGhostOpenChallenge({
        site: 'frank.localhost',
        title: 'Frank vs Open',
        itemId: 'abc123',
        pgn,
        challenge,
      })
      assert.equal(entry?.pending, true)
      assert.equal(entry?.slug, '')
      assert.equal(entry?.site, 'frank.localhost')
      assert.equal(entry?.host, undefined)
      assert.equal(entry?.challenge?.creator?.site, 'frank.localhost')
      assert.equal(entry?.pgn, pgn)
      assert.equal(entry?.itemId, 'abc123')
    })

    it('harvests a page-backed survey seek when a game slug is present', () => {
      const entry = harvestGhostOpenChallenge({
        site: 'frank.localhost',
        slug: 'club-night',
        title: 'Club Night',
        itemId: 'item42',
        pgn,
        challenge,
      })
      assert.equal(entry?.pending, false)
      assert.equal(entry?.slug, 'club-night')
      assert.equal(entry?.itemId, 'item42')
    })

    it('rejects ghost entries missing embedded PGN', () => {
      assert.equal(
        harvestGhostOpenChallenge({
          site: 'frank.localhost',
          itemId: 'abc123',
          challenge,
        }),
        null,
      )
    })

    it('harvests a page-based open seek on a real game page', () => {
      const entry = harvestPageOpenChallenge({
        site: 'frank.localhost',
        slug: 'club-game',
        title: 'Club game',
        itemId: 'item1',
        pgn,
      })
      assert.equal(entry?.pending, false)
      assert.equal(entry?.slug, 'club-game')
      assert.equal(entry?.pgn, pgn)
      assert.equal(entry?.challenge?.creator?.id, 'frank.localhost (Frank)')
    })

    it('finds page open seeks when crawling a game page', () => {
      const seeks = chessChallengesFromPage(
        {
          title: 'Club game',
          story: [
            {
              type: 'chess',
              id: 'item1',
              text: pgn,
            },
          ],
        },
        'frank.localhost',
        'club-game',
      )
      assert.equal(seeks.length, 1)
      assert.equal(seeks[0]?.slug, 'club-game')
    })
  })

  describe('survey open challenge metadata', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'frank.localhost (Frank)',
      creatorSite: 'frank.localhost',
      creatorColor: CHALLENGE_COLOR_WHITE,
    })
    const pgn = `[Event "Frank vs Open"]
[White "frank.localhost (Frank)"]
[Black ""]

*`
    const surveyItem = { type: 'chess', id: 'survey1', text: 'SURVEY' }

    it('includes page.chess openChallenges in chessChallengesFromPage', () => {
      const entries = chessChallengesFromPage(
        {
          title: 'My Chess Games',
          story: [{ ...surveyItem }],
          chess: {
            openChallenges: [{ itemId: 'abc123', pgn, title: 'Frank vs Open', challenge }],
          },
        },
        'frank.localhost',
        'my-chess-games',
      )
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.pending, true)
      assert.equal(entries[0]?.itemId, 'abc123')
    })

    it('harvests open challenges from the page charm', () => {
      const entries = harvestSurveyOpenChallenges(
        {
          story: [{ ...surveyItem }],
          chess: {
            openChallenges: [{ itemId: 'abc123', pgn, title: 'Frank vs Open', challenge }],
          },
        },
        'frank.localhost',
        'my-chess-games',
      )
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.itemId, 'abc123')
      assert.equal(entries[0]?.pending, true)
    })

    it('falls back to legacy SURVEY item metadata when page.chess has no openChallenges', () => {
      const entries = harvestSurveyOpenChallenges(
        {
          story: [
            {
              ...surveyItem,
              openChallenges: [{ itemId: 'abc123', pgn, title: 'Frank vs Open', challenge }],
            },
          ],
        },
        'frank.localhost',
        'my-chess-games',
      )
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.itemId, 'abc123')
    })

    it('syncOpenChallengeSurveyOnPage writes seeks to page.chess without journal edits', () => {
      const page = {
        title: 'My Chess Games',
        story: [{ ...surveyItem }],
        journal: [],
      }
      const result = syncOpenChallengeSurveyOnPage(page, {
        add: { itemId: 'abc123', pgn, title: 'Frank vs Open', challenge },
        site: 'frank.localhost',
      })
      assert.equal(result.changed, true)
      assert.equal(page.journal.length, 0)
      assert.equal(page.story[0].openChallenges, undefined)
      assert.equal(readSurveyOpenChallengeRecords(page).length, 1)
      assert.equal(page.chess?.openChallenges?.[0]?.itemId, 'abc123')
      assert.equal(page.chess?.gameIndex?.challenges?.[0]?.itemId, 'abc123')
    })

    it('stores a page-backed survey record with slug (pending false when harvested)', () => {
      const record = openChallengeSurveyRecord(challenge, {
        itemId: 'item42',
        pgn,
        title: 'Club Night',
        slug: 'club-night',
      })
      assert.equal(record?.slug, 'club-night')
      assert.equal(record?.itemId, 'item42')
      const list = applyOpenChallengeRecordsEdit([], { add: { ...record, challenge } })
      const entries = harvestSurveyOpenChallenges(
        { story: [{ ...surveyItem }], chess: { openChallenges: list } },
        'frank.localhost',
        'my-chess-games',
      )
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.pending, false)
      assert.equal(entries[0]?.slug, 'club-night')
      assert.equal(openChallengeUsesJoinGhost(entries[0]), false)
    })

    it('uses a join ghost only for pending survey-metadata seeks', () => {
      assert.equal(openChallengeUsesJoinGhost({ pending: true, pgn }), true)
      assert.equal(openChallengeUsesJoinGhost({ pending: false, slug: 'club-night', pgn }), false)
      assert.equal(openChallengeUsesJoinGhost({ accepted: true, acceptedGame: { slug: 'done' } }), false)
    })

    it('treats only create-preview flags as open-challenge ghost context', () => {
      assert.equal(isOpenChallengeCreatePreviewContext({}), false)
      assert.equal(isOpenChallengeCreatePreviewContext({ createPreviewPendingJournal: true }), true)
      assert.equal(isOpenChallengeCreatePreviewContext({ openChallengeSetupPending: true }), true)
      assert.equal(isOpenChallengeCreatePreviewContext({ wikiGhostPage: true }), true)
    })

    it('ignores open challenges forked onto another wiki', () => {
      const entries = harvestSurveyOpenChallenges(
        {
          story: [{ ...surveyItem }],
          chess: {
            openChallenges: [{ itemId: 'abc123', pgn, title: 'Frank vs Open', challenge }],
          },
        },
        'elif.localhost',
        'my-chess-games',
      )
      assert.equal(entries.length, 0)
    })

    it('lists foreign open-challenge ids for pruning stale fork copies', () => {
      const page = {
        story: [{ ...surveyItem }],
        chess: {
          openChallenges: [
            { itemId: 'abc123', pgn, title: 'Frank vs Open', challenge },
            {
              itemId: 'own456',
              pgn: `[Event "Elif vs Open"]
[White "elif.localhost (Elif)"]
[Black ""]

*`,
              title: 'Elif vs Open',
              challenge: buildOpenChallenge({
                creatorId: 'elif.localhost (Elif)',
                creatorSite: 'elif.localhost',
                creatorColor: CHALLENGE_COLOR_WHITE,
              }),
            },
          ],
        },
      }
      assert.deepEqual(foreignOpenChallengeItemIds(page, 'elif.localhost'), ['abc123'])
    })

    it('adds and removes open challenges on the page charm list', () => {
      const added = applyOpenChallengeRecordsEdit([], {
        add: { itemId: 'abc123', pgn, title: 'Frank vs Open', challenge },
      })
      assert.equal(added?.length, 1)
      const removed = applyOpenChallengeRecordsEdit(added, { removeIds: ['abc123'] })
      assert.deepEqual(removed, [])
      // Legacy item helper still works for old pages / tests.
      const legacy = applyOpenChallengeSurveyEdit(surveyItem, {
        add: { itemId: 'abc123', pgn, title: 'Frank vs Open', challenge },
      })
      assert.equal(legacy?.openChallenges?.length, 1)
    })

    it('harvests a directed wiki invite stored on the page charm', () => {
      const directed = buildOpenChallenge({
        rated: true,
        creatorId: 'frank.localhost (Frank)',
        creatorSite: 'frank.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
        challengeTarget: 'olga.localhost',
      })
      const entries = harvestSurveyOpenChallenges(
        {
          story: [{ ...surveyItem }],
          chess: {
            openChallenges: [{ itemId: 'dir123', pgn, title: 'Frank vs Olga', challenge: directed }],
          },
        },
        'frank.localhost',
        'my-chess-games',
      )
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.pending, true)
      assert.equal(entries[0]?.challenge?.challengeTarget, 'olga.localhost')
    })

    it('partitions directed survey invites into mine and directedAtMe', () => {
      const directed = buildOpenChallenge({
        rated: true,
        creatorId: 'frank.localhost (Frank)',
        creatorSite: 'frank.localhost',
        challengeTarget: 'olga.localhost',
      })
      const entry = harvestGhostOpenChallenge({
        site: 'frank.localhost',
        itemId: 'dir123',
        pgn,
        title: 'Frank vs Olga',
        challenge: directed,
      })
      const frankView = partitionOpenChallenges([entry], {
        viewingSite: 'frank.localhost',
      })
      assert.equal(frankView.mine.length, 1)
      assert.equal(frankView.directedAtMe.length, 0)
      const olgaGuest = partitionOpenChallenges([entry], {
        viewingSite: 'olga.localhost',
        isAuthenticatedOwner: false,
      })
      assert.equal(olgaGuest.mine.length, 0)
      assert.equal(olgaGuest.directedAtMe.length, 1)
      assert.equal(olgaGuest.directedAtMe[0].canJoin, false)
      const olgaOwner = partitionOpenChallenges([entry], {
        viewingSite: 'olga.localhost',
        isAuthenticatedOwner: true,
      })
      assert.equal(olgaOwner.directedAtMe[0].canJoin, true)
    })
  })

  describe('buildChallengeJoinGhostPgn', () => {
    const challenge = buildOpenChallenge({
      creatorId: 'elif.localhost (Elif)',
      creatorSite: 'elif.localhost',
      creatorColor: CHALLENGE_COLOR_WHITE,
    })
    const ghostPgn = `[Event "Elif vs Open"]
[White "elif.localhost (Elif)"]
[Black ""]

*`

    it('seats the joiner on the open side for a white-creator seek', () => {
      const joinerId = 'frank.localhost (Frank)'
      const seated = buildChallengeJoinGhostPgn(ghostPgn, challenge, joinerId)
      assert.match(seated, /\[White "elif\.localhost \(Elif\)"\]/)
      assert.match(seated, /\[Black "frank\.localhost \(Frank\)"\]/)
    })
  })

  describe('harvestAcceptedGhostGame', () => {
    it('finds a joiner fork with the ghost item id and active challenge', () => {
      const open = buildOpenChallenge({
        creatorId: 'elif.localhost (Elif)',
        creatorSite: 'elif.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      const accepted = {
        ...open,
        status: CHALLENGE_STATUS_ACTIVE,
        opponent: { id: 'frank.localhost (Frank)', site: 'frank.localhost', rating: null },
      }
      const row = harvestAcceptedGhostGame({
        site: 'frank.localhost',
        slug: 'elif-vs-frank',
        title: 'Elif vs Frank',
        itemId: 'ghost123',
        pgn: '[White "elif.localhost (Elif)"]\n[Black "frank.localhost (Frank)"]\n\n*',
        challenge: accepted,
      })
      assert.equal(row?.slug, 'elif-vs-frank')
      assert.equal(row?.itemId, 'ghost123')
      assert.equal(row?.accepted, true)
      assert.equal(row?.site, 'frank.localhost')
      assert.equal(row?.host, undefined)
    })
  })

  describe('partitionOpenChallenges accepted ghost', () => {
    it('keeps an accepted ghost seek as a fork-back row for the creator', () => {
      const open = buildOpenChallenge({
        creatorId: 'elif.localhost (Elif)',
        creatorSite: 'elif.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      const entries = [
        {
          site: 'elif.localhost',
          title: 'Elif vs Open',
          itemId: 'ghost123',
          pending: true,
          pgn: '[White "elif.localhost (Elif)"]\n[Black ""]\n\n*',
          challenge: open,
        },
      ]
      const accepted = harvestAcceptedGhostGame({
        site: 'frank.localhost',
        slug: 'elif-vs-frank',
        title: 'Elif vs Frank',
        itemId: 'ghost123',
        pgn: '[White "elif.localhost (Elif)"]\n[Black "frank.localhost (Frank)"]\n\n*',
        challenge: {
          ...open,
          status: CHALLENGE_STATUS_ACTIVE,
          opponent: { id: 'frank.localhost (Frank)', site: 'frank.localhost', rating: null },
        },
      })
      const frankView = partitionOpenChallenges(entries, {
        viewingSite: 'frank.localhost',
        acceptedGhosts: [accepted],
      })
      assert.equal(frankView.joinable.length, 0)
      assert.equal(frankView.acceptedMine.length, 0)
      const elifView = partitionOpenChallenges(entries, {
        viewingSite: 'elif.localhost',
        acceptedGhosts: [accepted],
      })
      assert.equal(elifView.mine.length, 0)
      assert.equal(elifView.joinable.length, 0)
      assert.equal(elifView.acceptedMine.length, 1)
      assert.equal(elifView.acceptedMine[0].accepted, true)
      assert.equal(elifView.acceptedMine[0].acceptedGame.slug, 'elif-vs-frank')
      assert.equal(elifView.acceptedMine[0].acceptedGame.site, 'frank.localhost')
      assert.equal(elifView.acceptedMine[0].opponentLabel, 'Frank (frank.localhost)')
    })

    it('ignores stale forked creator seek metadata on non-creator wikis', () => {
      const open = buildOpenChallenge({
        creatorId: 'frank.localhost (Frank)',
        creatorSite: 'frank.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      const entries = [
        {
          site: 'elif.localhost',
          title: 'Frank vs Open',
          itemId: 'ghost456',
          pending: true,
          pgn: '[White "frank.localhost (Frank)"]\n[Black ""]\n\n*',
          challenge: open,
        },
      ]
      const elifView = partitionOpenChallenges(entries, {
        viewingSite: 'elif.localhost',
        viewerSeatId: 'elif.localhost (Elif)',
      })
      assert.equal(elifView.mine.length, 0)
      assert.equal(elifView.joinable.length, 0)
      assert.equal(elifView.acceptedMine.length, 0)
    })
  })

  describe('My Chess Games active challenges', () => {
    it('lists in-progress games on the viewer wiki', () => {
      const pgn = `[Event "Club Championship"]
[White "frank.localhost (Frank)"]
[Black "elif.localhost (Elif)"]

*`
      const rows = buildMyGamesList(
        [{ slug: 'elif-vs-frank', title: 'Frank vs Elif', pgn, site: 'frank.localhost', itemId: 'abc' }],
        'frank.localhost',
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].active, true)
      assert.equal(rows[0].slug, 'elif-vs-frank')
      assert.equal(rows[0].site, 'frank.localhost')
      assert.equal(rows[0].opponentName, 'Elif')
      assert.equal(rows[0].whiteLabel, 'Frank (frank.localhost)')
      assert.equal(rows[0].blackLabel, 'Elif (elif.localhost)')
      assert.equal(rows[0].event, 'Club Championship')
    })

    it('extracts opponent display names for generic page titles', () => {
      const pgn = `[White "elif.localhost (Elif)"]
[Black "frank.localhost (Frank)"]

*`
      const rows = buildMyGamesList(
        [{ slug: 'new-chess-game', title: 'New Chess Game', pgn, site: 'elif.localhost', itemId: 'x' }],
        'elif.localhost',
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].opponentName, 'Frank')
      assert.equal(rows[0].title, 'New Chess Game')
    })

    it('lists a creator accepted game that lives on the joiner wiki', () => {
      const open = buildOpenChallenge({
        creatorId: 'elif.localhost (Elif)',
        creatorSite: 'elif.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      const accepted = harvestAcceptedGhostGame({
        site: 'frank.localhost',
        slug: 'elif-vs-frank',
        title: 'Elif vs Frank',
        itemId: 'ghost123',
        pgn: '[White "elif.localhost (Elif)"]\n[Black "frank.localhost (Frank)"]\n\n*',
        challenge: {
          ...open,
          status: CHALLENGE_STATUS_ACTIVE,
          opponent: { id: 'frank.localhost (Frank)', site: 'frank.localhost', rating: null },
        },
      })
      const rows = buildAcceptedGhostGamesList([accepted], 'elif.localhost')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].creatorForkBackPending, true)
      assert.equal(rows[0].site, 'frank.localhost')
      assert.equal(rows[0].slug, 'elif-vs-frank')
    })

    it('merges local and remote active games without duplicates', () => {
      const local = [{ slug: 'a', title: 'A', active: true, site: 'frank.localhost', itemId: '1', ts: 2 }]
      const remote = [{ slug: 'b', title: 'B', active: true, site: 'elif.localhost', itemId: '2', ts: 1 }]
      const merged = mergeMyGamesLists(local, remote)
      assert.equal(merged.length, 2)
      assert.equal(merged[0].slug, 'a')
      const bySite = mergeMyGamesLists(
        [{ slug: 'a', site: 'frank.localhost', itemId: '1', ts: 2 }],
        [{ slug: 'a', site: 'frank.localhost', itemId: '1', ts: 1 }],
        [{ slug: 'c', site: 'elif.localhost', itemId: '3', ts: 0 }],
      )
      assert.equal(bySite.length, 2)
      assert.equal(bySite[0].slug, 'a')
      assert.equal(bySite[1].slug, 'c')
    })

    it('lists sync-pending when the twin finished but the local copy is still open', () => {
      const localPgn = `[Event "Club"]
[White "frank.localhost (Frank)"]
[Black "elif.localhost (Elif)"]
[Result "*"]

1. e4 e5`
      const twinPgn = localPgn.replace('[Result "*"]', '[Result "1-0"]')
      assert.ok(syncPendingFromTwin(localPgn, twinPgn))
      const rows = buildMyGamesList(
        [
          {
            slug: 'club-game',
            title: 'Club game',
            pgn: localPgn,
            twinPgn,
            site: 'elif.localhost',
            itemId: 'abc',
          },
        ],
        'elif.localhost',
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].syncPending, true)
      assert.equal(rows[0].active, false)
      assert.equal(rows[0].result, '1-0')
      assert.equal(rows[0].score, 0)
    })

    it('reconstructs ghost PGN from a seated acceptance board', () => {
      const open = buildOpenChallenge({
        creatorId: 'elif.localhost (Elif)',
        creatorSite: 'elif.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      const ghost = '[White "elif.localhost (Elif)"]\n[Black ""]\n\n*'
      const seated = buildChallengeJoinGhostPgn(ghost, open, 'frank.localhost (Frank)')
      const accepted = acceptOpenChallenge(open, {
        joinerId: 'frank.localhost (Frank)',
        joinerSite: 'frank.localhost',
      })
      const recovered = reconstructGhostPgnFromSeated(seated, accepted)
      assert.match(recovered, /\[White "elif\.localhost \(Elif\)"\]/)
      assert.match(recovered, /\[Black ""\]/)
    })
  })

  describe('federation consensus', () => {
    const twinA = stampCompletionTags(`[Event "A"]
[Site "http://alice.localhost (id: abc)"]
[Date "2026.01.01"]
[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "1-0"]
[Rated "Yes"]
[WhiteElo "1500"]
[BlackElo "1500"]

1. e4 e5 2. Nf3 1-0`)
    const twinB = twinA

    it('deep recompute builds a state hash from verified twins', () => {
      const deep = runFederationConsensus({
        games: [twinA, twinB],
        trustedPeers: ['alice.localhost', 'bob.localhost'],
        deepRecompute: true,
      })
      assert.equal(deep.mode, 'audit')
      assert.ok(deep.stateHash)
      assert.ok(deep.lastTimelineKey)
    })

    it('checkpoint fast path replays only games after the timeline cursor', () => {
      const deep = runFederationConsensus({
        games: [twinA, twinB],
        trustedPeers: ['alice.localhost', 'bob.localhost'],
        deepRecompute: true,
      })
      const fast = runFederationConsensus({
        games: [twinA, twinB],
        trustedPeers: ['alice.localhost', 'bob.localhost'],
        localPlayers: deep.players,
        localCheckpoint: deep.checkpoint,
        peerCheckpoints: [
          { site: 'alice.localhost', checkpoint: deep.checkpoint },
          { site: 'bob.localhost', checkpoint: deep.checkpoint },
        ],
        deepRecompute: false,
      })
      assert.equal(fast.mode, 'lazy')
      assert.equal(fast.stateHash, deep.stateHash)
      const noop = applyIncrementalTimeline(clonePlayersMap(deep.players), [twinA, twinB], {
        afterTimelineKey: deep.lastTimelineKey,
      })
      assert.equal(noop.stateHash, deep.stateHash)
    })

    it('soft refresh trusts local IndexedDB analysis when the timeline cursor has not moved', () => {
      const deep = runFederationConsensus({
        games: [twinA, twinB],
        trustedPeers: ['alice.localhost', 'bob.localhost'],
        deepRecompute: true,
      })
      assert.equal(localCheckpointStillCurrent(deep.checkpoint, [twinA, twinB]), true)
      const soft = runFederationConsensus({
        games: [twinA, twinB],
        trustedPeers: [],
        localPlayers: deep.players,
        localCheckpoint: deep.checkpoint,
        peerCheckpoints: [],
        deepRecompute: false,
      })
      assert.equal(soft.mode, 'checkpoint')
      assert.equal(soft.queueAudit, true)
      assert.equal(soft.stateHash, deep.stateHash)
    })
  })

  describe('Glicko batching and blockList', () => {
    const mkEvent = (day, hour = 12) => {
      const ts = Date.UTC(2026, 0, day, hour, 0, 0)
      const pgn = stampCompletionTags(
        `[Event "x"]
[Site "http://alice.localhost (id: a)"]
[Date "2026.01.01"]
[White "alice.localhost (A)"]
[Black "bob.localhost (B)"]
[Result "1-0"]
[Rated "Yes"]

1. e4 1-0`,
        ts,
      )
      return { pgn, key: readGameTimelineKey(pgn).key }
    }

    it('shouldCloseGlickoBatch keeps same-day games in one batch until day changes', () => {
      const batch = Array.from({ length: GLICKO_BATCH_GAME_LIMIT }, (_, i) => mkEvent(1, i % 24))
      const sameDayNext = mkEvent(1, 23)
      assert.equal(shouldCloseGlickoBatch(batch, sameDayNext.pgn, null), false)
      const nextDay = mkEvent(2)
      assert.equal(shouldCloseGlickoBatch(batch, nextDay.pgn, null), true)
    })

    it('shouldCloseGlickoBatch closes after seven days', () => {
      const batch = [mkEvent(1)]
      const weekLater = mkEvent(8)
      const startTs = Date.parse(readGameTimelineKey(batch[0].pgn).ts)
      assert.equal(shouldCloseGlickoBatch(batch, weekLater.pgn, startTs), true)
    })

    it('filterOpenChallengesByBlockList drops rows from blocked sites', () => {
      const rows = [
        { site: 'alice.localhost', challenge: {} },
        { site: 'bad.localhost', challenge: {} },
      ]
      const filtered = filterOpenChallengesByBlockList(rows, { 'bad.localhost': { reason: 'user' } })
      assert.equal(filtered.length, 1)
      assert.equal(filtered[0].site, 'alice.localhost')
    })

    it('applyDeletionRatioMetrics silently hides peers above the deletion ratio', () => {
      const findings = Array.from({ length: 4 }, () => ({
        kind: 'missing-twin',
        peerSite: 'bad.localhost',
        peerUp: true,
        reason: 'twin game missing on peer',
        isLocalLoss: true,
      }))
      const { blockList, deletionMetrics } = applyDeletionRatioMetrics(findings, {}, {})
      assert.equal(deletionMetrics['bad.localhost'].ratio, 1)
      assert.equal(blockList['bad.localhost'].reason, 'deletion-ratio')
    })

    it('computeIslandState stays connected for a small young federation', () => {
      const events = [{ pgn: '[Date "2026.01.01"]\n\n1. e4 e5 1-0' }]
      const players = { 'a.localhost': {}, 'b.localhost': {} }
      const island = computeIslandState(events, players, null)
      assert.equal(island.state, 'connected')
      assert.equal(island.playerCount, 2)
      assert.equal(shouldShowIslandNotice(island), false)
    })

    it('computeIslandState flags isolation only after a real pool collapses', () => {
      const events = [{ pgn: '[Date "2026.01.01"]\n\n1. e4 e5 1-0' }]
      const players = { 'a.localhost': {}, 'b.localhost': {} }
      // 3 → 2 is below the contraction threshold but still a remnant of a real pool.
      const previous = {
        islandId: readGameTimelineKey(events[0].pgn).hash,
        playerCount: 3,
        state: 'connected',
      }
      const island = computeIslandState(events, players, previous)
      assert.equal(island.state, 'isolated')
      assert.equal(island.previousPlayerCount, 3)
      assert.equal(shouldShowIslandNotice(island), true)
    })

    it('computeIslandState flags shifted on sharp contraction', () => {
      const events = [{ pgn: '[Date "2026.01.01"]\n\n1. e4 e5 1-0' }]
      const players = {
        'a.localhost': {},
        'b.localhost': {},
        'c.localhost': {},
        'd.localhost': {},
      }
      const previous = {
        islandId: readGameTimelineKey(events[0].pgn).hash,
        playerCount: 10,
        state: 'connected',
      }
      const island = computeIslandState(events, players, previous)
      assert.ok(4 < 10 * (1 - ISLAND_CONTRACTION_RATIO))
      assert.equal(island.state, 'shifted')
      assert.equal(shouldShowIslandNotice(island), true)
    })

    it('shouldShowIslandNotice hides stale isolated flags without prior pool size', () => {
      assert.equal(
        shouldShowIslandNotice({ state: 'isolated', playerCount: 2, previousPlayerCount: 0 }),
        false,
      )
      assert.equal(shouldShowIslandNotice({ state: 'isolated', playerCount: 1 }), false)
    })
  })

  describe('crawl fetch concurrency', () => {
    it('mapWithConcurrency never exceeds the in-flight cap', async () => {
      let inFlight = 0
      let peak = 0
      const items = Array.from({ length: 20 }, (_, i) => i)
      const out = await mapWithConcurrency(items, 3, async n => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 5))
        inFlight -= 1
        return n * 2
      })
      assert.equal(peak, 3)
      assert.deepEqual(
        out,
        items.map(n => n * 2),
      )
    })

    it('fetchSiteGamePagesAsync caps parallel page fetches', async () => {
      let inFlight = 0
      let peak = 0
      const slugs = Array.from({ length: 12 }, (_, i) => `game-${i}`)
      const site = {
        async getPage(host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(entry => ({ ...entry })),
              chess: {
                gameIndex: {
                  completed: slugs.map(s => ({ site: host, slug: s, itemId: s })),
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise(r => setTimeout(r, 8))
          inFlight -= 1
          const name = String(slug).replace(/\.json$/i, '')
          return {
            title: name,
            story: [
              {
                type: 'chess',
                id: name,
                text: `[Event "${name}"]\n[Result "*"]\n\n*`,
              },
            ],
          }
        },
      }
      const { pageGames } = await fetchSiteGamePagesAsync(site, 'olga.localhost:3001')
      assert.ok(pageGames.length >= 12)
      assert.ok(peak <= SITE_FETCH_CONCURRENCY)
      assert.ok(peak >= 1)
    })

    it('diffSitemapSnapshots and ETA helpers support crawl reports', () => {
      const snap = sitemapSnapshotForCrawl([
        { slug: 'a', date: 2 },
        { slug: 'b', date: 1 },
      ])
      assert.deepEqual(
        snap.map(row => row.slug),
        ['a', 'b'],
      )
      const hit = diffSitemapSnapshots(snap, snap)
      assert.equal(hit.unchanged, true)
      assert.equal(hit.fetchSlugs.length, 0)
      const partial = diffSitemapSnapshots(snap, [
        { slug: 'a', date: 2 },
        { slug: 'b', date: 9 },
      ])
      assert.equal(partial.unchanged, false)
      assert.deepEqual(partial.fetchSlugs, ['b'])
      assert.ok(partial.keepSlugs.has('a'))
      assert.equal(estimateCrawlEtaSeconds(10_000, 2, 5), 15)
      assert.match(formatCrawlEtaLabel(10_000, 2, 5), /left/)
      const pruned = pruneSiteCrawlCache(
        normalizeSiteCrawlCache({
          'old.localhost': { updatedAt: 1, sitemap: [], games: [] },
          'new.localhost': { updatedAt: 9, sitemap: [], games: [] },
        }),
        1,
      )
      assert.deepEqual(Object.keys(pruned), ['new.localhost'])
    })

    it('reuses cached site games when the gameIndex fingerprint is unchanged', async () => {
      const pgn = `[Event "Cached"]\n[Result "1-0"]\n\n1. e4 e5 *`
      let pageFetches = 0
      const site = {
        async getPage(host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [{ site: host, slug: 'cached-game', itemId: 'g1', gameHash: 'stable-hash' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          pageFetches += 1
          return {
            title: 'Cached',
            story: [{ type: 'chess', id: 'g1', text: pgn }],
          }
        },
      }
      const first = await collectSiteGamesAsync(site, 'cache.localhost')
      assert.equal(first.cacheHit, false)
      assert.ok(first.pagesFetched >= 1)
      assert.equal(first.games.length, 1)
      assert.ok(first.cacheEntry?.gameIndexFingerprint)
      const pagesAfterFirst = pageFetches
      const second = await collectSiteGamesAsync(site, 'cache.localhost', {
        siteCache: first.cacheEntry,
      })
      assert.equal(second.cacheHit, true)
      assert.equal(second.pagesFetched, 0)
      assert.equal(pageFetches, pagesAfterFirst)
      assert.equal(second.games.length, 1)
    })

    it('refetches catalogued slugs when the gameIndex fingerprint changes', async () => {
      const pgnA = `[Event "A"]\n[Result "1-0"]\n\n1. e4 *`
      const pgnB1 = `[Event "B1"]\n[Result "1-0"]\n\n1. d4 *`
      const pgnB2 = `[Event "B2"]\n[Result "0-1"]\n\n1. c4 *`
      const fetched = []
      let gameHashB = 'hash-b1'
      const site = {
        async getPage(host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [
                    { site: host, slug: 'game-a', itemId: 'a', gameHash: 'hash-a' },
                    { site: host, slug: 'game-b', itemId: 'b', gameHash: gameHashB },
                  ],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          fetched.push(slug)
          if (slug === 'game-a.json') {
            return { title: 'A', story: [{ type: 'chess', id: 'a', text: pgnA }] }
          }
          if (slug === 'game-b.json') {
            return {
              title: 'B',
              story: [{ type: 'chess', id: 'b', text: gameHashB === 'hash-b1' ? pgnB1 : pgnB2 }],
            }
          }
          return null
        },
      }
      const first = await collectSiteGamesAsync(site, 'delta.localhost')
      assert.equal(first.games.length, 2)
      fetched.length = 0
      gameHashB = 'hash-b2'
      const second = await collectSiteGamesAsync(site, 'delta.localhost', {
        siteCache: first.cacheEntry,
      })
      assert.equal(second.cacheHit, false)
      // Fingerprint change refetches all indexed slugs (not a per-row sitemap delta).
      assert.ok(fetched.includes('game-a.json'))
      assert.ok(fetched.includes('game-b.json'))
      assert.equal(second.games.length, 2)
      assert.ok(second.games.some(pgn => pgn.includes('B2')))
      assert.ok(second.games.some(pgn => pgn.includes('[Event "A"]')))
    })

    it('selective-fetches catalogued slugs from survey gameIndex', async () => {
      const pgn = `[White "index.localhost (Ada)"]
[Black "peer.localhost (Bea)"]
[Result "1-0"]
[Rated "yes"]

1. e4 e5 2. Nf3 1-0`
      const stamped = stampCompletionTags(pgn, Date.parse('2026-01-02T00:00:00.000Z'))
      const fetched = []
      const site = {
        async getPage(_host, slug) {
          fetched.push(slug)
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(entry => ({ ...entry })),
              chess: {
                gameIndex: {
                  completed: [{ site: 'index.localhost', slug: 'rated-win', itemId: 'g1' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          if (slug === 'rated-win.json') {
            return { title: 'Rated', story: [{ type: 'chess', id: 'g1', text: stamped }] }
          }
          if (slug === 'system/sitemap.json') {
            assert.fail('sitemap should not be required when gameIndex is present')
          }
          return null
        },
      }
      const result = await collectSiteGamesAsync(site, 'index.localhost')
      assert.equal(result.games.length, 1)
      assert.ok(fetched.includes('my-chess-games.json'))
      assert.ok(fetched.includes('rated-win.json'))
      assert.equal(fetched.includes('system/sitemap.json'), false)
      assert.ok(result.cacheEntry?.gameIndexFingerprint)
    })

    it('rebuilds from sitemap when gameIndex is empty and rebuildIfEmpty is set', async () => {
      const activePgn = `[White "seed.localhost (Ada)"]
[Black "peer.localhost (Bea)"]
[Result "*"]
[Rated "yes"]

1. e4 e5 *`
      const site = {
        async getPage(_host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(entry => ({ ...entry })),
            }
          }
          if (slug === 'system/sitemap.json') {
            return [{ slug: 'live-game', date: 1 }]
          }
          if (slug === 'live-game.json') {
            return { title: 'Live', story: [{ type: 'chess', id: 'g1', text: activePgn }] }
          }
          return null
        },
      }
      const empty = await fetchSiteGamePagesAsync(site, 'seed.localhost')
      assert.equal(empty.pageGames.length, 0)
      const rebuilt = await fetchSiteGamePagesAsync(site, 'seed.localhost', { rebuildIfEmpty: true })
      assert.equal(rebuilt.pageGames.length, 1)
      assert.ok(rebuilt.rebuiltGameIndex)
      assert.equal(rebuilt.rebuiltGameIndex.active.length, 1)
      assert.equal(rebuilt.rebuiltGameIndex.active[0].slug, 'live-game')
    })

    it('detects unreadable gameIndex rows and rebuilds when rebuildIfEmpty is set', async () => {
      const activePgn = `[White "seed.localhost (Ada)"]
[Black "peer.localhost (Bea)"]
[Result "*"]
[Rated "no"]

1. d4 d5 *`
      assert.equal(
        gameIndexHasUnreadableEntries({
          active: [{ host: 'seed.localhost', slug: 'live-game', itemId: 'g1' }],
        }),
        true,
      )
      assert.equal(normalizeGameIndexEntry({ host: 'seed.localhost', slug: 'live-game', itemId: 'g1' }), null)
      assert.ok(normalizeGameIndexEntry({ site: 'seed.localhost', slug: 'live-game', itemId: 'g1' }))

      const site = {
        async getPage(_host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(entry => ({ ...entry })),
              chess: {
                gameIndex: {
                  updatedAt: 1,
                  active: [{ host: 'seed.localhost', slug: 'live-game', itemId: 'g1', title: 'Live' }],
                  completed: [],
                  challenges: [],
                  peers: [],
                },
              },
            }
          }
          if (slug === 'system/sitemap.json') {
            return [{ slug: 'live-game', date: 1 }]
          }
          if (slug === 'live-game.json') {
            return { title: 'Live', story: [{ type: 'chess', id: 'g1', text: activePgn }] }
          }
          return null
        },
      }
      assert.equal(readGameIndex(await site.getPage('seed.localhost', 'my-chess-games.json')).active.length, 0)
      const rebuilt = await fetchSiteGamePagesAsync(site, 'seed.localhost', { rebuildIfEmpty: true })
      assert.equal(rebuilt.pageGames.length, 1)
      assert.equal(rebuilt.rebuiltGameIndex?.active?.[0]?.site, 'seed.localhost')
      assert.equal(rebuilt.rebuiltGameIndex?.active?.[0]?.slug, 'live-game')
    })

    it('filters open challenges whose page game already has both seats filled', () => {
      const filledPgn = `[White "a.localhost (A)"]
[Black "b.localhost (B)"]
[Result "*"]

*`
      const kept = filterOpenChallengesStillSeeking(
        [
          { itemId: 'filled', slug: 'test-game', title: 'Test', pgn: '[Black ""]', challenge: { status: 'open' } },
          { itemId: 'open', slug: 'other-game', title: 'Other', pgn: '[Black ""]', challenge: { status: 'open' } },
        ],
        [{ itemId: 'filled', slug: 'test-game', pgn: filledPgn }],
      )
      assert.equal(kept.length, 1)
      assert.equal(kept[0].itemId, 'open')
    })

    it('retires a survey seek and first-writes page.chess.openChallenges without wiping unreadable gameIndex', () => {
      const surveyChess = SURVEY_PAGE_STORY.find(row => row.type === 'chess')
      const page = {
        title: SURVEY_PAGE_TITLE,
        story: [
          { ...SURVEY_PAGE_STORY[0] },
          {
            ...surveyChess,
            openChallenges: [
              {
                itemId: 'f2c3337f622eecec',
                slug: 'test-chess-game',
                title: 'Test Chess Game',
                pgn: '[White "rob.localhost (Rob)"]\n[Black ""]\n*',
                challenge: buildOpenChallenge({
                  rated: false,
                  creatorId: 'rob.localhost (Rob)',
                  creatorSite: 'rob.localhost',
                  challengeTarget: 'ward.localhost',
                }),
              },
            ],
          },
        ],
        chess: {
          gameIndex: {
            updatedAt: 1,
            active: [{ host: 'rob.localhost', slug: 'test-chess-game', itemId: 'f2c3337f622eecec' }],
            completed: [],
            challenges: [],
            peers: [],
          },
        },
      }
      assert.equal(chessCharmPatchWouldChange(page, { openChallenges: [] }), true)
      const result = syncOpenChallengeSurveyOnPage(page, {
        removeIds: ['f2c3337f622eecec'],
        site: 'rob.localhost',
      })
      assert.equal(result.changed, true)
      assert.equal(result.gameIndexTouched, false)
      assert.deepEqual(page.chess.openChallenges, [])
      assert.equal(page.chess.gameIndex.active[0].host, 'rob.localhost')
      assert.equal(readSurveyOpenChallengeRecords(page).length, 0)
    })

    it('crawls hosts within a BFS wave with bounded concurrency', async () => {
      let inFlight = 0
      let peak = 0
      const hosts = ['w0.localhost', 'w1.localhost', 'w2.localhost', 'w3.localhost']
      const site = {
        async getPage(host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [{ site: host, slug: 'solo', itemId: 'g' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise(r => setTimeout(r, 20))
          inFlight -= 1
          return {
            title: host,
            story: [
              {
                type: 'chess',
                id: 'g',
                text: `[Event "Solo"]\n[White "${host} (A)"]\n[Black "${host} (B)"]\n[Rated "Yes"]\n[Result "1-0"]\n\n1. e4 e5 *`,
              },
            ],
          }
        },
      }
      const result = await fetchFederationGamesAsync(site, hosts, {
        localSite: hosts[0],
        fetchReach: 'survey',
        expandGraph: false,
      })
      assert.ok(result)
      assert.equal(result.crawled.length, hosts.length)
      assert.ok(peak <= HOST_FETCH_CONCURRENCY)
      assert.ok(peak >= 2)
      assert.ok((result.crawlStats?.sitesCrawled || 0) >= hosts.length)
    })
  })

  describe('past opponents board', () => {
    const localGame = `[Event "Rated Game"]
[White "olga.localhost:3001 (Olga)"]
[Black "anya.localhost:3001 (Anya)"]
[Rated "Yes"]
[WhiteGlickoRating "1520"]
[WhiteGlickoRD "80"]
[BlackGlickoRating "1480"]
[BlackGlickoRD "80"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7`

    it('reads only the local site and never crawls opponent wikis', async () => {
      const touched = []
      const site = {
        async getPage(host, slug) {
          touched.push(`${host}/${slug}`)
          if (host === 'anya.localhost:3001') {
            throw new Error('opponent wiki should not be crawled')
          }
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [{ site: host, slug: 'rated-game', itemId: 'g1' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          if (slug === 'rated-game.json') {
            return {
              title: 'Rated Game',
              story: [{ type: 'chess', id: 'g1', text: localGame }],
            }
          }
          return null
        },
      }
      const result = await buildPastOpponentsBoardAsync(site, 'olga.localhost:3001')
      assert.ok(result)
      assert.equal(result.meta.mode, 'mine')
      assert.equal(result.meta.syncMode, 'local')
      assert.ok(touched.every(path => !path.startsWith('anya.localhost')))
      assert.deepEqual(result.meta.pastOpponents, ['anya.localhost:3001'])
      assert.deepEqual(
        result.entries.map(row => row.site),
        ['olga.localhost:3001', 'anya.localhost:3001'],
      )
    })

    it('routes buildLeaderboardAsync mine mode through the local-only path', async () => {
      const site = {
        async getPage(host, slug) {
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [{ site: host, slug: 'rated-game', itemId: 'g1' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          if (slug === 'rated-game.json') {
            return {
              title: 'Rated Game',
              story: [{ type: 'chess', id: 'g1', text: localGame }],
            }
          }
          return null
        },
      }
      const { meta } = await buildLeaderboardAsync(site, 'olga.localhost:3001', { mode: 'mine' })
      assert.equal(meta.mode, 'mine')
      assert.equal(meta.syncMode, 'local')
      assert.equal(meta.crawled, 1)
    })

    it('crawls registered neighbourhood member sites only (no opponent-graph expansion)', async () => {
      const touched = []
      const anyaGame = `[Event "Rated Game"]
[White "anya.localhost:3001 (Anya)"]
[Black "greta.localhost:3001 (Greta)"]
[Rated "Yes"]
[WhiteGlickoRating "1480"]
[WhiteGlickoRD "80"]
[BlackGlickoRating "1450"]
[BlackGlickoRD "80"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7`
      const gretaGame = `[Event "Rated Game"]
[White "greta.localhost:3001 (Greta)"]
[Black "liam.localhost:3001 (Liam)"]
[Rated "Yes"]
[WhiteGlickoRating "1450"]
[WhiteGlickoRD "80"]
[BlackGlickoRating "1440"]
[BlackGlickoRD "80"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7`
      const site = {
        async getPage(host, slug) {
          touched.push(`${host}/${slug}`)
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [{ site: host, slug: 'rated-game', itemId: 'g1' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          if (slug === 'rated-game.json') {
            let text = localGame
            if (host.startsWith('anya.localhost')) text = anyaGame
            else if (host.startsWith('greta.localhost')) text = gretaGame
            else if (host.startsWith('liam.localhost')) text = gretaGame
            return {
              title: 'Rated Game',
              story: [{ type: 'chess', id: 'g1', text }],
            }
          }
          return null
        },
      }
      const { meta, entries } = await buildLeaderboardAsync(site, 'olga.localhost:3001', {
        mode: 'neighborhood',
        neighborhoodSites: ['anya.localhost:3001'],
        localPlayers: {
          'olga.localhost:3001': { rating: 1600, rd: 50, gamesPlayed: 10 },
          'anya.localhost:3001': { rating: 1500, rd: 50, gamesPlayed: 8 },
        },
      })
      assert.equal(meta.mode, 'neighborhood')
      assert.equal(meta.syncMode, 'neighborhood')
      // Explicit roster only — greta/liam stay off the crawl until Add opponents.
      assert.equal(meta.crawled, 2)
      assert.ok(touched.some(path => path.startsWith('olga.localhost')))
      assert.ok(touched.some(path => path.startsWith('anya.localhost')))
      assert.equal(
        touched.some(path => path.startsWith('greta.localhost')),
        false,
      )
      assert.equal(
        touched.some(path => path.startsWith('liam.localhost')),
        false,
      )
      assert.deepEqual(meta.discoveredNeighbors || [], [])
      assert.ok(entries.some(row => sitesMatch(row.site, 'olga.localhost:3001')))
      assert.ok(entries.some(row => sitesMatch(row.site, 'anya.localhost:3001')))
      assert.equal(
        entries.some(row => sitesMatch(row.site, 'greta.localhost:3001')),
        false,
      )
      assert.equal(
        entries.some(row => sitesMatch(row.site, 'liam.localhost:3001')),
        false,
      )
    })

    it('keeps neighbourhood board curated when wiki.neighborhood is empty', async () => {
      const touched = []
      const site = {
        async getPage(host, slug) {
          touched.push(`${host}/${slug}`)
          if (slug === 'my-chess-games.json') {
            return {
              title: SURVEY_PAGE_TITLE,
              story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
              chess: {
                gameIndex: {
                  completed: [{ site: host, slug: 'rated-game', itemId: 'g1' }],
                  active: [],
                  challenges: [],
                },
              },
            }
          }
          if (slug === 'rated-game.json') {
            return {
              title: 'Rated Game',
              story: [{ type: 'chess', id: 'g1', text: localGame }],
            }
          }
          return null
        },
      }
      const { meta, entries } = await buildLeaderboardAsync(site, 'olga.localhost:3001', {
        mode: 'neighborhood',
        neighborhoodSites: [],
        localPlayers: {
          'olga.localhost:3001': { rating: 1600, rd: 50, gamesPlayed: 10 },
          'anya.localhost:3001': { rating: 1500, rd: 50, gamesPlayed: 8 },
        },
      })
      assert.equal(meta.mode, 'neighborhood')
      assert.equal(meta.crawled, 1)
      assert.ok(touched.every(path => path.startsWith('olga.localhost')))
      // Empty roster → local site only; Anya stays available via pastOpponents / Add opponents.
      assert.deepEqual(
        entries.map(row => row.site),
        ['olga.localhost:3001'],
      )
      assert.ok(
        (meta.pastOpponents || []).some(h => sitesMatch(h, 'anya.localhost:3001')),
        'past opponents should still list Anya for Add opponents',
      )
    })
  })

  describe('createBrowserWikiSiteClient', () => {
    it('wraps wiki.site().get in a promise', async () => {
      const page = { title: 'Test', story: [] }
      const client = createBrowserWikiSiteClient({
        site(host) {
          return {
            get(path, cb) {
              assert.equal(host, 'alice.localhost')
              assert.equal(path, 'welcome-visitors')
              cb(null, page)
            },
          }
        },
      })
      const result = await client.getPage('alice.localhost', 'welcome-visitors')
      assert.deepEqual(result, page)
    })

    it('returns null when wiki.site is unavailable', async () => {
      const client = createBrowserWikiSiteClient({})
      assert.equal(await client.getPage('x.localhost', 'y'), null)
    })
  })

  describe('orchestrateSiteSurveyDeferredWork', () => {
    it('preserves local seeks when challenge crawl finds nothing', async () => {
      const localSeek = {
        site: 'alice.localhost:3001',
        slug: 'my-chess-games',
        itemId: 'local1',
        ts: 2,
        challenge: { creator: { site: 'alice.localhost:3001' } },
      }
      const site = {
        async getPage() {
          return { title: 'Empty', story: [] }
        },
        async listSlugs() {
          return []
        },
      }
      const result = await orchestrateSiteSurveyDeferredWork(site, 'alice.localhost:3001', {
        localOpenChallenges: [localSeek],
        seeds: ['bob.localhost:3001'],
        enrichGames: false,
        fetchChallenges: true,
      })
      assert.equal(result.games.length, 0)
      assert.equal(result.openChallenges.length, 1)
      assert.equal(result.openChallenges[0].itemId, 'local1')
      assert.equal(result.meta?.site, 'alice.localhost:3001')
    })

    it('returns empty games when enrich is requested but crawl finds none', async () => {
      const site = {
        async getPage() {
          return { title: 'Empty', story: [] }
        },
        async listSlugs() {
          return []
        },
      }
      const result = await orchestrateSiteSurveyDeferredWork(site, 'alice.localhost:3001', {
        fetchedGames: [],
        enrichGames: true,
        fetchChallenges: false,
      })
      assert.deepEqual(result.games, [])
      assert.equal(result.meta, null)
    })

    it('reuses fetchedGames and skips a second site page crawl', async () => {
      let sitemapHits = 0
      const site = {
        async getPage(host, path) {
          if (String(path).includes('sitemap')) sitemapHits += 1
          return { title: 'Empty', story: [] }
        },
        async listSlugs() {
          sitemapHits += 1
          return []
        },
      }
      const snapshot = [
        {
          slug: 'my-chess-games',
          title: 'My Chess Games',
          pgn: `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "1-0"]
[Date "2026.07.12"]

1. e4 e5 1-0`,
          itemId: 'item1',
        },
      ]
      const result = await orchestrateSiteSurveyDeferredWork(site, 'alice.localhost', {
        fetchedGames: snapshot,
        enrichGames: true,
        fetchChallenges: false,
      })
      assert.equal(sitemapHits, 0)
      assert.ok(result.games.length >= 1)
      assert.equal(result.games[0].itemId, 'item1')
    })

    it('honors shouldAbort before challenge crawl', async () => {
      let touched = false
      const site = {
        async getPage() {
          touched = true
          return { title: 'Empty', story: [] }
        },
        async listSlugs() {
          touched = true
          return []
        },
      }
      const result = await orchestrateSiteSurveyDeferredWork(site, 'alice.localhost:3001', {
        localOpenChallenges: [{ site: 'alice.localhost:3001', slug: 's', itemId: 'x', ts: 1 }],
        seeds: ['bob.localhost:3001'],
        enrichGames: false,
        fetchChallenges: true,
        shouldAbort: () => true,
      })
      assert.equal(touched, false)
      assert.equal(result.openChallenges[0].itemId, 'x')
      assert.equal(result.meta?.unavailable, true)
    })
  })

  describe('neighbourhood hop trust', () => {
    it('matches the former ~3-hop floor at decay 0.8', () => {
      assert.ok(Math.abs(hopTrustAt(3, DEFAULT_NEIGHBORHOOD_HOP_DECAY) - 0.512) < 1e-9)
      assert.ok(hopTrustAt(3, DEFAULT_NEIGHBORHOOD_HOP_DECAY) >= HOP_TRUST_FLOOR)
      assert.ok(hopTrustAt(4, DEFAULT_NEIGHBORHOOD_HOP_DECAY) < HOP_TRUST_FLOOR)
    })

    it('previews kept hops and the first weeded cut', () => {
      // max hops above the decay cut so the preview attributes the weed to the floor.
      const rows = previewHopTrustSchedule({ maxHops: 5, hopDecay: 0.8 })
      assert.equal(rows.filter(r => r.kept).length, 4) // hops 0..3
      assert.equal(rows.at(-1).kept, false)
      assert.equal(rows.at(-1).hop, 4)
      assert.equal(rows.at(-1).weededReason, 'decay')
      const byMax = previewHopTrustSchedule({ maxHops: 2, hopDecay: 1 })
      assert.equal(byMax.at(-1).weededReason, 'maxHops')
      assert.deepEqual(normalizeNeighborhoodGraphOpts({ maxHops: 99, hopDecay: 0.1 }), {
        maxHops: 12,
        hopDecay: 0.5,
        trustFloor: HOP_TRUST_FLOOR,
      })
    })
  })

  describe('full federation crawl', () => {
    const ratedLink = (a, b, id) => `[Event "Link"]
[Site "http://${a} (id: ${id})"]
[Date "2026.01.01"]
[White "${a} (A)"]
[Black "${b} (B)"]
[Result "1-0"]
[Rated "Yes"]

1. e4 1-0`

    // Mock wiki site: each host has my-chess-games gameIndex + one game page.
    function chainSite(linksByHost) {
      const pages = new Map()
      for (const [host, pgns] of Object.entries(linksByHost)) {
        const h = String(host).toLowerCase()
        const story = (Array.isArray(pgns) ? pgns : []).map((text, i) => ({
          type: 'chess',
          id: `g${i}`,
          text,
        }))
        pages.set(h, {
          'my-chess-games.json': {
            title: SURVEY_PAGE_TITLE,
            story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
            chess: {
              gameIndex: {
                completed: story.length ? [{ site: h, slug: 'game-1', itemId: 'g0' }] : [],
                active: [],
                challenges: [],
              },
            },
          },
          'game-1.json': {
            title: 'Game 1',
            story,
          },
        })
      }
      return {
        async getPage(host, path) {
          const bag = pages.get(String(host || '').toLowerCase())
          if (!bag) return null
          return bag[path] || null
        },
      }
    }

    it('walks an opponent graph without hop trust when dials are omitted', async () => {
      // hop0→1→2→3→4→5 — unlimited survey crawl when hopGraph / useHopTrust are off.
      const hosts = [
        'hop0.localhost',
        'hop1.localhost',
        'hop2.localhost',
        'hop3.localhost',
        'hop4.localhost',
        'hop5.localhost',
      ]
      const links = {}
      for (let i = 0; i < hosts.length - 1; i += 1) {
        links[hosts[i]] = [ratedLink(hosts[i], hosts[i + 1], `link-${i}`)]
      }
      links[hosts[hosts.length - 1]] = []
      const site = chainSite(links)
      const result = await fetchFederationGamesAsync(site, [hosts[0]], {
        localSite: hosts[0],
        fetchReach: 'survey',
      })
      assert.ok(result)
      assert.deepEqual(result.crawled.sort(), [...hosts].sort())
      assert.equal(result.hopGraph, null)
    })

    it('weeds visible-federation graph hosts by max hops and decay floor', async () => {
      const hosts = ['hop0.localhost', 'hop1.localhost', 'hop2.localhost', 'hop3.localhost', 'hop4.localhost']
      const links = {}
      for (let i = 0; i < hosts.length - 1; i += 1) {
        links[hosts[i]] = [ratedLink(hosts[i], hosts[i + 1], `n-${i}`)]
      }
      links[hosts[hosts.length - 1]] = []
      const site = chainSite(links)
      const result = await fetchFederationGamesAsync(site, [hosts[0]], {
        localSite: hosts[0],
        fetchReach: 'survey',
        useHopTrust: true,
        maxHops: 2,
        hopDecay: 0.8,
      })
      assert.ok(result)
      assert.deepEqual(result.crawled.sort(), ['hop0.localhost', 'hop1.localhost', 'hop2.localhost'].sort())
      assert.equal(result.crawled.includes('hop3.localhost'), false)
      const hop3 = result.hopStats.find(row => row.hop === 3)
      assert.ok(hop3)
      assert.ok((hop3.weededMaxHops || 0) >= 1)
    })

    it('hop-bounded visible federation does not queue a full-federation deep audit', async () => {
      const links = {
        'hop0.localhost': [ratedLink('hop0.localhost', 'hop1.localhost', 'a')],
        'hop1.localhost': [],
      }
      const site = chainSite(links)
      const board = await buildLeaderboardAsync(site, 'hop0.localhost', {
        mode: 'survey',
        hopGraph: { maxHops: 2, hopDecay: 1 },
        localPlayers: {
          'hop0.localhost': { rating: 1600, rd: 50, gamesPlayed: 10 },
        },
        localCheckpoint: {
          state_hash: 'stale-not-matching',
          last_timeline_key: '',
          last_processed_game_hash: '',
        },
      })
      assert.ok(board)
      assert.equal(board.meta?.queueAudit, false)
      assert.ok(board.meta?.hopGraph)
    })

    it('hop-bounded visible federation leaf-crawls federation-index hosts without expanding them', async () => {
      // Index-only host has no rated path from hop0 — gameIndex-crawled as a leaf, but its
      // opponents must not be enqueued into the hop BFS (elsewhere stays untouched).
      const links = {
        'hop0.localhost': [ratedLink('hop0.localhost', 'hop1.localhost', 'a')],
        'hop1.localhost': [ratedLink('hop1.localhost', 'hop2.localhost', 'b')],
        'hop2.localhost': [],
        'index-only.localhost': [ratedLink('index-only.localhost', 'elsewhere.localhost', 'c')],
        'elsewhere.localhost': [ratedLink('elsewhere.localhost', 'far.localhost', 'd')],
        'neighbor-bloated.localhost': [ratedLink('neighbor-bloated.localhost', 'far.localhost', 'e')],
        'far.localhost': [],
      }
      const touched = []
      const base = chainSite(links)
      const site = {
        async getPage(host, path) {
          touched.push(`${host}/${path}`)
          return base.getPage(host, path)
        },
      }
      const bounded = await buildLeaderboardAsync(site, 'hop0.localhost', {
        mode: 'survey',
        hopGraph: { maxHops: 2, hopDecay: 1 },
        // Bloated neighbourhood must not become BFS seeds or index leaves.
        neighborhoodSites: ['neighbor-bloated.localhost', 'elsewhere.localhost'],
        // Explicit index leaf list (skip live federation-search fetch in unit tests).
        indexSites: ['index-only.localhost'],
        fetchIndex: false,
      })
      assert.ok(bounded)
      assert.ok(touched.some(p => p.startsWith('hop0.localhost')))
      assert.ok(touched.some(p => p.startsWith('hop1.localhost')))
      assert.ok(touched.some(p => p.startsWith('hop2.localhost')))
      assert.equal(
        touched.some(p => p.startsWith('index-only.localhost')),
        true,
      )
      assert.equal(
        touched.some(p => p.startsWith('elsewhere.localhost')),
        false,
      )
      assert.equal(
        touched.some(p => p.startsWith('neighbor-bloated.localhost')),
        false,
      )
      assert.ok((bounded.games || []).some(g => String(g).includes('index-only.localhost')))
      assert.ok((bounded.meta?.hopStats || []).length > 0)
    })

    it('resolveFederationIndexLeafHosts omits the local site and personal seeds', async () => {
      const leaves = await resolveFederationIndexLeafHosts(null, 'me.localhost', {
        indexSites: ['chess.viki.wiki', 'me.localhost', 'ward.dojo.fed.wiki'],
        knownOpponents: ['should-not-appear.localhost'],
      })
      assert.deepEqual(leaves, ['chess.viki.wiki', 'ward.dojo.fed.wiki'])
    })

    it('resolveFederationIndexLeafHosts merges global index over a thin fresh cache', async () => {
      resetChessPluginIndexCacheForTests()
      const fetchImpl = async () => ({
        ok: true,
        async json() {
          return {
            results:
              '<a href=//index-only.example target=index-only.example title=index-only.example>x</a>',
          }
        },
      })
      const leaves = await resolveFederationIndexLeafHosts(null, 'me.localhost', {
        knownFederationSites: {
          hosts: ['survey-only.example'],
          updatedAt: Date.now(),
        },
        fetchImpl,
      })
      assert.deepEqual(leaves.sort(), ['index-only.example', 'survey-only.example'].sort())
    })

    it('skips blockListed hosts and does not expand through them', async () => {
      const links = {
        'hop0.localhost': [ratedLink('hop0.localhost', 'bad.localhost', 'a')],
        'bad.localhost': [ratedLink('bad.localhost', 'hop2.localhost', 'b')],
        'hop2.localhost': [],
      }
      const site = chainSite(links)
      const result = await fetchFederationGamesAsync(site, ['hop0.localhost'], {
        localSite: 'hop0.localhost',
        fetchReach: 'survey',
        blockList: { 'bad.localhost': { reason: 'user' } },
      })
      assert.ok(result)
      assert.ok(result.crawled.includes('hop0.localhost'))
      assert.equal(result.crawled.includes('bad.localhost'), false)
      assert.equal(result.crawled.includes('hop2.localhost'), false)
    })

    it('challenge crawl probes SURVEY pages only (no seat-chain BFS)', async () => {
      const hosts = ['c0.localhost', 'c1.localhost', 'c2.localhost', 'c3.localhost', 'c4.localhost']
      const links = {}
      for (let i = 0; i < hosts.length - 1; i += 1) {
        links[hosts[i]] = [ratedLink(hosts[i], hosts[i + 1], `c-${i}`)]
      }
      links[hosts[hosts.length - 1]] = []
      const site = chainSite(links)
      const deep = await fetchChallengesAsync(site, [hosts[0]], 'my-chess-games')
      // Open seeks live on my-chess-games — do not walk opponent seat chains.
      assert.deepEqual(deep.crawled, [hosts[0]])

      const multi = await fetchChallengesAsync(site, [hosts[0], hosts[2], hosts[4]], 'my-chess-games')
      assert.deepEqual(multi.crawled.sort(), [hosts[0], hosts[2], hosts[4]].sort())

      const blocked = await fetchChallengesAsync(site, hosts, 'my-chess-games', {
        blockList: ['c2.localhost'],
      })
      assert.ok(blocked.crawled.includes('c0.localhost'))
      assert.ok(blocked.crawled.includes('c1.localhost'))
      assert.equal(blocked.crawled.includes('c2.localhost'), false)
      assert.ok(blocked.crawled.includes('c3.localhost'))
    })

    it('challenge crawl reads SURVEY openChallenges and reports progressive batches', async () => {
      const challenge = buildOpenChallenge({
        creatorId: 'bob.localhost (Bob)',
        creatorSite: 'bob.localhost',
        creatorColor: CHALLENGE_COLOR_WHITE,
      })
      const pgn = stampOpenChallengePgn(
        `[Event "Seek"]
[White "bob.localhost (Bob)"]
[Black "[open-seat]"]
[Result "*"]

*`,
        challenge,
      )
      const touched = []
      const site = {
        async getPage(host, path) {
          touched.push(`${host}/${path}`)
          if (path === 'system/sitemap.json') {
            throw new Error('sitemap should not be fetched for challenge discovery')
          }
          if (host === 'bob.localhost' && path === 'my-chess-games.json') {
            return {
              title: 'My Chess Games',
              story: [
                {
                  type: 'chess',
                  id: 'survey1',
                  text: 'SURVEY',
                  openChallenges: [{ itemId: 'seek1', pgn, title: 'Bob vs Open', challenge }],
                },
              ],
            }
          }
          return null
        },
      }
      const batches = []
      const result = await fetchChallengesAsync(site, ['bob.localhost', 'missing.localhost'], 'my-chess-games', {
        onBatch: batch => batches.push({ done: batch.done, n: batch.challenges.length }),
      })
      assert.equal(result.challenges.length, 1)
      assert.equal(result.challenges[0].itemId, 'seek1')
      assert.deepEqual(result.responsiveHosts, ['bob.localhost'])
      assert.ok(batches.some(b => b.done === true))
      assert.ok(batches.some(b => b.n >= 1 && !b.done) || batches.some(b => b.done && b.n >= 1))
      assert.equal(
        touched.some(t => t.includes('sitemap')),
        false,
      )
    })

    it('reports crawled/queued progress instead of a fixed host total', async () => {
      const links = {
        'a.localhost': [ratedLink('a.localhost', 'b.localhost', 'ab')],
        'b.localhost': [],
      }
      const site = chainSite(links)
      const messages = []
      await fetchFederationGamesAsync(site, ['a.localhost'], {
        localSite: 'a.localhost',
        fetchReach: 'survey',
        onProgress: patch => {
          if (patch?.message) messages.push(patch.message)
        },
      })
      assert.ok(messages.some(m => /\d+ done, \d+ queued/.test(m)))
      assert.equal(
        messages.some(m => /\/40/.test(m)),
        false,
      )
    })
  })

  describe('local farm sibling peers', () => {
    it('derives parent keys by stripping the leftmost label', () => {
      assert.equal(farmPeerParentKey('alice.localhost'), 'localhost')
      assert.equal(farmPeerParentKey('alice.localhost:3001'), 'localhost')
      assert.equal(farmPeerParentKey('olga.aolc.cc'), 'aolc.cc')
      assert.equal(farmPeerParentKey('ward.dojo.fed.wiki'), 'dojo.fed.wiki')
      assert.equal(farmPeerParentKey('localhost'), '')
      assert.equal(farmPeerParentKey('aolc.cc'), 'cc')
      assert.equal(farmPeerParentKey(''), '')
    })

    it('filters same-level sibling hosts and excludes self', () => {
      assert.deepEqual(
        filterSiblingFarmPeers('alice.localhost:3001', [
          'alice.localhost:3001',
          'bob.localhost:3001',
          'carol.localhost',
          'other.example.com',
          'localhost',
        ]),
        ['bob.localhost:3001', 'carol.localhost'],
      )
      assert.deepEqual(
        filterSiblingFarmPeers('olga.aolc.cc', ['rob.aolc.cc', 'chess.aolc.cc', 'aolc.cc', 'rob.other.cc']),
        ['rob.aolc.cc', 'chess.aolc.cc'],
      )
      assert.deepEqual(filterSiblingFarmPeers('localhost', ['alice.localhost', 'bob.localhost']), [])
    })

    it('maps farm data dirs to peer hosts with the local port', () => {
      assert.deepEqual(
        farmPeerHostsFromDataDirs(
          'alice.localhost:3001',
          ['alice.localhost', 'bob.localhost', 'carol.localhost', 'other.example.com', 'status'],
          { port: '3001' },
        ),
        ['bob.localhost:3001', 'carol.localhost:3001'],
      )
    })

    it('places farm peers after neighbourhood in fetch seed order', () => {
      assert.deepEqual(
        buildFetchTargets({
          localSite: 'me.localhost',
          knownOpponents: ['opp.example'],
          neighborhoodSites: ['nbhd.example'],
          farmPeerSites: ['peer.localhost'],
          indexSites: ['index.example'],
        }),
        ['me.localhost', 'opp.example', 'nbhd.example', 'peer.localhost', 'index.example'],
      )
      assert.deepEqual(
        buildSurveyFetchSeeds('me.localhost', {
          knownOpponents: ['opp.example'],
          neighborhoodSites: ['nbhd.example'],
          farmPeerSites: ['peer.localhost'],
          indexSites: ['index.example'],
        }),
        ['me.localhost', 'opp.example', 'nbhd.example', 'peer.localhost', 'index.example'],
      )
    })

    it('parses wiki-plugin-present roll sites into peer hosts', () => {
      assert.deepEqual(
        parsePresentRollSites(
          {
            roll: [
              { site: 'alice.localhost', pages: 3 },
              { site: 'bob.localhost', pages: 5 },
              { site: 'carol.localhost', pages: 1 },
              { site: 'other.example.com', pages: 2 },
            ],
          },
          'alice.localhost:3001',
        ),
        ['bob.localhost:3001', 'carol.localhost:3001'],
      )
    })

    it('fetchFarmPeerSites uses /plugin/present/roll and soft-fails when absent', async () => {
      const peers = await fetchFarmPeerSites({
        localSite: 'alice.localhost:3001',
        fetchImpl: async url => {
          assert.equal(url, '/plugin/present/roll')
          return {
            ok: true,
            async json() {
              return {
                roll: [
                  { site: 'alice.localhost', pages: 1 },
                  { site: 'bob.localhost', pages: 2 },
                ],
              }
            },
          }
        },
      })
      assert.deepEqual(peers, ['bob.localhost:3001'])
      assert.deepEqual(
        await fetchFarmPeerSites({
          localSite: 'alice.localhost:3001',
          fetchImpl: async () => ({ ok: false, status: 404 }),
        }),
        [],
      )
      assert.deepEqual(
        await fetchFarmPeerSites({
          localSite: 'alice.localhost:3001',
          fetchImpl: async () => {
            throw new Error('offline')
          },
        }),
        [],
      )
    })
  })

  describe('chess plugin federation index seeds', () => {
    afterEach(() => {
      resetChessPluginIndexCacheForTests()
    })

    it('parses hostnames from federation search results HTML', () => {
      const html =
        '<a href=//chess.viki.wiki target=chess.viki.wiki title=chess.viki.wiki>chess.viki.wiki</a><br>' +
        '<a href=//Ward.Dojo.Fed.Wiki target=Ward.Dojo.Fed.Wiki title=Ward.Dojo.Fed.Wiki>ward</a><br>' +
        '<a href=//chess.viki.wiki target=chess.viki.wiki title=chess.viki.wiki>dup</a>'
      assert.deepEqual(parseChessPluginIndexSites({ results: html }), ['chess.viki.wiki', 'ward.dojo.fed.wiki'])
      assert.deepEqual(parseChessPluginIndexSites(JSON.stringify({ results: html })), [
        'chess.viki.wiki',
        'ward.dojo.fed.wiki',
      ])
      assert.deepEqual(parseChessPluginIndexSites({}), [])
    })

    it('caches a successful index fetch for the TTL window', async () => {
      let calls = 0
      const fetchImpl = async () => {
        calls += 1
        return {
          ok: true,
          async json() {
            return {
              results:
                '<a href=//a.example target=a.example title=a.example>a</a><br>' +
                '<a href=//b.example target=b.example title=b.example>b</a>',
            }
          },
        }
      }
      const first = await fetchChessPluginIndexSites({ fetchImpl, now: 1_000 })
      const second = await fetchChessPluginIndexSites({
        fetchImpl,
        now: 1_000 + CHESS_PLUGIN_INDEX_TTL_MS - 1,
      })
      assert.deepEqual(first, ['a.example', 'b.example'])
      assert.deepEqual(second, ['a.example', 'b.example'])
      assert.equal(calls, 1)
      await fetchChessPluginIndexSites({
        fetchImpl,
        now: 1_000 + CHESS_PLUGIN_INDEX_TTL_MS + 1,
      })
      assert.equal(calls, 2)
    })

    it('keeps stale cache hosts when a refetch fails', async () => {
      let calls = 0
      const fetchImpl = async () => {
        calls += 1
        if (calls === 1) {
          return {
            ok: true,
            async json() {
              return { results: '<a href=//ok.example target=ok.example title=ok.example>ok</a>' }
            },
          }
        }
        throw new Error('network down')
      }
      assert.deepEqual(await fetchChessPluginIndexSites({ fetchImpl, now: 1 }), ['ok.example'])
      assert.deepEqual(
        await fetchChessPluginIndexSites({
          fetchImpl,
          now: 1 + CHESS_PLUGIN_INDEX_TTL_MS + 1,
        }),
        ['ok.example'],
      )
      assert.equal(calls, 2)
    })

    it('resolveFetchSeeds appends index hosts after personal seeds', async () => {
      const site = {
        async getSitemap() {
          return []
        },
        async getPage() {
          return { title: 'Empty', story: [] }
        },
        async listSlugs() {
          return []
        },
      }
      const seeds = await resolveFetchSeeds(site, 'me.localhost', {
        neighborhoodSites: ['neighbor.localhost'],
        indexSites: ['chess.viki.wiki', 'me.localhost'],
      })
      assert.deepEqual(seeds, ['me.localhost', 'neighbor.localhost', 'chess.viki.wiki'])
    })

    it('resolveFetchSeeds can skip the index fetch', async () => {
      let fetched = false
      const site = {
        async getSitemap() {
          return []
        },
        async getPage() {
          return { title: 'Empty', story: [] }
        },
        async listSlugs() {
          return []
        },
      }
      const seeds = await resolveFetchSeeds(site, 'me.localhost', {
        neighborhoodSites: ['neighbor.localhost'],
        fetchIndex: false,
        fetchImpl: async () => {
          fetched = true
          return {
            ok: true,
            async json() {
              return { results: '' }
            },
          }
        },
      })
      assert.equal(fetched, false)
      assert.deepEqual(seeds, ['me.localhost', 'neighbor.localhost'])
    })

    it('resolveFetchSeeds prefers a fresh federationSites cache over the global index', async () => {
      let fetched = false
      const site = {
        async getPage() {
          return { title: 'Empty', story: [] }
        },
      }
      const seeds = await resolveFetchSeeds(site, 'me.localhost', {
        neighborhoodSites: ['neighbor.localhost'],
        knownOpponents: ['opp.localhost'],
        knownFederationSites: {
          hosts: ['cached.example', 'neighbor.localhost'],
          updatedAt: Date.now(),
        },
        fetchImpl: async () => {
          fetched = true
          return {
            ok: true,
            async json() {
              return { results: '' }
            },
          }
        },
      })
      assert.equal(fetched, false)
      assert.deepEqual(seeds, ['me.localhost', 'opp.localhost', 'neighbor.localhost', 'cached.example'])
    })

    it('resolveFetchSeeds deferIndex never awaits the global index', async () => {
      let fetched = false
      const site = {
        async getPage() {
          return { title: 'Empty', story: [] }
        },
      }
      const seeds = await resolveFetchSeeds(site, 'me.localhost', {
        neighborhoodSites: ['neighbor.localhost'],
        knownOpponents: [],
        knownFederationSites: {
          hosts: ['stale.example'],
          updatedAt: 1,
        },
        deferIndex: true,
        fetchImpl: async () => {
          fetched = true
          return {
            ok: true,
            async json() {
              return { results: '<a href=//new.example target=new.example title=new.example>n</a>' }
            },
          }
        },
      })
      assert.equal(fetched, false)
      assert.deepEqual(seeds, ['me.localhost', 'neighbor.localhost', 'stale.example'])
    })

    it('refreshFederationSitesFromIndex merges new hosts in the background', async () => {
      const refreshed = await refreshFederationSitesFromIndex(
        { hosts: ['old.example'], updatedAt: 1 },
        {
          now: 1000,
          fetchImpl: async () => ({
            ok: true,
            async json() {
              return {
                results:
                  '<a href=//old.example target=old.example title=old.example>o</a>' +
                  '<a href=//new.example target=new.example title=new.example>n</a>',
              }
            },
          }),
        },
      )
      assert.deepEqual(refreshed.newHosts, ['new.example'])
      assert.ok(refreshed.hosts.includes('old.example'))
      assert.ok(refreshed.hosts.includes('new.example'))
      assert.equal(refreshed.cache.updatedAt, 1000)
    })

    it('mergeFederationSitesCache remembers responsive hosts', () => {
      const merged = mergeFederationSitesCache(
        { hosts: ['a.localhost'], updatedAt: 1 },
        ['b.localhost', 'a.localhost'],
        { now: 100 },
      )
      assert.deepEqual(merged.hosts, ['a.localhost', 'b.localhost'])
      assert.equal(merged.updatedAt, 100)
      const fresh = normalizeFederationSitesCache(merged, { now: 100 })
      assert.equal(fresh.fresh, true)
      const stale = normalizeFederationSitesCache(merged, {
        now: 100 + FEDERATION_SITES_CACHE_TTL_MS + 1,
      })
      assert.equal(stale.fresh, false)
    })
  })

  describe('survey.js host keys', () => {
    it('normalizeWikiSite strips port for consistent IndexedDB keying', () => {
      assert.equal(normalizeWikiSite('Host:3001'), normalizeWikiSite('host'))
    })
  })

  describe('academy teaching play journals', () => {
    it('synthesizes move glyphs and twin-site fork stamps when stampTwinForks is on', () => {
      const page = buildAcademyTeachingPageWithJournal(
        {
          title: 'The Opera Game',
          story: [
            { type: 'paragraph', id: 'blurb', text: 'Morphy masterpiece.' },
            {
              type: 'chess',
              id: 'demo',
              text: [
                'GAME',
                '[Event "Opera"]',
                '[Result "*"]',
                '',
                '1. e4 {center} 1... e5 2. Nf3 {develop} 2... Nc6 *',
              ].join('\n'),
            },
          ],
        },
        { seed: 'the-opera-game', startMs: 1_700_000_000_000, stampTwinForks: true },
      )
      assert.ok(page.journal.length > 5)
      const forks = page.journal.filter(a => a.type === 'fork')
      assert.ok(forks.length >= 1)
      assert.ok(forks.every(f => f.site === 'chess-academy-play.localhost'))
      const moveEdits = page.journal.filter(a => a.type === 'edit' && a.id === 'demo' && a.symbol && a.symbol !== '⚔')
      assert.ok(moveEdits.length >= 3, 'expected piece glyphs for plies')
      assert.equal(moveEdits[0].symbol, '♙')
      assert.match(String(page.story.find(i => i.id === 'demo')?.text || ''), /^GAME\n/)
      assert.equal(page.story[0].type, 'paragraph')
    })

    it('keeps local journals without twin forks when stampTwinForks is off', () => {
      const page = buildAcademyTeachingPageWithJournal(
        {
          title: 'Development',
          story: [
            {
              type: 'chess',
              id: 'demo',
              text: ['GAME', '[Result "*"]', '', '1. e4 {center} 1... e5 *'].join('\n'),
            },
          ],
        },
        { seed: 'development', startMs: 1_700_000_000_000, stampTwinForks: false },
      )
      assert.equal(page.journal.filter(a => a.type === 'fork').length, 0)
      assert.ok(
        page.journal.some(a => a.type === 'edit' && a.symbol && a.symbol !== '⚔'),
        'local move glyphs still present',
      )
    })
  })

  describe('fixtures · default wiki pages', () => {
    it('pages/my-chess-games matches SURVEY_PAGE_STORY', () => {
      const page = readDefaultPage('my-chess-games')
      assert.equal(page.title, SURVEY_PAGE_TITLE)
      assert.deepEqual(storyFingerprint(page.story), storyFingerprint(SURVEY_PAGE_STORY))
    })

    it('pages/chess-leaderboards matches LEADERBOARD_PAGE_STORY', () => {
      const page = readDefaultPage('chess-leaderboards')
      assert.equal(page.title, LEADERBOARD_PAGE_TITLE)
      assert.deepEqual(storyFingerprint(page.story), storyFingerprint(LEADERBOARD_PAGE_STORY))
    })
  })
})
