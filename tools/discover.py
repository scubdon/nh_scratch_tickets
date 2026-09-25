"""One-off probe #3: extract the game-data config from the site bundle and dump payloads."""
import json, re
import requests

S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
html = S.get("https://www.nhlottery.com/prizes/prizes-remaining", timeout=60).text
js_url = [u for u in re.findall(r'src="([^"]+index[^"]*\.js[^"]*)"', html)][0]
js = S.get(js_url, timeout=60).text
for pat in ["CLIENT_ID", "GAME_DATA_API_KEY", "GAME_DATA_BASE_URL"]:
    for m in list(re.finditer(pat, js))[:6]:
        print(f"--- {pat} @ {m.start()}: {js[max(0,m.start()-300):m.start()+300]}\n")
key = re.search(r'GAME_DATA_API_KEY:"([^"]+)"', js).group(1)
base = re.search(r'GAME_DATA_BASE_URL:"([^"]+)"', js).group(1)
cid = None
m = re.search(r'CLIENT_ID\s*[:=]\s*"([^"]+)"', js)
if m: cid = m.group(1)
print("KEY", key, "BASE", base, "CID", cid)
h = {"X-API-Key": key}
if cid: h["X-Client-ID"] = cid
for path in ["/v1/instant-games", "/v1/instant-game/prizes-remaining"]:
    r = S.get(base + path, headers=h, timeout=60)
    print(f"\n######## {path}\nSTATUS {r.status_code}")
    print("JSON>>>" + r.text + "<<<JSON")
