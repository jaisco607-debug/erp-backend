'use strict';
// Accounting engine (owner 2026-10-24): the journal. Every invoice / voucher posts ONE journal entry made of lines;
// the General Ledger and the Trial Balance are always worked out from these lines, never from saved totals.
//   journal_entries   the header: number, date, where it came from (sourceType + sourceId), POSTED or REVERSED
//   journal_lines     account + debit OR credit (never both) + the party (customer / vendor) when the account is a control account
// Safety is in the database too, not only in the code:
//   - a posted line is never changed or deleted (a mistake is corrected by a reversal entry: the same lines the other way round)
//   - at commit time the lines of an entry must add up: debit = credit (a deferred constraint trigger)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE journal_entries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "entryNo" integer NOT NULL,
          "entryDate" date NOT NULL,
          "sourceType" varchar(30) NOT NULL,
          "sourceId" uuid,
          narration varchar(300),
          status varchar(10) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
          "reversalOfId" uuid REFERENCES journal_entries (id),
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "entryNo")
        )`);
      await q('CREATE INDEX journal_entries_source ON journal_entries ("companyId", "sourceType", "sourceId")');
      await q('CREATE INDEX journal_entries_date ON journal_entries ("companyId", "entryDate")');
      // an entry is reversed at most once
      await q('CREATE UNIQUE INDEX journal_entries_one_reversal ON journal_entries ("reversalOfId") WHERE "reversalOfId" IS NOT NULL');
      await q(`
        CREATE TABLE journal_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "entryId" uuid NOT NULL REFERENCES journal_entries (id),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          "accountId" uuid NOT NULL REFERENCES accounts (id),
          debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
          credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
          "partyType" varchar(10) CHECK ("partyType" IN ('CUSTOMER', 'VENDOR')),
          "partyId" uuid,
          narration varchar(300),
          CONSTRAINT journal_lines_one_side CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
          CONSTRAINT journal_lines_party_pair CHECK (("partyType" IS NULL) = ("partyId" IS NULL))
        )`);
      await q('CREATE INDEX journal_lines_entry ON journal_lines ("entryId")');
      await q('CREATE INDEX journal_lines_account ON journal_lines ("accountId")');
      await q('CREATE INDEX journal_lines_party ON journal_lines ("companyId", "partyType", "partyId")');

      // a posted line never changes
      await q(`
        CREATE FUNCTION journal_lines_frozen() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'Posted journal lines cannot be changed or deleted; post a reversal entry instead'; END
        $$ LANGUAGE plpgsql`);
      await q('CREATE TRIGGER journal_lines_no_update_delete BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_frozen()');

      // an entry never changes either; the only allowed step is POSTED -> REVERSED (when its reversal is posted)
      await q(`
        CREATE FUNCTION journal_entries_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A journal entry cannot be deleted; post a reversal entry instead'; END IF;
          IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
             AND NEW.id = OLD.id AND NEW."companyId" = OLD."companyId" AND NEW."entryNo" = OLD."entryNo" AND NEW."entryDate" = OLD."entryDate"
             AND NEW."sourceType" = OLD."sourceType" AND NEW."sourceId" IS NOT DISTINCT FROM OLD."sourceId"
             AND NEW."reversalOfId" IS NOT DISTINCT FROM OLD."reversalOfId" AND NEW.narration IS NOT DISTINCT FROM OLD.narration THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'A posted journal entry cannot be changed; post a reversal entry instead';
        END
        $$ LANGUAGE plpgsql`);
      await q('CREATE TRIGGER journal_entries_no_change BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_guard()');

      // at commit: debit = credit for every entry that got lines in this transaction
      await q(`
        CREATE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
        DECLARE d numeric; c numeric;
        BEGIN
          SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) INTO d, c FROM journal_lines WHERE "entryId" = NEW."entryId";
          IF d <> c THEN RAISE EXCEPTION 'Journal entry is not balanced: debit % and credit %', d, c; END IF;
          RETURN NULL;
        END
        $$ LANGUAGE plpgsql`);
      await q(`CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
               DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced()`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE journal_lines');
      await q('DROP TABLE journal_entries');
      await q('DROP FUNCTION journal_lines_frozen()');
      await q('DROP FUNCTION journal_entries_guard()');
      await q('DROP FUNCTION journal_entry_balanced()');
    });
  },
};
