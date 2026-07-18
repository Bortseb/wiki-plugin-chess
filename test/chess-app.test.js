/** Build guard — client/chess-app.js (from src/chess-app.js) must hoist cm-modules-bundle imports. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const chessAppPath = path.join(root, 'client/chess-app.js')
const chessAppSourcePath = path.join(root, 'src/chess-app.js')
const submoduleSources = [
  'src/survey.js',
  'src/leaderboard.js',
  'src/realtime.js',
  'src/choose-menu.js',
  'src/position.js',
  'src/game.js',
  'src/puzzle.js',
  'src/board-layout.js',
]

describe('guards · chess-app', () => {
  it('ships with a single external cm-modules-bundle import', () => {
    assert.ok(fs.existsSync(chessAppPath), 'run npm run build first')
    const js = fs.readFileSync(chessAppPath, 'utf8')
    const imports = js.match(/import\{[^}]+\}from"\.\/cm-modules-bundle\.js(?:\?v=[^"]*)?";/g) || []
    assert.equal(imports.length, 1, 'mid-bundle imports break the chess iframe loader')
  })

  it('submodules route shell traffic through wiki.* helpers', () => {
    const raw = /postToShell\(\{\s*action:\s*MSG\./
    for (const rel of submoduleSources) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
      assert.doesNotMatch(src, raw, `${rel} still uses raw postToShell(MSG.*)`)
    }
  })

  it('mode switches apply on the confirming surface even when following a popup', () => {
    const src = fs.readFileSync(path.join(root, 'src/choose-menu.js'), 'utf8')
    // Must not early-return after forwarding to the shell — mobile zombie popups
    // would leave the embed stuck on the game.
    assert.match(src, /function reclaimSurfaceFromPopupFollow\(/)
    assert.match(
      src,
      /export function proceedReturnToStartMenu\(\) \{\s*if \(app\.followsPopup\) \{\s*shellMessenger\(\)\?\.requestSwitchGameMode\(\)\s*reclaimSurfaceFromPopupFollow\(\)\s*\}\s*returnToStartMenu\(\)/,
    )
    assert.match(
      src,
      /function proceedOpenPositionEditor\(fen\) \{\s*if \(app\.followsPopup\) \{\s*shellMessenger\(\)\?\.requestOpenPositionEditor\(\{ fen \}\)\s*reclaimSurfaceFromPopupFollow\(\)\s*\}\s*switchToPositionEditorFromGame\(fen\)/,
    )
  })

  it('defines player bar HTML helpers in game.js view layer', () => {
    const src = fs.readFileSync(path.join(root, 'src/game.js'), 'utf8')
    const app = fs.readFileSync(chessAppSourcePath, 'utf8')
    assert.match(src, /function playerLabelHtml\(/)
    assert.match(src, /function playerFaviconHtml\(/)
    assert.match(src, /function playerBarHtml\(/)
    assert.match(src, /wiki-chess-seat-king/)
    assert.match(src, /seatKingPreviewHtml\(isBlack \? 'b' : 'w'/)
    assert.doesNotMatch(src, /from ['"]\.\/chess-app\.js['"]/)
    assert.doesNotMatch(src, /import \{[\s\S]*\bplayerLabelHtml\b[\s\S]*\} from '\.\/chess-core\.js'/)
    assert.match(app, /from ['"]\.\/game\.js['"]/)
  })
})
