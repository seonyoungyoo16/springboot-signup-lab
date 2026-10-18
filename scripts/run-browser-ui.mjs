import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    baseURL: "https://localhost:8470",
    ignoreHTTPSErrors: true,
  }),
  page = await context.newPage(),
  headers = { "X-Lab-Control": "1" };
try {
  const run = "runner-" + Date.now();
  await context.request.post("/lab/runs", { headers, data: { run } });
  await page.goto("/?run=" + run);
  await expect(page.getByRole("status")).toContainText("이메일을 입력");
  const probe = await context.request.post("/lab/test", {
    headers,
    data: { probe: true },
  });
  expect(probe.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const r = await (
          await context.request.get("/lab/test-result", { headers })
        ).json();
        return !r.running && r.result?.status === "failed";
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "검증 결과 새로고침", exact: true })
    .click();
  await expect(page.getByTestId("runner-state")).toContainText("실패");
  await page
    .getByRole("button", { name: "브라우저 전체 검증 실행", exact: true })
    .click();
  await expect(page.getByTestId("runner-state")).toContainText("실행 중");
  await expect(
    page.getByRole("button", { name: "브라우저 전체 검증 실행", exact: true }),
  ).toBeDisabled();
  let result;
  await expect
    .poll(
      async () => {
        result = await (
          await context.request.get("/lab/test-result", { headers })
        ).json();
        return !result.running;
      },
      { timeout: 300000, intervals: [2000] },
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "검증 결과 새로고침", exact: true })
    .click();
  expect(result.result.status).toBe("passed");
  expect(result.result.tests).toHaveLength(50);
  await expect(page.getByTestId("runner-state")).toContainText("통과");
  fs.copyFileSync(
    "test-results/summary.json",
    "docs/verification/browser-summary.json",
  );
  const report = {
    status: "passed",
    completedAt: new Date().toISOString(),
    evidence: [
      "isolated intentional failing assertion surfaced as failed",
      "actual UI button started Playwright child",
      "running state disables duplicate execution",
      "50 actual backend browser cases surfaced as passed",
    ],
  };
  fs.writeFileSync(
    "docs/verification/test-runner.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("UI runner and 50 browser cases passed");
} finally {
  await context.close();
  await browser.close();
}
