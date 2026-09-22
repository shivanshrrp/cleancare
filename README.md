# CleanCare Waste Tracker

Tracks biomedical waste bags in small clinics: the clinic logs and QR-labels each bag, the collector
scans it at pickup, and the monitor sees exceptions (missed bags, weight mismatches over 10%).

A single static page (`index.html`) with no build step. The data is shared through Supabase.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app |
| `config.js` | Your Supabase URL and key. Leave blank for demo mode, where each browser keeps its own data |
| `supabase-setup.sql` | Creates the database table. Run once |

## 1. Set up the shared database (Supabase, free)

1. Sign up at https://supabase.com and create a new project (any name and region).
2. Open **SQL Editor → New query**, paste in all of `supabase-setup.sql`, and click **Run**.
3. Open **Project Settings → API** (or **Connect**) and copy:
   - the **Project URL**
   - the **anon** / **publishable** key. Never use the `service_role` / secret key; it would be public on the site.
4. Paste both into `config.js`.

The first time the site opens, it loads the 12 sample bags into the database.

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

## Notes

- **Security:** the demo database lets anyone who has the site link add, change or delete bags, and
  **Reset Demo** wipes the data for everyone. Add Supabase Auth before using it with real clinic data.
- **Supabase free tier:** projects pause after about a week with no activity. Resume from the Supabase
  dashboard.
- **Local testing:** run `python3 -m http.server 8765` in this folder and open http://localhost:8765.
