import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { seedCars } from '../src/data.js';

const STORE_KEY = 'the-family-auto-store-v1';
const stages = { confirmed: 0, preparing: 20, on_the_way: 55, nearby: 85, delivered: 100 };
let memoryStore;

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

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('996')) digits = digits.slice(3);
  if (digits.length > 9 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length === 9 ? `+996${digits}` : '';
}

function freshStore() {
  return { cars: structuredClone(seedCars), reviews: [], orders: [], bookings: [], users: [] };
}
function normalizeStore(store) {
  return { cars: store?.cars || seedCars, reviews: store?.reviews || [], orders: store?.orders || [], bookings: store?.bookings || [], users: store?.users || [] };
}
async function redisCommand(command) {
  const url = process.env.TFA_STORE_URL;
  const token = process.env.TFA_STORE_TOKEN;
  if (!url || !token) return null;
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  if (!response.ok) throw new Error(`Хранилище данных ответило HTTP ${response.status}`);
  return (await response.json()).result;
}
async function getStore() {
  if (process.env.TFA_STORE_URL && process.env.TFA_STORE_TOKEN) {
    try {
      const saved = await redisCommand(['GET', STORE_KEY]);
      if (saved) return normalizeStore(JSON.parse(saved));
      const initial = freshStore();
      await redisCommand(['SET', STORE_KEY, JSON.stringify(initial)]);
      return initial;
    } catch (error) {
      console.error('Persistent store unavailable:', error.message);
      throw new Error('Не удалось подключиться к хранилищу. Проверьте TFA_STORE_URL и TFA_STORE_TOKEN в Vercel.');
    }
  }
  memoryStore ||= freshStore();
  return memoryStore;
}
async function saveStore(store) {
  memoryStore = store;
  if (process.env.TFA_STORE_URL && process.env.TFA_STORE_TOKEN) {
    try { await redisCommand(['SET', STORE_KEY, JSON.stringify(store)]); }
    catch (error) { console.error('Persistent store write failed:', error.message); throw new Error('Не удалось сохранить данные. Проверьте подключение к хранилищу Vercel.'); }
  }
}

function tokenFor(user) {
  const encode = value => Buffer.from(value).toString('base64url');
  const unsigned = `${encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${encode(JSON.stringify({ sub: user.email, name: user.name, role: user.role, exp: Date.now() + 7 * 86400000 }))}`;
  const signature = createHmac('sha256', process.env.JWT_SECRET || 'local-only-change-this-secret').update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}
function userFromToken(req) {
  try {
    const authorization = req.headers.authorization || '';
    const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('tfa_token='))?.slice(10);
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : decodeURIComponent(cookie || '');
    const [header, payload, signature] = token.split('.');
    const unsigned = `${header}.${payload}`;
    const expected = createHmac('sha256', process.env.JWT_SECRET || 'local-only-change-this-secret').update(unsigned).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return user.exp > Date.now() ? user : null;
  } catch { return null; }
}
function reply(res, status, body) { return res.status(status).json(body); }
function requireUser(req, res, admin = false) {
  const user = userFromToken(req);
  if (!user) { reply(res, 401, { error: 'Нужно войти в аккаунт' }); return null; }
  if (admin && user.role !== 'admin') { reply(res, 403, { error: 'Доступ только для администратора' }); return null; }
  return user;
}
function sendCookie(res, token) {
  res.setHeader('Set-Cookie', `tfa_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
async function notify(record) {
  const cars = record.items?.map(item => item.name).filter(Boolean).join(', ') || record.car || 'Не указан';
  const message = [
    record.items ? '🚘 Новый заказ The Family Auto' : '📅 Новая заявка The Family Auto',
    `Номер: ${record.reference || '—'}`,
    `Клиент: ${record.name || 'Не указано'}`,
    `Телефон: ${record.phone || 'Не указан'}`,
    `Автомобиль: ${cars}`,
    record.total ? `Сумма: $${Number(record.total).toLocaleString('en-US')}` : '',
    record.method ? `Формат: ${record.method}` : '',
    record.email ? `Email: ${record.email}` : '',
  ].filter(Boolean).join('\n');
  const results = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message }) });
      results.push({ telegram: response.ok ? 'sent' : 'failed' });
    } catch { results.push({ telegram: 'failed' }); }
  }
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const route = String(url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
  const parts = route.split('/').filter(Boolean);
  const method = req.method || 'GET';
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    const store = await getStore();
    if (method === 'GET' && route === 'cars') return reply(res, 200, store.cars);
    if (method === 'GET' && route === 'reviews') return reply(res, 200, store.reviews);
    if (method === 'POST' && route === 'auth') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !body.password) return reply(res, 400, { error: 'Укажите email и пароль' });
      let user = store.users.find(item => item.email === email);
      if (body.mode === 'register') {
        if (body.terms !== 'on') return reply(res, 400, { error: 'Подтвердите согласие с условиями использования' });
        const phone = normalizePhone(body.phone);
        if (!phone) return reply(res, 400, { error: 'Введите 9 цифр телефона после кода +996' });
        if (user) return reply(res, 409, { error: 'Аккаунт с таким email уже существует' });
        const salt = randomBytes(16).toString('hex');
        user = { email, name: body.name || email.split('@')[0], phone, role: email === (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase() ? 'admin' : 'user', salt, passwordHash: scryptSync(body.password, salt, 64).toString('hex') };
        store.users.push(user); await saveStore(store);
      } else if (!user || !user.passwordHash || scryptSync(body.password, user.salt, 64).toString('hex') !== user.passwordHash) return reply(res, 401, { error: 'Неверная почта или пароль' });
      if (email === (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase() && user.role !== 'admin') {
        user.role = 'admin';
        await saveStore(store);
      }
      const token = tokenFor(user); sendCookie(res, token);
      return reply(res, 200, { token, user: { name: user.name, email: user.email, role: user.role } });
    }
    if (method === 'POST' && route === 'auth/oauth') {
      if (!['google', 'github'].includes(body.provider)) return reply(res, 400, { error: 'Неизвестный OAuth provider' });
      const user = { name: `${body.provider[0].toUpperCase()}${body.provider.slice(1)} Demo`, email: `${body.provider}-demo@example.com`, role: 'user' };
      return reply(res, 200, { token: tokenFor(user), user, demo: true });
    }
    if (method === 'GET' && route === 'me') {
      const user = requireUser(req, res); if (!user) return;
      return reply(res, 200, { name: user.name, email: user.sub, role: user.role });
    }
    if (method === 'GET' && route === 'admin/stats') {
      if (!requireUser(req, res, true)) return;
      const byBrand = ['Toyota', 'Mercedes-Benz', 'Honda', 'Lamborghini'].map(brand => ({ brand, total: store.cars.filter(car => car.brand === brand).length }));
      return reply(res, 200, { cars: store.cars.length, orders: store.orders.length, revenue: store.orders.reduce((sum, order) => sum + Number(order.total || 0), 0), byBrand });
    }
    if (method === 'PATCH' && parts[0] === 'admin' && parts[1] === 'orders' && parts[2]) {
      if (!requireUser(req, res, true)) return;
      const order = store.orders.find(item => item.reference === parts[2]);
      if (!order) return reply(res, 404, { error: 'Заказ не найден' });
      if (!Object.hasOwn(stages, body.status)) return reply(res, 400, { error: 'Неизвестный этап заказа' });
      const updatedAt = new Date().toISOString();
      Object.assign(order, { status: body.status, progress: stages[body.status], progressAt: updatedAt, updatedAt });
      await saveStore(store); return reply(res, 200, order);
    }
    if (method === 'GET' && parts[0] === 'orders' && parts[1]) {
      const user = requireUser(req, res); if (!user) return;
      const order = store.orders.find(item => item.reference === parts[1] && (user.role === 'admin' || item.email === user.sub));
      if (order && advanceTracking(order)) await saveStore(store);
      return order ? reply(res, 200, order) : reply(res, 404, { error: 'Заказ не найден' });
    }
    if (method === 'GET' && route === 'admin/orders') {
      if (!requireUser(req, res, true)) return;
      return reply(res, 200, store.orders);
    }
    if (method === 'POST' && route === 'cars') {
      if (!requireUser(req, res, true)) return;
      const car = { ...body, id: Date.now(), name: `${body.brand} ${body.model}`, rating: 5, reviews: 0, badge: body.badge || 'Новинка', description: body.description || 'Новый автомобиль в каталоге The Family Auto.' };
      store.cars.unshift(car); await saveStore(store); return reply(res, 201, car);
    }
    if ((method === 'PUT' || method === 'DELETE') && parts[0] === 'cars' && parts[1]) {
      if (!requireUser(req, res, true)) return;
      const index = store.cars.findIndex(car => String(car.id) === parts[1]);
      if (index < 0) return reply(res, 404, { error: 'Автомобиль не найден' });
      if (method === 'DELETE') { store.cars.splice(index, 1); await saveStore(store); return reply(res, 200, { ok: true }); }
      store.cars[index] = { ...store.cars[index], ...body, id: store.cars[index].id, name: `${body.brand || store.cars[index].brand} ${body.model || store.cars[index].model}` };
      await saveStore(store); return reply(res, 200, store.cars[index]);
    }
    if (method === 'POST' && route === 'reviews') {
      const review = { ...body, id: Date.now(), rating: Math.max(1, Math.min(5, Number(body.rating) || 5)), createdAt: new Date().toISOString() };
      store.reviews.unshift(review); await saveStore(store); return reply(res, 201, review);
    }
    if (method === 'POST' && route === 'contact') {
      const phone = normalizePhone(body.phone); if (!phone) return reply(res, 400, { error: 'Введите 9 цифр телефона после кода +996' });
      return reply(res, 201, { ok: true, notifications: await notify({ ...body, phone, total: 0, reference: `TFA-${Date.now().toString().slice(-6)}` }) });
    }
    if (method === 'POST' && route === 'bookings') {
      const phone = normalizePhone(body.phone); if (!phone) return reply(res, 400, { error: 'Введите 9 цифр телефона после кода +996' });
      const booking = { id: Date.now(), ...body, phone, reference: `TFA-${Date.now().toString().slice(-6)}`, createdAt: new Date().toISOString() };
      store.bookings.unshift(booking); await saveStore(store); return reply(res, 201, { ok: true, reference: booking.reference, notifications: await notify({ ...booking, total: 0 }) });
    }
    if (method === 'POST' && route === 'orders') {
      const user = requireUser(req, res); if (!user) return;
      const phone = normalizePhone(body.phone); if (!phone) return reply(res, 400, { error: 'Введите 9 цифр телефона после кода +996' });
      const ids = Array.isArray(body.items) ? body.items.map(Number) : [];
      const items = store.cars.filter(car => ids.includes(Number(car.id)));
      if (!items.length) return reply(res, 400, { error: 'Корзина пуста' });
      const reference = `TFA-${Date.now().toString().slice(-6)}`;
      const createdAt = new Date().toISOString();
      const order = { id: Date.now(), reference, name: body.name || user.name, email: body.email || user.sub, phone, items: items.map(car => ({ id: car.id, name: car.name, price: car.price })), total: items.reduce((sum, car) => sum + car.price, 0), payment: body.payment || 'demo', status: 'confirmed', progress: 0, progressAt: createdAt, createdAt, updatedAt: createdAt };
      store.orders.unshift(order); await saveStore(store); const notifications = await notify(order);
      return reply(res, 201, { ok: true, reference, total: order.total, payment: { provider: order.payment, mode: 'demo', status: 'pending' }, notifications });
    }
    if (method === 'POST' && route === 'payments') {
      if (!requireUser(req, res)) return;
      return reply(res, 200, { mode: 'demo', provider: body.provider || 'stripe', message: 'Демо-платёж: деньги не списываются', reference: `PAY-${Date.now().toString().slice(-6)}` });
    }
    if (method === 'GET' && route.startsWith('oauth/')) return reply(res, 503, { error: 'Настройте OAuth client ID и secret в переменных Vercel перед включением Google/GitHub login.' });
    return reply(res, 404, { error: 'API endpoint не найден' });
  } catch (error) {
    console.error('API error:', error);
    return reply(res, 500, { error: error.message || 'Внутренняя ошибка API' });
  }
}
