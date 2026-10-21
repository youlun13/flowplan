import { useEffect, useState } from 'react';
import { subscribeSync, type SyncStatus } from '@/sync/engine';

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState<SyncStatus>({ state: 'disabled', pending: 0, version: 0 });
  useEffect(() => subscribeSync(setS), []);
  return s;
}
