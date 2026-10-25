(function () {
  'use strict';

  const KEY = 'eng10-state-v1';
  const INTERVALS = [1, 2, 4, 7, 15]; // 복습 간격(일)
  const LEVELS = { basic: '기초', inter: '중급' };
  const CONTENT = window.CONTENT;
  const app = document.getElementById('app');
  const synth = window.speechSynthesis;
  const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;

  let st = load();
  let view = { name: 'home' };
  let gen = 0; // 음성 재생 세대. hush()가 올리면 이전 콜백은 무시된다
  let timer = null;
  let utter = null; // 재생 중 GC되지 않도록 참조 유지
  let rec = null;
  let lock = null;

  // ---------- 저장 ----------
  function load() {
    const def = { level: '', big: false, slow: false, day: { basic: 0, inter: 0 }, doneDate: { basic: '', inter: '' }, srs: {} };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return def; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* 저장 불가 환경에서도 학습은 가능 */ } }

  // ---------- 날짜 ----------
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function today() { return ymd(new Date()); }
  function plusDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }

  // 전날 학습을 끝냈으면 날짜가 바뀔 때 다음 Day로 넘어간다
  function rollDay() {
    const l = st.level;
    if (!l) return;
    if (st.doneDate[l] && st.doneDate[l] !== today()) {
      st.day[l] = (st.day[l] + 1) % CONTENT[l].length;
      st.doneDate[l] = '';
      save();
    }
  }

  // ---------- 콘텐츠 ----------
  function dayItems(level, day) {
    const d = CONTENT[level][day];
    return d.s.map((x, i) => ({ id: level + '-' + day + '-s-' + i, type: 's', en: x[0], ko: x[1] }))
      .concat(d.w.map((x, i) => ({ id: level + '-' + day + '-w-' + i, type: 'w', en: x[0], ko: x[1], ex: x[2] })));
  }
  function todayItems() { return dayItems(st.level, st.day[st.level]); }
  function itemById(id) {
    const p = id.split('-');
    if (!CONTENT[p[0]] || !CONTENT[p[0]][+p[1]]) return null;
    return dayItems(p[0], +p[1]).find(x => x.id === id) || null;
  }
  function dueItems() {
    const t = today();
    return Object.keys(st.srs)
      .filter(id => id.indexOf(st.level + '-') === 0 && st.srs[id].due <= t)
      .map(itemById).filter(Boolean);
  }
  function grade(id, ok) {
    const c = st.srs[id] || { box: -1 };
    const box = ok ? Math.min(c.box + 1, INTERVALS.length - 1) : 0;
    st.srs[id] = { box: box, due: plusDays(ok ? INTERVALS[box] : 1) };
    save();
  }

  // ---------- 음성 ----------
  // 기기에 설치된 음성 중 가장 자연스러운 것을 고른다 (기본 음성은 기계적인 경우가 많다)
  function bestVoice(lang) {
    if (!synth) return null;
    const score = v => (v.lang.replace('_', '-') === lang ? 4 : 0) + (/natural|neural/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 2 : 0);
    const list = synth.getVoices().filter(v => v.lang.slice(0, 2) === lang.slice(0, 2));
    return list.sort((a, b) => score(b) - score(a))[0] || null;
  }
  if (synth) synth.getVoices(); // 음성 목록은 비동기로 로드되므로 미리 요청
  function say(text, lang, onend) {
    const g = gen;
    const next = () => { if (g === gen && onend) onend(); };
    if (!synth) { next(); return; }
    utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang || 'en-US';
    const v = bestVoice(utter.lang);
    if (v) utter.voice = v;
    utter.rate = st.slow ? 0.75 : 1;
    utter.onend = next;
    utter.onerror = next;
    synth.speak(utter);
  }
  function hush() {
    gen++;
    clearTimeout(timer);
    if (synth) synth.cancel();
    keepAwake(false);
  }
  function sayItem(it) {
    hush();
    say(it.en, 'en-US', it.ex ? () => say(it.ex, 'en-US') : null);
  }
  function wait(ms, fn) { const g = gen; timer = setTimeout(() => { if (g === gen) fn(); }, ms); }
  function keepAwake(on) {
    try {
      if (on && navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { lock = l; }).catch(() => {});
      else if (!on && lock) { lock.release(); lock = null; }
    } catch (e) { /* 미지원 브라우저 */ }
  }

  // 연속 듣기: 영어 2번 → 한국어 뜻 → 다음 항목
  function autoStep(i) {
    const items = view.items;
    if (i >= items.length) { view.auto = false; hush(); render(); return; }
    document.querySelectorAll('.item').forEach((el, k) => {
      el.classList.toggle('on', k === i);
      if (k === i) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const it = items[i];
    say(it.en, 'en-US', () => wait(1200, () => say(it.en, 'en-US', () => wait(800, () => say(it.ko, 'ko-KR', () => wait(1200, () => autoStep(i + 1)))))));
  }

  // ---------- 말하기 채점 ----------
  // 줄임 표기와 풀어 쓴 표기를 같은 것으로 채점한다 (gonna = going to, I'm = I am)
  const EXPAND = [
    [/\bgonna\b/g, 'going to'], [/\bwanna\b/g, 'want to'], [/\bgotta\b/g, 'got to'], [/\bkinda\b/g, 'kind of'],
    [/\bsorta\b/g, 'sort of'], [/\blemme\b/g, 'let me'], [/\bgimme\b/g, 'give me'], [/\bdunno\b/g, "don't know"],
    [/\boutta\b/g, 'out of'], [/\blotta\b/g, 'lot of'],
    [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/n't\b/g, ' not'],
    [/'m\b/g, ' am'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'], [/'ll\b/g, ' will']
  ];
  function norm(s) {
    s = s.toLowerCase().replace(/[‘’]/g, "'");
    EXPAND.forEach(p => { s = s.replace(p[0], p[1]); });
    return s.replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
  }
  function match(target, heard) {
    const a = norm(target), b = norm(heard);
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const hit = new Array(a.length).fill(false);
    let i = a.length, j = b.length;
    while (i && j) {
      if (a[i - 1] === b[j - 1]) { hit[i - 1] = true; i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    return { hit: hit, score: a.length ? dp[a.length][b.length] / a.length : 0 };
  }
  function stopRec() { if (rec) { try { rec.abort(); } catch (e) { /* 이미 종료됨 */ } rec = null; } }
  function startRec() {
    hush();
    stopRec();
    const target = cur().en;
    rec = new Recog();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    view.listening = true;
    view.result = null;
    view.recErr = '';
    rec.onresult = e => {
      let best = null;
      Array.from(e.results[0]).forEach(alt => {
        const m = match(target, alt.transcript);
        if (!best || m.score > best.score) best = { heard: alt.transcript, hit: m.hit, score: m.score };
      });
      view.result = best;
    };
    rec.onerror = e => { if (e.error !== 'aborted') view.recErr = e.error; };
    rec.onend = () => { view.listening = false; rec = null; if (view.name === 'speak') render(); };
    try { rec.start(); } catch (e) { view.listening = false; view.recErr = 'start-failed'; }
    render();
  }

  // ---------- 화면 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cur() { return view.items[view.i]; }
  function go(name, extra) {
    hush();
    stopRec();
    view = Object.assign({ name: name }, extra || {});
    render();
    window.scrollTo(0, 0);
  }
  function bar(title) {
    const count = view.items && view.name !== 'learn' ? '<span class="sub">' + (view.i + 1) + ' / ' + view.items.length + '</span>' : '';
    return '<div class="bar"><button class="link" data-a="home">← 홈</button><b>' + title + '</b>' + count + '</div>';
  }

  function vLevel() {
    return '<div class="card"><h1>영어 10·10</h1><p class="sub">매일 문장 10개, 단어 10개</p></div>' +
      '<h3>수준을 골라 주세요</h3>' +
      '<div class="menu">' +
      '<button data-a="setLevel" data-v="basic"><b>기초</b><span>인사, 식당, 쇼핑, 길 묻기 같은 생활 영어</span></button>' +
      '<button data-a="setLevel" data-v="inter"><b>중급</b><span>의견, 이유, 경험을 깊이 있게 말하기</span></button>' +
      '</div>';
  }

  function vHome() {
    const l = st.level, d = st.day[l], total = CONTENT[l].length;
    const due = dueItems().length;
    const done = st.doneDate[l] === today();
    return '<div class="bar"><h1>영어 10·10</h1><button class="link" data-a="pickLevel">수준: ' + LEVELS[l] + ' 변경</button></div>' +
      '<div class="card"><div class="sub">Day ' + (d + 1) + ' / ' + total + '</div><h2>' + esc(CONTENT[l][d].t) + '</h2>' +
      '<p class="sub">문장 10개 · 단어 10개</p>' +
      (CONTENT[l][d].n ? '<p class="note">' + esc(CONTENT[l][d].n) + '</p>' : '') +
      (done ? '<p class="done">✓ 오늘 학습 완료. 내일 다음 Day가 열립니다.</p>' : '') + '</div>' +
      '<div class="menu">' +
      '<button data-a="learn"><b>1. 익히기</b><span>뜻을 보면서 듣기 · 연속 듣기</span></button>' +
      '<button data-a="listen"><b>2. 듣기</b><span>글자 없이 듣고 뜻 맞히기</span></button>' +
      '<button data-a="dict"><b>3. 받아쓰기</b><span>듣고 적어서 놓친 단어 찾기</span></button>' +
      '<button data-a="speak"><b>4. 말하기</b><span>한국어를 보고 영어로 말하기</span></button>' +
      '<button data-a="quiz"><b>5. 암기 테스트</b><span>오늘의 20개 확인 · 끝내면 오늘 학습 완료</span></button>' +
      '<button data-a="review"' + (due ? '' : ' disabled') + '><b>복습 (' + due + '개)</b><span>지난 문장·단어 중 다시 볼 때가 된 것</span></button>' +
      '</div>' +
      '<h3>설정</h3>' +
      '<div class="row2"><button data-a="prevDay"' + (d ? '' : ' disabled') + '>← 이전 Day</button>' +
      '<button data-a="nextDay"' + (d < total - 1 ? '' : ' disabled') + '>다음 Day →</button></div>' +
      '<div class="row2"><button data-a="big">글씨 크게: ' + (st.big ? '켬' : '끔') + '</button>' +
      '<button data-a="slow">느린 음성: ' + (st.slow ? '켬' : '끔') + '</button></div>';
  }

  function vLearn() {
    const row = (it, k) => '<button class="item" data-a="say" data-i="' + k + '"><span class="en">' + esc(it.en) + '</span>' +
      '<span class="ko">' + esc(it.ko) + '</span>' + (it.ex ? '<span class="ex">' + esc(it.ex) + '</span>' : '') + '</button>';
    const rows = view.items.map(row);
    return bar('익히기') +
      '<button class="main" style="width:100%" data-a="auto">' + (view.auto ? '■ 연속 듣기 멈춤' : '▶ 연속 듣기 (영어 2번 + 한국어 뜻)') + '</button>' +
      '<p class="note">문장을 누르면 그 문장만 들을 수 있습니다.</p>' +
      '<h3>문장</h3><div class="list">' + rows.slice(0, 10).join('') + '</div>' +
      '<h3>단어</h3><div class="list">' + rows.slice(10).join('') + '</div>';
  }

  function vListen() {
    const it = cur();
    return bar('듣기') +
      '<div class="card prompt"><span class="tag">' + (it.type === 's' ? '문장' : '단어') + '</span>' +
      (view.revealed
        ? '<div class="en">' + esc(it.en) + '</div><div class="ko">' + esc(it.ko) + '</div>'
        : '<div class="ko">듣고 뜻을 떠올려 보세요</div>') + '</div>' +
      '<div class="stack"><button class="main" data-a="play">🔊 다시 듣기</button>' +
      (view.revealed ? '' : '<button data-a="reveal">정답 보기</button>') +
      '<button data-a="next">다음 →</button></div>';
  }

  // 정답 문장을 단어별로 맞음/틀림 색으로 표시
  function resultCard(it, r, label) {
    let p = 0;
    const words = it.en.split(/\s+/).map(tok => {
      const k = norm(tok).length;
      const ok = r.hit.slice(p, p + k).every(Boolean);
      p += k;
      return '<span class="' + (ok ? 'hit' : 'miss') + '">' + esc(tok) + '</span>';
    }).join(' ');
    const pct = Math.round(r.score * 100);
    return '<div class="card prompt"><div class="en">' + words + '</div>' +
      '<div class="score ' + (pct >= 80 ? 'hit' : 'miss') + '">' + pct + '%' + (pct >= 80 ? ' 좋아요!' : ' 다시 한 번') + '</div>' +
      '<p class="sub">' + label + ': ' + esc(r.heard) + '</p></div>';
  }

  function vDict() {
    const it = cur(), r = view.result;
    return bar('받아쓰기') +
      (r
        ? resultCard(it, r, '내가 쓴 것') + '<p class="sub" style="text-align:center">' + esc(it.ko) + '</p>' +
          '<p class="note">빨간 단어가 놓친 소리입니다. 그 부분에 집중해서 다시 들어 보세요.</p>'
        : '<div class="card prompt"><div class="ko">들리는 대로 영어로 적어 보세요</div></div>' +
          '<textarea id="dict" rows="3" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="여기에 입력"></textarea>') +
      '<div class="stack"><button class="main" data-a="play">🔊 다시 듣기</button>' +
      (r ? '' : '<button data-a="check">확인</button>') +
      '<button data-a="next">다음 →</button></div>';
  }

  function vSpeak() {
    const it = cur(), r = view.result;
    let out = '';
    if (r) {
      out = resultCard(it, r, '들린 말');
    } else if (view.hint) {
      out = '<div class="card prompt"><div class="en">' + esc(it.en) + '</div></div>';
    }
    const err = view.recErr
      ? '<p class="note miss">' + (view.recErr === 'not-allowed' ? '마이크 권한이 필요합니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.'
        : view.recErr === 'no-speech' ? '소리가 들리지 않았습니다. 다시 눌러 말해 주세요.'
        : '음성 인식에 실패했습니다 (' + esc(view.recErr) + '). 인터넷 연결을 확인해 주세요.') + '</p>' : '';
    return bar('말하기') +
      '<div class="card prompt"><div class="ko">' + esc(it.ko) + '</div></div>' + out + err +
      '<div class="stack">' +
      (Recog
        ? '<button class="main" data-a="mic"' + (view.listening ? ' disabled' : '') + '>' + (view.listening ? '듣는 중… 영어로 말하세요' : '🎤 눌러서 말하기') + '</button>'
        : '<p class="note">이 브라우저는 음성 인식을 지원하지 않습니다. 크롬에서 열면 말하기 채점을 쓸 수 있습니다.</p>') +
      '<div class="row2" style="margin-top:0"><button data-a="play">🔊 듣기</button><button data-a="hint">영어 보기</button></div>' +
      '<button data-a="next">다음 →</button></div>';
  }

  function vQuiz() {
    const it = cur();
    return bar(view.kind === 'review' ? '복습' : '암기 테스트') +
      '<div class="card prompt"><span class="tag">' + (it.type === 's' ? '문장' : '단어') + '</span>' +
      '<div class="ko">' + esc(it.ko) + '</div>' +
      (view.revealed ? '<div class="en">' + esc(it.en) + '</div>' + (it.ex ? '<div class="ex">' + esc(it.ex) + '</div>' : '') : '') + '</div>' +
      (view.revealed
        ? '<div class="stack"><button data-a="play">🔊 듣기</button></div>' +
          '<div class="row2"><button class="no" data-a="rate" data-v="0">아직이에요</button><button class="ok" data-a="rate" data-v="1">외웠어요</button></div>'
        : '<div class="stack"><p class="sub" style="text-align:center">영어로 소리 내어 말해 본 뒤 확인하세요</p>' +
          '<button class="main" data-a="reveal">정답 보기</button></div>');
  }

  function vDone() {
    return '<div class="card prompt"><h2>' + (view.kind === 'review' ? '복습 완료' : '오늘 학습 완료') + '</h2>' +
      '<p>' + view.total + '개 중 <b>' + view.right + '개</b>를 한 번에 맞혔습니다.</p>' +
      '<p class="sub">틀린 것은 내일 복습에 다시 나옵니다.' + (view.kind === 'review' ? '' : ' 내일 앱을 열면 다음 Day가 시작됩니다.') + '</p></div>' +
      '<div class="stack"><button class="main" data-a="home">홈으로</button></div>';
  }

  const views = { home: vHome, learn: vLearn, listen: vListen, dict: vDict, speak: vSpeak, quiz: vQuiz, done: vDone };
  function render() {
    document.body.classList.toggle('big', st.big);
    app.innerHTML = st.level ? views[view.name]() : vLevel();
  }

  // ---------- 동작 ----------
  function startQuiz(kind, items) {
    go('quiz', { kind: kind, items: items.slice(), i: 0, revealed: false, seen: {}, right: 0, total: items.length });
  }
  const actions = {
    home: () => go('home'),
    pickLevel: () => { st.level = ''; save(); go('home'); },
    setLevel: (i, b) => { st.level = b.dataset.v; save(); rollDay(); go('home'); },
    prevDay: () => { st.day[st.level]--; st.doneDate[st.level] = ''; save(); render(); },
    nextDay: () => { st.day[st.level]++; st.doneDate[st.level] = ''; save(); render(); },
    big: () => { st.big = !st.big; save(); render(); },
    slow: () => { st.slow = !st.slow; save(); render(); },

    learn: () => go('learn', { items: todayItems(), auto: false }),
    say: i => { if (view.auto) { view.auto = false; render(); } sayItem(view.items[i]); },
    auto: () => {
      hush();
      view.auto = !view.auto;
      render();
      if (view.auto) { keepAwake(true); autoStep(0); }
    },

    listen: () => { go('listen', { items: todayItems(), i: 0, revealed: false }); sayItem(cur()); },
    dict: () => { go('dict', { items: todayItems().filter(x => x.type === 's'), i: 0 }); sayItem(cur()); },
    check: () => {
      const val = document.getElementById('dict').value;
      view.result = Object.assign({ heard: val }, match(cur().en, val));
      render();
    },
    speak: () => go('speak', { items: todayItems().filter(x => x.type === 's'), i: 0 }),
    quiz: () => startQuiz('day', todayItems()),
    review: () => startQuiz('review', dueItems()),

    play: () => sayItem(cur()),
    hint: () => { view.hint = !view.hint; render(); },
    mic: () => startRec(),
    reveal: () => { view.revealed = true; render(); if (view.name === 'quiz') sayItem(cur()); },
    next: () => {
      if (view.i + 1 >= view.items.length) { go('home'); return; }
      hush();
      stopRec();
      view.i++;
      view.revealed = false;
      view.hint = false;
      view.result = null;
      view.recErr = '';
      render();
      if (view.name === 'listen' || view.name === 'dict') sayItem(cur());
    },
    rate: (i, b) => {
      const it = cur(), ok = b.dataset.v === '1';
      if (!view.seen[it.id]) {
        view.seen[it.id] = true;
        grade(it.id, ok);
        if (ok) view.right++;
      }
      if (!ok) view.items.push(it); // 맞힐 때까지 뒤에서 다시 나온다
      if (view.i + 1 >= view.items.length) {
        if (view.kind === 'day') { st.doneDate[st.level] = today(); save(); }
        go('done', { kind: view.kind, right: view.right, total: view.total });
        return;
      }
      hush();
      view.i++;
      view.revealed = false;
      render();
    }
  };

  app.addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const fn = actions[b.dataset.a];
    if (fn) fn(+b.dataset.i, b);
  });

  // 앱을 켜 둔 채 날짜가 바뀐 경우
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && view.name === 'home') { rollDay(); render(); }
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  rollDay();
  render();
})();
