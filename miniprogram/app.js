// 为旧页面同步绑定状态；不限制单人操作。
const _originalPage = Page
const _Feedback = require('./utils/feedback')
const _bindWhitelist = ['pages/MainPage/index', 'pages/Settings/index', 'pages/Bind/index']

Page = function(options) {
  const originalOnShow = options.onShow
  const originalOnHide = options.onHide
  const originalOnUnload = options.onUnload
  options.onShow = function(...args) {
    const app = getApp()
    const pages = getCurrentPages()
    const route = pages[pages.length - 1]?.route || ''
    const whitelisted = _bindWhitelist.some(w => route.includes(w))

    if (!whitelisted && app && app.bindGuard && !app.bindGuard(this)) {
      return
    }

    _Feedback.create(wx, app).consume(this)
    if (originalOnShow) {
      return originalOnShow.apply(this, args)
    }
  }
  options.onHide = function(...args) {
    _Feedback.create(wx, getApp()).hide(this)
    return originalOnHide?.apply(this, args)
  }
  options.onUnload = function(...args) {
    _Feedback.create(wx, getApp()).hide(this)
    return originalOnUnload?.apply(this, args)
  }
  _originalPage(options)
}

App({
  async onLaunch() {
    this.initcloud()

    this.globalData = {
      // 当前用户信息（动态获取）
      currentUser: null,
      // 伴侣信息（动态获取）
      partner: null,
      // 用户信息是否已加载
      userLoaded: false,
      // 用户信息加载Promise
      userLoadPromise: null,

      // 云数据库集合名称
      collectionDishList: 'DishList',
      collectionOrderList: 'OrderList',

      // 应用信息
      appName: 'TandemBite 伴食',
      version: '2.3.1',
      kitchens: [],
      activeKitchenId: '',
      kitchenId: '',

      // 订阅消息模板ID
      notifyTmplIds: [],

      // 菜品分类（从数据库动态加载）
      categories: [],
      categoriesLoaded: false,
    }
  },

  flag: false,

  /**
   * 初始化云开发环境
   */
  async initcloud() {
    const normalinfo = require('./envList.js').envList || []
    if (normalinfo.length != 0 && normalinfo[0].envId != null) {
      wx.cloud.init({
        traceUser: true,
        env: normalinfo[0].envId
      })
      this.cloud = () => {
        return wx.cloud
      }
    } else {
      this.cloud = () => {
        wx.showModal({
          content: '伴食暂时连接不上云环境，请稍后重试',
          showCancel: false
        })
        throw new Error('无云开发环境')
      }
    }
  },

  // 获取云数据库实例
  async database() {
    return (await this.cloud()).database()
  },

  // 加载用户信息（带缓存）
  async loadUserInfo(forceRefresh = false) {
    // 如果已加载且不强制刷新，直接返回
    if (this.globalData.userLoaded && !forceRefresh && Date.now() - (this._sessionAt || 0) < 30000) {
      return {
        currentUser: this.globalData.currentUser,
        partner: this.globalData.partner
      }
    }

    // 如果正在加载中，等待加载完成
    if (this.globalData.userLoadPromise) {
      return this.globalData.userLoadPromise
    }

    // 开始加载
    this.globalData.userLoadPromise = this._doLoadUserInfo().finally(() => {
      this.globalData.userLoadPromise = null
    })
    return this.globalData.userLoadPromise
  },

  // 未配置通知时仍继续点菜、跳转等操作。
  requestSubscribeMessage(options = {}) {
    const tmplIds = this.globalData.notifyTmplIds.filter(id => id && id !== 'your-template-id')
    if (tmplIds.length === 0) {
      const result = { errMsg: '订阅消息尚未配置' }
      if (options.fail) options.fail(result)
      if (options.complete) return options.complete(result)
      return
    }
    return wx.requestSubscribeMessage({ ...options, tmplIds })
  },

  // 实际加载用户信息
  async _doLoadUserInfo() {
    try {
      await this.requestSession({ op: 'session' })
      return { currentUser: this.globalData.currentUser, partner: this.globalData.partner }
    } catch (e) {
      console.error('load user info error', e)
      this.globalData.userLoaded = false
      this.globalData.currentUser = null
      this.globalData.partner = null
      this.globalData.kitchenId = ''
      this.globalData.activeKitchenId = ''
      this.globalData.kitchens = []
      this.globalData.categories = []
      this.globalData.categoriesLoaded = false
      this.invalidateViews()
      return { currentUser: null, partner: null, error: e.message }
    }
  },

  async finishTransition(transition) {
    try {
      let state = transition
      while (!state.done) {
        if (state.pending) {
          wx.hideLoading()
          const a = state.pending.existing, b = state.pending.incoming
          const summary = value => value.dateKey + ' ¥' + (value.amountFen / 100).toFixed(2) + ' ' + (value.note || value.category)
          const confirm = await wx.showModal({ title: '同一笔旧账有不同修改', content: 'A：' + summary(a) + '\nB：' + summary(b) + '\n请核对后选择保留哪一版。只有确为两笔不同支出时，才分别保留。', confirmText: '选择版本', cancelText: '稍后继续' })
          if (!confirm.confirm) throw new Error('整理已暂停，回到首页重新加载可继续，原内容仍保留')
          const result = await wx.showActionSheet({ itemList: ['保留A版本', '保留B版本', '确实是两笔支出，分别保留'] }).catch(() => null)
          if (!result) throw new Error('整理已暂停，回到首页重新加载可继续，原内容仍保留')
          state = await this.api({ op: 'resolveTransition', transitionId: state.transitionId, choice: ['existing', 'incoming', 'both'][result.tapIndex] })
        } else {
          wx.showLoading({ title: '整理小厨房 ' + state.processed + '项', mask: true })
          state = await this.api({ op: 'transition', transitionId: state.transitionId })
        }
      }
      this.globalData.categoriesLoaded = false
    } finally { wx.hideLoading() }
  },

  // 加载分类数据
  async loadCategories(forceRefresh = false) {
    if (!this.globalData.currentUser) await this.loadUserInfo()
    if (!this.globalData.activeKitchenId) return []
    if (this.globalData.categoriesLoaded && !forceRefresh) {
      return this.globalData.categories
    }
    if (this._categoryPromise) return this._categoryPromise
    this._categoryPromise = this._loadCategories().finally(() => { this._categoryPromise = null })
    return this._categoryPromise
  },

  async _loadCategories() {
    try {
      const res = await this.callFunction({
        name: 'manageCategory',
        data: { action: 'ready' }
      })
      if (res.result?.success) {
        this.globalData.categories = res.result.data
        this.globalData.categoriesLoaded = true
        return res.result.data
      }
    } catch (e) {
      console.error('load categories error', e)
    }
    return []
  },

  // 更新用户昵称
  async updateNickname(nickname) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'createUser',
        data: { nickname }
      })
      if (res.result && res.result.success) {
        this.globalData.currentUser = res.result.user
        return true
      }
    } catch (e) {
      console.error('update nickname error', e)
    }
    return false
  },

  // 绑定伴侣
  async bindPartner(inviteCode) {
    try {
      const result = await this.api({ op: 'bind', inviteCode })
      await this.finishTransition(result.transition)
      await this.loadUserInfo(true)
      return { success: true }
    } catch (e) { return { success: false, message: e.message || '绑定未完成，返回首页可继续' } }
  },

  async unbindPartner() {
    try {
      const result = await this.api({ op: 'unbind' })
      await this.finishTransition(result.transition)
      await this.loadUserInfo(true)
      return { success: true }
    } catch (e) { return { success: false, message: e.message || '解绑未完成，返回首页可继续' } }
  },

  // 检查是否已绑定伴侣
  isBound() {
    return !!(this.globalData.currentUser?.bindStatus === 'bound' && this.globalData.partner)
  },

  // 检查用户信息是否完整（有昵称和头像）
  isProfileComplete() {
    const user = this.globalData.currentUser
    return user?.nickname && user?.avatarUrl
  },

  // 页面绑定守卫：仅设置绑定状态到页面 data，不拦截页面展示
  bindGuard(page) {
    page.setData({ isBound: this.isBound(), readOnly: this.isKitchenReadOnly() })
    return true
  },

  // 获取伴侣名字
  getPartnerName() {
    return this.globalData.partner?.nickname || '对方'
  },

  // 获取当前用户名字
  getCurrentUserName() {
    return this.globalData.currentUser?.nickname || '我'
  },

  // 根据 openid 获取显示名称
  getDisplayName(openid) {
    if (openid === this.globalData.currentUser?._id) {
      return '你'
    }
    if (openid === this.globalData.partner?.openid) {
      return this.globalData.partner?.nickname || '对方'
    }
    return '伙伴'
  },

  // 获取厨房名称（自定义或默认）
  getKitchenName() {
    return this.globalData.kitchens.find(k => k._id === this.globalData.activeKitchenId)?.name || '我们的小厨房'
  },

  // 设置页面导航栏标题为厨房名称
  setKitchenTitle() {
    const title = this.getKitchenName()
    wx.setNavigationBarTitle({ title })
  },

  // 临时链接缓存（fileID -> { url, expireTime }）
  _tempUrlCache: {},

  // 批量将 cloud:// fileID 转为临时链接
  async getTempFileURLs(fileIds) {
    if (!fileIds || fileIds.length === 0) return {}

    const now = Date.now()
    const result = {}
    const needFetch = []

    for (const id of fileIds) {
      if (!id || !id.startsWith('cloud://')) continue;
      const cached = this._tempUrlCache[id]
      if (cached && cached.expireTime > now) {
        result[id] = cached.url
      } else {
        needFetch.push(id)
      }
    }

    if (needFetch.length > 0) {
      try {
        const res = await wx.cloud.callFunction({
          name: 'getFileURL',
          data: { fileList: needFetch }
        })
        if (res.result?.success) {
          for (const item of res.result.fileList) {
            if (item.tempFileURL) {
              result[item.fileID] = item.tempFileURL
              // 缓存 1.5 小时（临时链接有效期约 2 小时）
              this._tempUrlCache[item.fileID] = {
                url: item.tempFileURL,
                expireTime: now + 90 * 60 * 1000
              }
            }
          }
        }
      } catch (e) {
        console.error('getTempFileURLs error', e)
      }
    }

    return result
  },

  // 批量转换数组中对象的指定字段为临时链接，原始值保留到 _raw_xxx
  async convertFileURLs(items, fields) {
    const allIds = []
    for (const item of items) {
      for (const field of fields) {
        const val = item[field]
        if (val && val.startsWith('cloud://')) allIds.push(val)
      }
    }
    const urlMap = await this.getTempFileURLs(allIds)
    for (const item of items) {
      for (const field of fields) {
        const raw = item[field]
        if (urlMap[raw] && urlMap[raw] !== raw) {
          item['_raw_' + field] = raw
          item[field] = urlMap[raw]
        }
      }
    }
    return items
  },

  // 更新厨房名称（同步到伴侣）
  async updateKitchenName(name) {
    if (!name || name.length > 8) {
      return { success: false, message: '名称不能超过8个字' }
    }
    try {
      const res = { result: await this.api({ op: 'rename', kitchenId: this.globalData.activeKitchenId, name }) }
      if (res.result?.success) {
        this.globalData.currentUser.kitchenName = name
        const kitchen = this.globalData.kitchens.find(k => k._id === this.globalData.activeKitchenId)
        if (kitchen) kitchen.name = name
        return { success: true }
      }
      return { success: false, message: res.result?.message || '更新失败' }
    } catch (e) {
      console.error('update kitchen name error', e)
      return { success: false, message: '更新失败' }
    }
  },

  requestId() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12) },

  async api(data) {
    const started = Date.now()
    let success = false, serverMs
    try {
      const res = await wx.cloud.callFunction({ name: 'tandem', data })
      if (!res.result?.success) throw new Error(res.result?.message || '暂时连接不上，请重试')
      success = true; serverMs = res.result.serverMs
      if (['foodWrite', 'bind', 'unbind', 'transition', 'resolveTransition', 'rename'].includes(data.op) || (data.op === 'ledger' && !['list', 'stats', 'get'].includes(data.action)) || (data.op === 'category' && !['list', 'ready', 'countDishes'].includes(data.action))) {
        this._writeGeneration = (this._writeGeneration || 0) + 1
        this.invalidateViews()
      }
      return res.result
    } finally {
      this._performance = [...(this._performance || []).slice(-29), { op: data.op, screen: data.screen || '', ms: Date.now() - started, serverMs, success }]
    }
  },

  getPerformanceSummary() { return (this._performance || []).map(item => ({ ...item })) },

  invalidateViews() {
    this._viewGeneration = (this._viewGeneration || 0) + 1
    this._viewCache = {}
    this.globalData.categoriesLoaded = false
  },

  applySession(result) {
    const previous = this.globalData.kitchenId
    if (previous !== result.kitchenId) {
      this.invalidateViews()
      this.globalData.categories = []
      this.globalData.reorderDishIds = null
    }
    for (const item of result.fileList || []) if (item.tempFileURL) this._tempUrlCache[item.fileID] = { url: item.tempFileURL, expireTime: Date.now() + 30 * 60000 }
    const profile = value => value ? { ...value, avatarUrl: this._tempUrlCache[value.avatarUrl]?.url || value.avatarUrl } : null
    Object.assign(this.globalData, { currentUser: profile(result.user), partner: profile(result.partner), kitchenId: result.kitchenId, activeKitchenId: result.kitchenId, kitchens: result.kitchens, userLoaded: true })
    this._sessionAt = Date.now()
    if (result.categories) Object.assign(this.globalData, { categories: result.categories, categoriesLoaded: true })
  },

  async requestSession(payload) {
    let generation = this._writeGeneration || 0
    let result = await this.api(payload)
    if (generation !== (this._writeGeneration || 0)) throw new Error('内容已更新，请重新加载')
    if (result.needsCreate) {
      const created = await wx.cloud.callFunction({ name: 'createUser' })
      if (!created.result?.success) throw new Error('账号加载失败，请重试')
      result = await this.api(payload)
    }
    if (result.transition) {
      await this.finishTransition(result.transition)
      generation = this._writeGeneration || 0
      result = await this.api(payload)
    }
    if (generation !== (this._writeGeneration || 0)) throw new Error('内容已更新，请重新加载')
    if (!result.user || !result.kitchenId || !result.kitchens?.length) throw new Error('厨房状态正在更新，请重新加载')
    this.applySession(result)
    return result
  },

  // 仅在本次运行的内存中保留15秒；写入、切换厨房或下拉刷新均失效。
  async getView(screen, params = {}, force = false) {
    const key = screen + ':' + JSON.stringify(params)
    this._viewCache ||= {}; this._viewPending ||= {}
    const cached = this._viewCache[key]
    const clone = value => JSON.parse(JSON.stringify(value))
    if (screen !== 'ledger' && !force && cached && cached.kitchenId === this.globalData.kitchenId && Date.now() - cached.time < 15000) return clone(cached.result)
    if (this._viewPending[key]) return clone(await this._viewPending[key])
    const pending = this.requestSession({ op: 'view', screen, params }).then(result => {
      if (Object.keys(this._viewCache).length >= 20) this._viewCache = {}
      if (screen !== 'ledger') this._viewCache[key] = { result: clone(result), time: Date.now(), kitchenId: result.kitchenId }
      return result
    })
    this._viewPending[key] = pending
    try { return clone(await pending) }
    finally { if (this._viewPending[key] === pending) delete this._viewPending[key] }
  },

  // 旧页面继续使用原有调用形状；数据归属和所有写入由新版云函数校验。
  async callFunction(options) {
    const ops = { getCoupleData: 'foodRead', updateCoupleData: 'foodWrite', manageCategory: 'category' }
    if (!ops[options.name]) {
      const res = await wx.cloud.callFunction(options)
      if (options.name === 'createUser' && res.result?.success && (options.data?.nickname || options.data?.avatarUrl)) { this.invalidateViews(); this._sessionAt = 0 }
      return res
    }
    if (!this.globalData.activeKitchenId) await this.loadUserInfo()
    const result = await this.api({ ...options.data, op: ops[options.name], kitchenId: this.globalData.activeKitchenId })
    return { result }
  },

  async addKitchenData(collection, data, requestId) {
    return this.api({ op: 'foodWrite', action: 'add', collection, kitchenId: this.globalData.activeKitchenId, data, requestId, countDishes: collection === 'OrderList' })
  },

  isKitchenReadOnly() { return !!this.globalData.kitchens.find(k => k._id === this.globalData.activeKitchenId)?.readOnly },


})
