/**
 * Host 半：读 DeepSeek 账号余额 + 当前峰谷档，注册 GET /api/usage-printer。
 *
 * 数据来源与旧插件一致：
 *   · 账号令牌来自凭证服务的 grant 记录 `deepseek-account-platform/default`
 *     （payload.token），请求头必须是 `x-dsh-auth-token`，套 Bearer 会被上游 401。
 *   · 余额来自 `GET https://api.deepseek.com/user/balance`。
 *   · 峰谷与单价用 DeepSeek 官方 2026-09-10 的价格表快照：北京时间工作日
 *     09–12、14–18 为峰价，其余（含周末）为谷价。
 */

const ROUTE_PATH = '/api/usage-printer'
const GRANT_KEY = 'deepseek-account-platform/default'
const DEFAULT_MODEL = 'deepseek-flash'
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const CACHE_MS = 30_000
const TZ_OFFSET_MIN = 480

/** 官方峰谷快照（元 / 百万 token）。表里没有的模型一律不显示单价。 */
const PRICES = {
  'deepseek-flash': {
    standard: { input: 2, cacheRead: 0.04, output: 8 },
    offPeak: { input: 1, cacheRead: 0.02, output: 4 },
  },
  'deepseek-v4-pro': {
    standard: { input: 9, cacheRead: 0.3, output: 27 },
    offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
  },
  'deepseek-chat': {
    standard: { input: 2, cacheRead: 0.5, output: 8 },
    offPeak: { input: 2, cacheRead: 0.5, output: 8 },
  },
  'deepseek-reasoner': {
    standard: { input: 4, cacheRead: 1, output: 16 },
    offPeak: { input: 4, cacheRead: 1, output: 16 },
  },
}

const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

const PEAK_WINDOWS = [[9, 12], [14, 18]]

function shanghai(date) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MIN * 60_000)
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
}

function isPeakAt(date) {
  const { day, hour } = shanghai(date)
  if (day === 0 || day === 6) return false
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/** 下一次峰谷切换：逐分钟向前找，最多 8 天。 */
function nextSwitch(date) {
  const current = isPeakAt(date)
  for (let minutes = 1; minutes <= 8 * 24 * 60; minutes += 1) {
    const at = new Date(date.getTime() + minutes * 60_000)
    if (isPeakAt(at) !== current) {
      return { peak: !current, ms: minutes * 60_000, at: at.getTime() }
    }
  }
  return null
}

function modelOf(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    const model = typeof selection?.model === 'string' ? selection.model : ''
    return model || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

function priceOf(model, peak) {
  const key = ALIASES[model] || model
  const entry = PRICES[key]
  if (!entry) return null
  const tier = peak ? entry.standard : entry.offPeak
  return { ...tier, model: key, currency: 'CNY' }
}

async function readGrant(ctx) {
  const readRecord = ctx.credentials?.readRecord
  if (typeof readRecord !== 'function') return null
  try {
    const record = await readRecord.call(ctx.credentials, GRANT_KEY)
    const token = typeof record?.payload?.token === 'string' ? record.payload.token.trim() : ''
    return token === '' ? null : token
  } catch {
    return null
  }
}

async function readBalance(token) {
  const response = await fetch(`${BASE_URL}/user/balance`, {
    headers: { 'x-dsh-auth-token': token, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    const error = new Error(`balance ${response.status}`)
    error.status = response.status
    throw error
  }
  const body = await response.json()
  const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : null
  const total = info ? Number(info.total_balance) : Number.NaN
  return {
    isAvailable: body?.is_available !== false,
    total: Number.isFinite(total) ? total : null,
    currency: typeof info?.currency === 'string' && info.currency.trim() ? info.currency.trim() : 'CNY',
  }
}

let cache = { at: 0, bucket: '', value: null }

async function snapshot(ctx) {
  const now = new Date()
  const peak = isPeakAt(now)
  const model = modelOf(ctx)
  const token = await readGrant(ctx)
  const bucket = `${token ? token.slice(-12) : 'none'}|${model}|${peak}`

  if (cache.value && cache.bucket === bucket && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true }
  }

  const tier = priceOf(model, peak)
  const next = nextSwitch(now)
  const base = {
    ok: true,
    model,
    peak,
    tier,
    next,
    schedule: { offsetMinutes: TZ_OFFSET_MIN, peakWindows: PEAK_WINDOWS },
    updatedAt: Date.now(),
  }

  if (!token) {
    return { ...base, ok: false, code: 'no-grant', message: '未检测到 DeepSeek 账号登录' }
  }

  try {
    const balance = await readBalance(token)
    const value = { ...base, balance }
    cache = { at: Date.now(), bucket, value }
    return value
  } catch (error) {
    const status = error?.status
    return {
      ...base,
      ok: false,
      code: status === 401 || status === 403 ? 'unauthorized' : 'network',
      message: status === 401 || status === 403 ? '登录已失效，请重新登录 DeepSeek 账号' : '暂时读不到余额',
    }
  }
}

/** 只允许本机主机名访问，避免 DNS rebinding / 局域网直连读到余额。 */
function isLocalRequest(req, bindHost) {
  const host = String(req.headers?.host || '').toLowerCase().replace(/:\d+$/, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true
  return bindHost !== '' && host === bindHost.toLowerCase()
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export const inject = ['credentials', 'webServer']

export function apply(ctx) {
  const bindHost = typeof ctx.webServer?.host === 'string' ? ctx.webServer.host : ''
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, code: 'method' })
        }
        if (!isLocalRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, code: 'forbidden' })
        }
        try {
          const data = await snapshot(ctx)
          return sendJson(res, 200, data)
        } catch (error) {
          return sendJson(res, 502, { ok: false, code: 'network', message: String(error?.message || error) })
        }
      },
    }),
    'usage-printer: route',
  )
}
