import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Step = {
  node: string;
  action: string;
  message: string;
  source: string;
  at: string;
};
type Trace = {
  id: string;
  run: string;
  instance: string;
  method: string;
  path: string;
  status: number;
  startedAt: string;
  steps: Step[];
};
const CONTROL = { "X-Lab-Control": "1", "Content-Type": "application/json" };
const initialUrl = new URL(location.href),
  run =
    initialUrl.searchParams.get("run") ||
    "demo-" + crypto.randomUUID().slice(0, 8);
const initialToken = location.hash.startsWith("#verify=")
  ? location.hash.slice(8)
  : "";
initialUrl.searchParams.set("run", run);
initialUrl.hash = "";
history.replaceState(null, "", initialUrl);
function App() {
  const [status, setStatus] = useState<any>(null),
    [snapshot, setSnapshot] = useState<any>(null),
    [mail, setMail] = useState<any[]>([]),
    [traces, setTraces] = useState<Trace[]>([]),
    [selected, setSelected] = useState<Trace | null>(null),
    [step, setStep] = useState(0),
    [playing, setPlaying] = useState(false),
    [sources, setSources] = useState<Record<string, any>>({});
  const [email, setEmail] = useState("new@lab.test"),
    [name, setName] = useState("새 회원"),
    [password, setPassword] = useState("Signup!2026LongPass"),
    [confirm, setConfirm] = useState("Signup!2026LongPass"),
    [terms, setTerms] = useState(false),
    [marketing, setMarketing] = useState(false),
    [notice, setNotice] = useState("실험실을 준비하고 있습니다."),
    [busy, setBusy] = useState(false),
    [pendingToken, setPendingToken] = useState(initialToken),
    [node, setNode] = useState("A"),
    [tab, setTab] = useState("service"),
    [sourceOpen, setSourceOpen] = useState(true),
    [uncertain, setUncertain] = useState(false),
    [dropNext, setDropNext] = useState(false),
    [auth, setAuth] = useState<any>(null),
    [authEmail, setAuthEmail] = useState("existing@lab.test"),
    [authPassword, setAuthPassword] = useState("Signup!2026LongPass"),
    [provider, setProvider] = useState("main"),
    [fault, setFault] = useState("none"),
    [network, setNetwork] = useState<Record<string, boolean>>({}),
    [testResult, setTestResult] = useState<any>(null),
    [now, setNow] = useState(Date.now());
  const csrf = useRef(""),
    completionKey = useRef(crypto.randomUUID()),
    lastComplete = useRef<any>(null),
    drop = useRef(false),
    lastEmail = useRef<any>(null);
  const current = selected?.steps[step],
    source = current ? sources[current.source] : null;
  async function lab(path: string, body?: any) {
    const r = await fetch("/lab/" + path, {
      method: body ? "POST" : "GET",
      headers: CONTROL,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (!r.ok)
      throw Error(
        d.code === "TEST_RUNNING"
          ? "브라우저 검증이 이미 실행 중입니다."
          : d.message || "실제 관찰·제어 결과 확인 불가",
      );
    return d;
  }
  async function prepare() {
    const r = await fetch("/api/context", {
      headers: { "X-Lab-Run": run, "X-Lab-Node": node },
    });
    const d = await r.json();
    if (!r.ok) throw Error("브라우저 문맥을 준비할 수 없습니다.");
    csrf.current = d.csrf;
  }
  async function observe(requestId?: string) {
    try {
      const [s, t, m] = await Promise.all([
        lab("snapshot?run=" + run),
        lab("traces?run=" + run),
        lab("mailbox?run=" + run),
      ]);
      setSnapshot(s);
      setTraces(t);
      setMail(m);
      if (requestId) {
        const found = t.find((v: Trace) => v.id === requestId);
        if (found) {
          setSelected(found);
          setStep(0);
          setPlaying(true);
        }
      }
    } catch {
      setSnapshot((old: any) => ({ ...old, unavailable: true }));
    }
  }
  async function api(
    path: string,
    method = "GET",
    body?: any,
    retry = true,
  ): Promise<any> {
    const id = crypto.randomUUID(),
      willDrop = drop.current && method !== "GET";
    if (willDrop) {
      drop.current = false;
      setDropNext(false);
    }
    let r: Response;
    try {
      r = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Lab-Run": run,
          "X-Lab-Node": node,
          "X-Request-Id": id,
          ...(csrf.current ? { "X-CSRF-TOKEN": csrf.current } : {}),
          ...(willDrop ? { "X-Lab-Drop-Response": "1" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      setUncertain(true);
      await observe(id);
      throw Error(
        "응답 연결이 유실되었습니다. 같은 요청 결과를 확인해 주세요.",
      );
    }
    const d = r.status === 204 ? {} : await r.json();
    await observe(id);
    if (r.status === 403 && d.code === "CSRF_INVALID" && retry) {
      await prepare();
      return api(path, method, body, false);
    }
    setUncertain(r.status >= 500);
    return { response: r, data: d };
  }
  async function refreshStatus() {
    const r = await fetch("/api/signup/status", {
      headers: { "X-Lab-Run": run, "X-Lab-Node": node },
    });
    const d = await r.json();
    if (r.ok) {
      setStatus(d);
      if (d.email) setEmail(d.email);
      return d;
    }
    if ([403, 404, 410].includes(r.status)) {
      setStatus(null);
      return null;
    }
    throw Error("가입 결과 확인 불가");
  }
  async function fresh() {
    const { response, data } = await api("signup/flows", "POST", {});
    if (response.ok) {
      completionKey.current = crypto.randomUUID();
      lastComplete.current = null;
      lastEmail.current = null;
      setPendingToken("");
      setTerms(false);
      setStatus(data);
      setUncertain(false);
      setNotice("이메일을 입력하고 실제 인증 메일을 요청하세요.");
    } else setNotice(data.message);
  }
  async function task(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "처리 결과 확인 불가");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const linkOpened = () => {
      if (!location.hash.startsWith("#verify=")) return;
      setPendingToken(location.hash.slice(8));
      const clean = new URL(location.href);
      clean.hash = "";
      history.replaceState(null, "", clean);
      setNotice(
        "메일 링크를 열었습니다. 확인 버튼을 눌러야 소유 확인이 완료됩니다.",
      );
      setTab("service");
    };
    window.addEventListener("hashchange", linkOpened);
    return () => window.removeEventListener("hashchange", linkOpened);
  }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await lab("runs", { run, policy: "normal" });
        await prepare();
        const found = await refreshStatus();
        if (!live) return;
        if (!found && !initialToken) await fresh();
        else
          setNotice(
            initialToken
              ? "메일 링크를 열었습니다. 확인 버튼을 눌러야 소유 확인이 완료됩니다."
              : "기존 가입 흐름을 복구했습니다.",
          );
        setSources(await (await fetch("/flow-source.json")).json());
        await observe();
        await refreshAuth();
        const oidcError = initialUrl.searchParams.get("oidcError");
        const oidcIntent = initialUrl.searchParams.get("oidc");
        if (oidcError)
          setNotice(
            "외부 인증 확인 실패 · " +
              oidcError +
              " · 기존 계정과 연결은 변경하지 않았습니다.",
          );
        else if (oidcIntent)
          setNotice(
            oidcIntent === "LINK"
              ? "외부 신원을 확인했습니다. 연결 확정 버튼으로 현재 계정에 연결하세요."
              : "외부 인증을 확인했습니다. 가입·로그인 상태를 확인해 주세요.",
          );
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "준비 실패");
      }
    })();
    const timer = setInterval(() => {
      setNow(Date.now());
      observe();
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!playing || !selected) return;
    const t = setTimeout(() => {
      if (step < selected.steps.length - 1) setStep(step + 1);
      else setPlaying(false);
    }, 750);
    return () => clearTimeout(t);
  }, [playing, selected, step]);
  async function requestMail(resend = false) {
    const body = { email, idempotencyKey: crypto.randomUUID() };
    lastEmail.current = body;
    const { response, data } = await api(
      "signup/email/" + (resend ? "resend" : "request"),
      "POST",
      body,
    );
    setNotice(response.status + " · " + (data.message || data.code));
    await refreshStatus();
  }
  async function verify() {
    const { response, data } = await api("signup/email/verify", "POST", {
      token: pendingToken,
    });
    setNotice(response.status + " · " + (data.message || data.code));
    if (response.ok) setPendingToken("");
    await refreshStatus();
  }
  async function complete(replay = false) {
    const body =
      replay && lastComplete.current
        ? lastComplete.current
        : {
            name,
            password: status?.intent === "OIDC" ? null : password,
            confirmation: status?.intent === "OIDC" ? null : confirm,
            terms,
            marketing,
            termsVersion: status?.termsVersion || 1,
            idempotencyKey: completionKey.current,
          };
    lastComplete.current = body;
    const { response, data } = await api(
      status?.intent === "OIDC" ? "signup/oidc/complete" : "signup/complete",
      "POST",
      body,
    );
    setNotice(response.status + " · " + (data.message || data.code));
    await refreshStatus();
  }
  async function refreshAuth() {
    const r = await fetch("/api/auth/me", {
      headers: { "X-Lab-Run": run, "X-Lab-Node": node },
    });
    if (r.ok) setAuth(await r.json());
    else setAuth(null);
  }
  async function login() {
    const { response, data } = await api("auth/login", "POST", {
      email: authEmail,
      password: authPassword,
    });
    setNotice(response.status + " · " + (data.message || data.code));
    if (response.ok) {
      await prepare();
      await refreshAuth();
    }
  }
  async function oidc(intent: string) {
    const { response, data } = await api("signup/oidc/start", "POST", {
      provider,
      intent,
    });
    if (response.ok && data.url) location.assign(data.url);
    else setNotice(response.status + " · " + (data.message || data.code));
  }
  const ownMail = mail.filter(
      (m) => !status?.flowId || m.flowId === status.flowId,
    ),
    completed = status?.state === "COMPLETED",
    verified = status?.emailVerified;
  const remain = (value?: string) =>
    value
      ? Math.max(0, Math.ceil((new Date(value).getTime() - now) / 1000)) + "초"
      : "—";
  return (
    <main>
      <header className="top">
        <a
          href="https://seonyoungyoo16.github.io/portfolio/"
          target="_blank"
          rel="noreferrer"
        >
          ← 포트폴리오
        </a>
        <span>ACTUAL BACKEND · SIGNUP LAB</span>
        <small>run {run}</small>
      </header>
      <section className="intro">
        <div>
          <span className="eyebrow">
            SPRING BOOT · REDIS · POSTGRESQL · SMTP · OIDC
          </span>
          <h1>
            이메일을 확인하고,
            <br />
            <em>한 계정으로 연결합니다.</em>
          </h1>
          <p>실제 요청·메일·외부 인증과 DB 커밋을 단계별로 확인하세요.</p>
        </div>
        <aside>
          <strong>실제 백엔드 실험실</strong>
          <p>
            앱 A·B와 실제 Redis·PostgreSQL,
            <br />
            SMTP 수신함·Keycloak을 사용합니다.
          </p>
          <label>
            처리 서버{" "}
            <select
              aria-label="처리 서버"
              value={node}
              onChange={(e) => setNode(e.target.value)}
            >
              <option>A</option>
              <option>B</option>
            </select>
          </label>
        </aside>
      </section>
      <nav className="tabs" aria-label="실험실 패널">
        {[
          ["service", "서비스"],
          ["mail", "메일함"],
          ["flow", "흐름·소스"],
          ["data", "데이터"],
          ["test", "검증"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <div
          className={
            "service-column pane " + (tab === "service" ? "mobile-active" : "")
          }
        >
          <section className="panel service" aria-label="회원가입 서비스">
            <div className="panel-head">
              <h2>이메일로 가입하기</h2>
              <button
                className="text-button"
                onClick={() => task(fresh)}
                disabled={busy}
              >
                새 가입 흐름
              </button>
            </div>
            <div className="flow-state">
              <span>
                {completed
                  ? "● 가입 완료"
                  : verified
                    ? "● 이메일 확인됨"
                    : "○ 이메일 확인 필요"}
              </span>
              <small>
                흐름 잔여 {remain(status?.flowExpiresAt)} · 세대{" "}
                {status?.generation ?? 0}
              </small>
            </div>
            {pendingToken && (
              <div className="verify-box">
                <strong>메일의 확인 링크를 열었습니다.</strong>
                <p>
                  같은 브라우저에서 확인 버튼을 눌러 소유 확인을 완료하세요.
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => task(verify)}
                >
                  이메일 확인 완료하기
                </button>
                <small>
                  다른 프로필이라면 가입을 시작한 브라우저에서 다시 열어 주세요.
                </small>
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                task(() => requestMail(false));
              }}
            >
              <label>
                이메일
                <input
                  aria-label="가입 이메일"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                  disabled={busy || completed}
                />
              </label>
              <div className="actions">
                <button type="submit" disabled={busy || completed}>
                  인증 메일 요청
                </button>
                <button
                  type="button"
                  disabled={busy || completed}
                  onClick={() => task(() => requestMail(true))}
                >
                  메일 재발송
                </button>
                <button
                  type="button"
                  disabled={busy || completed}
                  onClick={() =>
                    task(async () => {
                      const r = await api("signup/email/change", "POST", {
                        email,
                      });
                      setNotice(r.response.status + " · " + r.data.code);
                      completionKey.current = crypto.randomUUID();
                      await refreshStatus();
                    })
                  }
                >
                  이메일 수정 반영
                </button>
              </div>
            </form>
            {status?.existingAccount && (
              <div className="existing-account">
                이미 가입한 주소입니다. 기존 방식으로 로그인한 뒤 외부 인증을
                연결하세요. 이메일 확인만으로 기존 비밀번호를 바꾸지 않습니다.
              </div>
            )}
            {completed ? (
              <div className="success">
                <h3>가입이 완료되었습니다.</h3>
                <p>
                  계정 {String(status.accountId).slice(0, 8)} · 로그인은 별도로
                  진행합니다.
                </p>
              </div>
            ) : verified && !status?.existingAccount ? (
              <form
                className="details-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  task(() => complete());
                }}
              >
                <label>
                  표시 이름
                  <input
                    aria-label="표시 이름"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                  />
                </label>
                {status?.intent !== "OIDC" && (
                  <>
                    <label>
                      비밀번호
                      <input
                        aria-label="가입 비밀번호"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                    <label>
                      비밀번호 확인
                      <input
                        aria-label="비밀번호 확인"
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={terms}
                    onChange={(e) => setTerms(e.target.checked)}
                  />
                  필수 약관 동의 · v{status?.termsVersion || 1}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={marketing}
                    onChange={(e) => setMarketing(e.target.checked)}
                  />
                  마케팅 수신 동의 · 선택
                </label>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    !verified ||
                    !terms ||
                    status?.existingAccount ||
                    (status?.intent === "OIDC" && !status?.providerVerified)
                  }
                >
                  가입 확정하고 흐름 보기
                </button>
                <p className="subtle">
                  이메일 확인 뒤 가입합니다. 가입 응답만으로 로그인 쿠키를
                  만들지 않습니다.
                </p>
              </form>
            ) : (
              <p className="subtle">
                이메일 소유 확인을 마치면 가입 정보 입력이 열립니다.
              </p>
            )}
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  task(async () => {
                    const d = await refreshStatus();
                    setNotice(
                      d
                        ? "가입 결과를 다시 확인했습니다."
                        : "가입 흐름을 찾을 수 없습니다.",
                    );
                  })
                }
              >
                가입 결과 확인
              </button>
              <button
                disabled={busy || !lastComplete.current}
                onClick={() => task(() => complete(true))}
              >
                같은 가입 요청 재전송
              </button>
            </div>
            <p
              className={"notice " + (uncertain ? "uncertain" : "")}
              role="status"
            >
              {notice}
            </p>
          </section>
          <section className="panel identity">
            <h2>외부 인증과 기존 계정 연결</h2>
            <p className="subtle">
              같은 이메일이어도 자동 연결하지 않습니다. 기존 계정과 외부 신원을
              각각 확인합니다.
            </p>
            <label>
              공급자
              <select
                aria-label="외부 인증 공급자"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="main">Keycloak · signup-lab</option>
                <option value="team">Keycloak · signup-team</option>
              </select>
            </label>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() => task(() => oidc("SIGNUP"))}
              >
                SSO로 가입 계속
              </button>
              <button disabled={busy} onClick={() => task(() => oidc("LOGIN"))}>
                기존 SSO로 로그인
              </button>
            </div>
            <p className="subtle">IdP 실습 계정: alice / Signup!2026LongPass</p>
            <div className="auth-state">
              {auth ? "로그인됨 · " + auth.email : "기존 계정 로그인 필요"}
            </div>
            <label>
              기존 계정 이메일
              <input
                aria-label="기존 계정 이메일"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
              />
            </label>
            <label>
              기존 계정 비밀번호
              <input
                aria-label="기존 계정 비밀번호"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button disabled={busy} onClick={() => task(login)}>
              기존 계정 로그인
            </button>
            <p className="subtle">
              기본 계정: existing@lab.test / Signup!2026LongPass · 기존 계정
              비밀번호 입력을 사용합니다.
            </p>
            <div className="actions">
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    const r = await api("auth/reauthenticate", "POST", {
                      password: authPassword,
                    });
                    setNotice(r.response.status + " · " + r.data.code);
                    await refreshAuth();
                  })
                }
              >
                기존 비밀번호 재확인
              </button>
              <button
                disabled={busy || !auth}
                onClick={() => task(() => oidc("REAUTH"))}
              >
                기존 SSO 재확인
              </button>
              <button
                disabled={busy || !auth}
                onClick={() => task(() => oidc("LINK"))}
              >
                외부 신원 연결 시작
              </button>
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    const r = await api(
                      "account/identities/link/complete",
                      "POST",
                      {},
                    );
                    setNotice(
                      r.response.status +
                        " · " +
                        (r.data.message || r.data.code),
                    );
                    await refreshAuth();
                  })
                }
              >
                확인한 외부 신원 연결 확정
              </button>
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    await api("auth/logout", "POST", {});
                    await prepare();
                    setAuth(null);
                    setNotice("로그아웃 완료");
                  })
                }
              >
                기존 계정 로그아웃
              </button>
            </div>
            {auth?.identities?.map((i: any) => (
              <p key={i.id} className="identity-row">
                연결됨 · {i.provider} · {i.subjectHint}
              </p>
            ))}
          </section>
        </div>
        <section
          className={
            "panel mail pane " + (tab === "mail" ? "mobile-active" : "")
          }
          aria-label="실제 수신 메일함"
        >
          <div className="panel-head">
            <h2>실제 SMTP 수신함</h2>
            <button
              onClick={() =>
                task(async () => {
                  setMail(await lab("mailbox?run=" + run));
                })
              }
            >
              메일함 새로고침
            </button>
          </div>
          <p className="subtle">
            현재 가입 흐름에 실제로 도착한 메일입니다. 링크를 여는 것만으로
            확인되지 않습니다.
          </p>
          {ownMail.length ? (
            ownMail.map((m) => (
              <article className="mail-item" key={m.id}>
                <strong>{m.subject}</strong>
                <small>
                  {m.recipient} · 실제 수신 {m.receivedAt}
                </small>
                {m.url && <a href={m.url}>메일 확인 링크 열기 →</a>}
              </article>
            ))
          ) : (
            <p className="empty">
              수신한 메일이 없습니다. 접수 후 작업자가 전송할 때까지 기다리세요.
            </p>
          )}
        </section>
        <section
          className={
            "panel flow pane " + (tab === "flow" ? "mobile-active" : "")
          }
          aria-label="실제 처리 흐름"
        >
          <div className="panel-head">
            <h2>실행 기록과 실제 소스</h2>
            <span>
              {selected ? step + 1 + "/" + selected.steps.length : "READY"}
            </span>
          </div>
          <select
            aria-label="실행 기록 선택"
            value={selected?.id || ""}
            onChange={(e) => {
              setSelected(traces.find((t) => t.id === e.target.value) || null);
              setStep(0);
              setPlaying(false);
            }}
          >
            <option value="">실제 실행 기록 선택</option>
            {traces.map((t) => (
              <option key={t.id} value={t.id}>
                {t.method} {t.path} · {t.instance} · {t.status}
              </option>
            ))}
          </select>
          <p className="subtle">
            완료된 실제 실행 재생입니다. API 응답·DB 확정·메일 접수·브라우저
            수신은 별도로 표시합니다.
          </p>
          <div className="actions">
            <button
              disabled={!selected}
              onClick={() => {
                if (step === (selected?.steps.length || 0) - 1) setStep(0);
                setPlaying(!playing);
              }}
            >
              {playing ? "흐름 일시 정지" : "흐름 재생"}
            </button>
            <button
              disabled={!selected}
              onClick={() => {
                setPlaying(false);
                setStep(Math.min(step + 1, (selected?.steps.length || 1) - 1));
              }}
            >
              다음 단계
            </button>
            <button
              disabled={!selected}
              onClick={() => {
                setPlaying(false);
                setStep((selected?.steps.length || 1) - 1);
              }}
            >
              마지막 단계
            </button>
          </div>
          <div className="current-step">
            <strong>
              {current?.message ||
                "요청을 실행하면 실제 처리 기록이 나타납니다."}
            </strong>
            <small>
              {current?.node} {current?.action}
            </small>
          </div>
          <svg
            className="scene"
            viewBox="0 0 600 280"
            role="img"
            aria-label="브라우저·서버·Redis·DB·SMTP·IdP 처리 흐름"
          >
            <path d="M80 140H280L510 40M280 140L510 130M280 140L510 235M80 140L80 245H280" />
            {[
              ["Browser", 80, 140, "BROWSER"],
              ["Server", 280, 140, "SERVER " + (selected?.instance || node)],
              ["Redis", 510, 40, "REDIS"],
              ["DB", 510, 130, "POSTGRESQL"],
              ["SMTP", 510, 235, "SMTP"],
              ["IdP", 80, 245, "OIDC IdP"],
            ].map(([id, x, y, label]) => (
              <g
                key={id}
                transform={`translate(${x},${y})`}
                className={current?.node === id ? "active" : ""}
              >
                <rect x="-66" y="-24" width="132" height="48" rx="8" />
                <text textAnchor="middle" y="5">
                  {label}
                </text>
              </g>
            ))}
          </svg>
          <ol className="steps">
            {selected?.steps.map((s, i) => (
              <li key={i}>
                <button
                  aria-current={step === i ? "step" : undefined}
                  onClick={() => {
                    setStep(i);
                    setPlaying(false);
                  }}
                >
                  <span>{i + 1}</span>
                  {s.message}
                  <small>{s.node}</small>
                </button>
              </li>
            ))}
          </ol>
          <button
            className="source-toggle"
            onClick={() => setSourceOpen(!sourceOpen)}
            aria-expanded={sourceOpen}
          >
            현재 단계 실제 소스 {sourceOpen ? "닫기" : "열기"}
          </button>
          {sourceOpen &&
            (source ? (
              <div className="source">
                <p>
                  {source.file}:{source.line}
                </p>
                <pre>
                  {source.snippet.split("\n").map((line: string, i: number) => (
                    <div key={i}>
                      <span>{source.line + i}</span>
                      <code>{line || " "}</code>
                    </div>
                  ))}
                </pre>
              </div>
            ) : (
              <p className="subtle">현재 실행 단계의 소스를 선택하세요.</p>
            ))}
        </section>
        <section
          className={
            "panel data pane " + (tab === "data" ? "mobile-active" : "")
          }
          aria-label="실제 데이터 관찰"
        >
          <div className="panel-head">
            <h2>DB·Redis 관찰</h2>
            <small>
              {snapshot?.unavailable
                ? "확인 불가"
                : snapshot?.observedAt || "관찰 대기"}
            </small>
          </div>
          <p className="subtle">
            관찰은 가입 증명·세션 수명을 연장하지 않습니다. 실습용 기존 계정
            1개를 별도로 포함합니다.
          </p>
          <dl className="counts">
            {Object.entries(snapshot?.counts || {}).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
          {[
            ["flows", "가입 흐름"],
            ["challenges", "확인 증명"],
            ["mail", "발송 작업"],
            ["oidc", "외부 인증 거래"],
            ["limits", "Redis 제한 TTL"],
          ].map(([key, label]) => (
            <details key={key} open>
              <summary>{label}</summary>
              <pre>{JSON.stringify(snapshot?.[key] || [], null, 2)}</pre>
            </details>
          ))}
        </section>
        <section
          className={
            "panel tests pane " + (tab === "test" ? "mobile-active" : "")
          }
          aria-label="실습과 실제 검증"
        >
          <h2>장애와 브라우저 검증</h2>
          <p className="subtle">
            격리된 로컬 실험 제어입니다. 연결 차단·서버 처리 지점 중단·응답
            유실을 구분합니다.
          </p>
          <label>
            단축 정책
            <select
              aria-label="단축 정책"
              defaultValue="normal"
              onChange={(e) => {
                const u = new URL(location.href);
                u.searchParams.set(
                  "run",
                  "short-" + crypto.randomUUID().slice(0, 8),
                );
                task(async () => {
                  await lab("runs", {
                    run: u.searchParams.get("run"),
                    policy: e.target.value,
                  });
                  location.assign(u);
                });
              }}
            >
              <option value="normal">기본 30분 / 10분</option>
              <option value="short">짧게 60초 / 20초</option>
              <option value="expiry">검증 15초 / 3초</option>
            </select>
          </label>
          <label>
            중단할 처리 지점
            <select
              aria-label="중단 지점"
              value={fault}
              onChange={(e) => setFault(e.target.value)}
            >
              {[
                "none",
                "before-email-commit",
                "after-email-commit",
                "hold-mail",
                "hold-after-mail-claim",
                "before-account-commit",
                "after-account-commit",
                "after-token-exchange",
                "fail-jwks",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              task(async () => {
                await lab("fault", { run, point: fault });
                setNotice("지정 처리 지점 적용: " + fault);
              })
            }
          >
            처리 지점 적용
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={dropNext}
              onChange={(e) => {
                drop.current = e.target.checked;
                setDropNext(e.target.checked);
              }}
            />
            다음 변경 응답 연결 유실
          </label>
          <div className="actions">
            {["redis", "db", "smtp", "idp"].map((target) => (
              <button
                key={target}
                onClick={() =>
                  task(async () => {
                    const blocked = !network[target];
                    await lab("network", { target, blocked });
                    setNetwork((n) => ({ ...n, [target]: blocked }));
                    setNotice(
                      target + " 실제 TCP 경로 " + (blocked ? "차단" : "복구"),
                    );
                  })
                }
              >
                {target} {network[target] ? "연결 복구" : "연결 차단"}
              </button>
            ))}
          </div>
          <div className="actions">
            <button
              disabled={!!testResult?.running}
              onClick={() =>
                task(async () => {
                  await lab("test", {});
                  setTestResult({ running: true, result: null });
                  setNotice("실제 브라우저 검증을 시작했습니다.");
                  setTab("test");
                })
              }
            >
              브라우저 전체 검증 실행
            </button>
            <button
              onClick={() =>
                task(async () => setTestResult(await lab("test-result")))
              }
            >
              검증 결과 새로고침
            </button>
          </div>
          <p data-testid="runner-state">
            {testResult?.running
              ? "브라우저 검증 실행 중"
              : testResult?.result?.status === "passed"
                ? "브라우저 검증 통과"
                : testResult?.result?.status === "failed"
                  ? "브라우저 검증 실패"
                  : "브라우저 검증 미실행"}
          </p>
          <pre className="test-result">
            {(testResult && JSON.stringify(testResult, null, 2)) ||
              "아직 검증 결과를 조회하지 않았습니다."}
          </pre>
        </section>
      </div>
      <footer>
        실제 백엔드 검증 · source anchors · 이메일 소유 확인과 로그인 권한을
        구분합니다.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
