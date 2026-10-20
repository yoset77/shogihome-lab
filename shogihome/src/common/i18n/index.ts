import { Language } from "./languages.js";
import * as translate from "./translation_table.js";

export * from "./languages.js";
export { t } from "./translation_table.js";
export * from "./errors.js";
export * from "./record.js";

export function setLanguage(lang: Language) {
  translate.setLanguage(lang);
}
