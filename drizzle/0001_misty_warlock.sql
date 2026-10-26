CREATE TABLE "automation_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"scope_hash" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"output" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"environment" text DEFAULT 'cloud' NOT NULL,
	"trigger_run_id" text,
	"idempotency_key" text,
	"error" text,
	"output" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "automation_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"trigger_schedule_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"author" text DEFAULT 'user' NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"os" text,
	"agent_version" text,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"capabilities" jsonb DEFAULT '["screen","mouse","keyboard"]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "desktop_devices_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "desktop_enrollments" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"device_name" text,
	"os" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "execution_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"request" text NOT NULL,
	"environment" text,
	"status" text DEFAULT 'awaiting_execution_environment' NOT NULL,
	"reason" text,
	"options" jsonb,
	"browser_session_id" text,
	"error" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"panel_id" text,
	"automation_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"role" text NOT NULL,
	"model" text,
	"prompt" text NOT NULL,
	"result" text,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"approved_at" timestamp,
	"approval_id" uuid,
	"tool_calls" integer DEFAULT 0,
	"tokens_used" integer,
	"neurons_used" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"author" text DEFAULT 'user' NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pc_jobs" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "widgets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "execution_target" text DEFAULT 'cloud' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_schedules" ADD CONSTRAINT "automation_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_versions" ADD CONSTRAINT "widget_versions_widget_id_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_approvals_workflow_idx" ON "automation_approvals" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "automation_run_steps_run_idx" ON "automation_run_steps" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_trigger_run_unique" ON "automation_runs" USING btree ("trigger_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_idempotency_unique" ON "automation_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_runs_workflow_idx" ON "automation_runs" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "automation_runs_user_idx" ON "automation_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "automation_runs_status_idx" ON "automation_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_schedules_workflow_unique" ON "automation_schedules" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "automation_schedules_next_run_idx" ON "automation_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_unique" ON "automation_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "automation_versions_workflow_idx" ON "automation_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "desktop_devices_user_id_idx" ON "desktop_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desktop_enrollments_status_idx" ON "desktop_enrollments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "execution_tasks_user_id_idx" ON "execution_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "execution_tasks_conversation_idx" ON "execution_tasks" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "widget_versions_unique" ON "widget_versions" USING btree ("widget_id","version");--> statement-breakpoint
CREATE INDEX "widget_versions_widget_idx" ON "widget_versions" USING btree ("widget_id","version");--> statement-breakpoint
CREATE INDEX "workflows_user_updated_idx" ON "workflows" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "workflows_status_next_run_idx" ON "workflows" USING btree ("status","next_run_at");