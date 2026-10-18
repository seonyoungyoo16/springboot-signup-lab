import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  runtime = path.join(root, ".runtime");
const secrets = JSON.parse(
    fs.readFileSync(path.join(runtime, "secrets.json"), "utf8"),
  ),
  key = crypto.randomBytes(32).toString("hex");
const ports = { A: 8471, B: 8472 },
  apps = {},
  processes = {},
  network = { db: false, redis: false, smtp: false, idp: false },
  sockets = {
    db: new Set(),
    redis: new Set(),
    smtp: new Set(),
    idp: new Set(),
  },
  drops = new Map();
let smtpDrop = null,
  testProcess = null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const javaSettings = spawnSync(
  process.env.JAVA_BIN || "java",
  ["-XshowSettings:properties", "-version"],
  { encoding: "utf8", windowsHide: true },
);
const javaHome = (javaSettings.stderr || "")
  .match(/java\.home\s*=\s*([^\r\n]+)/)?.[1]
  ?.trim();
const javaBin =
  process.env.JAVA_BIN ||
  (javaHome
    ? path.join(
        javaHome,
        "bin",
        process.platform === "win32" ? "java.exe" : "java",
      )
    : "java");
for (const port of [8470, 8471, 8472, 55443, 56480, 11026, 18443, 18445])
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", () => reject(Error("Port " + port + " already in use")));
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
function child(name, file, args, env = {}) {
  const out = fs.openSync(path.join(runtime, name + ".log"), "a");
  const proc = spawn(file, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  processes[name] = proc;
  proc.on("exit", () => {
    if (processes[name] === proc) delete processes[name];
  });
  return proc;
}
if (!(await reachable(18025)))
  child("mailpit", path.join(runtime, "mailpit/mailpit.exe"), [
    "--listen",
    "127.0.0.1:18025",
    "--smtp",
    "127.0.0.1:11025",
    "--database",
    path.join(runtime, "mailpit.db"),
  ]);
if (!(await reachable(18444))) {
  const jdk = fs
    .readdirSync(path.join(runtime, "jdk25"))
    .map((name) => path.join(runtime, "jdk25", name))
    .find((dir) => fs.existsSync(path.join(dir, "bin/java.exe")));
  if (!jdk) throw Error("Keycloak JDK 25 missing");
  child(
    "keycloak",
    "cmd.exe",
    [
      "/d",
      "/c",
      path.join(runtime, "keycloak/keycloak-26.8.1/bin/kc.bat"),
      "start-dev",
      "--http-host=127.0.0.1",
      "--http-port=18444",
      "--hostname=https://localhost:18443",
      "--proxy-headers=xforwarded",
      "--import-realm",
    ],
    {
      JAVA_HOME: jdk,
      KC_BOOTSTRAP_ADMIN_USERNAME: "signup-admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: secrets.admin,
      KC_DIR: path.join(runtime, "keycloak/keycloak-26.8.1"),
      KC_HOME_DIR: path.join(runtime, "keycloak/keycloak-26.8.1"),
      KC_SPI_IMPORT_DIR: path.join(runtime, "realms"),
      KC_DB: "dev-file",
      KC_LOG_LEVEL: "WARN",
    },
  );
}
// flow:Gateway.network
function tcp(kind, listen, target) {
  net
    .createServer((client) => {
      if (network[kind]) {
        client.destroy();
        return;
      }
      const remote = net.connect(target, "127.0.0.1");
      sockets[kind].add(client);
      sockets[kind].add(remote);
      let payload = "",
        afterData = false,
        run = null;
      client.on("data", (chunk) => {
        if (kind === "smtp") {
          payload = (payload + chunk.toString()).slice(-100000);
          const m = payload.match(
            /Subject: Signup Lab \[run:([A-Za-z0-9_-]+)\]/i,
          );
          if (m) run = m[1];
          if (payload.includes("\r\n.\r\n")) afterData = true;
        }
        remote.write(chunk);
      });
      remote.on("data", (chunk) => {
        if (
          kind === "smtp" &&
          afterData &&
          run === smtpDrop &&
          chunk.toString().startsWith("250")
        ) {
          smtpDrop = null;
          client.destroy();
          remote.destroy();
          return;
        }
        client.write(chunk);
      });
      const close = () => {
        client.destroy();
        remote.destroy();
        sockets[kind].delete(client);
        sockets[kind].delete(remote);
      };
      client.on("error", close);
      remote.on("error", close);
      client.on("close", close);
      remote.on("close", close);
    })
    .listen(listen, "127.0.0.1");
}
tcp("db", 55443, 55442);
tcp("redis", 56480, 56479);
tcp("smtp", 11026, 11025);
tcp("idp", 18445, 18444);
function startApp(node) {
  if (apps[node] && apps[node].exitCode === null) return;
  const jar = path.join(runtime, "app-" + node + ".jar");
  fs.copyFileSync(path.join(root, "backend/target/signup-lab-1.0.0.jar"), jar);
  apps[node] = child("app-" + node, javaBin, ["-jar", jar], {
    APP_PORT: String(ports[node]),
    APP_INSTANCE: node,
    LAB_ENABLED: "true",
    LAB_KEY: key,
    SIGNUP_CRYPTO_KEY: secrets.crypto,
    OIDC_CLIENT_SECRET: secrets.oidc,
  });
}
async function stopApp(node) {
  const p = apps[node];
  if (p && p.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else p.kill();
    await Promise.race([
      new Promise((resolve) => p.once("exit", resolve)),
      pause(3000),
    ]);
  }
  delete apps[node];
}
startApp("A");
startApp("B");
function reachable(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.setTimeout(500);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}
function call(node, url, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: ports[node],
        path: url,
        method,
        headers: { "X-Lab-Key": key, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(data || "null"),
            });
          } catch {
            reject(Error("Invalid backend response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(7000, () => req.destroy(Error("Backend timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const tls = {
  key: fs.readFileSync(path.join(runtime, "dev-key.pem")),
  cert: fs.readFileSync(path.join(runtime, "dev-cert.pem")),
};
https
  .createServer(tls, (req, res) => {
    const up = http.request(
      {
        hostname: "127.0.0.1",
        port: 18444,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "localhost:18443",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "localhost:18443",
          "x-forwarded-port": "18443",
        },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      res.writeHead(503);
      res.end("IdP unavailable");
    });
    req.pipe(up);
  })
  .listen(18443, "127.0.0.1");
function reply(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = "";
  for await (const c of req) {
    text += c;
    if (text.length > 32000) throw Error("Body too large");
  }
  return text ? JSON.parse(text) : {};
}
async function mailbox(run) {
  const response = await fetch(
    "http://127.0.0.1:18025/api/v1/messages?limit=1000",
    { signal: AbortSignal.timeout(3000) },
  );
  if (!response.ok) throw Error("Mailpit unavailable");
  const data = await response.json();
  const items = (data.messages || []).filter((m) =>
    m.Subject?.includes("[run:" + run + "]"),
  );
  return Promise.all(
    items.map(async (m) => {
      const r = await fetch("http://127.0.0.1:18025/api/v1/message/" + m.ID);
      const full = await r.json();
      const url = (full.Text || "").match(
        /https:\/\/localhost:8470\/\?run=[A-Za-z0-9_-]+#verify=[A-Za-z0-9_.-]+/,
      )?.[0];
      return {
        flowId: (full.Text || "").match(/Flow: ([0-9a-f-]{36})/)?.[1],
        id: m.ID,
        subject: m.Subject,
        receivedAt: m.Created,
        recipient: (m.To?.[0]?.Address || "").replace(
          /^(.).+(@.+)$/,
          "$1***$2",
        ),
        url,
      };
    }),
  );
}
// flow:Gateway.response_lost
function loseResponse(up, res) {
  up.resume();
  up.on("end", () => {
    drops.set(up.headers["x-request-id"], new Date().toISOString());
    res.destroy();
  });
}
const main = https.createServer(tls, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://localhost:18443",
  );
  try {
    const u = new URL(req.url, "https://localhost:8470");
    if (!["localhost:8470", "127.0.0.1:8470"].includes(req.headers.host)) {
      reply(res, 400, { code: "HOST_REJECTED" });
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      !["https://localhost:8470", "https://127.0.0.1:8470"].includes(
        req.headers.origin,
      )
    ) {
      reply(res, 403, { code: "ORIGIN_REJECTED" });
      return;
    }
    if (u.pathname.startsWith("/internal/")) {
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    if (u.pathname.startsWith("/lab/")) {
      if (req.headers["x-lab-control"] !== "1") {
        reply(res, 403, { code: "LAB_CONTROL_REQUIRED" });
        return;
      }
      const run = u.searchParams.get("run");
      if (run && !/^[A-Za-z0-9_-]{1,80}$/.test(run)) {
        reply(res, 400, { code: "INVALID_RUN" });
        return;
      }
      if (u.pathname === "/lab/health") {
        const state = {};
        for (const n of ["A", "B"])
          try {
            state[n] = (await call(n, "/health")).status;
          } catch {
            state[n] = 503;
          }
        reply(res, 200, {
          apps: state,
          mailpit: await reachable(18025),
          keycloak: await reachable(18444),
        });
        return;
      }
      if (u.pathname === "/lab/runs" && req.method === "POST") {
        const b = await body(req);
        const n = apps.A?.exitCode === null ? "A" : "B";
        const r = await call(n, "/internal/lab/runs", "POST", b);
        reply(res, r.status, r.body);
        return;
      }
      if (u.pathname === "/lab/snapshot") {
        const n = apps.A?.exitCode === null ? "A" : "B";
        const r = await call(n, "/internal/lab/snapshot?run=" + run);
        reply(res, r.status, r.body);
        return;
      }
      if (u.pathname === "/lab/traces") {
        const traces = [];
        for (const n of ["A", "B"])
          try {
            const r = await call(n, "/internal/lab/traces?run=" + run);
            if (Array.isArray(r.body)) traces.push(...r.body);
          } catch {}
        for (const t of traces)
          if (drops.has(t.id))
            t.steps.push({
              node: "Browser",
              action: "response_lost",
              message: "서버 처리 뒤 실제 응답 연결 유실",
              source: "Gateway.response_lost",
              at: drops.get(t.id),
            });
        reply(
          res,
          200,
          traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        );
        return;
      }
      if (u.pathname === "/lab/mailbox") {
        reply(res, 200, await mailbox(run));
        return;
      }
      if (
        ["/lab/fault", "/lab/policy", "/lab/revoke-auth"].includes(
          u.pathname,
        ) &&
        req.method === "POST"
      ) {
        const b = await body(req);
        const name = u.pathname.split("/").at(-1);
        for (const n of ["A", "B"])
          if (apps[n]?.exitCode === null) {
            const r = await call(n, "/internal/lab/" + name, "POST", b);
            if (r.status >= 400) {
              reply(res, r.status, r.body);
              return;
            }
          }
        reply(res, 200, { status: "updated" });
        return;
      }
      if (u.pathname === "/lab/network" && req.method === "POST") {
        const b = await body(req);
        if (!Object.hasOwn(network, b.target)) {
          reply(res, 400, { code: "INVALID_TARGET" });
          return;
        }
        network[b.target] = !!b.blocked;
        for (const socket of sockets[b.target]) socket.destroy();
        reply(res, 200, { network });
        return;
      }
      if (u.pathname === "/lab/smtp-drop" && req.method === "POST") {
        smtpDrop = (await body(req)).run;
        reply(res, 200, { status: "armed" });
        return;
      }
      if (u.pathname === "/lab/redeliver-mail" && req.method === "POST") {
        const b = await body(req);
        await redeliverMail(b.run, b.id);
        reply(res, 200, { status: "smtp-reinjected" });
        return;
      }
      if (u.pathname === "/lab/idp-user" && req.method === "POST") {
        const b = await body(req);
        const { updateIdpUser } = await import("./configure-idp.mjs");
        await updateIdpUser(b.provider, b.username, b.email, b.emailVerified);
        reply(res, 200, { status: "updated" });
        return;
      }
      if (u.pathname === "/lab/app" && req.method === "POST") {
        const b = await body(req);
        if (!ports[b.node]) throw Error("Invalid app");
        if (b.action === "stop") await stopApp(b.node);
        else startApp(b.node);
        reply(res, 200, { status: b.action });
        return;
      }
      if (u.pathname === "/lab/redis-restart" && req.method === "POST") {
        const b = await body(req);
        await restartRedis();
        if (b.clearRun) {
          const { createClient } = await import("redis");
          const client = createClient({ url: "redis://127.0.0.1:56479" });
          await client.connect();
          const keys = await client.keys("signup:context:*");
          if (keys.length) await client.del(keys);
          await client.quit();
        }
        reply(res, 200, { status: "restarted" });
        return;
      }
      if (u.pathname === "/lab/test" && req.method === "POST") {
        if (testProcess) {
          reply(res, 409, { code: "TEST_RUNNING" });
          return;
        }
        const config = await body(req);
        testProcess = child(
          "browser-tests",
          process.execPath,
          config.probe
            ? [path.join(root, "test/runner-probe.mjs")]
            : [path.join(root, "node_modules/@playwright/test/cli.js"), "test"],
          {},
        );
        testProcess.on("exit", () => (testProcess = null));
        reply(res, 202, { status: "started" });
        return;
      }
      if (u.pathname === "/lab/test-result") {
        let result = null;
        try {
          result = JSON.parse(
            fs.readFileSync(
              path.join(root, "test-results/summary.json"),
              "utf8",
            ),
          );
        } catch {}
        reply(res, 200, { running: !!testProcess, result });
        return;
      }
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/oidc/")) {
      let node = req.headers["x-lab-node"] === "B" ? "B" : "A";
      if (!apps[node] || apps[node].exitCode !== null)
        node = node === "A" ? "B" : "A";
      const headers = {
        ...req.headers,
        host: "localhost:8470",
        "x-lab-client-ip": "127.0.0.1",
      };
      delete headers["x-lab-key"];
      const up = http.request(
        {
          hostname: "127.0.0.1",
          port: ports[node],
          path: u.pathname + u.search,
          method: req.method,
          headers,
        },
        (r) => {
          if (
            req.headers["x-lab-drop-response"] === "1" &&
            req.method !== "GET"
          ) {
            loseResponse(r, res);
            return;
          }
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent)
          reply(res, 503, {
            code: "APP_UNAVAILABLE",
            message: "앱의 처리 결과를 확인할 수 없습니다.",
          });
        else res.destroy();
      });
      up.setTimeout(20000, () => up.destroy());
      req.pipe(up);
      return;
    }
    const relative =
      u.pathname === "/flow-source.json"
        ? "public/flow-source.json"
        : u.pathname.startsWith("/assets/")
          ? "dist" + u.pathname
          : "dist/index.html";
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("Build the frontend first");
      return;
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : file.endsWith(".json")
              ? "application/json"
              : "application/octet-stream",
    );
    fs.createReadStream(file).pipe(res);
  } catch {
    if (!res.headersSent)
      reply(res, 503, {
        code: "OBSERVATION_UNAVAILABLE",
        message: "실제 저장소·메일·서버 상태를 확인할 수 없습니다.",
      });
    else res.destroy();
  }
});
main.listen(8470, "127.0.0.1", () =>
  console.log(
    "Signup lab https://localhost:8470 · IdP https://localhost:18443",
  ),
);
void (async () => {
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(
        "http://127.0.0.1:18444/realms/signup-lab/.well-known/openid-configuration",
        { signal: AbortSignal.timeout(1000) },
      );
      if (r.ok) {
        const { configureIdp } = await import("./configure-idp.mjs");
        await configureIdp();
        return;
      }
    } catch {}
    await pause(500);
  }
  console.warn(
    "Keycloak fixture initialization not ready; inspect owned runtime log",
  );
})();
fs.writeFileSync(
  path.join(runtime, "processes.json"),
  JSON.stringify(
    { root, gateway: process.pid, startedAt: new Date().toISOString() },
    null,
    2,
  ),
);
async function restartRedis() {
  network.redis = false;
  for (const s of sockets.redis) s.destroy();
  const dir = path.join(runtime, "redis/Redis-7.4.3-Windows-x64-cygwin");
  spawnSync(
    path.join(dir, "redis-cli.exe"),
    ["-p", "56479", "SHUTDOWN", "SAVE"],
    { windowsHide: true, stdio: "ignore" },
  );
  await pause(500);
  const data = path.join(runtime, "redis-data");
  const unix =
    "/cygdrive/" + data[0].toLowerCase() + data.slice(2).replaceAll("\\", "/");
  child("redis-restarted", path.join(dir, "redis-server.exe"), [
    "--bind",
    "127.0.0.1",
    "--port",
    "56479",
    "--dir",
    unix,
    "--appendonly",
    "yes",
  ]);
  for (let i = 0; i < 30; i++) {
    if (await reachable(56479)) return;
    await pause(200);
  }
  throw Error("Redis restart failed");
}
async function shutdown() {
  for (const name of Object.keys(processes)) {
    const p = processes[name];
    if (p.exitCode !== null) continue;
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else p.kill();
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// flow:Gateway.redeliver
async function redeliverMail(run, id) {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(run) ||
    typeof id !== "string" ||
    id.length > 80
  )
    throw Error("Invalid captured message");
  const response = await fetch(
    "http://127.0.0.1:18025/api/v1/message/" + encodeURIComponent(id),
  );
  const full = await response.json();
  if (!response.ok || !full.Subject?.includes("[run:" + run + "]"))
    throw Error("Message outside run");
  const recipient = full.To?.[0]?.Address;
  if (!recipient || /[\r\n]/.test(recipient))
    throw Error("Invalid captured recipient");
  const content =
    "From: signup@lab.test\r\nTo: " +
    recipient +
    "\r\nSubject: " +
    full.Subject +
    "\r\nMessage-ID: <" +
    crypto.randomUUID() +
    "@lab.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" +
    full.Text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..") +
    "\r\n.\r\n";
  await new Promise((resolve, reject) => {
    const socket = net.connect(11025, "127.0.0.1");
    let buffer = "",
      stage = 0;
    const commands = [
      "EHLO signup-lab\r\n",
      "MAIL FROM:<signup@lab.test>\r\n",
      "RCPT TO:<" + recipient + ">\r\n",
      "DATA\r\n",
      content,
      "QUIT\r\n",
    ];
    socket.setTimeout(5000, () =>
      socket.destroy(Error("SMTP reinjection timeout")),
    );
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (code >= 400) {
          socket.destroy();
          reject(Error("Captured mail SMTP rejected"));
          return;
        }
        if (stage === commands.length) {
          socket.end();
          resolve();
          return;
        }
        socket.write(commands[stage++]);
      }
    });
  });
}
