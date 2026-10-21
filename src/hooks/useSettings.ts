import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { defaultSettings, normalizeSettings, type Settings } from '@/db/schema';

const FALLBACK = defaultSettings();

/** 設定永遠有值且欄位完整：資料庫還沒寫入前先用預設值；舊版本寫入的列缺欄位時由 normalizeSettings 補 */
export function useSettings(): Settings {
  const row = useLiveQuery(() => db.settings.get('default'), []);
  return useMemo(() => (row ? normalizeSettings(row) : FALLBACK), [row]);
}
