/**
 * 自然語言 → 事件的降級鏈：
 *   1. 規則解析（零成本）夠確定 → 直接用
 *   2. AI 已啟用且未達每日上限 → 呼叫 Worker；輸出經 Zod 與 task id 核對
 *   3. AI 失敗或關閉 → 用規則解析的結果（即使不夠確定），並附上說明
 * 不論哪條路，結果都只是「理解到的狀態」，要使用者確認後才進規則引擎。
 */
import { ClaudeProxyProvider } from './claudeProxy';
import { nlParse } from './nlParse';
import { parsedToIncident } from './toIncident';
import { AiError, type AiContext, type AiUsage, type ExplainInput, type ParsedIncident, type ResolveResult } from './types';
import type { Settings, Task } from '@/db/schema';
import type { Occurrence } from '@/engine/recurrence';
import type { PlanProposal } from '@/engine/planner';
import { getUsage, recordUsage } from '@/db/usage';
import { isOpen } from '@/lib/select';
import { formatTime, toLocalDate, toLocalTime } from '@/lib/time';

export const RULES_CONFIDENCE_THRESHOLD = 0.8;

export interface ResolveContext {
  nowMs: number;
  tz: string;
  tasks: Task[];
  occurrences: Occurrence[];
  settings: Settings;
  energy?: Task['energyRequired'];
}

export function aiReady(settings: Settings): { ok: true } | { ok: false; code: AiError['code'] } {
  if (!settings.ai.enabled) return { ok: false, code: 'disabled' };
  if (settings.ai.provider !== 'claude') return { ok: false, code: 'disabled' };
  if (!settings.ai.proxyUrl || !settings.ai.proxySecret) return { ok: false, code: 'not_configured' };
  return { ok: true };
}

export function buildAiContext(ctx: ResolveContext): AiContext {
  return {
    now: toLocalTime(ctx.nowMs, ctx.tz),
    date: toLocalDate(ctx.nowMs, ctx.tz),
    timeZone: ctx.tz,
    workStart: ctx.settings.workStart,
    workEnd: ctx.settings.workEnd,
    energy: ctx.energy,
    tasks: ctx.tasks
      .filter((t) => isOpen(t))
      .slice(0, 60)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, estimatedMinutes: t.estimatedMinutes })),
    events: ctx.occurrences.slice(0, 30).map((o) => ({ title: o.title, start: formatTime(o.startMs, ctx.tz), end: formatTime(o.endMs, ctx.tz) })),
  };
}

export function makeProvider(settings: Settings, fetchImpl?: typeof fetch): ClaudeProxyProvider {
  return new ClaudeProxyProvider({
    proxyUrl: settings.ai.proxyUrl ?? '',
    proxySecret: settings.ai.proxySecret ?? '',
    model: settings.ai.model ?? 'claude-haiku-5-5',
    maxOutputTokens: settings.ai.maxOutputTokens,
    fetchImpl,
  });
}

function withIncident(parsed: ParsedIncident, source: ResolveResult['source'], ctx: ResolveContext, extra: Partial<ResolveResult> = {}): ResolveResult {
  try {
    const incident = parsedToIncident(parsed, { nowMs: ctx.nowMs, tz: ctx.tz, tasks: ctx.tasks });
    return { parsed, incident, source, ...extra };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '無法轉成事件';
    return { parsed, source, ...extra, notice: [extra.notice, msg].filter(Boolean).join('；') };
  }
}

export async function resolveIncidentText(text: string, ctx: ResolveContext, fetchImpl?: typeof fetch): Promise<ResolveResult> {
  const rules = nlParse(text, {
    now: toLocalTime(ctx.nowMs, ctx.tz),
    tasks: ctx.tasks.filter((t) => isOpen(t)).map((t) => ({ id: t.id, title: t.title })),
  });
  if (rules.confidence >= RULES_CONFIDENCE_THRESHOLD) return withIncident(rules, 'rules', ctx);

  const ready = aiReady(ctx.settings);
  if (!ready.ok) {
    const notice = ready.code === 'disabled' ? 'AI 助手未啟用，以規則解析為準' : '還沒設定 AI 助手，以規則解析為準';
    return withIncident(rules, 'rules', ctx, { notice });
  }

  const today = toLocalDate(ctx.nowMs, ctx.tz);
  const usage = await getUsage(today);
  if (usage.calls >= ctx.settings.ai.dailyLimit) {
    return withIncident(rules, 'rules', ctx, { notice: `今天的 AI 請求已達上限（${ctx.settings.ai.dailyLimit} 次），以規則解析為準` });
  }

  try {
    const provider = makeProvider(ctx.settings, fetchImpl);
    const r = await provider.parseIncident(text, buildAiContext(ctx));
    await recordUsage(today, r.model, r.usage.inputTokens, r.usage.outputTokens);
    return withIncident(r.parsed, 'ai', ctx, { usage: r.usage, model: r.model });
  } catch (e) {
    const msg = e instanceof AiError ? e.message : 'AI 失敗';
    return withIncident(rules, 'rules', ctx, { notice: `${msg}，改用規則解析` });
  }
}

/** 把規則引擎的方案翻成白話（可選；每次都算一次 AI 請求） */
export async function explainProposal(proposal: PlanProposal, ctx: { nowMs: number; tz: string; settings: Settings }, fetchImpl?: typeof fetch): Promise<{ text: string; usage: AiUsage; model: string }> {
  const ready = aiReady(ctx.settings);
  if (!ready.ok) throw new AiError(ready.code);
  const today = toLocalDate(ctx.nowMs, ctx.tz);
  const usage = await getUsage(today);
  if (usage.calls >= ctx.settings.ai.dailyLimit) throw new AiError('daily_limit');
  const input: ExplainInput = {
    now: toLocalTime(ctx.nowMs, ctx.tz),
    next: proposal.nextAction
      ? {
          title: proposal.nextAction.block.title,
          start: formatTime(proposal.nextAction.block.startMs, ctx.tz),
          end: formatTime(proposal.nextAction.block.endMs, ctx.tz),
          reason: proposal.nextAction.reason,
        }
      : undefined,
    blocks: proposal.blocks.map((b) => ({ title: b.title, start: formatTime(b.startMs, ctx.tz), end: formatTime(b.endMs, ctx.tz), isMinimum: b.isMinimum, kept: b.kept })),
    unscheduled: proposal.unscheduled.map((u) => ({ title: u.title, reason: u.reason, suggestion: u.suggestion })),
    warnings: proposal.warnings,
    stats: proposal.stats,
  };
  const provider = makeProvider(ctx.settings, fetchImpl);
  const r = await provider.explainPlan(input);
  await recordUsage(today, r.model, r.usage.inputTokens, r.usage.outputTokens);
  return r;
}
