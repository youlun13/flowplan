import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/db/db';
import type { ActivityLog, CalendarEvent, DailyState, Task } from '@/db/schema';
import { expandEvents, type Occurrence } from '@/engine/recurrence';
import type { LocalDate } from '@/lib/time';

const EMPTY_TASKS: Task[] = [];
const EMPTY_EVENTS: CalendarEvent[] = [];
const EMPTY_LOGS: ActivityLog[] = [];

export function useTasks(): Task[] {
  return useLiveQuery(() => db.tasks.toArray(), []) ?? EMPTY_TASKS;
}

export function useEvents(): CalendarEvent[] {
  return useLiveQuery(() => db.events.toArray(), []) ?? EMPTY_EVENTS;
}

/** 展開某段日期範圍內的所有行程 */
export function useOccurrences(fromDate: LocalDate, toDate: LocalDate, tz: string): Occurrence[] {
  const events = useEvents();
  return useMemo(() => expandEvents(events, fromDate, toDate, tz), [events, fromDate, toDate, tz]);
}

export function useLogsForDate(date: LocalDate): ActivityLog[] {
  return useLiveQuery(() => db.logs.where('date').equals(date).sortBy('startAt'), [date]) ?? EMPTY_LOGS;
}

export function useRunningLog(): ActivityLog | undefined {
  return useLiveQuery(() => db.logs.filter((l) => !l.endAt).first(), []);
}

export function useDailyState(date: LocalDate): DailyState | undefined {
  return useLiveQuery(() => db.dailyStates.get(date), [date]);
}
