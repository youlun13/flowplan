"""
瀏覽器端驗收：對 `vite preview` 跑真實的 Chromium。
用法：  npm run build && npm run preview -- --port 4173 &  ；  python3 e2e/smoke.py http://localhost:4173/
對應驗收條件 1、2、3、4、10（無 AI key 時核心功能可用）。
"""
import sys, re, datetime, json
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "e2e/shots"
import os
os.makedirs(SHOTS, exist_ok=True)

def tpe_today(offset=0):
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) + datetime.timedelta(days=offset)
    return now.strftime("%Y-%m-%d")

results = []
def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [errors so far: {len(errors)}]" if errors else ""))

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="zh-TW", timezone_id="Asia/Taipei")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"PAGEERROR {getattr(e, 'message', e)} :: {str(getattr(e, 'stack', ''))[:400]}"))
    page.on("console", lambda m: errors.append(f"{m.text} @ {m.location.get('url','')}:{m.location.get('lineNumber','')}") if m.type == "error" else None)

    page.goto(BASE)
    page.wait_for_selector("text=下一步（")
    page.screenshot(path=f"{SHOTS}/01-dashboard.png", full_page=True)
    check("Dashboard 顯示示範資料的下一步", page.locator("text=複習線性代數").count() > 0)

    # ---- 驗收 1：新增明天的 TODO，重新整理後仍存在 ----
    page.click("a[href='#/tasks']:visible")
    page.wait_for_selector("h1:has-text('任務')")
    page.click("button[aria-label='新增任務']")
    page.fill("input[placeholder*='複習線代']", "E2E 明天的任務")
    page.click("button:has-text('明天')")
    page.click("div[role='dialog'] button[role='radio']:has-text('高')")
    page.click("div[role='dialog'] button:has-text('新增')")
    page.wait_for_selector("text=E2E 明天的任務")
    page.reload()
    page.wait_for_selector("text=E2E 明天的任務")
    check("驗收1 新增明天 TODO，重新整理後仍存在", True)
    page.screenshot(path=f"{SHOTS}/02-tasks.png", full_page=True)

    # ---- 驗收 2：編輯名稱、期限、優先級與工時 ----
    page.click("text=E2E 明天的任務")
    page.wait_for_selector("text=編輯任務")
    page.fill("input[placeholder*='複習線代']", "E2E 已改名")
    page.fill("input[type='number'][min='5']", "90")
    page.click("button:has-text('進階')")
    due = tpe_today(3)
    page.locator("div[role='dialog'] input[type='date']").nth(1).fill(due)
    page.locator("div[role='dialog'] input[type='time']").first.fill("18:00")
    page.click("div[role='dialog'] button[role='radio']:has-text('中')")
    page.click("div[role='dialog'] button:has-text('儲存')")
    page.wait_for_selector("text=E2E 已改名")
    page.reload()
    page.click("text=E2E 已改名")
    page.wait_for_selector("text=編輯任務")
    title_ok = page.input_value("input[placeholder*='複習線代']") == "E2E 已改名"
    est_ok = page.input_value("input[type='number'][min='5']") == "90"
    due_ok = page.locator("div[role='dialog'] input[type='date']").nth(1).input_value() == due
    time_ok = page.locator("div[role='dialog'] input[type='time']").first.input_value() == "18:00"
    pri_ok = page.locator("div[role='dialog'] [role='radiogroup']").first.locator("button[aria-checked='true']").inner_text() == "中"
    check("驗收2 編輯後重新開啟仍正確", title_ok and est_ok and due_ok and time_ok and pri_ok)
    page.click("div[role='dialog'] button:has-text('取消')")

    # ---- 驗收 3：勾選完成 / 取消 ----
    page.click("a[href='#/']:visible")
    page.wait_for_selector("text=下一步（")
    before = page.locator("header").inner_text()
    m = re.search(r"已完成 (\d+) / (\d+)", before)
    done0, total0 = int(m.group(1)), int(m.group(2))
    page.locator("button[role='checkbox'][aria-checked='false']").first.click()
    page.wait_for_timeout(300)
    after = page.locator("header").inner_text()
    m2 = re.search(r"已完成 (\d+) / (\d+)", after)
    check("驗收3 勾選完成即時更新進度", int(m2.group(1)) == done0 + 1 and int(m2.group(2)) == total0)
    page.click("a[href='#/tasks']:visible")
    page.click("button[role='radio']:has-text('已完成')")
    page.locator("button[role='checkbox'][aria-checked='true']").first.click()
    page.wait_for_timeout(300)
    page.click("a[href='#/']:visible")
    page.wait_for_selector("text=下一步（")
    page.wait_for_timeout(300)
    again = page.locator("header").inner_text()
    m3 = re.search(r"已完成 (\d+) / (\d+)", again)
    check("驗收3 取消勾選恢復未完成", int(m3.group(1)) == done0)

    # ---- 驗收 4：日曆切換日期 ----
    page.click("a[href='#/calendar']:visible")
    page.wait_for_selector("text=固定行程")
    page.screenshot(path=f"{SHOTS}/03-calendar-month.png", full_page=True)
    tomorrow = tpe_today(1)
    d = int(tomorrow[8:])
    page.locator(f"button[aria-label*='{int(tomorrow[5:7])}月{d}日']").first.click()
    page.wait_for_timeout(300)
    check("驗收4 切到明天看到明天的任務", page.locator("text=E2E 已改名").count() > 0 and page.locator("text=弦樂社社課").count() > 0)
    page.click("button[role='radio']:has-text('日')")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/04-calendar-day.png", full_page=True)
    page.click("button[role='radio']:has-text('週')")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/05-calendar-week.png", full_page=True)

    # ---- 新增每週重複行程 ----
    page.click("button[role='radio']:has-text('月')")
    page.click("button:has-text('行程')")
    page.wait_for_selector("text=新增固定行程")
    page.fill("input[placeholder*='工程數學']", "E2E 每週課")
    page.locator("div[role='dialog'] input[type='time']").nth(0).fill("10:00")
    page.locator("div[role='dialog'] input[type='time']").nth(1).fill("12:00")
    page.click("div[role='dialog'] [role='switch']")
    page.click("div[role='dialog'] button:has-text('新增')")
    page.wait_for_selector("text=E2E 每週課")
    page.click("button[role='radio']:has-text('週')")
    page.wait_for_timeout(300)
    page.click("button[aria-label='下一個']")
    page.wait_for_timeout(300)
    check("每週重複行程下一週同星期出現", page.locator("text=E2E 每週課").count() == 1)
    page.click("button[aria-label='下一個']")
    page.wait_for_timeout(300)
    check("每週重複行程再下一週也出現", page.locator("text=E2E 每週課").count() == 1)

    # ---- 紀錄頁 ----
    page.click("a[href='#/log']:visible")
    page.wait_for_selector("input[placeholder='現在開始做什麼？']")
    page.fill("input[placeholder='現在開始做什麼？']", "E2E 計時")
    page.click("button:has-text('開始')")
    page.wait_for_selector("text=進行中")
    page.click("button:has-text('結束')")
    page.wait_for_timeout(300)
    check("紀錄 開始/結束", page.locator("text=E2E 計時").count() > 0)
    page.screenshot(path=f"{SHOTS}/06-log.png", full_page=True)

    # ---- 第二階段：規劃今天 → 套用 → 狀況 → 撤銷 ----
    page.click("a[href='#/']:visible")
    page.wait_for_selector("text=下一步（建議")
    page.click("button:has-text('規劃今天')")
    page.wait_for_selector("text=重排預覽")
    page.wait_for_selector("text=套用後的今日排程")
    page.screenshot(path=f"{SHOTS}/09-proposal.png", full_page=True)
    page.click("button:has-text('保留原計畫')")
    page.wait_for_timeout(300)
    check("驗收11 保留原計畫後沒有排程被寫入", page.locator("text=今日排程").count() == 0)
    page.click("button:has-text('規劃今天')")
    page.wait_for_selector("text=套用後的今日排程")
    page.click("button:has-text('套用新計畫')")
    page.wait_for_selector("h2:has-text('今日排程')")
    page.wait_for_timeout(300)
    check("驗收11 套用後出現今日排程與撤銷", page.locator("text=下一步（已套用的排程）").count() == 1 and page.locator("button:has-text('撤銷')").count() == 1)
    page.screenshot(path=f"{SHOTS}/10-dashboard-planned.png", full_page=True)
    # 臨時有事 15:00–17:00 之外再加一段，確認預覽顯示變更
    page.click("button:has-text('我遇到狀況了')")
    page.wait_for_selector("text=看看怎麼辦")
    page.click("button[aria-pressed]:has-text('臨時有事')")
    page.locator("div[role='dialog'] input[type='time']").nth(0).fill("10:00")
    page.locator("div[role='dialog'] input[type='time']").nth(1).fill("12:00")
    page.fill("input[placeholder='臨時有事']", "E2E 臨時行程")
    page.click("button:has-text('看看怎麼辦')")
    page.wait_for_selector("text=套用後的今日排程")
    check("狀況預覽列出加入的固定行程", page.locator("text=加入固定行程「E2E 臨時行程」").count() == 1)
    page.screenshot(path=f"{SHOTS}/11-incident-proposal.png", full_page=True)
    page.click("button:has-text('套用新計畫')")
    page.wait_for_timeout(400)
    check("套用後臨時行程進入今天的固定行程", page.locator("text=E2E 臨時行程").count() >= 1)
    page.click("button:has-text('撤銷')")
    page.wait_for_timeout(400)
    check("撤銷後臨時行程消失", page.locator("text=E2E 臨時行程").count() == 0)

    # ---- 第三階段：假 Worker（驗收 9、10、12）----
    WORKER = "https://fake-worker.test"
    state = {"mode": "html"}
    def worker_route(route, request):
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        auth = request.headers.get("authorization")
        if auth != "Bearer e2e-secret":
            return route.fulfill(status=401, headers={**cors, "content-type": "application/json"}, body=json.dumps({"ok": False, "error": {"code": "unauthorized"}}))
        if request.url.endswith("/v1/health"):
            return route.fulfill(status=200, headers={**cors, "content-type": "application/json"}, body=json.dumps({"ok": True, "result": {"hasKey": True, "model": "claude-haiku-5-5"}}))
        body = json.loads(request.post_data or "{}")
        assert "x-api-key" not in json.dumps(request.headers).lower()
        m = state["mode"]
        if m == "html":
            return route.fulfill(status=200, headers={**cors, "content-type": "text/html"}, body="<html>oops</html>")
        if m == "ghost":
            return route.fulfill(status=200, headers={**cors, "content-type": "application/json"}, body=json.dumps({"ok": True, "result": {"type": "task_done", "taskId": "ghost-id", "confidence": 0.9, "missing": [], "note": "假的"}, "usage": {"inputTokens": 10, "outputTokens": 5}, "model": "claude-haiku-5-5"}))
        if m == "down":
            return route.fulfill(status=503, headers={**cors, "content-type": "application/json"}, body=json.dumps({"ok": False, "error": {"code": "upstream_unavailable", "message": "overloaded"}}))
        if m == "ok":
            if body.get("op") == "explain_plan":
                return route.fulfill(status=200, headers={**cors, "content-type": "application/json"}, body=json.dumps({"ok": True, "result": {"text": "先休息二十五分鐘再開始。"}, "usage": {"inputTokens": 300, "outputTokens": 20}, "model": "claude-haiku-5-5"}))
            return route.fulfill(status=200, headers={**cors, "content-type": "application/json"}, body=json.dumps({"ok": True, "result": {"type": "rest", "minutes": 25, "confidence": 0.9, "missing": [], "note": "想先休息 25 分鐘"}, "usage": {"inputTokens": 800, "outputTokens": 40}, "model": "claude-haiku-5-5"}))
        return route.fulfill(status=500, headers=cors, body="")
    page.route(WORKER + "/**", worker_route)

    SESSION = "fake.session-token"
    import time as _time
    from urllib.parse import unquote
    # 假的登入端點：真 Worker 會跳去 Google 再回來；這裡 start 直接當登入成功跳回 App
    def auth_route(route, request):
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "content-type": "application/json"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        url = request.url
        if url.endswith("/auth/providers"):
            return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"providers": [{"id": "google", "label": "Google"}], "passphrase": True, "allowlist": True, "configuredProviders": 1}}))
        if url.endswith("/auth/me"):
            if request.headers.get("authorization") != f"Bearer {SESSION}":
                return route.fulfill(status=401, headers=cors, body=json.dumps({"ok": False, "error": {"code": "session_expired", "message": "登入已失效"}}))
            return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"uid": "google:1", "email": "friend@example.com", "name": "小明", "provider": "google", "exp": int(_time.time()) + 60 * 86400, "features": {"ai": True, "sync": True}}}))
        if "/auth/google/start" in url:
            redirect = unquote(url.split("redirect=", 1)[1])
            return route.fulfill(status=302, headers={"Location": redirect + "#/auth?token=" + SESSION})
        return route.fulfill(status=404, headers=cors, body="{}")
    page.route(WORKER + "/auth/**", auth_route)

    # 無 AI 時規則解析可用（驗收 10）
    page.click("a[href='#/']:visible")
    page.wait_for_selector("text=下一步（")
    page.click("button:has-text('我遇到狀況了')")
    page.wait_for_selector("textarea[placeholder*='一句話']")
    page.fill("textarea[placeholder*='一句話']", "我睡到十一點")
    page.click("button:has-text('解析')")
    page.wait_for_selector("text=理解到的狀態")
    check("無 AI：規則解析出睡過頭", page.locator("div[role='dialog'] >> text=睡過頭").count() >= 1 and page.locator("div[role='dialog'] >> text=規則").count() >= 1)
    page.click("button:has-text('正確，看看怎麼辦')")
    page.wait_for_selector("text=套用後的今日排程")
    check("規則解析的事件能直接進入預覽", page.locator("text=重排預覽 · 睡過頭").count() == 1)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)

    # 設定 AI（驗收 12：瀏覽器端只有通關密語）
    page.click("a[href='#/settings']:visible")
    page.wait_for_selector("text=每日時間")
    page.click("div:has(> span:text('啟用 AI 助手')) >> nth=0") if False else page.click("button[role='switch']:has-text('啟用 AI 助手')")
    page.fill("input[placeholder*='workers.dev']", WORKER)
    page.fill("input[type='password']", "e2e-secret")
    page.click("button:has-text('儲存設定')")
    page.wait_for_timeout(300)
    page.click("button:has-text('測試連線')")
    page.wait_for_selector("text=連線成功")
    check("測試連線經假 Worker 成功", True)

    def ask(text):
        page.click("a[href='#/']:visible")
        page.wait_for_selector("text=下一步（")
        page.click("button:has-text('我遇到狀況了')")
        page.wait_for_selector("textarea[placeholder*='一句話']")
        page.fill("textarea[placeholder*='一句話']", text)
        page.click("button:has-text('解析')")
        page.wait_for_selector("div[role='dialog'] >> text=/理解到的狀態|還缺一點資訊/")
        page.wait_for_timeout(200)

    state["mode"] = "html"
    ask("報告剛剛交出去了耶")
    check("驗收9 Worker 回非法 JSON → 顯示錯誤並退回規則", page.locator("text=不是有效的 JSON").count() >= 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    state["mode"] = "ghost"
    ask("報告剛剛交出去了耶")
    check("驗收9 AI 虛構 task id → 拒絕", page.locator("text=指到的任務不存在").count() >= 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    state["mode"] = "down"
    ask("報告剛剛交出去了耶")
    check("驗收9 API 失敗 → 可理解錯誤", page.locator("text=暫時無法服務").count() >= 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    state["mode"] = "ok"
    ask("報告剛剛交出去了耶")
    check("AI 解析成功 → 顯示 AI 標記與理解", page.locator("div[role='dialog'] >> text=想先休息 25 分鐘").count() == 1 and page.locator("div[role='dialog'] >> text=AI").count() >= 1)
    page.click("button:has-text('正確，看看怎麼辦')")
    page.wait_for_selector("text=套用後的今日排程")
    check("AI 事件進入規則引擎預覽", page.locator("text=先休息 25 分鐘").count() >= 1)
    page.click("button:has-text('請 AI 用白話說明')")
    page.wait_for_selector("text=先休息二十五分鐘再開始")
    check("AI 白話說明", True)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    page.click("a[href='#/settings']:visible")
    page.wait_for_selector("text=每日時間")
    check("設定頁顯示今日用量", page.locator("text=/今天 [2-9] 次/").count() == 1)

    # ---- 第四階段：假 Worker 同步往返 + 週統計 ----
    # 兩個空間：通關密語（擁有者）與登入者（假 session），對應真 Worker 的 `snapshot` / `u:<uid>:snapshot`
    cloud = {"snapshot": None}
    user_cloud = {"snapshot": None}
    spaces = {"Bearer e2e-secret": cloud, f"Bearer {SESSION}": user_cloud}
    def sync_route(route, request):
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "content-type": "application/json"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        store = spaces.get(request.headers.get("authorization") or "")
        if store is None:
            return route.fulfill(status=401, headers=cors, body=json.dumps({"ok": False, "error": {"code": "unauthorized"}}))
        url = request.url
        if url.endswith("/v1/sync/status"):
            snap = store["snapshot"]
            return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"configured": True, "version": snap["version"] if snap else 0, "updatedAt": None, "counts": {t: len(v) for t, v in snap["records"].items()} if snap else {}}}))
        if request.method == "GET":
            snap = store["snapshot"]
            since = int(url.split("since=")[1]) if "since=" in url else -1
            if snap is None or snap["version"] <= since:
                return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"unchanged": True, "version": snap["version"] if snap else 0}}))
            return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"snapshot": snap}}))
        if request.method == "POST":
            body = json.loads(request.post_data or "{}")
            snap = store["snapshot"] or {"version": 0, "updatedAt": None, "records": {t: {} for t in ["tasks", "events", "logs", "dailyStates", "workBlocks", "planRevisions", "settings"]}, "tombstones": {}}
            for t, recs in (body.get("records") or {}).items():
                snap["records"].setdefault(t, {}).update(recs)
            for k, v in (body.get("tombstones") or {}).items():
                tbl, rid = k.split(":", 1)
                snap["records"].get(tbl, {}).pop(rid, None)
                snap["tombstones"][k] = v
            snap["version"] += 1
            store["snapshot"] = snap
            return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"snapshot": snap, "stats": {}}}))
        if request.method == "DELETE":
            store["snapshot"] = None
            return route.fulfill(status=200, headers=cors, body=json.dumps({"ok": True, "result": {"deleted": True}}))
        return route.fulfill(status=404, headers=cors, body="{}")
    page.route(WORKER + "/v1/sync**", sync_route)


    page.click("a[href='#/settings']:visible")
    page.wait_for_selector("text=跨裝置同步")
    page.click("button[role='switch']:has-text('啟用同步')")
    page.click("button:has-text('儲存設定')")
    page.wait_for_selector("text=已啟用同步")
    page.wait_for_timeout(6000)  # 自動推送 4 秒去抖
    check("驗收 同步：啟用後本機資料推上雲端", cloud["snapshot"] is not None and len(cloud["snapshot"]["records"]["tasks"]) >= 1)
    assert "e2e-secret" not in json.dumps(cloud["snapshot"]["records"].get("settings", {})), "settings 不應含通關密語"
    check("驗收 同步：雲端 settings 不含通關密語", True)
    page.click("button:has-text('檢查雲端')")
    page.wait_for_selector("text=/雲端版本 [1-9]/")
    check("設定頁可查雲端狀態", True)

    # 模擬另一台裝置新增任務 → 本機回到前景時拉回
    import uuid
    rid = str(uuid.uuid4())
    now_iso = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    cloud["snapshot"]["records"]["tasks"][rid] = {"id": rid, "title": "E2E 來自另一台裝置", "status": "todo", "priority": "P2", "plannedDate": tpe_today(), "estimatedMinutes": 30, "energyRequired": "medium", "splittable": True, "dependencies": [], "deferCount": 0, "createdAt": now_iso, "updatedAt": now_iso}
    cloud["snapshot"]["version"] += 1
    page.click("button:has-text('立即同步')")
    page.wait_for_timeout(800)
    page.click("a[href='#/tasks']:visible")
    page.wait_for_selector("text=E2E 來自另一台裝置")
    check("驗收 同步：另一台裝置的新任務拉回本機", True)

    # ---- 多人登入：登入後憑證換成 session、資料推進自己的空間、擁有者空間不動 ----
    owner_version_before = cloud["snapshot"]["version"]
    page.click("a[href='#/settings']:visible")
    page.wait_for_selector("h2:has-text('帳號')")
    page.wait_for_selector("a[data-testid='login-google']")
    check("設定頁依 Worker 回報顯示「用 Google 登入」", page.locator("a[data-testid='login-google']").count() == 1)
    page.click("a[data-testid='login-google']")
    page.wait_for_selector("text=friend@example.com")
    check("登入回呼：/auth/me 驗證後顯示帳號", page.locator("text=小明").count() >= 1 and page.locator("text=已用 friend@example.com 登入").count() >= 1)
    check("登入後不再要求通關密語", page.locator("input[type='password']").count() == 0)
    page.wait_for_timeout(1500)
    check("登入後本機資料推進登入者自己的空間", user_cloud["snapshot"] is not None and any(t.get("title") == "E2E 來自另一台裝置" for t in user_cloud["snapshot"]["records"]["tasks"].values()))
    check("擁有者（通關密語）的空間沒被動到", cloud["snapshot"]["version"] == owner_version_before)
    assert SESSION not in json.dumps(user_cloud["snapshot"]["records"].get("settings", {})), "settings 不應含登入 token"
    page.screenshot(path=f"{SHOTS}/13-login.png", full_page=True)
    # 登出：資料留著、同步關閉、回到登入按鈕
    page.click("button:has-text('登出'):visible >> nth=0")
    page.click("[role='alertdialog'] button:has-text('登出')")
    page.wait_for_selector("a[data-testid='login-google']")
    check("登出後回到登入按鈕，資料仍在", page.locator("a[data-testid='login-google']").count() == 1 and page.locator("button[role='switch']:has-text('啟用同步')[aria-checked='false']").count() == 1)
    # 重新用通關密語模式把同步打開，讓後面的流程照舊
    page.click("button[role='switch']:has-text('啟用同步')")
    page.click("button:has-text('儲存設定')")
    page.wait_for_timeout(300)

    # 週統計
    page.click("a[href='#/log']:visible")
    page.wait_for_selector("input[placeholder='現在開始做什麼？']")
    page.click("button[role='radio']:has-text('週')")
    page.wait_for_selector("text=每天記錄了多少")
    check("紀錄頁週檢視", page.locator("h2:has-text('預估準不準')").count() == 1 and page.locator("h2:has-text('一直被延後的')").count() == 1)
    page.screenshot(path=f"{SHOTS}/12-week.png", full_page=True)

    # ---- 設定頁與匯出 ----
    page.click("a[href='#/settings']:visible")
    page.wait_for_selector("text=每日時間")
    page.click("button:has-text('使用說明')")
    page.wait_for_selector("h2:has-text('使用說明')")
    check("設定頁可開啟使用說明", page.locator("text=我遇到狀況了").count() >= 1)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    with page.expect_download() as dl:
        page.click("button:has-text('匯出 JSON 備份')")
    path = dl.value.path()
    import json
    data = json.load(open(path))
    check("匯出 JSON 含任務與行程", data["app"] == "flowplan" and len(data["tasks"]) > 0 and len(data["events"]) > 0)
    check("驗收12 匯出備份不含通關密語（更不含金鑰）", "e2e-secret" not in json.dumps(data) and data["settings"]["ai"].get("proxySecret") is None)
    page.screenshot(path=f"{SHOTS}/07-settings.png", full_page=True)

    # ---- 刪除示範資料 ----
    page.click("button:has-text('刪除示範資料')")
    page.click("[role='alertdialog'] button:has-text('刪除示範資料')")
    page.wait_for_timeout(400)
    page.click("a[href='#/tasks']:visible")
    page.wait_for_timeout(300)
    check("刪除示範資料後自己新增的任務仍在", page.locator("text=E2E 已改名").count() > 0 and page.locator("text=複習線性代數").count() == 0)

    # 桌機尺寸
    ctx2 = browser.new_context(viewport={"width": 1280, "height": 900}, locale="zh-TW", timezone_id="Asia/Taipei")
    pg2 = ctx2.new_page()
    pg2.goto(BASE)
    pg2.wait_for_selector("text=下一步（")
    pg2.screenshot(path=f"{SHOTS}/08-desktop.png", full_page=True)
    ctx2.close()

    real_errors = [e for e in errors if "status of 503" not in e]  # 503 是我們故意讓假 Worker 回的
    check("沒有 console/page error", len(real_errors) == 0)
    errors = real_errors
    if errors:
        print("ERRORS:", errors[:5])
    browser.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
