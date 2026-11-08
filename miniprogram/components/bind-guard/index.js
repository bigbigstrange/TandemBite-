Component({
  data: {
    show: false,
    type: '' // 'profile' 或 'bind'
  },
  pageLifetimes: {
    show() {
      const app = getApp()
      if (!app) return
      if (app.globalData.currentUser && !app.isProfileComplete()) {
        this.setData({ show: true, type: 'profile' })
      } else {
        this.setData({ show: false, type: '' })
      }
    }
  },
  methods: {
    goToBind() {
      wx.navigateTo({ url: '/pages/Bind/index' })
    },
    goToSetProfile() {
      getApp().globalData.editProfile = true
      wx.switchTab({ url: '/pages/Settings/index' })
    }
  }
})
