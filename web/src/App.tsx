import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Boxes,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  Receipt,
  Rocket,
  Settings as SettingsIcon,
  Stethoscope,
  Sun,
  Tags,
  X,
} from 'lucide-react';
import { Component, useEffect, useState } from 'react';
import { api, post, useApi } from './api.ts';
import { ActivityPage } from './pages/Activity.tsx';
import { Catalog } from './pages/Catalog.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { ListingEditor } from './pages/ListingEditor.tsx';
import { Listings } from './pages/Listings.tsx';
import { Orders } from './pages/Orders.tsx';
import { Products } from './pages/Products.tsx';
import { Profiles } from './pages/Profiles.tsx';
import { Reports } from './pages/Reports.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Setup } from './pages/Setup.tsx';
import { Button, cx, Field, Link, Spinner, useRouter } from './ui.tsx';

type Session = { authenticated: boolean; needsPassword: boolean; version: string };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const refresh = () => api<Session>('/api/session').then(setSession).catch(() => setSession({ authenticated: false, needsPassword: false, version: '' }));
  useEffect(() => {
    refresh();
    const onAuth = () => setSession((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);
  if (!session)
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="size-6 text-brand-500" />
      </div>
    );
  if (!session.authenticated) return <Login firstRun={session.needsPassword} onDone={refresh} />;
  return <Shell version={session.version} onLogout={() => post('/api/logout').then(refresh)} />;
}

function Login({ firstRun, onDone }: { firstRun: boolean; onDone: () => void }) {
  const { navigate } = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (firstRun && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      await post(firstRun ? '/api/setup/password' : '/api/login', { password });
      if (firstRun) navigate('/setup');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)]" />
      <form onSubmit={submit} className="card animate-in relative w-full max-w-sm p-7 dark:bg-zinc-900/70">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">{firstRun ? 'Welcome! Create your password' : 'Sign in'}</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {firstRun ? 'This password protects your dashboard. You will set up Shopify and eBay next.' : 'Enter your dashboard password.'}
        </p>
        <div className="mt-6 space-y-4">
          <Field label="Password">
            <input type="password" autoFocus className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={firstRun ? 8 : undefined} required />
          </Field>
          {firstRun && (
            <Field label="Confirm password" hint="At least 8 characters.">
              <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>
          )}
          {error && <p className="text-sm text-rose-500">{error}</p>}
          <Button variant="primary" className="w-full" loading={busy} type="submit">
            {firstRun ? 'Create password & continue' : 'Sign in'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-lg shadow-brand-500/30">
        <ArrowLeftRight className="size-[18px]" />
      </div>
      {!compact && (
        <div className="leading-tight">
          <div className="text-sm font-semibold">Shopify ⇄ eBay</div>
          <div className="text-[11px] text-zinc-500">Inventory sync</div>
        </div>
      )}
    </div>
  );
}

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/products', label: 'Shopify products', icon: Package },
  { to: '/catalog', label: 'Catalog health', icon: Stethoscope },
  { to: '/listings', label: 'eBay listings', icon: Boxes },
  { to: '/profiles', label: 'Listing profiles', icon: Tags },
  { to: '/reports', label: 'Profit reports', icon: BarChart3 },
  { to: '/orders', label: 'eBay sales', icon: Receipt },
  { to: '/activity', label: 'Activity log', icon: Activity },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  return (
    <button
      className="btn-ghost p-2"
      title="Toggle theme"
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle('dark', next);
        localStorage.setItem('theme', next ? 'dark' : 'light');
        setDark(next);
      }}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

function Shell({ version, onLogout }: { version: string; onLogout: () => void }) {
  const { path } = useRouter();
  const [mobileNav, setMobileNav] = useState(false);
  const status = useApi('/api/status', { refreshMs: 30_000 });
  const pathname = path.split('?')[0];
  const setupIncomplete = status.data && !status.data.checklist.complete;
  const active = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  let page: React.ReactNode;
  const listingMatch = pathname.match(/^\/listings\/(\d+)$/);
  if (pathname === '/setup') page = <Setup onChange={status.reload} />;
  else if (listingMatch) page = <ListingEditor id={Number(listingMatch[1])} />;
  else if (pathname.startsWith('/products')) page = <Products />;
  else if (pathname.startsWith('/catalog')) page = <Catalog />;
  else if (pathname.startsWith('/listings')) page = <Listings />;
  else if (pathname.startsWith('/profiles')) page = <Profiles />;
  else if (pathname.startsWith('/reports')) page = <Reports />;
  else if (pathname.startsWith('/orders')) page = <Orders />;
  else if (pathname.startsWith('/activity')) page = <ActivityPage />;
  else if (pathname.startsWith('/settings')) page = <SettingsPage onChange={status.reload} />;
  else page = <Dashboard status={status} />;

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5">
      {setupIncomplete && (
        <Link
          to="/setup"
          onClick={() => setMobileNav(false)}
          className={cx(
            'mb-2 flex items-center gap-3 rounded-xl bg-gradient-to-r from-brand-500/15 to-violet-500/10 px-3 py-2.5 text-sm font-medium text-brand-700 ring-1 ring-brand-500/20 dark:text-brand-300',
          )}
        >
          <Rocket className="size-4" /> Finish setup
          <span className="ml-auto rounded-full bg-brand-500 px-1.5 text-[10px] text-white">
            {status.data.checklist.steps.filter((s: any) => !s.done && !s.optional).length}
          </span>
        </Link>
      )}
      {NAV.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          onClick={() => setMobileNav(false)}
          className={cx(
            'flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition',
            active(to) ? 'bg-zinc-900 font-medium text-white shadow-sm dark:bg-white/10' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-200',
          )}
        >
          <Icon className="size-4" /> {label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-zinc-200/80 bg-white/70 p-4 backdrop-blur-xl lg:flex dark:border-white/[0.06] dark:bg-white/[0.02]">
        <div className="mb-6 px-1 pt-1">
          <Logo />
        </div>
        {nav}
        <Footer version={version} dryRun={status.data?.dryRun} onLogout={onLogout} />
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-zinc-200/80 bg-white/80 px-4 py-3 backdrop-blur-xl lg:hidden dark:border-white/[0.06] dark:bg-[#0b0b12]/80">
        <Logo />
        <button className="btn-ghost p-2" onClick={() => setMobileNav(true)}>
          <Menu className="size-5" />
        </button>
      </header>
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNav(false)} />
          <aside className="animate-in absolute inset-y-0 left-0 flex w-72 flex-col bg-white p-4 dark:bg-zinc-950">
            <div className="mb-6 flex items-center justify-between">
              <Logo />
              <button className="btn-ghost p-2" onClick={() => setMobileNav(false)}>
                <X className="size-4" />
              </button>
            </div>
            {nav}
            <Footer version={version} dryRun={status.data?.dryRun} onLogout={onLogout} />
          </aside>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <ErrorBoundary key={pathname}>{page}</ErrorBoundary>
      </main>
    </div>
  );
}

/** Shows a friendly message instead of a blank page if a screen crashes. */
class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card mx-auto max-w-lg p-6 text-center">
        <h2 className="font-semibold">Something went wrong on this page</h2>
        <p className="mt-2 font-mono text-xs break-words text-rose-500">{this.state.error.message}</p>
        <p className="mt-2 text-sm text-zinc-500">Your data is safe. Try reloading. If it keeps happening, report it with this message.</p>
        <Button variant="primary" className="mt-4" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}

function Footer({ version, dryRun, onLogout }: { version: string; dryRun?: boolean; onLogout: () => void }) {
  return (
    <div className="mt-4 space-y-3 border-t border-zinc-200/80 pt-4 dark:border-white/[0.06]">
      {dryRun && (
        <Link to="/settings?tab=sync" className="block rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 ring-1 ring-amber-500/20 dark:text-amber-300">
          Dry-run mode is on. Nothing is changed on eBay or Shopify.
        </Link>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-400">v{version}</span>
        <div className="flex">
          <ThemeToggle />
          <button className="btn-ghost p-2" title="Sign out" onClick={onLogout}>
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
