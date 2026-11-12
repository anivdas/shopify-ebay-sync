import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useState } from 'react';
import { ago, api, useApi } from '../api.ts';
import { Button, Card, Empty, PageHeader, Spinner, Tabs } from '../ui.tsx';

const ICON = {
  info: <Info className="size-4 text-sky-500" />,
  success: <CheckCircle2 className="size-4 text-emerald-500" />,
  warn: <AlertTriangle className="size-4 text-amber-500" />,
  error: <XCircle className="size-4 text-rose-500" />,
} as Record<string, React.ReactNode>;

export function ActivityPage() {
  const [level, setLevel] = useState<'' | 'error' | 'warn' | 'success' | 'info'>('');
  const q = useApi(`/api/activity?limit=100${level ? `&level=${level}` : ''}`, { refreshMs: 30_000 });
  const [more, setMore] = useState<any[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const rows = [...((q.data?.activity ?? []) as any[]), ...more];
  const loadMore = async () => {
    setLoadingMore(true);
    const last = rows[rows.length - 1];
    const r = await api(`/api/activity?limit=100&before=${last.id}${level ? `&level=${level}` : ''}`);
    setMore((m) => [...m, ...r.activity]);
    setLoadingMore(false);
  };
  return (
    <div>
      <PageHeader
        title="Activity log"
        description="Everything the app did, newest first. Kept for 90 days."
        actions={
          <Tabs
            value={level}
            onChange={(v) => {
              setLevel(v);
              setMore([]);
            }}
            tabs={[
              { value: '', label: 'All' },
              { value: 'error', label: 'Errors' },
              { value: 'warn', label: 'Warnings' },
              { value: 'success', label: 'Success' },
              { value: 'info', label: 'Info' },
            ]}
          />
        }
      />
      <Card padded={false}>
        {q.loading && !q.data ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty title="Nothing here yet" />
        ) : (
          <>
            <ul className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {rows.map((a) => (
                <li key={a.id} className="flex gap-3 px-5 py-3">
                  <span className="mt-0.5">{ICON[a.level]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{a.message}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      <span className="font-mono">{a.type}</span> · <span title={a.ts}>{ago(a.ts)}</span>
                    </p>
                    {a.data && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-zinc-400">details</summary>
                        <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto rounded-lg bg-zinc-50 p-2 text-[11px] dark:bg-white/[0.04]">{JSON.stringify(a.data, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {rows.length >= 100 && (
              <div className="border-t border-zinc-100 p-3 text-center dark:border-white/[0.06]">
                <Button variant="ghost" loading={loadingMore} onClick={loadMore}>
                  Load older
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
