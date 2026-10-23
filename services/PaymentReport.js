import CourseStudent, { LEVELS } from '../models/CourseStudent.js';
import CourseSetting from '../models/CourseSetting.js';
import User from '../models/User.js';
import { sendMail } from './EmailService.js';
import { paymentStatus, paidAhead, monthOf, dayOf } from './ParentPortal.js';

/**
 * The daily payment email (Jamshid, 2026-10-23): a copy of who has paid and
 * who hasn't, in his inbox, so he can see it even when the website is down.
 *
 * Sent once a day, in the evening (Tashkent time), and only on days when a
 * payment was added or marked as a mistake. Grouped by level (A1, A2, …):
 * each student, this month's status, how much was paid and on which date,
 * and months paid in advance. "Email report now" in the admin panel sends it
 * at any time.
 */

export const REPORT_HOUR = 20;   // after 20:00 Tashkent time

const UZ_MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
const monthName = ym => { const [y, m] = ym.split('-').map(Number); return `${UZ_MONTHS[m - 1]} ${y}`; };
const money = n => `${Math.round(n || 0).toLocaleString('en-US').replace(/,/g, ' ')} so‘m`;
const date = d => { const s = dayOf(d); return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`; };
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STATUS = {
  paid: ['To‘langan', '#15803d'], partial: ['Qisman', '#b45309'], due: ['To‘lanmagan (10-gacha)', '#b45309'],
  overdue: ['To‘lanmagan', '#b91c1c'], advance: ['Oldindan to‘langan', '#15803d'], upcoming: ['—', '#64748b']
};

/** Payments added or marked as a mistake since a moment. */
export function changesSince(students, since) {
  const t = since ? new Date(since).getTime() : 0;
  const out = [];
  for (const s of students) {
    for (const p of s.payments || []) {
      if (new Date(p.createdAt || p.paidAt).getTime() > t) out.push({ kind: 'added', student: s, p });
      if (p.voidedAt && new Date(p.voidedAt).getTime() > t) out.push({ kind: 'voided', student: s, p });
    }
  }
  return out;
}

/** The report itself: { subject, html, text, counts }. */
export function buildReport(students, { month = monthOf(), now = Date.now(), changes = [] } = {}) {
  const groups = LEVELS.map(level => ({ level, list: students.filter(s => s.level === level).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter(g => g.list.length);
  let paidCount = 0; let notPaid = 0; let total = 0;
  const textLines = [];
  const htmlGroups = groups.map(g => {
    textLines.push('', `== ${g.level} (${g.list.length}) ==`);
    const rows = g.list.map(s => {
      const p = paymentStatus(s, month, now);
      const ahead = paidAhead(s, now);
      total += p.paid;
      if (p.status === 'paid') paidCount += 1; else notPaid += 1;
      const [label, color] = STATUS[p.status] || STATUS.due;
      const dates = p.payments.map(x => `${money(x.amount)} · ${date(x.paidAt)}`).join('<br>');
      const aheadText = ahead.map(a => `${UZ_MONTHS[Number(a.month.slice(5)) - 1]}${a.status === 'partial' ? ' (qisman)' : ''}`).join(', ');
      textLines.push(`${s.name}: ${label}${p.paid ? ` — ${money(p.paid)}${p.fee ? ` / ${money(p.fee)}` : ''}` : ''}${p.payments.length ? ` (${p.payments.map(x => date(x.paidAt)).join(', ')})` : ''}${aheadText ? ` · oldindan: ${aheadText}` : ''}`);
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(s.name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:${color};font-weight:700">${label}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap">${p.paid ? money(p.paid) : '—'}${p.fee ? `<br><small style="color:#64748b">/ ${money(p.fee)}</small>` : ''}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${dates || '—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(aheadText) || '—'}</td>
      </tr>`;
    }).join('');
    return `<h3 style="margin:22px 0 6px;font-size:16px">${g.level} — ${g.list.length} o‘quvchi</h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr style="background:#f1f5f9;text-align:left"><th style="padding:6px 8px">O‘quvchi</th><th style="padding:6px 8px">${UZ_MONTHS[Number(month.slice(5)) - 1]}</th><th style="padding:6px 8px;text-align:right">To‘langan</th><th style="padding:6px 8px">Sana</th><th style="padding:6px 8px">Oldindan</th></tr>
        ${rows}
      </table>`;
  }).join('');

  const changeLines = changes.map(c => c.kind === 'added'
    ? `+ ${c.student.name} (${c.student.level}): ${money(c.p.amount)} — ${monthName(c.p.month)}, ${date(c.p.paidAt)}`
    : `✗ ${c.student.name} (${c.student.level}): ${money(c.p.amount)} — ${monthName(c.p.month)} xato deb belgilandi${c.p.voidReason ? ` (${c.p.voidReason})` : ''}`);

  const subject = `To‘lovlar — ${monthName(month)}: ${paidCount} to‘lagan, ${notPaid} to‘lamagan`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:760px">
    <h2 style="margin:0 0 4px">To‘lovlar hisoboti — ${monthName(month)}</h2>
    <p style="margin:0;color:#475569">${date(now)} holatiga · ${paidCount} to‘lagan · ${notPaid} to‘lamagan · jami ${money(total)}</p>
    ${changeLines.length ? `<h3 style="margin:18px 0 6px;font-size:15px">Bugungi o‘zgarishlar</h3><ul style="margin:0;padding-left:18px">${changeLines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${htmlGroups || '<p>O‘quvchilar yo‘q.</p>'}
    <p style="margin-top:20px;color:#64748b;font-size:12px">English Hub · bu xat sayt ishlamay qolsa ham to‘lovlarni ko‘rishingiz uchun yuboriladi.</p>
  </div>`;
  const text = [`To‘lovlar hisoboti — ${monthName(month)} (${date(now)})`, `${paidCount} to‘lagan, ${notPaid} to‘lamagan, jami ${money(total)}`,
    ...(changeLines.length ? ['', 'Bugungi o‘zgarishlar:', ...changeLines] : []), ...textLines].join('\n');
  return { subject, html, text, counts: { paid: paidCount, notPaid, total, changes: changes.length } };
}

/** Who gets the email: PAYMENT_REPORT_TO (comma-separated), or every admin account. */
export async function reportRecipients() {
  const env = String(process.env.PAYMENT_REPORT_TO || '').split(',').map(x => x.trim()).filter(Boolean);
  if (env.length) return env;
  const admins = await User.find({ role: 'admin', status: { $ne: 'suspended' } }).select('email').lean();
  return [...new Set(admins.map(a => a.email).filter(Boolean))];
}

/**
 * Send the report. `force` sends even without changes (the admin button);
 * otherwise only when something changed since the last report.
 */
export async function sendPaymentReport({ force = false, now = Date.now() } = {}) {
  const setting = await CourseSetting.findOne({ key: 'course' }).lean();
  const since = setting?.paymentReportAt || null;
  const students = await CourseStudent.find({ removedAt: null }).select('name level monthlyFee payments createdAt').lean();
  const changes = changesSince(students, since);
  if (!force && !changes.length) return { sent: false, reason: 'no payment changes since the last report' };
  const to = await reportRecipients();
  if (!to.length) return { sent: false, reason: 'no admin email to send to' };
  const report = buildReport(students, { now, changes });
  const results = [];
  for (const address of to) results.push(await sendMail({ to: address, subject: report.subject, html: report.html, text: report.text }));
  const sent = results.some(r => r?.sent !== false);
  if (sent) await CourseSetting.updateOne({ key: 'course' }, { $set: { paymentReportAt: new Date(now) } }, { upsert: true });
  return { sent, to, counts: report.counts, reason: sent ? '' : results.map(r => r?.reason).filter(Boolean).join('; ') };
}

/** Once an hour: after REPORT_HOUR Tashkent time, send today's report if there were changes. */
export function startPaymentReports() {
  const tick = async () => {
    try {
      const hour = Number(new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(11, 13));
      if (hour < REPORT_HOUR) return;
      const setting = await CourseSetting.findOne({ key: 'course' }).lean();
      if (setting?.paymentReportAutoDay === dayOf()) return;   // the evening email already went today
      const r = await sendPaymentReport();
      if (r.sent) await CourseSetting.updateOne({ key: 'course' }, { $set: { paymentReportAutoDay: dayOf() } });
      if (r.sent) console.log(`Payment report emailed to ${r.to.length} admin(s): ${r.counts.changes} change(s)`);
    } catch (error) {
      console.error('Payment report failed:', error.message);
    }
  };
  setTimeout(tick, 3 * 60 * 1000);
  return setInterval(tick, 60 * 60 * 1000);
}

export default { sendPaymentReport, startPaymentReports, buildReport, changesSince };
