import { describe, expect, it } from 'vitest';
import { unmetDependencies, wouldCreateCycle } from '@/engine/dependencies';

const tasks = [
  { id: 'a', dependencies: [], status: 'done' },
  { id: 'b', dependencies: ['a'], status: 'todo' },
  { id: 'c', dependencies: ['b'], status: 'todo' },
];

describe('依賴', () => {
  it('偵測直接與間接循環', () => {
    expect(wouldCreateCycle(tasks, 'a', ['a'])).toBe(true);
    expect(wouldCreateCycle(tasks, 'a', ['c'])).toBe(true); // a→c→b→a
    expect(wouldCreateCycle(tasks, 'c', ['a'])).toBe(false);
  });

  it('列出未完成的前置', () => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(unmetDependencies(tasks[1], byId)).toEqual([]);
    expect(unmetDependencies(tasks[2], byId)).toEqual(['b']);
    expect(unmetDependencies({ id: 'x', dependencies: ['ghost'] }, byId)).toEqual([]);
  });
});
