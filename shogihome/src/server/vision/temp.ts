import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_VISION_IMAGE_EXTENSIONS = new Set(["jpg", "png"]);

export const writeTempVisionImage = async (
  image: Buffer,
  extension: string,
): Promise<{ imagePath: string; cleanup: () => Promise<void> }> => {
  if (!SAFE_VISION_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("invalid vision image extension");
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shogihome-vision-"));
  const imagePath = path.join(dir, `input.${extension}`);
  await fs.writeFile(imagePath, image);
  return {
    imagePath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};
