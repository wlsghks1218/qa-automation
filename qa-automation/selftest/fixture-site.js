// 하네스 자가 검증용 테스트 사이트.
//   정상(clean) 모드: 모든 기능이 정상 동작 → 생성된 테스트가 전부 통과해야 한다 (실패 = 오탐)
//   버그(mutated) 모드: defects.js 의 버그가 모두 들어감 → 버그마다 해당 케이스가 실패해야 한다 (실패 = 감지)
// 모드 전환: GET /__mode/clean · /__mode/mutated
//   node selftest/fixture-site.js <port>
const http = require('http');

const port = Number(process.argv[2] || 5590);
let mutated = false;
const M = (bugged, clean) => (mutated ? bugged : clean);

const header = (page) => `<header>
<a href="/" aria-label="홈으로"><img alt="사이트 로고" width="60" height="24" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='24'%3E%3Crect width='60' height='24' fill='%23345'/%3E%3C/svg%3E"></a>
<nav aria-label="주 메뉴">
  <a href="${M('/about-old', '/about')}">회사 소개</a>
  <a href="/list">구성원 목록</a>
  <span class="menu"><button type="button">서비스</button>
    <span class="sub"><a href="${M('/about-old#team', '/about#team')}">팀 소개</a> <a href="/about#history">연혁</a></span></span>
  ${page === 'about' && mutated ? '' : '<a href="/support">고객센터</a>'}
</nav></header>
<style>.menu{position:relative;display:inline-block}.sub{display:none;position:absolute;top:26px;left:0;background:#fff;border:1px solid #999;padding:6px;white-space:nowrap}.menu:hover .sub{display:block}
dialog{border:1px solid #333}</style>`;

// 건너뛰기 링크: 평소엔 화면 밖, 키보드 포커스 때만 보인다
const skip = (page) => `<a class="skip" href="#${page === 'home' ? M('nowhere', 'content') : 'content'}">본문 바로가기</a>
<style>.skip{position:absolute;top:-40px;left:0;opacity:0}.skip:focus{top:0;opacity:1}</style>`;

const shell = (title, page, body, extra = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${extra}</head><body>${skip(page)}${header(page)}<main id="content">${body}</main></body></html>`;

const people = Array.from({ length: 12 }, (_, i) => [`구성원${'가나다라마바사아자차카타'[i]}`, ['개발팀', '기획팀', '디자인팀'][i % 3], `2025-0${(i % 9) + 1}-1${i % 9}`]);

function home() {
  return shell(
    '자가 검증 홈',
    'home',
    `<h1>자가 검증 홈</h1>
<img alt="배너 이미지" width="200" height="40" src="${M('/missing.png', "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='40'%3E%3Crect width='200' height='40' fill='%2399c'/%3E%3C/svg%3E")}">
<p>서비스를 소개하는 문구입니다</p>
<p>결제가능 ${M('{{token}}', 'USDT')}</p>
<button type="button" ${M('', 'disabled')}>다음 단계</button>
<a href="/" class="lg" id="lgA">로고 링크</a><a href="/" class="lg" id="lgB" style="display:none">로고 링크</a>
<div id="topBar">앱 설치 안내 <button type="button" onclick="topBar.remove()">오늘 하루 보지 않기</button></div>
<div id="floatPop" style="position:fixed;right:10px;bottom:10px;background:#fff;border:1px solid #999;padding:8px">새 기능 안내 <button type="button" onclick="floatPop.remove()">오늘 하루 보지 않기</button></div>
<button type="button" id="openModal">공지 보기</button>
<dialog id="dlg"><p>점검 안내 공지</p><button type="button" id="closeModal">닫기</button></dialog>
<button type="button" id="acc" aria-expanded="false" aria-controls="accBody">자주 묻는 질문 펼치기</button>
<div id="accBody" hidden><p>답변 내용</p></div>
<a href="/support" target="${M('_self', '_blank')}">도움말 새 창</a>
${M('<div style="width:900px;background:#eee">넓은 홍보 영역</div>', '<div style="max-width:100%;background:#eee">홍보 영역</div>')}
<script>
// 같은 이름의 로고 링크 두 개가 번갈아 보임 · 같은 문구의 '보지 않기' 버튼이 두 개 (오탐 방지 확인용, 버그 아님)
setInterval(() => { const a = lgA.style.display === 'none'; lgA.style.display = a ? '' : 'none'; lgB.style.display = a ? 'none' : ''; }, 1500);
openModal.onclick = () => dlg.showModal();
closeModal.onclick = () => { ${M('', 'dlg.close();')} };
acc.onclick = () => { ${M('', "const o = acc.getAttribute('aria-expanded') === 'true'; acc.setAttribute('aria-expanded', String(!o)); accBody.hidden = o;")} };
</script>`
  );
}

function list() {
  return shell(
    '구성원 목록',
    'list',
    `<h1>구성원 목록</h1>
<input id="q" aria-label="이름 검색" placeholder="이름 검색">
<button type="button" id="dl">엑셀 다운로드</button>
<div class="dd"><button type="button" id="dept" aria-haspopup="listbox" aria-expanded="false">부서 전체</button>
<ul role="listbox" id="deptList" hidden><li role="option">부서 전체</li><li role="option">개발팀</li><li role="option">기획팀</li></ul></div>
<table><thead><tr><th>이름</th><th>부서</th><th>가입일</th></tr></thead><tbody></tbody></table>
<nav aria-label="pagination"><button type="button" id="prev">이전</button><button type="button" id="next">다음</button></nav>
<ul class="notices">${[1, 2, 3, 4].map((n) => `<li><a href="/item/${n}">공지 ${n}번 보기</a></li>`).join('')}</ul>
<script>
const data = ${JSON.stringify(people)};
let page = 0, q = '', deptFilter = '';
function render() {
  const f = data.filter((r) => (!q || r.join(' ').includes(q)) && (!deptFilter || r[1] === deptFilter));
  const s = f.slice(page * 5, page * 5 + 5);
  document.querySelector('tbody').innerHTML = s.length
    ? s.map((r, i) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + (${mutated ? "i === 1 ? '날짜 없음' : r[2]" : 'r[2]'}) + '</td></tr>').join('')
    : '<tr><td colspan="3">검색 결과가 없습니다</td></tr>';
}
document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { ${M('', 'q = e.target.value.trim();')} page = 0; render(); } });
next.onclick = () => { ${M('', 'page = Math.min(page + 1, 2); render();')} };
prev.onclick = () => { page = Math.max(page - 1, 0); render(); };
document.getElementById('dept').onclick = () => { deptList.hidden = !deptList.hidden; document.getElementById('dept').setAttribute('aria-expanded', String(!deptList.hidden)); };
deptList.querySelectorAll('[role=option]').forEach((o) => (o.onclick = () => {
  const btn = document.getElementById('dept'); btn.textContent = o.textContent; deptList.hidden = true; btn.setAttribute('aria-expanded', 'false');
  ${M('', "deptFilter = o.textContent === '부서 전체' ? '' : o.textContent; page = 0; render();")}
}));
${M('', `dl.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['name,dept'], { type: 'text/csv' })); a.download = 'members.csv'; a.click(); };`)}
${M("fetch('/api/stats');", "fetch('/api/stats-ok');")}
render();
</script>`
  ).replace(M('<button type="button" id="dl">엑셀 다운로드</button>', '__none__'), '');
}

function about() {
  return shell('회사 소개', 'about', `<h1>회사 소개</h1><h2>${M('서비스 소게', '서비스 소개')}</h2><p id="team">우리 팀 이야기</p><p id="history">걸어온 길</p>`);
}

function form() {
  return shell(
    '문의하기',
    'form',
    `<h1>문의하기</h1><form onsubmit="event.preventDefault()">
<label>이름 <input name="name" ${M('', 'required')}></label>
<label>이메일 <input type="email" name="email"></label>
<label>내용 <input name="memo" maxlength="20"></label>
<button type="submit">보내기</button></form>`
  );
}

http
  .createServer((req, res) => {
    const u = req.url.split('?')[0];
    const send = (code, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    if (u === '/__mode/mutated') return (mutated = true), send(200, 'mutated');
    if (u === '/__mode/clean') return (mutated = false), send(200, 'clean');
    if (u === '/') return send(200, home());
    if (u === '/list') return send(200, list());
    if (u === '/about') return send(200, about());
    if (u === '/support') return send(200, form());
    if (/^\/item\/\d+$/.test(u)) {
      // 이름 없는 뒤로가기 아이콘 버튼 (앱 화면에 흔한 형태)
      const back = `<button type="button" class="btn-back" onclick="${M('', 'history.back()')}"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M10 2L4 8l6 6" stroke="#333" fill="none"/></svg></button>`;
      return send(200, shell('공지 상세', 'item', `${back}<h1>공지 상세</h1><p>공지 내용입니다</p><a href="/list">목록으로</a>`));
    }
    if (u === '/api/stats') return send(500, '{"error":"down"}', 'application/json');
    if (u === '/api/stats-ok') return send(200, '{"ok":true}', 'application/json');
    return send(404, shell('페이지를 찾을 수 없습니다', '404', '<h1>페이지를 찾을 수 없습니다</h1><p>404</p>'));
  })
  .listen(port, '127.0.0.1', () => console.log(`fixture ready ${port}`));
