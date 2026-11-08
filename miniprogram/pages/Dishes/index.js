const app = getApp()
const DishTools = require('../../utils/dish-tools.js')
const tools = DishTools.create(wx, app)
const Drafts = require('../../utils/drafts.js')
const drafts = Drafts.create(wx, app)

Page({
  goMenu() { wx.redirectTo({ url: '/pages/Order/index' }) },
  goLibrary() { wx.redirectTo({ url: '/pages/Dishes/index' }) },
  goMealHistory() { wx.redirectTo({ url: '/pages/OrderHistory/index' }) },
  data: {
    isBound: false,
    dishes: [],
    filteredDishes: [],
    search: '',
    loading: true,
    partnerName: '',
    filterMode: 'all',
  },

  async onShow() {
    await this.loadDishes()
  },
  async onPullDownRefresh() { try { await this.loadDishes(true) } finally { wx.stopPullDownRefresh() } },
  onPageScroll(e) { this._libraryTop = e.scrollTop },
  onHide() { this.saveBrowse() },
  onUnload() { this.saveBrowse() },
  saveBrowse() { if (this._browseScope === drafts.scope()) drafts.write('library', '', { search: this.data.search, filterMode: this.data.filterMode, scrollTop: this._libraryTop || 0 }) },

  // 获取伴侣名字
  async getPartnerName() {
    try {
      const res = await app.callFunction({ name: 'getOpenId' })
      const openid = res.result?.openid || ''
      const partnerName = app.getPartnerName(openid)
      this.setData({ partnerName })
    } catch (e) {
      console.error('获取伴侣名字失败', e)
    }
  },

  // 加载菜品列表
  async loadDishes(force = false) {
    this.setData({ loading: true })
    try {
      const result = await app.getView('menu', {}, force)
      const saved = drafts.read('library', '') || {}
      this._browseScope = drafts.scope()
      this.setData({ search: saved.search || '', filterMode: saved.filterMode || 'all' })
      app.setKitchenTitle()
      this.setData({ partnerName: app.getPartnerName(), isBound: app.isBound(), readOnly: app.isKitchenReadOnly() })
      let dishes = result.dishes.map(item => ({
        ...item,
        createTimeText: this.formatDate(item.createTime)
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      this.setData({
        dishes,
        filteredDishes: dishes,
        loading: false
      })
      this.filterDishes(() => {
        if (!force && saved.scrollTop) wx.pageScrollTo?.({ scrollTop: saved.scrollTop, duration: 0 })
      })
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 搜索
  onSearch(e) {
    const search = e.detail.value.trim()
    this.setData({ search })
    this.filterDishes()
    this.saveBrowse()
  },

  // 过滤菜品
  filterDishes(callback) {
    const { dishes, search } = this.data
    const filtered = tools.filter(dishes, search, this.data.filterMode)
    if (this.data.filterMode === 'all') filtered.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite))
    this.setData({ filteredDishes: filtered }, callback)
  },
  changeFilter(e) { this.setData({ filterMode: e.currentTarget.dataset.mode }); this.filterDishes(); this.saveBrowse() },
  async toggleFavorite(e) {
    try { await tools.favorite(this, e.currentTarget.dataset.id, this.data.dishes); this.filterDishes() }
    catch (e) { wx.showToast({ title: e.message || '收藏未保存', icon: 'none' }) }
  },

  // 跳转到添加页
  toAddPage() {
    wx.navigateTo({ url: '/pages/DishAdd/index' })
  },

  // 跳转到详情页
  toDetailPage(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)
    const imageUrl = dish?.imageUrl ? encodeURIComponent(dish.imageUrl) : ''
    wx.navigateTo({ url: `/pages/DishDetail/index?id=${id}&imageUrl=${imageUrl}` })
  },

  // 长按删除确认
  showDeleteConfirm(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)

    wx.showModal({
      title: '删除菜品',
      content: `确定要删除「${dish.name}」吗？`,
      confirmColor: '#E53935',
      success: async (res) => {
        if (res.confirm) {
          await this.deleteDish(id)
        }
      }
    })
  },

  // 删除菜品
  async deleteDish(id) {
    wx.showLoading({ title: '删除中...', mask: true })
    try {
      const res = await app.callFunction({
        name: 'updateCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          docId: id,
          action: 'remove'
        }
      })

      wx.hideLoading()

      if (!res.result?.success) {
        throw new Error(res.result?.message || '删除失败')
      }

      // 更新本地数据
      const dishes = this.data.dishes.filter(item => item._id !== id)
      this.setData({ dishes })
      this.filterDishes()

      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('删除失败', e)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  // 格式化日期
  formatDate(date) {
    if (!date) return ''
    const d = new Date(date)
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    return `${month}-${day}`
  },
})
