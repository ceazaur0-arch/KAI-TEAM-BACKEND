# KAI TeamTrack backend (runs inside Supabase)

No server to host. The API is one Supabase Edge Function (`supabase/functions/api`), the data is in
Supabase Postgres, photos go to Supabase Storage, logins use Supabase Auth.

## 1. Database and your admin account (once)
1. Create a project at supabase.com.
2. SQL Editor: paste and run `supabase/schema.sql`.
3. Authentication > Users > Add user: create YOUR account (email + password).
4. SQL Editor: insert your profile as Super Administrator. The statement is at the bottom of
   schema.sql; use your user's UUID from the Users page.
5. Authentication > URL Configuration: set Site URL to your frontend domain and add it as a redirect URL.

## 2. Deploy the function
Install the Supabase CLI (https://supabase.com/docs/guides/cli), then from this folder:
```
supabase login
supabase link --project-ref YOUR_PROJECT_REF
cp supabase/.env.secrets.example supabase/.env.secrets      # fill in FRONTEND_ORIGIN and IPQS_API_KEY
supabase secrets set --env-file supabase/.env.secrets
supabase functions deploy api --no-verify-jwt
```
Check: https://YOUR_PROJECT_REF.supabase.co/functions/v1/api/health  ->  {"ok":true}

SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are supplied to the function by
Supabase automatically. You never paste the service-role key anywhere, and it never touches the frontend.
`--no-verify-jwt` is intentional: login must work without a token; every other route checks the
session itself in code.

## 3. Deploy from GitHub (optional)
Push this folder to GitHub. Add repo secrets `SUPABASE_ACCESS_TOKEN` (supabase.com/dashboard/account/tokens)
and `SUPABASE_PROJECT_REF`. Every push to `main` that changes the function redeploys it
(`.github/workflows/deploy.yml`). Secrets from step 2 are stored in Supabase, not in GitHub.

## 4. Point the frontend at it
In Hostless set `API_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1` (no trailing slash).
`FRONTEND_ORIGIN` here must be exactly your frontend's address, or browsers will block requests.

## Permissions
Super Administrator: approvals, referral verification, task review, invitations, audit log.
Manager: create tasks, team-wide read. Analyst: team-wide read. KOL/Contributor: own records only.
Seats: 1 KOL, 2 Contributors, 1 Manager, 1 Analyst. Submitter attribution comes from the session.

## IPQS
Each referral gets an email check and a check of the submitting IP. Results are advisory flags shown to
the admin; nothing is auto-rejected, and referrals still work if IPQS is down. Duplicate emails are
blocked by a unique index in the database.

## Notes
- Login rate limiting is Supabase Auth's built-in limit (edge functions are stateless, so there is no
  in-function counter).
- Not built yet: evidence file uploads (profile photos only), PDF/CSV export.
