CREATE TYPE "public"."user_role" AS ENUM('SUPER_ADMIN', 'ADMIN', 'SALES', 'ESTIMATOR', 'PROJECT_MANAGER');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."activity_event_type" AS ENUM('job_opened', 'scan_run', 'sign_updated', 'pdf_exported', 'xlsx_exported');--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"full_name" text,
	"email" text,
	"role" "user_role" DEFAULT 'SALES' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"website" text,
	"logo_url" text,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"image_input_tokens" integer DEFAULT 0 NOT NULL,
	"image_output_tokens" integer DEFAULT 0 NOT NULL,
	"compare_text_input_tokens" integer DEFAULT 0 NOT NULL,
	"compare_text_output_tokens" integer DEFAULT 0 NOT NULL,
	"project_address" text,
	"project_city" text,
	"project_state" text,
	"scan_method" text DEFAULT 'gemini',
	"processing_log" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"stored_path" text NOT NULL,
	"page_count" integer,
	"extracted_text" text,
	"page_stats" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_signs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"job_file_id" uuid,
	"sheet_number" text,
	"detail_reference" text,
	"sign_type" text,
	"sign_identifier" text,
	"quantity" integer,
	"location" text,
	"dimensions" text,
	"mounting_type" text,
	"finish_color" text,
	"illumination" text,
	"materials" text,
	"message_content" text,
	"notes" text,
	"page_number" integer,
	"x_pos" real,
	"y_pos" real,
	"ai_x_pos" real,
	"ai_y_pos" real,
	"placement_source" text,
	"extraction_method" text DEFAULT 'text',
	"paired_sign_id" uuid,
	"ada_required" boolean DEFAULT false,
	"manually_added" boolean DEFAULT false NOT NULL,
	"user_verified" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"confidence_score" real DEFAULT 0 NOT NULL,
	"review_flag" boolean DEFAULT false NOT NULL,
	"raw_json" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"user_initials" text NOT NULL,
	"job_id" uuid,
	"job_name" text,
	"event_type" "activity_event_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_files" ADD CONSTRAINT "job_files_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_signs" ADD CONSTRAINT "extracted_signs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_signs" ADD CONSTRAINT "extracted_signs_job_file_id_job_files_id_fk" FOREIGN KEY ("job_file_id") REFERENCES "public"."job_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_signs" ADD CONSTRAINT "extracted_signs_paired_sign_id_extracted_signs_id_fk" FOREIGN KEY ("paired_sign_id") REFERENCES "public"."extracted_signs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_logs_job_id_created_at_idx" ON "activity_logs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_logs_org_id_created_at_idx" ON "activity_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_logs_user_id_created_at_idx" ON "activity_logs" USING btree ("user_id","created_at");