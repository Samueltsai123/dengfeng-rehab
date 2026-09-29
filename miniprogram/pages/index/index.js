const api = require('../../utils/api');

// 云函数不可用时的只读展示数据，让首页退化为机构介绍页而不是一行报错。
// 注意：服务项目须与 cloudfunctions/api/lib/rules.js 的 PROJECTS 保持一致，改动时两处同步。
const FALLBACK_PROJECTS = [
  { id: 'P01', name: '系统评估', duration: 30 },
  { id: 'P02', name: '肩颈腰背/下肢筋膜松解', duration: 40 },
  { id: 'P03', name: '体态调整', duration: 60 },
  { id: 'P04', name: '运动损伤', duration: 60 },
  { id: 'P05', name: '术前术后恢复', duration: 90 }
];

Page({
  data: { loading: true, error: '', projects: FALLBACK_PROJECTS },
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
