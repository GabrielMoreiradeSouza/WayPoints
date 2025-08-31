// WayPoint App (mobile-first)
// Dependencies: Leaflet, Firebase compat (optional)

const els = {
  map: document.getElementById('map'),
  btnAddHere: document.getElementById('btnAddHere'),
  btnList: document.getElementById('btnList'),
  panel: document.getElementById('panel'),
  btnClosePanel: document.getElementById('btnClosePanel'),
  wpList: document.getElementById('wpList'),
  routeInfo: document.getElementById('routeInfo'),
  modeSelect: document.getElementById('modeSelect'),
  followToggle: document.getElementById('followToggle'),
  // auth
  signedOut: document.getElementById('signedOut'),
  signedIn: document.getElementById('signedIn'),
  userEmail: document.getElementById('userEmail'),
  btnShowAuth: document.getElementById('btnShowAuth'),
  btnSignOut: document.getElementById('btnSignOut'),
  authDialog: document.getElementById('authDialog'),
  authEmail: document.getElementById('authEmail'),
  authPass: document.getElementById('authPass'),
  btnLogin: document.getElementById('btnLogin'),
  btnRegister: document.getElementById('btnRegister'),
  // waypoint modal
  wpDialog: document.getElementById('wpDialog'),
  wpForm: document.getElementById('wpForm'),
  wpDialogTitle: document.getElementById('wpDialogTitle'),
  wpName: document.getElementById('wpName'),
  wpNotes: document.getElementById('wpNotes'),
  wpSave: document.getElementById('wpSave'),
};

const state = {
  firebaseReady: false,
  user: null,
  map: null,
  userMarker: null,
  userCoords: null,
  watchId: null,
  markers: new Map(),
  routeLayer: null,
  editingId: null,
  follow: true,
  // navigation
  activeDest: null,        // { lat, lng, name }
  activeRoute: null,       // OSRM route
  activeSteps: [],         // OSRM steps
  nextStepIndex: 0,
  lastRouteAt: 0,
  // positioning
  firstFix: false,
  userAccuracy: null,
  accuracyCircle: null,
};

const LS_KEY = 'waypoint_local_items_v1';

function safeAlert(msg){
  // small non-blocking toast alternative
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.position='fixed';
  el.style.left='50%';
  el.style.top='14px';
  el.style.transform='translateX(-50%)';
  el.style.background='rgba(0,0,0,.8)';
  el.style.color='#fff';
  el.style.padding='8px 12px';
  el.style.borderRadius='10px';
  el.style.zIndex='10000';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 2000);
}

function getTransportProfile(){
  const val = els.modeSelect.value;
  if (val === 'walking') return { osrm: 'foot', icon: '🚶' };
  if (val === 'cycling') return { osrm: 'bike', icon: '🚲' };
  if (val === 'bus') return { osrm: 'driving', icon: '🚌' }; // aproximação
  return { osrm: 'driving', icon: '🚗' };
}

function initMap(){
  state.map = L.map('map');
  const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileLayer = L.tileLayer(tileUrl, { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
  tileLayer.addTo(state.map);

  // user marker initial
  const icon = L.divIcon({ className: 'user-icon', html: `<div style="font-size:22px">${getTransportProfile().icon}</div>` });
  state.userMarker = L.marker([0,0], { icon });
  state.userMarker.addTo(state.map);

  // locate: high accuracy, no cached positions, show accuracy circle
  if ('geolocation' in navigator){
    state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000,
    });
    // Initial one-shot to speed up first view (if available)
    navigator.geolocation.getCurrentPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    });
  } else {
    safeAlert('Geolocalização não suportada');
  }

  state.map.setView([-15.793889, -47.882778], 13); // Brasília como fallback
}

function updateUserIcon(){
  const icon = L.divIcon({ className: 'user-icon', html: `<div style="font-size:22px">${getTransportProfile().icon}</div>` });
  state.userMarker.setIcon(icon);
}

function onPosition(pos){
  const { latitude, longitude, accuracy, heading, speed } = pos.coords;
  // Ignore very inaccurate fixes for camera recenter (but still update marker)
  const isAccurate = accuracy != null ? accuracy <= 100 : true;
  state.userAccuracy = accuracy ?? null;
  state.userCoords = [latitude, longitude];
  state.userMarker.setLatLng(state.userCoords);

  // accuracy circle
  try{
    if (!state.accuracyCircle){
      state.accuracyCircle = L.circle(state.userCoords, { radius: accuracy||0, color:'#3b82f6', weight:1, fillColor:'#3b82f6', fillOpacity:0.15 }).addTo(state.map);
    } else {
      state.accuracyCircle.setLatLng(state.userCoords);
      if (accuracy) state.accuracyCircle.setRadius(accuracy);
    }
  }catch{}

  if (state.follow && (isAccurate || !state.firstFix)){
    state.map.setView(state.userCoords, Math.max(state.map.getZoom()||0, 17));
  }
  if (!state.firstFix && isAccurate){
    state.firstFix = true;
  }

  // live navigation update
  updateActiveNavigation();
}

function onPositionError(err){
  console.warn('Geolocation error', err);
  safeAlert('Ative o GPS e conceda permissão de localização');
}

// Data layer: Firestore if available and user logged in; otherwise LocalStorage
function usingFirestore(){
  return state.firebaseReady && state.user && window.firebase?.firestore;
}

function lsLoad(){
  try{ return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }catch{ return []; }
}
function lsSave(items){
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

async function dbList(){
  if (usingFirestore()){
    const db = firebase.firestore();
    const snap = await db.collection('users').doc(state.user.uid).collection('waypoints').orderBy('createdAt','desc').get();
    return snap.docs.map(d=>({ id:d.id, ...d.data() }));
  } else {
    return lsLoad();
  }
}

async function dbAdd(item){
  if (usingFirestore()){
    const db = firebase.firestore();
    const col = db.collection('users').doc(state.user.uid).collection('waypoints');
    const now = Date.now();
    const res = await col.add({ ...item, createdAt: now, updatedAt: now });
    return { id: res.id, ...item };
  } else {
    const items = lsLoad();
    const id = crypto.randomUUID();
    items.unshift({ id, ...item });
    lsSave(items);
    return { id, ...item };
  }
}

async function dbUpdate(id, patch){
  if (usingFirestore()){
    const db = firebase.firestore();
    await db.collection('users').doc(state.user.uid).collection('waypoints').doc(id).update({ ...patch, updatedAt: Date.now() });
  } else {
    const items = lsLoad();
    const idx = items.findIndex(x=>x.id===id);
    if (idx>=0){ items[idx] = { ...items[idx], ...patch }; lsSave(items); }
  }
}

async function dbDelete(id){
  if (usingFirestore()){
    const db = firebase.firestore();
    await db.collection('users').doc(state.user.uid).collection('waypoints').doc(id).delete();
  } else {
    const items = lsLoad().filter(x=>x.id!==id);
    lsSave(items);
  }
}

function clearWaypointsOnMap(){
  for (const m of state.markers.values()){
    state.map.removeLayer(m);
  }
  state.markers.clear();
}

function renderWaypointItem(wp){
  const div = document.createElement('div');
  div.className = 'wp-item';
  const info = document.createElement('div');
  const actions = document.createElement('div');
  actions.className = 'wp-actions';
  const h = document.createElement('h4');
  h.className = 'wp-title';
  h.textContent = wp.name;
  const p = document.createElement('p');
  p.className = 'wp-notes';
  p.textContent = wp.notes || '';
  info.appendChild(h); info.appendChild(p);

  const bCenter = document.createElement('button'); bCenter.className='btn'; bCenter.textContent='Ir';
  bCenter.onclick = ()=> { navigateTo(wp); };
  const bEdit = document.createElement('button'); bEdit.className='btn btn-outline'; bEdit.textContent='Editar';
  bEdit.onclick = ()=> { openEditDialog(wp); };
  const bDel = document.createElement('button'); bDel.className='btn btn-outline'; bDel.style.borderColor='var(--danger)'; bDel.textContent='Excluir';
  bDel.onclick = async ()=> { await dbDelete(wp.id); await refreshAll(); };
  actions.append(bCenter,bEdit,bDel);
  div.append(info, actions);
  return div;
}

async function refreshAll(){
  const list = await dbList();
  // list panel
  els.wpList.innerHTML = '';
  list.forEach(wp=> els.wpList.appendChild(renderWaypointItem(wp)) );
  // markers
  clearWaypointsOnMap();
  list.forEach(wp=>{
    const marker = L.marker([wp.lat, wp.lng]).addTo(state.map);
    marker.bindPopup(`<b>${escapeHtml(wp.name)}</b><br>${escapeHtml(wp.notes||'')}<br/><br/>
      <button id="nav-${wp.id}" class="leaflet-btn">Navegar</button>
      <button id="edit-${wp.id}" class="leaflet-btn">Editar</button>
      <button id="del-${wp.id}" class="leaflet-btn danger">Excluir</button>
    `);
    marker.on('popupopen', ()=>{
      const nav = document.getElementById(`nav-${wp.id}`);
      const edit = document.getElementById(`edit-${wp.id}`);
      const del = document.getElementById(`del-${wp.id}`);
      nav?.addEventListener('click', ()=> navigateTo(wp));
      edit?.addEventListener('click', ()=> openEditDialog(wp));
      del?.addEventListener('click', async ()=> { await dbDelete(wp.id); await refreshAll(); });
    });
    state.markers.set(wp.id, marker);
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"]+/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
}

// Routing with OSRM public server
let routeAbort = null;
async function navigateTo(wp){
  if (!state.userCoords){ safeAlert('Sem posição atual'); return; }
  state.activeDest = { lat: wp.lat, lng: wp.lng, name: wp.name };
  await reroute();
}

function profileToPath(p){
  // OSRM hosted server profiles: driving, walking, cycling
  if (p==='foot') return 'walking';
  if (p==='bike') return 'cycling';
  return 'driving';
}

async function fetchRoute(from, to, withSteps=true){
  try{
    routeAbort?.abort();
    routeAbort = new AbortController();
    const prof = profileToPath(getTransportProfile().osrm);
    const stepsParam = withSteps ? 'true' : 'false';
    const url = `https://router.project-osrm.org/route/v1/${prof}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&alternatives=false&steps=${stepsParam}`;
    const res = await fetch(url, { signal: routeAbort.signal });
    const json = await res.json();
    if (!json.routes?.length) throw new Error('Sem rota');
    return json.routes[0];
  }catch(e){
    console.warn('route error', e);
    safeAlert('Falha ao calcular rota');
    return null;
  }
}

function drawRoute(route){
  if (!route) return;
  if (state.routeLayer){ state.map.removeLayer(state.routeLayer); state.routeLayer = null; }
  const coords = route.geometry.coordinates.map(([lng,lat])=>[lat,lng]);
  state.routeLayer = L.polyline(coords, { color:'#22c55e', weight:5, opacity:.9 }).addTo(state.map);
  state.map.fitBounds(state.routeLayer.getBounds(), { padding:[40,40] });
  const km = (route.distance/1000).toFixed(2);
  const min = Math.round(route.duration/60);
  els.routeInfo.classList.remove('hidden');
  const step = state.activeSteps?.[state.nextStepIndex];
  const instr = step ? renderInstruction(step) : 'Navegação iniciada';
  els.routeInfo.innerHTML = `<strong>${instr}</strong><br>Distância ~ ${km} km • Tempo ~ ${min} min <button id="btnCancelNav" class="btn btn-outline" style="margin-left:8px">Parar</button>`;
  document.getElementById('btnCancelNav')?.addEventListener('click', cancelNavigation);
}

async function reroute(){
  if (!state.activeDest || !state.userCoords) return;
  state.lastRouteAt = Date.now();
  const route = await fetchRoute(state.userCoords, [state.activeDest.lat, state.activeDest.lng], true);
  if (!route) return;
  state.activeRoute = route;
  const steps = (route.legs?.[0]?.steps || []);
  state.activeSteps = steps;
  state.nextStepIndex = 0;
  drawRoute(route);
}

function cancelNavigation(){
  state.activeDest = null;
  state.activeRoute = null;
  state.activeSteps = [];
  state.nextStepIndex = 0;
  if (state.routeLayer){ state.map.removeLayer(state.routeLayer); state.routeLayer = null; }
  els.routeInfo.classList.add('hidden');
}

function updateActiveNavigation(){
  if (!state.activeDest || !state.userCoords) return;
  // advance step when close
  const step = state.activeSteps[state.nextStepIndex];
  if (step){
    const [slng, slat] = step.maneuver.location;
    const d = haversine(state.userCoords[0], state.userCoords[1], slat, slng);
    if (d < 20){ // meters
      state.nextStepIndex = Math.min(state.nextStepIndex + 1, state.activeSteps.length - 1);
    }
  }
  // recalc if off-route or periodic
  const now = Date.now();
  const needPeriodic = now - state.lastRouteAt > 10000; // 10s
  const off = state.routeLayer ? distanceToPolyline(state.userCoords, state.routeLayer.getLatLngs()) > 40 : true;
  if (needPeriodic || off){ reroute(); return; }

  // refresh panel info
  if (state.activeRoute){
    const rem = estimateRemaining(state.userCoords, state.activeRoute);
    const instr = state.activeSteps[state.nextStepIndex] ? renderInstruction(state.activeSteps[state.nextStepIndex]) : 'Continue';
    els.routeInfo.innerHTML = `<strong>${instr}</strong><br>Restante ~ ${formatDistance(rem.distance)} • ${formatDuration(rem.duration)} <button id="btnCancelNav" class="btn btn-outline" style="margin-left:8px">Parar</button>`;
    document.getElementById('btnCancelNav')?.addEventListener('click', cancelNavigation);
    // arrived?
    const destD = haversine(state.userCoords[0], state.userCoords[1], state.activeDest.lat, state.activeDest.lng);
    if (destD < 20){
      safeAlert('Você chegou ao destino');
      cancelNavigation();
    }
  }
}

function estimateRemaining(user, route){
  // fallback: remaining equals full route (simple). Advanced: compute along polyline.
  const totalDist = route.distance;
  const totalDur = route.duration;
  // try: scale by progress along polyline
  const coords = route.geometry.coordinates.map(([lng,lat])=>[lat,lng]);
  const idx = nearestPointOnPolylineIndex(user, coords);
  const remDist = polylineLength(coords.slice(idx)) || totalDist;
  const ratio = remDist/totalDist;
  return { distance: remDist, duration: Math.max(30, totalDur * ratio) };
}

function nearestPointOnPolylineIndex(p, line){
  let bestI = 0, bestD = Infinity;
  for (let i=0;i<line.length;i++){
    const d = haversine(p[0], p[1], line[i][0], line[i][1]);
    if (d < bestD){ bestD = d; bestI = i; }
  }
  return bestI;
}

function polylineLength(line){
  let sum = 0;
  for (let i=1;i<line.length;i++){
    sum += haversine(line[i-1][0], line[i-1][1], line[i][0], line[i][1]);
  }
  return sum;
}

function distanceToPolyline(p, line){
  // approximate: min distance to vertices (simple and fast)
  let best = Infinity;
  for (let i=0;i<line.length;i++){
    const d = haversine(p[0], p[1], line[i][0], line[i][1]);
    if (d < best) best = d;
  }
  return best;
}

function haversine(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = x=>x*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

function renderInstruction(step){
  const type = step.maneuver?.type || '';
  const mod = step.maneuver?.modifier || '';
  switch(type){
    case 'depart': return 'Siga em frente';
    case 'turn': return `Vire ${ptDir(mod)}`;
    case 'new name': return 'Continue em frente';
    case 'arrive': return 'Chegou ao destino';
    case 'merge': return `Entregue-se ${ptDir(mod)}`;
    case 'roundabout': return 'Rotatória — siga a saída indicada';
    case 'fork': return `Na bifurcação, mantenha-se ${ptDir(mod)}`;
    default: return 'Continue';
  }
}

function ptDir(mod){
  switch(mod){
    case 'left': return 'à esquerda';
    case 'right': return 'à direita';
    case 'slight left': return 'levemente à esquerda';
    case 'slight right': return 'levemente à direita';
    case 'uturn': return 'faça o retorno';
    case 'straight': default: return 'em frente';
  }
}

function formatDistance(m){
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m/1000).toFixed(1)} km`;
}
function formatDuration(s){
  const m = Math.round(s/60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m/60); const mm = m%60;
  return `${h} h ${mm} min`;
}

// Add/Edit dialog helpers
function openCreateDialog(latlng){
  state.editingId = null;
  els.wpDialogTitle.textContent = 'Novo WayPoint';
  els.wpName.value = '';
  els.wpNotes.value = '';
  els.wpDialog.showModal();
  els.wpForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const item = { name: els.wpName.value.trim(), notes: els.wpNotes.value.trim(), lat: latlng[0], lng: latlng[1] };
    if (!item.name){ safeAlert('Nome é obrigatório'); return; }
    await dbAdd(item);
    els.wpDialog.close();
    await refreshAll();
  };
}

function openEditDialog(wp){
  state.editingId = wp.id;
  els.wpDialogTitle.textContent = 'Editar WayPoint';
  els.wpName.value = wp.name || '';
  els.wpNotes.value = wp.notes || '';
  els.wpDialog.showModal();
  els.wpForm.onsubmit = async (ev)=>{
    ev.preventDefault();
    const patch = { name: els.wpName.value.trim(), notes: els.wpNotes.value.trim() };
    if (!patch.name){ safeAlert('Nome é obrigatório'); return; }
    await dbUpdate(wp.id, patch);
    els.wpDialog.close();
    await refreshAll();
  };
}

// Auth UI wiring
function setAuthUI(user){
  state.user = user;
  if (user){
    els.signedOut.classList.add('hidden');
    els.signedIn.classList.remove('hidden');
    els.userEmail.textContent = user.email || '';
  } else {
    els.signedOut.classList.remove('hidden');
    els.signedIn.classList.add('hidden');
    els.userEmail.textContent = '';
  }
}

function initFirebaseIfConfigured(){
  try{
    const cfg = window.FIREBASE_CONFIG || {};
    if (!cfg || !cfg.apiKey){
      console.info('Firebase não configurado. Usando modo local.');
      state.firebaseReady = false;
      return;
    }
    firebase.initializeApp(cfg);
    state.firebaseReady = true;
    firebase.auth().onAuthStateChanged(async (user)=>{
      setAuthUI(user);
      await refreshAll();
    });
  }catch(e){
    console.warn('Falha ao iniciar Firebase', e);
    state.firebaseReady = false;
  }
}

// Event listeners
function bindEvents(){
  els.btnShowAuth.addEventListener('click', ()=> els.authDialog.showModal());
  els.btnSignOut.addEventListener('click', async ()=> { try{ await firebase.auth().signOut(); }catch{} });
  els.btnLogin.addEventListener('click', async (e)=>{
    e.preventDefault();
    try{
      await firebase.auth().signInWithEmailAndPassword(els.authEmail.value, els.authPass.value);
      els.authDialog.close();
    }catch(err){ safeAlert('Falha no login: '+(err?.message||'')); }
  });
  els.btnRegister.addEventListener('click', async (e)=>{
    e.preventDefault();
    try{
      await firebase.auth().createUserWithEmailAndPassword(els.authEmail.value, els.authPass.value);
      els.authDialog.close();
    }catch(err){ safeAlert('Falha ao criar conta: '+(err?.message||'')); }
  });

  els.btnAddHere.addEventListener('click', ()=>{
    const pos = state.userCoords || state.map.getCenter();
    openCreateDialog([pos.lat || pos[0], pos.lng || pos[1]]);
  });

  els.btnList.addEventListener('click', async ()=>{
    els.panel.classList.remove('hidden');
    await refreshAll();
  });
  els.btnClosePanel.addEventListener('click', ()=> els.panel.classList.add('hidden'));

  els.modeSelect.addEventListener('change', ()=>{
    updateUserIcon();
    if (state.routeLayer) els.routeInfo.classList.remove('hidden');
  });
  els.followToggle.addEventListener('change', ()=>{ state.follow = !!els.followToggle.checked; });
}

// PWA service worker
function initSW(){
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}

// Bootstrap
initMap();
bindEvents();
initFirebaseIfConfigured();
refreshAll();
initSW();
