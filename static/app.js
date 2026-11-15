/* SegForces — frontend (vanilla JS, no build step) */
'use strict';

(() => {
  // -------------------------------------------------------------------------
  // utils
  // -------------------------------------------------------------------------
  const TOKEN = document.querySelector('meta[name="segforces-token"]').content;
  const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl';

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  function toMs(ts) {
    if (ts == null) return null;
    return typeof ts === 'string' ? Date.parse(ts) : ts * 1000;
  }

  function ago(ts) {
    const t = toMs(ts);
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'только что';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d} ${plural(d, ['день', 'дня', 'дней'])} назад`;
    return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function fmtDur(sec) {
    if (sec == null) return '';
    if (sec < 1) return `${Math.round(sec * 1000)} мс`;
    if (sec < 60) return `${sec.toFixed(1)} с`;
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  }

  function deadlineInfo(d) {
    if (!d) return null;
    const dl = new Date(`${d}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((dl - today) / 86400000);
    const date = dl.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    if (days < 0) return { cls: 'past', text: `${date}`, title: `Дедлайн прошёл ${-days} ${plural(-days, ['день', 'дня', 'дней'])} назад`, days };
    if (days === 0) return { cls: 'urgent', text: `${date} · сегодня`, title: 'Дедлайн сегодня', days };
    const rest = `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
    return { cls: days <= 2 ? 'urgent' : days <= 7 ? 'soon' : '', text: `${date} · ${rest}`, title: `Осталось ${rest}`, days };
  }

  function diffClass(points) {
    if (!points) return '';
    if (points <= 10) return 'd-easy';
    if (points <= 30) return 'd-med';
    return 'd-hard';
  }

  const RANKS = [
    [0, 'Newbie', '#8e96a6'], [0.05, 'Pupil', '#3cbf6c'], [0.15, 'Specialist', '#27b3b3'],
    [0.3, 'Expert', '#4c8dff'], [0.45, 'Candidate Master', '#b26bff'], [0.6, 'Master', '#ff9f1a'],
    [0.75, 'International Master', '#ff7a1a'], [0.88, 'Grandmaster', '#ff4d4f'], [1, 'Legendary Grandmaster', '#ff4d4f'],
  ];
  function rankFor(earned, total) {
    const pct = total ? earned / total : 0;
    let r = RANKS[0];
    for (const x of RANKS) if (pct >= x[0]) r = x;
    return { name: r[1], color: r[2], pct };
  }

  const VERDICTS = {
    AC: 'Accepted', WA: 'Wrong answer', RE: 'Runtime error', CE: 'Compilation error', TLE: 'Time limit exceeded',
    JE: 'Judge error', OFFLINE: 'Docker не запущен', CANCELLED: 'Отменено', BLOCKED: 'Не запущено',
    TESTING: 'Testing…', QUEUED: 'In queue',
  };
  const vname = (v) => VERDICTS[v] || v || '';

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  };

  // -------------------------------------------------------------------------
  // prefs (per-browser conveniences only)
  // -------------------------------------------------------------------------
  const prefs = (() => {
    try { return JSON.parse(localStorage.getItem('sf.prefs') || '{}') || {}; } catch (e) { return {}; }
  })();
  function savePrefs() {
    try { localStorage.setItem('sf.prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
  }
  const api = {
    async req(method, path, body, signal) {
      let res;
      try {
        res = await fetch(path, {
          method, signal,
          headers: Object.assign({ 'X-SegForces-Token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ApiError('Сервер SegForces недоступен. Он запущен?', 0, { code: 'offline' });
      }
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        if (data && data.code === 'token') showTokenBanner();
        if (data && data.code === 'no_repo' && !location.hash.startsWith('#/setup')) location.hash = '#/setup';
        throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
      }
      return data;
    },
    get(path, params) {
      const qs = params ? `?${new URLSearchParams(params)}` : '';
      return this.req('GET', path + qs);
    },
    post(path, body) { return this.req('POST', path, body || {}); },
    async stream(method, path, body, onEvent, signal) {
      let res;
      try {
        res = await fetch(path, {
          method, signal,
          headers: Object.assign({ 'X-SegForces-Token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ApiError('Сервер SegForces недоступен', 0, { code: 'offline' });
      }
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch (e) { /* ignore */ }
        if (data.code === 'token') showTokenBanner();
        throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) onEvent(JSON.parse(line));
        }
      }
      if (buf.trim()) onEvent(JSON.parse(buf));
    },
  };

  let tokenBannerShown = false;
  function showTokenBanner() {
    if (tokenBannerShown) return;
    tokenBannerShown = true;
    toast('Сервер перезапустился', 'Обнови страницу (⌘R), чтобы продолжить.', 'bad', 20000);
  }

  // -------------------------------------------------------------------------
  // toasts & modals
  // -------------------------------------------------------------------------
  function toast(title, text, kind = '', ms) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const ico = kind === 'ok' ? '✅' : kind === 'bad' ? '⛔️' : kind === 'warn' ? '⚠️' : 'ℹ️';
    el.innerHTML = `<span>${ico}</span><div><b>${esc(title)}</b>${text ? `<div class="muted">${esc(text)}</div>` : ''}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 320);
    }, ms || (kind === 'bad' ? 7000 : 4200));
  }

  function openModal(html, opts = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ${opts.wide ? 'wide' : ''} ${opts.cls || ''}" role="dialog" aria-modal="true">${html}</div>`;
    $('#modal-root').appendChild(back);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (opts.onClose) opts.onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (opts.onKey) opts.onKey(e);
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    $$('[data-close]', back).forEach((b) => b.addEventListener('click', close));
    return { el: back.firstElementChild, close, isOpen: () => !closed };
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function fireConfetti(big) {
    if (typeof window.confetti !== 'function') return;
    const opts = { particleCount: big ? 160 : 70, spread: big ? 90 : 60, origin: { y: 0.75 }, scalar: big ? 1 : 0.85,
      colors: ['#ffb020', '#2fbf71', '#4c9aff', '#ff5d62', '#a78bfa'] };
    window.confetti(opts);
    if (big) setTimeout(() => window.confetti(Object.assign({}, opts, { origin: { x: 0.2, y: 0.8 }, angle: 60 })), 220);
    if (big) setTimeout(() => window.confetti(Object.assign({}, opts, { origin: { x: 0.8, y: 0.8 }, angle: 120 })), 380);
  }

  // -------------------------------------------------------------------------
  // markdown
  // -------------------------------------------------------------------------
  if (window.marked) window.marked.setOptions({ gfm: true, breaks: false });
  if (window.hljs) window.hljs.configure({ ignoreUnescapedHTML: true });
  if (window.DOMPurify) {
    window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  function md(text) {
    if (!window.marked || !window.DOMPurify) return `<pre>${esc(text)}</pre>`;
    return window.DOMPurify.sanitize(window.marked.parse(text || ''));
  }
  function highlightIn(el) {
    if (!window.hljs) return;
    $$('pre code', el).forEach((b) => {
      if (b.dataset.hl) return;
      const cls = (b.className.match(/language-(\S+)/) || [])[1];
      if (cls && !window.hljs.getLanguage(cls)) b.className = b.className.replace(/language-\S+/, 'language-plaintext');
      try { window.hljs.highlightElement(b); } catch (e) { /* ignore */ }
      b.dataset.hl = '1';
    });
  }
  const HL_LANG = { shell: 'bash', c: 'c', cpp: 'cpp', python: 'python', makefile: 'makefile', markdown: 'markdown', json: 'json', yaml: 'yaml' };
  function highlightCode(text, lang) {
    if (!window.hljs) return esc(text);
    const l = HL_LANG[lang];
    try {
      if (l && window.hljs.getLanguage(l)) return window.hljs.highlight(text, { language: l }).value;
    } catch (e) { /* fall through */ }
    return esc(text);
  }

  // -------------------------------------------------------------------------
  // global state
  // -------------------------------------------------------------------------
  const S = {
    overview: null,
    env: null,
    route: null,
    key: null,
    task: null,
    files: new Map(),
    active: null,
    editor: null,
    leftTab: 'statement',
    bottomTab: 'result',
    run: null,
    chat: null,
    consoleHistory: {},
    judgeWatch: new Map(),
    homeFilter: prefs.homeFilter || 'all',
    homeQuery: '',
  };
  const view = $('#view');

  // -------------------------------------------------------------------------
  // environment pills & modal
  // -------------------------------------------------------------------------
  async function loadEnv(force) {
    try {
      S.env = await api.get('/api/env', force ? { force: 1 } : undefined);
    } catch (e) {
      S.env = null;
    }
    renderPills();
    if (S.key && S.leftTab === 'chat') renderChatSetup();
    if (S.route && S.route.view === 'home' && S.overview) {
      renderHero();
      renderHomeBanners();
    }
    return S.env;
  }

  const DOCKER_TEXT = {
    ok: 'Docker работает — тесты гоняются в контейнерах Debian, как у грейдера',
    stopped: 'Docker не запущен — большинство тестов не запустятся',
    hung: 'Docker запущен, но не отвечает — его нужно перезапустить',
    permission: 'Нет прав на Docker — нужно добавить себя в группу docker',
    missing: 'Docker не установлен',
  };

  function dockerState() {
    const d = (S.env && S.env.docker) || {};
    return d.state || (d.running ? 'ok' : d.installed === false ? 'missing' : 'stopped');
  }

  function envStates() {
    const e = S.env || {};
    const ds = e.docker ? dockerState() : '';
    return {
      docker: !ds ? '' : ds === 'ok' ? 'ok' : ds === 'hung' ? 'warn' : 'bad',
      gh: e.gh ? (e.gh.authed ? 'ok' : 'bad') : '',
      claude: e.claude ? (e.claude.loggedIn ? 'ok' : (e.claude.installed ? 'warn' : 'bad')) : '',
    };
  }

  function renderPills() {
    const st = envStates();
    const items = [
      ['docker', 'Docker', st.docker, S.env && S.env.docker ? DOCKER_TEXT[dockerState()] : 'Проверяю Docker…'],
      ['gh', 'Грейдер', st.gh, st.gh === 'ok' ? 'gh авторизован — видны результаты проверки на GitHub' : 'gh не авторизован — результаты грейдера не видны'],
      ['claude', 'Claude', st.claude, st.claude === 'ok' ? 'Claude готов помогать' : 'claude CLI не настроен — нажми, чтобы узнать как'],
    ];
    $('#env-pills').innerHTML = items.map(([k, label, s, title]) =>
      `<button class="pill" data-env="${k}" title="${esc(title)}"><i class="dot ${s}"></i><span class="lbl">${label}</span></button>`).join('');
    renderUserChip();
  }

  function renderUserChip() {
    const lbm = lbMe();
    const user = (S.env && S.env.gh && S.env.gh.user) || (S.overview && S.overview.user) || (lbm && lbm.user);
    const chip = $('#user-chip');
    if (!user) { chip.textContent = ''; return; }
    const t = S.overview ? computeTotals() : { earned: 0, points: 1 };
    const r = rankFor(t.earned, t.points);
    chip.style.color = r.color;
    chip.title = `${r.name} · ${t.earned}/${t.points} баллов`;
    chip.textContent = user;
  }

  function isMacHost() {
    return (S.env && S.env.platform) ? S.env.platform === 'darwin' : isMac;
  }

  function dockerHelp(state) {
    const mac = isMacHost();
    switch (state) {
      case 'ok': return { text: `Работает${S.env.docker.version ? ` (Docker ${esc(S.env.docker.version)})` : ''}. Тесты гоняются в контейнерах Debian — как у грейдера.`, actions: '' };
      case 'hung': return {
        text: 'Docker Desktop запущен, но не отвечает на запросы — так бывает после сна ноутбука или долгой работы. Поможет перезапуск.',
        actions: mac ? '<button class="btn sm primary" data-act="restart-docker">Перезапустить Docker</button>' : '<span class="muted">Перезапусти: <code>sudo systemctl restart docker</code></span>',
      };
      case 'permission': return { text: 'Не хватает прав на Docker. Выполни <code>sudo usermod -aG docker $USER</code>, затем перелогинься (или <code>newgrp docker</code>).', actions: '' };
      case 'missing': return { text: mac ? 'Не установлен. Поставь Docker Desktop: <code>brew install --cask docker</code> или с docker.com.' : 'Не установлен. Поставь Docker Engine — инструкция есть в README репозитория курса.', actions: '' };
      default: return {
        text: 'Не запущен. Без него не работают тесты почти всех задач (кроме пары bash-задач).',
        actions: mac ? '<button class="btn sm primary" data-act="start-docker">Запустить Docker Desktop</button>' : '<span class="muted">Запусти: <code>sudo systemctl start docker</code></span>',
      };
    }
  }

  function openEnvModal() {
    const e = S.env || {};
    const g = e.gh || {};
    const c = e.claude || {};
    const mac = isMacHost();
    const st = envStates();
    const dh = e.docker ? dockerHelp(dockerState()) : { text: 'Проверяю…', actions: '' };
    const row = (state, title, body, actions = '') =>
      `<div class="env-row"><i class="dot ${state}"></i><div class="grow"><b>${title}</b><div class="muted">${body}</div>${actions ? `<div class="row" style="margin-top:8px">${actions}</div>` : ''}</div></div>`;
    const html = `
      <div class="modal-head"><h3>Окружение</h3><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body"><div class="env-grid">
        ${row(st.docker, 'Docker', dh.text, dh.actions)}
        ${row(st.gh, 'GitHub / грейдер', g.authed ? `gh авторизован как <b>${esc(g.user || '?')}</b>. Результаты проверки подтягиваются из GitHub Actions.`
          : g.installed ? 'gh не авторизован. Выполни в терминале <code>gh auth login</code>.'
            : `Нет gh CLI: ${mac ? '<code>brew install gh</code>' : '<code>sudo apt install gh</code> (или cli.github.com)'}, затем <code>gh auth login</code>. Без него не видно результатов грейдера — лидерборд при этом работает.`)}
        ${row(st.claude, 'Claude', c.loggedIn ? `claude CLI авторизован (${esc(c.authMethod || 'ok')}). Помощь в задачах работает.`
          : c.installed ? 'claude CLI найден, но не авторизован. В терминале запусти <code>claude</code> и выполни <code>/login</code> (один раз). Пока можно копировать промпт и вставлять его в Claude вручную.'
            : 'claude CLI не найден (необязательно). Нужны Node.js и подписка Claude: <code>npm install -g @anthropic-ai/claude-code</code>, затем <code>claude</code> → <code>/login</code>. Без него работает кнопка «Промпт» в чате.')}
        ${row(e.shellcheck ? 'ok' : '', 'shellcheck', e.shellcheck ? 'Установлен — ошибки bash подсвечиваются прямо в редакторе.' : `Не установлен (необязательно). ${mac ? '<code>brew install shellcheck</code>' : '<code>sudo apt install shellcheck</code>'} даст больше подсказок по bash в редакторе.`)}
      </div>
      <div class="dim" style="margin-top:12px;font-size:12px">Репозиторий: <code>${esc(e.repo || '—')}</code>${e.git ? ` · ветка <code>${esc(e.git.branch || '?')}</code> · ${esc(e.git.slug || 'нет GitHub remote')}` : ''} · SegForces ${esc(e.version || '')}</div>
      </div>
      <div class="modal-foot"><button class="btn" data-act="recheck">${ICON.sync} Проверить снова</button><button class="btn primary" data-close>Готово</button></div>`;
    const m = openModal(html, { wide: true });
    m.el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'start-docker') {
        m.close();
        await startDocker();
      } else if (b.dataset.act === 'restart-docker') {
        m.close();
        await restartDocker();
      } else if (b.dataset.act === 'recheck') {
        b.disabled = true;
        b.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span> Проверяю…';
        await loadEnv(true);
        m.close();
        openEnvModal();
      }
    });
  }

  async function waitForDocker(rounds) {
    for (let i = 0; i < rounds; i++) {
      await sleep(4000);
      await loadEnv(true);
      if (dockerState() === 'ok') {
        toast('Docker работает', 'Можно гонять тесты.', 'ok');
        if (S.route && S.route.view === 'home') renderHomeBanners();
        return true;
      }
    }
    toast('Docker всё ещё не отвечает', 'Загляни в Docker Desktop — может, он что-то спрашивает.', 'warn', 8000);
    return false;
  }

  async function startDocker() {
    try {
      await api.post('/api/docker/start');
      toast('Запускаю Docker Desktop…', 'Обычно это занимает 10–30 секунд.');
      return await waitForDocker(20);
    } catch (e) {
      toast('Не удалось запустить Docker', e.message, 'bad');
    }
    return false;
  }

  async function restartDocker() {
    try {
      await api.post('/api/docker/restart');
      toast('Перезапускаю Docker Desktop…', 'Закрою и открою его заново — это займёт до минуты.', '', 8000);
      return await waitForDocker(25);
    } catch (e) {
      toast('Не удалось перезапустить Docker', e.message, 'bad');
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // router
  // -------------------------------------------------------------------------
  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
    const m = h.match(/^\/p\/(Session\d+\/[\w.-]+)(?:\/(statement|tests|subs|chat))?$/);
    if (m) return { view: 'task', key: m[1], tab: m[2] };
    if (h.startsWith('/status')) return { view: 'status' };
    if (h.startsWith('/leaderboard')) return { view: 'leaderboard' };
    if (h.startsWith('/setup')) return { view: 'setup' };
    return { view: 'home' };
  }

  let routing = Promise.resolve();
  function router() {
    routing = routing.then(doRoute).catch((e) => console.error(e));
    return routing;
  }

  function markRoute(r) {
    S.route = r;
    document.body.classList.toggle('in-task', r.view === 'task');
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (r.view === 'task' ? 'home' : r.view)));
  }

  // Navigation was refused (unsaved edits): put the address bar back without re-routing.
  function stayOnTask() {
    history.replaceState(null, '', `#/p/${S.key}`);
    markRoute({ view: 'task', key: S.key });
  }

  async function doRoute() {
    const r = parseRoute();
    if (r.view !== 'task' && S.key && !(await leaveTask())) {
      stayOnTask();
      return null;
    }
    markRoute(r);
    if (r.view === 'task') return showTask(r.key, r.tab);
    if (r.view === 'status') return showStatus();
    if (r.view === 'leaderboard') return showLeaderboard();
    if (r.view === 'setup') return showSetup();
    return showHome();
  }

  function setTopCenter(html) {
    $('#top-center').innerHTML = html;
  }

  // -------------------------------------------------------------------------
  // overview / dashboard
  // -------------------------------------------------------------------------
  async function loadOverview(sync) {
    S.overview = await api.get('/api/overview', sync ? { sync: 1 } : undefined);
    renderUserChip();
    return S.overview;
  }

  let judgeSyncing = null;
  function syncJudge(force) {
    if (judgeSyncing) return judgeSyncing;
    judgeSyncing = api.post('/api/judge/sync', { force: !!force })
      .then(async (r) => {
        await loadOverview();
        if (S.route && S.route.view === 'home') { renderHero(); renderHomeBody(); }
        if (S.route && S.route.view === 'status') showStatus(true);
        if (!r.ok && r.error) console.warn('judge sync:', r.error);
        return r;
      })
      .catch((e) => console.warn(e))
      .finally(() => { judgeSyncing = null; });
    return judgeSyncing;
  }

  function taskState(t) {
    const j = t.judge;
    const l = t.local;
    const sheet = lbScore(t.name);
    if ((j && j.solved) || (sheet != null && sheet > 0)) return 'solved';
    if (t.pending) return 'pending';
    if (j && j.last && (j.last.verdict === 'TESTING' || j.last.verdict === 'QUEUED')) return 'pending';
    if (l && l.verdict === 'AC') return 'ready';
    if ((j && j.count) || sheet === 0) return 'tried';
    if (l) return 'local';
    return 'none';
  }

  // Points/solved computed on the client: grader results (gh) + the course sheet.
  function computeTotals() {
    let earned = 0;
    let points = 0;
    let solved = 0;
    const tasks = allTasksFlat();
    for (const t of tasks) {
      points += t.points || 0;
      if (taskState(t) === 'solved') {
        solved += 1;
        earned += t.points || 0;
      }
    }
    return { earned, points, solved, tasks: tasks.length };
  }

  function stIcon(state) {
    switch (state) {
      case 'solved': return '<span class="st-ico ok" title="Принято грейдером">✓</span>';
      case 'tried': return '<span class="st-ico bad" title="Сдано, но не принято">✕</span>';
      case 'ready': return '<span class="st-ico warn" title="Открытые тесты пройдены — можно сдавать">▲</span>';
      case 'pending': return '<span class="st-ico pend" title="Проверяется грейдером"></span>';
      case 'local': return '<span class="st-ico none" title="Есть локальные прогоны"></span>';
      default: return '<span class="st-ico none" title="Не начато"></span>';
    }
  }

  function heatmapHtml(activity) {
    const weeks = 20;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setDate(start.getDate() - dow - (weeks - 1) * 7);
    let cells = '';
    let total = 0;
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + w * 7 + d);
        const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        const n = (activity && activity[key]) || 0;
        total += n;
        const lvl = n === 0 ? '' : n === 1 ? 'l1' : n <= 3 ? 'l2' : n <= 6 ? 'l3' : 'l4';
        const future = day > today ? 'future' : '';
        cells += `<i class="${lvl} ${future}" title="${day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}: ${n} ${plural(n, ['попытка', 'попытки', 'попыток'])}"></i>`;
      }
    }
    return { cells, total };
  }

  async function showHome() {
    setTopCenter('');
    view.className = '';
    if (!S.overview) view.innerHTML = '<div class="dash"><div class="skeleton" style="height:150px;margin-bottom:16px"></div><div class="skeleton" style="height:420px"></div></div>';
    try {
      await loadOverview();
    } catch (e) {
      if (e.data && e.data.code === 'no_repo') return;
      view.innerHTML = `<div class="dash"><div class="banner bad"><span class="b-ico">⛔️</span><div><b>Не удалось загрузить задачи</b><div>${esc(e.message)}</div></div></div></div>`;
      return;
    }
    renderHome();
    syncJudge(false);
    loadLeaderboard(false).then(() => {
      if (S.route && S.route.view === 'home') {
        renderHero();
        renderHomeBody();
        renderUserChip();
      }
    }).catch(() => {});
  }

  function renderHero() {
    const box = $('#home-hero');
    if (!box || !S.overview) return;
    const o = S.overview;
    const t = computeTotals();
    const r = rankFor(t.earned, t.points);
    const lbm = lbMe();
    const user = o.user || (S.env && S.env.gh && S.env.gh.user) || (lbm && lbm.user) || 'student';
    const allTasks = o.sessions.flatMap((s) => s.tasks);
    const ready = allTasks.filter((x) => taskState(x) === 'ready').length;
    const upcoming = allTasks
      .filter((x) => x.deadline && taskState(x) !== 'solved' && deadlineInfo(x.deadline).days >= 0)
      .sort((a, b) => a.deadline.localeCompare(b.deadline) || (a.id || 0) - (b.id || 0));
    const nd = upcoming[0];
    const ndInfo = nd ? deadlineInfo(nd.deadline) : null;
    const ndCount = nd ? upcoming.filter((x) => x.deadline === nd.deadline).length : 0;
    const heat = heatmapHtml(o.activity);
    const localPts = allTasks.filter((x) => taskState(x) === 'ready').reduce((a, x) => a + (x.points || 0), 0);
    const nextRank = RANKS.find((x) => x[0] > r.pct);
    const toNext = nextRank ? Math.max(0, Math.ceil(nextRank[0] * t.points - t.earned)) : 0;
    box.innerHTML = `
          <div class="card profile">
            <div>
              <div class="handle" style="color:${r.color}">${esc(user)}</div>
              <div class="rank" style="color:${r.color}">${r.name}</div>
            </div>
            <div class="stats">
              <div class="stat"><b>${t.earned}<span style="font-size:14px;color:var(--text-3)"> / ${t.points}</span></b><span>баллов принято</span></div>
              <div class="stat"><b>${t.solved}<span style="font-size:14px;color:var(--text-3)"> / ${t.tasks}</span></b><span>задач решено</span></div>
              <div class="stat"><b>${ready}</b><span>готовы к сдаче</span></div>
            </div>
            <div class="bar" title="Зелёное — принято грейдером, жёлтое — открытые тесты пройдены"><i style="width:${(t.points ? t.earned / t.points * 100 : 0).toFixed(2)}%"></i><i class="local" style="width:${(t.points ? localPts / t.points * 100 : 0).toFixed(2)}%"></i></div>
            <div class="next-dl">${nd ? `Ближайший дедлайн: <b>${esc(ndInfo.text)}</b> — ${ndCount} ${plural(ndCount, ['задача', 'задачи', 'задач'])} не сдано` : 'Все дедлайны закрыты 🎉'}</div>
            ${S.leaderboard ? `<a class="lb-mini" href="#/leaderboard">${lbm ? `🏆 <b>${lbm.rank} место</b> из ${S.leaderboard.count} в таблице курса · ${fmtNum(lbm.sum)} ${plural(Math.round(lbm.sum || 0), ['балл', 'балла', 'баллов'])}` : '🏆 Лидерборд курса — найди себя'} <span class="dim">→</span></a>` : ''}
          </div>
          <div class="card heat-card">
            <h3>Активность: ${heat.total} ${plural(heat.total, ['попытка', 'попытки', 'попыток'])} за 20 недель</h3>
            <div class="heat">${heat.cells}</div>
            <div class="heat-legend"><span>Прогоны тестов и посылки по дням</span><span>${nextRank ? `до <b style="color:${nextRank[2]}">${nextRank[1]}</b>: ${toNext} ${plural(toNext, ['балл', 'балла', 'баллов'])}` : 'максимальный ранг 👑'}</span></div>
          </div>`;
  }

  function renderHome() {
    view.innerHTML = `
      <div class="dash">
        <section class="hero" id="home-hero"></section>
        <div class="banners" id="home-banners"></div>
        <div class="toolbar">
          <label class="search">${ICON.search}<input id="home-q" placeholder="Поиск задачи…  (${MOD}K — везде)" value="${esc(S.homeQuery)}"></label>
          <div class="chips" id="home-chips">
            ${[['all', 'Все'], ['todo', 'Не решённые'], ['ready', 'Готовы к сдаче'], ['solved', 'Решённые']].map(([k, l]) =>
              `<button class="chip ${S.homeFilter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}
          </div>
          <span class="spacer"></span>
          <button class="btn sm ghost" id="sync-btn" title="Подтянуть результаты грейдера с GitHub">${ICON.sync} Обновить</button>
        </div>
        <div id="home-sessions"></div>
      </div>`;
    renderHero();
    renderHomeBanners();
    renderHomeBody();
    const q = $('#home-q');
    q.addEventListener('input', () => { S.homeQuery = q.value; renderHomeBody(); });
    $('#home-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      S.homeFilter = b.dataset.filter;
      prefs.homeFilter = S.homeFilter;
      savePrefs();
      $$('#home-chips .chip').forEach((c) => c.classList.toggle('on', c === b));
      renderHomeBody();
    });
    $('#sync-btn').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      await syncJudge(true);
      b.disabled = false;
      toast('Обновлено', 'Результаты грейдера подтянуты с GitHub.', 'ok');
    });
  }

  function renderHomeBanners() {
    const box = $('#home-banners');
    if (!box) return;
    const e = S.env;
    const out = [];
    const rh = S.overview && S.overview.repo_health;
    if (rh && !rh.ok) {
      out.push(`<div class="banner bad"><span class="b-ico">📂</span><div>
        <b>Файлы репозитория сейчас не читаются.</b> Папка недоступна или отдаёт файлы очень медленно, поэтому тесты и редактор пока не работают.
        <div class="dim" style="margin-top:4px;font-size:12px">${esc(rh.error || '')}</div></div>
        <div class="b-actions"><button class="btn sm" data-act="recheck">Проверить снова</button></div></div>`);
    }
    const ds = e && e.docker ? dockerState() : 'ok';
    if (ds !== 'ok') {
      const mac = isMacHost();
      const btn = ds === 'hung' && mac ? '<button class="btn sm" data-act="restart-docker">Перезапустить</button>'
        : ds === 'stopped' && mac ? '<button class="btn sm" data-act="start-docker">Запустить</button>'
          : '<button class="btn sm" data-act="env">Как исправить</button>';
      const head = { hung: 'Docker не отвечает.', permission: 'Нет прав на Docker.', missing: 'Docker не установлен.' }[ds] || 'Docker не запущен.';
      out.push(`<div class="banner warn"><span class="b-ico">🐳</span><div><b>${head}</b> Тесты почти всех задач гоняются в контейнерах — без Docker кнопка ▶ не сработает.</div><div class="b-actions">${btn}</div></div>`);
    }
    if (e && e.claude && !e.claude.loggedIn) {
      out.push(`<div class="banner info"><span class="b-ico">✦</span><div><b>Claude пока не подключён.</b> ${e.claude.installed ? 'Чтобы спрашивать помощь прямо в задаче, один раз выполни в терминале <code>claude</code> → <code>/login</code>.' : 'Для помощи в задачах нужен claude CLI (необязательно).'} До этого можно копировать готовый промпт кнопкой в чате.</div><div class="b-actions"><button class="btn sm" data-act="env">Подробнее</button></div></div>`);
    }
    if (S.overview && S.overview.judge && !S.overview.judge.available) {
      out.push(`<div class="banner warn"><span class="b-ico">🔌</span><div><b>Результаты грейдера недоступны.</b> Нужен авторизованный <code>gh</code> и remote на GitHub.</div></div>`);
    }
    box.innerHTML = out.join('');
    box.onclick = (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'start-docker') startDocker().then(renderHomeBanners);
      if (b.dataset.act === 'restart-docker') restartDocker().then(renderHomeBanners);
      if (b.dataset.act === 'env') openEnvModal();
      if (b.dataset.act === 'recheck') {
        b.disabled = true;
        b.textContent = 'Проверяю…';
        api.get('/api/overview', { recheck: 1 }).then((o) => {
          S.overview = o;
          renderHome();
          if (o.repo_health && o.repo_health.ok) toast('Репозиторий снова читается', 'Можно работать.', 'ok');
        }).catch((err) => toast('Не получилось', err.message, 'bad'));
      }
    };
  }

  function matchesQuery(t, q) {
    if (!q) return true;
    const hay = `${t.title} ${t.name} ${t.key} ${t.snum}${t.letter}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function renderHomeBody() {
    const box = $('#home-sessions');
    if (!box || !S.overview) return;
    const collapsed = new Set(prefs.collapsed || []);
    const html = [];
    for (const s of S.overview.sessions) {
      const tasks = s.tasks.filter((t) => {
        if (!matchesQuery(t, S.homeQuery)) return false;
        const st = taskState(t);
        if (S.homeFilter === 'todo') return st !== 'solved';
        if (S.homeFilter === 'solved') return st === 'solved';
        if (S.homeFilter === 'ready') return st === 'ready';
        return true;
      });
      if (!tasks.length) continue;
      const dl = deadlineInfo(s.deadline);
      const earned = s.tasks.filter((x) => taskState(x) === 'solved').reduce((a, x) => a + (x.points || 0), 0);
      const pct = s.points ? (earned / s.points) * 100 : 0;
      const isCollapsed = collapsed.has(s.name) && !S.homeQuery;
      html.push(`
        <section class="session ${isCollapsed ? 'collapsed' : ''}" data-session="${s.name}">
          <div class="session-head" data-toggle="${s.name}">
            <span class="chev">▾</span>
            <h2>Сессия ${s.num}</h2>
            ${dl ? `<span class="dl ${dl.cls}" title="${esc(dl.title)}">⏰&nbsp; ${esc(dl.text)}</span>` : ''}
            <span class="spacer"></span>
            <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
            <span class="pts">${earned} / ${s.points}</span>
          </div>
          <table class="problems"><tbody>
            ${tasks.map((t) => problemRow(t)).join('')}
          </tbody></table>
        </section>`);
    }
    box.innerHTML = html.join('') || '<div class="empty"><span class="big">🔎</span>Ничего не нашлось</div>';
    box.onclick = (e) => {
      const tog = e.target.closest('[data-toggle]');
      if (tog) {
        const name = tog.dataset.toggle;
        const set = new Set(prefs.collapsed || []);
        if (set.has(name)) set.delete(name); else set.add(name);
        prefs.collapsed = Array.from(set);
        savePrefs();
        tog.parentElement.classList.toggle('collapsed');
        return;
      }
      const row = e.target.closest('tr[data-key]');
      if (row) location.hash = `#/p/${row.dataset.key}`;
    };
  }

  function problemRow(t) {
    const st = taskState(t);
    const rowCls = st === 'solved' ? 'solved' : st === 'tried' ? 'tried' : st === 'ready' ? 'ready' : '';
    const dl = deadlineInfo(t.deadline);
    const j = t.judge && t.judge.last;
    let judgeCell = '<span class="dim">—</span>';
    if (t.pending) judgeCell = `<span class="vtext v-QUEUED">In queue</span><div class="vsub">отправлено ${esc(ago(t.pending.at))}</div>`;
    else if (j) {
      const v = t.judge.solved && j.verdict !== 'AC' ? `<span class="vtext v-AC">Accepted</span><div class="vsub">потом: ${esc(vname(j.verdict))}</div>`
        : `<span class="vtext v-${j.verdict}">${esc(vname(j.verdict))}</span><div class="vsub">${esc(ago(j.created))}${t.judge.count > 1 ? ` · ${t.judge.count} ${plural(t.judge.count, ['попытка', 'попытки', 'попыток'])}` : ''}</div>`;
      judgeCell = v;
    } else {
      const sheet = lbScore(t.name);
      if (sheet != null) {
        judgeCell = sheet > 0
          ? `<span class="vtext v-AC">Accepted</span><div class="vsub">${fmtNum(sheet)} балл. · по таблице курса</div>`
          : '<span class="vtext v-WA">0 баллов</span><div class="vsub">по таблице курса</div>';
      }
    }
    const l = t.local;
    let localCell = '<span class="dim">—</span>';
    if (l) {
      const tests = l.total != null ? ` ${l.passed}/${l.total}` : '';
      localCell = `<span class="vtext v-${l.verdict}">${l.verdict === 'AC' ? 'OK' : esc(l.verdict)}${tests}</span><div class="vsub">${esc(ago(l.at))}</div>`;
    }
    const kind = t.key.startsWith('Session01/') ? 'bash' : 'c';
    return `<tr class="prow ${rowCls}" data-key="${esc(t.key)}">
      <td class="st">${stIcon(st)}</td>
      <td class="pid">${t.snum}${t.letter}</td>
      <td><div class="ptitle">${esc(t.title)}</div><div class="pname">${esc(t.name)}</div></td>
      <td class="hide-sm"><span class="tag ${kind}">${kind === 'bash' ? 'bash' : 'C'}</span></td>
      <td><span class="pts-badge ${diffClass(t.points)}">${t.points || '—'}</span></td>
      <td class="hide-sm" title="Последний локальный прогон открытых тестов">${localCell}</td>
      <td title="Последняя проверка грейдером (скрытые тесты)">${judgeCell}</td>
      <td class="hide-sm">${dl ? `<span class="dl ${st === 'solved' ? '' : dl.cls}" title="${esc(dl.title)}">${esc(dl.text)}</span>` : ''}</td>
    </tr>`;
  }

  // -------------------------------------------------------------------------
  // status page (all grader submissions)
  // -------------------------------------------------------------------------
  async function showStatus(silent) {
    setTopCenter('');
    view.className = '';
    if (!silent) view.innerHTML = '<div class="page"><div class="skeleton" style="height:300px"></div></div>';
    let items = [];
    let err = null;
    try {
      if (!S.overview) await loadOverview();
      items = (await api.get('/api/judge/history')).items;
    } catch (e) {
      err = e.message;
    }
    if (S.route.view !== 'status') return;
    const titles = {};
    if (S.overview) S.overview.sessions.forEach((s) => s.tasks.forEach((t) => { titles[t.key] = t; }));
    view.innerHTML = `
      <div class="page">
        <div class="row"><div class="grow"><h1>Посылки</h1><div class="sub">Все проверки грейдером (GitHub Actions). Локальные прогоны — во вкладке «Посылки» каждой задачи.</div></div>
        <button class="btn sm" id="st-sync">${ICON.sync} Обновить</button></div>
        ${err ? `<div class="banner bad"><span class="b-ico">⛔️</span><div>${esc(err)}</div></div>` : ''}
        ${items.length ? `<table class="grid"><thead><tr><th>Когда</th><th>Задача</th><th>Вердикт</th><th>Тесты</th><th>Коммит</th><th></th></tr></thead><tbody>
          ${items.map((it) => {
            const t = titles[it.key];
            const ff = it.first_failed && it.first_failed.index ? ` on test ${it.first_failed.index}` : '';
            return `<tr class="click" data-go="${esc(it.key)}">
              <td class="nowrap" title="${esc(it.created || '')}">${esc(ago(it.created))}</td>
              <td>${t ? `<span class="dim mono">${t.snum}${t.letter}</span> ${esc(t.title)}` : esc(it.key)}</td>
              <td><span class="vtext v-${it.verdict}">${esc(vname(it.verdict))}${esc(ff)}</span></td>
              <td class="mono">${it.total != null ? `${it.passed}/${it.total}` : '—'}</td>
              <td class="mono dim">${esc((it.sha || '').slice(0, 7))}</td>
              <td><a href="${esc(it.url || '#')}" target="_blank" rel="noopener" data-stop>GitHub ↗</a></td>
            </tr>`;
          }).join('')}</tbody></table>`
          : `<div class="empty card"><span class="big">📭</span>Посылок пока нет. Открой задачу и нажми «Отправить».</div>`}
      </div>`;
    $('#st-sync').addEventListener('click', () => syncJudge(true));
    view.onclick = (e) => {
      if (e.target.closest('[data-stop]')) return;
      const tr = e.target.closest('[data-go]');
      if (tr) location.hash = `#/p/${tr.dataset.go}/subs`;
    };
  }

  // -------------------------------------------------------------------------
  // leaderboard (the course's public Google Sheet)
  // -------------------------------------------------------------------------
  const MEDALS = ['🥇', '🥈', '🥉'];
  const fmtNum = (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

  async function loadLeaderboard(force) {
    S.leaderboard = await api.get('/api/leaderboard', force ? { force: 1 } : undefined);
    return S.leaderboard;
  }

  function lbMe() {
    return S.leaderboard ? S.leaderboard.rows.find((r) => r.me) : null;
  }

  // Official per-task points of the current student from the sheet (works without gh).
  function lbScore(name) {
    const me = lbMe();
    return me && me.scores ? me.scores[name] : undefined;
  }

  function lbSessions(lb) {
    const by = new Map();
    for (const name of lb.tasks) {
      const meta = lb.task_meta[name];
      if (!meta) continue;
      if (!by.has(meta.session)) by.set(meta.session, { num: meta.session, tasks: [], max: 0 });
      const s = by.get(meta.session);
      s.tasks.push(name);
      s.max += meta.points || 0;
    }
    return Array.from(by.values()).sort((a, b) => a.num - b.num);
  }

  function avatar(user, size) {
    return `<img class="ava" src="https://github.com/${encodeURIComponent(user)}.png?size=${size * 2}" width="${size}" height="${size}" alt="" loading="lazy" referrerpolicy="no-referrer" data-i="${esc((user[0] || '?').toUpperCase())}">`;
  }

  function fixAvatars(root) {
    $$('img.ava', root).forEach((img) => {
      img.addEventListener('error', () => {
        const fb = document.createElement('span');
        fb.className = 'ava ava-fb';
        fb.style.width = fb.style.height = `${img.width}px`;
        fb.textContent = img.dataset.i;
        img.replaceWith(fb);
      }, { once: true });
    });
  }

  async function showLeaderboard() {
    setTopCenter('');
    view.className = '';
    if (S.leaderboard) renderLeaderboard();
    else view.innerHTML = '<div class="page"><div class="skeleton" style="height:150px;margin-bottom:14px"></div><div class="skeleton" style="height:420px"></div></div>';
    try {
      await loadLeaderboard(false);
    } catch (e) {
      if (S.route.view !== 'leaderboard') return;
      view.innerHTML = `<div class="page"><h1>Лидерборд</h1>
        <div class="banner bad"><span class="b-ico">⛔️</span><div><b>Не получилось загрузить таблицу.</b> ${esc(e.message)}</div>
        <div class="b-actions"><button class="btn sm" id="lb-settings">Настройки</button></div></div></div>`;
      $('#lb-settings').addEventListener('click', () => openSettings());
      return;
    }
    if (S.route.view === 'leaderboard') renderLeaderboard();
  }

  function renderLeaderboard() {
    const lb = S.leaderboard;
    const sessions = lbSessions(lb);
    const me = lbMe();
    const ranked = lb.rows.filter((r) => !r.reference && !r.meta);
    const maxSum = lb.max_sum || Math.max(1, ...ranked.map((r) => r.sum || 0));
    const pct = (r) => (r.percent != null ? r.percent : ((r.sum || 0) / maxSum) * 100);
    let meCard;
    if (me) {
      const above = ranked.filter((r) => (r.sum || 0) > (me.sum || 0));
      const next = above[above.length - 1];
      meCard = `<div class="card lb-me">${avatar(me.user, 48)}
        <div class="grow"><div class="lb-me-title">${me.rank} место <span class="dim">из ${lb.count}</span></div>
        <div class="muted">${fmtNum(me.sum)} баллов · ${fmtNum(pct(me))}% · решено задач: ${me.solved}</div></div>
        <div class="lb-next">${next ? `до ${next.rank} места — <b>${fmtNum(next.sum - me.sum)}</b> ${plural(Math.ceil(next.sum - me.sum), ['балл', 'балла', 'баллов'])}` : '👑 ты на первом месте'}</div></div>`;
    } else {
      meCard = `<div class="banner info"><span class="b-ico">🙋</span><div><b>Найди себя в таблице.</b> ${lb.me ? `Логина <code>${esc(lb.me)}</code> в ней нет.` : 'Не знаю твой GitHub-логин (gh не авторизован).'} Нажми на свою строку и выбери «Это я».</div></div>`;
    }
    const top = ranked.slice(0, 3);
    const podium = top.length === 3 ? `<div class="podium">${[1, 0, 2].map((i) => {
      const r = top[i];
      return `<div class="pod pod-${i + 1}" data-user="${esc(r.user)}">${avatar(r.user, i === 0 ? 68 : 54)}
        <div class="pod-name" title="${esc(r.user)}">${esc(r.user)}</div><div class="pod-pts">${fmtNum(r.sum)}</div>
        <div class="pod-step"><span>${MEDALS[r.rank - 1] || r.rank}</span></div></div>`;
    }).join('')}</div>` : '';
    const rowHtml = (r) => {
      const p = pct(r);
      const unranked = r.reference || r.meta;
      return `<tr class="lb-row ${r.me ? 'me' : ''} ${unranked ? 'ref' : ''}" data-user="${esc(r.user)}">
        <td class="lb-rank">${unranked ? '<span class="dim">—</span>' : (MEDALS[r.rank - 1] || r.rank)}</td>
        <td><div class="lb-user">${r.meta ? '<span class="ava ava-fb" style="width:28px;height:28px">Σ</span>' : avatar(r.user, 28)}<span class="lb-name">${esc(r.user)}</span>${r.me ? '<span class="you">ты</span>' : ''}${r.reference ? '<span class="tag">эталон</span>' : ''}${r.meta ? '<span class="tag">служебная строка</span>' : ''}</div></td>
        <td class="lb-sum">${fmtNum(r.sum)}</td>
        <td class="hide-sm"><div class="lb-pct"><div class="bar"><i style="width:${Math.min(100, p).toFixed(1)}%"></i></div><span>${fmtNum(p)}%</span></div></td>
        <td class="hide-sm mono">${r.solved}</td>
        <td class="hide-sm"><div class="lb-sess">${sessions.map((s) => {
          const got = s.tasks.reduce((a, t) => a + (r.scores[t] || 0), 0);
          const ratio = s.max ? got / s.max : 0;
          const lvl = ratio <= 0 ? '' : ratio < 0.34 ? 'l1' : ratio < 0.67 ? 'l2' : ratio < 1 ? 'l3' : 'l4';
          return `<i class="${lvl}" title="Сессия ${s.num}: ${fmtNum(got)} из ${s.max}"></i>`;
        }).join('')}</div></td>
      </tr>`;
    };
    view.innerHTML = `
      <div class="page lb-page">
        <div class="row" style="align-items:flex-end;margin-bottom:14px">
          <div class="grow"><h1>Лидерборд</h1>
            <div class="sub" style="margin:0">Официальная таблица курса · ${lb.count} ${plural(lb.count, ['участник', 'участника', 'участников'])} · обновлено ${esc(ago(lb.fetched_at))} · <a href="${esc(lb.source)}" target="_blank" rel="noopener">открыть таблицу ↗</a></div></div>
          <button class="btn sm ghost" id="lb-cfg" title="Ссылка на таблицу и «кто я»">⚙ Настройки</button>
          <button class="btn sm" id="lb-refresh">${ICON.sync} Обновить</button>
        </div>
        ${lb.stale ? `<div class="banner warn"><span class="b-ico">⚠️</span><div>Показываю сохранённую версию: ${esc(lb.error || '')}</div></div>` : ''}
        ${meCard}
        ${podium}
        <table class="grid lb-table"><thead><tr><th style="width:52px">#</th><th>Участник</th><th>Баллы</th><th class="hide-sm">Прогресс</th><th class="hide-sm">Задач</th><th class="hide-sm">По сессиям</th></tr></thead>
          <tbody>${lb.rows.map(rowHtml).join('')}</tbody></table>
        <div class="dim" style="font-size:12px;margin-top:10px">Нажми на строку, чтобы увидеть задачи. Цвет квадратиков — доля баллов за сессию.</div>
      </div>`;
    fixAvatars(view);
    $('#lb-refresh').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await loadLeaderboard(true);
        renderLeaderboard();
        toast('Лидерборд обновлён', '', 'ok');
      } catch (err) {
        toast('Не обновилось', err.message, 'bad');
        b.disabled = false;
      }
    });
    $('#lb-cfg').addEventListener('click', () => openSettings());
    view.onclick = (e) => {
      const me2 = e.target.closest('[data-me]');
      if (me2) { setLeaderboardMe(me2.dataset.me); return; }
      const row = e.target.closest('.lb-row, .pod');
      if (!row) return;
      toggleLbDetail(row.dataset.user);
    };
    if (me) {
      const tr = $(`.lb-row.me`, view);
      if (tr && !tr.dataset.shown) toggleLbDetail(me.user, true);
    }
  }

  function toggleLbDetail(user, quiet) {
    const lb = S.leaderboard;
    const tr = $$('.lb-row', view).find((x) => x.dataset.user === user);
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('lb-detail')) { next.remove(); return; }
    const r = lb.rows.find((x) => x.user === user);
    const sessions = lbSessions(lb);
    const chips = sessions.map((s) => `<div class="lb-dsess"><span class="lb-dlabel">С${s.num}</span>${s.tasks.map((t) => {
      const v = r.scores[t];
      const m = lb.task_meta[t] || {};
      const cls = v == null ? 'none' : v > 0 ? 'ok' : 'zero';
      return `<span class="lb-chip ${cls}" title="${esc(m.title || t)} · ${v == null ? 'не сдавалось' : `${fmtNum(v)} из ${m.points || '?'}`}">${m.letter || ''} ${esc(t)}${v != null ? ` <b>${fmtNum(v)}</b>` : ''}</span>`;
    }).join('')}</div>`).join('');
    const marks = Object.entries(r.marks || {}).map(([k, v]) => `<span class="tag">${esc(k)}: ${esc(v)}</span>`).join(' ');
    const row = document.createElement('tr');
    row.className = 'lb-detail';
    row.innerHTML = `<td></td><td colspan="5"><div class="lb-dbox">
      ${chips || '<span class="dim">Нет данных по задачам</span>'}
      <div class="row" style="margin-top:8px">${marks}<span class="spacer"></span>
        ${r.meta ? '' : `<a class="btn xs ghost" href="https://github.com/${encodeURIComponent(r.user)}" target="_blank" rel="noopener">GitHub ↗</a>`}
        ${r.reference || r.meta || r.me ? '' : `<button class="btn xs" data-me="${esc(r.user)}">Это я</button>`}</div></div></td>`;
    tr.after(row);
    tr.dataset.shown = '1';
    if (!quiet) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function setLeaderboardMe(user) {
    try {
      await api.post('/api/config', { leaderboard_me: user });
      await loadLeaderboard(false);
      toast('Запомнил', `Ты — ${user}. Поменять можно в настройках.`, 'ok');
      if (S.route.view === 'leaderboard') renderLeaderboard();
    } catch (e) {
      toast('Не сохранилось', e.message, 'bad');
    }
  }

  // -------------------------------------------------------------------------
  // settings & first-run setup
  // -------------------------------------------------------------------------
  async function openSettings() {
    let cfg;
    try { cfg = await api.get('/api/config'); } catch (e) { toast('Не открылись настройки', e.message, 'bad'); return; }
    const users = S.leaderboard ? S.leaderboard.rows.filter((r) => !r.reference && !r.meta).map((r) => r.user) : [];
    const m = openModal(`
      <div class="modal-head"><h3>Настройки</h3><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">
        <div class="section-label" style="margin-top:0">Репозиторий курса</div>
        <div class="row"><code class="grow" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${esc(cfg.repo || 'не выбран')}</code><a class="btn sm" href="#/setup" data-close>Сменить…</a></div>
        <div class="section-label">Таблица лидерборда</div>
        <input class="text-input" id="cfg-lb" placeholder="${esc(cfg.leaderboard_default)}" value="${esc(cfg.leaderboard_url === cfg.leaderboard_default ? '' : cfg.leaderboard_url)}">
        <div class="dim" style="font-size:12px;margin-top:4px">Пусто — таблица курса по умолчанию. Подойдёт любая Google Таблица с доступом по ссылке.</div>
        <div class="section-label">Кто я в лидерборде</div>
        <input class="text-input" id="cfg-me" list="cfg-users" placeholder="GitHub-логин (по умолчанию берётся из gh)" value="${esc(cfg.leaderboard_me || '')}">
        <datalist id="cfg-users">${users.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
        <div class="dim" style="font-size:12px;margin-top:12px;line-height:1.6">Данные SegForces: <code>${esc(cfg.data_dir || '—')}</code><br>Настройки: <code>${esc(cfg.config_path)}</code> · версия ${esc(cfg.version)}</div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>Отмена</button><button class="btn primary" id="cfg-save">Сохранить</button></div>`);
    $('#cfg-save', m.el).addEventListener('click', async () => {
      try {
        await api.post('/api/config', {
          leaderboard_url: $('#cfg-lb', m.el).value.trim(),
          leaderboard_me: $('#cfg-me', m.el).value.trim(),
        });
        m.close();
        S.leaderboard = null;
        toast('Сохранено', '', 'ok');
        if (S.route.view === 'leaderboard') showLeaderboard();
        else loadLeaderboard(false).then(() => { if (S.route.view === 'home') { renderHero(); renderHomeBody(); } }).catch(() => {});
      } catch (e) {
        toast('Не сохранилось', e.message, 'bad');
      }
    });
  }

  async function showSetup() {
    setTopCenter('');
    view.className = '';
    view.innerHTML = `
      <div class="page setup">
        <div class="card setup-card-big">
          <div class="brand-mark" style="width:44px;height:44px;font-size:18px;border-radius:12px">SF</div>
          <h1>Где твой репозиторий курса?</h1>
          <p class="muted">SegForces работает с твоим <code>Practice-Имя.Фамилия</code> — тем, что ты склонировал по инструкции курса. Выбери его ниже или впиши путь.</p>
          <div class="section-label">Нашёл на этом компьютере</div>
          <div id="setup-cands" class="setup-cands"><div class="row dim"><span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Ищу папки Practice-*…</div></div>
          <div class="section-label">Или путь вручную</div>
          <div class="row"><input class="text-input grow" id="setup-path" placeholder="~/Practice-Name.Surname"><button class="btn primary" id="setup-go">Открыть</button></div>
          <div id="setup-err"></div>
          <div class="dim" style="font-size:12px;margin-top:12px">Выбор запомнится. Поменять можно в настройках (⚙ вверху).</div>
        </div>
      </div>`;
    const use = async (path) => {
      $('#setup-err').innerHTML = '';
      try {
        await api.post('/api/setup/repo', { path });
        S.overview = null;
        S.leaderboard = null;
        toast('Репозиторий подключён', path, 'ok');
        loadEnv(true);
        location.hash = '#/';
      } catch (e) {
        $('#setup-err').innerHTML = `<div class="note err" style="margin-top:10px">${esc(e.message)}</div>`;
      }
    };
    $('#setup-go').addEventListener('click', () => use($('#setup-path').value.trim()));
    $('#setup-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') use(e.target.value.trim()); });
    try {
      const r = await api.get('/api/setup/candidates');
      if (S.route.view !== 'setup') return;
      const box = $('#setup-cands');
      box.innerHTML = r.candidates.length
        ? r.candidates.map((p) => `<button class="setup-cand ${p === r.current ? 'on' : ''}" data-path="${esc(p)}"><b>${esc(p.split('/').pop())}</b><span class="dim mono">${esc(p.replace(r.home, '~'))}</span></button>`).join('')
        : '<div class="dim">Не нашёл автоматически — впиши путь ниже.</div>';
      box.onclick = (e) => {
        const b = e.target.closest('[data-path]');
        if (b) use(b.dataset.path);
      };
      if (r.current) $('#setup-path').value = r.current;
    } catch (e) {
      $('#setup-cands').innerHTML = `<div class="note err">${esc(e.message)}</div>`;
    }
  }

  // -------------------------------------------------------------------------
  // Monaco
  // -------------------------------------------------------------------------
  let monacoPromise = null;
  function loadMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      if (!window.require || !window.require.config) {
        reject(new Error('Monaco loader не загрузился (нет интернета?)'));
        return;
      }
      window.MonacoEnvironment = {
        getWorkerUrl() {
          return `data:text/javascript;charset=utf-8,${encodeURIComponent(
            `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`)}`;
        },
      };
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
      window.require(['vs/editor/editor.main'], () => {
        setupMonaco(window.monaco);
        resolve(window.monaco);
      }, (err) => reject(err));
    });
    return monacoPromise;
  }

  function setupMonaco(monaco) {
    monaco.editor.defineTheme('sf-dark', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '6f7889', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff9e64' },
        { token: 'string', foreground: 'a6e3a1' },
        { token: 'number', foreground: 'f9c56b' },
        { token: 'variable', foreground: '89c4ff' },
        { token: 'type', foreground: 'c4a7ff' },
        { token: 'type.identifier', foreground: 'ffcc66' },
      ],
      colors: {
        'editor.background': '#0e1117', 'editor.lineHighlightBackground': '#151a23', 'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': '#394154', 'editorLineNumber.activeForeground': '#a7afbf',
        'editor.selectionBackground': '#2b3753', 'editorCursor.foreground': '#ffb020',
        'editorIndentGuide.background1': '#1c2130', 'editorWhitespace.foreground': '#2d3446',
        'editorGutter.background': '#0e1117', 'editorWidget.background': '#161a23', 'editorWidget.border': '#2f3646',
      },
    });
    monaco.editor.defineTheme('sf-light', {
      base: 'vs', inherit: true,
      rules: [{ token: 'comment', foreground: '8a93a3', fontStyle: 'italic' }],
      colors: { 'editor.background': '#ffffff', 'editorCursor.foreground': '#e08a00', 'editor.lineHighlightBackground': '#f6f7fa' },
    });
    if (!monaco.languages.getLanguages().some((l) => l.id === 'makefile')) {
      monaco.languages.register({ id: 'makefile' });
      monaco.languages.setMonarchTokensProvider('makefile', {
        tokenizer: {
          root: [
            [/^\s*#.*$/, 'comment'],
            [/\s#.*$/, 'comment'],
            [/^(\.PHONY|\.SUFFIXES|\.DEFAULT)(?=\s*:)/, 'keyword'],
            [/^[\w.%/$()-]+(?=\s*::?(?!=))/, 'type.identifier'],
            [/^\s*[\w.]+(?=\s*(?::=|\+=|\?=|=))/, 'variable'],
            [/\$[@<^?*%+]/, 'variable'],
            [/\$\([^)]*\)/, 'variable'],
            [/\$\{[^}]*\}/, 'variable'],
            [/\b(ifeq|ifneq|ifdef|ifndef|else|endif|include|define|endef|export|override)\b/, 'keyword'],
            [/"[^"]*"|'[^']*'/, 'string'],
            [/-[A-Za-z][\w-]*/, 'type'],
          ],
        },
      });
    }
    monaco.languages.registerCodeActionProvider(['shell', 'makefile'], {
      provideCodeActions(model, _range, context) {
        const actions = [];
        for (const m of context.markers) {
          if (m.code === 'SF001') {
            actions.push({
              title: 'Добавить #!/bin/bash первой строкой', kind: 'quickfix', diagnostics: [m], isPreferred: true,
              edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(1, 1, 1, 1), text: '#!/bin/bash\n' } }] },
            });
          } else if (m.code === 'MF001') {
            const line = model.getLineContent(m.startLineNumber);
            const lead = line.match(/^ +/);
            if (lead) {
              actions.push({
                title: 'Заменить пробелы на TAB', kind: 'quickfix', diagnostics: [m], isPreferred: true,
                edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(m.startLineNumber, 1, m.startLineNumber, lead[0].length + 1), text: '\t' } }] },
              });
            }
          }
        }
        return { actions, dispose() {} };
      },
    });
  }

  function monacoTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'sf-light' : 'sf-dark';
  }

  // -------------------------------------------------------------------------
  // lint (built-in, cheap, learner-oriented)
  // -------------------------------------------------------------------------
  function lintShell(model) {
    const out = [];
    const n = model.getLineCount();
    const first = model.getLineContent(1);
    if (!first.startsWith('#!')) {
      out.push({ sev: 'error', line: 1, c1: 1, c2: Math.max(first.length, 1) + 1, code: 'SF001',
        msg: 'Нет shebang. Первой строкой должно быть #!/bin/bash — иначе тесты упадут с «Exec format error». (⌘. — исправить)' });
    } else if (!/^#!\s*\/(bin|usr\/bin)\/(env\s+)?(ba)?sh\b/.test(first)) {
      out.push({ sev: 'warning', line: 1, c1: 1, c2: first.length + 1, code: 'SF009', msg: 'Необычный shebang. В тестах есть /bin/bash — используй #!/bin/bash.' });
    } else if (/^#!\s*\/bin\/sh\b/.test(first)) {
      out.push({ sev: 'info', line: 1, c1: 1, c2: first.length + 1, code: 'SF010', msg: '/bin/sh в Debian — это dash, а не bash: [[ ]], массивы и ${var,,} там не работают.' });
    }
    if (model.getEOL() === '\r\n') {
      out.push({ sev: 'error', line: 1, c1: 1, c2: 2, code: 'SF002', msg: 'Windows-переводы строк (CRLF). bash споткнётся о \\r — переключи на LF в строке состояния.' });
    }
    let inHeredoc = null;
    for (let i = 1; i <= n; i++) {
      const raw = model.getLineContent(i);
      if (inHeredoc) {
        if (raw.trim() === inHeredoc) inHeredoc = null;
        continue;
      }
      const hd = raw.match(/<<-?\s*['"]?(\w+)['"]?/);
      if (hd) inHeredoc = hd[1];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const code = raw.replace(/\s#.*$/, '');
      let m;
      if ((m = code.match(/^(\s*)(?:(?:local|export|readonly|declare)\s+)?([A-Za-z_]\w*)(\s+=\s*|\s*=\s+)(?!=)/)) && !/^\s*(if|while|until|elif|\[\[|\[)\b/.test(code)) {
        const col = m[1].length + 1;
        out.push({ sev: 'error', line: i, c1: col, c2: col + m[0].length - m[1].length, code: 'SF003',
          msg: `Пробелы вокруг = в присваивании: bash запустит «${m[2]}» как команду. Пиши ${m[2]}=значение.` });
      }
      const reBr = /\[\[(?=\S)|(?<=\S)\]\]/g;
      while ((m = reBr.exec(code))) {
        out.push({ sev: 'error', line: i, c1: m.index + 1, c2: m.index + 3, code: 'SF004', msg: 'Нужны пробелы внутри [[ ]]: [[ $a == b ]].' });
      }
      if ((m = code.match(/\b(if|elif|while|until)\s+\[(?!\[)(?=\S)/))) {
        out.push({ sev: 'error', line: i, c1: m.index + 1, c2: m.index + m[0].length + 1, code: 'SF005', msg: 'Нужен пробел после [ : `[` — это команда test.' });
      }
      if ((m = code.match(/\bread\b[^|;&]*\s-\w*p\b/))) {
        out.push({ sev: 'info', line: i, c1: m.index + 1, c2: m.index + m[0].length + 1, code: 'SF006',
          msg: 'read -p печатает приглашение только при вводе с терминала. Тесты подают ввод через пайп — приглашения не будет. Печатай его через printf.' });
      }
      if ((m = code.match(/\{\d+\.\.\$\w+\}|\{\$\w+\.\.[^}]*\}/))) {
        out.push({ sev: 'warning', line: i, c1: m.index + 1, c2: m.index + m[0].length + 1, code: 'SF007',
          msg: '{1..$n} не работает: скобки раскрываются раньше переменных. Используй for ((i=1; i<=n; i++)).' });
      }
      if ((m = code.match(/for\s+\w+\s+in\s+(`ls[^`]*`|\$\(ls\b[^)]*\))/))) {
        out.push({ sev: 'warning', line: i, c1: m.index + 1, c2: m.index + m[0].length + 1, code: 'SF008',
          msg: 'for f in $(ls) ломается на пробелах в именах. Используй глоб (for f in *) или find -print0 + while read.' });
      }
    }
    return out;
  }

  function lintMakefile(model) {
    const out = [];
    const n = model.getLineCount();
    let inRule = false;
    for (let i = 1; i <= n; i++) {
      const line = model.getLineContent(i);
      if (!line.trim()) { inRule = false; continue; }
      if (/^[^\s#=:][^=]*?::?(?!=)/.test(line) && !/^\s/.test(line)) { inRule = true; continue; }
      if (/^\S/.test(line)) { inRule = false; continue; }
      if (inRule && /^ +\S/.test(line)) {
        out.push({ sev: 'error', line: i, c1: 1, c2: line.match(/^ +/)[0].length + 1, code: 'MF001',
          msg: 'Команда рецепта начинается с пробелов — нужен TAB, иначе make скажет «missing separator». (⌘. — исправить)' });
      }
    }
    return out;
  }

  function applyLint(f) {
    const monaco = window.monaco;
    if (!monaco || !f.model || f.model.isDisposed()) return;
    let items = [];
    if (f.lang === 'shell') items = lintShell(f.model);
    else if (f.lang === 'makefile') items = lintMakefile(f.model);
    const sevMap = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
    monaco.editor.setModelMarkers(f.model, 'sf', items.map((x) => ({
      severity: sevMap[x.sev], startLineNumber: x.line, endLineNumber: x.line, startColumn: x.c1, endColumn: x.c2,
      message: x.msg, code: x.code, source: 'SegForces',
    })));
    if (f.lang === 'shell' && S.env && S.env.shellcheck) shellcheck(f);
    updateStatusbar();
  }

  async function shellcheck(f) {
    const ver = f.model.getAlternativeVersionId();
    try {
      const r = await api.post('/api/lint', { content: f.model.getValue() });
      if (!r.available || f.model.isDisposed() || f.model.getAlternativeVersionId() !== ver) return;
      const monaco = window.monaco;
      const sev = { error: 8, warning: 4, info: 2, style: 1 };
      monaco.editor.setModelMarkers(f.model, 'shellcheck', r.comments.map((c) => ({
        severity: sev[c.level] || 2, startLineNumber: c.line, endLineNumber: c.endLine, startColumn: c.column,
        endColumn: c.endColumn, message: c.message, code: { value: `SC${c.code}`, target: monaco.Uri.parse(`https://www.shellcheck.net/wiki/SC${c.code}`) },
        source: 'shellcheck',
      })));
      updateStatusbar();
    } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // workspace
  // -------------------------------------------------------------------------
  function fileIcon(path) {
    const base = path.split('/').pop();
    if (base.endsWith('.sh')) return '<span class="fi sh">sh</span>';
    if (/\.(c|h)$/.test(base)) return '<span class="fi c">c</span>';
    if (/\.(cpp|hpp|cc)$/.test(base)) return '<span class="fi c">c++</span>';
    if (base.startsWith('Makefile')) return '<span class="fi mk">mk</span>';
    return '<span class="fi tx">txt</span>';
  }

  function allTasksFlat() {
    return S.overview ? S.overview.sessions.flatMap((s) => s.tasks) : [];
  }

  function buildWorkspace() {
    view.className = 'ws-mode';
    const lw = prefs.leftW || 42;
    const bh = prefs.bottomH || 270;
    view.innerHTML = `
      <div class="ws" id="ws" style="--left-w:${lw}%">
        <section class="ws-left">
          <div class="tabs" id="left-tabs">
            <button class="tab" data-ltab="statement">Условие</button>
            <button class="tab" data-ltab="tests">Тесты</button>
            <button class="tab" data-ltab="subs">Посылки <span class="badge hidden" id="subs-badge"></span></button>
            <button class="tab" data-ltab="chat"><span style="color:#d97757">✦</span> Claude</button>
          </div>
          <div class="tab-body" id="left-body">
            <div data-pane="statement"></div>
            <div data-pane="tests" class="hidden"></div>
            <div data-pane="subs" class="hidden"></div>
            <div data-pane="chat" class="hidden" style="height:100%"></div>
          </div>
        </section>
        <div class="split-v" id="split-v" title="Потяни, чтобы изменить ширину"></div>
        <section class="ws-right">
          <div class="panel editor-panel">
            <div class="ftabs">
              <div class="ftabs-scroll" id="ftabs"></div>
              <div class="ftabs-actions">
                <button class="icon-btn" id="new-file-btn" title="Новый файл">${ICON.plus}</button>
                <button class="icon-btn" id="reveal-btn" title="Показать в Finder">${ICON.folder}</button>
              </div>
            </div>
            <div class="editor-host"><div id="editor"></div><div class="editor-empty hidden" id="editor-empty"></div></div>
            <div class="statusbar" id="statusbar"></div>
          </div>
          <div class="split-h" id="split-h" title="Потяни, чтобы изменить высоту"></div>
          <div class="panel bottom-panel" id="bottom-panel" style="--bottom-h:${bh}px">
            <div class="tabs" id="bottom-tabs">
              <button class="tab" data-btab="result">Результат</button>
              <button class="tab" data-btab="console">Консоль</button>
              <div class="tabs-right" id="bottom-actions"></div>
            </div>
            <div class="tab-body" id="bottom-body">
              <div data-bpane="result" style="height:100%"></div>
              <div data-bpane="console" class="hidden" style="height:100%"></div>
            </div>
          </div>
        </section>
      </div>`;
    $('#left-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ltab]');
      if (b) setLeftTab(b.dataset.ltab);
    });
    $('#bottom-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-btab]');
      if (b) setBottomTab(b.dataset.btab);
    });
    $('#new-file-btn').addEventListener('click', () => newFileDialog());
    $('#reveal-btn').addEventListener('click', () => api.post('/api/reveal', { key: S.key, path: S.active || undefined }).catch((e) => toast('Не получилось', e.message, 'bad')));
    setupSplitters();
    setLeftTab(S.leftTab, true);
    setBottomTab(S.bottomTab, true);
  }

  function setupSplitters() {
    const sv = $('#split-v');
    const sh = $('#split-h');
    const ws = $('#ws');
    sv.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sv.classList.add('dragging');
      document.body.classList.add('resizing', 'resizing-col');
      const rect = ws.getBoundingClientRect();
      const move = (ev) => {
        const pct = Math.min(70, Math.max(22, ((ev.clientX - rect.left) / rect.width) * 100));
        ws.style.setProperty('--left-w', `${pct}%`);
        prefs.leftW = Math.round(pct * 10) / 10;
      };
      const up = () => {
        sv.classList.remove('dragging');
        document.body.classList.remove('resizing', 'resizing-col');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        savePrefs();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    sh.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sh.classList.add('dragging');
      document.body.classList.add('resizing', 'resizing-row');
      const panel = $('#bottom-panel');
      const right = panel.parentElement.getBoundingClientRect();
      const move = (ev) => {
        const h = Math.min(right.height - 160, Math.max(100, right.bottom - ev.clientY));
        panel.style.setProperty('--bottom-h', `${h}px`);
        prefs.bottomH = Math.round(h);
      };
      const up = () => {
        sh.classList.remove('dragging');
        document.body.classList.remove('resizing', 'resizing-row');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        savePrefs();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  function setLeftTab(tab, silent) {
    S.leftTab = tab;
    $$('#left-tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.ltab === tab));
    $$('#left-body [data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
    const body = $('#left-body');
    if (body) body.style.overflow = tab === 'chat' ? 'hidden' : 'auto';
    if (silent || !S.task) return;
    if (tab === 'tests' && !$('[data-pane="tests"]').dataset.ready) renderTests();
    if (tab === 'subs') renderSubs();
    if (tab === 'chat') openChatPane();
  }

  function setBottomTab(tab, silent) {
    S.bottomTab = tab;
    $$('#bottom-tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.btab === tab));
    $$('#bottom-body [data-bpane]').forEach((p) => p.classList.toggle('hidden', p.dataset.bpane !== tab));
    const body = $('#bottom-body');
    if (body) body.style.overflow = tab === 'console' ? 'hidden' : 'auto';
    if (silent || !S.task) return;
    if (tab === 'console') renderConsole();
  }

  function renderTopForTask() {
    const t = S.task;
    const flat = allTasksFlat();
    const idx = flat.findIndex((x) => x.key === S.key);
    const prev = idx > 0 ? flat[idx - 1] : null;
    const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
    setTopCenter(`
      <div class="crumbs">
        <a href="#/">Сессия ${t ? t.snum : ''}</a><span class="dim">/</span>
        <span class="cur" title="${esc(t ? t.title : '')}">${t ? `${t.letter}. ${esc(t.title)}` : esc(S.key)}</span>
        <button class="icon-btn" ${prev ? `data-go="${esc(prev.key)}" title="Предыдущая: ${esc(prev.title)}"` : 'disabled'} style="width:26px;height:26px">${ICON.left}</button>
        <button class="icon-btn" ${next ? `data-go="${esc(next.key)}" title="Следующая: ${esc(next.title)}"` : 'disabled'} style="width:26px;height:26px">${ICON.right}</button>
      </div>
      <div class="run-group">
        <button class="btn" id="run-btn" title="Прогнать открытые тесты (${MOD}↵)">${ICON.play} Запустить <span class="k">${MOD}↵</span></button>
        <button class="btn success" id="submit-btn" title="Отправить на проверку грейдеру (${MOD}⇧↵)">${ICON.send} Отправить</button>
      </div>`);
    $('#top-center').onclick = (e) => {
      const g = e.target.closest('[data-go]');
      if (g) location.hash = `#/p/${g.dataset.go}`;
    };
    $('#run-btn').addEventListener('click', () => runTests());
    $('#submit-btn').addEventListener('click', () => openSubmit());
    updateRunButton();
  }

  function updateRunButton() {
    const b = $('#run-btn');
    if (!b) return;
    const running = S.run && S.run.key === S.key && (S.run.status === 'running' || S.run.status === 'starting');
    b.innerHTML = running ? `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Тестирую…` : `${ICON.play} Запустить <span class="k">${MOD}↵</span>`;
    b.disabled = !!running;
  }

  async function showTask(key, tab) {
    if (S.key !== key) {
      if (S.key && !(await leaveTask())) {
        stayOnTask();
        return;
      }
      S.key = key;
      S.task = null;
      S.run = null;
      S.chat = null;
      if (!S.overview) {
        try { await loadOverview(); } catch (e) { /* shown later */ }
      }
      if (tab) S.leftTab = tab;
      buildWorkspace();
      renderTopForTask();
      renderResult();
      $('[data-pane="statement"]').innerHTML = `<div class="md">
        <div class="skeleton" style="height:26px;width:62%;margin-bottom:14px"></div>
        <div class="skeleton" style="height:14px;width:35%;margin-bottom:22px"></div>
        ${'<div class="skeleton" style="height:13px;margin-bottom:9px"></div>'.repeat(6)}</div>`;
      const ee = $('#editor-empty');
      ee.classList.remove('hidden');
      ee.innerHTML = '<div class="box"><span class="spinner" style="margin:0 auto 10px;display:block"></span><p>Открываю файлы решения…</p></div>';
      try {
        await loadTask(key);
      } catch (e) {
        if (S.key !== key) return;
        const msg = `<div class="banner bad"><span class="b-ico">⛔️</span><div><b>Не удалось открыть задачу</b><div>${esc(e.message)}</div>${e.data && e.data.detail ? `<div class="dim" style="font-size:12px;margin-top:4px">${esc(e.data.detail)}</div>` : ''}</div></div>`;
        $('[data-pane="statement"]').innerHTML = `<div class="md">${msg}</div>`;
        const ee = $('#editor-empty');
        if (ee) ee.innerHTML = '<div class="box"><div class="big">🧊</div><h3>Файлы недоступны</h3><p>Подробности слева.</p></div>';
        return;
      }
    }
    if (tab && tab !== S.leftTab) setLeftTab(tab);
  }

  async function loadTask(key, keepEditor) {
    const t = await api.get('/api/task', { key });
    if (S.key !== key) return;
    S.task = t;
    renderTopForTask();
    renderStatement();
    renderSubsBadge();
    if (S.leftTab === 'subs') renderSubs();
    if (S.leftTab === 'tests') renderTests();
    if (S.leftTab === 'chat') openChatPane();
    if (!keepEditor) await loadFiles();
    if (!S.run) {
      const last = (t.local_runs || [])[t.local_runs.length - 1];
      if (last) {
        S.run = { key, status: 'done', result: last, lines: null, fromHistory: true };
        renderResult();
      }
    }
  }

  function confirmDiscard(files) {
    return new Promise((resolve) => {
      let decided = false;
      const m = openModal(`
        <div class="modal-head"><h3>Изменения не сохранились</h3></div>
        <div class="modal-body">
          <p>Не удалось записать на диск: ${files.map((f) => `<code>${esc(f.path)}</code>`).join(', ')}.</p>
          ${files[0] && files[0].error ? `<div class="note err">${esc(files[0].error)}</div>` : ''}
          <p class="muted">Если уйти сейчас, эти правки пропадут. Останься и попробуй ещё раз (${MOD}S) или скопируй код вручную.</p>
        </div>
        <div class="modal-foot"><button class="btn danger" data-d="leave">Уйти без сохранения</button><button class="btn primary" data-d="stay">Остаться</button></div>`,
      { onClose: () => { if (!decided) resolve(false); } });
      $('[data-d="stay"]', m.el).focus();
      m.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-d]');
        if (!b) return;
        decided = true;
        m.close();
        resolve(b.dataset.d === 'leave');
      });
    });
  }

  // Returns false (and keeps everything) if unsaved edits could not be written and the user stays.
  async function leaveTask() {
    const ok = await saveAll().catch(() => false);
    if (!ok) {
      const unsaved = Array.from(S.files.values()).filter((f) => f.dirty || f.error);
      if (unsaved.length && !(await confirmDiscard(unsaved))) return false;
    }
    if (S.chat && S.chat.abort) S.chat.abort.abort();
    if (S.run && S.run.abort) S.run.abort.abort();
    for (const f of S.files.values()) {
      clearTimeout(f.saveTimer);
      clearTimeout(f.lintTimer);
      if (f.model && !f.model.isDisposed()) f.model.dispose();
    }
    S.files.clear();
    S.active = null;
    if (S.editor) {
      S.editor.dispose();
      S.editor = null;
    }
    S.key = null;
    S.task = null;
    return true;
  }

  // ---------- statement ----------
  function cleanStatement(text) {
    const lines = text.split('\n');
    let cut = lines.length;
    for (let i = Math.floor(lines.length * 0.4); i < lines.length; i++) {
      if (/^\*\*(Testing|To submit)\b/i.test(lines[i].trim())) { cut = i; break; }
    }
    let out = lines.slice(0, cut).join('\n');
    out = out.replace(/^#\s+.*\n/, '');
    return out.trim();
  }

  function renderStatement() {
    const t = S.task;
    const pane = $('[data-pane="statement"]');
    if (!t || !pane) return;
    const dl = deadlineInfo(t.deadline);
    const exp = t.expected || [];
    const kindTag = t.kind === 'c' ? '<span class="tag c">C</span>' : t.kind === 'bash' ? '<span class="tag bash">bash</span>' : '';
    const runner = t.runner || {};
    pane.innerHTML = `
      <div class="st-head">
        <h1 class="st-title"><span class="letter">${t.snum}${t.letter}.</span>${esc(t.title)}</h1>
        <div class="st-meta">
          <span class="pts-badge ${diffClass(t.points)}">${t.points || '?'} балл.</span>
          ${kindTag}
          ${dl ? `<span class="dl ${dl.cls}" title="${esc(dl.title)}">⏰ ${esc(dl.text)}</span>` : ''}
          <span class="sep"></span>
          <span class="dim mono" style="font-size:12px">${esc(t.key)}</span>
          ${runner.docker ? '<span class="tag" title="Тесты запускаются в Docker">🐳 docker</span>' : runner.script ? '<span class="tag" title="Тесты запускаются прямо на твоём Mac">💻 локально</span>' : ''}
        </div>
        ${exp.length || (t.make_targets || []).length ? `<div class="st-files">
          ${exp.length ? `<div>Файлы решения: ${exp.map((e) => e.exists
            ? `<code>${esc(e.path)}${e.kind === 'dir' ? '/' : ''}</code> <span style="color:var(--ok)">✓</span>`
            : `<code>${esc(e.path)}${e.kind === 'dir' ? '/' : ''}</code> <button class="btn xs" data-create="${esc(e.path)}" data-kind="${e.kind}">создать</button>`).join(' &nbsp; ')}</div>` : ''}
          ${(t.make_targets || []).length ? `<div style="margin-top:6px">Тесты собирают так: ${t.make_targets.map((x) => `<code>make -f Makefile.Student ${esc(x)}</code>`).join(', ')}</div>` : ''}
        </div>` : ''}
      </div>
      <div class="md" id="statement-md">${md(cleanStatement(t.statement || '_Условие не найдено_'))}</div>`;
    highlightIn(pane);
    pane.onclick = (e) => {
      const b = e.target.closest('[data-create]');
      if (b) createFile(b.dataset.create, b.dataset.kind);
    };
  }

  // ---------- tests ----------
  async function renderTests(path) {
    const t = S.task;
    const pane = $('[data-pane="tests"]');
    if (!t || !pane) return;
    pane.dataset.ready = '1';
    const tests = (t.tests || []).filter((x) => x.size < 400000);
    if (!tests.length) {
      pane.innerHTML = '<div class="empty"><span class="big">🧪</span>Открытых тестов нет</div>';
      return;
    }
    const rank = (p) => (/test.*\.(py|cpp)$/.test(p) ? 0 : p.endsWith('.sh') ? 1 : 2);
    tests.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
    const cur = path || pane.dataset.cur || tests[0].path;
    pane.dataset.cur = cur;
    pane.innerHTML = `
      <div class="tlist">${tests.map((x) => `<button class="btn xs ${x.path === cur ? 'on' : ''}" data-tfile="${esc(x.path)}">${esc(x.path.replace(/^open_tests\//, ''))}</button>`).join('')}</div>
      <div class="dim" style="padding:10px 16px 0;font-size:12px">Это открытые тесты — их можно читать. Грейдер дополнительно гоняет скрытые.</div>
      <pre class="codeview" id="test-code"><code>Загрузка…</code></pre>`;
    pane.onclick = (e) => {
      const b = e.target.closest('[data-tfile]');
      if (b) renderTests(b.dataset.tfile);
    };
    try {
      const f = await api.get('/api/file', { key: S.key, path: cur });
      $('#test-code').innerHTML = `<code class="hljs">${highlightCode(f.content, f.lang)}</code>`;
    } catch (e) {
      $('#test-code').innerHTML = `<code>${esc(e.message)}</code>`;
    }
  }

  // ---------- submissions ----------
  function renderSubsBadge() {
    const b = $('#subs-badge');
    if (!b || !S.task) return;
    const j = S.task.judge || [];
    if (!j.length) { b.classList.add('hidden'); return; }
    const solved = j.some((x) => x.verdict === 'AC');
    b.textContent = j.length;
    b.className = `badge ${solved ? 'ok' : j[j.length - 1].verdict === 'TESTING' || j[j.length - 1].verdict === 'QUEUED' ? '' : 'bad'}`;
  }

  function renderSubs() {
    const t = S.task;
    const pane = $('[data-pane="subs"]');
    if (!t || !pane) return;
    const judge = (t.judge || []).slice().reverse();
    const local = (t.local_runs || []).slice().reverse();
    pane.innerHTML = `
      <div class="subs">
        <div class="row"><div class="section-label" style="margin:0">Проверки грейдером</div><span class="spacer"></span>
          <button class="btn xs ghost" id="subs-sync">${ICON.sync} Обновить</button></div>
        ${judge.length ? judge.map((j) => `
          <div class="sub-item" data-run="${esc(j.run_id)}">
            <div class="sub-head">
              <span class="vtext v-${j.verdict}" style="font-size:13.5px">${esc(vname(j.verdict))}${j.first_failed && j.first_failed.index && j.verdict !== 'AC' ? ` on test ${j.first_failed.index}` : ''}</span>
              ${j.total != null ? `<span class="mono dim" style="font-size:12px">${j.passed}/${j.total}</span>` : ''}
              <span class="spacer"></span>
              <span class="sub-meta" title="${esc(j.created || '')}">${esc(ago(j.created))} · <span class="mono">${esc((j.sha || '').slice(0, 7))}</span></span>
            </div>
            <div class="sub-body hidden"></div>
          </div>`).join('') : '<div class="empty" style="padding:14px"><span class="big">📮</span>Ещё не отправлялось. Кнопка «Отправить» — и грейдер прогонит скрытые тесты.</div>'}
        <div class="section-label">Локальные прогоны (открытые тесты)</div>
        ${local.length ? local.map((r) => `
          <div class="sub-item" data-local="${esc(r.id)}">
            <div class="sub-head">
              <span class="vtext v-${r.verdict}">${esc(r.verdict_name || vname(r.verdict))}</span>
              ${r.total != null ? `<span class="mono dim" style="font-size:12px">${r.passed}/${r.total}</span>` : ''}
              <span class="spacer"></span>
              <span class="sub-meta">${esc(ago(r.at))} · ${esc(fmtDur(r.duration))}</span>
            </div>
          </div>`).join('') : '<div class="dim" style="font-size:13px">Пока нет. Нажми ▶ Запустить.</div>'}
      </div>`;
    $('#subs-sync').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      await syncJudge(true);
      await loadTask(S.key, true);
    });
    pane.onclick = async (e) => {
      if (e.target.closest('button')) return;
      const item = e.target.closest('[data-run]');
      if (item) {
        const body = $('.sub-body', item);
        if (!body.classList.contains('hidden')) { body.classList.add('hidden'); return; }
        body.classList.remove('hidden');
        body.innerHTML = '<div class="dim" style="font-size:12.5px">Загрузка…</div>';
        try {
          const run = await api.get('/api/judge/run', { id: item.dataset.run, key: S.key });
          const res = run.result;
          body.innerHTML = `${res ? resultDetailsHtml(res, { judge: true }) : '<div class="dim">Подробностей нет (прогон ещё идёт?)</div>'}
            ${res && res.log ? `<details class="raw"><summary>Лог грейдера</summary><pre>${esc(res.log)}</pre></details>` : ''}
            <div class="res-actions">
              <a class="btn sm" href="${esc(run.url || '#')}" target="_blank" rel="noopener">Лог на GitHub ↗</a>
              ${res && res.verdict !== 'AC' ? '<button class="btn sm" data-ask-judge>✦ Спросить Claude</button>' : ''}
            </div>`;
          highlightIn(body);
          bindHintActions(body);
          const ask = $('[data-ask-judge]', body);
          if (ask) ask.addEventListener('click', () => askClaude('Почему моё решение не прошло проверку грейдером? Разбери лог проверки (там есть скрытые тесты) и мой код, укажи, что исправить.', { quick: 'judge' }));
        } catch (err) {
          body.innerHTML = `<div class="note err">${esc(err.message)}</div>`;
        }
        return;
      }
      const loc = e.target.closest('[data-local]');
      if (loc) {
        try {
          const r = await api.get('/api/run/output', { key: S.key, id: loc.dataset.local });
          S.run = { key: S.key, status: 'done', result: r, lines: null, fromHistory: true };
          setBottomTab('result');
          renderResult();
        } catch (err) {
          toast('Не нашёл прогон', err.message, 'bad');
        }
      }
    };
  }

  // ---------- files & editor ----------
  async function loadFiles() {
    const t = S.task;
    const key = S.key;
    let monaco;
    try {
      monaco = await loadMonaco();
    } catch (e) {
      $('#editor-empty').classList.remove('hidden');
      $('#editor-empty').innerHTML = `<div class="box"><div class="big">🧱</div><h3>Редактор не загрузился</h3><p>${esc(e.message || e)}. Monaco берётся с CDN — проверь интернет.</p></div>`;
      return;
    }
    if (S.key !== key) return;
    if (!S.editor) createEditor(monaco);
    const textFiles = t.files.filter((f) => !f.binary);
    const contents = await Promise.all(textFiles.map((f) => api.get('/api/file', { key, path: f.path }).catch(() => null)));
    if (S.key !== key) return;
    const expectedOrder = (t.expected || []).map((e) => e.path);
    const order = (p) => {
      const i = expectedOrder.findIndex((e) => p === e || p.startsWith(`${e}/`));
      return i < 0 ? 100 : i;
    };
    textFiles.forEach((f, i) => {
      const c = contents[i];
      if (!c) return;
      const uri = monaco.Uri.from({ scheme: 'sf', path: `/${key}/${f.path}` });
      const old = monaco.editor.getModel(uri);
      if (old) old.dispose();
      const lang = monaco.languages.getLanguages().some((l) => l.id === f.lang) ? f.lang : 'plaintext';
      const model = monaco.editor.createModel(c.content, lang, uri);
      const entry = {
        path: f.path, lang: f.lang, model, hash: c.hash, exec: c.exec, artifact: f.artifact,
        savedVersion: model.getAlternativeVersionId(), saving: false, error: null, view: null, order: order(f.path),
      };
      model.updateOptions({ insertSpaces: f.lang !== 'makefile', tabSize: f.lang === 'makefile' ? 8 : 4 });
      model.onDidChangeContent(() => onModelChange(entry));
      S.files.set(f.path, entry);
      applyLint(entry);
    });
    renderFileTabs();
    const sorted = sortedFiles();
    const first = sorted.find((f) => !f.artifact) || sorted[0];
    if (first) openFile(first.path);
    else showEditorEmpty();
  }

  function sortedFiles() {
    return Array.from(S.files.values()).sort((a, b) => (a.artifact - b.artifact) || (a.order - b.order) || a.path.localeCompare(b.path));
  }

  function createEditor(monaco) {
    S.editor = monaco.editor.create($('#editor'), {
      model: null, theme: monacoTheme(), automaticLayout: true,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace', fontSize: 13.5, lineHeight: 21, fontLigatures: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12, bottom: 12 },
      smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true }, guides: { bracketPairs: true, indentation: true },
      renderWhitespace: 'selection', fixedOverflowWidgets: true, stickyScroll: { enabled: false },
      renderLineHighlight: 'all', tabSize: 4, insertSpaces: true, wordWrap: 'off', lightbulb: { enabled: 'on' },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    const KM = monaco.KeyMod;
    const KC = monaco.KeyCode;
    S.editor.addCommand(KM.CtrlCmd | KC.KeyS, () => saveActive(true));
    S.editor.addCommand(KM.CtrlCmd | KC.Enter, () => runTests());
    S.editor.addCommand(KM.CtrlCmd | KM.Shift | KC.Enter, () => openSubmit());
    S.editor.addCommand(KM.CtrlCmd | KC.KeyJ, () => setLeftTab(S.leftTab === 'chat' ? 'statement' : 'chat'));
    S.editor.addCommand(KM.CtrlCmd | KC.KeyK, () => openPalette());
    S.editor.addAction({
      id: 'sf.ask-selection', label: 'Спросить Claude про выделенное', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      keybindings: [KM.CtrlCmd | KM.Shift | KC.KeyL],
      run: (ed) => {
        const sel = ed.getModel() && ed.getModel().getValueInRange(ed.getSelection());
        setLeftTab('chat');
        setTimeout(() => {
          const ta = $('#chat-input');
          if (!ta) return;
          S.chat.selection = sel ? { text: sel, file: S.active } : null;
          ta.value = sel ? 'Что делает этот фрагмент и что в нём не так?' : '';
          renderSelectionChip();
          ta.focus();
        }, 60);
      },
    });
    S.editor.onDidChangeCursorPosition(() => updateStatusbar());
    S.editor.onDidChangeModelDecorations(() => updateStatusbar());
  }

  function onModelChange(f) {
    const dirty = f.model.getAlternativeVersionId() !== f.savedVersion;
    if (dirty !== f.dirty) {
      f.dirty = dirty;
      renderFileTabs();
    }
    f.dirty = dirty;
    clearTimeout(f.saveTimer);
    if (dirty) f.saveTimer = setTimeout(() => saveFile(f), 700);
    clearTimeout(f.lintTimer);
    f.lintTimer = setTimeout(() => applyLint(f), 350);
    updateStatusbar();
  }

  function renderFileTabs() {
    const box = $('#ftabs');
    if (!box || !S.task) return;
    const files = sortedFiles();
    const missing = (S.task.expected || []).filter((e) => !e.exists && e.kind === 'file' && !S.files.has(e.path));
    box.innerHTML = files.map((f) => {
      const noExec = f.path.endsWith('.sh') && !f.exec;
      return `<button class="ftab ${f.path === S.active ? 'on' : ''}" data-file="${esc(f.path)}" title="${esc(f.path)}${noExec ? ' — не исполняемый!' : ''}" style="${f.artifact ? 'opacity:.6' : ''}">
        ${fileIcon(f.path)}<span>${esc(f.path)}</span>${noExec ? '<span class="warnx" title="Нет chmod +x">!</span>' : ''}${f.dirty ? '<span class="mod" title="Не сохранено"></span>' : ''}</button>`;
    }).join('') + missing.map((e) => `<button class="ftab ghost" data-create="${esc(e.path)}" title="Создать ${esc(e.path)}">+ ${esc(e.path)}</button>`).join('');
    box.onclick = (e) => {
      const c = e.target.closest('[data-create]');
      if (c) { createFile(c.dataset.create, 'file'); return; }
      const b = e.target.closest('[data-file]');
      if (b) openFile(b.dataset.file);
    };
  }

  function openFile(path) {
    const f = S.files.get(path);
    if (!f || !S.editor) return;
    const cur = S.files.get(S.active);
    if (cur && cur !== f) cur.view = S.editor.saveViewState();
    S.active = path;
    S.editor.setModel(f.model);
    if (f.view) S.editor.restoreViewState(f.view);
    S.editor.updateOptions({ renderWhitespace: f.lang === 'makefile' ? 'boundary' : 'selection' });
    $('#editor-empty').classList.add('hidden');
    renderFileTabs();
    updateStatusbar();
    S.editor.focus();
  }

  function showEditorEmpty() {
    const box = $('#editor-empty');
    if (!box || !S.task) return;
    const missing = (S.task.expected || []).filter((e) => !e.exists);
    box.classList.remove('hidden');
    box.innerHTML = `<div class="box">
      <div class="big">📝</div>
      <h3>Решения ещё нет</h3>
      <p>${missing.length ? 'Судя по условию и тестам, нужны такие файлы:' : 'Создай файл решения — тесты ищут его в папке задачи.'}</p>
      <div class="row" style="justify-content:center;flex-wrap:wrap">
        ${missing.map((e) => `<button class="btn ${e.kind === 'dir' ? '' : 'primary'}" data-create="${esc(e.path)}" data-kind="${e.kind}">${ICON.plus} ${esc(e.path)}${e.kind === 'dir' ? '/' : ''}</button>`).join('')}
        <button class="btn ghost" data-newfile>Другой файл…</button>
      </div>
    </div>`;
    box.onclick = (e) => {
      const c = e.target.closest('[data-create]');
      if (c) createFile(c.dataset.create, c.dataset.kind);
      if (e.target.closest('[data-newfile]')) newFileDialog();
    };
    updateStatusbar();
  }

  async function createFile(path, kind) {
    if (kind === 'dir') {
      const suggestion = S.task.kind === 'c' ? `${path}/${S.task.name}.c` : `${path}/main.c`;
      newFileDialog(suggestion);
      return;
    }
    try {
      await api.post('/api/file/create', { key: S.key, path });
      toast('Файл создан', path, 'ok');
      if (S.run && S.run.status === 'blocked') {
        S.run = null;
        renderResult();
      }
      await reloadTaskFiles(path);
    } catch (e) {
      toast('Не получилось создать файл', e.message, 'bad');
    }
  }

  async function reloadTaskFiles(openPath) {
    if (!(await saveAll())) {
      toast('Файлы не перезагружены', 'Есть несохранённые правки — сначала нужно их записать (⌘S).', 'warn');
      return;
    }
    const key = S.key;
    const prevActive = S.active;
    for (const f of S.files.values()) {
      if (f.model && !f.model.isDisposed()) {
        f.view = S.editor && S.active === f.path ? S.editor.saveViewState() : f.view;
      }
    }
    const views = new Map(Array.from(S.files.values()).map((f) => [f.path, f.view]));
    for (const f of S.files.values()) {
      clearTimeout(f.saveTimer);
      if (f.model && !f.model.isDisposed()) f.model.dispose();
    }
    S.files.clear();
    S.active = null;
    await loadTask(key, true);
    await loadFiles();
    for (const [p, v] of views) {
      const f = S.files.get(p);
      if (f && v) f.view = v;
    }
    if (openPath && S.files.has(openPath)) openFile(openPath);
    else if (prevActive && S.files.has(prevActive)) openFile(prevActive);
  }

  function newFileDialog(suggest) {
    const t = S.task;
    const sugg = (t.expected || []).filter((e) => !e.exists && e.kind === 'file').map((e) => e.path);
    if (t.kind === 'c') ['Makefile.Student', `src/${t.name}.c`, `src/${t.name}.h`].forEach((p) => { if (!sugg.includes(p) && !S.files.has(p)) sugg.push(p); });
    const m = openModal(`
      <div class="modal-head"><h3>Новый файл</h3><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">
        <input class="text-input" id="nf-path" placeholder="например, solution.sh или src/main.c" value="${esc(suggest || sugg[0] || '')}">
        <div class="dim" style="font-size:12px;margin-top:6px">Путь относительно папки задачи. Для .sh сразу добавлю shebang и chmod +x.</div>
        ${sugg.length ? `<div class="sugg">${sugg.map((p) => `<button class="btn xs" data-s="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-close>Отмена</button><button class="btn primary" id="nf-ok">Создать</button></div>`);
    const inp = $('#nf-path', m.el);
    inp.focus();
    inp.select();
    m.el.addEventListener('click', (e) => {
      const s = e.target.closest('[data-s]');
      if (s) { inp.value = s.dataset.s; inp.focus(); }
    });
    const ok = async () => {
      const p = inp.value.trim();
      if (!p) return;
      m.close();
      await createFile(p, 'file');
    };
    $('#nf-ok', m.el).addEventListener('click', ok);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  }

  // Resolves true only when the file on disk matches the editor (keystrokes typed while a
  // save was in flight are written by the same call before it resolves).
  async function saveFile(f, opts = {}) {
    if (!f || !f.model || f.model.isDisposed()) return true;
    if (f.savingPromise) await f.savingPromise;
    if (f.model.isDisposed()) return true;
    if (!f.dirty && !opts.force && !opts.overwrite) return !f.error;
    const key = S.key;
    f.saving = true;
    updateStatusbar();
    f.savingPromise = (async () => {
      let ok = true;
      let overwrite = !!opts.overwrite;
      try {
        do {
          const content = f.model.getValue();
          const ver = f.model.getAlternativeVersionId();
          try {
            const r = await api.post('/api/file', { key, path: f.path, content, base_hash: f.hash, force: overwrite });
            f.hash = r.hash;
            f.exec = r.exec;
            f.savedVersion = ver;
            f.error = null;
          } catch (e) {
            ok = false;
            f.error = e.message;
            if (e.data && e.data.code === 'conflict') showConflict(f, e.data);
            else toast(`Не сохранилось: ${f.path}`, e.message, 'bad');
            break;
          }
          overwrite = false;
          f.dirty = !f.model.isDisposed() && f.model.getAlternativeVersionId() !== f.savedVersion;
        } while (f.dirty);
      } finally {
        f.saving = false;
        f.savingPromise = null;
        if (!f.model.isDisposed()) f.dirty = f.model.getAlternativeVersionId() !== f.savedVersion;
        renderFileTabs();
        updateStatusbar();
      }
      return ok;
    })();
    return f.savingPromise;
  }

  async function saveActive(explicit) {
    const f = S.files.get(S.active);
    if (!f) return;
    clearTimeout(f.saveTimer);
    const ok = await saveFile(f, { force: false });
    if (explicit && ok) flashStatus('сохранено ✓');
  }

  async function saveAll() {
    const tasks = [];
    for (const f of S.files.values()) {
      clearTimeout(f.saveTimer);
      if (f.dirty) tasks.push(saveFile(f));
    }
    const res = await Promise.all(tasks);
    return res.every(Boolean);
  }

  function showConflict(f, data) {
    const m = openModal(`
      <div class="modal-head"><h3>Файл изменился на диске</h3></div>
      <div class="modal-body"><p><code>${esc(f.path)}</code> поменяли вне SegForces (другой редактор?). Что оставить?</p></div>
      <div class="modal-foot">
        <button class="btn" data-c="disk">Взять версию с диска</button>
        <button class="btn primary" data-c="mine">Оставить мою (перезаписать)</button>
      </div>`);
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      m.close();
      if (b.dataset.c === 'disk') {
        f.hash = data.disk_hash;
        f.model.setValue(data.disk_content);
        f.savedVersion = f.model.getAlternativeVersionId();
        clearTimeout(f.saveTimer);
        f.dirty = false;
        f.error = null;
        renderFileTabs();
        updateStatusbar();
      } else {
        f.hash = data.disk_hash;
        await saveFile(f, { force: true, overwrite: true });
      }
    });
  }

  async function checkExternalChanges() {
    if (!S.key || !S.task || !S.files.size) return;
    let t;
    try { t = await api.get('/api/task', { key: S.key }); } catch (e) { return; }
    const byPath = new Map(t.files.map((f) => [f.path, f]));
    let structural = t.files.filter((f) => !f.binary).length !== S.files.size;
    for (const f of S.files.values()) {
      const disk = byPath.get(f.path);
      if (!disk) { structural = true; continue; }
      f.exec = disk.exec;
      if (disk.hash && disk.hash !== f.hash && !f.dirty && !f.saving) {
        try {
          const c = await api.get('/api/file', { key: S.key, path: f.path });
          f.hash = c.hash;
          const viewState = S.active === f.path && S.editor ? S.editor.saveViewState() : null;
          f.model.setValue(c.content);
          f.savedVersion = f.model.getAlternativeVersionId();
          f.dirty = false;
          if (viewState) S.editor.restoreViewState(viewState);
          toast('Файл обновлён с диска', f.path);
        } catch (e) { /* ignore */ }
      }
    }
    S.task.local_runs = t.local_runs;
    S.task.judge = t.judge;
    S.task.expected = t.expected;
    renderFileTabs();
    if (structural) reloadTaskFiles();
  }

  let flashTimer = null;
  function flashStatus(text) {
    const el = $('#sb-flash');
    if (!el) return;
    el.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.textContent = ''; }, 1500);
  }

  function updateStatusbar() {
    const sb = $('#statusbar');
    if (!sb) return;
    const f = S.files.get(S.active);
    if (!f || !S.editor || !window.monaco) {
      sb.innerHTML = '<span class="sb-item">нет открытого файла</span>';
      return;
    }
    const pos = S.editor.getPosition() || { lineNumber: 1, column: 1 };
    const markers = window.monaco.editor.getModelMarkers({ resource: f.model.uri });
    const errs = markers.filter((m) => m.severity === 8).length;
    const warns = markers.filter((m) => m.severity === 4).length;
    const infos = markers.filter((m) => m.severity <= 2).length;
    const save = f.saving ? '<span class="sb-item">● сохраняю…</span>'
      : f.error ? `<span class="sb-item err" title="${esc(f.error)}">⚠ не сохранено</span>`
        : f.dirty ? '<span class="sb-item wrn">● есть изменения</span>' : '<span class="sb-item okc">✓ сохранено</span>';
    const crlf = f.model.getEOL() === '\r\n';
    const isSh = f.path.endsWith('.sh');
    sb.innerHTML = `
      ${save}<span class="sb-item" id="sb-flash"></span>
      <button class="sb-item" id="sb-problems" title="Проблемы в файле">${errs ? `<span class="err">✕ ${errs}</span>` : ''}${warns ? `<span class="wrn">⚠ ${warns}</span>` : ''}${infos ? `<span>ℹ ${infos}</span>` : ''}${!errs && !warns && !infos ? '<span class="okc">без замечаний</span>' : ''}</button>
      <span class="spacer"></span>
      ${isSh ? (f.exec ? '<span class="sb-item okc" title="chmod +x есть">x исполняемый</span>' : '<button class="sb-item wrn" id="sb-chmod" title="Нажми, чтобы сделать chmod +x">⚠ не исполняемый — исправить</button>') : ''}
      <span class="sb-item">Стр ${pos.lineNumber}, Кол ${pos.column}</span>
      <span class="sb-item">${esc(f.lang)}</span>
      ${crlf ? '<button class="sb-item err" id="sb-eol" title="Перевести в LF">CRLF → LF</button>' : '<span class="sb-item">LF</span>'}
      ${S.env && S.env.shellcheck && isSh ? '<span class="sb-item okc">shellcheck</span>' : ''}`;
    const ch = $('#sb-chmod');
    if (ch) ch.addEventListener('click', () => chmodFile(f.path));
    const eol = $('#sb-eol');
    if (eol) eol.addEventListener('click', () => fixCrlf(f));
    $('#sb-problems').addEventListener('click', () => {
      if (S.editor) {
        S.editor.focus();
        S.editor.trigger('sf', 'editor.action.marker.next', {});
      }
    });
  }

  async function chmodFile(path) {
    try {
      const r = await api.post('/api/file/chmod', { key: S.key, path, exec: true });
      const f = S.files.get(path);
      if (f) f.exec = r.exec;
      renderFileTabs();
      updateStatusbar();
      toast('chmod +x', `${path} теперь исполняемый`, 'ok');
    } catch (e) {
      toast('Не получилось', e.message, 'bad');
    }
  }

  function fixCrlf(f) {
    f.model.pushEOL(window.monaco.editor.EndOfLineSequence.LF);
    applyLint(f);
    toast('Переводы строк → LF', f.path, 'ok');
  }

  function fixShebang() {
    let done = 0;
    for (const f of S.files.values()) {
      if (!f.path.endsWith('.sh') || f.artifact) continue;
      if (f.model.getLineContent(1).startsWith('#!')) continue;
      f.model.pushEditOperations([], [{ range: new window.monaco.Range(1, 1, 1, 1), text: '#!/bin/bash\n' }], () => null);
      done++;
    }
    if (done) toast('Добавил #!/bin/bash', 'Сохраню и можно перезапускать тесты.', 'ok');
    else toast('Shebang уже на месте', '');
  }

  async function chmodAll() {
    const targets = Array.from(S.files.values()).filter((f) => f.path.endsWith('.sh') && !f.exec);
    if (!targets.length) { toast('Все скрипты уже исполняемые', ''); return; }
    for (const f of targets) await chmodFile(f.path);
  }

  // ---------- result panel ----------
  function renderResult() {
    const pane = $('[data-bpane="result"]');
    if (!pane) return;
    updateRunButton();
    const r = S.run;
    const actions = $('#bottom-actions');
    if (actions) actions.innerHTML = '';
    if (!r || r.key !== S.key) {
      pane.innerHTML = `<div class="idle"><div><div style="font-size:26px;margin-bottom:6px">🧪</div>
        Запусти открытые тесты — результат появится здесь.
        <div class="keys"><span><kbd>${MOD}</kbd> <kbd>↵</kbd> запустить</span><span><kbd>${MOD}</kbd> <kbd>⇧</kbd> <kbd>↵</kbd> отправить</span><span><kbd>${MOD}</kbd> <kbd>S</kbd> сохранить</span></div></div></div>`;
      return;
    }
    if (r.status === 'starting' || r.status === 'running') {
      pane.innerHTML = `<div class="result">
        <div class="running"><span class="spinner"></span><span class="vname">Testing…</span><span class="dim mono" id="run-elapsed">0:00</span>
          <span class="spacer"></span><button class="btn sm" id="run-cancel">${ICON.stop} Стоп</button></div>
        <div class="dim" style="font-size:12.5px;margin-top:6px">${r.status === 'starting' ? 'Сохраняю файлы и запускаю…' : 'Первый запуск задачи собирает Docker-образ — это может занять пару минут.'}</div>
        <pre class="livelog" id="livelog"></pre></div>`;
      $('#run-cancel').addEventListener('click', () => r.id && api.post('/api/run/cancel', { id: r.id }));
      if (r.lines && r.lines.length) appendLog(r.lines, true);
      return;
    }
    if (r.status === 'blocked') {
      pane.innerHTML = `<div class="result"><div class="verdict"><span class="vname v-BLOCKED">Тесты не запущены</span></div>
        ${r.problems.map((p) => hintHtml(p)).join('')}</div>`;
      bindHintActions(pane);
      return;
    }
    if (r.status === 'error') {
      pane.innerHTML = `<div class="result"><div class="verdict"><span class="vname v-JE">Ошибка запуска</span></div><div class="note err">${esc(r.error)}</div></div>`;
      return;
    }
    const res = r.result;
    pane.innerHTML = `<div class="result">${resultDetailsHtml(res, { local: true })}
      <div class="res-actions">
        ${res.verdict === 'AC' ? `<button class="btn success" data-act="submit">${ICON.send} Отправить на проверку</button>` : ''}
        ${res.verdict !== 'AC' && res.verdict !== 'OFFLINE' ? '<button class="btn" data-act="ask">✦ Почему падает? Спросить Claude</button>' : ''}
        <button class="btn ghost" data-act="rerun">${ICON.play} Ещё раз</button>
        ${r.fromHistory ? `<span class="dim" style="font-size:12px;align-self:center">прогон ${esc(ago(res.at))}</span>` : ''}
      </div>
      ${res.output || (r.lines && r.lines.length) ? `<details class="raw"><summary>Полный вывод тестов</summary><pre>${esc(res.output || r.lines.join('\n'))}</pre></details>` : ''}
    </div>`;
    highlightIn(pane);
    bindHintActions(pane);
    pane.querySelector('.res-actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'submit') openSubmit();
      if (b.dataset.act === 'rerun') runTests();
      if (b.dataset.act === 'ask') askClaude('Почему не проходят тесты? Разбери вывод последнего прогона и мой код, укажи конкретное место ошибки.', { quick: 'why' });
    });
  }

  function formatTrace(text) {
    return esc(text).split('\n').map((ln) => {
      if (/^- /.test(ln) || /^-$/.test(ln)) return `<span class="diff-del">${ln}</span>`;
      if (/^\+ /.test(ln) || /^\+$/.test(ln)) return `<span class="diff-add">${ln}</span>`;
      return ln;
    }).join('\n');
  }

  function resultDetailsHtml(res, opts = {}) {
    const v = res.verdict;
    const ff = res.first_failed && res.first_failed.index && v !== 'AC' ? `on test ${res.first_failed.index}` : '';
    const total = res.total;
    let bar = '';
    if (total && total <= 60) {
      let cells = '';
      if (res.seq) {
        // unittest progress line: "." pass, F/E fail, s/x skipped
        for (let i = 0; i < res.seq.length; i++) {
          const ch = res.seq[i];
          const cls = ch === '.' ? '' : 'FEu'.includes(ch) ? 'f' : 'u';
          cells += `<i class="${cls}" title="тест ${i + 1}: ${ch === '.' ? 'ok' : ch === 'F' ? 'неверный ответ' : ch === 'E' ? 'ошибка' : 'пропущен'}"></i>`;
        }
      } else {
        const failedCount = Math.max(0, total - (res.passed || 0));
        for (let i = 1; i <= total; i++) cells += `<i class="${i > total - failedCount ? 'f' : ''}" title="тест ${i}"></i>`;
      }
      bar = `<div class="testbar">${cells}</div>`;
    }
    const meta = [];
    if (total != null) meta.push(`${opts.judge ? 'Тесты (открытые + скрытые)' : 'Открытые тесты'}: <b>${res.passed}/${total}</b>`);
    if (res.duration != null) meta.push(fmtDur(res.duration));
    if (res.exit_code != null && res.exit_code !== 0 && v !== 'OFFLINE') meta.push(`код возврата ${res.exit_code}`);
    if (res.note) meta.push(esc(res.note));
    const failed = (res.failed || []).slice(0, 8);
    return `
      <div class="verdict"><span class="vname v-${v}">${esc(res.verdict_name || vname(v))}</span>${ff ? `<span class="on">${ff}</span>` : ''}</div>
      ${meta.length ? `<div class="vmeta">${meta.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
      ${bar}
      ${(res.hints || []).map((h) => hintHtml(h)).join('')}
      ${res.compile_errors && res.compile_errors.length ? `<div class="failcase"><div class="failcase-head"><span class="vtext v-CE">Сборка</span>${res.build ? `<span class="tname">${esc(res.build.cmd)}</span>` : ''}</div><pre>${esc(res.compile_errors.join('\n'))}</pre></div>` : ''}
      ${failed.map((fc) => `
        <div class="failcase">
          <div class="failcase-head"><span class="vtext v-${fc.kind}">${fc.kind === 'WA' ? 'FAIL' : 'ERROR'}</span><span class="tname">${esc(fc.name)}</span>
            ${fc.hidden === true || fc.hidden === false ? `<span class="oh-tag ${fc.hidden ? 'oh-hidden' : 'oh-open'}">${fc.hidden ? 'скрытый' : 'открытый'}</span>` : ''}</div>
          <pre>${formatTrace(fc.message || '')}</pre>
        </div>`).join('')}`;
  }

  const HINT_ACTIONS = {
    fix_shebang: ['Добавить #!/bin/bash', () => fixShebang()],
    chmod: ['Сделать chmod +x', () => chmodAll()],
    fix_crlf: ['Перевести в LF', () => { for (const f of S.files.values()) if (f.model.getEOL() === '\r\n') fixCrlf(f); }],
    start_docker: ['Запустить Docker', () => startDocker()],
    restart_docker: ['Перезапустить Docker', () => restartDocker()],
  };

  function hintHtml(h) {
    const ico = h.level === 'error' ? '⛔️' : h.level === 'warn' ? '⚠️' : '💡';
    let action = '';
    if (h.action) {
      if (HINT_ACTIONS[h.action]) action = `<button class="btn sm" data-hint="${esc(h.action)}">${esc(HINT_ACTIONS[h.action][0])}</button>`;
      else if (h.action.startsWith('create:')) action = `<button class="btn sm primary" data-hint="${esc(h.action)}">Создать ${esc(h.action.slice(7))}</button>`;
      else if (h.action.startsWith('rmdir:')) action = `<button class="btn sm" data-hint="${esc(h.action)}">Удалить пустую папку</button>`;
    }
    const text = esc(h.text).replace(/`([^`]+)`/g, '<code>$1</code>');
    return `<div class="hint ${h.level}"><span class="h-ico">${ico}</span><div class="grow"><div class="h-title">${esc(h.title)}</div><div class="h-text">${text}</div>${action ? `<div class="h-actions">${action}</div>` : ''}</div></div>`;
  }

  function bindHintActions(root) {
    $$('[data-hint]', root).forEach((b) => {
      b.addEventListener('click', async () => {
        const a = b.dataset.hint;
        if (HINT_ACTIONS[a]) return HINT_ACTIONS[a][1]();
        if (a.startsWith('create:')) {
          await createFile(a.slice(7), 'file');
          S.run = null;
          renderResult();
        }
        if (a.startsWith('rmdir:')) {
          try {
            await api.post('/api/file/rmdir', { key: S.key, path: a.slice(6) });
            toast('Папка удалена', a.slice(6), 'ok');
            await reloadTaskFiles();
            S.run = null;
            renderResult();
          } catch (e) { toast('Не получилось', e.message, 'bad'); }
        }
        return null;
      });
    });
  }

  let logRaf = null;
  let logPending = [];
  function appendLog(lines, reset) {
    const el = $('#livelog');
    if (!el) return;
    if (reset) { el.textContent = ''; logPending = []; }
    logPending.push(...lines);
    if (logRaf) return;
    logRaf = requestAnimationFrame(() => {
      logRaf = null;
      const box = $('#livelog');
      if (!box) { logPending = []; return; }
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.textContent += `${logPending.join('\n')}\n`;
      logPending = [];
      if (box.textContent.length > 400000) box.textContent = box.textContent.slice(-300000);
      if (atBottom) box.scrollTop = box.scrollHeight;
    });
  }

  let elapsedTimer = null;
  function startElapsed() {
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const el = $('#run-elapsed');
      if (!S.run || (S.run.status !== 'running' && S.run.status !== 'starting')) { clearInterval(elapsedTimer); return; }
      if (el) el.textContent = fmtDur((Date.now() - S.run.started) / 1000).replace(' с', 's');
    }, 250);
  }

  async function runTests() {
    if (!S.key) return;
    if (S.run && S.run.key === S.key && (S.run.status === 'running' || S.run.status === 'starting')) return;
    const key = S.key;
    setBottomTab('result');
    applyBuildMarkers(null);
    const run = { key, status: 'starting', lines: [], started: Date.now() };
    S.run = run;
    renderResult();
    startElapsed();
    // Each outcome replaces S.run only if this run is still the current one.
    const settle = (next) => {
      if (S.run !== run) return;
      S.run = next;
      renderResult();
    };
    if (!(await saveAll())) {
      settle({ key, status: 'error', error: 'Не все файлы сохранились — тесты не запускаю.' });
      return;
    }
    let r;
    try {
      r = await api.post('/api/run', { key });
    } catch (e) {
      settle({ key, status: 'error', error: e.message });
      return;
    }
    if (S.run !== run) return;
    if (r.blocked) {
      settle({ key, status: 'blocked', problems: r.problems });
      return;
    }
    if (r.offline) {
      settle({ key, status: 'done', result: r.result });
      loadEnv(true);
      return;
    }
    run.id = r.id;
    run.status = 'running';
    renderResult();
    streamRun(run);
  }

  // One stream per run object; aborted when leaving the task, so a run is never streamed twice.
  async function streamRun(run) {
    run.abort = new AbortController();
    for (let attempt = 0; attempt < 5 && run.status !== 'done'; attempt++) {
      try {
        await api.stream('GET', `/api/run/stream?id=${encodeURIComponent(run.id)}&from=${run.lines.length}`, null, (ev) => {
          if (ev.type === 'lines') {
            run.lines.push(...ev.lines);
            if (S.run === run) appendLog(ev.lines);
          } else if (ev.type === 'done') {
            run.status = 'done';
            run.result = ev.result;
          }
        }, run.abort.signal);
      } catch (e) {
        if (e.name === 'AbortError') return;
        await sleep(1000);
      }
    }
    if (run.status !== 'done') {
      run.status = 'error';
      run.error = 'Потерял связь с прогоном.';
    }
    onRunDone(run);
  }

  function applyBuildMarkers(res) {
    const monaco = window.monaco;
    if (!monaco) return;
    const byFile = new Map();
    for (const line of (res && res.compile_errors) || []) {
      const m = line.match(/^(.+?):(\d+):\s*(.*)$/);
      if (!m) continue;
      const path = m[1].replace(/^\/task\//, '').replace(/^(\.\.?\/)+/, '');
      const f = S.files.get(path) || Array.from(S.files.values()).find((x) => x.path.endsWith(`/${path}`) || path.endsWith(`/${x.path}`));
      if (!f) continue;
      const ln = Math.min(Number(m[2]), f.model.getLineCount());
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push({
        severity: monaco.MarkerSeverity.Error, startLineNumber: ln, endLineNumber: ln, startColumn: 1,
        endColumn: f.model.getLineMaxColumn(ln), message: `gcc: ${m[3]}`, source: 'build',
      });
    }
    for (const f of S.files.values()) {
      if (!f.model.isDisposed()) monaco.editor.setModelMarkers(f.model, 'build', byFile.get(f) || []);
    }
    updateStatusbar();
  }

  function onRunDone(run) {
    const current = S.run === run && S.key === run.key;
    if (current && run.status === 'done') applyBuildMarkers(run.result);
    if (current) renderResult();
    if (current && run.status === 'done') {
      const v = run.result.verdict;
      if (v === 'AC') {
        fireConfetti(false);
        toast('Открытые тесты пройдены', 'Можно отправлять на проверку грейдеру.', 'ok');
      }
      if (v === 'OFFLINE') loadEnv(true);
      if (S.task) {
        S.task.local_runs = (S.task.local_runs || []).concat([Object.assign({}, run.result, { output: undefined })]);
        if (S.leftTab === 'subs') renderSubs();
      }
    }
    loadOverview().catch(() => {});
  }

  // ---------- console ----------
  function defaultCommand() {
    const t = S.task;
    if (!t) return '';
    if (t.kind === 'c') {
      const target = (t.make_targets || [])[0] || 'build';
      const make = `make -f Makefile.Student ${target}`;
      if (t.example) return `${make} && ${t.example}`;
      return /\.(so|a)$/.test(target) || target === 'all'
        ? `${make} && ls -la`
        : `${make} && ./${target === 'build' ? t.name : target}`;
    }
    if (t.example) return t.example;
    const sh = Array.from(S.files.keys()).find((p) => p.endsWith('.sh'));
    if (sh) return `./${sh}`;
    return 'ls -la';
  }

  function renderConsole() {
    const pane = $('[data-bpane="console"]');
    if (!pane || !S.task) return;
    if (pane.dataset.key === S.key) return;
    pane.dataset.key = S.key;
    const docker = S.env && S.env.docker && S.env.docker.running;
    const mode = prefs.consoleMode || 'docker';
    pane.innerHTML = `
      <div class="console">
        <div class="console-bar">
          <label class="cmd-input"><span>$</span><input id="cmd" spellcheck="false" autocomplete="off" value="${esc(defaultCommand())}"></label>
          <select class="sel" id="cmd-mode" title="Где выполнить">
            <option value="docker" ${mode === 'docker' ? 'selected' : ''}>🐳 Linux (Docker)</option>
            <option value="local" ${mode === 'local' ? 'selected' : ''}>💻 macOS локально</option>
          </select>
          <button class="btn primary" id="cmd-run">${ICON.play} Выполнить</button>
        </div>
        <details class="stdin-box"><summary class="dim" style="font-size:12px;cursor:pointer;padding-top:6px">stdin (ввод для программы)</summary><textarea id="cmd-stdin" placeholder="То, что программа прочитает через read / scanf"></textarea></details>
        <div class="console-out" id="console-out">
          <div class="dim" style="font-size:12.5px;padding:10px 0">Команда выполняется в <b>копии</b> папки задачи — твои файлы не изменятся. ${docker ? 'В Docker окружение как у тестов (Debian, bash 5, GNU-утилиты).' : 'Docker не запущен — доступен режим macOS (bash 3.2 и BSD-утилиты, поведение может отличаться от тестов).'}
          Примеры: <code>./script.sh 5</code>, <code>make -f Makefile.Student build && ./prog</code>, <code>mkdir t && touch t/a.TXT && ./file_sorter.sh; find .</code></div>
        </div>
      </div>`;
    const run = () => runConsole();
    $('#cmd-run').addEventListener('click', run);
    $('#cmd').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
      const hist = S.consoleHistory[S.key] || [];
      if (e.key === 'ArrowUp' && hist.length) {
        e.preventDefault();
        const i = Math.max(0, (e.target.dataset.hi ? Number(e.target.dataset.hi) : hist.length) - 1);
        e.target.dataset.hi = i;
        e.target.value = hist[i];
      }
    });
    $('#cmd-mode').addEventListener('change', (e) => { prefs.consoleMode = e.target.value; savePrefs(); });
  }

  async function runConsole() {
    const cmd = $('#cmd').value.trim();
    if (!cmd) return;
    const mode = $('#cmd-mode').value;
    const out = $('#console-out');
    const hist = S.consoleHistory[S.key] || (S.consoleHistory[S.key] = []);
    if (hist[hist.length - 1] !== cmd) hist.push(cmd);
    $('#cmd').dataset.hi = '';
    if (!(await saveAll())) {
      toast('Команда не запущена', 'Не все файлы сохранились — иначе выполнилась бы старая версия.', 'bad');
      return;
    }
    const box = document.createElement('div');
    box.className = 'cres';
    box.innerHTML = `<div class="cres-head"><span class="cmd">$ ${esc(cmd)}</span><span class="spinner" style="width:13px;height:13px;border-width:2px"></span></div>`;
    out.prepend(box);
    const btn = $('#cmd-run');
    btn.disabled = true;
    try {
      const r = await api.post('/api/exec', { key: S.key, cmd, stdin: $('#cmd-stdin').value, mode, timeout: 20 });
      const changes = (r.changes || []).filter((c) => !c.path.startsWith('open_tests/'));
      box.innerHTML = `
        <div class="cres-head"><span class="cmd" title="${esc(cmd)}">$ ${esc(cmd)}</span>
          <span class="code-badge ${r.code === 0 ? 'ok' : 'bad'}">${r.timed_out ? 'таймаут' : `exit ${r.code}`}</span>
          <span class="dim">${esc(fmtDur(r.duration))} · ${r.mode === 'docker' ? '🐳' : '💻'}</span></div>
        ${r.stdout ? `<pre>${esc(r.stdout)}</pre>` : ''}
        ${r.stderr ? `<pre class="err">${esc(r.stderr)}</pre>` : ''}
        ${!r.stdout && !r.stderr ? '<pre class="dim">(пустой вывод)</pre>' : ''}
        ${changes.length ? `<div class="changes"><details><summary>Файлы после выполнения: ${changes.length}</summary>${changes.map((c) => `
          <div style="margin-top:6px"><span class="fst ${c.change === 'new' ? 'new' : c.change === 'deleted' ? 'del' : ''}">${c.change === 'new' ? 'новый' : c.change === 'deleted' ? 'удалён' : 'изменён'}</span> <span class="mono">${esc(c.path)}</span>${c.link ? ` → <span class="mono">${esc(c.link)}</span>` : ''}
          ${c.preview != null ? `<pre>${esc(c.preview)}</pre>` : ''}</div>`).join('')}</details></div>` : ''}`;
    } catch (e) {
      box.innerHTML = `<div class="cres-head"><span class="cmd">$ ${esc(cmd)}</span><span class="code-badge bad">ошибка</span></div><pre class="err">${esc(e.message)}</pre>
        ${e.data && e.data.action === 'start_docker' ? '<div style="padding:0 11px 10px"><button class="btn sm" data-sd>Запустить Docker</button></div>' : ''}`;
      const sd = $('[data-sd]', box);
      if (sd) sd.addEventListener('click', () => startDocker());
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- submit ----------
  async function openSubmit() {
    if (!S.key || !S.task) return;
    const key = S.key;
    const t = S.task;
    if (!(await saveAll())) {
      toast('Отправка отменена', 'Не все файлы сохранились — иначе ушла бы старая версия решения.', 'bad', 7000);
      return;
    }
    if (S.key !== key) return;
    const m = openModal(`
      <div class="modal-head"><h3>Отправка на проверку</h3><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body" id="sub-body"><div class="row"><span class="spinner"></span><span class="muted">Смотрю, что изменилось в задаче (git status)…</span></div>
      <div class="dim" style="font-size:12px;margin-top:8px">В большом репозитории первый раз это может занять несколько секунд.</div></div>`, { wide: true });
    let pf;
    try {
      pf = await api.post('/api/submit/preflight', { key });
    } catch (e) {
      if (!m.isOpen()) return;
      $('#sub-body', m.el).innerHTML = `<div class="note err">${esc(e.message)}</div>${e.data && e.data.hint ? `<div class="note warn">${esc(e.data.hint)}</div>` : ''}`;
      return;
    }
    if (!m.isOpen() || S.key !== key) return;
    const runs = t.local_runs || [];
    const lastLocal = runs[runs.length - 1];
    const notTested = !lastLocal || lastLocal.verdict !== 'AC';
    const hasChanges = pf.files.length > 0;
    const anySelectable = pf.files.some((f) => !f.protected);
    const body = $('#sub-body', m.el);
    body.innerHTML = `
      <div class="muted">Задача <b>${esc(t.snum + t.letter)}. ${esc(t.title)}</b> → коммит в <code>master</code> и push на GitHub. Грейдер проверит её на скрытых тестах.</div>
      ${pf.errors.map((x) => `<div class="note err">${esc(x)}</div>`).join('')}
      ${pf.lock && pf.lock.stale ? '<div style="margin:6px 0"><button class="btn sm" data-unlock>Убрать зависшую блокировку</button></div>' : ''}
      ${notTested ? `<div class="note warn">${lastLocal ? `Последний локальный прогон: ${esc(vname(lastLocal.verdict))}.` : 'Открытые тесты ещё не запускались.'} Можно отправить и так, но лучше сначала ▶.</div>` : ''}
      ${hasChanges ? `
        <div class="section-label" style="margin-top:12px">Что уйдёт в коммит — только файлы этой задачи</div>
        <div class="flist">${pf.files.map((f) => `
          <label><input type="checkbox" data-f="${esc(f.path)}" ${f.selected ? 'checked' : ''} ${f.protected ? 'disabled' : ''}>
            <span class="fpath grow">${esc(f.rel)}</span>
            ${f.binary ? '<span class="fst" title="Бинарник/артефакт сборки — обычно не нужен">бинарный</span>' : f.artifact ? '<span class="fst">артефакт</span>' : ''}
            ${f.protected ? '<span class="fst">файл тестов</span>' : ''}
            <span class="fst ${f.status === 'новый' ? 'new' : f.status === 'удалён' ? 'del' : ''}">${esc(f.status)}</span></label>`).join('')}</div>
        <div class="dim" style="font-size:12px">Если ничего не отметить, уйдёт пустой коммит — повторная проверка того, что уже лежит в репозитории.</div>`
        : ''}
      ${!anySelectable ? `<div class="note info">В решении нет изменений относительно последнего коммита. Можно отправить <b>повторную проверку</b> пустым коммитом — грейдер прогонит то, что уже лежит в репозитории.</div>` : ''}
      <div class="section-label">Сообщение коммита</div>
      <div class="commit-msg">${esc(pf.message)}</div>
      ${pf.unpushed.length ? `<div class="note warn">Вместе с этим уйдут неотправленные коммиты:<br>${pf.unpushed.map((x) => `<span class="mono">${esc(x)}</span>`).join('<br>')}</div>` : ''}
      ${pf.warnings.map((x) => `<div class="note warn">${esc(x)}</div>`).join('')}
      <div id="sub-steps"></div>`;
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-unlock]');
      if (!b) return;
      b.disabled = true;
      try {
        await api.post('/api/git/unlock');
        toast('Блокировка снята', 'Проверяю задачу заново…', 'ok');
        m.close();
        openSubmit();
      } catch (err) {
        toast('Не получилось', err.message, 'bad');
        b.disabled = false;
      }
    });
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    foot.innerHTML = `<span class="dim" style="font-size:12px;margin-right:auto;align-self:center">Без подписей и соавторов — коммит только от тебя.</span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn success" id="sub-go" ${pf.errors.length ? 'disabled' : ''}></button>`;
    m.el.appendChild(foot);
    $$('[data-close]', foot).forEach((b) => b.addEventListener('click', () => m.close()));
    const go = $('#sub-go', m.el);
    const checked = () => $$('input[data-f]', m.el).filter((i) => i.checked).map((i) => i.dataset.f);
    const label = () => {
      const n = checked().length;
      go.innerHTML = `${ICON.send} ${n ? `Отправить (${n} ${plural(n, ['файл', 'файла', 'файлов'])})` : 'Отправить повторно'}`;
    };
    label();
    m.el.addEventListener('change', (e) => { if (e.target.matches('input[data-f]')) label(); });
    go.focus();
    go.addEventListener('click', async () => {
      if (go.disabled) return;
      const files = checked();
      go.disabled = true;
      $$('input[data-f]', m.el).forEach((i) => { i.disabled = true; });
      const steps = $('#sub-steps', m.el);
      steps.innerHTML = '<div class="steps" id="steps-log"></div>';
      const logEl = $('#steps-log', m.el);
      const add = (text, cls = '') => { logEl.innerHTML += `<div class="${cls}">${esc(text)}</div>`; logEl.scrollTop = logEl.scrollHeight; };
      let sha = null;
      let failed = null;
      try {
        await api.stream('POST', '/api/submit', { key, files, allow_empty: files.length === 0 }, (ev) => {
          if (ev.type === 'step') add(`▸ ${ev.text}`);
          else if (ev.type === 'log') add(ev.text, 'dim');
          else if (ev.type === 'error') failed = ev;
          else if (ev.type === 'done') sha = ev.sha;
        });
      } catch (e) {
        failed = { message: e.message };
      }
      if (failed || !sha) {
        failed = failed || { message: 'Отправка прервалась' };
        add(`✕ ${failed.message}`, 's-err');
        if (failed.log) add(failed.log, 'dim');
        if (failed.hint) steps.insertAdjacentHTML('beforeend', `<div class="note warn">${esc(failed.hint)}</div>`);
        if (failed.stale_lock) steps.insertAdjacentHTML('beforeend', '<div style="margin-top:6px"><button class="btn sm" data-unlock>Убрать зависшую блокировку</button></div>');
        if (failed.committed) {
          const again = go.cloneNode(false);
          again.textContent = 'Повторить push';
          again.disabled = false;
          go.replaceWith(again);
          again.addEventListener('click', async () => {
            if (again.disabled) return;
            again.disabled = true;
            const okPush = await retryPush(m, key);
            if (okPush) again.remove(); else again.disabled = false;
          });
        }
        return;
      }
      add(`✓ Отправлено: ${sha.slice(0, 7)}`, 's-ok');
      foot.innerHTML = '<button class="btn" data-close>Закрыть</button>';
      $$('[data-close]', foot).forEach((b) => b.addEventListener('click', () => m.close()));
      watchJudge(sha, key, m);
    });
  }

  async function retryPush(m, key) {
    const steps = $('#steps-log', m.el);
    const add = (text, cls = '') => { steps.innerHTML += `<div class="${cls}">${esc(text)}</div>`; };
    let sha = null;
    let failed = null;
    try {
      await api.stream('POST', '/api/submit/push', { key }, (ev) => {
        if (ev.type === 'step') add(`▸ ${ev.text}`);
        else if (ev.type === 'log') add(ev.text, 'dim');
        else if (ev.type === 'error') failed = ev;
        else if (ev.type === 'done') sha = ev.sha;
      });
    } catch (e) { failed = { message: e.message }; }
    if (failed || !sha) {
      add(`✕ ${(failed && failed.message) || 'не вышло'}`, 's-err');
      if (failed && failed.hint) add(failed.hint, 'dim');
      return false;
    }
    add(`✓ Отправлено: ${sha.slice(0, 7)}`, 's-ok');
    watchJudge(sha, key, m);
    return true;
  }

  function judgeLiveHtml(state, res, run) {
    if (state === 'completed' && res) {
      const ff = res.first_failed && res.first_failed.index && res.verdict !== 'AC' ? ` on test ${res.first_failed.index}` : '';
      return `<div class="judge-live"><div class="grow"><div class="vname v-${res.verdict}">${esc(res.verdict_name || vname(res.verdict))}${esc(ff)}</div>
        <div class="muted" style="font-size:12.5px">${res.total != null ? `Тесты: ${res.passed}/${res.total} · ` : ''}проверка грейдером завершена</div></div>
        ${run && run.url ? `<a class="btn sm" href="${esc(run.url)}" target="_blank" rel="noopener">Лог ↗</a>` : ''}</div>`;
    }
    const text = state === 'waiting' ? 'Ждём, пока GitHub запустит проверку…' : state === 'queued' ? 'В очереди у грейдера…'
      : state === 'in_progress' ? 'Грейдер гоняет скрытые тесты…' : 'Проверяю статус…';
    return `<div class="judge-live"><span class="spinner"></span><div class="grow"><div class="vname v-TESTING">${state === 'in_progress' ? 'Testing…' : 'In queue'}</div>
      <div class="muted" style="font-size:12.5px">${text}</div></div>${run && run.url ? `<a class="btn sm" href="${esc(run.url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}</div>`;
  }

  async function watchJudge(sha, key, modal) {
    if (S.judgeWatch.has(sha)) return;
    S.judgeWatch.set(sha, true);
    const slot = () => modal && modal.isOpen() && $('#sub-steps', modal.el);
    const render = (state, res, run) => {
      const el = slot();
      if (!el) return;
      let live = $('.judge-live', el);
      const html = judgeLiveHtml(state, res, run);
      if (live) live.outerHTML = html; else el.insertAdjacentHTML('beforeend', html);
    };
    render('waiting');
    loadOverview().then(() => { if (S.route.view === 'home') { renderHero(); renderHomeBody(); } }).catch(() => {});
    const t0 = Date.now();
    let res = null;
    let run = null;
    while (Date.now() - t0 < 20 * 60 * 1000) {
      let r;
      try { r = await api.get('/api/judge/commit', { sha }); } catch (e) { r = { state: 'unknown' }; }
      run = r.run;
      if (r.state === 'completed' && r.run) {
        res = (r.run.results || {})[key] || null;
        render('completed', res || { verdict: r.run.conclusion === 'success' ? 'AC' : 'JE' }, r.run);
        break;
      }
      render(r.state, null, r.run);
      await sleep(r.state === 'waiting' ? 3000 : 5000);
    }
    S.judgeWatch.delete(sha);
    try { await loadOverview(); } catch (e) { /* ignore */ }
    if (S.route.view === 'home') { renderHero(); renderHomeBody(); }
    if (S.key === key) {
      try { await loadTask(key, true); } catch (e) { /* ignore */ }
    }
    if (res) {
      const t = allTasksFlat().find((x) => x.key === key);
      const name = t ? `${t.snum}${t.letter}. ${t.title}` : key;
      if (res.verdict === 'AC') {
        fireConfetti(true);
        toast(`Accepted! +${t ? t.points : ''} баллов`, name, 'ok', 8000);
      } else {
        toast(`${vname(res.verdict)}`, `${name} — подробности во вкладке «Посылки»`, 'bad', 9000);
      }
    }
  }

  // ---------- chat ----------
  const QUICK = [
    ['hint', '💡 Подсказка', 'Дай подсказку, в какую сторону двигаться дальше. Без готового решения.'],
    ['why', '🐞 Почему падает?', 'Почему не проходят тесты? Разбери вывод последнего прогона и мой код, укажи конкретное место ошибки.'],
    ['review', '🔍 Ревью', 'Сделай ревью моего решения: ошибки, граничные случаи, что может упасть на скрытых тестах, стиль.'],
    ['explain', '📖 Объясни условие', 'Объясни условие простыми словами: что на вход, что на выход, какие граничные случаи могут проверять.'],
    ['theory', '🧠 Теория', 'Какие темы, команды и функции нужны для этой задачи? Объясни базу на маленьких примерах, не решая саму задачу.'],
  ];

  function chatReady() {
    return S.env && S.env.claude && S.env.claude.loggedIn;
  }

  async function openChatPane() {
    const pane = $('[data-pane="chat"]');
    if (!pane || !S.task) return;
    if (!S.chat || S.chat.key !== S.key) {
      S.chat = { key: S.key, messages: [], streaming: false, loaded: false, selection: null };
      pane.innerHTML = '';
    }
    if (!pane.dataset.built || pane.dataset.key !== S.key) {
      pane.dataset.built = '1';
      pane.dataset.key = S.key;
      const mode = prefs.chatMode || 'hint';
      const model = prefs.chatModel || '';
      pane.innerHTML = `
        <div class="chat">
          <div class="chat-head">
            <div class="seg" id="chat-mode" title="Насколько подробно помогать">
              <button data-mode="hint" class="${mode === 'hint' ? 'on' : ''}">💡 Подсказки</button>
              <button data-mode="full" class="${mode === 'full' ? 'on' : ''}">📚 Полный разбор</button>
            </div>
            <select class="sel" id="chat-model" title="Модель" style="height:28px">
              <option value="" ${model === '' ? 'selected' : ''}>модель по умолчанию</option>
              <option value="sonnet" ${model === 'sonnet' ? 'selected' : ''}>Sonnet — быстро</option>
              <option value="opus" ${model === 'opus' ? 'selected' : ''}>Opus — умнее</option>
              <option value="haiku" ${model === 'haiku' ? 'selected' : ''}>Haiku — очень быстро</option>
            </select>
            <span class="spacer"></span>
            <button class="btn xs ghost" id="chat-copy" title="Скопировать промпт с контекстом задачи — вставить в Claude вручную">${ICON.copy} Промпт</button>
            <button class="btn xs ghost" id="chat-new" title="Начать новый диалог">Новый чат</button>
          </div>
          <div id="chat-setup"></div>
          <div class="chat-log" id="chat-log"></div>
          <div class="quick" id="chat-quick">${QUICK.map(([id, label]) => `<button data-q="${id}">${label}</button>`).join('')}</div>
          <div class="composer">
            <div id="chat-sel"></div>
            <div class="composer-box">
              <textarea id="chat-input" rows="2" placeholder="Спроси что угодно про задачу… (Enter — отправить, Shift+Enter — новая строка)"></textarea>
              <div class="composer-foot">
                <label title="Приложить текущие файлы решения"><input type="checkbox" id="chat-code" ${prefs.chatCode === false ? '' : 'checked'}> мой код</label>
                <label title="Приложить вывод последнего прогона тестов"><input type="checkbox" id="chat-run" ${prefs.chatRun === false ? '' : 'checked'}> последний прогон</label>
                <span class="spacer"></span>
                <button class="btn sm primary" id="chat-send">${ICON.send} Спросить</button>
              </div>
            </div>
          </div>
        </div>`;
      bindChat(pane);
    }
    renderChatSetup();
    if (!S.chat.loaded && !S.chat.loadPromise) {
      // sendChat awaits this, so a quick question never races the history load
      const chat = S.chat;
      chat.loadPromise = api.get('/api/chat', { key: chat.key }).then((r) => {
        chat.messages = (r.messages || []).concat(chat.messages);
        chat.loaded = true;
      }).catch((e) => {
        toast('История чата не загрузилась', e.message, 'warn');
      }).finally(() => {
        chat.loadPromise = null;
        if (S.chat === chat && !chat.streaming) renderChatLog();
      });
    }
    const ta = $('#chat-input');
    if (ta && !S.chat.streaming) setTimeout(() => ta.focus(), 30);
  }

  function renderChatSetup() {
    const box = $('#chat-setup');
    if (!box) return;
    const c = S.env && S.env.claude;
    if (!S.env) { box.innerHTML = ''; return; }
    if (c && c.loggedIn) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="setup-card">
      <b>${c && c.installed ? 'Claude CLI не авторизован' : 'Claude CLI не найден'}</b>
      ${c && c.installed ? `<ol><li>Открой терминал и запусти <code>claude</code></li><li>Выполни <code>/login</code> и войди в аккаунт</li><li>Вернись сюда и нажми «Проверить снова»</li></ol>`
        : `<ol><li>Нужны Node.js и подписка Claude (Pro/Max) или API-ключ</li><li>Установи: <code>npm install -g @anthropic-ai/claude-code</code></li><li>Запусти <code>claude</code>, выполни <code>/login</code>, потом перезапусти SegForces</li></ol>`}
      <div class="row"><button class="btn sm" id="chat-recheck">${ICON.sync} Проверить снова</button><button class="btn sm ghost" id="chat-copy2">${ICON.copy} Пока скопировать промпт</button></div>
    </div>`;
    $('#chat-recheck').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      await loadEnv(true);
      if (chatReady()) toast('Claude подключён', 'Можно спрашивать!', 'ok');
    });
    $('#chat-copy2').addEventListener('click', () => copyPrompt());
  }

  function bindChat(pane) {
    $('#chat-mode', pane).addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      prefs.chatMode = b.dataset.mode;
      savePrefs();
      $$('#chat-mode button', pane).forEach((x) => x.classList.toggle('on', x === b));
    });
    $('#chat-model', pane).addEventListener('change', (e) => { prefs.chatModel = e.target.value; savePrefs(); });
    $('#chat-code', pane).addEventListener('change', (e) => { prefs.chatCode = e.target.checked; savePrefs(); });
    $('#chat-run', pane).addEventListener('change', (e) => { prefs.chatRun = e.target.checked; savePrefs(); });
    $('#chat-new', pane).addEventListener('click', async () => {
      if (S.chat.streaming) return;
      if (S.chat.messages.length && !window.confirm('Начать новый диалог? Текущий удалится.')) return;
      await api.post('/api/chat/reset', { key: S.key }).catch(() => {});
      S.chat.messages = [];
      renderChatLog();
    });
    $('#chat-copy', pane).addEventListener('click', () => copyPrompt());
    $('#chat-quick', pane).addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      const q = QUICK.find((x) => x[0] === b.dataset.q);
      askClaude(q[2], { quick: q[0] });
    });
    const ta = $('#chat-input', pane);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendChat();
      }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
    });
    $('#chat-send', pane).addEventListener('click', () => {
      if (S.chat.streaming) stopChat(); else sendChat();
    });
    $('#chat-log', pane).addEventListener('click', (e) => {
      const b = e.target.closest('[data-code-act]');
      if (!b) return;
      const pre = b.closest('pre');
      const code = $('code', pre).innerText;
      if (b.dataset.codeAct === 'copy') {
        copyText(code).then((ok) => toast(ok ? 'Скопировано' : 'Не скопировалось', '', ok ? 'ok' : 'bad'));
      } else if (b.dataset.codeAct === 'insert') {
        insertIntoEditor(code);
      }
    });
  }

  function renderSelectionChip() {
    const box = $('#chat-sel');
    if (!box) return;
    const sel = S.chat && S.chat.selection;
    box.innerHTML = sel ? `<div class="tool-chip" style="margin-bottom:6px">📎 выделение из ${esc(sel.file || '')} (${sel.text.split('\n').length} стр.) <button class="btn xs ghost" id="sel-x">✕</button></div>` : '';
    const x = $('#sel-x');
    if (x) x.addEventListener('click', () => { S.chat.selection = null; renderSelectionChip(); });
  }

  function insertIntoEditor(code) {
    const f = S.files.get(S.active);
    if (!f || !S.editor) { toast('Нет открытого файла', 'Открой файл, куда вставить код.', 'warn'); return; }
    const sel = S.editor.getSelection();
    S.editor.pushUndoStop();
    S.editor.executeEdits('claude', [{ range: sel, text: code, forceMoveMarkers: true }]);
    S.editor.pushUndoStop();
    S.editor.focus();
    toast('Вставлено в редактор', `${f.path} — ${MOD}Z отменит`, 'ok');
  }

  async function copyPrompt() {
    const ta = $('#chat-input');
    const text = (ta && ta.value.trim()) || 'Помоги мне с этой задачей: объясни, что нужно сделать, и подскажи, с чего начать.';
    if (!(await saveAll())) {
      toast('Промпт не собран', 'Не все файлы сохранились — в промпт попал бы старый код.', 'bad');
      return;
    }
    try {
      const r = await api.post('/api/chat/prompt', {
        key: S.key, text, mode: prefs.chatMode || 'hint',
        include_code: $('#chat-code') ? $('#chat-code').checked : true,
        include_run: $('#chat-run') ? $('#chat-run').checked : true,
      });
      const ok = await copyText(r.prompt);
      toast(ok ? 'Промпт скопирован' : 'Не удалось скопировать', ok ? 'Вставь его в Claude (claude.ai или приложение) — там вся задача, твой код и вывод тестов.' : '', ok ? 'ok' : 'bad', 6000);
    } catch (e) {
      toast('Не получилось собрать промпт', e.message, 'bad');
    }
  }

  function chatMsgHtml(m, i) {
    if (m.role === 'user') {
      const att = [];
      if ((m.attached || []).includes('include_code')) att.push('код');
      if ((m.attached || []).includes('include_run')) att.push('прогон');
      return `<div class="msg user" data-i="${i}"><div class="bubble">${esc(m.text)}</div>${att.length ? `<div class="att">📎 ${att.join(', ')}${m.mode === 'full' ? ' · полный разбор' : ''}</div>` : ''}</div>`;
    }
    const tools = (m.tools || []).map((t) => `<span class="tool-chip">📖 ${esc(t.name)} ${esc(t.detail || '')}</span>`).join('');
    const meta = [];
    if (m.model) meta.push(esc(String(m.model).replace(/\[.*\]$/, '')));
    if (m.duration_ms) meta.push(fmtDur(m.duration_ms / 1000));
    if (m.cost) meta.push(`$${Number(m.cost).toFixed(3)}`);
    return `<div class="msg assistant" data-i="${i}">
      <div class="who"><span class="claude-mark">✦</span>Claude</div>
      ${tools ? `<div>${tools}</div>` : ''}
      <div class="md" data-md>${m.text ? md(m.text) : ''}</div>
      ${m.error ? `<div class="err">${esc(m.error)}</div>${m.auth_error ? '<div class="note warn" style="margin-top:6px">claude CLI не авторизован: в терминале <code>claude</code> → <code>/login</code>.</div>' : ''}` : ''}
      ${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}
    </div>`;
  }

  function decorateCode(el) {
    $$('pre', el).forEach((pre) => {
      if ($('.code-tools', pre)) return;
      const tools = document.createElement('div');
      tools.className = 'code-tools';
      tools.innerHTML = '<button class="btn xs" data-code-act="copy">Копировать</button><button class="btn xs" data-code-act="insert" title="Вставить в курсор / заменить выделение">В редактор</button>';
      pre.appendChild(tools);
    });
  }

  function renderChatLog() {
    const log = $('#chat-log');
    if (!log || !S.chat) return;
    if (!S.chat.messages.length) {
      log.innerHTML = `<div class="chat-empty"><div class="big">✦</div><h3>Спроси Claude</h3>
        <p>Он видит условие, твой код и вывод тестов. В режиме «Подсказки» он наводит на мысль, а не решает за тебя.</p>
        <p style="margin-top:8px" class="dim">${MOD}J — открыть чат · ${MOD}⇧L — спросить про выделенный код</p></div>`;
      return;
    }
    log.innerHTML = S.chat.messages.map(chatMsgHtml).join('');
    highlightIn(log);
    decorateCode(log);
    log.scrollTop = log.scrollHeight;
  }

  function askClaude(text, opts = {}) {
    setLeftTab('chat');
    setTimeout(() => {
      const ta = $('#chat-input');
      if (!ta) return;
      ta.value = text;
      sendChat(opts);
    }, 50);
  }

  function stopChat() {
    if (!S.chat || !S.chat.streaming) return;
    api.post('/api/chat/stop', { key: S.key }).catch(() => {});
    if (S.chat.abort) S.chat.abort.abort();
  }

  async function sendChat(opts = {}) {
    const chat = S.chat;
    if (!chat || chat.pending) return;
    chat.pending = true; // there are awaits before streaming starts — block a double Enter
    try {
      await sendChatInner(opts);
    } finally {
      chat.pending = false;
    }
  }

  async function sendChatInner(opts = {}) {
    const ta = $('#chat-input');
    if (!ta || !S.chat || S.chat.streaming) return;
    const text = ta.value.trim();
    if (!text) return;
    if (!chatReady()) {
      await loadEnv(true);
      if (!chatReady()) {
        renderChatSetup();
        toast('Claude не подключён', 'Скопируй промпт кнопкой «Промпт» или настрой claude CLI.', 'warn', 6000);
        return;
      }
    }
    if (!(await saveAll())) {
      toast('Вопрос не отправлен', 'Не все файлы сохранились — Claude увидел бы старый код.', 'bad');
      return;
    }
    const chat = S.chat;
    if (!chat || chat.key !== S.key || chat.streaming) return;
    if (chat.loadPromise) await chat.loadPromise;
    const key = S.key;
    const includeCode = $('#chat-code').checked;
    const includeRun = $('#chat-run').checked;
    const payload = {
      key, text, mode: prefs.chatMode || 'hint', model: prefs.chatModel || '', include_code: includeCode,
      include_run: includeRun, quick: opts.quick || null,
    };
    if (chat.selection) {
      payload.selection = chat.selection.text;
      payload.selection_file = chat.selection.file;
    }
    chat.selection = null;
    renderSelectionChip();
    ta.value = '';
    ta.style.height = 'auto';
    const attached = [];
    if (includeCode) attached.push('include_code');
    if (includeRun) attached.push('include_run');
    chat.messages.push({ role: 'user', text, attached, mode: payload.mode });
    const msg = { role: 'assistant', text: '', tools: [] };
    chat.messages.push(msg);
    chat.streaming = true;
    renderChatLog();
    setChatBusy(true);
    const log = $('#chat-log');
    let el = log && log.lastElementChild;
    const mdEl = () => el && $('[data-md]', el);
    if (mdEl()) mdEl().innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    let renderTimer = null;
    const paint = () => {
      renderTimer = null;
      if (!el || !el.isConnected) {
        const lg = $('#chat-log');
        el = lg && lg.querySelector(`[data-i="${chat.messages.length - 1}"]`);
      }
      const target = mdEl();
      if (!target) return;
      const lg = $('#chat-log');
      const nearBottom = lg ? lg.scrollHeight - lg.scrollTop - lg.clientHeight < 120 : false;
      target.innerHTML = msg.text ? md(msg.text) : '<div class="typing"><i></i><i></i><i></i></div>';
      highlightIn(target);
      decorateCode(target);
      if (lg && nearBottom) lg.scrollTop = lg.scrollHeight;
    };
    const schedule = () => { if (!renderTimer) renderTimer = setTimeout(paint, 70); };
    const addTool = (name, detail) => {
      if (!el) return;
      let box = el.querySelector('.tools');
      if (!box) {
        box = document.createElement('div');
        box.className = 'tools';
        el.insertBefore(box, mdEl());
      }
      box.insertAdjacentHTML('beforeend', `<span class="tool-chip">📖 ${esc(name)} ${esc(detail || '')}</span>`);
    };
    chat.abort = new AbortController();
    let done = null;
    try {
      await api.stream('POST', '/api/chat', payload, (ev) => {
        if (ev.type === 'delta') { msg.text += ev.text; schedule(); }
        else if (ev.type === 'tool_input') { msg.tools.push({ name: ev.name, detail: ev.detail }); addTool(ev.name, ev.detail); }
        else if (ev.type === 'notice') toast(ev.text, '');
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') done = { is_error: true, error: ev.message };
      }, chat.abort.signal);
    } catch (e) {
      done = e.name === 'AbortError' ? { is_error: true, error: 'Остановлено' } : { is_error: true, error: e.message };
    }
    chat.streaming = false;
    chat.abort = null;
    if (done) {
      if (done.text && !msg.text) msg.text = done.text;
      if (done.is_error) {
        msg.error = done.error || 'Ошибка';
        msg.auth_error = !!done.auth_error;
        if (done.auth_error) loadEnv(true);
      }
      msg.model = done.model;
      msg.cost = done.cost;
      msg.duration_ms = done.duration_ms;
    }
    if (S.chat === chat && S.key === key) {
      renderChatLog();
      setChatBusy(false);
    }
  }

  function setChatBusy(busy) {
    const b = $('#chat-send');
    if (!b) return;
    b.innerHTML = busy ? `${ICON.stop} Стоп` : `${ICON.send} Спросить`;
    b.classList.toggle('primary', !busy);
    $$('#chat-quick button').forEach((x) => { x.disabled = busy; });
  }

  // -------------------------------------------------------------------------
  // palette & shortcuts
  // -------------------------------------------------------------------------
  function openPalette() {
    if ($('.palette')) return;
    const tasks = allTasksFlat();
    let sel = 0;
    let list = tasks;
    const m = openModal(`
      <div class="pal-input">${ICON.search}<input id="pal-q" placeholder="Задача: название, номер (1B), имя папки…" autocomplete="off"></div>
      <div class="pal-list" id="pal-list"></div>`, { cls: 'palette' });
    const q = $('#pal-q', m.el);
    const box = $('#pal-list', m.el);
    const draw = () => {
      list = tasks.filter((t) => matchesQuery(t, q.value)).slice(0, 60);
      sel = Math.min(sel, Math.max(0, list.length - 1));
      box.innerHTML = list.map((t, i) => `<div class="pal-item ${i === sel ? 'on' : ''}" data-i="${i}">
        ${stIcon(taskState(t))}<span class="pid">${t.snum}${t.letter}</span><span class="grow">${esc(t.title)} <span class="dim mono" style="font-size:11.5px">${esc(t.name)}</span></span>
        <span class="pts-badge ${diffClass(t.points)}">${t.points || ''}</span></div>`).join('') || '<div class="empty">Ничего</div>';
      const on = $('.pal-item.on', box);
      if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const go = (i) => {
      const t = list[i];
      if (!t) return;
      m.close();
      location.hash = `#/p/${t.key}`;
    };
    q.addEventListener('input', () => { sel = 0; draw(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, list.length - 1); draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
      if (e.key === 'Enter') { e.preventDefault(); go(sel); }
    });
    box.addEventListener('click', (e) => {
      const it = e.target.closest('[data-i]');
      if (it) go(Number(it.dataset.i));
    });
    draw();
    q.focus();
  }

  function openShortcuts() {
    const rows = [
      [`${MOD} ↵`, 'Прогнать открытые тесты'], [`${MOD} ⇧ ↵`, 'Отправить на проверку'], [`${MOD} S`, 'Сохранить (и так автосохранение)'],
      [`${MOD} K`, 'Быстрый переход к задаче'], [`${MOD} J`, 'Открыть / закрыть чат с Claude'], [`${MOD} ⇧ L`, 'Спросить Claude про выделенный код'],
      [`${MOD} .`, 'Быстрое исправление (shebang, TAB в Makefile)'], ['F8', 'К следующей проблеме в коде'], ['?', 'Эта шпаргалка'],
    ];
    openModal(`<div class="modal-head"><h3>Горячие клавиши</h3><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body"><table class="grid" style="border:0">${rows.map(([k, d]) => `<tr><td style="width:150px">${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</td><td>${esc(d)}</td></tr>`).join('')}</table></div>`);
  }

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.monaco-editor'));
  }

  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.key) saveActive(true); return; }
    const inField = e.target.closest('.monaco-editor') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if (S.key && mod && e.key === 'Enter' && !inField && !$('.modal-back')) {
      e.preventDefault();
      if (e.shiftKey) openSubmit(); else runTests();
      return;
    }
    if (S.key && mod && e.key.toLowerCase() === 'j' && !e.target.closest('.monaco-editor')) {
      e.preventDefault();
      setLeftTab(S.leftTab === 'chat' ? 'statement' : 'chat');
      return;
    }
    if (e.key === '?' && !isTyping(e) && !$('.modal-back')) { e.preventDefault(); openShortcuts(); }
  });

  // -------------------------------------------------------------------------
  // theme
  // -------------------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('#hljs-theme').href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${theme === 'light' ? 'github' : 'github-dark'}.min.css`;
    if (window.monaco) window.monaco.editor.setTheme(monacoTheme());
  }
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    prefs.theme = next;
    savePrefs();
    applyTheme(next);
  });
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  $('#env-pills').addEventListener('click', () => openEnvModal());
  $('#palette-btn').addEventListener('click', () => openPalette());
  $('#help-btn').addEventListener('click', () => openShortcuts());
  $('#settings-btn').addEventListener('click', () => openSettings());

  // Monaco rejects pending work with "Canceled" when a model is disposed — harmless noise.
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && (e.reason.name === 'Canceled' || e.reason.message === 'Canceled')) e.preventDefault();
  });

  window.addEventListener('focus', () => {
    if (S.key) checkExternalChanges();
  });
  window.addEventListener('beforeunload', (e) => {
    const dirty = Array.from(S.files.values()).some((f) => f.dirty);
    if (dirty) {
      saveAll();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  window.addEventListener('hashchange', router);
  loadEnv().then(() => {
    if (S.route && S.route.view === 'home') renderHomeBanners();
  });
  router();
  loadMonaco().catch(() => {});
  setInterval(() => {
    if (document.hidden) return;
    if (S.route && S.route.view === 'home') syncJudge(false);
  }, 60000);
})();
