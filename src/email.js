// Email through Brevo's transactional API. Does nothing unless BREVO_API_KEY and BREVO_SENDER_EMAIL are set.
const API = 'https://api.brevo.com/v3/smtp/email';

function configured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

async function send({ to, toName, subject, html, text }) {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Fiorella & David' },
        to: [{ email: to, name: toName || undefined }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
    if (!r.ok) {
      console.error('Brevo error', r.status, await r.text().catch(() => ''));
      return { ok: false, reason: 'brevo_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('Brevo request failed', e.message);
    return { ok: false, reason: 'network' };
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function wrap(bodyHtml) {
  return `<div style="background:#EAE5D7;padding:28px 12px;font-family:Georgia,'Times New Roman',serif;color:#2F4A32">
  <div style="max-width:520px;margin:0 auto;background:#F4F0E6;border:1px solid #CFC6B1;border-radius:8px;padding:28px 26px;font-size:17px;line-height:1.55">
  <p style="margin:0 0 4px;font-size:26px;color:#9E2149;font-style:italic;text-align:center">Fiorella y David</p>
  <p style="margin:0 0 22px;text-align:center;letter-spacing:.18em;font-size:12px;text-transform:uppercase">30 · 08 · 2027 · Coombe Lodge</p>
  ${bodyHtml}
  </div></div>`;
}

const MEAL = { en: { meat: 'Meat', veg: 'Vegetarian', vegan: 'Vegan' }, es: { meat: 'Carne', veg: 'Vegetariano', vegan: 'Vegano' } };

function confirmation({ lang, type, guests, message, link }) {
  const es = lang === 'es';
  const rows = guests.map((g) => {
    const bits = [g.attending ? (es ? 'Asistirá' : 'Attending') : (es ? 'No podrá asistir' : 'Not attending')];
    if (g.attending && type === 'day' && g.meal) bits.push(MEAL[lang][g.meal]);
    if (g.attending && g.diet) bits.push(g.diet);
    return { name: g.name, detail: bits.join(' · ') };
  });
  const intro = es ? 'Gracias por su respuesta. Esto es lo que hemos recibido:' : "Thank you for your reply. Here's what we've received:";
  const change = es
    ? 'Pueden cambiar su respuesta en cualquier momento antes del 31 de mayo de 2027 con su enlace personal:'
    : 'You can change your reply any time before 31 May 2027 using your personal link:';
  const msgLabel = es ? 'Su mensaje' : 'Your message';
  const html = wrap(
    `<p>${intro}</p><ul style="padding-left:20px">${rows.map((r) => `<li><b>${esc(r.name)}</b>: ${esc(r.detail)}</li>`).join('')}</ul>` +
      (message ? `<p><b>${msgLabel}:</b><br>${esc(message).replace(/\n/g, '<br>')}</p>` : '') +
      `<p>${change}<br><a href="${esc(link)}" style="color:#9E2149">${esc(link)}</a></p>`
  );
  const text = `${intro}\n\n${rows.map((r) => `- ${r.name}: ${r.detail}`).join('\n')}\n\n${message ? `${msgLabel}: ${message}\n\n` : ''}${change}\n${link}\n`;
  return { subject: es ? 'Hemos recibido su respuesta · Fiorella y David' : "We've got your RSVP · Fiorella & David", html, text };
}

function reminder({ lang, names, link, deadlineText }) {
  const es = lang === 'es';
  const hello = es ? `Hola ${names}:` : `Hi ${names},`;
  const body = es
    ? `Todavía no hemos recibido su respuesta a nuestra invitación de boda. Por favor, confirmen antes del ${deadlineText} con su enlace personal:`
    : `We haven't had your reply to our wedding invitation yet. Please RSVP by ${deadlineText} using your personal link:`;
  const bye = es ? '¡Tenemos muchas ganas de celebrar con ustedes!' : "We can't wait to celebrate with you!";
  const html = wrap(`<p>${esc(hello)}</p><p>${esc(body)}<br><a href="${esc(link)}" style="color:#9E2149">${esc(link)}</a></p><p>${bye}<br>Fiorella ${es ? 'y' : '&amp;'} David</p>`);
  const text = `${hello}\n\n${body}\n${link}\n\n${bye}\nFiorella ${es ? 'y' : '&'} David\n`;
  return { subject: es ? 'Recordatorio: confirmen su asistencia · Fiorella y David' : 'A reminder to RSVP · Fiorella & David', html, text };
}

module.exports = { configured, send, confirmation, reminder };
