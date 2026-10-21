// Accounting / data-integrity rules of the whole system, each one a SELECT that returns the ROWS THAT BREAK THE RULE
// (no rows = the rule holds). Used by tests/audit/*.test.js after every scenario and by scripts/audit-db.js on a real
// database (read only). Money tolerance: 0.01 per row (cents), meters tolerance: 0.005.
// severity: CRITICAL (money / cloth wrong), HIGH (data inconsistent), MEDIUM (will cause trouble later).
const T = 0.011; // money / meter tolerance for one row

module.exports = [
  // ---------------- STORE: stock and value ----------------
  {
    id: 'STOCK-01', severity: 'CRITICAL', title: 'item stock qty = sum of its batches',
    sql: `SELECT i.id, i.name, i."stockQty"::float AS item_qty, COALESCE(SUM(b."qtyLeft"), 0)::float AS batch_qty
          FROM store_items i LEFT JOIN store_batches b ON b."itemId" = i.id GROUP BY i.id
          HAVING ABS(i."stockQty" - COALESCE(SUM(b."qtyLeft"), 0)) > 0.0005`,
  },
  {
    id: 'STOCK-02', severity: 'CRITICAL', title: 'item stock value = sum of its batches value (costing base)',
    sql: `SELECT i.id, i.name, i."stockValue"::float AS item_value, COALESCE(SUM(b."valueLeft"), 0)::float AS batch_value
          FROM store_items i LEFT JOIN store_batches b ON b."itemId" = i.id GROUP BY i.id
          HAVING ABS(i."stockValue" - COALESCE(SUM(b."valueLeft"), 0)) > ${T}`,
  },
  {
    id: 'STOCK-03', severity: 'CRITICAL', title: 'no negative stock, batch or value',
    sql: `SELECT 'item' AS kind, id, "stockQty"::float AS qty, "stockValue"::float AS value FROM store_items WHERE "stockQty" < 0 OR "stockValue" < 0
          UNION ALL SELECT 'batch', id, "qtyLeft"::float, "valueLeft"::float FROM store_batches WHERE "qtyLeft" < 0 OR "valueLeft" < 0`,
  },
  {
    id: 'STOCK-04', severity: 'HIGH', title: 'a batch has stock but no value (or value but no stock)',
    sql: `SELECT id, "itemId", "qtyLeft"::float AS qty, "valueLeft"::float AS value, rate::float FROM store_batches
          WHERE ("qtyLeft" = 0 AND "valueLeft" <> 0) OR ("qtyLeft" > 0 AND "valueLeft" = 0 AND rate > 0)`,
  },
  {
    id: 'STOCK-05', severity: 'HIGH', title: 'a batch holds more than it came in with',
    sql: `SELECT id, "qtyIn"::float, "qtyLeft"::float FROM store_batches WHERE "qtyLeft" > "qtyIn" + 0.0005`,
  },
  {
    id: 'STOCK-06', severity: 'CRITICAL', title: 'stock qty = opening stock + stock moves made after it (ledger agrees with stock)',
    sql: `WITH op AS (SELECT "itemId", SUM("qtyIn") q, SUM("qtyIn" * rate) v, MAX("createdAt") at FROM store_batches WHERE source = 'OPENING' GROUP BY 1),
               mv AS (SELECT m."itemId", SUM(m.qty) q FROM store_moves m LEFT JOIN op ON op."itemId" = m."itemId" WHERE op.at IS NULL OR m."createdAt" > op.at GROUP BY 1)
          SELECT i.id, i.name, i."stockQty"::float AS stock, (COALESCE(op.q, 0) + COALESCE(mv.q, 0))::float AS ledger
          FROM store_items i LEFT JOIN op ON op."itemId" = i.id LEFT JOIN mv ON mv."itemId" = i.id
          WHERE ABS(i."stockQty" - (COALESCE(op.q, 0) + COALESCE(mv.q, 0))) > 0.0005`,
  },
  {
    id: 'STOCK-07', severity: 'CRITICAL', title: 'stock value = opening value + value of the stock moves made after it (ledger agrees with value)',
    // opening value is recovered as qtyIn * rate (rate has 4 decimals): tolerance 0.05 per item
    sql: `WITH op AS (SELECT "itemId", SUM("qtyIn") q, SUM("qtyIn" * rate) v, MAX("createdAt") at FROM store_batches WHERE source = 'OPENING' GROUP BY 1),
               mv AS (SELECT m."itemId", SUM(m.value) v FROM store_moves m LEFT JOIN op ON op."itemId" = m."itemId" WHERE op.at IS NULL OR m."createdAt" > op.at GROUP BY 1)
          SELECT i.id, i.name, i."stockValue"::float AS stock, (COALESCE(op.v, 0) + COALESCE(mv.v, 0))::float AS ledger
          FROM store_items i LEFT JOIN op ON op."itemId" = i.id LEFT JOIN mv ON mv."itemId" = i.id
          WHERE ABS(i."stockValue" - (COALESCE(op.v, 0) + COALESCE(mv.v, 0))) > 0.05`,
  },

  // ---------------- CHEMICAL requests, issue, returns: the cost of a job ----------------
  {
    id: 'COST-01', severity: 'CRITICAL', title: 'a sent request line: value = sum of what its batches issued (qty and money)',
    sql: `SELECT l.id, l."requestId", l."sentQty"::float AS sent_qty, l.value::float AS line_value, x.q::float AS issued_qty, x.v::float AS issued_value
          FROM chemical_request_lines l JOIN (SELECT "requestLineId", SUM(qty) q, SUM(value) v FROM chemical_issue_batches GROUP BY 1) x ON x."requestLineId" = l.id
          WHERE ABS(l."sentQty" - x.q) > 0.0005 OR ABS(l.value - x.v) > ${T}`,
  },
  {
    id: 'COST-02', severity: 'CRITICAL', title: 'a request total = sum of its line values (and returned value likewise)',
    sql: `SELECT r.id, r."reqNo", r.status, r."totalValue"::float AS total, COALESCE(s.v, 0)::float AS lines, r."returnedValue"::float AS returned, COALESCE(s.rv, 0)::float AS lines_returned
          FROM chemical_requests r LEFT JOIN (SELECT "requestId", SUM(value) v, SUM("returnedValue") rv FROM chemical_request_lines GROUP BY 1) s ON s."requestId" = r.id
          WHERE r.status IN ('IN_WAY', 'DELIVERED') AND (ABS(r."totalValue" - COALESCE(s.v, 0)) > ${T} OR ABS(r."returnedValue" - COALESCE(s.rv, 0)) > ${T})`,
  },
  {
    id: 'COST-03', severity: 'CRITICAL', title: 'returned more than was sent (qty or value)',
    sql: `SELECT id, "requestId", "sentQty"::float, "returnedQty"::float, value::float, "returnedValue"::float FROM chemical_request_lines
          WHERE "returnedQty" > COALESCE("sentQty", 0) + 0.0005 OR "returnedValue" > value + ${T}`,
  },
  {
    id: 'COST-04', severity: 'HIGH', title: 'line returned qty = what its batches took back',
    sql: `SELECT l.id, l."returnedQty"::float AS line_returned, x.q::float AS batch_returned
          FROM chemical_request_lines l JOIN (SELECT "requestLineId", SUM("returnedQty") q FROM chemical_issue_batches GROUP BY 1) x ON x."requestLineId" = l.id
          WHERE ABS(l."returnedQty" - x.q) > 0.0005`,
  },
  {
    id: 'COST-05', severity: 'HIGH', title: 'a received return: total = sum of its lines',
    sql: `SELECT r.id, r."returnNo", r."totalValue"::float AS total, COALESCE(s.v, 0)::float AS lines
          FROM chemical_returns r LEFT JOIN (SELECT "returnId", SUM(value) v FROM chemical_return_lines GROUP BY 1) s ON s."returnId" = r.id
          WHERE r.status = 'RECEIVED' AND ABS(r."totalValue" - COALESCE(s.v, 0)) > ${T}`,
  },
  {
    id: 'COST-06', severity: 'HIGH', title: 'a request that was only asked (not sent) carries stock movement or value',
    sql: `SELECT r.id, r."reqNo", r.status, r."totalValue"::float FROM chemical_requests r
          WHERE r.status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED') AND (r."totalValue" <> 0 OR EXISTS (SELECT 1 FROM chemical_issue_batches x WHERE x."requestId" = r.id))`,
  },

  // ---------------- GREY and SO cards: meters ----------------
  {
    id: 'CLOTH-01', severity: 'CRITICAL', title: 'lot outward meters = meters on SO cards + given back',
    sql: `SELECT gl.id, gl."lotNo", gl."outwardMeters"::float AS outward, (COALESCE(x.m, 0) + gl."returnedMeters")::float AS expected
          FROM grey_lots gl LEFT JOIN (SELECT scl."greyLotId" id, SUM(scl.meters) m FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL GROUP BY 1) x ON x.id = gl.id
          WHERE gl."deletedAt" IS NULL AND ABS(gl."outwardMeters" - (COALESCE(x.m, 0) + gl."returnedMeters")) > ${T}`,
  },
  {
    id: 'CLOTH-02', severity: 'CRITICAL', title: 'a lot gave out more than it received (negative balance)',
    sql: `SELECT id, "lotNo", "inwardMeters"::float, "outwardMeters"::float FROM grey_lots WHERE "outwardMeters" > "inwardMeters" + ${T} OR "outwardMeters" < 0`,
  },
  {
    id: 'CLOTH-03', severity: 'CRITICAL', title: 'lot meters = sum of its thaans (thaan lots)',
    sql: `SELECT gl.id, gl."lotNo", gl."inwardMeters"::float AS lot, SUM(t.meters)::float AS thaans, gl.pieces, COUNT(t.id)::int AS thaan_count
          FROM grey_lots gl JOIN grey_lot_thaans t ON t."lotId" = gl.id WHERE gl."deletedAt" IS NULL GROUP BY gl.id
          HAVING ABS(gl."inwardMeters" - SUM(t.meters)) > ${T} OR gl.pieces <> COUNT(t.id)`,
  },
  {
    id: 'CLOTH-04', severity: 'CRITICAL', title: 'thaan taken meters = sum of what SO cards took of it',
    sql: `SELECT t.id, t."lotId", t."thaanNo", t.meters::float, t."takenMeters"::float AS taken, COALESCE(x.m, 0)::float AS on_cards, t.status
          FROM grey_lot_thaans t LEFT JOIN (SELECT p."thaanId" id, SUM(p.meters) m FROM so_card_lot_thaans p JOIN so_card_lots l ON l.id = p."soCardLotId" JOIN so_cards sc ON sc.id = l."soCardId" AND sc."deletedAt" IS NULL GROUP BY 1) x ON x.id = t.id
          WHERE t.status <> 'RETURNED' AND ABS(t."takenMeters" - COALESCE(x.m, 0)) > ${T}`,
  },
  {
    id: 'CLOTH-05', severity: 'HIGH', title: 'a thaan is taken for more than its length',
    sql: `SELECT id, "lotId", "thaanNo", meters::float, "takenMeters"::float FROM grey_lot_thaans WHERE "takenMeters" > meters + ${T} OR "takenMeters" < 0`,
  },
  {
    id: 'CLOTH-06', severity: 'HIGH', title: 'lot returned meters = sum of its give-backs',
    sql: `SELECT gl.id, gl."lotNo", gl."returnedMeters"::float AS lot, COALESCE(x.m, 0)::float AS returns
          FROM grey_lots gl LEFT JOIN (SELECT "lotId", SUM(meters) m FROM grey_returns GROUP BY 1) x ON x."lotId" = gl.id
          WHERE gl."deletedAt" IS NULL AND ABS(gl."returnedMeters" - COALESCE(x.m, 0)) > ${T}`,
  },
  {
    id: 'CLOTH-07', severity: 'HIGH', title: 'SO card meters = sum of its lot lines',
    sql: `SELECT sc.id, sc."cardNo", sc."totalMeters"::float AS card, COALESCE(x.m, 0)::float AS lines
          FROM so_cards sc LEFT JOIN (SELECT "soCardId", SUM(meters) m FROM so_card_lots GROUP BY 1) x ON x."soCardId" = sc.id
          WHERE sc."deletedAt" IS NULL AND ABS(sc."totalMeters" - COALESCE(x.m, 0)) > ${T}`,
  },
  {
    id: 'CLOTH-08', severity: 'HIGH', title: 'SO card line meters = sum of its thaan parts (thaan lots)',
    sql: `SELECT l.id, l."soCardId", l.meters::float AS line, SUM(p.meters)::float AS parts FROM so_card_lots l JOIN so_card_lot_thaans p ON p."soCardLotId" = l.id
          JOIN so_cards sc ON sc.id = l."soCardId" AND sc."deletedAt" IS NULL GROUP BY l.id HAVING ABS(l.meters - SUM(p.meters)) > ${T}`,
  },

  // ---------------- JOBS: cloth travelling through departments ----------------
  {
    id: 'JOB-01', severity: 'HIGH', title: 'job total meters = sum of its items',
    sql: `SELECT j.id, j."jobNo", j."totalMeters"::float AS job, COALESCE(x.m, 0)::float AS items
          FROM jobs j LEFT JOIN (SELECT "jobId", SUM(meters) m FROM job_items GROUP BY 1) x ON x."jobId" = j.id WHERE ABS(j."totalMeters" - COALESCE(x.m, 0)) > ${T}`,
  },
  {
    id: 'JOB-02', severity: 'CRITICAL', title: 'cloth sent from the SO card desk is more than the card holds (same SO card line sent twice)',
    sql: `SELECT scl.id, scl."soCardId", scl.meters::float AS card_line, SUM(ji.meters)::float AS sent
          FROM so_card_lots scl JOIN job_items ji ON ji."soCardLotId" = scl.id AND ji."sourceJobItemId" IS NULL JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED'
          GROUP BY scl.id HAVING SUM(ji.meters) > scl.meters + ${T}`,
  },
  {
    id: 'JOB-03', severity: 'CRITICAL', title: 'a department sent on more cloth than it received (same job item sent twice), outside Folding grading',
    sql: `SELECT p.id, p."jobId", p.meters::float AS received, SUM(c.meters)::float AS sent_on
          FROM job_items p JOIN jobs pj ON pj.id = p."jobId" JOIN services ps ON ps.id = pj."departmentId" AND ps.kind <> 'FOLDING'
          JOIN job_items c ON c."sourceJobItemId" = p.id JOIN jobs cj ON cj.id = c."jobId" AND cj.status <> 'REJECTED'
          GROUP BY p.id HAVING SUM(c.meters) > p.meters + ${T}`,
  },
  {
    id: 'JOB-04', severity: 'MEDIUM', title: 'a job made after the Receive / Accept flow (2026-10-18) lacks the stamps of the steps before its status',
    sql: `SELECT id, "jobNo", status, "receivedAt" IS NOT NULL AS received, "acceptedAt" IS NOT NULL AS accepted FROM jobs
          WHERE "createdAt" >= '2026-10-18' AND ((status IN ('PENDING', 'PROCESSING', 'COMPLETE') AND ("receivedAt" IS NULL OR "acceptedAt" IS NULL)) OR (status = 'QUEUE' AND "receivedAt" IS NULL))`,
  },
  {
    id: 'JOB-05', severity: 'MEDIUM', title: 'a process-department job made after 2026-10-20 was sent on without operator or process date',
    sql: `SELECT j.id, j."jobNo", s.name AS department, j."operatorName", j."processDate" FROM jobs j JOIN services s ON s.id = j."departmentId" AND s.kind = 'PROCESS'
          WHERE (j."operatorName" IS NULL OR j."processDate" IS NULL) AND j."createdAt" >= '2026-10-20'
            AND EXISTS (SELECT 1 FROM job_items p JOIN job_items c ON c."sourceJobItemId" = p.id JOIN jobs cj ON cj.id = c."jobId" AND cj.status <> 'REJECTED' WHERE p."jobId" = j.id)`,
  },
  {
    id: 'JOB-06', severity: 'HIGH', title: 'SO card status does not match its jobs',
    sql: `SELECT sc.id, sc."cardNo", sc.status, sc."currentDepartmentId" IS NOT NULL AS has_dept,
                 EXISTS (SELECT 1 FROM job_items ji WHERE ji."soCardId" = sc.id) AS has_jobs
          FROM so_cards sc WHERE sc."deletedAt" IS NULL AND ((sc.status = 'NEW' AND EXISTS (SELECT 1 FROM job_items ji WHERE ji."soCardId" = sc.id))
            OR (sc.status <> 'NEW' AND sc."currentDepartmentId" IS NULL))`,
  },

  // ---------------- FOLDING and PACKING ----------------
  {
    id: 'PACK-01', severity: 'CRITICAL', title: 'packing lists hold more cloth than Packing received for the SO card',
    sql: `SELECT p."soCardId", sc."cardNo", SUM(pl.meters)::float AS packed, r.received::float AS received_at_packing
          FROM packing_lists p JOIN packing_list_lines pl ON pl."packingListId" = p.id JOIN so_cards sc ON sc.id = p."soCardId" AND NOT sc."isGreyReturn"
          LEFT JOIN (SELECT ji."soCardId", SUM(ji.meters) received FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status NOT IN ('REJECTED', 'IN_WAY', 'QUEUE')
                     JOIN services s ON s.id = j."departmentId" AND s.kind = 'PACKING' GROUP BY 1) r ON r."soCardId" = p."soCardId"
          GROUP BY p."soCardId", sc."cardNo", r.received HAVING SUM(pl.meters) > COALESCE(r.received, 0) + ${T}`,
  },
  {
    id: 'PACK-02', severity: 'CRITICAL', title: 'a fabric return packing list holds more than the cloth that came back',
    sql: `SELECT p."soCardId", sc."cardNo", SUM(pl.meters)::float AS packed, sc."totalMeters"::float AS card
          FROM packing_lists p JOIN packing_list_lines pl ON pl."packingListId" = p.id JOIN so_cards sc ON sc.id = p."soCardId"
          WHERE sc."isGreyReturn" GROUP BY p."soCardId", sc."cardNo", sc."totalMeters" HAVING SUM(pl.meters) > sc."totalMeters" + ${T}`,
  },
  {
    id: 'PACK-03', severity: 'HIGH', title: 'a final packing list without lines, or a gate pass on a draft list',
    sql: `SELECT p.id, p."listNo", p.status, (SELECT count(*) FROM packing_list_lines x WHERE x."packingListId" = p.id)::int AS lines, g.id AS gate_pass
          FROM packing_lists p LEFT JOIN gate_passes g ON g."packingListId" = p.id
          WHERE (p.status = 'FINAL' AND NOT EXISTS (SELECT 1 FROM packing_list_lines x WHERE x."packingListId" = p.id)) OR (p.status = 'DRAFT' AND g.id IS NOT NULL)`,
  },
  {
    id: 'PACK-04', severity: 'HIGH', title: 'a thaan is on two packing lists in the same grade',
    sql: `SELECT pl."thaanId", pl.grade, COUNT(*)::int AS times FROM packing_list_lines pl WHERE pl."thaanId" IS NOT NULL GROUP BY pl."thaanId", pl.grade HAVING COUNT(*) > 1`,
  },
  {
    id: 'PACK-05', severity: 'MEDIUM', title: 'folding sent more than it graded',
    sql: `SELECT id, "jobId", "soCardId", "aMeters"::float, "sentA"::float, "bMeters"::float, "sentB"::float, "cpMeters"::float, "sentCP"::float FROM folding_lines
          WHERE "sentA" > "aMeters" OR "sentB" > "bMeters" OR "sentCP" > "cpMeters"`,
  },

  // ---------------- NUMBERS and ACCESS ----------------
  {
    id: 'NUM-01', severity: 'HIGH', title: 'a numbering counter is behind the highest used number (the next entry would collide)',
    sql: `SELECT c."companyId", c.name, c."nextValue", m.mx FROM company_counters c JOIN (
            SELECT "companyId", 'so_card_no' AS name, MAX("cardNo") mx FROM so_cards WHERE NOT "isGreyReturn" GROUP BY 1
            UNION ALL SELECT "companyId", 'fabric_return_card_no', MAX("cardNo") FROM so_cards WHERE "isGreyReturn" GROUP BY 1
            UNION ALL SELECT "companyId", 'grey_lot_no', MAX("lotNo") FROM grey_lots GROUP BY 1
            UNION ALL SELECT "companyId", 'job_no', MAX("jobNo") FROM jobs GROUP BY 1
            UNION ALL SELECT "companyId", 'packing_list_no', MAX("listNo") FROM packing_lists GROUP BY 1
            UNION ALL SELECT "companyId", 'gate_pass_no', MAX("gatePassNo") FROM gate_passes GROUP BY 1
            UNION ALL SELECT "companyId", 'chemical_request_no', MAX("reqNo") FROM chemical_requests GROUP BY 1
          ) m ON m."companyId" = c."companyId" AND m.name = c.name WHERE c."nextValue" <= m.mx`,
  },
  {
    id: 'NUM-02', severity: 'HIGH', title: 'duplicate numbers inside a company',
    sql: `SELECT 'job' AS kind, "companyId", "jobNo" AS no, COUNT(*)::int FROM jobs GROUP BY 2, 3 HAVING COUNT(*) > 1
          UNION ALL SELECT 'lot', "companyId", "lotNo", COUNT(*)::int FROM grey_lots GROUP BY 2, 3 HAVING COUNT(*) > 1
          UNION ALL SELECT 'so', "companyId", "cardNo", COUNT(*)::int FROM so_cards WHERE NOT "isGreyReturn" GROUP BY 2, 3 HAVING COUNT(*) > 1
          UNION ALL SELECT 'packing list', "companyId", "listNo", COUNT(*)::int FROM packing_lists GROUP BY 2, 3 HAVING COUNT(*) > 1`,
  },
  {
    id: 'ACC-01', severity: 'HIGH', title: 'a user holds a service the company does not have',
    sql: `SELECT us."userId", u.email, s.code FROM user_services us JOIN users u ON u.id = us."userId" AND u."deletedAt" IS NULL JOIN services s ON s.id = us."serviceId"
          WHERE NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = u."companyId" AND cs."serviceId" = us."serviceId")`,
  },
  {
    id: 'ACC-02', severity: 'MEDIUM', title: 'a company with employees but no active client admin (they are locked out)',
    sql: `SELECT c.id, c.name, (SELECT count(*) FROM users u WHERE u."companyId" = c.id AND u."userType" = 'USER' AND u."deletedAt" IS NULL)::int AS employees
          FROM companies c WHERE c."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM users a WHERE a."companyId" = c.id AND a."userType" = 'CLIENT_ADMIN' AND a."isActive" AND a."deletedAt" IS NULL)
            AND EXISTS (SELECT 1 FROM users u WHERE u."companyId" = c.id AND u."userType" = 'USER' AND u."deletedAt" IS NULL)`,
  },
  {
    id: 'ACC-03', severity: 'MEDIUM', title: 'a report service or REPORT kind with FULL access given to a user (reports are read only)',
    sql: `SELECT us."userId", s.code, us.access FROM user_services us JOIN services s ON s.id = us."serviceId" WHERE s.kind = 'REPORT' AND us.access <> 'VIEW'`,
  },
];
