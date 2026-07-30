import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { STATE_META, type PetState } from '@/types/pet'

/**
 * 消息归档二级页面：宠物身上都是碎片化的气泡和状态，
 * 这里把「消息提醒 / 绝活汇报 / 干活指令」持久化归档，随时回看全文。
 * 数据来自 server.cjs 的 /api/archive（~/.xiaojue-pet/archive.json）。
 */

interface ArchiveItem {
  id: string
  kind: 'message' | 'report' | 'command'
  ts: number
  // message
  state?: PetState
  label?: string
  chatId?: string
  // report
  trigger?: string
  text?: string
  // command
  command?: string
  source?: string
}

const TABS = [
  { id: 'all', name: '全部' },
  { id: 'message', name: '📩 消息提醒' },
  { id: 'report', name: '📋 绝活汇报' },
  { id: 'command', name: '🎯 干活指令' },
] as const

const STATE_DOT: Record<string, string> = {
  idle: '#9BE83A',
  thinking: '#FFD60A',
  working: '#2B5CFF',
  success: '#9BE83A',
  error: '#FF4D4F',
  sleeping: '#BFBFB8',
}

function fmtFull(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('zh-CN', { hour12: false })
  return sameDay
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/** 按天分组的小标题 */
function dayLabel(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return '今天'
  const yesterday = new Date(Date.now() - 86400_000)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function MessageRow({ it }: { it: ArchiveItem }) {
  const meta = it.state ? STATE_META[it.state] : null
  return (
    <div className="flex items-start gap-2.5 rounded-xl border-2 border-[#191919]/10 bg-white px-3 py-2.5">
      <span
        className="mt-0.5 shrink-0 rounded-md border-2 border-[#191919] px-1.5 py-0.5 text-[10px] font-black"
        style={{
          background: meta?.color ?? STATE_DOT.idle,
          color: meta?.textColor ?? '#191919',
        }}
      >
        {meta?.name ?? '动态'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold leading-relaxed text-[#191919]">
          {it.label || '（无内容）'}
          {it.chatId && (
            <a
              href={`https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(it.chatId)}`}
              target="_blank"
              rel="noreferrer"
              className="ml-1.5 inline-flex items-center rounded border border-[#2B5CFF] px-1 text-[10px] font-black text-[#2B5CFF] hover:bg-[#2B5CFF] hover:text-white"
            >
              去飞书看 ↗
            </a>
          )}
        </p>
        <p className="mt-0.5 text-[10px] font-bold text-[#191919]/40">
          {fmtFull(it.ts)} · {it.source ?? 'api'}
        </p>
      </div>
    </div>
  )
}

function ReportCard({ it }: { it: ArchiveItem }) {
  const [open, setOpen] = useState(false)
  const text = it.text ?? ''
  const long = text.length > 140
  return (
    <div className="rounded-xl border-[3px] border-[#191919] bg-white p-3.5 shadow-[4px_4px_0_#191919]">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="rounded-md border-2 border-[#191919] bg-[#8B5CF6] px-2 py-0.5 text-[10px] font-black text-white">
          {it.trigger || '绝活汇报'}
        </span>
        <span className="shrink-0 text-[10px] font-bold text-[#191919]/40">
          {fmtFull(it.ts)}
        </span>
      </div>
      <p
        className={`whitespace-pre-wrap text-xs font-bold leading-relaxed text-[#191919]/85 ${
          open ? '' : 'line-clamp-4'
        }`}
      >
        {text}
      </p>
      {long && (
        <button
          onClick={() => setOpen(!open)}
          className="mt-1.5 text-[11px] font-black text-[#2B5CFF] hover:underline"
        >
          {open ? '收起 ▲' : '展开全文 ▼'}
        </button>
      )}
    </div>
  )
}

function CommandRow({ it }: { it: ArchiveItem }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border-2 border-dashed border-[#191919]/25 bg-[#F8F8F4] px-3 py-2">
      <span className="rounded-md border-2 border-[#191919] bg-[#FFD60A] px-1.5 py-0.5 text-[10px] font-black">
        派活
      </span>
      <p className="min-w-0 flex-1 truncate text-xs font-bold text-[#191919]/80">
        {it.label || it.command}
      </p>
      <span className="shrink-0 text-[10px] font-bold text-[#191919]/40">
        {fmtFull(it.ts)} · {it.source ?? 'menu'}
      </span>
    </div>
  )
}

export default function Archive() {
  const [type, setType] = useState<string>('all')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<ArchiveItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (t: string, kw: string) => {
    try {
      const res = await fetch(
        `/api/archive?type=${encodeURIComponent(t)}&q=${encodeURIComponent(kw)}&limit=300`,
      )
      const d = await res.json()
      if (!d.ok) throw new Error(d.error || '加载失败')
      setItems(d.items)
      setTotal(d.total)
      setError('')
    } catch (e) {
      setError(`归档读取失败：${(e as Error).message}（宠物服务没开？）`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => load(type, q), q ? 300 : 0)
    return () => clearTimeout(timer)
  }, [type, q, load])

  // 30s 轮询，新消息/新汇报自动进来
  useEffect(() => {
    const timer = setInterval(() => load(type, q), 30_000)
    return () => clearInterval(timer)
  }, [type, q, load])

  // 按天分组
  const groups: { day: string; list: ArchiveItem[] }[] = []
  for (const it of items) {
    const day = dayLabel(it.ts)
    const g = groups[groups.length - 1]
    if (g && g.day === day) g.list.push(it)
    else groups.push({ day, list: [it] })
  }

  return (
    <div className="grid-paper min-h-screen font-sans text-[#191919]">
      {/* 顶栏 */}
      <header className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 pt-8">
        <div className="flex items-center gap-3">
          <div className="sticker px-4 py-2">
            <h1 className="text-2xl font-black tracking-tight">
              消息归档<span className="text-[#8B5CF6]">·</span>小绝的记事本
            </h1>
          </div>
        </div>
        <Link
          to="/"
          className="sticker px-3 py-1.5 text-xs font-black transition-all hover:-translate-y-0.5"
        >
          ← 返回看板
        </Link>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-6">
        {/* 过滤 + 搜索 */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setLoading(true)
                setType(t.id)
              }}
              className={`rounded-lg border-2 border-[#191919] px-3 py-1.5 text-xs font-black transition-all ${
                type === t.id
                  ? 'bg-[#191919] text-[#9BE83A] shadow-[3px_3px_0_rgba(25,25,25,0.3)]'
                  : 'bg-white hover:bg-[#9BE83A]/30'
              }`}
            >
              {t.name}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => {
              setLoading(true)
              setQ(e.target.value)
            }}
            placeholder="搜内容 / 来源 / 触发方式…"
            className="ml-auto w-56 rounded-lg border-2 border-[#191919] bg-white px-3 py-1.5 text-xs font-bold outline-none focus:border-[#2B5CFF]"
          />
        </div>

        {/* 统计 */}
        <p className="mb-4 text-[11px] font-bold text-[#191919]/40">
          {loading ? '读取中…' : `共 ${total} 条归档 · 本地持久化保存，宠物重启也不丢`}
        </p>

        {error && (
          <div className="sticker mb-4 border-[#FF4D4F] bg-[#FFF1F0] p-3 text-xs font-bold text-[#FF4D4F]">
            {error}
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="sticker flex flex-col items-center gap-2 p-10 text-center">
            <span className="text-3xl">🐾</span>
            <p className="text-sm font-black">还没有归档内容</p>
            <p className="text-xs font-bold text-[#191919]/40">
              飞书来消息、小绝演完绝活之后，这里会自动记下来
            </p>
          </div>
        )}

        {/* 分组列表 */}
        <div className="flex flex-col gap-5 pb-10">
          {groups.map((g) => (
            <section key={g.day}>
              <h2 className="mb-2 text-xs font-black text-[#191919]/50">
                —— {g.day} ——
              </h2>
              <div className="flex flex-col gap-2">
                {g.list.map((it) =>
                  it.kind === 'report' ? (
                    <ReportCard key={it.id} it={it} />
                  ) : it.kind === 'command' ? (
                    <CommandRow key={it.id} it={it} />
                  ) : (
                    <MessageRow key={it.id} it={it} />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  )
}
