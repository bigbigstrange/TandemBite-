const app = getApp()
const Feedback = require('../../utils/feedback')
const feedback = Feedback.create(wx, app)
Page({
  data: { kitchenName: '我们的小厨房', loading: true, ready: false, error: '', dishCount: 0, recentDishes: [], todayOrder: null, recentOrder: null },
  async onShow() { await this.load(false) },
  async onPullDownRefresh() { try { await this.load(true) } finally { wx.stopPullDownRefresh() } },
  async load(force = true) {
    this.setData({ loading: true, error: '' })
    try {
      const result = await app.getView('kitchen', {}, force !== false)
      await app.convertFileURLs(result.dishes, ['imageUrl'])
      this.setData({ ready: true, kitchenName: app.getKitchenName(), dishCount: result.dishCount, recentDishes: result.dishes, todayOrder: result.todayOrder, recentOrder: result.recentOrder })
    } catch (e) { this.setData({ error: e.message }) }
    finally { this.setData({ loading: false }) }
  },
  goOrder() { wx.navigateTo({ url: '/pages/Order/index' }) },
  greetDog() { feedback.greet(this) },
  goDishes() { wx.navigateTo({ url: '/pages/Dishes/index' }) },
  goHistory() { wx.navigateTo({ url: '/pages/OrderHistory/index' }) },
  addDish() { wx.navigateTo({ url: '/pages/DishAdd/index' }) },
  dishDetail(e) { wx.navigateTo({ url: '/pages/DishDetail/index?id=' + e.currentTarget.dataset.id }) },
  orderDetail(e) { wx.navigateTo({ url: '/pages/OrderDetail/index?id=' + e.currentTarget.dataset.id }) }
})
