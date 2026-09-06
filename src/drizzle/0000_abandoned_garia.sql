CREATE TYPE "public"."match_status" AS ENUM('scheduled', 'live', 'finished');--> statement-breakpoint
CREATE TABLE "commentary" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"minute" integer,
	"sequence" integer NOT NULL,
	"period" text,
	"event_type" text NOT NULL,
	"actor" text,
	"team" text,
	"message" text NOT NULL,
	"metadata" jsonb,
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"sport" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"status" "match_status" DEFAULT 'scheduled' NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"home_score" integer DEFAULT 0 NOT NULL,
	"away_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commentary" ADD CONSTRAINT "commentary_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commentary_match_id_sequence_idx" ON "commentary" USING btree ("match_id","sequence");--> statement-breakpoint
CREATE INDEX "commentary_match_id_created_at_idx" ON "commentary" USING btree ("match_id","created_at");--> statement-breakpoint
CREATE INDEX "matches_status_start_time_idx" ON "matches" USING btree ("status","start_time");--> statement-breakpoint
CREATE INDEX "matches_sport_start_time_idx" ON "matches" USING btree ("sport","start_time");