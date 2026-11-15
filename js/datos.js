/* ==========================================================
   Capa de datos — FIREBASE (Realtime Database)
   ----------------------------------------------------------
   Esta página funciona igual que la versión con Supabase, pero guarda los datos en Firebase.
   app.js llama a estas operaciones por su nombre (rpc("guardar_solicitud", …)); aquí se implementan
   contra Firebase. Los datos se guardan en:
     matriculas2027/<id>      una matrícula (la ficha + _solicitud y _orden si vino de una solicitud)
     solicitudes2027/<id>     folios reservados de una solicitud, estado y estado del correo
     prematriculas2027/<cod>  pre-matrículas de apoderados (código → datos)
     contadorFolio2027        último N° de ficha entregado
   ⚠️ Las claves de abajo viajan en este archivo (la página es estática): sirven para ordenar el uso
      del personal, no son seguridad fuerte. Ver README.md.
   ========================================================== */
const CLAVE_ADMIN = "incosaf2027";        // 🔑 panel de encargados (ver, editar, borrar, Excel, contador)
const CLAVE_INTERNA = "matriculas2027";   // 🔑 funcionarios que registran matrículas (cámbiala por la que quieras)

const firebaseConfig = {
  apiKey: "AIzaSyC3BboH372-0w_61AeF6pDaCEH_QRHPcao",
  authDomain: "matricula-incosaf-2027.firebaseapp.com",
  databaseURL: "https://matricula-incosaf-2027-default-rtdb.firebaseio.com",
  projectId: "matricula-incosaf-2027",
  storageBucket: "matricula-incosaf-2027.firebasestorage.app",
  messagingSenderId: "788236687215",
  appId: "1:788236687215:web:18336c9efffb417164fa9a"
};

let db = null;
try {
  if (typeof firebase !== "undefined" && !firebaseConfig.apiKey.includes("PEGA_AQUI")) {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
  }
} catch (e) { console.error("Firebase:", e); }

const DATOS = (() => {
  const MAX_ESTUDIANTES = 5;
  const DURACION = { admin: 3 * 3600e3, interna: 12 * 3600e3 };   // vigencia de la sesión (ms)
  const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";            // sin 0, 1, I ni O

  const limpiarRut = r => String(r || "").replace(/[^0-9kK]/g, "").toUpperCase();
  const fallo = (codigo, texto) => new Error(texto ? `${codigo}: ${texto}` : codigo);
  const aleatorio = n => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b]; };

  /* ---------- Sesiones (se guardan solo en esta pestaña) ---------- */
  let fallos = 0, bloqueoHasta = 0;
  function sesion(token){
    const m = /^(admin|interna)\.(\d+)\.[0-9a-f]{16}$/.exec(String(token || ""));
    if (!m || Date.now() > Number(m[2])) return null;
    return m[1];
  }
  function exigir(token, nivel){
    const rol = sesion(token);
    if (!rol || (nivel === "admin" && rol !== "admin")) throw fallo("clave_incorrecta");
    return rol;
  }
  function iniciarSesion({ p_clave, p_rol }){
    if (Date.now() < bloqueoHasta) return { ok: false, motivo: "bloqueado", espera_minutos: Math.ceil((bloqueoHasta - Date.now()) / 60000) };
    const rol = p_rol === "admin" ? "admin" : "interna";
    const buena = rol === "admin" ? p_clave === CLAVE_ADMIN : (p_clave === CLAVE_INTERNA || p_clave === CLAVE_ADMIN);
    if (!buena){
      if (++fallos >= 8){ bloqueoHasta = Date.now() + 15 * 60000; fallos = 0; return { ok: false, motivo: "bloqueado", espera_minutos: 15 }; }
      return { ok: false, motivo: "clave" };
    }
    fallos = 0;
    const azar = aleatorio(8).map(x => x.toString(16).padStart(2, "0")).join("");
    return { ok: true, token: `${rol}.${Date.now() + DURACION[rol]}.${azar}` };
  }

  /* ---------- Firebase: lectura y escritura ---------- */
  function exigirDb(){
    if (!db) throw new Error("No hay conexión con la base de datos (Firebase no está configurado).");
    return db;
  }
  async function leer(ruta){ const s = await exigirDb().ref(ruta).get(); return s.exists() ? s.val() : null; }
  async function todasLasMatriculas(){
    const v = (await leer("matriculas2027")) || {};
    return Object.entries(v).map(([id, ficha]) => ({ id, ...ficha }));
  }
  const folioNum = x => parseInt(x.folio, 10);

  /* ---------- Validación mínima del lado del dato (el formulario ya validó todo lo demás) ---------- */
  function exigirFicha(f, etiqueta){
    if (!f || typeof f !== "object" || !f.estudiante || !f.apoderado) throw fallo("dato_invalido", `${etiqueta}la ficha no tiene el formato correcto`);
    if (!limpiarRut(f.estudiante.rut) || !String(f.estudiante.nombre || "").trim()) throw fallo("dato_invalido", `${etiqueta}faltan el nombre o el RUT del estudiante`);
    if (JSON.stringify(f).length > 150000) throw fallo("dato_invalido", `${etiqueta}la ficha es demasiado grande`);
  }
  const sinInternos = f => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("_")));

  /* ---------- Operaciones (mismos nombres y resultados que en la versión Supabase) ---------- */
  const operaciones = {
    iniciar_sesion: async a => iniciarSesion(a),
    cerrar_sesion: async () => null,
    validar_token: async ({ p_token }) => sesion(p_token),

    // Entrega N números de ficha seguidos. Con el mismo id de solicitud devuelve los mismos (reintentos).
    async reservar_folios({ p_clave, p_solicitud, p_cantidad }){
      exigir(p_clave, "interna");
      if (!p_solicitud) throw fallo("solicitud_invalida", "falta el identificador de la solicitud");
      if (!Number.isInteger(p_cantidad) || p_cantidad < 1 || p_cantidad > MAX_ESTUDIANTES){
        throw fallo("dato_invalido", `se pueden matricular entre 1 y ${MAX_ESTUDIANTES} estudiantes por solicitud`);
      }
      const ref = exigirDb().ref("solicitudes2027/" + p_solicitud);
      const previa = await ref.get();
      if (previa.exists()){
        const s = previa.val();
        if (s.cantidad !== p_cantidad) throw fallo("solicitud_invalida", `la solicitud ya reservó ${s.cantidad} ficha(s); empieza una solicitud nueva`);
        return { folios: s.folios, estado: s.estado, repetida: true };
      }
      const res = await db.ref("contadorFolio2027").transaction(actual => (actual || 0) + p_cantidad);
      if (!res.committed) throw new Error("No se pudo reservar el número de ficha.");
      const ultimo = res.snapshot.val();
      const folios = Array.from({ length: p_cantidad }, (_, i) => ultimo - p_cantidad + 1 + i);
      await ref.set({ cantidad: p_cantidad, folios, estado: "reservada", creada: Date.now() });
      return { folios, estado: "reservada", repetida: false };
    },

    // Guarda todas las matrículas de la solicitud en UNA escritura (todas o ninguna). Con el mismo id no duplica.
    async guardar_solicitud({ p_clave, p_solicitud, p_fichas }){
      exigir(p_clave, "interna");
      if (!p_solicitud) throw fallo("solicitud_invalida", "falta el identificador de la solicitud");
      if (!Array.isArray(p_fichas) || p_fichas.length < 1 || p_fichas.length > MAX_ESTUDIANTES){
        throw fallo("dato_invalido", `se pueden matricular entre 1 y ${MAX_ESTUDIANTES} estudiantes por solicitud`);
      }
      const sol = await leer("solicitudes2027/" + p_solicitud);
      if (!sol) throw fallo("solicitud_invalida", "la solicitud no existe; vuelve a generar los documentos");
      if (sol.cantidad !== p_fichas.length) throw fallo("solicitud_invalida", "la cantidad de estudiantes no coincide con la reservada");
      const existentes = await todasLasMatriculas();
      const propias = existentes.filter(m => m._solicitud === p_solicitud).sort((a, b) => a._orden - b._orden);

      // Reintento: ya estaba guardada → se devuelve lo guardado
      if (sol.estado === "guardada" && propias.length){
        p_fichas.forEach((f, i) => {
          if (!propias[i] || limpiarRut(propias[i].estudiante.rut) !== limpiarRut(f.estudiante && f.estudiante.rut)){
            throw fallo("solicitud_invalida", "esta solicitud ya fue registrada con otros datos");
          }
        });
        return { ok: true, repetida: true, correo_estado: sol.correo_estado || null, advertencias: [],
                 matriculas: propias.map(m => ({ orden: m._orden, id: m.id, folio: folioNum(m) })) };
      }

      const ruts = [], rutApoderado = limpiarRut(p_fichas[0].apoderado && p_fichas[0].apoderado.rut);
      p_fichas.forEach((f, i) => {
        const et = `Estudiante ${i + 1}: `;
        exigirFicha(f, et);
        if (Number(f.folio) !== sol.folios[i]) throw fallo("folio_invalido", `${et}el N° de ficha no corresponde a esta solicitud`);
        const r = limpiarRut(f.estudiante.rut);
        if (ruts.includes(r)) throw fallo("dato_invalido", `${et}el RUT está repetido en la solicitud`);
        ruts.push(r);
        if (limpiarRut(f.apoderado.rut) !== rutApoderado) throw fallo("dato_invalido", `${et}el apoderado debe ser el mismo en toda la solicitud`);
        if (existentes.some(m => folioNum(m) === Number(f.folio) && m._solicitud !== p_solicitud)){
          throw fallo("folio_en_uso", `${et}el N° de ficha ${f.folio} ya está en uso`);
        }
      });

      const correo = String(p_fichas[0].apoderado.correo || "").trim();
      const correoEstado = correo ? "pendiente" : "sin_correo";
      const cambios = {}, ids = [], advertencias = [];
      p_fichas.forEach((f, i) => {
        const id = db.ref("matriculas2027").push().key;
        cambios[`matriculas2027/${id}`] = { ...sinInternos(f), folio: String(f.folio), _solicitud: p_solicitud, _orden: i + 1 };
        ids.push({ orden: i + 1, id, folio: Number(f.folio) });
        const otra = existentes.filter(m => m._solicitud !== p_solicitud && limpiarRut(m.estudiante && m.estudiante.rut) === limpiarRut(f.estudiante.rut))
                               .sort((a, b) => folioNum(a) - folioNum(b))[0];
        if (otra) advertencias.push({ orden: i + 1, folio_existente: folioNum(otra) });
      });
      cambios[`solicitudes2027/${p_solicitud}/estado`] = "guardada";
      cambios[`solicitudes2027/${p_solicitud}/correo_estado`] = correoEstado;
      await db.ref().update(cambios);
      return { ok: true, repetida: false, matriculas: ids, correo_estado: correoEstado, advertencias };
    },

    // Anota cómo terminó el envío del correo de una solicitud (pendiente / enviado / error)
    async registrar_correo({ p_clave, p_solicitud, p_estado }){
      exigir(p_clave, "interna");
      if (!["pendiente", "enviado", "error", "sin_correo"].includes(p_estado)) return null;
      if (!(await leer("solicitudes2027/" + p_solicitud))) return null;
      await db.ref(`solicitudes2027/${p_solicitud}/correo_estado`).set(p_estado);
      return p_estado;
    },

    async listar_matriculas({ p_clave }){
      exigir(p_clave, "admin");
      const [mats, sols] = await Promise.all([todasLasMatriculas(), leer("solicitudes2027")]);
      const cuenta = {};
      mats.forEach(m => { if (m._solicitud) cuenta[m._solicitud] = (cuenta[m._solicitud] || 0) + 1; });
      return mats.map(({ id, ...ficha }) => ({
        ...ficha,
        _key: id,
        _solicitud: ficha._solicitud || null,
        _orden: ficha._orden || null,
        _hermanos: ficha._solicitud ? cuenta[ficha._solicitud] : 1,
        _correo: ficha._solicitud && sols && sols[ficha._solicitud] ? (sols[ficha._solicitud].correo_estado || null) : null
      })).sort((a, b) => folioNum(a) - folioNum(b));
    },

    async actualizar_matricula({ p_clave, p_id, p_ficha }){
      exigir(p_clave, "admin");
      exigirFicha(p_ficha, "");
      const ref = exigirDb().ref("matriculas2027/" + p_id);
      const actual = await ref.get();
      if (!actual.exists()) throw new Error("matricula_no_encontrada");
      const v = actual.val();
      const extra = {};
      if (v._solicitud) { extra._solicitud = v._solicitud; extra._orden = v._orden; }
      await ref.set({ ...sinInternos(p_ficha), ...extra });
      return null;
    },

    // Eliminar una matrícula no toca a sus hermanos; si la solicitud queda vacía, se retira también
    async eliminar_matricula({ p_clave, p_id }){
      exigir(p_clave, "admin");
      const v = await leer("matriculas2027/" + p_id);
      await exigirDb().ref("matriculas2027/" + p_id).remove();
      if (v && v._solicitud){
        const quedan = (await todasLasMatriculas()).some(m => m._solicitud === v._solicitud);
        if (!quedan) await db.ref("solicitudes2027/" + v._solicitud).remove();
      }
      return null;
    },

    async ver_siguiente_folio({ p_clave }){
      exigir(p_clave, "admin");
      return ((await leer("contadorFolio2027")) || 0) + 1;
    },
    async establecer_siguiente_folio({ p_clave, p_valor }){
      exigir(p_clave, "admin");
      if (!Number.isInteger(p_valor) || p_valor < 1) throw fallo("folio_invalido", "el número debe ser 1 o mayor");
      const mats = await todasLasMatriculas();
      const minimo = mats.reduce((m, x) => Math.max(m, folioNum(x) || 0), 0) + 1;
      if (p_valor < minimo) throw fallo("folio_en_uso", `ya existen fichas hasta el N° ${minimo - 1}, el mínimo permitido es ${minimo}`);
      await db.ref("contadorFolio2027").set(p_valor - 1);
      return p_valor;
    },
    async cambiar_folio_matricula({ p_clave, p_id, p_folio }){
      exigir(p_clave, "admin");
      if (!Number.isInteger(p_folio) || p_folio < 1) throw fallo("folio_invalido", "el número debe ser 1 o mayor");
      const mats = await todasLasMatriculas();
      if (mats.some(m => folioNum(m) === p_folio && m.id !== p_id)) throw fallo("folio_duplicado", `el N° ${p_folio} ya lo tiene otra ficha`);
      if (!mats.some(m => m.id === p_id)) throw new Error("matricula_no_encontrada");
      await exigirDb().ref("matriculas2027/" + p_id + "/folio").set(String(p_folio));
      return null;
    },

    /* ---------- Pre-matrículas (apoderados, sin clave) ---------- */
    async crear_prematricula({ p_datos }){
      if (!p_datos || typeof p_datos !== "object") throw fallo("dato_invalido", "la solicitud no tiene el formato correcto");
      // campo trampa para robots: una persona no lo ve ni lo llena
      if (p_datos._hp) throw fallo("solicitud_invalida", "no se pudo procesar la solicitud");
      const { _hp, ...datos } = p_datos;
      const lista = Array.isArray(datos.estudiantes) ? datos.estudiantes : [datos];
      if (!lista.length || lista.length > MAX_ESTUDIANTES) throw fallo("dato_invalido", `se pueden matricular entre 1 y ${MAX_ESTUDIANTES} estudiantes por solicitud`);
      if (JSON.stringify(datos).length > 150000) throw fallo("dato_invalido", "la solicitud es demasiado grande");
      // freno básico por navegador (8 por hora): evita envíos repetidos por error
      let marcas = [];
      try { marcas = JSON.parse(localStorage.getItem("prematriculas_envios") || "[]").filter(t => Date.now() - t < 3600e3); } catch (e) {}
      if (marcas.length >= 8) throw fallo("demasiadas_solicitudes", "Se enviaron demasiadas pre-matrículas desde este equipo. Espera una hora o acércate al mesón de matrícula.");
      let codigo = null;
      for (let i = 0; i < 25 && !codigo; i++){
        const cand = aleatorio(6).map(x => ALFABETO[x % 32]).join("");
        if (!(await exigirDb().ref("prematriculas2027/" + cand).get()).exists()) codigo = cand;
      }
      if (!codigo) throw new Error("sin_codigos_disponibles");
      await db.ref("prematriculas2027/" + codigo).set({ codigo, creada: new Date().toLocaleString("es-CL"), creadaMs: Date.now(), datos });
      try { marcas.push(Date.now()); localStorage.setItem("prematriculas_envios", JSON.stringify(marcas)); } catch (e) {}
      return codigo;
    },
    async cargar_prematricula({ p_clave, p_codigo }){
      exigir(p_clave, "interna");
      const codigo = String(p_codigo || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
      if (!codigo) return null;
      const v = await leer("prematriculas2027/" + codigo);
      return v ? v.datos : null;
    },
    async eliminar_prematricula({ p_clave, p_codigo }){
      exigir(p_clave, "interna");
      const codigo = String(p_codigo || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
      if (codigo) await exigirDb().ref("prematriculas2027/" + codigo).remove();
      return null;
    }
  };

  async function llamar(nombre, args){
    const f = operaciones[nombre];
    if (!f) throw new Error("Operación desconocida: " + nombre);
    try {
      return await f(args || {});
    } catch (err) {
      if (err && /PERMISSION_DENIED|permission_denied/i.test(String(err.code || err.message))){
        console.error("Firebase:", err);
        throw new Error("Firebase rechazó la operación: las reglas de la base de datos no permiten acceder a estos datos (ver README.md, «Reglas de Firebase»).");
      }
      throw err;
    }
  }
  return { llamar };
})();
