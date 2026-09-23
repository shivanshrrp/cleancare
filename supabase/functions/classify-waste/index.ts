// CleanCare "Not sure? Scan an item": suggests a CPCB bag colour for a photographed item.
//
// Runs on Supabase so the Anthropic API key stays server-side (the web app is public).
// The browser sends { image: <base64 JPEG/PNG/WebP>, mediaType }, and gets back { text } in the
// format "ITEM: ... | CATEGORY: ... | REASON: ...". The web app parses it and only ever
// *suggests* a colour: staff confirm before anything is logged.
//
// Secret required:  supabase secrets set ANTHROPIC_API_KEY=... --project-ref <ref>

const MODEL = "claude-sonnet-4-6";
const ALLOWED_ORIGINS = ["https://shivanshrrp.github.io", "http://localhost:8765"];
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BASE64_CHARS = 3_000_000; // ~2.2 MB image; the app sends ~100-300 KB
const RATE_LIMIT = 20; // requests per minute per client IP (per function instance)

const PROMPT = `You are helping a small clinic sort biomedical waste according to India's CPCB Bio-Medical Waste Management Rules colour-coding scheme. Look at this photo of a single waste item and identify it. Then classify it into exactly one of these four categories:
YELLOW — human anatomical waste, soiled waste, expired medicines, chemical or cytotoxic waste, blood-soaked material
RED — contaminated recyclable plastics: tubing, IV sets, catheters, gloves, syringe barrels without needles
WHITE — sharps: needles, syringes with fixed needles, blades, scalpels, anything that can pierce skin
BLUE — broken glass, metal implants, ampoules, vials
If the item doesn't look like biomedical waste at all, say so instead of forcing a category.
Respond in exactly this format: ITEM: <name> | CATEGORY: <Yellow/Red/White/Blue/Not biomedical waste> | REASON: <one short sentence citing what about the item places it there>`;

const recent = new Map<string, number[]>();

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
  if (!ALLOWED_ORIGINS.includes(origin)) return reply({ error: "Origin not allowed" }, 403);

  // Light abuse protection: the endpoint is public, and every call costs money
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= RATE_LIMIT) return reply({ error: "Too many requests, try again in a minute" }, 429);
  hits.push(now);
  recent.set(ip, hits);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply({ error: "ANTHROPIC_API_KEY is not set" }, 503);

  let image: string, mediaType: string;
  try {
    ({ image, mediaType } = await req.json());
  } catch {
    return reply({ error: "Body must be JSON" }, 400);
  }
  if (typeof image !== "string" || !image || image.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return reply({ error: "image must be base64 and under ~2 MB" }, 400);
  }
  if (!MEDIA_TYPES.includes(mediaType)) return reply({ error: `mediaType must be one of ${MEDIA_TYPES.join(", ")}` }, 400);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) {
    console.error("Anthropic API error", res.status, await res.text());
    return reply({ error: "AI service error" }, 502);
  }
  const message = await res.json();
  if (message.stop_reason === "refusal") return reply({ error: "The AI declined this image" }, 422);
  const text = (message.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
  return reply({ text });
});
