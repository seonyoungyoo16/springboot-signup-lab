import { test, expect } from "@playwright/test";
import {
  setup,
  lab,
  verifyEmail,
  browserApi,
  completeBody,
  completeUi,
  oidcUi,
  loginExisting,
  PASSWORD,
} from "./helpers";
import pg from "pg";
async function sql(query: string, args: any[] = []) {
  const db = new pg.Client({
    host: "127.0.0.1",
    port: 55442,
    user: "signuplab",
    password: "signuplab_dev",
    database: "signuplab",
  });
  await db.connect();
  try {
    return (await db.query(query, args)).rows;
  } finally {
    await db.end();
  }
}
async function trustedSignup(page: any, request: any, run: string) {
  await lab(request, "policy", { run, trustEmail: true });
  await oidcUi(page);
  expect(
    (await browserApi(page, run, "signup/status")).data.emailVerified,
  ).toBe(true);
  expect((await completeUi(page)).status()).toBe(201);
}
test("O01 실제 Keycloak 코드·PKCE·서명 검증 후 SSO 가입 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await oidcUi(page);
  let s = await browserApi(page, run, "signup/status");
  expect(s.data.providerVerified).toBe(true);
  expect(s.data.emailVerified).toBe(false);
  await verifyEmail(page, request, run, "alice@lab.test");
  expect((await completeUi(page)).status()).toBe(201);
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.counts.accounts).toBe(2);
  expect(snap.counts.external_identities).toBe(1);
  expect(snap.counts.password_credentials).toBe(1);
  expect(snap.oidc[0].status).toBe("VERIFIED");
});
test("O02 같은 외부 신원의 재가입은 추가 계정 없이 기존 SSO 로그인 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await trustedSignup(page, request, run);
  await page.getByRole("button", { name: "새 가입 흐름", exact: true }).click();
  await oidcUi(page);
  await expect(page.getByRole("status")).toContainText(
    "IDENTITY_ALREADY_REGISTERED",
  );
  await oidcUi(page, "alice", "LOGIN");
  await expect(page.locator(".auth-state")).toContainText("alice@lab.test");
  expect((await lab(request, "snapshot?run=" + run)).counts.accounts).toBe(2);
});
test("O03 외부 이메일이 같아도 기존 계정에 자동 연결하지 않음 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await lab(request, "policy", { run, trustEmail: true });
  await oidcUi(page, "match");
  await expect(page.locator(".existing-account")).toBeVisible();
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.counts.accounts).toBe(1);
  expect(snap.counts.external_identities).toBe(0);
  expect((await browserApi(page, run, "auth/me")).status).toBe(401);
});
test("O04 기존 계정과 외부 신원을 확인한 명시적 연결 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await loginExisting(page);
  const before = (await browserApi(page, run, "auth/me")).data.accountId;
  await oidcUi(page, "match", "LINK");
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.external_identities,
  ).toBe(0);
  await page
    .getByRole("button", { name: "확인한 외부 신원 연결 확정", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("연결했습니다");
  const me = await browserApi(page, run, "auth/me");
  expect(me.data.accountId).toBe(before);
  expect(me.data.identities).toHaveLength(1);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.password_credentials,
  ).toBe(1);
  await oidcUi(page, "match", "REAUTH");
  await expect(page.locator(".auth-state")).toContainText("existing@lab.test");
});
test("O05 다른 계정에 연결된 신원은 옮겨 붙일 수 없음 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await trustedSignup(page, request, run);
  await loginExisting(page);
  await oidcUi(page, "alice", "LINK");
  await page
    .getByRole("button", { name: "확인한 외부 신원 연결 확정", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("다른 계정");
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.counts.accounts).toBe(2);
  expect(snap.counts.external_identities).toBe(1);
});
test("O06 issuer가 다르면 같은 subject인 다른 신원으로 판정 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const account = (
    await sql("SELECT id FROM accounts WHERE realm_id=$1", [run])
  )[0].id;
  await sql(
    "INSERT INTO external_identities(id,realm_id,account_id,issuer,subject,provider) VALUES($1,$2,$3,$4,$5,$6)",
    [
      crypto.randomUUID(),
      run,
      account,
      "https://localhost:18443/realms/signup-team",
      "10000000-0000-0000-0000-000000000001",
      "team",
    ],
  );
  await trustedSignup(page, request, run);
  const rows = await sql(
    "SELECT issuer,subject FROM external_identities WHERE realm_id=$1",
    [run],
  );
  expect(rows).toHaveLength(2);
  expect(rows[0].subject).toBe(rows[1].subject);
  expect(rows[0].issuer).not.toBe(rows[1].issuer);
});
test("O07 실제 IdP 이메일 변경도 기존 계정과 기본 이메일을 바꾸지 않음 @oidc", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await trustedSignup(page, request, run);
  const account = (await browserApi(page, run, "signup/status")).data.accountId;
  try {
    await lab(request, "idp-user", {
      provider: "main",
      username: "alice",
      email: "changed-alice@lab.test",
      emailVerified: true,
    });
    await oidcUi(page, "alice", "LOGIN");
    const me = await browserApi(page, run, "auth/me");
    expect(me.data.accountId).toBe(account);
    expect(me.data.email).toBe("alice@lab.test");
    expect((await lab(request, "snapshot?run=" + run)).counts.accounts).toBe(2);
  } finally {
    await lab(request, "idp-user", {
      provider: "main",
      username: "alice",
      email: "alice@lab.test",
      emailVerified: true,
    });
  }
});
test("O08 email 없음·미검증·미신뢰와 허용한 issuer 정책 분리 @oidc", async ({
  page,
  request,
}) => {
  for (const [user, provider, trust, verified] of [
    ["noemail", "main", true, false],
    ["unverified", "main", true, false],
    ["alice", "team", true, false],
    ["alice", "main", false, false],
    ["alice", "main", true, true],
  ] as const) {
    const run = await setup(page, request);
    await lab(request, "policy", { run, trustEmail: trust });
    await oidcUi(page, user, "SIGNUP", provider);
    const s = (await browserApi(page, run, "signup/status")).data;
    expect(s.providerVerified).toBe(true);
    expect(s.emailVerified).toBe(verified);
    if (user === "noemail") expect(s.email).toBeNull();
    expect(
      (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
    ).toBe(0);
  }
});
test("O09 실제 토큰의 검증 경계에서 state·nonce·iss·aud·서명·exp 거부 @oidc", async ({
  page,
  request,
}) => {
  for (const fault of [
    "oidc-invalid-nonce",
    "oidc-invalid-issuer",
    "oidc-invalid-audience",
    "oidc-invalid-signature",
    "oidc-invalid-expiry",
  ]) {
    const run = await setup(page, request);
    await lab(request, "fault", { run, point: fault });
    await oidcUi(page);
    await expect(page.getByRole("status")).toContainText("실패");
    const snap = await lab(request, "snapshot?run=" + run);
    expect(snap.counts.signup_accounts).toBe(0);
    expect(snap.counts.external_identities).toBe(0);
    expect(snap.oidc[0].status).not.toBe("VERIFIED");
  }
  const run = await setup(page, request);
  await browserApi(page, run, "signup/oidc/start", "POST", {
    provider: "main",
    intent: "SIGNUP",
  });
  await page.goto(
    "/oidc/callback/main?state=" + "x".repeat(43) + "&code=unused-code",
  );
  await expect(page.getByRole("status")).toContainText("OIDC_STATE_INVALID");
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(0);
});
test("O10 중복 callback은 재교환하지 않고 다른 프로필에서는 거부 @oidc", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  let callback = "";
  page.on("request", (r) => {
    if (r.url().includes("/oidc/callback/")) callback = r.url();
  });
  await oidcUi(page);
  expect(callback).not.toBe("");
  await page.goto(callback);
  await expect(page.getByRole("status")).toContainText("외부");
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true }),
    other = await ctx.newPage();
  await other.goto(callback);
  await expect(other.getByRole("status")).toContainText(
    "OIDC_CONTEXT_MISMATCH",
  );
  const traces = await lab(request, "traces?run=" + run);
  expect(
    traces
      .flatMap((t: any) => t.steps)
      .filter((s: any) => s.action === "code_exchanged"),
  ).toHaveLength(1);
  await ctx.close();
});
test("O11 연결 중 다른 탭의 로그아웃·사용자 교체·버전 폐기 @oidc", async ({
  page,
  request,
  context,
}) => {
  for (const action of ["logout", "switch", "revoke"]) {
    const run = await setup(page, request);
    if (action === "switch") {
      await verifyEmail(page, request, run, "other-local@lab.test");
      expect(
        (await browserApi(page, run, "signup/complete", "POST", completeBody()))
          .status,
      ).toBe(201);
    }
    await loginExisting(page);
    await page
      .getByRole("button", { name: "외부 신원 연결 시작", exact: true })
      .click();
    await page.waitForURL(/https:\/\/localhost:18443\//);
    const other = await context.newPage();
    await other.goto("/?run=" + run);
    if (action === "revoke") await lab(request, "revoke-auth", { run });
    else if (action === "logout")
      expect(
        (await browserApi(other, run, "auth/logout", "POST", {})).status,
      ).toBe(200);
    else await loginExisting(other, "other-local@lab.test");
    if (await page.locator("#username").isVisible())
      await page.locator("#username").fill("match");
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#kc-login").click();
    await page.waitForURL(
      (u) =>
        u.origin === "https://localhost:8470" &&
        !u.pathname.startsWith("/oidc/"),
    );
    await expect(page.getByRole("status")).toContainText("외부");
    const r = await browserApi(
      page,
      run,
      "account/identities/link/complete",
      "POST",
      {},
    );
    expect([401, 403]).toContain(r.status);
    expect(
      (await lab(request, "snapshot?run=" + run)).counts.external_identities,
    ).toBe(0);
    await other.close();
  }
});
test("O12 취소·실제 거래 만료·최근 인증 만료를 구분 @oidc", async ({
  page,
  request,
}) => {
  let run = await setup(page, request);
  const started = await browserApi(page, run, "signup/oidc/start", "POST", {
    provider: "main",
    intent: "SIGNUP",
  });
  const state = new URL(started.data.url).searchParams.get("state");
  await page.goto("/oidc/callback/main?error=access_denied&state=" + state);
  await expect(page.getByRole("status")).toContainText("OIDC_CANCELLED");
  run = await setup(page, request, "expiry");
  await page
    .getByRole("button", { name: "SSO로 가입 계속", exact: true })
    .click();
  await page.waitForURL(/https:\/\/localhost:18443\//);
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill(PASSWORD);
  await page.waitForTimeout(5200);
  await page.locator("#kc-login").click();
  await expect(page.getByRole("status")).toContainText(
    "OIDC_TRANSACTION_EXPIRED",
  );
  run = await setup(page, request, "expiry");
  await loginExisting(page);
  await page.waitForTimeout(3200);
  const r = await browserApi(page, run, "signup/oidc/start", "POST", {
    provider: "main",
    intent: "LINK",
  });
  expect(r.status).toBe(403);
  expect(r.data.code).toBe("REAUTH_REQUIRED");
});
test("D07 일반 가입과 실제 OIDC 가입의 이메일 동시 충돌 @oidc", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await lab(request, "policy", { run, trustEmail: true });
  await oidcUi(page);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true }),
    other = await ctx.newPage();
  await setup(other, request, "normal", run);
  await verifyEmail(other, request, run, "alice@lab.test");
  const results = await Promise.all([
    browserApi(
      page,
      run,
      "signup/oidc/complete",
      "POST",
      completeBody({ password: null, confirmation: null }),
      "A",
    ),
    browserApi(other, run, "signup/complete", "POST", completeBody(), "B"),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.counts.accounts).toBe(2);
  expect(s.counts.consent_records).toBe(2);
  expect(s.counts.external_identities).toBe(results[0].status === 201 ? 1 : 0);
  expect((await browserApi(page, run, "auth/me")).status).toBe(401);
  expect((await browserApi(other, run, "auth/me")).status).toBe(401);
  await ctx.close();
});
