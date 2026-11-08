const test = require('node:test')
const assert = require('node:assert/strict')
const client = require('./helpers/client.cjs')
const fixture = require('./helpers/tandem-fixture.cjs')
const Drafts = require('../miniprogram/utils/drafts.js')
const DishTools = require('../miniprogram/utils/dish-tools.js')

function platform() {
  const storage = new Map(), files = new Set(), copied = [], previews = []
  const clone = value => JSON.parse(JSON.stringify(value))
  const wx = {
    env: { USER_DATA_PATH: '/usr' },
    getStorageSync: key => storage.has(key) ? clone(storage.get(key)) : '',
    setStorageSync: (key, value) => storage.set(key, clone(value)), removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({ copyFile: o => { files.add(o.destPath); copied.push(o); o.success() }, access: o => files.has(o.path) ? o.success() : o.fail(), unlink: o => { files.delete(o.filePath); o.success?.() } }),
    showLoading() {}, hideLoading() {}, showToast() {}, setNavigationBarTitle() {}, stopPullDownRefresh() {}, navigateBack() {}, pageScrollTo() {},
    showModal: async () => ({ confirm: false }), previewImage: value => previews.push(value),
    chooseMedia: async () => ({ tempFiles: [{ tempFilePath: '/camera.jpg', size: 1024 }] }),
    cropImage: async () => { assert.fail('选照片不应进入裁剪') },
    compressImage: async () => ({ tempFilePath: '/compressed.jpg' }), getImageInfo: async () => ({ width: 1280, height: 960 })
  }
  return { wx, storage, files, copied, previews }
}
function form(data) { return { data: { ...data }, setData(patch) { Object.assign(this.data, patch) } } }
async function setup() {
  const f = fixture(), p = platform(), calls = []
  let sequence = 0, uploads = 0
  await f.complete('alice', { op: 'bootstrap' }); await f.complete('bob', { op: 'bootstrap' })
  p.wx.cloud = { init() {}, callFunction: async o => { calls.push(o); return { result: await f.call('alice', o.data) } }, uploadFile: async () => ({ fileID: 'cloud://env/photo' + (++uploads) }) }
  const app = client('app.js', null, p.wx); await app.onLaunch()
  app.requestId = () => 'ux_request_' + (++sequence)
  await app.loadUserInfo()
  await app.loadCategories()
  return { ...p, f, app, calls, uploads: () => uploads }
}

test('草稿按账号、厨房和记录隔离，恢复字段和重试编号，保存后不再生成草稿', () => {
  const { wx, storage } = platform(), app = { globalData: { currentUser: { _id: 'alice' }, kitchenId: 'one' } }
  const d = Drafts.create(wx, app), p = form({ name: '' }); p._requestId = 'same_request_1'
  d.open(p, { kind: 'dish', id: '', base: 'new', fields: ['name'] })
  p.setData({ name: '番茄炒蛋' }); d.flush(p)
  const restored = form({ name: '' }); d.open(restored, { kind: 'dish', id: '', base: 'new', fields: ['name'] })
  assert.equal(restored.data.name, '番茄炒蛋'); assert.equal(restored._requestId, 'same_request_1')
  app.globalData.kitchenId = 'two'; assert.equal(d.read('dish', ''), null)
  restored.setData({ name: '不能写入另一个厨房' }); assert.equal(d.flush(restored), false)
  app.globalData.currentUser._id = 'bob'; app.globalData.kitchenId = 'one'; assert.equal(d.read('dish', ''), null)
  app.globalData.currentUser._id = 'alice'; assert.equal(d.read('dish', '').data.name, '番茄炒蛋')
  d.clear(p); p.setData({ name: '保存后返回不重建' }); d.dispose(p)
  assert.equal(storage.size, 0)
})
test('旧草稿与云端版本冲突时不覆盖新值，暂存失败有提示', () => {
  const { wx } = platform(), app = { globalData: { currentUser: { _id: 'alice' }, kitchenId: 'one' } }, d = Drafts.create(wx, app)
  d.write('ledger', 'bill', { base: '1', data: { amount: '12.00' } })
  const p = form({ amount: '99.00' }); d.open(p, { kind: 'ledger', id: 'bill', base: '2', fields: ['amount'] })
  assert(p.data.draftBlocked); assert.equal(p.data.amount, '99.00'); p.setData({ amount: '5.00' }); assert.equal(d.flush(p), false)
  d.clear(p); const q = form({ amount: '' }); d.open(q, { kind: 'ledger', id: '', base: 'new', fields: ['amount'] })
  wx.setStorageSync = () => { throw Error('full') }; q.setData({ amount: '8.00' }); assert.equal(d.flush(q), false); assert(q.data.draftMessage.includes('失败'))
  d.clear(q)
})
test('新照片不经裁剪直接持久暂存，重开表单可以恢复，上传成功后清理本地草稿', async () => {
  const s = await setup(), first = client('pages/DishAdd/index.js', s.app, s.wx)
  s.wx.compressImage = async ({ src }) => { assert.equal(src, '/camera.jpg'); return { tempFilePath: '/compressed.jpg' } }
  await first.onLoad({}); first.onNameInput({ detail: { value: '西兰花' } }); await first.chooseImage(); first.onHide()
  const photo = first.data.tempFilePath; assert(photo.startsWith('/usr/tandem-draft-')); assert(s.files.has(photo)); assert.equal(s.copied[0].srcPath, '/compressed.jpg')
  const second = client('pages/DishAdd/index.js', s.app, s.wx); await second.onLoad({})
  assert.equal(second.data.name, '西兰花'); assert.equal(second.data.tempFilePath, photo)
  await second.saveDish(); assert.equal(s.uploads(), 1)
  const dish = [...s.f.col('DishList').values()][0]; assert.equal(dish.imageUrl, 'cloud://env/photo1')
  second.onUnload(); assert(!s.files.has(photo)); assert.equal([...s.storage.keys()].filter(k => k.includes(':dish:')).length, 0)
})
test('取消选图保留原照片，草稿照片遗失不静默保存成另一张图', async () => {
  const s = await setup(), page = client('pages/DishAdd/index.js', s.app, s.wx); await page.onLoad({})
  await page.chooseImage(); const previous = page.data.imageUrl
  s.wx.chooseMedia = async () => { throw { errMsg: 'chooseMedia:fail cancel' } }
  await page.chooseImage(); assert.equal(page.data.imageUrl, previous)
  page.onHide(); s.files.clear()
  const restored = client('pages/DishAdd/index.js', s.app, s.wx); await restored.onLoad({})
  assert(restored.data.photoDraftMissing); restored.onNameInput({ detail: { value: '照片遗失测试' } }); await restored.saveDish()
  assert.equal(s.f.col('DishList').size, 0); restored.clearImage(); await restored.saveDish(); assert.equal(s.f.col('DishList').size, 1)
})
test('记账草稿恢复，连续记账每次使用新编号，连续点击不重复入账', async () => {
  const s = await setup(), first = client('pages/LedgerEdit/index.js', s.app, s.wx); await first.onLoad({})
  first.input({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '12.34' } }); first.changeDate({ detail: { value: '2026-11-03' } }); first.useQuickNote({ currentTarget: { dataset: { note: '买菜' } } }); first.onHide()
  const page = client('pages/LedgerEdit/index.js', s.app, s.wx); await page.onLoad({})
  assert.equal(page.data.amount, '12.34'); assert.equal(page.data.note, '买菜'); assert(page.data.amountFocused)
  const request = page._requestId; await Promise.all([page.saveAndContinue(), page.saveAndContinue()])
  assert.equal(s.f.col('LedgerEntry').size, 1); assert.notEqual(page._requestId, request); assert.equal(page.data.amount, ''); assert.equal(page.data.category, '买菜食材'); assert.equal(page.data.dateKey, '2026-11-03')
  page.input({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '2.00' } }); await page.saveAndContinue()
  assert.equal(s.f.col('LedgerEntry').size, 2); page.onUnload()
})
test('账目已入库但响应丢失，重开草稿再保存只保留一笔', async () => {
  const s = await setup(), page = client('pages/LedgerEdit/index.js', s.app, s.wx); await page.onLoad({})
  page.input({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '8.88' } })
  const original = s.app.api.bind(s.app); let lost = true
  s.app.api = async payload => { const result = await original(payload); if (payload.op === 'ledger' && payload.action === 'add' && lost) { lost = false; throw Error('response lost') }; return result }
  await page.save(); page.onHide(); assert.equal(s.f.col('LedgerEntry').size, 1)
  const retry = client('pages/LedgerEdit/index.js', s.app, s.wx); await retry.onLoad({}); await retry.save()
  assert.equal(s.f.col('LedgerEntry').size, 1); retry.onUnload()
})
test('共享收藏双方可见，常做排序正确，保存餐单重试不重复计点菜次数', async () => {
  const s = await setup(), kitchenId = s.app.globalData.kitchenId, category = s.app.globalData.categories[0]._id
  const added = await s.f.call('alice', { op: 'foodWrite', action: 'add', collection: 'DishList', kitchenId, requestId: 'ux_favorite_dish', data: { name: '收藏菜', category, imageUrl: '' } })
  await s.f.complete('alice', { op: 'bind', inviteCode: 'DEF567' }); await s.app.loadUserInfo(true)
  const menu = await s.app.getView('menu'), id = menu.dishes[0]._id, shared = menu.kitchenId
  const favorite = await s.f.call('bob', { op: 'foodWrite', collection: 'DishList', kitchenId: shared, action: 'update', docId: id, data: { favorite: true } }); assert(favorite.success)
  assert(!(await s.f.call('cara', { op: 'foodWrite', collection: 'DishList', kitchenId: shared, action: 'update', docId: id, data: { favorite: true } })).success)
  assert(!(await s.f.call('bob', { op: 'foodWrite', collection: 'DishList', kitchenId: shared, action: 'update', docId: id, data: { favorite: 'yes' } })).success)
  assert((await s.f.call('alice', { op: 'view', screen: 'menu' })).dishes[0].favorite)
  const meal = { op: 'foodWrite', collection: 'OrderList', kitchenId: shared, action: 'add', requestId: 'ux_same_meal_1', countDishes: true, data: { dishes: [{ _id: id }], remark: '' } }
  assert((await s.f.call('alice', meal)).success); assert((await s.f.call('alice', meal)).success)
  assert.equal(s.f.col('DishList').get(id).orderCount, 1)
  assert(!(await s.f.call('alice', { ...meal, data: { ...meal.data, remark: '内容已变' } })).success)
  assert(added.success)
})
test('待选餐单跨页面恢复选择、备注、筛选和浏览位置，成功提交后不再恢复', async () => {
  const s = await setup(), kitchenId = s.app.globalData.kitchenId, category = s.app.globalData.categories[0]._id
  await s.f.call('alice', { op: 'foodWrite', action: 'add', collection: 'DishList', kitchenId, requestId: 'ux_menu_dish_1', data: { name: '番茄炒蛋', category, imageUrl: '' } })
  const page = client('pages/Order/index.js', s.app, s.wx); await page.onShow(); const id = page.data.allDishes[0]._id
  page.toggleSelect({ currentTarget: { dataset: { id } } }); page.setData({ remark: '少放盐' }); page.onDishScroll({ detail: { scrollTop: 186 } }); page.onHide()
  await client('pages/Dishes/index.js', s.app, s.wx).onShow()
  const restored = client('pages/Order/index.js', s.app, s.wx); await restored.onShow()
  assert.equal(restored.data.selectedCount, 1); assert.equal(restored.data.remark, '少放盐'); assert.equal(restored.data.menuScrollTop, 186)
  await restored.doSubmitOrder('少放盐'); restored.onUnload()
  const next = client('pages/Order/index.js', s.app, s.wx); await next.onShow(); assert.equal(next.data.selectedCount, 0)
})

test('已有账目被修改后，旧草稿不会覆盖新金额，放弃草稿后可编辑最新版本', async () => {
  const s = await setup(), bookId = s.app.globalData.kitchenId
  const added = await s.f.call('alice', { op: 'ledger', action: 'add', bookId, requestId: 'ux_bill_conflict', data: { amount: '10.00', type: 'expense', category: '买菜食材', dateKey: '2026-11-03', note: '' } })
  const page = client('pages/LedgerEdit/index.js', s.app, s.wx); await page.onLoad({ id: added.id, bookId })
  page.input({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '12.00' } }); page.onHide()
  await s.f.call('alice', { op: 'ledger', action: 'update', bookId, id: added.id, version: 1, data: { amount: '99.00', type: 'expense', category: '买菜食材', dateKey: '2026-11-03', note: '' } })
  const next = client('pages/LedgerEdit/index.js', s.app, s.wx); await next.onLoad({ id: added.id, bookId })
  assert(next.data.draftBlocked); assert.equal(next.data.amount, '99.00'); await next.save()
  assert.equal(s.f.col('LedgerEntry').get(added.id).amountFen, 9900)
  await next.discardDraft(); assert.equal(next.data.draftBlocked, false); assert.equal(next.data.version, 2); next.onUnload()
})
test('菜谱草稿恢复，来源已变化时保留旧稿并禁止直接覆盖', async () => {
  const s = await setup(), kitchenId = s.app.globalData.kitchenId, category = s.app.globalData.categories[0]._id
  const added = await s.f.call('alice', { op: 'foodWrite', collection: 'DishList', kitchenId, action: 'add', requestId: 'ux_recipe_draft', data: { name: '番茄炒蛋', category, ingredients: '番茄', steps: '炒熟' } })
  s.f.col('DishList').get(added._id).updateTime = new Date('2026-11-01')
  const page = client('pages/RecipeEdit/index.js', s.app, s.wx); page.setData({ dishId: added._id }); await page.loadDish()
  page.onStepsInput({ detail: { value: '少盐，慢慢炒' } }); page.onHide()
  const restored = client('pages/RecipeEdit/index.js', s.app, s.wx); restored.setData({ dishId: added._id }); await restored.loadDish(); assert.equal(restored.data.steps, '少盐，慢慢炒')
  s.f.col('DishList').get(added._id).updateTime = new Date('2030-01-01')
  const rejected = await s.f.call('alice', { op: 'foodWrite', collection: 'DishList', kitchenId, action: 'update', docId: added._id, expectedRevision: restored._baseRevision, data: { steps: '不可覆盖' } })
  assert(!rejected.success)
  const changed = client('pages/RecipeEdit/index.js', s.app, s.wx); changed.setData({ dishId: added._id }); await changed.loadDish(); assert(changed.data.draftBlocked)
  await changed.save(); assert.equal(s.f.col('DishList').get(added._id).steps, '炒熟')
  await changed.discardDraft(); changed.onUnload()
})
test('收藏和常做筛选不改动原数组，已入库的菜品重试不能静默忽略不同表单', async () => {
  const tools = DishTools.create({}, {}), dishes = [{ name: '甲', orderCount: 2, favorite: true }, { name: '乙', orderCount: 8 }, { name: '丙', orderCount: 0 }]
  assert.deepEqual(tools.filter(dishes, '', 'frequent').map(x => x.name), ['乙', '甲'])
  assert.deepEqual(tools.filter(dishes, '', 'favorite').map(x => x.name), ['甲']); assert.equal(dishes[0].name, '甲')
  const s = await setup(), kitchenId = s.app.globalData.kitchenId, category = s.app.globalData.categories[0]._id
  const input = { op: 'foodWrite', collection: 'DishList', kitchenId, action: 'add', requestId: 'ux_same_dish_1', data: { name: '甲', category, imageUrl: '' } }
  assert((await s.f.call('alice', input)).success); assert((await s.f.call('alice', input)).success)
  assert(!(await s.f.call('alice', { ...input, data: { ...input.data, name: '改过的甲' } })).success); assert.equal(s.f.col('DishList').size, 1)
})

test('草稿分类已不存在时要求重选，保存中重置不能清空待保存内容', async () => {
  const s = await setup(), page = client('pages/DishAdd/index.js', s.app, s.wx)
  await page.onLoad({})
  page.onNameInput({ detail: { value: '保留草稿菜' } })
  page.setData({ categoryId: 'removed-category', categoryIndex: 0 }); page.onHide()
  const restored = client('pages/DishAdd/index.js', s.app, s.wx); await restored.onLoad({})
  assert.equal(restored.data.categoryIndex, -1)
  await restored.saveDish(); assert.equal(s.f.col('DishList').size, 0)
  restored.setData({ saving: true }); restored.resetForm()
  assert.equal(restored.data.name, '保留草稿菜')
  restored.setData({ saving: false }); restored.onUnload()
})
