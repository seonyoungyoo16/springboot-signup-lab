import { expect, type Page, type APIRequestContext } from "@playwright/test";
export const BASE = "https://localhost:8470",
  CONTROL = { "X-Lab-Control": "1" },
  PASSWORD = "Signup!2026LongPass";
export async function lab(
  request: APIRequestContext,
  path: string,
  body?: any,
) {
  const r = body
    ? await request.post("/lab/" + path, { headers: CONTROL, data: body })
    : await request.get("/lab/" + path, { headers: CONTROL });
  expect(r.status()).toBe(200);
  return r.json();
}
export async function setup(
  page: Page,
  request: APIRequestContext,
  policy = "normal",
  run?: string,
) {
  run = run || "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await expect
    .poll(
      async () =>
        (
          await request.get("/api/context", { headers: { "X-Lab-Run": run! } })
        ).status(),
      { timeout: 15000 },
    )
    .toBe(200);
  await lab(request, "runs", { run, policy });
  await page.goto("/?run=" + run);
  await expect(page.getByRole("status")).toContainText("이메일을 입력");
  return run;
}
export async function browserApi(
  page: Page,
  run: string,
  path: string,
  method = "GET",
  body?: any,
  node = "A",
  withCsrf = true,
  extraHeaders: Record<string, string> = {},
) {
  return page.evaluate(
    async ({ run, path, method, body, node, withCsrf, extraHeaders }) => {
      let token = "";
      if (withCsrf && method !== "GET") {
        const r = await fetch("/api/context", {
          headers: { "X-Lab-Run": run, "X-Lab-Node": node },
        });
        token = (await r.json()).csrf;
      }
      const r = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Lab-Run": run,
          "X-Lab-Node": node,
          ...(token ? { "X-CSRF-TOKEN": token } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = r.status === 204 ? null : await r.json();
      return {
        status: r.status,
        data,
        instance: r.headers.get("x-app-instance"),
        retryAfter: r.headers.get("retry-after"),
      };
    },
    { run, path, method, body, node, withCsrf, extraHeaders },
  );
}
export async function requestMail(page: Page, email = "new@lab.test") {
  await page.getByLabel("가입 이메일", { exact: true }).fill(email);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/signup/email/request") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "인증 메일 요청", exact: true })
    .click();
  expect((await response).status()).toBe(202);
  await expect(page.getByRole("status")).toContainText("202");
}
export async function mailFor(
  page: Page,
  request: APIRequestContext,
  run: string,
) {
  const f = await browserApi(page, run, "signup/status");
  let messages: any[] = [];
  await expect
    .poll(
      async () => {
        messages = await lab(request, "mailbox?run=" + run);
        return messages.filter((m) => m.flowId === f.data.flowId && m.url)
          .length;
      },
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
  return messages.filter((m) => m.flowId === f.data.flowId && m.url);
}
export async function verifyEmail(
  page: Page,
  request: APIRequestContext,
  run: string,
  email = "new@lab.test",
) {
  await requestMail(page, email);
  const messages = await mailFor(page, request, run);
  await page.goto(messages[0].url);
  await expect(
    page.getByRole("button", { name: "이메일 확인 완료하기", exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/signup/email/verify") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "이메일 확인 완료하기", exact: true })
    .click();
  expect((await response).status()).toBe(200);
  await expect(page.locator(".flow-state")).toContainText("이메일 확인됨");
  return messages[0];
}
export function completeBody(overrides: any = {}) {
  return {
    name: "신규 회원",
    password: PASSWORD,
    confirmation: PASSWORD,
    terms: true,
    marketing: false,
    termsVersion: 1,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}
export async function completeUi(page: Page) {
  await page.getByLabel("필수 약관 동의", { exact: false }).check();
  const r = page.waitForResponse(
    (r) =>
      /\/api\/signup\/(oidc\/)?complete$/.test(r.url()) &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "가입 확정하고 흐름 보기", exact: true })
    .click();
  return r;
}
export async function oidcUi(
  page: Page,
  username = "alice",
  intent = "SIGNUP",
  provider = "main",
) {
  if (intent !== "LOGIN")
    await page.context().clearCookies({
      name: /^(AUTH_SESSION_ID|AUTH_SESSION_ID_LEGACY|KEYCLOAK_IDENTITY|KEYCLOAK_IDENTITY_LEGACY|KEYCLOAK_SESSION|KEYCLOAK_SESSION_LEGACY|KC_RESTART)$/,
    });
  await page.getByLabel("외부 인증 공급자").selectOption(provider);
  const names: Record<string, string> = {
    SIGNUP: "SSO로 가입 계속",
    LOGIN: "기존 SSO로 로그인",
    LINK: "외부 신원 연결 시작",
    REAUTH: "기존 SSO 재확인",
  };
  const callback = page.waitForResponse(
    (r) => r.url().includes("/oidc/callback/"),
    { timeout: 20000 },
  );
  await page.getByRole("button", { name: names[intent], exact: true }).click();
  await Promise.race([
    page.locator("#password").waitFor({ state: "visible", timeout: 15000 }),
    callback,
  ]);
  if (await page.locator("#username").isVisible())
    await page.locator("#username").fill(username);
  if (await page.locator("#password").isVisible())
    await page.locator("#password").fill(PASSWORD);
  if (await page.locator("#kc-login").isVisible())
    await page.locator("#kc-login").click();
  await page.waitForURL(
    (url) => url.origin === BASE && !url.pathname.startsWith("/oidc/"),
    { timeout: 20000 },
  );
  await expect(page.getByRole("status")).toContainText("외부");
}
export async function loginExisting(
  page: Page,
  email = "existing@lab.test",
  password = PASSWORD,
) {
  await page.getByLabel("기존 계정 이메일", { exact: true }).fill(email);
  await page.getByLabel("기존 계정 비밀번호", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "기존 계정 로그인", exact: true })
    .click();
  await expect(page.locator(".auth-state")).toContainText("로그인됨");
}
