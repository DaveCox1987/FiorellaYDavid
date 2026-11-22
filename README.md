# Fiorella & David wedding website

The website for the wedding on Monday 30 August 2027 at Coombe Lodge, Blagdon.

- **Guests** open a personal link (`/i/<code>`) sent by WhatsApp. They see the page for their household
  (Day or Evening, English or Spanish) and reply with the RSVP form at the bottom.
- **Dave and Fio** manage everything at `/admin`: the guest list, "Send on WhatsApp" buttons, replies,
  messages from guests, the spreadsheet for the caterer and venue, reminder emails and closing RSVPs.

## How it is built

| Part | What |
| --- | --- |
| `server.js` | The web server (Node, Express): guest pages, RSVP saving, admin API |
| `views/site.html` | The guest page: all wording in English and Spanish, styling and the RSVP form |
| `views/landing.html` | What people see without a personal link |
| `views/admin.html`, `public/admin/admin.js` | The admin page |
| `src/db.js` | Database tables (created automatically) and settings |
| `src/importer.js` | Guest list upload (CSV or Excel) |
| `src/exporter.js` | Excel export |
| `src/email.js` | Emails through Brevo |
| `public/img/` | Photos, the watercolour and the monogram |

Data lives in a Postgres database (Neon). The site runs on Render.

## Settings (environment variables)

| Name | Needed | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | Long random text that signs the admin login cookie |
| `SETUP_CODE` | for first login | One-time code each admin types when choosing a password |
| `BASE_URL` | recommended | The site's public address, e.g. `https://fiorellaydavidwedding.com` (used in links) |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` | for email | Turns on RSVP confirmation emails and reminders |
| `BREVO_SENDER_NAME` | no | Name emails come from (default "Fiorella & David") |

## Guest list file

One row per household, with these column headings:

`Guest names, Day or Evening, Language, WhatsApp, Email`

Separate the names in a household with `;`. Download a ready-made template from the Households tab.

## Run it on your own computer

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/wedding SETUP_CODE=choose-a-code node server.js
```

Then open http://localhost:3000/admin.

## Changing the wording

Almost all the guest-facing text is in `views/site.html`, in the block that starts `const T = {`:
`en:{…}` is English and `es:{…}` is Spanish.
