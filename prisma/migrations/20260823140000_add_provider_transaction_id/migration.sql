-- Correlates a FinancialTransaction with the payment-gateway (IntouchPay) request
-- that was made for it, so the async callback (and the status-poll fallback) can
-- look the row up and drive it to Cleared/Failed automatically.
ALTER TABLE "financial_transactions"
  ADD COLUMN "provider_transaction_id" VARCHAR(100);

CREATE UNIQUE INDEX "financial_transactions_provider_transaction_id_key"
  ON "financial_transactions" ("provider_transaction_id");
