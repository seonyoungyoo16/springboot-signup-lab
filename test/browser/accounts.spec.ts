import { test, expect } from "@playwright/test";
import {
  setup,
  lab,
  verifyEmail,
  browserApi,
  completeBody,
  completeUi,
  PASSWORD,
} from "./helpers";
test("D01 계정·자격정보·동의 원자 커밋과 별도 실제 로그인 @accounts", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  expect((await completeUi(page)).status()).toBe(201);
  await expect(page.locator(".success")).toBeVisible();
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.counts.signup_accounts).toBe(1);
  expect(snap.counts.accounts).toBe(2);
  expect(snap.counts.password_credentials).toBe(2);
  expect(snap.counts.consent_records).toBe(2);
  expect((await browserApi(page, run, "auth/me")).status).toBe(401);
  await page
    .getByLabel("기존 계정 이메일", { exact: true })
    .fill("new@lab.test");
  await page
    .getByRole("button", { name: "기존 계정 로그인", exact: true })
    .click();
  await expect(page.locator(".auth-state")).toContainText(
    "로그인됨 · new@lab.test",
  );
});
test("D02 같은 키의 동시 제출은 계정·동의 한 번 확정 @accounts", async ({
  page,
  request,
  context,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  const other = await context.newPage();
  await other.goto("/?run=" + run);
  const body = completeBody();
  const results = await Promise.all([
    browserApi(page, run, "signup/complete", "POST", body, "A"),
    browserApi(other, run, "signup/complete", "POST", body, "B"),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
  expect(results[0].data.accountId).toBe(results[1].data.accountId);
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.counts.signup_accounts).toBe(1);
  expect(snap.counts.consent_records).toBe(2);
  await other.close();
});
test("D03 실제 응답 연결 유실 뒤 같은 가입 결과 복구 @accounts", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  await page.getByLabel("필수 약관 동의", { exact: false }).check();
  await page.getByLabel("다음 변경 응답 연결 유실").check();
  await page
    .getByRole("button", { name: "가입 확정하고 흐름 보기", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("응답 연결이 유실");
  await page
    .getByRole("button", { name: "가입 결과 확인", exact: true })
    .click();
  await expect(page.locator(".success")).toBeVisible();
  await page.getByRole("button", { name: "같은 가입 요청 재전송" }).click();
  await expect(page.getByRole("status")).toContainText("200");
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(1);
});
test("D04 같은 키에 다른 입력은 409이며 최초 데이터 유지 @accounts", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  const body = completeBody(),
    first = await browserApi(page, run, "signup/complete", "POST", body);
  expect(first.status).toBe(201);
  const changed = await browserApi(page, run, "signup/complete", "POST", {
    ...body,
    name: "덮어쓰기",
    password: "Different!2026LongPass",
    confirmation: "Different!2026LongPass",
    marketing: true,
  });
  expect(changed.status).toBe(409);
  expect(changed.data.code).toBe("IDEMPOTENCY_KEY_REUSED");
  const signed = await browserApi(page, run, "auth/login", "POST", {
    email: "new@lab.test",
    password: PASSWORD,
  });
  expect(signed.status).toBe(200);
  expect(signed.data.name).toBe("신규 회원");
});
test("D05 두 독립 브라우저의 같은 이메일 동시 가입 @accounts", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request),
    ctx = await browser.newContext({ ignoreHTTPSErrors: true }),
    other = await ctx.newPage();
  await setup(other, request, "normal", run);
  await verifyEmail(page, request, run, "same@lab.test");
  await verifyEmail(other, request, run, "same@lab.test");
  const results = await Promise.all([
    browserApi(page, run, "signup/complete", "POST", completeBody(), "A"),
    browserApi(other, run, "signup/complete", "POST", completeBody(), "B"),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.counts.accounts).toBe(2);
  expect(snap.counts.password_credentials).toBe(2);
  expect(snap.counts.consent_records).toBe(2);
  expect((await browserApi(other, run, "auth/me")).status).toBe(401);
  await ctx.close();
});
test("D06 이메일 비교 정책은 대소문자 중복만 합치고 별칭을 추정하지 않음 @accounts", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run, "User.Name+tag@LAB.test");
  expect(
    (await browserApi(page, run, "signup/complete", "POST", completeBody()))
      .status,
  ).toBe(201);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true }),
    other = await ctx.newPage();
  await setup(other, request, "normal", run);
  await verifyEmail(other, request, run, "user.name+tag@lab.test");
  await expect(other.locator(".existing-account")).toBeVisible();
  expect(
    (await browserApi(other, run, "signup/complete", "POST", completeBody()))
      .status,
  ).toBe(409);
  await other
    .getByRole("button", { name: "새 가입 흐름", exact: true })
    .click();
  await verifyEmail(other, request, run, "username+tag@lab.test");
  expect(
    (await browserApi(other, run, "signup/complete", "POST", completeBody()))
      .status,
  ).toBe(201);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(2);
  await ctx.close();
});
test("D08 확인 증명 만료와 필수 동의 변경은 계정 생성 전 거부 @accounts", async ({
  page,
  request,
}) => {
  let run = await setup(page, request, "expiry");
  await verifyEmail(page, request, run);
  await page.waitForTimeout(3200);
  expect(
    (await browserApi(page, run, "signup/complete", "POST", completeBody()))
      .status,
  ).toBe(403);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(0);
  run = await setup(page, request);
  await verifyEmail(page, request, run);
  await lab(request, "policy", { run, termsVersion: 2 });
  const r = await browserApi(
    page,
    run,
    "signup/complete",
    "POST",
    completeBody(),
  );
  expect(r.status).toBe(409);
  expect(r.data.code).toBe("TERMS_UPDATED");
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(0);
});
