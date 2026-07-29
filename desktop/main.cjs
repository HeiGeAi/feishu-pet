/**
 * 小绝 · 桌面宠物主进程
 *
 * 桌面宠物形态：
 *  - 透明无边框窗口，置顶悬浮，不占任务栏/Dock
 *  - 按住拖动，单击摸头，右键菜单（摸头/投喂/置顶/鼠标穿透/看板/退出）
 *  - 系统托盘常驻
 *  - 内嵌事件服务器（desktop/server.cjs），飞书 CLI 外挂协议不变
 */
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  screen,
  shell,
  nativeImage,
  globalShortcut,
} = require('electron')
const { spawn } = require('node:child_process')
const path = require('path')
const { startPetServer } = require('./server.cjs')

const PORT = Number(process.env.PET_PORT || 7100)

let win = null
let assistantWin = null
let tray = null
let alwaysOnTop = true
let clickThrough = false
let dragOffset = null
let petOverviewExpanded = false
let petOverviewRestoreBounds = null
let summaryJobChild = null

// 体型档位：窗口尺寸 + 渲染缩放
const SIZES = {
  small: { w: 320, h: 200, scale: 0.4 },
  mid: { w: 380, h: 460, scale: 1.35 },
  big: { w: 520, h: 640, scale: 1.9 },
}
let currentSize = 'small'

// 皮肤与形态（渲染端 localStorage 持久化，启动时回传同步）
const SKIN_LIST = [
  { id: 'pixel', name: '小绝 · 像素猫' },
  { id: 'caishen', name: '财神到' },
  { id: 'plant', name: '小绿芽' },
  { id: 'unicorn', name: '彩虹独角兽' },
  { id: 'plane', name: '飞飞 · 小飞机' },
]
const FORM_LIST = [
  { id: 'baby', name: '幼年形态' },
  { id: 'adult', name: '成年形态' },
]
let currentSkin = 'pixel'
let currentForm = 'adult'

function setSkin(patch) {
  if (patch.skin) currentSkin = patch.skin
  if (patch.form) currentForm = patch.form
  win?.webContents.send('set-skin', { skin: currentSkin, form: currentForm })
  refreshTray()
}

/** 小绝的绝活：让 watcher 去飞书捞消息干活 */
function runJob(command, label) {
  if (summaryJobChild && summaryJobChild.exitCode === null) {
    fetch(`http://127.0.0.1:${PORT}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'error',
        label: '上一个消息总结还在进行，请稍等',
        source: 'desktop',
      }),
    }).catch(() => {})
    return
  }

  // 记录菜单操作，但不广播给可能仍在运行的常驻 watcher；本次由下方一次性进程执行。
  fetch(`http://127.0.0.1:${PORT}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feishu-Pet-Request': '1' },
    body: JSON.stringify({ command, label, source: 'menu', dispatch: false }),
  }).catch(() => {})

  const projectDir = path.join(__dirname, '..')
  const workerPath = path.join(projectDir, 'feishu', 'group-watcher.mjs')
  const child = spawn(process.execPath, [workerPath, '--job', command, '--label', label], {
    cwd: projectDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PET_URL: `http://127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  summaryJobChild = child
  child.stdout.on('data', (chunk) => console.log(`[summary] ${String(chunk).trimEnd()}`))
  child.stderr.on('data', (chunk) => console.warn(`[summary] ${String(chunk).trimEnd()}`))
  child.once('error', (err) => {
    if (summaryJobChild === child) summaryJobChild = null
    console.warn('[summary] 无法启动消息总结:', err.message)
    fetch(`http://127.0.0.1:${PORT}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'error', label: '消息总结启动失败', source: 'desktop' }),
    }).catch(() => {})
  })
  child.once('exit', (code, signal) => {
    if (summaryJobChild === child) summaryJobChild = null
    if (code && signal !== 'SIGTERM') {
      console.warn(`[summary] 消息总结进程退出，code=${code}`)
    }
  })
}

function setSize(name) {
  currentSize = name
  const s = SIZES[name]
  if (!win || !s) return
  if (petOverviewExpanded && petOverviewRestoreBounds) {
    win.setBounds(petOverviewRestoreBounds)
    petOverviewExpanded = false
    petOverviewRestoreBounds = null
  }
  win.setSize(s.w, s.h)
  win.webContents.send('set-scale', s.scale)
  refreshTray()
}

/** 悬停概览需要比宠物本体更大的透明画布；扩展时保持宠物的右下锚点不跳动。 */
function resizePetOverview(expanded) {
  if (!win || win.isDestroyed() || expanded === petOverviewExpanded) return
  if (expanded) {
    const base = win.getBounds()
    const workArea = screen.getDisplayNearestPoint({
      x: base.x + base.width - 1,
      y: base.y + base.height - 1,
    }).workArea
    const width = Math.min(base.width + 340, workArea.width)
    const height = Math.min(Math.max(base.height, 420), workArea.height)
    const right = base.x + base.width
    const bottom = base.y + base.height
    const x = Math.min(
      Math.max(right - width, workArea.x),
      workArea.x + workArea.width - width,
    )
    const y = Math.min(
      Math.max(bottom - height, workArea.y),
      workArea.y + workArea.height - height,
    )
    petOverviewRestoreBounds = base
    petOverviewExpanded = true
    win.setBounds({ x, y, width, height })
    return
  }
  const restore = petOverviewRestoreBounds
  petOverviewExpanded = false
  petOverviewRestoreBounds = null
  if (restore) win.setBounds(restore)
}

async function loadPetOverviewPath(pathname) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body.data
}

function serializeOverviewResult(result) {
  return result.status === 'fulfilled'
    ? { ok: true, data: result.value }
    : { ok: false, error: String(result.reason?.message || result.reason || '读取失败') }
}

function sendInteract(kind) {
  win?.webContents.send('interact', kind)
}

/** 鼠标穿透开关（菜单和全局快捷键共用） */
function setClickThrough(flag) {
  clickThrough = flag
  hitIgnoring = flag // 与像素级穿透的开关状态对齐，避免重复调用
  win?.setIgnoreMouseEvents(clickThrough, { forward: true })
  refreshTray()
  // 气泡提示一句，免得用户以为猫死了
  fetch(`http://localhost:${PORT}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: 'idle',
      label: clickThrough ? '穿透已开 · 按 ⌘⌥P 或托盘菜单恢复' : '穿透已关，又能摸我啦',
      source: 'system',
    }),
  }).catch(() => {})
}

/** 托盘菜单只构建一次会过期，状态变化后重建让勾选保持同步 */
function refreshTray() {
  if (tray) tray.setContextMenu(buildMenu())
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '✨ 小绝的自我介绍', click: () => win?.webContents.send('show-intro') },
    { type: 'separator' },
    { label: '摸摸头', click: () => sendInteract('pat') },
    { label: '投喂食物', click: () => sendInteract('feed') },
    { type: 'separator' },
    {
      label: '小绝的绝活',
      submenu: [
        { label: '整理今日待办事项', click: () => runJob('todo', '整理今日待办') },
        { type: 'separator' },
        { label: '总结过去 6 小时消息', click: () => runJob('summary:6', '6 小时消息总结') },
        { label: '总结过去 12 小时消息', click: () => runJob('summary:12', '12 小时消息总结') },
        { label: '总结过去 24 小时消息', click: () => runJob('summary:24', '24 小时消息总结') },
      ],
    },
    { type: 'separator' },
    {
      label: '🌈 皮肤',
      submenu: SKIN_LIST.map((s) => ({
        label: s.name,
        type: 'radio',
        checked: currentSkin === s.id,
        click: () => setSkin({ skin: s.id }),
      })),
    },
    {
      label: '形态',
      submenu: FORM_LIST.map((f) => ({
        label: f.name,
        type: 'radio',
        checked: currentForm === f.id,
        click: () => setSkin({ form: f.id }),
      })),
    },
    { type: 'separator' },
    {
      label: '体型',
      submenu: [
        {
          label: '小（不碍事）',
          type: 'radio',
          checked: currentSize === 'small',
          click: () => setSize('small'),
        },
        {
          label: '中',
          type: 'radio',
          checked: currentSize === 'mid',
          click: () => setSize('mid'),
        },
        {
          label: '大（盯着看）',
          type: 'radio',
          checked: currentSize === 'big',
          click: () => setSize('big'),
        },
      ],
    },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked
        win?.setAlwaysOnTop(alwaysOnTop, 'screen-saver')
        refreshTray()
      },
    },
    {
      label: '鼠标穿透（挂着不碍事）⌘⌥P',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => setClickThrough(item.checked),
    },
    { type: 'separator' },
    {
      label: '打开小绝助手',
      click: () => createAssistantWindow(),
    },
    {
      label: '打开调试看板',
      click: () => shell.openExternal(`http://localhost:${PORT}/`),
    },
    {
      label: '飞书工作台',
      click: () => shell.openExternal(`http://localhost:${PORT}/workbench`),
    },
    {
      label: '📒 消息归档',
      click: () => shell.openExternal(`http://localhost:${PORT}/archive`),
    },
    {
      label: '退出小绝',
      click: () => app.quit(),
    },
  ])
}

function positionAssistantWindow() {
  if (!assistantWin) return
  const petBounds = win?.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const workArea = screen.getDisplayNearestPoint(
    petBounds ? { x: petBounds.x, y: petBounds.y } : cursor,
  ).workArea
  const [width, height] = assistantWin.getSize()
  const preferredX = petBounds ? petBounds.x + petBounds.width - width : workArea.x + workArea.width - width - 24
  const preferredY = petBounds ? petBounds.y + petBounds.height - height : workArea.y + workArea.height - height - 24
  const x = Math.min(Math.max(preferredX, workArea.x + 12), workArea.x + workArea.width - width - 12)
  const y = Math.min(Math.max(preferredY, workArea.y + 12), workArea.y + workArea.height - height - 12)
  assistantWin.setPosition(Math.round(x), Math.round(y))
}

function createAssistantWindow() {
  if (assistantWin && !assistantWin.isDestroyed()) {
    positionAssistantWindow()
    assistantWin.show()
    assistantWin.focus()
    return
  }
  assistantWin = new BrowserWindow({
    width: 460,
    height: 500,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  assistantWin.setAlwaysOnTop(true, 'floating')
  assistantWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  assistantWin.setMenu(null)
  positionAssistantWindow()
  assistantWin.loadURL(`http://127.0.0.1:${PORT}/assistant`)
  assistantWin.once('ready-to-show', () => assistantWin?.show())
  assistantWin.on('closed', () => {
    assistantWin = null
  })
}

function createWindow() {
  const s = SIZES[currentSize]
  win = new BrowserWindow({
    width: s.w,
    height: s.h,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setMenu(null)
  // 初始位置：上次拖动的位置；没有则屏幕右下角
  const { workAreaSize } = screen.getPrimaryDisplay()
  const pos = loadPosition()
  const px = pos ? pos.x : workAreaSize.width - s.w - 40
  const py = pos ? pos.y : workAreaSize.height - s.h - 40
  win.setPosition(px, py)
  win.loadFile(path.join(__dirname, '..', 'dist', 'pet.html'))
  // 加载完成后同步当前体型（否则渲染端用默认缩放）
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('set-scale', SIZES[currentSize].scale)
    // 自检：PET_SKIN=caishen PET_FORM=baby 强制皮肤
    if (process.env.PET_SKIN) {
      win?.webContents.send('set-skin', {
        skin: process.env.PET_SKIN,
        form: process.env.PET_FORM || 'adult',
      })
    }
    // 自检：PET_INTRO=1 触发自我介绍气泡
    if (process.env.PET_INTRO) {
      setTimeout(() => win?.webContents.send('show-intro'), 800)
    }
  })

  // 自检截图：PET_SHOT=/path.png 时加载完成后截一张窗口图
  if (process.env.PET_SHOT) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage()
        require('fs').writeFileSync(process.env.PET_SHOT, img.toPNG())
        console.log('🐾 自检截图已保存:', process.env.PET_SHOT)
      }, Number(process.env.PET_SHOT_DELAY || 1500))
    })
  }

  win.on('closed', () => {
    win = null
  })
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
  tray = new Tray(icon.resize({ width: 22 }))
  tray.setToolTip('小绝 · 飞书干活宠物')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => {
    if (!win) return createWindow()
    win.isVisible() ? win.hide() : win.show()
  })
}

// —— 窗口位置持久化：拖过的位置重启后还在 ——
const POS_FILE = path.join(app.getPath('userData'), 'pet-position.json')
function loadPosition() {
  try {
    const p = JSON.parse(require('fs').readFileSync(POS_FILE, 'utf8'))
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
  } catch { /* 首次启动没有 */ }
  return null
}
function savePosition() {
  if (!win) return
  try {
    const [x, y] = win.getPosition()
    require('fs').writeFileSync(POS_FILE, JSON.stringify({ x, y }))
  } catch { /* 写不进就算了 */ }
}

// —— 拖拽（renderer 报告开始/移动，主进程算位置） ——
let dragSince = 0
ipcMain.on('drag-start', () => {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
  dragSince = Date.now()
})
ipcMain.on('drag-move', () => {
  if (!win || !dragOffset) return
  const cursor = screen.getCursorScreenPoint()
  // 钳制在屏幕内（至少留 60×40 可见），防止拖出屏幕找不回
  const wa = screen.getDisplayNearestPoint(cursor).workArea
  const [ww, wh] = win.getSize()
  const nx = Math.min(Math.max(cursor.x - dragOffset.x, wa.x - ww + 60), wa.x + wa.width - 60)
  const ny = Math.min(Math.max(cursor.y - dragOffset.y, wa.y), wa.y + wa.height - 40)
  win.setPosition(nx, ny)
})
ipcMain.on('drag-end', () => {
  dragOffset = null
  savePosition()
})
ipcMain.on('context-menu', () => {
  buildMenu().popup({ window: win })
})
ipcMain.on('skin-changed', (_e, v) => {
  if (v?.skin) currentSkin = v.skin
  if (v?.form) currentForm = v.form
})
ipcMain.on('open-assistant', () => createAssistantWindow())
ipcMain.on('pet-overview-resize', (_e, expanded) => resizePetOverview(Boolean(expanded)))
ipcMain.handle('pet-overview-load', async (_e, range) => {
  const start = typeof range?.start === 'string' ? range.start.slice(0, 80) : ''
  const end = typeof range?.end === 'string' ? range.end.slice(0, 80) : ''
  const [approvalResult, taskResult, calendarResult] = await Promise.allSettled([
    loadPetOverviewPath('/api/workspace/approvals'),
    loadPetOverviewPath('/api/workspace/tasks'),
    loadPetOverviewPath(
      `/api/workspace/calendar/agenda?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    ),
  ])
  return {
    approvals: serializeOverviewResult(approvalResult),
    tasks: serializeOverviewResult(taskResult),
    calendar: serializeOverviewResult(calendarResult),
  }
})
ipcMain.on('assistant-close', () => assistantWin?.close())
ipcMain.on('assistant-resize', (_e, expanded) => {
  if (!assistantWin || assistantWin.isDestroyed()) return
  assistantWin.setSize(expanded ? 520 : 460, expanded ? 760 : 500, true)
  positionAssistantWindow()
})
ipcMain.on('open-workbench', () => {
  shell.openExternal(`http://127.0.0.1:${PORT}/workbench`)
})
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
ipcMain.on('open-approval', (_e, approval) => {
  const definitionCode = approval?.definitionCode
  const instanceCode = approval?.instanceCode
  const taskId = approval?.taskId
  if (![definitionCode, instanceCode, taskId].every((value) => (
    typeof value === 'string' && APPROVAL_ID_PATTERN.test(value)
  ))) return
  const params = new URLSearchParams({
    approvalCode: definitionCode,
    instanceCode,
    taskId,
  })
  shell.openExternal(`https://applink.feishu.cn/client/approval/detail?${params}`)
})
ipcMain.on('open-workbench-approval', (_e, instanceCode) => {
  if (typeof instanceCode !== 'string' || !APPROVAL_ID_PATTERN.test(instanceCode)) return
  shell.openExternal(`http://127.0.0.1:${PORT}/workbench?approval=${encodeURIComponent(instanceCode)}`)
})

// —— 像素级点击穿透：透明区域放行鼠标，只有点在宠物本体上才吃事件 ——
// 渲染端定期上报画布的 alpha 遮罩（hit-mask），主进程轮询光标位置对照
const CANVAS_PX = 264 // PetStage 画布 22 格 × 12px
let hitMask = null // { w, h, scale, data:Uint8Array }
let hitIgnoring = false
ipcMain.on('hit-mask', (_e, m) => {
  if (m && m.w && m.h && m.data) hitMask = m
})
ipcMain.on('open-chat', (_e, chatId) => {
  if (typeof chatId === 'string' && chatId.startsWith('oc_')) {
    shell.openExternal(
      `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`,
    )
  }
})
function setHitIgnore(flag) {
  // 只在状态变化时调用，避免每 60ms 无差别 setIgnoreMouseEvents 造成窗口事件抖动
  if (flag === hitIgnoring) return
  hitIgnoring = flag
  win?.setIgnoreMouseEvents(flag, { forward: true })
}
function pollHitTest() {
  if (!win) return
  // 拖拽看门狗：renderer 的 mouseup 万一丢失，10s 后自愈，避免穿透永久失效
  if (dragOffset && Date.now() - dragSince > 10_000) dragOffset = null
  // 手动穿透模式 / 拖拽中不干预
  if (clickThrough || dragOffset) return
  if (!hitMask) {
    setHitIgnore(false)
    return
  }
  let inside = false
  const b = win.getBounds()
  const c = screen.getCursorScreenPoint()
  if (c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height) {
    const rx = c.x - b.x
    const ry = c.y - b.y
    // 消息气泡和悬停概览可点击；其余透明区域继续穿透
    const regions = Array.isArray(hitMask.regions) ? hitMask.regions : []
    const inRegion = regions.some((region) => (
      region && Number.isFinite(region.x) && Number.isFinite(region.y) &&
      Number.isFinite(region.w) && Number.isFinite(region.h) &&
      region.w > 0 && region.h > 0 &&
      rx >= region.x && rx < region.x + region.w &&
      ry >= region.y && ry < region.y + region.h
    ))
    const bb = hitMask.bubble
    if (inRegion || (bb && rx >= bb.x && rx < bb.x + bb.w && ry >= bb.y && ry < bb.y + bb.h)) {
      inside = true
    } else {
      const s = hitMask.scale || 1
      const cssSize = CANVAS_PX * s
      const left = b.width - 8 - cssSize // pet 容器 right-2 bottom-2
      const top = b.height - 8 - cssSize
      const lx = rx - left
      const ly = ry - top
      if (lx >= 0 && ly >= 0 && lx < cssSize && ly < cssSize) {
        const mx = Math.floor((lx / s) * (hitMask.w / CANVAS_PX))
        const my = Math.floor((ly / s) * (hitMask.h / CANVAS_PX))
        inside = !!hitMask.data[my * hitMask.w + mx]
      }
    }
  }
  setHitIgnore(!inside)
}
setInterval(pollHitTest, 60)

app.whenReady().then(() => {
  app.dock?.hide() // 桌面宠物：不占 Dock
  startPetServer({
    port: PORT,
    distDir: path.join(__dirname, '..', 'dist'),
    onError: (_err, message) => {
      dialog.showErrorBox('小绝启动失败', message)
      app.quit()
    },
  })
  createWindow()
  createTray()

  // 全局快捷键：⌘⌥P 切换鼠标穿透（穿透开了之后的逃生通道）
  globalShortcut.register('CommandOrControl+Alt+P', () => {
    setClickThrough(!clickThrough)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 单实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => win?.show())
}

app.on('window-all-closed', () => {
  // 宠物常驻：窗口全关也不退出，靠托盘菜单退出
})

app.on('will-quit', () => {
  if (summaryJobChild && summaryJobChild.exitCode === null) summaryJobChild.kill('SIGTERM')
  globalShortcut.unregisterAll()
})
