const api = require('../../utils/api');
Page({
  data: { items: [], projects: [], selectedId: '', name: '', accountOpenid: '', projectIds: [], enabled: true, pendingCount: 0, busy: false },
  onShow() { this.load(); },
  async load() {
    try { const session = getApp().globalData.session || {}; const result = await api.call('staff.list', {}); this.setData({ items: api.list(result, 'therapists'), projects: session.projects || [] }); }
    catch (error) { api.showError(error); }
  },
  edit(e) {
    const person = this.data.items.find(item => (item.id || item._id) === e.currentTarget.dataset.id);
    if (!person) return;
    const projectIds = person.projectIds || [];
    this.setData({ selectedId: person.id || person._id, name: person.name || '', accountOpenid: person.accountOpenid || '', projectIds, projects: this.data.projects.map(project => ({ ...project, selected: projectIds.includes(project.id || project._id) })), enabled: person.enabled !== false, pendingCount: person.pendingCount || 0 });
  },
  inputAccount(e) { this.setData({ accountOpenid: e.detail.value.trim() }); },
  toggleProject(e) { const id = e.currentTarget.dataset.id; const values = this.data.projectIds.slice(); const index = values.indexOf(id); if (index >= 0) values.splice(index, 1); else values.push(id); this.setData({ projectIds: values, projects: this.data.projects.map(project => ({ ...project, selected: values.includes(project.id || project._id) })) }); },
  toggleEnabled() { this.setData({ enabled: !this.data.enabled }); },
  schedule(e) { api.route(`/pages/schedule/schedule?therapistId=${e.currentTarget.dataset.id}`); },
  async save() {
    if (!this.data.selectedId || this.data.busy) return;
    const previous = this.data.items.find(item => item.id === this.data.selectedId) || {};
    const warnings = [];
    if (previous.enabled !== false && !this.data.enabled) warnings.push(`当前有 ${this.data.pendingCount} 条未签到预约。停用后该人员不能再处理预约，已有预约不会自动取消。`);
    if ((previous.accountOpenid || '') !== this.data.accountOpenid) warnings.push(this.data.accountOpenid ? '关联码变更后，原微信账号将失去教练权限。' : '清空关联码将解除原微信账号的教练权限。');
    if (warnings.length && !(await api.confirm(warnings.join('\n'), '确认人员变更'))) return;
    this.setData({ busy: true });
    try { await api.call('staff.save', { therapistId: this.data.selectedId, projectIds: this.data.projectIds, enabled: this.data.enabled, accountOpenid: this.data.accountOpenid }); wx.showToast({ title: '已保存', icon: 'success' }); this.load(); }
    catch (error) { api.showError(error); }
    finally { this.setData({ busy: false }); }
  }
});
