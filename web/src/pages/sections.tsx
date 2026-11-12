import { CheckCircle2, ExternalLink, KeyRound, Pencil, Plug, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, del, post, put, useApi } from '../api.ts';
import { Badge, Button, Callout, CopyField, Field, Toggle, useAction, useConfirm } from '../ui.tsx';

export type Settings = Record<string, any>;

export function useSettings() {
  const q = useApi<{ settings: Settings; marketplaces: Record<string, any> }>('/api/settings');
  const save = async (patch: Settings) => {
    const r = await put<{ settings: Settings }>('/api/settings', patch);
    q.setData((d) => (d ? { ...d, settings: r.settings } : d));
    return r.settings;
  };
  return { settings: q.data?.settings ?? null, marketplaces: q.data?.marketplaces ?? {}, save, reload: q.reload };
}

/** Local editable copy of some settings keys with a Save button. */
function useDraft(settings: Settings | null, keys: string[]) {
  const [draft, setDraft] = useState<Settings>({});
  useEffect(() => {
    if (settings) setDraft(Object.fromEntries(keys.map((k) => [k, settings[k]])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = settings ? keys.some((k) => draft[k] !== settings[k]) : false;
  return { draft, set, dirty };
}

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-600 hover:underline dark:text-brand-400">
    {children}
    <ExternalLink className="size-3" />
  </a>
);

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-600 marker:font-semibold marker:text-brand-500 dark:text-zinc-300">{children}</ol>;
}

function Secret({ label, value, onChange, fromEnv, hint }: { label: string; value: string; onChange: (v: string) => void; fromEnv?: boolean; hint?: ReactNode }) {
  return (
    <Field label={label} hint={fromEnv ? 'Set by an environment variable' : hint}>
      <input type="password" autoComplete="off" className="input font-mono" value={value} disabled={fromEnv} onChange={(e) => onChange(e.target.value)} placeholder="Paste here" />
    </Field>
  );
}

// ======================= Shopify connection =======================

export function ShopifySection({ onSaved }: { onSaved?: () => void }) {
  const creds = useApi('/api/credentials');
  const status = useApi('/api/status');
  const { busy, run } = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const [legacy, setLegacy] = useState(false);
  const c = creds.data?.credentials;
  useEffect(() => {
    if (!c) return;
    setForm({ shopifyShop: c.shopifyShop.value, shopifyClientId: c.shopifyClientId.value, shopifyClientSecret: c.shopifyClientSecret.value, shopifyAccessToken: c.shopifyAccessToken.value });
    setLegacy(!!c.shopifyAccessToken.set && !c.shopifyClientId.set);
  }, [creds.data]);
  const test = status.data?.shopify?.test;

  const saveAndTest = () =>
    run(
      'save',
      async () => {
        await put('/api/credentials', legacy ? { ...form, shopifyClientId: '', shopifyClientSecret: '' } : { ...form, shopifyAccessToken: '' });
        const r = await post('/api/credentials/test', { which: 'shopify' });
        status.reload();
        creds.reload();
        onSaved?.();
        if (!r.ok) throw new Error(r.error ?? `Missing permissions: ${r.missingScopes?.join(', ')}`);
        return r;
      },
      (r: any) => `Connected to ${r.shop}`,
    );

  if (!c) return null;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
      <div className="space-y-4">
        <h3 className="text-sm font-semibold">How to get your Shopify keys (5 minutes)</h3>
        <Steps>
          <li>
            Open the <A href="https://dev.shopify.com/dashboard">Shopify Dev Dashboard</A> and sign in with the account that owns your store.
          </li>
          <li>
            Click <b>Create app</b>, then name it something like <i>eBay Sync</i>.
          </li>
          <li>
            Under <b>Versions</b>, create a version. Add these <b>Access scopes</b>: <code className="text-xs">write_products, read_inventory, write_inventory, read_locations</code> (<i>write_products</i> lets the Catalog health page fix SKUs, barcodes and costs for you). For App URL you can use <code className="text-xs">https://example.com</code>. Click <b>Release</b>.
          </li>
          <li>
            Go to <b>Home</b> and click <b>Install app</b>, then pick your store.
          </li>
          <li>
            Open <b>Settings</b>, copy the <b>Client ID</b> and <b>Client secret</b>, and paste them here.
          </li>
        </Steps>
        <Callout kind="info">Your keys are stored encrypted on your own server and are never sent anywhere except Shopify.</Callout>
      </div>
      <div className="space-y-4">
        <Field label="Store address" hint="Just the part before .myshopify.com (e.g. my-store)">
          <div className="flex items-center">
            <input className="input rounded-r-none" value={form.shopifyShop ?? ''} disabled={c.shopifyShop.fromEnv} onChange={(e) => setForm({ ...form, shopifyShop: e.target.value })} placeholder="my-store" />
            <span className="rounded-r-xl border border-l-0 border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.06]">.myshopify.com</span>
          </div>
        </Field>
        {!legacy ? (
          <>
            <Field label="Client ID">
              <input className="input font-mono" value={form.shopifyClientId ?? ''} disabled={c.shopifyClientId.fromEnv} onChange={(e) => setForm({ ...form, shopifyClientId: e.target.value })} />
            </Field>
            <Secret label="Client secret" value={form.shopifyClientSecret ?? ''} fromEnv={c.shopifyClientSecret.fromEnv} onChange={(v) => setForm({ ...form, shopifyClientSecret: v })} />
          </>
        ) : (
          <Secret label="Admin API access token" hint="Starts with shpat_ (from an older custom app created in Shopify admin)" value={form.shopifyAccessToken ?? ''} fromEnv={c.shopifyAccessToken.fromEnv} onChange={(v) => setForm({ ...form, shopifyAccessToken: v })} />
        )}
        <button className="text-xs text-zinc-500 underline-offset-2 hover:underline" onClick={() => setLegacy(!legacy)}>
          {legacy ? 'Use Client ID & secret instead (recommended)' : 'I have an older custom app with a shpat_ access token'}
        </button>
        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" loading={busy === 'save'} onClick={saveAndTest}>
            <Plug className="size-4" /> Save & test connection
          </Button>
          {test?.ok && (
            <Badge color="green">
              <CheckCircle2 className="size-3" /> {test.shop} ({test.currency})
            </Badge>
          )}
        </div>
        {test && !test.ok && (
          <Callout kind="error" title="Shopify connection failed">
            {test.error ?? `Missing permissions: ${test.missingScopes?.join(', ')}. Add them to a new app version, release it and approve the update in your store.`}
          </Callout>
        )}
      </div>
    </div>
  );
}

// ======================= eBay keys =======================

export function EbayKeysSection({ onSaved }: { onSaved?: () => void }) {
  const creds = useApi('/api/credentials');
  const { busy, run } = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const c = creds.data?.credentials;
  useEffect(() => {
    if (!c) return;
    setForm({
      ebayEnv: c.ebayEnv.value || 'production',
      ebayMarketplaceId: c.ebayMarketplaceId.value || 'EBAY_US',
      ebayClientId: c.ebayClientId.value,
      ebayClientSecret: c.ebayClientSecret.value,
      ebayRuName: c.ebayRuName.value,
    });
  }, [creds.data]);
  if (!c) return null;
  const callback = creds.data.callbackUrl as string;
  const httpsCallback = callback.startsWith('https://');
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
      <div className="space-y-4">
        <h3 className="text-sm font-semibold">How to get free eBay developer keys (10 minutes)</h3>
        <Steps>
          <li>
            Click <b>Join</b> on the <A href="https://developer.ebay.com/signin">eBay Developers Program</A> site to create a free developer account. It's separate from your seller login; you'll link your seller account in the next step. <b>New accounts are reviewed by eBay and can take a business day to be approved.</b> Meanwhile you can do the other setup steps.
          </li>
          <li>
            Go to <A href="https://developer.ebay.com/my/keys">Application Keys</A> and create a <b>Production</b> keyset. If eBay asks about <i>Marketplace Account Deletion</i> notifications, choose the option to <b>opt out</b>, since this app doesn't store eBay buyers' personal data.
          </li>
          <li>
            Copy the <b>App ID (Client ID)</b> and <b>Cert ID (Client Secret)</b>.
          </li>
          <li>
            Click <b>User Tokens</b>, then <b>Get a Token from eBay via Your Application</b>, then <b>Add eBay Redirect URL</b>. Fill in a display title and a privacy policy URL (your store's privacy page works).
            {httpsCallback ? (
              <> Set <b>Your auth accepted URL</b> to the address below:</>
            ) : (
              <> You can leave <b>Your auth accepted URL</b> as the default. You'll paste the link back here after signing in.</>
            )}
          </li>
          <li>
            Save, then copy the <b>RuName</b> (it looks like <code className="text-xs">YourName-AppName-PRD-abc123</code>).
          </li>
        </Steps>
        {httpsCallback && <CopyField value={callback} />}
      </div>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="eBay site">
            <select className="input" value={form.ebayMarketplaceId} disabled={c.ebayMarketplaceId.fromEnv} onChange={(e) => setForm({ ...form, ebayMarketplaceId: e.target.value })}>
              {Object.entries(creds.data.marketplaces).map(([k, v]: any) => (
                <option key={k} value={k}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Environment" hint="Use Sandbox only for testing">
            <select className="input" value={form.ebayEnv} disabled={c.ebayEnv.fromEnv} onChange={(e) => setForm({ ...form, ebayEnv: e.target.value })}>
              <option value="production">Production (real)</option>
              <option value="sandbox">Sandbox (test)</option>
            </select>
          </Field>
        </div>
        <Field label="App ID (Client ID)">
          <input className="input font-mono" value={form.ebayClientId ?? ''} disabled={c.ebayClientId.fromEnv} onChange={(e) => setForm({ ...form, ebayClientId: e.target.value })} />
        </Field>
        <Secret label="Cert ID (Client secret)" value={form.ebayClientSecret ?? ''} fromEnv={c.ebayClientSecret.fromEnv} onChange={(v) => setForm({ ...form, ebayClientSecret: v })} />
        <Field label="RuName (redirect URL name)">
          <input className="input font-mono" value={form.ebayRuName ?? ''} disabled={c.ebayRuName.fromEnv} onChange={(e) => setForm({ ...form, ebayRuName: e.target.value })} />
        </Field>
        <Button
          variant="primary"
          loading={busy === 'save'}
          onClick={() =>
            run(
              'save',
              async () => {
                await put('/api/credentials', form);
                creds.reload();
                onSaved?.();
              },
              'eBay keys saved',
            )
          }
        >
          <KeyRound className="size-4" /> Save eBay keys
        </Button>
      </div>
    </div>
  );
}

// ======================= eBay account connection =======================

export function EbayConnectSection({ onSaved }: { onSaved?: () => void }) {
  const status = useApi('/api/status');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [pasted, setPasted] = useState('');
  const [opened, setOpened] = useState(false);
  const e = status.data?.ebay;
  if (!e) return null;
  if (!e.configured) return <Callout kind="warn">Add your eBay developer keys first.</Callout>;
  const refresh = () => {
    status.reload();
    onSaved?.();
  };
  return (
    <div className="space-y-4">
      {e.connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <Badge color="green">
            <CheckCircle2 className="size-3" /> Connected{e.test?.username ? ` as ${e.test.username}` : ''}
          </Badge>
          {e.refreshExpires && <span className="text-xs text-zinc-500">Connection valid until {new Date(e.refreshExpires).toLocaleDateString()}</span>}
          <Button loading={busy === 'test'} onClick={() => run('test', () => post('/api/credentials/test', { which: 'ebay' }).then(refresh), 'eBay connection OK')}>
            <RefreshCw className="size-4" /> Test
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (await confirm({ title: 'Disconnect eBay?', body: 'Syncing stops until you reconnect.', confirm: 'Disconnect', danger: true })) run('dc', () => post('/api/ebay/disconnect').then(refresh));
            }}
          >
            <Unplug className="size-4" /> Disconnect
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">Sign in to eBay and approve access. The app needs permission to manage listings, read orders and fees, and see your seller standards.</p>
          <Button
            variant="primary"
            loading={busy === 'url'}
            onClick={() =>
              run('url', async () => {
                const r = await api('/api/ebay/connect-url');
                window.open(r.url, '_blank');
                setOpened(true);
              })
            }
          >
            <Plug className="size-4" /> Connect eBay account
          </Button>
          {opened && (
            <div className="space-y-2 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-white/15">
              <p className="text-sm">
                After you click <b>Agree</b> on eBay, you'll land on a page. If it doesn't come back here automatically, <b>copy the full address from your browser's address bar</b> and paste it below.
              </p>
              <div className="flex gap-2">
                <input className="input font-mono text-xs" placeholder="https://...?code=v%5E1.1%23..." value={pasted} onChange={(ev) => setPasted(ev.target.value)} />
                <Button variant="primary" loading={busy === 'code'} disabled={!pasted} onClick={() => run('code', () => post('/api/ebay/code', { code: pasted }).then(refresh), 'eBay connected!')}>
                  Finish
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {e.test && e.test.ok === false && <Callout kind="error">{e.test.error}</Callout>}
    </div>
  );
}

// ======================= Business policies & location =======================

export function PoliciesSection({ onSaved }: { onSaved?: () => void }) {
  const { settings, save, reload } = useSettings();
  const status = useApi('/api/status');
  const policies = useApi(status.data?.ebay?.connected ? '/api/ebay/policies' : null);
  const locations = useApi(status.data?.ebay?.connected ? '/api/ebay/locations' : null);
  const shopLocations = useApi(status.data?.shopify?.test?.ok ? '/api/shopify/locations' : null);
  const { busy, run } = useAction();
  const { draft, set, dirty } = useDraft(settings, ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId', 'merchantLocationKey', 'shopifyLocationId']);
  const confirm = useConfirm();
  const emptyLoc = { name: 'Main warehouse', postalCode: '', city: '', stateOrProvince: '' };
  /** null = closed, 'new' = creating, otherwise the merchantLocationKey being edited */
  const [locMode, setLocMode] = useState<string | null>(null);
  const [locData, setLocData] = useState(emptyLoc);
  const locList: any[] = locations.data?.locations ?? [];
  const country = status.data?.ebay?.country ?? 'US';

  if (!status.data?.ebay?.connected) return <Callout kind="warn">Connect your eBay account first.</Callout>;
  const optedOut = status.data.ebay.test?.policiesOptIn === false;
  const p = policies.data;
  const empty = p && (!p.fulfillment.length || !p.payment.length || !p.returns.length);
  const select = (key: string, label: string, list: { id: string; name: string }[] = [], hint?: string) => (
    <Field label={label} hint={hint}>
      <select className="input" value={draft[key] ?? ''} onChange={(e) => set(key, e.target.value)}>
        <option value="">Select...</option>
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="space-y-6">
      {(optedOut || policies.error) && (
        <Callout kind="warn" title="Business policies aren't enabled on your eBay account">
          <p>eBay requires business policies (shipping, payment and returns) for listings created through its API.</p>
          <Button className="mt-2" loading={busy === 'optin'} onClick={() => run('optin', () => post('/api/ebay/opt-in'), (r: any) => r.note)}>
            Enable business policies
          </Button>
        </Callout>
      )}
      {empty && (
        <Callout kind="info" title="Create your policies on eBay">
          In eBay Seller Hub, go to <b>Account</b>, then <b>Business policies</b>, and create at least one shipping, one payment and one return policy. Then click refresh.
        </Callout>
      )}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Default business policies</h3>
          <Button variant="ghost" onClick={() => policies.reload()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {select('fulfillmentPolicyId', 'Shipping policy', p?.fulfillment)}
          {select('paymentPolicyId', 'Payment policy', p?.payment)}
          {select('returnPolicyId', 'Return policy', p?.returns)}
        </div>
      </div>
      <div>
        <h3 className="mb-3 text-sm font-semibold">Where you ship from</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {select(
            'merchantLocationKey',
            'eBay inventory location',
            (locations.data?.locations ?? []).map((l: any) => ({ id: l.merchantLocationKey, name: `${l.name ?? l.merchantLocationKey}${l.location?.address?.postalCode ? ` (${l.location.address.postalCode})` : ''}` })),
            'Required by eBay. Create one below if the list is empty.',
          )}
          <Field label="Shopify location for eBay sales" hint="Where stock is deducted when something sells on eBay">
            <select className="input" value={draft.shopifyLocationId ?? ''} onChange={(e) => set('shopifyLocationId', e.target.value)}>
              <option value="">Automatic (location with the most stock)</option>
              {(shopLocations.data?.locations ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {!!locList.length && (
          <div className="mt-4 space-y-2">
            {locList.map((l: any) => {
              const a = l.location?.address ?? {};
              return (
                <div key={l.merchantLocationKey} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-4 py-3 dark:border-white/10">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {l.name ?? l.merchantLocationKey}
                      {draft.merchantLocationKey === l.merchantLocationKey && <Badge color="green">Default</Badge>}
                    </div>
                    <div className="text-xs text-zinc-500">{[a.city, [a.stateOrProvince, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => {
                        setLocMode(l.merchantLocationKey);
                        setLocData({ name: l.name ?? '', postalCode: a.postalCode ?? '', city: a.city ?? '', stateOrProvince: a.stateOrProvince ?? '' });
                      }}
                    >
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs text-rose-600 dark:text-rose-400"
                      loading={busy === `del-${l.merchantLocationKey}`}
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete "${l.name ?? l.merchantLocationKey}"?`, body: 'The location is removed from your eBay account. Locations used by published listings can only be edited.', confirm: 'Delete', danger: true }))) return;
                        run(
                          `del-${l.merchantLocationKey}`,
                          async () => {
                            await del(`/api/ebay/locations/${encodeURIComponent(l.merchantLocationKey)}`);
                            if (locMode === l.merchantLocationKey) setLocMode(null);
                            locations.reload();
                            reload();
                          },
                          'Location deleted',
                        );
                      }}
                    >
                      <Trash2 className="size-3.5" /> Delete
                    </Button>
                  </div>
                </div>
              );
            })}
            {!locMode && (
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => (setLocMode('new'), setLocData({ ...emptyLoc, name: '' }))}>
                <Plus className="size-3.5" /> Add location
              </Button>
            )}
          </div>
        )}
        {(locMode || (locations.data && !locList.length)) && (
          <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-white/15">
            <div className="mb-3 text-xs font-semibold text-zinc-500">{locMode && locMode !== 'new' ? 'Edit location' : 'New location'}</div>
            <div className="grid gap-3 sm:grid-cols-5">
              <input className="input sm:col-span-2" placeholder="Name" value={locData.name} onChange={(e) => setLocData({ ...locData, name: e.target.value })} />
              <input className="input" placeholder="ZIP / postal code" value={locData.postalCode} onChange={(e) => setLocData({ ...locData, postalCode: e.target.value })} />
              <input className="input" placeholder="City" value={locData.city} onChange={(e) => setLocData({ ...locData, city: e.target.value })} />
              <input className="input" placeholder="State (e.g. TX)" maxLength={country === 'US' ? 2 : undefined} value={locData.stateOrProvince} onChange={(e) => setLocData({ ...locData, stateOrProvince: country === 'US' ? e.target.value.toUpperCase() : e.target.value })} />
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                loading={busy === 'loc'}
                disabled={!locData.postalCode}
                onClick={() =>
                  run(
                    'loc',
                    async () => {
                      if (locMode && locMode !== 'new') await put(`/api/ebay/locations/${encodeURIComponent(locMode)}`, locData);
                      else {
                        const key = `${locData.name || 'location'}-${locData.postalCode}`.toLowerCase().replace(/[^\w-]+/g, '-');
                        const r = await post('/api/ebay/locations', { ...locData, key });
                        set('merchantLocationKey', r.key);
                        reload();
                      }
                      setLocMode(null);
                      locations.reload();
                    },
                    locMode && locMode !== 'new' ? 'Location updated' : 'Location created and set as default',
                  )
                }
              >
                {locMode && locMode !== 'new' ? 'Save location' : 'Create location'}
              </Button>
              {locMode && (
                <Button variant="ghost" onClick={() => setLocMode(null)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      <Button variant="primary" disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', () => save(draft).then(() => onSaved?.()), 'Saved')}>
        Save
      </Button>
    </div>
  );
}

// ======================= Pricing =======================

export function PricingSection({ onSaved }: { onSaved?: () => void }) {
  const { settings, save } = useSettings();
  const { busy, run } = useAction();
  const keys = ['markupMinPct', 'markupMaxPct', 'undercutAmount', 'charmPricing', 'autoReprice', 'useShopifySalePrice', 'priceGuardPct', 'ebayFeePct', 'ebayFixedFee', 'bestOfferDefault', 'bestOfferAutoAcceptPct', 'bestOfferAutoDecline', 'soldLookbackDays'];
  const { draft, set } = useDraft(settings, keys);
  if (!settings) return null;
  const n = (k: string, label: string, opts: { step?: number; suffix?: string; hint?: ReactNode } = {}) => (
    <Field label={label} hint={opts.hint}>
      <div className="relative">
        <input type="number" step={opts.step ?? 0.01} className="input pr-10" value={draft[k] ?? ''} onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))} />
        {opts.suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-zinc-400">{opts.suffix}</span>}
      </div>
    </Field>
  );
  const example = 100;
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-brand-500/10 to-violet-500/5 p-5 ring-1 ring-brand-500/15">
        <p className="text-sm">
          eBay prices are always kept between <b>+{draft.markupMinPct}%</b> and <b>+{draft.markupMaxPct}%</b> of your Shopify price. For example, a <b>${example}</b> Shopify item sells on eBay for{' '}
          <b>
            ${(example * (1 + draft.markupMinPct / 100)).toFixed(2)} to ${(example * (1 + draft.markupMaxPct / 100)).toFixed(2)}
          </b>
          {draft.autoReprice ? '. Within that range, the app positions you just below the cheapest identical brand-new listing.' : '.'}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {n('markupMinPct', 'Minimum markup', { suffix: '%', step: 0.5, hint: 'Price floor: never lower than this' })}
        {n('markupMaxPct', 'Maximum markup', { suffix: '%', step: 0.5, hint: 'Price ceiling: never higher than this' })}
        {n('undercutAmount', 'Undercut competitors by', { suffix: '$', hint: 'How much below the cheapest competitor' })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Toggle checked={!!draft.autoReprice} onChange={(v) => set('autoReprice', v)} label="Automatic repricing" description="Apply the market-based suggestion inside your range after each research run. Turn off to approve suggestions manually." />
        <Toggle checked={!!draft.charmPricing} onChange={(v) => set('charmPricing', v)} label="Charm pricing (.99)" description="Round to $x.99 when it still fits your range." />
        <Toggle checked={!!draft.useShopifySalePrice} onChange={(v) => set('useShopifySalePrice', v)} label="Follow Shopify sales" description="When a Shopify item is on sale (has a compare-at price), base the eBay price on the sale price. Turn off to use the regular price." />
        <Toggle checked={!!draft.bestOfferDefault} onChange={(v) => set('bestOfferDefault', v)} label="Best Offer on new listings" description="Only for single-variation listings (eBay doesn't allow Best Offer on variation listings)." />
      </div>
      {draft.bestOfferDefault && (
        <div className="grid gap-4 sm:grid-cols-2">
          {n('bestOfferAutoAcceptPct', 'Auto-accept offers at or above', { suffix: '%', step: 0.5, hint: 'Markup over the Shopify price' })}
          <Toggle checked={!!draft.bestOfferAutoDecline} onChange={(v) => set('bestOfferAutoDecline', v)} label="Auto-decline below your floor" description={`Offers below +${draft.markupMinPct}% are declined automatically.`} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-4">
        {n('ebayFeePct', 'eBay fee estimate', { suffix: '%', hint: 'Used until real fees arrive' })}
        {n('ebayFixedFee', 'Per-order fee', { suffix: '$' })}
        {n('priceGuardPct', 'Safety limit', { suffix: '%', step: 1, hint: 'Hold larger price jumps for review' })}
        {n('soldLookbackDays', 'Sold-price lookback', { suffix: 'days', step: 1, hint: '42 days = 6 weeks' })}
      </div>
      <p className="text-xs text-zinc-500">Shipping charges and label costs are set under Settings, Shipping.</p>
      <Button
        variant="primary"
        loading={busy === 'save'}
        onClick={() =>
          run(
            'save',
            async () => {
              await save(draft);
              await post('/api/settings/pricing-reviewed');
              onSaved?.();
            },
            'Pricing rules saved',
          )
        }
      >
        Save pricing rules
      </Button>
    </div>
  );
}

// ======================= Shipping (boxes for calculated shipping) =======================

type BoxDraft = { id: string; name: string; length: number | ''; width: number | ''; height: number | ''; unit: 'INCH' | 'CENTIMETER'; emptyWeightOz: number | ''; packageType: string };
const PACKAGE_TYPES: [string, string][] = [
  ['MAILING_BOX', 'Box'],
  ['PADDED_BAGS', 'Padded mailer / poly bag'],
  ['PACKAGE_THICK_ENVELOPE', 'Thick envelope'],
  ['LARGE_ENVELOPE', 'Large envelope / flat'],
  ['LETTER', 'Letter'],
  ['EXTRA_LARGE_PACK', 'Extra large pack'],
  ['BULKY_GOODS', 'Bulky goods'],
];

export function ShippingSection({ onSaved }: { onSaved?: () => void }) {
  const { settings, save } = useSettings();
  const { busy, run } = useAction();
  const [boxes, setBoxes] = useState<BoxDraft[]>([]);
  const { draft, set } = useDraft(settings, ['defaultBoxId', 'buyerShippingEstimate', 'avgShippingCost', 'comparisonZip']);
  useEffect(() => {
    if (settings) setBoxes(JSON.parse(settings.shippingBoxes || '[]'));
  }, [settings]);
  if (!settings) return null;
  const update = (i: number, k: keyof BoxDraft, v: unknown) => setBoxes((b) => b.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const add = () => setBoxes((b) => [...b, { id: `box-${Date.now().toString(36)}`, name: '', length: '', width: '', height: '', unit: 'INCH', emptyWeightOz: '', packageType: 'MAILING_BOX' }]);
  const valid = boxes.every((b) => b.name && Number(b.length) > 0 && Number(b.width) > 0 && Number(b.height) > 0);
  const num = (v: string) => (v === '' ? '' : Number(v));

  return (
    <div className="space-y-6">
      <Callout kind="info" title="Calculated shipping needs package size and weight">
        Shopify keeps each product's <b>weight</b> (the app reads it automatically), but apps can't read your Shopify saved package sizes, so enter your boxes here once. eBay gets the box size plus product weight plus empty box weight on every listing.
      </Callout>
      <div className="space-y-2">
        <span className="label">Your boxes and mailers</span>
        <div className="scrollbar-thin overflow-x-auto rounded-xl border border-zinc-200 dark:border-white/10">
          <table className="w-full min-w-[760px]">
            <thead className="border-b border-zinc-100 dark:border-white/[0.06]">
              <tr>
                <th className="table-head">Default</th>
                <th className="table-head">Name</th>
                <th className="table-head">Length</th>
                <th className="table-head">Width</th>
                <th className="table-head">Height</th>
                <th className="table-head">Unit</th>
                <th className="table-head">Empty weight (oz)</th>
                <th className="table-head">Type</th>
                <th className="table-head" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {boxes.map((b, i) => (
                <tr key={b.id}>
                  <td className="table-cell">
                    <input type="radio" className="size-4 accent-brand-500" checked={draft.defaultBoxId === b.id} onChange={() => set('defaultBoxId', b.id)} />
                  </td>
                  <td className="table-cell">
                    <input className="input w-36 py-1" placeholder="e.g. Small box" value={b.name} onChange={(e) => update(i, 'name', e.target.value)} />
                  </td>
                  {(['length', 'width', 'height'] as const).map((k) => (
                    <td key={k} className="table-cell">
                      <input type="number" step={0.1} min={0} className="input w-20 py-1" value={b[k]} onChange={(e) => update(i, k, num(e.target.value))} />
                    </td>
                  ))}
                  <td className="table-cell">
                    <select className="input w-20 py-1" value={b.unit} onChange={(e) => update(i, 'unit', e.target.value)}>
                      <option value="INCH">in</option>
                      <option value="CENTIMETER">cm</option>
                    </select>
                  </td>
                  <td className="table-cell">
                    <input type="number" step={0.1} min={0} className="input w-20 py-1" value={b.emptyWeightOz} onChange={(e) => update(i, 'emptyWeightOz', num(e.target.value))} />
                  </td>
                  <td className="table-cell">
                    <select className="input w-40 py-1" value={b.packageType} onChange={(e) => update(i, 'packageType', e.target.value)}>
                      {PACKAGE_TYPES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="table-cell">
                    <button className="text-xs text-rose-500 hover:underline" onClick={() => setBoxes((x) => x.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {!boxes.length && (
                <tr>
                  <td colSpan={9} className="table-cell text-center text-sm text-zinc-500">
                    No boxes yet. Copy them from Shopify: Settings, Shipping and delivery, Package sizes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Button onClick={add}>+ Add box</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Typical shipping buyers pay you" hint="Average calculated shipping charge. Used to compare your price + shipping against competitors, and for profit.">
          <input type="number" step={0.01} min={0} className="input" value={draft.buyerShippingEstimate ?? 0} onChange={(e) => set('buyerShippingEstimate', Number(e.target.value))} />
        </Field>
        <Field label="Your average label cost" hint="What postage costs you per order (for profit estimates).">
          <input type="number" step={0.01} min={0} className="input" value={draft.avgShippingCost ?? 0} onChange={(e) => set('avgShippingCost', Number(e.target.value))} />
        </Field>
        <Field label="Typical buyer ZIP code" hint="Competitors' calculated shipping is quoted to this ZIP. A big-city ZIP far from you (e.g. 10001) is a fair middle.">
          <input className="input" maxLength={10} placeholder="e.g. 10001" value={draft.comparisonZip ?? ''} onChange={(e) => set('comparisonZip', e.target.value.trim())} />
        </Field>
      </div>
      <Button
        variant="primary"
        disabled={!valid}
        loading={busy === 'save'}
        onClick={() =>
          run(
            'save',
            async () => {
              const clean = boxes.map((b) => ({ ...b, length: Number(b.length), width: Number(b.width), height: Number(b.height), emptyWeightOz: Number(b.emptyWeightOz || 0) }));
              const defaultBoxId = clean.some((b) => b.id === draft.defaultBoxId) ? draft.defaultBoxId : (clean[0]?.id ?? '');
              await save({ ...draft, defaultBoxId, shippingBoxes: JSON.stringify(clean) });
              onSaved?.();
            },
            'Shipping settings saved',
          )
        }
      >
        Save shipping settings
      </Button>
      {!valid && <p className="text-xs text-amber-600">Every box needs a name and all three dimensions.</p>}
    </div>
  );
}

// ======================= Inventory =======================

export function InventorySection() {
  const { settings, save } = useSettings();
  const { busy, run } = useAction();
  const { draft, set, dirty } = useDraft(settings, ['quantityBuffer', 'maxListQuantity', 'minShopifyQtyToList', 'lowStockThreshold', 'restockOnCancel', 'matchUnlinkedBySku']);
  if (!settings) return null;
  const n = (k: string, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min={0} className="input" value={draft[k] ?? 0} onChange={(e) => set(k, Number(e.target.value))} />
    </Field>
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {n('quantityBuffer', 'Safety buffer', 'Hide this many units from eBay to prevent overselling (5 in Shopify with buffer 1 shows 4 on eBay)')}
        {n('maxListQuantity', 'Max quantity shown', '0 = show everything. Showing fewer can create urgency.')}
        {n('minShopifyQtyToList', 'Minimum stock to list', 'Show 0 on eBay when Shopify has fewer than this')}
        {n('lowStockThreshold', 'Low-stock alert at', 'Alert when Shopify stock drops to this')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Toggle checked={!!draft.restockOnCancel} onChange={(v) => set('restockOnCancel', v)} label="Restock on cancellation" description="When an eBay order is cancelled, add the units back to Shopify." />
        <Toggle checked={!!draft.matchUnlinkedBySku} onChange={(v) => set('matchUnlinkedBySku', v)} label="Match other eBay sales by SKU" description="Also deduct Shopify stock for eBay sales of listings not created here, if the SKU matches." />
      </div>
      <Callout kind="info" title="Tip: turn on eBay's Out-of-stock control">
        In eBay Seller Hub, go to <b>Account</b>, then <b>Site preferences</b>, then <b>Selling preferences</b>, and turn on <b>Out-of-stock control</b>. Listings that reach 0 are then hidden instead of ended, so they keep their sales history and search ranking. The app relists ended items automatically either way.
      </Callout>
      <Button variant="primary" disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', () => save(draft), 'Saved')}>
        Save
      </Button>
    </div>
  );
}

// ======================= Sync, alerts & webhooks =======================

export function SyncSection() {
  const { settings, save } = useSettings();
  const { busy, run } = useAction();
  const status = useApi('/api/status');
  const keys = ['dryRun', 'syncIntervalMin', 'ordersIntervalMin', 'researchIntervalHours', 'verifyIntervalHours', 'staleDays', 'alertWebhookUrl', 'webhookPublicUrl', 'backupKeep'];
  const { draft, set, dirty } = useDraft(settings, keys);
  if (!settings) return null;
  const n = (k: string, label: string, suffix: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <div className="relative">
        <input type="number" min={0} className="input pr-14" value={draft[k] ?? 0} onChange={(e) => set(k, Number(e.target.value))} />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-zinc-400">{suffix}</span>
      </div>
    </Field>
  );
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <Toggle checked={!!draft.dryRun} onChange={(v) => set('dryRun', v)} label="Dry-run mode" description="Simulate everything without changing eBay or Shopify. Great for testing; check the Activity log to see what would happen." />
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {n('ordersIntervalMin', 'Check eBay sales every', 'min')}
          {n('syncIntervalMin', 'Push Shopify changes every', 'min')}
          {n('researchIntervalHours', 'Price research every', 'hours')}
          {n('verifyIntervalHours', 'Health check every', 'hours')}
          {n('staleDays', 'Stale after no sales for', 'days')}
          {n('backupKeep', 'Keep backups', 'days')}
        </div>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Phone / chat alerts</h3>
        <Field
          label="Alert webhook URL"
          hint={
            <>
              Get alerts for oversell risks, errors and price drops. Works with a free <A href="https://ntfy.sh">ntfy.sh</A> topic (e.g. https://ntfy.sh/my-secret-topic), a Discord webhook or a Slack webhook.
            </>
          }
        >
          <div className="flex gap-2">
            <input className="input" placeholder="https://ntfy.sh/your-topic" value={draft.alertWebhookUrl ?? ''} onChange={(e) => set('alertWebhookUrl', e.target.value)} />
            <Button
              loading={busy === 'testalert'}
              disabled={!draft.alertWebhookUrl}
              onClick={() =>
                run(
                  'testalert',
                  async () => {
                    if (dirty) await save(draft);
                    await post('/api/alerts/test');
                  },
                  'Test alert sent. Check your phone.',
                )
              }
            >
              Send test alert
            </Button>
          </div>
        </Field>
      </div>
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          Instant Shopify updates <Badge color="violet">Optional</Badge>
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          By default the app checks Shopify every few minutes. For near-instant updates, give the app a public HTTPS address, for example with a free{' '}
          <A href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/">Cloudflare Tunnel</A>, and register webhooks. The README has a step-by-step guide.
        </p>
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-md" placeholder="https://sync.yourdomain.com" value={draft.webhookPublicUrl ?? ''} onChange={(e) => set('webhookPublicUrl', e.target.value)} />
          <Button
            loading={busy === 'hooks'}
            disabled={!draft.webhookPublicUrl}
            onClick={() =>
              run(
                'hooks',
                async () => {
                  const r = await post('/api/shopify/webhooks/register', { url: draft.webhookPublicUrl });
                  status.reload();
                  const bad = r.results.filter((x: any) => !x.ok);
                  if (bad.length) throw new Error(bad.map((x: any) => `${x.topic}: ${x.message}`).join('; '));
                  return r;
                },
                'Webhooks registered',
              )
            }
          >
            Register webhooks
          </Button>
        </div>
      </div>
      <Button variant="primary" disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', () => save(draft), 'Saved')}>
        Save
      </Button>
    </div>
  );
}

// ======================= Rules (exclusions, exceptions, auto profiles) =======================

const RULE_FIELDS: [string, string][] = [
  ['title', 'Title'],
  ['tag', 'Tag'],
  ['type', 'Product type'],
  ['vendor', 'Vendor (brand)'],
  ['collection', 'Collection'],
];

type RuleRow = { field: string; value: string; profileId?: number };

function RuleRows({ rows, onChange, profiles }: { rows: RuleRow[]; onChange: (r: RuleRow[]) => void; profiles?: { id: number; name: string }[] }) {
  const upd = (i: number, k: keyof RuleRow, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select className="input w-40" value={r.field} onChange={(e) => upd(i, 'field', e.target.value)}>
            {RULE_FIELDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <span className="text-sm text-zinc-500">contains</span>
          <input className="input w-48" placeholder="e.g. preorder" value={r.value} onChange={(e) => upd(i, 'value', e.target.value)} />
          {profiles && (
            <>
              <span className="text-sm text-zinc-500">use profile</span>
              <select className="input w-48" value={r.profileId ?? ''} onChange={(e) => upd(i, 'profileId', Number(e.target.value))}>
                <option value="">Select...</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <button className="text-xs text-rose-500 hover:underline" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <Button onClick={() => onChange([...rows, { field: profiles ? 'type' : 'title', value: '' }])}>+ Add rule</Button>
    </div>
  );
}

export function RulesSection() {
  const { settings, save } = useSettings();
  const { busy, run } = useAction();
  const profiles = useApi('/api/profiles');
  const overrides = useApi('/api/rules/overrides');
  const [exclude, setExclude] = useState<RuleRow[]>([]);
  const [profRules, setProfRules] = useState<RuleRow[]>([]);
  const { draft, set } = useDraft(settings, ['allowTag', 'blockTag', 'autoListWhenEligible', 'autoPublish']);
  useEffect(() => {
    if (!settings) return;
    setExclude(JSON.parse(settings.excludeRules || '[]'));
    setProfRules(JSON.parse(settings.profileRules || '[]'));
  }, [settings]);
  if (!settings) return null;
  const list = (overrides.data?.overrides ?? []) as { product_id: string; mode: string; title: string | null }[];

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Don't list products that match</h3>
        <p className="text-sm text-zinc-500">
          Matching is "contains" and ignores case, spaces and dashes. Matching products can't be published. Live listings that start matching are paused on eBay (quantity 0, listing kept) and resume automatically when the rule no longer matches.
        </p>
        <RuleRows rows={exclude} onChange={setExclude} />
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Exceptions</h3>
        <p className="text-sm text-zinc-500">
          Set exceptions per product on the <b>Shopify products</b> page ("Allow anyway" / "Never list"), or with Shopify tags, which makes bulk changes easy in Shopify's bulk editor. Priority: never list → allow → rules above.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tag that always allows a product" hint="Lists it even if a rule above matches (e.g. a preorder you want on eBay)">
            <input className="input font-mono" value={draft.allowTag ?? ''} onChange={(e) => set('allowTag', e.target.value)} />
          </Field>
          <Field label="Tag that never lists a product" hint="Keeps it off eBay no matter what">
            <input className="input font-mono" value={draft.blockTag ?? ''} onChange={(e) => set('blockTag', e.target.value)} />
          </Field>
        </div>
        {list.length > 0 && (
          <div className="rounded-xl border border-zinc-200 dark:border-white/10">
            <div className="border-b border-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-500 uppercase dark:border-white/[0.06]">Exceptions set in the app</div>
            <ul className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {list.map((o) => (
                <li key={o.product_id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <Badge color={o.mode === 'allow' ? 'green' : 'red'}>{o.mode === 'allow' ? 'Allow anyway' : 'Never list'}</Badge>
                  <span className="min-w-0 flex-1 truncate">{o.title ?? o.product_id}</span>
                  <button className="text-xs text-zinc-500 hover:underline" onClick={() => run('ov', () => post(`/api/products/${encodeURIComponent(o.product_id)}/override`, { mode: null }).then(() => overrides.reload()), 'Exception removed')}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">When a product stops matching</h3>
        <Toggle checked={!!draft.autoListWhenEligible} onChange={(v) => set('autoListWhenEligible', v)} label="Automatically list it on eBay" description='E.g. when "preorder" is removed from the title. Only applies to products the app saw while they were excluded, so your whole catalog is never listed by surprise. Checked every 30 minutes.' />
        <Toggle checked={!!draft.autoPublish} onChange={(v) => set('autoPublish', v)} label="Publish right away (otherwise create a draft for review)" description="Listings that fail eBay's checks (e.g. a missing item specific) are kept as drafts, and you get an alert." />
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Pick a profile (category, policies, box) automatically</h3>
        <p className="text-sm text-zinc-500">The first matching rule decides the profile for new and auto-created listings, unless you pick a profile yourself.</p>
        <RuleRows rows={profRules} onChange={setProfRules} profiles={profiles.data?.profiles ?? []} />
        {!(profiles.data?.profiles ?? []).length && <p className="text-xs text-amber-600">Create a profile first under Listing profiles.</p>}
      </div>

      <Button
        variant="primary"
        loading={busy === 'save'}
        onClick={() =>
          run(
            'save',
            () =>
              save({
                ...draft,
                excludeRules: JSON.stringify(exclude.filter((r) => r.value.trim())),
                profileRules: JSON.stringify(profRules.filter((r) => r.value.trim() && r.profileId)),
              }),
            'Rules saved. They apply at the next sync.',
          )
        }
      >
        Save rules
      </Button>
    </div>
  );
}

// ======================= Listing templates =======================

export function TemplatesSection() {
  const { settings, save } = useSettings();
  const { busy, run } = useAction();
  const { draft, set, dirty } = useDraft(settings, ['titleTemplate', 'descriptionTemplate', 'showFullTitleInDescription', 'vendorMode', 'vendorAspectName', 'ignoredVendors']);
  const [sample, setSample] = useState('The Lord of the Rings: The Return of the King 4K Ultra HD Blu-ray Disc + Digital Code Limited Edition Steelbook Collection');
  const [preview, setPreview] = useState<{ title: string; shortened: boolean; removed: string[] } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => post('/api/tools/title-preview', { title: sample }).then(setPreview).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [sample]);
  if (!settings) return null;
  const fullLine = draft.showFullTitleInDescription && !/\{\{\s*full_title\s*\}\}/.test(draft.descriptionTemplate ?? '') ? `<p style="font-size:15px"><b>This listing is for:</b> ${sample}</p>` : '';
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What is your Shopify &quot;Vendor&quot; field?" hint="E.g. a boutique label buyers search for (HDzeta, WeET, Mantalab) is a brand.">
          <select className="input" value={draft.vendorMode ?? 'brand'} onChange={(e) => set('vendorMode', e.target.value)}>
            <option value="brand">The brand / label: use it as eBay Brand and for {'{brand}'} in titles</option>
            <option value="aspect">Something else: put it in another item specific</option>
            <option value="ignore">Not relevant for eBay: don't use it</option>
          </select>
        </Field>
        <Field label="Vendors buyers don't search for" hint="Comma-separated. These are never added to titles or item specifics.">
          <input className="input" value={draft.ignoredVendors ?? ''} onChange={(e) => set('ignoredVendors', e.target.value)} placeholder="Walmart, Best Buy, Target" />
        </Field>
        {draft.vendorMode === 'aspect' && (
          <Field label="Item specific name for the vendor" hint='e.g. "Edition" or "Studio" (must match the eBay category item specific)'>
            <input className="input" value={draft.vendorAspectName ?? ''} onChange={(e) => set('vendorAspectName', e.target.value)} />
          </Field>
        )}
      </div>
      <Field
        label="Title template"
        hint={`Placeholders: {brand} {title} {options} {type} {sku}. Default "{title} {options}" uses your Shopify title as-is (plus the variant for per-variant listings). Add {brand} to also put the vendor in the title; it's skipped if already there.${draft.vendorMode !== 'brand' ? ' {brand} is empty because Vendor isn\u2019t used as the brand.' : ''}`}
      >
        <input className="input font-mono" value={draft.titleTemplate ?? ''} onChange={(e) => set('titleTemplate', e.target.value)} />
      </Field>
      <div className="rounded-xl bg-zinc-50 p-4 dark:bg-white/[0.03]">
        <span className="label">How long titles are shortened for eBay (80 characters max)</span>
        <input className="input text-sm" value={sample} onChange={(e) => setSample(e.target.value)} />
        {preview && (
          <div className="mt-3 space-y-1 text-sm">
            <div>
              <span className="text-zinc-500">eBay title: </span>
              <b>{preview.title}</b> <span className="text-xs text-zinc-500">({preview.title.length}/80)</span>
            </div>
            {preview.removed.length > 0 && <div className="text-xs text-amber-600">Had to drop: {preview.removed.join(' ')}</div>}
            <p className="text-xs text-zinc-500">The app tidies spacing and separators, removes repeated words, uses common abbreviations (4K UHD, Ltd Ed, Coll, &amp;, w/), drops filler words, and only cuts words as a last resort. The full name always appears in the description.</p>
          </div>
        )}
      </div>
      <Toggle
        checked={!!draft.showFullTitleInDescription}
        onChange={(v) => set('showFullTitleInDescription', v)}
        label='Start the description with "This listing is for: <full Shopify product name>"'
        description="Keeps the complete product name on eBay even when the title had to be shortened. Or place {{full_title}} anywhere in your template yourself."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="Description template (HTML)" hint="Placeholders: {{full_title}} {{title}} {{description}}. Scripts and iframes are removed automatically because eBay blocks active content.">
          <textarea rows={16} className="input font-mono text-xs" value={draft.descriptionTemplate ?? ''} onChange={(e) => set('descriptionTemplate', e.target.value)} />
        </Field>
        <div>
          <span className="label">Preview</span>
          <iframe
            title="preview"
            sandbox=""
            className="h-[340px] w-full rounded-xl border border-zinc-200 bg-white dark:border-white/10"
            srcDoc={
              fullLine +
              (draft.descriptionTemplate ?? '')
                .replace(/\{\{\s*full_title\s*\}\}/g, sample)
                .replace(/\{\{\s*title\s*\}\}/g, sample)
                .replace(/\{\{\s*description\s*\}\}/g, '<p>Your Shopify product description appears here.</p>')
            }
          />
        </div>
      </div>
      <Button variant="primary" disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', () => save(draft), 'Templates saved')}>
        Save templates
      </Button>
    </div>
  );
}

// ======================= Security =======================

export function SecuritySection() {
  const { busy, run } = useAction();
  const [form, setForm] = useState({ current: '', password: '' });
  return (
    <div className="max-w-sm space-y-4">
      <Field label="Current password">
        <input type="password" className="input" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
      </Field>
      <Field label="New password" hint="At least 8 characters">
        <input type="password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </Field>
      <Button variant="primary" loading={busy === 'pw'} onClick={() => run('pw', () => post('/api/password', form).then(() => setForm({ current: '', password: '' })), 'Password changed')}>
        Change password
      </Button>
    </div>
  );
}
