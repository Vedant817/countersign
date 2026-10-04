# PayPal API facts — verification report for `packages/paypal/`

Date of verification: 2026-10-04. No repository files were read-modified or written; this report is the
only artefact.

## Sources, and how they were read

| Abbreviation | Source                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEC-D`     | `openapi/customer_disputes_v1.json` — https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/customer_disputes_v1.json (identical served copy at https://developer.paypal.com/api/customer-disputes/v1/schema.json, `info.version` **1.12**) |
| `SPEC-P`     | `openapi/payments_payment_v2.json` — https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/payments_payment_v2.json (v **2.12**)                                                                                                            |
| `SPEC-O`     | `openapi/checkout_orders_v2.json` — https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/checkout_orders_v2.json (v **2.32**)                                                                                                              |
| `SPEC-V`     | `openapi/vault_payment_tokens_v3.json` — https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/vault_payment_tokens_v3.json (v **3.4**)                                                                                                     |
| `SPEC-W`     | `openapi/notifications_webhooks_v1.json` — https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/notifications_webhooks_v1.json (v **1.11**)                                                                                                |
| `GUIDE`      | https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api — "Use Disputes API", the only PayPal page that carries worked cURL for every seller dispute action                                                                                       |
| `TGL`        | https://developer.paypal.com/disputes/test-go-live — sandbox simulators                                                                                                                                                                                                    |
| `SETUP`      | https://developer.paypal.com/disputes/set-up — `PayPal-Auth-Assertion`                                                                                                                                                                                                     |
| `FILES`      | https://developer.paypal.com/disputes/supported-file-sizes-types                                                                                                                                                                                                           |
| `IDEMP`      | https://developer.paypal.com/api/rest/reference/idempotency                                                                                                                                                                                                                |
| `REQ`        | https://developer.paypal.com/api/rest/requests                                                                                                                                                                                                                             |
| `EVENTS`     | https://developer.paypal.com/api/rest/webhooks/event-names                                                                                                                                                                                                                 |
| `ERRORS`     | https://developer.paypal.com/api/errors/overview                                                                                                                                                                                                                           |
| `VAULTDOC`   | https://developer.paypal.com/api/save-with-purchase/save-payment-methods                                                                                                                                                                                                   |
| `MCPDOC`     | https://developer.paypal.com/ai-tools/mcp-server                                                                                                                                                                                                                           |
| `SDKJS`      | https://developer.paypal.com/sdk/js/set-up                                                                                                                                                                                                                                 |

A note on method: `developer.paypal.com` pages are server-rendered Next.js and the per-operation
`/api/...` pages are generated _from the same OpenAPI_, so they add no field information beyond the spec.
However the site exposes a plain-text rendering at `<url>.md`, which is how `GUIDE`, `TGL`, `SETUP`,
`FILES`, `IDEMP`, `EVENTS` were read. `GUIDE` and `TGL` are the two pages that materially extend the spec,
and both were decisive.

Where I state "the docs say X" I read it. Where I state "this is consistent with…" that is my inference and
is labelled.

---

# Disputes v1

## 1. `POST /v1/customer/disputes` — the sandbox buyer-dispute simulator

**CONTRADICTS.** Four separate mistakes in the code's assumption, and one of them (the field name) is
exactly the class of bug that is invisible until a judge watches it fail.

Source: `TGL`, section "Simulate buyer actions → Create dispute". **This endpoint is not in `SPEC-D` at all** —
`SPEC-D` declares only `GET` on `/v1/customer/disputes`. It is documented _only_ on the test-go-live page
(and is flagged there as sandbox-only). The API description in `SPEC-D.info.description` says
"create, cancel, compute metrics, change reason, and validate eligibility methods are available as a
limited-release solution… reach out to your PayPal account manager".

- **Content type: `multipart/form-data`**, with one JSON part named `input`. Not a JSON body.
- **The transaction field is `buyer_transaction_id`, nested in a `disputed_transactions` array.**
  There is no `transaction_id`.
- **The reason field is `reason`, not `dispute_reason`.**
- Full documented request (`TGL`, verbatim cURL):

```
curl -X POST https://api-m.sandbox.paypal.com/v1/customer/disputes \
  -H 'Authorization: Bearer ACCESS-TOKEN' \
  -H 'Content-Type: multipart/form-data' \
  -H 'PayPal-Auth-Assertion: AUTH-ASSERTION-JWT' \
  -F 'input={
"disputed_transactions": [{
"buyer_transaction_id": "BUYER-TRANSACTION-ID"
}],
"reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
"dispute_amount": {
"currency_code":"USD",
"value": "20"
},
"extensions": {
"merchant_contacted": true,
"merchant_contacted_outcome": "NO_RESPONSE",
"merchandise_dispute_properties": {
"issue_type": "PRODUCT"
}
}
};type=application/json'
```

- `reason` values are the **`dispute_reason` enum from `SPEC-D`** (see §11) — `TGL` links to "Dispute reasons"
  rather than restating them.
- **Return: `201 Created`** with an HATEOAS link for the dispute. So the code's `Links` return type is
  **right**; only the code path and body are wrong. The client treats any 2xx as success, so 201 is handled.

Against `packages/paypal/src/sandbox.ts:174` (`createBuyerDispute`) and
`packages/paypal/src/types.ts:717` (`simDisputeReqSchema`), which require `transaction_id` and
`dispute_reason` and send `json:`.

## 2. `POST /v1/customer/disputes/{id}/provide-evidence`

**VERIFIED for the transport; CONTRADICTS for the `input` shape and the file field names.**

Source: `GUIDE` "Provide evidence" (worked cURL), `SPEC-D` `paths./v1/customer/disputes/{id}/provide-evidence.post`
and `components.requestBodies.evidences`.

- Content type: `multipart/form-data`. **The `input` part name is correct** — the code's
  `EVIDENCE_INPUT_FIELD = 'input'` is right, and is confirmed by two independent `TGL` endpoints
  (`POST /v1/customer/disputes` and `POST /v1/customer/disputes/{ID}/change-reason`) plus `GUIDE`.
- **The `input` payload is `{ "evidences": [ … ] }` — an array wrapped in `evidences`.** The code's
  `provideEvidenceInputSchema` models a _bare_ `{evidence_type, date, notes[]}` object. That will be rejected.
- Per-evidence fields: `evidence_type`, `evidence_info` (`{tracking_info: [{carrier_name, tracking_number}]}`,
  `refund_ids`), `notes`, `documents`.
- **`notes` is a `string`, not an array.** `SPEC-D` `components.schemas.evidence.properties.notes` is
  `type: string, minLength: 1, maxLength: 2000, pattern: ^(.|\r?\n)*$`, and `GUIDE`'s table labels
  `evidences.notes` as `string`. The code's `notes: z.array(z.string())` is wrong.
- **Default file field names are `file1`, `file2`, …** — `GUIDE`'s cURL uses `-F 'file1=@NewDoc.pdf;type=application/pdf'`.
  The code's `file${index+1}` default is **correct**. The OpenAPI names the file part `evidence-file`
  (singular, hyphenated) but that is not what the guide's example uses; the guide is the better evidence
  for the field name.
- **`evidence_type` enum: 76 values.** All seven the spec claims exist:
  `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `DETAILS_OF_PURCHASE`, `ONLINE_TRACKING_INFORMATION`,
  `ORDER_DETAILS`, `ITEM_DESCRIPTION`, `PROOF_OF_RECEIPT_COPY` — **all present**.
  Nine further values in the code's `EVIDENCE_TYPES` do **not** exist: `CHECKOUT_PAGE`,
  `CANCELLED_RECURING_BILLING_AGREEMENT`, `CUSTOMER_COMMUNICATION`, `FULFILLMENT_DOCUMENTATION`,
  `REFUND_POLICY`, `TERMS_OF_SERVICE`, `UNCONTROLLED_WEB_CONTENT`. See §Action required.
- **`notes` length limit: 2000 characters, and it IS documented** — `SPEC-D`
  `components.schemas.evidence.properties.notes.maxLength = 2000`. Same 2000 cap and pattern on
  `make_offer.note`, `escalate.note`, `accept_offer.note`, `deny_offer.note`, `supporting_info.notes`,
  `message.content`. (`message.content` is `minLength: 0`; the others are `minLength: 1`.)
- Return: `200 OK` with `{ "links": [ … ] }`. **Not `204 No Content`.** The code's `linksSchema` is right,
  and its tolerance of an empty body (`types.ts:100` "204 No Content (TODO)") is unnecessary but harmless.

## 3. `POST /v1/customer/disputes/{id}/accept-claim`

**CONTRADICTS.** Source: `GUIDE` "Accept claim"; `SPEC-D`
`paths./v1/customer/disputes/{id}/accept-claim.post.requestBody` and `components.schemas.accept_claim_type`.

- `GUIDE` shows `Content-Type: application/json` with body `{ "note": "Full refund to the customer." }`.
- `SPEC-D` declares only `multipart/form-data` with one part, `accept-claim-document` (a file).
  **So both encodings are documented; the JSON one is what `GUIDE` demonstrates.**
- **`accept_claim_type` is not in either request body schema.** The operation _description_ says "Allowed
  accept_claim_type values for the request is available in dispute details allowed response options object",
  and `GUIDE` says "To determine which refund types are available … check
  `allowed_response_options.accept_claim.accept_claim_types`". **My inference:** `accept_claim_type` is an
  accepted request field but is missing from the OpenAPI request body. This is the one place in disputes
  where the machine-readable spec is visibly incomplete, so a sandbox probe is the only way to settle it.
- `accept_claim_type` enum (`SPEC-D` `components.schemas.accept_claim_type`):
  `REFUND`, `REFUND_WITH_RETURN`, `PARTIAL_REFUND`, `REFUND_WITH_RETURN_SHIPMENT_LABEL`.
- Return `200 OK` with a `links` array.

## 4. `POST /v1/customer/disputes/{id}/make-offer`

**CONTRADICTS (partly).** Source: `SPEC-D` `components.schemas.make_offer`; `GUIDE` "Make offer to resolve dispute".

- Encodings: `application/json`, `multipart/form-data`, `multipart/related`, `multipart/mixed` — all four
  point at the same `make_offer` schema. JSON is fine.
- Fields: `note` (**required**, 1–2000), `offer_type` (**required**), `offer_amount` (`money`),
  `return_shipping_address` (`address_portable`), `invoice_id` (1–127).
- **`offer_type` enum: `REFUND`, `REFUND_WITH_RETURN`, `REFUND_WITH_REPLACEMENT`, `REPLACEMENT_WITHOUT_REFUND`.**
  The code comment at `types.ts:691` claims `REFUND_WITH_RETURN | REFUND_NO_RETURN`. **`REFUND_NO_RETURN`
  does not exist.** The real non-return variant is `REFUND` / `REPLACEMENT_WITHOUT_REFUND`.
- `GUIDE` confirms `REFUND_WITH_RETURN` requires `return_shipping_address` and `offer_amount`, matching the
  `x-enumDescriptions` in the spec.
- The code's `makeOfferReqSchema` requires `offer_amount`, which the spec does **not** — omit it for
  `REPLACEMENT_WITHOUT_REFUND`. And it omits the required `note` and the optional `return_shipping_address`.
- Return `200 OK` with `links`.

## 5. `POST /v1/customer/disputes/{id}/send-message`

**VERIFIED — the code is right, and the OpenAPI is wrong.**

Source: `GUIDE` "Send message to other party"; `SPEC-D` request body.

- **`GUIDE` documents `{"message": "Shipment is in progress."}` as `application/json`** — so the body field
  _is_ `message` and JSON _is_ accepted. `packages/paypal/src/client.ts:771` matches.
- `GUIDE` also documents the multipart variant: `-F 'input={"message": "…"};type=application/json'`
  plus `-F 'file1=@doc.pdf;type=application/pdf'`.
- `SPEC-D` declares **only** `multipart/form-data` with a `message_document` file part and no text field at
  all. The operation description in `SPEC-D` nonetheless says "specify the message in the JSON request
  body", which is internally inconsistent with its own `requestBody`. `GUIDE` is the better source.
- Return `200 OK` with `links`.

## 6. `POST /v1/customer/disputes/{id}/acknowledge-return-item`

**CONTRADICTS.** Source: `GUIDE` "Acknowledge returned item"; `SPEC-D`
`components.schemas.acknowledgement_type`.

- **JSON**, body `{ "note": "I have received the item back.", "acknowledgement_type": "ITEM_RECEIVED" }`.
- **`return_shipping_address` is not a field of this endpoint.** The code's `ackReturnReqSchema`
  (`types.ts:700`) has `note` + `return_shipping_address`; it should be `note` + `acknowledgement_type`.
  (`return_shipping_address` _is_ real, but on `make-offer`, not here.)
- `acknowledgement_type` enum: `ITEM_RECEIVED`, `ITEM_NOT_RECEIVED`, `DAMAGED`,
  `EMPTY_PACKAGE_OR_DIFFERENT`, `MISSING_ITEMS`.
- Which values are permitted for a given dispute comes from
  `allowed_response_options.acknowledge_return_item.acknowledgement_types`.
- `SPEC-D` request body: `multipart/form-data` with an `acknowledgement_document` file part.
- Return `200 OK` with `links`.

## 7. `POST /v1/customer/disputes/{id}/provide-supporting-info`

**VERIFIED — the code's guess was right, and is now documented.**

Source: `GUIDE` "Provide supporting information".

- **The text field is `notes`, not `message`.**
- **Both encodings are documented.** JSON: `-d '{"notes": "Additional supporting information"}'`.
  Multipart: `-F 'input={"notes": "…"};type=application/json' -F 'file1=@NewDoc.pdf;type=application/pdf'`.
- `packages/paypal/src/client.ts:830` sends the multipart form with `{notes}` in the `input` part — that is
  the documented multipart form. Correct.
- Caveat on the `input` part encoding: PayPal's cURL writes a **bare field** with `;type=application/json`;
  the code appends it via `form.append(name, new Blob([json], {type:'application/json'}), 'input.json')`,
  which additionally emits `filename="input.json"`. See §12 / Action required.
- Return `200 OK` with `links`.
- Constraint from `SPEC-D` description: only allowed when `dispute_life_cycle_stage` is `CHARGEBACK`,
  `PRE_ARBITRATION` or `ARBITRATION`.

## 8. `POST /v1/customer/disputes/{id}/escalate`

**VERIFIED.** Source: `GUIDE` "Escalate dispute to claim"; `SPEC-D` `components.schemas.escalate`.

- **`application/json`**, body `{ "note": "Escalating to PayPal claim for resolution." }`.
  `GUIDE` shows exactly this cURL. The code's `escalate(id, note)` → `{ json: { note } }` is correct.
- Spec also carries an undocumented-in-prose optional `buyer_escalation_reason`
  (`SPEC-D` `components.schemas.escalate.properties.buyer_escalation_reason`, schema object is empty `{}` —
  PayPal has not published its values).
- `note`: 1–2000 chars. Neither field is in the schema's `required` array, so both are optional at the
  schema level; `GUIDE` always sends `note`.
- Return `200 OK`, schema `escalate_response` = `{links: [...]}` — same shape.

## 9. `POST /v1/customer/disputes/{id}/appeal`

**VERIFIED — the endpoint is real.** Source: `SPEC-D` path + `operationId: disputes.appeal`;
`GUIDE` "Appeal dispute"; `TGL` "Appeal dispute".

- It exists in the OpenAPI with the same `components.requestBodies.evidences` (multipart) as
  `provide-evidence`, same `200 OK` → `subsequent_action` (`{links}`) response.
- `GUIDE` cURL: `-F 'input={"evidences":[{"evidence_type":"PROOF_OF_FULFILLMENT","evidence_info":{"tracking_info":[{"carrier_name":"FEDEX","tracking_number":"122533485"}]},"notes":"Test"}]};type=application/json' -F 'file1=@NewDoc.pdf;type=application/pdf'`
- **Both halves of the question are true.** `dispute_state` does have an `APPEALABLE` value
  (`SPEC-D` `components.schemas.dispute_state.enum`), and `appeal` is a real `POST`. But PayPal states
  that _eligibility is signalled by the presence of the `appeal` HATEOAS link_ in the show-dispute-details
  response — "If this link does not appear, you cannot appeal the dispute" (`SPEC-D` description),
  "check whether the HATEOAS link for appeal is present" (`GUIDE`), and `TGL` "Check if the appeal action is
  available in the HATEOAS links".
- **Recommendation for the project:** gate on the HATEOAS link, not on `dispute_state === 'APPEALABLE'`.
  **My inference** is that the link is authoritative and `APPEALABLE` is the coarse state it corresponds to;
  neither source says the link is derived from it.
- The code's `appeal()` reuses `provideEvidenceInputSchema` and `buildEvidenceForm`, so the same
  `{evidences:[…]}` mismatch as §2 applies.

## 10. `GET /v1/customer/disputes` pagination

**CONTRADICTS.** Source: `SPEC-D` `paths./v1/customer/disputes.get.parameters` and
`components.parameters`.

**Real parameters, exactly seven:**

| Param                     | Status                 | Constraint                                                                                      |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `start_time`              | **`deprecated: true`** | RFC 3339, within last 180 days, default now. Mutually exclusive with `disputed_transaction_id`. |
| `disputed_transaction_id` | current                | 1–255, `^[0-9A-Z_]+$`                                                                           |
| `page_size`               | current                | integer, **min 1, max 50**, default 10                                                          |
| `next_page_token`         | **`deprecated: true`** | 1–255, `^[A-Za-z0-9+/=]+$`, "The token … is returned in the HATEOAS links in the response"      |
| `dispute_state`           | current                | enum below; **comma-separated multiples allowed**; 1–2000                                       |
| `update_time_before`      | current                | RFC 3339, within 180 days, default now                                                          |
| `update_time_after`       | current                | RFC 3339, within 180 days, default = now − 180d                                                 |

- **There is no `page` parameter.** It does not exist in the spec.
- **There is no `total_pages` and no `total_items`.** The response schema is `dispute_search` =
  `{ items: dispute_info_list, links: link_description_list }`. The code's `DisputeList.total_pages` /
  `total_items` are not PayPal fields (harmless — optional on a `looseObject` — but they will always be absent).
- `dispute_state` query enum: `REQUIRED_ACTION`, `REQUIRED_OTHER_PARTY_ACTION`, `UNDER_PAYPAL_REVIEW`,
  `RESOLVED`, `OPEN_INQUIRIES`, `APPEALABLE`.
- **Consequence for the reconciler (spec §8.12):** with both `page_size` and `next_page_token` deprecated,
  the documented forward-paging mechanism is the HATEOAS `links` on the response (`next` relation carrying
  the token). `packages/paypal/src/types.ts:641` sends `page` (ignored by PayPal) and caps `page_size` at 500
  where PayPal caps it at 50 — a `page_size` between 51 and 500 is a likely 400.
- `GUIDE` "List disputes" sample response confirms the shape: `{items: [...], links: [...]}`.

## 11. `GET /v1/customer/disputes/{id}` response fields

**CONTRADICTS on three field names and on the `dispute_state` enum.** Source: `SPEC-D`
`components.schemas.dispute` and `components.schemas.dispute_info`; corroborated by `GUIDE`'s full sample
responses.

| Field the code assumes                           | Verdict                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispute_reason`                                 | **Wrong. The field is `reason`.** `SPEC-D.dispute.properties.reason → $ref dispute_reason`. `GUIDE` sample: `"reason": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"`. |
| `dispute_life_cycle_stage`                       | **Correct.** Enum `INQUIRY`, `CHARGEBACK`, `PRE_ARBITRATION`, `ARBITRATION`.                                                                                       |
| `dispute_state`                                  | **Field exists, enum is different** — see below.                                                                                                                   |
| `status`                                         | **Correct.** Enum `OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`, `OTHER`.                                        |
| `seller_response_due_date`                       | **Correct.** RFC 3339, present only in some responses (present in `GUIDE`'s sample).                                                                               |
| `buyer_response_due_date`                        | **Correct.**                                                                                                                                                       |
| `disputed_amount`                                | **Wrong. The field is `dispute_amount`** (`money`). There is no `disputed_amount`.                                                                                 |
| `seller_transaction_id` / `buyer_transaction_id` | **Both exist, but nested** inside `disputed_transactions[]` (`$ref transaction_info_list`), not at the top level of the Dispute object.                            |

**`dispute_state` — the exact enum (`SPEC-D` `components.schemas.dispute_state`):**
`OPEN_INQUIRIES`, `REQUIRED_ACTION`, `REQUIRED_OTHER_PARTY_ACTION`, `UNDER_PAYPAL_REVIEW`, **`APPEALABLE`**, `RESOLVED`.
`APPEALABLE` **does exist** — the project's §8.16 assumption is correct. Its description: "The dispute can be
appealed." But the other five values in the code's `DISPUTE_STATES` (`WAITING_FOR_BUYER_RESPONSE`,
`WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `CANCELED`, `ACCEPTED`, `REFUNDED`, `PENDING`) are **not**
`dispute_state` values — they are either `status` values or invented. This matters because the code's filing
guard branches on `WAITING_FOR_SELLER_RESPONSE` and §8.15 says it keys on `status`, which is correct — but
`DISPUTE_STATES` as written would silently never match a real `dispute_state`.

**`dispute_reason` — the exact enum (`SPEC-D` `components.schemas.dispute_reason`, 10 values):**
`MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, `UNAUTHORISED`,
`CREDIT_NOT_PROCESSED`, `DUPLICATE_TRANSACTION`, `INCORRECT_AMOUNT`, `PAYMENT_BY_OTHER_MEANS`,
`CANCELED_RECURRING_BILLING`, `PROBLEM_WITH_REMITTANCE`, `OTHER`.
Against the code's 13: **`MERCHANDISE_OR_SERVICE_NOT_RECEIVED_2`, `REFUND_NOT_AS_DESCRIBED`,
`PAYOUT_DECLINED`, `ACCOUNT_COMPROMISED` and `UNPAID_AMOUNT` do not exist**; **`PAYMENT_BY_OTHER_MEANS`
and `PROBLEM_WITH_REMITTANCE` are missing.**

**Other response-shape facts the code's `disputeSchema` misses** (`looseObject` means they will not _fail_
parsing, but they will never be _read_):

- Evidence is **`evidences`** (plural, an array, `$ref evidence_list`), not `evidence`; each entry has
  `evidence_type`, `notes` (**string**), `evidence_info`, `documents`, `source`, `date`,
  `dispute_life_cycle_stage`, `item_id`, `item_type`, `action_info`. `GUIDE`'s sample confirms.
- `offer` (singular object), not `offers` (array) — `$ref offer`.
- `supporting_info` (array), not present in the code.
- `allowed_response_options` — `{acknowledge_return_item:{acknowledgement_types}, accept_claim:{accept_claim_types}, make_offer:{offer_types}}`. **This is the discovery endpoint for §3/§4/§6.**
- `adjudications` (array), `money_movements`, `fund_movements`, `dispute_outcome`, `fee_policy`,
  `external_reason_code`, `extensions`, `refund_details`, `communication_details`.
- `messages[].content` is the message text; `messages[].posted_by` ∈ `BUYER|SELLER|ARBITER` — the code's
  `messages` type guesses `{content, sender}`, and `sender` does not exist.

## 12. Evidence file upload limits and MIME types

**VERIFIED for the numbers; NOT DOCUMENTED for the unit.** Source: `FILES` (verbatim).

> - **Supported file types**: `.jpg`, `.jpeg`, `.gif`, `.png`, and `.pdf`
> - **Individual file size**: Less than 10 MB per file
> - **Total file size**: Up to 50 MB per API call

- The five types are exactly what `ALLOWED_EVIDENCE_CONTENT_TYPES` encodes
  (`image/jpeg`, `image/png`, `image/gif`, `application/pdf`). **VERIFIED.**
- "Less than 10 MB per file" is exclusive; the code's `size >= MAX_EVIDENCE_FILE_BYTES` rejects at the
  boundary, which matches.
- "Up to 50 MB per API call" is inclusive; the code's `total > MAX_EVIDENCE_TOTAL_BYTES` matches.
- **NOT DOCUMENTED: whether "MB" means 10^6 or 2^20.** PayPal does not say. `SPEC-D` contains no size
  constraint at all — no `maxLength` on `document.name`, no byte limits anywhere.
  **Consequence:** the code uses 10·2^20 = 10 485 760 (stricter than 10^6 per-file → safe) but
  50·2^20 = 52 428 800 total, which is **more permissive** than 50·10^6 = 50 000 000. A 51 MB upload would
  pass local validation and be rejected by PayPal. The conservative reading is decimal for both.
- Where PayPal would have to answer: the `FILES` page itself, or support via the `debug_id` from a 413/422.

---

# Payments v2

## 13. `POST /v2/payments/authorizations/{id}/capture`

**VERIFIED.** Source: `SPEC-P` `components.schemas.capture_request` (`allOf` `supplementary_purchase_data` + own props).

- Fields: **`amount`, `invoice_id`, `final_capture`, `note_to_payer`, `soft_descriptor`, `payment_instruction`.**
  All four fields the code declares exist, with those exact names.
- **`final_capture` default is `false`** — `SPEC-P` `capture_request.allOf[1].properties.final_capture.default = false`.
  Description: "Set to `true` if you do not intend to capture additional payments against the authorization."
- Constraints: `invoice_id` 0–127; `note_to_payer` 0–255; `soft_descriptor` 0–22.
- The whole request body is **`required: false`** — an empty `{}` captures the full authorized amount. The
  code makes `final_capture` **required** in `captureRequestSchema` (`types.ts:342`), which is stricter
  than PayPal and safe.
- Responses `200`, `201`, plus errors. Accepts `Prefer: return=minimal|return=representation`
  (default `return=minimal`) and `PayPal-Request-Id` — both documented on this operation.

## 14. `POST /v2/payments/authorizations/{id}/reauthorize` and `/void`

**VERIFIED — both exist at those exact paths.** Source: `SPEC-P` `paths` (operationIds
`authorizations.reauthorize`, `authorizations.void`).

- `/reauthorize`: request body `required: false`, schema `reauthorize_request` — **supports only the `amount`
  parameter**. Responses `200`, `201`, errors. Accepts `PayPal-Request-Id`.
- `/void`: request body **empty/absent** (no properties at all). Responses **`200` and `204`**. Accepts
  `PayPal-Request-Id`. "Voids, or cancels, an authorized payment, by ID. You cannot void an authorized
  payment that has been fully captured."
- The code's `voidAuthorization` expects `schema: null` (i.e. tolerates an empty body) — correct for 204,
  and the 200-with-body case is handled by `schema === null` short-circuiting. Fine.

## 15. `POST /v2/payments/captures/{id}/refund`

**VERIFIED.** Source: `SPEC-P` `components.schemas.refund_request`.

- Fields: **`amount`, `custom_id`, `invoice_id`, `note_to_payer`, `payment_instruction`.** Exactly the four
  the code declares plus one more.
- `amount` omitted ⇒ refund of `captured amount - previous refunds`. `custom_id` 1–127, `invoice_id` 1–127,
  `note_to_payer` 1–255.
- Body `required: false` (empty `{}` = full refund). Accepts `PayPal-Request-Id`.
- One doc inconsistency worth noting so nobody "fixes" the code toward it: the `captures_refund_with_prefer_header`
  **example** in `SPEC-P` shows `"note": "Defective product"`, but the **schema** field is `note_to_payer`.
  The code uses `note_to_payer`, which matches the schema.

## 16. Authorization validity window and the 3-day honour period

**VERIFIED.** Source: `SPEC-P` `components.schemas.reauthorize_request.description` (verbatim);
corroborated by `ERRORS`.

> "To ensure that funds are still available, reauthorize a payment after its initial three-day honor period
> expires. **You can reauthorize a payment only once from days four to 29.** If 30 days have transpired
> since the date of the original authorization, you must create an authorized payment instead of
> reauthorizing the original authorized payment. **A reauthorized payment itself has a new honor period of
> three days.** You can reauthorize an authorized payment once. The allowed amount depends on context and
> geography, for example in US it is up to 115% of the original authorized amount, not to exceed an
> increase of $75 USD. Supports only the `amount` request parameter."

- **29-day validity and a 3-day honour period: both confirmed, in PayPal's own words.**
- `authorization.expiration_time` exists (`date_time`, `readOnly`, RFC 3339) — but **the spec does not state
  a duration for it.** The 29-day figure is inferred by PayPal's own reauthorize prose ("days four to 29",
  "if 30 days have transpired"). **My inference:** `expiration_time ≈ create_time + 29 days`; it is not
  stated as an equation anywhere. Treat 29 as documented-by-prose, not as a schema guarantee.
- Independent corroboration of the 3-day honour period: `ERRORS` says of `ORDER_ALREADY_AUTHORIZED` —
  "If the authorization is more than 3 days old, reauthorize the funds before capturing."
- `authorization.status` enum (`SPEC-P` `authorization_status`): `CREATED`, `CAPTURED`, `DENIED`,
  `PARTIALLY_CAPTURED`, `VOIDED`, `PENDING`. The code's `PAYMENT_STATUSES` constant does **not** contain
  `PARTIALLY_CAPTURED` or `DENIED`; it does contain `APPROVED`, `PARTIALLY_REFUNDED`, `REFUNDED`,
  `EXPIRED`, `REVERSED`, `SAVED`, `FAILED` which are capture/refund values. Since the constant is
  documentation-only (all schemas are `z.string()`), this is cosmetic, but the union-of-all-statuses
  framing is misleading.

---

# Orders v2

## 17. `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` and `intent: AUTHORIZE`

**VERIFIED — the response DOES include the authorization inline. No follow-up `/authorize` call is needed
for this flow.** This is week-1 check C2 and the answer is unambiguous.

Source: `SPEC-O` `paths./v2/checkout/orders.post.responses["201"].content["application/json"].examples`,
example id **`orders_create_authorize_single_step_paypal_with_vault_id_and_stored_credentials_usage_pattern`**,
whose summary is _"Create and authorize an order for a PayPal wallet vaulted account holder … (Single Shot)"_.

The documented 201 response contains:

```json
"purchase_units": [{
  "payments": {
    "authorizations": [{
      "status": "CREATED",
      "id": "7X550106NA4440028",
      "amount": { "currency_code": "USD", "value": "100.00" },
      "seller_protection": { "status": "ELIGIBLE", "dispute_categories": ["UNAUTHORIZED_TRANSACTION"] },
      "expiration_time": "2024-06-05T18:46:54Z",
      "links": [ … capture / void / up … ],
      "create_time": "2024-05-07T18:46:54Z",
      "update_time": "2024-05-07T18:46:54Z"
    }]
  }
}]
```

- This is in the **schema**, not just the example: `SPEC-O` `components.schemas.purchase_unit.properties.payments
→ payment_collection`, whose properties are `authorizations`, `captures`, `refunds`. `types.ts:230`
  (`orderPaymentsSchema`) models exactly this. **The code's shape is right.**
- `POST /v2/checkout/orders/{id}/authorize` **also exists and is documented**, and its own examples include
  `orders_authorize_paypal_wallet_vault_id` with `payment_source.paypal.vault_id` in the body. **My
  inference:** `/authorize` is the path for the interactive/buyer-approved flow (create → buyer approves →
  authorize), while supplying `vault_id` at creation makes it single-shot. The project should implement
  the inline path as primary and keep `authorizeOrder` for the interactive path — but this is the one place
  where I would want a sandbox probe to confirm before shipping, because PayPal documents both routes and
  never states the exclusivity rule.
- Useful for the payer-id question (see §22): the same example shows
  `payer.payer_id = "XQHSN372NGSP2"` and `payment_source.paypal.account_id = "XQHSN372NGSP2"`.

## 18. `purchase_units[].custom_id` length and character restrictions

**VERIFIED.** Source: `SPEC-O` `components.schemas.purchase_unit_request` → `custom_id`.

```
type: string, minLength: 1, maxLength: 255, pattern: ^[\S\s]*$
```

- Max length **255**. The project's `"cs1:" + base64url(sha256)` = 47 characters is well inside it.
- Pattern `^[\S\s]*$` is "any characters, including whitespace" — i.e. **no character restriction beyond
  non-empty and ≤255**. Base64url's alphabet (`A–Z a–z 0–9 - _`) and the `:` in `cs1:` are all fine.
- Description: "Used to reconcile client transactions with PayPal transactions. Appears in transaction and
  settlement reports but is not visible to the payer." — which is exactly the use the project has for it.

## 19. `invoice_id` constraints and uniqueness semantics

**VERIFIED.** Source: `SPEC-O` `purchase_unit_request.invoice_id`.

```
type: string, minLength: 1, maxLength: 127, pattern: ^[\S\s]*$
description: "The API caller-provided external invoice number for this order. Appears in both the payer's
transaction history and the emails that the payer receives. invoice_id values are required to be unique
within each merchant account by default. Although the uniqueness validation is configurable, disabling this
behavior will remove the account's ability to use invoice_id in other APIs as an identifier. It is highly
recommended to keep a unique invoice_id for each Order."
```

- **Uniqueness is per merchant account and enforced by default.** This is directly relevant to the project
  stamping `ord_…` into `invoice_id`: reusing an id for a re-created order will produce
  `DUPLICATE_INVOICE_ID` (a name that **is** documented in `ERRORS`: "Use a different `invoice_id`"), not a
  silently deduplicated order. Good — but it means the project's request-id discipline (§32) and its
  invoice-id discipline must not be conflated.
- Note the tension: `errors.ts:72` maps `DUPLICATE_INVOICE_ID → PP_DUPLICATE`, which is right, but the same
  mapping is also applied to `INVALID_REQUEST_ID`, which **does not appear in any PayPal doc I could find**
  (see side note at the end).
- `payments_v2` has its own `invoice_id` (0–127) on `capture_request` and (1–127) on `refund_request` —
  independent fields, not the same identifier.

## 20. `POST /v2/checkout/orders/{id}/track` body fields

**VERIFIED — all four of the code's fields exist; one important idempotency finding.**

Source: `SPEC-O` `paths./v2/checkout/orders/{id}/track.post.requestBody` →
`components.schemas.order_tracker_request` = `shipment_tracker` + own props.

- `capture_id` — **required**, 1–50, `^[a-zA-Z0-9]*$`
- `tracking_number` — optional, ≤64, Unicode ("The tracking number for the shipment. This property supports Unicode.")
- `carrier` — optional, `$ref shipment_carrier` (an enum: `FEDEX`, `UPS`, `USPS`, `OTHER`, …)
- `carrier_name_other` — ≤64; "Provide this value only if the carrier parameter is OTHER."
- `notify_payer` — optional boolean, default `false`
- `items[]` — optional array (`tracker_item`: `name`, `quantity`, `sku`, `url`, `image_url`, `upc`)
- The code's `trackReqSchema` (`capture_id` required, `tracking_number` required, `carrier` optional,
  `items` optional) is **correct**; making `tracking_number` required locally is stricter than PayPal and safe.
  It is missing `carrier_name_other`, which matters if `carrier: 'OTHER'` is ever used.
- **Idempotency finding:** this operation does **not** declare a `PayPal-Request-Id` header parameter, and
  `SPEC-O`'s example description says explicitly — _"Idempotency for trackers is based on the `capture_id`
  and `tracking_number` combination sent in the request body."_ The code
  (`client.ts:184`) sets `sendRequestId: true` for this endpoint. Harmless but it means EC-SPLIT-2's
  "track twice against the same capture" dedupes on the body pair, not on our header.

---

# Vault v3

## 21. `POST /v3/vault/setup-tokens` body

**CONTRADICTS on placement.** Source: `SPEC-V` `components.schemas.setup_token_request`,
`paypal_wallet_request`, `wallet_base`, `experience_context`.

- `setup_token_request` has exactly **two** properties: `customer` and `payment_source` (required).
  **There is no top-level `experience_context`.** The code's `setupTokenReqSchema` (`types.ts:163`) has a
  top-level `experience_context` and its `SetupTokenReq` type puts `experience_context` at the top level —
  that shape is not in the spec.
- `payment_source.paypal` → `paypal_wallet_request` = `wallet_base` + `{billing_plan, experience_context}`.
  So the correct placement is **`payment_source.paypal.experience_context`**.
- `experience_context` keys: `brand_name`, `locale`, `return_url`, `cancel_url`, `shipping_preference`,
  `vault_instruction`. The code's `{return_url, cancel_url, user_action}` — **`user_action` is not in the
  Vault `experience_context`** (it exists in the Orders v2 `paypal_wallet_experience_context`, a different
  schema). `return_url`/`cancel_url` are correct and, per the description, "required for contingency flows
  like PayPal wallet".
- **`usage_type` enum: `MERCHANT`, `PLATFORM`** — spec §10.2's `MERCHANT` claim is **correct**.
  Also `customer_type`: `CONSUMER`, `BUSINESS`; `permit_multiple_payment_tokens`: boolean, default `false`.
- **`usage_pattern` enum (12 values):** `IMMEDIATE`, `DEFERRED`, `RECURRING_PREPAID`, `RECURRING_POSTPAID`,
  `THRESHOLD_PREPAID`, `THRESHOLD_POSTPAID`, `UNSCHEDULED_POSTPAID`, `UNSCHEDULED_PREPAID`,
  `SUBSCRIPTION_PREPAID`, `SUBSCRIPTION_POSTPAID`, `INSTALLMENT_POSTPAID`, `INSTALLMENT_PREPAID`.
  For a one-shot merchant-initiated charge, `IMMEDIATE` is what PayPal's own orders example uses
  (see §17's example id, which passes `RECURRING_PREPAID` with stored credentials).
- All of `usage_type`, `usage_pattern`, `customer_type`, `permit_multiple_payment_tokens`, `description`,
  `shipping` live under **`payment_source.paypal.*`**, not at the top level. The code's `SetupTokenReq` type
  comment at `types.ts:171` shows `payment_source.paypal.usage_type` — correct — but the runtime
  `setupTokenReqSchema` uses a generic `paymentSourceSchema` whose `paypal` member
  (`vaultPaymentSourcePaypalSchema`) does not declare `usage_type`/`usage_pattern`. Since it is a
  `looseObject` they pass through unvalidated, so the wire call is fine; only the local validation is thinner
  than it looks.
- Response `201` → `setup_token_response`: `{id, customer, status, payment_source, links}`.
  **Note:** `status` exists on the setup token, and the documented example shows `"status": "APPROVED"`.
  Also `links` includes `rel: "confirm"` pointing at `/v3/vault/payment-token`.
- `setup_token_request` is `required: ["payment_source"]` — a request with no `payment_source` is invalid.
  The code makes the whole body optional.
- **The operation declares a `PayPal-Request-Id` header** (`SPEC-V`
  `paths./v3/vault/setup-tokens.post.parameters = [paypal_request_id]`), with the note
  **"The server stores keys for 3 hours."**

## 22. `POST /v3/vault/payment-tokens` body and response

**VERIFIED for the request; CONTRADICTS for the top-level `payer`.**

Source: `SPEC-V` `payment_token_request`, `definitions-payment_source`, `token_id_request`,
`payment_token_response`, `payment_source`, `paypal_wallet_response`, `payer_base`.

**Request** — exactly what the code sends, **VERIFIED**:

```json
{ "payment_source": { "token": { "id": "<setup token id>", "type": "SETUP_TOKEN" } } }
```

`token_id_request` has `id` (1–255, `^[0-9A-Za-z_-]+$`) and `type` (enum: **`SETUP_TOKEN`** only), both
required. `payment_token_request.payment_source` allows `card`, `network_transaction_reference` and `token`
— **there is no `paypal` key on the request**, which is correct: you exchange a setup token, you don't
describe a wallet.

**Response** — `payment_token_response` = `{id, customer, payment_source, links}`. **There is no top-level
`payer` property.** `packages/paypal/src/types.ts:201` declares one (`payer: z.looseObject({})`) and the
`PaymentToken` type gives it `{email_address, payer_id}` at `types.ts:212`. That shape is not in the spec and
will never be populated.

**Which field carries the payer id:** `payment_source.paypal` → `paypal_wallet_response`, which is
`wallet_base` + **`payer_base`** + `{name, phone, address, account_id (readOnly), phone_number (readOnly)}`.

- `payer_base` = `{email_address, payer_id}` — `payer_id` is "The PayPal-assigned ID for the payer",
  `readOnly: true`, `$ref account_id`.
- `account_id` is also declared, `readOnly: true`, "The account identifier for a PayPal account", same
  `account_id` schema.
- **So both `payment_source.paypal.payer_id` and `payment_source.paypal.account_id` are the payer
  identifier.** The published example (`customer_vault_payment_tokens_response`) shows **only `account_id`**
  (`"VYYFH3WJ4JPJQ"`); `payer_id` is schema-declared but absent from every example PayPal publishes.
  **My inference:** they carry the same value and `account_id` is the one actually emitted. The project
  should read `payer_id ?? account_id` and record that as an assumption rather than a fact.
- Independent corroboration: in the Orders v2 create response (§17) `payer.payer_id` and
  `payment_source.paypal.account_id` are the same string (`XQHSN372NGSP2`). That is a _different_ endpoint,
  but it supports the "same value, two names" reading.
- `email_address` is present under `payment_source.paypal.email_address` (`payer_base`), not top level.

## 23. `DELETE /v3/vault/payment-tokens/{id}`

**VERIFIED.** Source: `SPEC-V` `paths./v3/vault/payment-tokens/{id}` — `operationId: payment_tokens.delete`.
Responses: `204`, `400`, `403`, `500`. **`204 No Content`**, so the code's `schema: null` is correct.
The `201` create response also returns a `rel: "delete"` HATEOAS link.

## 24. What token Vault v3 needs — client-credentials or a `client token`?

**VERIFIED: the plain OAuth client-credentials access token. A `client_token` is not required, and PayPal
now explicitly discourages it outside one narrow case.**

- `SPEC-V` `paths./v3/vault/setup-tokens.post.security` = `[{Oauth2: ["https://uri.paypal.com/services/vault/payment-tokens/read"]}]`,
  declared under `securitySchemes` as OAuth2 `clientCredentials` (the API reference header for the whole
  Disputes/Orders/Vault family reads "Oauth2 (OAuth 2.0, clientCredentials)").
- `VAULTDOC` "Prerequisites": "Your app's **client ID and client secret. Exchange these for an OAuth access
  token.**" No mention of a client token.
- The `client_token` grant is documented at `SDKJS` as a **browser-SDK** credential, and its current guidance
  is blunt: "**Option B: client token (for Fastlane only)** — Client token authentication is required for
  Fastlane integrations. For all other use cases, use Option A: client ID." The documented request is
  `POST /v1/oauth2/token` with `grant_type=client_credentials`, `response_type=client_token`, **and
  `domains[]`**; the response `scope` string in `SDKJS`'s own example contains
  `https://uri.paypal.com/services/vault/payment-tokens/read` and `…/readwrite`.
- **So the project's browser-SDK flow does not need a client token** — a client ID is the documented and
  recommended credential.
- Two concrete code notes: (a) `client.ts:398` `getClientToken()` omits `domains[]`, which the documented
  cURL includes; (b) the JS SDK v6 is referenced as `https://www.sandbox.paypal.com/web-sdk/v6/core`
  (`SDKJS`), which is the current major version.

---

# Webhooks

## 25. `POST /v1/notifications/verify-webhook-signature`

**VERIFIED — the code's seven fields are exactly right and all seven are required.**

Source: `SPEC-W` `components.schemas.verify_webhook_signature` (identical served copy at
https://developer.paypal.com/api/webhooks/v1/schema.json).

`required: ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time", "webhook_id", "webhook_event"]`

| Field               | Constraint                                | Where it comes from                                                                       |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `auth_algo`         | ≤100, `^[a-zA-Z0-9]+$`                    | `PAYPAL-AUTH-ALGO` header                                                                 |
| `cert_url`          | ≤500, `format: uri`                       | `PAYPAL-CERT-URL` header                                                                  |
| `transmission_id`   | ≤50                                       | `PAYPAL-TRANSMISSION-ID`                                                                  |
| `transmission_sig`  | ≤500                                      | `PAYPAL-TRANSMISSION-SIG`                                                                 |
| `transmission_time` | ≤100, `format: date-time`                 | `PAYPAL-TRANSMISSION-TRANSMISSION-TIME` (sic — spec text says `PAYPAL-TRANSMISSION-TIME`) |
| `webhook_id`        | ≤50, `^[a-zA-Z0-9]+$`                     | Developer Portal                                                                          |
| `webhook_event`     | `$ref event` — the whole raw event object | the notification body                                                                     |

Response: `verification_status`, `enum: ["SUCCESS","FAILURE"]`, required. The code's
`verifyWebhookSignatureResSchema` and its fail-closed "anything that isn't `SUCCESS` is `FAILURE`" are
correct. Header-name mapping in `types.ts:756` matches.

## 26. Webhook event names in the project's §8.12

Source: `EVENTS` — https://developer.paypal.com/api/rest/webhooks/event-names (91 event names enumerated).
Note that `SPEC-W` does **not** enumerate event names at all (`event_type.name` is a bare `string`), so
`EVENTS` is the authoritative list.

**All 18 events in `WEBHOOK_EVENT_NAMES` exist except one:**

| Event                                    | Verdict                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT.CAPTURE.COMPLETED`              | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `PAYMENT.CAPTURE.PENDING`                | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `PAYMENT.CAPTURE.DECLINED`               | VERIFIED (both `DECLINED` **and** `DENIED` exist — they are different events)                                                                                                                                                                                                                             |
| `PAYMENT.CAPTURE.REFUNDED`               | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `PAYMENT.CAPTURE.REVERSED`               | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `PAYMENT.REFUND.PENDING`                 | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `PAYMENT.REFUND.FAILED`                  | VERIFIED                                                                                                                                                                                                                                                                                                  |
| **`PAYMENT.REFUND.COMPLETED`**           | **NOT DOCUMENTED — no such event.** The full capture/refund set is `PAYMENT.CAPTURE.{COMPLETED,PENDING,DECLINED,DENIED,REFUNDED,REVERSED}` and `PAYMENT.REFUND.{PENDING,FAILED}`. There is no `PAYMENT.REFUND.COMPLETED`; refund completion is signalled by `PAYMENT.CAPTURE.REFUNDED`. (`types.ts:800`.) |
| `PAYMENT.AUTHORIZATION.CREATED`          | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `PAYMENT.AUTHORIZATION.VOIDED`           | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `CHECKOUT.ORDER.APPROVED`                | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `CHECKOUT.PAYMENT-APPROVAL.REVERSED`     | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `CUSTOMER.DISPUTE.CREATED`               | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `CUSTOMER.DISPUTE.UPDATED`               | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `CUSTOMER.DISPUTE.RESOLVED`              | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `VAULT.PAYMENT-TOKEN.CREATED`            | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `VAULT.PAYMENT-TOKEN.DELETED`            | VERIFIED                                                                                                                                                                                                                                                                                                  |
| `VAULT.PAYMENT-TOKEN.DELETION-INITIATED` | VERIFIED                                                                                                                                                                                                                                                                                                  |

**Documented events in the project's space that it is missing:**

- **`PAYMENT.CAPTURE.DENIED`** — documented and _recommended by PayPal_ for the checkout flow:
  https://developer.paypal.com/payment-methods/webhooks lists
  `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.PAYMENT-APPROVAL.REVERSED`, `PAYMENT.CAPTURE.PENDING`,
  `PAYMENT.CAPTURE.COMPLETED`, **`PAYMENT.CAPTURE.DENIED`** as the five to subscribe to, with
  "Listen for this webhook and then cancel fulfilling the order." The project subscribes to
  `DECLINED` but not `DENIED`.
- **`RISK.DISPUTE.CREATED`** — a pre-dispute risk signal in the `DISPUTE` namespace; potentially valuable to
  a "Dispute Defender" that wants lead time, though PayPal does not describe it further on `EVENTS`.
- `CHECKOUT.ORDER.COMPLETED`, `CHECKOUT.ORDER.PROCESSED` — order-side completion, complementary to `APPROVED`.
- **There is no `PAYMENT.AUTHORIZATION.EXPIRED`** — so the project's EC-TIME-5 expiry alerting **cannot** be
  webhook-driven; it must poll `GET /v2/payments/authorizations/{id}` and compare `expiration_time`.
  That is a genuine design finding, not a doc nit.

---

# Sandbox simulators

## 27. `POST /v2/customer-support/process-chargeback`

**CONTRADICTS — the code's body is essentially all wrong.** Source: `TGL`, "Simulate PayPal actions →
Create chargeback".

`application/json`. Required fields, with the values PayPal documents for a PayPal-funded transaction:

- `adjacency` — **`"PAYPAL"`**
- `file_layout` — **`"ATCK_CB"`**
- `merchant_id` — "the merchant ID associated with the PayPal account"
- `financial_institution.processor` — **`"FDMS"`**
- `transaction.id_enc` — "Pass the **SELLER-TRANSACTION-ID** in this parameter… the transaction ID available
  when you log in using the business test account"
- `transaction.amount` — `{currency_code, value}`
- `instrument.instrument_type` — **required**; possible values `CARD`, `BANK`, `CREDIT`; "Set the value as
  `CARD` for card-funded transactions"
- `dispute` — required object; documented sub-fields `receive_date`, `money_movement_date`, `response_date`;
  the sample also shows `id`, `stage`, `status`, `amount`, `event_code`, `event_type`, `chargeback_type`,
  `processor_info.{reference_number, reason_code, notes}`

`TGL`'s verbatim sample body:

```json
{
  "adjacency": "PAYPAL",
  "file_layout": "ATCK_CB",
  "merchant_id": "99038409233245",
  "financial_institution": { "processor": "FDMS" },
  "transaction": {
    "id_enc": "SELLER-TRANSACTION-ID",
    "amount": { "currency_code": "USD", "value": "20" }
  },
  "instrument": {
    "instrument_type": "CARD",
    "card_brand": "VISA",
    "credit_card_transaction_id": "2347289342893472",
    "external": false
  },
  "dispute": {
    "id": null,
    "stage": "CHARGEBACK",
    "response_date": "2023-07-16T12:05:22.544Z",
    "status": "2",
    "amount": { "currency_code": "USD", "value": "10" },
    "receive_date": "2025-06-16T12:05:22.544Z",
    "event_code": "CHARGEBACK_INITIATED",
    "money_movement_date": "2025-06-16T12:05:22.544Z",
    "event_type": "DEBIT",
    "chargeback_type": "REPORTED_TO_PROCESSOR",
    "processor_info": {
      "reference_number": "31639435342702423793399",
      "reason_code": "1330",
      "notes": "TEST_MEMO"
    }
  }
}
```

Return: **`201 Created`** with a dispute ID. `sandbox.ts:201` currently sends
`{transaction_id, reason}` and expects an empty body.

**Important scoping fact for the project:** the code's own comment says "Card-funded transactions only" —
`TGL` corroborates this strongly. `TGL`'s own prerequisite is "For a transaction to be eligible for
chargeback, **ensure you use a credit card** to send money", and `instrument.instrument_type` must be `CARD`.
So week-1 check C1's fallback chain is correct on the facts.

## 28. `POST /v1/customer/disputes/{id}/require-evidence`

**VERIFIED.** Source: `TGL` "Update dispute status"; `SPEC-D` `components.schemas.require_evidence`.

- `application/json`, body `{ "action": "BUYER_EVIDENCE" }` / `{ "action": "SELLER_EVIDENCE" }`.
- `action` is **required**, enum exactly `BUYER_EVIDENCE` | `SELLER_EVIDENCE`
  (`TGL`: "Possible values BUYER*EVIDENCE SELLER_EVIDER"). Pattern `^[0-9A-Z*]+$`, 1–255.
- `BUYER_EVIDENCE` ⇒ status becomes `WAITING_FOR_BUYER_RESPONSE`; `SELLER_EVIDENCE` ⇒
  `WAITING_FOR_SELLER_RESPONSE`.
- Sandbox-only. **Precondition:** `status` must be `UNDER_REVIEW` **and** the `require-evidence` HATEOAS
  link must be present.
- Return `200 OK` with a HATEOAS link. `sandbox.ts:216` is correct.

## 29. `POST /v1/customer/disputes/{id}/adjudicate`

**VERIFIED.** Source: `TGL` "Settle dispute"; `SPEC-D` `components.schemas.adjudicate`.

- `application/json`, body `{ "adjudication_outcome": "BUYER_FAVOR" }`.
- Enum exactly `BUYER_FAVOR` | `SELLER_FAVOR`, required. `TGL` maps the outcome to the resulting
  `dispute_outcome`: `RESOLVED_BUYER_FAVOR` / `RESOLVED_SELLER_FAVOR`.
- Sandbox-only. Precondition: `status` must be `UNDER_REVIEW` and the `adjudicate` link present.
- Return `200 OK` with a HATEOAS link. `sandbox.ts:234` is correct.

## 30. `change-reason`, `accept-offer`, `deny-offer`

- **`change-reason` — CONTRADICTS on encoding, partially right on fields.** `TGL` "Change dispute reason":
  `Content-Type: multipart/related`, header `PayPal-Auth-Assertion`, body is a single `input` JSON part:
  ```json
  { "reason": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    "note": "Product is not as advertised",
    "item_info": [ { "item_name": …, "item_quantity": …, "reason": …, "item_type": "PRODUCT",
                     "product_details": { "sub_reason": …, "category": … },
                     "expected_refund": { "currency_code": "USD", "value": "10" } } ] }
  ```
  So **`reason` is right**, `note` and `item_info` are missing, and JSON is not the documented encoding.
  Return `200 OK` + HATEOAS link. This endpoint is **not** in `SPEC-D` — `TGL` is the only source.
  `sandbox.ts:256` sends JSON `{reason}`.
- **`accept-offer` — CONTRADICTS on one field name.** `TGL` and `SPEC-D.accept_offer` both say
  `application/json` with **`{ "note": "I am ok with the refund offered." }`**. The code sends
  **`{payer_note}`** (`sandbox.ts:283`). `note` is optional (no `required` array), 1–2000 chars.
  "PayPal can view these notes, but the merchant cannot." Return **`200 OK`, or `202 Accepted`** if the
  offer's money movement is delayed.
- **`deny-offer` — VERIFIED.** `TGL` and `SPEC-D.deny_offer` both say `application/json` with
  `{ "note": "refund offer is very low." }`; **`note` is required**, 1–2000. `sandbox.ts:292` sends exactly
  `{note}`. Return `200 OK` + HATEOAS link.

## 31. `PayPal-Auth-Assertion` — is the unsigned `{alg:"none"}` form documented?

**VERIFIED — yes, verbatim, including the empty signature segment.** Source: `SETUP`, section
"Generate JWT for PayPal-Auth-Assertion". PayPal's own HTML snippet:

```js
function base64url(source) {
  var encodedSource = btoa(source)
  encodedSource = encodedSource.replace(/=+$/, '')
  encodedSource = encodedSource.replace(/\+/g, '-')
  encodedSource = encodedSource.replace(/\//g, '-')
  return encodedSource
}
function generateJWT() {
  var header = { alg: 'none', typ: 'JWT' }
  var data = { iss: 'CLIENT_ID', email: 'BUYER_EMAIL' }
  document.write(base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(data)) + '.')
}
```

- **No signature is required.** The token is literally `header.payload.` with a trailing dot, exactly as
  `sandbox.ts:71` `unsignedAuthAssertion` builds it. The code's comment "That trailing dot is not a typo" is
  correct and now cited.
- **Payload shape `{iss: CLIENT_ID, email: BUYER_EMAIL}` — VERIFIED, matches the code.**
- One difference worth noting for exactness: PayPal's header includes **`"typ": "JWT"`** alongside
  `"alg": "none"`; the code sends only `{alg: 'none'}`. A JWS `alg: none` header is _supposed_ to be
  `{"alg":"none"}`, so this is very unlikely to matter, but it is a real difference from the documented form.
- Corroborated by `SPEC-P`'s own header example for `PayPal-Auth-Assertion`:
  `"eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im15QGVtYWlsLmNvbSJ9"` — base64url of `{"alg":"none"}` +
  `{"email":"my@email.com"}`, unsigned, **no `iss`**. So the unsigned `alg:none` form is also baked into
  the payments spec's example.
- **Which calls need it:** `TGL` says "include the `PayPal-Auth-Assertion` request header with a valid JWT"
  for `POST /v1/customer/disputes` and `POST /v1/customer/disputes/{ID}/change-reason`. `TGL` also shows the
  header on `accept-offer` and `deny-offer`. `adjudicate` and `require-evidence` show only
  `Authorization: Bearer` in their cURL — so the assertion is buyer-side only, matching the code's placement.
- **Prerequisite the code doesn't mention:** `SETUP` requires two REST-app scopes from your account manager —
  `DISPUTE_CREATE` (`https://uri.paypal.com/services/disputes/create`) and `UPDATE_BUYER`
  (`…/disputes/update-buyer`) — **and** an interactive "Log in with PayPal" buyer-consent flow first. **A
  sandbox probe cannot skip the consent step.** That belongs in `docs/HUMAN_TODO.md`.
  (`SPEC-D`'s `security` for `provide-evidence` also lists `…/disputes/update-buyer`.)

---

# Idempotency

## 32. `PayPal-Request-Id` — maximum length, and which endpoints document support

**CONTRADICTS between two PayPal sources; the project must decide which one it believes.**

- **`IDEMP` (prose), "Usage notes":** "PayPal recommends that you use the **UUID standard** for the
  `PayPal-Request-Id` header value because it meets the **38 single-byte character limit**."
- **`SPEC-P` / `SPEC-V` (OpenAPI), `components.parameters.paypal_request_id`:** the same header is declared
  `minLength: 1`, **`maxLength: 10000`**, `pattern: ^.*$`, `required: false`. (`SPEC-V`'s copy adds
  "The server stores keys for 3 hours.")
- **These cannot both be the enforced limit.** Which is real is **NOT DOCUMENTED**. The safe engineering
  position is the smaller one: 38 characters is the only number PayPal states as a _limit_ rather than a
  schema maximum.
- **The project's worst case is 55 characters** — `idempotency.ts:209 observedRequestIdLengths` computes
  `cs:{17-char PayPal auth id}:cap:{shp_ + 26 ULID}` = 55, which **exceeds 38**. If the 38-char figure is
  enforced anywhere, `captureRequestId` is the format that breaks. **This is the single most consequential
  finding in this section.**
- Other documented behaviours the code should know:
  - `IDEMP`: "**Not all APIs support this header.** To determine whether your API supports it … see the
    reference for your API." The reference pages **do not actually enumerate** which APIs support it —
    you have to check each operation's `parameters` for `paypal_request_id`. **So the question "which
    endpoints document support" is answerable, and here is the answer from the specs:**
    - **Declares `PayPal-Request-Id`:** Orders v2 `POST /v2/checkout/orders`, `/authorize`, `/capture`;
      Payments v2 `authorizations.capture`, `authorizations.reauthorize`, `authorizations.void`,
      `captures.refund`; Vault v3 `POST /v3/vault/setup-tokens`, `POST /v3/vault/payment-tokens`.
    - **Does NOT declare it:** Orders v2 **`POST /v2/checkout/orders/{id}/track`** (idempotency is
      `capture_id` + `tracking_number` in the body, stated explicitly in `SPEC-O`); Notifications
      `POST /v1/notifications/verify-webhook-signature`.
    - **Not documented at all:** the whole Disputes v1 family, and `POST /v2/customer-support/process-chargeback`.
      `SPEC-D` has no `paypal_request_id` parameter anywhere, and none of the dispute paths are in
      `SPEC-W` either. The code's `re-read-required` policy for disputes/vault **is the correct call** —
      except that vault _does_ declare the header, which the code's comment (`client.ts:195`) gets wrong.
  - `IDEMP`: "**PayPal provides the status of a request at the current time and not the status of the
    original request.**" — i.e. a replayed id returns the _latest_ status, so a retry can legitimately
    return a different status than the original 5xx.
  - `IDEMP`: "When you send two **simultaneous** API requests with same `PayPal-Request-Id` header, PayPal
    processes the first request and **might fail the second request**." — relevant to the token
    single-flight design and to any two-worker race on the same key.
  - `REQ` "PayPal-Request-Id": "You can make the call again with the same ID … for **up to 45 days**."
    (Retentions differ per API; `SPEC-V` says 3 hours for vault.)
  - `IDEMP`: "the `PayPal-Request-Id` header value must be **unique for both each request and an API call
    type**" — i.e. key space is scoped per endpoint, which the project's formats respect.

---

# MCP

## 33. `https://mcp.sandbox.paypal.com/http` — client-credentials bearer vs interactive OAuth, and tool names

**VERIFIED — the remote MCP server accepts an OAuth client-credentials bearer token as a static credential.
An interactive login flow is only needed if you do not supply one.** Source: `MCPDOC`, section
"Remote MCP server → Set up token authorization".

> "**PayPal supports using your PayPal client credentials to connect to the remote MCP server.** With this
> type of authorization, you use your PayPal account's client ID and secret from PayPal Developer Dashboard."

```
{
  "mcpServers": {
    "paypal-mcp-server": {
      "command": "npx",
      "args": [ "mcp-remote", "https://mcp.sandbox.paypal.com/sse",
                "--header", "Authorization: Bearer <auth_header>" ]
    }
  }
}
```

- **Both transports are documented at the URLs the project uses:** SSE at `/sse`, streamable HTTP at
  `/http`, sandbox base `https://mcp.sandbox.paypal.com`, production `https://mcp.paypal.com`.
- The header-only examples (`mcp-remote https://mcp.sandbox.paypal.com/sse` with no `--header`) use the
  interactive flow: "Save the configuration file, and restart your MCP client. **The MCP client sends you to
  the PayPal login page.** Provide your consent…"
- Local alternative (also documented): `npx -y @paypal/mcp --tools=all` with env `PAYPAL_ACCESS_TOKEN`
  and `PAYPAL_ENVIRONMENT=SANDBOX`. `@paypal/mcp` is on npm at version **1.8.1**, described as
  "A command line tool for setting up PayPal MCP server".

**Empirical probes I ran against the live sandbox endpoints (unauthenticated) — these are observations, not
documentation:**

- `GET https://mcp.sandbox.paypal.com/.well-known/oauth-protected-resource/http` → **200**
  `{"resource":"https://mcp.sandbox.paypal.com/http","authorization_servers":["https://mcp.sandbox.paypal.com"],"bearer_methods_supported":["header"]}`
- `GET https://mcp.sandbox.paypal.com/.well-known/oauth-protected-resource/sse` → **200**, same shape.
  **`bearer_methods_supported: ["header"]` is direct machine-readable confirmation of the `--header` flow.**
- `POST /sse` unauthenticated → **401** with
  `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…/.well-known/oauth-protected-resource/sse", error="invalid_token"`.
- `POST /http` and `GET /http` unauthenticated → **404 `Not Found`** (not 401). **My inference:** the
  streamable-HTTP route is deliberately hidden behind a 404 until a bearer token is presented, since its
  protected-resource metadata is published. I could not confirm this without credentials.

**Tool names — NOT DOCUMENTED, with the best available evidence stated separately.**

- `MCPDOC` says only: "PayPal's MCP server offers a variety of helpful tools… **The complete catalog of
  tools is available in both local and remote MCP server.**" The catalog itself is **not rendered** on that
  page (verified in both the HTML and the `.md`), and `tools/list` requires authentication, so I could not
  enumerate the live list.
- **Best available evidence** (a _different_ artefact, offered as such): the toolkit README at
  https://raw.githubusercontent.com/paypal/agent-toolkit/main/typescript/README.md — "The PayPal Agent
  toolkit provides the following tools" — lists these tool names:
  - _Invoices_: `create_invoice`, `list_invoices`, `get_invoice`, `send_invoice`, `send_invoice_reminder`,
    `cancel_sent_invoice`, `generate_invoice_qr_code`, `delete_invoice`, `generate_invoice_number`,
    `search_invoicing`, `update_invoicing`, `cancel_invoice_auto_reminder`, `record_payment_for_invoice`,
    `record_refund_for_invoice`, `create_conditional_rules_for_invoice`
  - _Recurring_: `create_recurring_series`, `activate_recurring_series`, `get_recurring_series`,
    `cancel_recurring_series`, `delete_recurring_series`
  - _Payments_: `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`
  - _Disputes_: `list_disputes`, `get_dispute`, `accept_dispute_claim`
  - _Shipment_: `create_shipment_tracking`, `get_shipment_tracking`, `update_shipment_tracking`
  - _Catalog_: `create_product`, `list_products`, `show_product_details`
  - _Subscriptions_: `create_subscription_plan`, `update_plan`, `list_subscription_plans`,
    `show_subscription_plan_details`, `create_subscription`, `show_subscription_details`,
    `update_subscription`, `cancel_subscription`
  - _Reporting_: `list_transactions`, `get_merchant_insights`
- **I am not claiming these are the MCP server's exposed names.** `@paypal/mcp` is described as "a command
  line tool for setting up PayPal MCP server" and is versioned separately from `@paypal/agent-toolkit`; the
  MCP surface may namespace them (e.g. `paypal_create_order`) or expose a subset. Where PayPal would have
  to answer: run `tools/list` against the sandbox endpoint with a real client-credentials token, or ask
  PayPal's AI-tools team.
- **Notable gap for this project:** even taking the README at face value, the dispute surface is
  **`list_disputes`, `get_dispute`, `accept_dispute_claim` only** — there is no
  `provide_dispute_evidence`, `make_dispute_offer` or `escalate_dispute` in that list. If week-1 check
  C3(b) is meant to prove that evidence submission is reachable over MCP, this evidence suggests it is not.

---

## Side note on `errors.ts` (not asked, but adjacent and cheap to check)

`ERRORS` (https://developer.paypal.com/api/errors/overview) confirms `UNPROCESSABLE_ENTITY`,
`RESOURCE_NOT_FOUND`, `PAYER_ACTION_REQUIRED`, `CARD_EXPIRED`, `DUPLICATE_INVOICE_ID`,
`ORDER_ALREADY_AUTHORIZED`, `ORDER_ALREADY_CAPTURED`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`,
`MISSING_REQUIRED_PARAMETER`, `INVALID_STRING_LENGTH`, `ITEM_TOTAL_MISMATCH`.
It does **not** contain `INSTRUMENT_DECLINED`, `PAYER_CANNOT_PAY`, `TRANSACTION_REFUSED`,
`RATE_LIMIT_REACHED`, `INVALID_REQUEST_ID`, `AUTHORIZATION_EXPIRED`, `DISPUTE_HAS_NO_EVIDENCE` or
`DISPUTE_STATE_NOT_ALLOWED`. Only `UNPROCESSABLE_ENTITY` and `RESOURCE_NOT_FOUND` appear in the OpenAPI
specs. The mappings are therefore spec-driven assumptions rather than doc citations — which is fine given
the fallback-to-status design, but the file's `[B12, V15]` provenance comments should say so.

---

# Action required

Only items where `packages/paypal/` must change. Each line names the file and the fix. Where PayPal is
silent I recommend keeping current behaviour and recording it as an assumption.

### Must change — verified factual errors

1. `src/types.ts` `simDisputeReqSchema` and `src/sandbox.ts` `createBuyerDispute` — rewrite the body: it must be `multipart/form-data` with one `input` JSON part containing `disputed_transactions[{buyer_transaction_id}]`, `reason`, `dispute_amount`, `extensions`; `transaction_id` and `dispute_reason` do not exist. (Source: `TGL`.)
2. `src/sandbox.ts` `processChargeback` — replace `{transaction_id, reason}` with PayPal's real body: `adjacency:"PAYPAL"`, `file_layout:"ATCK_CB"`, `merchant_id`, `financial_institution.processor:"FDMS"`, `transaction.{id_enc,amount}`, `instrument.instrument_type:"CARD"`, `dispute{…}`; the call returns `201 Created` with a body, so `schema: null` must become a real schema. (Source: `TGL`.)
3. `src/types.ts` `provideEvidenceInputSchema` — the multipart `input` part is `{evidences:[{evidence_type, evidence_info, notes, documents}]}`, not a bare `{evidence_type,date,notes[]}`; `notes` is a **string**, not `string[]`. (Source: `GUIDE`, `SPEC-D`.)
4. `src/types.ts` `disputeEvidenceSchema` + `disputeSchema` — the response field is `evidences` (array), not `evidence`; each entry's `notes` is a string; the item-count cap is 100. (Source: `SPEC-D` `evidence_list`, `GUIDE` sample.)
5. `src/types.ts` `disputeSchema` — rename `dispute_reason` → `reason`, `disputed_amount` → `dispute_amount`; move `seller_transaction_id`/`buyer_transaction_id` into `disputed_transactions[]` (they are the join key to our capture and are currently read from a path PayPal never sends them on); `messages[].sender` → `messages[].posted_by`.
6. `src/types.ts` `DISPUTE_STATES` — replace with the real enum `OPEN_INQUIRIES | REQUIRED_ACTION | REQUIRED_OTHER_PARTY_ACTION | UNDER_PAYPAL_REVIEW | APPEALABLE | RESOLVED`; the current list mixes `status` values in and 5 of its 10 values can never match. `APPEALABLE` is confirmed real.
7. `src/types.ts` `DISPUTE_REASONS` — drop `MERCHANDISE_OR_SERVICE_NOT_RECEIVED_2`, `REFUND_NOT_AS_DESCRIBED`, `PAYOUT_DECLINED`, `ACCOUNT_COMPROMISED`, `UNPAID_AMOUNT` (none exist); add `PAYMENT_BY_OTHER_MEANS` and `PROBLEM_WITH_REMITTANCE`.
8. `src/types.ts` `EVIDENCE_TYPES` — drop the 7 non-existent values (`CHECKOUT_PAGE`, `CANCELLED_RECURING_BILLING_AGREEMENT`, `CUSTOMER_COMMUNICATION`, `FULFILLMENT_DOCUMENTATION`, `REFUND_POLICY`, `TERMS_OF_SERVICE`, `UNCONTROLLED_WEB_CONTENT`); the 7 the spec §8.15 claims are all confirmed against the real 76-value enum.
9. `src/types.ts` `listDisputesQuerySchema` — delete `page` (not a PayPal parameter); cap `page_size` at **50**, not 500; add `disputed_transaction_id`, `update_time_before`, `update_time_after`; note that `start_time` and `next_page_token` are deprecated in favour of the response HATEOAS links. Remove `total_pages`/`total_items` from `DisputeList` (not PayPal fields).
10. `src/types.ts` `makeOfferReqSchema` + comment — `offer_type` enum is `REFUND | REFUND_WITH_RETURN | REFUND_WITH_REPLACEMENT | REPLACEMENT_WITHOUT_REFUND`; **`REFUND_NO_RETURN` does not exist**. Add the required `note` (1–2000) and the optional `return_shipping_address`/`invoice_id`; make `offer_amount` optional (omit for `REPLACEMENT_WITHOUT_REFUND`).
11. `src/types.ts` `ackReturnReqSchema` + `src/client.ts` `acknowledgeReturnItem` — body is `{note, acknowledgement_type}`; `return_shipping_address` is not an acknowledge-return-item field (it belongs to make-offer). `acknowledgement_type` ∈ `ITEM_RECEIVED | ITEM_NOT_RECEIVED | DAMAGED | EMPTY_PACKAGE_OR_DIFFERENT | MISSING_ITEMS`.
12. `src/sandbox.ts` `acceptOffer` — `{payer_note}` → `{note}`; also handle `202 Accepted` as a success (documented: refund money movement delayed).
13. `src/sandbox.ts` `changeReason` — documented encoding is `multipart/related` with an `input` part `{reason, note, item_info[]}`; `reason` alone is currently sent and `note` is a documented field.
14. `src/types.ts` `WEBHOOK_EVENT_NAMES` — remove `PAYMENT.REFUND.COMPLETED` (no such event; refund completion is `PAYMENT.CAPTURE.REFUNDED`) and add `PAYMENT.CAPTURE.DENIED` (documented and PayPal-recommended for the checkout flow). Also record that **no `PAYMENT.AUTHORIZATION.EXPIRED` exists**, so EC-TIME-5 expiry alerting must poll `expiration_time`, not rely on a webhook.
15. `src/types.ts` `setupTokenReqSchema` / `SetupTokenReq` — `usage_type` (`MERCHANT|PLATFORM`), `usage_pattern` (12 values), `customer_type` and `experience_context` all belong under **`payment_source.paypal`**, not at the top level; `user_action` is not a Vault `experience_context` field; declare `usage_type`/`usage_pattern` on `vaultPaymentSourcePaypalSchema` so they stop passing through unvalidated.
16. `src/types.ts` `paymentTokenSchema` / `PaymentToken` — drop the top-level `payer`; the payment-token response has no such field. Read the payer id from `payment_source.paypal.payer_id`, falling back to `payment_source.paypal.account_id`.
17. `src/types.ts` `disputeState`/appeal gating in `src/client.ts` `appeal` — gate on the presence of the `appeal` HATEOAS link, not `dispute_state === 'APPEALABLE'`; PayPal states the link is what determines eligibility.
18. `src/multipart.ts` — set `MAX_EVIDENCE_TOTAL_BYTES` to `50_000_000` (decimal). The current `50·2^20` is _more permissive_ than PayPal's documented "up to 50 MB", so a 51 MB upload passes locally and is rejected remotely. Consider `MAX_EVIDENCE_FILE_BYTES = 10_000_000` for symmetry.

### Must change — comment / provenance accuracy (no behaviour change)

19. `src/client.ts` `ENDPOINT_POLICIES` — `'POST /v2/checkout/orders/{id}/track'` set `sendRequestId: false`: Orders v2 `track` does **not** declare `PayPal-Request-Id`, and PayPal states tracker idempotency is the `capture_id` + `tracking_number` body pair.
20. `src/client.ts` `ENDPOINT_POLICIES` provenance comment — Vault v3 `setup-tokens` and `payment-tokens` **do** declare `PayPal-Request-Id` (with "server stores keys for 3 hours"). Keeping `sendRequestId: false` / `re-read-required` is a defensible conservatism; the comment currently says support is unverified, which is no longer true.
21. `src/idempotency.ts` `REQUEST_ID_MAX_CHARS` + module comment — keep 255 as the local budget, but record the conflict: the OpenAPI declares `maxLength: 10000`, PayPal's prose recommends UUID "because it meets the **38 single-byte character limit**", and the project's worst case is **55** (`cs:{authId}:cap:{shipmentId}`). Flag `captureRequestId` as the format that would break first if 38 is enforced.
22. `src/client.ts` `getClientToken` — the documented request includes `domains[]`, which this omits. Add it, or document why a client token is being minted at all: `SDKJS` now says client-token auth is "for Fastlane only" and client ID is recommended for everything else, and Vault v3 needs only the client-credentials token.
23. `src/multipart.ts` `EVIDENCE_INPUT_FILENAME` / module comment — PayPal's documented form is a **bare** `input` field with `;type=application/json`; sending it as a named file part adds `filename="input.json"`. Keep current behaviour (it is a superset and `FormData` handles the boundary correctly), resolve with the sandbox probe, and cite `GUIDE` in the comment.
24. `src/types.ts` `linksSchema` comment — dispute actions return **`200 OK` with `{links:[…]}`, not `204 No Content**`; `provide-evidence`, `escalate`, `appeal`, `accept-claim`, `make-offer`, `send-message`, `provide-supporting-info`, `acknowledge-return-item` are all documented as 200-with-links. The empty-body tolerance can stay (void is genuinely 204) but the TODO should be resolved.
25. `src/sandbox.ts` `unsignedAuthAssertion` — add `"typ": "JWT"` to the JOSE header to match PayPal's documented snippet verbatim (`SETUP`), and add the `DISPUTE_CREATE` / `UPDATE_BUYER` scope + buyer-consent prerequisite to `docs/HUMAN_TODO.md`, since a sandbox probe cannot proceed without it.
26. `src/types.ts` `PAYMENT_STATUSES` — it is currently a union of capture, authorization and refund statuses and is missing `PARTIALLY_CAPTURED` and `DENIED` (real authorization statuses). Either split it per resource or rename it to make the union explicit.
27. `src/types.ts` `PaymentToken` `links` on `setupTokenSchema` — the setup-token `201` returns a `rel: "confirm"` link to `/v3/vault/payment-token`; worth a comment because it is the documented alternative to calling `POST /v3/vault/payment-tokens` directly.

### Where PayPal is silent — keep current behaviour, record as an assumption

28. `src/types.ts` `changeReasonReqSchema`/`requireEvidenceReqSchema` field names, and the whole
    `POST /v2/customer-support/process-chargeback` contract, rest solely on `TGL` with no OpenAPI backing —
    note that in the file, and treat `TGL` as the citation.
29. `accept_claim_type` as a _request_ field is described in prose but absent from the OpenAPI request body.
    Keep sending it (the operation description and `GUIDE` both imply it is accepted), and mark it as the one
    item that only a sandbox probe can settle.
30. `10 MB` vs `MB` (10^6 vs 2^20) is not stated anywhere; the decimal reading in item 18 is a conservative
    choice, not a documented fact.
31. MCP tool names cannot be verified without credentials (§33). Record the `agent-toolkit` tool list as
    "best available evidence, not the MCP contract", and treat the absence of any evidence-offering tool as
    an open risk for check C3(b).
