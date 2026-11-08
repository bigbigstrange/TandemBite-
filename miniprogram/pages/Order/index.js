const app = getApp()
const Drafts = require('../../utils/drafts.js')
const DishTools = require('../../utils/dish-tools.js')
const drafts = Drafts.create(wx, app)
const tools = DishTools.create(wx, app)

Page({
  goMenu() { wx.redirectTo({ url: '/pages/Order/index' }) },
  goLibrary() { wx.redirectTo({ url: '/pages/Dishes/index' }) },
  goMealHistory() { wx.redirectTo({ url: '/pages/OrderHistory/index' }) },
  data: {
    isBound: false,
    dishes: [],
    allDishes: [],
    categories: [],
    dishesByCategory: {},
    categoryCount: {},
    selectedByCategory: {},
    currentCategory: '',
    categoryScrollId: '',
    dishScrollId: '',
    selectedCount: 0,
    selectedDishes: [],
    loading: true,
    refreshing: false,
    error: '',
    showSuccess: false,
    showRemarkModal: false,
    showCartPanel: false,
    showDishDetail: false,
    detailClosing: false,
    currentDish: null,
    detailTranslateY: 0,
    remark: '',
    submitting: false,
    partnerName: '对方',
    categoryTops: [],
    searchKey: '',
    filterMode: 'all', menuScrollTop: 0, cartRestored: false,
  },

  async onShow() {
    await this.loadDishes()
  },
  onHide() { this.saveMenuDraft() },
  onUnload() { this.saveMenuDraft() },
  saveMenuDraft() {
    if (!this._menuScope || this._menuScope !== drafts.scope() || this.data.showSuccess) return
    drafts.write('menu', '', { ids: this.data.allDishes.filter(d => d.selected).map(d => d._id), searchKey: this.data.searchKey, filterMode: this.data.filterMode, category: this.data.currentCategory, scrollTop: this._menuScrollTop || 0, remark: this.data.remark, requestId: this._requestId || '' })
  },
  changeFilter(e) {
    const mode = e.currentTarget.dataset.mode
    if (!['all', 'favorite', 'frequent'].includes(mode)) return
    this.setData({ filterMode: mode, dishScrollId: '', menuScrollTop: 0 })
    this._menuScrollTop = 0
    this.filterDishes(this.data.searchKey)
    this.saveMenuDraft()
  },
  async toggleFavorite(e) {
    try {
      const value = await tools.favorite(this, e.currentTarget.dataset.id, this.data.allDishes)
      if (value === undefined) return
      this.filterDishes(this.data.searchKey, false)
      if (this.data.currentDish?._id === e.currentTarget.dataset.id) this.setData({ currentDish: { ...this.data.currentDish, favorite: value } })
    } catch (e) { wx.showToast({ title: e.message || '收藏未保存', icon: 'none' }) }
  },

  // 获取伴侣名字
  async loadPartnerName() {
    await app.loadUserInfo()
    const partnerName = app.getPartnerName()
    this.setData({ partnerName })
  },

  // 加载菜品
  async refreshMenu() {
    this.setData({ refreshing: true })
    try { await this.loadDishes(true) } finally { this.setData({ refreshing: false }) }
  },

  async loadDishes(force = false) {
    this.setData({ loading: true, error: '' })
    try {
      const result = await app.getView('menu', {}, force)
      const data = result.dishes
      const saved = drafts.read('menu', '') || {}
      this._menuScope = drafts.scope()
      app.setKitchenTitle()
      this.setData({ isBound: app.isBound(), readOnly: app.isKitchenReadOnly(), partnerName: app.getPartnerName() })
      const selected = new Set(saved.ids || (this.data.allDishes || []).filter(d => d.selected).map(d => d._id))

      // 检查是否有再来一单的菜品
      const reorderIds = app.globalData.reorderDishIds ? app.globalData.reorderDishIds.split(',') : []
      app.globalData.reorderDishIds = null
      this._requestId = reorderIds.length ? null : (saved.requestId || this._requestId)

      const dishes = data.map(item => ({
        ...item,
        selected: reorderIds.length ? reorderIds.includes(item._id) : selected.has(item._id),
        category: item.category || 'meat'
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      const categories = app.globalData.categories || []
      if (categories.length === 0) {
        console.warn('分类数据为空，请检查 manageCategory 云函数')
        this.setData({ dishes, allDishes: dishes, loading: false })
        return
      }

      const dishesByCategory = {}
      const categoryCount = {}
      const selectedByCategory = {}

      categories.forEach(cat => {
        dishesByCategory[cat._id] = dishes.filter(d => d.category === cat._id)
        categoryCount[cat._id] = dishesByCategory[cat._id].length
        selectedByCategory[cat._id] = dishes.filter(d => d.category === cat._id && d.selected).length
      })

      const selectedDishes = dishes.filter(d => d.selected)

      // 找到第一个有菜品的分类
      const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

      this.setData({
        dishes,
        allDishes: dishes,
        categories,
        dishesByCategory,
        categoryCount,
        selectedByCategory,
        selectedDishes,
        selectedCount: selectedDishes.length,
        currentCategory: firstCategory ? firstCategory._id : categories[0]._id,
        loading: false,
        searchKey: saved.searchKey || '',
        filterMode: saved.filterMode || 'all',
        menuScrollTop: Number(saved.scrollTop) || 0,
        remark: saved.remark || '',
        cartRestored: !reorderIds.length && selectedDishes.length > 0
      }, () => this.measureCategoryTops())
      this._menuScrollTop = Number(saved.scrollTop) || 0
      this.filterDishes(this.data.searchKey, false)
      if (saved.category && this.data.categoryCount[saved.category] > 0) this.setData({ currentCategory: saved.category })

      if (reorderIds.length > 0) {
        wx.showToast({ title: '已选好菜品~', icon: 'none' })
      }
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false, error: e.message || '菜品加载失败，请重试' })
    }
  },

  // 选择分类
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({
      currentCategory: id,
      dishScrollId: `cat-${id}`,
      categoryScrollId: `catleft-${id}`
    })
  },

  // 搜索输入
  onSearchInput(e) {
    const searchKey = e.detail.value.trim()
    this.setData({ searchKey })
    this.filterDishes(searchKey)
    this.saveMenuDraft()
  },

  // 清除搜索
  clearSearch() {
    this.setData({ searchKey: '' })
    this.filterDishes('')
    this.saveMenuDraft()
  },

  // 过滤菜品
  filterDishes(searchKey, resetCategory = true) {
    const { allDishes, categories } = this.data
    const dishes = tools.filter(allDishes, searchKey, this.data.filterMode)
    if (this.data.filterMode === 'all') dishes.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite))

    const dishesByCategory = {}
    const categoryCount = {}
    const selectedByCategory = {}

    categories.forEach(cat => {
      dishesByCategory[cat._id] = dishes.filter(d => d.category === cat._id)
      categoryCount[cat._id] = dishesByCategory[cat._id].length
      selectedByCategory[cat._id] = allDishes.filter(d => d.category === cat._id && d.selected).length
    })

    const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

    this.setData({
      dishes,
      dishesByCategory,
      categoryCount,
      selectedByCategory,
      selectedDishes: allDishes.filter(d => d.selected),
      selectedCount: allDishes.filter(d => d.selected).length,
      currentCategory: !resetCategory && categoryCount[this.data.currentCategory] > 0 ? this.data.currentCategory : (firstCategory ? firstCategory._id : (categories[0]?._id || ''))
    }, () => this.measureCategoryTops())
  },

  // 监听右侧滚动，同步左侧高亮
  onDishScroll(e) {
    this._menuScrollTop = e.detail.scrollTop
    const top = e.detail.scrollTop + 20
    const offsets = this._categoryOffsets || []
    if (!offsets.length) return
    let activeId = offsets[0].id
    for (const offset of offsets) if (offset.top <= top) activeId = offset.id
    if (activeId !== this.data.currentCategory) this.setData({ currentCategory: activeId, categoryScrollId: 'catleft-' + activeId })
  },

  measureCategoryTops() {
    const visibleCats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (visibleCats.length === 0) return

    const query = this.createSelectorQuery()
    query.select('.dish-list').boundingClientRect()
    query.select('.dish-list').scrollOffset()
    visibleCats.forEach(cat => {
      query.select(`#cat-${cat._id}`).boundingClientRect()
    })
    query.exec(rects => {
      if (!rects || !rects[0]) return
      this._categoryOffsets = visibleCats.flatMap((cat, i) => rects[i + 2] ? [{ id: cat._id, top: rects[i + 2].top - rects[0].top + (rects[1]?.scrollTop || 0) }] : [])
    })
  },

  // 选择以完整菜品库为准，搜索只改变当前可见列表。
  setSelected(id, selected) {
    this.data.allDishes = this.data.allDishes.map(dish => dish._id === id ? { ...dish, selected } : dish)
    this.filterDishes(this.data.searchKey, false)
    if (this.data.currentDish?._id === id) this.setData({ currentDish: this.data.allDishes.find(dish => dish._id === id) })
    this.saveMenuDraft()
  },

  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.allDishes.find(item => item._id === id)
    if (dish) this.setSelected(id, !dish.selected)
  },

  // 切换购物车面板
  toggleCartPanel() {
    this.setData({ showCartPanel: !this.data.showCartPanel })
  },

  // 打开菜品详情面板
  openDishDetail(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(d => d._id === id)
    if (dish) {
      this.setData({ showDishDetail: true, currentDish: dish })
    }
  },

  // 关闭菜品详情面板
  closeDishDetail() {
    this.setData({ detailClosing: true, detailTranslateY: 0 })
    setTimeout(() => {
      this.setData({ showDishDetail: false, detailClosing: false, currentDish: null })
    }, 300)
  },

  // 下拉关闭 - 触摸开始
  onDetailTouchStart(e) {
    this.touchStartY = e.touches[0].clientY
    this.isDragging = false
  },

  // 下拉关闭 - 触摸移动
  onDetailTouchMove(e) {
    const currentY = e.touches[0].clientY
    const deltaY = currentY - this.touchStartY
    if (deltaY > 0) {
      this.isDragging = true
      this.setData({ detailTranslateY: deltaY })
    }
  },

  // 下拉关闭 - 触摸结束
  onDetailTouchEnd() {
    const { detailTranslateY } = this.data
    if (detailTranslateY > 150) {
      this.closeDishDetail()
    } else {
      this.setData({ detailTranslateY: 0 })
    }
  },

  // 详情、购物车和列表使用同一套选择状态。
  toggleDishInDetail() {
    const dish = this.data.currentDish
    if (dish) this.setSelected(dish._id, !dish.selected)
  },

  removeFromCart(e) { this.setSelected(e.currentTarget.dataset.id, false) },

  clearCart() {
    this.data.allDishes = this.data.allDishes.map(dish => ({ ...dish, selected: false }))
    this.filterDishes(this.data.searchKey, false)
    this.setData({ showCartPanel: false })
    this._requestId = null
    this.setData({ cartRestored: false })
    this.saveMenuDraft()
  },

  // 提交点菜 - 先弹出备注输入框
  submitOrder() {
    const { selectedDishes, submitting } = this.data

    if (submitting || selectedDishes.length === 0) {
      if (selectedDishes.length === 0) {
        wx.showToast({ title: '请先选择菜品', icon: 'none' })
      }
      return
    }

    // 弹出备注输入框
    this.setData({ showRemarkModal: true, remark: '' })
  },

  // 输入备注
  onRemarkInput(e) {
    let value = e.detail.value
    if (value.length > 100) value = value.slice(0, 100)
    this.setData({ remark: value })
    return value
  },

  // 关闭备注弹窗
  closeRemarkModal() {
    this.setData({ showRemarkModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  // 跳过备注
  skipRemark() {
    this.setData({ showRemarkModal: false })
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      complete: () => this.doSubmitOrder('')
    })
  },

  // 确认备注
  confirmRemark() {
    this.setData({ showRemarkModal: false })
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      complete: () => this.doSubmitOrder(this.data.remark)
    })
  },

  // 实际提交点菜
  async doSubmitOrder(remark) {
    if (this.data.submitting) return
    if (app.isKitchenReadOnly()) {
      wx.showToast({ title: '历史厨房只能查看', icon: 'none' })
      return
    }

    const { selectedDishes } = this.data
    if (!selectedDishes.length) {
      wx.showToast({ title: '请先选择菜品', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    try {
      this._requestId = this._requestId || app.requestId()
      this.setData({ remark })
      this.saveMenuDraft()
      const addRes = await app.addKitchenData(app.globalData.collectionOrderList, {
          dishes: selectedDishes.map(item => ({
            _id: item._id,
            name: item.name,
            imageUrl: item._raw_imageUrl || item.imageUrl || '',
            category: item.category
          })),
          remark,
      }, this._requestId)
      const orderId = addRes._id
      this._requestId = null
      this.data.allDishes = this.data.allDishes.map(dish => ({ ...dish, selected: false }))
      drafts.write('menu', '', { ids: [], searchKey: '', filterMode: 'all', scrollTop: 0, requestId: '' })

      // 发送通知
      await this.sendNotification(selectedDishes, remark, orderId)

      wx.hideLoading()
      // 显示成功弹窗
      this.setData({
        showSuccess: true,
        submitting: false
      })

    } catch (e) {
      wx.hideLoading()
      console.error('点菜失败', e)
      if ((e.message || '').includes('上一次餐单')) wx.showModal({ title: '请先核对餐单', content: e.message, showCancel: false })
      else wx.showToast({ title: e.message || '点菜失败，请重试', icon: 'none' })
      this.setData({ submitting: false })
    }
  },

  // 发送通知
  async sendNotification(dishes, remark, orderId) {
    if (!app.isBound() || !app.globalData.notifyTmplIds.length) return
    const dishNames = dishes.map(d => d.name).join('、')
    try {
      await app.callFunction({
        name: 'sendNotify',
        data: {
          type: 'newOrder',
          templateId: app.globalData.notifyTmplIds[0],
          dishNames,
          count: dishes.length,
          remark,
          orderId
        }
      })
    } catch (e) {
      console.log('通知发送失败（可忽略）', e)
    }
  },

  closeSuccess() {
    this.clearCart()
    this.setData({ showSuccess: false })
  },

  // 跳转到菜品库
  goToDishes() {
    wx.navigateTo({ url: '/pages/Dishes/index' })
  },
})
