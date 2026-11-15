describe("Piece beat audio", () => {
  let audio: { currentTime: number; volume: number; play: ReturnType<typeof vi.fn> };
  let Audio: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    audio = { currentTime: 0, volume: 1, play: vi.fn().mockResolvedValue(undefined) };
    Audio = vi.fn(function () {
      return audio;
    });
    vi.stubGlobal("Audio", Audio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lazily reuses the loaded audio and restarts it with the current volume", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    expect(Audio).not.toHaveBeenCalled();

    playPieceBeat(40);
    expect(Audio).toHaveBeenCalledExactlyOnceWith("sound/piece.mp3");
    expect(audio.volume).toBe(0.4);
    expect(audio.play).toHaveBeenCalledTimes(1);

    audio.currentTime = 0.3;
    vi.advanceTimersByTime(200);
    playPieceBeat(70);
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBeCloseTo(0.7);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("preserves the 200ms throttle without restarting the current sound", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    playPieceBeat(40);
    audio.currentTime = 0.1;

    vi.advanceTimersByTime(199);
    playPieceBeat(70);
    expect(audio.currentTime).toBe(0.1);
    expect(audio.volume).toBe(0.4);
    expect(audio.play).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    playPieceBeat(70);
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("handles rejected playback and reuses the audio for a later attempt", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    audio.play.mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));
    playPieceBeat(40);
    await Promise.resolve();

    vi.advanceTimersByTime(200);
    playPieceBeat(40);
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
