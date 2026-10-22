import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useMemo } from 'react';
import { db } from '@/db/db';
import type { WorkBlock } from '@/db/schema';
import { buildPlan, type Incident, type PlanProposal, type PlannerInput } from '@/engine/planner';
import { computeAvailability } from '@/engine/availability';
import { calibration } from '@/engine/stats';
import { occurrencesOnDate } from '@/engine/recurrence';
import { useDailyState, useOccurrences, useRunningLog, useTasks } from './useData';
import { useSettings } from './useSettings';
import { isOpen } from '@/lib/select';
import { addLocalDays, dayStartMs, toLocalDate, type LocalDate } from '@/lib/time';

const EMPTY_BLOCKS: WorkBlock[] = [];

export function useBlocksForDate(date: LocalDate): WorkBlock[] {
  return useLiveQuery(() => db.workBlocks.where('date').equals(date).sortBy('startAt'), [date]) ?? EMPTY_BLOCKS;
}

/** 把目前的資料組成規則引擎的輸入；buildProposal 不寫資料 */
export function usePlanner(nowMs: number) {
  const settings = useSettings();
  const tz = settings.timeZone;
  const today = toLocalDate(nowMs, tz);
  const tomorrow = addLocalDays(today, 1);
  const tasks = useTasks();
  const occurrences = useOccurrences(addLocalDays(today, -1), tomorrow, tz);
  const blocks = useBlocksForDate(today);
  const running = useRunningLog();
  const daily = useDailyState(today);

  const todayOcc = useMemo(() => occurrencesOnDate(occurrences, today, tz), [occurrences, today, tz]);
  const tomorrowOcc = useMemo(() => occurrencesOnDate(occurrences, tomorrow, tz), [occurrences, tomorrow, tz]);

  const tomorrowInfo = useMemo(() => {
    const avail = computeAvailability({
      date: tomorrow,
      tz,
      workStart: settings.workStart,
      workEnd: settings.workEnd,
      sleepStart: settings.sleepStart,
      sleepEnd: settings.sleepEnd,
      bufferMinutes: settings.bufferMinutes,
      busy: tomorrowOcc,
      from: dayStartMs(tomorrow, tz),
    });
    const plannedMinutes = tasks.filter((t) => isOpen(t) && t.plannedDate === tomorrow).reduce((s, t) => s + t.estimatedMinutes, 0);
    return { availableMinutes: avail.totalMinutes, plannedMinutes };
  }, [tomorrow, tz, settings, tomorrowOcc, tasks]);

  const baseInput = useMemo<Omit<PlannerInput, 'incident' | 'nowMs'>>(
    () => ({
      tz,
      settings: {
        workStart: settings.workStart,
        workEnd: settings.workEnd,
        sleepStart: settings.sleepStart,
        sleepEnd: settings.sleepEnd,
        bufferMinutes: settings.bufferMinutes,
        breakMinutes: settings.breakMinutes,
        focusMinutes: settings.focusMinutes,
        preferDeadlineFirst: settings.preferDeadlineFirst,
        energyMatching: settings.energyMatching,
        allowSplitting: settings.allowSplitting,
      },
      tasks,
      busy: todayOcc.map((o) => ({ startMs: o.startMs, endMs: o.endMs, title: o.title, kind: 'event' as const })),
      existingBlocks: blocks,
      activeTaskId: running?.taskId,
      energy: daily?.energy,
      tomorrow: tomorrowInfo,
      calibration: settings.useCalibration ? calibration(tasks) : undefined,
    }),
    [tz, settings, tasks, todayOcc, blocks, running?.taskId, daily?.energy, tomorrowInfo],
  );

  const buildProposal = useCallback(
    (incident?: Incident, pinFirstTaskId?: string): PlanProposal => buildPlan({ ...baseInput, nowMs: Date.now(), incident, pinFirstTaskId }),
    [baseInput],
  );

  return { today, tz, tasks, todayOcc, blocks, running, daily, settings, buildProposal };
}
