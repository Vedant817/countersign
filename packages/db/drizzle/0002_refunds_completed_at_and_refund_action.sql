-- Two additive changes, both reported by WP-15e reviewing the Defender against the schema:
--
-- 1. `refunds.completed_at`. R-REF-1 asks "have we already refunded this?", which is a question
--    about SETTLED money. PayPal settles a refund days after we create it, so `created_at` answers
--    "yes" for a refund that later failed and for one still in flight. Wrong in both directions:
--    contesting an already-refunded capture wastes a response attempt, and accepting a claim we
--    already paid costs the money twice. Spec 7.2 lists no such column; see DECISIONS D-028.
--
-- 2. `dispute_action` gains `REFUND`. Spec 7.2 lists eight values and none of them is a refund, so a
--    REFUND-posture dispute was recorded as ACCEPT. ACCEPT means "we conceded the buyer's claim to
--    PayPal"; a refund issued in settlement is a different act. `R-OTHER-REFUND` alone refunds by
--    default, so this was the most common outcome in the product and the least accurate field.
--    See DECISIONS D-028.
--
-- Both are additive: no data is rewritten and no column is dropped, so this is safe to apply to a
-- database that already holds disputes.
ALTER TYPE "public"."dispute_action" ADD VALUE 'REFUND';--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "refunds_capture_completed_at_idx" ON "refunds" USING btree ("capture_id","completed_at");