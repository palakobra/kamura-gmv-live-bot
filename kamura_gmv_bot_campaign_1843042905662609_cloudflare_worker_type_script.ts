/*
  kamura-gmv-bot — single-campaign build (Cloudflare Worker, TypeScript)
  Campaign: 1843042905662609

  Features
  - /status: show daily GMV Max snapshot (cost, orders, cpo, gross, ROI)
  - /setbudget <angka>: set daily budget; auto-raises to satisfy TikTok 105% rule
  - Telegram webhook verification using X-Telegram-Bot-Api-Secret-Token
  - Basic allowlist + admin override
  - KV cache slots ready for future use (no required entries)

  Required Cloudflare bindings (Dashboard → Workers → Settings → Variables & Secrets):
  - Secrets: BOT_TOKEN, SECRET_TOKEN, TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID, STORE_ID
  - Plaintext: CAMPAIGN_ID (1843042905662609), TZ (e.g., "Asia/Jakarta")
  - JSON (plaintext): ALLOW_USER (e.g., ["7702808040"])
  - Plaintext (optional): ADMIN_CHAT_ID (7702808040)
  And add a KV binding: GMV_STORE → gmv_bot_namespace
*/

export interface Env {
  GMV_STORE: KVNamespace
  BOT_TOKEN: string
  SECRET_TOKEN: string
  TIKTOK_ACCESS_TOKEN: string
  TIKTOK_ADVERTISER_ID: string
  STORE_ID: string
  CAMPAIGN_ID: string
  ALLOW_USER?: string
  ADMIN_CHAT_ID?: string
  TZ?: string
}

const TG_API = (t: string) => `https://api.telegram.org/bot${t}`

const rupiah = (n: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0
}).format(Math.round(n))

function parseAmountIDR(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/rp|\s/g, '').replace(/\./g, '')
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (/^\d+(k|rb)$/.test(s)) return parseInt(s, 10) * 1000
  if (/^\d+(m|jt)$/.test(s)) return parseInt(s, 10) * 1_000_000
  if (/^\d+\.?\d*(m|jt)$/.test(s)) return Math.round(parseFloat(s) * 1_000_000)
  if (/^\d+\.?\d*(k|rb)$/.test(s)) return Math.round(parseFloat(s) * 1_000)
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n) : null
}

function nowInTZ(tz?: string) {
  return tz ? new Date(new Date().toLocaleString('en-US', { timeZone: tz })) : new Date()
}

function enforce105Rule(desired: number, currentSpend: number) {
  const minNow = Math.ceil(currentSpend * 1.05)
  return Math.max(desired, minNow)
}

// ————— TikTok Business API helpers (adjust endpoints if needed) —————
const TIKTOK_BASE = 'https://business-api.tiktok.com'

async function ttFetch(path: string, env: Env, init?: RequestInit) {
  const url = path.startsWith('http') ? path : `${TIKTOK_BASE}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'Access-Token': env.TIKTOK_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`TikTok API ${res.status}: ${text}`)
  }
  return res.json<any>()
}

// NOTE: Replace the endpoints below with the exact ones you already use in your previous bot.
// Shapes are kept generic to stay compatible.

// Pull today snapshot for a single campaign
async function getDailySnapshot(env: Env) {
  const today = new Date().toISOString().slice(0, 10)
  // Example report request. Adjust fields/dimensions to match your working endpoint.
  const payload = {
    advertiser_id: env.TIKTOK_ADVERTISER_ID,
    report_type: 'BASIC',
    data_level: 'AUCTION_CAMPAIGN',
    dimensions: ['campaign_id'],
    metrics: ['spend', 'stat_cost', 'gross_revenue', 'paid_orders', 'roi'],
    start_date: today,
    end_date: today,
    filtering: [{ field_name: 'campaign_id', operator: 'IN', values: [env.CAMPAIGN_ID] }]
  }
  let data: any;
  try {
    data = await ttFetch('/open_api/v1.3/report/integrated/get/', env, { method: 'POST', body: JSON.stringify(payload) })
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg.includes('405')) {
      const qs = new URLSearchParams({
        advertiser_id: String(payload.advertiser_id),
        report_type: payload.report_type,
        data_level: payload.data_level,
        dimensions: JSON.stringify(payload.dimensions),
        metrics: JSON.stringify(payload.metrics),
        start_date: payload.start_date,
        end_date: payload.end_date,
        filtering: JSON.stringify(payload.filtering)
      }).toString()
      data = await ttFetch(`/open_api/v1.3/report/integrated/get/?${qs}`, env, { method: 'GET' })
    } else {
      throw e
    }
  }
  const row = data?.data?.list?.[0] || {}
  // normalize possible field names
  const cost = Number(row.spend ?? row.stat_cost ?? 0)
  const orders = Number(row.paid_orders ?? row.order ?? 0)
  const gross = Number(row.gross_revenue ?? row.gmv ?? 0)
  const cpo = orders > 0 ? cost / orders : 0
  const roi = cost > 0 ? (gross / cost) * 100 : 0
  return { cost, orders, gross, cpo, roi }
}

// Read current daily budget of the campaign
async function getDailyBudget(env: Env) {
  const q = {
    advertiser_id: env.TIKTOK_ADVERTISER_ID,
    campaign_ids: [env.CAMPAIGN_ID]
  }
  const data = await ttFetch(`/open_api/v1.3/campaign/get/?advertiser_id=${encodeURIComponent(q.advertiser_id)}&campaign_ids=${encodeURIComponent(JSON.stringify(q.campaign_ids))}`, env)
  const item = data?.data?.list?.[0]
  const budget = Number(item?.budget ?? item?.daily_budget ?? 0)
  return { budget }
}

// Update daily budget (respecting 105% rule is handled before calling this)
async function setDailyBudget(env: Env, newBudget: number) {
  const payload = {
    advertiser_id: env.TIKTOK_ADVERTISER_ID,
    campaign_id: env.CAMPAIGN_ID,
    budget_mode: 'BUDGET_MODE_DAY',
    budget: Math.round(newBudget)
  }
  const data = await ttFetch('/open_api/v1.3/campaign/update/', env, { method: 'POST', body: JSON.stringify(payload) })
  return data
}

// ————— Telegram helpers —————
async function tgSend(env: Env, chat_id: number | string, text: string, opts: any = {}) {
  const res = await fetch(`${TG_API(env.BOT_TOKEN)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts })
  })
  return res.json<any>()
}

function isAllowed(env: Env, fromId?: number): boolean {
  if (!fromId) return false
  try {
    if (env.ADMIN_CHAT_ID && String(fromId) === String(env.ADMIN_CHAT_ID)) return true
    const allow = JSON.parse(env.ALLOW_USER || '[]')
    return allow.map((x: any) => String(x)).includes(String(fromId))
  } catch { return false }
}

function formatStatus(ts: Date, snap: { cost: number; orders: number; cpo: number; gross: number; roi: number }, budget: number) {
  const time = ts.toLocaleString('id-ID', { hour12: false })
  return [
    '✅ <b>Laporan Campaign Harian</b>',
    `Waktu: <b>${time} WIB</b>`,
    '----------------',
    '🧮 <b>Performa</b>',
    `• Total Biaya (Cost): <b>${rupiah(snap.cost)}</b>`,
    `• Total Order: <b>${snap.orders}</b>`,
    `• Biaya per Order: <b>${rupiah(snap.cpo)}</b>`,
    `• Pendapatan Kotor: <b>${rupiah(snap.gross)}</b>`,
    `• ROI: <b>${snap.roi.toFixed(2)}%</b>`,
    '----------------',
    '⚙️ <b>Pengaturan</b>',
    `• Budget Harian: <b>${rupiah(budget)}</b>`
  ].join('\n')
}

async function handleStatus(env: Env, chat_id: number) {
  const [snap, budget] = await Promise.all([
    getDailySnapshot(env),
    getDailyBudget(env)
  ])
  const text = formatStatus(nowInTZ(env.TZ), { ...snap }, budget.budget)
  await tgSend(env, chat_id, text)
}

async function handleSetBudget(env: Env, chat_id: number, args: string[]) {
  if (!args.length) return tgSend(env, chat_id, 'Format: <code>/setbudget &lt;angka-IDR&gt;</code> (contoh: <code>/setbudget 175.000</code>)')
  const desired = parseAmountIDR(args.join(' '))
  if (!desired || desired <= 0) return tgSend(env, chat_id, 'Nominal tidak valid. Coba seperti <code>/setbudget 180.000</code> atau <code>200k</code>.')
  const [snap, cur] = await Promise.all([ getDailySnapshot(env), getDailyBudget(env) ])
  if (desired < cur.budget) {
    await tgSend(env, chat_id, `❌ Tidak boleh menurunkan budget dari ${rupiah(cur.budget)} pada hari yang sama.`)
    return
  }
  const effective = enforce105Rule(desired, snap.cost)
  if (effective !== desired) {
    await tgSend(env, chat_id, `🧯 Aturan 105% aktif. Budget diangkat dari ${rupiah(desired)} → <b>${rupiah(effective)}</b> (spend saat ini ${rupiah(snap.cost)}).`)
  }
  try {
    await tgSend(env, chat_id, `🧑‍🏭 Mengatur budget campaign menjadi <b>${rupiah(effective)}</b>…`)
    await setDailyBudget(env, effective)
    await tgSend(env, chat_id, `✅ Budget campaign berhasil diperbarui!`)
  } catch (e: any) {
    await tgSend(env, chat_id, `❌ Gagal mengatur budget. Pesan: <code>${(e?.message || e).toString().slice(0, 500)}</code>`) 
  }
}

// ————— Router —————
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // Health
    if (url.pathname === '/') {
      return new Response('ok', { status: 200 })
    }

    if (url.pathname === '/telegram-webhook' && req.method === 'POST') {
      // Verify secret header
      const sec = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || ''
      if (!env.SECRET_TOKEN || sec !== env.SECRET_TOKEN) {
        return new Response('forbidden', { status: 403 })
      }

      const update = await req.json<any>()
      const msg = update.message || update.edited_message
      const chat_id: number | undefined = msg?.chat?.id
      const from_id: number | undefined = msg?.from?.id
      const text: string = msg?.text || ''

      if (!chat_id || !from_id) return new Response('ok')
      if (!isAllowed(env, from_id)) {
        await tgSend(env, chat_id, '🚫 Kamu tidak diizinkan menjalankan bot ini.')
        return new Response('ok')
      }

      const [cmd, ...args] = text.trim().split(/\s+/)
      if (cmd === '/start') {
        await tgSend(env, chat_id, 'Halo! Gunakan /status untuk laporan harian, dan /setbudget &lt;angka&gt; untuk ubah budget.')
      } else if (cmd === '/status') {
        await tgSend(env, chat_id, '⏳ Sedang mengambil data campaign…')
        try {
          await handleStatus(env, chat_id)
        } catch (err: any) {
          await tgSend(env, chat_id, '❌ Gagal mengambil laporan. Coba lagi.
<code>' + String(err?.message || err).slice(0, 500) + '</code>')
        }
      } else if (cmd === '/setbudget') {
        await handleSetBudget(env, chat_id, args)
      } else {
        await tgSend(env, chat_id, 'Perintah tidak dikenal. Coba /status atau /setbudget &lt;angka&gt;')
      }

      return new Response('ok')
    }

    return new Response('not found', { status: 404 })
  }
} satisfies ExportedHandler<Env>
