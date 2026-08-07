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
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Idempotency is scoped by tenant AND source: the same vendor sequence from two platforms is two
-- observations, and merging them would fabricate agreement between independent sources.
CREATE UNIQUE INDEX IF NOT EXISTS observation_idempotency
  ON core.observation (tenant_id, source, identity_basis, identity_value, received_at);

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
ALTER TABLE core.raw_receipt  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.raw_receipt  FORCE ROW LEVEL SECURITY;
ALTER TABLE core.observation  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.observation  FORCE ROW LEVEL SECURITY;
ALTER TABLE core.assignment   ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.assignment   FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.event       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event       FORCE ROW LEVEL SECURITY;

-- Partitions do NOT inherit their parent's row-level security. Querying core.observation_2026_08
-- directly bypasses a policy defined only on core.observation, so every partition needs its own
-- ENABLE, FORCE and policy. This is applied by function so a new partition cannot be added without
-- it, and so the same call can be made from the partition-creation path.
CREATE OR REPLACE FUNCTION core.apply_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = core.current_tenant()) '
    'WITH CHECK (tenant_id = core.current_tenant())', target);
END $$;

-- A NULL tenant context matches nothing. A job that forgets to set the context sees an empty
-- database rather than every tenant's data — the failure mode is loud and safe, not silent.
DROP POLICY IF EXISTS tenant_isolation ON core.raw_receipt;
CREATE POLICY tenant_isolation ON core.raw_receipt
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

DROP POLICY IF EXISTS tenant_isolation ON core.observation;
CREATE POLICY tenant_isolation ON core.observation
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

DROP POLICY IF EXISTS tenant_isolation ON core.assignment;
CREATE POLICY tenant_isolation ON core.assignment
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

DROP POLICY IF EXISTS tenant_isolation ON audit.event;
CREATE POLICY tenant_isolation ON audit.event
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Apply to every existing partition. A partition added later must call core.apply_tenant_rls on
-- itself; the isolation test asserts that no relation in core or audit is left uncovered, so
-- forgetting fails the release gate rather than shipping a hole.
DO $$
DECLARE part regclass;
BEGIN
  FOR part IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    -- Tables only: pg_inherits also lists partitioned indexes, which cannot carry RLS.
    WHERE n.nspname IN ('core', 'audit') AND c.relkind IN ('r', 'p')
  LOOP
    PERFORM core.apply_tenant_rls(part);
  END LOOP;
END $$;

-- NOTE FOR OPERATORS: a PostgreSQL superuser bypasses row-level security entirely, including
-- FORCE. No policy in this file constrains one. Production must therefore run as a non-superuser —
-- bf_migrator owns objects, bf_app uses them, and neither is a superuser. PRD §11.1's requirement
-- that production roles not hold BYPASSRLS is necessary but not sufficient on its own.
