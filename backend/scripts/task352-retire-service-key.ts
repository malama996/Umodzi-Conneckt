/**
 * task352-retire-service-key.ts — Task 35.2 Stage 5 (DB-4).
 *
 * The Supabase service-role key in backend/.env was confirmed UNUSED by a
 * repo-wide grep in Task 35.1 (0 code references). This script COMMENTS
 * OUT that single line in place (value is never printed, never copied,
 * never deleted from disk — it stays in the local secret file only, so an
 * owner can still rotate it in the Supabase dashboard and update it here
 * later if a future feature truly needs it).
 *
 * Idempotent: re-running leaves the line commented and the note intact.
 * Reversible: uncomment the line (dashboard access needed to rotate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(here, '..', '.env');

const NOTE =
  '# [Task 35.2 / DB-4] SUPABASE_SERVICE_ROLE_KEY is UNUSED by any code and was\n' +
  '# commented out as a standing-credential reduction. ROTATE it in the Supabase\n' +
  '# dashboard before any future reuse (history/exposure unknown). Do not uncomment\n' +
  '# without a code reference and a rotation.\n';

let env = fs.readFileSync(ENV_PATH, 'utf8');

if (/^SUPABASE_SERVICE_ROLE_KEY=/m.test(env)) {
  env = env.replace(/^SUPABASE_SERVICE_ROLE_KEY=/m, `${NOTE}# SUPABASE_SERVICE_ROLE_KEY=`);
  fs.writeFileSync(ENV_PATH, env);
  console.log('backend/.env: SUPABASE_SERVICE_ROLE_KEY line commented out (value untouched on disk, never printed).');
} else {
  console.log('backend/.env: SUPABASE_SERVICE_ROLE_KEY already inactive — nothing to do.');
}

// Same treatment for the two bucket-name lines? No: bucket NAMES are not
// secrets. Leave them; they document intended future storage config.
