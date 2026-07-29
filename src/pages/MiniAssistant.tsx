import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  ExternalLink,
  FileCheck2,
  ListTodo,
  LoaderCircle,
  Save,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { PetStage } from '@/pet/PetStage'
import {
  ApiError,
  formatDate,
  formatTimeSlots,
  normalizeApprovals,
  normalizeCalendar,
  normalizeTasks,
  workspaceApi,
  type ApprovalItem,
  type AssistantPlan,
  type CalendarItem,
  type TaskItem,
} from '@/lib/workspace'

type OverviewTab = 'tasks' | 'approvals' | 'calendar'
type ChatMessage = { id: number; role: 'assistant' | 'user'; text: string; success?: boolean }
type CloseChoice = 'preserve' | 'clear'

const ASSISTANT_CONTEXT_KEY = 'feishu-pet-assistant-context-v1'
const ASSISTANT_CLOSE_PREFERENCE_KEY = 'feishu-pet-assistant-close-preference-v1'
const DEFAULT_MESSAGES: ChatMessage[] = [
  { id: 1, role: 'assistant', text: '今天想让我处理什么？' },
]

interface CachedAssistantContext {
  messages: ChatMessage[]
  instruction: string
  expanded: boolean
  overviewTab: OverviewTab
}

function localDayKey(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function loadDailyCloseChoice(): CloseChoice | null {
  try {
    const raw = localStorage.getItem(ASSISTANT_CLOSE_PREFERENCE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { date?: unknown; choice?: unknown }
    if (
      parsed.date === localDayKey() &&
      (parsed.choice === 'preserve' || parsed.choice === 'clear')
    ) return parsed.choice
    localStorage.removeItem(ASSISTANT_CLOSE_PREFERENCE_KEY)
  } catch {
    /* 无效或不可用的偏好按未设置处理 */
  }
  return null
}

function saveDailyCloseChoice(choice: CloseChoice) {
  localStorage.setItem(ASSISTANT_CLOSE_PREFERENCE_KEY, JSON.stringify({
    date: localDayKey(),
    choice,
  }))
}

function loadAssistantContext(): CachedAssistantContext {
  const fallback = {
    messages: DEFAULT_MESSAGES,
    instruction: '',
    expanded: false,
    overviewTab: 'tasks' as OverviewTab,
  }
  try {
    const raw = localStorage.getItem(ASSISTANT_CONTEXT_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<CachedAssistantContext>
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter((item): item is ChatMessage => (
          item &&
          Number.isFinite(item.id) &&
          ['assistant', 'user'].includes(item.role) &&
          typeof item.text === 'string'
        )).slice(-12)
      : []
    return {
      messages: messages.length ? messages : DEFAULT_MESSAGES,
      instruction: typeof parsed.instruction === 'string' ? parsed.instruction.slice(0, 3000) : '',
      expanded: parsed.expanded === true,
      overviewTab: ['tasks', 'approvals', 'calendar'].includes(parsed.overviewTab || '')
        ? parsed.overviewTab as OverviewTab
        : 'tasks',
    }
  } catch {
    return fallback
  }
}

function todayRange() {
  const day = localDayKey()
  return {
    start: `${day}T00:00:00+08:00`,
    end: `${day}T23:59:59+08:00`,
  }
}

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    'task.create': '创建任务',
    'task.update': '修改任务',
    'task.complete': '完成任务',
    'approval.approve': '通过审批',
    'approval.reject': '拒绝审批',
    'calendar.create': '创建日程',
    'calendar.update': '修改日程',
    'calendar.suggest': '查找空闲时间',
    clarify: '需要补充',
  }
  return labels[action] || action
}

function ErrorLine({ error }: { error: ApiError | null }) {
  if (!error) return null
  return (
    <div className="mx-4 mb-3 rounded-md border-2 border-[#B42318] bg-[#FFF0EF] px-3 py-2 text-xs font-bold text-[#8A1C1C]">
      <p>{error.message}</p>
      {error.hint && <p className="mt-1 opacity-65">{error.hint}</p>}
    </div>
  )
}

const AssistantPet = memo(function AssistantPet() {
  return <PetStage state="idle" stateSince={0} interact={{ kind: 'pat', n: 0 }} scale={1} />
})

export default function MiniAssistant() {
  const [restoredContext] = useState(loadAssistantContext)
  const [expanded, setExpanded] = useState(restoredContext.expanded)
  const [overviewTab, setOverviewTab] = useState<OverviewTab>(restoredContext.overviewTab)
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [calendar, setCalendar] = useState<CalendarItem[]>([])
  const [expandedApproval, setExpandedApproval] = useState<string | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [hasInstruction, setHasInstruction] = useState(Boolean(restoredContext.instruction.trim()))
  const [plan, setPlan] = useState<AssistantPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(restoredContext.messages)
  const [closePrompt, setClosePrompt] = useState(false)
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false)
  const [pendingTaskCompletion, setPendingTaskCompletion] = useState('')
  const [completingTask, setCompletingTask] = useState('')
  const operationBusy = busy || Boolean(completingTask)
  const hasInlineConfirmation = Boolean(pendingTaskCompletion)
  const nextMessageId = useRef(Math.max(1, ...restoredContext.messages.map((item) => item.id)) + 1)
  const overviewRequestId = useRef(0)
  const overviewToggleRef = useRef<HTMLButtonElement>(null)
  const taskCompletionRefs = useRef(new Map<string, HTMLButtonElement>())
  const assistantShellRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const closeDialogRef = useRef<HTMLElement>(null)
  const closePromptWasOpen = useRef(false)
  const instructionInputRef = useRef<HTMLTextAreaElement>(null)
  const instructionDraftRef = useRef(restoredContext.instruction)
  const hasInstructionRef = useRef(Boolean(restoredContext.instruction.trim()))

  const addMessage = useCallback((message: Omit<ChatMessage, 'id'>) => {
    setMessages((old) => [...old.slice(-5), { ...message, id: nextMessageId.current++ }])
  }, [])

  const updateInstructionDraft = useCallback((value: string) => {
    instructionDraftRef.current = value
    const nextHasInstruction = Boolean(value.trim())
    if (nextHasInstruction !== hasInstructionRef.current) {
      hasInstructionRef.current = nextHasInstruction
      setHasInstruction(nextHasInstruction)
    }
  }, [])

  const clearInstruction = useCallback(() => {
    instructionDraftRef.current = ''
    if (instructionInputRef.current) instructionInputRef.current.value = ''
    if (hasInstructionRef.current) {
      hasInstructionRef.current = false
      setHasInstruction(false)
    }
  }, [])

  const cancelPlan = useCallback(() => {
    setPlan(null)
    requestAnimationFrame(() => instructionInputRef.current?.focus())
  }, [])

  const cancelTaskCompletion = useCallback(() => {
    const taskGuid = pendingTaskCompletion
    setPendingTaskCompletion('')
    requestAnimationFrame(() => taskCompletionRefs.current.get(taskGuid)?.focus())
  }, [pendingTaskCompletion])

  const loadOverview = useCallback(async () => {
    const requestId = ++overviewRequestId.current
    setOverviewLoading(true)
    const range = todayRange()
    const [approvalResult, taskResult, calendarResult] = await Promise.allSettled([
      workspaceApi<{ ok: true; data: unknown }>('/api/workspace/approvals'),
      workspaceApi<{ ok: true; data: unknown }>('/api/workspace/tasks'),
      workspaceApi<{ ok: true; data: unknown }>(
        `/api/workspace/calendar/agenda?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`,
      ),
    ])
    if (requestId !== overviewRequestId.current) return
    if (approvalResult.status === 'fulfilled') {
      setApprovals(normalizeApprovals(approvalResult.value.data))
    }
    if (taskResult.status === 'fulfilled') setTasks(normalizeTasks(taskResult.value.data))
    if (calendarResult.status === 'fulfilled') {
      setCalendar(normalizeCalendar(calendarResult.value.data))
    }
    const firstFailure = [approvalResult, taskResult, calendarResult].find(
      (result) => result.status === 'rejected',
    )
    setError(firstFailure?.status === 'rejected' ? firstFailure.reason as ApiError : null)
    setOverviewLoading(false)
  }, [])

  useEffect(() => {
    void loadOverview()
    return () => {
      overviewRequestId.current += 1
    }
  }, [loadOverview])

  useEffect(() => {
    if (restoredContext.expanded) window.petAPI?.resizeAssistant?.(true)
  }, [restoredContext.expanded])

  useEffect(() => {
    if (!assistantShellRef.current) return
    assistantShellRef.current.inert = closePrompt
    if (closePrompt) {
      closePromptWasOpen.current = true
      closeDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    } else if (closePromptWasOpen.current) {
      closePromptWasOpen.current = false
      closeButtonRef.current?.focus()
    }
  }, [closePrompt])

  const pendingTasks = useMemo(() => {
    return [...tasks].sort((left, right) => {
      const dueOrder = (left.due ?? Number.POSITIVE_INFINITY) - (right.due ?? Number.POSITIVE_INFINITY)
      return dueOrder || left.summary.localeCompare(right.summary, 'zh-CN')
    })
  }, [tasks])

  const toggleExpanded = () => {
    if (pendingTaskCompletion) cancelTaskCompletion()
    const next = !expanded
    setExpanded(next)
    window.petAPI?.resizeAssistant?.(next)
  }

  const context = useMemo(() => ({
    approvals: approvals.map((item) => ({
      instanceCode: item.instanceCode,
      taskId: item.taskId,
      title: item.title,
      initiator: item.initiator,
      summaries: item.summaries,
    })),
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
  }), [approvals, calendar, tasks])

  const requestPlan = async () => {
    const text = instructionDraftRef.current.trim()
    if (!text || operationBusy || hasInlineConfirmation) return
    clearInstruction()
    setBusy(true)
    setPlan(null)
    setError(null)
    addMessage({ role: 'user', text })
    try {
      const data = await workspaceApi<{ ok: true; plan: AssistantPlan }>(
        '/api/workspace/assistant/plan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instruction: text,
            context: {
              ...context,
              conversation: messages.slice(-10).map(({ role, text: messageText }) => ({
                role,
                text: messageText,
              })),
            },
          }),
        },
      )
      setPlan(data.plan)
      addMessage({ role: 'assistant', text: data.plan.preview })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  const prepareApproval = (item: ApprovalItem, action: 'approve' | 'reject') => {
    setError(null)
    const nextPlan: AssistantPlan = {
      action: `approval.${action}`,
      arguments: {
        instanceCode: item.instanceCode,
        taskId: item.taskId,
        comment: '',
      },
      preview: `${action === 'approve' ? '通过' : '拒绝'}「${item.title}」${item.initiator ? `（${item.initiator}）` : ''}`,
      requiresConfirmation: true,
    }
    setPlan(nextPlan)
    addMessage({ role: 'assistant', text: nextPlan.preview })
  }

  const completeTask = async (task: TaskItem) => {
    if (!task.guid || operationBusy) return
    const currentIndex = pendingTasks.findIndex((item) => item.guid === task.guid)
    const focusTargetGuid = pendingTasks[currentIndex + 1]?.guid || pendingTasks[currentIndex - 1]?.guid || ''
    setCompletingTask(task.guid)
    setError(null)
    try {
      await workspaceApi(`/api/workspace/tasks/${encodeURIComponent(task.guid)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      setTasks((current) => current.filter((item) => item.guid !== task.guid))
      setPendingTaskCompletion('')
      addMessage({ role: 'assistant', text: `已完成任务「${task.summary}」。`, success: true })
      requestAnimationFrame(() => {
        const nextButton = taskCompletionRefs.current.get(focusTargetGuid)
        if (nextButton) nextButton.focus()
        else overviewToggleRef.current?.focus()
      })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setCompletingTask('')
    }
  }

  const openApprovalInFeishu = (item: ApprovalItem) => {
    if (window.petAPI?.openApproval) {
      window.petAPI.openApproval({
        definitionCode: item.definitionCode,
        instanceCode: item.instanceCode,
        taskId: item.taskId,
      })
      return
    }
    if (item.link) window.open(item.link, '_blank', 'noopener,noreferrer')
  }

  const openApprovalOnWeb = (item: ApprovalItem) => {
    if (window.petAPI?.openWorkbenchApproval) {
      window.petAPI.openWorkbenchApproval(item.instanceCode)
      return
    }
    window.open(`/workbench?approval=${encodeURIComponent(item.instanceCode)}`, '_blank', 'noopener,noreferrer')
  }

  const executePlan = async () => {
    if (!plan || operationBusy || hasInlineConfirmation) return
    const executingPlan = plan
    setBusy(true)
    setError(null)
    try {
      const response = await workspaceApi<{ ok: true; data: unknown }>('/api/workspace/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, confirmed: plan.requiresConfirmation }),
      })
      const suggestedSlots = executingPlan.action === 'calendar.suggest'
        ? formatTimeSlots(response.data)
        : []
      const successText = executingPlan.action === 'calendar.suggest'
        ? suggestedSlots.length
          ? `找到 ${suggestedSlots.length} 个空闲时间段：${suggestedSlots.slice(0, 5).join('；')}${suggestedSlots.length > 5 ? '…' : ''}`
          : '查询完成，但所选范围内没有解析到空闲时间段。'
        : executingPlan.action === 'task.create'
          ? `已创建任务「${String(executingPlan.arguments.summary || '新任务')}」，已加入全部待办。`
          : '处理完成，飞书列表已刷新。'
      addMessage({ role: 'assistant', text: successText, success: true })
      setPlan(null)
      void loadOverview()
      if (executingPlan.action.startsWith('task.')) {
        setExpanded(true)
        setOverviewTab('tasks')
        window.petAPI?.resizeAssistant?.(true)
      } else if (executingPlan.action.startsWith('calendar.')) {
        setExpanded(true)
        setOverviewTab('calendar')
        window.petAPI?.resizeAssistant?.(true)
      }
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  const overviewTabs: { id: OverviewTab; label: string; count: number; icon: typeof ListTodo }[] = [
    { id: 'tasks', label: '待办', count: pendingTasks.length, icon: ListTodo },
    { id: 'approvals', label: '审批', count: approvals.length, icon: FileCheck2 },
    { id: 'calendar', label: '日程', count: calendar.length, icon: CalendarDays },
  ]

  const closeAssistantWindow = useCallback(() => {
    if (window.petAPI?.closeAssistant) window.petAPI.closeAssistant()
    else window.close()
  }, [])

  const applyCloseChoice = useCallback((choice: CloseChoice, rememberForToday: boolean) => {
    try {
      if (choice === 'preserve') {
        localStorage.setItem(ASSISTANT_CONTEXT_KEY, JSON.stringify({
          messages: messages.slice(-12),
          instruction: instructionDraftRef.current,
          expanded,
          overviewTab,
        } satisfies CachedAssistantContext))
      } else {
        localStorage.removeItem(ASSISTANT_CONTEXT_KEY)
      }
      if (rememberForToday) saveDailyCloseChoice(choice)
    } catch {
      setError(new ApiError('关闭设置保存失败，请取消后重试'))
      return
    }
    if (choice === 'clear') {
      setMessages(DEFAULT_MESSAGES)
      clearInstruction()
      setPlan(null)
      setPendingTaskCompletion('')
    }
    setRememberCloseChoice(false)
    setClosePrompt(false)
    closeAssistantWindow()
  }, [clearInstruction, closeAssistantWindow, expanded, messages, overviewTab])

  const requestCloseAssistant = useCallback(() => {
    if (operationBusy) return
    const dailyChoice = loadDailyCloseChoice()
    if (dailyChoice) {
      applyCloseChoice(dailyChoice, true)
      return
    }
    setRememberCloseChoice(false)
    setClosePrompt(true)
  }, [applyCloseChoice, operationBusy])

  const dismissClosePrompt = useCallback(() => {
    setRememberCloseChoice(false)
    setClosePrompt(false)
  }, [])

  useEffect(() => {
    document.title = '小绝助手'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (closePrompt) {
        dismissClosePrompt()
        return
      }
      if (pendingTaskCompletion) {
        cancelTaskCompletion()
        return
      }
      requestCloseAssistant()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [cancelTaskCompletion, closePrompt, dismissClosePrompt, pendingTaskCompletion, requestCloseAssistant])

  const trapCloseDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !closeDialogRef.current) return
    const focusable = [...closeDialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !closeDialogRef.current.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <main className="assistant-window h-screen w-screen overflow-hidden bg-transparent p-3 text-[#191919]">
      <section ref={assistantShellRef} className="assistant-shell flex h-full flex-col overflow-hidden rounded-[18px] border-[3px] border-[#191919] bg-[#FFFDF8] shadow-[6px_6px_0_#191919]">
        <header className="assistant-drag flex h-[68px] shrink-0 items-center gap-2 border-b-2 border-[#191919] bg-white px-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden">
            <div className="origin-top-left scale-[0.21]">
              <AssistantPet />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-black leading-tight">小绝助手</p>
            <p className="mt-0.5 truncate text-[11px] font-bold text-[#191919]/48">CLI 在线 · 操作前会给你确认</p>
          </div>
          <button
            className="assistant-no-drag assistant-icon-button"
            onClick={() => window.petAPI?.openWorkbench?.()}
            title="打开完整工作台"
            aria-label="打开完整工作台"
          >
            <ExternalLink className="h-[18px] w-[18px]" />
          </button>
          <button
            ref={closeButtonRef}
            className="assistant-no-drag assistant-icon-button"
            onClick={requestCloseAssistant}
            title={operationBusy ? '操作完成后再关闭' : '关闭'}
            aria-label="关闭"
            disabled={operationBusy}
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </header>

        <button
          ref={overviewToggleRef}
          className="assistant-no-drag flex min-h-12 shrink-0 items-center gap-3 border-b-2 border-[#191919]/12 bg-[#F3F7FF] px-4 text-left transition-colors hover:bg-[#E9F0FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2B5CFF]"
          onClick={toggleExpanded}
          aria-expanded={expanded}
        >
          <Sparkles className="h-4 w-4 text-[#2B5CFF]" />
          <span className="flex-1 text-xs font-black">工作概览</span>
          <span className="text-[11px] font-bold text-[#191919]/55">
            {pendingTasks.length} 待办 · {approvals.length} 审批 · {calendar.length} 今日日程
          </span>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {expanded && (
          <section className="assistant-overview shrink-0 border-b-2 border-[#191919] bg-[#F7F5EE]">
            <div className="grid grid-cols-3 border-b border-[#191919]/15 bg-white px-2 pt-2">
              {overviewTabs.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    className={`assistant-no-drag flex min-h-10 items-center justify-center gap-1.5 border-b-[3px] px-2 text-xs font-black transition-colors ${overviewTab === item.id ? 'border-[#2B5CFF] text-[#2B5CFF]' : 'border-transparent text-[#191919]/50 hover:text-[#191919]'}`}
                    onClick={() => {
                      if (pendingTaskCompletion && item.id !== 'tasks') cancelTaskCompletion()
                      setOverviewTab(item.id)
                    }}
                  >
                    <Icon className="h-3.5 w-3.5" />{item.label}
                    <span className="rounded bg-[#191919] px-1.5 py-0.5 text-[9px] text-white">{item.count}</span>
                  </button>
                )
              })}
            </div>
            <div className="h-[188px] overflow-y-auto p-3">
              {overviewLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs font-bold text-[#191919]/45">
                  <LoaderCircle className="h-4 w-4 animate-spin" />读取飞书数据
                </div>
              ) : overviewTab === 'tasks' ? (
                pendingTasks.length ? pendingTasks.map((task) => {
                  const awaitingConfirmation = pendingTaskCompletion === task.guid
                  const isCompleting = completingTask === task.guid
                  const confirmationId = `complete-task-${task.guid}`
                  return (
                    <article key={task.guid} className="border-b border-[#191919]/15 last:border-b-0">
                      <div className="flex min-h-11 items-center gap-2.5 px-1 py-1">
                        <button
                          ref={(node) => {
                            if (node) taskCompletionRefs.current.set(task.guid, node)
                            else taskCompletionRefs.current.delete(task.guid)
                          }}
                          className={`assistant-mini-action shrink-0 ${awaitingConfirmation ? 'bg-[#FFD60A]' : 'bg-white hover:bg-[#DDF9B9]'}`}
                          onClick={() => {
                            if (awaitingConfirmation) cancelTaskCompletion()
                            else setPendingTaskCompletion(task.guid)
                          }}
                          disabled={!task.guid || operationBusy || Boolean(plan)}
                          title={plan ? '请先处理当前操作预览' : '完成任务'}
                          aria-label={`完成任务：${task.summary}`}
                          aria-expanded={awaitingConfirmation}
                          aria-controls={awaitingConfirmation ? confirmationId : undefined}
                        >
                          {isCompleting
                            ? <LoaderCircle className="h-4 w-4 animate-spin" />
                            : <Circle className="h-4 w-4 text-[#43A047]" />}
                        </button>
                        <span className="min-w-0 flex-1 truncate text-xs font-bold">{task.summary}</span>
                        <span className="shrink-0 text-[10px] font-bold text-[#191919]/45">{formatDate(task.due, '无截止时间')}</span>
                      </div>
                      {awaitingConfirmation && (
                        <div id={confirmationId} className="mb-2 rounded-md border-2 border-[#191919] bg-[#FFF7CC] p-2 shadow-[2px_2px_0_#191919]">
                          <p className="truncate text-[11px] font-black">确认完成「{task.summary}」？</p>
                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            <button
                              className="assistant-command-button min-h-8 bg-[#9BE83A] px-2"
                              onClick={() => void completeTask(task)}
                              disabled={isCompleting}
                              autoFocus
                            >
                              {isCompleting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              {isCompleting ? '完成中' : '确认完成'}
                            </button>
                            <button
                              className="assistant-command-button min-h-8 bg-white px-2"
                              onClick={cancelTaskCompletion}
                              disabled={isCompleting}
                            >
                              <X className="h-3.5 w-3.5" />取消
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  )
                }) : <p className="assistant-empty">当前没有待办</p>
              ) : overviewTab === 'approvals' ? (
                approvals.length ? approvals.slice(0, 8).map((item) => (
                  <article key={item.instanceCode} className="border-b border-[#191919]/15 last:border-b-0">
                    <button
                      className="flex min-h-12 w-full items-center gap-2 px-1 py-1.5 text-left hover:bg-[#E9F0FF]"
                      onClick={() => setExpandedApproval((current) => current === item.instanceCode ? null : item.instanceCode)}
                      aria-expanded={expandedApproval === item.instanceCode}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-black">{item.title}</p>
                        <p className="truncate text-[10px] font-bold text-[#191919]/45">{item.initiator}</p>
                      </div>
                      {expandedApproval === item.instanceCode ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                    </button>
                    {expandedApproval === item.instanceCode && (
                      <div className="mb-2 rounded-md border-2 border-[#191919] bg-white p-2.5 shadow-[2px_2px_0_#191919]">
                        <dl className="space-y-1.5">
                          {item.summaries.length ? item.summaries.slice(0, 5).map((summary) => (
                            <div key={`${summary.key}-${summary.value}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[10px]">
                              <dt className="font-black text-[#191919]/45">{summary.key || '信息'}</dt>
                              <dd className="break-words font-bold">{summary.value || '未填写'}</dd>
                            </div>
                          )) : <p className="text-[10px] font-bold text-[#191919]/45">暂无摘要，打开网页查看完整表单</p>}
                        </dl>
                        <div className="mt-2 grid grid-cols-2 gap-1.5">
                          <button className="assistant-command-button min-h-8 bg-[#2B5CFF] px-2 text-white" onClick={() => openApprovalInFeishu(item)} disabled={!item.link}>
                            <FileCheck2 className="h-3.5 w-3.5" />跳转飞书
                          </button>
                          <button className="assistant-command-button min-h-8 bg-white px-2" onClick={() => openApprovalOnWeb(item)}>
                            <ExternalLink className="h-3.5 w-3.5" />网页端打开
                          </button>
                        </div>
                        {item.canOperate && item.taskId && (
                          <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-[#191919]/15 pt-2">
                            <button className="assistant-command-button min-h-8 bg-[#DDF9B9] px-2" onClick={() => prepareApproval(item, 'approve')} disabled={operationBusy}><Check className="h-3.5 w-3.5" />通过</button>
                            <button className="assistant-command-button min-h-8 bg-[#FFD7D5] px-2" onClick={() => prepareApproval(item, 'reject')} disabled={operationBusy}><X className="h-3.5 w-3.5" />拒绝</button>
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                )) : <p className="assistant-empty">当前没有待审批</p>
              ) : calendar.length ? calendar.slice(0, 8).map((item) => (
                <div key={item.eventId} className="assistant-list-row">
                  <Clock3 className="h-4 w-4 shrink-0 text-[#2B5CFF]" />
                  <span className="min-w-0 flex-1 truncate text-xs font-bold">{item.summary}</span>
                  <span className="text-[10px] font-bold text-[#191919]/45">{formatDate(item.start)}</span>
                </div>
              )) : <p className="assistant-empty">今天没有日程</p>}
            </div>
          </section>
        )}

        <section className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
          <div className="space-y-2.5">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <p className={`max-w-[86%] rounded-xl border-2 border-[#191919] px-3 py-2 text-xs font-bold leading-relaxed ${
                  message.role === 'user'
                    ? 'bg-[#2B5CFF] text-white'
                    : message.success
                      ? 'bg-[#DDF9B9]'
                      : 'bg-white'
                }`}>{message.text}</p>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="flex min-h-9 items-center gap-2 rounded-xl border-2 border-[#191919] bg-white px-3 text-xs font-bold">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#2B5CFF]" />处理中
                </div>
              </div>
            )}
          </div>
        </section>

        <ErrorLine error={error} />

        {plan && (
          <section className="mx-4 mb-3 shrink-0 rounded-lg border-2 border-[#191919] bg-[#FFF7CC] p-3 shadow-[3px_3px_0_#191919]">
            <div className="flex items-center justify-between gap-2">
              <span className="rounded bg-[#191919] px-2 py-1 text-[10px] font-black text-white">{actionLabel(plan.action)}</span>
              {plan.requiresConfirmation && <span className="text-[10px] font-black text-[#8A1C1C]">请确认</span>}
            </div>
            <p className="mt-2 text-xs font-black leading-relaxed">{plan.preview}</p>
            {plan.action !== 'clarify' && (
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <button className="assistant-command-button bg-[#9BE83A]" onClick={executePlan} disabled={operationBusy || hasInlineConfirmation}>
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {plan.requiresConfirmation ? '确认执行' : '立即查询'}
                </button>
                <button className="assistant-icon-button bg-white" onClick={cancelPlan} disabled={operationBusy} title="取消" aria-label="取消"><X className="h-4 w-4" /></button>
              </div>
            )}
          </section>
        )}

        <form
          className="assistant-no-drag shrink-0 border-t-2 border-[#191919] bg-white p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void requestPlan()
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={instructionInputRef}
              className="min-h-11 max-h-24 flex-1 resize-none rounded-xl border-2 border-[#191919] bg-[#F8F8F4] px-3 py-2.5 text-sm font-bold leading-5 outline-none transition-colors placeholder:text-[#191919]/35 focus:border-[#2B5CFF]"
              defaultValue={restoredContext.instruction}
              onInput={(event) => updateInstructionDraft(event.currentTarget.value)}
              disabled={operationBusy || hasInlineConfirmation}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault()
                  void requestPlan()
                }
              }}
              placeholder="告诉小绝要做什么"
              maxLength={3000}
              rows={1}
            />
            <button className="assistant-send-button" type="submit" disabled={!hasInstruction || operationBusy || hasInlineConfirmation} title="发送" aria-label="发送">
              {busy ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
        </form>
      </section>

      {closePrompt && (
        <div className="assistant-no-drag fixed inset-0 z-50 grid place-items-center bg-[#191919]/35 p-5 backdrop-blur-[2px]">
          <section
            ref={closeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="assistant-close-title"
            onKeyDown={trapCloseDialogFocus}
            className="w-full max-w-sm rounded-lg border-[3px] border-[#191919] bg-[#FFFDF8] p-4 shadow-[6px_6px_0_#191919]"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border-2 border-[#191919] bg-[#E9F0FF]">
                <Save className="h-5 w-5 text-[#2B5CFF]" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="assistant-close-title" className="text-base font-black">保留这次对话吗？</h2>
                <p className="mt-1 text-[11px] font-bold leading-relaxed text-[#191919]/55">
                  可保留最近对话和输入草稿，下次双击小绝继续。待执行操作不会缓存。
                </p>
              </div>
            </div>
            <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border-2 border-[#191919]/20 bg-white px-3 py-2 transition-colors hover:bg-[#F3F7FF] focus-within:border-[#2B5CFF]">
              <input
                className="h-5 w-5 shrink-0 accent-[#2B5CFF]"
                type="checkbox"
                checked={rememberCloseChoice}
                onChange={(event) => setRememberCloseChoice(event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-xs font-black">今天不再询问</span>
                <span className="block text-[10px] font-bold text-[#191919]/50">后续关闭沿用本次选择</span>
              </span>
            </label>
            <div className="mt-4 grid gap-2">
              <button className="assistant-command-button bg-[#9BE83A]" onClick={() => applyCloseChoice('preserve', rememberCloseChoice)} autoFocus>
                <Save className="h-4 w-4" />保留并关闭
              </button>
              <button className="assistant-command-button bg-[#FFF0EF] text-[#8A1C1C]" onClick={() => applyCloseChoice('clear', rememberCloseChoice)}>
                <Trash2 className="h-4 w-4" />清空并关闭
              </button>
              <button className="assistant-command-button border-[#191919]/25 bg-white" onClick={dismissClosePrompt}>
                <X className="h-4 w-4" />取消
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
