const crypto = require('crypto')
const D = require('./domain')

// 分页复制、最后事务切换。源内容只锁定，不删除；重试不重复生成副本。
module.exports = function transitions(db) {
  const collections = ['Category', 'DishList', 'OrderList', 'LedgerEntry']
  const randomId = prefix => prefix + crypto.randomBytes(16).toString('hex')
  async function doc(store, collection, id) {
    try { return (await store.collection(collection).doc(id).get()).data || null }
    catch (e) { if (/not exist|not found|不存在|DOCUMENT_NOT_FOUND/i.test(e.message || e.errMsg || '')) return null; throw e }
  }
  function flags(members) { return Object.fromEntries(members.map(id => [D.memberKey(id), true])) }
  function kitchen(members, name, status = 'active') { return { members, ...flags(members), name, type: members.length === 2 ? 'shared' : 'solo', status, schemaVersion: 3, createTime: db.serverDate() } }
  async function user(store, id) { const result = await doc(store, 'User', id); if (!result) throw new Error('请返回首页重新加载账号'); return result }
  function authorize(job, openid) { if (!job || !job.members.includes(openid)) throw new Error('无权整理这些内容') }
  function response(job) { return { transitionId: job._id, done: job.status === 'done', processed: job.processed || 0, pending: job.pending ? { existing: brief(job.pending.existing), incoming: brief(job.pending.incoming) } : null } }
  function brief(entry) { return { amountFen: entry.amountFen, dateKey: entry.dateKey, note: entry.note, category: entry.category, updatedByName: entry.updatedByName || entry.creatorName || '伙伴' } }
  async function sourcesFor(members) {
    const ids = new Set()
    for (const id of members) {
      const u = await user(db, id)
      if (u.schemaVersion === 3 && u.kitchenId) { ids.add(u.kitchenId); continue }
      if (await doc(db, 'Kitchen', D.personalId(id))) ids.add(D.personalId(id))
      const legacy = await db.collection('Kitchen').where({ [D.memberKey(id)]: true }).limit(100).get()
      for (const k of legacy.data) if (['active', 'closed'].includes(k.status)) ids.add(k._id)
      if (u.coupleId && u.partnerId && !await doc(db, 'Kitchen', u.coupleId)) {
        await db.runTransaction(async tx => {
          const latest = await user(tx, id), partner = await user(tx, u.partnerId)
          if (latest.coupleId !== u.coupleId || partner.coupleId !== u.coupleId || partner.partnerId !== id) throw new Error('绑定状态已经变化，请刷新')
          if (!await doc(tx, 'Kitchen', u.coupleId)) await tx.collection('Kitchen').doc(u.coupleId).set({ data: kitchen([id, u.partnerId], u.kitchenName || '我们的小厨房') })
        })
        ids.add(u.coupleId)
      }
    }
    return [...ids]
  }
  async function start(kind, members, sourceIds, openid) {
    const jobId = randomId('transition_')
    const targets = kind === 'split'
      ? members.map(id => ({ id: randomId('k_'), members: [id] }))
      : [{ id: randomId('k_'), members }]
    return db.runTransaction(async tx => {
      const users = []
      for (const id of members) users.push(await user(tx, id))
      for (const u of users) if (u.pendingTransitionId) {
        const previous = await doc(tx, 'KitchenTransition', u.pendingTransitionId)
        authorize(previous, openid)
        return response(previous)
      }
      if (kind === 'bind' && users.some(u => u.partnerId || u.bindStatus === 'bound')) throw new Error('你或对方已经绑定，请刷新状态')
      if (['split', 'upgradeShared'].includes(kind) && (users[0].partnerId !== members[1] || users[1].partnerId !== members[0] || users[0].coupleId !== users[1].coupleId)) throw new Error('绑定状态已变化，请刷新')
      if (kind === 'upgradeSolo' && users[0].partnerId) throw new Error('绑定状态已变化，请刷新')
      for (const id of sourceIds) {
        const source = await doc(tx, 'Kitchen', id)
        if (!source || !source.members.some(member => members.includes(member)) || !['active', 'closed'].includes(source.status)) throw new Error('厨房正在整理，请稍后重试')
        await tx.collection('Kitchen').doc(id).update({ data: { status: 'locked', transitionId: jobId } })
      }
      for (const target of targets) await tx.collection('Kitchen').doc(target.id).set({ data: kitchen(target.members, '我们的小厨房', 'building') })
      const data = { kind, members, sourceIds, targets, status: 'copying', sourceIndex: 0, collectionIndex: 0, skip: 0, targetIndex: 0, processed: 0, pending: null, createTime: db.serverDate() }
      await tx.collection('KitchenTransition').doc(jobId).set({ data })
      for (const id of members) await tx.collection('User').doc(id).update({ data: { pendingTransitionId: jobId } })
      return response({ _id: jobId, ...data })
    })
  }
  async function bootstrap(openid, knownUser) {
    const u = knownUser || await user(db, openid)
    if (u.pendingTransitionId) { const job = await doc(db, 'KitchenTransition', u.pendingTransitionId); authorize(job, openid); return { transition: response(job) } }
    if (u.schemaVersion === 3 && u.kitchenId) {
      const k = await doc(db, 'Kitchen', u.kitchenId)
      if (!D.isMember(k, openid) || k.status !== 'active') throw new Error('厨房状态已变化，请刷新')
      return { kitchenId: k._id, kitchens: [{ ...k, readOnly: false }] }
    }
    const members = u.partnerId && u.bindStatus === 'bound' ? [openid, u.partnerId] : [openid]
    const sources = await sourcesFor(members)
    return { transition: await start(members.length === 2 ? 'upgradeShared' : 'upgradeSolo', members, sources, openid) }
  }
  async function bind(inviteCode, openid) {
    if (typeof inviteCode !== 'string' || !/^[A-Z2-9]{6}$/.test(inviteCode.toUpperCase())) throw new Error('请输入6位邀请码')
    const found = await db.collection('User').where({ inviteCode: inviteCode.toUpperCase() }).limit(1).get()
    const partnerId = found.data[0]?._id
    if (!partnerId || partnerId === openid) throw new Error(partnerId ? '不能绑定自己' : '邀请码不存在')
    const members = [openid, partnerId]
    return { transition: await start('bind', members, await sourcesFor(members), openid) }
  }
  async function split(openid) {
    const u = await user(db, openid)
    if (u.pendingTransitionId) { const job = await doc(db, 'KitchenTransition', u.pendingTransitionId); authorize(job, openid); return { transition: response(job) } }
    if (!u.partnerId || !u.kitchenId) throw new Error('当前没有绑定关系')
    return { transition: await start('split', [openid, u.partnerId], [u.kitchenId], openid) }
  }
  const origin = item => item.originId || item.sourceId || item._id
  const targetId = (target, collection, original) => 'record_' + D.hash(target + ':' + collection + ':' + original)
  const categoryId = (target, name) => 'category_' + D.hash(target + ':' + name.trim())
  function signature(collection, item) {
    const keys = collection === 'DishList' ? ['name', 'description', 'imageUrl', 'ingredients', 'steps', 'cookTime', 'difficulty'] : collection === 'OrderList' ? ['dishes', 'remark', 'finishedPhoto', 'completed', 'marked', 'createTime'] : ['amountFen', 'type', 'category', 'dateKey', 'note', 'deleted', 'creatorId']
    return D.hash(JSON.stringify(keys.map(key => item[key] ?? null)))
  }
  async function categoryName(sourceId, id) {
    const cat = id && await doc(db, 'Category', id)
    if (cat?.coupleId === sourceId) return cat.name.trim()
    return D.DEFAULT_CATEGORIES.find(c => c[0] === id)?.[1] || '未分类'
  }
  async function prepare(collection, item, sourceId, target) {
    const { _id, ...rest } = item
    const data = { ...rest, originId: origin(item), migratedFrom: _id }
    let id = targetId(target, collection, data.originId), category = null
    if (collection === 'LedgerEntry') data.bookId = target
    else { data.coupleId = target; data.kitchenId = target }
    if (collection === 'Category') { data.name = (data.name || '未分类').trim(); id = categoryId(target, data.name); delete data.deleting; delete data.transferTo }
    if (collection === 'DishList') {
      const name = await categoryName(sourceId, item.category)
      data.category = categoryId(target, name)
      category = { id: data.category, data: { name, icon: '🍽️', coupleId: target, sort: 999, createTime: db.serverDate() } }
    }
    if (collection === 'OrderList') {
      data.dishes = []
      for (const selected of item.dishes || []) {
        const originalDish = await doc(db, 'DishList', selected._id)
        let dishId = targetId(target, 'DishList', originalDish ? origin(originalDish) : selected._id)
        if (originalDish) {
          const first = await doc(db, 'DishList', dishId)
          if (first && signature('DishList', first) !== signature('DishList', originalDish)) dishId += '_' + signature('DishList', originalDish)
        }
        data.dishes.push({ ...selected, _id: dishId })
      }
    }
    return { id, data, category }
  }
  function advance(job) {
    const targetIndex = job.targetIndex + 1
    return { pending: null, processed: job.processed + 1, targetIndex: targetIndex === job.targets.length ? 0 : targetIndex, skip: job.skip + (targetIndex === job.targets.length ? 1 : 0) }
  }
  async function finish(job, openid) {
    return db.runTransaction(async tx => {
      const latest = await doc(tx, 'KitchenTransition', job._id); authorize(latest, openid)
      if (latest.status === 'done') return response(latest)
      if (latest.sourceIndex < latest.sourceIds.length) throw new Error('整理尚未完成，请继续')
      for (const target of latest.targets) await tx.collection('Kitchen').doc(target.id).update({ data: { status: 'active' } })
      for (const sourceId of latest.sourceIds) await tx.collection('Kitchen').doc(sourceId).update({ data: { status: 'merged', mergedAt: db.serverDate() } })
      for (const id of latest.members) {
        const u = await user(tx, id)
        if (u.pendingTransitionId !== latest._id) throw new Error('账号整理状态已变化')
        const target = latest.targets.find(t => t.members.includes(id))
        const other = target.members.find(member => member !== id) || ''
        await tx.collection('User').doc(id).update({ data: { kitchenId: target.id, schemaVersion: 3, pendingTransitionId: '', partnerId: other, coupleId: other ? target.id : '', bindStatus: other ? 'bound' : 'unbound', ...(latest.kind === 'bind' ? { bindTime: db.serverDate() } : {}) } })
      }
      await tx.collection('KitchenTransition').doc(latest._id).update({ data: { status: 'done', finishedTime: db.serverDate() } })
      return response({ ...latest, status: 'done' })
    })
  }
  async function resume(jobId, openid) {
    for (let step = 0; step < 5; step++) {
      const job = await doc(db, 'KitchenTransition', jobId); authorize(job, openid)
      if (job.status === 'done' || job.pending) return response(job)
      if (job.sourceIndex >= job.sourceIds.length) return finish(job, openid)
      const collection = collections[job.collectionIndex], sourceId = job.sourceIds[job.sourceIndex]
      const result = await db.collection(collection).where({ [collection === 'LedgerEntry' ? 'bookId' : 'coupleId']: sourceId }).orderBy('_id', 'asc').skip(job.skip).limit(1).get()
      const item = result.data[0]
      const prepared = item ? await prepare(collection, item, sourceId, job.targets[job.targetIndex].id) : null
      await db.runTransaction(async tx => {
        const current = await doc(tx, 'KitchenTransition', jobId); authorize(current, openid)
        if (current.status === 'done' || current.pending || current.sourceIndex !== job.sourceIndex || current.collectionIndex !== job.collectionIndex || current.skip !== job.skip || current.targetIndex !== job.targetIndex) return
        if (!item) {
          const collectionIndex = job.collectionIndex + 1
          await tx.collection('KitchenTransition').doc(jobId).update({ data: { skip: 0, targetIndex: 0, collectionIndex: collectionIndex === collections.length ? 0 : collectionIndex, sourceIndex: job.sourceIndex + (collectionIndex === collections.length ? 1 : 0) } })
          return
        }
        const previous = await doc(tx, collection, prepared.id)
        if (previous && collection === 'LedgerEntry' && signature(collection, previous) !== signature(collection, prepared.data)) {
          await tx.collection('KitchenTransition').doc(jobId).update({ data: { pending: { id: prepared.id, incoming: prepared.data, existing: previous } } })
          return
        }
        if (prepared.category && !await doc(tx, 'Category', prepared.category.id)) await tx.collection('Category').doc(prepared.category.id).set({ data: prepared.category.data })
        if (!previous) await tx.collection(collection).doc(prepared.id).set({ data: prepared.data })
        else if (collection !== 'Category' && collection !== 'LedgerEntry' && signature(collection, previous) !== signature(collection, prepared.data)) {
          await tx.collection(collection).doc(prepared.id + '_' + signature(collection, prepared.data)).set({ data: { ...prepared.data, originId: prepared.data.originId + ':' + signature(collection, prepared.data) } })
        } else if (collection === 'LedgerEntry' && previous.version < prepared.data.version) await tx.collection(collection).doc(prepared.id).update({ data: { version: prepared.data.version } })
        else if (collection === 'DishList') await tx.collection(collection).doc(prepared.id).update({ data: { favorite: !!(previous.favorite || prepared.data.favorite), orderCount: Math.max(previous.orderCount || 0, prepared.data.orderCount || 0) } })
        if (collection === 'LedgerEntry') await tx.collection('LedgerChange').doc(prepared.id + '_migration_' + D.hash(sourceId)).set({ data: { entryId: prepared.id, bookId: prepared.data.bookId, actorId: openid, action: 'merge', before: item, time: db.serverDate() } })
        await tx.collection('KitchenTransition').doc(jobId).update({ data: advance(job) })
      })
    }
    const latest = await doc(db, 'KitchenTransition', jobId); authorize(latest, openid); return response(latest)
  }
  async function resolve(jobId, choice, openid) {
    if (!['existing', 'incoming', 'both'].includes(choice)) throw new Error('请选择要保留的账目版本')
    return db.runTransaction(async tx => {
      const job = await doc(tx, 'KitchenTransition', jobId); authorize(job, openid)
      if (!job.pending) return response(job)
      const { id, incoming, existing } = job.pending
      if (choice === 'incoming') await tx.collection('LedgerEntry').doc(id).set({ data: incoming })
      if (choice === 'both') {
        const suffix = signature('LedgerEntry', incoming)
        await tx.collection('LedgerEntry').doc(id + '_' + suffix).set({ data: { ...incoming, originId: incoming.originId + ':' + suffix } })
      }
      await tx.collection('LedgerChange').doc(id + '_choice_' + D.hash(jobId)).set({ data: { entryId: id, bookId: incoming.bookId, actorId: openid, action: 'mergeChoice', choice, existing, incoming, time: db.serverDate() } })
      const changes = advance(job)
      await tx.collection('KitchenTransition').doc(jobId).update({ data: changes })
      return response({ ...job, ...changes })
    })
  }
  return { bootstrap, bind, split, resume, resolve }
}
