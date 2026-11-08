const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
function fixture() {
  let caller = 'alice', sequence = 0, data = new Map(), queue = Promise.resolve()
  const clone = value => structuredClone(value)
  const col = name => { if (!data.has(name)) data.set(name, new Map()); return data.get(name) }
  for (const [id, inviteCode] of [['alice', 'ABC234'], ['bob', 'DEF567'], ['cara', 'GHJ789']]) col('User').set(id, { _id: id, nickname: id, inviteCode, partnerId: '', coupleId: '', bindStatus: 'unbound' })
  const cmp = (kind, value) => ({ kind, value, and(other) { return { kind: 'and', list: [this, other] } } })
  const command = { gte: v => cmp('gte', v), lte: v => cmp('lte', v), lt: v => cmp('lt', v), in: v => cmp('in', v), inc: v => cmp('inc', v), aggregate: { sum: v => ({ sum: v }), first: v => ({ first: v }) } }
  function matches(doc, where) {
    function pass(value, expected) {
      if (!expected || typeof expected !== 'object' || expected instanceof Date) return value === expected
      if (expected.kind === 'gte') return value >= expected.value
      if (expected.kind === 'lt') return value < expected.value
      if (expected.kind === 'lte') return value <= expected.value
      if (expected.kind === 'in') return expected.value.includes(value)
      if (expected.kind === 'and') return expected.list.every(e => pass(value, e))
      return value === expected
    }
    return Object.entries(where).every(([key, value]) => pass(doc[key], value))
  }
  const update = (doc, changes) => { for (const [k, v] of Object.entries(changes)) doc[k] = v?.kind === 'inc' ? (doc[k] || 0) + v.value : clone(v) }
  function collection(name) {
    let filter = {}, skip = 0, limit = Infinity, sorts = []
    const selected = () => Array.from(col(name).values()).filter(d => matches(d, filter)).sort((a, b) => {
      for (const [key, direction] of sorts) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'asc' ? 1 : -1)
      return 0
    }).slice(skip, skip + limit)
    return {
      where(value) { filter = value; return this }, orderBy(key, direction) { sorts.push([key, direction]); return this }, skip(value) { skip = value; return this }, limit(value) { limit = value; return this },
      async get() { return { data: clone(selected()) } }, async count() { return { total: selected().length } },
      async update({ data: changes }) { const rows = selected(); rows.forEach(d => update(d, changes)); return { stats: { updated: rows.length } } },
      async add({ data: document }) { const id = document._id || 'auto' + (++sequence); col(name).set(id, { ...clone(document), _id: id }); return { _id: id } },
      doc(id) { if (typeof id !== 'string') throw new Error('missing document id'); return {
        async get() { return { data: clone(col(name).get(id)) } },
        async set({ data: document }) { col(name).set(id, { ...clone(document), _id: id }); return { _id: id } },
        async update({ data: changes }) { const doc = col(name).get(id); if (!doc) throw new Error('not found'); update(doc, changes); return { stats: { updated: 1 } } },
        async remove() { return { stats: { removed: col(name).delete(id) ? 1 : 0 } } }
      } },
      aggregate() { let where = {}, group, max = Infinity; return {
        match(value) { where = value; return this }, group(value) { group = value; return this }, limit(value) { max = value; return this },
        async end() { const groups = new Map(); for (const row of col(name).values()) if (matches(row, where)) {
          const id = Object.fromEntries(Object.entries(group._id).map(([k, v]) => [k, row[v.slice(1)]])), key = JSON.stringify(id)
          if (!groups.has(key)) groups.set(key, { _id: id, creatorName: row.creatorName, amountFen: 0, count: 0 })
          groups.get(key).amountFen += row.amountFen; groups.get(key).count++
        } return { list: Array.from(groups.values()).slice(0, max) } }
      } }
    }
  }
  const db = { collection, command, serverDate: () => new Date(), runTransaction(fn) {
    const result = queue.then(async () => { const before = clone(data); try { return await fn(db) } catch (e) { data = before; throw e } })
    queue = result.catch(() => {}); return result
  } }
  const sdk = { init() {}, database: () => db, getWXContext: () => ({ OPENID: caller }), getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(fileID => ({ fileID, tempFileURL: 'https://files.test/' + encodeURIComponent(fileID) })) }) }
  const filename = path.resolve(__dirname, '../../cloudfunctions/tandem/index.js'), localRequire = createRequire(filename), exports = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, require: id => id === 'wx-server-sdk' ? sdk : localRequire(id), console: { error() {} } }, { filename })
  const call = async (openid, event) => { caller = openid; return exports.main(event) }
  async function complete(openid, event, choice) {
    let result = await call(openid, event)
    if (!result.success || !result.transition) return result
    let state = result.transition
    for (let i = 0; !state.done && i < 2000; i++) {
      if (state.pending && !choice) throw new Error('merge conflict needs a choice')
      state = await call(openid, { op: state.pending ? 'resolveTransition' : 'transition', transitionId: state.transitionId, choice })
      if (!state.success) throw new Error(state.message)
    }
    if (!state.done) throw new Error('transition did not finish')
    return call(openid, { op: 'bootstrap' })
  }
  return { call, complete, col, db }
}

module.exports = fixture
