// Process-lifetime capability delivery: only the exact pet file's main frame.
function createChannelAccess({ getWindow, expectedUrl, base, token }) {
  return (event) => {
    const win = getWindow()
    if (!win || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== expectedUrl) {
      throw new Error('Untrusted pet window')
    }
    return { base, token }
  }
}
module.exports = { createChannelAccess }
