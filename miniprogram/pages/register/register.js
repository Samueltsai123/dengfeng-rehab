const api = require('../../utils/api');
Page({
  data: { mode: 'new', name: '', phone: '', pending: false, disabled: false, saving: false, selfOpenid: '' },
  onLoad() { const session = getApp().globalData.session || {}; this.setData({ pending: session.role === 'pending', disabled: session.role === 'disabled', selfOpenid: session.selfOpenid || '' }); },
  copyOpenid() { wx.setClipboardData({ data: this.data.selfOpenid }); },
  refresh() { wx.reLaunch({ url: '/pages/index/index' }); },
  modeNew() { this.setData({ mode: 'new' }); },
  modeBind() { this.setData({ mode: 'bind' }); },
  inputName(e) { this.setData({ name: e.detail.value }); },
  inputPhone(e) { this.setData({ phone: e.detail.value }); },
  async submit() {
    if (this.data.saving) return;
    const name = this.data.name.trim(); const phone = this.data.phone.trim();
    if (!name || !/^1\d{10}$/.test(phone)) return api.showError(new Error('请填写姓名和 11 位手机号。'));
    if (this.data.mode === 'bind' && !(await api.confirm('提交后由管理员核对已有档案。核对完成前无法查看历史资料。', '申请绑定已有档案'))) return;
    this.setData({ saving: true });
    try {
      await api.call('register', { mode: this.data.mode, name, phone });
      if (this.data.mode === 'new') wx.reLaunch({ url: '/pages/index/index' });
      else { this.setData({ pending: true }); wx.showToast({ title: '申请已提交', icon: 'success' }); }
    } catch (error) { api.showError(error); }
    finally { this.setData({ saving: false }); }
  }
});
