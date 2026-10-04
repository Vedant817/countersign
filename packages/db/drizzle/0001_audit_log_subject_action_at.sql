-- Audit log lookup for the Defender's R-UNAUTH-2: "was this device already reported
-- lost before the mandate was signed?". Replaces the (subject)-only index rather than adding a
-- second one, because this serves the privacy export and the dispute timeline too, and the prefix
-- rule means it serves both with one btree.
--
-- No devices.lost_at column is added on purpose: this row is hash-chained to its predecessor, so a
-- rewritten entry breaks the chain, whereas a mutable column can be updated silently. See
-- docs/DECISIONS.md D-024.
DROP INDEX "audit_log_subject_idx";--> statement-breakpoint
CREATE INDEX "audit_log_subject_action_at_idx" ON "audit_log" USING btree ("subject","action","at");