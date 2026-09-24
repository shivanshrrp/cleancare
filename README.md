# CleanCare Waste Tracker

Tracks biomedical waste bags in small clinics, from the clinic to treatment. Live at
https://shivanshrrp.github.io/cleancare/

| Role | What it does |
| --- | --- |
| **Clinic** | **Rewards** card with the clinic's point balance, this month's points by colour, deductions and leaderboard rank; **Redeem points** for supplies. Log a bag (category, weight). It gets an ID and QR code, and **Print label** makes a visiting-card-size (89 × 51 mm) PDF label. **Not sure? Scan an item** photographs a loose item and suggests its bag colour (staff confirm before saving) |
| **Collector** | For the collection crew. Scan or type the bag ID at pickup and record the weight (and flag a wrong colour or contamination), then **Start trip** when the vehicle leaves: every bag on board is marked *In transit* at that time, with the vehicle number |
| **Facility** | For staff at the treatment plant (CBWTF), not the collector. Confirm each bag on arrival with its weight and a colour check, then record the treatment method and certificate |
| **Monitor** | Today's counts, activity and exceptions: bags missed at pickup, uncollected after 24 h, not received at the CBWTF within 24 h of pickup (the CPCB rule), or with a weight change over 10% at any handover. Each clinic is listed with its registration code. Also the month's reward points split into government- and CBWTF-funded shares, a table of mis-sorted bags, and a separate list of **inactive clinics** (no bag logged in `INACTIVITY_DAYS`, or never) |
| **Leaderboard** | Clinics ranked by this month's points; only names and totals, top 3 highlighted, your clinic marked |
| **Track** | A parcel-style timeline for any bag, showing the date and time of every checkpoint; links like `?track=CL-ABC-00231` open it directly |

A single static page (`index.html`) with no build step. Data is shared in real time through Supabase.
There's also an Android app: https://github.com/shivanshrrp/cleancare/releases/latest/download/CleanCare.apk

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app |
| `translations.js` | Every piece of interface text, in English, Hindi and Marathi. See *Languages* below |
| `config.js` | Your Supabase URL and key. Leave blank for demo mode, where each browser keeps its own data |
| `supabase-setup.sql` | Creates the database tables (bags, redemptions). Run once; later additions are safe to re-run |
| `supabase/functions/classify-waste/` | Server function behind "Scan an item": sends the photo to Google Gemini (free tier), or Claude if only `ANTHROPIC_API_KEY` is set. Needs the `GEMINI_API_KEY` secret in Supabase → Edge Functions → Secrets |

## 1. Set up the shared database (Supabase, free)

1. Sign up at https://supabase.com and create a new project (any name and region).
2. Open **SQL Editor → New query**, paste in all of `supabase-setup.sql`, and click **Run**.
3. Open **Project Settings → API** (or **Connect**) and copy:
   - the **Project URL**
   - the **anon** / **publishable** key. Never use the `service_role` / secret key; it would be public on the site.
4. Paste both into `config.js`.

The first time the site opens, it loads sample bags from 10 clinics into the database. **Reset Demo** reloads them.

## 2. Put it live on GitHub Pages

1. Create a new **public** repository on GitHub, e.g. `cleancare`. Don't add a README.
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<your-username>/cleancare.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, then
   **Branch: `main` / `(root)` → Save**.
4. After a minute or so the site is live at `https://<your-username>.github.io/cleancare/`.

Live camera scanning works on the live site because GitHub Pages serves it over HTTPS.

To update the site later, commit and `git push`. Pages redeploys automatically.

## Chain of custody

Each bag keeps an ordered list of timestamped events, one per handover, in the `events` column:

| Step | Who scans it | Recorded |
| --- | --- | --- |
| `logged` | Clinic | time, clinic, weight |
| `collected` | Collector | time, collector ID, weight at pickup |
| `in_transit` | Collector (Start trip) | time, collector ID, vehicle |
| `received` | CBWTF staff (Facility) | time, facility name, arrival weight |
| `treated` | CBWTF staff (Facility) | time, facility name, treatment method, certificate |

Track draws its timeline from these events, and the exception checks read them too: each weighed handover is
compared with the one before it. The stage columns (`status`, `collected_at`, …) still hold each bag's current
state, so older bags without events get a history rebuilt from them.

The sample clinics are small facilities (clinics, dental practices, pathology labs, diagnostic centres). Each
has a three-letter code used in bag IDs and a registration code made of five letters from its name, the
pincode, state code, facility type (CL, DH, PL, DC) and a serial number, e.g. `SAHYA-411030-MH-PL-005`.

## Reward points

Clinics earn points, never money, and spend them on healthcare supplies. The ₹ figures in the app are only a
reference (`POINTS_PER_RUPEE`, 10 points ≈ ₹1). All the numbers are constants at the top of the script in `index.html`:

| Constant | Meaning |
| --- | --- |
| `CLINIC_POINTS` | Points per verified kg: White 60, Yellow 50, Red 30, Blue 20 (placeholders) |
| `PENALTY_POINTS` | −25 per mis-sorted bag |
| `GOVT_FUNDED_SHARE` | Share of issued points funded by government (0.6); the CBWTF funds the rest |
| `REWARD_CATALOGUE` | Supplies clinics can request, a growing list of `{ id, pointCost, name }`. Add an item with one line; `name` can be plain text or `{ en, hi, mr }` |
| `INACTIVITY_DAYS` | Days without a logged bag before a clinic shows as inactive (3). A reminder only: it never costs points |

Points are never stored. They're worked out from each bag's events every time: a bag earns kg (as weighed at the
CBWTF) × the rate for its colour once it has been logged, collected and received at the CBWTF with the weight at each
handover within 10%, counted in the month it was received. If the collector or CBWTF corrects the colour, or finds
wrong items mixed in, a `reclassified` or `contamination` event is added to the bag with −25 points, so every
deduction shows in the bag's history. The only separate data is the `redemptions` table (what was requested with
points), created by `supabase-setup.sql`.

## Languages

The app is available in English, हिंदी (Hindi) and मराठी (Marathi), chosen from the menu in the header and
remembered on each device. All interface text lives in `translations.js`, one block per language with the same
keys; the page uses `t("key")` to look text up and falls back to English for anything missing.

To add a language, copy the `en` block in `translations.js`, give it the language code (e.g. `ta`), translate the
values and keep the keys and `{placeholders}` as they are. Nothing else needs to change: the language menu lists
every block automatically. Bag IDs, clinic names, times and typed values are never translated, and printed PDF
labels stay in English because the PDF fonts can't draw Devanagari.

## Notes

- **Security:** the demo database lets anyone who has the site link add, change or delete bags, and
  **Reset Demo** wipes the data for everyone. Add Supabase Auth before using it with real clinic data.
- **Supabase free tier:** projects pause after about a week with no activity. Resume from the Supabase
  dashboard.
- **Local testing:** run `python3 -m http.server 8765` in this folder and open http://localhost:8765.
