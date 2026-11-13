// ============================================================
// dshs42 관리 · dshs43 관리 — 관리자 전용 사이트 (같은 코드, 기수는 묶을 때 cohort.js 로 정함)
// 학생 사이트(dshs-study.js)에 있던 관리 탭(승인 · 피드백 · 학생 · 계획 · 점검 · 분석)과
// 학교 일정 관리(추가 · 수정 · 숨기기, NEIS 일정 고치기)를 옮겨 온 곳입니다.
// 학생 사이트와 같은 Supabase DB 를 쓰고, 권한은 DB(RLS · is_admin)가 막습니다.
// 묶기 · 배포: scripts/build-admin.mjs → admin-dist/ (README 의 "관리자 사이트")
// ============================================================
const CFG = window.DSHS_CONFIG || {};
const EMAIL_DOMAIN = "dshs.study";   // 계정이 아이디@dshs.study 로 저장돼 있어 바꾸지 않습니다

// ---------- 기수 (42기 · 43기) ----------
// 같은 코드로 42기 · 43기 관리자 사이트를 따로 묶습니다. scripts/build-admin.mjs 가 cohort.js 에 window.DSHS_COHORT 를
// 써 넣고(기수별 값은 scripts/admin-cohorts.mjs), 여기서 읽습니다. 두 기수가 같은 DB 를 쓰므로 학생 · 학생이 만든 내용은
// 이 기수 것만 보여 줍니다 (학번 범위 · 과목 이름으로 거름). 학번이 없는 계정(관리자 · 예전 계정)은 어느 기수에서나 보입니다.
// cohort.js 가 없으면 42기로 동작합니다.
const COHORT = {
  id: 42, label: "42기", title: "dshs42 관리", min: 2000, max: 2999,
  strict: false,          // false: 다른 기수 학번 · 과목만 빼고 모두 보임 (42기 · 예전부터 있던 것을 그대로 보이게)
  otherRanges: [],        // 다른 기수의 학번 범위 [[1000, 1999]]
  subjects: null,         // 이 기수 과목 (null 이면 SCHOOL_DATA 에서)
  otherSubjects: [],      // 다른 기수 과목 (strict 가 아니면 이 과목만 뺌)
  noAsgSubjects: ["미술", "체육"],
  grade: null,            // 학사일정 학년 (null 이면 명단에서)
  ...(window.DSHS_COHORT || {}),
};
// 기기에 남기는 이름: 42기는 예전 이름 그대로 (이미 등록한 관리자 기기가 계속 로그인돼 있게)
const KEYS = {
  auth: "dshs42-admin-auth", school: "dshs42-admin-school", push: "dshs42-admin-push",
  fbSeen: "dshs-fb-seen", ovSeen: "dshs-overview-seen",
  ...(COHORT.keys || {}),
};
const STUDENT_URL = COHORT.studentUrl || CFG.STUDENT_URL || "https://dshs42.app";
// 이 기수 학생인지 (학번). 학번이 없으면 어느 기수에서나 보입니다
function sidInCohort(sid) {
  if (sid === null || sid === undefined || sid === "") return true;
  const n = +sid;
  if (COHORT.strict) return n >= COHORT.min && n <= COHORT.max;
  return !(COHORT.otherRanges || []).some(([lo, hi]) => n >= lo && n <= hi);
}
// 이 기수 과목인지 (수행평가 · 합치기 제안). 42기 · 43기는 과목 이름이 겹치지 않습니다 (cohort43.sql)
const OWN_SUBJECTS = COHORT.subjects ? new Set(COHORT.subjects) : null;
const OTHER_SUBJECTS = new Set(COHORT.otherSubjects || []);
const asgInCohort = (a) => (OWN_SUBJECTS ? OWN_SUBJECTS.has(a.subject) : !OTHER_SUBJECTS.has(a.subject));
// 계정 id → 학번 (피드백 · 답글을 보낸 학생의 기수를 알아내려고. 한 번 받은 것은 기억)
const sidOfUser = new Map();
async function userInCohort(ids) {
  const need = [...new Set(ids)].filter((id) => id && !sidOfUser.has(id));
  if (need.length) {
    const { data } = await sb.from("profiles").select("id, student_id").in("id", need);
    (data || []).forEach((p) => sidOfUser.set(p.id, p.student_id));
  }
  return (id) => sidInCohort(sidOfUser.get(id));   // 프로필을 못 찾으면 보이게 둡니다
}
// 방문 · 로그인 이탈은 서버에 기수를 넘겨 이 기수 사이트 것만 받습니다 (visits.sql · loginsteps.sql 의 p_cohort).
// DB 에 아직 기수 칸을 넣지 않았으면(함수 없음) 예전처럼 두 기수 합계를 받습니다.
let cohortSplit = true;
async function cohortRpc(fn, args) {
  const r = await sb.rpc(fn, { ...args, p_cohort: COHORT.id });
  if (r.error?.code === "PGRST202") { cohortSplit = false; return sb.rpc(fn, args); }
  cohortSplit = true;
  return r;
}
// admin_overview 결과에서 이 기수 학생만 (명단 수는 빠진 다른 기수 학생 수만큼 뺍니다)
function cohortOverview(d) {
  if (!d?.students) return d;
  const students = d.students.filter((s) => sidInCohort(s.student_id));
  const notJoined = (d.not_joined || []).filter((s) => sidInCohort(s.student_id));
  const gone = (d.students.length - students.length) + ((d.not_joined || []).length - notJoined.length);
  return { ...d, roster: Math.max(0, (d.roster || 0) - gone), students, not_joined: notJoined,
    activity: (d.activity || []).filter((a) => sidInCohort(a.student_id)) };
}

let sb = null;
let me = null;          // { id, username, name, is_admin }
let page = "admin";     // admin(관리) | school(학교 일정)
let cache = { pending: [], school: [] };

// ---------- 유틸 ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isNetErr = (e) => /fetch|network|load failed|timeout/i.test(e?.message || "") || e?.status === 0;

function toast(msg, bad) {
  const el = $("studyToast");
  el.textContent = msg;
  el.className = "study-toast show" + (bad ? " bad" : "");
  undoFn = null;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = "study-toast"; }, 3200);
}

// 실행 취소가 붙은 알림 (학교 일정 삭제)
let undoFn = null;
const UNDO_MS = 7000;
function undoToast(msg, fn) {
  const el = $("studyToast");
  clearTimeout(toast._t);
  el.innerHTML = `<span>${esc(msg)}</span><button class="toast-undo" type="button">실행 취소</button>
    <svg class="toast-timer" aria-hidden="true"><rect pathLength="100" /></svg>`;
  el.className = "study-toast show has-undo";
  undoFn = fn;
  el.querySelector(".toast-undo").onclick = runUndo;
  const svg = el.querySelector(".toast-timer"), rect = svg.querySelector("rect");
  const fit = () => {
    const w = el.offsetWidth, h = el.offsetHeight;
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 13;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    Object.entries({ x: 0.5, y: 0.5, width: w - 1, height: h - 1, rx: r - 0.5 }).forEach(([k, v]) => rect.setAttribute(k, v));
  };
  fit();
  undoToast._ro?.disconnect();
  undoToast._ro = new ResizeObserver(fit);
  undoToast._ro.observe(el, { box: "border-box" });
  rect.style.animationDuration = `${UNDO_MS}ms`;
  rect.onanimationend = () => { if (undoFn === fn) { el.className = "study-toast"; undoFn = null; } };
}
async function runUndo() {
  const fn = undoFn;
  if (!fn) return;
  undoFn = null;
  clearTimeout(toast._t);
  $("studyToast").className = "study-toast";
  try { (await fn()) === false ? toast("되돌리지 못했어요", true) : toast("되돌렸어요"); }
  catch { toast("되돌리지 못했어요", true); }
}
document.addEventListener("keydown", (e) => {
  if (!undoFn || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
  if (e.target.closest?.("input, textarea, select")) return;
  e.preventDefault();
  runUndo();
});

function dueInfo(iso) {
  const d = new Date(iso);
  const diff = d - new Date();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  let label, tone;
  if (diff < 0) { label = "마감됨"; tone = "over"; }
  else if (hours < 24) { label = hours <= 0 ? "곧 마감" : `${hours}시간 남음`; tone = "soon"; }
  else if (days < 3) { label = `D-${days}`; tone = "soon"; }
  else { label = `D-${days}`; tone = "ok"; }
  const when = d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  return { label, tone, when };
}
function pad(n) { return String(n).padStart(2, "0"); }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); }
function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function md(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
function dayTitle(key) {
  return parseDay(key).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}
const HOUR = 3600000;

function openSheet(title, inner) {
  const m = $("studyModal");
  m.className = "study-modal show";
  m.innerHTML = `<div class="study-sheet">
    <div class="study-sheet-head"><div class="sheet-title">${title}</div><button class="study-x">✕</button></div>
    ${inner}
  </div>`;
  m.querySelector(".study-x").onclick = closeModal;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { $("studyModal").className = "study-modal"; }
function showErr(msg) { const e = $("authErr"); e.textContent = msg; e.classList.add("show"); }

// ---------- 학생 명단 (학생 사이트의 시간표 데이터 · school-data.js) ----------
// 43기처럼 시간표 명단(SCHOOL_DATA)이 없는 기수는 DB 명단(admin_overview 의 가입 학생 + 아직 가입 안 한 학생)을 쓰고,
// 모든 학생이 이 기수 과목을 모두 '전체 분반'(ban 없음)으로 듣는다고 봅니다 (cohort43.sql 의 enrollments 와 같음).
const SCHOOL_DATA = window.SCHOOL_DATA || {};
const HAS_SCHOOL_DATA = Object.keys(SCHOOL_DATA).length > 0;
const cohortClasses = () => Object.fromEntries((COHORT.subjects || []).map((s) => [s, null]));
let dbRoster = null;
function roster() {
  if (!HAS_SCHOOL_DATA) return dbRoster || [];
  return Object.entries(SCHOOL_DATA)
    .map(([name, v]) => ({ sid: v.id, name, classes: v.classes || {} }))
    .sort((a, b) => a.sid - b.sid);
}
function setDbRoster(ov) {
  if (HAS_SCHOOL_DATA || !ov?.students) return;
  const seen = new Map();
  for (const s of [...ov.students, ...(ov.not_joined || [])]) {
    if (s.student_id && sidInCohort(s.student_id)) seen.set(s.student_id, { sid: s.student_id, name: s.name || String(s.student_id), classes: cohortClasses() });
  }
  dbRoster = [...seen.values()].sort((a, b) => a.sid - b.sid);
}
// 명단이 필요한 화면(학교 일정 · 대상 고르기) 전에 부릅니다. 관리 화면에서 받은 것이 있으면 그대로 씁니다
async function loadDbRoster() {
  if (HAS_SCHOOL_DATA || dbRoster) return;
  let ov = ovLast?.[0]?.data;
  if (!ov) {
    const res = await sb.rpc("admin_overview");
    if (res.error) return;
    ov = cohortOverview(res.data);
  }
  setDbRoster(ov);
}
const homeroom = (sid) => Math.floor(sid / 100) % 10;   // 2113 → 1반
// 학년 (기수 설정에 있으면 그것, 없으면 명단에서 가장 많은 학년. 42기는 2026년 2학년)
const GRADE = COHORT.grade || (() => {
  const n = {};
  for (const p of roster()) { const g = Math.floor(p.sid / 1000); n[g] = (n[g] || 0) + 1; }
  return +Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
})();
function sortClasses(list) {
  return list.sort((a, b) => a.subject.localeCompare(b.subject, "ko") || (a.ban || "").localeCompare(b.ban || "", "ko"));
}
function allClassList() {
  if (!HAS_SCHOOL_DATA) return sortClasses((COHORT.subjects || []).map((subject) => ({ subject, ban: null })));
  const seen = new Map();
  for (const n in SCHOOL_DATA) {
    for (const [subject, ban] of Object.entries(SCHOOL_DATA[n].classes)) seen.set(`${subject}|${ban}`, { subject, ban });
  }
  return sortClasses([...seen.values()]);
}
const banLabel = (ban) => ban || "전체 분반";
// 수행평가를 보지 않는 과목 (학생 사이트와 같게)
const NO_ASG_SUBJECTS = new Set(COHORT.noAsgSubjects || []);
const banSubjects = () => (HAS_SCHOOL_DATA
  ? [...new Set(roster().flatMap((p) => Object.keys(p.classes)))]
  : [...(COHORT.subjects || [])]).sort((a, b) => a.localeCompare(b, "ko"));

// ---------- 시작 · 로그인 ----------
async function init() {
  if (!CFG.SUPABASE_URL) { $("studyView").innerHTML = '<div class="adm-none">config.js 를 찾지 못했어요.</div>'; return; }
  let createClient;
  try {
    ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4?bundle"));
  } catch {
    $("studyView").innerHTML = '<div class="adm-none">서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.</div>';
    return;
  }
  // 학생 사이트와 주소가 달라 로그인은 따로 기억됩니다 (같은 키 이름이어도 섞이지 않음)
  sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: KEYS.auth },
  });
  const q = new URLSearchParams(location.search);
  if (q.get("view") === "school") page = "school";
  const { data: { session } } = await sb.auth.getSession();
  if (session) await loadProfile();
  sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") { me = null; start(); } });
  start();
}

async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; return; }
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) { toast(isNetErr(error) ? "서버에 연결하지 못했어요" : "계정 정보를 읽지 못했어요", true); me = null; return; }
  me = data;
}

function start() {
  const set = $("btnSettings");
  set.style.display = me?.is_admin ? "" : "none";
  set.onclick = openSettings;
  if (!me) return renderLogin();
  if (!me.is_admin) return renderNotAdmin();
  renderNav();
  autoPush();
  openPage(page);
  if (!refreshAdminCount.on) {
    refreshAdminCount.on = true;
    setInterval(() => { if (!document.hidden) refreshAdminCount(); }, 60000);
  }
}

// 기기 등록: 처음 한 번만 관리자 비밀번호를 넣으면 이 기기가 관리자 계정으로 로그인된 채로 남습니다
// (로그인 유지 · 토큰 자동 갱신). 다음부터는 이 화면 없이 바로 열립니다.
// 비밀번호 한 칸으로 관리자 계정들에 차례로 로그인해 봅니다. 비밀번호는 코드 · 저장소에 두지 않고 Supabase 계정에만 있습니다.
const ADMIN_IDS = ["milkcat322", "qksalornt"];   // admins.sql 의 관리자 계정
function renderLogin() {
  $("studyNav").innerHTML = "";
  $("studyView").innerHTML = `<div class="gate">
    <h2>이 기기 등록</h2>
    <div class="study-sub">처음 한 번만 관리자 비밀번호를 넣으면, 이 기기에서는 다음부터 바로 열려요.</div>
    <input class="study-input" id="loginId" autocomplete="username" value="${ADMIN_IDS[0]}" hidden>
    <label class="study-label">관리자 비밀번호</label>
    <input class="study-input" id="loginPw" type="password" autocomplete="current-password">
    <div class="study-err" id="authErr"></div>
    <button class="study-submit" id="doLogin">등록</button>
  </div>`;
  const go = async () => {
    const p = $("loginPw").value;
    if (!p) return showErr("비밀번호를 입력해 주세요.");
    $("doLogin").disabled = true;
    let error;
    for (const u of ADMIN_IDS) {
      ({ error } = await sb.auth.signInWithPassword({ email: `${u}@${EMAIL_DOMAIN}`, password: p }));
      if (!error || isNetErr(error)) break;
    }
    $("doLogin").disabled = false;
    if (error) return showErr(isNetErr(error) ? "서버에 연결하지 못했어요." : "비밀번호가 맞지 않아요.");
    await loadProfile();
    if (!me) { await sb.auth.signOut(); return showErr("계정 정보(프로필)를 찾지 못했어요."); }
    if (me.is_admin) toast("이 기기를 등록했어요");
    start();
  };
  $("doLogin").onclick = go;
  $("loginPw").onkeydown = (e) => { if (e.key === "Enter") go(); };
  $("loginPw").focus();
}

function renderNotAdmin() {
  $("studyNav").innerHTML = "";
  $("studyView").innerHTML = `<div class="gate">
    <h2>관리자 계정이 아니에요</h2>
    <div class="study-sub">${esc(me.name)} 계정은 학생 계정이에요. 관리자 사이트는 관리자 계정만 쓸 수 있어요.</div>
    <a class="study-submit" href="${esc(STUDENT_URL)}" style="display:block;text-align:center;text-decoration:none">학생 사이트로 가기</a>
    <button class="study-submit ghost" id="doLogout">로그아웃</button>
  </div>`;
  $("doLogout").onclick = logout;
}

async function logout() {
  closeModal();
  await forgetPush();   // 이 기기로 관리자 알림이 계속 오지 않게, 서버 등록만 지웁니다
  autoPush.done = false;
  await sb.auth.signOut();
  me = null;
  toast("이 기기 등록을 해제했어요");
  start();
}

// ---------- 탭: 맨 위 카드 한 줄 (처리 · 학생 · 제안 · 학교 일정) ----------
// 처리 · 학생 · 제안은 '관리' 화면의 칸(OV_GROUP), 학교 일정은 따로 된 화면입니다. 카드의 숫자는 navStat (paintOverview 가 채움).
const NAV = [["asg", "📥", "처리"], ["stu", "👥", "학생"], ["dev", "💡", "제안"], ["school", "📅", "학교 일정"]];
let adminCount = 0;
let navStat = {};
function renderNav() {
  const nav = $("studyNav");
  const cur = page === "school" ? "school" : OV_GROUP[ovPane || "asg"];
  nav.classList.add("adm-nav");
  nav.innerHTML = NAV.map(([k, icon, label]) => {
    const st = navStat[k] || {};
    return `<button class="${cur === k ? "on" : ""}${st.hot ? " hot" : ""}" data-nav="${k}">
      <span class="adm-nav-top"><i>${icon}</i>${label}</span><b>${st.v ?? "&nbsp;"}</b></button>`;
  }).join("");
  nav.querySelectorAll("[data-nav]").forEach((b) => b.onclick = () => {
    const k = b.dataset.nav;
    if (k === "school") return page === "school" ? null : openPage("school");
    ovPane = ovSubLast[k];
    if (page !== "admin") return openPage("admin");
    ovShow?.(ovPane);
  });
}
function openPage(p) {
  page = p;
  renderNav();
  $("studyView").innerHTML = `
    ${p === "school" ? `<div class="adm-bar"><span>모든 학생 달력에 보이는 학교 일정</span><button class="study-btn primary small" id="btnSchool">+ 학교 일정 추가</button></div>` : ""}
    <div id="studyBody"><div class="study-empty">불러오는 중…</div></div>`;
  if ($("btnSchool")) $("btnSchool").onclick = () => openSchoolForm(null);
  if (p === "admin") renderOverview(true);
  else renderSchool();
}
// 추가 · 수정 · 승인 뒤: 지금 탭을 새로 받아 다시 그립니다
async function refresh() {
  if (page === "admin") await renderOverview();
  else await renderSchool();
}

// ============================================================
// 관리 탭: 승인 · 피드백 · 학생 · 계획 · 점검 · 분석
// ============================================================
const FEEDBACK_KINDS = { bug: "오류 제보", notice: "전체 분반 공지 오류", idea: "기능 제안", etc: "기타" };

// 관리 탭에 처리할 일(승인 대기 + 마지막으로 본 뒤 새로 온 피드백 + 합치기 제안) 수를 빨갛게 보여 줍니다 (피드백은 이 기기 기준)
const FB_SEEN_KEY = KEYS.fbSeen;
const fbSeenAt = () => { try { return localStorage.getItem(FB_SEEN_KEY) || "1970-01-01T00:00:00Z"; } catch { return "1970-01-01T00:00:00Z"; } };
async function refreshAdminCount() {
  if (!me?.is_admin) return;
  // 이 기수 것만 세려고 수 대신 과목 · 보낸 사람을 받아 거릅니다
  const [pend, fresh, merge, reply, tshare] = await Promise.all([
    sb.from("assignments").select("subject").eq("status", "pending"),
    sb.from("feedback").select("user_id").gt("created_at", fbSeenAt()),
    sb.from("merge_suggestions").select("subject").eq("status", "open"),
    sb.from("feedback_replies").select("created_by").eq("from_admin", false).gt("created_at", fbSeenAt()),   // 학생이 단 새 답글
    sb.rpc("admin_todo_shares"),   // 할 일 공유 승인 대기
  ]);
  if (pend.error || fresh.error) return;
  const mine = await userInCohort([...fresh.data.map((f) => f.user_id), ...(reply.data || []).map((r) => r.created_by)]);
  adminCount = pend.data.filter(asgInCohort).length + fresh.data.filter((f) => mine(f.user_id)).length
    + (merge.error ? 0 : merge.data.filter(asgInCohort).length) + (reply.error ? 0 : reply.data.filter((r) => mine(r.created_by)).length)
    + (tshare.error ? 0 : (tshare.data || []).filter((r) => !r.owner_sid || sidInCohort(r.owner_sid)).length);
  navStat.asg = { v: adminCount, hot: adminCount > 0 };
  renderNav();
  document.title = adminCount ? `(${adminCount}) ${COHORT.title}` : COHORT.title;
}

// ---------- 수행평가 카드 · 승인 · 수정 ----------
const asgDue = (a) => (a.due_at ? dueInfo(a.due_at) : { label: "D-?", tone: "ok", when: null });
const stBadge = (status) => (status === "pending" ? '<span class="st-badge pending">대기</span>'
  : status === "rejected" ? '<span class="st-badge rejected">반려됨</span>' : "");

function card(a) {
  const d = asgDue(a);
  return `<div class="asg-card">
    <div class="asg-top"><span class="asg-subject">${esc(a.subject)} · ${esc(banLabel(a.ban))}</span>
      <span class="asg-badges">${stBadge(a.status)}<span class="due-badge ${d.tone}">${d.label}</span></span></div>
    <div class="asg-title">${esc(a.title)}</div>
    ${a.body ? `<div class="asg-body">${esc(a.body)}</div>` : ""}
    <div class="asg-due"><span>${d.when ? `${d.when} 마감` : "마감 일시 미정"}</span>${a.author_name ? `<span class="asg-by">${esc(a.author_name)} 작성</span>` : ""}</div>
    ${a.submit_to ? `<div class="asg-due">제출: ${esc(a.submit_to)}</div>` : ""}
    <div class="asg-actions">
      <button class="study-btn small ok" data-ok="${a.id}">승인</button>
      <button class="study-btn small no" data-no="${a.id}">반려</button>
      <button class="study-btn small" data-aedit="${a.id}">수정</button>
      <button class="study-btn small no" data-del="${a.id}">삭제</button>
    </div>
  </div>`;
}

async function loadPending() {
  const { data, error } = await sb.from("assignments").select("*").eq("status", "pending").order("due_at", { ascending: true });
  if (!error) cache.pending = data.filter(asgInCohort);   // 이 기수 과목만
}

async function review(id, status) {
  const { error } = await sb.from("assignments")
    .update({ status, reviewed_by: me.id, reviewed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return toast("처리하지 못했어요", true);
  toast(status === "approved" ? "승인했어요" : "반려했어요");
  await refresh();
}

async function removeAsg(a) {
  if (!confirm(a.status === "approved"
    ? "이 수행평가를 삭제할까요? 이 분반 학생들 모두에게서 사라져요."
    : "이 수행평가를 삭제할까요? 올린 학생의 일정에서도 사라져요.")) return false;
  const { data, error } = await sb.from("assignments").delete().eq("id", a.id).select("id");
  if (error || !data?.length) { toast("삭제하지 못했어요", true); return false; }
  toast("삭제했어요");
  await refresh();
  return true;
}

// 수행평가 제출처 (학생 사이트와 같게)
const SUBMIT_PLACES = ["클래스룸", "dshs앱", "패들렛", "메일"];

// 관리자가 올리는 수행평가 공지(바로 승인) · 수행평가 고치기. a 가 있으면 고치기 (과목 · 분반은 그대로)
// seedDay: 학교 일정 달력에서 날짜를 눌러 올릴 때 그날 23:59 를 마감으로
function openAsgForm(a, seedDay) {
  const dueDay = seedDay ? parseDay(seedDay) : new Date();
  if (!seedDay) dueDay.setDate(dueDay.getDate() + 7);
  const dueVal = a ? (a.due_at ? `${dayKey(new Date(a.due_at))}T${hm(new Date(a.due_at))}` : "") : `${dayKey(dueDay)}T23:59`;
  const noDue = !!a && !a.due_at;
  const place = a?.submit_to ? (SUBMIT_PLACES.includes(a.submit_to) ? a.submit_to : "etc") : "";
  const classes = allClassList().filter((c) => !NO_ASG_SUBJECTS.has(c.subject));
  const subjects = [...new Set(classes.map((c) => c.subject))];
  // 관리자는 올린 뒤에도 과목 · 분반을 바꿀 수 있어요 (notice.sql 의 assignments_guard 가 관리자만 허락)
  // 분반이 없는 기수(43기)는 과목마다 '전체 분반' 하나만 있어요
  const opts = subjects.flatMap((s) => [{ subject: s, ban: null }, ...classes.filter((c) => c.subject === s && c.ban)]);
  if (a && !opts.some((o) => o.subject === a.subject && o.ban === a.ban)) opts.unshift({ subject: a.subject, ban: a.ban });
  const cur = a ? opts.findIndex((o) => o.subject === a.subject && o.ban === a.ban) : -1;
  openSheet(a ? "수행평가 수정" : "수행평가 공지 올리기", `
    <label class="study-label">과목 · 분반</label>
    <select class="study-input" id="nClass">
      ${opts.map((o, i) => `<option value="${i}"${i === cur ? " selected" : ""}>${esc(o.subject)} · ${esc(banLabel(o.ban))}</option>`).join("")}
    </select>
    <label class="study-label">제목</label>
    <input class="study-input" id="nTitle" maxlength="120" placeholder="예: 3단원 실험 보고서 제출" value="${esc(a?.title ?? "")}">
    <label class="study-label">내용 (선택)</label>
    <textarea class="study-input" id="nBody" rows="3" maxlength="2000" placeholder="범위, 분량, 준비물 등">${esc(a?.body ?? "")}</textarea>
    <label class="study-label">마감 일시</label>
    <input class="study-input" id="nDue" type="datetime-local" value="${dueVal}"${noDue ? " disabled" : ""}>
    <label class="ev-allday"><input type="checkbox" id="nNoDue"${noDue ? " checked" : ""}> 마감 일시 없음 <span class="ev-hint">(D-? 로 보여요)</span></label>
    <label class="study-label">제출 (선택)</label>
    <select class="study-input" id="nSubmit">
      <option value="">선택 안 함</option>
      ${SUBMIT_PLACES.map((p) => `<option value="${p}"${place === p ? " selected" : ""}>${p}</option>`).join("")}
      <option value="etc"${place === "etc" ? " selected" : ""}>그 외 (입력)</option>
    </select>
    <input class="study-input" id="nSubmitEtc" maxlength="30" placeholder="제출처를 적어 주세요" value="${place === "etc" ? esc(a.submit_to) : ""}" style="display:${place === "etc" ? "block" : "none"};margin-top:8px">
    <div class="study-err" id="authErr"></div>
    <button class="study-submit" id="nSave">${a ? "저장" : "올리기"}</button>
    ${a ? '<button class="study-submit ghost danger" id="nDel">삭제</button>' : ""}
    <div class="study-foot">${a
      ? a.status === "approved" ? "고치면 그 분반 학생 모두에게 바로 바뀐 내용으로 보여요. 학생이 자기 계정에서만 고친 내용은 그대로예요." : "아직 승인 전이에요. 고친 뒤 승인하면 분반 학생들에게 보여요."
      : "관리자가 올리면 승인 없이 바로 그 분반(전체 분반이면 그 과목 학생 모두)에게 보여요."}</div>`);
  $("nSubmit").onchange = () => { $("nSubmitEtc").style.display = $("nSubmit").value === "etc" ? "block" : "none"; };
  $("nNoDue").onchange = () => {
    $("nDue").disabled = $("nNoDue").checked;
    if (!$("nNoDue").checked && !$("nDue").value) $("nDue").value = `${dayKey(dueDay)}T23:59`;
  };
  if ($("nDel")) $("nDel").onclick = async () => { if (await removeAsg(a)) closeModal(); };
  $("nSave").onclick = async () => {
    const { subject, ban } = opts[+$("nClass").value];
    const title = $("nTitle").value.trim();
    const noDueNow = $("nNoDue").checked, due = $("nDue").value;
    const placeNow = $("nSubmit").value;
    const submitTo = placeNow === "etc" ? $("nSubmitEtc").value.trim() : placeNow;
    if (!title) return showErr("제목을 입력해 주세요.");
    if (!noDueNow && !due) return showErr("마감 일시를 정하거나 \"마감 일시 없음\" 을 골라 주세요.");
    if (placeNow === "etc" && !submitTo) return showErr("제출처를 적어 주세요.");
    const fields = { subject, ban, title, body: $("nBody").value.trim(), submit_to: submitTo || null, due_at: noDueNow ? null : new Date(due).toISOString() };
    $("nSave").disabled = true;
    let error;
    if (a) {
      const res = await sb.from("assignments").update(fields).eq("id", a.id).select("id");
      error = res.error || (!res.data?.length && { message: "수정 권한이 없어요" });
    } else {
      ({ error } = await sb.from("assignments").insert({
        ...fields, created_by: me.id, status: "approved", reviewed_by: me.id, reviewed_at: new Date().toISOString(),
      }));
    }
    $("nSave").disabled = false;
    if (error) return showErr(`${a ? "저장하지" : "올리지"} 못했어요: ${error.message}`);
    closeModal();
    toast(a ? "고쳤어요" : "바로 올렸어요");
    await refresh();
  };
}

// ---------- 학생 현황 ----------
// 데이터는 admin_overview() 한 번으로 받습니다 (overview.sql).
// 본인만 보는 내용(할 일 · 개인 일정 등)은 서버에서 제목 없이 수만 옵니다.
// 마지막으로 본 뒤 생긴 활동은 강조합니다 (이 기기 기준, 처음 열 때는 강조 없음).
const OV_SEEN_KEY = KEYS.ovSeen;
const ovTime = (s) => {
  if (!s) return "기록 없음";
  const d = new Date(s);
  return `${dayTitle(dayKey(d))} ${hm(d)}`;
};
const ovWho = (r) => `${r.student_id ? `${r.student_id} ` : ""}${esc(r.name)}`;
const OV_COUNTS = [["assignments", "수행평가"], ["personal", "개인 수정"], ["done", "완료 표시"], ["events", "일정"],
  ["todos", "할 일"], ["groups", "그룹"], ["feedback", "피드백"], ["push", "알림 기기"]];

// 학생 현황에서 숫자를 보고 하면 좋을 일을 고릅니다 ('제안' 칸 맨 위). 새 규칙은 여기에 한 줄씩 더합니다.
function overviewTips(data) {
  const joined = data.students;
  const weekAgo = Date.now() - 7 * 86400000;
  const idle = joined.filter((s) => !s.location && OV_COUNTS.every(([k]) => k === "push" || !s[k])).length;
  const noPush = joined.filter((s) => !s.push).length;
  const away = joined.filter((s) => !s.last_login || Date.parse(s.last_login) < weekAgo).length;
  const writers = joined.filter((s) => s.assignments > 0).length;
  const tips = [];
  if (data.not_joined.length >= data.roster * 0.3) tips.push(`아직 ${data.not_joined.length}명이 가입하지 않았어요. 단톡방에 사이트 주소와 'dshs.app으로 로그인' 방법을 공지해 보세요.`);
  if (idle >= 3) tips.push(`가입만 하고 아직 쓰지 않은 학생이 ${idle}명이에요. 수행평가와 일정 쓰는 법을 짧게 소개해 보세요.`);
  if (noPush >= 3) tips.push(`알림 켠 기기가 없는 학생이 ${noPush}명이에요. 설정에서 알림을 켜야 마감 알림을 받는다고 안내해 보세요.`);
  if (away >= 3) tips.push(`7일 넘게 로그인 기록이 없는 학생이 ${away}명이에요. 로그인을 유지한 채 쓰는 학생도 포함될 수 있어요.`);
  if (joined.length >= 10 && writers < joined.length * 0.3) tips.push(`수행평가를 올린 학생이 ${writers}명뿐이에요. 과목이나 분반별로 올려 줄 학생을 정해 보세요.`);
  return tips;
}

// 이용 통계: 가입한 학생 가운데 기능마다 한 번이라도 쓴 학생 수 · 로그인 최근성 · 쓴 기능 수 · 반별 가입.
// admin_overview 의 수만 씁니다 (내용은 받지 않음). 줄을 누르면 쓴 학생 / 안 쓴 학생 이름이 나와요.
const USE_FEATURES = [
  ["events", "개인 일정 직접 만듦"], ["invited", "친구가 넣은 일정 있음"], ["todos", "할 일 추가"], ["done", "수행평가 완료 표시"], ["assignments", "수행평가 올림"],
  ["personal", "수행평가 개인 수정"], ["location", "내 위치 남김"], ["push", "알림 켠 기기 있음"], ["groups", "그룹 만듦"], ["feedback", "피드백 보냄"],
  ["comments", "수행평가 댓글 씀"], ["bookmarks", "공부 탭 단어 북마크"],
];
const usedFeature = (s, k) => k === "location" ? !!s.location : s[k] > 0;
function usageStatsHtml(data) {
  const all = data.students.filter((s) => s.student_id);
  const n = all.length;
  if (!n) return "";
  const pct = (x) => Math.round(x / n * 100);
  const names = (list) => list.length ? list.map(ovWho).join(" · ") : "없음";
  const bar = (label, yes, no, extra = "") => `<details class="adm-use">
      <summary><span class="adm-use-l">${label}</span><span class="adm-use-bar"><i style="width:${pct(yes.length)}%"></i></span><span class="adm-use-n">${yes.length}명 <small>${pct(yes.length)}%</small></span></summary>
      <p><b>${extra || "쓴 학생"} ${yes.length}</b> ${names(yes)}</p>
      ${no ? `<p class="dim"><b>안 쓴 학생 ${no.length}</b> ${names(no)}</p>` : ""}
    </details>`;
  const features = USE_FEATURES.map(([k, label]) => bar(label, all.filter((s) => usedFeature(s, k)), all.filter((s) => !usedFeature(s, k)))).join("");
  // 마지막 로그인 (토큰이 살아 있으면 다시 로그인하지 않으므로 '오래됨'이 꼭 안 쓴다는 뜻은 아님)
  const age = (s) => s.last_login ? (Date.now() - Date.parse(s.last_login)) / 86400000 : Infinity;
  const login = [["오늘", (a) => a < 1], ["1~3일 전", (a) => a >= 1 && a < 3], ["3~7일 전", (a) => a >= 3 && a < 7], ["7일보다 전", (a) => a >= 7]]
    .map(([label, f]) => bar(label, all.filter((s) => f(age(s))), null, "해당 학생")).join("");
  // 쓴 기능 수 (알림 · 피드백은 빼고 일정 · 할 일 · 수행평가 · 위치 · 그룹)
  const core = ["events", "todos", "done", "assignments", "personal", "location", "groups", "comments", "bookmarks"];
  const depth = (s) => core.filter((k) => usedFeature(s, k)).length;
  const depthRows = [["가입만 함 (0개)", (d) => d === 0], ["1~2개", (d) => d >= 1 && d <= 2], ["3~4개", (d) => d >= 3 && d <= 4], ["5개 이상", (d) => d >= 5]]
    .map(([label, f]) => bar(label, all.filter((s) => f(depth(s))), null, "해당 학생")).join("");
  // 반별 가입 (학번 둘째 자리 = 반)
  const cls = new Map();
  const add = (sid, joined) => { const c = Math.floor(sid / 100) % 10; const x = cls.get(c) || { j: 0, t: 0 }; x.t++; if (joined) x.j++; cls.set(c, x); };
  all.forEach((s) => add(s.student_id, true));
  data.not_joined.forEach((s) => add(s.student_id, false));
  const classes = [...cls].sort((a, b) => a[0] - b[0]).map(([c, x]) => `<div class="adm-tile"><b>${x.j}<small>/${x.t}</small></b>${c}반</div>`).join("");
  // 개인 일정: 직접 만든 학생과 친구가 넣어 줘서만 있는 학생을 나눠 봅니다
  const own = (s) => s.events > 0, got = (s) => s.invited > 0;
  const evRows = [["직접 만들고 친구가 넣은 것도 있음", (s) => own(s) && got(s)], ["직접 만들기만 함", (s) => own(s) && !got(s)],
    ["친구가 넣어 준 일정만 있음", (s) => !own(s) && got(s)], ["개인 일정 없음", (s) => !own(s) && !got(s)]]
    .map(([label, f]) => bar(label, all.filter(f), null, "해당 학생")).join("");
  const weekAgo = Date.now() - 7 * 86400000;
  const fresh = all.filter((s) => Date.parse(s.joined_at) > weekAgo).length;
  return `<div class="adm-label">이용 통계 <small>가입한 ${n}명 기준 · 누르면 이름</small></div>
    <div class="adm-uses">${features}</div>
    <div class="adm-label">개인 일정 <small>직접 만듦 · 친구가 넣어 줌</small></div>
    <div class="adm-uses">${evRows}</div>
    <div class="adm-label">쓴 기능 수 <small>일정 · 할 일 · 완료 표시 · 수행평가 올림 · 개인 수정 · 위치 · 그룹 · 댓글 · 북마크 중</small></div>
    <div class="adm-uses">${depthRows}</div>
    <div class="adm-label">마지막 로그인</div>
    <div class="adm-uses">${login}</div>
    <div class="adm-foot">로그인을 유지한 채 쓰면 다시 로그인하지 않아서, 오래전으로 보여도 쓰고 있을 수 있어요.</div>
    <div class="adm-label">반별 가입 <small>최근 7일 새로 가입 ${fresh}명</small></div>
    <div class="adm-tiles">${classes}</div>`;
}

// 학생 칸은 있는 그대로만 보여 줍니다. 숫자를 보고 할 일(overviewTips)은 '제안' 칸에 있어요.
function studentsHtml(data, seen) {
  const first = seen === Infinity;   // 처음 열면 강조하지 않습니다
  const nNew = first ? 0 : data.activity.filter((a) => Date.parse(a.at) > seen).length;
  const activity = data.activity.map((a) => {
    const isNew = !first && Date.parse(a.at) > seen;
    return `<div class="adm-row${isNew ? " new" : ""}">
      <div class="adm-row-top"><b>${ovWho(a)}</b><span>${esc(ovTime(a.at))}</span></div>
      <div class="adm-row-sub">${esc(a.text)}</div>
    </div>`;
  }).join("");
  const students = data.students.map((s) => {
    const counts = OV_COUNTS.filter(([k]) => s[k] > 0).map(([k, label]) => `${label} ${s[k]}`);
    return `<div class="adm-row${s.student_id ? " click" : ""}"${s.student_id ? ` data-stucal="${s.student_id}" title="이 학생 달력 보기"` : ""}>
      <div class="adm-row-top"><b>${ovWho(s)}</b>${s.location ? `<span>📍 ${esc(s.location)}</span>` : ""}</div>
      <div class="adm-row-sub">${counts.length ? counts.join(" · ") : "아직 활동 없음"}</div>
      <div class="adm-row-sub dim">마지막 로그인 ${esc(ovTime(s.last_login))}</div>
    </div>`;
  }).join("");
  return `<div class="adm-tiles">
      <div class="adm-tile"><b>${data.students.length}<small>/${data.roster}</small></b>가입</div>
      <div class="adm-tile"><b>${data.not_joined.length}</b>아직 가입 안 함</div>
    </div>
    ${usageStatsHtml(data)}
    <div class="adm-label">명단</div>
    <details class="adm-acc"><summary>최근 활동<span>${nNew ? `새 ${nNew} · ` : ""}${data.activity.length}</span></summary>${activity || '<div class="adm-none">아직 활동이 없어요.</div>'}</details>
    <details class="adm-acc"><summary>가입한 학생<span>${data.students.length}</span></summary>${students || '<div class="adm-none">아직 가입한 학생이 없어요.</div>'}</details>
    <details class="adm-acc"><summary>아직 가입 안 한 학생<span>${data.not_joined.length}</span></summary><p>${data.not_joined.map(ovWho).join(" · ")}</p></details>
    <div class="adm-foot">지금 남아 있는 내용만 보여요. 지운 항목과 고치기 전 내용은 나오지 않아요. 할 일 · 개인 일정 · 개인 수정 · 학생 그룹의 내용은 본인만 볼 수 있어 수와 시각만 보여요.</div>`;
}

// 방문 기기 수 (admin_visits, visits.sql): 오늘 숫자와 최근 7일 막대
function visitsHtml(v) {
  if (!v?.days?.length) return '<div class="adm-none">방문 기록을 불러오지 못했어요.</div>';
  const t = v.days[v.days.length - 1];
  const guest = t.total - t.logged_in;
  const max = Math.max(1, ...v.days.map((d) => d.total));
  const wd = (d) => parseDay(d.day).toLocaleDateString("ko-KR", { weekday: "short" });
  return `<div class="adm-label">방문 기기</div>
    <div class="adm-tiles">
      <div class="adm-tile"><b>${t.total}</b>오늘 방문 기기</div>
      <div class="adm-tile"><b>${t.logged_in}</b>로그인</div>
      <div class="adm-tile"><b>${guest}</b>비로그인</div>
    </div>
    <div class="adm-sum">폰 ${t.phone} · 노트북·PC ${t.pc} · 태블릿 ${t.tablet}${guest ? ` (비로그인 ${guest}대 중 폰 ${t.guest_phone})` : ""}${t.standalone ? ` · 설치한 앱 ${t.standalone}` : ""}<br>최근 7일 서로 다른 기기 ${v.week_devices}대</div>
    <div class="adm-visits">${v.days.map((d) => `<div title="${esc(dayTitle(d.day))} · ${d.total}대 (로그인 ${d.logged_in})">
      <span>${d.total}</span>
      <i style="height:${Math.round(d.total / max * 100)}%"><em style="height:${d.total ? Math.round(d.logged_in / d.total * 100) : 0}%"></em></i>
      <small>${wd(d)}</small>
    </div>`).join("")}</div>
    <div class="adm-foot">학생 사이트의 방문 기기 수예요. 한 학생이 폰과 노트북을 쓰면 2대로 세요. 진한 부분이 로그인한 기기예요. 관리자 기기는 세지 않아요. ${cohortSplit ? `${COHORT.label} 사이트 방문만 셌어요.` : `기기 수는 모든 기수 사이트(42기 · 43기)를 합친 수이고, 아래 학생 이름만 ${COHORT.label}예요.`}</div>
    ${visitUsersHtml(v)}`;
}

// ---------- 로그인 이탈 (loginsteps.sql 의 admin_login_funnel) ----------
// 학생 사이트에서 'dshs.app 계정으로 시작하기'를 누른 시도마다 어디서 멈췄는지 묶어 보고, 숫자로 원인과 고칠 방향을 짚습니다.
const LOGIN_OUTCOME = {
  done: ["로그인 성공", ""],
  abandon: ["dshs.app 로그인 화면에서 돌아오지 않음", "Google 로그인 · 동의 화면에서 그만뒀거나, 로그인 뒤 다른 브라우저 · 앱에서 열렸어요"],
  "fail:denied": ["dshs.app 동의 화면에서 취소", "동의 화면에서 '취소'를 눌렀어요. 무엇을 읽어 가는지(학번 · 이름) 미리 알려 주면 줄어요"],
  "fail:notstudent": [`${COHORT.label} 명단에 없는 계정`, "다른 기수 · 선생님 계정이거나, 명단(SCHOOL_DATA)에 학번이 없어요"],
  "fail:expired": ["시간 초과 (10분)", "로그인 화면을 오래 열어 두었거나 같은 링크로 다시 들어왔어요"],
  "fail:failed": ["dshs.app 쪽 오류", "dshs.app 이 오류를 돌려줬어요. 몰려 있으면 dshs-oauth 함수 기록을 확인해요"],
  "fail:verify": ["돌아온 뒤 로그인 처리 실패", "일회용 토큰을 쓰지 못했어요 (이미 쓴 토큰 · 다른 브라우저). 몰려 있으면 버그예요"],
  "fail:profile": ["계정 정보(프로필) 없음", "계정은 만들어졌는데 프로필을 읽지 못했어요. 버그일 가능성이 커요"],
  "fail:mismatch": ["학번이 다른 계정", ""],
  start_fail: ["로그인을 시작하지 못함", "로그인 주소를 받지 못했어요 (인터넷 · 서버 문제)"],
  click_only: ["누르고 바로 멈춤", "로그인 화면으로 넘어가기 전에 멈췄어요 (팝업 차단 · 느린 연결)"],
  pending: ["진행 중 (15분 안)", ""],
};
const LOGIN_ENV = {
  "ios-safari": "아이폰 Safari", "ios-chrome": "아이폰 크롬", "ios-app": "아이폰 홈 화면 앱", "android-chrome": "안드로이드 크롬",
  "android-samsung": "삼성 인터넷", "android-app": "안드로이드 앱", kakao: "카카오톡 안 브라우저", inapp: "다른 앱 안 브라우저", pc: "PC 브라우저", "pc-app": "PC 앱",
};
function loginFunnelHtml(f) {
  if (!f) return `<div class="adm-label">로그인 이탈</div><div class="adm-none">기록을 불러오지 못했어요. loginsteps.sql 을 실행했는지 확인해 주세요.</div>`;
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const outs = Object.entries(f.outcomes || {}).filter(([k]) => k !== "pending");
  const tried = outs.reduce((s, [, n]) => s + n, 0);   // 끝난 시도 (진행 중 제외)
  const done = f.done || 0;
  const label = (k) => (LOGIN_OUTCOME[k] || [k.replace(/^fail:/, "실패: ")])[0];
  // 분석: 숫자에서 바로 읽히는 것만 짧게
  const notes = [];
  if (f.gate_seen) {
    const r = pct(f.gate_click, f.gate_seen);
    notes.push(`시작 화면을 본 ${f.gate_seen}대 중 <b>${f.gate_click}대(${r}%)</b>만 시작하기를 눌렀어요.${r < 40 ? " 버튼을 누르기 전 이탈이 가장 커요 — 화면에서 무엇을 쓸 수 있는지 더 보여 주는 게 먼저예요." : ""}`);
  }
  if (tried) {
    notes.push(`끝난 시도 ${tried}번 중 <b>${done}번(${pct(done, tried)}%)</b> 로그인에 성공했어요${f.median_sec ? ` · 성공까지 보통 ${f.median_sec < 90 ? `${f.median_sec}초` : `${Math.round(f.median_sec / 60)}분`}` : ""}.`);
    const worst = outs.filter(([k]) => k !== "done").sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= 2) notes.push(`가장 많이 멈춘 곳: <b>${label(worst[0])}</b> ${worst[1]}번(${pct(worst[1], tried)}%). ${LOGIN_OUTCOME[worst[0]]?.[1] || ""}`);
    const total = pct(done, tried);
    const bad = (f.envs || []).filter((e) => e.attempts >= 3).map((e) => ({ ...e, r: pct(e.done, e.attempts) }))
      .filter((e) => e.r <= total - 20).sort((a, b) => a.r - b.r)[0];
    if (bad) notes.push(`<b>${LOGIN_ENV[bad.env] || bad.env}</b>에서 성공률이 ${bad.r}%로 낮아요 (전체 ${total}%)${bad.env === "kakao" || bad.env === "inapp" ? ". 앱 안 브라우저는 Google 로그인이 막혀 기본 브라우저로 넘겨요 — 넘어간 뒤 돌아오지 않는 경우예요" : bad.env === "ios-app" ? ". 홈 화면 앱은 로그인 창이 따로 열려, 로그인 뒤 앱으로 돌아오지 않으면 끊겨요" : ""}.`);
  } else notes.push("아직 끝난 로그인 시도가 없어요.");
  const bar = (name, n, of, extra = "") => `<details class="adm-use"><summary><span class="adm-use-l">${name}</span><span class="adm-use-bar"><i style="width:${pct(n, of)}%"></i></span><span class="adm-use-n">${n}번 <small>${pct(n, of)}%</small></span></summary>${extra ? `<p>${extra}</p>` : ""}</details>`;
  const outRows = outs.sort((a, b) => b[1] - a[1]).map(([k, n]) => bar(label(k), n, tried, LOGIN_OUTCOME[k]?.[1] || "")).join("");
  const envRows = (f.envs || []).map((e) => bar(`${LOGIN_ENV[e.env] || e.env} <small>${e.attempts}번 시도</small>`, e.done, e.attempts,
    `성공 ${e.done}번${e.abandon ? ` · 돌아오지 않음 ${e.abandon}번` : ""}`)).join("");
  const KIND = { gate: "막힘 화면", sheet: "시작하기 · 설정 창" };
  const recent = (f.recent || []).map((r) => `<span class="adm-chip">${esc(ovTime(r.at))} · ${esc(LOGIN_ENV[r.env] || r.env)} · ${esc(label(r.outcome))}${r.src ? ` · ${KIND[r.src] || esc(r.src)}` : ""}</span>`).join(" ");
  return `<div class="adm-label">로그인 이탈 <small>최근 ${f.days}일</small></div>
    <div class="adm-tiles">
      <div class="adm-tile"><b>${f.gate_seen}</b>시작 화면 본 기기</div>
      <div class="adm-tile"><b>${f.attempts}</b>시작하기 누름</div>
      <div class="adm-tile"><b>${done}</b>로그인 성공</div>
    </div>
    <div class="adm-sum">${notes.join("<br>")}</div>
    ${outRows ? `<div class="adm-label">시도 결과 <small>누르면 원인</small></div><div class="adm-uses">${outRows}</div>` : ""}
    ${envRows ? `<div class="adm-label">브라우저별 성공</div><div class="adm-uses">${envRows}</div>` : ""}
    ${recent ? `<details class="adm-acc"><summary>최근 멈춘 시도<span>${f.recent.length}</span></summary><div class="adm-visit-users">${recent}</div></details>` : ""}
    <div class="adm-foot">시작 화면 본 기기는 기기 × 날짜로 세요. 시도는 '시작하기'를 누른 횟수예요. 다른 브라우저에서 돌아와 성공한 경우는 새 시도로 세요. 이름 · 학번은 기록하지 않아요. ${cohortSplit ? `${COHORT.label} 사이트에서 시작한 시도만 셌어요.` : "모든 기수 사이트(42기 · 43기)를 합친 수예요."}</div>`;
}

// 오늘 로그인한 상태로 연 학생 (visits.sql 의 today_users). '전환'은 그전엔 이 기기에서 비로그인으로만 썼던 학생
function visitUsersHtml(v) {
  const users = v.today_users || [];
  if (!users.length && !v.today_unknown) return "";
  const KIND = { phone: "폰", tablet: "태블릿", pc: "PC" };
  const at = (s) => new Date(s).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `<div class="adm-label">오늘 로그인한 학생 ${users.length}명</div>
    <div class="adm-visit-users">${users.map((u) => `<span class="adm-chip${u.was_guest ? " hot" : ""}" title="${u.was_guest ? "그전엔 이 기기에서 비로그인으로만 썼어요" : ""}">${esc(u.student_id ? `${u.student_id} ${u.name}` : u.name)} · ${KIND[u.kind] || ""} ${at(u.at)}${u.was_guest ? " · 전환" : ""}</span>`).join("")}</div>
    ${v.today_unknown ? `<div class="adm-foot">이름 기록을 시작하기 전에 로그인한 기기 ${v.today_unknown}대는 이름 없이 셌어요.</div>` : ""}`;
}

// replies: 이 피드백에 오간 답장들 (feedbackreply.sql). from_admin 이 false 면 학생이 다시 쓴 답글.
// 관리자 답장은 학생이 읽으면 '읽음'이 붙습니다. nameOf 로 답장한 관리자 이름을 찾습니다.
// 마지막으로 본 뒤(fbSeen) 학생 답글이 달린 지난 피드백은 '새 답글'로 위쪽 '새 피드백'에 다시 올라옵니다.
const fbByStudent = (r) => r.from_admin === false;
function feedbackItemHtml(f, name, url, isNew, replies = [], nameOf = new Map()) {
  const lastRe = replies[replies.length - 1];
  const state = !replies.length ? "" : fbByStudent(lastRe) ? "답장 기다리는 중" : "답장함";
  return `<div class="adm-fb${isNew ? " new" : ""}">
    <div class="adm-fb-top"><span class="adm-chip">${FEEDBACK_KINDS[f.kind]}</span>${isNew ? `<span class="fb-new">${Date.parse(f.created_at) > fbSeen ? "새 피드백" : "새 답글"}</span>` : ""}${state ? `<span class="adm-chip">${state}</span>` : ""}</div>
    <div class="adm-fb-text">${esc(f.body)}</div>
    ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="fb-img" src="${esc(url)}" alt="첨부한 스크린샷"></a>` : ""}
    ${replies.map((r) => `<div class="adm-fb-re${fbByStudent(r) ? " stu" : ""}">
      <div class="adm-fb-re-top"><b>${fbByStudent(r) ? `${esc(name || "학생")} 답글` : `${esc(nameOf.get(r.created_by) || "관리자")} 답장`}</b><span>${esc(ovTime(r.created_at))}${fbByStudent(r) ? "" : ` · ${r.seen_at ? "읽음" : "아직 안 읽음"}`}</span><button type="button" data-redel="${r.id}">지우기</button></div>
      <div class="adm-fb-re-text">${esc(r.body)}</div>
    </div>`).join("")}
    <div class="adm-fb-write" data-rebox="${f.id}" hidden>
      <textarea class="study-input" rows="3" maxlength="2000" placeholder="${esc(name || "학생")}에게 보낼 답장. 학생의 피드백 창에 보이고 알림이 가요."></textarea>
      <div class="adm-fb-write-foot"><button class="study-btn small" type="button" data-recancel="${f.id}">취소</button><button class="study-btn primary small" type="button" data-resend="${f.id}">답장 보내기</button></div>
    </div>
    <div class="adm-fb-foot"><span>${esc(name || "알 수 없음")} · ${esc(ovTime(f.created_at))}</span><span class="adm-fb-foot-btns"><button class="study-btn small" data-reopen="${f.id}">답장</button><button class="study-btn small no" data-fbdel="${f.id}">삭제</button></span></div>
  </div>`;
}

// 최근 피드백 100건과 스크린샷 주소 · 보낸 학생 이름을 받습니다
async function loadFeedback() {
  const { data: raw, error } = await sb.from("feedback").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return { error };
  // 보낸 학생의 학번으로 이 기수 것만 남깁니다 (학번 없는 계정 · 프로필을 못 찾은 피드백은 그대로 보여요)
  const { data: authors } = raw.length
    ? await sb.from("profiles").select("id, name, student_id").in("id", [...new Set(raw.map((f) => f.user_id).filter(Boolean))])
    : { data: [] };
  const sidBy = new Map((authors || []).map((p) => [p.id, p.student_id]));
  const data = raw.filter((f) => sidInCohort(sidBy.get(f.user_id)));
  const paths = data.map((f) => f.image_path).filter(Boolean);
  const signed = paths.length ? (await sb.storage.from("feedback").createSignedUrls(paths, 3600)).data || [] : [];
  // 답장 (feedbackreply.sql 을 아직 실행하지 않았으면 빈 목록)
  const { data: replies } = data.length
    ? await sb.from("feedback_replies").select("*")
        .in("feedback_id", data.map((f) => f.id)).order("created_at")
    : { data: [] };
  // 답장한 관리자 이름
  const more = [...new Set((replies || []).map((r) => r.created_by).filter((id) => id && !sidBy.has(id)))];
  const { data: admins } = more.length ? await sb.from("profiles").select("id, name, student_id").in("id", more) : { data: [] };
  const who = [...(authors || []), ...(admins || [])];
  return {
    rows: data,
    replies: replies || [],
    urlOf: new Map(signed.map((x) => [x.path, x.signedUrl])),
    nameOf: new Map((who || []).map((p) => [p.id, p.student_id ? `${p.student_id} ${p.name}` : p.name])),
  };
}

// ---------- 제작 칸: Claude 제작 맡기기 (agenttasks.sql · scripts/build-agent) ----------
// 초안을 고쳐 '제작 승인'하면 관리자 노트북의 Claude 가 agent-<번호> 브랜치에서 만들고 미리보기 주소와 함께 알려요.
// 미리보기를 보고 '수정 요청'(메모)하면 다시 만들고(최대 3번), '최종 승인'하면 main 에 합쳐 beta 에 올라가요.
const DEV_LABEL = {
  draft: "새 제안", approved: "제작 대기", building: "제작 중", review: "확인해 주세요", revise: "수정 대기",
  accepted: "합치는 중", merged: "beta 반영", rejected: "버림", failed: "실패", needs_human: "사람 손 필요",
};
const DEV_HOT = new Set(["draft", "review", "failed", "needs_human"]);   // 관리자가 볼 차례
const DEV_MAX = 3;
// 계획: 관리자마다 칸이 있고, 끝낸 항목은 아래로 내립니다 (plans.sql). 🛠 를 누르면 그 계획을 제작 초안으로 만들어요.
const PLAN_OWNERS = ["반민지", "진주빈"];
function plansHtml(plans, tasks) {
  if (!plans) return '<div class="adm-none">계획을 불러오지 못했어요. plans.sql 을 실행했는지 확인해 주세요.</div>';
  const asked = new Set((tasks || []).map((t) => t.title));
  return `<div class="adm-plans">${PLAN_OWNERS.map((owner) => {
    const list = plans.filter((p) => p.owner === owner).sort((a, b) => a.done - b.done);
    return `<div class="adm-plan">
      <div class="adm-plan-head"><b>${owner}</b><span>남은 일 ${list.filter((p) => !p.done).length}</span></div>
      ${list.map((p) => `<div class="adm-plan-item${p.done ? " done" : ""}">
        <input type="checkbox" data-plandone="${p.id}"${p.done ? " checked" : ""} aria-label="끝냄 표시">
        <span data-plantext="${p.id}" title="눌러서 고치기">${esc(p.title)}</span>
        ${p.done ? "" : asked.has(p.title) ? '<button disabled title="제작 맡김">🛠✓</button>' : `<button data-plandev="${p.id}" title="Claude 에게 제작 맡기기 (초안)" aria-label="제작 맡기기">🛠</button>`}
        <button data-planedit="${p.id}" aria-label="고치기">✎</button>
        <button data-plandel="${p.id}" aria-label="삭제">✕</button>
      </div>`).join("") || '<div class="adm-plan-none">아직 적은 계획이 없어요.</div>'}
      <form class="adm-plan-add" data-planadd="${owner}">
        <input type="text" maxlength="200" placeholder="계획 추가" aria-label="${owner} 계획 추가">
        <button class="study-btn small" type="submit">추가</button>
      </form>
    </div>`;
  }).join("")}</div>`;
}

function bindPlans(body, plans, addTask) {
  const save = async (query, fail) => {
    const { error } = await query;
    if (error) { toast(fail, true); return false; }
    renderOverview();
    return true;
  };
  body.querySelectorAll("[data-plandone]").forEach((x) => x.onchange = () =>
    save(sb.from("admin_plans").update({ done: x.checked }).eq("id", x.dataset.plandone), "저장하지 못했어요"));
  body.querySelectorAll("[data-plandel]").forEach((x) => x.onclick = () => {
    if (confirm("이 계획을 삭제할까요?")) save(sb.from("admin_plans").delete().eq("id", x.dataset.plandel), "삭제하지 못했어요");
  });
  // 고치기: 글자를 누르거나 ✎ → 그 자리에서 입력창. 엔터 · 다른 곳 누르면 저장, Esc 는 취소
  const edit = (id) => {
    const span = body.querySelector(`[data-plantext="${id}"]`);
    if (!span || span.querySelector("input")) return;
    const before = span.textContent;
    const input = Object.assign(document.createElement("input"), { type: "text", maxLength: 200, value: before, className: "adm-plan-edit" });
    input.setAttribute("aria-label", "계획 고치기");
    span.replaceChildren(input);
    input.focus();
    input.setSelectionRange(before.length, before.length);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (!keep || !title || title === before) return span.replaceChildren(before);
      save(sb.from("admin_plans").update({ title }).eq("id", id), "고치지 못했어요");
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
  };
  body.querySelectorAll("[data-plantext]").forEach((x) => x.onclick = () => edit(x.dataset.plantext));
  body.querySelectorAll("[data-planedit]").forEach((x) => x.onclick = () => edit(x.dataset.planedit));
  body.querySelectorAll("[data-planadd]").forEach((f) => f.onsubmit = (e) => {
    e.preventDefault();
    const title = f.querySelector("input").value.trim();
    if (title) save(sb.from("admin_plans").insert({ owner: f.dataset.planadd, title }), "추가하지 못했어요");
  });
  // 계획 → 제작 초안 (위 '새 제안'에서 고친 뒤 '승인하고 만들기')
  body.querySelectorAll("[data-plandev]").forEach((b) => b.onclick = () => {
    const p = (plans || []).find((x) => x.id === b.dataset.plandev);
    if (!p) return;
    b.disabled = true;
    addTask({ title: p.title, spec: p.title, source: { plan: p.id } });
  });
}

function devHtml(tasks, usage, plans, overview) {
  if (!tasks) return '<div class="adm-none">제작 목록을 불러오지 못했어요. agenttasks.sql 을 실행했는지 확인해 주세요.</div>';
  const chip = (t) => `<span class="${DEV_HOT.has(t.status) ? "fb-new" : "adm-chip"}">${DEV_LABEL[t.status]}</span>`;
  const head = (t) => `<div class="adm-fb-top">${chip(t)}<b>${esc(t.title)}</b>${t.rounds ? `<span class="adm-chip">${t.rounds}/${DEV_MAX}번째</span>` : ""}</div>`;
  const foot = (t, btns) => `<div class="adm-fb-foot"><span>${esc(ovTime(t.updated_at))}</span><span>${btns}</span></div>`;
  const ta = (attr, val, ph) => `<textarea ${attr} rows="4" maxlength="4000" placeholder="${ph}" class="adm-field">${esc(val)}</textarea>`;
  const btn = (attr, id, label) => `<button class="study-btn small" ${attr}="${id}">${label}</button>`;
  const card = (t) => {
    if (t.status === "draft") {
      const src = t.source || {};
      const GOAL = { login: "로그인 늘리기", convenience: "편의", both: "로그인 · 편의" }, EFFORT = { low: "금방", mid: "보통", high: "큰 작업" };
      return `<div class="adm-fb new">
      <div class="adm-fb-top"><b>${esc(t.title)}</b>${GOAL[src.goal] ? `<span class="adm-chip">${GOAL[src.goal]}</span>` : ""}${EFFORT[src.effort] ? `<span class="adm-chip">${EFFORT[src.effort]}</span>` : ""}</div>
      ${src.why ? `<div class="adm-fb-text">${esc(src.why)}</div>` : ""}
      <details class="adm-spec"${src.why ? "" : " open"}><summary>Claude 에게 줄 지시 보기 · 고치기</summary>
        <input type="text" data-devtitle="${t.id}" maxlength="200" value="${esc(t.title)}" aria-label="제목" class="adm-field">
        ${ta(`data-devspec="${t.id}"`, t.spec, "무엇을 · 어디를 · 어떻게")}
        <div style="text-align:right;margin-top:6px">${btn("data-devsave", t.id, "고친 내용 저장")}</div>
      </details>
      <div class="adm-dev-act"><button class="study-btn primary" data-devgo="${t.id}">승인하고 만들기</button>${btn("data-devdrop", t.id, "버리기")}</div></div>`;
    }
    const info = `${t.preview_url ? `<div class="adm-fb-text"><a href="${esc(t.preview_url)}" target="_blank" rel="noopener">미리보기 열기 ↗</a>${t.branch ? ` · <code>${esc(t.branch)}</code>` : ""}</div>` : ""}
      ${t.summary ? `<div class="adm-fb-text" style="white-space:pre-wrap">${esc(t.summary)}</div>` : ""}
      ${t.error ? `<div class="adm-fb-text" style="color:#ff6b6d;white-space:pre-wrap">${esc(t.error)}</div>` : ""}
      ${t.note && t.status !== "review" ? `<div class="adm-foot">수정 요청: ${esc(t.note)}</div>` : ""}`;
    if (t.status === "review") {
      const more = t.rounds < DEV_MAX;
      return `<div class="adm-fb new">${head(t)}${info}
      ${more ? ta(`data-devnote="${t.id}"`, "", "고칠 점이 있으면 적고 '수정 요청'") : ""}
      ${foot(t, `${more ? `${btn("data-devfix", t.id, "수정 요청")} ` : ""}${btn("data-devok", t.id, "최종 승인")} ${btn("data-devdrop", t.id, "버리기")}`)}</div>`;
    }
    // DB · 서버 함수 파일이 바뀌어 멈춘 것도 미리보기가 있으면 최종 승인할 수 있어요 (합친 뒤 그 변경은 사람이 적용)
    const okHuman = t.status === "needs_human" && t.preview_url && t.branch && /^DB · 서버 함수 변경/.test(t.error || "");
    const retry = ["failed", "needs_human"].includes(t.status)
      ? `${okHuman ? `${btn("data-devok", t.id, "최종 승인")} ` : ""}${btn("data-devdraft", t.id, "초안으로")} ${btn("data-devdrop", t.id, "버리기")}` : "";
    return `<div class="adm-fb${DEV_HOT.has(t.status) ? " new" : ""}">${head(t)}${info}${foot(t, retry)}</div>`;
  };
  const over = (t) => ["merged", "rejected"].includes(t.status);
  const live = tasks.filter((t) => !over(t)), done = tasks.filter(over);
  const drafts = live.filter((t) => t.status === "draft"), going = live.filter((t) => t.status !== "draft");
  const last = usage?.[0];
  return `<div class="adm-goal"><b>목표</b> 로그인해서 쓰는 학생 늘리기 · 수행평가 · 일정 기능을 쓰는 학생 늘리기
      <span>매일 밤 10시 Claude 가 사용 기록을 보고 이 목표에 맞는 개발을 제안해요. 고치거나 그대로 '승인하고 만들기'를 누르면 Claude 가 만들고 미리보기를 보내요.</span></div>
    ${overview ? overviewTips(overview).map((t) => `<div class="adm-tip">${esc(t)}</div>`).join("") : ""}
    ${last ? `<details class="adm-acc"><summary>최근 분석 · ${esc(ovTime(last.created_at))}</summary><div class="adm-use-text" style="padding:4px 14px 14px">${esc(last.report?.summary || "")}</div></details>` : ""}
    <div class="adm-label">새 제안${drafts.length ? ` ${drafts.length}` : ""}</div>
    ${drafts.map(card).join("") || '<div class="adm-empty">새 제안이 없어요. 밤 10시 분석 뒤에 올라와요.</div>'}
    ${going.length ? `<div class="adm-label">진행 중 ${going.length}</div>${going.map(card).join("")}` : ""}
    <div class="adm-label">계획</div>
    ${plansHtml(plans, tasks)}
    <details class="adm-acc"><summary>직접 맡기기</summary><form class="adm-plan-add" data-devadd style="padding:0 14px 14px"><input type="text" maxlength="200" placeholder="Claude 에게 맡길 일 (초안으로 만들어요)" aria-label="제작 맡기기"><button class="study-btn small" type="submit">추가</button></form></details>
    ${done.length ? `<details class="adm-acc"><summary>끝난 것 (반영 · 버림)<span>${done.length}</span></summary>${done.map(card).join("")}</details>` : ""}
    <div class="adm-foot">승인하면 관리자 노트북의 Claude 가 10분 안에 따로 브랜치에서 만들고(노트북이 켜져 있어야 해요) 미리보기 알림을 보내요. 미리보기를 보고 '수정 요청'하거나 '최종 승인'하면 beta 에 올라가요. DB · 서버 함수를 바꾸는 일은 '사람 손 필요'로 멈춰요. 미리보기가 괜찮으면 최종 승인하고, 합친 뒤 그 변경(SQL 실행 · 함수 배포)은 사람이 적용해요.</div>`;
}

function bindDev(body, tasks, showPane) {
  const set = async (id, patch, msg) => {
    const { error } = await sb.from("agent_tasks").update(patch).eq("id", id);
    if (error) return toast("저장하지 못했어요", true);
    if (msg) toast(msg);
    renderOverview();
  };
  const val = (sel) => body.querySelector(sel)?.value.trim() ?? "";
  const draft = (id) => ({ title: val(`[data-devtitle="${id}"]`) || tasks.find((t) => t.id === id)?.title, spec: val(`[data-devspec="${id}"]`) });
  const on = (attr, fn) => body.querySelectorAll(`[data-${attr}]`).forEach((b) => b.onclick = () => fn(b.dataset[attr], b));
  on("devsave", (id) => set(id, draft(id), "저장했어요"));
  on("devgo", (id) => {
    const d = draft(id);
    if (!d.spec) return toast("맡길 내용을 적어 주세요", true);
    if (confirm("이 제안을 승인할까요? 노트북의 Claude 가 만들기 시작해요.")) set(id, { ...d, status: "approved" }, "승인했어요. 다 되면 알림이 와요");
  });
  on("devfix", (id) => {
    const note = val(`[data-devnote="${id}"]`);
    if (!note) return toast("고칠 점을 적어 주세요", true);
    set(id, { status: "revise", note }, "수정을 요청했어요");
  });
  on("devok", (id) => {
    const t = tasks.find((x) => x.id === id);
    const human = t?.status === "needs_human" ? "\n\n합친 뒤 DB · 서버 함수 변경은 사람이 직접 적용(SQL 실행 · 함수 배포)해야 실제로 반영돼요." : "";
    if (confirm(`최종 승인할까요? main 에 합쳐 beta 사이트에 올라가요.${human}`)) set(id, { status: "accepted" }, "최종 승인했어요");
  });
  on("devdraft", (id) => set(id, { status: "draft", error: null }));
  on("devdrop", (id) => { if (confirm("이 제작을 버릴까요?")) set(id, { status: "rejected" }, "버렸어요"); });
  const add = async (row) => {
    const { error } = await sb.from("agent_tasks").insert(row);
    if (error) return toast("추가하지 못했어요", true);
    showPane("dev");
    renderOverview();
  };
  body.querySelectorAll("[data-devadd]").forEach((f) => f.onsubmit = (e) => {
    e.preventDefault();
    const title = f.querySelector("input").value.trim();
    if (title) add({ title, spec: "" });
  });
  return add;
}

// ---------- 승인 칸: 같은 수행평가 합치기 제안 · 처리 기록 ----------
// merge-suggest 서버 함수가 매일 0 · 8 · 12 · 16 · 20시에 같은 과목 · 다른 분반 · 비슷한 이름의 수행평가를 찾아 merge_suggestions 에 남깁니다 (merge.sql).
// 마감이 같으면 이름을 고쳐 전체 분반 공지로 합치고(merge_assignments), 마감이 다르면 확인만 합니다(dismiss_merge).
// 처리 기록: 승인 · 반려한 수행평가(누가 · 언제)와 합치기 · 확인 기록. 누르면 그 수행평가를 고치거나 지울 수 있어요.
let logRows = [];
async function loadReviewLog() {
  const [sug, done] = await Promise.all([
    sb.from("merge_suggestions").select("*").order("created_at", { ascending: false }).limit(100),
    sb.from("assignments").select("id, subject, ban, title, body, due_at, submit_to, status, created_at, created_by, reviewed_by, reviewed_at, author_name, merged_from")
      .neq("status", "pending").order("reviewed_at", { ascending: false, nullsFirst: false }).limit(300),
  ]);
  // 이 기수 과목만. merge.sql 을 아직 실행하지 않았으면 제안 없이
  const rows = (done.data || []).filter(asgInCohort), sugs = sug.error ? [] : sug.data.filter(asgInCohort);
  const ids = [...new Set([...rows.map((a) => a.reviewed_by), ...sugs.map((x) => x.resolved_by)].filter(Boolean))];
  const { data: who } = ids.length ? await sb.from("profiles").select("id, name").in("id", ids) : { data: [] };
  return {
    open: sugs.filter((x) => x.status === "open"),
    resolved: sugs.filter((x) => x.status !== "open"),
    reviewed: done.error ? null : rows,
    nameOf: Object.fromEntries((who || []).map((p) => [p.id, p.name])),
  };
}

const shortDue = (iso) => (iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "마감 없음");
// 그 과목의 분반 중 이 묶음에 없는 분반 (합치면 그 분반에도 보이게 됨)
function missingBans(subject, items) {
  const have = new Set(items.map((a) => a.ban));
  return [...new Set(allClassList().filter((c) => c.subject === subject && c.ban).map((c) => c.ban))]
    .filter((b) => !have.has(b)).sort((a, b) => a.localeCompare(b, "ko"));
}

function mergeHtml(log) {
  if (!log?.open.length) return "";
  const same = log.open.filter((x) => x.kind === "same"), diff = log.open.filter((x) => x.kind === "diff_due");
  const rows = (x, showDue) => x.items.map((a) => `<li><b>${esc(a.ban || "전체")}</b> ${esc(a.title)}${showDue ? ` <span class="adm-merge-due">${esc(shortDue(a.due_at))}</span>` : ""}${a.status === "pending" ? ' <span class="st-badge pending">대기</span>' : ""}</li>`).join("");
  const sameHtml = same.map((x) => {
    const miss = missingBans(x.subject, x.items);
    return `<div class="adm-fb adm-merge new">
      <div class="adm-fb-top"><span class="adm-chip hot">합치기 제안</span><span class="adm-chip">${esc(x.subject)}</span></div>
      <div class="adm-fb-text">${esc(x.items.map((a) => a.ban).join(" · "))}에 이런 이름의 수행평가가 같은 마감(${esc(shortDue(x.items[0].due_at))})으로 올라와 있어요.</div>
      <ul class="adm-merge-list">${rows(x, false)}</ul>
      <div class="adm-fb-text">아래 이름으로 <b>전체 분반 공지</b> 하나로 합칠까요? 원래 공지는 지워지고, 완료 체크와 댓글은 새 공지로 옮겨져요.</div>
      ${miss.length ? `<div class="adm-merge-warn">${esc(miss.join(" · "))}에는 없던 공지라, 합치면 ${esc(miss.join(" · "))}에도 보여요.</div>` : ""}
      <input class="adm-merge-title" type="text" maxlength="120" value="${esc(x.title)}" data-mtitle="${x.id}" aria-label="합칠 공지 이름">
      <div class="asg-actions">
        <button class="study-btn small ok" data-merge="${x.id}">전체 분반 공지로 합치기</button>
        <button class="study-btn small" data-mskip="${x.id}">합치지 않기</button>
      </div>
    </div>`;
  }).join("");
  const diffHtml = diff.map((x) => `<div class="adm-fb adm-merge">
      <div class="adm-fb-top"><span class="adm-chip">${esc(x.subject)}</span><span class="adm-chip">마감이 달라요</span></div>
      <ul class="adm-merge-list">${rows(x, true)}</ul>
      <div class="asg-actions"><button class="study-btn small" data-mskip="${x.id}">확인</button></div>
    </div>`).join("");
  return (same.length ? `<div class="adm-label">같은 수행평가 합치기 ${same.length}</div>${sameHtml}` : "")
    + (diff.length ? `<details class="adm-acc adm-merge-acc"${same.length ? "" : " open"}><summary>이름은 같은데 마감이 분반마다 달라요<span>${diff.length}</span></summary>
        <p>분반마다 수업 날이 달라 마감이 다른 경우가 많아요. 공지가 맞는지만 보고 확인을 눌러 주세요.</p>${diffHtml}</details>` : "");
}

function reviewLogHtml(log) {
  if (!log) return "";
  const who = (id) => log.nameOf[id] || "관리자";
  const items = [
    ...(log.reviewed || []).map((a) => ({
      at: a.reviewed_at || a.created_at,
      html: `<div class="adm-log-row click" data-logasg="${a.id}" title="눌러서 고치거나 지우기">
        <div><b>${esc(a.subject)} · ${esc(banLabel(a.ban))}</b> ${esc(a.title)}${a.status === "rejected" ? ' <span class="st-badge rejected">반려됨</span>' : ""}</div>
        <div class="adm-log-sub">${a.merged_from ? `${esc(a.merged_from.map((m) => m.ban).join(" · "))} → 전체 분반으로 합침 · ${esc(who(a.reviewed_by))}`
          : a.reviewed_by ? `${esc(who(a.reviewed_by))} ${a.status === "rejected" ? "반려" : "승인"}` : `${esc(a.author_name || "관리자")} 작성`} · ${esc(ovTime(a.reviewed_at || a.created_at))} · ${esc(shortDue(a.due_at))}</div>
      </div>`,
    })),
    ...log.resolved.filter((x) => x.status === "dismissed").map((x) => ({
      at: x.resolved_at,
      html: `<div class="adm-log-row">
        <div><b>${esc(x.subject)}</b> ${esc(x.title)} <span class="adm-chip">${x.kind === "same" ? "합치지 않음" : "마감 다름 확인"}</span></div>
        <div class="adm-log-sub">${esc(x.items.map((a) => a.ban).join(" · "))} · ${esc(who(x.resolved_by))} · ${esc(ovTime(x.resolved_at))}</div>
      </div>`,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return `<details class="adm-acc"${logOpen ? " open" : ""} id="logAcc"><summary>처리 기록 · 승인한 수행평가 전체<span>${log.reviewed ? items.length : "불러오지 못함"}</span></summary>
    ${items.map((x) => x.html).join("") || '<div class="adm-none">아직 처리한 수행평가가 없어요.</div>'}
    <div class="adm-foot">수행평가를 누르면 고치거나 지울 수 있어요.</div></details>`;
}
let logOpen = false;   // 처리 기록을 펼쳐 둔 채 고치면 다시 그려도 펼쳐 둡니다

function bindMerge(body) {
  body.querySelectorAll("[data-merge]").forEach((b) => b.onclick = async () => {
    const title = body.querySelector(`[data-mtitle="${b.dataset.merge}"]`).value.trim();
    if (!title) return toast("이름을 적어 주세요", true);
    if (!confirm(`'${title}' 전체 분반 공지 하나로 합칠까요? 원래 분반 공지는 지워져요.`)) return;
    b.disabled = true;
    const { error } = await sb.rpc("merge_assignments", { p_id: b.dataset.merge, p_title: title });
    if (error) { b.disabled = false; return toast(error.message?.match(/[가-힣]/) ? error.message : "합치지 못했어요", true); }
    toast("전체 분반 공지로 합쳤어요");
    await refresh();
  });
  body.querySelectorAll("[data-mskip]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.rpc("dismiss_merge", { p_id: b.dataset.mskip });
    if (error) { b.disabled = false; return toast("처리하지 못했어요", true); }
    await refresh();
  });
}

// 개발 소식 (devnews.sql · supabase/functions/dev-news): push 할 때 DEVLOG 요약기가 남긴 소식. 표가 없으면 칸을 숨김
function devNewsHtml(news) {
  if (!news) return "";
  const day = (n) => n.day ? dayTitle(n.day) : ovTime(n.updated_at);
  return `<div class="adm-label">개발 소식</div>
    <div class="adm-uses">${news.length ? news.map((n, i) => `<details class="adm-use"${i < 3 ? " open" : ""}>
      <summary style="grid-template-columns:minmax(0,1fr) auto"><span class="adm-use-l"><b>${esc(n.dev || "?")}</b> · ${esc(n.title || "개발")}</span><span class="adm-use-n"><small>${esc(day(n))}</small></span></summary>
      <p>${n.news.split(" | ").map((l) => `• ${esc(l)}`).join("<br>")}</p>
    </details>`).join("") : '<div class="adm-none">아직 소식이 없어요. push 하면 10분 안에 생겨요.</div>'}</div>`;
}

// 할 일 함께하기 승인 (todoshare.sql). 반민지 · 진주빈 말고 다른 학생이 할 일에 친구를 넣으면 여기서 승인해야 공유됩니다.
const sidName = (sid) => roster().find((p) => p.sid === sid)?.name || String(sid);
function todoShareHtml(list) {
  if (!list) return "";
  return `<div class="adm-label">할 일 공유 승인${list.length ? ` ${list.length}` : ""}</div>`
    + (list.length ? list.map((r) => {
      const d = r.due_on ? parseDay(r.due_on) : null;
      return `<div class="asg-card">
        <div class="asg-top"><span class="asg-subject">${esc(r.owner_name || "학생")}${r.owner_sid ? ` (${r.owner_sid})` : ""} · 할 일 공유</span></div>
        <div class="asg-title">${esc(r.title)}</div>
        <div class="asg-due"><span>${d ? `${md(d)}까지` : "기한 없음"}</span><span class="asg-by">${esc(new Date(r.asked_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))} 요청</span></div>
        <div class="asg-due">공유할 친구 ${r.sids.length}명: ${esc(r.sids.map(sidName).join(", "))}</div>
        <div class="asg-actions">
          <button class="study-btn small ok" data-tsok="${r.todo_id}">승인</button>
          <button class="study-btn small no" data-tsno="${r.todo_id}">반려</button>
        </div>
      </div>`;
    }).join("") : '<div class="adm-empty">승인 대기 중인 할 일 공유가 없어요.</div>');
}
async function reviewTodoShare(id, ok) {
  const { error } = await sb.rpc("review_todo_share", { p_todo: id, p_ok: ok });
  if (error) return toast("처리하지 못했어요", true);
  toast(ok ? "승인했어요. 친구들 할 일 목록에 생겨요" : "반려했어요");
  await refresh();
}

function manageHtml(pending, fb, fbSeen, overview, ovSeenAt, pane, visits, log, usage, tasks, plans, news, funnel, tshares) {
  const rows = fb.rows || [];
  // 새로 온 피드백 + 지난 피드백에 학생이 새로 단 답글
  const isFresh = (f) => Date.parse(f.created_at) > fbSeen
    || (fb.replies || []).some((r) => r.feedback_id === f.id && fbByStudent(r) && Date.parse(r.created_at) > fbSeen);
  const fresh = rows.filter(isFresh);
  const old = rows.filter((f) => !isFresh(f));
  const fbHtml = (list, isNew) => list.map((f) => feedbackItemHtml(f, fb.nameOf.get(f.user_id), fb.urlOf.get(f.image_path), isNew,
    (fb.replies || []).filter((r) => r.feedback_id === f.id), fb.nameOf)).join("");
  const nAsg = pending.length + (log?.open.length || 0) + (tshares?.length || 0), nDev = tasks?.filter((t) => DEV_HOT.has(t.status)).length ?? 0;
  navStat = { asg: { v: nAsg + fresh.length, hot: nAsg + fresh.length > 0 }, stu: { v: overview?.students.length ?? "-" },
    dev: { v: nDev, hot: nDev > 0 } };
  const box = (k, html) => `<div class="adm-pane" data-pane="${k}"${pane === k ? "" : " hidden"}>${html}</div>`;
  return `
    ${box("asg", `<div class="adm-bar"><span>수행평가 승인 · 학생 피드백</span><button class="study-btn primary small" id="btnAsg">+ 수행평가 공지 올리기</button></div>`
      + mergeHtml(log)
      + `<div class="adm-label">승인 대기${pending.length ? ` ${pending.length}` : ""}</div>`
      + (pending.length ? pending.map(card).join("") : '<div class="adm-empty">승인 대기 중인 수행평가가 없어요.</div>')
      + todoShareHtml(tshares)
      + `<div class="adm-label" id="fbSec">새 피드백${fresh.length ? ` ${fresh.length}` : ""}</div>`
      + (fb.error ? '<div class="adm-empty">피드백을 불러오지 못했어요.</div>'
        : fresh.length ? fbHtml(fresh, true) : '<div class="adm-empty">새 피드백이 없어요.</div>')
      + reviewLogHtml(log)
      + (old.length ? `<details class="adm-acc"><summary>지난 피드백<span>${old.length}</span></summary>${fbHtml(old, false)}</details>` : ""))}
    ${box("stu", visitsHtml(visits) + loginFunnelHtml(funnel) + '<div class="adm-label">학생 현황</div>' + (overview ? studentsHtml(overview, ovSeenAt) : '<div class="adm-none">학생 현황을 불러오지 못했어요.</div>'))}
    ${box("dev", devNewsHtml(news) + devHtml(tasks, usage, plans, overview))}`;
}

let ovSeen, fbSeen, ovPane, ovShow;   // 처음 열 때 읽은 "지난번 본 시각"과 고른 칸 (승인 뒤 다시 그려도 유지)
// 관리 화면 칸: 처리(asg: 승인 + 피드백) · 학생(stu) · 제안(dev: 제작 · 계획). 운영 점검 · 사용 분석 보고서는 화면에 두지 않고,
// 점검은 문제가 있을 때만 푸시, 분석은 '제안' 칸의 초안이 됩니다. 예전 알림 주소(?pane=ops · use · push · plan · fb)는 가까운 칸으로 엽니다.
const PANE_ALIAS = { fb: "asg", ops: "asg", push: "asg", use: "dev", plan: "dev" };
const OV_GROUP = { asg: "asg", stu: "stu", dev: "dev" };
const ovSubLast = { asg: "asg", stu: "stu", dev: "dev" };
let ovLast = null;
// cached: 탭을 눌러 들어온 경우 앞서 받은 관리 화면을 먼저 그리고 새로 받습니다
async function renderOverview(cached = false) {
  if (ovSeen === undefined) {
    ovSeen = Infinity;
    try { ovSeen = Date.parse(localStorage.getItem(OV_SEEN_KEY)) || Infinity; } catch {}
    fbSeen = Date.parse(fbSeenAt());
    // 알림을 누르고 들어오면 그 칸부터 (?view=admin&pane=dev 등)
    const want = new URLSearchParams(location.search).get("pane");
    ovPane = OV_GROUP[want] ? want : PANE_ALIAS[want] || null;
  }
  if (cached && ovLast) paintOverview(ovLast);
  const [res] = await Promise.all([Promise.all([sb.rpc("admin_overview"), loadFeedback(),
    cohortRpc("admin_visits", { p_days: 7 }), loadReviewLog(),
    sb.from("usage_reports").select("id, created_at, report").order("created_at", { ascending: false }).limit(1),
    sb.from("agent_tasks").select("*").order("created_at", { ascending: false }).limit(60),
    sb.from("admin_plans").select("*").order("created_at", { ascending: true }),
    sb.from("dev_news").select("*").order("updated_at", { ascending: false }).limit(15),
    cohortRpc("admin_login_funnel", { p_days: 14 }),
    sb.rpc("admin_todo_shares")]), loadPending()]);   // 할 일 공유 승인 대기 (todoshare.sql)
  // 학생 현황 · 오늘 로그인한 학생은 이 기수 학생만. 방문 기기 수 · 로그인 이탈은 서버가 기수(p_cohort)로 나눠 줍니다
  if (res[0]?.data) res[0] = { ...res[0], data: cohortOverview(res[0].data) };
  if (res[2]?.data?.today_users) res[2] = { ...res[2], data: { ...res[2].data, today_users: res[2].data.today_users.filter((u) => sidInCohort(u.student_id)) } };
  setDbRoster(res[0]?.data);
  const sig = JSON.stringify([res, cache.pending]);
  if (cached && ovLast && sig === ovLast.sig) return;   // 먼저 그린 것과 같으면 그대로
  ovLast = Object.assign(res, { sig });
  paintOverview(res);
}
function paintOverview(res) {
  const [{ data, error }, fb, visits, log, usage, tasks, plans, news, funnel, tshare] = res;
  // 이 기수 학생이 요청한 것만. 표가 아직 없으면(error) 칸을 숨깁니다
  const tshares = !tshare || tshare.error ? null : (tshare.data || []).filter((r) => !r.owner_sid || sidInCohort(r.owner_sid));
  const body = $("studyBody");
  if (page !== "admin" || !body) return;   // 그사이 다른 탭으로 옮겼으면 그리지 않습니다
  const pending = cache.pending || [];
  logRows = log?.reviewed || [];
  // 처음에는 처리할 일이 있는 칸을 엽니다
  if (!OV_GROUP[ovPane]) ovPane = "asg";
  body.innerHTML = manageHtml(pending, fb, fbSeen, error ? null : data, ovSeen, ovPane, visits.error ? null : visits.data, log, usage.error ? null : usage.data, tasks.error ? null : tasks.data, plans.error ? null : plans.data, !news || news.error ? null : news.data, !funnel || funnel.error ? null : funnel.data, tshares);
  const showPane = (k) => {
    if (k === "fb") { showPane("asg"); return $("fbSec")?.scrollIntoView({ behavior: "smooth", block: "start" }); }
    k = OV_GROUP[k] ? k : PANE_ALIAS[k] || "asg";
    ovPane = k;
    $("studyNav").querySelectorAll("[data-nav]").forEach((x) => x.classList.toggle("on", x.dataset.nav === k));
    body.querySelectorAll("[data-pane]").forEach((x) => { x.hidden = x.dataset.pane !== k; });
  };
  body.querySelectorAll("[data-ovpane]").forEach((b) => b.onclick = () => showPane(b.dataset.ovpane));
  ovShow = showPane;
  // 학생을 누르면 학교 일정 달력을 그 학생 기준으로
  body.querySelectorAll("[data-stucal]").forEach((r) => r.onclick = () => {
    calStudent = +r.dataset.stucal;
    calMonth = null;
    schPref.view = "cal";
    openPage("school");
  });
  renderNav();
  if ($("btnAsg")) $("btnAsg").onclick = () => openAsgForm(null);
  body.querySelectorAll("[data-gopane]").forEach((b) => b.onclick = () => { showPane(b.dataset.gopane); scrollTo({ top: 0, behavior: "smooth" }); });
  const pend = (id) => pending.find((a) => a.id === id);
  body.querySelectorAll("[data-ok]").forEach((b) => b.onclick = () => review(b.dataset.ok, "approved"));
  body.querySelectorAll("[data-no]").forEach((b) => b.onclick = () => review(b.dataset.no, "rejected"));
  body.querySelectorAll("[data-tsok]").forEach((b) => b.onclick = () => reviewTodoShare(b.dataset.tsok, true));
  body.querySelectorAll("[data-tsno]").forEach((b) => b.onclick = () => reviewTodoShare(b.dataset.tsno, false));
  body.querySelectorAll("[data-aedit]").forEach((b) => b.onclick = () => openAsgForm(pend(b.dataset.aedit)));
  body.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => removeAsg(pend(b.dataset.del)));
  body.querySelectorAll("[data-logasg]").forEach((r) => r.onclick = () => openAsgForm(logRows.find((a) => a.id === r.dataset.logasg)));
  const acc = $("logAcc");
  if (acc) acc.ontoggle = () => { logOpen = acc.open; };
  bindMerge(body);
  body.querySelectorAll("[data-fbdel]").forEach((x) => x.onclick = () => deleteFeedback(fb.rows.find((r) => r.id === x.dataset.fbdel)));
  bindReplies(body);
  bindPlans(body, plans.data || [], bindDev(body, tasks.data || [], showPane));
  // 본 데까지: 가장 최근 피드백과 학생 답글 중 늦은 쪽
  const fbLatest = [fb.rows?.[0]?.created_at, ...(fb.replies || []).filter(fbByStudent).map((r) => r.created_at)]
    .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (fbLatest) { try { localStorage.setItem(FB_SEEN_KEY, fbLatest); } catch {} }
  if (data?.activity[0]) { try { localStorage.setItem(OV_SEEN_KEY, data.activity[0].at); } catch {} }
  refreshAdminCount();
}


// 피드백 답장 쓰기 · 지우기 (feedbackreply.sql). 보내면 학생의 피드백 창에 보이고, send-reminders 가 1분 안에 그 학생에게 알립니다.
// 한 피드백에 여러 번 답장할 수 있고, 학생이 다시 답하면 '새 답글'로 올라옵니다.
function bindReplies(body) {
  const boxOf = (id) => body.querySelector(`[data-rebox="${id}"]`);
  body.querySelectorAll("[data-reopen]").forEach((b) => b.onclick = () => {
    const box = boxOf(b.dataset.reopen);
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector("textarea").focus();
  });
  body.querySelectorAll("[data-recancel]").forEach((b) => b.onclick = () => { boxOf(b.dataset.recancel).hidden = true; });
  body.querySelectorAll("[data-resend]").forEach((b) => b.onclick = async () => {
    const text = boxOf(b.dataset.resend).querySelector("textarea").value.trim();
    if (!text) return toast("답장 내용을 적어 주세요", true);
    b.disabled = true;
    const { error } = await sb.from("feedback_replies").insert({ feedback_id: b.dataset.resend, body: text, created_by: me.id });
    if (error) {
      b.disabled = false;
      return toast(/feedback_replies|schema cache|does not exist/.test(error.message || "") ? "feedbackreply.sql 을 먼저 실행해야 해요" : "답장을 보내지 못했어요", true);
    }
    toast("답장을 보냈어요");
    renderOverview();
  });
  body.querySelectorAll("[data-redel]").forEach((b) => b.onclick = async () => {
    if (!confirm("이 답장을 지울까요? 학생 화면에서도 사라져요.")) return;
    const { error } = await sb.from("feedback_replies").delete().eq("id", b.dataset.redel);
    if (error) return toast("지우지 못했어요", true);
    toast("답장을 지웠어요");
    renderOverview();
  });
}

async function deleteFeedback(f) {
  if (!confirm("이 피드백을 삭제할까요? 단 답장도 함께 지워져요.")) return;
  const { error } = await sb.from("feedback").delete().eq("id", f.id);
  if (error) return toast("삭제하지 못했어요", true);
  if (f.image_path) await sb.storage.from("feedback").remove([f.image_path]);
  toast("삭제했어요");
  renderOverview();
}

// ============================================================
// 학교 일정 탭
// 학생 달력에 보이는 학교 일정 = 관리자가 만든 일정(school_events) + 학교 홈페이지 학사일정(NEIS · academic.json).
// academic.json 은 매일 덮어써지므로, 고친 NEIS 일정은 school_events 에 neis_key("시작일|이름|대상학년")로 저장해 원본 대신 보여 줍니다.
// ============================================================
const ACAD_CATS = [
  ["home", "귀가일", "귀가일"],
  ["exam", "시험", "1·2차 지필평가"],
  ["break", "방학·개학", "방학식 · 개학식 · 방학 기간"],
  ["holiday", "공휴일·휴업일", "공휴일 · 재량휴업일"],
  ["club", "동아리·꿈지락", "학술동아리 · 문화예술동아리 · 꿈지락"],
  ["event", "학교 행사", "입학식 · 졸업식 · 체육대회 · 여명제 등"],
];
const catLabel = (k) => ACAD_CATS.find(([c]) => c === k)?.[1] || "";
// 종류 분류는 학생 사이트(dshs-study.js 의 acadCat)와 같게 둡니다
function acadCat(e) {
  if (/귀가|귀사/.test(e.name)) return "home";
  if (/지필|고사|시험/.test(e.name)) return "exam";
  if (/방학|개학|종업/.test(e.name)) return "break";
  if (e.type === "공휴일" || e.type === "휴업일") return "holiday";
  if (/동아리|꿈지락/.test(e.name)) return "club";
  return "event";
}
// 학사일정은 GitHub Actions 가 매일 beta 저장소의 academic.json 을 고칩니다. 그 최신본을 먼저 받고(_headers 로 허락),
// 못 받으면 이 사이트를 묶을 때 함께 넣은 복사본을 씁니다.
// 기수마다 그 학생 사이트의 academic.json (cohort.js 의 academicUrl)
const ACADEMIC_SRC = COHORT.academicUrl || CFG.ACADEMIC_URL || "https://dshs42-beta.netlify.app/academic.json";
let acadList = null;
async function loadAcademic() {
  if (acadList) return;
  try {
    const res = await fetch(ACADEMIC_SRC, { cache: "no-cache" }).then((r) => (r.ok ? r : Promise.reject()))
      .catch(() => fetch("academic.json", { cache: "no-cache" }));
    acadList = (await res.json()).events.map((e, i) => ({
      ...e, id: String(i), cat: acadCat(e),
      key: `${e.start}|${e.name}|${e.grades.join("")}`,   // 고친 내용을 잇는 값. 줄 번호는 매일 바뀔 수 있어서 내용으로 만듭니다
    }));
  } catch { acadList = []; }
}
async function loadSchool() {
  const { data, error } = await sb.from("school_events").select("*, school_event_targets(student_id)").order("starts_at", { ascending: true });
  if (error) { toast("학교 일정을 불러오지 못했어요", true); return false; }
  // 특정 인원에게만 보이는 일정은 대상에 이 기수 학생이 있을 때만. '전체' 일정은 모든 기수 학생 달력에 함께 보입니다
  cache.school = data.filter((e) => e.audience !== "some" || !(e.school_event_targets || []).length
    || e.school_event_targets.some((t) => sidInCohort(t.student_id)));
  return true;
}

// 관리자가 NEIS 일정을 처음 고칠 때 쓰는 초안 (학교 일정 폼이 그대로 받습니다). 저장하기 전에는 DB 에 없습니다.
function neisDraft(a) {
  return {
    id: null, title: a.name, memo: a.memo || "", all_day: true, notify: false, audience: "all", hidden: false,
    starts_at: parseDay(a.start).toISOString(), ends_at: a.end > a.start ? new Date(`${a.end}T23:59`).toISOString() : null,
    no_class: a.type === "공휴일" || a.type === "휴업일" || a.name.includes("지필평가"),
    category: a.cat, neis_key: a.key, school_event_targets: [],
  };
}

const schoolTargets = (e) => (e.school_event_targets || []).map((t) => t.student_id);
const SCH_PREF = KEYS.school;
let schPref = (() => { try { return { past: false, grades: false, ...JSON.parse(localStorage.getItem(SCH_PREF) || "{}") }; } catch { return { past: false, grades: false }; } })();

async function renderSchool() {
  const cal = schPref.view === "cal";
  const [ok] = await Promise.all([loadSchool(), loadAcademic(), cal ? loadCalAsg() : null, loadDbRoster()]);
  const body = $("studyBody");
  if (page !== "school" || !body) return;
  if (!ok) { body.innerHTML = '<div class="adm-none">학교 일정을 불러오지 못했어요.</div>'; return; }
  if (cal) return renderSchoolCal(body);
  const today = dayKey(new Date());
  const g = String(GRADE);
  const replaced = new Set(cache.school.map((x) => x.neis_key).filter(Boolean));
  const items = [
    ...cache.school.map((e) => {
      const s = new Date(e.starts_at), en = e.ends_at ? new Date(e.ends_at) : s;
      return { kind: "sch", e, id: e.id, start: dayKey(s), end: dayKey(en), at: s, title: e.title, grades: e.neis_key ? e.neis_key.split("|").pop() : null };
    }),
    ...(acadList || []).filter((a) => a.name !== "토요휴업일" && !replaced.has(a.key)).map((a) => ({
      kind: "acad", a, id: a.id, start: a.start, end: a.end, at: parseDay(a.start), title: a.name, grades: a.grades.join(""),
    })),
  ].filter((it) => (schPref.past || it.end >= today) && (schPref.grades || !it.grades || it.grades.includes(g)))
    .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.at - y.at));

  const months = new Map();
  for (const it of items) {
    const k = it.start.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(it);
  }
  const wd = (key) => parseDay(key).toLocaleDateString("ko-KR", { weekday: "short" });
  const dateLabel = (it) => {
    const d = `${md(parseDay(it.start))} (${wd(it.start)})`;
    if (it.end !== it.start) return `${d}<br>– ${md(parseDay(it.end))} (${wd(it.end)})`;
    if (it.kind === "sch" && !it.e.all_day) return `${d}<br>${hm(new Date(it.e.starts_at))}`;
    return d;
  };
  const gradeChip = (it) => it.grades && it.grades.length < 3 ? `<span class="adm-chip">${it.grades.split("").join("·")}학년</span>` : "";
  const rowHtml = (it) => {
    const chips = it.kind === "acad"
      ? [`<span class="adm-chip">${catLabel(it.a.cat)}</span>`, '<span class="adm-chip">NEIS</span>', gradeChip(it)]
      : [`<span class="adm-chip">${catLabel(it.e.category)}</span>`,
         it.e.neis_key ? '<span class="adm-chip">NEIS 고침</span>' : '<span class="adm-chip">직접 추가</span>',
         it.e.hidden ? '<span class="adm-chip hot">숨김</span>' : "",
         it.e.no_class ? '<span class="adm-chip">수업 없음</span>' : "",
         it.e.notify ? '<span class="adm-chip">필수 · 알림</span>' : "",
         it.e.audience === "some" ? `<span class="adm-chip">${schoolTargets(it.e).length}명 대상</span>` : "",
         gradeChip(it)];
    return `<button class="sch-row${it.kind === "sch" && it.e.hidden ? " hidden-ev" : ""}" data-sopen="${it.kind}:${it.id}">
      <span class="sch-date">${dateLabel(it)}</span>
      <span class="sch-main"><span class="sch-title">${esc(it.title)}</span><span class="sch-chips">${chips.join("")}</span></span>
    </button>`;
  };
  body.innerHTML = `${schViewSeg()}<div class="sch-tools">
      <label><input type="checkbox" id="schPast"${schPref.past ? " checked" : ""}> 지난 일정도 보기</label>
      <label><input type="checkbox" id="schGrades"${schPref.grades ? " checked" : ""}> 다른 학년 일정도 보기</label>
      <span>${items.length}개</span>
    </div>
    ${[...months].map(([k, list]) => `<div class="sch-month">${+k.slice(0, 4)}년 ${+k.slice(5)}월</div>${list.map(rowHtml).join("")}`).join("")
      || '<div class="adm-none">보여 줄 학교 일정이 없어요.</div>'}
    <div class="adm-foot">NEIS 는 학교 홈페이지 학사일정이에요 (매일 자동으로 받아 와요). 여기서 고치거나 숨기면 이 사이트의 학생 달력에만 반영되고 원본은 그대로예요.
      학생 달력에는 ${GRADE}학년 일정만 보여요. 숨긴 일정은 흐리게 남아 있어 눌러서 되돌릴 수 있어요.</div>`;
  bindSchView(body);
  $("schPast").onchange = () => { schPref.past = $("schPast").checked; saveSchPref(); renderSchool(); };
  $("schGrades").onchange = () => { schPref.grades = $("schGrades").checked; saveSchPref(); renderSchool(); };
  body.querySelectorAll("[data-sopen]").forEach((b) => b.onclick = () => {
    const [kind, id] = b.dataset.sopen.split(":");
    if (kind === "sch") openSchoolForm(cache.school.find((x) => x.id === id));
    else openSchoolForm(neisDraft(acadList.find((x) => x.id === id)));
  });
}

// ---------- 학교 일정 달력 ----------
// 학교 일정(직접 추가 · NEIS) + 수행평가(마감일)를 달 단위로 봅니다. 날짜를 누르면 그날 목록과 '+ 학교 일정 / + 수행평가'.
// 학생을 고르면 그 학생 달력에 보이는 공용 일정만 남깁니다: 대상에 든 학교 일정 · 그 학년 NEIS · 듣는 과목 분반의 수행평가 (+ 완료 표시).
// 개인 일정 · 할 일은 보여 주지 않습니다 (본인만 보는 내용).
let calAsg = [];
let calStudent = null;      // 고른 학생 학번 (없으면 전체)
let calDone = new Set();    // 고른 학생이 완료 표시한 수행평가 id (admin_student_done)
let calMonth = null;        // "YYYY-MM"
let calBusy = [];           // 고른 학생의 개인 일정 시각만 (admin_student_busy, 제목 · 메모는 받지 않음)
let calStats = null;
let calOvStudents = null;   // admin_overview 의 학생 목록 (학생을 바꿀 때마다 다시 받지 않게 한 번만)        // 고른 학생이 직접 추가한 일정 · 할 일 수 (admin_overview 의 students 한 줄, 내용은 받지 않음)
async function loadCalAsg() {
  const { data, error } = await sb.from("assignments")
    .select("id, subject, ban, title, body, due_at, submit_to, status, created_at, created_by, author_name")
    .neq("status", "rejected").not("due_at", "is", null).order("due_at");
  if (!error) calAsg = data.filter(asgInCohort);   // 이 기수 과목만
  calDone = new Set();
  calStats = null;
  calBusy = [];
  if (calStudent) {
    calOvStudents ||= ovLast?.[0]?.data?.students || null;
    const [{ data: done }, busy, ov] = await Promise.all([
      sb.rpc("admin_student_done", { p_student_id: calStudent }),
      sb.rpc("admin_student_busy", { p_student_id: calStudent }),
      calOvStudents ? null : sb.rpc("admin_overview"),
    ]);
    if (ov && !ov.error) calOvStudents = cohortOverview(ov.data)?.students || [];
    calDone = new Set(done || []);
    calBusy = busy.data || [];
    calStats = !calOvStudents ? null : calOvStudents.find((s) => s.student_id === calStudent) || false;   // false = 가입 전
  }
}
const BUSY_OWN = "#8888aa", BUSY_SHARED = "#3fb6a8";   // 흐린 개인 일정 칸: 직접 만든 일정 · 친구가 넣어 준 일정
const CAT_COLOR = { home: "#4caf7d", exam: "#ff6b6d", break: "#5aa9ff", holiday: "#f0a43a", club: "#b58cff", event: "#8888aa" };

// 그 학생에게 보이는 일정인지
function calVisible(it, stu) {
  if (!stu || it.kind === "busy") return true;   // 흐린 개인 일정 칸은 이미 그 학생 것만 받음
  if (it.kind === "asg") {
    const ban = stu.classes[it.a.subject];
    return ban !== undefined && (!it.a.ban || it.a.ban === ban);
  }
  if (it.kind === "acad") return !it.grades || it.grades.includes(String(Math.floor(stu.sid / 1000)));
  if (it.e.hidden) return false;
  if (it.e.audience === "some") return schoolTargets(it.e).includes(stu.sid);
  return !it.grades || it.grades.includes(String(Math.floor(stu.sid / 1000)));
}

function calItems() {
  const replaced = new Set(cache.school.map((x) => x.neis_key).filter(Boolean));
  return [
    ...cache.school.map((e) => {
      const s = new Date(e.starts_at), en = e.ends_at ? new Date(e.ends_at) : s;
      return { kind: "sch", e, id: e.id, start: dayKey(s), end: dayKey(en), title: e.title, cat: e.category || "event",
        grades: e.neis_key ? e.neis_key.split("|").pop() : null };
    }),
    ...(acadList || []).filter((a) => a.name !== "토요휴업일" && !replaced.has(a.key)).map((a) => ({
      kind: "acad", a, id: a.id, start: a.start, end: a.end, title: a.name, cat: a.cat, grades: a.grades.join(""),
    })),
    ...(calStudent ? calBusy.map((b, i) => {
      const s = new Date(b.starts_at), en = b.ends_at ? new Date(b.ends_at) : s;
      // 하루 종일 일정의 끝은 다음 날 0시로 저장돼 있어 하루 앞으로
      const last = b.all_day && b.ends_at && en > s ? new Date(en - 1) : en;
      return { kind: "busy", id: i, start: dayKey(s), end: dayKey(last), title: "개인 일정", shared: !!b.shared,
        time: b.all_day ? "하루 종일" : s.toTimeString().slice(0, 5) };
    }) : []),
    ...(schPref.asg === false ? [] : calAsg.map((a) => {
      const k = dayKey(new Date(a.due_at));
      return { kind: "asg", a, id: a.id, start: k, end: k, title: `${a.subject} ${a.title}` };
    })),
  ];
}

function renderSchoolCal(body) {
  const today = dayKey(new Date());
  calMonth ||= today.slice(0, 7);
  const [y, m] = calMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const gridStart = new Date(y, m - 1, 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const lastRow = days.findLastIndex((d) => d.getMonth() === m - 1);
  const shown = days.slice(0, Math.ceil((lastRow + 1) / 7) * 7);
  const stu = calStudent ? roster().find((p) => p.sid === calStudent) : null;
  const g = String(GRADE);
  const items = calItems().filter((it) => calVisible(it, stu))
    .filter((it) => stu || schPref.grades || !it.grades || it.grades.includes(g));
  const on = (key) => items.filter((it) => it.start <= key && key <= it.end)
    .sort((a, b) => (a.kind === "busy") - (b.kind === "busy") || (a.shared === true) - (b.shared === true) || (a.kind === "asg") - (b.kind === "asg") || a.title.localeCompare(b.title, "ko"));
  const chip = (it) => {
    if (it.kind === "busy") return `<span class="acal-chip busy" style="--c:${it.shared ? BUSY_SHARED : BUSY_OWN}" title="${it.shared ? "친구가 넣어 준 일정" : "직접 만든 일정"} (내용은 보이지 않아요)"><span class="busy-blur">개인 일정 내용</span></span>`;
    const done = it.kind === "asg" && calDone.has(it.id);
    const color = it.kind === "asg" ? "var(--accent1)" : CAT_COLOR[it.cat] || CAT_COLOR.event;
    const dim = (it.kind === "sch" && it.e.hidden) || it.a?.status === "pending" || done;
    return `<span class="acal-chip${it.kind === "asg" ? " asg" : ""}${dim ? " dim" : ""}" style="--c:${color}" data-copen="${it.kind}:${it.id}" title="${esc(it.title)}">${done ? "✓ " : ""}${esc(it.title)}</span>`;
  };
  const cell = (d) => {
    const key = dayKey(d), list = on(key);
    const cls = [d.getMonth() !== m - 1 ? "out" : "", key === today ? "today" : "", d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : ""].join(" ");
    return `<div class="acal-cell ${cls}" data-cday="${key}"><span class="acal-d">${d.getDate()}</span>
      ${list.slice(0, 3).map(chip).join("")}${list.length > 3 ? `<span class="acal-more">+${list.length - 3}</span>` : ""}</div>`;
  };
  const people = roster();
  const asgCount = stu ? items.filter((it) => it.kind === "asg" && it.start.startsWith(calMonth)).length : 0;
  const doneCount = stu ? items.filter((it) => it.kind === "asg" && it.start.startsWith(calMonth) && calDone.has(it.id)).length : 0;
  body.innerHTML = `${schViewSeg()}
    <div class="acal-bar">
      <button class="study-btn small" data-cmove="-1" aria-label="지난달">‹</button>
      <b class="acal-title">${y}년 ${m}월</b>
      <button class="study-btn small" data-cmove="1" aria-label="다음달">›</button>
      <button class="study-btn small" data-cmove="0">오늘</button>
      <select class="study-input acal-stu" id="calStu" aria-label="학생 고르기">
        <option value="">모든 일정 (학생 고르기)</option>
        ${people.map((p) => `<option value="${p.sid}"${p.sid === calStudent ? " selected" : ""}>${p.sid} ${esc(p.name)}</option>`).join("")}
      </select>
    </div>
    <div class="sch-tools">
      <label><input type="checkbox" id="calAsgOn"${schPref.asg === false ? "" : " checked"}> 수행평가도 보기</label>
      ${stu ? "" : `<label><input type="checkbox" id="schGrades"${schPref.grades ? " checked" : ""}> 다른 학년 일정도 보기</label>`}
      ${stu ? `<span>${esc(stu.name)} 달력 · 이달 수행평가 ${asgCount}개 중 완료 ${doneCount}개 · ${calStats ? `직접 추가한 일정 ${calStats.events}개 · 할 일 ${calStats.todos}개` : calStats === false ? "가입 전" : "일정 수를 못 받았어요"}</span>` : ""}
    </div>
    <div class="acal">
      ${["일", "월", "화", "수", "목", "금", "토"].map((w, i) => `<div class="acal-w${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</div>`).join("")}
      ${shown.map(cell).join("")}
    </div>
    <div class="acal-legend">${ACAD_CATS.map(([k, label]) => `<span style="--c:${CAT_COLOR[k]}">${label}</span>`).join("")}<span style="--c:var(--accent1)">수행평가</span>${stu ? `<span style="--c:${BUSY_OWN}">직접 만든 일정</span><span style="--c:${BUSY_SHARED}">친구가 넣은 일정</span>` : ""}</div>
    <div class="adm-foot">날짜를 누르면 그날 일정을 보고 학교 일정 · 수행평가를 추가할 수 있어요. 흐린 것은 숨긴 일정 · 승인 전 수행평가${stu ? " · 완료한 수행평가" : ""}예요.
      ${stu ? "학생을 고르면 그 학생 달력에 보이는 공용 일정과, 흐린 칸으로 개인 일정이 있는 날만 보여요 (개인 일정 · 할 일의 내용은 보이지 않아요. 일정 수는 지금까지 직접 추가한 전체 수예요)." : ""}</div>`;
  bindSchView(body);
  body.querySelectorAll("[data-cmove]").forEach((b) => b.onclick = () => {
    const n = +b.dataset.cmove;
    const d = n ? new Date(y, m - 1 + n, 1) : new Date();
    calMonth = dayKey(d).slice(0, 7);
    renderSchoolCal(body);
  });
  $("calStu").onchange = async () => {
    calStudent = +$("calStu").value || null;
    await loadCalAsg();
    renderSchoolCal(body);
  };
  $("calAsgOn").onchange = () => { schPref.asg = $("calAsgOn").checked; saveSchPref(); renderSchoolCal(body); };
  if ($("schGrades")) $("schGrades").onchange = () => { schPref.grades = $("schGrades").checked; saveSchPref(); renderSchoolCal(body); };
  const open = (kindId) => {
    const [kind, id] = kindId.split(":");
    if (kind === "sch") openSchoolForm(cache.school.find((x) => x.id === id));
    else if (kind === "acad") openSchoolForm(neisDraft(acadList.find((x) => x.id === id)));
    else openAsgForm(calAsg.find((x) => x.id === id));
  };
  body.querySelectorAll("[data-copen]").forEach((c) => c.onclick = (e) => { e.stopPropagation(); open(c.dataset.copen); });
  body.querySelectorAll("[data-cday]").forEach((c) => c.onclick = () => {
    const key = c.dataset.cday, list = on(key);
    openSheet(dayTitle(key), `
      ${list.map((it) => it.kind === "busy" ? `<div class="sch-row busy-row">
        <span class="acal-dot" style="--c:${it.shared ? BUSY_SHARED : BUSY_OWN}"></span>
        <span class="sch-main"><span class="sch-title"><span class="busy-blur">개인 일정 내용</span></span>
        <span class="sch-chips"><span class="adm-chip">${it.shared ? "친구가 넣어 준 일정" : "직접 만든 일정"} · ${it.time} · 내용 비공개</span></span></span>
      </div>` : `<button class="sch-row" data-copen="${it.kind}:${it.id}">
        <span class="acal-dot" style="--c:${it.kind === "asg" ? "var(--accent1)" : CAT_COLOR[it.cat] || CAT_COLOR.event}"></span>
        <span class="sch-main"><span class="sch-title">${it.kind === "asg" && calDone.has(it.id) ? "✓ " : ""}${esc(it.title)}</span>
        <span class="sch-chips"><span class="adm-chip">${it.kind === "asg" ? `수행평가 · ${esc(banLabel(it.a.ban))}${it.a.status === "pending" ? " · 승인 전" : ""}` : `${catLabel(it.cat)}${it.kind === "acad" ? " · NEIS" : ""}`}</span></span></span>
      </button>`).join("") || '<div class="adm-none">이날은 일정이 없어요.</div>'}
      <div class="acal-add"><button class="study-submit" id="cAddSch">+ 학교 일정</button><button class="study-submit" id="cAddAsg">+ 수행평가</button></div>`);
    const m2 = $("studyModal");
    m2.querySelectorAll("[data-copen]").forEach((b) => b.onclick = () => open(b.dataset.copen));
    $("cAddSch").onclick = () => openSchoolForm(null, { start: new Date(`${key}T09:00`), allDay: true });
    $("cAddAsg").onclick = () => openAsgForm(null, key);
  });
}

// 목록 · 달력 고르기
const schViewSeg = () => `<div class="adm-sub acal-view">${[["list", "목록"], ["cal", "달력"]].map(([k, label]) =>
  `<button class="${(schPref.view || "list") === k ? "on" : ""}" data-sview="${k}">${label}</button>`).join("")}</div>`;
function bindSchView(body) {
  body.querySelectorAll("[data-sview]").forEach((b) => b.onclick = () => {
    if ((schPref.view || "list") === b.dataset.sview) return;
    schPref.view = b.dataset.sview;
    saveSchPref();
    renderSchool();
  });
}
const saveSchPref = () => { try { localStorage.setItem(SCH_PREF, JSON.stringify(schPref)); } catch {} };

// 그룹: 자주 쓰는 대상(학번 목록)을 이름 붙여 저장합니다 (groups.sql). 관리자 그룹은 관리자끼리 함께 써요.
function mountGroups(boxId, getSids, addSids) {
  let groups = [];
  const draw = () => {
    const box = $(boxId);
    if (!box) return;
    box.innerHTML = `<span class="aud-label">그룹</span>` +
      groups.map((g, i) => `<span class="aud-group"><button type="button" class="study-btn small" data-group="${i}">${esc(g.name)} <small>${g.student_ids.length}</small></button><button type="button" class="aud-group-x" data-gdel="${i}" aria-label="${esc(g.name)} 그룹 지우기">✕</button></span>`).join("") +
      `<button type="button" class="study-btn small" data-gsave>+ 고른 사람을 그룹으로</button>`;
    box.querySelectorAll("[data-group]").forEach((b) => b.onclick = () => addSids(groups[+b.dataset.group].student_ids));
    box.querySelectorAll("[data-gdel]").forEach((b) => b.onclick = async () => {
      const g = groups[+b.dataset.gdel];
      if (!confirm(`'${g.name}' 그룹을 지울까요? (이미 넣은 사람은 그대로예요)`)) return;
      const { error } = await sb.from("audience_groups").delete().eq("id", g.id);
      if (error) return toast("그룹을 지우지 못했어요", true);
      groups = groups.filter((x) => x !== g);
      draw();
    });
    box.querySelector("[data-gsave]").onclick = async () => {
      const sids = [...new Set(getSids())].filter(Boolean).sort((a, b) => a - b);
      if (!sids.length) return toast("먼저 그룹에 넣을 사람을 골라 주세요", true);
      const name = prompt(`지금 고른 ${sids.length}명을 어떤 이름의 그룹으로 저장할까요?`, "")?.trim();
      if (!name) return;
      const { data, error } = await sb.from("audience_groups").insert({ name: name.slice(0, 40), student_ids: sids }).select().single();
      if (error) return toast("그룹을 저장하지 못했어요", true);
      groups = [...groups, data].sort((a, b) => a.name.localeCompare(b.name, "ko"));
      draw();
      toast(`'${data.name}' 그룹을 저장했어요`);
    };
  };
  sb.from("audience_groups").select("*").order("name").then(({ data, error }) => {
    if (error) { $(boxId)?.remove(); return; }
    groups = data;
    draw();
  });
}

// 학교 일정 추가·수정 (대상: 전체 / 특정 인원)
// e.neis_key 가 있으면 NEIS 일정을 고치는 중입니다. e.id 가 없으면 아직 고친 적이 없는 원본입니다 (neisDraft).
function openSchoolForm(e, seed) {
  const neis = !!e?.neis_key;
  const now = new Date();
  const start = e ? new Date(e.starts_at) : seed?.start || new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9);
  const allDay = e ? e.all_day : seed ? seed.allDay : true;
  const end = e?.ends_at ? new Date(e.ends_at) : allDay ? start : new Date(+start + HOUR);
  const people = roster();
  const nameOf = new Map(people.map((p) => [p.sid, p.name]));
  const before = e ? schoolTargets(e) : [];
  let picked = new Set(before);
  let audience = e?.audience || "all";
  const subjects = banSubjects();
  const rooms = [...new Set(people.map((p) => homeroom(p.sid)))].sort();

  openSheet(e?.id || neis ? "학교 일정 수정" : "학교 일정 추가", `
    ${neis ? `<div class="study-foot">학교 홈페이지(NEIS)에서 온 일정이에요. 여기서 고치면 이 사이트에서만 바뀌고, 원본은 그대로예요.</div>` : ""}
    ${e?.hidden ? `<div class="study-foot">지금 학생 달력에서 숨겨 둔 일정이에요. 저장하면 다시 보여요.</div>` : ""}
    <label class="study-label">제목</label>
    <input class="study-input" id="sTitle" maxlength="120" value="${esc(e?.title || "")}" placeholder="예: 체육대회, 2학기 기말고사, 개교기념일">
    <label class="study-label">종류</label>
    <select class="study-input" id="sCat">${ACAD_CATS.map(([k, label]) =>
      `<option value="${k}"${k === (e?.category || "event") ? " selected" : ""}>${label}</option>`).join("")}</select>
    <label class="ev-allday"><input type="checkbox" id="sAll"${allDay ? " checked" : ""}> 하루 종일 <span class="ev-hint">(끄면 시간을 정할 수 있어요)</span></label>
    <label class="study-label">시작</label>
    <div class="ev-when"><input class="study-input" type="date" id="sSd" value="${dayKey(start)}"><input class="study-input" type="time" id="sSt" step="300" value="${allDay ? "09:00" : hm(start)}"></div>
    <label class="study-label">끝</label>
    <div class="ev-when"><input class="study-input" type="date" id="sEd" value="${dayKey(end)}"><input class="study-input" type="time" id="sEt" step="300" value="${allDay ? "10:00" : hm(end)}"></div>
    <label class="ev-allday sch-noclass"><input type="checkbox" id="sNo"${e?.no_class ? " checked" : ""}> 수업 없는 날 <span class="ev-hint">(이 기간엔 달력에 시간표를 깔지 않아요)</span></label>
    <label class="ev-allday"><input type="checkbox" id="sNotify"${e?.notify ? " checked" : ""}> <span style="white-space:nowrap">필수 일정</span> <span class="ev-hint">(30분 전 알림 · 하루 종일은 07:50)</span></label>
    <label class="study-label">메모 (선택)</label>
    <textarea class="study-input" id="sMemo" rows="2" maxlength="2000" placeholder="장소, 준비물 등">${esc(e?.memo || "")}</textarea>

    <div${neis ? ' style="display:none"' : ""}>
    <label class="study-label">누구에게 보일까요</label>
    <div class="seg aud-seg">
      <button type="button" class="seg-btn" data-aud="all">전체</button>
      <button type="button" class="seg-btn" data-aud="some">특정 인원</button>
    </div>
    <div id="audSome">
      <div class="aud-count" id="audCount"></div>
      <div class="fr-chips" id="audChips"></div>
      <div class="aud-quick">
        <span class="aud-label">반</span>
        ${rooms.map((r) => `<button type="button" class="study-btn small" data-room="${r}">${r}반</button>`).join("")}
      </div>
      <div class="aud-quick" id="audGroups">
        <span class="aud-label">그룹</span>
        <span class="aud-hint">불러오는 중…</span>
      </div>
      <div class="aud-quick">
        <span class="aud-label">분반</span>
        <select class="study-input" id="audSubj"><option value="">과목 고르기</option>${subjects.map((x) => `<option>${esc(x)}</option>`).join("")}</select>
        <select class="study-input" id="audBan" disabled><option value="">분반</option></select>
        <button type="button" class="study-btn small" id="audSubjAdd" disabled>추가</button>
      </div>
      <input class="study-input" id="audQ" autocomplete="off" placeholder="이름·학번으로 한 명씩 추가">
      <div class="fr-results" id="audRes"></div>
    </div>
    </div>

    <div class="study-err" id="authErr"></div>
    <button class="study-submit" id="sSave">${e?.id || neis ? "저장" : "추가"}</button>
    ${neis && e.id ? '<button class="study-submit ghost" id="sRevert">원래 일정으로 되돌리기</button>' : ""}
    ${e && !e.hidden && (e.id || neis) ? `<button class="study-submit ghost danger" id="sDel">${neis ? "학생 달력에서 숨기기" : "학교 일정 삭제"}</button>` : ""}`);
  const sheet = $("studyModal").querySelector(".study-sheet");
  const at = (d, t) => (d ? new Date(`${d}T${t || "00:00"}`) : null);

  const syncAll = () => {
    sheet.classList.toggle("allday", $("sAll").checked);
    sheet.querySelector(".sch-noclass").style.display = $("sAll").checked ? "" : "none";
  };
  $("sAll").onchange = () => { syncAll(); $("sAll").checked ? $("sEd").value = $("sSd").value : $("sSd").onchange(); };
  $("sSd").onchange = () => {
    if ($("sAll").checked) { if ($("sEd").value < $("sSd").value) $("sEd").value = $("sSd").value; }
    else { const s = at($("sSd").value, $("sSt").value); const en = new Date(+s + HOUR); $("sEd").value = dayKey(en); $("sEt").value = hm(en); }
  };
  $("sSt").onchange = $("sSd").onchange;
  syncAll();

  const drawAud = () => {
    sheet.querySelectorAll("[data-aud]").forEach((b) => b.classList.toggle("on", b.dataset.aud === audience));
    $("audSome").style.display = audience === "some" ? "" : "none";
    const ids = [...picked].sort((a, b) => a - b);
    $("audCount").textContent = ids.length ? `${ids.length}명에게 보여요` : "아직 아무도 고르지 않았어요";
    $("audChips").innerHTML = ids.map((sid) =>
      `<span class="fr-chip">${esc(nameOf.get(sid) || sid)}<small>${sid}</small><button type="button" data-unpick="${sid}" aria-label="빼기">✕</button></span>`).join("") +
      (ids.length > 1 ? `<button type="button" class="aud-clear" id="audClear">모두 빼기</button>` : "");
    $("audChips").querySelectorAll("[data-unpick]").forEach((b) => b.onclick = () => { picked.delete(+b.dataset.unpick); drawAud(); });
    if ($("audClear")) $("audClear").onclick = () => { picked.clear(); drawAud(); };
  };
  sheet.querySelectorAll("[data-aud]").forEach((b) => b.onclick = () => { audience = b.dataset.aud; drawAud(); });
  sheet.querySelectorAll("[data-room]").forEach((b) => b.onclick = () => {
    people.filter((p) => homeroom(p.sid) === +b.dataset.room).forEach((p) => picked.add(p.sid));
    drawAud();
  });
  $("audSubj").onchange = () => {
    const subj = $("audSubj").value;
    const bans = [...new Set(people.map((p) => p.classes[subj]).filter(Boolean))].sort();
    $("audBan").innerHTML = `<option value="*">전체 분반</option>` + bans.map((x) => `<option>${esc(x)}</option>`).join("");
    $("audBan").disabled = $("audSubjAdd").disabled = !subj;
  };
  $("audSubjAdd").onclick = () => {
    const subj = $("audSubj").value, ban = $("audBan").value;
    // 분반이 없는 과목(43기)은 듣는 학생 모두 (classes 값이 null)
    people.filter((p) => p.classes[subj] !== undefined && (ban === "*" || p.classes[subj] === ban)).forEach((p) => picked.add(p.sid));
    drawAud();
  };
  mountGroups("audGroups", () => [...picked], (sids) => { sids.forEach((sid) => picked.add(sid)); drawAud(); });

  $("audQ").oninput = () => {
    const q = $("audQ").value.trim();
    const list = q ? people.filter((p) => !picked.has(p.sid) && (p.name.includes(q) || String(p.sid).startsWith(q))).slice(0, 8) : [];
    $("audRes").innerHTML = !q ? "" : list.length
      ? list.map((p) => `<button type="button" class="fr-item" data-pick="${p.sid}"><b>${esc(p.name)}</b><span>${p.sid}</span></button>`).join("")
      : `<div class="fr-empty">명단에 없어요.</div>`;
    $("audRes").querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => {
      picked.add(+b.dataset.pick); drawAud();
      $("audQ").value = ""; $("audRes").innerHTML = ""; $("audQ").focus();
    });
  };
  drawAud();

  $("sSave").onclick = async () => {
    const title = $("sTitle").value.trim();
    const sd = $("sSd").value, ed = $("sEd").value || sd, all = $("sAll").checked;
    if (!title) return showErr("제목을 입력해 주세요.");
    if (!sd) return showErr("시작 날짜를 정해 주세요.");
    let starts, ends;
    if (all) {
      if (ed < sd) return showErr("끝나는 날이 시작보다 빨라요.");
      starts = at(sd); ends = ed > sd ? at(ed, "23:59") : null;
    } else {
      starts = at(sd, $("sSt").value); ends = at(ed, $("sEt").value);
      if (!ends || ends <= starts) return showErr("끝나는 시간이 시작보다 빨라요.");
    }
    if (audience === "some" && !picked.size) return showErr("보여줄 사람을 한 명 이상 골라 주세요.");
    const row = {
      title, memo: $("sMemo").value.trim(), all_day: all, no_class: all && $("sNo").checked, notify: $("sNotify").checked, audience,
      starts_at: starts.toISOString(), ends_at: ends ? ends.toISOString() : null,
      category: $("sCat").value, neis_key: e?.neis_key || null, hidden: false,
    };
    $("sSave").disabled = true;
    const { data: saved, error } = e?.id
      ? await sb.from("school_events").update(row).eq("id", e.id).select("id").single()
      : await sb.from("school_events").insert(row).select("id").single();
    if (error) { $("sSave").disabled = false; return showErr("저장하지 못했어요: " + error.message); }
    // 대상 맞추기: 전체 공개로 바꾸면 대상 목록은 비웁니다
    const want = audience === "some" ? [...picked] : [];
    const add = want.filter((sid) => !before.includes(sid));
    const drop = before.filter((sid) => !want.includes(sid));
    const results = await Promise.all([
      add.length && sb.from("school_event_targets").insert(add.map((sid) => ({ event_id: saved.id, student_id: sid }))),
      drop.length && sb.from("school_event_targets").delete().eq("event_id", saved.id).in("student_id", drop),
    ]);
    closeModal();
    if (results.some((r) => r && r.error)) toast("일정은 저장했지만 대상 일부를 맞추지 못했어요", true);
    else toast(audience === "all" ? "모두에게 보이는 학교 일정이에요" : `${want.length}명에게 보이는 학교 일정이에요`);
    await refresh();
  };
  // NEIS 를 고친 일정 → 고친 내용을 지워 원본으로
  if ($("sRevert")) $("sRevert").onclick = async () => {
    const { error } = await sb.from("school_events").delete().eq("id", e.id);
    if (error) return showErr("되돌리지 못했어요.");
    closeModal();
    toast("학교 홈페이지 일정으로 되돌렸어요");
    await refresh();
  };
  // 원본 NEIS 일정은 지울 수 없으니, 숨겼다는 표시를 남겨 학생 달력에서 뺍니다 (이 목록에는 흐리게 남아 되돌릴 수 있어요)
  if ($("sDel") && neis) $("sDel").onclick = async () => {
    if (!confirm("이 일정을 모든 학생 달력에서 숨길까요?")) return;
    const hide = { hidden: true, notify: false, no_class: false };
    const { error } = e.id
      ? await sb.from("school_events").update(hide).eq("id", e.id)
      : await sb.from("school_events").insert({ title: e.title, memo: e.memo, starts_at: e.starts_at, ends_at: e.ends_at,
          all_day: true, audience: "all", category: e.category, neis_key: e.neis_key, ...hide });
    if (error) return showErr("숨기지 못했어요.");
    closeModal();
    toast("숨겼어요. 흐리게 보이는 일정을 눌러 되돌릴 수 있어요");
    await refresh();
  };
  if ($("sDel") && !neis) $("sDel").onclick = async () => {
    if (!confirm("이 학교 일정을 모든 학생 달력에서 지울까요?")) return;
    const snap = { id: e.id, title: e.title, memo: e.memo, starts_at: e.starts_at, ends_at: e.ends_at,
      all_day: e.all_day, no_class: e.no_class, notify: e.notify, audience: e.audience, category: e.category };
    const targets = before.map((sid) => ({ event_id: e.id, student_id: sid }));
    const { error } = await sb.from("school_events").delete().eq("id", e.id);
    if (error) return showErr("삭제하지 못했어요.");
    closeModal();
    undoToast("학교 일정을 지웠어요", async () => {
      const { error } = await sb.from("school_events").insert(snap);
      if (error) return false;
      if (targets.length) await sb.from("school_event_targets").insert(targets);
      await refresh();
    });
    await refresh();
  };
}

// ============================================================
// 설정: 알림 · 화면 테마 · 계정
// ============================================================
const THEMES = [
  ["dark", "다크", "#0a0a0f", "#7c6fe0"],
  ["light", "라이트", "#f5f5fa", "#6a5cd6"],
  ["ocean", "바다", "#07111b", "#3fa7e0"],
  ["forest", "숲", "#0a120d", "#5fbf7a"],
  ["coco", "코코", "#f2f7f3", "#2f9a52"],
  ["sakura", "벚꽃", "#fbf3f6", "#d0577f"],
];
const THEME_KEY = "dshs-theme";
const curTheme = () => document.documentElement.dataset.theme || "dark";

function openSettings() {
  openSheet("설정", `
    <label class="set-row"><span><b>알림</b><span class="ev-hint" id="pushHint">${PUSH_HINT}</span></span>
      <input type="checkbox" id="setPush"></label>
    <div class="set-row" style="display:block"><b>화면 테마</b>
      <div class="theme-grid">${THEMES.map(([k, label, bg, ac]) =>
        `<button type="button" data-theme-pick="${k}"${curTheme() === k ? ' class="on"' : ""}><i style="background:linear-gradient(135deg, ${bg} 50%, ${ac} 50%)"></i>${label}</button>`).join("")}</div></div>
    <a class="study-btn wide" href="${esc(STUDENT_URL)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none">학생 사이트 열기</a>
    <div class="study-foot">이 기기는 관리자 기기로 등록돼 있어요 (${esc(me.username)}).<br>
      <button class="auth-admin" id="doLogout" type="button">이 기기 등록 해제</button> · 기기를 잃어버렸거나 다른 사람에게 줄 때만 눌러요</div>`);
  $("setPush").onchange = togglePush;
  paintPush(); refreshPush();
  $("studyModal").querySelectorAll("[data-theme-pick]").forEach((b) => b.onclick = () => {
    try { localStorage.setItem(THEME_KEY, b.dataset.themePick); } catch {}
    window.applyTheme?.();
    $("studyModal").querySelectorAll("[data-theme-pick]").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("doLogout").onclick = () => { if (confirm("이 기기 등록을 해제할까요? 다시 쓰려면 비밀번호를 넣어야 하고, 이 기기로 관리자 알림이 오지 않아요.")) logout(); };
}

// ---------- 웹 푸시 ----------
// 관리자 알림(승인 요청 · 피드백 · 학생 가입 · 운영 점검 · 사용 분석)은 관리자 계정의 기기로 갑니다.
// 이 사이트에서 켠 기기만 관리자 계정으로 등록되므로, 학생 사이트의 알림과 섞이지 않습니다.
const PUSH_HINT = "승인 요청 · 피드백 · 점검 보고서를 이 기기로 알려 줘요";
let pushOn = false, pushReg = null;
function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from([...atob(b64)].map((c) => c.charCodeAt(0)));
}
async function deviceSub() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  pushReg = reg || pushReg;
  return reg ? reg.pushManager.getSubscription() : null;
}
const isAppleMobile = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function sameKey(sub) {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const want = urlB64ToUint8Array(CFG.VAPID_PUBLIC_KEY), got = new Uint8Array(k);
  return got.length === want.length && got.every((b, i) => b === want[i]);
}
function pushPossible() {
  if (!CFG.VAPID_PUBLIC_KEY || !("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  return !(isAppleMobile() && !isStandalone());
}
function paintPush() {
  const b = $("setPush");
  const warn = !!me && paintPush.known && !pushOn && pushPossible();
  if (b) {
    b.checked = pushOn;
    b.closest(".set-row").classList.toggle("warn", warn);
    $("pushHint").textContent = warn ? "알림이 꺼져 있어요. 눌러서 켜 주세요" : PUSH_HINT;
  }
  $("btnSettings").classList.toggle("warn", warn);
}
const PUSH_PREF = KEYS.push;
const pushWanted = () => { try { return localStorage.getItem(PUSH_PREF) !== "off"; } catch { return true; } };
async function autoPush() {
  if (autoPush.done || !me) return;
  autoPush.done = true;
  if (pushWanted() && "Notification" in window && Notification.permission === "granted") {
    try { await enablePush(true); } catch {}
  }
  refreshPush();
}
async function refreshPush() {
  const sub = await deviceSub().catch(() => null);
  if (!sub) { pushOn = false; paintPush.known = true; return paintPush(); }
  const { data, error } = await sb.from("push_subscriptions").select("endpoint").eq("endpoint", sub.endpoint).maybeSingle();
  if (error) return;
  pushOn = !!data;
  paintPush.known = true;
  paintPush();
}
async function togglePush() {
  const b = $("setPush");
  b.disabled = true;
  try {
    if (pushOn) {
      if (await disablePush()) {
        try { localStorage.setItem(PUSH_PREF, "off"); } catch {}
        toast("알림을 껐어요");
      } else toast("알림을 끄지 못했어요", true);
    } else {
      await enablePush();
      if (pushOn) try { localStorage.setItem(PUSH_PREF, "on"); } catch {}
    }
  } catch {
    toast("알림 설정을 바꾸지 못했어요", true);
  }
  if ($("setPush")) $("setPush").disabled = false;
  paintPush();
}
async function disablePush() {
  const sub = await deviceSub().catch(() => null);
  if (!sub) { pushOn = false; return true; }
  const { error } = await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  if (error) return false;
  await sub.unsubscribe().catch(() => {});
  pushOn = false;
  return true;
}
// 로그아웃: 서버 등록만 지우고 기기의 구독은 남겨 둡니다 (다시 로그인할 때 바로 다시 켜지게)
async function forgetPush() {
  const sub = await deviceSub().catch(() => null);
  if (sub) await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  pushOn = false;
}
async function enablePush(quiet = false) {
  const say = quiet ? () => {} : toast;
  if (!CFG.VAPID_PUBLIC_KEY) return say("알림 키가 아직 설정되지 않았어요", true);
  const apple = isAppleMobile();
  if (apple && !isStandalone()) return say("아이폰 · 아이패드는 홈 화면에 추가한 앱에서 알림을 켤 수 있어요", true);
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return say("이 브라우저는 알림을 지원하지 않아요", true);
  }
  const subscribe = (reg) => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(CFG.VAPID_PUBLIC_KEY) });
  let sub = null;
  if (!quiet && apple && Notification.permission === "default" && pushReg) {
    sub = await subscribe(pushReg).catch(() => null);   // 아이폰 · 아이패드: 누른 순간 바로 구독해야 허락 창이 뜹니다
    if (!sub) return say(Notification.permission === "denied" ? "알림이 차단되어 있어요" : "알림을 켜지 못했어요. 한 번 더 눌러 주세요", true);
  } else {
    const perm = quiet ? Notification.permission : await Notification.requestPermission();
    if (perm !== "granted") return say("알림이 차단되어 있어요", true);
    const reg = pushReg || await navigator.serviceWorker.ready;
    sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await subscribe(reg);
  }
  const j = sub.toJSON();
  // 같은 기기가 다른 계정으로 남아 있어도 지금 계정으로 넘겨받습니다 (schema.sql 의 save_push)
  const { error } = await sb.rpc("save_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  if (error) return say("알림 등록에 실패했어요", true);
  pushOn = true;
  paintPush();
  say("승인 요청 · 피드백 · 점검 보고서를 알려드릴게요");
}

// 설정 창을 열기 전에 받아 둡니다 (아이폰은 누른 순간 바로 구독해야 해서)
deviceSub().catch(() => {});
init();
