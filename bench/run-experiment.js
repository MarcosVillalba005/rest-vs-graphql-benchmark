// Experiment runner. Run it on the LOAD-GENERATOR laptop (the one with k6).
//
//   node bench/run-experiment.js --rest-url http://192.168.1.20:3000 --graphql-url http://192.168.1.20:4000
//
// Options (all optional, defaults come from config/experiment.json):
//   --reps 10            repetitions per configuration
//   --duration 30        measured seconds per run
//   --warmup 10          warm-up seconds per run (not recorded)
//   --cooldown 5         pause between runs
//   --vus 1,10,50        subset of concurrency levels
//   --scenarios simple   subset of scenarios
//   --apis rest,graphql  subset of APIs
//   --tag pilot          sub-folder name inside results/ (default: main)
//   --dry-run            print the randomised plan and exit
//
// Design: within each repetition block the 30 configurations run in a random
// (seeded, reproducible) order, so slow drifts such as thermal throttling or
// background activity affect REST and GraphQL equally. Finished runs are skipped
// when the script is restarted, so an interrupted experiment can be resumed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(path.join(root, 'config/experiment.json'), 'utf8'));

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const list = (v, def) => (v === undefined ? def : String(v).split(',').map((s) => s.trim()).filter(Boolean));

const urls = {
  rest: String(arg('rest-url', 'http://localhost:3000')).replace(/\/$/, ''),
  graphql: String(arg('graphql-url', 'http://localhost:4000')).replace(/\/$/, ''),
};
const reps = Number(arg('reps', cfg.repetitions));
const duration = Number(arg('duration', cfg.durationSeconds));
const warmup = Number(arg('warmup', cfg.warmupSeconds));
const cooldown = Number(arg('cooldown', cfg.cooldownSeconds));
const apis = list(arg('apis'), cfg.apis);
const scenarios = list(arg('scenarios'), cfg.scenarios);
const vusLevels = list(arg('vus'), cfg.vus.map(String)).map(Number);
const tag = String(arg('tag', 'main'));
const dryRun = arg('dry-run', false) === true;

const outDir = path.join(root, 'results', tag);
const rawDir = path.join(outDir, 'raw');
const k6Script = path.join(root, 'bench/k6/benchmark.js');
const nPosts = cfg.dataset.users * cfg.dataset.postsPerUser;

// ---------- reproducible random order ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, seed) {
  const r = mulberry32(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const configs = [];
for (const api of apis) for (const scenario of scenarios) for (const vus of vusLevels) configs.push({ api, scenario, vus });
const plan = [];
for (let rep = 1; rep <= reps; rep++) {
  shuffle(configs, cfg.orderSeed * 1000 + rep).forEach((c, i) => {
    plan.push({ ...c, rep, orderInBlock: i + 1, runId: `${c.api}_${c.scenario}_${String(c.vus).padStart(3, '0')}vu_rep${String(rep).padStart(2, '0')}` });
  });
}

const perRun = warmup + duration + cooldown + 4;
console.log(`Plan: ${plan.length} runs (${configs.length} configurations x ${reps} repetitions).`);
console.log(`Estimated time: ${(plan.length * perRun / 3600).toFixed(1)} h (${perRun}s per run).`);
if (dryRun) {
  plan.forEach((p, i) => console.log(`${String(i + 1).padStart(4)}  ${p.runId}`));
  process.exit(0);
}

// ---------- helpers ----------
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const fetchJson = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};
const runK6 = (env) =>
  new Promise((resolve, reject) => {
    const args = ['run', '--quiet', '--no-usage-report'];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(k6Script);
    const p = spawn('k6', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`k6 exited with code ${code}`))));
  });

// ---------- pre-flight ----------
const k6v = spawnSync('k6', ['version'], { encoding: 'utf8' });
if (k6v.error) {
  console.error('k6 not found in PATH. Install it (Windows: "winget install k6 --source winget") and reopen the terminal.');
  process.exit(1);
}
const serverInfo = {};
for (const api of apis) {
  try {
    serverInfo[api] = await fetchJson(`${urls[api]}/__info`);
  } catch (e) {
    console.error(`Cannot reach the ${api} server at ${urls[api]} (${e.message}). Is "npm run start:both" running and the firewall open?`);
    process.exit(1);
  }
}
mkdirSync(rawDir, { recursive: true });
writeFileSync(
  path.join(outDir, 'environment.json'),
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      k6Version: k6v.stdout.trim(),
      loadGenerator: {
        node: process.version,
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        cpuModel: os.cpus()[0]?.model,
        logicalCores: os.cpus().length,
        totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
      },
      servers: serverInfo,
      urls,
      design: { apis, scenarios, vus: vusLevels, reps, warmup, duration, cooldown, listLimit: cfg.listLimit, dataset: cfg.dataset },
    },
    null,
    2,
  ),
);

// ---------- main loop ----------
const t0 = Date.now();
let done = 0;
for (const [i, run] of plan.entries()) {
  const outFile = path.join(rawDir, `${run.runId}.json`);
  if (existsSync(outFile)) { done++; continue; }

  const base = urls[run.api];
  const common = { API: run.api, SCENARIO: run.scenario, VUS: run.vus, BASE_URL: base, N_USERS: cfg.dataset.users, N_POSTS: nPosts, LIST_LIMIT: cfg.listLimit };
  const k6File = path.join(rawDir, `${run.runId}.k6.json`).replaceAll('\\', '/');
  console.log(`\n[${i + 1}/${plan.length}] ${run.runId}`);
  try {
    await runK6({ ...common, DURATION: `${warmup}s` }); // warm-up: JIT, connection pools, OS caches
    await fetchJson(`${base}/__stats/reset`, { method: 'POST' });
    const startedAt = new Date().toISOString();
    await runK6({ ...common, DURATION: `${duration}s`, SUMMARY_PATH: k6File });
    const server = await fetchJson(`${base}/__stats`);
    const k6 = JSON.parse(readFileSync(k6File, 'utf8'));
    writeFileSync(outFile, JSON.stringify({ ...run, durationSeconds: duration, startedAt, finishedAt: new Date().toISOString(), server, k6 }, null, 1));
    rmSync(k6File);
    done++;
  } catch (e) {
    console.error(`  run failed: ${e.message} (it will be retried next time you start the runner)`);
  }
  const elapsedH = (Date.now() - t0) / 3.6e6;
  const remaining = plan.length - (i + 1);
  console.log(`  progress ${done}/${plan.length}, elapsed ${elapsedH.toFixed(2)} h, ~${(remaining * perRun / 3600).toFixed(1)} h left`);
  await sleep(cooldown);
}
console.log(`\nFinished. ${done}/${plan.length} runs stored in ${rawDir}`);
console.log(`Next: python analysis/analyze.py --results ${path.relative(root, outDir)}`);
