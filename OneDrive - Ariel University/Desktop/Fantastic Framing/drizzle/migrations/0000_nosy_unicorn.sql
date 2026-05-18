CREATE TABLE "artist_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"default_shipping_notes" text,
	"product_notes" text,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_profiles_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"sender" text NOT NULL,
	"subject" text,
	"received_at" timestamp with time zone NOT NULL,
	"raw_body_text" text,
	"raw_body_html" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"shopify_draft_id" text,
	"error" text,
	"attachments" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "extraction_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_id" integer NOT NULL,
	"model_response_json" jsonb,
	"validation_errors" text[],
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extraction_log" ADD CONSTRAINT "extraction_log_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE no action ON UPDATE no action;