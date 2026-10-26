import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Server as SocketServer } from 'socket.io';
import nodemailer from 'nodemailer';
import { seedCars } from './src/data.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.join(root, 'data', 'store.json');
let storePromise;
let io;
const oauthStates = new Map();
let config = {};
const base64url = value => Buffer.from(value).toString('base64url');
function signToken(user) {
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ sub: user.email, name: user.name, role: user.role, iat: Date.now(), exp: Date.now() + 7 * 86400000 }));
  const unsigned = `${head}.${body}`;
  return `${unsigned}.${createHmac('sha256', config.JWT_SECRET || 'local-only-change-this-secret').update(unsigned).digest('base64url')}`;
}
function verifyToken(token) {
  try {
    const [head, body, signature] = token.split('.');
    const unsigned = `${head}.${body}`;
    const expected = createHmac('sha256', config.JWT_SECRET || 'local-only-change-this-secret').update(unsigned).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
function getToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)));
  return cookies.tfa_token || '';
}
function send(res, status, body) { res.statusCode = status; res.end(JSON.stringify(body)); }
function advanceTracking(order) {
  if (order.status === 'delivered') return false;
  const now = Date.now();
  const lastProgressAt = Date.parse(order.progressAt || order.updatedAt || order.createdAt || now);
  const elapsedTicks = Math.floor(Math.max(0, now - lastProgressAt) / 2000);
  if (!elapsedTicks) return false;
  order.progress = Math.min(100, Number(order.progress || 0) + elapsedTicks * 5);
  order.progressAt = new Date(lastProgressAt + elapsedTicks * 2000).toISOString();
  order.status = order.progress >= 100 ? 'delivered' : order.progress >= 80 ? 'nearby' : order.progress >= 30 ? 'on_the_way' : order.progress >= 10 ? 'preparing' : 'confirmed';
  order.updatedAt = new Date(now).toISOString();
  return true;
}
async function getStore() {
  if (!storePromise) storePromise = (async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(storePath, 'utf8'));
      return { cars: saved.cars || seedCars, reviews: saved.reviews || [], orders: saved.orders || [], bookings: saved.bookings || [], users: saved.users || [] };
    } catch {
      const fresh = { cars: seedCars, reviews: [], orders: [], bookings: [], users: [] };
      await writeFile(storePath, JSON.stringify(fresh, null, 2));
      return fresh;
    }
  })();
  return storePromise;
}
async function saveStore(store) { await writeFile(storePath, JSON.stringify(store, null, 2)); }
function authUser(req, res, admin = false) {
  const payload = verifyToken(getToken(req));
  if (!payload) { send(res, 401, { error: 'Нужно войти в аккаунт' }); return null; }
  if (admin && payload.role !== 'admin') { send(res, 403, { error: 'Доступ только для администратора' }); return null; }
  return payload;
}
async function notify(order) {
  const messages = [];
  const message = `The Family Auto: ${order.reference}; заказ от ${order.name} (${order.phone}), сумма $${order.total}.`;
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text: message }) });
      messages.push({ telegram: response.ok ? 'sent' : 'failed' });
    } catch { messages.push({ telegram: 'failed' }); }
  }
  if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS && config.ORDER_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({ host: config.SMTP_HOST, port: Number(config.SMTP_PORT || 587), secure: String(config.SMTP_SECURE) === 'true', auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } });
      await transporter.sendMail({ from: config.SMTP_FROM || config.SMTP_USER, to: config.ORDER_EMAIL, subject: `Новый заказ ${order.reference}`, text: message });
      messages.push({ email: 'sent' });
    } catch { messages.push({ email: 'failed' }); }
  }
  return messages;
}
async function oauthCallback(provider, query, res) {
  const { code, state } = query;
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  if (!saved || saved.provider !== provider || saved.exp < Date.now()) return send(res, 400, { error: 'OAuth state is invalid or expired' });
  let profile;
  try {
    if (provider === 'google') {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, redirect_uri: saved.redirectUri, grant_type: 'authorization_code' }) });
      const tokens = await tokenResponse.json();
      const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } });
      profile = await userResponse.json();
    } else {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ code, client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET }) });
      const tokens = await tokenResponse.json();
      const userResponse = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': 'The-Family-Auto' } });
      const github = await userResponse.json();
      let email = github.email;
      if (!email) { const emailResponse = await fetch('https://api.github.com/user/emails', { headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': 'The-Family-Auto' } }); email = (await emailResponse.json()).find(item => item.primary)?.email; }
      profile = { email, name: github.name || github.login };
    }
    if (!profile?.email) throw new Error('OAuth provider did not return an email');
    const store = await getStore();
    const user = { email: profile.email, name: profile.name || profile.email.split('@')[0], role: profile.email.toLowerCase() === (config.ADMIN_EMAIL || 'admin@example.com').toLowerCase() ? 'admin' : 'user' };
    const existing = store.users.findIndex(item => item.email === user.email);
    if (existing < 0) store.users.push(user); else store.users[existing] = { ...store.users[existing], ...user };
    await saveStore(store);
    const token = signToken(user);
    res.statusCode = 302;
    res.setHeader('Set-Cookie', `tfa_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${config.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.setHeader('Location', '/?oauth=success');
    return res.end();
  } catch (error) { return send(res, 401, { error: `Не удалось завершить ${provider} OAuth: ${error.message}` }); }
}
function apiPlugin() {
  const handler = async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/oauth/google') {
      if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return send(res, 503, { error: 'Добавьте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в .env для OAuth' });
      const state = randomBytes(24).toString('hex'); const redirectUri = config.GOOGLE_OAUTH_CALLBACK_URL || 'http://localhost:5173/api/oauth/google/callback';
      oauthStates.set(state, { provider: 'google', redirectUri, exp: Date.now() + 600000 });
      res.statusCode = 302; res.setHeader('Location', `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' })}`); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/oauth/github') {
      if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) return send(res, 503, { error: 'Добавьте GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET в .env для OAuth' });
      const state = randomBytes(24).toString('hex'); const redirectUri = config.GITHUB_OAUTH_CALLBACK_URL || 'http://localhost:5173/api/oauth/github/callback';
      oauthStates.set(state, { provider: 'github', redirectUri, exp: Date.now() + 600000 });
      res.statusCode = 302; res.setHeader('Location', `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: config.GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: 'read:user user:email', state })}`); return res.end();
    }
    const callback = url.pathname.match(/^\/api\/oauth\/(google|github)\/callback$/);
    if (req.method === 'GET' && callback) return oauthCallback(callback[1], Object.fromEntries(url.searchParams), res);
    if (!url.pathname.startsWith('/api/')) return next();
    const parseBody = () => new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Некорректный JSON')); } }); req.on('error', reject); });
    let body = {};
    if (!['GET','HEAD'].includes(req.method)) { try { body = await parseBody(); } catch (error) { return send(res, 400, { error: error.message }); } }
    try {
      const store = await getStore();
      if (req.method === 'GET' && url.pathname === '/api/cars') return send(res, 200, store.cars);
      if (req.method === 'GET' && url.pathname === '/api/reviews') return send(res, 200, store.reviews);
      if (req.method === 'GET' && url.pathname === '/api/me') { const user = authUser(req, res); if (!user) return; return send(res, 200, { name: user.name, email: user.sub, role: user.role }); }
      if (req.method === 'POST' && url.pathname === '/api/auth') {
        const email = String(body.email || '').toLowerCase().trim();
        if (!email || !body.password) return send(res, 400, { error: 'Укажите email и пароль' });
        let user = store.users.find(item => item.email === email);
        if (body.mode === 'register') {
          if (user) return send(res, 409, { error: 'Аккаунт с таким email уже существует' });
          const salt = randomBytes(16).toString('hex'); const passwordHash = scryptSync(body.password, salt, 64).toString('hex');
          user = { email, name: body.name || email.split('@')[0], role: email === (config.ADMIN_EMAIL || 'admin@example.com').toLowerCase() ? 'admin' : 'user', salt, passwordHash };
          store.users.push(user); await saveStore(store);
        } else if (!user || !user.passwordHash || scryptSync(body.password, user.salt, 64).toString('hex') !== user.passwordHash) return send(res, 401, { error: 'Неверная почта или пароль' });
        if (email === (config.ADMIN_EMAIL || 'admin@example.com').toLowerCase() && user.role !== 'admin') { user.role = 'admin'; await saveStore(store); }
        const token = signToken(user); return send(res, 200, { token, user: { name: user.name, email: user.email, role: user.role } });
      }
      if (req.method === 'GET' && url.pathname === '/api/cars') return send(res, 200, store.cars);
      if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
        const user = authUser(req, res, true); if (!user) return;
        const byBrand = ['Toyota','Mercedes-Benz','Honda','Lamborghini'].map(brand => ({ brand, total: store.cars.filter(car => car.brand === brand).length }));
        return send(res, 200, { cars: store.cars.length, orders: store.orders.length, revenue: store.orders.reduce((sum, order) => sum + Number(order.total || 0), 0), byBrand });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
        if (!authUser(req, res, true)) return;
        return send(res, 200, store.orders);
      }
      const adminOrderRoute = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if (req.method === 'PATCH' && adminOrderRoute) {
        if (!authUser(req, res, true)) return;
        const order = store.orders.find(item => item.reference === decodeURIComponent(adminOrderRoute[1]));
        if (!order) return send(res, 404, { error: 'Заказ не найден' });
        const stages = { confirmed: 0, preparing: 20, on_the_way: 55, nearby: 85, delivered: 100 };
        if (!(body.status in stages)) return send(res, 400, { error: 'Неизвестный этап заказа' });
        order.status = body.status; order.progress = stages[body.status]; order.progressAt = new Date().toISOString(); order.updatedAt = order.progressAt;
        await saveStore(store); io?.emit('order:changed', { reference: order.reference });
        return send(res, 200, order);
      }
      const orderRoute = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (req.method === 'GET' && orderRoute) {
        const user = authUser(req, res); if (!user) return;
        const order = store.orders.find(item => item.reference === decodeURIComponent(orderRoute[1]) && (user.role === 'admin' || item.email === user.sub));
        if (!order) return send(res, 404, { error: 'Заказ не найден' });
        if (advanceTracking(order)) await saveStore(store);
        return send(res, 200, order);
      }
      const carRoute = url.pathname.match(/^\/api\/cars\/(\d+)$/);
      if (req.method === 'POST' && url.pathname === '/api/cars') {
        if (!authUser(req, res, true)) return;
        const car = { ...body, id: Date.now(), name: `${body.brand} ${body.model}`, rating: 5, reviews: 0, badge: body.badge || 'Новинка', description: body.description || 'Новый автомобиль в каталоге The Family Auto.' };
        store.cars.unshift(car); await saveStore(store); io?.emit('cars:changed'); return send(res, 201, car);
      }
      if (req.method === 'PUT' && carRoute) {
        if (!authUser(req, res, true)) return;
        const index = store.cars.findIndex(car => car.id === Number(carRoute[1])); if (index < 0) return send(res, 404, { error: 'Автомобиль не найден' });
        store.cars[index] = { ...store.cars[index], ...body, id: store.cars[index].id, name: `${body.brand || store.cars[index].brand} ${body.model || store.cars[index].model}` };
        await saveStore(store); io?.emit('cars:changed'); return send(res, 200, store.cars[index]);
      }
      if (req.method === 'DELETE' && carRoute) {
        if (!authUser(req, res, true)) return;
        store.cars = store.cars.filter(car => car.id !== Number(carRoute[1])); await saveStore(store); io?.emit('cars:changed'); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/reviews') { const review = { ...body, id: Date.now(), rating: Math.max(1, Math.min(5, Number(body.rating) || 5)), createdAt: new Date().toISOString() }; store.reviews.unshift(review); await saveStore(store); io?.emit('reviews:changed'); return send(res, 201, review); }
      if (req.method === 'POST' && url.pathname === '/api/contact') return send(res, 201, { ok: true, notifications: await notify({ ...body, total: 0, reference: `TFA-${Date.now().toString().slice(-6)}` }) });
      if (req.method === 'POST' && url.pathname === '/api/bookings') {
        const reference = `TFA-${Date.now().toString().slice(-6)}`;
        const booking = { id: Date.now(), ...body, reference, createdAt: new Date().toISOString() };
        store.bookings.unshift(booking); await saveStore(store); io?.emit('bookings:changed');
        return send(res, 201, { ok: true, reference, notifications: await notify({ ...booking, total: 0 }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        const user = authUser(req, res); if (!user) return;
        const ids = Array.isArray(body.items) ? body.items.map(Number) : [];
        const items = store.cars.filter(car => ids.includes(car.id));
        const reference = `TFA-${Date.now().toString().slice(-6)}`;
        const createdAt = new Date().toISOString();
        const order = { id: Date.now(), reference, name: body.name || user.name, email: body.email || user.sub, phone: body.phone, items: items.map(car => ({ id: car.id, name: car.name, price: car.price })), total: items.reduce((sum, car) => sum + car.price, 0), payment: body.payment || 'demo', status: 'confirmed', progress: 0, progressAt: createdAt, createdAt, updatedAt: createdAt };
        store.orders.unshift(order); await saveStore(store); const notifications = await notify(order); io?.emit('orders:changed'); io?.emit('order:changed', { reference });
        return send(res, 201, { ok: true, reference, total: order.total, payment: { provider: order.payment, mode: 'demo', status: 'pending' }, notifications });
      }
      if (req.method === 'POST' && url.pathname === '/api/payments') { if (!authUser(req, res)) return; return send(res, 200, { mode: 'demo', provider: body.provider || 'stripe', message: 'Демо-платёж: деньги не списываются', reference: `PAY-${Date.now().toString().slice(-6)}` }); }
      if (req.method === 'POST' && url.pathname === '/api/auth/oauth') {
        if (!['google','github'].includes(body.provider)) return send(res, 400, { error: 'Неизвестный OAuth provider' });
        const email = `${body.provider}-demo@example.com`; const user = { name: `${body.provider[0].toUpperCase()}${body.provider.slice(1)} Demo`, email, role: 'user' };
        return send(res, 200, { token: signToken(user), user, demo: true });
      }
      return send(res, 404, { error: 'API endpoint не найден' });
    } catch (error) { return send(res, 500, { error: error.message }); }
  };
  return {
    name: 'family-auto-api',
    configureServer(server) { io = new SocketServer(server.httpServer, { cors: { origin: true, credentials: true } }); server.middlewares.use(handler); },
    configurePreviewServer(server) { io = new SocketServer(server.httpServer, { cors: { origin: true, credentials: true } }); server.middlewares.use(handler); },
  };
}

export default defineConfig(({ mode }) => {
  config = { ...process.env, ...loadEnv(mode, root, '') };
  return { plugins: [react(), apiPlugin()], server: { port: 5173, host: true } };
});
