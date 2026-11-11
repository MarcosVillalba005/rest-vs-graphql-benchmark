// k6 load script for ONE experimental configuration (API x scenario x VUs).
// It is normally launched by bench/run-experiment.js, but can be run by hand:
//
//   k6 run -e API=graphql -e SCENARIO=nested -e VUS=50 -e DURATION=30s \
//          -e BASE_URL=http://192.168.1.20:4000 bench/k6/benchmark.js
//
// Closed workload model: each virtual user (VU) sends the next operation as soon
// as the previous one finishes (no think time), so load grows with the VU count.
import http from 'k6/http';
import { Trend, Counter, Rate } from 'k6/metrics';

const API = (__ENV.API || 'rest').toLowerCase(); // rest | graphql
const SCENARIO = (__ENV.SCENARIO || 'simple').toLowerCase(); // simple | nested | list
const BASE_URL = (__ENV.BASE_URL || (API === 'rest' ? 'http://localhost:3000' : 'http://localhost:4000')).replace(/\/$/, '');
const N_USERS = Number(__ENV.N_USERS || 1000);
const N_POSTS = Number(__ENV.N_POSTS || 10000);
const LIST_LIMIT = Number(__ENV.LIST_LIMIT || 100);

export const options = {
  vus: Number(__ENV.VUS || 1),
  duration: __ENV.DURATION || '30s',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  userAgent: 'rest-vs-graphql-benchmark/1.0',
  // batchPerHost keeps k6's default of 6 parallel connections per host,
  // the same limit browsers apply to HTTP/1.1 origins.
  batchPerHost: 6,
};

// Logical-operation latency: the time a client needs to obtain the whole
// document of the scenario (1 request for GraphQL; 1 or 2 waves for REST).
const opDuration = new Trend('op_duration', true);
const opsOk = new Counter('ops_ok');
const opErrors = new Rate('op_errors');
const requestsPerOp = new Trend('requests_per_op');

// Same operations as scripts/queries.js (k6 cannot import Node modules).
const USER = 'id name username email bio createdAt';
const POST = 'id userId title body createdAt';
const COMMENT = 'id postId name email body createdAt';
const QUERIES = {
  simple: `query Simple($id: Int!) { user(id: $id) { ${USER} } }`,
  nested: `query Nested($id: Int!) { user(id: $id) { ${USER} posts { ${POST} comments { ${COMMENT} } } } }`,
  list: `query List($limit: Int!, $offset: Int!) { posts(limit: $limit, offset: $offset) { ${POST} } }`,
};

const TEXT = { responseType: 'text', tags: { api: API, scenario: SCENARIO } };
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' }, ...TEXT };

// Full client-observed time of one response (queueing + connect + send + wait + receive).
const elapsed = (r) => r.timings.blocked + r.timings.connecting + r.timings.tls_handshaking + r.timings.duration;
// A wave of parallel requests lasts as long as its slowest request.
const waveTime = (responses) => Math.max(...responses.map(elapsed));
const restOk = (r) => r.status === 200 && !!r.body && r.body.length > 0;
const gqlOk = (r) => r.status === 200 && !!r.body && r.body.indexOf('"errors"') === -1;

const randomUserId = () => 1 + Math.floor(Math.random() * N_USERS);
const randomOffset = () => Math.floor(Math.random() * Math.max(N_POSTS - LIST_LIMIT, 1));

function graphqlOperation(variables) {
  const r = http.post(`${BASE_URL}/graphql`, JSON.stringify({ query: QUERIES[SCENARIO], variables }), JSON_HEADERS);
  return { ok: gqlOk(r), ms: elapsed(r), requests: 1 };
}

function restOperation() {
  if (SCENARIO === 'simple') {
    const r = http.get(`${BASE_URL}/users/${randomUserId()}`, TEXT);
    return { ok: restOk(r), ms: elapsed(r), requests: 1 };
  }
  if (SCENARIO === 'list') {
    const r = http.get(`${BASE_URL}/posts?limit=${LIST_LIMIT}&offset=${randomOffset()}`, TEXT);
    return { ok: restOk(r), ms: elapsed(r), requests: 1 };
  }
  // nested: wave 1 = user + posts in parallel; wave 2 = comments of every post in parallel.
  const id = randomUserId();
  const wave1 = http.batch([
    { method: 'GET', url: `${BASE_URL}/users/${id}`, params: TEXT },
    { method: 'GET', url: `${BASE_URL}/users/${id}/posts`, params: TEXT },
  ]);
  let ok = wave1.every(restOk);
  let ms = waveTime(wave1);
  let requests = 2;
  if (ok) {
    const posts = wave1[1].json();
    if (posts.length > 0) {
      const wave2 = http.batch(posts.map((p) => ({ method: 'GET', url: `${BASE_URL}/posts/${p.id}/comments`, params: TEXT })));
      ok = wave2.every(restOk);
      ms += waveTime(wave2);
      requests += wave2.length;
    }
  }
  return { ok, ms, requests };
}

export default function () {
  let result;
  if (API === 'graphql') {
    const variables =
      SCENARIO === 'list' ? { limit: LIST_LIMIT, offset: randomOffset() } : { id: randomUserId() };
    result = graphqlOperation(variables);
  } else {
    result = restOperation();
  }
  opErrors.add(!result.ok);
  if (result.ok) {
    opDuration.add(result.ms);
    opsOk.add(1);
    requestsPerOp.add(result.requests);
  }
}

export function handleSummary(data) {
  const out = {};
  const m = data.metrics;
  const line =
    `[${API}/${SCENARIO}/${options.vus} VUs] ops=${m.ops_ok ? m.ops_ok.values.count : 0} ` +
    `p50=${m.op_duration ? m.op_duration.values.med.toFixed(2) : 'n/a'} ms ` +
    `p95=${m.op_duration ? m.op_duration.values['p(95)'].toFixed(2) : 'n/a'} ms ` +
    `errors=${m.op_errors ? (m.op_errors.values.rate * 100).toFixed(2) : 'n/a'}%\n`;
  out.stdout = line;
  if (__ENV.SUMMARY_PATH) out[__ENV.SUMMARY_PATH] = JSON.stringify(data, null, 1);
  return out;
}
