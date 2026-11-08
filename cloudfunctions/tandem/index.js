const cloud = require('wx-server-sdk')
const D = require('./domain')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const transitions = require('./transitions')(db)
const _ = db.command
const FOOD = ['DishList', 'OrderList']
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
async function optional(store, collection, id) {
  try { return (await store.collection(collection).doc(id).get()).data || null }
  catch (e) {
    if (/not exist|not found|不存在|DOCUMENT_NOT_FOUND/i.test(e.errMsg || e.message || '')) return null
    throw e
  }
}
async function getUser(store, id) {
  const user = await optional(store, 'User', id)
  if (!user) throw new Error('请返回首页重新加载账号')
  return user
}
async function getKitchen(store, id, openid, write = false) {
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('请选择厨房或账本')
  const kitchen = await optional(store, 'Kitchen', id)
  if (!D.isMember(kitchen, openid)) throw new Error('无权访问这个厨房或账本')
  const user = await getUser(store, openid)
  if (user.pendingTransitionId) throw new Error('正在整理厨房内容，请返回首页继续')
  if (user.schemaVersion === 3 && user.kitchenId !== id) throw new Error('厨房已更新，请刷新后重试')
  if (['locked', 'building', 'merged'].includes(kitchen.status)) throw new Error('厨房内容正在整理，请返回首页继续')
  if (write) {
    if (kitchen.status !== 'active') throw new Error('历史共享记录已经封存，只能查看')
    if (kitchen.type === 'shared') {
      // 同时读取关系双方：旧版解绑、并发解绑都不能继续写入已结束的共享空间。
      for (const member of kitchen.members) {
        const user = await getUser(store, member)
        if (user.coupleId !== id || user.bindStatus !== 'bound') throw new Error('绑定关系已变化，请重新打开页面')
      }
    }
  }
  return kitchen
}
function foodFields(collection, input, creating) {
  const allowed = collection === 'DishList'
    ? ['name', 'description', 'imageUrl', 'category', 'ingredients', 'steps', 'cookTime', 'difficulty', 'recipeUpdateTime', 'updateTime', 'favorite']
    : ['remark', 'marked', 'finishedPhoto', 'completed']
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('操作内容不正确')
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error('不允许修改归属信息或无效字段')
  const result = {}
  for (const key of allowed) if (own(input, key)) {
    if (['marked', 'completed', 'favorite'].includes(key)) {
      if (typeof input[key] !== 'boolean') throw new Error('状态不正确')
    } else if (typeof input[key] !== 'string' && !['updateTime', 'recipeUpdateTime'].includes(key)) throw new Error('字段格式不正确')
    if (typeof input[key] === 'string' && input[key].length > (['ingredients', 'steps'].includes(key) ? 10000 : 1200)) throw new Error('内容过长')
    result[key] = ['updateTime', 'recipeUpdateTime'].includes(key) ? db.serverDate() : input[key]
  }
  if (collection === 'DishList' && ((creating && !result.name?.trim()) || (own(result, 'name') && (!result.name.trim() || result.name.length > 20)))) throw new Error('菜名为1到20个字')
  return result
}
async function foodRead(e, openid, authorized = false) {
  if (!FOOD.includes(e.collection)) throw new Error('不支持的查询')
  if (!authorized) await getKitchen(db, e.kitchenId, openid)
  if (e.docId) {
    const doc = await optional(db, e.collection, e.docId)
    if (!doc || doc.coupleId !== e.kitchenId) throw new Error('记录不存在或无权访问')
    return { data: doc }
  }
  const limit = e.limit === undefined ? 100 : e.limit, skip = e.skip || 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(skip) || skip < 0) throw new Error('分页参数不正确')
  const where = { coupleId: e.kitchenId }
  if (e.todayOnly) {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    where.createTime = _.gte(new Date(today + 'T00:00:00+08:00'))
  }
  if (e.countOnly) return { total: (await db.collection(e.collection).where(where).count()).total }
  const orderBy = ['createTime', 'name', 'orderCount'].includes(e.orderBy) ? e.orderBy : 'createTime'
  const res = await db.collection(e.collection).where(where).orderBy(orderBy, e.order === 'asc' ? 'asc' : 'desc').skip(skip).limit(limit).get()
  return { data: res.data, total: res.data.length }
}
async function foodWrite(e, openid) {
  if (!FOOD.includes(e.collection)) throw new Error('不支持的操作')
  return db.runTransaction(async tx => {
    await getKitchen(tx, e.kitchenId, openid, true)
    const col = tx.collection(e.collection)
    if (e.action === 'add') {
      const id = 'item_' + D.hash(openid + ':' + token(e.requestId))
      const previous = await optional(tx, e.collection, id)
      if (previous) {
        if (previous.coupleId !== e.kitchenId) throw new Error('请求已用于另一个厨房')
        if (e.collection === 'DishList') {
          const requested = foodFields(e.collection, e.data, true)
          if (Object.keys(requested).some(key => !['updateTime', 'recipeUpdateTime'].includes(key) && requested[key] !== previous[key])) throw new Error('上一次菜品已经保存，请到菜品库核对后再编辑')
        } else if (previous.remark !== e.data?.remark || JSON.stringify(previous.dishes.map(d => d._id)) !== JSON.stringify(e.data?.dishes?.map(d => d._id))) throw new Error('上一次餐单已经保存，请到做饭记录核对后再修改')
        return { _id: id }
      }
      let data
      if (e.collection === 'DishList') {
        data = foodFields(e.collection, e.data, true)
        const category = await optional(tx, 'Category', data.category)
        if (!category || category.coupleId !== e.kitchenId || category.deleting) throw new Error('请选择当前厨房的有效分类')
      } else {
        if (!Array.isArray(e.data?.dishes) || e.data.dishes.length < 1 || e.data.dishes.length > 100 || typeof e.data.remark !== 'string' || e.data.remark.length > 100) throw new Error('餐单内容不正确')
        const dishes = []
        for (const selected of e.data.dishes) {
          const dish = await optional(tx, 'DishList', selected._id)
          if (!dish || dish.coupleId !== e.kitchenId) throw new Error('所选菜品已变化，请刷新菜单')
          dishes.push({ _id: dish._id, name: dish.name, imageUrl: dish.imageUrl || '', category: dish.category })
        }
        data = { dishes, remark: e.data.remark, completed: false }
      }
      await col.doc(id).set({ data: { ...data, coupleId: e.kitchenId, kitchenId: e.kitchenId, _openid: openid, createTime: db.serverDate() } })
      if (e.collection === 'OrderList' && e.countDishes === true) for (const dishId of new Set(data.dishes.map(d => d._id))) await tx.collection('DishList').doc(dishId).update({ data: { orderCount: _.inc(1) } })
      return { _id: id }
    }
    if (typeof e.docId !== 'string' || !e.docId) throw new Error('缺少记录编号')
    const doc = await optional(tx, e.collection, e.docId)
    if (!doc || doc.coupleId !== e.kitchenId) throw new Error('无权操作这条记录')
    if (e.expectedRevision !== undefined) {
      const revision = Math.max(...['createTime', 'updateTime', 'recipeUpdateTime'].map(field => new Date(doc[field] || 0).getTime() || 0)).toString()
      if (typeof e.expectedRevision !== 'string' || e.expectedRevision !== revision) throw new Error('这道菜已被修改，请重新加载后再保存，草稿仍保留')
    }
    if (e.action === 'remove') { await col.doc(e.docId).remove(); return { removed: 1 } }
    if (e.action === 'inc') {
      if (e.collection !== 'DishList' || Object.keys(e.data || {}).length !== 1 || !Number.isSafeInteger(e.data.orderCount) || e.data.orderCount < 1) throw new Error('点菜次数不正确')
      await col.doc(e.docId).update({ data: { orderCount: _.inc(e.data.orderCount) } })
    } else if (e.action === 'update') {
      const data = foodFields(e.collection, e.data, false)
      if (data.category) {
        const category = await optional(tx, 'Category', data.category)
        if (!category || category.coupleId !== e.kitchenId || category.deleting) throw new Error('分类不属于当前厨房或正在转移')
      }
      await col.doc(e.docId).update({ data: { ...data, updateTime: db.serverDate() } })
    } else throw new Error('不支持的操作')
    return { updated: 1 }
  })
}
function token(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new Error('请求编号无效，请重新打开表单')
  return value
}
async function category(e, openid, authorized = false) {
  const write = !['list', 'ready', 'countDishes'].includes(e.action)
  if (!authorized) await getKitchen(db, e.kitchenId, openid, write)
  const col = db.collection('Category'), data = e.data || {}
  if (e.action === 'ready') {
    let result = await col.where({ coupleId: e.kitchenId }).orderBy('sort', 'asc').limit(100).get()
    if (!result.data.length) {
      await category({ kitchenId: e.kitchenId, action: 'init' }, openid)
      result = await col.where({ coupleId: e.kitchenId }).orderBy('sort', 'asc').limit(100).get()
    }
    return { data: result.data }
  }
  if (e.action === 'list') return { data: (await col.where({ coupleId: e.kitchenId }).orderBy('sort', 'asc').limit(100).get()).data }
  if (e.action === 'countDishes') return { count: (await db.collection('DishList').where({ coupleId: e.kitchenId, category: data._id }).count()).total }
  if (e.action === 'init') {
    if ((await col.where({ coupleId: e.kitchenId }).count()).total) return {}
    await db.runTransaction(async tx => {
      const kitchen = await getKitchen(tx, e.kitchenId, openid, true)
      if (kitchen.categoriesInitialized) return
      for (let i = 0; i < D.DEFAULT_CATEGORIES.length; i++) {
        const [legacy, name, icon] = D.DEFAULT_CATEGORIES[i], id = 'cat_' + D.hash(e.kitchenId + ':' + legacy)
        await tx.collection('Category').doc(id).set({ data: { coupleId: e.kitchenId, name, icon, sort: i, _openid: openid, createTime: db.serverDate() } })
      }
      await tx.collection('Kitchen').doc(e.kitchenId).update({ data: { categoriesInitialized: true } })
    })
    for (const [legacy] of D.DEFAULT_CATEGORIES) {
      const id = 'cat_' + D.hash(e.kitchenId + ':' + legacy)
      await db.collection('DishList').where({ coupleId: e.kitchenId, category: legacy }).update({ data: { category: id } })
    }
    return {}
  }
  return db.runTransaction(async tx => {
    await getKitchen(tx, e.kitchenId, openid, true)
    if (e.action === 'reorder') {
      if (!Array.isArray(data.orders) || data.orders.length > 100) throw new Error('排序内容不正确')
      for (const item of data.orders) {
        const cat = await optional(tx, 'Category', item._id)
        if (!cat || cat.coupleId !== e.kitchenId || !Number.isSafeInteger(item.sort) || item.sort < 0) throw new Error('分类不属于当前厨房')
        await tx.collection('Category').doc(item._id).update({ data: { sort: item.sort } })
      }
      return {}
    }
    if (['add', 'update'].includes(e.action) && (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 6 || typeof data.icon !== 'string' || data.icon.length > 12)) throw new Error('分类名称为1到6个字')
    if (e.action === 'add') {
      const res = await tx.collection('Category').add({ data: { name: data.name.trim(), icon: data.icon, sort: Date.now(), coupleId: e.kitchenId, _openid: openid, createTime: db.serverDate() } })
      return { _id: res._id }
    }
    const cat = await optional(tx, 'Category', data._id)
    if (!cat || cat.coupleId !== e.kitchenId) throw new Error('分类不属于当前厨房')
    if (e.action === 'update') {
      if (cat.deleting) throw new Error('分类正在转移，请先完成删除')
      await tx.collection('Category').doc(data._id).update({ data: { name: data.name.trim(), icon: data.icon } })
    }
    else if (e.action === 'remove') {
      // 转移可能涉及很多菜；先验证目标，再分批执行，失败可安全重试。
      throw new Error('REMOVE_CATEGORY_OUTSIDE_TRANSACTION')
    } else throw new Error('不支持的分类操作')
    return {}
  }).catch(async error => {
    if (error.message !== 'REMOVE_CATEGORY_OUTSIDE_TRANSACTION') throw error
    if ((await col.where({ coupleId: e.kitchenId }).count()).total <= 1) throw new Error('至少保留一个分类')
    const count = (await db.collection('DishList').where({ coupleId: e.kitchenId, category: data._id }).count()).total
    await db.runTransaction(async tx => {
      await getKitchen(tx, e.kitchenId, openid, true)
      const source = await optional(tx, 'Category', data._id)
      if (!source || source.coupleId !== e.kitchenId) throw new Error('分类已变化，请刷新')
      if (count || data.transferTo) {
        const target = await optional(tx, 'Category', data.transferTo)
        if (!target || target._id === data._id || target.coupleId !== e.kitchenId || target.deleting) throw new Error('请选择当前厨房的有效转移分类')
      }
      await tx.collection('Category').doc(data._id).update({ data: { deleting: true, transferTo: data.transferTo || '' } })
    })
    while (true) {
      const batch = await db.collection('DishList').where({ coupleId: e.kitchenId, category: data._id }).limit(10).get()
      if (!batch.data.length) break
      if (!data.transferTo) throw new Error('分类下新增了菜品，请选择转移分类后重试')
      for (const dish of batch.data) await db.runTransaction(async tx => {
        await getKitchen(tx, e.kitchenId, openid, true)
        const target = await optional(tx, 'Category', data.transferTo)
        if (!target || target.coupleId !== e.kitchenId || target.deleting) throw new Error('转移目标已变化，请刷新')
        await tx.collection('DishList').doc(dish._id).update({ data: { category: data.transferTo } })
      })
    }
    await db.runTransaction(async tx => { await getKitchen(tx, e.kitchenId, openid, true); await tx.collection('Category').doc(data._id).remove() })
    return {}
  })
}
async function ledger(e, openid, authorizedKitchen) {
  const bookId = e.bookId
  const kitchen = authorizedKitchen || await getKitchen(db, bookId, openid)
  if (['list', 'stats'].includes(e.action)) {
    const filter = D.ledgerFilter(e)
    const where = { bookId, dateKey: _.gte(filter.start).and(filter.inclusive ? _.lte(filter.end) : _.lt(filter.end)), deleted: e.deleted === true }
    if (filter.categories) { where.type = 'expense'; where.category = _.in(filter.categories) }
    if (e.action === 'stats') {
      const $ = _.aggregate
      const [res, people] = await Promise.all([
        db.collection('LedgerEntry').aggregate().match({ ...where, deleted: false }).group({ _id: { type: '$type', category: '$category' }, amountFen: $.sum('$amountFen'), count: $.sum(1) }).limit(20).end(),
        e.includePeople === false ? Promise.resolve({ list: [] }) : db.collection('LedgerEntry').aggregate().match({ ...where, deleted: false, type: 'expense' }).group({ _id: { creatorId: '$creatorId' }, creatorName: $.first('$creatorName'), amountFen: $.sum('$amountFen') }).limit(100).end()
      ])
      return { groups: res.list, people: people.list }
    }
    const skip = e.skip || 0
    if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('分页参数不正确')
    const res = await db.collection('LedgerEntry').where(where).orderBy('dateKey', 'desc').orderBy('_id', 'asc').skip(skip).limit(50).get()
    return { data: res.data, hasMore: res.data.length === 50 }
  }
  if (e.action === 'get') {
    const doc = await optional(db, 'LedgerEntry', e.id)
    if (!doc || doc.bookId !== bookId) throw new Error('账目不存在或无权查看')
    return { data: doc, readOnly: kitchen.status !== 'active' || (kitchen.type === 'shared' && (await getUser(db, openid)).coupleId !== bookId) }
  }
  return db.runTransaction(async tx => {
    await getKitchen(tx, bookId, openid, true)
    const user = await getUser(tx, openid)
    if (e.action === 'add') {
      // 账目归属由服务端关系决定，和当前选择的厨房无关。
      if ((user.kitchenId || user.coupleId || D.personalId(openid)) !== bookId) throw new Error('厨房状态已变化，请刷新后重新记账')
      const id = 'entry_' + D.hash(openid + ':' + token(e.requestId))
      const previous = await optional(tx, 'LedgerEntry', id)
      if (previous) {
        if (previous.bookId !== bookId) throw new Error('请求编号已使用')
        const requested = D.entryData(e.data || {})
        if (Object.keys(requested).some(key => requested[key] !== previous[key])) throw new Error('上一次记账已经保存，请返回账本核对后再修改')
        return { id }
      }
      const data = { ...D.entryData(e.data || {}), bookId, creatorId: openid, creatorName: user.nickname || '新朋友', updatedBy: openid, updatedByName: user.nickname || '新朋友', version: 1, deleted: false, createTime: db.serverDate(), updateTime: db.serverDate() }
      await tx.collection('LedgerEntry').doc(id).set({ data })
      await tx.collection('LedgerChange').doc(id + '_1').set({ data: { entryId: id, bookId, actorId: openid, action: 'add', after: data, time: db.serverDate() } })
      return { id }
    }
    if (!['update', 'delete', 'restore'].includes(e.action)) throw new Error('不支持的记账操作')
    const before = await optional(tx, 'LedgerEntry', e.id)
    if (!before || before.bookId !== bookId) throw new Error('账目不存在或无权操作')
    if (!Number.isSafeInteger(e.version) || before.version !== e.version) throw new Error('这笔账已被修改，请返回刷新后重试')
    if (e.action === 'update' && before.deleted) throw new Error('请先恢复这笔账')
    const changes = e.action === 'update' ? D.entryData(e.data || {}) : { deleted: e.action === 'delete' }
    const after = { ...changes, version: before.version + 1, updatedBy: openid, updatedByName: user.nickname || '新朋友', updateTime: db.serverDate() }
    await tx.collection('LedgerEntry').doc(e.id).update({ data: after })
    await tx.collection('LedgerChange').doc(e.id + '_' + after.version).set({ data: { entryId: e.id, bookId, actorId: openid, action: e.action, before, after: { ...before, ...after }, time: db.serverDate() } })
    return { id: e.id, version: after.version }
  })
}
const views = require('./views')({ cloud, db, optional, transitions, foodRead, ledger, category })
exports.main = async (event = {}) => {
  const started = Date.now()
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '请通过微信小程序登录' }
  try {
    let result
    switch (event.op) {
      case 'session': result = await views.session(openid); break
      case 'view': result = await views.read(event, openid); break
      case 'bootstrap': result = await transitions.bootstrap(openid); break
      case 'foodRead': result = await foodRead(event, openid); break
      case 'foodWrite': result = await foodWrite(event, openid); break
      case 'category': result = await category(event, openid); break
      case 'bind': result = await transitions.bind(event.inviteCode, openid); break
      case 'unbind': result = await transitions.split(openid); break
      case 'transition': result = await transitions.resume(event.transitionId, openid); break
      case 'resolveTransition': result = await transitions.resolve(event.transitionId, event.choice, openid); break
      case 'copyKitchen': throw new Error('新版只使用一个厨房，请返回首页刷新')
      case 'ledger': result = await ledger(event, openid); break
      case 'rename': {
        if (typeof event.name !== 'string' || !event.name.trim() || event.name.length > 8) throw new Error('厨房名称为1到8个字')
        result = await db.runTransaction(async tx => { await getKitchen(tx, event.kitchenId, openid, true); await tx.collection('Kitchen').doc(event.kitchenId).update({ data: { name: event.name.trim() } }); return {} })
        break
      }
      default: throw new Error('不支持的操作')
    }
    return { success: true, ...result, serverMs: Date.now() - started }
  } catch (error) {
    console.error('tandem', event.op, error)
    return { success: false, message: error.message || '操作失败，请重试' }
  }
}
