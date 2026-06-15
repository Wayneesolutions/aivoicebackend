// backend/src/services/email.js
// Sends transactional emails. Requires SMTP_HOST/SMTP_USER/SMTP_PASS in .env.
// In development without SMTP config, logs the email to console instead.
const nodemailer = require('nodemailer')

const USE_SMTP = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
)

const transporter = USE_SMTP
  ? nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null

const FROM = process.env.SMTP_FROM || 'VoCallM <noreply@vocallm.com>'
const BASE = process.env.FRONTEND_ADMIN_URL || 'http://localhost:8080'

async function sendPasswordReset(toEmail, resetToken) {
  const resetUrl = `${BASE}/admin/reset-password?token=${resetToken}`
  const subject  = 'Reset your VoCallM admin password'
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:700;color:#1a2b4a">VoCallM Admin</span>
      </div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 12px;color:#111">Reset your password</h2>
      <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 24px">
        We received a request to reset the password for your admin account (<strong>${toEmail}</strong>).
        Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.
      </p>
      <a href="${resetUrl}"
         style="display:inline-block;background:#1a2b4a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px">
        Reset password
      </a>
      <p style="font-size:12px;color:#999;margin-top:24px;line-height:1.5">
        If you didn't request this, you can safely ignore this email. Your password won't change.<br/>
        Or copy this link: ${resetUrl}
      </p>
    </div>
  `
  const text = `Reset your VoCallM admin password\n\nLink: ${resetUrl}\n\nExpires in 1 hour.`

  if (!USE_SMTP) {
    console.log('\n========== PASSWORD RESET EMAIL (dev mode — no SMTP configured) ==========')
    console.log(`To:      ${toEmail}`)
    console.log(`Subject: ${subject}`)
    console.log(`Link:    ${resetUrl}`)
    console.log('==========================================================================\n')
    return
  }

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, text })
  console.log(`[email] Password reset sent to ${toEmail}`)
}

module.exports = { sendPasswordReset }
