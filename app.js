(function () {
  'use strict';

  const KEY = 'eng10-state-v1';
  const VERSION = 'v14'; // 화면 맨 아래에 표시. 휴대폰이 새 버전을 받았는지 확인용
  const INTERVALS = [1, 2, 4, 7, 15]; // 복습 간격(일)
  const LEVELS = { basic: '기초', inter: '중급' };
  // AI 음성 파일(audio/<k>/<해시>.mp3). tools/make_audio.py의 VOICES와 순서·키를 맞춘다
  const VOICES = [
    { k: 'ava', label: '미국 · 여성 (Ava)' },
    { k: 'andrew', label: '미국 · 남성 (Andrew)' },
    { k: 'sonia', label: '영국 · 여성 (Sonia)' },
    { k: 'ryan', label: '영국 · 남성 (Ryan)' },
    { k: 'natasha', label: '호주 · 여성 (Natasha)' },
    { k: 'william', label: '호주 · 남성 (William)' }
  ];
  const CONTENT = window.CONTENT;
  const app = document.getElementById('app');
  const synth = window.speechSynthesis;

  let st = load();
  let view = { name: 'home' };
  let gen = 0; // 음성 재생 세대. hush()가 올리면 이전 콜백은 무시된다
  let timer = null;
  let utter = null; // 재생 중 GC되지 않도록 참조 유지
  let lock = null;
  let audio = null;

  // ---------- 저장 ----------
  function load() {
    const def = { level: '', big: false, slow: false, notes: [], day: { basic: 0, inter: 0 }, doneDate: { basic: '', inter: '' }, srs: {} };
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
  function say(text, lang, onend, plain) {
    const g = gen;
    const next = () => { if (g === gen && onend) onend(); };
    if (!synth) { next(); return; }
    utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang || 'en-US';
    const v = plain ? null : bestVoice(utter.lang);
    if (v) utter.voice = v;
    utter.rate = st.slow ? 0.75 : 1;
    utter.onend = next;
    utter.onerror = e => {
      // 고른 음성이 기기에서 재생되지 않으면 기본 음성으로 다시 시도
      if (v && g === gen && e.error !== 'interrupted' && e.error !== 'canceled') { say(text, lang, onend, true); return; }
      next();
    };
    synth.speak(utter);
  }

  // 소리가 안 날 때 원인을 화면에 보여 준다 (음성 지정 없이 기본 음성으로 재생)
  function diagnose() {
    hush();
    const out = view.diag = [];
    out.push('음성 기능: ' + (synth ? '있음' : '없음 (이 브라우저는 소리를 지원하지 않음)'));
    out.push('브라우저 정보: ' + navigator.userAgent);
    if (!synth) { render(); return; }
    const vs = synth.getVoices();
    const b = bestVoice('en-US');
    out.push('설치된 음성: ' + vs.length + '개 (영어 ' + vs.filter(v => /^en/i.test(v.lang)).length + '개)');
    out.push('앱이 고른 음성: ' + (b ? b.name + ' / ' + b.lang : '기기 기본값'));
    render();
    const u = new SpeechSynthesisUtterance('Hello. This is a sound test.');
    u.lang = 'en-US';
    let reacted = false;
    u.onstart = () => { reacted = true; out.push('기본 음성 재생 시작됨'); render(); };
    u.onend = () => { reacted = true; out.push('기본 음성 재생 끝남'); render(); };
    u.onerror = e => { reacted = true; out.push('오류: ' + e.error); render(); };
    utter = u;
    synth.speak(u);
    setTimeout(() => { if (!reacted && view.diag === out) { out.push('3초 동안 반응 없음'); render(); } }, 3000);
  }
  function hush() {
    gen++;
    clearTimeout(timer);
    if (synth) synth.cancel();
    if (audio) { audio.pause(); audio = null; }
    keepAwake(false);
  }

  // 목소리는 Day마다 돌아가며 바뀐다. 복습 항목은 원래 Day의 목소리로 재생한다
  function dayVoice(day) {
    return VOICES[(day === undefined ? st.day[st.level] : day) % VOICES.length];
  }
  function itemVoice(it) { return dayVoice(+it.id.split('-')[1]); }
  // 파일 이름용 FNV-1a 해시. tools/make_audio.py의 clip_key와 같은 결과를 내야 한다
  function clipKey(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function clipText(it) { return it.ex ? it.en + '. ' + it.ex : it.en; }

  // AI 음성 파일을 재생하고, 파일이 없거나 재생이 막히면 기기 음성으로 읽는다
  function play(it, onend) {
    const g = gen;
    const next = () => { if (g === gen && onend) onend(); };
    let fell = false;
    const fallback = () => {
      if (fell || g !== gen) return;
      fell = true;
      say(it.en, 'en-US', it.ex ? () => say(it.ex, 'en-US', next) : next);
    };
    audio = new Audio('audio/' + itemVoice(it).k + '/' + clipKey(clipText(it)) + '.mp3');
    audio.playbackRate = st.slow ? 0.75 : 1;
    audio.onended = next;
    audio.onerror = fallback;
    audio.play().catch(fallback);
  }
  function sayItem(it) {
    hush();
    play(it);
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
    play(it, () => wait(1200, () => play(it, () => wait(800, () => say(it.ko, 'ko-KR', () => wait(1200, () => autoStep(i + 1)))))));
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

  // ---------- 말하기: 녹음한 소리를 기기 안에서 받아 적어 채점 ----------
  // 안드로이드는 브라우저 음성 인식과 녹음이 마이크를 같이 쓰지 못해서(mic-test 5개 조합 모두 실패) Whisper로 직접 인식한다
  const ASR_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
  const ASR_MODEL = 'Xenova/whisper-tiny.en';
  let asrLoad = null;
  let asrMsg = '';
  function loadAsr() {
    if (asrLoad) return asrLoad;
    const seen = {};
    const progress = p => {
      if (st.asrReady || p.status !== 'progress' || !p.total) return;
      seen[p.file] = [p.loaded, p.total];
      const v = Object.values(seen), mb = n => Math.round(n / 1e6);
      asrMsg = '받는 중… ' + mb(v.reduce((a, x) => a + x[0], 0)) + ' / ' + mb(v.reduce((a, x) => a + x[1], 0)) + 'MB';
      const el = document.getElementById('asrGet');
      if (el) el.textContent = asrMsg;
    };
    asrMsg = '준비 중…';
    asrLoad = import(ASR_LIB)
      .then(lib => lib.pipeline('automatic-speech-recognition', ASR_MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progress }))
      .then(asr => { st.asrReady = true; save(); asrMsg = ''; return asr; })
      .catch(e => { asrLoad = null; asrMsg = ''; throw e; });
    return asrLoad;
  }
  function toPcm(blob) {
    const C = window.AudioContext || window.webkitAudioContext;
    const ctx = new C({ sampleRate: 16000 });
    return blob.arrayBuffer().then(b => ctx.decodeAudioData(b)).then(buf => { ctx.close(); return buf.getChannelData(0); });
  }
  function scoreClip(v, blob) {
    const i = v.i, target = v.items[i].en;
    const same = () => view === v && v.i === i;
    v.scoring = true;
    if (view === v) render();
    // 인식 중에는 화면이 잠시 멈추므로 "채점 중" 표시가 먼저 그려지게 한다
    setTimeout(() => {
      Promise.all([loadAsr(), toPcm(blob)]).then(r => r[0](r[1])).then(out => {
        if (!same()) return;
        const heard = out.text.trim();
        if (heard) v.result = Object.assign({ heard: heard }, match(target, heard));
        else v.recErr = 'no-speech';
      }).catch(() => { if (same()) v.recErr = 'asr'; }).then(() => {
        if (!same()) return;
        v.scoring = false;
        render();
      });
    }, 50);
  }
  // 말이 끝나고 조용해지면 자동으로 녹음을 멈춘다. 시끄러운 곳에서는 ⏹ 버튼이나 10초 제한으로 끝난다
  function watchSilence(ctx, stream, v) {
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0, quiet = 0, ticks = 0;
    const timer = setInterval(() => {
      if (++ticks <= 3) return; // 버튼 누르는 소리는 건너뛴다
      an.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length);
      peak = Math.max(peak, rms);
      if (peak > 0.01) v.voiced = true;
      quiet = v.voiced && rms < peak * 0.15 ? quiet + 100 : 0;
      if (quiet >= 1200) stopRecord();
    }, 100);
    return () => clearInterval(timer);
  }

  // ---------- 내 목소리 녹음 ----------
  let media = null;
  let micGen = 0; // 마이크가 열리기 전에 취소된 녹음을 가려낸다
  function stopRecord() { if (media && media.state !== 'inactive') media.stop(); }
  function cancelRecord() { micGen++; if (media) { media.cancelled = true; stopRecord(); } }
  function dropClip(v) { if (v.myClip) { URL.revokeObjectURL(v.myClip); v.myClip = ''; } }
  function startRecord() {
    const v = view, g = ++micGen;
    const fail = err => { v.recording = false; v.recErr = err; render(); };
    if (!navigator.mediaDevices || !window.MediaRecorder) { fail('no-record'); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    const ctx = new C(); // 버튼을 누른 순간에 만들어야 소리 크기를 읽을 수 있다
    v.recording = true;
    v.voiced = false;
    v.forceScore = false;
    v.recErr = '';
    render();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (g !== micGen) { stream.getTracks().forEach(t => t.stop()); ctx.close(); return; }
      const chunks = [];
      const mr = media = new MediaRecorder(stream);
      ctx.resume();
      const unwatch = watchSilence(ctx, stream, v);
      mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        clearTimeout(mr.limit);
        unwatch();
        ctx.close();
        stream.getTracks().forEach(t => t.stop());
        if (media === mr) media = null;
        v.recording = false;
        if (mr.cancelled) return;
        if (!chunks.length || !(v.voiced || v.forceScore)) {
          v.recErr = 'no-speech';
          if (view === v) render();
          return;
        }
        const blob = new Blob(chunks, { type: mr.mimeType });
        dropClip(v);
        v.myClip = URL.createObjectURL(blob);
        scoreClip(v, blob);
      };
      mr.start(250);
      mr.limit = setTimeout(stopRecord, 10000); // 10초 뒤 자동 종료
    }).catch(() => { ctx.close(); fail('not-allowed'); });
  }
  function playMine(onend) {
    const g = gen;
    audio = new Audio(view.myClip);
    audio.onended = () => { if (g === gen && onend) onend(); };
    audio.play().catch(() => {});
  }

  // ---------- 화면 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cur() { return view.items[view.i]; }
  function go(name, extra) {
    hush();
    cancelRecord();
    dropClip(view);
    view =Object.assign({ name: name }, extra || {});
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

  // 카카오톡·네이버 등 앱 안에서 링크를 열면 소리 기능이 없는 내장 브라우저로 열린다
  function noSoundBanner() {
    if (synth) return '';
    return '<div class="card" style="border-color:var(--no)"><p><b class="miss">이 화면에서는 일부 기능이 되지 않습니다.</b></p>' +
      '<p class="sub">카카오톡, 네이버 같은 앱 안에서 링크를 열면 한국어 뜻 읽기와 말하기 채점이 지원되지 않습니다. 오른쪽 위 메뉴(⋮)에서 "다른 브라우저로 열기"를 누르거나, 크롬 앱을 직접 열고 아래 주소를 입력하세요.</p>' +
      '<p class="sub"><b>' + esc(location.href.split('#')[0]) + '</b></p></div>';
  }

  function vHome() {
    const l = st.level, d = st.day[l], total = CONTENT[l].length;
    const due = dueItems().length;
    const done = st.doneDate[l] === today();
    return '<div class="bar"><h1>영어 10·10</h1><button class="link" data-a="pickLevel">수준: ' + LEVELS[l] + ' 변경</button></div>' +
      noSoundBanner() +
      '<div class="card"><div class="sub">Day ' + (d + 1) + ' / ' + total + '</div><h2>' + esc(CONTENT[l][d].t) + '</h2>' +
      '<p class="sub">문장 10개 · 단어 10개 · 목소리: ' + esc(dayVoice().label) + '</p>' +
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
      '<button data-a="slow">느린 음성: ' + (st.slow ? '켬' : '끔') + '</button></div>' +
      '<div class="stack"><button data-a="notes">📝 사용 후기 메모' + (st.notes.length ? ' (' + st.notes.length + ')' : '') + '</button>' +
      '<button data-a="diag">🔧 소리 진단</button></div>' +
      (view.diag ? '<div class="card" style="margin-top:10px">' + view.diag.map(x => '<p class="sub">' + esc(x) + '</p>').join('') + '</div>' : '') +
      '<p class="sub" style="text-align:center;margin-top:16px">버전 ' + VERSION + '</p>';
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
        : view.recErr === 'no-speech' ? '말소리가 들리지 않았습니다. 다시 눌러 말해 주세요.'
        : view.recErr === 'no-record' ? '이 브라우저는 녹음을 지원하지 않습니다. 크롬에서 열어 주세요.'
        : view.recErr === 'asr-get' ? '채점 모델을 받지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.'
        : '채점에 실패했습니다. 다시 눌러 말해 주세요.') + '</p>' : '';
    return bar('말하기') +
      '<div class="card prompt"><div class="ko">' + esc(it.ko) + '</div></div>' + out + err +
      '<div class="stack">' +
      (!st.asrReady
        ? '<button class="main" id="asrGet" data-a="asrGet"' + (asrMsg ? ' disabled>' + esc(asrMsg) : '>📥 채점 모델 받기 (약 40MB)') + '</button>' +
          '<p class="note">처음 한 번만 받습니다. 와이파이에서 받아 주세요.</p>'
        : view.recording
          ? '<button class="main" data-a="micStop">⏹ 듣는 중… 말을 끝냈으면 누르세요</button>'
          : '<button class="main" data-a="mic"' + (view.scoring ? ' disabled>채점 중…' : '>🎤 눌러서 말하기') + '</button>') +
      '<div class="row2" style="margin-top:0"><button data-a="play">🔊 원어민 듣기</button><button data-a="hint">영어 보기</button></div>' +
      '<button data-a="mine"' + (view.myClip && !view.recording ? '' : ' disabled') + '>▶ 내 목소리 듣기</button>' +
      (view.myClip && !view.recording ? '<button data-a="compare">🔁 원어민 → 내 목소리 이어서 듣기</button>' : '') +
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

  // 사용 후기: 이 휴대폰에만 저장되므로, 복사·공유 버튼으로 밖으로 꺼내서 전달한다
  function notesText() {
    return st.notes.map(n => '[' + n.d + ' · ' + n.where + '] ' + n.t).join('\n');
  }
  function vNotes() {
    return bar('사용 후기 메모') +
      '<p class="note">불편했던 점, 어려웠던 점, 좋았던 점을 짧게 적어 두세요. 메모는 이 휴대폰에만 저장됩니다. 전달하려면 아래 복사 또는 공유 버튼을 누르세요.</p>' +
      '<textarea id="note" rows="3" placeholder="예: 받아쓰기에서 문장이 너무 길어서 끝까지 못 들었다"></textarea>' +
      '<div class="stack"><button class="main" data-a="addNote">저장</button></div>' +
      (view.msg ? '<p class="note done">' + esc(view.msg) + '</p>' : '') +
      (st.notes.length
        ? '<div class="row2"><button data-a="copyNotes">전체 복사</button>' +
          (navigator.share ? '<button data-a="shareNotes">공유 (카톡 등)</button>' : '<span></span>') + '</div>' +
          '<h3>저장된 메모 ' + st.notes.length + '개</h3><div class="list">' +
          st.notes.slice().reverse().map((n, k) => '<div class="card" style="margin:0"><p class="sub">' + esc(n.d + ' · ' + n.where) + '</p><p>' + esc(n.t) + '</p>' +
            '<button class="link" data-a="delNote" data-i="' + (st.notes.length - 1 - k) + '">삭제</button></div>').join('') + '</div>'
        : '');
  }

  const views = { home: vHome, learn: vLearn, listen: vListen, dict: vDict, speak: vSpeak, quiz: vQuiz, done: vDone, notes: vNotes };
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
    diag: () => diagnose(),
    notes: () => go('notes'),
    addNote: () => {
      const t = document.getElementById('note').value.trim();
      if (!t) return;
      st.notes.push({ d: today(), where: LEVELS[st.level] + ' Day ' + (st.day[st.level] + 1), t: t });
      save();
      view.msg = '저장했습니다.';
      render();
    },
    delNote: i => { st.notes.splice(i, 1); save(); view.msg = ''; render(); },
    copyNotes: () => {
      const done = ok => { view.msg = ok ? '복사했습니다. Claude와의 대화창에 붙여넣으세요.' : '복사에 실패했습니다. 공유 버튼을 써 주세요.'; render(); };
      try { navigator.clipboard.writeText(notesText()).then(() => done(true), () => done(false)); } catch (e) { done(false); }
    },
    shareNotes: () => { navigator.share({ title: '영어 10·10 사용 후기', text: notesText() }).catch(() => {}); },

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
    speak: () => {
      go('speak', { items: todayItems().filter(x => x.type === 's'), i: 0 });
      if (st.asrReady) loadAsr().catch(() => {}); // 첫 채점이 빠르도록 미리 준비
    },
    quiz: () => startQuiz('day', todayItems()),
    review: () => startQuiz('review', dueItems()),

    play: () => sayItem(cur()),
    hint: () => { view.hint = !view.hint; render(); },
    asrGet: () => {
      const v = view;
      v.recErr = '';
      const p = loadAsr();
      render();
      p.catch(() => { v.recErr = 'asr-get'; }).then(() => { if (view === v) render(); });
    },
    mic: () => {
      hush();
      dropClip(view);
      view.result = null;
      startRecord();
    },
    micStop: () => { view.forceScore = true; stopRecord(); },
    mine: () => { hush(); playMine(); },
    compare: () => { hush(); play(cur(), () => wait(700, () => playMine())); },
    reveal: () => { view.revealed = true; render(); if (view.name === 'quiz') sayItem(cur()); },
    next: () => {
      if (view.i + 1 >= view.items.length) { go('home'); return; }
      hush();
      cancelRecord();
      dropClip(view);
      view.i++;
      view.revealed = false;
      view.hint = false;
      view.result = null;
      view.recErr = '';
      view.scoring = false;
      view.recording = false;
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
