import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
import fs from "node:fs";
import {
  BASE,
  setup,
  lab,
  oidcUi,
  browserApi,
  completeBody,
  loginExisting,
} from "./browser/helpers.ts";
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
  }),
  page = await context.newPage(),
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
  const run = await setup(
    page,
    context.request,
    "normal",
    "backend-oidc-" + Date.now(),
  );
  await lab(context.request, "policy", { run, trustEmail: true });
  await oidcUi(page);
  let row = (
    await db.query("SELECT * FROM oidc_transactions WHERE realm_id=$1", [run])
  ).rows[0];
  assert.equal(row.status, "VERIFIED");
  assert.equal(row.issuer, "https://localhost:18443/realms/signup-lab");
  assert.match(row.nonce_hash, /^[a-f0-9]{64}$/);
  assert.equal(row.verifier_ciphertext, null);
  assert.equal(row.proof.issuer, row.issuer);
  assert.equal(row.proof.provider, "main");
  assert.equal(row.proof.id_token, undefined);
  assert.equal(row.proof.access_token, undefined);
  passed++;
  const created = await browserApi(
    page,
    run,
    "signup/oidc/complete",
    "POST",
    completeBody({ password: null, confirmation: null }),
  );
  assert.equal(created.status, 201);
  const identity = (
    await db.query("SELECT * FROM external_identities WHERE realm_id=$1", [run])
  ).rows[0];
  assert.equal(identity.account_id, created.data.accountId);
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM password_credentials WHERE account_id=$1",
        [identity.account_id],
      )
    ).rows[0].count,
    "0",
  );
  assert.equal((await browserApi(page, run, "auth/me")).status, 401);
  passed++;
  const original = (
    await db.query(
      "SELECT a.id,p.encoded_hash FROM accounts a JOIN password_credentials p ON p.account_id=a.id JOIN account_emails e ON e.account_id=a.id WHERE a.realm_id=$1 AND e.email_key='existing@lab.test'",
      [run],
    )
  ).rows[0];
  await loginExisting(page);
  await oidcUi(page, "match", "LINK");
  const linked = await browserApi(
    page,
    run,
    "account/identities/link/complete",
    "POST",
    {},
  );
  assert.equal(linked.status, 200);
  const match = (
    await db.query(
      "SELECT * FROM external_identities WHERE realm_id=$1 AND subject='10000000-0000-0000-0000-000000000002'",
      [run],
    )
  ).rows[0];
  assert.equal(match.account_id, original.id);
  assert.equal(
    (
      await db.query(
        "SELECT encoded_hash FROM password_credentials WHERE account_id=$1",
        [original.id],
      )
    ).rows[0].encoded_hash,
    original.encoded_hash,
  );
  passed++;
  await oidcUi(page, "alice", "LINK");
  const rejected = await browserApi(
    page,
    run,
    "account/identities/link/complete",
    "POST",
    {},
  );
  assert.equal(rejected.status, 409);
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM external_identities WHERE realm_id=$1",
        [run],
      )
    ).rows[0].count,
    "2",
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM accounts WHERE realm_id=$1", [run]))
      .rows[0].count,
    "2",
  );
  passed++;
  const report = {
    status: "passed",
    stage: "oidc",
    passed,
    completedAt: new Date().toISOString(),
    evidence:
      "actual Keycloak browser redirect + code/PKCE + JWKS/claims + PostgreSQL credential and identity ownership checks",
  };
  fs.writeFileSync(
    "docs/verification/backend-oidc.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await db.end();
  await context.close();
  await browser.close();
}
