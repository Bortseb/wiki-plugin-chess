/** Embed wheel forwarding decisions (leaderboard / survey scroll chaining). */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEmbedWheelAction,
  isBrowserZoomWheel,
  CHOOSE_MENU_HEIGHT,
  CHOOSE_MENU_WIDTH,
  POPUP_INSTALL_DIALOG_MIN_HEIGHT,
  POPUP_INSTALL_DIALOG_MIN_WIDTH,
  LIST_VIEW_HEIGHT,
  LIST_VIEW_WIDTH,
  LEADERBOARD_VIEW_HEIGHT,
  LEADERBOARD_VIEW_WIDTH,
  chooseMenuWindowMetrics,
  popupWindowFeaturesString,
  windowMetricsForChessObj,
  windowMetricsForPage,
  POPUP_PUZZLE_CONTENT_CHROME_EST,
  POPUP_PUZZLE_BELOW_CHROME_BUDGET,
  BOARD_SQUARE_MIN_PX,
  POPUP_PWA_BOARD_MIN,
  POPUP_POSITION_BOARD_CAP,
  positionBoardCapPx,
  puzzleBoardCapPx,
  clampPwaPlayWindowHeight,
  shellTransport,
  enrichTransport,
  createShellMessenger,
  shellMessengerFromContext,
  isPwaJournallessSession,
  showLocalOnlyHalo,
  matchInstalledChessPwa,
  pwaOuterHeightForModalContent,
  pwaOuterWidthForModalPanel,
  shouldSkipPwaModalWindowRestore,
  popupOuterSizeUnchanged,
  isPwaDocumentReload,
  resolveBootIntent,
  initPwaPageChrome,
  updatePwaPageChrome,
  updatePwaPageChromeStatus,
  shouldTransitionPwaStatus,
  readPwaPageChromeStatus,
  clearPwaPageChromeStatus,
  rememberPopupState,
} from '../src/board-layout.js'
import { MSG } from '../src/chess-core.js'

describe('app · board-layout', () => {
  it('detects browser zoom wheel gestures', () => {
    assert.equal(isBrowserZoomWheel({ ctrlKey: true }), true)
    assert.equal(isBrowserZoomWheel({ metaKey: true }), true)
    assert.equal(isBrowserZoomWheel({ ctrlKey: false, metaKey: false }), false)
  })

  it('forwards when the region is not scrollable', () => {
    assert.equal(
      resolveEmbedWheelAction({
        deltaY: 100,
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 200,
        overflowY: 'visible',
      }),
      'forward',
    )
  })

  it('consumes wheel in the middle of a scrollable region', () => {
    assert.equal(
      resolveEmbedWheelAction({
        deltaY: 40,
        scrollTop: 100,
        scrollHeight: 500,
        clientHeight: 200,
        overflowY: 'auto',
      }),
      'consume',
    )
  })

  it('chains overflow at the top or bottom edge', () => {
    assert.equal(
      resolveEmbedWheelAction({
        deltaY: -50,
        scrollTop: 10,
        scrollHeight: 500,
        clientHeight: 200,
        overflowY: 'auto',
      }),
      'chain',
    )
    assert.equal(
      resolveEmbedWheelAction({
        deltaY: 50,
        scrollTop: 290,
        scrollHeight: 500,
        clientHeight: 200,
        overflowY: 'auto',
      }),
      'chain',
    )
  })

  it('sizes the choose menu window for PWA install dialog clearance', () => {
    const desktop = { availWidth: 1920, availHeight: 1080 }
    const m = chooseMenuWindowMetrics(desktop)
    assert.equal(m.width, POPUP_INSTALL_DIALOG_MIN_WIDTH)
    assert.equal(m.height, POPUP_INSTALL_DIALOG_MIN_HEIGHT)
    assert.ok(m.width >= CHOOSE_MENU_WIDTH)
    assert.ok(m.height >= CHOOSE_MENU_HEIGHT)
    assert.equal(m.left, Math.round((1920 - POPUP_INSTALL_DIALOG_MIN_WIDTH) / 2))
    assert.equal(m.top, Math.round((1080 - POPUP_INSTALL_DIALOG_MIN_HEIGHT) / 2))
  })

  it('picks mode-specific popup window metrics from chessObj', () => {
    const desktop = { availWidth: 1920, availHeight: 1080 }
    assert.equal(windowMetricsForChessObj({ showStartMenu: true }, desktop).width, POPUP_INSTALL_DIALOG_MIN_WIDTH)
    // Puzzle board tracks ~55% of the shorter screen side (capped), plus container padding.
    assert.equal(windowMetricsForChessObj({ format: 'PUZZLE' }, desktop).width, 618)
    assert.equal(windowMetricsForChessObj({ format: 'FEN' }, desktop).width, 464)
    assert.ok(windowMetricsForChessObj({ format: 'PGN' }, desktop).width > 800)
  })

  it('opens chess popups with full browser chrome for address-bar PWA install', () => {
    const features = popupWindowFeaturesString({ width: 640, height: 720, left: 40, top: 32 })
    assert.match(features, /^width=640,height=720/)
    assert.doesNotMatch(features, /\bpopup=yes\b/)
  })

  it('maps leaderboard pages to a wider list view size', () => {
    const desktop = { availWidth: 1920, availHeight: 1080 }
    const m = windowMetricsForPage('leaderboard', desktop)
    assert.equal(m.width, LEADERBOARD_VIEW_WIDTH)
    assert.equal(m.height, LEADERBOARD_VIEW_HEIGHT)
    assert.ok(m.width > LIST_VIEW_WIDTH)
    assert.ok(m.height > LIST_VIEW_HEIGHT)
  })

  it('maps survey list pages to the list view size', () => {
    const desktop = { availWidth: 1920, availHeight: 1080 }
    const m = windowMetricsForChessObj({ format: 'SURVEY', gameType: 'survey' }, desktop)
    assert.equal(m.width, LIST_VIEW_WIDTH)
    assert.equal(m.height, LIST_VIEW_HEIGHT)
  })

  it('reserves a positive puzzle popup chrome estimate', () => {
    assert.ok(POPUP_PUZZLE_CONTENT_CHROME_EST > 0)
    assert.ok(POPUP_PUZZLE_BELOW_CHROME_BUDGET > 0)
    assert.ok(POPUP_PUZZLE_BELOW_CHROME_BUDGET <= POPUP_PUZZLE_CONTENT_CHROME_EST + 40)
  })

  it('targets at least 42px squares when the board floor can apply', () => {
    assert.equal(BOARD_SQUARE_MIN_PX, 42)
    assert.equal(POPUP_PWA_BOARD_MIN, BOARD_SQUARE_MIN_PX * 8)
  })

  it('prefers column width for the PUZZLE board when height room allows', () => {
    // Arrange: tall window leftover height would have crushed the board against a
    // full button stack; width room is the real target.
    const widthCap = 520
    const heightCap = 700

    // Act
    const cap = puzzleBoardCapPx({ widthCap, heightCap, maxCap: 1024 })

    // Assert: fill the column (board is the primary surface).
    assert.equal(cap, widthCap)
  })

  it('soft-limits the PUZZLE board only when the window is shorter than the square', () => {
    const widthCap = 520
    const heightCap = 300

    const cap = puzzleBoardCapPx({ widthCap, heightCap, maxCap: 1024 })

    assert.equal(cap, heightCap)
    assert.ok(cap < widthCap)
  })

  it('does not force PUZZLE minFloor above a short heightCap', () => {
    const cap = puzzleBoardCapPx({
      widthCap: 500,
      heightCap: 200,
      maxCap: 1024,
      minFloor: POPUP_PWA_BOARD_MIN,
    })
    assert.equal(cap, 200)
    assert.ok(cap < POPUP_PWA_BOARD_MIN)
  })

  it('does not shrink play popups below metrics height when content measures short', () => {
    const metricsHeight = windowMetricsForPage('puzzle', { availWidth: 1920, availHeight: 1080 }).height
    // Empty/hidden puzzle page used to measure ~banner-tall and crush the window.
    assert.equal(clampPwaPlayWindowHeight(120, metricsHeight), metricsHeight)
    assert.equal(clampPwaPlayWindowHeight(metricsHeight + 80, metricsHeight), metricsHeight + 80)
    assert.equal(clampPwaPlayWindowHeight(NaN, metricsHeight), metricsHeight)
  })

  it('skips modal window restore when play-window sizing already owns the outer size', () => {
    // Filter confirm → puzzle calls fitPwaPlayWindow in the same turn; restoring the
    // choose-menu snapshot first then growing shakes the PWA.
    assert.equal(shouldSkipPwaModalWindowRestore({ playWindowPending: true }), true)
    assert.equal(shouldSkipPwaModalWindowRestore({ playWindowSizing: true }), true)
    assert.equal(shouldSkipPwaModalWindowRestore({ windowSizingHidden: true }), true)
    assert.equal(shouldSkipPwaModalWindowRestore({}), false)
  })

  it('skips no-op popup resizeTo within slack so resize storms cannot re-enter board fit', () => {
    assert.equal(
      popupOuterSizeUnchanged(800, 900, { outerWidth: 800, outerHeight: 900 }),
      true,
    )
    assert.equal(
      popupOuterSizeUnchanged(810, 900, { outerWidth: 800, outerHeight: 900, slack: 12 }),
      true,
    )
    assert.equal(
      popupOuterSizeUnchanged(820, 900, { outerWidth: 800, outerHeight: 900, slack: 12 }),
      false,
    )
  })

  it('shrinks the POSITION board below width when the window is short', () => {
    // Arrange: column would allow 440px, but only ~200px of viewport height remains.
    const widthCap = POPUP_POSITION_BOARD_CAP
    const heightCap = 200

    // Act
    const cap = positionBoardCapPx({ widthCap, heightCap })

    // Assert: height wins; never force POPUP_PWA_BOARD_MIN above heightCap.
    assert.equal(cap, heightCap)
    assert.ok(cap < widthCap)
    assert.ok(cap < POPUP_PWA_BOARD_MIN)
  })

  it('keeps the POSITION board at the comfort ceiling when space allows', () => {
    const cap = positionBoardCapPx({
      widthCap: 600,
      heightCap: 700,
      maxCap: POPUP_POSITION_BOARD_CAP,
    })
    assert.equal(cap, POPUP_POSITION_BOARD_CAP)
  })

  it('exposes typed shellTransport methods', () => {
    assert.equal(typeof shellTransport.getState, 'function')
    assert.equal(typeof shellTransport.buildLeaderboard, 'function')
    assert.equal(typeof shellTransport.positionChanged, 'function')
    assert.equal(typeof shellTransport.stateExported, 'function')
    assert.equal(typeof shellTransport.realtimePresence, 'function')
  })

  it('enriches outbound messages with itemId and pageKey', () => {
    const enriched = enrichTransport(
      { action: MSG.POSITION_CHANGED, text: '1. e4' },
      { itemId: 'abc', pageKey: 'my-game' },
    )
    assert.equal(enriched.itemId, 'abc')
    assert.equal(enriched.pageKey, 'my-game')
  })

  it('does not attach pageKey to ghost title updates', () => {
    const enriched = enrichTransport(
      { action: MSG.UPDATE_GHOST_PAGE_TITLE, title: 'New Game' },
      { itemId: 'abc', pageKey: 'my-game' },
    )
    assert.equal(enriched.itemId, 'abc')
    assert.equal(enriched.pageKey, undefined)
  })

  it('createShellMessenger forwards typed calls to postToShell', () => {
    const sent = []
    const wiki = createShellMessenger(msg => sent.push(msg))
    wiki.getState()
    wiki.positionChanged({ text: 'GAME', fen: null })
    wiki.pwaInstalled({ installed: true })
    wiki.embedWheelScroll({ deltaY: 1, deltaX: 0 })
    wiki.createPreview({ kind: 'game' })
    wiki.fetchPuzzlePages({ requestId: 'p1', slugs: ['the-fork'] })
    assert.deepEqual(sent[0], { action: MSG.GET_STATE })
    assert.equal(sent[1].action, MSG.POSITION_CHANGED)
    assert.equal(sent[1].text, 'GAME')
    assert.deepEqual(sent[2], { action: MSG.PWA_INSTALLED, installed: true })
    assert.deepEqual(sent[3], { action: MSG.EMBED_WHEEL_SCROLL, deltaY: 1, deltaX: 0 })
    assert.deepEqual(sent[4], { action: MSG.CREATE_PREVIEW, kind: 'game' })
    assert.deepEqual(sent[5], {
      action: MSG.FETCH_PUZZLE_PAGES,
      requestId: 'p1',
      slugs: ['the-fork'],
    })
  })

  it('shellMessengerFromContext prefers ctx.wiki over postToShell fallback', () => {
    const direct = { remoteWatch: () => 'direct' }
    const sent = []
    assert.equal(shellMessengerFromContext({ wiki: direct })?.remoteWatch(), 'direct')
    shellMessengerFromContext({ postToShell: msg => sent.push(msg) })?.remoteWatch({ host: 'x' })
    assert.deepEqual(sent[0], { action: MSG.REMOTE_WATCH, host: 'x' })
    assert.equal(shellMessengerFromContext(null), null)
    assert.equal(shellMessengerFromContext({}), null)
  })

  it('detects local-only PWA bridge sessions', () => {
    assert.equal(
      isPwaJournallessSession({
        pwaBridgeActive: true,
        pwaJournalless: true,
        pwaChessItemPending: false,
      }),
      true,
    )
    assert.equal(
      isPwaJournallessSession({
        pwaBridgeActive: true,
        pwaJournalless: true,
        pwaChessItemPending: true,
      }),
      false,
    )
  })

  it('shows the local-only halo only for unsigned PWA sessions', () => {
    assert.equal(
      showLocalOnlyHalo({
        isStandalone: true,
        isPwaJournalless: true,
        sessionResolved: true,
        canJournal: false,
      }),
      true,
    )
    assert.equal(
      showLocalOnlyHalo({
        isStandalone: true,
        isPwaJournalless: true,
        sessionResolved: true,
        canJournal: true,
      }),
      false,
    )
    assert.equal(
      showLocalOnlyHalo({
        isStandalone: true,
        isPwaJournalless: true,
        sessionResolved: false,
        canJournal: false,
      }),
      false,
    )
  })

  it('matches installed chess PWA by manifest URL or start_url id', () => {
    const origin = 'http://frank.localhost:3001'
    assert.equal(matchInstalledChessPwa([], { origin }), false)
    assert.equal(
      matchInstalledChessPwa([{ platform: 'webapp', url: `${origin}/plugins/chess/manifest.webmanifest` }], { origin }),
      true,
    )
    assert.equal(matchInstalledChessPwa([{ platform: 'webapp', id: '/plugins/chess/index.html' }], { origin }), true)
    assert.equal(
      matchInstalledChessPwa([{ platform: 'webapp', url: `${origin}/plugins/chess/manifest.json` }], { origin }),
      true,
    )
    assert.equal(
      matchInstalledChessPwa([{ platform: 'webapp', url: 'https://other.test/manifest.webmanifest' }], {
        origin,
      }),
      false,
    )
  })

  it('detects document reload navigation', () => {
    assert.equal(typeof isPwaDocumentReload(), 'boolean')
  })

  it('computes PWA outer height for modal content capped to screen', () => {
    const desktop = { availWidth: 1920, availHeight: 1080 }
    const outer = pwaOuterHeightForModalContent(620, { screen: desktop })
    assert.ok(outer > 620)
    assert.ok(outer <= 1080 - 24)
  })

  it('computes PWA outer width for modal panel with minimum floor', () => {
    const desktop = { availWidth: 1920, availHeight: 1080 }
    const panel = { getBoundingClientRect: () => ({ width: 448 }) }
    const outer = pwaOuterWidthForModalPanel(panel, { screen: desktop })
    assert.ok(outer >= 360)
    assert.ok(outer <= 1920 - 24)
  })

  it('resolveBootIntent maps runtime flags to boot modes', () => {
    assert.equal(resolveBootIntent({ hasWikiFrame: true, isWikiPopup: true, isPwaStandalone: false }), 'WikiPopup')
    assert.equal(resolveBootIntent({ hasWikiFrame: true, isWikiPopup: false, isPwaStandalone: false }), 'Embed')
    assert.equal(resolveBootIntent({ hasWikiFrame: false, isWikiPopup: false, isPwaStandalone: true }), 'InstalledPwa')
    assert.equal(resolveBootIntent({ hasWikiFrame: false, isWikiPopup: false, isPwaStandalone: false }), 'DirectTab')
  })

  it('shows PWA page chrome for local-only sessions via isPwaJournalless host', () => {
    const mkEl = (extra = {}) => ({
      hidden: false,
      value: '',
      disabled: false,
      textContent: '',
      title: '',
      href: '',
      dataset: {},
      classList: {
        _classes: new Set(),
        contains: name => extra._classes?.has(name) ?? false,
        add: name => extra._classes?.add(name),
        remove: name => extra._classes?.delete(name),
        toggle: (name, on) => {
          if (on === undefined) {
            extra._classes?.has(name) ? extra._classes.delete(name) : extra._classes.add(name)
          } else if (on) extra._classes?.add(name)
          else extra._classes?.delete(name)
        },
      },
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
      ...extra,
    })
    const elements = {
      wikiChessPwaPageChromePage: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageChrome: mkEl({ _classes: new Set() }),
      wikiChessPwaPageTitle: mkEl({ _classes: new Set() }),
      wikiChessPwaPageTitleLink: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageLead: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageActions: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaSaveToWikiBtn: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageStatus: mkEl({ hidden: true, _classes: new Set(), dataset: {} }),
    }
    let haloSynced = false
    initPwaPageChrome({
      chessState: { showStartMenu: false, pwaWikiPageChrome: true },
      pwaBridgeActive: true,
      pwaSessionResolved: true,
      pwaSessionReachable: true,
      isPwaJournalless: () => true,
      canWriteJournalHere: () => false,
      syncLocalOnlyHalo: () => {
        haloSynced = true
      },
    })
    const origDoc = globalThis.document
    globalThis.document = { getElementById: id => elements[id] || null }
    try {
      updatePwaPageChrome()
      assert.equal(elements.wikiChessPwaPageChromePage.hidden, false)
      assert.equal(elements.wikiChessPwaPageTitle.hidden, false)
      assert.equal(elements.wikiChessPwaPageTitleLink.hidden, true)
      assert.equal(elements.wikiChessPwaPageStatus.dataset.pwaStatus, 'local-only')
      assert.match(elements.wikiChessPwaPageStatus.textContent, /Not signed in/)
      assert.equal(haloSynced, true)
    } finally {
      globalThis.document = origDoc
    }
  })

  it('local-only PWA status distinguishes signed-in-but-unsaved from unsigned', () => {
    const status = {
      hidden: true,
      textContent: '',
      dataset: {},
      classList: {
        _classes: new Set(),
        add(name) {
          this._classes.add(name)
        },
        remove(name) {
          this._classes.delete(name)
        },
      },
    }
    const origDoc = globalThis.document
    globalThis.document = { getElementById: id => (id === 'wikiChessPwaPageStatus' ? status : null) }
    try {
      updatePwaPageChromeStatus('local-only', null, '', { canWrite: false })
      assert.match(status.textContent, /Not signed in/)
      updatePwaPageChromeStatus('local-only', null, '', { canWrite: true })
      assert.match(status.textContent, /Not on a wiki yet/)
    } finally {
      globalThis.document = origDoc
    }
  })

  it('shows PWA page title as a wiki link for signed-in journal targets', () => {
    const mkEl = (extra = {}) => ({
      hidden: false,
      value: '',
      disabled: false,
      textContent: '',
      title: '',
      href: '',
      dataset: {},
      classList: {
        _classes: new Set(),
        contains: name => extra._classes?.has(name) ?? false,
        add: name => extra._classes?.add(name),
        remove: name => extra._classes?.delete(name),
        toggle: (name, on) => {
          if (on === undefined) {
            extra._classes?.has(name) ? extra._classes.delete(name) : extra._classes.add(name)
          } else if (on) extra._classes?.add(name)
          else extra._classes?.delete(name)
        },
      },
      setAttribute: () => {},
      removeAttribute: name => {
        if (name === 'href') extra.href = ''
      },
      addEventListener: () => {},
      ...extra,
    })
    const elements = {
      wikiChessPwaPageChromePage: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageChrome: mkEl({ _classes: new Set() }),
      wikiChessPwaPageTitle: mkEl({ _classes: new Set() }),
      wikiChessPwaPageTitleLink: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageLead: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageActions: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaSaveToWikiBtn: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageStatus: mkEl({ hidden: true, _classes: new Set(), dataset: {} }),
    }
    initPwaPageChrome({
      chessState: {
        showStartMenu: false,
        pwaWikiPageChrome: true,
        wikiPageTitle: 'Welcome Visitors',
        wikiPageName: 'welcome-visitors',
        wikiSite: 'olga.localhost:3001',
      },
      pwaBridgeActive: true,
      pwaSessionResolved: true,
      pwaSessionReachable: true,
      isPwaJournalless: () => false,
      canWriteJournalHere: () => true,
      getPwaWikiContext: () => ({ slug: 'welcome-visitors', itemId: 'abc', title: 'Welcome Visitors' }),
      syncLocalOnlyHalo: () => {},
    })
    const origDoc = globalThis.document
    const origLoc = globalThis.location
    globalThis.document = { getElementById: id => elements[id] || null }
    globalThis.location = { host: 'olga.localhost:3001' }
    try {
      updatePwaPageChrome()
      assert.equal(elements.wikiChessPwaPageChromePage.hidden, false)
      assert.equal(elements.wikiChessPwaPageTitle.hidden, true)
      assert.equal(elements.wikiChessPwaPageTitleLink.hidden, false)
      assert.equal(elements.wikiChessPwaPageTitleLink.textContent, 'Welcome Visitors')
      assert.match(elements.wikiChessPwaPageTitleLink.href, /welcome-visitors\.html$/)
      assert.equal(elements.wikiChessPwaPageStatus.dataset.pwaStatus, 'journaling')
    } finally {
      globalThis.document = origDoc
      globalThis.location = origLoc
    }
  })

  it('does not claim Saved or show a title link without a wiki page slug', () => {
    const mkEl = (extra = {}) => ({
      hidden: false,
      value: '',
      disabled: false,
      textContent: '',
      title: '',
      href: '',
      dataset: {},
      classList: {
        _classes: new Set(),
        contains: name => extra._classes?.has(name) ?? false,
        add: name => extra._classes?.add(name),
        remove: name => extra._classes?.delete(name),
        toggle: (name, on) => {
          if (on === undefined) {
            extra._classes?.has(name) ? extra._classes.delete(name) : extra._classes.add(name)
          } else if (on) extra._classes?.add(name)
          else extra._classes?.delete(name)
        },
      },
      setAttribute: () => {},
      removeAttribute: name => {
        if (name === 'href') extra.href = ''
      },
      addEventListener: () => {},
      ...extra,
    })
    const elements = {
      wikiChessPwaPageChromePage: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageChrome: mkEl({ _classes: new Set() }),
      wikiChessPwaPageTitle: mkEl({ _classes: new Set() }),
      wikiChessPwaPageTitleLink: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageLead: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageActions: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaSaveToWikiBtn: mkEl({ hidden: true, _classes: new Set() }),
      wikiChessPwaPageStatus: mkEl({ hidden: true, _classes: new Set(), dataset: {} }),
    }
    initPwaPageChrome({
      chessState: {
        showStartMenu: false,
        pwaWikiPageChrome: true,
        wikiPageTitle: 'New Chess Position',
      },
      pwaBridgeActive: true,
      pwaSessionResolved: true,
      pwaSessionReachable: true,
      isPwaJournalless: () => false,
      canWriteJournalHere: () => true,
      getPwaWikiContext: () => ({ slug: null, itemId: null, title: null }),
      syncLocalOnlyHalo: () => {},
    })
    const origDoc = globalThis.document
    globalThis.document = { getElementById: id => elements[id] || null }
    try {
      updatePwaPageChrome()
      assert.equal(elements.wikiChessPwaPageChromePage.hidden, false)
      assert.equal(elements.wikiChessPwaPageTitle.hidden, false)
      assert.equal(elements.wikiChessPwaPageTitleLink.hidden, true)
      assert.equal(elements.wikiChessPwaPageStatus.dataset.pwaStatus || '', '')
    } finally {
      globalThis.document = origDoc
    }
  })

  it('shouldTransitionPwaStatus blocks overwrite of error and creating states', () => {
    assert.equal(shouldTransitionPwaStatus('', 'creating'), true)
    assert.equal(shouldTransitionPwaStatus('creating', 'creating'), false)
    assert.equal(shouldTransitionPwaStatus('error', 'creating'), false)
    assert.equal(shouldTransitionPwaStatus('', 'saved'), true)
    assert.equal(shouldTransitionPwaStatus('creating', 'saved'), false)
    assert.equal(shouldTransitionPwaStatus('error', 'saved'), false)
    assert.equal(shouldTransitionPwaStatus('saved', 'saved'), false)
    assert.equal(shouldTransitionPwaStatus('', 'journaling'), true)
    assert.equal(shouldTransitionPwaStatus('saved', 'journaling'), false)
    assert.equal(shouldTransitionPwaStatus('creating', 'journaling'), false)
  })

  it('readPwaPageChromeStatus reads data-pwa-status', () => {
    assert.equal(readPwaPageChromeStatus({ dataset: { pwaStatus: 'saved' } }), 'saved')
    assert.equal(readPwaPageChromeStatus(null), '')
  })

  it('clearPwaPageChromeStatus resets sticky saved status for page switches', () => {
    const status = {
      hidden: false,
      textContent: 'Saved on your wiki as “New Chess Position”.',
      dataset: { pwaStatus: 'saved' },
      classList: {
        _classes: new Set(['is-saved']),
        remove: (...names) => names.forEach(n => status.classList._classes.delete(n)),
      },
    }
    const origDoc = globalThis.document
    globalThis.document = { getElementById: id => (id === 'wikiChessPwaPageStatus' ? status : null) }
    try {
      clearPwaPageChromeStatus()
      assert.equal(status.hidden, true)
      assert.equal(status.dataset.pwaStatus, '')
      assert.equal(status.textContent, '')
      assert.equal(shouldTransitionPwaStatus(readPwaPageChromeStatus(status), 'journaling'), true)
    } finally {
      globalThis.document = origDoc
    }
  })

  it('popup session handoff writes sessionStorage under pwaStoragePrefix (not localStorage SSOT)', () => {
    const store = new Map()
    const memoryStorage = {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        store.set(String(key), String(value))
      },
      removeItem: key => {
        store.delete(String(key))
      },
    }
    const origLocal = globalThis.localStorage
    const origSession = globalThis.sessionStorage
    const origLocation = globalThis.location
    globalThis.localStorage = memoryStorage
    globalThis.sessionStorage = memoryStorage
    globalThis.location = { search: '?itemId=abc123&pageKey=ephemeral-key' }

    try {
      const pgn = '[Event "?"]\n\n1. e4 e5 2. Nf3 Nc6 *'
      rememberPopupState({
        format: 'PGN',
        PGN: pgn,
        chessState: pgn,
        itemId: 'abc123',
        mode: 'GAME',
      })
      const key = 'WikiChess-ephemeral-key-abc123PopupState'
      assert.equal(store.has(key), true)
      assert.equal(store.has('WikiChess-playSnapshot-abc123'), false)
      const saved = JSON.parse(store.get(key))
      assert.equal(saved.PGN, pgn)
    } finally {
      globalThis.localStorage = origLocal
      globalThis.sessionStorage = origSession
      globalThis.location = origLocation
    }
  })
})
