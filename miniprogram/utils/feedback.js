function create(wx, app) {
  function hide(page) {
    if (page._feedbackTimer) clearTimeout(page._feedbackTimer)
    page._feedbackTimer = null
    if (page.data?.tbFeedbackVisible) page.setData({ tbFeedbackVisible: false })
  }
  function show(page, message, celebrate) {
    hide(page)
    page.setData({ tbFeedbackVisible: true, tbFeedbackMessage: message, tbFeedbackCelebrate: celebrate })
    page._feedbackTimer = setTimeout(() => hide(page), 1800)
  }
  function success(page, message, nextPage = false) {
    if (nextPage) {
      app.globalData.pendingCelebration = { message, kitchenId: app.globalData.kitchenId, expiresAt: Date.now() + 5000 }
    } else show(page, message, true)
  }
  function consume(page) {
    const pending = app.globalData.pendingCelebration
    if (!pending) return
    app.globalData.pendingCelebration = null
    if (pending.expiresAt >= Date.now() && pending.kitchenId === app.globalData.kitchenId) show(page, pending.message, true)
  }
  function greet(page) {
    show(page, '汪！今天也要好好吃饭。', false)
  }
  return { success, greet, consume, hide }
}
module.exports = { create }
