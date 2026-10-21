/**
 * AI 層的型別與邊界。
 * AI 只負責「把中文描述變成結構化事件」與「把方案翻成白話」，永遠不碰資料庫。
 */
import { z } from 'zod';
import type { Energy, Task } from '@/db/schema';
import { HHmmSchema } from '@/db/schema';
import type { Incident } from '@/engine/planner';
import type { PlanProposal } from '@/engine/planner';

/** 模型（或規則解析）回傳的結構化事件；還不是可執行的 Incident，要再經 toIncident 驗證 */
export const ParsedIncidentSchema = z.object({
  type: z.enum(['overslept', 'lost_time', 'energy', 'task_done', 'overrun', 'rest', 'replan', 'unknown']),
  wakeTime: HHmmSchema.optional(),
  startTime: HHmmSchema.optional(),
  endTime: HHmmSchema.optional(),
  title: z.string().max(100).optional(),
  energy: z.enum(['high', 'medium', 'low']).optional(),
  taskId: z.string().max(64).optional(),
  remainingMinutes: z.number().int().min(1).max(24 * 60).optional(),
  minutes: z.number().int().min(1).max(24 * 60).optional(),
  confidence: z.number().min(0).max(1),
  missing: z.array(z.string()).default([]),
  note: z.string().max(500).default(''),
});
export type ParsedIncident = z.infer<typeof ParsedIncidentSchema>;

/** 給模型看的最小必要脈絡（不含描述、備註等私人內容） */
export interface AiContext {
  now: string; // HH:mm
  date: string; // YYYY-MM-DD
  timeZone: string;
  workStart: string;
  workEnd: string;
  energy?: Energy;
  tasks: Array<{ id: string; title: string; status: Task['status']; estimatedMinutes: number }>;
  events: Array<{ title: string; start: string; end: string }>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AiErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'daily_limit'
  | 'unauthorized'
  | 'forbidden_origin'
  | 'misconfigured'
  | 'invalid_key'
  | 'no_credits'
  | 'spend_limit'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_unreachable'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'bad_request'
  | 'bad_request_upstream'
  | 'bad_output'
  | 'bad_response'
  | 'network'
  | 'unknown';

export class AiError extends Error {
  code: AiErrorCode;
  /** 上游或 Worker 給的原始訊息（給除錯看） */
  detail?: string;
  constructor(code: AiErrorCode, detail?: string) {
    super(AI_ERROR_TEXT[code] ?? code);
    this.name = 'AiError';
    this.code = code;
    this.detail = detail;
  }
}

export const AI_ERROR_TEXT: Record<AiErrorCode, string> = {
  disabled: 'AI 助手已關閉',
  not_configured: '還沒設定 Worker 網址或通關密語',
  daily_limit: '今天的 AI 請求已達上限',
  unauthorized: 'Worker 拒絕：通關密語不正確',
  forbidden_origin: 'Worker 拒絕：這個網址不在允許清單',
  misconfigured: 'Worker 還沒設定金鑰或密語',
  invalid_key: 'Anthropic 金鑰無效或已停用',
  no_credits: 'Anthropic 額度已用完，等下個月額度到來或改用規則解析',
  spend_limit: '已達 Anthropic 的每月支出上限',
  rate_limited: '請求太頻繁，稍後再試',
  timeout: 'AI 回應逾時',
  upstream_unreachable: '無法連線到 Anthropic',
  upstream_unavailable: 'Anthropic 暫時無法服務',
  upstream_error: 'Anthropic 回傳錯誤',
  bad_request: '請求格式不正確',
  bad_request_upstream: 'Anthropic 拒絕了這個請求',
  bad_output: 'AI 回傳的內容不是有效的結構，已忽略',
  bad_response: 'Worker 回傳的內容不是有效的 JSON，已忽略',
  network: '網路連線失敗',
  unknown: 'AI 發生未知錯誤',
};

export interface AiProvider {
  readonly name: 'claude';
  parseIncident(text: string, context: AiContext): Promise<{ parsed: ParsedIncident; usage: AiUsage; model: string }>;
  explainPlan(plan: ExplainInput): Promise<{ text: string; usage: AiUsage; model: string }>;
  health(): Promise<{ hasKey: boolean; model: string }>;
}

/** 給解說用的精簡方案（不送整個 proposal，避免私人內容與 token 浪費） */
export interface ExplainInput {
  now: string;
  next?: { title: string; start: string; end: string; reason: string };
  blocks: Array<{ title: string; start: string; end: string; isMinimum: boolean; kept: boolean }>;
  unscheduled: Array<{ title: string; reason: string; suggestion: string }>;
  warnings: string[];
  stats: PlanProposal['stats'];
}

export type ResolvedSource = 'rules' | 'ai';

export interface ResolveResult {
  parsed: ParsedIncident;
  incident?: Incident;
  source: ResolvedSource;
  /** 轉換失敗或 AI 失敗時的說明（給人看） */
  notice?: string;
  usage?: AiUsage;
  model?: string;
}
