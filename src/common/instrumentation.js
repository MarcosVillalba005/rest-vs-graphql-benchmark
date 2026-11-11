// Server-side resource instrumentation, identical for both APIs.
// The load generator calls POST /__stats/reset right before a measured run and
// GET /__stats right after it, so no clock synchronisation between laptops is needed.
// These endpoints are never called during a measured window.
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export function createInstrumentation({ sampleMs = 250 } = {}) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  let state;
  const reset = () => {
    loopDelay.reset();
    state = {
      startedAt: process.hrtime.bigint(),
      cpu: process.cpuUsage(),
      rssSamples: [],
      heapPeak: 0,
    };
  };
  reset();

  const timer = setInterval(() => {
    const m = process.memoryUsage();
    state.rssSamples.push(m.rss);
    state.heapPeak = Math.max(state.heapPeak, m.heapUsed);
  }, sampleMs);
  timer.unref();

  const MB = 1024 * 1024;
  const snapshot = () => {
    const elapsedMs = Number(process.hrtime.bigint() - state.startedAt) / 1e6;
    const cpu = process.cpuUsage(state.cpu); // microseconds since reset
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const rss = state.rssSamples.length ? state.rssSamples : [process.memoryUsage().rss];
    return {
      elapsedMs,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      // 100 % = one fully used core (the Node.js event loop is single-threaded).
      cpuPercent: elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0,
      rssAvgMB: rss.reduce((a, b) => a + b, 0) / rss.length / MB,
      rssPeakMB: Math.max(...rss) / MB,
      heapPeakMB: state.heapPeak / MB,
      eventLoopDelayP50Ms: loopDelay.percentile(50) / 1e6,
      eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    };
  };

  const info = () => ({
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    logicalCores: os.cpus().length,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    hostname: os.hostname(),
    nodeEnv: process.env.NODE_ENV ?? '',
    dataloader: process.env.DATALOADER ?? 'on',
  });

  // Mounts the instrumentation routes on an Express app.
  const mount = (app, apiName) => {
    app.post('/__stats/reset', (_req, res) => { reset(); res.json({ ok: true }); });
    app.get('/__stats', (_req, res) => res.json({ api: apiName, ...snapshot() }));
    app.get('/__info', (_req, res) => res.json({ api: apiName, ...info() }));
    app.get('/health', (_req, res) => res.json({ ok: true, api: apiName }));
  };

  return { reset, snapshot, info, mount };
}
