import { RecordFileFormat } from "@/common/file/record";
import { ImmutableNode, ImmutableRecord } from "tsshogi";

export type RecordProperties = {
  branch: boolean;
  comment: boolean;
  bookmark: boolean;
  time: boolean;
};

/**
 * 指定ノードの兄弟分岐の一覧を返します。
 * 分岐が存在しない(単一手)場合は null を返します。
 */
export function getSiblingBranches(
  record: ImmutableRecord,
  node: ImmutableNode,
): ImmutableNode[] | null {
  const start = node.prev ? node.prev.next : record.first;
  if (!start || !start.branch) {
    return null;
  }
  const branches: ImmutableNode[] = [];
  for (let p: ImmutableNode | null = start; p; p = p.branch) {
    branches.push(p);
  }
  return branches.length >= 2 ? branches : null;
}

export function detectUnsupportedRecordProperties(
  record: ImmutableRecord,
  fileType: RecordFileFormat,
): RecordProperties {
  const props: RecordProperties = {
    branch: false,
    comment: false,
    bookmark: false,
    time: false,
  };
  if (fileType === RecordFileFormat.KIF || fileType === RecordFileFormat.KIFU) {
    return props;
  }
  record.forEach((node) => {
    if (node.branch) {
      props.branch = true;
    }
    if (node.comment) {
      props.comment = true;
    }
    if (node.bookmark) {
      props.bookmark = true;
    }
    if (node.elapsedMs) {
      props.time = true;
    }
  });
  switch (fileType) {
    case RecordFileFormat.KI2:
    case RecordFileFormat.KI2U:
      props.branch = false;
      props.comment = false;
      props.bookmark = false;
      break;
    case RecordFileFormat.CSA:
      props.comment = false;
      props.time = false;
      break;
    case RecordFileFormat.SFEN:
      break;
    case RecordFileFormat.JKF:
      props.branch = false;
      props.comment = false;
      props.time = false;
      break;
  }
  return props;
}
