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

Esta versión usa cuatro lugares de la base. Publica estas reglas (Consola Firebase → Realtime Database → Reglas):

```json
{
  "rules": {
    "matriculas2027":    { ".read": true, ".write": true },
    "solicitudes2027":   { ".read": true, ".write": true },
    "prematriculas2027": { ".read": true, ".write": true },
    "contadorFolio2027": { ".read": true, ".write": true }
  }
}
```

`solicitudes2027` es nueva (guarda los números de ficha reservados y el estado del correo). Si falta, la página avisa
«Firebase rechazó la operación…».

## Correo (Google Apps Script)

1. Entra a script.google.com con la cuenta que enviará los correos (`matriculasincosaf@gmail.com`).
2. Pega TODO `apps-script/Code.gs` sobre el script actual y guarda.
3. Implementar → Administrar implementaciones → editar → **Nueva versión** (la URL no cambia).

Envía **un solo correo por solicitud** con un certificado PDF por estudiante. Si el script quedó desactualizado, la página
lo detecta y avisa.

## Antes de matricular de verdad

1. Panel → eliminar las matrículas de prueba.
2. Panel → 🔢 Contador de folio → 1.
3. En Firebase, borrar `prematriculas2027` y `solicitudes2027` de pruebas.
4. Guardar un Excel de respaldo cada día.

## Pruebas

`node tests/prueba-firebase.js` (necesita Playwright): recorre acceso, una y varias matrículas, fallo y reintento del correo,
panel, pre-matrícula y reglas rechazadas. No usa Firebase ni Gmail reales.
