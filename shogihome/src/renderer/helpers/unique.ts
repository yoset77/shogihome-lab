let lastDOMNumber = 0;

export function issueDOMID(): string {
  lastDOMNumber++;
  return `es:incremental:${lastDOMNumber}`;
}

export function generateSessionId(): string {
  if (typeof window !== "undefined" && window.crypto) {
    const array = new Uint32Array(2);
    window.crypto.getRandomValues(array);
    return array[0].toString(36) + array[1].toString(36) + Date.now().toString(36);
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
