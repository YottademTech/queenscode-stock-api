CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "adjustments_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"stocktake_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"counter" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustments_quantity" CHECK ("adjustments"."quantity" >= 0),
	CONSTRAINT "adjustments_kind" CHECK ("adjustments"."kind" in ('correct', 'add', 'remove'))
);
--> statement-breakpoint
CREATE TABLE "claude_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"decimals" smallint NOT NULL,
	CONSTRAINT "currencies_decimals" CHECK ("currencies"."decimals" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "handled_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"handled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stocktake_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"full_cartons" integer NOT NULL,
	"pack_size" integer,
	"loose_pieces" integer NOT NULL,
	"confidence" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"counter" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_counts_numbers" CHECK ("photo_counts"."full_cartons" >= 0 and "photo_counts"."loose_pieces" >= 0 and "photo_counts"."pack_size" >= 0),
	CONSTRAINT "photo_counts_confidence" CHECK ("photo_counts"."confidence" in ('High', 'Medium', 'Low'))
);
--> statement-breakpoint
CREATE TABLE "product_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"barcode" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"expiry" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"variant" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"batch_number" text DEFAULT '' NOT NULL,
	"manufacture_date" text DEFAULT '' NOT NULL,
	"manufacturer" text DEFAULT '' NOT NULL,
	"country_of_origin" text DEFAULT '' NOT NULL,
	"ingredients" text DEFAULT '' NOT NULL,
	"directions" text DEFAULT '' NOT NULL,
	"other_details" text DEFAULT '' NOT NULL,
	"label_text" text DEFAULT '' NOT NULL,
	"qr_code" text DEFAULT '' NOT NULL,
	"pack_size" integer,
	"reorder_level" integer,
	"price_minor" bigint,
	"currency_code" char(3),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_numbers" CHECK ("products"."pack_size" >= 0 and "products"."reorder_level" >= 0 and "products"."price_minor" >= 0),
	CONSTRAINT "products_price_has_currency" CHECK (("products"."price_minor" is null) = ("products"."currency_code" is null))
);
--> statement-breakpoint
CREATE TABLE "sheet_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sheet_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"time_zone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shops_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "stocktakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"count_date" date NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_stocktake_id_stocktakes_id_fk" FOREIGN KEY ("stocktake_id") REFERENCES "public"."stocktakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_counts" ADD CONSTRAINT "photo_counts_stocktake_id_stocktakes_id_fk" FOREIGN KEY ("stocktake_id") REFERENCES "public"."stocktakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_counts" ADD CONSTRAINT "photo_counts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_counts" ADD CONSTRAINT "photo_counts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjustments_lookup" ON "adjustments" USING btree ("stocktake_id","product_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_shop_name" ON "locations" USING btree ("shop_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_shop_position" ON "locations" USING btree ("shop_id","position");--> statement-breakpoint
CREATE INDEX "photo_counts_lookup" ON "photo_counts" USING btree ("stocktake_id","product_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_photos_order" ON "product_photos" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "products_shop_code" ON "products" USING btree ("shop_id","code") WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_shop_name" ON "products" USING btree ("shop_id",lower("name")) WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "products_shop_barcode" ON "products" USING btree ("shop_id","barcode");--> statement-breakpoint
CREATE INDEX "sheet_outbox_waiting" ON "sheet_outbox" USING btree ("id") WHERE "sheet_outbox"."delivered_at" is null and "sheet_outbox"."failed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stocktakes_shop_date" ON "stocktakes" USING btree ("shop_id","count_date");--> statement-breakpoint
CREATE UNIQUE INDEX "stocktakes_one_current" ON "stocktakes" USING btree ("shop_id") WHERE "stocktakes"."is_current";