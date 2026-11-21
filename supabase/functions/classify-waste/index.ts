// CleanCare's Google Gemini features, behind one Supabase Edge Function so the API key stays server-side.
//
//   task "classify": { image: <base64 JPEG/PNG/WebP>, mediaType, lang }  -> { result }
//       Photo of one waste item -> CPCB bag colour, confidence, reason and a safe-handling step.
//   task "voice":    { audio: <base64 WAV>, lang }                           -> { result }
//       A staff member describes the item aloud in any Indian language -> transcript + the same result.
//   task "brief":    { data: <today's figures from the Monitor>, lang }      -> { brief }
//       A short daily brief for the regulator, written only from the figures sent.
//
// result = { item, category: Yellow|Red|White|Blue|None, confidence: 0-1, reason, handling, heard? }
// brief  = { headline, points: [..], actions: [..] }
// Text fields come back in the language named by `lang` (e.g. "Hindi"). The app only ever *suggests* a colour:
// staff confirm before anything is logged. A request with no task is treated as "classify" (older app versions).
//
// Secrets (Supabase -> Edge Functions -> Secrets): VERTEX_API_KEY (Google Cloud, Vertex AI; used first, optional)
// and GEMINI_API_KEY (Google AI Studio; the fallback). At least one is needed.
// Note: on Gemini's free tier, Google may use requests to improve its products.

// Free-tier models, tried in order: 3.1 Flash-Lite answers in ~5 s but is sometimes "busy" (503);
// 3.5 Flash-Lite is slower (15-40 s) but takes the overflow. Both: 15 requests/min, 500/day.
const FUNCTION_VERSION = "2.4.0";
const GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
const ALLOWED_ORIGINS = ["https://shivanshrrp.github.io", "https://cleancare-srrp.web.app", "https://cleancare-srrp.firebaseapp.com", "http://localhost:8765"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BASE64_CHARS = 3_000_000; // ~2.2 MB; the app sends ~100-300 KB photos and ~250 KB voice clips
const MAX_BRIEF_CHARS = 20_000;
const RATE_LIMIT = 20; // requests per minute per client IP (per function instance)
const CATEGORIES = ["Yellow", "Red", "White", "Blue", "None"];

// Grounding: the colour rules every answer must follow (BMW Management Rules 2016, Schedule I, as amended)
const CPCB_RULES = `India's Bio-Medical Waste Management Rules, 2016 (Schedule I) colour coding:
YELLOW: human and animal anatomical waste; soiled waste (dressings, cotton swabs, gauze, plaster casts, bags and linen
contaminated with blood or body fluids); expired or discarded medicines; cytotoxic drugs and items contaminated with them;
chemical waste; microbiology and lab waste (cultures, specimens).
RED: contaminated recyclable plastic: tubing, IV sets, bottles, catheters, urine bags, syringes WITHOUT needles,
vacutainers with needles cut, gloves.
WHITE (translucent, puncture-proof): sharps including metal: needles, syringes with fixed needles, needles from needle
tip cutters or burners, scalpels, blades, lancets, anything that can cut or pierce skin.
BLUE (cardboard box): glassware: broken or discarded glass, medicine vials and ampoules (except those contaminated with
cytotoxic drugs, which go in YELLOW); metallic body implants.
If the item is not biomedical waste (e.g. paper, food wrapper, household rubbish), the category is None.
Commonly confused, follow these exactly: a syringe with its needle still attached is WHITE (the plastic barrel alone,
needle removed, is RED). Used gloves are RED even when soiled; only the soaked dressing, cotton or gauze itself is
YELLOW. Glass vials and ampoules are BLUE even when empty.`;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    item: { type: "string", description: "Short name of the item" },
    category: { type: "string", enum: CATEGORIES },
    confidence: { type: "number", description: "0 to 1: how sure you are of the category" },
    reason: { type: "string", description: "One short sentence: what about the item places it in this category" },
    handling: { type: "string", description: "One short, practical safety step for disposing of it" },
    heard: { type: "string", description: "Voice only: what the person said, in their own language and script" },
  },
  required: ["item", "category", "confidence", "reason", "handling"],
};
const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    points: { type: "array", items: { type: "string" }, maxItems: 4 },
    actions: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
  required: ["headline", "points", "actions"],
};

const classifyPrompt = (lang: string) => `${CPCB_RULES}

You are helping staff at a small Indian clinic put one biomedical waste item in the right bag. Look at the photo,
identify the single main item, and classify it using only the rules above. Give your confidence honestly; if the photo is unclear, say so with a low
confidence. Write "item", "reason" and "handling" in ${lang}. Answer as JSON matching the schema.`;

const voicePrompt = (lang: string) => `${CPCB_RULES}

This audio is a clinic worker describing one waste item. They may speak Hindi, Marathi, Tamil, Telugu, Bengali,
Kannada, Malayalam, Gujarati, Punjabi, Urdu, English or another Indian language, possibly mixing languages. Put what they
said in "heard" (their own words and script). Then identify the item and classify it using only the rules above. If the
description is unclear or doesn't name a waste item, give a low confidence. Write "item", "reason" and "handling" in
${lang}. Answer as JSON matching the schema.`;

const briefPrompt = (lang: string, data: unknown) => `You assist a municipal officer who monitors biomedical waste
collection from small clinics in their city. Below are today's figures from the CleanCare dashboard as JSON.
Exception types: missed = bag left behind at the clinic's pickup; overdue = not collected within 24 h of logging;
weight = weight changed by over 10% at pickup; arrival = weight changed by over 10% at the treatment facility (CBWTF);
stuck = collected but not received at the CBWTF within 24 h.

Write a short daily brief in ${lang}: a one-line headline, up to 4 key points and up to 3 concrete follow-up actions
(name the clinics or bag IDs involved). Use ONLY these figures; never invent numbers, clinics or causes. If everything
is on track, say so briefly. Answer as JSON matching the schema.

${JSON.stringify(data)}`;

const recent = new Map<string, number[]>();

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const isBase64 = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= MAX_BASE64_CHARS && /^[A-Za-z0-9+/=]+$/.test(s);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
  if (!ALLOWED_ORIGINS.includes(origin)) return reply({ error: "Origin not allowed" }, 403);

  // Light abuse protection: the endpoint is public, and every call uses the shared quota
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= RATE_LIMIT) return reply({ error: "Too many requests, try again in a minute" }, 429);
  hits.push(now);
  recent.set(ip, hits);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Body must be JSON" }, 400);
  }
  const task = body.task ?? "classify";
  if (task === "reset") return resetSamples(body, reply, req.headers.get("authorization") ?? "");
  const providers = aiProviders();
  if (task === "health") return reply(await health(providers));
  if (!providers.length) return reply({ error: "Set VERTEX_API_KEY or GEMINI_API_KEY" }, 503);
  // The language name goes into the prompt, so only plain names are accepted ("Hindi", "Odia (Oriya)")
  const lang = typeof body.lang === "string" && /^[A-Za-z][A-Za-z ()-]{1,39}$/.test(body.lang) ? body.lang : "English";

  try {
    if (task === "classify") {
      if (!isBase64(body.image)) return reply({ error: "image must be base64 and under ~2 MB" }, 400);
      if (!IMAGE_TYPES.includes(body.mediaType as string)) return reply({ error: `mediaType must be one of ${IMAGE_TYPES.join(", ")}` }, 400);
      const json = await askGemini(providers, [{ inline_data: { mime_type: body.mediaType, data: body.image } }, { text: classifyPrompt(lang) }], RESULT_SCHEMA);
      const result = cleanResult(json);
      // App versions before 2.1 send no task and read a single "ITEM | CATEGORY | REASON" line
      if (!body.task) {
        const cat = result.category === "None" ? "Not biomedical waste" : result.category;
        return reply({ result, text: `ITEM: ${result.item} | CATEGORY: ${cat} | REASON: ${result.reason}` });
      }
      return reply({ result });
    }
    if (task === "voice") {
      if (!isBase64(body.audio)) return reply({ error: "audio must be base64 WAV and under ~2 MB" }, 400);
      const json = await askGemini(providers, [{ inline_data: { mime_type: "audio/wav", data: body.audio } }, { text: voicePrompt(lang) }], RESULT_SCHEMA);
      return reply({ result: cleanResult(json) });
    }
    if (task === "brief") {
      const size = JSON.stringify(body.data ?? null).length;
      if (!body.data || typeof body.data !== "object" || size > MAX_BRIEF_CHARS) return reply({ error: "data must be an object under 20 KB" }, 400);
      const json = await askGemini(providers, [{ text: briefPrompt(lang, body.data) }], BRIEF_SCHEMA);
      return reply({ brief: cleanBrief(json) });
    }
    return reply({ error: "task must be classify, voice, brief, reset or health" }, 400);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return reply({ error: "AI service error" }, 502);
  }
});

// Status for the About screen and pre-demo checks: can we reach Gemini and the database, and how fast.
// Reads model metadata and one bag ID only, so it uses no generation quota and returns no data.
async function health(providers: Provider[]) {
  const timed = async (check: () => Promise<boolean>) => {
    const t0 = Date.now();
    const ok = await check().catch(() => false);
    return { ok, ms: Date.now() - t0 };
  };
  const reachable = async (url: string, headers: Record<string, string>) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    return res.ok;
  };
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // countTokens is free on both services and proves the key, the model and the route all work
  const ping = (p: Provider) => timed(async () => {
    const res = await fetch(p.url(GEMINI_MODELS[0], "countTokens"), {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "x-goog-api-key": p.key, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
    });
    await res.body?.cancel();
    return res.ok;
  });
  const [checks, database] = await Promise.all([
    Promise.all(providers.map(async (p) => ({ via: p.name, ...await ping(p) }))),
    timed(async () => !!url && !!key && await reachable(`${url}/rest/v1/bags?select=id&limit=1`, { apikey: key, Authorization: `Bearer ${key}` })),
  ]);
  // "ai" is the service that will answer first; every configured service is listed too
  const ai = checks.find((c) => c.ok) ?? checks[0] ?? { via: "none", ok: false, ms: 0 };
  return { version: FUNCTION_VERSION, ai: { ...ai, model: GEMINI_MODELS[0] }, services: checks, database };
}

// Admin "Reset Demo" on the shared database. Visitors have no delete rights (supabase-setup.sql), so the
// only delete path is this one: it removes sample bags (no selection_method) and redemptions, nothing a
// clinic logged in the app. ponytail: anyone can still trigger it; real admin checks need Supabase Auth.
// Who is calling: the signed-in person's role from public.profiles, or null (no token, or not a real account)
async function callerRole(auth: string, url: string, key: string): Promise<string | null> {
  if (!/^Bearer ey/.test(auth)) return null;
  const who = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: auth } });
  if (!who.ok) { await who.body?.cancel(); return null; }
  const { id } = await who.json();
  const res = await fetch(`${url}/rest/v1/profiles?select=role&user_id=eq.${encodeURIComponent(id)}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const rows = res.ok ? await res.json() : [];
  return rows[0]?.role ?? null;
}

async function resetSamples(body: Record<string, unknown>, reply: (b: unknown, s?: number) => Response, auth: string) {
  const env = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!env || !svc) return reply({ error: "Database not configured" }, 503);
  if (await callerRole(auth, env, svc) !== "admin") return reply({ error: "Only an admin can reset the shared data" }, 403);
  const okRows = (a: unknown, max: number) => Array.isArray(a) && a.length <= max && a.every((r) => r && typeof r === "object" && !Array.isArray(r));
  if (!okRows(body.bags, 300) || !okRows(body.redemptions, 100)) return reply({ error: "bags and redemptions must be arrays of rows" }, 400);
  if ((body.bags as Record<string, unknown>[]).some((b) => typeof b.id !== "string" || !/^[A-Z0-9-]{3,40}$/.test(b.id) || b.selection_method != null)) {
    return reply({ error: "reset may only insert sample bags" }, 400);
  }
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return reply({ error: "Database not configured" }, 503);
  const db = (path: string, method: string, rows?: unknown, prefer = "return=minimal") =>
    fetch(`${url}/rest/v1/${path}`, { method, body: rows ? JSON.stringify(rows) : undefined,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: prefer } });
  const steps: [string, string, unknown?, string?][] = [
    ["bags?selection_method=is.null", "DELETE"],
    // Bags with the same ID as one logged in the app are skipped, so app data always survives
    ["bags", "POST", body.bags, "return=minimal,resolution=ignore-duplicates"],
    ["redemptions?clinic=neq.", "DELETE"],
    ["redemptions", "POST", body.redemptions, "return=representation"],
  ];
  let res: Response | undefined;
  for (const [path, method, rows, prefer] of steps) {
    if (rows && !(rows as unknown[]).length) continue;
    res = await db(path, method, rows, prefer);
    if (!res.ok) {
      console.error(path, method, res.status, await res.text());
      return reply({ error: "Reset failed" }, 502);
    }
  }
  return reply({ redemptions: res && body.redemptions && (body.redemptions as unknown[]).length ? await res.json() : [] });
}

// Only well-formed fields reach the app: known category, confidence clamped to 0-1, short strings
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanResult(r: Record<string, unknown>) {
  const category = CATEGORIES.find((c) => c.toLowerCase() === String(r.category ?? "").toLowerCase());
  if (!category) throw new Error(`Unexpected category in reply: ${JSON.stringify(r).slice(0, 300)}`);
  const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
  return { item: str(r.item, 80), category, confidence, reason: str(r.reason), handling: str(r.handling), heard: str(r.heard) };
}
function cleanBrief(b: Record<string, unknown>) {
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, n) : []);
  return { headline: str(b.headline, 200), points: list(b.points, 4), actions: list(b.actions, 3) };
}

// Google Gemini generateContent with JSON output. Moves on to the next model when one is busy or rate-limited.
// If a model rejects the JSON schema, it retries once with JSON output only (the prompt still describes the shape).
// Gemini is reached two ways, tried in order. Vertex AI (Google Cloud, billed to the project's Cloud credits; requests
// aren't used for training) comes first when VERTEX_API_KEY is set; the Gemini API key from AI Studio is the fallback,
// so a Vertex problem never takes the AI features down. Both take the same request body.
// Vertex gets a time limit: on a new project it serves Gemini from a shared pool, and image calls were seen taking
// 1.5 to 55 s. Past the limit the request is dropped and the Gemini API key answers instead (photos there: 2.6-5 s).
type Provider = { name: string; key: string; url: (model: string, method: string) => string; timeoutMs?: number };
function aiProviders(): Provider[] {
  const vertex = Deno.env.get("VERTEX_API_KEY")?.trim(), gemini = Deno.env.get("GEMINI_API_KEY")?.trim();
  const list: Provider[] = [];
  const timeoutMs = Number(Deno.env.get("VERTEX_TIMEOUT_MS")) || 8000;
  if (vertex) list.push({ name: "Vertex AI", key: vertex, timeoutMs, url: (m, fn) => `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:${fn}` });
  if (gemini) list.push({ name: "Gemini API", key: gemini, url: (m, fn) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:${fn}` });
  return list;
}

async function askGemini(providers: Provider[], parts: unknown[], schema: unknown): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  for (const p of providers) {
    try {
      return await askVia(p, parts, schema);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      console.error(`${p.name} failed, trying the next service`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function askVia(p: Provider, parts: unknown[], schema: unknown): Promise<Record<string, unknown>> {
  let lastError = "";
  // One deadline for everything tried on this service (retries and models included)
  const signal = p.timeoutMs ? AbortSignal.timeout(p.timeoutMs) : undefined;
  for (const model of GEMINI_MODELS) {
    for (const withSchema of [true, false]) {
      const started = Date.now();
      const res = await fetch(p.url(model, "generateContent"), {
        method: "POST",
        signal,
        headers: { "x-goog-api-key": p.key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          // Minimal thinking keeps replies quick; thinking still counts toward maxOutputTokens on Gemini 3.x
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.2,
            thinkingConfig: { thinkingLevel: "minimal" },
            responseMimeType: "application/json",
            ...(withSchema ? { responseJsonSchema: schema } : {}),
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      console.log(`${p.name} ${model}${withSchema ? "" : " (no schema)"} answered in ${Date.now() - started} ms (HTTP ${res.status})`);
      if (res.ok) {
        type Part = { text?: string; thought?: boolean };
        const out: Part[] = body.candidates?.[0]?.content?.parts ?? [];
        const text = out.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      }
      lastError = `${p.name} ${model} error ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 500)}`;
      if (!(res.status === 400 && withSchema)) break; // only a rejected schema is worth retrying without it
    }
    if (!/error (429|503)/.test(lastError)) break; // only busy/limit errors are worth another model
  }
  throw new Error(lastError);
}
