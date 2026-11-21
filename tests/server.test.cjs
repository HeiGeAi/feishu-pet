const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Import the store only after isolating its home path from the developer's archive.
const originalHomedir = os.homedir
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pet-server-'))
os.homedir = () => testHome

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
  server = startPetServer({ desktopToken: 'a'.repeat(64), port: TEST_PORT, host: '127.0.0.1', distDir: '/nonexistent' })
  await new Promise((resolve) => server.on('listening', resolve))
})

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  os.homedir = originalHomedir
  fs.rmSync(testHome, { recursive: true, force: true })
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

test('opaque origin cannot read events or mutate pet state', async () => {
  const secret = 'SYNTHETIC_PRIVATE_REPORT'
  const report = await post('/api/report', JSON.stringify({ text: secret, trigger: 'manual' }), { 'x-feishu-pet-request': '1' })
  assert.equal(report.status, 200)
  for (const token of ['', '?desktopToken=wrong']) {
    const stream = await fetch(base + '/api/events' + token, { headers: { origin: 'null', connection: 'close' } })
    assert.equal(stream.status, 403)
    assert.equal(stream.headers.get('access-control-allow-origin'), null)
    assert.equal((await stream.text()).includes(secret), false)
    for (const route of ['/api/event', '/api/interact']) {
      const response = await post(route + token, JSON.stringify({ state: 'working', kind: 'pat' }), { origin: 'null', 'content-type': 'text/plain' })
      assert.equal(response.status, 403)
    }
  }
})

test('Electron capability authenticates initial connection and reconnect; local web remains supported', async () => {
  for (const origin of ['null', `http://127.0.0.1:${TEST_PORT}`]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const response = await fetch(base + '/api/events?desktopToken=' + 'a'.repeat(64), { headers: { origin }, signal: controller.signal })
      assert.equal(response.status, 200)
      const chunk = await response.body.getReader().read()
      assert.match(new TextDecoder().decode(chunk.value), /"type":"init"/)
      controller.abort()
    }
  }
  const response = await post('/api/event?desktopToken=' + 'a'.repeat(64), JSON.stringify({ state: 'idle' }), { origin: 'null' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'null')
  const foreign = await fetch(base + '/api/events?desktopToken=' + 'a'.repeat(64), { headers: { origin: 'https://evil.example', connection: 'close' } })
  assert.equal(foreign.status, 403)
})

test('invalid event state returns HTTP 400 and split multi-byte UTF-8 chunks stay intact', async () => {
  const invalid = await post('/api/event', JSON.stringify({ state: 'nonexistent', label: 'bad' }))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.ok, false)
  assert.equal(invalid.json.code, 'INVALID_STATE')

  // Split a 3-byte Chinese UTF-8 sequence across separate HTTP write chunks.
  const payload = Buffer.from(JSON.stringify({ state: 'working', label: '中文分块测试🐾' }), 'utf8')
  const splitIndex = payload.indexOf(Buffer.from('中', 'utf8')) + 1
  const chunkedResult = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/event',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          connection: 'close',
        },
      },
      (res) => {
        const parts = []
        res.on('data', (chunk) => parts.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode,
          json: JSON.parse(Buffer.concat(parts).toString('utf8')),
        }))
      },
    )
    req.on('error', reject)
    req.write(payload.subarray(0, splitIndex))
    setTimeout(() => {
      req.end(payload.subarray(splitIndex))
    }, 10)
  })
  assert.equal(chunkedResult.status, 200)
  assert.equal(chunkedResult.json.event.label, '中文分块测试🐾')
})

test('malformed percent-encoding in workspace route returns 400 instead of 500', async () => {
  const res = await fetch(base + '/api/workspace/approvals/%E0%A4%A', {
    headers: { connection: 'close' },
  })
  const data = await res.json()
  assert.equal(res.status, 400)
  assert.equal(data.code, 'INVALID_URI')
})

test('llm-config rejects non-http baseUrl with 400 and persists valid config atomically with 0600', async () => {
  const badScheme = await post('/api/llm-config', JSON.stringify({
    provider: 'api',
    baseUrl: 'file:///etc/passwd',
    model: 'gpt-4o-mini',
  }), { 'x-feishu-pet-request': '1' })
  assert.equal(badScheme.status, 400)
  assert.equal(badScheme.json.code, 'INVALID_BASE_URL')

  const okCfg = await post('/api/llm-config', JSON.stringify({
    provider: 'api',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'test-key-123456',
  }), { 'x-feishu-pet-request': '1' })
  assert.equal(okCfg.status, 200)
  assert.equal(okCfg.json.ok, true)
  const configPath = path.join(testHome, '.xiaojue-pet', 'llm.json')
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600)
})

test('static server works with trailing-slash distDir and blocks symlink escape', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pet-static-'))
  const dist = path.join(scratch, 'dist')
  const secret = path.join(scratch, 'secret.txt')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>ok</h1>')
  fs.writeFileSync(secret, 'TOP_SECRET')
  fs.symlinkSync(secret, path.join(dist, 'escape.txt'))
  const staticPort = 7612
  const staticServer = startPetServer({
    port: staticPort,
    host: '127.0.0.1',
    distDir: dist + path.sep,
  })
  await new Promise((resolve) => staticServer.on('listening', resolve))
  try {
    const okRes = await fetch(`http://127.0.0.1:${staticPort}/`, { headers: { connection: 'close' } })
    assert.equal(okRes.status, 200)
    assert.equal(await okRes.text(), '<h1>ok</h1>')

    const escaped = await fetch(`http://127.0.0.1:${staticPort}/escape.txt`, { headers: { connection: 'close' } })
    assert.equal(escaped.status, 404)
  } finally {
    await new Promise((resolve) => staticServer.close(resolve))
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
