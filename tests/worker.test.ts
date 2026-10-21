import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error 純 JS Worker，無型別
import worker from '../worker/src/index.js';

const env = {
  ANTHROPIC_API_KEY: 'sk-test',
  FLOWPLAN_PROXY_SECRET: 'passphrase-123',
  ALLOWED_ORIGINS: 'https://youlun13.github.io,http://localhost:5173',
  AI_MODEL: 'claude-haiku-5-5',
  AI_MAX_OUTPUT_TOKENS: '1024',
};

function req(path: string, init: RequestInit & { origin?: string; auth?: boolean } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.origin !== undefined) headers.set('Origin', init.origin);
  if (init.auth !== false) headers.set('Authorization', 'Bearer passphrase-123');
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`https://flowplan-ai.example.workers.dev${path}`, { ...init, headers });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function upstream(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('Worker：存取控制', () => {
  it('沒有通關密語 → 401；錯的來源 → 403；OPTIONS 直接放行', async () => {
    const r1 = await worker.fetch(req('/v1/ai', { method: 'POST', auth: false, body: '{}' }), env);
    expect(r1.status).toBe(401);
    const r2 = await worker.fetch(req('/v1/ai', { method: 'POST', origin: 'https://evil.example', body: '{}' }), env);
    expect(r2.status).toBe(403);
    const r3 = await worker.fetch(req('/v1/ai', { method: 'OPTIONS', origin: 'https://youlun13.github.io' }), env);
    expect(r3.status).toBe(204);
    expect(r3.headers.get('Access-Control-Allow-Origin')).toBe('https://youlun13.github.io');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('沒設密語或金鑰 → 500 misconfigured，不會打上游', async () => {
    const r = await worker.fetch(req('/v1/ai', { method: 'POST', body: '{}' }), { ...env, FLOWPLAN_PROXY_SECRET: '' });
    expect(r.status).toBe(500);
    const r2 = await worker.fetch(req('/v1/ai', { method: 'POST', body: JSON.stringify({ op: 'parse_incident', text: 'x' }) }), { ...env, ANTHROPIC_API_KEY: '' });
    expect((await r2.json()).error.code).toBe('misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('health 回報有無金鑰，不洩漏金鑰本身', async () => {
    const r = await worker.fetch(req('/v1/health'), env);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, result: { hasKey: true, model: 'claude-haiku-5-5' } });
    expect(JSON.stringify(j)).not.toContain('sk-test');
  });
});

describe('Worker：請求驗證', () => {
  it('非法 JSON、未知 op、不允許的模型 → 400', async () => {
    expect((await worker.fetch(req('/v1/ai', { method: 'POST', body: '{nope' }), env)).status).toBe(400);
    expect((await worker.fetch(req('/v1/ai', { method: 'POST', body: JSON.stringify({ op: 'hack' }) }), env)).status).toBe(400);
    expect((await worker.fetch(req('/v1/ai', { method: 'POST', body: JSON.stringify({ op: 'parse_incident', text: 'x', model: 'gpt-9' }) }), env)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Worker：上游呼叫與錯誤正規化', () => {
  it('parse_incident 用 tool_use 強制結構化輸出，並回傳 usage', async () => {
    upstream(200, {
      content: [{ type: 'tool_use', name: 'report_incident', input: { type: 'overslept', wakeTime: '11:00', confidence: 0.9, missing: [], note: '睡到 11 點' } }],
      usage: { input_tokens: 800, output_tokens: 60 },
    });
    const r = await worker.fetch(
      req('/v1/ai', { method: 'POST', origin: 'https://youlun13.github.io', body: JSON.stringify({ op: 'parse_incident', text: '我睡到 11 點', context: { now: '11:05', tasks: [{ id: 'a', title: '線代' }] } }) }),
      env,
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.result.type).toBe('overslept');
    expect(j.usage).toEqual({ inputTokens: 800, outputTokens: 60 });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'report_incident' });
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.max_tokens).toBeLessThanOrEqual(1024);
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('sk-test');
  });

  it('模型沒回 tool_use → 502 bad_output', async () => {
    upstream(200, { content: [{ type: 'text', text: '好的' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await worker.fetch(req('/v1/ai', { method: 'POST', body: JSON.stringify({ op: 'parse_incident', text: 'x' }) }), env);
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe('bad_output');
  });

  it('額度不足 → no_credits；401 → invalid_key；429 → rate_limited / spend_limit；5xx → upstream_unavailable', async () => {
    const body = JSON.stringify({ op: 'parse_incident', text: 'x' });
    upstream(400, { error: { message: 'Your credit balance is too low to access the Anthropic API.' } });
    expect((await (await worker.fetch(req('/v1/ai', { method: 'POST', body }), env)).json()).error.code).toBe('no_credits');
    upstream(401, { error: { message: 'invalid x-api-key' } });
    expect((await (await worker.fetch(req('/v1/ai', { method: 'POST', body }), env)).json()).error.code).toBe('invalid_key');
    upstream(429, { error: { message: 'rate limit' } });
    expect((await (await worker.fetch(req('/v1/ai', { method: 'POST', body }), env)).json()).error.code).toBe('rate_limited');
    upstream(429, { error: { message: 'spend', details: { error_code: 'enforced_spend_limit_reached' } } });
    expect((await (await worker.fetch(req('/v1/ai', { method: 'POST', body }), env)).json()).error.code).toBe('spend_limit');
    upstream(529, { error: { message: 'overloaded' } });
    expect((await (await worker.fetch(req('/v1/ai', { method: 'POST', body }), env)).json()).error.code).toBe('upstream_unavailable');
  });

  it('explain_plan 回傳文字', async () => {
    upstream(200, { content: [{ type: 'text', text: '先做線代，因為今天截止。' }], usage: { input_tokens: 500, output_tokens: 40 } });
    const r = await worker.fetch(req('/v1/ai', { method: 'POST', body: JSON.stringify({ op: 'explain_plan', plan: { blocks: [] } }) }), env);
    const j = await r.json();
    expect(j.result.text).toContain('線代');
  });
});
