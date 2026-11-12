// dshs43 관리 — scripts/build-admin.mjs 가 scripts/admin-cohorts.mjs 로 만든 파일입니다. 직접 고치지 않습니다.
window.DSHS_COHORT = {
  "id": 43,
  "label": "43기",
  "title": "dshs43 관리",
  "min": 1000,
  "max": 1999,
  "strict": true,
  "otherRanges": [
    [
      2000,
      2999
    ]
  ],
  "subjects": [
    "국어",
    "영어회화",
    "지구과학",
    "진로",
    "체육",
    "화학",
    "적분과 통계",
    "기하와 벡터",
    "물리",
    "한국사",
    "프로그래밍",
    "생명과학"
  ],
  "otherSubjects": [],
  "noAsgSubjects": [
    "체육"
  ],
  "grade": 1,
  "studentUrl": "https://dshs43.netlify.app",
  "academicUrl": "https://dshs43.netlify.app/academic.json",
  "keys": {
    "auth": "dshs43-admin-auth",
    "school": "dshs43-admin-school",
    "push": "dshs43-admin-push",
    "fbSeen": "dshs43-fb-seen",
    "ovSeen": "dshs43-overview-seen"
  }
};
