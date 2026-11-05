// One-time move of the OLD per-account opening balances (accounts.openingBalance / openingSide) into ONE opening journal entry per company.
//
//   node scripts/migrate-opening-balances.js                          dry run (the default): only prints what would be done
//   node scripts/migrate-opening-balances.js --apply --date=2026-07-01   does it
//   options:  --company=<company id>   only this company
//
// Nothing is changed in a dry run. With --apply a company is moved only when it is safe:
//   - it has no opening entry yet and no other entry in the books (the opening balances are locked after that)
//   - it has something to move
//   - the amounts balance, or the company has an Opening Balance Equity system account to take the difference
//   - no income / expense opening balance (not allowed when the books start on the first day of the fiscal year)
//   - Accounts Receivable / Payable with customers / vendors need an amount per customer: those are listed, not moved
// The old fields are left as they are (readable); running the script again skips the companies already moved.
const { sequelize } = require('../src/models');
const opening = require('../src/services/openingBalanceService');
const accountService = require('../src/services/accountService');

const { toCents, fromCents } = accountService.internals;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const apply = Boolean(args.apply);
const q = (sql, bind) => sequelize.query(sql, { bind }).then(([rows]) => rows);

(async () => {
  if (apply && !/^\d{4}-\d{2}-\d{2}$/.test(args.date || '')) {
    console.error('--apply needs the day the books start: --date=YYYY-MM-DD');
    process.exit(2);
  }
  console.log(apply ? `APPLY: opening date ${args.date}` : 'DRY RUN: nothing is changed (add --apply --date=YYYY-MM-DD to do it)');

  const companies = await q(`SELECT DISTINCT c.id, c.name FROM companies c JOIN accounts a ON a."companyId" = c.id WHERE a."openingBalance" <> 0 AND c."deletedAt" IS NULL
    ${args.company ? 'AND c.id = $1' : ''} ORDER BY c.name`, args.company ? [args.company] : []);
  if (!companies.length) console.log('No account has an old opening balance. Nothing to do.');

  let moved = 0;
  for (const c of companies) {
    console.log(`\n== ${c.name} (${c.id})`);
    const [existing] = await q(`SELECT 1 FROM journal_entries WHERE "companyId" = $1 AND "sourceType" = 'OPENING' AND "reversalOfId" IS NULL AND status = 'POSTED' LIMIT 1`, [c.id]);
    if (existing) { console.log('   skipped: it already has an opening entry'); continue; }
    const [others] = await q(`SELECT count(*)::int AS n FROM journal_entries WHERE "companyId" = $1 AND "sourceType" <> 'OPENING'`, [c.id]);
    if (others.n) { console.log('   skipped: other entries exist in the books, the opening balances are locked'); continue; }

    const accounts = await q('SELECT id, code, name, "accountType", "controlType", "isGroup", "openingBalance"::text AS amount, "openingSide" FROM accounts WHERE "companyId" = $1 AND "openingBalance" <> 0 ORDER BY code', [c.id]);
    const [{ customers }] = await q('SELECT count(*)::int AS customers FROM customers WHERE "companyId" = $1 AND "deletedAt" IS NULL', [c.id]);
    const [{ vendors }] = await q('SELECT count(*)::int AS vendors FROM vendors WHERE "companyId" = $1', [c.id]);
    const [{ month }] = await q('SELECT "fiscalYearStartMonth" AS month FROM companies WHERE id = $1', [c.id]);
    const when = args.date || null;
    let debit = 0n;
    let credit = 0n;
    const lines = [];
    const problems = [];
    for (const a of accounts) {
      const cents = toCents(a.amount);
      console.log(`   ${a.code}  ${a.name.padEnd(36)} ${fromCents(cents).padStart(16)}  ${a.openingSide}`);
      if (a.isGroup) { problems.push(`${a.code} is a folder with an opening balance`); continue; }
      if ((a.accountType === 'INCOME' || a.accountType === 'EXPENSE') && when && !opening.plOpeningAllowed(when, month)) problems.push(`${a.code} ${a.name}: income / expense opening balance is not allowed on the first day of the fiscal year`);
      if ((a.controlType === 'CUSTOMERS' && customers) || (a.controlType === 'SUPPLIERS' && vendors)) problems.push(`${a.code} ${a.name}: needs an amount for each ${a.controlType === 'CUSTOMERS' ? 'customer' : 'vendor'}; enter it by hand in the opening balances screen`);
      if (a.openingSide === 'DEBIT') debit += cents; else credit += cents;
      lines.push({ accountId: a.id, amount: fromCents(cents), side: a.openingSide });
    }
    const diff = debit > credit ? debit - credit : credit - debit;
    console.log(`   total debit ${fromCents(debit)}, credit ${fromCents(credit)}${diff ? `, difference ${fromCents(diff)}` : ' (balanced)'}`);
    let balancingAccountId;
    if (diff) {
      const [oe] = await q(`SELECT id, code, name FROM accounts WHERE "companyId" = $1 AND "systemKey" = 'OPENING_BALANCE_EQUITY' AND "isActive"`, [c.id]);
      if (oe) { balancingAccountId = oe.id; console.log(`   the difference goes to ${oe.code} ${oe.name}`); } else problems.push('the amounts do not balance and the company has no Opening Balance Equity account (apply a template first)');
    }
    if (problems.length) { problems.forEach((p) => console.log(`   PROBLEM: ${p}`)); console.log('   skipped'); continue; }
    if (!apply) { console.log('   would be moved'); continue; }

    const req = { user: { id: null, companyId: c.id, userType: 'SYSTEM', email: null }, headers: {} };
    await opening.save(req, { date: args.date, lines, balancingAccountId });
    moved += 1;
    console.log('   MOVED');
  }
  console.log(`\n${apply ? `${moved} company(ies) moved` : 'dry run finished'}.`);
  await sequelize.close();
})().catch(async (e) => {
  console.error(e);
  await sequelize.close();
  process.exit(1);
});
