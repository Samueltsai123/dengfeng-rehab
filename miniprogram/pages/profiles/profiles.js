const api = require('../../utils/api');
Page({
  data: { query: '', items: [], role: '', loading: false, page: 0, hasMore: false },
  onLoad() { this.setData({ role: (getApp().globalData.session || {}).role || '' }); },
  onShow() { this.load(); },
  input(e) { this.setData({ query: e.detail.value }); },
  async load() {
    this.setData({ loading: true });
    try { const items = api.list(await api.call('profiles.list', { query: this.data.query.trim(), page: 1, pageSize: 50 }), 'students'); this.setData({ items, page: 1, hasMore: items.length === 50 }); }
    catch (error) { api.showError(error); }
    finally { this.setData({ loading: false }); }
  },
  async more() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try { const page = this.data.page + 1; const items = api.list(await api.call('profiles.list', { query: this.data.query.trim(), page, pageSize: 50 }), 'students'); this.setData({ items: this.data.items.concat(items), page, hasMore: items.length === 50 }); }
    catch (error) { api.showError(error); }
    finally { this.setData({ loading: false }); }
  },
  open(e) { api.route(`/pages/profile/profile?studentId=${e.currentTarget.dataset.id}`); },
  create() { api.route('/pages/profile/profile?create=1'); }
});
