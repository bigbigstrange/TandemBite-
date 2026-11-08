const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID
  const { collection, docId, action, data } = event

  if (!currentOpenid || !['DishList', 'OrderList'].includes(collection) || typeof docId !== 'string' || !docId) {
    return { success: false, message: '不支持的操作对象' }
  }
  if (action !== 'remove') {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0 ||
        Object.keys(data).some(key => /(^_|\.|\$)/.test(key) || ['coupleId', 'createTime'].includes(key))) {
      return { success: false, message: '不允许修改归属信息或无效字段' }
    }
    if (action === 'inc' && (collection !== 'DishList' || Object.keys(data).some(key => key !== 'orderCount') ||
        !Number.isSafeInteger(data.orderCount) || data.orderCount <= 0)) {
      return { success: false, message: '无效的点菜次数' }
    }
  }

  try {
    // 获取当前用户信息
    const userRes = await db.collection('User').doc(currentOpenid).get()
    const currentUser = userRes.data
    if (currentUser?.pendingTransitionId || currentUser?.schemaVersion === 3) return { success: false, message: '厨房已升级，请使用伴食2.1.0体验版' }

    if (!currentUser) {
      return { success: false, message: '用户不存在' }
    }

    // 获取当前 coupleId
    const coupleId = currentUser.coupleId
    if (!coupleId) return { success: false, message: '请先绑定伴侣' }

    // 验证文档是否属于当前 coupleId
    if (docId) {
      const docRes = await db.collection(collection).doc(docId).get()
      const doc = docRes.data
      if (doc.coupleId !== coupleId) {
        return { success: false, message: '无权操作' }
      }
    }

    // 执行操作
    let result
    switch (action) {
      case 'update':
        result = await db.collection(collection).doc(docId).update({ data })
        return { success: true, updated: result.stats.updated }

      case 'remove':
        result = await db.collection(collection).doc(docId).remove()
        return { success: true, removed: result.stats.removed }

      case 'inc':
        // 特殊操作：自增字段
        const incData = {}
        for (const key in data) {
          incData[key] = _.inc(data[key])
        }
        result = await db.collection(collection).doc(docId).update({ data: incData })
        return { success: true, updated: result.stats.updated }

      default:
        return { success: false, message: '不支持的操作' }
    }
  } catch (e) {
    console.error('updateCoupleData error', e)
    return { success: false, message: '操作失败', error: e.message }
  }
}
