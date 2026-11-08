const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./helpers/tandem-fixture.cjs')
const D = require('../cloudfunctions/tandem/domain')
const L = require('../miniprogram/utils/ledger')
const entry = (extra = {}) => ({ amount: '12.34', type: 'expense', category: '买菜食材', dateKey: '2026-11-02', note: '食材', ...extra })
async function init(f, name) {
  const result = await f.complete(name, { op: 'bootstrap' }); assert(result.success, result.message)
  const kitchenId = result.kitchenId
  assert((await f.call(name, { op: 'category', action: 'init', kitchenId })).success)
  return kitchenId
}
async function dish(f, name, kitchenId, title = '番茄炒蛋') {
  const categories = await f.call(name, { op: 'category', action: 'list', kitchenId })
  const result = await f.call(name, { op: 'foodWrite', action: 'add', collection: 'DishList', kitchenId, requestId: 'dish_' + name + '_' + Date.now(), data: { name: title, category: categories.data[0]._id, imageUrl: 'cloud://env/user-photo.jpg' } })
  assert(result.success, result.message); return result._id
}
async function addEntry(f, name, bookId, requestId, data = entry()) {
  const result = await f.call(name, { op: 'ledger', action: 'add', bookId, requestId, data }); assert(result.success, result.message); return result.id
}
const rows = (f, collection, id) => [...f.col(collection).values()].filter(x => x[collection === 'LedgerEntry' ? 'bookId' : 'coupleId'] === id)

test('重新合并时不同修改的菜谱都保留，做饭记录仍对应各自菜谱', async () => {
  const f = fixture(), a = await init(f, 'alice'); await init(f, 'bob')
  await dish(f, 'alice', a)
  await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' }); await f.complete('alice', { op: 'unbind' })
  for (const name of ['alice', 'bob']) {
    const k = f.col('User').get(name).kitchenId, recipe = rows(f, 'DishList', k)[0]
    assert((await f.call(name, { op: 'foodWrite', action: 'update', collection: 'DishList', kitchenId: k, docId: recipe._id, data: { name: name === 'alice' ? '少盐番茄炒蛋' : '加糖番茄炒蛋' } })).success)
    assert((await f.call(name, { op: 'foodWrite', action: 'add', collection: 'OrderList', kitchenId: k, requestId: 'meal_' + name + '_123', data: { dishes: [{ _id: recipe._id }], remark: name } })).success)
  }
  const merged = await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' })
  assert.equal(rows(f, 'DishList', merged.kitchenId).length, 2)
  for (const meal of rows(f, 'OrderList', merged.kitchenId)) {
    const recipe = f.col('DishList').get(meal.dishes[0]._id)
    assert(recipe); assert.equal(recipe.name, meal.remark === 'alice' ? '少盐番茄炒蛋' : '加糖番茄炒蛋')
  }
})

test('金额、日期和筛选范围精确校验', () => {
  assert.equal(D.amountToFen('0.01'), 1); assert.equal(D.amountToFen('99999999.99'), 9999999999)
  for (const input of ['0', '-1', '01', '1.001', '1e3', 1.23]) assert.throws(() => D.amountToFen(input))
  assert(!D.validDate('2026-02-29')); assert(D.validDate('2024-02-29'))
  assert.throws(() => D.ledgerFilter({ startDate: '2026-11-03', endDate: '2026-11-02' }))
  assert.throws(() => D.ledgerFilter({ month: '2026-11', categories: [] }))
})
test('未绑定用户只有一个厨房和一本账，可以独自保存照片菜品和完成餐单', async () => {
  const f = fixture(), kitchenId = await init(f, 'alice'), id = await dish(f, 'alice', kitchenId)
  const spaces = await f.call('alice', { op: 'bootstrap' }); assert.equal(spaces.kitchens.length, 1)
  await addEntry(f, 'alice', kitchenId, 'solo_expense_1')
  assert.equal(f.col('DishList').get(id).imageUrl, 'cloud://env/user-photo.jpg')
  const order = await f.call('alice', { op: 'foodWrite', action: 'add', kitchenId, collection: 'OrderList', requestId: 'solo_order_1', data: { dishes: [{ _id: id }], remark: '' } })
  assert(order.success, order.message)
  assert((await f.call('alice', { op: 'foodWrite', action: 'update', kitchenId, collection: 'OrderList', docId: order._id, data: { completed: true } })).success)
  assert(!(await f.call('cara', { op: 'foodRead', collection: 'DishList', kitchenId, docId: id })).success)
})
test('绑定合并双方原有菜品和历史账，同名菜保留、同名分类合并', async () => {
  const f = fixture(), a = await init(f, 'alice'), b = await init(f, 'bob')
  await dish(f, 'alice', a); await dish(f, 'bob', b)
  await addEntry(f, 'alice', a, 'before_alice_1'); await addEntry(f, 'bob', b, 'before_bob_123', entry({ amount: '20.00' }))
  const merged = await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' }); assert(merged.success)
  const id = merged.kitchenId
  assert.equal((await f.call('bob', { op: 'bootstrap' })).kitchenId, id)
  assert.equal(rows(f, 'DishList', id).length, 2); assert.equal(rows(f, 'Category', id).length, 8); assert.equal(rows(f, 'LedgerEntry', id).length, 2)
  assert.equal(L.totals((await f.call('bob', { op: 'ledger', action: 'stats', bookId: id, month: '2026-11' })).groups).expenseText, '32.34')
  assert.equal(rows(f, 'DishList', a).length, 1, 'original retained as backup')
  assert(!(await f.call('alice', { op: 'foodRead', kitchenId: a, collection: 'DishList' })).success)
})
test('合并中新写入被锁定，离开后可继续整理且重试不重复', async () => {
  const f = fixture(), a = await init(f, 'alice'), b = await init(f, 'bob')
  await dish(f, 'alice', a); await dish(f, 'bob', b)
  const start = await f.call('alice', { op: 'bind', inviteCode: 'DEF567' }); assert(start.success)
  assert(!(await f.call('alice', { op: 'ledger', action: 'add', bookId: a, requestId: 'during_merge_1', data: entry() })).success)
  assert(!(await f.call('cara', { op: 'transition', transitionId: start.transition.transitionId })).success)
  await f.call('alice', { op: 'transition', transitionId: start.transition.transitionId })
  const finished = await f.complete('bob', { op: 'bootstrap' }); assert(finished.success)
  await f.call('alice', { op: 'transition', transitionId: start.transition.transitionId })
  assert.equal(rows(f, 'DishList', finished.kitchenId).length, 2)
})
test('解绑后双方各有完整可编辑副本，后续修改互不影响', async () => {
  const f = fixture(), a = await init(f, 'alice'); await init(f, 'bob')
  await dish(f, 'alice', a); await addEntry(f, 'alice', a, 'expense_for_split')
  const pair = await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' })
  const left = await f.complete('alice', { op: 'unbind' }), right = await f.call('bob', { op: 'bootstrap' })
  assert.notEqual(left.kitchenId, right.kitchenId); assert.notEqual(left.kitchenId, pair.kitchenId)
  assert.equal(rows(f, 'DishList', left.kitchenId).length, 1); assert.equal(rows(f, 'DishList', right.kitchenId).length, 1)
  const aliceEntry = rows(f, 'LedgerEntry', left.kitchenId)[0], bobEntry = rows(f, 'LedgerEntry', right.kitchenId)[0]
  assert((await f.call('bob', { op: 'ledger', action: 'update', bookId: right.kitchenId, id: bobEntry._id, version: bobEntry.version, data: entry({ amount: '22.22' }) })).success)
  assert.equal(f.col('LedgerEntry').get(aliceEntry._id).amountFen, 1234)
  assert(!(await f.call('alice', { op: 'ledger', action: 'get', bookId: right.kitchenId, id: bobEntry._id })).success)
})
test('解绑后重新配对，相同旧账副本只计一次；另一对朋友无权访问', async () => {
  const f = fixture(), a = await init(f, 'alice'); await init(f, 'bob'); await init(f, 'cara')
  await addEntry(f, 'alice', a, 'before_rebind_1')
  await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' }); await f.complete('alice', { op: 'unbind' })
  const second = await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' })
  assert.equal(rows(f, 'LedgerEntry', second.kitchenId).length, 1)
  assert(!(await f.call('cara', { op: 'ledger', action: 'stats', bookId: second.kitchenId, month: '2026-11' })).success)
})
test('副本中的同一笔账发生不同修改时，先要求选择，不静默重复计算', async () => {
  const f = fixture(), a = await init(f, 'alice'); await init(f, 'bob')
  await addEntry(f, 'alice', a, 'before_conflict_1')
  await f.complete('alice', { op: 'bind', inviteCode: 'DEF567' }); await f.complete('alice', { op: 'unbind' })
  const b = f.col('User').get('bob').kitchenId, bill = rows(f, 'LedgerEntry', b)[0]
  assert((await f.call('bob', { op: 'ledger', action: 'update', bookId: b, id: bill._id, version: bill.version, data: entry({ amount: '99.00' }) })).success)
  const started = await f.call('alice', { op: 'bind', inviteCode: 'DEF567' })
  let state = started.transition
  while (!state.pending && !state.done) state = await f.call('alice', { op: 'transition', transitionId: state.transitionId })
  assert(state.pending); assert(!(await f.call('cara', { op: 'resolveTransition', transitionId: state.transitionId, choice: 'incoming' })).success)
  await f.call('alice', { op: 'resolveTransition', transitionId: state.transitionId, choice: 'incoming' })
  const final = await f.complete('alice', { op: 'bootstrap' })
  assert.equal(rows(f, 'LedgerEntry', final.kitchenId).length, 1)
  assert.equal(rows(f, 'LedgerEntry', final.kitchenId)[0].amountFen, 9900)
})
test('月统计包含收入，自定义日期和类别筛选包含起止两天、仅计支出', async () => {
  const f = fixture(), id = await init(f, 'alice')
  await addEntry(f, 'alice', id, 'date_bill_1', entry({ amount: '10.00', dateKey: '2026-10-31' }))
  await addEntry(f, 'alice', id, 'date_bill_2', entry({ amount: '20.00', dateKey: '2026-11-02' }))
  await addEntry(f, 'alice', id, 'date_bill_3', entry({ amount: '8.00', category: '交通出行' }))
  await addEntry(f, 'alice', id, 'date_salary_123', entry({ amount: '5000.00', type: 'income', category: '工资' }))
  const month = await f.call('alice', { op: 'ledger', action: 'stats', bookId: id, month: '2026-11' })
  assert.equal(L.totals(month.groups).incomeText, '5000.00')
  const filtered = { op: 'ledger', bookId: id, startDate: '2026-10-31', endDate: '2026-11-02', categories: ['买菜食材'] }
  const stats = await f.call('alice', { ...filtered, action: 'stats' }), list = await f.call('alice', { ...filtered, action: 'list' })
  assert.equal(L.totals(stats.groups).expenseText, '30.00'); assert.equal(L.totals(stats.groups).income, 0); assert.equal(list.data.length, 2)
})
test('重复保存、版本冲突、删除恢复和超过100笔汇总均正确', async () => {
  const f = fixture(), bookId = await init(f, 'alice')
  const id = await addEntry(f, 'alice', bookId, 'same_request_123')
  assert.equal(await addEntry(f, 'alice', bookId, 'same_request_123'), id)
  assert((await f.call('alice', { op: 'ledger', action: 'delete', bookId, id, version: 1 })).success)
  assert(!(await f.call('alice', { op: 'ledger', action: 'restore', bookId, id, version: 1 })).success)
  assert((await f.call('alice', { op: 'ledger', action: 'restore', bookId, id, version: 2 })).success)
  for (let i = 0; i < 137; i++) f.col('LedgerEntry').set('bulk' + i, { _id: 'bulk' + i, bookId, amountFen: 1, type: 'expense', category: '买菜食材', creatorId: 'alice', creatorName: 'alice', dateKey: '2026-11-02', deleted: false })
  const totals = L.totals((await f.call('alice', { op: 'ledger', action: 'stats', bookId, month: '2026-11' })).groups)
  assert.equal(totals.expenseText, '13.71')
})
test('升级旧双厨房时保留原菜品和照片，个人旧账并入唯一厨房', async () => {
  const f = fixture(), legacyId = 'legacy_pair'
  for (const [name, other] of [['alice', 'bob'], ['bob', 'alice']]) Object.assign(f.col('User').get(name), { coupleId: legacyId, partnerId: other, bindStatus: 'bound' })
  const solo = D.personalId('alice')
  f.col('Kitchen').set(solo, { _id: solo, name: '旧个人厨房', type: 'personal', status: 'active', members: ['alice'], [D.memberKey('alice')]: true })
  f.col('DishList').set('old_dish', { _id: 'old_dish', coupleId: legacyId, category: 'meat', name: '老菜品', imageUrl: 'cloud://old/photo.jpg', createTime: new Date() })
  f.col('LedgerEntry').set('old_bill', { _id: 'old_bill', bookId: solo, ...entry(), amountFen: 1234, creatorId: 'alice', creatorName: 'alice', version: 1, deleted: false })
  const upgraded = await f.complete('alice', { op: 'bootstrap' })
  assert.equal(upgraded.kitchens.length, 1); assert.equal(rows(f, 'DishList', upgraded.kitchenId)[0].imageUrl, 'cloud://old/photo.jpg'); assert.equal(rows(f, 'LedgerEntry', upgraded.kitchenId).length, 1)
  assert(f.col('DishList').has('old_dish')); assert.equal(f.col('Kitchen').get(solo).status, 'merged')
})
test('CSV保留中文及换行并阻止表格公式注入', () => {
  const csv = L.toCSV([{ dateKey: '2026-11-02', type: 'expense', category: '其他', amountFen: 123, note: '=HYPERLINK("bad")\n下一行', creatorName: '我', updatedByName: '伙伴' }])
  assert(csv.startsWith('\uFEFF')); assert(csv.includes("'=")); assert(csv.includes('下一行'))
})
