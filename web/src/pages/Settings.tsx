import { Download } from 'lucide-react';
import { useState } from 'react';
import { Card, PageHeader, Tabs } from '../ui.tsx';
import { EbayConnectSection, EbayKeysSection, InventorySection, PoliciesSection, PricingSection, SecuritySection, ShippingSection, ShopifySection, SyncSection, TemplatesSection } from './sections.tsx';

type Tab = 'connections' | 'ebay' | 'shipping' | 'pricing' | 'inventory' | 'templates' | 'sync' | 'security';

export function SettingsPage({ onChange }: { onChange: () => void }) {
  const initial = (new URLSearchParams(location.search).get('tab') as Tab) || 'connections';
  const [tab, setTab] = useState<Tab>(initial);
  const change = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `/settings?tab=${t}`);
  };
  return (
    <div>
      <PageHeader
        title="Settings"
        actions={
          <a href="/api/export/listings.csv" className="btn-secondary">
            <Download className="size-4" /> Export listings CSV
          </a>
        }
      />
      <div className="mb-6">
        <Tabs
          value={tab}
          onChange={change}
          tabs={[
            { value: 'connections', label: 'Connections' },
            { value: 'ebay', label: 'eBay defaults' },
            { value: 'shipping', label: 'Shipping' },
            { value: 'pricing', label: 'Pricing' },
            { value: 'inventory', label: 'Inventory' },
            { value: 'templates', label: 'Templates' },
            { value: 'sync', label: 'Sync & alerts' },
            { value: 'security', label: 'Security' },
          ]}
        />
      </div>
      <div className="space-y-6">
        {tab === 'connections' && (
          <>
            <Card title="Shopify">
              <ShopifySection onSaved={onChange} />
            </Card>
            <Card title="eBay developer keys">
              <EbayKeysSection onSaved={onChange} />
            </Card>
            <Card title="eBay seller account">
              <EbayConnectSection onSaved={onChange} />
            </Card>
          </>
        )}
        {tab === 'ebay' && (
          <Card title="Business policies & locations" description="Defaults for new listings. Profiles can override them.">
            <PoliciesSection onSaved={onChange} />
          </Card>
        )}
        {tab === 'shipping' && (
          <Card title="Shipping boxes & costs" description="Used for eBay calculated shipping, price comparisons and profit.">
            <ShippingSection onSaved={onChange} />
          </Card>
        )}
        {tab === 'pricing' && (
          <Card title="Pricing rules">
            <PricingSection onSaved={onChange} />
          </Card>
        )}
        {tab === 'inventory' && (
          <Card title="Inventory rules">
            <InventorySection />
          </Card>
        )}
        {tab === 'templates' && (
          <Card title="Default listing templates" description="Profiles can override these.">
            <TemplatesSection />
          </Card>
        )}
        {tab === 'sync' && (
          <Card title="Sync, alerts & webhooks">
            <SyncSection />
          </Card>
        )}
        {tab === 'security' && (
          <Card title="Dashboard password">
            <SecuritySection />
          </Card>
        )}
      </div>
    </div>
  );
}
