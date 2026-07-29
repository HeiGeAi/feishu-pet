const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const fixture = path.join(__dirname, 'fixtures', 'mock-lark.cjs')

test('calendar writes use the primary alias accepted by the user API', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pet-calendar-'))
  const logPath = path.join(tempDir, 'calls.ndjson')
  const previousLarkCli = process.env.LARK_CLI
  const previousMockLog = process.env.MOCK_LARK_LOG
  fs.chmodSync(fixture, 0o755)
  process.env.LARK_CLI = fixture
  process.env.MOCK_LARK_LOG = logPath

  const modulePath = require.resolve('../feishu/workspace-client.cjs')
  delete require.cache[modulePath]
  const workspace = require(modulePath)

  let callsText = ''
  try {
    await workspace.createCalendarEvent({
      summary: '测试会议',
      start: '2026-07-28T14:00:00+08:00',
      end: '2026-07-28T15:00:00+08:00',
      meeting: true,
      attendees: ['ou_test_user'],
    })
    await workspace.listAgenda({
      start: '2026-07-28T00:00:00+08:00',
      end: '2026-07-29T00:00:00+08:00',
    })
    callsText = fs.readFileSync(logPath, 'utf8')
  } finally {
    if (previousLarkCli === undefined) delete process.env.LARK_CLI
    else process.env.LARK_CLI = previousLarkCli
    if (previousMockLog === undefined) delete process.env.MOCK_LARK_LOG
    else process.env.MOCK_LARK_LOG = previousMockLog
    delete require.cache[modulePath]
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  const calls = callsText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const create = calls.find((args) => args.slice(0, 3).join(' ') === 'calendar events create')
  const attendees = calls.find((args) => args.slice(0, 3).join(' ') === 'calendar event.attendees create')
  const agenda = calls.find((args) => args.slice(0, 2).join(' ') === 'calendar +agenda')

  assert.equal(JSON.parse(create[create.indexOf('--params') + 1]).calendar_id, 'primary')
  assert.equal(JSON.parse(attendees[attendees.indexOf('--params') + 1]).calendar_id, 'primary')
  assert.equal(agenda[agenda.indexOf('--calendar-id') + 1], 'primary')
})
