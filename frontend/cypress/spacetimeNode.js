const normalizeSqlStatement = (statement) => {
  if (!statement || typeof statement !== 'object') {
    return [];
  }

  const rows = Array.isArray(statement.rows) ? statement.rows : [];
  const schema = statement.schema && typeof statement.schema === 'object'
    ? statement.schema
    : {};
  const elements = Array.isArray(schema?.Product?.elements)
    ? schema.Product.elements
    : Array.isArray(schema.elements)
      ? schema.elements
      : [];

  const columns = elements.map((element, index) => {
    if (typeof element?.name === 'string') {
      return element.name;
    }
    if (typeof element?.name?.some === 'string') {
      return element.name.some;
    }
    if (typeof element?.name?.Some === 'string') {
      return element.name.Some;
    }
    return `col_${index}`;
  });

  return rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return row;
    }
    if (!Array.isArray(row)) {
      return row;
    }

    return columns.reduce((normalized, columnName, index) => {
      normalized[columnName] = row[index];
      return normalized;
    }, {});
  });
};

const normalizeSqlRows = (payload) => {
  if (payload == null) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((statement) => normalizeSqlStatement(statement));
  }

  if (Array.isArray(payload.rows)) {
    return payload.rows;
  }

  if (payload.result != null) {
    return normalizeSqlRows(payload.result);
  }

  if (payload.data != null) {
    return normalizeSqlRows(payload.data);
  }

  if (payload.records != null) {
    return normalizeSqlRows(payload.records);
  }

  return [];
};

const getTaskConfig = (overrides = {}) => {
  const httpUrl = String(
    overrides.httpUrl
    || process.env.CYPRESS_SPACETIME_HTTP_URL
    || process.env.SPACETIMEDB_HTTP_URL
    || 'https://maincloud.spacetimedb.com'
  ).replace(/\/$/, '');

  const dbName = overrides.dbName
    || process.env.CYPRESS_SPACETIME_DB_NAME
    || process.env.SPACETIMEDB_DB_NAME
    || '';
  const dbId = overrides.dbId
    || process.env.CYPRESS_SPACETIME_DB_ID
    || process.env.SPACETIMEDB_DB_ID
    || '';
  const serviceToken = overrides.serviceToken
    || process.env.CYPRESS_SPACETIME_SERVICE_TOKEN
    || process.env.SPACETIMEDB_SERVICE_TOKEN
    || '';

  return {
    httpUrl,
    dbIdentifier: dbName || dbId,
    serviceToken,
  };
};

const parseJson = async (response) => {
  const rawText = await response.text();
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
};

const splitSqlStatements = (sql) => (
  String(sql)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
);

const executeSqlStatement = async ({ httpUrl, dbIdentifier, serviceToken, sql }) => {
  const response = await fetch(
    `${httpUrl}/v1/database/${encodeURIComponent(dbIdentifier)}/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: sql,
    }
  );

  const payload = await parseJson(response);
  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.message || payload?.error || payload?.detail || response.statusText;
    throw new Error(`SpaceTime SQL query failed (${response.status}): ${message}`);
  }

  return normalizeSqlRows(payload);
};

const runSpacetimeSql = async ({ sql, ...overrides } = {}) => {
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    throw new Error('The `spacetimeSql` Cypress task requires a non-empty SQL string.');
  }

  const { httpUrl, dbIdentifier, serviceToken } = getTaskConfig(overrides);

  if (!dbIdentifier) {
    throw new Error('No SpaceTime DB name or ID is configured for the `spacetimeSql` Cypress task.');
  }
  if (!serviceToken) {
    throw new Error('No SpaceTime service token is configured for the `spacetimeSql` Cypress task.');
  }

  const statements = splitSqlStatements(sql);
  const rows = [];

  for (const statement of statements) {
    const statementRows = await executeSqlStatement({
      httpUrl,
      dbIdentifier,
      serviceToken,
      sql: statement,
    });
    rows.push(...statementRows);
  }

  return rows;
};

export const registerSpacetimeTasks = (on) => {
  on('task', {
    spacetimeSql: runSpacetimeSql,
  });
};
