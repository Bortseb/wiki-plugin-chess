/** Modal mount-restore and suspend/resume when stacking dialogs (e.g. paste over seat claim). */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closeActiveModal, registerMountRestore, restoreEmbeddedMount, suspendForStacking } from '../src/modals.js'

describe('app · modals', () => {
  describe('mount restore', () => {
    it('closeActiveModal runs the registered mount restore', () => {
      let restored = 0
      registerMountRestore(() => {
        restored += 1
      })
      closeActiveModal()
      assert.equal(restored, 1)
      closeActiveModal()
      assert.equal(restored, 1)
    })

    it('restoreEmbeddedMount runs the registered callback once', () => {
      const order = []
      registerMountRestore(() => order.push('first'))
      restoreEmbeddedMount()
      assert.deepEqual(order, ['first'])
      registerMountRestore(() => order.push('second'))
      closeActiveModal({ restoreMount: false })
      assert.deepEqual(order, ['first'])
      closeActiveModal()
      assert.deepEqual(order, ['first', 'second'])
    })

    it('suspendForStacking is a no-op without an active shell modal', () => {
      assert.doesNotThrow(() => suspendForStacking())
      let restored = 0
      registerMountRestore(() => {
        restored += 1
      })
      closeActiveModal()
      assert.equal(restored, 1)
    })

    it('discardSuspended clears stacked overlays without resuming them', () => {
      let discarded = 0
      registerMountRestore(() => {
        discarded += 1
      })
      closeActiveModal({ discardSuspended: true, restoreMount: false })
      assert.equal(discarded, 0)
    })
  })
})
