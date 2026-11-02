// 管理画面。友人が決めたタイトルやユーザー名を表示するので、DOM へは textContent だけで入れる。
const $ = (id) => document.getElementById(id);
const statusBox = $('status');

// 認証情報は sessionStorage に置く。タブを閉じると消え、公開側のオリジンからは読めない。
const AUTHORIZATION_KEY = 'nakamaba.authorization';
let authorization = null;
let currentUser = null;

function readSavedAuthorization() {
  try {
    return sessionStorage.getItem(AUTHORIZATION_KEY);
  } catch {
    return null;
  }
}

function saveAuthorization(value) {
  try {
    if (value) sessionStorage.setItem(AUTHORIZATION_KEY, value);
    else sessionStorage.removeItem(AUTHORIZATION_KEY);
  } catch {
    // 保存できなくても、このページを開いている間はログインしたまま使える
  }
}

function basicAuthorization(name, password) {
  const bytes = new TextEncoder().encode(`${name}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

function showLogin() {
  authorization = null;
  currentUser = null;
  saveAuthorization(null);
  $('who').textContent = '';
  $('public-link').hidden = true;
  $('logout').hidden = true;
  $('app').hidden = true;
  $('pages').replaceChildren();
  $('users').replaceChildren();
  $('login-panel').hidden = false;
}

function showStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle('error', isError);
  statusBox.hidden = false;
}

function clearStatus() {
  statusBox.hidden = true;
  statusBox.textContent = '';
}

async function api(method, path, body) {
  const headers = authorization ? { Authorization: authorization } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw Object.assign(new Error('もう一度ログインしてください。'), { status: 401 });
  }
  if (!response.ok) throw new Error(data.message || `エラーが起きました（${response.status}）`);
  return data;
}

function element(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  if (options.onClick) node.addEventListener('click', options.onClick);
  node.append(...children);
  return node;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function guard(action) {
  return async (event) => {
    const button = event?.currentTarget;
    if (button) button.disabled = true;
    try {
      await action();
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  };
}

function renderPages(pages) {
  const list = $('pages');
  list.replaceChildren();
  if (pages.length === 0) {
    list.append(element('p', { className: 'empty', text: 'まだページがありません。' }));
    return;
  }
  for (const page of pages) {
    const link = element('a', {
      text: page.title,
      attrs: { href: page.url, target: '_blank', rel: 'noopener noreferrer' },
    });
    const actions = element('div', { className: 'row-actions' });
    if (page.canModify) {
      actions.append(
        element('button', {
          className: 'danger',
          text: '削除',
          attrs: { type: 'button', 'aria-label': `${page.name} を削除` },
          onClick: guard(async () => {
            if (!window.confirm(`ページ「${page.name}」を削除しますか？`)) return;
            await api('DELETE', `/api/pages/${encodeURIComponent(page.name)}`);
            showStatus(`「${page.name}」を削除しました。`);
            await refreshPages();
          }),
        }),
      );
    }
    list.append(
      element(
        'div',
        { className: 'row', attrs: { 'data-page': page.name } },
        element(
          'div',
          { className: 'row-main' },
          element('p', { className: 'row-title' }, link),
          element('p', {
            className: 'row-meta',
            text: `${page.name} ・ ${page.owner} ・ ${formatDate(page.updatedAt)}`,
          }),
        ),
        actions,
      ),
    );
  }
}

async function refreshPages() {
  const { pages } = await api('GET', '/api/pages');
  renderPages(pages);
}

function renderUsers(users, me) {
  const list = $('users');
  list.replaceChildren();
  for (const user of users) {
    const row = element('div', { className: 'row', attrs: { 'data-user': user.name } });
    const showPassword = (password) => {
      row.querySelector('.password')?.remove();
      row.append(
        element('div', {
          className: 'password',
          text: password,
          attrs: { 'aria-label': `${user.name} のパスワード` },
        }),
      );
    };
    const actions = element(
      'div',
      { className: 'row-actions' },
      element('button', {
        text: 'パスワードを表示',
        attrs: { type: 'button' },
        onClick: guard(async () => {
          clearStatus();
          const { password } = await api(
            'GET',
            `/api/users/${encodeURIComponent(user.name)}/password`,
          );
          showPassword(password);
        }),
      }),
      element('button', {
        text: '再発行',
        attrs: { type: 'button' },
        onClick: guard(async () => {
          if (!window.confirm(`「${user.name}」のパスワードを再発行しますか？`)) return;
          const { password } = await api(
            'PUT',
            `/api/users/${encodeURIComponent(user.name)}/password`,
          );
          showPassword(password);
          showStatus(`「${user.name}」のパスワードを再発行しました。`);
        }),
      }),
    );
    if (user.role !== 'admin' && user.name !== me.name) {
      actions.append(
        element('button', {
          className: 'danger',
          text: '削除',
          attrs: { type: 'button', 'aria-label': `${user.name} を削除` },
          onClick: guard(async () => {
            if (!window.confirm(`ユーザー「${user.name}」を削除しますか？`)) return;
            await api('DELETE', `/api/users/${encodeURIComponent(user.name)}`);
            showStatus(`「${user.name}」を削除しました。`);
            await refreshUsers(me);
          }),
        }),
      );
    }
    row.append(
      element(
        'div',
        { className: 'row-main' },
        element('p', { className: 'row-title', text: user.name }),
        element('p', {
          className: 'row-meta',
          text: `${user.role === 'admin' ? 'Admin' : 'メンバー'} ・ ${formatDate(user.createdAt)}`,
        }),
      ),
      actions,
    );
    list.append(row);
  }
  return list;
}

async function refreshUsers(me) {
  const { users } = await api('GET', '/api/users');
  renderUsers(users, me);
}

async function publish(name, file) {
  const { uploadId, upload, maxBytes } = await api(
    'PUT',
    `/api/pages/${encodeURIComponent(name)}/upload`,
  );
  if (file.size > maxBytes) {
    throw new Error(`zip が大きすぎます（上限 ${Math.floor(maxBytes / 1024 / 1024)} MB）。`);
  }
  const form = new FormData();
  for (const [field, value] of Object.entries(upload.fields)) form.append(field, value);
  form.append('file', file);
  const sent = await fetch(upload.url, { method: 'POST', body: form });
  if (!sent.ok) throw new Error(`zip を送れませんでした（${sent.status}）。`);
  return api('PUT', `/api/pages/${encodeURIComponent(name)}`, { uploadId });
}

$('publish-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('publish-button');
  const form = event.currentTarget;
  button.disabled = true;
  showStatus('公開しています…');
  try {
    const result = await publish($('page-name').value, $('page-zip').files[0]);
    showStatus(`公開しました: ${result.url}`);
    form.reset();
    await refreshPages();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = $('user-name').value;
  try {
    const { password } = await api('PUT', `/api/users/${encodeURIComponent(name)}`);
    form.reset();
    await refreshUsers(currentUser);
    const row = document.querySelector(`[data-user="${CSS.escape(name)}"]`);
    row?.append(
      element('div', {
        className: 'password',
        text: password,
        attrs: { 'aria-label': `${name} のパスワード` },
      }),
    );
    showStatus(`「${name}」を追加しました。パスワードを本人へ渡してください。`);
  } catch (error) {
    showStatus(error.message, true);
  }
});

async function enter() {
  currentUser = await api('GET', '/api/me');
  saveAuthorization(authorization);
  const isAdmin = currentUser.role === 'admin';
  $('who').textContent = `${currentUser.name}${isAdmin ? '（Admin）' : ''}`;
  $('public-link').href = currentUser.publicBaseUrl;
  $('public-link').hidden = false;
  $('logout').hidden = false;
  $('login-panel').hidden = true;
  $('users-panel').hidden = !isAdmin;
  $('app').hidden = false;
  await refreshPages();
  if (isAdmin) await refreshUsers(currentUser);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('login-button');
  button.disabled = true;
  clearStatus();
  authorization = basicAuthorization($('login-name').value, $('login-password').value);
  try {
    await enter();
    form.reset();
  } catch (error) {
    $('login-password').value = '';
    showStatus(error.status === 401 ? 'ユーザー名かパスワードが違います。' : error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', () => {
  clearStatus();
  showLogin();
});

authorization = readSavedAuthorization();
if (authorization) {
  enter().catch((error) => {
    if ($('app').hidden) showLogin();
    showStatus(error.message, true);
  });
} else {
  showLogin();
}
