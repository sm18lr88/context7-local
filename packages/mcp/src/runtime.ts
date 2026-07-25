export const SUPPORTED_NODE_MAJOR = 26;

export function assertSupportedNodeRuntime(nodeVersion: string = process.versions.node): void {
  const major = Number.parseInt(nodeVersion.split(".", 1)[0] ?? "", 10);
  if (major === SUPPORTED_NODE_MAJOR) return;

  throw new Error(
    `Context7 Local requires Node.js ${SUPPORTED_NODE_MAJOR}.x because its local SQLite index uses native modules. ` +
      `Detected Node.js ${nodeVersion}. Run the MCP server with Node.js ${SUPPORTED_NODE_MAJOR}.x or reinstall dependencies with the selected Node.js runtime.`
  );
}
