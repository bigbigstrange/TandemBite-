function create(wx, app) {
  const scope = () => app.globalData.currentUser?._id && app.globalData.kitchenId ? encodeURIComponent(app.globalData.currentUser._id) + ':' + encodeURIComponent(app.globalData.kitchenId) : ''
  const key = (kind, id = '') => scope() ? 'tandem:draft:2:' + scope() + ':' + kind + ':' + encodeURIComponent(id) : ''
  function read(kind, id) { try { const k = key(kind, id); return k && wx.getStorageSync ? wx.getStorageSync(k) || null : null } catch (_) { return null } }
  function write(kind, id, value) {
    const k = key(kind, id)
    if (!k || !wx.setStorageSync) return false
    try { wx.setStorageSync(k, value); return true } catch (_) { return false }
  }
  function open(page, config) {
    if (!scope() || !wx.getStorageSync || !wx.setStorageSync) return
    if (page._draft?.timer) clearTimeout(page._draft.timer)
    const record = read(config.kind, config.id)
    const state = { ...config, scope: scope(), dirty: false, done: false, blocked: false, managedFiles: record?.managedFiles || [] }
    page._draft = state
    const setData = page._draftSetData || page.setData.bind(page)
    page._draftSetData = setData
    if (record?.data && record.base !== config.base) {
      state.blocked = true; state.previous = record
      setData({ draftBlocked: true, draftMessage: '云端内容已有更新，旧草稿暂未恢复，请查看或放弃旧草稿。' })
    } else if (record?.data) {
      const restored = {}
      for (const field of config.fields) if (Object.prototype.hasOwnProperty.call(record.data, field)) restored[field] = record.data[field]
      if (typeof record.requestId === 'string') page._requestId = record.requestId
      if (record.uploadedImage?.path === restored.tempFilePath) page._uploadedImage = record.uploadedImage
      setData({ ...restored, draftBlocked: false, draftMessage: '已恢复上次未完成的内容，只保存在这台手机。' })
    } else setData({ draftBlocked: false, draftMessage: '' })
    page.setData = function (patch, callback) {
      setData(patch, callback)
      const current = page._draft
      if (!current || current.done || current.blocked || !current.fields.some(field => Object.prototype.hasOwnProperty.call(patch, field))) return
      current.dirty = true
      if (current.timer) clearTimeout(current.timer)
      current.timer = setTimeout(() => flush(page), 400)
    }
  }
  function flush(page) {
    const d = page._draft
    if (!d || d.done || d.blocked || !d.dirty || d.scope !== scope()) return false
    if (d.timer) { clearTimeout(d.timer); d.timer = null }
    const data = Object.fromEntries(d.fields.map(field => [field, page.data[field]]))
    const saved = write(d.kind, d.id, { data, base: d.base, requestId: page._requestId || '', uploadedImage: page._uploadedImage || null, managedFiles: d.managedFiles, updatedAt: Date.now() })
    page._draftSetData({ draftMessage: saved ? '已自动暂存到这台手机' : '手机暂存失败，请勿退出，先保存或释放存储空间。' })
    return saved
  }
  function clear(page) {
    const d = page._draft
    if (!d) return
    d.done = true
    if (d.timer) clearTimeout(d.timer)
    if (d.scope === scope() && wx.removeStorageSync) {
      try { wx.removeStorageSync(key(d.kind, d.id)) }
      catch (_) { write(d.kind, d.id, { completed: true }) }
    }
    page._draftSetData({ draftBlocked: false, draftMessage: '' })
  }
  function dispose(page) {
    const d = page._draft
    if (!d?.done) return flush(page)
    const fs = wx.getFileSystemManager?.()
    for (const filePath of d.managedFiles) if (typeof filePath === 'string' && filePath.startsWith(wx.env?.USER_DATA_PATH + '/tandem-draft-')) fs?.unlink?.({ filePath, fail() {} })
  }
  async function keepPhoto(page, tempFilePath) {
    if (!wx.getFileSystemManager || !wx.env?.USER_DATA_PATH) return tempFilePath
    const fs = wx.getFileSystemManager()
    const filePath = wx.env.USER_DATA_PATH + '/tandem-draft-' + app.requestId() + '.jpg'
    await new Promise((resolve, reject) => fs.copyFile({ srcPath: tempFilePath, destPath: filePath, success: resolve, fail: reject }))
    if (page._draft) page._draft.managedFiles.push(filePath)
    return filePath
  }
  async function checkPhoto(page) {
    const path = page.data.tempFilePath, fs = wx.getFileSystemManager?.()
    if (!path || !fs?.access) return
    const exists = await new Promise(resolve => fs.access({ path, success: () => resolve(true), fail: () => resolve(false) }))
    if (exists) return
    const uploaded = page._uploadedImage?.fileId
    page.setData({ tempFilePath: '', imageUrl: uploaded || page.data.rawImageUrl || '', rawImageUrl: uploaded || page.data.rawImageUrl || '', photoDraftMissing: !uploaded, draftMessage: uploaded ? '已恢复已上传的照片和文字' : '文字已恢复，草稿照片已失效，请重新选择或清除照片。' })
  }
  function inspect(page) {
    const data = page._draft?.previous?.data || {}
    const labels = { name: '菜名', amount: '金额', note: '备注', dateKey: '日期', ingredients: '食材', steps: '做法' }
    const content = Object.entries(labels).filter(([field]) => data[field]).map(([field, label]) => label + '：' + data[field]).join('\n').slice(0, 1500)
    wx.showModal({ title: '旧草稿（未覆盖云端）', content: content || '旧草稿含有照片或其他表单内容。', showCancel: false })
  }
  return { scope, read, write, open, flush, clear, dispose, keepPhoto, checkPhoto, inspect }
}
function revision(record) { return Math.max(...['createTime', 'updateTime', 'recipeUpdateTime'].map(field => new Date(record[field] || 0).getTime() || 0)).toString() }
module.exports = { create, revision }
