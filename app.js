/* ---------------- Config ---------------- */
const SUPABASE_URL = 'https://ivbngscbwesdxcsiczhk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2Ym5nc2Nid2VzZHhjc2ljemhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxODE1NTAsImV4cCI6MjEwNDc1NzU1MH0.PTfshYaFV3sBuzNelJcCM-XDM_mNdYtAya8NG94BwWw';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const CURRENCIES = ['THB','USD','SGD']; // every price is one of these; nothing else is offered anywhere

/* ---------------- State ---------------- */
let currentUser = null;   // {id, name, role}
let sessionToken = null;  // issued by the database at login; required for every data call
let peopleList = [];      // minimal shape for the login grid (list_people — public, no session)
let peopleAdminList = []; // full shape for Admin → People (list_people_admin — admin-only)
let selectedPersonName = null;
let pinBuffer = '';
let peopleDeleteArmed = new Set();
let tools = [];
let deletedTools = [];
let logbook = [];
let adminLog = [];
let activeToolId = null;
let resetArmed = false;
let deleteArmed = new Set();
let pollHandle = null;
let shelfUnits = [];   // [{id, label, sortOrder, levels:[{level,slots}]}]
let editToolId = null; // tool currently open in the admin edit modal
let editToolLocation = null; // {side,level,slot,bucketId} being edited (side null + bucketId null = unassigned)
let addToolLocation = { side:null, level:null, slot:null, bucketId:null }; // location chosen in the Add Tool form
let pickerCallback = null;   // called with {side,level,slot,bucketId} when a location is picked
let pickerExcludeId = null;  // a tool id whose own slot/bucket-membership shouldn't count as "occupied"
let pickerCurrent = null;    // {side,level,slot,bucketId} to highlight as "current"
let pickerIsBucketItself = false; // true when the item being placed is itself a bucket (can't go inside another bucket)
let adminSortKey = 'name';
let adminSortDir = 'asc';
let peopleSortKey = 'name';
let peopleSortDir = 'asc';
let editPersonId = null;
let shelfEditorUnitId = null; // unit currently open in the interactive shelf editor
let confirmPendingFn = null;  // pending action for the custom confirm modal

function todayIso(){ return new Date().toISOString().slice(0,10); }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
function money(amount, currency){
  if(amount===null || amount===undefined || amount===''){ return ''; }
  return Number(amount).toLocaleString('en-US', { style:'currency', currency: currency || 'THB' });
}
function locationCode(tool){
  if(tool.side) return `${tool.side}${tool.level}-${tool.slot}`;
  if(tool.bucketId){
    const b = tools.find(x=>x.id===tool.bucketId);
    return b ? `In: ${b.name}` : 'In a bucket';
  }
  return 'Unassigned';
}
function numberOptions(min, max, selected){
  let html = '';
  for(let i=min;i<=max;i++){ html += `<option value="${i}"${i===selected?' selected':''}>${i}</option>`; }
  return html;
}

/* ---------------- Loading state helper (used on every button that hits the database) ---------------- */
async function withLoading(btn, fn){
  if(!btn){ return await fn(); }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try{
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---------------- Custom confirm/notice modal (replaces native confirm/alert/prompt) ---------------- */
function showConfirm(title, message, confirmLabel, onConfirm, danger){
  const modal = document.getElementById('confirm-modal-body');
  modal.innerHTML = `
    <div class="modal-top"><div class="modal-tag">${escapeHtml(title||'Confirm')}</div><button class="modal-close" onclick="closeConfirmModal()">✕</button></div>
    <div class="modal-title" style="font-size:16px;">${message}</div>
    <div class="modal-actions">
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-full" onclick="confirmYes(this)">${escapeHtml(confirmLabel||'Confirm')}</button>
      <button class="btn btn-full" style="margin-top:8px;" onclick="closeConfirmModal()">Cancel</button>
    </div>
  `;
  confirmPendingFn = onConfirm;
  document.getElementById('confirm-overlay').classList.add('active');
}
function showNotice(title, message){
  const modal = document.getElementById('confirm-modal-body');
  modal.innerHTML = `
    <div class="modal-top"><div class="modal-tag">${escapeHtml(title||'Notice')}</div><button class="modal-close" onclick="closeConfirmModal()">✕</button></div>
    <div class="modal-title" style="font-size:16px;">${message}</div>
    <div class="modal-actions"><button class="btn btn-primary btn-full" onclick="closeConfirmModal()">OK</button></div>
  `;
  confirmPendingFn = null;
  document.getElementById('confirm-overlay').classList.add('active');
}
async function confirmYes(btn){
  const fn = confirmPendingFn;
  confirmPendingFn = null;
  document.getElementById('confirm-overlay').classList.remove('active');
  if(fn) await withLoading(btn, fn);
}
function closeConfirmModal(){
  document.getElementById('confirm-overlay').classList.remove('active');
  confirmPendingFn = null;
}

/* ---------------- DB <-> app mapping (tools come back from list_tools RPC) ---------------- */
function fromDbTool(r){
  const t = { id:r.id, name:r.name, tag:r.tag||'', side:r.side, level:r.level, slot:r.slot, status:r.status,
              description:r.description||'', price:r.price, currency:r.currency||'THB', acquiredDate:r.acquired_date||'',
              photoUrl:r.photo_url||'', kind:r.kind||'tool', bucketId:r.bucket_id||null };
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
}

async function loadAdminLog(){
  const { data } = await supabaseClient.rpc('list_admin_log', { p_token: sessionToken });
  adminLog = data || [];
  renderAdminLog();
}

async function loadDeletedTools(){
  const { data } = await supabaseClient.rpc('list_deleted_tools', { p_token: sessionToken });
  deletedTools = data || [];
  renderDeletedTools();
}

async function refreshAll(){
  if(!currentUser) return;
  await loadData();
  renderShelves();
  const activeView = document.querySelector('.view.active').id;
  if(activeView === 'view-logbook') renderLogbook();
  if(activeView === 'view-admin'){ renderAdmin(); await loadPeopleAdmin(); await loadAdminLog(); await loadDeletedTools(); }
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
  if(currentUser.role==='admin'){ renderAdmin(); await loadPeopleAdmin(); await loadAdminLog(); await loadDeletedTools(); }

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
  if(view==='admin'){ renderAdmin(); loadPeopleAdmin(); loadAdminLog(); loadDeletedTools(); }
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
  if(tool.kind === 'bucket'){
    el.classList.add('bucket-slot');
    const contents = tools.filter(t=>t.bucketId===tool.id);
    const outCount = contents.filter(t=>t.status==='checked_out').length;
    if(tool.status==='checked_out'){
      dotClass = isOverdue(tool) ? 'overdue' : 'out';
      label = isOverdue(tool) ? 'Overdue' : 'Checked out';
    } else if(outCount > 0){
      dotClass = 'out';
      label = `${outCount}/${contents.length} out`;
    } else {
      label = `${contents.length} inside`;
    }
  } else if(tool.status==='checked_out'){
    dotClass = isOverdue(tool) ? 'overdue' : 'out';
    label = isOverdue(tool) ? 'Overdue' : 'Checked out';
  }
  el.classList.add('slotstate-'+dotClass);
  el.title = tool.name + (tool.tag ? ' · '+tool.tag : '') + ' — ' + label;
  el.innerHTML = `
    <div class="slot-code">${code}${tool.tag ? ' · '+tool.tag : ''}</div>
    <div class="slot-name">${escapeHtml(tool.name)}</div>
    <div class="slot-status"><span class="dot ${dotClass}"></span><span style="font-size:9.5px;color:var(--text-dim);">${label}</span></div>
  `;
  el.onclick = () => openTool(tool.id);
  return el;
}

/* ---------------- Shelf location picker (used by Add Tool and Edit Tool) ---------------- */
// current: {side,level,slot,bucketId} or null. callback receives {side,level,slot,bucketId}.
function openLocationPicker(current, excludeToolId, isBucketItself, callback){
  pickerCallback = callback;
  pickerExcludeId = excludeToolId;
  pickerCurrent = current && (current.side || current.bucketId) ? current : null;
  pickerIsBucketItself = !!isBucketItself;
  renderLocationPicker();
  document.getElementById('picker-overlay').classList.add('active');
}
function closeLocationPicker(){
  document.getElementById('picker-overlay').classList.remove('active');
  pickerCallback = null; pickerExcludeId = null; pickerCurrent = null; pickerIsBucketItself = false;
}
function renderLocationPicker(){
  const modal = document.getElementById('picker-modal-body');
  const unitsHtml = shelfUnits.map(unit=>{
    const levels = unit.levels.slice().sort((a,b)=>b.level-a.level);
    if(!levels.length) return '';
    const levelsHtml = levels.map(lv=>{
      let cells = '';
      for(let slot=1; slot<=lv.slots; slot++){
        const occupant = tools.find(t=>t.side===unit.id && t.level===lv.level && t.slot===slot && t.id!==pickerExcludeId);
        const isCurrent = pickerCurrent && pickerCurrent.side===unit.id && pickerCurrent.level===lv.level && pickerCurrent.slot===slot;
        const code = unit.id+lv.level+'-'+slot;
        let cls = 'picker-slot';
        let title = code;
        if(isCurrent){ cls += ' current'; title += ' — current location'; }
        else if(occupant){ cls += ' occupied'; title += ' — occupied by ' + occupant.name; }
        else { cls += ' empty'; title += ' — empty, click to choose'; }
        const clickable = isCurrent || !occupant;
        cells += `<div class="${cls}" title="${escapeHtml(title)}"${clickable ? ` onclick="pickerChoose('${escapeHtml(unit.id)}',${lv.level},${slot})"` : ''}>${code}</div>`;
      }
      return `<div class="level-row"><div class="level-label">LEVEL ${lv.level}</div><div class="picker-slot-row" style="--slot-count:${lv.slots};">${cells}</div></div>`;
    }).join('');
    return `<div class="shelf-unit-label">${escapeHtml((unit.label||unit.id).toUpperCase())} — UNIT ${escapeHtml(unit.id)}</div>${levelsHtml}`;
  }).join('');

  const buckets = pickerIsBucketItself ? [] : tools.filter(t=>t.kind==='bucket' && t.id!==pickerExcludeId && !t.deletedAt);
  const bucketsHtml = buckets.length ? `
    <div class="picker-bucket-section">
      <div class="shelf-unit-label">OR PLACE INSIDE A BUCKET</div>
      <div class="picker-bucket-list">
        ${buckets.map(b=>{
          const isCurrent = pickerCurrent && pickerCurrent.bucketId === b.id;
          const count = tools.filter(t=>t.bucketId===b.id).length;
          return `<button class="btn btn-sm ${isCurrent ? 'btn-primary' : ''}" onclick="pickerChooseBucket('${b.id}')">🧺 ${escapeHtml(b.name)} (${count} inside)${isCurrent ? ' — current' : ''}</button>`;
        }).join('')}
      </div>
    </div>
  ` : '';

  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">Shelf location</div>
      <button class="modal-close" onclick="closeLocationPicker()">✕</button>
    </div>
    <div class="modal-title">Pick a slot</div>
    <div class="picker-legend">
      <span class="legend-item"><span class="picker-swatch empty"></span> Empty</span>
      <span class="legend-item"><span class="picker-swatch occupied"></span> Occupied</span>
      <span class="legend-item"><span class="picker-swatch current"></span> Current</span>
    </div>
    ${unitsHtml || '<div class="empty-note">No shelves set up yet — add one in Shelf Layout first.</div>'}
    ${bucketsHtml}
    <div class="modal-actions">
      <button class="btn btn-danger btn-full" onclick="pickerUnassign()">Unassign (no shelf location)</button>
      <button class="btn btn-full" style="margin-top:8px;" onclick="closeLocationPicker()">Cancel</button>
    </div>
  `;
}
function pickerChoose(side, level, slot){
  const cb = pickerCallback;
  closeLocationPicker();
  if(cb) cb({ side, level, slot, bucketId: null });
}
function pickerChooseBucket(bucketId){
  const cb = pickerCallback;
  closeLocationPicker();
  if(cb) cb({ side: null, level: null, slot: null, bucketId });
}
function pickerUnassign(){
  const cb = pickerCallback;
  closeLocationPicker();
  if(cb) cb({ side: null, level: null, slot: null, bucketId: null });
}

/* ---------------- Add Tool form: location + type display ---------------- */
function openAddLocationPicker(){
  const isBucket = document.getElementById('add-kind').value === 'bucket';
  openLocationPicker(addToolLocation, null, isBucket, (loc)=>{
    addToolLocation = loc;
    updateAddLocationDisplay();
  });
}
function updateAddLocationDisplay(){
  const el = document.getElementById('add-location-display');
  if(!el) return;
  el.textContent = locationCode({ side: addToolLocation.side, level: addToolLocation.level, slot: addToolLocation.slot, bucketId: addToolLocation.bucketId });
}
function onAddKindChange(){
  const isBucket = document.getElementById('add-kind').value === 'bucket';
  document.getElementById('add-price-field').style.display = isBucket ? 'none' : '';
  document.getElementById('add-currency-field').style.display = isBucket ? 'none' : '';
  // a bucket can't be placed inside another bucket — clear that choice if it was set
  if(isBucket && addToolLocation.bucketId){
    addToolLocation = { side:null, level:null, slot:null, bucketId:null };
    updateAddLocationDisplay();
  }
}

/* ---------------- Tool modal ---------------- */
function openTool(id){
  activeToolId = id;
  const tool = tools.find(t=>t.id===id);
  if(tool && tool.kind==='bucket'){ renderBucketModal(); } else { renderModal(); }
  document.getElementById('overlay').classList.add('active');
}
function closeModal(){ document.getElementById('overlay').classList.remove('active'); activeToolId = null; }

function renderModal(){
  const tool = tools.find(t => t.id===activeToolId);
  if(!tool) return;
  const modal = document.getElementById('modal-body');
  const code = tool.side ? (tool.side + tool.level + '-' + tool.slot) : 'Unassigned';
  const overdue = isOverdue(tool);

  let statusHtml, actionHtml = '';
  const canCheckIn = currentUser.role==='admin' || tool.checkedOutBy===currentUser.name;
  if(tool.status === 'available'){
    statusHtml = '<span class="status-pill ok">Available</span>';
    actionHtml = `
      <div class="field"><label>Expected return date</label><input class="small-input" id="return-date" type="date" min="${todayIso()}"></div>
      <button class="btn btn-primary btn-full" onclick="doCheckout(this)">Check out to ${escapeHtml(currentUser.name)}</button>
      <div class="msg error" id="modal-msg"></div>
    `;
  } else {
    statusHtml = overdue ? '<span class="status-pill overdue">Overdue</span>' : '<span class="status-pill out">Checked out</span>';
    actionHtml = canCheckIn
      ? `<button class="btn btn-primary btn-full" onclick="doCheckin(this)">Check in</button>`
      : `<div class="modal-note">Held by ${escapeHtml(tool.checkedOutBy)}. Ask them or an admin to check it in.</div>`;
  }

  const extendHtml = (tool.status==='checked_out' && canCheckIn) ? `
    <div class="extend-block">
      <div class="extend-block-label">Need more time?</div>
      <div class="field"><label>New expected return date</label><input class="small-input" id="extend-date" type="date" min="${tool.expectedReturn || todayIso()}" value="${tool.expectedReturn||''}"></div>
      <button class="btn btn-full" onclick="doExtend(this)">Extend reservation</button>
      <div class="msg error" id="extend-msg"></div>
    </div>
  ` : '';

  const adminExtras = currentUser.role==='admin' ? `
    ${tool.price!==null && tool.price!==undefined ? `<div class="modal-row"><span>Price</span><span>${money(tool.price, tool.currency)}</span></div>` : ''}
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

  const bucketNote = tool.bucketId ? `<div class="modal-note" style="margin-bottom:12px;">Stored inside bucket "${escapeHtml((tools.find(b=>b.id===tool.bucketId)||{}).name||'')}".</div>` : '';

  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">${code}${tool.tag ? ' · '+tool.tag : ' · general tool'}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${tool.photoUrl ? `<img class="tool-photo" src="${escapeHtml(tool.photoUrl)}" alt="${escapeHtml(tool.name)}">` : ''}
    <div class="modal-title">${escapeHtml(tool.name)}</div>
    ${tool.description ? `<div class="modal-note" style="margin-top:-8px;margin-bottom:12px;">${escapeHtml(tool.description)}</div>` : ''}
    ${bucketNote}
    <div class="modal-row"><span>Status</span><span>${statusHtml}</span></div>
    <div class="modal-row"><span>Shelf location</span><span>${tool.side ? `Shelf ${tool.side}, level ${tool.level}, slot ${tool.slot}` : `<span class="unassigned-tag">${escapeHtml(locationCode(tool))}</span>`}</span></div>
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

async function doExtend(btn){
  const dateInput = document.getElementById('extend-date');
  const msg = document.getElementById('extend-msg');
  if(!dateInput.value){ msg.textContent = 'Set a new expected return date.'; return; }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('extend_checkout', { p_token: sessionToken, p_tool_id: activeToolId, p_new_expected_return: dateInput.value });
    if(error){ msg.textContent = 'Could not extend — please refresh and try again.'; return; }
    await loadData();
    renderShelves();
    renderModal();
  });
}

async function doCheckout(btn){
  const dateInput = document.getElementById('return-date');
  const msg = document.getElementById('modal-msg');
  if(!dateInput.value){ msg.textContent = 'Set an expected return date.'; return; }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('checkout_tool', { p_token: sessionToken, p_tool_id: activeToolId, p_expected_return: dateInput.value });
    if(error){ msg.textContent = 'Could not check out — someone may have just taken it. Refreshing…'; await refreshAll(); return; }
    await loadData();
    renderShelves();
    closeModal();
  });
}

async function doCheckin(btn){
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('checkin_tool', { p_token: sessionToken, p_tool_id: activeToolId });
    if(error){ await refreshAll(); closeModal(); return; }
    await loadData();
    renderShelves();
    closeModal();
  });
}

/* ---------------- Bucket modal (opened instead of the normal tool modal when kind==='bucket') ---------------- */
function renderBucketModal(){
  const bucket = tools.find(t=>t.id===activeToolId);
  if(!bucket) return;
  const modal = document.getElementById('modal-body');
  const code = bucket.side ? (bucket.side + bucket.level + '-' + bucket.slot) : locationCode(bucket);
  const overdue = isOverdue(bucket);
  const canCheckIn = currentUser.role==='admin' || bucket.checkedOutBy===currentUser.name;
  const contents = tools.filter(t=>t.bucketId===bucket.id);

  let statusHtml, actionHtml;
  if(bucket.status === 'available'){
    statusHtml = '<span class="status-pill ok">Available</span>';
    actionHtml = `
      <div class="field"><label>Expected return date</label><input class="small-input" id="bucket-return-date" type="date" min="${todayIso()}"></div>
      <button class="btn btn-primary btn-full" onclick="doCheckoutBucket(this)">Check out whole bucket to ${escapeHtml(currentUser.name)}</button>
      <div class="msg error" id="bucket-modal-msg"></div>
    `;
  } else {
    statusHtml = overdue ? '<span class="status-pill overdue">Overdue</span>' : '<span class="status-pill out">Checked out</span>';
    actionHtml = canCheckIn
      ? `<button class="btn btn-primary btn-full" onclick="doCheckinBucket(this)">Check in whole bucket</button>`
      : `<div class="modal-note">Held by ${escapeHtml(bucket.checkedOutBy)}. Ask them or an admin to check it in.</div>`;
  }

  const contentsHtml = contents.length ? contents.map(t=>{
    const tOverdue = isOverdue(t);
    const pill = t.status==='available' ? '<span class="status-pill ok">Available</span>' : (tOverdue ? '<span class="status-pill overdue">Overdue</span>' : '<span class="status-pill out">Out</span>');
    const canItemCheckIn = currentUser.role==='admin' || t.checkedOutBy===currentUser.name;
    let itemAction;
    if(t.status==='available'){
      itemAction = `<input class="small-input bucket-item-date" id="bucket-item-date-${t.id}" type="date" min="${todayIso()}"><button class="btn btn-sm" onclick="doCheckoutItem('${t.id}', this)">Check out</button>`;
    } else if(canItemCheckIn){
      itemAction = `<button class="btn btn-sm" onclick="doCheckinItem('${t.id}', this)">Check in</button>`;
    } else {
      itemAction = `<span class="unassigned-tag">${escapeHtml(t.checkedOutBy)}</span>`;
    }
    return `
      <div class="bucket-item-row">
        <div class="bucket-item-info"><strong>${escapeHtml(t.name)}</strong> ${pill}</div>
        <div class="bucket-item-actions">${itemAction}</div>
      </div>
    `;
  }).join('') : '<div class="empty-note">Nothing in this bucket yet — an admin can add tools to it from the Edit screen.</div>';

  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">${escapeHtml(code)} · bucket</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${bucket.photoUrl ? `<img class="tool-photo" src="${escapeHtml(bucket.photoUrl)}" alt="${escapeHtml(bucket.name)}">` : ''}
    <div class="modal-title">🧺 ${escapeHtml(bucket.name)}</div>
    ${bucket.description ? `<div class="modal-note" style="margin-top:-8px;margin-bottom:12px;">${escapeHtml(bucket.description)}</div>` : ''}
    <div class="modal-row"><span>Status</span><span>${statusHtml}</span></div>
    <div class="modal-row"><span>Shelf location</span><span>${bucket.side ? `Shelf ${bucket.side}, level ${bucket.level}, slot ${bucket.slot}` : '<span class="unassigned-tag">Unassigned</span>'}</span></div>
    ${bucket.status==='checked_out' ? `
      <div class="modal-row"><span>Checked out by</span><span>${escapeHtml(bucket.checkedOutBy)}</span></div>
      <div class="modal-row"><span>Expected return</span><span>${bucket.expectedReturn || '—'}</span></div>
    ` : ''}
    <div class="modal-actions">${actionHtml}</div>
    <div class="bucket-contents">
      <div class="extend-block-label">Contents (${contents.length})</div>
      ${contentsHtml}
    </div>
  `;
}
async function doCheckoutBucket(btn){
  const dateInput = document.getElementById('bucket-return-date');
  const msg = document.getElementById('bucket-modal-msg');
  if(!dateInput.value){ msg.textContent = 'Set an expected return date.'; return; }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('checkout_bucket', { p_token: sessionToken, p_bucket_id: activeToolId, p_expected_return: dateInput.value });
    if(error){ msg.textContent = 'Could not check out.'; return; }
    await loadData();
    renderShelves();
    closeModal();
  });
}
async function doCheckinBucket(btn){
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('checkin_bucket', { p_token: sessionToken, p_bucket_id: activeToolId });
    await loadData();
    renderShelves();
    closeModal();
  });
}
async function doCheckoutItem(id, btn){
  const dateInput = document.getElementById('bucket-item-date-'+id);
  if(!dateInput || !dateInput.value){ showNotice('Missing date', 'Pick an expected return date first.'); return; }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('checkout_tool', { p_token: sessionToken, p_tool_id: id, p_expected_return: dateInput.value });
    if(!error){ await loadData(); renderShelves(); renderBucketModal(); }
  });
}
async function doCheckinItem(id, btn){
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('checkin_tool', { p_token: sessionToken, p_tool_id: id });
    await loadData();
    renderShelves();
    renderBucketModal();
  });
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
  renderAdminInventory();
}
function toolStatusKey(tool){
  if(tool.status==='available') return 'available';
  return isOverdue(tool) ? 'overdue' : 'checked_out';
}
function renderAdminInventory(){
  document.getElementById('inv-count').textContent = tools.length;
  const q = (document.getElementById('inv-search')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('inv-status-filter')?.value || 'all';

  let filtered = tools.filter(t=>{
    if(q){
      const hay = (t.name + ' ' + (t.tag||'') + ' ' + (t.description||'')).toLowerCase();
      if(!hay.includes(q)) return false;
    }
    if(statusFilter==='unassigned') return !t.side && !t.bucketId;
    if(statusFilter==='in_bucket') return !!t.bucketId;
    if(statusFilter!=='all' && !['unassigned','in_bucket'].includes(statusFilter) && toolStatusKey(t)!==statusFilter) return false;
    return true;
  });

  if(adminSortKey === 'price'){
    filtered.sort((a,b)=>{
      const ac = a.currency || 'THB', bc = b.currency || 'THB';
      if(ac !== bc) return adminSortDir==='asc' ? ac.localeCompare(bc) : bc.localeCompare(ac);
      const ap = (a.price===null||a.price===undefined) ? -Infinity : a.price;
      const bp = (b.price===null||b.price===undefined) ? -Infinity : b.price;
      if(ap<bp) return adminSortDir==='asc' ? -1 : 1;
      if(ap>bp) return adminSortDir==='asc' ? 1 : -1;
      return 0;
    });
  } else {
    filtered.sort((a,b)=>{
      let av, bv;
      switch(adminSortKey){
        case 'tag': av=(a.tag||'').toLowerCase(); bv=(b.tag||'').toLowerCase(); break;
        case 'location': av=locationCode(a).toLowerCase(); bv=locationCode(b).toLowerCase(); break;
        case 'status': av=toolStatusKey(a); bv=toolStatusKey(b); break;
        case 'acquired': av=a.acquiredDate||''; bv=b.acquiredDate||''; break;
        case 'name': default: av=a.name.toLowerCase(); bv=b.name.toLowerCase();
      }
      if(av<bv) return adminSortDir==='asc' ? -1 : 1;
      if(av>bv) return adminSortDir==='asc' ? 1 : -1;
      return 0;
    });
  }

  document.querySelectorAll('.sort-arrow').forEach(el=>el.textContent='');
  const activeArrow = document.getElementById('sort-arrow-'+adminSortKey);
  if(activeArrow) activeArrow.textContent = adminSortDir==='asc' ? ' ▲' : ' ▼';

  const body = document.getElementById('admin-body');
  body.innerHTML = '';
  if(!filtered.length){
    body.innerHTML = '<tr><td colspan="7" style="color:var(--text-dim);text-align:center;padding:20px;">No tools match your search/filter.</td></tr>';
    return;
  }
  filtered.forEach(tool => {
    const tr = document.createElement('tr');
    const statusLabel = tool.status==='available' ? 'Available' : (isOverdue(tool) ? 'Overdue — '+tool.checkedOutBy : 'Out — ' + tool.checkedOutBy);
    const armed = deleteArmed.has(tool.id);
    const loc = tool.side ? locationCode(tool) : `<span class="unassigned-tag">${escapeHtml(locationCode(tool))}</span>`;
    const nameLabel = (tool.kind==='bucket' ? '🧺 ' : '') + escapeHtml(tool.name);
    tr.innerHTML = `
      <td>${nameLabel}</td>
      <td>${tool.tag || '—'}</td>
      <td>${loc}</td>
      <td>${statusLabel}</td>
      <td>${money(tool.price, tool.currency) || '—'}</td>
      <td>${tool.acquiredDate || '—'}</td>
      <td class="admin-row-actions">
        <button class="btn btn-sm" onclick="openEditTool('${tool.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="${armed ? `deleteToolConfirm('${tool.id}', this)` : `armDelete('${tool.id}')`}">${armed ? 'Confirm delete?' : 'Delete'}</button>
      </td>
    `;
    body.appendChild(tr);
  });
}
function sortAdminInv(key){
  if(adminSortKey===key){ adminSortDir = adminSortDir==='asc' ? 'desc' : 'asc'; }
  else { adminSortKey = key; adminSortDir = 'asc'; }
  renderAdminInventory();
}
function armDelete(id){
  deleteArmed.add(id); renderAdminInventory();
  setTimeout(()=>{ deleteArmed.delete(id); renderAdminInventory(); }, 4000);
}
async function deleteToolConfirm(id, btn){
  deleteArmed.delete(id);
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_delete_tool', { p_token: sessionToken, p_tool_id: id });
    await loadData();
    await loadDeletedTools();
    renderAdmin(); renderShelves(); loadAdminLog();
  });
}

/* ---------------- Admin: recently deleted (soft-delete + restore) ---------------- */
function renderDeletedTools(){
  const body = document.getElementById('deleted-body');
  if(!body) return;
  body.innerHTML = '';
  const emptyEl = document.getElementById('deleted-empty');
  if(emptyEl) emptyEl.style.display = deletedTools.length ? 'none' : 'block';
  deletedTools.forEach(t=>{
    const tr = document.createElement('tr');
    const was = t.side ? `${t.side}${t.level}-${t.slot}` : '—';
    const when = new Date(t.deleted_at);
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td>${t.tag || '—'}</td>
      <td>${was}</td>
      <td>${isNaN(when) ? t.deleted_at : when.toLocaleString()}</td>
      <td><button class="btn btn-sm" onclick="restoreTool('${t.id}', this)">Restore</button></td>
    `;
    body.appendChild(tr);
  });
}
async function restoreTool(id, btn){
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_restore_tool', { p_token: sessionToken, p_tool_id: id });
    await loadData();
    await loadDeletedTools();
    renderAdmin(); renderShelves(); loadAdminLog();
  });
}

async function adminAddTool(btn){
  const name = document.getElementById('add-name').value.trim();
  const tag = document.getElementById('add-tag').value.trim();
  const kind = document.getElementById('add-kind').value;
  const description = document.getElementById('add-description').value.trim();
  const priceRaw = document.getElementById('add-price').value.trim();
  const price = priceRaw === '' ? null : parseFloat(priceRaw);
  const currency = document.getElementById('add-currency').value;
  const acquired = document.getElementById('add-acquired').value;
  const photoUrl = document.getElementById('add-photo').value.trim();
  const msg = document.getElementById('add-msg');
  msg.className = 'msg error';
  if(!name){ msg.textContent = 'Tool name is required.'; return; }
  const { side, level, slot, bucketId } = addToolLocation;
  if(side){
    const occupied = tools.find(t=>t.side===side && t.level===level && t.slot===slot);
    if(occupied){ msg.textContent = `Slot ${side}${level}-${slot} is already used by "${occupied.name}".`; return; }
  }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('admin_add_tool', {
      p_token: sessionToken, p_name: name, p_tag: tag, p_side: side, p_level: level, p_slot: slot,
      p_description: description, p_price: kind==='bucket' ? null : price, p_acquired_date: acquired,
      p_photo_url: photoUrl, p_currency: currency, p_kind: kind, p_bucket_id: bucketId
    });
    if(error){
      msg.textContent = (error.message||'').includes('occupied') ? 'That slot was just taken — choose another location.' : ('Could not add tool: ' + (error.message || 'unknown error'));
      return;
    }
    msg.className = 'msg success';
    msg.textContent = `Added "${name}"${bucketId ? ' inside the chosen bucket' : (side ? ' at '+side+level+'-'+slot : ' (unassigned)')}.`;
    ['add-name','add-tag','add-description','add-price','add-acquired','add-photo'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('add-kind').value = 'tool';
    document.getElementById('add-currency').value = 'THB';
    onAddKindChange();
    addToolLocation = { side:null, level:null, slot:null, bucketId:null };
    updateAddLocationDisplay();
    await loadData();
    renderAdmin(); renderShelves(); loadAdminLog();
  });
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
  const btn = document.getElementById('reset-btn');
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_reset_demo', { p_token: sessionToken });
    await loadData();
    await loadDeletedTools();
    renderAdmin(); renderShelves(); renderLogbook(); loadAdminLog();
  });
}

/* ---------------- Admin: edit tool (the one and only edit action — name/tag/description/price/date/photo/location) ---------------- */
function openEditTool(id){
  editToolId = id;
  const tool = tools.find(t=>t.id===id);
  editToolLocation = tool ? { side: tool.side, level: tool.level, slot: tool.slot, bucketId: tool.bucketId } : { side:null, level:null, slot:null, bucketId:null };
  renderEditModal();
  document.getElementById('edit-overlay').classList.add('active');
}
function closeEditModal(){
  document.getElementById('edit-overlay').classList.remove('active');
  editToolId = null;
  editToolLocation = null;
}
function pickEditLocation(){
  const tool = tools.find(t=>t.id===editToolId);
  openLocationPicker(editToolLocation, editToolId, tool && tool.kind==='bucket', (loc)=>{
    editToolLocation = loc;
    updateEditLocationDisplay();
  });
}
function updateEditLocationDisplay(){
  const el = document.getElementById('edit-location-display');
  if(el) el.textContent = locationCode({ side: editToolLocation.side, level: editToolLocation.level, slot: editToolLocation.slot, bucketId: editToolLocation.bucketId });
}
function renderEditModal(){
  const tool = tools.find(t=>t.id===editToolId);
  if(!tool) return;
  const modal = document.getElementById('edit-modal-body');
  const locCode = locationCode(tool);
  const isBucket = tool.kind === 'bucket';
  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">Editing · ${escapeHtml(locCode)}${isBucket ? ' · bucket' : ''}</div>
      <button class="modal-close" onclick="closeEditModal()">✕</button>
    </div>
    <div class="modal-title">Edit ${isBucket ? 'bucket' : 'tool'}</div>
    <div class="field"><label>Name</label><input class="small-input" id="edit-name" type="text" value="${escapeHtml(tool.name)}"></div>
    <div class="field"><label>Tag #</label><input class="small-input" id="edit-tag" type="text" value="${escapeHtml(tool.tag)}"></div>
    <div class="field"><label>Shelf location</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <div class="location-display" id="edit-location-display" style="flex:1;">${escapeHtml(locCode)}</div>
        <button class="btn btn-sm" onclick="pickEditLocation()">Change</button>
      </div>
    </div>
    <div class="field"><label>Description</label><input class="small-input" id="edit-description" type="text" value="${escapeHtml(tool.description)}"></div>
    ${!isBucket ? `
      <div class="form-grid" style="grid-template-columns:2fr 1fr;">
        <div class="field"><label>Price</label><input class="small-input" id="edit-price" type="number" step="0.01" value="${tool.price!==null && tool.price!==undefined ? tool.price : ''}"></div>
        <div class="field"><label>Currency</label>
          <select class="small-input" id="edit-currency">${CURRENCIES.map(c=>`<option value="${c}"${c===tool.currency?' selected':''}>${c}</option>`).join('')}</select>
        </div>
      </div>
    ` : ''}
    <div class="field"><label>Acquired date</label><input class="small-input" id="edit-acquired" type="date" value="${tool.acquiredDate||''}"></div>
    <div class="field"><label>Photo URL</label><input class="small-input" id="edit-photo" type="text" value="${escapeHtml(tool.photoUrl)}" placeholder="https://…"></div>
    ${tool.photoUrl ? `<img class="tool-photo" src="${escapeHtml(tool.photoUrl)}" alt="">` : ''}
    <div class="msg error" id="edit-msg"></div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-full" onclick="adminUpdateTool(this)">Save changes</button>
    </div>
  `;
}
async function adminUpdateTool(btn){
  const name = document.getElementById('edit-name').value.trim();
  const tag = document.getElementById('edit-tag').value.trim();
  const description = document.getElementById('edit-description').value.trim();
  const priceInput = document.getElementById('edit-price');
  const priceRaw = priceInput ? priceInput.value.trim() : '';
  const price = priceRaw === '' ? null : parseFloat(priceRaw);
  const currencyInput = document.getElementById('edit-currency');
  const currency = currencyInput ? currencyInput.value : 'THB';
  const acquired = document.getElementById('edit-acquired').value;
  const photoUrl = document.getElementById('edit-photo').value.trim();
  const msg = document.getElementById('edit-msg');
  if(!name){ msg.textContent = 'Tool name is required.'; return; }
  const { side, level, slot, bucketId } = editToolLocation;
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('admin_update_tool', {
      p_token: sessionToken, p_tool_id: editToolId, p_name: name, p_tag: tag,
      p_description: description, p_price: price, p_acquired_date: acquired, p_photo_url: photoUrl,
      p_side: side, p_level: level, p_slot: slot, p_currency: currency, p_bucket_id: bucketId
    });
    if(error){
      msg.textContent = (error.message||'').includes('occupied') ? 'That slot is already used by another tool.' : ('Could not save changes: ' + (error.message || 'unknown error'));
      return;
    }
    await loadData();
    renderAdmin(); renderShelves(); loadAdminLog();
    closeEditModal();
  });
}

/* ---------------- Admin: shelf layout (summary list; editing happens in the modal below) ---------------- */
function renderShelfLayoutAdmin(){
  const body = document.getElementById('shelf-layout-body');
  if(!body) return;
  if(!shelfUnits.length){
    body.innerHTML = '<div class="empty-note">No shelves yet — click "+ Add shelf" above.</div>';
    return;
  }
  body.innerHTML = shelfUnits.map(unit=>{
    const totalSlots = unit.levels.reduce((s,l)=>s+l.slots, 0);
    return `
      <div class="shelf-unit-card">
        <div class="shelf-unit-card-top">
          <strong>${escapeHtml(unit.label||unit.id)} (${escapeHtml(unit.id)})</strong>
          <button class="btn btn-sm" onclick="openShelfEditor('${escapeHtml(unit.id)}')">Edit shelf</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);">${unit.levels.length} level(s), ${totalSlots} slot(s) total</div>
      </div>
    `;
  }).join('');
}
function nextShelfId(){
  const used = new Set(shelfUnits.map(u=>u.id));
  for(let i=1;i<=50;i++){ const id = 'S'+i; if(!used.has(id)) return id; }
  return 'S'+Date.now();
}
async function createAndEditShelf(btn){
  await withLoading(btn, async ()=>{
    const id = nextShelfId();
    await supabaseClient.rpc('admin_add_shelf_unit', { p_token: sessionToken, p_unit_id: id, p_label: 'New Shelf' });
    await loadData();
    renderShelfLayoutAdmin(); renderShelves(); loadAdminLog();
    openShelfEditor(id);
  });
}

/* ---------------- Admin: interactive shelf editor (one modal — add/edit levels & slots, rename, delete) ---------------- */
function openShelfEditor(unitId){
  shelfEditorUnitId = unitId;
  renderShelfEditor();
  document.getElementById('shelf-editor-overlay').classList.add('active');
}
function closeShelfEditor(){
  document.getElementById('shelf-editor-overlay').classList.remove('active');
  shelfEditorUnitId = null;
  renderShelfLayoutAdmin();
}
function renderShelfEditor(){
  const unit = shelfUnits.find(u=>u.id===shelfEditorUnitId);
  const modal = document.getElementById('shelf-editor-modal-body');
  if(!unit){ modal.innerHTML = ''; return; }

  const levels = unit.levels.slice().sort((a,b)=>b.level-a.level);
  const usedLevels = new Set(unit.levels.map(l=>l.level));
  const availableLevels = [];
  for(let i=1;i<=50;i++){ if(!usedLevels.has(i)) availableLevels.push(i); }

  const levelRows = levels.map(lv=>`
    <tr>
      <td>Level ${lv.level}</td>
      <td>
        <select class="small-input" onchange="onChangeLevelSlots('${escapeHtml(unit.id)}', ${lv.level}, this)">
          ${numberOptions(1,50,lv.slots)}
        </select>
      </td>
      <td class="admin-row-actions">
        <button class="btn btn-sm btn-danger" onclick="removeShelfLevel('${escapeHtml(unit.id)}', ${lv.level})">Remove</button>
      </td>
    </tr>
  `).join('');

  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">Shelf ${escapeHtml(unit.id)}</div>
      <button class="modal-close" onclick="closeShelfEditor()">✕</button>
    </div>
    <div class="modal-title">Edit shelf</div>
    <div class="field"><label>Shelf name</label>
      <div style="display:flex;gap:8px;">
        <input class="small-input" id="shelf-editor-label" type="text" value="${escapeHtml(unit.label||'')}" style="flex:1;">
        <button class="btn btn-sm" onclick="saveShelfLabel(this)">Save name</button>
      </div>
    </div>
    <div class="table-scroll">
    <table>
      <thead><tr><th>Level</th><th>Slots</th><th></th></tr></thead>
      <tbody>${levelRows || '<tr><td colspan="3" style="color:var(--text-dim);">No levels yet — add one below.</td></tr>'}</tbody>
    </table>
    </div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr auto; margin-top:12px;">
      <div class="field"><label>New level</label>
        <select class="small-input" id="new-level-num">${availableLevels.map(n=>`<option value="${n}">${n}</option>`).join('') || '<option value="">—</option>'}</select>
      </div>
      <div class="field"><label>Slots</label>
        <select class="small-input" id="new-level-slots">${numberOptions(1,50,6)}</select>
      </div>
      <button class="btn btn-sm" onclick="addShelfLevel(this)" ${availableLevels.length ? '' : 'disabled'}>Add level</button>
    </div>
    <div class="modal-actions" style="margin-top:18px;">
      <button class="btn btn-danger btn-full" onclick="removeShelfUnit('${escapeHtml(unit.id)}')">Delete this shelf entirely</button>
      <button class="btn btn-full" style="margin-top:8px;" onclick="closeShelfEditor()">Done</button>
    </div>
  `;
}
async function saveShelfLabel(btn){
  const val = document.getElementById('shelf-editor-label').value.trim();
  if(!val) return;
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_update_shelf_unit', { p_token: sessionToken, p_unit_id: shelfEditorUnitId, p_label: val });
    await loadData();
    renderShelfEditor(); renderShelves(); loadAdminLog();
  });
}
async function addShelfLevel(btn){
  const numSel = document.getElementById('new-level-num');
  const slotsSel = document.getElementById('new-level-slots');
  if(!numSel.value) return;
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_set_shelf_level', {
      p_token: sessionToken, p_unit_id: shelfEditorUnitId, p_level: parseInt(numSel.value,10), p_slots: parseInt(slotsSel.value,10)
    });
    await loadData();
    renderShelfEditor(); renderShelves(); loadAdminLog();
  });
}
function onChangeLevelSlots(unitId, level, selectEl){
  const newSlots = parseInt(selectEl.value, 10);
  const affected = tools.filter(t=>t.side===unitId && t.level===level && t.slot>newSlots);
  const apply = async ()=>{
    await supabaseClient.rpc('admin_set_shelf_level', { p_token: sessionToken, p_unit_id: unitId, p_level: level, p_slots: newSlots });
    await loadData();
    renderShelfEditor(); renderShelves(); renderAdminInventory(); loadAdminLog();
  };
  if(affected.length){
    showConfirm('Slots will be removed',
      `Reducing level ${level} to ${newSlots} slots will unassign ${affected.length} tool(s):`
      + `<ul>${affected.map(t=>'<li>'+escapeHtml(t.name)+'</li>').join('')}</ul>`
      + `They'll stay in inventory with no shelf location. Continue?`,
      'Yes, unassign & continue', apply, true);
    renderShelfEditor(); // resets the dropdown visually unless/until the change is confirmed
  } else {
    apply();
  }
}
function removeShelfLevel(unitId, level){
  const affected = tools.filter(t=>t.side===unitId && t.level===level);
  const apply = async ()=>{
    await supabaseClient.rpc('admin_delete_shelf_level', { p_token: sessionToken, p_unit_id: unitId, p_level: level });
    await loadData();
    renderShelfEditor(); renderShelves(); renderAdminInventory(); loadAdminLog();
    if(affected.length){
      showNotice('Tools unassigned', `${affected.length} tool(s) were unassigned and now show "Unassigned" in Inventory:`
        + `<ul>${affected.map(t=>'<li>'+escapeHtml(t.name)+'</li>').join('')}</ul>`);
    }
  };
  const msg = affected.length
    ? `Level ${level} has ${affected.length} tool(s) on it:<ul>${affected.map(t=>'<li>'+escapeHtml(t.name)+'</li>').join('')}</ul>Removing this level will unassign them. Continue?`
    : `Remove level ${level}?`;
  showConfirm('Remove level', msg, 'Remove level', apply, true);
}
function removeShelfUnit(unitId){
  const affected = tools.filter(t=>t.side===unitId);
  const apply = async ()=>{
    await supabaseClient.rpc('admin_delete_shelf_unit', { p_token: sessionToken, p_unit_id: unitId });
    await loadData();
    closeShelfEditor(); renderShelves(); renderAdminInventory(); loadAdminLog();
    if(affected.length){
      showNotice('Tools unassigned', `${affected.length} tool(s) were unassigned:`
        + `<ul>${affected.map(t=>'<li>'+escapeHtml(t.name)+'</li>').join('')}</ul>`);
    }
  };
  const msg = affected.length
    ? `This shelf has ${affected.length} tool(s) on it:<ul>${affected.map(t=>'<li>'+escapeHtml(t.name)+'</li>').join('')}</ul>Deleting it will unassign them. Continue?`
    : `Delete this shelf entirely?`;
  showConfirm('Delete shelf', msg, 'Delete shelf', apply, true);
}

/* ---------------- Admin: people ---------------- */
async function loadPeopleAdmin(){
  const { data } = await supabaseClient.rpc('list_people_admin', { p_token: sessionToken });
  peopleAdminList = data || [];
  renderPeopleAdmin();
}
function sortAdminPeople(key){
  if(peopleSortKey===key){ peopleSortDir = peopleSortDir==='asc' ? 'desc' : 'asc'; }
  else { peopleSortKey = key; peopleSortDir = 'asc'; }
  renderPeopleAdmin();
}
function renderPeopleAdmin(){
  document.getElementById('people-count').textContent = peopleAdminList.length;

  const sorted = peopleAdminList.slice().sort((a,b)=>{
    let av, bv;
    switch(peopleSortKey){
      case 'role': av=a.role; bv=b.role; break;
      case 'phone': av=(a.phone||''); bv=(b.phone||''); break;
      case 'email': av=(a.email||'').toLowerCase(); bv=(b.email||'').toLowerCase(); break;
      case 'added': av=a.created_at||''; bv=b.created_at||''; break;
      case 'name': default: av=a.name.toLowerCase(); bv=b.name.toLowerCase();
    }
    if(av<bv) return peopleSortDir==='asc' ? -1 : 1;
    if(av>bv) return peopleSortDir==='asc' ? 1 : -1;
    return 0;
  });

  document.querySelectorAll('[id^="people-sort-arrow-"]').forEach(el=>el.textContent='');
  const activeArrow = document.getElementById('people-sort-arrow-'+peopleSortKey);
  if(activeArrow) activeArrow.textContent = peopleSortDir==='asc' ? ' ▲' : ' ▼';

  const body = document.getElementById('people-body');
  body.innerHTML = '';
  sorted.forEach(p=>{
    const tr = document.createElement('tr');
    const armed = peopleDeleteArmed.has(p.id);
    const added = p.created_at ? new Date(p.created_at).toLocaleDateString() : '—';
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${p.role==='admin' ? 'Admin' : 'Field employee'}</td>
      <td>${escapeHtml(p.phone||'—')}</td>
      <td>${escapeHtml(p.email||'—')}</td>
      <td>${added}</td>
      <td class="admin-row-actions">
        <button class="btn btn-sm" onclick="openEditPerson('${p.id}')">Edit</button>
        <button class="btn btn-sm" onclick="openResetPinModal('${p.id}','${escapeHtml(p.name)}')">Reset PIN</button>
        <button class="btn btn-sm btn-danger" onclick="${armed ? `adminDeletePerson('${p.id}', this)` : `armPersonDelete('${p.id}')`}">${armed ? 'Confirm delete?' : 'Delete'}</button>
      </td>
    `;
    body.appendChild(tr);
  });
}
function armPersonDelete(id){
  peopleDeleteArmed.add(id); renderPeopleAdmin();
  setTimeout(()=>{ peopleDeleteArmed.delete(id); renderPeopleAdmin(); }, 4000);
}
async function adminAddPerson(btn){
  const name = document.getElementById('add-person-name').value.trim();
  const pin = document.getElementById('add-person-pin').value.trim();
  const role = document.getElementById('add-person-role').value;
  const phone = document.getElementById('add-person-phone').value.trim();
  const email = document.getElementById('add-person-email').value.trim();
  const msg = document.getElementById('add-person-msg');
  msg.className = 'msg error';
  if(!name){ msg.textContent = 'Name is required.'; return; }
  if(!/^\d{4}$/.test(pin)){ msg.textContent = 'PIN must be exactly 4 digits.'; return; }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('admin_add_person', {
      p_token: sessionToken, new_name: name, new_pin: pin, new_role: role, new_phone: phone, new_email: email
    });
    if(error){
      msg.textContent = (error.message && error.message.includes('duplicate')) ? 'That name is already taken.' : 'Could not add person.';
      return;
    }
    msg.className = 'msg success';
    msg.textContent = `Added ${name} (${role==='admin' ? 'Admin' : 'Field employee'}).`;
    ['add-person-name','add-person-pin','add-person-phone','add-person-email'].forEach(id=>document.getElementById(id).value='');
    await loadPeopleAdmin();
    loadAdminLog();
  });
}
function openResetPinModal(id, name){
  const modal = document.getElementById('confirm-modal-body');
  modal.innerHTML = `
    <div class="modal-top"><div class="modal-tag">Reset PIN</div><button class="modal-close" onclick="closeConfirmModal()">✕</button></div>
    <div class="modal-title" style="font-size:16px;">New PIN for ${escapeHtml(name)}</div>
    <div class="field"><label>New 4-digit PIN</label><input class="small-input" id="reset-pin-input" type="text" inputmode="numeric" maxlength="4" placeholder="1234"></div>
    <div class="msg error" id="reset-pin-msg"></div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-full" onclick="submitResetPin('${id}', this)">Save new PIN</button>
      <button class="btn btn-full" style="margin-top:8px;" onclick="closeConfirmModal()">Cancel</button>
    </div>
  `;
  confirmPendingFn = null;
  document.getElementById('confirm-overlay').classList.add('active');
}
async function submitResetPin(id, btn){
  const val = document.getElementById('reset-pin-input').value.trim();
  const msg = document.getElementById('reset-pin-msg');
  if(!/^\d{4}$/.test(val)){ msg.textContent = 'PIN must be exactly 4 digits.'; return; }
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_reset_pin', { p_token: sessionToken, target_id: id, new_pin: val });
    await loadAdminLog();
  });
  closeConfirmModal();
}
async function adminDeletePerson(id, btn){
  peopleDeleteArmed.delete(id);
  await withLoading(btn, async ()=>{
    await supabaseClient.rpc('admin_delete_person', { p_token: sessionToken, target_id: id });
    await loadPeopleAdmin();
    loadAdminLog();
  });
}

/* ---------------- Admin: edit person ---------------- */
function openEditPerson(id){
  editPersonId = id;
  renderEditPersonModal();
  document.getElementById('person-edit-overlay').classList.add('active');
}
function closeEditPersonModal(){
  document.getElementById('person-edit-overlay').classList.remove('active');
  editPersonId = null;
}
function renderEditPersonModal(){
  const p = peopleAdminList.find(x=>x.id===editPersonId);
  if(!p) return;
  const modal = document.getElementById('person-edit-modal-body');
  modal.innerHTML = `
    <div class="modal-top">
      <div class="modal-tag">${p.role==='admin' ? 'Admin' : 'Field employee'}</div>
      <button class="modal-close" onclick="closeEditPersonModal()">✕</button>
    </div>
    <div class="modal-title">Edit person</div>
    <div class="field"><label>Name</label><input class="small-input" id="editp-name" type="text" value="${escapeHtml(p.name)}"></div>
    <div class="field"><label>Phone</label><input class="small-input" id="editp-phone" type="text" value="${escapeHtml(p.phone||'')}"></div>
    <div class="field"><label>Email</label><input class="small-input" id="editp-email" type="email" value="${escapeHtml(p.email||'')}"></div>
    <div style="font-size:11.5px;color:var(--text-dim);margin-top:4px;">Role and PIN aren't editable here — use Reset PIN for the PIN, and Delete + re-add to change a role.</div>
    <div class="msg error" id="editp-msg"></div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-full" onclick="adminUpdatePerson(this)">Save changes</button>
    </div>
  `;
}
async function adminUpdatePerson(btn){
  const name = document.getElementById('editp-name').value.trim();
  const phone = document.getElementById('editp-phone').value.trim();
  const email = document.getElementById('editp-email').value.trim();
  const msg = document.getElementById('editp-msg');
  if(!name){ msg.textContent = 'Name is required.'; return; }
  await withLoading(btn, async ()=>{
    const { error } = await supabaseClient.rpc('admin_update_person', {
      p_token: sessionToken, target_id: editPersonId, new_name: name, new_phone: phone, new_email: email
    });
    if(error){ msg.textContent = 'Could not save changes: ' + (error.message || 'unknown error'); return; }
    await loadPeopleAdmin();
    loadAdminLog();
    closeEditPersonModal();
  });
}

/* ---------------- Admin: activity log (admin-only, read via list_admin_log) ---------------- */
function renderAdminLog(){
  const body = document.getElementById('admin-log-body');
  if(!body) return;
  body.innerHTML = '';
  const emptyEl = document.getElementById('admin-log-empty');
  if(emptyEl) emptyEl.style.display = adminLog.length ? 'none' : 'block';
  adminLog.forEach(entry=>{
    const tr = document.createElement('tr');
    const when = new Date(entry.created_at);
    const whenStr = isNaN(when) ? entry.created_at : when.toLocaleString();
    tr.innerHTML = `
      <td>${whenStr}</td>
      <td>${escapeHtml(entry.actor_name)}</td>
      <td>${escapeHtml(entry.action)}</td>
      <td>${escapeHtml(entry.details||'')}</td>
    `;
    body.appendChild(tr);
  });
}

/* ---------------- Init ---------------- */
initLogin();
