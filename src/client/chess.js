// TODO change to make it a playable Game
// TODO if item text is empty, or not able to be parsed as png, just load a fresh game against random bot, randomize who goes first
// TODO make backwards compatible with previous notation
// TODO if there is parseable PGN, load it... otherwise try and make sense of it to parse
import { Chess } from 'chess.js'
import { INPUT_EVENT_TYPE, COLOR, Chessboard, BORDER_TYPE } from "cm-chessboard/src/Chessboard.js"
import { MARKER_TYPE, Markers } from "cm-chessboard/src/extensions/markers/Markers.js"
import { PROMOTION_DIALOG_RESULT_TYPE, PromotionDialog } from "cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js"
import { Accessibility } from "cm-chessboard/src/extensions/accessibility/Accessibility.js"

const expand = text => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
}

function cleanBeforeMakepgn(item) {
  // for later when item text gets more complicated than just pgn
  return item
}

async function makepgn($item, item) {
  return item.text; // This is the raw item text, this function need to return pgn

  function trouble(text, detail) {
    // console.log(text,detail)
    throw new Error(text + "\n" + detail)
  }

}

function message(text) {
  return `
      <div class="viewer" data-item="viewer" style="width:98%">
        <div style="width:80%; padding:8px; color:gray; background-color:#eee; margin:0 auto; text-align:center">
          <i>${text}</i>
        </div>
      </div>
    `
}

function emit($item, item) {
  // append css files to head
  ["chessboard", "markers", "promotion-dialog"].forEach((name) => {
    if (!([...document.styleSheets].filter((e) => e.ownerNode.hasAttribute('href'))
      .filter((e) => e.href.endsWith(`/plugins/chess/${name}.css`)).length)) {
      // console.log(`adding ${name} style`)
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = `/plugins/chess/${name}.css`
      link.type = 'text/css'
      document.getElementsByTagName('head')[0].appendChild(link)
    } else {
      // console.log(`already have ${name} style`)
    }
  })

  return $item.append(message('loading board...'));
};

async function bind($item, item) {
  $item.on('dblclick', () => {
    return wiki.textEditor($item, item);
  });

  function download(filename, text) {
    var element = document.createElement('a');
    element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    element.setAttribute('download', filename);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }

  $item.on('click', event => {
    // console.log("Clicked on item!")


    // const { target } = event

    // const { action } = (target.closest("a") || {}).dataset

    // if (!action) {
    //   return
    // }
    // event.stopPropagation()
    // event.preventDefault()
    // switch (action) {
    //   case "download":
    //     const slug = $item.parents('.page').attr('id')
    //     download(`${slug}.svg`, item.svg)
    //     break
    //   case "zoom":
    //     // wiki.dialog('Graphviz', item.svg)
    //     const pageKey = $item.parents('.page').data('key')
    //     const context = wiki.lineup.atKey(pageKey).getContext()
    //     const chessDialog = window.open('/plugins/chess/dialog/#', event.shiftKey ? '_blank' : 'chess', 'popup,height=600,width=800')
    //     if (chessDialog.location.pathname !== '/plugins/chess/dialog/') {
    //       chessDialog.addEventListener('load', (event) => {
    //         chessDialog.postMessage({ svg: item.svg, pageKey, context }, window.origin)
    //       })
    //     } else {
    //       chessDialog.postMessage({ svg: item.svg, pageKey, context }, window.origin)
    //     }
    //     break
    // }
  })

  try {
    let pgn = await makepgn($item, cleanBeforeMakepgn(item))
    $item.find('.viewer').html(`
        <div class="diagram"></class>
        <div id="board" class="board board-large" style="width: 400px"></div>
        <div id="output"></div>
        <p id="gameStatus"></p>
      `)

    // try adding the download stuff back in later
    /*
      <nav class="actions">
      <a href="#" data-action="download" title="Download"><img width="18" height="18" alt="download" src='data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 24 24" viewBox="0 0 24 24" fill="grey"><g><rect fill="none" height="24" width="24"/></g><g><path d="M5,20h14v-2H5V20z M19,9h-4V3H9v6H5l7,7L19,9z"/></g></svg>'></a>
      <a href="#" data-action="zoom" title="Zoom"><img width="18" height="18" alt="toggle zoom" src='data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" enable-background="new 0 0 24 24" viewBox="0 0 24 24"><g><rect fill="none" height="24" width="24"/></g><g><g><g><path fill="grey" d="M15,3l2.3,2.3l-2.89,2.87l1.42,1.42L18.7,6.7L21,9V3H15z M3,9l2.3-2.3l2.87,2.89l1.42-1.42L6.7,5.3L9,3H3V9z M9,21 l-2.3-2.3l2.89-2.87l-1.42-1.42L5.3,17.3L3,15v6H9z M21,15l-2.3,2.3l-2.87-2.89l-1.42,1.42l2.89,2.87L15,21h6V15z"/></g></g></g></svg>'></a>
      </nav>

    */

    const chess = new Chess()
    updateStatus()

    function makeEngineMove(chessboard) {
      const possibleMoves = chess.moves({ verbose: true })
      if (possibleMoves.length > 0) {
        const randomIndex = Math.floor(Math.random() * possibleMoves.length)
        const randomMove = possibleMoves[randomIndex]
        setTimeout(() => { // smoother with 500ms delay
          chess.move({ from: randomMove.from, to: randomMove.to })
          chessboard.setPosition(chess.fen(), true)
          // chessboard.enableMoveInput(inputHandler, COLOR.white)
        }, 500)
      }
      updateStatus()
    }

    function inputHandler(event) {
      if (event.type === INPUT_EVENT_TYPE.movingOverSquare) {
        return // ignore this event
      }
      if (event.type !== INPUT_EVENT_TYPE.moveInputFinished) {
        event.chessboard.removeLegalMovesMarkers()
      }
      if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
        // mark legal moves
        const moves = chess.moves({ square: event.squareFrom, verbose: true })
        event.chessboard.addLegalMovesMarkers(moves)
        return moves.length > 0
      } else if (event.type === INPUT_EVENT_TYPE.validateMoveInput) {
        const move = { from: event.squareFrom, to: event.squareTo, promotion: event.promotion }
        try {
          const result = chess.move(move)
          event.chessboard.state.moveInputProcess.then(() => { // wait for the move input process has finished
            event.chessboard.setPosition(chess.fen(), true).then(() => { // update position, maybe castled and wait for animation has finished
              makeEngineMove(event.chessboard)
            })
          })
        } catch {
          // promotion?
          let possibleMoves = chess.moves({ square: event.squareFrom, verbose: true })
          for (const possibleMove of possibleMoves) {
            if (possibleMove.promotion && possibleMove.to === event.squareTo) {
              event.chessboard.showPromotionDialog(event.squareTo, COLOR.white, (result) => {
                if (result.type === PROMOTION_DIALOG_RESULT_TYPE.pieceSelected) {
                  chess.move({ from: event.squareFrom, to: event.squareTo, promotion: result.piece.charAt(1) })
                  event.chessboard.setPosition(chess.fen(), true)
                  makeEngineMove(event.chessboard)
                } else {
                  // promotion canceled
                  event.chessboard.enableMoveInput(inputHandler, COLOR.white)
                  event.chessboard.setPosition(chess.fen(), true)
                }
              })
              return true
            }
          }
        }
        return
      } else if (event.type === INPUT_EVENT_TYPE.moveInputFinished) {
        if (event.legalMove) {
          event.chessboard.disableMoveInput()
        }
      }
    }

    const board = new Chessboard(document.getElementById("board"), {
      position: chess.fen(),
      assetsUrl: "/plugins/chess/assets/",
      style: { borderType: BORDER_TYPE.none, pieces: { file: "pieces/staunty.svg" }, animationDuration: 300 },
      orientation: COLOR.white,
      extensions: [
        { class: Markers, props: { autoMarkers: MARKER_TYPE.square } },
        { class: PromotionDialog },
        { class: Accessibility, props: { visuallyHidden: true } }
      ]
    })
    board.enableMoveInput(inputHandler, COLOR.white)

    function updateStatus() {
      let statusHTML = ''

      if (chess.isCheckmate() && chess.turn() === 'w') {
        statusHTML = 'Game over: white is in checkmate. Black wins!'
      } else if (chess.isCheckmate() && chess.turn() === 'b') {
        statusHTML = 'Game over: black is in checkmate. White wins!'
      } else if (chess.isStalemate() && chess.turn() === 'w') {
        statusHTML = 'Game is drawn. White is stalemated.'
      } else if (chess.isStalemate() && chess.turn() === 'b') {
        statusHTML = 'Game is drawn. Black is stalemated.'
      } else if (chess.isThreefoldRepetition()) {
        statusHTML = 'Game is drawn by threefold repetition rule.'
      } else if (chess.isInsufficientMaterial()) {
        statusHTML = 'Game is drawn by insufficient material.'
      } else if (chess.isDraw()) {
        statusHTML = 'Game is drawn by fifty-move rule.'
      } else {
        statusHTML = 'Game is ongoing.'
      }

      document.getElementById('gameStatus').innerHTML = statusHTML
      if (chess.isGameOver()) console.log(chess.pgn());
    }

  } catch (err) {
    console.log('makepgn', err)
    $item.html(message(err.message))
  }
};

function chessListener(event) {
  // only continue if event is from a chess popup.
  // events from a popup window will have an opener
  // ensure that the popup window is one of ours
  if (!event.source.opener || event.source.location.pathname !== '/plugins/chess/dialog/') {
    if (wiki.debug) { console.log('chessListener - not for us', { event }) }
    return
  }
  if (wiki.debug) { console.log('chessListener - ours', { event }) }

  const { data } = event
  const { action, keepLineup = false, pageKey = null, title = null, context = null } = data;

  let $page = null
  if (pageKey != null) {
    $page = keepLineup ? null : $('.page').filter((i, el) => $(el).data('key') == pageKey)
  }

  switch (action) {
    case 'doInternalLink':
      wiki.pageHandler.context = context
      wiki.doInternalLink(title, $page)
      break
    default:
      console.error({ where: 'chessListener', message: "unknown action", data })
  }
}

if (typeof window !== "undefined" && window !== null) {
  if (!window.plugins.chess) {
    window.plugins.chess = { emit, bind };
    if (typeof window.chessListener !== "undefined"
      || window.chessListener == null) {
      console.log('**** Adding chess listener')
      window.chessListener = chessListener
      window.addEventListener("message", chessListener)
    }
  }
}

export const chess = typeof window == 'undefined' ? { expand } : undefined