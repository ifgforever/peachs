// Rome's Joy admin Worker: outgoing email (Resend) and the inquiry notification.
import { escapeHtml } from './http.js';
import { run, parseJson } from './db.js';
import { chicagoLong } from './time.js';

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Sends one email. Tries Resend (RESEND_API_KEY + EMAIL_FROM); without them nothing is sent.
 * Always resolves to { sent, reason } and never throws, so a mail outage never loses a submission.
 */
export async function sendEmail(env, { to, subject, text, html, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no_recipients' };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { sent: false, reason: `resend_${res.status}${detail ? `: ${detail}` : ''}` };
    }
    return { sent: true, reason: null };
  } catch (err) {
    return { sent: false, reason: `network: ${err?.message || err}` };
  }
}

const FORM_LABELS = { contact: 'contact', quote: 'quote request', event: 'event inquiry', wholesale: 'wholesale inquiry', apply: 'job application' };

/** Builds the staff notification for an inquiries row: every field, the business, Chicago time, admin link. */
export function inquiryEmail(env, business, inquiry) {
  const kind = FORM_LABELS[inquiry.form_type] || `${inquiry.form_type} form`;
  const who = inquiry.name || inquiry.email || 'someone';
  const subject = `${business.name}: new ${kind} from ${who}`;
  const when = chicagoLong(inquiry.created_at ? new Date(`${inquiry.created_at.replace(' ', 'T')}Z`) : new Date());
  const rows = [
    ['Business', business.name],
    ['Form', kind],
    ['Received', `${when} (Chicago)`],
    ['Name', inquiry.name],
    ['Email', inquiry.email],
    ['Phone', inquiry.phone],
  ];
  const extra = parseJson(inquiry.fields_json, {});
  for (const [key, value] of Object.entries(extra)) rows.push([key.replace(/[_-]+/g, ' '), value]);
  rows.push(['Message', inquiry.message]);
  if (inquiry.source_url) rows.push(['Sent from', inquiry.source_url]);
  const present = rows.filter(([, v]) => v != null && String(v).trim() !== '');
  const adminUrl = env.PUBLIC_BASE_URL ? `${String(env.PUBLIC_BASE_URL).replace(/\/+$/, '')}/admin/` : null;

  const text = [
    `New ${kind} for ${business.name} (inquiry #${inquiry.id})`,
    '',
    ...present.map(([k, v]) => `${k}: ${String(v)}`),
    '',
    adminUrl ? `Open the admin inbox: ${adminUrl}` : 'Log in to the admin to mark it handled.',
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#222;line-height:1.5">
    <h2 style="margin:0 0 12px">New ${escapeHtml(kind)} for ${escapeHtml(business.name)}</h2>
    <p style="margin:0 0 16px;color:#666">Inquiry #${inquiry.id}</p>
    <table cellpadding="6" style="border-collapse:collapse">
      ${present.map(([k, v]) => `<tr><th align="left" valign="top" style="text-transform:capitalize;white-space:nowrap;color:#666">${escapeHtml(k)}</th><td style="white-space:pre-wrap">${escapeHtml(v)}</td></tr>`).join('')}
    </table>
    <p style="margin-top:20px">${adminUrl ? `<a href="${escapeHtml(adminUrl)}">Open the admin inbox</a>` : 'Log in to the admin to mark it handled.'}</p>
  </body></html>`;

  return { subject, text, html, replyTo: inquiry.email || undefined };
}

/** Emails an inquiry to the business's inboxes and records the result on the row. */
export async function deliverInquiry(env, business, inquiry) {
  const to = String(business.inquiry_emails || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const result = to.length ? await sendEmail(env, { to, ...inquiryEmail(env, business, inquiry) }) : { sent: false, reason: 'no_recipients' };
  if (result.sent) {
    await run(env, "UPDATE inquiries SET emailed_at = datetime('now'), email_error = NULL WHERE id = ?", [inquiry.id]);
  } else {
    await run(env, 'UPDATE inquiries SET email_error = ? WHERE id = ?', [result.reason, inquiry.id]);
  }
  return result;
}
