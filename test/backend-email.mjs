import { request } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
import fs from "node:fs";
const run = "backend-email-" + Date.now(),
  api = await request.newContext({
    baseURL: "https://localhost:8470",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
  }),
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55442,
    user: "signuplab",
    password: "signuplab_dev",
    database: "signuplab",
  });
let passed = 0;
try {
  await db.connect();
  let r = await api.post("/lab/runs", {
    headers: { "X-Lab-Control": "1" },
    data: { run, policy: "short" },
  });
  assert.equal(r.status(), 200);
  const c = await (await api.get("/api/context")).json();
  const headers = { "X-CSRF-TOKEN": c.csrf };
  r = await api.post("/api/signup/flows", { headers, data: {} });
  assert.equal(r.status(), 201);
  const flow = await r.json();
  const idem = crypto.randomUUID();
  r = await api.post("/api/signup/email/request", {
    headers,
    data: { email: "New@LAB.test", idempotencyKey: idem },
  });
  assert.equal(r.status(), 202);
  const rows = await db.query(
    "SELECT c.token_hash,o.payload_ciphertext,f.email_key FROM email_challenges c JOIN signup_flows f ON f.id=c.flow_id JOIN mail_outbox o ON o.flow_id=f.id WHERE f.id=$1",
    [flow.flowId],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].email_key, "new@lab.test");
  assert.match(rows.rows[0].token_hash, /^[a-f0-9]{64}$/);
  assert.ok(rows.rows[0].payload_ciphertext);
  passed++;
  r = await api.post("/api/signup/email/request", {
    headers,
    data: { email: "New@LAB.test", idempotencyKey: idem },
  });
  assert.equal(r.status(), 202);
  assert.equal((await r.json()).replayed, true);
  assert.equal(
    (
      await db.query("SELECT count(*) FROM email_challenges WHERE flow_id=$1", [
        flow.flowId,
      ])
    ).rows[0].count,
    "1",
  );
  passed++;
  let mail = [];
  for (let i = 0; i < 50; i++) {
    const d = await (
      await api.get("/lab/mailbox?run=" + run, {
        headers: { "X-Lab-Control": "1" },
      })
    ).json();
    if (Array.isArray(d) && d.length) {
      mail = d;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(mail.length, 1);
  assert.ok(mail[0].url);
  const token = new URL(mail[0].url).hash.slice(8);
  assert.equal(
    (
      await db.query("SELECT state FROM email_challenges WHERE flow_id=$1", [
        flow.flowId,
      ])
    ).rows[0].state,
    "ACTIVE",
  );
  passed++;
  r = await api.post("/api/signup/email/verify", { headers, data: { token } });
  assert.equal(r.status(), 200);
  assert.equal(
    (
      await db.query("SELECT state FROM email_challenges WHERE flow_id=$1", [
        flow.flowId,
      ])
    ).rows[0].state,
    "CONSUMED",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM accounts WHERE realm_id=$1 AND name<>'기존 회원'",
        [run],
      )
    ).rows[0].count,
    "0",
  );
  passed++;
  fs.writeFileSync(
    "docs/verification/backend-email.json",
    JSON.stringify(
      {
        status: "passed",
        stage: "email",
        passed,
        completedAt: new Date().toISOString(),
        evidence:
          "actual HTTPS + PostgreSQL hashes/encrypted outbox + Mailpit SMTP message + token consumption",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      stage: "email",
      passed,
      evidence:
        "actual HTTPS + PostgreSQL hashes/outbox + Mailpit SMTP message + token consumption",
    }),
  );
} finally {
  await db.end();
  await api.dispose();
}
