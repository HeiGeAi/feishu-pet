import { useCallback, useEffect, useRef, useState } from 'react'
import type { PetEvent, PetReport, PetState } from '@/types/pet'

/** 网页看板里走相对路径；桌面宠物窗口（file://）走绝对地址 */
const API_BASE = window.location.protocol.startsWith('http')
  ? ''
  : `http://localhost:${location.port || 7100}`

async function channelUrl(path: string) {
  if (window.location.protocol === 'file:') {
    if (!window.petAPI?.channelAccess) throw new Error('Pet IPC unavailable')
    const access = await window.petAPI.channelAccess()
    return `${access.base}${path}?desktopToken=${encodeURIComponent(access.token)}`
  }
  return `${API_BASE}${path}`
}

const FALLBACK: PetEvent = {
  state: 'idle',
  label: '待机中 · 等飞书 bot 召唤',
  ts: Date.now(),
  source: 'system',
}

export function usePetChannel() {
  const [current, setCurrent] = useState<PetEvent>(FALLBACK)
  const [log, setLog] = useState<PetEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [stateSince, setStateSince] = useState(FALLBACK.ts)
  const [interact, setInteract] = useState<{ kind: 'pat' | 'feed'; n: number }>({
    kind: 'pat',
    n: 0,
  })
  const [lastReport, setLastReport] = useState<PetReport | null>(null)
  const seenTs = useRef<number>(0)

  const bumpInteract = useCallback((kind: 'pat' | 'feed') => {
    setInteract((i) => ({ kind, n: i.n + 1 }))
  }, [])

  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout>
    let stopped = false

    const connect = async () => {
      let url: string
      try {
        url = await channelUrl('/api/events')
      } catch {
        if (!stopped) retry = setTimeout(connect, 3000)
        return
      }
      if (stopped) return
      es = new EventSource(url)
      es.onopen = () => setConnected(true)
      es.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data)
          if (d.type === 'init') {
            setCurrent(d.last)
            setLog(d.log ?? [])
            if (d.lastReport) setLastReport(d.lastReport)
            setStateSince(Date.now())
          } else if (d.type === 'event') {
            const ev: PetEvent = d.event
            if (ev.ts <= seenTs.current) return
            seenTs.current = ev.ts
            setCurrent(ev)
            setStateSince(Date.now())
            setLog((prev) => [...prev.slice(-49), ev])
          } else if (d.type === 'interact') {
            // 飞书侧发来的摸头/投喂
            bumpInteract(d.interact?.kind === 'feed' ? 'feed' : 'pat')
          } else if (d.type === 'report') {
            setLastReport(d.report)
          }
        } catch {
          /* ignore */
        }
      }
      es.onerror = () => {
        setConnected(false)
        es?.close()
        if (!stopped) retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      es?.close()
    }
  }, [bumpInteract])

  const sendEvent = useCallback(async (state: PetState, label?: string) => {
    try {
      const res = await fetch(await channelUrl('/api/event'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, label, source: 'demo' }),
      })
      const d = await res.json()
      if (!d.ok) throw new Error(d.error)
    } catch {
      // API 未就绪时本地降级：直接改前端状态
      const ev: PetEvent = { state, label, ts: Date.now(), source: 'local' }
      setCurrent(ev)
      setStateSince(Date.now())
      setLog((prev) => [...prev.slice(-49), ev])
    }
  }, [])

  return { current, log, connected, stateSince, sendEvent, interact, bumpInteract, lastReport }
}
