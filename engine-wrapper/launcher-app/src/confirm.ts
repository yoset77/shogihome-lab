// Destructive-action confirmations for the config editor.
//
// All confirmations go through the Tauri dialog plugin (`ask`), which is
// asynchronous. `window.confirm` must not be used here: under the dialog
// plugin's guest bindings it resolves to a Promise (always truthy), so a
// synchronous `if (window.confirm(...))` would execute the destructive
// action even when the user cancels.
import { ask } from "@tauri-apps/plugin-dialog";

export async function confirmAction(message: string, title?: string): Promise<boolean> {
  try {
    return await ask(message, title ? { title } : undefined);
  } catch {
    // Fail closed: a dialog error must never trigger the destructive path.
    return false;
  }
}
