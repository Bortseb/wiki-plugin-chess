/**
 * Board layout, embed sizing, paste capture, PWA/popup lifecycle, and wiki transport.
 * Inlined into both chess.js (shell) and chess-app.js (app bundles).
 *
 * §1 Embed wheel routing + popup metrics
 * §2 Board fit / resize
 * §3 Paste capture
 * §4 PWA session, page title chrome, HTTP bridge
 * §5 WikiTransport (typed postMessage / PWA dispatch)
 */

import {
  MSG,
  Paste,
  getFormat,
  isUnseatedFreshGamePgn,
  normalizeRestoredChessSession,
  localSessionUiPolicy,
  openChallengeAcceptParagraph,
  wikiSitePageUrl,
  normalizeWikiSite,
  isLoopbackWikiHost,
} from './chess-core.js'

// # PWA Detection and Install

// Installed-PWA HTTP bridge base path (journal, session, federation).
export const PWA_BRIDGE_BASE = '/plugin/chess/pwa'

// True when running as an installed PWA (iOS home screen or display-mode standalone/fullscreen).
export function isInstalledPwa() {
  return (
    window.navigator.standalone === true ||
    ['standalone', 'fullscreen'].some(m => window.matchMedia(`(display-mode: ${m})`).matches)
  )
}

// True when getInstalledRelatedApps lists this site's chess PWA manifest.
export function matchInstalledChessPwa(apps, { origin } = {}) {
  if (!Array.isArray(apps)) return false
  const pageOrigin = origin || (typeof location !== 'undefined' ? location.origin : '')
  if (!pageOrigin) return false
  const startIdAbsolute = `${pageOrigin}/plugins/chess/index.html`
  const startIdPath = '/plugins/chess/index.html'
  return apps.some(app => {
    if (app.platform !== 'webapp') return false
    const url = String(app.url || '')
    const id = String(app.id || '')
    return (
      url.includes('/plugins/chess/manifest.webmanifest') ||
      url.includes('/plugins/chess/manifest.json') ||
      id === startIdAbsolute ||
      id === startIdPath
    )
  })
}

export const CHESS_PWA_INSTALLED_FLAG_PREFIX = 'wiki-chess-pwa-installed:'

// IndexedDB-backed UI prefs bridge (set from chess-app via initUiPrefsBridge).
let uiPrefsBridge = {
  isPwaInstalled: () => false,
  markPwaInstalled: () => {},
  isHideInstallNudge: () => false,
  setHideInstallNudge: () => {},
}

export function initUiPrefsBridge(bridge = {}) {
  uiPrefsBridge = { ...uiPrefsBridge, ...bridge }
}

export function chessPwaInstalledFlagKey(origin = location.origin) {
  return `${CHESS_PWA_INSTALLED_FLAG_PREFIX}${origin}`
}

export function markChessPwaInstalled(origin = location.origin) {
  try {
    uiPrefsBridge.markPwaInstalled(origin)
  } catch {
    /* prefs unavailable */
  }
}

export function isChessPwaInstalledLocally(origin = location.origin) {
  try {
    return Boolean(uiPrefsBridge.isPwaInstalled(origin))
  } catch {
    return false
  }
}

function hideInstallNudgeElement(installNudge = document.getElementById('install-nudge')) {
  if (installNudge) installNudge.style.display = 'none'
}

// True when this origin's chess PWA is installed (local flag, URL hint, or related-apps API).
export async function queryChessPwaInstalled() {
  if (isInstalledPwa()) {
    markChessPwaInstalled()
    return true
  }
  if (isChessPwaInstalledLocally()) return true
  const params = new URLSearchParams(location.search)
  if (params.get('chessPwa') === '1') {
    markChessPwaInstalled()
    return true
  }
  if (typeof navigator.getInstalledRelatedApps !== 'function') return false
  try {
    const apps = await navigator.getInstalledRelatedApps()
    if (matchInstalledChessPwa(apps)) {
      markChessPwaInstalled()
      return true
    }
  } catch {
    /* API unavailable or blocked */
  }
  return false
}

// Popup / direct-tab install banner — hidden automatically once the PWA is installed.
export function initInstallNudge() {
  if (typeof window === 'undefined' || window.parent !== window.self) return
  if (isInstalledPwa()) {
    markChessPwaInstalled()
    hideInstallNudgeElement()
    return
  }
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    hideInstallNudgeElement()
    return
  }

  const installNudge = document.getElementById('install-nudge')
  if (!installNudge) return

  const refresh = async () => {
    if (await queryChessPwaInstalled()) {
      hideInstallNudgeElement(installNudge)
      return
    }
    try {
      if (uiPrefsBridge.isHideInstallNudge()) {
        hideInstallNudgeElement(installNudge)
        return
      }
    } catch {
      /* prefs unavailable */
    }
    installNudge.style.display = 'block'
  }

  void refresh()

  if (installNudge._wikiInstallWatch) return
  installNudge._wikiInstallWatch = true

  window.addEventListener('appinstalled', () => {
    markChessPwaInstalled()
    hideInstallNudgeElement(installNudge)
  })
  window.addEventListener('focus', () => {
    void refresh()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
  window.addEventListener('storage', event => {
    if (event.key === chessPwaInstalledFlagKey() && event.newValue === 'true') {
      hideInstallNudgeElement(installNudge)
    }
  })
  for (const delayMs of [500, 1500, 4000, 10000]) {
    window.setTimeout(() => {
      void refresh()
    }, delayMs)
  }
  document.getElementById('close-button')?.addEventListener('click', () => {
    try {
      uiPrefsBridge.setHideInstallNudge(true)
    } catch {
      /* prefs unavailable */
    }
    hideInstallNudgeElement(installNudge)
  })
}

// Register the chess PWA service worker (idempotent).
export function registerChessServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  if (ensurePwaProtocol()) return Promise.resolve(null)
  return navigator.serviceWorker
    .register('/plugins/chess/service-worker.js', { scope: '/plugins/chess/' })
    .catch(err => {
      console.warn('wiki-chess: service worker registration failed', err)
      return null
    })
}

// Downgrade https→http on farm dev hosts; upgrade http→https elsewhere.
// Returns true when a navigation was triggered (caller should stop boot).
export function ensurePwaProtocol({
  hostname = location.hostname,
  protocol = location.protocol,
  href = location.href,
  isEmbed = window.parent !== window.self,
} = {}) {
  if (isEmbed) return false
  if (isLoopbackWikiHost(hostname) && protocol === 'https:') {
    location.replace(href.replace(/^https:/i, 'http:'))
    return true
  }
  if (!isLoopbackWikiHost(hostname) && protocol === 'http:') {
    location.protocol = 'https:'
    return true
  }
  return false
}

import {
  openPasteConfirmModal,
  registerMountRestore,
  restoreEmbeddedMount,
  registerBodyDialogOverlay,
  registerModalPwaWindowHandlers,
  suspendForStacking,
  installAuthGatedClickGuard,
  setAuthGatedButton,
  clearViewportBlockingModals,
} from './modals.js'

// Restore PUZZLE popup/PWA URLs without importing app-only puzzle.js into the shell bundle.
function puzzleStateFromUrl(options = {}) {
  const params = new URLSearchParams(location.search)
  if (!params.has('puzzle')) return null
  const directive = (params.get('puzzle') || '').trim()
  const chessState = directive && /^PUZZLE\b/i.test(directive) ? directive : 'PUZZLE'
  return {
    format: 'PUZZLE',
    mode: 'PUZZLE',
    gameType: 'puzzle',
    chessState,
    showStartMenu: false,
    ...options,
  }
}

// Comfort ceiling for the board in popup / PWA (px). This is just a sanity cap for the
// extreme case — the real limiters in computePopupBoardCap() are the height-aware cap
// (keeps the move controls / banner on-screen) and, in the wide columns layout, the
// width-aware cap (keeps the History & Captured panel beside the board). Those let the
// board grow to fill the user's window when there is room.
//
// The ceiling scales with the monitor so the UI stays responsive on large/4K displays
// (where a fixed 1024 left the board marooned in a corner of an otherwise empty screen):
// it tracks the screen's shorter side but never goes below the original 1024 comfort cap.
// # Embed Wheel and Popup Metrics

// Pure wheel-routing decisions for wiki-embed scroll chaining.

// Browser zoom uses Ctrl/Cmd + wheel; embed scroll chaining must not intercept.
export function isBrowserZoomWheel(event) {
  return Boolean(event?.ctrlKey || event?.metaKey)
}

// Returns 'consume' | 'chain' | 'forward'.
export function resolveEmbedWheelAction({
  deltaY,
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  overflowY = 'visible',
} = {}) {
  if (!deltaY) return 'forward'

  const canScroll =
    (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && scrollHeight - clientHeight > 0
  if (!canScroll) return 'forward'

  const maxScroll = scrollHeight - clientHeight
  const next = scrollTop + deltaY
  if (next > 0 && next < maxScroll) return 'consume'
  return 'chain'
}

// ## Popup and PWA Window Sizes
// Used by board-layout.js (runtime resize) and chess.js (window.open). Runtime board
// fitting stays in board-layout.js.

// Prefer squares at least this wide (px) when the viewport has room.
export const BOARD_SQUARE_MIN_PX = 42
// Board floor (px) for 8×BOARD_SQUARE_MIN_PX — never forced above available height/width.
export const POPUP_PWA_BOARD_MIN = BOARD_SQUARE_MIN_PX * 8
// Puzzle popup below-board chrome estimate (controls, rating bar) — see board-layout.js
export const POPUP_PUZZLE_CONTENT_CHROME_EST = 160
// Max vertical reserve (px) for puzzle controls below the board when soft height-capping. Excess scrolls.
export const POPUP_PUZZLE_BELOW_CHROME_BUDGET = 160
// Position popup below-board chrome estimate (hint, conditions card, action buttons).
export const POPUP_POSITION_CONTENT_CHROME_EST = 300
// Max vertical reserve (px) for stacked position chrome below the board. Excess scrolls.
export const POPUP_POSITION_BELOW_CHROME_BUDGET = 120
// Comfort ceiling for the POSITION board (matches LAYOUT.popupPositionBoardCap).
export const POPUP_POSITION_BOARD_CAP = 440

// Pure POSITION board cap (square px). Prefer fitting the viewport height over a
// minimum floor — installed PWAs often cannot resizeTo, so a floor larger than
// heightCap would clip the board.
export function positionBoardCapPx({
  widthCap = 0,
  heightCap = 0,
  maxCap = POPUP_POSITION_BOARD_CAP,
  minFloor = POPUP_PWA_BOARD_MIN,
} = {}) {
  const w = Math.max(0, Number(widthCap) || 0)
  const h = Math.max(0, Number(heightCap) || 0)
  const max = Math.max(0, Number(maxCap) || 0)
  const bounded = Math.min(w, h, max)
  const floor = Math.min(Math.max(0, Number(minFloor) || 0), h)
  return Math.max(floor, Math.round(bounded))
}

// Pure PUZZLE board cap (square px). Prefer filling the column width — the board is
// the primary surface. Height only soft-limits when the remaining viewport is shorter
// than that square; never force minFloor above heightCap (short PWAs may not resizeTo).
export function puzzleBoardCapPx({
  widthCap = 0,
  heightCap = 0,
  maxCap = Infinity,
  minFloor = POPUP_PWA_BOARD_MIN,
} = {}) {
  const w = Math.max(0, Number(widthCap) || 0)
  const h = Math.max(0, Number(heightCap) || 0)
  const maxRaw = Number(maxCap)
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : Infinity
  const preferred = Math.min(w, max)
  if (h <= 0 || h >= preferred) {
    return Math.max(Math.max(0, Number(minFloor) || 0), Math.round(preferred))
  }
  const floor = Math.min(Math.max(0, Number(minFloor) || 0), h)
  return Math.max(floor, Math.round(Math.min(preferred, h)))
}

const LAYOUT = {
  // Side panel (210) + board comfort (352) + controls chrome (48) + board floor (336) = 946.
  // Keep in sync with @media (min-width: …) in wiki-chess.css and POPUP_COLUMNS_BREAKPOINT_PX.
  popupColumnsBreakpointPx: 946,
  popupSidePanelMin: 210,
  popupColumnGap: 12,
  popupContainerPadding: 24,
  popupScrollbarSlack: 24,
  popupScreenMargin: 24,
  popupMinAvailWidth: 360,
  popupMinAvailHeight: 420,
  popupFallbackScreenWidth: 1280,
  popupFallbackScreenHeight: 900,
  popupChromeHeight: 96,
  popupColumnsContentChrome: 280,
  popupNarrowBoardChrome: 200,
  popupBelowFooterChrome: 260,
  popupPuzzleContentChrome: 260,
  popupPuzzleBoardCap: 640,
  popupPuzzleBoardScreenFraction: 0.55,
  popupPositionContentChrome: 420,
  popupPositionBoardCap: 440,
  popupPositionBoardScreenFraction: 0.42,
  popupPositionMaxWidth: 480,
  popupInitialBoardCapWideFloor: 680,
  popupInitialBoardCapWideScreenFraction: 0.5,
  popupInitialBoardCapNarrow: 420,
}

const POPUP_WINDOW_COLUMNS_BREAKPOINT_PX = LAYOUT.popupColumnsBreakpointPx
const POPUP_WINDOW_SIDE_PANEL_MIN = LAYOUT.popupSidePanelMin
const POPUP_WINDOW_COLUMN_GAP = LAYOUT.popupColumnGap
const POPUP_WINDOW_CONTAINER_PADDING = LAYOUT.popupContainerPadding
const POPUP_WINDOW_SCROLLBAR_SLACK = LAYOUT.popupScrollbarSlack
const POPUP_WINDOW_SCREEN_MARGIN = LAYOUT.popupScreenMargin
const POPUP_WINDOW_MIN_AVAIL_WIDTH = LAYOUT.popupMinAvailWidth
const POPUP_WINDOW_MIN_AVAIL_HEIGHT = LAYOUT.popupMinAvailHeight
const POPUP_WINDOW_FALLBACK_SCREEN_WIDTH = LAYOUT.popupFallbackScreenWidth
const POPUP_WINDOW_FALLBACK_SCREEN_HEIGHT = LAYOUT.popupFallbackScreenHeight
const POPUP_WINDOW_CHROME_HEIGHT = LAYOUT.popupChromeHeight
const POPUP_WINDOW_COLUMNS_CONTENT_CHROME = LAYOUT.popupColumnsContentChrome
const POPUP_WINDOW_NARROW_BOARD_CHROME = LAYOUT.popupNarrowBoardChrome
const POPUP_WINDOW_BELOW_FOOTER_CHROME = LAYOUT.popupBelowFooterChrome

export const CHOOSE_MENU_WIDTH = 380
export const CHOOSE_MENU_HEIGHT = 460
// Chrome clips the PWA install dialog when the popup is too small (380×460 was too tight).
export const POPUP_INSTALL_DIALOG_MIN_WIDTH = 520
export const POPUP_INSTALL_DIALOG_MIN_HEIGHT = 640
export const LIST_VIEW_WIDTH = 600
export const LIST_VIEW_HEIGHT = 660
// Leaderboard needs room for metric columns — wider/taller than My Chess Games lists.
//  Stay under the survey.js compact threshold (~1100) so the default window uses short
// headers (Rat / G / W / …) instead of crushing full labels into a fixed-width table.
export const LEADERBOARD_VIEW_WIDTH = 1000
export const LEADERBOARD_VIEW_HEIGHT = 840

const POPUP_WINDOW_PUZZLE_CONTENT_CHROME = LAYOUT.popupPuzzleContentChrome
const POPUP_WINDOW_PUZZLE_BOARD_CAP = LAYOUT.popupPuzzleBoardCap
const POPUP_WINDOW_PUZZLE_BOARD_SCREEN_FRACTION = LAYOUT.popupPuzzleBoardScreenFraction
const POPUP_WINDOW_POSITION_CONTENT_CHROME = LAYOUT.popupPositionContentChrome
const POPUP_WINDOW_POSITION_BOARD_CAP = LAYOUT.popupPositionBoardCap
const POPUP_WINDOW_POSITION_BOARD_SCREEN_FRACTION = LAYOUT.popupPositionBoardScreenFraction
const POPUP_WINDOW_POSITION_MAX_WIDTH = LAYOUT.popupPositionMaxWidth
const POPUP_WINDOW_INITIAL_BOARD_CAP_WIDE_FLOOR = LAYOUT.popupInitialBoardCapWideFloor
const POPUP_WINDOW_INITIAL_BOARD_CAP_WIDE_SCREEN_FRACTION = LAYOUT.popupInitialBoardCapWideScreenFraction
const POPUP_WINDOW_INITIAL_BOARD_CAP_NARROW = LAYOUT.popupInitialBoardCapNarrow

function popupWindowAvailSize(screen = null) {
  const availW = Math.max(
    POPUP_WINDOW_MIN_AVAIL_WIDTH,
    (screen?.availWidth ?? POPUP_WINDOW_FALLBACK_SCREEN_WIDTH) - POPUP_WINDOW_SCREEN_MARGIN,
  )
  const availH = Math.max(
    POPUP_WINDOW_MIN_AVAIL_HEIGHT,
    (screen?.availHeight ?? POPUP_WINDOW_FALLBACK_SCREEN_HEIGHT) - POPUP_WINDOW_SCREEN_MARGIN,
  )
  return { availW, availH }
}

function popupWindowPlacement(width, height, screen) {
  const left = Math.max(0, Math.round(((screen?.availWidth ?? width) - width) / 2))
  const top = Math.max(0, Math.round(((screen?.availHeight ?? height) - height) / 2))
  return { width, height, left, top }
}

export function chooseMenuWindowMetrics(screen) {
  return popupWindowPlacement(
    Math.max(CHOOSE_MENU_WIDTH, POPUP_INSTALL_DIALOG_MIN_WIDTH),
    Math.max(CHOOSE_MENU_HEIGHT, POPUP_INSTALL_DIALOG_MIN_HEIGHT),
    screen,
  )
}

function popupWindowInitialBoardCapWide(screen) {
  const screenMin = Math.min(screen?.availWidth || 0, screen?.availHeight || 0)
  return Math.max(
    POPUP_WINDOW_INITIAL_BOARD_CAP_WIDE_FLOOR,
    Math.round(screenMin * POPUP_WINDOW_INITIAL_BOARD_CAP_WIDE_SCREEN_FRACTION),
  )
}

function popupWindowPuzzleBoardCap(screen) {
  const screenMin = Math.min(screen?.availWidth || 0, screen?.availHeight || 0)
  // Prefer the screen-relative size; the named cap is only a soft ceiling for huge monitors.
  return Math.min(
    POPUP_WINDOW_PUZZLE_BOARD_CAP,
    Math.max(POPUP_PWA_BOARD_MIN, Math.round(screenMin * POPUP_WINDOW_PUZZLE_BOARD_SCREEN_FRACTION)),
  )
}

function popupWindowPositionBoardCap(screen) {
  const screenMin = Math.min(screen?.availWidth || 0, screen?.availHeight || 0)
  return Math.min(
    POPUP_WINDOW_POSITION_BOARD_CAP,
    Math.max(POPUP_PWA_BOARD_MIN, Math.round(screenMin * POPUP_WINDOW_POSITION_BOARD_SCREEN_FRACTION)),
  )
}

export function boardPlayWindowMetrics(screen) {
  const { availW, availH } = popupWindowAvailSize(screen)
  const colsSideTotal = POPUP_WINDOW_SIDE_PANEL_MIN + POPUP_WINDOW_COLUMN_GAP + POPUP_WINDOW_CONTAINER_PADDING
  const minColsOuterW = POPUP_WINDOW_COLUMNS_BREAKPOINT_PX + POPUP_WINDOW_SCROLLBAR_SLACK
  const colsVChrome = POPUP_WINDOW_CHROME_HEIGHT + POPUP_WINDOW_COLUMNS_CONTENT_CHROME
  const canColumns = availW >= minColsOuterW && availH >= colsVChrome + POPUP_PWA_BOARD_MIN
  if (canColumns) {
    const boardByHeight = availH - colsVChrome
    const boardByWidth = availW - colsSideTotal
    let board = Math.min(boardByHeight, boardByWidth, popupWindowInitialBoardCapWide(screen))
    board = Math.max(POPUP_PWA_BOARD_MIN, Math.floor(board))
    const width = Math.min(availW, Math.max(board + colsSideTotal, minColsOuterW))
    const height = Math.min(availH, board + colsVChrome)
    return popupWindowPlacement(width, height, screen)
  }
  const docChrome = POPUP_WINDOW_NARROW_BOARD_CHROME + POPUP_WINDOW_BELOW_FOOTER_CHROME
  const board = Math.max(
    POPUP_PWA_BOARD_MIN,
    Math.floor(
      Math.min(
        availW - POPUP_WINDOW_CONTAINER_PADDING,
        POPUP_WINDOW_INITIAL_BOARD_CAP_NARROW,
        availH - POPUP_WINDOW_CHROME_HEIGHT - docChrome,
      ),
    ),
  )
  const width = Math.min(availW, board + POPUP_WINDOW_CONTAINER_PADDING)
  const height = Math.min(availH, POPUP_WINDOW_CHROME_HEIGHT + docChrome + board)
  return popupWindowPlacement(width, height, screen)
}

export function puzzleWindowMetrics(screen) {
  const { availW, availH } = popupWindowAvailSize(screen)
  const docChrome = POPUP_WINDOW_PUZZLE_CONTENT_CHROME
  const boardCap = popupWindowPuzzleBoardCap(screen)
  const boardByWidth = availW - POPUP_WINDOW_CONTAINER_PADDING
  const boardByHeight = availH - POPUP_WINDOW_CHROME_HEIGHT - docChrome
  let board = Math.max(POPUP_PWA_BOARD_MIN, Math.floor(Math.min(boardCap, boardByWidth, boardByHeight)))
  const width = Math.min(availW, Math.max(board + POPUP_WINDOW_CONTAINER_PADDING, 420))
  board = Math.min(board, width - POPUP_WINDOW_CONTAINER_PADDING)
  const height = Math.min(availH, POPUP_WINDOW_CHROME_HEIGHT + docChrome + board)
  return popupWindowPlacement(width, height, screen)
}

export function positionWindowMetrics(screen) {
  const { availW, availH } = popupWindowAvailSize(screen)
  const docChrome = POPUP_WINDOW_POSITION_CONTENT_CHROME
  const boardCap = popupWindowPositionBoardCap(screen)
  const maxWidth = Math.min(availW, POPUP_WINDOW_POSITION_MAX_WIDTH)
  const boardByWidth = maxWidth - POPUP_WINDOW_CONTAINER_PADDING
  const boardByHeight = availH - POPUP_WINDOW_CHROME_HEIGHT - docChrome
  let board = Math.max(POPUP_PWA_BOARD_MIN, Math.floor(Math.min(boardCap, boardByWidth, boardByHeight)))
  const width = Math.min(maxWidth, Math.max(board + POPUP_WINDOW_CONTAINER_PADDING, 420))
  board = Math.min(board, width - POPUP_WINDOW_CONTAINER_PADDING)
  const height = Math.min(availH, POPUP_WINDOW_CHROME_HEIGHT + docChrome + board)
  return popupWindowPlacement(width, height, screen)
}

export function listWindowMetrics(screen) {
  const { availW, availH } = popupWindowAvailSize(screen)
  const width = Math.min(availW, LIST_VIEW_WIDTH)
  const height = Math.min(availH, LIST_VIEW_HEIGHT)
  return popupWindowPlacement(width, height, screen)
}

export function leaderboardWindowMetrics(screen) {
  const { availW, availH } = popupWindowAvailSize(screen)
  const width = Math.min(availW, LEADERBOARD_VIEW_WIDTH)
  const height = Math.min(availH, LEADERBOARD_VIEW_HEIGHT)
  return popupWindowPlacement(width, height, screen)
}

export function windowMetricsForPage(page, screen) {
  if (page === 'leaderboard') return leaderboardWindowMetrics(screen)
  if (page === 'puzzle' || page === 'puzzle-author') return puzzleWindowMetrics(screen)
  if (page === 'position') return positionWindowMetrics(screen)
  if (page === 'start') return chooseMenuWindowMetrics(screen)
  return boardPlayWindowMetrics(screen)
}

export function windowMetricsForChessObj(chessObj = {}, screen) {
  if (chessObj.showStartMenu || chessObj.format === 'MENU' || chessObj.mode === 'CHOOSE') {
    return chooseMenuWindowMetrics(screen)
  }
  if (chessObj.format === 'PUZZLE' || chessObj.gameType === 'puzzle' || chessObj.mode === 'PUZZLE') {
    return puzzleWindowMetrics(screen)
  }
  if (chessObj.format === 'SURVEY' || chessObj.gameType === 'survey') {
    return listWindowMetrics(screen)
  }
  if (chessObj.format === 'LEADERBOARD' || chessObj.gameType === 'leaderboard') {
    return leaderboardWindowMetrics(screen)
  }
  if (
    chessObj.gameType === 'position' ||
    chessObj.mode === 'POSITION' ||
    (chessObj.format === 'FEN' && !chessObj.PGN)
  ) {
    return positionWindowMetrics(screen)
  }
  return boardPlayWindowMetrics(screen)
}

// # Board Fit and Resize

export function popupWindowFeaturesString(metrics) {
  const { width, height, left, top } = metrics
  // Sized window with full chrome — omit popup=yes (Chrome hides the PWA install icon in auxiliary popups).
  return `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
}

const POPUP_PWA_BOARD_MAX_FLOOR = 1024
const POPUP_PWA_BOARD_MAX_SCREEN_FRACTION = 0.9
function popupBoardMax() {
  const screen = window.screen
  const screenMin = Math.min(screen?.availWidth || 0, screen?.availHeight || 0)
  return Math.max(POPUP_PWA_BOARD_MAX_FLOOR, Math.round(screenMin * POPUP_PWA_BOARD_MAX_SCREEN_FRACTION))
}

function isPageVisible(page) {
  if (!page || page.hidden) return false
  return getComputedStyle(page).display !== 'none'
}

function isPuzzlePageActive() {
  return isPageVisible(document.getElementById('puzzle'))
}

function isPuzzleAuthorPageActive() {
  return isPageVisible(document.getElementById('puzzle-author'))
}

function isPositionPageActive() {
  return isPageVisible(document.getElementById('position'))
}

// Active popup/PWA board host — game, puzzle, author, or position (never a hidden sibling page).
function activePopupBoardHost() {
  if (isPuzzlePageActive()) {
    const container = document.getElementById('puzzle-console-container')
    const boardSlot = container?.querySelector?.('.chess-console-board') || null
    return {
      container,
      center: container?.querySelector?.('.chess-console-center') || null,
      boardSlot,
      boardEl: boardSlot?.querySelector?.('.chessboard') || null,
      kind: 'puzzle',
    }
  }
  if (isPuzzleAuthorPageActive()) {
    const container = document.getElementById('author-console-container')
    const boardSlot = container?.querySelector?.('.chess-console-board') || null
    return {
      container,
      center: container?.querySelector?.('.chess-console-center') || null,
      boardSlot,
      boardEl: boardSlot?.querySelector?.('.chessboard') || null,
      kind: 'puzzle-author',
    }
  }
  if (isPositionPageActive()) {
    const container = document.getElementById('position')
    const boardSlot = container?.querySelector?.('.wiki-fen-board') || null
    return {
      container,
      center: container?.querySelector?.('.wiki-fen-board-col') || null,
      boardSlot,
      boardEl: boardSlot?.querySelector?.('.chessboard') || null,
      kind: 'position',
    }
  }
  const container = document.getElementById('console-container')
  const boardSlot =
    document.querySelector('#game .chess-console-board') || document.querySelector('.chess-console-board')
  return {
    container,
    center: document.querySelector('#game .chess-console-center') || document.querySelector('.chess-console-center'),
    boardSlot,
    boardEl: boardSlot?.querySelector?.('.chessboard') || null,
    kind: 'game',
  }
}

// Popup / PWA narrow ↔ columns breakpoint (px). The CSS in wiki-chess.css owns the
// layout switch via a media query at this width; the JS reads the same query (it still
// needs to know which layout is active for the board cap and inline sizing). Keep this
// value in sync with the `@media (min-width: …)` rule in wiki-chess.css.
// 946 = History/Captured panel (210) + board (352) + controls column (48) + the
// board's own minimum (POPUP_PWA_BOARD_MIN = 336 for 42px squares).
const POPUP_COLUMNS_BREAKPOINT_PX = LAYOUT.popupColumnsBreakpointPx
const POPUP_COLUMNS_MEDIA = `(min-width: ${POPUP_COLUMNS_BREAKPOINT_PX}px)`
// The CSS media query enables the columns layout at/above the breakpoint, but we still
// force the stacked layout (via the body.wiki-popup-stack class) whenever the History &
// Captured panel can't actually sit beside the board without a horizontal scrollbar — see
// updatePopupStackState(). So "narrow" means: below the breakpoint OR force-stacked.
const isPopupColumnsWide = () => window.matchMedia(POPUP_COLUMNS_MEDIA).matches
const isPopupNarrow = () => !isPopupColumnsWide() || document.body.classList.contains('wiki-popup-stack')

// Minimum popup / PWA window outer width (px). The user owns the window size, but a
// window much narrower than this clips the board and controls, so if a resize drops it
// below this we snap the width back up (keeping the user's chosen height). Browsers give
// no declarative min-window-size, and some windows (e.g. an installed PWA) won't let
// script resize them — hence "if you can prevent it".
const POPUP_MIN_WINDOW_WIDTH = 360

// Floor for the horizontal room (px) reserved for the History & Captured panel beside the
// board in the wide/columns layout. The actual reservation is measured per render by
// measurePanelMinWidth() (the move list's widest row + the Captured heading + chrome) so
// the panel always gets exactly enough room to render without a horizontal scrollbar; this
// is just the lower bound for that measurement.
const POPUP_SIDE_PANEL_MIN = 210

// Extra width (px) beyond the measured History + Captured content: the two column paddings,
// the divider, and the panel column's own padding.
const PANEL_CHROME = 56
// Upper bound on the reserved panel width. Caps a pathologically wide move row and, by
// being >= any realistic measured value, doubles as the fallback used when the drawer is
// collapsed (its content isn't laid out, so it can't be measured). Keeping the collapsed
// fallback at the max prevents the columns/stacked decision from oscillating: the switch
// to columns is gated on this conservative value, and once the drawer opens the (smaller)
// measured value can only confirm — never reverse — that decision.
const PANEL_MAX_RESERVE = 360

// Window chrome shared by the board cap and the columns/stacked decision.
const COLUMN_GAP = 12 // .row.chess-console gap (0.75rem)
const CONTAINER_PADDING = 24 // .page.container left + right padding (0.75rem each)
const BREATHING_ROOM = 12

// Measure the width the History & Captured panel needs to render without a horizontal
// scrollbar. The move list and the Captured heading are both nowrap, so their scrollWidth
// reflects their true content width even when their column is currently squeezed. A
// collapsed drawer shows only its summary (captured pieces), so reserve at least that
// strip's width (floored at POPUP_SIDE_PANEL_MIN). If the drawer is open but its content
// isn't laid out yet (not measurable), fall back to the conservative maximum so we never
// switch to columns before we know the panel fits.
function measurePanelMinWidth() {
  const drawer = document.querySelector('.wiki-chess-history-drawer')
  if (!drawer) return POPUP_SIDE_PANEL_MIN
  if (!drawer.open) {
    const summaryW = drawer.querySelector('.wiki-chess-captured-summary')?.scrollWidth || 0
    return Math.min(PANEL_MAX_RESERVE, Math.max(POPUP_SIDE_PANEL_MIN, Math.round(summaryW + 48)))
  }
  // History | Captured default to a ~50/50 split (CSS: .wiki-chess-history-captured-row);
  // reserve the sum of both sides' preferred widths: the widest move row plus the
  // wider of the Captured heading and its widest one-line piece row. If the panel
  // ends up narrower anyway, the piece rows (and move cells) wrap instead of
  // scrolling — this reserve is what keeps each color's captures on a single line
  // in the normal case.
  const historyW = drawer.querySelector('.history')?.scrollWidth || 0
  const historyHeadingW = drawer.querySelector('.wiki-history-heading')?.scrollWidth || 0
  const capturedHeadingW = drawer.querySelector('.wiki-captured-heading')?.scrollWidth || 0
  let capturedRowW = 0
  for (const row of drawer.querySelectorAll('.captured-pieces .wiki-captured-row')) {
    capturedRowW = Math.max(capturedRowW, row.scrollWidth)
  }
  const historySide = Math.max(historyW, historyHeadingW)
  const capturedSide = Math.max(capturedHeadingW, capturedRowW)
  if (historySide > 0 || capturedSide > 0) {
    const raw = historySide + capturedSide + PANEL_CHROME
    return Math.min(PANEL_MAX_RESERVE, Math.max(POPUP_SIDE_PANEL_MIN, Math.round(raw)))
  }
  return PANEL_MAX_RESERVE
}

// Keep History & Captured beside the board only when it fits there without a horizontal
// scrollbar; otherwise add body.wiki-popup-stack to drop it below the board. "Fits" means
// the window is wide enough for the measured panel plus a board no smaller than its minimum.
function updatePopupStackState() {
  if (!ctx.isPopupLayout) return
  let force = false
  if (isPopupColumnsWide()) {
    const boardRoom = window.innerWidth - measurePanelMinWidth() - COLUMN_GAP - CONTAINER_PADDING - BREATHING_ROOM
    force = boardRoom < POPUP_PWA_BOARD_MIN
  }
  document.body.classList.toggle('wiki-popup-stack', force)
}

// Fallback vertical chrome (px) reserved below the board wrap when the center column is
// not in the DOM yet — used only by computePopupBoardCap() before the first layout pass.
const POPUP_BOARD_CAP_FALLBACK_CHROME = 200
// First-paint fallback when the board wrap exists but move controls are not measurable yet.
// Only used when measureCenterChromeBelowBoard() returns 0 — never as a floor on top of a
// real measurement (that left a permanent white gap under the footer and undersized the board).
const POPUP_CENTER_CHROME_BELOW_BOARD_EST = 160

function puzzleChromeBelowBoard() {
  const board =
    document.querySelector('#puzzle-console-container .chess-console-board') ||
    document.querySelector('#author-console-container .chess-console-board')
  const puzzleRoot =
    (isPuzzleAuthorPageActive() && document.getElementById('puzzle-author')) ||
    document.getElementById('puzzle-loaded') ||
    document.getElementById('puzzle')
  let measured = 0
  if (board && puzzleRoot) {
    measured = Math.max(0, puzzleRoot.getBoundingClientRect().bottom - board.getBoundingClientRect().bottom)
  }
  // Budget the reserve so a tall button stack cannot crush the board; excess scrolls
  // (body.wiki-popup { overflow-y: auto }). Same idea as POPUP_POSITION_BELOW_CHROME_BUDGET.
  const raw = measured > 0 ? Math.max(measured, POPUP_PUZZLE_CONTENT_CHROME_EST) : POPUP_PUZZLE_CONTENT_CHROME_EST
  return Math.min(raw, POPUP_PUZZLE_BELOW_CHROME_BUDGET)
}

// Hint + conditions card + primary action buttons (popup stacks these under the board).
// Budget the reserve so a tall stacked sidebar cannot crush the board; excess scrolls
// via .cm-fen-editor { overflow-y: auto }. Attributions / board-settings are omitted.
function positionChromeBelowBoard() {
  let measured = 0
  for (const el of [
    document.querySelector('#position .wiki-fen-under-board'),
    document.querySelector('#position .wiki-fen-sidebar .conditions-inputs'),
    document.querySelector('#position .wiki-chess-fen-actions'),
  ]) {
    if (!el) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) continue
    measured += rect.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  }
  if (measured > 0) {
    return Math.min(measured + 16, POPUP_POSITION_BELOW_CHROME_BUDGET)
  }
  return Math.min(POPUP_POSITION_CONTENT_CHROME_EST, POPUP_POSITION_BELOW_CHROME_BUDGET)
}
// First-paint fallback for the two player bars when they are not measurable yet.
// Same rule as POPUP_CENTER_CHROME_BELOW_BOARD_EST: estimate only when measured height is 0.
const POPUP_PLAYER_BARS_EST = 80

// Board width (px) below which cm-chessboard drops its frame border and moves the rank/
// file coordinates inside the squares (its AutoBorderNone behaviour). The popup/PWA gets a
// lower threshold than the wiki embed so its smaller boards still show the framed,
// outside-label style for longer. Passed to the board extension in configureBoardCoordinateMode().
const BOARD_BORDER_NONE_BELOW_POPUP = 460
const BOARD_BORDER_NONE_BELOW_EMBED = 580

let ctx

const PLAYER_BAR_OVERFLOW_EPSILON = 1
let fitPlayerBarsScheduled = false

function playerBarNameEl(bar) {
  return bar.querySelector('.wiki-chess-player-text:not(.wiki-chess-open-seat)')
}

function playerBarFormatBadge(bar) {
  return bar.querySelector('.wiki-chess-game-format-badge')
}

function playerBarNameWrap(bar) {
  return bar.querySelector(':scope > .wiki-chess-player')
}

// Packed content width: clear trailing margin-left:auto (Rated / score pills) so the
// free spacer is not counted, then sum in-flow children + gap + padding.
function playerBarPackedWidth(bar) {
  const style = getComputedStyle(bar)
  const gap = parseFloat(style.columnGap || style.gap) || 0
  let total = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  let count = 0
  for (const child of bar.children) {
    const cs = getComputedStyle(child)
    if (cs.display === 'none') continue
    const w = child.getBoundingClientRect().width
    if (w <= 0) continue
    const ml = cs.marginLeft === 'auto' ? 0 : parseFloat(cs.marginLeft) || 0
    const mr = cs.marginRight === 'auto' ? 0 : parseFloat(cs.marginRight) || 0
    total += ml + w + mr
    count++
  }
  if (count > 1) total += gap * (count - 1)
  return total
}

function playerBarOverflows(bar, rowWidth) {
  const width = bar.clientWidth || rowWidth
  if (width <= 0) return false

  const restored = []
  const save = (el, prop, value) => {
    restored.push([el, prop, el.style[prop]])
    el.style[prop] = value
  }

  for (const child of bar.children) {
    const cs = getComputedStyle(child)
    if (cs.marginLeft === 'auto') save(child, 'marginLeft', '0')
    if (cs.marginRight === 'auto') save(child, 'marginRight', '0')
  }
  const nameWrap = playerBarNameWrap(bar)
  // Measure the name at its natural text width (ignore any prior ellipsis flex shrink).
  if (nameWrap) {
    save(nameWrap, 'flex', '0 0 auto')
    save(nameWrap, 'minWidth', 'max-content')
    save(nameWrap, 'maxWidth', 'none')
    save(nameWrap, 'overflow', 'visible')
  }

  try {
    return playerBarPackedWidth(bar) > width + PLAYER_BAR_OVERFLOW_EPSILON
  } finally {
    for (const [el, prop, prev] of restored) el.style[prop] = prev
  }
}

function resetPlayerBarFit(bar) {
  // Clear any legacy inline name scaling from older fitPlayerBars builds.
  bar.style.fontSize = ''
  const nameEl = playerBarNameEl(bar)
  if (nameEl) nameEl.style.fontSize = ''
  bar.classList.remove('wiki-chess-player-bar--clipped')
  playerBarFormatBadge(bar)?.classList.remove('is-compact')
}

// Fit player-bar content without changing name font size (top/bottom stay matched):
//   1. full badge + full name when it fits
//   2. collapse rated/casual badge to icon-only
//   3. ellipsis the name as a last resort
export function fitPlayerBars(root) {
  const board =
    (root instanceof Element && root.matches('.chess-console-board') ? root : null) ||
    root?.querySelector?.('.chess-console-board') ||
    document.querySelector('.chess-console-board')
  if (!board) return

  for (const row of board.querySelectorAll('.player.top, .player.bottom')) {
    const rowStyle = getComputedStyle(row)
    if (rowStyle.display === 'none' || rowStyle.visibility === 'hidden') continue

    const bar = row.querySelector('.wiki-chess-player-bar')
    if (!bar) continue

    resetPlayerBarFit(bar)
    const available = row.clientWidth
    if (available <= 0) continue

    if (!playerBarOverflows(bar, available)) continue

    const badge = playerBarFormatBadge(bar)
    if (badge) {
      badge.classList.add('is-compact')
      if (!playerBarOverflows(bar, available)) continue
    }

    if (playerBarOverflows(bar, available)) {
      bar.classList.add('wiki-chess-player-bar--clipped')
    }
  }
}

export function scheduleFitPlayerBars() {
  if (fitPlayerBarsScheduled) return
  fitPlayerBarsScheduled = true
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      fitPlayerBarsScheduled = false
      fitPlayerBars()
    })
  })
}

export function initBoardLayout(context) {
  ctx = context
  window.scheduleFitPlayerBars = scheduleFitPlayerBars
  registerModalPwaWindowHandlers({
    begin: beginPwaModalWindow,
    scheduleFit: schedulePwaModalWindowFit,
    end: endPwaModalWindow,
  })
  const bootDrawerMemory = () => wireDrawerOpenMemory()
  if (document.readyState === 'loading') ctx.whenDocumentReady(bootDrawerMemory)
  else bootDrawerMemory()
}

export function setupPopupLayout() {
  window.addEventListener(
    'resize',
    () => {
      enforcePopupMinWidth()
      fitPopupBoard()
      scheduleFitPlayerBars()
    },
    { passive: true },
  )
  document.querySelectorAll('.wiki-chess-drawer').forEach(el => {
    el.addEventListener('toggle', () => fitPopupBoard(), { passive: true })
  })
  wireAttributionAutoCollapse()
  ctx.whenDocumentReady(() => {
    fitPopupBoard()
    window.setTimeout(fitPopupBoard, 50)
    window.setTimeout(fitPopupBoard, 250)
    const boardSlot = document.querySelector('.chess-console-board')
    if (boardSlot) {
      new ResizeObserver(() => {
        configureBoardCoordinateMode()
        scheduleFitPlayerBars()
      }).observe(boardSlot)
    }
    const centerCol = document.querySelector('.chess-console-center')
    if (centerCol) {
      new ResizeObserver(() => fitPopupBoard()).observe(centerCol)
    }
    const fenBoard = document.querySelector('#position .wiki-fen-board')
    if (fenBoard) {
      new ResizeObserver(() => {
        if (isPositionPageActive()) fitPopupBoard()
      }).observe(fenBoard)
    }
    const gameStateSlot = document.querySelector('.wiki-chess-game-state')
    if (!gameStateSlot) return
    new MutationObserver(() => fitPopupBoard()).observe(gameStateSlot, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
    })
  })
}

// Snap the popup / PWA window back to the minimum width if a resize took it narrower.
// We never grow or otherwise manage the window size — this only nudges the width up when
// the user drags it below the floor, so resizing at or above the minimum is untouched.
function enforcePopupMinWidth() {
  if (!ctx.isPopupLayout) return
  if (window.outerWidth >= POPUP_MIN_WINDOW_WIDTH) return
  resizePopupWindow(POPUP_MIN_WINDOW_WIDTH, window.outerHeight)
}

// Resize an already-open popup / PWA without relocating it. Initial placement for a
// newly opened popup uses popupWindowFeaturesString() in chess.js; chess-app.js resizes after load.
// only change dimensions so the window stays where the user left it (moveTo with screen-
// centred coords was jumping windows to the primary monitor's top-left on multi-display
// setups and installed PWAs).
function safeResizeTo(width, height) {
  try {
    window.resizeTo(width, height)
  } catch {
    /* some windows (e.g. an installed PWA) can't be script-resized; nothing we can do */
  }
}

// Skip no-op resizeTo — each call can fire `resize` and re-enter board fitting.
export function popupOuterSizeUnchanged(nextWidth, nextHeight, { slack = 12, outerWidth, outerHeight } = {}) {
  const w = outerWidth ?? (typeof window !== 'undefined' ? window.outerWidth : 0)
  const h = outerHeight ?? (typeof window !== 'undefined' ? window.outerHeight : 0)
  return Math.abs(w - nextWidth) <= slack && Math.abs(h - nextHeight) <= slack
}

function resizePopupWindow(width, height) {
  if (popupOuterSizeUnchanged(width, height)) return
  safeResizeTo(width, height)
}

const PWA_MODAL_ROOT_PADDING = 32
const PWA_MODAL_HEIGHT_MARGIN = 8

// Sum visible child scroll heights inside a modal panel (works while max-height caps layout).
export function measureModalPanelContentHeight(panel) {
  if (!panel) return 0
  const style = getComputedStyle(panel)
  let height = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
  const gap = parseFloat(style.rowGap) || parseFloat(style.gap) || 0
  const children = [...panel.children].filter(child => getComputedStyle(child).display !== 'none')
  for (const child of children) height += child.scrollHeight
  if (children.length > 1) height += gap * (children.length - 1)
  return height
}

export function pwaOuterHeightForModalContent(
  contentHeight,
  {
    chrome = POPUP_WINDOW_CHROME_HEIGHT,
    rootPadding = PWA_MODAL_ROOT_PADDING,
    margin = PWA_MODAL_HEIGHT_MARGIN,
    screen = null,
  } = {},
) {
  const { availH } = popupWindowAvailSize(screen)
  return Math.min(availH, Math.ceil(contentHeight + rootPadding + chrome + margin))
}

export function pwaOuterWidthForModalPanel(
  panel,
  { rootPadding = PWA_MODAL_ROOT_PADDING, minWidth = POPUP_MIN_WINDOW_WIDTH, screen = null } = {},
) {
  const { availW } = popupWindowAvailSize(screen)
  const panelWidth = panel?.getBoundingClientRect().width || 448
  return Math.min(availW, Math.max(minWidth, Math.ceil(panelWidth + rootPadding)))
}

let pwaModalWindowSnapshot = null
let pwaModalWindowObserver = null
let pwaModalFitToken = 0
// Filter-modal confirm → puzzle/play often calls fitPwaPlayWindow in the same turn.
// Restoring the choose-menu snapshot first, then growing the play window, shakes the
// PWA violently. Defer restore two frames so play-window sizing can cancel it.
let pwaModalRestoreToken = 0
// Last published board cap — skip handleResize when unchanged (stops ResizeObserver loops).
let lastPopupBoardCapKey = ''

function disconnectPwaModalWindowObserver() {
  pwaModalWindowObserver?.disconnect()
  pwaModalWindowObserver = null
}

function cancelDeferredPwaModalWindowRestore() {
  pwaModalRestoreToken++
}

// True when a play-window resize is about to own the outer size — skip modal restore.
export function shouldSkipPwaModalWindowRestore({
  playWindowPending = false,
  playWindowSizing = false,
  windowSizingHidden = false,
} = {}) {
  return Boolean(playWindowPending || playWindowSizing || windowSizingHidden)
}

function fitPwaModalWindowNow(panel) {
  if (!ctx?.isPopupLayout || !panel) return
  const contentHeight = measureModalPanelContentHeight(panel)
  const outerHeight = pwaOuterHeightForModalContent(contentHeight)
  const outerWidth = pwaOuterWidthForModalPanel(panel)
  const height = Math.max(window.outerHeight, outerHeight)
  const width = Math.max(window.outerWidth, outerWidth)
  resizePopupWindow(width, height)
}

export function beginPwaModalWindow(panel) {
  if (!ctx?.isPopupLayout || !panel) return
  if (!pwaModalWindowSnapshot) {
    pwaModalWindowSnapshot = { width: window.outerWidth, height: window.outerHeight }
  }
  disconnectPwaModalWindowObserver()
  pwaModalWindowObserver = new ResizeObserver(() => schedulePwaModalWindowFit(panel))
  pwaModalWindowObserver.observe(panel)
  const body = panel.querySelector('.wiki-modal-body, .wiki-stockfish-setup-body')
  if (body) pwaModalWindowObserver.observe(body)
}

export function schedulePwaModalWindowFit(panel) {
  if (!ctx?.isPopupLayout || !panel) return
  const token = ++pwaModalFitToken
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (token !== pwaModalFitToken) return
      fitPwaModalWindowNow(panel)
    })
  })
}

export function endPwaModalWindow() {
  pwaModalFitToken++
  disconnectPwaModalWindowObserver()
  const snapshot = pwaModalWindowSnapshot
  pwaModalWindowSnapshot = null
  if (!snapshot || !ctx?.isPopupLayout) return
  const token = ++pwaModalRestoreToken
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (token !== pwaModalRestoreToken) return
      if (
        shouldSkipPwaModalWindowRestore({
          playWindowPending: Boolean(pwaPendingPlayWindowPage),
          playWindowSizing: pwaPlayWindowSizing,
          windowSizingHidden: document.documentElement.classList.contains('wiki-pwa-window-sizing'),
        })
      ) {
        return
      }
      resizePopupWindow(snapshot.width, snapshot.height)
    })
  })
}

// Shrink the popup / PWA window for the choose menu. Windows remembers the last game-
// window size, which leaves a lot of empty space around the mode picker.
export function fitChooseMenuWindow() {
  if (!ctx.isPopupLayout) return
  cancelDeferredPwaModalWindowRestore()
  lastPopupBoardCapKey = ''
  pwaPendingPlayWindowPage = null
  pwaPlayWindowFinalizeToken++
  document.documentElement.classList.remove('wiki-pwa-window-sizing')
  const { width, height } = chooseMenuWindowMetrics(window.screen)
  resizePopupWindow(width, height)
}

// One-shot PWA play-window sizing: wait for the board to lay out, measure content, resize
// once (hidden via html.wiki-pwa-window-sizing), then reveal. Avoids the old pattern of
// estimate → shrink → grow that visibly jumped the window several times.
let pwaPendingPlayWindowPage = null
let pwaPlayWindowFinalizeToken = 0
let pwaPlayWindowSizing = false
const PWA_PLAY_LAYOUT_MAX_FRAMES = 40

function pwaPageElement(page) {
  if (page === 'puzzle' || page === 'puzzle-author') return document.getElementById('puzzle')
  if (page === 'position') return document.getElementById('position')
  if (page === 'game') return document.getElementById('game')
  return null
}

function pwaPlayLayoutReady(page) {
  const pageEl = pwaPageElement(page)
  if (!pageEl || getComputedStyle(pageEl).display === 'none') return false
  if (page === 'game') {
    return Boolean(document.querySelector('.chess-console-board .chessboard')?.getBoundingClientRect().height)
  }
  if (page === 'position') {
    return Boolean(document.querySelector('#position .wiki-fen-board .chessboard')?.getBoundingClientRect().height)
  }
  if (page === 'puzzle' || page === 'puzzle-author') {
    return Boolean(
      document
        .querySelector('#puzzle-console-container .chessboard, #puzzle-loaded .chessboard')
        ?.getBoundingClientRect().height,
    )
  }
  return true
}

function layoutFrames(count) {
  return new Promise(resolve => {
    const step = remaining => {
      if (remaining <= 0) resolve()
      else requestAnimationFrame(() => step(remaining - 1))
    }
    step(count)
  })
}

function pwaMeasuredOuterHeight(pageEl, fallback) {
  if (!pageEl || getComputedStyle(pageEl).display === 'none') return fallback
  const chrome = window.outerHeight - window.innerHeight
  return Math.ceil(measurePwaPageContentBottom(pageEl) + chrome + 8)
}

// Play-window outer height after measuring content. Never shrink below the mode's
// metrics height — an empty/hidden puzzle page used to measure ~banner-tall and
// crush the popup before the board finished mounting.
export function clampPwaPlayWindowHeight(measured, metricsHeight) {
  const floor = Math.max(0, Number(metricsHeight) || 0)
  const value = Math.max(0, Number(measured) || 0)
  return Math.max(floor, value)
}

function revealPwaPlayWindowAtMetrics(page) {
  const { width, height } = windowMetricsForPage(page)
  resizePopupWindow(width, height)
  document.documentElement.classList.remove('wiki-pwa-window-sizing')
}

function schedulePwaPlayWindowFinalize(frame = 0) {
  const page = pwaPendingPlayWindowPage
  if (!page) return

  const token = pwaPlayWindowFinalizeToken
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (token !== pwaPlayWindowFinalizeToken || pwaPendingPlayWindowPage !== page) return
      if (!pwaPlayLayoutReady(page)) {
        if (frame < PWA_PLAY_LAYOUT_MAX_FRAMES) {
          schedulePwaPlayWindowFinalize(frame + 1)
          return
        }
        // Board still missing (slow puzzle fetch / first cm-modules import). Reveal at
        // the planned metrics size and keep pending so notifyPwaPlayLayoutReady can
        // still run a measured finalize — do not measure an empty page and shrink.
        revealPwaPlayWindowAtMetrics(page)
        return
      }
      void runPwaPlayWindowFinalize(page)
    })
  })
}

async function runPwaPlayWindowFinalize(page) {
  if (pwaPlayWindowSizing) return
  pwaPlayWindowSizing = true

  try {
    const metrics = windowMetricsForPage(page)
    const pageEl = pwaPageElement(page)
    const { width } = metrics

    if (Math.abs(window.outerWidth - width) > 12) {
      resizePopupWindow(width, window.outerHeight)
    }

    await layoutFrames(2)
    applyPopupBoardCap({ syncBoardResize: true })
    await layoutFrames(2)

    let height = clampPwaPlayWindowHeight(pwaMeasuredOuterHeight(pageEl, metrics.height), metrics.height)
    resizePopupWindow(width, height)

    await layoutFrames(2)
    applyPopupBoardCap({ syncBoardResize: true })

    const corrected = clampPwaPlayWindowHeight(pwaMeasuredOuterHeight(pageEl, height), metrics.height)
    if (Math.abs(corrected - height) > 12) {
      height = corrected
      resizePopupWindow(width, height)
      applyPopupBoardCap({ syncBoardResize: true })
    }
  } finally {
    pwaPendingPlayWindowPage = null
    document.documentElement.classList.remove('wiki-pwa-window-sizing')
    pwaPlayWindowSizing = false
    fitPopupBoard()
  }
}

// Call when the play view's board has finished mounting (game console, FenEditor, puzzle).
export function notifyPwaPlayLayoutReady() {
  if (!ctx.isPopupLayout || !pwaPendingPlayWindowPage) return
  schedulePwaPlayWindowFinalize()
}

// Grow and centre the popup / PWA window for gameplay views after the compact choose menu.
export function fitPwaPlayWindow(page) {
  if (!ctx.isPopupLayout || !page || page === 'start') return

  // Cancel deferred filter/setup modal restore — that shrink-then-grow shakes the PWA.
  cancelDeferredPwaModalWindowRestore()
  lastPopupBoardCapKey = ''

  if (page === 'leaderboard') {
    pwaPendingPlayWindowPage = null
    pwaPlayWindowFinalizeToken++
    document.documentElement.classList.remove('wiki-pwa-window-sizing')
    const { width, height } = windowMetricsForPage(page)
    resizePopupWindow(width, height)
    return
  }

  pwaPendingPlayWindowPage = page
  pwaPlayWindowFinalizeToken++
  document.documentElement.classList.add('wiki-pwa-window-sizing')
  schedulePwaPlayWindowFinalize()
}

// The Game controls drawer (history, captures, action buttons, settings, attributions)
// is user-owned in every surface and layout. Defaults: `.wiki-chess-drawer` panels
// start open (except Game settings and Attributions, which always boot collapsed —
// see wireDrawerOpenMemory). sessionStorage remembers the last
// open/closed set per wiki item for this tab (ephemeral — cleared when the tab goes
// away). Layout changes (wide/columns vs narrow/stacked, resizes, ratio flips) must
// never force open or closed — auto-toggling on layout change kept overriding the
// user's choice.

// Lowest edge of visible page content (px from viewport top). body.wiki-popup is height:100%,
// so scrollHeight tracks the viewport — not the content — and cannot be used to trim excess
// window height.
function measurePwaPageContentBottom(pageEl) {
  let bottom = pageEl.getBoundingClientRect().bottom
  for (const el of pageEl.querySelectorAll(
    '.wiki-chess-sticky, .wiki-chess-below-chrome, .wiki-chess-fen-footer, .cm-fen-editor, .wiki-puzzle, #puzzle-loaded, #puzzle-console-container',
  )) {
    if (getComputedStyle(el).display === 'none') continue
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom)
  }
  return bottom
}

function applyPopupBoardCap({ syncBoardResize = false } = {}) {
  if (!ctx.isPopupLayout) return

  updatePopupStackState()

  if (!syncBoardResize) return

  const narrow = isPopupNarrow()
  const { container, center, boardSlot, boardEl, kind } = activePopupBoardHost()

  // Measure before mutating — if the published cap is unchanged, skip handleResize so a
  // center-column ResizeObserver cannot oscillate the board (reads as violent vibration).
  const cap = computePopupBoardCap()
  const capKey = `${kind}:${narrow ? 'n' : 'w'}:${cap}`
  if (capKey === lastPopupBoardCapKey) {
    if (boardEl) {
      publishBoardWidthVar(boardEl)
      scheduleFitPlayerBars()
    }
    syncPwaPageChromeBoardAlign()
    return
  }
  lastPopupBoardCapKey = capKey

  if (center) {
    center.style.minWidth = narrow ? '' : `${POPUP_PWA_BOARD_MIN}px`
  }

  if (boardSlot && boardEl) {
    boardSlot.style.width = ''
    boardSlot.style.maxWidth = ''
    boardSlot.style.minWidth = narrow ? '' : `${POPUP_PWA_BOARD_MIN}px`
    boardEl.style.width = ''
    boardEl.style.maxWidth = ''
    boardEl.style.height = ''
    boardEl.style.minWidth = narrow ? '' : `${POPUP_PWA_BOARD_MIN}px`
  }

  if (kind !== 'position') configureBoardCoordinateMode()

  // Publish a height/width cap so the board fills the window without pushing controls
  // off-screen. Must land on the *active* board host — #console-container always exists
  // in the DOM, so writing only there left puzzle/author/position stuck at CSS fallbacks.
  // PWA play-window sizing is handled separately in runPwaPlayWindowFinalize().
  if (container) container.style.setProperty('--wiki-chess-board-cap', `${cap}px`)

  if (kind === 'position') {
    // cm-chessboard handleResize() sets height from context.clientWidth — pin width
    // before resize so a short PWA window shrinks the square (CSS max-height alone is not enough).
    if (boardSlot) {
      boardSlot.style.width = '100%'
      boardSlot.style.maxWidth = `${cap}px`
      boardSlot.style.minWidth = ''
    }
    if (boardEl) {
      boardEl.style.width = '100%'
      boardEl.style.maxWidth = `${cap}px`
      boardEl.style.height = ''
      boardEl.style.minWidth = ''
      void boardEl.offsetWidth
    }
    ctx.fenEditor?.chessboard?.view?.handleResize?.()
    if (boardEl) publishBoardWidthVar(boardEl)
    syncPwaPageChromeBoardAlign()
    return
  }

  const chessboard = ctx.chessConsole?.components?.board?.chessboard
  if (chessboard?.view && boardEl) {
    const measured = Math.max(center?.clientWidth || 0, boardSlot?.clientWidth || 0, boardEl.clientWidth || 0)
    if (!narrow && measured > 0 && measured < POPUP_PWA_BOARD_MIN) {
      boardEl.style.width = `${POPUP_PWA_BOARD_MIN}px`
      boardEl.style.maxWidth = '100%'
    }
    chessboard.view.handleResize?.()
    publishBoardWidthVar(boardEl)
    scheduleFitPlayerBars()
  }
}

// Coalesce ResizeObserver / window.resize storms — unbounded fitPopupBoard re-entry
// (center column observes → handleResize → observe again) reads as the board vibrating.
let fitPopupBoardRaf = 0

export function fitPopupBoard() {
  if (fitPopupBoardRaf) return
  fitPopupBoardRaf = window.requestAnimationFrame(() => {
    fitPopupBoardRaf = 0
    // Stack/history state first; measure+resize on the next frame so layout settles.
    applyPopupBoardCap()
    window.requestAnimationFrame(() => {
      applyPopupBoardCap({ syncBoardResize: true })
    })
  })
}

// Cap the popup / PWA board, with different priorities per layout:
//
//   - Narrow / stacked layout (History & Captured panel and footer BELOW the board):
//     fill the center column width edge-to-edge. A square board that size may push
//     history/footer (and sometimes move controls) below the fold — the page scrolls.
//     Preferring a height reserve left empty gutters beside a smaller board on phones.
//
//   - Wide / columns layout (History / game-controls panel BESIDE the board): the board
//     shares its vertical space with the in-center chrome (move controls + banner).
//     Action buttons / settings / attributions live inside the side-panel drawer, so they
//     no longer reserve height under the board. Bounded by the horizontal room left after
//     the side panel's minimum width. The board is square, so the smallest of the bounds
//     wins.
//
// The reserved chrome heights/widths don't depend on the board's own size, so this is
// stable to recompute on every resize / drawer toggle.
function boardWrapTop() {
  const wrap = document.querySelector('.chess-console-board-wrap')
  if (!wrap) return null
  return Math.max(0, wrap.getBoundingClientRect().top)
}

// Player name rows above/below the square grid — reserved when height-capping the board.
function measurePlayerBarsHeight() {
  const board = document.querySelector('.chess-console-board')
  if (!board) return 0

  let total = 0
  for (const el of board.querySelectorAll('.player.top, .player.bottom')) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) continue
    total += rect.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  }
  return total
}

// Sum the in-center chrome below the board (controls, check banner, result banner, …).
// Measured from layout siblings so it does not depend on the board's current size.
function measureCenterChromeBelowBoard() {
  const center = document.querySelector('.chess-console-center')
  const wrap = center?.querySelector('.chess-console-board-wrap')
  if (!center || !wrap) return 0

  let total = 0
  for (let el = wrap.nextElementSibling; el; el = el.nextElementSibling) {
    if (!center.contains(el)) break
    if (el.hasAttribute('hidden')) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) continue
    total += rect.height
    total += parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  }
  return total
}

function popupBoardCapParts() {
  const boardTop = boardWrapTop()
  if (boardTop == null) return null

  const measuredBelow = measureCenterChromeBelowBoard()
  const belowBoardInCenter = measuredBelow > 0 ? measuredBelow : POPUP_CENTER_CHROME_BELOW_BOARD_EST
  const measuredBars = measurePlayerBarsHeight()
  const playerBars = measuredBars > 0 ? measuredBars : POPUP_PLAYER_BARS_EST
  const widthCap = window.innerWidth - CONTAINER_PADDING - BREATHING_ROOM

  if (isPopupNarrow()) {
    // Stacked layout (phone / Chrome tab / force-stack): fill the center column width.
    // Preferring heightCap left empty gutters beside a smaller square when the viewport
    // was wider than tall-enough-for-controls; users want the board edge-to-edge and can
    // scroll for history/footer. In-center move controls still share the column.
    const centerWidth = document.querySelector('.chess-console-center')?.clientWidth || 0
    const resolvedWidth = centerWidth > 0 ? centerWidth : widthCap
    return { heightCap: resolvedWidth, widthCap: resolvedWidth }
  }

  // Action buttons / settings / attributions live inside the History side-panel drawer
  // now, so they do not consume vertical space under the board in columns layout.
  const heightCap = window.innerHeight - boardTop - belowBoardInCenter - playerBars - BREATHING_ROOM

  // Reserve exactly the room the panel needs to render without a horizontal scrollbar
  // (measured per render), so the board grows to fill the remaining width but never
  // squeezes the panel into a scrollbar.
  const widthCapColumns = window.innerWidth - measurePanelMinWidth() - COLUMN_GAP - CONTAINER_PADDING - BREATHING_ROOM

  return { heightCap, widthCap: widthCapColumns }
}

function computePuzzlePopupBoardCap(max) {
  const board =
    document.querySelector('#puzzle-console-container .chess-console-board') ||
    document.querySelector('#author-console-container .chess-console-board')
  const boardTop =
    board?.getBoundingClientRect().top ??
    document.getElementById('puzzle-loaded')?.getBoundingClientRect().top ??
    document.getElementById('puzzle-author')?.getBoundingClientRect().top ??
    0
  // Puzzle is always stacked (no side panel). Prefer filling the center column width —
  // same priority as the game narrow layout. Height-capping against the full control
  // stack left empty gutters beside an undersized board; users scroll for buttons.
  const heightCap = window.innerHeight - boardTop - puzzleChromeBelowBoard() - BREATHING_ROOM
  const center = board?.closest?.('.chess-console-center')
  const widthCap = center?.clientWidth > 0 ? center.clientWidth : window.innerWidth - CONTAINER_PADDING - BREATHING_ROOM
  return puzzleBoardCapPx({
    widthCap,
    heightCap,
    maxCap: max,
    minFloor: POPUP_PWA_BOARD_MIN,
  })
}

function computePositionPopupBoardCap(max) {
  const board = document.querySelector('#position .wiki-fen-board .chessboard')
  const boardTop = Math.max(
    0,
    board?.getBoundingClientRect().top ?? document.getElementById('position')?.getBoundingClientRect().top ?? 0,
  )
  const heightCap = window.innerHeight - boardTop - positionChromeBelowBoard() - BREATHING_ROOM
  // Use the column (not .wiki-fen-board): the mount is already CSS-capped, so reading it
  // would prevent the board from growing when the window gets taller/wider.
  const col = document.querySelector('#position .wiki-fen-board-col')
  const widthCap = col?.clientWidth > 0 ? col.clientWidth : window.innerWidth - CONTAINER_PADDING - BREATHING_ROOM
  // cm-chessboard sizes the square from context.clientWidth only — the cap must shrink
  // width when the window is short. Never floor above heightCap (PWA may not resizeTo).
  return positionBoardCapPx({
    widthCap,
    heightCap,
    maxCap: Math.min(max, POPUP_WINDOW_POSITION_BOARD_CAP, POPUP_POSITION_BOARD_CAP),
    minFloor: POPUP_PWA_BOARD_MIN,
  })
}

function computePopupBoardCap() {
  const max = popupBoardMax()
  // Puzzle/author/position have no .chess-console-board-wrap; never let a leftover game wrap
  // drive the cap (hidden #game still matches querySelector).
  if (isPuzzlePageActive() || isPuzzleAuthorPageActive()) {
    return computePuzzlePopupBoardCap(max)
  }
  if (isPositionPageActive()) {
    return computePositionPopupBoardCap(max)
  }
  const parts = popupBoardCapParts()
  if (!parts) {
    const widthCap = window.innerWidth - CONTAINER_PADDING - BREATHING_ROOM
    const heightCap = window.innerHeight - POPUP_BOARD_CAP_FALLBACK_CHROME
    const cap = Math.min(widthCap, heightCap, max)
    return Math.max(POPUP_PWA_BOARD_MIN, Math.round(cap))
  }
  const cap = Math.min(parts.heightCap, parts.widthCap, max)
  return Math.max(POPUP_PWA_BOARD_MIN, Math.round(cap))
}

// Expose the rendered board width so below-the-board chrome can match the board.
// Also expose the full cluster span — from the board's left edge to the board's right
// edge (narrow) or to the History / game-controls panel's right edge (wide/columns) —
// so stacked chrome can line up under the cluster instead of stretching full width.
function publishBoardWidthVar(boardEl) {
  const container = document.getElementById('console-container')
  if (!container || !boardEl) return
  const boardRect = boardEl.getBoundingClientRect()
  if (boardRect.width > 0) {
    container.style.setProperty('--wiki-chess-board-width', `${Math.round(boardRect.width)}px`)
  }

  // The footer block is pinned to the board: its left edge matches the board's left edge
  // (--wiki-chess-cluster-left, measured relative to the container) and its right edge
  // reaches the board's right edge (narrow) or the History panel's right edge (columns).
  const containerLeft = container.getBoundingClientRect().left
  let clusterRight = boardRect.right
  if (!isPopupNarrow()) {
    const right = document.querySelector('.chess-console-right')
    const rightRect = right?.getBoundingClientRect()
    if (rightRect && rightRect.width > 0) clusterRight = Math.max(clusterRight, rightRect.right)
  }
  const clusterLeft = Math.max(0, boardRect.left - containerLeft)
  const clusterWidth = clusterRight - boardRect.left
  if (clusterWidth > 0) {
    container.style.setProperty('--wiki-chess-cluster-left', `${Math.round(clusterLeft)}px`)
    container.style.setProperty('--wiki-chess-cluster-width', `${Math.round(clusterWidth)}px`)
  }
  syncPwaPageChromeBoardAlign()
}

// Align PWA page-title chrome with the visible board's left edge.
export function syncPwaPageChromeBoardAlign() {
  const wrap = document.getElementById('wikiChessPwaPageChromePage')
  if (!wrap || wrap.hidden) return
  const query = typeof document.querySelector === 'function' ? document.querySelector.bind(document) : null
  if (!query) return
  const board =
    query('#game.wiki-page-active .chess-console-board') ||
    query('#puzzle.wiki-page-active .chess-console-board') ||
    query('#puzzle-console-container .chess-console-board') ||
    query('#position.wiki-page-active .chessboard') ||
    query('#author-console-container .chess-console-board') ||
    query('.chess-console-board')
  if (!board || typeof board.getBoundingClientRect !== 'function') {
    wrap.style?.removeProperty?.('padding-left')
    return
  }
  if (!wrap.getBoundingClientRect || !wrap.style) return
  const inset = Math.max(0, Math.round(board.getBoundingClientRect().left - wrap.getBoundingClientRect().left))
  wrap.style.paddingLeft = `${inset}px`
}

export function fitEmbedBoard() {
  if (!ctx.isWikiEmbed || ctx.isPopupLayout) return
  scheduleBoardResize()

  const boardSlot = document.querySelector('.chess-console-board')
  const boardEl = boardSlot?.querySelector('.chessboard')
  if (!boardSlot || !boardEl) return

  boardSlot.style.width = '100%'
  boardSlot.style.maxWidth = '100%'
  boardEl.style.width = '100%'
  boardEl.style.maxWidth = '100%'

  scheduleBoardResize()
  scheduleFitPlayerBars()
}

export function scheduleBoardResize() {
  window.requestAnimationFrame(() => {
    ctx.chessConsole?.components?.board?.chessboard?.view?.handleResize?.()
  })
}

// Match chess-console AutoBorderNone: frame border + outside labels when the board is wide enough
export function configureBoardCoordinateMode() {
  const chessboard = ctx.chessConsole?.components?.board?.chessboard
  if (!chessboard) return
  const borderNoneBelow = ctx.isPopupLayout ? BOARD_BORDER_NONE_BELOW_POPUP : BOARD_BORDER_NONE_BELOW_EMBED
  for (const ext of chessboard.extensions) {
    if (ext?.props?.borderNoneBelow != null) {
      ext.props.borderNoneBelow = borderNoneBelow
      break
    }
  }
  chessboard.view?.handleResize?.()
}

export function setupWikiEmbedHeight() {
  if (!ctx.isWikiEmbed || !ctx.wikiFrame) return

  let lastHeight = 0
  let lastEmbedWidth = window.innerWidth
  let heightReportScheduled = false

  // Content height only — never use body/html scrollHeight (tracks iframe viewport and loops)
  const measureEmbedHeight = () => {
    let bottom = 0
    for (const el of document.querySelectorAll('.page')) {
      if (el.style.display === 'none') continue
      if (getComputedStyle(el).display === 'none') continue
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom)
    }
    // Body-level in-flow dialogs (start-game setup) can sit outside `.page` until mounted.
    for (const el of document.querySelectorAll(
      '.wiki-stockfish-setup-root:not([hidden]), .wiki-modal-root.wiki-modal-embedded',
    )) {
      if (getComputedStyle(el).display === 'none') continue
      const rect = el.getBoundingClientRect()
      if (rect.height > 0) bottom = Math.max(bottom, rect.bottom)
    }
    return Math.ceil(bottom)
  }

  const postEmbedHeight = (height, { scrollIntoView = false } = {}) => {
    if (height < 1) return
    shellMessengerFromContext(ctx)?.resize({ height, scrollIntoView })
  }

  const report = ({ scrollIntoView = false } = {}) => {
    ctx.hideAppLoadingScreen?.()
    const height = measureEmbedHeight()
    if (height < 1) {
      if (lastHeight > 0) postEmbedHeight(lastHeight, { scrollIntoView })
      return
    }
    const heightChanged = Math.abs(height - lastHeight) > 2
    if (!heightChanged && !scrollIntoView) return
    if (heightChanged) lastHeight = height
    postEmbedHeight(height, { scrollIntoView })
  }

  const scheduleReport = () => {
    if (heightReportScheduled) return
    heightReportScheduled = true
    window.requestAnimationFrame(() => {
      heightReportScheduled = false
      report()
    })
  }

  window.scheduleWikiHeightReport = scheduleReport

  window.requestWikiEmbedScrollIntoView = () => report({ scrollIntoView: true })

  window.addEventListener(
    'resize',
    () => {
      const w = window.innerWidth
      if (w !== lastEmbedWidth) {
        lastEmbedWidth = w
        fitEmbedBoard()
        // Font fit only when width changes — height-only iframe resizes (new history
        // row after a move) must not re-measure bars or the board jiggles.
        scheduleFitPlayerBars()
      }
      scheduleReport()
    },
    { passive: true },
  )

  new ResizeObserver(() => scheduleReport()).observe(document.body)
  document.querySelectorAll('.wiki-chess-drawer').forEach(el => {
    el.addEventListener('toggle', scheduleReport)
  })
  wireAttributionAutoCollapse()
  wireEmbedScrollChain()
  scheduleReport()
}

// Inner scroll regions inside the wiki iframe (capped game lists, leaderboard table,
// move history, piece-set picker). CSS overscroll-behavior alone does not chain wheel
// events across the iframe boundary while the pointer stays put; Federated Wiki scrolls
// the `.page` column, not the window, so we forward wheel explicitly via frameElement.
//
// Default: forward every wheel to the wiki page. Only consume wheel inside a capped
// overflow region that still has room to scroll (survey section lists, federated
// leaderboard table, move history, piece-set options).
const EMBED_SCROLL_CHAIN_SELECTOR =
  '.wiki-chess-lb-games-scroll, .wiki-chess-lb-table-wrap, .wiki-chess-history-scroll, .wiki-chess-piece-set-options'

const EMBED_WHEEL_IGNORE_SELECTOR = '.wiki-modal-root:not(.wiki-modal-embedded)'

let embedScrollChainWired = false

function scrollParentWikiPage(deltaY, deltaX) {
  // Scroll via the wiki shell — it owns the `.page` column and the item context.
  // Same-origin scrollBy from inside the iframe is unreliable across browsers.
  shellMessengerFromContext(ctx)?.embedWheelScroll({ deltaY, deltaX })
}

function isVerticalScrollContainer(el) {
  const oy = getComputedStyle(el).overflowY
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay'
}

function onEmbedScrollChainWheel(event) {
  if (event.target.closest?.(EMBED_WHEEL_IGNORE_SELECTOR)) return
  if (isBrowserZoomWheel(event)) return

  const deltaY = event.deltaY
  if (deltaY === 0) return

  const scrollEl = event.target.closest?.(EMBED_SCROLL_CHAIN_SELECTOR)
  if (scrollEl instanceof HTMLElement && isVerticalScrollContainer(scrollEl)) {
    const action = resolveEmbedWheelAction({
      deltaY,
      scrollTop: scrollEl.scrollTop,
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      overflowY: getComputedStyle(scrollEl).overflowY,
    })
    if (action === 'consume') return
    if (action === 'chain') {
      event.preventDefault()
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight
      const next = scrollEl.scrollTop + deltaY
      const overflow = next <= 0 ? next : next - maxScroll
      scrollEl.scrollTop = next <= 0 ? 0 : maxScroll
      scrollParentWikiPage(overflow, event.deltaX)
      return
    }
  }

  // Iframe wheel does not reach the wiki .page column on its own.
  event.preventDefault()
  scrollParentWikiPage(deltaY, event.deltaX)
}

function wireEmbedScrollChain() {
  if (embedScrollChainWired || !ctx.isWikiEmbed || !ctx.wikiFrame) return
  embedScrollChainWired = true
  document.addEventListener('wheel', onEmbedScrollChainWheel, { passive: false, capture: true })
}

let attributionAutoCollapseWired = false
let drawerOpenMemoryWired = false

// ## Drawer Open Memory

function drawerOpenStorageKey() {
  return `${pwaStoragePrefix()}DrawerOpen`
}

function drawerMemoryId(el) {
  if (el.id) return el.id
  const page = el.closest('.page')?.id || 'app'
  if (el.classList.contains('wiki-chess-history-drawer')) return `${page}:controls`
  if (el.classList.contains('wiki-chess-game-settings-drawer')) return `${page}:settings`
  if (el.classList.contains('wiki-chess-board-settings-drawer')) return `${page}:board-settings`
  if (el.classList.contains('wiki-chess-thanks')) return `${page}:thanks`
  return `${page}:${[...el.classList].sort().join('.')}`
}

function readDrawerOpenMemory() {
  try {
    const raw = sessionStorage.getItem(drawerOpenStorageKey())
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeDrawerOpenMemory(state) {
  try {
    sessionStorage.setItem(drawerOpenStorageKey(), JSON.stringify(state))
  } catch {
    /* sessionStorage can be unavailable */
  }
}

// Expand game drawers by default; restore this tab's last open/closed set when present.
// Game settings and Attributions are the exception: they always boot collapsed,
// ignoring saved memory — older builds persisted their open default without a user
// click, so restoring it would keep reopening the panels.
export function wireDrawerOpenMemory() {
  if (drawerOpenMemoryWired) return
  drawerOpenMemoryWired = true
  const saved = readDrawerOpenMemory() || {}
  const state = { ...saved }
  document.querySelectorAll('details.wiki-chess-drawer').forEach(el => {
    // Settings / attributions boot collapsed (older builds persisted open without a click).
    // Board settings on position/puzzle used to ship with HTML open="" — same default.
    const alwaysStartClosed =
      el.classList.contains('wiki-chess-game-settings-drawer') ||
      el.classList.contains('wiki-chess-board-settings-drawer') ||
      el.classList.contains('wiki-chess-thanks')
    const id = drawerMemoryId(el)
    const open = alwaysStartClosed ? false : typeof saved[id] === 'boolean' ? saved[id] : true
    el.open = open
    state[id] = open
    el.addEventListener('toggle', () => {
      state[id] = el.open
      writeDrawerOpenMemory(state)
    })
  })
  writeDrawerOpenMemory(state)
}

export function collapseAttributionDrawers() {
  if (!ctx.isWikiEmbed && !ctx.isPopupLayout) return false
  let changed = false
  for (const el of document.querySelectorAll('details.wiki-chess-thanks[open]')) {
    el.open = false
    changed = true
  }
  if (changed) notifyAttributionLayoutChange()
  return changed
}

function notifyAttributionLayoutChange() {
  if (ctx.isWikiEmbed) {
    window.scheduleWikiHeightReport?.()
  } else if (ctx.isPopupLayout) {
    fitPopupBoard()
  }
}

// In wiki embed / popup, keep Attributions collapsed while the user works controls,
// opens other drawers, or brings up dialogs — an expanded list makes the item too tall.
export function wireAttributionAutoCollapse() {
  if (!ctx.isWikiEmbed && !ctx.isPopupLayout) return
  if (attributionAutoCollapseWired) return
  attributionAutoCollapseWired = true

  const wire = () => {
    document.addEventListener(
      'click',
      event => {
        const target = event.target instanceof Element ? event.target : null
        if (!target) return
        if (target.closest('.wiki-chess-thanks')) return
        const control = target.closest('button, .btn, a.btn, summary, input, select, textarea, [role="button"]')
        if (control) collapseAttributionDrawers()
      },
      { capture: true, passive: true },
    )

    document.addEventListener('show.bs.modal', () => {
      collapseAttributionDrawers()
    })

    for (const drawer of document.querySelectorAll('.wiki-chess-drawer:not(.wiki-chess-thanks)')) {
      drawer.addEventListener('toggle', () => {
        if (drawer.open) collapseAttributionDrawers()
      })
    }
  }

  if (document.readyState === 'loading') {
    ctx.whenDocumentReady(wire)
  } else {
    wire()
  }
}

// # Wiki Iframe Modal Mount

export function isWikiEmbedded() {
  return document.body.classList.contains('wiki-embedded')
}

function ensureStartSubmenu() {
  let submenu = document.getElementById('start-submenu')
  if (submenu) return submenu
  const fluid = document.querySelector('#start .container-fluid')
  if (!fluid) return null
  submenu = document.createElement('div')
  submenu.id = 'start-submenu'
  submenu.className = 'wiki-start-submenu'
  fluid.appendChild(submenu)
  return submenu
}

// Mount target for an in-flow modal embedded in the wiki iframe. On the CHOOSE menu we
// replace the menu like the setup dialogs do; `restore` brings it back if cancelled.
export function embeddedModalMount() {
  if (!isWikiEmbedded()) return { mount: document.body, embedded: false, restore: null }
  const startPage = document.getElementById('start')
  if (startPage && getComputedStyle(startPage).display !== 'none') {
    hideStartChooseMenu()
    const mount = ensureStartSubmenu() || document.querySelector('#start .container-fluid') || startPage
    return { mount, embedded: true, restore: () => showStartChooseMenu() }
  }
  for (const el of document.querySelectorAll('.page')) {
    if (getComputedStyle(el).display !== 'none') {
      const mount = el.querySelector('.container-fluid') || el
      // Hide the page's existing content so the in-flow dialog shows in its place
      // instead of being appended below the board/controls/attributions. `restore`
      // brings the page content back when the dialog is cancelled or submitted.
      const restore = hideMountContent(mount)
      return { mount, embedded: true, restore }
    }
  }
  return { mount: document.body, embedded: true, restore: null }
}

// Move a body-level dialog into the active wiki page mount so it grows the iframe
// in-flow instead of rendering as a clipped position:fixed overlay.
export function mountWikiEmbedBodyDialog(el, { embeddedClass = 'wiki-stockfish-setup-embedded' } = {}) {
  if (!isWikiEmbedded() || !(el instanceof HTMLElement)) {
    return { embedded: false, restore: null }
  }
  collapseAttributionDrawers()
  restoreEmbeddedMount()
  const { mount, restore: restoreMount } = embeddedModalMount()
  el.classList.add(embeddedClass)
  mount.appendChild(el)
  const teardown = () => {
    el.classList.remove(embeddedClass)
    el.hidden = true
    el.style.removeProperty('display')
    document.body.appendChild(el)
    restoreMount?.()
    registerMountRestore(null)
    registerBodyDialogOverlay(null)
    delete el._wikiBodyDialogState
  }
  const resume = () => {
    el.classList.add(embeddedClass)
    mount.appendChild(el)
    el.hidden = false
    el.style.removeProperty('display')
    registerMountRestore(teardown)
    registerBodyDialogOverlay(overlay)
    el._resumeKeyHandler?.()
    window.scheduleWikiHeightReport?.()
  }
  const isVisible = () => !el.hidden && getComputedStyle(el).display !== 'none'
  const suspend = () => {
    if (!isVisible()) return false
    el._cleanup?.()
    el._cleanup = null
    el.hidden = true
    el.style.display = 'none'
    document.body.appendChild(el)
    registerMountRestore(null)
    return true
  }
  const overlay = { suspend, resume, discard: teardown }
  el._wikiBodyDialogState = { mount, restoreMount, embeddedClass, teardown }
  registerBodyDialogOverlay(overlay)
  registerMountRestore(teardown)
  return { embedded: true, restore: teardown }
}

// Hide every current child of `mount` and return a function that restores them. New
// children added after this call (i.e. the modal root itself) are untouched.
function hideMountContent(mount) {
  if (!mount) return null
  const hidden = []
  for (const child of Array.from(mount.children)) {
    hidden.push([child, child.style.display])
    child.style.display = 'none'
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const [child, display] of hidden) child.style.display = display
  }
}

function hideStartChooseMenu() {
  const menu = document.getElementById('start-choose-menu')
  if (menu) {
    menu.hidden = true
    menu.style.display = 'none'
    return
  }
  const fluid = document.querySelector('#start .container-fluid')
  if (!fluid) return
  for (const child of fluid.children) {
    if (child.id === 'start-submenu') continue
    child.hidden = true
    child.style.display = 'none'
  }
}

function showStartChooseMenu() {
  const menu = document.getElementById('start-choose-menu')
  if (menu) {
    menu.hidden = false
    menu.style.display = ''
    return
  }
  const fluid = document.querySelector('#start .container-fluid')
  if (!fluid) return
  for (const child of fluid.children) {
    if (child.id === 'start-submenu') continue
    child.hidden = false
    child.style.display = ''
  }
}

// Undo hideStartChooseMenu / a stranded dialog mount so CHOOSE buttons stay clickable.
export function ensureStartMenuVisible() {
  clearViewportBlockingModals()
  restoreEmbeddedMount()
  showStartChooseMenu()
  ensureMountContentVisible('#start .container-fluid')
}

// Undo hideMountContent when a dialog closed without calling its restore callback
// (e.g. changePage to the leaderboard while a gate modal was still mounted).
export function ensureMountContentVisible(mountSelector) {
  const mount = typeof mountSelector === 'string' ? document.querySelector(mountSelector) : mountSelector
  if (!mount) return
  for (const child of mount.children) {
    if (child.classList?.contains('wiki-modal-root')) continue
    if (child.classList?.contains('wiki-fen-start-modal')) continue
    if (child.style.display === 'none') child.style.display = ''
    if (child.hidden) child.hidden = false
  }
  const puzzleError = mount.querySelector('#puzzle-load-error')
  const puzzleErrorVisible = Boolean(puzzleError && !puzzleError.hidden)
  for (const nested of mount.querySelectorAll(
    '#puzzle-loaded, #puzzle-console-container, .wiki-fen-board, .cm-fen-editor .chessboard',
  )) {
    if (nested.id === 'puzzle-loaded' && puzzleErrorVisible) continue
    if (nested.style.display === 'none') nested.style.display = ''
    if (nested.hidden) nested.hidden = false
  }
  if (mount.querySelector('#puzzle-loaded:not([hidden])') && puzzleError) {
    puzzleError.hidden = true
  }
}

export function openWithEmbeddedMount(openFn, opts = {}, onLayoutChange = null) {
  collapseAttributionDrawers()
  // Suspend any open dialog before we hide mount children for the new one — otherwise
  // hideMountContent can conceal the start-game modal before it is stashed.
  suspendForStacking()
  const { mount, embedded, restore } = embeddedModalMount()
  registerMountRestore(restore)
  const wrapConfirm = fn =>
    fn
      ? (...args) => {
          registerMountRestore(null)
          return fn(...args)
        }
      : undefined
  openFn({
    ...opts,
    mount,
    embedded,
    onLayoutChange: onLayoutChange ?? opts.onLayoutChange ?? null,
    onConfirm: wrapConfirm(opts.onConfirm),
    onCancel: opts.onCancel,
    onSave: wrapConfirm(opts.onSave),
    onClaim: opts.onClaim,
    onInvite: host => {
      const result = opts.onInvite?.(host)
      if (result !== false) registerMountRestore(null)
      return result
    },
    onApply: wrapConfirm(opts.onApply),
  })
}

// Center a confirm dialog over the live board (wiki embed and popup). Falls back to a
// normal fixed overlay when no board is mounted (e.g. before the console boots).
export function openBoardOverlayConfirmModal(openFn, opts = {}, onLayoutChange = null) {
  const wrap = document.querySelector('.chess-console-board-wrap')
  if (!wrap) {
    if (isWikiEmbedded()) {
      openWithEmbeddedMount(openFn, opts, onLayoutChange)
    } else {
      openFn({ ...opts, onLayoutChange: onLayoutChange ?? opts.onLayoutChange ?? null })
    }
    return
  }
  suspendForStacking()
  openFn({
    ...opts,
    mount: wrap,
    embedded: true,
    boardOverlay: true,
    onLayoutChange: onLayoutChange ?? opts.onLayoutChange ?? null,
  })
}

// # Paste Capture

let pasteSite

export function initPasteHandling(context) {
  pasteSite = context
}

function isEditablePasteTarget(target) {
  const el = target?.nodeType === 1 ? target : target?.parentElement
  if (!el) return false
  if (el.closest?.('[contenteditable="true"]')) return true
  const tag = el.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}

function pasteIsNoop(payload) {
  if (!payload?.actionable) return false
  let live = ''
  try {
    live = pasteSite.exportChessText({ liveBoardText: true })
  } catch {
    live = ''
  }
  const chessState = pasteSite.getAppState()
  return Paste.matchesCurrent(payload, live) || Paste.matchesCurrent(payload, chessState?.chessState)
}

function withPasteNoopOption(payload, options = {}) {
  if (!pasteIsNoop(payload)) return options
  const what = payload.format === 'FEN' || payload.format === 'FIGURINE' ? 'position' : 'game'
  return {
    ...options,
    unchanged: true,
    unchangedMessage: `That's the same ${what} that's already loaded here — nothing will change.`,
  }
}

function enrichPasteModalOptions(payload, options = {}) {
  const base = withPasteNoopOption(payload, options)
  if (base.unchanged || !payload.actionable) return base
  const canPersist = base.canPersist !== false
  let currentText = ''
  try {
    currentText = pasteSite?.exportChessText?.({ liveBoardText: true }) || pasteSite?.getAppState?.()?.chessState || ''
  } catch {
    currentText = pasteSite?.getAppState?.()?.chessState || ''
  }
  const canReplaceCurrent = Paste.canReplaceCurrentItem(currentText)
  const enriched = {
    ...base,
    applyLabel: Paste.applyLabel(canPersist),
    canReplaceCurrent,
  }
  if (pasteSite?.canCreatePasteGhost?.()) {
    enriched.createNewLabel = Paste.createNewLabel(payload)
    enriched.canCreateNew = true
    enriched.onCreateNew = confirmed => pasteSite.requestPastePreview?.(confirmed)
  }
  return enriched
}

let lastPasteHandledAt = 0

function isPasteShortcut(event) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'v'
}

async function readClipboardPlainText(event) {
  const fromEvent = event?.clipboardData?.getData?.('text/plain')
  if (fromEvent?.trim()) return fromEvent
  // `paste` carries clipboardData; only fall back to the async Clipboard API for the
  // keydown path (Ctrl/Cmd+V on non-editable targets that never fire `paste`).
  if (event?.type === 'paste') return ''
  try {
    const text = await navigator.clipboard?.readText?.()
    if (text?.trim()) return text
  } catch {
    // Clipboard read can fail without permission or in some embed contexts.
  }
  return ''
}

function reportEmbedHeight() {
  window.scheduleWikiHeightReport?.()
}

// Ask the wiki shell to scroll this item into view — call only after a user action.
export function requestWikiEmbedScrollIntoView() {
  if (typeof window === 'undefined') return
  window.requestWikiEmbedScrollIntoView?.()
}

function openPasteConfirmEmbedded(payload, modalOptions = {}) {
  if (!payload?.actionable && !modalOptions.unchanged) return
  openWithEmbeddedMount(
    opts => openPasteConfirmModal(payload, opts),
    modalOptions,
    () => {
      reportEmbedHeight()
      requestWikiEmbedScrollIntoView()
    },
  )
}

function offerPasteConfirm(text, { surface, onApply, canPersist, getCanPersist, persistLabel }) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return
  const now = Date.now()
  if (now - lastPasteHandledAt < 150) return
  const payload = Paste.capture(trimmed, surface)
  const persist = getCanPersist ? getCanPersist() : canPersist !== false
  const modalOptions = enrichPasteModalOptions(payload, { onApply, canPersist: persist, persistLabel })
  if (!payload.actionable && !modalOptions.unchanged) return
  lastPasteHandledAt = now
  openPasteConfirmEmbedded(payload, modalOptions)
}

export function wireDocumentPasteCapture({ surface, onApply, canPersist, getCanPersist, persistLabel } = {}) {
  if (document._wikiPasteCaptureWired) return
  document._wikiPasteCaptureWired = true

  const handlePasteText = async event => {
    if (isEditablePasteTarget(event.target)) return
    const text = await readClipboardPlainText(event)
    if (!text?.trim()) return
    if (event.type === 'paste') event.preventDefault()
    offerPasteConfirm(text, { surface, onApply, canPersist, getCanPersist, persistLabel })
  }

  // Capture phase so a focused board SVG or other non-editable control can't swallow paste.
  document.addEventListener(
    'paste',
    event => {
      void handlePasteText(event)
    },
    true,
  )
  // Ctrl/Cmd+V often doesn't fire `paste` on non-editable elements (common on Windows).
  // Defer so a real `paste` event (with clipboardData) can run first.
  document.addEventListener(
    'keydown',
    event => {
      if (!isPasteShortcut(event)) return
      window.setTimeout(() => {
        void handlePasteText(event)
      }, 0)
    },
    true,
  )
}

export function confirmPasteFromText(text, { surface = 'iframe', ...modalOptions } = {}) {
  const payload = Paste.capture(text, surface)
  const enriched = enrichPasteModalOptions(payload, modalOptions)
  if (!payload.actionable && !enriched.unchanged) return
  openPasteConfirmEmbedded(payload, enriched)
}

// # PWA and Popup Lifecycle
// Why four runtime modes matter for install/offline:
//   wiki iframe embed — never register a service worker (shares /plugins/chess/ scope;
//     SW control from an embed breaks chess-app.js loading).
//   wiki popup — register SW + show install nudge; postMessage to opener.
//   direct tab — same as popup without opener; opens CHOOSE menu via bootStandalone().
//   installed PWA — register SW, HTTP bridge via /plugin/chess/pwa, optional local-only halo.

let pwaCtx

export function initPwaPopup(context) {
  pwaCtx = context
}

// # PWA Page Title Chrome

let pwaPageChromeHost

export function initPwaPageChrome(context) {
  pwaPageChromeHost = context
}

function wirePwaPageChrome() {
  const titleInput = document.getElementById('wikiChessPwaPageTitle')
  if (titleInput && !titleInput._wikiPwaPageWired) {
    titleInput._wikiPwaPageWired = true
    titleInput.addEventListener('input', () => {
      pwaPageChromeHost?.onPageTitleInput?.(titleInput.value)
    })
  }
  const saveBtn = document.getElementById('wikiChessPwaSaveToWikiBtn')
  if (saveBtn && !saveBtn._wikiPwaSaveWired) {
    saveBtn._wikiPwaSaveWired = true
    saveBtn.addEventListener('click', () => void pwaPageChromeHost?.onPutJournal?.())
  }
  const titleLink = document.getElementById('wikiChessPwaPageTitleLink')
  if (titleLink && !titleLink._wikiPwaLinkWired) {
    titleLink._wikiPwaLinkWired = true
    titleLink.addEventListener('click', event => {
      event.preventDefault()
      const href = titleLink.getAttribute('href')
      pwaPageChromeHost?.onOpenWikiPage?.(href)
    })
  }
}

export function readPwaPageChromeStatus(statusEl) {
  return statusEl?.dataset?.pwaStatus || ''
}

// Allowed automatic transitions when updatePwaPageChrome refreshes status from state.
export function shouldTransitionPwaStatus(current, next) {
  if (next === 'creating') return current !== 'creating' && current !== 'error'
  if (next === 'saved') return current !== 'saved' && current !== 'creating' && current !== 'error'
  if (next === 'journaling') {
    return current !== 'journaling' && current !== 'creating' && current !== 'error' && current !== 'saved'
  }
  if (next === 'local-only') {
    return current !== 'local-only' && current !== 'creating' && current !== 'error'
  }
  return true
}

export function updatePwaPageChromeStatus(state, err = null, savedTitle = '', { canWrite = false } = {}) {
  const status = document.getElementById('wikiChessPwaPageStatus')
  if (!status) return
  status.hidden = false
  status.dataset.pwaStatus = state
  status.classList.remove('is-creating', 'is-saved', 'is-error', 'is-local-only', 'is-journaling')
  if (state === 'creating') {
    status.classList.add('is-creating')
    status.innerHTML =
      '<i class="fas fa-spinner fa-spin fa-fw" aria-hidden="true"></i> Creating this page on your wiki…'
    return
  }
  if (state === 'saved') {
    status.classList.add('is-saved')
    status.textContent = savedTitle ? `Saved on your wiki as “${savedTitle}”.` : 'Saved on your wiki.'
    return
  }
  if (state === 'journaling') {
    status.classList.add('is-journaling')
    status.textContent = 'Edits save to this wiki page.'
    return
  }
  if (state === 'local-only') {
    status.classList.add('is-local-only')
    status.textContent = canWrite
      ? 'Not on a wiki yet — edits stay on this device until you save.'
      : 'Not signed in — changes stay on this device only and are not saved to any wiki.'
    return
  }
  if (state === 'error') {
    status.classList.add('is-error')
    status.textContent = String(err?.message || err || 'Could not create the wiki page. Try again.')
  }
}

// Drop sticky chrome status so a page switch can paint journaling/saved fresh.
export function clearPwaPageChromeStatus() {
  const status = document.getElementById('wikiChessPwaPageStatus')
  if (!status) return
  status.hidden = true
  status.dataset.pwaStatus = ''
  status.textContent = ''
  status.classList.remove('is-creating', 'is-saved', 'is-error', 'is-local-only', 'is-journaling')
}

function pwaChromeWikiSlug(state, host) {
  const fromState = String(state?.wikiPageName || '').trim()
  if (fromState && fromState !== 'standalone' && fromState !== 'page') return fromState
  const ctx = host?.getPwaWikiContext?.() || getPwaWikiContext()
  const fromCtx = String(ctx?.slug || '').trim()
  if (fromCtx && fromCtx !== 'standalone' && fromCtx !== 'page') return fromCtx
  return ''
}

function pwaChromeWikiHost(state, host) {
  const fromState = String(state?.wikiSite || '').trim()
  if (fromState) return fromState.replace(/^[a-z]+:\/\//i, '').split('/')[0]
  try {
    return String(host?.wikiHost?.() || globalThis.location?.host || '').trim()
  } catch {
    return String(globalThis.location?.host || '').trim()
  }
}

export function updatePwaPageChrome() {
  const host = pwaPageChromeHost
  if (!host) return
  const state = host.chessState
  const wrap = document.getElementById('wikiChessPwaPageChromePage')
  const chrome = document.getElementById('wikiChessPwaPageChrome')
  const titleInput = document.getElementById('wikiChessPwaPageTitle')
  const titleLink = document.getElementById('wikiChessPwaPageTitleLink')
  const lead = document.getElementById('wikiChessPwaPageLead')
  if (!chrome || !titleInput) return

  const signedIn = Boolean(host.pwaSessionResolved && host.canWriteJournalHere?.())
  const localOnly = host.isPwaJournalless?.()
  const slug = pwaChromeWikiSlug(state, host)
  const policy = localSessionUiPolicy({
    isStandalone: true,
    isPwaJournalless: localOnly,
    sessionResolved: host.pwaSessionResolved,
    sessionReachable: host.pwaSessionReachable,
    signedIn,
    showStartMenu: state?.showStartMenu,
    hasWikiPageTitle: Boolean(state?.wikiPageTitle),
    hasWikiPageSlug: Boolean(slug),
    pendingJoinOrItem: Boolean(state?.pwaChallengeJoinPending || state?.pwaChessItemPending),
  })
  const show = host.pwaBridgeActive && state?.pwaWikiPageChrome && policy.showPwaPageChrome

  if (!show) {
    if (wrap) wrap.hidden = true
    host.syncLocalOnlyHalo?.()
    return
  }

  wirePwaPageChrome()
  if (wrap) wrap.hidden = false
  const joinCtx = state?.pwaChallengeJoinContext
  const chessCtx = state?.pwaChessItemContext
  const title = String(state?.wikiPageTitle || joinCtx?.proposedTitle || chessCtx?.proposedTitle || slug || '').trim()
  if (titleInput.value !== title) titleInput.value = title
  titleInput.disabled = !policy.titleEditable

  const showLink = Boolean(policy.titleAsLink && titleLink && slug)
  if (titleLink) {
    if (showLink) {
      const href = wikiSitePageUrl(pwaChromeWikiHost(state, host), slug)
      titleLink.hidden = !href
      titleLink.href = href || '#'
      titleLink.textContent = title || slug
      titleLink.title = href ? `Open ${title || slug} on the wiki` : ''
    } else {
      titleLink.hidden = true
      titleLink.removeAttribute('href')
      titleLink.textContent = ''
    }
  }
  titleInput.hidden = showLink

  if (lead) {
    if (joinCtx?.creatorLabel) {
      lead.hidden = false
      lead.textContent = openChallengeAcceptParagraph(joinCtx.joinerLabel, joinCtx.creatorLabel)
    } else if (chessCtx?.lead) {
      lead.hidden = false
      lead.textContent = chessCtx.lead
    } else {
      lead.hidden = true
      lead.textContent = ''
    }
  }

  const actions = document.getElementById('wikiChessPwaPageActions')
  const saveBtn = document.getElementById('wikiChessPwaSaveToWikiBtn')
  if (actions && saveBtn) {
    const showSave = policy.showSaveToWiki
    actions.hidden = !showSave
    saveBtn.hidden = !showSave
    installAuthGatedClickGuard(actions)
    setAuthGatedButton(saveBtn, host.canWriteJournalHere?.(), {
      titleWhenEnabled: 'Create a wiki page and save this activity to your journal',
      titleWhenDisabled: host.pwaAuthGateTitle?.(),
    })
  }

  const status = document.getElementById('wikiChessPwaPageStatus')
  const currentStatus = readPwaPageChromeStatus(status)
  if (state?.pwaChallengeJoinPending || state?.pwaChessItemPending) {
    if (status && shouldTransitionPwaStatus(currentStatus, 'creating')) {
      updatePwaPageChromeStatus('creating')
    }
  } else if (localOnly) {
    // Refresh copy when auth flips while already local-only (signed in vs not).
    if (status && (shouldTransitionPwaStatus(currentStatus, 'local-only') || currentStatus === 'local-only')) {
      updatePwaPageChromeStatus('local-only', null, '', { canWrite: Boolean(host.canWriteJournalHere?.()) })
    }
  } else if (showLink) {
    if (status && shouldTransitionPwaStatus(currentStatus, 'journaling')) {
      updatePwaPageChromeStatus('journaling')
    }
  } else if (status && slug && state?.wikiPageTitle && shouldTransitionPwaStatus(currentStatus, 'saved')) {
    // Only claim "Saved on your wiki" when a real page slug exists (not title-only chrome).
    updatePwaPageChromeStatus('saved', null, state.wikiPageTitle)
  }

  host.syncLocalOnlyHalo?.()
  host.notifyWikiHeight?.()
  // Board may still be laying out; sync now and again next frame.
  syncPwaPageChromeBoardAlign()
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => syncPwaPageChromeBoardAlign())
  }
}

function restorePwaContext() {
  const params = new URLSearchParams(location.search)
  let itemId = params.get('itemId')
  let pageKey = params.get('pageKey')
  if (!itemId || !pageKey) {
    try {
      const saved = JSON.parse(sessionStorage.getItem('wiki-chess-pwa-ctx') || 'null')
      if (saved?.itemId) itemId = itemId || saved.itemId
      if (saved?.pageKey) pageKey = pageKey || saved.pageKey
    } catch {
      /* ignore */
    }
  }
  return {
    itemId: itemId || 'standalone',
    pageKey: pageKey || 'standalone',
  }
}

export function pwaStoragePrefix(storageCtx = restorePwaContext()) {
  return `WikiChess-${storageCtx.pageKey}-${storageCtx.itemId}`
}

function popupStateStorageKey() {
  return `${pwaStoragePrefix(restorePwaContext())}PopupState`
}

const POPUP_AUTH_KEYS = [
  'signedInDisplayName',
  'pageOnThisWiki',
  'ownerCanJournalHere',
  'viewerCanClaimWikiSeat',
  'viewerSeatId',
  'viewerAuthenticated',
  'guestLocalStoragePersist',
]

function popupAuthFields(state) {
  if (!state || typeof state !== 'object') return {}
  const out = {}
  const displayName = state.signedInDisplayName || state.ownerName
  if (displayName) out.signedInDisplayName = displayName
  for (const key of POPUP_AUTH_KEYS) {
    if (key === 'signedInDisplayName') continue
    if (state[key] !== undefined) out[key] = state[key]
  }
  return out
}

function hasPopupAuthFields(auth) {
  return Boolean(
    auth.signedInDisplayName ||
      auth.pageOnThisWiki ||
      auth.ownerCanJournalHere ||
      auth.viewerCanClaimWikiSeat ||
      auth.viewerAuthenticated,
  )
}

// Session-only handoff for a popup that reloads before the wiki parent re-adopts it.
// Not a durability SSOT — every ply must journal through the wiki shell
// (`pageHandler.put` → origin, or yellow-halo local on failure).
// Also keeps wiki auth flags so a mobile reload does not stick the padlock locked
// while waiting for the opener to re-send SET_STATE / VIEWER_CONTEXT.
export function rememberPopupState(state) {
  const text = state?.PGN || state?.chessState || state?.FEN
  const auth = popupAuthFields(state)
  const hasText = Boolean(text && typeof text === 'string')
  if (!hasText && !hasPopupAuthFields(auth)) return
  const prev = loadPopupState() || {}
  const format = hasText
    ? state?.format || getFormat(text) || 'PGN'
    : state?.format || prev.format || 'MENU'
  const payload = {
    ...prev,
    savedAt: Date.now(),
    format,
    mode: state?.mode ?? prev.mode,
    playerColor: state?.playerColor ?? prev.playerColor,
    gameType: state?.gameType ?? prev.gameType,
    gameSettings: state?.gameSettings ?? prev.gameSettings,
    itemId: state?.itemId || prev.itemId || restorePwaContext().itemId,
    pageKey: state?.pageKey || prev.pageKey || restorePwaContext().pageKey,
    ...auth,
  }
  if (hasText) {
    payload.PGN = format === 'PGN' ? text : state?.PGN
    payload.FEN = format === 'FEN' ? text : state?.FEN
    payload.chessState = text
  }
  try {
    sessionStorage.setItem(popupStateStorageKey(), JSON.stringify(payload))
  } catch {
    /* sessionStorage can be unavailable */
  }
}

function loadPopupState() {
  try {
    const raw = sessionStorage.getItem(popupStateStorageKey())
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// Apply last-known auth flags into chessState before the opener answers. Safe no-op
// when nothing was saved or journal access is already established.
export function hydratePopupAuthFromSession(chessState) {
  if (!chessState || typeof chessState !== 'object') return false
  if (chessState.pageOnThisWiki || chessState.ownerCanJournalHere) return false
  const saved = loadPopupState()
  if (!saved || !hasPopupAuthFields(popupAuthFields(saved))) return false
  for (const key of POPUP_AUTH_KEYS) {
    if (saved[key] !== undefined && chessState[key] === undefined) chessState[key] = saved[key]
  }
  return Boolean(chessState.pageOnThisWiki || chessState.ownerCanJournalHere)
}

export function restorePopupWithoutOpener() {
  if (pwaCtx.receivedInitialState) return
  void bootFromSavedOrUrlOrMenu(restorePwaContext(), { allowPopupState: true })
}

// Pure boot mode from runtime flags (embed / popup / direct tab / installed PWA).
export function resolveBootIntent({ hasWikiFrame, isWikiPopup, isPwaStandalone }) {
  if (hasWikiFrame) return isWikiPopup ? 'WikiPopup' : 'Embed'
  if (isPwaStandalone) return 'InstalledPwa'
  return 'DirectTab'
}

async function bootFromSavedOrUrlOrMenu(
  storageCtx,
  { allowLocalSession = false, allowReloadClear = false, allowPopupState = false } = {},
) {
  if (pwaCtx.receivedInitialState) return true

  const puzzleState = puzzleStateFromUrl({
    itemId: storageCtx.itemId,
    pageKey: storageCtx.pageKey,
  })
  if (puzzleState) {
    pwaCtx.initializeChess(puzzleState)
    return true
  }

  if (allowPopupState) {
    const saved = loadPopupState()
    if (saved?.PGN) {
      pwaCtx.initializeChess({ ...saved, showStartMenu: false })
      return true
    }
  }

  const params = new URLSearchParams(location.search)
  const fenFromUrl = params.get('fen')
  if (fenFromUrl) {
    pwaCtx.initializeChess({
      format: 'FEN',
      FEN: fenFromUrl,
      itemId: storageCtx.itemId,
      pageKey: storageCtx.pageKey,
    })
    return true
  }

  if (allowReloadClear && isPwaDocumentReload()) {
    await clearPwaLocalSession()
    try {
      sessionStorage.removeItem('wiki-chess-pwa-ctx')
    } catch {
      /* sessionStorage can be unavailable */
    }
    pwaCtx.initializeChess({ showStartMenu: true, format: 'MENU' })
    return true
  }

  if (allowLocalSession) {
    const localSession = normalizeRestoredChessSession(await loadPwaLocalSession())
    if (
      localSession &&
      (localSession.PGN || localSession.FEN || localSession.chessState || localSession.puzzleResume)
    ) {
      pwaCtx.isolatePwaLocalWikiContext?.()
      pwaCtx.initializeChess({ ...localSession, showStartMenu: false, pwaJournalless: true })
      return true
    }
  }

  if (allowPopupState) {
    pwaCtx.initializeChess({ showStartMenu: true, format: 'MENU' })
    return true
  }

  if (allowLocalSession || allowReloadClear) {
    await clearPwaLocalSession()
    pwaCtx.initializeChess({ showStartMenu: true, format: 'MENU' })
    return true
  }

  return false
}

export async function bootPwa() {
  wirePwaLaunchQueue()
  const storageCtx = restorePwaContext()
  syncPwaUrlContext(storageCtx)
  rememberPwaContext()
  await bootFromSavedOrUrlOrMenu(storageCtx, { allowLocalSession: true, allowReloadClear: true })
}

export function rememberPwaContext() {
  if (!pwaCtx.isPwaStandalone) return
  const storageCtx = restorePwaContext()
  sessionStorage.setItem(
    'wiki-chess-pwa-ctx',
    JSON.stringify({
      itemId: pwaCtx.wikiItemId() || storageCtx.itemId,
      pageKey: new URLSearchParams(location.search).get('pageKey') || storageCtx.pageKey,
    }),
  )
}

function syncPwaUrlContext(storageCtx = restorePwaContext()) {
  if (!pwaCtx.isPwaStandalone || storageCtx.itemId === 'standalone') return
  const params = new URLSearchParams(location.search)
  if (params.get('itemId') && params.get('pageKey')) return
  params.set('itemId', storageCtx.itemId)
  params.set('pageKey', storageCtx.pageKey)
  const query = params.toString()
  history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname)
}

function wirePwaLaunchQueue() {
  if (!('launchQueue' in window) || typeof window.launchQueue?.setConsumer !== 'function') {
    return
  }
  window.launchQueue.setConsumer(params => {
    const target = params?.targetURL
    if (!target) return
    try {
      const url = new URL(target, location.href)
      if (url.href !== location.href) location.href = url.href
    } catch {
      /* ignore malformed launch URLs */
    }
  })
}

// True when this document load was a reload (F5 / hard refresh), not a cold launch.
export function isPwaDocumentReload() {
  try {
    const nav = performance.getEntriesByType('navigation')[0]
    return nav?.type === 'reload'
  } catch {
    return false
  }
}

export function bootStandalone() {
  const fenFromUrl = new URLSearchParams(window.location.search).get('fen')
  if (fenFromUrl) {
    pwaCtx.initializeChess({ format: 'FEN', FEN: fenFromUrl })
    return
  }

  // Bare /plugins/chess/index.html (install landing or direct tab) — CHOOSE menu.
  pwaCtx.initializeChess({ showStartMenu: true, format: 'MENU' })
}

let lastReportedPwaInstalled = null

export async function reportPwaInstalled() {
  if (!pwaCtx.wikiFrame || pwaCtx.isWikiPopup) return
  const installed = await queryChessPwaInstalled()
  if (installed === lastReportedPwaInstalled) return
  lastReportedPwaInstalled = installed
  shellMessengerFromContext(pwaCtx)?.pwaInstalled({ installed })
}

// Clear stale PWA resume for ephemeral open-seat seeks (no PGN resume write).
export function persistPwaState() {
  if (!pwaCtx.isPwaStandalone) return
  const pgn = pwaCtx.exportChessText()
  if (!pgn || getFormat(pgn) !== 'PGN') return
  // Toolbar / open-seat launches always open the choose menu; drop leftover
  // local-session resume blob so it does not rehydrate a seek.
  if (!isUnseatedFreshGamePgn(pgn)) return
  void clearPwaLocalSession()
}

const PWA_LOCAL_SESSION_IDB_NAME = 'wiki-chess-pwa-session'
const PWA_LOCAL_SESSION_IDB_STORE = 'session'
const PWA_LOCAL_SESSION_IDB_KEY = 'local'

const PWA_LOCAL_SESSION_FIELDS = [
  'format',
  'mode',
  'gameType',
  'PGN',
  'FEN',
  'chessState',
  'playerColor',
  'engineLevel',
  'gameSettings',
  'humanPlayMode',
  'bareKeywordGuard',
  'wikiPageTitle',
  'pwaChessItemContext',
  'puzzleResume',
]

function openPwaSessionIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const req = indexedDB.open(PWA_LOCAL_SESSION_IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PWA_LOCAL_SESSION_IDB_STORE)) {
        req.result.createObjectStore(PWA_LOCAL_SESSION_IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function pwaSessionIdbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function savePwaLocalSession(state) {
  if (!pwaCtx?.isPwaStandalone || !state || typeof state !== 'object') return
  const payload = { pwaJournalless: true, savedAt: Date.now() }
  for (const key of PWA_LOCAL_SESSION_FIELDS) {
    if (state[key] !== undefined) payload[key] = state[key]
  }
  try {
    const db = await openPwaSessionIdb()
    if (!db) return
    const tx = db.transaction(PWA_LOCAL_SESSION_IDB_STORE, 'readwrite')
    tx.objectStore(PWA_LOCAL_SESSION_IDB_STORE).put(payload, PWA_LOCAL_SESSION_IDB_KEY)
    await pwaSessionIdbTxDone(tx)
  } catch {
    /* IndexedDB can be unavailable */
  }
}

export async function loadPwaLocalSession() {
  try {
    const db = await openPwaSessionIdb()
    if (!db) return null
    const tx = db.transaction(PWA_LOCAL_SESSION_IDB_STORE, 'readonly')
    const stored = await new Promise((resolve, reject) => {
      const req = tx.objectStore(PWA_LOCAL_SESSION_IDB_STORE).get(PWA_LOCAL_SESSION_IDB_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
    await pwaSessionIdbTxDone(tx)
    if (stored && typeof stored === 'object') return stored
  } catch {
    /* IndexedDB can be unavailable */
  }
  return null
}

export async function clearPwaLocalSession() {
  try {
    const db = await openPwaSessionIdb()
    if (!db) return
    const tx = db.transaction(PWA_LOCAL_SESSION_IDB_STORE, 'readwrite')
    tx.objectStore(PWA_LOCAL_SESSION_IDB_STORE).delete(PWA_LOCAL_SESSION_IDB_KEY)
    await pwaSessionIdbTxDone(tx)
  } catch {
    /* IndexedDB can be unavailable */
  }
}

// # PWA HTTP Bridge
// Wiki iframe uses postMessage; installed PWA uses the server bridge. Inactive in
// popups and non-installed standalone tabs.

let pwaTransportCtx = null

// App context callbacks for sendTransport and runPwaBridgeMessage.
export function initPwaTransport(ctx) {
  pwaTransportCtx = ctx
}

export async function registerServiceWorker() {
  // Why: Chrome requires manifest + SW for install; index.html registers early, this waits for ready.
  if (!('serviceWorker' in navigator)) return
  if (ensurePwaProtocol()) return
  try {
    await registerChessServiceWorker()
    await navigator.serviceWorker.ready
  } catch (err) {
    console.warn('wiki-chess: service worker registration failed', err)
  }
}

export async function bridgeFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${PWA_BRIDGE_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text || res.statusText }
  }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'Bridge request failed')
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

const PWA_CLIENT_ONLY_ACTIONS = new Set([
  MSG.OPEN_SURVEY_PAGE,
  MSG.SHOW_CRAWL_HITS_PAGE,
  MSG.CREATE_PREVIEW,
  MSG.MODE_CHANGED,
  MSG.SHELL_SESSION_FLAGS,
  MSG.FETCH_UI,
  MSG.ALERT_UI,
  MSG.GAME_SETTINGS_CHANGED,
  MSG.PWA_INSTALLED,
  MSG.RESIZE,
  MSG.EMBED_WHEEL_SCROLL,
])

function dispatchPwaBridgeErrorReplies(msg, err) {
  const deliver = pwaTransportCtx?.deliverInboundShellMessage
  if (typeof deliver !== 'function') return
  if (msg.action === MSG.BUILD_CHALLENGES) {
    const errorMeta = { unavailable: true, error: String(err.message || err) }
    const localOpenChallenges = Array.isArray(msg.localOpenChallenges)
      ? msg.localOpenChallenges
      : Array.isArray(msg.localOpenSeeks)
        ? msg.localOpenSeeks
        : []
    deliver({
      action: MSG.SURVEY_OPEN_CHALLENGES_DATA,
      openChallenges: localOpenChallenges,
      meta: errorMeta,
      seq: msg.seq,
    })
    return
  }
  if (msg.action === MSG.BUILD_SITE_SURVEY_ENRICH) {
    deliver({
      action: MSG.SURVEY_SITE_GAMES_DATA,
      games: [],
      seq: msg.seq,
    })
  }
  if (msg.action === MSG.BUILD_LEADERBOARD) {
    deliver({
      action: MSG.LEADERBOARD_DATA,
      entries: [],
      meta: { unavailable: true, error: String(err.message || err) },
      seq: msg.seq,
    })
  }
  if (msg.action === MSG.SURVEY_STATUS) {
    deliver({
      action: MSG.SURVEY_STATE,
      hasRatedGame: false,
    })
  }
}

async function runPwaBridgeMessage(msg, bridgeCtx = {}) {
  if (!msg?.action) return false

  if (msg.action === MSG.OPEN_GAME_PAGE) {
    if (msg.ghost && msg.pgn && msg.challenge) {
      pwaTransportCtx?.onOpenChallengeJoinPreview?.(msg)
      return true
    }
    // Stay in-app: load via /game-state (same path as PWA boot), not wiki lineup.
    void openPwaGamePage(msg)
    return true
  }

  if (PWA_CLIENT_ONLY_ACTIONS.has(msg.action)) return true

  const ctx = pwaTransportCtx?.getPwaWikiContext?.() || {}
  try {
    const data = await bridgeFetch('/dispatch', {
      method: 'POST',
      body: {
        msg,
        ctx: {
          itemId: bridgeCtx.itemId || ctx.itemId,
          slug: bridgeCtx.pageKey || ctx.slug,
        },
      },
    })
    if (data?.session && bridgeCtx.onContextUpdate) {
      bridgeCtx.onContextUpdate(data.session)
    }
    if (data?.pwaContext) {
      setPwaWikiContext(data.pwaContext)
    }
    const deliver = pwaTransportCtx?.deliverInboundShellMessage
    if (typeof deliver === 'function') {
      for (const reply of data.replies || []) {
        deliver(reply)
      }
    }
  } catch (err) {
    console.warn('wiki-chess PWA bridge:', err)
    dispatchPwaBridgeErrorReplies(msg, err)
  }
  return true
}

// Open a journaled game inside the installed PWA (My Chess Games click).
async function openPwaGamePage(msg) {
  const slug = String(msg.slug || '').trim()
  const itemId = String(msg.itemId || '').trim()
  if (!slug || !itemId) return

  const site = normalizeWikiSite(msg.site || '')
  const local = normalizeWikiSite(typeof location !== 'undefined' ? location.host : '')
  if (site && local && site !== local) {
    console.warn('wiki-chess PWA open game: remote site not supported', site)
    return
  }

  try {
    const data = await loadPwaGameState(slug, itemId)
    if (!data?.chessObj) {
      console.warn('wiki-chess PWA open game: not found', slug, itemId)
      return
    }
    const deliver = pwaTransportCtx?.deliverInboundShellMessage
    deliver?.({
      action: MSG.SET_STATE,
      itemId: data.itemId || itemId,
      replaceInPlace: true,
      chessObj: {
        ...data.chessObj,
        showStartMenu: false,
        wikiPageName: data.chessObj.wikiPageName || slug,
        wikiPageTitle: data.chessObj.wikiPageTitle || msg.title || slug,
      },
    })
  } catch (err) {
    console.warn('wiki-chess PWA open game:', err)
  }
}

let onPwaContextChanged = null

export function setPwaContextChangedHandler(fn) {
  onPwaContextChanged = typeof fn === 'function' ? fn : null
}

let pwaWikiContext = { slug: null, itemId: null, title: null }

export function getPwaWikiContext() {
  return { ...pwaWikiContext }
}

export function setPwaWikiContext({ slug, itemId, title } = {}) {
  if (slug != null) pwaWikiContext.slug = slug
  if (itemId != null) pwaWikiContext.itemId = itemId
  if (title != null) pwaWikiContext.title = title
  try {
    if (pwaWikiContext.slug && pwaWikiContext.itemId) {
      sessionStorage.setItem(
        'wiki-chess-pwa-ctx',
        JSON.stringify({
          itemId: pwaWikiContext.itemId,
          pageKey: pwaWikiContext.slug,
        }),
      )
      const params = new URLSearchParams(location.search)
      if (pwaWikiContext.itemId !== 'standalone') params.set('itemId', pwaWikiContext.itemId)
      if (pwaWikiContext.slug && pwaWikiContext.slug !== 'standalone') {
        params.set('pageKey', pwaWikiContext.slug)
      }
      const query = params.toString()
      history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname)
    }
  } catch {
    /* sessionStorage / history can be unavailable */
  }
  onPwaContextChanged?.(getPwaWikiContext())
}

export async function loadPwaGameState(slug, itemId) {
  if (!slug || !itemId || slug === 'standalone' || itemId === 'standalone') return null
  const data = await bridgeFetch(`/game-state?slug=${encodeURIComponent(slug)}&itemId=${encodeURIComponent(itemId)}`)
  if (data?.chessObj) {
    setPwaWikiContext({ slug, itemId, title: data.chessObj.wikiPageTitle })
  }
  return data
}

export async function fetchPwaSession() {
  return bridgeFetch('/session')
}

let inboundShellDispatch = null

// Wire shell/PWA inbound postMessage dispatch (chess-app registers handlers at boot).
export function initInboundShellMessageBridge({ dispatch, getOrigin = () => window.origin } = {}) {
  inboundShellDispatch = dispatch
  if (typeof window === 'undefined') return
  window.addEventListener('message', event => {
    if (event.origin !== getOrigin()) return
    deliverInboundShellMessage(event.data)
  })
}

export function deliverInboundShellMessage(data) {
  if (!data || typeof data !== 'object' || !data.action) return false
  return inboundShellDispatch?.(data.action, { data, origin: window.origin }) ?? false
}

// Routes app→wiki traffic through the wiki shell postMessage bridge or the PWA HTTP bridge.
export function sendTransport(msg, bridgeCtx = {}) {
  if (!msg?.action) return null
  const payload = { ...msg }
  const wikiFrame = pwaTransportCtx?.getWikiFrame?.()
  if (wikiFrame) {
    wikiFrame.postMessage(payload, window.origin)
    return 'shell'
  }
  if (pwaTransportCtx?.isPwaBridgeActive?.()) {
    void runPwaBridgeMessage(payload, bridgeCtx)
    return 'pwa'
  }
  return null
}

// Prefer ctx.wiki; fall back to a messenger wrapped around the postToShell callback.
export function shellMessengerFromContext(ctx) {
  if (!ctx) return null
  if (ctx.wiki) return ctx.wiki
  if (typeof ctx.postToShell === 'function') return createShellMessenger(ctx.postToShell)
  return null
}

// Adds default itemId/pageKey to outbound shell messages when the caller omitted them.
export function enrichTransport(msg, { itemId = '', pageKey = '' } = {}) {
  if (!msg || typeof msg !== 'object') return msg
  const payload = { ...msg }
  if (itemId && payload.itemId == null) payload.itemId = itemId
  if (pageKey && payload.pageKey == null && payload.action !== MSG.UPDATE_GHOST_PAGE_TITLE) {
    payload.pageKey = pageKey
  }
  return payload
}

// True when the installed PWA is playing locally without a wiki journal target yet.
export function isPwaJournallessSession({
  pwaBridgeActive = false,
  pwaJournalless = false,
  pwaChessItemPending = false,
} = {}) {
  return Boolean(pwaBridgeActive && pwaJournalless && !pwaChessItemPending)
}

// Yellow halo: unsigned local-only PWA play (not while auth is still resolving).
export function showLocalOnlyHalo({
  isStandalone = false,
  isPwaJournalless = false,
  sessionResolved = false,
  canJournal = false,
} = {}) {
  return localSessionUiPolicy({
    isStandalone,
    isPwaJournalless,
    sessionResolved,
    canJournal,
  }).showHalo
}

// Toggle the document class that marks a local-only PWA session in CSS.
export function applyLocalOnlyHalo(isStandalone, showHalo) {
  if (!isStandalone || typeof document === 'undefined') return
  document.documentElement.classList.toggle('wiki-pwa-local-only', Boolean(showHalo))
  document.body.classList.toggle('wiki-pwa-local-only', Boolean(showHalo))
}

// # Wiki Transport
// Why shellMessengerFromContext: submodules receive ctx from chess-app and must not call raw postToShell(MSG.*).
// buildTransportApi keeps createShellMessenger and shellTransport in sync.

// Build semantic wiki.* helpers from a single dispatch function.
function buildTransportApi(dispatch) {
  const m = (action, { spread = true, scalar = null } = {}) => {
    if (scalar) return value => dispatch({ action, [scalar]: value })
    if (!spread) return () => dispatch({ action })
    return payload => dispatch({ action, ...(payload && typeof payload === 'object' ? payload : {}) })
  }
  return {
    send: dispatch,
    getState: m(MSG.GET_STATE, { spread: false }),
    popupReady: m(MSG.POPUP_READY),
    requestViewerContext: m(MSG.REQUEST_VIEWER_CONTEXT, { scalar: 'itemId' }),
    gameSettingsChanged: m(MSG.GAME_SETTINGS_CHANGED),
    positionChanged: m(MSG.POSITION_CHANGED),
    modeChanged: m(MSG.MODE_CHANGED),
    challengeChanged: m(MSG.CHALLENGE_CHANGED),
    shellSessionFlags: m(MSG.SHELL_SESSION_FLAGS),
    createPreview: m(MSG.CREATE_PREVIEW),
    createPastePreview: m(MSG.CREATE_PASTE_PREVIEW),
    updateGhostPageTitle: m(MSG.UPDATE_GHOST_PAGE_TITLE),
    syncGhostPreviewText: m(MSG.SYNC_GHOST_PREVIEW_TEXT),
    openItemEditor: m(MSG.OPEN_ITEM_EDITOR, { spread: false }),
    savePosition: m(MSG.SAVE_POSITION, { spread: false }),
    requestResign: m(MSG.REQUEST_RESIGN, { spread: false }),
    requestSignIn: m(MSG.REQUEST_SIGN_IN, { spread: false }),
    finalizeMatch: m(MSG.FINALIZE_MATCH),
    buildLeaderboard: m(MSG.BUILD_LEADERBOARD),
    buildChallenges: m(MSG.BUILD_CHALLENGES),
    enrichSiteSurvey: m(MSG.BUILD_SITE_SURVEY_ENRICH),
    discoverRatings: m(MSG.DISCOVER_RATINGS),
    remoteWatch: m(MSG.REMOTE_WATCH),
    forkRemotePage: m(MSG.FORK_REMOTE_PAGE),
    registerNeighbors: m(MSG.REGISTER_NEIGHBORS),
    openSurveyPage: m(MSG.OPEN_SURVEY_PAGE),
    openLeaderboardPage: m(MSG.OPEN_LEADERBOARD_PAGE),
    openGamePage: m(MSG.OPEN_GAME_PAGE),
    showCrawlHitsPage: m(MSG.SHOW_CRAWL_HITS_PAGE),
    lookupSiteDisplay: m(MSG.LOOKUP_SITE_DISPLAY),
    fetchPuzzlePages: m(MSG.FETCH_PUZZLE_PAGES),
    fetchLocalAcademyProgress: m(MSG.FETCH_LOCAL_ACADEMY_PROGRESS),
    surveyStatus: m(MSG.SURVEY_STATUS, { spread: false }),
    fetchUi: m(MSG.FETCH_UI),
    alertUi: m(MSG.ALERT_UI),
    abandonFetches: m(MSG.ABANDON_FETCHES, { spread: false }),
    realtimePresence: m(MSG.REALTIME_PRESENCE),
    realtimeSignal: m(MSG.REALTIME_SIGNAL),
    realtimeStatus: m(MSG.REALTIME_STATUS),
    requestRealtimeStatus: m(MSG.REQUEST_REALTIME_STATUS, { spread: false }),
    requestSwitchGameMode: m(MSG.REQUEST_SWITCH_GAME_MODE, { spread: false }),
    pasteApply: m(MSG.PASTE_APPLY),
    gameReady: m(MSG.GAME_READY),
    resize: m(MSG.RESIZE),
    stateExported: m(MSG.STATE_EXPORTED),
    pwaInstalled: m(MSG.PWA_INSTALLED),
    embedWheelScroll: m(MSG.EMBED_WHEEL_SCROLL),
  }
}

// Semantic wrappers around postToShell — keeps MSG action names in one module.
export function createShellMessenger(postToShell) {
  return buildTransportApi(payload => postToShell(payload))
}

// Typed wiki transport — one API for iframe postMessage and PWA HTTP bridge.
export const shellTransport = buildTransportApi(msg => sendTransport(msg))

// # Namespace Exports

// Wiki transport surface — prefer Transport.* (or `import * as BoardLayout`) over new flat imports.
export const Transport = Object.freeze({
  send: sendTransport,
  enrich: enrichTransport,
  createShellMessenger,
  shellMessengerFromContext,
  shellTransport,
  initInboundShellMessageBridge,
  deliverInboundShellMessage,
  isPwaJournallessSession,
  applyLocalOnlyHalo,
})

// Installed-PWA / popup session surface — prefer PWA.* over new flat aliases.
export const PWA = Object.freeze({
  BRIDGE_BASE: PWA_BRIDGE_BASE,
  isInstalled: isInstalledPwa,
  matchInstalled: matchInstalledChessPwa,
  markInstalled: markChessPwaInstalled,
  queryInstalled: queryChessPwaInstalled,
  reportInstalled: reportPwaInstalled,
  initInstallNudge,
  registerServiceWorker,
  initPopup: initPwaPopup,
  initPageChrome: initPwaPageChrome,
  updatePageChrome: updatePwaPageChrome,
  updatePageChromeStatus: updatePwaPageChromeStatus,
  clearPageChromeStatus: clearPwaPageChromeStatus,
  fitPlayWindow: fitPwaPlayWindow,
  notifyPlayLayoutReady: notifyPwaPlayLayoutReady,
  boot: bootPwa,
  bootStandalone,
  resolveBootIntent,
  restorePopupWithoutOpener,
  rememberPopupState,
  hydratePopupAuthFromSession,
  persistState: persistPwaState,
  saveLocalSession: savePwaLocalSession,
  clearLocalSession: clearPwaLocalSession,
  initTransport: initPwaTransport,
  bridgeFetch,
  getWikiContext: getPwaWikiContext,
  setWikiContext: setPwaWikiContext,
  setContextChangedHandler: setPwaContextChangedHandler,
  loadGameState: loadPwaGameState,
  fetchSession: fetchPwaSession,
})
