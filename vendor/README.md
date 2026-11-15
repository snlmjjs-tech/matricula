# Librerías de terceros (alojadas en el propio sitio)

Se sirven desde el mismo dominio en vez de un CDN: un CDN comprometido no puede inyectar código en la página
y las versiones no cambian sin un cambio visible en el repositorio.

| Archivo | Paquete | Versión | Uso |
|---|---|---|---|
| `firebase-app-compat-9.23.0.js` | `firebase` | 9.23.0 | Conexión con Firebase |
| `firebase-database-compat-9.23.0.js` | `firebase` | 9.23.0 | Base de datos en tiempo real |
| `jspdf-4.2.1.umd.min.js` | `jspdf` | 4.2.1 | Certificado de matrícula en PDF |
| `xlsx-0.18.5.full.min.js` | `xlsx` (SheetJS) | 0.18.5 | Exportación a Excel |
| `qrcode-1.0.0.js` | `qrcodejs` | 1.0.0 | Código QR para apoderados |

`SHA256SUMS`: `sha256sum -c SHA256SUMS`. Para actualizar una librería: `npm pack <paquete>@<versión>`,
copiar el archivo, cambiar el nombre en `index.html`, regenerar `SHA256SUMS` y probar.
