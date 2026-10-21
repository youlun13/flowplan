/**
 * 費用估算（美元 / 百萬 token）。只是給使用者感覺量級，實際以 Anthropic Console 的 Cost 頁為準。
 * 更新日期：2026-10-21（Haiku 5.5 以 ≤100K token 的提示價格計）
 */
export const MODEL_PRICING: Record<string, { input: number; output: number; label: string }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, label: 'Haiku 5.5（預設）' },
  'claude-sonnet-5-5': { input: 2, output: 10, label: 'Sonnet 5.5（約 20 倍價）' },
  'claude-haiku-4-5': { input: 1, output: 5, label: 'Haiku 4.5' },
  'claude-sonnet-4-5': { input: 3, output: 15, label: 'Sonnet 4.5' },
};

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function formatUsd(x: number): string {
  if (x < 0.001) return x === 0 ? 'US$0' : '< US$0.001';
  return `US$${x.toFixed(x < 0.1 ? 3 : 2)}`;
}
