// Team Desk – Task Tracker (multi-team)
// Plain JavaScript + Firebase (Auth + Firestore). No build step needed.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where,
  onSnapshot, serverTimestamp, Timestamp, arrayUnion, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCcjXx7wOXnJT-LWGVUWH-cVMRE5LpW2tU",
  authDomain: "izoc-task-tracker-71534.firebaseapp.com",
  projectId: "izoc-task-tracker-71534",
  storageBucket: "izoc-task-tracker-71534.firebasestorage.app",
  messagingSenderId: "643730618819",
  appId: "1:643730618819:web:c2fea3d2f031c019f02576"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- state ----------
let me = null;            // { uid, name, email, role, supervisorId }
let users = {};           // uid -> user (current team view)
let projects = {};        // id -> project (current team view)
let tasks = {};           // id -> task (current team view)
let projectDetails = {};  // id -> business details (staff only, current team view)
let invites = {};         // email -> pending invite (admin only, current team view)
// raw data as loaded (owner loads every team; everyone else only their own team)
let allUsers = {}, allProjects = {}, allTasks = {}, allDetails = {}, allInvites = {};
let teams = {};           // teamId -> { name }
const HOME_TEAM = "arsalan";     // Arsalan's own team (existing data belongs here)
let viewTeam = HOME_TEAM;        // team currently shown
let unsubs = [];
let editingTaskId = null;
let signUpMode = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ROLE_LABEL = { senior: "Admin", supervisor: "Manager", member: "Task Access" };
const DESIGNATIONS = ["Senior Supervisor", "Supervisor", "Ecommerce Officer"];
const TARGETS = { senior: { min: 7500, promo: 15000 }, supervisor: { min: 2500, promo: 7500 } };
const MAX_PROJECTS_PER_CLIENT = 2;
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
let currentTab = "tasks";
const isSenior = () => me?.role === "senior";
const isSup = () => me?.role === "supervisor";
const isStaff = () => isSenior() || isSup();
const isOwner = () => isSenior() && me?.owner === true;
const teamOf = (x) => x?.teamId || HOME_TEAM;
const teamName = (id) => teams[id]?.name || (id === HOME_TEAM ? "Team Arsalan" : "Team");

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2800);
}
function show(screen) {
  ["authScreen", "pendingScreen", "inviteScreen", "appScreen"].forEach((s) => $(s).classList.toggle("hidden", s !== screen));
}
const toDate = (ts) => (ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null);
function fmtDT(ts) {
  const d = toDate(ts); if (!d) return "";
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDur(ms) {
  if (!ms || ms < 0) return "";
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${mm}m`;
}
function workMs(t) {
  if (isOngoing(t)) return 0;
  let ms = t.workMs || 0;
  if (t.status === "In Progress" && t.lastResumeAt) ms += Date.now() - toDate(t.lastResumeAt).getTime();
  return ms;
}
function isOverdue(t) {
  if (!t.due || t.status === "Completed" || isOngoing(t)) return false;
  const end = new Date(t.due + "T23:59:59");
  return Date.now() > end.getTime();
}
const statusClass = (s) => "s-" + String(s).toLowerCase().replace(/\s+/g, "-");
const userName = (uid) => allUsers[uid]?.name || users[uid]?.name || "(unknown)";
const shortId = (id) => "T-" + id.slice(0, 5).toUpperCase();
const stLabel = (s) => (s === "Not Started" ? "Assigned" : s);
const isOngoing = (t) => !!t?.recurrence;
const fmtDay = (v) => { if (!v) return ""; const d = new Date(v + "T00:00:00"); return isNaN(d) ? esc(v) : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }); };
const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const avatarHtml = (u, cls = "") => u?.photo
  ? `<span class="avatar ${cls}"><img src="${esc(u.photo)}" alt="" /></span>`
  : `<span class="avatar ${cls}">${esc(initials(u?.name))}</span>`;

// ---------- inline editing (small pencil) ----------
const PEN = `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2.2"/></svg>`;
// kind: task | proj | user ; type: text | textarea | number | email
function ed(kind, id, field, value, display, type = "text", can = true) {
  const shown = display !== undefined && display !== null && display !== "" ? display : (value ? esc(value) : `<span class="ph">—</span>`);
  if (!can) return `<span class="ed-ro">${shown}</span>`;
  return `<span class="ed" data-kind="${kind}" data-id="${esc(id)}" data-field="${field}" data-type="${type}" data-value="${esc(value ?? "")}"><span class="ed-val">${shown}</span><button type="button" class="pen" title="Edit">${PEN}</button></span>`;
}
// inline select / date: saved on change
function sel(kind, id, field, value, opts, can = true, extra = "") {
  if (!can) { const o = opts.find(([v]) => String(v) === String(value ?? "")); return `<span class="ed-ro">${esc(o ? o[1] : "")}</span>`; }
  return `<select class="inl" data-kind="${kind}" data-id="${esc(id)}" data-field="${field}" ${extra}>` +
    opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("") + `</select>`;
}
function dateInl(kind, id, field, value, can = true) {
  if (!can) return `<span class="ed-ro">${fmtDay(value)}</span>`;
  return `<input type="date" class="inl date-inl" data-kind="${kind}" data-id="${esc(id)}" data-field="${field}" value="${esc(value || "")}" />`;
}
let inlineActive = false, needRender = false;
const inlFocused = () => !!document.activeElement?.classList?.contains("inl");
function scheduleRender() { if (inlineActive || inlFocused()) { needRender = true; return; } renderAll(); }
document.addEventListener("focusout", (e) => {
  if (e.target.classList?.contains("inl")) setTimeout(() => { if (needRender && !inlineActive && !inlFocused()) { needRender = false; renderAll(); } }, 150);
});
document.addEventListener("click", (e) => {
  const pen = e.target.closest(".pen"); if (!pen) return;
  e.preventDefault(); e.stopPropagation();
  const box = pen.closest(".ed"); if (!box || box.classList.contains("editing")) return;
  const type = box.dataset.type, val = box.dataset.value;
  box.classList.add("editing"); inlineActive = true;
  const inp = document.createElement(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") inp.type = type === "number" ? "number" : type === "email" ? "email" : "text";
  if (type === "number") { inp.min = "0"; inp.step = "any"; }
  if (type === "textarea") inp.rows = 2;
  inp.className = "ed-input"; inp.value = val;
  box.innerHTML = ""; box.appendChild(inp); inp.focus(); inp.select?.();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const nv = inp.value.trim();
    inlineActive = false;
    if (save && nv !== val) {
      try { await saveField(box.dataset.kind, box.dataset.id, box.dataset.field, nv, type); toast("Saved"); }
      catch (err) { toast(niceErr(err)); }
    }
    renderAll(); needRender = false;
  };
  inp.addEventListener("keydown", (k) => {
    if (k.key === "Escape") { k.preventDefault(); finish(false); }
    if (k.key === "Enter" && (type !== "textarea" || !k.shiftKey)) { k.preventDefault(); finish(true); }
  });
  inp.addEventListener("blur", () => finish(true));
}, true);
document.addEventListener("change", async (e) => {
  const el = e.target.closest(".inl"); if (!el) return;
  try { await saveField(el.dataset.kind, el.dataset.id, el.dataset.field, el.value, el.type === "date" ? "date" : "select"); toast("Saved"); }
  catch (err) { toast(niceErr(err)); renderAll(); }
});

async function saveField(kind, id, field, value, type) {
  if (type === "number") value = value === "" ? null : Number(value);
  if (kind === "task") return saveTaskField(tasks[id], field, value);
  if (kind === "proj") {
    const upd = { [field]: value, updatedAt: serverTimestamp(), updatedBy: me.uid, teamId: teamOf(projects[id]) };
    if (field === "clientName" && value) {
      const p = projects[id];
      const n = Object.values(projects).filter((x) => x.id !== id && x.active !== false && clientKey(projectDetails[x.id]?.clientName) === clientKey(value)).length;
      if (p?.active !== false && n >= MAX_PROJECTS_PER_CLIENT) throw new Error(`${value} already has ${MAX_PROJECTS_PER_CLIENT} current projects.`);
    }
    await setDoc(doc(db, "projectDetails", id), upd, { merge: true });
    if (field === "clientName" || field === "llcName") {
      const d = { ...(projectDetails[id] || {}), [field]: value };
      const name = projName(d); if (name) await updateDoc(doc(db, "projects", id), { name });
    }
    return;
  }
  if (kind === "user") {
    const upd = { [field]: value };
    if (field === "designation" && value !== "Ecommerce Officer") { upd.supervisorId = ""; upd.coSupervisorId = ""; }
    return updateDoc(doc(db, "users", id), upd);
  }
}
async function saveTaskField(t, field, value) {
  if (!t) return;
  if (field === "status") return changeStatus(t, value);
  const upd = { [field]: value, updatedAt: serverTimestamp() };
  let action = `Edited ${field}`;
  if (field === "assigneeId") { upd.supervisorId = supervisorFor(value); upd.managerIds = managerIdsFor(value, upd.supervisorId, t.assignedById); action = `Reassigned to ${userName(value)}`; }
  if (field === "projectId") { upd.projectName = projects[value]?.name || ""; action = `Project → ${projects[value]?.name || ""}`; }
  if (field === "priority") action = `Priority → ${value}`;
  if (field === "due") action = `Due date → ${value || "none"}`;
  if (field === "notes") action = "Note updated";
  if (field === "estimate") action = `Estimated time → ${value || "none"}`;
  if (field === "recurrence") {
    if (value) {
      upd.priority = "High";
      if (t.status === "In Progress" && t.lastResumeAt) { upd.workMs = (t.workMs || 0) + Date.now() - toDate(t.lastResumeAt).getTime(); upd.lastResumeAt = null; }
      action = `Made ongoing (${value})`;
    } else {
      if (t.status === "In Progress") upd.lastResumeAt = serverTimestamp();
      action = "Made one-time";
    }
  }
  upd.history = arrayUnion({ at: Timestamp.now(), by: me.uid, action });
  await updateDoc(doc(db, "tasks", t.id), upd);
}

// ---------- auth ----------
$("toggleAuth").onclick = (e) => {
  e.preventDefault(); signUpMode = !signUpMode;
  $("authName").classList.toggle("hidden", !signUpMode);
  $("authName").required = signUpMode;
  $("authPhone").classList.toggle("hidden", !signUpMode);
  $("authEmpId").classList.toggle("hidden", !signUpMode);
  $("authTeam").classList.toggle("hidden", !signUpMode);
  $("authTeam").required = signUpMode;
  if (signUpMode) loadSignupTeams();
  $("authBtn").textContent = signUpMode ? "Create account" : "Sign in";
  $("authSubtitle").textContent = signUpMode ? "Create your account" : "Sign in to continue";
  $("toggleAuth").textContent = signUpMode ? "Have an account? Sign in" : "New here? Create an account";
  $("authMsg").textContent = "";
};
async function loadSignupTeams() {
  try {
    const s = await getDocs(collection(db, "teams"));
    const list = []; s.forEach((d) => list.push([d.id, d.data().name || d.id]));
    list.sort((a, b) => a[1].localeCompare(b[1]));
    setOptions($("authTeam"), list, "Select your team");
  } catch (err) { console.warn(err); }
}
$("forgotPass").onclick = async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim();
  if (!email) { $("authMsg").textContent = "Type your email first."; return; }
  try { await sendPasswordResetEmail(auth, email); $("authMsg").textContent = "Reset email sent."; }
  catch (err) { $("authMsg").textContent = niceErr(err); }
};
$("authForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim(), pass = $("authPass").value;
  $("authMsg").textContent = ""; $("authBtn").disabled = true;
  try {
    if (signUpMode) {
      const name = $("authName").value.trim();
      const teamId = $("authTeam").value;
      if (!teamId) { $("authMsg").textContent = "Please select your team."; $("authBtn").disabled = false; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "users", cred.user.uid), {
        name, email, role: "pending", supervisorId: "", phone: $("authPhone").value.trim(),
        employeeId: $("authEmpId").value.trim(), designation: "", teamId, createdAt: serverTimestamp()
      });
      await loadMe(cred.user);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) { $("authMsg").textContent = niceErr(err); }
  $("authBtn").disabled = false;
};
function niceErr(err) {
  const c = err?.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Wrong email or password.";
  if (c.includes("email-already-in-use")) return "That email already has an account. Sign in instead.";
  if (c.includes("weak-password")) return "Password needs at least 6 characters.";
  if (c.includes("permission-denied")) return "You don't have permission for that.";
  return err?.message || "Something went wrong.";
}
$("completeForm").onsubmit = async (e) => {
  e.preventDefault();
  const user = auth.currentUser; if (!user || !inviteData) return;
  $("completeBtn").disabled = true; $("completeMsg").textContent = "";
  try {
    const name = $("cName").value.trim();
    await updatePassword(user, $("cPass").value);
    await updateProfile(user, { displayName: name });
    await setDoc(doc(db, "users", user.uid), {
      name, email: user.email, role: inviteData.role, designation: inviteData.designation,
      supervisorId: inviteData.supervisorId || "", phone: $("cPhone").value.trim(),
      employeeId: $("cEmpId").value.trim(), doj: inviteData.doj || "", teamId: teamOf(inviteData), createdAt: serverTimestamp()
    });
    await deleteDoc(doc(db, "invites", String(user.email).toLowerCase())).catch(() => {});
    inviteData = null;
    await loadMe(user);
  } catch (err) { $("completeMsg").textContent = niceErr(err); }
  $("completeBtn").disabled = false;
};
$("logoutBtn").onclick = () => signOut(auth);
$("pendingLogout").onclick = () => signOut(auth);

// Invite link: the invited person opens the emailed link and lands here.
const inviteParam = new URLSearchParams(location.search).get("invite");
let inviteLinkPromise = Promise.resolve();
if (isSignInWithEmailLink(auth, location.href)) {
  const em = inviteParam || window.localStorage.getItem("izocInviteEmail") || prompt("Confirm your email to accept the invite");
  inviteLinkPromise = signInWithEmailLink(auth, em, location.href)
    .then(() => history.replaceState(null, "", location.pathname))
    .catch((err) => { $("authMsg").textContent = "This invite link is expired or already used. Ask for a new invite, or sign in."; console.warn(err); });
}
let inviteData = null;

onAuthStateChanged(auth, async (user) => {
  await inviteLinkPromise;
  unsubs.forEach((u) => u()); unsubs = []; tasks = {}; users = {}; projects = {}; projectDetails = {}; invites = {};
  allTasks = {}; allUsers = {}; allProjects = {}; allDetails = {}; allInvites = {}; teams = {}; fixed.clear();
  if (!user) { me = null; show("authScreen"); return; }
  await loadMe(user);
});

async function loadMe(user) {
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) {
    const em = String(user.email || "").toLowerCase();
    const inv = em ? await getDoc(doc(db, "invites", em)).catch(() => null) : null;
    if (inv?.exists()) {
      inviteData = inv.data();
      $("inviteFor").textContent = `${user.email} · ${inviteData.designation}`;
      show("inviteScreen"); return;
    }
    show("pendingScreen"); return; // account doc still being created
  }
  me = { uid: user.uid, ...snap.data() };
  if (!["senior", "supervisor", "member"].includes(me.role)) { show("pendingScreen"); return; }
  startApp();
}

// ---------- app ----------
function startApp() {
  show("appScreen");
  viewTeam = isOwner() ? (localStorage.getItem("izocViewTeam") || HOME_TEAM) : teamOf(me);
  renderMe();
  document.querySelectorAll(".staff-only").forEach((el) => el.classList.toggle("hidden", !isStaff()));
  document.querySelectorAll(".senior-only").forEach((el) => el.classList.toggle("hidden", !isSenior()));
  $("teamSwitch").classList.toggle("hidden", !isOwner());
  switchTab("tasks");

  const owner = isOwner(), myTeamId = teamOf(me);
  // Owner loads every team; everyone else only their own team (must match the security rules).
  const scoped = (name) => owner ? collection(db, name) : query(collection(db, name), where("teamId", "==", myTeamId));
  const load = (name, keyed, setRaw) => onSnapshot(scoped(name), (s) => {
    const m = {}; s.forEach((d) => (m[d.id] = keyed(d)));
    setRaw(m); if (owner) backfill(name, m);
    applyView(); scheduleRender();
  }, (err) => console.warn(name, err));

  unsubs.push(onSnapshot(collection(db, "teams"), (s) => {
    teams = {}; s.forEach((d) => (teams[d.id] = { id: d.id, ...d.data() }));
    if (owner && !teams[HOME_TEAM]) setDoc(doc(db, "teams", HOME_TEAM), { name: "Team Arsalan", createdAt: serverTimestamp() }).catch(() => {});
    if (owner && viewTeam !== HOME_TEAM && Object.keys(teams).length && !teams[viewTeam]) setView(HOME_TEAM);
    renderTeamSwitch(); renderMe();
  }));
  unsubs.push(load("users", (d) => ({ uid: d.id, ...d.data() }), (m) => {
    allUsers = m;
    if (allUsers[me.uid]) me = { ...me, ...allUsers[me.uid] };
    renderMe();
  }));
  unsubs.push(load("projects", (d) => ({ id: d.id, ...d.data() }), (m) => (allProjects = m)));
  if (isSenior()) unsubs.push(load("invites", (d) => d.data(), (m) => (allInvites = m)));
  if (isStaff()) unsubs.push(load("projectDetails", (d) => d.data(), (m) => (allDetails = m)));

  // Task queries must match the security rules.
  const col = collection(db, "tasks");
  const qs = owner
    ? [col]
    : isSenior()
      ? [query(col, where("teamId", "==", myTeamId))]
      : isSup()
        ? [query(col, where("supervisorId", "==", me.uid)), query(col, where("managerIds", "array-contains", me.uid)), query(col, where("assigneeId", "==", me.uid)), query(col, where("assigneeIds", "array-contains", me.uid))]
        : [query(col, where("assigneeId", "==", me.uid)), query(col, where("assigneeIds", "array-contains", me.uid))];
  const buckets = qs.map(() => ({}));
  setupNotifications();
  qs.forEach((q, i) => unsubs.push(onSnapshot(q, (s) => {
    buckets[i] = {}; s.forEach((d) => (buckets[i][d.id] = { id: d.id, ...d.data() }));
    notifyNewAssignments(s);
    allTasks = Object.assign({}, ...buckets);
    if (owner) backfill("tasks", allTasks);
    applyView(); scheduleRender();
  }, (err) => toast(niceErr(err)))));

  // refresh running timers every minute
  unsubs.push(((h) => () => clearInterval(h))(setInterval(() => { if (!inlineActive && !document.activeElement?.classList?.contains("inl")) renderTasks(); }, 60000)));
}

// ---------- teams: view filter, switcher, one-time tagging of old data ----------
function applyView() {
  const pick = (m) => Object.fromEntries(Object.entries(m).filter(([, x]) => teamOf(x) === viewTeam));
  users = pick(allUsers); projects = pick(allProjects); tasks = pick(allTasks);
  projectDetails = pick(allDetails); invites = pick(allInvites);
}
function setView(id) {
  viewTeam = id; localStorage.setItem("izocViewTeam", id);
  ["fProject", "fPerson"].forEach((f) => ($(f).value = ""));
  projSynced = false; mgrSyncKey = "";
  applyView(); renderTeamSwitch(); renderMe(); renderAll();
}
function renderTeamSwitch() {
  const name = teamName(viewTeam);
  $("brandName").textContent = name; document.title = name;
  if (!isOwner()) return;
  const list = Object.values(teams).sort((a, b) => (a.id === HOME_TEAM ? -1 : b.id === HOME_TEAM ? 1 : (a.name || "").localeCompare(b.name || "")));
  $("teamSel").innerHTML = list.map((t) => `<option value="${esc(t.id)}" ${t.id === viewTeam ? "selected" : ""}>${esc(t.name || t.id)}</option>`).join("")
    + `<option value="__new">+ New team…</option><option value="__rename">✎ Rename this team…</option>`;
}
$("teamSel").onchange = async (e) => {
  const v = e.target.value;
  try {
    if (v === "__new") {
      const name = (prompt("New team name (e.g. Team Abdul Basit):") || "").trim().slice(0, 60);
      if (name) { const r = await addDoc(collection(db, "teams"), { name, createdBy: me.uid, createdAt: serverTimestamp() }); setView(r.id);
        toast(`${name} created. Open the Team tab to invite its Senior Supervisor.`); return; }
    } else if (v === "__rename") {
      const name = (prompt("Team name:", teamName(viewTeam)) || "").trim().slice(0, 60);
      if (name) { await setDoc(doc(db, "teams", viewTeam), { name }, { merge: true }); toast("Team renamed"); }
    } else { setView(v); return; }
  } catch (err) { toast(niceErr(err)); }
  renderTeamSwitch();
};
// Old records were made before teams existed: the owner tags them as Team Arsalan once.
const fixed = new Set();
function backfill(name, m) {
  Object.entries(m).forEach(([id, x]) => {
    if (x.teamId || fixed.has(name + "/" + id)) return;
    fixed.add(name + "/" + id);
    updateDoc(doc(db, name, id), { teamId: HOME_TEAM }).catch((err) => console.warn("tag", name, id, err));
  });
}

document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + tab));
  $("taskToolbar").classList.toggle("hidden", !["tasks", "ongoing", "completed"].includes(tab));
  $("fStatus").classList.toggle("hidden", tab !== "tasks");
  $("newTaskBtn").classList.toggle("hidden", !["tasks", "ongoing"].includes(tab) || !isStaff());
}

function renderAll() { syncProjectNames(); syncTaskManagers(); fillFilters(); renderTasks(); renderDashboard(); renderProjects(); renderTeam(); }

// people this user may assign to
function assignableUsers() {
  const active = Object.values(users).filter((u) => ["senior", "supervisor", "member"].includes(u.role));
  if (isSenior()) return active;
  if (isSup()) return active.filter((u) => u.uid === me.uid || managersOf(u.uid).includes(me.uid));
  return [];
}
// an officer can be managed by two people: main (supervisorId) + second (coSupervisorId)
function managersOf(uid) {
  const u = users[uid];
  if (!u) return [];
  if (Array.isArray(u.managerIds)) return u.managerIds.filter(Boolean);
  if (desigOf(u) !== "Ecommerce Officer") return [];
  return [u.supervisorId, u.coSupervisorId].filter(Boolean);
}
// ---------- checkbox multi-select (compact button + floating list) ----------
function mselLabel(ids, empty = "– choose –") {
  const n = ids.map(userName).filter(Boolean);
  return n.length ? esc(n[0]) + (n.length > 1 ? ` <span class="msel-more">+${n.length - 1}</span>` : "") : `<span class="muted">${empty}</span>`;
}
function mselBtn(key, ids, can = true, empty) {
  const title = esc(ids.map(userName).join(", "));
  return can ? `<button type="button" class="msel-btn" data-msel="${esc(key)}" title="${title}">${mselLabel(ids, empty)}<span class="msel-caret">▾</span></button>`
    : `<span title="${title}">${mselLabel(ids, "—")}</span>`;
}
let mselOpen = null; // { pop, onDone }
function closeMsel() { if (!mselOpen) return; const m = mselOpen; mselOpen = null; m.pop.remove(); inlineActive = false; m.onDone?.(); if (needRender) scheduleRender(); }
function openMsel(btn, options, selected, onChange, onDone) {
  closeMsel();
  const host = btn.closest("dialog") || document.body;
  const pop = document.createElement("div"); pop.className = "msel-pop";
  const chosen = new Set(selected);
  pop.innerHTML = `<input class="msel-search" placeholder="Search…" />` + options.map(([v, l, sub]) =>
    `<label class="msel-item"><input type="checkbox" value="${esc(v)}" ${chosen.has(v) ? "checked" : ""}/> <span>${esc(l)}${sub ? ` <small class="muted">${esc(sub)}</small>` : ""}</span></label>`).join("")
    + (options.length ? "" : `<div class="muted small">No one available.</div>`);
  host.appendChild(pop);
  const r = btn.getBoundingClientRect(), hr = host === document.body ? { left: 0, top: 0 } : host.getBoundingClientRect();
  pop.style.position = host === document.body ? "fixed" : "absolute";
  const left = Math.min(r.left, window.innerWidth - 270);
  pop.style.left = (left - hr.left + (host === document.body ? 0 : host.scrollLeft)) + "px";
  const below = r.bottom + 4, h = Math.min(320, 40 + options.length * 34);
  const top = below + h > window.innerHeight ? Math.max(8, r.top - h - 4) : below;
  pop.style.top = (top - hr.top + (host === document.body ? 0 : host.scrollTop)) + "px";
  inlineActive = true;
  mselOpen = { pop, onDone };
  pop.querySelector(".msel-search").oninput = (e) => { const q = e.target.value.toLowerCase();
    pop.querySelectorAll(".msel-item").forEach((l) => l.classList.toggle("hidden", !l.textContent.toLowerCase().includes(q))); };
  pop.addEventListener("change", () => {
    const ids = [...pop.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    onChange(ids);
  });
  setTimeout(() => pop.querySelector(".msel-search").focus(), 0);
}
document.addEventListener("mousedown", (e) => { if (mselOpen && !mselOpen.pop.contains(e.target) && !e.target.closest(".msel-btn")) closeMsel(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && mselOpen) { e.preventDefault(); closeMsel(); } });
// a task can have several people on it (one shared row, one shared timer)
const assigneesOf = (t) => (Array.isArray(t?.assigneeIds) && t.assigneeIds.length ? t.assigneeIds : [t?.assigneeId]).filter(Boolean);
const isAssignee = (t, uid = me?.uid) => assigneesOf(t).includes(uid);
function managerIdsFor(assigneeId, supId, assignerId) {
  const ids = Array.isArray(assigneeId) ? assigneeId : [assigneeId];
  const extra = [assignerId].filter((x) => x && users[x]?.role === "supervisor");
  return [...new Set([supId, ...ids.flatMap(managersOf), ...extra].filter(Boolean))];
}
function assigneeFields(ids, assignerId) {
  const supId = supervisorFor(ids[0]);
  return { assigneeIds: ids, assigneeId: ids[0], supervisorId: supId, managerIds: managerIdsFor(ids, supId, assignerId) };
}
const canManageTask = (t) => isSenior() || (isSup() && (t.supervisorId === me.uid || (t.managerIds || []).includes(me.uid)));
let mgrSyncKey = "";
function syncTaskManagers() {
  if (!isSenior() || !Object.keys(users).length) return;
  const key = Object.values(users).map((u) => u.uid + managersOf(u.uid).join(",")).join("|") + Object.keys(tasks).length;
  if (key === mgrSyncKey) return; mgrSyncKey = key;
  Object.values(tasks).forEach((t) => {
    const want = managerIdsFor(assigneesOf(t), t.supervisorId, t.assignedById);
    const have = t.managerIds || [];
    if (want.length !== have.length || want.some((x) => !have.includes(x)))
      updateDoc(doc(db, "tasks", t.id), { managerIds: want }).catch(() => {});
  });
}
const activeProjects = () => Object.values(projects).filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));

function setOptions(sel, items, first) {
  const cur = sel.value;
  sel.innerHTML = (first ? `<option value="">${first}</option>` : "") +
    items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function fillFilters() {
  setOptions($("fProject"), Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.id, projLabel(p.id)]), "All projects");
  const people = isSenior() ? Object.values(users).filter((u) => u.role !== "pending") : assignableUsers();
  setOptions($("fPerson"), people.sort((a, b) => a.name.localeCompare(b.name)).map((u) => [u.uid, u.name]), "All people");
}
["fProject", "fPerson", "fStatus", "fFrom", "fTo"].forEach((id) => ($(id).onchange = renderTasks));
$("doneSearch").oninput = () => renderDone();
function projName(d) { return String(d?.clientName || "").trim() || String(d?.llcName || "").trim(); }
let projSynced = false;
function syncProjectNames() {
  if (projSynced || !isStaff() || !Object.keys(projectDetails).length || !Object.keys(projects).length) return;
  projSynced = true;
  Object.values(projects).forEach((p) => { const n = projName(projectDetails[p.id]); if (n && n !== p.name) updateDoc(doc(db, "projects", p.id), { name: n }).catch(() => {}); });
}
function projLabel(pid) {
  const p = projects[pid]; const c = projectDetails[pid]?.clientName;
  return (c ? c + " · " : "") + (p?.name || "");
}

function filteredTasks(mode = "open") {
  const p = $("fProject").value, who = $("fPerson").value, st = mode === "open" ? $("fStatus").value : "";
  const from = $("fFrom").value ? new Date($("fFrom").value + "T00:00:00") : null;
  const to = $("fTo").value ? new Date($("fTo").value + "T23:59:59") : null;
  return Object.values(tasks).filter((t) => {
    if (p && t.projectId !== p) return false;
    if (who && !isAssignee(t, who)) return false;
    if (mode === "open" && t.status === "Completed" && !isOngoing(t)) return false;
    if (mode === "done" && (t.status !== "Completed" || isOngoing(t))) return false;
    if (mode === "open" && isOngoing(t) && t.status === "Completed") { /* ongoing never completes */ }
    if (st === "__ongoing" && !isOngoing(t)) return false;
    if (st && st !== "__ongoing" && t.status !== st) return false;
    const a = toDate(mode === "done" ? t.completedAt : t.assignedAt);
    if (from && a && a < from) return false;
    if (to && a && a > to) return false;
    return true;
  }).sort((a, b) => {
    if (mode === "done") return (toDate(b.completedAt)?.getTime() || 0) - (toDate(a.completedAt)?.getTime() || 0);
    const order = { "In Progress": 0, "Not Started": 1, "On Hold": 2, "Completed": 3 };
    return ((isOngoing(b) ? 1 : 0) - (isOngoing(a) ? 1 : 0)) || (order[a.status] - order[b.status]) || ((toDate(b.assignedAt)?.getTime() || 0) - (toDate(a.assignedAt)?.getTime() || 0));
  });
}

function renderTasks() {
  if (!me) return;
  if (inlineActive || inlFocused()) { needRender = true; return; }
  const list = filteredTasks("open");
  renderDone();
  const projOpts = activeProjects().map((p) => [p.id, projects[p.id].name]);
  const peopleOpts = assignableUsers().sort((a, b) => a.name.localeCompare(b.name)).map((u) => [u.uid, u.name]);
  const row = (t) => {
    const mine = isAssignee(t);
    const canManage = canManageTask(t);
    const og = isOngoing(t);
    const pOpts = projOpts.some(([v]) => v === t.projectId) ? projOpts : [[t.projectId, projects[t.projectId]?.name || t.projectName || "(removed)"], ...projOpts];
    const uOpts = peopleOpts.some(([v]) => v === t.assigneeId) ? peopleOpts : [[t.assigneeId, userName(t.assigneeId)], ...peopleOpts];
    const stOpts = og ? [["Not Started", "Assigned"], ["In Progress", "In Progress"]] : [["Not Started", "Assigned"], ["In Progress", "In Progress"], ["Completed", "Completed"]];
    if (t.status === "On Hold") stOpts.splice(1, 0, ["On Hold", "On Hold"]);
    const btns = [["history", "History"]];
    if (canManage) btns.push(["delete", "Delete"]);
    return `<tr class="${isOverdue(t) ? "overdue" : ""} ${og ? "ongoing" : ""}">
      <td class="title-cell"><b>${ed("task", t.id, "title", t.title, null, "text", canManage)}</b>
        <div class="desc">${ed("task", t.id, "desc", t.desc, t.desc ? esc(t.desc) : '<span class="ph">Add details</span>', "textarea", canManage)}</div>
        <div class="desc">📝 ${ed("task", t.id, "notes", t.notes, t.notes ? esc(t.notes) : '<span class="ph">Add note</span>', "textarea", canManage || mine)}</div></td>
      <td>${sel("task", t.id, "projectId", t.projectId, pOpts, canManage)}</td>
      <td>${mselBtn("asg:" + t.id, assigneesOf(t), canManage)}<div class="small muted">by ${esc(userName(t.assignedById))}</div></td>
      <td>${og ? "" : dateInl("task", t.id, "due", t.due, canManage)}${isOverdue(t) ? '<div class="od-wrap"><span class="badge s-overdue">Overdue</span></div>' : ""}</td>
      <td>${canManage ? sel("task", t.id, "recurrence", t.recurrence || "", [["", "One-time"], ["Daily", "Ongoing · Daily"], ["Weekly", "Ongoing · Weekly"], ["Monthly", "Ongoing · Monthly"]], true, `data-og="${og ? 1 : 0}"`)
        : og ? `<span class="badge s-ongoing">Ongoing · ${esc(t.recurrence)}</span>` : '<span class="muted small">One-time</span>'}</td>
      <td>${fmtDT(t.assignedAt)}</td>
      <td>${timerCell(t, mine, canManage)}</td>
      <td>${og ? `<span class="est">Est. ${ed("task", t.id, "estimate", t.estimate, null, "text", canManage)}</span>` : fmtDur(workMs(t))}</td>
      <td><div class="actions">${btns.map(([a, l]) => `<button class="secondary small-btn" data-act="${a}" data-id="${t.id}">${l}</button>`).join("")}</div></td>
    </tr>`;
  };
  const senior = isSenior();
  const pend = senior ? list.filter((t) => !isOngoing(t)) : list;
  const ong = senior ? list.filter((t) => isOngoing(t)) : [];
  $("taskEmpty").classList.toggle("hidden", pend.length > 0);
  $("taskTable").querySelector("tbody").innerHTML = pend.map(row).join("");
  $("ongoingEmpty").classList.toggle("hidden", ong.length > 0);
  $("ongoingTable").querySelector("tbody").innerHTML = ong.map(row).join("");
  tickTimers();
}
function timerCell(t, mine, canManage) {
  if (isOngoing(t)) return "";
  const can = mine || canManage;
  const started = t.startedAt ? `<div class="tm-start">Started ${fmtDT(t.startedAt)}</div>` : "";
  if (t.status === "In Progress") {
    const base = t.workMs || 0, res = t.lastResumeAt ? toDate(t.lastResumeAt).getTime() : Date.now();
    return `<div class="tm">${can ? `<div class="tm-btns"><button class="btn-complete" data-act="complete" data-id="${t.id}">✓ Complete</button><button class="btn-pause" data-act="hold" data-id="${t.id}" title="Pause the timer (break)">❚❚ Pause</button></div>` : `<span class="badge ${statusClass(t.status)}">In Progress</span>`}
      <span class="live-timer" data-base="${base}" data-res="${res}">${clock(base + Date.now() - res)}</span>${started}</div>`;
  }
  const paused = t.workMs ? `<span class="live-timer paused">${clock(t.workMs)}</span>` : "";
  return `<div class="tm">${can ? `<button class="btn-start" data-act="start" data-id="${t.id}">▶ ${t.status === "On Hold" || t.workMs ? "Resume" : "Start"}</button>` : `<span class="badge ${statusClass(t.status)}">${esc(stLabel(t.status))}</span>`}${paused}${started}</div>`;
}
function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const p = (n) => String(n).padStart(2, "0"); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; }
function tickTimers() { document.querySelectorAll(".live-timer").forEach((el) => { el.textContent = clock(Number(el.dataset.base) + Date.now() - Number(el.dataset.res)); }); }
setInterval(tickTimers, 1000);

function renderDone() {
  const q = $("doneSearch").value.trim().toLowerCase();
  const hay = (t) => [shortId(t.id), t.title, t.desc, t.notes, projects[t.projectId]?.name, t.projectName, projLabel(t.projectId),
    assigneesOf(t).map(userName).join(" "), userName(t.assignedById), t.priority, t.due].join(" ").toLowerCase();
  const list = filteredTasks("done").filter((t) => !q || q.split(/\s+/).every((w) => hay(t).includes(w)));
  $("doneEmpty").classList.toggle("hidden", list.length > 0);
  $("doneEmpty").textContent = q ? `No completed tasks match "${$("doneSearch").value.trim()}".` : "No completed tasks for these filters.";
  $("doneTable").querySelector("tbody").innerHTML = list.map((t) => {
    const canManage = canManageTask(t);
    const late = t.due && toDate(t.completedAt) && toDate(t.completedAt) > new Date(t.due + "T23:59:59");
    return `<tr>
      <td>${shortId(t.id)}</td>
      <td class="title-cell"><b>${esc(t.title)}</b>${t.desc ? `<div class="desc">${esc(t.desc)}</div>` : ""}${t.notes ? `<div class="desc">📝 ${esc(t.notes)}</div>` : ""}</td>
      <td>${esc(projects[t.projectId]?.name || t.projectName || "")}</td>
      <td>${esc(assigneesOf(t).map(userName).join(", "))}<div class="small muted">by ${esc(userName(t.assignedById))}</div></td>
      <td>${esc(t.due || "")}</td>
      <td>${fmtDT(t.assignedAt)}</td><td>${fmtDT(t.startedAt)}</td><td>${fmtDT(t.completedAt)}</td>
      <td><b>${fmtDur(workMs(t))}</b></td>
      <td>${!t.due ? "" : late ? '<span class="badge s-overdue">Late</span>' : '<span class="badge s-completed">On time</span>'}</td>
      <td><div class="actions"><button class="secondary small-btn" data-act="history" data-id="${t.id}">History</button>
        ${canManage ? `<button class="secondary small-btn" data-act="reopen" data-id="${t.id}">Reopen</button>
        <button class="secondary small-btn" data-act="delete" data-id="${t.id}">Delete</button>` : ""}</div></td>
    </tr>`;
  }).join("");
}

$("doneTable").onclick = (e) => $("taskTable").onclick(e);
$("ongoingTable").onclick = (e) => $("taskTable").onclick(e);
$("taskTable").onclick = async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const t = tasks[b.dataset.id]; if (!t) return;
  const act = b.dataset.act;
  try {
    if (act === "start") await changeStatus(t, "In Progress");
    if (act === "hold") await changeStatus(t, "On Hold");
    if (act === "complete") await changeStatus(t, "Completed");
    if (act === "reopen") await changeStatus(t, "In Progress");
    if (act === "history") showHistory(t);
    if (act === "edit") openTaskModal(t);
    if (act === "note") {
      const n = prompt("Note for this task:", t.notes || "");
      if (n !== null) await updateDoc(doc(db, "tasks", t.id), {
        notes: n, updatedAt: serverTimestamp(),
        history: arrayUnion({ at: Timestamp.now(), by: me.uid, action: "Note updated" })
      });
    }
    if (act === "delete" && confirm(`Delete "${t.title}"? This can't be undone.`)) {
      await deleteDoc(doc(db, "tasks", t.id)); toast("Task deleted");
    }
  } catch (err) { toast(niceErr(err)); }
};

async function changeStatus(t, status) {
  const now = Timestamp.now();
  if (isOngoing(t)) {
    if (status === "Completed") return;
    const u = { status, updatedAt: serverTimestamp(), history: arrayUnion({ at: now, by: me.uid, action: `${stLabel(t.status)} → ${stLabel(status)}` }) };
    if (status === "In Progress" && !t.startedAt) u.startedAt = serverTimestamp();
    await updateDoc(doc(db, "tasks", t.id), u); toast(`Marked ${stLabel(status)}`); return;
  }
  const upd = { status, updatedAt: serverTimestamp() };
  let work = t.workMs || 0;
  if (t.status === "In Progress" && t.lastResumeAt) work += now.toMillis() - toDate(t.lastResumeAt).getTime();
  upd.workMs = work;
  if (status === "In Progress") {
    upd.lastResumeAt = serverTimestamp();
    if (!t.startedAt) upd.startedAt = serverTimestamp();
    if (t.status === "Completed") upd.completedAt = null;
  } else {
    upd.lastResumeAt = null;
  }
  if (status === "Completed") upd.completedAt = serverTimestamp();
  upd.history = arrayUnion({ at: now, by: me.uid, action: `${stLabel(t.status)} → ${stLabel(status)}` });
  await updateDoc(doc(db, "tasks", t.id), upd);
  toast(status === "Completed" ? "Completed · moved to Completed page" : `Marked ${stLabel(status)}`);
}

function showHistory(t) {
  $("historyTitle").textContent = `History · ${t.title}`;
  const h = [...(t.history || [])].sort((a, b) => toDate(a.at) - toDate(b.at));
  $("historyList").innerHTML = h.length
    ? h.map((x) => `<li><span>${esc(String(x.action).replace(/Not Started/g, "Assigned"))}</span><span class="small muted">${esc(userName(x.by))} · ${fmtDT(x.at)}</span></li>`).join("")
    : `<li class="muted">No history yet.</li>`;
  $("historyModal").showModal();
}
$("historyClose").onclick = () => $("historyModal").close();

// "Managed by" checkbox list in Team tab
$("teamTable").addEventListener("click", (e) => {
  const b = e.target.closest(".msel-btn[data-msel^='mgr:']"); if (!b) return;
  if (mselOpen) { closeMsel(); return; }
  const uid = b.dataset.msel.slice(4);
  const pool = Object.values(users).filter((x) => x.role !== "pending" && x.uid !== uid).sort((a, c) => a.name.localeCompare(c.name))
    .map((x) => [x.uid, x.name, desigOf(x) + (x.role === "member" ? " · Task Access" : "")]);
  let ids = managersOf(uid);
  openMsel(b, pool, ids, (next) => { ids = next; b.innerHTML = mselLabel(ids) + '<span class="msel-caret">▾</span>'; },
    () => updateDoc(doc(db, "users", uid), { managerIds: ids, supervisorId: ids[0] || "", coSupervisorId: "" }).catch((err) => toast(niceErr(err))));
});

// "Assigned to" checkbox list in task tables: everyone ticked shares this one task
document.addEventListener("click", (e) => {
  const b = e.target.closest(".msel-btn[data-msel^='asg:']"); if (!b) return;
  if (mselOpen) { closeMsel(); return; }
  const t = tasks[b.dataset.msel.slice(4)]; if (!t) return;
  const cur = assigneesOf(t);
  const opts = assignableUsers().sort((a, c) => a.name.localeCompare(c.name)).map((u) => [u.uid, u.name, u.designation || ROLE_LABEL[u.role]]);
  cur.forEach((id) => { if (!opts.some(([v]) => v === id)) opts.unshift([id, userName(id), ""]); });
  let ids = [...cur];
  const draw = (x) => (b.innerHTML = mselLabel(x, "– choose –") + '<span class="msel-caret">▾</span>');
  openMsel(b, opts, ids, (next) => { ids = next; draw(ids); },
    async () => {
      if (!ids.length) { draw(cur); toast("At least one person must stay on the task."); return; }
      if (ids.length === cur.length && ids.every((x) => cur.includes(x))) { draw(cur); return; }
      try {
        await updateDoc(doc(db, "tasks", t.id), { ...assigneeFields(ids, t.assignedById), updatedAt: serverTimestamp(),
          history: arrayUnion({ at: Timestamp.now(), by: me.uid, action: `Assigned to ${ids.map(userName).join(", ")}` }) });
        toast("Assignees updated");
      } catch (err) { draw(cur); toast(niceErr(err)); }
    });
});

// ---------- task modal ----------
let taskAssignees = [];
function drawAssigneeBtn() { $("tAssigneeBtn").innerHTML = mselLabel(taskAssignees, "– choose people –") + '<span class="msel-caret">▾</span>';
  $("tAssigneeBtn").title = taskAssignees.map(userName).join(", "); }
$("tAssigneeBtn").onclick = (e) => {
  if (mselOpen) { closeMsel(); return; }
  const opts = assignableUsers().sort((a, b) => a.name.localeCompare(b.name)).map((u) => [u.uid, u.name, u.designation || ROLE_LABEL[u.role]]);
  openMsel(e.currentTarget, opts, taskAssignees, (ids) => { taskAssignees = ids; drawAssigneeBtn(); });
};
$("newTaskBtn").onclick = () => openTaskModal(null);
$("taskCancel").onclick = () => $("taskModal").close();
function openTaskModal(t) {
  editingTaskId = t?.id || null;
  $("taskModalTitle").textContent = t ? "Edit task" : "New task";
  setOptions($("tProject"), activeProjects().map((p) => [p.id, projLabel(p.id)]), null);
  if (!activeProjects().length) { toast("Add a project first (Projects tab)."); return; }
  $("tTitle").value = t?.title || ""; $("tDesc").value = t?.desc || "";
  if (t) { $("tProject").value = t.projectId; } taskAssignees = t ? assigneesOf(t) : []; drawAssigneeBtn();
  $("tDue").value = t?.due || ""; $("tNotes").value = t?.notes || "";
  $("tType").value = t?.recurrence || ""; $("tEst").value = t?.estimate || ""; syncTaskType();
  $("taskModal").showModal();
}
function syncTaskType() {
  const og = !!$("tType").value;
  $("tEstWrap").classList.toggle("hidden", !og);
  $("tDue").disabled = og;
}
$("tType").onchange = syncTaskType;
function supervisorFor(assigneeId) {
  const a = users[assigneeId];
  if (desigOf(a) === "Ecommerce Officer" && a.supervisorId) return a.supervisorId;
  return me.uid; // assigning to a supervisor or to yourself: the assigner manages it
}
$("taskForm").onsubmit = async (e) => {
  e.preventDefault();
  if (!taskAssignees.length) { toast("Choose at least one person."); return; }
  const projectId = $("tProject").value;
  const people = [...taskAssignees];
  const old = editingTaskId ? tasks[editingTaskId] : null;
  const data = {
    title: $("tTitle").value.trim(), desc: $("tDesc").value.trim(), projectId,
    projectName: projects[projectId]?.name || "", ...assigneeFields(people, old ? old.assignedById : me.uid),
    priority: $("tType").value ? "High" : (old?.priority || "Medium"), due: $("tType").value ? "" : $("tDue").value,
    notes: $("tNotes").value.trim(), recurrence: $("tType").value, estimate: $("tType").value ? $("tEst").value.trim() : "",
    updatedAt: serverTimestamp()
  };
  const names = people.map(userName).join(", ");
  try {
    if (old) {
      const same = people.length === assigneesOf(old).length && people.every((x) => assigneesOf(old).includes(x));
      data.history = arrayUnion({ at: Timestamp.now(), by: me.uid, action: same ? "Edited" : `Edited · assigned to ${names}` });
      await updateDoc(doc(db, "tasks", editingTaskId), data);
      toast("Task updated");
    } else {
      await addDoc(collection(db, "tasks"), {
        ...data, teamId: viewTeam, status: "Not Started", assignedById: me.uid, assignedAt: serverTimestamp(),
        startedAt: null, completedAt: null, workMs: 0, lastResumeAt: null,
        history: [{ at: Timestamp.now(), by: me.uid, action: `Assigned to ${names}` }]
      });
      toast(people.length > 1 ? `Task assigned to ${names}` : "Task assigned");
    }
    $("taskModal").close();
  } catch (err) { toast(niceErr(err)); }
};

// ---------- dashboard ----------
function renderDashboard() {
  if (!me) return;
  const all = Object.values(tasks);
  const weekAgo = Date.now() - 7 * 86400000;
  const done7 = all.filter((t) => t.status === "Completed" && toDate(t.completedAt)?.getTime() > weekAgo);
  const doneAll = all.filter((t) => t.status === "Completed");
  const avg = doneAll.length ? doneAll.reduce((s, t) => s + workMs(t), 0) / doneAll.length : 0;
  const kpi = [
    ["Open tasks", all.filter((t) => t.status !== "Completed").length],
    ["In progress", all.filter((t) => t.status === "In Progress").length],
    ["Completed (7 days)", done7.length],
    ["Overdue", all.filter(isOverdue).length],
    ["Avg time / task", fmtDur(avg) || "–"]
  ];
  const tone = { "Overdue": "red", "Completed (7 days)": "green" };
  $("kpis").innerHTML = kpi.map(([l, n]) => `<div class="card glass ${tone[l] || ""}"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join("");

  const people = {};
  all.forEach((t) => assigneesOf(t).forEach((id) => (people[id] ??= []).push(t)));
  $("byPerson").querySelector("tbody").innerHTML = Object.entries(people)
    .sort((a, b) => userName(a[0]).localeCompare(userName(b[0])))
    .map(([uid, ts]) => {
      const c = (s) => ts.filter((t) => t.status === s).length;
      const done = ts.filter((t) => t.status === "Completed");
      const a = done.length ? done.reduce((s, t) => s + workMs(t), 0) / done.length : 0;
      const od = ts.filter(isOverdue).length;
      return `<tr><td>${esc(userName(uid))}</td><td>${esc(users[uid]?.designation || ROLE_LABEL[users[uid]?.role] || "")}</td><td>${esc(managersOf(uid).map(userName).join(", "))}</td>
        <td>${c("Not Started")}</td><td>${c("In Progress")}</td><td>${c("On Hold")}</td>
        <td>${ts.filter((t) => t.status === "Completed" && toDate(t.completedAt)?.getTime() > weekAgo).length}</td>
        <td>${fmtDur(a) || "–"}</td><td>${od ? `<span class="badge s-overdue">${od}</span>` : 0}</td></tr>`;
    }).join("");

  const byProj = {};
  all.forEach((t) => (byProj[t.projectId] ??= []).push(t));
  $("byProject").querySelector("tbody").innerHTML = Object.entries(byProj)
    .map(([pid, ts]) => `<tr><td>${esc(projects[pid]?.name || ts[0].projectName)}</td><td>${ts.length}</td>
      <td>${ts.filter((t) => t.status !== "Completed").length}</td><td>${ts.filter((t) => t.status === "Completed").length}</td>
      <td>${ts.filter(isOverdue).length}</td><td>${fmtDur(ts.reduce((s, t) => s + workMs(t), 0)) || "–"}</td></tr>`).join("");

  $("overdueTable").querySelector("tbody").innerHTML = all.filter(isOverdue)
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((t) => `<tr class="overdue"><td>${esc(t.title)}</td><td>${esc(projects[t.projectId]?.name || t.projectName)}</td>
      <td>${esc(assigneesOf(t).map(userName).join(", "))}</td><td>${esc(t.due)}</td><td>${esc(stLabel(t.status))}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted">Nothing overdue 🎉</td></tr>`;
}

// ---------- projects ----------
// Business details (client, brand, LLC, type, revenue, manager) live in projectDetails/{id},
// which only supervisors and the senior can read. Officers only see project names.
let editingProjectId = null;
$("newProjectBtn").onclick = () => openProjectModal(null);
$("projectCancel").onclick = () => $("projectModal").close();
const desigOf = (u) => u?.designation || (u?.role === "senior" ? "Senior Supervisor" : u?.role === "supervisor" ? "Supervisor" : u?.role === "member" ? "Ecommerce Officer" : "");
const supervisorsList = () => Object.values(users).filter((u) => u.role !== "pending" && ["Supervisor", "Senior Supervisor"].includes(desigOf(u)))
  .sort((a, b) => a.name.localeCompare(b.name));
const clientKey = (n) => String(n || "").trim().toLowerCase();

function openProjectModal(p) {
  editingProjectId = p?.id || null;
  const d = (p && projectDetails[p.id]) || {};
  $("projectModalTitle").textContent = p ? "Edit project" : "New project";
  $("clientList").innerHTML = [...new Set(Object.values(projectDetails).map((x) => x.clientName).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}">`).join("");
  setOptions($("pManager"), supervisorsList().map((u) => [u.uid, u.name]), "– choose –");
  $("pClient").value = d.clientName || ""; $("pClientEmail").value = d.clientEmail || "";
  $("pClientId").value = d.clientId || ""; $("pDoj").value = d.doj || ""; $("pNum").value = d.numProjects ?? "";
  $("pLlc").value = d.llcName || ""; $("pType").value = d.projectType || "";
  $("pRevenue").value = d.revenue ?? "";
  $("pManager").value = d.managerId || (isSup() ? me.uid : "");
  $("clientLimitMsg").textContent = "";
  $("projectModal").showModal();
}
$("projectForm").onsubmit = async (e) => {
  e.preventDefault();
  const client = $("pClient").value.trim();
  const name = projName({ clientName: client, llcName: $("pLlc").value.trim() });
  if (!client) return;
  const sameClient = Object.values(projects).filter((p) => p.id !== editingProjectId && p.active !== false &&
    clientKey(projectDetails[p.id]?.clientName) === clientKey(client));
  if (sameClient.length >= MAX_PROJECTS_PER_CLIENT) {
    $("clientLimitMsg").textContent = `${client} already has ${MAX_PROJECTS_PER_CLIENT} active projects. End one first.`;
    return;
  }
  const rev = $("pRevenue").value;
  const details = {
    clientName: client, clientEmail: $("pClientEmail").value.trim(), llcName: $("pLlc").value.trim(),
    clientId: $("pClientId").value.trim(), doj: $("pDoj").value, numProjects: $("pNum").value === "" ? null : Number($("pNum").value),
    projectType: $("pType").value, revenue: rev === "" ? null : Number(rev), managerId: $("pManager").value,
    teamId: editingProjectId ? teamOf(projects[editingProjectId]) : viewTeam,
    updatedAt: serverTimestamp(), updatedBy: me.uid
  };
  try {
    let id = editingProjectId;
    if (id) await updateDoc(doc(db, "projects", id), { name });
    else id = (await addDoc(collection(db, "projects"), { name, active: true, teamId: viewTeam, createdBy: me.uid, createdAt: serverTimestamp() })).id;
    await setDoc(doc(db, "projectDetails", id), details, { merge: true });
    $("projectModal").close(); toast(editingProjectId ? "Project updated" : "Project added");
  } catch (err) { toast(niceErr(err)); }
};

function revenueOf(filterFn) {
  return Object.values(projects).filter((p) => p.active !== false && filterFn(p, projectDetails[p.id] || {}))
    .reduce((s, p) => s + (Number(projectDetails[p.id]?.revenue) || 0), 0);
}
function targetCard(title, subtitle, amount, t) {
  const max = t.promo * 1.1;
  const pct = Math.min(100, (amount / max) * 100);
  const pos = (v) => (v / max) * 100;
  const st = amount >= t.promo ? ["st-promo", "🏆 Promotion target reached"]
    : amount >= t.min ? ["st-min", `Minimum met · ${money(t.promo - amount)} to promotion`]
    : ["st-below", `${money(t.min - amount)} below minimum`];
  return `<div class="rev-card glass">
    <div class="who">${esc(title)}</div><div class="sub">${esc(subtitle)}</div>
    <div class="amt">${money(amount)}</div>
    <div class="sub">Minimum ${money(t.min)} · Promotion ${money(t.promo)}</div>
    <div class="bar"><div class="fill" style="width:${pct}%"></div>
      <span class="mark" style="left:${pos(t.min)}%"></span><span class="mark" style="left:${pos(t.promo)}%"></span></div>
    <div class="bar-legend"><span>$0</span><span>Min ${money(t.min)}</span><span>Promo ${money(t.promo)}</span></div>
    <span class="status-pill ${st[0]}">${st[1]}</span>
  </div>`;
}
function renderRevenue() {
  const total = revenueOf(() => true);
  const archived = Object.values(projects).filter((p) => p.active === false)
    .reduce((s, p) => s + (Number(projectDetails[p.id]?.revenue) || 0), 0);
  const cards = [];
  const kpis = `<div class="cards">
    <div class="card glass green"><div class="num">${money(total)}</div><div class="lbl">Total revenue (current projects)</div></div>
    <div class="card glass"><div class="num">${Object.values(projects).filter((p) => p.active !== false).length}</div><div class="lbl">Current projects</div></div>
    <div class="card glass"><div class="num">${new Set(Object.values(projects).filter((p) => p.active !== false).map((p) => clientKey(projectDetails[p.id]?.clientName)).filter(Boolean)).size}</div><div class="lbl">Current clients</div></div>
    <div class="card glass red"><div class="num">${money(archived)}</div><div class="lbl">Ended (not counted)</div></div>
  </div>`;
  const seen = (u) => u.role !== "pending" && (isSenior() || u.uid === me.uid);
  Object.values(users).filter((u) => seen(u) && desigOf(u) === "Senior Supervisor")
    .forEach((u) => cards.push(targetCard(u.name, "Senior Supervisor · all current projects", total, TARGETS.senior)));
  const sups = Object.values(users).filter((u) => seen(u) && desigOf(u) === "Supervisor");
  sups.forEach((u) => cards.push(targetCard(u.name, "Supervisor · projects they manage",
    revenueOf((p, d) => d.managerId === u.uid), TARGETS.supervisor)));
  $("revenuePanel").innerHTML = `<h3 style="margin-top:6px">Revenue</h3>` + kpis + `<h3>Revenue targets</h3><div class="rev-grid">${cards.join("")}</div>`;
}

function projRow(p, archived) {
  const d = projectDetails[p.id] || {};
  const mgrOpts = [["", "– choose –"], ...supervisorsList().map((u) => [u.uid, u.name])];
  if (d.managerId && !mgrOpts.some(([v]) => v === d.managerId)) mgrOpts.push([d.managerId, userName(d.managerId)]);
  return `<tr>
    <td class="client-cell"><b>${ed("proj", p.id, "clientName", d.clientName)}</b>
      <div class="client-id">ID: ${ed("proj", p.id, "clientId", d.clientId, d.clientId ? esc(d.clientId) : '<span class="ph">add</span>')}</div></td>
    <td>${ed("proj", p.id, "clientEmail", d.clientEmail, d.clientEmail ? `<a href="mailto:${esc(d.clientEmail)}">${esc(d.clientEmail)}</a>` : "", "email")}</td>
    <td>${dateInl("proj", p.id, "doj", d.doj)}</td>
    <td>${ed("proj", p.id, "llcName", d.llcName)}</td>
    <td>${sel("proj", p.id, "projectType", d.projectType || "", [["", "– select –"], ["Half Time", "Half Time"], ["Full Time", "Full Time"]], true, `data-pt="${esc(d.projectType || "")}"`)}</td>
    <td><b>${ed("proj", p.id, "revenue", d.revenue ?? "", d.revenue === null || d.revenue === undefined || d.revenue === "" ? "" : money(d.revenue), "number")}</b></td>
    <td>${ed("proj", p.id, "numProjects", d.numProjects ?? "", d.numProjects ?? "", "number")}</td>
    <td>${sel("proj", p.id, "managerId", d.managerId || "", mgrOpts)}</td>
    <td><div class="actions"><button class="secondary small-btn" data-pact="toggle" data-id="${p.id}">${archived ? "Restore" : "End"}</button>
      ${isSenior() ? `<button class="secondary small-btn" data-pact="delete" data-id="${p.id}">Delete</button>` : ""}</div></td></tr>`;
}
function renderProjects() {
  if (!isStaff()) return;
  const all = Object.values(projects);
  const sortFn = (a, b) => (projectDetails[a.id]?.clientName || "").localeCompare(projectDetails[b.id]?.clientName || "") || a.name.localeCompare(b.name);
  const active = all.filter((p) => p.active !== false).sort(sortFn);
  const archived = all.filter((p) => p.active === false).sort(sortFn);
  const total = active.reduce((s, p) => s + (Number(projectDetails[p.id]?.revenue) || 0), 0);
  const nTotal = active.reduce((s, p) => s + (Number(projectDetails[p.id]?.numProjects) || 0), 0);
  $("activeProjTable").querySelector("tbody").innerHTML = active.length
    ? active.map((p) => projRow(p, false)).join("") +
      `<tr class="total-row"><td colspan="5">Total (current projects)</td><td>${money(total)}</td><td>${nTotal || ""}</td><td colspan="2"></td></tr>`
    : `<tr><td colspan="9" class="muted">No current projects yet. Click + Add project.</td></tr>`;
  $("archivedProjTable").querySelector("tbody").innerHTML = archived.length
    ? archived.map((p) => projRow(p, true)).join("")
    : `<tr><td colspan="9" class="muted">No ended projects.</td></tr>`;
  renderRevenue();
}
$("tab-projects").onclick = async (e) => {
  const b = e.target.closest("button[data-pact]"); if (!b) return;
  const p = projects[b.dataset.id]; if (!p) return;
  try {
    if (b.dataset.pact === "toggle") {
      if (p.active === false) {
        const c = clientKey(projectDetails[p.id]?.clientName);
        const n = Object.values(projects).filter((x) => x.active !== false && clientKey(projectDetails[x.id]?.clientName) === c).length;
        if (c && n >= MAX_PROJECTS_PER_CLIENT) { toast(`This client already has ${MAX_PROJECTS_PER_CLIENT} active projects.`); return; }
      } else if (!confirm(`End "${p.name}"? Its revenue will no longer count in totals.`)) return;
      await updateDoc(doc(db, "projects", p.id), { active: p.active === false });
    }
    if (b.dataset.pact === "delete" && confirm(`Delete project "${p.name}" permanently? Its tasks stay.`)) {
      await deleteDoc(doc(db, "projects", p.id));
      await deleteDoc(doc(db, "projectDetails", p.id)).catch(() => {});
    }
  } catch (err) { toast(niceErr(err)); }
};

// ---------- team ----------
function renderTeam() {
  if (!isSenior()) return;
  const all = Object.values(users);
  const pending = all.filter((u) => u.role === "pending").sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));
  $("pendingTable").querySelector("tbody").innerHTML = pending.map((u) => `<tr>
      <td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${esc(u.phone || "")}</td><td>${esc(u.employeeId || "")}</td>
      <td>${fmtDT(u.createdAt)}</td>
      <td><select data-approve="${u.uid}"><option value="">– choose –</option>
        <option value="member|Ecommerce Officer">Ecommerce Officer · Task Access</option><option value="supervisor|Supervisor">Supervisor · Manager</option><option value="senior|Senior Supervisor">Senior Supervisor · Admin</option></select></td>
      <td><button class="secondary small-btn" data-uact="reject" data-id="${u.uid}">Reject</button></td></tr>`).join("")
    || `<tr><td colspan="7" class="muted">No one waiting for approval.</td></tr>`;

  const sups = supervisorsList().filter((x) => desigOf(x) === "Supervisor");
  const supPool = sups.length ? sups : supervisorsList();
  const order = { "Senior Supervisor": 0, "Supervisor": 1, "Ecommerce Officer": 2 };
  const team = all.filter((u) => u.role !== "pending")
    .sort((a, b) => ((order[desigOf(a)] ?? 3) - (order[desigOf(b)] ?? 3)) || a.name.localeCompare(b.name));
  const keepSel = (el, opts, ph) => { const v = el.value; setOptions(el, opts, ph); el.value = v; };
  keepSel($("iDesig"), DESIGNATIONS.map((d) => [d, d]), "Designation");
  keepSel($("iRole"), ["member", "supervisor", "senior"].map((r) => [r, ROLE_LABEL[r]]), "Access");
  keepSel($("iSup"), supPool.map((x) => [x.uid, x.name]), "Managed by (supervisor)");
  $("iSup").classList.toggle("hidden", $("iDesig").value !== "Ecommerce Officer");
  $("inviteTable").querySelector("tbody").innerHTML = Object.values(invites)
    .sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0))
    .map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.designation)}</td><td>${esc(ROLE_LABEL[i.role] || i.role)}</td>
      <td>${esc(i.supervisorId ? userName(i.supervisorId) : "")}</td><td>${fmtDT(i.createdAt)}</td>
      <td><div class="actions"><button class="secondary small-btn" data-iact="resend" data-id="${esc(i.email)}">Resend</button>
      <button class="secondary small-btn" data-iact="cancel" data-id="${esc(i.email)}">Cancel</button></div></td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No pending invites.</td></tr>`;
  $("teamTable").querySelector("tbody").innerHTML = team.map((u) => {
    const self = u.uid === me.uid;
    const officer = desigOf(u) === "Ecommerce Officer";
    const pool = supPool.filter((x) => x.uid !== u.uid);
    return `<tr>
      <td><div class="person">${avatarHtml(u, "sm")}<b>${ed("user", u.uid, "name", u.name)}</b></div></td><td>${esc(u.email)}</td>
      <td>${ed("user", u.uid, "phone", u.phone)}</td>
      <td>${ed("user", u.uid, "employeeId", u.employeeId)}</td>
      <td>${dateInl("user", u.uid, "doj", u.doj)}</td>
      <td>${sel("user", u.uid, "designation", u.designation || "", [["", "– choose –"], ...DESIGNATIONS.map((d) => [d, d])])}</td>
      <td>${sel("user", u.uid, "role", u.role, ["member", "supervisor", "senior"].map((r) => [r, ROLE_LABEL[r]]), !self)}</td>
      <td>${self ? '<span class="muted small">—</span>' : mselBtn("mgr:" + u.uid, managersOf(u.uid))}</td>
      <td>${self ? "" : `<button class="secondary small-btn" data-uact="remove" data-id="${u.uid}">Remove access</button>`}</td>
    </tr>`;
  }).join("");
}
$("iDesig").addEventListener("change", () => $("iSup").classList.toggle("hidden", $("iDesig").value !== "Ecommerce Officer"));
const inviteUrl = (email) => `${location.origin}${location.pathname}?invite=${encodeURIComponent(email)}`;
async function sendInvite(email) {
  await sendSignInLinkToEmail(auth, email, { url: inviteUrl(email), handleCodeInApp: true });
}
$("inviteForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("iEmail").value.trim().toLowerCase(), designation = $("iDesig").value, role = $("iRole").value;
  const supervisorId = designation === "Ecommerce Officer" ? $("iSup").value : "";
  if (!email || !designation || !role) return;
  if (Object.values(allUsers).some((u) => String(u.email).toLowerCase() === email)) { toast("This email already has an account."); return; }
  $("inviteBtn").disabled = true;
  try {
    await setDoc(doc(db, "invites", email), { email, designation, role, supervisorId, teamId: viewTeam, doj: $("iDoj").value || "", invitedBy: me.uid, createdAt: serverTimestamp() });
    await sendInvite(email);
    $("iEmail").value = ""; $("iDoj").value = ""; toast(`Invite sent to ${email}`);
  } catch (err) {
    toast(String(err?.code || "").includes("quota") ? "Daily invite limit reached (5 per day on the free plan). Try tomorrow." : niceErr(err));
  }
  $("inviteBtn").disabled = false;
};
$("tab-team").onchange = async (e) => {
  const el = e.target;
  if (el.closest("#inviteForm")) return;
  try {
    if (el.dataset.approve) {
      if (!el.value) return;
      const [role, designation] = el.value.split("|");
      await updateDoc(doc(db, "users", el.dataset.approve), { role, designation });
      toast(`Approved as ${designation}`); return;
    }
  } catch (err) { toast(niceErr(err)); }
};
$("tab-team").onclick = async (e) => {
  const ib = e.target.closest("button[data-iact]");
  if (ib) {
    try {
      if (ib.dataset.iact === "resend") { await sendInvite(ib.dataset.id); toast("Invite sent again"); }
      if (ib.dataset.iact === "cancel" && confirm(`Cancel invite for ${ib.dataset.id}?`)) { await deleteDoc(doc(db, "invites", ib.dataset.id)); toast("Invite cancelled"); }
    } catch (err) { toast(String(err?.code || "").includes("quota") ? "Daily invite limit reached (5 per day on the free plan). Try tomorrow." : niceErr(err)); }
    return;
  }
  const b = e.target.closest("button[data-uact]"); if (!b) return;
  const u = users[b.dataset.id]; if (!u) return;
  try {
    if (b.dataset.uact === "remove" && confirm(`Remove ${u.name}'s access? Their tasks stay.`)) {
      await updateDoc(doc(db, "users", u.uid), { role: "pending" }); toast("Access removed");
    }
    if (b.dataset.uact === "reject" && confirm(`Reject and delete ${u.name}'s sign-up?`)) {
      await deleteDoc(doc(db, "users", u.uid)); toast("Sign-up rejected");
    }
  } catch (err) { toast(niceErr(err)); }
};

// ---------- CSV export ----------
$("exportBtn").onclick = () => {
  const rows = [["ID", "Task", "Description", "Project", "Assigned to", "Assigned by", "Supervisor", "Priority", "Due",
    "Status", "Overdue", "Assigned at", "Started at", "Completed at", "Time taken (hours)", "Notes"]];
  filteredTasks(currentTab === "completed" ? "done" : "open").forEach((t) => rows.push([
    shortId(t.id), t.title, t.desc, projects[t.projectId]?.name || t.projectName, assigneesOf(t).map(userName).join(", "),
    userName(t.assignedById), userName(t.supervisorId), t.priority, t.due, stLabel(t.status) + (isOngoing(t) ? ` (Ongoing · ${t.recurrence})` : ""), isOverdue(t) ? "Yes" : "No",
    toDate(t.assignedAt)?.toLocaleString() || "", toDate(t.startedAt)?.toLocaleString() || "",
    toDate(t.completedAt)?.toLocaleString() || "", isOngoing(t) ? `Est. ${t.estimate || ""}` : (workMs(t) / 3600000).toFixed(2), t.notes
  ]));
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" }));
  a.download = `${teamName(viewTeam).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

// ---------- profile ----------
function renderMe() {
  if (!me) return;
  $("whoami").textContent = me.name || "";
  $("whoDesig").textContent = desigOf(me) || ROLE_LABEL[me.role] || "";
  $("meAvatar").outerHTML = avatarHtml(me).replace('class="avatar ', 'id="meAvatar" class="avatar ');
}
$("profileBtn").onclick = (e) => { e.stopPropagation(); $("profileMenu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest(".profile-wrap")) $("profileMenu").classList.add("hidden"); });
let pfPhoto;
function pfShowAvatar() { $("pfAvatar").outerHTML = avatarHtml({ name: $("pfName").value || me.name, photo: pfPhoto }, "xl").replace('class="avatar ', 'id="pfAvatar" class="avatar '); }
$("openProfile").onclick = () => {
  $("profileMenu").classList.add("hidden");
  pfPhoto = me.photo || "";
  $("pfName").value = me.name || ""; $("pfPhone").value = me.phone || "";
  $("pfCurPass").value = ""; $("pfNewPass").value = ""; $("pfMsg").textContent = "";
  const info = [["Email", me.email], ["Employee ID", me.employeeId], ["Designation", desigOf(me)], ["Access", ROLE_LABEL[me.role]],
    ["Date of joining", fmtDay(me.doj)], ["Managed by", me.supervisorId ? userName(me.supervisorId) : ""]];
  $("pfInfo").innerHTML = info.map(([k, v]) => `<div><span>${k}</span><b>${v ? (k === "Date of joining" ? v : esc(v)) : "—"}</b></div>`).join("");
  pfShowAvatar(); $("profileModal").showModal();
};
$("pfCancel").onclick = () => $("profileModal").close();
$("pfName").oninput = () => { if (!pfPhoto) pfShowAvatar(); };
$("pfRemovePhoto").onclick = () => { pfPhoto = ""; pfShowAvatar(); };
$("pfPhoto").onchange = async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
    const S = 200, c = document.createElement("canvas"); c.width = c.height = S;
    const m = Math.min(img.width, img.height);
    c.getContext("2d").drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
    pfPhoto = c.toDataURL("image/jpeg", 0.82); pfShowAvatar();
  } catch { $("pfMsg").textContent = "Couldn't read that image. Try a JPG or PNG."; }
  e.target.value = "";
};
$("profileForm").onsubmit = async (e) => {
  e.preventDefault(); $("pfSave").disabled = true; $("pfMsg").textContent = "";
  try {
    const name = $("pfName").value.trim();
    await updateDoc(doc(db, "users", me.uid), { name, phone: $("pfPhone").value.trim(), photo: pfPhoto || "" });
    if (name !== auth.currentUser.displayName) await updateProfile(auth.currentUser, { displayName: name }).catch(() => {});
    const np = $("pfNewPass").value;
    if (np) {
      if (np.length < 6) throw { code: "weak-password" };
      const cred = EmailAuthProvider.credential(auth.currentUser.email, $("pfCurPass").value);
      await reauthenticateWithCredential(auth.currentUser, cred);
      await updatePassword(auth.currentUser, np);
    }
    $("profileModal").close(); toast(np ? "Profile and password updated" : "Profile updated");
  } catch (err) {
    $("pfMsg").textContent = String(err?.code || "").includes("invalid-credential") || String(err?.code || "").includes("wrong-password")
      ? "Current password is wrong." : niceErr(err);
  }
  $("pfSave").disabled = false;
};

// ---------- desktop notifications (new task assigned to me) ----------
const NOTIF_KEY = () => `ta-notified-${me?.uid}`;
let notifReady = false;
function setupNotifications() {
  notifReady = false;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    const ask = () => { Notification.requestPermission(); document.removeEventListener("click", ask); };
    document.addEventListener("click", ask);
  }
}
function notifyNewAssignments(snap) {
  if (!me) return;
  let seen; try { seen = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "{}"); } catch { seen = {}; }
  const first = !localStorage.getItem(NOTIF_KEY());
  const fresh = [];
  snap.docChanges().forEach((ch) => {
    const t = { id: ch.doc.id, ...ch.doc.data() };
    if (!isAssignee(t) || t.status === "Completed") return;
    const key = t.id + "|" + me.uid;
    if (seen[key]) return;
    seen[key] = 1;
    // only alert for tasks given by someone else, and not the old backlog on first launch
    if (!first && t.assignedById !== me.uid && (ch.type === "added" || ch.type === "modified")) fresh.push(t);
  });
  localStorage.setItem(NOTIF_KEY(), JSON.stringify(seen));
  if (!fresh.length) return;
  fresh.forEach((t) => toast(`New task: ${t.title}`));
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const show = (title, body, tag) => {
    const n = new Notification(title, { body, icon: "favicon.png?v=2", tag, requireInteraction: false });
    n.onclick = () => { window.focus(); switchTab("tasks"); n.close(); };
  };
  if (fresh.length > 3) show(teamName(viewTeam), `You have ${fresh.length} new tasks assigned.`, "bulk");
  else fresh.forEach((t) => show("New task assigned", `${t.title}\n${projects[t.projectId]?.name || t.projectName || ""} · from ${userName(t.assignedById)}${t.recurrence ? " · Ongoing " + t.recurrence : t.due ? " · due " + t.due : ""}`, t.id));
}

// ---------- v9: phone card labels (copies each column header onto its cells) ----------
function labelCells(root = document) {
  root.querySelectorAll(".table-wrap table").forEach((tbl) => {
    const heads = [...tbl.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    tbl.querySelectorAll("tbody tr").forEach((tr) => {
      let i = 0;
      [...tr.children].forEach((td) => {
        const span = Number(td.getAttribute("colspan") || 1);
        const h = span > 1 ? "" : heads[i] || "";
        if (h && !td.classList.contains("title-cell")) td.setAttribute("data-label", h); else td.removeAttribute("data-label");
        if (!h) td.classList.add("nolabel");
        i += span;
      });
    });
  });
}
new MutationObserver(() => { clearTimeout(labelCells._t); labelCells._t = setTimeout(labelCells, 30); })
  .observe(document.body, { childList: true, subtree: true });
