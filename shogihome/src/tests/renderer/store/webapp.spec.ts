import { createStore } from "@/renderer/store/index.js";
import {
  exportJKFString,
  importJKFString,
  Move,
  Record,
  RecordMetadataKey,
  SpecialMoveType,
  specialMove,
} from "tsshogi";

describe("store/webapp", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("withUSENParam", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () =>
          "http://localhost/?usen=~0.7ku2jm6y20e45t2.&branch=0&ply=2&bname=bbb&wname=www",
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });
    const store = createStore();
    expect(store.isRecordFileUnsaved).toBeFalsy();
    expect(store.record.getUSI({ allMoves: true })).toBe(
      "position startpos moves 7g7f 3c3d 2g2f 4a3b 2f2e",
    );
    expect(store.record.moves).toHaveLength(6);
    expect(store.record.current.ply).toBe(2);
  });

  it("pcWeb/withLocalStorage", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });
    const store = createStore();
    store.doMove(store.record.position.createMoveByUSI("5g5f") as Move);
    vi.runAllTimers();
    const store2 = createStore();
    expect(store2.record.getUSI({ allMoves: true })).toBe("position startpos moves 5g5f");
  });

  it("pcWeb/metadataRestoration", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });
    const store = createStore();
    store.doMove(store.record.position.createMoveByUSI("7g7f") as Move);

    // Set Metadata
    store.updateStandardRecordMetadata({
      key: RecordMetadataKey.BLACK_NAME,
      value: "BlackPlayer",
    });
    store.updateStandardRecordMetadata({
      key: RecordMetadataKey.WHITE_NAME,
      value: "WhitePlayer",
    });
    store.updateStandardRecordMetadata({
      key: RecordMetadataKey.TITLE,
      value: "TestMatch",
    });

    vi.runAllTimers();

    const store2 = createStore();
    expect(store2.record.getUSI({ allMoves: true })).toBe("position startpos moves 7g7f");
    expect(store2.record.metadata.getStandardMetadata(RecordMetadataKey.BLACK_NAME)).toBe(
      "BlackPlayer",
    );
    expect(store2.record.metadata.getStandardMetadata(RecordMetadataKey.WHITE_NAME)).toBe(
      "WhitePlayer",
    );
    expect(store2.record.metadata.getStandardMetadata(RecordMetadataKey.TITLE)).toBe("TestMatch");
  });

  it("saveOnNavigate", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });
    const store = createStore();
    store.doMove(store.record.position.createMoveByUSI("7g7f") as Move);
    store.doMove(store.record.position.createMoveByUSI("3c3d") as Move);
    vi.runAllTimers();

    store.goBack();
    vi.runAllTimers();

    const store2 = createStore();
    // Should be at 1st move (7g7f)
    expect(store2.record.current.ply).toBe(1);
    expect(store2.record.moves).toHaveLength(3); // Record itself has 2 moves + startpos

    store.goForward();
    vi.runAllTimers();

    const store3 = createStore();
    // Should be at 2nd move (3c3d)
    expect(store3.record.current.ply).toBe(2);
  });

  it("jkf/branch-consistency", () => {
    const store = createStore();
    // 1. Setup a record with branches
    store.doMove(store.record.position.createMoveByUSI("7g7f") as Move);
    store.doMove(store.record.position.createMoveByUSI("3c3d") as Move);

    store.goBack(); // Back to 7g7f
    store.doMove(store.record.position.createMoveByUSI("8c8d") as Move);

    // 3. Export to JKF
    const jkf = exportJKFString(store.record);

    // 4. Import from JKF
    const restoredRecord = importJKFString(jkf);
    if (restoredRecord instanceof Error) {
      throw restoredRecord;
    }

    // 6. Verify Branch Structure
    restoredRecord.goto(2); // 7g7f -> 3c3d
    expect((restoredRecord.current.move as Move).usi).toBe("3c3d");

    restoredRecord.goto(1);
    // Check if branch exists linked from the next node (main branch node)
    const nextNode = restoredRecord.current.next;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const branchNode = (nextNode as any).branch;
    expect(branchNode).toBeDefined();
    expect(branchNode.move.usi).toBe("8c8d");
  });

  it("jkf/branch-restoration", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });

    const record = new Record();
    // 1. Setup a record with branches
    // Main branch (index 0): 7g7f -> 3c3d
    record.append(record.position.createMoveByUSI("7g7f") as Move);
    record.append(record.position.createMoveByUSI("3c3d") as Move);

    // Create a sub branch at ply 1: 7g7f -> 8c8d
    record.goto(1); // Back to 7g7f
    record.append(record.position.createMoveByUSI("8c8d") as Move);
    const jkf = exportJKFString(record);

    // 2. Select the sub branch (index 1) and stay at ply 2
    record.goto(1);
    record.switchBranchByIndex(1);
    record.goto(2);
    const [usen, branch] = record.usen;

    localStorage.setItem("webapp:jkf", jkf);
    localStorage.setItem("webapp:usen", usen);
    localStorage.setItem("webapp:branch", branch.toString());
    localStorage.setItem("webapp:ply", "2");

    // 3. Recreate store and check restoration
    const store2 = createStore();
    expect(store2.record.current.ply).toBe(2);
    // If branch 1 was restored correctly, the move at ply 2 should be 8c8d
    expect((store2.record.current.move as Move).usi).toBe("8c8d");
  });

  it("jkf/special-move-restoration", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });

    const record = new Record();
    record.append(record.position.createMoveByUSI("7g7f") as Move);
    record.append(record.position.createMoveByUSI("3c3d") as Move); // Branch 0 ends here (ply 2, 3c3d)
    record.goto(1);
    record.append(specialMove(SpecialMoveType.RESIGN)); // Branch 1 ends here (ply 2, Resign)
    const jkf = exportJKFString(record);

    // We were on branch 1, ply 2 (Resign)
    record.goto(1);
    record.switchBranchByIndex(1);
    record.goto(2); // Resign
    const [usen, branch] = record.usen;

    localStorage.setItem("webapp:jkf", jkf);
    localStorage.setItem("webapp:usen", usen);
    localStorage.setItem("webapp:branch", branch.toString());
    localStorage.setItem("webapp:ply", "2");

    const store = createStore();
    // It should correctly restore the Resign move, not the 3c3d move
    expect(store.record.current.move).toHaveProperty("type", SpecialMoveType.RESIGN);
    expect(store.record.current.ply).toBe(2);
  });

  it("jkf/special-move-propagation-fix", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });

    // 1. Setup a clean JKF record with two branches
    const record = new Record();
    record.append(record.position.createMoveByUSI("7g7f") as Move);
    record.append(record.position.createMoveByUSI("3c3d") as Move); // Branch 0 ends here
    record.goto(1);
    record.append(record.position.createMoveByUSI("8c8d") as Move); // Branch 1 ends here
    const jkf = exportJKFString(record);

    // 2. Setup a contaminated USEN (simulating the tsshogi bug)
    // Branch 0 has Resign (.r), and Branch 1 also incorrectly has Resign (.r)
    // USEN: ~0.7ku2jm.r~1.36e6y2.r (Assuming these are the USEN codes for the moves)
    // Here we just need a USEN that has a SpecialMove where the JKF doesn't.
    record.goto(2); // Branch 0 end
    record.append(specialMove(SpecialMoveType.RESIGN));
    const [contaminatedUsen] = record.usen;
    // contaminatedUsen will have .r at the end of branch 0.
    // In the actual bug, it would also appear at the end of branch 1 in the string,
    // but Record.newByUSEN would just parse it as is.
    // The point is that if we merged this USEN-record into the clean JKF-record,
    // Branch 1 of the JKF-record would also get the Resign move.

    localStorage.setItem("webapp:jkf", jkf);
    localStorage.setItem("webapp:usen", contaminatedUsen);
    localStorage.setItem("webapp:branch", "1");
    localStorage.setItem("webapp:ply", "2");

    const store = createStore();

    // Check Branch 1: It should NOT have Resign
    store.changeBranch(1);
    store.changePly(2);
    expect(store.record.current.move).not.toHaveProperty("type", "resign");
    expect((store.record.current.move as Move).usi).toBe("8c8d");
    expect(store.record.current.next).toBeNull(); // No next move (Resign) should exist

    // Check Branch 0: It should also NOT have Resign (because we didn't merge)
    store.changeBranch(0);
    store.changePly(2);
    expect(store.record.current.move).not.toHaveProperty("type", "resign");
    expect((store.record.current.move as Move).usi).toBe("3c3d");
    expect(store.record.current.next).toBeNull();
  });

  it("tsshogi/merge-preserves-path", () => {
    const record = new Record();
    record.append(record.position.createMoveByUSI("7g7f") as Move);
    record.append(record.position.createMoveByUSI("3c3d") as Move);
    record.goto(1);
    record.append(record.position.createMoveByUSI("8c8d") as Move);
    record.switchBranchByIndex(1);
    record.goto(2);
    expect((record.current.move as Move).usi).toBe("8c8d");

    const [usen, branch] = record.usen;
    const jkf = exportJKFString(record);

    // Restore path using USEN
    const restored = Record.newByUSEN(usen, branch, 2) as Record;
    expect((restored.current.move as Move).usi).toBe("8c8d");

    // Merge JKF data
    const dataRecord = importJKFString(jkf) as Record;
    restored.merge(dataRecord);

    // Check if path is still correct
    expect(restored.current.ply).toBe(2);
    expect((restored.current.move as Move).usi).toBe("8c8d");
  });

  it("mobileWeb/localStorage", () => {
    vi.stubGlobal("window", {
      location: {
        toString: () => "http://localhost/?mobile",
      },
      history: {
        replaceState: vi.fn(),
      },
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    });
    const store = createStore();
    store.doMove(store.record.position.createMoveByUSI("5g5f") as Move);
    vi.runAllTimers();
    const store2 = createStore();
    expect(store2.record.getUSI({ allMoves: true })).toBe("position startpos moves 5g5f");
  });
});
