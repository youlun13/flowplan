/**
 * FlowPlan AI 代理（Cloudflare Worker，零相依）
 *
 * 職責：
 *  1. 保管 ANTHROPIC_API_KEY，瀏覽器永遠拿不到
 *  2. 驗證通關密語（FLOWPLAN_PROXY_SECRET）與 Origin allowlist
 *  3. 把「狀況解析」「方案解說」兩種請求轉成 Anthropic Messages API 呼叫，
 *     用 tool_use 強制結構化輸出
 *  4. 把上游錯誤正規化成固定的 error code，讓 App 能明確降級
 *  5. （第四階段）/v1/sync：以 Cloudflare KV 做單一使用者的跨裝置同步，需綁定 FLOWPLAN_KV
 *
 * 不做：寫資料、決定排程、改任務。那些都在 App 端的規則引擎與驗證器。
 */

const DEFAULT_MODEL = 'claude-haiku-5-5';
const ALLOWED_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'];
const MAX_BODY_BYTES = 40_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const INCIDENT_TOOL = {
  name: 'report_incident',
  description: '把使用者描述的狀況轉成結構化事件。只能引用 tasks 清單裡的 id。不確定的欄位留空並列在 missing。',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['overslept', 'lost_time', 'energy', 'task_done', 'overrun', 'rest', 'replan', 'unknown'],
        description:
          'overslept=睡過頭/起床晚了；lost_time=臨時有事或某段時間不能工作；energy=精力/狀態改變；task_done=某任務提早做完；overrun=某任務超時還沒做完；rest=需要休息；replan=只是想重排；unknown=無法判斷',
      },
      wakeTime: { type: 'string', description: 'overslept 用，HH:mm（24 小時制）' },
      startTime: { type: 'string', description: 'lost_time 用，HH:mm' },
      endTime: { type: 'string', description: 'lost_time 用，HH:mm；若使用者只說「少了兩小時」，從現在起算' },
      title: { type: 'string', description: 'lost_time 的事由，簡短' },
      energy: { type: 'string', enum: ['high', 'medium', 'low'] },
      taskId: { type: 'string', description: 'task_done / overrun 用；必須是 tasks 清單中的 id' },
      remainingMinutes: { type: 'integer', description: 'overrun 用：還需要多少分鐘' },
      minutes: { type: 'integer', description: 'rest 用：休息幾分鐘' },
      confidence: { type: 'number', description: '0–1' },
      missing: { type: 'array', items: { type: 'string' }, description: '需要使用者補充的欄位名稱' },
      note: { type: 'string', description: '一句話說明你的理解，繁體中文' },
    },
    required: ['type', 'confidence', 'missing', 'note'],
  },
};

const PARSE_SYSTEM = `你是 FlowPlan 的狀況解析器。使用者會用中文描述今天遇到的狀況。
你唯一的工作是呼叫 report_incident，把描述轉成結構化事件。
規則：
- 只能引用 context.tasks 裡出現的任務 id；找不到對應任務就不要填 taskId，並把 "taskId" 放進 missing。
- 時間一律用 24 小時制 HH:mm；相對時間（「少了兩小時」「再 40 分鐘」）以 context.now 換算。
- 不要發明任務、截止時間或行程；不要給建議；不要改寫使用者的意思。
- 描述含多個狀況時，選最主要的一個，其餘寫在 note。
- 無法判斷就 type=unknown，confidence 給低分。`;

const EXPLAIN_SYSTEM = `你是 FlowPlan 的解說員。輸入是規則引擎已經算好的排程方案（JSON）。
用繁體中文、口語、最多 120 字，說明：現在先做什麼、為什麼、哪些事被縮短或延後、使用者需要決定什麼。
只能根據輸入內容；不要發明任務或時間；不要加入新的建議；不要用條列。`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowedOrigins);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (!env.FLOWPLAN_PROXY_SECRET) return json({ ok: false, error: { code: 'misconfigured', message: 'Worker 尚未設定 FLOWPLAN_PROXY_SECRET' } }, 500, cors);
    if (origin && !allowedOrigins.includes(origin)) return json({ ok: false, error: { code: 'forbidden_origin', message: `來源 ${origin} 不在允許清單` } }, 403, cors);

    const auth = request.headers.get('Authorization') || '';
    if (!safeEqual(auth, `Bearer ${env.FLOWPLAN_PROXY_SECRET}`)) return json({ ok: false, error: { code: 'unauthorized', message: '通關密語不正確' } }, 401, cors);

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return json({ ok: true, result: { hasKey: Boolean(env.ANTHROPIC_API_KEY), model: pickModel(env, undefined), allowedOrigins, sync: Boolean(env.FLOWPLAN_KV) } }, 200, cors);
    }
    if (url.pathname.startsWith('/v1/sync')) {
      const r = await handleSync(request, env, url, json, cors);
      if (r) return r;
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/ai') return json({ ok: false, error: { code: 'not_found', message: '沒有這個路徑' } }, 404, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: { code: 'misconfigured', message: 'Worker 尚未設定 ANTHROPIC_API_KEY' } }, 500, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: { code: 'too_large', message: '請求太大' } }, 413, cors);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: { code: 'bad_request', message: '請求不是有效的 JSON' } }, 400, cors);
    }

    const model = pickModel(env, body.model);
    if (!model) return json({ ok: false, error: { code: 'bad_request', message: '不允許的模型' } }, 400, cors);
    const maxTokens = clampInt(body.maxOutputTokens, 128, intEnv(env.AI_MAX_OUTPUT_TOKENS, 1024), 512);

    let upstreamBody;
    if (body.op === 'parse_incident') {
      if (typeof body.text !== 'string' || !body.text.trim()) return json({ ok: false, error: { code: 'bad_request', message: '缺少 text' } }, 400, cors);
      const ctx = sanitizeContext(body.context);
      upstreamBody = {
        model,
        max_tokens: maxTokens,
        system: PARSE_SYSTEM,
        tools: [INCIDENT_TOOL],
        tool_choice: { type: 'tool', name: 'report_incident' },
        messages: [{ role: 'user', content: `context:\n${JSON.stringify(ctx)}\n\n使用者的描述：\n${body.text.trim().slice(0, 1000)}` }],
      };
    } else if (body.op === 'explain_plan') {
      if (!body.plan || typeof body.plan !== 'object') return json({ ok: false, error: { code: 'bad_request', message: '缺少 plan' } }, 400, cors);
      upstreamBody = {
        model,
        max_tokens: Math.min(maxTokens, 600),
        system: EXPLAIN_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(body.plan).slice(0, 12_000) }],
      };
    } else {
      return json({ ok: false, error: { code: 'bad_request', message: '未知的 op' } }, 400, cors);
    }

    const upstream = await callAnthropic(env.ANTHROPIC_API_KEY, upstreamBody);
    if (!upstream.ok) return json({ ok: false, error: upstream.error }, upstream.status, cors);

    const usage = { inputTokens: upstream.data.usage?.input_tokens ?? 0, outputTokens: upstream.data.usage?.output_tokens ?? 0 };
    if (body.op === 'parse_incident') {
      const tool = (upstream.data.content || []).find((c) => c.type === 'tool_use' && c.name === 'report_incident');
      if (!tool || !tool.input || typeof tool.input !== 'object') {
        return json({ ok: false, error: { code: 'bad_output', message: '模型沒有回傳結構化結果' }, usage, model }, 502, cors);
      }
      return json({ ok: true, result: tool.input, usage, model }, 200, cors);
    }
    const text = (upstream.data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();
    if (!text) return json({ ok: false, error: { code: 'bad_output', message: '模型沒有回傳文字' }, usage, model }, 502, cors);
    return json({ ok: true, result: { text }, usage, model }, 200, cors);
  },
};

/* ------------------------------------ helpers ------------------------------------ */

async function callAnthropic(apiKey, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    return { ok: false, status: 504, error: { code: aborted ? 'timeout' : 'upstream_unreachable', message: aborted ? '上游逾時' : '無法連線到 Anthropic' } };
  }
  clearTimeout(timer);

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok && data) return { ok: true, data };

  const upstreamMessage = (data && data.error && data.error.message) || `HTTP ${res.status}`;
  const detailCode = data && data.error && data.error.details && data.error.details.error_code;
  let code = 'upstream_error';
  let status = 502;
  if (res.status === 401 || res.status === 403) {
    code = 'invalid_key';
    status = 502;
  } else if (res.status === 400 && /credit balance|usage limits/i.test(upstreamMessage)) {
    code = 'no_credits';
    status = 402;
  } else if (res.status === 429) {
    code = detailCode === 'enforced_spend_limit_reached' ? 'spend_limit' : 'rate_limited';
    status = 429;
  } else if (res.status === 529 || res.status >= 500) {
    code = 'upstream_unavailable';
    status = 503;
  } else if (res.status === 400) {
    code = 'bad_request_upstream';
    status = 400;
  }
  return { ok: false, status, error: { code, message: upstreamMessage.slice(0, 300) } };
}

function sanitizeContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const tasks = Array.isArray(c.tasks)
    ? c.tasks.slice(0, 60).map((t) => ({
        id: String(t.id || '').slice(0, 64),
        title: String(t.title || '').slice(0, 120),
        status: String(t.status || '').slice(0, 20),
        estimatedMinutes: Number.isFinite(t.estimatedMinutes) ? t.estimatedMinutes : undefined,
      }))
    : [];
  const events = Array.isArray(c.events)
    ? c.events.slice(0, 30).map((e) => ({ title: String(e.title || '').slice(0, 120), start: String(e.start || '').slice(0, 5), end: String(e.end || '').slice(0, 5) }))
    : [];
  return {
    now: String(c.now || '').slice(0, 5),
    date: String(c.date || '').slice(0, 10),
    timeZone: String(c.timeZone || '').slice(0, 40),
    workStart: String(c.workStart || '').slice(0, 5),
    workEnd: String(c.workEnd || '').slice(0, 5),
    energy: String(c.energy || '').slice(0, 10),
    tasks,
    events,
  };
}

function pickModel(env, requested) {
  const fallback = ALLOWED_MODELS.includes(env.AI_MODEL) ? env.AI_MODEL : DEFAULT_MODEL;
  if (requested === undefined || requested === null || requested === '') return fallback;
  return ALLOWED_MODELS.includes(requested) ? requested : null;
}

function corsHeaders(origin, allowed) {
  const allow = allowed.includes(origin) ? origin : allowed[0] || 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

function parseList(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function intEnv(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return Math.min(fallback, max);
  return Math.max(min, Math.min(max, n));
}

/** 常數時間比較，避免用回應時間猜密語 */
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/* ------------------------------------ 同步 ------------------------------------ */
/**
 * 跨裝置同步（Cloudflare KV，單一使用者）。
 *
 * 資料模型：KV 裡只有一把 key `snapshot`：
 *   { version, updatedAt, records: { tasks: {id: rec}, events, logs, dailyStates, workBlocks, planRevisions, settings }, tombstones: { "table:id": deletedAt } }
 *
 * 合併規則（確定性、可在客戶端重現）：
 *   - 同 id 以 updatedAt 較新者為準（ISO 字串比較）
 *   - tombstone 比該筆 updatedAt 新 → 視為刪除
 *   - 每次 push 成功 version +1；客戶端帶 baseVersion，伺服器無論如何都合併（不拒絕），回傳合併後的完整快照
 *
 * 不做：多使用者、加密（資料以明文存在你自己的 KV）、歷史版本。
 */

const SYNC_TABLES = ['tasks', 'events', 'logs', 'dailyStates', 'workBlocks', 'planRevisions', 'settings'];
const KEY = 'snapshot';
const MAX_PUSH_BYTES = 8_000_000;

function emptySnapshot() {
  const records = {};
  for (const t of SYNC_TABLES) records[t] = {};
  return { version: 0, updatedAt: null, records, tombstones: {} };
}

function idOf(table, rec) {
  return table === 'dailyStates' ? rec.date : rec.id;
}

function stampOf(rec) {
  return typeof rec?.updatedAt === 'string' ? rec.updatedAt : '';
}

/** 純函數：把 changes 合併進 snapshot，回傳新快照與統計 */
function mergeSnapshot(base, changes) {
  const out = { version: base.version, updatedAt: base.updatedAt, records: {}, tombstones: { ...(base.tombstones || {}) } };
  for (const t of SYNC_TABLES) out.records[t] = { ...(base.records?.[t] || {}) };
  const stats = { applied: 0, ignored: 0, deleted: 0 };

  // 先套刪除：tombstone 若比現有紀錄新就刪
  for (const [key, deletedAt] of Object.entries(changes.tombstones || {})) {
    if (typeof deletedAt !== 'string') continue;
    const [table, id] = key.split(':');
    if (!SYNC_TABLES.includes(table) || !id) continue;
    const prevTomb = out.tombstones[key];
    if (prevTomb && prevTomb >= deletedAt) continue;
    out.tombstones[key] = deletedAt;
    const existing = out.records[table][id];
    if (existing && stampOf(existing) <= deletedAt) {
      delete out.records[table][id];
      stats.deleted += 1;
    }
  }

  // 再套 upsert：比現有紀錄新、且沒有更新的 tombstone 才收
  for (const t of SYNC_TABLES) {
    const list = changes.records?.[t];
    if (!list || typeof list !== 'object') continue;
    for (const rec of Object.values(list)) {
      if (!rec || typeof rec !== 'object') continue;
      const id = idOf(t, rec);
      if (!id || typeof id !== 'string') continue;
      const stamp = stampOf(rec);
      const tomb = out.tombstones[`${t}:${id}`];
      if (tomb && tomb >= stamp) {
        stats.ignored += 1;
        continue;
      }
      const existing = out.records[t][id];
      if (existing && stampOf(existing) >= stamp) {
        stats.ignored += 1;
        continue;
      }
      out.records[t][id] = rec;
      stats.applied += 1;
    }
  }
  return { snapshot: out, stats };
}

async function readSnapshot(kv) {
  const raw = await kv.get(KEY, 'json');
  if (!raw || typeof raw !== 'object') return emptySnapshot();
  const snap = emptySnapshot();
  snap.version = Number.isFinite(raw.version) ? raw.version : 0;
  snap.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  for (const t of SYNC_TABLES) snap.records[t] = raw.records?.[t] && typeof raw.records[t] === 'object' ? raw.records[t] : {};
  snap.tombstones = raw.tombstones && typeof raw.tombstones === 'object' ? raw.tombstones : {};
  return snap;
}

function countRecords(snap) {
  const counts = {};
  for (const t of SYNC_TABLES) counts[t] = Object.keys(snap.records[t]).length;
  return counts;
}

/**
 * 路由：
 *   GET    /v1/sync          → { ok, result: { snapshot } }（?since=<version>：若伺服器 version <= since 回 { unchanged: true, version }）
 *   POST   /v1/sync          → body { baseVersion, records, tombstones } → 合併、version+1 → { ok, result: { snapshot, stats } }
 *   DELETE /v1/sync          → 刪除雲端快照
 *   GET    /v1/sync/status   → { ok, result: { configured, version, updatedAt, counts } }
 */
async function handleSync(request, env, url, json, cors) {
  const kv = env.FLOWPLAN_KV;
  if (url.pathname === '/v1/sync/status' && request.method === 'GET') {
    if (!kv) return json({ ok: true, result: { configured: false } }, 200, cors);
    const snap = await readSnapshot(kv);
    return json({ ok: true, result: { configured: true, version: snap.version, updatedAt: snap.updatedAt, counts: countRecords(snap) } }, 200, cors);
  }
  if (url.pathname !== '/v1/sync') return null;
  if (!kv) return json({ ok: false, error: { code: 'sync_not_configured', message: 'Worker 尚未綁定 KV（FLOWPLAN_KV）' } }, 501, cors);

  if (request.method === 'GET') {
    const snap = await readSnapshot(kv);
    const since = Number.parseInt(url.searchParams.get('since') ?? '', 10);
    if (Number.isFinite(since) && snap.version <= since) return json({ ok: true, result: { unchanged: true, version: snap.version } }, 200, cors);
    return json({ ok: true, result: { snapshot: snap } }, 200, cors);
  }

  if (request.method === 'POST') {
    const raw = await request.text();
    if (raw.length > MAX_PUSH_BYTES) return json({ ok: false, error: { code: 'too_large', message: '同步資料太大' } }, 413, cors);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: { code: 'bad_request', message: '請求不是有效的 JSON' } }, 400, cors);
    }
    if (!body || typeof body !== 'object') return json({ ok: false, error: { code: 'bad_request', message: '缺少內容' } }, 400, cors);
    const base = await readSnapshot(kv);
    const { snapshot, stats } = mergeSnapshot(base, { records: body.records || {}, tombstones: body.tombstones || {} });
    const changed = stats.applied + stats.deleted > 0 || Object.keys(body.tombstones || {}).length > 0;
    if (changed) {
      snapshot.version = base.version + 1;
      snapshot.updatedAt = new Date().toISOString();
      await kv.put(KEY, JSON.stringify(snapshot));
    }
    return json({ ok: true, result: { snapshot, stats } }, 200, cors);
  }

  if (request.method === 'DELETE') {
    await kv.delete(KEY);
    return json({ ok: true, result: { deleted: true } }, 200, cors);
  }

  return json({ ok: false, error: { code: 'not_found', message: '沒有這個路徑' } }, 404, cors);
}

export { mergeSnapshot, emptySnapshot, SYNC_TABLES };
