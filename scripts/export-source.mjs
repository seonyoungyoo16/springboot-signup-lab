import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const result = {};
const java = "backend/src/main/java/dev/portfolio/signuplab";
for (const file of [
  ...fs
    .readdirSync(java)
    .filter((n) => n.endsWith(".java"))
    .map((n) => java + "/" + n),
  "scripts/gateway.mjs",
]) {
  const text = fs.readFileSync(file, "utf8"),
    lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/flow:([\w.]+)/);
    if (m)
      result[m[1]] = {
        file,
        line: i + 2,
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
        snippet: lines.slice(i + 1, i + 37).join("\n"),
      };
  });
}
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync(
  "public/flow-source.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(Object.keys(result).length + " actual source anchors");
