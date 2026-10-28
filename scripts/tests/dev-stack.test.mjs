import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  assertSafeStateDir,
  buildCliTerminalWebSocketUrl,
  buildDevStackApiEnv,
  buildDevStackChildEnv,
  defaultDevStackPorts,
  defaultRepoRoot,
  ensureDevStackSecrets,
  formatReadyBanner,
  parseDevStackArgs,
  readPinnedComposeImages,
  readPinnedOpenCodePackageSpec,
  renderDevStackCompose,
  resetDevStack,
  resolvePackageBin,
  isRecordedDevStackProcess,
  listResponseItems,
  superviseChildProcesses,
  terminateRecordedProcesses,
  writeCliWrapperScripts
} from "../dev-stack.mjs";

test("readPinnedComposeImages extracts digest-pinned Postgres and Temporal images from compose template", () => {
  const composeTemplatePath = path.join(
    defaultRepoRoot,
    "packages",
    "run-spaceapp",
    "templates",
    "compose.yml"
  );
  const templateText = readFileSync(composeTemplatePath, "utf8");
  const { postgresImage, temporalImage } = readPinnedComposeImages(templateText);

  assert.match(postgresImage, /^pgvector\/pgvector:[^\s]+@sha256:[0-9a-f]{64}$/);
  assert.match(temporalImage, /^temporalio\/auto-setup:[^\s]+@sha256:[0-9a-f]{64}$/);

  assert.throws(
    () => readPinnedComposeImages("services:\n  postgres:\n    image: pgvector/pgvector:pg16\n"),
    /digest-pinned pgvector\/pgvector/
  );
});

test("readPinnedOpenCodePackageSpec extracts the pinned @opencode/cli version from Dockerfile", () => {
  const dockerfileText = readFileSync(path.join(defaultRepoRoot, "Dockerfile"), "utf8");
  const spec = readPinnedOpenCodePackageSpec(dockerfileText);
  assert.match(spec, /^@opencode\/cli@\d+\.\d+\.\d+$/);

  assert.throws(
    () => readPinnedOpenCodePackageSpec("FROM node:22-bookworm-slim\n"),
    /pinned @opencode\/cli/
  );
});

test("parseDevStackArgs applies isolated defaults and honors environment and CLI overrides", () => {
  const defaults = parseDevStackArgs([], {}, defaultRepoRoot);
  assert.equal(defaults.command, "up");
  assert.equal(defaults.apiPort, defaultDevStackPorts.apiPort);
  assert.equal(defaults.webPort, defaultDevStackPorts.webPort);
  assert.equal(defaults.postgresPort, defaultDevStackPorts.postgresPort);
  assert.equal(defaults.temporalPort, defaultDevStackPorts.temporalPort);
  assert.equal(defaults.stateDir, path.join(defaultRepoRoot, ".dev-stack"));

  const overridden = parseDevStackArgs(
    ["down", "--api-port", "6910", "--web-port=6911", "--state-dir", ".dev-stack-custom"],
    {
      SPACE_DEV_POSTGRES_PORT: "56432",
      SPACE_DEV_TEMPORAL_PORT: "58233",
      SPACE_DEV_STACK_PROJECT_NAME: "spaceapp-dev-custom"
    },
    defaultRepoRoot
  );
  assert.equal(overridden.command, "down");
  assert.equal(overridden.apiPort, 6910);
  assert.equal(overridden.webPort, 6911);
  assert.equal(overridden.postgresPort, 56432);
  assert.equal(overridden.temporalPort, 58233);
  assert.equal(overridden.projectName, "spaceapp-dev-custom");
  assert.equal(overridden.stateDir, path.join(defaultRepoRoot, ".dev-stack-custom"));
});

test("assertSafeStateDir refuses filesystem root, home, temp root, repo root, parents, and source dirs", () => {
  assert.throws(() => assertSafeStateDir("/", defaultRepoRoot), /unsafe state directory/);
  assert.throws(() => assertSafeStateDir(os.homedir(), defaultRepoRoot), /unsafe state directory/);
  assert.throws(() => assertSafeStateDir(os.tmpdir(), defaultRepoRoot), /unsafe state directory/);
  assert.throws(() => assertSafeStateDir(defaultRepoRoot, defaultRepoRoot), /unsafe state directory/);
  assert.throws(
    () => assertSafeStateDir(path.dirname(defaultRepoRoot), defaultRepoRoot),
    /unsafe state directory/
  );
  assert.throws(
    () => assertSafeStateDir(path.join(defaultRepoRoot, "apps", "api"), defaultRepoRoot),
    /unsafe state directory/
  );
  assert.throws(
    () => assertSafeStateDir(path.join(defaultRepoRoot, "packages"), defaultRepoRoot),
    /unsafe state directory/
  );
});

test("renderDevStackCompose binds ports strictly to 127.0.0.1 and pins digests", () => {
  const composeTemplatePath = path.join(
    defaultRepoRoot,
    "packages",
    "run-spaceapp",
    "templates",
    "compose.yml"
  );
  const { postgresImage, temporalImage } = readPinnedComposeImages(
    readFileSync(composeTemplatePath, "utf8")
  );
  const yaml = renderDevStackCompose({
    projectName: "spaceapp-dev",
    postgresImage,
    temporalImage,
    postgresPort: 55432,
    temporalPort: 57233,
    postgresPasswordFile: "/tmp/example/.dev-stack/secrets/postgres-password",
    temporalPasswordFile: "/tmp/example/.dev-stack/secrets/postgres-password-container"
  });

  assert.match(yaml, /"127\.0\.0\.1:55432:5432"/);
  assert.match(yaml, /"127\.0\.0\.1:57233:7233"/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
  assert.ok(yaml.includes(postgresImage));
  assert.ok(yaml.includes(temporalImage));
});

test("renderDevStackCompose configures Temporal the way the pinned auto-setup image expects", () => {
  const yaml = renderDevStackCompose({
    postgresImage: `pgvector/pgvector:pg17@sha256:${"a".repeat(64)}`,
    temporalImage: `temporalio/auto-setup:1.29.1@sha256:${"b".repeat(64)}`,
    postgresPasswordFile: "/tmp/example/.dev-stack/secrets/postgres-password",
    temporalPasswordFile: "/tmp/example/.dev-stack/secrets/postgres-password-container"
  });

  // temporalio/auto-setup ignores POSTGRES_PWD_FILE; the secret must be exported as POSTGRES_PWD.
  assert.doesNotMatch(yaml, /POSTGRES_PWD_FILE/);
  assert.ok(
    yaml.includes('export POSTGRES_PWD="$$(cat /run/secrets/postgres_password_temporal)"; exec /etc/temporal/entrypoint.sh autosetup')
  );
  // Temporal listens on the container IP, so a 127.0.0.1 health check never succeeds.
  assert.doesNotMatch(yaml, /--address", "127\.0\.0\.1:7233"/);
  assert.match(yaml, /temporal operator cluster health --address temporal:7233/);
  // The pinned auto-setup image ships config/dynamicconfig/docker.yaml, not development-sql.yaml.
  assert.match(yaml, /DYNAMIC_CONFIG_FILE_PATH: config\/dynamicconfig\/docker\.yaml/);
});

test("ensureDevStackSecrets and formatReadyBanner protect secrets and print setup token only while unclaimed", async () => {
  const scratchParent = mkdtempSync(path.join(os.tmpdir(), "spaceapp-dev-stack-test-"));
  const stateDir = path.join(scratchParent, ".dev-stack");
  try {
    const config = parseDevStackArgs(["--state-dir", stateDir], {}, defaultRepoRoot);
    const secrets = ensureDevStackSecrets(config);

    if (process.platform !== "win32") {
      assert.equal(statSync(secrets.secretsDir).mode & 0o777, 0o700);
      assert.equal(statSync(secrets.postgresPasswordFile).mode & 0o777, 0o600);
      assert.equal(statSync(secrets.sessionSecretFile).mode & 0o777, 0o600);
      assert.equal(statSync(secrets.setupTokenFile).mode & 0o777, 0o600);
      assert.equal(statSync(secrets.databaseUrlFile).mode & 0o777, 0o600);
    }

    const unclaimedBanner = formatReadyBanner({
      webOrigin: "http://127.0.0.1:5911",
      apiOrigin: "http://127.0.0.1:5910",
      setupRequired: true,
      setupToken: secrets.setupToken
    });
    assert.ok(unclaimedBanner.includes(secrets.setupToken));
    assert.ok(!unclaimedBanner.includes(secrets.sessionSecret));
    assert.ok(!unclaimedBanner.includes(secrets.databaseUrl));

    secrets.markSetupClaimed();
    assert.equal(secrets.isSetupClaimed(), true);

    const claimedBanner = formatReadyBanner({
      webOrigin: "http://127.0.0.1:5911",
      apiOrigin: "http://127.0.0.1:5910",
      setupRequired: false,
      setupToken: secrets.setupToken
    });
    assert.ok(!claimedBanner.includes(secrets.setupToken));
    assert.match(claimedBanner, /Owner setup:\s+already claimed/);

    const { env } = buildDevStackChildEnv(config, secrets, {});
    assert.equal(env.SPACE_PUBLIC_DISTRIBUTION, "true");
    assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
    assert.equal(env.SPACE_DEV_LOGIN, "false");
    assert.equal(env.SPACE_SETUP_TOKEN_FILE, undefined);
    // Only the API process receives the session secret value (apps/api reads SPACE_SESSION_SECRET only).
    assert.equal(env.SPACE_SESSION_SECRET, undefined);
    const apiEnv = buildDevStackApiEnv(env, secrets);
    assert.equal(apiEnv.SPACE_SESSION_SECRET, secrets.sessionSecret);
    assert.ok(apiEnv.SPACE_SESSION_SECRET.length >= 16);
    assert.equal(env.SPACE_SESSION_SECRET, undefined);

    const wrappers = writeCliWrapperScripts({
      stateDir,
      opencodeBinPath: "/usr/local/bin/opencode"
    });
    assert.equal(existsSync(wrappers.opencodeWrapperPath), true);
    const opencodeCfg = JSON.parse(readFileSync(wrappers.opencodeConfigFile, "utf8"));
    assert.equal(opencodeCfg.model, "opencode/big-pickle");

    await resetDevStack(config, { removeDocker: false });
    assert.equal(existsSync(stateDir), false);
  } finally {
    rmSync(scratchParent, { recursive: true, force: true });
  }
});

test("resetDevStack refuses to delete an unmarked non-empty custom directory", async () => {
  const unmarkedDir = mkdtempSync(path.join(os.tmpdir(), "spaceapp-unmarked-dir-"));
  try {
    mkdirSync(unmarkedDir, { recursive: true });
    writeFileSync(path.join(unmarkedDir, "important.txt"), "keep", "utf8");
    const config = parseDevStackArgs(["reset", "--state-dir", unmarkedDir], {}, defaultRepoRoot);
    await assert.rejects(
      () => resetDevStack(config, { removeDocker: false }),
      /Refusing to delete non-empty directory/
    );
    assert.equal(existsSync(path.join(unmarkedDir, "important.txt")), true);
  } finally {
    rmSync(unmarkedDir, { recursive: true, force: true });
  }
});

test("resetDevStack refuses to delete an unmarked .dev-stack-prefixed directory", async () => {
  const scratchParent = mkdtempSync(path.join(os.tmpdir(), "spaceapp-prefixed-dir-"));
  const prefixedDir = path.join(scratchParent, ".dev-stack-notes");
  try {
    mkdirSync(prefixedDir, { recursive: true });
    writeFileSync(path.join(prefixedDir, "notes.txt"), "keep", "utf8");
    const config = parseDevStackArgs(["reset", "--state-dir", prefixedDir], {}, defaultRepoRoot);
    await assert.rejects(
      () => resetDevStack(config, { removeDocker: false }),
      /Refusing to delete non-empty directory/
    );
    assert.equal(existsSync(path.join(prefixedDir, "notes.txt")), true);
  } finally {
    rmSync(scratchParent, { recursive: true, force: true });
  }
});

test("superviseChildProcesses stops sibling services and reports failure when a child exits unexpectedly", async () => {
  const fakeChildren = new Map();
  const fakeSpawn = (_cmd, _args, _opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.pid = 10000 + fakeChildren.size + 1;
    proc.kill = (signal = "SIGTERM") => {
      proc.signalCode = signal;
      proc.emit("exit", null, signal);
    };
    return proc;
  };

  const specs = [
    { name: "api", command: "node", args: ["api.js"], cwd: defaultRepoRoot, env: {} },
    { name: "worker", command: "node", args: ["worker.js"], cwd: defaultRepoRoot, env: {} }
  ];

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stderrText = "";
  stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
  });

  const supervisor = superviseChildProcesses(specs, {
    spawnProcess: (cmd, args, opts) => {
      const child = fakeSpawn(cmd, args, opts);
      fakeChildren.set(args[0], child);
      return child;
    },
    stdout,
    stderr
  });

  const workerChild = fakeChildren.get("worker.js");
  workerChild.exitCode = 2;
  workerChild.emit("exit", 2, null);

  const failure = await supervisor.failurePromise;
  assert.equal(failure.service, "worker");
  assert.equal(failure.code, 2);
  assert.match(stderrText, /service "worker" exited unexpectedly \(exit code 2\)/);
  assert.equal(fakeChildren.get("api.js").signalCode, "SIGTERM");
});

test("terminateRecordedProcesses verifies process identity and skips unrelated PIDs", async () => {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "spaceapp-pids-test-"));
  try {
    const pidsPath = path.join(scratchDir, "pids.json");
    writeFileSync(
      pidsPath,
      JSON.stringify({
        supervisorPid: 42001,
        repoRoot: defaultRepoRoot,
        stateDir: scratchDir,
        children: {
          "cli-host": 42002,
          unrelated: 42003
        }
      }),
      "utf8"
    );

    const alive = new Set([42001, 42002, 42003]);
    const signaled = [];
    const commands = new Map([
      [42001, `node ${path.join(defaultRepoRoot, "scripts", "dev-stack.mjs")}`],
      [42002, `node ${path.join(defaultRepoRoot, "packages", "cli-host", "dist", "main.js")}`],
      [42003, "/usr/sbin/sshd -D"]
    ]);

    assert.equal(
      isRecordedDevStackProcess(42001, {
        repoRoot: defaultRepoRoot,
        stateDir: scratchDir,
        inspectCommand: (pid) => commands.get(pid) ?? ""
      }),
      true
    );
    assert.equal(
      isRecordedDevStackProcess(42003, {
        repoRoot: defaultRepoRoot,
        stateDir: scratchDir,
        inspectCommand: (pid) => commands.get(pid) ?? ""
      }),
      false
    );

    await terminateRecordedProcesses(scratchDir, {
      repoRoot: defaultRepoRoot,
      inspectCommand: (pid) => commands.get(pid) ?? "",
      checkAlive: (pid) => alive.has(pid),
      sendSignal: (pid, sig) => {
        signaled.push({ pid, sig });
        alive.delete(pid);
      }
    });

    assert.deepEqual(signaled, [
      { pid: 42001, sig: "SIGTERM" },
      { pid: 42002, sig: "SIGTERM" }
    ]);
    assert.equal(alive.has(42003), true);
    assert.equal(existsSync(pidsPath), false);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("superviseChildProcesses restarts restartOnPackageRebuild services after incremental tsc rebuild", async () => {
  const spawned = [];
  const fakeSpawn = (_cmd, args, _opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.pid = 20000 + spawned.length + 1;
    proc.kill = (signal = "SIGTERM") => {
      proc.signalCode = signal;
      proc.emit("exit", null, signal);
    };
    spawned.push({ arg0: args[0], proc });
    return proc;
  };

  const specs = [
    { name: "packages", command: "npx", args: ["tsc"], cwd: defaultRepoRoot, env: {} },
    {
      name: "worker",
      command: "node",
      args: ["worker.js"],
      cwd: defaultRepoRoot,
      env: {},
      restartOnPackageRebuild: true
    }
  ];

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let updatedPids = null;

  const supervisor = superviseChildProcesses(specs, {
    spawnProcess: fakeSpawn,
    stdout,
    stderr,
    onPidsChanged: (pids) => {
      updatedPids = pids;
    }
  });

  const pkgProc = spawned[0].proc;
  // First watch completion is initial build -> should not restart worker yet
  pkgProc.stdout.write("Found 0 errors. Watching for file changes.\n");
  assert.equal(spawned.length, 2);

  // Second watch completion is an incremental rebuild -> should restart worker cleanly
  pkgProc.stdout.write("Found 0 errors. Watching for file changes.\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].arg0, "worker.js");
  assert.equal(updatedPids?.worker, spawned[2].proc.pid);

  await supervisor.stopAll();
});

test("isRecordedDevStackProcess requires the absolute checkout path for children", () => {
  const otherCheckout = path.join(os.tmpdir(), "other-spaceapp-checkout");
  const commands = new Map([
    [1, "node scripts/dev-stack.mjs"],
    [2, `node ${path.join(otherCheckout, "node_modules", "vite", "bin", "vite.js")} --port 5173`],
    [3, `node ${path.join(otherCheckout, "packages", "cli-host", "dist", "main.js")}`],
    [4, `node ${path.join(otherCheckout, "apps", "worker", "dist", "worker.js")}`],
    [5, "/usr/bin/invite-daemon"],
    [6, `node ${path.join(defaultRepoRoot, "node_modules", "vite", "bin", "vite.js")} --port 5173`]
  ]);
  const check = (pid, extra = {}) =>
    isRecordedDevStackProcess(pid, {
      repoRoot: defaultRepoRoot,
      inspectCommand: (p) => commands.get(p) ?? "",
      ...extra
    });

  // The relative supervisor marker is honoured only for the recorded supervisor PID.
  assert.equal(check(1, { isSupervisor: true }), true);
  assert.equal(check(1), false);
  // Generic "vite" and relative per-service paths from another checkout no longer match.
  for (const pid of [2, 3, 4, 5]) {
    assert.equal(check(pid), false, `pid ${pid} should not match`);
    assert.equal(check(pid, { isSupervisor: true }), false, `pid ${pid} should not match as supervisor`);
  }
  // Children launched with absolute paths under this checkout still match.
  assert.equal(check(6), true);
});

test("superviseChildProcesses serializes overlapping package rebuild restarts", async () => {
  const spawned = [];
  const fakeSpawn = (_cmd, args, _opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.pid = 21000 + spawned.length + 1;
    proc.kill = (signal = "SIGTERM") => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      // Exit asynchronously so a second rebuild can land while the first restart waits.
      setTimeout(() => {
        proc.signalCode = signal;
        proc.emit("exit", null, signal);
      }, 30);
    };
    spawned.push({ arg0: args[0], proc });
    return proc;
  };

  const specs = [
    { name: "packages", command: "npx", args: ["tsc"], cwd: defaultRepoRoot, env: {} },
    {
      name: "cli-host",
      command: "node",
      args: ["main.js"],
      cwd: defaultRepoRoot,
      env: {},
      restartOnPackageRebuild: true
    }
  ];

  let updatedPids = null;
  const supervisor = superviseChildProcesses(specs, {
    spawnProcess: fakeSpawn,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    onPidsChanged: (pids) => {
      updatedPids = pids;
    }
  });

  const pkgProc = spawned[0].proc;
  pkgProc.stdout.write("Found 0 errors. Watching for file changes.\n");
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Three incremental rebuilds while the first restart is still waiting for the old child.
  for (let i = 0; i < 3; i += 1) {
    pkgProc.stdout.write("Found 0 errors. Watching for file changes.\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  const hosts = spawned.filter((entry) => entry.arg0 === "main.js");
  // Initial start + the in-flight restart + exactly one coalesced pending rerun.
  assert.equal(hosts.length, 3);
  const live = hosts.filter(({ proc }) => proc.exitCode === null && proc.signalCode === null);
  assert.equal(live.length, 1);
  assert.equal(updatedPids?.["cli-host"], live[0].proc.pid);
  assert.equal(live[0].proc, hosts.at(-1).proc);

  await supervisor.stopAll();
});

test("resolvePackageBin points supervised tools at their JS entrypoints instead of npx wrappers", () => {
  const tsxBin = resolvePackageBin(path.join(defaultRepoRoot, "apps", "api"), "tsx");
  const viteBin = resolvePackageBin(path.join(defaultRepoRoot, "apps", "web"), "vite");
  const tscBin = resolvePackageBin(defaultRepoRoot, "typescript", "tsc");
  for (const bin of [tsxBin, viteBin, tscBin]) {
    assert.equal(path.isAbsolute(bin), true);
    assert.equal(existsSync(bin), true, `${bin} should exist`);
  }
  assert.match(tsxBin.replaceAll("\\", "/"), /node_modules\/tsx\//);
  assert.match(viteBin.replaceAll("\\", "/"), /node_modules\/vite\//);
  assert.match(tscBin.replaceAll("\\", "/"), /node_modules\/typescript\/bin\/tsc$/);
  assert.throws(() => resolvePackageBin(defaultRepoRoot, "typescript", "not-a-bin"), /does not declare/);
});

test("smoke helpers follow the API's paginated list shape and CLI terminal WebSocket contract", () => {
  assert.deepEqual(listResponseItems({ data: [{ id: "room:1" }], pagination: { page: 1 } }), [{ id: "room:1" }]);
  assert.equal(listResponseItems({ rooms: [] }), null);
  assert.equal(listResponseItems(null), null);

  const url = new URL(
    buildCliTerminalWebSocketUrl("http://127.0.0.1:5911", "pane:abc", {
      paneId: "pane:abc",
      sessionId: "cli_session:xyz",
      token: "t".repeat(32)
    })
  );
  assert.equal(url.protocol, "ws:");
  assert.equal(url.host, "127.0.0.1:5911");
  assert.equal(url.pathname, "/api/panes/pane%3Aabc/cli/terminal");
  assert.equal(url.searchParams.get("sessionId"), "cli_session:xyz");
  assert.equal(url.searchParams.get("token"), "t".repeat(32));
  assert.throws(() => buildCliTerminalWebSocketUrl("http://127.0.0.1:5911", "pane:abc", {}), /WebSocket ticket/);
});
