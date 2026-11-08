const app = getApp()
const L = require('../../utils/ledger')
const Feedback = require('../../utils/feedback')
const feedback = Feedback.create(wx, app)
Page({
  data: { loading: true, ready: false, error: '', isBound: false, kitchenName: '', todayText: '', month: '', todayOrder: null, expenseText: '0.00', incomeText: '0.00' },
  onLoad(options) { if (options.inviteCode) app.globalData.pendingInviteCode = options.inviteCode },
  async onShow() { return this.load(false) },
  async onPullDownRefresh() { try { await this.load(true) } finally { wx.stopPullDownRefresh() } },
  async load(force = false) {
    this.setData({ loading: true, error: '' })
    try {
      const month = L.dateKey().slice(0, 7)
      const result = await app.getView('home', { month }, force)
      if (result.todayOrder) await app.convertFileURLs(result.todayOrder.dishes || [], ['imageUrl'])
      this.setData({ isBound: app.isBound(), kitchenName: app.getKitchenName(), todayText: L.dateKey().replace(/-/g, '.'), month })
      this.setData({ ready: true, todayOrder: result.todayOrder, todayPreviewDishes: (result.todayOrder?.dishes || []).slice(0, 3), ...L.totals(result.groups) })
      wx.setNavigationBarTitle({ title: 'TandemBite 伴食' })
      if (app.globalData.pendingInviteCode && !app.isBound()) wx.navigateTo({ url: '/pages/Bind/index' })
    } catch (e) { this.setData({ error: e.message }) }
    finally { this.setData({ loading: false }) }
  },
  goToOrder() { wx.navigateTo({ url: '/pages/Order/index' }) },
  greetDog() { feedback.greet(this) },
  addDish() { wx.navigateTo({ url: '/pages/DishAdd/index' }) },
  addEntry() { wx.navigateTo({ url: '/pages/LedgerEdit/index' }) },
  goLedger() { wx.switchTab({ url: '/pages/Ledger/index' }) },
  goToHistory() { wx.navigateTo({ url: '/pages/OrderHistory/index' }) },
  goToTodayOrder() { if (this.data.todayOrder) wx.navigateTo({ url: '/pages/OrderDetail/index?id=' + this.data.todayOrder._id }) },
  goToBind() { wx.navigateTo({ url: '/pages/Bind/index' }) },
  goKitchen() { wx.switchTab({ url: '/pages/Kitchen/index' }) }
})
