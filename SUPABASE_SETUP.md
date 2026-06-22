# Supabase setup — Dorsia BD Pipeline

## Security model

- **Login required** — unauthenticated visitors see only the login screen.
- **Row Level Security (RLS)** — database rejects reads/writes unless `is_bd_user()` passes (signed in + optional email domain allowlist).
- **Invite-only** — disable public sign-up in Supabase; you create/invite BD accounts.
- **Anon key in the browser is OK** — it cannot bypass RLS. Never put the **service role key** in Vercel or the frontend.

## 1. Create Supabase project

1. [supabase.com](https://supabase.com) → New project.
2. **Project Settings → API** — copy **Project URL** and **anon public** key.

## 2. Run database schema

1. **SQL Editor → New query**
2. Paste contents of `supabase/schema.sql` and **Run**.

## 3. (Recommended) Lock to Dorsia email domains

In SQL Editor:

```sql
update app_settings
set value = '["dorsia.co"]'::jsonb  -- add all domains your team uses
where key = 'allowed_email_domains';
```

If `allowed_email_domains` is empty, any authenticated user can access data.

## 4. Auth settings

1. **Authentication → Providers → Email** — enable Email.
2. **Authentication → Settings** — **disable “Enable sign ups”** (invite-only).
3. **Authentication → Users** — invite or create each BD team member (set a password or they use magic link).

Add your production URL under **Authentication → URL Configuration → Redirect URLs**:

- `https://dorsia-bd.vercel.app`
- `http://localhost:5173` (local dev)

## 5. Seed initial deals (one time)

From project root, with service role key (Settings → API → `service_role` — **never commit this**):

```powershell
$env:SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
node scripts/seed-deals.mjs
```

Loads 208 deals from `scripts/deals-seed.json`. Skips if the table already has rows.

## 6. Environment variables

**Local** — copy `.env.example` to `.env`:

```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

**Vercel** — Project → Settings → Environment Variables (Production + Preview):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Redeploy after adding vars.

## 7. Verify

1. Open https://dorsia-bd.vercel.app — login screen appears (not the pipeline).
2. Sign in as an invited BD user — ~208 deals load.
3. Edit a deal field → refresh → change persists.
4. Sign out → pipeline is not visible.
5. Open DevTools → Network — unauthenticated requests to `deals` return 401/empty (RLS).

## Editing the dashboard

- Edit **`Dashboard.jsx`** at project root (your working copy).
- Copy to **`src/App.jsx`** before deploy, fixing imports:
  - `./src/lib/...` in Dashboard → `./lib/...` in App.jsx
  - `./src/components/...` → `./components/...`

Or run: `node scripts/sync-dashboard.mjs` (if added).
