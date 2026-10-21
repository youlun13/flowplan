import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/AppShell';
import { Button, Confirm, ErrorText, Field, Input, Segmented, Select, Sheet, Textarea, Toggle } from '@/components/ui';
import { clearAllData, countAll, deleteDemoData, updateSettings } from '@/db/repo';
import { exportBackupJson, importBackup, parseBackup, type ImportMode } from '@/db/backup';
import { db } from '@/db/db';
import type { Settings } from '@/db/schema';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { formatDateTimeZh } from '@/lib/time';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen } from 'lucide-react';
import { HelpSheet } from './HelpSheet';

export function SettingsPage() {
  const settings = useSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Settings>(settings);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<null | 'demo' | 'clear' | 'import'>(null);
  const [pendingImport, setPendingImport] = useState<{ json: string; mode: ImportMode; summary: string } | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('replace');
  const [storage, setStorage] = useState<{ persisted?: boolean; usageMB?: number } | null>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const demoCount = useLiveQuery(async () => (await db.tasks.filter((t) => Boolean(t.isDemo)).count()) + (await db.events.filter((e) => Boolean(e.isDemo)).count()), []) ?? 0;
  const counts = useLiveQuery(() => countAll(), []);

  useEffect(() => {
    if (!dirty) setDraft(settings);
  }, [settings, dirty]);

  useEffect(() => {
    (async () => {
      try {
        const persisted = await navigator.storage?.persisted?.();
        const est = await navigator.storage?.estimate?.();
        setStorage({ persisted, usageMB: est?.usage ? Math.round((est.usage / 1_048_576) * 10) / 10 : undefined });
      } catch {
        setStorage(null);
      }
    })();
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  async function save() {
    setError(null);
    try {
      await updateSettings(draft);
      setDirty(false);
      toast.show('已儲存設定');
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    }
  }

  async function doExport() {
    try {
      const json = await exportBackupJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flowplan-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.show('已匯出備份');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '匯出失敗', 'danger');
    }
  }

  /** 瀏覽器不允許下載時（例如預覽環境或某些 iOS 情況）的備援：複製到剪貼簿或手動複製 */
  async function doCopy() {
    try {
      const json = await exportBackupJson();
      try {
        await navigator.clipboard.writeText(json);
        toast.show('備份 JSON 已複製到剪貼簿');
      } catch {
        setCopyText(json);
      }
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '匯出失敗', 'danger');
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const json = await file.text();
      const backup = parseBackup(json);
      setPendingImport({ json, mode: importMode, summary: `${backup.tasks.length} 個任務、${backup.events.length} 個行程、${backup.logs.length} 筆紀錄（匯出於 ${formatDateTimeZh(backup.exportedAt, settings.timeZone)}）` });
      setConfirm('import');
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function doImport() {
    if (!pendingImport) return;
    try {
      const r = await importBackup(parseBackup(pendingImport.json), pendingImport.mode);
      toast.show(`已匯入 ${r.tasks} 個任務、${r.events} 個行程`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '匯入失敗');
    } finally {
      setConfirm(null);
      setPendingImport(null);
    }
  }

  return (
    <div>
      <PageHeader title="設定" />
      <ErrorText>{error}</ErrorText>

      <button type="button" onClick={() => setHelpOpen(true)} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2">
        <BookOpen size={20} className="shrink-0 text-accent" />
        <span className="flex-1">
          <span className="block text-[15px] font-semibold">使用說明</span>
          <span className="block text-xs text-muted">每天怎麼用、狀況怎麼處理、欄位怎麼填、備份注意事項</span>
        </span>
        <span className="text-muted">›</span>
      </button>

      <section className="mt-2 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">每日時間</h2>
        <p className="mt-0.5 text-xs text-muted">規則引擎只會在這些時段裡安排事情。</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="可工作 從">
            <Input type="time" value={draft.workStart} onChange={(e) => set('workStart', e.target.value)} />
          </Field>
          <Field label="可工作 到">
            <Input type="time" value={draft.workEnd} onChange={(e) => set('workEnd', e.target.value)} />
          </Field>
          <Field label="睡眠保護 從">
            <Input type="time" value={draft.sleepStart} onChange={(e) => set('sleepStart', e.target.value)} />
          </Field>
          <Field label="睡眠保護 到">
            <Input type="time" value={draft.sleepEnd} onChange={(e) => set('sleepEnd', e.target.value)} />
          </Field>
          <Field label="行程前後緩衝（分鐘）">
            <Input type="number" inputMode="numeric" min={0} max={120} step={5} value={draft.bufferMinutes} onChange={(e) => set('bufferMinutes', Number(e.target.value))} />
          </Field>
          <Field label="一次專注（分鐘）">
            <Input type="number" inputMode="numeric" min={10} max={240} step={5} value={draft.focusMinutes} onChange={(e) => set('focusMinutes', Number(e.target.value))} />
          </Field>
          <Field label="區塊之間休息（分鐘）">
            <Input type="number" inputMode="numeric" min={0} max={60} step={5} value={draft.breakMinutes} onChange={(e) => set('breakMinutes', Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-muted">週起始日</span>
          <Segmented size="sm" value={String(draft.weekStartsOn) as '0' | '1'} onChange={(v) => set('weekStartsOn', Number(v) as 0 | 1)} options={[{ value: '1', label: '週一' }, { value: '0', label: '週日' }]} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-muted">時區（固定，不跟裝置）</span>
          <span className="text-sm tnum">{draft.timeZone}</span>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">決策偏好</h2>
        <p className="mt-0.5 text-xs text-muted">重新規劃時規則引擎會依這些偏好排序與拆分任務。</p>
        <div className="mt-2 divide-y divide-line">
          <Toggle checked={draft.preferDeadlineFirst} onChange={(v) => set('preferDeadlineFirst', v)} label="優先保住有截止時間的任務" />
          <Toggle checked={draft.energyMatching} onChange={(v) => set('energyMatching', v)} label="依精力狀態匹配任務" />
          <Toggle checked={draft.allowSplitting} onChange={(v) => set('allowSplitting', v)} label="允許把任務拆成多段" />
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">AI 助手</h2>
        <p className="mt-0.5 text-xs text-muted">第三階段啟用。所有 AI 功能預設關閉；沒有 AI 時，日曆、任務、紀錄與規則引擎照常運作。金鑰永遠不會存在這個 App 裡。</p>
        <div className="mt-2 divide-y divide-line">
          <Toggle checked={false} onChange={() => toast.show('AI 助手將在第三階段提供')} label="啟用 AI 助手（第三階段）" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3 opacity-60">
          <Field label="供應商">
            <Select value={draft.ai.provider} disabled>
              <option value="none">無</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="groq">Groq</option>
            </Select>
          </Field>
          <Field label="每日請求上限">
            <Input type="number" value={draft.ai.dailyLimit} disabled />
          </Field>
        </div>
      </section>

      <div className="sticky bottom-20 mt-4 md:bottom-4">
        <Button variant="primary" full onClick={save} disabled={!dirty}>
          {dirty ? '儲存設定' : '設定已是最新'}
        </Button>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">資料</h2>
        <p className="mt-0.5 text-xs text-muted">
          所有資料只存在這台裝置的瀏覽器裡（IndexedDB）。目前 {counts ? `${counts.tasks} 個任務、${counts.events} 個行程、${counts.logs} 筆紀錄` : '…'}
          {storage?.usageMB !== undefined && `，約 ${storage.usageMB} MB`}
          {storage?.persisted === false && '。瀏覽器尚未承諾永久保存，請定期備份'}
          {storage?.persisted === true && '。瀏覽器已承諾保存'}。
          {settings.lastBackupAt ? ` 上次備份：${formatDateTimeZh(settings.lastBackupAt, settings.timeZone)}` : ' 還沒備份過'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={doExport}>匯出 JSON 備份</Button>
          <Button onClick={doCopy}>複製備份 JSON</Button>
          <Button onClick={() => fileRef.current?.click()}>匯入 JSON</Button>
          <Segmented size="sm" value={importMode} onChange={setImportMode} options={[{ value: 'replace', label: '匯入時取代' }, { value: 'merge', label: '合併' }]} />
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0])} />
        </div>
        <p className="mt-3 text-xs text-muted">iPhone 提醒：Safari 分頁與「加入主畫面」的 App 是兩份各自獨立的資料。請固定用同一個入口，要搬資料就用匯出 / 匯入。</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {demoCount > 0 && (
            <Button variant="danger" onClick={() => setConfirm('demo')}>
              刪除示範資料（{demoCount}）
            </Button>
          )}
          <Button variant="danger" onClick={() => setConfirm('clear')}>
            清除全部資料
          </Button>
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-muted">FlowPlan 0.1 · 第一階段 · 本機優先，零額外付費</p>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Sheet open={copyText !== null} onClose={() => setCopyText(null)} title="手動複製備份">
        <p className="mb-2 text-sm text-muted">這個環境不允許自動複製或下載。全選下方文字後複製，貼到任何筆記或檔案保存。</p>
        <Textarea readOnly value={copyText ?? ''} rows={12} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
      </Sheet>

      <Confirm
        open={confirm === 'demo'}
        title="刪除所有示範資料？"
        message="標記為示範的任務、行程與紀錄會被刪除，你自己新增的資料不受影響。"
        confirmLabel="刪除示範資料"
        danger
        onConfirm={async () => {
          await deleteDemoData();
          setConfirm(null);
          toast.show('已刪除示範資料');
        }}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === 'clear'}
        title="清除全部資料？"
        message="任務、行程、紀錄與設定都會刪除，且無法復原。建議先匯出備份。"
        confirmLabel="全部清除"
        danger
        onConfirm={async () => {
          await clearAllData();
          setConfirm(null);
          setDirty(false);
          toast.show('已清除全部資料');
        }}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === 'import'}
        title={pendingImport?.mode === 'replace' ? '取代目前資料？' : '合併到目前資料？'}
        message={
          <>
            將匯入：{pendingImport?.summary}
            <br />
            {pendingImport?.mode === 'replace' ? '目前所有任務、行程、紀錄會先刪除再匯入。' : '同一個 id 的資料會被覆蓋，其餘保留。'}
          </>
        }
        confirmLabel="匯入"
        danger={pendingImport?.mode === 'replace'}
        onConfirm={doImport}
        onCancel={() => {
          setConfirm(null);
          setPendingImport(null);
        }}
      />
    </div>
  );
}
