import { useMutation } from "@tanstack/react-query";
import { createOrganizationSchema, type AdminOrganization, type UpdateOrganization } from "@pandora/contracts";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { roleLabel } from "../auth/session";
import catalogStyles from "../catalog/Catalog.module.css";
import { CatalogFormField } from "../catalog/CatalogFormField";
import { errorFields, mutationMessage } from "../catalog/form-errors";
import {
  createOrganization,
  organizationTypeLabel,
  updateOrganization,
  useAdminExpiredSession,
  useAdminRefresh,
  useOrganization,
  useUsers,
} from "./admin-api";
import { ActiveBadge } from "./AdminShared";
import styles from "./Admin.module.css";

function OrganizationForm({ organization }: { organization?: AdminOrganization }) {
  const [name, setName] = useState(organization?.name ?? "");
  const [isActive, setIsActive] = useState(organization?.isActive ?? true);
  const [localError, setLocalError] = useState<string>();
  const refresh = useAdminRefresh();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: (input: { name: string }) => {
      if (!organization) return createOrganization(input);
      const patch: UpdateOrganization = {};
      if (input.name !== organization.name) patch.name = input.name;
      if (isActive !== organization.isActive) patch.isActive = isActive;
      return Object.keys(patch).length ? updateOrganization(organization.id, patch) : Promise.resolve(organization);
    },
    onSuccess: async (saved) => {
      setName(saved.name);
      setIsActive(saved.isActive);
      await refresh();
      if (!organization) void navigate(`/admin/organizations/${saved.id}`, { replace: true });
    },
  });
  useAdminExpiredSession(save.error);
  const errors = { ...errorFields(save.error), ...(localError ? { name: localError } : {}) };
  const isDistributor = organization?.type === "distributor";
  const deactivating = organization?.isActive === true && !isActive;

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createOrganizationSchema.safeParse({ name });
    setLocalError(parsed.success ? undefined : "Enter a name of 1 to 120 characters.");
    if (parsed.success) save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} className={catalogStyles.form} noValidate data-test="organization-form">
      <h2>{organization ? "Organization details" : "New retailer organization"}</h2>
      {save.isError && (
        <p role="alert" className={catalogStyles.error} data-test="organization-error">
          {mutationMessage(save.error)}
        </p>
      )}
      {localError && (
        <p role="alert" className={catalogStyles.error}>
          Please correct the highlighted fields.
        </p>
      )}
      {save.isSuccess && organization && (
        <p role="status" className={catalogStyles.success} data-test="organization-saved">
          Organization saved.
        </p>
      )}
      <fieldset disabled={save.isPending} className={catalogStyles.fields}>
        <CatalogFormField name="organization-name" label="Organization name" value={name} onChange={setName} maxLength={120} error={errors.name} />
        {organization ? (
          <>
            <label className={catalogStyles.checkbox}>
              <input
                type="checkbox"
                checked={isActive}
                disabled={isDistributor}
                aria-describedby="organization-active-help"
                onChange={(event) => setIsActive(event.target.checked)}
                data-test="organization-active"
              />
              Active organization
            </label>
            <p id="organization-active-help" className={catalogStyles.muted}>
              {isDistributor
                ? "The distributor organization is always active."
                : "Users of an inactive organization cannot sign in. Orders, reservations, and history are kept."}
            </p>
            {deactivating && (
              <p className={styles.notice} role="status" data-test="organization-deactivation-notice">
                Saving signs out all {organization.activeUserCount} active {organization.activeUserCount === 1 ? "user" : "users"} of{" "}
                {organization.name} immediately.
              </p>
            )}
          </>
        ) : (
          <p className={catalogStyles.muted}>New organizations are retailer stores. Add their users after creating the organization.</p>
        )}
      </fieldset>
      <button className={catalogStyles.primary} disabled={save.isPending} data-test="organization-save">
        {save.isPending ? "Saving…" : organization ? "Save organization" : "Create organization"}
      </button>
    </form>
  );
}

function Members({ organization }: { organization: AdminOrganization }) {
  const members = useUsers(`organizationId=${organization.id}&pageSize=100`);
  return (
    <section className={styles.members} aria-labelledby="members-heading">
      <div className={catalogStyles.sectionHeading}>
        <div>
          <h2 id="members-heading">Users</h2>
          <p className={catalogStyles.muted}>People who sign in for {organization.name}.</p>
        </div>
        <Link className={catalogStyles.secondary} to={`/admin/users/new?organizationId=${organization.id}`} data-test="organization-add-user">
          Add user
        </Link>
      </div>
      {members.isPending && <p role="status">Loading users…</p>}
      {members.isError && <p role="alert">Could not load the users of this organization.</p>}
      {members.data && !members.data.items.length && <p className={catalogStyles.empty}>No users yet.</p>}
      {members.data && members.data.items.length > 0 && (
        <div className={catalogStyles.tableScroll}>
          <table className={catalogStyles.table} data-test="organization-members">
            <caption className={catalogStyles.srOnly}>Users of {organization.name}</caption>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {members.data.items.map((user) => (
                <tr key={user.id} data-test="organization-member" data-email={user.email}>
                  <td>
                    <Link to={`/admin/users/${user.id}`}>{user.email}</Link>
                  </td>
                  <td>{user.displayName}</td>
                  <td>{roleLabel(user.role)}</td>
                  <td>
                    <ActiveBadge active={user.isActive} test="user-status" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {members.data.total > members.data.items.length && (
            <Link to={`/admin/users?organizationId=${organization.id}`}>Show all {members.data.total} users</Link>
          )}
        </div>
      )}
    </section>
  );
}

export function OrganizationPage({ create = false }: { create?: boolean }) {
  const { organizationId = "" } = useParams();
  const organization = useOrganization(create ? "" : organizationId);
  return (
    <>
      <Link className={catalogStyles.back} to="/admin/organizations">
        ← Organizations
      </Link>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>ADMINISTRATION</p>
          <h1 data-test="organization-heading">{create ? "Create an organization" : (organization.data?.name ?? "Organization")}</h1>
          {organization.data && (
            <p className={catalogStyles.muted}>
              {organizationTypeLabel(organization.data.type)} · <ActiveBadge active={organization.data.isActive} test="organization-status" />
            </p>
          )}
        </div>
      </div>
      {create ? (
        <OrganizationForm />
      ) : (
        <>
          {organization.isPending && <p role="status">Loading organization…</p>}
          {organization.isError && (
            <p role="alert">
              Could not load this organization. <button onClick={() => void organization.refetch()}>Try again</button>
            </p>
          )}
          {organization.data && (
            <>
              <OrganizationForm key={organization.data.id} organization={organization.data} />
              <Members organization={organization.data} />
            </>
          )}
        </>
      )}
    </>
  );
}
