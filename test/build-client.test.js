/** Unit tests for scripts/build-client.js — cm-modules-bundle import hoisting. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hoistCmBundleImports, stampCmBundleImport } from '../scripts/build-client.js'

const chessCoreSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/chess-core.js'),
  'utf8',
)

describe('guards · build-client', () => {
  it('hoists duplicate cm-modules-bundle imports to the bundle top', () => {
    const input = [
      '/* banner */',
      'import{Pgn as A}from"./cm-modules-bundle.js";',
      'const x=1;',
      'import{Board as B}from"./cm-modules-bundle.js";',
      'export{x}',
    ].join('')
    const out = hoistCmBundleImports(input)
    assert.match(out, /^\/\* banner \*\/import\{Pgn as A,Board as B\}from"\.\/cm-modules-bundle\.js";/)
    assert.equal((out.match(/import\{/g) || []).length, 1)
  })

  it('stamps a cache-busting query on the cm-modules-bundle import', () => {
    const input = 'import{Board as B}from"./cm-modules-bundle.js";const x=1'
    assert.equal(
      stampCmBundleImport(input, '1.2.3+99'),
      'import{Board as B}from"./cm-modules-bundle.js?v=1.2.3+99";const x=1',
    )
    assert.equal(
      stampCmBundleImport('import{Board as B}from"./cm-modules-bundle.js?v=old";', 'new'),
      'import{Board as B}from"./cm-modules-bundle.js?v=new";',
    )
  })

  it('keeps chess-core free of federation.js imports', () => {
    assert.doesNotMatch(chessCoreSource, /from ['"]\.\/federation\.js['"]/)
  })

  it('preserves upstream license comments in esbuild bundles', () => {
    const buildClientSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/build-client.js'),
      'utf8',
    )
    assert.match(buildClientSource, /legalComments:\s*['"]inline['"]/)
  })
})
