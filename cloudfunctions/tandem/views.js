// 每次请求重新核对身份和厨房，再并行查询；不跨请求缓存权限。
module.exports = function views({ cloud, db, optional, transitions, foodRead, ledger, category }) {
  async function attachFiles(result) {
    const files = new Set()
    const add = value => { if (typeof value === 'string' && value.startsWith('cloud://')) files.add(value) }
    add(result.user?.avatarUrl); add(result.partner?.avatarUrl)
    for (const dish of result.dishes || []) add(dish.imageUrl)
    for (const order of [...result.orders || [], result.todayOrder, result.recentOrder].filter(Boolean)) {
      add(order.finishedPhoto)
      for (const dish of order.dishes || []) add(dish.imageUrl)
    }
    result.fileList = []
    const ids = [...files]
    // 链接失败不遮住文字和金额；前端仍可使用原cloud文件ID加载图片。
    try {
      const batches = []
      for (let i = 0; i < ids.length; i += 50) batches.push(cloud.getTempFileURL({ fileList: ids.slice(i, i + 50) }))
      for (const response of await Promise.all(batches)) result.fileList.push(...response.fileList)
    } catch (e) { console.error('view image links', e.message) }
    return result
  }
  async function session(openid, withFiles = true) {
    const user = await optional(db, 'User', openid)
    if (!user) return { needsCreate: true }
    const spaces = await transitions.bootstrap(openid, user)
    if (spaces.transition) return { transition: spaces.transition }
    let partner = null
    if (user.partnerId && spaces.kitchens[0].members.includes(user.partnerId)) {
      const other = await optional(db, 'User', user.partnerId)
      if (other?.partnerId === openid && other.kitchenId === spaces.kitchenId) partner = { openid: other._id, nickname: other.nickname, avatarUrl: other.avatarUrl }
    }
    const result = { ...spaces, user, partner }
    return withFiles ? attachFiles(result) : result
  }
  async function read(event, openid) {
    if (!['home', 'kitchen', 'menu', 'history', 'ledger', 'settings'].includes(event.screen)) throw new Error('不支持的页面')
    const result = await session(openid, false)
    if (result.needsCreate || result.transition) return result
    const kitchenId = result.kitchenId, kitchen = result.kitchens[0], p = event.params || {}
    const food = (collection, options = {}) => foodRead({ collection, kitchenId, ...options }, openid, true)
    if (event.screen === 'home') {
      const [orders, stats] = await Promise.all([
        food('OrderList', { todayOnly: true, limit: 1 }),
        ledger({ bookId: kitchenId, month: p.month, action: 'stats', includePeople: false }, openid, kitchen)
      ])
      Object.assign(result, { todayOrder: orders.data[0] || null, groups: stats.groups })
    } else if (event.screen === 'kitchen') {
      const [count, dishes, today, recent] = await Promise.all([
        food('DishList', { countOnly: true }), food('DishList', { limit: 3 }),
        food('OrderList', { todayOnly: true, limit: 1 }), food('OrderList', { limit: 1 })
      ])
      Object.assign(result, { dishCount: count.total, dishes: dishes.data, todayOrder: today.data[0] || null, recentOrder: recent.data[0] || null })
    } else if (event.screen === 'menu') {
      const [dishes, categories] = await Promise.all([
        food('DishList', { limit: 100 }), category({ action: 'ready', kitchenId }, openid, true)
      ])
      // 菜谱正文只在详情页读取，避免菜单向视图层重复传输长文本。
      const summary = dish => Object.fromEntries(['_id', 'name', 'description', 'imageUrl', 'category', 'orderCount', 'favorite', 'createTime', '_openid'].filter(key => dish[key] !== undefined).map(key => [key, dish[key]]))
      Object.assign(result, { dishes: dishes.data.map(summary), categories: categories.data })
    } else if (event.screen === 'history') {
      const orders = await food('OrderList', { skip: p.skip || 0, limit: p.limit || 10 })
      result.orders = orders.data
    } else if (event.screen === 'ledger') {
      const query = { bookId: kitchenId, month: p.month, startDate: p.startDate, endDate: p.endDate, categories: p.categories, deleted: p.deleted, skip: p.skip || 0 }
      const [list, stats] = await Promise.all([
        ledger({ ...query, action: 'list' }, openid, kitchen),
        p.includeStats === false ? null : ledger({ ...query, action: 'stats' }, openid, kitchen)
      ])
      Object.assign(result, list, stats || {})
    } else {
      const [dishes, orders] = await Promise.all([food('DishList', { countOnly: true }), food('OrderList', { countOnly: true })])
      Object.assign(result, { dishCount: dishes.total, orderCount: orders.total })
    }
    return attachFiles(result)
  }
  return { session, read }
}
