const api = require('../../utils/api');
Page({
  data: { therapists: [], projects: [], projectOptions: [], slots: [], therapistIndex: -1, projectIndex: -1, date: api.dateToday(), today: api.dateToday(), slotIndex: -1, available: null, saving: false },
  onLoad() {
    const session = getApp().globalData.session || {};
    this.setData({ therapists: (session.therapists || session.staff || []).filter(item => item.enabled !== false), projects: session.projects || [] });
  },
  selectTherapist(e) {
    const therapistIndex = Number(e.detail.value); const therapist = this.data.therapists[therapistIndex];
    const projectOptions = this.data.projects.filter(project => (therapist.projectIds || []).includes(project.id || project._id));
    this.slotQuery = (this.slotQuery || 0) + 1;
    this.setData({ therapistIndex, projectOptions, projectIndex: -1, slots: [], slotIndex: -1, available: null });
  },
  selectProject(e) { this.setData({ projectIndex: Number(e.detail.value), slotIndex: -1 }); this.loadSlots(); },
  selectDate(e) { this.setData({ date: e.detail.value, slotIndex: -1 }); this.loadSlots(); },
  selectSlot(e) { this.setData({ slotIndex: Number(e.currentTarget.dataset.index) }); },
  async loadSlots() {
    const { therapists, therapistIndex, projectOptions, projectIndex, date } = this.data;
    if (therapistIndex < 0 || projectIndex < 0) return;
    const query = this.slotQuery = (this.slotQuery || 0) + 1;
    try {
      const therapistId = therapists[therapistIndex].id || therapists[therapistIndex]._id;
      const projectId = projectOptions[projectIndex].id || projectOptions[projectIndex]._id;
      const result = await api.call('bookings.slots', { therapistId, projectId, date });
      if (query !== this.slotQuery) return;
      const values = api.list(result, 'slots');
      this.setData({ slots: values.map(slot => typeof slot === 'number' ? { startMinute: slot } : slot).map(slot => ({ ...slot, startText: api.time(slot.startMinute), endText: api.time(slot.endMinute || slot.startMinute + Number(projectOptions[projectIndex].durationMinutes || projectOptions[projectIndex].duration || 0)) })), slotIndex: -1, available: result.available });
    } catch (error) { api.showError(error); }
  },
  history() { api.route('/pages/bookings/bookings'); },
  async submit() {
    if (this.data.saving) return;
    const { therapistIndex, projectIndex, slotIndex, therapists, projectOptions, slots, date } = this.data;
    if (therapistIndex < 0 || projectIndex < 0 || slotIndex < 0) return api.showError(new Error('请选择教练、项目和可约时间。'));
    this.setData({ saving: true });
    try {
      const session = getApp().globalData.session || {};
      if (session.subscriptionTemplateId) {
        try { await wx.requestSubscribeMessage({ tmplIds: [session.subscriptionTemplateId] }); }
        catch (_) { /* Refusal or unavailable permission does not block booking. */ }
      }
      await api.call('bookings.create', { therapistId: therapists[therapistIndex].id || therapists[therapistIndex]._id, projectId: projectOptions[projectIndex].id || projectOptions[projectIndex]._id, date, startMinute: slots[slotIndex].startMinute });
      wx.showToast({ title: '预约成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/bookings/bookings' }), 600);
    } catch (error) { api.showError(error); this.loadSlots(); }
    finally { this.setData({ saving: false }); }
  }
});
