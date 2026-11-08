const app = getApp()
const L = require('../../utils/ledger')
const allCategories = () => L.EXPENSE_CATEGORIES.map((name, index) => ({ name, icon: L.ICON_NAMES[index], selected: true }))
Page({
  data: { month: L.dateKey().slice(0, 7), bookId: '', mode: 'month', startDate: L.dateKey().slice(0, 7) + '-01', endDate: L.dateKey(), filtersApplied: false, selectedCategories: L.EXPENSE_CATEGORIES, filterLabel: '', periodLabel: '', showFilter: false, draftMode: 'month', draftMonth: '', draftStart: '', draftEnd: '', draftCategories: [], allSelected: true, tab: '明细', tabs: ['明细', '统计'], entries: [], loading: false, error: '', hasMore: false, deleted: false, expenseText: '0.00', incomeText: '0.00', netText: '0.00', categories: [], people: [] },
  async onShow() {
    await this.load(true)
  },
  query() {
    const d = this.data
    return { op: 'ledger', bookId: d.bookId, ...(d.mode === 'range' ? { startDate: d.startDate, endDate: d.endDate } : { month: d.month }), ...(d.filtersApplied ? { categories: d.selectedCategories } : {}) }
  },
  async load(reset = true, force = false) {
    if (this.data.loading) return
    this.setData({ loading: true, error: '', periodLabel: this.data.mode === 'range' ? this.data.startDate + ' 至 ' + this.data.endDate : this.data.month })
    const query = this.query(), deleted = this.data.deleted, skip = reset ? 0 : this.data.entries.length
    try {
      const { op, bookId, ...filters } = query
      const list = await app.getView('ledger', { ...filters, deleted, skip, includeStats: reset }, force)
      const stats = reset ? list : null
      const entries = list.data.map(x => ({ ...x, amountText: L.money(x.amountFen), icon: x.type === 'income' ? 'wallet' : L.ICON_NAMES[L.EXPENSE_CATEGORIES.indexOf(x.category)] || 'ellipsis', creatorLabel: x.creatorId === app.globalData.currentUser._id ? '我' : x.creatorName }))
      const combined = reset ? entries : this.data.entries.concat(entries)
      this.setData({ bookId: list.kitchenId, entries: combined.map((entry, index) => ({ ...entry, showDate: index === 0 || combined[index - 1].dateKey !== entry.dateKey })), hasMore: list.hasMore, ...(stats ? L.totals(stats.groups, stats.people) : {}) })
    } catch (e) { this.setData({ error: e.message }) }
    finally { this.setData({ loading: false }) }
  },
  changeMonth(e) { if (!this.data.loading) { this.setData({ month: e.detail.value, mode: 'month', entries: [] }); this.load(true) } },
  changeTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }) },
  openFilter() {
    this.setData({ showFilter: true, draftMode: this.data.mode, draftMonth: this.data.month, draftStart: this.data.startDate, draftEnd: this.data.endDate, draftCategories: allCategories().map(c => ({ ...c, selected: this.data.selectedCategories.includes(c.name) })), allSelected: this.data.selectedCategories.length === 8, filterError: '' })
  },
  closeFilter() { this.setData({ showFilter: false }) },
  preventClose() {},
  draftMode(e) { this.setData({ draftMode: e.currentTarget.dataset.mode }) },
  draftDate(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }) },
  toggleCategory(e) {
    const categories = this.data.draftCategories.map(c => c.name === e.currentTarget.dataset.name ? { ...c, selected: !c.selected } : c)
    this.setData({ draftCategories: categories, allSelected: categories.every(c => c.selected) })
  },
  selectAll() { const selected = !this.data.allSelected; this.setData({ draftCategories: allCategories().map(c => ({ ...c, selected })), allSelected: selected }) },
  applyFilter() {
    if (this.data.loading) return
    const d = this.data, categories = d.draftCategories.filter(c => c.selected).map(c => c.name)
    if (!categories.length) return this.setData({ filterError: '请至少选择一个支出分类' })
    if (d.draftMode === 'range' && (!d.draftStart || !d.draftEnd || d.draftStart > d.draftEnd)) return this.setData({ filterError: '开始日期不能晚于结束日期' })
    this.setData({ mode: d.draftMode, month: d.draftMonth, startDate: d.draftStart, endDate: d.draftEnd, selectedCategories: categories, filterLabel: categories.length === 8 ? '全部支出分类' : categories.join('、'), filtersApplied: true, showFilter: false, entries: [] })
    this.load(true)
  },
  clearFilter() { if (!this.data.loading) { this.setData({ mode: 'month', filtersApplied: false, selectedCategories: L.EXPENSE_CATEGORIES, entries: [] }); this.load(true) } },
  addEntry() { wx.navigateTo({ url: '/pages/LedgerEdit/index' }) },
  editEntry(e) { wx.navigateTo({ url: '/pages/LedgerEdit/index?id=' + encodeURIComponent(e.currentTarget.dataset.id) + '&bookId=' + encodeURIComponent(this.data.bookId) }) },
  toggleDeleted() { if (!this.data.loading) { this.setData({ deleted: !this.data.deleted, entries: [] }); this.load(true) } },
  loadMore() { if (this.data.hasMore) this.load(false) },
  async onPullDownRefresh() { try { await this.load(true, true) } finally { wx.stopPullDownRefresh() } },
  onReachBottom() { this.loadMore() },
  async exportCSV() {
    if (this._exporting) return
    this._exporting = true
    const query = this.query(), period = this.data.mode === 'range' ? this.data.startDate + '_' + this.data.endDate : this.data.month
    wx.showLoading({ title: '正在导出', mask: true })
    try {
      const rows = []; let hasMore = true
      while (hasMore) { const result = await app.api({ ...query, action: 'list', skip: rows.length }); rows.push(...result.data); hasMore = result.hasMore }
      const fileName = '伴食账本-' + period + (this.data.filtersApplied ? '-支出筛选' : '') + '.csv', filePath = wx.env.USER_DATA_PATH + '/' + fileName
      await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: L.toCSV(rows), encoding: 'utf8', success: resolve, fail: reject }))
      wx.hideLoading()
      if (wx.shareFileMessage) await wx.shareFileMessage({ filePath, fileName })
      else wx.showModal({ title: '导出完成', content: '当前微信版本不支持分享文件，请升级微信后重试。', showCancel: false })
    } catch (e) { if (!(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '导出失败，请重试', icon: 'none' }) }
    finally { wx.hideLoading(); this._exporting = false }
  }
})
