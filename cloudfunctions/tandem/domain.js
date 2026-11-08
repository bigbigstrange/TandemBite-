const crypto = require('crypto')
const EXPENSE_CATEGORIES = ['买菜食材', '餐饮外卖', '交通出行', '日用购物', '居住水电', '休闲娱乐', '医疗健康', '其他']
const INCOME_CATEGORIES = ['工资', '红包', '其他收入']
const DEFAULT_CATEGORIES = [['meat', '荤菜', '🥩'], ['vegetable', '素菜', '🥬'], ['soup', '汤类', '🍲'], ['rice', '主食', '🍚'], ['noodle', '面食', '🍜'], ['cold', '凉菜', '🥗'], ['dessert', '甜点', '🍰'], ['drink', '饮品', '🥤']]
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32) }
function personalId(openid) { return 'p_' + hash(openid) }
function memberKey(openid) { return 'member_' + hash(openid) }
function copyId(kitchenId, sourceId) { return 'copy_' + hash(kitchenId + ':' + sourceId) }
function amountToFen(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value)) throw new Error('请输入大于0、最多两位小数的金额')
  const [yuan, fraction = ''] = value.split('.')
  const fen = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(fen) || fen <= 0) throw new Error('金额必须大于0')
  return fen
}
function validDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00+08:00')
  return Number.isFinite(date.getTime()) && new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) === value
}
function monthRange(month) {
  if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份不正确')
  const year = Number(month.slice(0, 4)), m = Number(month.slice(5))
  return [month + '-01', (m === 12 ? year + 1 : year) + '-' + String(m === 12 ? 1 : m + 1).padStart(2, '0') + '-01']
}
function ledgerFilter(input) {
  let start, end
  if (input.startDate !== undefined || input.endDate !== undefined) {
    if (!validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) throw new Error('请选择正确的起止日期，开始日期不能晚于结束日期')
    start = input.startDate
    end = input.endDate
  } else { const range = monthRange(input.month); start = range[0]; end = range[1] }
  const filtering = input.categories !== undefined
  if (filtering && (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > EXPENSE_CATEGORIES.length || input.categories.some(c => !EXPENSE_CATEGORIES.includes(c)))) throw new Error('请至少选择一个有效的支出分类')
  return { start, end, inclusive: input.startDate !== undefined, categories: filtering ? [...new Set(input.categories)] : null }
}
function entryData(input) {
  if (!['expense', 'income'].includes(input.type)) throw new Error('收支类型不正确')
  if (!(input.type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES).includes(input.category)) throw new Error('分类不正确')
  if (!validDate(input.dateKey)) throw new Error('记账日期不正确')
  if (typeof input.note !== 'string' || input.note.length > 100) throw new Error('备注不能超过100字')
  return { amountFen: amountToFen(input.amount), type: input.type, category: input.category, dateKey: input.dateKey, note: input.note.trim() }
}
function isMember(kitchen, openid) { return !!kitchen && kitchen[memberKey(openid)] === true && kitchen.members.includes(openid) }
module.exports = { EXPENSE_CATEGORIES, INCOME_CATEGORIES, DEFAULT_CATEGORIES, hash, personalId, memberKey, copyId, amountToFen, validDate, monthRange, ledgerFilter, entryData, isMember }
