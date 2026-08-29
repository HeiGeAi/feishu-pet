const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { startPetServer } = require('../desktop/server.cjs')

function listen(server) {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function request(server, { method = 'GET', pathname, headers = {}, body = '' }) {
  const address = server.address()
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
        if (res.headers['content-type'] === 'text/event-stream') {
          req.destroy()
          resolve({ status: res.statusCode, headers: res.headers, body: text })
        }
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function start(options = {}) {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port
      probe.close((error) => (error ? reject(error) : resolve(selected)))
    })
  })
  const server = startPetServer({ port, capability: 'test-capability', ...options })
  await listen(server)
  return server
}

test('SSE rejects an opaque null Origin without reflecting CORS access', async (t) => {
  const server = await start()
  t.after(() => close(server))

  const response = await request(server, {
    pathname: '/api/events?cap=test-capability',
    headers: { Origin: 'null' },
  })

  assert.equal(response.status, 403)
  assert.equal(response.headers['access-control-allow-origin'], undefined)
})

test('SSE rejects an exact loopback Origin without the per-process capability', async (t) => {
  const server = await start()
  t.after(() => close(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const response = await request(server, {
    pathname: '/api/events',
    headers: { Origin: origin },
  })

  assert.equal(response.status, 403)
  assert.equal(response.headers['access-control-allow-origin'], undefined)
})

test('shutdown flush preserves an archive item added inside the three-second interval', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pet-archive-'))
  const archivePath = path.join(home, 'archive.json')
  const first = await start({ archivePath })
  t.after(async () => {
    if (first.listening) await close(first)
  })

  const post = await request(first, {
    method: 'POST',
    pathname: '/api/event',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'working', label: '退出前最后一条', source: 'test' }),
  })
  assert.equal(post.status, 200)
  assert.equal(typeof first.flushArchive, 'function')
  await first.flushArchive()
  await close(first)

  const second = await start({ archivePath })
  t.after(async () => {
    await close(second)
    fs.rmSync(home, { recursive: true, force: true })
  })
  const archived = await request(second, { pathname: '/api/archive' })
  const payload = JSON.parse(archived.body)

  assert.equal(payload.total, 1)
  assert.equal(payload.items[0].label, '退出前最后一条')
})

test('failed archive publication keeps the previous file and retries dirty state', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pet-retry-'))
  const archivePath = path.join(home, 'archive.json')
  const previous = [{ id: 'previous', kind: 'message', label: '旧归档', ts: 1 }]
  fs.writeFileSync(archivePath, JSON.stringify(previous))
  let writes = 0
  const server = await start({
    archivePath,
    archiveWriteFile: async (...args) => {
      writes += 1
      if (writes === 1) throw new Error('injected write failure')
      return fs.promises.writeFile(...args)
    },
  })
  t.after(async () => {
    await close(server)
    fs.rmSync(home, { recursive: true, force: true })
  })

  await request(server, {
    method: 'POST',
    pathname: '/api/event',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'success', label: '新归档', source: 'test' }),
  })
  assert.equal(typeof server.flushArchive, 'function')
  await assert.rejects(server.flushArchive(), /injected write failure/)
  assert.deepEqual(JSON.parse(fs.readFileSync(archivePath, 'utf8')), previous)

  await server.flushArchive()
  const saved = JSON.parse(fs.readFileSync(archivePath, 'utf8'))
  assert.deepEqual(saved.map((item) => item.label), ['旧归档', '新归档'])
})
