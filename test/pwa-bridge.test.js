/** Unit tests for PWA bridge logic in src/federation.js and server/pwa-bridge.js */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildJoinChallengePage,
  materializeJoinChallengePage,
  resolveChallengeJoinerColor,
  syncOpenChallengeSurveyOnPage,
  chessChallengesFromPage,
  buildSiteSurveyAsync,
  buildLeaderboardAsync,
  checkLeaderboardReadinessAsync,
  siteHasRatedGames,
  isLoopbackWikiHost,
  farmSiteDirFromSite,
  loopbackPortForHost,
  sitesMatch,
} from '../src/federation.js'
import {
  SURVEY_PAGE_STORY,
  SURVEY_PAGE_TITLE,
  isSurveyItemText,
  pageSlug,
  LEADERBOARD_PAGE_SLUG,
  LEADERBOARD_PAGE_TITLE,
  isLeaderboardPageSlug,
  pickLeaderboardPageSlug,
} from '../src/federation.js'
import {
  chessPwaManifest,
  chessInstallManifestIcons,
  createPwaBridgeSiteClient,
  createPwaBridgeRouter,
  readPngDimensions,
  federationIndexedDbOptsFromPayload,
  wikiFaviconRevision,
  requestOrigin,
} from '../server/pwa-bridge.js'
import { applyPageAction, applyChessSaveToPage, MSG } from '../src/chess-core.js'

function mockPagehandler(pages = {}) {
  return {
    get(slug, cb) {
      const key = String(slug).replace(/\.json$/i, '')
      if (Object.hasOwn(pages, key)) {
        cb(null, pages[key], 200)
        return
      }
      cb(null, null, 404)
    },
    put(slug, page, cb) {
      const key = String(slug).replace(/\.json$/i, '')
      pages[key] = page
      cb(null)
    },
  }
}

function mockRes() {
  let statusCode = 200
  let body = null
  const res = {
    status(code) {
      statusCode = code
      return res
    },
    header() {
      return res
    },
    json(payload) {
      body = payload
      return res
    },
    get statusCode() {
      return statusCode
    },
    get body() {
      return body
    },
  }
  return res
}

describe('server · pwa-bridge', () => {
  it('applies edit actions and rebuilds story', () => {
    const page = {
      title: 'Test',
      story: [{ type: 'chess', id: 'abc', text: 'GAME' }],
      journal: [],
    }
    applyPageAction(page, {
      type: 'create',
      item: { title: 'Test', story: page.story },
      date: 1,
    })
    const result = applyChessSaveToPage(page, 'abc', '[White "a"]\n[Black "b"]\n\n1. e4')
    assert.equal(result.changed, true)
    assert.match(page.story[0].text, /1\. e4/)
  })

  it('creates PWA puzzle pages with puzzle title and state', async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wiki-chess-'))
    const statusDir = path.join(tmp, 'status')
    await fsPromises.mkdir(statusDir, { recursive: true })
    // Non-empty sitemap so listSlugs does not fall through to loopback farm.
    await fsPromises.writeFile(path.join(statusDir, 'sitemap.json'), JSON.stringify([{ slug: 'welcome-visitors' }]))
    const pages = {}
    const handle = createPwaBridgeRouter({
      argv: { status: statusDir },
      securityhandler: {
        isAuthorized: () => true,
        getOwner: () => 'Olga',
      },
      pagehandler: mockPagehandler(pages),
    })
    const res = mockRes()
    const req = {
      method: 'POST',
      url: '/create-game',
      headers: { host: 'olga.localhost:3001' },
      body: {
        title: 'New Chess Puzzle',
        text: 'PUZZLE rating=1050..1600 themes=mateIn1',
      },
    }

    await new Promise((resolve, reject) => {
      const done = setInterval(() => {
        if (res.body != null) {
          clearInterval(done)
          resolve()
        }
      }, 5)
      setTimeout(() => {
        clearInterval(done)
        reject(new Error('create-game timed out'))
      }, 2000)
      handle(req, res, err => {
        clearInterval(done)
        if (err) reject(err)
      })
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.title, 'New Chess Puzzle')
    assert.equal(res.body?.slug, 'new-chess-puzzle')
    assert.equal(res.body?.chessObj?.wikiPageTitle, 'New Chess Puzzle')
    assert.equal(res.body?.chessObj?.format, 'PUZZLE')
    assert.equal(res.body?.chessObj?.gameType, 'puzzle')
    assert.equal(
      pages['new-chess-puzzle']?.story?.find(item => item.type === 'chess')?.text,
      'PUZZLE rating=1050..1600 themes=mateIn1',
    )
  })

  it('stores open challenges on the SURVEY item metadata', () => {
    const surveyItem = SURVEY_PAGE_STORY.find(i => i.type === 'chess')
    const page = {
      title: 'My Chess Games',
      story: [{ ...surveyItem }],
      journal: [
        {
          type: 'create',
          item: { title: 'My Chess Games', story: [{ ...surveyItem }] },
          date: 1,
        },
      ],
    }
    const result = syncOpenChallengeSurveyOnPage(page, {
      add: {
        itemId: 'ghost1',
        pgn: '[White "host (You)"]\n[Black "?"]\n\n*',
        title: 'Open — You',
        challenge: {
          status: 'open',
          config: { rated: false, creatorColor: 'random' },
          creator: { id: 'host (You)', host: 'localhost' },
        },
      },
    })
    assert.equal(result.changed, true)
    const updated = page.story.find(i => isSurveyItemText(i.text))
    assert.equal(updated.openChallenges.length, 1)
    assert.equal(updated.openChallenges[0].itemId, 'ghost1')
    assert.equal(updated.openChallenges[0].challenge.creator.site, 'localhost')
    assert.equal(updated.openChallenges[0].challenge.creator.host, undefined)
  })

  it('stores page-backed open challenges with a game slug on the SURVEY item', () => {
    const surveyItem = SURVEY_PAGE_STORY.find(i => i.type === 'chess')
    const page = {
      title: 'My Chess Games',
      story: [{ ...surveyItem }],
      journal: [
        {
          type: 'create',
          item: { title: 'My Chess Games', story: [{ ...surveyItem }] },
          date: 1,
        },
      ],
    }
    const result = syncOpenChallengeSurveyOnPage(page, {
      add: {
        itemId: 'page-item',
        slug: 'welcome-visitors',
        pgn: '[White "host (You)"]\n[Black "?"]\n\n*',
        title: 'Welcome Visitors',
        challenge: {
          status: 'open',
          config: { rated: false, creatorColor: 'random' },
          creator: { id: 'host (You)', host: 'localhost' },
        },
      },
    })
    assert.equal(result.changed, true)
    const updated = page.story.find(i => isSurveyItemText(i.text))
    assert.equal(updated.openChallenges[0].slug, 'welcome-visitors')
    assert.equal(updated.openChallenges[0].itemId, 'page-item')
  })

  it('builds a join-challenge page with seated PGN', () => {
    const payload = buildJoinChallengePage({
      ghostPgn: '[Event "Open — Alice"]\n[White "remote (Alice)"]\n[Black "?"]\n[Result "*"]\n\n*',
      challenge: {
        status: 'open',
        config: { rated: false, creatorColor: 'w' },
        creator: { id: 'remote (Alice)', site: 'remote.test' },
      },
      itemId: 'ghost99',
      joinerDisplayName: 'Bob',
      joinerSite: 'local.test',
      creatorSite: 'remote.test',
      ownerName: 'Bob',
      isAuthenticatedOwner: true,
    })
    const { page } = materializeJoinChallengePage(payload, {
      slug: 'open-alice-vs-bob',
      title: payload.baseTitle,
    })
    assert.ok(page.story.some(i => i.type === 'chess'))
    const chess = page.story.find(i => i.type === 'chess')
    assert.match(chess.text, /local\.test \(Bob\)/)
    assert.equal(chess.challenge?.status, 'active')
    const para = page.story.find(i => i.type === 'paragraph')
    assert.equal(para?.text, 'Bob (local.test) accepts an open challenge from Alice (remote).')
  })

  it('seats an unauthenticated joiner as plain Guest, not the public site owner', () => {
    const payload = buildJoinChallengePage({
      ghostPgn: '[White "remote (Alice)"]\n[Black ""]\n[Result "*"]\n\n*',
      challenge: {
        status: 'open',
        config: { rated: false, creatorColor: 'w', allowGuests: true },
        creator: { id: 'remote (Alice)', site: 'remote.test' },
      },
      itemId: 'ghost-guest',
      joinerDisplayName: '',
      joinerSite: 'chess.aolc.cc',
      creatorSite: 'remote.test',
      ownerName: 'Wiki Cafe Owner',
      isAuthenticatedOwner: false,
      guestName: 'Guest',
    })
    assert.match(payload.seatedPgn, /\[Black "Guest"\]/)
    assert.doesNotMatch(payload.seatedPgn, /Wiki Cafe Owner/)
    assert.doesNotMatch(payload.seatedPgn, /chess\.aolc\.cc \(Guest\)/)
  })

  it('materializes a join-challenge page with a caller-supplied title', () => {
    const payload = buildJoinChallengePage({
      ghostPgn: '[White "remote (Alice)"]\n[Black "?"]\n[Result "*"]\n\n*',
      challenge: {
        status: 'open',
        config: { rated: false, creatorColor: 'w' },
        creator: { id: 'remote (Alice)', site: 'remote.test' },
      },
      itemId: 'ghost42',
      joinerDisplayName: 'Bob',
      joinerSite: 'local.test',
      creatorSite: 'remote.test',
      ownerName: 'Bob',
      isAuthenticatedOwner: true,
    })
    const customTitle = 'My Custom Game Title'
    const { page } = materializeJoinChallengePage(payload, {
      slug: 'my-custom-game-title',
      title: customTitle,
    })
    assert.equal(page.title, customTitle)
  })

  it('personalizes an auto-built open-seek title for the joiner', () => {
    const challenge = {
      status: 'open',
      config: { rated: false, creatorColor: 'random' },
      creator: { id: 'remote (Alice)', site: 'remote.test' },
    }
    const payload = buildJoinChallengePage({
      ghostPgn: '[White "remote (Alice)"]\n[Black "?"]\n[Result "*"]\n\n*',
      challenge,
      itemId: 'ghost55',
      joinerDisplayName: 'Bob',
      joinerSite: 'local.test',
      creatorSite: 'remote.test',
      ownerName: 'Bob',
      isAuthenticatedOwner: true,
      remoteTitle: 'Alice vs [open-seat]',
    })
    // Random seat hash may put the joiner on White — title follows White vs Black.
    const joinerId = 'local.test (Bob)'
    const joinerColor = resolveChallengeJoinerColor(challenge, challenge.creator.id, joinerId)
    assert.equal(payload.baseTitle, joinerColor === 'w' ? 'Bob vs Alice' : 'Alice vs Bob')
  })

  it('harvests open seeks from real page PGN tags', () => {
    const seekPgn = `[White "alice.localhost (Alice)"]
[Black ""]
[Result "*"]
[Rated "no"]
[ChallengeCreator "alice.localhost (Alice)"]
[CreatorColor "White"]
[ChallengeTs "1700000000000"]

*`
    const rows = chessChallengesFromPage(
      {
        title: 'Alice vs Open',
        story: [{ type: 'chess', id: 'seek1', text: seekPgn }],
      },
      'alice.localhost',
      'alice-vs-open',
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].pending, false)
    assert.equal(rows[0].itemId, 'seek1')
    assert.equal(rows[0].challenge?.creator?.id, 'alice.localhost (Alice)')
  })

  it('slugifies titles like the wiki client', () => {
    assert.equal(pageSlug('My Chess Games'), 'my-chess-games')
    assert.equal(pageSlug(LEADERBOARD_PAGE_TITLE), LEADERBOARD_PAGE_SLUG)
  })

  it('recognizes the canonical leaderboard page slug', () => {
    assert.equal(isLeaderboardPageSlug(LEADERBOARD_PAGE_SLUG), true)
    assert.equal(isLeaderboardPageSlug('my-chess-games'), false)
  })

  it('prefers a saved fork slug over the plugin template stub', () => {
    const forkStory = [{ type: 'chess', id: 'x', text: 'LEADERBOARD' }]
    assert.equal(
      pickLeaderboardPageSlug({
        [LEADERBOARD_PAGE_SLUG]: { story: forkStory },
      }),
      LEADERBOARD_PAGE_SLUG,
    )
    assert.equal(
      pickLeaderboardPageSlug({
        [LEADERBOARD_PAGE_SLUG]: { story: forkStory, plugin: 'chess' },
      }),
      LEADERBOARD_PAGE_SLUG,
    )
  })

  it('normalizes loopback farm host helpers', () => {
    assert.equal(isLoopbackWikiHost('frank.localhost:3001'), true)
    assert.equal(isLoopbackWikiHost('192.168.68.62:3001'), true)
    assert.equal(isLoopbackWikiHost('example.com'), false)
    assert.equal(farmSiteDirFromSite('tessa.localhost:3001'), 'tessa.localhost')
    assert.equal(loopbackPortForHost('frank.localhost:3001'), '3001')
    assert.equal(loopbackPortForHost('frank.localhost', '3001'), '3001')
  })

  it('detects rated games for leaderboard listing', () => {
    const pgn = `[Event "Rated"]
[White "localhost (Rob)"]
[Black "guest.localhost (Guest)"]
[Rated "Yes"]
[WhiteGlickoRating "1500"]
[WhiteGlickoRD "200"]
[Result "1-0"]

1. e4 e5`
    assert.equal(siteHasRatedGames([pgn], 'localhost'), true)
    assert.equal(siteHasRatedGames([pgn], 'other.localhost'), false)
  })

  it('builds a site survey payload from local pages', async () => {
    const gamePgn = `[Event "Test Game"]
[White "localhost (Rob)"]
[Black "guest.localhost (Guest)"]
[Result "*"]

1. e4`
    const site = {
      async getPage(host, slug) {
        if (slug === 'my-chess-games.json') {
          return {
            title: SURVEY_PAGE_TITLE,
            story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
            chess: {
              gameIndex: {
                completed: [{ host, slug: 'test-game', itemId: 'game1' }],
                active: [],
                challenges: [],
              },
            },
          }
        }
        if (slug === 'test-game.json') {
          return {
            title: 'Test Game',
            story: [{ type: 'chess', id: 'game1', text: gamePgn }],
          }
        }
        return null
      },
    }
    const { entries, meta } = await buildSiteSurveyAsync(site, 'localhost', 'my-chess-games')
    assert.ok(Array.isArray(entries))
    assert.equal(meta.mode, 'site')
    assert.equal(meta.host, 'localhost')
    assert.ok(Array.isArray(meta.games))
    assert.equal(meta.games.length, 1)
    assert.equal(meta.games[0].active, true)
    assert.ok(Array.isArray(meta.openChallenges))
  })

  it('reports leaderboard readiness from published rated games', async () => {
    const gamePgn = `[Event "Rated Game"]
[White "localhost (Rob)"]
[Black "guest.localhost (Guest)"]
[Rated "Yes"]
[WhiteGlickoRating "1500"]
[WhiteGlickoRD "200"]
[Result "1-0"]

1. e4 e5`
    const site = {
      async getPage(_host, slug) {
        if (slug === 'system/sitemap.json') {
          return [
            { slug: 'my-chess-games', date: 2 },
            { slug: 'rated-game', date: 1 },
          ]
        }
        if (slug === 'my-chess-games.json') {
          return {
            title: 'My Chess Games',
            story: [{ type: 'chess', id: 'survey1', text: 'SURVEY' }],
          }
        }
        if (slug === 'rated-game.json') {
          return {
            title: 'Rated Game',
            story: [{ type: 'chess', id: 'game1', text: gamePgn }],
          }
        }
        return null
      },
    }
    const status = await checkLeaderboardReadinessAsync(site, 'localhost', 'my-chess-games')
    assert.equal(status.hasRatedGame, true)
  })

  it('reports no leaderboard readiness without rated games', async () => {
    const site = {
      async getPage(_host, slug) {
        if (slug === 'system/sitemap.json') {
          return [{ slug: 'my-chess-games', date: 1 }]
        }
        if (slug === 'my-chess-games.json') {
          return {
            title: 'My Chess Games',
            story: [{ type: 'chess', id: 'survey1', text: 'SURVEY' }],
          }
        }
        return null
      },
    }
    const status = await checkLeaderboardReadinessAsync(site, 'localhost', 'my-chess-games')
    assert.equal(status.hasRatedGame, false)
  })

  it('builds a federated survey leaderboard from local pages', async () => {
    const gamePgn = `[Event "Rated Game"]
[White "localhost (Rob)"]
[Black "guest.localhost (Guest)"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7`
    const site = {
      async getPage(host, slug) {
        if (slug === 'my-chess-games.json') {
          return {
            title: SURVEY_PAGE_TITLE,
            story: SURVEY_PAGE_STORY.map(e => ({ ...e })),
            chess: {
              gameIndex: {
                completed: [{ host, slug: 'rated-game', itemId: 'game1' }],
                active: [],
                challenges: [],
              },
            },
          }
        }
        if (slug === 'rated-game.json') {
          return {
            title: 'Rated Game',
            story: [{ type: 'chess', id: 'game1', text: gamePgn }],
          }
        }
        return null
      },
    }
    const { entries, meta } = await buildLeaderboardAsync(site, 'localhost', {
      mode: 'survey',
    })
    assert.ok(Array.isArray(entries))
    assert.equal(meta.mode, 'survey')
    assert.ok(meta.crawled >= 1)
  })

  it('builds a neighborhood board by crawling neighbourhood member sites', async () => {
    const gamePgn = `[Event "Rated Game"]
[White "localhost (Rob)"]
[Black "neighbor.localhost (Neighbor)"]
[Result "1-0"]
[Rated "Yes"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7`
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
                completed: [{ host, slug: 'rated-game', itemId: 'game1' }],
                active: [],
                challenges: [],
              },
            },
          }
        }
        if (slug === 'rated-game.json') {
          return {
            title: 'Rated Game',
            story: [{ type: 'chess', id: 'game1', text: gamePgn }],
          }
        }
        return null
      },
    }
    const { entries, meta } = await buildLeaderboardAsync(site, 'localhost', {
      mode: 'neighborhood',
      neighborhoodSites: ['neighbor.localhost'],
    })
    assert.ok(Array.isArray(entries))
    assert.equal(meta.mode, 'neighborhood')
    assert.equal(meta.syncMode, 'neighborhood')
    assert.ok(meta.crawled >= 2)
    assert.ok(touched.some(path => path.startsWith('localhost/')))
    assert.ok(touched.some(path => path.startsWith('neighbor.localhost/')))
    assert.ok(meta.neighborhoodSites.some(h => sitesMatch(h, 'neighbor.localhost')))
    assert.ok(
      meta.pastOpponents.includes('neighbor.localhost') ||
        meta.pastOpponents.some(h => sitesMatch(h, 'neighbor.localhost')),
    )
  })

  it('serves a host-specific installable web app manifest', () => {
    const req = { headers: { host: 'frank.localhost:3001' }, socket: {} }
    const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
    const statusDir = path.join(clientDir, '.test-status')
    fs.mkdirSync(statusDir, { recursive: true })
    fs.copyFileSync(path.join(clientDir, 'icon-512.png'), path.join(statusDir, 'favicon.png'))
    const favMtime = String(Math.trunc(fs.statSync(path.join(statusDir, 'favicon.png')).mtimeMs))
    const manifest = chessPwaManifest(req, { host: 'frank.localhost:3001', status: statusDir })
    fs.rmSync(statusDir, { recursive: true, force: true })
    assert.match(manifest.name, /frank\.localhost:3001/)
    assert.equal(manifest.display, 'standalone')
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'))
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'))
    assert.ok(manifest.icons.some(icon => icon.src.includes('/favicon.png')))
    assert.ok(
      manifest.icons.some(icon => icon.src.includes(`/favicon.png?v=${favMtime}`)),
      'site favicon URL should cache-bust on mtime',
    )
    const faviconIdx = manifest.icons.findIndex(icon => icon.src.includes('/favicon.png'))
    const bundled512Idx = manifest.icons.findIndex(
      icon => icon.src.includes('icon-512.png') && icon.sizes === '512x512',
    )
    assert.ok(faviconIdx >= 0 && bundled512Idx >= 0)
    assert.ok(faviconIdx < bundled512Idx, 'site favicon should precede bundled 512 for installed shortcut')
    assert.equal(manifest.start_url, '/plugins/chess/index.html')
    assert.equal(manifest.scope, '/plugins/chess/')
    assert.equal(manifest.id, '/plugins/chess/index.html')
    assert.equal(manifest.launch_handler, undefined)
    assert.equal(manifest.related_applications[0].platform, 'webapp')
    assert.match(manifest.related_applications[0].url, /\/plugins\/chess\/manifest\.json$/)
    assert.equal(manifest.related_applications[0].id, '/plugins/chess/index.html')
  })

  it('requestOrigin prefers X-Forwarded-Proto for TLS-terminating proxies', () => {
    assert.equal(
      requestOrigin({ headers: { host: 'chess.example.co', 'x-forwarded-proto': 'https' }, socket: {} }, {}),
      'https://chess.example.co',
    )
    assert.equal(
      requestOrigin(
        {
          headers: { host: 'chess.example.co', 'x-forwarded-proto': 'https, http' },
          socket: {},
        },
        {},
      ),
      'https://chess.example.co',
    )
    assert.equal(
      requestOrigin({ headers: { host: 'frank.localhost:3001' }, socket: {} }, {}),
      'http://frank.localhost:3001',
    )
    const manifest = chessPwaManifest(
      {
        headers: { host: 'chess.example.co', 'x-forwarded-proto': 'https' },
        socket: {},
      },
      { host: 'chess.example.co' },
    )
    assert.equal(manifest.related_applications[0].url, 'https://chess.example.co/plugins/chess/manifest.json')
  })

  it('reads PNG dimensions for manifest icon metadata', () => {
    const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
    const buf = fs.readFileSync(path.join(clientDir, 'icon-512.png'))
    const dim = readPngDimensions(buf)
    assert.equal(dim.width, 512)
    assert.equal(dim.height, 512)
  })

  it('falls back to bundled icons when site favicon is missing', () => {
    const icons = chessInstallManifestIcons('/plugins/chess/', { faviconPath: null })
    assert.equal(icons.length, 2)
    assert.ok(icons.every(icon => !icon.src.includes('/favicon.png')))
  })

  it('leads with a large wiki flag in the install manifest', () => {
    const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
    const statusDir = path.join(clientDir, '.test-status-icons')
    fs.mkdirSync(statusDir, { recursive: true })
    const favPath = path.join(statusDir, 'favicon.png')
    fs.copyFileSync(path.join(clientDir, 'icon-512.png'), favPath)
    const icons = chessInstallManifestIcons('/plugins/chess/', { faviconPath: favPath })
    assert.ok(icons[0].src.includes('/favicon.png'))
    assert.equal(icons[0].sizes, '512x512')
    fs.rmSync(statusDir, { recursive: true, force: true })
  })

  it('wikiFaviconRevision tracks favicon mtime for cache busting', () => {
    const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
    const statusDir = path.join(clientDir, '.test-status-rev')
    fs.mkdirSync(statusDir, { recursive: true })
    const favPath = path.join(statusDir, 'favicon.png')
    fs.copyFileSync(path.join(clientDir, 'icon-512.png'), favPath)
    const rev = wikiFaviconRevision(favPath)
    assert.equal(rev, String(Math.trunc(fs.statSync(favPath).mtimeMs)))
    assert.equal(wikiFaviconRevision(null), null)
    assert.equal(wikiFaviconRevision(path.join(statusDir, 'missing.png')), null)
    fs.rmSync(statusDir, { recursive: true, force: true })
  })

  it('ships installable PWA icon PNGs', () => {
    const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client')
    for (const size of [192, 512]) {
      const iconPath = path.join(clientDir, `icon-${size}.png`)
      assert.ok(fs.existsSync(iconPath), `missing icon-${size}.png`)
      assert.ok(fs.statSync(iconPath).size > 100, `icon-${size}.png looks empty`)
    }
  })

  it('forwards federationIndexedDbPayload fields into crawl job opts', () => {
    const blockList = { 'evil.example': { reason: 'user', blockedAt: 1 } }
    const deletionMetrics = { 'evil.example': { deleted: 2, seen: 3 } }
    const island = { id: 'isle-1' }
    const knownOpponents = ['friend.localhost']
    const knownFederationSites = { hosts: ['peer.example'], updatedAt: 9 }
    const siteCrawlCache = {
      'peer.example': { updatedAt: 9, sitemap: [{ slug: 'g', date: 1 }], games: [] },
    }
    const opts = federationIndexedDbOptsFromPayload({
      blockList,
      deletionMetrics,
      island,
      knownOpponents,
      knownFederationSites,
      siteCrawlCache,
      localCheckpoint: { state_hash: 'ignore-me' },
    })
    assert.deepEqual(opts, {
      blockList,
      deletionMetrics,
      island,
      knownOpponents,
      knownFederationSites,
      siteCrawlCache,
    })
    assert.deepEqual(federationIndexedDbOptsFromPayload({}), {
      blockList: undefined,
      deletionMetrics: undefined,
      island: undefined,
      knownOpponents: undefined,
      knownFederationSites: undefined,
      siteCrawlCache: undefined,
    })
  })
})

describe('server · pwa-bridge-site-client', () => {
  it('getPage returns normalized local page for matching host', async () => {
    const localSite = 'alice.localhost:3001'
    const page = {
      title: 'My Game',
      story: [{ type: 'chess', id: 'abc', text: 'GAME' }],
      journal: [],
    }
    const site = createPwaBridgeSiteClient(mockPagehandler({ 'my-game': page }), localSite, {
      data: '/nonexistent',
      status: '/nonexistent',
    })
    const result = await site.getPage(localSite, 'my-game')
    assert.equal(result.title, 'My Game')
    assert.equal(result.story[0].id, 'abc')
  })

  it('getPage returns null for missing local slug', async () => {
    const localSite = 'alice.localhost:3001'
    const site = createPwaBridgeSiteClient(mockPagehandler({}), localSite, {})
    const result = await site.getPage(localSite, 'missing-page')
    assert.equal(result, null)
  })

  it('listSlugs derives slugs from argv status sitemap', async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wiki-chess-'))
    const statusDir = path.join(tmp, 'status')
    await fsPromises.mkdir(statusDir, { recursive: true })
    await fsPromises.writeFile(
      path.join(statusDir, 'sitemap.json'),
      JSON.stringify([{ slug: 'welcome-visitors' }, { slug: 'my-chess-games' }]),
    )
    const localSite = 'alice.localhost:3001'
    const site = createPwaBridgeSiteClient(mockPagehandler({}), localSite, { status: statusDir })
    const slugs = await site.listSlugs(localSite)
    assert.deepEqual(slugs, ['welcome-visitors', 'my-chess-games'])
  })

  it('browser site client is getPage-only; bridge adds listSlugs', async () => {
    const site = createPwaBridgeSiteClient(mockPagehandler({}), 'host.localhost', {})
    assert.equal(typeof site.getPage, 'function')
    assert.equal(typeof site.listSlugs, 'function')
  })
})

describe('server · pwa-bridge OPEN_GAME_PAGE', () => {
  function mockRes() {
    let statusCode = 200
    let body = null
    const res = {
      status(code) {
        statusCode = code
        return res
      },
      header() {
        return res
      },
      json(payload) {
        body = payload
        return res
      },
      get statusCode() {
        return statusCode
      },
      get body() {
        return body
      },
    }
    return res
  }

  async function dispatchOpenGame(msg, pages, host = 'olga.localhost:3001') {
    const handle = createPwaBridgeRouter({
      argv: {},
      securityhandler: {
        isAuthorized: () => true,
        getOwner: () => 'Olga',
      },
      pagehandler: mockPagehandler(pages),
    })
    const res = mockRes()
    const req = {
      method: 'POST',
      url: '/dispatch',
      headers: { host },
      body: { msg, ctx: {} },
    }
    await new Promise((resolve, reject) => {
      const done = setInterval(() => {
        if (res.body != null) {
          clearInterval(done)
          resolve()
        }
      }, 5)
      setTimeout(() => {
        clearInterval(done)
        reject(new Error('dispatch timed out'))
      }, 2000)
      handle(req, res, err => {
        clearInterval(done)
        if (err) reject(err)
      })
    })
    return res
  }

  it('loads a local game into the PWA when the app sends site', async () => {
    const pgn = `[White "olga.localhost:3001 (Olga)"]
[Black "Stockfish Level 3"]
[Result "*"]

*`
    const page = {
      title: 'New Chess Position',
      story: [{ type: 'chess', id: 'game1', text: pgn }],
      journal: [],
    }
    const res = await dispatchOpenGame(
      {
        action: MSG.OPEN_GAME_PAGE,
        slug: 'new-chess-position',
        itemId: 'game1',
        site: 'olga.localhost:3001',
        title: 'New Chess Position',
      },
      { 'new-chess-position': page },
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.pwaContext?.slug, 'new-chess-position')
    assert.equal(res.body?.pwaContext?.itemId, 'game1')
    const setState = (res.body?.replies || []).find(r => r.action === MSG.SET_STATE)
    assert.ok(setState)
    assert.equal(setState.itemId, 'game1')
    assert.match(setState.chessObj?.PGN || '', /Stockfish Level 3/)
    assert.equal(setState.chessObj?.showStartMenu, false)
  })

  it('still opens when site is omitted (same-wiki survey click)', async () => {
    const page = {
      title: 'Local Game',
      story: [{ type: 'chess', id: 'x', text: '[White "a"]\n[Black "b"]\n\n*' }],
      journal: [],
    }
    const res = await dispatchOpenGame(
      {
        action: MSG.OPEN_GAME_PAGE,
        slug: 'local-game',
        itemId: 'x',
      },
      { 'local-game': page },
    )
    assert.equal(res.body?.pwaContext?.slug, 'local-game')
    assert.ok((res.body?.replies || []).some(r => r.action === MSG.SET_STATE))
  })

  it('LOOKUP_SITE_DISPLAY replies with SITE_DISPLAY (matches shell/app contract)', async () => {
    assert.equal(MSG.HOST_DISPLAY, undefined)
    const res = await dispatchOpenGame(
      { action: MSG.LOOKUP_SITE_DISPLAY, requestId: 'req-1', host: 'unreachable.test' },
      {},
    )
    assert.equal(res.statusCode, 200)
    const reply = (res.body?.replies || []).find(r => r.requestId === 'req-1')
    assert.ok(reply)
    assert.equal(reply.action, MSG.SITE_DISPLAY)
    assert.equal(reply.action, 'site-display')
  })

  it('fetches referenced puzzle page chess items for the installed PWA', async () => {
    const res = await dispatchOpenGame(
      { action: MSG.FETCH_PUZZLE_PAGES, requestId: 'puzzles-1', slugs: ['the-fork', '../private'] },
      {
        'the-fork': {
          title: 'The Fork',
          story: [
            { type: 'markdown', id: 'intro', text: 'Lesson' },
            { type: 'chess', id: 'p1', text: 'PUZZLE\n{"id":"fork-1"}' },
          ],
        },
      },
    )
    const reply = (res.body?.replies || []).find(r => r.action === MSG.PUZZLE_PAGES_DATA)
    assert.equal(reply.requestId, 'puzzles-1')
    assert.equal(reply.pages.length, 1)
    assert.equal(reply.pages[0].slug, 'the-fork')
    assert.deepEqual(reply.pages[0].story, [
      { type: 'chess', id: 'p1', text: 'PUZZLE\n{"id":"fork-1"}' },
    ])
  })
})
