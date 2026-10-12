/**
 * Task 33 OPTIONAL live smoke test: one real Gemini call through the
 * running backend's POST /api/v1/classify-fault as an authenticated
 * customer. Requires GEMINI_API_KEY in backend/.env AND a customer
 * session (TASK33_CUSTOMER_EMAIL / TASK33_CUSTOMER_PASSWORD for a
 * throwaway account). Skips cleanly when unavailable.
 *
 * The key is NEVER printed; the description is a fixed synthetic string.
 * Do not run in CI — it consumes real quota.
 *
 *   node backend/scripts/task33-gemini-smoke.mjs
 */
import dotenv from "dotenv";
dotenv.config({ path: "backend/.env" });

const API = "http://localhost:3001/api/v1";
if (!process.env.GEMINI_API_KEY) {
  console.log(
    "SKIP: GEMINI_API_KEY not configured (fallback path is the expected behavior).",
  );
  process.exit(0);
}
const email = process.env.TASK33_CUSTOMER_EMAIL;
const password = process.env.TASK33_CUSTOMER_PASSWORD;
if (!email || !password) {
  console.log(
    "SKIP: set TASK33_CUSTOMER_EMAIL/_PASSWORD to a throwaway customer to run.",
  );
  process.exit(0);
}

const jar = [];
async function call(path, init = {}, bearer) {
  const headers = { ...(init.headers ?? {}) };
  if (jar.length > 0) headers.cookie = jar.join("; ");
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let body = init.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(API + path, { ...init, headers, body });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const name = pair.split("=")[0];
    const idx = jar.findIndex((c) => c.split("=")[0] === name);
    if (idx >= 0) jar[idx] = pair;
    else jar.push(pair);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: res.status, text, json };
}

const login = await call("/auth/login", {
  method: "POST",
  body: { email, password },
});
if (login.status !== 200) {
  console.log(`FAIL: customer login ${login.status}`);
  process.exit(1);
}
const out = await call(
  "/classify-fault",
  {
    method: "POST",
    body: {
      description: "Kitchen tap drips nonstop and the cupboard below is damp.",
    },
  },
  login.json.data.accessToken,
);
console.log(`classify status: ${out.status}`);
console.log(`category: ${out.json?.data?.category ?? "(none)"}`);
console.log(`has summary: ${typeof out.json?.data?.summary === "string"}`);
console.log(`leaks key: ${out.text.includes(process.env.GEMINI_API_KEY)}`);
if (out.status !== 200 || out.text.includes(process.env.GEMINI_API_KEY))
  process.exit(1);
console.log("SMOKE OK");
