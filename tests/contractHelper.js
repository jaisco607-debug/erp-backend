// Test helper: a customer's (overhead) yarn only comes in on an overhead contract, so tests that add such an entry get a big contract line for that customer + yarn count.
const cache = new WeakMap();

/** The id of an active overhead contract line (a very large quantity) of `customerId` for the yarn count of `item`; made once per api and customer / count. */
async function overheadLine(api, customerId, item) {
  const yarnCountId = item.yarnCountId || (item.yarnCount && item.yarnCount.id);
  const map = cache.get(api) || new Map();
  cache.set(api, map);
  const key = `${customerId}:${yarnCountId}`;
  if (!map.has(key)) {
    const c = await api('post', '/weaving/yarn-contracts', { kind: 'OVERHEAD', customerId, taxPercent: 0, lines: [{ yarnCountId, lbs: 900000000 }] });
    if (c.status !== 201) throw new Error(`contract helper: ${JSON.stringify(c.body)}`);
    map.set(key, c.body.lines[0].id);
  }
  return map.get(key);
}

/** `body` of a yarn inward with the contract line added when it is a customer (overhead) entry that has none. */
async function withContract(api, item, body) {
  if (body.customerId && !body.contractLineId) return { ...body, contractLineId: await overheadLine(api, body.customerId, item) };
  return body;
}

module.exports = { overheadLine, withContract };
