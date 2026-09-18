import { spawn } from "node:child_process";

const PROTOCOL = "campaign-council-process-tree-v1";
const CLEANUP_GRACE_MS = 500;
const SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGKILL", 137],
  ["SIGTERM", 143],
]);
const FORWARDABLE_SIGNALS = new Set(SIGNAL_EXIT_CODES.keys());

function fail(message, code = 125) {
  process.stderr.write(`Process-tree supervisor: ${message}\n`);
  process.exit(code);
}

function parseInvocation() {
  const [mode, separator, command, ...args] = process.argv.slice(2);
  if ((mode !== "outer" && mode !== "inner") || separator !== "--" || !command) {
    fail("invalid invocation");
  }
  return { mode, command, args };
}

function validControlMessage(message) {
  return Boolean(
    message
      && typeof message === "object"
      && message.protocol === PROTOCOL
      && message.type === "signal"
      && FORWARDABLE_SIGNALS.has(message.signal),
  );
}

function resultExitCode(result, requestedSignal) {
  if (requestedSignal) return SIGNAL_EXIT_CODES.get(requestedSignal) ?? 1;
  if (Number.isInteger(result?.code)) return result.code;
  if (typeof result?.signal === "string") {
    return SIGNAL_EXIT_CODES.get(result.signal) ?? 1;
  }
  return 125;
}

function sendMessage(target, message) {
  if (!target.connected) return;
  try {
    target.send(message, () => {
      // The receiving side may have closed while this message was queued.
    });
  } catch {
    // A disconnected peer is handled by the process close/disconnect path.
  }
}

function runOuter(command, args) {
  let requestedSignal;
  let targetResult;
  let inner;
  let settled = false;

  const requestShutdown = (signal = "SIGTERM") => {
    if (!FORWARDABLE_SIGNALS.has(signal)) signal = "SIGTERM";
    requestedSignal ??= signal;
    if (inner) {
      sendMessage(inner, { protocol: PROTOCOL, type: "signal", signal });
    }
  };

  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]) {
    process.on(signal, () => requestShutdown(signal));
  }
  process.on("message", (message) => {
    if (validControlMessage(message)) requestShutdown(message.signal);
  });
  process.on("disconnect", () => requestShutdown("SIGTERM"));

  try {
    inner = spawn(
      process.execPath,
      [process.argv[1], "inner", "--", command, ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      },
    );
  } catch {
    fail("could not start the process-group owner");
  }

  inner.on("message", (message) => {
    if (
      message
      && typeof message === "object"
      && message.protocol === PROTOCOL
      && message.type === "result"
    ) {
      targetResult = {
        code: Number.isInteger(message.code) ? message.code : null,
        signal: typeof message.signal === "string" ? message.signal : null,
      };
    }
  });
  inner.once("error", () => {
    if (settled) return;
    settled = true;
    fail("process-group owner failed to start");
  });
  inner.once("close", () => {
    if (settled) return;
    settled = true;
    process.exit(resultExitCode(targetResult, requestedSignal));
  });

  if (requestedSignal) requestShutdown(requestedSignal);
}

function runInner(command, args) {
  let cleanupStarted = false;
  let resultSent = false;

  const killOwnGroup = (signal) => {
    try {
      process.kill(-process.pid, signal);
    } catch {
      // This process is the group leader, so failure only occurs during exit.
    }
  };

  const beginCleanup = (signal = "SIGTERM") => {
    if (signal === "SIGKILL") {
      killOwnGroup("SIGKILL");
      return;
    }
    if (cleanupStarted) return;
    cleanupStarted = true;
    killOwnGroup(signal);
    setTimeout(() => killOwnGroup("SIGKILL"), CLEANUP_GRACE_MS);
  };

  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]) {
    process.on(signal, () => beginCleanup(signal));
  }
  process.on("message", (message) => {
    if (validControlMessage(message)) beginCleanup(message.signal);
  });
  process.on("disconnect", () => beginCleanup("SIGTERM"));

  let target;
  try {
    target = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      detached: false,
      stdio: "inherit",
    });
  } catch {
    sendMessage(process, {
      protocol: PROTOCOL,
      type: "result",
      code: 127,
      signal: null,
    });
    beginCleanup("SIGTERM");
    return;
  }

  const reportResult = (code, signal) => {
    if (resultSent) return;
    resultSent = true;
    const message = {
      protocol: PROTOCOL,
      type: "result",
      code: Number.isInteger(code) ? code : null,
      signal: typeof signal === "string" ? signal : null,
    };
    if (!process.connected) {
      beginCleanup("SIGTERM");
      return;
    }
    let fallback;
    const afterSend = () => {
      if (fallback) clearTimeout(fallback);
      beginCleanup("SIGTERM");
    };
    try {
      process.send(message, afterSend);
      // Do not let a blocked IPC callback defeat process-tree cleanup.
      fallback = setTimeout(afterSend, 100);
    } catch {
      afterSend();
    }
  };

  target.once("error", () => reportResult(127, null));
  target.once("exit", reportResult);
}

if (process.platform === "win32") {
  fail("Windows requires a Job Object implementation");
}

const { mode, command, args } = parseInvocation();
if (mode === "outer") runOuter(command, args);
else runInner(command, args);
