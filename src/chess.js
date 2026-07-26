/**
 * Wiki shell plugin — renders chess items on federated wiki pages.
 *
 * §1 Plugin emit/bind/editor
 * §2 Journal save gateway (applyChessJournalSave → buildChessSaveActions)
 * §3 Cross-wiki crawl (ratings, leaderboard, challenges)
 * §4 postMessage shell handlers
 *
 * In-file landmarks use `// # Section Name` for navigation.
 *
 * SPDX-License-Identifier: MIT
 *
 * Bundled to client/chess.js. Owns the iframe embed, postMessage bridge to chess-app.js,
 * cross-wiki crawling (ratings, leaderboard, challenges), journal saves via applyChessJournalSave,
 * and popup/PWA launch.
 */

import {
  getFormat,
  parseChessItem,
  resolveChessState,
  buildStartPgn,
  mergeItemTextIntoChessObj,
  prepareWikiPgn,
  canonicalizePersistedChessText,
  defaultNewChessItemLabel,
  isNewChessItem,
  isLeaderboardItemText,
  isMaintenanceChessItemText,
  isMaintenanceChessState,
  planChessShellPersist,
  START_FEN,
  normalizeGameSettings,
  coalesceAdoptedGameSettings,
  buildJoinAcceptGhost,
  buildCreatePreviewMeta,
  buildCreatePreviewStory,
  shouldSplitOpenSeatGameJournal,
  keepGhostUntilSeatsFilled,
  chessItemEmitKey,
  shouldRespondWithPatchStateOnly,
  CHESS_CREATE_SYMBOL,
  resolveWikiSiteFromPageSite,
  isEditableWikiPage,
  isBrowserLocalForkPageSite,
  canOfferGuestLocalPersist,
  shouldDeferOriginJournalPut,
  mapChessSaveActionsForJournal,
  stripCreatePreviewFlag,
  clearGhostBootstrapJournal,
  Paste,
  isEditableChessItemText,
  looksLikePuzzleBankPaste,
  isBareModeKeyword,
  resolveSignedInUsername,
  formatPlayerId,
  guestSeatName,
  GUEST_PLAYER_NAME,
  normalizeWikiSite,
  remotePageMatchesExpect,
  playerDisplayLabel,
  openChallengeAcceptParagraph,
  setRealtimeSeat,
  normalizeRealtimeState,
  normalizeRealtimeSignalMap,
  applyPageAction,
  buildChessSaveActions,
  withChessSymbol,
  adoptRemoteWikiPage,
  MSG,
  createMessageDispatcher,
  pollWindowUntil,
} from './chess-core.js'
import { openPasteConfirmModal, openAlertModal } from './modals.js'
import {
  normalizeChallengeState,
  isOpenChallenge,
  proposeOpenChallengePageTitle,
  openChallengeDisplayTitle,
  proposeUniquePageTitle,
  collectLineupPageSlugs,
  acceptOpenChallenge,
  buildChallengeJoinGhostPgn,
  isAcceptedGhostJoinGame,
  reconstructGhostPgnFromSeated,
  sitesMatch,
  cleanSite,
  openChallengeFromPgn,
  syncOpenChallengeSurveyOnPage,
  mergeOpenChallengeEntries,
  resolveSeatRating,
  isSurveyItemText,
  siteHasRatedGames,
  SURVEY_PAGE_SLUG,
  SURVEY_PAGE_TITLE,
  SURVEY_PAGE_STORY,
  LEADERBOARD_PAGE_SLUG,
  LEADERBOARD_PAGE_TITLE,
  LEADERBOARD_PAGE_STORY,
  pickLeaderboardPageSlug,
  DEFAULT_SURVEY_ID,
  buildFetchTargets,
  resolveFetchSeeds,
  orchestrateSiteSurveyDeferredWork,
  runNeighborhoodJob,
  refreshFederationSitesFromIndex,
  fetchChallengesAsync,
  dedupeSites,
  buildFederationGossipPatch,
  shouldPublishFederationGossip,
  deriveGossipTrustedPeers,
  readFederationCharm,
  probeWikiSite,
  asSitemapArray,
  newItemId,
  fetchSiteContentAsync,
  fetchSitesAsync,
  createBrowserWikiSiteClient,
  readGameIndex,
  upsertGameIndexEntry,
  buildGameIndexEntryFromPgn,
  applyGameIndexToSurveyPage,
} from './federation.js'
import { popupWindowFeaturesString, windowMetricsForChessObj, markChessPwaInstalled } from './board-layout.js'

const pluginBuildId = __PLUGIN_BUILD_ID__

// # Plugin Boot and Item Live Registry

// itemLive.key is `${pageKey}/${itemId}` — sanitize for HTML id / window.name attributes.
const safeDomId = value =>
  String(value ?? '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'chess'

const items = new Map()

const CHESS_ITEM_EDIT_HINT = 'double-click here to edit chess item'

// Item-host chrome only. Selectors stay under `.wiki-plugin-chess` so a style tag
// in the wiki document cannot restyle wiki chrome (footer, pages, security UI).
// Sole exception: `.page:has(.wiki-plugin-chess)` reserves the page column's
// scrollbar gutter — see comment on the rule below.
// Shell paste modals mount inside this root — never as fixed overlays on `document.body`.
const ensureChessItemStyles = $host => {
  // Drop legacy global inject from earlier builds (was appended to document.head).
  document.getElementById('wiki-chess-item-styles')?.remove()
  const hostEl = $host?.jquery ? $host[0] : $host
  if (!hostEl?.appendChild) return
  const css = `
/* Keep the wiki page column's scrollbar lane reserved while a chess item is present.
   Moves change the iframe height (new history row, annotation, captured piece); when
   the page content tips just past the viewport the column scrollbar appears, the
   content narrows ~17px, the board refits smaller, the content fits again, the
   scrollbar vanishes — an oscillation the user sees as whole-page jitter. Same fix
   as body.wiki-popup in wiki-chess.css. */
.page:has(.wiki-plugin-chess) {
  scrollbar-gutter: stable;
}
.wiki-plugin-chess {
  position: relative;
  display: flex;
  flex-direction: column;
  margin: 5px 0;
  border: 2px solid #000;
}
.wiki-plugin-chess .wiki-chess-embed-host {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  overflow: hidden;
}
.wiki-plugin-chess .wiki-chess-embed-host.is-loading {
  min-height: 280px;
}
.wiki-plugin-chess .wiki-chess-embed-loading {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  text-align: center;
  background: #f8f9fa;
  pointer-events: none;
}
.wiki-plugin-chess .wiki-chess-embed-loading-text {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 0.95rem;
  line-height: 1.45;
  color: #495057;
}
.wiki-plugin-chess .chess-board-frame {
  display: block;
  width: 100%;
  border: 0;
  overflow: hidden;
}
/* Wiki story sortable: park the live iframe out of the item so jquery's
   sortstart clone stays light, then show it as a fixed non-interactive ghost. */
.wiki-plugin-chess.is-wiki-dragging {
  pointer-events: none;
  cursor: grabbing;
}
.wiki-plugin-chess .wiki-chess-drag-freeze {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  width: 100%;
  background: #f8f9fa;
  pointer-events: none;
  user-select: none;
}
iframe.chess-board-frame.wiki-chess-drag-ghost {
  position: fixed !important;
  z-index: 10000 !important;
  margin: 0 !important;
  border: 0 !important;
  pointer-events: none !important;
  display: block !important;
}
.wiki-chess-iframe-drag-shield {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: transparent;
  pointer-events: auto;
}
.wiki-plugin-chess .wiki-chess-item-bar {
  position: relative;
  z-index: 5;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  min-height: 1.25rem;
  padding: 0.35rem 0.5rem;
  background-color: #eee;
  outline: none;
  box-shadow: none;
  pointer-events: auto;
  cursor: text;
}
.wiki-plugin-chess .wiki-chess-item-bar:focus,
.wiki-plugin-chess .wiki-chess-item-bar:focus-visible {
  outline: none;
  box-shadow: none;
}
.wiki-plugin-chess .wiki-chess-item-bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-right: auto;
}
.wiki-plugin-chess .wiki-chess-item-bar-actions:empty {
  display: none;
}
.wiki-plugin-chess .wiki-chess-item-bar-hint {
  margin-left: auto;
  font-size: 14px;
  color: #555;
  user-select: none;
}
.wiki-plugin-chess > .wiki-modal-root,
.wiki-plugin-chess > .wiki-modal-root.wiki-modal-embedded {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem;
  margin: 0;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.5);
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-panel {
  position: relative;
  z-index: 1;
  width: min(100%, 28rem);
  max-height: 100%;
  overflow: auto;
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 0.35rem;
  box-shadow: 0 0.5rem 1.5rem rgba(0,0,0,0.2);
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-body {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  padding: 1.5rem 1.5rem 1.25rem;
  font-size: 1rem;
  line-height: 1.5;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-message { margin: 0; }
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-offline {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  color: #856404;
  background: #fff3cd;
  border: 1px solid #ffecb5;
  border-radius: 0.25rem;
  padding: 0.75rem 0.875rem;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1rem 1.5rem 1.5rem;
  border-top: 1px solid rgba(0,0,0,0.08);
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-footer .btn {
  flex: 0 0 auto;
  font-size: 0.9rem;
  padding: 0.35rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-footer.wiki-modal-footer-nowrap {
  flex-wrap: nowrap;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-footer.wiki-modal-footer-nowrap .btn {
  white-space: nowrap;
  font-size: 14px;
  padding: 0.35rem 0.55rem;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-footer .btn-outline-secondary {
  color: #333;
  background: #fff;
  border: 1px solid #ccc;
}
.wiki-plugin-chess > .wiki-modal-root .wiki-modal-footer .btn-primary {
  color: #fff;
  background: #0d6efd;
  border: 1px solid #0d6efd;
}
`
  let el = hostEl.querySelector(':scope > style[data-wiki-chess-item-styles]')
  if (!el) {
    el = document.createElement('style')
    el.setAttribute('data-wiki-chess-item-styles', '1')
    hostEl.insertBefore(el, hostEl.firstChild)
  }
  el.textContent = css
}

const buildChessItemBar = (controlButtons = []) => {
  const $actions = $('<div>', { class: 'wiki-chess-item-bar-actions' })
  controlButtons.forEach($btn => $actions.append($btn))
  return $('<div>', { class: 'wiki-chess-item-bar', tabindex: '0', title: 'Click here, then paste PGN or FEN' }).append(
    [$actions, $('<span>', { class: 'wiki-chess-item-bar-hint', text: CHESS_ITEM_EDIT_HINT })],
  )
}

const getPageKey = $item => $item.parents('.page:first').data('key')

// The page slug (e.g. "chess-keyword-examples") lives in the .page element's id,
// with an optional "_rev<n>" suffix for historical revisions. Unlike getPageKey
// (a random per-lineup key), the slug is what's preserved when a page is forked
// to another wiki, so it's what we use to fetch an opponent's copy of this page.
const getPageSlug = $item => {
  const id = $item.parents('.page:first').attr('id')
  if (!id) return undefined
  return id.split('_rev')[0] || undefined
}

const getPageTitle = $item => {
  const title = $item.parents('.page:first').data('data')?.title
  if (title == null) return undefined
  const trimmed = String(title).trim()
  return trimmed || undefined
}

const getItemLiveKey = ($item, item) => {
  const pageKey = getPageKey($item) ?? 'page'
  return `${pageKey}/${item.id}`
}

const isGhostPage = $item => $item.parents('.page:first').hasClass('ghost')

// Ghost pages are preview-only until forked — they are not reliable doInternalLink
// anchors (lineup key may be missing), so open plugin pages from the lineup tail.
const wikiLineupAnchor = ($page, $item) => {
  if (!$page?.length) return null
  if ($item && isGhostPage($item)) return null
  if (isGhostPage($page)) return null
  return $page
}

// Remote open-challenge join ghosts carry the creator's wiki on `data-site`. The
// viewer's first journal put records a fork action (type: 'fork', site: …) so the
// page is owned on the origin, then applies the join edit.
const challengeForkSite = $item => {
  const site = $item.parents('.page:first').data('site')
  const fromSite = site != null ? String(site).trim().toLowerCase() : ''
  if (!fromSite || fromSite === 'origin' || fromSite === 'view' || fromSite === 'local') return ''
  const here = String(location.host || '')
    .trim()
    .toLowerCase()
  return fromSite !== here ? fromSite : ''
}

// # Ghost Pages and Create Preview

const isChallengeJoinGhost = $item => isGhostPage($item) && Boolean(challengeForkSite($item))

const isCreatePreview = (item, $item = null) => {
  if (item?.createPreviewPendingJournal) return true
  const text = String(item?.text || '').trim()
  // CHOOSE is not a bare mode keyword, but a CHOOSE item on a lineup ghost page
  // (e.g. "New Chess page" from My Chess Games) is still a forkable chess-item ghost.
  if ($item && isGhostPage($item) && /^CHOOSE$/i.test(text)) return true
  return Boolean(text && isBareModeKeyword(text))
}

const isCreatePreviewPage = ctx =>
  Boolean(ctx?.$item && ctx?.item && isGhostPage(ctx.$item) && isCreatePreview(ctx.item, ctx.$item))

// A CHOOSE-menu ghost exists only in the lineup until its first save. Fed Wiki
// materializes it with a `create` action; `edit` on a missing slug 404s and falls
// back to browser local storage (yellow halo). Sync any title the author typed on
// the ghost header, then build the create action from the preview story.
const syncGhostPageTitleBeforeMaterialize = $page => {
  if (typeof wiki?.asSlug !== 'function') return
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  if (!pageObject) return
  const titleEl = $page.find('h1 .title')
  const newtitle = titleEl.text().trim().replaceAll(/\s+/g, ' ')
  if (!newtitle || newtitle === pageObject.getTitle()) return
  const slug = wiki.asSlug(newtitle)
  $page.attr('id', slug)
  pageObject.setCreateTitle(newtitle)
  titleEl.removeAttr('contenteditable')
  syncBrowserLocationToPageSlug($page, slug)
  syncPageFooterSlugLinks($page, slug)
}

const syncBrowserLocationToPageSlug = ($page, slug) => {
  const nextSlug = String(slug || '').trim()
  if (!nextSlug || !$page?.length || typeof history === 'undefined' || !history.pushState) return
  const pages = typeof $ !== 'undefined' ? $('.page').toArray() : []
  const index = pages.indexOf($page[0])
  if (index < 0) return
  const parts = String(location.pathname || '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 2) return
  const slots = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    slots.push({ loc: parts[i], slug: parts[i + 1] })
  }
  if (index >= slots.length || slots[index].slug === nextSlug) return
  slots[index].slug = nextSlug
  const url = slots.map(slot => `/${slot.loc}/${slot.slug}`).join('')
  if (url && url !== location.pathname) history.pushState(null, null, url)
}

const syncPageFooterSlugLinks = ($page, slug) => {
  const nextSlug = String(slug || '').trim()
  if (!nextSlug || !$page?.length || typeof $ === 'undefined') return
  const $footer = $page.find('.footer')
  if (!$footer.length) return
  const rewrite = (href, extension) => {
    const raw = String(href || '')
    if (!raw) return raw
    try {
      const url = new URL(raw, location.href)
      url.pathname = `/${nextSlug}${extension}`
      return `${url.origin}${url.pathname}${url.search}${url.hash}`
    } catch {
      return raw.replace(/\/[^/=?]+\.(json|html)(?=([?#]|$))/, `/${nextSlug}.$1`)
    }
  }
  $footer.find('a.show-page-source').each((_, el) => {
    const $el = $(el)
    $el.attr('href', rewrite($el.attr('href'), '.json'))
  })
  $footer.find('a[date-slug]').each((_, el) => {
    const $el = $(el)
    $el.attr('date-slug', nextSlug)
    $el.attr('href', rewrite($el.attr('href'), '.html'))
  })
}

const applyGhostPageTitle = ($page, title, { ctx } = {}) => {
  const newtitle = String(title || '')
    .trim()
    .replaceAll(/\s+/g, ' ')
  if (!newtitle || !$page?.length) return
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  const titleEl = $page.find('h1 .title')
  if (titleEl.length) titleEl.text(newtitle)
  const slug = typeof wiki?.asSlug === 'function' ? wiki.asSlug(newtitle) : ''
  if (slug) $page.attr('id', slug)
  pageObject?.setCreateTitle?.(newtitle)
  if (ctx?.chessObj) {
    ctx.chessObj.wikiPageTitle = newtitle
    if (slug) ctx.chessObj.wikiPageName = slug
  }
  if (slug) {
    syncBrowserLocationToPageSlug($page, slug)
    syncPageFooterSlugLinks($page, slug)
  }
}

// Paragraph edits on a create-preview ghost update page.story but not always the
// synthetic create journal entry — copy the live story before materialize/fork.
const syncGhostPageStoryBeforeMaterialize = $page => {
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  if (!pageObject?.isCreateEditable?.()) return
  const raw = pageObject.getRawPage()
  const create = raw?.journal?.[0]
  if (create?.type !== 'create' || !create.item) return
  create.item.story = JSON.parse(JSON.stringify(raw.story || []))
}

const syncGhostPageBeforeMaterialize = $page => {
  syncGhostPageTitleBeforeMaterialize($page)
  syncGhostPageStoryBeforeMaterialize($page)
}

const buildCreatePreviewCreateAction = $page => {
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  if (!pageObject?.isCreateEditable?.()) return null
  const raw = pageObject.getRawPage()
  const slug = String($page.attr('id') || '').split('_rev')[0]
  if (!slug) return null
  return {
    type: 'create',
    id: slug,
    item: stripCreatePreviewFlag({
      title: raw.title || pageObject.getTitle(),
      story: JSON.parse(JSON.stringify(raw.story || [])),
    }),
  }
}

// Drop the lineup ghost's bootstrap create so materialize puts a single origin create.
const clearLineupGhostBootstrapJournal = $page => {
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  const raw = pageObject?.getRawPage?.()
  if (!raw) return
  clearGhostBootstrapJournal(raw)
  // Ghost preview paints the bootstrap create into the journal strip; remove it so the
  // origin create does not appear as a second create glyph before refresh.
  $page.find?.('.journal a.action.create')?.remove?.()
}

// True while the page is still the single-create preview shown by showResult — not
// yet materialized on the origin server (or saved only to local storage).
const isCreatePreviewJournal = $page => {
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  if (!pageObject?.isCreateEditable?.()) return false
  const journal = pageObject.getRawPage()?.journal
  return Array.isArray(journal) && journal.length === 1 && journal[0]?.type === 'create'
}

// CHOOSE-menu / paste ghosts live in the lineup beside the source page while the chess
// iframe still embeds on the item the player started from — title sync must target this
// preview page, not itemLive.$item's parent.
const ghostPageStory = $page => {
  const fromData = $page?.data?.('data')?.story
  if (Array.isArray(fromData)) return fromData
  const pageObject = wiki?.lineup?.atKey?.($page?.data?.('key'))
  const fromJournal = pageObject?.getRawPage?.()?.story
  return Array.isArray(fromJournal) ? fromJournal : null
}

const isPendingCreatePreviewStoryEntry = entry => {
  if (entry?.type !== 'chess') return false
  if (entry.createPreviewPendingJournal) return true
  const text = String(entry.text || '').trim()
  if (/^CHOOSE$/i.test(text)) return true
  return isBareModeKeyword(text)
}

const findPendingCreatePreviewPage = () => {
  if (typeof $ === 'undefined') return null
  const pages = $('.page.ghost').toArray().reverse()
  for (const el of pages) {
    const $page = $(el)
    const story = ghostPageStory($page)
    if (!Array.isArray(story)) continue
    if (story.some(entry => entry?.type === 'chess' && entry.createPreviewPendingJournal)) {
      return $page
    }
    if (story.some(isPendingCreatePreviewStoryEntry) && isCreatePreviewJournal($page)) {
      return $page
    }
  }
  return null
}

const findGhostPageByKey = pageKey => {
  const key = String(pageKey || '').trim()
  if (!key || typeof $ === 'undefined') return null
  for (const el of $('.page.ghost').toArray()) {
    const $page = $(el)
    if (String($page.data('key') || '') === key) return $page
    const slug = String($page.attr('id') || '').split('_rev')[0]
    if (slug && slug === key) return $page
  }
  return null
}

const needsCreatePreviewMaterialize = (ctx, $page) => {
  if (!ctx?.item || !isCreatePreviewJournal($page)) return false
  return Boolean(
    ctx.item.createPreviewPendingJournal ||
      ctx.chessObj?.createPreviewPendingJournal ||
      (isGhostPage(ctx.$item) && isCreatePreview(ctx.item, ctx.$item)),
  )
}

const createPreviewMaterializeAction = (ctx, $page, { text, title } = {}) => {
  if (keepGhostUntilSeatsFilled(text)) return null
  if (!needsCreatePreviewMaterialize(ctx, $page)) return null
  const pageTitle = String(title || '').trim()
  if (pageTitle) applyGhostPageTitle($page, pageTitle, { ctx })
  const nextText = typeof text === 'string' ? canonicalizePersistedChessText(text) : ''
  if (nextText && ctx?.item) {
    // Stamp the committed item into the live story before the create snapshot so the
    // origin create already carries seats/FEN/PGN — not the bare POSITION/CHOOSE keyword.
    applyTextToItemLive(ctx, nextText)
    syncSavedItemToPage(ctx, ctx.item)
    if (!ctx.item.createPreviewPendingJournal) ctx.item.createPreviewPendingJournal = true
  }
  syncGhostPageBeforeMaterialize($page)
  return buildCreatePreviewCreateAction($page)
}

const needsChallengeJoinGhostMaterialize = (ctx, $page) =>
  Boolean(ctx?.item && isChallengeJoinGhost(ctx.$item) && isCreatePreviewJournal($page))

const challengeJoinGhostMaterializeAction = (ctx, $page) => {
  if (!needsChallengeJoinGhostMaterialize(ctx, $page)) return null
  syncGhostPageBeforeMaterialize($page)
  return buildCreatePreviewCreateAction($page)
}

const ghostPageMaterializeAction = (ctx, $page, { forkSite, text, title } = {}) => {
  const createPreviewAction = createPreviewMaterializeAction(ctx, $page, { text, title })
  if (createPreviewAction) return createPreviewAction
  if (isChallengeJoinGhost(ctx?.$item) && forkSite) {
    return challengeJoinGhostMaterializeAction(ctx, $page)
  }
  return null
}

const clearCreatePreviewFlags = ctx => {
  delete ctx.item.createPreviewPendingJournal
  delete ctx.chessObj.createPreviewPendingJournal
}

const getPageSite = $item => $item.parents('.page:first').data('site')

const isBrowserLocalForkPage = $item => {
  const $page = $item.parents('.page:first')
  return isBrowserLocalForkPageSite(getPageSite($item), { isLocalClass: $page.hasClass('local') })
}

const isPageOnCurrentWiki = $item =>
  !isBrowserLocalForkPage($item) &&
  isEditableWikiPage(getPageSite($item), {
    isOwner: typeof isOwner !== 'undefined' && isOwner,
    isGhost: isGhostPage($item),
    locationHost: location.host,
  })

const getWikiSite = $item => resolveWikiSiteFromPageSite(getPageSite($item), location.host)

// A guest (non-owner) viewing a non-ghost page that lives on the current wiki can keep
// LOCAL-only edits in the browser, exactly like vanilla FedWiki: wiki.pageHandler.put
// forks the page into localStorage for a non-owner (the page goes yellow and shows up in
// "Local Changes" with an (X) to discard). We surface this to the app as `guestLocalStoragePersist`
// so a guest's game autosaves through that same native path instead of vanishing on
// reload. Owners persist to the wiki/journal via `pageOnThisWiki` and never set this (the
// `!isPageOnCurrentWiki` guard excludes them); a page forked from a remote wiki is also
// excluded so we never silently fork someone else's wiki into the visitor's browser.
// Create-preview ghosts on this wiki are included so same-device play can materialize
// (drops FedWiki ghost fade) into a yellow-halo local fork without owner sign-in.
// Never offer guestLocalStoragePersist while isOwner is still undefined — pageHandler would fork
// origin edits locally and give signed-in owners a yellow halo before auth resolves.
const canGuestLocalStoragePersist = $item => {
  const item = $item.data('item')
  return canOfferGuestLocalPersist({
    isOwnerFlag: typeof isOwner !== 'undefined' ? isOwner : undefined,
    isOwner: typeof isOwner !== 'undefined' && Boolean(isOwner),
    isPageOnCurrentWiki: isPageOnCurrentWiki($item),
    isGhost: isGhostPage($item),
    isCreatePreview: Boolean(item && isCreatePreview(item, $item)),
    pageSite: getWikiSite($item),
    locationHost: location.host,
  })
}

const enrichChessObj = (chessObj, $item, item) => {
  const wikiSite = getWikiSite($item)
  const pageOnThisWiki = isPageOnCurrentWiki($item)
  chessObj.wikiSite = wikiSite
  // Real-time presence lives on the item (not the PGN); forward it to the app so
  // it knows its own persisted readiness alongside the opponent's (via the poll).
  if (item?.realtime) chessObj.realtime = normalizeRealtimeState(item.realtime)
  // Open-challenge: prefer PGN tags; fall back to item.challenge for in-session state.
  {
    const challenge = openChallengeFromPgn(item?.text, { fallbackChallenge: item?.challenge })
    if (challenge) chessObj.challenge = challenge
  }
  if (isChallengeJoinGhost($item)) {
    chessObj.challengeJoinGhost = true
  }
  if (isCreatePreview(item, $item)) {
    chessObj.createPreviewPendingJournal = true
  }
  if (item?.openChallengeSetupPending) {
    chessObj.openChallengeSetupPending = true
  }
  if (isGhostPage($item) && isCreatePreview(item, $item)) {
    chessObj.wikiGhostPage = true
  }
  // Only authenticated wiki owners adopt the public ownerName as their seat identity.
  // Guests must not inherit the site owner's display name (FedWiki exposes it to everyone).
  {
    const authenticatedOwner =
      typeof isAuthenticated !== 'undefined' &&
      Boolean(isAuthenticated) &&
      typeof isOwner !== 'undefined' &&
      Boolean(isOwner)
    const fromPayload = chessObj.signedInDisplayName || chessObj.ownerName
    const fromGlobal =
      authenticatedOwner && typeof ownerName !== 'undefined' && ownerName != null && String(ownerName).trim()
        ? resolveSignedInUsername(ownerName) || String(ownerName).trim()
        : undefined
    chessObj.signedInDisplayName = fromPayload || fromGlobal || undefined
  }
  delete chessObj.ownerName

  if (!chessObj.wikiPageName) {
    chessObj.wikiPageName = getPageSlug($item) ?? 'page'
  }
  if (!chessObj.wikiPageTitle) {
    chessObj.wikiPageTitle = getPageTitle($item)
  }
  if (!chessObj.itemId && item?.id) {
    chessObj.itemId = item.id
  }
  if (!chessObj.wikiSiteUrl) {
    chessObj.wikiSiteUrl = `${location.protocol}//${location.host}`
  }

  const textFormat = getFormat(chessObj.PGN || chessObj.chessState || chessObj.FEN || '')
  if (textFormat === 'PGN' || textFormat === 'FEN') {
    chessObj.showStartMenu = false
  }

  if (chessObj.format === 'SURVEY' || chessObj.gameType === 'survey') {
    chessObj.showStartMenu = false
    if (!chessObj.chessState && item?.text) chessObj.chessState = item.text
    return chessObj
  }

  if (chessObj.format === 'LEADERBOARD' || chessObj.gameType === 'leaderboard') {
    chessObj.showStartMenu = false
    if (!chessObj.chessState && item?.text) chessObj.chessState = item.text
    return chessObj
  }

  if (chessObj.showStartMenu || chessObj.format === 'MENU' || chessObj.mode === 'CHOOSE') {
    chessObj.showStartMenu = true
    chessObj.format = 'MENU'
    chessObj.mode = 'CHOOSE'
    chessObj.chessState = 'CHOOSE'
    delete chessObj.PGN
    delete chessObj.FEN
    delete chessObj.gameType
    delete chessObj.needsSeed
    delete chessObj.challenge
    return chessObj
  }

  if (chessObj.format === 'PUZZLE' || chessObj.gameType === 'puzzle' || chessObj.mode === 'PUZZLE') {
    chessObj.showStartMenu = false
    chessObj.format = 'PUZZLE'
    chessObj.gameType = 'puzzle'
    delete chessObj.PGN
    if (!chessObj.FEN) delete chessObj.FEN
    return chessObj
  }

  if (chessObj.gameType === 'position' || chessObj.mode === 'POSITION') {
    chessObj.showStartMenu = false
    chessObj.format = 'FEN'
    if (!chessObj.FEN) chessObj.FEN = START_FEN
    delete chessObj.PGN
    return chessObj
  }

  const wikiCtx = {
    signedInDisplayName: chessObj.signedInDisplayName,
    wikiSite,
    pageOnThisWiki,
    wikiPageName: chessObj.wikiPageName,
    wikiPageTitle: chessObj.wikiPageTitle,
    wikiSiteUrl: chessObj.wikiSiteUrl,
    itemId: chessObj.itemId,
  }

  if (
    !chessObj.PGN &&
    (chessObj.gameType === 'engine' || chessObj.gameType === 'human' || chessObj.gameType === 'open')
  ) {
    chessObj.PGN = buildStartPgn({
      gameType: chessObj.gameType,
      ...wikiCtx,
    })
    chessObj.chessState = chessObj.PGN
    chessObj.format = 'PGN'
  }

  if (chessObj.PGN || chessObj.format === 'PGN') {
    const pgn = chessObj.PGN || chessObj.chessState
    chessObj.PGN = prepareWikiPgn(pgn, wikiCtx)
    chessObj.chessState = chessObj.PGN
    chessObj.format = 'PGN'
  }

  return chessObj
}

const IFRAME_RESIZE_FUDGE = 4
const IFRAME_MIN_HEIGHT = 120

const APP_STATE_KEYS = [
  'PGN',
  'FEN',
  'format',
  'mode',
  'showStartMenu',
  'gameType',
  'needsSeed',
  'bareKeywordGuard',
  'awaitingStockfishSetup',
  'signedInDisplayName',
  'wikiSite',
  'wikiSiteUrl',
  'wikiPageName',
  'wikiPageTitle',
  'itemId',
  'chessState',
  'pageOnThisWiki',
  'guestLocalStoragePersist',
  'ownerCanJournalHere',
  'viewerCanClaimWikiSeat',
  'viewerSeatId',
  'viewerAuthenticated',
  'humanPlayMode',
  'gameSettings',
  'realtime',
  'challenge',
  'challengeJoinGhost',
  'createPreviewPendingJournal',
  'openChallengeSetupPending',
  'wikiGhostPage',
  'puzzleResume',
]

const slimAppState = (chessObj, extra = {}) => {
  const slim = {}
  for (const key of APP_STATE_KEYS) {
    if (chessObj[key] !== undefined) slim[key] = chessObj[key]
  }
  return { ...slim, ...extra }
}

const maybeClearEmbedLoading = ctx => {
  if (!ctx || ctx.embedLoadingCleared) return
  ctx.embedLoadingCleared = true
  ctx.$item?.find('.wiki-chess-embed-loading').remove()
  ctx.$item?.find('.wiki-chess-embed-host').removeClass('is-loading')
}

// # Iframe Embed Sizing and Scroll

// Never let the iframe's hit target overlap the wiki item edit bar below it. The app
// reports content height from inside the iframe; rounding/layout can overshoot by a few
// pixels and swallow footer double-clicks while a tall view (e.g. leaderboards) resizes.
const capIframeHeightBelowFooter = (ctx, px) => {
  const iframe = ctx?.iframe?.[0]
  const host = ctx?.$item?.find('.wiki-chess-embed-host')[0]
  const bar = ctx?.$item?.find('.wiki-chess-item-bar')[0]
  if (!iframe || !host || !bar) return px
  iframe.style.height = `${px}px`
  host.style.height = `${px}px`
  const overlap = iframe.getBoundingClientRect().bottom - bar.getBoundingClientRect().top
  if (overlap <= 1) return px
  return Math.max(IFRAME_MIN_HEIGHT, px - Math.ceil(overlap) - IFRAME_RESIZE_FUDGE)
}

const applyIframeHeight = (ctx, px) => {
  const host = ctx?.$item?.find('.wiki-chess-embed-host')
  ctx.iframe.css('height', `${px}px`)
  host?.css({ height: `${px}px`, overflow: 'hidden' })
}

// After the iframe shrinks or the app switches mode, the wiki `.page` scroll position
// is unchanged. A tall embed that was scrolled down (e.g. to reach "Switch game mode")
// can end up with the chess item above the viewport — pin the item top to the page top.
const wikiItemTextEditing = () =>
  typeof document !== 'undefined' && Boolean(document.querySelector('.item.textEditing'))

// Board → CHOOSE menu / small modal: treat a large drop as needing a top-align scroll
// even when the app forgot to pass scrollIntoView on a later height report.
const DRASTIC_SHRINK_MIN_PX = 180
const DRASTIC_SHRINK_RATIO = 0.7
const SCROLL_INTO_VIEW_SETTLE_MS = 80

const isDrasticIframeShrink = (previousPx, nextPx) =>
  Number.isFinite(previousPx) &&
  previousPx > 0 &&
  nextPx < previousPx - DRASTIC_SHRINK_MIN_PX &&
  nextPx / previousPx < DRASTIC_SHRINK_RATIO

const scrollChessItemIntoView = (ctx, { forceAlign = false } = {}) => {
  if (wikiItemTextEditing()) return
  const itemEl = ctx?.$item?.[0]
  if (!itemEl) return

  const page = itemEl.closest('.page')
  if (!(page instanceof HTMLElement)) {
    itemEl.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' })
    return
  }

  const margin = 16
  const pageRect = page.getBoundingClientRect()
  const itemRect = itemEl.getBoundingClientRect()
  const viewHeight = pageRect.height
  const itemHeight = itemRect.height

  let delta = 0
  if (forceAlign) {
    // Mode switch / drastic shrink: always put the item top at the page top.
    delta = itemRect.top - (pageRect.top + margin)
  } else if (itemHeight <= viewHeight - 2 * margin) {
    const overflowTop = pageRect.top + margin - itemRect.top
    const overflowBottom = itemRect.bottom - (pageRect.bottom - margin)
    if (overflowTop > 0 || overflowBottom > 0) {
      delta = itemRect.top - (pageRect.top + margin)
    }
  } else {
    const overflowTop = pageRect.top + margin - itemRect.top
    const overflowBottom = itemRect.bottom - (pageRect.bottom - margin)
    if (overflowTop > 0) delta = -overflowTop
    else if (overflowBottom > 0) delta = overflowBottom
  }

  if (Math.abs(delta) < 2) return
  page.scrollTo({ top: page.scrollTop + delta, behavior: 'smooth' })
}

const scheduleScrollChessItemIntoView = (ctx, opts = {}) => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => scrollChessItemIntoView(ctx, opts))
  })
}

const queueScrollChessItemIntoView = ctx => {
  ctx.pendingScrollIntoView = true
  if (ctx.scrollIntoViewTimer) window.clearTimeout(ctx.scrollIntoViewTimer)
  // Debounce: mode switches often report height twice (pre/post layout). Scroll once
  // after the iframe has settled on the smaller size.
  ctx.scrollIntoViewTimer = window.setTimeout(() => {
    ctx.scrollIntoViewTimer = null
    if (!ctx.pendingScrollIntoView) return
    ctx.pendingScrollIntoView = false
    scheduleScrollChessItemIntoView(ctx, { forceAlign: true })
  }, SCROLL_INTO_VIEW_SETTLE_MS)
}

const resizeIframe = (ctx, height, { scrollIntoView = false } = {}) => {
  if (!ctx?.iframe) return
  maybeClearEmbedLoading(ctx)
  const measured = Math.max(IFRAME_MIN_HEIGHT, Math.ceil(Number(height) || 0) + IFRAME_RESIZE_FUDGE)
  const px = capIframeHeightBelowFooter(ctx, measured)
  const current = Number.parseInt(ctx.iframe[0]?.style?.height, 10)
  const previous = Number.isFinite(current) ? current : Number(ctx.lastIframeHeight)
  const drasticShrink = isDrasticIframeShrink(previous, px)
  if (scrollIntoView || drasticShrink) ctx.pendingScrollIntoView = true
  if (Number.isFinite(current) && Math.abs(px - current) <= 2) {
    if (ctx.pendingScrollIntoView) queueScrollChessItemIntoView(ctx)
    return
  }
  applyIframeHeight(ctx, px)
  ctx.lastIframeHeight = px
  if (ctx.pendingScrollIntoView) queueScrollChessItemIntoView(ctx)
}

const buildChessObj = (item, $item) => {
  const parsed = parseChessItem(item.text)
  const resolved = resolveChessState(parsed)
  const chessObj = { item, ...parsed, ...resolved }
  chessObj.gameSettings = normalizeGameSettings(item.gameSettings)
  let params = ''

  switch (chessObj.format) {
    case 'FIGURINE':
    case 'FEN':
      params = `?fen=${encodeURIComponent(chessObj.FEN)}`
      break
    case 'MENU':
    case 'PUZZLE':
      break
    case 'PGN':
      break
    default:
      break
  }

  return { chessObj: enrichChessObj(chessObj, $item, item), params }
}

const getItemLive = ($item, item) => {
  const key = getItemLiveKey($item, item)
  let itemLive = items.get(key)
  if (!itemLive) {
    itemLive = { key, $item, item, chessObj: {}, iframe: null, popup: null, pendingSave: false }
    items.set(key, itemLive)
  } else {
    itemLive.$item = $item
    itemLive.item = item
  }
  return itemLive
}

const findItemLiveBySource = source => {
  for (const itemLive of items.values()) {
    if (itemLive.iframe?.[0]?.contentWindow === source) return itemLive
    if (itemLive.popup === source) return itemLive
  }
  return null
}

// A refreshed popup (or one whose wiki tab dropped its window reference) can no
// longer be matched by `event.source`. It re-sends popup-ready with its itemId /
// pageKey so we can find the matching chess item still rendered in this tab and
// re-adopt the window, restoring the live link instead of leaving it hanging.
// pageKey is ephemeral (FedWiki lineup key) and can change after a wiki reload —
// prefer an exact pageKey match, but fall back to itemId alone so the journal link
// still reconnects.
const adoptRefreshedPopup = event => {
  const { itemId, pageKey } = event.data || {}
  if (!itemId) return null
  let fallback = null
  for (const itemLive of items.values()) {
    if (itemLive.item?.id !== itemId) continue
    const liveKey = getPageKey(itemLive.$item) ?? 'page'
    if (pageKey && liveKey === pageKey) {
      itemLive.popup = event.source
      itemLive.popupActive = true
      monitorPopupClosed(itemLive)
      return itemLive
    }
    if (!fallback) fallback = itemLive
  }
  if (fallback) {
    fallback.popup = event.source
    fallback.popupActive = true
    monitorPopupClosed(fallback)
    return fallback
  }
  return null
}

const applyTextToItemLive = (ctx, text) => {
  if (!ctx || !text) return
  const persisted = canonicalizePersistedChessText(text)
  ctx.item.text = persisted
  ctx.chessObj = mergeItemTextIntoChessObj(ctx.chessObj, persisted)
}

// My Chess Games / Chess Leaderboards embeds — never follow popup or installed PWA.
const isMaintenanceChessCtx = ctx =>
  isMaintenanceChessItemText(ctx?.item?.text) || isMaintenanceChessState(ctx?.chessObj)

const withAutoSave = (ctx, chessObj) => {
  chessObj.pageOnThisWiki = isPageOnCurrentWiki(ctx.$item)
  chessObj.guestLocalStoragePersist = canGuestLocalStoragePersist(ctx.$item)
  return enrichViewerContext(ctx, chessObj)
}

// Forward live shell auth to the iframe so seat claims don't rely on a stale first sync.
const enrichViewerContext = (ctx, chessObj) => {
  const canJournal = ownerCanJournalHereFlag(ctx)
  const pageOnThisWiki = Boolean(chessObj.pageOnThisWiki)
  const joinGhost = isChallengeJoinGhost(ctx.$item)
  const createPreview = isCreatePreviewPage(ctx)
  const onCurrentWiki =
    (!isGhostPage(ctx.$item) || joinGhost || createPreview) &&
    normalizeWikiSite(getWikiSite(ctx.$item)) === normalizeWikiSite(location.host)
  const authenticated = typeof isAuthenticated !== 'undefined' && Boolean(isAuthenticated)
  const owner = typeof isOwner !== 'undefined' && Boolean(isOwner)
  const wikiOwnerName = resolveSignedInUsername(
    chessObj.signedInDisplayName || (typeof ownerName !== 'undefined' ? ownerName : ''),
  )

  chessObj.ownerCanJournalHere = canJournal
  chessObj.viewerAuthenticated = authenticated
  chessObj.viewerCanClaimWikiSeat = Boolean(
    canJournal || pageOnThisWiki || (onCurrentWiki && authenticated && owner && wikiOwnerName),
  )
  if (chessObj.viewerCanClaimWikiSeat && wikiOwnerName) {
    chessObj.viewerSeatId = formatPlayerId(wikiOwnerName, location.host)
    if (!chessObj.signedInDisplayName) chessObj.signedInDisplayName = wikiOwnerName
  } else {
    delete chessObj.viewerSeatId
    // Drop a public site-owner name that would otherwise seat a guest as the owner.
    if (!authenticated || !owner) delete chessObj.signedInDisplayName
  }
  return chessObj
}

const viewerContextPayload = (ctx, chessObj) => ({
  pageOnThisWiki: Boolean(chessObj.pageOnThisWiki),
  ownerCanJournalHere: Boolean(chessObj.ownerCanJournalHere),
  guestLocalStoragePersist: Boolean(chessObj.guestLocalStoragePersist),
  signedInDisplayName: chessObj.signedInDisplayName,
  viewerCanClaimWikiSeat: Boolean(chessObj.viewerCanClaimWikiSeat),
  viewerSeatId: chessObj.viewerSeatId,
  viewerAuthenticated: Boolean(chessObj.viewerAuthenticated),
})

// Whether this viewer can persist the position to the wiki page. Forwarded to the
// chess app (see APP_STATE_KEYS), which renders the in-editor "Save Position to
// Wiki" button itself and messages back `save-position` when clicked. The grey item
// footer bar carries "Open in new window" on playable chess items (not SURVEY /
// LEADERBOARD embeds — those stay wiki-only).
const ownerCanJournalHereFlag = ctx =>
  typeof isOwner !== 'undefined' &&
  isOwner &&
  (isChallengeJoinGhost(ctx.$item) ||
    isCreatePreviewPage(ctx) ||
    (!isGhostPage(ctx.$item) && isPageOnCurrentWiki(ctx.$item)))

const pushModeChangeToViews = (ctx, source) => {
  // Maintenance embeds keep SURVEY/LEADERBOARD — do not push CHOOSE/game from a popup.
  if (isMaintenanceChessCtx(ctx)) return
  const chessObj = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  const iframeWindow = ctx.iframe?.[0]?.contentWindow
  const popupOpen = ctx.popup && !ctx.popup.closed
  try {
    if (iframeWindow && iframeWindow !== source) {
      iframeWindow.postMessage(
        {
          action: MSG.SET_STATE,
          itemId: ctx.item.id,
          chessObj: slimAppState(chessObj, { followsPopup: popupOpen }),
          replaceInPlace: true,
          wikiItemText: String(ctx.item?.text ?? ''),
        },
        window.origin,
      )
    }
    if (popupOpen && ctx.popup !== source && !isOpenerHostedPopup(ctx)) {
      ctx.popup.postMessage(
        {
          action: MSG.SET_STATE,
          itemId: ctx.item.id,
          chessObj: slimAppState(chessObj),
          replaceInPlace: true,
          wikiItemText: String(ctx.item?.text ?? ''),
        },
        window.origin,
      )
    }
  } catch (error) {
    console.error('Error pushing mode change:', error)
  }
}

// Opening/replacing the popup is navigation-only — block journal puts from either
// surface until the handoff finishes (pendingPopup / popupHandoff) and while the
// the popup is active and the embed follows it (popupActive).
const shouldBlockShellJournalSave = (ctx, event) => {
  if (!ctx) return true
  if (ctx.pendingPopup || ctx.popupHandoff) return true
  const source = event?.source
  const iframeWindow = ctx.iframe?.[0]?.contentWindow
  // While the popup is active, the embed is read-only — never journal from its surface.
  if (ctx.popupActive && source === iframeWindow) return true
  return false
}

const POPUP_HANDOFF_MS = 300

const completePopupHandoff = ctx => {
  if (!ctx) return
  window.setTimeout(() => {
    ctx.pendingPopup = false
    ctx.popupHandoff = false
  }, POPUP_HANDOFF_MS)
}

const abortPopupLaunch = ctx => {
  if (!ctx) return
  ctx.pendingPopup = false
  ctx.popupHandoff = false
  ctx.replacingPopup = false
  if (!ctx.popup || ctx.popup.closed) {
    ctx.popupActive = false
    // beginPopupLaunch sets followsPopup before window.open — clear it when the
    // popup never materializes (blocked popups / failed mobile hand-off).
    notifyEmbedFollowsPopup(ctx, false)
  }
}

const notifyEmbedFollowsPopup = (ctx, followsPopup = false) => {
  const iframeWindow = ctx?.iframe?.[0]?.contentWindow
  if (!iframeWindow) return
  // Maintenance pages stay on SURVEY/LEADERBOARD — never mirror the popup.
  const follow = isMaintenanceChessCtx(ctx) ? false : followsPopup
  const chessObj = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  iframeWindow.postMessage(
    {
      action: MSG.SET_STATE,
      itemId: ctx.item.id,
      chessObj: slimAppState(chessObj, { patchStateOnly: true, followsPopup: follow }),
      wikiItemText: String(ctx.item?.text ?? ''),
    },
    window.origin,
  )
}

// Popup window is the tab's opener (installed PWA host) — mirror embed only, never boot the host.
const isOpenerHostedPopup = ctx =>
  Boolean(ctx?.popup && !ctx.popup.closed && window.opener && ctx.popup === window.opener)

const syncChessViews = (ctx, excludeSource = null) => {
  const chessObj = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  const popupOpen = ctx.popup && !ctx.popup.closed
  const openerHost = isOpenerHostedPopup(ctx)
  const maintenance = isMaintenanceChessCtx(ctx)

  const postSync = (target, { followsPopup = false } = {}) => {
    target.postMessage(
      {
        action: MSG.SET_STATE,
        itemId: ctx.item.id,
        chessObj: slimAppState(chessObj, { patchStateOnly: true, followsPopup }),
        wikiItemText: String(ctx.item?.text ?? ''),
      },
      window.origin,
    )
  }

  try {
    const iframeWindow = ctx.iframe?.[0]?.contentWindow
    if (iframeWindow && iframeWindow !== excludeSource) {
      // Survey/leaderboard wiki items never follow an open popup/PWA.
      postSync(iframeWindow, { followsPopup: popupOpen && !maintenance })
    }
    // Reverse link: PWA is opener+host — never push SET_STATE back at it (would clobber play).
    if (popupOpen && ctx.popup !== excludeSource && !openerHost) {
      postSync(ctx.popup, { followsPopup: false })
    }
  } catch (error) {
    console.error('Error syncing chess views:', error)
  }
}

// Tell the installed PWA (window.opener) this wiki chess item can follow it.
const announceWikiTabToChessOpener = ctx => {
  // My Chess Games / Chess Leaderboards must not reverse-link to the opener PWA.
  if (isMaintenanceChessCtx(ctx)) return
  const opener = window.opener
  if (!opener || opener.closed || !isChessAppSource(opener)) return
  const itemId = ctx?.item?.id
  if (!itemId) return
  const $page = ctx.$item?.parents?.('.page:first')
  const slug = String($page?.attr?.('id') || ctx.chessObj?.wikiPageName || '').trim()
  try {
    opener.postMessage(
      {
        action: MSG.WIKI_TAB_READY,
        itemId,
        pageKey: getPageKey(ctx.$item) ?? 'page',
        ...(slug ? { slug } : {}),
      },
      window.origin,
    )
  } catch (error) {
    if (wiki.debug) console.log('announceWikiTabToChessOpener', error)
  }
}

const resumeIframePlay = ctx => {
  ctx.popupActive = false
  if (!ctx.iframe?.[0]?.contentWindow) return
  const chessObj = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  ctx.iframe[0].contentWindow.postMessage(
    {
      action: MSG.SET_STATE,
      itemId: ctx.item.id,
      chessObj: slimAppState(chessObj, { patchStateOnly: true }),
      wikiItemText: String(ctx.item?.text ?? ''),
    },
    window.origin,
  )
}

const monitorPopupClosed = ctx => {
  if (ctx.popupPoll) clearInterval(ctx.popupPoll)
  ctx.popupPoll = setInterval(() => {
    if (!ctx.popup || ctx.popup.closed) {
      clearInterval(ctx.popupPoll)
      ctx.popupPoll = null
      ctx.popup = null
      ctx.pendingPopup = false
      ctx.replacingPopup = false
      ctx.popupHandoff = false
      resumeIframePlay(ctx)
    }
  }, 1000)
}

const ensureDefaultChessItemText = item => {
  if (!String(item.text || '').trim()) {
    item.text = defaultNewChessItemLabel()
  }
}

const saveNewItemPlaceholder = ($item, item) => {
  ensureDefaultChessItemText(item)
  const $page = $item.parents('.page:first')
  if (!isGhostPage($item)) {
    wiki.pageHandler.put($page, { type: 'edit', id: item.id, item })
  }
}

// # Factory Editor and Unconfigured Item

const editor = ($item, item) => {
  if ($item.hasClass('textEditing')) return
  $item.addClass('textEditing').off()
  saveNewItemPlaceholder($item, item)
  $item.removeClass('textEditing factory')
  emit($item, item).then(() => bind($item, item))
}

const renderUnconfiguredChess = ($item, item) => {
  const itemLive = getItemLive($item, item)
  const { chessObj } = buildChessObj(item, $item)
  itemLive.chessObj = chessObj
  const $root = $('<div>', {
    class: 'wiki-plugin-chess wiki-chess-unconfigured',
    'data-item-id': itemLive.key,
  }).append(
    $('<p>', { text: 'Chess game — edit this page to choose how to play.' }),
    buildChessItemBar([createOpenInNewWindowButton()]),
  )
  ensureChessItemStyles($root)
  return $item.append($root)
}

// # Journal Save Gateway

// Record an implicit fork in the journal DOM (same shape as wiki-client addToJournal).
const JOURNAL_ACTION_SYMBOLS = {
  create: '☼',
  add: '+',
  edit: '✎',
  fork: '⚑',
  move: '↕',
  remove: '✕',
  copyIn: '⨭',
  copyOut: '⨂',
  separator: '○',
}

const addForkJournalEntry = ($page, forkSite, date = Date.now()) => {
  const host = String(forkSite || '').trim()
  if (!host || typeof wiki?.site !== 'function') return
  const $journal = $page.find('.journal')
  if (!$journal.length) return
  const slug = ($page.attr('id') || '').split('_rev')[0] || $page.attr('id')
  const forkAction = { type: 'fork', site: host, date: date - 1 }
  appendJournalActionDom($journal, forkAction, slug)
}

// Rebuild the journal action strip to match page.journal after a wiki page fork.
const rebuildJournalActions = ($page, journal) => {
  const $journal = $page.find('.journal')
  if (!$journal.length) return
  $journal.children('a.action').remove()
  const slug = ($page.attr('id') || '').split('_rev')[0] || $page.attr('id')
  const pageObject = typeof wiki?.lineup?.atKey === 'function' ? wiki.lineup.atKey($page.data('key')) : null
  // Prefer wiki's time-bucket separators so the strip matches a full page refresh.
  if (pageObject && typeof pageObject.seqActions === 'function') {
    pageObject.seqActions((each, done) => {
      if (each?.separator) {
        appendJournalActionDom(
          $journal,
          {
            type: 'separator',
            symbol: each.separator.symbol,
            date: each.separator.date,
            title: each.separator.period,
          },
          slug,
        )
      }
      if (each?.action) appendJournalActionDom($journal, each.action, slug)
      done?.()
    })
    return
  }
  for (const action of Array.isArray(journal) ? journal : []) {
    if (!action?.type) continue
    appendJournalActionDom($journal, action, slug)
  }
}

const appendJournalActionDom = ($journal, action, slug) => {
  if (typeof $ !== 'function') return
  const type = action.type || 'separator'
  const $action = $('<a href="#" />')
    .addClass('action')
    .addClass(type)
    .text(action.symbol || JOURNAL_ACTION_SYMBOLS[type] || '○')
    .attr('title', action.title || (action.site ? `${action.site}\n${action.type}` : String(action.type || '')))
    .attr('data-id', action.id || '0')
    .attr('data-date', String(action.date || 0))
    .data('action', action)
  if (action.type === 'fork' && action.site && typeof wiki?.site === 'function') {
    try {
      $action
        .css('background-image', `url(${wiki.site(action.site).flag()})`)
        .attr('href', `${wiki.site(action.site).getDirectURL(slug)}.html`)
        .attr('target', action.site)
        .data('site', action.site)
        .data('slug', slug)
    } catch {
      // Flag helpers can fail for unknown hosts; keep the fork glyph.
    }
  }
  const controls = $journal.children('.control-buttons')
  if (controls.length) $action.insertBefore(controls)
  else $action.appendTo($journal)
}

const pageHandlerPutSupportsDone = typeof wiki?.pageHandler?.put === 'function' && wiki.pageHandler.put.length >= 3

const ORIGIN_JOURNAL_PUT_DEFER_MS = 250
const ORIGIN_JOURNAL_PUT_DEFER_MAX = 48
const JOURNAL_PUT_WAIT_MS = 50
const JOURNAL_PUT_WAIT_MAX_MS = 15000

const shouldDeferChessJournalPut = ($page, { forkSite } = {}) =>
  shouldDeferOriginJournalPut({
    isOwnerFlag: typeof isOwner !== 'undefined' ? isOwner : undefined,
    pageSite: $page.data('site'),
    isLocalPage: $page.hasClass('local') || $page.data('site') === 'local',
    forkSite,
  })

const journalEntryMatchesAction = (entry, action) => {
  if (!entry || !action || entry.type !== action.type) return false
  if (action.date && entry.date === action.date) return true
  if (action.type === 'create' && action.id && entry.id === action.id) return true
  if (action.type === 'edit' && action.id && entry.id === action.id && action.date && entry.date === action.date) {
    return true
  }
  return false
}

// True once pageHandler has applied this action (origin apply, or yellow-halo local/DOM).
const journalHasAppliedAction = ($page, action) => {
  if (!action) return false
  const raw = wiki?.lineup?.atKey?.($page.data('key'))?.getRawPage?.()
  if (Array.isArray(raw?.journal) && raw.journal.some(entry => journalEntryMatchesAction(entry, action))) {
    return true
  }
  // Failed origin puts yellow-halo via pushToLocal + addToJournal without pageObject.apply.
  // Detect the journal glyph so the put queue does not stall for JOURNAL_PUT_WAIT_MAX_MS.
  if (typeof $ === 'function' && $page?.length && action.date != null) {
    let found = false
    $page.find('.journal .action').each(function eachJournalAction() {
      const $a = $(this)
      if (String($a.attr('data-date') || '') !== String(action.date)) return
      if (action.id != null && String($a.attr('data-id') || '') !== String(action.id || '0')) return
      if (action.type && !$a.hasClass(action.type)) return
      found = true
      return false
    })
    if (found) return true
  }
  return false
}

const waitForJournalPutApplied = ($page, action, done) => {
  if (typeof done !== 'function') return
  const started = Date.now()
  const tick = () => {
    if (journalHasAppliedAction($page, action) || Date.now() - started >= JOURNAL_PUT_WAIT_MAX_MS) {
      done()
      return
    }
    window.setTimeout(tick, JOURNAL_PUT_WAIT_MS)
  }
  window.setTimeout(tick, JOURNAL_PUT_WAIT_MS)
}

// Before an origin create, bump the title when the slug is already taken (sitemap
// and/or a live origin GET). Avoids Conflict → yellow local fork.
// Deliberately ignores browser localStorage and the wiki lineup — those linger after
// deletes and falsely force " (2)" titles.
const ensureUniqueCreateActionSlug = ($page, createAction, ctx, done) => {
  if (!createAction || createAction.type !== 'create') {
    done?.(createAction)
    return
  }
  const title = String(createAction.item?.title || '').trim()
  const slug = String(createAction.id || '').trim()
  const localSite = String(location.host || '').trim()
  const finish = (existingSlugs = []) => {
    const unique = proposeUniquePageTitle(title, existingSlugs)
    if (unique && unique !== title && typeof wiki?.asSlug === 'function') {
      applyGhostPageTitle($page, unique, { ctx })
      createAction.id = wiki.asSlug(unique)
      if (createAction.item) createAction.item.title = unique
    }
    done?.(createAction)
  }
  if (!slug || typeof wiki?.origin?.get !== 'function') {
    finish()
    return
  }
  const afterSitemap = (sitemapSlugs = []) => {
    wiki.origin.get(`${slug}.json`, err => {
      const slugs = [...sitemapSlugs]
      if (!err) slugs.push(slug)
      finish(slugs)
    })
  }
  if (typeof wiki?.site === 'function' && localSite) {
    try {
      wiki.site(localSite).get('system/sitemap.json', (err, res) => {
        const slugs = !err ? (asSitemapArray(res) || []).map(entry => entry?.slug).filter(Boolean) : []
        afterSitemap(slugs)
      })
      return
    } catch {
      /* fall through */
    }
  }
  afterSitemap()
}

const executePutChessPageAction = ($page, action, { forkSite, done, ctx } = {}) => {
  if (!action.date) action.date = Date.now()
  let host = String(forkSite || action.fork || '').trim()
  // Never stamp a self-fork — that poisons the journal and breaks auto-watch.
  const viewing = typeof location !== 'undefined' ? String(location.host || '').trim() : ''
  if (host && viewing && normalizeWikiSite(host) === normalizeWikiSite(viewing)) {
    host = ''
    delete action.fork
  }
  if (host) {
    addForkJournalEntry($page, host, action.date)
    action.fork = host
  }
  const putNow = nextAction => {
    if (pageHandlerPutSupportsDone) {
      wiki.pageHandler.put($page, nextAction, done)
      return
    }
    wiki.pageHandler.put($page, nextAction)
    waitForJournalPutApplied($page, nextAction, done)
  }
  if (action.type === 'create') {
    ensureUniqueCreateActionSlug($page, action, ctx, uniqueAction => putNow(uniqueAction || action))
    return
  }
  putNow(action)
}

const putChessPageAction = ($page, action, { forkSite, done, ctx } = {}) => {
  if (shouldDeferChessJournalPut($page, { forkSite })) {
    let attempts = 0
    const retry = () => {
      if (!shouldDeferChessJournalPut($page, { forkSite }) || attempts >= ORIGIN_JOURNAL_PUT_DEFER_MAX) {
        executePutChessPageAction($page, action, { forkSite, done, ctx })
        return
      }
      attempts += 1
      window.setTimeout(retry, ORIGIN_JOURNAL_PUT_DEFER_MS)
    }
    window.setTimeout(retry, ORIGIN_JOURNAL_PUT_DEFER_MS)
    return
  }
  executePutChessPageAction($page, action, { forkSite, done, ctx })
}

// Fed Wiki accepts one journal action per server round trip. When a chess save
// needs several entries (crossed swords + seat ring, or join-ghost replay),
// chain puts so each request reads the page after the previous write landed.
// Also serialize concurrent saves on the same page — otherwise an engine reply
// can edit before the ghost's origin create lands (404 → yellow local fork).
const pageJournalPutQueues = new Map()

const enqueuePageJournalPuts = ($page, run) => {
  const key = String($page?.data?.('key') || $page?.attr?.('id') || '').trim() || 'page'
  const prev = pageJournalPutQueues.get(key) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => run())
  pageJournalPutQueues.set(key, next)
  next.finally(() => {
    if (pageJournalPutQueues.get(key) === next) pageJournalPutQueues.delete(key)
  })
  return next
}

const putChessPageActionsInOrder = ($page, actions, { forkSite, onComplete, ctx } = {}) => {
  const list = (Array.isArray(actions) ? actions : []).filter(Boolean)
  enqueuePageJournalPuts(
    $page,
    () =>
      new Promise(resolve => {
        const run = index => {
          if (index >= list.length) {
            onComplete?.()
            resolve()
            return
          }
          putChessPageAction($page, list[index], {
            forkSite: String(list[index]?.fork || '').trim() || (index === 0 ? forkSite : undefined) || undefined,
            ctx,
            done: () => run(index + 1),
          })
        }
        run(0)
      }),
  )
}

const challengeJoinAcceptJournalPresent = (pageObject, itemId) => {
  const journal = pageObject?.getRawPage?.()?.journal
  if (!Array.isArray(journal)) return false
  return journal.some(
    action =>
      action?.type === 'edit' &&
      action.id === itemId &&
      action.symbol === CHESS_CREATE_SYMBOL &&
      action?.item?.text === 'GAME',
  )
}

const needsChallengeJoinAcceptJournal = (ctx, pageObject) => {
  if (!ctx?.item || isGhostPage(ctx.$item)) return false
  if (!isAcceptedGhostJoinGame(ctx.item)) return false
  if (pageObject && challengeJoinAcceptJournalPresent(pageObject, ctx.item.id)) return false
  return true
}

// After fork the page may still carry the creator's `data-site`, so `ownerCanJournalHereFlag`
// is false even though the joiner is saving onto their own wiki.
const canPersistJoinGhostJournal = ctx => {
  if (typeof isOwner === 'undefined' || !isOwner || isGhostPage(ctx.$item)) return false
  if (ownerCanJournalHereFlag(ctx)) return true
  if (!isAcceptedGhostJoinGame(ctx.item)) return false
  const local = String(location.host || '')
    .trim()
    .toLowerCase()
  const joinerSite = cleanSite(ctx.item?.challenge?.opponent?.site ?? ctx.item?.challenge?.opponent?.host)
  return Boolean(local && joinerSite && sitesMatch(joinerSite, local))
}

let challengeJoinGhostFinalizeGen = 0
const scheduleChallengeJoinGhostFinalize = ctx => {
  if (
    !ctx ||
    !needsChallengeJoinAcceptJournal(ctx, wiki?.lineup?.atKey?.(ctx.$item?.parents?.('.page:first')?.data('key')))
  ) {
    return
  }
  const gen = ++challengeJoinGhostFinalizeGen
  const attempt = (n = 0) => {
    if (gen !== challengeJoinGhostFinalizeGen) return
    if (maybeFinalizeChallengeJoinGhost(ctx)) return
    if (
      n < 12 &&
      needsChallengeJoinAcceptJournal(ctx, wiki?.lineup?.atKey?.(ctx.$item?.parents?.('.page:first')?.data('key')))
    ) {
      window.setTimeout(() => attempt(n + 1), 50 * (n + 1))
    }
  }
  window.setTimeout(() => attempt(0), 0)
}

// After a join ghost is forked, replay crossed-swords + seat rings into the journal.
// The ghost itself carries only a `create` entry so the page title stays editable.
const maybeFinalizeChallengeJoinGhost = ctx => {
  const $page = ctx?.$item?.parents?.('.page:first')
  if (!$page?.length) return false
  syncGhostPageBeforeMaterialize($page)
  const pageObject = wiki?.lineup?.atKey?.($page.data('key'))
  if (!needsChallengeJoinAcceptJournal(ctx, pageObject)) {
    if (ctx.item?.challengeJoinPendingJournal) {
      delete ctx.item.challengeJoinPendingJournal
      delete ctx.item.challengeJoinGhostPgn
    }
    return false
  }
  if (!canPersistJoinGhostJournal(ctx)) return false

  const itemId = ctx.item.id
  const seatedPgn = String(ctx.item.text || '').trim()
  const challenge = normalizeChallengeState(ctx.item.challenge)
  const ghostPgn =
    String(ctx.item.challengeJoinGhostPgn || '').trim() || reconstructGhostPgnFromSeated(seatedPgn, challenge)
  if (!ghostPgn || !seatedPgn || !challenge) return false

  const journalActions = buildJoinAcceptGhost(ghostPgn, seatedPgn, {
    itemId,
    challenge,
    ts: Number.isFinite(challenge.ts) ? challenge.ts : Date.now(),
  })
  if (!journalActions.length) return false

  $page.removeClass('ghost')

  const cleanItem = { ...ctx.item }
  delete cleanItem.challengeJoinPendingJournal
  delete cleanItem.challengeJoinGhostPgn

  putChessPageActionsInOrder($page, [...journalActions, { type: 'edit', id: itemId, item: cleanItem }], {
    ctx,
    onComplete: () => {
      ctx.item.challengeJoinPendingJournal = undefined
      ctx.item.challengeJoinGhostPgn = undefined
      Object.assign(ctx.item, cleanItem)
      delete ctx.chessObj.challengeJoinGhost
      notifyChallengeJoinForked(ctx)
    },
  })
  return true
}

const notifyChallengeJoinForked = ctx => {
  if (!ctx || ctx.challengeJoinForkNotified) return
  ctx.challengeJoinForkNotified = true
  delete ctx.chessObj.challengeJoinGhost
  sendMessage(ctx, MSG.CHALLENGE_JOIN_FORKED)
  sendMessage(ctx, MSG.SET_STATE)
}

// Shared journal put path for saveItemText and saveSeatedOpenGameJournal.
const applyChessJournalSave = (
  ctx,
  text,
  {
    fen,
    forkSite,
    title,
    resolveMaterializeAction,
    joinFinalize = 'none',
    requireStringText = false,
    surveyGuard = false,
  } = {},
) => {
  if (!ctx || !text) return false
  if (requireStringText && typeof text !== 'string') return false
  const persisted = typeof text === 'string' ? canonicalizePersistedChessText(text) : text
  if (surveyGuard && isSurveyItemText(ctx.item?.text) && ctx.item.text !== persisted) return false
  const $page = ctx.$item.parents('.page:first')
  if (isGhostPage(ctx.$item) && !isChallengeJoinGhost(ctx.$item) && !isCreatePreviewPage(ctx)) {
    return false
  }
  const { item } = ctx
  const forkingJoinGhost = isChallengeJoinGhost(ctx.$item)
  const pageTitle = String(title || ctx.chessObj?.wikiPageTitle || '').trim()
  if (pageTitle && (isCreatePreviewPage(ctx) || isChallengeJoinGhost(ctx.$item))) {
    applyGhostPageTitle($page, pageTitle, { ctx })
  }
  const prevText = item.text
  const materializeAction = resolveMaterializeAction?.(ctx, $page, {
    fen,
    forkSite,
    text: persisted,
    title: pageTitle,
  })
  const forkingCreatePreview = Boolean(materializeAction)
  if (forkingCreatePreview) {
    $page.removeClass('ghost')
    // Ghost bootstrap create stays in-memory only for create-editable titles. Clear it
    // before the slug'd create is applied so the journal never keeps both.
    clearLineupGhostBootstrapJournal($page)
  }
  if (joinFinalize === 'before') {
    if (item.challengeJoinPendingJournal || forkingJoinGhost || isAcceptedGhostJoinGame(item)) {
      scheduleChallengeJoinGhostFinalize(ctx)
      if (maybeFinalizeChallengeJoinGhost(ctx) && item.text === persisted) return true
    }
  }
  const raw = $page.data('data')
  // Create already carries the committed story text (stamped during materialize). Still
  // emit the seed edit so the journal shows the ⚔ game-start glyph before move edits.
  const coreActions = buildChessSaveActions(raw, item.id, persisted, {
    fen,
    prevText,
    forkSite,
    viewingSite: typeof location !== 'undefined' ? location.host : '',
  })
  if (!materializeAction && !coreActions?.length) return false

  if (!forkingCreatePreview) applyTextToItemLive(ctx, persisted)
  else if (item.text !== persisted) applyTextToItemLive(ctx, persisted)
  stampRealtimePresence(ctx)
  const actions = mapChessSaveActionsForJournal([materializeAction, ...(coreActions || [])].filter(Boolean), {
    stripGhost: forkingCreatePreview,
  })
  const batchForkSite = (coreActions || []).some(action => action.fork) ? undefined : forkSite
  putChessPageActionsInOrder($page, actions, {
    forkSite: batchForkSite,
    ctx,
    onComplete: forkingCreatePreview
      ? () => {
          clearCreatePreviewFlags(ctx)
          scheduleSurveyGameIndexFromCtx(ctx, persisted)
        }
      : () => scheduleSurveyGameIndexFromCtx(ctx, persisted),
  })
  if (joinFinalize === 'after') {
    if (forkingJoinGhost || isAcceptedGhostJoinGame(item)) {
      scheduleChallengeJoinGhostFinalize(ctx)
      maybeFinalizeChallengeJoinGhost(ctx)
    }
  }
  return true
}

const scheduleSurveyGameIndexFromCtx = (ctx, pgn) => {
  try {
    if (!ctx || isSurveyItemText(ctx.item?.text) || isMaintenanceChessState(ctx.chessObj)) return
    const slug = String(getPageSlug(ctx.$item) || ctx.chessObj?.wikiPageName || '').trim()
    const itemId = String(ctx.item?.id || ctx.chessObj?.itemId || '').trim()
    const title = String(ctx.chessObj?.wikiPageTitle || '').trim()
    publishSurveyGameIndexUpsert({ slug, itemId, title, pgn })
  } catch (error) {
    if (wiki.debug) console.log('scheduleSurveyGameIndexFromCtx error', error)
  }
}

// Persist a sitemap-seeded gameIndex onto My Chess Games (empty-catalog bootstrap).
const persistRebuiltSurveyGameIndex = (localSite, rebuiltGameIndex) => {
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (
    !host ||
    host !==
      String(location.host || '')
        .trim()
        .toLowerCase() ||
    !rebuiltGameIndex
  ) {
    return
  }
  putChessPageCharmPatch(SURVEY_PAGE_SLUG, { gameIndex: rebuiltGameIndex }, err => {
    if (err && wiki.debug) console.log('persistRebuiltSurveyGameIndex error', err)
  })
}

const saveItemText = (ctx, text, { fen, forkSite, title } = {}) =>
  // Journal gateway: buildChessSaveActions (chess-core.js) → wiki journal.
  applyChessJournalSave(ctx, text, {
    fen,
    forkSite,
    title,
    resolveMaterializeAction: (saveCtx, $page, { forkSite: host, text: nextText, title: pageTitle }) =>
      ghostPageMaterializeAction(saveCtx, $page, { forkSite: host, text: nextText, title: pageTitle }),
    joinFinalize: 'before',
    requireStringText: true,
    surveyGuard: true,
  })

// First save of a human game with one open seat: journal shows crossed swords for
// "game started", then the creator's seat ring (White ◎ / Black ⦿).
const saveSeatedOpenGameJournal = (ctx, text, { fen, title } = {}) =>
  applyChessJournalSave(ctx, text, {
    fen,
    title,
    resolveMaterializeAction: (saveCtx, $page, { text: nextText, title: pageTitle }) =>
      createPreviewMaterializeAction(saveCtx, $page, { text: nextText, title: pageTitle }),
    joinFinalize: 'after',
  })

const saveChessItemText = (ctx, text, { fen, forkSite, title } = {}) => {
  if (!ctx || !text) return false
  const prevText = ctx.item?.text ?? ''
  if (shouldSplitOpenSeatGameJournal(prevText, text)) {
    return saveSeatedOpenGameJournal(ctx, text, { fen, title })
  }
  return saveItemText(ctx, text, { fen, forkSite, title })
}

// Fold the local player's real-time readiness into the item carried by this move's
// edit (no separate journal entry). The app reports its seat + flag via the
// `realtime-presence` message; we only stamp our own seat, leaving the opponent's.
const stampRealtimePresence = ctx => {
  const presence = ctx?.realtimePresence
  if (!presence?.seat) return
  ctx.item.realtime = setRealtimeSeat(ctx.item.realtime, presence.seat, presence.ready, Date.now(), presence.rtcConsent)
}

const syncSavedItemToPage = (ctx, item) => {
  ctx.$item.data('item', item)
  const raw = ctx.$item.parents('.page:first').data('data')
  if (raw?.story && item?.id) {
    const index = raw.story.findIndex(entry => entry?.id === item.id)
    if (index !== -1) raw.story[index] = item
  }
}

// In-place ghost mode switches (CHOOSE → puzzle/position/game) update the iframe
// immediately but the preview story still read "CHOOSE" until the first journal save.
// Sync the live preview story in memory so title edits / re-emits do not replay CHOOSE
// and blank the board mid-boot.
const syncGhostPreviewChessItemText = (ctx, text) => {
  const nextText = String(text || '').trim()
  if (!nextText || !ctx?.item?.id || !ctx.$item?.length) return false
  if (!isGhostPage(ctx.$item) || !isCreatePreviewPage(ctx)) return false
  const $page = ctx.$item.parents('.page:first')
  if (!$page.length || !isCreatePreviewJournal($page)) return false

  applyTextToItemLive(ctx, nextText)
  // In-place CHOOSE → POSITION/PUZZLE keeps the ghost forkable even after the bare
  // keyword changes; persist the flag on the item so FEN/PGN text still materializes.
  if (!ctx.item.createPreviewPendingJournal) ctx.item.createPreviewPendingJournal = true
  syncSavedItemToPage(ctx, ctx.item)
  syncGhostPageStoryBeforeMaterialize($page)
  ctx.emitKey = chessEmitKeyFor(ctx.item, ctx.$item)
  const { chessObj } = buildChessObj(ctx.item, ctx.$item)
  ctx.chessObj = chessObj
  return true
}

// # Realtime Item Persistence

// Session-only seat readiness / real-time consent (ephemeral — not journaled).
const saveRealtimePresence = (ctx, presence) => {
  if (!ctx || !presence?.seat) return false
  const { item } = ctx
  const prev = normalizeRealtimeState(item.realtime)[presence.seat]
  item.realtime = setRealtimeSeat(item.realtime, presence.seat, presence.ready, Date.now(), presence.rtcConsent)
  ctx.chessObj.realtime = item.realtime
  const readyChanged = Boolean(prev?.ready) !== Boolean(presence.ready)
  const consentChanged = presence.rtcConsent !== undefined && Boolean(prev?.rtcConsent) !== Boolean(presence.rtcConsent)
  if (!readyChanged && !consentChanged) return false
  return true
}

// Session-only WebRTC handshake blob (ephemeral — not journaled).
const saveRealtimeSignal = (ctx, seat, signal) => {
  if (!ctx || (seat !== 'White' && seat !== 'Black')) return false
  const { item } = ctx
  const map = { ...(item.realtimeSignal && typeof item.realtimeSignal === 'object' ? item.realtimeSignal : {}) }
  if (signal) map[seat] = signal
  else delete map[seat]
  if (Object.keys(map).length) item.realtimeSignal = map
  else delete item.realtimeSignal
  ctx.chessObj.realtimeSignal = item.realtimeSignal
  return true
}

// Session-only game settings (not journaled as a metadata edit).
const saveItemSettings = (ctx, gameSettings) => {
  if (!ctx || isGhostPage(ctx.$item)) return false
  const normalized = normalizeGameSettings(gameSettings)
  const { item } = ctx
  const prev = normalizeGameSettings(item.gameSettings)
  if (
    prev.confirmMoves === normalized.confirmMoves &&
    prev.sameDeviceFlip === normalized.sameDeviceFlip &&
    prev.sameDeviceFlipPieces === normalized.sameDeviceFlipPieces &&
    prev.autoAcceptOpponentWikiMoves === normalized.autoAcceptOpponentWikiMoves &&
    prev.autoAcceptOpponentWikiGameEnd === normalized.autoAcceptOpponentWikiGameEnd &&
    prev.challengeCreatorColor === normalized.challengeCreatorColor
  ) {
    return false
  }
  item.gameSettings = normalized
  ctx.chessObj.gameSettings = normalized
  return true
}

// Session-only challenge descriptor. Prefer openChallengeFromPgn when reading.
const saveItemChallenge = (ctx, challenge) => {
  if (!ctx) return false
  const normalized = normalizeChallengeState(challenge)
  const prevKey = JSON.stringify(normalizeChallengeState(ctx.chessObj?.challenge) || null)
  const nextKey = JSON.stringify(normalized || null)
  if (prevKey === nextKey) return false
  ctx.chessObj.challenge = normalized || undefined
  return true
}

// True when the most recent change recorded in this page's journal was an edit
// of THIS chess item — i.e. the last thing saved really was this game's own
// move. We use it to gate take-back rollbacks so an undo only rewinds the saved
// game when it's safe to, never overwriting an unrelated edit or a remote
// opponent's move that arrived after our last move. (Fork entries are skipped;
// they wrap an edit rather than being a change of their own.)
const lastJournalActionIsItemEdit = ctx => {
  try {
    const key = ctx.$item.parents('.page:first').data('key')
    const journal = wiki?.lineup?.atKey(key)?.getRawPage()?.journal
    if (!Array.isArray(journal)) return false
    for (let i = journal.length - 1; i >= 0; i--) {
      const action = journal[i]
      if (!action || action.type === 'fork') continue
      return action.type === 'edit' && action.id === ctx.item.id
    }
  } catch (error) {
    if (wiki.debug) console.log('lastJournalActionIsItemEdit error', error)
  }
  return false
}

const resyncChessItemsOnPage = $page => {
  if (!$page?.length) return
  for (const ctx of items.values()) {
    if (ctx.$item?.parents?.('.page:first')?.[0] === $page[0]) sendMessage(ctx, MSG.SET_STATE)
  }
}

const chessEmitKeyFor = (item, $item) =>
  chessItemEmitKey({
    pageKey: getPageKey($item) ?? 'page',
    itemId: item?.id,
    itemText: item?.text,
    ghostPreview: Boolean(
      item?.createPreviewPendingJournal && $item?.length && isGhostPage($item) && isCreatePreview(item, $item),
    ),
  })

const isEmbedFrameLive = iframe => {
  const el = iframe?.[0]
  if (!el?.contentWindow) return false
  try {
    return el.contentDocument?.readyState === 'complete'
  } catch {
    return false
  }
}

const iframeMatchesPluginBuild = iframe => {
  try {
    const src = iframe?.[0]?.getAttribute?.('src') || iframe?.[0]?.src || ''
    return src.includes(`v=${encodeURIComponent(pluginBuildId)}`)
  } catch {
    return false
  }
}

const canReuseChessEmbed = (ctx, emitKey) =>
  Boolean(
    ctx?.emitKey &&
      ctx.emitKey === emitKey &&
      ctx.iframe?.length &&
      isEmbedFrameLive(ctx.iframe) &&
      iframeMatchesPluginBuild(ctx.iframe),
  )

// jQuery empty()/detach() discards an iframe's browsing context (the running chess
// app, Stockfish worker, game state). Where the state-preserving Element.moveBefore()
// exists (Chrome 133+, Firefox 144+ — not Safari yet), evacuate a live frame to
// document.body before the item DOM is torn down so reattaching it does not reload.
const supportsStatePreservingMove = () =>
  typeof Element !== 'undefined' && typeof Element.prototype.moveBefore === 'function'

const evacuateChessIframe = ctx => {
  const el = ctx?.iframe?.[0]
  if (!el?.isConnected || el.parentElement === document.body || !supportsStatePreservingMove()) return
  try {
    document.body.moveBefore(el, null)
  } catch {
    // Leave it in place; the caller's empty() discards it and the frame reloads as before.
  }
}

const restoreRebuildParkedIframeStyle = iframeEl => {
  if (!iframeEl?.dataset?.wikiChessRebuildParked) return
  const saved = iframeEl.dataset.wikiChessRebuildParkedStyle
  if (saved) iframeEl.setAttribute('style', saved)
  else iframeEl.removeAttribute('style')
  delete iframeEl.dataset.wikiChessRebuildParked
  delete iframeEl.dataset.wikiChessRebuildParkedStyle
}

const appendChessPluginDom = ($item, ctx, { loading = false } = {}) => {
  // My Chess Games / Chess Leaderboards are embed-only — omit the popup button
  // (beginPopupLaunch would no-op; a visible dead control is worse).
  const controls = isMaintenanceChessCtx(ctx) ? [] : [createOpenInNewWindowButton()]
  const $embedHost = $('<div>', { class: 'wiki-chess-embed-host' })
  if (loading) {
    $embedHost.addClass('is-loading')
    const $loading = $('<div>', { class: 'wiki-chess-embed-loading', 'aria-live': 'polite' }).append(
      $('<p>', {
        class: 'wiki-chess-embed-loading-text',
        text: 'Loading Federated Wiki Chess…',
      }),
    )
    $embedHost.append($loading)
  }
  const $root = $('<div>', { class: 'wiki-plugin-chess', 'data-item-id': ctx.key }).append([
    $embedHost,
    buildChessItemBar(controls),
  ])
  ensureChessItemStyles($root)
  $item.append($root)
  const iframeEl = ctx.iframe?.[0]
  // A still-connected iframe (evacuated to document.body across a page rebuild) is
  // moved into the new host without a reload via the state-preserving moveBefore().
  if (iframeEl?.isConnected && supportsStatePreservingMove()) {
    try {
      $embedHost[0].moveBefore(iframeEl, null)
      restoreRebuildParkedIframeStyle(iframeEl)
      return $item
    } catch {
      // Fall through to the detach/append reattach (reloads the frame).
    }
  }
  ctx.iframe.detach()
  $embedHost.append(ctx.iframe)
  return $item
}

const sendMessage = (ctx, action, extra = {}) => {
  const chessObj = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  const msg = {
    action,
    itemId: ctx.item.id,
    chessObj: slimAppState(chessObj, extra),
    wikiItemText: String(ctx.item?.text ?? ''),
  }
  try {
    if (ctx.popup) ctx.popup.postMessage(msg, window.origin)
    if (ctx.iframe) ctx.iframe[0].contentWindow.postMessage(msg, window.origin)
  } catch (error) {
    console.error('Error sending message:', error)
  }
}

// Full boot state for a freshly opened popup only. The embedded iframe stays on
// patchStateOnly follower updates — broadcasting a full SET_STATE to both surfaces makes
// the iframe re-run survey crawls and race the popup's own request.
const sendPopupBootState = (ctx, target = ctx.popup, { replaceInPlace = false } = {}) => {
  if (!target) return
  try {
    if (target.closed) return
  } catch {
    return
  }
  const chessObj = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  target.postMessage(
    {
      action: MSG.SET_STATE,
      itemId: ctx.item.id,
      chessObj: slimAppState(chessObj),
      replaceInPlace,
      wikiItemText: String(ctx.item?.text ?? ''),
    },
    window.origin,
  )
}

const emit = async ($item, item, { forceRebuild = false } = {}) => {
  if (isGhostPage($item) && isNewChessItem(item.text) && !isCreatePreview(item, $item)) {
    $item.empty()
    return renderUnconfiguredChess($item, item)
  }

  const itemLive = getItemLive($item, item)
  const emitKey = chessEmitKeyFor(item, $item)

  // Fed Wiki's plugin.do/renderFrom empties lineup items even when their data did
  // not change. Reattach the live iframe instead of reloading when only the shell
  // DOM was torn down (e.g. after editing a paragraph above this chess item).
  if (!forceRebuild && canReuseChessEmbed(itemLive, emitKey)) {
    itemLive.$item = $item
    itemLive.item = item
    const { chessObj } = buildChessObj(item, $item)
    itemLive.chessObj = chessObj
    evacuateChessIframe(itemLive)
    $item.empty()
    const $root = appendChessPluginDom($item, itemLive)
    sendMessage(itemLive, MSG.SET_STATE, { patchStateOnly: true })
    announceWikiTabToChessOpener(itemLive)
    return $root
  }

  // In-place ghost mode switches (CHOOSE → puzzle/position/game) update preview item
  // text before the wiki title sync. Rebuilding the iframe mid-boot leaves a blank
  // board; reattach the live frame and push a full SET_STATE for the new mode instead.
  if (
    !forceRebuild &&
    itemLive?.iframe?.length &&
    isEmbedFrameLive(itemLive.iframe) &&
    iframeMatchesPluginBuild(itemLive.iframe) &&
    itemLive.item?.id === item?.id &&
    (getPageKey($item) ?? 'page') === (getPageKey(itemLive.$item) ?? 'page') &&
    isGhostPage($item) &&
    isCreatePreview(item, $item) &&
    isCreatePreviewPage(itemLive)
  ) {
    itemLive.$item = $item
    itemLive.item = item
    const { chessObj } = buildChessObj(item, $item)
    itemLive.chessObj = chessObj
    itemLive.emitKey = emitKey
    evacuateChessIframe(itemLive)
    $item.empty()
    const $root = appendChessPluginDom($item, itemLive)
    // The live iframe already switched modes in-place; mirror shell metadata only.
    sendMessage(itemLive, MSG.SET_STATE, { patchStateOnly: true })
    announceWikiTabToChessOpener(itemLive)
    return $root
  }

  $item.empty()

  const { chessObj, params } = buildChessObj(item, $item)
  itemLive.chessObj = chessObj
  itemLive.emitKey = emitKey

  if (itemLive.iframe) {
    itemLive.leaderboardFetchGen = (itemLive.leaderboardFetchGen || 0) + 1
    itemLive.iframe.remove()
    itemLive.iframe = null
  }
  // The fresh app instance re-requests any remote watch via `remote-watch`.
  stopRemoteWatch(itemLive)

  itemLive.embedLoadingCleared = false
  itemLive.initialShellStateSent = false
  const pageKey = getPageKey($item) ?? 'page'
  const iframeId = `chess-board-${safeDomId(itemLive.key)}`
  itemLive.iframe = $('<iframe>', {
    id: iframeId,
    class: 'chess-board-frame',
    scrolling: 'no',
    style: 'width:100%;border:0;overflow:hidden;display:block;height:280px;',
    src: `//${location.host}/plugins/chess/index.html?itemId=${encodeURIComponent(item.id)}&pageKey=${encodeURIComponent(pageKey)}&v=${encodeURIComponent(pluginBuildId)}${params ? '&' + params.slice(1) : ''}`,
  })
  itemLive.iframe.on('load', () => {
    itemLive.$item?.find('.wiki-chess-embed-loading-text').text('Starting Federated Wiki Chess…')
    announceWikiTabToChessOpener(itemLive)
    // chess-app.js may still be loading when 'load' fires; retry until the iframe boots.
    const retryEmbedBoot = (attempt = 0) => {
      if (itemLive.embedLoadingCleared || !itemLive.iframe?.[0]?.contentWindow || attempt > 30) return
      try {
        sendMessage(itemLive, MSG.SET_STATE, attempt > 0 ? { patchStateOnly: true } : {})
      } catch {
        /* ignore */
      }
      if (!itemLive.embedLoadingCleared) window.setTimeout(() => retryEmbedBoot(attempt + 1), 400)
    }
    window.setTimeout(() => retryEmbedBoot(0), 200)
  })

  const $root = appendChessPluginDom($item, itemLive, { loading: true })
  if (
    !isGhostPage($item) &&
    needsChallengeJoinAcceptJournal(itemLive, wiki?.lineup?.atKey?.($item.parents('.page:first').data('key')))
  ) {
    scheduleChallengeJoinGhostFinalize(itemLive)
  }
  announceWikiTabToChessOpener(itemLive)
  return $root
}

// # Paste Capture Shell

const applyPasteToItem = (ctx, payload) => {
  const text = payload?.itemText
  if (!text || !ctx || !payload?.actionable) return
  const prevText = ctx.item.text
  applyTextToItemLive(ctx, text)
  const { chessObj } = buildChessObj(ctx.item, ctx.$item)
  ctx.chessObj = enrichChessObj(chessObj, ctx.$item, ctx.item)
  if (!isGhostPage(ctx.$item)) {
    const action = withChessSymbol(
      {
        type: 'edit',
        id: ctx.item.id,
        item: ctx.item,
      },
      prevText,
      text,
    )
    putChessPageAction(ctx.$item.parents('.page:first'), action, {
      forkSite: payload.forkSite,
    })
  }
  resumeIframePlay(ctx)
  updateChessItemControls(ctx)
}

const wikiCanPresentGhost = () => typeof wiki?.newPage === 'function' && typeof wiki?.showResult === 'function'

const shellPasteModalMount = ctx => {
  const $root = ctx?.$item?.find?.('.wiki-plugin-chess')?.first?.()
  return $root?.length ? $root[0] : null
}

const pasteModalOptionsForItemLive = (ctx, payload, { onApply, originalText } = {}) => {
  const unchanged = Paste.matchesCurrent(payload, originalText ?? ctx?.item?.text)
  const what = payload.format === 'FEN' || payload.format === 'FIGURINE' ? 'position' : 'game'
  const canPersist = isPageOnCurrentWiki(ctx.$item)
  const canReplaceCurrent = Paste.canReplaceCurrentItem(originalText ?? ctx?.item?.text)
  const mount = shellPasteModalMount(ctx)
  return {
    canPersist,
    unchanged,
    unchangedMessage: `That's the same ${what} that's already in this item — nothing will change.`,
    applyLabel: Paste.applyLabel(canPersist),
    createNewLabel: Paste.createNewLabel(payload),
    canReplaceCurrent,
    canCreateNew: !unchanged && payload.actionable && wikiCanPresentGhost(),
    // Keep shell paste UI inside the chess item — never document.body / wiki chrome.
    mount: mount || undefined,
    embedded: Boolean(mount),
    onApply: () => (onApply ? onApply(payload) : applyPasteToItem(ctx, payload)),
    onCreateNew: () =>
      showPasteGhost({
        payload,
        anchor: ctx.$item?.parents?.('.page')?.first?.() || null,
        ctx,
      }),
  }
}

const isIframePasteReady = ctx => {
  const iframe = ctx?.iframe?.[0]
  if (!iframe?.contentWindow) return false
  try {
    return iframe.contentDocument?.readyState === 'complete'
  } catch {
    return false
  }
}

const forwardPasteToIframe = (ctx, text) => {
  if (!isIframePasteReady(ctx)) return false
  const target = ctx.iframe[0].contentWindow
  try {
    target.postMessage({ action: MSG.PASTE_CAPTURE, itemId: ctx.item?.id, text }, window.origin)
    return true
  } catch (error) {
    console.error('Error forwarding paste to chess board:', error)
    return false
  }
}

const bindChessItemPaste = ($item, ctx) => {
  let lastItemPasteAt = 0

  const isPasteShortcut = event =>
    (event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'v'

  const pasteTargetBlocked = event =>
    $item.hasClass('textEditing') || $(event.target).closest('input, textarea, [contenteditable="true"]').length

  const readItemClipboardText = async event => {
    const native = event.originalEvent || event
    const fromEvent = native.clipboardData?.getData?.('text/plain')
    if (fromEvent?.trim()) return fromEvent
    try {
      const text = await navigator.clipboard?.readText?.()
      if (text?.trim()) return text
    } catch {
      // Clipboard read can fail without permission.
    }
    return ''
  }

  const applyPasteFromText = text => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return
    const now = Date.now()
    if (now - lastItemPasteAt < 150) return
    lastItemPasteAt = now
    // Show the confirmation inside the chess board (iframe) rather than as a
    // full-wiki overlay. Persistence still flows back via the 'paste-apply'
    // message the app posts on confirm. Fall back to the wiki modal only if the
    // board iframe isn't available.
    const payload = Paste.capture(trimmed, 'wiki-item')
    if (!payload.actionable) return
    if (forwardPasteToIframe(ctx, trimmed)) return
    openPasteConfirmModal(payload, pasteModalOptionsForItemLive(ctx, payload))
  }

  const handlePaste = async event => {
    if (pasteTargetBlocked(event)) return
    const text = await readItemClipboardText(event)
    if (!text?.trim()) return
    event.preventDefault()
    applyPasteFromText(text)
  }

  const handlePasteKeydown = event => {
    if (!isPasteShortcut(event)) return
    void handlePaste(event)
  }

  $item.on('paste', handlePaste)
  $item.on('keydown', handlePasteKeydown)

  const $bar = $item.find('.wiki-chess-item-bar')
  $bar.on('mousedown', event => {
    if (event.button !== 0) return
    $bar[0]?.focus({ preventScroll: true })
  })
  $bar.on('paste', handlePaste)
  $bar.on('keydown', handlePasteKeydown)

  $item.find('.wiki-plugin-chess').on('mousedown', event => {
    if (event.button !== 0) return
    $bar[0]?.focus({ preventScroll: true })
  })
}

// Open the wiki text editor for this chess item. Abandon any in-flight federated crawl
// in the iframe first so a late reply cannot repaint after the editor replaces the embed.
const escapeChessEditorText = string =>
  String(string ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

const readChessEditorClipboard = async event => {
  const native = event?.originalEvent || event
  const fromEvent = native?.clipboardData?.getData?.('text/plain')
  if (fromEvent?.trim()) return fromEvent
  try {
    const text = await navigator.clipboard?.readText?.()
    if (text?.trim()) return text
  } catch {
    // Clipboard read can fail without permission.
  }
  return ''
}

const offerChessItemPaste = (ctx, text, { onApply, originalText } = {}) => {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return
  const payload = Paste.capture(trimmed, 'wiki-item')
  if (!payload.actionable) return
  openPasteConfirmModal(payload, pasteModalOptionsForItemLive(ctx, payload, { onApply, originalText }))
}

const openChessItemEditor = ctx => {
  const $item = ctx?.$item
  if (!$item?.length || $item.hasClass('textEditing')) return
  const item = $item.data('item') || ctx.item
  if (!item || !$('.editEnable').is(':visible')) return
  try {
    ctx.iframe?.[0]?.contentWindow?.postMessage({ action: MSG.ABANDON_FETCHES }, window.origin)
  } catch (error) {
    if (wiki.debug) console.log('abandon crawls before edit error', error)
  }

  const original = String(item.text ?? '')
  $item.addClass('textEditing').off()

  const lineCount = Math.max(3, Math.min(24, original.split(/\r?\n/).length + 1))
  const $textarea = $(
    `<textarea rows="${lineCount}" style="min-height:${Math.max(4, lineCount) * 1.35}em;width:100%;box-sizing:border-box">${escapeChessEditorText(original)}</textarea>`,
  )

  const finishEditing = async ({ save = false, nextText = original } = {}) => {
    $textarea.off()
    $item.removeClass('textEditing')
    const trimmed = String(nextText ?? '').trim()
    if (save && trimmed !== original.trim() && isEditableChessItemText(trimmed)) {
      const prevText = item.text
      applyTextToItemLive(ctx, trimmed)
      if (!isGhostPage($item)) {
        wiki.pageHandler.put(
          $item.parents('.page:first'),
          withChessSymbol(
            {
              type: 'edit',
              id: item.id,
              item,
            },
            prevText,
            trimmed,
          ),
        )
      }
    }
    await emit($item, item)
    bind($item, ctx)
  }

  const saveFromTextarea = () => {
    const next = $textarea.val()
    if (String(next ?? '').trim() === original.trim() || isEditableChessItemText(next)) {
      void finishEditing({ save: true, nextText: next })
    } else {
      void finishEditing({ save: false })
    }
  }

  const insertTextAtCaret = text => {
    const el = $textarea[0]
    if (!el) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const before = el.value.slice(0, start)
    const after = el.value.slice(end)
    el.value = `${before}${text}${after}`
    const caret = start + String(text).length
    el.setSelectionRange(caret, caret)
    const rows = Math.max(3, Math.min(24, el.value.split(/\r?\n/).length + 1))
    el.rows = rows
    el.style.minHeight = `${rows * 1.35}em`
  }

  const handlePaste = async event => {
    const text = await readChessEditorClipboard(event)
    if (!text?.trim()) return
    // Multiline puzzle banks (JSONL / CSV rows) insert into the textarea like markdown.
    if (looksLikePuzzleBankPaste(text) || looksLikePuzzleBankPaste($textarea.val() + '\n' + text)) {
      event.preventDefault()
      insertTextAtCaret(text)
      return
    }
    event.preventDefault()
    offerChessItemPaste(ctx, text, {
      originalText: original,
      onApply: payload => finishEditing({ save: true, nextText: payload.itemText }),
    })
  }

  // Plain Enter inserts a newline (markdown-like). Esc / Ctrl|Cmd+S commit.
  // Do not split or close the chess item on Enter.
  const handleKeydown = event => {
    if (event.which === 27 || ((event.ctrlKey || event.metaKey) && event.which === 83)) {
      event.preventDefault()
      saveFromTextarea()
    }
  }

  $textarea.on('focusout', saveFromTextarea).on('keydown', handleKeydown).on('paste', handlePaste)
  $item.html($textarea)
  $textarea.trigger('focus')
}

const findItemLiveForItemBar = barEl => {
  const $bar = $(barEl)
  const $item = $bar.closest('.item')
  if (!$item.length) return null
  const item = $item.data('item')
  if (!item || item.type !== 'chess') return null
  const key = $bar.closest('.wiki-plugin-chess').data('item-id')
  if (key && items.has(String(key))) return items.get(String(key))
  return items.get(getItemLiveKey($item, item)) || null
}

// Capture-phase handler so footer edit still works when the iframe hit box overshoots
// the embed host and would otherwise steal the double-click during leaderboard crawls.
const wireChessItemBarEdit = () => {
  if (typeof document === 'undefined' || document.documentElement.dataset.wikiChessBarEditWired) return
  document.documentElement.dataset.wikiChessBarEditWired = '1'
  document.addEventListener(
    'dblclick',
    event => {
      const bar = event.target?.closest?.('.wiki-chess-item-bar')
      if (!bar) return
      // Match paragraph / factory: no-op when wiki edit mode is off (no editor, no flicker).
      if (!$('.editEnable').is(':visible')) return
      const itemLive = findItemLiveForItemBar(bar)
      if (!itemLive) return
      event.preventDefault()
      event.stopImmediatePropagation()
      openChessItemEditor(itemLive)
    },
    true,
  )
}

// Wiki lineup sortable uses helper:"original" and clones the item on sortstart for a
// hidden shadow-copy. Cloning a live chess iframe is the multi-second lag; the pointer
// then hits the lagged live board. Fix: shortly before the 150ms sortable delay ends,
// park the iframe on document.body as a fixed non-interactive ghost that tracks the
// placeholder, so sortstart's clone is cheap and the floating visual stays the real UI.
// A quick tap cancels the pending arm so the iframe never reparents (no flash).
let wikiChessSortActive = false
let wikiChessDragGhost = null
let wikiChessArmTimer = null
let wikiChessArmPendingItem = null
// Must be < wiki-client story sortable delay (150ms) so the iframe is parked before clone.
const WIKI_CHESS_DRAG_ARM_MS = 120

const cancelPendingChessDragArm = () => {
  if (wikiChessArmTimer != null) {
    clearTimeout(wikiChessArmTimer)
    wikiChessArmTimer = null
  }
  wikiChessArmPendingItem = null
}

const scheduleChessItemDragArm = $item => {
  cancelPendingChessDragArm()
  if (!$item?.length) return
  wikiChessArmPendingItem = $item
  wikiChessArmTimer = setTimeout(() => {
    wikiChessArmTimer = null
    const pending = wikiChessArmPendingItem
    wikiChessArmPendingItem = null
    if (pending?.length) armChessItemForWikiDrag(pending)
  }, WIKI_CHESS_DRAG_ARM_MS)
}

const shieldChessIframesForWikiSort = () => {
  document.querySelectorAll('iframe.chess-board-frame').forEach(iframe => {
    if (iframe.classList.contains('wiki-chess-drag-ghost')) return
    if (iframe.dataset.wikiChessDragShielded === '1') return
    const host = iframe.closest('.wiki-chess-embed-host')
    if (!host) return
    iframe.dataset.wikiChessDragShielded = '1'
    const shield = document.createElement('div')
    shield.className = 'wiki-chess-iframe-drag-shield'
    host.appendChild(shield)
  })
}

const syncWikiChessDragGhost = () => {
  const ghost = wikiChessDragGhost
  if (!ghost?.iframe || !ghost.placeholder) return
  const rect = ghost.placeholder.getBoundingClientRect()
  ghost.iframe.style.left = `${rect.left}px`
  ghost.iframe.style.top = `${rect.top}px`
  ghost.iframe.style.width = `${rect.width}px`
  ghost.iframe.style.height = `${ghost.height}px`
}

const armChessItemForWikiDrag = $item => {
  if (wikiChessDragGhost || !$item?.length) return false
  const $root = $item.find('.wiki-plugin-chess').first()
  const host = $item.find('.wiki-chess-embed-host')[0]
  const iframe = $item.find('iframe.chess-board-frame')[0]
  if (!$root.length || !host || !iframe) return false
  if (iframe.dataset.wikiChessDragFrozen === '1') return true

  const rect = iframe.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height || iframe.offsetHeight || 280))
  const savedStyle = iframe.getAttribute('style') || ''

  const placeholder = document.createElement('div')
  placeholder.className = 'wiki-chess-drag-freeze'
  placeholder.setAttribute('aria-hidden', 'true')
  placeholder.style.height = `${height}px`

  // Reparent before sortstart so wiki's $item.clone() does not deep-clone the iframe.
  iframe.dataset.wikiChessDragFrozen = '1'
  iframe.classList.add('wiki-chess-drag-ghost')
  iframe.style.cssText = [
    `position:fixed`,
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${width}px`,
    `height:${height}px`,
    `z-index:10000`,
    `margin:0`,
    `border:0`,
    `pointer-events:none`,
    `display:block`,
    `overflow:hidden`,
  ].join(';')
  document.body.appendChild(iframe)
  host.appendChild(placeholder)
  $root.addClass('is-wiki-dragging')

  wikiChessDragGhost = {
    iframe,
    host,
    placeholder,
    $root,
    height,
    savedStyle,
  }
  return true
}

const thawChessItemsAfterWikiDrag = () => {
  cancelPendingChessDragArm()
  document.querySelectorAll('.wiki-chess-iframe-drag-shield').forEach(el => el.remove())
  document.querySelectorAll('iframe.chess-board-frame[data-wiki-chess-drag-shielded]').forEach(iframe => {
    delete iframe.dataset.wikiChessDragShielded
  })

  const ghost = wikiChessDragGhost
  wikiChessDragGhost = null
  if (ghost?.iframe) {
    const { iframe, host, placeholder, $root, savedStyle } = ghost
    iframe.classList.remove('wiki-chess-drag-ghost')
    delete iframe.dataset.wikiChessDragFrozen
    if (savedStyle) iframe.setAttribute('style', savedStyle)
    else iframe.removeAttribute('style')
    if (host?.isConnected && placeholder?.parentNode === host) {
      host.replaceChild(iframe, placeholder)
    } else if (host?.isConnected) {
      placeholder?.remove?.()
      host.appendChild(iframe)
    } else if (placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(iframe, placeholder)
      placeholder.remove()
    }
    $root?.removeClass?.('is-wiki-dragging')
  }

  document.querySelectorAll('.wiki-chess-drag-freeze').forEach(el => el.remove())
  document.querySelectorAll('.wiki-plugin-chess.is-wiki-dragging').forEach(el => {
    el.classList.remove('is-wiki-dragging')
  })
}

// The footer "wiki" edit-mode toggle rebuilds every lineup page with $page.empty(),
// which discards each chess iframe's browsing context and forces a cold app reboot
// (visible mode cycling, Stockfish restart). Where moveBefore() exists, park the live
// iframes on document.body as fixed ghosts in the click capture phase — before the
// wiki's bubble-phase handler empties the pages — so emit()'s reuse path can move them
// back without a reload. Browsers without moveBefore keep the cold-reboot behavior.
const REBUILD_PARK_ORPHAN_MS = 10000
let rebuildParkOrphanTimer = null

const removeOrphanedRebuildParkedIframes = () => {
  rebuildParkOrphanTimer = null
  document.querySelectorAll('iframe.chess-board-frame[data-wiki-chess-rebuild-parked]').forEach(el => el.remove())
}

const parkChessEmbedsBeforePageRebuild = () => {
  if (!supportsStatePreservingMove()) return
  document.querySelectorAll('.page iframe.chess-board-frame').forEach(iframe => {
    if (iframe.dataset.wikiChessRebuildParked || iframe.dataset.wikiChessDragFrozen === '1') return
    const rect = iframe.getBoundingClientRect()
    const savedStyle = iframe.getAttribute('style') || ''
    try {
      document.body.moveBefore(iframe, null)
    } catch {
      return
    }
    iframe.dataset.wikiChessRebuildParked = '1'
    iframe.dataset.wikiChessRebuildParkedStyle = savedStyle
    // Freeze the frame at its on-screen position so the board appears untouched
    // while the wiki rebuilds the page DOM underneath it.
    iframe.style.cssText = [
      'position:fixed',
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${Math.max(1, Math.round(rect.width))}px`,
      `height:${Math.max(1, Math.round(rect.height))}px`,
      'z-index:9999',
      'margin:0',
      'border:0',
      'pointer-events:none',
      'display:block',
      'overflow:hidden',
    ].join(';')
  })
  if (rebuildParkOrphanTimer != null) clearTimeout(rebuildParkOrphanTimer)
  rebuildParkOrphanTimer = window.setTimeout(removeOrphanedRebuildParkedIframes, REBUILD_PARK_ORPHAN_MS)
}

const wireWikiEditTogglePark = () => {
  if (typeof document === 'undefined') return
  if (document.documentElement.dataset.wikiChessEditToggleParkWired) return
  document.documentElement.dataset.wikiChessEditToggleParkWired = '1'
  document.addEventListener(
    'click',
    event => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('footer')) return
      // The toggle is a plain footer <span> wrapping the .editEnable checkmark; the
      // click may land on either the wrapper or the (visible) checkmark itself.
      const span = target.closest('span')
      if (!span) return
      const toggle = span.classList.contains('editEnable') ? span.parentElement : span
      if (!toggle?.querySelector?.('.editEnable')) return
      parkChessEmbedsBeforePageRebuild()
    },
    true,
  )
}

const wireWikiSortableChessFreeze = () => {
  if (typeof document === 'undefined' || typeof $ === 'undefined') return
  if (document.documentElement.dataset.wikiChessSortFreezeWired) return
  document.documentElement.dataset.wikiChessSortFreezeWired = '1'

  // Schedule arm just before sortable's 150ms delay — a quick tap cancels and never freezes.
  // Skip the grey item bar (paste/edit chrome): it is not a drag handle, and a deliberate
  // double-click there easily outlasts 120ms, which used to park/restore the iframe (flicker)
  // even when wiki edit mode is off and there is no sortable at all.
  $(document).on('pointerdown.wikiChessFreeze', '.wiki-plugin-chess', event => {
    if (event.button != null && event.button !== 0) return
    if (!$('.editEnable').is(':visible')) return
    if (event.target?.closest?.('button, a, input, textarea, select, .wiki-modal-root, .wiki-chess-item-bar')) {
      return
    }
    const $item = $(event.currentTarget).closest('.item')
    if (!$item.length) return
    scheduleChessItemDragArm($item)
  })

  $(document).on('pointerup.wikiChessFreeze pointercancel.wikiChessFreeze', () => {
    if (!wikiChessSortActive) thawChessItemsAfterWikiDrag()
  })

  $(document).on('sortstart.wikiChessFreeze', '.page .story', (_event, ui) => {
    wikiChessSortActive = true
    cancelPendingChessDragArm()
    const $item = ui?.item
    if ($item?.length && $item.find('.wiki-plugin-chess, .wiki-chess-drag-freeze').length) {
      armChessItemForWikiDrag($item)
    }
    shieldChessIframesForWikiSort()
    syncWikiChessDragGhost()
  })

  $(document).on('sort.wikiChessFreeze', '.page .story', () => {
    syncWikiChessDragGhost()
  })

  $(document).on('sortstop.wikiChessFreeze', '.page .story', () => {
    wikiChessSortActive = false
    thawChessItemsAfterWikiDrag()
  })
}

const bind = async ($item, item) => {
  const itemLive = getItemLive($item, item)

  $item.on('dblclick', () => openChessItemEditor(itemLive))

  bindChessItemPaste($item, itemLive)
  announceWikiTabToChessOpener(itemLive)
}

const popupWindowFeatures = chessObj => popupWindowFeaturesString(windowMetricsForChessObj(chessObj, window.screen))

// Set true when the embedded chess iframe reports (via `pwa-installed`) that the
// chess PWA is installed on this device. Origin-wide, so a single flag is enough.
let pwaInstalled = false

// After a PWA-targeted open, the freshly created window is one of two things:
//   - a blank stub the browser left behind after routing the navigation into the
//     installed app window — close it so no duplicate tab lingers; or
//   - the chess app itself, if the browser did NOT capture the launch (e.g. the
//     user hasn't enabled "open in app") — keep it and treat it as the popup.
// The window is same-origin, so we can read its location to tell them apart.
// Capture timing varies by browser/version, so poll briefly before giving up.
const reclaimOrCleanupPwaLaunch = (ctx, win) => {
  pollWindowUntil(tries => {
    let closed = true
    try {
      closed = win.closed
    } catch {
      closed = true
    }
    if (closed) return true

    let pathname = null
    try {
      pathname = win.location?.pathname
    } catch {
      pathname = null
    }

    if (pathname === '/plugins/chess/index.html') {
      ctx.popup = win
      ctx.popupActive = true
      ctx.popupHandoff = true
      monitorPopupClosed(ctx)
      syncChessViews(ctx, win)
      sendPopupBootState(ctx, win)
      completePopupHandoff(ctx)
      return true
    }

    if (pathname === 'about:blank' || pathname === '' || pathname == null) {
      if (tries >= 8) {
        try {
          win.close()
        } catch {
          /* already gone */
        }
        return true
      }
      return false
    }

    return true
  })
}

// # Popup and PWA Launch

const launchPopup = (ctx, { replacing = false } = {}) => {
  if (replacing) {
    let win = ctx.popup
    try {
      if (win && !win.closed) {
        ctx.popupActive = true
        monitorPopupClosed(ctx)
        sendPopupBootState(ctx, win, { replaceInPlace: true })
        try {
          win.focus()
        } catch {
          /* ignore */
        }
        return
      }
    } catch {
      win = null
    }
  }

  const pageKey = getPageKey(ctx.$item) ?? 'page'
  const query = new URLSearchParams({
    itemId: ctx.item.id,
    pageKey,
  })
  // Cache-bust index.html the same way the embedded iframe does (see the &v= on the
  // iframe src). Without this the popup — and the installed PWA, which reuses this URL —
  // can load an HTTP-cached index.html that still points at an old chess-app.js bundle,
  // so freshly shipped fixes appear "missing" only in the popup/PWA.
  query.set('v', pluginBuildId)
  if (pwaInstalled) query.set('chessPwa', '1')
  if (ctx.chessObj.FEN) query.set('fen', ctx.chessObj.FEN)
  // Carry puzzle context in the URL so the popup's no-opener fallback — and, crucially,
  // the installed PWA, which reuses this URL with no opener to message — can restore
  // Puzzle Mode. The whole PUZZLE directive rides along verbatim (a bare keyword, a
  // "PUZZLE RANDOM [filters]" line, or "PUZZLE\n<Lichess row>") so the new window
  // resolves the same chooser-or-random behaviour the embedded item would.
  if (ctx.chessObj.gameType === 'puzzle' || ctx.chessObj.format === 'PUZZLE' || ctx.chessObj.mode === 'PUZZLE') {
    const cs = String(ctx.chessObj.chessState || ctx.item?.text || '').trim()
    query.set('puzzle', /^PUZZLE\b/i.test(cs) ? cs : 'PUZZLE')
  }

  const windowName = `chess-${safeDomId(ctx.key)}`

  // Sized window (width/height/left/top, no popup=yes). chess-app.js resizes after load.
  const url = `/plugins/chess/index.html?${query}`
  const win = window.open(url, windowName, popupWindowFeatures(ctx.chessObj))
  if (!win) {
    abortPopupLaunch(ctx)
    return
  }

  // Link the window immediately so shell-routed requests (survey crawls, etc.)
  // from the popup are not dropped while a PWA hand-off probe is still running.
  ctx.popup = win
  ctx.popupActive = true
  monitorPopupClosed(ctx)

  if (pwaInstalled) {
    reclaimOrCleanupPwaLaunch(ctx, win)
    return
  }

  syncChessViews(ctx, win)
}

// Export live state from the wiki embed, then open or replace the popup window.
const beginPopupLaunch = ctx => {
  // Survey/leaderboard pages are embed-only — never open or link a popup/PWA.
  if (isMaintenanceChessCtx(ctx)) return
  ctx.pendingPopup = true
  ctx.popupHandoff = true
  ctx.replacingPopup = Boolean(ctx.popup && !ctx.popup.closed)
  ctx.popupActive = true
  notifyEmbedFollowsPopup(ctx, true)
  const iframeWindow = ctx.iframe?.[0]?.contentWindow
  if (iframeWindow) {
    iframeWindow.postMessage({ action: MSG.GET_EXPORT }, window.origin)
    return
  }
  if (ctx.popup && !ctx.popup.closed) {
    ctx.popup.postMessage({ action: MSG.GET_EXPORT }, window.origin)
    return
  }
  launchPopup(ctx)
}

const doPopup = event => {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  const $root = $(event.target).closest('.wiki-plugin-chess')
  const ctxKey = $root.data('item-id')
  const ctx = items.get(ctxKey)
  if (!ctx) return
  beginPopupLaunch(ctx)
}

const createOpenInNewWindowButton = () =>
  $('<button>', {
    class: 'chess-open-new',
    type: 'button',
    text: 'Open in new window',
    title: 'Open this chess item in a new browser window',
  }).on('click', event => doPopup(event))

const updateOpenInNewWindowButton = ctx => {
  Object.assign(ctx.chessObj, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
  const $actions = ctx.$item.find('.wiki-chess-item-bar-actions')
  if (!$actions.length) return
  const $btn = $actions.find('.chess-open-new')
  // My Chess Games / Chess Leaderboards stay in the wiki embed — no popup/PWA link.
  if (isMaintenanceChessCtx(ctx)) {
    $btn.remove()
    return
  }
  if (!$btn.length) {
    $actions.prepend(createOpenInNewWindowButton())
  }
}

const updateChessItemControls = ctx => {
  updateOpenInNewWindowButton(ctx)
}

function isChessAppSource(source) {
  try {
    return source?.location?.pathname === '/plugins/chess/index.html'
  } catch {
    return false
  }
}

// # Remote Opponent Watch
//
// The iframe app asks us (the wiki shell) to watch the opponent's wiki for their
// next move, because only the shell can fetch cross-origin via `wiki.site`. We
// poll the opponent's copy of this same page (same slug + item id, preserved by
// forking) and forward the opponent item's text whenever it changes. The app
// validates legality and decides whether to fork the move in.
const REMOTE_POLL_INTERVAL_MS = 12000
// During a WebRTC handshake we poll faster so the offer/answer SDP (which travels
// through the wiki page) is exchanged in seconds rather than on the slow interval.
const REMOTE_POLL_FAST_MS = 2000

const stopRemoteWatch = ctx => {
  if (!ctx) return
  if (ctx.remotePoll) clearInterval(ctx.remotePoll)
  ctx.remotePoll = null
  ctx.remoteWatchSite = null
  ctx.lastRemoteText = null
  ctx.lastRemoteRealtime = null
  ctx.lastRemoteSignal = null
  ctx.lastRemotePage = null
}

const sendRemoteOpponentState = (ctx, text, realtime, signal) => {
  const msg = { action: MSG.REMOTE_OPPONENT_STATE, text, realtime, signal }
  try {
    if (ctx.iframe?.[0]?.contentWindow) {
      ctx.iframe[0].contentWindow.postMessage(msg, window.origin)
    }
    if (ctx.popup && !ctx.popup.closed) {
      ctx.popup.postMessage(msg, window.origin)
    }
  } catch (error) {
    console.error('Error sending remote opponent state:', error)
  }
}

const pollRemoteOpponent = ctx => {
  const host = ctx?.remoteWatchSite
  if (!host || typeof wiki?.site !== 'function') return
  const slug = getPageSlug(ctx.$item) ?? ctx.chessObj?.wikiPageName
  const itemId = ctx.item?.id
  if (!slug || !itemId) return
  try {
    wiki.site(host).get(`${slug}.json`, (err, page) => {
      if (err || !page) return
      const story = Array.isArray(page.story) ? page.story : []
      const remoteItem = story.find(entry => entry?.id === itemId)
      const text = remoteItem?.text
      if (!text) return
      // Keep the full page so Fork Move / autofork can wiki-fork it (journal + story).
      ctx.lastRemotePage = page
      // The opponent's real-time readiness + WebRTC handshake blobs ride on their
      // item (alongside the PGN). Forward all three; dedupe on the combination so a
      // signal-only change (no move) still reaches the app during a handshake.
      const realtime = remoteItem?.realtime ? normalizeRealtimeState(remoteItem.realtime) : undefined
      const signal = remoteItem?.realtimeSignal ? normalizeRealtimeSignalMap(remoteItem.realtimeSignal) : {}
      const realtimeKey = realtime ? JSON.stringify(realtime) : ''
      const signalKey = signal ? JSON.stringify(signal) : ''
      if (text === ctx.lastRemoteText && realtimeKey === ctx.lastRemoteRealtime && signalKey === ctx.lastRemoteSignal) {
        return
      }
      ctx.lastRemoteText = text
      ctx.lastRemoteRealtime = realtimeKey
      ctx.lastRemoteSignal = signalKey
      sendRemoteOpponentState(ctx, text, realtime, signal)
    })
  } catch (error) {
    if (wiki.debug) console.log('pollRemoteOpponent error', error)
  }
}

// Wiki-style page fork from the opponent: replace this page with their copy, then
// stamp `{ type: 'fork', site }`. Matches the lineup "fork" button — journals
// converge with both sites' flags — unlike a surgical edit+forkSite stamp.
const forkRemoteOpponentPage = (ctx, { host, expectText = null } = {}, done) => {
  const remoteSite = String(host || ctx?.remoteWatchSite || '').trim()
  const $page = ctx?.$item?.parents?.('.page:first')
  const slug = getPageSlug(ctx?.$item) ?? ctx?.chessObj?.wikiPageName
  if (!ctx || !remoteSite || !$page?.length || !slug) {
    done?.(new Error('cannot fork remote page'))
    return
  }
  if (normalizeWikiSite(remoteSite) === normalizeWikiSite(location.host)) {
    done?.(new Error('refusing self-fork'))
    return
  }
  if (ctx.remoteForkInFlight) {
    done?.(new Error('fork already in flight'))
    return
  }
  ctx.remoteForkInFlight = true

  const applyFork = remotePage => {
    if (!remotePage || typeof remotePage !== 'object') {
      ctx.remoteForkInFlight = false
      done?.(new Error('missing remote page'))
      return
    }
    const pageObject = typeof wiki?.lineup?.atKey === 'function' ? wiki.lineup.atKey($page.data('key')) : null
    const raw = pageObject?.getRawPage?.() || $page.data('data')
    if (!raw) {
      ctx.remoteForkInFlight = false
      done?.(new Error('missing local page'))
      return
    }
    const backup = JSON.parse(JSON.stringify(raw))
    const action = { type: 'fork', site: remoteSite, date: Date.now() }
    // Snapshot remote content for the server bundle; commit into `raw` only after put succeeds
    // so a failed put cannot leave the lineup half-adopted.
    const forkPage = {
      title: remotePage.title || raw.title,
      story: JSON.parse(JSON.stringify(remotePage.story || [])),
      journal: JSON.parse(JSON.stringify(remotePage.journal || [])),
    }

    const revertLocal = () => {
      raw.title = backup.title
      raw.story = backup.story
      raw.journal = backup.journal
      $page.data('data', raw)
    }

    const commitLocalAfterPut = () => {
      raw.title = forkPage.title
      raw.story = JSON.parse(JSON.stringify(forkPage.story))
      raw.journal = JSON.parse(JSON.stringify(forkPage.journal))
      $page.data('data', raw)
      // Same as wiki-client pageHandler: append the fork action to the in-memory page.
      if (typeof pageObject?.apply === 'function') {
        pageObject.apply(action)
      } else {
        adoptRemoteWikiPage(raw, remotePage, remoteSite, action.date)
        $page.data('data', raw)
      }
      try {
        wiki.neighborhoodObject?.updateSitemap?.(pageObject)
        wiki.neighborhoodObject?.updateIndex?.(pageObject)
        wiki.local?.delete?.($page.attr('id'))
      } catch {
        // Neighborhood / local-cache helpers are best-effort outside the wiki shell.
      }
      // Replace the journal strip so both sites' flags match the forked history.
      rebuildJournalActions($page, raw.journal)
      $page.data('site', null)
      $page.removeClass('remote')
      $page.find('h1').prop('title', location.host)
      const itemId = ctx.item?.id
      const nextItem = (raw.story || []).find(entry => entry?.id === itemId)
      const preservedSettings = ctx.chessObj?.gameSettings
      if (nextItem) {
        Object.assign(ctx.item, nextItem)
        mergeItemTextIntoChessObj(ctx.chessObj, nextItem.text)
        if (nextItem.challenge !== undefined) ctx.chessObj.challenge = nextItem.challenge
        // Remote items usually have gameSettings: null — do not wipe local auto-fork prefs.
        ctx.chessObj.gameSettings = coalesceAdoptedGameSettings(nextItem.gameSettings, preservedSettings)
      }
      // patchStateOnly: update the board/PGN without a full iframe re-init (keeps settings UI stable).
      sendMessage(ctx, MSG.SET_STATE, { patchStateOnly: true })
      done?.()
    }

    const afterPut = err => {
      ctx.remoteForkInFlight = false
      if (err) {
        revertLocal()
        done?.(err)
        return
      }
      commitLocalAfterPut()
    }

    // Prefer origin.put: real completion callback (pageHandler.put is fire-and-forget).
    if (typeof wiki?.origin?.put === 'function') {
      wiki.origin.put(slug, { ...action, forkPage }, afterPut)
      return
    }
    // Legacy: preload then pageHandler.put; poll until apply appends the fork.
    raw.title = forkPage.title
    raw.story = JSON.parse(JSON.stringify(forkPage.story))
    raw.journal = JSON.parse(JSON.stringify(forkPage.journal))
    $page.data('data', raw)
    if (typeof wiki?.pageHandler?.put === 'function') {
      const expectLen = (raw.journal?.length || 0) + 1
      if (pageHandlerPutSupportsDone) {
        wiki.pageHandler.put($page, action, afterPut)
      } else {
        wiki.pageHandler.put($page, action)
        const started = Date.now()
        const poll = () => {
          if ((raw.journal?.length || 0) >= expectLen) {
            afterPut(null)
            return
          }
          if (Date.now() - started > 8000) {
            afterPut(new Error('fork put timed out'))
            return
          }
          window.setTimeout(poll, 50)
        }
        window.setTimeout(poll, 50)
      }
      return
    }
    afterPut(new Error('wiki put unavailable'))
  }

  // Always GET fresh. When expectText is set (autofork / RTC), retry until the opponent's
  // wiki has that movetext — otherwise a premature fork reverts the board to a stale page.
  const maxAttempts = expectText ? 20 : 1
  const fetchRemote = (attempt = 0) => {
    try {
      wiki.site(remoteSite).get(`${slug}.json`, (err, page) => {
        if (err || !page) {
          if (attempt + 1 < maxAttempts) {
            window.setTimeout(() => fetchRemote(attempt + 1), 100 + attempt * 50)
            return
          }
          ctx.remoteForkInFlight = false
          done?.(err || new Error('remote page missing'))
          return
        }
        ctx.lastRemotePage = page
        if (expectText && !remotePageMatchesExpect(page, ctx.item?.id, expectText) && attempt + 1 < maxAttempts) {
          window.setTimeout(() => fetchRemote(attempt + 1), 100 + attempt * 50)
          return
        }
        if (expectText && !remotePageMatchesExpect(page, ctx.item?.id, expectText)) {
          ctx.remoteForkInFlight = false
          done?.(new Error('remote wiki not caught up'))
          return
        }
        applyFork(page)
      })
    } catch (error) {
      ctx.remoteForkInFlight = false
      done?.(error)
    }
  }
  fetchRemote(0)
}

const scheduleRemotePoll = ctx => {
  if (ctx.remotePoll) clearInterval(ctx.remotePoll)
  const interval = ctx.remotePollFast ? REMOTE_POLL_FAST_MS : REMOTE_POLL_INTERVAL_MS
  ctx.remotePoll = setInterval(() => {
    // Pause while the tab is hidden to avoid pointless cross-wiki fetches.
    if (typeof document !== 'undefined' && document.hidden) return
    pollRemoteOpponent(ctx)
  }, interval)
}

const startRemoteWatch = (ctx, host) => {
  if (!ctx) return
  if (ctx.remoteWatchSite === host && ctx.remotePoll) return
  stopRemoteWatch(ctx)
  if (!host) return
  ctx.remoteWatchSite = host
  pollRemoteOpponent(ctx) // check right away, then on an interval
  scheduleRemotePoll(ctx)
}

// Speed up (or restore) the opponent poll while a WebRTC handshake is in flight.
const setRemotePollSpeed = (ctx, fast) => {
  if (!ctx) return
  const next = Boolean(fast)
  if (ctx.remotePollFast === next) return
  ctx.remotePollFast = next
  if (ctx.remotePoll) scheduleRemotePoll(ctx)
}

// # Federated Rating Discovery
//
// The iframe app can't reach other wikis, so it asks us (the shell) to resolve both
// seats' current Glicko-2 ratings. There is no rating server: a player's state is
// stamped into the PGN of every rated game they play, so we DISCOVER it by crawling
// each seat's wiki for their most recent rated game (chess-discovery picks the
// freshest and verifies it against the twin on the opponent's site). Pure rating math
// + verification live in src/federation.js; the shell only does the cross-wiki fetching.

const wikiSiteAdapter = () => createBrowserWikiSiteClient(wiki)

// Resolve both seats' ratings for the app's `discover-ratings` request and reply with
// a single `rating-state`. Each seat is resolved from games crawled off ITS OWN wiki,
// and verified against the games crawled off the OTHER seat's wiki (where the shared
// twin lives). Engine / open / same-wiki seats are skipped (null state).
const discoverRatings = async (ctx, data, fetchGen) => {
  const slug = getPageSlug(ctx.$item) ?? ctx.chessObj?.wikiPageName
  const whiteSite = String(data?.white?.site ?? data?.white?.host ?? '')
    .trim()
    .toLowerCase()
  const blackSite = String(data?.black?.site ?? data?.black?.host ?? '')
    .trim()
    .toLowerCase()
  if (!whiteSite && !blackSite) return
  if (typeof wiki?.site !== 'function') return

  const isAborted = () => fetchGen !== ctx.leaderboardFetchGen
  const site = wikiSiteAdapter()

  try {
    const [whiteResult, blackResult] = await Promise.all([
      whiteSite ? fetchSitesAsync(site, [whiteSite], slug) : { games: [] },
      blackSite ? fetchSitesAsync(site, [blackSite], slug) : { games: [] },
    ])
    if (isAborted()) return

    const whiteGames = whiteResult.games
    const blackGames = blackResult.games
    const white = whiteSite
      ? resolveSeatRating({ siteGames: whiteGames, twinGames: blackGames, site: whiteSite })
      : { state: null, verified: false }
    const black = blackSite
      ? resolveSeatRating({ siteGames: blackGames, twinGames: whiteGames, site: blackSite })
      : { state: null, verified: false }
    const msg = {
      action: MSG.RATING_STATE,
      white: white.state,
      black: black.state,
      verified: { white: white.verified, black: black.verified },
    }
    try {
      if (ctx.iframe?.[0]?.contentWindow) ctx.iframe[0].contentWindow.postMessage(msg, window.origin)
      if (ctx.popup && !ctx.popup.closed) ctx.popup.postMessage(msg, window.origin)
    } catch (error) {
      if (wiki.debug) console.log('discoverRatings reply error', error)
    }
  } catch (error) {
    if (wiki.debug) console.log('discoverRatings crawl error', error)
  }
}

// # Federated Leaderboard and Neighborhood Fetch
//
// "Who are the highest-rated players?" There is no rating server, so a leaderboard is
// just rating discovery run across many wikis and sorted. The shell does the cross-
// origin crawling (only it can reach `wiki.site`); the pure aggregation lives in
// src/federation.js. Two reach modes:
//
//   - mine ("my games only"): the viewer's own games plus the direct opponents named in
//     them (a single hop, so each game's cross-wiki twin is in the pool to verify it).
//   - survey ("visible federation"): discovery follows the OPPONENTS named in the games —
//     the games imply the roster (not a `roster` item) — walking the twin-connected
//     population transitively out from the viewer's own site, bounded by hop-trust dials
//     (max hops × decay floor). A site is LISTED on the board only if it opted in by
//     publishing the survey page (its sitemap carries SURVEY_PAGE_SLUG); hosts are still
//     crawled for games (twins / priors) when kept by hop trust, but non-opted-in players
//     aren't shown. Neighbourhood reach is a separate curated wiki.neighborhood roster.

// Cap the crawl fan-out so a large neighbourhood / survey can't fire hundreds of
// fetches. Hosts beyond this are simply not crawled this round (see federation.js).

// The hosts in the viewer's federated neighbourhood (the sites whose sitemaps the
// client has cached). Empty/defensive when the global isn't available.
const neighborhoodSites = () => {
  try {
    const sites = (typeof wiki !== 'undefined' && wiki.neighborhood) || {}
    return Object.keys(sites)
  } catch {
    return []
  }
}

// Federation crawl seeds for open challenges: local + opponents + neighbourhood +
// cached federation sites only — never wait on the global index (refreshed in background).
const resolveSurveyFetchSeeds = (localSite, _ctx, done, seedOpts = {}) => {
  const neighborhood = neighborhoodSites()
  const opts = {
    neighborhoodSites: neighborhood,
    knownOpponents: Array.isArray(seedOpts.knownOpponents) ? seedOpts.knownOpponents : undefined,
    knownFederationSites: seedOpts.knownFederationSites,
    deferIndex: seedOpts.deferIndex !== false,
  }
  if (typeof wiki?.site !== 'function') {
    done(
      buildFetchTargets({
        localSite,
        neighborhoodSites: neighborhood,
        knownOpponents: opts.knownOpponents || [],
        indexSites: normalizeFederationSitesHosts(seedOpts.knownFederationSites),
      }),
    )
    return
  }
  resolveFetchSeeds(wikiSiteAdapter(), localSite, opts)
    .then(seeds => done(seeds))
    .catch(() =>
      done(
        buildFetchTargets({
          localSite,
          neighborhoodSites: neighborhood,
          knownOpponents: opts.knownOpponents || [],
          indexSites: normalizeFederationSitesHosts(seedOpts.knownFederationSites),
        }),
      ),
    )
}

function normalizeFederationSitesHosts(raw) {
  if (Array.isArray(raw?.hosts)) return raw.hosts
  if (Array.isArray(raw)) return raw
  return []
}

// Soft-refresh the global chess-plugin index off the UI path; probe only brand-new hosts.
const backgroundFederationIndexFollowUp = async ({
  site,
  slug,
  seedHosts,
  blockList,
  knownFederationSites,
  onNewChallenges,
  onCacheUpdate,
}) => {
  try {
    const refreshed = await refreshFederationSitesFromIndex(knownFederationSites)
    onCacheUpdate?.(refreshed.hosts)
    const already = new Set(dedupeSites(seedHosts || []).map(h => cleanSite(h)))
    const extra = refreshed.newHosts.filter(h => h && !already.has(cleanSite(h)))
    if (!extra.length || typeof onNewChallenges !== 'function') return
    const result = await fetchChallengesAsync(site, extra, slug, { blockList })
    if (result.challenges?.length || result.responsiveHosts?.length) {
      onNewChallenges(result)
    }
  } catch (error) {
    if (wiki.debug) console.log('backgroundFederationIndexFollowUp error', error)
  }
}

// Report whether this site has a published rated game, so the app can show leaderboard
// listing status. Invokes `done({ hasRatedGame })` exactly once.
const checkLeaderboardReadiness = (localSite, slug, done) => {
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (!host || typeof wiki?.site !== 'function') return done({ hasRatedGame: false })
  const site = wikiSiteAdapter()
  fetchSiteContentAsync(site, host, slug)
    .then(({ games }) => done({ hasRatedGame: siteHasRatedGames(games, host) }))
    .catch(() => done({ hasRatedGame: false }))
}

const viewerIsAuthenticatedOwner = () =>
  typeof isAuthenticated !== 'undefined' &&
  Boolean(isAuthenticated) &&
  typeof isOwner !== 'undefined' &&
  Boolean(isOwner)

const resolveJoinerNameForGhost = (hint, localSite, { guestName } = {}) => {
  const isAuthenticatedOwner = viewerIsAuthenticatedOwner()
  const placeholder = name => !String(name || '').trim() || /^(open|you)$/i.test(String(name).trim())
  let name = String(hint || '').trim()
  if (!isAuthenticatedOwner) {
    if (placeholder(name) || /^guest$/i.test(name)) return guestSeatName(guestName || name)
    return name
  }
  if (placeholder(name) || /^guest$/i.test(name)) {
    name = resolveSignedInUsername(typeof ownerName !== 'undefined' ? ownerName : '') || ''
  }
  if ((placeholder(name) || /^guest$/i.test(name)) && localSite) {
    const fromSeat = playerDisplayLabel(formatPlayerId('player', localSite))
    if (fromSeat && !placeholder(fromSeat) && !/^guest$/i.test(fromSeat)) name = fromSeat
  }
  if (placeholder(name) || /^guest$/i.test(name)) return 'You'
  return name
}

const buildChallengeJoinGhostStory = (item, challenge, creatorSite) => {
  const creatorLabel = playerDisplayLabel(challenge?.creator?.id || '') || creatorSite
  const joinerLabel = playerDisplayLabel(challenge?.opponent?.id || '')
  const chessItem = {
    type: 'chess',
    id: item.id,
    text: item.text,
  }
  if (item.gameSettings) chessItem.gameSettings = item.gameSettings
  if (challenge) chessItem.challenge = challenge
  if (item.challengeJoinPendingJournal) chessItem.challengeJoinPendingJournal = true
  if (item.challengeJoinGhostPgn) chessItem.challengeJoinGhostPgn = item.challengeJoinGhostPgn
  return [
    {
      type: 'paragraph',
      id: newItemId(),
      text: openChallengeAcceptParagraph(joinerLabel, creatorLabel),
    },
    chessItem,
  ]
}

const openGamePageLink = (slug, anchor, host) => {
  if (!slug || typeof wiki?.doInternalLink !== 'function') return
  try {
    wiki.doInternalLink(slug, anchor, host || null)
  } catch (error) {
    if (wiki.debug) console.log('open game page error', error)
  }
}

const resolveJoinerDisplayName = ctx => {
  const canClaim = Boolean(ctx?.chessObj?.viewerCanClaimWikiSeat) || viewerIsAuthenticatedOwner()
  if (canClaim) {
    const fromOwner =
      resolveSignedInUsername(ctx?.chessObj?.signedInDisplayName) ||
      resolveSignedInUsername(typeof ownerName !== 'undefined' ? ownerName : '')
    if (fromOwner) return fromOwner
    const seatId = ctx?.chessObj?.viewerSeatId
    if (seatId) {
      const fromSeat = playerDisplayLabel(seatId)
      if (fromSeat && fromSeat.toLowerCase() !== 'open seat') return fromSeat
    }
  }
  return GUEST_PLAYER_NAME
}

const showChallengeJoinGhost = ({ host, itemId, anchor, challenge, pgn, joinerDisplayName, entryTitle = '' }) => {
  if (typeof wiki?.newPage !== 'function' || typeof wiki?.showResult !== 'function') {
    return
  }
  const challengeState = normalizeChallengeState(challenge)
  const ghostPgn = String(pgn || '').trim()
  if (!challengeState || !isOpenChallenge(challengeState) || !ghostPgn) return
  const id = String(itemId || '').trim() || newItemId()
  const localSite = String(location.host || '')
    .trim()
    .toLowerCase()
  const isAuthenticatedOwner = viewerIsAuthenticatedOwner()
  const joinerName = resolveJoinerNameForGhost(joinerDisplayName, localSite)
  const joinerId = isAuthenticatedOwner ? formatPlayerId(joinerName, localSite) : guestSeatName(joinerName)
  const seatedPgn = buildChallengeJoinGhostPgn(ghostPgn, challengeState, joinerId)
  const acceptedChallenge = acceptOpenChallenge(challengeState, { joinerId, joinerSite: localSite }) || challengeState
  const item = {
    type: 'chess',
    id,
    text: seatedPgn,
    challenge: acceptedChallenge,
    challengeJoinPendingJournal: true,
    challengeJoinGhostPgn: ghostPgn,
  }
  const remoteTitle = openChallengeDisplayTitle({
    challenge: challengeState,
    title: String(entryTitle || '').trim(),
  })
  const baseTitle = proposeOpenChallengePageTitle(challengeState, joinerName, remoteTitle, {
    joinerId,
  })

  const presentGhost = ghostTitle => {
    const story = buildChallengeJoinGhostStory(item, acceptedChallenge, host)
    const previewTs = Number.isFinite(acceptedChallenge?.ts) ? acceptedChallenge.ts : Date.now()
    const ghost = wiki.newPage({
      title: ghostTitle,
      story,
      journal: [{ type: 'create', item: { title: ghostTitle, story }, date: previewTs }],
    })
    try {
      wiki.showResult(ghost, anchor ? { $page: anchor } : {})
      const $ghost = typeof $ !== 'undefined' ? $('.page').last() : null
      if ($ghost?.length) {
        $ghost.data('site', host)
        window.setTimeout(() => resyncChessItemsOnPage($ghost), 0)
      }
    } catch (error) {
      if (wiki.debug) console.log('open challenge ghost error', error)
    }
  }

  const slugsFromSitemap = res => {
    const sitemap = asSitemapArray(res)
    return sitemap?.length ? sitemap.map(e => e?.slug).filter(Boolean) : []
  }

  if (typeof wiki?.site === 'function' && localSite) {
    try {
      wiki.site(localSite).get('system/sitemap.json', (err, res) => {
        const slugs = !err ? slugsFromSitemap(res) : []
        presentGhost(proposeUniquePageTitle(baseTitle, slugs))
      })
      return
    } catch {
      /* fall through */
    }
  }
  presentGhost(proposeUniquePageTitle(baseTitle, []))
}

const notifyCreatePreview = (ctx, payload) => {
  const msg = { action: MSG.CHESS_ITEM_GHOST_SHOWN, itemId: ctx.item.id, ...payload }
  try {
    if (ctx.iframe?.[0]?.contentWindow) ctx.iframe[0].contentWindow.postMessage(msg, window.origin)
    if (ctx.popup && !ctx.popup.closed) ctx.popup.postMessage(msg, window.origin)
  } catch (error) {
    if (wiki.debug) console.log('chess item ghost notify error', error)
  }
}

const showCreatePreview = ({ kind, puzzleText, anchor, ctx, purpose } = {}) => {
  const meta = buildCreatePreviewMeta(kind, { puzzleText })
  if (!meta) {
    notifyCreatePreview(ctx, { success: false, kind })
    return
  }
  const openChallengeSetupPending = purpose === 'open-challenge-setup'
  presentMetaGhostPage({
    meta,
    anchor,
    ctx,
    openChallengeSetupPending,
    onSuccess: payload => notifyCreatePreview(ctx, { success: true, kind, ...(payload || {}) }),
    onFailure: () => notifyCreatePreview(ctx, { success: false, kind }),
  })
}

const handleCreatePreview = (ctx, event) => {
  const kind = String(event.data?.kind || '').trim()
  const puzzleText = String(event.data?.puzzleText || '').trim()
  const purpose = String(event.data?.purpose || '').trim()
  const $page = ctx.$item?.parents?.('.page')?.first?.()
  const anchor = $page && $page.length ? $page : null
  showCreatePreview({ kind, puzzleText, anchor, ctx, purpose })
}

const showPasteGhost = ({ payload, anchor, ctx }) => {
  const meta = Paste.buildGhostMeta(payload)
  presentMetaGhostPage({ meta, anchor, ctx })
}

const presentMetaGhostPage = ({ meta, anchor, ctx, openChallengeSetupPending = false, onSuccess, onFailure } = {}) => {
  if (!meta) {
    onFailure?.()
    if (wiki.debug) console.log('chess ghost error', 'missing meta')
    return
  }
  if (typeof wiki?.newPage !== 'function' || typeof wiki?.showResult !== 'function') {
    onFailure?.()
    if (wiki.debug) console.log('chess ghost error', 'wiki.newPage/showResult unavailable')
    return
  }

  const itemId = newItemId()
  const story = buildCreatePreviewStory(meta, { itemId, openChallengeSetupPending })
  const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
    .trim()
    .toLowerCase()

  const presentGhost = ghostTitle => {
    const previewTs = Date.now()
    const ghost = wiki.newPage({
      title: ghostTitle,
      story,
      journal: [{ type: 'create', item: { title: ghostTitle, story }, date: previewTs }],
    })
    try {
      wiki.showResult(ghost, anchor ? { $page: anchor } : {})
      const $ghost = typeof $ !== 'undefined' ? $('.page').last() : null
      if ($ghost?.length) {
        window.setTimeout(() => {
          resyncChessItemsOnPage($ghost)
          $ghost[0]?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        }, 0)
      }
      onSuccess?.({
        ghostPageKey: $ghost?.length ? $ghost.data('key') : null,
      })
    } catch (error) {
      onFailure?.()
      if (wiki.debug) console.log('chess ghost error', error)
    }
  }

  const slugsFromSitemap = res => {
    const sitemap = asSitemapArray(res)
    return sitemap?.length ? sitemap.map(e => e?.slug).filter(Boolean) : []
  }

  if (typeof wiki?.site === 'function' && localSite) {
    try {
      const lineupSlugs = collectLineupPageSlugs(localSite)
      wiki.site(localSite).get('system/sitemap.json', (err, res) => {
        const slugs = !err ? slugsFromSitemap(res) : []
        presentGhost(proposeUniquePageTitle(meta.title, [...slugs, ...lineupSlugs]))
      })
      return
    } catch {
      /* fall through */
    }
  }
  presentGhost(proposeUniquePageTitle(meta.title, collectLineupPageSlugs(localSite)))
}

const putChessPageCharmPatch = (slug, patch, done) => {
  const normalizedSlug = String(slug || '').trim()
  if (!normalizedSlug || !patch || !Object.keys(patch).length) {
    done?.(new Error('missing slug or patch'))
    return
  }
  fetch('/plugin/chess/revise-page-charm', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: normalizedSlug, patch }),
  })
    .then(res => {
      if (res.ok) return done?.()
      return res.text().then(text => done?.(new Error(text || `HTTP ${res.status}`)))
    })
    .catch(err => done?.(err))
}

// Upsert one game into My Chess Games page.chess.gameIndex (metadata only).
const publishSurveyGameIndexUpsert = ({ slug, itemId, title, pgn } = {}, done) => {
  const localSite = String(location.host || '')
    .trim()
    .toLowerCase()
  const pageSlug = String(slug || '').trim()
  const id = String(itemId || '').trim()
  if (!localSite || !pageSlug || !id || typeof pgn !== 'string' || !pgn.trim()) {
    done?.(null)
    return
  }
  if (pageSlug === SURVEY_PAGE_SLUG || pageSlug === LEADERBOARD_PAGE_SLUG) {
    done?.(null)
    return
  }
  if (isSurveyItemText(pgn) || isLeaderboardItemText(pgn) || isMaintenanceChessItemText(pgn)) {
    done?.(null)
    return
  }
  const built = buildGameIndexEntryFromPgn({
    host: localSite,
    slug: pageSlug,
    itemId: id,
    title,
    pgn,
  })
  if (!built) {
    done?.(null)
    return
  }
  if (typeof wiki?.site !== 'function') {
    done?.(new Error('survey get unavailable'))
    return
  }
  wiki.site(localSite).get(`${SURVEY_PAGE_SLUG}.json`, (err, existing) => {
    try {
      const { page, isNew } = ensureSurveyPageObject(!err && existing ? existing : null)
      const next = upsertGameIndexEntry(readGameIndex(page), built.entry, built.bucket)
      applyGameIndexToSurveyPage(page, next)
      const persistCharm = putErr => {
        if (putErr) {
          done?.(putErr)
          return
        }
        putChessPageCharmPatch(SURVEY_PAGE_SLUG, { gameIndex: readGameIndex(page) }, done)
      }
      if (isNew) {
        if (typeof wiki?.origin?.put !== 'function') {
          done?.(new Error('survey put unavailable'))
          return
        }
        wiki.origin.put(
          SURVEY_PAGE_SLUG,
          {
            type: 'create',
            item: { title: page.title || SURVEY_PAGE_TITLE, story: page.story },
            date: Date.now(),
          },
          persistCharm,
        )
        return
      }
      persistCharm(null)
    } catch (error) {
      done?.(error)
    }
  })
}

const probeLeaderboardPageSlug = (localSite, done) => {
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (!host || typeof wiki?.site !== 'function') {
    done(LEADERBOARD_PAGE_SLUG)
    return
  }
  wiki.site(host).get(`${LEADERBOARD_PAGE_SLUG}.json`, (err, page) => {
    const pagesBySlug = !err && page && Array.isArray(page.story) ? { [LEADERBOARD_PAGE_SLUG]: page } : {}
    done(pickLeaderboardPageSlug(pagesBySlug))
  })
}

const openLeaderboardPageLink = (anchor, _localSite) => {
  if (typeof wiki?.doInternalLink !== 'function') return
  try {
    wiki.doInternalLink(LEADERBOARD_PAGE_SLUG, anchor)
  } catch (error) {
    if (wiki.debug) console.log('open leaderboard page link error', error)
  }
}

const cloneWikiPage = page => {
  try {
    return structuredClone(page)
  } catch {
    return JSON.parse(JSON.stringify(page))
  }
}

const ensureSurveyPageObject = existing => {
  if (existing && Array.isArray(existing.story)) {
    const page = cloneWikiPage(existing)
    page.title = page.title || SURVEY_PAGE_TITLE
    page.story ||= []
    page.journal ||= []
    return { page, isNew: false }
  }
  const story = SURVEY_PAGE_STORY.map(entry => ({ ...entry }))
  const page = { title: SURVEY_PAGE_TITLE, story: [], journal: [] }
  applyPageAction(page, {
    type: 'create',
    item: { title: SURVEY_PAGE_TITLE, story },
    date: Date.now(),
  })
  return { page, isNew: true }
}

// Persist a pending open challenge on My Chess Games (`openChallenges` metadata).
// No game page is created until an opponent accepts — titles need both seats filled.
const publishOpenChallengeSurveyDelta = ({ add = null, removeIds = [] } = {}, done) => {
  const localSite = String(location.host || '')
    .trim()
    .toLowerCase()
  if (!localSite || typeof wiki?.site !== 'function' || typeof wiki?.origin?.put !== 'function') {
    done?.(new Error('survey put unavailable'))
    return
  }

  const finishPut = (page, isNew) => {
    if (isNew && !add) {
      done?.(null)
      return
    }
    const result = syncOpenChallengeSurveyOnPage(page, { add, removeIds, host: localSite })
    if (result.error === 'no-survey-item') {
      done?.(new Error('no-survey-item'))
      return
    }
    if (!result.changed && !isNew) {
      done?.(null)
      return
    }
    const persistCharm = err => {
      if (err) {
        done?.(err)
        return
      }
      const index = readGameIndex(page)
      if (!(index.active.length || index.completed.length || index.challenges.length)) {
        done?.(null)
        return
      }
      putChessPageCharmPatch(SURVEY_PAGE_SLUG, { gameIndex: index }, done)
    }
    if (isNew) {
      wiki.origin.put(
        SURVEY_PAGE_SLUG,
        {
          type: 'create',
          item: { title: page.title || SURVEY_PAGE_TITLE, story: page.story },
          date: Date.now(),
        },
        persistCharm,
      )
      return
    }
    const action = page.journal?.[page.journal.length - 1]
    if (!action || action.type !== 'edit') {
      // Journal unchanged but charm may have been updated (challenge refs).
      persistCharm(null)
      return
    }
    wiki.origin.put(SURVEY_PAGE_SLUG, { ...action, date: Date.now() }, persistCharm)
  }

  wiki.site(localSite).get(`${SURVEY_PAGE_SLUG}.json`, (err, existing) => {
    try {
      const { page, isNew } = ensureSurveyPageObject(!err && existing ? existing : null)
      finishPut(page, isNew)
    } catch (error) {
      done?.(error)
    }
  })
}

const autoJournalLeaderboardCheckpoint = (localSite, meta) => {
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (
    !host ||
    host !==
      String(location.host || '')
        .trim()
        .toLowerCase()
  )
    return
  if (!meta?.checkpoint || typeof wiki?.site !== 'function') return
  probeLeaderboardPageSlug(host, slug => {
    wiki.site(host).get(`${slug}.json`, (err, page) => {
      if (err || !page) return
      const published = readFederationCharm(page)
      const trustedPeers = deriveGossipTrustedPeers(meta.listed, {
        localSite: host,
        previous: published.trustedPeers,
      })
      if (
        !shouldPublishFederationGossip(published, {
          checkpoint: meta.checkpoint,
          trustedPeers,
        })
      ) {
        return
      }
      const patch = buildFederationGossipPatch({
        checkpoint: meta.checkpoint,
        trustedPeers,
      })
      if (!Object.keys(patch).length) return
      putChessPageCharmPatch(slug, patch)
    })
  })
}

const registerDirectedChallengeNeighbor = host => {
  const normalized = cleanSite(host)
  if (!normalized) return
  try {
    wiki?.neighborhoodObject?.registerNeighbor?.(normalized)
  } catch (error) {
    if (wiki.debug) console.log('registerDirectedChallengeNeighbor error', error)
  }
}

// Deliver a leaderboard/survey crawl result to every live chess-app surface for this item.
const postLeaderboardData = (ctx, msg, requestSource = null) => {
  const targets = new Set()
  try {
    if (ctx?.iframe?.[0]?.contentWindow) targets.add(ctx.iframe[0].contentWindow)
    if (ctx?.popup && !ctx.popup.closed) targets.add(ctx.popup)
    if (requestSource && isChessAppSource(requestSource)) targets.add(requestSource)
    for (const target of targets) {
      target.postMessage(msg, window.origin)
    }
  } catch (error) {
    if (wiki.debug) console.log('buildLeaderboardData reply error', error)
  }
}

const postSurveyOpenChallenges = (ctx, { openChallenges, meta, seq, partial } = {}, requestSource = null) => {
  postLeaderboardData(
    ctx,
    {
      action: MSG.SURVEY_OPEN_CHALLENGES_DATA,
      openChallenges: Array.isArray(openChallenges) ? openChallenges : [],
      meta: meta || null,
      seq,
      partial: partial === true,
    },
    requestSource,
  )
}

const postSurveySiteGames = (ctx, { games, seq } = {}, requestSource = null) => {
  postLeaderboardData(
    ctx,
    {
      action: MSG.SURVEY_SITE_GAMES_DATA,
      games: Array.isArray(games) ? games : [],
      seq,
    },
    requestSource,
  )
}

let deepAuditUnloadBound = false

const deepAuditUnloadHandler = event => {
  event.preventDefault()
  event.returnValue = ''
  return ''
}

const bindDeepAuditUnload = active => {
  if (typeof window === 'undefined') return
  if (active && !deepAuditUnloadBound) {
    window.addEventListener('beforeunload', deepAuditUnloadHandler)
    deepAuditUnloadBound = true
  } else if (!active && deepAuditUnloadBound) {
    window.removeEventListener('beforeunload', deepAuditUnloadHandler)
    deepAuditUnloadBound = false
  }
}

// Build and reply with a leaderboard for the app's `build-leaderboard` request.
// Progress stays in the chess iframe status line; tab-close warning for full audits is
// driven by FETCH_UI { loading, deep } from survey.js.
const buildLeaderboardData = (ctx, data, fetchGen, requestSource = null) => {
  const slug = getPageSlug(ctx.$item) ?? ctx.chessObj?.wikiPageName
  const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
    .trim()
    .toLowerCase()
  const mode =
    data?.mode === 'site'
      ? 'site'
      : data?.mode === 'survey'
        ? 'survey'
        : data?.mode === 'neighborhood'
          ? 'neighborhood'
          : 'mine'
  const survey = String(data?.survey || DEFAULT_SURVEY_ID)
    .trim()
    .toLowerCase()
  const deepRecompute = data?.deepRecompute === true
  const isAborted = () => fetchGen !== ctx.leaderboardFetchGen

  const reply = (entries, meta) => {
    if (fetchGen !== ctx.leaderboardFetchGen) return
    postLeaderboardData(ctx, { action: MSG.LEADERBOARD_DATA, entries, meta, seq: data?.seq }, requestSource)
    if (meta?.checkpoint) {
      autoJournalLeaderboardCheckpoint(localSite, meta)
    }
  }

  const reportProgress = patch => {
    if (fetchGen !== ctx.leaderboardFetchGen) return
    postLeaderboardData(
      ctx,
      { action: MSG.LEADERBOARD_PROGRESS, seq: data?.seq, mode, deepRecompute, ...patch },
      requestSource,
    )
  }

  if (typeof wiki?.site !== 'function') {
    reply([], { unavailable: true, mode, generatedAt: Date.now() })
    return
  }

  const site = wikiSiteAdapter()
  ;(async () => {
    try {
      if (isAborted()) return
      if (mode === 'site') {
        // Fast path only — deferred enrich + challenges arrive via
        // BUILD_SITE_SURVEY_ENRICH / BUILD_CHALLENGES (forSiteSurvey), same as PWA.
        const result = await runNeighborhoodJob('siteSurvey', {
          site,
          localSite,
          opts: {
            slug,
            neighborhoodSites: neighborhoodSites(),
            includeFederationChallenges: false,
          },
        })
        if (isAborted()) return
        reply(result.entries, result.meta)
        if (result.meta?.rebuiltGameIndex) {
          persistRebuiltSurveyGameIndex(localSite, result.meta.rebuiltGameIndex)
        }
        return
      }
      const extraNeighborhoodSites = Array.isArray(data?.extraNeighborhoodSites)
        ? data.extraNeighborhoodSites
        : Array.isArray(data?.extraNeighborhoodSites)
          ? data.extraNeighborhoodSites
          : []
      const hopGraph = data?.hopGraph && typeof data.hopGraph === 'object' ? data.hopGraph : null
      const result = await runNeighborhoodJob('leaderboard', {
        site,
        localSite,
        opts: {
          mode,
          survey,
          slug,
          neighborhoodSites: [...neighborhoodSites(), ...extraNeighborhoodSites.map(h => cleanSite(h)).filter(Boolean)],
          hopGraph,
          deepRecompute,
          localCheckpoint: data?.localCheckpoint || null,
          localPlayers: data?.localPlayers || null,
          blockList: data?.blockList,
          deletionMetrics: data?.deletionMetrics,
          island: data?.island,
          knownOpponents: data?.knownOpponents,
          knownFederationSites: data?.knownFederationSites,
          siteCrawlCache: data?.siteCrawlCache,
          shouldAbort: isAborted,
          onProgress: reportProgress,
        },
      })
      if (isAborted() || !result) {
        if (isAborted()) bindDeepAuditUnload(false)
        return
      }
      reply(result.entries, {
        ...result.meta,
        entries: result.entries,
      })
    } catch (error) {
      if (wiki.debug) console.log('buildLeaderboardData federation error', error)
      if (fetchGen !== ctx.leaderboardFetchGen) return
      reply([], { unavailable: true, mode, generatedAt: Date.now() })
    }
  })()
}

// Site-survey deferred open-challenges crawl (MSG BUILD_CHALLENGES — shared with PWA).
const buildSiteSurveyDeferredChallenges = (ctx, data, requestSource = null) => {
  const slug = getPageSlug(ctx.$item) ?? ctx.chessObj?.wikiPageName
  const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
    .trim()
    .toLowerCase()
  const localOpenChallenges = Array.isArray(data?.localOpenChallenges)
    ? data.localOpenChallenges
    : Array.isArray(data?.localOpenSeeks)
      ? data.localOpenSeeks
      : []
  if (typeof wiki?.site !== 'function') {
    postSurveyOpenChallenges(
      ctx,
      {
        openChallenges: localOpenChallenges,
        meta: { unavailable: true, site: localSite },
        seq: data?.seq,
        partial: false,
      },
      requestSource,
    )
    return
  }
  const site = wikiSiteAdapter()
  resolveSurveyFetchSeeds(
    localSite,
    ctx,
    seeds => {
      void (async () => {
        try {
          const result = await orchestrateSiteSurveyDeferredWork(site, localSite, {
            localOpenChallenges,
            seeds,
            slug,
            blockList: data?.blockList,
            knownOpponents: data?.knownOpponents,
            knownFederationSites: data?.knownFederationSites,
            enrichGames: false,
            fetchChallenges: true,
            onBatch: batch => {
              if (!batch || batch.done) return
              postSurveyOpenChallenges(
                ctx,
                {
                  openChallenges: mergeOpenChallengeEntries(localOpenChallenges, batch.challenges),
                  meta: {
                    site: localSite,
                    crawled: batch.crawled?.length,
                    acceptedGhosts: batch.acceptedGhosts,
                    responsiveHosts: batch.responsiveHosts,
                    partial: true,
                  },
                  seq: data?.seq,
                  partial: true,
                },
                requestSource,
              )
            },
          })
          postSurveyOpenChallenges(
            ctx,
            {
              openChallenges: result.openChallenges,
              meta: result.meta,
              seq: data?.seq,
              partial: false,
            },
            requestSource,
          )
          void backgroundFederationIndexFollowUp({
            site,
            slug,
            seedHosts: seeds,
            blockList: data?.blockList,
            knownFederationSites: data?.knownFederationSites,
            onCacheUpdate: hosts => {
              postSurveyOpenChallenges(
                ctx,
                {
                  openChallenges: result.openChallenges,
                  meta: {
                    ...(result.meta || {}),
                    site: localSite,
                    federationSitesCache: hosts,
                    background: true,
                  },
                  seq: data?.seq,
                  partial: false,
                },
                requestSource,
              )
            },
            onNewChallenges: extra => {
              postSurveyOpenChallenges(
                ctx,
                {
                  openChallenges: mergeOpenChallengeEntries(result.openChallenges, extra.challenges),
                  meta: {
                    site: localSite,
                    crawled: (result.meta?.crawled || 0) + (extra.crawled?.length || 0),
                    acceptedGhosts: [
                      ...(Array.isArray(result.meta?.acceptedGhosts) ? result.meta.acceptedGhosts : []),
                      ...(Array.isArray(extra.acceptedGhosts) ? extra.acceptedGhosts : []),
                    ],
                    responsiveHosts: dedupeSites([
                      ...(result.meta?.responsiveHosts || []),
                      ...(extra.responsiveHosts || []),
                    ]),
                    federationSitesCache: dedupeSites([
                      ...(result.meta?.responsiveHosts || []),
                      ...(extra.responsiveHosts || []),
                    ]),
                    background: true,
                  },
                  seq: data?.seq,
                  partial: false,
                },
                requestSource,
              )
            },
          })
        } catch (error) {
          if (wiki.debug) console.log('buildSiteSurveyDeferredChallenges error', error)
          postSurveyOpenChallenges(
            ctx,
            {
              openChallenges: localOpenChallenges,
              meta: { unavailable: true, site: localSite },
              seq: data?.seq,
              partial: false,
            },
            requestSource,
          )
        }
      })()
    },
    data,
  )
}

// Site-survey deferred game enrichment (MSG BUILD_SITE_SURVEY_ENRICH — shared with PWA).
const buildSiteSurveyDeferredEnrich = (ctx, data, requestSource = null) => {
  const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
    .trim()
    .toLowerCase()
  if (typeof wiki?.site !== 'function') {
    postSurveySiteGames(ctx, { games: [], seq: data?.seq }, requestSource)
    return
  }
  const site = wikiSiteAdapter()
  void (async () => {
    try {
      const fetchedGames = Array.isArray(data?.fetchedGames) ? data.fetchedGames : null
      const result = await orchestrateSiteSurveyDeferredWork(site, localSite, {
        fetchedGames,
        enrichGames: true,
        fetchChallenges: false,
      })
      postSurveySiteGames(ctx, { games: result.games, seq: data?.seq }, requestSource)
    } catch (error) {
      if (wiki.debug) console.log('buildSiteSurveyDeferredEnrich error', error)
      postSurveySiteGames(ctx, { games: [], seq: data?.seq }, requestSource)
    }
  })()
}

// # Shell App Message Handlers

const fetchLocalPuzzleReferencePages = slugs => {
  const wanted = [...new Set((Array.isArray(slugs) ? slugs : []).map(s => String(s || '').trim().toLowerCase()))]
    .filter(slug => /^[a-z0-9][a-z0-9-]*$/.test(slug))
    .slice(0, 20)
  if (!wanted.length) return Promise.resolve([])
  const site = typeof wiki?.site === 'function' ? wiki.site(window.location.host) : null
  const readOne = slug =>
    new Promise(resolve => {
      // Prefer yellow Local Changes (exportable page JSON) over origin.
      const tryLocal = done => {
        if (typeof wiki?.local?.get !== 'function') {
          done(null)
          return
        }
        wiki.local.get(`${slug}.json`, (err, page) => {
          done(err || !page ? null : page)
        })
      }
      const tryOrigin = pageFromLocal => {
        if (pageFromLocal) {
          resolve({
            slug,
            title: String(pageFromLocal.title || slug),
            story: (Array.isArray(pageFromLocal.story) ? pageFromLocal.story : [])
              .filter(item => item?.type === 'chess')
              .map(item => ({ type: 'chess', id: item.id, text: String(item.text || '') })),
          })
          return
        }
        if (!site?.get) {
          resolve(null)
          return
        }
        site.get(`${slug}.json`, (err, page) => {
          if (err || !page) {
            resolve(null)
            return
          }
          resolve({
            slug,
            title: String(page.title || slug),
            story: (Array.isArray(page.story) ? page.story : [])
              .filter(item => item?.type === 'chess')
              .map(item => ({ type: 'chess', id: item.id, text: String(item.text || '') })),
          })
        })
      }
      tryLocal(tryOrigin)
    })
  return Promise.all(wanted.map(readOne)).then(pages => pages.filter(Boolean))
}

// Scan browser localStorage for FedWiki page JSON (Local Changes export surface).
const listLocalWikiPagesForAcademyProgress = () => {
  const pages = []
  if (typeof localStorage === 'undefined') return pages
  const maxKeys = 400
  for (let i = 0; i < localStorage.length && pages.length < maxKeys; i++) {
    const key = localStorage.key(i)
    if (!key || !/^[a-z0-9][a-z0-9-]*$/.test(key)) continue
    if (key.startsWith('wiki-chess-') || key.startsWith('wiki.')) continue
    let page
    try {
      page = JSON.parse(localStorage.getItem(key) || '')
    } catch {
      continue
    }
    if (!page || typeof page !== 'object' || !Array.isArray(page.story)) continue
    if (!page.story.some(item => item?.type === 'chess')) continue
    pages.push({
      slug: key,
      title: String(page.title || key),
      story: page.story
        .filter(item => item?.type === 'chess')
        .map(item => ({ type: 'chess', id: item.id, text: String(item.text || '') })),
    })
  }
  return pages
}

/* eslint-disable no-unused-vars -- uniform (ctx, event, text, fen) MSG dispatch signature */
const shellAppMessageHandlers = {
  [MSG.GET_STATE](ctx, event, text, fen) {
    const patchStateOnly = shouldRespondWithPatchStateOnly({
      initialShellStateSent: Boolean(ctx.initialShellStateSent),
      wikiItemEditing: wikiItemTextEditing(),
    })
    sendMessage(ctx, MSG.SET_STATE, { patchStateOnly })
    ctx.initialShellStateSent = true
  },
  [MSG.SAVE_POSITION](ctx, event, text, fen) {
    // The chess app's in-editor "Save Position to Wiki" button. Mirror the old
    // footer button: ask the app to export its current text, then persist it in
    // the `state-exported` handler below (pendingSave path).
    ctx.pendingSave = true
    if (ctx.popup && !ctx.popup.closed && event.source === ctx.iframe?.[0]?.contentWindow) {
      ctx.popup.postMessage({ action: MSG.GET_EXPORT }, window.origin)
    } else {
      sendMessage(ctx, MSG.GET_EXPORT)
    }
  },
  [MSG.REQUEST_RESIGN](ctx, event, text, fen) {
    if (ctx.popup && !ctx.popup.closed) {
      ctx.popup.postMessage({ action: MSG.REQUEST_RESIGN }, window.origin)
    } else {
      // No live popup — resign in the embedded board (stale popup flag or in-page play).
      const iframeWindow = ctx.iframe?.[0]?.contentWindow
      if (iframeWindow) {
        iframeWindow.postMessage({ action: MSG.REQUEST_RESIGN }, window.origin)
      }
    }
  },
  [MSG.REQUEST_SWITCH_GAME_MODE](ctx, event, text, fen) {
    // Deliver to the requesting surface first. A background/zombie popup must not
    // swallow an action the user confirmed in the wiki iframe (common on mobile).
    const iframeWindow = ctx.iframe?.[0]?.contentWindow
    const source = event.source
    const targets = new Set()
    if (source && (source === iframeWindow || source === ctx.popup)) targets.add(source)
    if (ctx.popup && !ctx.popup.closed) targets.add(ctx.popup)
    else if (iframeWindow) targets.add(iframeWindow)
    for (const target of targets) {
      try {
        target.postMessage({ action: MSG.REQUEST_SWITCH_GAME_MODE }, window.origin)
      } catch {
        /* ignore closed targets */
      }
    }
  },
  [MSG.REQUEST_SIGN_IN](ctx, event, text, fen) {
    const claim = document.getElementById('claim')
    const signIn = document.getElementById('show-security-dialog')
    if (claim) claim.click()
    else if (signIn) signIn.click()
  },
  [MSG.REQUEST_VIEWER_CONTEXT](ctx, event, text, fen) {
    const fresh = withAutoSave(ctx, enrichChessObj({ ...ctx.chessObj }, ctx.$item, ctx.item))
    event.source.postMessage(
      {
        action: MSG.VIEWER_CONTEXT,
        itemId: ctx.item.id,
        ...viewerContextPayload(ctx, fresh),
      },
      window.origin,
    )
  },
  [MSG.FETCH_PUZZLE_PAGES](ctx, event, text, fen) {
    void fetchLocalPuzzleReferencePages(event.data?.slugs).then(pages => {
      event.source?.postMessage(
        {
          action: MSG.PUZZLE_PAGES_DATA,
          requestId: event.data?.requestId,
          pages,
        },
        window.origin,
      )
    })
  },
  [MSG.FETCH_LOCAL_ACADEMY_PROGRESS](ctx, event, text, fen) {
    const pages = listLocalWikiPagesForAcademyProgress()
    event.source?.postMessage(
      {
        action: MSG.LOCAL_ACADEMY_PROGRESS_DATA,
        requestId: event.data?.requestId,
        pages,
      },
      window.origin,
    )
  },
  [MSG.POPUP_READY](ctx, event, text, fen) {
    ctx.popup = event.source
    ctx.popupActive = true
    ctx.replacingPopup = false
    monitorPopupClosed(ctx)
    syncChessViews(ctx, event.source)
    // Reverse link: installed PWA opened this wiki tab and is the play host.
    // Do not boot host state from the page journal — wait for mirrorOnly pushes.
    if (!isOpenerHostedPopup(ctx)) {
      sendPopupBootState(ctx, event.source)
    }
    completePopupHandoff(ctx)
  },
  [MSG.PWA_INSTALLED](ctx, event, text, fen) {
    // Reported by the embedded iframe (which shares the PWA scope). Drives
    // launchPopup's choice between a sized popup window and a PWA hand-off.
    pwaInstalled = Boolean(event.data.installed)
    if (pwaInstalled) markChessPwaInstalled()
  },
  [MSG.GAME_SETTINGS_CHANGED](ctx, event, text, fen) {
    if (shouldBlockShellJournalSave(ctx, event)) return
    if (event.data.gameSettings) {
      ctx.chessObj.gameSettings = normalizeGameSettings({
        ...ctx.chessObj.gameSettings,
        ...event.data.gameSettings,
      })
      ctx.item.gameSettings = ctx.chessObj.gameSettings
      saveItemSettings(ctx, ctx.chessObj.gameSettings)
      syncChessViews(ctx, event.source)
    }
  },
  [MSG.CHALLENGE_CHANGED](ctx, event, text, fen) {
    const challenge = normalizeChallengeState(event.data.challenge)
    const ghost = event.data.ghost
    const ghostItemId = String(event.data.ghostItemId || ghost?.itemId || '').trim()
    const pageBackedSlug = String(ghost?.slug || '').trim()
    if (ownerCanJournalHereFlag(ctx)) {
      if (ghost && challenge) {
        publishOpenChallengeSurveyDelta({
          add: {
            itemId: ghost.itemId,
            pgn: ghost.pgn,
            title: ghost.title,
            ...(pageBackedSlug ? { slug: pageBackedSlug } : {}),
            challenge,
          },
        })
        if (challenge.challengeTarget) registerDirectedChallengeNeighbor(challenge.challengeTarget)
      } else if (!challenge && ghostItemId) {
        publishOpenChallengeSurveyDelta({ removeIds: [ghostItemId] })
      }
    }
    if (event.data.challenge !== undefined) {
      if (shouldBlockShellJournalSave(ctx, event)) return
      // Pending survey-only seeks: do not journal challenge onto the posting item.
      // Page-backed seeks keep challenge on the game item for fork / Accept.
      if (ghost && !pageBackedSlug) {
        delete ctx.chessObj.challenge
      } else {
        ctx.chessObj.challenge = challenge || undefined
        saveItemChallenge(ctx, challenge)
      }
      syncChessViews(ctx, event.source)
    }
  },
  [MSG.SHELL_SESSION_FLAGS](ctx, event, text, fen) {
    const bareKeywordGuard = event.data.bareKeywordGuard
    if (bareKeywordGuard !== undefined) {
      if (bareKeywordGuard) ctx.chessObj.bareKeywordGuard = bareKeywordGuard
      else delete ctx.chessObj.bareKeywordGuard
    }
    if (event.data.awaitingStockfishSetup !== undefined) {
      if (event.data.awaitingStockfishSetup) {
        ctx.chessObj.awaitingStockfishSetup = true
      } else {
        delete ctx.chessObj.awaitingStockfishSetup
      }
    }
    if (event.data.clearOpenChallengeSetupPending) {
      delete ctx.chessObj.openChallengeSetupPending
      if (ctx.item) delete ctx.item.openChallengeSetupPending
    }
  },
  [MSG.REALTIME_PRESENCE](ctx, event, text, fen) {
    if (shouldBlockShellJournalSave(ctx, event)) return
    // Remember the local player's seat + readiness so the next move's save folds
    // it into the item (stampRealtimePresence). After the first move, consent and
    // readiness amend the latest journal snapshot instead of adding a new flag.
    ctx.realtimePresence = event.data.presence || null
    if (event.data.persist && ctx.realtimePresence) {
      saveRealtimePresence(ctx, ctx.realtimePresence)
      setRemotePollSpeed(ctx, Boolean(ctx.realtimePresence.rtcConsent))
    }
  },
  [MSG.REALTIME_SIGNAL](ctx, event, text, fen) {
    if (shouldBlockShellJournalSave(ctx, event)) return
    // The app produced (or finished with) a WebRTC offer/answer. Persist it to our
    // seat so the opponent's poll picks it up, and poll faster while handshaking.
    if (event.data.seat) {
      saveRealtimeSignal(ctx, event.data.seat, event.data.signal || null)
    }
    setRemotePollSpeed(ctx, Boolean(event.data.handshaking))
  },
  [MSG.REALTIME_STATUS](ctx, event, text, fen) {
    if (ctx.popup && !ctx.popup.closed && event.source === ctx.popup && ctx.iframe?.[0]?.contentWindow) {
      ctx.iframe[0].contentWindow.postMessage(
        {
          action: MSG.REALTIME_STATUS,
          connected: Boolean(event.data?.connected),
          connecting: Boolean(event.data?.connecting),
        },
        window.origin,
      )
    }
  },
  [MSG.REQUEST_REALTIME_STATUS](ctx, event, text, fen) {
    if (ctx.popup && !ctx.popup.closed && event.source === ctx.iframe?.[0]?.contentWindow) {
      ctx.popup.postMessage({ action: MSG.REQUEST_REALTIME_STATUS }, window.origin)
    }
  },
  [MSG.STATE_EXPORTED](ctx, event, text, fen) {
    if (ctx.pendingPopup) {
      const replacing = Boolean(ctx.replacingPopup)
      if (text) {
        const exported = event.data.chessObj
        let merged = mergeItemTextIntoChessObj({ ...ctx.chessObj }, text)
        if (exported && typeof exported === 'object') {
          merged = { ...merged, ...exported }
          if (exported.showStartMenu || exported.mode === 'CHOOSE') {
            merged.showStartMenu = true
            merged.format = 'MENU'
            merged.mode = 'CHOOSE'
            merged.chessState = 'CHOOSE'
            delete merged.PGN
            delete merged.FEN
            delete merged.gameType
            delete merged.needsSeed
            delete merged.bareKeywordGuard
          } else if (exported.gameType === 'puzzle' || exported.format === 'PUZZLE' || exported.mode === 'PUZZLE') {
            merged.showStartMenu = false
            merged.format = 'PUZZLE'
            merged.mode = 'PUZZLE'
            merged.gameType = 'puzzle'
            delete merged.PGN
            if (!merged.FEN) delete merged.FEN
          } else if (exported.gameType === 'position' || exported.mode === 'POSITION') {
            merged.showStartMenu = false
            merged.format = 'FEN'
            merged.mode = 'POSITION'
            merged.gameType = 'position'
            delete merged.PGN
          } else if (
            exported.gameType === 'engine' ||
            exported.gameType === 'human' ||
            exported.gameType === 'open' ||
            exported.format === 'PGN' ||
            exported.mode === 'GAME' ||
            merged.PGN ||
            (text && getFormat(text) === 'PGN')
          ) {
            merged.showStartMenu = false
            merged.format = 'PGN'
            if (!merged.mode || merged.mode === 'POSITION' || merged.mode === 'NONE') {
              merged.mode = 'GAME'
            }
            if (exported.gameType === 'engine' || exported.gameType === 'human' || exported.gameType === 'open') {
              merged.gameType = exported.gameType
            } else if (merged.gameType === 'position') {
              delete merged.gameType
            }
            delete merged.FEN
          }
        }
        Object.assign(ctx.chessObj, slimAppState(merged))
        // Assign cannot clear keys omitted from slim — drop stale FEN explicitly.
        if (ctx.chessObj.gameType !== 'position' && ctx.chessObj.mode !== 'POSITION') {
          delete ctx.chessObj.FEN
        }
      }
      launchPopup(ctx, { replacing })
    }
    if (ctx.pendingSave && text && !ctx.pendingPopup) {
      saveItemText(ctx, text, { fen })
      ctx.pendingSave = false
      updateChessItemControls(ctx)
      syncChessViews(ctx, event.source)
    }
  },
  [MSG.POSITION_CHANGED](ctx, event, text, fen) {
    // PWA already journaled via HTTP bridge — update in-memory item + follower embed only.
    if (event.data?.mirrorOnly) {
      if (isMaintenanceChessCtx(ctx)) return
      const next = String(text || event.data?.text || '').trim()
      if (!next) return
      applyTextToItemLive(ctx, next)
      Object.assign(ctx.chessObj, slimAppState(mergeItemTextIntoChessObj({ ...ctx.chessObj }, next)))
      syncChessViews(ctx, event.source)
      return
    }
    // Follower played on the wiki embed — one journal writer is the linked host
    // (popup or opener PWA). Relay the board; do not put from this surface.
    if (event.data?.relayToLinkedHost) {
      if (ctx.popup && !ctx.popup.closed) {
        try {
          ctx.popup.postMessage(
            {
              action: MSG.APPLY_LINKED_BOARD,
              itemId: ctx.item.id,
              text: String(text || event.data?.text || '').trim(),
              ...(fen ? { fen } : {}),
            },
            window.origin,
          )
        } catch (error) {
          if (wiki.debug) console.log('relayToLinkedHost', error)
        }
      }
      return
    }
    if (shouldBlockShellJournalSave(ctx, event)) return
    const itemText = ctx.item?.text
    const plan = planChessShellPersist({
      itemText,
      nextText: text || event.data?.text,
      bareKeywordGuard: ctx.chessObj?.bareKeywordGuard,
      gameType: ctx.chessObj?.gameType,
      revert: Boolean(event.data.revert),
      lastJournalWasItemEdit: lastJournalActionIsItemEdit(ctx),
      isSurveyItem: isSurveyItemText(itemText),
      isLeaderboardItem: isLeaderboardItemText(itemText),
    })
    if (!plan.persist) return
    const saveText = plan.saveText
    const pageTitle = String(event.data?.title || '').trim()
    if (plan.clearKeywordOnly && ctx.chessObj?.bareKeywordGuard) {
      delete ctx.chessObj.bareKeywordGuard
    }
    if (plan.kind === 'puzzle') {
      if (saveText && saveItemText(ctx, saveText, { fen, title: pageTitle })) {
        Object.assign(ctx.chessObj, slimAppState(mergeItemTextIntoChessObj({ ...ctx.chessObj }, saveText)))
        syncChessViews(ctx, event.source)
      }
      return
    }
    if (plan.kind === 'position') {
      if (saveItemText(ctx, saveText, { fen: fen || saveText, title: pageTitle })) {
        ctx.chessObj.needsSeed = false
        syncChessViews(ctx, event.source)
      }
      return
    }
    if (saveChessItemText(ctx, saveText, { fen, forkSite: event.data.forkSite, title: pageTitle })) {
      ctx.chessObj.needsSeed = false
      syncChessViews(ctx, event.source)
      updateChessItemControls(ctx)
    }
  },
  [MSG.GAME_READY](ctx, event, text, fen) {
    if (shouldBlockShellJournalSave(ctx, event)) return
    maybeClearEmbedLoading(ctx)
    const itemText = ctx.item?.text
    const plan = planChessShellPersist({
      itemText,
      nextText: text || event.data?.text,
      bareKeywordGuard: ctx.chessObj?.bareKeywordGuard,
      gameType: ctx.chessObj?.gameType,
      isSurveyItem: isSurveyItemText(itemText),
      isLeaderboardItem: isLeaderboardItemText(itemText),
    })
    if (!plan.persist) {
      updateChessItemControls(ctx)
      return
    }
    if (plan.clearKeywordOnly && ctx.chessObj?.bareKeywordGuard) {
      delete ctx.chessObj.bareKeywordGuard
    }
    const saveText = plan.saveText
    if (saveText && ctx.chessObj?.needsSeed) {
      if (saveChessItemText(ctx, saveText)) {
        ctx.chessObj.needsSeed = false
      }
    }
    updateChessItemControls(ctx)
  },
  [MSG.MODE_CHANGED](ctx, event, text, fen) {
    // The app switched modes in-app without persisting (e.g. game -> position
    // editor). Update our notion of the item state so the footer controls (the
    // "Save position to wiki" button) reflect the new mode. No journal write.
    // Survey/leaderboard wiki items never leave their maintenance view.
    if (isMaintenanceChessCtx(ctx)) return
    if (event.data.chessObj && typeof event.data.chessObj === 'object') {
      Object.assign(ctx.chessObj, event.data.chessObj)
      if (event.data.chessObj.gameType === 'position') delete ctx.chessObj.PGN
      if (
        event.data.chessObj.showStartMenu ||
        event.data.chessObj.mode === 'CHOOSE' ||
        event.data.chessObj.format === 'MENU'
      ) {
        delete ctx.chessObj.PGN
        delete ctx.chessObj.FEN
        delete ctx.chessObj.gameType
        delete ctx.chessObj.needsSeed
        delete ctx.chessObj.challenge
        ctx.chessObj.chessState = 'CHOOSE'
      }
      if (
        event.data.chessObj.mode === 'GAME' ||
        event.data.chessObj.format === 'PGN' ||
        event.data.chessObj.gameType === 'engine' ||
        event.data.chessObj.gameType === 'human' ||
        event.data.chessObj.gameType === 'open'
      ) {
        // Object.assign cannot remove keys — drop position-editor residue so
        // "Open in new window" boots the game, not the FEN editor.
        delete ctx.chessObj.FEN
        delete ctx.chessObj.bareKeywordGuard
      }
      updateChessItemControls(ctx)
      pushModeChangeToViews(ctx, event.source)
    }
  },
  [MSG.REMOTE_WATCH](ctx, event, text, fen) {
    startRemoteWatch(ctx, event.data.host || null)
  },
  [MSG.FORK_REMOTE_PAGE](ctx, event, text, fen) {
    forkRemoteOpponentPage(ctx, {
      host: event.data?.host || null,
      expectText: event.data?.expectText || text || null,
    })
  },
  [MSG.DISCOVER_RATINGS](ctx, event, text, fen) {
    // Only the shell can fetch cross-origin: crawl both seats' wikis for their
    // latest rated game and reply with the verified Glicko-2 state of each.
    ctx.leaderboardFetchGen = (ctx.leaderboardFetchGen || 0) + 1
    const fetchGen = ctx.leaderboardFetchGen
    void discoverRatings(ctx, event.data, fetchGen)
  },
  [MSG.FINALIZE_MATCH](ctx, event, text, fen) {
    // Async-play finalize / claim-victory: persist the rating-stamped final PGN to
    // the player's own page (same path as an autosaved move).
    if (text && saveItemText(ctx, text, { fen })) {
      ctx.chessObj.needsSeed = false
      updateChessItemControls(ctx)
      syncChessViews(ctx, event.source)
    }
  },
  [MSG.REGISTER_NEIGHBORS](ctx, event, text, fen) {
    for (const host of Array.isArray(event.data?.sites)
      ? event.data.sites
      : Array.isArray(event.data?.hosts)
        ? event.data.hosts
        : []) {
      registerDirectedChallengeNeighbor(host)
    }
  },
  [MSG.LOOKUP_SITE_DISPLAY](ctx, event, text, fen) {
    const host = String(event.data?.site ?? event.data?.host ?? '').trim()
    const requestId = event.data?.requestId
    void (async () => {
      let displayName = ''
      let valid = false
      let error = ''
      try {
        // Prefer wiki.site (/proxy/ on HTTPS) — direct fetch hits CORS on many farms.
        const siteClient = wikiSiteAdapter()
        const probe = await probeWikiSite(host, {
          getPage: (site, path) => siteClient.getPage(site, path),
        })
        valid = probe.valid
        displayName = probe.displayName || ''
        error = probe.error || ''
      } catch {
        error = 'unreachable'
      }
      try {
        event.source?.postMessage?.(
          { action: MSG.SITE_DISPLAY, requestId, site: host, displayName, valid, error },
          window.origin,
        )
      } catch (error) {
        if (wiki.debug) console.log('lookup host display reply error', error)
      }
    })()
  },
  [MSG.ABANDON_FETCHES](ctx, event, text, fen) {
    // Explicit cancel (edit mode, new conflicting crawl, tab teardown) — not leaving
    // the leaderboard view; Visible-federation crawls keep running after navigation.
    ctx.leaderboardFetchGen = (ctx.leaderboardFetchGen || 0) + 1
    bindDeepAuditUnload(false)
  },
  [MSG.BUILD_LEADERBOARD](ctx, event, text, fen) {
    // Only the shell can fetch cross-origin: crawl the neighbourhood (or the survey
    // survey member list) and reply with a ranked, twin-verified leaderboard.
    // Yield first so the iframe can paint its loading state and stay interactive.
    ctx.leaderboardFetchGen = (ctx.leaderboardFetchGen || 0) + 1
    const leaderboardFetchGen = ctx.leaderboardFetchGen
    const leaderboardRequestSource = event.source
    setTimeout(() => {
      buildLeaderboardData(ctx, event.data, leaderboardFetchGen, leaderboardRequestSource)
      requestAnimationFrame(() => {
        if (!ctx?.iframe) return
        const h = Number.parseInt(ctx.iframe[0]?.style?.height, 10)
        if (Number.isFinite(h)) applyIframeHeight(ctx, capIframeHeightBelowFooter(ctx, h))
      })
    }, 0)
  },
  [MSG.BUILD_CHALLENGES](ctx, event, text, fen) {
    // Site-survey deferred open-challenges crawl (shared with PWA bridge).
    buildSiteSurveyDeferredChallenges(ctx, event.data, event.source)
  },
  [MSG.BUILD_SITE_SURVEY_ENRICH](ctx, event, text, fen) {
    buildSiteSurveyDeferredEnrich(ctx, event.data, event.source)
  },
  [MSG.OPEN_ITEM_EDITOR](ctx, event, text, fen) {
    openChessItemEditor(ctx)
  },
  [MSG.FETCH_UI](ctx, event, text, fen) {
    const loading = event.data?.loading === true
    const deep = event.data?.deep === true
    const warnUnload = event.data?.warnUnload === true
    // Deep audits and Visible-federation crawls both warn before tab close.
    bindDeepAuditUnload(loading && (deep || warnUnload))
    // After the iframe reports its loading height, reclamp so the footer edit bar
    // is never covered by the iframe hit target.
    maybeClearEmbedLoading(ctx)
    requestAnimationFrame(() => {
      if (!ctx?.iframe) return
      const h = Number.parseInt(ctx.iframe[0]?.style?.height, 10)
      if (!Number.isFinite(h)) return
      applyIframeHeight(ctx, capIframeHeightBelowFooter(ctx, h))
    })
  },
  [MSG.ALERT_UI](ctx, event, text, fen) {
    // Full-viewport alert on the parent wiki window — visible even when the chess
    // iframe is scrolled away or showing another plugin mode.
    const title = String(event.data?.title || 'Chess').trim() || 'Chess'
    const message = String(event.data?.message || '').trim()
    const okLabel = String(event.data?.okLabel || 'OK').trim() || 'OK'
    try {
      window.focus?.()
    } catch {
      /* ignore */
    }
    openAlertModal({ title, message, okLabel, mount: document.body })
  },
  [MSG.OPEN_SURVEY_PAGE](ctx, event, text, fen) {
    // Present the "My Chess Games" page as a forkable GHOST in the lineup, right after
    // the page this chess item lives on. The page is NOT shipped as a server-served
    // default — it lives in the plugin as the SURVEY_PAGE_STORY template.
    const view = !!event.data?.view
    const $page = ctx.$item?.parents?.('.page')?.first?.()
    const anchor = wikiLineupAnchor($page, ctx.$item)
    const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
      .trim()
      .toLowerCase()
    const linkFallback = () => {
      try {
        if (typeof wiki?.doInternalLink === 'function') {
          wiki.doInternalLink(SURVEY_PAGE_TITLE, anchor)
        }
      } catch (error) {
        if (wiki.debug) console.log('open survey page fallback error', error)
      }
    }
    const showGhost = (baseStory, baseTitle) => {
      const ghost = wiki.newPage({
        title: baseTitle || SURVEY_PAGE_TITLE,
        story: Array.isArray(baseStory) ? baseStory.map(entry => ({ ...entry })) : SURVEY_PAGE_STORY,
        journal: [],
      })
      try {
        wiki.showResult(ghost, anchor ? { $page: anchor } : {})
      } catch (error) {
        if (wiki.debug) console.log('open survey page showResult error', error)
        linkFallback()
      }
    }
    try {
      if (
        typeof wiki?.newPage !== 'function' ||
        typeof wiki?.showResult !== 'function' ||
        typeof wiki?.site !== 'function'
      ) {
        linkFallback()
      }
      // Prefer the player's own saved copy when they've already forked it; otherwise fall
      // back to the built-in template (the page is no longer a server-served default — it
      // only exists once an author forks this ghost).
      wiki.site(localSite).get(`${SURVEY_PAGE_SLUG}.json`, (err, page) => {
        const saved = !err && page && Array.isArray(page.story) ? page : null
        // `event.data.view`: open the games page directly, not a fork prompt.
        if (view && saved) {
          linkFallback()
          return
        }
        showGhost(saved ? saved.story : SURVEY_PAGE_STORY, saved ? saved.title : SURVEY_PAGE_TITLE)
      })
    } catch (error) {
      if (wiki.debug) console.log('open survey page error', error)
      linkFallback()
    }
  },
  [MSG.OPEN_LEADERBOARD_PAGE](ctx, event, text, fen) {
    const view = !!event.data?.view
    const $page = ctx.$item?.parents?.('.page')?.first?.()
    const anchor = wikiLineupAnchor($page, ctx.$item)
    const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
      .trim()
      .toLowerCase()
    const linkFallback = () => openLeaderboardPageLink(anchor, localSite)
    const showGhost = (baseStory, baseTitle) => {
      const ghost = wiki.newPage({
        title: baseTitle || LEADERBOARD_PAGE_TITLE,
        story: Array.isArray(baseStory) ? baseStory.map(entry => ({ ...entry })) : LEADERBOARD_PAGE_STORY,
        journal: [],
      })
      try {
        wiki.showResult(ghost, anchor ? { $page: anchor } : {})
      } catch (error) {
        if (wiki.debug) console.log('open leaderboard page showResult error', error)
        linkFallback()
      }
    }
    try {
      if (
        typeof wiki?.newPage !== 'function' ||
        typeof wiki?.showResult !== 'function' ||
        typeof wiki?.site !== 'function'
      ) {
        linkFallback()
      }
      wiki.site(localSite).get(`${LEADERBOARD_PAGE_SLUG}.json`, (err, canonical) => {
        const savedCanonical = !err && canonical?.story && !canonical.plugin
        // view=true: open the saved page directly, not a second ghost copy.
        if (view && savedCanonical) {
          linkFallback()
          return
        }
        showGhost(
          savedCanonical ? canonical.story : LEADERBOARD_PAGE_STORY,
          savedCanonical ? canonical.title || LEADERBOARD_PAGE_TITLE : LEADERBOARD_PAGE_TITLE,
        )
      })
    } catch (error) {
      if (wiki.debug) console.log('open leaderboard page error', error)
      linkFallback()
    }
  },
  [MSG.OPEN_GAME_PAGE](ctx, event, text, fen) {
    const gameSlug = String(event.data?.slug || '').trim()
    const host = String(event.data?.site ?? event.data?.host ?? '')
      .trim()
      .toLowerCase()
    const itemId = String(event.data?.itemId || '').trim()
    const ghostPgn = String(event.data?.pgn || '').trim()
    const challengeHint = normalizeChallengeState(event.data?.challenge)
    // `append` (Shift+click from My Chess Games) mirrors FedWiki [[link]] shift behavior:
    // pass a null $page so doInternalLink / showResult add at the end of the lineup.
    const append = Boolean(event.data?.append)
    const $page = append ? null : ctx.$item?.parents?.('.page')?.first?.()
    const anchor = $page && $page.length ? $page : null
    const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
      .trim()
      .toLowerCase()
    if (event.data?.ghost && challengeHint && isOpenChallenge(challengeHint) && ghostPgn) {
      showChallengeJoinGhost({
        host,
        itemId,
        entryTitle: String(event.data?.title || '').trim(),
        anchor,
        challenge: challengeHint,
        pgn: ghostPgn,
        joinerDisplayName: resolveJoinerDisplayName(ctx),
      })
    }
    if (!gameSlug) return
    openGamePageLink(gameSlug, anchor, host || null)
  },
  [MSG.SHOW_CRAWL_HITS_PAGE](ctx, event, text, fen) {
    // Same shape as FedWiki search results: intro paragraph + reference items.
    if (typeof wiki?.newPage !== 'function' || typeof wiki?.showResult !== 'function') return
    const title = String(event.data?.title || 'Crawl hits').trim() || 'Crawl hits'
    const intro = String(event.data?.intro || '').trim()
    const refs = Array.isArray(event.data?.references) ? event.data.references : []
    const maxRefs = Math.max(1, Math.min(250, Number(event.data?.maxReferences) || 200))
    const shown = refs.slice(0, maxRefs)
    const omitted = Math.max(0, refs.length - shown.length)
    const story = []
    if (intro || omitted) {
      const lines = [intro, omitted ? `${omitted} additional hit${omitted === 1 ? '' : 's'} omitted.` : '']
        .filter(Boolean)
        .join('\n')
      if (lines) story.push({ type: 'paragraph', id: newItemId(), text: lines })
    }
    for (const row of shown) {
      const site = String(row?.site ?? row?.host ?? '')
        .trim()
        .toLowerCase()
      const slug = String(row?.slug || '').trim()
      if (!site || !slug) continue
      story.push({
        type: 'reference',
        id: newItemId(),
        site,
        slug,
        title: String(row?.title || slug).trim() || slug,
        text: String(row?.text || '').trim(),
      })
    }
    if (!story.length) {
      story.push({
        type: 'paragraph',
        id: newItemId(),
        text: 'No crawl hits to list yet.',
      })
    }
    const $page = ctx.$item?.parents?.('.page')?.first?.()
    const anchor = wikiLineupAnchor($page, ctx.$item)
    const ghost = wiki.newPage({
      title,
      story,
      journal: [{ type: 'create', item: { title, story }, date: Date.now() }],
    })
    try {
      wiki.showResult(ghost, anchor ? { $page: anchor } : {})
    } catch (error) {
      if (wiki.debug) console.log('show crawl hits page error', error)
    }
  },
  [MSG.CREATE_PREVIEW]: handleCreatePreview,
  [MSG.UPDATE_GHOST_PAGE_TITLE](ctx, event, text, fen) {
    const title = String(event.data?.title || '').trim()
    if (!title) return
    let $page = null
    const pageKey = String(event.data?.pageKey || '').trim()
    if (pageKey) {
      $page = findGhostPageByKey(pageKey)
    }
    if (!$page?.length && ctx.$item && isGhostPage(ctx.$item)) {
      $page = ctx.$item.parents('.page:first')
    }
    if (!$page?.length) {
      $page = findPendingCreatePreviewPage()
    }
    if (!$page?.length) return
    applyGhostPageTitle($page, title, { ctx })
  },
  [MSG.SYNC_GHOST_PREVIEW_TEXT](ctx, event, text, fen) {
    const previewText = String(event.data?.text || text || '').trim()
    if (!previewText) return
    syncGhostPreviewChessItemText(ctx, previewText)
  },
  [MSG.CREATE_PASTE_PREVIEW](ctx, event, text, fen) {
    const payload = Paste.capture(String(event.data?.itemText || ''), 'paste-ghost')
    if (!payload.actionable) return
    const $page = ctx.$item?.parents?.('.page')?.first?.()
    const anchor = $page && $page.length ? $page : null
    showPasteGhost({ payload, anchor, ctx })
  },
  [MSG.SURVEY_STATUS](ctx, event, text, fen) {
    const localSite = String(ctx.chessObj?.wikiSite || location.host || '')
      .trim()
      .toLowerCase()
    const slug = getPageSlug(ctx.$item) ?? ctx.chessObj?.wikiPageName
    checkLeaderboardReadiness(localSite, slug, ({ hasRatedGame }) => {
      const msg = { action: MSG.SURVEY_STATE, hasRatedGame }
      try {
        if (ctx.iframe?.[0]?.contentWindow) ctx.iframe[0].contentWindow.postMessage(msg, window.origin)
        if (ctx.popup && !ctx.popup.closed) ctx.popup.postMessage(msg, window.origin)
      } catch (error) {
        if (wiki.debug) console.log('survey status reply error', error)
      }
    })
  },
  [MSG.RESIZE](ctx, event, text, fen) {
    resizeIframe(ctx, event.data.height, { scrollIntoView: Boolean(event.data.scrollIntoView) })
  },
  [MSG.EMBED_WHEEL_SCROLL](ctx, event, text, fen) {
    const page = ctx.$item?.parents?.('.page:first')?.[0]
    const deltaY = Number(event.data?.deltaY) || 0
    const deltaX = Number(event.data?.deltaX) || 0
    if (page instanceof HTMLElement && (deltaY || deltaX)) {
      page.scrollBy({ top: deltaY, left: deltaX })
    }
  },
  [MSG.PASTE_APPLY](ctx, event, text, fen) {
    if (event.data.text) {
      applyPasteToItem(ctx, {
        itemText: event.data.text,
        actionable: true,
        forkSite: event.data.forkSite,
      })
    }
  },
}
/* eslint-enable no-unused-vars */

const dispatchShellAppAction = createMessageDispatcher(shellAppMessageHandlers)

function dispatchShellAppMessage(ctx, event) {
  const { action, text, fen } = event.data ?? {}
  if (dispatchShellAppAction(action, ctx, event, text, fen)) return
  if (wiki.debug) {
    console.log({ where: 'chessListener', action, data: event.data })
  }
}

function chessListener(event) {
  if (event.origin !== window.origin) return

  if (event.data?.action === MSG.POPUP_CLOSED) {
    const itemLive = findItemLiveBySource(event.source)
    if (itemLive) {
      if (itemLive.popupPoll) clearInterval(itemLive.popupPoll)
      itemLive.popupPoll = null
      itemLive.popup = null
      itemLive.pendingPopup = false
      itemLive.replacingPopup = false
      itemLive.popupHandoff = false
      resumeIframePlay(itemLive)
    }
    return
  }

  if (!isChessAppSource(event.source)) {
    return
  }

  let itemLive = findItemLiveBySource(event.source)
  if (!itemLive && event.data?.itemId) {
    itemLive = adoptRefreshedPopup(event)
  }
  if (!itemLive) {
    if (wiki.debug) {
      console.log('chessListener - unknown source', event.source)
    }
    return
  }

  dispatchShellAppMessage(itemLive, event)
}

if (typeof window !== 'undefined') {
  wireChessItemBarEdit()
  wireWikiSortableChessFreeze()
  wireWikiEditTogglePark()
  window.plugins = window.plugins || {}
  window.plugins.chess = { emit, bind, editor, doPopup, sendMessage }
  if (typeof window.chessListener === 'undefined' || window.chessListener == null) {
    window.chessListener = chessListener
    window.addEventListener('message', chessListener)
  }

  // Re-push SET_STATE when auth/owner flags change after the security plugin's async
  // client-settings fetch (or a sign-in cookie update without a full reload).
  let lastSyncedAuth = null
  const authSnapshot = () => {
    const authenticated = typeof isAuthenticated !== 'undefined' && Boolean(isAuthenticated)
    const owner = typeof isOwner !== 'undefined' && Boolean(isOwner)
    return `${authenticated}:${owner}`
  }
  const syncAllChessEmbedsIfAuthChanged = () => {
    const current = authSnapshot()
    if (lastSyncedAuth === current) return
    lastSyncedAuth = current
    for (const itemLive of items.values()) {
      if (itemLive.iframe || itemLive.popup) {
        sendMessage(itemLive, MSG.SET_STATE, { patchStateOnly: true })
      }
    }
  }
  let authPollCount = 0
  const AUTH_EMBED_POLL_INITIAL_MS = 300
  const AUTH_EMBED_POLL_INTERVAL_MS = 500
  const AUTH_EMBED_POLL_MAX_ATTEMPTS = 24
  const pollAuthForChessEmbeds = () => {
    syncAllChessEmbedsIfAuthChanged()
    if (++authPollCount < AUTH_EMBED_POLL_MAX_ATTEMPTS) {
      window.setTimeout(pollAuthForChessEmbeds, AUTH_EMBED_POLL_INTERVAL_MS)
    }
  }
  window.setTimeout(pollAuthForChessEmbeds, AUTH_EMBED_POLL_INITIAL_MS)
  if (typeof cookieStore !== 'undefined') {
    cookieStore.addEventListener('change', () => {
      lastSyncedAuth = null
      window.setTimeout(syncAllChessEmbedsIfAuthChanged, 200)
    })
  }
}

// # Factory Expand Export

const expand = text =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')

export const chess = typeof window == 'undefined' ? { expand } : undefined
