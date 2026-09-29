let sequence = 0;
const retryIds = new Map();
const mutations = new Set(['register', 'profiles.create', 'profiles.save', 'bindings.resolve', 'staff.save', 'schedule.save', 'schedule.fill', 'bookings.create', 'bookings.cancel', 'bookings.signin', 'bookings.undo', 'credits.adjust', 'logs.save', 'media.prepare']);

function newRequestId() {
  sequence += 1;
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${sequence}`;
}

function call(action, payload = {}, requestId) {
  const key = `${action}:${JSON.stringify(payload)}`;
  const id = requestId || retryIds.get(key) || newRequestId();
  if (mutations.has(action)) retryIds.set(key, id);
  return wx.cloud.callFunction({ name: 'api', data: { action, payload, requestId: id } }).then(({ result }) => {
    if (!result || !result.ok) {
      const error = result && result.error || {};
      const message = error.message || '操作未完成，请稍后重试。';
      const failure = new Error(message);
      failure.code = error.code || 'UNKNOWN';
      failure.fromApi = true;
      throw failure;
    }
    retryIds.delete(key);
    return result.data;
  }).catch(error => {
    if (error && error.fromApi) { retryIds.delete(key); throw error; }
    throw new Error('网络连接失败，请检查网络后重试。');
  });
}

function showError(error) {
  wx.showToast({ title: error && error.message || '操作未完成', icon: 'none', duration: 3000 });
}

function confirm(content, title = '请确认') {
  return new Promise(resolve => wx.showModal({ title, content, success: res => resolve(res.confirm), fail: () => resolve(false) }));
}

function dateToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function time(minute) {
  if (minute === null || minute === undefined || minute === '') return '';
  const value = Number(minute);
  if (!Number.isFinite(value)) return String(minute);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function minute(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '').split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function status(value) {
  return ({ booked: '已预约', checkedIn: '已签到', signed: '已签到', cancelled: '已取消', reserved: '已预约', attended: '已签到', canceled: '已取消' })[value] || value || '已预约';
}

function bookings(data) {
  const list = Array.isArray(data) ? data : data && (data.items || data.bookings || data.list) || [];
  return list.map(item => ({ ...item, id: item.id || item._id, statusText: status(item.status), startText: time(item.startMinute), endText: time(item.endMinute) }));
}

function list(data, key) {
  return Array.isArray(data) ? data : data && (data.items || data[key] || data.list) || [];
}

function route(url) { wx.navigateTo({ url }); }

module.exports = { call, showError, confirm, dateToday, time, minute, bookings, list, route, newRequestId };
