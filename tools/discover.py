"""One-off probe #2: can plain requests read the NH endpoints? Dump full payloads."""
import json, re
import requests

S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

def dump(label, url):
    print(f"\n######## {label} {url}")
    r = S.get(url, timeout=60)
    print("STATUS", r.status_code, r.headers.get("content-type"))
    try:
        print("JSON>>>" + json.dumps(r.json(), separators=(",", ":")) + "<<<JSON")
    except Exception:
        print(r.text[:2000])

dump("collection", "https://www.nhlottery.com/api/v1/game/collection?identifier=in-store&platform=web&cmsPreview=false")
dump("remaining", "https://prod.game-data.gambytservices.com/v1/instant-game/prizes-remaining")
dump("prizetable", "https://www.nhlottery.com/api/v1/game/prize-table?identifier=Six-Figures&cmsPreview=false&platform=web")
dump("game", "https://www.nhlottery.com/api/v1/game?identifier=Six-Figures&platform=web&cmsPreview=false")
for u in ["https://prod.game-data.gambytservices.com/v1/instant-game",
          "https://prod.game-data.gambytservices.com/v1/instant-games",
          "https://prod.game-data.gambytservices.com/v1/instant-game/b7ca3116-265c-4f7b-a3b3-922f18f61c32"]:
    dump("probe", u)

# find where the site's JS builds the CSV (Game Number source)
html = S.get("https://www.nhlottery.com/prizes/prizes-remaining", timeout=60).text
scripts = sorted(set(re.findall(r'src="([^"]+\.js[^"]*)"', html)))
print("SCRIPTS", scripts)
for s in scripts:
    url = s if s.startswith("http") else "https://www.nhlottery.com" + s
    try:
        js = S.get(url, timeout=60).text
    except Exception as e:
        print("ERR", url, e); continue
    for pat in ["Game Number", "gambytservices", "prizes-remaining", "gameNumber", "instant-game"]:
        for m in re.finditer(re.escape(pat), js):
            print(f"--- {pat} in {url} @ {m.start()}:\n{js[max(0,m.start()-600):m.start()+600]}\n")
