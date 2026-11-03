"""Inline core.js into index.html -> one self-contained page (for hosting anywhere)."""
import sys
from pathlib import Path

here = Path(__file__).parent
html = (here / "index.html").read_text()
core = (here / "core.js").read_text()
out = html.replace('<script src="core.js"></script>', "<script>\n" + core + "\n</script>")
if "--fragment" not in sys.argv:
    # a complete standalone document (for GitHub Pages / Cloudflare Pages / any static host)
    head = (
        '<!doctype html>\n<html lang="en">\n<head>\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="theme-color" content="#ef5a24">\n'
        '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E'
        '%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%23ef5a24%27/%3E%3Cpath d=%27M7 22c4-14 14-14 18 0%27 '
        'fill=%27none%27 stroke=%27white%27 stroke-width=%273%27 stroke-linecap=%27round%27/%3E%3C/svg%3E">\n'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}</style>\n'
    )
    out = out.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', "")
    i = out.index("<main>")
    out = head + out[:i] + "</head>\n<body>\n" + out[i:] + "\n</body>\n</html>\n"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
dest = Path(args[0]) if args else here.parent / "docs" / "index.html"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(out)
print(dest, len(out), "bytes")
