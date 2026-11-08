const Ring = require('../../utils/ring')
Component({
  properties: { items: { type: Array, value: [], observer() { this.updateChart() } } },
  data: { rows: [], selectedName: '', centerLabel: '支出合计', centerMoney: '0.00', moneySize: 38, canvasReady: true },
  lifetimes: {
    ready() { this._ready = true; this.updateChart() },
    detached() { this._ready = false; this._canvas = null }
  },
  methods: {
    updateChart() {
      const model = Ring.prepare(this.properties.items || [])
      this._model = model
      const selected = model.rows.find(row => row.name === this.data.selectedName)
      const centerMoney = selected?.amount || model.totalText
      this.setData({ rows: model.rows, selectedName: selected?.name || '', centerLabel: selected?.name || '支出合计', centerMoney, moneySize: centerMoney.length > 11 ? 25 : centerMoney.length > 8 ? 30 : 38 }, () => { if (this._ready) this.draw() })
    },
    selectCategory(e) {
      const name = e.currentTarget.dataset.name, selectedName = this.data.selectedName === name ? '' : name
      const selected = this._model?.rows.find(row => row.name === selectedName)
      const centerMoney = selected?.amount || this._model?.totalText || '0.00'
      this.setData({ selectedName: selected?.name || '', centerLabel: selected?.name || '支出合计', centerMoney, moneySize: centerMoney.length > 11 ? 25 : centerMoney.length > 8 ? 30 : 38 }, () => this.draw())
    },
    draw() {
      if (!this._ready) return
      this.createSelectorQuery().select('#ring-canvas').fields({ node: true, size: true }).exec(result => {
        if (!this._ready) return
        const box = result?.[0]
        if (!box?.node || !box.width || !box.height) { this.setData({ canvasReady: false }); return }
        try {
          const canvas = box.node, context = canvas.getContext('2d')
          const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio
          canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr)
          context.scale(dpr, dpr)
          Ring.draw(context, box.width, box.height, this._model, this.data.selectedName)
          if (!this.data.canvasReady) this.setData({ canvasReady: true })
        } catch (_) { this.setData({ canvasReady: false }) }
      })
    }
  }
})
