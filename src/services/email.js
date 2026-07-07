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

const FROM = process.env.SMTP_FROM || 'Quor <noreply@vocallm.com>'
const BASE = process.env.FRONTEND_ADMIN_URL || 'http://localhost:8080'
const CLIENT_BASE = process.env.FRONTEND_CLIENT_URL || BASE

async function sendPasswordReset(toEmail, resetToken) {
  const resetUrl = `${BASE}/admin/reset-password?token=${resetToken}`
  const subject  = 'Reset your Quor admin password'
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:700;color:#1a2b4a">Quor Admin</span>
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
  const text = `Reset your Quor admin password\n\nLink: ${resetUrl}\n\nExpires in 1 hour.`

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

async function sendTenantPasswordReset(toEmail, resetToken) {
  const resetUrl = `${CLIENT_BASE}/reset-password?token=${resetToken}`
  const subject  = 'Reset your Quor password'
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:700;color:#1a2b4a">Quor</span>
      </div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 12px;color:#111">Reset your password</h2>
      <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 24px">
        We received a request to reset the password for your Quor account (<strong>${toEmail}</strong>).
        Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.
      </p>
      <a href="${resetUrl}"
         style="display:inline-block;background:#1a2b4a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px">
        Reset password
      </a>
      <p style="font-size:12px;color:#999;margin-top:24px;line-height:1.5">
        If you didn't request this, you can safely ignore this email.<br/>
        Or copy this link: ${resetUrl}
      </p>
    </div>
  `
  const text = `Reset your Quor password\n\nLink: ${resetUrl}\n\nExpires in 1 hour.`

  if (!USE_SMTP) {
    console.log('\n========== TENANT PASSWORD RESET EMAIL (dev mode) ==========')
    console.log(`To:      ${toEmail}`)
    console.log(`Subject: ${subject}`)
    console.log(`Link:    ${resetUrl}`)
    console.log('=============================================================\n')
    return
  }

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, text })
  console.log(`[email] Tenant password reset sent to ${toEmail}`)
}

async function sendWelcomeEmail(toEmail, name, companyName) {
  const loginUrl = `${CLIENT_BASE}/login`
  const subject  = `Welcome to Quor, ${name}!`
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:700;color:#1a2b4a">Quor</span>
      </div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 12px;color:#111">Welcome aboard, ${name}!</h2>
      <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 16px">
        Your Quor account for <strong>${companyName}</strong> is ready. You can now sign in to your portal, set up your AI calling agent, and start booking meetings on autopilot.
      </p>
      <a href="${loginUrl}"
         style="display:inline-block;background:#1a2b4a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px">
        Go to your portal
      </a>
      <div style="margin-top:28px;padding-top:20px;border-top:1px solid #eee">
        <p style="font-size:13px;font-weight:600;color:#333;margin:0 0 10px">Quick start guide:</p>
        <ol style="font-size:13px;color:#555;line-height:1.8;padding-left:18px;margin:0">
          <li>Choose a plan that fits your call volume</li>
          <li>Create your first AI script</li>
          <li>Upload your leads and launch a campaign</li>
        </ol>
      </div>
      <p style="font-size:12px;color:#999;margin-top:24px">
        Need help? Reply to this email and we'll get back to you.
      </p>
    </div>
  `
  const text = `Welcome to Quor, ${name}!\n\nYour account for ${companyName} is ready.\n\nSign in: ${loginUrl}`

  if (!USE_SMTP) {
    console.log('\n========== WELCOME EMAIL (dev mode) ==========')
    console.log(`To:      ${toEmail}`)
    console.log(`Subject: ${subject}`)
    console.log('================================================\n')
    return
  }

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, text })
  console.log(`[email] Welcome email sent to ${toEmail}`)
}

async function sendClientWelcome(toEmail, name, companyName, password) {
  const loginUrl = `${CLIENT_BASE}/login`
  const subject  = `Your Quor account is ready — ${companyName}`
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:24px">
        <span style="font-size:20px;font-weight:700;color:#1a2b4a">Quor</span>
      </div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 12px;color:#111">Welcome, ${name}!</h2>
      <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 20px">
        Your Quor portal for <strong>${companyName}</strong> has been set up. Here are your login credentials:
      </p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:13px;color:#555;margin-bottom:6px"><span style="font-weight:600;color:#333">Email:</span> ${toEmail}</div>
        <div style="font-size:13px;color:#555"><span style="font-weight:600;color:#333">Password:</span> ${password}</div>
      </div>
      <a href="${loginUrl}"
         style="display:inline-block;background:#1a2b4a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px">
        Sign in to your portal
      </a>
      <p style="font-size:12px;color:#999;margin-top:24px;line-height:1.5">
        We recommend changing your password after your first login.<br/>
        Portal URL: <a href="${loginUrl}" style="color:#1a2b4a">${loginUrl}</a>
      </p>
    </div>
  `
  const text = `Welcome to Quor, ${name}!\n\nCompany: ${companyName}\nEmail: ${toEmail}\nPassword: ${password}\n\nSign in: ${loginUrl}\n\nPlease change your password after first login.`

  if (!USE_SMTP) {
    console.log('\n========== CLIENT WELCOME EMAIL (dev mode) ==========')
    console.log(`To:       ${toEmail}`)
    console.log(`Subject:  ${subject}`)
    console.log(`Email:    ${toEmail}`)
    console.log(`Password: ${password}`)
    console.log('=====================================================\n')
    return
  }

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, text })
  console.log(`[email] Client welcome sent to ${toEmail}`)
}

async function sendContactInquiry({ firstName, lastName, email, company, phone, callVolume, message }) {
  const to      = process.env.SMTP_USER
  const subject = `New demo request — ${firstName} ${lastName} · ${company}`
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fff">
      <div style="margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #1a2b4a">
        <span style="font-size:20px;font-weight:700;color:#1a2b4a">Quor</span>
        <span style="font-size:14px;color:#888;margin-left:8px">· New Demo Request</span>
      </div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 20px;color:#111">
        ${firstName} ${lastName} from <em>${company}</em> wants a demo
      </h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#888;width:36%;font-weight:500">Name</td>
          <td style="padding:10px 0;color:#111">${firstName} ${lastName}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#888;font-weight:500">Email</td>
          <td style="padding:10px 0"><a href="mailto:${email}" style="color:#1a2b4a">${email}</a></td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#888;font-weight:500">Company</td>
          <td style="padding:10px 0;color:#111">${company}</td>
        </tr>
        ${phone ? `<tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#888;font-weight:500">Phone</td>
          <td style="padding:10px 0;color:#111">${phone}</td>
        </tr>` : ''}
        ${callVolume ? `<tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#888;font-weight:500">Monthly calls</td>
          <td style="padding:10px 0;color:#111">${callVolume}</td>
        </tr>` : ''}
      </table>
      ${message ? `
      <div style="margin-top:20px;padding:16px;background:#f8f9fb;border-radius:8px;border-left:3px solid #1a2b4a">
        <div style="font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Message</div>
        <p style="font-size:14px;color:#333;line-height:1.7;margin:0">${message.replace(/\n/g, '<br/>')}</p>
      </div>` : ''}
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee">
        <a href="mailto:${email}?subject=Re: Your Quor demo request"
           style="display:inline-block;background:#1a2b4a;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 24px;border-radius:8px">
          Reply to ${firstName}
        </a>
      </div>
      <p style="font-size:12px;color:#bbb;margin-top:20px">Submitted via Quor contact form</p>
    </div>
  `
  const text = [
    `New demo request from ${firstName} ${lastName} (${company})`,
    `Email: ${email}`,
    phone       ? `Phone: ${phone}` : '',
    callVolume  ? `Monthly calls: ${callVolume}` : '',
    message     ? `\nMessage:\n${message}` : '',
  ].filter(Boolean).join('\n')

  if (!USE_SMTP) {
    console.log('\n========== CONTACT INQUIRY (dev mode — no SMTP configured) ==========')
    console.log(`From:    ${firstName} ${lastName} <${email}>`)
    console.log(`Company: ${company}`)
    if (phone)      console.log(`Phone:   ${phone}`)
    if (callVolume) console.log(`Volume:  ${callVolume}`)
    if (message)    console.log(`Message:\n${message}`)
    console.log('=====================================================================\n')
    return
  }

  await transporter.sendMail({ from: FROM, to, replyTo: email, subject, html, text })
  console.log(`[email] Contact inquiry from ${email} forwarded to ${to}`)
}

module.exports = { sendPasswordReset, sendTenantPasswordReset, sendWelcomeEmail, sendClientWelcome, sendContactInquiry }
