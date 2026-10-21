/**
 * 示範資料：讓第一次打開就看得懂每個區塊在做什麼。全部標記 isDemo，可一鍵刪除。
 */
import { db } from './db';
import { createEvent, createLog, createTask, updateSettings } from './repo';
import { addLocalDays, localDateTimeToIso, localWeekday, todayLocal } from '@/lib/time';

export async function loadDemoDataIfEmpty(tz: string): Promise<boolean> {
  const [tasks, events, settings] = await Promise.all([db.tasks.count(), db.events.count(), db.settings.get('default')]);
  if (tasks > 0 || events > 0 || settings?.demoDataLoaded) return false;

  const today = todayLocal(tz);
  const tomorrow = addLocalDays(today, 1);
  const in3 = addLocalDays(today, 3);
  const iso = (date: string, time: string) => localDateTimeToIso(date, time, tz);

  // 每週重複的課：用今天的星期 + 兩天後，讓示範一定看得到
  const wd = localWeekday(today);
  await createEvent({
    title: '工程數學（示範）',
    kind: 'class',
    location: '理學院 302',
    startAt: iso(today, '15:00'),
    endAt: iso(today, '17:00'),
    recurrence: { byWeekday: [wd, (wd + 2) % 7], until: addLocalDays(today, 120) },
    isDemo: true,
  });
  await createEvent({
    title: '線性代數期中考（示範）',
    kind: 'exam',
    location: '綜合大樓 201',
    startAt: iso(in3, '10:00'),
    endAt: iso(in3, '12:00'),
    isDemo: true,
  });
  await createEvent({
    title: '弦樂社社課（示範）',
    kind: 'appointment',
    startAt: iso(tomorrow, '19:00'),
    endAt: iso(tomorrow, '21:00'),
    isDemo: true,
  });

  const linalg = await createTask({
    title: '複習線性代數第 3–4 章（示範）',
    priority: 'P1',
    plannedDate: today,
    dueAt: iso(in3, '10:00'),
    estimatedMinutes: 120,
    minimumMinutes: 45,
    minimumOutcome: '至少把第 3 章的例題全部重做一次',
    energyRequired: 'high',
    splittable: true,
    isDemo: true,
  });
  await createTask({
    title: '寫線代習題 4.2（示範）',
    priority: 'P1',
    plannedDate: tomorrow,
    dueAt: iso(in3, '10:00'),
    estimatedMinutes: 90,
    minimumMinutes: 30,
    minimumOutcome: '完成前 5 題',
    energyRequired: 'high',
    splittable: true,
    dependencies: [linalg.id],
    isDemo: true,
  });
  await createTask({
    title: '重構 FlowPlan 任務表單（示範）',
    priority: 'P2',
    plannedDate: today,
    estimatedMinutes: 60,
    energyRequired: 'medium',
    splittable: true,
    isDemo: true,
  });
  await createTask({
    title: '健身房 45 分鐘（示範）',
    priority: 'P3',
    plannedDate: today,
    estimatedMinutes: 45,
    energyRequired: 'low',
    splittable: false,
    isDemo: true,
  });
  await createTask({
    title: '回覆社團總務信件（示範）',
    priority: 'P3',
    plannedDate: today,
    estimatedMinutes: 15,
    energyRequired: 'low',
    splittable: false,
    isDemo: true,
  });

  await createLog({ title: '起床、早餐（示範）', category: 'meal', startAt: iso(today, '07:40'), endAt: iso(today, '08:10'), isDemo: true }, tz);
  await createLog({ title: '通勤（示範）', category: 'commute', startAt: iso(today, '08:10'), endAt: iso(today, '08:40'), isDemo: true }, tz);

  await updateSettings({ demoDataLoaded: true });
  return true;
}
