from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"
SOURCE = Path(__file__).with_name("update-fix.js")
TARGET = DOCS_DIR / "update-fix.js"
SCRIPT_TAG = '  <script src="/the-charging-rally/update-fix.js"></script>'
RUNTIME_MARKER = '  <script src="/the-charging-rally/runtime.'


def main() -> None:
    index_path = DOCS_DIR / "index.html"
    shutil.copyfile(SOURCE, TARGET)

    html = index_path.read_text(encoding="utf-8")
    if SCRIPT_TAG in html:
        return

    if RUNTIME_MARKER not in html:
        raise SystemExit("Could not find runtime script marker in docs/index.html")

    index_path.write_text(
        html.replace(RUNTIME_MARKER, f"{SCRIPT_TAG}\n{RUNTIME_MARKER}", 1),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
