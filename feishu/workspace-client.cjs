/**
 * 飞书工作台 CLI 适配层。
 * 所有个人资源都固定使用 user 身份，参数通过 argv 传递，不经过 shell。
 */
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const LARK = process.env.LARK_CLI || 'lark-cli'
const TIMEZONE = 'Asia/Shanghai'
const LARK_ENV = {
  ...process.env,
  PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
}

const REQUIRED_SCOPES = {
  approval: ['approval:task:read', 'approval:instance:read', 'approval:task:write'],
  task: ['task:task:read', 'task:task:write'],
  calendar: [
    'calendar:calendar.event:read',
    'calendar:calendar.event:create',
    'calendar:calendar.event:update',
  ],
}
// Optional calendar capabilities must not prevent the rest of the workspace from becoming ready.
const OPTIONAL_SCOPES = {
  calendar: ['calendar:calendar.free_busy:read'],
}
// The user API accepts `primary`; lark-cli 1.0.53's `<primary>` expansion is rejected with 191001.
const PRIMARY_CALENDAR_ID = 'primary'

class WorkspaceError extends Error {
  constructor(message, { code = 'WORKSPACE_ERROR', status = 500, hint = '', details = null } = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.status = status
    this.hint = hint
    this.details = details
  }
}

function parseJson(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((n) => n >= 0)
    const start = starts.length ? Math.min(...starts) : -1
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
    throw new WorkspaceError('飞书 CLI 返回了无法解析的数据', {
      code: 'INVALID_CLI_RESPONSE',
      status: 502,
    })
  }
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && payload.code === 0 && payload.data) {
    return payload.data
  }
  return payload?.data && Object.keys(payload).every((key) => ['data', '_notice'].includes(key))
    ? payload.data
    : payload
}

function normalizeCliError(err) {
  const raw = `${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`.trim()
  let envelope = null
  for (const candidate of [err?.stderr, err?.stdout]) {
    try {
      envelope = parseJson(candidate)
      if (envelope?.error) break
    } catch {
      /* 非 JSON 错误 */
    }
  }
  const message = String(envelope?.error?.message || envelope?.msg || raw || '飞书 CLI 调用失败')
  const hint = String(envelope?.error?.hint || envelope?.hint || '')
  const lowered = `${message} ${hint} ${raw}`.toLowerCase()

  if (err?.code === 'ENOENT' || lowered.includes('not found')) {
    return new WorkspaceError('未找到 lark-cli，请先安装飞书 CLI', {
      code: 'CLI_NOT_FOUND',
      status: 503,
      hint: '安装并完成 lark-cli config init 后重试',
    })
  }
  if (
    lowered.includes('refresh token expired') ||
    lowered.includes('user identity: missing') ||
    lowered.includes('not logged') ||
    lowered.includes('no user credential') ||
    lowered.includes('user_access_token') && lowered.includes('invalid')
  ) {
    return new WorkspaceError('飞书用户授权已失效或尚未登录', {
      code: 'AUTH_REQUIRED',
      status: 401,
      hint: '请在终端运行工作台显示的最小权限授权命令',
    })
  }
  if (
    lowered.includes('permission') ||
    lowered.includes('scope') ||
    lowered.includes('forbidden') ||
    lowered.includes('99991672')
  ) {
    return new WorkspaceError('飞书应用或当前用户缺少所需权限', {
      code: 'PERMISSION_REQUIRED',
      status: 403,
      hint: hint || '请在飞书开放平台开通对应 scope，并重新进行用户授权',
      details: envelope?.error?.permission_violations || null,
    })
  }
  if (lowered.includes('auth login')) {
    return new WorkspaceError('飞书用户授权已失效或尚未登录', {
      code: 'AUTH_REQUIRED',
      status: 401,
      hint: hint || '请在终端运行工作台显示的授权命令',
    })
  }
  if (err?.killed || lowered.includes('timed out') || lowered.includes('timeout')) {
    return new WorkspaceError('飞书 CLI 响应超时', { code: 'CLI_TIMEOUT', status: 504 })
  }
  return new WorkspaceError(message.slice(0, 500), {
    code: envelope?.error?.type || 'CLI_ERROR',
    status: 502,
    hint,
  })
}

async function runLark(args, { timeoutMs = 30_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(LARK, args, {
      env: LARK_ENV,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })
    return unwrap(parseJson(stdout))
  } catch (err) {
    throw normalizeCliError(err)
  }
}

function cleanString(value, name, { required = false, max = 3000 } = {}) {
  const text = String(value ?? '').trim()
  if (required && !text) {
    throw new WorkspaceError(`${name}不能为空`, { code: 'INVALID_INPUT', status: 400 })
  }
  if (text.length > max) {
    throw new WorkspaceError(`${name}不能超过 ${max} 个字符`, {
      code: 'INVALID_INPUT',
      status: 400,
    })
  }
  return text
}

function cleanTaskId(value) {
  const id = cleanString(value, '任务 ID', { required: true, max: 100 })
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) {
    throw new WorkspaceError('任务 ID 必须是飞书任务 GUID', {
      code: 'INVALID_TASK_ID',
      status: 400,
    })
  }
  return id
}

function cleanEventId(value) {
  const id = cleanString(value, '日程 ID', { required: true, max: 300 })
  if (!/^[\w@.:-]+$/i.test(id)) {
    throw new WorkspaceError('日程 ID 格式不正确', { code: 'INVALID_EVENT_ID', status: 400 })
  }
  return id
}

function cleanDate(value, name, { required = false } = {}) {
  const text = cleanString(value, name, { required, max: 80 })
  if (text && Number.isNaN(Date.parse(text))) {
    throw new WorkspaceError(`${name}不是有效时间`, { code: 'INVALID_DATE', status: 400 })
  }
  return text
}

function cliArgs(base, flags = {}) {
  const args = [...base]
  for (const [flag, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === '') continue
    if (value === true) args.push(`--${flag}`)
    else if (value === false || value === 'false') args.push(`--${flag}=false`)
    else args.push(`--${flag}`, String(value))
  }
  args.push('--as', 'user', '--format', 'json')
  return args
}

async function getCurrentUserOpenId() {
  let auth
  try {
    const { stdout } = await execFileAsync(LARK, ['auth', 'status', '--json'], {
      env: LARK_ENV,
      timeout: 5000,
      windowsHide: true,
    })
    auth = parseJson(stdout)
  } catch (err) {
    throw normalizeCliError(err)
  }
  const openId = String(auth?.identities?.user?.openId || '')
  if (!/^ou_[A-Za-z0-9]+$/.test(openId)) {
    throw new WorkspaceError('无法读取当前飞书用户 ID', {
      code: 'AUTH_REQUIRED',
      status: 401,
      hint: '请重新执行飞书用户授权后重试',
    })
  }
  return openId
}

function findTaskItems(payload, depth = 0) {
  if (depth > 8 || !payload || typeof payload !== 'object') return []
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === 'object')
  for (const key of ['items', 'tasks', 'task_list']) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  for (const key of ['data', 'result', 'page']) {
    const found = findTaskItems(payload[key], depth + 1)
    if (found.length) return found
  }
  return []
}

async function getWorkspaceStatus() {
  let version = ''
  let auth = null
  let scopeCheck = null
  try {
    const { stdout } = await execFileAsync(LARK, ['--version'], {
      env: LARK_ENV,
      timeout: 5000,
      windowsHide: true,
    })
    version = String(stdout).trim().replace(/^(?:lark-cli\s*)?version\s*/i, '')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        cliInstalled: false,
        userAvailable: false,
        requiredScopes: REQUIRED_SCOPES,
        optionalScopes: OPTIONAL_SCOPES,
      }
    }
  }
  try {
    const { stdout } = await execFileAsync(LARK, ['auth', 'status', '--json'], {
      env: LARK_ENV,
      timeout: 5000,
      windowsHide: true,
    })
    auth = parseJson(stdout)
  } catch {
    /* 列表接口会返回更具体的认证错误 */
  }
  const user = auth?.identities?.user || {}
  const userAvailable = Boolean(user.available)
  const requiredScopeList = Object.values(REQUIRED_SCOPES).flat()
  const optionalScopeList = Object.values(OPTIONAL_SCOPES).flat()
  const allScopes = [...requiredScopeList, ...optionalScopeList]
  if (userAvailable) {
    try {
      const { stdout } = await execFileAsync(
        LARK,
        ['auth', 'check', '--scope', allScopes.join(' '), '--json'],
        { env: LARK_ENV, timeout: 5000, windowsHide: true },
      )
      scopeCheck = parseJson(stdout)
    } catch (err) {
      try {
        scopeCheck = parseJson(err?.stdout || err?.stderr)
      } catch {
        /* 不让 scope 检测影响状态页 */
      }
    }
  }
  const missingScopes = Array.isArray(scopeCheck?.missing) ? scopeCheck.missing : []
  const missingRequiredScopes = missingScopes.filter((scope) => requiredScopeList.includes(scope))
  const missingOptionalScopes = missingScopes.filter((scope) => optionalScopeList.includes(scope))
  const ready = userAvailable && missingRequiredScopes.length === 0
  return {
    cliInstalled: true,
    version,
    userAvailable,
    ready,
    tokenStatus: String(user.tokenStatus || user.status || 'unknown'),
    authMessage: String(user.message || ''),
    requiredScopes: REQUIRED_SCOPES,
    optionalScopes: OPTIONAL_SCOPES,
    missingScopes: missingRequiredScopes,
    missingOptionalScopes,
    loginCommand: missingRequiredScopes.length
      ? `lark-cli auth login --scope "${missingRequiredScopes.join(' ')}"`
      : missingOptionalScopes.length
        ? `lark-cli auth login --scope "${missingOptionalScopes.join(' ')}"`
      : `lark-cli auth login --scope "${allScopes.join(' ')}"`,
  }
}

async function listApprovals() {
  return runLark(
    cliArgs(['approval', 'tasks', 'query'], {
      params: JSON.stringify({ topic: '1', locale: 'zh-CN', page_size: 50 }),
      'page-all': true,
    }),
  )
}

async function getApproval(instanceCode) {
  const code = cleanString(instanceCode, '审批实例 Code', { required: true, max: 200 })
  return runLark(
    cliArgs(['approval', 'instances', 'get'], {
      params: JSON.stringify({ instance_code: code, locale: 'zh-CN', user_id_type: 'open_id' }),
    }),
  )
}

async function decideApproval({ instanceCode, taskId, action, comment }) {
  const instance = cleanString(instanceCode, '审批实例 Code', { required: true, max: 200 })
  const task = cleanString(taskId, '审批任务 ID', { required: true, max: 200 })
  const reason = cleanString(comment, '审批意见', { max: 1000 })
  if (!['approve', 'reject'].includes(action)) {
    throw new WorkspaceError('审批动作必须是 approve 或 reject', {
      code: 'INVALID_APPROVAL_ACTION',
      status: 400,
    })
  }
  return runLark(
    cliArgs(['approval', 'tasks', action], {
      data: JSON.stringify({
        instance_code: instance,
        task_id: task,
        ...(reason ? { comment: reason } : {}),
      }),
      yes: true,
    }),
  )
}

async function listTasks() {
  const currentUserOpenId = await getCurrentUserOpenId()
  const [assignedResult, createdResult] = await Promise.allSettled([
    runLark(cliArgs(['task', '+get-my-tasks'], { complete: 'false', 'page-all': true })),
    runLark(cliArgs(['task', '+search'], {
      creator: currentUserOpenId,
      completed: 'false',
      'page-all': true,
    })),
  ])
  const successfulResults = [assignedResult, createdResult]
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  if (!successfulResults.length) {
    throw assignedResult.reason || createdResult.reason
  }
  const byGuid = new Map()
  for (const result of successfulResults) {
    for (const task of findTaskItems(result)) {
      const guid = String(task.guid || task.task_guid || '')
      if (!guid) continue
      byGuid.set(guid, { ...(byGuid.get(guid) || {}), ...task })
    }
  }
  return { items: [...byGuid.values()], has_more: false }
}

async function createTask(input) {
  const summary = cleanString(input.summary, '任务标题', { required: true, max: 3000 })
  const description = cleanString(input.description, '任务描述', { max: 3000 })
  const due = cleanDate(input.due, '截止时间')
  const requestedAssignee = cleanString(input.assignee, '执行人', { max: 80 })
  const assignee = requestedAssignee || await getCurrentUserOpenId()
  if (!/^(?:ou_|cli_)[A-Za-z0-9]+$/.test(assignee)) {
    throw new WorkspaceError('执行人必须是飞书用户 open_id 或应用 app_id', {
      code: 'INVALID_ASSIGNEE_ID',
      status: 400,
    })
  }
  const hasReminder = input.reminderMinutes !== undefined && input.reminderMinutes !== null
  const reminderMinutes = hasReminder ? Number(input.reminderMinutes) : null
  if (hasReminder && (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 525_600)) {
    throw new WorkspaceError('任务提醒时间必须是 0 到 525600 分钟的整数', {
      code: 'INVALID_REMINDER',
      status: 400,
    })
  }
  if (hasReminder && !due) {
    throw new WorkspaceError('设置任务提醒前必须提供截止时间', {
      code: 'INVALID_REMINDER',
      status: 400,
    })
  }
  const idempotencyKey = cleanString(input.idempotencyKey, '幂等键', { max: 100 })
  return runLark(
    cliArgs(['task', '+create'], {
      summary,
      description,
      due,
      assignee,
      data: hasReminder
        ? JSON.stringify({ reminders: [{ relative_fire_minute: reminderMinutes }] })
        : '',
      'idempotency-key': idempotencyKey || `pet-task-${crypto.randomUUID()}`,
    }),
  )
}

async function updateTask(taskId, input) {
  const id = cleanTaskId(taskId)
  const patch = {
    summary: input.summary === undefined ? '' : cleanString(input.summary, '任务标题', { max: 3000 }),
    description:
      input.description === undefined ? '' : cleanString(input.description, '任务描述', { max: 3000 }),
    due: input.due === undefined ? '' : cleanDate(input.due, '截止时间'),
  }
  if (input.summary === undefined && input.description === undefined && input.due === undefined) {
    throw new WorkspaceError('至少提供一个要修改的任务字段', {
      code: 'INVALID_INPUT',
      status: 400,
    })
  }
  return runLark(cliArgs(['task', '+update'], { 'task-id': id, ...patch }))
}

async function completeTask(taskId) {
  return runLark(cliArgs(['task', '+complete'], { 'task-id': cleanTaskId(taskId) }))
}

async function listAgenda({ start, end } = {}) {
  const startValue = cleanDate(start, '开始时间')
  const endValue = cleanDate(end, '结束时间')
  return runLark(
    cliArgs(['calendar', '+agenda'], {
      start: startValue,
      end: endValue,
      'calendar-id': PRIMARY_CALENDAR_ID,
    }),
  )
}

function cleanAttendees(value) {
  const source = Array.isArray(value) ? value : [value]
  const list = source
    .flatMap((item) => String(item || '').split(/[,，;；\s]+/))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
  if (list.length > 100) {
    throw new WorkspaceError('一次最多添加 100 位参与人', { code: 'INVALID_INPUT', status: 400 })
  }
  return list.map((id) => {
    const text = cleanString(id, '参与人 ID', { required: true, max: 100 })
    if (/^ou_[A-Za-z0-9_-]+$/.test(text)) return { type: 'user', user_id: text }
    if (/^oc_[A-Za-z0-9_-]+$/.test(text)) return { type: 'chat', chat_id: text }
    if (/^omm_[A-Za-z0-9_-]+$/.test(text)) return { type: 'resource', room_id: text }
    throw new WorkspaceError(`无法识别参与人 ID：${text}`, {
      code: 'INVALID_ATTENDEE_ID',
      status: 400,
    })
  })
}

function calendarEventData(input, { partial = false } = {}) {
  const data = {}
  if (!partial || input.summary !== undefined) {
    data.summary = cleanString(input.summary, '日程标题', { required: !partial, max: 1000 })
  }
  if (!partial || input.start !== undefined || input.end !== undefined) {
    const start = cleanDate(input.start, '开始时间', { required: true })
    const end = cleanDate(input.end, '结束时间', { required: true })
    if (Date.parse(end) <= Date.parse(start)) {
      throw new WorkspaceError('结束时间必须晚于开始时间', {
        code: 'INVALID_DATE_RANGE',
        status: 400,
      })
    }
    data.start_time = {
      timestamp: String(Math.floor(Date.parse(start) / 1000)),
      timezone: TIMEZONE,
    }
    data.end_time = {
      timestamp: String(Math.floor(Date.parse(end) / 1000)),
      timezone: TIMEZONE,
    }
  }
  if (!partial || input.description !== undefined) {
    data.description = cleanString(input.description, '日程描述', { max: 5000 })
  }
  if (!partial || input.location !== undefined) {
    const location = cleanString(input.location, '地点', { max: 500 })
    data.location = location ? { name: location, address: location } : {}
  }
  if (!partial || input.reminderMinutes !== undefined) {
    const minutes = Number(input.reminderMinutes ?? 5)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 20160) {
      throw new WorkspaceError('提醒时间必须是 0 到 20160 的整数分钟', {
        code: 'INVALID_REMINDER',
        status: 400,
      })
    }
    data.reminders = [{ minutes }]
  }
  if (!partial || input.meeting !== undefined) {
    data.vchat = { vc_type: input.meeting ? 'vc' : 'no_meeting' }
  }
  return data
}

async function createCalendarEvent(input) {
  const data = calendarEventData(input)
  // 参与人在创建日程前先校验：否则非法 ID 会留下一个已创建的日程，重试还会再建一个
  const attendees = cleanAttendees(input.attendees)
  data.need_notification = true
  const event = await runLark(
    cliArgs(['calendar', 'events', 'create'], {
      params: JSON.stringify({
        calendar_id: PRIMARY_CALENDAR_ID,
        user_id_type: 'open_id',
        idempotency_key: cleanString(input.idempotencyKey, '幂等键', { max: 100 }) || `pet-calendar-${crypto.randomUUID()}`,
      }),
      data: JSON.stringify(data),
    }),
  )
  const eventId = event?.event?.event_id || event?.event_id
  if (!eventId) {
    throw new WorkspaceError('飞书创建日程成功，但没有返回日程 ID', {
      code: 'INVALID_CLI_RESPONSE',
      status: 502,
    })
  }
  if (attendees.length && eventId) {
    try {
      await runLark(
        cliArgs(['calendar', 'event.attendees', 'create'], {
          params: JSON.stringify({
            calendar_id: PRIMARY_CALENDAR_ID,
            event_id: eventId,
            user_id_type: 'open_id',
          }),
          data: JSON.stringify({ attendees, need_notification: true }),
        }),
      )
    } catch (err) {
      throw new WorkspaceError(`日程已创建，但邀请参与人失败（event_id: ${eventId}）`, {
        code: 'ATTENDEE_INVITE_FAILED',
        status: 502,
        hint: err?.hint || err?.message || '请在飞书日程详情中补充参与人',
        details: { eventId },
      })
    }
  }
  return event
}

async function updateCalendarEvent(eventId, input) {
  const id = cleanEventId(eventId)
  const data = calendarEventData(input, { partial: true })
  if (!Object.keys(data).length) {
    throw new WorkspaceError('至少提供一个要修改的日程字段', {
      code: 'INVALID_INPUT',
      status: 400,
    })
  }
  data.need_notification = true
  return runLark(
    cliArgs(['calendar', 'events', 'patch'], {
      params: JSON.stringify({
        calendar_id: PRIMARY_CALENDAR_ID,
        event_id: id,
        user_id_type: 'open_id',
      }),
      data: JSON.stringify(data),
    }),
  )
}

async function suggestCalendarTime(input) {
  const start = cleanDate(input.start, '候选开始时间', { required: true })
  const end = cleanDate(input.end, '候选结束时间', { required: true })
  const duration = Number(input.durationMinutes || 30)
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) {
    throw new WorkspaceError('会议时长必须是 5 到 1440 分钟', {
      code: 'INVALID_DURATION',
      status: 400,
    })
  }
  return runLark(
    cliArgs(['calendar', '+suggestion'], {
      start,
      end,
      'duration-minutes': duration,
      'attendee-ids': cleanAttendees(input.attendees)
        .map((item) => item.user_id || item.chat_id || item.room_id)
        .join(','),
      timezone: TIMEZONE,
    }),
  )
}

module.exports = {
  TIMEZONE,
  REQUIRED_SCOPES,
  WorkspaceError,
  runLark,
  getWorkspaceStatus,
  listApprovals,
  getApproval,
  decideApproval,
  listTasks,
  createTask,
  updateTask,
  completeTask,
  listAgenda,
  createCalendarEvent,
  updateCalendarEvent,
  suggestCalendarTime,
  OPTIONAL_SCOPES,
}
