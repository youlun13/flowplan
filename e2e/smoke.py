"""
瀏覽器端驗收：對 `vite preview` 跑真實的 Chromium。
用法：  npm run build && npm run preview -- --port 4173 &  ；  python3 e2e/smoke.py http://localhost:4173/
對應驗收條件 1、2、3、4、10（無 AI key 時核心功能可用）。
"""
import sys, re, datetime
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
    print(("PASS " if cond else "FAIL ") + name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="zh-TW", timezone_id="Asia/Taipei")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

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
    page.click("button:has-text('臨時有事')")
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

    check("沒有 console/page error", len(errors) == 0)
    if errors:
        print("ERRORS:", errors[:5])
    browser.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
