const WINDOWS = [[540, 780], [840, 1170]];
const PROJECTS = [
  { id: 'P01', name: '系统评估', duration: 30 },
  { id: 'P02', name: '肩颈腰背/下肢筋膜松解', duration: 40 },
  { id: 'P03', name: '体态调整', duration: 60 },
  { id: 'P04', name: '运动损伤', duration: 60 },
  { id: 'P05', name: '术前术后恢复', duration: 90 }
];
const THERAPISTS = [
  { id: 'T01', name: '段老师' }, { id: 'T02', name: '周老师' },
  { id: 'T03', name: '字老师' }, { id: 'T04', name: '何老师' },
  { id: 'T05', name: '刘老师' }
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function requireThat(ok, code, message) { if (!ok) fail(code, message); }
function integer(value) { return Number.isInteger(value); }
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const [year, month, day] = date.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}
function shanghaiDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function dateMinuteTime(date, minute) {
  return Date.parse(`${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+08:00`);
}
function overlap(a, b) { return a.startMinute < b.endMinute && b.startMinute < a.endMinute; }
function inside(range, outer) { return range.startMinute >= outer.startMinute && range.endMinute <= outer.endMinute; }
function allowedWork(range) { return WINDOWS.some(([startMinute, endMinute]) => inside(range, { startMinute, endMinute })); }
function normalizeRanges(ranges) {
  requireThat(Array.isArray(ranges) && ranges.length <= 4, 'INVALID_RANGES', '每天最多设置 4 个空闲段');
  const result = ranges.map(range => ({ startMinute: Number(range.startMinute), endMinute: Number(range.endMinute) }));
  for (const range of result) {
    requireThat(integer(range.startMinute) && integer(range.endMinute) && range.startMinute % 30 === 0 && range.endMinute % 30 === 0 && range.endMinute > range.startMinute && allowedWork(range), 'INVALID_RANGES', '空闲段须在工作时间内，按半小时设置');
  }
  result.sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < result.length; i++) requireThat(!overlap(result[i - 1], result[i]), 'INVALID_RANGES', '空闲段不能重叠');
  return result;
}
function bookable({ date, startMinute, duration, ranges, occupancies, studentOccupancies, now = new Date() }) {
  const slot = { startMinute, endMinute: startMinute + duration };
  if (!validDate(date) || !integer(startMinute) || startMinute % 30 !== 0 || !integer(duration)) return false;
  if (dateMinuteTime(date, startMinute) <= now.getTime()) return false;
  if (!allowedWork(slot) || !(ranges || []).some(range => inside(slot, range))) return false;
  if ((occupancies || []).some(item => overlap(slot, item))) return false;
  if ((studentOccupancies || []).some(item => overlap(slot, item))) return false;
  return true;
}
function available(balance, held) { return balance - held; }
function nonEmpty(value, max = 100) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}
function validPhone(value) { return typeof value === 'string' && /^1\d{10}$/.test(value.trim()); }
module.exports = { WINDOWS, PROJECTS, THERAPISTS, fail, requireThat, integer, validDate, shanghaiDate, dateMinuteTime, overlap, inside, allowedWork, normalizeRanges, bookable, available, nonEmpty, validPhone };
