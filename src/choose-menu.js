/**
 * CHOOSE start menu — game/position/puzzle entry and in-flow mode switches.
 *
 * §1 Init & menu chrome sync
 * §2 Return / resume / cancel navigation
 * §3 Mode switches (game ↔ menu ↔ position editor)
 *
 * Wired from chess-app.js via initStartMenu().
 *
 * In-file landmarks use `// # Section Name` for navigation.
 */

import {
  getFormat,
  isBareModeKeyword,
  mergeGameSettings,
  normalizeFen,
  isStandardStartFen,
  parseChessItem,
} from './chess-core.js'
import {
  isPuzzleAuthorActive,
  hasUnsavedPuzzleAuthorWork,
  getPuzzleAuthorStartFen,
  abandonPuzzleAuthoring,
} from './puzzle.js'
import { isCurrentGameRated, isCurrentEngineGame, isCurrentRatedEngineGame } from './survey.js'
import { shellMessengerFromContext } from './board-layout.js'

let app

function shellMessenger() {
  return shellMessengerFromContext(app)
}

// # Init and Menu Chrome Sync

export function initStartMenu(appContext) {
  app = appContext
}

function requireHost() {
  if (!app) throw new Error('initStartMenu must be called before using choose-menu APIs')
}

// CHOOSE menu federation buttons (My Chess Games / Leaderboards) are always visible —
// the same menu in the wiki iframe, popup, and installed PWA. Wiki iframe opens the
// plugin pages in the lineup; popup / installed PWA open the in-app survey surfaces.
export function syncChooseMenuFederationButtons() {
  requireHost()
  const page = document.getElementById('start')
  if (!page) return
  for (const sel of ['.wiki-start-my-games', '.wiki-start-leaderboard']) {
    const btn = page.querySelector(sel)
    if (btn) btn.hidden = false
  }
}

// Installed PWA: Stockfish games, positions, and puzzles start as local-only sessions —
// no sign-in required. Federation publish paths gate themselves elsewhere.
export function syncChooseMenuAuthGatedButtons() {
  requireHost()
  if (!app.pwaBridgeActive) return
  const page = document.getElementById('start')
  if (!page) return
  for (const sel of ['.wiki-start-game', '.wiki-start-position', '.wiki-start-puzzle']) {
    const btn = page.querySelector(sel)
    if (!btn) continue
    btn.disabled = false
    btn.classList.remove('wiki-chess-auth-gated-disabled')
    btn.removeAttribute('aria-disabled')
    if (btn.dataset.authGatedTitle) {
      btn.title = btn.dataset.authGatedTitle
      delete btn.dataset.authGatedTitle
    }
  }
}

// # Return Resume and Cancel Navigation

// Snapshot in-progress game before browsing the start menu (journal unchanged until a new mode is chosen)
function captureGameResumeSnapshot() {
  // returnToStartMenu() only runs from the "Switch Game mode" buttons, so we always
  // arrive here from an active game, the position editor, or Puzzle Mode.
  // Capture enough state to restore that mode so the CHOOSE menu can offer a Cancel
  // button — even for a fresh game or position that still shows only a bare
  // GAME/POSITION keyword. (Opening the menu from the default CHOOSE keyword never
  // calls this, so that case has no snapshot and shows no Cancel, which is what we want.)

  // Puzzle mode reuses the main chessConsole. Capture the active puzzle session so
  // the CHOOSE menu can offer Cancel and restore the same puzzle (including progress).
  if (
    app.chessState?.gameType === 'puzzle' ||
    app.chessState?.format === 'PUZZLE' ||
    app.chessState?.mode === 'PUZZLE'
  ) {
    return app.capturePuzzleResumeSnapshot?.() || null
  }

  const base = {
    mode: app.chessState?.mode,
    gameType: app.chessState?.gameType,
    PGN: app.chessState?.PGN,
    FEN: app.chessState?.FEN,
    gameSettings: app.chessState?.gameSettings ? mergeGameSettings(app.chessState.gameSettings, {}) : undefined,
    humanPlayMode: app.chessState?.humanPlayMode,
    playerColor: app.chessState?.playerColor,
    engineLevel: app.chessState?.engineLevel,
    bareKeywordGuard: app.chessState?.bareKeywordGuard,
  }

  // Position editor (including the POSITION keyword): resume the live board position.
  if (app.isPositionEditorMode()) {
    const fen = app.exportCurrentFen() || app.chessState?.FEN
    if (fen) {
      return {
        ...base,
        format: 'FEN',
        mode: app.chessState?.mode || 'POSITION',
        gameType: app.chessState?.gameType || 'position',
        FEN: fen,
        chessState: fen,
        text: fen,
      }
    }
  }

  const text = app.exportChessText()

  // Active game, including a brand-new game still showing the bare GAME keyword.
  // Capture the full board PGN (liveBoardText bypasses the keyword gate) so Cancel can
  // restore a real, parseable game — exportChessText() returns "GAME" for an
  // uncommitted keyword game, which would crash the PGN parser on resume.
  if (app.chessConsole?.state?.chess) {
    const gamePgn = app.exportChessText({ liveBoardText: true })
    return {
      ...base,
      format: 'PGN',
      chessState: app.chessState?.chessState || gamePgn,
      text: gamePgn,
    }
  }

  // No live game or editor: only resume if the item already holds real chess data
  // (not a menu, empty, unknown, or bare CHOOSE keyword item).
  if (!text || text === 'CHOOSE' || isBareModeKeyword(text)) return null
  const format = getFormat(text)
  if (format === 'MENU' || format === 'EMPTY' || format === 'UNKNOWN') return null
  return {
    ...base,
    format: app.chessState?.format || format,
    chessState: app.chessState?.chessState || text,
    text,
  }
}

export function clearBrowseStartMenuState() {
  requireHost()
  delete app.chessState.browsingStartMenu
  delete app.chessState.resumeSnapshot
}

// `overrideSnapshot` (when `useOverride` is true) replaces the live capture — used
// when cancelling out of CHOOSE → "Play New Game" so we restore the menu's original
// resume state instead of snapshotting the throwaway setup board.
export function returnToStartMenu({ overrideSnapshot, useOverride = false } = {}) {
  requireHost()
  // We're rebuilding the CHOOSE menu directly, so close the start-game modal
  // without routing through its cancel branch (which would call us right back).
  app.newGameSetupActive = false
  app.newGameSetupOrigin = null
  app.closePositionStartModal()

  // Installed PWA: the live game is already in the chess item PGN (or local session).
  // Browse the menu without a resume snapshot — return via My Chess Games or reopen the page.
  if (app.pwaBridgeActive) app.flushGameBeforeBrowse?.()

  const resumeSnapshot = app.pwaBridgeActive
    ? null
    : useOverride
      ? overrideSnapshot || null
      : captureGameResumeSnapshot()

  app.resetChessApp()
  const next = {
    ...app.pickAppStateBasics(),
    showStartMenu: true,
    format: 'MENU',
    mode: 'CHOOSE',
    chessState: 'CHOOSE',
    browsingStartMenu: Boolean(resumeSnapshot),
    resumeSnapshot: resumeSnapshot || undefined,
    itemId: app.wikiItemId(),
    gameSettings: resumeSnapshot?.gameSettings ?? app.chessState?.gameSettings,
  }
  app.chessState = next
  app.initializeChess(next)
  // Back at the CHOOSE menu the footer should show no buttons. The shell only
  // sees this in-app transition via mode-changed; showStartMenu hides both.
  shellMessenger()?.modeChanged({
    chessObj: { mode: 'CHOOSE', format: 'MENU', showStartMenu: true },
  })
  app.requestWikiEmbedScrollIntoView?.()
}

// Reclaim this surface after the user confirmed a mode switch here. A background or
// zombie "Open in new window" tab (common on mobile) must not leave the embed stuck
// forwarding actions that never land.
function reclaimSurfaceFromPopupFollow() {
  if (!app.followsPopup) return
  app.setFollowsPopup?.(false)
}

// Return to CHOOSE from the viewer's surface. When a popup is also open, notify it so
// both stay in sync — but always apply here, where the user confirmed (mobile often
// leaves a background window that never receives the shell forward).
export function proceedReturnToStartMenu() {
  if (app.followsPopup) {
    shellMessenger()?.requestSwitchGameMode()
    reclaimSurfaceFromPopupFollow()
  }
  returnToStartMenu()
}

// Popup handler when the shell forwards a "switch game mode" request.
export function handleMirrorSwitchGameModeRequest() {
  returnToStartMenu()
}

// Cancel out of the CHOOSE menu back to the game/position we were browsing from.
// Only reachable when returnToStartMenu() captured a resumeSnapshot — a menu opened
// from a bare CHOOSE keyword has no snapshot and shows no Cancel button.
export function cancelStartMenu({ overrideSnapshot } = {}) {
  requireHost()
  const snap = overrideSnapshot || app.chessState?.resumeSnapshot
  if (!snap) return

  if (snap.format === 'PUZZLE' || snap.gameType === 'puzzle' || snap.puzzleResume) {
    app.resetChessApp()
    const next = {
      ...app.pickAppStateBasics(),
      format: 'PUZZLE',
      mode: 'PUZZLE',
      gameType: 'puzzle',
      chessState: snap.chessState ?? snap.text,
      showStartMenu: false,
      itemId: app.wikiItemId(),
    }
    app.chessState = next
    app.resumePuzzleSession?.(snap)
    shellMessenger()?.modeChanged({
      chessObj: {
        gameType: 'puzzle',
        mode: 'PUZZLE',
        format: 'PUZZLE',
        showStartMenu: false,
      },
    })
    app.requestWikiEmbedScrollIntoView?.()
    clearBrowseStartMenuState()
    return
  }

  app.resetChessApp()
  const next = {
    ...app.pickAppStateBasics(),
    format: snap.format,
    mode: snap.mode,
    gameType: snap.gameType,
    chessState: snap.chessState ?? snap.text,
    gameSettings: snap.gameSettings ?? app.chessState?.gameSettings,
    humanPlayMode: snap.humanPlayMode,
    playerColor: snap.playerColor,
    engineLevel: snap.engineLevel,
    bareKeywordGuard: snap.bareKeywordGuard,
    showStartMenu: false,
    itemId: app.wikiItemId(),
  }
  // Restore the live position the snapshot captured (text holds the current moves).
  if (snap.format === 'FEN') {
    next.FEN = snap.FEN || snap.text
  } else {
    const pgn = snap.text || snap.PGN
    // Never feed a bare keyword (e.g. "GAME") to the PGN parser — that throws the
    // "Provided PGN: GAME" error. Resumable games always carry real PGN; if somehow
    // only a keyword is left, fall through with no PGN so init shows the menu safely.
    if (pgn && !isBareModeKeyword(pgn)) next.PGN = pgn
  }
  app.chessState = next
  app.initializeChess(next)
  // Resuming the snapshotted game/position: re-sync the shell footer (a position
  // shows "Save position to wiki", a game doesn't). showStartMenu is cleared.
  shellMessenger()?.modeChanged({
    chessObj: {
      gameType: next.gameType,
      mode: next.mode,
      format: next.format,
      FEN: next.FEN,
      showStartMenu: false,
    },
  })
  app.requestWikiEmbedScrollIntoView?.()
  clearBrowseStartMenuState()
}

// A live PGN game on the game page that has not yet reached a final result.
function isLiveOngoingGame() {
  if (!app.chessConsole || !app.isActivePage('game') || app.chessState?.showStartMenu) return false
  const pgn = app.chessState?.PGN || app.chessState?.chessState || ''
  if (!pgn || getFormat(pgn) !== 'PGN') return false
  return !app.currentGameOutcome().over
}

// Completed rated games show the result banner — hide mode-switch / position-edit so
// players are not nudged to overwrite a finished rated result in the journal. The
// installed PWA still shows "Back to menu" (see syncChooseModeButton); popup/iframe hide it.
export function hideGameNavForCompletedRated() {
  requireHost()
  return app.isActivePage('game') && isCurrentGameRated() && app.currentGameOutcome().over
}

const RATED_RESIGN_BEFORE_EDIT_NOTE =
  'Rated games must be resigned before the chess item is changed, so the result and ' +
  'rating update are recorded in the wiki journal. If someone edits the item after ' +
  'resigning, the other player can fork that resignation entry in the journal as proof.'

const ENGINE_RATED_RESIGN_BEFORE_EDIT_NOTE =
  'Resign to record the result — changing the item without resigning leaves the game ' +
  'unfinished and your vs-Stockfish reference rating unchanged.'

const ENGINE_CASUAL_LEAVE_NOTE = 'This ends your game vs Stockfish. No rating will change.'

const END_GAME_BY_EDITING_NOTE =
  'Changing the chess item ends the current game. To recover it later, fork the page ' +
  'to an earlier point in its journal history.'

// Installed PWA: browsing the CHOOSE menu is in-app navigation. The chess item keeps its
// saved PGN, so leaving a game does not require resigning or overwriting the journal item.
function pwaBrowsingPreservesOngoingGame() {
  return Boolean(app.pwaBridgeActive)
}

// Confirm before an action that replaces the live game in the wiki item. Skips the
// dialog when there is no in-progress game; rated games resign on confirm when allowed.
export function confirmLeaveOngoingGame({
  title,
  titleBlocked = 'Resign first',
  message,
  messageRated,
  messageBlocked = 'This rated game is still in progress. Resign from your seat before changing the chess item.',
  proceedNoteRated = 'Confirming resigns for you (a loss and rating update) before continuing.',
  proceedNoteEngineRated = 'Confirming resigns for you (a loss) and updates your personal vs-Stockfish reference rating before continuing.',
  extraNotes = [],
  confirmLabel,
  confirmLabelRated,
  onProceed,
} = {}) {
  requireHost()
  if (pwaBrowsingPreservesOngoingGame() || !isLiveOngoingGame()) {
    onProceed?.()
    return
  }

  const humanRated = isCurrentGameRated()
  const engineRated = isCurrentRatedEngineGame()
  const engineCasual = isCurrentEngineGame() && !engineRated
  const ratedMessage = messageRated || message
  const engineRatedMessage = (messageRated || message).replace(/\brated game\b/i, 'rated game vs Stockfish')
  const popupForwardNote = app.followsPopup ? 'The open game window will apply this change.' : null

  if (humanRated) {
    if (app.viewerHoldsResignableSeat()) {
      const popupNote = app.followsPopup ? 'Resignation is recorded in the open game window.' : null
      app.openEmbeddedConfirmModal({
        title,
        message: ratedMessage,
        notes: [
          proceedNoteRated,
          RATED_RESIGN_BEFORE_EDIT_NOTE,
          ...(popupNote ? [popupNote] : []),
          ...(popupForwardNote ? [popupForwardNote] : []),
          ...extraNotes,
        ],
        confirmLabel: confirmLabelRated || `Resign & ${confirmLabel}`,
        cancelLabel: 'Keep playing',
        confirmClass: 'btn-danger',
        onConfirm: () => {
          app.executeResignFromViewer({ onAfter: () => onProceed?.() })
        },
      })
      return
    }
    app.openEmbeddedConfirmModal({
      title: titleBlocked,
      message: messageBlocked,
      notes: [RATED_RESIGN_BEFORE_EDIT_NOTE, END_GAME_BY_EDITING_NOTE, ...extraNotes],
      confirmLabel: 'OK',
      cancelLabel: 'Keep playing',
      confirmClass: 'btn-primary',
      onConfirm: () => {},
    })
    return
  }

  if (engineRated) {
    const popupNote = app.followsPopup ? 'Resignation is recorded in the open game window.' : null
    app.openEmbeddedConfirmModal({
      title,
      message: engineRatedMessage,
      notes: [
        proceedNoteEngineRated,
        ENGINE_RATED_RESIGN_BEFORE_EDIT_NOTE,
        'Your vs-Stockfish rating is for your reference only — it never appears on leaderboards.',
        ...(popupNote ? [popupNote] : []),
        ...(popupForwardNote ? [popupForwardNote] : []),
        ...extraNotes,
      ],
      confirmLabel: confirmLabelRated || `Resign & ${confirmLabel}`,
      cancelLabel: 'Keep playing',
      confirmClass: 'btn-danger',
      onConfirm: () => {
        app.executeResignFromViewer({ onAfter: () => onProceed?.() })
      },
    })
    return
  }

  app.openEmbeddedConfirmModal({
    title,
    message,
    notes: [
      END_GAME_BY_EDITING_NOTE,
      ...(engineCasual ? [ENGINE_CASUAL_LEAVE_NOTE] : []),
      ...(popupForwardNote ? [popupForwardNote] : []),
      ...extraNotes,
    ],
    confirmLabel,
    cancelLabel: 'Keep playing',
    confirmClass: 'btn-danger',
    onConfirm: () => onProceed?.(),
  })
}

// # Mode Switches

// The footer "Switch Game Mode" button, from inside a game. Leaving a game for the
// CHOOSE menu walks away from the live game, so confirm first when there's something
// to lose. A rated (cross-wiki human) game can't simply be abandoned without a result,
// so leaving it forces a resignation (a recorded loss) before we switch.
export function switchGameModeFromGame() {
  requireHost()
  if (!app.isActivePage('game') || app.currentGameOutcome().over) {
    proceedReturnToStartMenu()
    return
  }
  if (!isLiveOngoingGame()) {
    proceedReturnToStartMenu()
    return
  }

  confirmLeaveOngoingGame({
    title: 'Switch game mode?',
    message: 'This will end the current game by changing the chess item.',
    messageRated: 'This will end the rated game by changing the chess item.',
    proceedNoteRated: 'Confirming resigns for you (a loss and rating update) before returning to the game menu.',
    confirmLabel: 'Switch game mode',
    confirmLabelRated: 'Resign & switch',
    onProceed: () => proceedReturnToStartMenu(),
  })
}

// FEN last persisted on the wiki item (not the live board).
function itemSavedPositionFen() {
  if (app.chessState?.bareKeywordGuard === 'POSITION') return ''
  if (app.chessState?.FEN) return normalizeFen(app.chessState.FEN)
  const text = String(app.chessState?.chessState || '').trim()
  if (!text || isBareModeKeyword(text)) return ''
  const parsed = parseChessItem(text)
  if (parsed.mode === 'POSITION' && parsed.content && getFormat(parsed.content) === 'FEN') {
    return normalizeFen(parsed.content.split(/\r?\n/)[0])
  }
  if (app.chessState?.format === 'FEN') return normalizeFen(text.split(/\r?\n/)[0])
  return ''
}

function liveEditorPositionFen() {
  if (isPuzzleAuthorActive()) return normalizeFen(getPuzzleAuthorStartFen())
  return normalizeFen(app.currentPositionFen() || app.exportCurrentFen())
}

function hasUnsavedPositionEdits() {
  if (!app.isPositionEditorMode() && !isPuzzleAuthorActive()) return false
  const current = liveEditorPositionFen()
  if (!current) return false
  const saved = itemSavedPositionFen()
  if (!saved) {
    if (app.chessState?.bareKeywordGuard === 'POSITION') return !isStandardStartFen(current)
    return false
  }
  return current !== saved
}

function editorSwitchLossNotes() {
  const notes = []
  if (isPuzzleAuthorActive() && hasUnsavedPuzzleAuthorWork()) {
    notes.push('Your recorded puzzle line and prompt will be discarded if you have not saved the puzzle.')
  }
  if ((app.isPositionEditorMode() || isPuzzleAuthorActive()) && hasUnsavedPositionEdits()) {
    notes.push('The position on the board has not been saved to this item and will be lost.')
  }
  return notes
}

// Position editor and puzzle author: confirm before returning to CHOOSE when edits
// would be discarded. Puzzle solving switches straight to the menu (offline downloads
// continue in-window; closing the window is guarded separately).
export function confirmSwitchGameModeFromEditor() {
  requireHost()
  const notes = editorSwitchLossNotes()
  if (app.followsPopup) {
    notes.push('The open game window will apply this change.')
  }
  const proceed = () => {
    if (isPuzzleAuthorActive()) abandonPuzzleAuthoring()
    proceedReturnToStartMenu()
  }
  if (!notes.length) {
    proceed()
    return
  }
  app.openEmbeddedConfirmModal({
    title: 'Switch game mode?',
    message: 'Leaving the editor will discard your unsaved work.',
    notes,
    confirmLabel: 'Switch game mode',
    cancelLabel: 'Keep editing',
    confirmClass: 'btn-danger',
    onConfirm: () => proceed(),
  })
}

export function openPositionEditorFromGame() {
  requireHost()
  const fen = app.exportCurrentFen()
  if (!fen) return

  const canPersist = Boolean(app.wikiFrame && app.chessState?.pageOnThisWiki)
  const persistNote =
    "This page isn't yours to edit, so the change is only kept in this browser " +
    '(local storage) and is not saved to the server.'

  if (isLiveOngoingGame()) {
    confirmLeaveOngoingGame({
      title: 'Edit position?',
      message: 'This will end the current game by changing the chess item to a position.',
      messageRated: 'This will end the rated game by changing the chess item to a position.',
      proceedNoteRated: 'Confirming resigns for you (a loss and rating update) before opening the position editor.',
      extraNotes: !canPersist ? [persistNote] : [],
      confirmLabel: 'Edit position',
      confirmLabelRated: 'Resign & edit',
      onProceed: () => proceedOpenPositionEditor(fen),
    })
    return
  }

  const notes = ['Switching to the position editor replaces the current chess item content with this board position.']
  if (!canPersist) notes.push(persistNote)
  if (app.followsPopup) {
    notes.push('The open game window will apply this change.')
  }

  app.openEmbeddedConfirmModal({
    title: 'Edit position?',
    message: 'Switch to the position editor for this board?',
    notes,
    confirmLabel: 'Edit position',
    cancelLabel: 'Cancel',
    confirmClass: 'btn-danger',
    onConfirm: () => proceedOpenPositionEditor(fen),
  })
}

function proceedOpenPositionEditor(fen) {
  if (app.followsPopup) {
    shellMessenger()?.requestOpenPositionEditor({ fen })
    reclaimSurfaceFromPopupFollow()
  }
  switchToPositionEditorFromGame(fen)
}

// Popup handler when the shell forwards an "edit position" request.
export function handleMirrorOpenPositionEditorRequest(fen) {
  switchToPositionEditorFromGame(fen || app.exportCurrentFen())
}

function switchToPositionEditorFromGame(fen) {
  app.resetChessApp()
  const next = {
    ...app.pickAppStateBasics(),
    format: 'FEN',
    FEN: fen,
    mode: 'POSITION',
    gameType: 'position',
    chessState: fen,
    showStartMenu: false,
  }
  app.chessState = next
  clearBrowseStartMenuState()
  // Don't persist on entry — the position is only written to the wiki when the
  // user saves it or starts a game from it. The journal keeps the prior game
  // until then, so an unsaved position edit is discardable.
  app.initializeChess(next)
  // Tell the wiki shell we're now editing a position so its footer shows "Open in
  // new window" (the shell rendered while this item was still a live game). The
  // "Save Position to Wiki" button lives in this editor's own action row.
  shellMessenger()?.modeChanged({
    chessObj: { gameType: 'position', mode: 'POSITION', format: 'FEN', FEN: fen },
  })
  app.requestWikiEmbedScrollIntoView?.()
}
