# NexusERP-AI S06 - Finance: payments, customer wallet, supplier payments, ledger

- **Scenario id / name:** S06 / Finance: payments, customer wallet, supplier payments, ledger
- **Role / user:** fin1, crm1, proc1, admin (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Clean seed.
  - Customer 'S06 Cust' and supplier 'S06 Supplier' exist; one invoiced order PO-S06-001 (qty 10 x 450, VAT 14% = 5,130) can be produced by running S03 steps 1-12 with S06 names.
- **Test data:**
  - Advance deposit 5,000 ref ADV-1
  - Customer payment 2,000 then 3,130
  - Supplier payment 100, PO PO-X, ref TRX1
  - Manual ledger entry: 'Manual journal' 250 debit account Cash
- **Live verification note:** Verified live 2026-10-15 (API): steps 2,3,8,9,10 (outputs as written). Steps 4-7 and 11-13 rely on code paths read in server.js/FinanceModule and were not executed or rendered here.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | As crm1/fin1 open Customer Accounts & Wallets (Finance) and select 'S06 Cust'. | Customer wallet shows balance 0.00. | 1 |
| 2 | Record advance payment 5,000 ref ADV-1 note 'deposit'. (API POST /api/v1/customers/:id/advance-payment) | Wallet balance 5,000; log 'Advance Payment Recorded: 5,000 L.E.'. | 1 |
| 3 | Open project wallets (API GET /api/v1/project-wallets). | One entry '(General Advance / Future Orders)' balance 5000 with the customer listed. | 1 |
| 4 | Open invoiced order PO-S06-001 in Finance and record payment 2,000.00 using 'Apply from Customer Wallet'. | Wallet decreases by 2,000 to 3,000; payment recorded with a receipt number. | 1 |
| 5 | Record payment 3,130.00 (cash). | Total paid 5,130 equals invoice total; order fully paid (status moves to WAITING_GOVE when delivered). | 1 |
| 6 | Generate the payment receipt PDF for the first payment. | A PDF named Receipt-<order>-<receipt>.pdf downloads with customer, amount and previous payments. | 1 |
| 7 | Cancel the 3,130 payment with a reason (cancel-payment). | Payment removed; balance due 3,130 again; log entry for cancellation. | 1 |
| 8 | As proc1/fin1 record a supplier payment: supplier 'S06 Supplier', amount 100, PO PO-X, ref TRX1. (API POST /api/v1/supplierPayments) | Payment saved with unallocatedAdvance 100 (no matching PO yet). | 1 |
| 9 | Open the supplier ledger (API GET /api/v1/supplier-ledger/:supplierId). | Summary shows totalPaid 100 and balance -100 (advance in favour of the company). | 1 |
| 10 | Add a manual journal entry in General Ledger: 'Manual journal', 250, debit, Cash. (API POST /api/v1/ledger) | Entry appears in the ledger list with an id `ledger_<ts>`. | 1 |
| 11 | Open the General Ledger balance sheet dashboard. | Assets and Liabilities+Equity sections are displayed and the variance indicator is zero for the seeded data. | 1 |
| 12 | Search Finance order list with the keyword 'non-project'. | Only orders without a project name are listed. | 1 |
| 13 | Expand all order cards (Expand All). | All cards open; Collapse All closes them. | 1 |
| 14 | Open the Finance order list filter 'Unpaid'. | Only orders with a balance due are listed. | 1 |
| 15 | Reload the page and reopen the customer wallet. | Wallet balance persists (server state). | 1 |
