import {
  DEFAULT_INPUTS, decodeInputs, encodeInputs, fmtMs, fmtPct, loadCurve, maxArrivalRate, minWorkers,
  mmc, responsePercentile, separateQueues, waitPercentile, workerTable,
} from "./queue.js";

const form = document.getElementById("form");
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

let inputs = decodeInputs(location.hash);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const pLabel = () => `p${inputs.percentile}`;
const rate = (n) => `${Math.round(n).toLocaleString("en-US")}/s`;

function verdict(ok) {
  return el("span", { class: `verdict ${ok ? "good" : "bad"}` }, [ok ? "✓ Meets target" : "✕ Misses target"]);
}

function card(label, value, sub, extra) {
  return el("div", { class: "card" }, [
    el("span", { class: "card-label", text: label }),
    el("span", { class: "card-total", text: value }),
    el("span", { class: "card-sub", text: sub }),
    extra || "",
  ]);
}

function fillForm() {
  for (const field of form.elements) if (field.name) field.value = inputs[field.name];
}

function update() {
  const r = mmc(inputs);
  const pct = responsePercentile(inputs.percentile, inputs);
  const ok = pct <= inputs.targetMs;
  const need = minWorkers(inputs);
  const capacity = maxArrivalRate(inputs);

  $("cards").replaceChildren(
    card("Utilization", r.stable ? fmtPct(r.utilization) : "over 100%", `${r.load.toFixed(1)} workers busy on average`),
    card(`${pLabel()} response time`, fmtMs(pct), `target ${fmtMs(inputs.targetMs)}`, verdict(ok)),
    card("Workers needed", need == null ? "none" : String(need), need == null ? "service time alone misses the target" : need === inputs.workers ? "you are at the minimum" : need < inputs.workers ? `${inputs.workers - need} more than needed` : `${need - inputs.workers} more than you have`),
    card("Load this pool can take", capacity > 0 ? rate(capacity) : "none", `while meeting the ${pLabel()} target`),
  );

  const warnings = [];
  if (!r.stable) warnings.push(`The pool can serve at most ${rate(inputs.workers * r.mu)}. The queue grows without limit at ${rate(inputs.arrivalRate)}.`);
  else if (r.utilization > 0.9) warnings.push("Above about 90% utilization, small traffic spikes cause large latency jumps. Leave headroom for bursts and deploys.");
  if (need == null) warnings.push(`Even with no queueing, the ${pLabel()} of the service time is ${fmtMs(responsePercentile(inputs.percentile, { ...inputs, arrivalRate: 0 }))}. Make each request faster or relax the target.`);
  $("warnings").replaceChildren(...warnings.map((w) => el("li", { text: w })));

  const stat = (k, v) => el("div", {}, [el("dt", { text: k }), el("dd", { text: v })]);
  $("stats").replaceChildren(
    stat("Requests that wait", r.stable ? fmtPct(r.pWait, 1) : "all"),
    stat("Mean response", fmtMs(r.meanResponseMs)),
    stat(`${pLabel()} time in queue`, fmtMs(waitPercentile(inputs.percentile, inputs))),
    stat("In flight (Little's law)", r.stable ? r.inSystem.toFixed(1) : "unbounded"),
  );

  const split = separateQueues(inputs.percentile, inputs);
  $("compare").replaceChildren(
    el("div", {}, [el("span", { text: "One shared queue" }), el("b", { text: fmtMs(pct) }), el("span", { text: `${pLabel()}, mean ${fmtMs(r.meanResponseMs)}` })]),
    el("div", {}, [el("span", { text: "A queue per worker" }), el("b", { text: fmtMs(split.percentileMs) }), el("span", { text: `${pLabel()}, mean ${fmtMs(split.meanResponseMs)}` })]),
  );

  $("pct-head").textContent = pLabel();
  $("rows").replaceChildren(
    ...workerTable(inputs).map((row) => el("tr", { class: row.isCurrent ? "current" : "" }, [
      el("td", { text: `${row.workers}${row.isCurrent ? " (current)" : ""}${row.isMin ? " (minimum)" : ""}` }),
      el("td", { class: "num", text: fmtPct(row.utilization) }),
      el("td", { class: "num", text: fmtPct(row.pWait, 1) }),
      el("td", { class: "num", text: fmtMs(row.meanMs) }),
      el("td", { class: "num", text: fmtMs(row.pctMs) }),
      el("td", {}, [row.meets ? "✓ meets" : "✕ misses"]),
    ])),
  );

  drawChart(r);
  history.replaceState(null, "", `#${encodeInputs(inputs)}`);
}

function drawChart(current) {
  const pts = loadCurve(inputs, 96);
  const chart = $("chart");
  const W = 640, H = 300, m = { l: 56, r: 16, t: 14, b: 44 };
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  // Clip the y axis so the bend stays readable. The curve goes to infinity at 100%.
  const now = responsePercentile(inputs.percentile, inputs);
  const yMax = niceCeil(Math.max(inputs.targetMs * 2, pts[0].pctMs * 1.5, Number.isFinite(now) ? now * 1.2 : 0));
  const x = (u) => m.l + u * (W - m.l - m.r);
  const y = (v) => H - m.b - (Math.min(v, yMax * 4) / yMax) * (H - m.t - m.b);

  const nodes = [];
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtMs(v).replace(".0 ms", " ms")));
  }
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    nodes.push(svg("text", { x: x(u), y: H - m.b + 18, class: "tick", "text-anchor": "middle" }, fmtPct(u)));
  }
  nodes.push(svg("text", { x: (m.l + W - m.r) / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, "Utilization"));

  nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(inputs.targetMs), y2: y(inputs.targetMs), class: "target" }));
  nodes.push(svg("text", { x: m.l + 6, y: y(inputs.targetMs) - 6, class: "target-label" }, `target ${fmtMs(inputs.targetMs)}`));

  if (current.stable) nodes.push(svg("line", { x1: x(current.utilization), x2: x(current.utilization), y1: m.t, y2: H - m.b, class: "marker" }));

  const series = [
    { key: "mean", label: "Mean", get: (p) => p.meanMs },
    { key: "pct", label: pLabel(), get: (p) => p.pctMs },
  ];
  for (const s of series) {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.utilization).toFixed(1)},${y(s.get(p)).toFixed(1)}`).join("");
    nodes.push(svg("path", { d, class: `line s-${s.key}`, "clip-path": "url(#plot)" }));
  }
  const clip = svg("clipPath", { id: "plot" }, null);
  clip.append(svg("rect", { x: m.l, y: m.t - 2, width: W - m.l - m.r, height: H - m.t - m.b + 2 }));
  nodes.unshift(clip);

  const hover = svg("g", { visibility: "hidden" });
  const hoverLine = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair" });
  hover.append(hoverLine, ...series.map((s) => svg("circle", { r: 4.5, class: `dot s-${s.key}`, "data-key": s.key })));
  nodes.push(hover);
  const hit = svg("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H - m.b, fill: "transparent" });
  nodes.push(hit);
  chart.replaceChildren(...nodes);

  const tip = $("tooltip");
  hit.addEventListener("pointermove", (evt) => {
    const box = chart.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    let idx = 0;
    for (let i = 0; i < pts.length; i++) if (Math.abs(x(pts[i].utilization) - px) < Math.abs(x(pts[idx].utilization) - px)) idx = i;
    const p = pts[idx];
    const cx = x(p.utilization);
    hover.setAttribute("visibility", "visible");
    hoverLine.setAttribute("x1", cx);
    hoverLine.setAttribute("x2", cx);
    for (const dot of hover.querySelectorAll("circle")) {
      const s = series.find((k) => k.key === dot.dataset.key);
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", y(s.get(p)));
      dot.setAttribute("visibility", s.get(p) > yMax ? "hidden" : "visible");
    }
    tip.replaceChildren(
      el("strong", { text: `${fmtPct(p.utilization)} busy, ${rate(p.arrivalRate)}` }),
      ...series.slice().reverse().map((s) => el("div", { class: "tip-row" }, [el("i", { class: `swatch s-${s.key}` }), el("span", { text: s.label }), el("b", { text: fmtMs(s.get(p)) })])),
    );
    tip.hidden = false;
    const left = (cx / W) * box.width;
    tip.style.left = `${left > box.width / 2 ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = "8px";
  });
  hit.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; });

  $("legend").replaceChildren(
    ...series.slice().reverse().map((s) => el("li", {}, [el("i", { class: `swatch s-${s.key}` }), s.label])),
    el("li", {}, [el("i", { class: "swatch s-target" }), "Target"]),
  );
  const knee = pts.find((p) => p.pctMs > inputs.targetMs);
  $("chart-note").textContent = `The vertical line marks your current load. ${knee ? `With ${inputs.workers} workers, the ${pLabel()} crosses the target at about ${fmtPct(knee.utilization)} utilization.` : `With ${inputs.workers} workers, the ${pLabel()} stays under the target up to 98% utilization.`}`;
}

function niceCeil(v) {
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * mag >= v) return s * mag;
  return 10 * mag;
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  const n = Number(f.value);
  if (!Number.isFinite(n) || n < 0 || (f.name !== "arrivalRate" && n <= 0)) return;
  inputs = { ...inputs, [f.name]: f.name === "workers" ? Math.max(1, Math.round(n)) : n };
  update();
});

form.addEventListener("click", (e) => {
  const step = Number(e.target.dataset?.step);
  if (!step) return;
  inputs = { ...inputs, workers: Math.max(1, inputs.workers + step) };
  form.elements.workers.value = inputs.workers;
  update();
});

$("reset").addEventListener("click", () => {
  inputs = { ...DEFAULT_INPUTS };
  fillForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

fillForm();
update();
