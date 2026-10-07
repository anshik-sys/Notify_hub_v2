import { PERMISSION_GROUPS } from "@/lib/permissions";
import { Button, Field, Form, Hint } from "../../form";
import { deleteRole, saveRole } from "./actions";
import styles from "./role-form.module.css";

// Ids come from the URL; Postgres throws on a malformed uuid, so check first.
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

type Role = { id: string; name: string; permissions: string[]; system: boolean; admin: boolean };

export function RoleForm({ role }: { role?: Role }) {
  const readOnly = role?.system ?? false;
  return (
    <>
      {readOnly && <Hint>This is a built-in role and can’t be changed.</Hint>}
      <Form action={saveRole}>
        {role && <input type="hidden" name="id" value={role.id} />}
        <Field label="Name" name="name" defaultValue={role?.name} maxLength={50} required disabled={readOnly} />
        {role?.admin ? (
          <Hint>All permissions, including any added later.</Hint>
        ) : (
          Object.entries(PERMISSION_GROUPS).map(([group, permissions]) => (
            <fieldset key={group} className={styles.group} disabled={readOnly}>
              <legend className={styles.legend}>{group}</legend>
              {Object.entries(permissions).map(([key, label]) => (
                <label key={key} className={styles.permission}>
                  <input type="checkbox" name="permissions" value={key} defaultChecked={role?.permissions.includes(key)} />
                  {label}
                </label>
              ))}
            </fieldset>
          ))
        )}
        {!readOnly && <Button>{role ? "Save role" : "Create role"}</Button>}
      </Form>
      {role && !readOnly && (
        <Form action={deleteRole}>
          <input type="hidden" name="id" value={role.id} />
          {/* A required checkbox stands in for a confirm dialog, without client JS. */}
          <label className={styles.permission}>
            <input type="checkbox" required />
            Delete this role and remove it from everyone who has it
          </label>
          <Button variant="danger">Delete role</Button>
        </Form>
      )}
    </>
  );
}
