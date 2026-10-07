// Shared bits for the auth and onboarding forms.

export const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-base dark:border-zinc-700 dark:bg-zinc-900";
export const buttonClass =
  "w-full rounded-md bg-zinc-900 px-3 py-2 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900";

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input className={inputClass} {...props} />
    </label>
  );
}

export function FormPage({
  title,
  error,
  notice,
  children,
}: {
  title: string;
  error?: string;
  notice?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800">
          {notice}
        </p>
      )}
      {children}
    </main>
  );
}

export const errorUrl = (path: string, message: string) => `${path}?error=${encodeURIComponent(message)}`;

export const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
