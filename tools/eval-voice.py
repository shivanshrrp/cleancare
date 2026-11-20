"""Measures the live voice check: 20 waste items spoken by the Mac's Indian voices (Hindi, Indian English, Tamil),
sent to the deployed server function exactly as the app sends them, scored against the BMW Rules 2016 colour.
Writes docs/ai-eval.md. macOS only (uses `say` and `afconvert`). Run from the repo root:
    python3 tools/eval-voice.py
Calls the real AI service (about 20 requests, paced under the function's 20-per-minute limit)."""
import base64, json, os, re, statistics, subprocess, tempfile, time, urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = open(os.path.join(ROOT, "config.js"), encoding="utf-8").read()
URL = re.search(r"https://[a-z0-9]+\.supabase\.co", CFG).group(0) + "/functions/v1/classify-waste"
KEY = re.search(r"sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._-]+", CFG).group(0)
ORIGIN = "https://cleancare-srrp.web.app"

# (voice, app language, what staff say, correct colour under Schedule I of the BMW Rules 2016)
ITEMS = [
    ("Lekha", "Hindi", "इस्तेमाल की हुई सुई", "White"),
    ("Lekha", "Hindi", "सर्जिकल ब्लेड", "White"),
    ("Lekha", "Hindi", "सुई लगी हुई इस्तेमाल की गई सिरिंज", "White"),
    ("Lekha", "Hindi", "खून से सना हुआ रुई का फाहा", "Yellow"),
    ("Lekha", "Hindi", "घाव की गंदी पट्टी", "Yellow"),
    ("Lekha", "Hindi", "इस्तेमाल किए हुए दस्ताने", "Red"),
    ("Lekha", "Hindi", "यूरिन बैग", "Red"),
    ("Lekha", "Hindi", "टूटी हुई कांच की शीशी", "Blue"),
    ("Lekha", "Hindi", "एक्सपायर हो चुकी दवा की गोलियाँ", "Yellow"),
    ("Lekha", "Hindi", "पुराना अखबार", "None"),
    ("Rishi", "English", "a used lancet from a finger prick test", "White"),
    ("Rishi", "English", "an IV drip set with tubing", "Red"),
    ("Rishi", "English", "a urinary catheter", "Red"),
    ("Rishi", "English", "an empty glass ampoule", "Blue"),
    ("Tara", "English", "gauze soaked in blood", "Yellow"),
    ("Tara", "English", "a plastic syringe without the needle", "Red"),
    ("Tara", "English", "an empty cardboard box", "None"),
    ("Tara", "English", "a broken glass slide from the lab", "Blue"),
    ("Vani", "Tamil", "பயன்படுத்திய ஊசி", "White"),
    ("Vani", "Tamil", "இரத்தம் படிந்த பஞ்சு", "Yellow"),
]


def post(payload, timeout=60):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), method="POST", headers={
        "content-type": "application/json", "apikey": KEY, "origin": ORIGIN})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, {}, time.time() - t0


def wav_b64(voice, text, tmp):
    aiff, wav = os.path.join(tmp, "x.aiff"), os.path.join(tmp, "x.wav")
    subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
    # 16 kHz mono 16-bit, the same format the app records and sends
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], check=True)
    return base64.b64encode(open(wav, "rb").read()).decode()


def main():
    _, health, _ = post({"task": "health"})
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (voice, lang, text, want) in enumerate(ITEMS, 1):
            status, out, secs = post({"task": "voice", "lang": lang, "audio": wav_b64(voice, text, tmp)})
            res = out.get("result", {})
            got = res.get("category", f"HTTP {status}")
            rows.append(dict(lang=lang, text=text, want=want, got=got, ok=got == want, secs=secs,
                             conf=res.get("confidence"), heard=res.get("heard", "")))
            print(f"{i:2} {lang:7} {want:6} -> {got:8} {'ok ' if got == want else 'MISS'} {secs:4.1f}s  {text}")
            time.sleep(3.5)  # stays under 20 requests a minute

    right = sum(r["ok"] for r in rows)
    times = sorted(r["secs"] for r in rows)
    p90 = times[max(0, round(0.9 * len(times)) - 1)]
    when = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%d %b %Y, %H:%M IST")
    via = health.get("ai", {}).get("via", "unknown")
    lines = [
        "# AI evaluation: voice check",
        "",
        f"Measured {when} against the live server function (version {health.get('version', '?')}, "
        f"answering via {via}, model {health.get('ai', {}).get('model', '?')}). Re-run with `python3 tools/eval-voice.py`.",
        "",
        "| Result | Value |",
        "| --- | --- |",
        f"| Correct bag colour | **{right} of {len(rows)}** ({100 * right // len(rows)}%) |",
        f"| Median reply time | {statistics.median(times):.1f} s |",
        f"| 90th percentile | {p90:.1f} s |",
        f"| Languages | {', '.join(sorted({r['lang'] for r in rows}))} |",
        "",
        "**Method.** Each item is spoken by a built-in macOS Indian voice (Lekha for Hindi, Rishi and Tara for Indian",
        "English, Vani for Tamil), converted to the 16 kHz mono WAV the app records, and sent to the deployed function",
        "exactly as the app sends it. The expected colour follows Schedule I of the Bio-Medical Waste Management Rules,",
        "2016. Reply time is measured from the client and includes the network. Synthetic voices are clearer than a busy",
        "clinic, so treat this as a baseline; staff always confirm the colour before a bag is saved.",
        "",
        "| # | Language | Said | Expected | AI answer | Confidence | Heard | Time |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for i, r in enumerate(rows, 1):
        mark = r["got"] if r["ok"] else f"**{r['got']}** ✗"
        conf = "" if r["conf"] is None else f"{r['conf']:.2f}"
        lines.append(f"| {i} | {r['lang']} | {r['text']} | {r['want']} | {mark} | {conf} | {r['heard']} | {r['secs']:.1f} s |")
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    open(os.path.join(ROOT, "docs", "ai-eval.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(f"\n{right}/{len(rows)} correct, median {statistics.median(times):.1f} s, p90 {p90:.1f} s -> docs/ai-eval.md")


if __name__ == "__main__":
    main()
