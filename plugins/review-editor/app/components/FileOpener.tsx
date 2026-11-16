// The fileOpener: resolve where the file lives, then hand it to the editor.
// Files outside a workspace (thread storage, loose host paths), binaries and
// very large files go to bb's own preview.
import { experimental_useRpcQuery, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { FileRef } from "../../server/contract";
import { isRelativePath } from "../../server/shared";
import { clientContract } from "../contract";
import { useFileRead } from "../data";
import { EditorPage } from "./EditorPage";

function cleanPath(path: string): string | null {
  const clean = path.replace(/^\.\//u, "");
  return isRelativePath(clean) ? clean : null;
}

export function FileOpener({ path, source, experimental_lineRange, Original }: PluginFileOpenerProps) {
  if (source.kind === "workspace" && source.environmentId !== null) {
    const relative = cleanPath(path);
    if (relative === null) return <Original />;
    return (
      <Guard
        file={{ environmentId: source.environmentId, path: relative }}
        threadId={source.threadId}
        projectId={source.projectId}
        lineRange={experimental_lineRange}
        Original={Original}
      />
    );
  }
  if (source.kind === "host" && source.experimental_hostId !== undefined) {
    return (
      <HostFile
        hostId={source.experimental_hostId}
        path={path}
        threadId={source.threadId}
        projectId={source.projectId}
        lineRange={experimental_lineRange}
        Original={Original}
      />
    );
  }
  return <Original />;
}

type Rest = Pick<PluginFileOpenerProps, "Original"> & {
  threadId: string | null;
  projectId: string | null;
  lineRange: PluginFileOpenerProps["experimental_lineRange"];
};

function HostFile({ hostId, path, ...rest }: Rest & { hostId: string; path: string }) {
  const resolved = experimental_useRpcQuery({ contract: clientContract, method: "resolveHostFile", input: { hostId, path } });
  if (resolved.data === undefined) return resolved.error === null ? null : <rest.Original />;
  if (resolved.data === null) return <rest.Original />;
  return <Guard file={resolved.data} {...rest} />;
}

/** Text files open in the editor; everything else in bb's preview. */
function Guard({ file, threadId, projectId, lineRange, Original }: Rest & { file: FileRef }) {
  const read = useFileRead(file);
  if (read.data !== undefined && (read.data.status === "binary" || read.data.status === "too_large")) return <Original />;
  return <EditorPage key={`${file.environmentId}:${file.path}`} file={file} threadId={threadId} projectId={projectId} lineRange={lineRange} />;
}
