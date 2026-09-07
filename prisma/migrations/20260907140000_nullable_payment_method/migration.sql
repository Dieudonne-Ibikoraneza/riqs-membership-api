-- payment_method is now optional: a system-generated Unpaid invoice (upgrade fee, auto-generated
-- Annual Renewal, stamp fee) has no payment method until someone actually attempts to pay it.
-- Previously every such row was forced to claim 'Bank_Transfer' before any money had moved.
ALTER TABLE "financial_transactions" ALTER COLUMN "payment_method" DROP NOT NULL;

-- Clear the fabricated placeholder value off every row that was never actually paid — these
-- never had a real payment method, they just had to satisfy the old NOT NULL constraint.
UPDATE "financial_transactions"
SET "payment_method" = NULL
WHERE "status" = 'Unpaid';
