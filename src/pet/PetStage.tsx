import { useEffect, useRef } from 'react'
import type { PetState } from '@/types/pet'
import { skinImage, type PetForm, type SkinId } from '@/pet/skins'
import {
  BODY,
  HEART,
  STAR,
  GRID_W,
  GRID_H,
  drawPet,
  drawParticle,
  type EyeMode,
} from '@/pet/sprite'

const S = 12 // 每像素渲染尺寸

interface Particle {
  kind: 'heart' | 'star' | 'z' | 'spark' | 'cookie'
  x: number // 网格坐标（浮点）
  y: number
  vx: number
  vy: number
  born: number
  life: number
  size: number
}

export interface PetStageProps {
  state: PetState
  /** 状态开始时间戳，用于跳动/抖动等一次性动作 */
  stateSince: number
  /** 互动触发器：pat=摸头 feed=投喂，数值变化时触发 */
  interact: { kind: 'pat' | 'feed'; n: number }
  /** CSS 缩放倍数，桌面窗口用小体型 */
  scale?: number
  /** 皮肤与形态 */
  skin?: SkinId
  form?: PetForm
  onPat?: () => void
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a)
}

export function PetStage({ state, stateSince, interact, scale = 1.35, skin = 'pixel', form = 'adult', onPat }: PetStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const stateSinceRef = useRef(stateSince)
  const skinRef = useRef(skin)
  const formRef = useRef(form)
  const imgCacheRef = useRef(new Map<string, HTMLImageElement>())
  const particlesRef = useRef<Particle[]>([])
  const blinkRef = useRef({ next: 0, until: 0 })
  const patUntilRef = useRef(0)

  useEffect(() => {
    stateRef.current = state
    stateSinceRef.current = stateSince
    skinRef.current = skin
    formRef.current = form
  }, [form, skin, state, stateSince])

  const getImage = (src: string): HTMLImageElement | null => {
    let img = imgCacheRef.current.get(src)
    if (!img) {
      img = new Image()
      img.src = src
      imgCacheRef.current.set(src, img)
    }
    return img.complete && img.naturalWidth > 0 ? img : null
  }

  // 互动效果
  useEffect(() => {
    if (interact.n === 0) return
    const now = performance.now()
    if (interact.kind === 'pat') {
      patUntilRef.current = now + 1600
      for (let i = 0; i < 6; i++) {
        particlesRef.current.push({
          kind: 'heart',
          x: rand(6, 14),
          y: rand(4, 8),
          vx: rand(-0.012, 0.012),
          vy: rand(-0.05, -0.028),
          born: now + i * 120,
          life: 1400,
          size: 3,
        })
      }
    } else {
      // 投喂：像素食物从天上掉下来
      particlesRef.current.push({
        kind: 'cookie',
        x: 10.5,
        y: -4,
        vx: 0,
        vy: 0.06,
        born: now,
        life: 4000,
        size: 3,
      })
      patUntilRef.current = now + 2200
    }
  }, [interact])

  // 状态进入时的一次性粒子
  useEffect(() => {
    const now = performance.now()
    if (state === 'success') {
      for (let i = 0; i < 10; i++) {
        particlesRef.current.push({
          kind: 'star',
          x: rand(2, 18),
          y: rand(2, 10),
          vx: rand(-0.02, 0.02),
          vy: rand(-0.045, -0.02),
          born: now + i * 90,
          life: 1600,
          size: 3,
        })
      }
    }
  }, [state, stateSince])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    blinkRef.current.next = performance.now() + 2500

    let raf = 0
    const loop = (t: number) => {
      const st = stateRef.current
      const elapsed = t - stateSinceRef.current

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // —— 本体位移 ——
      let ox = 0
      let oy = 0
      if (st === 'idle' || st === 'thinking') {
        oy = Math.round(Math.sin(t / 480) * 0.35) // 呼吸起伏
      } else if (st === 'working') {
        oy = Math.round(Math.sin(t / 260) * 0.2)
      } else if (st === 'success') {
        // 起跳抛物线（前 1.2s）
        const p = Math.min(1, elapsed / 1200)
        oy = -Math.round(Math.sin(p * Math.PI) * 3.2)
      } else if (st === 'error') {
        ox = Math.round(Math.sin(t / 40) * 0.45) * (elapsed < 900 ? 1 : 0)
      } else if (st === 'sleeping') {
        oy = Math.round(Math.sin(t / 900) * 0.25)
      }

      // —— 眨眼 ——
      const blink = blinkRef.current
      if (t > blink.next) {
        blink.until = t + 140
        blink.next = t + rand(2400, 4600)
      }
      let eyes: EyeMode = t < blink.until ? 'blink' : 'open'
      if (t < patUntilRef.current) eyes = 'happy'
      if (st === 'success' && elapsed < 1500) eyes = 'happy'

      // —— 本体绘制：图片皮肤 / 像素皮肤 ——
      const imgSrc = skinImage(skinRef.current, formRef.current)
      if (imgSrc) {
        const img = getImage(imgSrc)
        if (img) {
          ctx.imageSmoothingEnabled = true
          const cw = canvas.width
          const chh = canvas.height
          const size = Math.min(cw, chh) * 0.94
          const dx = (cw - size) / 2 + ox * S
          const dy = chh - size - 2 + oy * S
          const squash = t < blink.until ? 0.93 : 1 // 眨眼 = 压扁
          ctx.save()
          ctx.translate(dx + size / 2, dy + size)
          ctx.scale(1, squash)
          if (st === 'thinking') ctx.rotate(Math.sin(t / 900) * 0.06)
          ctx.drawImage(img, -size / 2, -size, size, size)
          ctx.restore()
          if (st === 'working') {
            ctx.font = `${S * 3.5}px sans-serif`
            ctx.fillText('💻', cw / 2 - S * 1.75 + ox * S, chh - 6 + oy * S)
          }
          ctx.imageSmoothingEnabled = false
        }
      } else {
        // 像素皮肤：幼年 / 成年两套 sprite（同一落地线）
        drawPet(ctx, S, { state: st, eyes, tick: t, ox, oy, form: formRef.current })
      }

      // —— 常驻状态粒子 ——
      if (st === 'sleeping' && Math.random() < 0.02) {
        particlesRef.current.push({
          kind: 'z', x: 16, y: 4, vx: 0.008, vy: -0.02,
          born: t, life: 2400, size: 3,
        })
      }
      if (st === 'working' && Math.random() < 0.06) {
        particlesRef.current.push({
          kind: 'spark', x: rand(6, 16), y: rand(13, 16), vx: rand(-0.01, 0.01),
          vy: rand(-0.04, -0.02), born: t, life: 900, size: 2,
        })
      }
      if (st === 'thinking' && Math.random() < 0.012) {
        particlesRef.current.push({
          kind: 'z', x: 17, y: 3, vx: 0.006, vy: -0.015,
          born: t, life: 2000, size: 3,
        })
      }

      // —— 粒子更新与绘制 ——
      particlesRef.current = particlesRef.current.filter((p) => {
        const age = t - p.born
        if (age < 0) return true
        if (age > p.life) return false
        const alpha = 1 - age / p.life
        const gx = p.x + p.vx * age
        const gy = p.y + p.vy * age
        if (p.kind === 'heart') drawParticle(ctx, HEART, gx, gy, p.size, alpha)
        else if (p.kind === 'star') drawParticle(ctx, STAR, gx, gy, p.size, alpha)
        else if (p.kind === 'cookie') {
          if (gy > 16) return false // 落地被吃掉
          ctx.save()
          ctx.fillStyle = '#FFB020'
          ctx.fillRect(gx * S, gy * S, S * 2, S * 2)
          ctx.fillStyle = '#191919'
          ctx.fillRect(gx * S, gy * S, S * 2, S / 2)
          ctx.restore()
        } else {
          // z / spark
          ctx.save()
          ctx.globalAlpha = alpha
          if (p.kind === 'z') {
            ctx.fillStyle = '#2B5CFF'
            ctx.font = `900 ${S * 2.2}px ui-monospace, monospace`
            ctx.fillText(p.kind === 'z' && st === 'thinking' ? '?' : 'Z', gx * S, gy * S)
          } else {
            ctx.fillStyle = Math.random() < 0.5 ? '#9BE83A' : '#2B5CFF'
            ctx.fillRect(gx * S, gy * S, S / 2, S / 2)
          }
          ctx.restore()
        }
        return true
      })

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={GRID_W * S}
      height={GRID_H * S}
      onClick={onPat}
      className="pet-canvas pixelated cursor-pointer select-none"
      style={{ width: GRID_W * S * scale, height: GRID_H * S * scale }}
      aria-label="像素宠物，点击摸头"
      title="点我摸头"
      data-body-rows={BODY.length}
    />
  )
}
