const api = require('../../utils/api');
Page({
  data: { date: api.dateToday(), therapists: [], therapistIndex: 0, items: [], busyId: '', reason: '', page: 0, hasMore: false, loading: false, showNotifications: false, notifications: [] },
  onShow() { this.load(); },
  async load() {
    try {
      const session = getApp().globalData.session || await api.call('bootstrap');
      const therapists = [{ id: '', name: '全部教练' }].concat(session.therapists || session.staff || []);
      const therapist = therapists[this.data.therapistIndex] || therapists[0];
      const result = await api.call('bookings.list', { date: this.data.date, therapistId: therapist.id || undefined, page: 1, pageSize: 50 });
      const items = api.bookings(result);
      this.setData({ therapists, items, page: 1, hasMore: items.length === 50 });
    } catch (error) { api.showError(error); }
  },
  async more() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try { const page = this.data.page + 1; const therapist = this.data.therapists[this.data.therapistIndex] || {}; const result = await api.call('bookings.list', { date: this.data.date, therapistId: therapist.id || undefined, page, pageSize: 50 }); const items = api.bookings(result); this.setData({ items: this.data.items.concat(items), page, hasMore: items.length === 50 }); }
    catch (error) { api.showError(error); }
    finally { this.setData({ loading: false }); }
  },
  changeDate(e) { this.setData({ date: e.detail.value }); this.load(); },
  changeTherapist(e) { this.setData({ therapistIndex: Number(e.detail.value) }); this.load(); },
  profiles() { api.route('/pages/profiles/profiles'); },
  staff() { api.route('/pages/staff/staff'); },
  async seedCatalog() {
    if (!(await api.confirm('初始化五位教练目录？此操作不会设置服务项目或排班。', '初始化人员目录'))) return;
    try {
      await api.call('catalog.seed', {});
      getApp().globalData.session = await api.call('bootstrap');
      wx.showToast({ title: '初始化完成', icon: 'success' });
      this.load();
    } catch (error) { api.showError(error); }
  },
  async notifications() {
    if (this.data.showNotifications) return this.setData({ showNotifications: false });
    try { const rows = api.list(await api.call('notifications.list', {}), 'items'); this.setData({ notifications: rows.map(item => ({ ...item, statusText: ({ sent: '已发送', failed: '发送失败', notConfigured: '未配置', noRecipient: '无接收账号', unknown: '状态待确认', pending: '待发送' })[item.status] || item.status })), showNotifications: true }); }
    catch (error) { api.showError(error); }
  },
  async cleanupMedia() {
    if (!(await api.confirm('清理超过 24 小时且当前日志未引用的归档图片？', '清理图片'))) return;
    try {
      const result = await api.call('media.gc', {});
      wx.showModal({ title: '清理完成', content: `检查 ${result.scanned || 0} 张，删除 ${result.deleted || 0} 张，保留 ${result.retained || 0} 张，失败 ${result.failed || 0} 张。`, showCancel: false });
    } catch (error) { api.showError(error); }
  },
  profile(e) { api.route(`/pages/profile/profile?studentId=${e.currentTarget.dataset.id}`); },
  log(e) { api.route(`/pages/log/log?bookingId=${e.currentTarget.dataset.id}&readonly=1`); },
  async signin(e) { await this.action(e.currentTarget.dataset.id, 'bookings.signin', '确认签到并扣 1 节？', {}); },
  async cancel(e) {
    const reason = await this.getReason('取消预约原因');
    if (!reason) return;
    await this.action(e.currentTarget.dataset.id, 'bookings.cancel', '', { reason }, true);
  },
  async undo(e) {
    const reason = await this.getReason('撤销误签到原因');
    if (!reason) return;
    await this.action(e.currentTarget.dataset.id, 'bookings.undo', '', { reason }, true);
  },
  getReason(title) { return new Promise(resolve => wx.showModal({ title, content: title.startsWith('撤销') ? '确认后将退回 1 节课时并取消预约。' : '确认后将取消该预约。', editable: true, placeholderText: '请填写原因，确认后立即执行', success: res => resolve(res.confirm ? String(res.content || '').trim() : '') })); },
  async action(id, action, message, extra, alreadyConfirmed = false) {
    if (this.data.busyId || (!alreadyConfirmed && !(await api.confirm(message)))) return;
    this.setData({ busyId: id });
    try { await api.call(action, { bookingId: id, ...extra }); wx.showToast({ title: '操作成功', icon: 'success' }); this.load(); }
    catch (error) { api.showError(error); this.load(); }
    finally { this.setData({ busyId: '' }); }
  }
});
