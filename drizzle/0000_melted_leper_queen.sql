CREATE TYPE "public"."agent_kind" AS ENUM('chat', 'browser', 'computer', 'social');--> statement-breakpoint
CREATE TYPE "public"."agent_source" AS ENUM('default', 'user', 'ai');--> statement-breakpoint
CREATE TYPE "public"."chat_kind" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."pc_job_status" AS ENUM('pending', 'claimed', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('ai', 'sandbox', 'browser', 'social');--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"avatar" text NOT NULL,
	"job" text NOT NULL,
	"instructions" text,
	"sandbox_id" text,
	"kind" "agent_kind" DEFAULT 'chat' NOT NULL,
	"source" "agent_source" DEFAULT 'user' NOT NULL,
	"model" text,
	"output_format" text DEFAULT 'markdown' NOT NULL,
	"tools" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"role" text
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"chat_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_members_chat_id_bot_id_pk" PRIMARY KEY("chat_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "chat_kind" DEFAULT 'direct' NOT NULL,
	"name" text,
	"last_message_preview" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"zernio_profile_id" text,
	"pc_agent_token" text,
	"pc_agent_status" text DEFAULT 'offline' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pc_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" jsonb NOT NULL,
	"status" "pc_job_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"amount" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_entries_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "widgets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"graph" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bots_user_id_idx" ON "bots" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bots_user_id_name_unique" ON "bots" USING btree ("user_id",lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "chat_members_bot_id_idx" ON "chat_members" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "chats_user_id_idx" ON "chats" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pc_jobs_user_id_status_idx" ON "pc_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "usage_entries_user_id_created_at_idx" ON "usage_entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "widgets_user_id_idx" ON "widgets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "widgets_user_id_order_idx" ON "widgets" USING btree ("user_id","order");--> statement-breakpoint
CREATE INDEX "widgets_user_id_published_idx" ON "widgets" USING btree ("user_id","is_published");--> statement-breakpoint
CREATE INDEX "workflows_user_id_idx" ON "workflows" USING btree ("user_id");