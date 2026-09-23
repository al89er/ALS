-- ALS security incident review: restore deny-by-default protection for the
-- unaccounted public.config table.
--
-- Evidence captured on 2026-09-02:
--   * public.config is in the Data API's public schema.
--   * RLS is disabled and no policies exist.
--   * anon and authenticated have CRUD table grants.
--   * the current ALS repository contains no application query for this table.
--
-- This intentionally does not FORCE RLS, create a permissive policy, alter
-- table grants, or modify data. Existing privileged server access continues
-- to work through PostgreSQL's normal RLS-bypass semantics.

alter table if exists public.config enable row level security;

do $$
begin
  if to_regclass('public.config') is not null
     and not (
       select c.relrowsecurity
       from pg_catalog.pg_class as c
       where c.oid = 'public.config'::regclass
     ) then
    raise exception 'Expected RLS to be enabled on public.config';
  end if;
end
$$;
