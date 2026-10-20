import { LogLevel } from "@/common/log";

const mocks = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const getLogger = vi.fn().mockReturnValue(logger);
  return {
    logger,
    getLogger,
    configure: vi.fn().mockReturnValue({ getLogger }),
    isTest: vi.fn(),
  };
});

vi.mock("log4js", () => ({ default: { configure: mocks.configure } }));
vi.mock("@/node/proc/env", () => ({ isTest: mocks.isTest }));

describe("server logging", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([
    { test: true, output: "recording" },
    { test: false, output: "stdout" },
  ])("initializes one $output logger lazily", async ({ test, output }) => {
    mocks.isTest.mockReturnValue(test);
    const { getAppLogger } = await import("@/node/log");
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(getAppLogger()).toBe(mocks.logger);
    expect(getAppLogger()).toBe(mocks.logger);
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith({
      appenders: { output: { type: output } },
      categories: { default: { appenders: ["output"], level: LogLevel.INFO } },
    });
    expect(mocks.getLogger).toHaveBeenCalledExactlyOnceWith("app");
  });
});
