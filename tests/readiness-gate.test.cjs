const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('window ready gate ignores early opens and starts opening only after listening', () => {
  const modulePath = path.join(__dirname, '..', 'desktop', 'readiness-gate.cjs')
  assert.equal(fs.existsSync(modulePath), true, 'readiness gate module must exist')
  const { createReadinessGate } = require(modulePath)
  const opens = []
  const gate = createReadinessGate(() => opens.push('open'))

  assert.equal(gate.open(), false)
  assert.deepEqual(opens, [])

  assert.equal(gate.markReady(), true)
  assert.deepEqual(opens, ['open'])

  assert.equal(gate.open(), true)
  assert.deepEqual(opens, ['open', 'open'])
})
