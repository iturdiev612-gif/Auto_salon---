import React, { useState } from 'react';
import BrandMark from '../components/BrandMark.jsx';
import PhoneInput from '../components/PhoneInput.jsx';

const authText = {
  ru: { login: 'Вход в THE FAMILY AUTO', register: 'Создать аккаунт', intro: 'Сохраняйте автомобили, бронируйте просмотр и оформляйте заказы.', name: 'Ваше имя', phone: 'Номер телефона', email: 'Электронная почта', password: 'Пароль', submitLogin: 'Войти', submitRegister: 'Зарегистрироваться', switchLogin: 'Уже есть аккаунт? Войти', switchRegister: 'Нет аккаунта? Зарегистрироваться', error: 'Не удалось выполнить вход', back: '← Вернуться в автосалон', social: 'Или войдите через', terms: 'Я принимаю условия использования и политику конфиденциальности', note: 'Вход по SMS и Telegram ещё не подключён. Номер сохранится для связи по заказу. Google/GitHub требуют настройки ключей.', adminNote: 'Чтобы открыть панель и добавлять автомобили, зарегистрируйте admin@example.com (или адрес из ADMIN_EMAIL). После входа нажмите кнопку «Панель администратора» в шапке сайта.' },
  kg: { login: 'THE FAMILY AUTO аккаунты', register: 'Аккаунт түзүү', intro: 'Унааларды сактап, көрүүгө жазылып, буйрутма бериңиз.', name: 'Атыңыз', phone: 'Телефон номери', email: 'Электрондук почта', password: 'Сырсөз', submitLogin: 'Кирүү', submitRegister: 'Катталуу', switchLogin: 'Аккаунтуңуз барбы? Кириңиз', switchRegister: 'Аккаунт жокпу? Катталыңыз', error: 'Кирүү ишке ашкан жок', back: '← Автосалонго кайтуу', social: 'Же бул аркылуу кириңиз', terms: 'Колдонуу шарттарын жана купуялык саясатын кабыл алам', note: 'SMS жана Telegram аркылуу кирүү азырынча туташтырыла элек. Телефон буйрутма боюнча байланыш үчүн сакталат.', adminNote: 'Унаа кошуу үчүн admin@example.com (же ADMIN_EMAIL дарегиңиз) менен катталып, сайттын жогору жагындагы админ панелин ачыңыз.' },
  en: { login: 'Sign in to THE FAMILY AUTO', register: 'Create an account', intro: 'Save cars, book a viewing and place orders.', name: 'Your name', phone: 'Phone number', email: 'Email address', password: 'Password', submitLogin: 'Sign in', submitRegister: 'Create account', switchLogin: 'Already registered? Sign in', switchRegister: 'New here? Create an account', error: 'Could not sign in', back: '← Back to the showroom', social: 'Or continue with', terms: 'I accept the terms of use and privacy policy', note: 'SMS and Telegram sign-in are not connected yet. Your phone number is saved for order contact.', adminNote: 'To add cars, register with admin@example.com (or the ADMIN_EMAIL address), then open Admin panel from the site header.' },
};

export default function AuthPage({ mode = 'login', lang = 'ru', onAuth, onNavigate }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = authText[lang] || authText.ru;
  const isRegister = mode === 'register';
  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.mode = isRegister ? 'register' : 'login';
    payload.terms = form.get('terms') || '';
    try {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t.error);
      onAuth(result);
    } catch (e) { setError(e.message || t.error); }
    finally { setBusy(false); }
  };
  const oauth = async provider => {
    const enabled = provider === 'google' ? import.meta.env.VITE_GOOGLE_OAUTH_ENABLED : import.meta.env.VITE_GITHUB_OAUTH_ENABLED;
    if (enabled === 'true') { location.href = `/api/oauth/${provider}`; return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/oauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t.error);
      onAuth(result);
    } catch (e) { setError(e.message || t.error); }
    finally { setBusy(false); }
  };

  return <main className="auth-page">
    <a className="auth-back" href="/" onClick={event => { event.preventDefault(); onNavigate('/'); }}>{t.back}</a>
    <section className="auth-panel">
      <div className="auth-box">
        <a className="auth-brand" href="/" onClick={event => { event.preventDefault(); onNavigate('/'); }}><BrandMark/><span>THE FAMILY <b>AUTO</b><small>PREMIUM AUTOMOBILES · BISHKEK</small></span></a>
        <h1>{isRegister ? t.register : t.login}</h1>
        <p>{t.intro}</p>
        <div className="auth-providers"><button type="button" onClick={() => oauth('google')} disabled={busy}><b className="provider-google">G</b> Google</button><button type="button" onClick={() => oauth('github')} disabled={busy}><b>⌘</b> GitHub</button></div>
        <div className="auth-divider"><span/>{t.social}<span/></div>
        <form className="auth-form" onSubmit={submit}>
          {isRegister && <label>{t.name}<input name="name" required autoComplete="name" placeholder="Асан Асанов"/></label>}
          {isRegister && <label>{t.phone}<PhoneInput/></label>}
          <label>{t.email}<input name="email" type="email" required autoComplete="email" placeholder="name@example.com"/></label>
          <label>{t.password}<input name="password" type="password" required minLength="8" autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder="••••••••"/></label>
          {isRegister && <label className="auth-terms"><input name="terms" type="checkbox" required value="on"/><span>{t.terms}</span></label>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="button button-lime auth-submit" type="submit" disabled={busy}>{busy ? '…' : isRegister ? t.submitRegister : t.submitLogin}<span>↗</span></button>
        </form>
        <small className="auth-demo">{t.note}</small>
        <small className="auth-admin-note">{t.adminNote}</small>
        <button className="auth-switch" onClick={() => onNavigate(isRegister ? '/login' : '/register')}>{isRegister ? t.switchLogin : t.switchRegister}</button>
      </div>
    </section>
  </main>;
}
