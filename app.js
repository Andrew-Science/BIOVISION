import { analyzeRunning, analyzePullups, analyzeDeadlift, analyzeDance, calibrationFrom, LM, SEGMENT_NAMES } from "./analysis.js";

// ---------------- catálogo de análisis ----------------
const TESTS = {
  running: {
    name: "Carrera", unit: "spm", desc: "Cadencia, tiempo de contacto y flexión de rodilla al contacto.",
    tips: ["Cámara fija y de lado; la cinta caminadora es ideal.", "Ambos tobillos visibles todo el tiempo.", "Mínimo 8–10 s de carrera estable."],
  },
  chin: {
    name: "Chin-ups", unit: "reps", desc: "Cuenta repeticiones con barbilla sobre la barra y cronometra cada tirón.",
    tips: ["De frente o de lado, con manos, cabeza y cadera en cuadro.", "Agarre supino; la barra puede quedar fuera del cuadro.", "Empieza el video ya colgado."],
  },
  pull: {
    name: "Pull-ups", unit: "ROM", desc: "Cuenta repeticiones y califica cada una como completa o parcial.",
    tips: ["De frente o de espaldas, con brazos completos en cuadro.", "Para calibrar: graba un set de 3+ repeticiones con colgado completo.", "Cámara fija a la altura del pecho."],
  },
  deadlift: {
    name: "Peso muerto", unit: "cad°", desc: "Repeticiones por ángulo de cadera, tiempo de tirón e indicador aproximado de postura.",
    tips: ["Estrictamente de lado, todo el cuerpo en cuadro.", "Se analiza el lado más visible.", "El indicador de espalda es una aproximación por pose, no un diagnóstico."],
  },
  dance: {
    name: "Sincronía de baile", unit: "%", desc: "Compara postura y tiempo entre 2 a 4 personas haciendo la misma coreografía.",
    tips: ["Todas las personas de cuerpo entero, sin taparse.", "Cámara fija y de frente.", "Al menos 6–8 s de coreografía."],
  },
};

const FPS = 30;
const MAX_SECONDS = 60;
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "—");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = { test: null, file: null, url: null, duration: 0, aspect: 1, frames: null, result: null, start: 0, cancel: false };

// ---------------- almacenamiento local (solo conveniencias) ----------------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("biovision." + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("biovision." + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("biovision." + k); } catch {} },
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600);
}

function show(id) {
  for (const s of ["home", "setup", "running", "result"]) $(s).hidden = s !== id;
  window.scrollTo({ top: 0 });
}

// ---------------- inicio ----------------
$("tests").innerHTML = Object.entries(TESTS).map(([k, t]) => `
  <button class="test" type="button" data-test="${k}">
    <span class="unit">${t.unit}</span>
    <span><strong>${t.name}</strong><span class="d">${t.desc}</span></span>
    <span class="go" aria-hidden="true">›</span>
  </button>`).join("");
$("tests").addEventListener("click", (e) => {
  const b = e.target.closest("[data-test]");
  if (b) openSetup(b.dataset.test);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (!b) return;
  if (b.dataset.go === "setup" && !state.test) return show("home");
  show(b.dataset.go);
});

function openSetup(test) {
  state.test = test;
  const t = TESTS[test];
  $("setup-title").textContent = t.name;
  $("setup-tip").innerHTML = `<h3>Cómo grabar</h3><ul>${t.tips.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  $("opt-knee").hidden = test !== "running";
  $("opt-dancers").hidden = test !== "dance";
  renderCalib();
  show("setup");
}

function renderCalib() {
  const el = $("calib");
  el.hidden = state.test !== "pull";
  if (el.hidden) return;
  const cal = store.get("pullcal");
  el.innerHTML = cal
    ? `<span>Calibrado: colgado <b>${fmt(cal.hang)}°</b>, despeje <b>${fmt(cal.clear, 2)}</b> troncos (${cal.reps} reps).</span><button class="btn" type="button" id="cal-clear">Borrar calibración</button>`
    : `<span>Sin calibración: cada video se compara consigo mismo (colgado ≥ 150°).</span>`;
  const b = $("cal-clear");
  if (b) b.onclick = () => { store.del("pullcal"); renderCalib(); toast("Calibración borrada"); };
}

// ---------------- selección de video ----------------
$("file").addEventListener("change", () => {
  const f = $("file").files[0];
  if (!f) return;
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = f; state.url = URL.createObjectURL(f);
  const v = $("preview");
  v.src = state.url;
  $("setup-stage").hidden = false;
  $("picker-label").textContent = "Cambiar video";
  $("picker-sub").textContent = f.name;
  $("run").disabled = true;
  $("setup-status").textContent = "Leyendo video…";
  v.onloadedmetadata = () => {
    state.duration = v.duration;
    state.aspect = v.videoWidth / v.videoHeight;
    $("from").value = 0;
    $("to").value = Math.min(v.duration, MAX_SECONDS).toFixed(1);
    $("run").disabled = false;
    $("setup-status").textContent = `${fmt(v.duration)} s · ${v.videoWidth}×${v.videoHeight}`;
  };
  v.onerror = () => { $("setup-status").textContent = "Este formato de video no se puede abrir en el navegador. Prueba con MP4 (H.264)."; };
});

// ---------------- MediaPipe ----------------
let vision = null, landmarker = null, lmKey = "";
const abs = (p) => new URL(p, document.baseURI).href;

async function getLandmarker(model, numPoses) {
  const key = model + numPoses;
  if (landmarker && lmKey === key) return landmarker;
  if (!vision) vision = await import("./vendor/vision_bundle.mjs");
  const { FilesetResolver, PoseLandmarker } = vision;
  let simd = true;
  try { simd = await FilesetResolver.isSimdSupported(); } catch {}
  const base = simd ? "wasm/vision_wasm_internal" : "wasm/vision_wasm_nosimd_internal";
  const fileset = { wasmLoaderPath: abs(base + ".js"), wasmBinaryPath: abs(base + ".wasm") };
  if (landmarker) { try { landmarker.close(); } catch {} landmarker = null; }
  // El modelo se descarga una vez y se entrega como buffer. En claude.ai se
  // publica con extensión .wasm (tipo binario servido); en la app instalable, .task.
  let buf = null;
  for (const name of [`models/pose_landmarker_${model}.task`, `models/pose_landmarker_${model}.task.wasm`]) {
    try { const r = await fetch(abs(name)); if (r.ok) { buf = new Uint8Array(await r.arrayBuffer()); break; } } catch {}
  }
  if (!buf) throw new Error("No se pudo descargar el modelo de pose. Revisa la conexión e inténtalo de nuevo.");
  const opts = (delegate) => ({
    baseOptions: { modelAssetBuffer: buf, delegate },
    runningMode: "VIDEO", numPoses,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { landmarker = await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
  lmKey = key;
  return landmarker;
}

// ---------------- dibujo del esqueleto ----------------
const BONES = [
  [LM.lsh, LM.rsh, "c"], [LM.lhip, LM.rhip, "c"], [LM.lsh, LM.lhip, "l"], [LM.rsh, LM.rhip, "r"],
  [LM.lsh, LM.lel, "l"], [LM.lel, LM.lwr, "l"], [LM.rsh, LM.rel, "r"], [LM.rel, LM.rwr, "r"],
  [LM.lhip, LM.lkn, "l"], [LM.lkn, LM.lank, "l"], [LM.rhip, LM.rkn, "r"], [LM.rkn, LM.rank, "r"],
  [LM.lank, LM.lheel, "l"], [LM.lheel, LM.lfoot, "l"], [LM.lank, LM.lfoot, "l"],
  [LM.rank, LM.rheel, "r"], [LM.rheel, LM.rfoot, "r"], [LM.rank, LM.rfoot, "r"],
];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawPose(ctx, pose, W, H, opts = {}) {
  const lw = Math.max(2, W / 260);
  const col = { l: css("--side-l"), r: css("--accent"), c: "#ffffff" };
  ctx.lineCap = "round";
  for (const [a, b, s] of BONES) {
    const A = pose[a], B = pose[b];
    if (!A || !B || (A.v ?? 1) < 0.3 || (B.v ?? 1) < 0.3) continue;
    ctx.strokeStyle = opts.color || col[s]; ctx.lineWidth = lw * (opts.thin ? 0.7 : 1);
    ctx.beginPath(); ctx.moveTo(A.x * W, A.y * H); ctx.lineTo(B.x * W, B.y * H); ctx.stroke();
  }
  const nose = pose[LM.nose];
  if (nose && (nose.v ?? 1) > 0.3) {
    ctx.fillStyle = opts.color || "#ffffff";
    ctx.beginPath(); ctx.arc(nose.x * W, nose.y * H, lw * 1.6, 0, 7); ctx.fill();
  }
}

function label(ctx, text, x, y, W, color) {
  const fs = Math.max(13, W / 32);
  ctx.font = `600 ${fs}px ${css("--display") || "sans-serif"}`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(0,0,0,.62)";
  ctx.fillRect(x - 4, y - fs, w + 8, fs * 1.25);
  ctx.fillStyle = color || "#fff";
  ctx.fillText(text, x, y);
}

// ---------------- extracción de cuadros + pose ----------------
function seek(video, t) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); video.removeEventListener("seeked", done); res(); };
    const to = setTimeout(done, 3000);
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

async function runAnalysis() {
  const test = state.test;
  const from = Math.max(0, parseFloat($("from").value) || 0);
  let to = Math.min(state.duration, parseFloat($("to").value) || state.duration);
  if (to - from > MAX_SECONDS) to = from + MAX_SECONDS;
  if (to - from < 2) return toast("El tramo debe durar al menos 2 segundos.");
  state.start = from;
  state.cancel = false;
  const model = document.querySelector('input[name="model"]:checked').value;
  const dancers = parseInt($("dancers").value, 10);
  $("run-title").textContent = `Analizando · ${TESTS[test].name}`;
  $("bar").style.width = "0%";
  $("run-status").textContent = "Cargando el modelo de pose…";
  show("running");

  let wake = null;
  try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  try {
    const lm = await getLandmarker(model, test === "dance" ? dancers : 1);
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = state.url;
    await new Promise((r, j) => { video.onloadeddata = r; video.onerror = () => j(new Error("No se pudo decodificar el video.")); });
    const W = video.videoWidth, H = video.videoHeight;
    const live = $("live");
    const scale = Math.min(1, 640 / Math.max(W, H));
    live.width = Math.round(W * scale); live.height = Math.round(H * scale);
    const ctx = live.getContext("2d");
    const n = Math.floor((to - from) * FPS);
    const frames = [];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (state.cancel) throw new Error("cancel");
      const t = from + i / FPS;
      await seek(video, t);
      const res = lm.detectForVideo(video, Math.round(t * 1000) + 1);
      const poses = (res.landmarks || []).map((pl) => pl.map((p) => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4), v: +(p.visibility ?? 1).toFixed(3) })));
      frames.push({ t: i / FPS, poses });
      if (i % 2 === 0 || i === n - 1) {
        ctx.drawImage(video, 0, 0, live.width, live.height);
        poses.forEach((p) => drawPose(ctx, p, live.width, live.height));
        const el = (performance.now() - t0) / 1000;
        const eta = (el / (i + 1)) * (n - i - 1);
        $("bar").style.width = `${((i + 1) / n) * 100}%`;
        $("run-status").textContent = `Cuadro ${i + 1} de ${n} · ${poses.length ? "pose detectada" : "sin persona"} · faltan ~${Math.ceil(eta)} s`;
      }
    }
    state.frames = frames;
    const detected = frames.filter((f) => f.poses.length).length;
    if (detected < frames.length * 0.4) throw new Error(`Solo se detectó a la persona en ${Math.round((detected / frames.length) * 100)} % de los cuadros. Revisa iluminación y encuadre.`);
    const args = { fps: FPS, aspect: W / H };
    let result;
    if (test === "running") result = analyzeRunning(frames, { ...args, kneeSide: $("knee").value });
    else if (test === "chin") result = analyzePullups(frames, { ...args, mode: "chin" });
    else if (test === "pull") result = analyzePullups(frames, { ...args, mode: "pull", calibration: store.get("pullcal") });
    else if (test === "deadlift") result = analyzeDeadlift(frames, args);
    else result = analyzeDance(frames, { ...args, dancers });
    state.result = result;
    state.meta = { test, file: state.file?.name, from, to, fps: FPS, width: W, height: H, model, date: new Date().toISOString() };
    renderResult();
  } catch (e) {
    if (e.message === "cancel") show("setup");
    else { renderError(e.message || String(e)); }
  } finally {
    try { await wake?.release(); } catch {}
  }
}
$("run").addEventListener("click", runAnalysis);
$("cancel").addEventListener("click", () => { state.cancel = true; });

function renderError(msg) {
  $("result-body").innerHTML = `<div class="err"><b>No se pudo completar el análisis.</b><br>${esc(msg)}</div>`;
  show("result");
}

// ---------------- gráficas (canvas) ----------------
function chart(canvas, { series, xMax, yMin, yMax, yLabel, hlines = [], markers = [], bands = [] }) {
  const dpr = window.devicePixelRatio || 1;
  const draw = (cursor) => {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const pad = { l: 44, r: 12, t: 12, b: 26 };
    const X = (x) => pad.l + (x / xMax) * (W - pad.l - pad.r);
    const Y = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
    const muted = css("--muted"), line = css("--line");
    c.font = `11px ${css("--mono")}`;
    // rejilla
    const ticks = niceTicks(yMin, yMax, 4);
    c.strokeStyle = line; c.fillStyle = muted; c.lineWidth = 1; c.textAlign = "right"; c.textBaseline = "middle";
    for (const v of ticks) {
      c.beginPath(); c.moveTo(pad.l, Y(v)); c.lineTo(W - pad.r, Y(v)); c.stroke();
      c.fillText(fmtTick(v), pad.l - 6, Y(v));
    }
    c.textAlign = "center"; c.textBaseline = "top";
    for (const v of niceTicks(0, xMax, 6)) c.fillText(fmtTick(v) + " s", X(v), H - pad.b + 7);
    c.save(); c.translate(11, pad.t + (H - pad.t - pad.b) / 2); c.rotate(-Math.PI / 2); c.textBaseline = "middle"; c.fillText(yLabel, 0, 0); c.restore();
    for (const b of bands) { c.globalAlpha = b.alpha ?? 0.15; c.fillStyle = b.color; c.fillRect(X(b.x0), pad.t, X(b.x1) - X(b.x0), H - pad.t - pad.b); c.globalAlpha = 1; }
    for (const h of hlines) {
      c.strokeStyle = h.color; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(pad.l, Y(h.y)); c.lineTo(W - pad.r, Y(h.y)); c.stroke(); c.setLineDash([]);
      if (h.label) { c.fillStyle = h.color; c.textAlign = "left"; c.textBaseline = "bottom"; c.fillText(h.label, pad.l + 4, Y(h.y) - 2); }
    }
    for (const s of series) {
      c.strokeStyle = s.color; c.lineWidth = s.width || 2; c.beginPath();
      let pen = false;
      for (let i = 0; i < s.y.length; i++) {
        const yv = s.y[i], xv = s.x ? s.x[i] : i / FPS;
        if (!Number.isFinite(yv)) { pen = false; continue; }
        const py = Y(Math.max(yMin, Math.min(yMax, yv)));
        pen ? c.lineTo(X(xv), py) : c.moveTo(X(xv), py); pen = true;
      }
      c.stroke();
    }
    for (const m of markers) {
      if (!Number.isFinite(m.y)) continue;
      c.fillStyle = m.color; c.strokeStyle = css("--surface"); c.lineWidth = 2;
      c.beginPath(); c.arc(X(m.x), Y(Math.max(yMin, Math.min(yMax, m.y))), m.r || 4.5, 0, 7); c.fill(); c.stroke();
    }
    if (Number.isFinite(cursor)) {
      c.strokeStyle = css("--ink"); c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(X(cursor), pad.t); c.lineTo(X(cursor), H - pad.b); c.stroke();
    }
    canvas._x = (px) => ((px - pad.l) / (W - pad.l - pad.r)) * xMax;
  };
  canvas._draw = draw;
  draw();
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const t = canvas._x(e.clientX - r.left);
    if (Number.isFinite(t)) seekResult(Math.max(0, Math.min(xMax, t)));
  });
  return draw;
}
function niceTicks(a, b, n) {
  const span = b - a; if (!(span > 0)) return [a];
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const fmtTick = (v) => (Math.abs(v) >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)).replace(".", ",");

// ---------------- resultados ----------------
function metric(k, v, unit = "", s = "") {
  return `<div class="metric"><span class="k">${k}</span><span class="v">${v}${unit ? `<small>${unit}</small>` : ""}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`;
}
const legend = (items) => `<div class="legend">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("")}</div>`;

function renderResult() {
  const r = state.result, test = state.test, body = $("result-body");
  if (r.error) return renderError(r.error);
  const dur = state.frames.length / FPS;
  let html = "";
  const charts = [];
  const accent = css("--accent"), sideL = css("--side-l"), ok = css("--ok"), bad = css("--bad"), muted = css("--muted"), warn = css("--warn");

  if (test === "running") {
    const near = r.perFoot[r.kneeSide], nearName = r.kneeSide === "right" ? "derecha" : "izquierda";
    html += hero(fmt(r.cadence, 0), "spm", "Cadencia", `${r.steps} apoyos en ${fmt(dur)} s`);
    html += `<div class="metrics">
      ${metric("Tiempo de zancada", fmt(r.stride, 2), "s")}
      ${metric("Contacto", fmt(r.contact * 1000, 0), "ms")}
      ${metric("Vuelo por paso", fmt(r.flight * 1000, 0), "ms")}
      ${metric("Factor de apoyo", fmt(r.dutyFactor * 100, 0), "%")}
      ${metric(`Rodilla al contacto (${nearName})`, fmt(near.kneeAtStrike), "°", `± ${fmt(near.kneeAtStrikeSd)}° · flexión proyectada`)}
      ${metric(`Flexión máx. en apoyo (${nearName})`, fmt(near.peakStanceFlex), "°")}
    </div>`;
    html += stage();
    html += `<div class="chart"><h3>Altura del tobillo</h3><canvas id="c1"></canvas>${legend([[sideL, "Tobillo izquierdo"], [accent, "Tobillo derecho"], [muted, "Contacto"]])}</div>`;
    html += `<div class="chart"><h3>Cadencia acumulada</h3><canvas id="c2"></canvas></div>`;
    html += table(["Pierna", "Apoyos", "Contacto ms", "Rodilla contacto °", "Flexión máx. °"],
      ["left", "right"].map((k) => { const f = r.perFoot[k]; return { cells: [k === "left" ? "Izquierda" : "Derecha", f.strikes, fmt(f.contact * 1000, 0), `${fmt(f.kneeAtStrike)} ± ${fmt(f.kneeAtStrikeSd)}`, fmt(f.peakStanceFlex)] }; }));
    html += notes(["La articulación del tobillo marca el contacto; MediaPipe también ubica talón y punta, pero el patrón de pisada no se clasifica.",
      "La flexión de rodilla es un ángulo proyectado en 2D: compara cada pierna consigo misma, no entre sí.",
      "Izquierda/derecha según el modelo; si las piernas se cruzan en la imagen puede intercambiarlas un ciclo."]);
    charts.push(() => {
      const yMax = Math.max(0.05, ...r.series.hl.filter(Number.isFinite), ...r.series.hr.filter(Number.isFinite)) * 1.1;
      return chart($("c1"), {
        series: [{ y: r.series.hl, color: sideL }, { y: r.series.hr, color: accent }],
        xMax: dur, yMin: 0, yMax, yLabel: "× pierna",
        hlines: [{ y: 0.18 * mean2(r.feet.left.typical, r.feet.right.typical), color: muted }],
        markers: r.allStrikes.map((s) => ({ x: s.t, y: 0, color: s.foot === "left" ? sideL : accent, r: 3.5 })),
      });
    });
    charts.push(() => {
      const ys = r.cadenceSeries.map((c) => c.spm), lo = Math.min(...ys), hi = Math.max(...ys);
      return chart($("c2"), {
        series: [{ x: r.cadenceSeries.map((c) => c.t), y: ys, color: accent, width: 2.5 }],
        markers: r.cadenceSeries.map((c) => ({ x: c.t, y: c.spm, color: accent, r: 3 })),
        xMax: dur, yMin: Math.floor(lo - 6), yMax: Math.ceil(hi + 6), yLabel: "spm",
      });
    });
  }

  if (test === "chin" || test === "pull") {
    const pull = test === "pull";
    html += hero(String(r.count), "reps", pull ? `${r.fullCount} de ${r.reps.length} con rango completo` : "Chin-ups válidas",
      pull ? (r.calibrated ? "Calificado con tu calibración" : "Calificado contra el propio clip") : `${r.reps.length - r.count} intento(s) sin barbilla sobre la barra`);
    html += `<div class="metrics">
      ${metric(pull ? "Tirón medio (completas)" : "Tirón medio", fmt(r.avgMoving, 2), "s", "inicio del movimiento → pico")}
      ${metric("Descenso medio", fmt(r.avgDescent, 2), "s")}
      ${pull ? metric("Corte de colgado", fmt(r.hangCut, 0), "°", "codo extendido") : ""}
      ${pull ? metric("Corte de despeje", fmt(r.clearCut, 2), "troncos", "cabeza sobre manos") : ""}
    </div>`;
    html += stage();
    html += `<div class="chart"><h3>Desplazamiento del tronco respecto a las manos</h3><canvas id="c1"></canvas>${legend([[accent, "Tronco"], [ok, pull ? "Completa" : "Válida"], [bad, pull ? "Parcial" : "Sin barbilla"]])}</div>`;
    html += table(pull ? ["#", "Nota", "Codo abajo °", "Codo arriba °", "Despeje", "Tirón s", "Descenso s"] : ["#", "Nota", "Despeje", "Tirón s", "Subida s", "Descenso s"],
      r.reps.map((x, i) => ({
        t: x.tPeak,
        cells: pull
          ? [i + 1, pill(x.grade, x.full ? "ok" : "bad"), cell(fmt(x.bottomElbow, 0), !x.bottomOk), fmt(x.topElbow, 0), cell(fmt(x.clearance, 2), !x.topOk), x.full ? fmt(x.moving, 2) : "—", fmt(x.descent, 2)]
          : [i + 1, pill(x.grade, x.headOverBar ? "ok" : "bad"), fmt(x.clearance, 2), fmt(x.moving, 2), fmt(x.ascent, 2), fmt(x.descent, 2)],
      })));
    if (pull) html += `<div class="row"><button class="btn" type="button" id="calibrate">Usar este video como calibración</button></div>`;
    html += notes(["El conteo usa el tronco medido contra las manos: si las manos dejan la barra, esos cuadros se descartan.",
      "Despeje = altura de la cabeza sobre las manos, en longitudes de tronco (independiente de la distancia a la cámara).",
      pull ? "Una calibración pertenece a una persona y a una posición de cámara." : "No evalúa balanceo (kipping) ni ángulo de codo."]);
    charts.push(() => {
      const y = r.s.map((v) => (v - r.base) / r.torsoLen);
      const yMax = Math.max(...y.filter(Number.isFinite)) * 1.12;
      return chart($("c1"), {
        series: [{ y, color: accent, width: 2.2 }], xMax: dur, yMin: Math.min(0, ...y.filter(Number.isFinite)), yMax, yLabel: "troncos",
        markers: r.reps.map((x) => ({ x: x.peak / FPS, y: y[x.peak], color: (pull ? x.full : x.headOverBar) ? ok : bad, r: 5 })),
      });
    });
  }

  if (test === "deadlift") {
    html += hero(String(r.count), "reps", "Peso muerto", `Lado analizado: ${r.side} · ${r.flagged ? `${r.flagged} repetición(es) para revisar` : "sin alertas de postura"}`);
    html += `<div class="metrics">
      ${metric("Tirón medio", fmt(r.avgPull, 2), "s", "despegue → bloqueo de cadera")}
      ${metric("Cadera al inicio", fmt(meanOf(r.reps.map((x) => x.startHip)), 0), "°")}
      ${metric("Cadera en bloqueo", fmt(meanOf(r.reps.map((x) => x.lockHip)), 0), "°")}
      ${metric("Tronco al inicio", fmt(meanOf(r.reps.map((x) => x.startTrunk)), 0), "°", "respecto a la vertical")}
    </div>`;
    html += stage();
    html += `<div class="chart"><h3>Ángulo de cadera y desviación cabeza-tronco</h3><canvas id="c1"></canvas>${legend([[accent, "Cadera (hombro-cadera-rodilla)"], [sideL, "Cabeza-tronco"]])}</div>`;
    html += table(["#", "Indicador", "Tirón s", "Cadera ini. °", "Bloqueo °", "Tronco ini. °", "Δ cabeza-tronco °", "Deriva muñeca %"],
      r.reps.map((x, i) => ({ t: x.tLock, cells: [i + 1, x.flag ? pill("revisar", "warn") : pill("sin alerta", "ok"), fmt(x.pull, 2), fmt(x.startHip, 0), fmt(x.lockHip, 0), fmt(x.startTrunk, 0), cell(fmt(x.devDelta, 0), x.flag), fmt(x.barDrift, 0)] })));
    html += notes(["El original usa SAM 3.1 para el disco y Gemma para clasificar la espalda; aquí todo sale de la pose, así que el indicador es aproximado.",
      "Δ cabeza-tronco compara el ángulo cadera→hombro→oreja durante el tirón contra tu postura en bloqueo; ≥ 20° marca la repetición para revisar en video. Mirar hacia abajo también lo eleva.",
      "La muñeca se usa como sustituto de la barra; la deriva se expresa en % de la longitud de la pierna."]);
    charts.push(() => {
      const ys = r.hip.filter(Number.isFinite).concat(r.dev.filter(Number.isFinite));
      return chart($("c1"), {
        series: [{ y: r.hip, color: accent, width: 2.4 }, { y: r.dev, color: sideL }], xMax: dur,
        yMin: 0, yMax: Math.ceil(Math.max(...ys) / 20) * 20 + 10, yLabel: "grados",
        bands: r.reps.map((x) => ({ x0: x.onset / FPS, x1: x.lock / FPS, color: x.flag ? warn : muted, alpha: x.flag ? 0.22 : 0.12 })),
      });
    });
  }

  if (test === "dance") {
    html += hero(fmt(r.overall * 100, 0), "%", "Sincronía del grupo", `Postura ${fmt(r.postureScore * 100, 0)} % · tiempo ${fmt(r.timingScore * 100, 0)} % · ${fmt(r.validFraction * 100, 0)} % de cuadros evaluables`);
    html += `<div class="metrics">${r.dancerScore.map((s, i) => metric(`Bailarín ${i + 1}${i === 0 ? " (izq.)" : i === r.dancers - 1 ? " (der.)" : ""}`, fmt(s * 100, 0), "%")).join("")}</div>`;
    html += stage();
    html += `<div class="chart"><h3>Sincronía en el tiempo</h3><canvas id="c1"></canvas>${legend([[accent, "Grupo (media móvil 0,5 s)"], [bad, "Momentos más desincronizados"]])}</div>`;
    html += table(["Momento", "Tiempo", "Sincronía", "Segmento que más difiere"],
      r.worst.map((w, i) => ({ t: w.t, cells: [i + 1, fmt(w.t + state.start, 1) + " s", fmt(w.score * 100, 0) + " %", w.segment] })));
    html += notes(["La puntuación mide acuerdo entre bailarines, no corrección frente a una coreografía de referencia.",
      "0 % equivale a comparar momentos no relacionados del mismo clip y 100 % a la mejor coincidencia que alcanzan; no se compara entre videos.",
      "Versión simplificada del original: no puntúa por separado las llegadas a cada posición."]);
    charts.push(() => chart($("c1"), {
      series: [{ y: r.smoothScore.map((v) => v * 100), color: accent, width: 2.4 }], xMax: dur, yMin: 0, yMax: 100, yLabel: "%",
      markers: r.worst.map((w) => ({ x: w.t, y: w.score * 100, color: bad, r: 5 })),
    }));
  }

  html += `<div class="row">
    <button class="btn" type="button" id="exp-csv">Exportar resultados (CSV)</button>
    <button class="btn" type="button" id="exp-json">Exportar puntos (JSON)</button>
    <button class="btn" type="button" data-go="home">Nuevo análisis</button>
  </div>`;
  body.innerHTML = html;
  show("result");
  setupStage();
  const draws = charts.map((f) => f());
  state.draws = draws;
  body.querySelectorAll("tbody tr[data-t]").forEach((tr) => tr.addEventListener("click", () => seekResult(parseFloat(tr.dataset.t))));
  $("exp-csv").onclick = () => exportFile("csv");
  $("exp-json").onclick = () => exportFile("json");
  const cal = $("calibrate");
  if (cal) cal.onclick = () => {
    const c = calibrationFrom(r);
    if (c.error) return toast(c.error);
    store.set("pullcal", c); renderCalib();
    toast(`Calibración guardada: colgado ${fmt(c.hang)}°`);
  };
}
const mean2 = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(a) ? a : b);
const meanOf = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : NaN; };
const pill = (t, k) => `<span class="pill ${k}">${t}</span>`;
const cell = (v, short) => ({ html: v, cls: short ? "short" : "" });
const hero = (num, unit, title, cap) => `<div class="hero"><div class="num">${num}<small>${unit}</small></div><div class="cap"><strong>${title}</strong>${esc(cap)}</div></div>`;
const stage = () => `<div class="stage" id="rstage"><video id="rvideo" playsinline muted controls preload="auto"></video><canvas class="over" id="rover"></canvas></div>`;
const notes = (items) => `<div class="notes"><h3>Cómo leerlo</h3><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
function table(head, rows) {
  return `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr${Number.isFinite(r.t) ? ` data-t="${r.t}"` : ""}>${r.cells.map((c) => (typeof c === "object" ? `<td class="${c.cls}">${c.html}</td>` : `<td>${c}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// ---------------- reproducción con superposición ----------------
function setupStage() {
  const v = $("rvideo"), cv = $("rover");
  v.src = state.url;
  v.addEventListener("loadedmetadata", () => { v.currentTime = state.start; }, { once: true });
  const paint = () => {
    const rect = v.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = rect.width * dpr; cv.height = rect.height * dpr;
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // zona real del video dentro del elemento (object-fit: contain)
    const ar = v.videoWidth / v.videoHeight || state.aspect;
    let w = rect.width, h = w / ar;
    if (h > rect.height) { h = rect.height; w = h * ar; }
    const ox = (rect.width - w) / 2, oy = (rect.height - h) / 2;
    c.translate(ox, oy);
    const t = v.currentTime - state.start;
    const i = Math.round(t * FPS);
    const f = state.frames[i];
    for (const d of state.draws || []) d(t);
    if (!f || t < -0.05) return;
    overlay(c, f, i, w, h);
  };
  const loop = () => { paint(); if (!v.paused) requestAnimationFrame(loop); };
  v.addEventListener("play", loop);
  v.addEventListener("seeked", paint);
  v.addEventListener("loadeddata", paint);
  window.addEventListener("resize", () => { paint(); });
  state.paint = paint;
}

function overlay(c, f, i, W, H) {
  const r = state.result, test = state.test;
  if (test === "dance") {
    const tr = r.tracks[i] || [];
    tr.forEach((p, d) => {
      if (!p) return;
      drawPose(c, p, W, H);
      const hx = Math.min(p[LM.lsh].x, p[LM.rsh].x) * W, hy = Math.min(p[LM.lsh].y, p[LM.rsh].y) * H - 34;
      label(c, String(d + 1), hx, Math.max(18, hy), W);
    });
    const s = r.smoothScore[i];
    if (Number.isFinite(s)) label(c, `Sincronía ${Math.round(s * 100)} %`, 10, 28, W);
    return;
  }
  const p = f.poses[0];
  if (!p) return;
  drawPose(c, p, W, H);
  if (test === "running") {
    for (const s of r.allStrikes) {
      if (i >= s.frame && i < s.frame + Math.round(0.25 * FPS)) {
        const a = p[s.foot === "left" ? LM.lank : LM.rank];
        c.strokeStyle = s.foot === "left" ? css("--side-l") : css("--accent");
        c.lineWidth = 3; c.beginPath(); c.arc(a.x * W, a.y * H, W / 28, 0, 7); c.stroke();
      }
    }
    const done = r.cadenceSeries.filter((x) => x.t <= i / FPS).pop();
    label(c, `${done ? Math.round(done.spm) : "—"} spm`, 10, 28, W);
  } else if (test === "chin" || test === "pull") {
    const n = r.reps.filter((x) => x.peak <= i && (test === "pull" || x.headOverBar)).length;
    label(c, `${n} reps · codo ${Math.round(r.elbow[i]) || "—"}°`, 10, 28, W);
  } else if (test === "deadlift") {
    const n = r.reps.filter((x) => x.lock <= i).length;
    label(c, `${n} reps · cadera ${Math.round(r.hip[i]) || "—"}°`, 10, 28, W);
  }
}

function seekResult(t) {
  const v = $("rvideo");
  if (!v) return;
  v.pause();
  v.currentTime = state.start + t;
  $("rstage").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------- exportación ----------------
function resultRows() {
  const r = state.result, t = state.test;
  if (t === "running") return [["evento", "pie", "tiempo_s", "contacto_s", "rodilla_contacto_deg", "flexion_max_apoyo_deg"],
    ...r.allStrikes.map((s) => ["apoyo", s.foot === "left" ? "izquierdo" : "derecho", s.t + state.start, s.contact, s.kneeFlex, s.peakFlex]),
    [], ["cadencia_spm", r.cadence], ["zancada_s", r.stride], ["contacto_s", r.contact], ["factor_apoyo", r.dutyFactor]];
  if (t === "chin" || t === "pull") return [["rep", "nota", "pico_s", "tiron_s", "subida_s", "descenso_s", "codo_abajo_deg", "codo_arriba_deg", "despeje_troncos"],
    ...r.reps.map((x, i) => [i + 1, x.grade, x.tPeak + state.start, x.moving, x.ascent, x.descent, x.bottomElbow, x.topElbow, x.clearance])];
  if (t === "deadlift") return [["rep", "indicador", "bloqueo_s", "tiron_s", "cadera_inicio_deg", "cadera_bloqueo_deg", "tronco_inicio_deg", "delta_cabeza_tronco_deg", "deriva_muneca_pct"],
    ...r.reps.map((x, i) => [i + 1, x.flag ? "revisar" : "sin alerta", x.tLock + state.start, x.pull, x.startHip, x.lockHip, x.startTrunk, x.devDelta, x.barDrift])];
  return [["tiempo_s", "sincronia_grupo"], ...r.frameScore.map((s, i) => [i / FPS + state.start, s]), [],
    ["bailarin", "sincronia"], ...r.dancerScore.map((s, i) => [i + 1, s])];
}
async function exportFile(kind) {
  const base = `biovision_${state.test}_${(state.meta.date || "").slice(0, 10)}`;
  let filename, data;
  if (kind === "csv") {
    filename = base + ".csv";
    data = "﻿" + resultRows().map((row) => row.map((v) => (typeof v === "number" ? (Number.isFinite(v) ? +v.toFixed(4) : "") : `"${String(v ?? "").replace(/"/g, '""')}"`)).join(";")).join("\r\n");
  } else {
    filename = base + "_puntos.json";
    data = JSON.stringify({ meta: { ...state.meta, landmarks: "MediaPipe Pose (33 puntos), coordenadas normalizadas" }, frames: state.frames });
  }
  try {
    const dl = window.claude?.use ? await window.claude.use("downloads") : null;
    if (dl) { await dl.save({ filename, data: new Blob([data]) }); toast("Archivo guardado"); return; }
  } catch (e) {
    if (e && e.code === "declined") return;
    if (e && e.code && e.code !== "unavailable" && e.code !== "not_granted") return toast("No se pudo guardar el archivo.");
  }
  // Fuera de claude.ai (instalada como app): descarga normal.
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: kind === "csv" ? "text/csv" : "application/json" }));
  a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- instalable (fuera de claude.ai) ----------------
if ("serviceWorker" in navigator && document.querySelector('link[rel="manifest"]')) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Gancho de pruebas automatizadas (sin efecto en el uso normal).
window.__bv = { state, renderResult, TESTS };
