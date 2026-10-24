# UrubutoPay staging frontend verification

Verified on 23 October 2026 (Africa/Kigali).

The member submitted a First Year Fee request through the local frontend. The dialog moved to waiting for phone confirmation and then displayed Payment not completed. Backend persistence and a direct provider status lookup both report FAILED.

- Environment: staging
- Amount: 200000 RWF
- Phone: documentation example 250795601005 (confirmed in provider response)
- Merchant transaction reference: FYF-40e1532b-1792785480001
- UrubutoPay internal reference: 33202610232158008048
- Mobile money provider reference: undefined
- Payment timestamp returned by provider: 23/10/2026 21:58:00
- Lookup HTTP status: 200
- API status: 200
- Payment status: FAILED
- Provider failure reason: absent from the status response

## Support question

Please investigate the provider reference above and confirm the reason for failure, supported staging test wallets and amounts, and whether wallet approval is required for this test number. Wallet validation for the original frontend test number returned valid: true, but this does not establish available funds or payment approval.

## Frontend corrections verified

Gateway failures now display Mobile Money payment failure instead of incorrectly reporting rejected receipt documentation. Pending gateway payments are distinguished from administrative review. Closing the payment dialog refreshes payment history.

Frontend TypeScript validation passed. Strict ESLint still reports existing explicit-any issues on the payments page; with that existing rule suppressed for the focused check, there are no errors and two existing unused-variable warnings.

A completed payment has not been verified. No support message was sent and no paid status was forced.
