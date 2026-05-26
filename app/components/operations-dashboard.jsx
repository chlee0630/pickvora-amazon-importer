/* eslint-disable react/prop-types */

const cardStyle = {
  minWidth: "150px",
  flex: "1 1 150px",
  padding: "12px 14px",
  border: "1px solid #e1e3e5",
  borderRadius: "8px",
  background: "white",
};

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const cellStyle = {
  padding: "8px 10px",
  borderBottom: "1px solid #e1e3e5",
  verticalAlign: "top",
};

export function SummaryGrid({ items }) {
  return (
    <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap" }}>
      {items.map((item) => (
        <div key={item.label} style={cardStyle}>
          <div style={{ fontSize: "22px", fontWeight: "700", color: item.tone === "critical" ? "#8e1f0b" : "#202223" }}>
            {item.value}
          </div>
          <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
            {item.label}
          </div>
        </div>
      ))}
    </s-stack>
  );
}

export function DashboardFilters({ filters }) {
  return (
    <s-section heading="Filters">
      <form method="get">
        <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap", alignItems: "end" }}>
          <label style={filterLabelStyle}>
            Order status
            <select name="orderStatus" defaultValue={filters.orderStatus} style={filterInputStyle}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="complete">Complete</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label style={filterLabelStyle}>
            Queue status
            <select name="queueStatus" defaultValue={filters.queueStatus} style={filterInputStyle}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="complete">Complete</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label style={filterLabelStyle}>
            Failure category
            <select name="failureCategory" defaultValue={filters.failureCategory} style={filterInputStyle}>
              <option value="">All</option>
              <option value="retryable">Retryable</option>
              <option value="permanent">Permanent</option>
            </select>
          </label>
          <label style={filterLabelStyle}>
            From
            <input name="from" type="date" defaultValue={dateInputValue(filters.from)} style={filterInputStyle} />
          </label>
          <label style={filterLabelStyle}>
            To
            <input name="to" type="date" defaultValue={dateInputValue(filters.to)} style={filterInputStyle} />
          </label>
          <button type="submit" style={buttonStyle}>Apply</button>
          <s-button href="/app/operations" variant="tertiary">Reset</s-button>
        </s-stack>
      </form>
    </s-section>
  );
}

export function DataTable({ columns, rows, emptyMessage }) {
  if (!rows.length) {
    return <s-paragraph>{emptyMessage}</s-paragraph>;
  }

  return (
    <s-box padding="none" borderWidth="base" borderRadius="base" background="default">
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: "#f6f6f7" }}>
              {columns.map((column) => (
                <th key={column.key} style={{ ...cellStyle, textAlign: "left", fontWeight: "700" }}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td key={column.key} style={cellStyle}>
                    {column.render ? column.render(row) : valueOrDash(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </s-box>
  );
}

export function PaginationControls({ filters, total }) {
  const page = filters.page;
  const pageSize = filters.pageSize;
  const hasPrevious = page > 1;
  const hasNext = page * pageSize < total;
  const previousHref = buildPageHref(filters, page - 1);
  const nextHref = buildPageHref(filters, page + 1);

  return (
    <s-stack direction="inline" gap="base" style={{ justifyContent: "space-between", marginTop: "12px", flexWrap: "wrap" }}>
      <s-text>Total rows: {total}</s-text>
      <s-stack direction="inline" gap="base">
        <s-button href={hasPrevious ? previousHref : undefined} disabled={!hasPrevious} variant="tertiary">
          Previous
        </s-button>
        <s-button href={hasNext ? nextHref : undefined} disabled={!hasNext} variant="tertiary">
          Next
        </s-button>
      </s-stack>
    </s-stack>
  );
}

export function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

export function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

export function formatDuration(value) {
  if (!value) return "0 ms";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function buildPageHref(filters, page) {
  const params = new URLSearchParams();
  for (const key of ["orderStatus", "queueStatus", "failureCategory"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.from) params.set("from", dateInputValue(filters.from));
  if (filters.to) params.set("to", dateInputValue(filters.to));
  params.set("page", String(page));
  params.set("pageSize", String(filters.pageSize));
  return `/app/operations?${params.toString()}`;
}

function dateInputValue(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

const filterLabelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  minWidth: "140px",
  fontSize: "12px",
  color: "#6d7175",
};

const filterInputStyle = {
  minHeight: "34px",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  padding: "6px 8px",
  background: "white",
  color: "#202223",
};

const buttonStyle = {
  minHeight: "34px",
  padding: "6px 14px",
  border: "1px solid #008060",
  borderRadius: "6px",
  background: "#008060",
  color: "white",
  cursor: "pointer",
};
