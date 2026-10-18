import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const b = await chromium.launch({ headless: true }),
  c = await b.newContext({
    baseURL: "https://localhost:8470",
    ignoreHTTPSErrors: true,
    viewport: { width: 1550, height: 1100 },
  }),
  p = await c.newPage();
try {
  fs.mkdirSync("docs/previews", { recursive: true });
  const run = "preview-" + Date.now();
  await c.request.post("/lab/runs", {
    headers: { "X-Lab-Control": "1" },
    data: { run },
  });
  await p.goto("/?run=" + run);
  await expect(p.getByRole("status")).toContainText("이메일을 입력");
  await p.screenshot({ path: "docs/previews/desktop.png", fullPage: true });
  await p.setViewportSize({ width: 390, height: 950 });
  await p.screenshot({ path: "docs/previews/mobile.png", fullPage: true });
  console.log("Actual app desktop/mobile previews captured");
} finally {
  await c.close();
  await b.close();
}
