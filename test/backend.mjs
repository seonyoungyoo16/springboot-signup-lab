import { spawnSync } from "node:child_process";
import fs from "node:fs";
const stages = ["email", "accounts", "oidc"];
for (const stage of stages) {
  const r = spawnSync(
    process.execPath,
    stage === "oidc"
      ? ["--experimental-strip-types", "test/backend-oidc.ts"]
      : ["test/backend-" + stage + ".mjs"],
    { stdio: "inherit", windowsHide: true },
  );
  if (r.status !== 0) process.exit(r.status || 1);
}
const results = stages.map((s) =>
  JSON.parse(
    fs.readFileSync("docs/verification/backend-" + s + ".json", "utf8"),
  ),
);
const summary = {
  status: "passed",
  passed: results.reduce((n, r) => n + r.passed, 0),
  completedAt: new Date().toISOString(),
  stages: results,
};
fs.writeFileSync(
  "docs/verification/backend-summary.json",
  JSON.stringify(summary, null, 2) + "\n",
);
console.log("Actual backend assertions passed: " + summary.passed);
