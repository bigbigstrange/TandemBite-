const EXPENSE_CATEGORIES = ['买菜食材', '餐饮外卖', '交通出行', '日用购物', '居住水电', '休闲娱乐', '医疗健康', '其他']
const INCOME_CATEGORIES = ['工资', '红包', '其他收入']
const ICONS = ['🥕', '🍜', '🚌', '🛍️', '🏡', '☕', '🩺', '📝']
const ICON_NAMES = ['carrot', 'utensils', 'bus', 'shopping-bag', 'house', 'coffee', 'heart-pulse', 'ellipsis']
const money = fen => (fen / 100).toFixed(2)
function dateKey(date = new Date()) { return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) }
function totals(groups, peopleGroups) {
  const result = { expense: 0, income: 0, categories: [], people: [] }, categories = {}, people = {}
  for (const group of groups) {
    result[group._id.type] += group.amountFen
    if (group._id.type === 'expense') {
      categories[group._id.category] = (categories[group._id.category] || 0) + group.amountFen
      const id = group._id.creatorId
      if (id) {
        if (!people[id]) people[id] = { id, name: group.creatorName || '伙伴', amount: 0 }
        people[id].amount += group.amountFen
      }
    }
  }
  result.categories = Object.keys(categories).map(name => ({ name, amountFen: categories[name], amount: money(categories[name]), percent: result.expense ? Math.round(categories[name] / result.expense * 100) : 0 })).sort((a, b) => b.amountFen - a.amountFen)
  result.people = peopleGroups ? peopleGroups.map(p => ({ id: p._id.creatorId, name: p.creatorName || '伙伴', amount: money(p.amountFen) })) : Object.values(people).map(p => ({ ...p, amount: money(p.amount) }))
  return { ...result, expenseText: money(result.expense), incomeText: money(result.income), netText: money(result.income - result.expense) }
}
function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}
function toCSV(rows) {
  return '\uFEFF' + [['日期', '收支类型', '分类', '金额（元）', '备注', '创建人', '最近修改人'], ...rows.map(row => [row.dateKey, row.type === 'income' ? '收入' : '支出', row.category, money(row.amountFen), row.note, row.creatorName, row.updatedByName])].map(row => row.map(csvCell).join(',')).join('\r\n')
}
module.exports = { EXPENSE_CATEGORIES, INCOME_CATEGORIES, ICONS, ICON_NAMES, money, dateKey, totals, toCSV }
