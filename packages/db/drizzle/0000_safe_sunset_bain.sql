CREATE TYPE "public"."agent_status" AS ENUM('ACTIVE', 'SUSPENDED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."authorization_status" AS ENUM('CREATED', 'PENDING', 'CAPTURED', 'PARTIALLY_CAPTURED', 'VOIDED', 'DENIED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."budget_entry_kind" AS ENUM('RESERVE', 'RELEASE', 'COMMIT', 'REVERSE');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('PENDING', 'COMPLETED', 'DECLINED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."checkout_attempt_state" AS ENUM('CREATED', 'GATED_ALLOW', 'GATED_BLOCK', 'ORDER_CREATED', 'AUTHORIZED', 'PARTIALLY_CAPTURED', 'CAPTURED', 'VOIDED', 'AUTH_EXPIRED', 'DECLINED', 'PENDING_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."checkout_session_status" AS ENUM('CREATED', 'SUBMITTED', 'COMPLETED', 'EXPIRED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('ACTIVE', 'LOST', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."dispute_action" AS ENUM('FILE', 'OFFER', 'ACCEPT', 'MESSAGE', 'APPEAL', 'ACK_RETURN', 'SUPPORTING_INFO', 'ESCALATE');--> statement-breakpoint
CREATE TYPE "public"."dispute_defense_state" AS ENUM('NEW', 'ANALYSED', 'AWAITING_MERCHANT_APPROVAL', 'FILED', 'OFFERED', 'ACCEPTED', 'CLOSED_WON', 'CLOSED_LOST', 'CLOSED_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."dispute_liability" AS ENUM('USER_AUTHORISED', 'AGENT_FAULT', 'MERCHANT_FAULT', 'UNPROVABLE', 'ALREADY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."dispute_stage" AS ENUM('INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."gate_decision" AS ENUM('ALLOW', 'BLOCK', 'REVIEW');--> statement-breakpoint
CREATE TYPE "public"."jwks_key_role" AS ENUM('ISSUER', 'MERCHANT', 'GATE', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."jwks_key_status" AS ENUM('ACTIVE', 'RETIRED', 'COMPROMISED');--> statement-breakpoint
CREATE TYPE "public"."l1_status" AS ENUM('ACTIVE', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('DRAFT', 'PENDING_SIGNATURE', 'ACTIVE', 'SUSPENDED', 'EXHAUSTED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."order_intent" AS ENUM('AUTHORIZE', 'CAPTURE');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('ORDER_CREATED', 'AUTHORIZED', 'PARTIALLY_CAPTURED', 'CAPTURED', 'VOIDED', 'CANCELLED', 'DECLINED', 'PENDING_REVIEW', 'PAYMENT_FAILED', 'AUTH_EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_kind" AS ENUM('EXPORT', 'ERASE');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_status" AS ENUM('RECEIVED', 'IN_PROGRESS', 'BLOCKED_LEGAL_HOLD', 'SCHEDULED', 'COMPLETED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."refund_initiated_by" AS ENUM('USER', 'MERCHANT', 'DEFENDER', 'DISPUTE');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('SHIPPED', 'DELIVERED', 'NOT_SHIPPED', 'VOIDED', 'FAILURE');--> statement-breakpoint
CREATE TYPE "public"."wallet_cap_period" AS ENUM('DAY', 'MONTH');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('ACTIVE', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."webhook_verified" AS ENUM('PENDING', 'VERIFIED', 'FAILED');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"kid" text NOT NULL,
	"enc_private_key" "bytea" NOT NULL,
	"status" "agent_status" DEFAULT 'ACTIVE' NOT NULL,
	"rotated_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"details" jsonb,
	"prev_hash" text,
	"this_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"paypal_authorization_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "authorization_status" DEFAULT 'CREATED' NOT NULL,
	"expiration_time" timestamp with time zone NOT NULL,
	"honor_expires_at" timestamp with time zone NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_accounts" (
	"mandate_id" text PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"cap_minor" bigint NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"spent_minor" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_accounts_reserved_plus_spent_le_cap" CHECK ("budget_accounts"."reserved_minor" + "budget_accounts"."spent_minor" <= "budget_accounts"."cap_minor"),
	CONSTRAINT "budget_accounts_non_negative" CHECK ("budget_accounts"."reserved_minor" >= 0 AND "budget_accounts"."spent_minor" >= 0),
	CONSTRAINT "budget_accounts_cap_non_negative" CHECK ("budget_accounts"."cap_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"attempt_id" text,
	"kind" "budget_entry_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"capture_id" text,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_entries_amount_non_negative" CHECK ("budget_entries"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"authorization_id" text,
	"paypal_capture_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"final_capture" boolean DEFAULT false NOT NULL,
	"status" "capture_status" DEFAULT 'PENDING' NOT NULL,
	"shipment_id" text,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"reversed" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captures_amount_minor_non_negative" CHECK ("captures"."amount_minor" >= 0),
	CONSTRAINT "captures_refunded_lte_amount" CHECK ("captures"."refunded_minor" <= "captures"."amount_minor")
);
--> statement-breakpoint
CREATE TABLE "checkout_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"checkout_session_id" text NOT NULL,
	"l3a" text NOT NULL,
	"l3b" text NOT NULL,
	"l3_jti" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"payee" text NOT NULL,
	"state" "checkout_attempt_state" DEFAULT 'CREATED' NOT NULL,
	"gate_decision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"cart" jsonb NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"shipping_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"checkout_jwt" text NOT NULL,
	"checkout_hash" text NOT NULL,
	"price_lock_exp" timestamp with time zone NOT NULL,
	"status" "checkout_session_status" DEFAULT 'CREATED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_sessions_total_matches_parts" CHECK ("checkout_sessions"."total_minor" = "checkout_sessions"."subtotal_minor" + "checkout_sessions"."tax_minor" + "checkout_sessions"."shipping_minor")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"jkt" text NOT NULL,
	"label" text NOT NULL,
	"webauthn_credential_id" text,
	"status" "device_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"action" "dispute_action" NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"actor" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"paypal_dispute_id" text NOT NULL,
	"order_id" text,
	"capture_id" text,
	"reason" text NOT NULL,
	"stage" "dispute_stage" NOT NULL,
	"status" "dispute_status" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"seller_response_due_date" timestamp with time zone,
	"buyer_response_due_date" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"defense_state" "dispute_defense_state" DEFAULT 'NEW' NOT NULL,
	"liability" "dispute_liability",
	"router_trace" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_packets" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"bundle" jsonb NOT NULL,
	"bundle_hash" text NOT NULL,
	"pdf_bytes" "bytea",
	"pdf_sha256" text,
	"notes" text,
	"citations" jsonb,
	"citation_check" jsonb,
	"filed_at" timestamp with time zone,
	"paypal_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_packets_notes_le_2000" CHECK ("evidence_packets"."notes" IS NULL OR char_length("evidence_packets"."notes") <= 2000),
	CONSTRAINT "evidence_packets_version_positive" CHECK ("evidence_packets"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"decision" "gate_decision" NOT NULL,
	"reasons" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"chain_valid" boolean NOT NULL,
	"vi_lib_commit" text NOT NULL,
	"signed_record" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"budget_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT 'job' NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retryLimit" smallint DEFAULT 2 NOT NULL,
	"retryDelay" integer DEFAULT 0 NOT NULL,
	"retryBackoff" boolean DEFAULT false NOT NULL,
	"startAfter" text DEFAULT now()::text NOT NULL,
	"singletonOn" text,
	"singletonKey" text,
	"createdOn" timestamp DEFAULT now() NOT NULL,
	"completedOn" timestamp,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"role" "jwks_key_role" NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"status" "jwks_key_status" DEFAULT 'ACTIVE' NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jwks_keys_not_after_gt_not_before" CHECK ("jwks_keys"."not_after" IS NULL OR "jwks_keys"."not_after" > "jwks_keys"."not_before")
);
--> statement-breakpoint
CREATE TABLE "l1_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"sd_jwt" text NOT NULL,
	"issuer_kid" text NOT NULL,
	"iat" bigint NOT NULL,
	"exp" bigint NOT NULL,
	"status" "l1_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l1_credentials_exp_gt_iat" CHECK ("l1_credentials"."exp" > "l1_credentials"."iat")
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"l2_serialized" text NOT NULL,
	"l2_payload" jsonb NOT NULL,
	"nl_intent" text NOT NULL,
	"readback" text NOT NULL,
	"constraints" jsonb NOT NULL,
	"nonce" text NOT NULL,
	"aud" text NOT NULL,
	"iat" bigint NOT NULL,
	"exp" bigint NOT NULL,
	"status" "mandate_status" DEFAULT 'DRAFT' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"webauthn_assertion" jsonb,
	"compiler_model" text NOT NULL,
	"compiler_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_exp_gt_iat" CHECK ("mandates"."exp" > "mandates"."iat")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"paypal_order_id" text NOT NULL,
	"intent" "order_intent" NOT NULL,
	"custom_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"status" "order_status" DEFAULT 'ORDER_CREATED' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"payment_token_id" text NOT NULL,
	"payer_id" text NOT NULL,
	"payer_email" text NOT NULL,
	"status" "wallet_status" DEFAULT 'ACTIVE' NOT NULL,
	"customer_id" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "privacy_request_kind" NOT NULL,
	"status" "privacy_request_status" DEFAULT 'RECEIVED' NOT NULL,
	"legal_hold_reason" text,
	"scheduled_for" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"sku" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"stock" integer NOT NULL,
	"ships_in_days" integer NOT NULL,
	"digital" boolean DEFAULT false NOT NULL,
	"listing_html" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_minor_non_negative" CHECK ("products"."price_minor" >= 0),
	CONSTRAINT "products_stock_non_negative" CHECK ("products"."stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_id" text NOT NULL,
	"paypal_refund_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "refund_status" DEFAULT 'PENDING' NOT NULL,
	"reason_code" text,
	"initiated_by" "refund_initiated_by" NOT NULL,
	"actor" text,
	"note" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_minor_non_negative" CHECK ("refunds"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"lines" jsonb NOT NULL,
	"carrier" text NOT NULL,
	"tracking_number" text NOT NULL,
	"paypal_tracker_id" text,
	"status" "shipment_status" DEFAULT 'SHIPPED' NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"persona" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"country" char(2) NOT NULL,
	"dpdp_notice_ack_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_caps" (
	"wallet_id" text PRIMARY KEY NOT NULL,
	"period" "wallet_cap_period" NOT NULL,
	"cap_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_caps_cap_non_negative" CHECK ("wallet_caps"."cap_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"create_time" timestamp with time zone NOT NULL,
	"verified" "webhook_verified" DEFAULT 'PENDING' NOT NULL,
	"verified_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_accounts" ADD CONSTRAINT "budget_accounts_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entries" ADD CONSTRAINT "budget_entries_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_actions" ADD CONSTRAINT "dispute_actions_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_attempt_id_checkout_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."checkout_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l1_credentials" ADD CONSTRAINT "l1_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l1_credentials" ADD CONSTRAINT "l1_credentials_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l1_credentials" ADD CONSTRAINT "l1_credentials_wallet_id_paypal_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."paypal_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_wallet_id_paypal_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."paypal_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_attempt_id_checkout_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."checkout_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_wallets" ADD CONSTRAINT "paypal_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_caps" ADD CONSTRAINT "wallet_caps_wallet_id_paypal_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."paypal_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_user_id_status_idx" ON "agents" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_kid_key" ON "agents" USING btree ("kid");--> statement-breakpoint
CREATE INDEX "audit_log_chain_id_at_idx" ON "audit_log" USING btree ("chain_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_chain_id_this_hash_key" ON "audit_log" USING btree ("chain_id","this_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "authorizations_paypal_authorization_id_key" ON "authorizations" USING btree ("paypal_authorization_id");--> statement-breakpoint
CREATE INDEX "authorizations_order_id_idx" ON "authorizations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "authorizations_status_expiration_time_idx" ON "authorizations" USING btree ("status","expiration_time");--> statement-breakpoint
CREATE INDEX "budget_entries_mandate_id_at_idx" ON "budget_entries" USING btree ("mandate_id","at");--> statement-breakpoint
CREATE INDEX "budget_entries_attempt_id_idx" ON "budget_entries" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "budget_entries_mandate_id_kind_at_idx" ON "budget_entries" USING btree ("mandate_id","kind","at");--> statement-breakpoint
CREATE UNIQUE INDEX "captures_paypal_capture_id_key" ON "captures" USING btree ("paypal_capture_id");--> statement-breakpoint
CREATE INDEX "captures_order_id_idx" ON "captures" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "captures_status_updated_at_idx" ON "captures" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_l3_jti_key" ON "checkout_attempts" USING btree ("l3_jti");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_idempotency_key_key" ON "checkout_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "checkout_attempts_mandate_id_idx" ON "checkout_attempts" USING btree ("mandate_id");--> statement-breakpoint
CREATE INDEX "checkout_attempts_checkout_session_id_idx" ON "checkout_attempts" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE INDEX "checkout_attempts_mandate_id_created_at_idx" ON "checkout_attempts" USING btree ("mandate_id","created_at");--> statement-breakpoint
CREATE INDEX "checkout_sessions_status_price_lock_exp_idx" ON "checkout_sessions" USING btree ("status","price_lock_exp");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_id_jkt_key" ON "devices" USING btree ("user_id","jkt");--> statement-breakpoint
CREATE INDEX "devices_user_id_status_idx" ON "devices" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_actions_idempotency_key_key" ON "dispute_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "dispute_actions_dispute_id_at_idx" ON "dispute_actions" USING btree ("dispute_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_paypal_dispute_id_key" ON "disputes" USING btree ("paypal_dispute_id");--> statement-breakpoint
CREATE INDEX "disputes_defense_state_idx" ON "disputes" USING btree ("defense_state");--> statement-breakpoint
CREATE INDEX "disputes_seller_response_due_date_idx" ON "disputes" USING btree ("seller_response_due_date");--> statement-breakpoint
CREATE INDEX "disputes_status_updated_at_idx" ON "disputes" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "disputes_order_id_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "evidence_packets_dispute_id_idx" ON "evidence_packets" USING btree ("dispute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_packets_dispute_id_version_key" ON "evidence_packets" USING btree ("dispute_id","version");--> statement-breakpoint
CREATE INDEX "gate_decisions_attempt_id_idx" ON "gate_decisions" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "gate_decisions_decision_decided_at_idx" ON "gate_decisions" USING btree ("decision","decided_at");--> statement-breakpoint
CREATE INDEX "jobs_name_start_after_idx" ON "jobs" USING btree ("name","startAfter");--> statement-breakpoint
CREATE INDEX "jobs_singleton_key_idx" ON "jobs" USING btree ("singletonKey");--> statement-breakpoint
CREATE INDEX "jwks_keys_role_status_idx" ON "jwks_keys" USING btree ("role","status");--> statement-breakpoint
CREATE UNIQUE INDEX "l1_credentials_device_id_wallet_id_key" ON "l1_credentials" USING btree ("device_id","wallet_id");--> statement-breakpoint
CREATE INDEX "l1_credentials_user_id_status_idx" ON "l1_credentials" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "mandates_wallet_id_status_idx" ON "mandates" USING btree ("wallet_id","status");--> statement-breakpoint
CREATE INDEX "mandates_user_id_status_idx" ON "mandates" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "mandates_agent_id_status_idx" ON "mandates" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_paypal_order_id_key" ON "orders" USING btree ("paypal_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_attempt_id_key" ON "orders" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "orders_custom_id_idx" ON "orders" USING btree ("custom_id");--> statement-breakpoint
CREATE INDEX "orders_status_updated_at_idx" ON "orders" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_wallets_payment_token_id_key" ON "paypal_wallets" USING btree ("payment_token_id");--> statement-breakpoint
CREATE INDEX "paypal_wallets_user_id_idx" ON "paypal_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_user_id_created_at_idx" ON "privacy_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_scheduled_for_idx" ON "privacy_requests" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "products_price_idx" ON "products" USING btree ("price_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_paypal_refund_id_key" ON "refunds" USING btree ("paypal_refund_id");--> statement-breakpoint
CREATE INDEX "refunds_capture_id_idx" ON "refunds" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "refunds_status_created_at_idx" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_paypal_tracker_id_key" ON "shipments" USING btree ("paypal_tracker_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_number_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_paypal_event_id_key" ON "webhook_events" USING btree ("paypal_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_resource_id_idx" ON "webhook_events" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "webhook_events_processed_at_received_at_idx" ON "webhook_events" USING btree ("processed_at","received_at");