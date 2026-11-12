// dshs43.app 관리자 사이트 — 설정 (build-admin.mjs 가 만든 것)
// Supabase 프로젝트를 만든 뒤 이 세 값만 채우면 로그인·수행평가 기능이 켜집니다.
// 비워 두면 시간표 기능만 동작합니다 (로그인 버튼이 숨겨져요).
//
//   SUPABASE_URL      Settings → API → Project URL
//   SUPABASE_ANON_KEY Settings → API → anon public key   (공개되어도 되는 키입니다)
//   VAPID_PUBLIC_KEY  npx web-push generate-vapid-keys 로 만든 공개키
//
window.DSHS_CONFIG = {
  SUPABASE_URL: "https://jsanpwlleufzgglqkrkv.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzYW5wd2xsZXVmemdnbHFrcmt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwOTc4ODEsImV4cCI6MjEwODY3Mzg4MX0.hxqptnpMQXfQ_jztsXqxnpx5ZQITCWP6pOie8sySlNM",
  VAPID_PUBLIC_KEY: "BIX8--TywfEp92OPeHlIJjml8hzrk4YCFNxBsoMJ6ckn8nX-9cpm5voycfpD642uMRe5jCzAV2yDB_cj8agi4Fo",
  // 관리자 사이트 (milkcat322/dshs43-admin) · 관리자 사이트에서 보는 학생 사이트
  ADMIN_URL: "https://dshs43-admin.netlify.app",
  STUDENT_URL: "https://dshs43.netlify.app",
  ACADEMIC_URL: "https://dshs43.netlify.app/academic.json",
};
