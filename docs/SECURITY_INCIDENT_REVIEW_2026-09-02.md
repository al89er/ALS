# ALS Supabase Security Incident Review

Review date: 2026-09-02 (Asia/Kuala_Lumpur)

Affected project: `pvutxjfkskzgccawfibu`

This report contains no credentials, token values, user identifiers, IP addresses, or row contents.

## Executive Summary

Status: **UNABLE TO DETERMINE** whether an unauthorized party changed the database after the leaked legacy `service_role` JWT entered public Git history on 2026-07-27.

The project is on the Free plan and the available log interface exposes only the newest 100 events per service from the recent 24-hour window. The incident-period logs and DDL history are therefore unavailable. No retained migration ledger exists.

Current-state inspection found one confirmed high-risk exposure: `public.config` had RLS disabled while `anon` and `authenticated` had CRUD grants. The table is not represented in repository SQL and has no current application query. Three rows exist; a metadata-only scan found no obvious secret-like key or value patterns. This does not prove the values are non-sensitive. The user subsequently applied the prepared RLS restoration, and the live after-state was verified at 2026-09-02 08:14 UTC.

Six other user-data tables have RLS enabled and policies matching repository SQL. No broad `USING (true)` or `WITH CHECK (true)` policy exists. No application-owned functions, RPCs, materialized views, non-internal triggers, or `SECURITY DEFINER` functions exist in `public`.

A separate high-confidence authorization weakness exists in the repository-derived policies: an authenticated user can manage their own `device_status` row and choose its `device_id`, while five other tables authorize access by matching that mutable identifier. Because `device_status.device_id` is not unique, a user could register another device's identifier and satisfy the cross-device policy. Current data has no duplicate device identifiers, but 25 command rows and 58 log rows intentionally rely on cross-owner device matching. A safe correction therefore requires an application-level ownership design and was not guessed or applied.

## Review Baseline

- Project ref: `pvutxjfkskzgccawfibu`
- Connection: linked remote Supabase project; connector session role is read-only
- Project health: `ACTIVE_HEALTHY`
- Region: `ap-northeast-1`
- PostgreSQL: `17.6.1.127`
- Supabase CLI observed: `2.116.0`
- Git branch: `feat/clock-actions-proof-confirmation`
- HEAD at final inventory: `3669db3b96a655acf148a79a213196fad6f9a9aa`
- Working tree before review artifacts: four modified application files and five untracked SQL files; these pre-existing changes were preserved
- Legacy publishable key: disabled
- Modern publishable key: active

## RLS Status

| Application table | RLS | Forced | Owner | Policies | Assessment |
| --- | --- | --- | --- | ---: | --- |
| `public.device_status` | enabled | no | `postgres` | 1 | Repository-derived owner/admin policy |
| `public.commands` | enabled | no | `postgres` | 1 | Repository-derived owner/device/admin policy |
| `public.logs` | enabled | no | `postgres` | 1 | Repository-derived owner/device/admin policy |
| `public.config` | enabled | no | `postgres` | 0 | Restored deny-by-default protection; unaccounted object |
| `public.system_config` | enabled | no | `postgres` | 0 | Fail-closed; application compatibility requires review |
| `public.skip_days` | enabled | no | `postgres` | 1 | Repository-derived owner/device/admin policy |
| `public.todays_proof` | enabled | no | `postgres` | 1 | Repository-derived owner/device/admin policy |
| `public.daily_schedules` | enabled | no | `postgres` | 1 | Repository-derived owner/device/admin policy |

Counts after the verified RLS restoration:

- Application tables: 8
- RLS enabled: 8
- RLS disabled: 0
- RLS restored remotely: 1
- Manual review required: 2 (`system_config` authorization and cross-device ownership)

## Policies

All six live policies are permissive `FOR ALL` policies attached to the PostgreSQL `public` role. For `anon`, `auth.uid()` and `auth.email()` are null, so the predicates do not grant anonymous row access. Restricting the policies to `authenticated` would be clearer hardening, but it is not required to close the confirmed exposure.

| Table | Policy | Operation | Roles | Sanitized `USING` / `WITH CHECK` expression |
| --- | --- | --- | --- | --- |
| `device_status` | `Users can manage their own device_status` | ALL | `public` | owner UID OR hard-coded admin email |
| `commands` | `Users can manage their own commands` | ALL | `public` | owner UID OR matching owned `device_id` OR hard-coded admin email |
| `logs` | `Users can manage their own logs` | ALL | `public` | owner UID OR matching owned `device_id` OR hard-coded admin email |
| `skip_days` | `Users can manage their own skip_days` | ALL | `public` | owner UID OR matching owned `device_id` OR hard-coded admin email |
| `todays_proof` | `Users can manage their own todays_proof` | ALL | `public` | owner UID OR matching owned `device_id` OR hard-coded admin email |
| `daily_schedules` | `Users can manage their own daily_schedules` | ALL | `public` | owner UID OR matching owned `device_id` OR hard-coded admin email |

Expected policies: 6. Missing on an RLS-enabled table: 1 (`system_config`, intentionally not reconstructed without a trustworthy rule). Unexpected broad-true policies: 0. Modified/restored remotely: 0.

## Findings

### F-01 — RESOLVED HIGH — `public.config` exposed without RLS

- **Before state:** RLS disabled; no policies; `anon` and `authenticated` had SELECT, INSERT, UPDATE, and DELETE grants; three rows existed.
- **After state:** RLS enabled; FORCE disabled; zero policies; grants unchanged. Both API client roles have `BYPASSRLS=false` and zero applicable policies, so access is deny-by-default. Privileged server semantics remain unchanged.
- **Expected state:** An unaccounted configuration table should not be anonymously reachable through the Data API.
- **Evidence:** Catalog metadata, table privileges, Supabase Security Advisor, and absence of repository query references.
- **Risk:** Unauthenticated reading or mutation of configuration data. Whether the rows influence an external component is unknown.
- **Remediation:** RLS was enabled without adding a policy. Current grants and privileged server behavior were preserved. Provenance still requires investigation before deciding whether to retain the table.
- **Confidence:** High.

### F-02 — HIGH — Mutable device identifiers can satisfy cross-owner policies

- **Current state:** Users can upsert an owned `device_status` row with a chosen `device_id`. Five policies authorize rows when that identifier appears in the user's device rows. The identifier is neither unique nor server-provisioned.
- **Expected state:** Device ownership must be established by a non-forgeable or administratively controlled mapping, or target rows must carry the target owner's UID.
- **Evidence:** Live policy expressions, table constraints, application upserts, and repository SQL. Current data has five device mappings, no duplicates, and no multi-owner collision. Twenty-five command rows and 58 log rows match a device owner different from the row owner, showing that cross-owner behavior is currently used.
- **Risk:** An authenticated user may be able to claim a known device identifier and access or mutate another user's device-scoped rows.
- **Proposed remediation:** Design and test one of: server-controlled device enrollment; immutable globally unique device mappings; or writing the target owner's UID onto commands and other target rows so policies can return to owner-only checks. Do not merely remove the device branch without updating legitimate admin-to-device workflows.
- **Confidence:** High.

### F-03 — MEDIUM — No remote migration ledger and repository drift

- **Current state:** Supabase reports zero migrations. The live schema corresponds partly to untracked SQL files `03` through `07`; older files are not in a timestamped migration directory.
- **Expected state:** Every production DDL and policy change should be represented by an immutable, timestamped migration.
- **Evidence:** Empty remote migration list, Git status, live constraints and policy definitions.
- **Risk:** Change provenance cannot be established, drift is difficult to detect, and incident attribution is weakened.
- **Proposed remediation:** Adopt `supabase/migrations`, baseline the reviewed state, and apply future DDL only as migrations.
- **Confidence:** High.

### F-04 — MEDIUM — `system_config` is fail-closed but used by clients

- **Current state:** RLS is enabled with zero policies. The desktop and web code perform SELECT and UPSERT operations against this global table, which has no `user_id` or `device_id` ownership column.
- **Expected state:** The product must define whether configuration is per-user, per-device, admin-managed, or server-only.
- **Evidence:** Supabase Security Advisor, live schema, and static application query mapping.
- **Risk:** Normal publishable-key/authenticated clients cannot access the table; adding a broad policy to restore functionality could create a global write vulnerability.
- **Proposed remediation:** Keep fail-closed until an explicit ownership model is approved. Do not add `USING (true)` or an all-authenticated write policy.
- **Confidence:** High.

### F-05 — MEDIUM — Legacy privileged-key assumptions remain in operational files

- **Current state:** The desktop runtime has been migrated to `SUPABASE_PUBLISHABLE_KEY`, but README guidance still names `SUPABASE_SERVICE_ROLE_KEY`; two tracked test scripts expect it; and the deployed Edge Function reads the legacy service-role environment variable. The deployed source exactly matches the repository source and contains no literal JWT.
- **Expected state:** Desktop/client code and operator guidance use publishable keys plus authenticated sessions. Privileged Edge Function access uses an explicitly managed modern secret and remains server-only.
- **Evidence:** Safe identifier-only repository scan, deployed source comparison, and current key-status metadata.
- **Risk:** Operators may reintroduce a privileged client credential, hazardous scripts may mutate production if run with such a key, and the Edge Function may fail after legacy-key disablement.
- **Proposed remediation:** Update documentation; quarantine or rewrite production-mutating scripts; migrate the Edge Function to a separately configured modern server secret after a deployment plan. Do not expose or rotate any key during this review.
- **Confidence:** High.

### F-06 — MEDIUM — Leaked-password protection disabled

- **Current state:** Supabase Security Advisor reports leaked-password protection disabled.
- **Expected state:** Enable it where the Auth plan and user experience permit.
- **Risk:** Users may choose passwords known to be compromised.
- **Proposed remediation:** Enable through Auth settings after confirming product impact; no Auth users were inspected or changed.
- **Confidence:** High.

### F-07 — LOW — Orphaned ownership metadata

- **Current state:** Five log rows, three proof rows, and one daily-schedule row have null `user_id`. Null-owned log rows span 2026-07-30 to 2026-08-25; null-owned proof rows are dated 2026-07-29 to 2026-07-30; the null-owned schedule is dated 2026-08-26. Two proof rows have no matching device mapping.
- **Expected state:** User-owned rows should have an attributable owner.
- **Risk:** Rows may be inaccessible through RLS and complicate forensics. This is data drift, not evidence of malicious activity.
- **Proposed remediation:** Human review and explicit owner attribution. No production row was modified.
- **Confidence:** High for state, low for cause.

## Grants

All eight public tables and the `user_devices` view grant broad table privileges to `anon`, `authenticated`, and `service_role`; `PUBLIC` has no relation grant. The two application sequences grant SELECT, UPDATE, and USAGE to the three API roles. These are legacy/default Supabase-style Data API grants and are normally constrained by RLS. They are immediately dangerous only on `config`, where RLS is disabled.

No grant was revoked automatically. The review did not treat normal Data API grants as malicious, and did not assume that PostgreSQL-only privileges such as TRUNCATE are directly exposed as a PostgREST operation.

## Security Definer Functions

No application-owned function or RPC exists in `public`. Therefore there is no application `SECURITY DEFINER`, unsafe function `search_path`, or administrative RPC callable by `anon`/`authenticated` to remediate.

## Other Database Objects

- View: `public.user_devices`, owned by `postgres`, with `security_invoker=true`; it inherits `device_status` RLS.
- Materialized views: none in `public`.
- Non-internal triggers: none in `public`.
- Sequences: `commands_id_seq`, `logs_id_seq`.
- Realtime publication: `commands`, `device_status`, `logs`, `skip_days`, `system_config`, and `todays_proof`. `daily_schedules` is not published even though desktop code subscribes to it; this is a functionality drift, not proven malicious activity.
- Storage: zero buckets and zero objects; no application storage policy found.
- Installed extensions: `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, and `uuid-ossp`; none is unexpected for this application/platform.
- Relevant API roles: `anon` and `authenticated` do not bypass RLS; `service_role` does. Platform administrative roles were not modified.

## Unaccounted Remote Objects

- `public.config`: not present in repository schema SQL or current application queries; origin and purpose cannot be established.
- `public.system_config`: actively referenced by the application but lacks a repository definition and a usable policy.
- Live policies and composite constraints correspond to untracked SQL files rather than recorded remote migrations. This is untracked provenance, not proof of an attacker-created object.

No unknown application function, trigger, custom schema, storage bucket, or unusual extension was found.

## Log Review

The project is on the Free plan. The available interface covers only recent activity and returns at most the newest 100 events per service, so it cannot answer what occurred from 2026-07-27 onward.

Recent sampled evidence:

- API: 100 events from a roughly ten-minute span; all were `device_status` POSTs, with 80 HTTP 200 and 20 HTTP 401 responses.
- Auth: 100 events from roughly eleven hours; 48 explicit HTTP 200 results and two invalid-credential HTTP 400 results; no administrative-user action indicator was surfaced by the aggregate scan.
- Postgres: 100 recent events; no service-role, JWT, RLS-bypass, TRUNCATE, or bulk-delete marker surfaced by the aggregate scan.
- Edge Function: no retained event in the returned sample.
- Storage and Realtime: small recent samples with no reviewed incident indicator.
- No sampled API request targeted `config` or `system_config`.

These observations are **NO EVIDENCE FOUND in the retained sample**, not proof that the leaked credential was unused.

## Security Advisors

Security Advisor findings captured before remediation:

1. Error: RLS disabled on `public.config`.
2. Info: RLS enabled with no policy on `public.system_config`.
3. Warning: Auth leaked-password protection disabled.

After-state advisor verification:

1. The `rls_disabled_in_public` error for `public.config` is cleared.
2. `public.config` now has the expected informational `rls_enabled_no_policy` notice because it is intentionally server-only/deny-by-default.
3. The pre-existing `system_config` informational notice and leaked-password warning remain.

Performance advisors also identify unindexed `user_id` foreign keys, repeated auth-function evaluation in RLS, and duplicate unique/primary indexes on three composite-key tables. They are performance/schema-cleanup items and were not mixed into incident remediation.

## Changes Applied

Remote database changes:

- `supabase/migrations/20260902155707_security_incident_rls_restoration.sql`
  - enables RLS on `public.config`
  - creates no policy
  - does not force RLS
  - does not alter grants or data

The user reported applying this SQL, and the read-only connector independently verified the live result. Supabase still reports an empty migration ledger, so the schema change took effect but was not recorded in `supabase_migrations.schema_migrations`. No attempt was made to fabricate or repair migration history during this read-only review.

No commit or push was made.

## Tests

- `npm.cmd test` in `desktop-app`: 14 passed, 1 failed.
- The failure is in the pre-existing dirty `automation.js`: `targetDeviceId` is undefined in the second pre-flight duplicate-click prevention test. It is unrelated to the prepared RLS migration.
- Live catalog checks confirmed the exact before-state of tables, policies, grants, views, functions, triggers, extensions, publications, storage, and key status.
- Live after-state checks confirmed `public.config`: RLS enabled, FORCE disabled, zero policies, unchanged grants, and no RLS bypass for `anon` or `authenticated`.
- Supabase Security Advisor no longer reports RLS disabled on `public.config`.
- No destructive RLS probe or production row mutation was performed.

## Remaining Risks

- Incident-period logs and DDL audit history are unavailable.
- The purpose and provenance of `public.config` remain unknown.
- Cross-device authorization depends on a user-controlled identifier.
- `system_config` has no safe documented ownership model.
- Hard-coded admin-email authorization is brittle and should eventually become a managed authorization claim or server-controlled role mapping.
- The Edge Function still expects the legacy service-role environment variable.
- Legacy and debug/test files increase the chance of unsafe production operations if run manually.
- Null-owned and orphan-mapped rows require human attribution.

## Recommended Next Actions

### P0 — Immediate

1. Preserve this report and export any currently available logs before the Free-plan window rolls over.
2. Reconcile the empty remote migration ledger using the normal reviewed Supabase migration workflow; do not re-run the schema change or fabricate history blindly.
3. Confirm any intended privileged server consumer of `config` still functions; ordinary `anon` and authenticated access is now structurally denied.

### P1 — Soon

1. Design a non-forgeable device ownership model, then replace the cross-device policy branch and add non-destructive two-user RLS tests.
2. Define `system_config` ownership and split SELECT/INSERT/UPDATE/DELETE policies; do not use a blanket all-authenticated policy.
3. Migrate the Edge Function to a modern server-side secret variable and deploy only after a functional test.
4. Remove service-role setup guidance from README and quarantine production-mutating debug/test scripts.
5. Review and attribute null-owner/orphan rows without deleting data.

### P2 — Hardening

1. Replace hard-coded admin-email checks with a managed authorization claim or server-controlled mapping.
2. Restrict policies explicitly to `authenticated` and use scalar subselects for auth functions after regression tests.
3. Add missing foreign-key indexes and remove redundant composite unique constraints in separate performance migrations.
4. Enable leaked-password protection after user-impact review.
5. Establish longer log retention or external log drains and a documented incident-response export procedure.
