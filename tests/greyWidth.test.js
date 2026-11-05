const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(120000);
beforeEach(clean);

test('the width typed at grey inward (per thaan, or one for the lot) goes with the cloth to the SO card, the job, Folding and the packing list', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING', 'REPORT_GREY', 'REPORT_SO_CARDS', 'REPORT_PACKING', 'REPORT_FOLDING', 'REPORT_ACTIVE_FABRIC']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const base = { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id };

  // wrong widths are refused
  for (const bad of [0, -5, 'abc', 10000]) expect((await api('post', '/grey-lots', { ...base, thaans: [100], width: bad })).status).toBe(400);
  expect((await api('post', '/grey-lots', { ...base, thaans: [{ length: 100, width: 0 }] })).status).toBe(400);

  // a lot width of 63; thaan 2 has its own width of 58; plain numbers still work
  const created = await api('post', '/grey-lots', { ...base, width: 63, thaans: [100, { length: 120, width: 58 }, 80] });
  expect(created.status).toBe(201);
  const lot = created.body;
  expect(lot).toMatchObject({ width: 63, widths: [58, 63], pieces: 3, inwardMeters: 300 });
  expect(lot.thaans.map((t) => [t.thaanNo, t.meters, t.width])).toEqual([[1, 100, 63], [2, 120, 58], [3, 80, 63]]);
  // no width at all stays empty
  const none = (await api('post', '/grey-lots', { ...base, thaans: [50] })).body;
  expect(none).toMatchObject({ width: null, widths: [] });
  expect(none.thaans[0].width).toBeNull();
  // a new lot width reaches the thaans that had the old one (or none), not the one with its own width
  const changed = (await api('patch', `/grey-lots/${lot.id}`, { width: 60 })).body;
  expect(changed.thaans.map((t) => t.width)).toEqual([60, 58, 60]);
  // sending the thaans again without widths keeps the widths they have
  const again = (await api('patch', `/grey-lots/${lot.id}`, { thaans: [100, 120, 80] })).body;
  expect(again.thaans.map((t) => t.width)).toEqual([60, 58, 60]);
  const reset = (await api('patch', `/grey-lots/${lot.id}`, { thaans: [100, { length: 120, width: 58 }, { length: 80, width: 63 }] })).body;
  expect(reset.thaans.map((t) => t.width)).toEqual([60, 58, 63]);
  expect((await api('get', `/grey-lots/${lot.id}`)).body.widths).toEqual([58, 60, 63]);
  await api('post', `/grey-lots/${lot.id}/approve`);

  // the SO card
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3] }] })).body;
  expect(card.lots[0]).toMatchObject({ width: 60, widths: [58, 60, 63] });
  expect(card.lots[0].thaans.map((t) => [t.thaanNo, t.width])).toEqual([[1, 60], [2, 58], [3, 63]]);

  // the department job
  const fd = (await api('get', '/jobs/form-data')).body;
  const dye = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  const job = (await api('get', `/departments/DYEING/jobs/${dye.id}`)).body;
  const item = (job.items || job.rows || [])[0];
  expect(item.thaans.map((t) => [t.thaanNo, t.width])).toEqual([[1, 60], [2, 58], [3, 63]]);
  expect(item.widths).toEqual([58, 60, 63]);

  // Folding
  await api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' });
  const form = (await api('get', '/departments/DYEING/send-form')).body;
  await api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  const frow = (await api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
  expect(frow.lots[0].lines.map((l) => [l.thaanNo, l.width])).toEqual([[1, 60], [2, 58], [3, 63]]);
  expect(frow.lots[0].widths).toEqual([58, 60, 63]);
  const ls = frow.lots[0].lines;
  await api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [
    { greyLotId: lot.id, thaanId: ls[0].thaanId, a: 100 }, { greyLotId: lot.id, thaanId: ls[1].thaanId, b: 120 }, { greyLotId: lot.id, thaanId: ls[2].thaanId, a: 80 },
  ] });
  const pack = (await api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, { keepRemaining: false })).body.packingJob;

  // Packing: the form, and the packing list itself
  await api('post', `/departments/PACKING/jobs/${pack.id}/accept`);
  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(f.lots[0].thaans.map((t) => [t.thaanNo, t.width])).toEqual([[1, 60], [2, 58], [3, 63]]);
  expect(f.lots[0].widths).toEqual([58, 60, 63]);
  const pl = (await api('post', '/departments/PACKING/packing-lists', {
    soCardId: card.id, rateA: 50, rateB: 25,
    lines: f.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: t.suggestedLines[0].grade, meters: t.suggestedLines[0].meters })),
  })).body;
  expect(pl.lots[0].thaans.map((t) => [t.thaanNo, t.width])).toEqual([[1, 60], [2, 58], [3, 63]]);
  const got = (await api('get', `/departments/PACKING/packing-lists/${pl.id}`)).body;
  expect(got.lots[0].thaans.map((t) => t.width)).toEqual([60, 58, 63]);
  // the reports carry a Width column (so the screens and the exports made from them have it too)
  const widthOf = async (url, pick) => {
    const r = await api('get', url);
    expect([url, r.status]).toEqual([url, 200]);
    const sec = r.body.sections.find((x) => x.columns.some((c) => c.key === 'width'));
    expect([url, Boolean(sec)]).toEqual([url, true]);
    expect(sec.columns.find((c) => c.key === 'width').label).toBe('Width (m)');
    return pick(sec.rows);
  };
  expect(await widthOf('/reports/grey/lots', (rows) => rows.find((x) => x.lotNo === lot.lotNo).width)).toBe('58, 60, 63');
  expect(await widthOf('/reports/so-cards/lots', (rows) => rows.map((x) => x.width))).toEqual(['58, 60, 63']);
  expect(await widthOf(`/reports/so-cards/${card.id}`, (rows) => rows[0].width)).toBe('58, 60, 63');
  expect(await widthOf('/reports/packing-lists?view=lines', (rows) => rows.map((x) => [x.thaanNo, x.width]))).toEqual([[1, 60], [2, 58], [3, 63]]);
  expect(await widthOf('/reports/folding', (rows) => rows[0].width)).toBe('58, 60, 63');
  // a lot with no width at all shows an empty cell
  await api('post', `/grey-lots/${none.id}/approve`);
  expect(await widthOf('/reports/grey/lots', (rows) => rows.find((x) => x.lotNo === none.lotNo).width)).toBe('');
});
