describe("Clock beep audio", () => {
  function createContext() {
    return {
      state: "running" as AudioContextState,
      currentTime: 5,
      destination: {},
      close: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      createOscillator: vi.fn(() => ({
        type: "sine",
        frequency: { value: 0 },
        onended: undefined as (() => void) | undefined,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createGain: vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
    };
  }

  let context: ReturnType<typeof createContext>;
  let AudioContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    context = createContext();
    AudioContext = vi.fn(function () {
      return context;
    });
    vi.stubGlobal("AudioContext", AudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lazily reuses one context across repeated short beeps", async () => {
    const { beepShort } = await import("@/renderer/devices/audio");
    expect(AudioContext).not.toHaveBeenCalled();

    for (let i = 0; i < 20; i++) {
      beepShort({ frequency: 660, volume: 60 });
      context.createOscillator.mock.results[i].value.onended?.();
    }

    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).toHaveBeenCalledTimes(20);
    expect(context.close).not.toHaveBeenCalled();
    expect(context.resume).not.toHaveBeenCalled();
    const oscillator = context.createOscillator.mock.results[0].value;
    const gain = context.createGain.mock.results[0].value;
    expect(oscillator.type).toBe("sine");
    expect(oscillator.frequency.value).toBe(660);
    expect(gain.gain.value).toBeCloseTo(0.3);
    expect(oscillator.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(oscillator.start).toHaveBeenCalledWith(5);
    expect(oscillator.stop).toHaveBeenCalledWith(5.1);
    expect(oscillator.disconnect).toHaveBeenCalledExactlyOnceWith(gain);
    expect(gain.disconnect).toHaveBeenCalledExactlyOnceWith(context.destination);
  });

  it.each(["suspended", "interrupted"] as const)(
    "resumes and reuses a context in state %s",
    async (state) => {
      const { beepShort } = await import("@/renderer/devices/audio");
      context.state = state;
      beepShort({ volume: 40 });
      expect(context.resume).toHaveBeenCalledTimes(1);
      expect(context.createOscillator).not.toHaveBeenCalled();
      expect(context.createGain).not.toHaveBeenCalled();

      context.state = "running";
      beepShort({ volume: 40 });
      expect(context.resume).toHaveBeenCalledTimes(1);
      expect(context.createOscillator).toHaveBeenCalledTimes(1);
      expect(context.createGain).toHaveBeenCalledTimes(1);

      context.state = state;
      beepShort({ volume: 40 });
      expect(context.resume).toHaveBeenCalledTimes(2);
      expect(context.createOscillator).toHaveBeenCalledTimes(1);
      expect(context.createGain).toHaveBeenCalledTimes(1);
      expect(AudioContext).toHaveBeenCalledTimes(1);
    },
  );

  it("drops short beeps while resume is pending without replaying them after recovery", async () => {
    const { beepShort } = await import("@/renderer/devices/audio");
    const resumed = Promise.withResolvers<void>();
    context.state = "suspended";
    context.resume.mockReturnValue(resumed.promise);

    for (let i = 0; i < 3; i++) {
      beepShort({ volume: 40 });
    }
    expect(context.resume).toHaveBeenCalledTimes(3);
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(context.createGain).not.toHaveBeenCalled();

    context.state = "running";
    resumed.resolve();
    await Promise.resolve();
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(context.createGain).not.toHaveBeenCalled();

    beepShort({ volume: 40 });
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
    expect(AudioContext).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected resume and retries on the next beep", async () => {
    const { beepShort } = await import("@/renderer/devices/audio");
    context.state = "suspended";
    context.resume.mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));
    beepShort({ volume: 40 });
    await Promise.resolve();

    beepShort({ volume: 40 });
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(context.createGain).not.toHaveBeenCalled();

    context.state = "running";
    beepShort({ volume: 40 });
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
  });

  it("drops long beeps while suspended without blocking the next audible warning", async () => {
    const { beepUnlimited } = await import("@/renderer/devices/audio");
    context.state = "suspended";
    beepUnlimited({ volume: 40 });
    beepUnlimited({ volume: 40 });
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(context.createGain).not.toHaveBeenCalled();

    context.state = "running";
    beepUnlimited({ volume: 40 });
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
  });

  it("resumes an interrupted long beep without creating another oscillator", async () => {
    const { beepUnlimited, stopBeep } = await import("@/renderer/devices/audio");
    beepUnlimited({ volume: 40 });
    const oscillator = context.createOscillator.mock.results[0].value;

    context.state = "interrupted";
    beepUnlimited({ volume: 40 });
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);

    context.state = "running";
    beepUnlimited({ volume: 40 });
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
    expect(AudioContext).toHaveBeenCalledTimes(1);
    stopBeep();
    expect(oscillator.stop).toHaveBeenCalledTimes(1);
  });

  it("preserves the default pitch and volume when omitted", async () => {
    const { beepShort } = await import("@/renderer/devices/audio");
    beepShort({});
    expect(context.createOscillator.mock.results[0].value.frequency.value).toBe(440);
    expect(context.createGain.mock.results[0].value.gain.value).toBe(0.01);
  });

  it.each([0, -1])("does not create a context for clock volume %i", async (volume) => {
    const { beepShort, beepUnlimited } = await import("@/renderer/devices/audio");
    beepShort({ volume });
    beepUnlimited({ volume });
    expect(AudioContext).not.toHaveBeenCalled();

    beepShort({ volume: 40 });
    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
  });

  it("shares the context with long beeps and preserves their stop and cleanup behavior", async () => {
    const { beepShort, beepUnlimited, stopBeep } = await import("@/renderer/devices/audio");
    beepUnlimited({ frequency: 880, volume: 40 });
    const oscillator = context.createOscillator.mock.results[0].value;
    const gain = context.createGain.mock.results[0].value;
    expect(oscillator.frequency.value).toBe(880);
    expect(gain.gain.value).toBe(0.2);
    expect(oscillator.stop).not.toHaveBeenCalled();

    beepUnlimited({ volume: 70 });
    beepShort({ volume: 70 });
    expect(context.createOscillator).toHaveBeenCalledTimes(1);

    stopBeep();
    stopBeep();
    expect(oscillator.stop).toHaveBeenCalledTimes(1);
    oscillator.onended?.();
    expect(oscillator.disconnect).toHaveBeenCalledExactlyOnceWith(gain);
    expect(gain.disconnect).toHaveBeenCalledExactlyOnceWith(context.destination);

    beepShort({ volume: 70 });
    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("creates a new context if the previous one was closed", async () => {
    const { beepShort } = await import("@/renderer/devices/audio");
    beepShort({ volume: 40 });
    const previous = context;
    previous.state = "closed";
    context = createContext();

    beepShort({ volume: 40 });
    expect(AudioContext).toHaveBeenCalledTimes(2);
    expect(previous.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
  });
});

describe("Piece beat audio", () => {
  let audio: {
    currentTime: number;
    volume: number;
    error: Pick<MediaError, "code"> | null;
    load: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
  };
  let Audio: ReturnType<typeof vi.fn>;

  function failNextPlayback(): void {
    audio.play.mockImplementationOnce(() => {
      audio.error = { code: 4 };
      return Promise.reject(new DOMException("Media source failed", "NotSupportedError"));
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    audio = {
      currentTime: 0,
      volume: 1,
      error: null,
      load: vi.fn(() => {
        audio.error = null;
        audio.currentTime = 0;
      }),
      // A failed media source remains unusable until load() clears the error.
      play: vi.fn(() =>
        audio.error
          ? Promise.reject(new DOMException("Media source failed", "NotSupportedError"))
          : Promise.resolve(),
      ),
    };
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
    expect(audio.load).not.toHaveBeenCalled();
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

  it.each([0, -1])("does not load audio or consume the throttle for volume %i", async (volume) => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    playPieceBeat(volume);
    expect(Audio).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();

    playPieceBeat(40);
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("leaves loaded audio untouched and does not throttle the next audible beat when muted", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    playPieceBeat(40);
    audio.currentTime = 0.1;
    vi.advanceTimersByTime(200);

    playPieceBeat(0);
    expect(audio.currentTime).toBe(0.1);
    expect(audio.volume).toBe(0.4);
    expect(audio.play).toHaveBeenCalledTimes(1);

    playPieceBeat(70);
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBeCloseTo(0.7);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("handles autoplay rejection without reloading the audio", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    audio.play.mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));
    playPieceBeat(40);
    await Promise.resolve();

    vi.advanceTimersByTime(200);
    playPieceBeat(40);
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.load).not.toHaveBeenCalled();
  });

  it("reloads a failed media source on the next beat without replacing the audio", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    failNextPlayback();
    playPieceBeat(40);
    await expect(audio.play.mock.results[0].value).rejects.toThrow("Media source failed");
    expect(audio.error?.code).toBe(4);
    expect(audio.load).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    playPieceBeat(70);
    await expect(audio.play.mock.results[1].value).resolves.toBeUndefined();
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.error).toBeNull();
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBeCloseTo(0.7);

    vi.advanceTimersByTime(200);
    playPieceBeat(70);
    await expect(audio.play.mock.results[2].value).resolves.toBeUndefined();
    expect(audio.load).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1])("does not reload failed audio for volume %i", async (volume) => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    failNextPlayback();
    playPieceBeat(40);
    await expect(audio.play.mock.results[0].value).rejects.toThrow("Media source failed");
    vi.advanceTimersByTime(200);
    audio.currentTime = 0.1;

    playPieceBeat(volume);
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.error?.code).toBe(4);
    expect(audio.currentTime).toBe(0.1);
    expect(audio.volume).toBe(0.4);

    playPieceBeat(70);
    await expect(audio.play.mock.results[1].value).resolves.toBeUndefined();
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(Audio).toHaveBeenCalledTimes(1);
  });

  it("does not reload failed audio until the 200ms throttle expires", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    failNextPlayback();
    playPieceBeat(40);
    await expect(audio.play.mock.results[0].value).rejects.toThrow("Media source failed");

    vi.advanceTimersByTime(199);
    playPieceBeat(70);
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.error?.code).toBe(4);

    vi.advanceTimersByTime(1);
    playPieceBeat(70);
    await expect(audio.play.mock.results[1].value).resolves.toBeUndefined();
    expect(audio.load).toHaveBeenCalledTimes(1);
  });

  it("retries repeated media failures only when another beat is requested", async () => {
    const { playPieceBeat } = await import("@/renderer/devices/audio");
    failNextPlayback();
    playPieceBeat(40);
    await expect(audio.play.mock.results[0].value).rejects.toThrow("Media source failed");

    vi.advanceTimersByTime(200);
    failNextPlayback();
    playPieceBeat(40);
    await expect(audio.play.mock.results[1].value).rejects.toThrow("Media source failed");
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.error?.code).toBe(4);

    await vi.advanceTimersByTimeAsync(1000);
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(2);

    playPieceBeat(70);
    await expect(audio.play.mock.results[2].value).resolves.toBeUndefined();
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(audio.error).toBeNull();
    expect(Audio).toHaveBeenCalledTimes(1);
  });
});
