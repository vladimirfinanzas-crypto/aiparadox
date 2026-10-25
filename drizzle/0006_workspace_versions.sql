-- Workspace versioning — additive only.
--
-- A panel's document (its blocks) is what Godfather rewrites. Keeping every
-- structural version lets a person see what changed and go back to a version
-- that worked, while the data they typed (rows, ticks, events, form values)
-- stays with the blocks that survived.

alter table "widgets"
  add column if not exists "version" integer not null default 1;

create table if not exists "widget_versions" (
  "id" uuid primary key default gen_random_uuid(),
  "widget_id" text not null references "widgets"("id") on delete cascade,
  "user_id" text not null,
  "version" integer not null,
  "name" text not null,
  "document" jsonb not null,
  "author" text not null default 'user',
  "summary" text,
  "created_at" timestamp with time zone not null default now(),
  constraint "widget_versions_author_check" check ("author" in ('user', 'godfather', 'migration')),
  constraint "widget_versions_unique" unique ("widget_id", "version")
);

create index if not exists "widget_versions_widget_idx"
  on "widget_versions" ("widget_id", "version" desc);

-- The library lists by most recent activity.
create index if not exists "widgets_user_updated_idx"
  on "widgets" ("user_id", "updated_at" desc);

-- Baseline for panels that already existed before versioning: their current
-- document becomes version 1 (attributed to the person, not to Godfather), so
-- the first change has something to compare against and to revert to. The
-- stored value is the panel's own config; it is normalized the same way the
-- runtime normalizes every document it reads.
insert into "widget_versions" ("widget_id", "user_id", "version", "name", "document", "author", "summary")
select w."id", w."user_id", w."version", w."name", w."config", 'migration', 'Versión inicial'
from "widgets" w
where not exists (
  select 1 from "widget_versions" v
  where v."widget_id" = w."id" and v."version" = w."version"
);
