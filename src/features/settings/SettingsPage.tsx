import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/AppShell';
import { Button, Confirm, ErrorText, Field, Input, Segmented, Select, Sheet, Textarea, Toggle } from '@/components/ui';
import { clearAllData, countAll, updateSettings } from '@/db/repo';
import { exportBackupJson, importBackup, parseBackup, type ImportMode } from '@/db/backup';
import type { Settings } from '@/db/schema';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { formatDateTimeZh } from '@/lib/time';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, Compass } from 'lucide-react';
import { HelpSheet } from './HelpSheet';
import { DEFAULT_MODEL, MODEL_PRICING, formatUsd } from '@/ai/pricing';
import { makeProvider } from '@/ai/resolve';
import { getUsage, totalUsage } from '@/db/usage';
import { enqueueEverything, makeTransport, replaceWithRemote, runSync, refreshSyncStatus, syncConfigured } from '@/sync/engine';
import { useSyncStatus } from '@/hooks/useSync';
import { todayLocal } from '@/lib/time';
import { useSession } from '@/hooks/useSession';
import { fetchProviders, loginUrl, proxyUrlOf, setSession, verifySessionToken, type ProvidersResult } from '@/auth/session';
import { completeLogin, switchConflict } from '@/features/auth/AuthCallbackPage';
import type { MeResult } from '@/auth/session';
import { DEFAULT_PROXY_URL } from '@/config';
import { LogIn, UserCircle2 } from 'lucide-react';

export function SettingsPage() {
  const settings = useSettings();
  const toast = useToast();
  const session = useSession();
  const [draft, setDraft] = useState<Settings>(settings);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<null | 'clear' | 'import' | 'replace-remote' | 'delete-remote' | 'logout' | 'logout-wipe' | 'paste-switch'>(null);
  const [pendingMe, setPendingMe] = useState<{ me: MeResult; previous: string } | null>(null);
  const [providers, setProviders] = useState<ProvidersResult | 'loading' | { error: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteToken, setPasteToken] = useState('');
  const [pasting, setPasting] = useState(false);
  const proxyUrl = proxyUrlOf(draft, DEFAULT_PROXY_URL);
  const configured = syncConfigured(draft);

  // 有 Worker 網址就問它開放哪些登入方式（公開端點，不需要憑證）
  useEffect(() => {
    if (!proxyUrl || session) {
      setProviders(null);
      return;
    }
    let cancelled = false;
    setProviders('loading');
    const t = window.setTimeout(() => {
      fetchProviders(proxyUrl)
        .then((r) => {
          if (!cancelled) setProviders(r);
        })
        .catch((e: unknown) => {
          if (!cancelled) setProviders({ error: e instanceof Error ? e.message : '無法連線到 Worker' });
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [proxyUrl, session]);

  async function logout(wipe: boolean) {
    setConfirm(null);
    try {
      if (wipe) {
        await clearAllData();
        setSession(null);
        setDirty(false);
        toast.show('已登出並清除此裝置資料');
        return;
      }
      setSession(null);
      await updateSettings({ sync: { ...settings.sync, enabled: false }, ai: { ...settings.ai, enabled: Boolean(settings.ai.proxySecret) && settings.ai.enabled } });
      setDirty(false);
      toast.show('已登出，資料仍留在這台裝置');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '登出失敗', 'danger');
    }
  }

  async function pasteLogin() {
    const token = pasteToken.trim();
    if (!token || !proxyUrl) return;
    setPasting(true);
    try {
      const me = await verifySessionToken(proxyUrl, token);
      const previous = await switchConflict(me);
      if (previous) {
        setPendingMe({ me, previous });
        setConfirm('paste-switch');
        return;
      }
      const msg = await completeLogin(me, { wipeLocal: false });
      setPasteOpen(false);
      setPasteToken('');
      setDirty(false);
      toast.show(msg);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '登入碼無效', 'danger');
    } finally {
      setPasting(false);
    }
  }
  const syncStatus = useSyncStatus();
  const [syncBusy, setSyncBusy] = useState(false);
  const [cloudInfo, setCloudInfo] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ json: string; mode: ImportMode; summary: string } | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('replace');
  const [storage, setStorage] = useState<{ persisted?: boolean; usageMB?: number } | null>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const usageToday = useLiveQuery(() => getUsage(todayLocal(settings.timeZone)), [settings.timeZone]);
  const usageTotal = useLiveQuery(() => totalUsage(), []);

  const setSync = (patch: Partial<Settings['sync']>) => {
    setDraft((d) => ({ ...d, sync: { ...d.sync, ...patch } }));
    setDirty(true);
  };

  async function syncNowClick() {
    setSyncBusy(true);
    try {
      await runSync('手動');
      await refreshSyncStatus();
      toast.show('已同步');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '同步失敗', 'danger');
    } finally {
      setSyncBusy(false);
    }
  }

  async function checkCloud() {
    setSyncBusy(true);
    try {
      const t = makeTransport({ ...draft });
      const st = await t.status();
      if (!st.configured) setCloudInfo('Worker 還沒綁定 KV（FLOWPLAN_KV）。照 docs/API_SETUP.md Part C 綁定後再試。');
      else {
        const c = st.counts ?? {};
        setCloudInfo(`雲端版本 ${st.version ?? 0} · ${c.tasks ?? 0} 個任務、${c.events ?? 0} 個行程、${c.logs ?? 0} 筆紀錄${st.updatedAt ? ` · 更新於 ${formatDateTimeZh(st.updatedAt, settings.timeZone)}` : ''}`);
      }
    } catch (e) {
      setCloudInfo(e instanceof Error ? e.message : '無法連線');
    } finally {
      setSyncBusy(false);
    }
  }

  const setAi = (patch: Partial<Settings['ai']>) => {
    setDraft((d) => ({ ...d, ai: { ...d.ai, ...patch } }));
    setDirty(true);
  };

  async function testConnection() {
    setTesting(true);
    try {
      const provider = makeProvider({ ...draft, ai: { ...draft.ai } });
      const h = await provider.health();
      toast.show(h.hasKey ? `連線成功，Worker 模型：${h.model}` : '連線成功，但 Worker 還沒設定 ANTHROPIC_API_KEY', h.hasKey ? 'info' : 'danger');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '連線失敗', 'danger');
    } finally {
      setTesting(false);
    }
  }
  const fileRef = useRef<HTMLInputElement>(null);
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
      const wasEnabled = settings.sync.enabled;
      await updateSettings(draft);
      if (draft.sync.enabled && !wasEnabled) {
        const n = await enqueueEverything();
        toast.show(`已啟用同步，${n} 筆資料排入第一次推送`);
      }
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
      <button
        type="button"
        onClick={async () => {
          await updateSettings({ tourDone: false });
          toast.show('導覽開始');
        }}
        className="mt-2 flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2"
        data-testid="replay-tour"
      >
        <Compass size={20} className="shrink-0 text-accent" />
        <span className="flex-1">
          <span className="block text-[15px] font-semibold">看一次導覽</span>
          <span className="block text-xs text-muted">在畫面上一步步指給你看每個地方在做什麼（第一次使用時會自動出現）</span>
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
          <Toggle checked={draft.useCalibration} onChange={(v) => set('useCalibration', v)} label="依過去的實際 / 預估比例校正工時" />
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">帳號</h2>
        <p className="mt-0.5 text-xs text-muted">
          用 Google 或 GitHub 登入後，AI 助手與跨裝置同步都不需要通關密語；你的資料存在 Worker 擁有者的 Cloudflare KV 裡，各帳號互不相見。只有被擁有者加進允許清單的 email 能登入。
        </p>
        {session ? (
          <div className="mt-3">
            <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2">
              <UserCircle2 size={28} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{session.name || session.email}</div>
                <div className="truncate text-xs text-muted">
                  {session.email} · {session.provider === 'google' ? 'Google' : 'GitHub'}
                </div>
                <div className="text-xs text-muted">登入有效至 {formatDateTimeZh(new Date(session.exp * 1000).toISOString(), settings.timeZone)}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => setConfirm('logout')}>登出</Button>
              <Button variant="danger" onClick={() => setConfirm('logout-wipe')}>
                登出並清除此裝置資料
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">借別人的裝置用完請選「登出並清除」；自己的裝置只要「登出」，資料留著，下次登入同一個帳號會接著同步。</p>
          </div>
        ) : (
          <div className="mt-3">
            {!proxyUrl && <p className="text-xs text-warn">請先在下方「AI 助手」填 Worker 網址（擁有者會告訴你）。</p>}
            {providers === 'loading' && <p className="text-xs text-muted">正在詢問 Worker 開放的登入方式…</p>}
            {providers && typeof providers === 'object' && 'error' in providers && <p className="text-xs text-danger">無法取得登入方式：{providers.error}</p>}
            {providers && typeof providers === 'object' && 'providers' in providers && (
              <>
                {providers.providers.length === 0 ? (
                  <p className="text-xs text-muted">
                    這個 Worker 沒有開放登入
                    {providers.configuredProviders > 0 && !providers.allowlist ? '（已設定登入供應商，但 ALLOWED_USERS 還是空的）' : ''}；{providers.passphrase ? '請用下方的通關密語。' : '也沒有設定通關密語。'}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {providers.providers.map((p) => (
                      <a key={p.id} href={loginUrl(proxyUrl, p.id)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white active:opacity-80" data-testid={`login-${p.id}`}>
                        <LogIn size={16} /> 用 {p.label} 登入
                      </a>
                    ))}
                  </div>
                )}
              </>
            )}
            <button type="button" className="mt-3 text-xs text-muted underline" onClick={() => setPasteOpen(true)} disabled={!proxyUrl}>
              已在別的瀏覽器登入？貼上登入碼
            </button>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">AI 助手</h2>
        <p className="mt-0.5 text-xs text-muted">
          把「用一句話描述狀況」交給 Claude 解析。關閉時一切照常：規則解析與表單永遠可用。金鑰只放在 Cloudflare Worker，這裡只存{session ? '登入狀態' : '通關密語'}（備份時不會匯出）。設定步驟見 docs/API_SETUP.md。
        </p>
        <div className="mt-2 divide-y divide-line">
          <Toggle checked={draft.ai.enabled} onChange={(v) => setAi({ enabled: v, provider: v ? 'claude' : draft.ai.provider })} label="啟用 AI 助手" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Field label="供應商">
            <Select value={draft.ai.provider} onChange={(e) => setAi({ provider: e.target.value as Settings['ai']['provider'] })}>
              <option value="none">無</option>
              <option value="claude">Claude</option>
              <option value="gemini" disabled>Gemini（之後）</option>
              <option value="groq" disabled>Groq（之後）</option>
            </Select>
          </Field>
          <Field label="模型">
            <Select value={draft.ai.model ?? DEFAULT_MODEL} onChange={(e) => setAi({ model: e.target.value })}>
              {Object.entries(MODEL_PRICING).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Worker 網址" hint={DEFAULT_PROXY_URL ? `留空就用預設：${DEFAULT_PROXY_URL}` : undefined} className="mt-3">
          <Input type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder={DEFAULT_PROXY_URL || 'https://flowplan-ai.xxx.workers.dev'} value={draft.ai.proxyUrl ?? ''} onChange={(e) => setAi({ proxyUrl: e.target.value.trim() })} />
        </Field>
        {session ? (
          <p className="mt-3 text-xs text-muted">已登入，不需要通關密語。</p>
        ) : (
          <Field label="通關密語（單人模式）" hint="和 Worker 的 FLOWPLAN_PROXY_SECRET 一樣；不是 Anthropic API key。有登入就不用填。" className="mt-3">
            <div className="flex gap-2">
              <Input type={showSecret ? 'text' : 'password'} autoCapitalize="off" autoCorrect="off" value={draft.ai.proxySecret ?? ''} onChange={(e) => setAi({ proxySecret: e.target.value })} className="flex-1" />
              <Button onClick={() => setShowSecret((v) => !v)} className="shrink-0">
                {showSecret ? '隱藏' : '顯示'}
              </Button>
            </div>
          </Field>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="每日請求上限">
            <Input type="number" inputMode="numeric" min={0} max={1000} value={draft.ai.dailyLimit} onChange={(e) => setAi({ dailyLimit: Number(e.target.value) })} />
          </Field>
          <Field label="單次最大輸出 token">
            <Input type="number" inputMode="numeric" min={128} max={8192} step={128} value={draft.ai.maxOutputTokens} onChange={(e) => setAi({ maxOutputTokens: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={testConnection} disabled={testing || !configured}>
            {testing ? '測試中…' : '測試連線'}
          </Button>
          <span className="text-xs text-muted">
            今天 {usageToday?.calls ?? 0} 次 · {((usageToday?.inputTokens ?? 0) + (usageToday?.outputTokens ?? 0)).toLocaleString()} token · 約 {formatUsd(usageToday?.costUsd ?? 0)}
            {usageTotal && usageTotal.calls > 0 && ` · 累計 ${usageTotal.calls} 次 約 ${formatUsd(usageTotal.costUsd)}`}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted">費用為估算；真正的硬上限請在 Anthropic Console 的 FlowPlan workspace 設 spend limit。額度用完時 API 只會停止，不會扣款。</p>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">跨裝置同步</h2>
        <p className="mt-0.5 text-xs text-muted">
          用同一個 Worker，把資料存一份在 Cloudflare KV（免費），iPhone 與電腦之間自動同步。{session ? '已登入：資料存在你自己的帳號空間。' : '通關密語模式：需要先在 Worker 綁定 KV（見 docs/API_SETUP.md Part C）。'}資料以明文存在 KV；同一筆資料兩邊都改過時，以較新的為準。
        </p>
        <div className="mt-2 divide-y divide-line">
          <Toggle checked={draft.sync.enabled} onChange={(v) => setSync({ enabled: v })} label="啟用同步" />
          <Toggle checked={draft.sync.auto} onChange={(v) => setSync({ auto: v })} label="自動同步（有變更後幾秒推送、回到前景時拉取）" />
        </div>
        {!configured && <p className="mt-2 text-xs text-warn">請先登入，或在上方「AI 助手」填好 Worker 網址與通關密語（同步共用同一組）。</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={syncNowClick} disabled={syncBusy || !settings.sync.enabled || !syncConfigured(settings)}>
            {syncBusy ? '同步中…' : '立即同步'}
          </Button>
          <Button onClick={checkCloud} disabled={syncBusy || !configured}>
            檢查雲端
          </Button>
          <span className="text-xs text-muted">
            {syncStatus.state === 'disabled' && '未啟用'}
            {syncStatus.state === 'syncing' && '同步中…'}
            {syncStatus.state === 'offline' && '離線，恢復連線後自動同步'}
            {syncStatus.state === 'idle' && `已同步 · 版本 ${syncStatus.version}`}
            {syncStatus.state === 'error' && <span className="text-danger">{syncStatus.lastError}</span>}
            {syncStatus.pending > 0 && ` · ${syncStatus.pending} 筆待推送`}
            {syncStatus.lastPullAt && ` · 上次 ${formatDateTimeZh(syncStatus.lastPullAt, settings.timeZone)}`}
          </span>
        </div>
        {cloudInfo && <p className="mt-2 text-xs text-muted">{cloudInfo}</p>}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">進階：以雲端為準 / 刪除雲端資料</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => setConfirm('replace-remote')} disabled={!settings.sync.enabled || !syncConfigured(settings)}>
              以雲端為準覆蓋本機
            </Button>
            <Button variant="danger" onClick={() => setConfirm('delete-remote')} disabled={!syncConfigured(settings)}>
              刪除雲端資料
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">「以雲端為準」會清掉本機的任務、行程、紀錄再從雲端載入（設定與密語保留）。「刪除雲端資料」只刪 KV 裡的快照，本機不動。</p>
        </details>
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
          <Button variant="danger" onClick={() => setConfirm('clear')}>
            清除全部資料
          </Button>
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-muted">FlowPlan 0.4 · 本機優先，零額外付費</p>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="貼上登入碼">
        <p className="mb-2 text-sm text-muted">在別的瀏覽器完成登入後，登入頁會顯示一段登入碼。貼到這裡就能在這個 App 裡登入（登入碼只存在這台裝置）。</p>
        <Textarea value={pasteToken} onChange={(e) => setPasteToken(e.target.value)} rows={4} placeholder="貼上登入碼" autoCapitalize="off" autoCorrect="off" className="font-mono text-xs" />
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={pasteLogin} disabled={pasting || !pasteToken.trim()}>
            {pasting ? '確認中…' : '登入'}
          </Button>
          <Button onClick={() => setPasteOpen(false)}>取消</Button>
        </div>
      </Sheet>
      <Confirm
        open={confirm === 'logout'}
        title="登出？"
        message="這台裝置的資料會留著，同步與 AI 會停用；下次用同一個帳號登入會接著同步。"
        confirmLabel="登出"
        onConfirm={() => logout(false)}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === 'logout-wipe'}
        title="登出並清除此裝置資料？"
        message="會刪掉這台裝置上的任務、行程、紀錄與設定。雲端資料不受影響，之後登入可再載回。還沒推送的變更會遺失。"
        confirmLabel="登出並清除"
        danger
        onConfirm={() => logout(true)}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === 'paste-switch'}
        title="改用另一個帳號？"
        message={`這台裝置的資料屬於 ${pendingMe?.previous ?? ''}。改用 ${pendingMe?.me.email ?? ''} 會先清除本機資料，再從雲端載入。`}
        confirmLabel="清除本機並切換"
        danger
        onConfirm={async () => {
          setConfirm(null);
          if (!pendingMe) return;
          setPasting(true);
          try {
            const msg = await completeLogin(pendingMe.me, { wipeLocal: true });
            setPasteOpen(false);
            setPasteToken('');
            setDirty(false);
            toast.show(msg);
          } catch (e) {
            toast.show(e instanceof Error ? e.message : '切換失敗', 'danger');
          } finally {
            setPasting(false);
            setPendingMe(null);
          }
        }}
        onCancel={() => {
          setConfirm(null);
          setPendingMe(null);
        }}
      />
      <Sheet open={copyText !== null} onClose={() => setCopyText(null)} title="手動複製備份">
        <p className="mb-2 text-sm text-muted">這個環境不允許自動複製或下載。全選下方文字後複製，貼到任何筆記或檔案保存。</p>
        <Textarea readOnly value={copyText ?? ''} rows={12} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
      </Sheet>

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
        open={confirm === 'replace-remote'}
        title="以雲端為準覆蓋本機？"
        message="本機的任務、行程、紀錄會先清空，再從雲端載入。本機尚未推送的變更會遺失。"
        confirmLabel="覆蓋本機"
        danger
        onConfirm={async () => {
          setConfirm(null);
          setSyncBusy(true);
          try {
            const r = await replaceWithRemote(makeTransport(settings));
            await refreshSyncStatus();
            toast.show(`已從雲端載入 ${r.upserted} 筆（版本 ${r.version}）`);
          } catch (e) {
            toast.show(e instanceof Error ? e.message : '失敗', 'danger');
          } finally {
            setSyncBusy(false);
          }
        }}
        onCancel={() => setConfirm(null)}
      />
      <Confirm
        open={confirm === 'delete-remote'}
        title="刪除雲端資料？"
        message="只會刪除 Cloudflare KV 裡的快照，本機資料不受影響。下次同步會把本機資料重新推上去。"
        confirmLabel="刪除雲端"
        danger
        onConfirm={async () => {
          setConfirm(null);
          setSyncBusy(true);
          try {
            await makeTransport(settings).remove();
            setCloudInfo('雲端快照已刪除');
            toast.show('已刪除雲端資料');
          } catch (e) {
            toast.show(e instanceof Error ? e.message : '失敗', 'danger');
          } finally {
            setSyncBusy(false);
          }
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
