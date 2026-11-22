// Admin page for the wedding website. Talks to /admin/api.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const main = $('#main');
  const state = { me: null, accounts: [], data: null, tab: 'dashboard', q: '', fType: 'all', fStatus: 'all' };

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'x-requested-with': 'fyd-admin' }, credentials: 'same-origin' };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const r = await fetch('/admin/api' + path, init);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/login') {
      state.me = null;
      renderLogin();
      throw new Error('login_required');
    }
    if (!r.ok) throw Object.assign(new Error(j.error || 'error'), { detail: j.detail, status: r.status });
    return j;
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const MEAL = { meat: 'Meat', veg: 'Vegetarian', vegan: 'Vegan' };
  const joinNames = (names, lang) => {
    if (names.length < 2) return names[0] || '';
    const last = names[names.length - 1];
    const and = lang === 'en' ? ' & ' : /^(i|hi)/i.test(last) ? ' e ' : ' y ';
    return names.slice(0, -1).join(', ') + and + last;
  };
  const linkFor = (h) => `${state.data.baseUrl}/i/${h.token}`;
  // WhatsApp wants the number in international form, digits only. A leading 0 is taken as a UK number.
  function waNumber(raw) {
    let n = String(raw || '').replace(/[^\d+]/g, '');
    if (!n) return '';
    if (n.startsWith('+')) n = n.slice(1);
    else if (n.startsWith('00')) n = n.slice(2);
    else if (n.startsWith('0')) n = '44' + n.slice(1);
    return n.replace(/\D/g, '');
  }

  // ---------- Login and first-time setup ----------

  function renderLogin(error = '') {
    $('#tabs').hidden = true;
    $('#logout').hidden = true;
    $('#who').textContent = '';
    const opts = state.accounts.map((a) => `<option value="${esc(a.email)}">${esc(a.name)} (${esc(a.email)})</option>`).join('');
    main.innerHTML = `<div class="card login">
      <h2>Log in</h2>
      <form id="login">
        <label class="f" for="em">Who are you?</label>
        <select id="em">${opts}</select>
        <div id="pw-area"></div>
        <p class="error" id="err" role="alert">${esc(error)}</p>
        <button class="btn rasp" type="submit" id="go">Log in</button>
      </form>
    </div>`;
    const area = $('#pw-area');
    const draw = () => {
      const acc = state.accounts.find((a) => a.email === $('#em').value);
      if (acc && !acc.ready) {
        area.innerHTML = `<p class="notice" style="margin-top:14px">First time here, ${esc(acc.name)}: choose your password. You need the setup code once.</p>
          <label class="f" for="code">Setup code</label><input id="code" autocomplete="off" required>
          <label class="f" for="pw">New password (at least 10 characters)</label><input id="pw" type="password" autocomplete="new-password" minlength="10" required>
          <label class="f" for="pw2">Repeat the password</label><input id="pw2" type="password" autocomplete="new-password" minlength="10" required>`;
        $('#go').textContent = 'Set password and log in';
      } else {
        area.innerHTML = `<label class="f" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>`;
        $('#go').textContent = 'Log in';
      }
    };
    $('#em').addEventListener('change', draw);
    draw();
    $('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const acc = state.accounts.find((a) => a.email === $('#em').value);
      const err = $('#err');
      err.textContent = '';
      try {
        if (acc && !acc.ready) {
          if ($('#pw').value !== $('#pw2').value) return void (err.textContent = 'The two passwords are different.');
          await api('/setup', { method: 'POST', body: { email: acc.email, code: $('#code').value.trim(), password: $('#pw').value } });
        } else {
          await api('/login', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value } });
        }
        await start();
      } catch (ex) {
        err.textContent =
          { bad_login: 'That password is not right.', bad_setup: 'That setup code is not right.', weak_password: 'Use at least 10 characters.', too_many: 'Too many tries. Wait 15 minutes and try again.' }[ex.message] ||
          'Something went wrong. Try again.';
      }
    });
  }

  // ---------- Shell ----------

  const TABS = [
    ['dashboard', 'Dashboard'],
    ['households', 'Households'],
    ['messages', 'Messages'],
    ['export', 'Export & reminders'],
    ['settings', 'Settings'],
  ];

  function renderTabs() {
    const nMsg = state.data.households.filter((h) => h.message).length;
    const nav = $('#tabs');
    nav.hidden = false;
    nav.innerHTML = TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}${id === 'messages' && nMsg ? `<span class="count">${nMsg}</span>` : ''}</button>`).join('');
    nav.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        render();
      })
    );
  }

  async function reload() {
    state.data = await api('/data');
    render();
  }

  function render() {
    renderTabs();
    ({ dashboard: renderDashboard, households: renderHouseholds, messages: renderMessages, export: renderExport, settings: renderSettings })[state.tab]();
  }

  // ---------- Dashboard ----------

  function stats() {
    const hs = state.data.households;
    const g = (type, f) => hs.filter((h) => h.type === type).reduce((n, h) => n + h.guests.filter(f).length, 0);
    const rows = [
      ['Invited', () => true],
      ['Attending', (x) => x.attending === true],
      ['Declined', (x) => x.attending === false],
      ['Not replied', (x) => x.attending === null],
    ].map(([label, f]) => ({ label, day: g('day', f), eve: g('eve', f) }));
    const meals = ['meat', 'veg', 'vegan'].map((m) => ({ m, n: g('day', (x) => x.attending === true && x.meal === m) }));
    return {
      rows,
      meals,
      households: hs.length,
      sent: hs.filter((h) => h.sent_at).length,
      opened: hs.filter((h) => h.opened_at).length,
      replied: hs.filter((h) => h.responded_at).length,
      diets: hs.reduce((n, h) => n + h.guests.filter((x) => x.attending && x.diet).length, 0),
    };
  }

  function renderDashboard() {
    const s = stats();
    const att = s.rows[1];
    const d = state.data;
    const status = d.locked
      ? `<span class="chip no">RSVPs closed</span>`
      : `<span class="chip ok">RSVPs open</span> until the end of ${esc(fmtDay(d.settings.rsvp_deadline + 'T12:00:00Z'))}`;
    main.innerHTML = `
      <h2>Dashboard</h2>
      <div class="grid">
        <div class="card"><h3>Attending so far</h3><div class="big">${att.day + att.eve}</div><p class="muted" style="margin:6px 0 0">${att.day} day guests and ${att.eve} evening guests</p></div>
        <div class="card"><h3>Households replied</h3><div class="big">${s.replied} <span style="font-size:22px;color:var(--ink)">of ${s.households}</span></div><p class="muted" style="margin:6px 0 0">${s.sent} invites sent · ${s.opened} opened</p></div>
        <div class="card"><h3>RSVP status</h3><p style="margin:0">${status}</p><p class="muted" style="margin:8px 0 0">Change this in Settings.</p></div>
      </div>
      <div class="grid">
        <div class="card"><h3>Guests by event</h3>
          <table><thead><tr><th></th><th class="num">Day</th><th class="num">Evening</th><th class="num">Total</th></tr></thead>
          <tbody>${s.rows.map((r) => `<tr><td>${r.label}</td><td class="num">${r.day}</td><td class="num">${r.eve}</td><td class="num"><b>${r.day + r.eve}</b></td></tr>`).join('')}</tbody></table>
          <p class="hint">Day guests are at the whole day. The evening party is day guests plus evening guests: <b>${att.day + att.eve}</b> so far.</p>
        </div>
        <div class="card"><h3>Meals (day guests attending)</h3>
          <table><tbody>${s.meals.map((m) => `<tr><td>${MEAL[m.m]}</td><td class="num"><b>${m.n}</b></td></tr>`).join('')}
          <tr><td>With dietary notes</td><td class="num"><b>${s.diets}</b></td></tr></tbody></table>
          <p class="hint">The full list for the caterer is in Export.</p>
        </div>
      </div>`;
  }

  // ---------- Households ----------

  function replyChips(h) {
    if (!h.responded_at) return h.opened_at ? `<span class="chip wait">Opened, no reply</span>` : h.sent_at ? `<span class="chip wait">Sent, not opened</span>` : `<span class="chip">Not sent</span>`;
    const yes = h.guests.filter((g) => g.attending === true).length;
    const no = h.guests.filter((g) => g.attending === false).length;
    const wait = h.guests.filter((g) => g.attending === null).length;
    return (yes ? `<span class="chip ok">${yes} attending</span> ` : '') + (no ? `<span class="chip no">${no} declined</span> ` : '') + (wait ? `<span class="chip wait">${wait} no reply</span>` : '');
  }

  function renderHouseholds() {
    const d = state.data;
    const q = state.q.toLowerCase();
    const list = d.households.filter((h) => {
      if (state.fType !== 'all' && h.type !== state.fType) return false;
      if (state.fStatus === 'unsent' && h.sent_at) return false;
      if (state.fStatus === 'noreply' && h.responded_at) return false;
      if (state.fStatus === 'replied' && !h.responded_at) return false;
      if (q && !h.guests.some((g) => g.name.toLowerCase().includes(q))) return false;
      return true;
    });
    main.innerHTML = `
      <h2>Households <span class="muted" style="font:15px var(--ui)">${list.length} of ${d.households.length}</span></h2>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search by name" value="${esc(state.q)}" aria-label="Search by name">
        <select id="fType" aria-label="Day or Evening"><option value="all">Day and Evening</option><option value="day">Day only</option><option value="eve">Evening only</option></select>
        <select id="fStatus" aria-label="Status"><option value="all">Any status</option><option value="unsent">Invite not sent</option><option value="noreply">Not replied</option><option value="replied">Replied</option></select>
        <span class="spacer"></span>
        <button class="btn" id="add">Add household</button>
        <label class="btn ghost" for="file" tabindex="0">Upload guest list</label><input type="file" id="file" accept=".csv,.xlsx" hidden>
        <a class="btn ghost" href="/admin/api/template.csv">Template</a>
      </div>
      <div id="import-result"></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Guests</th><th>Invite</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${
          list
            .map((h) => {
              const replies = h.responded_at
                ? `<ul class="replies">${h.guests
                    .map((g) => `<li>${esc(g.name)}: ${g.attending === true ? 'attending' : g.attending === false ? 'declined' : 'no reply yet'}${g.attending && g.meal ? ' · ' + MEAL[g.meal] : ''}${g.attending && g.diet ? ' · ' + esc(g.diet) : ''}</li>`)
                    .join('')}</ul>`
                : '';
              return `<tr data-id="${h.id}">
              <td><div class="names">${esc(h.guests.map((g) => g.name).join(', '))}</div>${replies}
                <div class="hint">${esc(h.whatsapp || 'No WhatsApp number')}${h.email ? ' · ' + esc(h.email) : ''}</div></td>
              <td><span class="chip ${h.type}">${h.type === 'day' ? 'Day' : 'Evening'}</span> <span class="chip">${h.lang === 'es' ? 'Spanish' : 'English'}</span></td>
              <td>${replyChips(h)}<div class="hint">${h.sent_at ? 'Sent ' + esc(fmtDate(h.sent_at)) : ''}${h.opened_at ? '<br>Opened ' + esc(fmtDate(h.opened_at)) : ''}${h.responded_at ? '<br>Replied ' + esc(fmtDate(h.responded_at)) : ''}</div></td>
              <td><div class="actions">
                <button class="btn rasp small" data-act="wa">${h.sent_at ? 'Send again' : 'Send on WhatsApp'}</button>
                <button class="btn ghost small" data-act="copy">Copy link</button>
                <a class="btn ghost small" href="/i/${esc(h.token)}" target="_blank" rel="noopener">Open</a>
                <button class="btn ghost small" data-act="edit">Edit</button>
                <button class="btn danger small" data-act="del">Delete</button>
              </div></td></tr>`;
            })
            .join('') || `<tr><td colspan="4" class="muted">${d.households.length ? 'Nothing matches.' : 'No households yet. Add one, or upload your guest list.'}</td></tr>`
        }</tbody></table></div>
      <p class="hint">“Open” shows the page that household sees. You can fill in their RSVP there if they reply to you directly.</p>`;
    $('#fType').value = state.fType;
    $('#fStatus').value = state.fStatus;
    $('#q').addEventListener('input', (e) => {
      state.q = e.target.value;
      renderHouseholds();
      const el = $('#q');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    $('#fType').addEventListener('change', (e) => ((state.fType = e.target.value), renderHouseholds()));
    $('#fStatus').addEventListener('change', (e) => ((state.fStatus = e.target.value), renderHouseholds()));
    $('#add').addEventListener('click', () => householdDialog(null));
    $('#file').addEventListener('change', importFile);
    main.querySelectorAll('tr[data-id]').forEach((tr) => {
      const h = d.households.find((x) => x.id === Number(tr.dataset.id));
      tr.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => ({ wa: sendWhatsApp, copy: copyLink, edit: householdDialog, del: deleteHousehold })[b.dataset.act](h)));
    });
  }

  async function sendWhatsApp(h) {
    const tpl = state.data.settings[h.lang === 'es' ? 'wa_es' : 'wa_en'];
    const text = tpl.replace(/\{names\}/g, joinNames(h.guests.map((g) => g.name), h.lang)).replace(/\{link\}/g, linkFor(h));
    const num = waNumber(h.whatsapp);
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    if (!h.sent_at) {
      await api(`/households/${h.id}/sent`, { method: 'POST', body: { sent: true } });
      await reload();
    }
    toast(num ? 'WhatsApp opened. Press send there.' : 'No number saved: choose the contact in WhatsApp.');
  }

  async function copyLink(h) {
    try {
      await navigator.clipboard.writeText(linkFor(h));
      toast('Link copied');
    } catch {
      prompt('Copy this link:', linkFor(h));
    }
  }

  async function deleteHousehold(h) {
    const names = h.guests.map((g) => g.name).join(', ');
    if (!confirm(`Delete ${names}?\n\nThis removes the household, its personal link and any reply. It cannot be undone.`)) return;
    await api(`/households/${h.id}`, { method: 'DELETE' });
    toast('Deleted');
    await reload();
  }

  function householdDialog(h) {
    const dlg = $('#dlg');
    dlg.innerHTML = `<form method="dialog" id="hh">
      <h2>${h ? 'Edit household' : 'Add household'}</h2>
      <label class="f" for="h-names">Guest names, one per line</label>
      <textarea id="h-names" required>${esc(h ? h.guests.map((g) => g.name).join('\n') : '')}</textarea>
      <p class="hint">Only the people named here are invited.${h && h.responded_at ? ' Changing a name clears that person’s reply.' : ''}</p>
      <div class="row2">
        <div><label class="f" for="h-type">Invited to</label><select id="h-type" class="field"><option value="day">Day (whole day)</option><option value="eve">Evening only</option></select></div>
        <div><label class="f" for="h-lang">Language</label><select id="h-lang" class="field"><option value="en">English</option><option value="es">Spanish</option></select></div>
      </div>
      <div class="row2">
        <div><label class="f" for="h-wa">WhatsApp number</label><input id="h-wa" class="field" inputmode="tel" placeholder="+44 7700 900123" value="${esc(h ? h.whatsapp : '')}"></div>
        <div><label class="f" for="h-email">Email (optional)</label><input id="h-email" class="field" type="email" value="${esc(h ? h.email : '')}"></div>
      </div>
      <p class="hint">Include the country code (+44, +51…). A number starting with 0 is treated as a UK number.</p>
      <p class="error" id="h-err" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="btn ghost" id="h-cancel">Cancel</button><button class="btn rasp" type="submit">Save</button></div>
    </form>`;
    if (h) {
      $('#h-type').value = h.type;
      $('#h-lang').value = h.lang;
    }
    $('#h-cancel').addEventListener('click', () => dlg.close());
    $('#hh').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        names: $('#h-names').value.split('\n').map((s) => s.trim()).filter(Boolean),
        type: $('#h-type').value,
        lang: $('#h-lang').value,
        whatsapp: $('#h-wa').value,
        email: $('#h-email').value,
      };
      try {
        await api(h ? `/households/${h.id}` : '/households', { method: h ? 'PUT' : 'POST', body });
        dlg.close();
        toast('Saved');
        await reload();
      } catch (ex) {
        $('#h-err').textContent = { names_required: 'Add at least one name.', too_many_names: 'No more than 12 names in one household.' }[ex.message] || 'Could not save. Try again.';
      }
    });
    dlg.showModal();
  }

  async function importFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const out = $('#import-result');
    out.innerHTML = `<p class="notice">Reading ${esc(file.name)}…</p>`;
    try {
      const r = await api('/import', { method: 'POST', form });
      await reload();
      $('#import-result').innerHTML = `<div class="notice"><b>${r.added} household${r.added === 1 ? '' : 's'} added.</b>${
        r.skipped.length ? ` ${r.skipped.length} row${r.skipped.length === 1 ? ' was' : 's were'} skipped:<ul style="margin:6px 0 0">${r.skipped.map((s) => `<li>Row ${s.row}: ${esc(s.reason)}</li>`).join('')}</ul>` : ''
      }</div>`;
    } catch (ex) {
      out.innerHTML = `<p class="notice"><b>Could not read that file.</b> ${esc(ex.detail || 'Use the template: a CSV or Excel file with one row per household.')}</p>`;
    }
  }

  // ---------- Messages ----------

  function renderMessages() {
    const list = state.data.households.filter((h) => h.message).sort((a, b) => new Date(b.message_at || b.responded_at) - new Date(a.message_at || a.responded_at));
    main.innerHTML = `<h2>Messages <span class="muted" style="font:15px var(--ui)">${list.length}</span></h2>
      <div class="card">${
        list
          .map(
            (h) => `<div class="msg"><b>${esc(h.guests.map((g) => g.name).join(', '))}</b> <span class="chip ${h.type}">${h.type === 'day' ? 'Day' : 'Evening'}</span>
            <span class="muted"> · ${esc(fmtDate(h.message_at || h.responded_at))}</span><blockquote>${esc(h.message)}</blockquote></div>`
          )
          .join('') || '<p class="muted" style="margin:0">No messages yet. Notes that guests leave in “A message for us” on their RSVP appear here, newest first.</p>'
      }</div>`;
  }

  // ---------- Export and reminders ----------

  async function renderExport() {
    main.innerHTML = `<h2>Export & reminders</h2>
      <div class="grid">
        <div class="card"><h3>Spreadsheet for the caterer and venue</h3>
          <p>An Excel file with four sheets: Numbers (for the venue), Catering (meal counts and dietary requirements), Guests and Households.</p>
          <a class="btn rasp" href="/admin/api/export.xlsx">Download spreadsheet</a>
          <p class="hint">It contains dietary and contact details, so share it only with the people who need it.</p></div>
        <div class="card"><h3>Reminder emails</h3><div id="rem"><p class="muted">Checking…</p></div></div>
      </div>`;
    const box = $('#rem');
    try {
      const p = await api('/reminders', { method: 'POST', body: { preview: true } });
      const noEmail = state.data.households.filter((h) => !h.responded_at && !h.email).length;
      box.innerHTML = `<p><b>${p.count}</b> household${p.count === 1 ? ' has' : 's have'} not replied and ${p.count === 1 ? 'has' : 'have'} an email address.${noEmail ? ` ${noEmail} more ${noEmail === 1 ? 'has' : 'have'} no email: use “Send again” on WhatsApp for those.` : ''}</p>
        ${p.emailConfigured ? '' : '<p class="notice">Email is not connected yet, so reminders cannot be sent. The Brevo key needs adding to the hosting settings.</p>'}
        ${state.data.locked ? '<p class="notice">RSVPs are closed, so reminders are switched off.</p>' : ''}
        <button class="btn" id="send-rem" ${p.count && p.emailConfigured && !state.data.locked ? '' : 'disabled'}>Send ${p.count} reminder${p.count === 1 ? '' : 's'}</button>
        <p class="hint">Each email is in the household’s language and has their personal link.</p>`;
      $('#send-rem').addEventListener('click', async () => {
        if (!confirm(`Send a reminder email to ${p.count} household${p.count === 1 ? '' : 's'} now?`)) return;
        $('#send-rem').disabled = true;
        const r = await api('/reminders', { method: 'POST', body: {} });
        toast(`${r.sent} sent${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
        if (r.failed.length) box.insertAdjacentHTML('beforeend', `<p class="notice">Could not send to: ${esc(r.failed.join('; '))}</p>`);
      });
    } catch {
      box.innerHTML = '<p class="error">Could not check reminders.</p>';
    }
  }

  // ---------- Settings ----------

  function renderSettings() {
    const s = state.data.settings;
    main.innerHTML = `<h2>Settings</h2>
      <div class="grid">
        <div class="card"><h3>RSVP closing</h3>
          <label class="f" for="s-deadline">Last day to reply</label><input id="s-deadline" type="date" value="${esc(s.rsvp_deadline)}">
          <p class="hint">Replies close automatically at the end of this day (UK time). The date printed on the site says 31 May 2027; tell Claude if you move it, so the wording is changed too.</p>
          <label class="f" style="display:flex;gap:8px;align-items:center;margin-top:16px"><input type="checkbox" id="s-locked" ${s.rsvp_locked === 'yes' ? 'checked' : ''}> Lock RSVPs now</label>
          <p class="hint">When locked, guests can still see the site and their reply, but cannot change it.</p>
          <p class="error" id="s1-err" role="alert"></p><button class="btn rasp" id="s1-save">Save</button></div>
        <div class="card"><h3>WhatsApp invitation message</h3>
          <label class="f" for="s-en">English</label><textarea id="s-en">${esc(s.wa_en)}</textarea>
          <label class="f" for="s-es">Spanish</label><textarea id="s-es">${esc(s.wa_es)}</textarea>
          <p class="hint">{names} becomes the guests’ names and {link} becomes their personal link. Keep {link} in both.</p>
          <p class="error" id="s2-err" role="alert"></p><button class="btn rasp" id="s2-save">Save</button></div>
      </div>
      <div class="card"><h3>Logins</h3><p style="margin:0">${state.accounts.map((a) => `${esc(a.name)} (${esc(a.email)}): ${a.ready ? 'password set' : 'not set up yet'}`).join('<br>')}</p></div>`;
    $('#s1-save').addEventListener('click', async () => {
      try {
        await api('/settings', { method: 'POST', body: { rsvp_deadline: $('#s-deadline').value, rsvp_locked: $('#s-locked').checked ? 'yes' : 'no' } });
        toast('Saved');
        await reload();
      } catch {
        $('#s1-err').textContent = 'Choose a valid date.';
      }
    });
    $('#s2-save').addEventListener('click', async () => {
      try {
        await api('/settings', { method: 'POST', body: { wa_en: $('#s-en').value, wa_es: $('#s-es').value } });
        toast('Saved');
        await reload();
      } catch (ex) {
        $('#s2-err').textContent = ex.message === 'link_placeholder_missing' ? 'Both messages must contain {link}.' : 'Could not save.';
      }
    });
  }

  // ---------- Start ----------

  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    state.me = null;
    await start();
  });

  async function start() {
    const r = await fetch('/admin/api/me', { credentials: 'same-origin' }).then((x) => x.json());
    state.me = r.me;
    state.accounts = r.accounts;
    if (!state.me) return renderLogin();
    $('#who').textContent = 'Logged in as ' + state.me.name;
    $('#logout').hidden = false;
    await reload();
  }
  start().catch(() => (main.innerHTML = '<p class="error">Could not load the admin page. Refresh to try again.</p>'));
})();
