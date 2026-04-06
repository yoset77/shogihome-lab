import { describe, expect, it } from "vitest";
import { normalizeSfen } from "@/common/usi/sfen.js";

describe("common/usi/sfen", () => {
  describe("normalizeSfen", () => {
    it("should remove trailing move count from SFEN", () => {
      expect(normalizeSfen("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1")).toBe(
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -",
      );
    });

    it("should handle SFEN with multi-digit move count", () => {
      expect(
        normalizeSfen("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 123"),
      ).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -");
    });

    it("should handle SFEN with hand pieces", () => {
      expect(
        normalizeSfen("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b P 25"),
      ).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b P");
    });

    it("should not modify SFEN without move count", () => {
      expect(normalizeSfen("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -")).toBe(
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -",
      );
    });
  });
});
