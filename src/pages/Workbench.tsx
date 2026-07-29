import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  Bot,
  CalendarDays,
  Check,
  Clipboard,
  Clock3,
  FileCheck2,
  ListTodo,
  LoaderCircle,
  MapPin,
  Pencil,
  Paperclip,
  Plus,
  RefreshCw,
  Sparkles,
  Users,
  Video,
  WandSparkles,
  X,
} from 'lucide-react'
import { LlmSettings } from '@/components/LlmSettings'
import {
  ApiError,
  asObject,
  asString,
  formatDate,
  formatTimeSlots,
  normalizeApprovals,
  normalizeCalendar,
  normalizeTasks,
  workspaceApi as api,
  type ApprovalItem,
  type AssistantPlan,
  type CalendarItem,
  type JsonObject,
  type TaskItem,
  type WorkspaceStatus,
} from '@/lib/workspace'

type TabId = 'approvals' | 'tasks' | 'calendar'

interface ApprovalEvaluation {
  summary?: string
  riskLevel?: 'low' | 'medium' | 'high'
  recommendation?: 'approve' | 'reject' | 'need_more_info' | 'manual_review'
  confidence?: number
  reasoning?: string
  riskPoints?: string[]
  missingInformation?: string[]
  checklist?: string[]
}


function toDateTimeInput(value: number | null) {
  if (!value) return ''
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultDateTime(offsetMinutes: number) {
  const date = new Date(Date.now() + offsetMinutes * 60_000)
  date.setMinutes(Math.ceil(date.getMinutes() / 30) * 30, 0, 0)
  return toDateTimeInput(date.getTime())
}

function inputToIso(value: string) {
  return value ? new Date(value).toISOString() : ''
}

function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || (!text.startsWith('[') && !text.startsWith('{'))) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function isAttachmentUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const location = `${url.hostname}${url.pathname}`
    return (
      /approval-attachment|internal-api-drive-stream/i.test(location) ||
      /\.(pdf|png|jpe?g|webp|gif)$/i.test(url.pathname) ||
      url.searchParams.has('x-signature') ||
      url.searchParams.has('x-expires')
    )
  } catch {
    return false
  }
}

function collectAttachmentUrls(value: unknown, result = new Set<string>(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return result
  const parsed = parseStructuredValue(value)
  if (parsed !== value) return collectAttachmentUrls(parsed, result, depth + 1)
  if (typeof value === 'string') {
    if (isAttachmentUrl(value)) result.add(value)
    return result
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectAttachmentUrls(item, result, depth + 1))
    return result
  }
  if (typeof value === 'object') {
    Object.values(value as JsonObject).forEach((item) => collectAttachmentUrls(item, result, depth + 1))
  }
  return result
}

function primitiveText(value: unknown, label = '') {
  if (value === null || value === undefined || value === '') return '未填写'
  if (typeof value === 'number' && /金额|费用|amount/i.test(label)) return `¥${value.toFixed(2)}`
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const timestamp = Date.parse(value)
    if (!Number.isNaN(timestamp)) return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  return asString(value)
}

const structuredLabels: Record<string, string> = {
  departure: '出发地',
  destination: '目的地',
  start: '开始日期',
  end: '结束日期',
  interval: '天数',
  oneRound: '行程类型',
  transport: '交通工具',
  remark: '备注',
  reason: '出差事由',
  peer: '同行人',
  schedule: '行程安排',
  name: '名称',
  label: '选项',
  text: '内容',
  value: '值',
  amount: '金额',
  date: '日期',
  address: '地址',
  city: '城市',
  country: '国家/地区',
}

const hiddenStructuredKeys = new Set([
  'id',
  'open_id',
  'openId',
  'peer_open_ids',
  'timezoneOffset',
  'timezone_offset',
])

function structuredLabel(key: string) {
  return structuredLabels[key] || key.replace(/_/g, ' ')
}

function StructuredValue({ value, depth = 0, label = '' }: { value: unknown; depth?: number; label?: string }) {
  const parsed = parseStructuredValue(value)
  if (parsed !== value) return <StructuredValue value={parsed} depth={depth + 1} label={label} />
  if (depth > 8) return <p className="break-words text-xs font-bold">{JSON.stringify(value)}</p>
  if (typeof value === 'string' && isAttachmentUrl(value)) {
    return <p className="text-xs font-bold text-[#191919]/45">附件链接已隐藏</p>
  }
  if (!value || typeof value !== 'object') {
    return <p className="whitespace-pre-wrap break-words text-xs font-bold">{primitiveText(value, label)}</p>
  }
  if (Array.isArray(value)) {
    if (!value.length) return <p className="text-xs font-bold text-[#191919]/45">无</p>
    const fieldRows = value.every((item) => {
      const row = asObject(item)
      return Boolean(row.name || row.id) && Object.prototype.hasOwnProperty.call(row, 'value')
    })
    if (fieldRows) {
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {value.map((item, index) => {
            const row = asObject(item)
            const name = asString(row.name ?? row.id ?? `字段 ${index + 1}`)
            return (
              <div key={`${name}-${index}`} className="rounded-md border border-[#191919]/15 bg-white p-2">
                <p className="text-[10px] font-black text-[#191919]/45">{name}</p>
                <div className="mt-1"><StructuredValue value={row.value} depth={depth + 1} label={name} /></div>
              </div>
            )
          })}
        </div>
      )
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-md border border-[#191919]/15 bg-white p-2">
            {value.length > 1 && <p className="mb-1 text-[9px] font-black text-[#2B5CFF]">第 {index + 1} 项</p>}
            <StructuredValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }
  const entries = Object.entries(value as JsonObject).filter(([key]) => !hiddenStructuredKeys.has(key))
  if (!entries.length) return <p className="text-xs font-bold text-[#191919]/45">无</p>
  return (
    <div className="space-y-1.5">
      {entries.map(([key, item]) => (
        <div key={key} className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-xs">
          <span className="font-black text-[#191919]/45">{structuredLabel(key)}</span>
          <StructuredValue value={item} depth={depth + 1} label={structuredLabel(key)} />
        </div>
      ))}
    </div>
  )
}

function choiceText(value: unknown): string {
  const parsed = parseStructuredValue(value)
  if (Array.isArray(parsed)) return parsed.map(choiceText).filter(Boolean).join('、')
  if (!parsed || typeof parsed !== 'object') return primitiveText(parsed)
  const item = asObject(parsed)
  return choiceText(item.text ?? item.label ?? item.name ?? item.value)
}

function personNames(value: unknown): string[] {
  const parsed = parseStructuredValue(value)
  if (!Array.isArray(parsed)) return []
  return parsed.map((item) => {
    if (!item || typeof item !== 'object') return asString(item)
    const person = asObject(item)
    return asString(person.name ?? person.user_name ?? person.display_name ?? person.label)
  }).filter(Boolean)
}

function formatTripDate(value: unknown, exclusiveEnd = false) {
  const timestamp = Date.parse(asString(value))
  if (Number.isNaN(timestamp)) return primitiveText(value)
  const date = new Date(timestamp)
  if (exclusiveEnd && date.getHours() === 0 && date.getMinutes() === 0) {
    date.setDate(date.getDate() - 1)
  }
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function TripGroupValue({ value }: { value: unknown }) {
  const trip = asObject(parseStructuredValue(value))
  const schedules = Array.isArray(trip.schedule) ? trip.schedule.map(asObject) : []
  const peers = personNames(trip.peer)

  return (
    <div className="space-y-3">
      {asString(trip.reason) && (
        <div className="rounded-md border-2 border-[#191919]/15 bg-[#FFFBE8] p-3">
          <p className="text-[10px] font-black text-[#191919]/45">出差事由</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs font-bold leading-relaxed">{asString(trip.reason)}</p>
        </div>
      )}
      {schedules.map((schedule, index) => {
        const start = formatTripDate(schedule.start)
        const end = formatTripDate(schedule.end, true)
        const days = numericAmount(schedule.interval ?? trip.interval)
        return (
          <article key={`${asString(schedule.start)}-${index}`} className="overflow-hidden rounded-md border-2 border-[#191919] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#191919] bg-[#E9F0FF] px-3 py-2">
              <p className="flex items-center gap-1.5 text-xs font-black">
                <CalendarDays className="h-3.5 w-3.5 text-[#2B5CFF]" />
                {schedules.length > 1 ? `第 ${index + 1} 段 · ` : ''}{start} - {end}
              </p>
              <span className="rounded border border-[#191919] bg-[#FFD60A] px-1.5 py-0.5 text-[10px] font-black">
                {days === null ? '天数未返回' : `${days} 天`}
              </span>
            </div>
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-black text-[#191919]/45">出发地</p>
                <p className="mt-1 flex items-start gap-1.5 text-xs font-bold"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2B5CFF]" />{primitiveText(schedule.departure)}</p>
              </div>
              <div>
                <p className="text-[10px] font-black text-[#191919]/45">目的地</p>
                <p className="mt-1 flex items-start gap-1.5 text-xs font-bold"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FF4D4F]" />{primitiveText(schedule.destination)}</p>
              </div>
              <div>
                <p className="text-[10px] font-black text-[#191919]/45">交通与行程</p>
                <p className="mt-1 text-xs font-bold">{[asString(schedule.transport), asString(schedule.oneRound)].filter(Boolean).join(' · ') || '未填写'}</p>
              </div>
              <div>
                <p className="text-[10px] font-black text-[#191919]/45">同行人</p>
                <p className="mt-1 text-xs font-bold">{peers.length ? peers.join('、') : '无'}</p>
              </div>
              {asString(schedule.remark) && (
                <div className="sm:col-span-2">
                  <p className="text-[10px] font-black text-[#191919]/45">备注</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs font-bold">{asString(schedule.remark)}</p>
                </div>
              )}
            </div>
          </article>
        )
      })}
      {!schedules.length && !asString(trip.reason) && <StructuredValue value={trip} />}
    </div>
  )
}

function OutGroupValue({ value }: { value: unknown }) {
  const outing = asObject(parseStructuredValue(value))
  const unit = {
    HOUR: '小时',
    DAY: '天',
    HALF_DAY: '半天',
  }[asString(outing.unit).toUpperCase()] || asString(outing.unit) || '小时'

  return (
    <div className="overflow-hidden rounded-md border-2 border-[#191919] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#191919] bg-[#EAFBD3] px-3 py-2">
        <p className="text-xs font-black">{asString(outing.name) || '外出'}</p>
        <span className="rounded border border-[#191919] bg-white px-1.5 py-0.5 text-[10px] font-black">
          {primitiveText(outing.interval)} {unit}
        </span>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-black text-[#191919]/45">开始时间</p>
          <p className="mt-1 flex items-start gap-1.5 text-xs font-bold"><Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2B5CFF]" />{primitiveText(outing.start)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black text-[#191919]/45">结束时间</p>
          <p className="mt-1 flex items-start gap-1.5 text-xs font-bold"><Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FF4D4F]" />{primitiveText(outing.end)}</p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-[10px] font-black text-[#191919]/45">外出事由</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs font-bold leading-relaxed">{primitiveText(outing.reason)}</p>
        </div>
      </div>
    </div>
  )
}

function ApprovalFieldValue({ field }: { field: ApprovalField }) {
  const type = field.type.toLowerCase()
  if (type === 'tripgroup') return <TripGroupValue value={field.value} />
  if (type === 'outgroup') return <OutGroupValue value={field.value} />
  if (type === 'connect') {
    const connected = Array.isArray(field.value) ? field.value.length : 0
    return <p className="text-xs font-bold">{connected ? `已关联 ${connected} 条审批` : '未关联审批'}</p>
  }
  if (['radiov2', 'radio', 'checkboxv2', 'checkbox', 'select'].includes(type)) {
    return <p className="whitespace-pre-wrap break-words text-xs font-bold">{choiceText(field.value)}</p>
  }
  return <StructuredValue value={field.value} label={field.name} />
}

function AttachmentPreview({ urls }: { urls: string[] }) {
  if (!urls.length) return null
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-black">附件</h4>
        <span className="rounded border border-[#191919] bg-[#FFD60A] px-1.5 text-[10px] font-black">{urls.length} 份</span>
      </div>
      <div className="divide-y-2 divide-[#191919]/10 border-y-2 border-[#191919]/15">
        {urls.map((url, index) => {
          const pdf = new URL(url).pathname.toLowerCase().endsWith('.pdf')
          return (
            <article key={url} className="flex min-h-14 items-center gap-3 bg-white px-1 py-2">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border-2 border-[#191919] bg-[#E9F0FF]">
                <Paperclip className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-black">附件 {index + 1}{pdf ? ' · PDF' : ' · 图片'}</p>
                <p className="text-[10px] font-bold text-[#191919]/45">默认不加载文件内容</p>
              </div>
              <a href={url} target="_blank" rel="noreferrer" className={`${buttonClass} shrink-0 border-[#191919]/35 bg-white text-[#2B5CFF]`}>按需打开</a>
            </article>
          )
        })}
      </div>
      <p className="mt-2 text-[10px] font-bold text-[#191919]/40">审批评估只读取表单 JSON，不会请求这些附件 URL。</p>
    </section>
  )
}

interface ApprovalField {
  name: string
  type: string
  value: unknown
}

interface ExpenseRow {
  content: string
  date: string
  amount: number | null
}

function numericAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const match = asString(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function expenseRowsFrom(value: unknown): ExpenseRow[] {
  const parsed = parseStructuredValue(value)
  if (!Array.isArray(parsed)) return []
  const rows = parsed.map((row) => Array.isArray(row) ? row : [row])
  return rows.map((row) => {
    const fields = row.map(asObject)
    const find = (pattern: RegExp) => fields.find((field) => pattern.test(asString(field.name)))
    const content = find(/内容|事由|说明/)
    const date = find(/日期|时间/)
    const amount = find(/金额|费用/)
    return {
      content: asString(content?.value) || '未填写内容',
      date: primitiveText(date?.value, '日期'),
      amount: numericAmount(amount?.value),
    }
  }).filter((row) => row.content || row.date || row.amount !== null)
}

function money(value: number | null) {
  return value === null ? '未返回' : `¥${value.toFixed(2)}`
}

function ExpenseBreakdown({ rows, formulaTotal }: { rows: ExpenseRow[]; formulaTotal: number | null }) {
  if (!rows.length && formulaTotal === null) return null
  const calculatedTotal = rows.length && rows.every((row) => row.amount !== null)
    ? rows.reduce((sum, row) => sum + (row.amount || 0), 0)
    : null
  const comparable = formulaTotal !== null && calculatedTotal !== null
  const mismatch = comparable && Math.abs(formulaTotal - calculatedTotal) >= 0.005
  const verificationLabel = !comparable
    ? '待核验'
    : mismatch
      ? '金额不一致'
      : '金额一致'
  return (
    <section className="border-y-[3px] border-[#191919] bg-[#FFFDF8]">
      <div className="grid grid-cols-2 divide-x-2 divide-[#191919] border-b-2 border-[#191919] sm:grid-cols-[1fr_1fr_auto]">
        <div className="p-3">
          <p className="text-[10px] font-black text-[#191919]/45">飞书公式返回</p>
          <p className="mt-1 text-xl font-black tabular-nums">{money(formulaTotal)}</p>
        </div>
        <div className="p-3">
          <p className="text-[10px] font-black text-[#191919]/45">明细计算</p>
          <p className="mt-1 text-xl font-black tabular-nums">{money(calculatedTotal)}</p>
        </div>
        <div className={`col-span-2 flex items-center justify-center px-3 py-2 text-xs font-black sm:col-span-1 ${mismatch ? 'bg-[#FFD7D5] text-[#8A1C1C]' : comparable ? 'bg-[#DDF9B9] text-[#285E13]' : 'bg-[#FFF2B3] text-[#6B4F00]'}`}>
          {verificationLabel}
        </div>
      </div>
      {rows.length > 0 && (
        <div>
          <div className="flex items-center justify-between border-b border-[#191919]/15 px-3 py-2">
            <h4 className="text-xs font-black">费用明细</h4>
            <span className="text-[10px] font-bold text-[#191919]/45">{rows.length} 项</span>
          </div>
          <div className="divide-y divide-[#191919]/12">
            {rows.map((row, index) => (
              <div key={`${row.content}-${index}`} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#2B5CFF] text-[10px] font-black text-white">{index + 1}</span>
                <div className="min-w-0">
                  <p className="break-words text-xs font-black leading-relaxed">{row.content}</p>
                  <p className="mt-0.5 text-[10px] font-bold text-[#191919]/45">{row.date}</p>
                </div>
                <p className="text-sm font-black tabular-nums">{money(row.amount)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function ErrorNotice({ error }: { error: ApiError | null }) {
  if (!error) return null
  const auth = error.code === 'AUTH_REQUIRED'
  return (
    <div className="rounded-md border-2 border-[#191919] bg-[#FFF0EF] px-3 py-2 text-xs font-bold text-[#8A1C1C]">
      <p>{auth ? '需要飞书用户授权：' : ''}{error.message}</p>
      {error.hint && <p className="mt-1 text-[11px] text-[#8A1C1C]/70">{error.hint}</p>}
    </div>
  )
}

function LoadingBlock({ text = '正在读取飞书数据' }: { text?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-2 text-sm font-bold text-[#191919]/55">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      {text}
    </div>
  )
}

function EmptyBlock({ text }: { text: string }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-md border-2 border-dashed border-[#191919]/20 bg-white/60 px-4 text-center text-sm font-bold text-[#191919]/45">
      {text}
    </div>
  )
}

const inputClass =
  'w-full rounded-md border-2 border-[#191919] bg-white px-3 py-2 text-sm font-bold outline-none transition-colors focus:border-[#2B5CFF]'
const buttonClass =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border-2 border-[#191919] px-3 py-1.5 text-xs font-black transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50'

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    'task.create': '创建任务',
    'task.update': '修改任务',
    'task.complete': '完成任务',
    'calendar.create': '创建日程',
    'calendar.update': '修改日程',
    'calendar.suggest': '查找空闲时间',
    clarify: '需要补充',
  }
  return labels[action] || action
}

function AuthBanner({ status }: { status: WorkspaceStatus | null }) {
  const [copied, setCopied] = useState(false)
  const missingOptionalScopes = status?.missingOptionalScopes || []
  const optionalCapabilityNames = [
    missingOptionalScopes.includes('calendar:calendar.free_busy:read') ? '查找空闲时间' : '',
  ].filter(Boolean)
  if (!status || (status.ready && !missingOptionalScopes.length)) return null
  const copy = async () => {
    if (!status.loginCommand) return
    await navigator.clipboard.writeText(status.loginCommand)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="border-y-[3px] border-[#191919] bg-[#FFD60A]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="min-w-0">
          <p className="text-sm font-black">
            {!status.cliInstalled
              ? '未找到 lark-cli'
              : status.userAvailable
                ? status.ready
                  ? '飞书核心权限已就绪'
                  : '飞书权限不完整'
                : '飞书用户授权已失效'}
          </p>
          <p className="text-[11px] font-bold text-[#191919]/65">
            {status.cliInstalled
              ? status.userAvailable
                ? status.ready
                  ? `核心能力可用；${optionalCapabilityNames.join('、') || `${missingOptionalScopes.length} 项扩展能力`}仍需可选权限。`
                  : `还缺 ${status.missingScopes?.length || 0} 项核心权限，增量授权后即可使用基础工作台能力。`
                : '审批、任务和个人日历必须使用用户身份，重新授权后即可读取真实数据。'
              : '请先安装并初始化飞书 CLI。'}
          </p>
        </div>
        {status.loginCommand && (
          <button className={`${buttonClass} shrink-0 bg-white`} onClick={copy} title="复制授权命令">
            {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            {copied ? '已复制' : status.ready ? '复制可选权限授权命令' : '复制最小权限授权命令'}
          </button>
        )}
      </div>
    </div>
  )
}

function ApprovalTab({ items, loading, error, reload }: {
  items: ApprovalItem[]
  loading: boolean
  error: ApiError | null
  reload: () => void
}) {
  const [selected, setSelected] = useState<ApprovalItem | null>(null)
  const [detail, setDetail] = useState<JsonObject | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [evaluation, setEvaluation] = useState<ApprovalEvaluation | null>(null)
  const [evaluationCache, setEvaluationCache] = useState<{ cached: boolean; cachedAt: number } | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [localError, setLocalError] = useState<ApiError | null>(null)
  const [comment, setComment] = useState('')
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'reject' | null>(null)
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionStatus, setDecisionStatus] = useState('')
  const selectionRequestId = useRef(0)
  const evaluationRequestId = useRef(0)

  const evaluateCode = useCallback(async (
    instanceCode: string,
    force = false,
    selectionId = selectionRequestId.current,
  ) => {
    const requestId = ++evaluationRequestId.current
    setEvaluating(true)
    setLocalError(null)
    try {
      const result = await api<{
        ok: true
        evaluation: ApprovalEvaluation
        cached: boolean
        cachedAt: number
      }>(
        '/api/workspace/approvals/evaluate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceCode, force }),
        },
      )
      if (
        selectionId !== selectionRequestId.current ||
        requestId !== evaluationRequestId.current
      ) return
      setEvaluation(result.evaluation)
      setEvaluationCache({ cached: result.cached, cachedAt: result.cachedAt })
    } catch (err) {
      if (
        selectionId !== selectionRequestId.current ||
        requestId !== evaluationRequestId.current
      ) return
      setLocalError(err as ApiError)
    } finally {
      if (
        selectionId === selectionRequestId.current &&
        requestId === evaluationRequestId.current
      ) setEvaluating(false)
    }
  }, [])

  const open = useCallback(async (item: ApprovalItem) => {
    const selectionId = ++selectionRequestId.current
    evaluationRequestId.current += 1
    setSelected(item)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('approval', item.instanceCode)
    window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}`)
    setDetail(null)
    setEvaluation(null)
    setEvaluationCache(null)
    setLocalError(null)
    setComment('')
    setPendingDecision(null)
    setDecisionStatus('')
    setDetailLoading(true)
    setEvaluating(false)
    try {
      const result = await api<{ ok: true; data: unknown }>(
        `/api/workspace/approvals/${encodeURIComponent(item.instanceCode)}`,
      )
      if (selectionId !== selectionRequestId.current) return
      const nextDetail = asObject(result.data)
      setDetail(nextDetail)
      setSelected((current) => {
        if (!current || current.instanceCode !== item.instanceCode) return current
        const definitionCode = current.definitionCode || asString(nextDetail.definition_code)
        const pendingTask = Array.isArray(nextDetail.tasks)
          ? nextDetail.tasks.map(asObject).find((task) => asString(task.status) === 'PENDING')
          : undefined
        const taskId = current.taskId || asString(pendingTask?.id)
        const link = current.link || (definitionCode && taskId
          ? `https://applink.feishu.cn/client/approval/detail?approvalCode=${encodeURIComponent(definitionCode)}&instanceCode=${encodeURIComponent(item.instanceCode)}&taskId=${encodeURIComponent(taskId)}`
          : '')
        return {
          ...current,
          definitionCode,
          definitionName: current.definitionName || asString(nextDetail.definition_name),
          title: current.title === '审批详情' ? asString(nextDetail.definition_name) || current.title : current.title,
          taskId,
          link,
        }
      })
      void evaluateCode(item.instanceCode, false, selectionId)
    } catch (err) {
      if (selectionId !== selectionRequestId.current) return
      setLocalError(err as ApiError)
    } finally {
      if (selectionId === selectionRequestId.current) setDetailLoading(false)
    }
  }, [evaluateCode])

  useEffect(() => {
    if (selected) return
    const requested = new URLSearchParams(window.location.search).get('approval')
    const requestedIsSafe = Boolean(requested && /^[A-Za-z0-9_-]{1,200}$/.test(requested))
    const initialItem = items.find((item) => item.instanceCode === requested) || (requestedIsSafe ? {
      instanceCode: requested || '',
      definitionCode: '',
      taskId: '',
      title: '审批详情',
      initiator: '非当前待办',
      definitionName: '',
      link: '',
      canOperate: false,
      summaries: [],
      raw: {},
    } satisfies ApprovalItem : items[0])
    if (initialItem) void open(initialItem)
  }, [items, open, selected])

  useEffect(() => {
    setSelected((current) => {
      if (!current) return current
      const pendingItem = items.find((item) => item.instanceCode === current.instanceCode)
      if (!pendingItem) return current
      if (
        current.taskId === pendingItem.taskId &&
        current.canOperate === pendingItem.canOperate &&
        current.summaries.length === pendingItem.summaries.length
      ) return current
      return { ...current, ...pendingItem }
    })
  }, [items])

  const evaluate = () => {
    if (selected) void evaluateCode(selected.instanceCode, true)
  }

  const prepareDecision = (action: 'approve' | 'reject') => {
    setLocalError(null)
    setPendingDecision(action)
  }

  const submitDecision = async () => {
    if (!selected || !pendingDecision) return
    setDecisionBusy(true)
    setLocalError(null)
    try {
      await api(`/api/workspace/approvals/${encodeURIComponent(selected.instanceCode)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: selected.taskId,
          action: pendingDecision,
          comment,
          confirmed: true,
        }),
      })
      setDecisionStatus(pendingDecision === 'approve' ? '已通过该审批' : '已拒绝该审批')
      setPendingDecision(null)
      reload()
    } catch (err) {
      setLocalError(err as ApiError)
    } finally {
      setDecisionBusy(false)
    }
  }

  const fields = useMemo(() => {
    if (!detail) return []
    try {
      const parsed = typeof detail.form === 'string' ? JSON.parse(detail.form) : detail.form
      if (!Array.isArray(parsed)) return []
      return parsed.map((value): ApprovalField => {
        const row = asObject(value)
        const rawValue = row.value
        return {
          name: asString(row.name ?? row.custom_id ?? row.id ?? '字段'),
          type: asString(row.type),
          value: parseStructuredValue(rawValue),
        }
      })
    } catch {
      return [{ name: '审批表单', type: '', value: asString(detail.form) }]
    }
  }, [detail])

  const attachments = useMemo(
    () => detail ? [...collectAttachmentUrls(detail)] : [],
    [detail],
  )
  const expenseField = fields.find((field) => /费用明细/.test(field.name))
  const formulaField = fields.find((field) => /费用汇总/.test(field.name))
  const expenses = expenseRowsFrom(expenseField?.value)
  const formulaTotal = numericAmount(formulaField?.value)
  const regularFields = fields.filter((field) => (
    field !== expenseField &&
    field !== formulaField &&
    !/attachment/i.test(field.type) &&
    !/附件/.test(field.name)
  ))

  const riskColor = evaluation?.riskLevel === 'high'
    ? '#FF8F8F'
    : evaluation?.riskLevel === 'medium'
      ? '#FFD60A'
      : '#9BE83A'
  const recommendation = {
    approve: '建议通过',
    reject: '建议拒绝',
    need_more_info: '补充信息后再审',
    manual_review: '建议人工复核',
  }[evaluation?.recommendation || 'manual_review']

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(300px,0.8fr)_minmax(380px,1.2fr)]">
      <section className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">审批待办</h2>
            <p className="text-[11px] font-bold text-[#191919]/45">打开后自动评估，不会自动提交审批决定</p>
          </div>
          <button className={`${buttonClass} bg-white`} onClick={reload} title="刷新审批列表">
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>
        <ErrorNotice error={error} />
        {loading ? (
          <LoadingBlock />
        ) : items.length === 0 && !error ? (
          <EmptyBlock text="当前没有审批待办" />
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => {
              const itemSelected = selected?.instanceCode === item.instanceCode
              return (
                <button
                  key={`${item.instanceCode}-${item.title}`}
                  className={`w-full rounded-md border-2 border-[#191919] p-3 text-left transition-all hover:-translate-y-0.5 ${itemSelected ? 'bg-[#E9F0FF] shadow-[3px_3px_0_#191919]' : 'bg-white'}`}
                  onClick={() => void open(item)}
                  aria-pressed={itemSelected}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm font-black leading-snug">{item.title}</p>
                    <span className="shrink-0 rounded border border-[#191919] bg-[#FFD60A] px-1.5 py-0.5 text-[10px] font-black">待审批</span>
                  </div>
                  <p className="mt-1 text-[11px] font-bold text-[#191919]/55">
                    {item.initiator}{item.definitionName ? ` · ${item.definitionName}` : ''}
                  </p>
                  {item.summaries.slice(0, 2).map((summary) => (
                    <p key={`${summary.key}-${summary.value}`} className="mt-1 truncate text-[11px] text-[#191919]/65">
                      <span className="font-bold">{summary.key}：</span>{summary.value}
                    </p>
                  ))}
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="min-w-0 border-t-2 border-[#191919]/15 pt-5 xl:border-l-2 xl:border-t-0 xl:pl-5 xl:pt-0">
        {!selected ? (
          <EmptyBlock text="选择一条审批，查看完整内容并让大模型评估" />
        ) : detailLoading ? (
          <LoadingBlock text="正在读取审批详情" />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black text-[#2B5CFF]">审批详情</p>
                <h3 className="text-xl font-black">{asString(detail?.definition_name) || selected.title}</h3>
                <p className="mt-1 text-[11px] font-bold text-[#191919]/45">
                  单号 {asString(detail?.serial_number) || selected.instanceCode}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {selected.link && (
                  <a className={`${buttonClass} bg-[#2B5CFF] text-white`} href={selected.link} target="_blank" rel="noreferrer">
                    <FileCheck2 className="h-4 w-4" />飞书中打开审批
                  </a>
                )}
                <button
                  className={`${buttonClass} bg-[#9BE83A]`}
                  onClick={evaluate}
                  disabled={!detail || evaluating}
                >
                  {evaluating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {evaluating ? '自动评估中' : evaluation ? '重新评估（消耗 token）' : '大模型评估'}
                </button>
              </div>
            </div>
            <ErrorNotice error={localError} />
            {regularFields.length ? (
              <dl className="divide-y-2 divide-[#191919]/10 border-y-2 border-[#191919]/15 bg-white">
                {regularFields.map((field, index) => (
                  <div key={`${field.name}-${index}`} className="grid gap-1 px-2 py-2.5 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
                    <dt className="text-[10px] font-black text-[#191919]/45">{field.name}</dt>
                    <dd><ApprovalFieldValue field={field} /></dd>
                  </div>
                ))}
              </dl>
            ) : !fields.length ? <p className="text-xs font-bold text-[#191919]/45">该审批没有可展示的表单字段。</p> : null}
            <ExpenseBreakdown rows={expenses} formulaTotal={formulaTotal} />
            <AttachmentPreview urls={attachments} />
            {evaluation && (
              <div className="rounded-md border-[3px] border-[#191919] bg-white p-4 shadow-[4px_4px_0_#191919]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border-2 border-[#191919] px-2 py-0.5 text-xs font-black" style={{ background: riskColor }}>
                    {evaluation.riskLevel === 'high' ? '高风险' : evaluation.riskLevel === 'medium' ? '中风险' : '低风险'}
                  </span>
                  <span className="text-sm font-black">{recommendation}</span>
                  {Number.isFinite(evaluation.confidence) && (
                    <span className="ml-auto text-[11px] font-bold text-[#191919]/45">置信度 {evaluation.confidence}%</span>
                  )}
                </div>
                {evaluationCache && (
                  <p className="mt-2 text-[10px] font-bold text-[#191919]/45">
                    {evaluationCache.cached ? '已复用缓存建议' : '本次新生成'} · {new Date(evaluationCache.cachedAt).toLocaleString('zh-CN', { hour12: false })}
                  </p>
                )}
                <p className="mt-3 text-sm font-bold leading-relaxed">{evaluation.summary}</p>
                <p className="mt-2 text-xs leading-relaxed text-[#191919]/70">{evaluation.reasoning}</p>
                {[
                  ['风险点', evaluation.riskPoints],
                  ['待补信息', evaluation.missingInformation],
                  ['人工检查', evaluation.checklist],
                ].map(([label, values]) => Array.isArray(values) && values.length ? (
                  <div key={String(label)} className="mt-3">
                    <p className="text-[10px] font-black text-[#191919]/45">{label}</p>
                    <ul className="mt-1 space-y-1 text-xs font-bold">
                      {values.map((value) => <li key={value}>· {value}</li>)}
                    </ul>
                  </div>
                ) : null)}
                <p className="mt-3 border-t border-[#191919]/15 pt-2 text-[10px] font-bold text-[#191919]/40">
                  本结果是模型辅助建议，最终决定仍需审批人结合公司制度作出。
                </p>
              </div>
            )}
            <div className="rounded-md border-[3px] border-[#191919] bg-[#F8F8F4] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="text-sm font-black">审批操作</h4>
                  <p className="text-[10px] font-bold text-[#191919]/45">通过或拒绝会直接写入飞书，提交前必须二次确认</p>
                </div>
                <span className="rounded border border-[#191919] bg-white px-1.5 py-0.5 text-[10px] font-black">高风险操作</span>
              </div>
              {selected.canOperate && selected.taskId ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button className={`${buttonClass} bg-[#9BE83A]`} onClick={() => prepareDecision('approve')} disabled={decisionBusy}>
                      <Check className="h-4 w-4" />通过
                    </button>
                    <button className={`${buttonClass} bg-[#FF8F8F]`} onClick={() => prepareDecision('reject')} disabled={decisionBusy}>
                      <X className="h-4 w-4" />拒绝
                    </button>
                  </div>
                  <textarea
                    className={`${inputClass} mt-2 min-h-16`}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="需要时再填写审批意见（选填）"
                    maxLength={1000}
                  />
                </>
              ) : (
                <p className="mt-3 rounded-md border-2 border-dashed border-[#191919]/20 bg-white p-2 text-xs font-bold text-[#191919]/55">
                  这条审批未返回可操作的 task_id，或飞书标记为不支持 API 审批，请使用“飞书中打开审批”。
                </p>
              )}
              {decisionStatus && <p className="mt-2 rounded-md border-2 border-[#191919] bg-[#EAFBD3] p-2 text-xs font-black">{decisionStatus}</p>}
              {pendingDecision && (
                <div className="mt-3 rounded-md border-2 border-[#191919] bg-[#FFFBE8] p-3">
                  <p className="text-sm font-black">
                    确认{pendingDecision === 'approve' ? '通过' : '拒绝'}「{selected.title}」？
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs font-bold text-[#191919]/65">审批意见：{comment.trim() || '未填写'}</p>
                  <div className="mt-3 flex gap-2">
                    <button className={`${buttonClass} flex-1 ${pendingDecision === 'approve' ? 'bg-[#9BE83A]' : 'bg-[#FF8F8F]'}`} onClick={submitDecision} disabled={decisionBusy}>
                      {decisionBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      确认提交
                    </button>
                    <button className={`${buttonClass} bg-white`} onClick={() => setPendingDecision(null)} disabled={decisionBusy}>取消</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function TaskForm({ editing, busy, onCancel, onSaved }: {
  editing: TaskItem | null
  busy: boolean
  onCancel: () => void
  onSaved: () => void
}) {
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [due, setDue] = useState('')
  const [assignee, setAssignee] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const createIdempotencyKey = useRef(`pet-task-${crypto.randomUUID()}`)

  useEffect(() => {
    setSummary(editing?.summary || '')
    setDescription(editing?.description || '')
    setDue(toDateTimeInput(editing?.due || null))
    setAssignee('')
    setError(null)
  }, [editing])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body = {
        summary,
        description,
        due: inputToIso(due),
        assignee,
        ...(!editing ? { idempotencyKey: createIdempotencyKey.current } : {}),
      }
      if (editing) {
        await api(`/api/workspace/tasks/${encodeURIComponent(editing.guid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        await api('/api/workspace/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setSummary('')
        setDescription('')
        setDue('')
        setAssignee('')
        createIdempotencyKey.current = `pet-task-${crypto.randomUUID()}`
      }
      onSaved()
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="rounded-md border-2 border-[#191919] bg-[#F8F8F4] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-black">{editing ? '编辑任务' : '手动创建任务'}</p>
        {editing && (
          <button type="button" onClick={onCancel} className="rounded p-1 hover:bg-black/5" title="取消编辑">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={`${inputClass} sm:col-span-2`} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="任务标题" required />
        <input className={inputClass} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="截止时间" />
        {!editing && <input className={inputClass} value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="执行人 open_id（可选）" />}
        <textarea className={`${inputClass} min-h-20 sm:col-span-2`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务描述（可选）" />
      </div>
      <ErrorNotice error={error} />
      <button className={`${buttonClass} mt-2 bg-[#9BE83A]`} disabled={saving || busy}>
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : editing ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        {saving ? '保存中' : editing ? '保存修改' : '创建任务'}
      </button>
    </form>
  )
}

function TaskTab({ items, loading, error, reload }: {
  items: TaskItem[]
  loading: boolean
  error: ApiError | null
  reload: () => void
}) {
  const [editing, setEditing] = useState<TaskItem | null>(null)
  const [completing, setCompleting] = useState('')
  const [localError, setLocalError] = useState<ApiError | null>(null)

  const complete = async (task: TaskItem) => {
    setCompleting(task.guid)
    setLocalError(null)
    try {
      await api(`/api/workspace/tasks/${encodeURIComponent(task.guid)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      reload()
    } catch (err) {
      setLocalError(err as ApiError)
    } finally {
      setCompleting('')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">我的任务</h2>
          <p className="text-[11px] font-bold text-[#191919]/45">只显示未完成任务，使用真实 GUID 修改状态</p>
        </div>
        <button className={`${buttonClass} bg-white`} onClick={reload} title="刷新任务列表">
          <RefreshCw className="h-4 w-4" />刷新
        </button>
      </div>
      <TaskForm editing={editing} busy={loading} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />
      <ErrorNotice error={error || localError} />
      {loading ? <LoadingBlock /> : items.length === 0 && !error ? <EmptyBlock text="当前没有未完成任务，可以先创建一条" /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((task) => (
            <article key={task.guid || task.summary} className="rounded-md border-2 border-[#191919] bg-white p-3 shadow-[3px_3px_0_rgba(25,25,25,0.16)]">
              <div className="flex items-start gap-2">
                <button
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 border-[#191919] bg-[#F8F8F4] hover:bg-[#9BE83A] disabled:opacity-40"
                  onClick={() => complete(task)}
                  disabled={!task.guid || completing === task.guid}
                  title="完成任务"
                >
                  {completing === task.guid ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-black">{task.summary}</p>
                  {task.description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#191919]/60">{task.description}</p>}
                </div>
                <button className="shrink-0 rounded p-1 hover:bg-[#E9F0FF] disabled:opacity-30" onClick={() => setEditing(task)} disabled={!task.guid} title="编辑任务">
                  <Pencil className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#191919]/10 pt-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#191919]/50">
                  <Clock3 className="h-3.5 w-3.5" />{formatDate(task.due)}
                </span>
                {task.url && <a className="text-[11px] font-black text-[#2B5CFF] hover:underline" href={task.url} target="_blank" rel="noreferrer">飞书中打开</a>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function CalendarForm({ editing, onCancel, onSaved }: {
  editing: CalendarItem | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [summary, setSummary] = useState('')
  const [start, setStart] = useState(defaultDateTime(60))
  const [end, setEnd] = useState(defaultDateTime(90))
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [attendees, setAttendees] = useState('')
  const [reminderMinutes, setReminderMinutes] = useState('5')
  const [meeting, setMeeting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const createIdempotencyKey = useRef(`pet-calendar-${crypto.randomUUID()}`)

  useEffect(() => {
    setSummary(editing?.summary || '')
    setStart(toDateTimeInput(editing?.start || null) || defaultDateTime(60))
    setEnd(toDateTimeInput(editing?.end || null) || defaultDateTime(90))
    setDescription(editing?.description || '')
    setLocation(editing?.location || '')
    setAttendees('')
    // 编辑时飞书不回传原提醒设置，默认「保持不变」，避免悄悄把提醒改成 5 分钟
    setReminderMinutes(editing ? '' : '5')
    setMeeting(editing?.meeting || false)
    setError(null)
  }, [editing])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body = {
        summary,
        start: inputToIso(start),
        end: inputToIso(end),
        description,
        location,
        attendees: attendees.split(',').map((item) => item.trim()).filter(Boolean),
        ...(reminderMinutes !== '' ? { reminderMinutes: Number(reminderMinutes) } : {}),
        meeting,
        ...(!editing ? { idempotencyKey: createIdempotencyKey.current } : {}),
      }
      if (editing) {
        await api(`/api/workspace/calendar/events/${encodeURIComponent(editing.eventId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        await api('/api/workspace/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setSummary('')
        setDescription('')
        setLocation('')
        setAttendees('')
        createIdempotencyKey.current = `pet-calendar-${crypto.randomUUID()}`
      }
      onSaved()
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="rounded-md border-2 border-[#191919] bg-[#F8F8F4] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-black">{editing ? '编辑日程' : '手动创建日程 / 会议'}</p>
        {editing && <button type="button" onClick={onCancel} className="rounded p-1 hover:bg-black/5" title="取消编辑"><X className="h-4 w-4" /></button>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={`${inputClass} sm:col-span-2`} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="日程标题" required />
        <label className="text-[10px] font-black text-[#191919]/55">开始时间<input className={`${inputClass} mt-1`} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
        <label className="text-[10px] font-black text-[#191919]/55">结束时间<input className={`${inputClass} mt-1`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
        <input className={inputClass} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="地点（可选）" />
        <input className={inputClass} value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="参与人 ou_ / 群 oc_，逗号分隔" disabled={Boolean(editing)} />
        <label className="text-[10px] font-black text-[#191919]/55">提前提醒<select className={`${inputClass} mt-1`} value={reminderMinutes} onChange={(e) => setReminderMinutes(e.target.value)}>{editing && <option value="">保持不变</option>}<option value="0">开始时</option><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option><option value="1440">1 天</option></select></label>
        <label className="flex min-h-[62px] cursor-pointer items-center justify-between rounded-md border-2 border-[#191919] bg-white px-3 py-2">
          <span><span className="block text-xs font-black">飞书视频会议</span><span className="text-[10px] font-bold text-[#191919]/45">自动生成会议链接</span></span>
          <input type="checkbox" className="h-5 w-5 accent-[#2B5CFF]" checked={meeting} onChange={(e) => setMeeting(e.target.checked)} />
        </label>
        <textarea className={`${inputClass} min-h-20 sm:col-span-2`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="日程说明（可选）" />
      </div>
      <ErrorNotice error={error} />
      <button className={`${buttonClass} mt-2 bg-[#2B5CFF] text-white`} disabled={saving}>
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : editing ? <Check className="h-4 w-4" /> : meeting ? <Video className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        {saving ? '保存中' : editing ? '保存修改' : meeting ? '创建会议' : '创建日程'}
      </button>
    </form>
  )
}

function CalendarTab({ items, loading, error, range, setRange, reload }: {
  items: CalendarItem[]
  loading: boolean
  error: ApiError | null
  range: { start: string; end: string }
  setRange: (range: { start: string; end: string }) => void
  reload: () => void
}) {
  const [editing, setEditing] = useState<CalendarItem | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">日程待办表</h2>
          <p className="text-[11px] font-bold text-[#191919]/45">主日历 · Asia/Shanghai</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[10px] font-black text-[#191919]/50">从<input className="ml-1 rounded-md border-2 border-[#191919] bg-white px-2 py-1.5 text-xs font-bold" type="date" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} /></label>
          <label className="text-[10px] font-black text-[#191919]/50">到<input className="ml-1 rounded-md border-2 border-[#191919] bg-white px-2 py-1.5 text-xs font-bold" type="date" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} /></label>
          <button className={`${buttonClass} bg-white`} onClick={reload} title="刷新日程"><RefreshCw className="h-4 w-4" /></button>
        </div>
      </div>
      <CalendarForm editing={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />
      <ErrorNotice error={error} />
      {loading ? <LoadingBlock /> : items.length === 0 && !error ? <EmptyBlock text="所选时间范围内没有日程" /> : (
        <div className="space-y-2.5">
          {items.map((item) => (
            <article key={item.eventId || `${item.summary}-${item.start}`} className="grid grid-cols-[72px_minmax(0,1fr)_auto] gap-3 rounded-md border-2 border-[#191919] bg-white p-3">
              <div className="border-r-2 border-[#191919]/10 pr-3 text-center">
                <p className="text-xs font-black text-[#2B5CFF]">{item.start ? new Date(item.start).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '待定'}</p>
                <p className="mt-1 text-[11px] font-bold text-[#191919]/55">{item.start ? new Date(item.start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--'}</p>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="break-words text-sm font-black">{item.summary}</p>
                  {item.meeting && <span className="inline-flex items-center gap-1 rounded border border-[#191919] bg-[#E9F0FF] px-1.5 py-0.5 text-[9px] font-black"><Video className="h-3 w-3" />会议</span>}
                </div>
                <p className="mt-1 text-[11px] font-bold text-[#191919]/50">{formatDate(item.start)} - {item.end ? new Date(item.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '待定'}{item.location ? ` · ${item.location}` : ''}</p>
                {item.description && <p className="mt-1 line-clamp-2 text-xs text-[#191919]/60">{item.description}</p>}
              </div>
              <div className="flex flex-col items-end justify-between gap-2">
                <button className="rounded p-1 hover:bg-[#E9F0FF] disabled:opacity-30" onClick={() => setEditing(item)} disabled={!item.eventId} title="编辑日程"><Pencil className="h-4 w-4" /></button>
                {item.url && <a className="whitespace-nowrap text-[10px] font-black text-[#2B5CFF] hover:underline" href={item.url} target="_blank" rel="noreferrer">飞书中打开</a>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantPanel({ tab, tasks, calendar, onExecuted }: {
  tab: TabId
  tasks: TaskItem[]
  calendar: CalendarItem[]
  onExecuted: () => void
}) {
  const examples: Record<TabId, string> = {
    approvals: '审批评估请在左侧选择具体审批后操作',
    tasks: '明天下午 6 点前完成季度复盘，描述写整理结论和行动项',
    calendar: '周三上午十点创建产品评审会议，持续一小时，提前 15 分钟提醒',
  }
  const [hasInstruction, setHasInstruction] = useState(false)
  const [plan, setPlan] = useState<AssistantPlan | null>(null)
  const [result, setResult] = useState<unknown>(null)
  const [resultAction, setResultAction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const instructionInputRef = useRef<HTMLTextAreaElement>(null)
  const planButtonRef = useRef<HTMLButtonElement>(null)
  const instructionDraftRef = useRef('')
  const hasInstructionRef = useRef(false)

  const updateInstructionDraft = (value: string) => {
    instructionDraftRef.current = value
    const nextHasInstruction = Boolean(value.trim())
    if (nextHasInstruction !== hasInstructionRef.current) {
      hasInstructionRef.current = nextHasInstruction
      setHasInstruction(nextHasInstruction)
    }
  }

  const clearInstruction = () => {
    instructionDraftRef.current = ''
    if (instructionInputRef.current) instructionInputRef.current.value = ''
    if (hasInstructionRef.current) {
      hasInstructionRef.current = false
      setHasInstruction(false)
    }
  }

  const planInstruction = async () => {
    const text = instructionDraftRef.current.trim()
    if (!text || busy || tab === 'approvals') return
    clearInstruction()
    setBusy(true)
    setError(null)
    setPlan(null)
    setResult(null)
    try {
      const context = {
        tasks: tasks.map((item) => ({
          taskGuid: item.guid,
          summary: item.summary,
          description: item.description,
          due: item.due ? new Date(item.due).toISOString() : null,
        })),
        calendar: calendar.map((item) => ({
          eventId: item.eventId,
          summary: item.summary,
          start: item.start ? new Date(item.start).toISOString() : null,
          end: item.end ? new Date(item.end).toISOString() : null,
        })),
      }
      const data = await api<{ ok: true; plan: AssistantPlan }>('/api/workspace/assistant/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: text, context }),
      })
      setPlan(data.plan)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  const execute = async () => {
    if (!plan) return
    const action = plan.action
    setBusy(true)
    setError(null)
    try {
      const data = await api<{ ok: true; data: unknown }>('/api/workspace/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, confirmed: plan.requiresConfirmation }),
      })
      setResult(data.data)
      setResultAction(action)
      setPlan(null)
      onExecuted()
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }
  const suggestedSlots = resultAction === 'calendar.suggest' && result !== null
    ? formatTimeSlots(result)
    : []
  const cancelPlan = () => {
    setPlan(null)
    requestAnimationFrame(() => planButtonRef.current?.focus())
  }

  return (
    <div className="sticker p-4">
      <div className="flex items-start gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border-2 border-[#191919] bg-[#FF8FD8]"><WandSparkles className="h-5 w-5" /></div>
        <div>
          <h2 className="text-base font-black">自然语言助手</h2>
          <p className="text-[10px] font-bold text-[#191919]/45">先生成结构化预览，再确认执行</p>
        </div>
      </div>
      <textarea ref={instructionInputRef} className={`${inputClass} mt-3 min-h-28 resize-y`} onInput={(event) => updateInstructionDraft(event.currentTarget.value)} placeholder={examples[tab]} disabled={tab === 'approvals'} maxLength={3000} />
      <button ref={planButtonRef} className={`${buttonClass} mt-2 w-full bg-[#191919] text-white`} onClick={planInstruction} disabled={busy || tab === 'approvals' || !hasInstruction}>
        {busy && !plan ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
        生成操作预览
      </button>
      <ErrorNotice error={error} />
      {plan && (
        <div className="mt-3 rounded-md border-2 border-[#191919] bg-[#FFFBE8] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="rounded border border-[#191919] bg-white px-1.5 py-0.5 text-[10px] font-black">{actionLabel(plan.action)}</span>
            {plan.requiresConfirmation && <span className="text-[10px] font-black text-[#B42318]">待确认</span>}
          </div>
          <p className="mt-2 text-sm font-black leading-relaxed">{plan.preview}</p>
          <dl className="mt-2 space-y-1 border-t border-[#191919]/15 pt-2 text-[11px]">
            {Object.entries(plan.arguments).map(([key, value]) => (
              <div key={key} className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
                <dt className="font-black text-[#191919]/45">{key}</dt>
                <dd className="break-words font-bold">{Array.isArray(value) ? value.join(', ') || '无' : String(value ?? '未设置')}</dd>
              </div>
            ))}
          </dl>
          {plan.action !== 'clarify' && (
            <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
              <button className={`${buttonClass} w-full ${plan.requiresConfirmation ? 'bg-[#FF8FD8]' : 'bg-[#9BE83A]'}`} onClick={execute} disabled={busy}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {busy ? '执行中' : plan.requiresConfirmation ? '确认并执行' : '查询候选时间'}
              </button>
              <button className={`${buttonClass} bg-white`} onClick={cancelPlan} disabled={busy} title="取消操作" aria-label="取消操作"><X className="h-4 w-4" /></button>
            </div>
          )}
        </div>
      )}
      {result !== null && (
        <div className="mt-3 rounded-md border-2 border-[#191919] bg-[#EAFBD3] p-3 text-xs font-bold">
          {resultAction === 'calendar.suggest' ? (
            suggestedSlots.length ? (
              <>
                <p className="font-black">找到 {suggestedSlots.length} 个空闲时间段：</p>
                <ul className="mt-1 space-y-1">
                  {suggestedSlots.slice(0, 8).map((slot) => <li key={slot}>· {slot}</li>)}
                </ul>
              </>
            ) : '查询完成，但所选范围内没有解析到空闲时间段。'
          ) : '操作已完成。列表正在刷新。'}
        </div>
      )}
    </div>
  )
}

function isoDateOnly(offsetDays: number) {
  const date = new Date(Date.now() + offsetDays * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export default function Workbench() {
  const [tab, setTab] = useState<TabId>('approvals')
  const [status, setStatus] = useState<WorkspaceStatus | null>(null)
  const [approvalsRaw, setApprovalsRaw] = useState<unknown>(null)
  const [tasksRaw, setTasksRaw] = useState<unknown>(null)
  const [calendarRaw, setCalendarRaw] = useState<unknown>(null)
  const [loading, setLoading] = useState<Record<TabId, boolean>>({ approvals: true, tasks: true, calendar: true })
  const [errors, setErrors] = useState<Record<TabId, ApiError | null>>({ approvals: null, tasks: null, calendar: null })
  const [range, setRange] = useState({ start: isoDateOnly(0), end: isoDateOnly(7) })

  const loadStatus = useCallback(() => {
    api<{ ok: true; status: WorkspaceStatus }>('/api/workspace/status')
      .then((data) => setStatus(data.status))
      .catch(() => setStatus({ cliInstalled: false, userAvailable: false }))
  }, [])

  const loadApprovals = useCallback(async () => {
    setLoading((old) => ({ ...old, approvals: true }))
    try {
      const data = await api<{ ok: true; data: unknown }>('/api/workspace/approvals')
      setApprovalsRaw(data.data)
      setErrors((old) => ({ ...old, approvals: null }))
    } catch (err) {
      setErrors((old) => ({ ...old, approvals: err as ApiError }))
    } finally {
      setLoading((old) => ({ ...old, approvals: false }))
    }
  }, [])

  const loadTasks = useCallback(async () => {
    setLoading((old) => ({ ...old, tasks: true }))
    try {
      const data = await api<{ ok: true; data: unknown }>('/api/workspace/tasks')
      setTasksRaw(data.data)
      setErrors((old) => ({ ...old, tasks: null }))
    } catch (err) {
      setErrors((old) => ({ ...old, tasks: err as ApiError }))
    } finally {
      setLoading((old) => ({ ...old, tasks: false }))
    }
  }, [])

  const loadCalendar = useCallback(async () => {
    setLoading((old) => ({ ...old, calendar: true }))
    try {
      const start = `${range.start}T00:00:00+08:00`
      const end = `${range.end}T23:59:59+08:00`
      const data = await api<{ ok: true; data: unknown }>(`/api/workspace/calendar/agenda?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
      setCalendarRaw(data.data)
      setErrors((old) => ({ ...old, calendar: null }))
    } catch (err) {
      setErrors((old) => ({ ...old, calendar: err as ApiError }))
    } finally {
      setLoading((old) => ({ ...old, calendar: false }))
    }
  }, [range])

  useEffect(() => {
    loadStatus()
    loadApprovals()
    loadTasks()
  }, [loadStatus, loadApprovals, loadTasks])

  useEffect(() => {
    loadCalendar()
  }, [loadCalendar])

  const approvals = useMemo(() => normalizeApprovals(approvalsRaw), [approvalsRaw])
  const tasks = useMemo(() => normalizeTasks(tasksRaw), [tasksRaw])
  const calendar = useMemo(() => normalizeCalendar(calendarRaw), [calendarRaw])
  const refreshAll = () => {
    loadApprovals()
    loadTasks()
    loadCalendar()
  }

  const tabs: { id: TabId; label: string; icon: typeof FileCheck2; count: number }[] = [
    { id: 'approvals', label: '审批', icon: FileCheck2, count: approvals.length },
    { id: 'tasks', label: '任务', icon: ListTodo, count: tasks.length },
    { id: 'calendar', label: '日程', icon: CalendarDays, count: calendar.length },
  ]

  return (
    <div className="grid-paper min-h-screen font-sans text-[#191919]">
      <header className="bg-[#191919] text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border-2 border-white/35 hover:border-white" title="返回宠物看板"><ArrowLeft className="h-5 w-5" /></Link>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-black">飞书工作台<span className="text-[#9BE83A]">·</span>小绝</h1>
              <p className="text-[10px] font-bold text-white/45">审批判断、任务管理与日程安排</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-md border-2 px-2.5 py-1 text-[11px] font-black ${status?.ready ? 'border-[#9BE83A] text-[#9BE83A]' : 'border-[#FFD60A] text-[#FFD60A]'}`}>
              <span className={`h-2 w-2 rounded-full ${status?.ready ? 'bg-[#9BE83A]' : 'bg-[#FFD60A]'}`} />
              {status?.ready ? '飞书权限已就绪' : status?.userAvailable ? '权限待补充' : '需要用户授权'}
            </span>
            {status?.version && <span className="hidden text-[10px] font-bold text-white/35 sm:inline">CLI {status.version}</span>}
          </div>
        </div>
      </header>
      <AuthBanner status={status} />

      <nav className="border-b-[3px] border-[#191919] bg-white">
        <div className="mx-auto flex max-w-7xl gap-1 px-5 pt-2">
          {tabs.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} onClick={() => setTab(item.id)} className={`flex min-w-28 items-center justify-center gap-2 border-x-2 border-t-2 border-[#191919] px-4 py-2.5 text-sm font-black transition-colors ${tab === item.id ? 'translate-y-[3px] bg-[#9BE83A]' : 'bg-[#F8F8F4] hover:bg-[#E9F0FF]'}`}>
                <Icon className="h-4 w-4" />{item.label}
                <span className="rounded bg-[#191919] px-1.5 py-0.5 text-[9px] text-white">{item.count}</span>
              </button>
            )
          })}
        </div>
      </nav>

      <main className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="sticker min-w-0 p-4 sm:p-5">
          {tab === 'approvals' && <ApprovalTab items={approvals} loading={loading.approvals} error={errors.approvals} reload={loadApprovals} />}
          {tab === 'tasks' && <TaskTab items={tasks} loading={loading.tasks} error={errors.tasks} reload={loadTasks} />}
          {tab === 'calendar' && <CalendarTab items={calendar} loading={loading.calendar} error={errors.calendar} range={range} setRange={setRange} reload={loadCalendar} />}
        </section>
        <aside className="flex min-w-0 flex-col gap-5">
          <AssistantPanel tab={tab} tasks={tasks} calendar={calendar} onExecuted={refreshAll} />
          <LlmSettings />
          <div className="rounded-md border-2 border-[#191919] bg-white p-3">
            <div className="flex items-start gap-2">
              <Users className="mt-0.5 h-4 w-4 shrink-0 text-[#2B5CFF]" />
              <p className="text-[11px] font-bold leading-relaxed text-[#191919]/60">
                工作台固定使用飞书用户身份。大模型只生成受限动作计划，创建、修改和完成操作都需要你在预览卡片再次确认。
              </p>
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}
