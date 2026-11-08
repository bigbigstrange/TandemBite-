const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
module.exports = function client(file, app, wx = {}) {
  if (app) {
    if (!app.callFunction && wx.cloud?.callFunction) app.callFunction = wx.cloud.callFunction
    app.isKitchenReadOnly ||= () => false
    app.requestId ||= () => 'request_test_123'
  }
  let definition
  const filename = path.resolve(__dirname, '../../miniprogram', file)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    App: value => { definition = value }, Page: value => { definition = value }, Component: value => { definition = value },
    getApp: () => app, getCurrentPages: () => [], wx, console: { error() {}, log() {}, warn() {} },
    require: createRequire(filename), setTimeout: callback => callback()
  }, { filename })
  definition.setData = function (data) {
    for (const [key, value] of Object.entries(data)) {
      const parts = key.split('.'); let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part] ||= {}
      target[parts.at(-1)] = value
    }
  }
  return definition
}
