/**
 * task351-rls-audit.ts — Task 35.1 read-only PostgreSQL security & RLS audit.
 *
 * STRICTLY READ-ONLY: every statement is a catalog SELECT or a plain SELECT
 * against application tables. No DDL, no DML, no migrations, no truncation,
 * no policy/grant/role changes. The connection string is loaded from
 * backend/.env and NEVER printed.
 *
 * Answers, with direct evidence:
 *   1. Which role does the application actually connect as? Is it privileged?
 *   2. Is RLS enabled (relrowsecurity) on each table?
 *   3. Do policies exist (pg_policies) and for which roles/commands?
 *   4. Can the application's actual connection role bypass RLS?
 *   5. What grants does the runtime role hold?
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function q(text: string): Promise<any[]> {
  const r = await pool.query(text);
  return r.rows;
}

async function section(title: string): Promise<void> {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  try {
    // 1. Who are we, and what privileges does that role hold?
    await section('1. Runtime role & role attributes');
    const roles = await q(`
      SELECT current_user AS current_user_, session_user AS session_user_,
             rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
      FROM pg_roles WHERE rolname = CURRENT_USER
    `);
    console.log(JSON.stringify(roles, null, 2));

    await section('1b. All non-system roles (names + attributes only)');
    const allRoles = await q(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
      FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname
    `);
    for (const r of allRoles) {
      console.log(
        `  ${r.rolname} super=${r.rolsuper} bypassrls=${r.rolbypassrls} login=${r.rolcanlogin}`
      );
    }

    // 2. RLS enabled per table + table ownership.
    await section('2. RLS enablement + ownership per public table');
    const tables = await q(`
      SELECT c.relname,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced,
             pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    for (const t of tables) {
      console.log(
        `  ${t.relname}: RLS=${t.rls_enabled} forced=${t.rls_forced} owner=${t.owner}`
      );
    }

    // 3. Policies per table (pg_policies gives readable policy definitions).
    await section('3. RLS policies (pg_policies)');
    const policies = await q(`
      SELECT tablename, policyname, permissive, roles, cmd, qual
      FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname
    `);
    if (policies.length === 0) {
      console.log('  (none — zero rows returned)');
    } else {
      for (const p of policies) {
        console.log(
          `  ${p.tablename}.${p.policyname} roles={${p.roles}} cmd=${p.cmd} permissive=${p.permissive}`
        );
        console.log(`    qual: ${p.qual}`);
      }
    }

    // 4. Direct bypass test: can THIS role read every row of key user-data
    //    tables right now? (Evidence of full read access = RLS not protecting
    //    this connection.) Pure SELECT COUNT — no row values printed.
    await section('4. Read-access probe (COUNT only, no values exposed)');
    const probeTables = [
      'users',
      'sessions',
      'technicians',
      'service_requests',
      'dispatch_offers',
      'conversations',
      'messages',
      'notifications',
      'push_subscriptions',
      'user_phones',
      'technician_verification_documents',
      'audit_events',
    ];
    for (const name of probeTables) {
      try {
        const rows = await q(`SELECT COUNT(*)::int AS n FROM "${name}"`);
        console.log(`  ${name}: readable, ${rows[0].n} rows`);
      } catch (e: any) {
        console.log(`  ${name}: NOT readable (${e.message.split('\n')[0]})`);
      }
    }

    // 5. Grants held by the current role on public tables.
    await section('5. Table grants for runtime role');
    const grants = await q(`
      SELECT table_name, privilege_type, is_grantable
      FROM information_schema.role_table_grants
      WHERE grantee = current_user AND table_schema = 'public'
      ORDER BY table_name, privilege_type
    `);
    const byTable: Record<string, string[]> = {};
    for (const g of grants) {
      (byTable[g.table_name] ||= []).push(g.privilege_type);
    }
    for (const [t, privs] of Object.entries(byTable)) {
      console.log(`  ${t}: ${[...new Set(privs)].sort().join(', ')}`);
    }

    // 6. Is there a schema_migrations ledger, and what has been applied?
    await section('6. Applied migrations (ledger)');
    try {
      const m = await q(
        `SELECT name FROM schema_migrations ORDER BY name`
      );
      for (const row of m) console.log(`  ${row.name}`);
    } catch {
      console.log('  (no schema_migrations ledger readable)');
    }

    // 7. Supabase Data API roles: do anon/authenticated/service_role hold any
    //    grants on the app tables? (Determines whether PostgREST-style access
    //    is even possible without additional grants.)
    await section('7. Grants held by Supabase API roles (anon/authenticated/service_role)');
    const apiRoles = ["anon", "authenticated", "service_role"];
    let anyApiGrants = false;
    for (const role of apiRoles) {
      const g = await q(`
        SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
        FROM information_schema.role_table_grants
        WHERE grantee = '${role}' AND table_schema = 'public'
        GROUP BY table_name ORDER BY table_name
      `);
      if (g.length === 0) {
        console.log(`  ${role}: NO grants on any public table`);
      } else {
        anyApiGrants = true;
        for (const row of g) console.log(`  ${role}: ${row.table_name} → ${row.privs}`);
      }
    }
    if (!anyApiGrants) console.log('  → no public-table grants for any Supabase API role');

    // 8. Transport security of the app's connection (parameter ONLY — the
    //    URL itself, userinfo, host and password are never printed).
    await section('8. Connection TLS parameter (sslmode only)');
    try {
      const url = new URL(process.env.DATABASE_URL || '');
      console.log(`  sslmode = ${url.searchParams.get('sslmode') ?? '(not set → default)'}`);
    } catch {
      console.log('  (DATABASE_URL not parseable as URL — not printed)');
    }

    // 9. Connection count / exposure surface: can the public Data API role
    //    even log in? (Role attributes only, no secrets.)
    await section('9. Supabase API role attributes');
    const apiAttrs = await q(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
      FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
      ORDER BY rolname
    `);
    for (const r of apiAttrs) {
      console.log(
        `  ${r.rolname} super=${r.rolsuper} bypassrls=${r.rolbypassrls} login=${r.rolcanlogin}`
      );
    }

    // 10. Sequences & functions in public (least-privilege planning).
    await section('10. Sequences + functions in public schema');
    const seqs = await q(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname
    `);
    console.log(`  sequences: ${seqs.length ? seqs.map((s) => s.relname).join(', ') : '(none)'}`);
    const funcs = await q(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' ORDER BY p.proname
    `);
    console.log(`  functions: ${funcs.length ? funcs.map((f) => f.proname).join(', ') : '(none)'}`);

    // 11. Default privileges (why new tables silently get anon grants).
    await section('11. Default ACLs touching schema public');
    const dacls = await q(`
      SELECT pg_get_userbyid(d.defaclrole) AS grantor,
             d.defaclobjtype AS objtype,
             d.defaclacl::text AS acl
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = 'public'
    `);
    if (dacls.length === 0) console.log('  (no default ACLs on public)');
    for (const d of dacls) console.log(`  ${d.objtype} by ${d.grantor}: ${d.acl}`);

    // 12. Schema-level privileges for the API roles + runtime role.
    await section('12. Schema public USAGE/CREATE per role');
    for (const role of ['anon', 'authenticated', 'service_role', 'umodzi_app']) {
      const exists = await q(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`);
      if (exists.length === 0) {
        console.log(`  ${role}: role does not exist`);
        continue;
      }
      const r = await q(`
        SELECT has_schema_privilege('${role}', 'public', 'USAGE') AS usage,
               has_schema_privilege('${role}', 'public', 'CREATE') AS create_
      `);
      console.log(`  ${role}: USAGE=${r[0].usage} CREATE=${r[0].create_}`);
    }

    // 13. Realtime publication membership (do Supabase services depend on
    //     these tables?).
    await section('13. supabase_realtime publication membership');
    const pubs = await q(`
      SELECT schemaname, tablename FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' ORDER BY tablename
    `);
    console.log(
      `  ${pubs.length ? pubs.map((p) => p.tablename).join(', ') : '(no tables published)'}`
    );

    // 14. Runtime role existence (post-remediation this must be true).
    await section('14. Runtime role umodzi_app existence');
    const rt = await q(`
      SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin
      FROM pg_roles WHERE rolname = 'umodzi_app'
    `);
    console.log(
      rt.length
        ? `  present: super=${rt[0].rolsuper} createrole=${rt[0].rolcreaterole} createdb=${rt[0].rolcreatedb} bypassrls=${rt[0].rolbypassrls} login=${rt[0].rolcanlogin}`
        : '  ABSENT (not yet created)'
    );

    // 15. Runtime role's effective table privileges (catalog truth, not grants).
    await section('15. umodzi_app effective table privileges');
    if (rt.length === 0) {
      console.log('  (role absent — nothing to check)');
    } else {
      for (const t of probeTables) {
        try {
          const p = await q(`
            SELECT has_table_privilege('umodzi_app', '"${t}"', 'SELECT') AS s,
                   has_table_privilege('umodzi_app', '"${t}"', 'INSERT') AS i,
                   has_table_privilege('umodzi_app', '"${t}"', 'UPDATE') AS u,
                   has_table_privilege('umodzi_app', '"${t}"', 'DELETE') AS d,
                   has_table_privilege('umodzi_app', '"${t}"', 'TRUNCATE') AS tr
          `);
          console.log(
            `  ${t}: SELECT=${p[0].s} INSERT=${p[0].i} UPDATE=${p[0].u} DELETE=${p[0].d} TRUNCATE=${p[0].tr}`
          );
        } catch (e: any) {
          console.log(`  ${t}: check failed (${e.message.split('\n')[0]})`);
        }
      }
      try {
        const led = await q(`
          SELECT has_table_privilege('umodzi_app', '"schema_migrations"', 'SELECT') AS s
        `);
        console.log(`  schema_migrations: SELECT=${led[0].s} (must be false)`);
      } catch (e: any) {
        console.log(`  schema_migrations: check failed (${e.message.split('\n')[0]})`);
      }
    }
  } catch (e: any) {
    console.error('AUDIT ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
