/**
 * 任務依賴：循環檢查與「前置是否完成」。
 */
export interface DepNode {
  id: string;
  dependencies: string[];
  status?: string;
}

/** 若把 taskId 的依賴改成 newDeps，會不會形成循環 */
export function wouldCreateCycle(tasks: DepNode[], taskId: string, newDeps: string[]): boolean {
  if (newDeps.includes(taskId)) return true;
  const graph = new Map<string, string[]>();
  for (const t of tasks) graph.set(t.id, t.id === taskId ? newDeps : t.dependencies);
  if (!graph.has(taskId)) graph.set(taskId, newDeps);

  // 從 newDeps 出發，能否走回 taskId
  const seen = new Set<string>();
  const stack = [...newDeps];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of graph.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/** 回傳尚未完成的前置任務 id（不存在的 id 視為已失效、忽略） */
export function unmetDependencies(task: DepNode, byId: Map<string, DepNode>): string[] {
  return task.dependencies.filter((id) => {
    const dep = byId.get(id);
    return dep !== undefined && dep.status !== 'done' && dep.status !== 'cancelled';
  });
}
