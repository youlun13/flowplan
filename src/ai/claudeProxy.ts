/**
 * 透過 Cloudflare Worker 呼叫 Claude。瀏覽器只知道 Worker 網址與通關密語，從不接觸 API key。
 */
import { z } from 'zod';
import { AiError, ParsedIncidentSchema, type AiContext, type AiProvider, type AiUsage, type ExplainInput } from './types';

const REQUEST_TIMEOUT_MS = 30_000;

const ProxyEnvelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  model: z.string().optional(),
});

export interface ClaudeProxyConfig {
  proxyUrl: string;
  proxySecret: string;
  model: string;
  maxOutputTokens: number;
  /** 測試用：自訂 fetch */
  fetchImpl?: typeof fetch;
}

const KNOWN_CODES = new Set([
  'unauthorized',
  'forbidden_origin',
  'misconfigured',
  'invalid_key',
  'no_credits',
  'spend_limit',
  'rate_limited',
  'timeout',
  'upstream_unreachable',
  'upstream_unavailable',
  'upstream_error',
  'bad_request',
  'bad_request_upstream',
  'bad_output',
  'not_found',
  'too_large',
]);

export class ClaudeProxyProvider implements AiProvider {
  readonly name = 'claude' as const;
  private readonly cfg: ClaudeProxyConfig;

  constructor(cfg: ClaudeProxyConfig) {
    this.cfg = cfg;
  }

  private get base(): string {
    return this.cfg.proxyUrl.replace(/\/+$/, '');
  }

  private async call(path: string, init: RequestInit): Promise<z.infer<typeof ProxyEnvelope>> {
    if (!this.cfg.proxyUrl || !this.cfg.proxySecret) throw new AiError('not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await (this.cfg.fetchImpl ?? fetch)(`${this.base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.cfg.proxySecret}`, 'content-type': 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new AiError(e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network');
    }
    clearTimeout(timer);

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new AiError('bad_response');
    }
    const env = ProxyEnvelope.safeParse(raw);
    if (!env.success) throw new AiError('bad_response');
    if (!env.data.ok) {
      const code = env.data.error?.code ?? 'unknown';
      throw new AiError(KNOWN_CODES.has(code) ? (code as AiError['code']) : 'unknown', env.data.error?.message);
      // 註：AiError 的 message 一律是 AI_ERROR_TEXT 的中文；上游訊息放在 detail
    }
    return env.data;
  }

  async health(): Promise<{ hasKey: boolean; model: string }> {
    const r = await this.call('/v1/health', { method: 'GET' });
    const parsed = z.object({ hasKey: z.boolean(), model: z.string() }).safeParse(r.result);
    if (!parsed.success) throw new AiError('bad_response');
    return parsed.data;
  }

  async parseIncident(text: string, context: AiContext): Promise<{ parsed: z.infer<typeof ParsedIncidentSchema>; usage: AiUsage; model: string }> {
    const r = await this.call('/v1/ai', {
      method: 'POST',
      body: JSON.stringify({ op: 'parse_incident', text, context, model: this.cfg.model, maxOutputTokens: this.cfg.maxOutputTokens }),
    });
    const parsed = ParsedIncidentSchema.safeParse(r.result);
    if (!parsed.success) throw new AiError('bad_output');
    return { parsed: parsed.data, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 }, model: r.model ?? this.cfg.model };
  }

  async explainPlan(plan: ExplainInput): Promise<{ text: string; usage: AiUsage; model: string }> {
    const r = await this.call('/v1/ai', {
      method: 'POST',
      body: JSON.stringify({ op: 'explain_plan', plan, model: this.cfg.model, maxOutputTokens: Math.min(this.cfg.maxOutputTokens, 600) }),
    });
    const parsed = z.object({ text: z.string().min(1) }).safeParse(r.result);
    if (!parsed.success) throw new AiError('bad_output');
    return { text: parsed.data.text, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 }, model: r.model ?? this.cfg.model };
  }
}
