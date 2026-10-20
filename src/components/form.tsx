// The UI kit: page frame, form controls, buttons. Desktop-first: wide pages,
// forms at a readable width, the page's main action top right.
import Link from "next/link";
import styles from "./form.module.css";

export function Page({
  title,
  back,
  error,
  notice,
  center,
  actions,
  children,
}: {
  title: string;
  /** Shown above the title, e.g. { href: "/users", label: "People" }. */
  back?: { href: string; label: string };
  error?: string;
  notice?: string;
  /** Vertically centred, narrow: for sign-in style screens outside the app shell. */
  center?: boolean;
  /** The page's main buttons/links, shown top right next to the title. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main id="main" className={center ? `${styles.page} ${styles.center}` : styles.page}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          {back && (
            <Link href={back.href} className={styles.back}>
              <span aria-hidden="true">←</span> {back.label}
            </Link>
          )}
          <h1 className={styles.title}>{title}</h1>
        </div>
        {actions && <div className={styles.headerActions}>{actions}</div>}
      </div>
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

// The red * after a required field's label. Inputs with `required` get it
// from Field etc. (screen readers already hear "required" from the input);
// a section that needs at least one choice passes `required` and also gets
// the word, visually hidden.
const Star = () => (
  <span className={styles.required} aria-hidden="true">
    {" "}
    *
  </span>
);

export function Section({
  id,
  title,
  required,
  step,
  children,
}: {
  /** For in-page links, e.g. `#discussion`. */
  id?: string;
  title: string;
  required?: boolean;
  /** A numbered step in a StepsForm: shown as a small circle before the title. */
  step?: number;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={styles.section} data-card>
      <h2 className={styles.sectionTitle}>
        {step !== undefined && (
          <span className={styles.step} aria-hidden="true">
            {step}
          </span>
        )}
        {title}
        {required && (
          <>
            <Star />
            <span className={styles.hidden}> (required)</span>
          </>
        )}
      </h2>
      {children}
    </section>
  );
}

// Two columns for dashboards: the main one wider. Stacks on narrower windows.
export function Columns({ main, side }: { main: React.ReactNode; side: React.ReactNode }) {
  return (
    <div className={styles.columns}>
      <div className={styles.column}>{main}</div>
      <div className={styles.column}>{side}</div>
    </div>
  );
}

// A slim nudge with progress (e.g. setup): one line, so it never dominates a page.
export function Banner({ href, title, done, total, action }: { href: string; title: string; done: number; total: number; action: string }) {
  return (
    <Link href={href} className={styles.banner}>
      <span className={styles.bannerTitle}>{title}</span>
      <span className={styles.bannerTrack} role="img" aria-label={`${done} of ${total} done`}>
        <span className={styles.bannerFill} style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </span>
      <span className={styles.bannerCount} aria-hidden="true">
        {done}/{total}
      </span>
      <span className={styles.bannerAction}>
        {action} <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}

export function Form(props: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={styles.form} data-card {...props} />;
}

// A long form in numbered Section cards (640px column), with an aside that
// stays in view while scrolling, e.g. a live preview. Below 1100px wide the
// aside drops under the form. Sections stay cards here (unlike in Form).
export function StepsForm({ aside, children, ...props }: { aside: React.ReactNode } & React.FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form className={styles.steps} {...props}>
      <div className={styles.stepsMain}>{children}</div>
      <aside className={styles.stepsAside}>{aside}</aside>
    </form>
  );
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.field}>
      <span>
        {label}
        {props.required && <Star />}
      </span>
      <input className={styles.input} {...props} />
    </label>
  );
}

export function FileField({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input type="file" className={styles.fileInput} {...props} />
    </label>
  );
}

export function TextArea({ label, ...props }: { label: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={styles.field}>
      <span>
        {label}
        {props.required && <Star />}
      </span>
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
      <span>
        {label}
        {props.required && <Star />}
      </span>
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

// hideLegend: the section heading already says it; the legend stays for
// screen readers.
export function CheckboxGroup({
  legend,
  name,
  options,
  disabled,
  hideLegend,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string; checked?: boolean; disabled?: boolean }[];
  disabled?: boolean;
  hideLegend?: boolean;
}) {
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className={hideLegend ? styles.hidden : styles.legend}>{legend}</legend>
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
  hideLegend,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  value: string;
  hideLegend?: boolean;
}) {
  return (
    <fieldset className={styles.group}>
      <legend className={hideLegend ? styles.hidden : styles.legend}>{legend}</legend>
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

// Navigation that looks like a button (a link, not a form submit).
export function LinkButton({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={`${styles.button} ${styles[variant]} ${styles.linkButton}`}>
      {children}
    </Link>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

export const errorUrl = (path: string, message: string) => `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;

// Only same-origin paths: "/x" yes, "//evil.com" and "https://…" no.
export const safeNext = (v: unknown) => (typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : "/");

export const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
