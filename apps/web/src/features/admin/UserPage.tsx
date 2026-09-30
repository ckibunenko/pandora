import { useMutation } from "@tanstack/react-query";
import {
  adminPasswordSchema,
  createUserSchema,
  rolesFor,
  updateUserSchema,
  type AdminUser,
  type CreateUser,
  type UpdateUser,
  type UserRole,
} from "@pandora/contracts";
import { useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { roleLabel, useSession } from "../auth/session";
import catalogStyles from "../catalog/Catalog.module.css";
import { CatalogFormField } from "../catalog/CatalogFormField";
import { errorFields, mutationMessage } from "../catalog/form-errors";
import { createUser, resetPassword, updateUser, useAdminExpiredSession, useAdminRefresh, useOrganizations, useUser } from "./admin-api";
import { ActiveBadge } from "./AdminShared";
import styles from "./Admin.module.css";

type FieldErrors = Record<string, string>;
const issuesToErrors = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldErrors =>
  Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.message]));

function PasswordField({
  name,
  label,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const id = useId();
  return (
    <div className={catalogStyles.field}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        maxLength={256}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        data-test={`field-${name}`}
      />
      {error && (
        <p className={catalogStyles.fieldError} id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

function CreateUserForm() {
  const [params] = useSearchParams();
  const organizations = useOrganizations("pageSize=100&status=active");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [organizationId, setOrganizationId] = useState(params.get("organizationId") ?? "");
  const [role, setRole] = useState<UserRole | "">("");
  const [password, setPassword] = useState("");
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});
  const refresh = useAdminRefresh();
  const navigate = useNavigate();
  const organization = organizations.data?.items.find((item) => item.id === organizationId);
  const allowedRoles = organization ? rolesFor(organization.type) : [];
  const selectedRole = role && allowedRoles.includes(role) ? role : (allowedRoles[0] ?? "");
  const save = useMutation({
    mutationFn: (input: CreateUser) => createUser(input),
    onSuccess: async (saved) => {
      await refresh();
      void navigate(`/admin/users/${saved.id}`, { replace: true, state: { created: true } });
    },
  });
  useAdminExpiredSession(save.error);
  const errors = { ...errorFields(save.error), ...localErrors };

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createUserSchema.safeParse({ email, displayName, organizationId, role: selectedRole, password });
    setLocalErrors(parsed.success ? {} : issuesToErrors(parsed.error.issues));
    if (parsed.success) save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} className={catalogStyles.form} noValidate data-test="user-form">
      <h2>New user</h2>
      {save.isError && (
        <p role="alert" className={catalogStyles.error} data-test="user-error">
          {mutationMessage(save.error)}
        </p>
      )}
      {Object.keys(localErrors).length > 0 && (
        <p role="alert" className={catalogStyles.error}>
          Please correct the highlighted fields.
        </p>
      )}
      {organizations.isError && <p role="alert">Could not load organizations.</p>}
      <fieldset disabled={save.isPending} className={catalogStyles.fields}>
        <CatalogFormField name="user-email" label="Email" value={email} onChange={setEmail} maxLength={254} error={errors.email} />
        <CatalogFormField name="user-display-name" label="Display name" value={displayName} onChange={setDisplayName} maxLength={120} error={errors.displayName} />
        <CatalogFormField
          name="user-organization"
          label="Organization"
          type="select"
          value={organizationId}
          onChange={setOrganizationId}
          error={errors.organizationId}
          options={[
            { value: "", label: organizations.isPending ? "Loading organizations…" : "Select an organization" },
            ...(organizations.data?.items.map((item) => ({ value: item.id, label: item.name })) ?? []),
          ]}
        />
        <CatalogFormField
          name="user-role"
          label="Role"
          type="select"
          value={selectedRole}
          onChange={(value) => setRole(allowedRoles.find((allowed) => allowed === value) ?? "")}
          error={errors.role}
          disabled={allowedRoles.length < 2}
          options={
            allowedRoles.length
              ? allowedRoles.map((allowed) => ({ value: allowed, label: roleLabel(allowed) }))
              : [{ value: "", label: "Select an organization first" }]
          }
        />
        <PasswordField name="user-password" label="Initial password (at least 12 characters)" value={password} onChange={setPassword} error={errors.password} />
        <p className={catalogStyles.muted}>Share the initial password with the user through a separate channel. Only active organizations are listed.</p>
      </fieldset>
      <button className={catalogStyles.primary} disabled={save.isPending} data-test="user-save">
        {save.isPending ? "Creating…" : "Create user"}
      </button>
    </form>
  );
}

function EditUserForm({ user, self }: { user: AdminUser; self: boolean }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<UserRole>(user.role);
  const [isActive, setIsActive] = useState(user.isActive);
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});
  const refresh = useAdminRefresh();
  const allowedRoles = rolesFor(user.organization.type);
  const save = useMutation({
    mutationFn: (patch: UpdateUser) => (Object.keys(patch).length ? updateUser(user.id, patch) : Promise.resolve(user)),
    onSuccess: async (saved) => {
      setDisplayName(saved.displayName);
      setRole(saved.role);
      setIsActive(saved.isActive);
      await refresh();
    },
  });
  useAdminExpiredSession(save.error);
  const errors = { ...errorFields(save.error), ...localErrors };
  const endsSessions = (user.isActive && !isActive) || role !== user.role;

  function submit(event: FormEvent) {
    event.preventDefault();
    const patch: UpdateUser = {};
    if (displayName.trim() !== user.displayName) patch.displayName = displayName;
    if (role !== user.role) patch.role = role;
    if (isActive !== user.isActive) patch.isActive = isActive;
    const parsed = Object.keys(patch).length ? updateUserSchema.safeParse(patch) : null;
    setLocalErrors(parsed && !parsed.success ? issuesToErrors(parsed.error.issues) : {});
    if (!parsed) save.mutate({});
    else if (parsed.success) save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} className={catalogStyles.form} noValidate data-test="user-form">
      <h2>Account</h2>
      {save.isError && (
        <p role="alert" className={catalogStyles.error} data-test="user-error">
          {mutationMessage(save.error)}
        </p>
      )}
      {Object.keys(localErrors).length > 0 && (
        <p role="alert" className={catalogStyles.error}>
          Please correct the highlighted fields.
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className={catalogStyles.success} data-test="user-saved">
          User saved.
        </p>
      )}
      <fieldset disabled={save.isPending} className={catalogStyles.fields}>
        <CatalogFormField name="user-display-name" label="Display name" value={displayName} onChange={setDisplayName} maxLength={120} error={errors.displayName} />
        {allowedRoles.length > 1 ? (
          <CatalogFormField
            name="user-role"
            label="Role"
            type="select"
            value={role}
            onChange={(value) => setRole(allowedRoles.find((allowed) => allowed === value) ?? user.role)}
            error={errors.role}
            options={allowedRoles.map((allowed) => ({ value: allowed, label: roleLabel(allowed) }))}
          />
        ) : (
          <p className={catalogStyles.muted}>Role: {roleLabel(user.role)}. Retailer store users always have the retailer role.</p>
        )}
        <label className={catalogStyles.checkbox}>
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} data-test="user-active" />
          Active user
        </label>
        {endsSessions && (
          <p className={styles.notice} role="status" data-test="user-sessions-notice">
            {self
              ? "This is your own account. Saving signs you out immediately."
              : `Saving signs ${user.displayName} out of every device immediately.`}
          </p>
        )}
      </fieldset>
      <button className={catalogStyles.primary} disabled={save.isPending} data-test="user-save">
        {save.isPending ? "Saving…" : "Save user"}
      </button>
    </form>
  );
}

function ResetPasswordForm({ user, self }: { user: AdminUser; self: boolean }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});
  const refresh = useAdminRefresh();
  const reset = useMutation({
    mutationFn: (value: string) => resetPassword(user.id, { password: value }),
    onSuccess: async () => {
      setPassword("");
      setConfirmation("");
      await refresh();
    },
  });
  useAdminExpiredSession(reset.error);
  const errors = { ...errorFields(reset.error), ...localErrors };

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = adminPasswordSchema.safeParse(password);
    const next: FieldErrors = {};
    if (!parsed.success) next.password = "Use 12 to 256 characters.";
    else if (confirmation !== password) next.confirmation = "The passwords do not match.";
    setLocalErrors(next);
    if (parsed.success && !next.confirmation) reset.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} className={catalogStyles.form} noValidate data-test="password-form">
      <h2>Reset password</h2>
      {reset.isError && (
        <p role="alert" className={catalogStyles.error} data-test="password-error">
          {mutationMessage(reset.error)}
        </p>
      )}
      {reset.isSuccess && (
        <p role="status" className={catalogStyles.success} data-test="password-saved">
          Password reset. {user.displayName} was signed out everywhere and must use the new password.
        </p>
      )}
      <fieldset disabled={reset.isPending} className={catalogStyles.fields}>
        <PasswordField name="new-password" label="New password (at least 12 characters)" value={password} onChange={setPassword} error={errors.password} />
        <PasswordField name="confirm-password" label="Repeat the new password" value={confirmation} onChange={setConfirmation} error={errors.confirmation} />
        <p className={catalogStyles.muted}>
          {self ? "Resetting your own password signs you out." : "The user is signed out of every device."}
        </p>
      </fieldset>
      <button className={catalogStyles.secondary} disabled={reset.isPending} data-test="password-save">
        {reset.isPending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

export function UserPage({ create = false }: { create?: boolean }) {
  const { userId = "" } = useParams();
  const user = useUser(create ? "" : userId);
  const session = useSession();
  const self = session.data?.user.id === user.data?.id;
  const location = useLocation();
  const created = typeof location.state === "object" && location.state !== null && "created" in location.state && location.state.created === true;
  return (
    <>
      <Link className={catalogStyles.back} to="/admin/users">
        ← Users
      </Link>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>ADMINISTRATION</p>
          <h1 data-test="user-heading">{create ? "Create a user" : (user.data?.displayName ?? "User")}</h1>
        </div>
      </div>
      {create ? (
        <CreateUserForm />
      ) : (
        <>
          {created && (
            <p role="status" className={catalogStyles.success} data-test="user-created">
              User created. They can sign in with the initial password.
            </p>
          )}
          {user.isPending && <p role="status">Loading user…</p>}
          {user.isError && (
            <p role="alert">
              Could not load this user. <button onClick={() => void user.refetch()}>Try again</button>
            </p>
          )}
          {user.data && (
            <div className={catalogStyles.editor}>
              <div>
                <dl className={styles.readOnly} data-test="user-details">
                  <dt>Email</dt>
                  <dd data-test="user-email">{user.data.email}</dd>
                  <dt>Organization</dt>
                  <dd>
                    <Link to={`/admin/organizations/${user.data.organization.id}`}>{user.data.organization.name}</Link>
                    {!user.data.organization.isActive && " (inactive organization: sign-in is blocked)"}
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    <ActiveBadge active={user.data.isActive} test="user-status" />
                  </dd>
                </dl>
                <p className={`${catalogStyles.muted} ${styles.readOnlyNote}`}>Email and organization cannot be changed.</p>
                <EditUserForm key={user.data.id} user={user.data} self={self} />
              </div>
              <ResetPasswordForm key={user.data.id} user={user.data} self={self} />
            </div>
          )}
        </>
      )}
    </>
  );
}
