import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
const runtime = ".runtime";
fs.mkdirSync(runtime, { recursive: true });
if (!fs.existsSync(runtime + "/secrets.json"))
  fs.writeFileSync(
    runtime + "/secrets.json",
    JSON.stringify({
      crypto: crypto.randomBytes(32).toString("base64"),
      oidc: crypto.randomBytes(32).toString("base64url"),
      admin: crypto.randomBytes(24).toString("base64url"),
    }),
  );
const secrets = JSON.parse(fs.readFileSync(runtime + "/secrets.json", "utf8"));
const db = new pg.Client({
  host: "127.0.0.1",
  port: 55442,
  user: "signuplab",
  password: "signuplab_dev",
  database: "postgres",
});
await db.connect();
try {
  const r = await db.query(
    "SELECT 1 FROM pg_database WHERE datname='signuplab'",
  );
  if (!r.rowCount) await db.query("CREATE DATABASE signuplab");
} finally {
  await db.end();
}
fs.mkdirSync(runtime + "/realms", { recursive: true });
for (const realm of ["signup-lab", "signup-team"]) {
  const users = ["alice", "match", "unverified", "noemail", "other"].map(
    (name, i) => ({
      id: `${realm === "signup-lab" ? "1" : "2"}0000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
      username: name,
      enabled: true,
      email: name === "match" ? "existing@lab.test" : name + "@lab.test",
      emailVerified: name !== "unverified",
      firstName: "Lab",
      lastName: name,
      credentials: [
        { type: "password", value: "Signup!2026LongPass", temporary: false },
      ],
      requiredActions: [],
    }),
  );
  const data = {
    realm,
    enabled: true,
    sslRequired: "none",
    registrationAllowed: false,
    loginWithEmailAllowed: false,
    duplicateEmailsAllowed: true,
    verifyEmail: false,
    resetPasswordAllowed: false,
    users,
    clients: [
      {
        clientId: "signup-lab",
        name: "Signup Lab",
        enabled: true,
        publicClient: false,
        secret: secrets.oidc,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: [
          "https://localhost:8470/oidc/callback/main",
          "https://localhost:8470/oidc/callback/team",
        ],
        webOrigins: ["https://localhost:8470"],
        attributes: { "pkce.code.challenge.method": "S256" },
        defaultClientScopes: ["profile", "email"],
        optionalClientScopes: [],
      },
    ],
  };
  fs.writeFileSync(
    `${runtime}/realms/${realm}.json`,
    JSON.stringify(data, null, 2),
  );
}
console.log("Project database and isolated IdP realm imports prepared");
