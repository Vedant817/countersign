# Merchant persistence verification

Date: 24 October 2026 (IST). Base: `32397d1`. Branch: `wp/09-merchant-persistence`.

## Reproductions and implementation

The original store ignored products/checkout repositories and always read SEED_PRODUCTS plus process-global stock and session maps. Against the original catalog, all five initial regression tests failed. A targeted baseline rerun of the reload test created a session, removed `globalThis.__countersignShopState`, reset the module graph, and then observed `{ok:true,value:undefined}`. This reproduces loss of process-local state; it is not a physical PostgreSQL restart test.

`shopCatalog` now delegates catalog reads to the existing product repositories and session inserts/lookups to checkout repositories whenever DATABASE_URL is configured. It does not fall back to seeds on a DB failure. DB prices, stock, titles, shipping times, descriptions and listing HTML are returned, with the existing untrusted wrappers. `isInjectionSku` is preserved. DB cart JSON stores `unit_minor` as canonical decimal strings; reload validates every line, quantity, title, amount, currency, date, identity and subtotal/total relationship before constructing the merchant session. Numeric JSON units are rejected, including otherwise small numbers: precision cannot be inferred from an already parsed JSON number. Invalid or legacy rows without titles fail closed rather than acquiring invented titles. Units greater than Number.MAX_SAFE_INTEGER round-trip exactly in the regression suite.

New rows use DB status CREATED, translated to the merchant port's OPEN on read. Terminal statuses remain terminal; expired price-lock dates are preserved for Gate enforcement. Duplicate inserts use repository conflict handling; there is no in-memory overwrite path.

`shopCheckout.findOrderByAttempt` calls the compatible existing order repository and maps its stored amount/currency/status. Missing rows are returned only after an actual successful lookup; repository failures propagate. Checkout JWT creation retains the real configured VI client and now also requires DB persistence configuration. Tests make no PayPal or VI requests and invent no orders outside repository test data.

No schema, core types, manifests, other packages, UI, checkout routes or MCP/auth files were changed. Read AGENTS.md, apps/web/AGENTS.md, spec sections 7, 8.9, WP-09 and relevant price/stock cases. Read the installed Next 16.3.8 guide `apps/web/node_modules/next/dist/docs/01-app/02-guides/data-security.md`; these adapters remain server-only.

## Parent integration contract

- Export `shopCatalogMode()` returns `database`, `demo-browse-only`, or `unavailable`; UI can display this mode.
- Without DATABASE_URL, browsing is disabled by default. `COUNTERSIGN_DEMO_CATALOG=1` explicitly enables seed listing only when NODE_ENV is not production. There is no stock/session persistence or purchase authority in this mode. `findProductBySku` refuses demo authority because create_checkout uses it for signed prices; product detail UI should use the browse list for any explicitly labeled demonstration view.
- Production ignores the demo opt-in. A configured but unreachable DB returns repository errors, never seed authority.
- `withShopTransaction(fn)` accepts a callback returning Result and returns Result. It opens an actual existing DB transaction and throws failed callback Results internally to force rollback, since @countersign/db.withTx otherwise commits returned errors. Stock operations accept only the active handle supplied by this helper; fabricated, expired, or independently supplied handles fail closed. Callback callers must propagate failed operation Results; ignoring a failure and returning success commits successful prior operations.
- This helper is deliberately not a drop-in for MerchantDeps.withTx's generic unwrapped Promise contract. The composition owner must adapt the error/rollback boundary explicitly. Current MCP's placeholder transaction handle cannot authorize stock writes. No process mutex is offered as a substitute for a DB transaction.
- Session create/read optionally accept an active helper handle for atomic composition; without one they use individual repository statements. Creating a price lock does not reserve/decrement stock; stock remains an ORDER_CREATED responsibility.
- Existing MCP search test assumes implicit demo seeds. Owner should explicitly opt into demo in that test, or inject a DB repository fixture. Default no-DB behavior should remain fail-closed.

## Validation evidence

- Initial regression run against original catalog: 5 failures, including seed authority, missing repository persistence, conflicts hidden, missing DB accepted and invalid stock writes.
- Targeted original-catalog reload run: expected failure with missing checkout after clearing process state.
- Final focused regression suite: 20 passing tests, using repository doubles only.
- Default web suite: 59 passed, 1 failed (MCP search assumes implicit seed browsing).
- Web suite with explicit `COUNTERSIGN_DEMO_CATALOG=1`: 60 passed, 5 test files.
- Focused ESLint: passed; web typecheck: passed. Further build/root-check results are recorded below.

## Acceptance limits and required setup

A migrated/seeded PostgreSQL instance and DATABASE_URL supplied privately by the parent are needed to prove durable reload across actual server processes, row-lock contention, and rollback in PostgreSQL. Docker/global infrastructure was not managed, credentials were not read, no external services were contacted for purchases, and no payment was attempted. Repository-double reload/transaction tests prove adapter routing/validation only, not PostgreSQL durability or locking.

The existing public types do not block the persistence adapter or order lookup. Transaction composition still requires owner integration under the contract above. DB product rows are a shared catalog with no merchant column under the existing schema; this patch does not invent merchant isolation that the schema cannot provide.

Additional checks on the restored final implementation:

- `pnpm typecheck`: passed across all workspace packages, worker and web.
- `pnpm --filter @countersign/web build`: passed (Next 16.3.8 production build, all listed routes generated).
- `pnpm secret-scan`: passed both working-tree and history scans; 184 commits scanned with no leaks.
- Scoped Prettier check and `git diff --check`: passed.

One earlier build overlapped the intentional baseline-source reproduction and consequently typechecked that temporary old file. It is superseded by the clean successful build above; no artifact from that interrupted validation is acceptance evidence.

- `COUNTERSIGN_DEMO_CATALOG=1 pnpm test` (PowerShell process-local environment): 90 test files passed, 2,526 tests passed, 30 skipped. This is the ordinary local suite, not live PayPal/PostgreSQL acceptance. Without demo opt-in, the one MCP search integration expectation described above must be updated by its owner.
- `pnpm lint`: passed repository-wide ESLint and money-discipline scan (117 files across 15 roots).
