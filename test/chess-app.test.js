/** Build guard — client/chess-app.js (from src/chess-app.js) must hoist cm-modules-bundle imports. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const chessAppPath = path.join(root, 'client/chess-app.js')

describe('chess-app', () => {
  it('ships with a single external cm-modules-bundle import', () => {
    assert.ok(fs.existsSync(chessAppPath), 'run npm run build first')
    const js = fs.readFileSync(chessAppPath, 'utf8')
    const imports = js.match(/import\{[^}]+\}from"\.\/cm-modules-bundle\.js";/g) || []
    assert.equal(imports.length, 1, 'mid-bundle imports break the chess iframe loader')
  })
})
