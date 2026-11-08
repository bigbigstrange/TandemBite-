const app = getApp()
const Feedback = require('../../utils/feedback')
const feedback = Feedback.create(wx, app)

Page({
  greetDog() { feedback.greet(this) },
  data: {
    appName: '',
    userName: '',
    userAvatar: '',
    partnerName: '',
    partnerAvatar: '',
    isBound: false,
    dishCount: 0,
    orderCount: 0,
    showEditModal: false,
    tempNickname: '',
    tempAvatarUrl: '',
    saving: false,
  },

  onLoad(options) {
    if (options.editProfile) {
      this._autoEditProfile = true
    }
  },

  async onShow() {
    try {
      const result = await app.getView('settings')
      await this.loadUserInfo()
      this.loadAppInfo()
      this.setData({ dishCount: result.dishCount, orderCount: result.orderCount })
    } catch (e) { wx.showToast({ title: e.message || '加载失败，请重试', icon: 'none' }); return }
    app.setKitchenTitle()
    if (this._autoEditProfile || app.globalData.editProfile) {
      app.globalData.editProfile = false
      this._autoEditProfile = false
      this.openEditProfile()
    }
  },

  // 加载用户信息
  async loadUserInfo() {
    const { currentUser, partner } = await app.loadUserInfo()
    this.setData({
      userName: currentUser?.nickname || '未设置',
      userAvatar: currentUser?.avatarUrl || '',
      partnerName: partner?.nickname || '',
      partnerAvatar: partner?.avatarUrl || '',
      isBound: app.isBound()
    })
  },

  // 加载应用信息
  loadAppInfo() {
    this.setData({
      appName: app.getKitchenName()
    })
  },

  // 加载统计数据
  async loadStats() {
    try {
      const [dishRes, orderRes] = await Promise.all([
        app.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionDishList, countOnly: true }
        }),
        app.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionOrderList, countOnly: true }
        })
      ])

      this.setData({
        dishCount: dishRes.result?.total || 0,
        orderCount: orderRes.result?.total || 0
      })
    } catch (e) {
      console.error('load stats error', e)
    }
  },

  // 跳转到绑定页面
  goLedger() { wx.switchTab({ url: '/pages/Ledger/index' }) },
  goKitchen() { wx.switchTab({ url: '/pages/Kitchen/index' }) },
  showAbout() { wx.showModal({ title: 'TandemBite 伴食 v2.3.1', content: '好好吃饭，慢慢记账。\n基于 630999Steven/PairBite 二次开发，采用 CC BY-NC-SA 4.0，已修改厨房共享、生活记账与界面。仅限非商业使用。\n原项目：https://github.com/630999Steven/PairBite\n许可：https://creativecommons.org/licenses/by-nc-sa/4.0/', showCancel: false }) },

  async showLoadDiagnostics() {
    const names = { home: '首页', kitchen: '厨房', menu: '菜单', history: '做饭记录', ledger: '账本', settings: '我的' }
    const records = app.getPerformanceSummary().filter(x => x.op === 'view').slice(-8)
    const lines = records.map(x => (names[x.screen] || '页面') + '：总等待 ' + (x.ms / 1000).toFixed(2) + ' 秒；云端处理 ' + (Number.isFinite(x.serverMs) ? (x.serverMs / 1000).toFixed(2) + ' 秒' : '暂无') + (x.success ? '' : '（未成功）'))
    const content = lines.length ? lines.join('\n') + '\n\n仅为本次打开的请求耗时，不含照片下载和界面绘制。总等待还包含网络、调度和冷启动。' : '先打开首页、厨房或账本，再回来查看。'
    const result = await wx.showModal({ title: '加载速度诊断', content, confirmText: '复制结果', cancelText: '关闭' })
    if (result.confirm) wx.setClipboardData({ data: '伴食 v' + app.globalData.version + '\n' + content })
  },

  goToBind() {
    wx.navigateTo({ url: '/pages/Bind/index' })
  },

  // 打开编辑个人信息弹窗
  openEditProfile() {
    this.setData({
      showEditModal: true,
      tempNickname: this.data.userName === '未设置' ? '' : this.data.userName,
      tempAvatarUrl: ''
    })
  },

  // 关闭编辑弹窗
  closeEditModal() {
    this.setData({ showEditModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  // 选择头像
  onChooseAvatar(e) {
    this.setData({ tempAvatarUrl: e.detail.avatarUrl })
  },

  // 输入昵称
  onNicknameInput(e) {
    this.setData({ tempNickname: e.detail.value })
  },

  // 保存个人信息
  async saveProfile() {
    const { tempNickname, tempAvatarUrl, saving } = this.data
    if (saving) return

    const nickname = tempNickname.trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      const profile = { nickname }
      // 如果选择了新头像，上传到云存储
      if (tempAvatarUrl) {
        const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).substr(2)}.jpg`
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath,
          filePath: tempAvatarUrl
        })
        profile.avatarUrl = uploadRes.fileID
      }

      // 调用云函数更新用户信息
      const res = await app.callFunction({
        name: 'createUser',
        data: profile
      })
      if (!res.result?.success) throw new Error(res.result?.error || '保存失败')

      // 刷新用户信息
      await app.loadUserInfo(true)
      await this.loadUserInfo()

      wx.hideLoading()
      this.setData({ showEditModal: false })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('save profile error', e)
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  // 请求订阅消息权限
  requestNotifyPermission() {
    if (app.globalData.notifyTmplIds.length === 0) {
      wx.showToast({ title: '消息通知暂未开通', icon: 'none' })
      return
    }
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      success: (res) => {
        if (res[app.globalData.notifyTmplIds[0]] === 'accept') {
          wx.showToast({ title: '订阅成功', icon: 'success' })
        } else {
          wx.showToast({ title: '需要授权才能收到通知', icon: 'none' })
        }
      },
      fail: () => {
        wx.showToast({ title: '订阅失败', icon: 'none' })
      }
    })
  },

})
