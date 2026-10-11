CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer DEFAULT 4 NOT NULL,
	"shape" text DEFAULT 'square' NOT NULL,
	"pos_x" integer DEFAULT 0 NOT NULL,
	"pos_y" integer DEFAULT 0 NOT NULL,
	"width" integer DEFAULT 2 NOT NULL,
	"height" integer DEFAULT 2 NOT NULL,
	"status" text DEFAULT 'AVAILABLE' NOT NULL,
	"current_order_id" uuid,
	"merged_into_table_id" uuid,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tables_branch_name_uq" UNIQUE("branch_id","name")
);
--> statement-breakpoint
CREATE TABLE "zone_waiters" (
	"zone_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "zone_waiters_zone_id_user_id_pk" PRIMARY KEY("zone_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"floor" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_counters" (
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_counters_branch_id_business_date_pk" PRIMARY KEY("branch_id","business_date")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name_snapshot" text NOT NULL,
	"name_en_snapshot" text,
	"base_price_satang" integer NOT NULL,
	"unit_price_satang" integer NOT NULL,
	"qty" integer NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"combo_components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allergens" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"station_code" text,
	"course" integer DEFAULT 1 NOT NULL,
	"held" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"discount_satang" integer DEFAULT 0 NOT NULL,
	"line_total_satang" integer NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'POS' NOT NULL,
	"created_by" uuid,
	"sent_at" timestamp with time zone,
	"preparing_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"served_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_no" text NOT NULL,
	"business_date" date NOT NULL,
	"channel" text NOT NULL,
	"source" text DEFAULT 'POS' NOT NULL,
	"table_id" uuid,
	"guest_count" integer DEFAULT 1 NOT NULL,
	"customer_id" uuid,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"subtotal_satang" integer DEFAULT 0 NOT NULL,
	"discount_satang" integer DEFAULT 0 NOT NULL,
	"service_charge_satang" integer DEFAULT 0 NOT NULL,
	"vat_satang" integer DEFAULT 0 NOT NULL,
	"grand_total_satang" integer DEFAULT 0 NOT NULL,
	"paid_satang" integer DEFAULT 0 NOT NULL,
	"pricing" jsonb NOT NULL,
	"note" text,
	"customer_name" text,
	"customer_phone" text,
	"external_ref" text,
	"merged_into_order_id" uuid,
	"shift_id" uuid,
	"opened_by" uuid,
	"closed_by" uuid,
	"voided_by" uuid,
	"void_reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bill_requested_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_branch_no_uq" UNIQUE("branch_id","business_date","order_no")
);
--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_waiters" ADD CONSTRAINT "zone_waiters_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_waiters" ADD CONSTRAINT "zone_waiters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_counters" ADD CONSTRAINT "order_counters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tables_zone_idx" ON "tables" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_branch_status_idx" ON "order_items" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "order_items_menu_idx" ON "order_items" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "orders_branch_status_idx" ON "orders" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "orders_branch_date_idx" ON "orders" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_active_table_uq" ON "orders" USING btree ("table_id") WHERE status in ('OPEN','BILL_REQUESTED') and table_id is not null;