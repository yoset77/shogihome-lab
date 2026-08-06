import { describe, expect, it } from "vitest";
import {
  getElapsedTimeChartBoardMaxSize,
  getElapsedTimeChartBoardSize,
} from "@/renderer/view/dialog/ElapsedTimeChartDialog.vue";

describe("ElapsedTimeChartDialog", () => {
  it("sizes the desktop board from the dialog content area", () => {
    expect(getElapsedTimeChartBoardMaxSize(1200, 800, false)).toMatchObject({
      width: 360,
      height: 360,
    });
    expect(getElapsedTimeChartBoardMaxSize(2400, 1600, false)).toMatchObject({
      width: 480,
      height: 480,
    });
  });

  it("keeps the mobile board within the viewport", () => {
    expect(getElapsedTimeChartBoardMaxSize(500, 800, true)).toMatchObject({
      width: 280,
      height: 280,
    });
  });

  it("uses viewport dimensions for mobile and content dimensions for desktop", () => {
    expect(getElapsedTimeChartBoardSize(500, 800, 300, 400, true)).toMatchObject({
      width: 280,
      height: 280,
    });
    expect(getElapsedTimeChartBoardSize(1920, 1080, 1200, 800, false)).toMatchObject({
      width: 360,
      height: 360,
    });
  });
});
