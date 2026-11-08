const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const L = require('../miniprogram/utils/ledger')
const Ring = require('../miniprogram/utils/ring')
const Feedback = require('../miniprogram/utils/feedback')
const client = require('./helpers/client.cjs')

function component(file, app, wx, properties = {}) {
  let definition, timer = 0
  const tasks = new Map(), filename = path.resolve(__dirname, '../miniprogram/components', file, 'index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Component: d => { definition = d }, getApp: () => app, wx, require: createRequire(filename), setTimeout: fn => { tasks.set(++timer, fn); return timer }, clearTimeout: id => tasks.delete(id) }, { filename })
  const instance = { ...definition.methods, properties, data: { ...definition.data }, setData(patch, callback) { Object.assign(this.data, patch); callback?.() } }
  return { definition, instance, tasks }
}
function context() {
  const arcs = [], strokes = [], scales = []
  const ctx = { globalAlpha: 1, clearRect() {}, beginPath() {}, arc(...args) { arcs.push(args) }, stroke() { strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth }) }, scale(...args) { scales.push(args) } }
  return { ctx, arcs, strokes, scales }
}

test('环形统计用整数分计算，排除收入，颜色不随分类排序变化', () => {
  const totals = L.totals([{ _id: { type: 'expense', category: '买菜食材' }, amountFen: 1 }, { _id: { type: 'expense', category: '买菜食材' }, amountFen: 2 }, { _id: { type: 'expense', category: '餐饮外卖' }, amountFen: 97 }, { _id: { type: 'income', category: '工资' }, amountFen: 500000 }])
  const model = Ring.prepare(totals.categories)
  assert.equal(model.total, 100); assert.equal(model.totalText, '1.00')
  assert.equal(model.rows.find(x => x.name === '买菜食材').amountFen, 3)
  assert.equal(model.rows.find(x => x.name === '买菜食材').percentText, '3.0')
  const reversed = Ring.prepare([...totals.categories].reverse())
  for (const row of model.rows) assert.equal(row.color, reversed.rows.find(x => x.name === row.name).color)
  assert(Math.abs(model.rows.at(-1).end - Math.PI * 1.5) < 1e-12)
  assert.equal(Ring.prepare([]).totalText, '0.00')
  assert.equal(Ring.prepare([{ amountFen: -1 }, { amountFen: NaN }]).rows.length, 0)
})

test('环形图按真实比例绘制并高亮分类，零支出只绘制中性底环', () => {
  const c = context(), model = Ring.prepare([{ name: '买菜食材', amountFen: 2500, amount: '25.00' }, { name: '日用购物', amountFen: 7500, amount: '75.00' }])
  Ring.draw(c.ctx, 156, 156, model, '买菜食材')
  assert.equal(c.arcs.length, 3)
  assert(Math.abs(c.arcs[1][4] - c.arcs[1][3] - Math.PI / 2) < 1e-12)
  assert.equal(c.strokes[1].alpha, 1); assert.equal(c.strokes[2].alpha, .35); assert.equal(c.ctx.globalAlpha, 1)
  assert(c.strokes[1].width > c.strokes[2].width)
  const empty = context(); Ring.draw(empty.ctx, 156, 156, Ring.prepare([])); assert.equal(empty.arcs.length, 1)
})

test('原生环形组件适配像素密度，分类切换更新金额，缺少画布仍保留明细', () => {
  const c = context(), canvas = { getContext: () => c.ctx }, wx = { getWindowInfo: () => ({ pixelRatio: 2 }) }
  const x = component('ledger-ring', {}, wx, { items: [{ name: '买菜食材', amountFen: 1234, amount: '12.34' }, { name: '日用购物', amountFen: 2000, amount: '20.00' }] })
  x.instance.createSelectorQuery = () => ({ select() { return this }, fields() { return this }, exec(fn) { fn([{ width: 156, height: 156, node: canvas }]) } })
  x.definition.lifetimes.ready.call(x.instance)
  assert.equal(canvas.width, 312); assert.equal(canvas.height, 312); assert.equal(x.instance.data.centerMoney, '32.34')
  x.instance.selectCategory({ currentTarget: { dataset: { name: '买菜食材' } } }); assert.equal(x.instance.data.centerMoney, '12.34')
  x.instance.selectCategory({ currentTarget: { dataset: { name: '买菜食材' } } }); assert.equal(x.instance.data.centerMoney, '32.34')
  x.instance.properties.items = [{ name: '买菜食材', amountFen: 999999999999, amount: '不能使用这个字符串' }]
  x.instance.updateChart(); assert.equal(x.instance.data.centerMoney, '9999999999.99'); assert.equal(x.instance.data.moneySize, 25)
  x.instance.createSelectorQuery = () => ({ select() { return this }, fields() { return this }, exec(fn) { fn([]) } })
  x.instance.draw(); assert.equal(x.instance.data.canvasReady, false); assert.equal(x.instance.data.rows.length, 1)
  x.definition.lifetimes.detached.call(x.instance)
  assert.equal(x.instance._ready, false)
})

test('保存庆祝跨页只消费一次，过期及不同厨房不展示，离开页面清理计时器', () => {
  const app = { globalData: { kitchenId: 'one' } }, wx = { showToast() {} }
  const feedback = Feedback.create(wx, app), page = { data: {}, setData(patch) { Object.assign(this.data, patch) } }
  feedback.success(page, '已保存', true); assert(!page.data.tbFeedbackVisible)
  feedback.consume(page); assert.equal(page.data.tbFeedbackMessage, '已保存'); assert(page.data.tbFeedbackCelebrate)
  assert.equal(app.globalData.pendingCelebration, null); assert(page._feedbackTimer)
  feedback.hide(page); assert.equal(page._feedbackTimer, null); assert.equal(page.data.tbFeedbackVisible, false)
  feedback.consume(page); assert.equal(page.data.tbFeedbackVisible, false)
  feedback.success(page, '另一个厨房', true); app.globalData.kitchenId = 'two'; feedback.consume(page); assert.equal(page.data.tbFeedbackVisible, false)
  feedback.success(page, '过期', true); app.globalData.pendingCelebration.expiresAt = 0; feedback.consume(page); assert.equal(page.data.tbFeedbackVisible, false)
  feedback.greet(page); assert.equal(page.data.tbFeedbackCelebrate, false); feedback.hide(page)
})

test('全局页面反馈清理保留原有显示、草稿暂存和卸载回调', () => {
  let definition
  const calls = [], app = { globalData: { kitchenId: 'one' }, bindGuard: () => true }
  const filename = path.resolve(__dirname, '../miniprogram/app.js')
  const sandbox = { Page: options => { definition = options }, App() {}, wx: {}, getApp: () => app, getCurrentPages: () => [{ route: 'pages/Order/index' }], require: createRequire(filename) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  sandbox.Page({ onShow() { calls.push('show'); return 'loaded' }, onHide() { calls.push('draft-flush') }, onUnload() { calls.push('draft-dispose') } })
  const page = { data: {}, setData(patch) { Object.assign(this.data, patch) } }
  Feedback.create({}, app).success(page, '已保存', true)
  assert.equal(definition.onShow.call(page), 'loaded')
  assert(page.data.tbFeedbackVisible)
  definition.onHide.call(page)
  assert.equal(page._feedbackTimer, null); assert.equal(page.data.tbFeedbackVisible, false)
  definition.onUnload.call(page)
  assert.deepEqual(calls, ['show', 'draft-flush', 'draft-dispose'])
})

test('账本分页按日期分组，跨页同一天不重复日期标题，收入使用钱包图标', async () => {
  const data = [{ _id: 'a', dateKey: '2026-11-03', category: '买菜食材', type: 'expense', amountFen: 100, creatorId: 'me' }, { _id: 'b', dateKey: '2026-11-03', category: '工资', type: 'income', amountFen: 1000, creatorId: 'me' }, { _id: 'c', dateKey: '2026-11-02', category: '日用购物', type: 'expense', amountFen: 200, creatorId: 'other', creatorName: '伙伴' }]
  const app = { globalData: { currentUser: { _id: 'me' } }, getView: async (_, params) => ({ data: params.skip ? data.slice(1) : data.slice(0, 1), kitchenId: 'one', hasMore: !params.skip, groups: [] }) }
  const page = client('pages/Ledger/index.js', app, {})
  await page.load(true); await page.load(false)
  assert.deepEqual(Array.from(page.data.entries, x => x.showDate), [true, false, true])
  assert.equal(page.data.entries[1].icon, 'wallet'); assert.equal(page.data.entries[2].creatorLabel, '伙伴')
})

test('记账失败不显示成功庆祝，确认保存后再发起跨页反馈', async () => {
  const app = { globalData: { kitchenId: 'one' }, api: async () => { throw new Error('网络断开') } }
  const wx = { showToast() {}, navigateBack() {} }, page = client('pages/LedgerEdit/index.js', app, wx)
  page.setData({ ready: true, loading: false, bookId: 'one', amount: '12.34' })
  await page.save(); assert.equal(app.globalData.pendingCelebration, undefined); assert.equal(page.data.error, '网络断开')
  app.api = async () => ({ success: true }); await page.save()
  assert.equal(app.globalData.pendingCelebration.message, '这一笔，记好啦')
})
