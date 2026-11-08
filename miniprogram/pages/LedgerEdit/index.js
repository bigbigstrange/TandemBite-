const app = getApp()
const L = require('../../utils/ledger')
const Feedback = require('../../utils/feedback')
const feedback = Feedback.create(wx, app)
const Drafts = require('../../utils/drafts.js')
const drafts = Drafts.create(wx, app)
Page({
  data: { id: '', bookId: '', amount: '', type: 'expense', category: '买菜食材', categories: L.EXPENSE_CATEGORIES, categoryIcons: L.ICON_NAMES, note: '', dateKey: L.dateKey(), version: 0, saving: false, loading: true, ready: false, readOnly: false, deleted: false, meta: '', sharing: false, error: '', draftMessage: '', draftBlocked: false, amountFocused: false, quickNotes: ['买菜', '早餐', '午餐', '晚餐', '日用'] },
  async onLoad(options) {
    this.options = options
    await this.load()
  },
  async load() {
    try {
      this.setData({ ready: false })
      const { currentUser } = await app.loadUserInfo()
      if (!currentUser) throw new Error('连接失败，请重新加载账本')
      const options = this.options || {}, bookId = options.bookId || app.globalData.kitchenId
      this._requestId = app.requestId()
      this.setData({ bookId, sharing: app.isBound(), error: '', loading: true })
      if (options.id) {
        const result = await app.api({ op: 'ledger', action: 'get', bookId, id: options.id }), x = result.data
        this.setData({ ...x, id: x._id, amount: L.money(x.amountFen), categories: x.type === 'expense' ? L.EXPENSE_CATEGORIES : L.INCOME_CATEGORIES, readOnly: result.readOnly, meta: '创建：' + x.creatorName + '；最近修改：' + x.updatedByName + '；版本 ' + x.version })
        wx.setNavigationBarTitle({ title: result.readOnly ? '封存账目' : '编辑账目' })
      } else if (options.meal) this.setData({ note: '这顿饭的食材花销' })
      if (!this.data.readOnly && !this.data.deleted) drafts.open(this, { kind: 'ledger', id: options.id || '', base: options.id ? String(this.data.version) : 'new', fields: ['amount', 'type', 'category', 'note', 'dateKey'] })
      this.setData({ ready: true, amountFocused: !this.data.draftBlocked && !options.id, categories: this.data.type === 'expense' ? L.EXPENSE_CATEGORIES : L.INCOME_CATEGORIES })
    } catch (e) { this.setData({ error: e.message }) }
    finally { this.setData({ loading: false }) }
  },
  onHide() { drafts.flush(this) },
  onUnload() { drafts.dispose(this) },
  viewDraft() { drafts.inspect(this) },
  async discardDraft() {
    if (this.data.saving) return
    drafts.clear(this)
    if (!this.data.id) this.setData({ amount: '', note: '', dateKey: L.dateKey(), type: 'expense', category: '买菜食材' })
    await this.load()
  },
  useQuickNote(e) {
    const note = e.currentTarget.dataset.note
    if (!this.data.quickNotes.includes(note) || this.data.saving || this.data.draftBlocked) return
    this.setData({ note: (this.data.note.includes(note) ? this.data.note : (this.data.note ? this.data.note + ' · ' + note : note)).slice(0, 100) })
  },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }) },
  changeDate(e) { this.setData({ dateKey: e.detail.value }) },
  selectCategory(e) { this.setData({ category: e.currentTarget.dataset.category }) },
  setType(e) {
    const type = e.currentTarget.dataset.type, categories = type === 'expense' ? L.EXPENSE_CATEGORIES : L.INCOME_CATEGORIES
    this.setData({ type, categories, category: categories[0] })
  },
  saveAndContinue() { return this.save(true) },
  async save(keepOpen = false) {
    keepOpen = keepOpen === true && !this.data.id
    if (this.data.saving || this.data.loading || !this.data.ready || this.data.readOnly || this.data.deleted || this.data.draftBlocked) return
    this.setData({ saving: true, error: '', amountFocused: false })
    try {
      const { bookId, id, version, amount, type, category, note, dateKey } = this.data
      drafts.flush(this)
      await app.api({ op: 'ledger', action: id ? 'update' : 'add', bookId, id, version, requestId: this._requestId, data: { amount: amount.trim(), type, category, note, dateKey } })
      drafts.clear(this)
      feedback.success(this, '这一笔，记好啦', !keepOpen)
      if (keepOpen) {
        this._requestId = app.requestId()
        this.setData({ amount: '', note: '', saving: false, amountFocused: true })
        drafts.open(this, { kind: 'ledger', id: '', base: 'new', fields: ['amount', 'type', 'category', 'note', 'dateKey'] })
      } else setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { this.setData({ error: e.message, saving: false }) }
  },
  async remove() {
    const result = await wx.showModal({ title: '删除这笔账？', content: '删除后会移到最近删除，可以恢复。' })
    if (result.confirm) this.changeDeleted('delete')
  },
  restore() { this.changeDeleted('restore') },
  async changeDeleted(action) {
    if (this.data.readOnly || this.data.saving || this.data.loading) return
    this.setData({ saving: true, error: '' })
    try {
      await app.api({ op: 'ledger', action, bookId: this.data.bookId, id: this.data.id, version: this.data.version })
      drafts.clear(this)
      wx.showToast({ title: action === 'delete' ? '已移到最近删除' : '已恢复' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) { this.setData({ error: e.message, saving: false }) }
  }
})
