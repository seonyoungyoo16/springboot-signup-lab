# 요구사항과 실제 실행 근거

기본 50개 전부 실제 백엔드 연결 브라우저 실행을 통과했다. 실제 SQL 저장 내용의 별도 검증은 12개다. T01~T04(여러 RP SSO)는 원본 설계의 후속 범위다.

| ID | 브라우저 시나리오 | 구현된 검사 | 결과 |
|---|---|---|---|
| E01 | 실제 SMTP 수신과 명시적 이메일 확인 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E02 | 메일 링크 GET은 확인 증명을 소비하지 않음 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E03 | 다른 브라우저의 확인 요청은 원래 링크를 소비하지 않음 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E04 | 같은 프로필 두 탭의 동시 확인은 한 번만 확정 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E05 | 재발송한 현재 세대만 유효 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E06 | A·B 동시 재발송과 간격·횟수 제한 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E07 | 실제 경과 시간 이후 링크 만료 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E08 | 주소 변경은 이미 확인한 증명을 무효화 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E09 | 새로고침과 A→B 이동은 기존 흐름과 메일을 유지 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| E10 | 기존 주소도 같은 접수 응답, 소유 확인 뒤 기존 계정 안내 | [test/browser/email.spec.ts](../../test/browser/email.spec.ts) | passed |
| D01 | 계정·자격정보·동의 원자 커밋과 별도 실제 로그인 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| D02 | 같은 키의 동시 제출은 계정·동의 한 번 확정 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| D03 | 실제 응답 연결 유실 뒤 같은 가입 결과 복구 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| D04 | 같은 키에 다른 입력은 409이며 최초 데이터 유지 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| D05 | 두 독립 브라우저의 같은 이메일 동시 가입 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| D06 | 이메일 비교 정책은 대소문자 중복만 합치고 별칭을 추정하지 않음 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| D07 | 일반 가입과 실제 OIDC 가입의 이메일 동시 충돌 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| D08 | 확인 증명 만료와 필수 동의 변경은 계정 생성 전 거부 | [test/browser/accounts.spec.ts](../../test/browser/accounts.spec.ts) | passed |
| O01 | 실제 Keycloak 코드·PKCE·서명 검증 후 SSO 가입 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O02 | 같은 외부 신원의 재가입은 추가 계정 없이 기존 SSO 로그인 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O03 | 외부 이메일이 같아도 기존 계정에 자동 연결하지 않음 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O04 | 기존 계정과 외부 신원을 확인한 명시적 연결 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O05 | 다른 계정에 연결된 신원은 옮겨 붙일 수 없음 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O06 | issuer가 다르면 같은 subject인 다른 신원으로 판정 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O07 | 실제 IdP 이메일 변경도 기존 계정과 기본 이메일을 바꾸지 않음 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O08 | email 없음·미검증·미신뢰와 허용한 issuer 정책 분리 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O09 | 실제 토큰의 검증 경계에서 state·nonce·iss·aud·서명·exp 거부 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O10 | 중복 callback은 재교환하지 않고 다른 프로필에서는 거부 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O11 | 연결 중 다른 탭의 로그아웃·사용자 교체·버전 폐기 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| O12 | 취소·실제 거래 만료·최근 인증 만료를 구분 | [test/browser/oidc.spec.ts](../../test/browser/oidc.spec.ts) | passed |
| F01 | 메일 커밋 직전 실패는 challenge·outbox·결과를 함께 롤백 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F02 | 실제 lease 소유 앱 종료 후 다른 작업자가 durable outbox 회수 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F03 | 실제 SMTP 차단·재시도 상한·만료 작업 중단과 복구 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F04 | SMTP 250 응답 실제 유실과 작업자 종료 뒤 중복 메일·단일 가입 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F05 | 실제 SMTP에 옛 캡처 메일을 늦게 재주입해도 최신 세대만 확인 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F06 | Redis 실제 TCP 차단 시 확인·가입은 503, 복구해도 만료 연장 없음 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F07 | DB 실제 차단과 커밋 후 HTTP 연결 유실을 구분해 결과 복구 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F08 | 실제 Redis 재시작·옛 문맥 복원으로 DB의 소비·완료 상태 우회 불가 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F09 | A 실제 종료 뒤 B에서 기존 흐름 확인·가입 계속 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| F10 | 실제 IdP TCP 차단·JWKS 경계 실패·코드 소비 뒤 중단은 재시작 요구 | [test/browser/faults.spec.ts](../../test/browser/faults.spec.ts) | passed |
| S01 | 변경 API의 CSRF 누락·다른 출처 요청은 쓰기 전에 거부 | [test/browser/security.spec.ts](../../test/browser/security.spec.ts) | passed |
| S02 | 다른 브라우저·실행에 ID와 멱등 키를 대입해도 소유 결과 접근 불가 | [test/browser/security.spec.ts](../../test/browser/security.spec.ts) | passed |
| S03 | 실제 흐름·스냅샷·보고서·정리된 URL에 인증 원문이 남지 않음 | [test/browser/security.spec.ts](../../test/browser/security.spec.ts) | passed |
| S04 | A·B의 실제 Redis 이메일 제한은 원자적이며 위조 IP로 우회 불가 | [test/browser/security.spec.ts](../../test/browser/security.spec.ts) | passed |
| S05 | Host·외부 Origin·공급자·리다이렉트 조작과 메일 HTML 입력 거부 | [test/browser/security.spec.ts](../../test/browser/security.spec.ts) | passed |
| S06 | IDN 이메일·공백과 한글 비밀번호를 보존하고 길이·동의 정책 적용 | [test/browser/security.spec.ts](../../test/browser/security.spec.ts) | passed |
| U01 | 관찰 화면을 열어두어도 실제 흐름·확인 증명 만료 연장 없음 | [test/browser/observability.spec.ts](../../test/browser/observability.spec.ts) | passed |
| U02 | 네 가지 뷰포트에서 패널 이동·입력·오류·포커스와 가로 넘침 확인 | [test/browser/observability.spec.ts](../../test/browser/observability.spec.ts) | passed |
| U03 | 실제 이벤트의 모든 소스 발췌·행·해시와 DB 상태 확인 | [test/browser/observability.spec.ts](../../test/browser/observability.spec.ts) | passed |
| U04 | 실제 실행기 상태 표시·중복 실행 방지와 처리 경계 제어 | [test/browser/observability.spec.ts](../../test/browser/observability.spec.ts) | passed |

출처: [브라우저 결과](browser-summary.json), [실제 SQL 검증](backend-summary.json), [실행기 진단](test-runner.json).

방법: F01과 JWKS 등 지정 경계 중단은 코드 체크포인트, F02/F09는 실제 앱 종료, F03/F06/F07/F10은 실제 TCP 차단이다. F04는 SMTP 250 실제 응답을 제거한다. F05는 캡처한 옛 메일을 SMTP로 재주입해 지연 도착을 통제한다. O09는 실제 토큰의 서명 변형 또는 검증기의 기대 issuer/audience/nonce/시간을 통제한다. 실제 IdP가 잘못된 클레임을 발급했다는 주장이 아니다.

개별 성공 단계를 기록한 파일보다 browser-summary.json의 전체 실행이 최종 기준이다.
