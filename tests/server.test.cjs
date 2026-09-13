const assert = require('node:assert/strict')
const test = require('node:test')

const { startPetServer } = require('../desktop/server.cjs')

// /api/event 与 /api/interact 的 Origin 白名单、CORS 收紧与 body 上限是本项目的安全语义核心，
// 这里起真实端口做一轮集成测试，防回归。

const TEST_PORT = 7611
const base = `http://127.0.0.1:${TEST_PORT}`
let server

const post = (url, body, headers = {}) =>
  fetch(base + url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', connection: 'close', ...headers },
  }).then(async (r) => ({ status: r.status, headers: r.headers, json: await r.json() }))

test.before(async () => {
  server = startPetServer({ port: TEST_PORT, host: '127.0.0.1', distDir: '/nonexistent' })
  await new Promise((resolve) => server.on('listening', resolve))
})

test.after(() => {
  server?.close()
})

test('browser page with foreign origin cannot forge pet events (local CSRF guard)', async () => {
  const evil = await post('/api/event', JSON.stringify({ state: 'working' }), {
    origin: 'https://evil.example',
  })
  assert.equal(evil.status, 403)
  assert.equal(evil.json.ok, false)

  const evilInteract = await post('/api/interact', JSON.stringify({ kind: 'pat' }), {
    origin: 'https://evil.example',
  })
  assert.equal(evilInteract.status, 403)
})

test('local curl / pet-hook without Origin is still accepted', async () => {
  const okEvent = await post('/api/event', JSON.stringify({ state: 'working', text: 'hi' }))
  assert.equal(okEvent.status, 200)
  assert.equal(okEvent.json.ok, true)
  assert.equal(okEvent.json.event.state, 'working')
})

test('CORS echoes only validated local origin, never a wildcard', async () => {
  const localOrigin = `http://127.0.0.1:${TEST_PORT}`
  const res = await post('/api/event', JSON.stringify({ state: 'idle' }), { origin: localOrigin })
  assert.equal(res.status, 200)

  // 本机 Origin 的预检回显该 Origin
  const preflightOk = await fetch(base + '/api/event', {
    method: 'OPTIONS',
    headers: { origin: localOrigin, connection: 'close' },
  })
  assert.equal(preflightOk.status, 204)
  assert.equal(preflightOk.headers.get('access-control-allow-origin'), localOrigin)

  // 非本机 Origin 的预检直接 403，且任何情况下都不出现通配符 *
  const preflight = await fetch(base + '/api/event', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', connection: 'close' },
  })
  assert.equal(preflight.status, 403)
  assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*')
})

test('POST body over 512KB is rejected with 413, invalid JSON with 400', async () => {
  const big = await post('/api/interact', '{"kind":"' + 'x'.repeat(600 * 1024) + '"}')
  assert.equal(big.status, 413)
  assert.equal(big.json.code, 'BODY_TOO_LARGE')

  const bad = await post('/api/event', '{not json')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.code, 'INVALID_JSON')
})

test('workspace-style routes still require the local client header', async () => {
  const noHeader = await post('/api/report', JSON.stringify({ text: 'hi', trigger: 'manual' }))
  assert.equal(noHeader.status, 403)
  assert.equal(noHeader.json.code, 'INVALID_CLIENT_REQUEST')

  const withHeader = await post('/api/report', JSON.stringify({ text: 'hi', trigger: 'manual' }), {
    'x-feishu-pet-request': '1',
  })
  assert.equal(withHeader.status, 200)
  assert.equal(withHeader.json.ok, true)
})
