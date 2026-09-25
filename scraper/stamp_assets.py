#!/usr/bin/env python3
"""Cache-bust styles.css / app.js by stamping a short content hash onto their URLs
in index.html, so a code change reaches visitors without a stale cached copy."""

import hashlib
import re
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"


def main() -> None:
    index = SITE / "index.html"
    html = index.read_text(encoding="utf-8")
    for asset in ("styles.css", "app.js"):
        digest = hashlib.sha256((SITE / asset).read_bytes()).hexdigest()[:10]
        html = re.sub(re.escape(asset) + r'(\?v=[^"\']*)?', f"{asset}?v={digest}", html)
    index.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()
