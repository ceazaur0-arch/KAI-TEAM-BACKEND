import { Hono } from 'npm:hono@4';
import { cors } from 'npm:hono@4/cors';
import {
  db, anon, z, parse, str, url, date, today, HttpError, ADMIN, Vars,
  requireAuth, requireAdmin, requireRoles, audit, notify, checkReferralRisk, clientIp,
} from './core.ts';
import * as m from './mappers.ts';

// The function is named "api", so Supabase serves it at /functions/v1/api/...
const app = new Hono<{ Variables: Vars }>().basePath('/api');

app.use('*', cors({
  origin: Deno.env.get('FRONTEND_ORIGIN') || '',
  allowHeaders: ['Authorization', 'Content-Type', 'apikey', 'x-client-info'],
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
}));

app.onError((err: any, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status as any);
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500); // never leak internals
});

app.get('/health', (c) => c.json({ ok: true }));

// ---------------- auth (public) ----------------
app.post('/auth/login', async (c) => {
  const b = await parse(c, z.object({ email: z.string().email(), password: z.string().min(1).max(200) }));
  const { data, error } = await anon().auth.signInWithPassword(b);
  if (error || !data.session) throw new HttpError(401, 'Incorrect email or password.');
  const { data: profile } = await db.from('profiles').select('status').eq('id', data.user.id).single();
  if (!profile) throw new HttpError(403, 'This account has not been invited to the platform.');
  if (profile.status === 'Suspended') throw new HttpError(403, 'This account is suspended.');
  const s = data.session;
  return c.json({ accessToken: s.access_token, refreshToken: s.refresh_token, expiresAt: s.expires_at });
});

app.post('/auth/refresh', async (c) => {
  const b = await parse(c, z.object({ refreshToken: z.string().min(1) }));
  const { data, error } = await anon().auth.refreshSession({ refresh_token: b.refreshToken });
  if (error || !data.session) throw new HttpError(401, 'Session expired. Please sign in again.');
  const s = data.session;
  return c.json({ accessToken: s.access_token, refreshToken: s.refresh_token, expiresAt: s.expires_at });
});

// Always 200 so this can't be used to discover which emails have accounts.
app.post('/auth/forgot', async (c) => {
  const b = await parse(c, z.object({ email: z.string().email() }));
  await anon().auth.resetPasswordForEmail(b.email, { redirectTo: Deno.env.get('FRONTEND_ORIGIN') });
  return c.json({ ok: true });
});

// After an invitation / reset email link: the short-lived token proves the person owns the address.
app.post('/auth/set-password', async (c) => {
  const b = await parse(c, z.object({ accessToken: z.string().min(20), password: z.string().min(10).max(200) }));
  const { data, error } = await db.auth.getUser(b.accessToken);
  if (error || !data?.user) throw new HttpError(401, 'This link is invalid or has expired.');
  const { data: profile } = await db.from('profiles').select('id').eq('id', data.user.id).single();
  if (!profile) throw new HttpError(403, 'This account has not been invited to the platform.');
  const { error: uErr } = await db.auth.admin.updateUserById(data.user.id, { password: b.password });
  if (uErr) throw new HttpError(400, uErr.message);
  return c.json({ ok: true });
});

// ---------------- everything below requires a signed-in, active team member ----------------
app.use('*', requireAuth);

app.get('/bootstrap', async (c) => {
  const user = c.get('user'), isAdmin = c.get('isAdmin'), canSeeAll = c.get('canSeeAll');
  const own = (q: any, col: string) => (canSeeAll ? q : q.eq(col, user.id));

  const [profiles, parts, sgn, tsk, refs, acts, notifs] = await Promise.all([
    db.from('profiles').select('*').order('created_at'),
    own(db.from('partnerships').select('*').order('created_at', { ascending: false }), 'submitted_by'),
    own(db.from('signups').select('*').order('created_at', { ascending: false }), 'submitted_by'),
    own(db.from('tasks').select('*').order('created_at', { ascending: false }), 'assigned_to'),
    own(db.from('referrals').select('*').order('created_at', { ascending: false }), 'submitted_by'),
    own(db.from('activities').select('*').order('created_at', { ascending: false }), 'responsible_member'),
    db.from('notifications').select('*').or(`recipient.eq.${user.id}${isAdmin ? ',recipient.is.null' : ''}`)
      .order('created_at', { ascending: false }).limit(100),
  ]);
  const failed = [profiles, parts, sgn, tsk, refs, acts, notifs].find((x: any) => x.error);
  if (failed) throw (failed as any).error;

  const names: Record<string, string> = Object.fromEntries(profiles.data.map((p: any) => [p.id, p.name]));
  const tasks = tsk.data.map((t: any) => {
    const row = m.toTask(t, names);
    if (['Assigned', 'In Progress'].includes(row.status) && row.dueDate < today()) row.status = 'Overdue';
    return row;
  });
  // Stats are computed from the records, never from hand-edited counters.
  const stat = (p: any) => ({
    completed: tasks.filter((t: any) => t.assignedToMemberId === p.id && t.status === 'Completed').length,
    pending: tasks.filter((t: any) => t.assignedToMemberId === p.id && t.status !== 'Completed').length,
    signups: sgn.data.filter((s: any) => s.submitted_by === p.id).length,
    referrals: refs.data.filter((x: any) => x.submitted_by === p.id).length,
  });
  const members = profiles.data.map((p: any) => {
    const mem = m.toMember(p, canSeeAll || p.id === user.id ? stat(p) : {});
    if (!isAdmin && p.id !== user.id) { delete mem.phone; delete mem.telegram; if (!canSeeAll) mem.email = ''; }
    return mem;
  });

  let auditLogs: any[] = [];
  if (isAdmin) {
    const a = await db.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
    auditLogs = (a.data || []).map(m.toAudit);
  }
  return c.json({
    me: user.id, members,
    partnerships: parts.data.map((x: any) => m.toPartnership(x, names)),
    signups: sgn.data.map((x: any) => m.toSignup(x, names)),
    tasks,
    referrals: refs.data.map((x: any) => m.toReferral(x, names, isAdmin)),
    activities: acts.data.map((x: any) => m.toActivity(x, names)),
    notifications: notifs.data.map(m.toNotification),
    auditLogs,
  });
});

// ---------------- partnerships ----------------
const loadPartnership = async (id: string) => (await db.from('partnerships').select('*').eq('id', id).single()).data;

app.post('/partnerships', async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({
    applicantName: str(120).min(1), organization: str(160).min(1), category: str(60).min(1),
    email: z.string().email().max(200), description: str(2000).default(''), avatarUrl: url, logoUrl: url,
    socialLinks: z.object({ website: url, x: url, telegram: str(200).optional(), discord: str(200).optional() }).default({}),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']).default('Medium'),
    expectedTvlOrUsers: str(80).optional(),
  }));
  const { data, error } = await db.from('partnerships').insert({
    applicant_name: b.applicantName, organization: b.organization, category: b.category, email: b.email,
    description: b.description, avatar_url: b.avatarUrl, logo_url: b.logoUrl, social_links: b.socialLinks,
    priority: b.priority, expected_tvl_or_users: b.expectedTvlOrUsers,
    submitted_by: user.id, // attribution always comes from the session
    internal_notes: ['Application initially registered.'],
    review_history: [{ date: today(), reviewerName: user.name, action: 'Created Partnership Application' }],
  }).select().single();
  if (error) throw error;
  await audit(user, 'Submitted Partnership Application', b.organization);
  await notify({ title: `New Partnership: ${b.organization}`, message: `${user.name} submitted ${b.category} partnership application.`, type: 'partnership', priority: 'high', actionUrl: 'partnerships' });
  return c.json({ id: data.id }, 201);
});

app.patch('/partnerships/:id/status', requireAdmin, async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({ status: z.enum(['Pending', 'Under Review', 'Approved', 'Rejected', 'Follow-up Required']), note: str(1000).optional() }));
  const p = await loadPartnership(c.req.param('id'));
  if (!p) throw new HttpError(404, 'Not found.');
  const { error } = await db.from('partnerships').update({
    status: b.status,
    internal_notes: b.note ? [...p.internal_notes, b.note] : p.internal_notes,
    review_history: [...p.review_history, { date: today(), reviewerName: user.name, action: `Status updated to ${b.status}`, note: b.note }],
  }).eq('id', p.id);
  if (error) throw error;
  await audit(user, `Updated Partnership Status to ${b.status}`, `ID: ${p.id}`, b.note);
  await notify({ recipient: p.submitted_by, title: `${p.organization}: ${b.status}`, message: `Your partnership application is now "${b.status}".`, type: 'partnership', actionUrl: 'partnerships' });
  return c.json({ ok: true });
});

app.post('/partnerships/:id/notes', requireAdmin, async (c) => {
  const b = await parse(c, z.object({ note: str(1000).min(1) }));
  const p = await loadPartnership(c.req.param('id'));
  if (!p) throw new HttpError(404, 'Not found.');
  await db.from('partnerships').update({ internal_notes: [...p.internal_notes, b.note] }).eq('id', p.id);
  return c.json({ ok: true });
});

app.post('/partnerships/:id/followups', requireAdmin, async (c) => {
  const b = await parse(c, z.object({ action: str(300).min(1), assignedToId: z.string().uuid(), dueDate: date }));
  const p = await loadPartnership(c.req.param('id'));
  if (!p) throw new HttpError(404, 'Not found.');
  const { data: who } = await db.from('profiles').select('name').eq('id', b.assignedToId).single();
  if (!who) throw new HttpError(400, 'Unknown member.');
  const fa = { id: crypto.randomUUID(), action: b.action, assignedToId: b.assignedToId, assignedToName: who.name, dueDate: b.dueDate, completed: false };
  await db.from('partnerships').update({ follow_up_actions: [...p.follow_up_actions, fa] }).eq('id', p.id);
  return c.json(fa, 201);
});

app.patch('/partnerships/:id/followups/:actionId/toggle', async (c) => {
  const user = c.get('user');
  const p = await loadPartnership(c.req.param('id'));
  if (!p) throw new HttpError(404, 'Not found.');
  const target = p.follow_up_actions.find((f: any) => f.id === c.req.param('actionId'));
  if (!target) throw new HttpError(404, 'Not found.');
  // The assignee (e.g. the Manager following up) or the admin can tick it off.
  if (!c.get('isAdmin') && target.assignedToId !== user.id) throw new HttpError(403, 'Not your follow-up.');
  await db.from('partnerships').update({
    follow_up_actions: p.follow_up_actions.map((f: any) => (f.id === target.id ? { ...f, completed: !f.completed } : f)),
  }).eq('id', p.id);
  return c.json({ ok: true });
});

// ---------------- signups ----------------
app.post('/signups', async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({
    applicantName: str(120).min(1), email: z.string().email().max(200), organization: str(160).min(1), category: str(60).min(1),
    evidenceUrl: url, evidenceNotes: str(2000).default(''), contactTelegram: str(100).optional(), estimatedReach: str(80).optional(),
  }));
  const { data, error } = await db.from('signups').insert({
    applicant_name: b.applicantName, email: b.email, organization: b.organization, category: b.category,
    evidence_url: b.evidenceUrl, evidence_notes: b.evidenceNotes, contact_telegram: b.contactTelegram,
    estimated_reach: b.estimatedReach, submitted_by: user.id,
  }).select().single();
  if (error) throw error;
  await audit(user, 'Submitted Partnership Signup', b.organization);
  await notify({ title: `New Signup: ${b.organization}`, message: `${b.applicantName} registered under ${b.category}.`, type: 'signup', actionUrl: 'signups' });
  return c.json({ id: data.id }, 201);
});

app.patch('/signups/:id/review', requireAdmin, async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({ status: z.enum(['Pending', 'Under Review', 'Approved', 'Rejected']), notes: str(1000).optional() }));
  const { data: s } = await db.from('signups').select('id, submitted_by, organization').eq('id', c.req.param('id')).single();
  if (!s) throw new HttpError(404, 'Not found.');
  const { error } = await db.from('signups').update({ status: b.status, reviewer_id: user.id, review_date: today(), review_notes: b.notes }).eq('id', s.id);
  if (error) throw error;
  await audit(user, `Reviewed Signup (${b.status})`, `ID: ${s.id}`, b.notes);
  await notify({ recipient: s.submitted_by, title: `Signup ${b.status}: ${s.organization}`, message: b.notes || `Your signup is now "${b.status}".`, type: 'signup', actionUrl: 'signups' });
  return c.json({ ok: true });
});

// ---------------- tasks ----------------
const loadTask = async (id: string) => (await db.from('tasks').select('*').eq('id', id).single()).data;

app.post('/tasks', requireRoles('Manager'), async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({
    title: str(160).min(1), description: str(2000).default(''), assignedToMemberId: z.string().uuid(),
    priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).default('Medium'), dueDate: date,
    category: z.enum(['Partnership', 'Community', 'Research', 'Campaign', 'Operations']).default('Operations'),
  }));
  const { data: assignee } = await db.from('profiles').select('id, name, status').eq('id', b.assignedToMemberId).single();
  if (!assignee || assignee.status === 'Suspended') throw new HttpError(400, 'Invalid assignee.');
  const { data, error } = await db.from('tasks').insert({
    title: b.title, description: b.description, assigned_to: b.assignedToMemberId, created_by: user.id,
    priority: b.priority, due_date: b.dueDate, category: b.category,
  }).select().single();
  if (error) throw error;
  await audit(user, 'Assigned Task', `${b.title} to ${assignee.name}`);
  await notify({ recipient: assignee.id, title: `Task Assigned: ${b.title}`, message: `Due ${b.dueDate}`, type: 'task', priority: b.priority === 'Urgent' ? 'high' : 'medium', actionUrl: 'tasks' });
  return c.json({ id: data.id }, 201);
});

// Assignees may only move their own task to "In Progress"; Admin/Manager can set any non-completion status.
app.patch('/tasks/:id/status', async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({ status: z.enum(['Assigned', 'In Progress', 'Under Review']) }));
  const t = await loadTask(c.req.param('id'));
  if (!t) throw new HttpError(404, 'Not found.');
  const manages = c.get('isAdmin') || user.role === 'Manager';
  if (!manages && !(t.assigned_to === user.id && b.status === 'In Progress')) throw new HttpError(403, 'Not permitted.');
  await db.from('tasks').update({ status: b.status }).eq('id', t.id);
  await audit(user, `Updated Task Status to ${b.status}`, `ID: ${t.id}`);
  return c.json({ ok: true });
});

app.post('/tasks/:id/submit', async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({ textExplanation: str(2000).min(1), linkUrl: url, attachmentName: str(200).optional() }));
  const t = await loadTask(c.req.param('id'));
  if (!t) throw new HttpError(404, 'Not found.');
  if (t.assigned_to !== user.id) throw new HttpError(403, 'Only the assignee can submit work.');
  if (t.status === 'Completed') throw new HttpError(409, 'Task is already completed.');
  await db.from('tasks').update({ status: 'Submitted', submission: { ...b, submittedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) } }).eq('id', t.id);
  await audit(user, 'Submitted Completed Task Work', `Task ID: ${t.id}`);
  await notify({ title: 'Task Work Submitted', message: `${user.name} submitted "${t.title}" for review.`, type: 'task', priority: 'high', actionUrl: 'tasks' });
  return c.json({ ok: true });
});

app.post('/tasks/:id/review', requireAdmin, async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({ approved: z.boolean(), feedback: str(1000).optional() }));
  const t = await loadTask(c.req.param('id'));
  if (!t) throw new HttpError(404, 'Not found.');
  await db.from('tasks').update({ status: b.approved ? 'Completed' : 'In Progress', admin_feedback: b.feedback }).eq('id', t.id);
  await audit(user, b.approved ? 'Approved Task Submission' : 'Requested Task Revision', `Task ID: ${t.id}`, b.feedback);
  await notify({ recipient: t.assigned_to, title: b.approved ? `Approved: ${t.title}` : `Revision requested: ${t.title}`, message: b.feedback || '', type: 'task', actionUrl: 'tasks' });
  return c.json({ ok: true });
});

// ---------------- referrals ----------------
app.post('/referrals', async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({
    referredName: str(120).min(1), gmailAddress: z.string().email().max(200), referralSource: str(80).min(1),
    supportingEvidence: str(2000).default(''), evidenceUrl: url, internalNotes: str(1000).default(''),
  }));
  const email = b.gmailAddress.trim().toLowerCase();
  const risk = await checkReferralRisk({ email, ip: clientIp(c) }); // best-effort, 5s timeout, advisory only
  const { data, error } = await db.from('referrals').insert({
    referred_name: b.referredName, gmail_address: email, referral_source: b.referralSource,
    supporting_evidence: b.supportingEvidence, evidence_url: b.evidenceUrl, internal_notes: b.internalNotes,
    submitted_by: user.id, status: 'Admin Verification', risk_flags: risk,
  }).select().single();
  // The unique index on lower(trim(gmail_address)) is the real duplicate guard.
  if ((error as any)?.code === '23505') throw new HttpError(409, 'This email has already been referred.', { duplicate: true });
  if (error) throw error;
  await audit(user, 'Logged Referral', `${b.referredName} (${email})`);
  const flagged = (risk as any).checked && (risk as any).flags.length > 0;
  await notify({
    title: `New Referral Logged: ${b.referredName}`,
    message: flagged ? `Needs verification. Risk signals: ${(risk as any).flags.join('; ')}` : `Submitted by ${user.name}, awaiting verification.`,
    type: 'referral', priority: flagged ? 'high' : 'medium', actionUrl: 'referrals',
  });
  return c.json({ id: data.id, flagged }, 201);
});

// Only the administrator can finalise. Nothing counts as registered without their decision.
app.post('/referrals/:id/verify', requireAdmin, async (c) => {
  const user = c.get('user');
  const { data, error } = await db.from('referrals').update({ status: 'Verified', verified_at: today(), verified_by: user.id })
    .eq('id', c.req.param('id')).select('id, submitted_by, referred_name').single();
  if (error || !data) throw new HttpError(404, 'Not found.');
  await audit(user, 'Verified Referral', `ID: ${data.id}`);
  await notify({ recipient: data.submitted_by, title: `Referral verified: ${data.referred_name}`, message: 'Your referral was verified.', type: 'referral', actionUrl: 'referrals' });
  return c.json({ ok: true });
});

app.post('/referrals/:id/reject', requireAdmin, async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({ reason: str(500).min(1) }));
  const { data, error } = await db.from('referrals').update({ status: 'Rejected', rejection_reason: b.reason })
    .eq('id', c.req.param('id')).select('id, submitted_by, referred_name').single();
  if (error || !data) throw new HttpError(404, 'Not found.');
  await audit(user, 'Rejected Referral', `ID: ${data.id}`, b.reason);
  await notify({ recipient: data.submitted_by, title: `Referral rejected: ${data.referred_name}`, message: b.reason, type: 'referral', actionUrl: 'referrals' });
  return c.json({ ok: true });
});

// ---------------- activities ----------------
app.post('/activities', async (c) => {
  const user = c.get('user');
  const n = z.number().int().min(0).max(1e9).optional();
  const b = await parse(c, z.object({
    title: str(160).min(1), description: str(2000).default(''), category: str(60).min(1), supportingLink: url,
    evidenceNotes: str(2000).default(''), metrics: z.object({ impressions: n, participants: n, conversions: n }).default({}),
  }));
  const { data, error } = await db.from('activities').insert({
    title: b.title, description: b.description, category: b.category, supporting_link: b.supportingLink,
    evidence_notes: b.evidenceNotes, metrics: b.metrics, responsible_member: user.id,
  }).select().single();
  if (error) throw error;
  await audit(user, 'Logged Community Activity', b.title);
  return c.json({ id: data.id }, 201);
});

// ---------------- notifications ----------------
const scope = (q: any, c: any) => q.or(`recipient.eq.${c.get('user').id}${c.get('isAdmin') ? ',recipient.is.null' : ''}`);
app.post('/notifications/read-all', async (c) => {
  await scope(db.from('notifications').update({ read: true }), c);
  return c.json({ ok: true });
});
app.post('/notifications/:id/read', async (c) => {
  await scope(db.from('notifications').update({ read: true }).eq('id', c.req.param('id')), c);
  return c.json({ ok: true });
});

// ---------------- team ----------------
const ROLE = z.enum(['KOL', 'Contributor', 'Manager', 'Analyst']); // Super Administrator can never be granted via the API
const SEATS: Record<string, number> = { KOL: 1, Contributor: 2, Manager: 1, Analyst: 1 };

app.post('/team/invite', requireAdmin, async (c) => {
  const user = c.get('user');
  const b = await parse(c, z.object({
    name: str(120).min(1), email: z.string().email().max(200), role: ROLE, responsibilities: z.array(str(120)).max(20).default([]),
  }));
  const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', b.role);
  if ((count ?? 0) >= SEATS[b.role]) throw new HttpError(409, `All ${b.role} seats are already filled.`);
  const { data, error } = await db.auth.admin.inviteUserByEmail(b.email, { redirectTo: Deno.env.get('FRONTEND_ORIGIN'), data: { name: b.name } });
  if (error) throw new HttpError(400, error.message);
  const { error: pErr } = await db.from('profiles').insert({
    id: data.user.id, name: b.name, handle: `@${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    email: b.email.toLowerCase(), role: b.role, responsibilities: b.responsibilities,
    bio: `${b.role} on the KAIChain ecosystem operations team.`,
  });
  if (pErr) throw pErr;
  await audit(user, 'Invited Team Member', `${b.name} (${b.role})`);
  return c.json({ id: data.user.id }, 201);
});

app.patch('/team/:id', async (c) => {
  const user = c.get('user'), isAdmin = c.get('isAdmin');
  const id = c.req.param('id');
  if (id !== user.id && !isAdmin) throw new HttpError(403, 'Not permitted.');
  const b = await parse(c, z.object({
    name: str(120).min(1).optional(), bio: str(600).optional(), phone: str(40).optional(), telegram: str(80).optional(), xHandle: str(80).optional(),
    status: z.enum(['Active', 'Away', 'Suspended']).optional(), role: ROLE.optional(),
    assignedResponsibilities: z.array(str(120)).max(20).optional(),
  }));
  // Non-admins may only edit personal fields on their own profile.
  if (!isAdmin && (b.status || b.role || b.assignedResponsibilities)) throw new HttpError(403, 'Not permitted.');
  const { data: target } = await db.from('profiles').select('id, role').eq('id', id).single();
  if (!target) throw new HttpError(404, 'Not found.');
  if (target.role === ADMIN && (b.status === 'Suspended' || b.role)) throw new HttpError(400, 'The Super Administrator account is protected.');
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.bio !== undefined) patch.bio = b.bio;
  if (b.phone !== undefined) patch.phone = b.phone;
  if (b.telegram !== undefined) patch.telegram = b.telegram;
  if (b.xHandle !== undefined) patch.x_handle = b.xHandle;
  if (b.status) patch.status = b.status;
  if (b.role) patch.role = b.role;
  if (b.assignedResponsibilities) patch.responsibilities = b.assignedResponsibilities;
  const { error } = await db.from('profiles').update(patch).eq('id', target.id);
  if (error) throw error;
  await audit(user, 'Updated Member Details', `Member: ${target.id}`);
  return c.json({ ok: true });
});

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
app.post('/team/:id/photo', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (id !== user.id && !c.get('isAdmin')) throw new HttpError(403, 'Not permitted.');
  const b = await parse(c, z.object({ dataUrl: z.string().max(3_200_000) }));
  const mt = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl);
  if (!mt) throw new HttpError(400, 'Only JPG, PNG or WebP images are accepted.');
  const bin = atob(mt[2]);
  if (bin.length > 2 * 1024 * 1024) throw new HttpError(413, 'Image must be 2 MB or smaller.');
  const buf = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  // Check magic bytes so a renamed file can't masquerade as an image.
  const ascii = (a: number, z2: number) => String.fromCharCode(...buf.slice(a, z2));
  const ok = (mt[1] === 'image/png' && buf[0] === 0x89 && ascii(1, 4) === 'PNG')
    || (mt[1] === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8)
    || (mt[1] === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP');
  if (!ok) throw new HttpError(400, 'File content does not match its type.');
  const path = `${id}/${Date.now()}.${EXT[mt[1]]}`;
  const up = await db.storage.from('avatars').upload(path, buf, { contentType: mt[1], upsert: false });
  if (up.error) throw up.error;
  const { data } = db.storage.from('avatars').getPublicUrl(path);
  await db.from('profiles').update({ avatar_url: data.publicUrl }).eq('id', id);
  await audit(user, 'Updated Profile Photo', `Member: ${id}`);
  return c.json({ avatarUrl: data.publicUrl });
});

Deno.serve(app.fetch);
