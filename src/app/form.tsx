// Shared bits for the auth and onboarding forms.
import styles from "./form.module.css";

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
    <main className={styles.page}>
      <h1 className={styles.title}>{title}</h1>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {children}
    </main>
  );
}

export function Form(props: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={styles.form} {...props} />;
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.field}>
      {label}
      <input className={styles.input} {...props} />
    </label>
  );
}

export function SelectField({
  label,
  options,
  ...props
}: { label: string; options: string[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={styles.field}>
      {label}
      <select className={styles.input} {...props}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={styles.button} {...props} />;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

export const errorUrl = (path: string, message: string) => `${path}?error=${encodeURIComponent(message)}`;

export const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
