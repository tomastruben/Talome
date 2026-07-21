export const PENDING_STACK_IMPORT_KEY = "talome:pending-stack-import:v1";
export const STACK_IMPORT_DESTINATION = "/dashboard/settings/stacks";
const MAX_IMPORT_FRAGMENT_LENGTH = 500_000;

export function capsuleFromFragment(fragment: string): string | null {
  let value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  try {
    value = decodeURIComponent(value).trim();
  } catch {
    return null;
  }

  if (!value.startsWith("t2.") || value.length > MAX_IMPORT_FRAGMENT_LENGTH) return null;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}
