(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let config = null;
  let stats = null;
  let output = null;
  let editing = null; // { type: 'whitelist' | 'custom', name }

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function flash(kind, text, target = $('#alert')) {
    if (!target) return;
    target.className = `alert ${kind}`;
    target.innerHTML = text;
    target.classList.remove('hidden');
    if (target === $('#alert')) {
      clearTimeout(flash._timer);
      flash._timer = setTimeout(() => target.classList.add('hidden'), 6000);
    }
  }

  /* ---------------------------- 请求 ---------------------------- */

  async function request(path, options = {}) {
    const init = { method: 'GET', credentials: 'same-origin', headers: {} };
    if (options.body !== undefined) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await fetch(`/api/${path}`, init);
    } catch {
      throw new Error('网络请求失败，请检查网络或稍后重试');
    }

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: `服务器返回异常（HTTP ${res.status}）` };
    }

    if (res.status === 401) {
      showLogin();
      throw new Error(data.error || '登录已过期，请重新登录');
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
    }
    return data;
  }

  /* ---------------------------- 视图切换 ---------------------------- */

  function showLogin(message) {
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    if (message) flash('err', message, $('#login-alert'));
    setTimeout(() => $('#login-password')?.focus(), 60);
  }

  function showApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
  }

  /* ---------------------- 地址输入的前端校验 ---------------------- */

  function checkTarget(raw) {
    let value = String(raw ?? '').trim();
    if (!value) return { ok: false, msg: '请填写地址' };

    value = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
    if (value.startsWith('//')) value = value.slice(2);
    if (value.endsWith('/') && value.indexOf('/') === value.length - 1) value = value.slice(0, -1);

    if (/[/?#\s]/.test(value)) return { ok: false, msg: '只填写主机部分，不要包含路径、参数或空格' };

    let host = '';
    let port = '';
    const v6 = value.match(/^\[([0-9A-Fa-f:.]+)\](?::([0-9]{1,5}))?$/);
    if (v6) {
      host = `[${v6[1]}]`;
      port = v6[2] ?? '';
    } else {
      const m = value.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
      if (!m) return { ok: false, msg: '端口只能用英文冒号分隔，例如 example.com:8080' };
      host = m[1];
      port = m[2] ?? '';
    }

    if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]+)$/.test(host)) {
      return { ok: false, msg: '主机名包含非法字符' };
    }
    if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
      return { ok: false, msg: '主机名中不能出现开头/结尾/连续的英文句点' };
    }
    if (/^\d+(\.\d+){3}$/.test(host) && host.split('.').some((n) => Number(n) > 255)) {
      return { ok: false, msg: 'IPv4 每一段必须在 0-255 之间' };
    }
    if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) {
      return { ok: false, msg: '端口超出范围，必须是 1-65535' };
    }

    return {
      ok: true,
      authority: port ? `${host}:${port}` : host,
      msg: port ? `将使用 ${host}，端口 ${port}` : `将使用 ${host}（不带端口）`,
    };
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function whitelistGroups() {
    return config?.settings?.whitelist_groups ?? [];
  }

  function customGroups() {
    const list = [];
    for (const ch of config?.channels ?? []) {
      if (whitelistGroups().includes(ch.group)) continue;
      if (!list.includes(ch.group)) list.push(ch.group);
    }
    return list;
  }

  function groupChannels(name) {
    return (config?.channels ?? []).filter((c) => c.group === name);
  }

  function serializeGroup(name) {
    const genres = new Map();
    for (const ch of groupChannels(name)) {
      const g = ch.genre || '默认';
      if (!genres.has(g)) genres.set(g, []);
      genres.get(g).push(ch);
    }
    const lines = [];
    for (const [genre, list] of genres) {
      lines.push(`${genre},#genre#`);
      for (const ch of list) lines.push(`${ch.name},${ch.url}`);
    }
    return lines.join('\n');
  }

  function renderStats(selector) {
    const target = typeof selector === 'string' ? $(selector) : selector;
    if (!target || !stats) return;
    target.innerHTML = `
      <div><strong>${stats.whitelistGroups}</strong>组播主分组</div>
      <div><strong>${stats.customGroups}</strong>自定义分组</div>
      <div><strong>${stats.customChannels}</strong>自定义频道</div>
      <div><strong>${stats.totalChannels}</strong>总频道数</div>`;
  }

  function renderRegionSelect() {
    const select = $('#region-select');
    if (!select) return;
    const previous = select.value;
    const groups = whitelistGroups();
    select.innerHTML = groups.length
      ? groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
      : '<option value="">（暂未添加组播主分组）</option>';
    if (groups.includes(previous)) select.value = previous;
    $('#target-submit').disabled = groups.length === 0;
    $('#target-input').disabled = groups.length === 0;
  }

  function renderTargets() {
    const box = $('#target-list');
    if (!box) return;
    const groups = whitelistGroups();
    if (!groups.length) {
      box.innerHTML = '<div class="hint">暂未添加组播主分组。</div>';
      return;
    }
    box.innerHTML = groups
      .map((g) => {
        const ip = config.settings.region_ips?.[g];
        const count = groupChannels(g).length;
        return `• <b>${esc(g)}</b>：${ip ? `<code>${esc(ip)}</code>` : '<span class="hint">未记录</span>'}（${count} 个频道）`;
      })
      .join('<br>');
  }

  function groupItemHtml(type, name, index) {
    const channels = groupChannels(name);
    const genreCount = new Set(channels.map((c) => c.genre || '默认')).size;
    const ip = config.settings.region_ips?.[name];
    const isEditing = editing && editing.type === type && editing.name === name;
    const id = `edit-${type}-${index}`;

    const ipChip = type === 'whitelist'
      ? `<span class="chip">${ip ? esc(ip) : '未记录地址'}</span>`
      : '<span class="chip tag">自定义分组</span>';

    const targetField = type === 'whitelist'
      ? `<div class="field">
           <label>该分组的地址（IP / 域名 / IP:端口 / 域名:端口）</label>
           <input type="text" name="target" class="wide" value="${esc(ip ?? '')}" placeholder="留空则不改动地址">
           <div class="hint">修改并保存时会同步改写该分组下所有频道的主机部分。</div>
         </div>`
      : '';

    return `
      <div class="group-item">
        <span class="gname" data-act="toggle" data-type="${type}" data-name="${esc(name)}" title="点击展开编辑">${esc(name)}</span>
        ${ipChip}
        <span class="chip count">子分组 ${genreCount} · 频道 ${channels.length}</span>
        <span class="spacer"></span>
        <button class="btn danger" data-act="delete" data-type="${type}" data-name="${esc(name)}">删除</button>
      </div>
      <div class="edit-area ${isEditing ? '' : 'hidden'}" id="${id}">
        <h5>✏️ 编辑${type === 'whitelist' ? '主分组' : '自定义分组'}：${esc(name)}</h5>
        <form data-act="save" data-type="${type}" data-name="${esc(name)}">
          <div class="field">
            <label>分组名称（不可修改）</label>
            <input type="text" value="${esc(name)}" readonly>
          </div>
          ${targetField}
          <div class="field">
            <div class="field-head">
              <label>子分组内容（子分组 + 频道）</label>
              <button type="button" class="btn ghost mini" data-clear>清空</button>
            </div>
            <textarea name="text" rows="14" placeholder="卫视频道,#genre#
CCTV1,http://125.33.94.8:4022/rtp/239.3.1.129:8008">${esc(serializeGroup(name))}</textarea>
            <div class="hint">子分组用「子分组名,#genre#」单独一行，频道用「频道名称,URL」；顺序即输出顺序。</div>
          </div>
          <button type="submit" class="btn primary">💾 保存</button>
          <button type="button" class="btn ghost" data-act="close">关闭</button>
        </form>
      </div>`;
  }

  function renderGroups(type) {
    const box = $(type === 'whitelist' ? '#whitelist-list' : '#custom-list');
    if (!box) return;
    const groups = type === 'whitelist' ? whitelistGroups() : customGroups();

    if (!groups.length) {
      box.innerHTML = '<div class="hint">暂无分组，请在下方添加。</div>';
      return;
    }
    box.innerHTML = groups.map((name, index) => groupItemHtml(type, name, index)).join('');
  }

  function renderBadges() {
    const box = $('#whitelist-badges');
    if (!box) return;
    box.innerHTML = whitelistGroups().map((g) => `<span class="badge">${esc(g)}</span>`).join('') || '<span class="hint">（暂无）</span>';
  }

  function renderOutput() {
    if (!output) return;
    const txt = $('#link-txt');
    const m3u = $('#link-m3u');
    txt.textContent = output.txt;
    txt.href = output.txt;
    m3u.textContent = output.m3u;
    m3u.href = output.m3u;
  }

  /**
   * 新增组播主分组的文本框，空的时候用配置里的默认示例内容填充
   * （对应原版 settings.new_group_text_default）。
   */
  function applyDefaultGroupText() {
    const form = $('#whitelist-add-form');
    if (!form) return;
    const textarea = form.querySelector('textarea[name="text"]');
    if (!textarea || textarea.value.trim() !== '') return;
    const sample = config?.settings?.new_group_text_default;
    if (typeof sample === 'string' && sample.trim() !== '') textarea.value = sample;
  }

  function renderAll() {
    applyDefaultGroupText();
    renderRegionSelect();
    renderTargets();
    renderGroups('whitelist');
    renderGroups('custom');
    renderBadges();
    renderOutput();
    ['#stats-settings', '#stats-whitelist', '#stats-custom', '#stats-output'].forEach((sel) => renderStats(sel));
  }

  /* ---------------------------- 状态加载 ---------------------------- */

  async function loadState() {
    const data = await request('state');
    config = data.config;
    stats = data.stats;
    output = data.output;

    const warning = $('#config-warning');
    if (!data.kvBound) {
      warning.innerHTML = '⚠️ 未检测到 KV 绑定 <code>CONFIG_KV</code>：所有修改都无法保存。请在 Cloudflare 控制台创建 KV 命名空间并绑定为 <b>CONFIG_KV</b> 后重新部署。';
      warning.classList.remove('hidden');
    } else if (data.configSource === 'default') {
      warning.innerHTML = '当前配置还是空的初始状态：添加分组并保存后才会写入 KV。';
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }

    renderAll();
    restoreTab();
  }

  /* ---------------------------- 交互 ---------------------------- */

  const TAB_KEY = 'mrs.activeTab';
  const TARGET_HINT_DEFAULT =
    '支持四种写法：<b>IP</b>、<b>域名</b>、<b>IP:端口</b>、<b>域名:端口</b>（也可以直接粘贴完整 URL）';

  function activateTab(tab) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.panel}`));
  }

  function restoreTab() {
    let panel = '';
    try {
      panel = localStorage.getItem(TAB_KEY) || '';
    } catch {
      panel = '';
    }
    const tab = panel && $(`.tab[data-panel="${panel}"]`);
    if (tab) activateTab(tab);
  }

  function setBusy(button, busy, textWhileBusy = '处理中…') {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = textWhileBusy;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
    }
  }

  document.addEventListener('click', async (event) => {
    const tab = event.target.closest('.tab');
    if (tab) {
      activateTab(tab);
      try {
        localStorage.setItem(TAB_KEY, tab.dataset.panel);
      } catch {
        /* 隐私模式下忽略 */
      }
      return;
    }

    if (event.target.id === 'logout-btn') {
      try {
        await request('logout', { body: {} });
      } catch {
        /* 忽略 */
      }
      editing = null;
      showLogin();
      flash('ok', '已退出登录。', $('#login-alert'));
      return;
    }

    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      const kind = copyBtn.dataset.copy;
      const text = kind === 'txt' ? output?.txt : output?.m3u;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      flash('ok', '链接已复制到剪贴板。');
      return;
    }

    const clearBtn = event.target.closest('[data-clear]');
    if (clearBtn) {
      const field = clearBtn.closest('.field');
      const textarea = field ? field.querySelector('textarea') : null;
      if (!textarea) return;
      if (textarea.value.trim() === '') {
        flash('info', '文本框已经是空的。');
        return;
      }
      if (!window.confirm('确定要清空文本框内容吗？此操作不可撤销！')) return;
      textarea.value = '';
      textarea.focus();
      flash('info', '文本框已清空，点「保存」后才会写入配置。');
      return;
    }

    const action = event.target.closest('[data-act]');
    if (!action) return;

    const act = action.dataset.act;
    const type = action.dataset.type;
    const name = action.dataset.name;

    if (act === 'toggle') {
      const same = editing && editing.type === type && editing.name === name;
      editing = same ? null : { type, name };
      renderAll();
      if (!same) {
        const el = document.getElementById(`edit-${type}-${type === 'whitelist' ? whitelistGroups().indexOf(name) : customGroups().indexOf(name)}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    if (act === 'close') {
      editing = null;
      renderAll();
      return;
    }

    if (act === 'delete') {
      const label = type === 'whitelist' ? '组播主分组' : '自定义分组';
      const count = groupChannels(name).length;
      if (!confirm(`确定要删除${label}「${name}」吗？将同时删除其下 ${count} 个频道，且不可恢复。`)) return;

      setBusy(action, true, '删除中…');
      try {
        const result = await request('group/delete', { body: { type, name } });
        editing = null;
        flash('ok', result.message);
        await loadState();
      } catch (err) {
        setBusy(action, false);
        flash('err', err.message);
      }
    }
  });

  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;

    if (form.id === 'login-form') {
      const password = $('#login-password').value;
      const button = $('#login-submit');
      setBusy(button, true, '登录中…');
      try {
        await request('login', { body: { password } });
        $('#login-password').value = '';
        $('#login-alert').classList.add('hidden');
        showApp();
        await loadState();
      } catch (err) {
        flash('err', err.message, $('#login-alert'));
        setBusy(button, false);
      }
      return;
    }

    if (form.id === 'target-form') {
      const region = $('#region-select').value;
      const target = $('#target-input').value;
      const check = checkTarget(target);
      if (!region) return flash('err', '请先添加组播主分组。');
      if (!check.ok) return flash('err', check.msg);

      const button = $('#target-submit');
      setBusy(button, true, '更新中…');
      try {
        const result = await request('target', { body: { region, target } });
        $('#target-input').value = '';
        flash('ok', result.message);
        await loadState();
      } catch (err) {
        flash('err', err.message);
      } finally {
        setBusy(button, false);
      }
      return;
    }

    if (form.id === 'whitelist-add-form' || form.id === 'custom-add-form') {
      const isWhitelist = form.id === 'whitelist-add-form';
      const nameInput = form.querySelector('[name="name"]');
      const textInput = form.querySelector('[name="text"]');
      const name = nameInput.value.trim();
      const text = textInput.value;
      const button = form.querySelector('button[type="submit"]');

      if (!name) return flash('err', '请填写分组名称。');
      if (!text.trim()) return flash('err', '请填写子分组内容，至少包含一个频道。');

      const body = { type: isWhitelist ? 'whitelist' : 'custom', name, text };
      if (isWhitelist) {
        const targetInput = form.querySelector('[name="target"]');
        const check = checkTarget(targetInput.value);
        if (!check.ok) return flash('err', check.msg);
        body.target = targetInput.value;
      }

      setBusy(button, true, '添加中…');
      try {
        const result = await request('group/add', { body });
        form.reset();
        flash('ok', result.message);
        await loadState();
      } catch (err) {
        flash('err', err.message);
      } finally {
        setBusy(button, false);
      }
      return;
    }

    if (form.dataset.act === 'save') {
      const type = form.dataset.type;
      const name = form.dataset.name;
      const textInput = form.querySelector('[name="text"]');
      const targetInput = form.querySelector('[name="target"]');
      const text = textInput.value;
      const button = form.querySelector('button[type="submit"]');

      if (!text.trim() && !confirm('子分组内容为空，确定要保存吗？')) return;

      const body = { type, name, text };
      if (type === 'whitelist' && targetInput) {
        const raw = targetInput.value.trim();
        if (raw) {
          const check = checkTarget(raw);
          if (!check.ok) return flash('err', check.msg);
          body.target = raw;
        }
      }

      setBusy(button, true, '保存中…');
      try {
        const result = await request('group/update', { body });
        editing = null;
        flash('ok', result.message);
        await loadState();
      } catch (err) {
        setBusy(button, false);
        flash('err', err.message);
      }
    }
  });

  // 地址输入的实时提示（对应原版 validateIPFormat，但支持四种写法并显示归一化结果）
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'target-input') return;
    const hint = $('#target-hint');
    const value = event.target.value.trim();
    if (!value) {
      hint.className = 'hint';
      hint.innerHTML = TARGET_HINT_DEFAULT;
      event.target.classList.remove('invalid');
      return;
    }
    const check = checkTarget(value);
    const region = $('#region-select')?.value;
    hint.className = `hint ${check.ok ? 'ok' : 'error'}`;
    hint.innerHTML = check.ok
      ? `✓ 将把${region ? `「${esc(region)}」` : '该分组'}的代理地址改成 <code>${esc(check.authority)}</code>，路径与组播内层地址不变。`
      : `✗ ${esc(check.msg)}`;
    event.target.classList.toggle('invalid', !check.ok);
  });

  /* ---------------------------- 启动 ---------------------------- */

  (async function boot() {
    try {
      const session = await request('session');
      if (!session.passwordConfigured) {
        showLogin(
          '服务器未设置管理员密码。请到 Cloudflare 项目 Settings → Variables and Secrets 添加环境变量 ADMIN_PASSWORD（类型选 Secret），然后重新部署。',
        );
        return;
      }
      if (!session.authenticated) {
        showLogin();
        return;
      }
      showApp();
      await loadState();
    } catch (err) {
      showLogin(err.message);
    }
  })();
})();
