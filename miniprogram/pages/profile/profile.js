const api = require('../../utils/api');
Page({
  data: { studentId: '', mine: false, create: false, role: '', student: {}, name: '', phone: '', notes: '', version: 0, logs: [], logsPage: 0, hasMoreLogs: false, bookings: [], bookingsPage: 0, hasMoreBookings: false, ledgerPage: 0, hasMoreLedger: false, bindings: [], bindingsPage: 0, hasMoreBindings: false, delta: '', reasonIndex: 0, reasonOptions: ['初始录入', '线下购课', '录入纠错', '其他'], otherReason: '', saving: false, accountId: '' },
  onLoad(options) {
    const session = getApp().globalData.session || {};
    this.setData({ studentId: options.studentId || (session.student && (session.student.id || session.student._id)) || '', mine: options.mine === '1', create: options.create === '1', role: session.role || '' });
  },
  onShow() { if (!this.data.create) this.load(); },
  async load() {
    try {
      const data = await api.call('profiles.get', { studentId: this.data.studentId });
      const student = data.student || data;
      const studentId = student.id || student._id;
      const [logsData, bookingsData] = await Promise.all([api.call('logs.list', { studentId, page: 1, pageSize: 50 }), api.call('bookings.list', { studentId, page: 1, pageSize: 50 })]);
      const bookings = api.bookings(bookingsData);
      const byId = Object.fromEntries(bookings.map(item => [item.id, item]));
      const role = this.data.role;
      const therapist = (getApp().globalData.session || {}).therapist || {};
      const ownId = therapist.id || therapist._id;
      const logs = api.list(logsData, 'logs').map(log => ({ ...byId[log.bookingId], ...log, date: log.date || (byId[log.bookingId] || {}).date, projectName: log.projectName || (byId[log.bookingId] || {}).projectName, therapistName: log.therapistName || (byId[log.bookingId] || {}).therapistName }));
      this.setData({ student: { ...student, creditEntries: (student.ledger || []).map(entry => ({ ...entry, createdAt: entry.at || entry.createdAt })) }, studentId, name: student.name || '', phone: student.phone || '', notes: student.notes || '', version: student.version || 0, logs, logsPage: 1, hasMoreLogs: logs.length === 50, bookings: bookings.map(item => ({ ...item, canEditLog: role === 'therapist' && item.therapistId === ownId })), bookingsPage: 1, hasMoreBookings: bookings.length === 50, ledgerPage: 1, hasMoreLedger: (student.ledger || []).length === 50 });
      if (this.data.role === 'admin') this.loadBindings();
    } catch (error) { api.showError(error); }
  },
  async moreLogs() {
    if (!this.data.hasMoreLogs) return;
    try { const page = this.data.logsPage + 1; const rows = api.list(await api.call('logs.list', { studentId: this.data.studentId, page, pageSize: 50 }), 'logs'); this.setData({ logs: this.data.logs.concat(rows), logsPage: page, hasMoreLogs: rows.length === 50 }); }
    catch (error) { api.showError(error); }
  },
  async moreBookings() {
    if (!this.data.hasMoreBookings) return;
    try {
      const page = this.data.bookingsPage + 1;
      const rows = api.bookings(await api.call('bookings.list', { studentId: this.data.studentId, page, pageSize: 50 }));
      const ownId = ((getApp().globalData.session || {}).therapist || {}).id;
      this.setData({ bookings: this.data.bookings.concat(rows.map(item => ({ ...item, canEditLog: this.data.role === 'therapist' && item.therapistId === ownId }))), bookingsPage: page, hasMoreBookings: rows.length === 50 });
    } catch (error) { api.showError(error); }
  },
  async moreLedger() {
    if (!this.data.hasMoreLedger || this.data.role !== 'admin') return;
    try {
      const page = this.data.ledgerPage + 1;
      const rows = api.list(await api.call('credits.list', { studentId: this.data.studentId, page, pageSize: 50 }), 'items').map(entry => ({ ...entry, createdAt: entry.at || entry.createdAt }));
      this.setData({ 'student.creditEntries': (this.data.student.creditEntries || []).concat(rows), ledgerPage: page, hasMoreLedger: rows.length === 50 });
    } catch (error) { api.showError(error); }
  },
  async loadBindings() {
    try { const rows = api.list(await api.call('bindings.list', { page: 1, pageSize: 50 }), 'bindings'); this.setData({ bindings: rows, bindingsPage: 1, hasMoreBindings: rows.length === 50 }); }
    catch (error) { api.showError(error); }
  },
  async moreBindings() {
    if (!this.data.hasMoreBindings) return;
    try { const page = this.data.bindingsPage + 1; const rows = api.list(await api.call('bindings.list', { page, pageSize: 50 }), 'bindings'); this.setData({ bindings: this.data.bindings.concat(rows), bindingsPage: page, hasMoreBindings: rows.length === 50 }); }
    catch (error) { api.showError(error); }
  },
  inputName(e) { this.setData({ name: e.detail.value }); },
  inputPhone(e) { this.setData({ phone: e.detail.value }); },
  inputNotes(e) { this.setData({ notes: e.detail.value }); },
  inputDelta(e) { this.setData({ delta: e.detail.value }); },
  inputOther(e) { this.setData({ otherReason: e.detail.value }); },
  changeReason(e) { this.setData({ reasonIndex: Number(e.detail.value) }); },
  async save() {
    if (this.data.saving) return;
    const name = this.data.name.trim(); const phone = this.data.phone.trim();
    if (!name || !/^1\d{10}$/.test(phone)) return api.showError(new Error('请填写姓名和 11 位手机号。'));
    this.setData({ saving: true });
    try {
      if (this.data.create) {
        await api.call('profiles.create', { name, phone, notes: this.data.notes.trim() });
        wx.showToast({ title: '建档成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 500);
      } else {
        await api.call('profiles.save', { studentId: this.data.studentId, name, phone, notes: this.data.role === 'student' ? undefined : this.data.notes.trim(), version: this.data.version });
        wx.showToast({ title: '已保存', icon: 'success' }); this.load();
      }
    } catch (error) {
      // A version conflict deliberately keeps unsaved fields on screen.
      api.showError(error);
    } finally { this.setData({ saving: false }); }
  },
  async adjust() {
    const delta = Number(this.data.delta);
    const reason = this.data.reasonOptions[this.data.reasonIndex] === '其他' ? this.data.otherReason.trim() : this.data.reasonOptions[this.data.reasonIndex];
    if (!Number.isInteger(delta) || delta === 0 || !reason) return api.showError(new Error('请输入非零整数课时和原因。'));
    const balance = Number(this.data.student.balance || 0);
    if (!(await api.confirm(`当前剩余 ${balance} 节，调整 ${delta > 0 ? '+' : ''}${delta} 节，预计变为 ${balance + delta} 节。\n原因：${reason}`, '确认课时调整'))) return;
    try { await api.call('credits.adjust', { studentId: this.data.studentId, delta, reason }); wx.showToast({ title: '调整成功', icon: 'success' }); this.setData({ delta: '', otherReason: '' }); this.load(); }
    catch (error) { api.showError(error); }
  },
  async resolve(e) {
    const accountId = e.currentTarget.dataset.id;
    const replace = !!this.data.student.boundAccountId;
    if (!(await api.confirm(`${replace ? '原账号将失去此档案访问权限。' : '请先在线下核对申请者身份。'}确认将申请账号绑定到 ${this.data.name} 的档案？`, replace ? '确认换绑' : '确认绑定'))) return;
    try { await api.call('bindings.resolve', { accountId, studentId: this.data.studentId, replace }); wx.showToast({ title: '绑定成功', icon: 'success' }); this.load(); }
    catch (error) { api.showError(error); }
  },
  log(e) { api.route(`/pages/log/log?bookingId=${e.currentTarget.dataset.id}&readonly=1`); },
  writeLog(e) { api.route(`/pages/log/log?bookingId=${e.currentTarget.dataset.id}`); }
});
