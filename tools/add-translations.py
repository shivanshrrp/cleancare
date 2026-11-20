"""Adds new interface strings to every language that has them.

Usage: python3 tools/add-translations.py new-keys.json
new-keys.json is {"en": {"key": "text", ...}, "hi": {...}, "ta": {...}, ...}. Each language's keys go just before its
"lang.failed" line: en, hi and mr in translations.js, the rest in translations/<code>.js. Run the checker afterwards:
deno run --allow-read tools/check-translations.js
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INLINE = ["en", "hi", "mr"]  # block order inside translations.js


def lines_for(keys, indent):
    return [f'{" " * indent}{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n' for k, v in keys.items()]


def insert_before(path, nth, new_lines):
    lines = open(path, encoding="utf-8").readlines()
    hits = [i for i, l in enumerate(lines) if l.lstrip().startswith('"lang.failed"')]
    i = hits[nth]
    lines[i:i] = new_lines
    open(path, "w", encoding="utf-8").writelines(lines)


new = json.load(open(sys.argv[1], encoding="utf-8"))
for code, keys in new.items():
    if code in INLINE:
        insert_before(os.path.join(ROOT, "translations.js"), INLINE.index(code), lines_for(keys, 4))
    else:
        insert_before(os.path.join(ROOT, "translations", code + ".js"), 0, lines_for(keys, 2))
    print(code, len(keys), "keys")
