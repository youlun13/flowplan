import { db } from './db';
import type { AiUsageDay } from './schema';
import { estimateCostUsd } from '@/ai/pricing';
import { nowIso, type LocalDate } from '@/lib/time';

export async function getUsage(date: LocalDate): Promise<AiUsageDay> {
  return (await db.aiUsage.get(date)) ?? { date, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: nowIso() };
}

export async function recordUsage(date: LocalDate, model: string, inputTokens: number, outputTokens: number): Promise<AiUsageDay> {
  const cur = await getUsage(date);
  const next: AiUsageDay = {
    date,
    calls: cur.calls + 1,
    inputTokens: cur.inputTokens + inputTokens,
    outputTokens: cur.outputTokens + outputTokens,
    costUsd: cur.costUsd + estimateCostUsd(model, inputTokens, outputTokens),
    updatedAt: nowIso(),
  };
  await db.aiUsage.put(next);
  return next;
}

export async function totalUsage(): Promise<{ calls: number; costUsd: number; days: number }> {
  const all = await db.aiUsage.toArray();
  return { calls: all.reduce((s, d) => s + d.calls, 0), costUsd: all.reduce((s, d) => s + d.costUsd, 0), days: all.length };
}
