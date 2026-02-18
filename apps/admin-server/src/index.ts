import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getEnv } from "./env.js";
import { UserStore } from "./auth/userStore.js";
import { LogBuffer } from "./logging/logBuffer.js";
import { ConfigStore } from "./runtime/configStore.js";
import { createApp, buildSnapshot, type Services } from "./app.js";
import { WsHub } from "./ws/wsHub.js";
import { BotController } from "./bot/botController.js";
import { StatsStore } from "./runtime/statsStore.js";

type ConfigStoreWithHook = ConfigStore & {
  set: (next: unknown) => Promise<unknown>;
  onAfterSet?: (next: unknown) => void;
};

function getProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "..", ".."),
    (() => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      return path.resolve(here, "..", "..", "..");
    })(),
  ];
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, "apps"))) return root;
  }
  return candidates[0] ?? cwd;
}

/**
 * 启动 HTTP + WebSocket 服务。
 */
export async function startAdminServer(input?: {
  env?: ReturnType<typeof getEnv>;
  projectRoot?: string;
}): Promise<{ shutdown: () => Promise<void>; url: string; host: string; port: number }> {
  const env = input?.env ?? getEnv();
  const projectRoot = input?.projectRoot ?? getProjectRoot();
  const dataDir = path.isAbsolute(env.DATA_DIR) ? env.DATA_DIR : path.resolve(projectRoot, env.DATA_DIR);

  const logBuffer = new LogBuffer({ dataDir });
  await logBuffer.append({ level: "info", scope: "SERVER", message: "Admin server booting..." });

  const userStore = new UserStore(dataDir);

  if (await userStore.needsBootstrap()) {
    try {
      await userStore.bootstrapAdmin(env.BOOTSTRAP_ADMIN_USERNAME, env.BOOTSTRAP_ADMIN_PASSWORD);
      await logBuffer.append({
        level: "info",
        scope: "AUTH",
        message: `Bootstrap admin created: ${env.BOOTSTRAP_ADMIN_USERNAME}`,
      });
    } catch {
      // ignore bootstrap race or transient state
    }
  }

  const configStore = new ConfigStore(dataDir);
  let configCache = await configStore.get();

  const statsStore = new StatsStore({ dataDir, logBuffer });
  await statsStore.load();

  const bot = new BotController({ projectRoot, logBuffer, configStore });

  const wsHub = new WsHub({ jwtSecret: env.JWT_SECRET, logBuffer });

  const services: Services = {
    env,
    projectRoot,
    userStore,
    logBuffer,
    configStore,
    statsStore,
    bot,
    getWsClientCount: () => wsHub.getClientCount(),
    getRuntimeConfig: () => configCache,
    shutdown: async () => {},
  };

  let logCleanupTimer: NodeJS.Timeout | null = null;
  const refreshLogCleanup = (cfg: typeof configCache): void => {
    if (logCleanupTimer) {
      clearInterval(logCleanupTimer);
      logCleanupTimer = null;
    }
    const enabled = Boolean(cfg.logs?.autoClearEnabled);
    const intervalHours = Number(cfg.logs?.autoClearIntervalHours ?? 24);
    if (!enabled || !Number.isFinite(intervalHours) || intervalHours < 1) return;
    const intervalMs = Math.max(60_000, Math.floor(intervalHours * 3600 * 1000));
    logCleanupTimer = setInterval(() => {
      void services.logBuffer
        .clear()
        .then(() =>
          services.logBuffer.append({
            level: "info",
            scope: "LOG",
            message: `Auto log cleanup executed (${intervalHours}h interval)`,
          })
        )
        .catch(() => undefined);
    }, intervalMs);
  };
  refreshLogCleanup(configCache);

  const app = createApp(services);

  const server = http.createServer(app);
  wsHub.attach(server, "/ws");

  const stopLogBroadcast = wsHub.startLogBroadcast();
  const stopSnapshotBroadcast = wsHub.startSnapshotBroadcast(() => buildSnapshot(services), 1500);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopLogBroadcast();
    stopSnapshotBroadcast();
    if (logCleanupTimer) {
      clearInterval(logCleanupTimer);
      logCleanupTimer = null;
    }
    wsHub.close();
    await bot.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  services.shutdown = shutdown;

  await new Promise<void>((resolve) => {
    server.listen(env.PORT, env.HOST, () => resolve());
  });

  const addr = server.address();
  const port =
    typeof addr === "object" && addr && "port" in addr && typeof addr.port === "number" ? addr.port : env.PORT;
  const host = env.HOST;
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${clientHost}:${port}`;

  await logBuffer.append({
    level: "info",
    scope: "SERVER",
    message: `Listening on ${url}`,
    details: { ws: `ws://${clientHost}:${port}/ws` },
  });

  process.on("SIGINT", async () => {
    await shutdown();
  });

  (configStore as ConfigStoreWithHook).onAfterSet = (saved) => {
    configCache = saved as typeof configCache;
    refreshLogCleanup(configCache);
    try {
      bot.applyRuntimeConfig(saved as typeof configCache);
    } catch {
      return;
    }
  };

  return { shutdown, url, host, port };
}

if (process.env.ADMIN_SERVER_NO_AUTORUN !== "1") {
  startAdminServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
