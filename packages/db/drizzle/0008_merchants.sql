CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"paypal_merchant_id" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_status_check" CHECK ("merchants"."status" IN ('ACTIVE', 'SUSPENDED'))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merchant_id" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_owner_user_id_key" ON "merchants" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_paypal_merchant_id_key" ON "merchants" USING btree ("paypal_merchant_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_merchant_id_idx" ON "orders" USING btree ("merchant_id");