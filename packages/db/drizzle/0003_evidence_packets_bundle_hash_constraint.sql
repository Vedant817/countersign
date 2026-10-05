-- Two additions to evidence_packets, both reported by WP-18 (docs/DECISIONS.md D-030).
--
-- 1. A CHECK constraining bundle_hash to 43 base64url characters. The comment on that column
--    already said it equals the custom_id payload, and custom_id is base64url -- but nothing
--    enforced it. A SHA-256 digest is 32 bytes, so base64url of it is always exactly 43
--    characters, unpadded. Without this constraint a hex digest stores happily and then fails
--    every comparison, and disputes.ts finds packets BY this column -- so the symptom would be
--    "no packet with that id" for a packet that plainly exists. A wrong answer to "is this
--    genuine?" has to be loud, and a failed lookup is the quietest way to be wrong.
--
-- 2. An index on the same column, for the same reason: that lookup otherwise seq-scans once
--    per dispute.
--
-- Additive only. A database already holding packets written as base64url is unaffected; one
-- holding hex now fails loudly on this migration instead of silently forever, which is the
-- whole improvement.
CREATE INDEX "evidence_packets_bundle_hash_idx" ON "evidence_packets" USING btree ("bundle_hash");--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_bundle_hash_is_base64url_sha256" CHECK ("evidence_packets"."bundle_hash" ~ '^[A-Za-z0-9_-]{43}$');