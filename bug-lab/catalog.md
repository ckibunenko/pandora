# Bug Lab defect catalog

| ID | Title | Area | Severity | Business rule broken | Reproduction prerequisite |
|---|---|---|---|---|---|
| `BUG-001` | Fully shipped order stays partially shipped | Fulfillment: order status | High: the order never reaches its final state, and reports and follow-up actions are wrong | Overview §5: when nothing is outstanding and nothing was cancelled, the status is `shipped` | At least two shipments on one order and no cancelled quantities |
| `BUG-002` | Page 2 of the order list repeats an order and displaces the boundary order | Orders list: pagination | Medium: every page boundary shows a duplicate. When the total is an exact multiple of the page size, the final order cannot be reached | Overview §7: pages partition the filtered, stably sorted list, so every order appears exactly once | At least 41 orders visible to the viewer, page size 20, default sort |
| `BUG-003` | Submitted order shows current catalog prices | Order detail: price snapshot | High: customers and staff see prices that were never agreed, and the page contradicts its own total | Overview §4: submission freezes unit prices, line totals, and the order total, and later catalog edits never change them | Submit an order, change that SKU's catalog price, reopen the order |

Every defect exists only in a database prepared by `pnpm bug-lab setup` and an API started with the matching `BUG_LAB_DEFECT`. Learner briefs are in `briefs/`; solutions are in `solutions/`.
