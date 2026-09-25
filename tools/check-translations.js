// Checks every language block against English: missing keys, unknown keys and {placeholder} mismatches.
// Run from the repo root: deno run --allow-read tools/check-translations.js
globalThis.window = globalThis;
await import(new URL("../translations.js", import.meta.url));
const I = window.CLEANCARE_I18N, L = window.CLEANCARE_LANGUAGES;
for (const { code } of L) {
  if (!I[code]) { try { await import(new URL(`../translations/${code}.js`, import.meta.url)); } catch { } }
}
const en = I.en, keys = Object.keys(en);
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");
let bad = 0;
for (const l of L) {
  const b = I[l.code];
  if (!b) { console.log(`${l.code.padEnd(4)} MISSING FILE`); bad++; continue; }
  const missing = keys.filter((k) => !(k in b));
  const extra = Object.keys(b).filter((k) => !(k in en));
  const phBad = keys.filter((k) => k in b && ph(b[k]) !== ph(en[k]));
  const empty = keys.filter((k) => k in b && !String(b[k]).trim());
  const full = missing.length === 0;
  console.log(`${l.code.padEnd(4)} ${String(Object.keys(b).length).padStart(3)}/${keys.length} ${full ? "complete" : "partial "}${l.review ? " (review)" : ""}` +
    (extra.length ? `  EXTRA: ${extra.join(" ")}` : "") + (phBad.length ? `  PLACEHOLDERS: ${phBad.join(" ")}` : "") + (empty.length ? `  EMPTY: ${empty.join(" ")}` : ""));
  if (extra.length || phBad.length || empty.length || (!l.review && !full)) bad++;
}
if (bad) { console.log(`\n${bad} language(s) need attention`); Deno.exit(1); }
