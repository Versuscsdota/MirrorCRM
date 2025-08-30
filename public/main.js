const api = async (path, opts = {}) => {
  const isFD = (opts && opts.body && typeof FormData !== 'undefined' && opts.body instanceof FormData);
  const headers = isFD ? (opts.headers || {}) : { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, {
    credentials: 'include',
    headers,
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
};

const el = (sel) => document.querySelector(sel);

// Simple modal helpers
function showModal({ title = '', content, submitText = 'Сохранить' }) {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const header = document.createElement('header');
    header.innerHTML = `<h3>${title}</h3>`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ghost';
    cancelBtn.textContent = 'Отмена';
    const okBtn = document.createElement('button');
    okBtn.textContent = submitText;
    actions.append(cancelBtn, okBtn);
    const err = document.createElement('div');
    err.style.color = 'var(--danger)'; err.style.fontSize = '12px'; err.style.minHeight = '16px'; err.style.marginTop = '4px';
    modal.append(header, content, err, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const close = () => { backdrop.remove(); };
    cancelBtn.onclick = () => { close(); resolve(null); };
    okBtn.onclick = () => { resolve({ close, setError: (m)=> err.textContent = m }); };
  });
}

// Employees helper
const Employee = {
  async getAll() {
    return api('/api/employees');
  },
  async get(id, opts = {}) {
    const qs = new URLSearchParams();
    qs.set('id', String(id));
    if (opts.withStats) qs.set('withStats', 'true');
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    return api('/api/employees?' + qs.toString());
  }
};

// Calendar: slot-based without employee linkage
async function renderCalendar() {
  const view = el('#view');
  const today = new Date().toISOString().slice(0,10);
  let date = today;
  let currentMonth = today.slice(0,7); // YYYY-MM
  let slots = [];
  let monthDays = [];

  view.innerHTML = `
    <div style="display:grid;grid-template-columns:320px 1fr;gap:16px;height:calc(100vh - 120px)">
      <div class="card" style="padding:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <button id="mPrev" class="ghost" style="padding:4px 8px">◀</button>
          <strong id="mTitle" style="font-size:14px"></strong>
          <button id="mNext" class="ghost" style="padding:4px 8px">▶</button>
        </div>
        <div id="monthGrid"></div>
        ${(window.currentUser && ['root','admin','interviewer'].includes(window.currentUser.role)) ? '<button id="addSlot" style="width:100%;margin-top:12px">Создать слот</button>' : ''}
      </div>
      <div class="card">
        <div style="padding:16px;border-bottom:1px solid #1e1e1e">
          <h3 style="margin:0;font-size:16px">Слоты на <span id="selectedDate">${today}</span></h3>
        </div>
        <div style="padding:16px;overflow-y:auto;max-height:calc(100vh - 200px)">
          <ul id="slotList" class="empl-list" style="margin:0"></ul>
        </div>
      </div>
    </div>`;

  async function load() {
    const res = await api('/api/schedule?date=' + encodeURIComponent(date));
    slots = res.items || [];
    renderList();
  }

  async function loadMonth() {
    const res = await api('/api/schedule?month=' + encodeURIComponent(currentMonth));
    monthDays = res.days || [];
    renderMonth();
  }

  function renderList() {
    const list = el('#slotList');
    if (!slots.length) { list.innerHTML = '<li class="employee-item"><div class="employee-info">Слотов нет</div></li>'; return; }
    list.innerHTML = slots.map(s => `
      <li class="employee-item">
        <div class="employee-info">
          <div class="employee-header">
            <div class="empl-name">${s.start || ''}–${s.end || ''} ${s.title ? '· ' + s.title : ''}</div>
            <div class="employee-actions">
              <button class="open-slot" data-id="${s.id}">Открыть</button>
              ${(['root','admin','interviewer'].includes(window.currentUser.role)) ? `<button class="edit-slot" data-id="${s.id}">Редактировать</button>` : ''}
              ${(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin')) ? `<button class="delete-slot" data-id="${s.id}">Удалить</button>` : ''}
            </div>
          </div>
          ${s.notes ? `<div class="empl-notes">${s.notes}</div>` : ''}
        </div>
      </li>
    `).join('');

    // Wire actions
    [...list.querySelectorAll('.open-slot')].forEach(b => b.onclick = () => openSlot(b.dataset.id));
    [...list.querySelectorAll('.edit-slot')].forEach(b => b.onclick = () => editSlot(b.dataset.id));
    [...list.querySelectorAll('.delete-slot')].forEach(b => b.onclick = () => deleteSlot(b.dataset.id));
  }

  // Month grid with slot previews
  function renderMonth() {
    const grid = el('#monthGrid');
    const [y, m] = currentMonth.split('-').map(x=>parseInt(x,10));
    const d0 = new Date(y, m-1, 1);
    const monthName = d0.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
    const titleEl = el('#mTitle');
    if (titleEl) titleEl.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
    const startDow = (d0.getDay()+6)%7; // Mon=0
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i=0;i<startDow;i++) cells.push(null);
    for (let day=1; day<=daysInMonth; day++) cells.push(new Date(y, m-1, day));
    while (cells.length % 7) cells.push(null);

    const byDate = new Map((monthDays||[]).map(d => [d.date, d]));
    const todayStr = new Date().toISOString().slice(0,10);

    grid.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;font-size:11px;color:var(--muted);margin-bottom:4px;text-align:center">
        <div>Пн</div><div>Вт</div><div>Ср</div><div>Чт</div><div>Пт</div><div>Сб</div><div>Вс</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">
        ${cells.map(c => {
          if (!c) return `<div style="height:40px;border:1px solid #1a1a1a;background:#0a0a0a"></div>`;
          const dstr = c.toISOString().slice(0,10);
          const info = byDate.get(dstr);
          const isToday = dstr === todayStr;
          const isSelected = dstr === date;
          const hasSlots = info && info.count > 0;
          return `
            <button class="cal-cell" data-date="${dstr}" style="height:40px;display:flex;align-items:center;justify-content:center;position:relative;padding:2px;border:1px solid ${isSelected ? '#2bb3b1' : '#1a1a1a'};background:${isToday ? '#1a2a2a' : (hasSlots ? '#1a1a2a' : '#0a0a0a')};font-size:12px;color:${isSelected ? '#2bb3b1' : (hasSlots ? '#fff' : '#888')}">
              ${c.getDate()}
              ${hasSlots ? `<div style="position:absolute;top:2px;right:2px;width:6px;height:6px;background:#2bb3b1;border-radius:50%"></div>` : ''}
            </button>`;
        }).join('')}
      </div>`;

    [...grid.querySelectorAll('.cal-cell')].forEach(btn => btn.onclick = async () => {
      date = btn.dataset.date;
      el('#selectedDate').textContent = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
      await load();
      renderMonth();
    });
  }

  async function createSlot() {
    const form = document.createElement('div');
    form.innerHTML = `
      <label>Начало<input id="sStart" type="time" required /></label>
      <label>Конец<input id="sEnd" type="time" required /></label>
      <label>Заголовок<input id="sTitle" /></label>
      <label>Заметки<textarea id="sNotes" rows="3"></textarea></label>`;
    const m = await showModal({ title: 'Создать слот', content: form, submitText: 'Создать' });
    if (!m) return;
    const { close, setError } = m;
    const start = form.querySelector('#sStart').value.trim();
    const end = form.querySelector('#sEnd').value.trim();
    const title = form.querySelector('#sTitle').value.trim();
    const notes = form.querySelector('#sNotes').value.trim();
    if (!start || !end) { setError('Укажите время начала и конца'); return; }
    try {
      const created = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ date, start, end, title, notes }) });
      slots = [...slots, created].sort((a,b)=> (a.start||'').localeCompare(b.start||''));
      renderList();
      close();
    } catch (e) { setError(e.message); }
  }

  async function editSlot(id) {
    const s = slots.find(x => x.id === id);
    if (!s) return;
    const form = document.createElement('div');
    form.innerHTML = `
      <label>Начало<input id="sStart" type="time" value="${s.start || ''}" /></label>
      <label>Конец<input id="sEnd" type="time" value="${s.end || ''}" /></label>
      <label>Заголовок<input id="sTitle" value="${s.title || ''}" /></label>
      <label>Заметки<textarea id="sNotes" rows="3">${s.notes || ''}</textarea></label>
      <div id="timeCommentWrap"><label>Комментарий к изменению времени<textarea id="sComment" rows="2" placeholder="Почему изменили время слота"/></label></div>`;
    const m = await showModal({ title: 'Редактировать слот', content: form, submitText: 'Сохранить' });
    if (!m) return;
    const { close, setError } = m;
    const start = form.querySelector('#sStart').value.trim();
    const end = form.querySelector('#sEnd').value.trim();
    const title = form.querySelector('#sTitle').value.trim();
    const notes = form.querySelector('#sNotes').value.trim();
    const timeChanged = (start !== (s.start||'')) || (end !== (s.end||''));
    const comment = timeChanged ? (form.querySelector('#sComment').value || '').trim() : '';
    if (timeChanged && !comment) { setError('Требуется комментарий для изменения времени'); return; }
    try {
      const updated = await api('/api/schedule', { method: 'PUT', body: JSON.stringify({ id: s.id, date, start, end, title, notes, comment }) });
      slots = slots.map(x => x.id === s.id ? updated : x).sort((a,b)=> (a.start||'').localeCompare(b.start||''));
      renderList();
      close();
    } catch (e) { setError(e.message); }
  }

  async function deleteSlot(id) {
    const s = slots.find(x => x.id === id);
    if (!s) return;
    if (!(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin'))) {
      alert('Недостаточно прав для удаления');
      return;
    }
    if (window.currentUser.role === 'root') {
      if (!await confirmRootPassword(`удаление слота ${s.start}-${s.end}`)) return;
    }
    if (!confirm('Удалить слот?')) return;
    try {
      await api(`/api/schedule?id=${encodeURIComponent(s.id)}&date=${encodeURIComponent(date)}`, { method: 'DELETE' });
      slots = slots.filter(x => x.id !== s.id);
      renderList();
    } catch (e) { alert(e.message); }
  }

  async function openSlot(id) {
    const s = slots.find(x => x.id === id);
    if (!s) return;
    const box = document.createElement('div');
    const canCreateModel = window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin');
    box.innerHTML = `
      <div style="display:grid;gap:8px">
        <div><strong>${s.start || ''}–${s.end || ''}</strong> ${s.title ? '· ' + s.title : ''}</div>
        <label>Заметки интервью<textarea id="iText" rows="5" placeholder="Текст интервью">${(s.interview && s.interview.text) || ''}</textarea></label>
        <div>
          <h4>Вложения</h4>
          <div id="attList" style="display:grid;gap:8px"></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="upFile" type="file" accept="image/*,audio/*" />
            <input id="upName" placeholder="Название файла" />
            <button id="uploadBtn" type="button">Загрузить</button>
          </div>
        </div>
        ${Array.isArray(s.history) && s.history.length ? `<div>
          <h4>История</h4>
          <ul id="slotHistory" style="display:grid;gap:6px;list-style:none;padding:0;margin:0"></ul>
        </div>` : ''}
        ${canCreateModel ? `<div style="margin-top:8px"><button id="createModelBtn" type="button">Создать модель из слота</button></div>` : ''}
      </div>`;
    const modalPromise = showModal({ title: 'Слот', content: box, submitText: 'Сохранить' });

    async function refreshFiles() {
      try {
        const res = await api('/api/files?slotId=' + encodeURIComponent(s.id));
        const items = res.items || [];
        const list = box.querySelector('#attList');
        const canDelete = window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin');
        list.innerHTML = items.map(f => {
          const ct = (f.contentType || '').toLowerCase();
          const isImg = ct.startsWith('image/');
          const isAudio = ct.startsWith('audio/');
          return `
            <div class="file-card" style="display:flex;gap:12px;align-items:center">
              <div style="width:64px;height:48px;display:flex;align-items:center;justify-content:center;background:#111;border:1px solid #222">
                ${isImg ? `<img src="${f.url}" style="max-width:100%;max-height:100%;object-fit:contain"/>` : (isAudio ? '🎵' : '📄')}
              </div>
              <div style="flex:1">
                <div>${f.name}</div>
                ${isAudio ? `<audio src="${f.url}" controls style="width:100%"></audio>` : ''}
              </div>
              ${canDelete ? `<div><button class="del-slot-file" data-id="${f.id}" style="background:#dc2626">Удалить</button></div>` : ''}
            </div>`;
        }).join('');

        if (canDelete) {
          [...list.querySelectorAll('.del-slot-file')].forEach(btn => {
            btn.onclick = async () => {
              const fileId = btn.dataset.id;
              if (window.currentUser.role === 'root') {
                if (!await confirmRootPassword('удаление вложения слота')) return;
              }
              if (!confirm('Удалить файл?')) return;
              try {
                await api('/api/files?id=' + encodeURIComponent(fileId), { method: 'DELETE' });
                await refreshFiles();
              } catch (e) { alert(e.message); }
            };
          });
        }
      } catch (e) {
        console.warn(e);
      }
    }

    // initial
    refreshFiles();
    // render history if exists
    const historyEl = box.querySelector('#slotHistory');
    if (historyEl && Array.isArray(s.history)) {
      const actionLabel = (a) => a === 'create' ? 'создание' : a === 'time_change' ? 'смена времени' : 'изменение';
      historyEl.innerHTML = s.history
        .sort((a,b)=> (a.ts||0)-(b.ts||0))
        .map(h => `<li style="font-size:12px;color:#aaa">${new Date(h.ts||Date.now()).toLocaleString('ru-RU')} · ${actionLabel(h.action)}${h.comment ? ` — ${h.comment}` : ''}</li>`)
        .join('');
    }

    box.querySelector('#uploadBtn').onclick = async () => {
      const f = box.querySelector('#upFile').files[0];
      const name = (box.querySelector('#upName').value || '').trim() || (f && f.name) || 'file';
      if (!f) { alert('Выберите файл'); return; }
      const fd = new FormData();
      fd.append('slotId', s.id);
      fd.append('file', f);
      fd.append('name', name);
      try {
        await api('/api/files', { method: 'POST', body: fd });
        box.querySelector('#upFile').value = '';
        box.querySelector('#upName').value = '';
        await refreshFiles();
      } catch (e) { alert(e.message); }
    };

    // Hook create model action (if visible)
    if (canCreateModel) {
      const btn = box.querySelector('#createModelBtn');
      if (btn) btn.onclick = async () => {
        const name = (s.title || `Модель от ${date} ${s.start || ''}`);
        const note = (box.querySelector('#iText').value || '').trim();
        try {
          const model = await api('/api/models', { method: 'POST', body: JSON.stringify({ name, note }) });
          // Ingest slot files and write interview history into model
          await api('/api/models', { method: 'POST', body: JSON.stringify({ action: 'ingestFromSlot', modelId: model.id, date, slotId: s.id }) });
          // Navigate to models and open the created model
          renderModels();
          if (model && model.id && typeof window.renderModelCard === 'function') {
            window.renderModelCard(model.id);
          }
        } catch (e) { alert(e.message); }
      };
    }

    const m = await modalPromise;
    if (!m) return;
    const { close, setError } = m;
    try {
      // save interview text
      const text = () => (box.querySelector('#iText').value || '').trim();
      const updated = await api('/api/schedule', { method: 'PUT', body: JSON.stringify({ id: s.id, date, interviewText: text() }) });
      slots = slots.map(x => x.id === s.id ? updated : x);
      close();
    } catch (e) { setError(e.message); }
  }

  // Remove date input - navigation only via calendar clicks
  const prevBtn = el('#mPrev');
  const nextBtn = el('#mNext');
  
  if (prevBtn) {
    prevBtn.onclick = async () => {
      const [y,m] = currentMonth.split('-').map(n=>parseInt(n,10));
      const d = new Date(y, m-2, 1);
      currentMonth = d.toISOString().slice(0,7);
      await loadMonth();
    };
  }
  
  if (nextBtn) {
    nextBtn.onclick = async () => {
      const [y,m] = currentMonth.split('-').map(n=>parseInt(n,10));
      const d = new Date(y, m, 1); // m is already 1-based, so this goes to next month
      currentMonth = d.toISOString().slice(0,7);
      await loadMonth();
    };
  }
  const addBtn = el('#addSlot'); 
  if (addBtn) addBtn.onclick = createSlot;
  
  const selectedDateEl = el('#selectedDate');
  if (selectedDateEl) {
    selectedDateEl.textContent = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  
  await Promise.all([loadMonth(), load()]);
}

function renderLogin() {
  el('#app').innerHTML = `
    <div class="card">
      <h2>Вход</h2>
      <form id="loginForm">
        <label>Логин<input name="login" required /></label>
        <label>Пароль<input name="password" type="password" required /></label>
        <button type="submit">Войти</button>
      </form>
      <p class="hint">Если это первый запуск — первый пользователь станет root.</p>
    </div>`;

  el('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ login: fd.get('login'), password: fd.get('password') }),
      });
      // First login: must change credentials
      if (res && res.user && res.user.mustChange) {
        const form = document.createElement('div');
        form.innerHTML = `
          <p style="color:var(--muted)">Это первый вход. Пожалуйста, задайте новый логин и пароль.</p>
          <label>Новый логин<input id="newLogin" required /></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <label>Новый пароль<input id="newPass" type="password" required /></label>
            <label>Ещё раз пароль<input id="newPass2" type="password" required /></label>
          </div>`;
        const m = await showModal({ title: 'Смена учётных данных', content: form, submitText: 'Сохранить' });
        if (m) {
          const { close, setError } = m;
          const loginNew = form.querySelector('#newLogin').value.trim().toLowerCase();
          const p1 = form.querySelector('#newPass').value;
          const p2 = form.querySelector('#newPass2').value;
          if (!loginNew || !p1) { setError('Заполните поля'); return; }
          if (p1 !== p2) { setError('Пароли не совпадают'); return; }
          try {
            await api('/api/users', { method: 'PUT', body: JSON.stringify({ login: loginNew, password: p1 }) });
            close();
          } catch (err) {
            setError(err.message);
            return;
          }
        }
      }
      renderApp();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function renderEmployees() {
  const view = el('#view');
  let items = await api('/api/employees');
  view.innerHTML = `
    <section class="bar">
      <input id="emplSearch" placeholder="Поиск по ФИО/должности" />
      <span style="flex:1"></span>
      ${window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin') ? '<button id="addEmployee">Добавить сотрудника</button>' : ''}
    </section>
    <div class="grid" id="emplGrid"></div>
  `;
  const gridEl = el('#emplGrid');
  const isRoot = window.currentUser.role === 'root';
  
  function renderList(){
    const q = (el('#emplSearch').value || '').toLowerCase();
    const filtered = (items || []).filter(e => 
      (e.fullName||'').toLowerCase().includes(q) || 
      (e.position||'').toLowerCase().includes(q) ||
      (e.department||'').toLowerCase().includes(q) ||
      (e.city||'').toLowerCase().includes(q)
    );
    gridEl.innerHTML = filtered.map(e => {
      const contactEmail = e.email ? `<span class="info-item"><a href="mailto:${e.email}">📧 ${e.email}</a></span>` : '';
      const contactTg = e.telegram ? `<span class="info-item"><a href="https://t.me/${String(e.telegram).replace('@','')}" target="_blank">💬 @${String(e.telegram).replace('@','')}</a></span>` : '';
      const contactPhone = e.phone ? `<span class="info-item">📞 ${e.phone}</span>` : '';
      
      return `
        <div class="card model-card employee-card">
          <div class="model-header">
            <div>
              <h3>${e.fullName || 'Сотрудник'}</h3>
              ${e.position ? `<div class="model-fullname">${e.position}</div>` : ''}
            </div>
            <div class="employee-status">
              <span class="status-badge active">Активен</span>
            </div>
          </div>
          
          <div class="employee-contacts">
            <div class="model-info">
              ${contactEmail}
              ${contactTg}
            </div>
          </div>
          
          ${e.notes ? `<div class="employee-notes"><p class="model-note">${e.notes}</p></div>` : ''}
          
          <div class="model-actions">
            <button data-id="${e.id}" class="openEmployee primary">Открыть профиль</button>
            <button data-id="${e.id}" class="toggleMore secondary">Подробнее</button>
            ${isRoot ? `<button class="edit-employee secondary" data-id="${e.id}">Изменить</button>` : ''}
            ${isRoot ? `<button class="delete-employee danger" data-id="${e.id}">Удалить</button>` : ''}
          </div>
          
          <div class="employee-more" data-id="${e.id}" style="display:none">
            <div class="model-info expanded-info">
              ${e.department ? `<span class="info-item">🏢 ${e.department}</span>` : ''}
              ${contactPhone}
              ${e.startDate ? `<span class="info-item">📅 Начал работу: ${e.startDate}</span>` : ''}
              ${e.birthDate ? `<span class="info-item">🎂 Дата рождения: ${e.birthDate}</span>` : ''}
              ${e.city ? `<span class="info-item">🏙️ ${e.city}</span>` : ''}
              ${e.address ? `<span class="info-item">📍 ${e.address}</span>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

    // Open profile
    [...gridEl.querySelectorAll('.openEmployee')].forEach(btn => {
      btn.onclick = () => {
        if (typeof window.renderEmployeeCard === 'function') window.renderEmployeeCard(btn.dataset.id);
      };
    });

    // Toggle more
    [...gridEl.querySelectorAll('.toggleMore')].forEach(btn => {
      btn.onclick = () => {
        const more = gridEl.querySelector(`.employee-more[data-id="${btn.dataset.id}"]`);
        if (more) more.style.display = (more.style.display === 'none' || more.style.display === '') ? 'block' : 'none';
        btn.textContent = (more && more.style.display === 'block') ? 'Скрыть' : 'Показать подробнее';
      };
    });

    // Add functionality
    if (isRoot) {
      [...gridEl.querySelectorAll('.delete-employee')].forEach(btn => {
        btn.onclick = async () => {
          const employeeId = btn.dataset.id;
          const employee = filtered.find(e => e.id === employeeId);
          await deleteEmployeeWithPassword(employee);
        };
      });
      
      [...gridEl.querySelectorAll('.edit-employee')].forEach(btn => {
        btn.onclick = async () => {
          const employeeId = btn.dataset.id;
          const employee = filtered.find(e => e.id === employeeId);
          await editEmployee(employee);
        };
      });
    }
  }
  el('#emplSearch').addEventListener('input', renderList);
  renderList();
  const addBtn = el('#addEmployee');
  if (addBtn) {
    addBtn.onclick = async () => {
      const form = document.createElement('div');
      form.innerHTML = `
        <label>ФИО<input id="fFullName" placeholder="Иванов Иван Иванович" required /></label>
        <label>Должность<input id="fPosition" placeholder="Фотограф" required /></label>
        <label>Отдел<input id="fDepartment" placeholder="Студийная съёмка" /></label>
        <label>Телефон<input id="fPhone" placeholder="+7 (999) 123-45-67" /></label>
        <label>Email<input id="fEmail" placeholder="employee@example.com" /></label>
        <label>Telegram<input id="fTelegram" placeholder="@username" /></label>
        <label>Дата начала работы<input id="fStartDate" type="date" /></label>
        <label>Дата рождения<input id="fBirthDate" type="date" /></label>
        <label>Город<input id="fCity" placeholder="Москва" /></label>
        <label>Адрес<input id="fAddress" placeholder="ул. Пример, д. 1, кв. 1" /></label>
        <label>Заметки<textarea id="fNotes" placeholder="Дополнительная информация о сотруднике" rows="3"></textarea></label>
        <label>Роль
          <select id="fRole">
            <option value="interviewer">Интервьюер</option>
            <option value="curator">Куратор</option>
            <option value="admin">Администратор</option>
          </select>
        </label>
      `;
      const res = await showModal({ title: 'Добавить сотрудника', content: form, submitText: 'Создать' });
      if (!res) return;
      const { close, setError } = res;
      const fullName = form.querySelector('#fFullName').value.trim();
      const position = form.querySelector('#fPosition').value.trim();
      const department = form.querySelector('#fDepartment').value.trim();
      const phone = form.querySelector('#fPhone').value.trim();
      const email = form.querySelector('#fEmail').value.trim();
      const telegram = form.querySelector('#fTelegram').value.trim();
      const startDate = form.querySelector('#fStartDate').value;
      const birthDate = form.querySelector('#fBirthDate').value;
      const city = form.querySelector('#fCity').value.trim();
      const address = form.querySelector('#fAddress').value.trim();
      const notes = form.querySelector('#fNotes').value.trim();
      const role = form.querySelector('#fRole').value;
      if (!fullName || !position) { setError('Заполните ФИО и должность'); return; }
      try {
        const created = await api('/api/employees', { method: 'POST', body: JSON.stringify({ fullName, position, department, phone, email, telegram, startDate, birthDate, city, address, notes, role }) });
        // Optimistic update: add to local list and re-render without refetch
        items = [created, ...items];
        renderList();
        close();
        // Show generated credentials once
        if (created && created.credentials) {
          const info = document.createElement('div');
          info.innerHTML = `
            <p>Учётная запись создана. Передайте сотруднику эти данные для первого входа:</p>
            <div class="card" style="margin:0">
              <div><strong>Логин:</strong> <code>${created.credentials.login}</code></div>
              <div><strong>Пароль:</strong> <code>${created.credentials.password}</code></div>
            </div>
            <p style="color:var(--muted)">При первом входе система попросит задать собственные логин и пароль.</p>`;
          await showModal({ title: 'Данные для входа', content: info, submitText: 'Готово' });
        }
      } catch (e) { setError(e.message); }
    };
  }

  // Add edit employee function
  async function editEmployee(employee) {
    // Fetch full details to include current role
    let full = employee;
    try {
      full = await api('/api/employees?id=' + encodeURIComponent(employee.id));
    } catch {}
    const currentRole = (full && full.role) || 'interviewer';
    const form = document.createElement('div');
    form.innerHTML = `
      <label>ФИО<input id="fFullName" value="${employee.fullName || ''}" placeholder="Иванов Иван Иванович" required /></label>
      <label>Должность<input id="fPosition" value="${employee.position || ''}" placeholder="Фотограф" required /></label>
      <label>Отдел<input id="fDepartment" value="${employee.department || ''}" placeholder="Студийная съёмка" /></label>
      <label>Телефон<input id="fPhone" value="${employee.phone || ''}" placeholder="+7 (999) 123-45-67" /></label>
      <label>Email<input id="fEmail" value="${employee.email || ''}" placeholder="employee@example.com" /></label>
      <label>Telegram<input id="fTelegram" value="${employee.telegram || ''}" placeholder="@username" /></label>
      <label>Дата начала работы<input id="fStartDate" type="date" value="${employee.startDate || ''}" /></label>
      <label>Дата рождения<input id="fBirthDate" type="date" value="${employee.birthDate || ''}" /></label>
      <label>Город<input id="fCity" value="${employee.city || ''}" placeholder="Москва" /></label>
      <label>Адрес<input id="fAddress" value="${employee.address || ''}" placeholder="ул. Пример, д. 1, кв. 1" /></label>
      <label>Роль
        <select id="fRole">
          <option value="interviewer" ${currentRole==='interviewer' ? 'selected' : ''}>Интервьюер</option>
          <option value="curator" ${currentRole==='curator' ? 'selected' : ''}>Куратор</option>
          <option value="admin" ${currentRole==='admin' ? 'selected' : ''}>Администратор</option>
        </select>
      </label>
      <label>Заметки<textarea id="fNotes" placeholder="Дополнительная информация о сотруднике" rows="3">${employee.notes || ''}</textarea></label>
    `;
    
    const res = await showModal({ title: 'Редактировать сотрудника', content: form, submitText: 'Сохранить' });
    if (!res) return;
    
    const { close, setError } = res;
    const fullName = form.querySelector('#fFullName').value.trim();
    const position = form.querySelector('#fPosition').value.trim();
    const department = form.querySelector('#fDepartment').value.trim();
    const phone = form.querySelector('#fPhone').value.trim();
    const email = form.querySelector('#fEmail').value.trim();
    const telegram = form.querySelector('#fTelegram').value.trim();
    const startDate = form.querySelector('#fStartDate').value;
    const birthDate = form.querySelector('#fBirthDate').value;
    const city = form.querySelector('#fCity').value.trim();
    const address = form.querySelector('#fAddress').value.trim();
    const role = form.querySelector('#fRole').value;
    const notes = form.querySelector('#fNotes').value.trim();
    
    if (!fullName || !position) { setError('Заполните ФИО и должность'); return; }
    
    try {
      const updated = await api('/api/employees', { 
        method: 'PUT', 
        body: JSON.stringify({ id: employee.id, fullName, position, department, phone, email, telegram, startDate, birthDate, city, address, role, notes }) 
      });
      
      // Update local list
      const index = items.findIndex(e => e.id === employee.id);
      if (index !== -1) {
        items[index] = updated.employee;
        renderList();
      }
      close();
    } catch (e) { 
      setError(e.message); 
    }
  }

  // expose edit helper for external callers (employee card)
  window._openEditEmployee = (targetId) => {
    const e = (items || []).find(x => x.id === targetId);
    if (e) editEmployee(e);
  };
}

// Detailed employee card with stats
async function renderEmployeeCard(id) {
  const view = el('#view');
  // Default range: last 30 days
  const to = new Date();
  const from = new Date(to.getTime() - 29*24*60*60*1000);
  let range = { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) };
  let data = await Employee.get(id, { withStats: true, ...range });

  function hoursFmt(h) {
    if (!h) return '0 ч';
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return mm ? `${hh} ч ${mm} мин` : `${hh} ч`;
  }

  function render() {
    const e = data;
    const stats = e.stats || { eventsCount: 0, hoursTotal: 0, byDay: [] };
    const byDayArr = Array.isArray(stats.byDay)
      ? stats.byDay
      : Object.entries(stats.byDay || {}).map(([date, count]) => ({ date, count }));
    view.innerHTML = `
      <section class="bar">
        <button id="backToEmployees" class="ghost">← Назад</button>
        <h2 style="margin:0 12px">${e.fullName}</h2>
        <span style="flex:1"></span>
        <label>Период: 
          <input id="stFrom" type="date" value="${range.from}" /> — 
          <input id="stTo" type="date" value="${range.to}" />
        </label>
        <button id="applyRange">Обновить</button>
      </section>
      <div style="display:grid;grid-template-columns:320px 1fr;gap:16px">
        <div class="card" style="padding:16px">
          <h3 style="margin-top:0">Профиль</h3>
          <div style="display:grid;gap:6px;font-size:14px">
            ${e.position ? `<div><strong>Должность:</strong> ${e.position}</div>` : ''}
            ${e.department ? `<div><strong>Отдел:</strong> ${e.department}</div>` : ''}
            ${e.role ? `<div><strong>Роль:</strong> ${e.role}</div>` : ''}
            ${e.phone ? `<div><strong>Телефон:</strong> ${e.phone}</div>` : ''}
            ${e.email ? `<div><strong>Email:</strong> ${e.email}</div>` : ''}
            ${e.telegram ? `<div><strong>Telegram:</strong> <a href="https://t.me/${String(e.telegram).replace('@','')}" target="_blank">${e.telegram}</a></div>` : ''}
            ${e.startDate ? `<div><strong>Начало работы:</strong> ${e.startDate}</div>` : ''}
            ${e.birthDate ? `<div><strong>Дата рождения:</strong> ${e.birthDate}</div>` : ''}
            ${e.city ? `<div><strong>Город:</strong> ${e.city}</div>` : ''}
            ${e.address ? `<div><strong>Адрес:</strong> ${e.address}</div>` : ''}
            ${e.notes ? `<div style="white-space:pre-wrap"><strong>Заметки:</strong> ${e.notes}</div>` : ''}
          </div>
          ${(window.currentUser && (window.currentUser.role === 'root')) ? `
            <div style="margin-top:12px;display:flex;gap:8px">
              <button id="editEmployeeBtn">Редактировать</button>
              <button id="deleteEmployeeBtn" style="background:#dc2626">Удалить</button>
            </div>` : ''}
        </div>
        <div class="card" style="padding:16px">
          <div style="display:flex;gap:24px;align-items:center;border-bottom:1px solid #1e1e1e;padding-bottom:8px;margin-bottom:12px">
            <h3 style="margin:0">Статистика</h3>
            <div style="color:var(--muted)">за период ${range.from} — ${range.to}</div>
          </div>
          <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px">
            <div class="stat-badge"><div class="stat-value">${stats.eventsCount||0}</div><div class="stat-label">событий</div></div>
            <div class="stat-badge"><div class="stat-value">${hoursFmt(stats.hoursTotal||0)}</div><div class="stat-label">отработано</div></div>
          </div>
          <div style="overflow:auto">
            <table class="tbl" style="width:100%;font-size:13px;border-collapse:collapse">
              <thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid #1e1e1e">Дата</th><th style="text-align:left;padding:6px;border-bottom:1px solid #1e1e1e">Кол-во</th><th style="text-align:left;padding:6px;border-bottom:1px solid #1e1e1e">Часы</th></tr></thead>
              <tbody>
                ${byDayArr.map(d => `<tr>
                  <td style="padding:6px;border-bottom:1px solid #111">${d.date}</td>
                  <td style="padding:6px;border-bottom:1px solid #111">${d.count||0}</td>
                  <td style="padding:6px;border-bottom:1px solid #111">${(typeof d.hours === 'number') ? hoursFmt(d.hours) : '—'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;

    // Wire back
    el('#backToEmployees').onclick = renderEmployees;
    // Apply range
    el('#applyRange').onclick = async () => {
      const nf = el('#stFrom').value || range.from;
      const nt = el('#stTo').value || range.to;
      range = { from: nf, to: nt };
      data = await Employee.get(id, { withStats: true, ...range });
      render();
    };
    // Edit/Delete
    const editBtn = el('#editEmployeeBtn');
    if (editBtn) editBtn.onclick = async () => {
      // Reuse list editor if present by temporarily rendering list and opening edit
      await renderEmployees();
      if (typeof window._openEditEmployee === 'function') window._openEditEmployee(id);
    };
    const delBtn = el('#deleteEmployeeBtn');
    if (delBtn) delBtn.onclick = async () => {
      await deleteEmployeeWithPassword({ id, fullName: data.fullName });
    };
  }

  render();
}

// expose globally
window.renderEmployeeCard = renderEmployeeCard;

async function fetchMe() {
  try {
    return await api('/api/users?me=1');
  } catch {
    return null;
  }
}

function renderAppShell(me) {
  el('#app').innerHTML = `
    <header>
      <div class="logo">
        <svg width="120" height="48" viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 45 Q25 35, 35 40 Q45 45, 50 35 Q55 25, 65 30 Q75 35, 80 25" 
                stroke="#2bb3b1" stroke-width="3" fill="none" stroke-linecap="round"/>
          <path d="M90 55 Q100 45, 110 50 Q120 55, 125 45 Q130 35, 140 40 Q150 45, 155 35 Q160 25, 170 30 Q180 35, 185 25" 
                stroke="#2bb3b1" stroke-width="3" fill="none" stroke-linecap="round"/>
          <ellipse cx="35" cy="20" rx="25" ry="15" stroke="#2bb3b1" stroke-width="2" fill="none" transform="rotate(-15 35 20)"/>
        </svg>
      </div>
      <nav>
        ${
          (me.role === 'root' || me.role === 'admin') ? `
            <button id="nav-models">Модели</button>
            <button id="nav-calendar">Календарь</button>
            <button id="nav-employees">Сотрудники</button>
            <button id="nav-files">Файлы</button>
          ` : (me.role === 'interviewer') ? `
            <button id="nav-calendar">Календарь</button>
          ` : ''
        }
      </nav>
      <div class="me">${me ? me.login + ' (' + me.role + ')' : ''}
        <button id="logout">Выход</button>
      </div>
    </header>
    <main id="view"></main>
  `;
  el('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); renderLogin(); };
  if (me.role === 'root' || me.role === 'admin') {
    el('#nav-models').onclick = renderModels;
    el('#nav-calendar').onclick = renderCalendar;
    el('#nav-employees').onclick = renderEmployees;
    el('#nav-files').onclick = renderFileSystem;
  } else if (me.role === 'interviewer') {
    el('#nav-calendar').onclick = renderCalendar;
  }
}

async function renderModels() {
  if (!(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin'))) {
    el('#view').innerHTML = `<div class="card"><h3>Недостаточно прав</h3><p>Доступно только администраторам.</p></div>`;
    return;
  }
  const view = el('#view');
  const data = await api('/api/models');
  let items = data.items || [];
  view.innerHTML = `
    <section class="bar">
      ${(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin')) ? '<button id="addModel">Добавить модель</button>' : ''}
      <input id="search" placeholder="Поиск по имени/описанию" />
      <select id="sort">
        <option value="name-asc">Имя ↑</option>
        <option value="name-desc">Имя ↓</option>
      </select>
    </section>
    <div class="grid" id="modelsGrid"></div>
  `;
  const grid = el('#modelsGrid');
  function applySort(list, mode){
    const arr = [...list];
    if (mode === 'name-desc') arr.sort((a,b)=> (b.name||'').localeCompare(a.name||''));
    else arr.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    return arr;
  }
  function renderList(){
    const q = (el('#search').value || '').toLowerCase();
    const mode = el('#sort').value;
    const filtered = items.filter(m => (m.name||'').toLowerCase().includes(q) || (m.note||'').toLowerCase().includes(q));
    const sorted = applySort(filtered, mode);
    grid.innerHTML = sorted.map(m => {
      const tags = (m.tags || []).slice(0, 3).join(', ');
      const moreTagsCount = Math.max(0, (m.tags || []).length - 3);
      return `
        <div class="card model-card">
          <div class="model-header">
            <h3>${m.name}</h3>
            ${m.fullName ? `<div class="model-fullname">${m.fullName}</div>` : ''}
          </div>
          <div class="model-info">
            ${m.age ? `<span class="info-item">${m.age} лет</span>` : ''}
            ${m.height ? `<span class="info-item">${m.height} см</span>` : ''}
            ${m.measurements ? `<span class="info-item">${m.measurements}</span>` : ''}
          </div>
          ${tags ? `<div class="model-tags">${tags}${moreTagsCount > 0 ? ` +${moreTagsCount}` : ''}</div>` : ''}
          ${m.note ? `<p class="model-note">${m.note}</p>` : ''}
          <div class="model-actions">
            <button data-id="${m.id}" class="openModel">Открыть профиль</button>
          </div>
        </div>`;
    }).join('');
    [...grid.querySelectorAll('.openModel')].forEach(b => b.onclick = () => renderModelCard(b.dataset.id));
  }
  el('#search').addEventListener('input', renderList);
  el('#sort').addEventListener('change', renderList);
  renderList();
  const addBtn = el('#addModel');
  if (addBtn) {
    addBtn.onclick = async () => {
      const form = document.createElement('div');
      form.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Псевдоним/Никнейм<input id="mName" placeholder="Анна" required /></label>
          <label>Полное имя<input id="mFullName" placeholder="Анна Владимировна Петрова" /></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <label>Возраст<input id="mAge" type="number" placeholder="25" min="18" max="50" /></label>
          <label>Рост (см)<input id="mHeight" type="number" placeholder="170" min="150" max="200" /></label>
          <label>Вес (кг)<input id="mWeight" type="number" placeholder="55" min="40" max="100" /></label>
        </div>
        <label>Параметры<input id="mMeasurements" placeholder="90-60-90" /></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Телефон<input id="mPhone" placeholder="+79991234567" /></label>
          <label>Email<input id="mEmail" type="email" placeholder="anna@example.com" /></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Instagram<input id="mInstagram" placeholder="@anna_model" /></label>
          <label>Telegram<input id="mTelegram" placeholder="@anna_tg" /></label>
        </div>
        <label>Теги<input id="mTags" placeholder="фотомодель, реклама, fashion" /></label>
        <label>Примечания<textarea id="mNote" placeholder="Дополнительная информация" rows="3"></textarea></label>
      `;
      const res = await showModal({ title: 'Добавить модель', content: form, submitText: 'Создать' });
      if (!res) return;
      const { close, setError } = res;
      const name = form.querySelector('#mName').value.trim();
      const fullName = form.querySelector('#mFullName').value.trim();
      const age = form.querySelector('#mAge').value;
      const height = form.querySelector('#mHeight').value;
      const weight = form.querySelector('#mWeight').value;
      const measurements = form.querySelector('#mMeasurements').value.trim();
      const phone = form.querySelector('#mPhone').value.trim();
      const email = form.querySelector('#mEmail').value.trim();
      const instagram = form.querySelector('#mInstagram').value.trim();
      const telegram = form.querySelector('#mTelegram').value.trim();
      const tags = form.querySelector('#mTags').value.split(',').map(t => t.trim()).filter(Boolean);
      const note = form.querySelector('#mNote').value.trim();
      if (!name) { setError('Укажите псевдоним модели'); return; }
      try {
        const created = await api('/api/models', { method: 'POST', body: JSON.stringify({ 
          name, fullName, age, height, weight, measurements, phone, email, instagram, telegram, tags, note 
        }) });
        items = [created, ...items];
        renderList();
        close();
      } catch (e) {
        setError(e.message);
      }
    };
  }
}

async function renderModelCard(id) {
  if (!(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin'))) {
    el('#view').innerHTML = `<div class="card"><h3>Недостаточно прав</h3><p>Доступно только администраторам.</p></div>`;
    return;
  }
  const view = el('#view');
  const [model, filesRes] = await Promise.all([
    api('/api/models?id=' + encodeURIComponent(id)),
    api('/api/files?modelId=' + encodeURIComponent(id))
  ]);
  let files = filesRes.items || [];
  
  const mainFile = (files || []).find(f => f.id === model.mainPhotoId && (f.contentType||'').startsWith('image/'));
  view.innerHTML = `
    <div class="model-profile">
      <div class="profile-header">
        <div class="profile-main" style="display:flex;gap:12px;align-items:center">
          ${mainFile ? `<img src="${mainFile.url}" alt="main" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #1e1e1e"/>` : ''}
          <div>
            <h1 style="margin:0">${model.name}</h1>
            ${model.fullName ? `<h2 class="full-name" style="margin:4px 0 0 0">${model.fullName}</h2>` : ''}
            <div class="profile-actions" style="margin-top:8px">
              <button id="editProfile">Редактировать профиль</button>
              <button id="deleteModel" style="background: #dc2626;">Удалить модель</button>
            </div>
          </div>
        </div>
        <div class="profile-info">
          <div class="info-grid">
            ${model.age ? `<div class="info-item"><label>Возраст</label><span>${model.age} лет</span></div>` : ''}
            ${model.height ? `<div class="info-item"><label>Рост</label><span>${model.height} см</span></div>` : ''}
            ${model.weight ? `<div class="info-item"><label>Вес</label><span>${model.weight} кг</span></div>` : ''}
            ${model.measurements ? `<div class="info-item"><label>Параметры</label><span>${model.measurements}</span></div>` : ''}
          </div>
          ${(model.contacts && (model.contacts.phone || model.contacts.email || model.contacts.instagram || model.contacts.telegram)) ? `
            <div class="contacts">
              <h4>Контакты</h4>
              ${model.contacts.phone ? `<div><strong>Телефон:</strong> <a href="tel:${model.contacts.phone}">${model.contacts.phone}</a></div>` : ''}
              ${model.contacts.email ? `<div><strong>Email:</strong> <a href="mailto:${model.contacts.email}">${model.contacts.email}</a></div>` : ''}
              ${model.contacts.instagram ? `<div><strong>Instagram:</strong> <a href="https://instagram.com/${model.contacts.instagram.replace('@', '')}" target="_blank">${model.contacts.instagram}</a></div>` : ''}
              ${model.contacts.telegram ? `<div><strong>Telegram:</strong> <a href="https://t.me/${model.contacts.telegram.replace('@', '')}" target="_blank">${model.contacts.telegram}</a></div>` : ''}
            </div>
          ` : ''}
          ${(model.tags && model.tags.length) ? `
            <div class="tags-section">
              <h4>Теги</h4>
              <div class="tags">${model.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${model.note ? `<div class="notes-section"><h4>Примечания</h4><p>${model.note}</p></div>` : ''}
        </div>
      </div>
      
      <div class="files-section">
        <h3>Файлы портфолио</h3>
        <section class="bar" style="gap:8px;flex-wrap:wrap">
          <form id="fileForm" style="display:${(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin')) ? 'flex' : 'none'};gap:8px;flex-wrap:wrap">
            <input type="file" name="file" required accept="image/*,video/*,.pdf" multiple />
            <input name="name" placeholder="Название" required />
            <input name="description" placeholder="Описание" />
            <button>Загрузить</button>
          </form>
          <input id="fileSearch" placeholder="Поиск по файлам" />
          <select id="fileSort">
            <option value="name-asc">Имя ↑</option>
            <option value="name-desc">Имя ↓</option>
            <option value="date-desc">Дата ↓</option>
          </select>
          <button id="exportCsv" type="button">Экспорт CSV</button>
        </section>
        <div class="files-grid" id="filesGrid"></div>
        <div id="filePreview" style="margin-top:12px"></div>
      </div>

      <div class="comments-section" style="margin-top:16px">
        <h3>Комментарии</h3>
        <div id="commentsList" style="display:grid;gap:8px;margin:8px 0"></div>
        <form id="commentForm" style="display:flex;gap:8px;align-items:flex-start">
          <textarea id="commentText" rows="3" placeholder="Добавить комментарий" style="flex:1"></textarea>
          <button type="submit">Добавить</button>
        </form>
      </div>
    </div>`;
  // Render comments helper
  function renderComments(list){
    const box = el('#commentsList');
    const items = Array.isArray(list) ? [...list] : [];
    items.sort((a,b)=> (a.ts||0) - (b.ts||0));
    box.innerHTML = items.map(c => {
      const when = c.ts ? new Date(c.ts).toLocaleString('ru') : '';
      const who = c.user && (c.user.login || c.user.fullName || c.user.id) ? ` · ${c.user.login || c.user.fullName || c.user.id}` : '';
      const text = (c.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<div class="comment-item" style="padding:8px;border:1px solid #1f2937;border-radius:8px;background:#0b1220">`+
        `<div style="font-size:12px;color:#94a3b8">${when}${who}</div>`+
        `<div style="margin-top:4px;white-space:pre-wrap">${text}</div>`+
      `</div>`;
    }).join('');
  }
  renderComments(model.comments || []);
  const gridEl = el('#filesGrid');
  function applyFileSort(arr, mode){
    const a = [...arr];
    if (mode === 'name-desc') a.sort((x,y)=> (y.name||'').localeCompare(x.name||''));
    else if (mode === 'date-desc') a.sort((x,y)=> (y.createdAt||0) - (x.createdAt||0));
    else a.sort((x,y)=> (x.name||'').localeCompare(y.name||''));
    return a;
  }
  // simple pagination
  let page = 1;
  const pageSize = 24;
  function renderFiles(){
    const q = (el('#fileSearch').value || '').toLowerCase();
    const mode = el('#fileSort').value;
    const filtered = files.filter(f => (f.name||'').toLowerCase().includes(q) || (f.description||'').toLowerCase().includes(q));
    const sorted = applyFileSort(filtered, mode);
    const paged = sorted.slice(0, page*pageSize);
    gridEl.innerHTML = paged.map(f => {
      const viewUrl = f.url;
      const downloadUrl = f.url + (f.url.includes('?') ? '&' : '?') + 'download=1';
      const canDownload = (window.currentUser && window.currentUser.role === 'root');
      const isImage = (f.contentType || '').startsWith('image/');
      const isVideo = (f.contentType || '').startsWith('video/');
      const fileDate = f.createdAt ? new Date(f.createdAt).toLocaleDateString('ru') : '';
      return `
        <div class="file-card">
          ${isImage ? `<div class="file-thumb"><img src="${viewUrl}" alt="${f.name}" loading="lazy" /></div>` : 
            isVideo ? `<div class="file-thumb video"><span>📹</span></div>` : 
            `<div class="file-thumb doc"><span>📄</span></div>`}
          <div class="file-info">
            <div class="file-name">${f.name}</div>
            ${f.description ? `<div class="file-desc">${f.description}</div>` : ''}
            ${fileDate ? `<div class="file-date">${fileDate}</div>` : ''}
            <div class="file-actions">
              ${canDownload ? `<a href="${downloadUrl}" class="file-btn">Скачать</a>` : ''}
              ${isImage ? `<button class="file-btn make-main" data-id="${f.id}">Сделать главной</button>` : ''}
              ${(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin')) ? `<button class="file-btn delete-file" data-id="${f.id}" style="background: #dc2626;">Удалить</button>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
    const moreBtnId = 'moreFilesBtn';
    let moreBtn = document.getElementById(moreBtnId);
    if (sorted.length > paged.length) {
      if (!moreBtn) {
        moreBtn = document.createElement('button');
        moreBtn.id = moreBtnId;
        moreBtn.textContent = 'Показать ещё';
        moreBtn.className = 'file-btn';
        gridEl.parentElement.appendChild(moreBtn);
        moreBtn.onclick = () => { page++; renderFiles(); };
      }
      moreBtn.style.display = '';
    } else if (moreBtn) {
      moreBtn.style.display = 'none';
    }
    // no inline preview, only download
  }
  el('#fileSearch').addEventListener('input', renderFiles);
  el('#fileSort').addEventListener('change', renderFiles);
  
  // File actions: delete and set main photo
  document.addEventListener('click', async (e) => {
    if (e.target.classList.contains('delete-file')) {
      const fileId = e.target.dataset.id;
      const fileName = e.target.closest('.file-card').querySelector('.file-name').textContent;
      if (!confirm(`Удалить файл "${fileName}"?`)) return;
      try {
        await api('/api/files?id=' + encodeURIComponent(fileId), { method: 'DELETE' });
        files = files.filter(f => f.id !== fileId);
        renderFiles();
      } catch (err) {
        alert(err.message);
      }
    }
    if (e.target.classList.contains('make-main')) {
      const fileId = e.target.dataset.id;
      try {
        await api('/api/models', { method: 'PUT', body: JSON.stringify({ id, mainPhotoId: fileId }) });
        model.mainPhotoId = fileId;
        renderModelCard(id);
      } catch (err) { alert(err.message); }
    }
  });

  // Edit profile functionality
  el('#editProfile').onclick = async () => {
    const form = document.createElement('div');
    form.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Псевдоним/Никнейм<input id="mName" value="${model.name || ''}" required /></label>
        <label>Полное имя<input id="mFullName" value="${model.fullName || ''}" /></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <label>Возраст<input id="mAge" type="number" value="${model.age || ''}" min="18" max="50" /></label>
        <label>Рост (см)<input id="mHeight" type="number" value="${model.height || ''}" min="150" max="200" /></label>
        <label>Вес (кг)<input id="mWeight" type="number" value="${model.weight || ''}" min="40" max="100" /></label>
      </div>
      <label>Параметры<input id="mMeasurements" value="${model.measurements || ''}" placeholder="90-60-90" /></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Телефон<input id="mPhone" value="${(model.contacts && model.contacts.phone) || ''}" /></label>
        <label>Email<input id="mEmail" type="email" value="${(model.contacts && model.contacts.email) || ''}" /></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Instagram<input id="mInstagram" value="${(model.contacts && model.contacts.instagram) || ''}" /></label>
        <label>Telegram<input id="mTelegram" value="${(model.contacts && model.contacts.telegram) || ''}" /></label>
      </div>
      <label>Теги<input id="mTags" value="${(model.tags || []).join(', ')}" placeholder="фотомодель, реклама, fashion" /></label>
      <label>Примечания<textarea id="mNote" rows="3">${model.note || ''}</textarea></label>
    `;
    const res = await showModal({ title: 'Редактировать профиль', content: form, submitText: 'Сохранить' });
    if (!res) return;
    const { close, setError } = res;
    const name = form.querySelector('#mName').value.trim();
    const fullName = form.querySelector('#mFullName').value.trim();
    const age = form.querySelector('#mAge').value;
    const height = form.querySelector('#mHeight').value;
    const weight = form.querySelector('#mWeight').value;
    const measurements = form.querySelector('#mMeasurements').value.trim();
    const phone = form.querySelector('#mPhone').value.trim();
    const email = form.querySelector('#mEmail').value.trim();
    const instagram = form.querySelector('#mInstagram').value.trim();
    const telegram = form.querySelector('#mTelegram').value.trim();
    const tags = form.querySelector('#mTags').value.split(',').map(t => t.trim()).filter(Boolean);
    const note = form.querySelector('#mNote').value.trim();
    if (!name) { setError('Укажите псевдоним модели'); return; }
    try {
      await api('/api/models', { method: 'PUT', body: JSON.stringify({ 
        id, name, fullName, age, height, weight, measurements, 
        contacts: { phone, email, instagram, telegram }, tags, note 
      }) });
      close();
      renderModelCard(id); // refresh profile
    } catch (e) {
      setError(e.message);
    }
  };

  // Delete model functionality
  el('#deleteModel').onclick = async () => {
    if (window.currentUser.role === 'root') {
      if (!await confirmRootPassword(`удаление модели "${model.name}"`)) return;
    }
    
    if (!confirm(`Удалить модель "${model.name}"?\n\nЭто действие удалит:\n• Профиль модели\n• Все загруженные файлы\n• Необратимо`)) return;
    try {
      await api('/api/models?id=' + encodeURIComponent(id), { method: 'DELETE' });
      renderModels();
    } catch (err) {
      alert(err.message);
    }
  };

  el('#exportCsv').addEventListener('click', () => {
    const mode = el('#fileSort').value;
    const q = (el('#fileSearch').value || '').toLowerCase();
    const filtered = files.filter(f => (f.name||'').toLowerCase().includes(q) || (f.description||'').toLowerCase().includes(q));
    const sorted = applyFileSort(filtered, mode);
    const rows = [['name','description','url'], ...sorted.map(f => [f.name||'', f.description||'', f.url||''])];
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${model.name}-files.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  renderFiles();
  el('#fileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    fd.append('modelId', id);
    try {
      const res = await fetch('/api/files', { method: 'POST', body: fd, credentials: 'include' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data) {
        if (Array.isArray(data.files)) {
          files = [...data.files, ...files];
        } else if (data.file) {
          files = [data.file, ...files];
        }
      }
      renderFiles();
    } catch (err) { alert(err.message); }
  });
  // Comment submit handler
  const commentForm = el('#commentForm');
  if (commentForm) {
    commentForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ta = el('#commentText');
      const text = (ta.value || '').trim();
      if (!text) return;
      try {
        const resp = await api('/api/models', { method: 'PUT', body: JSON.stringify({ action: 'addComment', modelId: id, text }) });
        // resp: { ok, comment, model }
        ta.value = '';
        const updated = (resp && resp.model) ? resp.model : model;
        renderComments(updated.comments || []);
      } catch (e) { alert(e.message); }
    });
  }
}

function timeStr(d) { return d.toTimeString().slice(0,5); }

function hmFromISO(iso) { return iso.slice(11,16); }
function minutesFromHM(hm) { const [h,m] = hm.split(':').map(Number); return h*60 + m; }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

async function renderSchedule() {
  if (!(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin'))) {
    el('#view').innerHTML = `<div class="card"><h3>Недостаточно прав</h3><p>Доступно только администраторам.</p></div>`;
    return;
  }
  const view = el('#view');
  const now = new Date();
  let date = now.toISOString().slice(0,10);
  const PX_PER_MIN = 2; // scale
  const DAY_START = 8*60, DAY_END = 22*60; // 08:00 - 22:00
  const ROW_H = 56; // per-employee row height

  const [data, employees] = await Promise.all([
    api('/api/schedule?date=' + date),
    api('/api/employees')
  ]);
  let events = data.items || [];
  const width = (DAY_END - DAY_START) * PX_PER_MIN;
  // Build a single grid with sticky left column
  view.innerHTML = `
    <section class="bar">
      <button id="addEvent">+ Новый слот</button>
      <input id="pickDate" type="date" value="${date}" />
      <span style="color: #94a3b8; font-size: 14px; margin-left: auto;">
        ${events.length} слот${events.length === 1 ? '' : events.length < 5 ? 'а' : 'ов'} на ${new Date(date).toLocaleDateString('ru')}
      </span>
    </section>
    <div class="sched-wrap">
      <div class="tl-scroll" id="schedScroll">
        <div class="sched-table">
          <div class="sched-header">
            <div class="cell-left sticky">Сотрудник</div>
            <div class="cell-right" style="width:${width}px">
              <div class="tl-header" id="tlHeader"></div>
              <div class="tl-grid" id="tlGridHeader"></div>
            </div>
          </div>
          ${(employees||[]).map((emp, idx)=>`
            <div class="sched-row" data-emp="${emp.id}" style="height:${ROW_H}px">
              <div class="cell-left sticky">
                <div class="empl-name">${emp.fullName}</div>
                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${emp.position || ''}</div>
              </div>
              <div class="cell-right" style="width:${width}px">
                <div class="row-grid"></div>
                <div class="row-events"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  // Build hour ticks and vlines once (header)
  const header = el('#tlHeader');
  const gridHeader = el('#tlGridHeader');
  let headerHtml = '';
  let vlines = '';
  for (let m = DAY_START; m <= DAY_END; m += 60) {
    const left = (m - DAY_START) * PX_PER_MIN;
    const hh = String(Math.floor(m/60)).padStart(2,'0');
    headerHtml += `<div class="tl-hour" style="left:${left}px">${hh}:00</div>`;
    vlines += `<div class="tl-vline" style="left:${left}px"></div>`;
  }
  header.innerHTML = headerHtml;
  gridHeader.innerHTML = vlines;

  function renderEvents(items){
    // Clear all rows
    document.querySelectorAll('.sched-row').forEach(row => {
      row.querySelector('.row-grid').innerHTML = vlines; // per-row vlines
      row.querySelector('.row-events').innerHTML = '';
    });
    items.forEach(ev => {
      const row = document.querySelector(`.sched-row[data-emp="${ev.employeeId}"]`);
      if (!row) return;
      const s = minutesFromHM(hmFromISO(ev.startISO));
      const e = minutesFromHM(hmFromISO(ev.endISO));
      const left = (s - DAY_START) * PX_PER_MIN;
      const widthPx = Math.max(6, (e - s) * PX_PER_MIN);
      const node = document.createElement('div');
      node.className = 'tl-event';
      node.style.left = left + 'px';
      node.style.width = widthPx + 'px';
      node.dataset.id = ev.id;
      node.dataset.date = ev.date;
      const duration = Math.round((e - s) / 60 * 10) / 10; // hours with 1 decimal
      const timeLabel = `${hmFromISO(ev.startISO)}–${hmFromISO(ev.endISO)} (${duration}ч)`;
      node.innerHTML = `
        <div class="tl-content">
          <span class="tl-title">${ev.title || 'Слот'}</span>
          <span class="tl-time">${timeLabel}</span>
        </div>
        <span class="tl-resize left"></span>
        <span class="tl-resize right"></span>
      `;
      row.querySelector('.row-events').appendChild(node);
    });
  }

  renderEvents(events);

  // interactions: drag move and resize
  let drag = null;
  function onDown(e){
    const target = e.target.closest('.tl-event');
    if (!target) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const isLeft = e.target.classList.contains('left');
    const isRight = e.target.classList.contains('right');
    const currentRow = target.closest('.sched-row');
    const currentEmployeeId = currentRow ? currentRow.dataset.employeeId : null;
    
    const ev = {
      id: target.dataset.id,
      date: target.dataset.date,
      leftPx: parseFloat(target.style.left),
      widthPx: parseFloat(target.style.width),
      mode: isLeft ? 'resize-left' : isRight ? 'resize-right' : 'move',
      startX,
      startY,
      node: target,
      originalEmployeeId: currentEmployeeId,
      currentEmployeeId: currentEmployeeId,
    };
    drag = ev;
    target.classList.add('dragging');
    document.body.style.cursor = ev.mode === 'move' ? 'grabbing' : 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  }
  function onMove(e){
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    
    // Horizontal drag for time changes and resizing
    if (drag.mode === 'move'){
      const nextLeft = clamp(drag.leftPx + dx, 0, (DAY_END-DAY_START)*PX_PER_MIN - drag.widthPx);
      drag.node.style.left = nextLeft + 'px';
      
      // Vertical drag for employee change (only in move mode)
      if (Math.abs(dy) > 10) {
        const schedTable = document.querySelector('.sched-table');
        const rows = [...schedTable.querySelectorAll('.sched-row[data-employee-id]')];
        const currentRowIndex = rows.findIndex(row => row.dataset.employeeId === drag.currentEmployeeId);
        
        if (currentRowIndex >= 0) {
          const rowHeight = 56; // Fixed row height
          const targetRowIndex = Math.max(0, Math.min(rows.length - 1, 
            currentRowIndex + Math.round(dy / rowHeight)));
          
          if (targetRowIndex !== currentRowIndex) {
            const targetRow = rows[targetRowIndex];
            const newEmployeeId = targetRow.dataset.employeeId;
            
            // Visual feedback - highlight target row
            rows.forEach(row => row.classList.remove('drop-target'));
            targetRow.classList.add('drop-target');
            
            drag.currentEmployeeId = newEmployeeId;
          }
        }
      }
    } else if (drag.mode === 'resize-left'){
      const nextLeft = clamp(drag.leftPx + dx, 0, drag.leftPx + drag.widthPx - 6);
      const nextWidth = drag.widthPx + (drag.leftPx - nextLeft);
      drag.node.style.left = nextLeft + 'px';
      drag.node.style.width = Math.max(6, nextWidth) + 'px';
    } else if (drag.mode === 'resize-right'){
      const nextWidth = Math.max(6, drag.widthPx + dx);
      const maxWidth = (DAY_END-DAY_START)*PX_PER_MIN - drag.leftPx;
      drag.node.style.width = clamp(nextWidth, 6, maxWidth) + 'px';
    }
  }
  async function onUp(){
    document.removeEventListener('mousemove', onMove);
    const node = drag.node;
    const leftPx = parseFloat(node.style.left);
    const widthPx = parseFloat(node.style.width);
    node.classList.remove('dragging');
    document.body.style.cursor = '';
    
    // Clear drop target highlights
    document.querySelectorAll('.drop-target').forEach(row => row.classList.remove('drop-target'));
    
    // Check if employee changed
    const employeeChanged = drag.currentEmployeeId !== drag.originalEmployeeId;
    const timeChanged = drag.mode === 'move' || drag.mode === 'resize-left' || drag.mode === 'resize-right';
    
    if (employeeChanged || timeChanged) {
      // convert to HM
      const startMin = Math.round(leftPx / PX_PER_MIN) + DAY_START;
      const endMin = Math.round((leftPx + widthPx) / PX_PER_MIN) + DAY_START;
      const toHM = (m)=> `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
      
      const updateData = { 
        id: node.dataset.id, 
        date: node.dataset.date, 
        start: toHM(startMin), 
        end: toHM(endMin) 
      };
      
      // Add employee change if needed
      if (employeeChanged) {
        updateData.employeeId = drag.currentEmployeeId;
      }
      
      try{
        await api('/api/schedule', { method:'PUT', body: JSON.stringify(updateData) });
        
        // If employee changed, move the event to the new row
        if (employeeChanged) {
          const targetRow = document.querySelector(`.sched-row[data-employee-id="${drag.currentEmployeeId}"] .cell-right`);
          if (targetRow) {
            targetRow.appendChild(node);
            // Update the event in our local data
            const eventIndex = events.findIndex(e => e.id === node.dataset.id);
            if (eventIndex >= 0) {
              events[eventIndex].employeeId = drag.currentEmployeeId;
            }
          }
        }
      }catch(err){ 
        alert(err.message);
        renderEvents(events);
      }
    }
    
    drag = null;
  }
  // delegate mousedown to all rows
  document.querySelector('.sched-table').addEventListener('mousedown', onDown);

  el('#addEvent').onclick = async () => {
    const form = document.createElement('div');
    const defaultStart = timeStr(now);
    const defaultEnd = timeStr(new Date(now.getTime()+3600000));
    form.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Время начала<input id="evStart" placeholder="HH:MM" value="${defaultStart}" /></label>
        <label>Время окончания<input id="evEnd" placeholder="HH:MM" value="${defaultEnd}" /></label>
      </div>
      <label>Название<input id="evTitle" placeholder="Встреча, консультация..." /></label>
      <label>Сотрудник
        <select id="evEmployee" required>
          <option value="">Выберите сотрудника</option>
          ${(employees||[]).map(e=>`<option value="${e.id}">${e.fullName} — ${e.position || 'Сотрудник'}</option>`).join('')}
        </select>
      </label>
      <label>Примечания<textarea id="evDesc" placeholder="Дополнительная информация" rows="2" style="resize:vertical"></textarea></label>`;
    const res = await showModal({ title: 'Создать слот', content: form, submitText: 'Создать' });
    if (!res) return;
    const { close, setError } = res;
    const start = form.querySelector('#evStart').value.trim();
    const end = form.querySelector('#evEnd').value.trim();
    const title = form.querySelector('#evTitle').value.trim();
    const description = form.querySelector('#evDesc').value.trim();
    const employeeId = form.querySelector('#evEmployee').value;
    if (!start || !end || !employeeId) { setError('Укажите время начала и конца и выберите сотрудника'); return; }
    try {
      const created = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ date, start, end, title, description, employeeId }) });
      events = [...events, created];
      events.sort((a,b)=> (a.startISO < b.startISO ? -1 : 1));
      renderEvents(events);
      close();
    } catch (e) { setError(e.message); }
  };

  el('#pickDate').addEventListener('change', async (e)=>{
    date = e.target.value;
    const fresh = await api('/api/schedule?date=' + date);
    events = fresh.items || [];
    renderEvents(events);
  });
}

// Password confirmation for root operations
async function confirmRootPassword(operation) {
  if (window.currentUser.role !== 'root') {
    throw new Error('Недостаточно прав');
  }
  
  const form = document.createElement('div');
  form.innerHTML = `
    <p style="margin-bottom: 16px; color: var(--muted);">
      Для выполнения операции "${operation}" введите ваш пароль:
    </p>
    <label>Пароль<input id="rootPassword" type="password" placeholder="Введите пароль" required /></label>
  `;
  
  const result = await showModal({
    title: 'Подтверждение root операции',
    content: form,
    submitText: 'Подтвердить'
  });
  
  if (!result) return false;
  
  const password = el('#rootPassword').value;
  if (!password) {
    result.setError('Пароль обязателен');
    return false;
  }
  
  try {
    // Verify password by attempting to login
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        login: window.currentUser.login,
        password: password
      })
    });
    result.close();
    return true;
  } catch (err) {
    result.setError('Неверный пароль');
    return false;
  }
}

async function deleteEmployeeWithPassword(employee) {
  if (!await confirmRootPassword(`удаление сотрудника "${employee.fullName}"`)) {
    return;
  }
  
  if (!confirm(`Вы уверены, что хотите удалить сотрудника "${employee.fullName}"?\n\nЭто действие:\n• Удалит аккаунт пользователя\n• Удалит все события в расписании\n• Необратимо`)) {
    return;
  }
  
  try {
    await api('/api/employees?id=' + encodeURIComponent(employee.id), { method: 'DELETE', body: JSON.stringify({ id: employee.id }) });
    renderEmployees(); // Refresh the list
  } catch (err) {
    alert('Ошибка удаления: ' + (err.message || 'Unknown error'));
  }
}

async function renderFileSystem() {
  if (!(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin'))) {
    el('#view').innerHTML = `<div class="card"><h3>Недостаточно прав</h3><p>Доступно только администраторам.</p></div>`;
    return;
  }
  
  const view = el('#view');
  
  // Fetch all models and files
  const [modelsRes, allFiles] = await Promise.all([
    api('/api/models'),
    getAllFiles()
  ]);
  
  const models = modelsRes.items || [];
  
  view.innerHTML = `
    <div class="file-system">
      <div class="fs-header">
        <h1>Файловая система</h1>
        <div class="fs-stats">
          <span>${allFiles.length} файлов</span>
          <span>${models.length} моделей</span>
          <span>${Math.round(allFiles.reduce((sum, f) => sum + (f.size || 0), 0) / 1024 / 1024)} МБ</span>
        </div>
      </div>
      
      <div class="fs-controls">
        <input id="fsSearch" placeholder="Поиск по файлам и моделям..." />
        <select id="fsSort">
          <option value="date-desc">По дате ↓</option>
          <option value="date-asc">По дате ↑</option>
          <option value="name-asc">По имени ↑</option>
          <option value="name-desc">По имени ↓</option>
          <option value="size-desc">По размеру ↓</option>
        </select>
        <select id="fsFilter">
          <option value="all">Все файлы</option>
          <option value="images">Изображения</option>
          <option value="videos">Видео</option>
          <option value="documents">Документы</option>
        </select>
      </div>
      
      <div class="fs-content">
        <div class="fs-sidebar">
          <h3>Модели</h3>
          <div class="model-list" id="modelList"></div>
        </div>
        <div class="fs-main">
          <div class="files-timeline" id="filesTimeline"></div>
        </div>
      </div>
    </div>
  `;
  
  let filteredFiles = [...allFiles];
  let selectedModelId = null;
  
  function renderModelList() {
    const modelCounts = {};
    allFiles.forEach(f => {
      modelCounts[f.modelId] = (modelCounts[f.modelId] || 0) + 1;
    });
    
    const modelListEl = el('#modelList');
    modelListEl.innerHTML = `
      <div class="model-item ${!selectedModelId ? 'active' : ''}" data-model="all">
        <div class="model-name">Все модели</div>
        <div class="file-count">${allFiles.length}</div>
      </div>
      ${models.map(m => `
        <div class="model-item ${selectedModelId === m.id ? 'active' : ''}" data-model="${m.id}">
          <div class="model-name">${m.name}</div>
          <div class="file-count">${modelCounts[m.id] || 0}</div>
        </div>
      `).join('')}
    `;
    
    // Model selection
    [...modelListEl.querySelectorAll('.model-item')].forEach(item => {
      item.onclick = () => {
        const modelId = item.dataset.model;
        selectedModelId = modelId === 'all' ? null : modelId;
        applyFilters();
        renderModelList();
      };
    });
  }
  
  function applyFilters() {
    const search = (el('#fsSearch').value || '').toLowerCase();
    const sort = el('#fsSort').value;
    const filter = el('#fsFilter').value;
    
    // Filter by model
    let files = selectedModelId ? allFiles.filter(f => f.modelId === selectedModelId) : [...allFiles];
    
    // Filter by search
    if (search) {
      files = files.filter(f => {
        const model = models.find(m => m.id === f.modelId);
        return (f.name || '').toLowerCase().includes(search) ||
               (f.description || '').toLowerCase().includes(search) ||
               (model && model.name.toLowerCase().includes(search));
      });
    }
    
    // Filter by type
    if (filter !== 'all') {
      files = files.filter(f => {
        const ct = (f.contentType || '').toLowerCase();
        if (filter === 'images') return ct.startsWith('image/');
        if (filter === 'videos') return ct.startsWith('video/');
        if (filter === 'documents') return ct.includes('pdf') || ct.includes('document') || ct.includes('text');
        return true;
      });
    }
    
    // Sort
    files.sort((a, b) => {
      if (sort === 'date-desc') return (b.createdAt || 0) - (a.createdAt || 0);
      if (sort === 'date-asc') return (a.createdAt || 0) - (b.createdAt || 0);
      if (sort === 'name-desc') return (b.name || '').localeCompare(a.name || '');
      if (sort === 'name-asc') return (a.name || '').localeCompare(b.name || '');
      if (sort === 'size-desc') return (b.size || 0) - (a.size || 0);
      return 0;
    });
    
    filteredFiles = files;
    renderTimeline();
  }
  
  function renderTimeline() {
    const timelineEl = el('#filesTimeline');
    
    if (filteredFiles.length === 0) {
      timelineEl.innerHTML = '<div class="no-files">Файлы не найдены</div>';
      return;
    }
    
    // Group by date
    const groups = {};
    filteredFiles.forEach(f => {
      const date = f.createdAt ? new Date(f.createdAt).toLocaleDateString('ru') : 'Неизвестная дата';
      if (!groups[date]) groups[date] = [];
      groups[date].push(f);
    });
    
    timelineEl.innerHTML = Object.entries(groups).map(([date, files]) => `
      <div class="timeline-group">
        <h3 class="timeline-date">${date}</h3>
        <div class="timeline-files">
          ${files.map(f => {
            const model = models.find(m => m.id === f.modelId);
            const isImage = (f.contentType || '').startsWith('image/');
            const isVideo = (f.contentType || '').startsWith('video/');
            const viewUrl = `/api/files?id=${f.id}`;
            const downloadUrl = viewUrl + '&download=1';
            const canDownload = window.currentUser && window.currentUser.role === 'root';
            const fileSize = f.size ? (f.size / 1024 / 1024).toFixed(1) + ' МБ' : '';
            
            return `
              <div class="timeline-file">
                <div class="file-preview">
                  ${isImage ? `<img src="${viewUrl}" alt="${f.name}" />` : 
                    isVideo ? `<div class="file-icon">📹</div>` : 
                    `<div class="file-icon">📄</div>`}
                </div>
                <div class="file-details">
                  <div class="file-header">
                    <div class="file-name">${f.name}</div>
                    <div class="file-model">${model ? model.name : 'Неизвестная модель'}</div>
                  </div>
                  ${f.description ? `<div class="file-desc">${f.description}</div>` : ''}
                  <div class="file-meta">
                    ${fileSize ? `<span>${fileSize}</span>` : ''}
                    <span>${new Date(f.createdAt).toLocaleTimeString('ru', {hour: '2-digit', minute: '2-digit'})}</span>
                  </div>
                  <div class="file-actions">
                    <a href="${viewUrl}" target="_blank" class="file-btn">Просмотр</a>
                    ${canDownload ? `<a href="${downloadUrl}" class="file-btn">Скачать</a>` : ''}
                    <button class="file-btn" onclick="renderModelCard('${f.modelId}')">К модели</button>
                    ${(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin')) ? 
                      `<button class="file-btn delete-file-fs" data-id="${f.id}" style="background: #dc2626;">Удалить</button>` : ''}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `).join('');
    
    // File deletion in file system
    [...timelineEl.querySelectorAll('.delete-file-fs')].forEach(btn => {
      btn.onclick = async () => {
        const fileId = btn.dataset.id;
        const file = filteredFiles.find(f => f.id === fileId);
        
        if (window.currentUser.role === 'root') {
          if (!await confirmRootPassword(`удаление файла "${file.name}"`)) return;
        }
        
        if (!confirm(`Удалить файл "${file.name}"?`)) return;
        try {
          await api('/api/files?id=' + encodeURIComponent(fileId), { method: 'DELETE' });
          // Remove from all arrays
          const index = allFiles.findIndex(f => f.id === fileId);
          if (index >= 0) allFiles.splice(index, 1);
          applyFilters();
          renderModelList();
        } catch (err) {
          alert(err.message);
        }
      };
    });
  }
  
  // Event listeners
  el('#fsSearch').addEventListener('input', applyFilters);
  el('#fsSort').addEventListener('change', applyFilters);
  el('#fsFilter').addEventListener('change', applyFilters);
  
  // Initial render
  renderModelList();
  applyFilters();
}

async function getAllFiles() {
  const modelsRes = await api('/api/models');
  const models = modelsRes.items || [];
  
  const allFiles = [];
  await Promise.all(models.map(async (model) => {
    try {
      const filesRes = await api('/api/files?modelId=' + encodeURIComponent(model.id));
      const files = (filesRes.items || []).map(f => ({ ...f, modelId: model.id }));
      allFiles.push(...files);
    } catch (e) {
      console.warn('Failed to fetch files for model', model.id, e);
    }
  }));
  
  return allFiles;
}

async function renderApp() {
  const me = await fetchMe();
  if (!me) return renderLogin();
  window.currentUser = me;
  renderAppShell(me);
  if (me.role === 'root' || me.role === 'admin') {
    renderModels();
  } else if (me.role === 'interviewer') {
    renderCalendar();
  } else {
    el('#view').innerHTML = `<div class="card"><h3>Добро пожаловать</h3><p>Нет доступных разделов для вашей роли.</p></div>`;
  }
}

renderApp();
