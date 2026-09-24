#!/usr/bin/env node
// CI only. Reads a throwaway credential that the workflow just stored in
// Windows Credential Manager, through the same path Stage 8 uses from WSL2.
// The expected value is compared, never printed.
import { importTypeScriptModule } from "./doctor.mjs";
import path from "node:path";

const service = process.env.COUNCIL_CI_SECRET_SERVICE;
const expected = process.env.COUNCIL_CI_SECRET_EXPECTED;
if (!service || !expected) { console.error("COUNCIL_CI_SECRET_SERVICE and COUNCIL_CI_SECRET_EXPECTED are required"); process.exit(2); }
const { readSecret, detectSecretBackend } = await importTypeScriptModule(path.resolve(import.meta.dirname, ".."), "orchestrator/secretStore");
const backend = detectSecretBackend();
if (backend !== "windows-credential-manager") { console.error(`expected the WSL2 backend, detected ${backend}`); process.exit(3); }
const value = await readSecret(service);
if (value !== expected) { console.error("secret bridge returned a different value than stored"); process.exit(4); }
console.log("secret bridge OK through windows-credential-manager");
