import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CalendarDays,
  ChevronDown,
  ExternalLink,
  FileCheck2,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  TriangleAlert,
} from 'lucide-react'
import { PetStage } from '@/pet/PetStage'
import { usePetChannel } from '@/hooks/use-pet-channel'
import {
  ApiError,
  normalizeApprovals,
  normalizeCalendar,
  normalizeTasks,
  workspaceApi,
  type ApprovalItem,
  type CalendarItem,
  type TaskItem,
} from '@/lib/workspace'
import { STATE_META } from '@/types/pet'
import type { PetForm, SkinId } from '@/pet/skins'
import './index.css'

declare global {
  interface Window {
    petAPI?: {
      dragStart: () => void
      dragMove: () => void
      dragEnd: () => void
      openMenu: () => void
      onInteract: (cb: (kind: 'pat' | 'feed') => void) => void
      onScale: (cb: (scale: number) => void) => void
      onSkin: (cb: (v: { skin: SkinId; form: PetForm }) => void) => void
      skinChanged: (v: { skin: SkinId; form: PetForm }) => void
      onShowIntro: (cb: () => void) => void
      hitMask: (m: {
        w: number
        h: number
        scale: number
        data: Uint8Array
        bubble?: { x: number; y: number; w: number; h: number } | null
        regions?: { x: number; y: number; w: number; h: number }[]
      }) => void
      openChat: (chatId: string) => void
      openAssistant: () => void
      closeAssistant: () => void
      resizeAssistant: (expanded: boolean) => void
      openWorkbench: () => void
      openApproval: (approval: {
        definitionCode: string
        instanceCode: string
        taskId: string
      }) => void
      openWorkbenchApproval: (instanceCode: string) => void
      resizePetOverview: (expanded: boolean) => void
      loadPetOverview: (range: { start: string; end: string }) => Promise<{
        tasks: { ok: boolean; data?: unknown; error?: string }
        approvals: { ok: boolean; data?: unknown; error?: string }
        calendar: { ok: boolean; data?: unknown; error?: string }
      }>
    }
  }
}

const INTRO_TEXT =
  '我叫小绝 🐾 诞生于 2026 年 7 月 25 日 · 飞书绝活大会北京场。bot 干活我伴舞，飞书来消息我冒泡，右键换皮肤、点我派绝活，摸我冒爱心～'

const HOVER_OPEN_DELAY = 250
const HOVER_CLOSE_DELAY = 420
const OVERVIEW_TTL = 60_000
const UPCOMING_CALENDAR_DAYS = 30
const OVERVIEW_PREVIEW_COUNT = 2

type OverviewKind = 'tasks' | 'approvals' | 'calendar'
type OverviewData = {
  tasks: TaskItem[]
  approvals: ApprovalItem[]
  calendar: CalendarItem[]
}
type OverviewErrors = Record<OverviewKind, string>

const EMPTY_OVERVIEW: OverviewData = { tasks: [], approvals: [], calendar: [] }
const EMPTY_OVERVIEW_ERRORS: OverviewErrors = { tasks: '', approvals: '', calendar: '' }
let overviewCache: { at: number; data: OverviewData; errors: OverviewErrors } | null = null
let overviewRequest: Promise<{ data: OverviewData; errors: OverviewErrors }> | null = null

function localDateTime(value: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  const offsetMinutes = -value.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
  return `${day}T${time}${offset}`
}

function upcomingCalendarRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + UPCOMING_CALENDAR_DAYS)
  end.setHours(23, 59, 59, 0)
  return {
    start: localDateTime(start),
    end: localDateTime(end),
  }
}

function compactTime(value: number | null, fallback: string) {
  if (!value) return fallback
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function isSameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
}

function isAllDayCalendarItem(item: CalendarItem) {
  const rawStart = item.raw.start_time
  return item.raw.is_all_day === true || Boolean(
    rawStart && typeof rawStart === 'object' &&
    'date' in rawStart && !('timestamp' in rawStart),
  )
}

function compactCalendarTime(item: CalendarItem, now = new Date()) {
  if (!item.start) return '全天'
  const start = new Date(item.start)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = isSameLocalDay(start, now)
    ? ''
    : isSameLocalDay(start, tomorrow)
      ? '明天 '
      : `${start.getMonth() + 1}月${start.getDate()}日 `
  if (isAllDayCalendarItem(item)) return `${day}全天`.trim()
  if (item.end && item.start <= now.getTime() && item.end > now.getTime()) return '进行中'
  return `${day}${compactTime(item.start, '')}`.trim()
}

function overviewError(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return '暂时没取到数据'
}

async function requestOverview() {
  if (overviewRequest) return overviewRequest
  overviewRequest = (async () => {
    const range = upcomingCalendarRange()
    const previous = overviewCache?.data ?? EMPTY_OVERVIEW
    const data: OverviewData = {
      tasks: [...previous.tasks],
      approvals: [...previous.approvals],
      calendar: [...previous.calendar],
    }
    const errors: OverviewErrors = { ...EMPTY_OVERVIEW_ERRORS }
    if (window.petAPI?.loadPetOverview) {
      const result = await window.petAPI.loadPetOverview(range)
      if (result.approvals.ok) data.approvals = normalizeApprovals(result.approvals.data)
      else errors.approvals = result.approvals.error || '暂时没取到审批'
      if (result.tasks.ok) data.tasks = normalizeTasks(result.tasks.data)
      else errors.tasks = result.tasks.error || '暂时没取到待办'
      if (result.calendar.ok) data.calendar = normalizeCalendar(result.calendar.data)
      else errors.calendar = result.calendar.error || '暂时没取到日程'
    } else {
      const [approvalResult, taskResult, calendarResult] = await Promise.allSettled([
        workspaceApi<{ ok: true; data: unknown }>('/api/workspace/approvals'),
        workspaceApi<{ ok: true; data: unknown }>('/api/workspace/tasks'),
        workspaceApi<{ ok: true; data: unknown }>(
          `/api/workspace/calendar/agenda?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`,
        ),
      ])
      if (approvalResult.status === 'fulfilled') {
        data.approvals = normalizeApprovals(approvalResult.value.data)
      } else {
        errors.approvals = overviewError(approvalResult.reason)
      }
      if (taskResult.status === 'fulfilled') {
        data.tasks = normalizeTasks(taskResult.value.data)
      } else {
        errors.tasks = overviewError(taskResult.reason)
      }
      if (calendarResult.status === 'fulfilled') {
        data.calendar = normalizeCalendar(calendarResult.value.data)
      } else {
        errors.calendar = overviewError(calendarResult.reason)
      }
    }

    data.tasks = data.tasks.filter((item) => (
      !['completed', 'complete', 'done', 'closed'].includes(item.status.toLowerCase())
    ))
    const now = Date.now()
    data.calendar = data.calendar.filter((item) => {
      const status = String(item.raw.status ?? '').toLowerCase()
      const rsvp = String(item.raw.self_rsvp_status ?? '').toLowerCase()
      if (['cancelled', 'canceled'].includes(status)) return false
      if (['decline', 'declined', 'removed'].includes(rsvp)) return false
      const relevantTime = item.end ?? item.start
      return relevantTime !== null && relevantTime >= now
    })

    data.tasks.sort((left, right) => (
      (left.due ?? Number.POSITIVE_INFINITY) - (right.due ?? Number.POSITIVE_INFINITY) ||
      left.summary.localeCompare(right.summary, 'zh-CN')
    ))
    data.calendar.sort((left, right) => (
      (left.start ?? Number.POSITIVE_INFINITY) - (right.start ?? Number.POSITIVE_INFINITY)
    ))
    const result = { data, errors }
    overviewCache = { at: Date.now(), ...result }
    return result
  })().finally(() => {
    overviewRequest = null
  })
  return overviewRequest
}

type OverviewRow = { key: string; title: string; meta: string }

function OverviewSection({
  kind,
  label,
  count,
  icon,
  accent,
  rows,
  expanded,
  onToggle,
  loading,
  error,
  empty,
}: {
  kind: OverviewKind
  label: string
  count: number
  icon: ReactNode
  accent: string
  rows: OverviewRow[]
  expanded: boolean
  onToggle: () => void
  loading: boolean
  error: string
  empty: string
}) {
  const canToggle = rows.length > OVERVIEW_PREVIEW_COUNT
  const visibleRows = expanded ? rows : rows.slice(0, OVERVIEW_PREVIEW_COUNT)
  return (
    <section className="border-t-2 border-[#191919]/15 px-3 py-2 first:border-t-0">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border-2 border-[#191919]" style={{ background: accent }}>
          {icon}
        </span>
        <h3 className="text-xs font-black text-[#191919]">{label}</h3>
        <span className="ml-auto min-w-5 rounded border-2 border-[#191919] bg-white px-1 text-center text-[10px] font-black leading-4 text-[#191919]">
          {count}
        </span>
        {canToggle && (
          <button
            type="button"
            onClick={onToggle}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 border-[#191919] bg-white transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B5CFF] focus-visible:ring-offset-1 active:scale-95"
            title={expanded ? `收起${label}` : `展开${label}`}
            aria-label={expanded ? `收起${label}` : `展开${label}`}
            aria-expanded={expanded}
            aria-controls={`pet-overview-${kind}-items`}
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      <div id={`pet-overview-${kind}-items`}>
        {loading && visibleRows.length === 0 ? (
          <div className="space-y-1.5 py-0.5" aria-label={`${label}加载中`}>
            <div className="h-3 w-4/5 animate-pulse rounded-sm bg-[#191919]/10" />
            <div className="h-3 w-3/5 animate-pulse rounded-sm bg-[#191919]/10" />
          </div>
        ) : error && visibleRows.length === 0 ? (
          <p className="flex items-center gap-1 py-1 text-[10px] font-bold text-[#B42318]" title={error}>
            <TriangleAlert className="h-3 w-3 shrink-0" />
            <span className="truncate">{error}</span>
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="py-1 text-[10px] font-bold text-[#191919]/45">{empty}</p>
        ) : (
          <ul className="space-y-1">
            {visibleRows.map((row) => (
              <li key={row.key} className="flex min-w-0 items-baseline gap-2 text-[11px] leading-4">
                <span className="truncate font-extrabold text-[#191919]">{row.title}</span>
                <span className="ml-auto shrink-0 text-[9px] font-bold text-[#191919]/45">{row.meta}</span>
              </li>
            ))}
          </ul>
        )}
        {error && rows.length > 0 && (
          <p className="mt-1 truncate text-[9px] font-bold text-[#B42318]" title={error}>刷新失败 · 正在显示上次结果</p>
        )}
      </div>
    </section>
  )
}

export function PetWindow() {
  const { current, stateSince, interact, bumpInteract } = usePetChannel()
  const meta = STATE_META[current.state]
  const [now, setNow] = useState(Date.now())
  const [scale, setScale] = useState(0.4)
  const [skin, setSkin] = useState<SkinId>(
    () => (localStorage.getItem('pet-skin') as SkinId) || 'pixel',
  )
  const [form, setForm] = useState<PetForm>(
    () => (localStorage.getItem('pet-form') as PetForm) || 'adult',
  )
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overviewRef = useRef<HTMLElement | null>(null)
  const [introUntil, setIntroUntil] = useState(0)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [overviewData, setOverviewData] = useState<OverviewData>(
    () => overviewCache?.data ?? EMPTY_OVERVIEW,
  )
  const [overviewErrors, setOverviewErrors] = useState<OverviewErrors>(
    () => overviewCache?.errors ?? EMPTY_OVERVIEW_ERRORS,
  )
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Record<OverviewKind, boolean>>({
    tasks: false,
    approvals: false,
    calendar: false,
  })
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => {
      clearInterval(t)
      if (clickTimer.current) clearTimeout(clickTimer.current)
      if (hoverOpenTimer.current) clearTimeout(hoverOpenTimer.current)
      if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current)
    }
  }, [])

  const loadOverview = useCallback(async () => {
    if (overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL) {
      setOverviewData(overviewCache.data)
      setOverviewErrors(overviewCache.errors)
      return
    }
    setOverviewLoading(true)
    try {
      const result = await requestOverview()
      setOverviewData(result.data)
      setOverviewErrors(result.errors)
    } catch (error) {
      const message = overviewError(error)
      setOverviewErrors({ tasks: message, approvals: message, calendar: message })
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const cancelHoverTimers = useCallback(() => {
    if (hoverOpenTimer.current) {
      clearTimeout(hoverOpenTimer.current)
      hoverOpenTimer.current = null
    }
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current)
      hoverCloseTimer.current = null
    }
  }, [])

  const closeOverview = useCallback(() => {
    cancelHoverTimers()
    setOverviewOpen(false)
    window.petAPI?.resizePetOverview?.(false)
  }, [cancelHoverTimers])

  const toggleOverviewSection = useCallback((kind: OverviewKind) => {
    setExpandedSections((current) => ({ ...current, [kind]: !current[kind] }))
  }, [])

  const scheduleOverviewOpen = useCallback(() => {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current)
      hoverCloseTimer.current = null
    }
    if (overviewOpen || hoverOpenTimer.current) return
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = null
      setOverviewOpen(true)
      window.petAPI?.resizePetOverview?.(true)
      void loadOverview()
    }, HOVER_OPEN_DELAY)
  }, [loadOverview, overviewOpen])

  const scheduleOverviewClose = useCallback(() => {
    if (hoverOpenTimer.current) {
      clearTimeout(hoverOpenTimer.current)
      hoverOpenTimer.current = null
    }
    if (!overviewOpen || hoverCloseTimer.current) return
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null
      if (overviewRef.current?.contains(document.activeElement)) return
      setOverviewOpen(false)
      window.petAPI?.resizePetOverview?.(false)
    }, HOVER_CLOSE_DELAY)
  }, [overviewOpen])

  // 自我介绍（托盘/右键菜单触发）：气泡展示 9 秒
  useEffect(() => {
    window.petAPI?.onShowIntro(() => setIntroUntil(Date.now() + 9000))
  }, [])

  // 像素级点击穿透：定期把画布的 alpha 遮罩上报给主进程
  useEffect(() => {
    const off = document.createElement('canvas')
    off.width = 66
    off.height = 66
    const octx = off.getContext('2d', { willReadFrequently: true })
    if (!octx) return
    const t = setInterval(() => {
      const c = document.querySelector<HTMLCanvasElement>('.pet-canvas')
      if (!c || !window.petAPI?.hitMask) return
      octx.clearRect(0, 0, 66, 66)
      octx.drawImage(c, 0, 0, 66, 66)
      const d = octx.getImageData(0, 0, 66, 66).data
      const mask = new Uint8Array(66 * 66)
      for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 40 ? 1 : 0
      // 可交互浮层一并上报，避免透明窗口的像素级穿透吃掉面板点击
      let bubble: { x: number; y: number; w: number; h: number } | null = null
      const b = document.getElementById('pet-bubble-click')
      if (b) {
        const r = b.getBoundingClientRect()
        bubble = { x: r.x, y: r.y, w: r.width, h: r.height }
      }
      const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-pet-hit-region]'))
        .map((element) => {
          const r = element.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        .filter((region) => region.w > 0 && region.h > 0)
      window.petAPI.hitMask({
        w: 66,
        h: 66,
        scale: scaleRef.current,
        data: mask,
        bubble,
        regions,
      })
    }, 150)
    return () => clearInterval(t)
  }, [])

  // 主进程转发的互动（托盘/右键菜单触发）与体型切换
  useEffect(() => {
    window.petAPI?.onInteract((kind) => bumpInteract(kind))
    window.petAPI?.onScale((s) => setScale(s))
    window.petAPI?.onSkin((v) => {
      setSkin(v.skin)
      setForm(v.form)
      localStorage.setItem('pet-skin', v.skin)
      localStorage.setItem('pet-form', v.form)
    })
  }, [bumpInteract])

  // 启动时把持久化的皮肤同步给主进程（菜单勾选状态）
  useEffect(() => {
    window.petAPI?.skinChanged({ skin, form })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 未读消息：带 chatId 的消息提醒会挂着不消失，直到点气泡跳过去看
  const [unread, setUnread] = useState<{ n: number; chatId?: string; label: string }>({
    n: 0,
    label: '',
  })
  const seenMsgTs = useRef(0)
  useEffect(() => {
    const ev = current
    if (!ev.chatId) return
    if (['system', 'auto', 'demo', 'local', 'menu'].includes(ev.source ?? '')) return
    if (ev.ts <= seenMsgTs.current) return
    seenMsgTs.current = ev.ts
    // 重启补投的旧消息（5 分钟前）不计未读，免得一开机就挂着气泡
    if (Date.now() - ev.ts > 5 * 60_000) return
    setUnread((u) => ({ n: u.n + 1, chatId: ev.chatId, label: ev.label ?? '' }))
  }, [current])

  const clearUnread = useRef(() => {})
  clearUnread.current = () => setUnread({ n: 0, label: '' })

  // 气泡：未读消息常驻直到点掉；普通状态事件 30 秒内可见；小体型时同步缩小避免超出窗口
  const introActive = now < introUntil
  const hasUnread = unread.n > 0
  const bubbleVisible =
    introActive || hasUnread || (Boolean(current.label) && now - current.ts < 30000)
  const bubbleScale = Math.min(1, Math.max(0.75, scale / 0.8))
  const bubbleBadge = introActive ? '自我介绍' : hasUnread ? `新消息 x${unread.n}` : meta.name
  const bubbleBadgeBg = introActive ? '#FF9EC6' : hasUnread ? '#FF4D4F' : meta.color
  const bubbleBadgeColor = introActive || hasUnread ? '#191919' : meta.textColor
  const bubbleText = introActive ? INTRO_TEXT : hasUnread ? unread.label : current.label
  // 消息类气泡可点击跳转飞书会话（自我介绍不可点）
  const bubbleClickable = !introActive && (hasUnread || Boolean(current.chatId))
  const bubbleChatId = hasUnread ? unread.chatId : current.chatId

  const onBubbleClick = () => {
    if (!bubbleClickable) return
    const chatId = bubbleChatId
    clearUnread.current()
    if (chatId) window.petAPI?.openChat(chatId)
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    closeOverview()
    drag.current = { x: e.screenX, y: e.screenY, moved: false }
    window.petAPI?.dragStart()
    const move = (ev: MouseEvent) => {
      if (!drag.current) return
      if (
        Math.abs(ev.screenX - drag.current.x) + Math.abs(ev.screenY - drag.current.y) >
        6
      ) {
        drag.current.moved = true
      }
      if (drag.current.moved) window.petAPI?.dragMove()
    }
    const up = () => {
      if (drag.current && !drag.current.moved) {
        if (clickTimer.current) {
          clearTimeout(clickTimer.current)
          clickTimer.current = null
          window.petAPI?.openAssistant()
        } else {
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null
            bumpInteract('pat')
          }, 240)
        }
      }
      drag.current = null
      window.petAPI?.dragEnd()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const taskRows = useMemo<OverviewRow[]>(() => overviewData.tasks.map((item) => ({
    key: item.guid || item.summary,
    title: item.summary,
    meta: compactTime(item.due, '无期限'),
  })), [overviewData.tasks])
  const approvalRows = useMemo<OverviewRow[]>(() => overviewData.approvals.map((item) => ({
    key: item.taskId || item.instanceCode || item.title,
    title: item.title,
    meta: item.initiator || '待处理',
  })), [overviewData.approvals])
  const calendarRows = useMemo<OverviewRow[]>(() => overviewData.calendar.map((item) => ({
    key: item.eventId || `${item.summary}-${item.start}`,
    title: item.summary,
    meta: compactCalendarTime(item),
  })), [overviewData.calendar])
  const todayLabel = new Date(now).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })

  const openAssistantFromOverview = () => {
    closeOverview()
    window.petAPI?.openAssistant()
  }

  const openWorkbenchFromOverview = () => {
    closeOverview()
    window.petAPI?.openWorkbench()
  }

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden">
      {overviewOpen && (
        <aside
          ref={overviewRef}
          data-pet-hit-region
          data-pet-overview
          onMouseEnter={scheduleOverviewOpen}
          onMouseLeave={scheduleOverviewClose}
          onFocusCapture={cancelHoverTimers}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              scheduleOverviewClose()
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeOverview()
          }}
          className="pet-hover-overview absolute bottom-3 z-20 w-[318px] overflow-hidden rounded-xl border-[3px] border-[#191919] bg-[#FFFDF8] text-[#191919] shadow-[6px_6px_0_#191919]"
          style={{ right: `${Math.round(18 + 264 * scale)}px`, maxHeight: 'calc(100vh - 24px)' }}
          aria-label="工作概览"
        >
          <header className="flex items-center gap-2 border-b-[3px] border-[#191919] bg-[#CFE1FF] px-3 py-2">
            <div className="min-w-0">
              <h2 className="text-sm font-black leading-4">工作一览</h2>
              <p className="mt-0.5 text-[9px] font-bold text-[#191919]/55">{todayLabel}</p>
            </div>
            {overviewLoading && <LoaderCircle className="ml-auto h-4 w-4 animate-spin" aria-label="刷新中" />}
            <button
              type="button"
              onClick={openAssistantFromOverview}
              className={`${overviewLoading ? '' : 'ml-auto'} flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 border-[#191919] bg-white transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B5CFF] focus-visible:ring-offset-1 active:scale-95`}
              title="打开小绝助手"
              aria-label="打开小绝助手"
            >
              <MessageCircle className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={openWorkbenchFromOverview}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 border-[#191919] bg-[#9BE83A] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B5CFF] focus-visible:ring-offset-1 active:scale-95"
              title="打开飞书工作台"
              aria-label="打开飞书工作台"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          </header>
          <div className="max-h-[310px] overflow-y-auto">
            <OverviewSection
              kind="tasks"
              label="待办"
              count={overviewData.tasks.length}
              icon={<ListTodo className="h-3.5 w-3.5" />}
              accent="#FFE878"
              rows={taskRows}
              expanded={expandedSections.tasks}
              onToggle={() => toggleOverviewSection('tasks')}
              loading={overviewLoading}
              error={overviewErrors.tasks}
              empty="待办已经清空"
            />
            <OverviewSection
              kind="approvals"
              label="待审批"
              count={overviewData.approvals.length}
              icon={<FileCheck2 className="h-3.5 w-3.5" />}
              accent="#FFB7D2"
              rows={approvalRows}
              expanded={expandedSections.approvals}
              onToggle={() => toggleOverviewSection('approvals')}
              loading={overviewLoading}
              error={overviewErrors.approvals}
              empty="当前没有待审批"
            />
            <OverviewSection
              kind="calendar"
              label="近期日程"
              count={overviewData.calendar.length}
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              accent="#9BE83A"
              rows={calendarRows}
              expanded={expandedSections.calendar}
              onToggle={() => toggleOverviewSection('calendar')}
              loading={overviewLoading}
              error={overviewErrors.calendar}
              empty="近期没有日程"
            />
          </div>
        </aside>
      )}

      {/* 气泡台词（贴纸风，自动隐藏）：锚右对齐宠物，可向左舒展 */}
      <div
        className={`pointer-events-none absolute right-2 top-1 z-10 transition-all duration-300 ${
          bubbleVisible ? 'opacity-100' : '-translate-y-2 opacity-0'
        }`}
        style={{
          transform: `scale(${bubbleScale})`,
          transformOrigin: 'top right',
        }}
      >
        <div
          id={bubbleClickable ? 'pet-bubble-click' : undefined}
          data-pet-hit-region={bubbleClickable ? '' : undefined}
          onClick={onBubbleClick}
          title={bubbleClickable ? '点击跳转到飞书会话' : undefined}
          className={`relative rounded-2xl border-[3px] border-[#191919] bg-white px-3 py-2 shadow-[4px_4px_0_#191919] ${
            bubbleClickable ? 'pointer-events-auto cursor-pointer hover:bg-[#F0F5FF]' : ''
          }`}
          style={{ maxWidth: 'calc(100vw - 16px)' }}
        >
          <div
            className="absolute -top-2.5 right-3 rounded border-2 border-[#191919] px-1.5 text-[10px] font-black"
            style={{ background: bubbleBadgeBg, color: bubbleBadgeColor }}
          >
            {bubbleBadge}
          </div>
          <p className="pt-1 text-left text-xs font-bold leading-snug text-[#191919]">
            {bubbleText}
            {bubbleClickable && <span className="text-[#2B5CFF]"> ↗</span>}
          </p>
          <div className="absolute -bottom-[9px] right-6 h-3.5 w-3.5 rotate-45 border-b-[3px] border-r-[3px] border-[#191919] bg-white" />
        </div>
      </div>

      {/* 宠物本体锚定右下：按住拖动，单击摸头，右键菜单 */}
      <div
        onMouseDown={onMouseDown}
        onMouseEnter={scheduleOverviewOpen}
        onMouseLeave={scheduleOverviewClose}
        onDoubleClick={(event) => {
          event.preventDefault()
          if (clickTimer.current) {
            clearTimeout(clickTimer.current)
            clickTimer.current = null
          }
          window.petAPI?.openAssistant()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          window.petAPI?.openMenu()
        }}
        className="absolute bottom-2 right-2 cursor-grab active:cursor-grabbing"
        title="单击摸头，双击打开小绝助手"
      >
        <PetStage
          state={current.state}
          stateSince={stateSince}
          interact={interact}
          scale={scale}
          skin={skin}
          form={form}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<PetWindow />)
