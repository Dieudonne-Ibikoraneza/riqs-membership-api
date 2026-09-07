-- Generalize PaymentMethod's MTN_Momo value to a network-agnostic Mobile_Money — it was
-- wrongly assumed to always mean "MTN specifically" both for gateway payments (IntouchPay can
-- settle via MTN or Airtel Money) and for manual MoMo-code payments (the member could have sent
-- from either network). Renaming the enum value preserves every existing row's data as-is.
ALTER TYPE "PaymentMethod" RENAME VALUE 'MTN_Momo' TO 'Mobile_Money';
