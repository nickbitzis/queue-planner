import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INPUTS, decodeInputs, encodeInputs, erlangC, fmtMs, loadCurve, maxArrivalRate, minWorkers,
  mmc, responsePercentile, responseTail, separateQueues, waitPercentile, workerTable,
} from "../src/queue.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("Erlang C matches textbook values", () => {
  near(erlangC(1, 0.5), 0.5); // M/M/1: wait probability equals utilization
  near(erlangC(2, 1), 1 / 3);
  near(erlangC(10, 8), 0.4092, 1e-4); // standard table value
  assert.equal(erlangC(3, 3), 1);
});

test("Erlang C stays stable for large pools", () => {
  const c = erlangC(500, 480);
  assert.ok(c > 0 && c < 1);
});

test("M/M/1 response time is exponential with rate mu minus lambda", () => {
  const inputs = { arrivalRate: 8, serviceMs: 100, workers: 1 };
  const r = mmc(inputs);
  near(r.meanResponseMs, 500, 1e-9); // 1 / (10 - 8) s
  near(r.utilization, 0.8);
  for (const p of [50, 90, 99]) near(responsePercentile(p, inputs), (-Math.log(1 - p / 100) / 2) * 1000, 1e-6);
});

test("Little's law ties rate, time, and count together", () => {
  const r = mmc({ arrivalRate: 120, serviceMs: 50, workers: 8 });
  near(r.inSystem, 120 * (r.meanResponseMs / 1000), 1e-9);
  near(r.inSystem - r.queueLength, r.load, 1e-9); // busy workers on average
});

test("the tail is a valid distribution and handles theta equal to mu", () => {
  const r = mmc({ arrivalRate: 10, serviceMs: 100, workers: 2 }); // theta = 20 - 10 = mu
  near(r.theta, r.mu);
  near(responseTail(0, r), 1);
  let prev = 1;
  for (let t = 0.01; t < 2; t += 0.05) {
    const v = responseTail(t, r);
    assert.ok(v <= prev + 1e-12 && v >= 0);
    prev = v;
  }
});

test("percentile agrees with a simulation", () => {
  // Deterministic LCG so the test is reproducible.
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) + 0.5) / 4294967296;
  const exp = (rate) => -Math.log(rand()) / rate;
  const inputs = { arrivalRate: 60, serviceMs: 100, workers: 8 };
  const free = new Array(8).fill(0);
  let t = 0;
  const times = [];
  for (let i = 0; i < 200000; i++) {
    t += exp(60);
    let w = 0;
    for (let k = 1; k < 8; k++) if (free[k] < free[w]) w = k;
    const start = Math.max(t, free[w]);
    free[w] = start + exp(10);
    if (i > 5000) times.push(free[w] - t);
  }
  times.sort((a, b) => a - b);
  const sim95 = times[Math.floor(times.length * 0.95)] * 1000;
  near(responsePercentile(95, inputs), sim95, sim95 * 0.03);
});

test("an overloaded pool is reported as unstable", () => {
  const r = mmc({ arrivalRate: 200, serviceMs: 50, workers: 8 }); // capacity is 160/s
  assert.equal(r.stable, false);
  assert.equal(responsePercentile(99, { arrivalRate: 200, serviceMs: 50, workers: 8 }), Infinity);
  assert.equal(fmtMs(Infinity), "unbounded");
});

test("zero traffic means response time equals service time", () => {
  const r = mmc({ arrivalRate: 0, serviceMs: 40, workers: 4 });
  assert.equal(r.pWait, 0);
  near(responsePercentile(50, { arrivalRate: 0, serviceMs: 40, workers: 4 }), 40 * Math.log(2), 1e-6);
});

test("wait percentile is zero when most requests never queue", () => {
  const inputs = { arrivalRate: 20, serviceMs: 50, workers: 8 };
  assert.equal(waitPercentile(90, inputs), 0);
  const busy = { arrivalRate: 150, serviceMs: 50, workers: 8 };
  assert.ok(waitPercentile(99, busy) > 0);
});

test("one shared queue beats separate queues at the same utilization", () => {
  const inputs = { arrivalRate: 120, serviceMs: 50, workers: 8 };
  const pooled = responsePercentile(99, inputs);
  const split = separateQueues(99, inputs);
  assert.ok(split.percentileMs > pooled * 2);
  near(split.meanResponseMs, 1000 / (20 - 15), 1e-9);
});

test("minimum workers is the first count that meets the target", () => {
  const c = minWorkers(DEFAULT_INPUTS);
  assert.ok(c > 6);
  assert.ok(responsePercentile(99, { ...DEFAULT_INPUTS, workers: c }) <= 100);
  assert.ok(responsePercentile(99, { ...DEFAULT_INPUTS, workers: c - 1 }) > 100);
});

test("minimum workers is null when service time alone misses the target", () => {
  // p99 of an exponential with mean 50 ms is about 230 ms, more than 200.
  assert.equal(minWorkers({ ...DEFAULT_INPUTS, serviceMs: 50, targetMs: 150 }), null);
});

test("worker table marks current and minimum rows", () => {
  const rows = workerTable(DEFAULT_INPUTS);
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((r) => r.isMin).length, 1);
  assert.ok(rows.some((r) => r.isCurrent));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].pctMs <= rows[i - 1].pctMs);
});

test("load curve rises steeply near saturation", () => {
  const pts = loadCurve(DEFAULT_INPUTS);
  assert.ok(pts.at(-1).pctMs > pts[0].pctMs * 5);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].pctMs >= pts[i - 1].pctMs - 1e-9);
});

test("max arrival rate sits exactly at the target", () => {
  const lam = maxArrivalRate(DEFAULT_INPUTS);
  near(responsePercentile(99, { ...DEFAULT_INPUTS, arrivalRate: lam }), 100, 0.5);
  assert.equal(maxArrivalRate({ ...DEFAULT_INPUTS, targetMs: 50 }), 0);
});

test("inputs round-trip through the URL and bad values fall back", () => {
  const inputs = { arrivalRate: 333, serviceMs: 12, workers: 5, percentile: 95, targetMs: 80 };
  assert.deepEqual(decodeInputs(`#${encodeInputs(inputs)}`), inputs);
  const bad = decodeInputs("#arrivalRate=-1&workers=2.6&percentile=42&serviceMs=abc");
  assert.equal(bad.arrivalRate, DEFAULT_INPUTS.arrivalRate);
  assert.equal(bad.workers, 3);
  assert.equal(bad.percentile, DEFAULT_INPUTS.percentile);
  assert.equal(bad.serviceMs, DEFAULT_INPUTS.serviceMs);
});
