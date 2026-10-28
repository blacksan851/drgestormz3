import { useEffect, useState } from 'react';

type User = {
  id?: string;
  name?: string;
  login?: string;
  email?: string;
  role?: string;
  caixa?: string | null;
};

async function requestJson(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('drgestor_token');
  const headers = new Headers(options.headers ?? {});

  if (!(options.headers as Headers | undefined)?.has?.('Content-Type') && !options.body?.toString().startsWith('FormData')) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || 'Nao foi possivel concluir a operacao.');
  }

  return payload;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [loginForm, setLoginForm] = useState({ identifier: 'admin', password: 'Admin@12345' });

  useEffect(() => {
    const token = localStorage.getItem('drgestor_token');
    if (!token) {
      setLoading(false);
      return;
    }

    requestJson('/auth/session')
      .then((response) => {
        setUser(response.user || null);
      })
      .catch(() => {
        localStorage.removeItem('drgestor_token');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    try {
      const response = await requestJson('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: loginForm.identifier,
          password: loginForm.password,
        }),
      });

      localStorage.setItem('drgestor_token', response.token);
      setUser(response.user || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao entrar.');
    }
  }

  function handleLogout() {
    localStorage.removeItem('drgestor_token');
    setUser(null);
  }

  if (loading) {
    return <div className="screen loading-screen">Carregando sistema...</div>;
  }

  if (user) {
    return (
      <div className="screen dashboard-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">DR Gestor</p>
            <h1>Dashboard do caixa</h1>
          </div>
          <button className="logout-button" onClick={handleLogout}>Sair</button>
        </header>

        <main className="dashboard-grid">
          <section className="panel primary-panel">
            <p className="label">Bem-vindo</p>
            <h2>{user.name || user.login || 'Usuário'}</h2>
            <div className="meta-list">
              <span>Perfil: {String(user.role || 'caixa').toUpperCase()}</span>
              <span>Login: {user.login || '—'}</span>
              <span>Email: {user.email || '—'}</span>
              {user.caixa ? <span>Caixa: {user.caixa}</span> : null}
            </div>
          </section>

          <section className="panel">
            <p className="label">Resumo</p>
            <div className="stat-row">
              <div>
                <strong>01</strong>
                <span>Pagamentos hoje</span>
              </div>
              <div>
                <strong>00</strong>
                <span>Pagamentos pendentes</span>
              </div>
            </div>
          </section>

          <section className="panel wide-panel">
            <p className="label">Ações rápidas</p>
            <div className="actions-grid">
              <button type="button">Abrir caixa</button>
              <button type="button">Vendas</button>
              <button type="button">Clientes</button>
              <button type="button">Relatórios</button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="screen auth-shell">
      <div className="auth-card">
        <div className="brand-box">
          <p className="eyebrow">DR Gestor</p>
          <h1>Login</h1>
          <p>Acesso do caixa</p>
        </div>

        {error ? <div className="error-box">{error}</div> : null}

        <form onSubmit={handleLogin} className="auth-form">
          <label>
            Login ou email
            <input
              value={loginForm.identifier}
              onChange={(event) => setLoginForm((current) => ({ ...current, identifier: event.target.value }))}
              placeholder="admin ou caixa@exemplo.com"
            />
          </label>

          <label>
            Senha
            <input
              type="password"
              value={loginForm.password}
              onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="••••••••"
            />
          </label>

          <button type="submit" className="primary-button">Entrar</button>
          <small className="helper-text">Padrao admin: admin / Admin@12345</small>
        </form>
      </div>
    </div>
  );
}
