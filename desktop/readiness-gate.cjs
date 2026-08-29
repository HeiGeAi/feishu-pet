'use strict'

function createReadinessGate(openWindow) {
  let ready = false
  const open = () => {
    if (!ready) return false
    openWindow()
    return true
  }
  return {
    open,
    markReady() {
      ready = true
      return open()
    },
  }
}

module.exports = { createReadinessGate }
