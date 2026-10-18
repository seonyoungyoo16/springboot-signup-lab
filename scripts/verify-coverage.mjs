import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
const ids = [
  ...Array.from({ length: 10 }, (_, i) => "E" + String(i + 1).padStart(2, "0")),
  ...Array.from({ length: 8 }, (_, i) => "D" + String(i + 1).padStart(2, "0")),
  ...Array.from({ length: 12 }, (_, i) => "O" + String(i + 1).padStart(2, "0")),
  ...Array.from({ length: 10 }, (_, i) => "F" + String(i + 1).padStart(2, "0")),
  ...Array.from({ length: 6 }, (_, i) => "S" + String(i + 1).padStart(2, "0")),
  ...Array.from({ length: 4 }, (_, i) => "U" + String(i + 1).padStart(2, "0")),
];
const cases = fs
  .readdirSync("test/browser")
  .filter((f) => f.endsWith(".spec.ts"))
  .flatMap((file) =>
    Array.from(
      fs
        .readFileSync("test/browser/" + file, "utf8")
        .matchAll(/test\(\s*["']([EDOFSU]\d\d)\s/g),
    ).map((m) => ({ id: m[1], file: "test/browser/" + file })),
  );
assert.deepEqual(cases.map((t) => t.id).sort(), [...ids].sort());
const report = JSON.parse(
  fs.readFileSync("docs/verification/browser-summary.json", "utf8"),
);
assert.equal(report.status, "passed");
assert.deepEqual(report.tests.map((t) => t.id).sort(), [...ids].sort());
assert.ok(report.tests.every((t) => t.status === "passed"));
const backend = JSON.parse(
  fs.readFileSync("docs/verification/backend-summary.json", "utf8"),
);
assert.equal(backend.status, "passed");
assert.equal(backend.passed, 12);
const sources = JSON.parse(fs.readFileSync("public/flow-source.json", "utf8"));
for (const s of Object.values(sources)) {
  const text = fs.readFileSync(s.file, "utf8");
  assert.equal(
    crypto.createHash("sha256").update(text).digest("hex"),
    s.sha256,
  );
  assert.equal(
    text
      .split(/\r?\n/)
      .slice(s.line - 1, s.line + 35)
      .join("\n"),
    s.snippet,
  );
}
const lines = [
  "# 요구사항과 실제 실행 근거",
  "",
  "기본 50개 전부 실제 백엔드 연결 브라우저 실행을 통과했다. 실제 SQL 저장 내용의 별도 검증은 12개다. T01~T04(여러 RP SSO)는 원본 설계의 후속 범위다.",
  "",
  "| ID | 브라우저 시나리오 | 구현된 검사 | 결과 |",
  "|---|---|---|---|",
  ...ids.map((id) => {
    const t = report.tests.find((t) => t.id === id),
      c = cases.find((c) => c.id === id);
    return `| ${id} | ${t.title.slice(4)} | [${c.file}](../../${c.file}) | ${t.status} |`;
  }),
  "",
  "출처: [브라우저 결과](browser-summary.json), [실제 SQL 검증](backend-summary.json), [실행기 진단](test-runner.json).",
  "",
  "방법: F01과 JWKS 등 지정 경계 중단은 코드 체크포인트, F02/F09는 실제 앱 종료, F03/F06/F07/F10은 실제 TCP 차단이다. F04는 SMTP 250 실제 응답을 제거한다. F05는 캡처한 옛 메일을 SMTP로 재주입해 지연 도착을 통제한다. O09는 실제 토큰의 서명 변형 또는 검증기의 기대 issuer/audience/nonce/시간을 통제한다. 실제 IdP가 잘못된 클레임을 발급했다는 주장이 아니다.",
  "",
  "개별 성공 단계를 기록한 파일보다 browser-summary.json의 전체 실행이 최종 기준이다.",
];
fs.writeFileSync("docs/verification/COVERAGE.md", lines.join("\n") + "\n");
console.log(
  `50 browser cases, 12 backend checks, ${Object.keys(sources).length} actual source anchors verified`,
);
