-- SPDX-FileCopyrightText: 2026 David Rukahu
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Tenant model and row-level security.
--
-- PRD §11.1 is emphatic and this file implements it literally:
--   * RLS is a second boundary, not the only one.
--   * Production application roles MUST NOT own tenant tables or hold BYPASSRLS.
--   * Background jobs MUST set an explicit tenant context.
--
-- The role split is the load-bearing part. bf_migrator owns every object and is used only by
-- migrations; bf_app owns nothing, holds no BYPASSRLS, and is the only role the application uses.
-- An owner is exempt from its own RLS policies unless FORCE ROW LEVEL SECURITY is set, so both are
-- applied: the application cannot become an owner, and an owner cannot bypass the policy anyway.

-- Schemas separated by trust class. Open-data schemas are never joined into core tables — the
-- licence boundary is expressed as an absent foreign key, which is checkable.
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS audit;
-- Open data lives in its own schema, its own lineage class. ODbL and CC BY-SA are incompatible
-- copylefts, so OSM and cell data never share a derived database either.
CREATE SCHEMA IF NOT EXISTS osm_snapshot;
-- Cell data is a separate lineage class again. OSM is ODbL, OpenCellID is CC BY-SA 4.0, and
-- Creative Commons has never designated ODbL as BY-SA-compatible — a derived database holding both
-- would owe two irreconcilable copylefts, so they never share one.
CREATE SCHEMA IF NOT EXISTS cell_snapshot;

-- ---------------------------------------------------------------- tenant context

-- Returns the tenant set for this transaction, or NULL when none was set.
-- Marked STABLE, not IMMUTABLE: it reads settings that change within a session.
CREATE OR REPLACE FUNCTION core.current_tenant() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

-- ---------------------------------------------------------------- tables

CREATE TABLE IF NOT EXISTS core.raw_receipt (
  id             bigserial    NOT NULL,
  tenant_id      text         NOT NULL,
  source         text         NOT NULL,
  batch_id       text         NOT NULL,
  raw_sha256     text         NOT NULL,
  received_at    timestamptz  NOT NULL,
  byte_length    integer      NOT NULL,
  -- The payload itself lives in object storage; this row holds the reference and the evidence
  -- needed to prove the payload was not altered (PRD §12.3).
  object_key     text,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

CREATE TABLE IF NOT EXISTS core.observation (
  id             bigserial    NOT NULL,
  tenant_id      text         NOT NULL,
  source         text         NOT NULL,
  device_ref     text         NOT NULL,
  asset_ref      text,
  -- Identity basis travels with the value: every duplicate and ordering claim downstream depends
  -- on whether the vendor supplied it or the adapter synthesised it.
  identity_basis text         NOT NULL
                 CHECK (identity_basis IN ('vendor_event_id', 'vendor_sequence', 'synthesised')),
  identity_value text         NOT NULL,
  received_at    timestamptz  NOT NULL,
  vendor_received_at timestamptz,
  device_time    timestamptz,
  payload        jsonb        NOT NULL,
  adapter_version text        NOT NULL,
  -- Traceability to the immutable receipt. Not a foreign key: raw_receipt is partitioned, and a
  -- cross-partition FK would force every partition to be attached before any insert. The hash is
  -- the durable link and is verified on read.
  raw_receipt_id bigint,
  raw_sha256     text         NOT NULL,
  -- Re-decoding the same receipt with a newer adapter creates a NEW version rather than replacing
  -- the old one (FR-TEL-007). The original stays exactly as it was decoded, because an episode
  -- already classified from it must remain reproducible.
  version        integer      NOT NULL DEFAULT 1,
  superseded     boolean      NOT NULL DEFAULT false,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Idempotency is scoped by tenant AND source: the same vendor sequence from two platforms is two
-- observations, and merging them would fabricate agreement between independent sources.
-- Idempotency holds per adapter version: replaying the same payload through the same adapter is a
-- duplicate, while re-decoding through a newer one is a new version of the same observation.
CREATE UNIQUE INDEX IF NOT EXISTS observation_idempotency
  ON core.observation (tenant_id, source, identity_basis, identity_value, received_at, version);

CREATE TABLE IF NOT EXISTS core.assignment (
  id             bigserial PRIMARY KEY,
  tenant_id      text        NOT NULL,
  asset_ref      text        NOT NULL,
  device_ref     text        NOT NULL,
  role           text        NOT NULL CHECK (role IN ('primary', 'secondary')),
  sim_ref        text,
  installer_ref  text,
  -- Half-open [valid_from, valid_to): the instant one record ends is the instant its successor
  -- begins, so back-to-back periods neither overlap nor leave a gap.
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Rows that could not be normalized. Carries a code, field paths and a row hash — never values.
-- PRD §10.5 forbids coordinates, raw packets, IMSI, ICCID or borrower data in a rejection code, and
-- a diagnostic queue is exactly where such a value would be least controlled.
CREATE TABLE IF NOT EXISTS core.quarantine (
  id          bigserial PRIMARY KEY,
  tenant_id   text        NOT NULL,
  source      text        NOT NULL,
  batch_id    text        NOT NULL,
  code        text        NOT NULL,
  row_number  integer     NOT NULL,
  row_sha256  text        NOT NULL,
  field_paths text[]      NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL
);

-- A historical replay is a bounded, approved, resumable operation — never an ambient background
-- job. FR-EPI-007 requires runs to be resumable, scoped and separately audited, so the scope and
-- the approval are stored with the run rather than passed at the call site and forgotten.
CREATE TABLE IF NOT EXISTS core.replay_run (
  id             bigserial PRIMARY KEY,
  tenant_id      text        NOT NULL,
  source         text        NOT NULL,
  interval_start timestamptz NOT NULL,
  interval_end   timestamptz NOT NULL,
  approved_by    text        NOT NULL,
  reason         text        NOT NULL,
  status         text        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
  -- The upper bound of the last window fully processed. A resumed run restarts here, never from
  -- the beginning: re-processing already-checkpointed windows would be wasted work at best and, on
  -- a partially-failed run, an inconsistent double-write at worst.
  checkpoint_at  timestamptz,
  windows_total  integer     NOT NULL,
  windows_done   integer     NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  CHECK (interval_end > interval_start)
);

CREATE TABLE IF NOT EXISTS audit.event (
  id          bigserial PRIMARY KEY,
  tenant_id   text        NOT NULL,
  actor       text        NOT NULL,
  action      text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Append-only by trigger rather than by convention (PRD §7.3). Corrections insert a superseding
-- row; nothing is ever updated or deleted.
CREATE OR REPLACE FUNCTION core.refuse_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER IF EXISTS raw_receipt_append_only ON core.raw_receipt;
CREATE TRIGGER raw_receipt_append_only
  BEFORE UPDATE OR DELETE ON core.raw_receipt
  FOR EACH ROW EXECUTE FUNCTION core.refuse_mutation();

DROP TRIGGER IF EXISTS audit_event_append_only ON audit.event;
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION core.refuse_mutation();

-- ---------------------------------------------------------------- partitions

-- Partitioned from the start. §12.3 says partition after measured need, but retrofitting
-- partitioning onto a live append-only table is materially harder than starting with it, and these
-- are the only tables whose growth is unbounded by definition.
CREATE TABLE IF NOT EXISTS core.raw_receipt_2026_08
  PARTITION OF core.raw_receipt FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS core.raw_receipt_2026_09
  PARTITION OF core.raw_receipt FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS core.observation_2026_08
  PARTITION OF core.observation FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS core.observation_2026_09
  PARTITION OF core.observation FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- ---------------------------------------------------------------- row-level security

-- FORCE applies the policy to the table owner too. Without it an owner silently reads everything,
-- which would make the whole boundary decorative.
--
-- Partitions do NOT inherit their parent's row-level security: a policy on core.observation does
-- nothing for a query against core.observation_2026_08. Applied by function, over EVERY table in
-- the tenant schemas rather than an enumerated list — a list is how a new table ships without a
-- policy, which is precisely what happened to core.quarantine and what the isolation test caught.
CREATE OR REPLACE FUNCTION core.apply_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', target);
  -- A NULL tenant context matches nothing. A job that forgets to set the context sees an empty
  -- database rather than every tenant's data — the failure mode is loud and safe, not silent.
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = core.current_tenant()) '
    'WITH CHECK (tenant_id = core.current_tenant())', target);
END $$;

DO $$
DECLARE rel regclass;
BEGIN
  FOR rel IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    -- Tables and partitioned tables only: pg_class also lists indexes, which cannot carry RLS.
    WHERE n.nspname IN ('core', 'audit') AND c.relkind IN ('r', 'p')
  LOOP
    PERFORM core.apply_tenant_rls(rel);
  END LOOP;
END $$;

-- NOTE FOR OPERATORS: a PostgreSQL superuser bypasses row-level security entirely, including
-- FORCE. No policy in this file constrains one. Production must therefore run as a non-superuser —
-- bf_migrator owns objects, bf_app uses them, and neither is a superuser. PRD §11.1's requirement
-- that production roles not hold BYPASSRLS is necessary but not sufficient on its own.

-- ---------------------------------------------------------------- open map data

-- A snapshot cannot activate without complete provenance (FR-ADM-003). The NOT NULLs are the
-- enforcement: an import that cannot state its source, licence, version and checksum is not a
-- licensed extract, it is an unattributed copy.
CREATE TABLE IF NOT EXISTS osm_snapshot.snapshot (
  id            bigserial PRIMARY KEY,
  source_url    text        NOT NULL,
  licence       text        NOT NULL,
  extract_date  date        NOT NULL,
  sha256        text        NOT NULL CHECK (char_length(sha256) = 64),
  attribution   text        NOT NULL,
  imported_at   timestamptz NOT NULL,
  -- Activation is separate from import: an imported snapshot with a failed checksum must be
  -- inspectable without being usable.
  active        boolean     NOT NULL DEFAULT false,
  UNIQUE (source_url, extract_date, sha256)
);

-- The mapping from a stable internal key to the OSM way it came from. This table is the ONLY place
-- an OSM identifier appears. Tenant tables reference segments by surrogate key, so no
-- customer-derived attribute is ever keyed on an OSM feature — the shape ODbL's Horizontal Map
-- Layers guideline treats as a Derivative Database.
CREATE TABLE IF NOT EXISTS osm_snapshot.segment (
  snapshot_id   bigint      NOT NULL REFERENCES osm_snapshot.snapshot(id),
  -- Derived from geometry, not from the OSM id: way ids are reassigned when a way is split or
  -- merged, and an episode's corridor evidence must stay resolvable after that happens (FR-GEO-005).
  surrogate_key text        NOT NULL,
  osm_way_id    bigint      NOT NULL,
  h3_cell       text        NOT NULL,
  highway_class text,
  PRIMARY KEY (snapshot_id, surrogate_key)
);

CREATE INDEX IF NOT EXISTS segment_by_key ON osm_snapshot.segment (surrogate_key);
CREATE INDEX IF NOT EXISTS segment_by_h3 ON osm_snapshot.segment (h3_cell);

-- ---------------------------------------------------------------- open cell data

CREATE TABLE IF NOT EXISTS cell_snapshot.snapshot (
  id            bigserial PRIMARY KEY,
  source_url    text        NOT NULL,
  licence       text        NOT NULL,
  extract_date  date        NOT NULL,
  sha256        text        NOT NULL CHECK (char_length(sha256) = 64),
  attribution   text        NOT NULL,
  -- How the snapshot was obtained. The community API is not permitted for commercial production
  -- without contributing data or being whitelisted, and access may be withdrawn at any time, so the
  -- acquisition route is recorded rather than assumed.
  acquisition   text        NOT NULL
                CHECK (acquisition IN ('self_hosted_download', 'commercial_provider')),
  imported_at   timestamptz NOT NULL,
  active        boolean     NOT NULL DEFAULT false,
  UNIQUE (source_url, extract_date, sha256)
);

CREATE TABLE IF NOT EXISTS cell_snapshot.cell (
  snapshot_id bigint  NOT NULL REFERENCES cell_snapshot.snapshot(id),
  mcc         integer NOT NULL,
  mnc         integer NOT NULL,
  lac         integer NOT NULL,
  cell_id     bigint  NOT NULL,
  -- Averaged from reception measurements, not surveyed. One physical tower can contain several
  -- logical cells, so this is a prior over where a device might have been heard, never a position.
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  range_m     integer,
  samples     integer,
  PRIMARY KEY (snapshot_id, mcc, mnc, lac, cell_id)
);

CREATE INDEX IF NOT EXISTS cell_by_identity ON cell_snapshot.cell (mcc, mnc, lac, cell_id);
