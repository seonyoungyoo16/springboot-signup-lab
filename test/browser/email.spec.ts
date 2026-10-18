import { test, expect } from "@playwright/test";
import {
  setup,
  lab,
  requestMail,
  mailFor,
  verifyEmail,
  browserApi,
} from "./helpers";
test("E01 실제 SMTP 수신과 명시적 이메일 확인 @email", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await expect(page.getByLabel("가입 비밀번호", { exact: true })).toHaveCount(
    0,
  );
  await verifyEmail(page, request, run);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.counts.signup_accounts).toBe(0);
  expect(s.challenges[0].state).toBe("CONSUMED");
  expect(s.mail[0].state).toBe("SMTP_ACCEPTED");
  await expect(page.getByLabel("가입 비밀번호", { exact: true })).toBeVisible();
});
test("E02 메일 링크 GET은 확인 증명을 소비하지 않음 @email", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await requestMail(page);
  const mail = await mailFor(page, request, run);
  await page.goto(mail[0].url);
  await expect(
    page.getByRole("button", { name: "이메일 확인 완료하기" }),
  ).toBeVisible();
  await page.reload();
  expect((await lab(request, "snapshot?run=" + run)).challenges[0].state).toBe(
    "ACTIVE",
  );
  expect(
    (await browserApi(page, run, "signup/status")).data.emailVerified,
  ).toBe(false);
});
test("E03 다른 브라우저의 확인 요청은 원래 링크를 소비하지 않음 @email", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await requestMail(page);
  const mail = (await mailFor(page, request, run))[0];
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const other = await ctx.newPage();
  await other.goto(mail.url);
  await other.getByRole("button", { name: "이메일 확인 완료하기" }).click();
  await expect(other.getByRole("status")).toContainText("404");
  expect((await lab(request, "snapshot?run=" + run)).challenges[0].state).toBe(
    "ACTIVE",
  );
  await ctx.close();
  await page.goto(mail.url);
  await page.getByRole("button", { name: "이메일 확인 완료하기" }).click();
  await expect(page.locator(".flow-state")).toContainText("확인됨");
});
test("E04 같은 프로필 두 탭의 동시 확인은 한 번만 확정 @email", async ({
  page,
  request,
  context,
}) => {
  const run = await setup(page, request);
  await requestMail(page);
  const mail = (await mailFor(page, request, run))[0],
    token = new URL(mail.url).hash.slice(8);
  const other = await context.newPage();
  await other.goto("/?run=" + run);
  const results = await Promise.all([
    browserApi(page, run, "signup/email/verify", "POST", { token }, "A"),
    browserApi(other, run, "signup/email/verify", "POST", { token }, "B"),
  ]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.challenges).toHaveLength(1);
  expect(s.challenges[0].state).toBe("CONSUMED");
  await other.close();
});
test("E05 재발송한 현재 세대만 유효 @email", async ({ page, request }) => {
  const run = await setup(page, request, "short");
  await requestMail(page);
  const first = (await mailFor(page, request, run))[0];
  await page.waitForTimeout(5100);
  await page.getByRole("button", { name: "메일 재발송", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("202");
  await expect
    .poll(async () => (await mailFor(page, request, run)).length)
    .toBe(2);
  const messages = await mailFor(page, request, run),
    second = messages.find((m) => m.id !== first.id);
  expect(
    (
      await browserApi(page, run, "signup/email/verify", "POST", {
        token: new URL(first.url).hash.slice(8),
      })
    ).status,
  ).toBe(410);
  await page.goto(second.url);
  await page.getByRole("button", { name: "이메일 확인 완료하기" }).click();
  await expect(page.locator(".flow-state")).toContainText("확인됨");
});
test("E06 A·B 동시 재발송과 간격·횟수 제한 @email", async ({
  page,
  request,
  context,
}) => {
  const run = await setup(page, request, "expiry");
  await requestMail(page);
  const body = { email: "new@lab.test", idempotencyKey: crypto.randomUUID() };
  expect(
    (await browserApi(page, run, "signup/email/resend", "POST", body, "B"))
      .status,
  ).toBe(429);
  await page.waitForTimeout(1100);
  const tab = await context.newPage();
  await tab.goto("/?run=" + run);
  const responses = await Promise.all([
    browserApi(
      page,
      run,
      "signup/email/resend",
      "POST",
      { ...body, idempotencyKey: crypto.randomUUID() },
      "A",
    ),
    browserApi(
      tab,
      run,
      "signup/email/resend",
      "POST",
      { ...body, idempotencyKey: crypto.randomUUID() },
      "B",
    ),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([202, 429]);
  expect((await lab(request, "snapshot?run=" + run)).challenges).toHaveLength(
    2,
  );
  await page.waitForTimeout(1100);
  expect(
    (
      await browserApi(page, run, "signup/email/resend", "POST", {
        ...body,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);
  await page.waitForTimeout(1100);
  expect(
    (
      await browserApi(page, run, "signup/email/resend", "POST", {
        ...body,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(429);
  await tab.close();
});
test("E07 실제 경과 시간 이후 링크 만료 @email", async ({ page, request }) => {
  const run = await setup(page, request, "expiry");
  await requestMail(page);
  const mail = (await mailFor(page, request, run))[0];
  await page.waitForTimeout(3300);
  await page.goto(mail.url);
  await page.getByRole("button", { name: "이메일 확인 완료하기" }).click();
  await expect(page.getByRole("status")).toContainText("410");
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.counts.signup_accounts).toBe(0);
  expect(s.challenges[0].consumed_at).toBeNull();
});
test("E08 주소 변경은 이미 확인한 증명을 무효화 @email", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  await page
    .getByLabel("가입 이메일", { exact: true })
    .fill("changed@lab.test");
  await page.getByRole("button", { name: "이메일 수정 반영" }).click();
  await expect(page.getByRole("status")).toContainText("EMAIL_CHANGED");
  expect(
    (await browserApi(page, run, "signup/status")).data.emailVerified,
  ).toBe(false);
  await expect(page.getByLabel("가입 비밀번호", { exact: true })).toHaveCount(
    0,
  );
});
test("E09 새로고침과 A→B 이동은 기존 흐름과 메일을 유지 @email", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await requestMail(page);
  const mail = (await mailFor(page, request, run))[0];
  const first = (await browserApi(page, run, "signup/status")).data.flowId;
  await page.reload();
  await page.getByLabel("처리 서버").selectOption("B");
  await page.goto(mail.url);
  await page.getByRole("button", { name: "이메일 확인 완료하기" }).click();
  await expect(page.locator(".flow-state")).toContainText("확인됨");
  const status = await browserApi(
    page,
    run,
    "signup/status",
    "GET",
    undefined,
    "B",
  );
  expect(status.instance).toBe("B");
  expect(status.data.flowId).toBe(first);
  expect((await lab(request, "snapshot?run=" + run)).mail).toHaveLength(1);
});
test("E10 기존 주소도 같은 접수 응답, 소유 확인 뒤 기존 계정 안내 @email", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run, "existing@lab.test");
  await expect(page.locator(".existing-account")).toBeVisible();
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.counts.accounts).toBe(1);
  expect(s.counts.password_credentials).toBe(1);
  expect(s.counts.signup_accounts).toBe(0);
});
