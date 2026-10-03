# DECISIONS

Every deviation from `docs/spec/countersign-blueprint.md`, every fallback taken because reality
contradicted the spec, and every judgement call that a judge could reasonably challenge.

Format: date, decision, reason, evidence (links or command output). Newest at the bottom.

---

## D-000 — Repo layout follows spec §5 exactly

**Date:** 2026-10-04
**Decision:** Adopt the spec's tree verbatim (`apps/web`, `apps/worker`, `apps/vi`,
`packages/{core,db,paypal,vi-client,gate,orders,ledger,webhooks,agent,compiler,defender,evidence-pdf,privacy,evals}`).
**Reason:** The blueprint's module contracts (§8) and work plan (§15) reference these paths by name.
**Evidence:** `docs/spec/countersign-blueprint.md` §5.

## D-001 — Spec is committed under `docs/spec/`, not the repo root

**Date:** 2026-10-04
**Decision:** Moved `countersign-blueprint.md` / `.pdf` to `docs/spec/`.
**Reason:** The spec's own §5 tree lists `docs/` for documentation; keeping the root clean avoids
two 155 KB/2.5 MB files sitting next to `package.json`.
**Evidence:** AGENTS.md links the new path.