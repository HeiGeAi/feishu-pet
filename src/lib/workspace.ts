export type JsonObject = Record<string, unknown>

export interface WorkspaceStatus {
  cliInstalled: boolean
  version?: string
  userAvailable: boolean
  ready?: boolean
  tokenStatus?: string
  authMessage?: string
  loginCommand?: string
  requiredScopes?: Record<string, string[]>
  optionalScopes?: Record<string, string[]>
  missingScopes?: string[]
  missingOptionalScopes?: string[]
}

export interface ApprovalItem {
  instanceCode: string
  definitionCode: string
  taskId: string
  title: string
  initiator: string
  definitionName: string
  link: string
  canOperate: boolean
  summaries: { key: string; value: string }[]
  raw: JsonObject
}

export interface TaskItem {
  guid: string
  summary: string
  description: string
  due: number | null
  url: string
  status: string
  raw: JsonObject
}

export interface CalendarItem {
  eventId: string
  summary: string
  description: string
  start: number | null
  end: number | null
  location: string
  meeting: boolean
  url: string
  raw: JsonObject
}

export interface AssistantPlan {
  action: string
  arguments: JsonObject
  preview: string
  requiresConfirmation: boolean
}

export class ApiError extends Error {
  code: string
  hint: string

  constructor(message: string, code = '', hint = '') {
    super(message)
    this.code = code
    this.hint = hint
  }
}

export async function workspaceApi<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (['POST', 'PATCH'].includes((init?.method || 'GET').toUpperCase())) {
    headers.set('X-Feishu-Pet-Request', '1')
  }
  const res = await fetch(url, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new ApiError(data.error || `请求失败（HTTP ${res.status}）`, data.code, data.hint)
  }
  return data as T
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

export function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

export function findArray(value: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object') as JsonObject[]
  }
  const root = asObject(value)
  for (const key of keys) {
    if (Array.isArray(root[key])) return findArray(root[key], keys)
  }
  for (const key of ['data', 'result', 'page']) {
    const nested = root[key]
    if (nested && typeof nested === 'object') {
      const found = findArray(nested, keys)
      if (found.length) return found
    }
  }
  return []
}

export function parseEpoch(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const obj = asObject(value)
    return parseEpoch(obj.timestamp ?? obj.time ?? obj.date ?? obj.datetime)
  }
  if (typeof value === 'number' || /^\d+$/.test(asString(value))) {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    return n < 10_000_000_000 ? n * 1000 : n
  }
  const parsed = Date.parse(asString(value))
  return Number.isNaN(parsed) ? null : parsed
}

export function formatDate(value: number | null, fallback = '未设置') {
  if (!value) return fallback
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 从空闲时间建议返回里提取「开始 - 结束」时间段文案；结构对不上时返回空数组 */
export function formatTimeSlots(data: unknown): string[] {
  const slots = findArray(data, ['suggestions', 'slots', 'free_slots', 'time_slots', 'items'])
  return slots
    .map((slot) => {
      const start = parseEpoch(slot.start_time ?? slot.start ?? slot.begin)
      const end = parseEpoch(slot.end_time ?? slot.end ?? slot.finish)
      if (!start) return ''
      return end ? `${formatDate(start)} - ${formatDate(end)}` : formatDate(start)
    })
    .filter(Boolean)
}

export function normalizeApprovals(data: unknown): ApprovalItem[] {
  return findArray(data, ['tasks', 'items']).map((raw) => {
    const instanceCode = asString(raw.instance_code ?? raw.instanceCode)
    const definitionCode = asString(raw.definition_code ?? raw.definitionCode)
    const taskId = asString(raw.task_id ?? raw.taskId)
    const nativeLink = definitionCode && instanceCode && taskId
      ? `https://applink.feishu.cn/client/approval/detail?approvalCode=${encodeURIComponent(definitionCode)}&instanceCode=${encodeURIComponent(instanceCode)}&taskId=${encodeURIComponent(taskId)}`
      : ''
    return {
      instanceCode,
      definitionCode,
      taskId,
      title: asString(raw.title ?? raw.definition_name ?? '未命名审批'),
      initiator: asString(raw.initiator_name ?? raw.initiator ?? '未知发起人'),
      definitionName: asString(raw.definition_name ?? raw.definition_group_name ?? ''),
      link: asString(raw.link) || nativeLink,
      canOperate: raw.support_api_operate !== false,
      summaries: Array.isArray(raw.summaries)
        ? raw.summaries.map((item) => {
            const obj = asObject(item)
            return { key: asString(obj.key), value: asString(obj.value) }
          })
        : [],
      raw,
    }
  })
}

export function normalizeTasks(data: unknown): TaskItem[] {
  return findArray(data, ['tasks', 'items', 'task_list']).map((raw) => ({
    guid: asString(raw.guid ?? raw.task_guid),
    summary: asString(raw.summary ?? raw.title ?? '未命名任务'),
    description: asString(raw.description),
    due: parseEpoch(raw.due ?? raw.due_time ?? raw.due_at),
    url: asString(raw.url ?? raw.app_link),
    status: asString(raw.status ?? 'todo'),
    raw,
  }))
}

export function normalizeCalendar(data: unknown): CalendarItem[] {
  return findArray(data, ['events', 'items', 'event_list']).map((raw) => {
    const location = asObject(raw.location)
    const vchat = asObject(raw.vchat)
    return {
      eventId: asString(raw.event_id ?? raw.eventId ?? raw.id),
      summary: asString(raw.summary ?? raw.title ?? '未命名日程'),
      description: asString(raw.description),
      start: parseEpoch(raw.start_time ?? raw.start ?? raw.start_at),
      end: parseEpoch(raw.end_time ?? raw.end ?? raw.end_at),
      location: asString(location.name ?? location.address ?? raw.location),
      meeting: Boolean(vchat.meeting_url) || ['vc', 'lark_live'].includes(asString(vchat.vc_type)),
      url: asString(raw.app_link ?? raw.url),
      raw,
    }
  })
}
