const { whoDbJson } = require('./whodb-auth');

// These fixed queries follow cli/internal/platform/{operations,read_operations,ontology_query}.go.
// The model supplies variables only: it can never supply a GraphQL document or mutation.
const operations = {
  orgs: { field: 'MyOrganizations', query: 'query HabibiOrganizations { MyOrganizations { id name slug } }', key: 'orgs' },
  projects: { field: 'Projects', query: 'query HabibiProjects($orgId: ID!) { Projects(orgId: $orgId) { id name slug description } }', key: 'projects' },
  apps: { field: 'ProjectApps', query: 'query HabibiApps($projectId: ID!) { ProjectApps(projectId: $projectId) { id name description } }', key: 'apps' },
  ontology_describe: { field: 'OntologyDescribe', query: 'query HabibiOntologyDescribe($projectId: ID!, $input: OntologyDescribeInput!) { OntologyDescribe(projectId: $projectId, input: $input) { text entities { name displayName description primaryKey fields { name displayName description type required searchable sortable } } relationships { name source sourceField target targetField cardinality kind } } }' },
  ontology_query: { field: 'OntologyQuery', query: 'query HabibiOntologyQuery($projectId: ID!, $input: OntologyQueryInput!) { OntologyQuery(projectId: $projectId, input: $input) { columns rows total partial scannedRows } }' },
};
const toolDefinitions = Object.keys(operations).map((id) => ({
  name: `whodb_platform_${id}`, annotations: { readOnlyHint: true },
  description: id === 'ontology_query' ? 'Read bounded ontology rows/aggregates. input.entity is a catalog entity name; whereJson is a JSON-encoded filter object. Max 100 rows and 5000 scanned rows.' : `Read WhoDB ${id.replaceAll('_', ' ')} in the selected workspace.`,
  inputSchema: id === 'ontology_query' ? {
    type: 'object', required: ['input'], properties: { input: { type: 'object', required: ['entity'], properties: {
      entity: { type: 'string' }, whereJson: { type: 'string' }, search: { type: 'string' },
      searchFields: { type: 'array', items: { type: 'string' } }, groupBy: { type: 'array', items: { type: 'string' } },
      metrics: { type: 'array', items: { type: 'object', properties: { op: { enum: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] }, field: { type: 'string' }, as: { type: 'string' } } } },
      sort: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, desc: { type: 'boolean' } } } },
    } } },
  } : { type: 'object', properties: {} },
}));

/** In-process CLI-compatible platform reads, with no resident CLI or polling worker. */
function createWhoDbPlatform({ auth, fetcher = fetch }) {
  return {
    async readSession(host, run) {
      return run({ tools: toolDefinitions, call: async (name, args = {}) => {
        const id = name.replace(/^whodb_platform_/, '');
        const operation = operations[id];
        if (!Object.hasOwn(operations, id)) throw new Error('WhoDB operation is not read-only.');
        const workspace = args.workspace || {};
        if (workspace.host !== host) throw new Error('WhoDB workspace host mismatch.');
        if (id !== 'orgs' && !workspace.org) throw new Error('Choose an organization.');
        if (!['orgs', 'projects'].includes(id) && !workspace.project) throw new Error('Choose a project.');
        const variables = id === 'projects' ? { orgId: workspace.org } : id === 'orgs' ? {} : { projectId: workspace.project };
        if (id === 'ontology_describe') variables.input = { entities: [], includeInferred: false };
        if (id === 'ontology_query') {
          const input = args.input;
          if (!input || typeof input.entity !== 'string' || !input.entity || input.entity.length > 160) throw new Error('Choose a catalog entity.');
          variables.input = { entity: input.entity, pageSize: 100, offset: 0, scanLimit: 5000 };
          for (const key of ['whereJson', 'search', 'searchFields', 'groupBy', 'metrics', 'sort']) {
            if (input[key] !== undefined) variables.input[key] = input[key];
          }
          if (JSON.stringify(variables.input).length > 24_000) throw new Error('WhoDB query is too large.');
        }
        const request = async () => whoDbJson(fetcher, `${host}/api/query`, {
          method: 'POST', headers: {
            Authorization: `Bearer ${await auth.token(host)}`, 'Content-Type': 'application/json',
            'X-Whodb-Client': 'habibi',
            ...(workspace.org ? { 'X-Whodb-Org-Id': workspace.org } : {}),
            ...(workspace.project ? { 'X-Whodb-Project-Id': workspace.project } : {}),
          }, body: JSON.stringify({ query: operation.query, variables }),
        });
        const data = await request();
        if (data.errors?.length || !data.data || data.data[operation.field] == null) throw new Error('WhoDB denied or could not complete this read.');
        const value = data.data[operation.field];
        return { structuredContent: operation.key ? { [operation.key]: value } : { data: value } };
      } });
    },
  };
}
module.exports = { createWhoDbPlatform };
