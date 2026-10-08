// Análisis biomecánico a partir de puntos de MediaPipe Pose (33 puntos).
// Portado y adaptado de jeremyipark/vision-demos (Apache-2.0): running/gait.py,
// chin_ups/reps.py, pull_ups/reps.py + rom.py, deadlift/reps.py y
// dance_sync/similarity.py. Las coordenadas x se escalan por la relación de
// aspecto, así que todas las longitudes quedan en "alturas de cuadro".
//
// frames: [{ t: segundos, poses: [ [ {x, y, v} x33 ], ... ] }]

export const LM = {
  nose: 0, leye: 2, reye: 5, lear: 7, rear: 8,
  lsh: 11, rsh: 12, lel: 13, rel: 14, lwr: 15, rwr: 16,
  lhip: 23, rhip: 24, lkn: 25, rkn: 26, lank: 27, rank: 28,
  lheel: 29, rheel: 30, lfoot: 31, rfoot: 32,
};

const MIN_VIS = 0.3;

// ---------- utilidades numéricas ----------

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function percentile(arr, p) {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const k = (a.length - 1) * (p / 100);
  const lo = Math.floor(k), hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}
export const median = (arr) => percentile(arr, 50);
export function mean(arr) {
  const a = arr.filter(isNum);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
export function sd(arr) {
  const a = arr.filter(isNum);
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** Interpola linealmente huecos (NaN) internos de hasta maxGap muestras. */
export function fillGaps(arr, maxGap) {
  const out = arr.slice();
  let i = 0;
  while (i < out.length) {
    if (isNum(out[i])) { i++; continue; }
    let j = i;
    while (j < out.length && !isNum(out[j])) j++;
    const len = j - i;
    if (i > 0 && j < out.length && len <= maxGap) {
      const a = out[i - 1], b = out[j];
      for (let k = i; k < j; k++) out[k] = a + (b - a) * ((k - i + 1) / (len + 1));
    }
    i = j;
  }
  return out;
}

export function medfilt(arr, k) {
  if (k <= 1) return arr.slice();
  const h = Math.floor(k / 2);
  return arr.map((v, i) => {
    if (!isNum(v)) return NaN;
    const w = [];
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) if (isNum(arr[j])) w.push(arr[j]);
    return median(w);
  });
}

export function movavg(arr, k) {
  if (k <= 1) return arr.slice();
  const h = Math.floor(k / 2);
  return arr.map((v, i) => {
    if (!isNum(v)) return NaN;
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) if (isNum(arr[j])) { s += arr[j]; n++; }
    return s / n;
  });
}

/** Ventana impar escalada a la frecuencia de muestreo (definida a 30 fps). */
const win = (k30, fps) => { const k = Math.max(1, Math.round((k30 * fps) / 30)); return k % 2 ? k : k + 1; };

export function smooth(arr, fps, med30, mean30, gapSec = 0.25) {
  return movavg(medfilt(fillGaps(arr, Math.round(gapSec * fps)), win(med30, fps)), win(mean30, fps));
}

export function angleDeg(a, b, c) {
  if (!a || !b || !c) return NaN;
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
  if (!nu || !nv) return NaN;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
  return (Math.acos(cos) * 180) / Math.PI;
}
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : NaN);
const midpt = (a, b) => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) } : null);
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Punto escalado (x * aspecto) o null si la visibilidad es baja. */
export function P(pose, idx, aspect, minVis = MIN_VIS) {
  const l = pose && pose[idx];
  if (!l) return null;
  const v = l.v ?? 1;
  if (v < minVis) return null;
  return { x: l.x * aspect, y: l.y, v };
}

/** Primera persona de cada cuadro (análisis de un solo sujeto). */
const subject = (frames) => frames.map((f) => (f.poses && f.poses[0]) || null);

/** Recorridos (índices inicio..fin inclusive) donde pred(v) se cumple. */
function runs(arr, pred) {
  const out = [];
  let s = -1;
  for (let i = 0; i < arr.length; i++) {
    const ok = isNum(arr[i]) && pred(arr[i]);
    if (ok && s < 0) s = i;
    if (!ok && s >= 0) { out.push([s, i - 1]); s = -1; }
  }
  if (s >= 0) out.push([s, arr.length - 1]);
  return out;
}

/** Instante (fraccional) en que la señal cruza el umbral entre i-1 e i. */
function crossT(arr, i, thr) {
  if (i <= 0 || !isNum(arr[i - 1]) || !isNum(arr[i])) return i;
  const a = arr[i - 1], b = arr[i];
  if (a === b) return i;
  return i - 1 + (thr - a) / (b - a);
}

// ---------- CARRERA: cadencia, contactos y rodilla ----------

export function analyzeRunning(frames, { fps, aspect, kneeSide = "right" }) {
  const n = frames.length;
  const poses = subject(frames);
  const sides = {
    left: { hip: LM.lhip, kn: LM.lkn, an: LM.lank },
    right: { hip: LM.rhip, kn: LM.rkn, an: LM.rank },
  };

  const thigh = [], shank = [];
  for (const p of poses) for (const s of Object.values(sides)) {
    const h = P(p, s.hip, aspect), k = P(p, s.kn, aspect), a = P(p, s.an, aspect);
    thigh.push(dist(h, k)); shank.push(dist(k, a));
  }
  const legLen = median(thigh) + median(shank);
  if (!isNum(legLen) || legLen <= 0) return { error: "No se detectaron piernas completas en el video." };

  const feet = {};
  for (const [name, s] of Object.entries(sides)) {
    const y = poses.map((p) => { const a = P(p, s.an, aspect); return a ? a.y : NaN; });
    const ground = percentile(y, 90);
    const h = smooth(y.map((v) => (ground - v) / legLen), fps, 3, 3, 0.15);

    // Altura típica de balanceo: mediana de los picos de cada excursión.
    const p98 = percentile(h, 98);
    const exc = runs(h, (v) => v > 0.3 * p98);
    const peaks = exc.map(([a, b]) => Math.max(...h.slice(a, b + 1)));
    const typical = median(peaks);
    const contactThr = 0.18 * typical, swingThr = 0.55 * typical;

    // Contactos: tramos bajo el umbral. Se absorben contactos demasiado
    // cortos y balanceos que no alcanzan la altura mínima.
    let contacts = runs(h, (v) => v < contactThr);
    const minContact = Math.max(1, Math.round(0.1 * fps));
    contacts = contacts.filter(([a, b]) => b - a + 1 >= minContact || a === 0 || b === n - 1);
    const merged = [];
    for (const c of contacts) {
      const last = merged[merged.length - 1];
      if (last) {
        const swingPeak = Math.max(...h.slice(last[1] + 1, c[0]).filter(isNum), -Infinity);
        if (swingPeak < swingThr) { last[1] = c[1]; continue; }
      }
      merged.push([c[0], c[1]]);
    }

    const strikes = [];
    for (const [a, b] of merged) {
      if (a === 0) continue; // ya estaba apoyado al iniciar el clip
      const tStrike = crossT(h, a, contactThr) / fps;
      const complete = b < n - 1;
      const tEnd = complete ? crossT(h, b + 1, contactThr) / fps : NaN;
      const fr = Math.min(n - 1, Math.round(tStrike * fps));
      const sd_ = sides[name];
      const ang = angleDeg(P(poses[fr], sd_.hip, aspect), P(poses[fr], sd_.kn, aspect), P(poses[fr], sd_.an, aspect));
      // Flexión máxima en apoyo (proyectada), con tope fisiológico de 85°.
      let peakFlex = NaN;
      if (complete) {
        for (let i = a; i <= b; i++) {
          const g = angleDeg(P(poses[i], sd_.hip, aspect), P(poses[i], sd_.kn, aspect), P(poses[i], sd_.an, aspect));
          const fl = 180 - g;
          if (isNum(fl) && fl <= 85 && !(fl <= peakFlex)) peakFlex = fl;
        }
      }
      strikes.push({
        foot: name, t: tStrike, frame: fr,
        contact: complete ? tEnd - tStrike : NaN,
        mid: complete ? (tStrike + tEnd) / 2 : NaN,
        kneeFlex: isNum(ang) ? 180 - ang : NaN,
        peakFlex,
      });
    }
    feet[name] = { h, ground, typical, strikes };
  }

  // Zancadas: mismo pie a mismo pie, cronometradas en el apoyo medio.
  const strideTimes = [];
  const strideEvents = [];
  for (const f of Object.values(feet)) {
    const mids = f.strikes.map((s) => s.mid).filter(isNum);
    for (let i = 1; i < mids.length; i++) { strideTimes.push(mids[i] - mids[i - 1]); strideEvents.push({ t: mids[i], dt: mids[i] - mids[i - 1] }); }
  }
  const medStride = median(strideTimes);
  const good = strideEvents.filter((e) => e.dt < 1.6 * medStride && e.dt > 0.5 * medStride);
  const allStrikes = [...feet.left.strikes, ...feet.right.strikes].sort((a, b) => a.t - b.t);

  if (good.length < 2) {
    return { error: "Se detectaron muy pocos pasos. Graba de lado, con ambos tobillos visibles y al menos 6–8 segundos de carrera.", feet, allStrikes, legLen };
  }

  const cadence = 120 / mean(good.map((e) => e.dt));
  good.sort((a, b) => a.t - b.t);
  const cadenceSeries = good.map((e, i) => ({ t: e.t, spm: 120 / mean(good.slice(0, i + 1).map((g) => g.dt)), inst: 120 / e.dt }));

  const perFoot = {};
  for (const [name, f] of Object.entries(feet)) {
    const kf = f.strikes.map((s) => s.kneeFlex);
    const ct = f.strikes.map((s) => s.contact);
    const pf = f.strikes.map((s) => s.peakFlex);
    perFoot[name] = {
      strikes: f.strikes.length,
      kneeAtStrike: mean(kf), kneeAtStrikeSd: sd(kf),
      peakStanceFlex: mean(pf),
      contact: mean(ct),
    };
  }
  const contactAll = mean(allStrikes.map((s) => s.contact));
  const stride = mean(good.map((e) => e.dt));
  return {
    cadence, steps: allStrikes.length, stride, contact: contactAll,
    dutyFactor: contactAll / stride,
    flight: stride / 2 - contactAll,
    perFoot, kneeSide, allStrikes, cadenceSeries, feet, legLen,
    series: { hl: feet.left.h, hr: feet.right.h },
  };
}

// ---------- DOMINADAS (chin-ups y pull-ups) ----------

function headPoint(pose, aspect, joints) {
  let sx = 0, sy = 0, sw = 0;
  for (const j of joints) {
    const p = P(pose, j, aspect);
    if (p) { sx += p.x * p.v; sy += p.y * p.v; sw += p.v; }
  }
  return sw ? { x: sx / sw, y: sy / sw } : null;
}

function elbowAngle(pose, aspect) {
  const L = angleDeg(P(pose, LM.lsh, aspect), P(pose, LM.lel, aspect), P(pose, LM.lwr, aspect));
  const R = angleDeg(P(pose, LM.rsh, aspect), P(pose, LM.rel, aspect), P(pose, LM.rwr, aspect));
  return mean([L, R]);
}

/** Conteo por histéresis: se arma en el valle, se confirma en el pico. */
function hysteresisReps(s, hi, lo) {
  const reps = [];
  let armed = false, inRep = false, peak = -1;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (!isNum(v)) continue;
    if (inRep) {
      if (v > s[peak]) peak = i;
      if (v < lo) { reps.push({ peak, closed: true }); inRep = false; armed = true; }
    } else if (v < lo) armed = true;
    else if (armed && v > hi) { inRep = true; armed = false; peak = i; }
  }
  if (inRep) reps.push({ peak, closed: false });
  return reps;
}

function argExt(s, a, b, cmp) {
  let k = -1;
  for (let i = Math.max(0, a); i <= Math.min(s.length - 1, b); i++) if (isNum(s[i]) && (k < 0 || cmp(s[i], s[k]))) k = i;
  return k;
}

export function analyzePullups(frames, { fps, aspect, mode = "chin", calibration = null }) {
  const poses = subject(frames);
  const n = poses.length;
  const headJoints = mode === "chin" ? [LM.leye, LM.reye] : [LM.nose, LM.leye, LM.reye, LM.lear, LM.rear];

  const torsoY = [], handY = [], headY = [], elbow = [], torsoLen = [];
  for (const p of poses) {
    const sh = midpt(P(p, LM.lsh, aspect), P(p, LM.rsh, aspect));
    const hp = midpt(P(p, LM.lhip, aspect), P(p, LM.rhip, aspect));
    const pts = [LM.lsh, LM.rsh, LM.lhip, LM.rhip].map((j) => P(p, j, aspect)).filter(Boolean);
    torsoY.push(pts.length >= 3 ? mean(pts.map((q) => q.y)) : NaN);
    const w = [LM.lwr, LM.rwr].map((j) => P(p, j, aspect)).filter(Boolean);
    handY.push(w.length ? mean(w.map((q) => q.y)) : NaN);
    const hd = headPoint(p, aspect, headJoints);
    headY.push(hd ? hd.y : NaN);
    elbow.push(elbowAngle(p, aspect));
    torsoLen.push(dist(sh, hp));
  }

  // Manos fuera de la barra: se descartan esos cuadros.
  const handMed = median(handY);
  const raw = torsoY.map((t, i) => (Math.abs(handY[i] - handMed) > 0.05 ? NaN : handY[i] - t));
  const s = smooth(raw, fps, 5, 7, 0.3);
  const base = percentile(s, 10);
  const amp = percentile(s, 98) - base;
  const tLen = median(torsoLen);
  if (!isNum(amp) || amp < 0.25 * tLen || amp < 0.02) {
    return { error: "No se detectó movimiento vertical suficiente. Verifica que las manos y el tronco se vean completos.", s, base, reps: [] };
  }
  const cands = hysteresisReps(s, base + 0.6 * amp, base + 0.3 * amp);
  const vel = s.map((v, i) => (i > 0 && isNum(v) && isNum(s[i - 1]) ? (v - s[i - 1]) * fps : NaN));
  const elbowS = smooth(elbow, fps, 5, 5, 0.3);
  const headS = smooth(headY, fps, 3, 5, 0.3);
  const handS = smooth(handY, fps, 5, 7, 0.3);

  const reps = [];
  let prevPeak = 0;
  for (let r = 0; r < cands.length; r++) {
    const { peak, closed } = cands[r];
    const valley = argExt(s, prevPeak, peak, (a, b) => a < b);
    // Inicio: desde la máxima velocidad hacia atrás hasta que la curva se aplana.
    const vmaxI = argExt(vel, valley, peak, (a, b) => a > b);
    const vmax = vel[vmaxI];
    let onset = vmaxI;
    while (onset > valley && isNum(vel[onset - 1]) && vel[onset - 1] > 0.1 * vmax) onset--;
    const nextPeak = r + 1 < cands.length ? cands[r + 1].peak : n - 1;
    const nextValley = closed ? argExt(s, peak, nextPeak, (a, b) => a < b) : -1;
    let returned = -1;
    if (closed) for (let i = peak; i <= nextValley; i++) if (isNum(s[i]) && s[i] <= s[valley] + 0.1 * (s[peak] - s[valley])) { returned = i; break; }

    // Barbilla/cabeza sobre la barra en el pico (ventana de ±2 cuadros).
    const w0 = Math.max(0, peak - 2), w1 = Math.min(n - 1, peak + 2);
    let clear = -Infinity;
    for (let i = w0; i <= w1; i++) {
      if (isNum(handS[i]) && isNum(headS[i])) clear = Math.max(clear, (handS[i] - headS[i]) / tLen);
    }
    // Ángulo de codo en el colgado (máximo cerca del valle) y en el pico.
    const k = Math.round(0.17 * fps);
    let bottom = -Infinity;
    for (let i = Math.max(0, valley - k); i <= Math.min(n - 1, valley + k); i++) if (isNum(elbowS[i])) bottom = Math.max(bottom, elbowS[i]);
    let top = Infinity;
    for (let i = w0; i <= w1; i++) if (isNum(elbowS[i])) top = Math.min(top, elbowS[i]);

    reps.push({
      valley, onset, peak, closed,
      tPeak: peak / fps,
      moving: (peak - onset) / fps,
      ascent: (peak - valley) / fps,
      descent: returned > 0 ? (returned - peak) / fps : NaN,
      clearance: isFinite(clear) ? clear : NaN,
      headOverBar: isFinite(clear) && clear > 0,
      bottomElbow: isFinite(bottom) ? bottom : NaN,
      topElbow: isFinite(top) ? top : NaN,
    });
    prevPeak = peak;
  }

  let valid = reps;
  let hangCut = NaN, clearCut = NaN;
  if (mode === "chin") {
    valid = reps.filter((r) => r.headOverBar);
    for (const r of reps) r.grade = r.headOverBar ? "válida" : "sin barbilla sobre barra";
  } else {
    // Rango completo: colgado con brazo extendido + cabeza sobre las manos.
    if (calibration) {
      hangCut = calibration.hang - 12.5;
      clearCut = 0.4 * calibration.clear;
    } else {
      hangCut = Math.max(150, Math.max(...reps.map((r) => r.bottomElbow).filter(isNum)) - 12.5);
      clearCut = 0.18;
    }
    for (const r of reps) {
      r.bottomOk = isNum(r.bottomElbow) && r.bottomElbow >= hangCut;
      r.topOk = isNum(r.clearance) && r.clearance >= clearCut;
      r.full = r.bottomOk && r.topOk;
      r.grade = r.full ? "completa" : "parcial";
    }
  }
  const timed = mode === "chin" ? valid : reps.filter((r) => r.full);
  return {
    mode, reps, count: valid.length,
    fullCount: mode === "pull" ? reps.filter((r) => r.full).length : NaN,
    avgMoving: mean(timed.map((r) => r.moving)),
    avgDescent: mean(timed.map((r) => r.descent)),
    hangCut, clearCut, calibrated: !!calibration,
    s, base, amp, elbow: elbowS, torsoLen: tLen,
    clearanceSeries: handS.map((h, i) => (h - headS[i]) / tLen),
  };
}

/** Perfil de calibración a partir de un clip de repeticiones completas. */
export function calibrationFrom(result) {
  const reps = (result.reps || []).filter((r) => r.closed);
  if (reps.length < 3) return { error: "Se necesitan al menos 3 repeticiones completas para calibrar." };
  const hangs = reps.map((r) => r.bottomElbow).filter(isNum);
  const spread = Math.max(...hangs) - Math.min(...hangs);
  if (spread > 6 * 2) return { error: `Los ángulos de colgado varían ${spread.toFixed(0)}°; graba un set con colgados completos y uniformes.` };
  return { hang: median(hangs), clear: median(reps.map((r) => r.clearance)), reps: reps.length, date: new Date().toISOString() };
}

// ---------- PESO MUERTO (aproximado, solo pose) ----------

export function analyzeDeadlift(frames, { fps, aspect }) {
  const poses = subject(frames);
  const n = poses.length;
  const vis = (side) => mean(poses.map((p) => mean([LM[side + "sh"], LM[side + "hip"], LM[side + "kn"]].map((j) => (p && p[j] ? p[j].v ?? 1 : 0)))));
  const side = vis("l") >= vis("r") ? "l" : "r";
  const J = { sh: LM[side + "sh"], hip: LM[side + "hip"], kn: LM[side + "kn"], an: side === "l" ? LM.lank : LM.rank, ear: side === "l" ? LM.lear : LM.rear, wr: side === "l" ? LM.lwr : LM.rwr };

  const hipAng = [], trunk = [], dev = [], wristX = [], wristY = [], seg = [];
  for (const p of poses) {
    const sh = P(p, J.sh, aspect), hp = P(p, J.hip, aspect), kn = P(p, J.kn, aspect), ear = P(p, J.ear, aspect, 0.2), wr = P(p, J.wr, aspect);
    hipAng.push(angleDeg(sh, hp, kn));
    trunk.push(sh && hp ? (Math.atan2(Math.abs(sh.x - hp.x), hp.y - sh.y) * 180) / Math.PI : NaN);
    // Desviación cabeza-tronco: ángulo entre cadera→hombro y hombro→oreja.
    if (sh && hp && ear) {
      const a1 = Math.atan2(sh.y - hp.y, sh.x - hp.x), a2 = Math.atan2(ear.y - sh.y, ear.x - sh.x);
      dev.push(Math.abs(wrap180(((a2 - a1) * 180) / Math.PI)));
    } else dev.push(NaN);
    wristX.push(wr ? wr.x : NaN); wristY.push(wr ? wr.y : NaN);
    seg.push(dist(hp, kn) + dist(kn, P(p, J.an, aspect)));
  }
  const legLen = median(seg);
  const th = smooth(hipAng, fps, 5, 5, 0.3);
  const devS = smooth(dev, fps, 5, 5, 0.3);
  const trunkS = smooth(trunk, fps, 5, 5, 0.3);
  const base = percentile(th, 10);
  const amp = percentile(th, 98) - base;
  if (!isNum(amp) || amp < 30) {
    return { error: "No se detectó extensión de cadera suficiente (mínimo 30°). Graba de lado con todo el cuerpo visible.", hip: th, reps: [], side };
  }
  const cands = hysteresisReps(th, base + 0.6 * amp, base + 0.3 * amp);
  const reps = [];
  let prev = 0;
  for (let r = 0; r < cands.length; r++) {
    const { peak, closed } = cands[r];
    const valley = argExt(th, prev, peak, (a, b) => a < b);
    const lo = th[valley];
    const hiI = argExt(th, valley, closed && r + 1 < cands.length ? cands[r + 1].peak : Math.min(n - 1, peak + Math.round(fps)), (a, b) => a > b);
    const hi = Math.max(th[peak], th[hiI] ?? -Infinity);
    let onset = valley, lock = peak;
    for (let i = valley; i <= peak; i++) if (th[i] >= lo + 0.1 * (hi - lo)) { onset = i; break; }
    for (let i = onset; i < n; i++) if (th[i] >= lo + 0.98 * (hi - lo)) { lock = i; break; }
    // Referencia erguida: desviación mediana en el bloqueo (±0,2 s).
    const k = Math.round(0.2 * fps);
    const ref = median(devS.slice(Math.max(0, lock - k), Math.min(n, lock + k + 1)));
    const pull = devS.slice(onset, lock + 1);
    const maxDev = Math.max(...pull.filter(isNum));
    const devDelta = maxDev - ref;
    const wx = wristX.slice(onset, lock + 1).filter(isNum);
    const drift = wx.length ? ((Math.max(...wx) - Math.min(...wx)) / legLen) * 100 : NaN;
    reps.push({
      valley, onset, lock, peak, closed,
      tLock: lock / fps,
      pull: (lock - onset) / fps,
      startHip: lo, lockHip: hi,
      startTrunk: trunkS[onset],
      devDelta,
      flag: isNum(devDelta) && devDelta >= 20,
      barDrift: drift,
    });
    prev = peak;
  }
  return {
    side: side === "l" ? "izquierdo" : "derecho",
    reps, count: reps.length,
    avgPull: mean(reps.map((r) => r.pull)),
    flagged: reps.filter((r) => r.flag).length,
    hip: th, dev: devS, trunk: trunkS, base, amp,
  };
}

// ---------- SINCRONÍA DE BAILE ----------

const SEGMENTS = [
  // [nombre, desde, hasta, peso, tolerancia°]
  ["Muslo izq.", LM.lhip, LM.lkn, 1.5, 5],
  ["Muslo der.", LM.rhip, LM.rkn, 1.5, 5],
  ["Pierna izq.", LM.lkn, LM.lank, 1, 10],
  ["Pierna der.", LM.rkn, LM.rank, 1, 10],
  ["Brazo izq.", LM.lsh, LM.lel, 1, 10],
  ["Brazo der.", LM.rsh, LM.rel, 1, 10],
  ["Antebrazo izq.", LM.lel, LM.lwr, 1, 15],
  ["Antebrazo der.", LM.rel, LM.rwr, 1, 15],
  ["Línea de hombros", LM.lsh, LM.rsh, 1.5, 5],
  ["Cuello-cabeza", "midsh", LM.nose, 1.5, 5],
  ["Inclinación del tronco", "lean", null, 2, 5],
];

function segAngles(pose, aspect) {
  const sh = midpt(P(pose, LM.lsh, aspect, 0.2), P(pose, LM.rsh, aspect, 0.2));
  const hp = midpt(P(pose, LM.lhip, aspect, 0.2), P(pose, LM.rhip, aspect, 0.2));
  if (!sh || !hp) return null;
  const ux = sh.x - hp.x, uy = sh.y - hp.y;
  const out = [];
  for (const [, a, b] of SEGMENTS) {
    if (a === "lean") { out.push((Math.atan2(ux, -uy) * 180) / Math.PI); continue; }
    const A = a === "midsh" ? sh : P(pose, a, aspect, 0.2);
    const B = P(pose, b, aspect, 0.2);
    if (!A || !B) { out.push(NaN); continue; }
    const dx = B.x - A.x, dy = B.y - A.y;
    out.push((Math.atan2(ux * dy - uy * dx, ux * dx + uy * dy) * 180) / Math.PI);
  }
  return out;
}

const hipCenter = (pose) => {
  const a = pose[LM.lhip], b = pose[LM.rhip];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

function permutations(k) {
  if (k === 1) return [[0]];
  const out = [];
  for (const p of permutations(k - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), k - 1, ...p.slice(i)]);
  return out;
}

/** Asigna identidades estables por cercanía de la cadera entre cuadros. */
export function trackDancers(frames, nd) {
  const tracks = frames.map(() => new Array(nd).fill(null));
  let last = null;
  const perms = permutations(nd);
  for (let f = 0; f < frames.length; f++) {
    const ps = (frames[f].poses || []).slice(0, nd);
    if (ps.length < nd) continue;
    const c = ps.map(hipCenter);
    if (!last) {
      const order = c.map((p, i) => [p.x, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      order.forEach((pi, ti) => (tracks[f][ti] = ps[pi]));
      last = order.map((pi) => c[pi]);
      continue;
    }
    let best = null, bestCost = Infinity;
    for (const perm of perms) {
      let cost = 0;
      for (let t = 0; t < nd; t++) cost += Math.hypot(c[perm[t]].x - last[t].x, c[perm[t]].y - last[t].y);
      if (cost < bestCost) { bestCost = cost; best = perm; }
    }
    best.forEach((pi, t) => (tracks[f][t] = ps[pi]));
    last = best.map((pi) => c[pi]);
  }
  return tracks;
}

function postureDiff(a, b) {
  let s = 0, w = 0;
  const per = [];
  for (let k = 0; k < SEGMENTS.length; k++) {
    const [, , , wt, tol] = SEGMENTS[k];
    if (!isNum(a[k]) || !isNum(b[k])) { per.push(NaN); continue; }
    const d = Math.max(0, Math.abs(wrap180(a[k] - b[k])) - tol);
    per.push(d); s += wt * d; w += wt;
  }
  return { d: w ? s / w : NaN, per };
}
function speedDiff(a, b) {
  let s = 0, w = 0;
  for (let k = 0; k < SEGMENTS.length; k++) {
    if (!isNum(a[k]) || !isNum(b[k])) continue;
    s += SEGMENTS[k][3] * Math.abs(a[k] - b[k]); w += SEGMENTS[k][3];
  }
  return w ? s / w : NaN;
}

export function analyzeDance(frames, { fps, aspect, dancers = 2 }) {
  const nd = dancers;
  const n = frames.length;
  const tracks = trackDancers(frames, nd);
  // Ángulos por bailarín, suavizados por segmento.
  const ang = [];
  for (let d = 0; d < nd; d++) {
    const raw = tracks.map((tr) => (tr[d] ? segAngles(tr[d], aspect) : null));
    const perSeg = SEGMENTS.map((_, k) => {
      // Desenvolver el ángulo antes de suavizar para no promediar ±180°.
      const series = raw.map((r) => (r ? r[k] : NaN));
      let prev = NaN, off = 0;
      const un = series.map((v) => {
        if (!isNum(v)) return NaN;
        if (isNum(prev)) { const d_ = v + off - prev; if (d_ > 180) off -= 360; else if (d_ < -180) off += 360; }
        prev = v + off; return v + off;
      });
      return movavg(fillGaps(un, Math.round(0.15 * fps)), win(3, fps));
    });
    ang.push(raw.map((r, f) => (r ? SEGMENTS.map((_, k) => perSeg[k][f]) : null)));
  }
  const speed = ang.map((A) => A.map((a, f) => {
    if (!a || f === 0 || !A[f - 1]) return null;
    return a.map((v, k) => Math.abs(v - A[f - 1][k]) * fps);
  }));
  const valid = ang[0].map((_, f) => ang.every((A) => A[f] && A[f].filter(isNum).length >= 8));
  const nValid = valid.filter(Boolean).length;
  if (nValid < 2 * fps) return { error: `Solo ${nValid} cuadros con los ${nd} bailarines completos en cuadro. Asegúrate de que todos se vean de cuerpo entero.` };

  const pairs = [];
  for (let i = 0; i < nd; i++) for (let j = i + 1; j < nd; j++) pairs.push([i, j]);

  // Diferencias reales (postura con desfase de ±2 cuadros).
  const D = pairs.map(() => new Array(n).fill(NaN));
  const T = pairs.map(() => new Array(n).fill(NaN));
  const perSeg = pairs.map(() => new Array(n).fill(null));
  pairs.forEach(([i, j], pi) => {
    for (let f = 0; f < n; f++) {
      if (!valid[f]) continue;
      let best = null;
      for (let dlt = -2; dlt <= 2; dlt++) {
        const g = f + dlt;
        if (g < 0 || g >= n || !valid[g]) continue;
        const pd = postureDiff(ang[i][f], ang[j][g]);
        if (!best || pd.d < best.d) best = pd;
      }
      D[pi][f] = best.d; perSeg[pi][f] = best.per;
      if (speed[i][f] && speed[j][f]) T[pi][f] = speedDiff(speed[i][f], speed[j][f]);
    }
  });

  // Anclas del 0 %: momentos no relacionados (≥ 2 s de distancia).
  const validIdx = valid.map((v, f) => (v ? f : -1)).filter((f) => f >= 0);
  const gap = Math.round(2 * fps);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const zD = [], zT = [];
  for (let k = 0; k < 3000; k++) {
    const f = validIdx[Math.floor(rnd() * validIdx.length)], g = validIdx[Math.floor(rnd() * validIdx.length)];
    if (Math.abs(f - g) < gap) continue;
    const [i, j] = pairs[Math.floor(rnd() * pairs.length)];
    zD.push(postureDiff(ang[i][f], ang[j][g]).d);
    if (speed[i][f] && speed[j][g]) zT.push(speedDiff(speed[i][f], speed[j][g]));
  }
  if (zD.length < 50) return { error: "El clip es demasiado corto para calibrar la escala (se necesitan al menos ~5 s de coreografía)." };
  const zeroD = median(zD), zeroT = median(zT);
  const allD = D.flat(), allT = T.flat();
  const bestD = percentile(allD, 10), bestT = percentile(allT, 10);
  const scoreOf = (d, zero, best) => (isNum(d) ? Math.max(0, Math.min(1, (zero - d) / Math.max(1e-6, zero - best))) : NaN);

  const pairScore = pairs.map((_, pi) => D[pi].map((d, f) => {
    const sp = scoreOf(d, zeroD, bestD), st = scoreOf(T[pi][f], zeroT, bestT);
    return isNum(sp) && isNum(st) ? 0.5 * sp + 0.5 * st : sp;
  }));
  const frameScore = new Array(n).fill(0).map((_, f) => mean(pairScore.map((ps) => ps[f])));
  const smoothScore = movavg(frameScore, win(15, fps));
  const dancerScore = new Array(nd).fill(0).map((_, d) => mean(pairs.flatMap(([i, j], pi) => (i === d || j === d ? pairScore[pi] : []))));
  const postureScore = mean(pairs.flatMap((_, pi) => D[pi].map((d) => scoreOf(d, zeroD, bestD))));
  const timingScore = mean(pairs.flatMap((_, pi) => T[pi].map((t) => scoreOf(t, zeroT, bestT))));

  // Momentos de menor sincronía, separados al menos 2 s.
  const order = smoothScore.map((v, f) => [v, f]).filter((x) => isNum(x[0])).sort((a, b) => a[0] - b[0]);
  const worst = [];
  for (const [v, f] of order) {
    if (worst.every((w) => Math.abs(w.frame - f) >= gap)) {
      const segMeans = SEGMENTS.map((_, k) => mean(pairs.map((__, pi) => (perSeg[pi][f] ? perSeg[pi][f][k] : NaN))));
      const kMax = segMeans.reduce((bi, v_, k) => (isNum(v_) && (bi < 0 || v_ > segMeans[bi]) ? k : bi), -1);
      worst.push({ frame: f, t: f / fps, score: v, segment: kMax >= 0 ? SEGMENTS[kMax][0] : "—" });
    }
    if (worst.length === 3) break;
  }

  return {
    dancers: nd, overall: mean(frameScore), postureScore, timingScore,
    dancerScore, pairs, pairMean: pairScore.map((ps) => mean(ps)),
    frameScore, smoothScore, worst, tracks,
    validFraction: nValid / n,
    anchors: { zeroD, bestD, zeroT, bestT },
  };
}

export const SEGMENT_NAMES = SEGMENTS.map((s) => s[0]);
