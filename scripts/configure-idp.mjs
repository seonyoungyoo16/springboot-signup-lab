import fs from "node:fs";
const secrets = JSON.parse(fs.readFileSync(".runtime/secrets.json", "utf8")),
  base = "http://127.0.0.1:18444";
export async function configureIdp() {
  const r = await fetch(base + "/realms/master/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "signup-admin",
      password: secrets.admin,
    }),
  });
  if (!r.ok) throw Error("Local IdP admin unavailable");
  const token = await r.json(),
    headers = {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
    };
  for (const realm of ["signup-lab", "signup-team"]) {
    const url = base + "/admin/realms/" + realm;
    const profile = await (
      await fetch(url + "/users/profile", { headers })
    ).json();
    for (const a of profile.attributes || [])
      if (["email", "firstName", "lastName"].includes(a.name))
        delete a.required;
    const p = await fetch(url + "/users/profile", {
      method: "PUT",
      headers,
      body: JSON.stringify(profile),
    });
    if (!p.ok) throw Error("Local IdP profile setup failed");
    const users = await (
        await fetch(url + "/users?username=noemail", { headers })
      ).json(),
      user = users.find((u) => u.username === "noemail");
    const d = await fetch(url + "/users/" + user.id, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...user, email: "", emailVerified: false }),
    });
    if (!d.ok) throw Error("Local IdP fixture setup failed");
  }
  console.log("Actual Keycloak fixtures ready");
}
export async function updateIdpUser(provider, username, email, emailVerified) {
  if (
    !["main", "team"].includes(provider) ||
    !["alice", "match", "unverified", "noemail", "other"].includes(username) ||
    typeof email !== "string" ||
    email.length > 254 ||
    typeof emailVerified !== "boolean"
  )
    throw Error("Invalid isolated IdP fixture");
  const r = await fetch(base + "/realms/master/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "signup-admin",
      password: secrets.admin,
    }),
  });
  if (!r.ok) throw Error("Local IdP admin unavailable");
  const token = await r.json(),
    headers = {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
    },
    realm = provider === "main" ? "signup-lab" : "signup-team",
    url = base + "/admin/realms/" + realm;
  const users = await (
      await fetch(url + "/users?username=" + username, { headers })
    ).json(),
    user = users.find((u) => u.username === username);
  const result = await fetch(url + "/users/" + user.id, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...user, email, emailVerified }),
  });
  if (!result.ok) throw Error("Local IdP fixture update failed");
}
if (process.argv[1]?.endsWith("configure-idp.mjs")) await configureIdp();
