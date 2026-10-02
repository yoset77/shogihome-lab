import { t } from "@/common/i18n";

// False means the user cancelled; errors still reject and success returns true.
export async function saveWithOverwriteConfirmation(
  send: (overwrite: boolean) => Promise<Response>,
  path: string,
  overwriteCurrent = false,
): Promise<boolean> {
  let response = await send(overwriteCurrent);
  if (!overwriteCurrent && response.status === 409) {
    if (!window.confirm(t.overwriteUploadConflicts(path))) return false;
    response = await send(true);
  }
  if (!response.ok) throw new Error(await response.text());
  return true;
}
