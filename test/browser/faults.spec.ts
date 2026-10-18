import { test, expect } from "@playwright/test";
import { createClient } from "redis";
import crypto from "node:crypto";
import {
  setup,
  lab,
  requestMail,
  mailFor,
  verifyEmail,
  browserApi,
  completeBody,
  oidcUi,
} from "./helpers";
const token = (mail: any) => new URL(mail.url).hash.slice(8);
test("F01 메일 커밋 직전 실패는 challenge·outbox·결과를 함께 롤백 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await lab(request, "fault", { run, point: "before-email-commit" });
  const body = {
    email: "rollback@lab.test",
    idempotencyKey: crypto.randomUUID(),
  };
  expect(
    (await browserApi(page, run, "signup/email/request", "POST", body)).status,
  ).toBe(503);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.mail).toHaveLength(0);
  expect(s.challenges).toHaveLength(0);
  expect(s.flows[0].issued_count).toBe(0);
  expect(
    (await browserApi(page, run, "signup/email/request", "POST", body)).status,
  ).toBe(202);
  await mailFor(page, request, run);
});
test("F02 실제 lease 소유 앱 종료 후 다른 작업자가 durable outbox 회수 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "short");
  let owner = "";
  try {
    await lab(request, "fault", { run, point: "hold-after-mail-claim" });
    await requestMail(page);
    await expect
      .poll(async () => {
        const s = await lab(request, "snapshot?run=" + run);
        owner = s.mail[0]?.lease_owner;
        return s.mail[0]?.state;
      })
      .toBe("LEASED");
    expect(["A", "B"]).toContain(owner);
    await lab(request, "app", { node: owner, action: "stop" });
    await lab(request, "fault", { run, point: "none" });
    await mailFor(page, request, run);
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.mail[0].lease_owner).not.toBe(owner);
    expect(s.mail[0].attempts).toBeGreaterThanOrEqual(2);
    expect(s.counts.signup_accounts).toBe(0);
  } finally {
    await lab(request, "fault", { run, point: "none" });
    if (owner) await lab(request, "app", { node: owner, action: "start" });
    await expect
      .poll(async () => (await lab(request, "health")).apps[owner || "A"], {
        timeout: 20000,
      })
      .toBe(200);
  }
});
test("F03 실제 SMTP 차단·재시도 상한·만료 작업 중단과 복구 @faults", async ({
  page,
  request,
}) => {
  let run = await setup(page, request, "short");
  try {
    await lab(request, "network", { target: "smtp", blocked: true });
    await requestMail(page);
    await expect
      .poll(
        async () => (await lab(request, "snapshot?run=" + run)).mail[0]?.state,
        { timeout: 15000 },
      )
      .toBe("DEAD");
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.mail[0].attempts).toBe(5);
    expect(s.counts.signup_accounts).toBe(0);
    expect(await lab(request, "mailbox?run=" + run)).toHaveLength(0);
  } finally {
    await lab(request, "network", { target: "smtp", blocked: false });
  }
  expect(
    (
      await browserApi(page, run, "signup/email/resend", "POST", {
        email: "new@lab.test",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);
  await mailFor(page, request, run);
  run = await setup(page, request, "expiry");
  await lab(request, "fault", { run, point: "hold-mail" });
  await requestMail(page);
  await page.waitForTimeout(3400);
  await lab(request, "fault", { run, point: "none" });
  await expect
    .poll(
      async () => (await lab(request, "snapshot?run=" + run)).mail[0]?.state,
    )
    .toBe("EXPIRED");
  expect(await lab(request, "mailbox?run=" + run)).toHaveLength(0);
});
test("F04 SMTP 250 응답 실제 유실과 작업자 종료 뒤 중복 메일·단일 가입 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "short");
  await lab(request, "smtp-drop", { run });
  await requestMail(page);
  await expect
    .poll(async () => (await lab(request, "mailbox?run=" + run)).length, {
      timeout: 12000,
    })
    .toBeGreaterThanOrEqual(2);
  const mails = await mailFor(page, request, run);
  expect(new Set(mails.map((m: any) => m.url)).size).toBe(1);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.challenges).toHaveLength(1);
  const owner = s.mail[0].lease_owner;
  try {
    await lab(request, "app", { node: owner, action: "stop" });
    expect(
      (
        await browserApi(
          page,
          run,
          "signup/email/verify",
          "POST",
          { token: token(mails[0]) },
          owner === "A" ? "B" : "A",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await browserApi(
          page,
          run,
          "signup/complete",
          "POST",
          completeBody(),
          owner === "A" ? "B" : "A",
        )
      ).status,
    ).toBe(201);
    expect(
      (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
    ).toBe(1);
  } finally {
    await lab(request, "app", { node: owner, action: "start" });
    await expect
      .poll(async () => (await lab(request, "health")).apps[owner], {
        timeout: 20000,
      })
      .toBe(200);
  }
});
test("F05 실제 SMTP에 옛 캡처 메일을 늦게 재주입해도 최신 세대만 확인 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "short");
  await requestMail(page);
  const old = (await mailFor(page, request, run))[0];
  await page.waitForTimeout(5100);
  expect(
    (
      await browserApi(page, run, "signup/email/resend", "POST", {
        email: "new@lab.test",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);
  let messages: any[] = [];
  await expect
    .poll(async () => {
      messages = await lab(request, "mailbox?run=" + run);
      return messages.length;
    })
    .toBe(2);
  const fresh = messages.find((m) => m.url !== old.url);
  await lab(request, "redeliver-mail", { run, id: old.id });
  await expect
    .poll(async () => (await lab(request, "mailbox?run=" + run)).length)
    .toBe(3);
  expect(
    (
      await browserApi(page, run, "signup/email/verify", "POST", {
        token: token(old),
      })
    ).status,
  ).toBe(410);
  expect(
    (
      await browserApi(page, run, "signup/email/verify", "POST", {
        token: token(fresh),
      })
    ).status,
  ).toBe(200);
});
test("F06 Redis 실제 TCP 차단 시 확인·가입은 503, 복구해도 만료 연장 없음 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await requestMail(page);
  const mail = (await mailFor(page, request, run))[0];
  const before = (await browserApi(page, run, "signup/status")).data;
  try {
    await lab(request, "network", { target: "redis", blocked: true });
    expect(
      (
        await browserApi(page, run, "signup/email/verify", "POST", {
          token: token(mail),
        })
      ).status,
    ).toBe(503);
  } finally {
    await lab(request, "network", { target: "redis", blocked: false });
  }
  await expect
    .poll(
      async () =>
        (
          await browserApi(page, run, "signup/email/verify", "POST", {
            token: token(mail),
          })
        ).status,
      { timeout: 15000 },
    )
    .toBe(200);
  const proof = (await browserApi(page, run, "signup/status")).data;
  try {
    await lab(request, "network", { target: "redis", blocked: true });
    expect(
      (await browserApi(page, run, "signup/complete", "POST", completeBody()))
        .status,
    ).toBe(503);
  } finally {
    await lab(request, "network", { target: "redis", blocked: false });
  }
  await expect
    .poll(async () => (await browserApi(page, run, "signup/status")).status, {
      timeout: 15000,
    })
    .toBe(200);
  const after = (await browserApi(page, run, "signup/status")).data;
  expect(after.flowExpiresAt).toBe(before.flowExpiresAt);
  expect(after.verifiedUntil).toBe(proof.verifiedUntil);
  const body = completeBody();
  await expect
    .poll(
      async () =>
        (await browserApi(page, run, "signup/complete", "POST", body)).status,
      { timeout: 15000 },
    )
    .toBe(201);
});
test("F07 DB 실제 차단과 커밋 후 HTTP 연결 유실을 구분해 결과 복구 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  const body = completeBody();
  try {
    await lab(request, "network", { target: "db", blocked: true });
    expect(
      (await browserApi(page, run, "signup/complete", "POST", body)).status,
    ).toBe(503);
  } finally {
    await lab(request, "network", { target: "db", blocked: false });
  }
  await expect
    .poll(async () => (await browserApi(page, run, "signup/status")).status, {
      timeout: 15000,
    })
    .toBe(200);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(0);
  const lost = await page.evaluate(
    async ({ run, body }) => {
      const c = await (
        await fetch("/api/context", { headers: { "X-Lab-Run": run } })
      ).json();
      try {
        await fetch("/api/signup/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Lab-Run": run,
            "X-CSRF-TOKEN": c.csrf,
            "X-Lab-Drop-Response": "1",
          },
          body: JSON.stringify(body),
        });
        return false;
      } catch {
        return true;
      }
    },
    { run, body },
  );
  expect(lost).toBe(true);
  expect(
    (await browserApi(page, run, "signup/complete", "POST", body)).status,
  ).toBe(200);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(1);
});
test("F08 실제 Redis 재시작·옛 문맥 복원으로 DB의 소비·완료 상태 우회 불가 @faults", async ({
  page,
  request,
  context,
}) => {
  const run = await setup(page, request);
  await verifyEmail(page, request, run);
  const sid = (await context.cookies()).find(
      (c) => c.name === "__Host-signup_context",
    )!.value,
    key =
      "signup:context:" + crypto.createHash("sha256").update(sid).digest("hex");
  const redis = createClient({ url: "redis://127.0.0.1:56479" });
  redis.on("error", () => {});
  await redis.connect();
  const old = await redis.get(key);
  expect(old).toBeTruthy();
  const body = completeBody();
  expect(
    (await browserApi(page, run, "signup/complete", "POST", body)).status,
  ).toBe(201);
  await redis.quit();
  await lab(request, "redis-restart", {});
  const restored = createClient({ url: "redis://127.0.0.1:56479" });
  restored.on("error", () => {});
  await restored.connect();
  await restored.set(key, old!, { EX: 120 });
  await restored.quit();
  await expect
    .poll(
      async () =>
        (await browserApi(page, run, "signup/complete", "POST", body)).status,
      { timeout: 15000 },
    )
    .toBe(200);
  expect(
    (await browserApi(page, run, "signup/complete", "POST", completeBody()))
      .status,
  ).toBe(409);
  expect(
    (await lab(request, "snapshot?run=" + run)).counts.signup_accounts,
  ).toBe(1);
});
test("F09 A 실제 종료 뒤 B에서 기존 흐름 확인·가입 계속 @faults", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await requestMail(page);
  const mail = (await mailFor(page, request, run))[0];
  try {
    await lab(request, "app", { node: "A", action: "stop" });
    const verified = await browserApi(
      page,
      run,
      "signup/email/verify",
      "POST",
      { token: token(mail) },
      "B",
    );
    expect(verified.status).toBe(200);
    expect(verified.instance).toBe("B");
    expect(
      (
        await browserApi(
          page,
          run,
          "signup/complete",
          "POST",
          completeBody(),
          "B",
        )
      ).status,
    ).toBe(201);
  } finally {
    await lab(request, "app", { node: "A", action: "start" });
    await expect
      .poll(async () => (await lab(request, "health")).apps.A, {
        timeout: 20000,
      })
      .toBe(200);
  }
});
test("F10 실제 IdP TCP 차단·JWKS 경계 실패·코드 소비 뒤 중단은 재시작 요구 @faults", async ({
  page,
  request,
}) => {
  for (const point of ["network", "fail-jwks", "after-token-exchange"]) {
    const run = await setup(page, request);
    if (point === "network")
      await lab(request, "network", { target: "idp", blocked: true });
    else await lab(request, "fault", { run, point });
    try {
      await oidcUi(page);
      await expect(page.getByRole("status")).toContainText(
        /DEPENDENCY_UNAVAILABLE|CHECKPOINT_INTERRUPTED|IDP_UNAVAILABLE|JWKS_UNAVAILABLE/,
      );
      const s = await lab(request, "snapshot?run=" + run);
      expect(s.counts.external_identities).toBe(0);
      expect(s.counts.signup_accounts).toBe(0);
      if (point === "after-token-exchange") {
        expect(s.oidc[0].status).toBe("EXCHANGING");
        expect(
          (
            await browserApi(
              page,
              run,
              "signup/oidc/complete",
              "POST",
              completeBody(),
            )
          ).status,
        ).not.toBe(201);
      }
    } finally {
      await lab(request, "network", { target: "idp", blocked: false });
      await lab(request, "fault", { run, point: "none" });
    }
  }
});
