'use strict';
/* Villa Libertad · servidor mundial
   Una sola ciudad compartida por todos los jugadores (WebSocket).
   Uso:  npm install  &&  npm start        (PORT y MAX_PLAYERS opcionales)
   Este archivo se genera a partir de index.html: la lógica del juego es la misma. */
const http = require('http');
const fs = require('fs');
const path = require('path');
let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); } catch (e) { console.error('Falta la dependencia "ws". Ejecuta primero: npm install'); process.exit(1); }

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS, 10) || 80;
const DIR = __dirname;
const STARTED = Date.now();
const CELL = 480, ROAD = 120;

/* ============ lógica del juego (misma que en el navegador) ============ */
/*SHARED:garage*/
// Concesionario (civiles) y garaje (policía): zona de interacción y plazas donde aparecen los coches.
const GARAGES = {
  civil: { kind: 'civil', n: 'Concesionario', zx: CELL + ROAD + 180, zy: 2 * CELL + ROAD + 175, zr: 62,
    pads: [80, 180, 280].map(dx => ({ x: CELL + ROAD + dx, y: 2 * CELL + ROAD + 305, a: Math.PI / 2 })) },
  police: { kind: 'police', n: 'Garaje policial', zx: CELL + ROAD + 280, zy: CELL + ROAD + 180, zr: 55,
    pads: [65, 125, 185].map(dx => ({ x: CELL + ROAD + dx, y: CELL + ROAD + 300, a: Math.PI / 2 })) }
};
// Catálogo: p = precio en €, t = nivel, maxF = velocidad máx., acc = aceleración, turn = giro.
const CATALOG = [
  { k: 'utilitario', role: 'civil', n: 'Utilitario', p: 0, t: 0, len: 58, maxF: 440, acc: 340, turn: 2.3 },
  { k: 'compacto', role: 'civil', n: 'Compacto', p: 400, t: 1, len: 62, maxF: 520, acc: 400, turn: 2.4 },
  { k: 'berlina', role: 'civil', n: 'Berlina', p: 1000, t: 2, len: 78, maxF: 580, acc: 430, turn: 2.35 },
  { k: 'deportivo', role: 'civil', n: 'Deportivo', p: 2500, t: 3, len: 70, maxF: 650, acc: 540, turn: 2.6 },
  { k: 'superdeportivo', role: 'civil', n: 'Superdeportivo', p: 5000, t: 4, len: 74, maxF: 700, acc: 650, turn: 2.8 },
  { k: 'patrulla', role: 'police', n: 'Patrulla estándar', p: 0, t: 0, len: 66, maxF: 440, acc: 340, turn: 2.3 },
  { k: 'patrulla2', role: 'police', n: 'Patrulla mejorada', p: 500, t: 1, len: 68, maxF: 540, acc: 420, turn: 2.4 },
  { k: 'interceptora', role: 'police', n: 'Interceptora', p: 1500, t: 2, len: 72, maxF: 630, acc: 520, turn: 2.6 },
  { k: 'superpatrulla', role: 'police', n: 'Superpatrulla', p: 3500, t: 3, len: 76, maxF: 700, acc: 640, turn: 2.8 }
];
const MODEL = {}; CATALOG.forEach(m => { MODEL[m.k] = m; });
const BASE_SPEC = { maxF: 440, acc: 340, turn: 2.3 }; // coches de la ciudad sin modelo
/*END:garage*/

const TL_CYCLE = 20, TL_D = 26;
const tlInter = [];
for (let j = 1; j <= 4; j++) for (let i = 1; i <= 4; i++) tlInter.push({ i, j, x0: i * CELL, y0: j * CELL, x1: i * CELL + ROAD, y1: j * CELL + ROAD });
// axis 0 = tráfico norte-sur (eje Y), axis 1 = este-oeste (eje X). T = segundo del ciclo (0-20)
function tlState(i, j, axis, T) {
  let ph = (T + ((i + j) & 1) * 10) % TL_CYCLE;
  if (axis === 1) ph = (ph + 10) % TL_CYCLE;
  if (ph < 8) return { c: 'g', age: 0 };
  if (ph < 10) return { c: 'y', age: 0 };
  return { c: 'r', age: ph - 10 };
}
let tlBase = 0, tlAt = 0;
const tlNow = () => (tlBase + (performance.now() - tlAt) / 1000) % TL_CYCLE;
const FINE_REASONS = [
  { k: 'semaforo', t: 'Saltarse un semáforo en rojo', a: 90 },
  { k: 'velocidad', t: 'Exceso de velocidad', a: 120 },
  { k: 'temeraria', t: 'Conducción temeraria', a: 150 },
  { k: 'senal', t: 'No respetar la señalización', a: 60 },
  { k: 'aparcar', t: 'Aparcamiento indebido', a: 40 },
  { k: 'orden', t: 'Alteración del orden público', a: 80 },
  { k: 'desobediencia', t: 'Desobediencia a la autoridad', a: 100 }
];
const ARREST_REASONS = [
  { k: 'reiteradas', t: 'Infracciones de tráfico reiteradas' },
  { k: 'temeraria', t: 'Conducción temeraria' },
  { k: 'desobediencia', t: 'Desobediencia a la autoridad' },
  { k: 'orden', t: 'Alteración del orden público' }
];

const Server = (() => {
  const SW = 2520, PI = Math.PI;
  const CARS = []; let carId = 1;
  const addCar = (kind, color, len, x, y, a) => CARS.push({ id: carId++, kind, color, len, x, y, a, hx: x, hy: y, ha: a, emptyAt: 0, driver: 0, si: 0, radio: 0, m: '', owner: 0 });
  const CAR_IDLE_MS = 180000; // un coche abandonado vuelve a su sitio tras 3 minutos vacío
  [640, 690, 740, 790].forEach(x => addCar('police', '#f4f6f8', 66, x, 810, -PI / 2));
  addCar('civil', '#c0392b', 58, 640, 1810, -PI / 2);
  addCar('civil', '#2980b9', 66, 700, 1810, -PI / 2);
  addCar('civil', '#f1c40f', 74, 760, 1810, -PI / 2);
  addCar('civil', '#d35400', 66, 1710, 1790, PI / 2);
  const carPub = c => ({ id: c.id, kind: c.kind, color: c.color, len: c.len, x: c.x, y: c.y, a: c.a, d: c.driver, si: c.si, r: c.radio, m: c.m || '', o: c.owner || 0 });

  const sp = new Map(); let nextId = 1;
  const now = () => Date.now();
  const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = 0; return Math.max(lo, Math.min(hi, v)); };
  const pub = p => ({ id: p.id, name: p.name, role: p.role, color: p.color });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const send = (p, o) => { if (p.conn.open()) p.conn.send(JSON.stringify(o)); };
  const bcast = (o, except) => { const s = JSON.stringify(o); for (const p of sp.values()) if (p !== except && p.conn.open()) p.conn.send(s); };
  const sys = text => bcast({ t: 'chat', sys: 1, text });
  const freeCar = p => { for (const c of CARS) if (c.driver === p.id) { c.driver = 0; c.si = 0; c.fx = undefined; c.radio = 0; c.emptyAt = now(); } p.v = 0; };
  let signer = null; // solo en el servidor mundial (server.js): firma las partidas guardadas
  const sendSave = p => { if (signer) send(p, { t: 'save', s: signer.sign({ v: 1, m: p.money, o: [...p.owned].filter(k => MODEL[k] && MODEL[k].p > 0), f: p.fines }) }); };
  const sendMoney = p => { send(p, { t: 'money', money: p.money, fines: p.fines }); sendSave(p); };
  const ownedList = p => [...p.owned];
  const dropPersonal = p => { for (let i = CARS.length - 1; i >= 0; i--) if (CARS[i].owner === p.id) { const id = CARS[i].id; CARS.splice(i, 1); bcast({ t: 'cardel', id }); } };
  const atGarage = p => { const g = GARAGES[p.role]; return !!g && Math.hypot(p.x - g.zx, p.y - g.zy) <= g.zr + 45; };
  const JAIL_SECONDS = 25;
  const tNow = () => (Date.now() / 1000) % TL_CYCLE;
  const sendStatus = p => send(p, { t: 'status', wanted: p.wanted ? 1 : 0, n: p.strikes });
  function infraction(p, text) {
    const t = now();
    if (t - p.lastInf < 2000) return;
    p.lastInf = t; p.strikes = Math.min(p.strikes + 1, 9);
    let fresh = false;
    if (!p.wanted && p.strikes >= 3) { p.wanted = true; fresh = true; }
    if (p.wanted) p.wantedUntil = t + 120000;
    send(p, { t: 'infr', text, n: p.strikes, wanted: p.wanted ? 1 : 0, fresh: fresh ? 1 : 0 });
    sendStatus(p);
    if (fresh) for (const q of sp.values()) if (q.role === 'police') send(q, { t: 'wantedalert', x: p.x, y: p.y, name: p.name });
  }
  // el morro del coche (a -> b) cruza la línea de detención de un semáforo en rojo
  function checkRedLight(p, ax, ay, bx, by) {
    const T = tNow();
    for (const it of tlInter) {
      let axis = -1;
      if (bx >= it.x0 && bx <= it.x1) {
        if (ay < it.y0 - TL_D && by >= it.y0 - TL_D) axis = 0;
        else if (ay > it.y1 + TL_D && by <= it.y1 + TL_D) axis = 0;
      } else if (by >= it.y0 && by <= it.y1) {
        if (ax < it.x0 - TL_D && bx >= it.x0 - TL_D) axis = 1;
        else if (ax > it.x1 + TL_D && bx <= it.x1 + TL_D) axis = 1;
      }
      if (axis < 0) continue;
      const st = tlState(it.i, it.j, axis, T);
      if (st.c === 'r' && st.age > 0.7) { infraction(p, 'Semáforo en rojo'); return; }
    }
  }

  function onMessage(conn, raw) {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    let me = conn.p;
    if (!me && m.t !== 'join') return;
    switch (m.t) {
      case 'join': {
        const name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Jugador';
        const role = m.role === 'police' ? 'police' : 'civil';
        const color = /^#[0-9a-f]{6}$/i.test(String(m.color)) ? m.color : '#2e86de';
        if (!me) {
          me = conn.p = { id: nextId++, conn, name, role, color, x: 1260, y: 1260, a: 0, v: 0, money: 300, fines: 0, jailUntil: 0, lastAct: 0, lastCall: 0, strikes: 0, wanted: false, wantedUntil: 0, lastInf: 0, owned: new Set(), lastSpawn: 0 };
          sp.set(me.id, me);
          if (signer && typeof m.save === 'string' && m.save.length < 800) { // partida guardada (solo si la firma es válida)
            const d = signer.verify(m.save);
            if (d && d.v === 1) {
              me.money = Math.floor(num(d.m, 0, 9999999)); me.fines = Math.floor(num(d.f, 0, 99999));
              for (const k of Array.isArray(d.o) ? d.o.slice(0, 20) : []) if (MODEL[k] && MODEL[k].p > 0) me.owned.add(k);
            }
          }
          send(me, { t: 'welcome', id: me.id, players: [...sp.values()].filter(p => p !== me).map(pub), cars: CARS.map(carPub), money: me.money, fines: me.fines, count: sp.size, own: ownedList(me) });
          sendSave(me);
          bcast({ t: 'pjoin', p: pub(me) }, me);
          sys(`${name} ha llegado a la ciudad como ${role === 'police' ? 'Policía Local' : 'civil'}.`);
        } else {
          if (me.jailUntil > now()) { send(me, { t: 'notice', text: 'No puedes cambiar de rol estando detenido.' }); break; }
          freeCar(me); dropPersonal(me);
          me.name = name; me.role = role; me.color = color;
          me.wanted = false; me.strikes = 0; me.wantedUntil = 0; sendStatus(me);
          bcast({ t: 'pjoin', p: pub(me) }, me);
          sys(`${name} ahora es ${role === 'police' ? 'Policía Local' : 'civil'}.`);
        }
        break;
      }
      case 'u': {
        me.x = num(m.x, 0, SW); me.y = num(m.y, 0, SW); me.a = Number(m.a) || 0;
        const c = m.v ? CARS.find(c => c.id === m.v && c.driver === me.id) : null;
        if (c) {
          c.x = num(m.cx, 0, SW); c.y = num(m.cy, 0, SW); c.a = Number(m.ca) || 0;
          c.si = m.si && c.kind === 'police' ? 1 : 0;
          const nfx = c.x + Math.cos(c.a) * c.len / 2, nfy = c.y + Math.sin(c.a) * c.len / 2;
          if (me.role === 'civil' && c.fx !== undefined) checkRedLight(me, c.fx, c.fy, nfx, nfy);
          c.fx = nfx; c.fy = nfy;
          me.v = c.id;
        } else me.v = 0;
        break;
      }
      case 'enter': {
        if (me.v || me.jailUntil > now()) break;
        const c = CARS.find(c => c.id === m.id);
        if (!c || c.driver) break;
        if (c.kind === 'police' && me.role !== 'police') { send(me, { t: 'notice', text: 'Ese coche es de la Policía Local.' }); break; }
        if (c.owner && c.owner !== me.id) { send(me, { t: 'notice', text: 'Ese coche es de otro jugador.' }); break; }
        if (Math.hypot(c.x - me.x, c.y - me.y) > 170) break;
        c.driver = me.id; me.v = c.id; c.fx = undefined;
        send(me, { t: 'entered', id: c.id });
        break;
      }
      case 'exit': freeCar(me); break;
      case 'buy': {
        const mdl = MODEL[m.m];
        if (!mdl || mdl.role !== me.role || me.jailUntil > now()) break;
        if (!atGarage(me)) { send(me, { t: 'notice', text: 'Acércate al ' + GARAGES[me.role].n.toLowerCase() + '.' }); break; }
        if (mdl.p === 0 || me.owned.has(mdl.k)) { send(me, { t: 'owned', own: ownedList(me) }); break; }
        if (me.money < mdl.p) { send(me, { t: 'notice', text: 'Te faltan ' + (mdl.p - me.money) + ' € para comprar el ' + mdl.n + '.' }); break; }
        me.money -= mdl.p; me.owned.add(mdl.k);
        send(me, { t: 'owned', own: ownedList(me) }); sendMoney(me);
        send(me, { t: 'notice', text: '✅ Has comprado: ' + mdl.n + ' (' + mdl.p + ' €). ¡Ya puedes sacarlo!' });
        break;
      }
      case 'spawn': {
        const mdl = MODEL[m.m];
        if (!mdl || mdl.role !== me.role || me.jailUntil > now()) break;
        if (!atGarage(me)) { send(me, { t: 'notice', text: 'Acércate al ' + GARAGES[me.role].n.toLowerCase() + '.' }); break; }
        if (mdl.p > 0 && !me.owned.has(mdl.k)) { send(me, { t: 'notice', text: 'Aún no tienes ese vehículo.' }); break; }
        if (now() - me.lastSpawn < 3000) { send(me, { t: 'notice', text: 'Espera unos segundos antes de sacar otro coche.' }); break; }
        const g = GARAGES[me.role];
        const pad = g.pads.find(pd => !CARS.some(c => c.owner !== me.id && Math.hypot(c.x - pd.x, c.y - pd.y) < 70));
        if (!pad) { send(me, { t: 'notice', text: 'La salida está ocupada. Inténtalo en unos segundos.' }); break; }
        me.lastSpawn = now();
        freeCar(me); dropPersonal(me);
        const color = g.kind === 'police' ? '#f4f6f8' : (/^#[0-9a-f]{6}$/i.test(String(m.c)) ? m.c : '#2e86de');
        const car = { id: carId++, kind: g.kind, color, len: mdl.len, x: pad.x, y: pad.y, a: pad.a, hx: pad.x, hy: pad.y, ha: pad.a, emptyAt: 0, driver: me.id, si: 0, radio: 0, m: mdl.k, owner: me.id };
        CARS.push(car); me.v = car.id;
        bcast({ t: 'caradd', c: carPub(car) });
        send(me, { t: 'entered', id: car.id });
        break;
      }
      case 'radio': {
        const c = me.v ? CARS.find(c => c.id === me.v && c.driver === me.id) : null;
        if (c) c.radio = (m.s === 1 || m.s === 2 || m.s === 3) ? m.s : 0;
        break;
      }
      case 'chat': {
        const text = String(m.text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 140);
        if (text && now() - (me.lastChat || 0) >= 600) { me.lastChat = now(); bcast({ t: 'chat', id: me.id, name: me.name, role: me.role, text }); }
        break;
      }
      case 'horn': bcast({ t: 'horn', x: me.x, y: me.y }); break;
      case 'call': {
        if (me.role !== 'civil' || now() - me.lastCall < 15000) break;
        me.lastCall = now();
        for (const p of sp.values()) if (p.role === 'police') send(p, { t: 'alert', x: me.x, y: me.y, name: me.name });
        send(me, { t: 'notice', text: 'Has llamado a la Policía Local. Mantén la calma.' });
        break;
      }
      case 'arrest':
      case 'fine': {
        if (me.role !== 'police' || me.jailUntil > now()) break;
        const t = sp.get(Number(m.id));
        if (!t || t.role !== 'civil' || t.jailUntil > now()) break;
        if (now() - me.lastAct < 1500) break;
        if (dist(me, t) > 120) { send(me, { t: 'notice', text: 'Estás demasiado lejos de ' + t.name + '.' }); break; }
        if (m.t === 'arrest') {
          const r = ARREST_REASONS.find(x => x.k === m.r);
          if (!r) break;
          if (!t.wanted) { send(me, { t: 'notice', text: 'Solo puedes llevar a la cárcel a una persona buscada. Multa a ' + t.name + ' eligiendo un motivo.' }); break; }
          me.lastAct = now();
          const wasDriving = CARS.some(c => c.driver === t.id);
          freeCar(t);
          t.jailUntil = now() + JAIL_SECONDS * 1000;
          t.wanted = false; t.strikes = 0; t.wantedUntil = 0;
          if (wasDriving) send(t, { t: 'forceexit' });
          send(t, { t: 'jail', sec: JAIL_SECONDS, why: r.t });
          sendStatus(t);
          me.money += 100;
          sys(`🚔 El agente ${me.name} ha detenido a ${t.name}: ${r.t}.`);
        } else {
          const r = FINE_REASONS.find(x => x.k === m.r);
          if (!r) break;
          me.lastAct = now();
          t.money = Math.max(0, t.money - r.a);
          t.fines++;
          if (!t.wanted) { t.strikes = 0; sendStatus(t); }
          me.money += Math.round(r.a / 3);
          send(t, { t: 'notice', text: `El agente ${me.name} te ha multado con ${r.a} € por: ${r.t}.` });
          sys(`🧾 El agente ${me.name} ha multado a ${t.name} por ${r.t.toLowerCase()} (${r.a} €).`);
        }
        sendMoney(me); sendMoney(t);
        break;
      }
    }
  }

  function onClose(conn) {
    const me = conn.p; if (!me) return;
    conn.p = null;
    freeCar(me); dropPersonal(me); sp.delete(me.id);
    bcast({ t: 'pleft', id: me.id });
    sys(`${me.name} ha abandonado la ciudad.`);
  }

  let tn = 0;
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
  function tick() {
    tn++;
    const t = now();
    if (sp.size) {
      const s = JSON.stringify({ t: 'snap', p: [...sp.values()].map(p => [p.id, r1(p.x), r1(p.y), r2(p.a), p.v, p.jailUntil > t ? 1 : 0, p.wanted ? 1 : 0, p.strikes]), tl: r2(tNow()), c: CARS.map(c => [c.id, r1(c.x), r1(c.y), r2(c.a), c.driver, c.si, c.radio]) });
      for (const p of sp.values()) if (p.conn.open()) p.conn.send(s);
    }
    if (tn % 10 === 0) for (const p of sp.values()) if (p.jailUntil && p.jailUntil <= t) { p.jailUntil = 0; send(p, { t: 'free' }); }
    if (tn % 10 === 0) for (const p of sp.values()) {
      if (p.wanted && t > p.wantedUntil) { p.wanted = false; p.strikes = 0; send(p, { t: 'notice', text: 'Has despistado a la policía. Ya no estás buscado.' }); sendStatus(p); }
      else if (!p.wanted && p.strikes > 0 && t - p.lastInf > 120000) { p.strikes = 0; sendStatus(p); }
    }
    if (tn % 20 === 0) for (let i = CARS.length - 1; i >= 0; i--) {
      const c = CARS[i];
      if (c.driver || !c.emptyAt || t - c.emptyAt <= CAR_IDLE_MS) continue;
      if (c.owner) { CARS.splice(i, 1); bcast({ t: 'cardel', id: c.id }); } // coche comprado y abandonado: vuelve al garaje
      else { c.x = c.hx; c.y = c.hy; c.a = c.ha; c.si = 0; c.radio = 0; c.emptyAt = 0; c.fx = undefined; }
    }
    if (tn % 400 === 0) for (const p of sp.values()) { p.money += p.role === 'police' ? 30 : 15; sendMoney(p); }
  }
  return { onMessage, onClose, tick, count: () => sp.size, setSigner: f => { signer = f; } };
})();

/* ======================================================================= */

/* ---- partidas guardadas: el servidor firma el dinero y los coches comprados; el navegador del jugador los guarda ---- */
const crypto = require('crypto');
const SAVE_SECRET = process.env.SAVE_SECRET || 'villa-libertad-secreto-por-defecto';
if (!process.env.SAVE_SECRET) console.warn('AVISO: no hay variable SAVE_SECRET. Las partidas guardadas funcionan, pero se pueden falsificar. Defínela (Render → Environment) con un texto largo y secreto.');
const hmac = p => crypto.createHmac('sha256', SAVE_SECRET).update(p).digest('base64url');
Server.setSigner({
  sign(obj) { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return p + '.' + hmac(p); },
  verify(tok) {
    const i = tok.indexOf('.'); if (i < 1) return null;
    const p = tok.slice(0, i), sig = Buffer.from(tok.slice(i + 1)), good = Buffer.from(hmac(p));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
    try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { return null; }
  }
});

const MIME = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length' };

function findFile(name) {
  if (!/^[\w.\- ]+$/.test(name)) return null;
  const ext = path.extname(name).toLowerCase();
  if (!MIME[ext]) return null;
  let list; try { list = fs.readdirSync(DIR); } catch (e) { return null; }
  const hit = list.find(f => f.toLowerCase() === name.toLowerCase());
  return hit ? path.join(DIR, hit) : null;
}

function serveFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch (e) { res.writeHead(404, CORS); return res.end('No encontrado'); }
  const ext = path.extname(file).toLowerCase(), size = st.size;
  const h = Object.assign({ 'Content-Type': MIME[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': ext === '.mp3' ? 'public, max-age=86400' : 'no-cache' }, CORS);
  let start = 0, end = size - 1, code = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + size }, CORS)); return res.end(); }
    if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); }
    else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10)); }
    if (start > end || start >= size) { res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + size }, CORS)); return res.end(); }
    code = 206; h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  }
  h['Content-Length'] = end - start + 1;
  res.writeHead(code, h);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const rs = fs.createReadStream(file, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, CORS); return res.end(); }
    let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400, CORS); return res.end(); }
    if (p === '/health') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, CORS)); return res.end('ok'); }
    if (p === '/status') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS));
      return res.end(JSON.stringify({ players: Server.count(), max: MAX_PLAYERS, uptime: Math.round((Date.now() - STARTED) / 1000) }));
    }
    const name = p === '/' ? 'index.html' : p.slice(1);
    const file = findFile(name);
    if (!file) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS)); return res.end('No encontrado'); }
    serveFile(req, res, file);
  } catch (e) { console.error(e); try { res.writeHead(500); res.end(); } catch (e2) {} }
});

const wss = new WebSocketServer({ server, maxPayload: 4096, perMessageDeflate: false });

wss.on('connection', ws => {
  ws.isAlive = true;
  let slow = 0, winStart = Date.now(), winN = 0;
  const conn = {
    p: null,
    open: () => ws.readyState === 1,
    send: s => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > 256 * 1024) { if (++slow > 200) ws.terminate(); return; } // cliente lento: se descartan snapshots
      slow = 0; ws.send(s);
    }
  };
  const joinTimer = setTimeout(() => { if (!conn.p) ws.close(4000, 'timeout'); }, 15000);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const t = Date.now();
    if (t - winStart >= 1000) { winStart = t; winN = 0; }
    if (++winN > 400) return ws.terminate();
    if (winN > 100) return; // más de ~100 mensajes por segundo: se ignoran
    const s = data.toString();
    try {
      if (!conn.p) {
        let m; try { m = JSON.parse(s); } catch (e) { return; }
        if (!m || m.t !== 'join') return;
        if (Server.count() >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full', max: MAX_PLAYERS })); ws.close(); return; }
      }
      Server.onMessage(conn, s);
    } catch (e) { console.error('Error en mensaje:', e); }
  });
  ws.on('close', () => { clearTimeout(joinTimer); try { Server.onClose(conn); } catch (e) { console.error(e); } });
  ws.on('error', () => {});
});

setInterval(() => { try { Server.tick(); } catch (e) { console.error('Error en tick:', e); } }, 50);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
}, 25000);

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
server.listen(PORT, '0.0.0.0', () => console.log('Villa Libertad en marcha: http://localhost:' + PORT + '  (máx. ' + MAX_PLAYERS + ' jugadores)'));
