// Sanity check BEFORE benchmarking: both APIs must return exactly the same data
// for each scenario. Run from the load-generator laptop (or the server itself).
//
//   node scripts/verify-equivalence.js --rest http://192.168.1.20:3000 --graphql http://192.168.1.20:4000
import { isDeepStrictEqual } from 'node:util';
import { QUERIES, restNested } from './queries.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const REST = arg('rest', 'http://localhost:3000');
const GQL = arg('graphql', 'http://localhost:4000');
const LIMIT = Number(arg('limit', 100));

const getJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};
const gql = async (query, variables) => {
  const r = await fetch(`${GQL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
};

const checks = [];
for (const id of [1, 137, 1000]) {
  checks.push(['simple', id, await getJson(`${REST}/users/${id}`), (await gql(QUERIES.simple, { id })).user]);
  checks.push(['nested', id, await restNested(getJson, REST, id), (await gql(QUERIES.nested, { id })).user]);
}
for (const offset of [0, 4321]) {
  checks.push([
    'list',
    offset,
    await getJson(`${REST}/posts?limit=${LIMIT}&offset=${offset}`),
    (await gql(QUERIES.list, { limit: LIMIT, offset })).posts,
  ]);
}

let failed = 0;
for (const [scenario, key, rest, graph] of checks) {
  const ok = isDeepStrictEqual(rest, graph);
  if (!ok) failed++;
  const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${scenario.padEnd(7)} key=${String(key).padEnd(5)} ` +
    `payload REST=${bytes(rest)} B, GraphQL(data)=${bytes(graph)} B`);
}
for (const base of [REST, GQL]) {
  const info = await getJson(`${base}/__info`);
  console.log(`${info.api}: Node ${info.node}, ${info.cpuModel}, ${info.logicalCores} cores, ` +
    `${info.totalMemGB} GB, NODE_ENV=${info.nodeEnv}, DataLoader=${info.dataloader}`);
}
if (failed) {
  console.error(`\n${failed} check(s) failed: the APIs are NOT equivalent. Fix before benchmarking.`);
  process.exit(1);
}
console.log('\nAll checks passed: REST and GraphQL return identical data.');
