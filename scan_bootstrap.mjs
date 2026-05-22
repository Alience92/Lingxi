// Quick bootstrap scan - no API key needed for scanning
import { scanExistingMemoryFiles, buildInstallMessage } from "./dist/mcp/install.js";

const workspaceDir = process.argv[2] || "C:\\Users\\Administrator";
console.log(`Scanning workspace: ${workspaceDir}\n`);

const estimate = scanExistingMemoryFiles(workspaceDir);
const message = buildInstallMessage(estimate);

console.log(message);
console.log("\n--- Detailed scan results ---");
console.log(JSON.stringify(estimate, null, 2));
