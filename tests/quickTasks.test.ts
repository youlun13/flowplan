import { describe, expect, it } from 'vitest';
import { parseQuickLine, parseQuickTasks, quickTaskDueAt } from '@/engine/quickTasks';

describe('快速輸入解析', () => {
  it('每行一件；分鐘、小時、純數字、沒寫時間', () => {
    const r = parseQuickTasks('讀英文 60\n寫報告 1.5h\n整理筆記 30分\n背單字');
    expect(r.map((t) => [t.title, t.estimatedMinutes, t.explicitMinutes])).toEqual([
      ['讀英文', 60, true],
      ['寫報告', 90, true],
      ['整理筆記', 30, true],
      ['背單字', 30, false],
    ]);
  });

  it('一行用頓號 / 逗號分開也行；項目符號會去掉', () => {
    const r = parseQuickTasks('- 讀英文 45、寫報告 90，洗衣服');
    expect(r.map((t) => t.title)).toEqual(['讀英文', '寫報告', '洗衣服']);
  });

  it('! 代表優先級高，「低」代表低；截止時間支援 17:00前 / 下午五點前 / 9點半前', () => {
    expect(parseQuickLine('交作業 17:00前 !')).toMatchObject({ title: '交作業', priority: 'P1', dueTime: '17:00' });
    expect(parseQuickLine('交作業 下午5點前')).toMatchObject({ title: '交作業', dueTime: '17:00' });
    expect(parseQuickLine('回信 9點半前 低')).toMatchObject({ title: '回信', dueTime: '09:30', priority: 'P3' });
    expect(parseQuickLine('看影片 2小時20分')).toMatchObject({ title: '看影片', estimatedMinutes: 140 });
    expect(quickTaskDueAt(parseQuickLine('交作業 17:00前')!, '2026-10-26', 'Asia/Taipei')).toBe('2026-10-26T09:00:00.000Z');
  });

  it('空行與只有標記的行略過；時間會對齊 5 分鐘、最少 5', () => {
    expect(parseQuickTasks('\n\n!\n')).toEqual([]);
    expect(parseQuickLine('小事 2')?.estimatedMinutes).toBe(5);
    expect(parseQuickLine('小事 33')?.estimatedMinutes).toBe(35);
  });
});
