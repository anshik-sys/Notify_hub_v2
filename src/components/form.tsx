// The UI kit: page frame, form controls, buttons. Mobile-first: every control
// is full width and at least 44px tall. See form.module.css.
import Link from "next/link";
import styles from "./form.module.css";

export function Page({
  title,
  back,
  error,
  notice,
  center,
  children,
}: {
  title: string;
  /** Shown above the title, e.g. { href: "/users", label: "People" }. */
  back?: { href: string; label: string };
  error?: string;
  notice?: string;
  /** Vertically centred, narrow: for sign-in style screens outside the app shell. */
  center?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className={center ? `${styles.page} ${styles.center}` : styles.page}>
      {back && (
        <Link href={back.href} className={styles.back}>
          <span aria-hidden="true">‹</span> {back.label}
        </Link>
      )}
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

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
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

export function TextArea({ label, ...props }: { label: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={styles.field}>
      {label}
      <textarea className={`${styles.input} ${styles.textarea}`} {...props} />
    </label>
  );
}

export function SelectField({
  label,
  options,
  ...props
}: { label: string; options: (string | { value: string; label: string })[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={styles.field}>
      {label}
      <select className={styles.input} {...props}>
        {options.map((o) =>
          typeof o === "string" ? (
            <option key={o}>{o}</option>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ),
        )}
      </select>
    </label>
  );
}

export function Checkbox({ label, ...props }: { label: React.ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.checkbox}>
      <input type="checkbox" className={styles.checkboxInput} {...props} />
      {label}
    </label>
  );
}

export function CheckboxGroup({
  legend,
  name,
  options,
  disabled,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string; checked?: boolean; disabled?: boolean }[];
  disabled?: boolean;
}) {
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className={styles.legend}>{legend}</legend>
      {options.map((o) => (
        <Checkbox key={o.value} label={o.label} name={name} value={o.value} defaultChecked={o.checked} disabled={o.disabled} />
      ))}
    </fieldset>
  );
}

export function RadioGroup({
  legend,
  name,
  options,
  value,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  value: string;
}) {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={styles.checkbox}>
          <input type="radio" className={styles.checkboxInput} name={name} value={o.value} defaultChecked={o.value === value} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

export function Button({
  variant = "primary",
  size,
  className,
  ...props
}: { variant?: "primary" | "secondary" | "danger"; size?: "small" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [styles.button, styles[variant], size === "small" && styles.small, className].filter(Boolean);
  return <button className={classes.join(" ")} {...props} />;
}

// Navigation that looks like the primary button (a link, not a form submit).
export function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={`${styles.button} ${styles.primary} ${styles.linkButton}`}>
      {children}
    </Link>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

export const errorUrl = (path: string, message: string) => `${path}?error=${encodeURIComponent(message)}`;

// Only same-origin paths: "/x" yes, "//evil.com" and "https://…" no.
export const safeNext = (v: unknown) => (typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : "/");

export const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
