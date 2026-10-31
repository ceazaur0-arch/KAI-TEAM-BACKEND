// @ts-nocheck
// Convert DB rows to the exact shapes the React frontend (src/types) expects.
const d = (v) => (v ? String(v).slice(0, 10) : undefined);
const ts = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '');

export const toMember = (p, stats = {}) => ({
  id: p.id, name: p.name, handle: p.handle, role: p.role, email: p.email,
  avatarUrl: p.avatar_url || '', joinDate: d(p.created_at), status: p.status,
  assignedResponsibilities: p.responsibilities || [],
  completedTasksCount: stats.completed || 0, pendingTasksCount: stats.pending || 0,
  totalSignups: stats.signups || 0, totalReferrals: stats.referrals || 0,
  bio: p.bio || '', phone: p.phone || undefined, telegram: p.telegram || undefined, xHandle: p.x_handle || undefined,
});

export const toPartnership = (r, names) => ({
  id: r.id, applicantName: r.applicant_name, organization: r.organization, category: r.category,
  email: r.email, avatarUrl: r.avatar_url || undefined, logoUrl: r.logo_url || undefined,
  description: r.description, socialLinks: r.social_links || {},
  submittedByMemberId: r.submitted_by, submittedByMemberName: names[r.submitted_by] || 'Unknown',
  submissionDate: d(r.created_at), status: r.status, priority: r.priority,
  expectedTvlOrUsers: r.expected_tvl_or_users || undefined,
  internalNotes: r.internal_notes || [], followUpActions: r.follow_up_actions || [],
  reviewHistory: r.review_history || [],
});

export const toSignup = (r, names) => ({
  id: r.id, applicantName: r.applicant_name, email: r.email, organization: r.organization,
  category: r.category, submittedByMemberId: r.submitted_by,
  submittedByMemberName: names[r.submitted_by] || 'Unknown', submissionDate: d(r.created_at),
  status: r.status, evidenceUrl: r.evidence_url || undefined, evidenceNotes: r.evidence_notes,
  reviewerId: r.reviewer_id || undefined, reviewerName: r.reviewer_id ? names[r.reviewer_id] : undefined,
  reviewDate: d(r.review_date), reviewNotes: r.review_notes || undefined,
  contactTelegram: r.contact_telegram || undefined, estimatedReach: r.estimated_reach || undefined,
});

export const toTask = (r, names) => ({
  id: r.id, title: r.title, description: r.description,
  assignedToMemberId: r.assigned_to, assignedToMemberName: names[r.assigned_to] || 'Unknown',
  createdByMemberId: r.created_by, createdByMemberName: names[r.created_by] || 'Unknown',
  priority: r.priority, status: r.status, dueDate: d(r.due_date), createdAt: d(r.created_at),
  category: r.category, submissionEvidence: r.submission || undefined,
  adminFeedback: r.admin_feedback || undefined,
});

export const toReferral = (r, names, isAdmin = false) => ({
  id: r.id, referredName: r.referred_name, gmailAddress: r.gmail_address,
  referralDate: d(r.created_at), referralSource: r.referral_source,
  submittedByMemberId: r.submitted_by, submittedByMemberName: names[r.submitted_by] || 'Unknown',
  supportingEvidence: r.supporting_evidence, evidenceUrl: r.evidence_url || undefined,
  internalNotes: r.internal_notes, status: r.status, verifiedAt: d(r.verified_at),
  verifiedBy: r.verified_by ? names[r.verified_by] : undefined,
  rejectionReason: r.rejection_reason || undefined,
  // Risk flags are advisory and only visible to the administrator.
  riskFlags: isAdmin ? r.risk_flags || undefined : undefined,
});

export const toActivity = (r, names) => ({
  id: r.id, title: r.title, description: r.description, category: r.category,
  responsibleMemberId: r.responsible_member, responsibleMemberName: names[r.responsible_member] || 'Unknown',
  date: d(r.created_at), supportingLink: r.supporting_link || undefined,
  evidenceNotes: r.evidence_notes, metrics: r.metrics || {}, status: r.status,
});

export const toNotification = (r) => ({
  id: r.id, title: r.title, message: r.message, type: r.type, priority: r.priority,
  timestamp: ts(r.created_at), read: r.read, actionUrl: r.action_url || undefined,
});

export const toAudit = (r) => ({
  id: r.id, actorName: r.actor_name, actorRole: r.actor_role, action: r.action,
  target: r.target, timestamp: ts(r.created_at), details: r.details || undefined,
});
