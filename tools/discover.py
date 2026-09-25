"""One-off: record the network traffic nhlottery.com's SPA makes, to find its data API."""
import asyncio, json, os
from playwright.async_api import async_playwright

PAGES = [
    "https://www.nhlottery.com/game-collection/in-store?filters=scratchGame",
    "https://www.nhlottery.com/prizes/prizes-remaining",
]
os.makedirs("out", exist_ok=True)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(accept_downloads=True, user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"))
        page = await ctx.new_page()
        seen = []

        async def on_resp(r):
            ct = r.headers.get("content-type", "")
            if r.request.resource_type in ("xhr", "fetch") or "json" in ct or "csv" in ct:
                body = ""
                try:
                    body = (await r.text())[:3000]
                except Exception as e:
                    body = f"<err {e}>"
                seen.append(r.url)
                print(f"\n### {r.request.method} {r.status} {ct} {r.url}")
                if r.request.method == "POST":
                    print("POSTDATA:", (r.request.post_data or "")[:1000])
                print(body)
        page.on("response", lambda r: asyncio.ensure_future(on_resp(r)))

        for url in PAGES:
            print(f"\n\n======== PAGE {url}")
            await page.goto(url, wait_until="networkidle", timeout=90000)
            await page.wait_for_timeout(5000)
            html = await page.content()
            open(f"out/{len(seen)}.html", "w").write(html)
            links = await page.eval_on_selector_all("a", "els => els.map(e => e.href)")
            print("LINKS:", json.dumps(sorted(set(l for l in links if 'game' in l.lower() or 'scratch' in l.lower()))[:200], indent=0))
            imgs = await page.eval_on_selector_all("img", "els => els.map(e => e.src)")
            print("IMGS:", json.dumps(imgs[:60], indent=0))
            buttons = await page.eval_on_selector_all("button, a", "els => els.map(e => (e.innerText||'').trim()).filter(t => t && t.length < 60)")
            print("BUTTONS:", json.dumps(sorted(set(buttons))[:200]))
            text = await page.inner_text("body")
            print("TEXT:", text[:4000])

        # try the CSV button on the prizes remaining page
        for label in ["CSV", "Download", "Export"]:
            loc = page.get_by_text(label, exact=False)
            n = await loc.count()
            print(f"candidates for {label}: {n}")
            if n:
                try:
                    async with page.expect_download(timeout=30000) as dl:
                        await loc.first.click()
                    d = await dl.value
                    path = "out/prizes.csv"
                    await d.save_as(path)
                    print("DOWNLOAD URL:", d.url[:500])
                    data = open(path, encoding="utf-8", errors="replace").read()
                    print("CSV LEN", len(data))
                    print(data[:6000])
                    break
                except Exception as e:
                    print("download failed:", e)

        # visit one game detail page
        links = await page.goto(PAGES[0], wait_until="networkidle", timeout=90000)
        await page.wait_for_timeout(4000)
        hrefs = await page.eval_on_selector_all("a", "els => els.map(e => e.href)")
        games = [h for h in hrefs if "/game" in h and "game-collection" not in h]
        print("GAME HREFS:", games[:20])
        if games:
            print(f"\n\n======== GAME PAGE {games[0]}")
            await page.goto(games[0], wait_until="networkidle", timeout=90000)
            await page.wait_for_timeout(4000)
            print("TEXT:", (await page.inner_text("body"))[:4000])
            imgs = await page.eval_on_selector_all("img", "els => els.map(e => e.src)")
            print("IMGS:", json.dumps(imgs[:40], indent=0))
        await b.close()

asyncio.run(main())
