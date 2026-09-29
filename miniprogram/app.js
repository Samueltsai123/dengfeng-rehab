const config = require('./config');

App({
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({ title: '当前微信版本过低', content: '请更新微信后再使用小程序。', showCancel: false });
      return;
    }
    wx.cloud.init(config.cloudEnvId ? { env: config.cloudEnvId, traceUser: true } : { traceUser: true });
  },
  globalData: { session: null }
});
