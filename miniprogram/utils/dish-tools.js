function create(wx, app) {
  async function preview(imageUrl) {
    if (!imageUrl) return
    const urls = await app.getTempFileURLs([imageUrl])
    const current = urls[imageUrl] || imageUrl
    wx.previewImage({ current, urls: [current] })
  }
  async function favorite(page, id, source) {
    if (page._favoriteBusy) return
    const dish = source.find(item => item._id === id)
    if (!dish) return
    page._favoriteBusy = true
    try {
      const value = !dish.favorite
      const result = await app.callFunction({ name: 'updateCoupleData', data: { collection: 'DishList', docId: id, action: 'update', data: { favorite: value } } })
      if (!result.result?.success) throw new Error(result.result?.message || '收藏未保存，请重试')
      dish.favorite = value
      wx.showToast({ title: value ? '已加入共同收藏' : '已取消收藏', icon: 'none' })
      return value
    } finally { page._favoriteBusy = false }
  }
  function filter(dishes, search, mode) {
    let list = dishes.filter(dish => !search || dish.name.toLowerCase().includes(search.toLowerCase()) || (dish.description || '').includes(search))
    if (mode === 'favorite') list = list.filter(dish => dish.favorite)
    if (mode === 'frequent') list = list.filter(dish => dish.orderCount > 0).sort((a, b) => b.orderCount - a.orderCount || a.name.localeCompare(b.name))
    return list
  }
  return { preview, favorite, filter }
}
module.exports = { create }
