const api = async (path, opts = {}) => {
  const isFD = (opts && opts.body && typeof FormData !== 'undefined' && opts.body instanceof FormData);
  const headers = isFD ? (opts.headers || {}) : { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // Prevent 304 / cached JSON — always fetch fresh data
  const reqInit = {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache', ...headers },
    ...opts,
  };
  // Add cache-busting param for GET requests
  try {
    const method = (reqInit.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const url = new URL(path, location.origin);
      url.searchParams.set('__ts', String(Date.now()));
      path = url.toString();
    }
  } catch {}
  const res = await fetch(path, reqInit);
  if (!res.ok) throw new Error(await res.text());
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
};

const el = (sel) => document.querySelector(sel);

// Theme management
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  return savedTheme;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  return newTheme;
}

// Format date as YYYY-MM-DD in LOCAL timezone (avoid toISOString UTC shift)
function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
  const today = ymdLocal(new Date());
  let date = today;
  let currentMonth = today.slice(0,7); // YYYY-MM
  let slots = [];
  let monthDays = [];
  // Snackbar state for undo
  let _snackbar = null;
  let _snackbarTimer = null;

  const monthLabelInit = (() => {
    const [yy, mm] = currentMonth.split('-').map(n=>parseInt(n,10));
    const d = new Date(yy, mm-1, 1);
    const lbl = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    return lbl.charAt(0).toUpperCase() + lbl.slice(1);
  })();

  view.innerHTML = `
    <div class="schedule-container">
      <div class="schedule-header">
        <h1>Календарь</h1>
        <div class="current-date" id="currentDateDisplay">${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
      </div>
      
      <div class="schedule-main-content">
        <div class="schedule-left-panel">
          <div class="schedule-calendar-container">
            <div class="schedule-calendar">
              <div class="schedule-calendar-header">
                <div class="month-title" id="monthTitleWrap">
                  <h2 id="monthTitle" class="month-title-text">${monthLabelInit}</h2>
                  <button id="monthTitleBtn" class="icon-btn" aria-label="Изменить месяц"><span class="material-symbols-rounded">expand_more</span></button>
                </div>
                <select id="monthSelect" class="visually-hidden" aria-label="Выбор месяца">
                  <option value="${currentMonth}">${monthLabelInit}</option>
                </select>
              </div>
              
              <div class="schedule-calendar-weekdays">
                <div class="schedule-calendar-weekday">Пн</div>
                <div class="schedule-calendar-weekday">Вт</div>
                <div class="schedule-calendar-weekday">Ср</div>
                <div class="schedule-calendar-weekday">Чт</div>
                <div class="schedule-calendar-weekday">Пт</div>
                <div class="schedule-calendar-weekday">Сб</div>
                <div class="schedule-calendar-weekday">Вс</div>
              </div>
              <div id="monthGrid"></div>
              
              ${(window.currentUser && ['root','admin'].includes(window.currentUser.role)) ? '<button id="addSlot" class="schedule-create-slot-btn">Создать слот</button>' : ''}
            </div>
          </div>
          
          <div class="schedule-color-legend">
            <h3>Обозначение цветов</h3>
            <div class="schedule-legend-items">
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-not-confirmed"></div>
                <span>Не подтвердилась/Не пришла/Пришла</span>
              </div>
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-confirmed"></div>
                <span>Подтвердилась</span>
              </div>
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-drain"></div>
                <span>Слив</span>
              </div>
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-registration"></div>
                <span>Регистрация</span>
              </div>
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-candidate-refusal"></div>
                <span>Отказ со стороны кандидата</span>
              </div>
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-our-refusal"></div>
                <span>Отказ с нашей стороны</span>
              </div>
              <div class="schedule-legend-item">
                <div class="schedule-legend-color status-thinking"></div>
                <span>Ушла на подумать</span>
              </div>
            </div>
          </div>
        </div>
        
        <div class="schedule-slots-container">
          <div class="schedule-slots-header">
            <h2 id="selectedDate">${today}</h2>
          </div>
          
          <div class="schedule-slots-grid" id="scheduleTable"></div>
        </div>
      </div>
    </div>`;
  // After rendering, set initial selected date label like on day click
  const selectedDateElInit = el('#selectedDate');
  if (selectedDateElInit) {
    selectedDateElInit.textContent = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  // Kick off initial data load
  loadMonth();
  load();

  // Wire up month title click to open native select
  const monthTitleBtn = el('#monthTitleBtn');
  const monthSelectEl = el('#monthSelect');
  if (monthTitleBtn && monthSelectEl) {
    monthTitleBtn.onclick = () => monthSelectEl.showPicker ? monthSelectEl.showPicker() : monthSelectEl.focus();
  }
  
  // Wire up create slot button
  const addSlotBtn = el('#addSlot');
  if (addSlotBtn) {
    addSlotBtn.onclick = createSlot;
  }
  
  // Slot click handling is delegated per-render inside renderList() to avoid duplicate bindings

  async function load() {
    const res = await api('/api/schedule?date=' + encodeURIComponent(date));
    slots = res.items || [];
    renderList();
  }

  // Simple snackbar with Undo
  function showUndoSnackbar({ message, actionText = 'Отменить', timeoutMs = 12000, onAction }) {
    // cleanup previous
    if (_snackbarTimer) { clearTimeout(_snackbarTimer); _snackbarTimer = null; }
    if (_snackbar) { _snackbar.remove(); _snackbar = null; }
    const bar = document.createElement('div');
    bar.className = 'snackbar';
    bar.style.position = 'fixed';
    bar.style.left = '50%';
    bar.style.bottom = '20px';
    bar.style.transform = 'translateX(-50%)';
    bar.style.background = 'var(--panel-glass)';
    bar.style.border = '1px solid var(--border)';
    bar.style.padding = '10px 12px';
    bar.style.borderRadius = '8px';
    bar.style.boxShadow = '0 6px 20px rgba(0,0,0,0.4)';
    bar.style.display = 'flex';
    bar.style.gap = '12px';
    bar.style.alignItems = 'center';
    bar.style.zIndex = '9999';
    const txt = document.createElement('div');
    txt.textContent = message;
    const btn = document.createElement('button');
    btn.textContent = actionText;
    btn.className = 'ghost';
    btn.style.border = '1px solid var(--accent)';
    btn.style.color = 'var(--accent)';
    btn.onclick = () => {
      if (_snackbarTimer) { clearTimeout(_snackbarTimer); _snackbarTimer = null; }
      if (_snackbar) { _snackbar.remove(); _snackbar = null; }
      if (typeof onAction === 'function') onAction();
    };
    bar.append(txt, btn);
    document.body.appendChild(bar);
    _snackbar = bar;
    _snackbarTimer = setTimeout(() => {
      if (_snackbar) { _snackbar.remove(); _snackbar = null; }
      _snackbarTimer = null;
    }, timeoutMs);
  }

  // Removed global document-level fallback to prevent double triggering
  async function loadMonth() {
    try {
      console.debug('[calendar] loadMonth start', { currentMonth });
      const res = await api('/api/schedule?month=' + encodeURIComponent(currentMonth));
      monthDays = res.days || [];
    } catch (e) {
      console.warn('loadMonth failed', e);
      monthDays = [];
    }
    console.debug('[calendar] loadMonth done render', { currentMonth, days: monthDays.length });
    renderMonth();
  }

  function renderList() {
    const table = el('#scheduleTable');
    if (!table) return;
    
    // Generate time slots 12:00 - 18:00, step 30min
    const timeSlots = [];
    for (let h = 12; h <= 18; h++) {
      for (let m = 0; m < 60; m += 30) {
        if (h === 18 && m > 0) break; // stop at 18:00
        const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        timeSlots.push(t);
      }
    }
    
    // Group slots by time
    const byTime = new Map();
    (slots || []).forEach(s => {
      const t = (s.start || '').slice(0,5);
      if (!t) return;
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t).push(s);
    });
    
    // Helper to get status class based on slot statuses (status1/3/4)
    const getStatusClass = (slot) => {
      const s1 = slot?.status1;
      const s3 = slot?.status3;
      const s4 = slot?.status4;
      // Priority: fail/confirmed (status1), then registration (status4), then status3 values
      if (s1 === 'fail') return 'status-drain';
      if (s1 === 'confirmed') return 'status-confirmed';
      if (s4 === 'registration') return 'status-registration';
      if (s3 === 'reject_candidate') return 'status-candidate-refusal';
      if (s3 === 'reject_us') return 'status-our-refusal';
      if (s3 === 'thinking') return 'status-thinking';
      return 'status-not-confirmed';
    };
    
    // Render slot events
    const renderSlotEvents = (slotsAtTime) => {
      const real = Array.isArray(slotsAtTime) ? slotsAtTime : [];
      const parts = [];
      if (real.length === 0) {
        // show two placeholders (capacity is 2 per time)
        parts.push('<div class="schedule-event schedule-event-empty">Свободно</div>');
        parts.push('<div class="schedule-event schedule-event-empty">Свободно</div>');
        return parts.join('');
      }

      parts.push(...real.map(slot => {
        const statusClass = getStatusClass(slot);
        const phone = slot.phone || slot.contacts?.phone || '';
        return `
          <div class="schedule-event ${statusClass}" data-id="${slot.id}">
            ${slot.title || 'Без названия'}
            ${phone ? `<span class="schedule-phone-number">${phone}</span>` : ''}
          </div>
        `;
      }));

      // If we have less than 2 real slots at this time, show placeholders for remaining capacity
      const capacity = 2;
      for (let i = real.length; i < capacity; i++) {
        parts.push('<div class="schedule-event schedule-event-empty">Свободно</div>');
      }
      return parts.join('');
    };
    
    table.innerHTML = timeSlots.map(time => {
      const slotsAtTime = byTime.get(time) || [];
      return `
        <div class="schedule-slot">
          <div class="schedule-slot-time">${time}</div>
          <div class="schedule-slot-events">
            ${renderSlotEvents(slotsAtTime)}
          </div>
        </div>
      `;
    }).join('');
    
    // Delegate clicks to open a slot (rebound each render to keep fresh closures)
    table.onclick = (e) => {
      const target = e.target && e.target.closest && e.target.closest('.schedule-event[data-id]');
      if (!target) return;
      const slotId = target.dataset.id;
      if (slotId) openSlot(slotId);
    };
  }

  // Month grid with slot previews
  function renderMonth() {
    const grid = el('#monthGrid');
    const [y, m] = currentMonth.split('-').map(x=>parseInt(x,10));
    const d0 = new Date(y, m-1, 1);
    const monthName = d0.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
    
    // Update month select and populate with nearby months
    const monthSelect = el('#monthSelect');
    if (monthSelect) {
      const options = [];
      for (let i = -6; i <= 6; i++) {
        const optionDate = new Date(y, m - 1 + i, 1);
        const optionValue = `${optionDate.getFullYear()}-${String(optionDate.getMonth() + 1).padStart(2, '0')}`;
        const optionLabel = optionDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
        const selected = optionValue === currentMonth ? ' selected' : '';
        options.push(`<option value="${optionValue}"${selected}>${optionLabel.charAt(0).toUpperCase() + optionLabel.slice(1)}</option>`);
      }
      monthSelect.innerHTML = options.join('');
      
      // Wire up month select change
      monthSelect.onchange = () => {
        currentMonth = monthSelect.value;
        loadMonth();
      };
    }
    // Update visual month title like mockup
    const titleEl = el('#monthTitle');
    if (titleEl) {
      const lbl = d0.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
      titleEl.textContent = lbl.charAt(0).toUpperCase() + lbl.slice(1);
    }
    
    const startDow = (d0.getDay()+6)%7; // Mon=0
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = [];
    
    // Add previous month days
    const prevMonth = new Date(y, m-2, 0);
    const prevMonthDays = prevMonth.getDate();
    for (let i = startDow - 1; i >= 0; i--) {
      cells.push({ day: prevMonthDays - i, isOtherMonth: true });
    }
    
    // Add current month days
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({ day, isOtherMonth: false, date: new Date(y, m-1, day) });
    }
    
    // Add next month days to fill grid
    let nextDay = 1;
    while (cells.length < 42) { // 6 weeks * 7 days
      cells.push({ day: nextDay++, isOtherMonth: true });
    }

    const byDate = new Map((monthDays||[]).map(d => [d.date, d]));
    const todayStr = ymdLocal(new Date());

    grid.innerHTML = cells.map(cell => {
      if (cell.isOtherMonth) {
        return `<div class="schedule-calendar-day other-month">${cell.day}</div>`;
      }
      
      const dstr = ymdLocal(cell.date);
      const info = byDate.get(dstr);
      const isToday = dstr === todayStr;
      const isSelected = dstr === date;
      return `
        <div class="schedule-calendar-day ${isSelected ? 'selected' : ''}" data-date="${dstr}">
          ${cell.day}
        </div>`;
    }).join('');

    // Wire up calendar day clicks
    [...grid.querySelectorAll('.schedule-calendar-day[data-date]')].forEach(dayEl => {
      dayEl.onclick = async () => {
        date = dayEl.dataset.date;
        const selectedDateEl = el('#selectedDate');
        if (selectedDateEl) {
          selectedDateEl.textContent = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            year: 'numeric'
          });
        }
        await load();
        renderMonth();
      };
    });
  }

  async function createSlot() {
    const form = document.createElement('div');
    // Build time options 12:00 .. 18:30, step 30m; gray out (disable) if >=2 slots already at that start time for the selected date
    const counts = new Map();
    (slots || []).forEach(s => {
      const k = (s.start || '').slice(0,5);
      if (!k) return;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const times = [];
    for (let h = 12; h <= 18; h++) {
      for (let m = 0; m < 60; m += 30) {
        const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        times.push(t);
      }
    }
    // Also include 18:30 explicitly when h loop ends at 18 with m=30 already included above
    // Determine default time = first available (count < 2) or 12:00
    const firstFree = times.find(t => (counts.get(t) || 0) < 2) || times[0];
    form.innerHTML = `
      <label>ФИО<input id="sFullName" placeholder="Иванов Иван" required /></label>
      <label>Номер телефона<input id="sPhone" placeholder="+7 999 123-45-67" required /></label>
      <label>Время
        <select id="sTime" required>
          ${times.map(t => {
            const c = counts.get(t) || 0;
            const full = c >= 2;
            const attrs = `${t === firstFree ? ' selected' : ''}${full ? ' disabled' : ''}`;
            const style = full ? ' style="color:#888"' : '';
            const label = full ? `${t} (занято)` : t;
            return `<option value="${t}"${attrs}${style}>${label}</option>`;
          }).join('')}
        </select>
      </label>
      <label>Комментарий<textarea id="sComment" rows="3" placeholder="Дополнительно (необязательно)"></textarea></label>`;

    // Custom modal (like editSlot) so Save can be clicked repeatedly after validation errors
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const header = document.createElement('header');
    header.innerHTML = `<h3>Создать слот</h3>`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ghost';
    cancelBtn.textContent = 'Отмена';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'Создать';
    actions.append(cancelBtn, okBtn);
    const err = document.createElement('div');
    err.style.color = 'var(--danger)'; err.style.fontSize = '12px'; err.style.minHeight = '16px'; err.style.marginTop = '4px';
    modal.append(header, form, err, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => { backdrop.remove(); };
    const setError = (m) => { err.textContent = m || ''; };

    cancelBtn.onclick = () => close();
    okBtn.onclick = async () => {
      setError('');
      const fullName = form.querySelector('#sFullName').value.trim();
      const phone = form.querySelector('#sPhone').value.trim();
      const selectedTime = (form.querySelector('#sTime').value || '').trim();
      const comment = form.querySelector('#sComment').value.trim();
      if (!fullName || !phone || !selectedTime) { setError('Заполните ФИО, телефон и время'); return; }
      // Use selected calendar date and selected time; end = +30 минут
      let dateStr = '', start = '', end = '';
      try {
        dateStr = date; // selected day in calendar
        start = selectedTime.slice(0,5);
        // compute end = start + 30 минут
        const [hh, mm] = start.split(':').map(n=>parseInt(n,10));
        const total = hh * 60 + mm + 30;
        const eh = Math.floor((total % (24 * 60)) / 60);
        const em = total % 60;
        end = `${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}`;
      } catch {
        setError('Неверный формат времени');
        return;
      }
      const title = fullName;
      const notes = `Телефон: ${phone}` + (comment ? `\nКомментарий: ${comment}` : '');
      try {
        const created = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ date: dateStr, start, end, title, notes }) });
        slots = [...slots, created].sort((a,b)=> (a.start||'').localeCompare(b.start||''));
        renderList();
        close();
      } catch (e) { setError(e.message); }
    };
  }

  async function editSlot(id) {
    const s = slots.find(x => x.id === id);
    if (!s) { console.debug('[editSlot] not found', { id }); return; }
    console.debug('[editSlot] start', { id, slot: s });
    const form = document.createElement('div');
    // Build time options like in createSlot()
    const counts = new Map();
    (slots || []).forEach(it => {
      const k = (it.start || '').slice(0,5);
      if (!k) return;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const times = [];
    for (let h = 12; h <= 18; h++) {
      for (let m = 0; m < 60; m += 30) {
        const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        times.push(t);
      }
    }
    const currStart = (s.start || '').slice(0,5);
    form.innerHTML = `
      <label>Время
        <select id="sTime" required>
          ${times.map(t => {
            const c = counts.get(t) || 0;
            const full = c >= 2 && t !== currStart; // allow keeping current even if overbooked
            const attrs = `${t === currStart ? ' selected' : ''}${full ? ' disabled' : ''}`;
            const style = full ? ' style="color:#888"' : '';
            const label = full ? `${t} (занято)` : t;
            return `<option value="${t}"${attrs}${style}>${label}</option>`;
          }).join('')}
        </select>
      </label>
      <label>Статус подтверждения
        <select id="sStatus1">
          <option value="confirmed" ${s.status1 === 'confirmed' ? 'selected' : ''}>Подтвердилось</option>
          <option value="not_confirmed" ${!s.status1 || s.status1 === 'not_confirmed' ? 'selected' : ''}>Не подтвердилось</option>
          <option value="fail" ${s.status1 === 'fail' ? 'selected' : ''}>Слив</option>
        </select>
      </label>
      <label>ФИО<input id="sTitle" value="${s.title || ''}" placeholder="Иванов Иван" /></label>
      <label>Комментарий<textarea id="sNotes" rows="3" placeholder="Дополнительно (необязательно)">${s.notes || ''}</textarea></label>
      <div id="timeCommentWrap" style="display:none"><label>Комментарий к изменению времени<textarea id="sComment" rows="2" placeholder="Почему изменили время слота"></textarea></label></div>`;
    // Show comment field only when time changed
    const timeSel = form.querySelector('#sTime');
    const wrap = form.querySelector('#timeCommentWrap');
    const toggleWrap = () => {
      const timeChanged = (timeSel.value || '').slice(0,5) !== currStart;
      wrap.style.display = timeChanged ? 'block' : 'none';
    };
    timeSel.onchange = toggleWrap;
    toggleWrap();

    // Custom modal handling for edit slot
    const modalPromise = new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'modal';
      const header = document.createElement('header');
      header.innerHTML = `<h3>Редактировать слот</h3>`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ghost';
      cancelBtn.textContent = 'Отмена';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'Сохранить';
      actions.append(cancelBtn, okBtn);
      const err = document.createElement('div');
      err.style.color = 'var(--danger)'; err.style.fontSize = '12px'; err.style.minHeight = '16px'; err.style.marginTop = '4px';
      modal.append(header, form, err, actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      
      const close = () => { backdrop.remove(); resolve(null); };
      const setError = (m) => err.textContent = m;
      
      cancelBtn.onclick = () => close();
      okBtn.onclick = async () => {
        setError('');
        const start = (timeSel.value || '').slice(0,5);
        // compute end = start + 30 minutes
        const [hh, mm] = start.split(':').map(n=>parseInt(n,10));
        const total = hh * 60 + mm + 30;
        const eh = Math.floor((total % (24 * 60)) / 60);
        const em = total % 60;
        const end = `${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}`;
        const title = (box.querySelector('#regName').value || '').trim();
        const phone = (box.querySelector('#regPhone').value || '').trim();
        const notesBase = form.querySelector('#sNotes') ? form.querySelector('#sNotes').value.trim() : '';
        const notes = phone ? `Телефон: ${phone}${notesBase?`\n${notesBase}`:''}` : notesBase;
        const status1 = (box.querySelector('#regS1').value || 'not_confirmed');
        const status2 = (box.querySelector('#regS2').value || '');
        const status4 = (box.querySelector('#regS4').value || '');
        const timeChanged = (start !== currStart);
        const comment = timeChanged ? ((form.querySelector('#sComment') && form.querySelector('#sComment').value) || '').trim() : '';
        console.log('[editSlot] Save slot:', { status1, status2, status4, title, notes, timeChanged, comment });
        if (timeChanged && !comment) { setError('Требуется комментарий для изменения времени'); return; }
        if (!title) { setError('Заполните ФИО'); return; }
        try {
          const payload = { id: s.id, date: (s.date || date), start, end, title, notes, comment, status1, status2: status2 || undefined, status4: status4 || undefined };
          console.log('[editSlot] API payload:', payload);
          const updated = await api('/api/schedule', { method: 'PUT', body: JSON.stringify(payload) });
          console.log('[editSlot] API response:', updated);
          slots = slots.map(x => x.id === s.id ? updated : x).sort((a,b)=> (a.start||'').localeCompare(b.start||''));
          renderList();
          close();
        } catch (e) { setError(e.message); }
      };
    });
    
    await modalPromise;

    // Wire registration action inside the already open modal lifecycle
    const doRegisterBtn = box.querySelector('#doRegister');
    if (doRegisterBtn) {
      doRegisterBtn.onclick = async () => {
        // no-op: currently not used (we place registration under StartReg flow below)
      };
    }

    // Attach handler to perform registration when regSection visible and user clicks a special footer button we add below
    const regSection = box.querySelector('#regSection');
    if (regSection) {
      // Ensure footer exists; button will reveal section on first click
      const tryAddFooter = () => {
        if (!regSection || regSection.dataset.footer) return;
        const footer = document.createElement('div');
        footer.style.display = 'flex';
        footer.style.gap = '8px';
        footer.style.marginTop = '8px';
        const regBtn = document.createElement('button');
        regBtn.textContent = 'Зарегистрировать';
        regBtn.className = 'primary';
        footer.appendChild(regBtn);
        regSection.appendChild(footer);
        regSection.dataset.footer = '1';
        regBtn.onclick = async () => {
          // Phase 1: first click reveals the registration fields
          if (regSection && (regSection.style.display === 'none' || !regSection.dataset.shown)) {
            regSection.style.display = 'block';
            regSection.dataset.shown = '1';
            regBtn.textContent = 'Подтвердить регистрацию';
            const first = box.querySelector('#regName') || box.querySelector('input,select,textarea');
            if (first && first.focus) first.focus();
            return;
          }
          const name = (box.querySelector('#regName').value || '').trim();
          const fullName = name;
          const phone = (box.querySelector('#regPhone').value || '').trim();
          const birthDate = (box.querySelector('#regBirth').value || '').trim();
          const docType = (box.querySelector('#regDocType').value || '').trim();
          const docNumber = (box.querySelector('#regDocNumber').value || '').trim();
          const internshipDate = (box.querySelector('#regIntern').value || '').trim();
          if (!birthDate || !docType || !docNumber) { alert('Заполните обязательные поля регистрации'); return; }
          try {
            // 1) Upload chosen files to slot (so backend will link them during registration)
            const photo = box.querySelector('#regPhoto').files?.[0];
            const audio = box.querySelector('#regAudio').files?.[0];
            if (photo || audio) {
              const fd = new FormData();
              fd.append('slotId', s.id);
              if (photo) fd.append('file', photo);
              if (audio) fd.append('file', audio);
              await api('/api/files', { method: 'POST', body: fd });
            }
            // 2) Register model from slot
            const payload = {
              action: 'registerFromSlot',
              date: s.date || date,
              slotId: s.id,
              name,
              fullName,
              phone,
              birthDate,
              docType,
              docNumber,
              internshipDate,
              comment: (s.interview && s.interview.text) || ''
            };
            const res = await api('/api/models', { method: 'POST', body: JSON.stringify(payload) });
            // 3) Refresh slots list to reflect link and statuses
            const rel = await api('/api/schedule?date=' + encodeURIComponent(s.date || date));
            slots = rel.items || [];
            renderList();
            // 4) Close modal
            const modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            alert('Модель зарегистрирована');
          } catch (e) {
            alert(e.message);
          }
        };
      };
      // Always add footer; button now reveals the section on first click
      tryAddFooter();
      // Also hook startRegBtn to add footer after show
      const startBtn = box.querySelector('#startRegBtn');
      if (startBtn) startBtn.addEventListener('click', tryAddFooter, { once: true });
    }
  }

  async function deleteSlot(id) {
    const s = slots.find(x => x.id === id);
    if (!s) return;
    const btn = document.querySelector(`.delete-slot[data-id="${id}"]`);
    if (btn && btn.disabled) return; // already in progress
    if (!(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin'))) {
      alert('Недостаточно прав для удаления');
      return;
    }
    try {
      if (btn) btn.disabled = true;
      // Use slot's own date to avoid mismatch if selected date changed
      await api(`/api/schedule?id=${encodeURIComponent(s.id)}&date=${encodeURIComponent(s.date || date)}`, { method: 'DELETE' });
      slots = slots.filter(x => x.id !== s.id);
      renderList();
      // Offer undo
      const backup = { date: s.date || date, start: s.start, end: s.end, title: s.title, notes: s.notes };
      showUndoSnackbar({
        message: 'Слот удалён',
        actionText: 'Отменить',
        timeoutMs: 12000,
        onAction: async () => {
          try {
            const restored = await api('/api/schedule', { method: 'POST', body: JSON.stringify(backup) });
            slots = [...slots, restored].sort((a,b)=> (a.start||'').localeCompare(b.start||''));
            renderList();
          } catch (e) {
            alert('Не удалось восстановить слот: ' + e.message);
          }
        }
      });
    } catch (e) {
      console.warn('[deleteSlot] error', e);
      alert(e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openSlot(id) {
    const s = slots.find(x => x.id === id);
    if (!s) return;
    const box = document.createElement('div');
    const phoneInit = s.phone || s.contacts?.phone || '';
    const s1 = s.status1 || 'not_confirmed';
    const s2 = s.status2 || '';
    const s4 = s.status4 || '';
    box.innerHTML = `
      <div style="display:grid;gap:12px">
        <div><strong>${s.start || ''}–${s.end || ''}</strong></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Псевдоним/Никнейм<input id="regNick" placeholder="Ник" value="${(s.nickname||'').replace(/"/g,'&quot;')}" /></label>
          <label>ФИО<input id="regName" placeholder="Иванов Иван Иванович" value="${(s.title||'').replace(/"/g,'&quot;')}" /></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Телефон<input id="regPhone" placeholder="+7 (999) 123-45-67" value="${phoneInit}" /></label>
          <label>Дата рождения<input id="regBirthDate" type="date" value="${(s.dataBlock && Array.isArray(s.dataBlock.model_data) ? (s.dataBlock.model_data.find(x=>x.field==='birthDate')?.value||'') : '')}" /></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Тип документа
            <select id="regDocType">
              <option value="">Не указан</option>
              <option value="passport">Паспорт РФ</option>
              <option value="driver">Водительские права</option>
              <option value="foreign">Загранпаспорт</option>
            </select>
          </label>
          <label>Серия и номер / Номер<input id="regDocNumber" value="${(s.dataBlock && Array.isArray(s.dataBlock.model_data) ? (s.dataBlock.model_data.find(x=>x.field==='docNumber')?.value||'') : '')}" /></label>
        </div>
        
        <label>Статус слота
          <select id="regS1">
            <option value="confirmed" ${s1==='confirmed'?'selected':''}>Подтвержден</option>
            <option value="not_confirmed" ${!s1 || s1==='not_confirmed'?'selected':''}>Не подтвержден</option>
            <option value="fail" ${s1==='fail'?'selected':''}>Слив</option>
          </select>
        </label>
        <label>Статус прихода
          <select id="regS2">
            <option value="" ${!s2?'selected':''}>—</option>
            <option value="arrived" ${s2==='arrived'?'selected':''}>Пришла</option>
            <option value="no_show" ${s2==='no_show'?'selected':''}>Не пришла</option>
            <option value="other" ${s2==='other'?'selected':''}>Другое</option>
          </select>
        </label>
        <label>Статус собеседования
          <select id="regS4">
            <option value="" ${!s4?'selected':''}>—</option>
            <option value="registration" ${s4==='registration'?'selected':''}>Регистрация</option>
          </select>
        </label>

        <div style="display:flex;align-items:center;gap:8px">
          <button id="registerBtn" type="button" class="success" style="display:none">Зарегистрировать</button>
          <span id="startHint" style="font-size:12px;color:#9aa">Кнопка появится при: Подтвержден · Пришла</span>
        </div>

        

        <label>Заметки интервью<textarea id="iText" rows="4" placeholder="Текст интервью">${(s.interview && s.interview.text) || ''}</textarea></label>
        <div>
          <h4>Вложения</h4>
          <div id="attList" style="display:grid;gap:8px"></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="upFile" type="file" accept="image/*,audio/*,video/*,.pdf,.txt,.csv" multiple />
            <input id="upName" placeholder="Название файла (для одиночной загрузки)" />
            <button id="uploadBtn" type="button">Загрузить</button>
          </div>
        </div>
        ${(window.currentUser && (window.currentUser.role==='root' || window.currentUser.role==='admin')) ? `
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button id="deleteSlotBtn" type="button" style="background:#dc2626;color:#fff">Удалить слот</button>
        </div>` : ''}
      </div>`;
    const modalPromise = showModal({ title: 'Слот', content: box, submitText: 'Сохранить' });

    // Removed legacy Start Registration UI; registration happens via Data Block only

    // Delete slot inside modal (root/admin)
    const delBtn = box.querySelector('#deleteSlotBtn');
    if (delBtn) {
      delBtn.onclick = async () => {
        try {
          if (window.currentUser.role === 'root') {
            if (!await confirmRootPassword('удаление слота')) return;
          }
          if (!confirm('Удалить слот?')) return;
          await api('/api/schedule?id=' + encodeURIComponent(s.id) + '&date=' + encodeURIComponent(s.date || ''), { method: 'DELETE' });
          slots = slots.filter(x => x.id !== s.id);
          renderList();
          const modal = document.querySelector('.modal-backdrop');
          if (modal) modal.remove();
        } catch (e) {
          alert(e.message);
        }
      };
    }

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
          const isVideo = ct.startsWith('video/');
          return `
            <div class="file-card" style="display:flex;gap:12px;align-items:center">
              <div style="width:64px;height:48px;display:flex;align-items:center;justify-content:center;background:var(--panel);border:1px solid var(--border)">
                ${isImg ? `<img src="${f.url}" style="max-width:100%;max-height:100%;object-fit:contain"/>` : (isAudio ? '🎵' : (isVideo ? '🎞' : '📄'))}
              </div>
              <div style="flex:1">
                <div>${f.name}</div>
                ${isAudio ? `<audio src="${f.url}" controls style="width:100%"></audio>` : ''}
                ${isVideo ? `<video src="${f.url}" controls style="width:100%"></video>` : ''}
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

    // Toggle Start Registration button visibility based on statuses
    function updateStartVisibility() {
      const v1 = (box.querySelector('#regS1')?.value || '');
      const v2 = (box.querySelector('#regS2')?.value || '');
      const canStart = (v1 === 'confirmed' && v2 === 'arrived');
      const btn = box.querySelector('#registerBtn');
      const hint = box.querySelector('#startHint');
      if (btn) {
        btn.style.display = canStart ? 'inline-flex' : 'none';
        btn.disabled = !canStart;
      }
      if (hint) hint.style.display = canStart ? 'none' : 'inline';
    }
    ['#regS1','#regS2','#regS4'].forEach(sel => {
      const elx = box.querySelector(sel);
      if (elx) elx.onchange = updateStartVisibility;
    });
    updateStartVisibility();

    // Preselect doc type from dataBlock if exists
    const prevDocType = (s.dataBlock && Array.isArray(s.dataBlock.model_data)) ? (s.dataBlock.model_data.find(x=>x.field==='docType')?.value||'') : '';
    const docSel = box.querySelector('#regDocType');
    if (docSel && prevDocType) docSel.value = prevDocType;

    const regBtn = box.querySelector('#registerBtn');
    if (regBtn) regBtn.onclick = async () => {
      // Final guard: do not allow registration if statuses are not eligible
      const v1 = (box.querySelector('#regS1')?.value || '');
      const v2 = (box.querySelector('#regS2')?.value || '');
      if (!(v1 === 'confirmed' && v2 === 'arrived')) {
        updateStartVisibility();
        return;
      }
      try {
        // Save latest slot state first (title/phone/statuses/interview/data_block)
        const titleVal = (box.querySelector('#regName')?.value || s.title || '').trim();
        const nickVal = (box.querySelector('#regNick')?.value || '').trim();
        const phoneVal = (box.querySelector('#regPhone')?.value || s.phone || s.contacts?.phone || '').trim();
        const birthDateVal = (box.querySelector('#regBirthDate')?.value || '').trim();
        const docTypeVal = (box.querySelector('#regDocType')?.value || '').trim();
        const docNumberVal = (box.querySelector('#regDocNumber')?.value || '').trim();
        const s1v = (box.querySelector('#regS1')?.value || 'not_confirmed');
        const s2v = (box.querySelector('#regS2')?.value || '');
        const textVal = (box.querySelector('#iText')?.value || '').trim();
        const savePayload = {
          id: s.id,
          date: (s.date || date),
          title: titleVal,
          interviewText: textVal,
          status1: s1v,
          status2: s2v || undefined,
          dataBlock: {
            model_data: [
              { field: 'fullName', value: titleVal },
              ...(nickVal ? [{ field: 'name', value: nickVal }] : []),
              { field: 'phone', value: phoneVal },
              ...(birthDateVal ? [{ field: 'birthDate', value: birthDateVal }] : []),
              ...(docTypeVal ? [{ field: 'docType', value: docTypeVal }] : []),
              ...(docNumberVal ? [{ field: 'docNumber', value: docNumberVal }] : [])
            ]
          }
        };
        // Attempt to save slot, but do not block registration if forbidden (e.g., interviewer limited perms)
        try { await api('/api/schedule', { method: 'PUT', body: JSON.stringify(savePayload) }); }
        catch (err) {
          console.warn('Slot save before registration failed, continuing with registration:', err?.message || err);
        }

        // Register model from slot (backend will set status4=registration and merge data_block)
        const modelPayload = {
          action: 'registerFromSlot',
          date: (s.date || date),
          slotId: s.id,
          name: (nickVal || titleVal || s.title || 'Кандидат'),
          fullName: titleVal || undefined,
          phone: phoneVal || undefined,
          status1: s1v,
          status2: s2v || undefined
        };
        const model = await api('/api/models', { method: 'POST', body: JSON.stringify(modelPayload) });
        const backdrop = box.closest('.modal-backdrop'); if (backdrop) backdrop.remove();
        await renderModels();
        if (model && model.id && typeof window.renderModelCard === 'function') window.renderModelCard(model.id);
      } catch (e) { alert(e.message || 'Не удалось выполнить регистрацию'); }
    };

    // initial
    refreshFiles();
    // render history if exists (slot history + data_block.edit_history)
    const historyEl = box.querySelector('#slotHistory');
    if (historyEl) {
      const rows = [];
      if (Array.isArray(s.history)) {
        const actionLabel = (a) => a === 'create' ? 'создание' : a === 'time_change' ? 'смена времени' : 'изменение';
        rows.push(...s.history
          .sort((a,b)=> (a.ts||0)-(b.ts||0))
          .map(h => `<li style="font-size:12px;color:#aaa">${new Date(h.ts||Date.now()).toLocaleString('ru-RU')} · ${actionLabel(h.action)}${h.comment ? ` — ${h.comment}` : ''}</li>`));
      }
      const dbh = s.data_block && Array.isArray(s.data_block.edit_history) ? s.data_block.edit_history : [];
      rows.push(...dbh.map(ev => `<li style="font-size:12px;color:#aaa">${(ev.edited_at ? new Date(ev.edited_at).toLocaleString('ru-RU') : '')} · поле «${ev.changes?.field}»: ${ev.changes?.old_value ?? '—'} → ${ev.changes?.new_value ?? '—'} (uid ${ev.user_id})</li>`));
      historyEl.innerHTML = rows.join('');
    }

    box.querySelector('#uploadBtn').onclick = async (ev) => {
      const btn = ev.currentTarget;
      const input = box.querySelector('#upFile');
      const files = input && input.files;
      const nameInput = (box.querySelector('#upName').value || '').trim();
      if (!files || files.length === 0) { alert('Выберите файл(ы)'); return; }
      const fd = new FormData();
      fd.append('slotId', s.id);
      // If single file selected and custom name provided, use it
      if (files.length === 1 && nameInput) fd.append('name', nameInput);
      for (const f of files) fd.append('file', f);
      try {
        btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Загрузка…';
        await api('/api/files', { method: 'POST', body: fd });
        input.value = '';
        box.querySelector('#upName').value = '';
        await refreshFiles();
        btn.textContent = prev; btn.disabled = false;
      } catch (e) { alert(e.message); btn.disabled = false; }
    };

    const m = await modalPromise;
    if (!m) return;
    const { close, setError } = m;
    try {
      // Collect form values
      const text = () => (box.querySelector('#iText').value || '').trim();
      const titleVal = (box.querySelector('#regName')?.value || '').trim();
      const phoneVal = (box.querySelector('#regPhone')?.value || '').trim();
      const s1v = (box.querySelector('#regS1')?.value || 'not_confirmed');
      const s2v = (box.querySelector('#regS2')?.value || '');
      const s4v = (box.querySelector('#regS4')?.value || '');
      const payload = {
        id: s.id,
        date: (s.date || date),
        title: titleVal,
        interviewText: text(),
        status1: s1v,
        status2: s2v || undefined,
        status4: s4v || undefined,
        dataBlock: {
          model_data: [
            { field: 'fullName', value: titleVal },
            { field: 'phone', value: phoneVal }
          ]
        }
      };
      const updated = await api('/api/schedule', { method: 'PUT', body: JSON.stringify(payload) });
      // refresh from server to avoid stale local state
      await load();
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
      const nextVal = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      console.debug('[calendar] prev click', { from: currentMonth, to: nextVal });
      currentMonth = nextVal;
      await loadMonth();
    };
  }
  
  if (nextBtn) {
    nextBtn.onclick = async () => {
      const [y,m] = currentMonth.split('-').map(n=>parseInt(n,10));
      const d = new Date(y, m, 1); // m is already 1-based, so this goes to next month
      const nextVal = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      console.debug('[calendar] next click', { from: currentMonth, to: nextVal });
      currentMonth = nextVal;
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
    <section class="bar" style="align-items:center">
      <h1 style="margin:0">Сотрудники</h1>
      <span style="flex:1"></span>
      ${window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin') ? '<button id="addEmployee" class="primary">+ Добавить сотрудника</button>' : ''}
    </section>
    <div id="emplGrid" style="display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));align-items:stretch"></div>
  `;
  const gridEl = el('#emplGrid');
  const isRoot = window.currentUser.role === 'root';
  
  function renderList(){
    const filtered = (items || []);
    gridEl.innerHTML = filtered.map(e => {
      const tg = e.telegram ? `@${String(e.telegram).replace('@','')}` : '';
      const phone = e.phone || '';
      const roleLabel = e.role === 'admin' ? 'Администратор' : e.role === 'curator' ? 'Куратор' : 'Интервьюер';
      return `
        <div class="card" style="padding:20px;border-radius:12px;display:flex;flex-direction:column;align-items:center;text-align:center">
          <div style="width:96px;height:96px;border-radius:50%;background:linear-gradient(145deg,#fff,#f1f1f1);box-shadow:0 6px 16px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;color:#9aa0a6;font-size:12px">Employee\navatar</div>
          <div style="margin-top:12px">
            <div style="font-weight:700;color:var(--fg)">${e.fullName || 'Сотрудник'}</div>
            <div style="color:var(--muted);margin-top:2px">${roleLabel}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;width:100%;align-items:center;color:var(--muted)">
            ${tg ? `<a href="https://t.me/${tg.replace('@','')}" target="_blank" style="display:flex;align-items:center;gap:8px;color:inherit;text-decoration:none"><span class="material-symbols-rounded" style="color:#1d4ed8">send</span><span>${tg}</span></a>` : ''}
            ${phone ? `<div style="display:flex;align-items:center;gap:8px"><span class="material-symbols-rounded" style="color:#16a34a">call</span><span>${phone}</span></div>` : ''}
          </div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button data-id="${e.id}" class="openEmployee">Открыть профиль</button>
            ${isRoot ? `<button class="edit-employee secondary" data-id="${e.id}">Изменить</button>` : ''}
            ${isRoot ? `<button class="delete-employee danger" data-id="${e.id}">Удалить</button>` : ''}
          </div>
        </div>`;
    }).join('');

    // Open profile
    [...gridEl.querySelectorAll('.openEmployee')].forEach(btn => {
      btn.onclick = () => {
        if (typeof window.renderEmployeeCard === 'function') window.renderEmployeeCard(btn.dataset.id);
      };
    });

    // Removed expandable details to match mockup

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
  renderList();
  const addBtn = el('#addEmployee');
  if (addBtn) {
    addBtn.onclick = async () => {
      const form = document.createElement('div');
      form.innerHTML = `
        <label>ФИО<input id="fFullName" placeholder="Иванов Иван Иванович" required /></label>
        <label>Телефон<input id="fPhone" placeholder="+7 (999) 123-45-67" /></label>
        <label>Email<input id="fEmail" placeholder="employee@example.com" /></label>
        <label>Telegram<input id="fTelegram" placeholder="@username" /></label>
        <label>Дата начала работы<input id="fStartDate" type="date" /></label>
        <label>Дата рождения<input id="fBirthDate" type="date" /></label>
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
      const phone = form.querySelector('#fPhone').value.trim();
      const email = form.querySelector('#fEmail').value.trim();
      const telegram = form.querySelector('#fTelegram').value.trim();
      const startDate = form.querySelector('#fStartDate').value;
      const birthDate = form.querySelector('#fBirthDate').value;
      const notes = form.querySelector('#fNotes').value.trim();
      const role = form.querySelector('#fRole').value;
      if (!fullName) { setError('Заполните ФИО'); return; }
      try {
        // Include legacy fields with non-empty placeholders for backward compatibility (older servers may require them non-empty)
        const created = await api('/api/employees', { method: 'POST', body: JSON.stringify({ fullName, phone, email, telegram, startDate, birthDate, notes, role, position: 'N/A', department: 'N/A', city: 'N/A', address: 'N/A' }) });
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
      <label>Телефон<input id="fPhone" value="${employee.phone || ''}" placeholder="+7 (999) 123-45-67" /></label>
      <label>Email<input id="fEmail" value="${employee.email || ''}" placeholder="employee@example.com" /></label>
      <label>Telegram<input id="fTelegram" value="${employee.telegram || ''}" placeholder="@username" /></label>
      <label>Дата начала работы<input id="fStartDate" type="date" value="${employee.startDate || ''}" /></label>
      <label>Дата рождения<input id="fBirthDate" type="date" value="${employee.birthDate || ''}" /></label>
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
    const phone = form.querySelector('#fPhone').value.trim();
    const email = form.querySelector('#fEmail').value.trim();
    const telegram = form.querySelector('#fTelegram').value.trim();
    const startDate = form.querySelector('#fStartDate').value;
    const birthDate = form.querySelector('#fBirthDate').value;
    const role = form.querySelector('#fRole').value;
    const notes = form.querySelector('#fNotes').value.trim();
    
    if (!fullName) { setError('Заполните ФИО'); return; }
    
    try {
      // Include legacy fields with non-empty placeholders for backward compatibility (older servers may require them non-empty)
      const updated = await api('/api/employees', { 
        method: 'PUT', 
        body: JSON.stringify({ id: employee.id, fullName, phone, email, telegram, startDate, birthDate, role, notes, position: 'N/A', department: 'N/A', city: 'N/A', address: 'N/A' }) 
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
            ${e.role ? `<div><strong>Роль:</strong> ${e.role}</div>` : ''}
            ${e.phone ? `<div><strong>Телефон:</strong> ${e.phone}</div>` : ''}
            ${e.email ? `<div><strong>Email:</strong> ${e.email}</div>` : ''}
            ${e.telegram ? `<div><strong>Telegram:</strong> <a href="https://t.me/${String(e.telegram).replace('@','')}" target="_blank">${e.telegram}</a></div>` : ''}
            ${e.startDate ? `<div><strong>Начало работы:</strong> ${e.startDate}</div>` : ''}
            ${e.birthDate ? `<div><strong>Дата рождения:</strong> ${e.birthDate}</div>` : ''}
            ${e.notes ? `<div style="white-space:pre-wrap"><strong>Заметки:</strong> ${e.notes}</div>` : ''}
          </div>
          ${(window.currentUser && (window.currentUser.role === 'root')) ? `
            <div style="margin-top:12px;display:flex;gap:8px">
              <button id="editEmployeeBtn">Редактировать</button>
              <button id="deleteEmployeeBtn" style="background:#dc2626">Удалить</button>
            </div>` : ''}
        </div>
        <div class="card" style="padding:16px">
            <div style="display:flex;gap:24px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:12px">
            <h3 style="margin:0">Статистика</h3>
            <div style="color:var(--muted)">за период ${range.from} — ${range.to}</div>
          </div>
          <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px">
            <div class="stat-badge"><div class="stat-value">${stats.eventsCount||0}</div><div class="stat-label">событий</div></div>
            <div class="stat-badge"><div class="stat-value">${stats.hoursTotal||0}</div><div class="stat-label">часов</div></div>
            <div class="stat-badge"><div class="stat-value">${hoursFmt(stats.hoursTotal||0)}</div><div class="stat-label">отработано</div></div>
          </div>
          <div style="overflow:auto">
            <table class="tbl" style="width:100%;font-size:13px;border-collapse:collapse">
              <thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">Дата</th><th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">Кол-во</th><th style="text-align:left;padding:6px;border-bottom:1px solid var(--border)">Часы</th></tr></thead>
              <tbody>
                ${byDayArr.map(d => `<tr>
                  <td style="padding:6px;border-bottom:1px solid var(--border)">${d.date}</td>
                  <td style="padding:6px;border-bottom:1px solid var(--border)">${d.count||0}</td>
                  <td style="padding:6px;border-bottom:1px solid var(--border)">${(typeof d.hours === 'number') ? hoursFmt(d.hours) : '—'}</td>
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
        <svg viewBox="0 0 120 24" fill="currentColor">
          <text x="0" y="18" font-family="system-ui" font-weight="700" font-size="16">MirrorCRM</text>
        </svg>
      </div>
      <nav>
        ${me.role === 'root' || me.role === 'admin' ? `
          <button id="navModels" class="active">Модели</button>
          <button id="navEmployees">Сотрудники</button>
          <button id="navSchedule">Расписание</button>
          <button id="navFiles">Файлы</button>
          <button id="navAudit">Аудит</button>
        ` : me.role === 'interviewer' ? `
          <button id="navSchedule" class="active">Расписание</button>
          <button id="navModels">Модели</button>
        ` : ''}
        <button id="themeToggle" class="ghost" title="Переключить тему">🌓</button>
        <button id="logoutBtn">Выход</button>
      </nav>
    </header>
    <main id="view"></main>
  `;
  
  // Theme toggle functionality
  const themeBtn = el('#themeToggle');
  if (themeBtn) {
    themeBtn.onclick = () => {
      const newTheme = toggleTheme();
      themeBtn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
    };
    // Set initial icon
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    themeBtn.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  }
  
  // Logout functionality
  const logoutBtn = el('#logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = async () => { 
      await api('/api/logout', { method: 'POST' }); 
      renderLogin(); 
    };
  }
  // Helper to set active nav state
  function setActiveNav(activeId) {
    const navButtons = document.querySelectorAll('header nav button[id^="nav"]');
    navButtons.forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(activeId);
    if (activeBtn) activeBtn.classList.add('active');
  }

  if (me.role === 'root' || me.role === 'admin') {
    el('#navModels').onclick = () => { setActiveNav('navModels'); renderModels(); };
    el('#navSchedule').onclick = () => { setActiveNav('navSchedule'); renderCalendar(); };
    el('#navEmployees').onclick = () => { setActiveNav('navEmployees'); renderEmployees(); };
    el('#navFiles').onclick = () => { setActiveNav('navFiles'); renderFileSystem(); };
    const logsBtn = document.getElementById('navAudit');
    if (logsBtn) logsBtn.onclick = () => { setActiveNav('navAudit'); window.location.href = '/audit.html'; };
  } else if (me.role === 'interviewer') {
    el('#navSchedule').onclick = () => { setActiveNav('navSchedule'); renderCalendar(); };
    const modelsBtn = document.getElementById('navModels');
    if (modelsBtn) modelsBtn.onclick = () => { setActiveNav('navModels'); renderModels(); };
  }
}

async function renderModels() {
  if (!(window.currentUser && (['root','admin','interviewer'].includes(window.currentUser.role)))) {
    el('#view').innerHTML = `<div class="card"><h3>Недостаточно прав</h3><p>Доступно только для администраторов и интервьюеров.</p></div>`;
    return;
  }
  const view = el('#view');
  const data = await api('/api/models');
  let items = data.items || [];
  view.innerHTML = `
    <div class="models-container">
      <div class="models-header">
        <h1>Модели</h1>
        <div class="search-container">
          <div class="search-input-wrapper">
            <span class="material-symbols-rounded search-icon">search</span>
            <input id="search" class="search-input" placeholder="Поиск моделей..." type="text"/>
          </div>
        </div>
      </div>
      
      <div class="models-grid" id="modelsGrid"></div>
    </div>
  `;
  const grid = el('#modelsGrid');
  const getSelected = (id) => {
    const elSel = el(id);
    if (!elSel) return '';
    return elSel.value;
  };
  function applySort(list, mode){
    const arr = [...list];
    if (mode === 'name-desc') arr.sort((a,b)=> (b.name||'').localeCompare(a.name||''));
    else arr.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    return arr;
  }
  function renderList(){
    const q = (el('#search').value || '').toLowerCase();
    const filtered = items.filter(m => {
      const matchesText = (m.name||'').toLowerCase().includes(q) || (m.note||'').toLowerCase().includes(q) || (m.fullName||'').toLowerCase().includes(q);
      return matchesText;
    });
    const sorted = applySort(filtered, 'name-asc');
    grid.innerHTML = sorted.map(m => {
      const photoUrl = m.mainPhotoId ? `/api/files?id=${m.mainPhotoId}` : '';
      const initials = (m.fullName || m.name || '').trim().charAt(0).toUpperCase();
      const displayName = m.fullName || m.name || 'Модель';
      const telegram = m.telegram || '';
      const phone = m.phone || '';
      
      return `
        <div class="model-card" data-id="${m.id}">
          <div class="model-avatar">
            ${photoUrl ? `<img src="${photoUrl}" alt="${displayName}" class="avatar-image" />` : `<div class="avatar-placeholder"><span class="avatar-initials">${initials || '?'}</span></div>`}
          </div>
          <h3 class="model-name">${displayName}</h3>
          <div class="model-contacts">
            ${telegram ? `<div class="contact-item"><span class="material-symbols-rounded contact-icon telegram-icon">send</span><span class="contact-text">@${telegram}</span></div>` : ''}
            ${phone ? `<div class="contact-item"><span class="material-symbols-rounded contact-icon phone-icon">phone</span><span class="contact-text">${phone}</span></div>` : ''}
          </div>
        </div>`;
    }).join('');
    [...grid.querySelectorAll('.model-card')].forEach(card => card.onclick = () => renderModelCard(card.dataset.id));
  }
  el('#search').addEventListener('input', renderList);
  renderList();
}

async function renderModelCard(id) {
  if (!(window.currentUser && (['root','admin','interviewer'].includes(window.currentUser.role)))) {
    el('#view').innerHTML = `<div class="card"><h3>Недостаточно прав</h3><p>Доступно только для администраторов и интервьюеров.</p></div>`;
    return;
  }
  const view = el('#view');
  const me = window.currentUser || {};
  const isAdmin = (me.role === 'root' || me.role === 'admin');
  const model = await api('/api/models?id=' + encodeURIComponent(id));
  let files = [];
  try {
    const filesRes = await api('/api/files?modelId=' + encodeURIComponent(id));
    files = filesRes.items || [];
  } catch (e) {
    // Ignore files errors for robust rendering (interviewer/admin/root can view)
    files = [];
  }
  const mainFile = (files || []).find(f => f.id === model.mainPhotoId && (f.contentType||'').startsWith('image/'));
  const displayName = model.fullName || model.name || 'Модель';
  const telegram = model.telegram || '';
  const phone = model.phone || '';
  // Collect all active statuses for display and editing
  const getActiveStatusKeys = (m) => {
    const keys = [];
    const s1 = m.status1 || 'not_confirmed';
    if (s1) keys.push(s1);
    if (m.status2) keys.push(m.status2);
    if (m.status3) keys.push(m.status3);
    if (m.status4 === 'registration') keys.push('registration');
    return keys;
  };
  const activeStatuses = getActiveStatusKeys(model);
  
  // Status mapping
  const statusMap = {
    // Light backgrounds -> dark text; Dark backgrounds -> white text
    'not_confirmed': { label: 'не подтвердилась', color: 'var(--status-green-light)', textColor: '#1c1c1e' },
    'confirmed': { label: 'подтвердилась', color: 'var(--status-yellow)', textColor: '#1c1c1e' },
    'fail': { label: 'слив', color: 'var(--status-red)', textColor: '#ffffff' },
    'arrived': { label: 'пришла', color: 'var(--status-green-dark)', textColor: '#ffffff' },
    'no_show': { label: 'не пришла', color: 'var(--status-red)', textColor: '#ffffff' },
    'other': { label: 'другое', color: 'var(--status-gray)', textColor: '#1c1c1e' },
    'registration': { label: 'регистрация', color: 'var(--status-green-dark)', textColor: '#ffffff' },
    'reject_candidate': { label: 'отказ со стороны кандидата', color: 'var(--status-green-dark)', textColor: '#ffffff' },
    'reject_us': { label: 'отказ с нашей стороны', color: 'var(--status-black)', textColor: '#ffffff' },
    'thinking': { label: 'ушла на подумать', color: 'var(--status-gray)', textColor: '#1c1c1e' }
  };
  
  // Build inline chips for header subtitle (instead of @telegram)
  const headerStatusChips = `
    <div class="profile-status-chips">
      ${activeStatuses.map(k => `
        <span class="profile-status-chip" style="background-color: ${statusMap[k]?.color || 'var(--status-gray)'}; color: ${statusMap[k]?.textColor || '#1c1c1e'}">
          ${statusMap[k]?.label || k}
        </span>
      `).join('')}
    </div>
  `;

  view.innerHTML = `
    <div class="model-profile-new">
      <header class="profile-header">
        <div class="profile-header-left">
          <div class="profile-avatar-small">
            ${mainFile ? `<img src="${mainFile.url}" alt="${displayName}" class="avatar-image" />` : `<div class="avatar-placeholder"><span class="avatar-initials">${(displayName || '').charAt(0).toUpperCase()}</span></div>`}
          </div>
          <div class="profile-title-info">
            <h2 class="profile-title">${displayName}</h2>
            ${headerStatusChips}
          </div>
        </div>
        <div class="profile-header-right">
          <div class="status-dropdown">
            <button class="status-button icon-only" id="statusButton" title="Изменить статусы">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M4 2c.55 0 1 .45 1 1v17a1 1 0 1 1-2 0V3c0-.55.45-1 1-1zm3.5 1h8.38c.9 0 1.62.73 1.62 1.62v7.26c0 .89-.72 1.62-1.62 1.62H9.5l-.2-.01-2.3-.39v-9.1l2.3-.39.2-.01z"/>
              </svg>
            </button>
            <div class="status-dropdown-content" id="statusDropdown">
              ${Object.entries(statusMap).map(([key, value]) => {
                const checked = activeStatuses.includes(key) ? 'checked' : '';
                return `
                  <label class="status-option" data-status="${key}">
                    <input type="checkbox" class="status-checkbox" data-status="${key}" ${checked} />
                    <span class="status-indicator" style="background-color: ${value.color}"></span>
                    ${key === 'reject_candidate' ? '<span class="line-through">' + value.label + '</span>' : value.label}
                  </label>`;
              }).join('')}
            </div>
          </div>
          ${isAdmin ? `
          <button class="icon-button" id="deleteModelBtn" title="Удалить модель" style="color: var(--text)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" style="display:block;color:inherit">
              <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zm13-14h-3.5l-1-1h-5l-1 1H5v2h14V5z"/>
            </svg>
          </button>
          ` : ''}
          <button class="icon-button" id="editProfile" title="Редактировать">
            <span class="material-symbols-rounded">edit</span>
          </button>
          <button class="icon-button" id="closeProfile" title="Закрыть">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </header>
      
      <main class="profile-main">
        <div class="profile-grid">
          <div class="profile-left">
            <div class="info-section">
              <h3 class="section-title">Личная информация</h3>
              <div class="form-grid">
                <div class="form-field">
                  <label class="field-label">Telegram/Nickname</label>
                  <input type="text" class="field-input" value="@${telegram}" id="telegramInput" readonly aria-readonly="true" />
                </div>
                <div class="form-field">
                  <label class="field-label">ФИО</label>
                  <input type="text" class="field-input" value="${displayName}" id="fullNameInput" readonly aria-readonly="true" />
                </div>
                <div class="form-field">
                  <label class="field-label">Телефон</label>
                  <input type="text" class="field-input" value="${phone}" id="phoneInput" readonly aria-readonly="true" />
                </div>
                <div class="form-field">
                  <label class="field-label">Дата рождения</label>
                  <input type="date" class="field-input" value="${model.registration?.birthDate ? new Date(model.registration.birthDate).toISOString().split('T')[0] : ''}" id="birthDateInput" readonly aria-readonly="true" />
                </div>
                <div class="form-field">
                  <label class="field-label">Дата первой стажировки</label>
                  <input type="date" class="field-input" value="${model.registration?.internshipDate ? new Date(model.registration.internshipDate).toISOString().split('T')[0] : ''}" id="internshipDateInput" readonly aria-readonly="true" />
                </div>
              </div>
            </div>
            
            <div class="info-section">
              <h3 class="section-title">Документы</h3>
              <div class="form-grid">
                <div class="form-field">
                  <label class="field-label">Тип документа</label>
                  <select class="field-input" id="docTypeInput" disabled aria-disabled="true">
                    <option value="passport" ${model.registration?.docType === 'passport' ? 'selected' : ''}>Паспорт РФ</option>
                    <option value="license" ${model.registration?.docType === 'license' ? 'selected' : ''}>Водительское удостоверение</option>
                    <option value="international" ${model.registration?.docType === 'international' ? 'selected' : ''}>Загранпаспорт</option>
                  </select>
                </div>
                <div class="form-field">
                  <label class="field-label">Серия и номер / номер</label>
                  <input type="text" class="field-input" value="${model.registration?.docNumber || ''}" id="docNumberInput" readonly aria-readonly="true" />
                </div>
              </div>
            </div>
            
            <div class="info-section">
              <h3 class="section-title">История статусов</h3>
              <div class="status-history" id="statusHistory">
                <!-- Status history will be populated here -->
              </div>
            </div>
          </div>
          
          <div class="profile-right">
            <div class="info-section">
              <h3 class="section-title">Комментарии</h3>
              <div class="comments-list" id="commentsList">
                <!-- Comments will be populated here -->
              </div>
              <div class="comment-input-container">
                <textarea class="comment-input" placeholder="Добавить комментарий..." rows="3" id="commentText"></textarea>
                <button class="comment-send-btn" id="sendComment">
                  <span class="material-symbols-rounded">send</span>
                </button>
              </div>
            </div>
            
            <div class="info-section">
              <h3 class="section-title">Файлы</h3>
              <div class="files-container">
                <div class="files-header">
                  <h4 class="files-subtitle">Хранилище файлов</h4>
                  <label class="upload-btn" for="fileUpload">
                    <span class="material-symbols-rounded">upload_file</span>
                    Загрузить
                  </label>
                  <input type="file" id="fileUpload" class="file-input" multiple accept="image/*,video/*,.pdf" />
                </div>
                <div class="files-list" id="filesList">
                  <!-- Files will be populated here -->
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>`;
  
  // Populate status history with user info
  const statusHistoryEl = el('#statusHistory');
  if (statusHistoryEl && model.history) {
    // Get employees to map user IDs to names
    let employees = [];
    try {
      const empData = await api('/api/employees');
      employees = empData.items || [];
    } catch (e) {
      console.warn('Failed to load employees for history:', e);
    }
    
    const getUserName = (userId) => {
      if (!userId) return 'Система';
      const emp = employees.find(e => e.userId === userId);
      return emp ? emp.fullName : `Пользователь ${userId}`;
    };
    
    const historyItems = model.history
      .filter(h => h.action === 'status_change' || h.type === 'status_sync_from_slot' || h.type === 'registration')
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)) // newest first
      .map(h => {
        const date = new Date(h.ts || Date.now());
        const timeStr = date.toLocaleDateString('ru-RU', { 
          day: '2-digit', 
          month: '2-digit', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const userName = getUserName(h.userId);
        let actionText = '';
        let statusChips = '';
        
        if (h.type === 'registration') {
          actionText = `Регистрация модели — ${userName}`;
          statusChips = `<span class="history-status-chip" style="background: var(--status-green-dark)">регистрация</span>`;
        } else if (h.changes) {
          const changes = Object.entries(h.changes).map(([key, change]) => {
            const fromLabel = statusMap[change.from]?.label || change.from || '—';
            const toLabel = statusMap[change.to]?.label || change.to || '—';
            return `${fromLabel} → ${toLabel}`;
          }).join(', ');
          actionText = `${changes} — ${userName}`;
          
          // Show current statuses as chips
          const currentStatuses = [h.status1, h.status2, h.status3, h.status4].filter(Boolean);
          statusChips = currentStatuses.map(s => 
            `<span class="history-status-chip" style="background: ${statusMap[s]?.color || 'var(--status-gray)'}; color: ${statusMap[s]?.textColor || '#1c1c1e'}">${statusMap[s]?.label || s}</span>`
          ).join('');
        } else {
          actionText = `${h.type === 'status_sync_from_slot' ? 'Синхронизация со слотом' : 'Изменение статуса'} — ${userName}`;
        }
        
        return `
          <div class="status-history-item">
            <div class="status-history-left">
              <div class="status-history-text">${actionText}</div>
              <div class="status-history-chips">${statusChips}</div>
            </div>
            <div class="status-history-time">${timeStr}</div>
          </div>
        `;
      }).join('');
    
    statusHistoryEl.innerHTML = historyItems || '<div class="status-history-empty">История статусов пуста</div>';
  }
  // Admin-only: hook delete button inside renderModelCard
  if (isAdmin) {
    const delBtn = el('#deleteModelBtn');
    if (delBtn) {
      delBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ok = confirm('Удалить модель? Действие необратимо.');
        if (!ok) return;
        try {
          await api(`/api/models?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
          renderModels();
        } catch (e) {
          console.error('Delete model failed', e);
          alert('Не удалось удалить модель');
        }
      };
    }
  }
  // After render, populate accounts textarea explicitly
  try {
    const ta = el('#webcamAccounts');
    if (ta && typeof model.webcamAccounts === 'string') {
      ta.value = model.webcamAccounts;
      console.debug('[renderModelCard] textarea populated, len=', model.webcamAccounts.length);
      // Re-apply on next ticks to beat any late DOM updates
      setTimeout(() => {
        const ta2 = el('#webcamAccounts');
        if (ta2 && ta2.value !== model.webcamAccounts) {
          ta2.value = model.webcamAccounts;
          console.debug('[renderModelCard] textarea re-applied (0ms)');
        }
      }, 0);
      setTimeout(() => {
        const ta3 = el('#webcamAccounts');
        if (ta3 && ta3.value !== model.webcamAccounts) {
          ta3.value = model.webcamAccounts;
          console.debug('[renderModelCard] textarea re-applied (100ms)');
        }
      }, 100);
    }
  } catch {}
  // Hook save webcam accounts
  const btnAcc = el('#saveWebcamAccounts');
  if (btnAcc) {
    btnAcc.onclick = async () => {
      const val = (el('#webcamAccounts').value || '').trim();
      try {
        await api('/api/models', { method: 'PUT', body: JSON.stringify({ id, webcamAccounts: val }) });
        // UX: show inline confirmation and delay refresh to avoid KV eventual consistency
        btnAcc.textContent = 'Сохранено';
        btnAcc.disabled = true;
        // Keep local value visible immediately
        const ta = el('#webcamAccounts');
        if (ta) ta.value = val;
        // Poll server for consistency up to ~5s, then optionally re-render
        const started = Date.now();
        const poll = async () => {
          try {
            const fresh = await api('/api/models?id=' + encodeURIComponent(id));
            if (fresh && typeof fresh.webcamAccounts === 'string' && fresh.webcamAccounts === val) {
              // Data is consistent on server; safe to re-render (updates other UI parts)
              btnAcc.textContent = 'Сохранить';
              btnAcc.disabled = false;
              renderModelCard(id);
              return;
            }
          } catch {}
          if (Date.now() - started < 5000) {
            setTimeout(poll, 500);
          } else {
            // Stop polling, just restore button
            btnAcc.textContent = 'Сохранить';
            btnAcc.disabled = false;
          }
        };
        setTimeout(poll, 500);
      } catch (e) { alert(e.message); }
    };
  }
  // Render comments helper
  function renderComments(list){
    const box = el('#commentsList');
    const items = Array.isArray(list) ? [...list] : [];
    items.sort((a,b)=> (a.ts||0) - (b.ts||0));
    box.innerHTML = items.map(c => {
      const when = c.ts ? new Date(c.ts).toLocaleString('ru') : '';
      const who = c.user && (c.user.login || c.user.fullName || c.user.id) ? ` · ${c.user.login || c.user.fullName || c.user.id}` : '';
      const text = (c.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<div class="comment-item" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--panel)">`+
        `<div style="font-size:12px;color:var(--muted)">${when}${who}</div>`+
        `<div style="margin-top:4px;white-space:pre-wrap">${text}</div>`+
      `</div>`;
    }).join('');
  }
  renderComments(model.comments || []);
  const filesListEl = el('#filesList');
  function renderFiles(){
    if (!filesListEl) return;
    const canDownload = (window.currentUser && window.currentUser.role === 'root');
    filesListEl.innerHTML = (files || []).map(f => {
      const viewUrl = f.url;
      const downloadUrl = f.url + (f.url.includes('?') ? '&' : '?') + 'download=1';
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
            ${fileDate ? `<div class="file-date">${fileDate}</div>` : ''}
            <div class="file-actions">
              ${canDownload ? `<a href="${downloadUrl}" class="file-btn">Скачать</a>` : ''}
              ${isImage ? `<button class="file-btn make-main" data-id="${f.id}">Сделать главной</button>` : ''}
              ${(window.currentUser && (window.currentUser.role === 'root' || window.currentUser.role === 'admin')) ? `<button class="file-btn delete-file" data-id="${f.id}" style="background:#dc2626;">Удалить</button>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }
  renderFiles();
  // Upload via new UI input
  const uploadInput = el('#fileUpload');
  if (uploadInput) {
    uploadInput.addEventListener('change', async (e) => {
      const filesToUpload = [...(e.target.files || [])];
      if (!filesToUpload.length) return;
      const fd = new FormData();
      fd.append('modelId', id);
      filesToUpload.forEach(f => fd.append('file', f));
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
        uploadInput.value = '';
      } catch (err) { alert(err.message); }
    });
  }
  
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

  // Edit profile functionality (registration-first)
  el('#editProfile').onclick = async () => {
    const form = document.createElement('div');
    const reg = (model && model.registration) || {};
    form.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Псевдоним/Никнейм<input id="mName" value="${model.name || ''}" required /></label>
        <label>ФИО<input id="mFullName" value="${reg.fullName || model.fullName || ''}" /></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Телефон<input id="mPhone" value="${reg.phone || (model.contacts && model.contacts.phone) || ''}" /></label>
        <label>Дата рождения<input id="mBirthDate" type="date" value="${reg.birthDate || ''}" /></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Дата первой стажировки<input id="mInternshipDate" type="date" value="${reg.internshipDate || ''}" /></label>
        <label>Тип документа
          <select id="mDocType">
            <option value="">Не указан</option>
            <option value="passport" ${reg.docType === 'passport' ? 'selected' : ''}>Паспорт РФ</option>
            <option value="driver" ${reg.docType === 'driver' ? 'selected' : ''}>Водительские права</option>
            <option value="foreign" ${reg.docType === 'foreign' ? 'selected' : ''}>Загранпаспорт</option>
          </select>
        </label>
      </div>
      <label>Серия и номер / Номер<input id="mDocNumber" value="${reg.docNumber || ''}" /></label>
      
    `;
    const res = await showModal({ title: 'Редактировать профиль', content: form, submitText: 'Сохранить' });
    if (!res) return;
    const { close, setError } = res;
    const name = form.querySelector('#mName').value.trim();
    const fullName = form.querySelector('#mFullName').value.trim();
    const phone = form.querySelector('#mPhone').value.trim();
    
    // Registration fields (if present)
    const birthDate = form.querySelector('#mBirthDate') ? form.querySelector('#mBirthDate').value : undefined;
    const docType = form.querySelector('#mDocType') ? form.querySelector('#mDocType').value : undefined;
    const docNumber = form.querySelector('#mDocNumber') ? form.querySelector('#mDocNumber').value.trim() : undefined;
    const internshipDate = form.querySelector('#mInternshipDate') ? form.querySelector('#mInternshipDate').value : undefined;
    
    if (!name) { setError('Укажите псевдоним модели'); return; }
    try {
      const payload = { 
        id, name, fullName, 
        contacts: { phone }
      };
      
      // Add registration fields if they exist
      if (birthDate !== undefined || docType !== undefined || docNumber !== undefined || internshipDate !== undefined) {
        payload.registration = {
          ...reg,
          ...(birthDate !== undefined ? { birthDate } : {}),
          ...(docType !== undefined ? { docType } : {}),
          ...(docNumber !== undefined ? { docNumber } : {}),
          ...(internshipDate !== undefined ? { internshipDate } : {})
        };
      }
      
      await api('/api/models', { method: 'PUT', body: JSON.stringify(payload) });
      close();
      renderModelCard(id); // refresh profile
    } catch (e) {
      setError(e.message);
    }
  };

  // Status dropdown interactions with multi-select
  const statusBtn = el('#statusButton');
  const statusDropdown = el('#statusDropdown');
  if (statusBtn && statusDropdown) {
    // Prevent dropdown from closing when interacting inside it
    statusDropdown.addEventListener('click', (e) => e.stopPropagation());
    statusDropdown.addEventListener('mousedown', (e) => e.stopPropagation());

    // Toggle open/close on button
    let onDocClick;
    let onEsc;
    const openMenu = () => {
      if (statusDropdown.classList.contains('open')) return;
      statusDropdown.classList.add('open');
      onDocClick = (e) => {
        if (!statusDropdown.contains(e.target) && !statusBtn.contains(e.target)) {
          closeMenu();
        }
      };
      onEsc = (e) => {
        if (e.key === 'Escape') closeMenu();
      };
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
    };
    const closeMenu = () => {
      statusDropdown.classList.remove('open');
      if (onDocClick) document.removeEventListener('click', onDocClick, true);
      if (onEsc) document.removeEventListener('keydown', onEsc, true);
    };

    statusBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (statusDropdown.classList.contains('open')) {
        closeMenu();
      } else {
        openMenu();
      }
    };
    const group1 = ['not_confirmed','confirmed','fail'];
    const group3 = ['reject_candidate','reject_us','thinking'];

    const applyFromCheckboxes = async () => {
      // Read current selections
      const selected = Array.from(statusDropdown.querySelectorAll('.status-checkbox'))
        .filter(inp => inp.checked)
        .map(inp => inp.dataset.status);
      // Enforce one per group by last-checked wins (UI handlers also enforce, but double-check)
      let s1 = selected.find(k => group1.includes(k)) || 'not_confirmed';
      let s3 = selected.find(k => group3.includes(k)) || '';
      const s4 = selected.includes('registration') ? 'registration' : '';
      const payload = { id, status1: s1 };
      if (s3) payload.status3 = s3; else payload.status3 = '';
      if (s4) payload.status4 = 'registration'; else payload.status4 = '';
      try {
        await api('/api/models', { method: 'PUT', body: JSON.stringify(payload) });
        // Refresh chips without closing dropdown
        renderModelCard(id);
      } catch (e) { alert(e.message); }
    };

    // Handle checkbox changes; keep only one per group toggled
    statusDropdown.querySelectorAll('.status-checkbox').forEach(inp => {
      inp.addEventListener('change', (ev) => {
        const key = inp.dataset.status;
        // If a group1 key is checked, uncheck other group1
        if (group1.includes(key) && inp.checked) {
          statusDropdown.querySelectorAll('.status-checkbox').forEach(other => {
            if (other !== inp && group1.includes(other.dataset.status)) other.checked = false;
          });
        }
        // If a group3 key is checked, uncheck other group3
        if (group3.includes(key) && inp.checked) {
          statusDropdown.querySelectorAll('.status-checkbox').forEach(other => {
            if (other !== inp && group3.includes(other.dataset.status)) other.checked = false;
          });
        }
        // registration is independent
        applyFromCheckboxes();
      });
    });
  }

  // Close profile button -> back to models list
  const closeBtn = el('#closeProfile');
  if (closeBtn) closeBtn.onclick = () => renderModels();

  // Comment send in new UI (no form)
  const sendBtn = el('#sendComment');
  if (sendBtn) {
    sendBtn.onclick = async () => {
      const ta = el('#commentText');
      const text = (ta && ta.value || '').trim();
      if (!text) return;
      try {
        const resp = await api('/api/models', { method: 'PUT', body: JSON.stringify({ action: 'addComment', modelId: id, text }) });
        ta.value = '';
        const updated = (resp && resp.model) ? resp.model : model;
        renderComments(updated.comments || []);
      } catch (e) { alert(e.message); }
    };
  }

  // Delete model functionality (direct binding + delegated fallback)
  window._handleDeleteModel = window._handleDeleteModel || (async (btn) => {
    console.log('[model/delete] handler called');
    try {
      const bid = btn?.dataset?.id || id;
      const bname = btn?.dataset?.name || (model && model.name) || '';
      console.log('[model/delete] extracted data:', { bid, bname });
      if (!bid) { console.warn('[model/delete] missing id on button'); return; }
      if (btn && btn.disabled) { console.log('[model/delete] button disabled, returning'); return; }
      
      console.log('[model/delete] checking user role:', window.currentUser?.role);
      if (window.currentUser.role === 'root') {
        console.log('[model/delete] requesting root password');
        if (!await confirmRootPassword(`удаление модели "${bname}"`)) {
          console.log('[model/delete] root password cancelled');
          return;
        }
      }
      
      console.log('[model/delete] showing confirmation dialog');
      if (!confirm(`Удалить модель "${bname}"?\n\nЭто действие удалит:\n• Профиль модели\n• Все загруженные файлы\n• Необратимо`)) {
        console.log('[model/delete] user cancelled confirmation');
        return;
      }
      
      if (btn) btn.disabled = true;
      console.log('[model/delete] sending DELETE /api/models', { id: bid });
      await api('/api/models?id=' + encodeURIComponent(bid), { method: 'DELETE' });
      console.log('[model/delete] success');
      renderModels();
    } catch (err) {
      console.warn('[model/delete] failed', err);
      alert(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  const _delBtn = el('#deleteModel');
  if (_delBtn) {
    _delBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await window._handleDeleteModel(_delBtn);
    };
  }

  // Delegated fallback in case direct binding didn’t attach
  if (!window._deleteModelDelegated) {
    window._deleteModelDelegated = true;
    document.addEventListener('click', (e) => {
      const btn = e.target && (e.target.id === 'deleteModel' ? e.target : e.target.closest && e.target.closest('#deleteModel'));
      if (!btn) return;
      // If a direct handler exists, let it run; otherwise call shared handler
      if (typeof btn.onclick === 'function') return;
      window._handleDeleteModel(btn);
    }, true);
  }

  const exportBtn = el('#exportCsv');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const modeEl = el('#fileSort');
      const qEl = el('#fileSearch');
      const mode = modeEl ? modeEl.value : 'name-asc';
      const q = (qEl && qEl.value || '').toLowerCase();
      const filtered = files.filter(f => (f.name||'').toLowerCase().includes(q) || (f.description||'').toLowerCase().includes(q));
      const sorted = filtered.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
      const rows = [['name','description','url'], ...sorted.map(f => [f.name||'', f.description||'', f.url||''])];
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${model.name}-files.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }
  renderFiles();
  const fileFormEl = el('#fileForm');
  if (fileFormEl) fileFormEl.addEventListener('submit', async (e) => {
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
          ${(employees||[]).map(e=>`<option value="${e.id}">${e.fullName}</option>`).join('')}
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

// Password confirmation for root operations (disabled - always allow)
async function confirmRootPassword(operation) {
  return true;
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
  initTheme(); // Initialize theme on app start
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
