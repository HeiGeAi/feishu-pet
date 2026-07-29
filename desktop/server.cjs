/**
 * 小绝桌面宠物 · 内嵌事件服务器（零依赖，Node 原生 http）
 *
 *  - POST /api/event     飞书 bot 上报状态（六档）
 *  - POST /api/interact  互动（pat 摸头 / feed 投喂）
 *  - GET  /api/events    SSE 实时推送（宠物窗口 + 调试看板共用）
 *  - GET  /api/state     当前状态兜底轮询
 *  - GET  /api/archive   消息/汇报/指令归档（持久化在 ~/.xiaojue-pet/archive.json）
 *  - GET  /archive       归档二级页面（SPA 入口）
 *  - GET  /*             调试看板静态文件（dist/），不依赖 Vite
 *
 * 额外行为：10 分钟没有任何事件 → 自动进入 sleeping（摸鱼）。
 */
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  CONFIG_PATH,
  loadLlmConfig,
  saveLlmConfig,
  maskKey,
  llmChat,
  evaluateApprovalCached,
  planWorkspaceInstruction,
} = require('../feishu/llm-client.cjs')
const workspace = require('../feishu/workspace-client.cjs')

const VALID_STATES = new Set([
  'idle',
  'thinking',
  'working',
  'success',
  'error',
  'sleeping',
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

// —— 归档存储：消息提醒 / 绝活汇报 / 干活指令，持久化到本地，归档页随时回看 ——
const ARCHIVE_PATH = path.join(os.homedir(), '.xiaojue-pet', 'archive.json')
const ARCHIVE_MAX = 800

function readJsonBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        reject(
          new workspace.WorkspaceError('请求内容过大', {
            code: 'BODY_TOO_LARGE',
            status: 413,
          }),
        )
        req.resume()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (settled) return
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        reject(
          new workspace.WorkspaceError('请求 JSON 格式不正确', {
            code: 'INVALID_JSON',
            status: 400,
          }),
        )
      }
    })
    req.on('error', reject)
  })
}

function cleanPlanString(value, max = 3000) {
  if (value === undefined || value === null) return undefined
  return String(value).trim().slice(0, max)
}

function cleanPlanInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '' || value === false) return undefined
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new workspace.WorkspaceError(`${name}格式不正确`, {
      code: 'INVALID_PLAN',
      status: 422,
    })
  }
  return number
}

function cleanPlanBoolean(value, name, { defaultValue } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(?:true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === 'true'
  }
  throw new workspace.WorkspaceError(`${name}格式不正确`, {
    code: 'INVALID_PLAN',
    status: 422,
  })
}

function planIdempotencyKey(value, kind) {
  const key = cleanPlanString(value, 100)
  return key && /^pet-plan-[a-z]+-[0-9a-f-]{36}$/i.test(key)
    ? key
    : `pet-plan-${kind}-${crypto.randomUUID()}`
}

const PLAN_ACTIONS = new Set([
  'task.create',
  'task.update',
  'task.complete',
  'approval.approve',
  'approval.reject',
  'calendar.create',
  'calendar.update',
  'calendar.suggest',
  'clarify',
])

function sanitizeAssistantPlan(raw) {
  const action = String(raw?.action || '')
  if (!PLAN_ACTIONS.has(action)) {
    throw new workspace.WorkspaceError('大模型返回了不支持的操作', {
      code: 'INVALID_PLAN',
      status: 422,
    })
  }
  const source = raw?.arguments && typeof raw.arguments === 'object' ? raw.arguments : {}
  let args
  switch (action) {
    case 'task.create':
      {
      const reminderMinutes = cleanPlanInteger(source.reminderMinutes, '任务提醒时间', {
        max: 525_600,
      })
      args = {
        summary: cleanPlanString(source.summary),
        description: cleanPlanString(source.description),
        due: cleanPlanString(source.due, 80),
        assignee: cleanPlanString(source.assignee, 100),
        idempotencyKey: planIdempotencyKey(source.idempotencyKey, 'task'),
        ...(reminderMinutes !== undefined
          ? { reminderMinutes }
          : {}),
      }
      break
      }
    case 'task.update':
      args = {
        taskGuid: cleanPlanString(source.taskGuid, 100),
        ...(source.summary !== undefined ? { summary: cleanPlanString(source.summary) } : {}),
        ...(source.description !== undefined
          ? { description: cleanPlanString(source.description) }
          : {}),
        ...(source.due !== undefined ? { due: cleanPlanString(source.due, 80) } : {}),
      }
      break
    case 'task.complete':
      args = { taskGuid: cleanPlanString(source.taskGuid, 100) }
      break
    case 'approval.approve':
    case 'approval.reject':
      args = {
        instanceCode: cleanPlanString(source.instanceCode, 200),
        taskId: cleanPlanString(source.taskId, 200),
        comment: cleanPlanString(source.comment, 1000),
      }
      break
    case 'calendar.create':
      {
      const reminderMinutes = cleanPlanInteger(source.reminderMinutes, '日程提醒时间', {
        max: 20_160,
      })
      const summary = cleanPlanString(source.summary, 1000)
      const start = cleanPlanString(source.start, 80)
      const end = cleanPlanString(source.end, 80)
      if (!summary || !start || !end) {
        throw new workspace.WorkspaceError('创建日程需要标题、开始时间和结束时间', {
          code: 'INVALID_PLAN',
          status: 422,
        })
      }
      args = {
        summary,
        start,
        end,
        description: cleanPlanString(source.description, 5000),
        location: cleanPlanString(source.location, 500),
        meeting: cleanPlanBoolean(source.meeting, '是否视频会议', { defaultValue: false }),
        reminderMinutes: reminderMinutes ?? 5,
        idempotencyKey: planIdempotencyKey(source.idempotencyKey, 'calendar'),
        attendees: Array.isArray(source.attendees)
          ? source.attendees.map((id) => cleanPlanString(id, 100)).filter(Boolean).slice(0, 100)
          : [],
      }
      break
      }
    case 'calendar.update':
      {
      const reminderMinutes = cleanPlanInteger(source.reminderMinutes, '日程提醒时间', {
        max: 20_160,
      })
      const hasStart = source.start !== undefined
      const hasEnd = source.end !== undefined
      if (hasStart !== hasEnd) {
        throw new workspace.WorkspaceError('修改日程时间时必须同时提供开始和结束时间', {
          code: 'INVALID_PLAN',
          status: 422,
        })
      }
      args = {
        eventId: cleanPlanString(source.eventId, 300),
        ...(source.summary !== undefined ? { summary: cleanPlanString(source.summary, 1000) } : {}),
        ...(hasStart ? { start: cleanPlanString(source.start, 80) } : {}),
        ...(hasEnd ? { end: cleanPlanString(source.end, 80) } : {}),
        ...(source.description !== undefined
          ? { description: cleanPlanString(source.description, 5000) }
          : {}),
        ...(source.location !== undefined
          ? { location: cleanPlanString(source.location, 500) }
          : {}),
        ...(source.meeting !== undefined
          ? { meeting: cleanPlanBoolean(source.meeting, '是否视频会议') }
          : {}),
        ...(reminderMinutes !== undefined
          ? { reminderMinutes }
          : {}),
      }
      break
      }
    case 'calendar.suggest':
      args = {
        start: cleanPlanString(source.start, 80),
        end: cleanPlanString(source.end, 80),
        durationMinutes: Number(source.durationMinutes || 30),
        attendees: Array.isArray(source.attendees)
          ? source.attendees.map((id) => cleanPlanString(id, 100)).filter(Boolean).slice(0, 100)
          : [],
      }
      break
    default:
      args = { question: cleanPlanString(source.question, 500) || '请补充更明确的信息。' }
  }
  return {
    action,
    arguments: args,
    preview: cleanPlanString(raw.preview, 500) || action,
    requiresConfirmation: !['clarify', 'calendar.suggest'].includes(action),
  }
}

async function executeAssistantPlan(plan) {
  const args = plan.arguments
  switch (plan.action) {
    case 'task.create':
      return workspace.createTask(args)
    case 'task.update':
      return workspace.updateTask(args.taskGuid, args)
    case 'task.complete':
      return workspace.completeTask(args.taskGuid)
    case 'approval.approve':
    case 'approval.reject':
      return workspace.decideApproval({
        instanceCode: args.instanceCode,
        taskId: args.taskId,
        action: plan.action === 'approval.approve' ? 'approve' : 'reject',
        comment: args.comment,
      })
    case 'calendar.create':
      return workspace.createCalendarEvent(args)
    case 'calendar.update':
      return workspace.updateCalendarEvent(args.eventId, args)
    case 'calendar.suggest':
      return workspace.suggestCalendarTime(args)
    default:
      throw new workspace.WorkspaceError('这条指令需要补充信息，不能执行', {
        code: 'CLARIFICATION_REQUIRED',
        status: 422,
      })
  }
}

async function handleWorkspaceRoute(req, res, url, json) {
  const parsedUrl = new URL(req.url || '/', 'http://localhost')
  const approvalMatch = url.match(/^\/api\/workspace\/approvals\/([^/]+)$/)
  const approvalDecisionMatch = url.match(
    /^\/api\/workspace\/approvals\/([^/]+)\/decision$/,
  )
  const taskMatch = url.match(/^\/api\/workspace\/tasks\/([^/]+)$/)
  const taskCompleteMatch = url.match(/^\/api\/workspace\/tasks\/([^/]+)\/complete$/)
  const eventMatch = url.match(/^\/api\/workspace\/calendar\/events\/([^/]+)$/)

  if (url === '/api/workspace/status' && req.method === 'GET') {
    json(res, { ok: true, status: await workspace.getWorkspaceStatus() })
    return
  }
  if (url === '/api/workspace/approvals' && req.method === 'GET') {
    json(res, { ok: true, data: await workspace.listApprovals() })
    return
  }
  if (approvalMatch && req.method === 'GET') {
    json(res, { ok: true, data: await workspace.getApproval(decodeURIComponent(approvalMatch[1])) })
    return
  }
  if (url === '/api/workspace/approvals/evaluate' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const detail = await workspace.getApproval(body.instanceCode)
    const result = await evaluateApprovalCached(body.instanceCode, detail, {
      force: body.force === true,
    })
    json(res, { ok: true, ...result })
    return
  }
  if (approvalDecisionMatch && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (body.confirmed !== true) {
      throw new workspace.WorkspaceError('提交审批决定前需要二次确认', {
        code: 'CONFIRMATION_REQUIRED',
        status: 409,
      })
    }
    json(res, {
      ok: true,
      data: await workspace.decideApproval({
        instanceCode: decodeURIComponent(approvalDecisionMatch[1]),
        taskId: body.taskId,
        action: body.action,
        comment: body.comment,
      }),
    })
    return
  }
  if (url === '/api/workspace/tasks' && req.method === 'GET') {
    json(res, { ok: true, data: await workspace.listTasks() })
    return
  }
  if (url === '/api/workspace/tasks' && req.method === 'POST') {
    const body = await readJsonBody(req)
    json(res, { ok: true, data: await workspace.createTask(body) }, 201)
    return
  }
  if (taskCompleteMatch && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (body.confirmed !== true) {
      throw new workspace.WorkspaceError('完成任务前需要确认', {
        code: 'CONFIRMATION_REQUIRED',
        status: 409,
      })
    }
    json(res, {
      ok: true,
      data: await workspace.completeTask(decodeURIComponent(taskCompleteMatch[1])),
    })
    return
  }
  if (taskMatch && req.method === 'PATCH') {
    const body = await readJsonBody(req)
    json(res, {
      ok: true,
      data: await workspace.updateTask(decodeURIComponent(taskMatch[1]), body),
    })
    return
  }
  if (url === '/api/workspace/calendar/agenda' && req.method === 'GET') {
    json(res, {
      ok: true,
      data: await workspace.listAgenda({
        start: parsedUrl.searchParams.get('start') || '',
        end: parsedUrl.searchParams.get('end') || '',
      }),
    })
    return
  }
  if (url === '/api/workspace/calendar/events' && req.method === 'POST') {
    const body = await readJsonBody(req)
    json(res, { ok: true, data: await workspace.createCalendarEvent(body) }, 201)
    return
  }
  if (eventMatch && req.method === 'PATCH') {
    const body = await readJsonBody(req)
    json(res, {
      ok: true,
      data: await workspace.updateCalendarEvent(decodeURIComponent(eventMatch[1]), body),
    })
    return
  }
  if (url === '/api/workspace/assistant/plan' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const rawPlan = await planWorkspaceInstruction(body.instruction, body.context || {})
    json(res, { ok: true, plan: sanitizeAssistantPlan(rawPlan) })
    return
  }
  if (url === '/api/workspace/assistant/execute' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const plan = sanitizeAssistantPlan(body.plan)
    if (plan.requiresConfirmation && body.confirmed !== true) {
      throw new workspace.WorkspaceError('执行写操作前需要确认预览', {
        code: 'CONFIRMATION_REQUIRED',
        status: 409,
      })
    }
    json(res, { ok: true, data: await executeAssistantPlan(plan), plan })
    return
  }
  json(res, { ok: false, error: 'workspace route not found' }, 404)
}

function loadArchive() {
  try {
    const list = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'))
    if (Array.isArray(list)) return list.slice(-ARCHIVE_MAX)
  } catch {
    /* 首次没有 */
  }
  return []
}

function makeArchiveStore() {
  const items = loadArchive()
  let dirty = false
  const timer = setInterval(() => {
    if (!dirty) return
    dirty = false
    try {
      fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true })
      fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(items))
    } catch {
      /* 写不进就算了 */
    }
  }, 3000)
  timer.unref?.()
  return {
    items,
    add(entry) {
      items.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, ...entry })
      if (items.length > ARCHIVE_MAX) items.splice(0, items.length - ARCHIVE_MAX)
      dirty = true
    },
  }
}

function startPetServer({ port = 7100, host = '127.0.0.1', distDir, onEvent, onError } = {}) {
  const clients = new Set()
  const archive = makeArchiveStore()
  let last = {
    state: 'idle',
    label: '待机中 · 等飞书 bot 召唤',
    ts: Date.now(),
    source: 'system',
  }
  const log = [last]
  let lastReport = null
  let lastCommand = null // 最近一条绝活指令，SSE 重连时随 init 补投，防启动竞态丢指令

  const broadcast = (payload) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of clients) {
      try {
        res.write(data)
      } catch {
        clients.delete(res)
      }
    }
  }

  const pushEvent = (ev) => {
    last = ev
    log.push(ev)
    if (log.length > 200) log.shift()
    // 归档有价值的动态（跳过自动休眠/状态回落这类噪音）
    if (!['auto', 'system'].includes(ev.source)) {
      archive.add({
        kind: 'message',
        ts: ev.ts,
        state: ev.state,
        label: ev.label,
        source: ev.source,
        ...(ev.chatId ? { chatId: ev.chatId } : {}),
      })
    }
    broadcast({ type: 'event', event: ev })
    onEvent?.(ev)
  }

  // 桌面宠物式：10 分钟没活干自动睡着
  const autoSleep = setInterval(() => {
    if (last.state !== 'sleeping' && Date.now() - last.ts > 10 * 60 * 1000) {
      pushEvent({
        state: 'sleeping',
        label: '10 分钟没活干，先眯一会',
        ts: Date.now(),
        source: 'auto',
      })
    }
  }, 30 * 1000)
  autoSleep.unref?.()

  const json = (res, obj, code = 200) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(obj))
  }

  const trustedLocalOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])

  // 宠物窗口经 file:// 加载，Chromium 把它的 Origin 序列化成字符串 "null"
  const isLocalPageOrigin = (origin) => !origin || origin === 'null' || trustedLocalOrigins.has(origin)

  const validateLocalApiRequest = (req) => {
    const origin = String(req.headers.origin || '')
    if (origin && !trustedLocalOrigins.has(origin)) {
      throw new workspace.WorkspaceError('本地 API 拒绝了非本机页面请求', {
        code: 'UNTRUSTED_ORIGIN',
        status: 403,
      })
    }
    if (['POST', 'PATCH'].includes(req.method || '')) {
      const contentType = String(req.headers['content-type'] || '')
      if (!/^application\/json(?:;|$)/i.test(contentType)) {
        throw new workspace.WorkspaceError('本地 API 写请求必须使用 JSON', {
          code: 'INVALID_CONTENT_TYPE',
          status: 415,
        })
      }
      if (req.headers['x-feishu-pet-request'] !== '1') {
        throw new workspace.WorkspaceError('本地 API 写请求缺少本地客户端标识', {
          code: 'INVALID_CLIENT_REQUEST',
          status: 403,
        })
      }
    }
    return origin
  }

  const server = http.createServer((req, res) => {
    let url = req.url?.split('?')[0] || '/'
    try {
      url = decodeURIComponent(url)
    } catch {
      /* 保持原样 */
    }

    const isWorkspaceApi = url.startsWith('/api/workspace/')
    // 汇报全文与干活指令只接受本机页面/本机进程写入；/api/event 与 /api/interact 保持开放（对外埋点协议）
    const isLlmSettingsApi = url === '/api/llm-config' || url === '/api/llm-test' ||
      url === '/api/report' || url === '/api/command'
    if (isWorkspaceApi || isLlmSettingsApi) {
      let localOrigin = ''
      try {
        localOrigin = validateLocalApiRequest(req)
      } catch (err) {
        json(res, {
          ok: false,
          error: String(err?.message || err),
          code: err?.code || 'WORKSPACE_REQUEST_REJECTED',
        }, Number(err?.status) || 403)
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(localOrigin ? { 'Access-Control-Allow-Origin': localOrigin } : {}),
          Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Feishu-Pet-Request',
        })
        res.end()
        return
      }
      if (isWorkspaceApi) {
        handleWorkspaceRoute(req, res, url, json).catch((err) => {
          const status = Number(err?.status) || 500
          console.warn(`[workspace] ${req.method} ${url}: ${err?.message || err}`)
          json(
            res,
            {
              ok: false,
              error: String(err?.message || err || '工作台请求失败'),
              code: err?.code || 'WORKSPACE_ERROR',
              hint: err?.hint || '',
              ...(err?.details ? { details: err.details } : {}),
            },
            status,
          )
        })
        return
      }
    }

    if (url === '/api/events' && req.method === 'GET') {
      // SSE 流里有消息气泡、汇报全文和指令，不能对任意网页开放读取
      const origin = String(req.headers.origin || '')
      if (!isLocalPageOrigin(origin)) {
        json(res, { ok: false, error: '事件流只对本机页面开放' }, 403)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      })
      res.write(
        `data: ${JSON.stringify({ type: 'init', last, log: log.slice(-30), lastReport, lastCommand })}\n\n`,
      )
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (url === '/api/state' && req.method === 'GET') {
      json(res, { last, log: log.slice(-30), lastReport })
      return
    }

    // 归档查询：?type=all|message|report|command&q=关键词&limit=N，新的在前
    if (url === '/api/archive' && req.method === 'GET') {
      const query = new URL(req.url, 'http://x').searchParams
      const type = query.get('type') || 'all'
      const q = (query.get('q') || '').trim().toLowerCase()
      const limit = Math.min(Number(query.get('limit') || 200), ARCHIVE_MAX)
      let items = archive.items
      if (type !== 'all') items = items.filter((it) => it.kind === type)
      if (q) {
        items = items.filter((it) =>
          `${it.label || ''} ${it.text || ''} ${it.trigger || ''} ${it.source || ''}`
            .toLowerCase()
            .includes(q),
        )
      }
      json(res, { ok: true, total: items.length, items: items.slice(-limit).reverse() })
      return
    }

    if (
      (url === '/api/event' || url === '/api/interact') &&
      req.method === 'OPTIONS'
    ) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    if (url === '/api/event' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          if (!VALID_STATES.has(parsed.state)) {
            json(res, {
              ok: false,
              error: `state 必须是 ${[...VALID_STATES].join('/')}`,
            })
            return
          }
          const ev = {
            state: parsed.state,
            label: String(parsed.label ?? '').slice(0, 60),
            ts: Date.now(),
            source: String(parsed.source ?? 'api').slice(0, 30),
          }
          // 可选：飞书会话 id，气泡点击可跳转到对应聊天
          if (parsed.chatId) ev.chatId = String(parsed.chatId).slice(0, 40)
          pushEvent(ev)
          json(res, { ok: true, event: ev })
        } catch {
          json(res, { ok: false, error: 'invalid JSON' })
        }
      })
      return
    }

    if (url === '/api/interact' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const kind = parsed.kind === 'feed' ? 'feed' : 'pat'
          const interact = {
            kind,
            label: String(parsed.label ?? '').slice(0, 40),
            ts: Date.now(),
            source: String(parsed.source ?? 'api').slice(0, 30),
          }
          broadcast({ type: 'interact', interact })
          json(res, { ok: true, interact })
        } catch {
          json(res, { ok: false, error: 'invalid JSON' })
        }
      })
      return
    }

    // 群汇报卡片：watcher 的 LLM 总结全文
    if (url === '/api/report' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const report = {
            text: String(parsed.text ?? '').slice(0, 1200),
            trigger: String(parsed.trigger ?? '').slice(0, 40),
            ts: Date.now(),
            source: String(parsed.source ?? 'api').slice(0, 30),
          }
          lastReport = report
          archive.add({
            kind: 'report',
            ts: report.ts,
            trigger: report.trigger,
            text: report.text,
            source: report.source,
          })
          broadcast({ type: 'report', report })
          json(res, { ok: true, report })
        } catch {
          json(res, { ok: false, error: 'invalid JSON' })
        }
      })
      return
    }

    // 小绝的绝活：菜单下发干活指令（watcher 监听执行）
    if (url === '/api/command' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const cmd = {
            command: String(parsed.command ?? '').slice(0, 30),
            label: String(parsed.label ?? '').slice(0, 40),
            ts: Date.now(),
            source: String(parsed.source ?? 'api').slice(0, 30),
          }
          archive.add({
            kind: 'command',
            ts: cmd.ts,
            command: cmd.command,
            label: cmd.label,
            source: cmd.source,
          })
          if (parsed.dispatch !== false) {
            lastCommand = cmd
            broadcast({ type: 'command', command: cmd })
          }
          json(res, { ok: true, command: cmd })
        } catch {
          json(res, { ok: false, error: 'invalid JSON' })
        }
      })
      return
    }

    // —— 大模型设置：读配置（key 脱敏）——
    if (url === '/api/llm-config' && req.method === 'GET') {
      const cfg = loadLlmConfig()
      json(res, {
        ok: true,
        config: {
          provider: cfg.provider,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          hasKey: Boolean(cfg.apiKey),
          apiKeyMasked: maskKey(cfg.apiKey),
        },
        configPath: CONFIG_PATH,
      })
      return
    }

    // —— 大模型设置：保存 ——
    if (url === '/api/llm-config' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const next = saveLlmConfig({
            provider: parsed.provider,
            baseUrl: String(parsed.baseUrl ?? '').trim(),
            model: String(parsed.model ?? '').trim(),
            apiKey: String(parsed.apiKey ?? '').trim(),
          })
          json(res, {
            ok: true,
            config: {
              provider: next.provider,
              baseUrl: next.baseUrl,
              model: next.model,
              hasKey: Boolean(next.apiKey),
              apiKeyMasked: maskKey(next.apiKey),
            },
          })
        } catch (err) {
          json(res, { ok: false, error: String(err.message || err) })
        }
      })
      return
    }

    // —— 大模型设置：连接测试（用当前已保存的配置）——
    if (url === '/api/llm-test' && req.method === 'POST') {
      llmChat('用一句不超过 20 字的话介绍你自己。', { timeoutMs: 60_000 })
        .then((text) => json(res, { ok: true, text: text.slice(0, 120) }))
        .catch((err) => json(res, { ok: false, error: String(err.message || err) }))
      return
    }

    // 静态文件（调试看板）；二级页面走 SPA 入口
    if (req.method === 'GET' && distDir) {
      const rel = ['/', '/archive', '/workbench', '/assistant'].includes(url) ? '/index.html' : url
      const file = path.normalize(path.join(distDir, rel))
      if (file.startsWith(path.normalize(distDir) + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        })
        fs.createReadStream(file).pipe(res)
        return
      }
    }

    json(res, { ok: false, error: 'not found' }, 404)
  })

  // SSE 保活
  const keepAlive = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, 25000)
  keepAlive.unref?.()

  server.on('error', (err) => {
    const message = err?.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用（可能已有一只小绝在跑，或其他程序占了端口）。可用 PET_PORT 换端口。`
      : `事件服务器启动失败：${err?.message || err}`
    console.error(`🐾 ${message}`)
    if (onError) onError(err, message)
    else process.exit(1)
  })
  server.listen(port, host, () => {
    console.log(`🐾 小绝事件服务器: http://localhost:${port}`)
  })
  return server
}

module.exports = { startPetServer }

// 也可以独立跑：node desktop/server.cjs（配合任何静态看板/调试）
if (require.main === module) {
  startPetServer({
    port: Number(process.env.PET_PORT || 7100),
    host: process.env.PET_HOST || '127.0.0.1',
    distDir: path.join(__dirname, '..', 'dist'),
  })
}
