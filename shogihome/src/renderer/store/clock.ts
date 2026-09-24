export type ClockSettings = {
  timeMs?: number;
  byoyomi?: number;
  increment?: number;
  onBeepShort?: () => void;
  onBeepUnlimited?: () => void;
  onStopBeep?: () => void;
  onTimeout?: () => void;
};

export type ClockSnapshot = { timeMs: number; byoyomi: number; elapsedMs: number };

export class Clock {
  private _settings: ClockSettings = {
    timeMs: 0,
    byoyomi: 0,
    increment: 0,
  };
  private _timeMs = 0;
  private _byoyomi = 0;
  private _elapsedMs = 0;
  private timerHandle = 0;
  private timerStart = 0;
  private lastTimeMs = 0;
  private generation = 0;

  snapshot(): ClockSnapshot {
    return { timeMs: this._timeMs, byoyomi: this._byoyomi, elapsedMs: this._elapsedMs };
  }

  restore(snapshot: ClockSnapshot): void {
    this.clearTimer();
    this._timeMs = snapshot.timeMs;
    this._byoyomi = snapshot.byoyomi;
    this._elapsedMs = snapshot.elapsedMs;
    this.lastTimeMs = snapshot.timeMs;
  }

  settle(): void {
    if (!this.timerHandle) return;
    this._elapsedMs = Math.max(0, Date.now() - this.timerStart);
    const remaining = this.lastTimeMs - this._elapsedMs;
    this._timeMs = Math.max(0, remaining);
    this._byoyomi =
      remaining >= 0
        ? this.settings.byoyomi || 0
        : Math.max(0, Math.ceil((this.settings.byoyomi || 0) + remaining / 1000));
    if (this._timeMs === 0 && this._byoyomi === 0) this.timeout();
  }

  setup(settings: ClockSettings): void {
    this._settings = settings;
    this._timeMs = settings.timeMs || 0;
    this._byoyomi = settings.byoyomi || 0;
    this._elapsedMs = 0;
  }

  get settings(): ClockSettings {
    return this._settings;
  }

  get time(): number {
    return Math.ceil(this._timeMs / 1e3);
  }

  get timeMs(): number {
    return this._timeMs;
  }

  get byoyomi(): number {
    return this._byoyomi;
  }

  get elapsedMs(): number {
    return this._elapsedMs;
  }

  start(): void {
    this.clearTimer();
    this.timerStart = Date.now();
    this.lastTimeMs = this._timeMs;
    this._byoyomi = this.settings.byoyomi || 0;
    this._elapsedMs = 0;
    const generation = this.generation;
    this.timerHandle = window.setInterval(() => {
      if (generation !== this.generation) return;
      const lastTimeMs = this.timeMs;
      const lastByoyomi = this.byoyomi;
      this._elapsedMs = Date.now() - this.timerStart;
      const timeMs = this.lastTimeMs - this._elapsedMs;
      if (timeMs >= 0) {
        this._timeMs = timeMs;
      } else {
        this._timeMs = 0;
        this._byoyomi = Math.max(Math.ceil((this.settings.byoyomi || 0) + timeMs / 1e3), 0);
      }
      if (this.timeMs === 0 && this.byoyomi === 0) {
        this.timeout();
        return;
      }
      this.fireBeep(lastTimeMs, lastByoyomi);
    }, 100);
  }

  private fireBeep(lastTimeMs: number, lastByoyomi: number): void {
    // 秒に切り上げる。
    let time = Math.ceil(this.timeMs / 1e3);
    let lastTime = Math.ceil(lastTimeMs / 1e3);
    // 持ち時間があって秒読みが付いていれば何もしない。
    if (time !== 0 && this.byoyomi !== 0) {
      return;
    }
    // 持ち時間がなくなった瞬間に短いビープを鳴らす。
    if (time === 0 && lastTime !== 0) {
      if (this.settings.onBeepShort) {
        this.settings.onBeepShort();
      }
      return;
    }
    // 秒読みがある場合はその値を使う。
    if (this.byoyomi !== 0) {
      time = this.byoyomi;
      lastTime = lastByoyomi;
    }
    // 前回から秒が変わっていなければ何もしない。
    if (time === lastTime) {
      return;
    }
    // 残り 5 秒で長音, 10 秒以下, 20, 30, 60 秒で単音を鳴らす。
    if (time <= 5) {
      if (this.settings.onBeepUnlimited) {
        this.settings.onBeepUnlimited();
      }
    } else if (time <= 10 || time === 20 || time === 30 || time === 60) {
      if (this.settings.onBeepShort) {
        this.settings.onBeepShort();
      }
    }
  }

  pause(): void {
    this.clearTimer();
  }

  stop(): void {
    this.clearTimer();
    this.incrementTime();
  }

  private timeout(): void {
    this.clearTimer();
    this.settings.onTimeout?.();
  }

  private clearTimer(): void {
    ++this.generation;
    if (this.timerHandle) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = 0;
    }
    this.settings.onStopBeep?.();
  }

  private incrementTime(): void {
    this._timeMs += (this.settings.increment || 0) * 1e3;
  }

  correct(elapsedMsCorrection: number): void {
    this._elapsedMs += elapsedMsCorrection;
    if (this._elapsedMs < 0) {
      this._elapsedMs = 0;
    }

    const timeMs = this.lastTimeMs - this._elapsedMs;
    if (timeMs >= 0) {
      this._timeMs = timeMs;
      this._byoyomi = this.settings.byoyomi || 0;
    } else {
      this._timeMs = 0;
      this._byoyomi = Math.max(Math.ceil((this.settings.byoyomi || 0) + timeMs / 1e3), 0);
    }
  }
}
