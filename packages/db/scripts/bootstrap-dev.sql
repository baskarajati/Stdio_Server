-- Bootstrap for local development.
-- Run this one time as a superuser of the local Postgres:
--   psql -h localhost -d postgres -f packages/db/scripts/bootstrap-dev.sql
--
-- The CI pipeline runs the same statements as a setup step.
--
-- The `stdio` role is not a superuser. Row-Level Security does not apply to
-- superusers, so the application role must stay below that line. CREATEROLE
-- lets the migration create the restricted `studio_app` role. CREATEDB lets
-- the test suite build its own scratch database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stdio') THEN
    CREATE ROLE stdio LOGIN PASSWORD 'stdio' NOSUPERUSER CREATEROLE CREATEDB;
  END IF;
END
$$;

SELECT 'CREATE DATABASE stdio_dev OWNER stdio'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'stdio_dev')\gexec
