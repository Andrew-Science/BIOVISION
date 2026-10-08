"""Arma dist/: la versión instalable (PWA) para alojar en GitHub Pages o cualquier HTTPS.

index.html es el contenido de la página (así lo publica claude.ai); aquí se
envuelve con doctype, <head>, manifiesto y service worker.
"""
import json, shutil, pathlib

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"
VERSION = "1.0.0"

page = (ROOT / "index.html").read_text(encoding="utf-8")
head = """<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#c2421c">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
"""
html = head + page + "\n</body>\n</html>\n"

if DIST.exists():
    shutil.rmtree(DIST)
DIST.mkdir()
(DIST / "index.html").write_text(html, encoding="utf-8")
(ROOT / "standalone.html").write_text(html, encoding="utf-8")  # para pruebas locales
for f in ["app.js", "analysis.js", "icon.svg", "icon-192.png", "icon-512.png"]:
    shutil.copy(ROOT / f, DIST / f)
for d in ["vendor", "wasm", "models"]:
    shutil.copytree(ROOT / d, DIST / d)

(DIST / "manifest.webmanifest").write_text(json.dumps({
    "name": "BioVisión Deportiva",
    "short_name": "BioVisión",
    "description": "Análisis biomecánico de video en el teléfono: carrera, dominadas, peso muerto y sincronía de baile.",
    "lang": "es",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": "#f2f4f1",
    "theme_color": "#c2421c",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}, ensure_ascii=False, indent=2), encoding="utf-8")

assets = ["./", "index.html", "app.js", "analysis.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
          "vendor/vision_bundle.mjs"] + [f"{d}/{p.name}" for d in ["wasm", "models"] for p in sorted((ROOT / d).iterdir())]
(DIST / "sw.js").write_text(f"""// Cache sin conexión: tras la primera apertura, la app funciona sin internet.
const CACHE = "biovision-{VERSION}";
const ASSETS = {json.dumps(assets)};
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {{
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, {{ ignoreSearch: true }}).then((hit) => hit || fetch(e.request).then((res) => {{
    if (res.ok && new URL(e.request.url).origin === location.origin) {{ const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }}
    return res;
  }})));
}});
""", encoding="utf-8")
print("dist/ listo:", sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file()) // 1024, "KB")
