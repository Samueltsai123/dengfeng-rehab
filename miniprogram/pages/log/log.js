const api = require('../../utils/api');
Page({
  data: { bookingId: '', readonly: false, text: '', images: [], booking: {}, saving: false, loading: true },
  onLoad(options) { this.setData({ bookingId: options.bookingId || '', readonly: options.readonly === '1' }); this.load(); },
  async load() {
    try {
      const record = await api.call('logs.get', { bookingId: this.data.bookingId });
      const log = record && (record.log || record) || {};
      const media = log.fileIds && log.fileIds.length ? await api.call('media.urls', { bookingId: this.data.bookingId }) : { fileIds: [], urls: [] };
      const booking = api.bookings([record && record.booking || {}])[0] || {};
      const fileIds = media.fileIds || log.fileIds || [];
      const urls = media.urls || [];
      const images = fileIds.map((fileId, index) => ({ fileId, url: typeof urls[index] === 'string' ? urls[index] : urls[index] && urls[index].url || '', status: 'ready' }));
      this.setData({ text: log.text || '', booking, images, loading: false });
    } catch (error) { this.setData({ loading: false }); api.showError(error); }
  },
  inputText(e) { this.setData({ text: e.detail.value }); },
  async choose() {
    const remaining = 3 - this.data.images.length;
    if (remaining <= 0) return api.showError(new Error('最多上传 3 张图片。'));
    try {
      const result = await wx.chooseMedia({ count: remaining, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
      const added = result.tempFiles.map(file => ({ localPath: file.tempFilePath, url: file.tempFilePath, status: 'pending', fileId: '' }));
      this.setData({ images: this.data.images.concat(added) });
      added.forEach(image => this.upload(image.localPath));
    } catch (error) { /* User cancelled picker. */ }
  },
  async upload(localPath) {
    const images = this.data.images.map(image => image.localPath === localPath ? { ...image, status: 'uploading' } : image);
    this.setData({ images });
    try {
      const prepared = await api.call('media.prepare', { bookingId: this.data.bookingId });
      const uploaded = await wx.cloud.uploadFile({ cloudPath: prepared.path, filePath: localPath });
      this.setData({ images: this.data.images.map(image => image.localPath === localPath ? { ...image, fileId: uploaded.fileID, status: 'ready' } : image) });
    } catch (error) {
      this.setData({ images: this.data.images.map(image => image.localPath === localPath ? { ...image, status: 'failed' } : image) });
      api.showError(error);
    }
  },
  retry(e) { this.upload(e.currentTarget.dataset.path); },
  remove(e) { const images = this.data.images.slice(); images.splice(Number(e.currentTarget.dataset.index), 1); this.setData({ images }); },
  preview(e) { const urls = this.data.images.filter(image => image.url).map(image => image.url); wx.previewImage({ current: e.currentTarget.dataset.url, urls }); },
  async save() {
    if (this.data.saving) return;
    if (!this.data.text.trim()) return api.showError(new Error('请填写康复反馈文字。'));
    if (this.data.images.some(image => image.status !== 'ready')) return api.showError(new Error('有图片上传失败或尚未完成，请重试或移除后保存。'));
    this.setData({ saving: true });
    try { await api.call('logs.save', { bookingId: this.data.bookingId, text: this.data.text.trim(), fileIds: this.data.images.map(image => image.fileId) }); wx.showToast({ title: '日志已保存', icon: 'success' }); this.load(); }
    catch (error) { api.showError(error); }
    finally { this.setData({ saving: false }); }
  }
});
