-- A single, inclusive "not through our gateway" payment method, replacing the short-lived
-- member-facing "how did you pay?" method picker (Mobile_Money/Bank_Transfer/Manual_Cash) for
-- manually-uploaded proof of payment — that distinction wasn't worth asking the member for.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'Manual_Payment';
