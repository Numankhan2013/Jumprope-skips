"""Inline core.js into index.html -> one self-contained page (for hosting anywhere)."""
import sys
from pathlib import Path

here = Path(__file__).parent
html = (here / "index.html").read_text()
core = (here / "core.js").read_text()
out = html.replace('<script src="core.js"></script>', "<script>\n" + core + "\n</script>")
dest = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "dist" / "index.html"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(out)
print(dest, len(out), "bytes")
