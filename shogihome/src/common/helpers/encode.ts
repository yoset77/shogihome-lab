import ejpn, { Encoding } from "encoding-japanese";
const [convert, detect] = [ejpn.convert, ejpn.detect];

export function encodeText(data: string, encoding: Encoding): Uint8Array {
  if (encoding === "ASCII" || encoding === "UTF8") {
    return new TextEncoder().encode(data);
  }
  return new Uint8Array(
    convert(data, {
      type: "arraybuffer",
      from: "UNICODE",
      to: encoding,
    }),
  );
}

type DecodeOption = {
  encoding?: Encoding;
  autoDetect?: boolean;
};

const encodingToLabel: Partial<Record<Encoding, string>> = {
  UTF8: "utf-8",
  UTF16: "utf-16",
  UTF16BE: "utf-16be",
  UTF16LE: "utf-16le",
  JIS: "iso-2022-jp",
  EUCJP: "euc-jp",
  SJIS: "shift-jis",
  ASCII: "ascii",
};

export function decodeText(data: Uint8Array, option?: DecodeOption): string {
  const encoding =
    option?.autoDetect || !option?.encoding
      ? detectTextEncoding(data, option?.encoding)
      : option.encoding;

  if (encoding === "UNICODE" || encoding === "BINARY") {
    return convert(data, {
      type: "string",
      from: encoding,
      to: "UNICODE",
    });
  }

  const label = encodingToLabel[encoding] || encoding;
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return convert(data, {
      type: "string",
      from: encoding,
      to: "UNICODE",
    });
  }
}

export function detectTextEncoding(data: Uint8Array, defaultEncoding?: Encoding): Encoding {
  const detected = detect(data);
  // encoding-japanese returns "UNICODE" or "BINARY" when detection is ambiguous or
  // the byte sequence contains characters outside the detected encoding's range
  // (e.g. CP932 extension characters like はしご高 U+9AD9 = 0xFB 0xFC).
  // Treat these as detection failure and fall back to the caller-supplied hint.
  if (!detected || detected === "UNICODE" || detected === "BINARY") {
    return defaultEncoding || "UTF8";
  }
  return detected;
}
