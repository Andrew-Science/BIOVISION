# BioVisión Deportiva — versión instalable

App web instalable (PWA) que analiza video en el teléfono con MediaPipe Pose.
Funciona sin conexión después de la primera apertura y el video nunca sale del dispositivo.

## Instalarla en Android (GitHub Pages, gratis)

1. Crea un repositorio público en GitHub, por ejemplo `biovision`.
2. Sube **el contenido** de esta carpeta (no la carpeta en sí): `index.html`, `app.js`,
   `sw.js`, `manifest.webmanifest`, los íconos y las carpetas `vendor`, `wasm`, `models`.
3. En el repositorio: **Settings → Pages → Branch: main / root → Save**.
4. Abre en Chrome del teléfono `https://TU-USUARIO.github.io/biovision/`.
5. Menú ⋮ → **Instalar app** (o "Agregar a la pantalla principal").

Cualquier hosting con HTTPS sirve igual (Netlify, Vercel, servidor de la universidad).

## Qué analiza

| Módulo | Mide |
|---|---|
| Carrera | Cadencia (spm), tiempo de zancada y de contacto, factor de apoyo, flexión de rodilla al contacto |
| Chin-ups | Repeticiones con barbilla sobre la barra, tiempo de tirón y de descenso |
| Pull-ups | Repeticiones, calificación completa/parcial por ángulo de codo y despeje de cabeza, calibración por atleta |
| Peso muerto | Repeticiones por ángulo de cadera, tiempo de tirón, tronco al inicio, indicador aproximado cabeza-tronco |
| Sincronía de baile | Sincronía 0–100 % entre 2 y 4 personas (postura + tiempo), momentos de menor sincronía |

Exporta resultados en CSV (separado por `;`, abre directo en Excel en español) y los
33 puntos por cuadro en JSON.

## Origen y diferencias

Algoritmos portados de [jeremyipark/vision-demos](https://github.com/jeremyipark/vision-demos)
(Apache-2.0). El original usa ViTPose, SAM 3.1 y Gemma en la nube; aquí todo corre con
MediaPipe Pose en el dispositivo. Por eso el indicador de espalda del peso muerto es una
aproximación y la escalada (que necesita segmentar presas) no está incluida.

## Desarrollo

- `analysis.js` — funciones puras de análisis.
- `test/synthetic.test.mjs` — `node test/synthetic.test.mjs` valida cada análisis con esqueletos sintéticos de valores conocidos.
- `build.py` — arma `dist/` con manifiesto y service worker.
