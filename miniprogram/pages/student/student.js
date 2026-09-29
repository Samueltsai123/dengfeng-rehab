const api = require('../../utils/api');
Page({
  data: { student: {}, today: [], loading: true },
  onShow() { this.load(); },
  async load() {
    try {
      const session = await api.call('bootstrap'); getApp().globalData.session = session;
      if (!session.student) return wx.reLaunch({ url: '/pages/register/register' });
      const data = await api.call('bookings.list', { date: api.dateToday(), studentId: session.student.id || session.student._id });
      const student = session.student;
      this.setData({ student, today: api.bookings(data), loading: false });
    } catch (error) { this.setData({ loading: false }); api.showError(error); }
  },
  book() { api.route('/pages/booking/booking'); },
  history() { api.route('/pages/bookings/bookings'); },
  profile() { api.route('/pages/profile/profile?mine=1'); }
});
