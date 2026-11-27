const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');
const fourPoint = require('../src/utils/fourPoint');
const { today } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

// owner plan N-B1: fabric inspection with the 4-point system, by its own person (service INSPECTION)
const CODES = ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING', 'INSPECTION'];
async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of CODES) { s[code] = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: s[code].id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const person = async (code, access) => { const u = await makeUser({ userType: 'USER', companyId: company.id }); await UserService.create({ userId: u.id, serviceId: s[code].id, access }); return u; };
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, s, api: as(admin), inspector: as(await person('INSPECTION', 'FULL')), reader: as(await person('INSPECTION', 'VIEW')), folder: as(await person('FOLDING', 'FULL')) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

async function lotOf(w, thaans, extra = {}) {
  const cu = await ok(w.api('post', '/customers', { name: `AZ ${Math.random().toString(36).slice(2, 7)}` }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: `Q ${Math.random().toString(36).slice(2, 7)}` }), 201);
  const lot = await ok(w.api('post', '/grey-lots', { inwardDate: today(), customerId: cu.id, qualityId: ql.id, thaans, ...extra }), 201);
  return { cu, ql, lot };
}
/** The defect types of the company by code (the standard list is loaded once). */
async function defects(w) {
  const r = await ok(w.api('post', '/inspection/defect-types/standard'));
  return Object.fromEntries(r.data.map((d) => [d.code, d.id]));
}

test('4-point sums: points by size, fixed points, at most 4 on one meter, per 100 meters and per 100 square yards, grades', () => {
  const rules = fourPoint.STANDARD_RULES;
  expect(['S1', 'S2', 'S3', 'S4'].map((k) => fourPoint.pointsOf(rules, null, k))).toEqual([1, 2, 3, 4]);
  expect(fourPoint.pointsOf(rules, { fixedPoints: 4 }, 'S1')).toBe(4); // a hole
  expect(fourPoint.pointsOf(rules, null, 'S9')).toBeNull();
  // the owner's example: 1 + 2 + 3 = 6 points on 215 m = 2.79 per 100 m -> A
  expect(fourPoint.evaluate(rules, [{ atMeter: 12, points: 1 }, { atMeter: 80, points: 2 }, { atMeter: 150, points: 3 }], 215, null)).toEqual({ rawPoints: 6, totalPoints: 6, pointsPer100: 2.79, grade: 'A' });
  // one meter never gets more than 4: 12.2 (3) and 12.8 (4) are one meter
  expect(fourPoint.evaluate(rules, [{ atMeter: 12.2, points: 3 }, { atMeter: 12.8, points: 4 }, { atMeter: 13.1, points: 2 }], 100, null)).toMatchObject({ rawPoints: 9, totalPoints: 6 });
  expect(fourPoint.evaluate({ ...rules, maxPointsPerMeter: null }, [{ atMeter: 12.2, points: 3 }, { atMeter: 12.8, points: 4 }], 100, null).totalPoints).toBe(7);
  // the grade borders: 20 is A, over 20 is B, over 30 is C, over 40 is REJECT
  expect([0, 20, 20.01, 30, 30.01, 40, 40.01].map((x) => fourPoint.gradeOf(rules, x))).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'REJECT']);
  // per 100 square yards: 6 points, 215 m, 58 inch -> 215 x 1.0936133 x 58 / 36 = 378.81 square yards -> 1.58
  expect(fourPoint.per100({ ...rules, basis: 'SQ_YARD' }, 6, 215, 58)).toBe(1.58);
  expect(fourPoint.per100({ ...rules, basis: 'SQ_YARD' }, 6, 215, null)).toBeNull();
});

test('the inspector inspects a grey thaan: draft, defects worked out by the server, finish locks it, only the client admin reopens with a reason', async () => {
  const w = await setup();
  const d = await defects(w);
  const { lot, cu } = await lotOf(w, [215, 100]);
  // pick the lot and the thaan
  const pick = await ok(w.inspector('get', `/inspections/thaans?lotNo=${lot.lotNo}`));
  expect(pick.data.map((t) => [t.source, t.thaanNo, t.meters, t.latest, t.draft])).toEqual([['GREY', 1, 215, null, null], ['GREY', 2, 100, null, null]]);
  const t1 = pick.data[0];
  let ins = await ok(w.inspector('post', '/inspections', { source: 'GREY', thaanId: t1.thaanId, widthInches: 58 }), 201);
  expect(ins).toMatchObject({ inspectionNo: 1, label: 'INS-00001', status: 'DRAFT', lotNo: lot.lotNo, thaanNo: 1, meters: 215, widthInches: 58, preview: true, totalPoints: 0, pointsPer100: 0, grade: 'A', customer: { name: cu.name.toUpperCase() === cu.name ? cu.name : cu.name }, canEdit: true, canReopen: false });
  await fails(w.inspector('post', '/inspections', { source: 'GREY', thaanId: t1.thaanId }), 422, 'DRAFT_EXISTS');
  // the points come from the server: the screen sends only type, meter and size
  const list = [{ defectTypeId: d.OIL, atMeter: 12, sizeClass: 'S1' }, { defectTypeId: d.DIRT, atMeter: 80, sizeClass: 'S2' }, { defectTypeId: d.SLUB, atMeter: 150, sizeClass: 'S3', note: 'near selvedge' }];
  ins = await ok(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: list }));
  expect(ins).toMatchObject({ rawPoints: 6, totalPoints: 6, pointsPer100: 2.79, grade: 'A', suggestedFoldingGrade: 'a', defectCount: 3 });
  expect(ins.defects.map((x) => [x.code, x.atMeter, x.points])).toEqual([['OIL', 12, 1], ['DIRT', 80, 2], ['SLUB', 150, 3]]);
  // a hole has fixed points 4 whatever the size, and one meter gets at most 4
  const withHole = await ok(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [...list, { defectTypeId: d.HOLE, atMeter: 12.5, sizeClass: 'S1' }] }));
  expect(withHole).toMatchObject({ rawPoints: 10, totalPoints: 9 }); // meter 12: 1 + 4 = 5 -> 4
  // refused: beyond the thaan, a size that is not in the table, typed points, more than 300
  await fails(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [{ defectTypeId: d.OIL, atMeter: 215.5, sizeClass: 'S1' }] }), 422, 'BEYOND_THAAN');
  await fails(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [{ defectTypeId: d.OIL, atMeter: 1, sizeClass: 'XL' }] }), 422, 'UNKNOWN_SIZE');
  await fails(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [{ defectTypeId: d.OIL, atMeter: 1, sizeClass: 'S1', points: 0 }] }), 400, 'VALIDATION_FAILED');
  await fails(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: Array.from({ length: 301 }, () => list[0]) }), 400, 'VALIDATION_FAILED');
  await ok(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: list }));

  const done = await ok(w.inspector('post', `/inspections/${ins.id}/finish`));
  expect(done).toMatchObject({ status: 'FINISHED', preview: false, totalPoints: 6, pointsPer100: 2.79, grade: 'A', canEdit: false, canReopen: true });
  // finished: nothing changes it
  for (const p of [w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [] }), w.inspector('patch', `/inspections/${ins.id}`, { remarks: 'x' }), w.inspector('post', `/inspections/${ins.id}/finish`), w.inspector('delete', `/inspections/${ins.id}`, { reason: 'wrong one' })]) {
    await fails(p, 422, 'INSPECTION_FINISHED');
  }
  // a change of the settings does not change a finished one
  await ok(w.api('put', '/inspection/settings', { gradeLimits: [{ grade: 'A', maxPoints: 1 }, { grade: 'B', maxPoints: 2 }, { grade: 'C', maxPoints: 3 }] }));
  expect(await ok(w.reader('get', `/inspections/${ins.id}`))).toMatchObject({ grade: 'A', pointsPer100: 2.79 });
  // reopen: client admin only, with a reason
  expect((await w.inspector('post', `/inspections/${ins.id}/reopen`, { reason: 'a defect was missed' })).status).toBe(403);
  await fails(w.api('post', `/inspections/${ins.id}/reopen`, {}), 400, 'VALIDATION_FAILED');
  const re = await ok(w.api('post', `/inspections/${ins.id}/reopen`, { reason: 'a defect was missed' }));
  expect(re).toMatchObject({ status: 'DRAFT', grade: 'C', reopened: { reason: 'a defect was missed' } }); // the new limits now apply: 2.79 is C
  await ok(w.inspector('post', `/inspections/${ins.id}/finish`));

  // a re-inspection of the same thaan: the latest finished one counts
  let second = await ok(w.inspector('post', '/inspections', { source: 'GREY', thaanId: t1.thaanId }), 201);
  await ok(w.inspector('post', `/inspections/${second.id}/finish`));
  const again = (await ok(w.inspector('get', `/inspections/thaans?lotNo=${lot.lotNo}`))).data[0];
  expect(again.latest).toMatchObject({ inspectionNo: 2, grade: 'A' });
  // a draft can be deleted with a reason; its number is not used again
  const third = await ok(w.inspector('post', '/inspections', { source: 'GREY', thaanId: t1.thaanId }), 201);
  await fails(w.inspector('delete', `/inspections/${third.id}`), 400, 'VALIDATION_FAILED');
  await ok(w.inspector('delete', `/inspections/${third.id}`, { reason: 'opened by mistake' }), 204);
  second = await ok(w.inspector('post', '/inspections', { source: 'GREY', thaanId: pick.data[1].thaanId }), 201);
  expect(second.inspectionNo).toBe(4);
  // the list with filters
  expect((await ok(w.reader('get', '/inspections'))).total).toBe(3);
  expect((await ok(w.reader('get', `/inspections?lotNo=${lot.lotNo}&thaanNo=1&status=FINISHED`))).total).toBe(2);
  expect((await ok(w.reader('get', '/inspections?grade=C'))).total).toBe(1);

  // the summary counts only the latest finished inspection of a thaan (thaan 1: INS-2, grade A with no defects)
  const sum = await ok(w.inspector('get', '/reports/inspection-summary'));
  expect(sum.overall).toEqual({ thaans: 1, meters: 215, avgPointsPer100: 0 });
  expect(sum.sections.map((x) => x.key)).toEqual(['grades', 'defects', 'qualities', 'makers']);
});

test('settings, rights, two companies, per square yard, and the summary with top defects', async () => {
  const w = await setup();
  const other = await setup();
  const d = await defects(w);
  expect((await ok(w.api('post', '/inspection/defect-types/standard'))).added).toBe(0); // loading again adds nothing
  const { lot } = await lotOf(w, [100]);
  const thaan = (await ok(w.inspector('get', `/inspections/thaans?lotNo=${lot.lotNo}`))).data[0];

  // rights: only the inspection people; VIEW cannot write; Folding cannot open it; the settings are the client admin's
  expect((await w.folder('get', '/inspections')).status).toBe(403);
  expect((await w.folder('get', '/reports/inspection-summary')).status).toBe(403);
  expect((await w.reader('post', '/inspections', { source: 'GREY', thaanId: thaan.thaanId })).status).toBe(403);
  expect((await w.inspector('put', '/inspection/settings', { basis: 'SQ_YARD' })).status).toBe(403);
  expect((await w.inspector('post', '/inspection/defect-types', { code: 'X1', name: 'New one' })).status).toBe(403);
  await ok(w.reader('get', '/inspection/settings'));
  await fails(w.api('put', '/inspection/settings', { gradeLimits: [{ grade: 'A', maxPoints: 30 }, { grade: 'B', maxPoints: 20 }, { grade: 'C', maxPoints: 40 }] }), 422, 'GRADE_LIMITS');
  const own = await ok(w.api('post', '/inspection/defect-types', { code: 'x1', name: 'Loom oil line' }), 201);
  expect(own.code).toBe('X1');
  await fails(w.api('post', '/inspection/defect-types', { code: 'X2', name: 'loom OIL line' }), 422, 'NAME_TAKEN');

  // another company: its thaan, inspection and defect are not reachable
  await fails(other.api('post', '/inspections', { source: 'GREY', thaanId: thaan.thaanId }), 404, 'NOT_FOUND');
  expect((await ok(other.inspector('get', `/inspections/thaans?lotNo=${lot.lotNo}`))).data).toHaveLength(0);
  const ins = await ok(w.inspector('post', '/inspections', { source: 'GREY', thaanId: thaan.thaanId }), 201);
  for (const p of [other.api('get', `/inspections/${ins.id}`), other.api('put', `/inspections/${ins.id}/defects`, { defects: [] }), other.api('post', `/inspections/${ins.id}/finish`), other.api('patch', `/inspection/defect-types/${own.id}`, { name: 'hacked' })]) {
    await fails(p, 404, 'NOT_FOUND');
  }
  await fails(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [{ defectTypeId: (await defects(other)).OIL, atMeter: 1, sizeClass: 'S1' }] }), 404, 'NOT_FOUND');
  // a switched off defect is not used on new lines; a used one is not deleted
  await ok(w.api('patch', `/inspection/defect-types/${own.id}`, { isActive: false }));
  await fails(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [{ defectTypeId: own.id, atMeter: 1, sizeClass: 'S1' }] }), 422, 'DEFECT_INACTIVE');

  // per square yard: without the width it cannot finish
  await ok(w.api('put', '/inspection/settings', { basis: 'SQ_YARD' }));
  await ok(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: [{ defectTypeId: d.HOLE, atMeter: 5, sizeClass: 'S4' }, { defectTypeId: d.OIL, atMeter: 40, sizeClass: 'S4' }, { defectTypeId: d.OIL, atMeter: 41, sizeClass: 'S2' }] }));
  await ok(w.inspector('patch', `/inspections/${ins.id}`, { widthInches: null }));
  await fails(w.inspector('post', `/inspections/${ins.id}/finish`), 422, 'WIDTH_REQUIRED');
  await ok(w.inspector('patch', `/inspections/${ins.id}`, { widthInches: 60 }));
  const done = await ok(w.inspector('post', `/inspections/${ins.id}/finish`));
  // 10 points on 100 m x 60 inch = 182.27 square yards -> 5.49
  expect(done).toMatchObject({ totalPoints: 10, pointsPer100: 5.49, grade: 'A' });
  await fails(w.api('delete', `/inspection/defect-types/${d.OIL}`), 422, 'IN_USE');

  const sum = await ok(w.api('get', '/reports/inspection-summary'));
  expect(sum.sections[0].rows.find((r) => r.grade === 'A')).toMatchObject({ thaans: 1, meters: 100, thaanPercent: 100 });
  expect(sum.sections[1].rows.map((r) => [r.defect, r.count, r.points])).toEqual([['Oil stain', 2, 6], ['Hole / tear', 1, 4]]);
  expect(sum.sections[2].rows[0]).toMatchObject({ thaans: 1, gradeA: 1, reject: 0 });
  expect((await ok(other.api('get', '/reports/inspection-summary'))).overall.thaans).toBe(0);
  expect((await ok(w.api('get', '/reports'))).reports.map((x) => x.key)).toContain('inspection-summary');
});

test('a thaan a department made is inspected too; Folding and Packing show its grade as a suggestion and nothing else changes', async () => {
  const w = await setup();
  const d = await defects(w);
  const { lot } = await lotOf(w, [100, 120]);
  await ok(w.api('post', `/grey-lots/${lot.id}/approve`));
  const card = await ok(w.api('post', '/so-cards', { cardDate: today(), lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] }), 201);
  const fd = await ok(w.api('get', '/jobs/form-data'));
  const job = await ok(w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: fd.rows.find((r) => r.soCard.id === card.id).soCardLotId }] }), 201);
  await ok(w.api('post', `/departments/DYEING/jobs/${job.id}/receive`));
  await ok(w.api('post', `/departments/DYEING/jobs/${job.id}/accept`));
  await ok(w.api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: job.items[0].id, thaans: [110, 108] }] }));
  // the inspector sees the two grey thaans and the two thaans Dyeing made
  const pick = (await ok(w.inspector('get', `/inspections/thaans?lotNo=${lot.lotNo}`))).data;
  expect(pick.map((t) => [t.source, t.thaanNo, t.meters, t.departmentName])).toEqual([['GREY', 1, 100, null], ['GREY', 2, 120, null], ['DEPARTMENT', 1, 110, 'Dyeing'], ['DEPARTMENT', 2, 108, 'Dyeing']]);
  const made = pick[2];
  let ins = await ok(w.inspector('post', '/inspections', { source: 'DEPARTMENT', thaanId: made.thaanId }), 201);
  expect(ins).toMatchObject({ department: { name: 'Dyeing' }, jobNo: job.jobNo, meters: 110, thaanExists: true });
  await ok(w.inspector('put', `/inspections/${ins.id}/defects`, { defects: Array.from({ length: 7 }, (_, i) => ({ defectTypeId: d.PATCH, atMeter: i * 5, sizeClass: 'S4' })) })); // 28 points on 110 m = 25.45 -> B
  ins = await ok(w.inspector('post', `/inspections/${ins.id}/finish`));
  expect(ins).toMatchObject({ pointsPer100: 25.45, grade: 'B' });

  // on to Folding: the department's thaans can still be sent (nothing is blocked), and the row shows the grade beside thaan 1 only
  await ok(w.api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'COMPLETE' }));
  await ok(w.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Aslam', processDate: today() }));
  const form = await ok(w.api('get', `/departments/DYEING/send-form?jobId=${job.id}`));
  const fold = await ok(w.api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] }), 201);
  await ok(w.api('post', `/departments/FOLDING/jobs/${fold.id}/accept`));
  const row = await ok(w.folder('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`));
  const lines = row.lots[0].lines;
  expect(lines[0].inspection).toMatchObject({ grade: 'B', pointsPer100: 25.45, suggestedFoldingGrade: 'b', label: 'INS-00001' });
  expect(lines[1].inspection).toBeUndefined();
  expect(lines[0]).toMatchObject({ a: 0, b: 0, cp: 0 }); // a suggestion only: nothing was graded by itself
  // the folder still chooses: grade it A
  await ok(w.api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [{ greyLotId: lot.id, thaanId: lines[0].thaanId, a: 110 }, { greyLotId: lot.id, thaanId: lines[1].thaanId, a: 108 }] }));
  const pack = (await ok(w.api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, { keepRemaining: false }), 201)).packingJob;
  await ok(w.api('post', `/departments/PACKING/jobs/${pack.id}/accept`));
  const pf = await ok(w.api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`));
  expect(pf.lots[0].thaans[0].inspection).toMatchObject({ grade: 'B' });
  const pl = await ok(w.api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 10, lines: [{ greyLotId: lot.id, thaanId: pf.lots[0].thaans[0].thaanId, grade: 'A', meters: 110 }] }), 201);
  expect(pl.lots[0].thaans[0].inspection).toMatchObject({ grade: 'B', inspectionNo: 1 });
  // the summary knows the department that made it
  const sum = await ok(w.inspector('get', '/reports/inspection-summary'));
  expect(sum.sections[3].rows[0]).toMatchObject({ department: 'Dyeing', thaans: 1, gradeB: 1 });
});
