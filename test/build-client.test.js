/** Unit tests for scripts/build-client.js — cm-modules-bundle import hoisting. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hoistCmBundleImports } from '../scripts/build-client.js'

describe('build-client', () => {
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
})
