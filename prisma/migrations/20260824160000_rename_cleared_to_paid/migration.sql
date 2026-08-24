-- The gateway-driven flow means transactions are now confirmed by the member's own
-- payment, not "cleared" by an admin acting on their behalf. Renaming the enum value
-- in place preserves every existing row's meaning exactly (Cleared rows become Paid).
ALTER TYPE "TransactionStatus" RENAME VALUE 'Cleared' TO 'Paid';
