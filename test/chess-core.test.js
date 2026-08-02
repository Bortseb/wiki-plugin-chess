/** Unit tests for src/chess-core.js — format detection, keywords, PGN helpers, puzzle pool. */
globalThis.bootstrap = globalThis.bootstrap || {}
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getFormat,
  figurineToFEN,
  parseChessItem,
  parseItemMode,
  resolveChessState,
  mergeItemTextIntoChessObj,
  formatPlayerId,
  parsePlayerId,
  isManuallyEditablePlayerTag,
  boardPlayerLabelFromPgn,
  playerDisplayLabelHtml,
  formatPlayerDisplayLabel,
  faviconUrl,
  openChallengeAcceptParagraph,
  wikiSiteLinkLabel,
  wikiSitePageUrl,
  WIKI_HOME_PAGE_SLUG,
  buildStartPgn,
  resolvePgnEvent,
  gameStartInstant,
  getPgnTag,
  normalizePgnPlayers,
  shouldIgnoreKeywordAutosave,
  shouldPersistChessItemText,
  isUnseatedFreshGamePgn,
  hasOneCreatorOpenSeat,
  isPageOpenChallengePgn,
  keepGhostUntilSeatsFilled,
  claimSeat,
  getSeatClaimOffer,
  canClaimOpenSeatAsViewer,
  upgradeGuestSeatTagsToWikiIdentity,
  isPlainGuestSeatTag,
  GUEST_PLAYER_NAME,
  detectClipboardChessFormat,
  isPasteContentValid,
  isValidFenString,
  lastMoveFromEnPassantTarget,
  fenBeforeEnPassantDoubleStep,
  isEditableChessItemText,
  resolvePasteItemText,
  createPasteCapturePayload,
  pasteMatchesCurrent,
  pasteApplyLabel,
  pasteCreateNewLabel,
  buildPasteGhostMeta,
  pasteCanReplaceCurrentItem,
  chessItemEmitKey,
  shouldRespondWithPatchStateOnly,
  SESSION_PHASE,
  planChessShellPersist,
  SESSION_ACTION,
  reduceChessSession,
  createInitialChessSession,
  sessionShouldDeferNewGameSetup,
  sessionHasReceivedInitialState,
  sessionBlocksAutosave,
  sessionBlocksSounds,
  sessionShouldDismissSetupForItem,
  sessionShouldReopenGameSetup,
  CHESS_VIEW,
  createChessSessionController,
  resolveChessViewMode,
  sessionConsoleGeneration,
  MSG,
  createMessageDispatcher,
  shouldKeepActiveShellSync,
  isStaleGhostChooseShellSync,
  isMaintenanceChessItemText,
  isMaintenanceChessState,
  canOfferGuestLocalPersist,
  shouldDeferOriginJournalPut,
  localSessionUiPolicy,
  pwaMatchesLinkedWikiTab,
  isPuzzleState,
  normalizeRestoredChessSession,
  GAME_SYNC_SOURCE,
  gamePlyCount,
  evaluateGameSyncUpdate,
  preferRicherGameText,
  hasActivePuzzleFilters,
  formatPuzzleFiltersLabel,
  formatByteSize,
  puzzleMatchesFilters,
  puzzleThemeLabel,
  resolvePuzzleThemeKey,
  rankCommonPuzzleThemes,
  PUZZLE_COMMON_THEME_IDS,
  PUZZLE_THEME_OPTIONS,
  chessJournalSymbol,
  bothSeatsFilled,
  CHESS_CREATE_SYMBOL,
  CHESS_SEAT_WHITE_SYMBOL,
  CHESS_SEAT_BLACK_SYMBOL,
  CHESS_COMPLETE_SYMBOL,
  classifyChessSave,
  buildOpenChallengeGhostJournal,
  buildJoinAcceptGhost,
  buildCreatePreviewMeta,
  buildCreatePreviewStory,
  buildPuzzleItemText,
  rewritePuzzleItemText,
  puzzleBankBodyText,
  parsePuzzleSpec,
  recordAdaptivePuzzleOutcome,
  ADAPTIVE_COACH_DEFAULT_RATING,
  markPuzzleItemProgress,
  puzzleItemProgressFromText,
  academyProgressFromLocalPages,
  resolveSmartAcademyNext,
  academyLinksForPuzzleThemes,
  shouldSplitOpenSeatGameJournal,
  chessGameHasStarted,
  rebuildStoryFromJournal,
  normalizeGameSettings,
  shouldRotateBoardForSideToMove,
  shouldFlipPiecesInPlace,
  pieceSetAllowsInPlaceFlip,
  challengeTargetFromPgn,
  challengeOpponentWikiSite,
  clearPgnTag,
  stripSelfChallengeTarget,
  setPgnTag,
  mergeGameSettings,
  coalesceAdoptedGameSettings,
  isChessAcademyWikiSite,
  siteGameSettingDefaults,
  pgnGameSettingDefaults,
  parseCommentsTag,
  parseOnOffPgnTag,
  isDemoOrLessonGame,
  pgnHasMoveComments,
  shouldViewLoadedGameFromStart,
  isAnnotatedGameChessText,
  academyPlayTwinSite,
  parsePgnParts,
  remotePageMatchesExpect,
  chessMovetextKey,
  PIECE_SETS,
  DEFAULT_PIECE_SET_ID,
  normalizePieceSetId,
  getPieceSetById,
  DEFAULT_COLOR_THEME_ID,
  normalizeColorThemeId,
  nextColorThemeId,
  resolveColorTheme,
  positionStartModalFields,
  parseStartModalColorChoice,
  HUMAN_PLAY_CORRESPONDENCE,
  HUMAN_PLAY_SAME_DEVICE,
  START_FEN,
  planCorrespondenceJournalSteps,
  resolveCorrespondenceJournalContext,
  opponentWikiSiteFromPgn,
  canonicalizePersistedChessText,
  normalizeExportPgn,
  formatPgn,
  prepareWikiPgn,
  isCommentOrResultOnlyMovetext,
  pgnHasMoves,
  pgnThroughPlies,
  boardPlayerLabel,
  stockfishDisplayLabel,
  stockfishPlayerId,
  stockfishLevelElo,
  parsePuzzleBankContent,
  parsePuzzleJsonLine,
  looksLikePuzzleBankPaste,
  isLoopbackWikiHost,
  protocolForWikiSite,
  puzzlePlayerColor,
} from '../src/chess-core.js'
import {
  validateRemoteContinuation,
  validateRemotePageFork,
  remoteMoveContinuation,
  REMOTE_REJECT_NO_NEW_MOVE,
  REMOTE_REJECT_START_CHANGED,
  REMOTE_REJECT_HISTORY_REWRITTEN,
  REMOTE_REJECT_MULTIPLE_PLIES,
  REMOTE_REJECT_FORGED_SEAT,
  validateRemoteGameCompletion,
  classifyRemoteGameEnd,
} from '../src/realtime.js'
import {
  parsePuzzleRow,
  parsePuzzlesCsv,
  parseEmbeddedPuzzleContent,
  puzzlesFromReferencedPages,
  formatPuzzleSourceLabel,
  formatPuzzleSourceTitle,
  puzzleSourceBadgeClass,
  puzzleUnavailableCopy,
  localPuzzleDownloadModalCopy,
  localPuzzleDownloadDisableCopy,
  isLocalPuzzleDownloadInProgress,
  selectPuzzle,
  createPuzzleSolver,
  puzzleStartPgn,
  parseTeachPuzzleFromPgn,
  isInsufficientMaterialSoftDraw,
} from '../src/puzzle.js'
import { Chess } from '../src/cm-modules-bundle.js'

const MATE_IN_2_ROW =
  '0042j,3r2k1/4nppp/pq1p1b2/1p2P3/2r2P2/2P1NR2/PP1Q2BP/3R2K1 b - - 0 24,d6e5 d2d8 b6d8 d1d8,555,106,92,1446,backRankMate mate mateIn2 middlegame short,https://lichess.org/DuM2FZjg/black#48,'

const MATE_IN_1_ROW =
  '00GRa,1r3rk1/2p1Nppb/p2nq3/1p2p1Pp/4Qn1P/2P1N3/PPB2P1K/3R2R1 b - - 5 28,e6e7 e4h7,438,118,96,1203,kingsideAttack mate mateIn1 middlegame oneMove,https://lichess.org/QiJhfG8J/black#56,'

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const STARTING_FIGURINE = `♜a8 ♞b8 ♝c8 ♛d8 ♚e8 ♝f8 ♞g8 ♜h8
♟a7 ♟b7 ♟c7 ♟d7 ♟e7 ♟f7 ♟g7 ♟h7


♙a2 ♙b2 ♙c2 ♙d2 ♙e2 ♙f2 ♙g2 ♙h2
♖a1 ♘b1 ♗c1 ♕d1 ♔e1 ♗f1 ♘g1 ♖h1`

describe('lib · chess-core', () => {
  it('detects figurine, FEN, PGN, empty, and unknown text', () => {
    assert.equal(getFormat(STARTING_FIGURINE), 'FIGURINE')
    assert.equal(getFormat(STARTING_FEN), 'FEN')
    assert.equal(getFormat('[White "a"]\n[Black "b"]'), 'PGN')
    assert.equal(getFormat('1. e4 e5'), 'PGN')
    assert.equal(getFormat(''), 'EMPTY')
    assert.equal(getFormat('hello world'), 'UNKNOWN')
  })

  it('converts a figurine diagram to FEN', () => {
    const fen = figurineToFEN(STARTING_FIGURINE)
    assert.ok(fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'))
  })

  it('reads mode keywords from item text', () => {
    assert.equal(parseItemMode('GAME'), 'GAME')
    assert.equal(parseItemMode('position'), 'POSITION')
    assert.equal(parseItemMode('PUZZLE'), 'PUZZLE')
    assert.equal(parseItemMode('CHOOSE'), 'CHOOSE')
    assert.equal(parseItemMode('1. e4'), 'NONE')
  })

  it('treats loopback, *.local, and private LAN hosts as HTTP-ok', () => {
    assert.equal(isLoopbackWikiHost('localhost'), true)
    assert.equal(isLoopbackWikiHost('frank.localhost:3001'), true)
    assert.equal(isLoopbackWikiHost('127.0.0.1:3000'), true)
    assert.equal(isLoopbackWikiHost('192.168.68.62:3001'), true)
    assert.equal(isLoopbackWikiHost('10.0.0.5'), true)
    assert.equal(isLoopbackWikiHost('172.16.1.2'), true)
    assert.equal(isLoopbackWikiHost('172.15.0.1'), false)
    assert.equal(isLoopbackWikiHost('chess.example.co'), false)
    assert.equal(protocolForWikiSite('192.168.68.62:3001'), 'http')
    assert.equal(protocolForWikiSite('chess.example.co'), 'https')
  })

  it('shows the start menu for CHOOSE and empty items', () => {
    assert.equal(parseChessItem('CHOOSE').showStartMenu, true)
    assert.equal(parseChessItem('').showStartMenu, true)
    assert.equal(parseChessItem('GAME').showStartMenu, false)
    assert.equal(parseChessItem('[White "a"]\n\n1. e4').showStartMenu, false)
  })

  it('resolves GAME, POSITION, and PUZZLE keywords', () => {
    const game = resolveChessState(parseChessItem('GAME'))
    assert.equal(game.gameType, 'open')
    assert.equal(game.format, 'PGN')

    const position = resolveChessState(parseChessItem('POSITION'))
    assert.equal(position.gameType, 'position')
    assert.equal(position.format, 'FEN')

    const puzzle = resolveChessState(parseChessItem('PUZZLE'))
    assert.equal(puzzle.gameType, 'puzzle')
    assert.equal(puzzle.format, 'PUZZLE')
  })

  it('formats and parses wiki player ids', () => {
    assert.equal(formatPlayerId('Rob', 'localhost:3001'), 'localhost:3001 (Rob)')
    const player = parsePlayerId('ff.localhost:3001 (Rob)')
    assert.equal(player.username, 'Rob')
    assert.equal(player.domain, 'ff.localhost:3001')
    assert.equal(parsePlayerId('Stockfish Level 3').isEngine, true)
  })

  it('marks plain seat names as manually editable (not Stockfish or wiki host seats)', () => {
    assert.equal(isManuallyEditablePlayerTag('Olga'), true)
    assert.equal(isManuallyEditablePlayerTag('Player 2'), true)
    assert.equal(isManuallyEditablePlayerTag('Guest'), true)
    assert.equal(isManuallyEditablePlayerTag('Stockfish Level 3'), false)
    assert.equal(isManuallyEditablePlayerTag('localhost:3001 (Rob)'), false)
    assert.equal(isManuallyEditablePlayerTag(''), false)
  })

  it('keeps Stockfish Elo out of board names (badge shows it separately)', () => {
    assert.equal(boardPlayerLabel({ name: 'Stockfish Level 3', state: { level: 3 } }), 'Stockfish Level 3')
    assert.equal(boardPlayerLabel({ name: 'Stockfish Level 6' }), 'Stockfish Level 6')
    assert.equal(stockfishPlayerId(3), 'Stockfish Level 3')
    assert.equal(stockfishDisplayLabel(3), `Stockfish Level 3 (${stockfishLevelElo(3)})`)
  })

  it('builds wiki site labels as selectable text (not navigable links)', () => {
    assert.equal(WIKI_HOME_PAGE_SLUG, 'welcome-visitors')
    assert.equal(wikiSiteLinkLabel('example.com:443'), 'example.com')
    assert.equal(wikiSiteLinkLabel('example.com'), 'example.com')
    assert.equal(wikiSiteLinkLabel('ff.localhost:3001'), 'ff.localhost:3001')
    assert.equal(wikiSitePageUrl('ff.localhost:3001'), 'http://ff.localhost:3001/welcome-visitors.html')
    assert.equal(wikiSitePageUrl('example.com'), 'https://example.com/welcome-visitors.html')
    const html = playerDisplayLabelHtml('ff.localhost:3001 (Rob)')
    assert.doesNotMatch(html, /<a\b/)
    assert.match(html, /Rob/)
    assert.match(html, /<span class="wiki-chess-wiki-site-link">ff\.localhost:3001<\/span>/)
    assert.doesNotMatch(playerDisplayLabelHtml('example.com (Ada)'), /<a\b/)
    assert.match(playerDisplayLabelHtml('example.com (Ada)'), /Ada/)
    assert.match(playerDisplayLabelHtml('example.com (Ada)'), /<span class="wiki-chess-wiki-site-link">example\.com<\/span>/)
    assert.equal(formatPlayerDisplayLabel('chess.aolc.cc (Wiki Cafe)'), 'Wiki Cafe (chess.aolc.cc)')
  })

  it('keeps host-first wiki tags for board bars so favicons resolve', () => {
    // Display labels are name-first; parsePlayerId / faviconUrl need host-first PGN tags.
    const white = { name: 'stale' }
    const black = { name: 'Stockfish Level 1', state: { level: 1 } }
    const consoleLike = {
      playerWhite: () => white,
      playerBlack: () => black,
      state: {
        chess: {
          pgn: {
            header: {
              tags: {
                White: 'chess.aolc.cc (Wiki Cafe)',
                Black: 'Stockfish Level 1',
              },
            },
          },
        },
      },
    }
    const label = boardPlayerLabelFromPgn(white, consoleLike)
    assert.equal(label, 'chess.aolc.cc (Wiki Cafe)')
    const parsed = parsePlayerId(label)
    assert.equal(parsed.domain, 'chess.aolc.cc')
    assert.equal(parsed.username, 'Wiki Cafe')
    assert.match(faviconUrl(parsed.domain), /chess\.aolc\.cc\/favicon\.png/)
    // Regressing to formatPlayerDisplayLabel here swaps host/name and breaks the chip.
    const wrong = parsePlayerId(formatPlayerDisplayLabel(label))
    assert.notEqual(wrong.domain, 'chess.aolc.cc')
  })

  it('names joiner and creator in the open-challenge accept paragraph', () => {
    assert.equal(
      openChallengeAcceptParagraph('bjorn.localhost:3001 (Bjorn)', 'olga.localhost:3001 (Olga)'),
      'bjorn.localhost:3001 (Bjorn) accepts an open challenge from olga.localhost:3001 (Olga).',
    )
    assert.equal(openChallengeAcceptParagraph('', ''), 'You accept an open challenge from another wiki.')
  })

  it('builds a starting PGN for a game vs Stockfish', () => {
    const pgn = buildStartPgn({ gameType: 'engine', ownerName: 'alice', wikiSite: 'ff.localhost' })
    assert.equal(getPgnTag(pgn, 'White'), 'ff.localhost (alice)')
    assert.equal(getPgnTag(pgn, 'Black'), 'Stockfish Level 1')
    assert.equal(getPgnTag(pgn, 'Event'), 'Federated Wiki Chess')
    assert.equal(getPgnTag(pgn, 'Rated'), 'yes')
  })

  it('skips placeholder ghost-page names when resolving the Event tag', () => {
    // Games started from CHOOSE / "New Chess Page" ghosts must not stamp the
    // placeholder slug as their tournament name.
    assert.equal(resolvePgnEvent({ wikiPageName: 'new-chess-page' }), 'Federated Wiki Chess')
    assert.equal(resolvePgnEvent({ wikiPageTitle: 'New Chess Game' }), 'Federated Wiki Chess')
    assert.equal(resolvePgnEvent({ wikiPageName: 'fedwiki-island-cup' }), 'fedwiki-island-cup')
  })

  it('stamps and reads back the game start instant from UTC tags', () => {
    const pgn = buildStartPgn({ gameType: 'engine', ownerName: 'alice', wikiSite: 'ff.localhost' })
    const instant = gameStartInstant({ utcDate: getPgnTag(pgn, 'UTCDate'), utcTime: getPgnTag(pgn, 'UTCTime') })
    assert.ok(instant instanceof Date)
    assert.ok(Math.abs(Date.now() - instant.getTime()) < 60_000)
    assert.equal(gameStartInstant({ utcDate: '', utcTime: '' }), null)
  })

  it('always stamps engine games rated for the vs-Stockfish track', () => {
    const pgn = buildStartPgn({
      gameType: 'engine',
      ownerName: 'alice',
      wikiSite: 'ff.localhost',
      rated: false,
    })
    assert.equal(getPgnTag(pgn, 'Rated'), 'yes')
  })

  it('stamps challenge metadata in PGN tags for open seeks', () => {
    const pgn = buildStartPgn({
      gameType: 'human',
      ownerName: 'frank',
      wikiSite: 'frank.localhost',
      localSeat: 'w',
      rated: false,
      challengeCreator: 'frank.localhost (Frank)',
      creatorColorPref: 'Random',
    })
    assert.equal(getPgnTag(pgn, 'ChallengeCreator'), 'frank.localhost (Frank)')
    assert.equal(getPgnTag(pgn, 'CreatorColor'), 'Random')
    assert.equal(getPgnTag(pgn, 'Rated'), 'no')
    // Blank ChallengeTarget is omitted (open federation seek).
    assert.equal(getPgnTag(pgn, 'ChallengeTarget'), null)

    const directed = buildStartPgn({
      gameType: 'human',
      ownerName: 'frank',
      wikiSite: 'frank.localhost',
      localSeat: 'w',
      rated: false,
      challengeCreator: 'frank.localhost (Frank)',
      creatorColorPref: 'White',
      challengeTarget: 'olga.localhost:3001',
    })
    assert.equal(getPgnTag(directed, 'ChallengeTarget'), 'olga.localhost:3001')
  })

  it('fills in missing player tags', () => {
    const pgn = normalizePgnPlayers(`[SetUp "1"]\n[FEN "${STARTING_FEN}"]`, {
      ownerName: 'FF FF',
      wikiSite: 'ff.localhost',
    })
    assert.equal(getPgnTag(pgn, 'White'), 'ff.localhost (FF FF)')
    assert.equal(getPgnTag(pgn, 'Black'), 'Stockfish Level 1')
  })

  it('keeps an open seat when the opponent tag was dropped from a human challenge', () => {
    const local = 'elif.localhost:3001 (Elif)'
    const pgn = normalizePgnPlayers(
      `[White "${local}"]\n[HumanPlay "correspondence"]\n[Result "*"]`,
      {
        ownerName: 'Elif',
        wikiSite: 'elif.localhost:3001',
      },
    )
    assert.equal(getPgnTag(pgn, 'White'), local)
    assert.equal(getPgnTag(pgn, 'Black'), '')
  })

  it('claims an open seat', () => {
    const pgn = buildStartPgn({ gameType: 'open', ownerName: 'alice', wikiSite: 'ff.localhost' })
    const claimed = claimSeat(pgn, 'Black', { ownerName: 'bob', wikiSite: 'bb.localhost' })
    assert.equal(getPgnTag(claimed, 'Black'), 'bb.localhost (bob)')
  })

  it('upgrades a plain Guest seat to the signed-in wiki identity', () => {
    const pgn = `[White "${GUEST_PLAYER_NAME}"]\n[Black "Stockfish Level 3"]\n[Result "*"]\n\n*`
    assert.equal(isPlainGuestSeatTag(GUEST_PLAYER_NAME), true)
    const next = upgradeGuestSeatTagsToWikiIdentity(pgn, {
      signedInDisplayName: 'Robert',
      wikiSite: 'robert.localhost:3001',
    })
    assert.equal(getPgnTag(next, 'White'), 'robert.localhost:3001 (Robert)')
    assert.equal(getPgnTag(next, 'Black'), 'Stockfish Level 3')
  })

  it('does not steal an opponent Guest seat when this wiki already holds the other side', () => {
    // Ward accepted a directed challenge while unauthenticated (White=Guest); Rob forks back.
    const pgn = [
      `[White "${GUEST_PLAYER_NAME}"]`,
      '[Black "rob.chess.aolc.cc (Rob)"]',
      '[HumanPlay "correspondence"]',
      '[Result "*"]',
      '',
      '*',
    ].join('\n')
    const upgraded = upgradeGuestSeatTagsToWikiIdentity(pgn, {
      signedInDisplayName: 'Rob',
      wikiSite: 'rob.chess.aolc.cc',
    })
    assert.equal(getPgnTag(upgraded, 'White'), GUEST_PLAYER_NAME)
    assert.equal(getPgnTag(upgraded, 'Black'), 'rob.chess.aolc.cc (Rob)')

    const normalized = normalizePgnPlayers(pgn, {
      signedInDisplayName: 'Rob',
      wikiSite: 'rob.chess.aolc.cc',
    })
    assert.equal(getPgnTag(normalized, 'White'), GUEST_PLAYER_NAME)
    assert.equal(getPgnTag(normalized, 'Black'), 'rob.chess.aolc.cc (Rob)')

    const prepared = prepareWikiPgn(pgn, {
      signedInDisplayName: 'Rob',
      wikiSite: 'rob.chess.aolc.cc',
      pageOnThisWiki: true,
    })
    assert.equal(getPgnTag(prepared, 'White'), GUEST_PLAYER_NAME)
    assert.equal(getPgnTag(prepared, 'Black'), 'rob.chess.aolc.cc (Rob)')
  })

  it('offers wiki join on open seats only when browsing a remote challenge', () => {
    const pgn = buildStartPgn({
      gameType: 'human',
      ownerName: 'frank',
      wikiSite: 'frank.localhost',
      localSeat: 'b',
    })
    const offer = getSeatClaimOffer(pgn, {
      ownerName: 'elif',
      wikiSite: 'elif.localhost',
      pageOnThisWiki: false,
      wikiJoinId: 'elif.localhost (elif)',
      guestName: 'Guest',
    })
    assert.equal(offer.localId, 'elif.localhost (elif)')
    assert.equal(offer.options.length, 1)
    assert.equal(offer.options[0].seat, 'White')
    assert.equal(getPgnTag(pgn, 'Black'), 'frank.localhost (frank)')
  })

  it('blocks guests from claiming a directed wiki challenge seat', () => {
    const pgn = buildStartPgn({
      gameType: 'human',
      ownerName: 'Rob',
      wikiSite: 'rob.chess.aolc.cc',
      localSeat: 'w',
      rated: false,
      challengeTarget: 'ward.chess.aolc.cc',
      challengeCreator: 'rob.chess.aolc.cc (Rob)',
      creatorColorPref: 'Random',
    })
    assert.equal(canClaimOpenSeatAsViewer(pgn, { viewingSite: 'ward.chess.aolc.cc' }), false)
    assert.equal(
      getSeatClaimOffer(pgn, {
        wikiSite: 'ward.chess.aolc.cc',
        pageOnThisWiki: false,
        guestName: 'Guest',
      }),
      null,
    )
    const ownerOffer = getSeatClaimOffer(pgn, {
      signedInDisplayName: 'Ward',
      wikiSite: 'ward.chess.aolc.cc',
      pageOnThisWiki: false,
      wikiJoinId: 'ward.chess.aolc.cc (Ward)',
      guestName: 'Guest',
    })
    assert.ok(ownerOffer)
    assert.equal(ownerOffer.localId, 'ward.chess.aolc.cc (Ward)')
    assert.equal(ownerOffer.options[0].seat, 'Black')
    assert.equal(ownerOffer.options[0].challenge, true)
  })

  it('clears the start menu once a real PGN is saved', () => {
    const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
    const merged = mergeItemTextIntoChessObj({ showStartMenu: true, format: 'MENU' }, pgn)
    assert.equal(merged.showStartMenu, false)
    assert.equal(merged.format, 'PGN')
  })

  it('ignores autosave of the bare GAME keyword', () => {
    const ctx = { ownerName: 'alice', wikiSite: 'alice.example.com' }
    assert.equal(shouldIgnoreKeywordAutosave('GAME', 'GAME'), true)
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    assert.equal(shouldIgnoreKeywordAutosave('GAME', openBoard), true)
    const engine = buildStartPgn({ gameType: 'engine', ...ctx })
    assert.equal(shouldIgnoreKeywordAutosave('GAME', engine), false)
    assert.equal(shouldIgnoreKeywordAutosave('GAME', { move: { san: 'e4' } }), false)
  })

  it('persists a seated open game before the first move', () => {
    const ctx = { ownerName: 'alice', wikiSite: 'aa.localhost' }
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    const seated = claimSeat(openBoard, 'White', ctx)
    assert.equal(shouldIgnoreKeywordAutosave('GAME', seated), false)
  })

  it('shouldPersistChessItemText blocks bare keywords and survey tampering', () => {
    assert.equal(shouldPersistChessItemText({ itemText: 'SURVEY', nextText: 'GAME' }), false)
    assert.equal(shouldPersistChessItemText({ itemText: 'LEADERBOARD', nextText: 'GAME' }), false)
    assert.equal(
      shouldPersistChessItemText({
        itemText: 'GAME',
        nextText: 'GAME',
        bareKeywordGuard: 'GAME',
      }),
      false,
    )
    assert.equal(
      shouldPersistChessItemText({
        itemText: 'GAME',
        nextText: '[White "a"]\n[Black "b"]\n\n1. e4',
        bareKeywordGuard: 'GAME',
      }),
      true,
    )
    assert.equal(shouldPersistChessItemText({ itemText: '', nextText: 'CHOOSE' }), false)
    assert.equal(shouldPersistChessItemText({ itemText: 'GAME', nextText: 'CHOOSE' }), true)
  })

  it('detects ephemeral two-open-seat boards', () => {
    const ctx = { ownerName: 'alice', wikiSite: 'aa.localhost' }
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    assert.equal(isUnseatedFreshGamePgn(openBoard), true)
    assert.equal(isUnseatedFreshGamePgn(claimSeat(openBoard, 'White', ctx)), false)
    assert.equal(isUnseatedFreshGamePgn(buildStartPgn({ gameType: 'engine', ...ctx })), false)
  })

  it('detects page open seeks with one creator seat', () => {
    const ctx = { ownerName: 'Frank', wikiSite: 'frank.localhost', pageOnThisWiki: true }
    const openBoard = buildStartPgn({ gameType: 'open', ...ctx })
    const seated = claimSeat(openBoard, 'White', ctx)
    assert.equal(hasOneCreatorOpenSeat(openBoard), false)
    assert.equal(hasOneCreatorOpenSeat(seated), true)
    assert.equal(isPageOpenChallengePgn(seated), true)
    assert.equal(keepGhostUntilSeatsFilled(seated), true)
    assert.equal(isPageOpenChallengePgn(buildStartPgn({ gameType: 'engine', localSeat: 'w', ...ctx })), false)
  })

  describe('paste capture', () => {
    it('treats FEN and PGN as actionable paste', () => {
      const fenDetected = detectClipboardChessFormat(STARTING_FEN)
      assert.equal(fenDetected.format, 'FEN')
      assert.equal(isPasteContentValid(STARTING_FEN, fenDetected), true)
      assert.equal(resolvePasteItemText(STARTING_FEN, fenDetected), STARTING_FEN)

      const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
      const pgnDetected = detectClipboardChessFormat(pgn)
      assert.equal(pgnDetected.format, 'PGN')
      assert.equal(resolvePasteItemText(pgn, pgnDetected), pgn)
    })

    it('rejects bare keywords and unknown text', () => {
      const keyword = detectClipboardChessFormat('GAME')
      assert.equal(isPasteContentValid('GAME', keyword), false)
      assert.equal(createPasteCapturePayload('GAME').actionable, false)

      const unknown = detectClipboardChessFormat('hello world')
      assert.equal(isPasteContentValid('hello world', unknown), false)
    })

    it('rejects junk that only looks like FEN (seven slashes)', () => {
      const junk = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN x KQkq - 0 1'
      const detected = detectClipboardChessFormat(junk)
      assert.equal(detected.format, 'FEN')
      assert.equal(isPasteContentValid(junk, detected), false)
      assert.equal(createPasteCapturePayload(junk).actionable, false)
    })

    it('accepts a real FEN position', () => {
      assert.equal(isValidFenString(STARTING_FEN), true)
      assert.equal(isPasteContentValid(STARTING_FEN), true)
    })

    it('recovers the double-step that created an en-passant target', () => {
      const fen = '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1'
      assert.deepEqual(lastMoveFromEnPassantTarget(fen), { from: 'e7', to: 'e5', color: 'b' })
      assert.equal(fenBeforeEnPassantDoubleStep(fen), '4k3/4p3/8/3P4/8/8/8/4K3 b - - 0 1')
      assert.equal(lastMoveFromEnPassantTarget(STARTING_FEN), null)
      assert.equal(fenBeforeEnPassantDoubleStep(STARTING_FEN), null)
      const whiteEp = '4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1'
      assert.deepEqual(lastMoveFromEnPassantTarget(whiteEp), { from: 'd2', to: 'd4', color: 'w' })
    })

    it('allows mode keywords in the item text editor', () => {
      assert.equal(isEditableChessItemText('GAME'), true)
      assert.equal(isEditableChessItemText('PUZZLE'), true)
      assert.equal(isEditableChessItemText('PUZZLE RANDOM'), true)
      assert.equal(isEditableChessItemText('not chess junk'), false)
    })

    it('converts figurine paste to FEN item text', () => {
      const payload = createPasteCapturePayload(STARTING_FIGURINE)
      assert.equal(payload.actionable, true)
      assert.ok(payload.itemText.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'))
    })

    it('detects when pasted content matches what is already loaded', () => {
      const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
      const payload = createPasteCapturePayload(pgn)
      assert.equal(pasteMatchesCurrent(payload, pgn), true)
      assert.equal(pasteMatchesCurrent(payload, '[White "x"]\n[Black "y"]\n\n1. d4 d5'), false)
    })

    it('labels paste modal actions and builds ghost meta for new pages', () => {
      const pgn = '[White "a"]\n[Black "b"]\n\n1. e4 e5'
      const gamePayload = createPasteCapturePayload(pgn)
      assert.equal(pasteApplyLabel(true), 'Replace in this item')
      assert.equal(pasteApplyLabel(false), 'Load in this item')
      assert.equal(pasteCreateNewLabel(gamePayload), 'Create new page')
      assert.equal(buildPasteGhostMeta(gamePayload)?.chessText, pgn)
      assert.equal(buildPasteGhostMeta(gamePayload)?.paragraph, undefined)

      const fenPayload = createPasteCapturePayload(STARTING_FEN)
      assert.equal(pasteCreateNewLabel(fenPayload), 'Create new page')
      assert.equal(buildPasteGhostMeta(fenPayload)?.title, 'New Chess Position')
      assert.equal(buildPasteGhostMeta(fenPayload)?.paragraph, undefined)

      assert.equal(pasteCanReplaceCurrentItem('SURVEY'), false)
      assert.equal(pasteCanReplaceCurrentItem('LEADERBOARD'), false)
      assert.equal(pasteCanReplaceCurrentItem(pgn), true)
    })
  })

  describe('puzzle pool', () => {
    it('parses a Lichess CSV row', () => {
      const p = parsePuzzleRow(MATE_IN_2_ROW)
      assert.equal(p.id, '0042j')
      assert.deepEqual(p.moves, ['d6e5', 'd2d8', 'b6d8', 'd1d8'])
      assert.equal(p.rating, 555)
      assert.ok(p.themes.includes('mateIn2'))
    })

    it('skips the header and bad rows when parsing a CSV', () => {
      const csv = `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
${MATE_IN_2_ROW}
garbage,too,few
${MATE_IN_1_ROW}`
      const puzzles = parsePuzzlesCsv(csv)
      assert.equal(puzzles.length, 2)
    })

    it('derives the solver color from the FEN side to move', () => {
      assert.equal(puzzlePlayerColor(parsePuzzleRow(MATE_IN_2_ROW)), 'w')
    })

    it('treats odd-length move lists as player-first (no Lichess setup steal)', () => {
      const line = JSON.stringify({
        id: 'academyM201',
        fen: '6k1/6pp/8/8/8/5Q2/6PP/6K1 w - - 0 1',
        moves: ['f3f7', 'g8h8', 'f7f8'],
        themes: ['mateIn2'],
        prompt: 'Mate in two: check on f7, then mate on f8.',
      })
      const puzzle = parsePuzzleJsonLine(line)
      assert.equal(puzzle.noSetup, true)
      assert.equal(puzzlePlayerColor(puzzle), 'w')
      const solver = createPuzzleSolver(puzzle).start()
      assert.equal(solver.playerColor, 'w')
      assert.equal(solver.setupMove, null)
      assert.equal(solver.expectedMove(), 'f3f7')
      const pgn = puzzleStartPgn(puzzle)
      const chess = new Chess()
      chess.loadPgn(pgn, true)
      assert.equal(chess.turn(), 'w')
      assert.equal(chess.plyCount(), 0)
    })

    it('builds start PGN with the setup move already played', () => {
      const puzzle = parsePuzzleRow(MATE_IN_2_ROW)
      const pgn = puzzleStartPgn(puzzle)
      assert.match(pgn, /\[SetUp "1"\]/)
      assert.match(pgn, /1\.\s+\S+/)
      const chess = new Chess()
      chess.loadPgn(pgn, true)
      assert.equal(chess.plyCount(), 1)
      assert.equal(chess.turn(), puzzlePlayerColor(puzzle))
    })

    it('filters selection by theme and rating', () => {
      const puzzles = [parsePuzzleRow(MATE_IN_2_ROW), parsePuzzleRow(MATE_IN_1_ROW)]
      assert.equal(selectPuzzle(puzzles, { themes: ['mateIn1'] }).id, '00GRa')
      assert.equal(selectPuzzle(puzzles, { maxRating: 500 }).id, '00GRa')
    })

    it('walks a correct solution to solved', () => {
      const solver = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      assert.equal(solver.submitMove('d2d8').status, 'continue')
      assert.equal(solver.submitMove('d1d8').status, 'solved')
      assert.equal(solver.solved, true)
    })

    it('marks the puzzle failed on a wrong move', () => {
      const solver = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      assert.equal(solver.submitMove('c4c3').status, 'wrong')
      const illegal = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      const illegalResult = illegal.failIllegal()
      assert.equal(illegalResult.status, 'wrong')
      assert.equal(illegalResult.reason, 'illegal')
      assert.equal(illegal.failIllegal().status, 'ignored')
      assert.equal(solver.failed, true)
    })

    it('parses annotated PGN teach puzzles with variation coach text', () => {
      const teach = parseTeachPuzzleFromPgn(`[Event "How Pieces Capture"]
[FEN "4k3/8/8/8/4b3/8/4Q3/4K3 w - - 0 1"]
[SetUp "1"]

1. Qxe4 {Capture replaces the enemy piece on its square.} (1. Qe3 {Safe, but misses the free take on e4.}) *`)
      assert.ok(teach)
      assert.equal(teach.teach, true)
      assert.equal(teach.noSetup, true)
      assert.deepEqual(teach.moves, ['e2e4'])
      assert.equal(teach.comments.e2e4.includes('Capture'), true)
      assert.match(teach.wrongHints.e2e3, /e4/)
      assert.equal(puzzlePlayerColor(teach), 'w')

      const solver = createPuzzleSolver(teach).start()
      const coach = solver.submitMove('e2e3')
      assert.equal(coach.status, 'coach')
      assert.match(coach.message, /e4/)
      assert.equal(solver.failed, false)
      assert.equal(solver.submitMove('e2e4').status, 'solved')
    })

    it('accepts single-move CSV rows from teach-puzzle popup resume', () => {
      // Popup handoff serializes teach puzzles via buildPuzzleRow (CSV). One-movers
      // used to be rejected (moveList.length < 2) and the popup showed the load error.
      const teach = parseTeachPuzzleFromPgn(`PUZZLE
[Event "The Fork"]
[FEN "q3k3/8/8/3N4/8/8/8/4K3 w - - 0 1"]
[SetUp "1"]

1. Nc7+ {Royal fork — king and queen.} (1. Nf6+ {Checks the king only.}) *`)
      assert.ok(teach)
      assert.deepEqual(teach.moves, ['d5c7'])
      const csvRow = [teach.id, teach.fen, teach.moves.join(' '), '0', '0', '0', '0', '', '', ''].join(',')
      const resumed = parsePuzzleRow(csvRow)
      assert.ok(resumed, 'single-move teach CSV must parse for popup resume')
      assert.equal(resumed.noSetup, true)
      assert.equal(resumed.teach, true)
      assert.deepEqual(resumed.moves, ['d5c7'])
      assert.equal(createPuzzleSolver(resumed).start().submitMove('d5c7').status, 'solved')
    })

    it('soft-coaches unlisted legal tries on teach puzzles instead of hard-failing', () => {
      // The Chessboard: only Kd2 is the lesson move; Ke2/Kf1 have hints; Kd1 has none.
      // Hard-fail left the wrong ply on the board and froze input until Retry.
      const teach = parseTeachPuzzleFromPgn(`[Event "The Chessboard"]
[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]
[SetUp "1"]

1. Kd2 {Step one.} (1. Ke2 {Also one.}) (1. Kf1 {Also legal.}) *`)
      const solver = createPuzzleSolver(teach).start()
      const unlisted = solver.submitMove('e1d1')
      assert.equal(unlisted.status, 'coach')
      assert.match(unlisted.message, /try another/i)
      assert.equal(solver.failed, false)
      assert.equal(solver.isPlayerTurn(), true)
      assert.equal(solver.submitMove('e1d2').status, 'solved')
    })

    it('treats bare-king teach FENs as soft draws so puzzle input can stay enabled', () => {
      // How the King Moves: K vs K is gameOver in chess.js; chess-console used to skip
      // enableMoveInput. Soft-draw detection lets the puzzle console keep requesting plies.
      const bareKings = new Chess('8/8/4k3/8/4K3/8/8/8 w - - 0 1')
      assert.equal(bareKings.gameOver(), true)
      assert.equal(bareKings.insufficientMaterial(), true)
      assert.equal(isInsufficientMaterialSoftDraw(bareKings), true)

      const mate = new Chess('6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1')
      mate.move('e1e8')
      assert.equal(mate.inCheckmate(), true)
      assert.equal(isInsufficientMaterialSoftDraw(mate), false)

      const starting = new Chess(STARTING_FEN)
      assert.equal(isInsufficientMaterialSoftDraw(starting), false)
    })

    it('parses packed first-ply variations that would otherwise break cm-pgn', () => {
      const teach = parseTeachPuzzleFromPgn(`[Event "The Chessboard"]
[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]
[SetUp "1"]

1. Kd2 {Step one.} (1. Ke2 {Also one.} 1. Kf1 {Also legal.}) *`)
      assert.ok(teach, 'packed variation teach must still load (not filter chooser)')
      assert.deepEqual(teach.moves, ['e1d2'])
      assert.ok(teach.wrongHints.e1e2 || teach.wrongHints.e1f1)
    })

    it('exports and imports in-progress solver state', () => {
      const solver = createPuzzleSolver(parsePuzzleRow(MATE_IN_2_ROW)).start()
      solver.submitMove('d2d8')
      const saved = solver.exportState()
      assert.equal(saved.index, 2)
      assert.equal(saved.status, 'solving')
      solver.importState({ index: 0, status: 'solving' })
      assert.equal(solver.exportState().index, 0)
      solver.importState(saved)
      assert.equal(solver.submitMove('d1d8').status, 'solved')
    })

    it('labels puzzle sources for the puzzle bar UI', () => {
      assert.equal(formatPuzzleSourceLabel('farm'), 'Farm database')
      assert.equal(formatPuzzleSourceLabel('local'), 'On-device copy')
      assert.equal(formatPuzzleSourceLabel('lichess-api'), 'Lichess API')
      assert.equal(formatPuzzleSourceLabel('embedded'), 'Saved in this item')
      assert.equal(formatPuzzleSourceLabel('wiki-page'), 'Curated wiki page')
      assert.equal(formatPuzzleSourceLabel('farm', { itemEmbedded: true }), 'Saved in this item')
      assert.equal(formatPuzzleSourceLabel(undefined), '')

      assert.ok(formatPuzzleSourceTitle('farm').includes('wiki farm'))
      assert.ok(formatPuzzleSourceTitle('lichess-api').includes('lichess.org'))
      assert.ok(formatPuzzleSourceTitle('embedded').includes('saved'))

      assert.equal(puzzleSourceBadgeClass('farm'), 'wiki-puzzle-source-badge-farm')
      assert.equal(puzzleSourceBadgeClass('lichess-api'), 'wiki-puzzle-source-badge-lichess')
      assert.equal(puzzleSourceBadgeClass('embedded'), 'wiki-puzzle-source-badge-embedded')
      assert.equal(puzzleSourceBadgeClass('wiki-page'), 'wiki-puzzle-source-badge-embedded')
    })

    it('builds unavailable-modal copy for puzzle load failures', () => {
      const offline = puzzleUnavailableCopy('offline-no-sources', { pwaBridgeActive: true })
      assert.match(offline.message, /Download for offline play/i)
      assert.equal(offline.showRetry, true)

      const filters = puzzleUnavailableCopy('no-match')
      assert.equal(filters.showEditFilters, true)

      const popularity = puzzleUnavailableCopy('popularity-needs-farm')
      assert.match(popularity.message, /popularity/i)
      assert.equal(popularity.showEditFilters, true)
    })

    it('builds local puzzle download confirmation copy', () => {
      const enable = localPuzzleDownloadModalCopy()
      assert.match(enable.message, /full Lichess puzzle database/i)
      assert.ok(enable.notes.some(note => /wiki farm/i.test(note)))

      const filtered = localPuzzleDownloadModalCopy({
        filters: { minRating: 1500, maxRating: 2000 },
        estimate: {
          fullBytes: 300_000_000,
          filteredBytes: 45_000_000,
          filteredCount: 900_000,
          totalCount: 6_000_000,
        },
      })
      assert.ok(filtered.hasFilters)
      assert.ok(filtered.filteredLabel?.includes('45 MB'))
      assert.ok(filtered.notes.some(note => /Rating 1500–2000/.test(note)))

      const disable = localPuzzleDownloadDisableCopy()
      assert.match(disable.message, /Delete the puzzle database/i)
      assert.equal(disable.confirmClass, 'btn-danger')
      assert.equal(isLocalPuzzleDownloadInProgress(), false)
    })

    it('formats active puzzle filter labels', () => {
      assert.equal(hasActivePuzzleFilters({}), false)
      assert.equal(hasActivePuzzleFilters({ minRating: 1200 }), true)
      assert.equal(
        formatPuzzleFiltersLabel({ minRating: 1500, maxRating: 2000, themes: ['fork'] }),
        'Rating 1500–2000 · Themes: Fork',
      )
      assert.equal(puzzleThemeLabel('fork'), 'Fork')
      assert.equal(resolvePuzzleThemeKey('Mate in 2'), 'mateIn2')
      assert.equal(resolvePuzzleThemeKey('FORK'), 'fork')
      assert.ok(PUZZLE_COMMON_THEME_IDS.includes('pin'))
      assert.ok(PUZZLE_THEME_OPTIONS.some(t => t.id === 'skewer'))
      assert.equal(formatByteSize(302_000_000), '~302 MB')
    })

    it('parses next=/done= and walks smart academy next from local page JSON', () => {
      const spec = parsePuzzleSpec('next=how-the-queen-moves done=1')
      assert.equal(spec.filters.next, 'how-the-queen-moves')
      assert.equal(spec.filters.done, true)
      const teach =
        'PUZZLE next=how-the-queen-moves\n[Event "How the King Moves"]\n[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. Ke2 *'
      const marked = markPuzzleItemProgress(teach, { done: true })
      assert.match(marked, /^PUZZLE done=1 next=how-the-queen-moves\n/)
      assert.match(marked, /\[Event "How the King Moves"\]/)
      assert.equal(puzzleItemProgressFromText(marked).done, true)

      const progress = academyProgressFromLocalPages([
        {
          slug: 'how-the-king-moves',
          title: 'How the King Moves',
          story: [{ type: 'chess', text: marked }],
        },
        {
          slug: 'how-the-queen-moves',
          title: 'How the Queen Moves',
          story: [{ type: 'chess', text: 'PUZZLE next=how-the-rook-moves\n[Event "Q"]\n1. Qd4 *' }],
        },
      ])
      assert.equal(progress['how-the-king-moves'].done, true)
      assert.equal(resolveSmartAcademyNext('how-the-king-moves', progress), 'how-the-queen-moves')
      assert.equal(ADAPTIVE_COACH_DEFAULT_RATING.min, 400)
    })

    it('parses and rewrites adaptive Puzzle Coach progress on the filter line', () => {
      const spec = parsePuzzleSpec('adaptive=true rating=400..700 solved=a1,a2 failed=b1\n{"id":"x"}')
      assert.equal(spec.adaptive, true)
      assert.equal(spec.filters.adaptive, true)
      assert.equal(spec.filters.minRating, 400)
      assert.deepEqual(spec.filters.solvedIds, ['a1', 'a2'])
      assert.deepEqual(spec.filters.failedIds, ['b1'])
      assert.equal(hasActivePuzzleFilters(spec.filters), true)

      const item =
        'PUZZLE adaptive=true rating=400..700\n' +
        '{"id":"p1","fen":"4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1","moves":["e2e8"],"themes":["mateIn1"],"rating":500}'
      assert.match(puzzleBankBodyText(item), /^\{"id":"p1"/)

      const next = recordAdaptivePuzzleOutcome({ adaptive: true, minRating: 400, maxRating: 700 }, 'solved', 'p1')
      assert.deepEqual(next.solvedIds, ['p1'])
      assert.equal(next.minRating, 450)
      assert.equal(next.maxRating, 750)
      const rewritten = rewritePuzzleItemText(item, next)
      assert.match(rewritten, /^PUZZLE adaptive=true rating=450\.\.750 solved=p1\n/)
      assert.match(rewritten, /"id":"p1"/)

      const failed = recordAdaptivePuzzleOutcome(next, 'failed', 'p2')
      assert.deepEqual(failed.failedIds, ['p2'])
      assert.ok(!failed.solvedIds.includes('p2'))
      assert.equal(failed.minRating, 400)
      assert.equal(failed.maxRating, 700)

      assert.deepEqual(
        academyLinksForPuzzleThemes(['pin', 'fork', 'opening', 'pieceMove']).map(l => l.title),
        ['The Pin', 'The Fork', 'How Pieces Move'],
      )
      assert.match(buildPuzzleItemText({ adaptive: true, minRating: 400, maxRating: 700 }), /adaptive=true/)
      assert.equal(isEditableChessItemText('PUZZLE adaptive=true rating=400..700'), true)
      assert.equal(ADAPTIVE_COACH_DEFAULT_RATING.min, 400)
      assert.equal(ADAPTIVE_COACH_DEFAULT_RATING.max, 700)
    })

    it('matches puzzles against pool filters including themes', () => {
      const puzzle = { rating: 1600, popularity: 50, themes: ['fork', 'middlegame'] }
      assert.equal(puzzleMatchesFilters(puzzle, { minRating: 1500, maxRating: 2000 }), true)
      assert.equal(puzzleMatchesFilters(puzzle, { themes: ['pin'] }), false)
      assert.equal(puzzleMatchesFilters(puzzle, { themes: ['fork'] }), true)
      assert.equal(puzzleMatchesFilters(puzzle, { themes: ['fork', 'middlegame'] }), true)
      assert.equal(puzzleMatchesFilters(puzzle, { themes: ['fork', 'mateIn1'] }), false)
    })

    it('ranks recommended theme badges by co-occurrence in the filtered set', () => {
      assert.deepEqual(
        rankCommonPuzzleThemes({ pin: 3, fork: 10, mateIn1: 5, skewer: 0 }, { exclude: ['fork'] }),
        ['mateIn1', 'pin'],
      )
      assert.ok(rankCommonPuzzleThemes(null).includes('fork'))
      assert.deepEqual(rankCommonPuzzleThemes(null, { exclude: ['fork'] })[0], PUZZLE_COMMON_THEME_IDS.find(id => id !== 'fork'))
      assert.equal(rankCommonPuzzleThemes({ pin: 2 }, { exclude: ['pin'] }).includes('pin'), false)
      assert.deepEqual(rankCommonPuzzleThemes({ pin: 2, skewer: 0 }), ['pin'])
    })

    it('normalizes restored sessions where puzzle item text was stored as PGN', () => {
      const broken = {
        PGN: 'PUZZLE rating=1050..1600 themes=mateIn1',
        chessState: 'PUZZLE rating=1050..1600 themes=mateIn1',
        showStartMenu: false,
      }
      const fixed = normalizeRestoredChessSession(broken)
      assert.equal(fixed.format, 'PUZZLE')
      assert.equal(fixed.gameType, 'puzzle')
      assert.equal(fixed.chessState, 'PUZZLE rating=1050..1600 themes=mateIn1')
      assert.equal(fixed.PGN, undefined)
      assert.equal(isPuzzleState(fixed), true)
    })

    it('preserves current session keys and maps the FedWiki owner name', () => {
      const fixed = normalizeRestoredChessSession({
        pageOnThisWiki: false,
        guestLocalStoragePersist: true,
        ownerCanJournalHere: false,
        pwaJournalless: true,
        followsPopup: true,
        patchStateOnly: true,
        createPreviewPendingJournal: true,
        ownerName: 'Alice',
      })

      assert.deepEqual(fixed, {
        pageOnThisWiki: false,
        guestLocalStoragePersist: true,
        ownerCanJournalHere: false,
        pwaJournalless: true,
        followsPopup: true,
        patchStateOnly: true,
        createPreviewPendingJournal: true,
        signedInDisplayName: 'Alice',
      })
    })

    it('tags item-embedded puzzles with source embedded', () => {
      const puzzle = parseEmbeddedPuzzleContent(`${MATE_IN_2_ROW}\nFind the mate.`)
      assert.equal(puzzle.source, 'embedded')
      assert.equal(puzzle.prompt, 'Find the mate.')
    })

    it('parses JSONL puzzle banks and tags= filters', () => {
      const line = JSON.stringify({
        id: 'demo1',
        fen: '4k3/8/8/3b4/8/8/4Q3/4K3 b - - 0 1',
        moves: ['d5e4', 'e2e4'],
        tags: ['hangingPiece', 'lessonA'],
        rating: 550,
      })
      const parsed = parsePuzzleJsonLine(line)
      assert.equal(parsed.id, 'demo1')
      assert.equal(parsed.moves.length, 2)
      const bank = parsePuzzleBankContent(`tags=lessonA\n${line}\n${line.replace('demo1', 'demo2')}`)
      assert.equal(bank.puzzles.length, 2)
      assert.deepEqual(bank.filters.tags, ['lessonA'])
      assert.equal(looksLikePuzzleBankPaste(`PUZZLE\n${line}`), true)
      assert.equal(isEditableChessItemText(`PUZZLE tags=lessonA\n${line}`), true)
    })

    it('combines puzzle filters with inline and referenced curated banks', () => {
      const line = JSON.stringify({
        id: 'inline-fork',
        fen: '4k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
        moves: ['d5c7'],
        themes: ['fork'],
        rating: 900,
      })
      const spec = parsePuzzleSpec('RANDOM rating=800..1200 themes=fork pages=the-fork,old-game-puzzles')
      assert.equal(spec.random, true)
      assert.equal(spec.filters.random, true)
      assert.deepEqual(spec.filters.pageSlugs, ['the-fork', 'old-game-puzzles'])
      assert.match(buildPuzzleItemText(spec.filters), /^PUZZLE RANDOM .*pages=the-fork,old-game-puzzles/)

      const bank = parsePuzzleBankContent(
        `RANDOM rating=800..1200 themes=fork pages=the-fork,old-game-puzzles\n${line}`,
      )
      assert.equal(bank.puzzles[0].id, 'inline-fork')
      assert.deepEqual(bank.filters.pageSlugs, ['the-fork', 'old-game-puzzles'])

      const referenced = puzzlesFromReferencedPages([
        {
          slug: 'the-fork',
          title: 'The Fork',
          story: [{ type: 'chess', id: 'abc', text: `PUZZLE\n${line.replace('inline-fork', 'shared-fork')}` }],
        },
      ])
      assert.equal(referenced.length, 1)
      assert.equal(referenced[0].id, 'shared-fork')
      assert.equal(referenced[0].source, 'wiki-page')
      assert.equal(referenced[0].sourcePageSlug, 'the-fork')
    })
  })

  describe('journal symbols and open seats', () => {
    const frankWhite = `[White "frank.localhost:3001 (Frank)"]
[Black ""]

`
    const bothSeated = `[White "frank.localhost:3001 (Frank)"]
[Black "elif.localhost:3001 (Elif)"]

`

    it('detects when both seats are filled', () => {
      assert.equal(bothSeatsFilled(frankWhite), false)
      assert.equal(bothSeatsFilled(bothSeated), true)
    })

    it('uses a white seat ring when the creator posts an open challenge', () => {
      assert.equal(chessJournalSymbol('GAME', frankWhite), CHESS_SEAT_WHITE_SYMBOL)
    })

    it('uses a black seat ring when the opponent claims the open seat', () => {
      assert.equal(chessJournalSymbol(frankWhite, bothSeated), CHESS_SEAT_BLACK_SYMBOL)
    })

    it('uses crossed swords for a new game with no seat claim', () => {
      const enginePgn = `[White "Stockfish Level 6"]
[Black "frank.localhost:3001 (Frank)"]

`
      assert.equal(chessJournalSymbol('GAME', enginePgn), CHESS_CREATE_SYMBOL)
    })

    it('uses crossed swords again when a new game starts over an existing game', () => {
      const prior = `[White "olga.localhost:3001 (Olga)"]
[Black "Stockfish Level 1"]
[Result "*"]

1. Nf3`
      const restarted = `[White "olga.localhost:3001 (Olga)"]
[Black "Stockfish Level 1"]
[Result "*"]

`
      assert.equal(classifyChessSave(prior, restarted), 'create')
      assert.equal(chessJournalSymbol(prior, restarted), CHESS_CREATE_SYMBOL)
    })

    it('uses crossed swords when restarting over a seated game with no moves yet', () => {
      const prior = `[White "olga.localhost:3001 (Olga)"]
[Black "Stockfish Level 5"]
[Result "*"]

`
      const restarted = `[White "olga.localhost:3001 (Olga)"]
[Black "Stockfish Level 1"]
[Result "*"]

`
      assert.equal(classifyChessSave(prior, restarted), 'create')
      assert.equal(chessJournalSymbol(prior, restarted), CHESS_CREATE_SYMBOL)
    })

    it('still classifies PGN with figurine codepoints in comments for journal glyphs', () => {
      const movePgn = `${bothSeated}1. e4`
      const withComment = movePgn.replace('e4', 'e4 {Nice ♟ push}')
      assert.equal(getFormat(withComment), 'PGN')
      assert.equal(chessJournalSymbol(bothSeated, withComment), '♙')
    })

    it('uses the checkered flag when a game receives a final Result', () => {
      const inProgress = `${bothSeated}[Result "*"]

1. e4 e5`
      const finished = `${bothSeated}[Result "1-0"]

1. e4 e5`
      assert.equal(classifyChessSave(inProgress, finished), 'complete')
      assert.equal(chessJournalSymbol(inProgress, finished), CHESS_COMPLETE_SYMBOL)
    })

    it('uses the checkered flag when Result and trailing score land in one save', () => {
      // Resign / natural endings often append "1-0" to movetext while stamping Result.
      const inProgress = `${bothSeated}[Result "*"]

1. e4 e5 2. Nf3`
      const resigned = `${bothSeated}[Result "1-0"]
[Termination "normal"]

1. e4 e5 2. Nf3 1-0`
      assert.equal(classifyChessSave(inProgress, resigned), 'complete')
      assert.equal(chessJournalSymbol(inProgress, resigned), CHESS_COMPLETE_SYMBOL)
    })

    it('uses the checkered flag when a mating move and Result arrive together', () => {
      const beforeMate = `${bothSeated}[Result "*"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6`
      const mated = `${bothSeated}[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`
      assert.equal(classifyChessSave(beforeMate, mated), 'complete')
      assert.equal(chessJournalSymbol(beforeMate, mated), CHESS_COMPLETE_SYMBOL)
    })

    it('builds a two-step ghost journal for an open challenge', () => {
      const journal = buildOpenChallengeGhostJournal(frankWhite, { itemId: 'abc123' })
      assert.equal(journal.length, 2)
      assert.equal(journal[0].symbol, CHESS_CREATE_SYMBOL)
      assert.equal(journal[0].item.text, 'GAME')
      assert.equal(journal[1].symbol, CHESS_SEAT_WHITE_SYMBOL)
      assert.equal(journal[1].item.text, frankWhite)
    })

    it('builds a three-step join-accept ghost journal', () => {
      const journal = buildJoinAcceptGhost(frankWhite, bothSeated, {
        itemId: 'abc123',
      })
      assert.equal(journal.length, 3)
      assert.equal(journal[0].symbol, CHESS_CREATE_SYMBOL)
      assert.equal(journal[1].symbol, CHESS_SEAT_WHITE_SYMBOL)
      assert.match(journal[1].item.text, /\[White "frank\.localhost:3001 \(Frank\)"\]/)
      assert.equal(journal[2].symbol, CHESS_SEAT_BLACK_SYMBOL)
      assert.match(journal[2].item.text, /\[Black "elif\.localhost:3001 \(Elif\)"\]/)
    })

    it('builds ghost page meta and story for CHOOSE menu picks', () => {
      const gameMeta = buildCreatePreviewMeta('game')
      assert.equal(gameMeta.title, 'New Chess Game')
      assert.match(gameMeta.paragraph, /A new chess game\./i)
      assert.equal(gameMeta.chessText, 'GAME')

      const positionMeta = buildCreatePreviewMeta('position')
      assert.equal(positionMeta.title, 'New Chess Position')

      const positionStory = buildCreatePreviewStory(positionMeta, {
        itemId: 'chess1',
        paragraphId: 'para1',
      })
      assert.equal(positionStory.length, 2)
      assert.equal(positionStory[0].type, 'paragraph')
      assert.equal(positionStory[0].id, 'para1')
      assert.equal(positionStory[1].type, 'chess')
      assert.equal(positionStory[1].id, 'chess1')
      assert.equal(positionStory[1].text, 'POSITION')
      assert.equal(positionStory[1].createPreviewPendingJournal, true)

      const puzzleText = buildPuzzleItemText({ minRating: 1200, maxRating: 1400 })
      const puzzleMeta = buildCreatePreviewMeta('puzzle', { puzzleText })
      assert.equal(puzzleMeta.title, 'New Chess Puzzle')
      assert.equal(puzzleMeta.chessText, puzzleText)

      const chooseMeta = buildCreatePreviewMeta('choose')
      assert.equal(chooseMeta.title, 'New Chess page')
      assert.equal(chooseMeta.paragraph, undefined)
      assert.equal(chooseMeta.chessText, 'CHOOSE')
      const chooseStory = buildCreatePreviewStory(chooseMeta, { itemId: 'chess1' })
      assert.equal(chooseStory.length, 1)
      assert.equal(chooseStory[0].type, 'chess')
      assert.equal(chooseStory[0].text, 'CHOOSE')
      assert.equal(chooseStory[0].createPreviewPendingJournal, true)

      const challengeStory = buildCreatePreviewStory(gameMeta, {
        itemId: 'chess2',
        openChallengeSetupPending: true,
      })
      assert.equal(challengeStory.length, 1)
      assert.equal(challengeStory[0].type, 'chess')
      assert.equal(challengeStory[0].openChallengeSetupPending, true)
    })

    it('splits journal when a human challenge opens with one seated side', () => {
      assert.equal(shouldSplitOpenSeatGameJournal('GAME', frankWhite), true)
      assert.equal(shouldSplitOpenSeatGameJournal(frankWhite, bothSeated), false)
    })

    it('does not offer take-seat on an open seat to the seated page owner', () => {
      const offer = getSeatClaimOffer(frankWhite, {
        ownerName: 'Frank',
        wikiSite: 'frank.localhost:3001',
        pageOnThisWiki: true,
      })
      assert.equal(offer, null)
    })
  })

  describe('journal story rebuild', () => {
    const movePgn = `[White "a"]
[Black "b"]

1. e4`
    const itemId = 'item1'
    const chessItem = (text, extra = {}) => ({
      type: 'chess',
      id: itemId,
      text,
      ...extra,
    })

    it('detects when a game has started from movetext', () => {
      assert.equal(chessGameHasStarted('GAME'), false)
      assert.equal(chessGameHasStarted(movePgn), true)
    })

    it('rebuilds story from journal', () => {
      const journal = [
        { type: 'create', item: { title: 'Test', story: [chessItem('GAME')] } },
        {
          type: 'edit',
          id: itemId,
          item: chessItem(movePgn, { realtime: { Black: { ready: true } } }),
        },
      ]
      const story = rebuildStoryFromJournal({ title: 'Test', journal })
      assert.equal(story.length, 1)
      assert.equal(story[0].realtime.Black.ready, true)
      assert.equal(story[0].text, movePgn)
    })
  })

  describe('game settings', () => {
    it('normalizes auto-accept real-time preference', () => {
      assert.equal(mergeGameSettings({}, { autoAcceptRealtime: true }).autoAcceptRealtime, true)
      assert.equal(mergeGameSettings({ autoAcceptRealtime: true }, null).autoAcceptRealtime, true)
    })

    it('distinguishes pass-and-play board flip from opposite-sides piece flip', () => {
      assert.equal(normalizeGameSettings({}).sameDeviceFlip, false)
      assert.equal(normalizeGameSettings({}).sameDeviceFlipPieces, false)
      assert.equal(mergeGameSettings({}, { sameDeviceFlipPieces: true }).sameDeviceFlipPieces, true)
      const sameDevice = { humanPlayMode: HUMAN_PLAY_SAME_DEVICE, gameSettings: {} }
      assert.equal(shouldRotateBoardForSideToMove(sameDevice), false)
      assert.equal(shouldFlipPiecesInPlace(sameDevice), false)
      const passAndPlay = {
        humanPlayMode: HUMAN_PLAY_SAME_DEVICE,
        gameSettings: { sameDeviceFlip: true },
      }
      assert.equal(shouldRotateBoardForSideToMove(passAndPlay), true)
      const oppositeSides = {
        humanPlayMode: HUMAN_PLAY_SAME_DEVICE,
        gameSettings: { sameDeviceFlip: false, sameDeviceFlipPieces: true },
      }
      assert.equal(shouldRotateBoardForSideToMove(oppositeSides), false)
      assert.equal(shouldFlipPiecesInPlace(oppositeSides), true)
      const remote = { humanPlayMode: 'correspondence', gameSettings: { sameDeviceFlipPieces: true } }
      assert.equal(shouldFlipPiecesInPlace(remote), false)
      assert.equal(pieceSetAllowsInPlaceFlip('merida'), true)
      assert.equal(pieceSetAllowsInPlaceFlip('shapes'), false)
      assert.equal(pieceSetAllowsInPlaceFlip('SHAPES'), false)
    })

    it('normalizes showAnnotationsBelow and academy site defaults', () => {
      assert.equal(normalizeGameSettings({}).enableComments, false)
      assert.equal(normalizeGameSettings({}).showAnnotationsBelow, false)
      assert.equal(mergeGameSettings({}, { showAnnotationsBelow: true }).showAnnotationsBelow, true)
      assert.equal(isChessAcademyWikiSite('chess-academy.localhost'), true)
      assert.equal(isChessAcademyWikiSite('other.localhost'), false)
      assert.equal(siteGameSettingDefaults('chess-academy.localhost').showAnnotationsBelow, true)
      assert.deepEqual(siteGameSettingDefaults('alice.localhost'), {})
      assert.equal(parseCommentsTag('[Comments "on"]\n\n1. e4 e5 *'), 'on')
      assert.equal(parseCommentsTag('[Comments "off"]\n\n1. e4 e5 *'), 'off')
      assert.equal(parseCommentsTag('[Event "x"]\n\n1. e4 e5 *'), null)
      assert.equal(isDemoOrLessonGame('[Demo "1"]\n[Result "*"]\n\n1. e4 e5 *'), true)
      assert.equal(isDemoOrLessonGame('[Lesson "1"]\n[Result "*"]\n\n1. e4 e5 *'), true)
      assert.equal(isDemoOrLessonGame('[Result "*"]\n\n1. e4 e5 *'), false)
      assert.deepEqual(pgnGameSettingDefaults('[Comments "on"]\n\n1. e4 e5 *'), {
        enableComments: true,
        showAnnotationsBelow: true,
      })
      assert.deepEqual(pgnGameSettingDefaults('[Comments "off"]\n\n1. e4 e5 *'), {
        enableComments: false,
        showAnnotationsBelow: false,
      })
      assert.deepEqual(pgnGameSettingDefaults('[Event "x"]\n\n1. e4 e5 *'), {})
      assert.equal(parseOnOffPgnTag('[ConfirmMoves "on"]\n\n*', 'ConfirmMoves'), 'on')
      assert.equal(parseOnOffPgnTag('[SameDeviceFlip "off"]\n\n*', 'SameDeviceFlip'), 'off')
      assert.deepEqual(pgnGameSettingDefaults('[ConfirmMoves "on"]\n[SameDeviceFlip "on"]\n\n*'), {
        confirmMoves: true,
        sameDeviceFlip: true,
      })
      assert.deepEqual(pgnGameSettingDefaults('[SameDeviceFlipPieces "on"]\n\n*'), {
        sameDeviceFlipPieces: true,
      })
      // Merge order: site < personal IndexedDB prefs < PGN tags (author wins).
      assert.equal(
        mergeGameSettings(
          mergeGameSettings(siteGameSettingDefaults('chess-academy.localhost'), {
            showAnnotationsBelow: false,
            confirmMoves: false,
          }),
          pgnGameSettingDefaults('[Comments "on"]\n[ConfirmMoves "on"]'),
        ).confirmMoves,
        true,
      )
      assert.equal(
        mergeGameSettings(
          mergeGameSettings(siteGameSettingDefaults('chess-academy.localhost'), {
            showAnnotationsBelow: false,
          }),
          pgnGameSettingDefaults('[Comments "off"]'),
        ).showAnnotationsBelow,
        false,
      )
      assert.equal(
        mergeGameSettings(
          mergeGameSettings(
            siteGameSettingDefaults('chess-academy.localhost'),
            pgnGameSettingDefaults('[Comments "off"]'),
          ),
          {},
        ).showAnnotationsBelow,
        false,
      )
      assert.equal(pgnHasMoveComments('1. e4 {center} e5'), true)
      assert.equal(pgnHasMoveComments('1. e4 e5'), false)
      assert.equal(shouldViewLoadedGameFromStart('[Result "*"]\n\n1. e4 {center} e5 *'), true)
      // Finished games open at the tip (end position), not ply 0.
      assert.equal(shouldViewLoadedGameFromStart('[Result "1-0"]\n\n1. e4 e5 2. Qh5 g6 3. Qxe5# 1-0'), false)
      assert.equal(shouldViewLoadedGameFromStart('[Result "*"]\n\n1. e4 e5 *'), false)
      assert.equal(shouldViewLoadedGameFromStart('[Result "*"]\n\n*'), false)
      // Per-item override via custom PGN tag.
      assert.equal(
        shouldViewLoadedGameFromStart('[Result "1-0"]\n[StartView "start"]\n\n1. e4 e5 2. Qh5 g6 3. Qxe5# 1-0'),
        true,
      )
      assert.equal(shouldViewLoadedGameFromStart('[Result "*"]\n[StartView "end"]\n\n1. e4 {center} e5 *'), false)
      assert.equal(academyPlayTwinSite('chess-academy.localhost'), 'chess-academy-play.localhost')
      assert.equal(isAnnotatedGameChessText('GAME\n[Event "x"]\n\n1. e4 e5 *'), true)
      assert.equal(isAnnotatedGameChessText('POSITION\n4k3/8/8/8/8/8/8/4K3 w - - 0 1'), false)
      assert.equal(parsePgnParts('GAME\n[Event "x"]\n\n1. e4 *').tags.Event, 'x')
      assert.match(parsePgnParts('GAME\n[Event "x"]\n\n1. e4 *').movetext, /^1\. e4/)
      assert.match(canonicalizePersistedChessText('GAME\n[Event "x"]\n[Result "*"]\n\n1. e4 *'), /^GAME\n/)
    })

    it('normalizes auto-accept remote game endings', () => {
      assert.equal(mergeGameSettings({}, { autoAcceptOpponentWikiGameEnd: true }).autoAcceptOpponentWikiGameEnd, true)
    })

    it('ignores unused challengeSite on game settings', () => {
      const current = normalizeGameSettings({ challengeSite: 'current.example' })
      assert.equal(current.challengeSite, undefined)
    })

    it('reads directed invite target from PGN ChallengeTarget only', () => {
      const pgn = setPgnTag('[White "a"]\n[Black ""]\n\n*', 'ChallengeTarget', 'bob.example.com')
      assert.equal(challengeTargetFromPgn(pgn), 'bob.example.com')
      assert.equal(challengeOpponentWikiSite(pgn), 'bob.example.com')
      assert.equal(challengeOpponentWikiSite('[White "a"]\n[Black ""]\n\n*'), null)
    })

    it('clears and strips self ChallengeTarget tags', () => {
      const pgn = setPgnTag('[White "a"]\n[Black ""]\n\n*', 'ChallengeTarget', 'joiner.example.com')
      assert.equal(getPgnTag(clearPgnTag(pgn, 'ChallengeTarget'), 'ChallengeTarget'), null)
      assert.equal(getPgnTag(stripSelfChallengeTarget(pgn, 'joiner.example.com'), 'ChallengeTarget'), null)
      assert.equal(challengeTargetFromPgn(stripSelfChallengeTarget(pgn, 'other.example.com')), 'joiner.example.com')
    })

    it('coalesceAdoptedGameSettings ignores null remote settings', () => {
      const kept = coalesceAdoptedGameSettings(null, {
        autoAcceptOpponentWikiMoves: true,
        autoAcceptOpponentWikiGameEnd: true,
      })
      assert.equal(kept.autoAcceptOpponentWikiMoves, true)
      assert.equal(kept.autoAcceptOpponentWikiGameEnd, true)
      const fromRemote = coalesceAdoptedGameSettings(
        { autoAcceptOpponentWikiMoves: false },
        { autoAcceptOpponentWikiMoves: true },
      )
      assert.equal(fromRemote.autoAcceptOpponentWikiMoves, false)
    })

    it('remotePageMatchesExpect waits for opponent wiki to catch up', () => {
      const itemId = 'chess1'
      const older = {
        story: [{ type: 'chess', id: itemId, text: '[Result "*"]\n\n1. e4' }],
      }
      const newer = {
        story: [{ type: 'chess', id: itemId, text: '[Result "*"]\n\n1. e4 e5' }],
      }
      assert.equal(remotePageMatchesExpect(older, itemId, newer.story[0].text), false)
      assert.equal(remotePageMatchesExpect(newer, itemId, newer.story[0].text), true)
      assert.equal(chessMovetextKey(older.story[0].text) !== chessMovetextKey(newer.story[0].text), true)
    })
  })

  describe('correspondence journal planning', () => {
    const remotePgn = (whiteSite, blackSite, movetext = '') =>
      `[Event "Test"]
[White "${whiteSite} (White)"]
[Black "${blackSite} (Black)"]
[HumanPlay "${HUMAN_PLAY_CORRESPONDENCE}"]
[Result "*"]

${movetext}`.trim()

    it('splits opponent-then-own plies into fork + native steps', () => {
      const prev = remotePgn('olga.localhost:3001', 'rosa.localhost:3001', '1. e4')
      const next = remotePgn('olga.localhost:3001', 'rosa.localhost:3001', '1. e4 e5')
      const steps = planCorrespondenceJournalSteps(prev, next, {
        localSeat: 'white',
        opponentSite: 'rosa.localhost:3001',
      })
      assert.equal(steps?.length, 1)
      assert.equal(steps[0].forkSite, 'rosa.localhost:3001')
      assert.match(steps[0].text, /1\.\s*e4\s+e5/)
    })

    it('plans fork then native when journal lagged behind the board by two plies', () => {
      const prev = remotePgn('olga.localhost:3001', 'rosa.localhost:3001', '1. e4')
      const next = remotePgn('olga.localhost:3001', 'rosa.localhost:3001', '1. e4 e5 2. Nf3')
      const steps = planCorrespondenceJournalSteps(prev, next, {
        localSeat: 'white',
        opponentSite: 'rosa.localhost:3001',
      })
      assert.equal(steps?.length, 2)
      assert.equal(steps[0].forkSite, 'rosa.localhost:3001')
      assert.match(steps[0].text, /1\.\s*e4\s+e5/)
      assert.equal(steps[1].forkSite, undefined)
      assert.match(steps[1].text, /2\.\s*Nf3/)
    })

    it('resolves local seat from the viewing wiki host', () => {
      const pgn = remotePgn('olga.localhost:3001', 'rosa.localhost:3001', '1. e4')
      const ctx = resolveCorrespondenceJournalContext(pgn, { viewingSite: 'rosa.localhost:3001' })
      assert.deepEqual(ctx, {
        localSeat: 'black',
        opponentSite: 'olga.localhost:3001',
      })
    })

    it('ignores ChallengeTarget that equals the viewing wiki (joiner leftover)', () => {
      const pgn = setPgnTag(
        remotePgn('bjorn.localhost:3001', 'olga.localhost:3001', '1. e4'),
        'ChallengeTarget',
        'bjorn.localhost:3001',
      )
      const ctx = resolveCorrespondenceJournalContext(pgn, {
        viewingSite: 'bjorn.localhost:3001',
      })
      assert.deepEqual(ctx, {
        localSeat: 'white',
        opponentSite: 'olga.localhost:3001',
      })
    })

    it('reads opponent host from seated PGN tags', () => {
      assert.equal(
        opponentWikiSiteFromPgn(
          remotePgn('bjorn.localhost:3001', 'olga.localhost:3001', '1. e4'),
          'bjorn.localhost:3001',
        ),
        'olga.localhost:3001',
      )
    })

    it('canonicalizes duplicated leading PGN header blocks', () => {
      const once = remotePgn('a.localhost', 'b.localhost', '1. e4 e5')
      const headers = once.split(/\n\n/)[0]
      const dup = `${headers}\n\n${headers}\n\n1. e4 e5 *`
      assert.equal((dup.match(/\[Event /g) || []).length, 2)
      const clean = canonicalizePersistedChessText(dup)
      assert.equal((clean.match(/\[Event /g) || []).length, 1)
      assert.match(clean, /1\.\s*e4\s+e5/)
      assert.equal(normalizeExportPgn(dup), clean)
      const step = pgnThroughPlies(dup, 0)
      assert.equal((step.match(/\[Event /g) || []).length, 1)
      assert.match(step, /1\.\s*e4/)
    })

    it('strips comment-only movetext so cm-pgn can load academy preamble boards', () => {
      const raw =
        'GAME\n[Event "Opening Book"]\n[Site "Opening Book"]\n[Result "*"]\n[Comments "on"]\n\n' +
        '{Root of the Opening Book — open Starting Position, then follow To.} *'
      assert.equal(isCommentOrResultOnlyMovetext('{Root comment} *'), true)
      assert.equal(isCommentOrResultOnlyMovetext('{Root comment}'), true)
      assert.equal(isCommentOrResultOnlyMovetext('{hi} 1. e4 *'), false)
      assert.equal(pgnHasMoves(raw), false)
      const cleaned = formatPgn(raw)
      assert.ok(!cleaned.includes('{'))
      assert.match(cleaned, /\[Result "\*"\]/)
      assert.match(cleaned, /\[Comments "on"\]/)
      assert.ok(!/\n\n\*/.test(cleaned))
      assert.equal(normalizeExportPgn(raw), cleaned)
      const prepared = prepareWikiPgn(raw, {
        signedInDisplayName: 'Curator',
        wikiSite: 'chess-academy.localhost:3001',
        pageOnThisWiki: true,
      })
      assert.ok(!prepared.includes('{'))
      assert.equal(pgnHasMoves(prepared), false)
    })
  })

  describe('remote move validation', () => {
    const BASE_PGN = '[White "a"]\n[Black "b"]\n\n'

    it('accepts a single new opponent move', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['e4', 'e5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, true)
      assert.deepEqual(result.newMoves, ['e5'])
    })

    it('rejects when there is no new move', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['e4'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_NO_NEW_MOVE)
    })

    it('rejects a rewritten history', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['d4', 'd5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_HISTORY_REWRITTEN)
      assert.equal(remoteMoveContinuation(['e4'], ['d4', 'd5']), null)
    })

    it('rejects multiple plies appended at once', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: [],
        remoteSans: ['e4', 'e5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_MULTIPLE_PLIES)
    })

    it('page fork accepts multiple new plies from the opponent', () => {
      const result = validateRemotePageFork({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: ['e4'],
        remoteSans: ['e4', 'e5', 'Nf3'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, true)
      assert.deepEqual(result.newMoves, ['e5', 'Nf3'])
    })

    it('rejects a move forged for the local seat', () => {
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: BASE_PGN,
        localSans: [],
        remoteSans: ['e4'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_FORGED_SEAT)
    })

    it('rejects when the starting position changed', () => {
      const customFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
      const result = validateRemoteContinuation({
        localPgn: BASE_PGN,
        remotePgn: `[SetUp "1"]\n[FEN "${customFen}"]\n\n`,
        localSans: [],
        remoteSans: ['e5'],
        opponentColor: 'b',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, REMOTE_REJECT_START_CHANGED)
    })
  })

  describe('remote game completion', () => {
    const BASE = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "*"]

1. e4 e5`

    it('accepts an opponent resignation with the same movetext', () => {
      const remote = BASE.replace('[Result "*"]', '[Result "1-0"]')
      const result = validateRemoteGameCompletion({
        localPgn: BASE,
        remotePgn: remote,
        localSans: ['e4', 'e5'],
        remoteSans: ['e4', 'e5'],
      })
      assert.equal(result.ok, true)
      assert.deepEqual(result.newMoves, [])
    })

    it('classifies a winner prompt after opponent resignation', () => {
      const remote = BASE.replace('[Result "*"]', '[Result "1-0"]')
      const end = classifyRemoteGameEnd({
        localPgn: BASE,
        remotePgn: remote,
        localSeatColor: 'w',
      })
      assert.equal(end.ok, true)
      assert.equal(end.promptKind, 'winner-resign')
    })

    it('classifies a loser sync prompt after opponent checkmate', () => {
      const remote = `[White "alice.localhost (Alice)"]
[Black "bob.localhost (Bob)"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#`
      const end = classifyRemoteGameEnd({
        localPgn: BASE,
        remotePgn: remote,
        localSeatColor: 'w',
      })
      assert.equal(end.ok, true)
      assert.equal(end.promptKind, 'loser-sync')
    })
  })

  describe('position start modal fields', () => {
    it('shows open-challenge fields and same-device choice for human remote without a target wiki', () => {
      const fields = positionStartModalFields({
        opponent: 'human',
        humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
      })
      assert.equal(fields.isOpenChallenge, true)
      assert.equal(fields.showChallengeWrap, true)
      assert.equal(fields.showHumanColorWrap, false)
      assert.equal(fields.showRatedWrap, false)
      assert.equal(fields.showLevelWrap, false)
      assert.equal(fields.showOpponentWikiWrap, true)
      assert.equal(fields.showHumanPlayWrap, true)
    })

    it('shows open-challenge fields when human remote has no wiki site', () => {
      const fields = positionStartModalFields({
        opponent: 'human',
        humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
        opponentWikiSite: '  ',
      })
      assert.equal(fields.isOpenChallenge, true)
      assert.equal(fields.showChallengeWrap, true)
      assert.equal(fields.showRatedWrap, false)
      assert.equal(fields.showHumanPlayWrap, true)
    })

    it('shows open-challenge fields when human remote has a wiki site', () => {
      const fields = positionStartModalFields({
        opponent: 'human',
        humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
        opponentWikiSite: 'https://alice.example.co/page',
      })
      assert.equal(fields.isChallengePost, true)
      assert.equal(fields.isOpenChallenge, false)
      assert.equal(fields.showChallengeWrap, true)
      assert.equal(fields.showRatedWrap, false)
      assert.equal(fields.showOpponentWikiWrap, true)
      assert.equal(fields.showHumanColorWrap, false)
      assert.equal(fields.showHumanPlayWrap, true)
      assert.equal(fields.normalizedWikiSite, 'alice.example.co')
    })

    it('hides same-device choice when challenge-only setup is forced', () => {
      const fields = positionStartModalFields({
        opponent: 'human',
        humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
        hideHumanPlayChoice: true,
      })
      assert.equal(fields.isChallengePost, true)
      assert.equal(fields.showHumanPlayWrap, false)
    })

    it('keeps challenge-post mode blocked for unparseable wiki input', () => {
      const fields = positionStartModalFields({
        opponent: 'human',
        humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
        opponentWikiSite: 'https://[bad',
      })
      assert.equal(fields.isChallengePost, false)
      assert.equal(fields.isOpenChallenge, false)
      assert.equal(fields.wikiInputInvalidFormat, true)
      assert.equal(fields.hasWikiSiteIntent, true)
      assert.equal(fields.showHumanPlayWrap, true)
    })

    it('hides follow-up fields until an opponent is chosen', () => {
      const fields = positionStartModalFields({ opponent: '' })
      assert.equal(fields.showLevelWrap, false)
      assert.equal(fields.showRatedWrap, false)
      assert.equal(fields.showHumanPlayWrap, false)
      assert.equal(fields.showHumanColorWrap, false)
      assert.equal(fields.showChallengeWrap, false)
      assert.equal(fields.isEngine, false)
    })

    it('keeps human extras hidden until how-you-play is chosen', () => {
      const fields = positionStartModalFields({
        opponent: 'human',
        humanPlayMode: '',
      })
      assert.equal(fields.playModeChosen, false)
      assert.equal(fields.showSameDeviceWrap, false)
      assert.equal(fields.showChallengeWrap, false)
      assert.equal(fields.showOpponentWikiWrap, false)
      assert.equal(fields.showRatedWrap, false)
      assert.equal(fields.showHumanPlayWrap, true)
    })

    it('shows the human colour picker for engine games only', () => {
      assert.equal(positionStartModalFields({ opponent: 'engine' }).showHumanColorWrap, true)
      assert.equal(
        positionStartModalFields({
          opponent: 'human',
          humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
          opponentWikiSite: 'bob.example.co',
        }).showHumanColorWrap,
        false,
      )
      assert.equal(
        positionStartModalFields({ opponent: 'human', humanPlayMode: HUMAN_PLAY_SAME_DEVICE }).showHumanColorWrap,
        false,
      )
      assert.equal(
        positionStartModalFields({ opponent: 'human', humanPlayMode: HUMAN_PLAY_SAME_DEVICE }).showHumanPlayWrap,
        true,
      )
      assert.equal(
        positionStartModalFields({ opponent: 'human', humanPlayMode: HUMAN_PLAY_SAME_DEVICE }).showSameDeviceWrap,
        true,
      )
      assert.equal(
        positionStartModalFields({ opponent: 'human', humanPlayMode: HUMAN_PLAY_SAME_DEVICE }).showRatedWrap,
        false,
      )
      assert.equal(positionStartModalFields({ opponent: 'engine' }).showRatedWrap, false)
      assert.equal(
        positionStartModalFields({ opponent: 'human', humanPlayMode: HUMAN_PLAY_SAME_DEVICE }).isChallengePost,
        false,
      )
      assert.equal(
        positionStartModalFields({
          opponent: 'human',
          humanPlayMode: HUMAN_PLAY_CORRESPONDENCE,
        }).showSameDeviceWrap,
        false,
      )
      assert.equal(positionStartModalFields({ opponent: 'engine' }).showSameDeviceWrap, false)
    })

    it('parses start-modal colour choices including random', () => {
      assert.deepEqual(parseStartModalColorChoice('random'), {
        localSeat: 'w',
        creatorColor: 'random',
        isRandom: true,
      })
      assert.deepEqual(parseStartModalColorChoice('w'), {
        localSeat: 'w',
        creatorColor: 'white',
        isRandom: false,
      })
      assert.deepEqual(parseStartModalColorChoice('black'), {
        localSeat: 'b',
        creatorColor: 'black',
        isRandom: false,
      })
    })
  })

  describe('shouldRespondWithPatchStateOnly', () => {
    it('requires full boot only on the first GET_STATE reply', () => {
      assert.equal(shouldRespondWithPatchStateOnly({ initialShellStateSent: false, wikiItemEditing: false }), false)
      assert.equal(shouldRespondWithPatchStateOnly({ initialShellStateSent: true, wikiItemEditing: false }), true)
    })

    it('uses patchStateOnly while another wiki item is being text-edited', () => {
      assert.equal(shouldRespondWithPatchStateOnly({ initialShellStateSent: false, wikiItemEditing: true }), true)
    })
  })

  describe('chess session reducer', () => {
    it('starts in BOOT until shell state is received', () => {
      const initial = createInitialChessSession()
      assert.equal(initial.phase, SESSION_PHASE.BOOT)
      assert.equal(sessionHasReceivedInitialState(initial), false)
      const active = reduceChessSession(initial, { type: SESSION_ACTION.SHELL_STATE_RECEIVED })
      assert.equal(active.phase, SESSION_PHASE.ACTIVE)
      assert.equal(sessionHasReceivedInitialState(active), true)
    })

    it('SETUP defers background shell sync', () => {
      let state = reduceChessSession(createInitialChessSession(), {
        type: SESSION_ACTION.ENTER_SETUP,
        origin: 'keyword',
        pendingModalOpts: { defaultOpponent: 'engine' },
      })
      assert.equal(sessionShouldDeferNewGameSetup(state), true)
      state = reduceChessSession(state, { type: SESSION_ACTION.EXIT_SETUP })
      assert.equal(sessionShouldDeferNewGameSetup(state), false)
    })

    it('syncing blocks autosave and sounds; following blocks autosave only', () => {
      let state = createInitialChessSession()
      state = reduceChessSession(state, { type: SESSION_ACTION.SHELL_STATE_RECEIVED })
      assert.equal(sessionBlocksAutosave(state), false)
      state = reduceChessSession(state, { type: SESSION_ACTION.BEGIN_SYNC })
      assert.equal(sessionBlocksAutosave(state), true)
      assert.equal(sessionBlocksSounds(state), true)
      state = reduceChessSession(state, { type: SESSION_ACTION.END_SYNC })
      assert.equal(sessionBlocksSounds(state), false)
      state = reduceChessSession(state, {
        type: SESSION_ACTION.SET_FOLLOWS_POPUP,
        followsPopup: true,
      })
      assert.equal(sessionBlocksAutosave(state), true)
      assert.equal(sessionBlocksSounds(state), false)
    })

    it('bumps console generation to invalidate in-flight init', () => {
      let state = createInitialChessSession()
      assert.equal(sessionConsoleGeneration(state), 0)
      state = reduceChessSession(state, { type: SESSION_ACTION.BUMP_CONSOLE_GENERATION })
      assert.equal(sessionConsoleGeneration(state), 1)
    })

    it('remembers dismissed setup items and blocks reopen', () => {
      let state = reduceChessSession(createInitialChessSession(), {
        type: SESSION_ACTION.SHELL_STATE_RECEIVED,
      })
      assert.equal(
        sessionShouldReopenGameSetup(state, {
          bareKeywordGuard: 'GAME',
          itemId: 'item-1',
        }),
        true,
      )
      state = reduceChessSession(state, {
        type: SESSION_ACTION.DISMISS_SETUP_ITEM,
        itemId: 'item-1',
      })
      assert.equal(sessionShouldDismissSetupForItem(state, 'item-1'), true)
      assert.equal(
        sessionShouldReopenGameSetup(state, {
          bareKeywordGuard: 'GAME',
          itemId: 'item-1',
        }),
        false,
      )
    })
  })

  describe('resolveChessViewMode', () => {
    it('routes survey, leaderboard, puzzle, position, game, and menu states', () => {
      assert.equal(resolveChessViewMode({ format: 'SURVEY' }), CHESS_VIEW.SURVEY)
      assert.equal(resolveChessViewMode({ mode: 'LEADERBOARD' }), CHESS_VIEW.LEADERBOARD)
      assert.equal(resolveChessViewMode({ format: 'PUZZLE' }), CHESS_VIEW.PUZZLE)
      assert.equal(resolveChessViewMode({ mode: 'POSITION', FEN: START_FEN }), CHESS_VIEW.POSITION)
      assert.equal(resolveChessViewMode({ PGN: '[White "a"]\n\n1. e4' }), CHESS_VIEW.GAME)
      assert.equal(resolveChessViewMode({ showStartMenu: true }), CHESS_VIEW.MENU)
      assert.equal(resolveChessViewMode({ chessState: 'CHOOSE' }), CHESS_VIEW.MENU)
    })

    it('prefers a PGN game over a leftover FEN from the position editor', () => {
      assert.equal(
        resolveChessViewMode({
          FEN: START_FEN,
          PGN: '[White "Olga"]\n[Black "Stockfish Level 3"]\n\n1. e4 e6 2. d4',
          gameType: 'engine',
          format: 'PGN',
          mode: 'GAME',
        }),
        CHESS_VIEW.GAME,
      )
    })
  })

  it('clears stale FEN when merging PGN into a prior position shell state', () => {
    const pgn = '[White "Olga"]\n[Black "Stockfish Level 3"]\n\n1. e4 e6'
    const merged = mergeItemTextIntoChessObj(
      { mode: 'POSITION', gameType: 'position', format: 'FEN', FEN: START_FEN },
      pgn,
    )
    assert.equal(merged.format, 'PGN')
    assert.equal(merged.PGN, pgn)
    assert.equal(merged.FEN, undefined)
    assert.notEqual(merged.gameType, 'position')
    assert.notEqual(merged.mode, 'POSITION')
  })

  describe('createChessSessionController', () => {
    it('notifies popup-follow changes and exposes lifecycle helpers', () => {
      const followsPopupChanges = []
      const session = createChessSessionController({
        onFollowPopupChange: value => followsPopupChanges.push(value),
      })
      session.markShellStateReceived()
      assert.equal(session.shouldDeferNewGameSetup(), false)
      session.enterSetup({ origin: 'keyword', pendingModalOpts: { defaultOpponent: 'engine' } })
      assert.equal(session.isNewGameSetupActive(), true)
      assert.equal(session.shouldDeferNewGameSetup(), true)
      session.setFollowsPopup(true)
      assert.deepEqual(followsPopupChanges, [true])
      session.clearNewGameSetupForGameStart()
      assert.equal(session.isNewGameSetupActive(), false)
      assert.equal(session.pendingNewGameSetupModalOpts(), null)
    })

    it('stores chess state and resolved view mode', () => {
      const session = createChessSessionController()
      session.loadChessState({ format: 'SURVEY', mode: 'FULL' })
      assert.equal(session.viewMode(), CHESS_VIEW.SURVEY)
      assert.equal(session.getChessState()?.format, 'SURVEY')
      session.patchChessState({ wikiPageTitle: 'My Chess Games' })
      assert.equal(session.getChessState()?.wikiPageTitle, 'My Chess Games')
    })
  })

  describe('planChessShellPersist', () => {
    it('blocks survey items, stale reverts, and bare keywords', () => {
      assert.equal(planChessShellPersist({ isSurveyItem: true }).persist, false)
      assert.equal(planChessShellPersist({ isLeaderboardItem: true }).persist, false)
      assert.equal(planChessShellPersist({ revert: true, lastJournalWasItemEdit: false }).persist, false)
      assert.equal(
        planChessShellPersist({
          itemText: 'GAME',
          nextText: 'GAME',
          bareKeywordGuard: 'GAME',
        }).persist,
        false,
      )
    })

    it('routes puzzle, position, and game saves', () => {
      assert.equal(planChessShellPersist({ nextText: 'PUZZLE\nfen', gameType: 'puzzle' }).kind, 'puzzle')
      assert.equal(
        planChessShellPersist({
          nextText: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          gameType: 'position',
        }).kind,
        'position',
      )
      assert.equal(planChessShellPersist({ nextText: '[White "a"]\n\n1. e4', gameType: 'game' }).kind, 'game')
    })
  })

  describe('chessItemEmitKey', () => {
    it('keys embed reuse on page, item id, and trimmed item text', () => {
      assert.equal(chessItemEmitKey({ pageKey: 'my-page', itemId: 'abc', itemText: ' GAME \n' }), 'my-page/abc:GAME')
    })

    it('uses a stable key for ghost preview items', () => {
      assert.equal(
        chessItemEmitKey({
          pageKey: 'new-chess-puzzle',
          itemId: 'abc',
          itemText: 'PUZZLE',
          ghostPreview: true,
        }),
        'new-chess-puzzle/abc:ghost-preview',
      )
    })
  })

  describe('MSG contract', () => {
    it('defines current shell action names', () => {
      assert.equal(MSG.LOOKUP_SITE_DISPLAY, 'lookup-site-display')
      assert.equal(MSG.SITE_DISPLAY, 'site-display')
      assert.equal(MSG.CREATE_PREVIEW, 'create-preview')
      assert.equal(MSG.ABANDON_FETCHES, 'abandon-fetches')
      assert.equal(MSG.FETCH_UI, 'fetch-ui')
      assert.equal(MSG.ALERT_UI, 'alert-ui')
      assert.equal(MSG.SHOW_CRAWL_HITS_PAGE, 'show-crawl-hits-page')
      assert.equal(MSG.CREATE_PASTE_PREVIEW, 'create-paste-preview')
    })
  })

  describe('wiki owner auth persistence guards', () => {
    it('does not offer guest local persist while isOwner is unresolved', () => {
      assert.equal(
        canOfferGuestLocalPersist({
          isOwnerFlag: undefined,
          isPageOnCurrentWiki: false,
          pageSite: 'frank.localhost:3001',
          locationHost: 'frank.localhost:3001',
        }),
        false,
      )
    })

    it('offers guest local persist only for known non-owners on the current wiki', () => {
      assert.equal(
        canOfferGuestLocalPersist({
          isOwnerFlag: false,
          isOwner: false,
          isPageOnCurrentWiki: false,
          pageSite: 'frank.localhost:3001',
          locationHost: 'frank.localhost:3001',
        }),
        true,
      )
      assert.equal(
        canOfferGuestLocalPersist({
          isOwnerFlag: true,
          isOwner: true,
          isPageOnCurrentWiki: true,
          pageSite: 'frank.localhost:3001',
          locationHost: 'frank.localhost:3001',
        }),
        false,
      )
    })

    it('offers guest local persist for create-preview ghosts on the current wiki', () => {
      assert.equal(
        canOfferGuestLocalPersist({
          isOwnerFlag: false,
          isOwner: false,
          isPageOnCurrentWiki: false,
          isGhost: true,
          isCreatePreview: true,
          pageSite: 'chess-academy.localhost:3001',
          locationHost: 'chess-academy.localhost:3001',
        }),
        true,
      )
      assert.equal(
        canOfferGuestLocalPersist({
          isOwnerFlag: false,
          isOwner: false,
          isPageOnCurrentWiki: false,
          isGhost: true,
          isCreatePreview: false,
          pageSite: 'chess-academy.localhost:3001',
          locationHost: 'chess-academy.localhost:3001',
        }),
        false,
      )
    })

    it('defers origin journal puts until isOwner resolves', () => {
      assert.equal(
        shouldDeferOriginJournalPut({
          isOwnerFlag: undefined,
          pageSite: 'origin',
        }),
        true,
      )
      assert.equal(
        shouldDeferOriginJournalPut({
          isOwnerFlag: true,
          pageSite: 'origin',
        }),
        false,
      )
      assert.equal(
        shouldDeferOriginJournalPut({
          isOwnerFlag: undefined,
          pageSite: 'local',
        }),
        false,
      )
      assert.equal(
        shouldDeferOriginJournalPut({
          isOwnerFlag: undefined,
          pageSite: 'other.localhost:3001',
        }),
        false,
      )
    })
  })

  describe('localSessionUiPolicy', () => {
    it('derives halo, chrome, and save flags for local-only PWA sessions', () => {
      assert.deepEqual(
        localSessionUiPolicy({
          isStandalone: true,
          isPwaJournalless: true,
          sessionResolved: true,
          sessionReachable: true,
          signedIn: false,
          showStartMenu: false,
          hasWikiPageTitle: false,
          canJournal: false,
        }),
        {
          showHalo: true,
          showPwaPageChrome: true,
          showSaveToWiki: true,
          titleEditable: true,
          titleAsLink: false,
        },
      )
      assert.equal(
        localSessionUiPolicy({
          isStandalone: true,
          isPwaJournalless: true,
          sessionResolved: true,
          canJournal: true,
        }).showHalo,
        false,
      )
    })

    it('shows link chrome for signed-in journal targets without editable title', () => {
      const policy = localSessionUiPolicy({
        isStandalone: true,
        isPwaJournalless: false,
        sessionResolved: true,
        signedIn: true,
        showStartMenu: false,
        hasWikiPageTitle: true,
        hasWikiPageSlug: true,
        canJournal: true,
      })
      assert.equal(policy.showPwaPageChrome, true)
      assert.equal(policy.titleEditable, false)
      assert.equal(policy.titleAsLink, true)
      assert.equal(policy.showSaveToWiki, false)
    })

    it('does not treat title-only chrome as a wiki page link', () => {
      const policy = localSessionUiPolicy({
        isStandalone: true,
        isPwaJournalless: false,
        sessionResolved: true,
        signedIn: true,
        showStartMenu: false,
        hasWikiPageTitle: true,
        hasWikiPageSlug: false,
        canJournal: true,
      })
      assert.equal(policy.showPwaPageChrome, true)
      assert.equal(policy.titleEditable, false)
      assert.equal(policy.titleAsLink, false)
    })

    it('keeps title editable while create/join is pending', () => {
      const policy = localSessionUiPolicy({
        isStandalone: true,
        isPwaJournalless: false,
        sessionResolved: true,
        signedIn: true,
        showStartMenu: false,
        hasWikiPageTitle: true,
        pendingJoinOrItem: true,
        canJournal: true,
      })
      assert.equal(policy.showPwaPageChrome, true)
      assert.equal(policy.titleEditable, true)
      assert.equal(policy.titleAsLink, false)
    })
  })

  describe('pwaMatchesLinkedWikiTab', () => {
    it('matches on itemId and accepts matching or missing slug', () => {
      assert.equal(
        pwaMatchesLinkedWikiTab(
          { itemId: 'abc', slug: 'welcome-visitors' },
          { itemId: 'abc', slug: 'welcome-visitors' },
        ),
        true,
      )
      assert.equal(pwaMatchesLinkedWikiTab({ itemId: 'abc', slug: 'welcome-visitors' }, { itemId: 'abc' }), true)
      assert.equal(
        pwaMatchesLinkedWikiTab({ itemId: 'abc', slug: 'welcome-visitors' }, { itemId: 'abc', slug: 'other-page' }),
        false,
      )
      assert.equal(pwaMatchesLinkedWikiTab({ itemId: 'abc' }, { itemId: 'xyz' }), false)
    })
  })

  describe('createMessageDispatcher', () => {
    it('invokes handlers by action name', () => {
      let seen = null
      const dispatch = createMessageDispatcher({
        ping: (payload, extra) => {
          seen = { payload, extra }
        },
      })
      assert.equal(dispatch('ping', { data: { action: 'ping' } }, 1), true)
      assert.deepEqual(seen, { payload: { data: { action: 'ping' } }, extra: 1 })
      assert.equal(dispatch('missing'), false)
    })
  })

  describe('shouldKeepActiveShellSync', () => {
    it('keeps an unchanged in-progress game on sync-only SET_STATE', () => {
      const prev = { PGN: '[Event "?"]\n1. e4 *', chessState: '[Event "?"]\n1. e4 *' }
      const incoming = {
        patchStateOnly: true,
        PGN: prev.PGN,
        chessState: prev.chessState,
      }
      assert.equal(
        shouldKeepActiveShellSync(incoming, prev, {
          activePage: id => id === 'game',
          hasChessConsole: true,
        }),
        true,
      )
    })

    it('ignores sync-only updates when item text changed', () => {
      const prev = { PGN: '1. e4', chessState: '1. e4' }
      const incoming = { patchStateOnly: true, PGN: '1. d4', chessState: '1. d4' }
      assert.equal(
        shouldKeepActiveShellSync(incoming, prev, {
          activePage: id => id === 'game',
          hasChessConsole: true,
        }),
        false,
      )
    })

    it('keeps an in-progress game when shell resync only rewrites headers', () => {
      const prev = {
        PGN: '[White "Alice"]\n\n1. e4 e5 *',
        chessState: '[White "Alice"]\n\n1. e4 e5 *',
      }
      const incoming = {
        patchStateOnly: true,
        PGN: '[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
        chessState: '[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *',
      }
      assert.equal(
        shouldKeepActiveShellSync(incoming, prev, {
          activePage: id => id === 'game',
          hasChessConsole: true,
        }),
        true,
      )
    })

    it('ignores stale CHOOSE replay while puzzle mode is booting on a ghost page', () => {
      const prev = {
        mode: 'PUZZLE',
        format: 'PUZZLE',
        gameType: 'puzzle',
        chessState: 'PUZZLE RANDOM',
      }
      const incoming = {
        patchStateOnly: true,
        showStartMenu: true,
        format: 'MENU',
        mode: 'CHOOSE',
        chessState: 'CHOOSE',
      }
      assert.equal(isStaleGhostChooseShellSync(incoming, prev), true)
      assert.equal(
        shouldKeepActiveShellSync(incoming, prev, {
          activePage: id => id === 'puzzle',
        }),
        true,
      )
    })

    it('ignores stale CHOOSE replay while game mode is booting before the console exists', () => {
      const prev = {
        mode: 'GAME',
        format: 'PGN',
        gameType: 'open',
        bareKeywordGuard: 'GAME',
        PGN: '[Event "?"]\n[White "?"]\n[Black "?"]\n\n *',
        chessState: '[Event "?"]\n[White "?"]\n[Black "?"]\n\n *',
      }
      const incoming = {
        patchStateOnly: true,
        showStartMenu: true,
        format: 'MENU',
        mode: 'CHOOSE',
        chessState: 'CHOOSE',
      }
      assert.equal(
        shouldKeepActiveShellSync(incoming, prev, {
          activePage: id => id === 'game',
          hasChessConsole: false,
        }),
        true,
      )
    })

    it('keeps SURVEY / LEADERBOARD when shell sync would navigate to CHOOSE', () => {
      assert.equal(isMaintenanceChessItemText('SURVEY'), true)
      assert.equal(isMaintenanceChessItemText('LEADERBOARD'), true)
      assert.equal(isMaintenanceChessState({ format: 'SURVEY', mode: 'FULL' }), true)
      assert.equal(isMaintenanceChessState({ format: 'LEADERBOARD' }), true)

      const surveyPrev = { format: 'SURVEY', mode: 'FULL', chessState: 'SURVEY' }
      const lbPrev = { format: 'LEADERBOARD', mode: 'LEADERBOARD', chessState: 'LEADERBOARD' }
      const chooseIncoming = {
        patchStateOnly: true,
        showStartMenu: true,
        format: 'MENU',
        mode: 'CHOOSE',
        chessState: 'CHOOSE',
        followsPopup: true,
      }
      assert.equal(
        shouldKeepActiveShellSync(chooseIncoming, surveyPrev, {
          activePage: id => id === 'leaderboard',
        }),
        true,
      )
      assert.equal(
        shouldKeepActiveShellSync(chooseIncoming, lbPrev, {
          activePage: id => id === 'leaderboard',
        }),
        true,
      )
    })
  })

  describe('game sync coordinator (pure)', () => {
    const localPgn = '[Event "?"]\n\n1. e4 e5 2. Nf3 *'
    const remotePgn = '[Event "?"]\n\n1. e4 e5 2. Nf3 Nc6 *'

    it('counts plies from PGN movetext', () => {
      assert.equal(gamePlyCount(localPgn), 3)
      assert.equal(gamePlyCount(remotePgn), 4)
    })

    it('rejects stale remote updates behind local ply epoch', () => {
      const verdict = evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: localPgn,
        source: GAME_SYNC_SOURCE.REMOTE_POLL,
        localPlyEpoch: 4,
      })
      assert.equal(verdict.accept, false)
      assert.equal(verdict.reason, 'stale-ply')
    })

    it('rejects remote updates while shell sync is applying', () => {
      const verdict = evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: remotePgn,
        source: GAME_SYNC_SOURCE.REMOTE_POLL,
        applying: true,
      })
      assert.equal(verdict.accept, false)
      assert.equal(verdict.reason, 'sync-in-progress')
    })

    it('accepts shell SET_STATE when incoming ply is current', () => {
      const verdict = evaluateGameSyncUpdate({
        localPgn,
        incomingPgn: remotePgn,
        source: GAME_SYNC_SOURCE.SHELL_SET_STATE,
        localPlyEpoch: 3,
      })
      assert.equal(verdict.accept, true)
    })

    it('preferRicherGameText keeps the side with more plies', () => {
      assert.equal(preferRicherGameText(remotePgn, localPgn), remotePgn)
      assert.equal(preferRicherGameText(localPgn, remotePgn), remotePgn)
      assert.equal(preferRicherGameText('', remotePgn), remotePgn)
      assert.equal(preferRicherGameText(localPgn, ''), localPgn)
      assert.equal(preferRicherGameText(localPgn, localPgn), localPgn)
    })
  })

  it('normalizes piece set ids and defaults to Merida', () => {
    assert.equal(normalizePieceSetId('merida'), 'merida')
    assert.equal(normalizePieceSetId('  CHESSNUT '), 'chessnut')
    assert.equal(normalizePieceSetId('staunty'), DEFAULT_PIECE_SET_ID)
    assert.equal(normalizePieceSetId('standard'), 'cburnett')
    assert.equal(getPieceSetById('kiwen-suwi').spriteFile, 'pieces/kiwen-suwi.svg')
    assert.equal(getPieceSetById('cburnett').sourceUrl.includes('/cburnett'), true)
    assert.equal(PIECE_SETS.length, 9)
    assert.equal(getPieceSetById(null).id, DEFAULT_PIECE_SET_ID)
  })

  it('normalizes color theme preference and resolves auto from OS', () => {
    assert.equal(normalizeColorThemeId('DARK'), 'dark')
    assert.equal(normalizeColorThemeId('nope'), DEFAULT_COLOR_THEME_ID)
    assert.equal(nextColorThemeId('auto'), 'light')
    assert.equal(nextColorThemeId('light'), 'dark')
    assert.equal(nextColorThemeId('dark'), 'auto')
    assert.equal(resolveColorTheme('auto', true), 'dark')
    assert.equal(resolveColorTheme('auto', false), 'light')
    assert.equal(resolveColorTheme('light', true), 'light')
  })
})
