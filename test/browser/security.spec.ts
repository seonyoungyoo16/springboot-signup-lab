import { test, expect } from "@playwright/test";
import fs from "node:fs";
import {
  setup,
  lab,
  verifyEmail,
  browserApi,
  completeBody,
  oidcUi,
  PASSWORD,
} from "./helpers";
test("S01 변경 API의 CSRF 누락·다른 출처 요청은 쓰기 전에 거부 @security", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const paths = [
    "signup/email/request",
    "signup/email/verify",
    "signup/complete",
    "account/identities/link/complete",
  ];
  for (const path of paths)
    expect(
      (
        await browserApi(
          page,
          run,
          path,
          "POST",
          { ...completeBody(), email: "csrf@lab.test", token: "invalid" },
          "A",
          false,
        )
      ).status,
    ).toBe(403);
  const foreign = await request.post("/api/signup/email/request", {
    headers: { Origin: "https://attacker.invalid", "X-Lab-Run": run },
    data: { email: "csrf@lab.test" },
  });
  expect(foreign.status()).toBe(403);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.mail).toHaveLength(0);
  expect(s.counts.signup_accounts).toBe(0);
  expect(s.counts.external_identities).toBe(0);
});
test("S02 다른 브라우저·실행에 ID와 멱등 키를 대입해도 소유 결과 접근 불가 @security", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  const body = completeBody(),
    owner = await browserApi(page, run, "signup/complete", "POST", body);
  expect(owner.status).toBe(201);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true }),
    other = await ctx.newPage();
  await setup(other, request, "normal", run);
  const wrong = await browserApi(other, run, "signup/complete", "POST", body);
  expect(wrong.status).toBe(403);
  expect(wrong.data.accountId).toBeUndefined();
  expect(
    (await browserApi(other, run, "signup/status")).data.accountId,
  ).toBeNull();
  const another = "other-" + Date.now();
  await lab(request, "runs", { run: another, policy: "normal" });
  expect((await browserApi(page, another, "signup/status")).status).toBe(403);
  expect((await browserApi(other, run, "auth/me")).status).toBe(401);
  await ctx.close();
});
test("S03 실제 흐름·스냅샷·보고서·정리된 URL에 인증 원문이 남지 않음 @security", async ({
  page,
  request,
  context,
}) => {
  const run = await setup(page, request),
    mail = await verifyEmail(page, request, run, "private-mail@lab.test");
  expect(page.url()).not.toContain("#verify");
  let callback = "";
  page.on("request", (r) => {
    if (r.url().includes("/oidc/callback/") && r.url().includes("code="))
      callback = r.url();
  });
  await oidcUi(page);
  expect(callback).toContain("code=");
  expect(page.url()).not.toMatch(/[?#&](code|state|verify)=/);
  const traces = await lab(request, "traces?run=" + run),
    snapshot = await lab(request, "snapshot?run=" + run),
    report = fs.readFileSync("test-results/summary.json", "utf8"),
    serialized = JSON.stringify({ traces, snapshot }) + report;
  const cookies = await context.cookies();
  for (const cookie of cookies.filter((c) =>
    c.name.startsWith("__Host-signup"),
  )) {
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");
    expect(serialized).not.toContain(cookie.value);
  }
  for (const secret of [
    PASSWORD,
    "private-mail@lab.test",
    new URL(mail.url).hash.slice(8),
    new URL(callback).searchParams.get("code")!,
  ])
    expect(serialized).not.toContain(secret);
  expect(serialized).not.toMatch(
    /pkce_verifier|verifier_ciphertext|id_token|access_token|encoded_hash/,
  );
});
test("S04 A·B의 실제 Redis 이메일 제한은 원자적이며 위조 IP로 우회 불가 @security", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request),
    contexts: any[] = [],
    pages = [page];
  try {
    for (let i = 0; i < 6; i++) {
      const c = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(c);
      const p = await c.newPage();
      pages.push(p);
      await setup(p, request, "normal", run);
    }
    const rs = await Promise.all(
      pages.map((p, i) =>
        browserApi(
          p,
          run,
          "signup/email/request",
          "POST",
          { email: "limit@lab.test", idempotencyKey: crypto.randomUUID() },
          i % 2 ? "A" : "B",
          true,
          { "X-Lab-Client-IP": "192.0.2." + i },
        ),
      ),
    );
    expect(rs.filter((r) => r.status === 202)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(2);
    for (const r of rs.filter((r) => r.status === 429))
      expect(Number(r.retryAfter)).toBeGreaterThan(3500);
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.mail).toHaveLength(5);
    expect(s.limits.filter((l: any) => l.kind === "ip")).toHaveLength(1);
    expect(s.limits.find((l: any) => l.kind === "ip").ttl).toBeLessThanOrEqual(
      600,
    );
    expect(s.limits.find((l: any) => l.kind === "email").ttl).toBeGreaterThan(
      3500,
    );
  } finally {
    for (const c of contexts) await c.close();
  }
});
test("S05 Host·외부 Origin·공급자·리다이렉트 조작과 메일 HTML 입력 거부 @security", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  expect(
    (
      await request.get("/api/context", {
        headers: { Host: "attacker.invalid" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await browserApi(page, run, "signup/oidc/start", "POST", {
        provider: "https://attacker.invalid",
        intent: "SIGNUP",
      })
    ).status,
  ).toBe(400);
  const started = await browserApi(page, run, "signup/oidc/start", "POST", {
    provider: "main",
    intent: "SIGNUP",
    redirectUri: "https://attacker.invalid",
    issuer: "https://attacker.invalid",
  });
  expect(started.status).toBe(200);
  const url = new URL(started.data.url);
  expect(url.origin).toBe("https://localhost:18443");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://localhost:8470/oidc/callback/main",
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  for (const email of [
    "<img src=x onerror=alert(1)>@lab.test",
    "victim@lab.test\r\nBcc:other@lab.test",
  ])
    expect(
      (
        await browserApi(page, run, "signup/email/request", "POST", {
          email,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
  expect((await lab(request, "snapshot?run=" + run)).mail).toHaveLength(0);
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll('img[onerror],script[src*="attacker"]')
          .length,
    ),
  ).toBe(0);
  expect(
    (await request.get("/internal/lab/snapshot?run=" + run)).status(),
  ).toBe(404);
});
test("S06 IDN 이메일·공백과 한글 비밀번호를 보존하고 길이·동의 정책 적용 @security", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  for (const email of [
    "a".repeat(65) + "@lab.test",
    "user@" + "x".repeat(250) + ".test",
    "공백@lab.test",
  ])
    expect(
      (
        await browserApi(page, run, "signup/email/request", "POST", {
          email,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
  await verifyEmail(page, request, run, "User@예시.한국");
  const password = "  공백도 보존하는 긴 비밀번호 2026!  ";
  for (const bad of ["short", "a".repeat(129)])
    expect(
      (
        await browserApi(
          page,
          run,
          "signup/complete",
          "POST",
          completeBody({ password: bad, confirmation: bad }),
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await browserApi(
        page,
        run,
        "signup/complete",
        "POST",
        completeBody({ password, confirmation: password, terms: false }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(0);
  expect(
    (
      await browserApi(
        page,
        run,
        "signup/complete",
        "POST",
        completeBody({ password, confirmation: password }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await browserApi(page, run, "auth/login", "POST", {
        email: "user@xn--vv4b11d.xn--3e0b707e",
        password: password.trim(),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await browserApi(page, run, "auth/login", "POST", {
        email: "User@예시.한국",
        password,
      })
    ).status,
  ).toBe(200);
});
