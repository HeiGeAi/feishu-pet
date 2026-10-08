const test = require('node:test')
const assert = require('node:assert/strict')
const { createChannelAccess } = require('../desktop/channel-access.cjs')

test('only the exact trusted main frame receives a runtime capability', () => {
  const expectedUrl = 'file:///synthetic/dist/pet.html'
  const frame = { url: expectedUrl }
  const webContents = { mainFrame: frame }
  let win = { webContents }
  const get = createChannelAccess({ getWindow: () => win, expectedUrl, base: 'http://127.0.0.1:7100', token: 'synthetic' })
  assert.equal(get({ sender: webContents, senderFrame: frame }).token, 'synthetic')
  assert.throws(() => get({ sender: {}, senderFrame: frame }), /Untrusted/)
  assert.throws(() => get({ sender: webContents, senderFrame: { url: expectedUrl } }), /Untrusted/)
  frame.url = 'https://evil.example/'
  assert.throws(() => get({ sender: webContents, senderFrame: frame }), /Untrusted/)
  win = null
  assert.throws(() => get({ sender: webContents, senderFrame: frame }), /Untrusted/)
})
