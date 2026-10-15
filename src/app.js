/* AttendX Web: responsive port of the uploaded desktop project.
 * Supabase is the shared source of truth; no database passwords or service keys are stored here.
 */
'use strict';

import './styles.css';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import * as faceapi from '@vladmandic/face-api';

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_PUBLIC_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
const supabase = SUPABASE_URL && SUPABASE_PUBLIC_KEY
  ? createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
      global: { headers: { 'X-Client-Info': 'attendx-web/1.0' } }
    })
  : null;
const FACE_MODEL_PATH = String(import.meta.env.VITE_FACE_MODEL_URL || 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model').replace(/\/$/, '');
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function todayISO() { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date()); const p = Object.fromEntries(parts.map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; }
function localDateTimeValue(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function currentDayName() { return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone:'Asia/Manila' }).format(new Date()); }
function manilaWeekStart(dateText = todayISO()) {
  const [year, month, day] = dateText.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function recordsForPeriod(records, period = teacherPeriod) {
  const today = todayISO();
  if (period === 'today') return records.filter(item => item.date === today);
  if (period === 'week') return records.filter(item => item.date >= manilaWeekStart(today) && item.date <= today);
  return records.filter(item => item.date.slice(0,7) === today.slice(0,7));
}
function periodLabel(period = teacherPeriod) {
  return period === 'today' ? 'Today' : period === 'week' ? 'This week' : 'This month';
}
function emptyData() {
  return { version: 2, users: [], subjects: [], schedules: [], enrollments: [], attendance: [], qrTokens: {} };
}
let data = emptyData();
let currentUserId = null;
let view = 'home';
let authRole = 'student';
let authMode = 'login';
let activePage = 'dashboard';
let modal = null;
let toastTimer = null;
let classSearch = '';
let recordSearch = '';
let studentSearch = '';
let teacherPeriod = 'today';
let selectedTeacherSchedule = '';
let authSession = null;
let qrScanner = null;
let faceStream = null;
let faceRegStream = null;
let faceDetectionLoop = false;
let faceModelsReady = false;
let faceModelsPromise = null;
let fingerprintPort = null;
let fingerprintReader = null;
let fingerprintWriter = null;
let fingerprintReadPump = null;
let fingerprintIncomingBytes = [];
let fingerprintPacketQueue = [];
let fingerprintPacketWaiters = [];
let fingerprintScanActive = false;
let fingerprintCapacity = 127;
let fingerprintLocalDeviceId = null;
function getFingerprintDeviceId() {
  if (fingerprintLocalDeviceId) return fingerprintLocalDeviceId;
  try {
    const saved = window.localStorage.getItem('attendx-fingerprint-reader-id');
    if (saved && /^[a-zA-Z0-9._:-]{1,64}$/.test(saved)) {
      fingerprintLocalDeviceId = saved;
      return saved;
    }
  } catch { /* storage can be disabled by browser privacy settings */ }
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const random = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  fingerprintLocalDeviceId = `attendx-${random}`;
  try { window.localStorage.setItem('attendx-fingerprint-reader-id', fingerprintLocalDeviceId); } catch {}
  return fingerprintLocalDeviceId;
}
let liveAttendanceEntries = [];
let cameraBusy = false;
let faceRegistered = false;
let refreshTimer = null;

const iconMap = {
  dashboard: '▦', subjects: '▤', browse: '⌕', attendance: '◷', qr: '▦', profile: '◎',
  schedule: '▤', addSchedule: '＋', students: '♙', center: '◉', records: '▥', catalog: '▧', guide: 'ⓘ', logout: '↪'
};
function saveData() {
  // Supabase is the source of truth. Database writes are explicit/awaited at each action.
  // Kept as a harmless compatibility helper for older render functions.
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}
function fullName(user) {
  if (!user) return 'Unknown user';
  return [user.firstName, user.middleName, user.lastName, user.suffix].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
function initials(user) { return `${user?.firstName?.[0] || 'A'}${user?.lastName?.[0] || 'X'}`.toUpperCase(); }
function currentUser() { return data.users.find(user => user.id === currentUserId) || null; }
function userById(id) { return data.users.find(user => user.id === id) || null; }
function roleName(role) { return role === 'teacher' ? 'Teacher' : 'Student'; }
function shortDate(date) {
  if (!date) return '—';
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function time12(time) {
  if (!time) return '—';
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}
function scheduleLabel(schedule) {
  if (!schedule) return 'Unknown class';
  return `${schedule.subject} · ${schedule.course} ${schedule.year} / ${schedule.section}`;
}
function scheduleById(id) { return data.schedules.find(schedule => schedule.id === id) || null; }
function getTeacherSchedules(userId) { return data.schedules.filter(schedule => schedule.teacherId === userId); }
function getStudentSchedules(userId) {
  const ids = data.enrollments.filter(item => item.studentId === userId).map(item => item.scheduleId);
  return data.schedules.filter(schedule => ids.includes(schedule.id));
}
function enrolledStudents(scheduleId) {
  const ids = data.enrollments.filter(item => item.scheduleId === scheduleId).map(item => item.studentId);
  return data.users.filter(user => user.role === 'student' && ids.includes(user.id));
}
function attendanceForStudent(userId) {
  return data.attendance.filter(record => record.studentId === userId).sort((a,b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}
function attendanceForTeacher(userId) {
  const scheduleIds = getTeacherSchedules(userId).map(schedule => schedule.id);
  return data.attendance.filter(record => scheduleIds.includes(record.scheduleId)).sort((a,b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}
function getRecord(userId, scheduleId, date) {
  return data.attendance.find(record => record.studentId === userId && record.scheduleId === scheduleId && record.date === date);
}
function statusClass(status) {
  if (status === 'PRESENT') return 'present';
  if (status === 'LATE') return 'late';
  if (status === 'LATE-ABSENT' || status === 'LATE ABSENT' || status === 'ABSENT') return 'late-absent';
  return 'active';
}
function badge(status) { return `<span class="status ${statusClass(status)}">${esc(status || 'ACTIVE')}</span>`; }
function teacherFor(schedule) { return userById(schedule?.teacherId); }
function displayDateTime() {
  const d = new Date();
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}
function toast(message, duration = 3100) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function requireCloud() {
  if (!supabase) throw new Error('Supabase is not configured. Copy .env.example to .env, then set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  return supabase;
}
function cleanHumanText(value, max = 80) { return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max); }
function accountEmail(accountId) {
  const normalized = cleanHumanText(accountId, 40).toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) { hash ^= normalized.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  const slug = normalized.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'account';
  return `ax-${slug}-${hash.toString(36)}@attendx.example.com`;
}
function mapProfile(row) {
  return {
    id: row.id, role: row.role, accountId: row.account_id || '',
    firstName: row.first_name || '', middleName: row.middle_name || '', lastName: row.last_name || '', suffix: row.suffix || '',
    sex: row.sex || '', course: row.course || '', year: row.year_level || '', section: row.section || '',
    department: row.department || '', office: row.office || '', status: row.status || 'ACTIVE'
  };
}
function mapSchedule(row) {
  return { id: row.id, teacherId: row.teacher_id, course: row.course, subject: row.subject,
    section: row.section, year: row.year_level, day: row.day, startTime: String(row.start_time).slice(0,5),
    endTime: String(row.end_time).slice(0,5), status: row.status || 'ACTIVE' };
}
function mapAttendance(row) {
  return { id: row.id, studentId: row.student_id, scheduleId: row.schedule_id,
    date: String(row.attendance_date).slice(0,10), time: String(row.attendance_time), status: row.status, method: row.method };
}
function dedupeById(items) { const map = new Map(); for (const item of items) if (item?.id) map.set(item.id, item); return [...map.values()]; }
async function refreshWorkspaceData({ silent = false } = {}) {
  if (!supabase || !currentUserId) return;
  try {
    const [profilesRes, teacherDirectoryRes, subjectsRes, schedulesRes, enrollmentsRes, attendanceRes] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('attendx_teacher_directory').select('id,role,first_name,middle_name,last_name,suffix,department,status'),
      supabase.from('subjects').select('name').eq('status','ACTIVE').order('name'),
      supabase.from('schedules').select('*').order('day').order('start_time'),
      supabase.from('enrollments').select('student_id,schedule_id'),
      supabase.from('attendance').select('*').order('attendance_date',{ascending:false}).order('attendance_time',{ascending:false})
    ]);
    for (const result of [profilesRes, teacherDirectoryRes, subjectsRes, schedulesRes, enrollmentsRes, attendanceRes]) {
      if (result.error) throw result.error;
    }
    const profileRows = profilesRes.data || [];
    const ownRow = profileRows.find(row => row.id === currentUserId);
    if (!ownRow) throw new Error('The account profile is missing or not visible. Verify the migration and registration function configuration, then sign in again.');
    const publicTeacherRows = (teacherDirectoryRes.data || []).map(row => ({ ...row, account_id: '', sex: '' }));
    data.users = dedupeById([...publicTeacherRows.map(mapProfile), ...profileRows.map(mapProfile)]);
    data.subjects = (subjectsRes.data || []).map(row => row.name);
    data.schedules = (schedulesRes.data || []).map(mapSchedule);
    data.enrollments = (enrollmentsRes.data || []).map(row => ({ studentId: row.student_id, scheduleId: row.schedule_id }));
    data.attendance = (attendanceRes.data || []).map(mapAttendance);
    data.qrTokens = {};
    if (ownRow.role === 'student') {
      const { data: qrRows, error: qrError } = await supabase.from('qr_tokens').select('schedule_id,token').eq('student_id', currentUserId);
      if (qrError) throw qrError;
      for (const row of qrRows || []) data.qrTokens[`${currentUserId}:${row.schedule_id}`] = row.token;
      const { data: faceRow, error: faceError } = await supabase.from('face_templates').select('student_id').eq('student_id', currentUserId).maybeSingle();
      if (faceError) throw faceError;
      faceRegistered = Boolean(faceRow);
    } else { faceRegistered = false; }
    if (!silent && view !== 'home' && view !== 'auth') renderApp();
  } catch (error) {
    console.error('AttendX refresh failed:', error);
    if (!silent) toast(`Could not refresh cloud data: ${error.message || error}`);
  }
}
async function readFunctionError(error, responseData) {
  if (responseData?.error) return new Error(responseData.error);
  if (error?.context && typeof error.context.json === 'function') {
    try { const body = await error.context.json(); if (body?.error) return new Error(body.error); } catch { /* use SDK message */ }
  }
  return new Error(error?.message || 'The server request failed.');
}
async function signedInProfile() {
  const client = requireCloud();
  const { data: { session }, error } = await client.auth.getSession();
  if (error) throw error;
  authSession = session;
  if (!session?.user) return null;
  currentUserId = session.user.id;
  await refreshWorkspaceData({ silent: true });
  return currentUser();
}
function liveClockText() {
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true }).format(new Date());
}
function renderIntro() {
  const root = $('#intro-root');
  if (!root) return;
  root.innerHTML = `<div class="intro-glow glow-one"></div><div class="intro-glow glow-two"></div><div class="intro-center"><div class="intro-initializing" id="intro-initializing">INITIALIZING ATTENDX<span class="intro-dots">...</span></div><div class="intro-progress"><span id="intro-progress-fill"></span></div><div class="intro-system" id="intro-system">SMART ATTENDANCE SYSTEM</div><div class="intro-welcome" id="intro-welcome">WELCOME</div><div class="intro-logo" id="intro-logo"><svg viewBox="0 0 120 120" role="img" aria-label="AttendX logo"><path d="M60 8 104 32v56l-44 24L16 88V32Z"/><path d="M31 80 60 27 89 80H74L60 55 46 80Z"/><path d="M48 68h24"/></svg></div><div class="intro-wordmark" id="intro-wordmark">ATTEND<span>X</span></div><div class="intro-tagline">SMART ATTENDANCE SYSTEM</div></div>`;
  $('#app').classList.add('app-hidden');
  root.classList.remove('intro-gone');
  window.setTimeout(() => $('#intro-initializing')?.classList.add('intro-fade'), 720);
  window.setTimeout(() => $('#intro-system')?.classList.add('intro-show'), 750);
  window.setTimeout(() => $('#intro-welcome')?.classList.add('intro-show'), 1100);
  window.setTimeout(() => { $('#intro-logo')?.classList.add('intro-show'); $('#intro-wordmark')?.classList.add('intro-show'); }, 1400);
}
async function startApplication() {
  renderIntro();
  await new Promise(resolve => window.setTimeout(resolve, 2550));
  $('#intro-root')?.classList.add('intro-gone');
  $('#app').classList.remove('app-hidden');
  if (!supabase) { renderHome(); toast('Supabase not configured yet. Copy .env.example to .env and add the public project values.'); return; }
  try {
    const user = await signedInProfile();
    if (user) { view = 'workspace'; activePage = 'dashboard'; renderApp(); }
    else renderHome();
  } catch (error) {
    console.error(error);
    renderHome();
    toast(`Supabase startup check failed: ${error.message || error}`);
  }
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (currentUserId) refreshWorkspaceData({ silent: true }); }, 20000);
}
function applyAttendanceRecord(record) {
  const mapped = record?.date ? {
    id: record.id || makeId('att'), studentId: record.student_id || record.studentId,
    scheduleId: record.schedule_id || record.scheduleId, date: String(record.date).slice(0,10),
    time: String(record.time || '').slice(0,8), status: record.status, method: record.method
  } : mapAttendance(record);
  const index = data.attendance.findIndex(item => item.studentId === mapped.studentId && item.scheduleId === mapped.scheduleId && item.date === mapped.date);
  if (index >= 0) data.attendance[index] = mapped; else data.attendance.unshift(mapped);
  return mapped;
}
async function saveAttendanceViaRpc(studentId, scheduleId, method) {
  const client = requireCloud();
  const { data: result, error } = await client.rpc('record_attendance', {
    p_student_id: studentId, p_schedule_id: scheduleId, p_method: method
  });
  if (error) throw error;
  const record = applyAttendanceRecord(result);
  addLiveAttendee({ id: studentId, name: fullName(userById(studentId)), accountId: userById(studentId)?.accountId || '', status: record.status, method: record.method, time: record.time });
  return record;
}
function addLiveAttendee(entry) {
  if (entry && !liveAttendanceEntries.some(item => item.id === entry.id)) liveAttendanceEntries.unshift(entry);
  const list = $('#live-attended-list');
  if (list) list.innerHTML = liveAttendanceEntries.map(item => `<div class="live-attendee"><span class="live-check">✓</span><div><b>${esc(item.name || 'Student')}</b><small>${esc(item.accountId || '')} · ${esc(item.time || '')} · ${esc(item.method || '')}</small></div>${badge(item.status || 'PRESENT')}</div>`).join('') || `<div class="empty"><strong>Waiting for scans</strong>Verified students will appear here.</div>`;
  const count = $('#live-count'); if (count) count.textContent = `${liveAttendanceEntries.length} scanned`;
}
function resetLiveAttendance() { liveAttendanceEntries = []; addLiveAttendee(null); }
let seenQrTokens = new Set();
let duplicateQrNoticeTokens = new Set();
let seenFaceIds = new Set();
let lastFaceAttemptAt = 0;
let lastFaceNoticeAt = 0;
let lastFaceNoticeMessage = '';
const faceDuplicateNoticeIds = new Set();
async function startQrCamera() {
  const user = currentUser();
  if (!user || user.role !== 'teacher') return toast('Log in as a teacher to scan student QR passes.');
  const scheduleId = $('#teacher-schedule-select')?.value || selectedTeacherSchedule;
  const schedule = scheduleById(scheduleId);
  if (!schedule) return toast('Choose a class schedule first.');
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera access is not supported here. Open AttendX on HTTPS or localhost in a modern browser.');
  try {
    await stopCameraTools();
    resetLiveAttendance();
    const region = $('#camera-region');
    if (region) region.hidden = false;
    const reader = $('#camera-reader');
    const video = $('#face-video');
    if (reader) reader.hidden = false;
    if (video) video.hidden = true;
    seenQrTokens = new Set();
    duplicateQrNoticeTokens = new Set();
    qrScanner = new Html5Qrcode('camera-reader', { verbose: false });
    await qrScanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 235, height: 235 }, aspectRatio: 1 }, async (decodedText) => {
      const token = String(decodedText || '').trim();
      if (!token || cameraBusy) return;
      if (seenQrTokens.has(token)) {
        if (!duplicateQrNoticeTokens.has(token)) { duplicateQrNoticeTokens.add(token); toast('ALREADY VERIFIED — this QR pass has already been recorded.'); }
        return;
      }
      cameraBusy = true;
      try {
        const client = requireCloud();
        const { data: verified, error } = await client.functions.invoke('verify-qr', { body: { token, scheduleId } });
        if (error || verified?.error || !verified?.student?.id) throw await readFunctionError(error, verified);
        const record = await saveAttendanceViaRpc(verified.student.id, scheduleId, 'QR');
        seenQrTokens.add(token);
        toast(`${verified.student.name}: ${record.status} · QR verified`);
        await refreshWorkspaceData({ silent: true });
      } catch (error) {
        const message = String(error.message || error);
        if (message.toLowerCase().includes('already recorded')) {
          seenQrTokens.add(token);
          if (!duplicateQrNoticeTokens.has(token)) { duplicateQrNoticeTokens.add(token); toast('ALREADY VERIFIED — attendance already exists for today.'); }
        } else toast(message);
      } finally { cameraBusy = false; }
    }, () => {});
    toast('QR camera started. Point it at a student QR pass.');
  } catch (error) {
    console.error(error);
    await stopCameraTools();
    toast(`Could not start QR camera: ${error.message || error}`);
  }
}
async function loadFaceModels() {
  if (faceModelsReady) return;
  // Share one model-loading request between camera startup and Capture Face.
  // Without this promise, tapping Capture while startup is loading can launch
  // duplicate downloads and make mobile registration feel frozen.
  if (!faceModelsPromise) {
    faceModelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_PATH),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODEL_PATH),
      faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_PATH)
    ]).then(() => {
      faceModelsReady = true;
    }).catch(error => {
      faceModelsPromise = null;
      throw error;
    });
  }
  return faceModelsPromise;
}
async function startFaceCamera() {
  const user = currentUser();
  if (!user || user.role !== 'teacher') return toast('Log in as a teacher to run face attendance.');
  const scheduleId = $('#teacher-schedule-select')?.value || selectedTeacherSchedule;
  if (!scheduleById(scheduleId)) return toast('Choose a class schedule first.');
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera access needs HTTPS or localhost.');
  try {
    await stopCameraTools();
    resetLiveAttendance();
    await loadFaceModels();
    const region = $('#camera-region'); if (region) region.hidden = false;
    const reader = $('#camera-reader'); if (reader) reader.hidden = true;
    const video = $('#face-video'); if (!video) throw new Error('Face camera preview is missing from the page.');
    video.hidden = false;
    faceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 540 } }, audio: false });
    video.srcObject = faceStream;
    await video.play();
    faceDetectionLoop = true;
    seenFaceIds = new Set();
    faceDuplicateNoticeIds.clear();
    const scanFrame = async () => {
      if (!faceDetectionLoop || !faceStream || video.readyState < 2) return;
      try {
        if (!cameraBusy && Date.now() - lastFaceAttemptAt > 1300) {
          lastFaceAttemptAt = Date.now();
          const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.58 })).withFaceLandmarks(true).withFaceDescriptors();
          if (detections.length > 1) {
            const message = 'Multiple faces detected. Please keep only one student in the camera frame.';
            if (message !== lastFaceNoticeMessage || Date.now() - lastFaceNoticeAt > 8000) {
              lastFaceNoticeMessage = message;
              lastFaceNoticeAt = Date.now();
              toast(message);
            }
          }
          const detection = detections.length === 1 ? detections[0] : null;
          if (detection?.descriptor) {
            cameraBusy = true;
            let candidateStudentId = null;
            try {
              const client = requireCloud();
              const { data: verified, error } = await client.functions.invoke('verify-face', { body: { scheduleId, descriptor: Array.from(detection.descriptor) } });
              if (error || verified?.error || !verified?.student?.id) throw await readFunctionError(error, verified);
              candidateStudentId = verified.student.id;
              if (!seenFaceIds.has(candidateStudentId)) {
                const record = await saveAttendanceViaRpc(candidateStudentId, scheduleId, 'FACE');
                seenFaceIds.add(candidateStudentId);
                faceDuplicateNoticeIds.add(candidateStudentId);
                toast(`${verified.student.name}: ${record.status} · Face verified`);
                await refreshWorkspaceData({ silent: true });
              }
            } catch (error) {
              const message = String(error.message || error);
              const lowerMessage = message.toLowerCase();
              if (lowerMessage.includes('already recorded')) {
                if (candidateStudentId) seenFaceIds.add(candidateStudentId);
                if (!candidateStudentId || !faceDuplicateNoticeIds.has(candidateStudentId)) {
                  if (candidateStudentId) faceDuplicateNoticeIds.add(candidateStudentId);
                  toast('ALREADY VERIFIED — attendance already exists for today.');
                }
              } else if (!lowerMessage.includes('no confident face match') && !lowerMessage.includes('not found') && !lowerMessage.includes('no enrolled students have registered face data')) {
                if (message !== lastFaceNoticeMessage || Date.now() - lastFaceNoticeAt > 8000) {
                  lastFaceNoticeMessage = message;
                  lastFaceNoticeAt = Date.now();
                  toast(message);
                }
              }
            } finally { cameraBusy = false; }
          }
        }
      } catch (error) { console.debug('Face scan frame skipped:', error); }
      if (faceDetectionLoop) window.setTimeout(() => requestAnimationFrame(scanFrame), 250);
    };
    requestAnimationFrame(scanFrame);
    toast('Face camera started. Look at the camera; ambiguous matches will be rejected.');
  } catch (error) {
    console.error(error);
    await stopCameraTools();
    toast(`Could not start face camera: ${error.message || error}. Check the connection and model files, or use QR.`, 5000);
  }
}
async function stopCameraTools({ closeFingerprint = true } = {}) {
  faceDetectionLoop = false;
  fingerprintScanActive = false;
  if (qrScanner) {
    try { if (qrScanner.isScanning) await qrScanner.stop(); } catch (error) { console.debug(error); }
    try { qrScanner.clear(); } catch { /* already cleared */ }
    qrScanner = null;
  }
  for (const key of ['faceStream','faceRegStream']) {
    const stream = key === 'faceStream' ? faceStream : faceRegStream;
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (key === 'faceStream') faceStream = null; else faceRegStream = null;
  }
  const video = $('#face-video'); if (video) { video.pause(); video.srcObject = null; video.hidden = true; }
  const regVideo = $('#face-registration-video'); if (regVideo) { regVideo.pause(); regVideo.srcObject = null; }
  const reader = $('#camera-reader'); if (reader) { reader.innerHTML = ''; reader.hidden = false; }
  const region = $('#camera-region'); if (region) region.hidden = true;
  cameraBusy = false;
  if (closeFingerprint) await disconnectFingerprintReader();
}

function rejectFingerprintPacketWaiters(error) {
  for (const waiter of fingerprintPacketWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}
function parseFingerprintPacketBuffer() {
  while (fingerprintIncomingBytes.length >= 9) {
    let header = -1;
    for (let i = 0; i < fingerprintIncomingBytes.length - 1; i++) {
      if (fingerprintIncomingBytes[i] === 0xEF && fingerprintIncomingBytes[i + 1] === 0x01) { header = i; break; }
    }
    if (header < 0) {
      fingerprintIncomingBytes = fingerprintIncomingBytes.slice(-1);
      return;
    }
    if (header > 0) fingerprintIncomingBytes.splice(0, header);
    if (fingerprintIncomingBytes.length < 9) return;
    const packetLength = (fingerprintIncomingBytes[7] << 8) | fingerprintIncomingBytes[8];
    if (packetLength < 2 || packetLength > 1024) {
      fingerprintIncomingBytes.shift();
      continue;
    }
    const totalLength = 9 + packetLength;
    if (fingerprintIncomingBytes.length < totalLength) return;
    const packet = fingerprintIncomingBytes.splice(0, totalLength);
    const waiter = fingerprintPacketWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(packet); }
    else fingerprintPacketQueue.push(packet);
  }
}
function waitForFingerprintPacket(timeoutMs = 6000) {
  if (fingerprintPacketQueue.length) return Promise.resolve(fingerprintPacketQueue.shift());
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve, reject,
      timer: window.setTimeout(() => {
        const index = fingerprintPacketWaiters.indexOf(waiter);
        if (index >= 0) fingerprintPacketWaiters.splice(index, 1);
        reject(new Error('Fingerprint reader did not respond. Check USB connection, baud rate (57600), and power.'));
      }, timeoutMs)
    };
    fingerprintPacketWaiters.push(waiter);
  });
}
async function connectFingerprintReader() {
  if (!('serial' in navigator)) {
    throw new Error('Fingerprint reader needs Chrome/Edge on a compatible computer browser and an AS608/R307 reader connected through USB-to-serial. Most phone browsers cannot connect to this UART reader directly.');
  }
  if (fingerprintPort?.readable && fingerprintPort?.writable && fingerprintReader && fingerprintWriter) return;
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 57600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  if (!port.readable || !port.writable) {
    try { await port.close(); } catch {}
    throw new Error('The selected serial port is unavailable. Reconnect the fingerprint reader and try again.');
  }
  fingerprintPort = port;
  fingerprintIncomingBytes = [];
  fingerprintPacketQueue = [];
  fingerprintPacketWaiters = [];
  const reader = port.readable.getReader();
  fingerprintReader = reader;
  fingerprintWriter = port.writable.getWriter();
  fingerprintReadPump = (async () => {
    while (fingerprintReader === reader) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        fingerprintIncomingBytes.push(...value);
        parseFingerprintPacketBuffer();
      }
    }
  })().catch(error => {
    rejectFingerprintPacketWaiters(error);
    if (fingerprintReader === reader) toast('Fingerprint serial connection lost. Reconnect the reader and try again.', 5000);
  });
  try {
    const system = await sendFingerprintCommand([0x0F]);
    if (system[0] === 0 && system.length >= 7) {
      const capacity = (system[3] << 8) | system[4];
      if (capacity >= 2) fingerprintCapacity = Math.min(capacity, 256);
    }
  } catch (error) {
    console.warn('Fingerprint reader did not report its capacity; using a conservative slot limit.', error);
  }
  toast(`Fingerprint reader connected at 57600 baud · ${fingerprintCapacity - 1} usable slots.`);
}
async function disconnectFingerprintReader() {
  fingerprintScanActive = false;
  const reader = fingerprintReader;
  const writer = fingerprintWriter;
  const port = fingerprintPort;
  fingerprintReader = null;
  fingerprintWriter = null;
  fingerprintPort = null;
  rejectFingerprintPacketWaiters(new Error('Fingerprint reader disconnected.'));
  if (reader) {
    try { await reader.cancel(); } catch {}
    try { await fingerprintReadPump; } catch {}
    try { reader.releaseLock(); } catch {}
  }
  if (writer) { try { writer.releaseLock(); } catch {} }
  fingerprintReadPump = null;
  fingerprintIncomingBytes = [];
  fingerprintPacketQueue = [];
  if (port) { try { await port.close(); } catch (error) { console.debug('Serial port close:', error); } }
}
async function sendFingerprintCommand(commandBytes) {
  if (!fingerprintWriter || !fingerprintReader) throw new Error('Connect the fingerprint reader first.');
  const payloadLength = commandBytes.length + 2;
  let checksum = 0x01 + (payloadLength >> 8) + (payloadLength & 0xFF);
  for (const byte of commandBytes) checksum += byte;
  const packet = new Uint8Array([
    0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0x01,
    (payloadLength >> 8) & 0xFF, payloadLength & 0xFF,
    ...commandBytes, (checksum >> 8) & 0xFF, checksum & 0xFF
  ]);
  await fingerprintWriter.write(packet);
  const response = await waitForFingerprintPacket();
  if (response[6] !== 0x07) throw new Error('Invalid response from fingerprint reader. Check the serial connection and baud rate.');
  return response.slice(9, response.length - 2);
}
function fingerprintStatusText(code) {
  return ({
    0x01:'Fingerprint packet error.', 0x02:'No finger detected yet.', 0x03:'Fingerprint image is too noisy. Clean the sensor and try again.',
    0x06:'Fingerprint image is too messy. Press the finger gently and retry.', 0x07:'Fingerprint image is too small. Reposition the finger.',
    0x08:'No fingerprint features were found. Try a cleaner, flatter finger placement.', 0x09:'No matching fingerprint template was found.',
    0x0A:'The two fingerprint samples did not match. Re-enroll the same finger.', 0x0B:'Fingerprint storage address is out of range.',
    0x0C:'Could not read the fingerprint template.', 0x0D:'Fingerprint sensor operation failed.',
    0x0E:'Could not combine the fingerprint samples.', 0x10:'Fingerprint templates could not be merged.', 0x13:'Fingerprint sensor password verification failed.'
  })[code] || `Fingerprint sensor returned error 0x${Number(code).toString(16).padStart(2,'0')}.`;
}
function expectFingerprintSuccess(payload, operation) {
  if (!payload?.length) throw new Error(`No response while ${operation}.`);
  if (payload[0] !== 0) throw new Error(fingerprintStatusText(payload[0]));
  return payload;
}
const waitMs = ms => new Promise(resolve => window.setTimeout(resolve, ms));
async function waitForFingerprintImage(prompt) {
  toast(prompt, 5000);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const payload = await sendFingerprintCommand([0x01]);
    if (payload[0] === 0) return;
    if (payload[0] !== 0x02) throw new Error(fingerprintStatusText(payload[0]));
    await waitMs(250);
  }
  throw new Error('Timed out waiting for a finger. Press Cancel/Stop and try again.');
}
async function waitForFingerRemoval(showPrompt = true) {
  if (showPrompt) toast('Lift your finger completely from the sensor.', 5000);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const payload = await sendFingerprintCommand([0x01]);
    if (payload[0] === 0x02) return;
    if (payload[0] !== 0) throw new Error(fingerprintStatusText(payload[0]));
    await waitMs(250);
  }
  throw new Error('The sensor still detects a finger. Lift your finger and try again.');
}
async function registerStudentFingerprint(studentId) {
  const teacher = currentUser();
  const scheduleId = $('#teacher-schedule-select')?.value || selectedTeacherSchedule;
  const schedule = scheduleById(scheduleId);
  if (teacher?.role !== 'teacher' || !schedule || !enrolledStudents(schedule.id).some(student => student.id === studentId)) {
    return toast('Select a class and an enrolled student before registering a fingerprint.');
  }
  try {
    // Open the serial picker immediately in the real click action to preserve browser permission.
    await connectFingerprintReader();
    await stopCameraTools({ closeFingerprint: false });
    const { data: mappings, error: mappingsError } = await requireCloud().from('fingerprint_templates')
      .select('sensor_slot,student_id').eq('device_id', getFingerprintDeviceId());
    if (mappingsError) throw mappingsError;
    const existing = (mappings || []).find(row => row.student_id === studentId);
    const used = new Set((mappings || []).map(row => Number(row.sensor_slot)));
    const maxSlot = Math.max(1, fingerprintCapacity - 1);
    let slot = existing ? Number(existing.sensor_slot) : 0;
    if (!slot) for (let candidate = 1; candidate <= maxSlot; candidate++) if (!used.has(candidate)) { slot = candidate; break; }
    if (!slot || slot > maxSlot) throw new Error('Fingerprint storage is full. Remove an old reader template or use another reader.');
    await waitForFingerprintImage('Place the student’s finger on the sensor.');
    expectFingerprintSuccess(await sendFingerprintCommand([0x02, 0x01]), 'converting the first fingerprint sample');
    const duplicateSearch = await sendFingerprintCommand([0x04, 0x01, 0x00, 0x00, (fingerprintCapacity >> 8) & 0xFF, fingerprintCapacity & 0xFF]);
    if (duplicateSearch[0] === 0 && duplicateSearch.length >= 5) {
      const matchedSlot = (duplicateSearch[1] << 8) | duplicateSearch[2];
      const matchedMapping = (mappings || []).find(row => Number(row.sensor_slot) === matchedSlot);
      if (!matchedMapping) throw new Error('This finger already matches an unmapped sensor slot. Do not assign it to another student; ask the administrator to reconcile the reader slots.');
      if (matchedMapping.student_id !== studentId) throw new Error('This finger already matches a fingerprint registered to another student. AttendX blocked duplicate fingerprint registration.');
      if (!existing || Number(existing.sensor_slot) !== matchedSlot) throw new Error('This student’s finger already matches a different sensor slot. Refresh the roster and use the existing mapped slot.');
    } else if (duplicateSearch[0] !== 0x09 && duplicateSearch[0] !== 0x02) {
      throw new Error(fingerprintStatusText(duplicateSearch[0]));
    }
    await waitForFingerRemoval(true);
    await waitForFingerprintImage('Place the same finger on the sensor a second time.');
    expectFingerprintSuccess(await sendFingerprintCommand([0x02, 0x02]), 'converting the second fingerprint sample');
    expectFingerprintSuccess(await sendFingerprintCommand([0x05]), 'combining fingerprint samples');
    expectFingerprintSuccess(await sendFingerprintCommand([0x06, 0x01, (slot >> 8) & 0xFF, slot & 0xFF]), 'saving the fingerprint to the sensor');
    const { data: saved, error } = await requireCloud().functions.invoke('register-fingerprint', {
      body: { scheduleId, studentId, deviceId: getFingerprintDeviceId(), sensorSlot: slot }
    });
    if (error || saved?.error || !saved?.ok) throw await readFunctionError(error, saved);
    toast(`Fingerprint enrolled for ${fullName(userById(studentId))} · sensor slot ${slot}.`, 5000);
    await refreshWorkspaceData({ silent: true });
  } catch (error) {
    console.error('Fingerprint enrollment failed:', error);
    toast(`Fingerprint enrollment failed: ${error.message || error}`, 6000);
  }
}
async function startFingerprintAttendanceScan() {
  const teacher = currentUser();
  const scheduleId = $('#teacher-schedule-select')?.value || selectedTeacherSchedule;
  if (teacher?.role !== 'teacher') return toast('Only teachers can scan fingerprints for attendance.');
  if (!scheduleById(scheduleId)) return toast('Choose a class schedule first.');
  try {
    await connectFingerprintReader();
    await stopCameraTools({ closeFingerprint: false });
    fingerprintScanActive = true;
    const scannedSlots = new Set();
    toast('Fingerprint attendance scan started. Place one enrolled student’s finger on the reader; use Stop Camera to finish.', 5000);
    while (fingerprintScanActive && fingerprintReader && fingerprintWriter) {
      const image = await sendFingerprintCommand([0x01]);
      if (image[0] === 0x02) { await waitMs(250); continue; }
      if (image[0] !== 0) {
        toast(fingerprintStatusText(image[0]), 4500);
        await waitForFingerRemoval(false);
        continue;
      }
      expectFingerprintSuccess(await sendFingerprintCommand([0x02, 0x01]), 'processing the fingerprint');
      const search = await sendFingerprintCommand([0x04, 0x01, 0x00, 0x00, (fingerprintCapacity >> 8) & 0xFF, fingerprintCapacity & 0xFF]);
      if (search[0] === 0 && search.length >= 5) {
        const slot = (search[1] << 8) | search[2];
        if (!scannedSlots.has(slot)) {
          try {
            const { data: verified, error } = await requireCloud().functions.invoke('verify-fingerprint', {
              body: { scheduleId, deviceId: getFingerprintDeviceId(), sensorSlot: slot }
            });
            if (error || verified?.error || !verified?.student?.id) throw await readFunctionError(error, verified);
            const record = await saveAttendanceViaRpc(verified.student.id, scheduleId, 'FINGERPRINT');
            scannedSlots.add(slot);
            toast(`${verified.student.name}: ${record.status} · Fingerprint verified`, 5000);
            await refreshWorkspaceData({ silent: true });
          } catch (error) {
            const message = String(error.message || error);
            if (message.toLowerCase().includes('already recorded')) {
              scannedSlots.add(slot);
              toast('ALREADY VERIFIED — attendance already exists for today.', 4500);
            } else toast(message, 5000);
          }
        } else {
          toast('This fingerprint has already been scanned in this session. Lift the finger before scanning again.', 3500);
        }
      } else if (search[0] === 0x09) {
        toast('No matching registered fingerprint. Register the student’s finger first or use QR/face verification.', 5000);
      } else {
        throw new Error(fingerprintStatusText(search[0]));
      }
      await waitForFingerRemoval(false);
    }
  } catch (error) {
    if (fingerprintScanActive) toast(`Fingerprint scan stopped: ${error.message || error}`, 6000);
    console.error('Fingerprint scan failed:', error);
    fingerprintScanActive = false;
  }
}
async function waitForLiveCameraFrame(video, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!video.isConnected) throw new Error('The face preview was closed before the camera started.');
    // HAVE_CURRENT_DATA (readyState >= 2) ensures an actual decoded frame is
    // available. HAVE_METADATA alone can have dimensions but still display no
    // picture, which is too early to enable Capture Face.
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return;
    await waitMs(80);
  }
  throw new Error('Camera permission was granted, but no live picture reached the preview box. Keep this tab open, allow camera access for AttendX, close other camera apps, then tap Retry Camera.');
}
async function startFaceRegistrationCamera() {
  const user = currentUser();
  if (!user || user.role !== 'student') return toast('Only a student can register their face.');
  const video = $('#face-registration-video');
  const status = $('#face-camera-status');
  const captureButton = document.querySelector('[data-action="capture-face"]');
  if (captureButton) {
    captureButton.disabled = true;
    captureButton.textContent = 'Waiting for camera…';
  }
  try {
    if (!video) throw new Error('Face registration preview not found.');
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access requires HTTPS and a browser that supports camera capture. Open the deployed AttendX HTTPS link, not an insecure HTTP address.');
    }

    // Set mobile Safari/Chrome playback flags before requesting the stream.
    video.hidden = false;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.style.display = 'block';
    video.style.visibility = 'visible';
    video.style.position = 'absolute';
    video.style.inset = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.maxHeight = 'none';
    video.style.objectFit = 'cover';
    video.style.transform = 'none';
    video.style.webkitTransform = 'none';
    if (status) {
      status.hidden = false;
      status.textContent = 'Opening camera… this may take a few seconds.';
    }

    // Load the face models while the camera starts, rather than making the
    // student wait for one step to finish before the other can begin.
    const modelsReadyPromise = loadFaceModels().catch(modelError => {
      console.error('Face model preloading failed:', modelError);
      return modelError;
    });

    // A smaller stream is noticeably lighter on phones and is sufficient for
    // the 320px TinyFaceDetector input used below.
    const cameraConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 480 },
        height: { ideal: 360 },
        frameRate: { ideal: 15, max: 24 }
      }
    };
    try {
      faceRegStream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
    } catch (firstCameraError) {
      // Some mobile browsers reject a frame-rate constraint; retry once with
      // plain front-camera constraints rather than leaving the screen stuck.
      if (!['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(firstCameraError?.name)) throw firstCameraError;
      faceRegStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 480 }, height: { ideal: 360 } }
      });
    }

    if (!video.isConnected) {
      for (const track of faceRegStream.getTracks()) track.stop();
      faceRegStream = null;
      return;
    }
    video.srcObject = faceRegStream;

    // Give mobile Safari/Chrome a real inline playback request after the stream
    // is attached; metadata may become available before the first decoded frame.
    const playback = video.play();
    if (playback && typeof playback.then === 'function') await playback;
    await waitForLiveCameraFrame(video);

    const liveTrack = faceRegStream.getVideoTracks().find(track => track.readyState === 'live');
    if (!liveTrack) throw new Error('The camera stream ended. Reopen Face Registration and allow camera access.');

    if (status) status.hidden = true;
    if (captureButton) {
      captureButton.disabled = false;
      captureButton.textContent = 'Capture Face';
    }
    toast('Live camera preview is ready. Face the camera in good lighting, then tap Capture Face.');

    // Camera preview and face-model downloads now run in parallel. The preview
    // is shown as soon as video frames arrive; the shared promise avoids a
    // second model download if Capture Face is tapped while loading continues.
    const modelError = await modelsReadyPromise;
    if (modelError) {
      toast('The camera preview is working, but face-recognition models could not load. Check your internet connection, then tap Capture Face to retry.', 6000);
    }
  } catch (error) {
    console.error('Face registration camera failed:', error);
    if (faceRegStream) {
      for (const track of faceRegStream.getTracks()) track.stop();
      faceRegStream = null;
    }
    if (video) {
      try { video.pause(); } catch {}
      video.srcObject = null;
    }
    if (captureButton) {
      captureButton.disabled = true;
      captureButton.textContent = 'Capture Face';
    }
    if (status) {
      status.hidden = false;
      status.textContent = error.message || 'Could not show the live camera preview. Check camera permission for AttendX.';
    }
    toast(`Face registration camera failed: ${error.message || error}`, 6000);
  }
}
async function captureAndSaveFace() {
  const video = $('#face-registration-video');
  if (!video || !faceRegStream) return toast('Start the camera first.');
  const captureButton = document.querySelector('[data-action="capture-face"]');
  if (captureButton) { captureButton.disabled = true; captureButton.textContent = 'Capturing…'; }
  try {
    await waitForLiveCameraFrame(video, 8000);
    await loadFaceModels();
    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.6 })).withFaceLandmarks(true).withFaceDescriptors();
    if (detections.length === 0) {
      if (captureButton) { captureButton.disabled = false; captureButton.textContent = 'Capture Face'; }
      toast('No clear face found. Face the camera, improve lighting, and tap Capture Face again.');
      return;
    }
    if (detections.length > 1) {
      if (captureButton) { captureButton.disabled = false; captureButton.textContent = 'Capture Face'; }
      toast('More than one face detected. Keep only the student registering in view, then tap Capture Face again.');
      return;
    }
    const detection = detections[0];
    if (!detection?.descriptor) {
      if (captureButton) { captureButton.disabled = false; captureButton.textContent = 'Capture Face'; }
      toast('No clear face found. Face the camera, improve lighting, and tap Capture Face again.');
      return;
    }
    const { data: saved, error } = await requireCloud().functions.invoke('register-face', { body: { descriptor: Array.from(detection.descriptor) } });
    if (error || saved?.error || !saved?.ok) throw await readFunctionError(error, saved);
    faceRegistered = true;
    await stopCameraTools();
    modal = null;
    await refreshWorkspaceData({ silent: true });
    renderApp();
    toast('Face template saved to your AttendX account. You can update it from Profile.');
  } catch (error) {
    console.error(error);
    const frameReady = Boolean(video?.isConnected && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
    const captureButton = document.querySelector('[data-action="capture-face"]');
    if (captureButton) {
      captureButton.disabled = !frameReady;
      captureButton.textContent = frameReady ? 'Capture Face' : 'Waiting for camera…';
    }
    if (!frameReady) {
      const status = $('#face-camera-status');
      if (status) {
        status.hidden = false;
        status.textContent = error.message || 'No live camera frame is available yet. Tap Retry Camera.';
      }
    }
    toast(`Could not save face data: ${error.message || error}`);
  }
}
function drawQrCodes() {
  document.querySelectorAll('canvas[data-qr-token]').forEach(canvas => {
    const token = canvas.dataset.qrToken;
    if (!token || canvas.dataset.drawn === '1') return;
    QRCode.toCanvas(canvas, token, { width: 164, margin: 1, errorCorrectionLevel: 'H', color: { dark: '#111729', light: '#ffffff' } }, error => {
      if (error) { console.error(error); toast('Could not render QR pass.'); }
      else canvas.dataset.drawn = '1';
    });
  });
}

function header() {
  return `<header class="topbar">
    <button class="brand" data-action="home" aria-label="AttendX home"><span class="brand-mark">A</span><span><span class="brand-name">ATTENDX</span><span class="brand-sub">SMART SCHOOL ATTENDANCE</span></span></button>
    <div class="top-right"><span class="pill clock-pill">◷ &nbsp;<span id="live-clock">${esc(liveClockText())}</span></span><span class="pill"><span class="dot"></span> ${supabase ? 'Cloud workspace' : 'Setup required'}</span></div>
  </header>`;
}
function footerNote() {
  return `<div class="footer-note">AttendX Smart School Attendance Management System · Supabase shared database<br>Camera access requires HTTPS (GitHub Pages) or localhost. Biometric data should only be registered with the student's consent.</div>`;
}
function renderHome() {
  view = 'home';
  $('#app').innerHTML = `${header()}<main class="role-wrap">
    <section class="role-intro"><div class="eyebrow">ATTENDX SMART ATTENDANCE</div><h1>WELCOME TO ATTENDX</h1><p>Smart School Attendance Management System</p></section>
    <section class="role-cards">
      <article class="role-card"><div class="role-symbol">♙</div><h2>STUDENT</h2><p>Manage your subjects,<br>profile and attendance.</p><button class="btn" data-action="auth" data-role="student" data-mode="login">ENTER STUDENT PORTAL <span>→</span></button><button class="text-btn role-register" data-action="auth" data-role="student" data-mode="register">Create student account</button></article>
      <article class="role-card"><div class="role-symbol">▤</div><h2>TEACHER</h2><p>Manage schedules,<br>students and attendance.</p><button class="btn" data-action="auth" data-role="teacher" data-mode="login">ENTER TEACHER PORTAL <span>→</span></button><button class="text-btn role-register" data-action="auth" data-role="teacher" data-mode="register">Create teacher account</button></article>
    </section>
    <div class="role-actions"><button class="btn secondary" data-action="guide">USER GUIDE</button><button class="btn ghost" data-action="connection-test">CHECK CONNECTION</button></div>
    ${!supabase ? `<section class="panel setup-panel"><div class="notice warning"><b>Supabase setup is not complete.</b><br>Copy <code>.env.example</code> to <code>.env</code>, enter your Supabase project URL and public/anon key, run the SQL migration and deploy the Edge Functions, then restart the dev server.</div></section>` : `<p class="panel-sub cloud-note">Accounts, schedules and attendance are shared through Supabase across devices that open this deployed site.</p>`}
  </main>${footerNote()}`;
}
function renderAuth() {
  view = 'auth';
  const registering = authMode === 'register';
  const role = authRole;
  const heading = registering ? `Create ${roleName(role).toLowerCase()} account` : `${roleName(role)} login`;
  const commonFields = registering ? `<div class="form-grid">
    <div class="field"><label for="firstName">First name *</label><input id="firstName" name="firstName" required maxlength="45" autocomplete="given-name"></div>
    <div class="field"><label for="lastName">Last name *</label><input id="lastName" name="lastName" required maxlength="45" autocomplete="family-name"></div>
    <div class="field"><label for="middleName">Middle name</label><input id="middleName" name="middleName" maxlength="45"></div>
    <div class="field"><label for="suffix">Suffix / extension</label><input id="suffix" name="suffix" maxlength="15" placeholder="Jr., III, etc."></div>
    <div class="field"><label for="sex">Sex *</label><select id="sex" name="sex" required><option value="">Select sex</option><option>Female</option><option>Male</option></select></div>
    ${role === 'student' ? `<div class="field"><label for="course">Course *</label><input id="course" name="course" value="BSIT" required maxlength="30"></div><div class="field"><label for="year">Year level *</label><select id="year" name="year" required><option>1ST</option><option selected>2ND</option><option>3RD</option><option>4TH</option></select></div><div class="field"><label for="section">Section *</label><input id="section" name="section" value="D" required maxlength="10"></div>` : `<div class="field"><label for="department">Department</label><input id="department" name="department" value="Information Technology" maxlength="60"></div><div class="field"><label for="office">Office</label><input id="office" name="office" value="IT Faculty" maxlength="60"></div><div class="field full"><label for="teacherInviteCode">Teacher invitation code *</label><input id="teacherInviteCode" name="teacherInviteCode" type="password" required maxlength="160" autocomplete="off"><small>Ask the AttendX administrator for this code. It is checked by the server and is not stored in your profile.</small></div>`}
    <div class="field full"><label for="accountId">${role === 'student' ? 'School ID' : 'Teacher ID'} *</label><input id="accountId" name="accountId" required maxlength="40" autocomplete="username"><small>Account IDs must be unique across Student and Teacher roles.</small></div>
    <div class="field full"><label for="password">Password *</label><input id="password" name="password" type="password" minlength="6" required autocomplete="new-password"><small>Use at least 6 characters. This password is handled by Supabase Auth, not stored in the profile table.</small></div>
  </div>` : `<div class="form-grid"><div class="field full"><label for="accountId">${role === 'student' ? 'School ID' : 'Teacher ID'}</label><input id="accountId" name="accountId" required autocomplete="username" placeholder="Enter your account ID"></div><div class="field full"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Enter your password"></div></div>`;
  $('#app').innerHTML = `${header()}<main class="auth-wrap"><section class="auth-card"><button class="text-btn auth-back" data-action="home">← Back to role selection</button><div class="eyebrow">${roleName(role)} portal</div><h1>${esc(heading)}</h1><p class="subtitle">${registering ? 'Enter your official information to create an AttendX account shared through the cloud database.' : 'Sign in with your account ID and password to access your workspace.'}</p>
    <div class="toolbar" style="margin-top:18px;margin-bottom:0"><button class="btn ${role === 'student' ? '' : 'secondary'} small" data-action="auth" data-role="student" data-mode="${authMode}">Student</button><button class="btn ${role === 'teacher' ? '' : 'secondary'} small" data-action="auth" data-role="teacher" data-mode="${authMode}">Teacher</button></div>
    <form data-form="auth" data-role="${role}" data-mode="${authMode}">${commonFields}<div class="form-actions"><button class="btn" type="submit">${registering ? 'Create account' : 'Log in'} <span>→</span></button><button class="btn secondary" type="button" data-action="home">Cancel</button></div></form>
    <div class="auth-switch">${registering ? 'Already registered?' : 'New to AttendX?'} <button class="text-btn" data-action="auth" data-role="${role}" data-mode="${registering ? 'login' : 'register'}">${registering ? 'Log in' : 'Create account'}</button></div>
    ${!supabase ? `<div class="notice warning" style="margin-top:18px">Supabase settings are missing. Configure the project before creating or logging into an account.</div>` : ''}
  </section></main>${footerNote()}`;
}
function navFor(role) {
  if (role === 'student') return [
    ['dashboard','Dashboard','dashboard'], ['browse','Browse Classes','browse'], ['subjects','My Subjects','subjects'], ['attendance','My Attendance','attendance'], ['qr','QR Pass','qr'], ['profile','My Profile','profile']
  ];
  return [
    ['dashboard','Dashboard','dashboard'], ['schedule','My Schedule','schedule'], ['addSchedule','Add Schedule','addSchedule'], ['students','My Students','students'], ['center','Attendance Center','center'], ['records','Attendance Records','records'], ['catalog','Subject Catalog','catalog'], ['profile','My Profile','profile']
  ];
}
function renderShell(contentHtml) {
  const user = currentUser();
  const nav = navFor(user.role);
  const navHtml = nav.map(([key,label,icon]) => `<button class="side-link ${activePage === key ? 'active' : ''}" data-action="navigate" data-page="${key}"><span class="side-icon">${iconMap[icon] || '•'}</span><span>${label}</span></button>`).join('');
  $('#app').innerHTML = `${header()}<div class="app-shell"><aside class="sidebar"><div class="side-label">Workspace</div>${navHtml}<div class="side-bottom"><div class="user-mini"><span class="avatar">${esc(initials(user))}</span><div><b>${esc(fullName(user))}</b><small>${esc(user.accountId)} · ${roleName(user.role)}</small></div></div><button class="side-link" data-action="logout"><span class="side-icon">↪</span><span>Log out</span></button></div></aside><main class="main-area">${contentHtml}</main></div>${modal ? renderModal() : ''}`;
}
function pageHead(title, subtitle, actions = '') { return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="page-head-actions">${actions}</div></div>`; }
function statCard(label, value, foot, icon) { return `<div class="stat-card"><div class="stat-label"><span>${esc(label)}</span><span>${icon || '◦'}</span></div><div class="stat-num">${esc(value)}</div><div class="stat-foot">${esc(foot)}</div></div>`; }
function classCard(schedule, options = {}) {
  const teacher = teacherFor(schedule);
  const enrolled = data.enrollments.some(item => item.studentId === currentUserId && item.scheduleId === schedule.id);
  const actionButtons = options.browse ? (enrolled ? `<button class="btn secondary small" disabled>Enrolled</button><button class="btn ghost small" data-action="view-class" data-id="${esc(schedule.id)}">Details</button>` : `<button class="btn small" data-action="join-class" data-id="${esc(schedule.id)}">Join class +</button>`) : options.checkin ? `<button class="btn small" data-action="checkin" data-id="${esc(schedule.id)}" data-method="QR">Open QR Pass</button><button class="btn secondary small" data-action="checkin" data-id="${esc(schedule.id)}" data-method="FACE">Face Recognition</button><button class="btn ghost small" data-action="checkin" data-id="${esc(schedule.id)}" data-method="FINGERPRINT">Fingerprint</button>` : options.teacher ? `<button class="btn secondary small" data-action="teacher-class" data-id="${esc(schedule.id)}">Manage class</button>` : `<button class="btn ghost small" data-action="view-class" data-id="${esc(schedule.id)}">View</button>`;
  return `<article class="class-card"><div class="class-top"><div><div class="class-title">${esc(schedule.subject)}</div><div class="class-meta">${esc(schedule.course)} · ${esc(schedule.year)} year · Section ${esc(schedule.section)}<br>${esc(schedule.day)} · ${time12(schedule.startTime)}–${time12(schedule.endTime)}${teacher ? `<br>Teacher: ${esc(fullName(teacher))}` : ''}</div></div>${badge(schedule.status || 'ACTIVE')}</div><div class="class-actions">${actionButtons}</div></article>`;
}
function renderStudentDashboard(user) {
  const schedules = getStudentSchedules(user.id);
  const records = attendanceForStudent(user.id);
  const presents = records.filter(record => record.status === 'PRESENT').length;
  const rate = records.length ? `${Math.round(presents / records.length * 100)}%` : '—';
  const recent = records.slice(0,5);
  return `${pageHead(`Welcome, ${user.firstName}`, 'Here is your student attendance snapshot.', `<button class="btn small" data-action="navigate" data-page="browse">Browse classes +</button>`)}
  <div class="stats-grid">${statCard('Enrolled subjects', schedules.length, 'Classes connected to you', '▤')}${statCard('Attendance records', records.length, 'Recorded check-ins', '◷')}${statCard('Present records', presents, 'On-time arrivals', '✓')}${statCard('Present rate', rate, 'Based on recorded attendance', '↗')}</div>
  <div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>My subjects</h2><div class="panel-sub">Your enrolled class schedules.</div></div><button class="inline-link" data-action="navigate" data-page="subjects">View all →</button></div>${schedules.length ? `<div class="class-list">${schedules.slice(0,4).map(s => classCard(s)).join('')}</div>` : `<div class="empty"><strong>No subjects yet</strong>Browse the class list and join a class.</div>`}</section><div><section class="panel"><div class="panel-head"><div><h2>Recent attendance</h2><div class="panel-sub">Your latest recorded attendance.</div></div><button class="inline-link" data-action="navigate" data-page="attendance">View all →</button></div>${recent.length ? recent.map(r => { const s = scheduleById(r.scheduleId); return `<div class="class-card"><div class="class-top"><div><div class="class-title">${esc(s?.subject || 'Removed class')}</div><div class="class-meta">${esc(shortDate(r.date))} · ${esc(r.time)}<br>Method: ${esc(r.method)}</div></div>${badge(r.status)}</div></div>`; }).join('') : `<div class="empty">Attendance records will show here.</div>`}</section><section class="panel"><div class="panel-head"><div><h2>Attendance verification</h2><div class="panel-sub">Show your QR pass or register a face template; your teacher verifies attendance.</div></div></div><div class="notice">Choose an enrolled class. QR and face verification are teacher-controlled; the old USB/serial fingerprint reader is not directly supported by ordinary mobile browsers.</div><div style="margin-top:13px"><button class="btn" data-action="navigate" data-page="attendance">Open attendance →</button></div></section></div></div>`;
}
function renderTeacherDashboard(user) {
  const schedules = getTeacherSchedules(user.id);
  const students = new Set(data.enrollments.filter(item => schedules.some(s => s.id === item.scheduleId)).map(item => item.studentId));
  const allRecords = attendanceForTeacher(user.id);
  const records = recordsForPeriod(allRecords);
  const present = records.filter(r => r.status === 'PRESENT').length;
  const recent = records.slice(0,5);
  const periodButtons = [['today','Today'],['week','Weekly'],['month','Monthly']].map(([key,label]) => `<button class="btn ${teacherPeriod===key?'':'secondary'} small" data-action="teacher-period" data-period="${key}">${label}</button>`).join('');
  return `${pageHead(`Welcome, ${user.firstName}`, 'Manage class schedules and student attendance.', `<button class="btn small" data-action="navigate" data-page="addSchedule">Add schedule +</button>`)}
  <div class="dashboard-period"><div><b>Attendance overview</b><span>Records for ${esc(periodLabel())}</span></div><div class="period-actions">${periodButtons}</div></div>
  <div class="stats-grid">${statCard('My schedules', schedules.length, 'Active classes', '▤')}${statCard('My students', students.size, 'Across your classes', '♙')}${statCard(`${periodLabel()} records`, records.length, `From ${recordsForPeriod(allRecords).length} selected records`, '◷')}${statCard('Present check-ins', present, `On-time · ${periodLabel().toLowerCase()}`, '✓')}</div>
  <div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>My schedule</h2><div class="panel-sub">Classes assigned to your account.</div></div><button class="inline-link" data-action="navigate" data-page="schedule">View all →</button></div>${schedules.length ? `<div class="class-list">${schedules.slice(0,5).map(s=>classCard(s,{teacher:true})).join('')}</div>` : `<div class="empty"><strong>No schedules</strong>Create a schedule so students can find and join your class.</div>`}</section><div><section class="panel"><div class="panel-head"><div><h2>Recent attendance</h2><div class="panel-sub">${esc(periodLabel())} records for your classes.</div></div><button class="inline-link" data-action="navigate" data-page="records">View all →</button></div>${recent.length ? recent.map(r => { const student = userById(r.studentId); const s = scheduleById(r.scheduleId); return `<div class="class-card"><div class="class-top"><div><div class="class-title">${esc(fullName(student))}</div><div class="class-meta">${esc(s?.subject || 'Removed class')} · ${esc(r.date)} · ${esc(r.time)}</div></div>${badge(r.status)}</div></div>`; }).join('') : `<div class="empty">No attendance records for ${esc(periodLabel().toLowerCase())}.</div>`}</section><section class="panel"><div class="panel-head"><div><h2>Attendance center</h2><div class="panel-sub">Keep QR / face scanning open while students verify.</div></div></div><button class="btn" data-action="navigate" data-page="center">Open attendance center →</button></section></div></div>`;
}

function renderBrowseClasses(user) {
  const matchesPlacement = s => String(s.course).trim().toLowerCase() === String(user.course).trim().toLowerCase()
    && String(s.year).trim().toLowerCase() === String(user.year).trim().toLowerCase()
    && String(s.section).trim().toLowerCase() === String(user.section).trim().toLowerCase();
  const list = data.schedules.filter(s => s.status !== 'ARCHIVED' && matchesPlacement(s))
    .filter(s => `${s.subject} ${s.course} ${s.year} ${s.section} ${fullName(teacherFor(s))}`.toLowerCase().includes(classSearch.toLowerCase()));
  return `${pageHead('Browse Classes', 'Find class schedules and enroll in the subjects you attend.', `<button class="btn secondary small" data-action="navigate" data-page="subjects">My subjects</button>`)}<div class="toolbar"><input id="class-search" placeholder="Search subject, course, teacher…" value="${esc(classSearch)}"><span class="pill">${list.length} class${list.length===1?'':'es'} found</span></div>${list.length ? `<div class="class-list">${list.map(s=>classCard(s,{browse:true})).join('')}</div>` : `<div class="empty"><strong>No matching classes</strong>Try another search, or ask a teacher to create a schedule.</div>`}`;
}
function renderMySubjects(user) {
  const schedules = getStudentSchedules(user.id);
  return `${pageHead('My Subjects', 'Classes connected to your student account.', `<button class="btn small" data-action="navigate" data-page="browse">Browse classes +</button>`)}${schedules.length ? `<div class="class-list">${schedules.map(s=>classCard(s,{checkin:true})).join('')}</div>` : `<div class="empty"><strong>No subjects yet</strong>Use Browse Classes to enroll in a class schedule.</div>`}`;
}
function attendanceTable(records, isTeacher) {
  if (!records.length) return `<div class="empty"><strong>No attendance records</strong>Records appear here after a teacher verifies attendance.</div>`;
  return `<div class="table-wrap"><table><thead><tr>${isTeacher ? '<th>Student</th>' : ''}<th>Date</th><th>Time</th><th>Subject / Class</th><th>Method</th><th>Status</th></tr></thead><tbody>${records.map(r => { const s=scheduleById(r.scheduleId); const student=userById(r.studentId); return `<tr>${isTeacher ? `<td><span class="row-primary">${esc(fullName(student))}</span><br><span class="muted">${esc(student?.accountId || '')}</span></td>` : ''}<td>${esc(shortDate(r.date))}</td><td>${esc(r.time)}</td><td><span class="row-primary">${esc(s?.subject || 'Removed class')}</span><br><span class="muted">${esc(s ? `${s.course} ${s.year} / ${s.section}` : '')}</span></td><td>${esc(r.method)}</td><td>${badge(r.status)}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function renderAttendance(user) {
  const records = attendanceForStudent(user.id).filter(r => `${r.date} ${r.time} ${r.method} ${r.status} ${scheduleById(r.scheduleId)?.subject || ''}`.toLowerCase().includes(recordSearch.toLowerCase()));
  const schedules = getStudentSchedules(user.id);
  return `${pageHead('My Attendance', 'Review your attendance history and verification status.', `<button class="btn small" data-action="show-checkins">Attendance options</button>`)}<section class="panel"><div class="panel-head"><div><h2>Check in to a class</h2><div class="panel-sub">Show your QR pass or register face recognition. The teacher records attendance using the active Attendance Center.</div></div></div>${schedules.length ? `<div class="class-list">${schedules.map(s=>classCard(s,{checkin:true})).join('')}</div>` : `<div class="empty">Join a class before checking in.</div>`}</section><section class="panel"><div class="panel-head"><div><h2>Attendance history</h2><div class="panel-sub">One record per student, class and date.</div></div></div><div class="toolbar"><input id="record-search" placeholder="Search records…" value="${esc(recordSearch)}"></div><div id="attendance-table">${attendanceTable(records,false)}</div></section>`;
}
function renderQr(user) {
  const schedules = getStudentSchedules(user.id);
  const cards = schedules.map(schedule => {
    const key = `${user.id}:${schedule.id}`;
    const token = data.qrTokens[key] || '';
    return `<div class="panel qr-pass-panel"><div class="panel-head"><div><h2>${esc(schedule.subject)}</h2><div class="panel-sub">${esc(schedule.course)} · ${esc(schedule.year)} / ${esc(schedule.section)}</div></div>${badge('ACTIVE')}</div>
      ${token ? `<canvas class="real-qr-canvas" data-qr-token="${esc(token)}" aria-label="Scannable student QR pass"></canvas><div class="token">${esc(token)}</div><div class="class-actions" style="justify-content:center"><button class="btn secondary small" data-action="copy-token" data-token="${esc(token)}">Copy token</button><button class="btn small" data-action="download-qr" data-id="${esc(schedule.id)}">Download QR</button></div>` : `<div class="qr-box">ATTENDX<br>QR PASS</div><div class="notice warning">Your pass is generated automatically when you enroll in this class. If it has not appeared yet, refresh your QR passes.</div><div class="class-actions"><button class="btn secondary" data-action="refresh-qr-passes">Refresh QR Pass</button></div>`}
      <p class="panel-sub" style="text-align:center;margin-top:11px">Show this QR to your teacher while their Attendance Center camera is running. Face attendance does not require a QR pass.</p></div>`;
  }).join('');
  return `${pageHead('QR Pass', 'Your QR pass is created automatically for every class you join.', '')}<div class="notice" style="margin-bottom:15px">AttendX creates one persistent QR pass per student and class enrollment. You do not need to press Generate QR. If you joined a class before this update, refresh the QR Pass page to load its automatically-created pass.</div><div class="content-grid">${cards || `<div class="empty"><strong>No class passes yet</strong>Browse Classes and join the matching course/year/section. A QR pass will be created automatically after you join.</div>`}</div>`;
}
function renderProfile(user) {
  return `${pageHead('My Profile', 'Review and edit your profile information. Account ID and password are not editable here.', '')}<div class="profile-grid"><section class="panel"><div class="panel-head"><div><h2>Personal details</h2><div class="panel-sub">Changes are saved to the shared AttendX database.</div></div></div><form data-form="profile"><div class="form-grid"><div class="field"><label>First name *</label><input name="firstName" value="${esc(user.firstName)}" required maxlength="45"></div><div class="field"><label>Last name *</label><input name="lastName" value="${esc(user.lastName)}" required maxlength="45"></div><div class="field"><label>Middle name</label><input name="middleName" value="${esc(user.middleName)}" maxlength="45"></div><div class="field"><label>Suffix / extension</label><input name="suffix" value="${esc(user.suffix)}" maxlength="15"></div><div class="field"><label>Sex</label><select name="sex"><option ${user.sex==='Female'?'selected':''}>Female</option><option ${user.sex==='Male'?'selected':''}>Male</option></select></div>${user.role==='student'?`<div class="field"><label>Course</label><input name="course" value="${esc(user.course)}" required maxlength="30"></div><div class="field"><label>Year</label><select name="year">${['1ST','2ND','3RD','4TH'].map(y=>`<option ${user.year===y?'selected':''}>${y}</option>`).join('')}</select></div><div class="field"><label>Section</label><input name="section" value="${esc(user.section)}" required maxlength="10"></div>`:`<div class="field"><label>Department</label><input name="department" value="${esc(user.department||'')}" maxlength="60"></div><div class="field"><label>Office</label><input name="office" value="${esc(user.office||'')}" maxlength="60"></div>`}</div><div class="form-actions"><button class="btn" type="submit">Save profile</button></div></form></section><aside class="profile-banner"><span class="avatar">${esc(initials(user))}</span><h2>${esc(fullName(user))}</h2><p>${esc(roleName(user.role))} account<br>${esc(user.accountId)}<br>${user.role==='student'?`${esc(user.course)} · ${esc(user.year)} Year · Section ${esc(user.section)}`:esc(user.department||'Teacher')}</p>${user.role==='student'?`<div class="face-profile-status ${faceRegistered?'is-registered':''}"><span class="dot"></span>${faceRegistered?'Face recognition registered':'Face recognition not registered'}</div><button class="btn secondary full-width" style="margin-top:12px" data-action="register-face">${faceRegistered?'Update face recognition':'Register face recognition'}</button><p class="panel-sub">Face data is stored as a numerical descriptor in your Supabase project. Register only with your consent.</p>`:`<div class="notice" style="margin-top:20px">Teacher access is limited to your own schedules, enrolled student rosters, and associated attendance records.</div>`}</aside></div>`;
}
function renderSchedule(user) {
  const schedules = getTeacherSchedules(user.id);
  return `${pageHead('My Schedule', 'All class schedules created by your teacher account.', `<button class="btn small" data-action="navigate" data-page="addSchedule">Add schedule +</button>`)}${schedules.length ? `<div class="class-list">${schedules.map(s=>classCard(s,{teacher:true})).join('')}</div>` : `<div class="empty"><strong>No schedules yet</strong>Create a schedule so students can find your class.</div>`}`;
}
function renderAddSchedule(user) {
  return `${pageHead('Add Schedule', 'Create a class schedule for eligible students to discover and join.', '')}<section class="panel"><div class="panel-head"><div><h2>Class information</h2><div class="panel-sub">The schedule will be saved to the shared AttendX cloud database.</div></div></div><form data-form="add-schedule"><div class="form-grid"><div class="field"><label>Subject *</label><input name="subject" required maxlength="80" placeholder="Type the subject name (e.g. Web Development)"></div><div class="field"><label>Course *</label><input name="course" value="BSIT" required maxlength="30"></div><div class="field"><label>Year level *</label><select name="year"><option>1ST</option><option selected>2ND</option><option>3RD</option><option>4TH</option></select></div><div class="field"><label>Section *</label><input name="section" value="D" required maxlength="10"></div><div class="field"><label>Day *</label><select name="day">${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d=>`<option ${d===currentDayName()?'selected':''}>${d}</option>`).join('')}</select></div><div class="field"><label>Start time *</label><input name="startTime" type="time" value="13:00" required></div><div class="field"><label>End time *</label><input name="endTime" type="time" value="14:30" required></div></div><div class="form-actions"><button class="btn" type="submit">Save schedule</button><button class="btn secondary" type="button" data-action="navigate" data-page="schedule">Cancel</button></div></form></section><section class="panel"><div class="panel-head"><div><h2>Need a new subject?</h2><div class="panel-sub">Add it in the Subject Catalog before creating a schedule.</div></div><button class="btn secondary small" data-action="navigate" data-page="catalog">Open catalog →</button></div></section>`;
}
function renderStudents(user) {
  const teacherScheduleIds = getTeacherSchedules(user.id).map(s=>s.id);
  const enrolledIds = [...new Set(data.enrollments.filter(e=>teacherScheduleIds.includes(e.scheduleId)).map(e=>e.studentId))];
  const allStudents = data.users.filter(u=>u.role==='student' && enrolledIds.includes(u.id));
  const students = allStudents.filter(student => fullName(student).toLowerCase().includes(studentSearch.toLowerCase()));
  return `${pageHead('My Students', 'Students enrolled in any of your class schedules.', '')}<div class="toolbar"><input id="student-search" placeholder="Search student by name…" value="${esc(studentSearch)}" aria-label="Search students by name"><span class="pill">${students.length} student${students.length===1?'':'s'}</span></div>${students.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>School ID</th><th>Course / Year / Section</th><th>Enrolled classes</th><th>Action</th></tr></thead><tbody>${students.map(student=>{ const enrollments=data.enrollments.filter(e=>e.studentId===student.id && teacherScheduleIds.includes(e.scheduleId)); return `<tr><td class="row-primary">${esc(fullName(student))}</td><td>${esc(student.accountId)}</td><td>${esc(`${student.course} · ${student.year} / ${student.section}`)}</td><td>${enrollments.length}</td><td><button class="btn danger small" data-action="remove-student" data-id="${esc(student.id)}">Remove Student</button></td></tr>`; }).join('')}</tbody></table></div>` : `<div class="empty"><strong>${studentSearch?'No students match that name':'No enrolled students'}</strong>${studentSearch?'Try another name.':'Students appear here after they join your class schedule.'}</div>`}`;
}

function renderTeacherCenter(user) {
  const schedules = getTeacherSchedules(user.id);
  if (!selectedTeacherSchedule && schedules.length) selectedTeacherSchedule = schedules[0].id;
  const schedule = scheduleById(selectedTeacherSchedule);
  const roster = schedule ? enrolledStudents(schedule.id) : [];
  const date = todayISO();
  const rosterRows = roster.map(student => {
    const record = getRecord(student.id, schedule.id, date);
    return `<tr data-roster-student="${esc(student.id)}"><td><span class="row-primary">${esc(fullName(student))}</span><br><span class="muted">${esc(student.accountId)}</span></td><td>${esc(`${student.course} · ${student.year} / ${student.section}`)}</td><td>${record ? badge(record.status) : `<span class="status">NOT RECORDED</span>`}</td><td>${record ? `${esc(record.time)} · ${esc(record.method)}` : '—'}</td><td><button class="btn ghost small" data-action="enroll-fingerprint" data-id="${esc(student.id)}">Enroll Fingerprint</button></td></tr>`;
  }).join('');
  return `${pageHead('Attendance Center', 'Select a class, then verify students with QR, face recognition or a compatible fingerprint reader.', '')}<div class="attendance-tools"><section class="panel"><div class="panel-head"><div><h2>Attendance setup</h2><div class="panel-sub">Uses the live Asia/Manila clock and the 15-minute attendance rule.</div></div></div><div class="field"><label>Class schedule</label><select id="teacher-schedule-select">${schedules.map(s=>`<option value="${esc(s.id)}" ${s.id===selectedTeacherSchedule?'selected':''}>${esc(s.subject)} · ${esc(s.course)} ${esc(s.year)}-${esc(s.section)} · ${esc(s.day)}</option>`).join('')}</select></div>
    <div class="notice" style="margin-top:14px">Choose the correct class. Attendance is checked against the selected teacher, class enrollment, current server time, and any existing record for today.</div>
    <div class="class-actions"><button class="btn" data-action="start-qr-camera" ${schedule?'':'disabled'}>Start QR Camera</button><button class="btn secondary" data-action="start-face-camera" ${schedule?'':'disabled'}>Start Face Camera</button><button class="btn secondary" data-action="start-fingerprint-scan" ${schedule?'':'disabled'}>Start Fingerprint Scan</button><button class="btn ghost" data-action="stop-camera">Stop Camera / Reader</button></div>
    <div class="class-actions"><button class="btn secondary" data-action="refresh-roster">Refresh roster</button><button class="btn danger" data-action="mark-no-shows" ${schedule?'':'disabled'}>Mark no-shows ABSENT</button></div>
  </section><section class="panel"><div class="panel-head"><div><h2>Selected class</h2><div class="panel-sub">Live roster and verification controls.</div></div></div>${schedule ? `<div class="class-card"><div class="class-title">${esc(schedule.subject)}</div><div class="class-meta">${esc(schedule.course)} · ${esc(schedule.year)} Year · Section ${esc(schedule.section)}<br>${esc(schedule.day)} · ${time12(schedule.startTime)}–${time12(schedule.endTime)}</div></div><div class="stats-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:13px;margin-bottom:0">${statCard('Enrolled',roster.length,'Students in this class','♙')}${statCard('Recorded',roster.filter(st=>getRecord(st.id,schedule.id,date)).length,'Records today','◷')}</div>` : `<div class="empty"><strong>No schedule yet</strong>Create a schedule before starting attendance.</div>`}<div class="notice warning" style="margin-top:14px">Phone/laptop cameras require HTTPS or localhost. Face matching requires each student to register a face template first. Use QR when face matching is unclear.</div></section></div>
  <section class="camera-layout" id="camera-region" hidden><div class="panel camera-panel"><div class="panel-head"><div><h2>Live scanner</h2><div class="panel-sub">The camera stays open until you press Stop Camera or leave this page.</div></div><span class="status present">LIVE</span></div><div id="camera-reader" hidden></div><video id="face-video" class="camera-video" autoplay playsinline muted hidden></video><div class="camera-help">QR mode: point the rear camera at the student's QR Pass. Face mode: place one face in view, with good lighting.</div></div><div class="panel live-list-panel"><div class="panel-head"><div><h2>Verified students</h2><div class="panel-sub">Newly attended students appear here without closing the scanner.</div></div><span class="pill" id="live-count">${liveAttendanceEntries.length} scanned</span></div><div id="live-attended-list">${liveAttendanceEntries.map(item=>`<div class="live-attendee"><span class="live-check">✓</span><div><b>${esc(item.name)}</b><small>${esc(item.accountId)} · ${esc(item.time)} · ${esc(item.method)}</small></div>${badge(item.status)}</div>`).join('') || `<div class="empty"><strong>Waiting for scans</strong>Verified students will appear here.</div>`}</div></div></section>
  <section class="panel"><div class="panel-head"><div><h2>Class roster</h2><div class="panel-sub">${esc(date)} · No-shows can only be marked after the class end time.</div></div></div>${roster.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Class placement</th><th>Status</th><th>Record</th><th>Biometric setup</th></tr></thead><tbody>${rosterRows}</tbody></table></div>` : `<div class="empty">No students enrolled in this class yet.</div>`}</section>`;
}
function renderRecords(user) {
  const records = attendanceForTeacher(user.id).filter(r => `${r.date} ${r.time} ${r.method} ${r.status} ${scheduleById(r.scheduleId)?.subject || ''} ${fullName(userById(r.studentId))}`.toLowerCase().includes(recordSearch.toLowerCase()));
  return `${pageHead('Attendance Records', 'Attendance records recorded across your classes.', '')}<div class="toolbar"><input id="record-search" placeholder="Search student, class, status or date…" value="${esc(recordSearch)}"><span class="pill">${records.length} record${records.length===1?'':'s'}</span><button class="btn secondary small" data-action="export-csv">Export CSV</button></div><div id="records-table">${attendanceTable(records,true)}</div>`;
}
function renderCatalog() {
  return `${pageHead('Subject Catalog', 'Manage subjects that can be assigned to a class schedule.', '')}<section class="panel"><div class="panel-head"><div><h2>Add a subject</h2><div class="panel-sub">Subject names are unique in the shared database.</div></div></div><form data-form="add-subject"><div class="inline-form two"><div class="field"><label>Subject name *</label><input name="subject" required maxlength="80" placeholder="e.g. Human Computer Interaction"></div><button type="submit" class="btn">Add subject +</button></div></form></section><section class="panel"><div class="panel-head"><div><h2>Available subjects</h2><div class="panel-sub">${data.subjects.length} subject(s) in the catalog.</div></div></div>${data.subjects.length ? `<div class="class-list">${data.subjects.map(subject=>`<div class="class-card"><div class="class-top"><div class="class-title">${esc(subject)}</div><span class="status active">CATALOG</span></div><div class="class-meta">Used by ${data.schedules.filter(s=>s.subject===subject).length} schedule(s).</div></div>`).join('')}</div>` : `<div class="empty">No subjects in the catalog.</div>`}</section>`;
}
function renderGuide() {
  return `${pageHead('User Guide', 'AttendX Student and Teacher workflows.', `<button class="btn secondary small" data-action="home">Home</button>`)}
  <div class="content-grid">
    <section class="panel"><div class="panel-head"><div><h2>Student flow</h2><div class="panel-sub">Create an account, join the correct class and present your identity.</div></div></div>
      <ol class="guide-list"><li>Choose <b>Student Portal</b>, then log in or register using your School ID.</li><li>Check My Profile and make sure Course, Year and Section are correct.</li><li>Open <b>Browse Classes</b> and join the schedule that matches your course/year/section.</li><li>Open <b>QR Pass</b>, select the enrolled schedule and generate your pass.</li><li>Show the pass to your teacher while their Attendance Center QR scanner is active. Alternatively, register your face in Profile and stand in front of the teacher's Face Camera.</li><li>Review the server-recorded result in My Attendance. Duplicate attendance for the same class/date is blocked.</li></ol>
    </section>
    <section class="panel"><div class="panel-head"><div><h2>Teacher flow</h2><div class="panel-sub">Set up classes before scanning attendance.</div></div></div>
      <ol class="guide-list"><li>Choose <b>Teacher Portal</b>, then log in or register using your Teacher ID.</li><li>Use Subject Catalog if a subject name is missing.</li><li>Open <b>Add Schedule</b> and set Course, Subject, Section, Year, Day, Start Time and End Time.</li><li>Open My Students to review the enrolled class roster. Students must match the class placement to discover/join it.</li><li>Open <b>Attendance Center</b>, select a schedule and start QR or Face Camera. Keep the scanner open; verified students appear in the live list.</li><li>After the scheduled end time, use Mark no-shows ABSENT for students without a record.</li><li>Review Attendance Records and export a CSV when needed.</li></ol>
    </section>
  </div>
  <section class="panel"><div class="panel-head"><div><h2>Attendance timing rule in the latest desktop entry-point code</h2><div class="panel-sub">The server evaluates the clock in Asia/Manila (Philippine time).</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>Time relative to class start</th><th>Result</th><th>Meaning</th></tr></thead><tbody>
      <tr><td>Before or exactly at scheduled start</td><td>${badge('PRESENT')}</td><td>The latest main2.py status function returns PRESENT for an elapsed time at or below zero.</td></tr>
      <tr><td>After start and before +15:00</td><td>${badge('LATE')}</td><td>Any positive elapsed time below 15 minutes is late.</td></tr>
      <tr><td>At +15:00 or later</td><td>${badge('LATE-ABSENT')}</td><td>Attendance is retained but counted with absence-like statuses for drop-rule checks.</td></tr>
      <tr><td>No record after class end</td><td>${badge('ABSENT')}</td><td>The teacher can insert a system ABSENT record after the schedule ends.</td></tr>
    </tbody></table></div>
    <p class="panel-sub" style="margin-top:13px">Important: the uploaded legacy project contains multiple historical status functions in different files. The SQL implementation uses this documented active-entry-point rule for consistency; test it against the specific build your panel will see.</p>
  </section>
  <section class="panel"><div class="notice warning"><b>Browser / hardware notes</b><br>Camera access requires HTTPS or localhost. QR is scanned with the device camera. Face recognition needs every participating student to register a template and is sensitive to lighting, camera quality, twins and similar faces; ambiguous matches are rejected and QR is the fallback. A normal browser cannot directly control the legacy AS608/R307 USB/serial fingerprint reader. This project does not claim that the physical fingerprint hardware is integrated.</div></section>`;
}

const pageTitles = { dashboard:'Dashboard', browse:'Browse Classes', subjects:'My Subjects', attendance:'My Attendance', qr:'QR Pass', profile:'My Profile', schedule:'My Schedule', addSchedule:'Add Schedule', students:'My Students', center:'Attendance Center', records:'Attendance Records', catalog:'Subject Catalog' };
function renderApp() {
  const user = currentUser();
  if (!user) { renderHome(); return; }
  if (user.role === 'student') {
    const html = ({ dashboard:()=>renderStudentDashboard(user), browse:()=>renderBrowseClasses(user), subjects:()=>renderMySubjects(user), attendance:()=>renderAttendance(user), qr:()=>renderQr(user), profile:()=>renderProfile(user) }[activePage] || (()=>renderStudentDashboard(user)))();
    renderShell(html);
  } else {
    const html = ({ dashboard:()=>renderTeacherDashboard(user), schedule:()=>renderSchedule(user), addSchedule:()=>renderAddSchedule(user), students:()=>renderStudents(user), center:()=>renderTeacherCenter(user), records:()=>renderRecords(user), catalog:()=>renderCatalog(), profile:()=>renderProfile(user) }[activePage] || (()=>renderTeacherDashboard(user)))();
    renderShell(html);
  }
  if (modal) $('#app').insertAdjacentHTML('beforeend', renderModal());
  if (activePage === 'qr' && user.role === 'student') window.setTimeout(drawQrCodes, 30);
}
function renderModal() {
  if (!modal) return '';
  if (modal.type === 'face-register') {
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal face-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-content><div class="eyebrow">Student biometric registration</div><h2 id="modal-title">${faceRegistered?'Update face recognition':'Register face recognition'}</h2><p>Allow camera access, look straight at the camera, use good lighting, and keep only one face in view. AttendX stores a 128-number face descriptor for matching; it does not store a photo.</p><div class="face-preview-frame"><video id="face-registration-video" class="camera-video face-register-video" autoplay playsinline muted></video><div id="face-camera-status" class="face-camera-status">Connecting to camera…</div></div><div class="camera-help">Use the front camera on your phone. Keep your whole face inside the preview and wait until the live picture appears.</div><div class="notice warning" style="margin-top:12px">Face matching can make mistakes, including with similar-looking people or twins. The app rejects close/ambiguous matches and the teacher can use QR verification instead.</div><div class="modal-actions"><button class="btn secondary" type="button" data-action="retry-face-camera">Retry Camera</button><button class="btn" type="button" data-action="capture-face" disabled>Waiting for camera…</button><button class="btn secondary" type="button" data-action="close-modal">Cancel</button></div></section></div>`;
  }
  if (modal.type === 'checkin') {
    const schedule = scheduleById(modal.scheduleId);
    const method = modal.method || 'QR';
    if (method === 'FACE') {
      return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-modal-content><div class="eyebrow">Face recognition attendance</div><h2>${esc(schedule?.subject || 'Class check-in')}</h2><p><b>You do not need to generate a QR pass for face attendance.</b> First register your face in My Profile. Then ask your teacher to select this class in Attendance Center and start Face Camera. AttendX will verify your registered face against students enrolled in this class and record attendance if it matches.</p><div class="notice" style="margin-top:12px">Face attendance is teacher-scanned. Opening this page does not record attendance by itself.</div><div class="modal-actions"><button class="btn" type="button" data-action="navigate" data-page="profile">Register / Check My Face</button><button class="btn secondary" type="button" data-action="close-modal">Close</button></div></section></div>`;
    }
    if (method === 'FINGERPRINT') {
      return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-modal-content><div class="eyebrow">Fingerprint attendance</div><h2>Register your fingerprint with your teacher</h2><p>For this web build, a compatible AS608/R307 sensor must be connected to the teacher’s computer through USB-to-serial. The teacher opens Attendance Center, selects this class, then clicks <b>Enroll Fingerprint</b> beside your name and captures the same finger twice.</p><p>After enrollment, the teacher can start <b>Fingerprint Scan</b> to verify a real sensor match and record attendance. A phone browser generally cannot connect directly to the UART reader without a separate supported hardware bridge.</p><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">Close</button></div></section></div>`;
    }
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-modal-content><div class="eyebrow">QR attendance verification</div><h2>${esc(schedule?.subject || 'Class check-in')}</h2><p>QR attendance requires a generated student pass for this class. If you prefer face attendance, use the Face Recognition button instead; QR generation is not required for face verification.</p><div class="modal-actions"><button class="btn" type="button" data-action="navigate" data-page="qr">Open QR Pass</button><button class="btn secondary" type="button" data-action="close-modal">Close</button></div></section></div>`;
  }
  if (modal.type === 'fingerprint-info') {
    const schedule = scheduleById(modal.scheduleId);
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-modal-content><div class="eyebrow">Fingerprint attendance</div><h2>Fingerprint setup needs the external reader</h2><p>This screen will not open QR. The AttendX web fingerprint option uses a physical AS608/R307 reader connected to a compatible laptop/PC through USB-to-serial; it cannot enroll a reusable fingerprint template from the phone’s built-in fingerprint sensor.</p><p>To enroll${schedule ? ` for <b>${esc(schedule.subject)}</b>` : ''}, ask your teacher to sign in on the computer connected to the reader, open <b>Attendance Center</b>, select the class, then click <b>Enroll Fingerprint</b> beside your name. The same finger is captured twice. The teacher can then use <b>Start Fingerprint Scan</b> for attendance.</p><p class="panel-sub">Use the same computer, browser profile and reader for enrollment and scanning. No fingerprint is registered from this phone window.</p><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">Close</button></div></section></div>`;
  }
  if (modal.type === 'class-info') {
    const schedule = scheduleById(modal.scheduleId);
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-modal-content><div class="eyebrow">Class details</div><h2>${esc(schedule?.subject || 'Class details')}</h2><p>${schedule ? `${esc(schedule.course)} · ${esc(schedule.year)} Year · Section ${esc(schedule.section)}<br>${esc(schedule.day)} · ${time12(schedule.startTime)}–${time12(schedule.endTime)}<br>Teacher: ${esc(fullName(teacherFor(schedule)))}` : 'This class is no longer available.'}</p><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">Close</button></div></section></div>`;
  }
  return '';
}
function validHumanName(value, required = false) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return !required;
  return /^[\p{L}][\p{L}\p{M}\s.'’-]*$/u.test(cleaned) && !/\d/.test(cleaned);
}
function cleanText(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function makeId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }
function setUser(user) {
  currentUserId = user?.id || null;
  activePage = 'dashboard';
  view = currentUserId ? 'workspace' : 'home';
  modal = null;
  renderApp();
}
async function authSubmit(form, fields) {
  const client = requireCloud();
  const role = form.dataset.role;
  const mode = form.dataset.mode;
  const accountId = cleanText(fields.get('accountId'));
  const password = String(fields.get('password') || '');
  if (!accountId || !password) return toast('Enter your account ID and password.');
  if (mode === 'register') {
    const firstName = cleanText(fields.get('firstName'));
    const lastName = cleanText(fields.get('lastName'));
    const middleName = cleanText(fields.get('middleName'));
    const suffix = cleanText(fields.get('suffix'));
    const sex = cleanText(fields.get('sex'));
    if (!validHumanName(firstName,true) || !validHumanName(lastName,true) || !validHumanName(middleName) || !validHumanName(suffix)) return toast('Check the name fields. Use letters and normal name punctuation only.');
    if (password.length < 6) return toast('Password must be at least 6 characters.');
    if (!sex) return toast('Select sex to continue.');
    if (role === 'student' && (!cleanText(fields.get('course')) || !cleanText(fields.get('year')) || !cleanText(fields.get('section')))) return toast('Complete course, year level and section.');
    if (role === 'teacher' && !cleanText(fields.get('teacherInviteCode'))) return toast('Enter the teacher invitation code provided by the administrator.');
    const payload = {
      role, accountId, password, firstName, lastName, middleName, suffix, sex,
      teacherInviteCode: role === 'teacher' ? String(fields.get('teacherInviteCode') || '') : '',
      course: cleanText(fields.get('course')), year: cleanText(fields.get('year')),
      section: cleanText(fields.get('section')), department: cleanText(fields.get('department')),
      office: cleanText(fields.get('office'))
    };
    const { data: created, error: registrationError } = await client.functions.invoke('account-register', { body: payload });
    if (registrationError || created?.error || !created?.ok) throw await readFunctionError(registrationError, created);
  }
  const { data: loginData, error: loginError } = await client.auth.signInWithPassword({ email: accountEmail(accountId), password });
  if (loginError || !loginData?.user) throw loginError || new Error('Account ID or password is incorrect.');
  authSession = loginData.session;
  currentUserId = loginData.user.id;
  await refreshWorkspaceData({ silent: true });
  const found = currentUser();
  if (!found || found.role !== role) {
    await client.auth.signOut();
    currentUserId = null; authSession = null; data = emptyData(); renderHome();
    throw new Error(`This account does not belong to the ${roleName(role)} portal. Choose its correct role.`);
  }
  if (found.status === 'INACTIVE' || found.status === 'DROPPED') {
    await client.auth.signOut(); currentUserId = null; authSession = null; data = emptyData(); renderHome();
    throw new Error(found.status === 'DROPPED' ? 'This account was flagged for the absence threshold. Contact the system administrator.' : 'This account is inactive. Please contact the system administrator.');
  }
  const { error: loginEventError } = await client.rpc('record_login_event');
  if (loginEventError) console.warn('Login audit event was not recorded:', loginEventError.message);
  setUser(found);
  toast(`Welcome to AttendX, ${found.firstName}!`);
}
async function handleForm(form) {
  const fields = new FormData(form);
  try {
    switch (form.dataset.form) {
      case 'auth': return await authSubmit(form, fields);
      case 'profile': {
        const user = currentUser();
        const firstName=cleanText(fields.get('firstName')), lastName=cleanText(fields.get('lastName'));
        const middleName=cleanText(fields.get('middleName')), suffix=cleanText(fields.get('suffix'));
        if (!validHumanName(firstName,true)||!validHumanName(lastName,true)||!validHumanName(middleName)||!validHumanName(suffix)) return toast('Check the name fields.');
        const sex=cleanText(fields.get('sex')); if (!['Male','Female'].includes(sex)) return toast('Select Male or Female.');
        const patch = { first_name:firstName, last_name:lastName, middle_name:middleName, suffix, sex };
        if (user.role==='student') Object.assign(patch,{course:cleanText(fields.get('course')).toUpperCase(),year_level:cleanText(fields.get('year')).toUpperCase(),section:cleanText(fields.get('section')).toUpperCase()});
        else Object.assign(patch,{department:cleanText(fields.get('department')),office:cleanText(fields.get('office'))});
        const { error } = await requireCloud().from('profiles').update(patch).eq('id', currentUserId);
        if (error) throw error;
        await refreshWorkspaceData({ silent:true }); renderApp(); return toast('Profile saved to the AttendX cloud database.');
      }
      case 'add-subject': {
        const subject=cleanText(fields.get('subject'));
        if (!subject) return toast('Enter a subject name.');
        if (data.subjects.some(s=>s.toLowerCase()===subject.toLowerCase())) return toast('That subject already exists.');
        const { error } = await requireCloud().from('subjects').insert({ name:subject, created_by:currentUserId });
        if (error) throw error;
        await refreshWorkspaceData({ silent:true }); renderApp(); return toast('Subject added to the shared catalog.');
      }
      case 'add-schedule': {
        const subject=cleanText(fields.get('subject')), course=cleanText(fields.get('course')).toUpperCase(), year=cleanText(fields.get('year')).toUpperCase(), section=cleanText(fields.get('section')).toUpperCase(), day=cleanText(fields.get('day')), startTime=cleanText(fields.get('startTime')), endTime=cleanText(fields.get('endTime'));
        if (!subject || !course || !year || !section || !day || !startTime || !endTime) return toast('Complete all required schedule fields.');
        if (startTime >= endTime) return toast('End time must be later than start time.');
        const client = requireCloud();
        const { data: knownSubject, error: subjectLookupError } = await client.from('subjects')
          .select('name').eq('name_key', subject.toLowerCase()).maybeSingle();
        if (subjectLookupError) throw subjectLookupError;
        if (!knownSubject) {
          const { error: subjectInsertError } = await client.from('subjects').insert({ name:subject, created_by:currentUserId });
          // Another teacher may have added the same normalized name at the same time.
          if (subjectInsertError && subjectInsertError.code !== '23505') throw subjectInsertError;
        }
        const schedule = { id:makeId('schedule'), teacher_id:currentUserId, subject, course, year_level:year, section, day, start_time:startTime, end_time:endTime, status:'ACTIVE' };
        const { error } = await client.from('schedules').insert(schedule);
        if (error) throw error;
        await refreshWorkspaceData({ silent:true }); activePage='schedule'; renderApp(); return toast('Schedule saved. Eligible students can now find it.');
      }
      case 'confirm-checkin': return toast("Attendance can only be recorded through the teacher's QR or face scanner.");
      default: return;
    }
  } catch (error) {
    console.error('AttendX form action failed:', error);
    toast(error.message || String(error));
  }
}
function checkinAction(scheduleId, method) {
  const user=currentUser();
  if (!user || user.role!=='student') return toast('Open the Student portal to display a student QR pass or register face data.');
  if (!data.enrollments.some(e=>e.studentId===user.id&&e.scheduleId===scheduleId)) return toast('Join this class before using an attendance verification method.');
  if (method === 'QR') {
    activePage = 'qr';
    renderApp();
    if (!data.qrTokens[`${user.id}:${scheduleId}`]) toast('Generate the QR Pass for this class, then ask your teacher to scan it.');
    return;
  }
  if (method === 'FACE') {
    if (!faceRegistered) {
      activePage = 'profile'; renderApp();
      toast('Register your face in Profile first. The teacher then uses Face Camera in Attendance Center.');
    } else toast('Face is registered. Your teacher can verify your face from Attendance Center → Start Face Camera.');
    return;
  }
  if (method === 'FINGERPRINT') {
    modal = { type:'fingerprint-info', scheduleId };
    renderApp();
    return;
  }
  modal={type:'checkin',scheduleId,method}; renderApp();
}
function exportTeacherRecords() {
  const records=attendanceForTeacher(currentUserId);
  const lines=[['Date','Time','Student ID','Student Name','Subject','Course','Year','Section','Method','Status']];
  for (const r of records) {
    const u=userById(r.studentId), s=scheduleById(r.scheduleId);
    lines.push([r.date,r.time,u?.accountId||'',fullName(u),s?.subject||'',s?.course||'',s?.year||'',s?.section||'',r.method,r.status]);
  }
  const csv=lines.map(row=>row.map(value=>`"${String(value??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download='AttendX-Attendance-Records.csv'; link.click(); URL.revokeObjectURL(url);
  toast('Attendance CSV exported.');
}
async function markNoShows() {
  const schedule = scheduleById($('#teacher-schedule-select')?.value || selectedTeacherSchedule);
  if (!schedule) return toast('Choose a class schedule first.');
  try {
    const { data: result, error } = await requireCloud().rpc('mark_absent_students', { p_schedule_id: schedule.id });
    if (error) throw error;
    await refreshWorkspaceData({ silent:true });
    renderApp();
    toast(`${result?.inserted ?? 0} student(s) marked ABSENT for the completed class.`);
  } catch (error) { toast(error.message || String(error)); }
}
async function handleClick(event) {
  const control=event.target.closest('[data-action]');
  if (!control) return;
  const action=control.dataset.action;
  try {
    if (action==='close-modal') {
      const backdrop = control.closest('.modal-backdrop');
      const clickedInsideModal = Boolean(event.target.closest('[data-modal-content]'));
      if (backdrop && control === backdrop && clickedInsideModal) return;
      if (modal?.type === 'face-register') await stopCameraTools();
      modal = null; renderApp(); return;
    }
    switch(action) {
      case 'home':
        await stopCameraTools();
        if (currentUserId) { activePage='dashboard'; modal=null; renderApp(); }
        else { modal=null; renderHome(); }
        break;
      case 'auth':
        await stopCameraTools(); authRole=control.dataset.role||'student'; authMode=control.dataset.mode||'login'; modal=null; renderAuth(); break;
      case 'guide':
        await stopCameraTools(); view='guide'; $('#app').innerHTML=`${header()}<main class="main-area">${renderGuide()}</main>${footerNote()}`; break;
      case 'connection-test': {
        if (!supabase) { toast('Supabase configuration is missing. Set the VITE_SUPABASE_* values first.'); break; }
        try {
          const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_PUBLIC_KEY } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          toast('Supabase Auth endpoint is reachable. Sign in to test the protected database.');
        } catch (error) { toast(`Supabase connection failed: ${error.message || error}`); }
        break;
      }
      case 'navigate':
        await stopCameraTools();
        activePage=control.dataset.page; modal=null; renderApp(); break;
      case 'logout':
        await stopCameraTools();
        if (supabase) { const { error } = await supabase.auth.signOut(); if (error) console.warn('Signout:', error); }
        currentUserId=null; authSession=null; data=emptyData(); modal=null; liveAttendanceEntries=[]; renderHome(); toast('Logged out.'); break;
      case 'join-class': {
        const scheduleId=control.dataset.id;
        if (data.enrollments.some(e=>e.studentId===currentUserId&&e.scheduleId===scheduleId)) { toast('You are already enrolled in this class.'); break; }
        const { error } = await requireCloud().from('enrollments').insert({ student_id:currentUserId, schedule_id:scheduleId });
        if (error) throw error;
        await refreshWorkspaceData({ silent:true }); renderApp(); toast('You joined the class. Your QR pass was generated automatically.'); break;
      }
      case 'view-class': modal={type:'class-info',scheduleId:control.dataset.id}; renderApp(); break;
      case 'checkin': checkinAction(control.dataset.id,control.dataset.method); break;
      case 'show-checkins': activePage='attendance'; renderApp(); break;
      case 'copy-token': {
        const token=control.dataset.token||'';
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(token);
        else window.prompt('Copy this token:', token);
        toast('QR pass token copied.'); break;
      }
      case 'refresh-qr-passes':
        await refreshWorkspaceData({ silent:true });
        renderApp();
        toast(Object.keys(data.qrTokens).length ? 'Your automatically generated QR passes are up to date.' : 'No QR token loaded yet. Confirm that the enrollment is active and the latest QR migration has been applied.');
        break;
      case 'download-qr': {
        const canvas = control.closest('.panel')?.querySelector('canvas[data-qr-token]');
        if (!canvas || canvas.dataset.drawn !== '1') { toast('Generate the QR pass first.'); break; }
        const link=document.createElement('a'); link.download=`AttendX-QR-${control.dataset.id}.png`; link.href=canvas.toDataURL('image/png'); link.click(); break;
      }
      case 'teacher-period': teacherPeriod=['today','week','month'].includes(control.dataset.period)?control.dataset.period:'today'; renderApp(); break;
      case 'teacher-class':
        await stopCameraTools(); selectedTeacherSchedule=control.dataset.id; activePage='center'; renderApp(); break;
      case 'refresh-roster':
        selectedTeacherSchedule=$('#teacher-schedule-select')?.value||selectedTeacherSchedule;
        await stopCameraTools();
        await refreshWorkspaceData({ silent:true }); renderApp(); toast('Roster refreshed from Supabase.'); break;
      case 'mark-no-shows':
        selectedTeacherSchedule=$('#teacher-schedule-select')?.value||selectedTeacherSchedule; await stopCameraTools(); await markNoShows(); break;
      case 'start-qr-camera': await startQrCamera(); break;
      case 'start-face-camera': await startFaceCamera(); break;
      case 'start-fingerprint-scan': await startFingerprintAttendanceScan(); break;
      case 'enroll-fingerprint': await registerStudentFingerprint(control.dataset.id); break;
      case 'stop-camera': await stopCameraTools(); if ($('#camera-region')) $('#camera-region').hidden=true; toast('Camera and fingerprint reader stopped.'); break;
      case 'register-face':
        if (currentUser()?.role !== 'student') { toast('Only students can register their face.'); break; }
        // Finish cleaning up the previous camera/reader before creating the new
        // preview. Otherwise an awaited old cleanup can close the new stream.
        await stopCameraTools();
        modal={type:'face-register'};
        renderApp();
        await startFaceRegistrationCamera();
        break;
      case 'retry-face-camera':
        if (modal?.type !== 'face-register') break;
        if (faceRegStream) { for (const track of faceRegStream.getTracks()) track.stop(); faceRegStream = null; }
        const retryVideo = $('#face-registration-video');
        if (retryVideo) { try { retryVideo.pause(); } catch {} retryVideo.srcObject = null; }
        await startFaceRegistrationCamera();
        break;
      case 'capture-face': await captureAndSaveFace(); break;
      case 'fingerprint-help': modal=null; renderApp(); toast('This browser cannot directly control the old AS608/R307 serial fingerprint reader. See README for the web-safe options.'); break;
      case 'export-csv': exportTeacherRecords(); break;
      case 'remove-student': {
        const studentId=control.dataset.id;
        if (!window.confirm('Remove this student from all schedules owned by this teacher? Their historical attendance remains.')) break;
        const mySchedules=getTeacherSchedules(currentUserId).map(s=>s.id);
        if (!mySchedules.length) break;
        const { error } = await requireCloud().from('enrollments').delete().eq('student_id',studentId).in('schedule_id',mySchedules);
        if (error) throw error;
        await refreshWorkspaceData({ silent:true }); renderApp(); toast('Student removed from your class enrolments.'); break;
      }
      default: break;
    }
  } catch (error) {
    console.error(`AttendX action ${action} failed:`, error);
    toast(error.message || String(error));
  }
}
function handleInput(event) {
  if (event.target.id==='class-search') {
    const cursor=event.target.selectionStart; classSearch=event.target.value;
    const u = currentUser();
    const list=data.schedules.filter(s=>s.status!=='ARCHIVED' && u?.role === 'student'
      && String(s.course).trim().toLowerCase()===String(u.course).trim().toLowerCase()
      && String(s.year).trim().toLowerCase()===String(u.year).trim().toLowerCase()
      && String(s.section).trim().toLowerCase()===String(u.section).trim().toLowerCase())
      .filter(s=>`${s.subject} ${s.course} ${s.year} ${s.section} ${fullName(teacherFor(s))}`.toLowerCase().includes(classSearch.toLowerCase()));
    const results=$('.class-list'); if (results) results.innerHTML=list.length?list.map(s=>classCard(s,{browse:true})).join(''):`<div class="empty"><strong>No matching classes</strong>Try another search.</div>`;
    const pill=$('.toolbar .pill'); if(pill)pill.textContent=`${list.length} class${list.length===1?'':'es'} found`;
  }
  if (event.target.id==='student-search') {
    studentSearch=event.target.value;
    const user=currentUser();
    if(user?.role==='teacher') { const teacherScheduleIds=getTeacherSchedules(user.id).map(s=>s.id); const enrolledIds=[...new Set(data.enrollments.filter(e=>teacherScheduleIds.includes(e.scheduleId)).map(e=>e.studentId))]; const rows=data.users.filter(u=>u.role==='student'&&enrolledIds.includes(u.id)&&fullName(u).toLowerCase().includes(studentSearch.toLowerCase())); const target=$('.table-wrap tbody'); if(target) target.innerHTML=rows.map(student=>{ const enrollments=data.enrollments.filter(e=>e.studentId===student.id&&teacherScheduleIds.includes(e.scheduleId)); return `<tr><td class="row-primary">${esc(fullName(student))}</td><td>${esc(student.accountId)}</td><td>${esc(`${student.course} · ${student.year} / ${student.section}`)}</td><td>${enrollments.length}</td><td><button class="btn danger small" data-action="remove-student" data-id="${esc(student.id)}">Remove Student</button></td></tr>`; }).join(''); const pill=$('.toolbar .pill'); if(pill)pill.textContent=`${rows.length} student${rows.length===1?'':'s'}`; }
  }
  if (event.target.id==='record-search') {
    recordSearch=event.target.value;
    const user=currentUser();
    if(user?.role==='student') { const rows=attendanceForStudent(user.id).filter(r=>`${r.date} ${r.time} ${r.method} ${r.status} ${scheduleById(r.scheduleId)?.subject||''}`.toLowerCase().includes(recordSearch.toLowerCase())); const target=$('#attendance-table'); if(target) target.innerHTML=attendanceTable(rows,false); }
    if(user?.role==='teacher') { const rows=attendanceForTeacher(user.id).filter(r=>`${r.date} ${r.time} ${r.method} ${r.status} ${scheduleById(r.scheduleId)?.subject||''} ${fullName(userById(r.studentId))}`.toLowerCase().includes(recordSearch.toLowerCase())); const target=$('#records-table'); if(target) target.innerHTML=attendanceTable(rows,true); }
  }
}
$('#app').addEventListener('click', handleClick);
$('#app').addEventListener('submit', event => { const form=event.target.closest('form[data-form]'); if (!form) return; event.preventDefault(); handleForm(form); });
$('#app').addEventListener('input', handleInput);
$('#app').addEventListener('change', async event => { if(event.target.id==='teacher-schedule-select'){await stopCameraTools(); if($('#camera-region')) $('#camera-region').hidden=true; selectedTeacherSchedule=event.target.value; liveAttendanceEntries=[]; renderApp();} });
setInterval(() => { const clock=$('#live-clock'); if(clock) clock.textContent=liveClockText(); }, 1000);
window.addEventListener('beforeunload', () => { void stopCameraTools(); });
startApplication();
