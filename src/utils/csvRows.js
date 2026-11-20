// A small CSV reader for the production uploads: quotes, commas inside quotes, CRLF and a BOM are handled.
// parse(text) -> { headers: [normalised names], rows: [ { line, ...values by normalised header } ] }.  The header names are lower-cased and stripped of anything but letters / digits ("Employee ID" -> "employeeid", "K#" -> "k").
function cells(text) {
  const out = []; let row = []; let cur = ''; let inQ = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i += 1; } else inQ = false; } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cur); cur = ''; out.push(row); row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out;
}
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

function parse(text) {
  const all = cells(text);
  const at = all.findIndex((r) => r.some((c) => String(c).trim() !== ''));
  if (at < 0) return { headers: [], rows: [] };
  const headers = all[at].map(norm);
  const rows = [];
  for (let i = at + 1; i < all.length; i += 1) {
    if (all[i].every((c) => String(c).trim() === '')) continue;
    const r = { line: i + 1 };
    headers.forEach((h, j) => { if (h) r[h] = String(all[i][j] === undefined ? '' : all[i][j]).trim(); });
    rows.push(r);
  }
  return { headers, rows };
}

/** rows sent as JSON ([{date, shift, ...}]) are read the same way: keys normalised, a line number added. */
const fromObjects = (list) => ({ headers: list.length ? Object.keys(list[0]).map(norm) : [], rows: list.map((o, i) => { const r = { line: i + 1 }; for (const [k, v] of Object.entries(o)) r[norm(k)] = v == null ? '' : String(v).trim(); return r; }) });

module.exports = { parse, fromObjects, norm };
