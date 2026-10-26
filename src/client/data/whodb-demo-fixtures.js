export const demoWhoDbScope = {
  ok: true,
  org: { id: 'acme', name: 'Acme Retail', role: 'Admin' },
  orgs: [{ id: 'acme', name: 'Acme Retail', role: 'Admin' }, { id: 'northwind', name: 'Northwind Logistics', role: 'Editor' }, { id: 'clidey', name: 'Clidey Labs', role: 'Owner' }],
  projects: [{ id: 'storefront', name: 'Storefront', description: '2 apps' }, { id: 'supply', name: 'Supply chain', description: '1 app' }, { id: 'care', name: 'Customer care', description: '1 app' }],
};
export const demoWhoDbApps = [
  { id: 'orders', name: 'Order Desk', description: 'Orders, returns, and refunds', projectName: 'Storefront', url: '/apps/orders' },
  { id: 'inventory', name: 'Inventory Planner', description: 'Stock across 14 warehouses', projectName: 'Supply chain', url: '/apps/inventory' },
  { id: 'pulse', name: 'Store Pulse', description: 'Daily store KPIs', projectName: 'Storefront', url: '/apps/pulse' },
  { id: 'returns', name: 'Returns Triage', description: 'Returns by reason and SKU', projectName: 'Customer care', url: '/apps/returns' },
];
export const demoWhoDbResult = {
  ok: true, readOnly: true, partial: false,
  answer: '312 orders in Acme Retail shipped after their promised date this week. Leeds accounts for 71% of them, mostly from Tuesday and Wednesday.',
  trace: [{ tool: 'whodb_platform_ontology_describe', project: 'Storefront' }, { tool: 'whodb_platform_ontology_follow_link', project: 'Storefront' }, { tool: 'whodb_platform_ontology_aggregate', project: 'Storefront' }],
  datasets: [{ title: 'Late shipments by warehouse this week', project: 'Storefront', columns: ['Warehouse', 'Late'], rows: [['Leeds', 221], ['Bristol', 54], ['Glasgow', 37]], sql: "SELECT warehouse, COUNT(*) AS late\nFROM shipments\nWHERE shipped_at > promised_at\n  AND shipped_at >= DATE '2026-10-19'\nGROUP BY warehouse;", provenance: ['postgres.shipments', 'netsuite.locations'], partial: false, warnings: [] }],
};
