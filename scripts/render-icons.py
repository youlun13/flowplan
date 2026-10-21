"""把 design/icon-<x>.svg 轉成 public/ 的 PNG 圖示：python3 scripts/render-icons.py c
PNG 一律填滿背景色（iOS 會把透明角落塗黑，所以不留透明）。"""
import sys, os, shutil
from playwright.sync_api import sync_playwright
from PIL import Image

name = sys.argv[1] if len(sys.argv) > 1 else "d1"
BG = (255, 255, 255, 255)
src = os.path.abspath(f"design/icon-{name}.svg")
shutil.copy(src, "public/icon.svg")
svg = open(src, encoding="utf-8").read()
with sync_playwright() as p:
    b = p.chromium.launch()
    for size, out in [(512, "public/icon-512.png"), (192, "public/icon-192.png"), (180, "public/apple-touch-icon.png")]:
        pg = b.new_page(viewport={"width": size, "height": size})
        inline = svg.replace("<svg ", f'<svg width="{size}" height="{size}" style="display:block" ', 1)
        pg.set_content(f'<html><body style="margin:0">{inline}</body></html>')
        pg.wait_for_timeout(200)
        pg.screenshot(path=out, omit_background=True)
        pg.close()
        fg = Image.open(out).convert("RGBA")
        bg = Image.new("RGBA", fg.size, BG)
        bg.alpha_composite(fg)
        bg.convert("RGB").save(out)
    b.close()
print("icons rendered from", src)
