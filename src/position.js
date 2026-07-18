/**
 * POSITION mode — FEN editor board, save/flip, entry from CHOOSE.
 *
 * §1 Init & board lifecycle
 * §2 FEN input sync & live-edit guard
 * §3 Save / flip / mode entry
 *
 * Owns the FEN editor board build; start-game / start-from-position modal
 * lives in game.js. Wired from chess-app.js via initPosition().
 *
 * In-file landmarks use `// # Section Name` for navigation.
 */

import { FenEditor, MARKER_TYPE, ensurePieceSpriteCached } from './cm-modules-bundle.js'
import { normalizeFen, mergeItemTextIntoChessObj, buildCreatePreviewMeta, START_FEN } from './chess-core.js'
import { shellMessengerFromContext, fitPopupBoard } from './board-layout.js'

let app

function shellMessenger() {
  return shellMessengerFromContext(app)
}

export function initPosition(appContext) {
  app = appContext
}

function requireHost() {
  if (!app) throw new Error('initPosition must be called before using position APIs')
}

// # Init and Board Lifecycle

export function isPositionEditorMode() {
  const positionPage = document.getElementById('position')
  return Boolean(app?.fenEditor) && positionPage?.style.display !== 'none'
}

async function reloadFenEditorPieceSet() {
  requireHost()
  const fenEditor = app.fenEditor
  if (!fenEditor?.chessboard) return
  const fen = fenEditor.state.fen.toString()
  fenEditor.chessboard.destroy()
  fenEditor.props.piecesFile = app.getPieceSetFile()
  fenEditor.initChessboard()
  await fenEditor.chessboard.setPosition(fen, false)
  fenEditor.state.fen.parse(fen)
  // eslint-disable-next-line no-self-assign
  fenEditor.state.fen = fenEditor.state.fen
}

function fitPositionEditorBoard() {
  const board = app.fenEditor?.chessboard
  if (!board?.view) return
  const mount = document.querySelector('.wiki-fen-board')
  const boardEl = mount?.querySelector('.chessboard')
  if (app.isPopupLayout) {
    // Popup/PWA: fitPopupBoard publishes --wiki-chess-board-cap and pins max-width so
    // cm-chessboard handleResize() sees a height-aware width (square fits the viewport).
    if (mount) {
      mount.style.width = ''
      mount.style.maxWidth = ''
    }
    if (boardEl) {
      boardEl.style.width = ''
      boardEl.style.maxWidth = ''
    }
    fitPopupBoard()
    return
  }
  if (mount) {
    mount.style.width = '100%'
    mount.style.maxWidth = '100%'
  }
  if (boardEl) {
    boardEl.style.width = '100%'
    boardEl.style.maxWidth = '100%'
  }
  board.view.handleResize?.()
  if (app.isWikiEmbed) {
    window.requestAnimationFrame(() => board.view.handleResize?.())
  }
}

async function ensurePositionEditorBoard({ fen, keepLiveEdits = false } = {}) {
  requireHost()
  await ensurePieceSpriteCached(app.getPieceSpritesUrl())
  const mount = document.querySelector('.cm-fen-editor')
  if (!mount) {
    console.error('Position editor mount (.cm-fen-editor) not found')
    return
  }
  if (!app.fenEditor?.chessboard?.view) {
    if (app.fenEditor?.chessboard?.destroy) {
      try {
        app.fenEditor.chessboard.destroy()
      } catch {
        /* ignore stale board teardown */
      }
    }
    app.fenEditor = new FenEditor(mount, {
      fen: fen || START_FEN,
      boardTheme: 'green',
      assetsUrl: './assets/',
      piecesFile: app.getPieceSetFile(),
      markers: MARKER_TYPE.square,
      onFenChange: onPositionFenChange,
    })
  }
  if (keepLiveEdits) {
    wireFenInputSync()
    app.wirePositionEditor()
    updatePositionSaveButton()
    fitPositionEditorBoard()
    app.notifyWikiHeight()
    app.notifyPwaPlayLayoutReady()
    app.flushGhostChessItemSyncIfReady()
    return
  }
  app.fenEditor.state.fen.parse(fen || START_FEN)
  // eslint-disable-next-line no-self-assign
  app.fenEditor.state.fen = app.fenEditor.state.fen
  wireFenInputSync()
  app.wirePositionEditor()
  updatePositionSaveButton()
  fitPositionEditorBoard()
  app.notifyWikiHeight()
  app.notifyPwaPlayLayoutReady()
  app.flushGhostChessItemSyncIfReady()
}

// # FEN Input Sync and Live Edit Guard

// The wiki shell re-pushes SET_STATE while the iframe is open (GET_STATE retries,
// auth sync). chessState().FEN still reflects the last saved/keyword baseline until
// the user explicitly saves, so a blind re-parse would wipe in-progress edits.
export function shouldPreserveLivePositionEdits(incomingFen) {
  const fenEditor = app?.fenEditor
  if (!fenEditor?.state?.fen || !app.isActivePage('position')) return false
  const live = normalizeFen(fenEditor.state.fen.toString())
  const incoming = normalizeFen(incomingFen || START_FEN)
  return live !== incoming
}

// Editing the board in the FEN editor never writes to the wiki journal. The new
// position is only persisted when the user explicitly saves ("Save position to
// wiki") or carries it into another mode (e.g. "Start game from position"). We
// just keep the embedded iframe sized to the changing board/fields here.
function onPositionFenChange() {
  app.notifyWikiHeight()
}

// cm-fen-editor only listens for `change` (blur) on the FEN field, so a paste or
// edit never updates the board until the input loses focus. Wire input/paste so
// Ctrl+V and typing apply immediately.
function wireFenInputSync() {
  const fenInput = document.getElementById('fenInputOutput')
  if (!fenInput || fenInput._wikiFenInputWired) return
  fenInput._wikiFenInputWired = true

  const syncFromInput = () => {
    const fenEditor = app.fenEditor
    if (!fenEditor) return
    fenEditor.state.fen.parse(fenInput.value)
    // Reassigning the observable property notifies cm-web-modules observers.
    // eslint-disable-next-line no-self-assign
    fenEditor.state.fen = fenEditor.state.fen
  }

  fenInput.addEventListener('input', syncFromInput)
  fenInput.addEventListener('paste', () => {
    requestAnimationFrame(syncFromInput)
  })
}

// # Save Flip and Mode Entry

// After an explicit save, refresh the in-app "saved on wiki" baseline. The shell
// updates its own chessObj when the journal write completes but deliberately skips
// syncing back to this iframe (the save source), so without this the switch-mode
// guard would still think the board position is unsaved.
function markPositionSavedToItem() {
  const text = app.exportChessText({ liveBoardText: true })
  if (!text) return
  Object.assign(app.chessState, mergeItemTextIntoChessObj(app.chessState, text))
}

// Persist the current FEN editor position to the wiki page. The save itself happens
// in the wiki shell (it owns the journal); we just ask it to export-and-save. On the
// installed PWA (no shell), promote the local-only session via Save to wiki.
// The button is only shown when this viewer may save (see updatePositionSaveButton).
export function savePositionToWiki() {
  requireHost()
  if (app.pwaBridgeActive && app.isPwaJournalless?.()) {
    if (!app.followsPopup) markPositionSavedToItem()
    void app.requestPwaSaveToWiki?.()
    return
  }
  if (!app.wikiFrame) return
  if (!app.followsPopup) markPositionSavedToItem()
  shellMessenger()?.savePosition()
}

// Show the in-editor "Save Position to Wiki" button when this viewer may persist
// (owner autosave or guest local fork), matching canPersistPosition / putJournal.
// Installed PWA: same affordance while the session is still device-local.
export function updatePositionSaveButton() {
  const btn = document.getElementById('positionSaveToWikiBtn')
  if (!btn) return
  const showWiki = Boolean(app.wikiFrame && app.canPersistPosition())
  const showPwa = Boolean(app.pwaBridgeActive && app.isPwaJournalless?.() && app.canWriteJournalHere?.())
  btn.hidden = !(showWiki || showPwa)
}

// Flip the FEN editor's board perspective. Purely visual — the orientation isn't
// part of the FEN, so the exported/saved position is unaffected.
export function flipPositionBoard() {
  const board = app.fenEditor?.chessboard
  if (!board?.setOrientation) return
  const next = board.getOrientation() === 'w' ? 'b' : 'w'
  board.setOrientation(next, true)
}

export function startPositionFromMenu() {
  requireHost()
  app.clearBrowseStartMenuState()
  const meta = buildCreatePreviewMeta('position')
  const positionTitle = meta?.title || 'New Chess Position'
  const itemText = meta?.chessText || 'POSITION'
  app.chessState.wikiPageTitle = positionTitle
  app.setStartModalPageTitlePinned(true)
  const fen = START_FEN
  app.initializeChess({
    ...app.pickAppStateBasics(),
    format: 'FEN',
    FEN: fen,
    mode: 'POSITION',
    chessState: fen,
    needsSeed: true,
    gameType: 'position',
    showStartMenu: false,
  })
  shellMessenger()?.modeChanged({
    chessObj: { gameType: 'position', mode: 'POSITION', format: 'FEN', FEN: fen, showStartMenu: false },
  })
  app.syncGhostChessItemAfterModeBoot({ itemText, title: positionTitle })
}

export { reloadFenEditorPieceSet, ensurePositionEditorBoard }
