const cloud = require('wx-server-sdk');
const { createService } = require('./lib/service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = createService({ cloud, db: cloud.database(), env: process.env });

exports.main = async event => {
  try {
    const context = cloud.getWXContext();
    if (!context.OPENID) throw Object.assign(new Error('请先使用微信登录'), { code: 'UNAUTHENTICATED' });
    const data = await service.handle(event.action, event.payload || {}, context.OPENID, event.requestId);
    return { ok: true, data };
  } catch (error) {
    const known = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code);
    if (!known) console.error('api error', { code: error.code, message: error.message, action: event.action });
    return { ok: false, error: { code: known ? error.code : 'INTERNAL', message: known ? error.message : '服务暂时不可用，请稍后重试' } };
  }
};
