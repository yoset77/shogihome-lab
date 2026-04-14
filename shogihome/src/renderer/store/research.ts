import { ResearchSettings, defaultResearchSettings } from "@/common/settings/research.js";
import { USIPlayer } from "@/renderer/players/usi.js";
import { LanPlayer } from "@/renderer/players/lan_player.js";
import { SearchInfo } from "@/renderer/players/player.js";
import { ImmutableRecord } from "tsshogi";
import { MultiPV, USIEngine, USIMultiPV } from "@/common/settings/usi.js";
import { SearchInfoSenderType } from "./record.js";
import { useAppSettings } from "./settings.js";
import { Lazy } from "@/renderer/helpers/lazy.js";

function cloneUSIEngineOptions(options: USIEngine["options"]): USIEngine["options"] {
  return Object.fromEntries(
    Object.entries(options).map(([name, option]) => [
      name,
      option.type === "combo" ? { ...option, vars: [...option.vars] } : { ...option },
    ]),
  );
}

function getSenderTypeByIndex(index: number): SearchInfoSenderType | undefined {
  switch (index) {
    case 0:
      return SearchInfoSenderType.RESEARCHER;
    case 1:
      return SearchInfoSenderType.RESEARCHER_2;
    case 2:
      return SearchInfoSenderType.RESEARCHER_3;
    case 3:
      return SearchInfoSenderType.RESEARCHER_4;
    default:
      return undefined;
  }
}

type UpdateSearchInfoCallback = (type: SearchInfoSenderType, info: SearchInfo) => void;
type ResearchErrorCallback = (e: unknown) => void;

type Engine = {
  usi: USIPlayer | LanPlayer;
  timer?: NodeJS.Timeout;
  paused: boolean;
};

export class ResearchManager {
  private settings = defaultResearchSettings();
  private engines: Engine[] = [];
  private ready: boolean = false;
  private stopping = false;
  private closingPromise?: Promise<void>;
  private onUpdateSearchInfo: UpdateSearchInfoCallback = () => {
    /* noop */
  };
  private onError: ResearchErrorCallback = () => {
    /* noop */
  };
  private record?: ImmutableRecord;
  private lazyPositionUpdate = new Lazy();
  private synced = true;

  on(event: "updateSearchInfo", handler: UpdateSearchInfoCallback): this;
  on(event: "error", handler: ResearchErrorCallback): this;
  on(event: string, handler: unknown): this {
    switch (event) {
      case "updateSearchInfo":
        this.onUpdateSearchInfo = handler as UpdateSearchInfoCallback;
        break;
      case "error":
        this.onError = handler as ResearchErrorCallback;
        break;
    }
    return this;
  }

  async launch(settings: ResearchSettings) {
    if (this.closingPromise) {
      await this.closingPromise;
    }
    this.settings = settings;

    // Validation
    if (settings.usi === undefined) {
      throw new Error("ResearchManager#launch: USIエンジンの設定は必須です。");
    }
    for (const s of settings.secondaries || []) {
      if (s.usi === undefined) {
        throw new Error("ResearchManager#launch: USIエンジンの設定は必須です。");
      }
    }
    if (this.engines.length > 0) {
      throw new Error(
        "ResearchManager#launch: 前回のエンジンが終了していません。数秒待ってからもう一度試してください。",
      );
    }

    // エンジンを設定する。
    const appSettings = useAppSettings();
    const usiEngines = [settings.usi, ...(settings.secondaries?.map((s) => s.usi) || [])];
    this.stopping = false;
    this.engines = usiEngines.map((usi, index) => {
      const type = getSenderTypeByIndex(index);

      if (usi!.uri.startsWith("lan-engine")) {
        const uri = usi!.uri;
        let engineId = "research";
        let engineName = uri;

        if (uri.startsWith("lan-engine:")) {
          engineId = uri.split(":")[1];
          engineName = usi!.name || engineId;
        } else if (uri === "lan-engine") {
          // legacy
          engineId = "research";
        }

        const sessionKey = index === 0 ? "research_main" : `research_sub_${index}`;

        return {
          usi: new LanPlayer(
            sessionKey,
            engineId,
            engineName,
            (info) => {
              if (type !== undefined && this.synced) {
                this.onUpdateSearchInfo(type, info);
              }
            },
            (e) => {
              this.onError(e);
            },
          ),
          paused: false,
        };
      }

      const options = cloneUSIEngineOptions(usi!.options);
      if (settings.overrideMultiPV) {
        if (options[USIMultiPV]?.type === "spin") {
          options[USIMultiPV].value = settings.multiPV;
        } else if (options[MultiPV]?.type === "spin") {
          options[MultiPV].value = settings.multiPV;
        }
      }
      const usiEngine: USIEngine = { ...usi!, options };
      return {
        usi: new USIPlayer(usiEngine, appSettings.engineTimeoutSeconds, (info) => {
          if (type !== undefined && this.synced) {
            this.onUpdateSearchInfo(type, info);
          }
        }),
        paused: false,
      };
    });

    // エンジンを起動する。
    try {
      await Promise.all(this.engines.map((engine) => engine.usi.launch()));
      if (settings.overrideMultiPV) {
        await Promise.all(this.engines.map((engine) => engine.usi.setMultiPV(settings.multiPV)));
      }
      await Promise.all(this.engines.map((engine) => engine.usi.readyNewGame()));
      if (this.stopping) {
        await this.close();
        return;
      }
      this.ready = true;
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  updatePosition(record: ImmutableRecord) {
    if (this.stopping) {
      return;
    }
    // 反映を遅延させるので同期済みフラグを下ろす。
    this.synced = false;
    // 200ms 以内に複数回更新されたら最後の 1 回だけを処理する。
    this.lazyPositionUpdate.after(() => {
      // 初期化処理が終わっていない場合は何もしない。
      if (!this.ready || this.stopping) {
        return;
      }
      // 一時停止中のエンジンを除いて探索を開始する。
      this.engines.forEach((engine) => {
        if (engine.paused) {
          return;
        }
        engine.usi.startResearch(record.position, record.usi).catch((e) => {
          this.onError(e);
        });
        // タイマーを初期化する。
        this.setupTimer(engine);
      });
      // 同期済みフラグを立てる。
      this.synced = true;
      // 一時停止からの再開のために棋譜を覚えておく。
      this.record = record;
    }, 200);
  }

  isPaused(sessionID: number): boolean {
    return this.engines.find((engine) => engine.usi.sessionID === sessionID)?.paused || false;
  }

  pause(sessionID: number): void;
  pause(): void;
  pause(sessionID?: number) {
    if (this.stopping) {
      return;
    }
    if (sessionID !== undefined) {
      const engine = this.engines.find((engine) => engine.usi.sessionID === sessionID);
      if (!engine) {
        return;
      }
      engine.paused = true;
      engine.usi.stop().catch((e) => {
        this.onError(e);
      });
    } else {
      this.engines.forEach((engine) => {
        if (!engine.paused) {
          engine.paused = true;
          engine.usi.stop().catch((e) => {
            this.onError(e);
          });
        }
      });
    }
  }

  unpause(sessionID: number): void;
  unpause(): void;
  unpause(sessionID?: number) {
    if (this.stopping) {
      return;
    }
    if (sessionID !== undefined) {
      const engine = this.engines.find((engine) => engine.usi.sessionID === sessionID);
      if (!engine) {
        return;
      }
      engine.paused = false;
      if (this.record) {
        engine.usi.startResearch(this.record.position, this.record.usi).catch((e) => {
          this.onError(e);
        });
        // タイマーを初期化する。
        this.setupTimer(engine);
      }
    } else {
      this.engines.forEach((engine) => {
        if (engine.paused) {
          engine.paused = false;
          if (this.record) {
            engine.usi.startResearch(this.record.position, this.record.usi).catch((e) => {
              this.onError(e);
            });
            // タイマーを初期化する。
            this.setupTimer(engine);
          }
        }
      });
    }
  }

  getMultiPV(sessionID: number): number | undefined {
    return this.engines.find((engine) => engine.usi.sessionID === sessionID)?.usi.multiPV;
  }

  setMultiPV(sessionID: number, multiPV: number) {
    if (this.stopping) {
      return;
    }
    const engine = this.engines.find((engine) => engine.usi.sessionID === sessionID);
    if (!engine || engine.usi.multiPV === undefined) {
      return;
    }
    // Stop the engine first, then change MultiPV, then resume.
    engine.usi
      .stop()
      .then(() => engine.usi.setMultiPV(multiPV))
      .then(() => {
        if (this.record && !engine.paused) {
          engine.usi.startResearch(this.record.position, this.record.usi).catch((e) => {
            this.onError(e);
          });
          // タイマーを初期化する。
          this.setupTimer(engine);
        }
      })
      .catch((e) => {
        this.onError(e);
      });
  }

  isSessionExists(sessionID: number): boolean {
    return this.engines.some((engine) => engine.usi.sessionID === sessionID);
  }

  hasLanEngine(): boolean {
    return this.engines.some((engine) => engine.usi instanceof LanPlayer);
  }

  private setupTimer(engine: Engine) {
    clearTimeout(engine.timer);
    if (this.settings.enableMaxSeconds && this.settings.maxSeconds > 0) {
      engine.timer = setTimeout(() => {
        engine.usi.stop().catch((e) => {
          this.onError(e);
        });
      }, this.settings.maxSeconds * 1e3);
    }
  }

  close(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }
    this.stopping = true;
    this.ready = false;
    this.synced = false;
    this.record = undefined;
    this.lazyPositionUpdate.clear();
    const enginesToClose = this.engines;
    this.engines = [];
    enginesToClose.forEach((engine) => clearTimeout(engine.timer));
    this.closingPromise = Promise.allSettled(
      enginesToClose.map((engine) => engine.usi.close()),
    ).then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected") {
          this.onError(result.reason);
        }
      });
      this.engines = [];
      this.ready = false;
      this.stopping = false;
      this.closingPromise = undefined;
    });
    return this.closingPromise;
  }
}
