const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../cloudfunctions/api/lib/service');
const R = require('../cloudfunctions/api/lib/rules');

const copy = value => value === undefined ? undefined : structuredClone(value);
class Connection {
  constructor(records) {
    this.records = records;
    this.RegExp = class { constructor({ regexp, options }) { return new RegExp(regexp, options); } };
    this.command = { or: (...conditions) => ({ $or: conditions }), lt: value => ({ $lt: value }) };
  }
  collection(name) {
    if (!this.records[name]) this.records[name] = {};
    const records = this.records[name];
    const matches = (row, filter) => filter.$or ? filter.$or.some(item => matches(row, item)) : Object.entries(filter).every(([key, value]) => value instanceof RegExp ? value.test(String(row[key] || '')) : value && value.$lt !== undefined ? row[key] < value.$lt : row[key] === value);
    const query = (filter = null, sortField = null, offset = 0, count = 100) => ({
      where(value) { return query(value, sortField, offset, count); },
      orderBy(field) { return query(filter, field, offset, count); },
      skip(value) { return query(filter, sortField, value, count); },
      limit(value) { return query(filter, sortField, offset, value); },
      async count() { return { total: Object.values(records).filter(row => !filter || matches(row, filter)).length }; },
      async get() {
        let rows = Object.values(records);
        if (filter) rows = rows.filter(row => matches(row, filter));
        if (sortField) rows.sort((a, b) => String(b[sortField] || '').localeCompare(String(a[sortField] || '')));
        return { data: rows.slice(offset, offset + count).map(copy) };
      }
    });
    return {
      doc(id) {
        return {
          async get() { return { data: copy(records[id] || null) }; },
          async set({ data }) { records[id] = copy(data); return { updated: 1 }; }
        };
      },
      ...query()
    };
  }
}
class MemoryDB extends Connection {
  constructor() { super({}); this.tail = Promise.resolve(); }
  async runTransaction(work) {
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = next;
    await previous;
    const snapshot = copy(this.records);
    try {
      const result = await work(new Connection(snapshot));
      this.records = snapshot;
      release();
      return { result, errMsg: 'runTransaction:ok' };
    } catch (error) {
      release();
      throw error;
    }
  }
}
const ok = (service, action, payload, actor, key) => service.handle(action, payload, actor, key);
async function rejectsCode(promise, code) { await assert.rejects(promise, error => error.code === code); }
async function setup() {
  const db = new MemoryDB();
  let instant = new Date('2026-09-24T08:00:00+08:00');
  const service = createService({ db, env: { BOOTSTRAP_ADMIN_OPENID: 'admin' }, now: () => instant });
  await ok(service, 'bootstrap', {}, 'admin');
  await ok(service, 'catalog.seed', {}, 'admin', 'seed0001');
  await ok(service, 'staff.save', { therapistId: 'T01', projectIds: ['P02'], enabled: true, accountOpenid: 'teacher1' }, 'admin', 'staff0001');
  await ok(service, 'staff.save', { therapistId: 'T02', projectIds: ['P03'], enabled: true, accountOpenid: 'teacher2' }, 'admin', 'staff0002');
  const a = await ok(service, 'register', { mode: 'new', name: '学员甲', phone: '13800000001' }, 'student1', 'register1');
  const b = await ok(service, 'register', { mode: 'new', name: '学员乙', phone: '13800000002' }, 'student2', 'register2');
  await ok(service, 'credits.adjust', { studentId: a.student.id, delta: 1, reason: '线下购课' }, 'admin', 'credit001');
  await ok(service, 'credits.adjust', { studentId: b.student.id, delta: 1, reason: '线下购课' }, 'admin', 'credit002');
  await ok(service, 'schedule.save', { therapistId: 'T01', date: '2026-09-25', ranges: [{ startMinute: 540, endMinute: 780 }] }, 'teacher1', 'schedule1');
  await ok(service, 'schedule.save', { therapistId: 'T02', date: '2026-09-25', ranges: [{ startMinute: 540, endMinute: 780 }] }, 'teacher2', 'schedule2');
  return { db, service, a: a.student, b: b.student, setTime: value => { instant = new Date(value); } };
}

test('40 分钟实际时长、同师冲突和相邻时段', async () => {
  const { service } = await setup();
  const first = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'booking01');
  assert.equal(first.endMinute, 610);
  await rejectsCode(ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 600 }, 'student2', 'booking02'), 'SLOT_UNAVAILABLE');
  const adjacent = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 630 }, 'student2', 'booking03');
  assert.equal(adjacent.startMinute, 630);
});

test('最后一节被预约占用，不因预约扣余额；跨老师同学员重叠被拒', async () => {
  const { service, a } = await setup();
  await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'booking04');
  const profile = await ok(service, 'profiles.get', { studentId: a.id }, 'student1');
  assert.deepEqual([profile.balance, profile.held, profile.available], [1, 1, 0]);
  await rejectsCode(ok(service, 'bookings.create', { therapistId: 'T02', projectId: 'P03', date: '2026-09-25', startMinute: 570 }, 'student1', 'booking05'), 'INSUFFICIENT_CREDIT');
  await ok(service, 'credits.adjust', { studentId: a.id, delta: 1, reason: '线下购课' }, 'admin', 'credit003');
  await rejectsCode(ok(service, 'bookings.create', { therapistId: 'T02', projectId: 'P03', date: '2026-09-25', startMinute: 570 }, 'student1', 'booking06'), 'SLOT_UNAVAILABLE');
  await rejectsCode(ok(service, 'credits.adjust', { studentId: a.id, delta: -2, reason: '纠错' }, 'admin', 'credit004'), 'INSUFFICIENT_CREDIT');
});

test('签到扣课仅一次，撤销返课一次，取消与日志作废', async () => {
  const { service, db, a, setTime } = await setup();
  const booking = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'booking07');
  await rejectsCode(ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'signin001'), 'SIGNIN_TOO_EARLY');
  setTime('2026-09-25T09:30:00+08:00');
  await Promise.all([ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'signin002'), ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'signin003')]);
  const checked = await ok(service, 'profiles.get', { studentId: a.id }, 'student1');
  assert.deepEqual([checked.balance, checked.held], [0, 0]);
  assert.equal(Object.values(db.records.ledger).filter(x => x.type === 'checkin').length, 1);
  await ok(service, 'logs.save', { bookingId: booking.id, text: '恢复情况稳定', fileIds: [] }, 'teacher1', 'logsave01');
  await ok(service, 'bookings.undo', { bookingId: booking.id, reason: '误签到' }, 'admin', 'undo0001');
  const corrected = await ok(service, 'profiles.get', { studentId: a.id }, 'student1');
  assert.deepEqual([corrected.balance, corrected.held], [1, 0]);
  assert.equal(await ok(service, 'logs.get', { bookingId: booking.id }, 'student1'), null);
  await rejectsCode(ok(service, 'bookings.undo', { bookingId: booking.id, reason: '误签到' }, 'admin', 'undo0002'), 'INVALID_STATE');
});

test('账号权限、档案版本与绑定隔离', async () => {
  const { service, a } = await setup();
  await rejectsCode(ok(service, 'profiles.get', { studentId: a.id }, 'student2'), 'FORBIDDEN');
  await rejectsCode(ok(service, 'credits.adjust', { studentId: a.id, delta: 1, reason: '测试' }, 'teacher1', 'forbid001'), 'FORBIDDEN');
  const profile = await ok(service, 'profiles.get', { studentId: a.id }, 'teacher2');
  await ok(service, 'profiles.save', { studentId: a.id, name: '学员甲', phone: profile.phone, notes: '记录', version: profile.version }, 'teacher2', 'profile01');
  await rejectsCode(ok(service, 'profiles.save', { studentId: a.id, name: '学员甲', phone: profile.phone, notes: '旧内容', version: profile.version }, 'teacher1', 'profile02'), 'VERSION_CONFLICT');
  await ok(service, 'register', { mode: 'bind', name: '学员甲', phone: '13800000001' }, 'replacement', 'binding01');
  await rejectsCode(ok(service, 'register', { mode: 'new', name: '学员甲', phone: '13800000001' }, 'replacement', 'bindingNew'), 'ALREADY_REGISTERED');
  await rejectsCode(ok(service, 'profiles.get', { studentId: a.id }, 'replacement'), 'FORBIDDEN');
  await ok(service, 'bindings.resolve', { accountId: 'replacement', studentId: a.id, replace: true }, 'admin', 'binding02');
  await rejectsCode(ok(service, 'profiles.get', { studentId: a.id }, 'student1'), 'FORBIDDEN');
  const rebound = await ok(service, 'profiles.get', { studentId: a.id }, 'replacement');
  assert.equal(rebound.id, a.id);
});

test('边界计算与午间、结束相接', () => {
  assert.equal(R.bookable({ date: '2026-09-25', startMinute: 750, duration: 30, ranges: [{ startMinute: 540, endMinute: 780 }], now: new Date('2026-09-24T00:00:00+08:00') }), true);
  assert.equal(R.bookable({ date: '2026-09-25', startMinute: 750, duration: 40, ranges: [{ startMinute: 540, endMinute: 780 }], now: new Date('2026-09-24T00:00:00+08:00') }), false);
  assert.equal(R.overlap({ startMinute: 570, endMinute: 610 }, { startMinute: 610, endMinute: 650 }), false);
});

test('并发争抢同一时段与最后一节，均最多成功一次', async () => {
  const { service, a } = await setup();
  const sameSlot = await Promise.allSettled([
    ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'race0001'),
    ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student2', 'race0002')
  ]);
  assert.equal(sameSlot.filter(item => item.status === 'fulfilled').length, 1);
  const profile = await ok(service, 'profiles.get', { studentId: a.id }, 'student1');
  assert.ok(profile.balance >= profile.held);
});

test('排班变更不能覆盖预约，日志只能由负责康复师修改但其他康复师可读', async () => {
  const { service, a, setTime } = await setup();
  const booking = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'booking08');
  await rejectsCode(ok(service, 'schedule.save', { therapistId: 'T01', date: '2026-09-25', ranges: [{ startMinute: 660, endMinute: 780 }] }, 'teacher1', 'schedule3'), 'SCHEDULE_CONFLICT');
  setTime('2026-09-25T10:00:00+08:00');
  await ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'signin004');
  await ok(service, 'logs.save', { bookingId: booking.id, text: '恢复良好', fileIds: [] }, 'teacher1', 'logsave02');
  const otherRead = await ok(service, 'logs.get', { bookingId: booking.id }, 'teacher2');
  assert.equal(otherRead.text, '恢复良好');
  const all = await ok(service, 'logs.list', { studentId: a.id }, 'teacher2');
  assert.equal(all[0].projectName, '肩颈腰背/下肢筋膜松解');
  await rejectsCode(ok(service, 'logs.save', { bookingId: booking.id, text: '擅改', fileIds: [] }, 'teacher2', 'logsave03'), 'FORBIDDEN');
});

test('幂等操作同键只执行一次、异参重用被拒', async () => {
  const { service, a, db } = await setup();
  const payload = { studentId: a.id, delta: 2, reason: '线下购课' };
  const first = await ok(service, 'credits.adjust', payload, 'admin', 'credit005');
  const second = await ok(service, 'credits.adjust', payload, 'admin', 'credit005');
  assert.equal(first.balance, second.balance);
  assert.equal(Object.values(db.records.ledger).filter(row => row.studentId === a.id && row.delta === 2).length, 1);
  await rejectsCode(ok(service, 'credits.adjust', { ...payload, delta: 3 }, 'admin', 'credit005'), 'REQUEST_ID_REUSED');
});

test('跨日期并发争用最后一节课，只产生一个预约', async () => {
  const { service, a } = await setup();
  await ok(service, 'schedule.save', { therapistId: 'T01', date: '2026-09-26', ranges: [{ startMinute: 540, endMinute: 780 }] }, 'teacher1', 'schedule4');
  const attempts = await Promise.allSettled([
    ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'crossday1'),
    ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-26', startMinute: 570 }, 'student1', 'crossday2')
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const profile = await ok(service, 'profiles.get', { studentId: a.id }, 'student1');
  assert.deepEqual([profile.balance, profile.held, profile.available], [1, 1, 0]);
});

test('管理员取消与康复师签到竞争，至多一个动作生效', async () => {
  const { service, a, db, setTime } = await setup();
  const booking = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'racebook1');
  setTime('2026-09-25T09:30:00+08:00');
  const attempts = await Promise.allSettled([
    ok(service, 'bookings.cancel', { bookingId: booking.id, reason: '临时停课' }, 'admin', 'racecancel'),
    ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'racesignin')
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const profile = await ok(service, 'profiles.get', { studentId: a.id }, 'student1');
  assert.equal(profile.held, 0);
  assert.equal(profile.balance, Object.values(db.records.ledger).some(row => row.type === 'checkin') ? 0 : 1);
});

test('人员解绑立即失权，服务端拒绝非手机号', async () => {
  const { service, a } = await setup();
  const search = await ok(service, 'profiles.list', { query: '13800000001' }, 'teacher1');
  assert.equal(search.length, 1);
  assert.equal(search[0].id, a.id);
  await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'staffbook1');
  await rejectsCode(ok(service, 'register', { mode: 'new', name: '异常', phone: '123' }, 'badphone', 'badphone1'), 'INVALID_INPUT');
  await rejectsCode(ok(service, 'profiles.create', { name: '异常', phone: 'abc' }, 'teacher1', 'badphone2'), 'INVALID_INPUT');
  const people = await ok(service, 'staff.list', {}, 'admin');
  assert.equal(people.find(item => item.id === 'T01').pendingCount, 1);
  await ok(service, 'staff.save', { therapistId: 'T01', projectIds: ['P02'], enabled: true, accountOpenid: '' }, 'admin', 'unlink001');
  const teacher = await ok(service, 'bootstrap', {}, 'teacher1');
  assert.equal(teacher.role, 'unregistered');
  await rejectsCode(ok(service, 'profiles.get', { studentId: a.id }, 'teacher1'), 'FORBIDDEN');
  const newStudent = await ok(service, 'register', { mode: 'new', name: '原康复师', phone: '13800000003' }, 'teacher1', 'afterunlink');
  assert.equal(newStudent.role, 'student');
  await ok(service, 'staff.save', { therapistId: 'T02', projectIds: ['P03'], enabled: false, accountOpenid: 'teacher2' }, 'admin', 'disable002');
  assert.equal((await ok(service, 'bootstrap', {}, 'teacher2')).role, 'disabled');
});

test('作废日志不会截断有效日志分页，流水可继续翻页', async () => {
  const { service, db, a, setTime } = await setup();
  const booking = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'pagebook1');
  setTime('2026-09-25T09:30:00+08:00');
  await ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'pagesign1');
  await ok(service, 'logs.save', { bookingId: booking.id, text: '有效反馈', fileIds: [] }, 'teacher1', 'pagelog01');
  for (let i = 0; i < 50; i++) db.records.logs[`void${i}`] = { id: `void${i}`, bookingId: `void${i}`, studentId: a.id, valid: false, createdAt: `2026-10-01T${String(i % 24).padStart(2, '0')}:00:00Z` };
  const logs = await ok(service, 'logs.list', { studentId: a.id, page: 1, pageSize: 50 }, 'student1');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].text, '有效反馈');
  for (let i = 0; i < 51; i++) db.records.ledger[`extra${i}`] = { id: `extra${i}`, studentId: a.id, delta: 1, reason: '历史', at: `2026-10-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z` };
  const second = await ok(service, 'credits.list', { studentId: a.id, page: 2, pageSize: 50 }, 'admin');
  assert.ok(second.length > 0);
});

test('待绑定申请超过 50 条后仍可翻页处理', async () => {
  const { service, db } = await setup();
  for (let i = 0; i < 51; i++) db.records.accounts[`waiting${String(i).padStart(2, '0')}`] = { id: `waiting${String(i).padStart(2, '0')}`, role: 'pending', enabled: true, pendingBinding: { name: `申请者${i}`, phone: '13800000009' } };
  const first = await ok(service, 'bindings.list', { page: 1, pageSize: 50 }, 'admin');
  const second = await ok(service, 'bindings.list', { page: 2, pageSize: 50 }, 'admin');
  assert.equal(first.length, 50);
  assert.equal(second.length, 1);
});

test('图片从临时路径归档，重复请求不覆盖正式图片', async () => {
  const { service, db, setTime } = await setup();
  const booking = await ok(service, 'bookings.create', { therapistId: 'T01', projectId: 'P02', date: '2026-09-25', startMinute: 570 }, 'student1', 'imgbook01');
  setTime('2026-09-25T09:30:00+08:00');
  await ok(service, 'bookings.signin', { bookingId: booking.id }, 'teacher1', 'imgsignin');
  const archives = [];
  const deleted = [];
  let deletionConfirmed = false;
  const cloud = {
    async downloadFile() { return { fileContent: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }; },
    async uploadFile({ cloudPath, fileContent }) { archives.push({ cloudPath, fileContent }); return { fileID: `cloud://test-env.bucket/${cloudPath}` }; },
    async deleteFile({ fileList }) { if (!deletionConfirmed) return { fileList: [] }; deleted.push(...fileList); return { fileList: fileList.map(fileID => ({ fileID, code: 'SUCCESS' })) }; }
  };
  const media = createService({ db, cloud, env: { CLOUD_ENV_ID: 'test-env' }, now: () => new Date('2026-09-25T09:30:00+08:00') });
  const prepared = await ok(media, 'media.prepare', { bookingId: booking.id }, 'teacher1', 'imgprepare');
  const stagedFileId = `cloud://test-env.bucket/${prepared.path}`;
  const payload = { bookingId: booking.id, text: '带图片反馈', fileIds: [stagedFileId] };
  const first = await ok(media, 'logs.save', payload, 'teacher1', 'imgsave01');
  assert.equal(archives.length, 1);
  assert.match(first.fileIds[0], /\/private\/logs\//);
  assert.notEqual(first.fileIds[0], stagedFileId);
  const repeated = await ok(media, 'logs.save', payload, 'teacher1', 'imgsave01');
  assert.deepEqual(repeated.fileIds, first.fileIds);
  assert.equal(archives.length, 1);
  const retained = await ok(media, 'logs.save', { bookingId: booking.id, text: '更新文字', fileIds: first.fileIds }, 'teacher1', 'imgsave02');
  assert.deepEqual(retained.fileIds, first.fileIds);
  assert.equal(archives.length, 1);
  const archiveRecord = Object.values(db.records.mediaArchives)[0];
  db.records.mediaArchives[archiveRecord.id].gcAfter = '2026-09-20T00:00:00.000Z';
  const before = await ok(media, 'media.gc', {}, 'admin');
  assert.equal(before.retained, 1);
  assert.equal(deleted.length, 0);
  await ok(media, 'logs.save', { bookingId: booking.id, text: '移除图片', fileIds: [] }, 'teacher1', 'imgsave03');
  db.records.mediaArchives[archiveRecord.id].gcAfter = '2026-09-20T00:00:00.000Z';
  const unconfirmed = await ok(media, 'media.gc', {}, 'admin');
  assert.equal(unconfirmed.failed, 1);
  assert.equal(db.records.mediaArchives[archiveRecord.id].status, 'active');
  deletionConfirmed = true;
  const gc = await ok(media, 'media.gc', {}, 'admin');
  assert.equal(gc.deleted, 1);
  assert.deepEqual(deleted, first.fileIds);
});
