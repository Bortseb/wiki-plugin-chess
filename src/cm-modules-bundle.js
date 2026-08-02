/**
 * Browser bundle entry — chess-console, Stockfish UI glue, and wiki-specific board widgets.
 *
 * Built to client/cm-modules-bundle.js and loaded at runtime by chess-app.js (kept
 * external so the main app bundle stays smaller). Source lives alongside chess-app
 * in src/ so source and built filenames match.
 */
import { HistoryControl } from 'chess-console/src/components/HistoryControl.js'
import { GameControl } from 'chess-console/src/components/GameControl/GameControl.js'
import { LocalPlayer } from 'chess-console/src/players/LocalPlayer.js'
import { COLOR } from 'cm-chess/src/Chess.js'
import { PIECES } from 'cm-chess/src/Chess.js'
import { COLOR as BOARD_COLOR } from 'cm-chessboard/src/Chessboard.js'
import { ChessboardView } from 'cm-chessboard/src/view/ChessboardView.js'
import { Observe } from 'cm-web-modules/src/observe/Observe.js'
import { DomUtils } from 'cm-web-modules/src/utils/DomUtils.js'
import { html } from 'chess-console/src/utils/html.js'
import { ChessRender } from 'chess-console/src/tools/ChessRender.js'
import { CapturedPieces } from 'chess-console/src/components/CapturedPieces.js'
import { UiComponent } from 'cm-web-modules/src/app/Component.js'
import { ENGINE_STATE } from 'cm-engine-runner/src/EngineRunner.js'
import { StockfishRunner, LEVELS } from 'cm-engine-runner/src/StockfishRunner.js'
import {
  fenBeforeEnPassantDoubleStep,
  lastMoveFromEnPassantTarget,
  stockfishLevelElo,
} from './chess-core.js'
import 'bootstrap-show-modal/src/ShowModal.js'

// # Staunty Figures

const PIECE_TYPES = ['K', 'Q', 'R', 'B', 'N', 'P']
// Shared with cm-chessboard `assetsCache` so board + history resolve the same in-document sprite.
const BOARD_SPRITE_WRAPPER_ID = 'cm-chessboard-sprite'

let cachePromise = null
let cachedSpriteUrl = null

export function clearPieceSpriteCache() {
  cachePromise = null
  cachedSpriteUrl = null
  document.getElementById(BOARD_SPRITE_WRAPPER_ID)?.remove()
}

function spriteWrapperHasSvg(wrapperId) {
  return Boolean(document.getElementById(wrapperId)?.querySelector('svg'))
}

function waitForSpriteWrapper(wrapperId) {
  return new Promise(resolve => {
    const check = () => {
      if (spriteWrapperHasSvg(wrapperId)) {
        resolve()
        return
      }
      requestAnimationFrame(check)
    }
    check()
  })
}

// Without a service worker, sprite fetch is async. cm-chessboard draws `<use href="#wk">`
// immediately — if the sprite wrapper is still empty, the board stays blank until redraw.
function redrawChessboardViewPieces(view) {
  try {
    view?.redrawPieces?.()
  } catch {
    /* board may already be destroyed */
  }
}

// Ensure piece sprites are inlined once under `#cm-chessboard-sprite`.
// Chrome (incl. Android) often drops `fill="url(#…)"` paints when `<use>` points at an
// external SVG file — Merida white K/Q then render as solid dark silhouettes. In-document
// `#wk` refs keep gradients/filters working. Paint-server ids in each set file are
// prefixed (`merida-wk-a`, `shapes-wk-a`, …) so sets cannot collide on `#wk-a`.
// Prefer `style="fill:…"` (or paint-server urls) over presentation `fill="…"` / shared CSS
// classes — Chrome `<use href="#wk">` inherits host fill and overrides presentation attrs
// and colliding class rules (Kosal wk/wq went solid black that way).
export function ensurePieceSpriteCached(spriteUrl = './assets/pieces/merida.svg') {
  if (cachePromise && cachedSpriteUrl === spriteUrl && spriteWrapperHasSvg(BOARD_SPRITE_WRAPPER_ID)) {
    return cachePromise
  }

  if (cachedSpriteUrl !== spriteUrl) {
    clearPieceSpriteCache()
  }

  cachedSpriteUrl = spriteUrl
  cachePromise = new Promise((resolve, reject) => {
    if (spriteWrapperHasSvg(BOARD_SPRITE_WRAPPER_ID)) {
      resolve()
      return
    }

    // Board may already have created the wrapper and be loading via XHR.
    if (document.getElementById(BOARD_SPRITE_WRAPPER_ID)) {
      waitForSpriteWrapper(BOARD_SPRITE_WRAPPER_ID).then(resolve).catch(reject)
      return
    }

    const wrapper = document.createElement('div')
    wrapper.id = BOARD_SPRITE_WRAPPER_ID
    wrapper.setAttribute('aria-hidden', 'true')
    wrapper.style.cssText = 'position:absolute;transform:scale(0);pointer-events:none'
    document.body.appendChild(wrapper)

    fetch(spriteUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to load piece sprite: ${response.status}`)
        }
        return response.text()
      })
      .then(markup => {
        wrapper.insertAdjacentHTML('afterbegin', markup)
        resolve()
      })
      .catch(reject)
  })

  return cachePromise
}

// cm-chessboard's cacheSpriteToDiv fires XHR without waiting and skips entirely when the
// wrapper already exists (e.g. survey prefetch). Redraw pieces once the SVG is present so
// cold loads without a SW do not leave a blank board.
const _cacheSpriteToDiv = ChessboardView.prototype.cacheSpriteToDiv
ChessboardView.prototype.cacheSpriteToDiv = function cacheSpriteToDivThenRedraw(wrapperId, url) {
  const existing = document.getElementById(wrapperId)
  if (existing) {
    if (spriteWrapperHasSvg(wrapperId)) return
    waitForSpriteWrapper(wrapperId).then(() => redrawChessboardViewPieces(this))
    return
  }
  _cacheSpriteToDiv.call(this, wrapperId, url)
  waitForSpriteWrapper(wrapperId).then(() => redrawChessboardViewPieces(this))
}

export function stauntySpriteId(colorChar, pieceLetter) {
  return `${colorChar}${String(pieceLetter).toLowerCase()}`
}

function stauntyUseHref(spriteId) {
  return `#${spriteId}`
}

export function stauntyPieceSvg(
  _spriteUrl,
  colorChar,
  pieceLetter,
  size = 28,
  { className = 'wiki-staunty-piece-svg', wrapClass = 'wiki-staunty-piece' } = {},
) {
  const spriteId = stauntySpriteId(colorChar, pieceLetter)
  const href = stauntyUseHref(spriteId)
  return (
    `<span class="${wrapClass}">` +
    `<svg class="${className}" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">` +
    `<use href="${href}" xlink:href="${href}"></use></svg></span>`
  )
}

export function createStauntyFigures(spriteUrl = './assets/pieces/merida.svg', size = 18) {
  const figures = {}
  for (const colorChar of ['w', 'b']) {
    const suffix = colorChar
    for (const letter of PIECE_TYPES) {
      figures[`${letter}${suffix}`] = stauntyPieceSvg(spriteUrl, colorChar, letter, size, {
        wrapClass: 'wiki-staunty-piece wiki-staunty-piece-inline',
      })
    }
  }
  return figures
}

export function renderSanFigures(san, color, figures) {
  if (!san || !figures) return san || ''
  const suffix = color === 'b' ? 'b' : 'w'
  const match = san.match(/^([NBRQK])(.*)$/)
  if (!match) return san
  const fig = figures[`${match[1]}${suffix}`]
  return fig ? `${fig}${match[2]}` : san
}

// # Wiki History

export class WikiHistory {
  constructor(chessConsole, props = {}) {
    this.context = chessConsole.componentContainers.left.querySelector('.chess-console-history')
    this.chessConsole = chessConsole
    this.element = document.createElement('div')
    this.element.setAttribute('class', 'history')
    this.context.appendChild(this.element)
    this.props = {
      notationType: 'figures',
      makeClickable: true,
      spriteUrl: './assets/pieces/merida.svg',
      ...props,
    }
    this.chessConsole.state.observeChess(() => {
      this.redraw()
    })
    Observe.property(chessConsole.state, 'plyViewed', () => {
      this.redraw()
    })
    if (this.props.makeClickable) {
      this.addClickEvents()
    }
    this.i18n = chessConsole.i18n
    this.i18n
      .load({
        de: { game_history: 'Spielnotation' },
        en: { game_history: 'Game notation' },
      })
      .then(() => {
        ensurePieceSpriteCached(this.props.spriteUrl).then(() => this.redraw())
      })
  }

  addClickEvents() {
    this.clickHandler = DomUtils.delegate(this.element, 'click', '.ply', event => {
      const cell = event.target.closest?.('.ply') || event.target
      const ply = parseInt(cell.getAttribute('data-ply'), 10)
      if (ply <= this.chessConsole.state.chess.history().length) {
        this.chessConsole.state.plyViewed = ply
      }
    })
    this.element.classList.add('clickable')
  }

  removeClickEvents() {
    this.clickHandler.remove()
    this.element.classList.remove('clickable')
  }

  getPlyClass(plyNumber) {
    const plyViewed = this.chessConsole.state.plyViewed
    if (plyViewed === plyNumber) return 'active'
    if (plyViewed < plyNumber) return 'text-muted'
    return ''
  }

  formatSan(san, color) {
    if (!san) return ''
    if (this.props.notationType !== 'figures') {
      return ChessRender.san(san, color, this.i18n.lang, this.props.notationType)
    }
    return renderSanFigures(san, color, this.chessConsole.props.figures)
  }

  // The full comment text attached to a move (any of cm-pgn's three slots).
  moveCommentText(move) {
    if (!move) return ''
    return [move.commentBefore, move.commentMove, move.commentAfter].filter(Boolean).join(' ').trim()
  }

  // A small speech-bubble marker after a commented move; the comment shows as a
  // tooltip. `html` does not escape, so the title is escaped by hand.
  commentMarker(text) {
    if (!text) return ''
    const safe = String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return ` <span class="ply-comment" title="${safe}" aria-label="Has a comment">\u{1F4AC}</span>`
  }

  redraw() {
    window.clearTimeout(this.redrawDebounce)
    this.redrawDebounce = setTimeout(() => {
      const history = this.chessConsole.state.chess.history()
      const rows = []

      // Always show at least the first move number, so a fresh game reads
      // "1." with empty cells while it waits for White's opening move.
      const rowCount = Math.max(1, Math.ceil(history.length / 2))

      for (let r = 0; r < rowCount; r += 1) {
        const i = r * 2
        const moveNumber = i / 2 + 1
        const whitePly = i + 1
        const blackPly = i + 2
        const moveWhite = history[i]
        const moveBlack = history[i + 1]

        const sanWhite = moveWhite ? this.formatSan(moveWhite.san, COLOR.white) : ''
        const sanBlack = moveBlack ? this.formatSan(moveBlack.san, COLOR.black) : ''
        const markWhite = moveWhite ? this.commentMarker(this.moveCommentText(moveWhite)) : ''
        const markBlack = moveBlack ? this.commentMarker(this.moveCommentText(moveBlack)) : ''

        // .wiki-ply-san keeps figurine + SAN on one line; the cell itself may wrap
        // (only the comment marker breaks) so the list never scrolls horizontally.
        rows.push(html`
          <tr>
            <td class="num">${moveNumber}.</td>
            <td data-ply="${whitePly}" class="ply ${this.getPlyClass(whitePly)} ply${whitePly}">
              <span class="wiki-ply-san">${sanWhite}</span>${markWhite}
            </td>
            <td data-ply="${blackPly}" class="ply ${this.getPlyClass(blackPly)} ply${blackPly}">
              <span class="wiki-ply-san">${sanBlack}</span>${markBlack}
            </td>
          </tr>
        `)
      }

      this.element.innerHTML = html`
        <h2 class="visually-hidden">${this.i18n.t('game_history')}</h2>
        <table>
          ${rows}
        </table>
      `

      // Keep the viewed ply in view inside `.wiki-chess-history-scroll`.
      // Use getBoundingClientRect vs the scroll box (not offsetParent walks — the
      // container is often unpositioned). Avoid element.scrollIntoView so the wiki
      // page / iframe itself does not jump.
      // ply 0 = start position (no active cell) — scroll to the top so opening
      // moves are visible instead of leaving the list parked at the end.
      const plyViewed = this.chessConsole.state.plyViewed
      const scrollEl = this.element.closest('.wiki-chess-history-scroll')
      if (scrollEl && plyViewed <= 0) {
        scrollEl.scrollTop = 0
      } else if (plyViewed > 0) {
        const plyElement = this.element.querySelector('.ply' + plyViewed)
        const plyScrollEl = plyElement?.closest('.wiki-chess-history-scroll') || scrollEl
        if (plyElement && plyScrollEl) {
          const elRect = plyElement.getBoundingClientRect()
          const scRect = plyScrollEl.getBoundingClientRect()
          const padTop = parseFloat(getComputedStyle(plyScrollEl).paddingTop) || 0
          const padBottom = parseFloat(getComputedStyle(plyScrollEl).paddingBottom) || 0
          // Keep a little slack so the active ring isn’t flush against the clip edge.
          const slack = 4
          const topLimit = scRect.top + padTop + slack
          const bottomLimit = scRect.bottom - padBottom - slack
          if (elRect.top < topLimit) {
            plyScrollEl.scrollTop -= topLimit - elRect.top
          } else if (elRect.bottom > bottomLimit) {
            plyScrollEl.scrollTop += elRect.bottom - bottomLimit
          }
        }
      }
    })
  }
}

// # Wiki Captured Pieces

function stauntyPieceMarkup(spriteUrl, pieceCaptured, colorChar, ply, size, count = 1) {
  const pieceHtml = stauntyPieceSvg(spriteUrl, colorChar, pieceCaptured, size, {
    className: 'wiki-captured-piece-svg',
    wrapClass: 'wiki-captured-piece-sprite',
  })
  const badge = count > 1 ? `<span class="wiki-captured-count">${count}</span>` : ''
  return `<span class="piece wiki-captured-piece" role="button" data-ply="${ply}">${pieceHtml}${badge}</span>`
}

// Lowest material value → highest. Knight before bishop at equal value (3).
const CAPTURE_DISPLAY_ORDER = ['P', 'N', 'B', 'R', 'Q']

function emptyCapturedSlot() {
  return '<span class="wiki-captured-piece wiki-captured-piece-empty" aria-hidden="true"></span>'
}

// One entry per piece type; last ply wins for click-to-jump.
function bumpCaptureGroup(map, piece, ply) {
  const group = map.get(piece)
  if (group) {
    group.count += 1
    group.ply = ply
  } else {
    map.set(piece, { piece, ply, count: 1 })
  }
}

export class WikiCapturedPieces extends CapturedPieces {
  constructor(chessConsole, props = {}) {
    super(chessConsole)
    this.spriteUrl = props.spriteUrl || './assets/pieces/merida.svg'
    this.pieceSize = props.pieceSize || 28
    this.i18n.load({ en: { captured_pieces: 'Captured Pieces' } }).then(() => this.redraw())
    ensurePieceSpriteCached(this.spriteUrl).then(() => this.redraw())
    // Summary strip mirrors captures; stopPropagation so a ply jump doesn't toggle the drawer.
    const summary = document.querySelector('.wiki-chess-captured-summary')
    if (summary && !summary._wikiCapturedWired) {
      summary._wikiCapturedWired = true
      DomUtils.delegate(summary, 'click', '.piece', event => {
        event.preventDefault()
        event.stopPropagation()
        const ply = event.target.closest?.('.piece')?.getAttribute('data-ply')
        if (ply != null) this.chessConsole.state.plyViewed = parseInt(ply, 10)
      })
    }
  }

  // Points column, then slots in CAPTURE_DISPLAY_ORDER. `types` is shared by white and
  // black so matching piece types share a column; missing types get an empty spacer.
  renderAlignedRow(groups, colorChar, types, points) {
    let output = '<div class="wiki-captured-row">'
    if (points > 0) {
      output += `<small class="wiki-captured-points" title="Material points">${points}</small>`
    } else if (types.length > 0) {
      output += '<small class="wiki-captured-points wiki-captured-points-empty" aria-hidden="true"></small>'
    }
    if (types.length > 0) {
      output += '<span class="wiki-captured-board">'
      for (const piece of types) {
        const group = groups.get(piece)
        if (!group) {
          output += emptyCapturedSlot()
          continue
        }
        output += stauntyPieceMarkup(
          this.spriteUrl,
          piece,
          colorChar,
          group.ply,
          this.pieceSize,
          group.count,
        )
      }
      output += '</span>'
    }
    output += '</div>'
    return output
  }

  redraw() {
    window.clearTimeout(this.redrawDebounce)
    this.redrawDebounce = setTimeout(() => {
      const groupsWhite = new Map()
      const groupsBlack = new Map()
      const history = this.chessConsole.state.chess.history({ verbose: true })
      // plyViewed is 1-based (fenOfPly uses history[ply-1]); only count captures that
      // have already happened at the viewed position — never "future" muted leftovers,
      // which used to re-split stacks and break sort/align while scrubbing history.
      const plyViewed = this.chessConsole.state.plyViewed
      let pointsWhite = 0
      let pointsBlack = 0
      history.forEach((move, index) => {
        if (index >= plyViewed) return
        if (move.flags.indexOf('c') === -1 && move.flags.indexOf('e') === -1) return
        const piece = move.captured.toUpperCase()
        const value = PIECES[piece.toLowerCase()]?.value || 0
        if (move.color === 'b') {
          bumpCaptureGroup(groupsWhite, piece, move.ply)
          pointsWhite += value
        } else if (move.color === 'w') {
          bumpCaptureGroup(groupsBlack, piece, move.ply)
          pointsBlack += value
        }
      })
      // Shared column set: every type either side has taken so far, low→high value.
      const types = CAPTURE_DISPLAY_ORDER.filter(
        piece => groupsWhite.has(piece) || groupsBlack.has(piece),
      )
      const outputWhite = this.renderAlignedRow(groupsWhite, 'w', types, pointsWhite)
      const outputBlack = this.renderAlignedRow(groupsBlack, 'b', types, pointsBlack)
      const rows = this.chessConsole.state.orientation === 'w' ? outputWhite + outputBlack : outputBlack + outputWhite
      this.element.innerHTML = `<h3 class="wiki-captured-heading">${this.i18n.t('captured_pieces')}</h3>` + rows
      // The game panel's collapsed "captured pieces" summary mirrors captures
      // (white/black rows stacked, same sprite size as this panel) so the drawer can
      // collapse without hiding what was taken.
      const summary = document.querySelector('.wiki-chess-captured-summary')
      if (summary) summary.innerHTML = rows
    })
  }
}

// # Stockfish State View

export class StockfishStateView extends UiComponent {
  constructor(chessConsole, player, props = {}) {
    super(undefined, props)
    this.chessConsole = chessConsole
    this.player = player
    this.props = {
      spinnerIcon: 'spinner',

      thinkingPlacement: 'player-label',
      playerBarSelector: '.wiki-chess-player-bar',
      thinkingSlotSelector: '.wiki-chess-thinking',
      scoreSlotSelector: '.wiki-chess-engine-score',
      ...props,
    }
    const i18n = chessConsole.i18n
    this.numberFormat = new Intl.NumberFormat(i18n.locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })
    Observe.property(player.state, 'level', () => {
      this.updatePlayerName()
      this.updateThinkingIndicator()
    })
    Observe.property(player.state, 'engineState', () => {
      this.updateThinkingIndicator()
    })
    Observe.property(this.chessConsole.state, 'orientation', () => {
      this.updateThinkingIndicator()
      this.refreshScore()
    })
    Observe.property(player.state, 'score', event => {
      this.updateScoreDisplay(event.newValue)
    })
    Observe.property(this.chessConsole.state, 'plyViewed', () => {
      this.refreshScore()
    })
    this.updatePlayerName()
    this.updateThinkingIndicator()
    this.refreshScore()
  }

  formatScore(score) {
    if (score === null || score === undefined || score === '') return ''
    if (isNaN(score)) return String(score)
    return this.numberFormat.format(score)
  }

  updateScoreDisplay(score) {
    const scoreElement = this.getScoreElement()
    if (!scoreElement) return
    const formatted = this.formatScore(score)
    if (formatted) {
      scoreElement.textContent = `${this.chessConsole.i18n.t('score')} ${formatted}`
    } else {
      scoreElement.textContent = ''
    }
    globalThis.scheduleFitPlayerBars?.()
  }

  refreshScore() {
    let score = this.player.state.scoreHistory[this.chessConsole.state.plyViewed]
    if (!score && this.chessConsole.state.plyViewed > 0) {
      score = this.player.state.scoreHistory[this.chessConsole.state.plyViewed - 1]
    }
    if (score === undefined || score === null) {
      score = this.player.state.score
    }
    this.updateScoreDisplay(score)
  }

  getEngineLabelElement() {
    const board = this.chessConsole.components?.board
    if (!board?.elements) return null
    const white = this.chessConsole.playerWhite()
    const black = this.chessConsole.playerBlack()
    const engineIsWhite = this.player === white
    const engineIsBlack = this.player === black
    if (!engineIsWhite && !engineIsBlack) return null
    const bottomIsWhite = this.chessConsole.props.playerColor === this.chessConsole.state.orientation
    const engineOnBottom = engineIsWhite ? bottomIsWhite : !bottomIsWhite
    return engineOnBottom ? board.elements.playerBottom : board.elements.playerTop
  }

  getScoreElement() {
    const labelEl = this.getEngineLabelElement()
    if (!labelEl) return null
    let scoreEl = labelEl.querySelector(this.props.scoreSlotSelector)
    if (!scoreEl) {
      const host = labelEl.querySelector(this.props.playerBarSelector) || labelEl
      scoreEl = document.createElement('span')
      scoreEl.className = this.props.scoreSlotSelector.replace(/^\./, '')
      scoreEl.setAttribute('aria-live', 'polite')
      host.appendChild(scoreEl)
    }
    return scoreEl
  }

  updateThinkingIndicator() {
    const labelEl = this.getEngineLabelElement()
    if (!labelEl) return

    const bar = labelEl.querySelector(this.props.playerBarSelector)
    const host = bar || labelEl
    let thinking = host.querySelector(this.props.thinkingSlotSelector)
    if (!thinking) {
      thinking = document.createElement('span')
      thinking.className = this.props.thinkingSlotSelector.replace(/^\./, '')
      thinking.setAttribute('aria-hidden', 'true')
      thinking.textContent = '💭'
      host.appendChild(thinking)
    }

    const active = this.player.state.engineState === ENGINE_STATE.THINKING
    thinking.classList.toggle('is-active', active)
    thinking.setAttribute('aria-hidden', active ? 'false' : 'true')
    globalThis.scheduleFitPlayerBars?.()
  }

  updatePlayerName() {
    this.player.name = `Stockfish ${this.chessConsole.i18n.t('level')} ${this.player.state.level}`
  }
}

// # Stockfish New Game Dialog

// Patches the global `bootstrap` with `.showModal()`. chess-console's own dialogs
// import this too; doing it here keeps our fork self-contained regardless of order.
import 'bootstrap-show-modal/src/ShowModal.js'

function stockfishLevelHint(level) {
  if (level <= 3) return 'casual'
  if (level <= 8) return 'moderate'
  if (level <= 14) return 'strong'
  return 'expert'
}

export class StockfishNewGameDialog {
  constructor(chessConsole, props) {
    this.chessConsole = chessConsole
    this.props = props
    const i18n = chessConsole.i18n
    i18n
      .load({
        de: {
          new_game_vs_stockfish: 'Neues Spiel gegen Stockfish',
          new_game_lead: 'Starte ein neues Spiel gegen Stockfish — den Schachcomputer als Gegner.',
          your_color: 'Deine Farbe',
          color_white: 'Weiß — du spielst mit Weiß und machst den ersten Zug',
          color_black: 'Schwarz — du spielst mit Schwarz, Stockfish beginnt',
          color_random: 'Zufällig — Farbe wird bei jedem neuen Spiel gewählt',
          color_auto: 'Wechseln — andere Farbe als im aktuellen Spiel',
          color_hint_white: 'Du spielst mit Weiß (unten am Brett) und ziehst zuerst.',
          color_hint_black: 'Du spielst mit Schwarz (unten am Brett). Stockfish zieht zuerst.',
          color_hint_random: 'Beim Start wird zufällig Weiß oder Schwarz für dich gewählt.',
          color_hint_auto: 'Du bekommst die andere Farbe als in der laufenden Partie.',
          stockfish_level: 'Stockfish-Stärke',
          stockfish_level_help:
            'Höhere Stufen denken länger und spielen stärker. Stufe 1 ist am leichtesten. Die Elo-Zahl ist die ungefähre Spielstärke (UCI_Elo).',
          level_option: 'Stufe $0 · ~$2 Elo — $1',
          level_casual: 'leicht',
          level_moderate: 'mittel',
          level_strong: 'stark',
          level_expert: 'sehr stark',
          summary_you_white: 'Du (Weiß) gegen Stockfish Stufe $0 (~$1 Elo)',
          summary_you_black: 'Du (Schwarz) gegen Stockfish Stufe $0 (~$1 Elo)',
          summary_random: 'Zufällige Farbe für dich gegen Stockfish Stufe $0 (~$1 Elo)',
          summary_auto: 'Andere Farbe als zuvor gegen Stockfish Stufe $0 (~$1 Elo)',
          start_game: 'Spiel starten',
        },
        en: {
          new_game_vs_stockfish: 'New game vs Stockfish',
          new_game_lead: 'Start a fresh game against Stockfish — the computer opponent.',
          your_color: 'Your color',
          color_white: 'White — you play White and move first',
          color_black: 'Black — you play Black; Stockfish moves first',
          color_random: 'Random — your color is picked each new game',
          color_auto: 'Alternate — swap color from the current game',
          color_hint_white: 'You play White (bottom of the board) and move first.',
          color_hint_black: 'You play Black (bottom of the board). Stockfish moves first.',
          color_hint_random: 'White or Black will be chosen for you when the game starts.',
          color_hint_auto: 'You take the opposite color from your side in the current game.',
          stockfish_level: 'Stockfish level',
          stockfish_level_help:
            'Higher levels think longer and play stronger. Level 1 is the easiest. The Elo number is the approximate playing strength (UCI_Elo).',
          level_option: 'Level $0 · ~$2 Elo — $1',
          level_casual: 'casual',
          level_moderate: 'moderate',
          level_strong: 'strong',
          level_expert: 'expert',
          summary_you_white: 'You (White) vs Stockfish level $0 (~$1 Elo)',
          summary_you_black: 'You (Black) vs Stockfish level $0 (~$1 Elo)',
          summary_random: 'Random color for you vs Stockfish level $0 (~$1 Elo)',
          summary_auto: 'Alternate color vs Stockfish level $0 (~$1 Elo)',
          start_game: 'Start game',
        },
      })
      .then(() => {
        const newGameColor = chessConsole.persistence.loadValue('newGameColor')
        const levelHintKey = hint => {
          const map = {
            casual: 'level_casual',
            moderate: 'level_moderate',
            strong: 'level_strong',
            expert: 'level_expert',
          }
          return i18n.t(map[hint] || 'level_moderate')
        }

        props.title = i18n.t('new_game_vs_stockfish')
        props.modalClass = 'fade wiki-stockfish-new-game-modal'
        props.body = `<div class="wiki-new-game-dialog form">
          <p class="wiki-new-game-lead text-muted mb-3">${i18n.t('new_game_lead')}</p>
          <div class="mb-3">
            <label for="color" class="form-label fw-semibold">${i18n.t('your_color')}</label>
            <select id="color" class="form-select" aria-describedby="color-hint">
              <option value="w" ${newGameColor === 'w' ? 'selected' : ''}>${i18n.t('color_white')}</option>
              <option value="b" ${newGameColor === 'b' ? 'selected' : ''}>${i18n.t('color_black')}</option>
              <option value="random" ${newGameColor === 'random' ? 'selected' : ''}>${i18n.t('color_random')}</option>
              <option value="auto" ${newGameColor === 'auto' ? 'selected' : ''}>${i18n.t('color_auto')}</option>
            </select>
            <div id="color-hint" class="form-text">${i18n.t('color_hint_white')}</div>
          </div>
          <div class="mb-3">
            <label for="level" class="form-label fw-semibold">${i18n.t('stockfish_level')}</label>
            <select id="level" class="form-select" aria-describedby="level-help">
              ${this.renderLevelOptions(i18n, levelHintKey)}
            </select>
            <div id="level-help" class="form-text">${i18n.t('stockfish_level_help')}</div>
          </div>
          <div id="new-game-summary" class="wiki-new-game-summary alert alert-secondary py-2 mb-0" role="status" aria-live="polite"></div>
        </div>`
        props.footer = `<button type="button" class="btn btn-link" data-dismiss="modal">${i18n.t('cancel')}</button>
            <button type="submit" class="btn btn-primary">${i18n.t('start_game')}</button>`
        props.onCreate = modal => {
          const form = modal.element.querySelector('.wiki-new-game-dialog')
          const colorSelect = form.querySelector('#color')
          const levelSelect = form.querySelector('#level')
          const colorHint = form.querySelector('#color-hint')
          const summary = form.querySelector('#new-game-summary')
          let committed = false

          const colorHintFor = value => {
            const keys = {
              w: 'color_hint_white',
              b: 'color_hint_black',
              random: 'color_hint_random',
              auto: 'color_hint_auto',
            }
            return i18n.t(keys[value] || 'color_hint_white')
          }

          const summaryFor = (colorValue, level) => {
            const keys = {
              w: 'summary_you_white',
              b: 'summary_you_black',
              random: 'summary_random',
              auto: 'summary_auto',
            }
            return i18n.t(keys[colorValue] || 'summary_you_white', level, stockfishLevelElo(level))
          }

          const refreshDialog = () => {
            const colorValue = colorSelect.value
            const level = levelSelect.value
            colorHint.textContent = colorHintFor(colorValue)
            summary.textContent = summaryFor(colorValue, level)
          }

          colorSelect.addEventListener('change', refreshDialog)
          levelSelect.addEventListener('change', refreshDialog)
          refreshDialog()

          $(modal.element).on('click', "button[type='submit']", function (event) {
            event.preventDefault()
            let color = colorSelect.value
            chessConsole.persistence.saveValue('newGameColor', color)
            const level = parseInt(levelSelect.value, 10) || 1
            if (color === 'auto') {
              color = chessConsole.props.playerColor === BOARD_COLOR.white ? BOARD_COLOR.black : BOARD_COLOR.white
            } else if (color === 'random') {
              color = 'wb'.charAt(Math.floor(Math.random() * 2))
            }
            committed = true
            modal.hide()
            const payload = { playerColor: color, engineLevel: level }
            if (props.onConfirm) {
              props.onConfirm(payload)
            } else {
              chessConsole.newGame(payload)
            }
          })
          if (props.onHidden) {
            modal.element.addEventListener('hidden.bs.modal', () => {
              if (!committed) props.onHidden(modal)
            })
          }
        }
        bootstrap.showModal(props)
      })
  }

  renderLevelOptions(i18n, levelHintKey) {
    let html = ''
    const proposedLevel = 1
    const levels = Object.keys(LEVELS)
    for (let i = levels[0]; i <= levels[levels.length - 1]; i++) {
      const selected = Number(i) === proposedLevel ? 'selected ' : ''
      const hint = levelHintKey(stockfishLevelHint(i))
      const label = i18n.t('level_option', i, hint, stockfishLevelElo(i))
      html += `<option ${selected}value="${i}">${label}</option>`
    }
    return html
  }
}

export class StockfishGameControl extends GameControl {
  showNewGameDialog() {
    new StockfishNewGameDialog(this.chessConsole, {
      player: this.props.player,
    })
  }
}

// Upstream typos: EngineRunner sets `initialized`, StockfishRunner.calculateMove waited on
// `initialisation`, and StockfishPlayer waited on `initialization` — so the UI never
// actually awaited worker ready, and a second nextMove (journal echo) could orphan the
// first search. Also `bestmove (none)` never matched the move regex → infinite THINKING.
// Illegal / "funhouse" FENs (e.g. three bishops) make Stockfish 18 reply `bestmove (none)`
// even when cm-chess still has legal moves — without a fallback the turn hourglass hangs.
const ENGINE_MOVE_TIMEOUT_MS = 30000
const ENGINE_SEARCH_ABORTED = Object.freeze({ aborted: true })

function runnerReadyPromise(runner) {
  if (!runner) return Promise.resolve()
  return runner.initialized || runner.initialisation || runner.initialization || Promise.resolve()
}

function pickLegalFallbackMove(chess) {
  const moves = typeof chess?.moves === 'function' ? chess.moves({ verbose: true }) : []
  if (!Array.isArray(moves) || moves.length === 0) return null
  const move = moves[Math.floor(Math.random() * moves.length)]
  if (!move?.from || !move?.to) return null
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion } : {}),
  }
}

const _stockfishWorkerListener = StockfishRunner.prototype.workerListener
StockfishRunner.prototype.workerListener = function workerListenerWithNone(event) {
  const line = event?.data
  if (typeof line === 'string' && /^bestmove\s+\(none\)/i.test(line)) {
    this.engineState = ENGINE_STATE.READY
    if (typeof this.moveResponse === 'function') this.moveResponse(null)
    return
  }
  return _stockfishWorkerListener.call(this, event)
}

StockfishRunner.prototype.abortSearch = function abortSearch() {
  this._calcGeneration = (this._calcGeneration || 0) + 1
  try {
    this.uciCmd('stop')
  } catch {
    /* worker may not be ready yet */
  }
  this.engineState = ENGINE_STATE.READY
  if (typeof this.moveResponse === 'function') {
    const done = this.moveResponse
    this.moveResponse = () => {}
    done(ENGINE_SEARCH_ABORTED)
  }
}

// Patch StockfishRunner to use real UCI_Elo strength instead of depth-only levels.
StockfishRunner.prototype.calculateMove = function calculateMoveByElo(fen, props = { level: 4 }) {
  this.engineState = ENGINE_STATE.THINKING
  this.score = undefined
  const depth = LEVELS[props.level]?.[0] ?? 12
  const elo = stockfishLevelElo(props.level)
  const generation = (this._calcGeneration = (this._calcGeneration || 0) + 1)
  const delay = this.props.responseDelay || 0

  return runnerReadyPromise(this).then(
    () =>
      new Promise(resolve => {
        let settled = false
        const finish = move => {
          // Always resolve so callers are never left awaiting; ignore stale bestmoves
          // for engineState when a newer calculateMove/abortSearch has taken over.
          if (settled) return
          settled = true
          window.clearTimeout(watchdog)
          if (generation === this._calcGeneration) {
            this.engineState = ENGINE_STATE.READY
          }
          if (move && move.aborted) {
            resolve(ENGINE_SEARCH_ABORTED)
            return
          }
          resolve(move || null)
        }
        const watchdog = window.setTimeout(() => {
          try {
            this.uciCmd('stop')
          } catch {
            /* ignore */
          }
          finish(null)
        }, ENGINE_MOVE_TIMEOUT_MS)

        // Cancel any prior go so a journal-echo nextMove cannot leave us waiting forever.
        try {
          this.uciCmd('stop')
        } catch {
          /* ignore */
        }

        window.setTimeout(() => {
          if (generation !== this._calcGeneration) {
            finish(ENGINE_SEARCH_ABORTED)
            return
          }
          this.moveResponse = move => finish(move)
          this.uciCmd('setoption name UCI_LimitStrength value true')
          this.uciCmd('setoption name UCI_Elo value ' + elo)
          this.uciCmd('position fen ' + fen)
          this.uciCmd('go depth ' + depth)
        }, delay)
      }),
  )
}

// # Bundle Re Exports

function setDisabledWithTooltip(button, disabled) {
  if (!button) return
  button.disabled = false
  button.classList.toggle('is-disabled', disabled)
  button.setAttribute('aria-disabled', disabled ? 'true' : 'false')
  if (disabled) {
    button.tabIndex = -1
  } else {
    button.removeAttribute('tabindex')
  }
}

export function enhanceToolbarAccessibility(container) {
  if (!container || container._wikiToolbarA11y) return
  container._wikiToolbarA11y = true
  container.querySelectorAll('button[title]').forEach(button => {
    if (!button.getAttribute('aria-label')) {
      button.setAttribute('aria-label', button.getAttribute('title'))
    }
  })
}

function installDisabledControlGuards(container) {
  if (!container || container._wikiDisabledGuard) return
  container._wikiDisabledGuard = true
  enhanceToolbarAccessibility(container)
  container.addEventListener(
    'click',
    event => {
      const button = event.target.closest('button.is-disabled')
      if (button) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    true,
  )
}

function patchHistoryControl(HistoryControl) {
  HistoryControl.prototype.setButtonStates = function setButtonStatesWithTooltips() {
    installDisabledControlGuards(this.context)
    window.clearTimeout(this.redrawDebounce)
    this.redrawDebounce = window.setTimeout(() => {
      const atStart = this.chessConsole.state.plyViewed <= 0
      const atEnd = this.chessConsole.state.plyViewed >= this.chessConsole.state.chess.plyCount()
      setDisabledWithTooltip(this.btnFirst, atStart)
      setDisabledWithTooltip(this.btnBack, atStart)
      setDisabledWithTooltip(this.btnLast, atEnd)
      setDisabledWithTooltip(this.btnForward, atEnd)
      setDisabledWithTooltip(this.btnAutoplay, atEnd)
    })
    this.updatePlayIcon()
  }
}

function patchGameControl(GameControl) {
  GameControl.prototype.setButtonStates = function setButtonStatesWithTooltips() {
    installDisabledControlGuards(this.context)
    setDisabledWithTooltip(this.btnUndoMove, this.chessConsole.state.chess.plyCount() < 2)
  }
}

patchHistoryControl(HistoryControl)
patchGameControl(GameControl)

export { ChessConsole } from 'chess-console/src/ChessConsole.js'
export { ChessConsolePlayer } from 'chess-console/src/ChessConsolePlayer.js'
export { LocalPlayer }
import { Board as CmBoard } from 'chess-console/src/components/Board.js'

// Expand a FEN piece-placement field to 64 square chars ('.' = empty).
function expandFenPlacement(placement) {
  let out = ''
  for (const ch of String(placement || '')) {
    if (ch === '/') continue
    if (ch >= '1' && ch <= '8') out += '.'.repeat(Number(ch))
    else out += ch
  }
  return out
}

// True when from→to is not a single ply (normal move ≤4 square changes; castling = 4).
// Used to snap bulk loads instead of morphing every piece across the board.
function isBulkChessboardChange(fromPlacement, toPlacement) {
  const a = expandFenPlacement(fromPlacement)
  const b = expandFenPlacement(toPlacement)
  if (a.length !== 64 || b.length !== 64) return true
  let diffs = 0
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) diffs++
  return diffs > 4
}

// Opposite-sides tabletop: board stays white-at-bottom; every glyph rotates 180° only on
// Black's turn so the far seat can read them. White to move → upright (start position).
// Applied to the inner <use> so move animations (outer-group translate) keep working.
function sideToMoveAtPly(chessConsole) {
  const chess = chessConsole?.state?.chess
  if (!chess) return null
  const ply = typeof chessConsole.state.plyViewed === 'number' ? chessConsole.state.plyViewed : chess.plyCount?.()
  if (typeof chess.fenOfPly === 'function' && typeof ply === 'number') {
    const fen = String(chess.fenOfPly(ply) || '')
    const turn = fen.split(/\s+/)[1]
    if (turn === 'w' || turn === 'b') return turn
  }
  return typeof chess.turn === 'function' ? chess.turn() : null
}

function piecesShouldAppearFlipped(chessboard) {
  if (!chessboard?._wikiPiecesFlipped) return false
  // Home seat is always white-at-bottom while this mode is on (enforced in chess-app).
  // Flip glyphs only when Black is to move — never on the opening White turn.
  return sideToMoveAtPly(chessboard._wikiChessConsole) === 'b'
}

function appendPieceGlyphFlip(chessboard, useEl) {
  if (!piecesShouldAppearFlipped(chessboard) || !useEl?.transform?.baseVal) return
  const tile = Number(chessboard.props?.style?.pieces?.tileSize) || 40
  const rot = (useEl.ownerSVGElement || chessboard.view?.svg)?.createSVGTransform?.()
  if (!rot) return
  rot.setRotate(180, tile / 2, tile / 2)
  useEl.transform.baseVal.appendItem(rot)
}

function ensurePiecesFlipHooks(chessboard, chessConsole) {
  if (!chessboard?.view || chessboard._wikiPiecesFlipHooked) return
  chessboard._wikiPiecesFlipHooked = true
  if (chessConsole) chessboard._wikiChessConsole = chessConsole
  const view = chessboard.view

  const origDrawOnSquare = view.drawPieceOnSquare.bind(view)
  view.drawPieceOnSquare = (square, pieceName, hidden) => {
    const g = origDrawOnSquare(square, pieceName, hidden)
    appendPieceGlyphFlip(chessboard, g?.querySelector?.('use'))
    return g
  }

  const origDrawPiece = view.drawPiece.bind(view)
  view.drawPiece = (parentGroup, pieceName, point) => {
    const g = origDrawPiece(parentGroup, pieceName, point)
    appendPieceGlyphFlip(chessboard, g?.querySelector?.('use'))
    return g
  }

  const moveInput = view.visualMoveInput
  if (moveInput && typeof moveInput.createDraggablePiece === 'function') {
    const origDrag = moveInput.createDraggablePiece.bind(moveInput)
    moveInput.createDraggablePiece = pieceName => {
      origDrag(pieceName)
      appendPieceGlyphFlip(chessboard, moveInput.draggablePiece?.querySelector?.('use'))
    }
  }
}

// Toggle opposite-sides piece-glyph flip on a live console board (board sides stay put).
export function setConsolePiecesFlipped(chessConsole, flipped) {
  const board = chessConsole?.components?.board
  const chessboard = board?.chessboard
  if (!chessboard) return
  chessboard._wikiChessConsole = chessConsole
  ensurePiecesFlipHooks(chessboard, chessConsole)
  const next = Boolean(flipped)
  const was = Boolean(chessboard._wikiPiecesFlipped)
  board._wikiPiecesFlipped = next
  chessboard._wikiPiecesFlipped = next
  // Flip mode off and staying off: do not redraw. wirePassAndPlayFlip calls this on every
  // ply (including vs Stockfish); wiping piece nodes here races cm-chessboard's move
  // animation and makes engine replies snap instead of slide.
  if (!next && !was) return
  // Side-to-move glyph refresh while flip stays on: wait out the move animation so we
  // do not replace the SVG nodes PositionsAnimation is translating.
  if (next && was) {
    clearTimeout(chessboard._wikiFlipRedrawTimer)
    chessboard._wikiFlipRedrawTimer = setTimeout(() => {
      chessboard.view?.redrawPieces?.(chessboard.state.position.squares)
    }, 320)
    return
  }
  clearTimeout(chessboard._wikiFlipRedrawTimer)
  chessboard.view?.redrawPieces?.(chessboard.state.position.squares)
}

// Skip redundant setPosition calls when the placement is already drawn — chess-console
// and game sync can both request the same ply in one tick, which flickers the pieces.
export class Board extends CmBoard {
  constructor(chessConsole, props = {}) {
    super(chessConsole, props)
    this.initialized.then(() => {
      const chessboard = this.chessboard
      if (!chessboard) return
      // cm-chessboard's setOrientation animates through an empty board even when
      // animated=false; redraw in place so puzzle/game mode switches do not flash.
      chessboard.setOrientation = (color, _animated = false) => {
        if (chessboard.boardTurning) {
          console.warn('setOrientation is only once in queue allowed')
          return Promise.resolve()
        }
        if (chessboard.getOrientation() === color) return Promise.resolve()
        chessboard.boardTurning = true
        chessboard.state.orientation = color
        chessboard.view.redrawBoard()
        chessboard.view.redrawPieces(chessboard.state.position.squares)
        chessboard.boardTurning = false
        chessboard.state.invokeExtensionPoints?.('boardChanged')
        return Promise.resolve()
      }
      chessboard._wikiChessConsole = chessConsole
      ensurePiecesFlipHooks(chessboard, chessConsole)
      if (this._wikiPiecesFlipped) {
        chessboard._wikiPiecesFlipped = true
        chessboard.view.redrawPieces(chessboard.state.position.squares)
      }
    })
  }

  setPositionOfPlyViewed(animated = true) {
    if (this._suppressPositionUpdates) return
    clearTimeout(this.setPositionOfPlyViewedDebounced)
    this.setPositionOfPlyViewedDebounced = setTimeout(() => {
      const to = this.chessConsole.state.chess.fenOfPly(this.chessConsole.state.plyViewed)
      const boardPlacement = this.chessboard?.getPosition?.()
      const newPlacement = String(to).split(/\s+/)[0]
      if (boardPlacement && boardPlacement === newPlacement) return
      // chess-console checks functionName === "load_pgn" but Observe reports "loadPgn",
      // so PGN loads animate by mistake. Bulk swaps (new puzzle) must snap, not morph —
      // otherwise every piece flies across the board and it looks like a shake.
      const animate = animated && !isBulkChessboardChange(boardPlacement, newPlacement)
      this.chessboard.setPosition(to, animate)
    })
  }

  // chess-console only marks history plies. Teach drills often start at ply 0 with an
  // en-passant target in the FEN (no setup move recorded) — mark that implied double-step.
  markLastMove() {
    window.clearTimeout(this.markLastMoveDebounce)
    this.markLastMoveDebounce = setTimeout(() => {
      this.chessboard.removeMarkers(this.props.markers.moveInput)
      this.chessboard.removeMarkers(this.props.markers.check)
      const ply = this.chessConsole.state.plyViewed
      if (ply > 0) {
        const lastMove = this.chessConsole.state.chess.history()[ply - 1]
        if (lastMove) {
          this.chessboard.addMarker(this.props.markers.moveInput, lastMove.from)
          this.chessboard.addMarker(this.props.markers.moveInput, lastMove.to)
          if (
            this.chessConsole.state.chess.inCheck(lastMove) ||
            this.chessConsole.state.chess.inCheckmate(lastMove)
          ) {
            const kingSquare = this.chessConsole.state.chess.pieces(
              'k',
              this.chessConsole.state.chess.turn(lastMove),
              lastMove,
            )[0]
            this.chessboard.addMarker(this.props.markers.check, kingSquare.square)
          }
        }
        return
      }
      const fen = this.chessConsole.state.chess.fenOfPly?.(0)
      const implied = lastMoveFromEnPassantTarget(fen)
      if (!implied) return
      this.chessboard.addMarker(this.props.markers.moveInput, implied.from)
      this.chessboard.addMarker(this.props.markers.moveInput, implied.to)
    })
  }

  // Snap to the ply before the current tip, then animate that single move so visitors
  // see what just happened (e.g. a pawn double-step before an en passant puzzle).
  // Cancels any in-flight reveal when a new puzzle/game loads quickly.
  revealLastMoveAnimated() {
    if (this._suppressPositionUpdates) return Promise.resolve()
    const chess = this.chessConsole?.state?.chess
    const chessboard = this.chessboard
    const ply = this.chessConsole?.state?.plyViewed
    if (!chessboard || !chess || typeof ply !== 'number') return Promise.resolve()

    clearTimeout(this.setPositionOfPlyViewedDebounced)
    window.clearTimeout(this.markLastMoveDebounce)
    const gen = (this._revealLastMoveGen = (this._revealLastMoveGen || 0) + 1)

    if (ply < 1) {
      const fen = chess.fenOfPly(0)
      const before = fenBeforeEnPassantDoubleStep(fen)
      if (before && fen) {
        return chessboard.setPosition(before, false).then(() => {
          if (gen !== this._revealLastMoveGen) return
          if (this.chessConsole?.state?.plyViewed !== ply) return
          this.markLastMove()
          return chessboard.setPosition(fen, true).then(() => {
            if (gen !== this._revealLastMoveGen) return
            this.markLastMove()
          })
        })
      }
      if (fen) void chessboard.setPosition(fen, false)
      this.markLastMove()
      return Promise.resolve()
    }

    const fromFen = chess.fenOfPly(ply - 1)
    const toFen = chess.fenOfPly(ply)
    if (!fromFen || !toFen) {
      this.setPositionOfPlyViewed(false)
      this.markLastMove()
      return Promise.resolve()
    }

    return chessboard.setPosition(fromFen, false).then(() => {
      if (gen !== this._revealLastMoveGen) return
      if (this.chessConsole?.state?.plyViewed !== ply) return
      this.markLastMove()
      return chessboard.setPosition(toFen, true).then(() => {
        if (gen !== this._revealLastMoveGen) return
        this.markLastMove()
      })
    })
  }
}
import { GameStateOutput as CmGameStateOutput } from 'chess-console/src/components/GameStateOutput.js'

// The game-over/check banner describes the game's final position, but loaded games
// rest on ply 0 (maybeRewindLoadedGameToStart) — hide it unless the board is viewing
// the last ply, and re-check whenever the user steps through the history.
export class GameStateOutput extends CmGameStateOutput {
  constructor(chessConsole) {
    super(chessConsole)
    Observe.property(chessConsole.state, 'plyViewed', () => this.redraw())
  }

  redraw() {
    const state = this.chessConsole?.state
    if (state && typeof state.plyViewed === 'number' && state.plyViewed < state.chess.plyCount()) {
      this.chessConsole.componentContainers.notifications.style.display = 'none'
      this.element.innerHTML = ''
      return
    }
    super.redraw()
  }
}
export { WikiHistory as History }
export { WikiCapturedPieces as CapturedPieces }
export { HistoryControl } from 'chess-console/src/components/HistoryControl.js'
export { GameControl } from 'chess-console/src/components/GameControl/GameControl.js'
export { Persistence } from 'chess-console/src/components/Persistence.js'
export { Sound } from 'chess-console/src/components/Sound.js'

import { StockfishPlayer as UpstreamStockfishPlayer } from 'chess-console-stockfish/src/StockfishPlayer.js'
import { CONSOLE_MESSAGE_TOPICS } from 'chess-console/src/ChessConsole.js'

// Wait on the real worker ready promise and abort stale searches on board re-init
// (shell SET_STATE after a local move used to start a second calculateMove).
export class StockfishPlayer extends UpstreamStockfishPlayer {
  constructor(chessConsole, name, props) {
    super(chessConsole, name, props)
    const runners = [this.openingRunner, this.engineRunner].filter(Boolean)
    for (const runner of runners) {
      if (runner.initialized) {
        runner.initialisation = runner.initialized
        runner.initialization = runner.initialized
      }
    }
    this.initialisation = Promise.all(runners.map(runnerReadyPromise))
    this.initialisation.then(() => {
      if (this.state.engineState === ENGINE_STATE.LOADING || this.state.engineState === ENGINE_STATE.LOADED) {
        this.state.engineState = ENGINE_STATE.READY
      }
    })
    chessConsole.messageBroker.subscribe(CONSOLE_MESSAGE_TOPICS.initGame, () => {
      this.abortEngineSearch()
    })
  }

  abortEngineSearch() {
    this.engineRunner?.abortSearch?.()
    if (this.openingRunner && this.openingRunner !== this.engineRunner) {
      this.openingRunner.abortSearch?.()
    }
    if (this.state.engineState === ENGINE_STATE.THINKING) {
      this.state.engineState = ENGINE_STATE.READY
    }
  }

  moveRequest(fen, moveResponse) {
    if (this.props.debug) console.log('moveRequest', fen)
    this.initialisation.then(async () => {
      this.state.engineState = ENGINE_STATE.THINKING
      if (this.state.level < 3) {
        this.state.currentRunner = this.engineRunner
      }
      let nextMove = await this.state.currentRunner.calculateMove(fen, { level: this.state.level })
      // Journal echo / initGame abort — a newer nextMove owns the turn; do not play.
      if (nextMove?.aborted) {
        this.state.engineState = ENGINE_STATE.READY
        return
      }
      if (!nextMove) {
        if (this.state.currentRunner === this.openingRunner && this.openingRunner !== this.engineRunner) {
          this.state.currentRunner = this.engineRunner
          this.moveRequest(fen, moveResponse)
          return
        }
        // Stockfish rejects some illegal FENs with `bestmove (none)` while cm-chess
        // still has moves — play one so the turn does not hang forever.
        nextMove = pickLegalFallbackMove(this.chessConsole.state.chess)
        if (!nextMove) {
          this.state.engineState = ENGINE_STATE.READY
          console.warn('wiki-chess: Stockfish returned no move for', fen)
          return
        }
        console.warn('wiki-chess: Stockfish returned no move; playing legal fallback for', fen)
      }
      let newScore = undefined
      if (nextMove.score !== undefined) {
        if (!isNaN(nextMove.score)) {
          newScore = -nextMove.score
        } else {
          newScore = nextMove.score
        }
        this.state.scoreHistory[this.chessConsole.state.chess.plyCount()] = newScore
        this.state.score = newScore
      } else {
        this.state.score = undefined
      }
      this.state.engineState = ENGINE_STATE.READY
      moveResponse(nextMove)
    })
  }
}
export { I18n } from 'cm-web-modules/src/i18n/I18n.js'

import { FenEditor as CmFenEditor } from 'cm-fen-editor/src/FenEditor.js'
import { Chessboard } from 'cm-chessboard/src/Chessboard.js'
import { FEN } from 'cm-chessboard/src/model/Position.js'
import { Markers } from 'cm-chessboard/src/extensions/markers/Markers.js'
import { PositionEditor } from 'cm-chessboard-position-editor/src/PositionEditor.js'
import { Chess } from 'cm-chess/src/Chess.js'
import { Cookie } from 'cm-web-modules/src/cookie/Cookie.js'

// Swap piece sprites on an existing game board without rebuilding the console chrome.
export async function reloadConsoleBoardPieceSet(
  chessConsole,
  { piecesFile, assetsUrl = './assets/', reenableMoveInput = false } = {},
) {
  const board = chessConsole?.components?.board
  if (!board?.chessboard || !board?.elements?.chessboard || !piecesFile) return

  const orientation = chessConsole.state.orientation
  const fenAtPly = chessConsole.state.chess.fenOfPly(chessConsole.state.plyViewed)
  const piecesFlipped = Boolean(board._wikiPiecesFlipped || board.chessboard?._wikiPiecesFlipped)
  // Shapes stay upright (shadows baked for both seats); never restore glyph flip.
  const allowInPlaceFlip = !String(piecesFile).includes('shapes')

  board.chessboard.destroy()
  // Drop the inlined sprite so the next Chessboard loads `piecesFile` (cacheSpriteToDiv
  // skips fetch when #cm-chessboard-sprite already exists).
  clearPieceSpriteCache()
  board.props.assetsUrl = assetsUrl
  board.props.assetsCache = true
  board.props.orientation = orientation
  board.props.style = board.props.style || {}
  board.props.style.pieces = { ...(board.props.style.pieces || {}), file: piecesFile }

  board.chessboard = new Chessboard(board.elements.chessboard, board.props)
  const spriteUrl =
    typeof board.chessboard.view?.getSpriteUrl === 'function'
      ? board.chessboard.view.getSpriteUrl()
      : `${assetsUrl}${piecesFile}`
  await ensurePieceSpriteCached(spriteUrl)
  await board.chessboard.setOrientation(orientation)
  await board.chessboard.setPosition(fenAtPly, false)
  board.markLastMove()
  board.markPlayerToMove()
  if (piecesFlipped && allowInPlaceFlip) setConsolePiecesFlipped(chessConsole, true)
  else if (piecesFlipped) {
    board._wikiPiecesFlipped = false
    board.chessboard._wikiPiecesFlipped = false
  }

  // destroy() drops cm-chessboard move-input handlers; re-request the current turn.
  if (reenableMoveInput && chessConsole.playerToMove?.()) {
    chessConsole.nextMove()
  }
}

// Fen editor keeps assetsCache off so its board can use a different sprite file than the
// game board without fighting over #cm-chessboard-sprite. Paint-server ids are set-prefixed
// (`merida-wk-a`) so external `<use>` from the picker cannot alias Merida gradients to
// Shapes filters (same short `#wk-a` name).
export class FenEditor extends CmFenEditor {
  syncFenEditorFormFields() {
    this.removeNotAllowedCastlings()
    const fenString = this.state.fen.toString()
    this.elements.fenInputOutput.classList.remove('is-invalid')
    this.elements.fenInputOutput.value = fenString
    if (this.elements.fenSelect) this.elements.fenSelect.value = fenString
    this.elements.colorToPlay.value = this.state.fen.colorToPlay
    this.elements.castling.wk.checked = this.state.fen.castlings.includes('K')
    this.elements.castling.wq.checked = this.state.fen.castlings.includes('Q')
    this.elements.castling.bk.checked = this.state.fen.castlings.includes('k')
    this.elements.castling.bq.checked = this.state.fen.castlings.includes('q')
    if (this.props.cookieName) Cookie.write(this.props.cookieName, fenString)
  }

  // cm-fen-editor always setPosition() on every FEN tweak. After a board edit the
  // pieces are already drawn — a second setPosition redraws the board and flickers.
  updateValidState() {
    const fenString = this.state.fen.toString()
    try {
      new Chess(fenString)
      this.state.fenIsValid = true
    } catch {
      this.state.fenIsValid = false
    }
    if (!this.state.fenIsValid) {
      this.elements.fenInputOutput.classList.add('is-invalid')
      console.warn('invalid fen', fenString)
      return
    }

    const boardPlacement = this.chessboard?.getPosition?.()
    const newPlacement = fenString.split(/\s+/)[0]
    if (boardPlacement && boardPlacement === newPlacement) {
      this.syncFenEditorFormFields()
      return
    }

    this.chessboard.setPosition(fenString, false).then(() => {
      this.syncFenEditorFormFields()
    })
  }

  initChessboard() {
    this.chessboard = new Chessboard(this.elements.chessboardContext, {
      position: FEN.empty,
      assetsUrl: this.props.assetsUrl,
      assetsCache: false,
      style: {
        aspectRatio: 0.98,
        pieces: { file: this.props.piecesFile },
        cssClass: this.props.boardTheme,
      },
      extensions: [
        {
          class: PositionEditor,
          props: {
            autoSpecialMoves: false,
            onPositionChange: event => {
              this.state.fen.position = event.position
              this.removeNotAllowedCastlings()
              // Trigger Observe listeners when nested position fields change.
              // eslint-disable-next-line no-self-assign -- intentional reactivity notify
              this.state.fen = this.state.fen
              if (this.props.onPositionChange) {
                this.props.onPositionChange(event)
              }
            },
            markers: { addPiece: { ...this.props.markers } },
          },
        },
        { class: Markers, props: { autoMarkers: { ...this.props.markers } } },
      ],
    })
  }
}
export { MARKER_TYPE } from 'cm-chessboard/src/extensions/markers/Markers.js'
export { FEN } from 'cm-chessboard/src/model/Position.js'
export { Chess } from 'cm-chess/src/Chess.js'
export { Pgn } from 'cm-pgn/src/Pgn.js'
export { Observe } from 'cm-web-modules/src/observe/Observe.js'
