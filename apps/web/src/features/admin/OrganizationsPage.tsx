import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import catalogStyles from "../catalog/Catalog.module.css";
import { organizationTypeLabel, useOrganizations } from "./admin-api";
import { ActiveBadge, ListPagination } from "./AdminShared";
import { useListParams } from "./useListParams";
import styles from "./Admin.module.css";

export function OrganizationsPage() {
  const { params, change, clear } = useListParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const organizations = useOrganizations(params.toString());
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    change("q", search);
  };
  const clearFilters = () => {
    clear();
    setSearch("");
  };

  return (
    <>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>ADMINISTRATION</p>
          <h1>Organizations</h1>
          <p className={catalogStyles.muted}>The distributor and its retailer stores. Deactivating a store signs out all of its users.</p>
        </div>
        <Link className={catalogStyles.primary} to="/admin/organizations/new" data-test="organization-create">
          New organization
        </Link>
      </div>

      <div className={catalogStyles.filters}>
        <form onSubmit={submitSearch} className={catalogStyles.search}>
          <label htmlFor="organization-search">Search organizations</label>
          <div>
            <input
              id="organization-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Organization name"
              maxLength={120}
              data-test="organization-search"
            />
            <button className={catalogStyles.secondary} data-test="organization-search-submit">
              Search
            </button>
          </div>
        </form>
        <label>
          Type
          <select value={params.get("type") ?? ""} onChange={(event) => change("type", event.target.value)} data-test="organization-type-filter">
            <option value="">All types</option>
            <option value="retailer">Retailers</option>
            <option value="distributor">Distributor</option>
          </select>
        </label>
        <label>
          Status
          <select value={params.get("status") ?? "all"} onChange={(event) => change("status", event.target.value)} data-test="organization-status-filter">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {organizations.isPending && <p role="status">Loading organizations…</p>}
      {organizations.isError && (
        <div role="alert" className={catalogStyles.error}>
          Could not load organizations.{" "}
          <button className={catalogStyles.textButton} onClick={clearFilters}>
            Clear filters
          </button>
          <button className={catalogStyles.textButton} data-test="organization-retry" onClick={() => void organizations.refetch()}>
            Try again
          </button>
        </div>
      )}
      {organizations.data && (
        <>
          <p className={catalogStyles.results} role="status" data-test="organization-total">
            {organizations.data.total} {organizations.data.total === 1 ? "organization" : "organizations"}
          </p>
          {!organizations.data.items.length ? (
            <div className={catalogStyles.empty}>
              <h2>No organizations found</h2>
              <p>Try another search or change the filters.</p>
              <button className={catalogStyles.secondary} data-test="organization-clear-filters" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className={catalogStyles.tableScroll}>
              <table className={catalogStyles.table}>
                <caption className={catalogStyles.srOnly}>Organizations by name</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th className={styles.number}>Active users</th>
                    <th className={styles.number}>All users</th>
                  </tr>
                </thead>
                <tbody>
                  {organizations.data.items.map((organization) => (
                    <tr key={organization.id} data-test="organization-row" data-organization-name={organization.name}>
                      <td>
                        <Link to={`/admin/organizations/${organization.id}`} data-test="organization-link">
                          {organization.name}
                        </Link>
                      </td>
                      <td>{organizationTypeLabel(organization.type)}</td>
                      <td>
                        <ActiveBadge active={organization.isActive} test="organization-status" />
                      </td>
                      <td className={styles.number}>{organization.activeUserCount}</td>
                      <td className={styles.number}>{organization.userCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ListPagination
            label="Organization pages"
            prefix="organization"
            page={organizations.data.page}
            pageSize={organizations.data.pageSize}
            total={organizations.data.total}
            onChange={change}
          />
        </>
      )}
    </>
  );
}
