const crypto = require('node:crypto');
const R = require('./rules');

const MUTATIONS = new Set(['register', 'profiles.create', 'profiles.save', 'bindings.resolve', 'staff.save', 'schedule.save', 'schedule.fill', 'bookings.create', 'bookings.cancel', 'bookings.signin', 'bookings.undo', 'credits.adjust', 'logs.save', 'media.prepare', 'catalog.seed']);
const C = { accounts: 'accounts', students: 'students', therapists: 'therapists', therapistDays: 'therapistDays', studentDays: 'studentDays', bookings: 'bookings', ledger: 'ledger', logs: 'logs', operations: 'operations', outbox: 'outbox', audits: 'audits', templates: 'scheduleTemplates', uploads: 'uploads', mediaArchives: 'mediaArchives' };
const hash = input => crypto.createHash('sha256').update(input).digest('hex');
const id = () => crypto.randomUUID();
const teacherDayId = (teacherId, date) => `${teacherId}_${date}`;
const studentDayId = (studentId, date) => `${studentId}_${date}`;
const clone = value => JSON.parse(JSON.stringify(value));
const unwrapTransaction = value => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'result') && typeof value.errMsg === 'string' ? value.result : value;

async function get(db, collection, docId) {
  try {
    const result = await db.collection(collection).doc(docId).get();
    return result && result.data && !Array.isArray(result.data) ? result.data : null;
  } catch (error) {
    if (/DOCUMENT_NOT_EXIST|DOC_NOT_EXIST|DOCUMENT_NOT_FOUND/i.test(String(error.code || error.message))) return null;
    throw error;
  }
}
async function set(db, collection, docId, data) {
  return db.collection(collection).doc(docId).set({ data });
}
async function list(db, collection, limit = 100) {
  const result = await db.collection(collection).limit(limit).get();
  return result.data || [];
}
async function pageQuery(db, collection, filter, payload = {}, sortField = null) {
  const page = Number.isInteger(payload.page) && payload.page >= 1 ? Math.min(payload.page - 1, 9999) : 0;
  const pageSize = Number.isInteger(payload.pageSize) ? Math.max(1, Math.min(payload.pageSize, 50)) : 50;
  let query = db.collection(collection);
  if (filter) query = query.where(filter);
  if (sortField) query = query.orderBy(sortField, 'desc');
  const result = await query.skip(page * pageSize).limit(pageSize).get();
  return result.data || [];
}
function role(account, allowed) {
  R.requireThat(account && account.enabled !== false && allowed.includes(account.role), 'FORBIDDEN', '当前账号无权执行此操作');
}
function requireStudentAccess(account, studentId) {
  if (account.role === 'student') R.requireThat(account.studentId === studentId, 'FORBIDDEN', '只能查看自己的档案');
  else role(account, ['therapist', 'admin']);
}
function bookingView(booking, student, therapist, account, now) {
  const isStudent = account.role === 'student' && account.studentId === booking.studentId;
  const isTeacher = account.role === 'therapist' && account.therapistId === booking.therapistId;
  const isAdmin = account.role === 'admin';
  return {
    ...booking,
    studentName: student && student.name,
    therapistName: therapist && therapist.name,
    canCancel: booking.status === 'booked' && (isAdmin || (isStudent && R.dateMinuteTime(booking.date, booking.startMinute) > now.getTime())),
    canSignin: booking.status === 'booked' && (isTeacher || isAdmin) && R.dateMinuteTime(booking.date, booking.startMinute) <= now.getTime(),
    canUndo: booking.status === 'checkedIn' && isAdmin
  };
}
function studentView(student) {
  return { ...student, available: R.available(student.balance, student.held) };
}
function ensureCredit(student, delta) {
  const next = student.balance + delta;
  R.requireThat(Number.isInteger(next) && next >= student.held, 'INSUFFICIENT_CREDIT', '课时不足，请先处理未签到预约');
  return next;
}

function createService({ db, cloud = null, env = {}, now = () => new Date() }) {
  async function accountFor(openid) {
    let account = await get(db, C.accounts, openid);
    if (!account && env.BOOTSTRAP_ADMIN_OPENID && openid === env.BOOTSTRAP_ADMIN_OPENID) {
      account = { id: openid, role: 'admin', enabled: true, revision: 0, createdAt: now().toISOString() };
      await set(db, C.accounts, openid, account);
    }
    return account;
  }
  async function transact(openid, action, requestId, payload, work) {
    R.requireThat(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(requestId), 'REQUEST_ID_REQUIRED', '操作标识无效，请重试');
    const opId = hash(`${openid}:${action}:${requestId}`);
    const payloadHash = hash(JSON.stringify(payload));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await db.runTransaction(async tx => {
          const prior = await get(tx, C.operations, opId);
          if (prior) {
            R.requireThat(prior.payloadHash === payloadHash, 'REQUEST_ID_REUSED', '该操作标识已用于其他内容');
            return prior.result;
          }
          const result = await work(tx, now());
          await set(tx, C.operations, opId, { id: opId, actor: openid, action, payloadHash, result, createdAt: now().toISOString() });
          return result;
        });
        return unwrapTransaction(raw);
      } catch (error) {
        if (!/TRANSACTION_CONFLICT|WRITE_CONFLICT/i.test(String(error.code || error.message)) || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
  async function requireAccount(openid, allowed) {
    const account = await accountFor(openid);
    role(account, allowed);
    return account;
  }
  async function getBookingFor(account, bookingId, store = db) {
    const booking = await get(store, C.bookings, bookingId);
    R.requireThat(booking, 'NOT_FOUND', '预约不存在');
    R.requireThat(account.role === 'admin' || (account.role === 'student' && account.studentId === booking.studentId) || (account.role === 'therapist' && account.therapistId === booking.therapistId), 'FORBIDDEN', '无权查看该预约');
    return booking;
  }
  async function audit(tx, type, actor, targetId, details) {
    const auditId = id();
    await set(tx, C.audits, auditId, { id: auditId, type, actor, targetId, details, at: now().toISOString() });
  }
  async function touchAccount(tx, account) {
    account.revision = (account.revision || 0) + 1;
    await set(tx, C.accounts, account.id, account);
  }

  async function bootstrap(openid) {
    const account = await accountFor(openid);
    const therapists = (await list(db, C.therapists, 20)).filter(t => t.enabled !== false);
    const student = account && account.studentId ? await get(db, C.students, account.studentId) : null;
    const therapist = account && account.therapistId ? await get(db, C.therapists, account.therapistId) : null;
    return { role: !account ? 'unregistered' : account.enabled === false ? 'disabled' : account.role, account, selfOpenid: openid, student: student ? studentView(student) : null, therapist, therapists, projects: R.PROJECTS, subscriptionTemplateId: env.SIGNIN_TEMPLATE_ID || '' };
  }
  async function seed(openid, requestId) {
    await requireAccount(openid, ['admin']);
    return transact(openid, 'catalog.seed', requestId, {}, async tx => {
      for (const therapist of R.THERAPISTS) {
        if (!await get(tx, C.therapists, therapist.id)) await set(tx, C.therapists, therapist.id, { ...therapist, enabled: true, projectIds: [], revision: 0 });
      }
      return { therapists: R.THERAPISTS.length, projects: R.PROJECTS.length };
    });
  }
  async function register(openid, payload, requestId) {
    R.requireThat(['new', 'bind'].includes(payload.mode) && R.nonEmpty(payload.name, 50) && R.validPhone(payload.phone), 'INVALID_INPUT', '请填写姓名和 11 位手机号');
    return transact(openid, 'register', requestId, payload, async tx => {
      const existing = await get(tx, C.accounts, openid);
      R.requireThat(!existing || existing.role === 'unregistered' || (existing.role === 'pending' && payload.mode === 'bind'), 'ALREADY_REGISTERED', '当前账号已经建档或关联工作人员');
      if (payload.mode === 'bind') {
        const account = { id: openid, role: 'pending', enabled: true, pendingBinding: { name: payload.name.trim(), phone: payload.phone.trim(), submittedAt: now().toISOString() }, revision: (existing && existing.revision || 0) + 1 };
        await set(tx, C.accounts, openid, account);
        return { role: 'pending' };
      }
      const studentId = id();
      const student = { id: studentId, name: payload.name.trim(), phone: payload.phone.trim(), notes: '', balance: 0, held: 0, version: 1, boundAccountId: openid, enabled: true, createdBy: openid, updatedBy: openid, updatedAt: now().toISOString() };
      const account = { id: openid, role: 'student', studentId, enabled: true, revision: 1, createdAt: now().toISOString() };
      await set(tx, C.students, studentId, student);
      await set(tx, C.accounts, openid, account);
      return { role: 'student', student: studentView(student) };
    });
  }
  async function profilesCreate(openid, payload, requestId) {
    const actor = await requireAccount(openid, ['therapist', 'admin']);
    R.requireThat(R.nonEmpty(payload.name, 50) && R.validPhone(payload.phone), 'INVALID_INPUT', '请填写姓名和 11 位手机号');
    return transact(openid, 'profiles.create', requestId, payload, async tx => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['therapist', 'admin']);
      const studentId = id();
      const student = { id: studentId, name: payload.name.trim(), phone: payload.phone.trim(), notes: typeof payload.notes === 'string' ? payload.notes.trim().slice(0, 2000) : '', balance: 0, held: 0, version: 1, boundAccountId: null, enabled: true, createdBy: actor.id, updatedBy: actor.id, updatedAt: now().toISOString() };
      await set(tx, C.students, studentId, student);
      await touchAccount(tx, current);
      return studentView(student);
    });
  }
  async function profilesList(openid, payload) {
    await requireAccount(openid, ['therapist', 'admin']);
    const term = String(payload.query || '').trim().slice(0, 50);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = term && new db.RegExp({ regexp: escaped, options: 'i' });
    const filter = term ? db.command.or({ name: expression }, { phone: expression }) : null;
    const rows = await pageQuery(db, C.students, filter, payload, 'updatedAt');
    return rows.filter(s => s.enabled !== false).map(studentView);
  }
  async function profilesGet(openid, payload) {
    const account = await requireAccount(openid, ['student', 'therapist', 'admin']);
    const studentId = payload.studentId || account.studentId;
    requireStudentAccess(account, studentId);
    const student = await get(db, C.students, studentId);
    R.requireThat(student && student.enabled !== false, 'NOT_FOUND', '学员档案不存在');
    const ledger = account.role === 'admin' ? await pageQuery(db, C.ledger, { studentId }, { page: 1, pageSize: 50 }, 'at') : undefined;
    return { ...studentView(student), ledger: account.role === 'admin' ? ledger : undefined };
  }
  async function profilesSave(openid, payload, requestId) {
    const account = await requireAccount(openid, ['student', 'therapist', 'admin']);
    const studentId = payload.studentId || account.studentId;
    requireStudentAccess(account, studentId);
    R.requireThat(R.nonEmpty(payload.name, 50) && R.validPhone(payload.phone) && Number.isInteger(payload.version), 'INVALID_INPUT', '资料不完整，请刷新后重试');
    return transact(openid, 'profiles.save', requestId, payload, async tx => {
      const currentAccount = await get(tx, C.accounts, openid);
      role(currentAccount, ['student', 'therapist', 'admin']);
      requireStudentAccess(currentAccount, studentId);
      const student = await get(tx, C.students, studentId);
      R.requireThat(student && student.version === payload.version, 'VERSION_CONFLICT', '资料已被他人更新，请刷新后再保存');
      student.name = payload.name.trim();
      student.phone = payload.phone.trim();
      if (currentAccount.role !== 'student' && typeof payload.notes === 'string') student.notes = payload.notes.trim().slice(0, 2000);
      student.version++;
      student.updatedBy = openid;
      student.updatedAt = now().toISOString();
      await set(tx, C.students, studentId, student);
      if (currentAccount.role === 'therapist') await touchAccount(tx, currentAccount);
      await audit(tx, 'profileEdit', openid, studentId, { version: student.version });
      return studentView(student);
    });
  }
  async function bindingsList(openid, payload) {
    await requireAccount(openid, ['admin']);
    return (await pageQuery(db, C.accounts, { role: 'pending' }, payload, 'id')).filter(a => a.pendingBinding).map(a => ({ accountId: a.id, ...a.pendingBinding }));
  }
  async function bindingsResolve(openid, payload, requestId) {
    await requireAccount(openid, ['admin']);
    R.requireThat(R.nonEmpty(payload.accountId, 100) && R.nonEmpty(payload.studentId, 100), 'INVALID_INPUT', '请选择账号和学员档案');
    return transact(openid, 'bindings.resolve', requestId, payload, async tx => {
      role(await get(tx, C.accounts, openid), ['admin']);
      const target = await get(tx, C.accounts, payload.accountId);
      const student = await get(tx, C.students, payload.studentId);
      R.requireThat(target && ['pending', 'unregistered'].includes(target.role) && student && student.enabled !== false, 'NOT_FOUND', '待绑定账号或档案不存在');
      const oldId = student.boundAccountId;
      if (oldId && oldId !== target.id) {
        R.requireThat(payload.replace === true, 'ALREADY_BOUND', '原档案已绑定其他账号，请核对后选择换绑');
        const old = await get(tx, C.accounts, oldId);
        if (old) await set(tx, C.accounts, oldId, { ...old, role: 'unregistered', studentId: null, revision: (old.revision || 0) + 1 });
      }
      target.role = 'student';
      target.studentId = student.id;
      target.pendingBinding = null;
      target.revision = (target.revision || 0) + 1;
      student.boundAccountId = target.id;
      await set(tx, C.accounts, target.id, target);
      await set(tx, C.students, student.id, student);
      await audit(tx, oldId ? 'replaceBinding' : 'bind', openid, student.id, { from: oldId || null, to: target.id });
      return { studentId: student.id, accountId: target.id };
    });
  }
  async function staffList(openid) {
    await requireAccount(openid, ['admin']);
    const therapists = await list(db, C.therapists, 20);
    const rows = await Promise.all(therapists.map(async therapist => {
      const count = await db.collection(C.bookings).where({ therapistId: therapist.id, status: 'booked' }).count();
      return { ...therapist, pendingCount: count.total || 0 };
    }));
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  async function staffSave(openid, payload, requestId) {
    await requireAccount(openid, ['admin']);
    R.requireThat(R.THERAPISTS.some(t => t.id === payload.therapistId), 'INVALID_INPUT', '教练编号无效');
    R.requireThat(Array.isArray(payload.projectIds) && payload.projectIds.every(projectId => R.PROJECTS.some(p => p.id === projectId)), 'INVALID_INPUT', '服务项目无效');
    return transact(openid, 'staff.save', requestId, payload, async tx => {
      role(await get(tx, C.accounts, openid), ['admin']);
      const therapist = await get(tx, C.therapists, payload.therapistId);
      R.requireThat(therapist, 'NOT_FOUND', '教练不存在');
      if (payload.accountOpenid === '' && therapist.accountOpenid) {
        const old = await get(tx, C.accounts, therapist.accountOpenid);
        if (old) await set(tx, C.accounts, old.id, { ...old, role: 'unregistered', therapistId: null, enabled: true, revision: (old.revision || 0) + 1 });
        therapist.accountOpenid = null;
      } else if (payload.accountOpenid && payload.accountOpenid !== therapist.accountOpenid) {
        R.requireThat(R.nonEmpty(payload.accountOpenid, 100), 'INVALID_INPUT', '账号标识无效');
        const target = await get(tx, C.accounts, payload.accountOpenid);
        R.requireThat(!target || ['unregistered', 'pending'].includes(target.role), 'ALREADY_BOUND', '该微信账号已关联其他身份');
        if (therapist.accountOpenid) {
          const old = await get(tx, C.accounts, therapist.accountOpenid);
          if (old) await set(tx, C.accounts, old.id, { ...old, role: 'unregistered', therapistId: null, enabled: true, revision: (old.revision || 0) + 1 });
        }
        await set(tx, C.accounts, payload.accountOpenid, { id: payload.accountOpenid, role: 'therapist', therapistId: therapist.id, enabled: payload.enabled !== false, revision: (target && target.revision || 0) + 1 });
        therapist.accountOpenid = payload.accountOpenid;
      } else if (therapist.accountOpenid) {
        const target = await get(tx, C.accounts, therapist.accountOpenid);
        if (target) await set(tx, C.accounts, target.id, { ...target, enabled: payload.enabled !== false, revision: (target.revision || 0) + 1 });
      }
      therapist.projectIds = [...new Set(payload.projectIds)];
      therapist.enabled = payload.enabled !== false;
      therapist.revision = (therapist.revision || 0) + 1;
      await set(tx, C.therapists, therapist.id, therapist);
      await audit(tx, 'staffSave', openid, therapist.id, { enabled: therapist.enabled, projectIds: therapist.projectIds });
      return therapist;
    });
  }
  async function scheduleGet(openid, payload) {
    const account = await requireAccount(openid, ['therapist', 'admin']);
    const therapistId = payload.therapistId || account.therapistId;
    R.requireThat(account.role === 'admin' || account.therapistId === therapistId, 'FORBIDDEN', '只能查看自己的排班');
    R.requireThat(R.validDate(payload.date), 'INVALID_DATE', '日期无效');
    const day = await get(db, C.therapistDays, teacherDayId(therapistId, payload.date));
    const template = await get(db, C.templates, therapistId);
    return { date: payload.date, ranges: day ? day.ranges : [], configured: !!day, occupancies: day ? day.occupancies : [], template: template || null };
  }
  async function scheduleSave(openid, payload, requestId) {
    const account = await requireAccount(openid, ['therapist', 'admin']);
    const therapistId = payload.therapistId || account.therapistId;
    R.requireThat(account.role === 'admin' || account.therapistId === therapistId, 'FORBIDDEN', '只能维护自己的排班');
    R.requireThat(R.validDate(payload.date), 'INVALID_DATE', '日期无效');
    const ranges = R.normalizeRanges(payload.ranges);
    return transact(openid, 'schedule.save', requestId, payload, async tx => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['therapist', 'admin']);
      R.requireThat(current.role === 'admin' || current.therapistId === therapistId, 'FORBIDDEN', '只能维护自己的排班');
      const therapist = await get(tx, C.therapists, therapistId);
      R.requireThat(therapist && therapist.enabled !== false, 'STAFF_DISABLED', '教练已停用');
      const key = teacherDayId(therapistId, payload.date);
      const day = await get(tx, C.therapistDays, key) || { id: key, therapistId, date: payload.date, occupancies: [] };
      const affected = day.occupancies.filter(booking => !ranges.some(range => R.inside(booking, range)));
      R.requireThat(affected.length === 0, 'SCHEDULE_CONFLICT', `有 ${affected.length} 个有效预约受影响：${affected.slice(0, 5).map(item => `${String(Math.floor(item.startMinute / 60)).padStart(2, '0')}:${String(item.startMinute % 60).padStart(2, '0')}（${item.bookingId.slice(0, 8)}）`).join('、')}${affected.length > 5 ? '等' : ''}。请先处理预约。`);
      day.ranges = ranges;
      day.configured = true;
      day.updatedBy = openid;
      day.updatedAt = now().toISOString();
      await set(tx, C.therapistDays, key, day);
      if (current.role === 'therapist') await touchAccount(tx, current);
      return { date: day.date, ranges: day.ranges };
    });
  }
  async function scheduleFill(openid, payload, requestId) {
    const account = await requireAccount(openid, ['therapist', 'admin']);
    const therapistId = payload.therapistId || account.therapistId;
    R.requireThat(account.role === 'admin' || account.therapistId === therapistId, 'FORBIDDEN', '只能维护自己的排班');
    R.requireThat(R.validDate(payload.startDate) && R.validDate(payload.endDate), 'INVALID_DATE', '日期无效');
    const start = R.dateMinuteTime(payload.startDate, 0);
    const end = R.dateMinuteTime(payload.endDate, 0);
    const days = Math.round((end - start) / 86400000) + 1;
    R.requireThat(days >= 1 && days <= 31, 'INVALID_RANGE', '每次可填充 1 至 31 天');
    R.requireThat(Array.isArray(payload.weekdays) && payload.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6), 'INVALID_INPUT', '请选择星期');
    const ranges = R.normalizeRanges(payload.ranges);
    await transact(openid, 'schedule.fill.template', requestId, { therapistId, weekdays: payload.weekdays, ranges, startDate: payload.startDate, endDate: payload.endDate }, async tx => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['therapist', 'admin']);
      R.requireThat(current.role === 'admin' || current.therapistId === therapistId, 'FORBIDDEN', '只能维护自己的排班');
      const therapist = await get(tx, C.therapists, therapistId);
      R.requireThat(therapist && therapist.enabled !== false, 'STAFF_DISABLED', '教练已停用');
      await set(tx, C.templates, therapistId, { id: therapistId, weekdays: [...new Set(payload.weekdays)], ranges, updatedAt: now().toISOString() });
      if (current.role === 'therapist') await touchAccount(tx, current);
      return true;
    });
    const summary = { filled: 0, skipped: 0, failed: 0 };
    for (let offset = 0; offset < days; offset++) {
      const date = new Date(start + offset * 86400000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
      if (!payload.weekdays.includes(weekday)) continue;
      try {
        const result = await transact(openid, 'schedule.fill.day', `${requestId}_${date.replace(/-/g, '')}`, { therapistId, date, ranges }, async tx => {
          const current = await get(tx, C.accounts, openid);
          role(current, ['therapist', 'admin']);
          R.requireThat(current.role === 'admin' || current.therapistId === therapistId, 'FORBIDDEN', '只能维护自己的排班');
          const therapist = await get(tx, C.therapists, therapistId);
          R.requireThat(therapist && therapist.enabled !== false, 'STAFF_DISABLED', '教练已停用');
          const key = teacherDayId(therapistId, date);
          if (await get(tx, C.therapistDays, key)) return 'skipped';
          await set(tx, C.therapistDays, key, { id: key, therapistId, date, ranges, occupancies: [], configured: true, updatedBy: openid, updatedAt: now().toISOString() });
          if (current.role === 'therapist') await touchAccount(tx, current);
          return 'filled';
        });
        summary[result]++;
      } catch (_) { summary.failed++; }
    }
    return summary;
  }
  async function bookingSlots(openid, payload) {
    const account = await requireAccount(openid, ['student']);
    R.requireThat(R.validDate(payload.date), 'INVALID_DATE', '日期无效');
    const project = R.PROJECTS.find(item => item.id === payload.projectId);
    const therapist = await get(db, C.therapists, payload.therapistId);
    R.requireThat(project && therapist && therapist.enabled !== false && therapist.projectIds.includes(project.id), 'NOT_FOUND', '教练暂未提供该项目');
    const student = await get(db, C.students, account.studentId);
    R.requireThat(student && student.boundAccountId === openid, 'FORBIDDEN', '档案绑定已变化，请重新进入');
    const day = await get(db, C.therapistDays, teacherDayId(therapist.id, payload.date));
    const ownDay = await get(db, C.studentDays, studentDayId(student.id, payload.date));
    const slots = [];
    if (day && student.balance > student.held) {
      for (const range of day.ranges) {
        for (let startMinute = range.startMinute; startMinute + project.duration <= range.endMinute; startMinute += 30) {
          if (R.bookable({ date: payload.date, startMinute, duration: project.duration, ranges: day.ranges, occupancies: day.occupancies, studentOccupancies: ownDay && ownDay.occupancies, now: now() })) slots.push({ startMinute, endMinute: startMinute + project.duration });
        }
      }
    }
    return { slots, available: R.available(student.balance, student.held), duration: project.duration };
  }
  async function bookingsList(openid, payload) {
    const account = await requireAccount(openid, ['student', 'therapist', 'admin']);
    const filter = {};
    if (account.role === 'student') filter.studentId = account.studentId;
    else if (payload.studentId) filter.studentId = payload.studentId;
    if (account.role === 'therapist') filter.therapistId = account.therapistId;
    else if (payload.therapistId) filter.therapistId = payload.therapistId;
    if (payload.date) filter.date = payload.date;
    const filtered = await pageQuery(db, C.bookings, filter, payload, 'createdAt');
    const students = new Map();
    const therapists = new Map();
    const result = [];
    for (const booking of filtered) {
      if (!students.has(booking.studentId)) students.set(booking.studentId, await get(db, C.students, booking.studentId));
      if (!therapists.has(booking.therapistId)) therapists.set(booking.therapistId, await get(db, C.therapists, booking.therapistId));
      result.push(bookingView(booking, students.get(booking.studentId), therapists.get(booking.therapistId), account, now()));
    }
    return result;
  }
  async function bookingsCreate(openid, payload, requestId) {
    const account = await requireAccount(openid, ['student']);
    const startMinute = Number(payload.startMinute);
    R.requireThat(R.validDate(payload.date) && Number.isInteger(startMinute), 'INVALID_INPUT', '请选择有效日期和时间');
    const project = R.PROJECTS.find(item => item.id === payload.projectId);
    R.requireThat(project, 'INVALID_INPUT', '请选择有效项目');
    return transact(openid, 'bookings.create', requestId, payload, async (tx, at) => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['student']);
      const student = await get(tx, C.students, current.studentId);
      const therapist = await get(tx, C.therapists, payload.therapistId);
      R.requireThat(student && student.boundAccountId === openid, 'FORBIDDEN', '档案绑定已变化，请重新进入');
      R.requireThat(therapist && therapist.enabled !== false && therapist.projectIds.includes(project.id), 'STAFF_UNAVAILABLE', '教练或项目暂不可约');
      R.requireThat(student.balance > student.held, 'INSUFFICIENT_CREDIT', '可再预约课时不足');
      const tKey = teacherDayId(therapist.id, payload.date);
      const sKey = studentDayId(student.id, payload.date);
      const day = await get(tx, C.therapistDays, tKey);
      const ownDay = await get(tx, C.studentDays, sKey) || { id: sKey, studentId: student.id, date: payload.date, occupancies: [] };
      R.requireThat(day && day.configured && R.bookable({ date: payload.date, startMinute, duration: project.duration, ranges: day.ranges, occupancies: day.occupancies, studentOccupancies: ownDay.occupancies, now: at }), 'SLOT_UNAVAILABLE', '该时间已不可约，请重新选择');
      const bookingId = id();
      const slot = { bookingId, studentId: student.id, therapistId: therapist.id, startMinute, endMinute: startMinute + project.duration };
      const booking = { id: bookingId, studentId: student.id, therapistId: therapist.id, projectId: project.id, projectName: project.name, duration: project.duration, date: payload.date, startMinute, endMinute: slot.endMinute, status: 'booked', createdBy: openid, createdAt: at.toISOString(), revision: 1 };
      day.occupancies.push(slot);
      ownDay.occupancies.push(slot);
      student.held++;
      therapist.revision = (therapist.revision || 0) + 1;
      await set(tx, C.therapistDays, tKey, day);
      await set(tx, C.studentDays, sKey, ownDay);
      await set(tx, C.students, student.id, student);
      await set(tx, C.therapists, therapist.id, therapist);
      await set(tx, C.bookings, bookingId, booking);
      return bookingView(booking, student, therapist, current, at);
    });
  }
  async function bookingsCancel(openid, payload, requestId) {
    const account = await requireAccount(openid, ['student', 'admin']);
    R.requireThat(R.nonEmpty(payload.bookingId, 100), 'INVALID_INPUT', '预约编号无效');
    if (account.role === 'admin') R.requireThat(R.nonEmpty(payload.reason, 200), 'REASON_REQUIRED', '请填写取消原因');
    return transact(openid, 'bookings.cancel', requestId, payload, async (tx, at) => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['student', 'admin']);
      const booking = await get(tx, C.bookings, payload.bookingId);
      R.requireThat(booking, 'NOT_FOUND', '预约不存在');
      R.requireThat(booking.status === 'booked', 'INVALID_STATE', '该预约已处理，无法取消');
      if (current.role === 'student') {
        R.requireThat(current.studentId === booking.studentId, 'FORBIDDEN', '只能取消自己的预约');
        R.requireThat(R.dateMinuteTime(booking.date, booking.startMinute) > at.getTime(), 'CANCEL_TOO_LATE', '课程已开始，请联系管理员处理');
      }
      const student = await get(tx, C.students, booking.studentId);
      const tKey = teacherDayId(booking.therapistId, booking.date);
      const sKey = studentDayId(booking.studentId, booking.date);
      const day = await get(tx, C.therapistDays, tKey);
      const ownDay = await get(tx, C.studentDays, sKey);
      R.requireThat(student && day && ownDay && student.held >= 1, 'DATA_INCONSISTENT', '预约数据异常，请联系管理员');
      day.occupancies = day.occupancies.filter(item => item.bookingId !== booking.id);
      ownDay.occupancies = ownDay.occupancies.filter(item => item.bookingId !== booking.id);
      student.held--;
      booking.status = 'cancelled';
      booking.cancelledAt = at.toISOString();
      booking.cancelledBy = openid;
      booking.cancelReason = current.role === 'admin' ? payload.reason.trim() : '';
      booking.revision++;
      await set(tx, C.therapistDays, tKey, day);
      await set(tx, C.studentDays, sKey, ownDay);
      await set(tx, C.students, student.id, student);
      await set(tx, C.bookings, booking.id, booking);
      if (current.role === 'admin') await audit(tx, 'bookingCancel', openid, booking.id, { reason: booking.cancelReason });
      return booking;
    });
  }
  async function bookingsSignin(openid, payload, requestId) {
    await requireAccount(openid, ['therapist', 'admin']);
    R.requireThat(R.nonEmpty(payload.bookingId, 100), 'INVALID_INPUT', '预约编号无效');
    const result = await transact(openid, 'bookings.signin', requestId, payload, async (tx, at) => {
      const account = await get(tx, C.accounts, openid);
      role(account, ['therapist', 'admin']);
      const booking = await get(tx, C.bookings, payload.bookingId);
      R.requireThat(booking, 'NOT_FOUND', '预约不存在');
      R.requireThat(account.role === 'admin' || account.therapistId === booking.therapistId, 'FORBIDDEN', '只能为本人负责的预约签到');
      if (booking.status === 'checkedIn') return booking;
      R.requireThat(booking.status === 'booked', 'INVALID_STATE', '已取消预约不能签到');
      R.requireThat(R.dateMinuteTime(booking.date, booking.startMinute) <= at.getTime(), 'SIGNIN_TOO_EARLY', '课程开始后才能签到');
      const student = await get(tx, C.students, booking.studentId);
      R.requireThat(student && student.balance >= 1 && student.held >= 1, 'DATA_INCONSISTENT', '课时数据异常，请联系管理员');
      const ledgerId = `checkin_${booking.id}`;
      R.requireThat(!await get(tx, C.ledger, ledgerId), 'DATA_INCONSISTENT', '该课程已有扣课记录');
      student.balance--;
      student.held--;
      booking.status = 'checkedIn';
      booking.checkedInAt = at.toISOString();
      booking.checkedInBy = openid;
      booking.revision++;
      account.revision = (account.revision || 0) + 1;
      await set(tx, C.accounts, openid, account);
      await set(tx, C.students, student.id, student);
      await set(tx, C.bookings, booking.id, booking);
      await set(tx, C.ledger, ledgerId, { id: ledgerId, studentId: student.id, delta: -1, type: 'checkin', reason: '课程签到', bookingId: booking.id, actor: openid, at: at.toISOString() });
      await set(tx, C.outbox, booking.id, { id: booking.id, bookingId: booking.id, studentId: student.id, status: 'pending', createdAt: at.toISOString() });
      return booking;
    });
    try { await sendSigninNotification(result.id); } catch (error) { console.error('notification error', { bookingId: result.id, code: error.code, message: error.message }); }
    return result;
  }
  async function bookingsUndo(openid, payload, requestId) {
    await requireAccount(openid, ['admin']);
    R.requireThat(R.nonEmpty(payload.bookingId, 100) && R.nonEmpty(payload.reason, 200), 'REASON_REQUIRED', '请填写撤销原因');
    return transact(openid, 'bookings.undo', requestId, payload, async (tx, at) => {
      role(await get(tx, C.accounts, openid), ['admin']);
      const booking = await get(tx, C.bookings, payload.bookingId);
      R.requireThat(booking && booking.status === 'checkedIn', 'INVALID_STATE', '仅已签到预约可撤销');
      const student = await get(tx, C.students, booking.studentId);
      const tKey = teacherDayId(booking.therapistId, booking.date);
      const sKey = studentDayId(booking.studentId, booking.date);
      const day = await get(tx, C.therapistDays, tKey);
      const ownDay = await get(tx, C.studentDays, sKey);
      const original = await get(tx, C.ledger, `checkin_${booking.id}`);
      const log = await get(tx, C.logs, booking.id);
      R.requireThat(student && day && ownDay && original && !await get(tx, C.ledger, `reversal_${booking.id}`), 'DATA_INCONSISTENT', '原扣课记录不存在或已返课');
      student.balance++;
      day.occupancies = day.occupancies.filter(item => item.bookingId !== booking.id);
      ownDay.occupancies = ownDay.occupancies.filter(item => item.bookingId !== booking.id);
      booking.status = 'cancelled';
      booking.cancelledAt = at.toISOString();
      booking.cancelledBy = openid;
      booking.cancelReason = payload.reason.trim();
      booking.revision++;
      await set(tx, C.students, student.id, student);
      await set(tx, C.therapistDays, tKey, day);
      await set(tx, C.studentDays, sKey, ownDay);
      await set(tx, C.bookings, booking.id, booking);
      await set(tx, C.ledger, `reversal_${booking.id}`, { id: `reversal_${booking.id}`, studentId: student.id, delta: 1, type: 'reversal', reason: payload.reason.trim(), bookingId: booking.id, originalLedgerId: original.id, actor: openid, at: at.toISOString() });
      if (log) await set(tx, C.logs, booking.id, { ...log, valid: false, voidReason: payload.reason.trim(), voidedAt: at.toISOString(), voidedBy: openid });
      await audit(tx, 'undoSignin', openid, booking.id, { reason: payload.reason.trim() });
      return booking;
    });
  }
  async function creditsAdjust(openid, payload, requestId) {
    await requireAccount(openid, ['admin']);
    R.requireThat(R.nonEmpty(payload.studentId, 100) && R.integer(payload.delta) && payload.delta !== 0 && Math.abs(payload.delta) <= 10000 && R.nonEmpty(payload.reason, 200), 'INVALID_INPUT', '请填写有效课时数量和原因');
    return transact(openid, 'credits.adjust', requestId, payload, async (tx, at) => {
      role(await get(tx, C.accounts, openid), ['admin']);
      const student = await get(tx, C.students, payload.studentId);
      R.requireThat(student && student.enabled !== false, 'NOT_FOUND', '学员不存在');
      const before = student.balance;
      student.balance = ensureCredit(student, payload.delta);
      const ledgerId = `adjust_${id()}`;
      await set(tx, C.students, student.id, student);
      await set(tx, C.ledger, ledgerId, { id: ledgerId, studentId: student.id, delta: payload.delta, type: 'adjustment', reason: payload.reason.trim(), before, after: student.balance, actor: openid, at: at.toISOString() });
      return studentView(student);
    });
  }
  async function creditsList(openid, payload) {
    await requireAccount(openid, ['admin']);
    R.requireThat(R.nonEmpty(payload.studentId, 100), 'INVALID_INPUT', '学员编号无效');
    return pageQuery(db, C.ledger, { studentId: payload.studentId }, payload, 'at');
  }
  async function mediaPrepare(openid, payload, requestId) {
    const account = await requireAccount(openid, ['therapist']);
    const booking = await getBookingFor(account, payload.bookingId);
    R.requireThat(booking.status === 'checkedIn' && booking.therapistId === account.therapistId, 'FORBIDDEN', '只能为本人已签到课程上传图片');
    return transact(openid, 'media.prepare', requestId, payload, async tx => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['therapist']);
      const currentBooking = await get(tx, C.bookings, payload.bookingId);
      R.requireThat(currentBooking && currentBooking.status === 'checkedIn' && currentBooking.therapistId === current.therapistId, 'INVALID_STATE', '当前课程不能上传图片');
      const uploadId = id();
      const path = `staging/logs/${currentBooking.id}/${openid}/${uploadId}.jpg`;
      await set(tx, C.uploads, uploadId, { id: uploadId, bookingId: currentBooking.id, ownerId: openid, path, createdAt: now().toISOString() });
      await touchAccount(tx, current);
      return { uploadId, path };
    });
  }
  async function logsGet(openid, payload) {
    const account = await requireAccount(openid, ['student', 'therapist', 'admin']);
    const booking = await get(db, C.bookings, payload.bookingId);
    R.requireThat(booking, 'NOT_FOUND', '预约不存在');
    if (account.role === 'student') R.requireThat(account.studentId === booking.studentId, 'FORBIDDEN', '只能查看自己的训练记录');
    const log = await get(db, C.logs, payload.bookingId);
    if (log && log.valid === false && account.role !== 'admin') return null;
    const student = await get(db, C.students, booking.studentId);
    const therapist = await get(db, C.therapists, booking.therapistId);
    return { ...(log || {}), booking: bookingView(booking, student, therapist, account, now()) };
  }
  async function logsList(openid, payload) {
    const account = await requireAccount(openid, ['student', 'therapist', 'admin']);
    const studentId = payload.studentId || account.studentId;
    requireStudentAccess(account, studentId);
    const logs = await pageQuery(db, C.logs, account.role === 'admin' ? { studentId } : { studentId, valid: true }, payload, 'createdAt');
    const result = [];
    for (const log of logs) {
      const booking = await get(db, C.bookings, log.bookingId);
      const therapist = booking && await get(db, C.therapists, booking.therapistId);
      result.push({ ...log, date: booking && booking.date, projectName: booking && booking.projectName, therapistName: therapist && therapist.name });
    }
    return result;
  }
  async function logsSave(openid, payload, requestId) {
    await requireAccount(openid, ['therapist']);
    R.requireThat(R.nonEmpty(payload.text, 5000) && Array.isArray(payload.fileIds) && payload.fileIds.length <= 3 && payload.fileIds.every(fileId => typeof fileId === 'string'), 'INVALID_INPUT', '请填写反馈文字，最多上传 3 张图片');
    R.requireThat(new Set(payload.fileIds).size === payload.fileIds.length, 'INVALID_FILE', '图片不能重复');
    const opId = hash(`${openid}:logs.save:${requestId}`);
    const prior = await get(db, C.operations, opId);
    if (prior) {
      R.requireThat(prior.payloadHash === hash(JSON.stringify(payload)), 'REQUEST_ID_REUSED', '该操作标识已用于其他内容');
      return prior.result;
    }
    const staged = new Map();
    for (const fileId of payload.fileIds) {
      if (!fileId.includes('/staging/logs/')) continue;
      R.requireThat(cloud && typeof cloud.downloadFile === 'function' && typeof cloud.uploadFile === 'function' && R.nonEmpty(env.CLOUD_ENV_ID, 100), 'MEDIA_UNAVAILABLE', '图片服务尚未配置完成');
      R.requireThat(fileId.startsWith(`cloud://${env.CLOUD_ENV_ID}.`) || fileId.startsWith(`cloud://${env.CLOUD_ENV_ID}/`), 'INVALID_FILE', '图片不属于当前云环境');
      const match = fileId.match(/\/([0-9a-f-]{36})\.jpg$/i);
      R.requireThat(match, 'INVALID_FILE', '图片来源无效');
      const upload = await get(db, C.uploads, match[1]);
      R.requireThat(upload && upload.bookingId === payload.bookingId && upload.ownerId === openid && fileId.includes(`/${upload.path}`), 'INVALID_FILE', '图片与当前课程不匹配');
      let file;
      try { file = await cloud.downloadFile({ fileID: fileId }); } catch (_) { R.fail('INVALID_FILE', '图片尚未上传成功，请重试或移除'); }
      const content = file && file.fileContent;
      const jpg = Buffer.isBuffer(content) && content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
      const png = Buffer.isBuffer(content) && content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      R.requireThat((jpg || png) && content.length <= 5 * 1024 * 1024, 'INVALID_FILE', '仅支持不超过 5 MB 的 JPG 或 PNG 图片');
      const archiveId = id();
      const archived = await cloud.uploadFile({ cloudPath: `private/logs/${payload.bookingId}/${archiveId}.${jpg ? 'jpg' : 'png'}`, fileContent: content });
      R.requireThat(archived && archived.fileID, 'MEDIA_UNAVAILABLE', '图片归档失败，请重试');
      try {
        const archivedAt = now();
        await set(db, C.mediaArchives, archiveId, { id: archiveId, bookingId: payload.bookingId, fileId: archived.fileID, status: 'active', createdAt: archivedAt.toISOString(), gcAfter: new Date(archivedAt.getTime() + 24 * 60 * 60 * 1000).toISOString() });
      } catch (error) {
        if (typeof cloud.deleteFile === 'function') {
          try { await cloud.deleteFile({ fileList: [archived.fileID] }); } catch (_) { /* 云存储清理需在控制台核对。 */ }
        }
        throw error;
      }
      staged.set(fileId, { uploadId: upload.id, finalFileId: archived.fileID });
    }
    return transact(openid, 'logs.save', requestId, payload, async tx => {
      const current = await get(tx, C.accounts, openid);
      role(current, ['therapist']);
      const booking = await get(tx, C.bookings, payload.bookingId);
      R.requireThat(booking && booking.status === 'checkedIn' && booking.therapistId === current.therapistId, 'FORBIDDEN', '只能填写本人负责的已签到课程日志');
      const old = await get(tx, C.logs, booking.id);
      R.requireThat(!old || old.valid !== false, 'INVALID_STATE', '作废日志不能修改');
      const finalFileIds = [];
      for (const fileId of payload.fileIds) {
        if (staged.has(fileId)) {
          const stagedFile = staged.get(fileId);
          const upload = await get(tx, C.uploads, stagedFile.uploadId);
          R.requireThat(upload && upload.bookingId === booking.id && upload.ownerId === openid && fileId.includes(`/${upload.path}`), 'INVALID_FILE', '图片与当前课程不匹配');
          finalFileIds.push(stagedFile.finalFileId);
        } else {
          R.requireThat(old && old.fileIds.includes(fileId) && fileId.includes('/private/logs/'), 'INVALID_FILE', '只能保留本课程已有图片');
          finalFileIds.push(fileId);
        }
      }
      const log = { id: booking.id, bookingId: booking.id, studentId: booking.studentId, therapistId: booking.therapistId, authorId: old ? old.authorId : openid, text: payload.text.trim(), fileIds: finalFileIds, valid: true, createdAt: old ? old.createdAt : now().toISOString(), updatedAt: now().toISOString(), updatedBy: openid };
      booking.revision++;
      await set(tx, C.bookings, booking.id, booking);
      await set(tx, C.logs, booking.id, log);
      await touchAccount(tx, current);
      return log;
    });
  }
  async function mediaUrls(openid, payload) {
    const log = await logsGet(openid, payload);
    if (!log || !log.fileIds || !log.fileIds.length) return { fileIds: [], urls: [] };
    R.requireThat(cloud && typeof cloud.getTempFileURL === 'function', 'MEDIA_UNAVAILABLE', '图片服务未就绪');
    const result = await cloud.getTempFileURL({ fileList: log.fileIds });
    const urls = new Map((result.fileList || []).map(item => [item.fileID, item.tempFileURL || '']));
    return { fileIds: log.fileIds, urls: log.fileIds.map(fileId => urls.get(fileId) || '') };
  }
  async function mediaGc(openid) {
    await requireAccount(openid, ['admin']);
    R.requireThat(cloud && typeof cloud.deleteFile === 'function', 'MEDIA_UNAVAILABLE', '图片清理服务未就绪');
    const result = await db.collection(C.mediaArchives).where({ status: 'active', gcAfter: db.command.lt(now().toISOString()) }).limit(20).get();
    const summary = { scanned: 0, deleted: 0, retained: 0, failed: 0 };
    for (const archive of result.data || []) {
      summary.scanned++;
      const current = await get(db, C.mediaArchives, archive.id);
      if (!current || current.status !== 'active') continue;
      const log = await get(db, C.logs, archive.bookingId);
      if (log && Array.isArray(log.fileIds) && log.fileIds.includes(archive.fileId)) {
        await set(db, C.mediaArchives, archive.id, { ...current, gcAfter: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() });
        summary.retained++;
        continue;
      }
      try {
        const removed = await cloud.deleteFile({ fileList: [archive.fileId] });
        if (removed && removed.code && removed.code !== 'SUCCESS') throw new Error(String(removed.code));
        const outcome = removed && Array.isArray(removed.fileList) && removed.fileList.find(item => item.fileID === archive.fileId);
        if (!outcome || outcome.code !== 'SUCCESS') throw new Error(String(outcome && outcome.code || 'DELETE_UNCONFIRMED'));
        await set(db, C.mediaArchives, archive.id, { ...current, status: 'deleted', deletedAt: now().toISOString() });
        summary.deleted++;
      } catch (_) { summary.failed++; }
    }
    return summary;
  }
  async function notificationsList(openid) {
    await requireAccount(openid, ['admin']);
    const items = await pageQuery(db, C.outbox, null, { page: 1, pageSize: 50 }, 'createdAt');
    const staleBefore = now().getTime() - 5 * 60 * 1000;
    const result = [];
    for (const item of items) {
      if (item.status === 'sending' && Date.parse(item.updatedAt || item.createdAt) < staleBefore) {
        const raw = await db.runTransaction(async tx => {
          const current = await get(tx, C.outbox, item.id);
          if (current && current.status === 'sending' && Date.parse(current.updatedAt || current.createdAt) < staleBefore) {
            current.status = 'unknown';
            current.updatedAt = now().toISOString();
            await set(tx, C.outbox, item.id, current);
            return current;
          }
          return current;
        });
        result.push(unwrapTransaction(raw));
      } else result.push(item);
    }
    return result.map(item => ({ bookingId: item.bookingId, status: item.status, updatedAt: item.updatedAt || item.createdAt, lastError: item.errorCode || '' }));
  }
  async function sendSigninNotification(bookingId) {
    if (!cloud || !cloud.openapi || !cloud.openapi.subscribeMessage) {
      const outbox = await get(db, C.outbox, bookingId);
      if (outbox && outbox.status === 'pending') await set(db, C.outbox, bookingId, { ...outbox, status: 'notConfigured', updatedAt: now().toISOString() });
      return;
    }
    const templateId = env.SIGNIN_TEMPLATE_ID;
    const projectField = env.SIGNIN_TEMPLATE_PROJECT_FIELD;
    const timeField = env.SIGNIN_TEMPLATE_TIME_FIELD;
    if (!templateId || !/^(thing|name|phrase)\d+$/.test(projectField || '') || !/^time\d+$/.test(timeField || '')) {
      const outbox = await get(db, C.outbox, bookingId);
      if (outbox && outbox.status === 'pending') await set(db, C.outbox, bookingId, { ...outbox, status: 'notConfigured', updatedAt: now().toISOString() });
      return;
    }
    const claim = unwrapTransaction(await db.runTransaction(async tx => {
      const outbox = await get(tx, C.outbox, bookingId);
      if (!outbox || outbox.status !== 'pending') return false;
      await set(tx, C.outbox, bookingId, { ...outbox, status: 'sending', updatedAt: now().toISOString() });
      return true;
    }));
    if (!claim) return;
    const booking = await get(db, C.bookings, bookingId);
    const student = booking && await get(db, C.students, booking.studentId);
    if (!student || !student.boundAccountId) {
      const outbox = await get(db, C.outbox, bookingId);
      await set(db, C.outbox, bookingId, { ...outbox, status: 'noRecipient', updatedAt: now().toISOString() });
      return;
    }
    try {
      const timeText = `${booking.date} ${String(Math.floor(booking.startMinute / 60)).padStart(2, '0')}:${String(booking.startMinute % 60).padStart(2, '0')}`;
      await cloud.openapi.subscribeMessage.send({ touser: student.boundAccountId, templateId, page: `pages/bookings/bookings?id=${booking.id}`, data: { [projectField]: { value: booking.projectName.slice(0, 20) }, [timeField]: { value: timeText } }, miniprogramState: env.MINIPROGRAM_STATE || 'formal', lang: 'zh_CN' });
      const outbox = await get(db, C.outbox, bookingId);
      await set(db, C.outbox, bookingId, { ...outbox, status: 'sent', updatedAt: now().toISOString() });
    } catch (error) {
      const outbox = await get(db, C.outbox, bookingId);
      await set(db, C.outbox, bookingId, { ...outbox, status: 'failed', errorCode: error.errCode || error.code || 'SEND_FAILED', updatedAt: now().toISOString() });
    }
  }

  async function handle(action, payload = {}, openid, requestId) {
    R.requireThat(typeof action === 'string' && action.length <= 60, 'INVALID_ACTION', '请求无效');
    R.requireThat(payload && typeof payload === 'object' && !Array.isArray(payload), 'INVALID_INPUT', '请求内容无效');
    if (MUTATIONS.has(action)) R.requireThat(typeof requestId === 'string', 'REQUEST_ID_REQUIRED', '请重试当前操作');
    switch (action) {
      case 'bootstrap': return bootstrap(openid);
      case 'catalog.seed': return seed(openid, requestId);
      case 'register': return register(openid, payload, requestId);
      case 'profiles.create': return profilesCreate(openid, payload, requestId);
      case 'profiles.list': return profilesList(openid, payload);
      case 'profiles.get': return profilesGet(openid, payload);
      case 'profiles.save': return profilesSave(openid, payload, requestId);
      case 'bindings.list': return bindingsList(openid, payload);
      case 'bindings.resolve': return bindingsResolve(openid, payload, requestId);
      case 'staff.list': return staffList(openid);
      case 'staff.save': return staffSave(openid, payload, requestId);
      case 'schedule.get': return scheduleGet(openid, payload);
      case 'schedule.save': return scheduleSave(openid, payload, requestId);
      case 'schedule.fill': return scheduleFill(openid, payload, requestId);
      case 'bookings.slots': return bookingSlots(openid, payload);
      case 'bookings.list': return bookingsList(openid, payload);
      case 'bookings.create': return bookingsCreate(openid, payload, requestId);
      case 'bookings.cancel': return bookingsCancel(openid, payload, requestId);
      case 'bookings.signin': return bookingsSignin(openid, payload, requestId);
      case 'bookings.undo': return bookingsUndo(openid, payload, requestId);
      case 'credits.adjust': return creditsAdjust(openid, payload, requestId);
      case 'credits.list': return creditsList(openid, payload);
      case 'logs.get': return logsGet(openid, payload);
      case 'logs.list': return logsList(openid, payload);
      case 'logs.save': return logsSave(openid, payload, requestId);
      case 'media.prepare': return mediaPrepare(openid, payload, requestId);
      case 'media.urls': return mediaUrls(openid, payload);
      case 'media.gc': return mediaGc(openid);
      case 'notifications.list': return notificationsList(openid);
      default: R.fail('INVALID_ACTION', '不支持的操作');
    }
  }
  return { handle };
}

module.exports = { createService, C };
