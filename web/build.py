"""Inline core.js into index.html -> one self-contained page (for hosting anywhere)."""
import sys
from pathlib import Path

here = Path(__file__).parent
html = (here / "index.html").read_text()
out = html
for name, sid in [("core.js", "skipcore"), ("shrink.js", "skipshrink"), ("engine.js", "skipengine"), ("journal.js", "skipjournal"), ("app.js", "skipapp")]:
    src = (here / name).read_text()
    out = out.replace(f'<script src="{name}"></script>', f'<script id="{sid}">\n{src}\n</script>')
if "--fragment" not in sys.argv:
    # a complete standalone document (for GitHub Pages / Cloudflare Pages / any static host)
    head = (
        '<!doctype html>\n<html lang="en">\n<head>\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="theme-color" content="#ef5a24">\n'
        '<link rel="manifest" href="manifest.webmanifest">\n'
        '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="Skip Count">\n'
        '<meta name="apple-mobile-web-app-status-bar-style" content="default">\n'
        '<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">\n'
        '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E'
        '%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%23ef5a24%27/%3E%3Cpath d=%27M7 22c4-14 14-14 18 0%27 '
        'fill=%27none%27 stroke=%27white%27 stroke-width=%273%27 stroke-linecap=%27round%27/%3E%3C/svg%3E">\n'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}</style>\n'
    )
    out = out.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', "")
    i = out.index("<div class=\"wrap\">")
    out = head + out[:i] + "</head>\n<body>\n" + out[i:] + "\n</body>\n</html>\n"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
dest = Path(args[0]) if args else here.parent / "docs" / "index.html"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(out)
if "--fragment" not in sys.argv:
    # installable app: manifest, icons and a service worker stamped with this build's hash
    import hashlib
    import shutil
    (dest.parent / "icons").mkdir(exist_ok=True)
    for f in (here / "icons").glob("*.png"):
        shutil.copy(f, dest.parent / "icons" / f.name)
    shutil.copy(here / "manifest.webmanifest", dest.parent / "manifest.webmanifest")
    (dest.parent / "voice").mkdir(exist_ok=True)
    for f in (here / "voice").glob("*"):
        shutil.copy(f, dest.parent / "voice" / f.name)
    h = hashlib.sha1(out.encode())
    for f in sorted((here / "icons").glob("*.png")) + sorted((here / "voice").glob("*")) + [here / "manifest.webmanifest", here / "sw.js"]:
        h.update(f.read_bytes())
    build = h.hexdigest()[:10]
    (dest.parent / "sw.js").write_text((here / "sw.js").read_text().replace("__BUILD__", build))
print(dest, len(out), "bytes")
