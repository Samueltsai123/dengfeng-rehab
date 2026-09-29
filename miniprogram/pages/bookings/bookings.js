const api = require('../../utils/api');
Page({
  data: { items: [], loading: true, page: 0, hasMore: false },
  onShow() { this.load(); },
  async load() {
    try { const items = api.bookings(await api.call('bookings.list', { page: 1, pageSize: 50 })); this.setData({ items, page: 1, hasMore: items.length === 50, loading: false }); }
    catch (error) { this.setData({ loading: false }); api.showError(error); }
  },
  async more() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try { const page = this.data.page + 1; const items = api.bookings(await api.call('bookings.list', { page, pageSize: 50 })); this.setData({ items: this.data.items.concat(items), page, hasMore: items.length === 50 }); }
    catch (error) { api.showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async cancel(e) {
    const item = this.data.items.find(value => value.id === e.currentTarget.dataset.id);
    if (!item || !(await api.confirm('取消后原时段将释放。重新预约不保证仍有空位。', '取消预约'))) return;
    try { await api.call('bookings.cancel', { bookingId: item.id, reason: '学员自行取消' }); wx.showToast({ title: '已取消', icon: 'success' }); this.load(); }
    catch (error) { api.showError(error); }
  },
  log(e) { api.route(`/pages/log/log?bookingId=${e.currentTarget.dataset.id}&readonly=1`); }
});
