const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const client = require('./helpers/client.cjs')

const root = path.resolve(__dirname, '..')

test('自己选照片后压缩上传，保存重试复用上传结果，更换照片才重新上传', async () => {
  let uploads = 0, source = '/tmp/meal.png', selected
  const page = client('pages/DishAdd/index.js', { globalData: { kitchenId: 'kitchen' } }, {
    chooseMedia: async options => { selected = options; return { tempFiles: [{ tempFilePath: source, size: 1024 }] } },
    compressImage: async ({ src }) => ({ tempFilePath: src.replace('/tmp/', '/compressed/') }),
    cloud: { uploadFile: async options => { uploads++; assert(options.cloudPath.startsWith('dishes/kitchen/')); return { fileID: 'cloud://photo' + uploads } } }
  })
  await page.chooseImage()
  assert.deepEqual(Array.from(selected.sourceType), ['album', 'camera'])
  assert.equal(page.data.imageUrl, '/compressed/meal.png')
  assert.equal(await page.uploadImage(), 'cloud://photo1')
  assert.equal(await page.uploadImage(), 'cloud://photo1')
  assert.equal(uploads, 1)
  source = '/tmp/new.png'; await page.chooseImage()
  assert.equal(await page.uploadImage(), 'cloud://photo2')
  page.clearImage(); assert.equal(page.data.imageUrl, ''); assert.equal(await page.uploadImage(), '')
})

test('照片上传失败能重试，超大照片或取消选择不会替换已有照片', async () => {
  let tooLarge = true, fail = true, toast = ''
  const page = client('pages/DishAdd/index.js', { globalData: { kitchenId: 'kitchen' } }, {
    chooseMedia: async () => { if (!tooLarge) throw { errMsg: 'chooseMedia:fail cancel' }; return { tempFiles: [{ tempFilePath: '/large.jpg', size: 11 * 1024 * 1024 }] } },
    showToast: value => { toast = value.title },
    cloud: { uploadFile: async () => { if (fail) throw new Error('network'); return { fileID: 'cloud://retry.jpg' } } }
  })
  page.setData({ imageUrl: 'cloud://old.jpg' }); await page.chooseImage()
  assert(toast.includes('10MB')); assert.equal(page.data.imageUrl, 'cloud://old.jpg')
  tooLarge = false; toast = ''; await page.chooseImage(); assert.equal(toast, '')
  page.setData({ tempFilePath: '/new.jpg' }); await assert.rejects(page.uploadImage(), /图片上传失败/)
  fail = false; assert.equal(await page.uploadImage(), 'cloud://retry.jpg')
})

function cloudFunction(name, { caller = 'alice', bound = true, owner = 'couple-a', schemaVersion, pendingTransitionId } = {}) {
  const writes = []
  const db = {
    command: { inc: value => ({ increment: value }), gte: value => value },
    collection(collection) {
      return {
        doc(id) {
          return {
            async get() {
              return { data: collection === 'User'
                ? { _id: caller, coupleId: bound ? 'couple-a' : '', schemaVersion, pendingTransitionId }
                : { _id: id, coupleId: owner, name: '番茄炒蛋' } }
            },
            async update({ data }) {
              writes.push({ collection, id, data })
              return { stats: { updated: 1 } }
            },
            async remove() {
              writes.push({ collection, id, removed: true })
              return { stats: { removed: 1 } }
            },
          }
        },
      }
    },
  }
  const sdk = { init() {}, database: () => db, getWXContext: () => ({ OPENID: caller }) }
  const exports = {}
  vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions', name, 'index.js'), 'utf8'), {
    exports,
    require: id => {
      assert.equal(id, 'wx-server-sdk')
      return sdk
    },
    console: { error() {} },
  })
  return { main: exports.main, writes }
}

test('正在合并或已升级的账号不能从旧函数绕过新版数据保护', async () => {
  for (const flags of [{ schemaVersion: 3 }, { pendingTransitionId: 'transition_1' }]) {
    for (const name of ['getCoupleData', 'updateCoupleData', 'manageCategory', 'updateKitchenName']) {
      const f = cloudFunction(name, flags)
      const result = await f.main({ collection: 'DishList', docId: 'recipe', action: 'update', kitchenName: '小厨房', data: { name: '偷偷改名' } })
      assert.equal(result.success, false); assert.match(result.message, /2\.1\.0/); assert.equal(f.writes.length, 0)
    }
  }
})

test('未配置通知模板时，点菜和跳转的回调仍执行，且不调用微信订阅接口', async () => {
  let requests = 0
  let continued = 0
  const app = client('app.js', null, { cloud: { init() {} }, requestSubscribeMessage() { requests++ } })
  await app.onLaunch()
  app.globalData.notifyTmplIds = ['your-template-id']
  app.requestSubscribeMessage({ complete: () => continued++ })
  assert.equal(continued, 1)
  assert.equal(requests, 0)
})

test('配置真实通知模板后，传递模板和回调', () => {
  let options
  const app = client('app.js', null, { requestSubscribeMessage: value => { options = value } })
  app.globalData = { notifyTmplIds: ['real-template'] }
  const complete = () => {}
  app.requestSubscribeMessage({ complete })
  assert.equal(options.tmplIds[0], 'real-template')
  assert.equal(options.complete, complete)
})

test('用户加载失败后能够重新请求，不缓存失败的 Promise', async () => {
  const app = client('app.js', null)
  app.globalData = { userLoaded: false }
  let calls = 0
  app._doLoadUserInfo = async () => { calls++; return { currentUser: null, partner: null } }
  await app.loadUserInfo()
  await app.loadUserInfo()
  assert.equal(calls, 2)
})

test('只修改昵称时，不把临时 HTTPS 头像地址覆盖到数据库', async () => {
  let saved
  const wx = {
    showLoading() {}, hideLoading() {}, showToast() {},
    cloud: { callFunction: async options => { saved = options.data; return { result: { success: true } } } },
  }
  const app = { loadUserInfo: async () => ({ currentUser: { nickname: '新昵称', avatarUrl: 'https://temporary/avatar' } }), isBound: () => false }
  const page = client('pages/Settings/index.js', app, wx)
  Object.assign(page.data, { tempNickname: ' 新昵称 ', userAvatar: 'https://temporary/avatar' })
  await page.saveProfile()
  assert.equal(saved.nickname, '新昵称')
  assert.equal(Object.hasOwn(saved, 'avatarUrl'), false)
})

test('云端保存个人资料失败时，页面不会提示保存成功', async () => {
  const toasts = []
  const wx = { showLoading() {}, hideLoading() {}, showToast: value => toasts.push(value.title),
    cloud: { callFunction: async () => ({ result: { success: false, error: '写入失败' } }) } }
  const page = client('pages/Settings/index.js', {}, wx)
  page.data.tempNickname = '昵称'
  await page.saveProfile()
  assert.ok(toasts.includes('保存失败'))
  assert.ok(!toasts.includes('保存成功'))
  assert.equal(page.data.saving, false)
})

test('菜品编辑时显示临时图片链接，保存时保留原云文件 ID', async () => {
  let saved
  const raw = 'cloud://test/dishes/dish.jpg'
  const app = {
    globalData: { collectionDishList: 'DishList' }, isBound: () => true,
    getTempFileURLs: async () => ({ [raw]: 'https://temporary/dish.jpg' }), database: async () => ({}),
  }
  const wx = { showLoading() {}, hideLoading() {}, showToast() {}, navigateBack() {},
    cloud: { callFunction: async options => {
      if (options.name === 'getCoupleData') return { result: { success: true, data: { name: '番茄炒蛋', category: 'cat-1', imageUrl: raw } } }
      saved = options.data.data
      return { result: { success: true } }
    } } }
  const page = client('pages/DishAdd/index.js', app, wx)
  Object.assign(page.data, { _id: 'dish-1', isEdit: true, categories: [{ _id: 'cat-1' }] })
  await page.loadDish()
  assert.equal(page.data.imageUrl, 'https://temporary/dish.jpg')
  await page.saveDish()
  assert.equal(saved.imageUrl, raw)
})

test('更换成品照片后，删除操作所用的原始 ID 同步更新', async () => {
  const app = { globalData: { collectionOrderList: 'OrderList' }, getTempFileURLs: async () => ({ 'cloud://new': 'https://new' }) }
  const page = client('pages/OrderDetail/index.js', app, { cloud: { callFunction: async () => ({ result: { success: true } }) } })
  page.data.order = { _id: 'order-1', _rawFinishedPhoto: 'cloud://old' }
  await page.saveFinishedPhoto('cloud://new')
  assert.equal(page.data.order._rawFinishedPhoto, 'cloud://new')
  assert.equal(page.data.order.finishedPhoto, 'https://new')
})

test('成品照片写入失败时向上传流程报告错误', async () => {
  const app = { globalData: { collectionOrderList: 'OrderList' } }
  const page = client('pages/OrderDetail/index.js', app, { cloud: { callFunction: async () => ({ result: { success: false, message: '无权操作' } }) } })
  page.data.order = { _id: 'order-1' }
  await assert.rejects(page.saveFinishedPhoto('cloud://new'), /无权操作/)
})

test('读取共享数据不能请求用户集合或越过厨房边界', async () => {
  const fn = cloudFunction('getCoupleData', { owner: 'couple-b' })
  assert.equal((await fn.main({ collection: 'User', docId: 'bob' })).success, false)
  assert.equal((await fn.main({ collection: 'DishList', docId: 'dish-1' })).success, false)
  assert.equal((await fn.main({ collection: 'DishList', limit: 1000 })).success, false)
})

test('更新接口拒绝用户集合、未绑定用户和其他厨房的数据', async () => {
  const request = { collection: 'DishList', docId: 'dish-1', action: 'update', data: { name: '新菜名' } }
  for (const options of [{ bound: false }, { owner: 'couple-b' }, { caller: '' }]) {
    const fn = cloudFunction('updateCoupleData', options)
    assert.equal((await fn.main(request)).success, false)
    assert.equal(fn.writes.length, 0)
  }
  const fn = cloudFunction('updateCoupleData')
  assert.equal((await fn.main({ ...request, collection: 'User' })).success, false)
  assert.equal(fn.writes.length, 0)
})

test('不能用直接字段或点路径改写记录归属', async () => {
  const fn = cloudFunction('updateCoupleData')
  for (const key of ['coupleId', '_openid', '_id', 'createTime', 'dishes.0._id', '$set']) {
    const result = await fn.main({ collection: 'DishList', docId: 'dish-1', action: 'update', data: { [key]: 'forged' } })
    assert.equal(result.success, false, key)
  }
  assert.equal(fn.writes.length, 0)
})

test('同一厨房仍可编辑菜品，点菜次数只接受正整数', async () => {
  const fn = cloudFunction('updateCoupleData')
  const base = { collection: 'DishList', docId: 'dish-1' }
  assert.equal((await fn.main({ ...base, action: 'update', data: { name: '番茄炒蛋' } })).success, true)
  assert.equal((await fn.main({ ...base, action: 'inc', data: { orderCount: 1 } })).success, true)
  assert.equal((await fn.main({ ...base, action: 'inc', data: { orderCount: -1 } })).success, false)
  assert.equal(fn.writes.length, 2)
})

test('连续点击提交时只创建一条订单，订单保留云文件 ID', async () => {
  let finish
  let writes = 0
  let saved
  const app = { isBound: () => true, globalData: { collectionOrderList: 'OrderList', notifyTmplIds: [], currentUser: { coupleId: 'couple-a' } },
    addKitchenData: async (collection, data) => {
      writes++; saved = data; await new Promise(resolve => { finish = resolve }); return { _id: 'order-1' }
    },
    database: async () => ({ serverDate: () => 'server-date', collection: () => ({ add: async ({ data }) => {
      writes++; saved = data; await new Promise(resolve => { finish = resolve }); return { _id: 'order-1' }
    } }) }) }
  const wx = { showLoading() {}, hideLoading() {}, showToast() {}, cloud: { callFunction: async () => ({ result: { success: true } }) } }
  const page = client('pages/Order/index.js', app, wx)
  page.data.selectedDishes = [{ _id: 'dish-1', name: '番茄炒蛋', imageUrl: 'https://temporary', _raw_imageUrl: 'cloud://dish-1' }]
  const first = page.doSubmitOrder('少放盐')
  await Promise.resolve()
  await page.doSubmitOrder('少放盐')
  assert.equal(writes, 1)
  assert.equal(saved.dishes[0].imageUrl, 'cloud://dish-1')
  finish()
  await first
  assert.equal(page.data.showSuccess, true)
})
