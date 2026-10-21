// AUDIT: random sequences of store / chemical operations (purchase, approve, un-approve, issue, return, adjust),
// checked after every step against an independent model (FIFO batches at the purchase rate) and, regularly,
// against the accounting rules of scripts/audit/invariants.js. Seeded: the same seed repeats the same run.
const { world, rng, clean, expectClean, checkInvariants } = require('./world');

beforeEach(clean);
jest.setTimeout(600000);

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const m3 = (n) => Math.round(n * 1000);
const TOL = 0.03;

async function run(seed, steps) {
  const R = rng(seed);
  const w = await world();
  const items = [await w.chem('A'), await w.chem('B'), await w.chem('C', 'LTR')];
  await w.give('DYEING', items);
  // one Dyeing job takes every request
  const lot = await w.lot({ meters: 5000, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 5000 }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');

  // the model: per item, batches oldest first { qtyMilli, rate, valueLeft, purchaseId, used }
  const shadow = new Map(items.map((i) => [i.id, []]));
  const purchases = []; // { id, itemId, batch }
  const issued = []; // { requestId, lineId, itemId, parts: [{ batch, qtyMilli, value, returnedMilli }] }
  let day = 1;
  let netIssuedValue = 0; // money that left the store to jobs and did not come back
  const log = [];

  const stockQty = (id) => shadow.get(id).reduce((t, b) => t + b.qtyMilli, 0);
  const stockValue = (id) => r2(shadow.get(id).reduce((t, b) => t + b.valueLeft, 0));

  for (let step = 1; step <= steps; step += 1) {
    const kind = R.pick(['buy', 'buy', 'issue', 'issue', 'issue', 'return', 'return', 'adjustOut', 'adjustIn', 'count', 'unapprove']);
    const item = R.pick(items);
    try {
      if (kind === 'buy') {
        const qty = R.int(1, 50000) / 1000;
        const rate = R.int(100, 20000) / 100;
        const date = `2026-09-${String(day).padStart(2, '0')}`;
        day = Math.min(28, day + 1);
        const res = await w.ok('post', '/stores/chemical/inwards', { inwardDate: date, vendorName: 'V', lines: [{ itemId: item.id, qty, rate }], approve: true }, 201);
        const amount = res.lines[0].amount;
        if (Math.abs(amount - qty * rate) > 0.0051) throw new Error(`line amount ${amount} is not ${qty} x ${rate}`);
        const batch = { qtyMilli: m3(qty), rate: amount / qty, valueLeft: amount, date, order: step };
        shadow.get(item.id).push(batch);
        shadow.get(item.id).sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
        purchases.push({ id: res.id, itemId: item.id, batch });
        log.push(`buy ${item.name} ${qty} @ ${rate}`);
      } else if (kind === 'issue') {
        const have = stockQty(item.id);
        if (have < 10) continue;
        const qtyMilli = R.int(1, Math.max(1, Math.floor(have * (R.next() < 0.2 ? 1 : 0.6))));
        const qty = qtyMilli / 1000;
        const sent = await w.issue('DYEING', job, [{ itemId: item.id, qty }]);
        // the model: oldest batch first
        let left = qtyMilli; let value = 0; const parts = [];
        for (const b of shadow.get(item.id)) {
          if (left <= 0) break;
          const n = Math.min(left, b.qtyMilli);
          const v = n === b.qtyMilli ? b.valueLeft : r2((n / 1000) * b.rate);
          b.qtyMilli -= n; b.valueLeft = r2(b.valueLeft - v); left -= n; value = r2(value + v);
          parts.push({ batch: b, qtyMilli: n, value: v, returnedMilli: 0 });
        }
        shadow.set(item.id, shadow.get(item.id).filter((b) => b.qtyMilli > 0));
        if (Math.abs(sent.totalValue - value) > TOL) throw new Error(`issue of ${qty} ${item.name} valued ${sent.totalValue}, model says ${value}`);
        issued.push({ requestId: sent.id, lineId: sent.lines[0].id, itemId: item.id, parts });
        netIssuedValue = r2(netIssuedValue + sent.totalValue);
        log.push(`issue ${item.name} ${qty} = ${sent.totalValue}`);
      } else if (kind === 'return') {
        const cands = issued.filter((x) => x.parts.some((p) => p.qtyMilli - p.returnedMilli > 0));
        if (!cands.length) continue;
        const x = R.pick(cands);
        const can = x.parts.reduce((t, p) => t + p.qtyMilli - p.returnedMilli, 0);
        const qtyMilli = R.int(1, can);
        const ret = await w.ok('post', '/departments/DYEING/chemical-returns', { requestId: x.requestId, lines: [{ requestLineId: x.lineId, qty: qtyMilli / 1000 }] }, 201);
        const got = await w.ok('post', `/stores/chemical/returns/${ret.id}/receive`);
        // the model: back into the batches it came from, newest issue first (the batch may have been emptied: it is re-created)
        let left = qtyMilli; let value = 0;
        for (const p of [...x.parts].reverse()) {
          if (left <= 0) break;
          const n = Math.min(left, p.qtyMilli - p.returnedMilli);
          if (n <= 0) continue;
          const v = r2((n / 1000) * p.batch.rate);
          p.returnedMilli += n; p.batch.qtyMilli += n; p.batch.valueLeft = r2(p.batch.valueLeft + v);
          if (!shadow.get(x.itemId).includes(p.batch)) {
            shadow.get(x.itemId).push(p.batch);
            shadow.get(x.itemId).sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
          }
          left -= n; value = r2(value + v);
        }
        if (Math.abs(got.totalValue - value) > TOL) throw new Error(`return valued ${got.totalValue}, model says ${value}`);
        netIssuedValue = r2(netIssuedValue - got.totalValue);
        log.push(`return ${qtyMilli / 1000} = ${got.totalValue}`);
      } else if (kind === 'adjustOut') {
        const have = stockQty(item.id);
        if (have < 10) continue;
        const qtyMilli = R.int(1, Math.floor(have / 3));
        await w.ok('post', '/stores/chemical/adjustments', { reason: 'DAMAGED', lines: [{ itemId: item.id, mode: 'OUT', qty: qtyMilli / 1000 }] }, 201);
        let left = qtyMilli;
        for (const b of shadow.get(item.id)) {
          if (left <= 0) break;
          const n = Math.min(left, b.qtyMilli);
          const v = n === b.qtyMilli ? b.valueLeft : r2((n / 1000) * b.rate);
          b.qtyMilli -= n; b.valueLeft = r2(b.valueLeft - v); left -= n;
        }
        shadow.set(item.id, shadow.get(item.id).filter((b) => b.qtyMilli > 0));
        log.push(`adjust out ${item.name} ${qtyMilli / 1000}`);
      } else if (kind === 'adjustIn') {
        const qty = R.int(1, 5000) / 1000;
        const rate = R.int(100, 5000) / 100;
        await w.ok('post', '/stores/chemical/adjustments', { reason: 'OTHER', lines: [{ itemId: item.id, mode: 'IN', qty, rate }] }, 201);
        shadow.get(item.id).push({ qtyMilli: m3(qty), rate, valueLeft: r2(qty * rate), date: '2026-09-29', order: step });
        log.push(`adjust in ${item.name} ${qty} @ ${rate}`);
      } else if (kind === 'count') {
        const have = stockQty(item.id);
        const target = Math.max(0, have + R.int(-2000, 2000));
        if (target === have) continue;
        const res = await w.api('post', '/stores/chemical/adjustments', { reason: 'COUNT', lines: [{ itemId: item.id, mode: 'COUNT', qty: target / 1000 }] });
        if (res.status !== 201) { log.push(`count refused ${res.body.error && res.body.error.code}`); continue; }
        // the model: a count up is added at the average rate, a count down is taken oldest first
        if (target > have) {
          const avg = have > 0 ? Math.round((stockValue(item.id) / (have / 1000)) * 10000) / 10000 : 0;
          shadow.get(item.id).push({ qtyMilli: target - have, rate: avg, valueLeft: r2(((target - have) / 1000) * avg), date: '2026-09-29', order: step });
        } else {
          let left = have - target;
          for (const b of shadow.get(item.id)) {
            if (left <= 0) break;
            const n = Math.min(left, b.qtyMilli);
            const v = n === b.qtyMilli ? b.valueLeft : r2((n / 1000) * b.rate);
            b.qtyMilli -= n; b.valueLeft = r2(b.valueLeft - v); left -= n;
          }
          shadow.set(item.id, shadow.get(item.id).filter((b) => b.qtyMilli > 0));
        }
        log.push(`count ${item.name} ${have / 1000} -> ${target / 1000}`);
      } else if (kind === 'unapprove') {
        const p = purchases.find((x) => x.itemId === item.id && shadow.get(item.id).includes(x.batch) && x.batch.qtyMilli === m3(x.batch.qtyMilli / 1000) && !issued.some((i) => i.parts.some((q) => q.batch === x.batch)));
        if (!p) continue;
        const res = await w.api('post', `/stores/chemical/inwards/${p.id}/unapprove`);
        if (res.status === 200) {
          shadow.set(item.id, shadow.get(item.id).filter((b) => b !== p.batch));
          purchases.splice(purchases.indexOf(p), 1);
          log.push(`unapprove ${item.name}`);
        } else log.push(`unapprove refused ${res.body.error && res.body.error.code}`);
      }
    } catch (e) {
      e.message = `seed ${seed} step ${step} (${kind} ${item.name}): ${e.message}\nlast steps: ${log.slice(-6).join(' | ')}`;
      throw e;
    }

    // after every step: the real stock = the model
    for (const it of items) {
      const real = await w.stock(it);
      if (m3(real.stockQty) !== stockQty(it.id)) throw new Error(`seed ${seed} step ${step} (${kind}): ${it.name} stock ${real.stockQty} but model ${stockQty(it.id) / 1000}\nlast steps: ${log.slice(-6).join(' | ')}`);
      if (Math.abs(real.stockValue - stockValue(it.id)) > TOL * 6) throw new Error(`seed ${seed} step ${step} (${kind}): ${it.name} value ${real.stockValue} but model ${stockValue(it.id)}\nlast steps: ${log.slice(-6).join(' | ')}`);
    }
    if (step % 8 === 0) {
      const broken = await checkInvariants();
      if (broken.length) throw new Error(`seed ${seed} step ${step} (${kind}): rules broken ${JSON.stringify(broken)}\nlast steps: ${log.slice(-6).join(' | ')}`);
    }
  }
  await expectClean();

  // the money the jobs carry = the issued value minus what came back; every report agrees
  const cost = await w.ok('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`);
  expect(Math.abs(cost.totalValue - netIssuedValue)).toBeLessThanOrEqual(0.05);
  const so = await w.ok('get', `/stores/chemical/cost/so-cards/${card.id}`);
  expect(Math.abs(so.totalValue - netIssuedValue)).toBeLessThanOrEqual(0.05);
  const rep = await w.ok('get', '/reports/chemical-cost');
  expect(Math.abs(rep.totalCost - netIssuedValue)).toBeLessThanOrEqual(0.05);
  return log.length;
}

// AUDIT_SEEDS / AUDIT_STEPS make the run bigger (default: a quick run)
const SEEDS = Array.from({ length: Number(process.env.AUDIT_SEEDS || 3) }, (_, i) => i + 1);
test.each(SEEDS)('random store and chemical operations (seed %i): stock, value and cost stay exact', async (seed) => {
  const steps = await run(seed, Number(process.env.AUDIT_STEPS || 60));
  expect(steps).toBeGreaterThan(20);
});
