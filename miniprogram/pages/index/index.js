const api = require('../../utils/api');
Page({
  data: { loading: true, error: '' },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const session = await api.call('bootstrap');
      getApp().globalData.session = session;
      const role = session.role;
      const url = role === 'admin' ? '/pages/admin/admin' : role === 'therapist' ? '/pages/therapist/therapist' : role === 'student' && session.student ? '/pages/student/student' : '/pages/register/register';
      wx.redirectTo({ url });
    } catch (error) { this.setData({ loading: false, error: error.message }); }
  }
});
