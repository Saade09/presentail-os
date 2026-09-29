# Physical Stock Events Implementation Report

## Scope and ledger

Physical on-hand changes are recorded in `base_item_stock_adjustments` with
`ledger_scope = 'base_item_operational'`. The generic `inventory_movements`
analytics/costing store is deliberately not used to calculate Base Item
on-hand balances.

The implemented physical event types are:

- purchase receipt (`purchase_order_receipt`)
- same-country transfer (`transfer_out` and `transfer_in`)
- manual increase/decrease (`manual_adjustment`)
- waste or damage (`waste_damage`)
- count correction (`inventory_count_correction`)
- usable customer return (`customer_return`)
- supplier return (`supplier_return`)
- recipe use (`product_consumption`)
- cancellation compensation (`order_cancellation`)

The ledger service validates movement direction for types with a fixed
direction. Manual adjustments, count corrections, and generic reversals remain
signed because either direction is intentional for those types.

## Verified physical fulfilment event

Recipe consumption is posted when an order enters `ready_for_delivery`.

Evidence:

1. The florist completion route permits completion only after the florist
   assignment is in progress/paused and its card, photo verification, and Slack
   evidence gates have passed.
2. That route atomically marks the physical florist assignment `completed` and
   then moves the parent order through the canonical status-transition service
   to `ready_for_delivery`.
3. The assignment stores `location_id`, which identifies the branch that
   physically prepared the order. Consumption resolves this location first and
   uses `orders.location_id` only when there is no florist assignment.
4. The dedicated order-status route and the general order edit route also use
   the same canonical status-transition service, so an authorized manual
   transition to `ready_for_delivery` follows the same posting rules.

`out_for_delivery` is not the preparation event. Tookan assignment-family
updates use it to describe dispatch. `completed` is also excluded because
Tookan uses it for successful delivery. Waiting for either would delay the
physical deduction beyond preparation and could select delivery state rather
than the actual florist branch.

A monotonic `inventory_fulfillment_cycle` on each order gives every entry into
`ready_for_delivery` a stable event identity. Replayed updates in one cycle
reuse the same movement keys; a cancelled and later re-fulfilled order uses a
new cycle.

## Recipe calculation and location evidence

At the physical event, every tracked order line is expanded from its recipe:

`ordered line quantity × recipe quantity = canonical Base Item quantity`

Multi-quantity and multi-ingredient lines create one movement per Base Item.
The movement stores the product, line item, ordered quantity, ingredient
quantity, canonical unit, calculated canonical quantity, event cycle, and
human-readable calculation. This snapshot is immutable audit evidence.

Retries for an existing ingredient use the captured calculation rather than
recalculating history from mutable order or recipe values. The current Base
Item, recipe, unit, location, and ledger baseline are still revalidated. If the
order quantity, recipe quantity, or canonical unit changed after fulfilment,
the retry remains open as an integrity exception instead of rewriting the past.

A `MISSING_RECIPE` event cannot contain an ingredient snapshot that did not
exist. After an operator corrects that data, retry applies every ingredient in
the corrected recipe while retaining the original event cycle and original
ordered line quantity.

## Idempotency and transaction boundaries

Client-originated physical commands require UUID action identities:

- `adjustment_action_id`
- `transfer_action_id`
- `receive_action_id`
- wastage `actionId`

Transaction-scoped advisory locks serialize action reuse where the movement is
the idempotency anchor. Canonical payload hashes distinguish a safe replay from
a reused action with changed data; changed payloads return `409`.

All stock-changing routes enforce their existing workspace mutation
permissions. Wastage requires owner access or `base_items.manage`, and its
immutable ledger actor is always the authenticated user; an optional
responsible-employee field cannot replace or spoof that actor.

Purchase receipts lock and revalidate the purchase order inside the same
transaction as the receipt claim, counter update, conversion, and stock
movement. A concurrent cancellation cannot pass a stale preflight check.
Supplier package quantity is snapshotted on the PO line and is multiplied once
to obtain canonical units.

Transfers claim a payload-hashed action, validate both locations and their
countries, lock stock, and append linked outbound/inbound rows in one
transaction. A failure rolls back both sides. The pair has zero consolidated
effect.

## Existing negative-stock behavior

The existing workspace setting `inventory_allow_negative_stock` is preserved:

- When false or absent, the ledger service rejects a movement whose resulting
  location stock would be below zero.
- When true, the same movement is allowed and the negative balance is recorded.

No new negative-stock policy was invented. The setting is read by manual
decreases, count corrections, waste/damage, supplier returns, transfers,
purchase receipts, recipe consumption, and authorized consumption retries.
Positive receipt/return/reversal paths do not need an exception to this rule,
but still use the same service. Transfer validation and both transfer rows
remain atomic under either setting.

## Durable exceptions and authorized retry

Failures that prevent safe recipe posting create
`recipe_consumption_exceptions` rows in the same transaction as the fulfilment
transition. Covered reasons include:

- missing physical location
- missing recipe or Base Item data
- missing ledger baseline
- insufficient stock under the workspace policy
- unsupported unit change/conversion
- other integrity failures

Each row is unique by workspace and immutable consumption idempotency key, so a
new fulfilment cycle cannot collide with a resolved earlier cycle. The original
source snapshot is never replaced. Every retry appends timestamped outcome
details to `attempt_history`.

Workspace-scoped endpoints provide list, detail, and retry operations. Owners
and users with `base_items.view` can review; retry requires owner access or
`base_items.manage`. Retry locks the exception, revalidates corrected data,
reuses the original event identity, and marks it resolved only after the
expected movement or full corrected multi-ingredient set exists.

An exception persistence failure is not swallowed: the enclosing status
transaction rolls back, preventing an event from being lost without either a
movement or a review record. Normal inventory integrity failures do not block
the customer workflow after their review item is durable.

## Cancellation and reversal

Cancelling before any consumption creates no stock movement. Cancelling after
consumption appends one positive compensating movement for every outstanding
consumption row at that row's original location. Reversal rows link to their
original movements, and duplicate cancellation/retry attempts cannot append a
second reversal. Original consumption audit rows are never deleted or edited.

## Validation coverage

Database-backed coverage verifies:

- receipt package conversion, counters, audit metadata, replay/conflict, and
  cancellation/status locking
- manual movement taxonomy, reason/direction requirements, returns,
  idempotency, per-location balances, and negative-stock behavior
- atomic linked transfers, same-country enforcement, retry conflict handling,
  per-location effects, and consolidated neutrality
- wastage posting, canonical units, negative stock, and concurrent changed
  payload reuse
- recipe multi-quantity and multi-ingredient math, location precedence,
  immutable snapshots, event cycles, negative-stock policy, and idempotency
- durable exception isolation/permissions/history, corrected multi-ingredient
  retry, changed historical data rejection, and reconciliation
- cancellation before/after consumption, exactly-once reversal, and full
  fulfilment-cancellation cycles

## Intentionally unchanged and unresolved cases

- Recipe consumption remains controlled by
  `inventory_recipe_consumption_enabled`, whose default is false. This work does
  not enable it for any live workspace.
- No historical consumption is backfilled. Old orders whose recipe, package
  conversion, status event, or fulfilment location cannot be proven remain
  untouched.
- Exceptions caused by post-fulfilment recipe, quantity, or canonical-unit
  edits intentionally remain open until an authorized operator restores or
  otherwise corrects the conflicting source data. The system does not guess a
  conversion or silently adopt a new historical quantity.
- Cross-country transfers remain unsupported.
- Reservations and availability calculations remain separate from physical
  stock and were not added to this ledger.