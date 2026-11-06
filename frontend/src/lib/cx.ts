/** Join class names, skipping falsy values. */
export function cx(...classes: (string | false | null | undefined | 0)[]): string {
  return classes.filter(Boolean).join(" ");
}
