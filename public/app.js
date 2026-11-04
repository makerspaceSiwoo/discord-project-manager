const app = document.querySelector('#app'),
  params = new URLSearchParams(location.search),
  demo = params.get('demo') === '1';
let me,
  poll,
  selected = new Set(),
  saved = null,
  emptyIntent = false,
  tab = params.get('tab') === 'mine' ? 'mine' : 'team',
  dirty = false,
  noticeTimer;
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat())
    if (c !== undefined && c !== null)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
function notify(s) {
  document.querySelector('#notice').textContent = s;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (document.querySelector('#notice').textContent = ''), 6000);
}
async function api(path, method = 'GET', data) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const b = r.status === 204 ? {} : await r.json();
  if (!r.ok) throw new Error(b.error || '요청을 완료하지 못했습니다.');
  return b;
}
function action(label, fn, primary = false) {
  return el(
    'button',
    {
      class: primary ? 'save' : 'secondary',
      onclick: () =>
        Promise.resolve()
          .then(fn)
          .catch((e) => notify(e.message)),
    },
    label,
  );
}
function heading(label, title, desc) {
  return el(
    'section',
    { class: 'hero' },
    el('div', {}, el('div', { class: 'eyebrow' }, label), el('h1', {}, title), el('p', {}, desc)),
  );
}
function renderLogin(error) {
  app.replaceChildren(
    el(
      'section',
      { class: 'login' },
      el('div', { class: 'eyebrow' }, 'A LITTLE MORE TOGETHER'),
      el('h1', {}, '우리의 시간을 모아,\n함께 만드는 한 주.'),
      el(
        'p',
        {},
        '일정을 나누고, 할 일을 연결하고, 프로젝트 이야기를 이어가세요. 프로젝트 역할이 있는 Discord 멤버만 참여할 수 있어요.',
      ),
      error ? el('p', {}, error) : null,
      el('a', { class: 'save', href: '/auth/login' }, 'Discord로 시작하기 →'),
      el('p', { class: 'micro' }, 'Notion 계정 연결은 로그인 후 직접 진행합니다.'),
      el('a', { class: 'micro', href: '/?demo=1' }, '샘플 일정 화면 둘러보기'),
    ),
  );
}
function example() {
  const members = [
    { id: 'demo-me', name: '나' },
    { id: 'a', name: '민서' },
    { id: 'b', name: '도윤' },
    { id: 'c', name: '지안' },
    { id: 'd', name: '서준' },
  ];
  return {
    id: 'demo',
    week: '2026-11-09',
    opens: 0,
    closes: Date.now() + 3600_000,
    editable: true,
    members,
    votes: [
      {
        userId: 'a',
        slots: Array.from({ length: 196 }, (_, i) => i).filter((i) => i % 28 >= 12 && i % 28 < 21),
      },
      { userId: 'b', slots: [12, 13, 14, 15, 40, 41, 42, 43, 68, 69, 70, 71] },
      { userId: 'c', slots: [] },
    ],
  };
}
async function start() {
  try {
    if (demo) {
      me = {
        userId: 'demo-me',
        name: '샘플 사용자',
        csrf: '',
        project: { name: '플젝하는 연수리', timezone: 'Asia/Seoul' },
      };
      poll = example();
      renderCalendar([{ id: 'demo', week: poll.week }]);
      return;
    }
    me = await api('/api/me');
    document.querySelector('#user').replaceChildren(
      document.createTextNode(me.name + ' 님'),
      action('로그아웃', async () => {
        await api('/auth/logout', 'POST');
        location.href = '/';
      }),
    );
    if (me.admin) document.querySelector('nav').append(el('a', { href: '/?view=admin' }, '관리자'));
    if (params.get('job')) return showJob(params.get('job'));
    if (params.get('view') === 'account') return account();
    if (params.get('view') === 'admin') return admin();
    if (params.get('report')) return showReport(params.get('report'));
    if (params.get('view') === 'reports') return reports();
    const polls = await api('/api/polls');
    if (!polls.length) {
      app.replaceChildren(
        heading(
          'WEEKLY SCHEDULE',
          '다음 한 주를 준비해요',
          '일요일 오전 9시, Discord에서 새 투표를 안내합니다.',
        ),
        el(
          'section',
          { class: 'card panel' },
          el('h2', {}, '아직 열린 투표가 없어요'),
          el('p', {}, '관리자가 프로젝트를 설정하면 매주 새 일정표가 열립니다.'),
        ),
      );
      return;
    }
    const id = params.get('poll') || polls[0].id;
    poll = await api('/api/polls/' + encodeURIComponent(id));
    renderCalendar(polls);
  } catch (e) {
    renderLogin(e.message);
  } finally {
    app.setAttribute('aria-busy', 'false');
  }
}
function renderCalendar(polls) {
  const mine = poll.votes.find((v) => v.userId === me.userId);
  saved = mine ? JSON.stringify([...mine.slots].sort((a, b) => a - b)) : null;
  selected = new Set(mine?.slots || []);
  emptyIntent = !!mine && !selected.size;
  dirty = false;
  const closed = Date.now() >= poll.closes;
  poll.editable = poll.editable && !closed;
  app.replaceChildren();
  if (demo)
    app.append(
      el(
        'div',
        { class: 'banner' },
        '샘플 화면입니다. 실제 팀 데이터가 아니며, 저장 결과는 이 화면에서만 유지됩니다.',
      ),
    );
  const hero = heading(
    'WEEKLY SCHEDULE',
    '우리 팀이 가능한 시간',
    '각 시간에 가능한 팀원을 한눈에 확인하세요.',
  );
  hero.append(el('span', { class: 'pill' }, closed ? '● 마감 · 확정 결과' : '● 투표 진행 중'));
  app.append(hero);
  const chooser = el('select', {
    'aria-label': '주차 선택',
    onchange: (e) => {
      if (dirty && !confirm('저장하지 않은 변경 사항을 버리고 이동할까요?')) {
        e.target.value = poll.id;
        return;
      }
      location.href = '/?poll=' + encodeURIComponent(e.target.value);
    },
  });
  for (const x of polls) {
    const end = new Date(x.week + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 6);
    const o = el('option', { value: x.id }, x.week + ' ~ ' + end.toISOString().slice(0, 10));
    if (x.id === poll.id) o.selected = true;
    chooser.append(o);
  }
  app.append(
    el('div', { class: 'weeknav' }, chooser, el('span', { class: 'micro' }, '월요일 — 일요일')),
  );
  const mineTab = el(
      'button',
      { class: 'tab', role: 'tab', 'aria-selected': tab === 'mine', onclick: () => setTab('mine') },
      '내가 선택한 시간',
    ),
    teamTab = el(
      'button',
      { class: 'tab', role: 'tab', 'aria-selected': tab === 'team', onclick: () => setTab('team') },
      '팀원이 선택한 시간',
    );
  const head = el('div', { class: 'calendar-head', 'aria-label': '요일' }),
    grid = el('div', { class: 'calendar', 'aria-label': '월요일부터 일요일까지 30분 단위 시간표' }),
    summary = el('div', { class: 'save-state' }),
    saveButton = action('선택한 시간 저장', save, true);
  saveButton.id = 'save';
  const noTime = el('input', {
    type: 'checkbox',
    id: 'empty',
    onchange: (e) => {
      if (e.target.checked) selected.clear();
      emptyIntent = e.target.checked;
      update();
    },
  });
  noTime.checked = emptyIntent;
  noTime.disabled = !poll.editable;
  const bottom = el(
    'div',
    { class: 'bottom' },
    el(
      'div',
      {},
      summary,
      el('label', { class: 'empty-choice' }, noTime, '가능한 시간 없음으로 제출'),
    ),
    saveButton,
  );
  const card = el(
    'section',
    { class: 'card' + (closed ? ' closed' : '') },
    el(
      'div',
      { class: 'toolbar' },
      el('div', { class: 'tabs', role: 'tablist', 'aria-label': '시간표 보기' }, mineTab, teamTab),
      el('span', { class: 'zone' }, me.project.timezone + ' · 30 MIN'),
    ),
    el('div', { class: 'scroll' }, head, grid),
    bottom,
  );
  const count = el('div', { class: 'big' }),
    bar = el('div'),
    responded = el('div', { class: 'micro' }),
    details = el(
      'div',
      {},
      el('p', {}, '시간 칸에 마우스를 올리거나 누르면 팀원의 응답을 볼 수 있어요.'),
    );
  const detailCard = el(
    'section',
    { class: 'card note detail-card' },
    el('div', { class: 'eyebrow' }, 'TEAM AT A GLANCE'),
    el('h2', {}, '이 시간의 팀원'),
    details,
    el(
      'div',
      { class: 'legend' },
      '적음',
      ...[0, 1, 2, 3, 4].map(() => el('span', { class: 'swatch' })),
      '많음',
    ),
    el(
      'button',
      {
        class: 'secondary close-details',
        onclick: () => detailCard.classList.remove('mobile-peek'),
      },
      '닫기',
    ),
  );
  const aside = el(
    'aside',
    { class: 'aside' },
    el(
      'section',
      { class: 'card note dark' },
      el('div', { class: 'eyebrow' }, 'OUR AVAILABILITY'),
      el('h2', {}, '응답한 팀원'),
      count,
      el('div', { class: 'progress' }, bar),
      responded,
    ),
    detailCard,
    el(
      'section',
      { class: 'card note' },
      el('h2', {}, '한 주를 시작하기 전에'),
      el('p', {}, '일요일 23:59까지 저장해 주세요. 월요일 00:00부터 결과가 확정됩니다.'),
      el(
        'p',
        { class: 'micro' },
        '새로 합류한 팀원은 다음 투표부터 참여해요. 미응답과 가능한 시간 없음은 별도로 표시합니다.',
      ),
    ),
  );
  app.append(
    el(
      'div',
      { class: 'layout' },
      el(
        'div',
        {},
        card,
        el(
          'p',
          { class: 'hint' },
          '클릭하거나 드래그하여 선택 · 방향키로 이동, 스페이스로 선택 · 모바일은 시간 칸을 길게 누를 필요 없이 끌어 주세요. 요일 행을 좌우로 밀면 나머지 요일을 볼 수 있어요. 시간표 바깥에서 위아래로 스크롤하세요.',
        ),
      ),
      aside,
    ),
  );
  let dragging = false,
    dragValue = true,
    detailSlot = 0,
    lastPaint = null;
  const cells = new Map();
  const dayNames = ['월', '화', '수', '목', '금', '토', '일'];
  head.append(el('div', { class: 'day' }, '시간'));
  for (let d = 0; d < 7; d++) {
    const date = new Date(poll.week + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + d);
    head.append(
      el(
        'div',
        { class: 'day' },
        dayNames[d],
        el('strong', {}, String(date.getUTCDate()).padStart(2, '0')),
      ),
    );
  }
  const slotLabel = (i) => {
    const h = 9 + Math.floor((i % 28) / 2),
      m = i % 2 ? '30' : '00',
      end = i % 28 === 27 ? '23:00' : i % 2 ? `${h + 1}:00` : `${h}:30`;
    return `${dayNames[Math.floor(i / 28)]} ${String(h).padStart(2, '0')}:${m}–${end}`;
  };
  for (let r = 0; r < 28; r++) {
    grid.append(
      el('div', { class: 'time' }, r % 2 === 0 ? `${String(9 + r / 2).padStart(2, '0')}:00` : ''),
    );
    for (let d = 0; d < 7; d++) {
      const i = d * 28 + r,
        b = el('button', {
          class: 'slot' + (r % 2 === 0 ? ' hour' : ''),
          'data-slot': i,
          'aria-label': slotLabel(i),
          'aria-pressed': 'false',
          type: 'button',
          tabindex: i === 0 ? '0' : '-1',
        });
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        showDetails(i, tab === 'team');
        if (tab !== 'mine' || !poll.editable) return;
        e.preventDefault();
        lastPaint = null;
        dragging = true;
        dragValue = !selected.has(i);
        b.focus();
        paint(i);
      });
      b.addEventListener('pointerenter', () => {
        showDetails(i);
        if (dragging) paint(i);
      });
      b.addEventListener('focus', () => showDetails(i, tab === 'team'));
      b.addEventListener('keydown', (e) => {
        let next = i;
        if (e.key === 'ArrowLeft') next = i - 28;
        if (e.key === 'ArrowRight') next = i + 28;
        if (e.key === 'ArrowUp') next = i - 1;
        if (e.key === 'ArrowDown') next = i + 1;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (tab === 'mine' && poll.editable) {
            dragValue = !selected.has(i);
            paint(i);
          }
          showDetails(i);
          return;
        }
        if (next !== i && cells.has(next)) {
          e.preventDefault();
          b.tabIndex = -1;
          cells.get(next).tabIndex = 0;
          cells.get(next).focus();
        }
      });
      b.addEventListener('click', () => {
        if (tab === 'team') showDetails(i, true);
      });
      cells.set(i, b);
      grid.append(b);
    }
  }
  grid.append(el('div', { class: 'time' }, '23:00'));
  grid.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-slot]');
    if (hit && grid.contains(hit)) paint(Number(hit.dataset.slot));
  });
  window.addEventListener('pointerup', () => (dragging = false));
  window.addEventListener('pointercancel', () => (dragging = false));
  function paint(i) {
    const indices = [i];
    if (dragging && lastPaint !== null) {
      const a = [Math.floor(lastPaint / 28), lastPaint % 28],
        b = [Math.floor(i / 28), i % 28],
        steps = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
      for (let k = 1; k < steps; k++)
        indices.push(
          Math.round(a[0] + ((b[0] - a[0]) * k) / steps) * 28 +
            Math.round(a[1] + ((b[1] - a[1]) * k) / steps),
        );
    }
    for (const x of indices) {
      if (dragValue) selected.add(x);
      else selected.delete(x);
    }
    lastPaint = dragging ? i : null;
    emptyIntent = false;
    noTime.checked = false;
    update();
  }
  function groups(i) {
    const available = [],
      unavailable = [],
      unanswered = [];
    for (const m of poll.members) {
      const vote = poll.votes.find((v) => v.userId === m.id);
      if (!vote) unanswered.push(m.name);
      else if (vote.slots.includes(i)) available.push(m.name);
      else unavailable.push(m.name);
    }
    return { available, unavailable, unanswered };
  }
  function showDetails(i, peek = false) {
    if (peek) detailCard.classList.add('mobile-peek');
    detailSlot = i;
    const g = groups(i);
    details.replaceChildren(el('strong', { class: 'names' }, slotLabel(i)));
    for (const [label, key] of [
      ['가능', 'available'],
      ['불가능', 'unavailable'],
      ['미응답', 'unanswered'],
    ])
      details.append(
        el('div', { class: 'group-label' }, label + ' · ' + g[key].length),
        el('div', { class: 'names' }, g[key].join(', ') || '없음'),
      );
  }
  function update() {
    const value = JSON.stringify([...selected].sort((a, b) => a - b));
    dirty = value !== saved && (saved !== null || selected.size > 0 || emptyIntent);
    summary.textContent = !poll.editable
      ? '마감되었거나 이번 주차의 투표 대상자가 아닙니다.'
      : dirty
        ? `저장 전 변경 사항 · ${selected.size / 2}시간 선택`
        : saved === null
          ? '아직 제출하지 않았어요.'
          : `저장됨 · ${selected.size ? selected.size / 2 + '시간 선택' : '가능한 시간 없음'}`;
    saveButton.disabled = !poll.editable || !dirty || (!selected.size && !emptyIntent);
    noTime.disabled = !poll.editable;
    bottom.classList.toggle('hidden', tab !== 'mine');
    mineTab.setAttribute('aria-selected', tab === 'mine');
    teamTab.setAttribute('aria-selected', tab === 'team');
    for (const [i, b] of cells) {
      const g = groups(i),
        level = g.available.length
          ? Math.ceil((g.available.length / Math.max(1, poll.members.length)) * 5)
          : 0;
      b.className =
        'slot' + (i % 2 === 0 ? ' hour' : '') + (tab === 'team' ? ' team level' + level : '');
      if (tab === 'mine') b.setAttribute('aria-pressed', String(selected.has(i)));
      else b.removeAttribute('aria-pressed');
      b.setAttribute(
        'aria-label',
        slotLabel(i) +
          (tab === 'team'
            ? ` · 가능 ${g.available.length}명 · 미응답 ${g.unanswered.length}명`
            : ''),
      );
      b.textContent = tab === 'team' && g.available.length ? g.available.length : '';
    }
    count.replaceChildren(
      String(poll.votes.length),
      el('small', {}, '/ ' + poll.members.length + '명'),
    );
    bar.style.width = (poll.votes.length / Math.max(1, poll.members.length)) * 100 + '%';
    responded.textContent = `${poll.members.length - poll.votes.length}명의 응답을 기다리고 있어요.`;
    showDetails(detailSlot);
  }
  function setTab(t) {
    tab = t;
    detailCard.classList.remove('mobile-peek');
    update();
  }
  async function save() {
    saveButton.disabled = true;
    summary.textContent = '저장 중…';
    try {
      const values = [...selected].sort((a, b) => a - b);
      if (!demo) await api('/api/polls/' + encodeURIComponent(poll.id), 'PUT', { slots: values });
      saved = JSON.stringify(values);
      const existing = poll.votes.find((v) => v.userId === me.userId);
      if (existing) existing.slots = values;
      else poll.votes.push({ userId: me.userId, slots: values });
      dirty = false;
      notify(demo ? '샘플 응답을 반영했어요.' : '응답을 저장했어요. 마감 전까지 수정할 수 있어요.');
      update();
    } catch (e) {
      summary.textContent = '저장 실패 · 선택 내용은 유지됩니다.';
      saveButton.disabled = false;
      notify(e.message);
    }
  }
  update();
}
async function account() {
  app.replaceChildren(
    heading(
      'ACCOUNT CONNECTION',
      '내 계정을 직접 연결해요',
      'Notion 로그인 이메일로 계정을 찾고 한 번 연결하면 계속 사용합니다.',
    ),
  );
  const panel = el('section', { class: 'card panel' });
  app.append(panel);
  if (me.link) {
    panel.append(
      el('h2', {}, '연결된 Notion 계정'),
      el('code', {}, me.link.notion_id),
      el(
        'p',
        {},
        me.link.valid_until === 0
          ? '연결 유지 중 · 직접 해제하거나 접근 권한이 철회될 때까지 계속 사용합니다.'
          : '재검증 기한: ' + new Date(me.link.valid_until).toLocaleString('ko-KR'),
      ),
      action('연결 해제', async () => {
        if (!confirm('계정 연결을 해제할까요?')) return;
        await api('/api/link', 'DELETE');
        location.reload();
      }),
    );
    if (me.link.valid_until === 0 || me.link.valid_until > Date.now()) {
      panel.append(
        el(
          'p',
          {},
          '이슈를 만들 때 이 Notion 계정이 자동으로 사용됩니다. 다른 계정으로 바꾸려면 먼저 연결을 해제하세요.',
        ),
      );
      return;
    }
  }
  if (!(me.linkingEnabled ?? me.guestVerificationEnabled)) {
    panel.append(
      el(
        'p',
        {},
        '계정 연결 준비 중입니다. 관리자가 인증 페이지 설정을 완료하면 이용할 수 있습니다.',
      ),
    );
    return;
  }
  const pending = await api('/api/link/email');
  if (pending) {
    panel.append(
      el('h2', {}, me.admin ? '연결할 계정을 확인해 주세요' : '관리자 확인을 기다리고 있어요'),
      el('p', {}, 'Discord: ' + me.name),
      el('p', {}, 'Notion: ' + pending.name + ' · ' + pending.email),
    );
    if (me.admin)
      panel.append(
        action(
          '이 계정으로 연결',
          async () => {
            await api('/api/admin/link-requests/approve', 'POST', { id: pending.id });
            location.reload();
          },
          true,
        ),
      );
    else panel.append(el('p', {}, '관리자가 Discord 계정과 Notion 계정을 확인하면 연결됩니다.'));
    panel.append(
      action('요청 취소 / 이메일 변경', async () => {
        await api('/api/link/email/cancel', 'POST', { id: pending.id });
        location.reload();
      }),
    );
    return;
  }
  const email = el('input', {
    type: 'email',
    autocomplete: 'email',
    required: '',
    placeholder: 'Notion 로그인 이메일',
    'aria-label': 'Notion 이메일',
  });
  panel.append(
    el(
      'p',
      {},
      me.admin
        ? '이메일을 입력하고 검색된 Notion 계정이 본인인지 확인하면 연결됩니다.'
        : '이메일을 입력해 연결을 요청하세요. 관리자가 한 번 확인하면 계속 사용할 수 있습니다.',
    ),
    el('label', {}, 'Notion 이메일', email),
    action(
      '이메일로 연결 요청',
      async () => {
        if (!email.reportValidity()) return;
        await api('/api/link/email', 'POST', { email: email.value });
        await account();
      },
      true,
    ),
    el(
      'p',
      { class: 'micro' },
      '댓글에 코드를 입력할 필요가 없습니다. 연결 요청은 7일 동안 유효합니다.',
    ),
  );
}

async function reports() {
  const rows = await api('/api/reports');
  app.replaceChildren(
    heading(
      'WEEKLY REPORT',
      '이번 주, 이어갈 일들',
      '미완료 상위 작업을 마감일과 우선순위 순으로 확인하세요.',
    ),
  );
  const box = el('section', { class: 'card' });
  if (!rows.length) box.append(el('p', { class: 'panel' }, '아직 생성된 보고서가 없습니다.'));
  for (const r of rows)
    box.append(
      el(
        'a',
        { class: 'linkrow', href: '/?report=' + encodeURIComponent(r.id) },
        `${r.week} 주간 보고 · ${r.complete ? '게시 완료' : '수집 또는 게시 중'}`,
      ),
    );
  app.append(box);
}
async function showReport(id) {
  const r = await api('/api/reports/' + encodeURIComponent(id));
  app.replaceChildren(
    heading(
      'WEEKLY REPORT',
      r.week + ' · 주간 보고',
      r.complete
        ? '확정된 보고서 스냅샷입니다. 최신 정보는 Notion 원문을 확인하세요.'
        : '수집 또는 Discord 게시가 진행 중입니다.',
    ),
  );
  const body = el('tbody'),
    table = el(
      'table',
      { class: 'report-table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['작업 ID', '이름', '마감일', '우선순위', '상태', '생성일', '담당자', '바로가기'].map(
            (s) => el('th', { scope: 'col' }, s),
          ),
        ),
      ),
      body,
    );
  app.append(el('div', { class: 'card report-scroll' }, table));
  function append(items) {
    for (const i of items)
      body.append(
        el(
          'tr',
          {},
          ...[
            i.taskId,
            i.title,
            i.due || '없음',
            i.priority,
            i.status,
            i.created.slice(0, 10),
            i.assignees.join(', ') || '미지정',
          ].map((s) => el('td', {}, s)),
          el(
            'td',
            {},
            el('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer' }, 'Notion'),
            i.discordUrl
              ? el(
                  'a',
                  { href: i.discordUrl, target: '_blank', rel: 'noopener noreferrer' },
                  ' · Discord',
                )
              : null,
          ),
        ),
      );
  }
  append(r.items);
  if (!r.items.length)
    app.append(el('p', {}, r.complete ? '미완료 상위 작업 없음' : '보고서 수집 중입니다.'));
  let next = r.nextOffset;
  if (next !== null) {
    const more = action('다음 작업 더 보기', async () => {
      const page = await api('/api/reports/' + encodeURIComponent(id) + '?offset=' + next);
      append(page.items);
      next = page.nextOffset;
      more.disabled = next === null;
    });
    app.append(more);
  }
}
async function showJob(id) {
  const j = await api('/api/jobs/' + encodeURIComponent(id));
  app.replaceChildren(
    heading('ISSUE CREATION', '이슈 생성 진행 상태', '외부 서비스 단계별 결과를 확인합니다.'),
    el(
      'section',
      { class: 'card panel' },
      el('h2', {}, j.status),
      el('p', {}, j.error || '요청이 저장되어 있습니다. Cron이 다음 단계를 이어갑니다.'),
      action('상태 새로고침', () => showJob(id)),
    ),
  );
}
async function admin() {
  if (!me.admin) throw new Error('관리자 권한이 필요합니다.');
  const data = await api('/api/admin/status');
  app.replaceChildren(
    heading(
      'PROJECT SETTINGS',
      '프로젝트 연결과 복구',
      '실제 DB 속성, 채널 종류와 대상 명단을 확인하세요.',
    ),
  );
  const requests = await api('/api/admin/link-requests');
  const requestPanel = el('section', { class: 'card panel' }, el('h2', {}, '계정 연결 요청'));
  if (!requests.length) requestPanel.append(el('p', {}, '대기 중인 요청이 없습니다.'));
  for (const request of requests) {
    requestPanel.append(
      el(
        'section',
        { class: 'panel' },
        el('h3', {}, request.discord_name + ' → ' + request.name),
        el('p', {}, request.email),
        el('p', { class: 'micro' }, 'Discord ID: ' + request.discord_id),
        action(
          '확인하고 연결',
          async () => {
            if (
              !confirm(
                request.discord_name +
                  ' 님과 ' +
                  request.name +
                  ' (' +
                  request.email +
                  ') 계정이 같은 사람인지 확인했나요?',
              )
            )
              return;
            await api('/api/admin/link-requests/approve', 'POST', { id: request.id });
            await admin();
          },
          true,
        ),
        action('요청 거절', async () => {
          await api('/api/link/email/cancel', 'POST', { id: request.id });
          await admin();
        }),
      ),
    );
  }
  app.append(requestPanel);
  const out = el('pre', { class: 'json' }, JSON.stringify(data, null, 2));
  const input = el('input', {
    type: 'text',
    placeholder: '실패 또는 검토 중인 작업 ID',
    'aria-label': '복구할 작업 ID',
  });
  app.append(
    el(
      'section',
      { class: 'card panel' },
      el(
        'div',
        { class: 'actions' },
        action('연동 진단', async () => {
          const r = await api('/api/admin/diagnose');
          out.textContent = JSON.stringify(r, null, 2);
        }),
        action('예약 작업 1단계 실행', async () => {
          await api('/api/admin/run', 'POST', {});
          notify('작업을 실행했습니다.');
        }),
      ),
      input,
      action('안전하게 재시도', async () => {
        await api('/api/admin/retry', 'POST', { id: input.value });
        notify('다시 예약했습니다. 미확인 생성 결과는 재조회합니다.');
      }),
      out,
    ),
  );
}
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
start();
