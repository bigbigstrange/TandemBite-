const L = require('./ledger')
const COLORS = ['#728F73', '#C4A273', '#7E9FA5', '#B88770', '#9283A1', '#A3A16F', '#BD91A6', '#99998D']
function prepare(items) {
  const rows = items.filter(item => Number.isSafeInteger(item.amountFen) && item.amountFen > 0).map(item => ({ ...item, amount: L.money(item.amountFen), color: COLORS[Math.max(0, L.EXPENSE_CATEGORIES.indexOf(item.name))] }))
  const total = rows.reduce((sum, item) => sum + item.amountFen, 0)
  let angle = -Math.PI / 2
  const segments = rows.map(item => {
    const start = angle
    angle += item.amountFen / total * Math.PI * 2
    return { ...item, percentText: (item.amountFen / total * 100).toFixed(1), start, end: angle }
  })
  return { rows: segments, total, totalText: L.money(total) }
}
function draw(ctx, width, height, model, selected = '') {
  ctx.clearRect(0, 0, width, height)
  const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * .365
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = '#E9DDCA'; ctx.lineWidth = Math.min(width, height) * .11; ctx.globalAlpha = 1; ctx.stroke()
  for (const row of model.rows) {
    ctx.beginPath(); ctx.arc(cx, cy, radius, row.start, row.end)
    ctx.strokeStyle = row.color
    ctx.lineWidth = Math.min(width, height) * (selected === row.name ? .135 : .11)
    ctx.globalAlpha = selected && selected !== row.name ? .35 : 1
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}
module.exports = { prepare, draw, COLORS }
