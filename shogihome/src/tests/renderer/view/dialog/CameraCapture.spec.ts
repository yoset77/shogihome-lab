import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CameraCapture from "@/renderer/view/dialog/CameraCapture.vue";

const getCameraStreamMock = vi.hoisted(() => vi.fn());
const stopCameraStreamMock = vi.hoisted(() => vi.fn());

vi.mock("@/renderer/helpers/camera", () => ({
  getCameraStream: getCameraStreamMock,
  stopCameraStream: stopCameraStreamMock,
  captureVideoFrame: vi.fn(),
}));

describe("CameraCapture", () => {
  it("stops a stream that resolves after the component is unmounted", async () => {
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    const streamPromise = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const stream = { getTracks: vi.fn(() => []) } as unknown as MediaStream;
    getCameraStreamMock.mockReturnValueOnce(streamPromise);

    const wrapper = mount(CameraCapture, {
      global: {
        stubs: {
          Icon: true,
        },
      },
    });

    wrapper.unmount();
    resolveStream(stream);
    await flushPromises();

    expect(stopCameraStreamMock).toHaveBeenCalledWith(stream);
  });
});
