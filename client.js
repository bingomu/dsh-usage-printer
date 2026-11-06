window.__ModuleLoader__.load({
  id: '@bingomu/dsh-usage-printer',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /* ── 3×5 点阵字形 ─────────────────────────────────────── */
    const GLYPHS = {
      0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
      1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
      2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
      3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
      4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
      5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
      6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
      7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
      8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
      9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
      '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    }

    function dotNumber(text, size = 24, extra = 1.4) {
      const px = 1.6
      const gap = 1.0
      const pitch = px + gap
      const chars = String(text).split('')
      const rects = []
      let x = 0
      for (const ch of chars) {
        const glyph = GLYPHS[ch]
        if (!glyph) {
          x += 5 * pitch + extra
          continue
        }
        for (let row = 0; row < glyph.length; row += 1) {
          for (let col = 0; col < glyph[row].length; col += 1) {
            if (glyph[row][col] === '1') {
              rects.push(h('rect', {
                key: `${x}-${row}-${col}`,
                x: x + col * pitch,
                y: row * pitch,
                width: px,
                height: px,
                rx: 0.35,
              }))
            }
          }
        }
        x += 5 * pitch + extra
      }
      const width = x - pitch - extra
      const height = 7 * pitch - gap
      return h('svg', {
        className: 'up-dotnum',
        viewBox: `0 0 ${width} ${height}`,
        height: size,
        fill: 'currentColor',
        'aria-hidden': 'true',
      }, rects)
    }

    /* ── 峰谷带 ───────────────────────────────────────────── */
    const W = 240
    const H = 20
    const PEAK_Y = 3.5
    const VALLEY_Y = 14.5

    function isPeakAt(date, schedule) {
      const offset = schedule?.offsetMinutes ?? 480
      const windows = schedule?.peakWindows ?? [[9, 12], [14, 18]]
      const shifted = new Date(date.getTime() + offset * 60_000)
      const day = shifted.getUTCDay()
      if (day === 0 || day === 6) return false
      const hour = shifted.getUTCHours()
      return windows.some(([from, to]) => hour >= from && hour < to)
    }

    function localMinutes(date, schedule) {
      const offset = schedule?.offsetMinutes ?? 480
      const shifted = new Date(date.getTime() + offset * 60_000)
      return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
    }

    function bandPath(schedule) {
      const x = (minutes) => (minutes / 1440) * W
      const points = []
      for (let hour = 0; hour < 24; hour += 1) {
        const start = hour * 60
        const end = start + 60
        const peak = isPeakAt(new Date(Date.UTC(2026, 0, 5, 0, 0, 0) + start * 60_000), schedule)
        const y = peak ? PEAK_Y : VALLEY_Y
        points.push({ x0: x(start), x1: x(end), y })
      }
      let d = `M${points[0].x0},${points[0].y}`
      for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1]
        const point = points[i]
        if (point.y !== prev.y) d += ` H${point.x0} V${point.y}`
      }
      d += ` H${W}`
      return d
    }

    const BASE_BAND = bandPath(null)

    /* ── 数据 ─────────────────────────────────────────────── */
    const PEAK_KEY = 'dsh-usage-printer:peak'
    const SAMPLES_KEY = 'dsh-usage-printer:samples'

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        return fallback
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage?.setItem(key, JSON.stringify(value))
      } catch {}
    }

    /**
     * 预充值基准 = 这一轮的起点水位（插件第一次看到你时的余额；之后只在你充值变多时更新）。
     * DeepSeek 不提供充值流水，所以这个数只能来自插件自己的观测，不需要用户填任何东西。
     */
    function usePeakLevel(balance) {
      const [peak, setPeak] = useState(() => {
        const raw = Number(readJson(PEAK_KEY, 0))
        return Number.isFinite(raw) && raw > 0 ? raw : 0
      })
      useEffect(() => {
        if (typeof balance !== 'number') return
        setPeak((current) => {
          if (current > 0 && balance <= current) return current
          const next = Math.max(balance, 0.01)
          writeJson(PEAK_KEY, next)
          return next
        })
      }, [balance])
      return peak
    }

    const LEDGER_KEY = 'dsh-usage-printer:ledger'

    function dayKey(ts) {
      const d = new Date(ts)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /**
     * 余额样本 + 每日账本。
     * 花费 = 两次采样之间的余额下降量；间隔超过 30 分钟视为「未观测区间」，
     * 该天的数字会打上 ~ 前缀，而不是假装精确。
     */
    function useUsageHistory(balance) {
      const [state, setState] = useState({ days: null, today: 0, month: 0, gap: false })
      useEffect(() => {
        if (typeof balance !== 'number') return
        const now = Date.now()
        const samples = readJson(SAMPLES_KEY, [])
        const list = Array.isArray(samples) ? samples : []
        const last = list[list.length - 1]
        const ledger = readJson(LEDGER_KEY, {})
        const books = ledger && typeof ledger === 'object' ? ledger : {}

        if (!last || now - last.t > 10 * 60_000) {
          if (last && balance < last.v) {
            const key = dayKey(now)
            const cell = books[key] || { spend: 0, gap: false }
            cell.spend += last.v - balance
            if (now - last.t > 30 * 60_000) cell.gap = true
            books[key] = cell
            for (const k of Object.keys(books)) {
              if (now - new Date(`${k}T00:00:00`).getTime() > 120 * 864e5) delete books[k]
            }
            writeJson(LEDGER_KEY, books)
          }
          writeJson(SAMPLES_KEY, [...list, { t: now, v: balance }].slice(-400))
        }

        const today = dayKey(now)
        const month = today.slice(0, 7)
        let todaySpend = 0
        let monthSpend = 0
        for (const [key, cell] of Object.entries(books)) {
          const value = Number(cell?.spend) || 0
          if (key === today) todaySpend = value
          if (key.startsWith(month)) monthSpend += value
        }

        let days = null
        const kept = list.filter((sample) => now - sample.t < 7 * 864e5)
        if (kept.length >= 3) {
          const first = kept[0]
          const spanDays = (now - first.t) / 864e5
          const drop = first.v - balance
          if (spanDays >= 0.15 && drop > 0) days = balance / (drop / spanDays)
        }

        setState({ days, today: todaySpend, month: monthSpend, gap: Boolean(books[today]?.gap) })
      }, [balance])
      return state
    }

    function useSnapshot() {
      const [state, setState] = useState({ phase: 'loading', data: null })
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const response = await fetch('/api/usage-printer', { headers: { accept: 'application/json' } })
          const data = await response.json()
          if (alive.current) setState({ phase: 'ready', data })
        } catch {
          if (alive.current) setState({ phase: 'error', data: null })
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = window.setInterval(load, 30_000)
        const onVisible = () => {
          if (document.visibilityState === 'visible') load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive.current = false
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      return state
    }

    /* ── 文案 ─────────────────────────────────────────────── */
    function money(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      const symbol = currency === 'CNY' || !currency ? '¥' : `${currency} `
      return `${symbol}${value.toFixed(2)}`
    }

    /** 金额拆成主数字（元，整数）与副数字（角分），上限百万。 */
    function splitAmount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      const capped = Math.min(Math.max(value, 0), 9_999_999.99)
      const major = Math.floor(capped).toString()
      const minor = Math.round((capped - Math.floor(capped)) * 100).toString().padStart(2, '0')
      return { major, minor, overflow: value > 9_999_999.99 }
    }

    function tierName(peak) {
      return peak ? '峰价' : '谷价'
    }

    function countdown(next) {
      if (!next || typeof next.ms !== 'number') return '--'
      const total = Math.max(0, Math.round(next.ms / 60_000))
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}` : `${minutes} 分`
    }

    function priceText(tier) {
      if (!tier) return ['--', '--', '--']
      const fmt = (value) => (Number.isFinite(value) ? value.toFixed(2) : '--')
      return [fmt(tier.input), fmt(tier.cacheRead), fmt(tier.output)]
    }

    /* ── 小票 ─────────────────────────────────────────────── */
    function Row({ label, value, head }) {
      return h('div', { className: head ? 'up-row up-row-head' : 'up-row' },
        h('span', null, label),
        h('b', null, value),
      )
    }

    function Receipt({ data, runway, peak, history }) {
      const ok = data && data.ok !== false
      const balance = ok ? data.balance : null
      const tier = ok ? data.tier : null
      const [input, cache, output] = priceText(tier)
      const head = h('div', { key: 'b', className: 'up-head' },
        h('div', { className: 'up-row up-row-head' },
          h('span', null, '余额'),
          h('b', null, ok ? money(balance?.total, balance?.currency) : '--'),
        ),
        ok && peak > 0 && h('div', {
          className: 'up-row up-row-sub',
          title: '这一轮充值的起点：插件第一次读到你的余额；你充值后会自动更新',
        },
          h('span', null, '已充值'),
          h('b', null, money(peak, balance?.currency)),
        ),
      )
      const rows = ok
        ? [
            head,
            h('div', { key: 'c1', className: 'up-cut' }),
            h(Row, { key: 't', label: '时段', value: tierName(data.peak) }),
            h(Row, { key: 'n', label: data.next?.peak ? '转峰' : '转谷', value: `${countdown(data.next)} 后` }),
            runway != null && h(Row, { key: 'r', label: '可用', value: `约 ${Math.max(1, Math.round(runway))} 天` }),
            history && (history.today > 0 || history.month > 0) && h(Row, {
              key: 'td',
              label: '今日',
              value: `${history.gap ? '~' : ''}${money(history.today, balance?.currency)}`,
            }),
            history && history.month > 0 && h(Row, {
              key: 'mo',
              label: '本月',
              value: `${history.gap ? '~' : ''}${money(history.month, balance?.currency)}`,
            }),
            h(Row, { key: 'i', label: '输入', value: input }),
            h(Row, { key: 'r2', label: '缓存', value: cache }),
            h(Row, { key: 'o', label: '输出', value: output }),
          ]
        : [
            head,
            h('div', { key: 'c1', className: 'up-cut' }),
            h(Row, { key: 's', label: '状态', value: data?.message || '暂不可用' }),
          ]
      return h('div', { className: 'up-receipt' },
        h('div', { className: 'up-tear-wrap' }, h('div', { className: 'up-tear' })),
        h('div', { className: 'up-paper' },
          ...rows,
          h('div', { className: 'up-cut' }),
          h('div', { className: 'up-foot' },
            h('span', null, (data?.model || 'deepseek').toUpperCase()),
            h('span', null, '¥ / 百万 TOKEN'),
            h('a', {
              className: 'up-link',
              href: 'https://platform.deepseek.com/top_up',
              target: '_blank',
              rel: 'noopener noreferrer',
              title: '在浏览器打开 DeepSeek 官方充值页',
              onClick: (event) => event.stopPropagation(),
            }, '充值 ↗'),
          ),
        ),
      )
    }

    /* ── 卡片 ─────────────────────────────────────────────── */
    function Card({ wide }) {
      const { phase, data } = useSnapshot()
      const [pinned, setPinned] = useState(false)
      const [dismissed, setDismissed] = useState(false)
      const [rect, setRect] = useState(null)
      const cardRef = useRef(null)

      // 小票用 fixed 定位，避开侧栏容器的 overflow 裁剪。
      const placeReceipt = useCallback(() => {
        const el = cardRef.current
        if (el) setRect(el.getBoundingClientRect())
      }, [])

      useEffect(() => {
        if (!pinned) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setPinned(false)
          setDismissed(true)
        }
        const onDown = (event) => {
          const el = cardRef.current
          if (el && !el.contains(event.target)) setPinned(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onDown, true)
        }
      }, [pinned])
      const balance = data && data.ok !== false ? data.balance?.total : null
      const peakLevel = usePeakLevel(typeof balance === 'number' ? balance : null)
      const history = useUsageHistory(typeof balance === 'number' ? balance : null)
      const runway = history.days
      const ready = typeof balance === 'number' && peakLevel > 0
      const pct = ready ? Math.max(0, Math.min(100, Math.round((balance / peakLevel) * 100))) : null
      const peak = Boolean(data?.peak)
      const band = data?.schedule ? bandPath(data.schedule) : BASE_BAND

      const now = new Date()
      const nowX = (localMinutes(now, data?.schedule) / 1440) * W
      const nowY = peak ? PEAK_Y : VALLEY_Y

      const failed = phase === 'error' || (data && data.ok === false)
      const lit = ready ? pct : 0
      const amountParts = failed || phase === 'loading' ? null : splitAmount(balance)
      const digitsCount = amountParts ? amountParts.major.length : 2
      const scale = wide ? 1 : 0.5
      const majorSize = (digitsCount <= 4 ? 25 : digitsCount === 5 ? 21 : 18) * scale
      const minorSize = (digitsCount <= 4 ? 16 : digitsCount === 5 ? 14 : 12) * scale

      const body = h('div', { className: `up-card${peak ? ' up-peak' : ''}${phase === 'error' || (data && data.ok === false) ? ' up-off' : ''}` },
        h('div', {
          className: 'up-sheet',
          onClick: (event) => event.stopPropagation(),
          style: rect
            ? { position: 'fixed', left: `${rect.left}px`, width: `${rect.width}px`,
                bottom: `${Math.round(window.innerHeight - rect.top + 5)}px`, right: 'auto', top: 'auto' }
            : undefined,
        }, h(Receipt, { data, runway, peak: peakLevel, history })),
        h('div', { className: 'up-sliver' }),
        h('div', { className: 'up-body' },
          h('div', { className: 'up-mouth' }),
          h('div', { className: 'up-screen' },
            h('div', { className: 'up-leds' }),
            h('div', { className: 'up-leds up-lit', style: { clipPath: `inset(0 ${100 - lit}% 0 0)` } }),
            h('div', { className: 'up-top' },
              h('span', { className: 'up-amount' },
                h('i', { className: 'up-cur' }, '¥'),
                dotNumber(amountParts ? amountParts.major : '--', majorSize),
                amountParts && h('span', { className: 'up-dec' },
                  h('i', { className: 'up-point' }, '.'),
                  dotNumber(amountParts.minor, minorSize),
                ),
              ),
              h('span', { className: 'up-tier' }, failed ? '暂停' : peak ? '峰价' : '谷价'),
            ),
            h('svg', {
              className: 'up-band',
              viewBox: `0 0 ${W} ${H}`,
              preserveAspectRatio: 'none',
              'aria-hidden': 'true',
            },
              h('path', { className: 'up-halo', d: band }),
              h('path', { className: 'up-line', d: band }),
              h('line', { className: 'up-tick', x1: nowX, x2: nowX, y1: nowY, y2: H }),
              h('circle', { className: 'up-dot', cx: nowX, cy: nowY, r: 2 }),
            ),
          ),
        ),
      )

      const label = ready
        ? `账户余额 ${money(balance, data?.balance?.currency)}，${tierName(peak)}`
        : '账户用量'
      return h('div', {
        ref: cardRef,
        className: `up-wrap${wide ? '' : ' up-rail'}${pinned ? ' up-pinned' : ''}${dismissed ? ' up-dismissed' : ''}`,
        title: label,
        role: 'button',
        tabIndex: 0,
        'aria-label': label,
        onMouseEnter: () => {
          setDismissed(false)
          placeReceipt()
        },
        onMouseLeave: () => setDismissed(false),
        onFocus: placeReceipt,
        onClick: () => {
          if (dismissed) {
            setDismissed(false)
            setPinned(true)
            placeReceipt()
            return
          }
          if (pinned) {
            setPinned(false)
            setDismissed(true)
            return
          }
          setPinned(true)
          placeReceipt()
        },
      }, body)
    }

    /* ── 样式 ─────────────────────────────────────────────── */
    const CSS = `
.up-wrap{flex:1 0 100%;
  --up-ink:var(--dsw-alias-label-primary,#1b221e);
  --up-ink2:var(--dsw-alias-label-secondary,#5d6260);
  --up-ink3:var(--dsw-alias-label-tertiary,#8b8f8c);
  --up-surface:var(--dsw-alias-bg-layer-1,#f9fbf8);
  --up-line:var(--dsw-alias-border-l1,rgba(18,26,22,.08));
  --up-gold:#c09a3e;--up-red:#c06a5e;
  --up-screen:rgba(18,26,22,.035);--up-screen-solid:#eef1ec;
  --up-mouth:rgba(18,26,22,.17);--up-dot:rgba(18,26,22,.075);
  position:relative;width:100%;max-width:264px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;
  cursor:pointer;outline:none}
.up-wrap:focus-visible .up-body{box-shadow:0 0 0 2px var(--up-gold)}
:is(html,body)[data-ds-dark-theme] .up-wrap{
  --up-gold:#c9a86a;--up-red:#c47f72;
  --up-screen:rgba(255,255,255,.03);--up-screen-solid:#1d2521;--up-mouth:rgba(0,0,0,.55);--up-dot:rgba(255,255,255,.10)}
.up-wrap .up-card{position:relative;--up-led:var(--up-gold)}
.up-wrap .up-card.up-peak{--up-led:var(--up-red)}
.up-wrap .up-body{position:relative;z-index:2;background:var(--up-surface);border:1px solid var(--up-line);
  border-radius:11px;box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 3px 8px -6px rgba(12,20,17,.3)}
:is(html,body)[data-ds-dark-theme] .up-wrap .up-body{box-shadow:none}
.up-wrap .up-mouth{height:5px;margin:6px 7px 0;border-radius:2.5px;background:var(--up-mouth);
  box-shadow:inset 0 1.5px 2px -.5px rgba(0,0,0,.4),0 1px 0 rgba(255,255,255,.45)}
.up-wrap .up-sliver{position:absolute;z-index:1;left:15px;right:15px;bottom:calc(100% - 7px);height:6px;
  background:var(--up-surface);border:1px solid var(--up-line);border-bottom:0;border-radius:3px 3px 0 0}
.up-wrap .up-screen{position:relative;margin:8px 9px 10px;background:var(--up-screen);border-radius:6px;padding:8px 9px;overflow:hidden}
.up-wrap .up-leds{position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(circle at 1px 1px,var(--up-dot) 1px,transparent 1.1px);background-size:5px 5px;background-position:1px 2px}
.up-wrap .up-leds.up-lit{background-image:radial-gradient(circle at 1px 1px,var(--up-led) 1.15px,transparent 1.25px);opacity:.30}
.up-wrap .up-top{position:relative;z-index:3;display:flex;align-items:flex-end;justify-content:space-between}
.up-wrap .up-amount{display:flex;align-items:flex-end;gap:2px;color:var(--up-ink);min-width:0}
.up-wrap .up-cur{font-style:normal;font-size:9px;font-weight:600;color:var(--up-ink3);margin-bottom:4px;margin-right:2px}
.up-wrap .up-dec{display:flex;align-items:flex-end;gap:1px;color:var(--up-ink2);margin-bottom:3px;margin-left:3px}
.up-wrap .up-point{font-style:normal;font-size:9px;font-weight:700;color:var(--up-ink2);margin-bottom:2px}
.up-wrap .up-dotnum{display:block;fill:currentColor}
.up-wrap .up-tier{font-size:9px;letter-spacing:.14em;color:var(--up-led);font-weight:500;padding-bottom:5px;white-space:nowrap}
.up-wrap .up-band{position:relative;z-index:2;display:block;width:100%;height:20px;margin-top:4px}
.up-wrap .up-halo{fill:none;stroke:var(--up-screen-solid);stroke-width:4.5;stroke-linecap:round;stroke-linejoin:round}
.up-wrap .up-line{fill:none;stroke:var(--up-led);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.up-wrap .up-dot{fill:var(--up-led)}
.up-wrap .up-tick{stroke:var(--up-led);stroke-width:1;opacity:.3}
.up-wrap .up-sheet{position:absolute;z-index:5;left:0;right:0;bottom:calc(100% - 5px);transform:translateY(8px);
  clip-path:inset(100% 0 0 0);opacity:0;pointer-events:none;
  transition:clip-path .34s cubic-bezier(.2,.8,.25,1),transform .34s cubic-bezier(.2,.8,.25,1),opacity .14s ease}
.up-wrap:hover .up-sheet,.up-wrap:focus-within .up-sheet,.up-wrap.up-pinned .up-sheet{clip-path:inset(0 0 0 0);transform:translateY(3px);opacity:1;pointer-events:auto}
.up-wrap.up-dismissed:hover .up-sheet,
.up-wrap.up-dismissed:focus-within .up-sheet{clip-path:inset(100% 0 0 0);transform:translateY(8px);opacity:0;pointer-events:none}
.up-wrap .up-receipt{position:relative;filter:drop-shadow(0 -3px 8px rgba(12,20,17,.12))}
.up-wrap .up-tear-wrap{position:relative;height:3px}
.up-wrap .up-tear{position:absolute;left:0;right:0;top:0;bottom:0;background:var(--up-surface);
  clip-path:polygon(0 0,1.25% 100%,2.5% 0,3.75% 100%,5% 0,6.25% 100%,7.5% 0,8.75% 100%,10% 0,11.25% 100%,12.5% 0,13.75% 100%,15% 0,16.25% 100%,17.5% 0,18.75% 100%,20% 0,21.25% 100%,22.5% 0,23.75% 100%,25% 0,26.25% 100%,27.5% 0,28.75% 100%,30% 0,31.25% 100%,32.5% 0,33.75% 100%,35% 0,36.25% 100%,37.5% 0,38.75% 100%,40% 0,41.25% 100%,42.5% 0,43.75% 100%,45% 0,46.25% 100%,47.5% 0,48.75% 100%,50% 0,51.25% 100%,52.5% 0,53.75% 100%,55% 0,56.25% 100%,57.5% 0,58.75% 100%,60% 0,61.25% 100%,62.5% 0,63.75% 100%,65% 0,66.25% 100%,67.5% 0,68.75% 100%,70% 0,71.25% 100%,72.5% 0,73.75% 100%,75% 0,76.25% 100%,77.5% 0,78.75% 100%,80% 0,81.25% 100%,82.5% 0,83.75% 100%,85% 0,86.25% 100%,87.5% 0,88.75% 100%,90% 0,91.25% 100%,92.5% 0,93.75% 100%,95% 0,96.25% 100%,97.5% 0,98.75% 100%)}
.up-wrap .up-paper{background:var(--up-surface);border:1px solid var(--up-line);border-top:0;
  padding:11px 13px 10px;font-family:"SF Mono",ui-monospace,SFMono-Regular,monospace}
.up-wrap .up-row{display:flex;justify-content:space-between;align-items:baseline;font-size:10px;color:var(--up-ink3)}
.up-wrap .up-row+.up-row{margin-top:5px}
.up-wrap .up-row b{font-size:11px;font-weight:500;color:var(--up-ink);letter-spacing:-.02em}
.up-wrap .up-row-head b{font-size:14px;font-weight:600}
.up-wrap .up-head .up-row+.up-row{margin-top:2px}
.up-wrap .up-link{font-size:7.5px;letter-spacing:.12em;color:var(--up-ink3);text-decoration:none;
  transition:color .15s ease}
.up-wrap .up-link:hover,.up-wrap .up-link:focus-visible{color:var(--up-ink);text-decoration:underline;
  text-underline-offset:2px;outline:none}
.up-wrap .up-row-sub b{font-size:14px;font-weight:400;letter-spacing:0}
.up-wrap .up-cut{height:1px;border-top:1px dashed var(--up-line);margin:9px 0 8px}
.up-wrap .up-foot{display:flex;justify-content:space-between;gap:10px;font-size:7.5px;color:var(--up-ink3);letter-spacing:.12em;white-space:nowrap}
.up-wrap.up-off .up-line,.up-wrap.up-off .up-dot,.up-wrap.up-off .up-tick{opacity:.25}
.up-wrap.up-off .up-tier{color:var(--up-ink3)}
.up-rail{max-width:34px;flex:0 0 auto}
.up-rail .up-body{border-radius:9px}
.up-rail .up-screen{margin:5px;padding:0;height:22px;display:flex;align-items:center;justify-content:center}
.up-rail .up-top{justify-content:center;width:100%}
.up-rail .up-tier,.up-rail .up-band,.up-rail .up-mouth,.up-rail .up-sliver{display:none}
.up-rail .up-pct{gap:0}
.up-rail .up-pct i{font-size:7px;margin-bottom:1px}
div[class*="footerActions"]{flex-wrap:wrap}
`

    let cssInjected = false
    function injectStyles() {
      if (cssInjected) return
      cssInjected = true
      if (document.querySelector('style[data-plugin-css="dsh-usage-printer"]')) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-usage-printer'
      style.dataset.pluginCss = 'dsh-usage-printer'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        injectStyles()
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-usage-printer', order: 101, label: '账户用量' },
          (props) => h(Card, { wide: props.wide }),
        ))
      },
    }
  },
})
