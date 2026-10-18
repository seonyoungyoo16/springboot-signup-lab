import { request } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
import fs from "node:fs";
const run = "backend-accounts-" + Date.now(),
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55442,
    user: "signuplab",
    password: "signuplab_dev",
    database: "signuplab",
  });
let passed = 0;
const clients = [];
async function client() {
  const api = await request.newContext({
    baseURL: "https://localhost:8470",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
  });
  clients.push(api);
  const csrf = (await (await api.get("/api/context")).json()).csrf;
  const headers = { "X-CSRF-TOKEN": csrf };
  return { api, headers };
}
async function verified(c, email) {
  const f = await (
    await c.api.post("/api/signup/flows", { headers: c.headers, data: {} })
  ).json();
  assert.ok(f.flowId);
  const r = await c.api.post("/api/signup/email/request", {
    headers: c.headers,
    data: { email, idempotencyKey: crypto.randomUUID() },
  });
  assert.equal(r.status(), 202);
  let token;
  for (let i = 0; i < 50; i++) {
    const m = await (
      await c.api.get("/lab/mailbox?run=" + run, {
        headers: { "X-Lab-Control": "1" },
      })
    ).json();
    const row = m.find((v) => v.flowId === f.flowId);
    if (row) {
      token = new URL(row.url).hash.slice(8);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(token);
  assert.equal(
    (
      await c.api.post("/api/signup/email/verify", {
        headers: c.headers,
        data: { token },
      })
    ).status(),
    200,
  );
  return f;
}
try {
  await db.connect();
  const a = await client();
  assert.equal(
    (
      await a.api.post("/lab/runs", {
        headers: { "X-Lab-Control": "1" },
        data: { run },
      })
    ).status(),
    200,
  );
  await verified(a, "one@lab.test");
  const body = {
    name: "원자 가입",
    password: "Signup!2026LongPass",
    confirmation: "Signup!2026LongPass",
    terms: true,
    marketing: false,
    termsVersion: 1,
    idempotencyKey: crypto.randomUUID(),
  };
  let r = await a.api.post("/api/signup/complete", {
    headers: a.headers,
    data: body,
  });
  assert.equal(r.status(), 201);
  const first = await r.json();
  const facts = (
    await db.query(
      "SELECT a.name,p.encoded_hash,(SELECT count(*) FROM consent_records c WHERE c.account_id=a.id) AS consents FROM accounts a JOIN password_credentials p ON p.account_id=a.id WHERE a.id=$1",
      [first.accountId],
    )
  ).rows[0];
  assert.equal(facts.name, "원자 가입");
  assert.match(facts.encoded_hash, /^\{argon2id\}\$argon2id\$/);
  assert.equal(facts.consents, "2");
  assert.equal((await a.api.get("/api/auth/me")).status(), 401);
  passed++;
  r = await a.api.post("/api/signup/complete", {
    headers: a.headers,
    data: body,
  });
  assert.equal(r.status(), 200);
  assert.equal((await r.json()).accountId, first.accountId);
  assert.equal(
    (
      await a.api.post("/api/signup/complete", {
        headers: a.headers,
        data: { ...body, name: "변경" },
      })
    ).status(),
    409,
  );
  passed++;
  const b = await client(),
    c = await client();
  await verified(b, "race@lab.test");
  await verified(c, "race@lab.test");
  const results = await Promise.all([
    b.api.post("/api/signup/complete", {
      headers: { ...b.headers, "X-Lab-Node": "A" },
      data: { ...body, idempotencyKey: crypto.randomUUID() },
    }),
    c.api.post("/api/signup/complete", {
      headers: { ...c.headers, "X-Lab-Node": "B" },
      data: { ...body, idempotencyKey: crypto.randomUUID() },
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status()).sort(), [201, 409]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM account_emails WHERE realm_id=$1 AND email_key=$2",
        [run, "race@lab.test"],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM password_credentials p JOIN accounts a ON a.id=p.account_id WHERE a.realm_id=$1",
        [run],
      )
    ).rows[0].count,
    "3",
  );
  passed++;
  const orphans = (
    await db.query(
      "SELECT count(*) FROM accounts a LEFT JOIN account_emails e ON e.account_id=a.id WHERE a.realm_id=$1 AND e.account_id IS NULL",
      [run],
    )
  ).rows[0].count;
  assert.equal(orphans, "0");
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM signup_operation_results r JOIN signup_flows f ON f.id=r.flow_id WHERE f.realm_id=$1 AND r.operation=$2",
        [run, "complete"],
      )
    ).rows[0].count,
    "3",
  );
  passed++;
  const result = {
    status: "passed",
    stage: "accounts",
    passed,
    completedAt: new Date().toISOString(),
    evidence:
      "actual HTTPS + Argon2id DB hash + atomic consents + independent A/B unique conflict and no orphan rows",
  };
  fs.writeFileSync(
    "docs/verification/backend-accounts.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await db.end();
  for (const c of clients) await c.dispose();
}
