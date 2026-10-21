import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { defaultSettings, type Settings } from '@/db/schema';

const FALLBACK = defaultSettings();

/** 設定永遠有值：資料庫還沒寫入前先用預設值，避免整頁閃爍 */
export function useSettings(): Settings {
  const settings = useLiveQuery(() => db.settings.get('default'), []);
  return settings ?? FALLBACK;
}
