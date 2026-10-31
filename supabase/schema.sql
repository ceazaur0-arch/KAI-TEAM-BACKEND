-- KAI TeamTrack schema. Run once in Supabase SQL Editor.
-- The backend uses the service-role key; RLS is enabled with NO policies,
-- so the anon/public key can never read or write these tables directly.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  handle text not null,
  email text not null unique,
  role text not null check (role in ('Super Administrator','KOL','Contributor','Manager','Analyst')),
  avatar_url text,
  status text not null default 'Active' check (status in ('Active','Away','Suspended')),
  responsibilities text[] not null default '{}',
  bio text not null default '',
  phone text, telegram text, x_handle text,
  created_at timestamptz not null default now()
);
-- Only one Super Administrator may ever exist.
create unique index if not exists one_super_admin on profiles (role) where role = 'Super Administrator';

create table if not exists partnerships (
  id uuid primary key default gen_random_uuid(),
  applicant_name text not null, organization text not null, category text not null,
  email text not null, avatar_url text, logo_url text, description text not null default '',
  social_links jsonb not null default '{}',
  submitted_by uuid not null references profiles(id),
  status text not null default 'Pending' check (status in ('Pending','Under Review','Approved','Rejected','Follow-up Required')),
  priority text not null default 'Medium' check (priority in ('Low','Medium','High','Critical')),
  expected_tvl_or_users text,
  internal_notes jsonb not null default '[]',
  follow_up_actions jsonb not null default '[]',
  review_history jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists signups (
  id uuid primary key default gen_random_uuid(),
  applicant_name text not null, email text not null, organization text not null, category text not null,
  submitted_by uuid not null references profiles(id),
  status text not null default 'Pending' check (status in ('Pending','Under Review','Approved','Rejected')),
  evidence_url text, evidence_notes text not null default '',
  reviewer_id uuid references profiles(id), review_date date, review_notes text,
  contact_telegram text, estimated_reach text,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null, description text not null default '',
  assigned_to uuid not null references profiles(id),
  created_by uuid not null references profiles(id),
  priority text not null default 'Medium' check (priority in ('Low','Medium','High','Urgent')),
  status text not null default 'Assigned' check (status in ('Assigned','In Progress','Submitted','Under Review','Completed','Overdue')),
  due_date date not null,
  category text not null default 'Operations',
  submission jsonb, admin_feedback text,
  created_at timestamptz not null default now()
);

create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referred_name text not null,
  gmail_address text not null,
  referral_source text not null,
  submitted_by uuid not null references profiles(id),
  supporting_evidence text not null default '', evidence_url text, internal_notes text not null default '',
  status text not null default 'Admin Verification' check (status in ('Submitted','Awaiting Registration','Evidence Submitted','Admin Verification','Verified','Rejected')),
  verified_at date, verified_by uuid references profiles(id), rejection_reason text,
  risk_flags jsonb,            -- IPQS results: advisory only, never auto-rejects
  created_at timestamptz not null default now()
);
-- Server-side duplicate protection (case-insensitive)
create unique index if not exists referrals_unique_gmail on referrals (lower(trim(gmail_address)));

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  title text not null, description text not null default '', category text not null,
  responsible_member uuid not null references profiles(id),
  supporting_link text, evidence_notes text not null default '',
  metrics jsonb not null default '{}',
  status text not null default 'Completed' check (status in ('Draft','Published','Completed','Under Review')),
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient uuid references profiles(id) on delete cascade,  -- null = all admins
  title text not null, message text not null, type text not null,
  priority text not null default 'medium', action_url text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor uuid references profiles(id), actor_name text not null, actor_role text not null,
  action text not null, target text not null, details text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table partnerships enable row level security;
alter table signups enable row level security;
alter table tasks enable row level security;
alter table referrals enable row level security;
alter table activities enable row level security;
alter table notifications enable row level security;
alter table audit_logs enable row level security;

-- Public bucket for profile photos only (evidence stays out of public storage).
insert into storage.buckets (id, name, public) values ('avatars','avatars', true) on conflict do nothing;

-- After creating YOUR auth user (Authentication > Users > Add user), run:
-- insert into profiles (id, name, handle, email, role)
-- values ('<your-auth-user-uuid>', 'Your Name', '@yourhandle', 'you@example.com', 'Super Administrator');
