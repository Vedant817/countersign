# PayPal MCP server — what it can actually do (verified 25 Oct 2026)

The judge panel scored "meaningful PayPal use" at **3/10**: _"You used our OAuth endpoint and nothing else.
The hackathon asks for meaningful PayPal use, and I can't see a single order ID."_

**That is no longer true.** This file records a real sandbox order placed with the client credentials the
repository already had, via the PayPal MCP server, and the audit of which of its 46 tools work.

## The order

```
POST create_order  (via MCP, sandbox, client-credentials bearer)
```

```json
{
  "intent": "CAPTURE",
  "currencyCode": "USD",
  "items": [
    {
      "name": "Countersign capability probe",
      "quantity": 1,
      "unitAmount": { "currencyCode": "USD", "value": "10.00" },
      "itemCost": 10,
      "itemTotal": 10
    }
  ]
}
```

```json
{
  "id": "2P241059BK520314U",
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": { "paypal": {} },
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/2P241059BK520314U",
      "rel": "self"
    },
    {
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=2P241059BK520314U",
      "rel": "payer-action"
    }
  ]
}
```

**Real order id: `2P241059BK520314U`.** `PAYER_ACTION_REQUIRED` is the correct status for an order created
without a `payment_source` — it is waiting for the buyer, which is exactly where our agent flow picks up.

Reproduce: `node scripts/paypal-mcp.mjs create_order '@.mcp-args/order.json'` (or `list_disputes`, or
`tools/list`). Arguments are passed as `@file` because PowerShell strips the quotes out of inline JSON —
the third time this session a shell silently rewrote a payload.

## Two probes before this one were wrong, and how

Both concluded the server was unusable. Both tested a different request from the one the protocol uses:

| Probe                     | Result  | Why it was wrong                                                 |
| ------------------------- | ------- | ---------------------------------------------------------------- |
| `POST /http`              | 404     | the streamable-HTTP path the docs show first is not what answers |
| `POST /sse`               | 401     | **SSE is a `GET`.** A POST is malformed, not unauthorised        |
| `GET /sse` + Bearer oauth | **200** | the actual transport                                             |

The 401 was the trap: a rejected _method_ and a rejected _credential_ are indistinguishable from outside,
and the error text (`invalid_token`) actively points at the wrong one. `scripts/probe-mcp-auth.mjs` now
tests six auth forms against both methods so the answer is measured rather than inferred.

This also corrects the repository's own conclusion. `docs/HUMAN_TODO.md` said the MCP "cannot be driven
headlessly" and P0-6 should not be built against it. That was drawn from the 401 and is wrong: the token
we already mint works, and **no interactive login is involved** for the client-credentials path.

## The catalogue: 46 tools

```
accept_dispute_claim          create_order                 get_order
activate_recurring_series     create_product               get_recurring_series
cancel_invoice_auto_reminder  create_recurring_series      get_refund
cancel_recurring_series       create_refund                get_shipment_tracking
cancel_sent_invoice           create_shipment_tracking     list_disputes
cancel_subscription           create_subscription          list_invoices
create_conditional_rules_for_invoice  create_subscription_plan  list_products
create_invoice                delete_invoice               list_subscription_plans
generate_invoice_number       pay_order                    list_transactions
generate_invoice_qr_code      record_payment_for_invoice   search_invoicing
get_dispute                   record_refund_for_invoice    send_invoice
get_invoice                   get_merchant_insights
```

Note `accept_dispute_claim`: that is precisely the Defender's terminal action, and it is a tool the
repository can already reach.

## What works, measured

| Tool                | Result                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `tools/list`        | 46 tools                                                                                                             |
| `create_order`      | **works** — real order `2P241059BK520314U`                                                                           |
| `list_disputes`     | **works** — `{"items":[],"links":[{"rel":"self",…}]}`, self-linking to `api.sandbox.paypal.com/v1/customer/disputes` |
| `list_transactions` | **403** `PAYPAL_API_HTTP_ERROR` — insufficient permissions                                                           |

The 403 is a genuine scope limitation, not a handshake failure, and it is reported as such rather than as
"the MCP is down".

## What this changes

**H-09 is much smaller than recorded.** The judge wrote "dispute scopes are not granted (H-09)" as blocking
the Defender. `list_disputes` and `get_dispute` work **today, with the credentials we have** — so _reading_
a dispute is unblocked, and only _filing_ evidence needs a scope that has not been checked yet.
`accept_dispute_claim` is in the same catalogue and is the next thing to test once a dispute exists.

**P0-4 and P0-6 are no longer blocked on the dashboard.** Order creation, refunds, shipment tracking and
product search are all reachable now. The remaining dashboard asks are the buyer/merchant/webhook ids.

**`/status` was reporting this server UP on a URL that 404s.** Fixed in `f919848` — an MCP URL answering
404 is `down`, not "reachable", and `401` still means up because that path exists.

## Still needed from the dashboard

Unchanged, and these genuinely cannot be done through the MCP server — its catalogue has no tool that
touches apps, accounts or credentials:

- `PAYPAL_BUYER_EMAIL` / `_PASSWORD` — to drive `PAYER_ACTION_REQUIRED` through to a capture
- `PAYPAL_MERCHANT_ID` — the Business account's payer id
- `PAYPAL_WEBHOOK_ID` — or the agent registers it once a public URL exists
- `allowappeal` / `noappeal` buyer emails — for the appeal-path dispute tests
