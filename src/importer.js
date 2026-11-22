// Reads a guest list from a CSV or Excel file: one row per household.
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');

const TEMPLATE_CSV = [
  'Guest names,Day or Evening,Language,WhatsApp,Email',
  'Ana Torres; Tom Baker,Day,English,+44 7700 900123,ana@example.com',
  'Carmen Rojas; Luis Rojas,Day,Spanish,+51 999 888 777,carmen@example.com',
  'Jess Lee,Evening,English,07700 900456,',
  '',
].join('\r\n');

const norm = (s) => String(s == null ? '' : s).trim();
const key = (s) => norm(s).toLowerCase().replace(/[^a-z]/g, '');

function columnFor(header) {
  const k = key(header);
  if (/^(guestnames?|names?|guests?|household|invitados|nombres?)$/.test(k)) return 'names';
  if (/^(dayorevening|type|invite|invitation|dayevening|tipo)$/.test(k)) return 'type';
  if (/^(language|lang|preferredlanguage|idioma)$/.test(k)) return 'lang';
  if (/^(whatsapp|whatsappnumber|phone|mobile|telefono|celular)$/.test(k)) return 'whatsapp';
  if (/^(email|emailaddress|correo)$/.test(k)) return 'email';
  return null;
}

function splitNames(s) {
  return norm(s)
    .split(/\s*(?:;|,|&|\band\b|\sy\s|\se\s)\s*/i)
    .map((n) => n.trim().slice(0, 80))
    .filter(Boolean);
}

function parseType(s) {
  const k = key(s);
  if (/^(day|d|dia|allday|fullday)/.test(k)) return 'day';
  if (/^(eve|evening|e|night|noche|tarde)/.test(k)) return 'eve';
  return null;
}

function parseLang(s) {
  const k = key(s);
  if (/^(es|spa|esp|castellano)/.test(k)) return 'es';
  if (/^(en|eng|ing)/.test(k) || k === '') return 'en';
  return null;
}

async function toMatrix(buffer, filename) {
  if (/\.xlsx$/i.test(filename) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('The workbook has no sheets.');
    const out = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const v = row.getCell(c).value;
        let text = '';
        if (v == null) text = '';
        else if (typeof v === 'object' && v.text) text = v.text;
        else if (typeof v === 'object' && v.richText) text = v.richText.map((t) => t.text).join('');
        else if (typeof v === 'object' && v.result != null) text = String(v.result);
        else text = String(v);
        cells.push(text);
      }
      out.push({ n: row.number, cells });
    });
    return out;
  }
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: false });
  return rows.map((cells, i) => ({ n: i + 1, cells })).filter((r) => r.cells.some((c) => norm(c)));
}

async function parseGuestFile(buffer, filename) {
  const matrix = await toMatrix(buffer, filename);
  if (!matrix.length) throw new Error('The file is empty.');
  const header = matrix[0].cells.map(columnFor);
  if (!header.includes('names') || !header.includes('type')) {
    throw new Error('The first row must have the column headings "Guest names" and "Day or Evening".');
  }
  const rows = [];
  const problems = [];
  for (const r of matrix.slice(1)) {
    const rec = {};
    header.forEach((col, i) => {
      if (col) rec[col] = norm(r.cells[i]);
    });
    const names = splitNames(rec.names);
    const type = parseType(rec.type);
    const lang = parseLang(rec.lang);
    if (!names.length) {
      problems.push({ row: r.n, reason: 'no guest names' });
      continue;
    }
    if (names.length > 12) {
      problems.push({ row: r.n, reason: 'more than 12 names in one household' });
      continue;
    }
    if (!type) {
      problems.push({ row: r.n, reason: `"Day or Evening" not understood: "${rec.type || ''}"` });
      continue;
    }
    if (!lang) {
      problems.push({ row: r.n, reason: `language not understood: "${rec.lang}"` });
      continue;
    }
    rows.push({ rowNumber: r.n, names, type, lang, whatsapp: (rec.whatsapp || '').slice(0, 40), email: (rec.email || '').slice(0, 200) });
  }
  return { rows, problems };
}

module.exports = { parseGuestFile, TEMPLATE_CSV };
