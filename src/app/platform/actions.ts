"use server";

import { redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import {
  createCompanyForCustomer,
  deleteEmptyCompany,
  editCompany,
  ownerAction,
  setMemberPermissions,
  setSuspended,
  setVolumeAlert,
} from "@/lib/platform";
import { isUuid } from "@/lib/validate";

// Every action re-checks the owner (email, 2FA, IP) and is rate limited.
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const go = (path: string, error: string | null, notice = "Saved."): never =>
  redirect(error ? errorUrl(path, error) : `${path}?notice=${encodeURIComponent(notice)}`);
async function gate(path: string) {
  const { owner, limited } = await ownerAction();
  if (limited) go(path, limited);
  return owner;
}
const companyId = (fd: FormData) => {
  const id = str(fd, "companyId");
  if (!isUuid(id)) redirect("/platform");
  return id;
};

export async function createCompanyAction(fd: FormData) {
  const owner = await gate("/platform");
  const r = await createCompanyForCustomer(owner, {
    name: str(fd, "name"),
    domain: str(fd, "domain"),
    timeZone: str(fd, "timeZone"),
    adminEmail: str(fd, "adminEmail"),
  });
  if (!r.id) go("/platform", r.error ?? "Couldn't create it.");
  go(`/platform/companies/${r.id}`, r.error ?? null, "Company created. The first admin has been invited.");
}

export async function editCompanyAction(fd: FormData) {
  const id = companyId(fd);
  await gate(`/platform/companies/${id}`);
  go(`/platform/companies/${id}`, await editCompany(id, { name: str(fd, "name"), domain: str(fd, "domain"), timeZone: str(fd, "timeZone") }));
}

export async function suspendAction(fd: FormData) {
  const id = companyId(fd);
  await gate(`/platform/companies/${id}`);
  const on = str(fd, "suspend") === "true";
  go(`/platform/companies/${id}`, await setSuspended(id, on), on ? "Suspended: its people are locked out and nothing is sent." : "Unsuspended.");
}

export async function deleteCompanyAction(fd: FormData) {
  const id = companyId(fd);
  await gate(`/platform/companies/${id}`);
  const error = await deleteEmptyCompany(id);
  if (error) go(`/platform/companies/${id}`, error);
  go("/platform", null, "Company deleted.");
}

export async function platformSettingsAction(fd: FormData) {
  await gate("/platform/settings");
  const v = str(fd, "volume").trim();
  const error = await setVolumeAlert(v === "" ? null : Number(v));
  if (error) go("/platform/settings", error);
  go("/platform/settings", await setMemberPermissions(fd.getAll("member").map(String)));
}
