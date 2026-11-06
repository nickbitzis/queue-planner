// M/M/c queueing math for sizing a pool of workers.
//
// Requests arrive at random (Poisson) at rate lambda per second. Each of c
// identical workers takes an exponentially distributed time with mean S to
// serve one. Requests that find every worker busy wait in one shared FIFO
// queue. Everything here is closed form, so it is exact for that model.

export const PERCENTILES = [50, 90, 95, 99, 99.9];

export const DEFAULT_INPUTS = {
  arrivalRate: 300, // requests per second
  serviceMs: 20, // mean time one worker spends on one request
  workers: 7,
  percentile: 99,
  targetMs: 100,
};

/** Erlang C: the probability that an arriving request has to wait. */
export function erlangC(c, load) {
  if (load >= c) return 1;
  // Erlang B by the stable recurrence, then convert.
  let b = 1;
  for (let k = 1; k <= c; k++) b = (load * b) / (k + load * b);
  return (c * b) / (c - load * (1 - b));
}

/**
 * Closed-form results for an M/M/c queue.
 * Times are in milliseconds. `stable` is false when the workers cannot keep up.
 */
export function mmc({ arrivalRate, serviceMs, workers }) {
  const mu = 1000 / serviceMs; // per worker, per second
  const load = arrivalRate / mu; // offered load in erlangs
  const c = workers;
  const utilization = load / c;
  if (arrivalRate <= 0) {
    return { stable: true, load: 0, utilization: 0, pWait: 0, meanWaitMs: 0, meanResponseMs: serviceMs, inSystem: 0, queueLength: 0, mu, theta: Infinity };
  }
  if (load >= c) return { stable: false, load, utilization, pWait: 1, meanWaitMs: Infinity, meanResponseMs: Infinity, inSystem: Infinity, queueLength: Infinity, mu };
  const pWait = erlangC(c, load);
  const theta = c * mu - arrivalRate; // rate of the waiting time's exponential tail
  const meanWait = pWait / theta;
  const meanResponse = meanWait + 1 / mu;
  return {
    stable: true,
    load,
    utilization,
    pWait,
    meanWaitMs: meanWait * 1000,
    meanResponseMs: meanResponse * 1000,
    inSystem: arrivalRate * meanResponse, // Little's law
    queueLength: arrivalRate * meanWait,
    mu,
    theta,
  };
}

/**
 * P(response time > t seconds). Response = wait + service. The wait is 0 with
 * probability 1 - C and exponential with rate theta otherwise, and service is
 * exponential with rate mu, so the tail has a closed form.
 */
export function responseTail(t, { pWait, theta, mu }) {
  const service = Math.exp(-mu * t);
  if (!Number.isFinite(theta)) return service;
  let both;
  if (Math.abs(theta - mu) < 1e-9 * mu) both = Math.exp(-mu * t) * (1 + mu * t);
  else both = (mu * Math.exp(-theta * t) - theta * Math.exp(-mu * t)) / (mu - theta);
  return (1 - pWait) * service + pWait * both;
}

/** The p-th percentile of response time in ms, found by bisection on the tail. */
export function responsePercentile(p, inputs) {
  const r = mmc(inputs);
  if (!r.stable) return Infinity;
  const target = 1 - p / 100;
  let lo = 0, hi = 1 / r.mu;
  while (responseTail(hi, r) > target) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (responseTail(mid, r) > target) lo = mid;
    else hi = mid;
  }
  return hi * 1000;
}

/** The p-th percentile of waiting time alone, in ms. */
export function waitPercentile(p, inputs) {
  const r = mmc(inputs);
  if (!r.stable) return Infinity;
  const tail = 1 - p / 100;
  if (r.pWait <= tail) return 0;
  return (Math.log(r.pWait / tail) / r.theta) * 1000;
}

/**
 * The same traffic split across c independent single-worker queues, as with
 * random load balancing. Each is M/M/1, whose response time is exponential.
 */
export function separateQueues(p, { arrivalRate, serviceMs, workers }) {
  const mu = 1000 / serviceMs;
  const perQueue = arrivalRate / workers;
  if (perQueue >= mu) return { stable: false, meanResponseMs: Infinity, percentileMs: Infinity };
  const rate = mu - perQueue;
  return { stable: true, meanResponseMs: 1000 / rate, percentileMs: (-Math.log(1 - p / 100) / rate) * 1000 };
}

/** The smallest worker count whose p-th percentile meets the target. */
export function minWorkers(inputs, maxWorkers = 10000) {
  const { arrivalRate, serviceMs, percentile, targetMs } = inputs;
  if (targetMs <= responsePercentile(percentile, { arrivalRate: 0, serviceMs, workers: 1 })) return null; // service alone is too slow
  const mu = 1000 / serviceMs;
  for (let c = Math.max(1, Math.floor(arrivalRate / mu) + 1); c <= maxWorkers; c++) {
    if (responsePercentile(percentile, { arrivalRate, serviceMs, workers: c }) <= targetMs) return c;
  }
  return null;
}

/** Rows for the comparison table: each worker count from just stable upward. */
export function workerTable(inputs, rows = 10) {
  const mu = 1000 / inputs.serviceMs;
  const first = Math.max(1, Math.floor(inputs.arrivalRate / mu) + 1);
  const best = minWorkers(inputs);
  const start = Math.max(first, Math.min(inputs.workers, best ?? inputs.workers) - 3);
  const out = [];
  for (let c = start; c < start + rows; c++) {
    const r = mmc({ ...inputs, workers: c });
    const pct = responsePercentile(inputs.percentile, { ...inputs, workers: c });
    out.push({ workers: c, utilization: r.utilization, pWait: r.pWait, meanMs: r.meanResponseMs, pctMs: pct, meets: pct <= inputs.targetMs, isMin: c === best, isCurrent: c === inputs.workers });
  }
  return out;
}

/**
 * Latency as load grows with the worker count fixed: the hockey stick.
 * Returns points from 2% to 98% utilization.
 */
export function loadCurve(inputs, steps = 60) {
  const mu = 1000 / inputs.serviceMs;
  const cap = inputs.workers * mu;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = 0.02 + (0.96 * i) / steps;
    const lam = u * cap;
    const r = mmc({ ...inputs, arrivalRate: lam });
    pts.push({ utilization: u, arrivalRate: lam, meanMs: r.meanResponseMs, pctMs: responsePercentile(inputs.percentile, { ...inputs, arrivalRate: lam }) });
  }
  return pts;
}

/** The highest arrival rate the current pool can take while meeting the target. */
export function maxArrivalRate(inputs) {
  const mu = 1000 / inputs.serviceMs;
  const ok = (lam) => responsePercentile(inputs.percentile, { ...inputs, arrivalRate: lam }) <= inputs.targetMs;
  if (!ok(1e-9)) return 0;
  let lo = 0, hi = inputs.workers * mu * (1 - 1e-9);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function encodeInputs(inputs) {
  return new URLSearchParams(Object.entries(inputs).map(([k, v]) => [k, String(v)])).toString();
}

export function decodeInputs(hash) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ""));
  const out = { ...DEFAULT_INPUTS };
  for (const key of Object.keys(DEFAULT_INPUTS)) {
    const n = Number(params.get(key));
    if (params.has(key) && Number.isFinite(n) && n > 0) out[key] = n;
  }
  out.workers = Math.max(1, Math.round(out.workers));
  if (!PERCENTILES.includes(out.percentile)) out.percentile = DEFAULT_INPUTS.percentile;
  return out;
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "unbounded";
  if (ms >= 10000) return `${(ms / 1000).toFixed(0)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

export function fmtPct(x, digits = 0) {
  return `${(x * 100).toFixed(digits)}%`;
}
