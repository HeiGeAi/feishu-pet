const assert = require('node:assert/strict')
const test = require('node:test')

let watcher

test.before(async () => {
  watcher = await import('../feishu/group-watcher.mjs')
})

test('one-shot options only accept supported summary jobs', () => {
  assert.deepEqual(
    watcher.parseRunOptions(['--job', 'summary:12', '--label', '12 小时消息总结']),
    { job: 'summary:12', label: '12 小时消息总结', reportNow: false },
  )
  assert.throws(
    () => watcher.parseRunOptions(['--job', 'calendar.delete']),
    (error) => error.code === 'INVALID_COMMAND',
  )
})

test('current user open id can be discovered without .env.local', async () => {
  let calls = 0
  const openId = await watcher.resolveMyOpenId(async (args) => {
    calls++
    assert.deepEqual(args, ['auth', 'status', '--json'])
    return { identities: { user: { openId: 'ou_123abc' } } }
  })
  assert.equal(openId, 'ou_123abc')
  assert.equal(calls, 1)
})

test('message collection discovers chats and reads each chat once', async () => {
  const calls = []
  const runCommand = async (args) => {
    calls.push(args)
    if (args.slice(0, 2).join(' ') === 'im +chat-list') {
      return {
        ok: true,
        data: {
          chats: [
            { chat_id: 'oc_group1', name: '项目群', chat_mode: 'group' },
            { chat_id: 'oc_person1', name: '小杨', chat_mode: 'p2p' },
          ],
        },
      }
    }
    const chatId = args[args.indexOf('--chat-id') + 1]
    return {
      ok: true,
      data: {
        messages: [{
          message_id: `om_${chatId}`,
          create_time: '2026-07-28T10:00:00+08:00',
          content: '请确认方案',
          sender: { name: '同事' },
          msg_type: 'text',
        }],
      },
    }
  }
  const lines = await watcher.collectLines(6, {
    runCommand,
    configuredChatId: '',
    inboxChats: 2,
    classifyMessage: (message) => ({ name: message.sender.name, text: message.content }),
  })
  assert.equal(calls.length, 3)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /\[项目群\] 同事: 请确认方案/)
  assert.match(lines[1], /\[私聊·小杨\] 同事: 请确认方案/)
})

test('missing message permission is surfaced instead of becoming an empty summary', async () => {
  const permissionError = watcher.errorFromEnvelope({
    ok: false,
    error: {
      type: 'authorization',
      subtype: 'missing_scope',
      message: 'missing required scope(s): im:message.history:readonly',
      missing_scopes: ['im:message.history:readonly'],
    },
  })
  await assert.rejects(
    watcher.collectLines(6, {
      configuredChatId: '',
      runCommand: async () => { throw permissionError },
    }),
    (error) => error.code === 'PERMISSION_REQUIRED' && error.missingScopes[0] === 'im:message.history:readonly',
  )

  const failure = watcher.formatJobFailure(permissionError)
  assert.equal(failure.label, '消息总结缺少飞书读取权限')
  assert.match(failure.report, /lark-cli auth login --scope/)
  assert.ok(watcher.MESSAGE_READ_SCOPES.includes('im:message.history:readonly'))
  for (const scope of watcher.MESSAGE_READ_SCOPES) assert.match(failure.command, new RegExp(scope))
})

test('one-shot command executes once and publishes actionable failures', async () => {
  let runs = 0
  const success = await watcher.handleCommand(
    { command: 'summary:6', label: '6 小时消息总结' },
    {
      runJob: async (hours, mode) => {
        runs++
        assert.equal(hours, 6)
        assert.equal(mode, 'summary')
      },
      postResult: async () => {},
    },
  )
  assert.equal(success.ok, true)
  assert.equal(runs, 1)

  const posts = []
  const failed = await watcher.handleCommand(
    { command: 'todo', label: '整理今日待办' },
    {
      runJob: async () => {
        throw new watcher.WatcherError('missing scope', {
          code: 'PERMISSION_REQUIRED',
          missingScopes: ['im:chat:read'],
        })
      },
      postResult: async (path, body) => posts.push({ path, body }),
    },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'PERMISSION_REQUIRED')
  assert.deepEqual(posts.map((item) => item.path), ['/api/report', '/api/event'])
})
