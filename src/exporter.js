// Builds the Excel export for the caterer and the venue.
const ExcelJS = require('exceljs');

const MEAL = { meat: 'Meat', veg: 'Vegetarian', vegan: 'Vegan' };
const fmt = (d) => (d ? new Date(d) : null);

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4A32' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function buildWorkbook(households, baseUrl) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fiorella & David wedding website';
  wb.created = new Date();

  const guests = [];
  for (const h of households) for (const g of h.guests) guests.push({ h, g });
  const attending = guests.filter((x) => x.g.attending === true);
  const day = (x) => x.h.type === 'day';

  // Numbers for the venue
  const nums = wb.addWorksheet('Numbers');
  nums.columns = [{ header: '', key: 'a', width: 44 }, { header: 'Day guests', key: 'd', width: 14 }, { header: 'Evening guests', key: 'e', width: 16 }, { header: 'Total', key: 't', width: 12 }];
  const count = (f) => [guests.filter((x) => day(x) && f(x)).length, guests.filter((x) => !day(x) && f(x)).length];
  const line = (label, f) => {
    const [d, e] = count(f);
    nums.addRow({ a: label, d, e, t: d + e });
  };
  line('Invited', () => true);
  line('Attending', (x) => x.g.attending === true);
  line('Declined', (x) => x.g.attending === false);
  line('Not replied yet', (x) => x.g.attending === null);
  nums.addRow({});
  const dayAtt = attending.filter(day).length;
  nums.addRow({ a: 'At the ceremony and wedding breakfast (day guests attending)', t: dayAtt });
  nums.addRow({ a: 'At the evening party (day + evening guests attending)', t: attending.length });
  styleHeader(nums);

  // Catering
  const cat = wb.addWorksheet('Catering');
  cat.columns = [{ header: 'Meal', key: 'a', width: 34 }, { header: 'Count', key: 'b', width: 10 }, { header: '', key: 'c', width: 60 }];
  for (const m of ['meat', 'veg', 'vegan']) cat.addRow({ a: MEAL[m], b: attending.filter((x) => day(x) && x.g.meal === m).length });
  cat.addRow({ a: 'Total meals', b: dayAtt });
  cat.addRow({});
  const dh = cat.addRow({ a: 'Dietary requirements and allergies', b: '', c: '' });
  dh.font = { bold: true };
  cat.addRow({ a: 'Guest', b: 'Meal', c: 'Requirement' }).font = { bold: true };
  for (const x of attending.filter((x) => x.g.diet)) cat.addRow({ a: x.g.name, b: x.g.meal ? MEAL[x.g.meal] : (day(x) ? '' : 'Evening only'), c: x.g.diet });
  styleHeader(cat);

  // Every guest
  const gs = wb.addWorksheet('Guests');
  gs.columns = [
    { header: 'Guest', key: 'name', width: 28 },
    { header: 'Household', key: 'hh', width: 36 },
    { header: 'Day or Evening', key: 'type', width: 16 },
    { header: 'Reply', key: 'reply', width: 14 },
    { header: 'Meal', key: 'meal', width: 14 },
    { header: 'Dietary requirements', key: 'diet', width: 44 },
    { header: 'Replied on', key: 'at', width: 20 },
  ];
  for (const { h, g } of guests) {
    gs.addRow({
      name: g.name,
      hh: h.guests.map((x) => x.name).join(', '),
      type: h.type === 'day' ? 'Day' : 'Evening',
      reply: g.attending === true ? 'Attending' : g.attending === false ? 'Declined' : 'No reply',
      meal: g.meal ? MEAL[g.meal] : '',
      diet: g.diet,
      at: g.attending === null ? null : fmt(h.responded_at),
    });
  }
  gs.getColumn('at').numFmt = 'dd mmm yyyy hh:mm';
  styleHeader(gs);

  // Households, links and messages
  const hs = wb.addWorksheet('Households');
  hs.columns = [
    { header: 'Household', key: 'hh', width: 36 },
    { header: 'Day or Evening', key: 'type', width: 16 },
    { header: 'Language', key: 'lang', width: 12 },
    { header: 'WhatsApp', key: 'wa', width: 20 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Personal link', key: 'link', width: 48 },
    { header: 'Invite sent', key: 'sent', width: 20 },
    { header: 'Opened', key: 'opened', width: 20 },
    { header: 'Replied', key: 'replied', width: 20 },
    { header: 'Message', key: 'msg', width: 60 },
  ];
  for (const h of households) {
    hs.addRow({
      hh: h.guests.map((x) => x.name).join(', '),
      type: h.type === 'day' ? 'Day' : 'Evening',
      lang: h.lang === 'es' ? 'Spanish' : 'English',
      wa: h.whatsapp,
      email: h.email,
      link: `${baseUrl}/i/${h.token}`,
      sent: fmt(h.sent_at),
      opened: fmt(h.opened_at),
      replied: fmt(h.responded_at),
      msg: h.message,
    });
  }
  for (const k of ['sent', 'opened', 'replied']) hs.getColumn(k).numFmt = 'dd mmm yyyy hh:mm';
  hs.getColumn('msg').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(hs);

  return wb;
}

module.exports = { buildWorkbook };
