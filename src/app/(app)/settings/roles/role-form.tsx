import { PERMISSION_GROUPS } from "@/lib/permissions";
import { Button, Checkbox, CheckboxGroup, Field, Form, Hint } from "@/components/form";
import { deleteRole, saveRole } from "./actions";

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
            <CheckboxGroup
              key={group}
              legend={group}
              name="permissions"
              disabled={readOnly}
              options={Object.entries(permissions).map(([value, label]) => ({
                value,
                label,
                checked: role?.permissions.includes(value),
              }))}
            />
          ))
        )}
        {!readOnly && <Button>{role ? "Save role" : "Create role"}</Button>}
      </Form>
      {role && !readOnly && (
        <Form action={deleteRole}>
          <input type="hidden" name="id" value={role.id} />
          {/* A required checkbox stands in for a confirm dialog, without client JS. */}
          <Checkbox label="Delete this role and remove it from everyone who has it" required />
          <Button variant="danger">Delete role</Button>
        </Form>
      )}
    </>
  );
}
