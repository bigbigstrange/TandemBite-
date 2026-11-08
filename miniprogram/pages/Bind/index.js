const app = getApp()

Page({
  data: {
    inviteCode: '',
    inputCode: '',
    nickname: '',
    avatarUrl: '',
    partnerNickname: '',
    partnerAvatarUrl: '',
    bindStatus: 'unbound',
    bindDays: 0,
    bindDate: '',
    dishCount: 0,
    orderCount: 0,
    kitchenName: '',
    tempKitchenName: '',
    showKitchenNameModal: false,
    loading: true,
    submitting: false,
    statusBarHeight: 20,
  },

  onLoad() {
    const sysInfo = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sysInfo.statusBarHeight })
  },

  async onShow() {
    await this.loadUserInfo()

    // 如果有待绑定的邀请码（从分享链接进入），自动执行绑定
    if (app.globalData.pendingInviteCode && this.data.bindStatus !== 'bound') {
      this.setData({ inputCode: app.globalData.pendingInviteCode })
      app.globalData.pendingInviteCode = null
    }
  },

  // 加载用户信息

  async loadUserInfo() {
    this.setData({ loading: true })
    const { currentUser, partner } = await app.loadUserInfo(true)

    // 计算绑定天数和日期
    let bindDays = 0
    let bindDate = ''
    if (currentUser?.bindStatus === 'bound' && currentUser?.bindTime) {
      const bindTime = new Date(currentUser.bindTime)
      const now = new Date()
      bindDays = Math.floor((now - bindTime) / (1000 * 60 * 60 * 24)) + 1
      bindDate = `${bindTime.getFullYear()}年${bindTime.getMonth() + 1}月${bindTime.getDate()}日`
    }

    this.setData({
      loading: false,
      inviteCode: currentUser?.inviteCode || '',
      nickname: currentUser?.nickname || '',
      avatarUrl: currentUser?.avatarUrl || '',
      bindStatus: currentUser?.bindStatus || 'unbound',
      bindDays,
      bindDate,
      kitchenName: app.getKitchenName(),
      partnerNickname: partner?.nickname || '',
      partnerAvatarUrl: partner?.avatarUrl || ''
    })

    // 已绑定时加载统计数据
    if (currentUser?.bindStatus === 'bound') {
      this.loadStats()
    }
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
      console.error('loadStats error', e)
    }
  },

  // 输入邀请码
  onInputCode(e) {
    this.setData({ inputCode: e.detail.value.toUpperCase() })
  },

  // 绑定伴侣
  async bindPartner() {
    const { inputCode, submitting } = this.data
    if (submitting || !inputCode || inputCode.length !== 6) {
      wx.showToast({ title: '请输入6位邀请码', icon: 'none' })
      return
    }

    const confirmation = await wx.showModal({ title: '一起使用这个小厨房？', content: '双方已有菜品、做饭记录和历史账目将合并，之后共同查看、修改和删除。解绑时双方各保留完整副本，停止同步。整理期间请稍候。' })
    if (!confirmation.confirm) return
    this.setData({ submitting: true })
    wx.showLoading({ title: '绑定中...', mask: true })

    const result = await app.bindPartner(inputCode)

    if (result.success) {
      // 刷新页面显示已绑定状态
      await app.loadUserInfo(true)
      await this.loadUserInfo()
      wx.hideLoading()
      wx.showToast({ title: '我们的小厨房准备好啦', icon: 'none' })
      // 绑定成功后立即请求通知授权，为接收伴侣点菜通知积攒额度
      app.requestSubscribeMessage({
        tmplIds: app.globalData.notifyTmplIds,
        complete: () => {}
      })
    } else {
      wx.hideLoading()
      wx.showToast({ title: result.message, icon: 'none' })
    }
    this.setData({ submitting: false })
  },

  // 解除绑定
  unbindPartner() {
    wx.showModal({
      title: '确认解绑',
      content: '双方各保留当前菜品、做饭记录和账目的完整副本。之后各自使用，新增或修改不再同步。确定解除绑定？',
      confirmColor: '#E57373',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '解绑中...', mask: true })
          const result = await app.unbindPartner()
          if (result.success) {
            await this.loadUserInfo()
            wx.hideLoading()
            wx.showToast({ title: '已解绑', icon: 'success' })
          } else {
            wx.hideLoading()
            wx.showToast({ title: result.message, icon: 'none' })
          }
        }
      }
    })
  },

  // 复制邀请码
  copyInviteCode() {
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => {
        wx.showToast({ title: '已复制邀请码', icon: 'success' })
      }
    })
  },

  // 分享邀请链接
  onShareAppMessage() {
    const { inviteCode, nickname } = this.data
    return {
      title: `${nickname || '我'}邀请你一起使用 TandemBite 伴食`,
      path: `/pages/MainPage/index?inviteCode=${inviteCode}`,
      imageUrl: '/images/tandem/brand.jpg'
    }
  },

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  // 显示修改厨房名称弹窗
  showKitchenNameModal() {
    this.setData({
      showKitchenNameModal: true,
      tempKitchenName: this.data.kitchenName
    })
  },

  // 隐藏弹窗
  hideKitchenNameModal() {
    this.setData({ showKitchenNameModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  // 输入厨房名称
  onKitchenNameInput(e) {
    let value = e.detail.value
    if (value.length > 8) value = value.slice(0, 8)
    this.setData({ tempKitchenName: value })
    return value
  },

  // 保存厨房名称
  async saveKitchenName() {
    const { tempKitchenName } = this.data
    if (!tempKitchenName.trim()) {
      wx.showToast({ title: '请输入厨房名称', icon: 'none' })
      return
    }
    if (tempKitchenName.length > 8) {
      wx.showToast({ title: '名称不能超过8个字', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...' })
    const result = await app.updateKitchenName(tempKitchenName.trim())
    wx.hideLoading()

    if (result.success) {
      this.setData({
        kitchenName: tempKitchenName.trim(),
        showKitchenNameModal: false
      })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } else {
      wx.showToast({ title: result.message, icon: 'none' })
    }
  },
})
