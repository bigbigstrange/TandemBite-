const app = getApp()
const Drafts = require('../../utils/drafts.js')
const DishTools = require('../../utils/dish-tools.js')
const drafts = Drafts.create(wx, app)
const photos = DishTools.create(wx, app)
const Feedback = require('../../utils/feedback')
const feedback = Feedback.create(wx, app)
const {
  DIFFICULTY_OPTIONS,
  COOK_TIME_OPTIONS,
  DEFAULT_COOK_TIME_INDEX,
  matchCookTimeIndex,
  estimateHeight,
} = require('../../utils/recipe.js')

Page({
  data: {
    _id: '',
    name: '',
    description: '',
    imageUrl: '',
    rawImageUrl: '',
    tempFilePath: '',
    isEdit: false,
    categories: [],
    categoryIndex: 0,
    saving: false,
    categoryId: '', draftMessage: '', draftBlocked: false, photoDraftMissing: false,

    // 菜谱字段（可选填）
    ingredients: '',
    steps: '',
    cookTime: COOK_TIME_OPTIONS[DEFAULT_COOK_TIME_INDEX].label,
    cookTimeOptions: COOK_TIME_OPTIONS,
    cookTimeIndex: DEFAULT_COOK_TIME_INDEX,
    difficulty: '简单',
    difficultyOptions: DIFFICULTY_OPTIONS,
    difficultyIndex: 0,
    ingredientsHeight: 80,
    stepsHeight: 80,
  },

  async onLoad(options) {
    this._opening = true
    this.options = options
    await app.loadCategories()
    this.setData({ categories: app.globalData.categories })
    if (!options.id) this.setData({ categoryId: this.data.categories[0]?._id || '' })
    if (options.id) {
      this.setData({ _id: options.id, isEdit: true })
      wx.setNavigationBarTitle({ title: '编辑菜品' })
      // 编辑模式直接在 onLoad 里把字段回填，避免 onShow 早于 onLoad 完成的竞态
      if (!await this.loadDish()) { this._loadFailed = true; this._opening = false; return }
    }
    this._requestId = app.requestId()
    drafts.open(this, { kind: 'dish', id: this.data._id, base: this._baseRevision || 'new', fields: ['name', 'description', 'categoryId', 'ingredients', 'steps', 'cookTime', 'cookTimeIndex', 'difficulty', 'difficultyIndex', 'tempFilePath', 'imageUrl', 'rawImageUrl', 'photoDraftMissing'] })
    await drafts.checkPhoto(this)
    const index = this.data.categories.findIndex(c => c._id === this.data.categoryId)
    this.setData({ categoryIndex: index, ingredientsHeight: estimateHeight(this.data.ingredients), stepsHeight: estimateHeight(this.data.steps) })
    this._opening = false
  },
  onHide() { drafts.flush(this) },
  onUnload() { drafts.dispose(this) },
  viewDraft() { drafts.inspect(this) },
  async discardDraft() {
    if (this.data.saving || this._opening) return
    drafts.clear(this); drafts.dispose(this)
    if (this.data.isEdit) { if (!await this.loadDish()) { this._loadFailed = true; return } } else { this.resetForm(); return }
    drafts.open(this, { kind: 'dish', id: this.data._id, base: this._baseRevision || 'new', fields: ['name', 'description', 'categoryId', 'ingredients', 'steps', 'cookTime', 'cookTimeIndex', 'difficulty', 'difficultyIndex', 'tempFilePath', 'imageUrl', 'rawImageUrl'] })
  },

  // 加载菜品信息（编辑模式）
  async loadDish() {
    try {
      const res = await app.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          docId: this.data._id
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }

      const dish = res.result.data
      this._loadFailed = false
      this._uploadedImage = null
      this._baseRevision = Drafts.revision(dish)
      const rawImageUrl = dish.imageUrl || ''
      const urls = await app.getTempFileURLs([rawImageUrl])
      const categoryIndex = this.data.categories.findIndex(c => c._id === dish.category)
      const difficulty = dish.difficulty && DIFFICULTY_OPTIONS.includes(dish.difficulty)
        ? dish.difficulty
        : '简单'
      const cookTimeIndex = matchCookTimeIndex(dish.cookTime)
      this.setData({
        name: dish.name,
        description: dish.description || '',
        imageUrl: urls[rawImageUrl] || rawImageUrl,
        rawImageUrl,
        tempFilePath: '', photoDraftMissing: false,
        categoryId: dish.category,
        categoryIndex,
        ingredients: dish.ingredients || '',
        steps: dish.steps || '',
        cookTime: COOK_TIME_OPTIONS[cookTimeIndex].label,
        cookTimeIndex,
        difficulty,
        difficultyIndex: DIFFICULTY_OPTIONS.indexOf(difficulty),
        ingredientsHeight: estimateHeight(dish.ingredients),
        stepsHeight: estimateHeight(dish.steps),
      })
      return true
    } catch (e) {
      console.error('加载菜品失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
      return false
    }
  },

  // 输入菜品名称
  onNameInput(e) {
    let value = e.detail.value
    if (value.length > 20) value = value.slice(0, 20)
    this.setData({ name: value })
    return value
  },

  // 输入菜品描述
  onDescInput(e) {
    let value = e.detail.value
    if (value.length > 6) value = value.slice(0, 6)
    this.setData({ description: value })
    return value
  },

  // 选择分类
  onCategoryChange(e) {
    this.setData({ categoryIndex: e.detail.value, categoryId: this.data.categories[e.detail.value]?._id || '' })
  },

  // 菜谱字段输入
  onIngredientsInput(e) {
    const v = e.detail.value
    this.setData({ ingredients: v, ingredientsHeight: estimateHeight(v) })
  },
  onStepsInput(e) {
    const v = e.detail.value
    this.setData({ steps: v, stepsHeight: estimateHeight(v) })
  },
  onDifficultyChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ difficultyIndex: idx, difficulty: DIFFICULTY_OPTIONS[idx] })
  },
  onCookTimeChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ cookTimeIndex: idx, cookTime: COOK_TIME_OPTIONS[idx].label })
  },

  // 清空已选的图片
  clearImage() {
    if (this.data.saving || this.data.draftBlocked) return
    this._uploadedImage = null
    this.setData({ imageUrl: '', rawImageUrl: '', tempFilePath: '', photoDraftMissing: false })
  },

  // 选择图片
  async chooseImage() {
    if (this.data.saving || this._opening || this.data.draftBlocked) return
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] })
      const file = res.tempFiles?.[0]
      if (!file) return
      if (file.size > 10 * 1024 * 1024) throw new Error('请选一张小于10MB的照片')
      const selectedPath = file.tempFilePath
      const info = wx.getImageInfo ? await wx.getImageInfo({ src: selectedPath }).catch(() => null) : null
      const scale = info ? Math.min(1, 1280 / Math.max(info.width, info.height)) : 1
      const dimensions = info && scale < 1 ? { compressedWidth: Math.max(1, Math.round(info.width * scale)), compressedHeight: Math.max(1, Math.round(info.height * scale)) } : {}
      const compressed = wx.compressImage ? await wx.compressImage({ src: selectedPath, quality: 80, ...dimensions }).catch(() => null) : null
      const tempFilePath = await drafts.keepPhoto(this, compressed?.tempFilePath || selectedPath)
      this._uploadedImage = null
      this.setData({ tempFilePath, imageUrl: tempFilePath, photoDraftMissing: false })
      drafts.flush(this)
    } catch (e) {
      if (!(e.errMsg || '').includes('cancel')) wx.showToast({ title: e.message || '照片没选好，请再试一次', icon: 'none' })
    }
  },

  previewPhoto() { return photos.preview(this.data.imageUrl) },

  // 上传图片到云存储
  async uploadImage() {
    if (!this.data.tempFilePath) return ''
    if (this._uploadedImage?.path === this.data.tempFilePath) return this._uploadedImage.fileId
    const extension = this.data.tempFilePath.match(/\.(png|jpe?g|webp)$/i)?.[1] || 'jpg'
    const cloudPath = `dishes/${app.globalData.kitchenId}/${app.requestId()}.${extension}`

    try {
      const res = await wx.cloud.uploadFile({
        cloudPath,
        filePath: this.data.tempFilePath
      })
      this._uploadedImage = { path: this.data.tempFilePath, fileId: res.fileID }
      drafts.flush(this)
      return res.fileID
    } catch (e) {
      console.error('上传图片失败', e)
      throw new Error('图片上传失败')
    }
  },

  // 保存菜品
  async saveDish() {
    if (this._opening || this._loadFailed || this.data.draftBlocked) return
    if (this.data.photoDraftMissing) return wx.showToast({ title: '请重新选择或清除已失效的照片', icon: 'none' })
    if (app.isKitchenReadOnly()) {
      wx.showToast({ title: '历史厨房只能查看', icon: 'none' })
      return
    }

    const { name, saving, isEdit, _id } = this.data

    if (saving) return

    if (!name.trim()) {
      wx.showToast({ title: '请输入菜品名称', icon: 'none' })
      return
    }
    if (!this.data.categories.some(c => c._id === this.data.categoryId)) {
      wx.showToast({ title: '请选择菜品分类，原分类可能已调整', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })

    try {
      let imageUrl = this.data.rawImageUrl || this.data.imageUrl

      // 如果有新选择的图片，上传新图片
      if (this.data.tempFilePath) {
        imageUrl = await this.uploadImage()
      }

      const category = this.data.categoryId
      if (!category) throw new Error('请先在类目管理中添加分类')

      // 菜谱字段：有食材或步骤就视为填了；否则各字段写空，避免默认值污染
      const hasRecipe = !!(this.data.ingredients.trim() || this.data.steps.trim())
      const baseData = {
        name: name.trim(),
        description: this.data.description.trim(),
        imageUrl,
        category,
        ingredients: hasRecipe ? this.data.ingredients.trim() : '',
        steps: hasRecipe ? this.data.steps.trim() : '',
        cookTime: hasRecipe ? this.data.cookTime : '',
        difficulty: hasRecipe ? this.data.difficulty : '',
      }

      if (isEdit) {
        drafts.flush(this)
        // 编辑模式：更新现有记录
        const res = await app.callFunction({
          name: 'updateCoupleData',
          data: {
            collection: app.globalData.collectionDishList,
            docId: _id,
            expectedRevision: this._baseRevision,
            action: 'update',
            data: { ...baseData, updateTime: new Date() }
          }
        })

        wx.hideLoading()

        if (!res.result?.success) {
          wx.showToast({ title: res.result?.message || '修改失败', icon: 'none' })
          this.setData({ saving: false })
          return
        }

        feedback.success(this, '这道菜，更新好啦', true)
      } else {
        // 新增模式（带上 coupleId）
        this._requestId = this._requestId || app.requestId()
        drafts.flush(this)
        await app.addKitchenData(app.globalData.collectionDishList, baseData, this._requestId)
        wx.hideLoading()
        feedback.success(this, '喜欢的味道，存好啦', true)
      }

      drafts.clear(this)
      setTimeout(() => {
        wx.navigateBack()
      }, 400)

    } catch (e) {
      console.error('保存失败', e)
      wx.hideLoading()
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  // 重置表单
  resetForm() {
    if (this.data.saving || this._opening) return
    drafts.clear(this); drafts.dispose(this)
    this._uploadedImage = null
    this._requestId = app.requestId()
    this.setData({
      name: '',
      description: '',
      imageUrl: '',
      rawImageUrl: '',
      tempFilePath: '',
      photoDraftMissing: false,
      categoryId: this.data.categories[0]?._id || '',
      categoryIndex: 0,
      ingredients: '',
      steps: '',
      cookTime: COOK_TIME_OPTIONS[DEFAULT_COOK_TIME_INDEX].label,
      cookTimeIndex: DEFAULT_COOK_TIME_INDEX,
      difficulty: '简单',
      difficultyIndex: 0,
      ingredientsHeight: 80,
      stepsHeight: 80,
    })
    drafts.open(this, { kind: 'dish', id: this.data._id, base: this._baseRevision || 'new', fields: ['name', 'description', 'categoryId', 'ingredients', 'steps', 'cookTime', 'cookTimeIndex', 'difficulty', 'difficultyIndex', 'tempFilePath', 'imageUrl', 'rawImageUrl', 'photoDraftMissing'] })
  },
})
