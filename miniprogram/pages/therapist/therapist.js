const api = require('../../utils/api');
Page({
  data: { date: api.dateToday(), items: [], therapist: {}, busyId: '', page: 0, hasMore: false, loading: false },
  onShow() { this.load(); },
  changeDate(e) { this.setData({ date: e.detail.value }); this.load(); },
  async load() {
    try {
      const session = getApp().globalData.session || await api.call('bootstrap');
      const therapist = session.therapist || {};
      const result = await api.call('bookings.list', { date: this.data.date, therapistId: therapist.id || therapist._id, page: 1, pageSize: 50 });
      const items = api.bookings(result);
      this.setData({ therapist, items, page: 1, hasMore: items.length === 50 });
    } catch (error) { api.showError(error); }
  },
  async more() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try { const page = this.data.page + 1; const result = await api.call('bookings.list', { date: this.data.date, therapistId: this.data.therapist.id || this.data.therapist._id, page, pageSize: 50 }); const items = api.bookings(result); this.setData({ items: this.data.items.concat(items), page, hasMore: items.length === 50 }); }
    catch (error) { api.showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async signin(e) {
    const item = this.data.items.find(value => value.id === e.currentTarget.dataset.id);
    if (!item || this.data.busyId || !(await api.confirm(`${item.studentName} · ${item.projectName}\n${item.date} ${item.startText}—${item.endText}\n本次扣 1 节。`, '确认签到'))) return;
    this.setData({ busyId: item.id });
    try { await api.call('bookings.signin', { bookingId: item.id }); wx.showToast({ title: '签到成功', icon: 'success' }); this.load(); }
    catch (error) { api.showError(error); this.load(); }
    finally { this.setData({ busyId: '' }); }
  },
  log(e) { api.route(`/pages/log/log?bookingId=${e.currentTarget.dataset.id}`); },
  profile(e) { api.route(`/pages/profile/profile?studentId=${e.currentTarget.dataset.id}`); },
  profiles() { api.route('/pages/profiles/profiles'); },
  schedule() { api.route('/pages/schedule/schedule'); }
});
