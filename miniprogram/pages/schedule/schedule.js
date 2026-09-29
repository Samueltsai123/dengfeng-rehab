const api = require('../../utils/api');
const weekdayOptions = [{ value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' }, { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 0, label: '周日' }];
function displayRanges(ranges) { return (ranges || []).map(range => ({ start: api.time(range.startMinute), end: api.time(range.endMinute) })); }
function payloadRanges(ranges) { return ranges.map(range => ({ startMinute: api.minute(range.start), endMinute: api.minute(range.end) })); }
Page({
  data: { role: '', therapists: [], therapistIndex: 0, therapistId: '', date: api.dateToday(), ranges: [], weekdays: weekdayOptions, selectedDays: [], templateRanges: [{ start: '09:00', end: '13:00' }], startDate: api.dateToday(), endDate: api.dateToday(), saving: false },
  onLoad(options) {
    const session = getApp().globalData.session || {};
    const therapists = session.role === 'admin' ? session.therapists || session.staff || [] : [session.therapist || {}];
    const index = Math.max(0, therapists.findIndex(item => (item.id || item._id) === options.therapistId));
    this.setData({ role: session.role, therapists, therapistIndex: index, therapistId: therapists[index] && (therapists[index].id || therapists[index]._id) || '' });
    this.load();
  },
  therapistChange(e) { const index = Number(e.detail.value); const therapist = this.data.therapists[index]; this.setData({ therapistIndex: index, therapistId: therapist.id || therapist._id }); this.load(); },
  dateChange(e) { this.setData({ date: e.detail.value }); this.load(); },
  startDateChange(e) { this.setData({ startDate: e.detail.value }); },
  endDateChange(e) { this.setData({ endDate: e.detail.value }); },
  async load() {
    if (!this.data.therapistId) return;
    try {
      const data = await api.call('schedule.get', { therapistId: this.data.therapistId, date: this.data.date });
      const template = data.template || {};
      const selectedDays = template.weekdays || this.data.selectedDays;
      this.setData({ ranges: displayRanges(data.ranges), selectedDays, weekdays: weekdayOptions.map(day => ({ ...day, checked: selectedDays.includes(day.value) })), templateRanges: template.ranges && template.ranges.length ? displayRanges(template.ranges) : this.data.templateRanges });
    } catch (error) { api.showError(error); }
  },
  addRange(e) { const key = e.currentTarget.dataset.key; this.setData({ [key]: this.data[key].concat({ start: '09:00', end: '13:00' }) }); },
  removeRange(e) { const key = e.currentTarget.dataset.key; const ranges = this.data[key].slice(); ranges.splice(Number(e.currentTarget.dataset.index), 1); this.setData({ [key]: ranges }); },
  changeTime(e) { const key = e.currentTarget.dataset.key; const field = e.currentTarget.dataset.field; const ranges = this.data[key].slice(); ranges[Number(e.currentTarget.dataset.index)] = { ...ranges[Number(e.currentTarget.dataset.index)], [field]: e.detail.value }; this.setData({ [key]: ranges }); },
  toggleDay(e) { const day = Number(e.currentTarget.dataset.day); const selected = this.data.selectedDays.slice(); const index = selected.indexOf(day); if (index >= 0) selected.splice(index, 1); else selected.push(day); this.setData({ selectedDays: selected, weekdays: weekdayOptions.map(item => ({ ...item, checked: selected.includes(item.value) })) }); },
  validRanges(ranges) {
    return ranges.every(range => {
      const start = api.minute(range.start); const end = api.minute(range.end);
      return Number.isFinite(start) && Number.isFinite(end) && start < end && ((start >= 540 && end <= 780) || (start >= 840 && end <= 1170));
    });
  },
  async save() {
    if (this.data.saving) return;
    if (!this.validRanges(this.data.ranges)) return api.showError(new Error('空闲段需在 09:00—13:00 或 14:00—19:30 内，结束晚于开始。'));
    this.setData({ saving: true });
    try { await api.call('schedule.save', { therapistId: this.data.therapistId, date: this.data.date, ranges: payloadRanges(this.data.ranges) }); wx.showToast({ title: '已保存', icon: 'success' }); this.load(); }
    catch (error) { if (error.code === 'SCHEDULE_CONFLICT') wx.showModal({ title: '排班影响已有预约', content: error.message, showCancel: false }); else api.showError(error); }
    finally { this.setData({ saving: false }); }
  },
  async fill() {
    if (this.data.saving) return;
    if (!this.data.selectedDays.length || !this.data.templateRanges.length || this.data.startDate > this.data.endDate || !this.validRanges(this.data.templateRanges)) return api.showError(new Error('请选择工作日、有效空闲段和日期范围。'));
    this.setData({ saving: true });
    try {
      const result = await api.call('schedule.fill', { therapistId: this.data.therapistId, weekdays: this.data.selectedDays, ranges: payloadRanges(this.data.templateRanges), startDate: this.data.startDate, endDate: this.data.endDate });
      wx.showModal({ title: result.failed ? '部分日期未完成' : '应用完成', content: `已填充 ${result.filled || 0} 天，跳过已有设置 ${result.skipped || 0} 天，失败 ${result.failed || 0} 天。`, showCancel: false });
      this.load();
    } catch (error) { api.showError(error); }
    finally { this.setData({ saving: false }); }
  }
});
