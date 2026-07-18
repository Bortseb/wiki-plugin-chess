/**
 * LEADERBOARD client UI — the federated, gated leaderboard surface.
 *
 * §1 Opt-in gate + federated entry points
 * §2 Visible-federation hop-graph dials
 * §3 Past-opponents → neighbourhood promotion
 * §4 Federated ranking table, standings, and fluid layout
 *
 * This module owns the federated-only halves of the shared `#leaderboard` browse shell.
 * The shell itself — request/response plumbing, board caches, shared render orchestration,
 * and the My Chess Games / site-survey views — lives in `survey.js`. Imports are one-way
 * (`leaderboard.js` → `survey.js`); `survey.js` reaches back only through the render hooks
 * registered here via `registerLeaderboardUi`.
 *
 * In-file landmarks use `// # Section Name` for navigation.
 */

import {
  standingFor,
  rankLeaderboard,
  LEADERBOARD_COLUMNS,
  DEFAULT_SURVEY_ID,
  sitesMatch,
  cleanSite,
  leaderboardPlayerDisplayName,
  normalizeNeighborhoodGraphOpts,
  previewHopTrustSchedule,
  HOP_TRUST_FLOOR,
} from './federation.js'
import { wikiSitePageUrl, wikiSiteLinkLabel, wikiSiteLinkTarget } from './chess-core.js'
import { openLeaderboardGateModal, closeActiveModal, clearViewportBlockingModals } from './modals.js'
import { embeddedModalMount, shellMessengerFromContext } from './board-layout.js'
import {
  registerLeaderboardUi,
  lbSnapshot,
  setLbState,
  requestBoard,
  renderLeaderboard,
  wireLeaderboardView,
  ensureLeaderboardShellInteractive,
  applyBoardCache,
  applySurveyFilterFromCache,
  primeBoardFromIndexedDb,
  boardCacheKey,
  maybeAutoRefreshEmptyPastOpponents,
  viewerHasRatedGame,
  canProbeSurveyStatus,
  readNeighborhoodHopGraph,
  persistNeighborhoodHopGraph,
  resetChooseMenuSurveyBrowse,
  isPrimaryEmbedSurface,
  isInAppSurveySurface,
  isOnLeaderboardPluginPage,
} from './survey.js'

let ctx

function shellMessenger() {
  return shellMessengerFromContext(ctx)
}

function el(id) {
  return typeof document !== 'undefined' ? document.getElementById(id) : null
}

export function initLeaderboardUi(context) {
  ctx = context
  registerLeaderboardUi({
    renderStanding,
    renderLbTable,
    renderLbControls,
    renderLbUpdating,
    renderHopGraphPanel,
    renderAddOpponentsToNeighborhoodButton,
    ensureLeaderboardTableHead,
    wireLeaderboardTableResize,
    wireHopGraphDials,
    syncHopGraphInputs,
    cancelScheduledHopGraphRecrawl,
    addPastOpponentsToNeighborhood,
    closeGate,
    openLeaderboardInWiki,
  })
}

// # Opt In Gate and Federated Entry Points

let gateOpen = false
let gateMount = typeof document !== 'undefined' ? document.body : null
let gateEmbedded = false
let gateRestore = null

export function openLeaderboardInWiki() {
  if (!isPrimaryEmbedSurface()) return
  shellMessenger()?.openLeaderboardPage({ view: true })
}

export function openLeaderboardFromChooseMenu() {
  ctx?.clearBrowseStartMenuState?.()
  // Popup / installed PWA: open the in-app federated board (same as Challenges).
  if (isInAppSurveySurface()) {
    openLeaderboard()
    return
  }
  if (isPrimaryEmbedSurface()) {
    openLeaderboardInWiki()
    return
  }
  openLeaderboard()
}

function openLeaderboard() {
  setLbState({ mineEmptyAutoRefreshDone: false, mineEmptyRatedProbePending: false })
  openGate()
}

// Opt-in CTA only helps signed-in owners who can journal a rated game on this wiki.
function shouldShowLeaderboardOptInGate() {
  return Boolean(ctx?.canPublish?.())
}

function openGate() {
  gateOpen = true
  const canProbe = canProbeSurveyStatus()
  setLbState({ siteHasRatedGame: false, checkingRatedStatus: canProbe })
  gateMount = document.body
  gateEmbedded = false
  gateRestore = null
  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  if ((ctx?.ownGamesPlayed?.(host) || 0) > 0) {
    closeGate()
    viewBoard({ reach: 'mine' })
    return
  }
  // Visitors who aren't signed in (or can't journal here) can't play rated games on
  // this site — skip the opt-in modal and open the board the same as "View leaderboards".
  if (!shouldShowLeaderboardOptInGate()) {
    closeGate()
    viewBoard({ reach: 'survey' })
    return
  }
  if (canProbe) {
    shellMessenger()?.surveyStatus()
    return
  }
  ensureGateMount()
  renderGate()
}

function ensureGateMount() {
  if (gateRestore) return
  const { mount, embedded, restore } = embeddedModalMount()
  gateMount = mount
  gateEmbedded = embedded
  gateRestore = restore
}

function closeGate() {
  gateOpen = false
  gateRestore?.()
  gateRestore = null
  gateMount = document.body
  gateEmbedded = false
  clearViewportBlockingModals()
}

function renderGate() {
  if (!gateOpen) return
  const { checkingRatedStatus } = lbSnapshot()
  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  const hasRatedGame = viewerHasRatedGame(host)
  if (hasRatedGame) {
    closeGate()
    viewBoard({ reach: 'mine' })
    return
  }
  if (!shouldShowLeaderboardOptInGate()) {
    closeGate()
    viewBoard({ reach: 'survey' })
    return
  }
  closeActiveModal({ discardSuspended: true, restoreMount: false })
  ensureGateMount()
  openLeaderboardGateModal({
    hasRatedGame,
    checkingStatus: checkingRatedStatus,
    mount: gateMount,
    embedded: gateEmbedded,
    onView: () => {
      closeGate()
      viewBoard({ reach: hasRatedGame ? 'mine' : 'survey' })
    },
    onCancel: () => {
      closeGate()
    },
    onLayoutChange: () => ctx?.notifyWikiHeight?.(),
  })
}

export function handleSurveyState(data) {
  setLbState({
    siteHasRatedGame: !!data?.hasRatedGame,
    checkingRatedStatus: false,
    mineEmptyRatedProbePending: false,
  })
  const { siteHasRatedGame } = lbSnapshot()
  if (gateOpen && siteHasRatedGame) {
    closeGate()
    viewBoard({ reach: 'mine' })
    return
  }
  if (gateOpen) {
    renderGate()
    return
  }
  if (siteHasRatedGame && maybeAutoRefreshEmptyPastOpponents()) return
  renderLeaderboard()
}

function viewBoard({ reach = 'mine' } = {}) {
  ctx?.clearBrowseStartMenuState?.()
  closeGate()
  ensureLeaderboardShellInteractive()
  const nextMode = reach === 'neighborhood' ? 'neighborhood' : reach === 'survey' ? 'survey' : 'mine'
  setLbState({
    fromSurveyItem: false,
    viewKind: 'federatedLeaderboard',
    mode: nextMode,
    survey: DEFAULT_SURVEY_ID,
  })
  ctx.changePage('leaderboard')
  ctx.adoptPwaLeaderboardPage?.()
  wireLeaderboardView()
  if (applyBoardCache(boardCacheKey()) || applySurveyFilterFromCache(nextMode) || primeBoardFromIndexedDb()) {
    // Past opponents / neighborhood reuse cache or IndexedDB — no federation crawl on open.
    // Visible federation: paint cache only; Refresh / hop dials start a crawl explicitly.
    if (nextMode === 'mine' && maybeAutoRefreshEmptyPastOpponents()) return
    renderLeaderboard()
    return
  }
  requestBoard({ force: nextMode === 'survey' })
}

// LEADERBOARD keyword on the Chess Leaderboards plugin page.
export function showLeaderboardBoardForItem() {
  resetChooseMenuSurveyBrowse()
  setLbState({
    fromSurveyItem: false,
    viewKind: 'federatedLeaderboard',
    mode: 'mine',
    survey: DEFAULT_SURVEY_ID,
  })
  ensureLeaderboardShellInteractive()
  ctx.changePage('leaderboard')
  ctx.adoptPwaLeaderboardPage?.()
  wireLeaderboardView()
  if (isPrimaryEmbedSurface() && !isOnLeaderboardPluginPage()) {
    setLbState({ lbLoading: false, lbEntries: [], lbMeta: { wrongPage: true } })
    renderLeaderboard()
    ctx?.notifyWikiHeight?.()
    return
  }
  openLeaderboard()
}

// # Visible Federation Hop Graph Dials

// True while a hop dial is being dragged (pointer) — blocks progress paints from stomping the thumb.
let hopGraphDialPointerDown = false
// Debounce timer for neighbourhood recrawl after hop/decay commit.
let hopGraphRecrawlTimer = null
const HOP_GRAPH_RECRAWL_DEBOUNCE_MS = 800
let hopDialsWired = false

function hopGraphDialEls() {
  return [el('wikiChessLbMaxHops'), el('wikiChessLbHopDecay')].filter(Boolean)
}

function hopGraphsEqual(a, b) {
  if (!a || !b) return false
  const x = normalizeNeighborhoodGraphOpts(a)
  const y = normalizeNeighborhoodGraphOpts(b)
  return x.maxHops === y.maxHops && x.hopDecay === y.hopDecay
}

function readLiveHopGraphFromInputs() {
  const maxEl = el('wikiChessLbMaxHops')
  const decayEl = el('wikiChessLbHopDecay')
  if (!maxEl && !decayEl) return readNeighborhoodHopGraph()
  return normalizeNeighborhoodGraphOpts({
    maxHops: maxEl?.value,
    hopDecay: decayEl?.value,
  })
}

// Dragging or keyboard-focusing a hop dial — do not overwrite its value from persisted state.
function isHopGraphDialInteracting() {
  if (hopGraphDialPointerDown) return true
  const active = typeof document !== 'undefined' ? document.activeElement : null
  return !!active && hopGraphDialEls().some(node => node === active)
}

function cancelScheduledHopGraphRecrawl() {
  if (hopGraphRecrawlTimer == null) return
  clearTimeout(hopGraphRecrawlTimer)
  hopGraphRecrawlTimer = null
}

// Persist is immediate; network crawl waits so rapid dial tweaks collapse into one walk.
// Skips when the chosen dials already match an in-flight crawl or a completed cached board.
function scheduleFederationHopGraphRecrawl() {
  cancelScheduledHopGraphRecrawl()
  hopGraphRecrawlTimer = window.setTimeout(() => {
    hopGraphRecrawlTimer = null
    const { mode, viewKind, lbLoading, lbProgress, lbMeta, lbBoardCache } = lbSnapshot()
    if (mode !== 'survey' || viewKind !== 'federatedLeaderboard') return
    const next = readNeighborhoodHopGraph()
    const inFlight = lbLoading ? lbProgress?.hopGraph || lbMeta?.hopGraph : null
    if (inFlight && hopGraphsEqual(next, inFlight)) {
      renderHopGraphPanel()
      return
    }
    if (!lbLoading && lbBoardCache.survey && lbMeta?.hopGraph && hopGraphsEqual(next, lbMeta.hopGraph)) {
      renderHopGraphPanel()
      return
    }
    lbBoardCache.survey = null
    requestBoard({ force: true, deepRecompute: false, syncSurvey: true })
  }, HOP_GRAPH_RECRAWL_DEBOUNCE_MS)
  renderHopGraphPanel()
}

function formatHopTrustPreview(graph = readNeighborhoodHopGraph()) {
  const rows = previewHopTrustSchedule(graph)
  const parts = rows.map(row => {
    const trust = row.trust.toFixed(2)
    if (row.kept) return `hop ${row.hop}: ${trust}`
    if (row.weededReason === 'maxHops') return `hop ${row.hop}: cut (max hops)`
    return `hop ${row.hop}: ${trust} weeded (floor ${HOP_TRUST_FLOOR})`
  })
  return `Trust = decay^hop (floor ${HOP_TRUST_FLOOR}). ${parts.join(' · ')}`
}

function hopWeededTotal(hopStats) {
  const rows = Array.isArray(hopStats) ? hopStats : []
  return rows.reduce((n, row) => n + (Number(row?.weededMaxHops) || 0) + (Number(row?.weededDecay) || 0), 0)
}

function formatHopStatsLines(hopStats, hopGraph = null) {
  const rows = Array.isArray(hopStats) ? hopStats : []
  if (!rows.length) return 'No crawl yet — blocked count updates after Refresh on Visible federation.'
  const graph = hopGraph ? normalizeNeighborhoodGraphOpts(hopGraph) : readNeighborhoodHopGraph()
  const lines = rows.map(row => {
    const weeded = (Number(row.weededMaxHops) || 0) + (Number(row.weededDecay) || 0)
    const bits = [`hop ${row.hop}: kept ${Number(row.kept) || 0}`]
    if (Number(row.weededMaxHops)) bits.push(`${row.weededMaxHops} over max hops`)
    if (Number(row.weededDecay)) bits.push(`${row.weededDecay} below floor`)
    if (!weeded && row.hop > 0) bits.push('none weeded')
    return bits.join(', ')
  })
  return `Last crawl (max ${graph.maxHops}, decay ${graph.hopDecay}): ${lines.join(' · ')}`
}

function syncHopGraphInputs() {
  const graph = readNeighborhoodHopGraph()
  const maxEl = el('wikiChessLbMaxHops')
  const hopsValueEl = el('wikiChessLbMaxHopsValue')
  const decayEl = el('wikiChessLbHopDecay')
  const decayValueEl = el('wikiChessLbHopDecayValue')
  if (maxEl && String(maxEl.value) !== String(graph.maxHops)) maxEl.value = String(graph.maxHops)
  if (decayEl && String(decayEl.value) !== String(graph.hopDecay)) {
    decayEl.value = String(graph.hopDecay)
  }
  if (maxEl) maxEl.setAttribute('aria-valuetext', String(graph.maxHops))
  if (hopsValueEl) hopsValueEl.textContent = String(graph.maxHops)
  if (decayEl) decayEl.setAttribute('aria-valuetext', graph.hopDecay.toFixed(2))
  if (decayValueEl) decayValueEl.textContent = graph.hopDecay.toFixed(2)
}

function renderHopGraphPanel() {
  const panel = el('wikiChessLbHopGraph')
  if (!panel) return
  const { mode, viewKind, lbMeta, lbLoading, lbProgress } = lbSnapshot()
  const show = viewKind === 'federatedLeaderboard' && mode === 'survey' && !lbMeta?.wrongPage
  // PWA/popup: show the same hop dials as the wiki embed (crawl already sends hopGraph).
  // Clear both the hidden attribute and any stale inline display from mount hide/restore.
  panel.hidden = !show
  if (show) {
    panel.removeAttribute('hidden')
    panel.style.removeProperty('display')
  }
  if (!show) return
  // Never stomp dial thumbs while the user is aiming — crawl progress used to
  // re-sync from IndexedDB ~4×/s and fight the pointer.
  const dialBusy = isHopGraphDialInteracting()
  if (!dialBusy) syncHopGraphInputs()
  const preview = el('wikiChessLbHopPreview')
  if (preview) {
    const graph = dialBusy ? readLiveHopGraphFromInputs() : readNeighborhoodHopGraph()
    let text = formatHopTrustPreview(graph)
    if (hopGraphRecrawlTimer != null) text += ' · recrawl shortly…'
    preview.textContent = text
  }
  // Prefer the last completed crawl’s hop stats while a new pass is still warming up
  // (progress often starts with empty / zero weeded counts).
  const progressStats = Array.isArray(lbProgress?.hopStats) ? lbProgress.hopStats : null
  const metaStats = Array.isArray(lbMeta?.hopStats) ? lbMeta.hopStats : null
  const hopStats =
    lbLoading && metaStats?.length && hopWeededTotal(progressStats) === 0 && hopWeededTotal(metaStats) > 0
      ? metaStats
      : progressStats || metaStats
  const blockedCount = hopWeededTotal(hopStats)
  const blockedEl = el('wikiChessLbHopBlockedCount')
  if (blockedEl) blockedEl.textContent = String(blockedCount)
  const blockedWrap = el('wikiChessLbHopBlocked')
  if (blockedWrap) {
    blockedWrap.title =
      hopStats && Array.isArray(hopStats) && hopStats.length
        ? `${blockedCount} site${blockedCount === 1 ? '' : 's'} weeded by max hops or decay floor`
        : 'Sites blocked by hop trust after the last visible-federation crawl'
  }
  const stats = el('wikiChessLbHopStats')
  if (stats) {
    stats.hidden = false
    stats.textContent = formatHopStatsLines(hopStats, lbMeta?.hopGraph || lbProgress?.hopGraph)
  }
}

// Wire the max-hops / decay dials (once). Extracted from the shared shell's wireLeaderboardView.
function wireHopGraphDials() {
  if (hopDialsWired) return
  const onHopGraphCommit = () => {
    hopGraphDialPointerDown = false
    const maxEl = el('wikiChessLbMaxHops')
    const decayEl = el('wikiChessLbHopDecay')
    persistNeighborhoodHopGraph({
      maxHops: maxEl?.value,
      hopDecay: decayEl?.value,
    })
    syncHopGraphInputs()
    const { mode, viewKind } = lbSnapshot()
    if (mode === 'survey' && viewKind === 'federatedLeaderboard') {
      scheduleFederationHopGraphRecrawl()
    } else {
      renderHopGraphPanel()
    }
  }
  const onHopGraphInput = () => {
    const maxEl = el('wikiChessLbMaxHops')
    const hopsValueEl = el('wikiChessLbMaxHopsValue')
    const decayEl = el('wikiChessLbHopDecay')
    const decayValueEl = el('wikiChessLbHopDecayValue')
    const graph = normalizeNeighborhoodGraphOpts({
      maxHops: maxEl?.value,
      hopDecay: decayEl?.value,
    })
    if (maxEl) maxEl.setAttribute('aria-valuetext', String(graph.maxHops))
    if (hopsValueEl) hopsValueEl.textContent = String(graph.maxHops)
    if (decayEl) decayEl.setAttribute('aria-valuetext', graph.hopDecay.toFixed(2))
    if (decayValueEl) decayValueEl.textContent = graph.hopDecay.toFixed(2)
    const preview = el('wikiChessLbHopPreview')
    if (preview) preview.textContent = formatHopTrustPreview(graph)
  }
  const onHopDialPointerDown = () => {
    hopGraphDialPointerDown = true
    const release = () => {
      hopGraphDialPointerDown = false
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }
  const dials = hopGraphDialEls()
  if (!dials.length) return
  hopDialsWired = true
  for (const dial of dials) {
    dial.addEventListener('pointerdown', onHopDialPointerDown)
    dial.addEventListener('input', onHopGraphInput)
    dial.addEventListener('change', onHopGraphCommit)
  }
  syncHopGraphInputs()
}

// # Past Opponents Neighbourhood Promotion

function pastOpponentsMissingFromNeighborhood() {
  const { lbMeta, lbBoardCache } = lbSnapshot()
  const localSite = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  const pastOpponents = [
    ...(Array.isArray(lbMeta?.pastOpponents) ? lbMeta.pastOpponents : []),
    ...(Array.isArray(lbBoardCache.mine?.meta?.pastOpponents) ? lbBoardCache.mine.meta.pastOpponents : []),
    ...(Array.isArray(lbBoardCache.survey?.meta?.pastOpponents) ? lbBoardCache.survey.meta.pastOpponents : []),
  ]
  const neighborhoodSites = [
    ...(Array.isArray(lbMeta?.neighborhoodSites) ? lbMeta.neighborhoodSites : []),
    ...(Array.isArray(lbBoardCache.neighborhood?.meta?.neighborhoodSites)
      ? lbBoardCache.neighborhood.meta.neighborhoodSites
      : []),
    ...(Array.isArray(lbBoardCache.survey?.meta?.neighborhoodSites) ? lbBoardCache.survey.meta.neighborhoodSites : []),
  ]
  if (!pastOpponents.length) return []
  const seen = new Set()
  const missing = []
  for (const host of pastOpponents) {
    const h = String(host || '')
      .trim()
      .toLowerCase()
    if (!h || seen.has(h) || sitesMatch(h, localSite)) continue
    if (neighborhoodSites.some(n => sitesMatch(n, h))) continue
    seen.add(h)
    missing.push(h)
  }
  return missing
}

function addPastOpponentsToNeighborhood() {
  const hosts = pastOpponentsMissingFromNeighborhood()
  if (!hosts.length || !shellMessenger()) return
  shellMessenger().registerNeighbors({ hosts })
  const { lbBoardCache } = lbSnapshot()
  // Drop the stale neighbourhood snapshot so the forced rebuild crawls the new members.
  lbBoardCache.neighborhood = null
  if (lbBoardCache.survey?.meta) {
    lbBoardCache.survey.meta.neighborhoodSites = [
      ...(Array.isArray(lbBoardCache.survey.meta.neighborhoodSites) ? lbBoardCache.survey.meta.neighborhoodSites : []),
      ...hosts,
    ]
  }
  // Pass hosts explicitly so the shell crawl includes them even if wiki.neighborhood
  // has not finished registering yet (postMessage ordering vs BUILD_LEADERBOARD).
  requestBoard({
    force: true,
    deepRecompute: false,
    syncSurvey: false,
    extraNeighborhoodSites: hosts,
  })
}

function renderAddOpponentsToNeighborhoodButton() {
  const btn = el('wikiChessLbAddOpponents')
  if (!btn) return
  const { viewKind, mode, lbMeta, lbLoading } = lbSnapshot()
  const missing = pastOpponentsMissingFromNeighborhood()
  const show =
    viewKind === 'federatedLeaderboard' &&
    mode === 'neighborhood' &&
    !lbMeta?.wrongPage &&
    !isInAppSurveySurface() &&
    !!ctx?.wikiFrame &&
    missing.length > 0
  btn.hidden = !show
  btn.disabled = lbLoading
  btn.title = show
    ? `Register ${missing.length} past ${missing.length === 1 ? 'opponent' : 'opponents'} as wiki neighbours`
    : ''
}

// # Federated Ranking Table and Layout

function renderLbUpdating() {
  const updating = el('wikiChessLbUpdating')
  if (!updating) return
  const { lbLoading, lbBackground, viewKind } = lbSnapshot()
  const show = lbLoading && lbBackground && viewKind === 'federatedLeaderboard'
  updating.hidden = !show
}

function renderLbControls() {
  const { reliableOnly, sortColumn, sortDir, columnFilters } = lbSnapshot()
  const reliable = el('wikiChessLbReliable')
  if (reliable) reliable.checked = reliableOnly
  ensureLeaderboardTableHead()
  const head = el('wikiChessLbHead')
  if (!head) return
  for (const node of head.querySelectorAll('[data-lb-sort]')) {
    const colId = node.getAttribute('data-lb-sort')
    const active = colId === sortColumn
    node.classList.toggle('is-active', active)
    if (node.tagName === 'BUTTON') {
      node.setAttribute('aria-pressed', String(active))
      const ind = node.querySelector('.wiki-chess-lb-sort-ind')
      if (ind) ind.textContent = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
    }
  }
  for (const input of head.querySelectorAll('[data-lb-filter="player"]')) {
    const next = columnFilters.player || ''
    if (input.value !== next) input.value = next
    input.closest?.('.wiki-chess-lb-player-search')?.classList.toggle('has-value', Boolean(String(next).trim()))
  }
  syncLeaderboardTableDensity()
}

function renderStanding() {
  const banner = el('wikiChessLbStanding')
  if (!banner) return
  const { lbLoading, viewKind, lbEntries } = lbSnapshot()
  if (lbLoading || viewKind === 'siteSurvey') {
    banner.hidden = true
    banner.textContent = ''
    banner.classList.remove('wiki-chess-lb-todo')
    return
  }
  const host = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  const rating = host ? ctx?.ownRatingValue?.(host) : null
  const standing = host ? standingFor(lbEntries, { host, rating }) : null

  if (standing?.listed) {
    banner.hidden = false
    banner.classList.remove('wiki-chess-lb-todo')
    const ratingPart = Number.isFinite(Number(rating)) ? ` (${rating})` : ''
    banner.textContent = `You rank #${standing.rank} of ${standing.total}${ratingPart} — top ${standing.percentile}%`
    return
  }

  banner.hidden = true
  banner.textContent = ''
  banner.classList.remove('wiki-chess-lb-todo')
}

function renderLbTable() {
  const { viewKind, lbEntries, sortColumn, sortDir, category, reliableOnly, columnFilters, lbLoading } = lbSnapshot()
  const body = el('wikiChessLbBody')
  const empty = el('wikiChessLbEmpty')
  const panel = el('wikiChessLbTablePanel')
  const wrap = el('wikiChessLbTableWrap')
  const legend = el('wikiChessLbLegend')
  if (!body) return
  body.replaceChildren()

  if (viewKind === 'siteSurvey') {
    if (panel) panel.hidden = true
    else if (wrap) wrap.hidden = true
    if (legend) legend.hidden = true
    if (empty) empty.hidden = true
    return
  }

  const ranked = rankLeaderboard(lbEntries, {
    column: sortColumn,
    dir: sortDir,
    category,
    reliableOnly,
    filters: columnFilters,
  })
  const showLoadingOnly = lbLoading && !ranked.length

  if (showLoadingOnly || !ranked.length) {
    const filteredByReliable = !showLoadingOnly && reliableOnly && lbEntries.length
    const filteredByPlayer =
      !showLoadingOnly && !filteredByReliable && lbEntries.length && String(columnFilters.player || '').trim()
    // Keep the table chrome (Name search) visible while a filter matches nothing —
    // otherwise typing past the last match hides the search box with the table.
    if (filteredByPlayer || filteredByReliable) {
      if (panel) panel.hidden = false
      else if (wrap) wrap.hidden = false
      if (legend) legend.hidden = true
      if (empty) {
        empty.hidden = false
        empty.textContent = filteredByReliable
          ? 'No players with an established (reliable) rating yet. Uncheck “established ratings only” to see provisional ratings.'
          : 'No players match the current search.'
      }
      return
    }
    if (panel) panel.hidden = true
    else if (wrap) wrap.hidden = true
    if (legend) legend.hidden = true
    if (empty) {
      empty.hidden = showLoadingOnly || !lbEntries.length
      empty.textContent = 'No rated players found yet.'
    }
    return
  }
  if (panel) panel.hidden = false
  else if (wrap) wrap.hidden = false
  if (empty) empty.hidden = true

  const ownSite = String(ctx?.viewingSite?.() || '')
    .trim()
    .toLowerCase()
  let anyProvisional = false
  let anyUnverified = false
  for (const entry of ranked) {
    if (entry.provisional) anyProvisional = true
    if (!entry.verified) anyUnverified = true
    body.appendChild(lbRowFor(entry, ownSite))
  }
  if (legend) {
    const prov = el('wikiChessLbLegendProv')
    const unver = el('wikiChessLbLegendUnver')
    if (prov) prov.hidden = !anyProvisional
    if (unver) unver.hidden = !anyUnverified
    legend.hidden = !anyProvisional && !anyUnverified
  }
  // Size Name / headers to available wrap width (domains + progressive labels).
  requestAnimationFrame(() => {
    fitLeaderboardFluidLayout()
    if (isInAppSurveySurface()) {
      fitLeaderboardTableToWindow({ animate: false })
      requestAnimationFrame(() => {
        fitLeaderboardFluidLayout()
        fitLeaderboardTableToWindow({ animate: false })
      })
    }
  })
}

function ensureLeaderboardTableHead() {
  const head = el('wikiChessLbHead')
  if (!head || head.childElementCount) return
  const sortRow = document.createElement('tr')
  sortRow.className = 'wiki-chess-lb-sort-row'
  for (const col of LEADERBOARD_COLUMNS) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.className = colClassFor(col.id)
    const tip = col.title || col.label
    if (tip) th.title = tip
    th.setAttribute('data-lb-sort', col.id)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'wiki-chess-lb-sort-btn'
    btn.setAttribute('data-lb-sort', col.id)
    btn.setAttribute('aria-label', `Sort by ${tip}`)
    const labelFull = document.createElement('span')
    labelFull.className = 'wiki-chess-lb-sort-label-full'
    labelFull.textContent = col.label
    btn.appendChild(labelFull)
    // Only emit a short sibling when it differs — Name/Rating/Peak keep the full label always.
    if (col.shortLabel && col.shortLabel !== col.label) {
      const labelShort = document.createElement('span')
      labelShort.className = 'wiki-chess-lb-sort-label-short'
      labelShort.textContent = col.shortLabel
      labelShort.setAttribute('aria-hidden', 'true')
      btn.appendChild(labelShort)
    }
    const ind = document.createElement('span')
    ind.className = 'wiki-chess-lb-sort-ind'
    ind.setAttribute('aria-hidden', 'true')
    btn.appendChild(ind)
    if (col.id === 'player') {
      const headWrap = document.createElement('div')
      headWrap.className = 'wiki-chess-lb-player-head'
      headWrap.appendChild(btn)
      const search = document.createElement('div')
      search.className = 'wiki-chess-lb-player-search'
      const icon = document.createElement('span')
      icon.className = 'wiki-chess-lb-player-search-icon'
      icon.setAttribute('aria-hidden', 'true')
      icon.innerHTML = '<i class="fas fa-search"></i>'
      const input = document.createElement('input')
      input.type = 'search'
      input.className = 'wiki-chess-lb-player-filter'
      input.setAttribute('data-lb-filter', 'player')
      input.setAttribute('aria-label', 'Search players')
      input.setAttribute('size', '1')
      input.placeholder = ''
      input.autocomplete = 'off'
      search.appendChild(icon)
      search.appendChild(input)
      headWrap.appendChild(search)
      th.appendChild(headWrap)
    } else {
      th.appendChild(btn)
    }
    sortRow.appendChild(th)
  }
  head.appendChild(sortRow)
}

function colClassFor(columnId) {
  if (columnId === 'rank') return 'wiki-chess-lb-rank'
  if (columnId === 'player') return 'wiki-chess-lb-player-col'
  if (columnId === 'rating') return 'wiki-chess-lb-rating'
  return 'wiki-chess-lb-metric'
}

function lbRowFor(entry, ownSite) {
  const tr = document.createElement('tr')
  const site = entry.site ?? entry.host ?? ''
  if (ownSite && hostEq(site, ownSite)) tr.classList.add('wiki-chess-lb-you')

  for (const col of LEADERBOARD_COLUMNS) {
    if (col.id === 'player') {
      const player = document.createElement('td')
      player.className = 'wiki-chess-lb-player'
      const name = document.createElement('span')
      name.className = 'wiki-chess-lb-name'
      name.textContent = leaderboardPlayerDisplayName(entry)
      player.appendChild(name)
      if (site) {
        const hostEl = document.createElement('span')
        hostEl.className = 'wiki-chess-lb-host'
        hostEl.title = String(site).trim()
        appendWikiSiteLinkEl(hostEl, site)
        // Prefer a plain host tooltip on the link (Visit … still in aria via accessible name).
        const siteLink = hostEl.querySelector('a.wiki-chess-wiki-site-link')
        if (siteLink) siteLink.title = String(site).trim()
        player.appendChild(hostEl)
      }
      tr.appendChild(player)
      continue
    }
    if (col.id === 'rating') {
      const rating = document.createElement('td')
      rating.className = 'wiki-chess-lb-rating'
      const val = document.createElement('span')
      val.className = 'wiki-chess-lb-rating-val'
      const num = document.createElement('span')
      num.className = 'wiki-chess-lb-rating-num'
      num.textContent = String(entry.rating)
      val.appendChild(num)
      if (entry.provisional) {
        val.appendChild(flag('*', 'provisional — too few rated games yet for a reliable rating', 'wiki-chess-lb-prov'))
      }
      if (!entry.verified) {
        val.appendChild(flag('†', 'unverified — no matching twin found across wikis'))
      }
      rating.appendChild(val)
      tr.appendChild(rating)
      continue
    }
    appendCell(tr, columnCellText(entry, col), colClassFor(col.id))
  }
  return tr
}

function columnCellText(entry, col) {
  if (col.id === 'rank') return String(entry.rank)
  if (col.id === 'winrate') return `${Number(entry.winRate) || 0}%`
  const field = col.field || col.id
  return String(Number(entry?.[field]) || 0)
}

function appendCell(tr, text, className) {
  const td = document.createElement('td')
  td.className = className
  td.textContent = text
  tr.appendChild(td)
}

function flag(glyph, title, extraClass = '') {
  const span = document.createElement('span')
  span.className = extraClass ? `wiki-chess-lb-flag ${extraClass}` : 'wiki-chess-lb-flag'
  span.textContent = glyph
  span.title = title
  return span
}

function hostEq(a, b) {
  // Exact origin only — ports distinguish farm peers (olga.localhost ≠ olga.localhost:3001).
  const x = cleanSite(a)
  const y = cleanSite(b)
  return Boolean(x && y && x === y)
}

function appendWikiSiteLinkEl(parent, host) {
  const cleaned = String(host || '').trim()
  if (!cleaned) {
    parent.textContent = ''
    return
  }
  const link = document.createElement('a')
  link.className = 'wiki-chess-wiki-site-link'
  link.href = wikiSitePageUrl(cleaned)
  link.target = wikiSiteLinkTarget(cleaned)
  link.rel = 'noopener noreferrer'
  link.title = `Visit ${wikiSiteLinkLabel(cleaned)}`
  link.textContent = wikiSiteLinkLabel(cleaned)
  parent.appendChild(link)
}

// Default / min / max visible leaderboard rows for the resizable table viewport.
const LB_TABLE_DEFAULT_ROWS = 8
const LB_TABLE_MIN_ROWS = 3
const LB_TABLE_MAX_ROWS = 24

function lbTableCssPx(wrap, prop, fallbackPx) {
  const raw = getComputedStyle(wrap).getPropertyValue(prop).trim()
  if (!raw) return fallbackPx
  if (raw.endsWith('px')) return Number.parseFloat(raw) || fallbackPx
  if (raw.endsWith('rem')) {
    const rem = Number.parseFloat(raw) || 0
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    return rem * root || fallbackPx
  }
  return fallbackPx
}

function lbTableStridePx(wrap) {
  return lbTableCssPx(wrap, '--wiki-chess-lb-row-stride', 44)
}

function lbTableHeadPx(wrap) {
  return lbTableCssPx(wrap, '--wiki-chess-lb-head-height', 36)
}

function lbTableHeightForRows(wrap, rows) {
  return Math.round(lbTableStridePx(wrap) * rows + lbTableHeadPx(wrap))
}

function setLeaderboardTableHeight(wrap, heightPx, { notify = true, animate = false, maxPx = null } = {}) {
  if (!wrap) return
  const minH = lbTableHeightForRows(wrap, LB_TABLE_MIN_ROWS)
  const maxH = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : lbTableHeightForRows(wrap, LB_TABLE_MAX_ROWS)
  const next = Math.max(minH, Math.min(maxH, Math.round(heightPx)))
  wrap.classList.toggle('is-window-fitting', Boolean(animate))
  wrap.classList.add('is-manually-sized')
  wrap.style.height = `${next}px`
  const handle = el('wikiChessLbTableResize')
  if (handle) {
    handle.setAttribute('aria-valuenow', String(next))
    handle.setAttribute('aria-valuemin', String(minH))
    handle.setAttribute('aria-valuemax', String(maxH))
  }
  if (notify) ctx?.notifyWikiHeight?.()
}

function measureLeaderboardTableContentHeight(wrap) {
  const table = wrap?.querySelector('table.wiki-chess-lb-table')
  if (table) return Math.ceil(table.getBoundingClientRect().height)
  return Math.ceil(wrap?.scrollHeight || 0)
}

function leaderboardTableBottomReserve() {
  let reserve = 16
  const handle = el('wikiChessLbTableResize')
  if (handle && handle.offsetParent !== null) {
    const cs = getComputedStyle(handle)
    reserve +=
      handle.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
  }
  const legend = el('wikiChessLbLegend')
  if (legend) {
    // Always reserve the note’s natural height in the popup/PWA. Fitting while the
    // legend is still `hidden` used to fill the whole viewport and shove “* provisional…”
    // below the fold once it finally appeared.
    const wasHidden = legend.hidden
    if (wasHidden) legend.hidden = false
    const cs = getComputedStyle(legend)
    const h =
      legend.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
    if (wasHidden) legend.hidden = true
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    reserve += Math.max(Math.ceil(h), Math.ceil(2.25 * rootPx))
  }
  const update = el('wikiChessLbSurveyUpdate')
  if (update && !update.hidden) {
    reserve += update.getBoundingClientRect().height + 8
  }
  // Keep a little air above the window edge / OS chrome.
  return Math.ceil(reserve)
}

// Popup/PWA: grow (or shrink) the table viewport with the window so scrollbars ease away.
function fitLeaderboardTableToWindow({ animate = true } = {}) {
  if (!isInAppSurveySurface()) return
  const { viewKind } = lbSnapshot()
  if (viewKind === 'siteSurvey') return
  const wrap = el('wikiChessLbTableWrap')
  const panel = el('wikiChessLbTablePanel')
  if (!wrap || !panel || panel.hidden) return
  if (wrap.dataset.lbResizeDragging === '1') return

  const top = wrap.getBoundingClientRect().top
  const available = Math.floor(window.innerHeight - top - leaderboardTableBottomReserve())
  if (!Number.isFinite(available) || available < 1) return

  const contentH = measureLeaderboardTableContentHeight(wrap)
  const minH = lbTableHeightForRows(wrap, LB_TABLE_MIN_ROWS)
  // If the table is wider than the wrap, a horizontal bar will consume height — reserve it
  // so the last row is never hidden under that bar.
  const table = wrap.querySelector('table.wiki-chess-lb-table')
  const tableW = table ? table.getBoundingClientRect().width : 0
  const hBar = tableW > wrap.clientWidth + 1 ? lbTableCssPx(wrap, '--wiki-chess-lb-scrollbar-size', 8) : 0
  // Fill leftover window space up to the full table — enough to drop the vertical scrollbar.
  const target = Math.max(minH, Math.min(available, Math.max(contentH + hBar + 1, minH)))
  const current = wrap.getBoundingClientRect().height
  if (Math.abs(target - current) < 2) return
  setLeaderboardTableHeight(wrap, target, {
    notify: false,
    animate,
    maxPx: Math.max(available, lbTableHeightForRows(wrap, LB_TABLE_MAX_ROWS)),
  })
}

let lbWindowFitTimer = null
function scheduleLeaderboardTableWindowFit() {
  if (!isInAppSurveySurface()) return
  if (lbWindowFitTimer) window.clearTimeout(lbWindowFitTimer)
  lbWindowFitTimer = window.setTimeout(() => {
    lbWindowFitTimer = null
    syncLeaderboardTableDensity()
    fitLeaderboardFluidLayout()
    fitLeaderboardTableToWindow({ animate: true })
  }, 50)
}

function wireLeaderboardTableResize() {
  const handle = el('wikiChessLbTableResize')
  const wrap = el('wikiChessLbTableWrap')
  if (!handle || !wrap || handle.dataset.lbResizeWired === '1') return
  handle.dataset.lbResizeWired = '1'
  const minH = () => lbTableHeightForRows(wrap, LB_TABLE_MIN_ROWS)
  const maxH = () => lbTableHeightForRows(wrap, LB_TABLE_MAX_ROWS)
  const defaultH = () => lbTableHeightForRows(wrap, LB_TABLE_DEFAULT_ROWS)
  handle.setAttribute('aria-valuemin', String(minH()))
  handle.setAttribute('aria-valuemax', String(maxH()))
  handle.setAttribute('aria-valuenow', String(wrap.clientHeight || defaultH()))

  let drag = null
  const onPointerMove = e => {
    if (!drag) return
    const delta = e.clientY - drag.startY
    setLeaderboardTableHeight(wrap, drag.startHeight + delta, { notify: false, animate: false })
  }
  const onPointerUp = e => {
    if (!drag) return
    try {
      handle.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    drag = null
    wrap.dataset.lbResizeDragging = ''
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    ctx?.notifyWikiHeight?.()
  }
  handle.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    wrap.classList.remove('is-window-fitting')
    wrap.dataset.lbResizeDragging = '1'
    const startHeight = wrap.classList.contains('is-manually-sized')
      ? wrap.getBoundingClientRect().height
      : Math.min(wrap.scrollHeight, wrap.clientHeight || defaultH())
    // Lock current viewport height before dragging so max-height alone does not fight us.
    if (!wrap.classList.contains('is-manually-sized')) {
      setLeaderboardTableHeight(wrap, startHeight, { notify: false, animate: false })
    }
    drag = { startY: e.clientY, startHeight: wrap.getBoundingClientRect().height }
    handle.setPointerCapture(e.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  })
  handle.addEventListener('keydown', e => {
    const step = lbTableStridePx(wrap)
    const current = wrap.classList.contains('is-manually-sized')
      ? wrap.getBoundingClientRect().height
      : Math.min(wrap.scrollHeight, defaultH())
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const delta = e.key === 'ArrowUp' ? -step : step
      setLeaderboardTableHeight(wrap, current + delta, { animate: false })
    } else if (e.key === 'Home') {
      e.preventDefault()
      setLeaderboardTableHeight(wrap, defaultH(), { animate: false })
    } else if (e.key === 'End') {
      e.preventDefault()
      setLeaderboardTableHeight(wrap, maxH(), { animate: false })
    }
  })

  if (isInAppSurveySurface() && wrap.dataset.lbWindowFitWired !== '1') {
    wrap.dataset.lbWindowFitWired = '1'
    window.addEventListener('resize', scheduleLeaderboardTableWindowFit, { passive: true })
    // First open often lays out before the popup has its final size — same path as resize.
    scheduleLeaderboardTableWindowFit()
  }
  if (wrap.dataset.lbDensityWired !== '1') {
    wrap.dataset.lbDensityWired = '1'
    window.addEventListener(
      'resize',
      () => {
        syncLeaderboardTableDensity()
        requestAnimationFrame(() => fitLeaderboardFluidLayout())
      },
      { passive: true },
    )
  }
}

// Prefer display-name floor; spend spare wrap width on full domains, then unabbreviate headers.
function fitLeaderboardFluidLayout() {
  const wrap = el('wikiChessLbTableWrap')
  const table = wrap?.querySelector('table.wiki-chess-lb-table')
  if (!table || wrap?.hidden) return

  syncLeaderboardTableDensity()

  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;font:inherit'
  table.appendChild(probe)

  const applyFont = elLike => {
    if (!elLike) return
    const cs = getComputedStyle(elLike)
    probe.style.font = cs.font
    probe.style.fontWeight = cs.fontWeight
    probe.style.letterSpacing = cs.letterSpacing
    probe.style.textTransform = cs.textTransform
  }

  let floor = 0
  const sampleName = table.querySelector('td.wiki-chess-lb-player .wiki-chess-lb-name')
  applyFont(sampleName)
  for (const name of table.querySelectorAll('td.wiki-chess-lb-player .wiki-chess-lb-name')) {
    probe.textContent = name.textContent || ''
    floor = Math.max(floor, Math.ceil(probe.getBoundingClientRect().width))
  }

  const labelFull = table.querySelector('th.wiki-chess-lb-player-col .wiki-chess-lb-sort-label-full')
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  if (labelFull) {
    applyFont(labelFull)
    probe.style.textTransform = 'uppercase'
    probe.textContent = labelFull.textContent || 'Name'
    const labelW = probe.getBoundingClientRect().width
    const searchW = 1.75 * rootPx
    const gap = 0.35 * rootPx
    const headPad = 0.8 * rootPx
    floor = Math.max(floor, Math.ceil(labelW + gap + searchW + headPad))
  }

  // Domain ideal: measure with the host link font. Prefer title (full host) over any
  // already-ellipsized visible text; add a small pad so CSS ellipsis doesn't clip early.
  let ideal = floor
  const sampleHost = table.querySelector('td.wiki-chess-lb-player .wiki-chess-lb-host')
  applyFont(sampleHost?.querySelector('a') || sampleHost)
  for (const host of table.querySelectorAll('td.wiki-chess-lb-player .wiki-chess-lb-host')) {
    const link = host.querySelector('a.wiki-chess-wiki-site-link')
    const raw = String(host.title || link?.textContent || host.textContent || '').trim()
    probe.textContent = raw
    ideal = Math.max(ideal, Math.ceil(probe.getBoundingClientRect().width))
  }
  probe.remove()
  if (!floor) floor = 48
  if (ideal < floor) ideal = floor

  const sample = table.querySelector('td.wiki-chess-lb-player, th.wiki-chess-lb-player-col')
  const cellCs = sample ? getComputedStyle(sample) : null
  const pad = cellCs ? (parseFloat(cellCs.paddingLeft) || 0) + (parseFloat(cellCs.paddingRight) || 0) : 0
  const floorPad = Math.max(1, Math.ceil(floor + pad))
  // Extra px: borders + hanging-glyph margin so hosts aren't left one character short.
  const idealPad = Math.max(floorPad, Math.ceil(ideal + pad + 6))

  // Reset progressive header expansions before measuring spare width.
  for (const th of table.querySelectorAll('thead th.is-lb-expanded')) {
    th.classList.remove('is-lb-expanded')
  }

  // Sum column boxes — do NOT use table.scrollWidth (overflow:visible Name header
  // can inflate it and fake a horizontal overflow while cells still look narrow).
  const contentW = () => {
    let w = 0
    for (const th of table.querySelectorAll('thead tr:first-child th')) {
      w += th.getBoundingClientRect().width
    }
    return Math.ceil(w)
  }
  const budget = () => Math.floor(wrap.clientWidth - contentW())

  table.style.setProperty('--wiki-chess-lb-name-col-width', `${floorPad}px`)
  void table.offsetWidth

  // Give Name every free pixel up to full domain text before unabbreviating headers.
  let spare = budget()
  let nameW = floorPad
  if (idealPad > floorPad) {
    if (spare > 0) {
      nameW = floorPad + Math.min(spare, idealPad - floorPad)
    }
    // Wide (non-compact) wraps should still prefer the domain width — fixed layout's
    // 100% width made residual "spare" look like 0 even when Name could grow.
    if (!wrap.classList.contains('is-lb-compact')) {
      nameW = idealPad
    }
    table.style.setProperty('--wiki-chess-lb-name-col-width', `${nameW}px`)
    void table.offsetWidth
    spare = budget()
  }

  // Unabbreviate only after domains fit (or as much as spare allows).
  if (wrap.classList.contains('is-lb-compact') && nameW >= idealPad - 1) {
    const expandOrder = [
      'rating',
      'peak',
      'games',
      'wins',
      'losses',
      'draws',
      'winrate',
      'whiteWins',
      'whiteLosses',
      'blackWins',
      'blackLosses',
    ]
    for (const colId of expandOrder) {
      if (spare < 16) break
      const th = table.querySelector(`thead th[data-lb-sort="${colId}"]`)
      if (!th || !th.querySelector('.wiki-chess-lb-sort-label-short')) continue
      th.classList.add('is-lb-expanded')
      void table.offsetWidth
      const nextSpare = budget()
      if (nextSpare < 4) {
        th.classList.remove('is-lb-expanded')
        void table.offsetWidth
        break
      }
      spare = nextSpare
    }
  }

  const rank = table.querySelector('th.wiki-chess-lb-rank, td.wiki-chess-lb-rank')
  if (rank) {
    table.style.setProperty('--wiki-chess-lb-rank-col-width', `${Math.ceil(rank.getBoundingClientRect().width)}px`)
  }
}

// Wide wrap → full headers + stretch table; compact wrap → short headers + content width.
//  Keep this above the default leaderboard popup/PWA width so that size prefers short
// labels first, then fluidly expands Name + headers into leftover space.
const LB_COMPACT_WRAP_PX = 1100
function syncLeaderboardTableDensity() {
  const wrap = el('wikiChessLbTableWrap')
  if (!wrap || wrap.hidden) return
  wrap.classList.toggle('is-lb-compact', wrap.clientWidth > 0 && wrap.clientWidth < LB_COMPACT_WRAP_PX)
}
