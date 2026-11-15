// Prueba de extremo a extremo de la página con FIREBASE (simulado en memoria) y el script de correo REAL (apps-script/Code.gs)
// ejecutado en un entorno de Google simulado. Datos 100 % ficticios: no se conecta a Firebase ni envía correos.
// Uso: node tests/prueba-firebase.js
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const RAIZ = path.resolve(__dirname, '..');
const CODIGO = fs.readFileSync(path.join(RAIZ, 'apps-script/Code.gs'), 'utf8');
const SECRETO = /APPS_SCRIPT_SECRETO\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(RAIZ, 'js/app.js'), 'utf8'))[1];
const INTERNA = /CLAVE_INTERNA\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(RAIZ, 'js/datos.js'), 'utf8'))[1];
const ADMIN = /CLAVE_ADMIN\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(RAIZ, 'js/datos.js'), 'utf8'))[1];
const DEST = 'apoderado.test@example.invalid';

let P = 0, F = 0;
const ok = (n, c, d) => { if (c) { P++; console.log(`  ✔ ${n}`); } else { F++; console.log(`  ✘ ${n}${d ? '  → ' + d : ''}`); } };
const sec = t => console.log('\n' + t);
const rut = n => { let s = 0, m = 2; for (const d of String(n).split('').reverse()) { s += d * m; m = m === 7 ? 2 : m + 1; } const r = 11 - s % 11; return n + '-' + (r === 11 ? '0' : r === 10 ? 'K' : r); };

/* ---------- Firebase simulado (reemplaza los dos scripts de vendor/firebase-*) ---------- */
const FIREBASE_FALSO = `(function(){
  const raiz = window.__FB = { datos: {}, rechazar: false };
  const partes = r => String(r || '').split('/').filter(Boolean);
  const copia = v => v === undefined ? null : JSON.parse(JSON.stringify(v));
  function leer(r){ let n = raiz.datos; for (const p of partes(r)) { if (n == null || typeof n !== 'object') return null; n = n[p]; } return n === undefined ? null : copia(n); }
  function escribir(r, v){
    if (raiz.rechazar) { const e = new Error('PERMISSION_DENIED'); e.code = 'PERMISSION_DENIED'; throw e; }
    const ps = partes(r); if (!ps.length) { raiz.datos = v || {}; return; }
    let n = raiz.datos; for (const p of ps.slice(0, -1)) { if (n[p] == null || typeof n[p] !== 'object') n[p] = {}; n = n[p]; }
    if (v === null || v === undefined) delete n[ps[ps.length - 1]]; else n[ps[ps.length - 1]] = copia(v);
  }
  const snap = (r, v) => ({ exists: () => v !== null, val: () => copia(v), key: partes(r).pop() });
  const ref = r => ({
    get: async () => snap(r, leer(r)),
    set: async v => escribir(r, v),
    remove: async () => escribir(r, null),
    update: async o => { for (const k of Object.keys(o)) escribir((r ? r + '/' : '') + k, o[k]); },
    transaction: async fn => { const nuevo = fn(leer(r)); escribir(r, nuevo); return { committed: true, snapshot: snap(r, leer(r)) }; },
    push: () => { const k = '-K' + Math.random().toString(36).slice(2, 12); const h = ref((r ? r + '/' : '') + k); h.key = k; return h; }
  });
  window.firebase = { initializeApp(){}, database: () => ({ ref }) };
})();`;

/* ---------- Entorno de Google simulado para ejecutar el Code.gs real ---------- */
function crearGoogle() {
  const props = {}, correos = [];
  const ctx = {
    console, JSON, Math, Date, String, Array, Object, RegExp, parseInt, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      formatDate: (d, tz, f) => d.toISOString().slice(0, 10),
      base64Decode: b => [...Buffer.from(b, 'base64')],
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
      computeDigest: (alg, t) => [...crypto.createHash('sha256').update(String(t)).digest()],
      DigestAlgorithm: { SHA_256: 'sha256' },
      newBlob: (bytes, tipo, nombre) => ({ bytes, tipo, nombre })
    },
    GmailApp: { sendEmail: (to, asunto, cuerpo, op) => { if (ctx.__fallar) throw new Error('Gmail caído'); correos.push({ to, asunto, cuerpo, op }); } },
    ContentService: { createTextOutput: t => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
  };
  vm.createContext(ctx); vm.runInContext(CODIGO, ctx);
  // Script de Google que ya está publicado (formato anterior): un correo con UN adjunto, sin lista de certificados
  const postAntiguo = cuerpo => { const d = JSON.parse(cuerpo); if (d.secreto !== SECRETO || !d.to) return { ok: false, error: 'no autorizado' };
    correos.push({ to: d.to, asunto: d.subject, cuerpo: d.body, op: { attachments: d.pdfBase64 ? [{ tipo: 'application/pdf', nombre: d.pdfName }] : [], replyTo: d.replyTo }, antiguo: true }); return { ok: true }; };
  return { correos, ctx, postAntiguo, antiguo: false, post: cuerpo => JSON.parse(ctx.doPost({ postData: { length: cuerpo.length, contents: cuerpo } }).t) };
}

const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const servir = () => new Promise(res => { const s = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(RAIZ, u === '/' ? 'index.html' : u);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': tipos[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(r); }).listen(0, '127.0.0.1', () => res(s)); });

let navegador, base, google;
const peticiones = [];

async function abrir(url, { dl = false } = {}) {
  const ctx = await navegador.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: dl }); const pg = await ctx.newPage(); pg.errores = [];
  await pg.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective)); });
  pg.on('pageerror', e => pg.errores.push(String(e)));
  await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await pg.route(/vendor\/firebase-app-compat/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FIREBASE_FALSO }));
  await pg.route(/vendor\/firebase-database-compat/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await pg.route('https://script.google.com/**', ruta => {
    const c = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (ruta.request().method() === 'OPTIONS') return ruta.fulfill({ status: 204, headers: c });
    const cuerpo = ruta.request().postData(); peticiones.push(JSON.parse(cuerpo));
    ruta.fulfill({ status: 200, headers: { ...c, 'content-type': 'application/json' }, body: JSON.stringify(google.antiguo ? google.postAntiguo(cuerpo) : google.post(cuerpo)) });
  });
  await pg.goto(base + url); await pg.waitForTimeout(600); return pg;
}
const fb = pg => pg.evaluate(() => { const d = JSON.parse(JSON.stringify(window.__FB.datos)); const m = d.matriculas2027 || {}; d.solicitudes2027 = m._solicitudes || {}; delete m._solicitudes; d.matriculas2027 = m; return d; });
const pant = pg => pg.evaluate(() => document.querySelector('.screen.active')?.id);
const entrar = async (pg, c = INTERNA) => { await pg.fill('#inputClaveInterna', c); await pg.press('#inputClaveInterna', 'Enter'); await pg.waitForTimeout(500); };
const radioPill = (pg, sel) => pg.click('label.radio-pill:has(' + sel + ')');
const idE = (n, c) => '#' + (n === 1 ? 'e_' : `e${n}_`) + c;
const gn = (n, g) => n === 1 ? g : g + n;
async function llenarEst(pg, n, o) {
  const f = (c, v) => pg.fill(idE(n, c), v);
  await radioPill(pg, `input[name=tipo_${n}][value=${o.tipo}]`);
  await f('nombre', o.nombre); await f('rut', o.rut); await pg.press(idE(n, 'rut'), 'Tab'); await f('fnac', '2012-05-10'); await f('dir', 'Calle Ficticia 123 TEST');
  await f('comuna', 'Comuna TEST'); await f('nacionalidad', 'Chilena'); await f('cel', '+56 9 0000 0000');
  if (o.tipo === 'nuevo') { await f('procedencia', 'Colegio TEST'); if (o.curso) await pg.selectOption(idE(n, 'cursoNuevo'), o.curso); }
  else { await pg.selectOption(idE(n, 'cursoAnt'), o.curso || '2° Medio'); await f('letraAnt', o.letra || 'a'); }
  await radioPill(pg, `input[name=${gn(n, 'rep')}][value=no]`);
  await radioPill(pg, `input[name=${gn(n, 'pie')}][value=no]`);
  await radioPill(pg, `input[name=${gn(n, 'salud')}][value=no]`);
  if (n > 1 && o.parentesco) await pg.selectOption(idE(n, 'parentesco'), o.parentesco);
}
async function llenarApoderado(pg, correo = DEST) {
  await pg.fill('#a_nombre', 'Apoderado TEST'); await pg.fill('#a_rut', rut(22222222)); await pg.press('#a_rut', 'Tab'); await pg.fill('#a_edad', '40');
  await pg.fill('#a_dir', 'Calle Ficticia 123 TEST'); await pg.fill('#a_comuna', 'Comuna TEST'); await pg.fill('#a_nacionalidad', 'Chilena'); await pg.fill('#a_cel', '+56 9 0000 0001');
  if (correo) await pg.fill('#a_mail', correo); await pg.selectOption('#a_parentesco', { index: 1 });
}
const enviar = async pg => { await pg.click('#ficha button[type=submit]'); await pg.waitForTimeout(700); };
async function finalizar(pg) { await pg.evaluate(() => { window.print = () => {}; imprimirMemos(); }); await pg.waitForTimeout(400); await pg.click('#btnFinalizar'); await pg.waitForTimeout(1500); }
const rpc = (pg, nombre, args) => pg.evaluate(async ([n, a]) => { try { return { v: await rpc(n, a) }; } catch (e) { return { error: e.message }; } }, [nombre, args]);

const H = [
  { nombre: 'Ana TEST Uno', rut: rut(41000001), tipo: 'antiguo', curso: '1° Medio', letra: 'a' },
  { nombre: 'Beto TEST Dos', rut: rut(41000002), tipo: 'antiguo', curso: '3° Medio', letra: 'b', parentesco: 'Tío(a)' },
  { nombre: 'Carla TEST Tres', rut: rut(41000003), tipo: 'nuevo', curso: '2° Medio' }
];

(async () => {
  const srv = await servir(); base = `http://127.0.0.1:${srv.address().port}`; navegador = await chromium.launch(); google = crearGoogle();
  try {
    sec('1) Acceso del personal');
    let pg = await abrir('/index.html', { dl: true });
    ok('al abrir, pide la clave interna', await pant(pg) === 'scr-acceso');
    await entrar(pg, 'clave-mala');
    ok('una clave incorrecta no entra y avisa', await pant(pg) === 'scr-acceso' && /incorrecta/i.test(await pg.textContent('#accesoError')));
    await entrar(pg);
    ok('la clave interna correcta entra a la pantalla de inicio', await pant(pg) === 'scr-home');
    ok('el panel de encargados NO acepta la clave interna', await (async () => { await pg.click('.admin-link'); await pg.fill('#inputClave', INTERNA); await pg.click('#ovClave .btn-pri'); await pg.waitForTimeout(400); const r = await pant(pg) !== 'scr-admin'; await pg.evaluate(() => { cerrar('ovAviso'); cerrar('ovClave'); }); return r; })());
    ok('sin sesión, las operaciones del panel se rechazan', (await rpc(pg, 'listar_matriculas', { p_clave: null })).error?.includes('sesión'));

    sec('2) Una matrícula: ficha, Firebase y correo');
    await pg.click('.card-btn:nth-child(2)');
    await llenarEst(pg, 1, H[0]); await llenarApoderado(pg); await enviar(pg);
    ok('genera los documentos (pantalla de impresión)', await pant(pg) === 'scr-memos', await pant(pg) + ' ' + (await pg.textContent('#bannerTexto')));
    ok('reservó la ficha 1 en Firebase (contador y solicitud)', (await fb(pg)).contadorFolio2027 === 1 && Object.keys((await fb(pg)).solicitudes2027 || {}).length === 1);
    await finalizar(pg);
    let d = await fb(pg); let mats = Object.values(d.matriculas2027 || {});
    ok('guardó la matrícula en matriculas2027 con ficha "1" y su solicitud', mats.length === 1 && mats[0].folio === '1' && mats[0]._orden === 1 && !!mats[0]._solicitud && mats[0].estudiante.nombre === H[0].nombre);
    ok('la solicitud quedó «guardada» con correo pendiente→enviado', Object.values(d.solicitudes2027)[0].estado === 'guardada' && Object.values(d.solicitudes2027)[0].correo_estado === 'enviado', JSON.stringify(Object.values(d.solicitudes2027)[0]));
    ok('el script envió UN correo con 1 certificado PDF al apoderado', google.correos.length === 1 && google.correos[0].to === DEST && google.correos[0].op.attachments.length === 1 && google.correos[0].op.attachments[0].tipo === 'application/pdf');
    ok('el asunto dice «Ficha 1» y trae Reply-To', /Ficha 1$/.test(google.correos[0].asunto) && !!google.correos[0].op.replyTo);
    ok('la pantalla final dice que se envió', await pant(pg) === 'scr-done' && /Se envió/.test(await pg.textContent('#doneMail')), await pg.textContent('#doneMail'));
    ok('sin errores de página ni violaciones de la política de seguridad', pg.errores.length === 0 && (await pg.evaluate(() => window.__csp)).length === 0, pg.errores.join('|'));

    sec('3) Tres hermanos en una solicitud: resumen, fichas seguidas y UN correo');
    await pg.click('button[data-click=nuevaMatricula]'); await pg.waitForTimeout(300);
    await pg.evaluate(() => iniciarFicha('antiguo')); await pg.waitForTimeout(200);
    await llenarEst(pg, 1, H[0].rut === H[0].rut ? { ...H[0], rut: rut(42000001), nombre: 'Ana DOS Uno' } : H[0]);
    await pg.click('#btnAddEst'); await llenarEst(pg, 2, { ...H[1], rut: rut(42000002) });
    await pg.click('#btnAddEst'); await llenarEst(pg, 3, { ...H[2], rut: rut(42000003) });
    await llenarApoderado(pg); await enviar(pg);
    ok('con varios estudiantes primero muestra el resumen', await pant(pg) === 'scr-resumen', await pant(pg));
    await pg.click('#btnConfirmarResumen'); await pg.waitForTimeout(700);
    d = await fb(pg);
    ok('reservó las fichas 2, 3 y 4 seguidas', d.contadorFolio2027 === 4 && await pant(pg) === 'scr-memos');
    await finalizar(pg);
    d = await fb(pg); mats = Object.values(d.matriculas2027).filter(m => m._orden); const nuevas = mats.filter(m => ['2', '3', '4'].includes(m.folio));
    ok('guardó las 3 matrículas (fichas 2, 3 y 4) con la misma solicitud y orden 1, 2, 3', nuevas.length === 3 && new Set(nuevas.map(m => m._solicitud)).size === 1 && nuevas.map(m => m._orden).sort().join() === '1,2,3');
    ok('el script envió UN solo correo con 3 certificados', google.correos.length === 2 && google.correos[1].op.attachments.length === 3 && /Fichas 2, 3 y 4/.test(google.correos[1].asunto), google.correos[1] && google.correos[1].asunto);
    ok('el correo menciona a los tres estudiantes', ['Ana DOS Uno', 'Beto TEST Dos', 'Carla TEST Tres'].every(n => google.correos[1].cuerpo.includes(n)));
    ok('la pantalla final dice que se envió UN correo con los 3 certificados', /UN correo con los 3/.test(await pg.textContent('#doneMail')), await pg.textContent('#doneMail'));

    sec('4) Falla del correo: las matrículas quedan guardadas y se puede reintentar sin duplicar');
    google.ctx.__fallar = true;
    await pg.click('button[data-click=nuevaMatricula]'); await pg.evaluate(() => iniciarFicha('nuevo')); await pg.waitForTimeout(200);
    await llenarEst(pg, 1, { ...H[2], rut: rut(43000001), nombre: 'Dora TEST Cuatro' }); await llenarApoderado(pg); await enviar(pg); await finalizar(pg);
    d = await fb(pg); const dora = Object.values(d.matriculas2027).find(m => m.estudiante.nombre === 'Dora TEST Cuatro');
    ok('la matrícula quedó guardada (ficha 5)', !!dora && dora.folio === '5');
    ok('avisa que el correo NO se envió y ofrece reintentar', /NO se envió/.test(await pg.textContent('#doneMail')) && await pg.isVisible('#btnReintentarCorreo'), await pg.textContent('#doneMail'));
    ok('el estado del correo en Firebase es «error»', d.solicitudes2027[dora._solicitud].correo_estado === 'error');
    google.ctx.__fallar = false;
    await pg.click('#btnReintentarCorreo'); await pg.waitForTimeout(1200);
    d = await fb(pg);
    ok('el reintento envía el correo y NO duplica la matrícula', google.correos.length === 3 && Object.values(d.matriculas2027).filter(m => m.estudiante.nombre === 'Dora TEST Cuatro').length === 1 && d.contadorFolio2027 === 5);
    ok('el estado pasa a «enviado»', d.solicitudes2027[dora._solicitud].correo_estado === 'enviado');
    await pg.click('#btnReintentarCorreo').catch(() => {});

    sec('4b) Con el script de Google que ya está publicado (sin actualizarlo)');
    google.antiguo = true; const antesA = google.correos.length;
    await pg.click('button[data-click=nuevaMatricula]'); await pg.evaluate(() => iniciarFicha('antiguo')); await pg.waitForTimeout(200);
    await llenarEst(pg, 1, { ...H[0], rut: rut(45000001), nombre: 'Fran TEST Seis' }); await pg.click('#btnAddEst'); await llenarEst(pg, 2, { ...H[1], rut: rut(45000002), nombre: 'Gael TEST Siete' });
    await llenarApoderado(pg); await enviar(pg); await pg.click('#btnConfirmarResumen'); await pg.waitForTimeout(700); await finalizar(pg);
    const nuevosA = google.correos.slice(antesA);
    ok('envía un correo por estudiante, cada uno con su certificado PDF', nuevosA.length === 2 && nuevosA.every(c => c.op.attachments.length === 1 && c.to === DEST) && /Ficha 6/.test(nuevosA[0].asunto) && /Ficha 7/.test(nuevosA[1].asunto), JSON.stringify(nuevosA.map(c => c.asunto)));
    ok('la pantalla final informa los 2 correos', /Se enviaron 2 correos/.test(await pg.textContent('#doneMail')), await pg.textContent('#doneMail'));
    google.antiguo = false;

    sec('5) Seguridad del script de correo');
    const base64 = Buffer.from('%PDF-1.4\n' + 'x'.repeat(200) + '\n%%EOF').toString('base64');
    const buena = { secreto: SECRETO, solicitudId: crypto.randomUUID(), to: DEST, apoderado: 'A', certificados: [{ folio: '9', nombre: 'N', rut: '1-9', tipo: 'nuevo', pdfBase64: base64 }] };
    const antes = google.correos.length;
    ok('clave de envío incorrecta → no envía', google.post(JSON.stringify({ ...buena, secreto: 'mala' })).error === 'no_autorizado');
    ok('correo inválido → no envía', google.post(JSON.stringify({ ...buena, to: 'no-es-correo' })).error === 'correo_invalido');
    ok('PDF falso → no envía', google.post(JSON.stringify({ ...buena, certificados: [{ ...buena.certificados[0], pdfBase64: Buffer.from('hola'.repeat(60)).toString('base64') }] })).error === 'pdf_invalido');
    ok('más de 5 certificados → no envía', google.post(JSON.stringify({ ...buena, certificados: Array.from({ length: 6 }, (_, i) => ({ ...buena.certificados[0], folio: String(i + 1) })) })).error === 'demasiados_certificados');
    ok('folios repetidos → no envía', google.post(JSON.stringify({ ...buena, certificados: [buena.certificados[0], buena.certificados[0]] })).error === 'certificados_invalidos');
    ok('ninguno de esos intentos envió correos', google.correos.length === antes);
    ok('un envío válido sale, y repetirlo (misma solicitud) no duplica', google.post(JSON.stringify(buena)).ok === true && google.post(JSON.stringify(buena)).ya_enviado === true && google.correos.length === antes + 1);

    sec('6) Panel de encargados');
    await pg.evaluate(() => { cerrarAcceso(); }); await entrar(pg);
    await pg.click('.admin-link'); await pg.fill('#inputClave', ADMIN); await pg.click('#ovClave .btn-pri'); await pg.waitForTimeout(800);
    ok('la clave de encargados abre el panel', await pant(pg) === 'scr-admin');
    ok('lista las 7 matrículas ordenadas por ficha', (await pg.$$eval('#tbodyAdmin tr', t => t.map(r => r.cells[0].textContent))).join() === '1,2,3,4,5,6,7', (await pg.$$eval('#tbodyAdmin tr', t => t.map(r => r.cells[0].textContent))).join());
    ok('muestra la solicitud (n/total) y el estado del correo', /2\/3/.test(await pg.textContent('#tbodyAdmin')) && /Enviado/.test(await pg.textContent('#tbodyAdmin')));
    const tok = await pg.evaluate(() => tokenAdmin);
    const claves = (await rpc(pg, 'listar_matriculas', { p_clave: tok })).v.map(m => m._key);
    ok('cambiar el N° de ficha a uno en uso se rechaza', /ya lo tiene otra ficha/.test((await rpc(pg, 'cambiar_folio_matricula', { p_clave: tok, p_id: claves[0], p_folio: 3 })).error || ''));
    ok('cambiar el N° de ficha a uno libre funciona', (await rpc(pg, 'cambiar_folio_matricula', { p_clave: tok, p_id: claves[0], p_folio: 40 })).error === undefined && (await fb(pg)).matriculas2027[claves[0]].folio === '40');
    ok('el contador no puede quedar por debajo de las fichas existentes', /ya existen fichas/.test((await rpc(pg, 'establecer_siguiente_folio', { p_clave: tok, p_valor: 6 })).error || ''));
    ok('el contador se puede subir', (await rpc(pg, 'establecer_siguiente_folio', { p_clave: tok, p_valor: 50 })).error === undefined && (await rpc(pg, 'ver_siguiente_folio', { p_clave: tok })).v === 50 && (await fb(pg)).contadorFolio2027 === 49);
    await rpc(pg, 'eliminar_matricula', { p_clave: tok, p_id: claves[0] });
    d = await fb(pg);
    ok('eliminar la única matrícula de una solicitud retira también la solicitud', Object.keys(d.matriculas2027).length === 6 && Object.keys(d.solicitudes2027).length === 3);
    const hermano = Object.entries(d.matriculas2027).find(([, m]) => m.folio === '3')[0];
    await rpc(pg, 'eliminar_matricula', { p_clave: tok, p_id: hermano });
    d = await fb(pg);
    ok('eliminar un hermano no toca a los otros dos ni a la solicitud', Object.values(d.matriculas2027).filter(m => ['2', '4'].includes(m.folio)).length === 2 && Object.keys(d.solicitudes2027).length === 3);
    const edit = (await rpc(pg, 'listar_matriculas', { p_clave: tok })).v.find(m => m.estudiante.nombre === 'Dora TEST Cuatro');
    const { _key, _solicitud, _orden, _hermanos, _correo, ...ficha } = edit;
    ok('editar una matrícula conserva su solicitud', (await rpc(pg, 'actualizar_matricula', { p_clave: tok, p_id: _key, p_ficha: { ...ficha, estudiante: { ...ficha.estudiante, comuna: 'Comuna EDITADA' } } })).error === undefined && (await fb(pg)).matriculas2027[_key].estudiante.comuna === 'Comuna EDITADA' && (await fb(pg)).matriculas2027[_key]._solicitud === _solicitud);
    const descarga = pg.waitForEvent('download'); await pg.evaluate(() => { aplicarFiltrosAdmin(); }); await pg.click('#btnDescargarExcel'); const dlx = await descarga;
    ok('descarga el Excel', /Matriculas_INCOSAF_2027\.xlsx/.test(dlx.suggestedFilename()));

    sec('7) Pre-matrícula por QR (apoderado, sin clave)');
    const pa = await abrir('/index.html?apoderado');
    ok('el apoderado entra directo, sin pedir clave', await pant(pa) === 'scr-home');
    await pa.evaluate(() => iniciarFicha('nuevo')); await llenarEst(pa, 1, { ...H[2], rut: rut(44000001), nombre: 'Eva TEST Cinco' }); await llenarApoderado(pa); await enviar(pa);
    ok('muestra un código de 6 caracteres', await pant(pa) === 'scr-codigo' && /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(await pa.textContent('#codigoGrande')), await pant(pa));
    const codigo = (await pa.textContent('#codigoGrande')).replace('-', '');
    d = await fb(pa);
    ok('quedó guardada en prematriculas2027', !!d.prematriculas2027[codigo] && d.prematriculas2027[codigo].datos.estudiante.nombre === 'Eva TEST Cinco');
    ok('el apoderado NO puede leer matrículas ni cargar códigos', (await rpc(pa, 'listar_matriculas', {})).error?.includes('sesión') && (await rpc(pa, 'cargar_prematricula', { p_codigo: codigo })).error?.includes('sesión'));
    await pa.context().close();
    // el personal carga el código (en la misma base simulada: se copia el árbol)
    await pg.evaluate(d => { window.__FB.datos.prematriculas2027 = d; }, d.prematriculas2027);
    await pg.evaluate(() => volverInicio()); await pg.click('button[data-click=abrirCargarCodigo]'); await pg.fill('#inputCodigo', codigo.slice(0, 3) + '-' + codigo.slice(3)); await pg.click('#btnBuscarCodigo'); await pg.waitForTimeout(700);
    ok('el personal carga los datos con el código', await pant(pg) === 'scr-form' && (await pg.inputValue('#e_nombre')) === 'Eva TEST Cinco');
    ok('un código que no existe avisa', (await rpc(pg, 'cargar_prematricula', { p_clave: await pg.evaluate(() => tokenInterno), p_codigo: 'ZZZZZZ' })).v === null);
    ok('el campo trampa de robots rechaza el envío', /no se pudo procesar/.test((await rpc(pg, 'crear_prematricula', { p_datos: { _hp: 'x', estudiante: { nombre: 'a', rut: '1-9' }, apoderado: {} } })).error || ''));

    sec('8) Si Firebase rechaza las reglas, el mensaje es claro');
    await pg.evaluate(() => { window.__FB.rechazar = true; });
    const rech = await rpc(pg, 'eliminar_prematricula', { p_clave: await pg.evaluate(() => tokenInterno), p_codigo: 'ABC123' });
    ok('mensaje que indica revisar las reglas de Firebase', /reglas de la base de datos/.test(rech.error || ''), rech.error);

    sec('9) Sin errores de consola en toda la prueba');
    ok('sin errores de JavaScript ni violaciones de la política de seguridad', pg.errores.length === 0 && (await pg.evaluate(() => window.__csp)).length === 0, pg.errores.join('|'));
  } finally { await navegador.close(); srv.close(); }
  console.log(`\n${P} correctas, ${F} con fallo`); process.exit(F ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
