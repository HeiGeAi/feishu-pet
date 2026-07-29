#!/usr/bin/env node

const fs = require('fs')

const args = process.argv.slice(2)
const logPath = process.env.MOCK_LARK_LOG
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`)

const command = args.slice(0, 3).join(' ')
const shortCommand = args.slice(0, 2).join(' ')
if (args[0] === '--version') {
  process.stdout.write('lark-cli version 1.0.53\n')
} else if (shortCommand === 'auth status') {
  process.stdout.write(JSON.stringify({
    identities: { user: { available: true, tokenStatus: 'valid', openId: 'ou_test_user' } },
  }))
} else if (shortCommand === 'auth check') {
  const missing = String(process.env.MOCK_LARK_MISSING_SCOPES || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
  process.stdout.write(JSON.stringify({ missing }))
} else if (command === 'calendar events create') {
  process.stdout.write(JSON.stringify({ event: { event_id: 'event-test-001' } }))
} else {
  process.stdout.write(JSON.stringify({ ok: true }))
}
