/**
 * Shared DOM modals — confirm, paste, challenge/seek, puzzle filters, etc.
 *
 * §1 Modal stack / mount restore
 * §2 Auth-gated controls
 * §3 Confirm & paste modals
 * §4 Game / challenge / puzzle modals
 *
 * Used by both chess.js (shell) and chess-app.js (iframe). One active shell modal at a
 * time; stacking (e.g. paste over a seat-claim dialog) suspends the prior modal and
 * restores it on Cancel. Embedded callers pass a cleanup hook so iframe height can be
 * re-measured after close.
 *
 * In-file landmarks use `// # Section Name` for navigation.
 */

import { LEADERBOARD_PAGE_TITLE } from './federation.js'

let activeModalRoot = null
// Called after the active modal is torn down — lets an embedded caller re-measure
// and shrink the host iframe once an in-flow modal is removed.
let activeModalCleanup = null
// Restores page content hidden by openWithEmbeddedMount (in-flow wiki iframe modals).
let activeMountRestore = null
// The active modal's document-level keydown handler, removed on close so listeners
// never accumulate across opens (and a stale Escape can't double-fire onCancel).
let activeModalKeyHandler = null
// Suspended modals (shell DOM or body-level overlays) preserved while a stacked dialog
// such as paste-confirm is open — resumed on Cancel, discarded on Confirm/Apply.
const suspendedStack = []
// Body-level in-flow dialogs (e.g. wikiFenStartModal) registered by board-layout.js.
let bodyDialogOverlay = null

let pwaModalWindowBegin = null
let pwaModalWindowScheduleFit = null
let pwaModalWindowEnd = null

// # Modal Stack and Mount Restore

export function registerModalPwaWindowHandlers({ begin, scheduleFit, end } = {}) {
  pwaModalWindowBegin = begin || null
  pwaModalWindowScheduleFit = scheduleFit || null
  pwaModalWindowEnd = end || null
}

function beginPwaModalWindowForShell(panel, { embedded, boardOverlay } = {}) {
  if (embedded || boardOverlay) return
  pwaModalWindowBegin?.(panel)
  pwaModalWindowScheduleFit?.(panel)
}

function endPwaModalWindowForShell({ embedded, boardOverlay } = {}) {
  if (embedded || boardOverlay) return
  pwaModalWindowEnd?.()
}

function refitPwaModalWindowForActiveShell() {
  const panel = activeModalRoot?.querySelector('.wiki-modal-panel')
  if (panel) pwaModalWindowScheduleFit?.(panel)
}

function refitPwaModalWindowAfterResume() {
  refitPwaModalWindowForActiveShell()
  const fenModal = document.getElementById('wikiFenStartModal')
  const panel = fenModal?.querySelector('.wiki-stockfish-setup-panel')
  if (fenModal && !fenModal.hidden && panel) pwaModalWindowScheduleFit?.(panel)
}

// Hover text for PWA controls that need wiki owner sign-in before they work.
export const WIKI_AUTH_REQUIRED_TITLE = 'Sign in on your wiki — available again once you authenticate.'

// # Auth Gated Controls

// Grey out a control but keep its title tooltip (native `disabled` suppresses hover text).
export function setAuthGatedButton(
  button,
  enabled,
  { titleWhenDisabled = WIKI_AUTH_REQUIRED_TITLE, titleWhenEnabled = '' } = {},
) {
  if (!button) return
  button.disabled = false
  button.classList.toggle('is-disabled', !enabled)
  button.setAttribute('aria-disabled', enabled ? 'false' : 'true')
  const title = enabled ? titleWhenEnabled : titleWhenDisabled
  if (title) {
    button.title = title
    button.setAttribute('aria-label', title)
  } else {
    button.removeAttribute('title')
    button.removeAttribute('aria-label')
  }
  if (enabled) button.removeAttribute('tabindex')
  else button.tabIndex = -1
}

export function installAuthGatedClickGuard(container) {
  if (!container || container._wikiAuthGatedGuard) return
  container._wikiAuthGatedGuard = true
  container.addEventListener(
    'click',
    event => {
      const button = event.target.closest('button.is-disabled, a.is-disabled')
      if (button) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    true,
  )
}

export function registerMountRestore(restore) {
  activeMountRestore = typeof restore === 'function' ? restore : null
}

export function registerBodyDialogOverlay(overlay) {
  bodyDialogOverlay = overlay && typeof overlay.suspend === 'function' ? overlay : null
}

function runMountRestore() {
  const restore = activeMountRestore
  activeMountRestore = null
  restore?.()
}

// Restore hidden in-flow page content (explicit teardown, not suspend).
export function restoreEmbeddedMount() {
  runMountRestore()
}

function suspendShellModal() {
  if (!activeModalRoot) return false
  const root = activeModalRoot
  if (activeModalKeyHandler) {
    document.removeEventListener('keydown', activeModalKeyHandler)
  }
  root.dataset.wikiSuspended = 'true'
  root.hidden = true
  root.style.display = 'none'
  const parent = root.parentNode
  // Keep item-scoped shell modals in their chess host. Only park orphan overlays on body.
  if (parent && !parent.classList?.contains('wiki-plugin-chess')) {
    document.body.appendChild(root)
  }
  suspendedStack.push({
    kind: 'shell',
    root,
    cleanup: activeModalCleanup,
    mountRestore: activeMountRestore,
    keyHandler: activeModalKeyHandler,
    parent,
  })
  activeModalRoot = null
  activeModalCleanup = null
  activeModalKeyHandler = null
  activeMountRestore = null
  return true
}

function isVisibleDialogEl(el) {
  if (!el || el.hidden) return false
  if (typeof getComputedStyle === 'undefined') return true
  return getComputedStyle(el).display !== 'none'
}

function suspendBodyDialogElement(el) {
  const state = el._wikiBodyDialogState
  if (!state?.mount || !isVisibleDialogEl(el)) return null
  el._cleanup?.()
  el._cleanup = null
  el.hidden = true
  el.style.display = 'none'
  document.body.appendChild(el)
  registerMountRestore(null)
  const overlay = {
    resume: () => {
      el.classList.add(state.embeddedClass)
      state.mount.appendChild(el)
      el.hidden = false
      el.style.removeProperty('display')
      registerMountRestore(state.teardown)
      registerBodyDialogOverlay(overlay)
      el._resumeKeyHandler?.()
      window.scheduleWikiHeightReport?.()
    },
    discard: state.teardown,
    suspend: () => false,
  }
  return overlay
}

function suspendBodyDialogOverlay() {
  if (bodyDialogOverlay?.suspend?.()) {
    const overlay = bodyDialogOverlay
    bodyDialogOverlay = null
    suspendedStack.push({ kind: 'bodyDialog', overlay })
    return true
  }
  if (typeof document === 'undefined') return false
  const startModal = document.getElementById('wikiFenStartModal')
  const overlay = startModal ? suspendBodyDialogElement(startModal) : null
  if (!overlay) return false
  suspendedStack.push({ kind: 'bodyDialog', overlay })
  return true
}

// Hide the open dialog without destroying it — used before stacking paste-confirm, etc.
export function suspendForStacking() {
  if (suspendShellModal()) return
  suspendBodyDialogOverlay()
}

function resumeOneSuspended() {
  const entry = suspendedStack.pop()
  if (!entry) return false
  if (entry.kind === 'shell') {
    const { root, cleanup, mountRestore, keyHandler, parent } = entry
    delete root.dataset.wikiSuspended
    root.hidden = false
    root.style.display = ''
    if (parent) parent.appendChild(root)
    else document.body.appendChild(root)
    activeModalRoot = root
    activeModalCleanup = cleanup
    activeMountRestore = mountRestore
    registerMountRestore(mountRestore)
    if (keyHandler) {
      document.addEventListener('keydown', keyHandler)
      activeModalKeyHandler = keyHandler
    }
  } else if (entry.kind === 'bodyDialog') {
    entry.overlay?.resume?.()
  }
  document.body?.classList.add('wiki-modal-open')
  return true
}

function discardAllSuspended() {
  while (suspendedStack.length) {
    const entry = suspendedStack.pop()
    if (entry.kind === 'shell') {
      entry.root?.remove()
      entry.cleanup?.()
    } else if (entry.kind === 'bodyDialog') {
      entry.overlay?.discard?.()
    }
  }
}

function removeActiveShellModal() {
  if (!activeModalRoot) return
  activeModalRoot.remove()
  activeModalRoot = null
}

function removeOrphanShellModals() {
  if (typeof document === 'undefined') return
  document.querySelectorAll('.wiki-modal-root').forEach(el => {
    if (el.dataset.wikiSuspended === 'true') return
    el.remove()
  })
}

// Tear down any full-viewport modal shell left behind (e.g. gate auto-advance on a ghost
// page preview) so it cannot intercept clicks on the leaderboard toolbar.
export function clearViewportBlockingModals() {
  closeActiveModal({ discardSuspended: true, restoreMount: false })
  if (typeof document === 'undefined') return
  document.querySelectorAll('.wiki-modal-root').forEach(root => {
    if (root.dataset.wikiSuspended === 'true') return
    const fixed = typeof getComputedStyle !== 'undefined' && getComputedStyle(root).position === 'fixed'
    if (fixed) root.remove()
  })
  document.body?.classList.remove('wiki-modal-open')
}

function closeModalDismiss(onDismiss) {
  closeActiveModal({ resumeSuspended: suspendedStack.length > 0 })
  onDismiss?.()
}

function closeModalConfirm(callback, { restoreMount = true } = {}, ...args) {
  const hadSuspended = suspendedStack.length > 0
  closeActiveModal({
    discardSuspended: hadSuspended,
    restoreMount: restoreMount && !hadSuspended,
  })
  callback?.(...args)
}

export function closeActiveModal({ restoreMount = true, resumeSuspended = false, discardSuspended = false } = {}) {
  removeActiveShellModal()
  removeOrphanShellModals()
  if (typeof document !== 'undefined') {
    if (activeModalKeyHandler) {
      document.removeEventListener('keydown', activeModalKeyHandler)
      activeModalKeyHandler = null
    }
  }
  const cleanup = activeModalCleanup
  activeModalCleanup = null

  if (discardSuspended) discardAllSuspended()

  if (resumeSuspended && resumeOneSuspended()) {
    cleanup?.()
    activeModalCleanup?.()
    refitPwaModalWindowAfterResume()
    return
  }

  cleanup?.()
  if (typeof document !== 'undefined' && !suspendedStack.length) {
    document.body?.classList.remove('wiki-modal-open')
    endPwaModalWindowForShell()
  }
  if (restoreMount) runMountRestore()
}

function isWikiEmbeddedDocument() {
  return typeof document !== 'undefined' && document.body?.classList?.contains('wiki-embedded')
}

function createModalShell({
  ariaLabel = '',
  mount = document.body,
  embedded = false,
  boardOverlay = false,
  onDismiss = null,
  onEnter = null,
  onLayoutChange = null,
} = {}) {
  // Stacking (e.g. paste-confirm over a seat-claim dialog): suspend the prior dialog
  // so Cancel on the new one can restore it in the same state.
  suspendForStacking()

  // In the wiki iframe a fixed full-viewport overlay is clipped and blocks every
  // control beneath it (toolbar, footer edit bar) until the crawl finishes.
  // Board overlays are the exception: they mount inside .chess-console-board-wrap.
  if (isWikiEmbeddedDocument() && !boardOverlay) embedded = true

  const mountEl = mount || document.body
  // Shell paste mounts inside `.wiki-plugin-chess` on the parent wiki — never lock
  // wiki-page scroll or paint a viewport overlay outside the item.
  const hostContained = Boolean(mountEl?.classList?.contains('wiki-plugin-chess'))

  const root = document.createElement('div')
  const rootClasses = ['wiki-modal-root']
  if (embedded || hostContained) rootClasses.push('wiki-modal-embedded')
  if (boardOverlay) rootClasses.push('wiki-modal-board-overlay')
  root.className = rootClasses.join(' ')
  root.innerHTML = `<div class="wiki-modal-backdrop" data-dismiss="true"></div>`

  const panel = document.createElement('div')
  panel.className = 'wiki-modal-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  if (ariaLabel) panel.setAttribute('aria-label', ariaLabel)

  const body = document.createElement('div')
  body.className = 'wiki-modal-body'

  const footer = document.createElement('div')
  footer.className = 'wiki-modal-footer'

  panel.append(body, footer)
  root.append(panel)
  mountEl.append(root)
  if (!hostContained) {
    document.body.classList.add('wiki-modal-open')
  }
  activeModalRoot = root
  activeModalCleanup = onLayoutChange || null
  beginPwaModalWindowForShell(panel, { embedded: embedded || hostContained, boardOverlay })

  const dismiss = () => closeModalDismiss(onDismiss)
  root.addEventListener('click', event => {
    if (event.target?.dataset?.dismiss === 'true') dismiss()
  })

  const onKey = event => {
    if (event.key === 'Escape') {
      dismiss()
    } else if (onEnter && event.key === 'Enter') {
      event.preventDefault()
      onEnter()
    }
  }
  document.addEventListener('keydown', onKey)
  activeModalKeyHandler = onKey

  // NOTE: onLayoutChange is registered as the teardown re-measure hook above, but is
  // NOT fired here — the body/footer are still empty at this point. The caller fires it
  // once it has populated the modal (so an embedded host iframe measures the real
  // height, not an empty shell).
  return { root, panel, body, footer }
}

// # Confirm and Paste Modals

export function openPasteConfirmModal(
  payload,
  {
    onApply,
    onCreateNew,
    onCancel,
    canPersist = true,
    persistLabel,
    applyLabel,
    createNewLabel,
    canCreateNew = false,
    canReplaceCurrent = true,
    unchanged = false,
    unchangedMessage,
    mount,
    embedded,
    onLayoutChange,
  } = {},
) {
  if (!payload) return
  if (!payload.actionable && !unchanged) return
  const dismiss = () => closeModalDismiss(onCancel)
  const { body, footer } = createModalShell({
    ariaLabel: 'Confirm paste',
    mount,
    embedded,
    onLayoutChange,
    onDismiss: onCancel,
  })

  const message = document.createElement('p')
  message.className = 'wiki-modal-message'
  message.textContent = unchanged
    ? unchangedMessage || 'That is already loaded here — nothing will change.'
    : payload.message
  body.append(message)

  // Surfaces that can't save (offline PWA / read-only) get a heads-up line — but
  // not when nothing will change anyway.
  if (!unchanged && !canPersist && payload.actionable) {
    const offline = document.createElement('p')
    offline.className = 'wiki-modal-offline'
    offline.textContent = persistLabel || 'This will update the board in this window only (not saved to a wiki page).'
    body.append(offline)
  }

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  // No-op paste only needs to be acknowledged, so the lone button reads "OK".
  cancelBtn.className = unchanged ? 'btn btn-primary' : 'btn btn-outline-secondary'
  cancelBtn.textContent = unchanged ? 'OK' : 'Cancel'
  cancelBtn.addEventListener('click', dismiss)
  footer.append(cancelBtn)

  // Only offer "apply" when the paste is real chess data we can load, it differs from
  // what's already here, and this item type allows replacement (not SURVEY).
  let applyBtn = null
  if (!unchanged && canReplaceCurrent && payload.actionable && payload.itemText) {
    applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'btn btn-primary'
    applyBtn.textContent = applyLabel || (canPersist ? 'Replace in this item' : 'Load in this item')
    applyBtn.addEventListener('click', () => {
      closeActiveModal({ discardSuspended: true, restoreMount: false })
      // Stash the last applied paste so the receiving runtime can pick it up if needed.
      if (typeof globalThis !== 'undefined') {
        globalThis._wikiChessLastPaste = payload
      }
      onApply?.(payload)
    })
    footer.append(applyBtn)
  }

  let createNewBtn = null
  if (!unchanged && canCreateNew && onCreateNew && payload.actionable && payload.itemText) {
    createNewBtn = document.createElement('button')
    createNewBtn.type = 'button'
    createNewBtn.className = canReplaceCurrent ? 'btn btn-outline-primary' : 'btn btn-primary'
    createNewBtn.textContent = createNewLabel || 'Create new page'
    createNewBtn.addEventListener('click', () => {
      // Restore hidden in-flow page content (e.g. the SURVEY view) — we are not
      // replacing the current item, only spawning a forkable ghost elsewhere.
      closeActiveModal({ discardSuspended: true, restoreMount: true })
      onCreateNew(payload)
    })
    footer.insertBefore(createNewBtn, applyBtn)
  }

  // Focus the primary action when present, otherwise the only button (Cancel).
  // `preventScroll` so focusing never scrolls the host page (the plugin runs in the
  // wiki iframe, where a focus-scroll would jump the parent page to the item).
  ;(applyBtn || createNewBtn || cancelBtn).focus({ preventScroll: true })
  // Body/footer are populated — let an embedded host iframe measure the real height.
  onLayoutChange?.()
}

export const CANCEL_OPEN_CHALLENGE_CONFIRM = {
  title: 'Cancel open challenge?',
  message:
    'This removes your challenge from the survey and federation browser. The board stays open for a casual game.',
  confirmLabel: 'Cancel challenge',
  cancelLabel: 'Keep challenge',
  confirmClass: 'btn-danger',
}

export function openConfirmModal({
  title = 'Are you sure?',
  message = '',
  notes = [],
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmClass = 'btn-primary',
  altActions = [],
  footerNowrap = false,
  checkboxLabel = null,
  checkboxChecked = false,
  mount,
  embedded,
  boardOverlay,
  onLayoutChange,
  onConfirm,
  onCancel,
} = {}) {
  const { body, footer } = createModalShell({
    ariaLabel: title,
    mount,
    embedded,
    boardOverlay,
    onLayoutChange,
    onDismiss: onCancel,
  })
  if (footerNowrap) footer.classList.add('wiki-modal-footer-nowrap')

  if (title) {
    const heading = document.createElement('h2')
    heading.className = 'h5 wiki-chess-gate-title'
    heading.textContent = title
    body.append(heading)
  }
  if (message) {
    const lead = document.createElement('p')
    lead.className = 'wiki-modal-message'
    lead.textContent = message
    body.append(lead)
  }
  notes.forEach(note => {
    const box = document.createElement('p')
    box.className = 'wiki-modal-offline'
    box.textContent = note
    body.append(box)
  })

  let checkbox = null
  if (checkboxLabel) {
    const checkRow = document.createElement('div')
    checkRow.className = 'form-check mb-0 mt-2'
    checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'form-check-input'
    checkbox.id = 'wikiModalConfirmCheckbox'
    checkbox.checked = Boolean(checkboxChecked)
    const checkLabel = document.createElement('label')
    checkLabel.className = 'form-check-label'
    checkLabel.htmlFor = 'wikiModalConfirmCheckbox'
    checkLabel.textContent = checkboxLabel
    checkRow.append(checkbox, checkLabel)
    body.append(checkRow)
  }

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = `btn ${confirmClass}`
  confirmBtn.textContent = confirmLabel
  confirmBtn.addEventListener('click', () => {
    if (checkbox) {
      closeModalConfirm(onConfirm, {}, { checkboxChecked: checkbox.checked })
    } else {
      closeModalConfirm(onConfirm)
    }
  })

  footer.append(cancelBtn)
  altActions.forEach(({ label, className = 'btn-outline-primary', title, onClick }) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `btn ${className}`
    btn.textContent = label
    if (title) btn.title = title
    btn.addEventListener('click', () => closeModalConfirm(onClick))
    footer.append(btn)
  })
  footer.append(confirmBtn)
  cancelBtn.focus({ preventScroll: true })
  // Body/footer are now populated, so let an embedded host iframe measure the real
  // height (createModalShell deliberately leaves this for the caller to fire).
  onLayoutChange?.()
}

// Offline puzzle download — full archive or a filter-scoped CSV export.
export function openLocalPuzzleDownloadModal({
  title = 'Download puzzles for offline play?',
  message = '',
  notes = [],
  fullLabel = 'Download full database',
  filteredLabel = null,
  cancelLabel = 'Cancel',
  mount,
  embedded,
  boardOverlay,
  onLayoutChange,
  onDownloadFull,
  onDownloadFiltered,
  onCancel,
} = {}) {
  const { body, footer } = createModalShell({
    ariaLabel: title,
    mount,
    embedded,
    boardOverlay,
    onLayoutChange,
    onDismiss: onCancel,
  })

  if (title) {
    const heading = document.createElement('h2')
    heading.className = 'h5 wiki-chess-gate-title'
    heading.textContent = title
    body.append(heading)
  }
  if (message) {
    const lead = document.createElement('p')
    lead.className = 'wiki-modal-message'
    lead.textContent = message
    body.append(lead)
  }
  notes.forEach(note => {
    const box = document.createElement('p')
    box.className = 'wiki-modal-offline'
    box.textContent = note
    body.append(box)
  })

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  footer.append(cancelBtn)

  if (filteredLabel && typeof onDownloadFiltered === 'function') {
    const filteredBtn = document.createElement('button')
    filteredBtn.type = 'button'
    filteredBtn.className = 'btn btn-outline-primary'
    filteredBtn.textContent = filteredLabel
    filteredBtn.addEventListener('click', () => closeModalConfirm(onDownloadFiltered))
    footer.append(filteredBtn)
  }

  const fullBtn = document.createElement('button')
  fullBtn.type = 'button'
  fullBtn.className = 'btn btn-primary'
  fullBtn.textContent = fullLabel
  fullBtn.addEventListener('click', () => closeModalConfirm(onDownloadFull))
  footer.append(fullBtn)
  ;(filteredLabel ? footer.querySelector('.btn-outline-primary') : fullBtn)?.focus({
    preventScroll: true,
  })
  onLayoutChange?.()
}

// # Challenge and Seat Modals

export function openChallengePublishConfirmModal({
  confirmLabel,
  cancelLabel = 'Cancel',
  directed = false,
  challengeTarget = '',
  mount,
  embedded,
  onConfirm,
  onCancel,
  onLayoutChange,
} = {}) {
  const target = String(challengeTarget || '').trim()
  const isDirected = Boolean(directed && target)
  const { body, footer } = createModalShell({
    ariaLabel: isDirected ? 'Post challenge' : 'Post open challenge',
    mount,
    embedded,
    onLayoutChange,
    onDismiss: onCancel,
  })

  const title = document.createElement('h2')
  title.className = 'h5 wiki-chess-gate-title'
  title.textContent = isDirected ? 'Post challenge?' : 'Post open challenge?'
  body.append(title)

  const message = document.createElement('p')
  message.className = 'wiki-modal-message'
  message.textContent = isDirected
    ? `This creates a challenge for ${target}. They fork the page on that wiki and accept to sit down. A game page is created when they accept.`
    : 'This posts an open challenge listed in the federation browser until someone sits down. A game page is created when an opponent accepts.'
  body.append(message)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-primary'
  confirmBtn.textContent = confirmLabel || (isDirected ? 'Post Challenge' : 'Post Open Challenge')
  confirmBtn.addEventListener('click', () => {
    closeModalConfirm(onConfirm, {}, {})
  })

  footer.append(cancelBtn, confirmBtn)
  confirmBtn.focus({ preventScroll: true })
  onLayoutChange?.()
}

export function openEndRealtimeModal({
  title = 'End real-time play?',
  message = 'Moves will still sync through the wiki, but may take a moment longer without the live link.',
  keepAutoForkLabel = 'Keep auto-forking moves via the wiki',
  confirmLabel = 'End real-time',
  cancelLabel = 'Keep playing',
  mount,
  embedded,
  boardOverlay,
  onLayoutChange,
  onConfirm,
  onCancel,
} = {}) {
  const { body, footer } = createModalShell({
    ariaLabel: title,
    mount,
    embedded,
    boardOverlay,
    onLayoutChange,
    onDismiss: onCancel,
  })

  const heading = document.createElement('h2')
  heading.className = 'h5 wiki-chess-gate-title'
  heading.textContent = title
  body.append(heading)

  const lead = document.createElement('p')
  lead.className = 'wiki-modal-message'
  lead.textContent = message
  body.append(lead)

  const checkLabel = document.createElement('label')
  checkLabel.className = 'wiki-modal-seek-open-page'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  // Checked = keep auto-fork on after ending the live link (default).
  checkbox.checked = true
  checkLabel.append(checkbox, document.createTextNode(` ${keepAutoForkLabel}`))
  body.append(checkLabel)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-danger'
  confirmBtn.textContent = confirmLabel
  confirmBtn.addEventListener('click', () => {
    closeModalConfirm(onConfirm, {}, { keepAutoFork: checkbox.checked })
  })

  footer.append(cancelBtn, confirmBtn)
  confirmBtn.focus({ preventScroll: true })
  onLayoutChange?.()
}

export function openChallengeEditModal({
  title = '',
  rated = false,
  creatorColor = 'random',
  minRating = null,
  maxRating = null,
  confirmLabel = 'Save challenge',
  cancelLabel = 'Close',
  cancelChallengeLabel = 'Cancel challenge',
  mount,
  embedded,
  onSave,
  onCancel,
  onCancelChallenge,
  onLayoutChange,
} = {}) {
  const submit = () => {
    closeModalConfirm(() =>
      onSave?.({
        rated: ratedSelect.value === 'rated',
        creatorColor: colorSelect.value || 'random',
        minRating: minInput.value ?? '',
        maxRating: maxInput.value ?? '',
      }),
    )
  }
  const { body, footer } = createModalShell({
    ariaLabel: title || 'Edit open challenge',
    mount,
    embedded,
    onDismiss: onCancel,
    onEnter: submit,
    onLayoutChange,
  })

  if (title) {
    const heading = document.createElement('h2')
    heading.className = 'h5 wiki-chess-gate-title'
    heading.textContent = title
    body.append(heading)
  }

  const lead = document.createElement('p')
  lead.className = 'wiki-modal-message'
  lead.textContent = onCancelChallenge
    ? 'Update the terms of this open challenge, or cancel it to remove it from your survey and the federation browser.'
    : 'Update the terms of this open challenge. Changes apply to anyone who joins from now on.'
  body.append(lead)

  const makeField = (labelText, control) => {
    const wrap = document.createElement('label')
    wrap.className = 'wiki-challenge-edit-field'
    const span = document.createElement('span')
    span.className = 'wiki-challenge-edit-label'
    span.textContent = labelText
    wrap.append(span, control)
    return wrap
  }

  const ratedSelect = document.createElement('select')
  ratedSelect.className = 'form-select'
  ratedSelect.innerHTML =
    '<option value="unrated">Unrated</option><option value="rated">Rated (affects Glicko-2 rating)</option>'
  ratedSelect.value = rated ? 'rated' : 'unrated'

  const colorSelect = document.createElement('select')
  colorSelect.className = 'form-select'
  colorSelect.innerHTML =
    '<option value="random">Random</option><option value="white">White</option><option value="black">Black</option>'
  colorSelect.value = ['random', 'white', 'black'].includes(creatorColor) ? creatorColor : 'random'

  const minInput = document.createElement('input')
  minInput.type = 'number'
  minInput.inputMode = 'numeric'
  minInput.className = 'form-control'
  minInput.placeholder = 'any'
  minInput.min = '0'
  minInput.max = '3500'
  minInput.step = '50'
  minInput.autocomplete = 'off'
  if (minRating != null) minInput.value = String(minRating)

  const maxInput = document.createElement('input')
  maxInput.type = 'number'
  maxInput.inputMode = 'numeric'
  maxInput.className = 'form-control'
  maxInput.placeholder = 'any'
  maxInput.min = '0'
  maxInput.max = '3500'
  maxInput.step = '50'
  maxInput.autocomplete = 'off'
  if (maxRating != null) maxInput.value = String(maxRating)

  const ratingRow = document.createElement('div')
  ratingRow.className = 'wiki-challenge-edit-rating-row'
  ratingRow.append(makeField('Min rating', minInput), makeField('Max rating', maxInput))

  const hint = document.createElement('p')
  hint.className = 'wiki-modal-offline'
  hint.textContent =
    'Leave a rating blank for no limit. Opponents outside the range can view the game but can\u2019t join.'

  body.append(makeField('Game format', ratedSelect), makeField('Your color', colorSelect), ratingRow, hint)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-primary'
  confirmBtn.textContent = confirmLabel
  confirmBtn.addEventListener('click', submit)

  if (onCancelChallenge) {
    const withdrawBtn = document.createElement('button')
    withdrawBtn.type = 'button'
    withdrawBtn.className = 'btn btn-outline-danger me-auto'
    withdrawBtn.textContent = cancelChallengeLabel
    withdrawBtn.addEventListener('click', () =>
      openConfirmModal({
        ...CANCEL_OPEN_CHALLENGE_CONFIRM,
        mount,
        embedded,
        onLayoutChange,
        onConfirm: () => closeModalConfirm(onCancelChallenge),
      }),
    )
    footer.append(withdrawBtn, cancelBtn, confirmBtn)
  } else {
    footer.append(cancelBtn, confirmBtn)
  }
  confirmBtn.focus({ preventScroll: true })
  onLayoutChange?.()
}

export function openOpenSeatModal({
  seat,
  canClaim = false,
  currentSite = '',
  mount,
  embedded,
  onClaim,
  onInvite,
  onCancel,
} = {}) {
  if (seat !== 'White' && seat !== 'Black') return

  const seatWord = seat === 'White' ? 'White' : 'Black'

  const submitInvite = () => {
    const value = siteInput.value.trim()
    if (!value) {
      siteInput.focus({ preventScroll: true })
      return
    }
    if (onInvite?.(value) === false) {
      siteInput.focus({ preventScroll: true })
      return
    }
    closeModalConfirm()
  }

  const { body, footer } = createModalShell({
    ariaLabel: `Open ${seatWord} Seat`,
    mount,
    embedded,
    onDismiss: onCancel,
    onEnter: submitInvite,
  })

  const title = document.createElement('h2')
  title.className = 'h5 wiki-chess-gate-title'
  title.textContent = `Open ${seatWord} Seat`
  body.append(title)

  if (canClaim) {
    const claimBlock = document.createElement('div')
    claimBlock.className = 'mb-3'
    const hint = document.createElement('p')
    hint.className = 'text-muted mb-2'
    hint.textContent = 'Sit down and play this seat yourself.'
    const claimBtn = document.createElement('button')
    claimBtn.type = 'button'
    claimBtn.className = 'btn btn-primary w-100 wiki-chess-action-btn'
    claimBtn.innerHTML = `<i class="fas fa-chess-pawn fa-fw" aria-hidden="true"></i> Play as ${seatWord}`
    claimBtn.addEventListener('click', () => closeModalConfirm(onClaim))
    claimBlock.append(hint, claimBtn)
    body.append(claimBlock)

    const divider = document.createElement('div')
    divider.className = 'wiki-open-seat-divider'
    divider.innerHTML = '<span>or</span>'
    body.append(divider)
  }

  const inviteBlock = document.createElement('div')
  inviteBlock.className = 'mb-1'

  const label = document.createElement('label')
  label.className = 'form-label fw-semibold'
  label.setAttribute('for', 'wiki-open-seat-host')
  label.textContent = 'Invite a wiki to play'

  const siteInput = document.createElement('input')
  siteInput.type = 'text'
  siteInput.id = 'wiki-open-seat-host'
  siteInput.className = 'form-control'
  siteInput.placeholder = 'username.example.co'
  siteInput.autocomplete = 'off'
  siteInput.spellcheck = false
  siteInput.value = currentSite

  const formText = document.createElement('div')
  formText.className = 'form-text'
  formText.innerHTML = 'They accept by forking this page on their wiki and clicking <em>Accept challenge</em>.'

  inviteBlock.append(label, siteInput, formText)
  body.append(inviteBlock)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const inviteBtn = document.createElement('button')
  inviteBtn.type = 'button'
  inviteBtn.className = 'btn btn-primary'
  inviteBtn.textContent = 'Send Invite'
  inviteBtn.addEventListener('click', submitInvite)

  footer.append(cancelBtn, inviteBtn)

  window.requestAnimationFrame(() => {
    const claimBtn = body.querySelector('.wiki-chess-action-btn')
    if (canClaim && claimBtn instanceof HTMLElement) claimBtn.focus({ preventScroll: true })
    else siteInput.focus({ preventScroll: true })
  })
}

export function openCommentModal({
  moveLabel = '',
  annotatorName = '',
  existing = '',
  placeholder = 'Write a note about this move…',
  confirmLabel = 'Save comment',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
} = {}) {
  const { body, footer } = createModalShell({ ariaLabel: 'Add a comment', onDismiss: onCancel })

  const lead = document.createElement('p')
  lead.className = 'wiki-modal-message'
  lead.textContent = moveLabel ? `Comment on ${moveLabel}` : 'Comment on this move'
  body.append(lead)

  if (existing) {
    const prior = document.createElement('p')
    prior.className = 'wiki-modal-offline wiki-comment-modal-existing'
    prior.textContent = existing
    body.append(prior)
  }

  const label = document.createElement('label')
  label.className = 'wiki-comment-modal-label'
  label.textContent = annotatorName ? `Commenting as ${annotatorName}` : 'Your comment'
  const textarea = document.createElement('textarea')
  textarea.className = 'wiki-comment-modal-input form-control'
  textarea.rows = 3
  textarea.placeholder = placeholder
  label.setAttribute('for', 'wiki-comment-modal-input')
  textarea.id = 'wiki-comment-modal-input'
  body.append(label, textarea)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-primary'
  confirmBtn.textContent = confirmLabel
  const submit = () => {
    const value = textarea.value.trim()
    if (!value) {
      textarea.focus({ preventScroll: true })
      return
    }
    closeModalConfirm(() => onSubmit?.(value))
  }
  confirmBtn.addEventListener('click', submit)

  // Ctrl/Cmd+Enter saves; plain Enter stays a newline in the textarea (so this is
  // scoped to the textarea, not the shell's document-level Enter handler).
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  })

  footer.append(cancelBtn, confirmBtn)
  textarea.focus({ preventScroll: true })
}

// # Puzzle and Leaderboard Modals

export function openPuzzleFilterModal({
  title = 'Choose puzzles',
  intro = 'Pick the range of puzzles to draw from.',
  ranges = [],
  themes = null,
  confirmLabel = 'Play puzzles',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
  onFilterCount = null,
  // Embedded in the wiki iframe: mount the dialog in-flow (inside `mount`) so the
  // iframe grows to fit it instead of clipping a fixed overlay against the short
  // viewport. `onLayoutChange` lets the caller re-report the iframe height.
  mount = document.body,
  embedded = false,
  onLayoutChange = null,
} = {}) {
  const submit = () => {
    const values = {}
    for (const ctl of controls) values[ctl.key] = ctl.value
    if (themePicker) values.themes = themePicker.value
    closeModalConfirm(() => onSubmit?.(values))
  }
  const { body, footer } = createModalShell({
    ariaLabel: title,
    mount,
    embedded,
    onDismiss: onCancel,
    onEnter: submit,
    onLayoutChange,
  })

  if (intro) {
    const lead = document.createElement('p')
    lead.className = 'wiki-modal-message'
    lead.textContent = intro
    body.append(lead)
  }

  const controls = ranges.map(spec => {
    const min = Number(spec.min)
    const max = Number(spec.max)
    const step = Number(spec.step) || 1
    const fmt = typeof spec.format === 'function' ? spec.format : v => String(v)

    const group = document.createElement('div')
    group.className = 'wiki-puzzle-filter-range'

    const head = document.createElement('div')
    head.className = 'wiki-puzzle-filter-head'
    const name = document.createElement('span')
    name.className = 'wiki-puzzle-filter-label'
    name.textContent = spec.label
    const readout = document.createElement('span')
    readout.className = 'wiki-puzzle-filter-readout'
    head.append(name, readout)

    const makeSlider = value => {
      const input = document.createElement('input')
      input.type = 'range'
      input.className = 'wiki-puzzle-filter-slider form-range'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(Math.min(max, Math.max(min, Number(value))))
      return input
    }
    const lowInput = makeSlider(spec.low != null ? spec.low : min)
    const highInput = makeSlider(spec.high != null ? spec.high : max)

    const sync = () => {
      readout.textContent = `${fmt(Number(lowInput.value))} – ${fmt(Number(highInput.value))}`
    }
    // Keep the thumbs from crossing: push the other thumb when one passes it.
    lowInput.addEventListener('input', () => {
      if (Number(lowInput.value) > Number(highInput.value)) highInput.value = lowInput.value
      sync()
      notifyFilterChange()
    })
    highInput.addEventListener('input', () => {
      if (Number(highInput.value) < Number(lowInput.value)) lowInput.value = highInput.value
      sync()
      notifyFilterChange()
    })
    sync()

    group.append(head, lowInput, highInput)
    body.append(group)
    return {
      key: spec.key,
      get value() {
        const a = Number(lowInput.value)
        const b = Number(highInput.value)
        return { low: Math.min(a, b), high: Math.max(a, b) }
      },
    }
  })

  let themePicker = null
  let countEl = null
  let countSeq = 0

  const readFilterValues = () => {
    const values = {}
    for (const ctl of controls) values[ctl.key] = ctl.value
    if (themePicker) values.themes = themePicker.value
    return values
  }

  const refreshFilterCount = () => {
    if (!onFilterCount || !countEl) return
    const values = readFilterValues()
    const seq = ++countSeq
    countEl.textContent = 'Counting matching puzzles…'
    Promise.resolve(onFilterCount(values))
      .then(msg => {
        if (seq === countSeq) countEl.textContent = msg || ''
      })
      .catch(() => {
        if (seq === countSeq) countEl.textContent = 'Could not estimate puzzle count.'
      })
  }

  const notifyFilterChange = () => {
    refreshFilterCount()
    onLayoutChange?.()
  }

  if (onFilterCount) {
    countEl = document.createElement('p')
    countEl.className = 'wiki-puzzle-filter-count text-muted small mb-0'
    countEl.setAttribute('role', 'status')
  }

  if (themes && Array.isArray(themes.options) && themes.options.length) {
    themePicker = buildPuzzleThemePicker({
      body,
      selected: themes.selected,
      options: themes.options,
      commonIds: themes.common,
      onLayoutChange: notifyFilterChange,
      onChange: notifyFilterChange,
    })
  }

  if (countEl) {
    body.append(countEl)
    refreshFilterCount()
  }

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = cancelLabel
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-primary'
  confirmBtn.textContent = confirmLabel
  confirmBtn.addEventListener('click', submit)

  footer.append(cancelBtn, confirmBtn)
  // Modal is fully populated now — let an embedded host iframe grow to the real height.
  onLayoutChange?.()
  // `preventScroll` so auto-focusing the primary button never scrolls the host page —
  // this dialog renders in-flow inside the wiki item, and an embedded "PUZZLE" item
  // opens it on every reload, which would otherwise jump the page to this button.
  confirmBtn.focus({ preventScroll: true })
}

function buildPuzzleThemePicker({ body, selected = [], options = [], commonIds = [], onLayoutChange, onChange }) {
  const optionById = new Map(options.map(opt => [opt.id, opt]))
  const chosen = new Set(
    (Array.isArray(selected) ? selected : []).map(id => optionById.get(id)?.id || id).filter(id => optionById.has(id)),
  )

  const group = document.createElement('div')
  group.className = 'wiki-puzzle-filter-themes'

  const head = document.createElement('div')
  head.className = 'wiki-puzzle-filter-head'
  const name = document.createElement('span')
  name.className = 'wiki-puzzle-filter-label'
  name.textContent = 'Themes'
  const readout = document.createElement('span')
  readout.className = 'wiki-puzzle-filter-readout'
  head.append(name, readout)

  const selectedWrap = document.createElement('div')
  selectedWrap.className = 'wiki-puzzle-theme-selected'
  selectedWrap.hidden = true

  const inputWrap = document.createElement('div')
  inputWrap.className = 'wiki-puzzle-theme-input-wrap'
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'form-control form-control-sm wiki-puzzle-theme-input'
  input.placeholder = 'Type to search themes…'
  input.autocomplete = 'off'
  input.setAttribute('aria-label', 'Search puzzle themes')
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', 'wiki-puzzle-theme-suggestions')
  input.id = 'wiki-puzzle-theme-input'
  inputWrap.append(input)

  const suggestions = document.createElement('div')
  suggestions.className = 'wiki-puzzle-theme-suggestions'
  suggestions.id = 'wiki-puzzle-theme-suggestions'
  suggestions.hidden = true
  suggestions.setAttribute('role', 'listbox')
  suggestions.setAttribute('aria-label', 'Matching puzzle themes')

  const quickWrap = document.createElement('div')
  quickWrap.className = 'wiki-puzzle-theme-quick'
  const quickLabel = document.createElement('div')
  quickLabel.className = 'wiki-puzzle-theme-quick-label'
  quickLabel.textContent = 'Common'
  const quickBadges = document.createElement('div')
  quickBadges.className = 'wiki-puzzle-theme-badges'
  quickWrap.append(quickLabel, quickBadges)

  const syncReadout = () => {
    readout.textContent = chosen.size ? `${chosen.size} selected` : 'Any'
    selectedWrap.hidden = chosen.size === 0
  }

  const makeBadge = (opt, { selected: isSelected = false, onPick } = {}) => {
    const badge = document.createElement('button')
    badge.type = 'button'
    badge.className = `wiki-puzzle-theme-badge${isSelected ? ' is-selected' : ''}`
    badge.textContent = opt.label
    badge.title = isSelected ? `Remove ${opt.label}` : `Add ${opt.label}`
    badge.setAttribute('role', 'option')
    badge.setAttribute('aria-selected', isSelected ? 'true' : 'false')
    badge.addEventListener('mousedown', e => e.preventDefault())
    badge.addEventListener('click', () => onPick?.(opt.id))
    return badge
  }

  const renderSelected = () => {
    selectedWrap.replaceChildren()
    for (const id of [...chosen].sort((a, b) => {
      const la = optionById.get(a)?.label || a
      const lb = optionById.get(b)?.label || b
      return la.localeCompare(lb)
    })) {
      const opt = optionById.get(id) || { id, label: id }
      selectedWrap.append(
        makeBadge(opt, {
          selected: true,
          onPick: themeId => {
            chosen.delete(themeId)
            renderSelected()
            renderQuick()
            refreshSuggestions()
            syncReadout()
            onLayoutChange?.()
            onChange?.()
          },
        }),
      )
    }
  }

  const addTheme = id => {
    if (!id || !optionById.has(id) || chosen.has(id)) return
    chosen.add(id)
    input.value = ''
    suggestions.hidden = true
    input.setAttribute('aria-expanded', 'false')
    renderSelected()
    renderQuick()
    refreshSuggestions()
    syncReadout()
    onLayoutChange?.()
    onChange?.()
  }

  const renderQuick = () => {
    quickBadges.replaceChildren()
    const ids = Array.isArray(commonIds) && commonIds.length ? commonIds : options.slice(0, 18).map(opt => opt.id)
    for (const id of ids) {
      if (chosen.has(id)) continue
      const opt = optionById.get(id)
      if (!opt) continue
      quickBadges.append(makeBadge(opt, { onPick: addTheme }))
    }
    quickWrap.hidden = !quickBadges.childElementCount
  }

  const refreshSuggestions = () => {
    const q = input.value.trim().toLowerCase()
    suggestions.replaceChildren()
    if (!q) {
      suggestions.hidden = true
      input.setAttribute('aria-expanded', 'false')
      return
    }
    const matches = options
      .filter(opt => !chosen.has(opt.id) && (opt.id.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q)))
      .slice(0, 14)
    if (!matches.length) {
      suggestions.hidden = true
      input.setAttribute('aria-expanded', 'false')
      return
    }
    const list = document.createElement('div')
    list.className = 'wiki-puzzle-theme-badges wiki-puzzle-theme-badges-suggest'
    for (const opt of matches) list.append(makeBadge(opt, { onPick: addTheme }))
    suggestions.append(list)
    suggestions.hidden = false
    input.setAttribute('aria-expanded', 'true')
    onLayoutChange?.()
  }

  let blurTimer = null
  input.addEventListener('input', refreshSuggestions)
  input.addEventListener('focus', () => {
    clearTimeout(blurTimer)
    refreshSuggestions()
  })
  input.addEventListener('blur', () => {
    blurTimer = setTimeout(() => {
      suggestions.hidden = true
      input.setAttribute('aria-expanded', 'false')
    }, 150)
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const q = input.value.trim().toLowerCase()
      const exact = options.find(
        opt => !chosen.has(opt.id) && (opt.id.toLowerCase() === q || opt.label.toLowerCase() === q),
      )
      const first = suggestions.querySelector('.wiki-puzzle-theme-badge:not(.is-selected)')
      if (exact) addTheme(exact.id)
      else if (first) first.click()
    } else if (e.key === 'Escape') {
      input.value = ''
      suggestions.hidden = true
      input.setAttribute('aria-expanded', 'false')
    }
  })

  group.append(head, selectedWrap, inputWrap, suggestions, quickWrap)
  body.append(group)
  renderSelected()
  renderQuick()
  syncReadout()

  return {
    get value() {
      return [...chosen]
    },
  }
}

export function openPuzzleUnavailableModal({
  title = 'Could not load a puzzle',
  message = '',
  showEditFilters = false,
  showRetry = true,
  editFiltersLabel = 'Edit filters',
  retryLabel = 'Try again',
  dismissLabel = 'Close',
  mount = document.body,
  embedded = false,
  onEditFilters,
  onRetry,
  onDismiss,
  onLayoutChange = null,
} = {}) {
  const { body, footer } = createModalShell({
    ariaLabel: title,
    mount,
    embedded,
    onDismiss,
    onLayoutChange,
  })

  const heading = document.createElement('h2')
  heading.className = 'h5 wiki-chess-gate-title'
  heading.textContent = title
  body.append(heading)

  if (message) {
    const lead = document.createElement('p')
    lead.className = 'wiki-modal-message'
    lead.textContent = message
    body.append(lead)
  }

  const dismissBtn = document.createElement('button')
  dismissBtn.type = 'button'
  dismissBtn.className = 'btn btn-outline-secondary'
  dismissBtn.textContent = dismissLabel
  dismissBtn.addEventListener('click', () => closeModalDismiss(onDismiss))

  footer.append(dismissBtn)

  if (showEditFilters) {
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'btn btn-outline-primary'
    editBtn.textContent = editFiltersLabel
    editBtn.addEventListener('click', () => closeModalConfirm(onEditFilters))
    footer.append(editBtn)
  }

  if (showRetry) {
    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'btn btn-primary'
    retryBtn.textContent = retryLabel
    retryBtn.addEventListener('click', () => closeModalConfirm(onRetry))
    footer.append(retryBtn)
    retryBtn.focus({ preventScroll: true })
  } else {
    dismissBtn.classList.add('btn-primary')
    dismissBtn.focus({ preventScroll: true })
  }

  onLayoutChange?.()
}

// Confirm opting into a full federation Glicko audit (and publishing a new gossip checkpoint).
export function openFullFederationAuditConfirmModal({
  estimateSeconds = null,
  mount = document.body,
  embedded = false,
  onConfirm,
  onCancel,
  onLayoutChange = null,
} = {}) {
  const { body, footer } = createModalShell({
    ariaLabel: 'Confirm full federation audit',
    mount,
    embedded,
    onDismiss: onCancel,
    onEnter: () => closeModalConfirm(onConfirm),
    onLayoutChange,
  })

  const title = document.createElement('h2')
  title.className = 'h5 wiki-chess-gate-title'
  title.textContent = 'Full federation audit'
  body.append(title)

  const lead = document.createElement('p')
  lead.className = 'wiki-modal-message'
  lead.textContent =
    'This recomputes Glicko-2 ratings from scratch across reachable rated games and publishes a new checkpoint for peers to gossip. Soft Refresh still uses trusted checkpoints when you only need a quick update.'
  body.append(lead)

  const eta = document.createElement('p')
  eta.className = 'wiki-modal-offline'
  if (Number.isFinite(Number(estimateSeconds)) && estimateSeconds > 0) {
    const sec = Math.max(1, Math.round(Number(estimateSeconds)))
    eta.textContent =
      sec < 60
        ? `Last full audit took about ${sec}s. Keep this tab open while it runs — closing it cancels the worker.`
        : `Last full audit took about ${Math.round(sec / 60)} min. Keep this tab open while it runs — closing it cancels the worker.`
  } else {
    eta.textContent =
      'No prior timing yet. A seeded federation can take tens of seconds. Keep this tab open until it finishes.'
  }
  body.append(eta)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))
  footer.append(cancelBtn)

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-primary'
  confirmBtn.textContent = 'Start full audit'
  confirmBtn.addEventListener('click', () => closeModalConfirm(onConfirm))
  footer.append(confirmBtn)

  confirmBtn.focus({ preventScroll: true })
  onLayoutChange?.()
}

export function openLeaderboardGateModal({
  hasRatedGame = false,
  checkingStatus = false,
  mount = document.body,
  embedded = false,
  onView,
  onCancel,
  onLayoutChange,
} = {}) {
  const { body, footer } = createModalShell({
    ariaLabel: 'Chess leaderboards',
    mount,
    embedded,
    onDismiss: onCancel,
    onEnter: () => closeModalConfirm(onView),
    onLayoutChange,
  })

  const title = document.createElement('h2')
  title.className = 'h5 wiki-chess-gate-title'
  title.textContent = LEADERBOARD_PAGE_TITLE
  body.append(title)

  const intro = document.createElement('p')
  intro.className = 'wiki-modal-message'
  intro.textContent =
    'The leaderboard is a federated survey — no central server. Anyone can browse it. ' +
    'Playing a rated game opts your wiki in automatically; sites with no rated games never appear on the board.'
  body.append(intro)

  const list = document.createElement('div')
  list.className = 'wiki-chess-gate-reqs'

  list.append(
    gateRequirement({
      met: hasRatedGame,
      pending: checkingStatus,
      label: 'Play a rated game',
      detail: hasRatedGame
        ? 'Done — you have a published rated game on this wiki.'
        : checkingStatus
          ? 'Checking your site for rated games…'
          : 'Finish at least one rated cross-wiki game so you have a rating of your own.',
    }),
  )
  body.append(list)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn-outline-secondary'
  cancelBtn.textContent = 'Close'
  cancelBtn.addEventListener('click', () => closeModalDismiss(onCancel))
  footer.append(cancelBtn)

  const viewBtn = document.createElement('button')
  viewBtn.type = 'button'
  viewBtn.className = 'btn btn-success'
  viewBtn.textContent = 'View leaderboards'
  viewBtn.addEventListener('click', () => closeModalConfirm(onView))
  footer.append(viewBtn)

  viewBtn.focus({ preventScroll: true })
  onLayoutChange?.()
}

// One requirement row in the gate modal: a status glyph (met ✓ / pending ⟳ / open ○),
// a bold label, and an explanatory line.
function gateRequirement({ met = false, pending = false, label = '', detail = '' }) {
  const row = document.createElement('div')
  row.className = `wiki-chess-gate-req${met ? ' is-met' : ''}`

  const mark = document.createElement('span')
  mark.className = 'wiki-chess-gate-mark'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = met ? '✓' : pending ? '⟳' : '○'
  row.append(mark)

  const text = document.createElement('div')
  text.className = 'wiki-chess-gate-text'
  const strong = document.createElement('div')
  strong.className = 'wiki-chess-gate-label'
  strong.textContent = label
  const small = document.createElement('div')
  small.className = 'wiki-chess-gate-detail'
  small.textContent = detail
  text.append(strong, small)
  row.append(text)
  return row
}
