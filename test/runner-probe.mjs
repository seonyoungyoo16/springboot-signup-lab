import fs from "node:fs";
import assert from "node:assert/strict";
fs.mkdirSync("test-results", { recursive: true });
const result = {
  status: "running",
  startedAt: new Date().toISOString(),
  tests: [],
};
fs.writeFileSync("test-results/summary.json", JSON.stringify(result));
await new Promise((r) => setTimeout(r, 300));
try {
  assert.fail("Intentional isolated runner diagnostic");
} catch {
  result.status = "failed";
  result.finishedAt = new Date().toISOString();
  result.tests = [
    {
      id: "RUNNER_PROBE",
      title: "의도적인 실행기 오류 전달 진단",
      status: "failed",
      error: "Intentional diagnostic only",
    },
  ];
  fs.writeFileSync(
    "test-results/summary.json",
    JSON.stringify(result, null, 2),
  );
  process.exitCode = 1;
}
