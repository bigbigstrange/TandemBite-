const test = require('node:test')
const assert = require('node:assert/strict')
const client = require('./helpers/client.cjs')
const fixture = require('./helpers/tandem-fixture.cjs')

async function setup() {
  const f = fixture()
  const a = await f.complete('alice', { op: 'bootstrap' })
  await f.complete('bob', { op: 'bootstrap' })
  await f.call('alice', { op: 'category', action: 'init', kitchenId: a.kitchenId })
  const calls = [], wx = { setNavigationBarTitle() {}, stopPullDownRefresh() {}, cloud: { init() {}, callFunction: async options => {
    calls.push(options)
    assert.equal(options.name, 'tandem', '已存在的账号无需再次调用createUser或getFileURL')
    return { result: await f.call('alice', options.data) }
  } } }
  const app = client('app.js', null, wx)
  await app.onLaunch()
  return { app, f, calls, wx, kitchenId: a.kitchenId }
}
test('首页、厨房、点菜、账本各自首次只需一次页面云调用，菜单切换复用数据', async () => {
  const { app, calls, wx } = await setup()
  for (const pagePath of ['MainPage', 'Kitchen', 'Order', 'Ledger']) {
    const before = calls.length, page = client('pages/' + pagePath + '/index.js', app, wx)
    await page.onShow()
    assert.equal(page.data.error || '', '', pagePath)
    assert.equal(calls.length - before, 1, pagePath)
  }
  const before = calls.length
  await client('pages/Dishes/index.js', app, wx).onShow()
  assert.equal(calls.length, before, '点菜与菜品库复用15秒内的菜单')
})
test('并发相同请求合并；缓存副本相互独立；写入和手动刷新立即失效', async () => {
  const { app, calls, kitchenId } = await setup()
  const [first, second] = await Promise.all([app.getView('menu'), app.getView('menu')])
  assert.equal(calls.length, 1)
  first.categories[0].name = '仅修改本地副本'
  assert.notEqual(second.categories[0].name, first.categories[0].name)
  await app.api({ op: 'foodWrite', action: 'add', collection: 'DishList', kitchenId, requestId: 'performance_dish', data: { name: '新菜', category: second.categories[0]._id, imageUrl: 'cloud://env/own-photo.jpg', ingredients: '很长的食材正文', steps: '很长的做法正文' } })
  const fresh = await app.getView('menu')
  assert.equal(fresh.dishes.length, 1); assert.equal(calls.length, 3)
  assert.equal(fresh.dishes[0].ingredients, undefined, '菜单不传详情页才使用的长正文')
  await app.convertFileURLs(fresh.dishes, ['imageUrl'])
  assert.equal(fresh.dishes[0]._raw_imageUrl, 'cloud://env/own-photo.jpg')
  assert.equal((await app.getView('menu')).dishes[0].imageUrl, 'cloud://env/own-photo.jpg')
  const before = calls.length; await app.getView('menu', {}, true); assert.equal(calls.length, before + 1)
})
test('账本每次重新进入都取最新数据，日期类别条件仍准确且不缓存旧金额', async () => {
  const { app, calls, f, kitchenId } = await setup()
  await app.getView('ledger', { month: '2026-11' })
  await f.call('alice', { op: 'ledger', action: 'add', bookId: kitchenId, requestId: 'performance_bill', data: { amount: '8.88', type: 'expense', category: '买菜食材', dateKey: '2026-11-03', note: '买菜' } })
  const result = await app.getView('ledger', { month: '2026-11' })
  assert.equal(calls.length, 2); assert.equal(result.data[0].amountFen, 888)
  const filtered = await app.getView('ledger', { startDate: '2026-11-03', endDate: '2026-11-03', categories: ['交通出行'] })
  assert.equal(filtered.data.length, 0); assert.equal(filtered.groups.length, 0)
})
test('页面聚合接口忽略伪造厨房编号，整理锁定时不返回旧厨房内容', async () => {
  const { f, kitchenId } = await setup()
  const bob = await f.call('bob', { op: 'view', screen: 'kitchen', kitchenId, params: { kitchenId, bookId: kitchenId } })
  assert(bob.success); assert.notEqual(bob.kitchenId, kitchenId)
  assert(!(await f.call('alice', { op: 'view', screen: 'User' })).success)
  await f.call('alice', { op: 'bind', inviteCode: 'DEF567' })
  const locked = await f.call('bob', { op: 'view', screen: 'menu' })
  assert(locked.transition); assert.equal(locked.dishes, undefined)
})
test('写入期间尚未返回的旧读取不能重新填入缓存，失败可以重试', async () => {
  const { app, wx } = await setup()
  const real = wx.cloud.callFunction
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  wx.cloud.callFunction = async options => {
    const response = await real(options)
    if (options.data.op === 'view') { entered(); await new Promise(resolve => { release = resolve }) }
    return response
  }
  const read = app.getView('kitchen')
  await waiting
  app._writeGeneration = (app._writeGeneration || 0) + 1; app.invalidateViews()
  release()
  await assert.rejects(read, /内容已更新/)
  assert.equal(Object.keys(app._viewCache).length, 0)
  wx.cloud.callFunction = real
  assert((await app.getView('kitchen')).user)
})
test('滚动高亮只用预先测量的位置，不在每一帧查询布局', async () => {
  const page = client('pages/Order/index.js', {}, {})
  page._categoryOffsets = [{ id: 'first', top: 0 }, { id: 'second', top: 200 }]
  page.createSelectorQuery = () => { throw Error('滚动时不应查询布局') }
  page.onDishScroll({ detail: { scrollTop: 205 } })
  assert.equal(page.data.currentCategory, 'second')
  page.onDishScroll({ detail: { scrollTop: 0 } })
  assert.equal(page.data.currentCategory, 'first')
})

test('新上传大照片等比缩小，小图不放大，压缩失败仍可选图', async () => {
  let width = 4000, height = 3000, options, fail = false
  const page = client('pages/DishAdd/index.js', {}, {
    chooseMedia: async () => ({ tempFiles: [{ tempFilePath: '/photo.jpg', size: 2000000 }] }),
    getImageInfo: async () => ({ width, height }),
    compressImage: async config => { options = config; if (fail) throw Error('unsupported'); return { tempFilePath: '/compressed.jpg' } }
  })
  await page.chooseImage()
  assert.equal(options.compressedWidth, 1280); assert.equal(options.compressedHeight, 960)
  width = 600; height = 800; await page.chooseImage(); assert.equal(options.compressedWidth, undefined)
  fail = true; await page.chooseImage(); assert.equal(page.data.tempFilePath, '/photo.jpg')
})

test('搜索其他菜再选择时保留先前选择，清空购物车覆盖隐藏的已选菜品', () => {
  const page = client('pages/Order/index.js', {}, {})
  const dishes = [{ _id: 'a', name: '青菜', category: 'vegetable', selected: false }, { _id: 'b', name: '番茄', category: 'vegetable', selected: false }]
  page.setData({ allDishes: dishes, dishes, categories: [{ _id: 'vegetable' }], dishesByCategory: { vegetable: dishes } })
  page.toggleSelect({ currentTarget: { dataset: { id: 'a' } } })
  page.onSearchInput({ detail: { value: '番茄' } })
  page.toggleSelect({ currentTarget: { dataset: { id: 'b' } } })
  assert.equal(page.data.selectedCount, 2)
  page.clearSearch(); assert.equal(page.data.dishes.filter(d => d.selected).length, 2)
  page.onSearchInput({ detail: { value: '番茄' } }); page.clearCart()
  assert.equal(page.data.allDishes.filter(d => d.selected).length, 0)
})

test('手机加载诊断只复制耗时，不包含身份、照片或账目内容', async () => {
  let copied = ''
  const page = client('pages/Settings/index.js', { globalData: { version: '2.1.1' }, getPerformanceSummary: () => [{ op: 'view', screen: 'home', ms: 1000, serverMs: 120, success: true, openid: 'PRIVATE', note: 'PRIVATE', amount: '99999' }] }, {
    showModal: async () => ({ confirm: true }), setClipboardData: ({ data }) => { copied = data }
  })
  await page.showLoadDiagnostics()
  assert(copied.includes('总等待 1.00 秒')); assert(copied.includes('云端处理 0.12 秒'))
  assert(!copied.includes('PRIVATE')); assert(!copied.includes('99999'))
})

test('选菜和清空购物车时保留当前分类高亮', () => {
  const page = client('pages/Order/index.js', {}, {})
  const dishes = [{ _id: 'a', name: '青菜', category: 'first', selected: false }, { _id: 'b', name: '番茄', category: 'second', selected: false }]
  page.setData({ allDishes: dishes, dishes, categories: [{ _id: 'first' }, { _id: 'second' }], currentCategory: 'second' })
  page.toggleSelect({ currentTarget: { dataset: { id: 'b' } } })
  assert.equal(page.data.currentCategory, 'second')
  page.clearCart(); assert.equal(page.data.currentCategory, 'second')
})
