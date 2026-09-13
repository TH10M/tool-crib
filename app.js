/* ---------------- Config ---------------- */
const SUPABASE_URL = 'https://ivbngscbwesdxcsiczhk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2Ym5nc2Nid2VzZHhjc2ljemhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxODE1NTAsImV4cCI6MjEwNDc1NzU1MH0.PTfshYaFV3sBuzNelJcCM-XDM_mNdYtAya8NG94BwWw';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------- State ---------------- */
let currentUser = null;   // {id, name, role}
let sessionToken = null;  // issued by the database at login; required for every data call
let peopleList = [];
let selectedPersonName = null;
let pinBuffer = '';
let peopleDeleteArmed = new Set();
let tools = [];
let logbook = [];
let activeToolId = null;
let resetArmed = false;
let deleteArmed = new Set();
let pollHandle = null;
let shelfUnits = [];   // [{id, label, sortOrder, levels:[{level,slots}]}]
let editToolId = null; // tool currently open in the admin edit modal

function todayIso(){ return new Date().toISOString().slice(0,10); }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
function money(n){ return n===null || n===undefined ? '' : Number(n).toLocaleString(undefined,{style:'currency',currency:'USD'}); }

/* ---------------- DB <-> app mapping (tools come back from list_tools RPC) ---------------- */
function fromDbTool(r){
  const t = { id:r.id, name:r.name, tag:r.tag||'', side:r.side, level:r.level, slot:r.slot, status:r.status,
              description:r.description||'', price:r.price, acquiredDate:r.acquired_date||'', photoUrl:r.photo_url||'' };
  if(r.checked_out_by) t.checkedOutBy = r.checked_out_by;
  if(r.checked_out_date) t.checkedOutDate = r.checked_out_date;
  if(r.expected_return) t.expectedReturn = r.expected_return;
  return t;
}
function fromDbLog(r){
  return { id:r.id, toolId:r.tool_id, toolName:r.tool_name, action:r.action, user:r.user_name,
           timestamp:r.logged_at, expectedReturn:r.expected_return||'' };
}
function groupShelfLayout(rows){
  const map = new Map();
  (rows||[]).forEach(r=>{
    if(!map.has(r.unit_id)) map.set(r.unit_id, { id:r.unit_id, label:r.unit_label, sortOrder:r.sort_order, levels:[] });
    if(r.level !== null && r.level !== undefined){
      map.get(r.unit_id).levels.push({ level:r.level, slots:r.slots });
    }
  });
  return Array.from(map.values()).sort((a,b)=>a.sortOrder-b.sortOrder);
}
function getLastBorrowed(toolId){
  const entries = logbook.filter(l=>l.toolId===toolId).slice().sort((a,b)=> new Date(b.timestamp) - new Date(a.timestamp));
  const lastCheckout = entries.find(e=>e.action==='checkout');
  if(!lastCheckout) return null;
  const returnedEntry = entries.find(e=>e.action==='checkin' && new Date(e.timestamp) > new Date(lastCheckout.timestamp));
  const timesBorrowed = entries.filter(e=>e.action==='checkout').length;
  return {
    user: lastCheckout.user,
    checkoutDate: lastCheckout.timestamp,
    returnedDate: returnedEntry ? returnedEntry.timestamp : null,
    timesBorrowed
  };
}

/* ---------------- Remote data (all gated by sessionToken) ---------------- */
async function loadData(){
  const [{ data: toolRows }, { data: logRows }, { data: layoutRows }] = await Promise.all([
    supabaseClient.rpc('list_tools', { p_token: sessionToken }),
    supabaseClient.rpc('list_logbook', { p_token: sessionToken }),
    supabaseClient.rpc('list_shelf_layout', { p_token: sessionToken })
  ]);
  tools = (toolRows || []).map(fromDbTool);
  logbook = (logRows || []).map(fromDbLog);
  shelfUnits = groupShelfLayout(layoutRows);
  populateAddSideOptions();
}

async function refreshAll(){
  if(!currentUser) return;
  await loadData();
  renderShelves();
  const activeView = document.querySelector('.view.active').id;
  if(activeView === 'view-logbook') renderLogbook();
  if(activeView === 'view-admin'){ renderAdmin(); await loadPeopleAdmin(); }
}

/* ---------------- Login (name grid + PIN, verified in the database) ---------------- */
async function initLogin(){
  const { data } = await supabaseClient.rpc('list_people');
  peopleList = data || [];
  renderPeopleGrid();
}

function renderPeopleGrid(){
  const grid = document.getElementById('people-grid');
  const errEl = document.getElementById('people-err');
  grid.innerHTML = ''; errEl.textContent = '';
  if(!peopleList || peopleList.length===0){
    errEl.textContent = 'No one is set up yet — run the SQL setup script in Supabase to add the first admin.';
    return;
  }
  peopleList.forEach(p=>{
    const el = document.createElement('div');
    el.className = 'person-btn';
    el.textContent = p.name;
    el.onclick = () => selectPerson(p.name);
    grid.appendChild(el);
  });
}

function selectPerson(name){
  selectedPersonName = name; pinBuffer = '';
  document.getElementById('login-step-1').style.display = 'none';
  document.getElementById('login-step-2').style.display = 'block';
  document.getElementById('pin-person-name').textContent = name;
  document.getElementById('login-err').textContent = '';
  updatePinDots();
}
function backToNames(){
  document.getElementById('login-step-1').style.display = 'block';
  document.getElementById('login-step-2').style.display = 'none';
  pinBuffer = ''; selectedPersonName = null;
}
function updatePinDots(){
  document.querySelectorAll('#pin-dots .pin-dot').forEach((d,i)=> d.classList.toggle('filled', i < pinBuffer.length));
}
function pinPress(d){
  if(pinBuffer.length >= 4) return;
  pinBuffer += d;
  updatePinDots();
  if(pinBuffer.length === 4) submitPin();
}
function pinBackspace(){ pinBuffer = pinBuffer.slice(0,-1); updatePinDots(); }

async function submitPin(){
  const errEl = document.getElementById('login-err');
  errEl.textContent = '';
  const { data, error } = await supabaseClient.rpc('login', { p_name: selectedPersonName, p_pin: pinBuffer });
  if(error || !data || data.length===0){
    errEl.textContent = 'Incorrect PIN. Try again.';
    pinBuffer = ''; updatePinDots();
    return;
  }
  const session = data[0];
  sessionToken = session.token;
  currentUser = { name: session.name, role: session.role };
  await enterApp();
}

async function enterApp(){
  await loadData();
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-app').style.display = 'block';
  document.getElementById('hdr-username').textContent = currentUser.name;
  document.getElementById('hdr-role').textContent = currentUser.role === 'admin' ? 'ADMIN' : 'FIELD';
  document.getElementById('hdr-role').classList.toggle('admin', currentUser.role==='admin');
  document.getElementById('tab-admin').style.display = currentUser.role==='admin' ? 'block' : 'none';
  renderShelves();
  renderLogbook();
  if(currentUser.role==='admin'){ renderAdmin(); await loadPeopleAdmin(); }

  if(pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(()=>{ if(!document.getElementById('overlay').classList.contains('active')) refreshAll(); }, 15000);
}

async function logout(){
  if(sessionToken){ supabaseClient.rpc('logout', { p_token: sessionToken }); }
  currentUser = null; sessionToken = null;
  if(pollHandle) clearInterval(pollHandle);
  document.getElementById('screen-app').style.display = 'none';
  document.getElementById('screen-login').style.display = 'flex';
  backToNames();
  initLogin();
  switchTab('map');
}

/* ---------------- Tabs ---------------- */
function switchTab(view){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view===view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  if(view==='logbook') renderLogbook();
  if(view==='admin'){ renderAdmin(); loadPeopleAdmin(); }
}

/* ---------------- Shelf map ---------------- */
function isOverdue(tool){
  return tool.status==='checked_out' && tool.expectedReturn && tool.expectedReturn < todayIso();
}
function renderShelves(){
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const container = document.getElementById('shelves-container');
  container.innerHTML = '';
  if(!shelfUnits.length){
    container.innerHTML = '<div class="empty-note">No shelves set up yet. An admin can add one in the Admin tab → Shelf Layout.</div>';
    return;
  }
  shelfUnits.forEach(unit=>{
    const wrap = document.createElement('div');
    const labelEl = document.createElement('div');
    labelEl.className = 'shelf-unit-label';
    labelEl.textContent = (unit.label || unit.id).toUpperCase() + ' — UNIT ' + unit.id;
    wrap.appendChild(labelEl);
    const body = document.createElement('div');
    wrap.appendChild(body);
    container.appendChild(wrap);
    renderShelfUnitBody(body, unit, q);
  });
}
function renderShelfUnitBody(body, unit, q){
  body.innerHTML = '';
  const levels = unit.levels.slice().sort((a,b)=>b.level-a.level);
  if(!levels.length){
    body.innerHTML = '<div class="empty-note" style="padding:16px 0;">No levels on this shelf yet.</div>';
    return;
  }
  levels.forEach(lv=>{
    const row = document.createElement('div');
    row.className = 'level-row';
    const label = document.createElement('div');
    label.className = 'level-label';
    label.textContent = 'LEVEL ' + lv.level;
    row.appendChild(label);
    const slotRow = document.createElement('div');
    slotRow.className = 'slot-row';
    slotRow.style.setProperty('--slot-count', lv.slots);
    for(let slot=1; slot<=lv.slots; slot++){
      const tool = tools.find(t => t.side===unit.id && t.level===lv.level && t.slot===slot);
      slotRow.appendChild(buildSlotEl(unit.id, lv.level, slot, tool, q));
    }
    row.appendChild(slotRow);
    body.appendChild(row);
  });
}
function buildSlotEl(side, level, slot, tool, q){
  const el = document.createElement('div');
  el.className = 'slot';
  const code = side + level + '-' + slot;
  if(!tool){
    el.classList.add('slotstate-empty');
    el.innerHTML = '<div class="slot-code">'+code+'</div><div class="slot-status"><span class="dot empty"></span></div>';
    if(q) el.classList.add('dimmed');
    return el;
  }
  el.classList.add('filled');
  const matches = q && (tool.name.toLowerCase().includes(q) || (tool.tag||'').toLowerCase().includes(q));
  if(q && matches) el.classList.add('match');
  else if(q && !matches) el.classList.add('dimmed');

  let dotClass = 'ok', label = 'Available';
  if(tool.status==='checked_out'){
    dotClass = isOverdue(tool) ? 'overdue' : 'out';
    label = isOverdue(tool) ? 'Overdue' : 'Checked out';
  }
  el.classList.add('slotstate-'+dotClass);
  el.innerHTML = `
    <div class="slot-code">${code}${tool.tag ? ' · '+tool.tag : ''}</div>
    <div class="slot-name">${escapeHtml(tool.name)}</div>
    <div class="slot-status"><span class="dot ${dotClass}"></span><span style="font-size:9.5px;color:var(--text-dim);">${label}</span></div>
  `;
  el.onclick = () => openTool(tool.id);
  return el;
}

/* ---------------- Add-tool shelf/level dropdowns (dynamic, from shelfUnits) ---------------- */
function populateAddSideOptions(){
  const sel = document.getElementById('add-side');
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = shelfUnits.map(u=>`<option value="${escapeHtml(u.id)}">${escapeHtml(u.label||u.id)}</option>`).join('');
  if(shelfUnits.some(u=>u.id===prev)) sel.value = prev;
  populateAddLevelOptions();
}
function populateAddLevelOptions(){
  const sideSel = document.getElementById('add-side');
  const levelSel = document.getElementById('add-level');
  if(!sideSel || !levelSel) return;
  const unit = shelfUnits.find(u=>u.id===sideSel.value);
  const levels = unit ? unit.levels.slice().sort((a,b)=>b.level-a.level) : [];
  levelSel.innerHTML = levels.map(lv=>`<option value="${lv.level}">${lv.level} (${lv.slots} slots)</option>`).join('');
}

/* ---------------- Tool modal ---------------- */
function openTool(id){ activeToolId = id; renderModal(); document.getElementById('overlay').classList.add('active'); }
function closeModal(){ document.getElementById('overlay').classList.remove('active'); activeToolId = null; }

function renderModal(){
  const tool = tools.find(t => t.id===activeToolId);
  if(!tool) return;
  const modal = document.getElementById('modal-body');
  const code = tool.side + tool.level + '-' + tool.slot;
  const overdue = isOverdue(tool);

  let statusHtml, actionHtml = '';
  const canCheckIn = currentUser.role==='admin' || tool.checkedOutBy===currentUser.name;
  if(tool.status === 'available'){
    statusHtml = '<span class="status-pill ok">Available</span>';
    actionHtml = `
      <div class="field"><label>Expected return date</label><input class="small-input" id="return-date" type="date" min="${todayIso()}"></div>
      <button class="btn btn-primary btn-full" onclick="doCheckout()">Check out to ${escapeHtml(currentUser.name)}</button>
      <div class="msg error" id="modal-msg"></div>
    `;
  } else {
    statusHtml = overdue ? '<span class="status-pill overdue">Overdue</span>' : '<span class="status-pill out">Checked out</span>';
    actionHtml = canCheckIn
      ? `<button class="btn btn-primary btn-full" onclick="doCheckin()">Check in</button>`
      : `<div class="modal-note">Held by ${escapeHtml(tool.checkedOutBy)}. Ask them or an admin to check it in.</div>`;
  }

  const extendHtml = (tool.status==='checked_out' && canCheckIn) ? `
    <div class="extend-block">
      <div class="extend-block-label">Need more time?</div>
      <div class="field"><label>New expected return date</label><input class="small-input" id="extend-date" type="date" min="${tool.expectedReturn || todayIso()}" value="${tool.expectedReturn||''}"></div>
      <button class="btn btn-full" onclick="doExtend()">Extend reservation</button>
      <div class="msg error" id="extend-msg"></div>
    </div>
  ` : '';

  const adminExtras = currentUser.role==='admin' ? `
    ${tool.price!==null && tool.price!==undefined ? `<div class="modal-row"><span>Price</span><span>${money(tool.price)}</span></div>` : ''}
    ${tool.acquiredDate ? `<div class="modal-row"><span>Acquired</span><span>${tool.acquiredDate}</span></div>` : ''}
  ` : '';

  const lastBorrowed = getLastBorrowed(tool.id);
  let lastBorrowedHtml = '';
  if(lastBorrowed){
    const checkoutWhen = new Date(lastBorrowed.checkoutDate);
    const checkoutStr = isNaN(checkoutWhen) ? lastBorrowed.checkoutDate : checkoutWhen.toLocaleDateString();
    let line;
    if(tool.status === 'checked_out'){
      line = `Currently with <strong>${escapeHtml(lastBorrowed.user)}</strong> since ${checkoutStr}.`;
    } else if(lastBorrowed.returnedDate){
      const returnedWhen = new Date(lastBorrowed.returnedDate);
      const returnedStr = isNaN(returnedWhen) ? lastBorrowed.returnedDate : returnedWhen.toLocaleDateString();
      line = `Last borrowed by <strong>${escapeHtml(lastBorrowed.user)}</strong> (${checkoutStr}), returned ${returnedStr}.`;
    } else {
      line = `Last borrowed by <strong>${escapeHtml(lastBorrowed.user)}</strong> on ${checkoutStr}.`;
    }
    lastBorrowedHtml = `<div class="last-borrowed">${line}${lastBorrowed.timesBorrowed>1 ? ` · Borrowed ${lastBorrowed.timesBorrowed} times total.` : ''}</div>`;
  }

  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">${code}${tool.tag ? ' · '+tool.tag : ' · general tool'}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${tool.photoUrl ? `<img class="tool-photo" src="${escapeHtml(tool.photoUrl)}" alt="${escapeHtml(tool.name)}">` : ''}
    <div class="modal-title">${escapeHtml(tool.name)}</div>
    ${tool.description ? `<div class="modal-note" style="margin-top:-8px;margin-bottom:12px;">${escapeHtml(tool.description)}</div>` : ''}
    <div class="modal-row"><span>Status</span><span>${statusHtml}</span></div>
    <div class="modal-row"><span>Shelf location</span><span>Shelf ${tool.side}, level ${tool.level}, slot ${tool.slot}</span></div>
    ${tool.status==='checked_out' ? `
      <div class="modal-row"><span>Checked out by</span><span>${escapeHtml(tool.checkedOutBy)}</span></div>
      <div class="modal-row"><span>Checked out on</span><span>${tool.checkedOutDate}</span></div>
      <div class="modal-row"><span>Expected return</span><span>${tool.expectedReturn || '—'}</span></div>
    ` : ''}
    ${adminExtras}
    <div class="modal-actions">${actionHtml}</div>
    ${extendHtml}
    ${lastBorrowedHtml}
  `;
}

async function doExtend(){
  const dateInput = document.getElementById('extend-date');
  const msg = document.getElementById('extend-msg');
  if(!dateInput.value){ msg.textContent = 'Set a new expected return date.'; return; }
  const { error } = await supabaseClient.rpc('extend_checkout', { p_token: sessionToken, p_tool_id: activeToolId, p_new_expected_return: dateInput.value });
  if(error){ msg.textContent = 'Could not extend — please refresh and try again.'; return; }
  await loadData();
  renderShelves();
  renderModal();
}

async function doCheckout(){
  const dateInput = document.getElementById('return-date');
  const msg = document.getElementById('modal-msg');
  if(!dateInput.value){ msg.textContent = 'Set an expected return date.'; return; }
  const { error } = await supabaseClient.rpc('checkout_tool', { p_token: sessionToken, p_tool_id: activeToolId, p_expected_return: dateInput.value });
  if(error){ msg.textContent = 'Could not check out — someone may have just taken it. Refreshing…'; await refreshAll(); return; }
  await loadData();
  renderShelves();
  closeModal();
}

async function doCheckin(){
  const { error } = await supabaseClient.rpc('checkin_tool', { p_token: sessionToken, p_tool_id: activeToolId });
  if(error){ await refreshAll(); closeModal(); return; }
  await loadData();
  renderShelves();
  closeModal();
}

/* ---------------- Logbook ---------------- */
function renderLogbook(){
  const body = document.getElementById('logbook-body');
  body.innerHTML = '';
  document.getElementById('logbook-empty').style.display = logbook.length ? 'none' : 'block';
  logbook.forEach(entry => {
    const tr = document.createElement('tr');
    const when = new Date(entry.timestamp);
    const whenStr = isNaN(when) ? entry.timestamp : when.toLocaleString();
    const actionLabels = { checkout:'CHECK OUT', checkin:'CHECK IN', extend:'EXTENDED' };
    tr.innerHTML = `
      <td>${whenStr}</td>
      <td>${escapeHtml(entry.toolName)}</td>
      <td><span class="action-tag ${entry.action}">${actionLabels[entry.action] || entry.action.toUpperCase()}</span></td>
      <td>${escapeHtml(entry.user)}</td>
      <td>${entry.expectedReturn || '—'}</td>
    `;
    body.appendChild(tr);
  });
}

/* ---------------- Admin: tools ---------------- */
function renderAdmin(){
  renderShelfLayoutAdmin();
  document.getElementById('inv-count').textContent = tools.length;
  const body = document.getElementById('admin-body');
  body.innerHTML = '';
  tools.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(tool => {
    const tr = document.createElement('tr');
    const code = tool.side + tool.level + '-' + tool.slot;
    const statusLabel = tool.status==='available' ? 'Available' : ('Out — ' + tool.checkedOutBy);
    const armed = deleteArmed.has(tool.id);
    tr.innerHTML = `
      <td>${escapeHtml(tool.name)}</td>
      <td>${tool.tag || '—'}</td>
      <td>${code}</td>
      <td>${statusLabel}</td>
      <td>${money(tool.price) || '—'}</td>
      <td>${tool.acquiredDate || '—'}</td>
      <td class="admin-row-actions">
        <button class="btn btn-sm" onclick="openEditTool('${tool.id}')">Edit</button>
        <button class="btn btn-sm" onclick="editLocation('${tool.id}')">Move</button>
        <button class="btn btn-sm btn-danger" onclick="${armed ? `deleteToolConfirm('${tool.id}')` : `armDelete('${tool.id}')`}">${armed ? 'Confirm delete?' : 'Delete'}</button>
      </td>
    `;
    body.appendChild(tr);
  });
}
function armDelete(id){
  deleteArmed.add(id); renderAdmin();
  setTimeout(()=>{ deleteArmed.delete(id); renderAdmin(); }, 4000);
}
async function deleteToolConfirm(id){
  deleteArmed.delete(id);
  await supabaseClient.rpc('admin_delete_tool', { p_token: sessionToken, p_tool_id: id });
  await loadData();
  renderAdmin(); renderShelves();
}
async function editLocation(id){
  const tool = tools.find(t=>t.id===id);
  const newSide = prompt('Shelf side (L or R):', tool.side);
  if(newSide===null) return;
  const newLevel = prompt('Level (1-4):', tool.level);
  if(newLevel===null) return;
  const newSlot = prompt('Slot (1-6):', tool.slot);
  if(newSlot===null) return;
  const side = newSide.trim().toUpperCase();
  const level = parseInt(newLevel,10), slot = parseInt(newSlot,10);
  if(!['L','R'].includes(side) || ![1,2,3,4].includes(level) || slot<1 || slot>6) return;
  const occupied = tools.find(t=>t.id!==id && t.side===side && t.level===level && t.slot===slot);
  if(occupied) return;
  await supabaseClient.rpc('admin_move_tool', { p_token: sessionToken, p_tool_id: id, p_side: side, p_level: level, p_slot: slot });
  await loadData();
  renderAdmin(); renderShelves();
}
async function adminAddTool(){
  const name = document.getElementById('add-name').value.trim();
  const tag = document.getElementById('add-tag').value.trim();
  const side = document.getElementById('add-side').value;
  const level = parseInt(document.getElementById('add-level').value,10);
  const slot = parseInt(document.getElementById('add-slot').value,10);
  const description = document.getElementById('add-description').value.trim();
  const priceRaw = document.getElementById('add-price').value.trim();
  const price = priceRaw === '' ? null : parseFloat(priceRaw);
  const acquired = document.getElementById('add-acquired').value;
  const photoUrl = document.getElementById('add-photo').value.trim();
  const msg = document.getElementById('add-msg');
  msg.className = 'msg error';
  if(!name){ msg.textContent = 'Tool name is required.'; return; }
  if(!side || !level){ msg.textContent = 'Set up a shelf and level first (Shelf Layout section above).'; return; }
  const unit = shelfUnits.find(u=>u.id===side);
  const lvInfo = unit && unit.levels.find(l=>l.level===level);
  const maxSlots = lvInfo ? lvInfo.slots : 0;
  if(!slot || slot<1 || slot>maxSlots){ msg.textContent = `Slot must be between 1 and ${maxSlots} for that level.`; return; }
  const occupied = tools.find(t=>t.side===side && t.level===level && t.slot===slot);
  if(occupied){ msg.textContent = `Slot ${side}${level}-${slot} is already used by "${occupied.name}".`; return; }
  const { error } = await supabaseClient.rpc('admin_add_tool', {
    p_token: sessionToken, p_name: name, p_tag: tag, p_side: side, p_level: level, p_slot: slot,
    p_description: description, p_price: price, p_acquired_date: acquired, p_photo_url: photoUrl
  });
  if(error){ msg.textContent = 'Could not add tool.'; return; }
  msg.className = 'msg success';
  msg.textContent = `Added "${name}" at ${side}${level}-${slot}.`;
  ['add-name','add-tag','add-slot','add-description','add-price','add-acquired','add-photo'].forEach(id=>document.getElementById(id).value='');
  await loadData();
  renderAdmin(); renderShelves();
}
function confirmReset(){
  const btn = document.getElementById('reset-btn');
  if(!resetArmed){
    resetArmed = true;
    btn.textContent = 'Click again to confirm reset';
    setTimeout(()=>{ resetArmed=false; btn.textContent='Reset demo data'; }, 4000);
    return;
  }
  resetArmed = false;
  btn.textContent = 'Reset demo data';
  doReset();
}
async function doReset(){
  await supabaseClient.rpc('admin_reset_demo', { p_token: sessionToken });
  await loadData();
  renderAdmin(); renderShelves(); renderLogbook();
}

/* ---------------- Admin: edit tool (name/tag/description/price/date/photo) ---------------- */
function openEditTool(id){
  editToolId = id;
  renderEditModal();
  document.getElementById('edit-overlay').classList.add('active');
}
function closeEditModal(){
  document.getElementById('edit-overlay').classList.remove('active');
  editToolId = null;
}
function renderEditModal(){
  const tool = tools.find(t=>t.id===editToolId);
  if(!tool) return;
  const modal = document.getElementById('edit-modal-body');
  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">Editing · ${tool.side}${tool.level}-${tool.slot}</div>
      <button class="modal-close" onclick="closeEditModal()">✕</button>
    </div>
    <div class="modal-title">Edit tool</div>
    <div class="field"><label>Name</label><input class="small-input" id="edit-name" type="text" value="${escapeHtml(tool.name)}"></div>
    <div class="field"><label>Tag #</label><input class="small-input" id="edit-tag" type="text" value="${escapeHtml(tool.tag)}"></div>
    <div class="field"><label>Description</label><input class="small-input" id="edit-description" type="text" value="${escapeHtml(tool.description)}"></div>
    <div class="field"><label>Price</label><input class="small-input" id="edit-price" type="number" step="0.01" value="${tool.price!==null && tool.price!==undefined ? tool.price : ''}"></div>
    <div class="field"><label>Acquired date</label><input class="small-input" id="edit-acquired" type="date" value="${tool.acquiredDate||''}"></div>
    <div class="field"><label>Photo URL</label><input class="small-input" id="edit-photo" type="text" value="${escapeHtml(tool.photoUrl)}" placeholder="https://…"></div>
    ${tool.photoUrl ? `<img class="tool-photo" src="${escapeHtml(tool.photoUrl)}" alt="">` : ''}
    <div class="msg error" id="edit-msg"></div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-full" onclick="adminUpdateTool()">Save changes</button>
    </div>
  `;
}
async function adminUpdateTool(){
  const name = document.getElementById('edit-name').value.trim();
  const tag = document.getElementById('edit-tag').value.trim();
  const description = document.getElementById('edit-description').value.trim();
  const priceRaw = document.getElementById('edit-price').value.trim();
  const price = priceRaw === '' ? null : parseFloat(priceRaw);
  const acquired = document.getElementById('edit-acquired').value;
  const photoUrl = document.getElementById('edit-photo').value.trim();
  const msg = document.getElementById('edit-msg');
  if(!name){ msg.textContent = 'Tool name is required.'; return; }
  const { error } = await supabaseClient.rpc('admin_update_tool', {
    p_token: sessionToken, p_tool_id: editToolId, p_name: name, p_tag: tag,
    p_description: description, p_price: price, p_acquired_date: acquired, p_photo_url: photoUrl
  });
  if(error){ msg.textContent = 'Could not save changes.'; return; }
  await loadData();
  renderAdmin(); renderShelves();
  closeEditModal();
}

/* ---------------- Admin: shelf layout ---------------- */
function renderShelfLayoutAdmin(){
  const body = document.getElementById('shelf-layout-body');
  if(!body) return;
  if(!shelfUnits.length){
    body.innerHTML = '<div class="empty-note">No shelves yet — add one above.</div>';
    return;
  }
  body.innerHTML = shelfUnits.map(unit=>{
    const levels = unit.levels.slice().sort((a,b)=>b.level-a.level);
    const rows = levels.map(lv=>`
      <tr>
        <td>Level ${lv.level}</td>
        <td>${lv.slots} slots</td>
        <td class="admin-row-actions">
          <button class="btn btn-sm" onclick="editShelfLevelSlots('${escapeHtml(unit.id)}', ${lv.level}, ${lv.slots})">Edit slots</button>
          <button class="btn btn-sm btn-danger" onclick="deleteShelfLevel('${escapeHtml(unit.id)}', ${lv.level})">Delete</button>
        </td>
      </tr>
    `).join('');
    return `
      <div class="shelf-unit-card">
        <div class="shelf-unit-card-top">
          <strong>${escapeHtml(unit.label||unit.id)} (${escapeHtml(unit.id)})</strong>
          <button class="btn btn-sm btn-danger" onclick="deleteShelfUnit('${escapeHtml(unit.id)}')">Delete shelf</button>
        </div>
        <div class="table-scroll">
        <table>
          <thead><tr><th>Level</th><th>Slots</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" style="color:var(--text-dim);">No levels yet.</td></tr>'}</tbody>
        </table>
        </div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr auto; margin-top:10px;">
          <div class="field"><label>New level #</label><input class="small-input" id="new-level-num-${escapeHtml(unit.id)}" type="number" min="1"></div>
          <div class="field"><label>Slots</label><input class="small-input" id="new-level-slots-${escapeHtml(unit.id)}" type="number" min="1" value="6"></div>
          <button class="btn btn-sm" onclick="adminAddShelfLevel('${escapeHtml(unit.id)}')">Add level</button>
        </div>
      </div>
    `;
  }).join('');
}
async function adminAddShelfUnit(){
  const id = document.getElementById('add-unit-id').value.trim().toUpperCase();
  const label = document.getElementById('add-unit-label').value.trim();
  const msg = document.getElementById('add-unit-msg');
  msg.className = 'msg error';
  if(!id){ msg.textContent = 'Shelf ID is required.'; return; }
  if(shelfUnits.some(u=>u.id===id)){ msg.textContent = `Shelf ID "${id}" is already used.`; return; }
  const { error } = await supabaseClient.rpc('admin_add_shelf_unit', { p_token: sessionToken, p_unit_id: id, p_label: label || id });
  if(error){ msg.textContent = 'Could not add shelf.'; return; }
  msg.className = 'msg success';
  msg.textContent = `Added shelf "${label || id}".`;
  document.getElementById('add-unit-id').value = '';
  document.getElementById('add-unit-label').value = '';
  await loadData();
  renderShelfLayoutAdmin(); renderShelves();
}
async function adminAddShelfLevel(unitId){
  const num = parseInt(document.getElementById('new-level-num-'+unitId).value, 10);
  const slots = parseInt(document.getElementById('new-level-slots-'+unitId).value, 10);
  if(!num || num<1 || !slots || slots<1){ alert('Enter a valid level number and slot count.'); return; }
  await supabaseClient.rpc('admin_set_shelf_level', { p_token: sessionToken, p_unit_id: unitId, p_level: num, p_slots: slots });
  await loadData();
  renderShelfLayoutAdmin(); renderShelves();
}
async function editShelfLevelSlots(unitId, level, currentSlots){
  const val = prompt(`Slots on ${unitId} level ${level}:`, currentSlots);
  if(val === null) return;
  const slots = parseInt(val, 10);
  if(!slots || slots<1) return;
  await supabaseClient.rpc('admin_set_shelf_level', { p_token: sessionToken, p_unit_id: unitId, p_level: level, p_slots: slots });
  await loadData();
  renderShelfLayoutAdmin(); renderShelves();
}
async function deleteShelfLevel(unitId, level){
  if(!confirm(`Delete level ${level} on shelf ${unitId}? This only works if no tools are on it.`)) return;
  const { error } = await supabaseClient.rpc('admin_delete_shelf_level', { p_token: sessionToken, p_unit_id: unitId, p_level: level });
  if(error){ alert('Could not delete: that level still has tools on it. Move or delete them first.'); return; }
  await loadData();
  renderShelfLayoutAdmin(); renderShelves();
}
async function deleteShelfUnit(unitId){
  if(!confirm(`Delete shelf ${unitId} entirely? This only works if no tools are on it.`)) return;
  const { error } = await supabaseClient.rpc('admin_delete_shelf_unit', { p_token: sessionToken, p_unit_id: unitId });
  if(error){ alert('Could not delete: that shelf still has tools on it. Move or delete them first.'); return; }
  await loadData();
  renderShelfLayoutAdmin(); renderShelves();
}

/* ---------------- Admin: people ---------------- */
async function loadPeopleAdmin(){
  const { data } = await supabaseClient.rpc('list_people');
  peopleList = data || [];
  renderPeopleAdmin();
}
function renderPeopleAdmin(){
  document.getElementById('people-count').textContent = peopleList.length;
  const body = document.getElementById('people-body');
  body.innerHTML = '';
  peopleList.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(p=>{
    const tr = document.createElement('tr');
    const armed = peopleDeleteArmed.has(p.id);
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${p.role==='admin' ? 'Admin' : 'Field employee'}</td>
      <td class="admin-row-actions">
        <button class="btn btn-sm" onclick="promptResetPin('${p.id}','${escapeHtml(p.name)}')">Reset PIN</button>
        <button class="btn btn-sm btn-danger" onclick="${armed ? `adminDeletePerson('${p.id}')` : `armPersonDelete('${p.id}')`}">${armed ? 'Confirm delete?' : 'Delete'}</button>
      </td>
    `;
    body.appendChild(tr);
  });
}
function armPersonDelete(id){
  peopleDeleteArmed.add(id); renderPeopleAdmin();
  setTimeout(()=>{ peopleDeleteArmed.delete(id); renderPeopleAdmin(); }, 4000);
}
async function adminAddPerson(){
  const name = document.getElementById('add-person-name').value.trim();
  const pin = document.getElementById('add-person-pin').value.trim();
  const role = document.getElementById('add-person-role').value;
  const msg = document.getElementById('add-person-msg');
  msg.className = 'msg error';
  if(!name){ msg.textContent = 'Name is required.'; return; }
  if(!/^\d{4}$/.test(pin)){ msg.textContent = 'PIN must be exactly 4 digits.'; return; }
  const { error } = await supabaseClient.rpc('admin_add_person', { p_token: sessionToken, new_name: name, new_pin: pin, new_role: role });
  if(error){
    msg.textContent = (error.message && error.message.includes('duplicate')) ? 'That name is already taken.' : 'Could not add person.';
    return;
  }
  msg.className = 'msg success';
  msg.textContent = `Added ${name} (${role==='admin' ? 'Admin' : 'Field employee'}).`;
  document.getElementById('add-person-name').value = '';
  document.getElementById('add-person-pin').value = '';
  await loadPeopleAdmin();
}
function promptResetPin(id, name){
  const newPin = prompt('New 4-digit PIN for ' + name + ':');
  if(newPin === null) return;
  if(!/^\d{4}$/.test(newPin)) return;
  supabaseClient.rpc('admin_reset_pin', { p_token: sessionToken, target_id: id, new_pin: newPin });
}
async function adminDeletePerson(id){
  peopleDeleteArmed.delete(id);
  await supabaseClient.rpc('admin_delete_person', { p_token: sessionToken, target_id: id });
  await loadPeopleAdmin();
}

/* ---------------- Init ---------------- */
initLogin();
