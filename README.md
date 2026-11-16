# Matrícula INCOSAF 2027 — versión Firebase

Mismo sistema y mismo diseño que `enrollmentincosaf`, pero los datos se guardan en **Firebase Realtime Database**
(la versión Supabase vive en su propio repositorio y no se toca). Página estática: se publica con GitHub Pages.

## Estructura

```
index.html              pantallas (acceso, formulario, resumen, documentos, panel)
css/styles.css          estilos (diseño, impresión)
js/datos.js             base de datos: Firebase, claves del personal, sesiones, folios, solicitudes, pre-matrículas
js/app.js               lógica: formulario, varios estudiantes, PDF, correo, Excel, QR, panel
js/ui.js                detalle visual
assets/logo.png         logo
nomina2026.json         nómina 2026 (autocompletar estudiantes antiguos)
vendor/                 librerías (Firebase, jsPDF, SheetJS, QR) alojadas en el sitio
apps-script/Code.gs     script de Google que envía el correo (se instala a mano)
tests/prueba-firebase.js  prueba automática de punta a punta (Firebase y Gmail simulados)
```

## Claves (en `js/datos.js`)

| Qué | Dónde | Valor actual |
|---|---|---|
| Funcionarios (registrar matrículas) | `CLAVE_INTERNA` | `matriculas2027` |
| Encargados (panel, Excel, editar, borrar, contador) | `CLAVE_ADMIN` | `incosaf2027` |
| Clave de envío del correo | `APPS_SCRIPT_SECRETO` (`js/app.js`) = `SECRETO` (`apps-script/Code.gs`) | — |

Cámbialas cuando quieras (en la página y, la de envío, también en el script). **Están dentro del código y el repositorio es
público**, así que ordenan el uso pero no son seguridad fuerte: quien lea el código las ve. La versión Supabase sí las valida en el servidor.

## Reglas de Firebase

No hace falta cambiar nada: se usan los mismos lugares de siempre (`matriculas2027`, `prematriculas2027`, `contadorFolio2027`).
Las solicitudes (números de ficha reservados y estado del correo) se guardan dentro de `matriculas2027/_solicitudes`.

## Certificados en PDF y correo

El **envío por correo está apagado** (`ENVIAR_CORREO = false` en `js/app.js`). El certificado de matrícula se descarga en PDF:
en la pantalla final (un botón por estudiante) y en el panel de encargados (botón 📄 de cada fila).

Para volver a activar el correo: publicar `apps-script/Code.gs` como aplicación web en la cuenta de Gmail que enviará los
correos, poner su URL `/exec` en `APPS_SCRIPT_URL` y cambiar `ENVIAR_CORREO` a `true`.

## Antes de matricular de verdad

1. Panel → eliminar las matrículas de prueba.
2. Panel → 🔢 Contador de folio → 1.
3. En Firebase, borrar `prematriculas2027` de pruebas y `matriculas2027/_solicitudes` (se borra solo si eliminas todas las matrículas).
4. Guardar un Excel de respaldo cada día.

## Pruebas

`node tests/prueba-firebase.js` (necesita Playwright): recorre acceso, una y varias matrículas, fallo y reintento del correo,
panel, pre-matrícula y reglas rechazadas. No usa Firebase ni Gmail reales.
