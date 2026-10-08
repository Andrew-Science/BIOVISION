// Pruebas de los análisis con esqueletos sintéticos de valores conocidos.
import { analyzeRunning, analyzePullups, analyzeDeadlift, analyzeDance, calibrationFrom, LM } from "../analysis.js";
import assert from "node:assert/strict";

const fps = 30;
const blank = () => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0.1 }));
const set = (p, i, x, y, v = 0.95) => { p[i] = { x, y, v }; };
let rs = 3;
const noise = (a) => { rs = (rs * 16807) % 2147483647; return (rs / 2147483647 - 0.5) * 2 * a; };
const aspect = 1; // coordenadas ya en unidades cuadradas

// --- carrera: 170 spm, 10 s
{
  const spm = 170, stride = 120 / spm, duty = 0.36, n = 10 * fps;
  const frames = [];
  for (let f = 0; f < n; f++) {
    const t = f / fps, p = blank();
    set(p, LM.lsh, 0.5, 0.25); set(p, LM.rsh, 0.5, 0.25);
    set(p, LM.lhip, 0.5, 0.5); set(p, LM.rhip, 0.5, 0.5);
    for (const [kn, an, ph] of [[LM.lkn, LM.lank, 0], [LM.rkn, LM.rank, 0.5]]) {
      const c = ((t / stride + ph) % 1);
      const h = c < duty ? 0 : 0.12 * Math.sin(Math.PI * (c - duty) / (1 - duty));
      const ay = 0.9 - h + noise(0.002);
      set(p, an, 0.5 + 0.05 * Math.cos(2 * Math.PI * c), ay);
      set(p, kn, 0.53, (0.5 + ay) / 2);
    }
    frames.push({ t, poses: [p] });
  }
  const r = analyzeRunning(frames, { fps, aspect });
  assert.ok(!r.error, r.error);
  console.log("carrera: cadencia", r.cadence.toFixed(1), "pasos", r.steps, "contacto", r.contact.toFixed(3), "rodilla", r.perFoot.right.kneeAtStrike.toFixed(1));
  assert.ok(Math.abs(r.cadence - spm) < 3, "cadencia fuera de tolerancia");
  assert.ok(r.steps >= 26 && r.steps <= 30, "número de pasos");
  assert.ok(Math.abs(r.contact - duty * stride) < 0.06, "tiempo de contacto");
}

// --- dominadas pull-up: 5 reps cada 3 s, la 3.ª con colgado incompleto
function pullFrames({ reps = 5, period = 3, partial = 2, chinFail = -1 }) {
  const n = Math.round((reps * period + 1.5) * fps), frames = [];
  for (let f = 0; f < n; f++) {
    const t = f / fps, p = blank();
    const k = Math.floor((t - 0.75) / period), ph = ((t - 0.75) / period) % 1;
    const up = t < 0.75 || k >= reps ? 0 : Math.max(0, Math.sin(Math.PI * ph)) ** 1.2;
    const v = Math.round((t - 0.75) / period); // valle más cercano
    const hangDeg = v === partial ? 135 : 168;
    const lift = k === chinFail ? 0.14 : 0.22;
    const shY = 0.42 - lift * up;
    const elbowDeg = hangDeg - (hangDeg - 55) * up;
    const wristY = 0.2;
    set(p, LM.lwr, 0.42, wristY); set(p, LM.rwr, 0.58, wristY);
    // codo: entre hombro y muñeca, desplazado para producir el ángulo deseado
    for (const [sh, el, x] of [[LM.lsh, LM.lel, 0.42], [LM.rsh, LM.rel, 0.58]]) {
      set(p, sh, x, shY);
      const L = (shY - wristY) / 2 / Math.sin((elbowDeg / 2) * Math.PI / 180);
      const off = Math.sqrt(Math.max(0, L * L - ((shY - wristY) / 2) ** 2));
      set(p, el, x + (x < 0.5 ? -off : off), (shY + wristY) / 2);
    }
    set(p, LM.lhip, 0.45, shY + 0.25); set(p, LM.rhip, 0.55, shY + 0.25);
    for (const j of [LM.nose, LM.leye, LM.reye, LM.lear, LM.rear]) set(p, j, 0.5, shY - 0.05 + noise(0.002));
    frames.push({ t, poses: [p] });
  }
  return frames;
}
{
  const r = analyzePullups(pullFrames({}), { fps, aspect, mode: "pull" });
  assert.ok(!r.error, r.error);
  console.log("pull-ups:", r.reps.map((x) => `${x.grade}(${x.bottomElbow.toFixed(0)}°, ${x.clearance.toFixed(2)})`).join(" "), "media", r.avgMoving.toFixed(2), "s");
  assert.equal(r.reps.length, 5);
  assert.equal(r.fullCount, 4);
  assert.equal(r.reps[2].grade, "parcial");
  const cal = calibrationFrom(analyzePullups(pullFrames({ partial: -1 }), { fps, aspect, mode: "pull" }));
  assert.ok(!cal.error, cal.error);
  console.log("calibración:", cal.hang.toFixed(1), "°", cal.clear.toFixed(2));
  const rc = analyzePullups(pullFrames({}), { fps, aspect, mode: "pull", calibration: cal });
  assert.equal(rc.fullCount, 4);
}
// --- chin-ups: 4 reps, la 2.ª sin barbilla sobre la barra
{
  const r = analyzePullups(pullFrames({ reps: 4, partial: -1, chinFail: 1 }), { fps, aspect, mode: "chin" });
  assert.ok(!r.error, r.error);
  console.log("chin-ups:", r.count, "válidas de", r.reps.length, r.reps.map((x) => x.clearance.toFixed(2)).join(","));
  assert.equal(r.reps.length, 4);
  assert.equal(r.count, 3);
}

// --- peso muerto: 4 reps, la 3.ª con flexión cabeza-tronco marcada
{
  const n = Math.round(4 * 4 * fps + fps), frames = [];
  for (let f = 0; f < n; f++) {
    const t = f / fps, p = blank();
    const k = Math.floor((t - 0.5) / 4), ph = ((t - 0.5) / 4) % 1;
    const ext = t < 0.5 || k >= 4 ? 0 : (ph < 0.5 ? Math.sin(Math.PI * ph) : Math.sin(Math.PI * ph)) ;
    const trunkDeg = 65 * (1 - ext); // inclinación del tronco
    const hip = { x: 0.5, y: 0.55 };
    const tr = trunkDeg * Math.PI / 180, L = 0.3;
    const sh = { x: hip.x + L * Math.sin(tr), y: hip.y - L * Math.cos(tr) };
    set(p, LM.lhip, hip.x, hip.y); set(p, LM.lsh, sh.x, sh.y);
    set(p, LM.lkn, 0.55, 0.72); set(p, LM.lank, 0.5, 0.9);
    const headDev = (k === 2 ? 45 : 5) * (1 - ext) * Math.PI / 180;
    set(p, LM.lear, sh.x + 0.08 * Math.sin(tr + headDev), sh.y - 0.08 * Math.cos(tr + headDev));
    set(p, LM.lwr, sh.x, 0.75 - 0.2 * ext);
    for (const j of [LM.rsh, LM.rhip, LM.rkn]) p[j].v = 0.2;
    frames.push({ t, poses: [p] });
  }
  const r = analyzeDeadlift(frames, { fps, aspect });
  assert.ok(!r.error, r.error);
  console.log("peso muerto:", r.count, "reps,", r.reps.map((x) => `${x.pull.toFixed(2)}s Δ${x.devDelta.toFixed(0)}° ${x.flag ? "⚑" : ""}`).join(" | "));
  assert.equal(r.count, 4);
  assert.equal(r.flagged, 1);
  assert.ok(r.reps[2].flag);
}

// --- baile: sincronizados vs. desincronizados
function danceFrames(lagFrames, chaos) {
  const n = 12 * fps, frames = [];
  const pose = (cx, t) => {
    const p = blank();
    const a = Math.sin(2 * Math.PI * 0.7 * t), b = Math.sin(2 * Math.PI * 1.1 * t + 1);
    set(p, LM.lhip, cx - 0.03, 0.6); set(p, LM.rhip, cx + 0.03, 0.6);
    set(p, LM.lsh, cx - 0.04, 0.4); set(p, LM.rsh, cx + 0.04, 0.4);
    set(p, LM.nose, cx, 0.33);
    set(p, LM.lel, cx - 0.04 - 0.08 * Math.cos(a), 0.4 + 0.08 * Math.sin(a));
    set(p, LM.lwr, cx - 0.04 - 0.16 * Math.cos(a), 0.4 + 0.16 * Math.sin(a) * 0.5);
    set(p, LM.rel, cx + 0.04 + 0.08 * Math.cos(b), 0.4 + 0.08 * Math.sin(b));
    set(p, LM.rwr, cx + 0.04 + 0.15 * Math.cos(b), 0.4 + 0.15 * Math.sin(b));
    set(p, LM.lkn, cx - 0.04 + 0.03 * a, 0.75); set(p, LM.rkn, cx + 0.04 - 0.03 * b, 0.75);
    set(p, LM.lank, cx - 0.04, 0.9); set(p, LM.rank, cx + 0.04, 0.9);
    return p;
  };
  for (let f = 0; f < n; f++) {
    const t = f / fps;
    const t2 = chaos ? t * 1.37 + 3 : t - lagFrames / fps;
    frames.push({ t, poses: [pose(0.7, t2), pose(0.3, t)] }); // orden invertido a propósito
  }
  return frames;
}
{
  const sync = analyzeDance(danceFrames(1, false), { fps, aspect, dancers: 2 });
  const off = analyzeDance(danceFrames(0, true), { fps, aspect, dancers: 2 });
  assert.ok(!sync.error, sync.error); assert.ok(!off.error, off.error);
  console.log("baile: sincronizados", (sync.overall * 100).toFixed(0) + "%", "| desincronizados", (off.overall * 100).toFixed(0) + "%", "| peor momento", off.worst[0].segment);
  assert.ok(sync.overall > 0.7);
  assert.ok(off.overall < sync.overall - 0.3);
}
console.log("OK: todas las pruebas pasaron");
