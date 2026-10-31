import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod@3';

export { z };
const env = (k: string) => Deno.env.get(k) ?? '';

// Service-role client: bypasses RLS, so it only ever runs here on the server.
export const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});
// Throwaway client per login so a user session never leaks into the service-role client.
export const anon = () => createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const ADMIN = 'Super Administrator';
const SEE_ALL = new Set([ADMIN, 'Manager', 'Analyst']);

export type Vars = { user: any; isAdmin: boolean; canSeeAll: boolean };

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export async function parse<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try { raw = await c.req.json(); } catch { /* empty body */ }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, 'Invalid input.', { details: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  return r.data;
}

export const str = (max = 500) => z.string().trim().max(max);
export const url = z.string().trim().url().max(500).optional().or(z.literal('').transform(() => undefined));
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const today = () => new Date().toISOString().slice(0, 10);

export async function requireAuth(c: any, next: () => Promise<void>) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Authentication required.');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Invalid or expired session.');
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).single();
  // An auth user with no profile row was never invited: no access.
  if (!profile) throw new HttpError(403, 'No team profile for this account.');
  if (profile.status === 'Suspended') throw new HttpError(403, 'This account is suspended.');
  c.set('user', profile);
  c.set('isAdmin', profile.role === ADMIN);
  c.set('canSeeAll', SEE_ALL.has(profile.role));
  await next();
}

export async function requireAdmin(c: any, next: () => Promise<void>) {
  if (!c.get('isAdmin')) throw new HttpError(403, 'Super Administrator only.');
  await next();
}
export const requireRoles = (...roles: string[]) => async (c: any, next: () => Promise<void>) => {
  if (!c.get('isAdmin') && !roles.includes(c.get('user').role)) throw new HttpError(403, 'Not permitted for your role.');
  await next();
};

export async function audit(user: any, action: string, target: string, details?: string) {
  await db.from('audit_logs').insert({ actor: user.id, actor_name: user.name, actor_role: user.role, action, target, details: details || null });
}
// recipient null => visible to the Super Administrator
export async function notify(n: { recipient?: string | null; title: string; message: string; type: string; priority?: string; actionUrl?: string }) {
  await db.from('notifications').insert({
    recipient: n.recipient ?? null, title: n.title, message: n.message, type: n.type,
    priority: n.priority ?? 'medium', action_url: n.actionUrl || null,
  });
}

// IPQualityScore: ADVISORY only. Flags a referral for the admin; never rejects anything.
async function ipqsGet(u: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(u, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.success !== false ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}
export async function checkReferralRisk({ email, ip }: { email?: string; ip?: string }) {
  const KEY = env('IPQS_API_KEY');
  if (!KEY) return { checked: false, reason: 'IPQS not configured' };
  const base = 'https://ipqualityscore.com/api/json';
  const out: any = { checked: true, flags: [] as string[] };
  const privateIp = !ip || /^(::1|::ffff:127\.|127\.|10\.|192\.168\.)/.test(ip);
  const [em, ipr] = await Promise.all([
    email ? ipqsGet(`${base}/email/${KEY}/${encodeURIComponent(email)}`) : null,
    privateIp ? null : ipqsGet(`${base}/ip/${KEY}/${encodeURIComponent(ip!)}?strictness=1`),
  ]);
  if (em) {
    out.email = { valid: em.valid, disposable: em.disposable, fraudScore: em.fraud_score, recentAbuse: em.recent_abuse };
    if (em.disposable) out.flags.push('Disposable email address');
    if (em.valid === false) out.flags.push('Email reported invalid');
    if (em.fraud_score >= 75) out.flags.push(`High email fraud score (${em.fraud_score})`);
  }
  if (ipr) {
    out.submitterIp = { fraudScore: ipr.fraud_score, proxy: ipr.proxy, vpn: ipr.vpn, tor: ipr.tor };
    if (ipr.fraud_score >= 85 || ipr.tor) out.flags.push('Submitting IP flagged as high risk');
  }
  if (!em && !ipr) return { checked: false, reason: 'IPQS lookup unavailable' };
  return out;
}

export const clientIp = (c: any) => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.req.header('cf-connecting-ip') || '';
