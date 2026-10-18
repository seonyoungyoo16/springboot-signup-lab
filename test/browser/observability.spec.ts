import { test, expect } from "@playwright/test";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  setup,
  lab,
  verifyEmail,
  requestMail,
  browserApi,
  completeUi,
} from "./helpers";
test("U01 관찰 화면을 열어두어도 실제 흐름·확인 증명 만료 연장 없음 @ui", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await verifyEmail(page, request, run);
  const before = await browserApi(page, run, "signup/status");
  await page.waitForTimeout(3500);
  const after = await browserApi(page, run, "signup/status");
  expect(after.data.flowExpiresAt).toBe(before.data.flowExpiresAt);
  expect(after.data.verifiedUntil).toBe(before.data.verifiedUntil);
  expect(after.data.emailVerified).toBe(false);
  await page.waitForTimeout(11500);
  expect([404, 410]).toContain(
    (await browserApi(page, run, "signup/status")).status,
  );
  const expired = await lab(request, "snapshot?run=" + run);
  expect(new Date(expired.flows[0].expires_at).getTime()).toBeLessThan(
    Date.now(),
  );
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(0);
});
test("U02 네 가지 뷰포트에서 패널 이동·입력·오류·포커스와 가로 넘침 확인 @ui", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  for (const width of [390, 768, 1440, 1800]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const label of ["서비스", "메일함", "흐름·소스", "데이터", "검증"]) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      if (width === 390) await tab.click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      if (width === 390)
        expect(await page.locator(".pane:visible").count()).toBe(1);
    }
    if (width === 390)
      await page.getByRole("tab", { name: "서비스", exact: true }).click();
    await page.getByLabel("가입 이메일", { exact: true }).focus();
    await expect(page.getByLabel("가입 이메일", { exact: true })).toBeFocused();
  }
  await requestMail(page);
  await page
    .getByRole("button", { name: "인증 메일 요청", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("429");
  expect((await lab(request, "snapshot?run=" + run)).mail).toHaveLength(1);
});
test("U03 실제 이벤트의 모든 소스 발췌·행·해시와 DB 상태 확인 @ui", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  expect((await completeUi(page)).status()).toBe(201);
  const traces = await lab(request, "traces?run=" + run),
    sources = await (await request.get("/flow-source.json")).json();
  let count = 0;
  for (const trace of traces)
    for (const step of trace.steps) {
      const source = sources[step.source];
      expect(source, step.source).toBeTruthy();
      const text = fs.readFileSync(source.file, "utf8");
      expect(crypto.createHash("sha256").update(text).digest("hex")).toBe(
        source.sha256,
      );
      expect(
        text
          .split(/\r?\n/)
          .slice(source.line - 1, source.line + 35)
          .join("\n"),
      ).toBe(source.snippet);
      count++;
    }
  expect(count).toBeGreaterThan(8);
  await expect
    .poll(async () =>
      page.getByLabel("실행 기록 선택").locator("option").count(),
    )
    .toBeGreaterThan(2);
  await page
    .getByLabel("실행 기록 선택")
    .selectOption(
      traces.find((t: any) => t.path === "/api/signup/complete").id,
    );
  await expect(page.locator(".source")).toBeVisible();
  await page.getByRole("button", { name: "마지막 단계", exact: true }).click();
  await expect(page.locator(".source")).toContainText("TraceLog.java");
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(1);
});
test("U04 실제 실행기 상태 표시·중복 실행 방지와 처리 경계 제어 @ui", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await page
    .getByRole("button", { name: "검증 결과 새로고침", exact: true })
    .click();
  const result = await lab(request, "test-result");
  await expect(page.getByTestId("runner-state")).toContainText(
    result.running
      ? "실행 중"
      : result.result?.status === "passed"
        ? "통과"
        : result.result?.status === "failed"
          ? "실패"
          : "미실행",
  );
  if (result.running)
    await expect(
      page.getByRole("button", {
        name: "브라우저 전체 검증 실행",
        exact: true,
      }),
    ).toBeDisabled();
  await page.getByLabel("중단 지점").selectOption("before-email-commit");
  await page
    .getByRole("button", { name: "처리 지점 적용", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("before-email-commit");
  await page
    .getByLabel("가입 이메일", { exact: true })
    .fill("ui-fault@lab.test");
  await page
    .getByRole("button", { name: "인증 메일 요청", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("503");
  expect((await lab(request, "snapshot?run=" + run)).mail).toHaveLength(0);
});
