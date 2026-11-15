/**
 * Envío de certificados de matrícula — Google Apps Script (versión Firebase)
 * ---------------------------------------------------------------------------------------------
 * UN SOLO correo por solicitud, con un certificado PDF independiente por cada estudiante matriculado.
 *
 * Instalación (en la cuenta de Gmail que enviará los correos, p. ej. matriculasincosaf@gmail.com):
 *   1. script.google.com → Nuevo proyecto → pega TODO este archivo en «Código.gs» y guarda.
 *   2. Cambia SECRETO si quieres (debe ser igual a APPS_SCRIPT_SECRETO en js/app.js).
 *   3. Implementar → Nueva implementación → Aplicación web → Ejecutar como: Yo · Quién tiene acceso: Cualquier persona.
 *   4. Copia la URL que termina en /exec a APPS_SCRIPT_URL en js/app.js.
 *   Si ya tenías un script, pega este código encima y usa Implementar → Administrar implementaciones →
 *   editar → Nueva versión (la URL no cambia).
 *
 * Protecciones: clave de envío (SECRETO), formato y tamaño de los PDF, tope de correos por día y por
 * destinatario, y una solicitud ya enviada no se repite (reintentos seguros).
 */

var SECRETO = 'ZZWBOa92quuP2qK3la7vVYhc';
var NOMBRE_REMITENTE = 'Instituto Comercial Alberto Valenzuela Llanos - Matrículas';
var NOMBRE_COLEGIO = 'Instituto Comercial Alberto Valenzuela Llanos de San Fernando';
var CORREO_CONTACTO = 'lissette.maldonado@slepcolchagua.cl';
var TELEFONO_CONTACTO = '72 2847263';
var DIRECCION_COLEGIO = 'Av. Manso de Velasco 389, San Fernando';
var ANIO = '2027';

// ---------- Límites ----------
var MAX_CERTIFICADOS = 5;          // igual que MAX_ESTUDIANTES de la página
var MAX_PDF_BASE64 = 250000;       // por PDF, en caracteres Base64 (un certificado comprimido mide ≈ 120 000)
var MAX_TOTAL_BASE64 = 1000000;    // suma de los PDF de una solicitud (Gmail admite 25 MB por mensaje)
var MAX_SOLICITUD_CHARS = 1200000; // tamaño de toda la petición
var MAX_POR_DESTINATARIO = 5;      // correos por destinatario y día
var LIMITE_DIARIO = 100;           // Gmail gratuito permite ≈100 destinatarios al día
var MAX_ENVIADOS_RECORDADOS = 150;

function doGet() {
  return json_({ ok: true, servicio: 'certificados de matrícula', version: 'firebase-2' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || e.postData.length > MAX_SOLICITUD_CHARS) return json_({ ok: false, error: 'solicitud_invalida' });
    var d = JSON.parse(e.postData.contents);
    if (d.secreto !== SECRETO) return json_({ ok: false, error: 'no_autorizado' });
    if (typeof d.solicitudId !== 'string' || !/^[0-9a-f-]{36}$/.test(d.solicitudId)) return json_({ ok: false, error: 'solicitud_invalida' });
    var dest = typeof d.to === 'string' ? d.to.trim() : '';
    if (dest.length > 120 || !/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(dest)) return json_({ ok: false, error: 'correo_invalido' });

    var v = validarCertificados_(d.certificados);
    if (!v.ok) return json_({ ok: false, error: v.error });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (yaEnviada_(d.solicitudId)) return json_({ ok: true, ya_enviado: true });
      var estado = estadoDelDia_();
      if (estado.total >= LIMITE_DIARIO) return json_({ ok: false, error: 'limite_diario' });
      if ((estado.destinos[hash_(dest)] || 0) >= MAX_POR_DESTINATARIO) return json_({ ok: false, error: 'limite_destinatario' });

      var adjuntos = [], lineas = [], folios = [];
      for (var i = 0; i < d.certificados.length; i++) {
        var c = d.certificados[i];
        var folio = c.folio;
        var archivo = 'Certificado_matricula_Ficha_' + folio + '_' + slug_(c.nombre) + '.pdf';
        adjuntos.push(Utilities.newBlob(Utilities.base64Decode(c.pdfBase64), 'application/pdf', archivo));
        folios.push(folio);
        lineas.push((i + 1) + '. ' + limpiar_(c.nombre, 200) + (c.rut ? ' (RUT ' + limpiar_(c.rut, 20) + ')' : '') + '\n' +
          '   Ficha: ' + folio + ' · ' + (c.tipo === 'antiguo' ? 'Estudiante antiguo' : 'Estudiante nuevo') +
          (c.tipo === 'nuevo' && c.procedencia ? ' · Colegio de procedencia: ' + limpiar_(c.procedencia, 200) : '') +
          (c.curso ? ' · Curso ' + ANIO + ': ' + limpiar_(c.curso, 200) : '') + '\n' +
          '   Certificado adjunto: ' + archivo);
      }
      var varios = folios.length > 1;
      var asunto = 'Confirmación de matrícula ' + ANIO + ' - ' +
        (varios ? 'Fichas ' + listaFolios_(folios) + ' (' + folios.length + ' estudiantes)' : 'Ficha ' + folios[0]);
      var cuerpo =
        'Estimado(a) ' + limpiar_(d.apoderado, 200) + ':\n' +
        'Confirmamos ' + (varios ? 'las matrículas ' + ANIO + ' de ' + folios.length + ' estudiantes' : 'la matrícula ' + ANIO) + ' en ' + NOMBRE_COLEGIO + '.\n\n' +
        lineas.join('\n\n') + '\n\n' +
        'Cada certificado en PDF es independiente: puede abrirlo, imprimirlo y compartirlo por separado.\n\n' +
        'Atentamente,\n' + NOMBRE_COLEGIO + '\n\n--\n' +
        'Este es un correo automático de confirmación de matrícula.\n' +
        'Para consultas escriba a: ' + CORREO_CONTACTO + ' · Teléfono: ' + TELEFONO_CONTACTO + '\n' +
        NOMBRE_COLEGIO + ' · ' + DIRECCION_COLEGIO;
      var opciones = { name: NOMBRE_REMITENTE, attachments: adjuntos, replyTo: CORREO_CONTACTO };

      try {
        GmailApp.sendEmail(dest, asunto, cuerpo, opciones);
      } catch (errMail) {
        console.error(errMail);
        return json_({ ok: false, error: 'envio_fallido' });
      }

      estado.total += 1;
      estado.destinos[hash_(dest)] = (estado.destinos[hash_(dest)] || 0) + 1;
      guardarEstado_(estado);
      recordarEnviada_(d.solicitudId);
      return json_({ ok: true, enviado: true, certificados: folios.length });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'error_interno' });
  }
}

// ---------- Validación de certificados ----------
function validarCertificados_(lista) {
  if (!Array.isArray(lista) || lista.length < 1) return { ok: false, error: 'certificados_invalidos' };
  if (lista.length > MAX_CERTIFICADOS) return { ok: false, error: 'demasiados_certificados' };
  var vistos = {}, total = 0;
  for (var i = 0; i < lista.length; i++) {
    var c = lista[i];
    if (!c || typeof c.folio !== 'string' || !/^[0-9]{1,9}$/.test(c.folio) || vistos[c.folio]) return { ok: false, error: 'certificados_invalidos' };
    vistos[c.folio] = true;
    var b = c.pdfBase64;
    if (typeof b !== 'string' || b.length < 100 || !/^[A-Za-z0-9+\/]+=*$/.test(b) || b.indexOf('JVBER') !== 0) return { ok: false, error: 'pdf_invalido' };  // «JVBER» = «%PDF»
    if (b.length > MAX_PDF_BASE64) return { ok: false, error: 'pdf_demasiado_grande' };
    total += b.length;
    if (total > MAX_TOTAL_BASE64) return { ok: false, error: 'adjuntos_excedidos' };
    var bytes = Utilities.base64Decode(b);
    var cola = '';
    for (var k = Math.max(0, bytes.length - 1024); k < bytes.length; k++) cola += String.fromCharCode(bytes[k] & 255);
    if (cola.indexOf('%%EOF') < 0) return { ok: false, error: 'pdf_invalido' };
  }
  return { ok: true };
}

// ---------- Utilidades ----------
function limpiar_(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/g, '').trim().substring(0, max);
}
function slug_(texto) {
  var t = limpiar_(String(texto || ''), 80);
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  t = t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 30);
  return t || 'Estudiante';
}
function listaFolios_(folios) {
  if (folios.length === 1) return folios[0];
  return folios.slice(0, -1).join(', ') + ' y ' + folios[folios.length - 1];
}
function hoy_() { return Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd'); }
function hash_(texto) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto.toLowerCase())).substring(0, 10);
}
function estadoDelDia_() {
  var crudo = PropertiesService.getScriptProperties().getProperty('ESTADO_ENVIOS');
  var e = crudo ? JSON.parse(crudo) : null;
  if (!e || e.fecha !== hoy_()) e = { fecha: hoy_(), total: 0, destinos: {} };
  return e;
}
function guardarEstado_(e) { PropertiesService.getScriptProperties().setProperty('ESTADO_ENVIOS', JSON.stringify(e)); }
function yaEnviada_(id) {
  var crudo = PropertiesService.getScriptProperties().getProperty('ENVIADOS');
  return !!crudo && JSON.parse(crudo).indexOf(id) >= 0;
}
function recordarEnviada_(id) {
  var crudo = PropertiesService.getScriptProperties().getProperty('ENVIADOS');
  var lista = crudo ? JSON.parse(crudo) : [];
  lista.push(id);
  if (lista.length > MAX_ENVIADOS_RECORDADOS) lista = lista.slice(lista.length - MAX_ENVIADOS_RECORDADOS);
  PropertiesService.getScriptProperties().setProperty('ENVIADOS', JSON.stringify(lista));
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
