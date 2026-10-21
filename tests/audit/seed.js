// One of everything in a company, to be used by the audit sweeps (security, robustness, performance).
const fs = require('fs');
const path = require('path');

/** Every API route of the app as { method, path } with the real mount prefixes (read from src/routes/index.js). */
function allRoutes() {
  const app = require('../../src/app');
  const index = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');
  const prefixes = [...index.matchAll(/router\.use\('(\/v1\/[^']+)'/g)].map((m) => m[1]);
  const top = app.router || app._router;
  const out = [];
  const matches = (layer, p) => layer.matchers.some((m) => m(p));
  (function walk(stack, prefix, depth) {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) out.push({ method, path: `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` });
      } else if (layer.handle && layer.handle.stack) {
        let add = '';
        if (depth === 0) add = '/api';
        else if (depth === 1) {
          const hit = prefixes.filter((p) => matches(layer, p)).sort((a, b) => b.length - a.length)[0];
          add = hit || '';
        }
        walk(layer.handle.stack, prefix + add, depth + 1);
      }
    }
  }(top.stack, '', 0));
  return out;
}

/** Builds one of everything in the world; returns the ids by kind. */
async function seedEverything(w) {
  const ids = {};
  const cu = await w.customer('AZ TEXTILES');
  const q = await w.quality('PC TWILL');
  ids.customer = cu.id; ids.quality = q.id;
  const lot = await w.lot({ customer: cu, quality: q, thaans: [100, 120, 80, 90] });
  ids.lot = lot.id; ids.thaan = lot.thaans[0].id;
  const lot2 = await w.lot({ customer: cu, quality: q, meters: 500, pieces: 2 });
  ids.lot2 = lot2.id;
  const back = await w.ok('post', `/grey-lots/${lot2.id}/give-back`, { meters: 10, pieces: 1 });
  ids.giveBack = back.returns[0].id;
  const card = await w.card([{ greyLotId: lot.id, thaanNos: [1, 2] }]);
  ids.card = card.id;
  const card2 = await w.card([{ greyLotId: lot.id, thaanNos: [3] }]); // stays NEW
  ids.card2 = card2.id;
  const fr = await w.ok('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [4] }] }, 201);
  ids.fabricReturn = fr.id;
  const colour = await w.ok('post', '/colours', { name: 'NAVY' });
  ids.colour = colour.id;
  const job = await w.sendCard(card, 'DYEING');
  ids.job = job.id; ids.jobItem = job.items[0].id;
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  // store and chemicals
  const vendor = await w.vendor('ALI CHEM');
  ids.vendor = vendor.id;
  const cat = await w.ok('post', '/stores/chemical/categories', { name: 'DYES' });
  const brand = await w.ok('post', '/stores/chemical/brands', { name: 'BASF' });
  ids.category = cat.id; ids.brand = brand.id;
  const red = await w.chem('RED');
  ids.item = red.id;
  const inward = await w.buy(red, 100, 10);
  ids.inward = inward.id;
  const draft = await w.ok('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'V2', lines: [{ itemId: red.id, qty: 1 }] }, 201);
  ids.draftInward = draft.id;
  ids.batch = (await w.ok('get', `/stores/chemical/items/${red.id}/batches`)).batches[0].batchId;
  await w.give('DYEING', [red]);
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 10 }]);
  ids.request = sent.id; ids.requestLine = sent.lines[0].id;
  const pending = await w.ok('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 1 }] }, 201);
  ids.pendingRequest = pending.id;
  const ret = await w.ok('post', '/departments/DYEING/chemical-returns', { requestId: sent.id, lines: [{ requestLineId: sent.lines[0].id, qty: 2 }] }, 201);
  ids.return = ret.id;
  const adj = await w.ok('post', '/stores/chemical/adjustments', { reason: 'OTHER', lines: [{ itemId: red.id, mode: 'IN', qty: 1, rate: 12 }] }, 201);
  ids.adjustment = adj.id;
  // forward through Folding and Packing to a gate pass
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  ids.foldingJob = fold.id;
  await w.accept('FOLDING', fold);
  const url = `/departments/FOLDING/folding/${fold.id}/${card.id}`;
  const row = await w.ok('get', url);
  await w.ok('put', `${url}/grades`, { lines: row.lots[0].lines.map((l) => ({ greyLotId: row.lots[0].lotId, thaanId: l.thaanId, a: l.received })) });
  const pack = (await w.ok('post', `${url}/send-packing`, {}, 201)).packingJob;
  ids.packingJob = pack.id;
  await w.accept('PACKING', pack);
  const form = await w.ok('get', `/departments/PACKING/packing/so-cards/${card.id}/form`);
  const pl = await w.ok('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 10, lines: form.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: t.meters })) }, 201);
  ids.packingList = pl.id;
  await w.ok('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  const gp = await w.ok('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'D', vehicleNo: 'V-1', passDate: '2030-01-01' });
  ids.gatePass = gp.id;
  // people
  const emp = await w.ok('post', '/users', { name: 'Aslam', email: 'aslam@audit.com', password: 'Employee-Pass-123', services: [{ serviceId: w.s.DYEING.id, access: 'FULL' }] }, 201);
  ids.employee = emp.id;
  ids.company = w.company.id; ids.admin = w.admin.id;
  // (service ids are the same catalog for every company: not company data, so they are not part of the pool)
  ids.soCardDetailFr = fr.id;
  return ids;
}

module.exports = { allRoutes, seedEverything };
