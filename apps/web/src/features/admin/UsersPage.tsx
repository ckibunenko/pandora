import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { roleLabel } from "../auth/session";
import catalogStyles from "../catalog/Catalog.module.css";
import { useOrganizations, useUsers } from "./admin-api";
import { ActiveBadge, ListPagination } from "./AdminShared";
import { useListParams } from "./useListParams";

export function UsersPage() {
  const { params, change, clear } = useListParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const users = useUsers(params.toString());
  const organizations = useOrganizations("pageSize=100");
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    change("q", search);
  };
  const clearFilters = () => {
    clear();
    setSearch("");
  };
  const selectedOrganization = params.get("organizationId") ?? "";

  return (
    <>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>ADMINISTRATION</p>
          <h1>Users</h1>
          <p className={catalogStyles.muted}>Accounts for distributor staff and retailer stores.</p>
        </div>
        <Link
          className={catalogStyles.primary}
          to={selectedOrganization ? `/admin/users/new?organizationId=${selectedOrganization}` : "/admin/users/new"}
          data-test="user-create"
        >
          New user
        </Link>
      </div>

      <div className={catalogStyles.filters}>
        <form onSubmit={submitSearch} className={catalogStyles.search}>
          <label htmlFor="user-search">Search users</label>
          <div>
            <input
              id="user-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Email or name"
              maxLength={254}
              data-test="user-search"
            />
            <button className={catalogStyles.secondary} data-test="user-search-submit">
              Search
            </button>
          </div>
        </form>
        <label>
          Organization
          <select value={selectedOrganization} onChange={(event) => change("organizationId", event.target.value)} data-test="user-organization-filter">
            <option value="">All organizations</option>
            {organizations.data?.items.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select value={params.get("role") ?? ""} onChange={(event) => change("role", event.target.value)} data-test="user-role-filter">
            <option value="">All roles</option>
            <option value="retailer">{roleLabel("retailer")}</option>
            <option value="operator">{roleLabel("operator")}</option>
            <option value="administrator">{roleLabel("administrator")}</option>
          </select>
        </label>
        <label>
          Status
          <select value={params.get("status") ?? "all"} onChange={(event) => change("status", event.target.value)} data-test="user-status-filter">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {users.isPending && <p role="status">Loading users…</p>}
      {users.isError && (
        <div role="alert" className={catalogStyles.error}>
          Could not load users.{" "}
          <button className={catalogStyles.textButton} onClick={clearFilters}>
            Clear filters
          </button>
          <button className={catalogStyles.textButton} data-test="user-retry" onClick={() => void users.refetch()}>
            Try again
          </button>
        </div>
      )}
      {users.data && (
        <>
          <p className={catalogStyles.results} role="status" data-test="user-total">
            {users.data.total} {users.data.total === 1 ? "user" : "users"}
          </p>
          {!users.data.items.length ? (
            <div className={catalogStyles.empty}>
              <h2>No users found</h2>
              <p>Try another search or change the filters.</p>
              <button className={catalogStyles.secondary} data-test="user-clear-filters" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className={catalogStyles.tableScroll}>
              <table className={catalogStyles.table}>
                <caption className={catalogStyles.srOnly}>Users by email</caption>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Organization</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => (
                    <tr key={user.id} data-test="user-row" data-email={user.email}>
                      <td>
                        <Link to={`/admin/users/${user.id}`} data-test="user-link">
                          {user.email}
                        </Link>
                      </td>
                      <td>{user.displayName}</td>
                      <td>{roleLabel(user.role)}</td>
                      <td>
                        {user.organization.name}
                        {!user.organization.isActive && " (inactive organization)"}
                      </td>
                      <td>
                        <ActiveBadge active={user.isActive} test="user-status" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ListPagination
            label="User pages"
            prefix="user"
            page={users.data.page}
            pageSize={users.data.pageSize}
            total={users.data.total}
            onChange={change}
          />
        </>
      )}
    </>
  );
}
