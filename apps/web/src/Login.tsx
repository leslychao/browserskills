import { useState } from 'react';
export function Login({onLogin,error,busy}:{onLogin:(login:string,password:string)=>Promise<void>;error:string|null;busy:boolean}){
  const [login,setLogin]=useState('');const [password,setPassword]=useState('');
  return <main className="login-page"><section className="login-intro"><div className="brand"><span className="brand-mark">b.</span> BrowserSkills</div><span className="eyebrow">Помощник для Яндекс Янг</span><h1>Инструкция.<br/>Материал.<br/><em>Результат.</em></h1><p>Выбирайте задания или задавайте критерии. Помощник читает инструкции и выполняет задания на вашем сервере.</p><div className="login-tags"><span>Текст</span><span>Изображения</span><span>Аудио</span></div></section>
    <form className="login-form" onSubmit={event=>{event.preventDefault();if(!busy&&login&&password)void onLogin(login,password);}}>
      <span className="section-label">Рабочее пространство</span><h2>Войти в BrowserSkills</h2><p>Используйте учётную запись, которую создал администратор сервера.</p>
      <label>Логин<input name="login" autoComplete="username" value={login} onChange={event=>setLogin(event.target.value)} required disabled={busy}/></label>
      <label>Пароль<input name="password" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required disabled={busy}/></label>
      {error&&<p role="alert" className="notice error">{error}</p>}
      <button className="primary" disabled={busy||!login||!password}>{busy?'Входим…':'Войти'}</button><small>Вход в Яндекс выполняется отдельно, в вашем серверном браузере.</small>
    </form></main>;
}
