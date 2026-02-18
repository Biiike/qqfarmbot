import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import axios from "axios";
import type { Env } from "./env.js";
import { asyncHandler } from "./http/asyncHandler.js";
import { errorMiddleware } from "./http/errorMiddleware.js";
import { httpError } from "./http/httpErrors.js";
import { requireAuth, requireRole } from "./auth/authMiddleware.js";
import { signAccessToken } from "./auth/jwt.js";
import { toPublicUser } from "./auth/types.js";
import type { UserStore } from "./auth/userStore.js";
import type { LogBuffer } from "./logging/logBuffer.js";
import type { ConfigStore } from "./runtime/configStore.js";
import type { CoreSnapshot } from "./runtime/runtimeState.js";
import { BotController } from "./bot/botController.js";
import type { RuntimeConfig } from "./runtime/runtimeState.js";
import type { StatsStore } from "./runtime/statsStore.js";

export type Services = {
  env: Env;
  projectRoot: string;
  userStore: UserStore;
  logBuffer: LogBuffer;
  configStore: ConfigStore;
  statsStore: StatsStore;
  bot: BotController;
  getWsClientCount: () => number;
  getRuntimeConfig: () => RuntimeConfig;
  shutdown: () => Promise<void>;
};

export function createApp(services: Services): express.Express {
  const app = express();

  app.use(
    cors({
      origin: true,
      credentials: false,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  type SeedListItem = {
    plantId: number;
    seedId: number;
    name: string;
    landLevelNeed: number;
    seasons: number;
    exp: number;
    fruitId: number | null;
    fruitCount: number | null;
    totalGrowSec: number | null;
    growPhases: Array<{ name: string; sec: number }>;
    shopAvailable: boolean;
    shopUnlocked: boolean;
  };

  type SeedListCache = { mtimeMs: number; shopMtimeMs: number; updatedAtMs: number; items: SeedListItem[] };
  let seedListCache: SeedListCache | null = null;

  /**
   * 从 gameConfig/Plant.json 构建“种子清单”对照表，并按文件 mtime 做缓存刷新。
   */
  function getSeedList(): SeedListCache {
    const filePath = path.join(services.projectRoot, "gameConfig", "Plant.json");
    const shopPath = path.join(services.projectRoot, "tools", "seed-shop-merged-export.json");
    const stat = fs.statSync(filePath);
    const shopStat = (() => {
      try {
        return fs.statSync(shopPath);
      } catch {
        return null;
      }
    })();
    const shopMtimeMs = shopStat ? shopStat.mtimeMs : 0;
    const cached = seedListCache;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.shopMtimeMs === shopMtimeMs) return cached;

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw httpError(500, "PLANT_CONFIG_INVALID");

    /**
     * 解析 grow_phases 字符串：例如 "种子:2400;发芽:2400;...;成熟:0;"
     */
    function parseGrowPhases(input: unknown): Array<{ name: string; sec: number }> {
      if (typeof input !== "string" || !input.trim()) return [];
      return input
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((pair) => {
          const idx = pair.indexOf(":");
          if (idx <= 0) return null;
          const name = pair.slice(0, idx).trim();
          const sec = Number(pair.slice(idx + 1));
          if (!name) return null;
          if (!Number.isFinite(sec) || sec < 0) return null;
          return { name, sec: Math.floor(sec) };
        })
        .filter((x): x is { name: string; sec: number } => Boolean(x));
    }

    /**
     * 解析商城导出文件，构建 seedId -> unlocked/exp 的索引。
     */
    function readShopSeedIndex(): Map<number, { unlocked: boolean; exp: number | null }> {
      try {
        const rawShop = fs.readFileSync(shopPath, "utf-8");
        const parsedShop = JSON.parse(rawShop) as unknown;
        const rows = (parsedShop as { rows?: unknown })?.rows;
        if (!Array.isArray(rows)) return new Map();
        const map = new Map<number, { unlocked: boolean; exp: number | null }>();
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const seedId = Number((row as { seedId?: unknown }).seedId);
          if (!Number.isFinite(seedId) || seedId <= 0) continue;
          const expRaw = Number((row as { exp?: unknown }).exp);
          const unlockedRaw = (row as { unlocked?: unknown }).unlocked;
          map.set(seedId, { unlocked: Boolean(unlockedRaw), exp: Number.isFinite(expRaw) ? expRaw : null });
        }
        return map;
      } catch {
        return new Map();
      }
    }

    const shopIndex = readShopSeedIndex();

    const items: SeedListItem[] = (parsed as Array<Record<string, unknown>>)
      .map((row) => {
        const plantId = Number(row.id);
        const seedId = Number(row.seed_id);
        const name = typeof row.name === "string" ? row.name : "";
        const landLevelNeed = Number(row.land_level_need);
        const seasons = Number(row.seasons);
        const expRaw = Number(row.exp);
        const fruit = row.fruit as { id?: unknown; count?: unknown } | undefined;
        const fruitId = fruit && fruit.id != null ? Number(fruit.id) : null;
        const fruitCount = fruit && fruit.count != null ? Number(fruit.count) : null;
        const growPhases = parseGrowPhases(row.grow_phases);
        const totalGrowSec =
          growPhases.length > 0 ? growPhases.reduce((sum, x) => sum + (Number.isFinite(x.sec) ? x.sec : 0), 0) : null;

        const shopMeta = shopIndex.get(seedId);
        const baseExp = Number.isFinite(expRaw) ? expRaw : 0;
        const shopExp = shopMeta?.exp ?? null;
        const expFinal = Number.isFinite(shopExp) ? Number(shopExp) : baseExp;

        if (!Number.isFinite(plantId) || plantId <= 0) return null;
        if (!Number.isFinite(seedId) || seedId <= 0) return null;
        if (!name) return null;

        return {
          plantId,
          seedId,
          name,
          landLevelNeed: Number.isFinite(landLevelNeed) ? landLevelNeed : 0,
          seasons: Number.isFinite(seasons) ? seasons : 0,
          exp: expFinal,
          fruitId: fruitId != null && Number.isFinite(fruitId) ? fruitId : null,
          fruitCount: fruitCount != null && Number.isFinite(fruitCount) ? fruitCount : null,
          totalGrowSec,
          growPhases,
          shopAvailable: Boolean(shopMeta),
          shopUnlocked: Boolean(shopMeta?.unlocked),
        } satisfies SeedListItem;
      })
      .filter((x): x is SeedListItem => Boolean(x))
      .sort((a, b) => a.seedId - b.seedId || a.plantId - b.plantId);

    seedListCache = { mtimeMs: stat.mtimeMs, shopMtimeMs, updatedAtMs: Date.now(), items };
    return seedListCache;
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      const bootstrapRequired = await services.userStore.needsBootstrap();
      if (bootstrapRequired) throw httpError(409, "BOOTSTRAP_REQUIRED");
      const body = z
        .object({
          username: z.string().min(1),
          password: z.string().min(1),
        })
        .parse(req.body);

      const user = await services.userStore.authenticate(body.username, body.password);
      if (!user) throw httpError(401, "INVALID_CREDENTIALS");
      const publicUser = toPublicUser(user);
      const token = signAccessToken(services.env.JWT_SECRET, publicUser);
      res.json({ token, user: publicUser });
    })
  );

  app.get(
    "/api/auth/bootstrap",
    asyncHandler(async (_req, res) => {
      const required = await services.userStore.needsBootstrap();
      res.json({ required });
    })
  );

  app.post(
    "/api/auth/bootstrap",
    asyncHandler(async (req, res) => {
      const required = await services.userStore.needsBootstrap();
      if (!required) throw httpError(409, "ALREADY_BOOTSTRAPPED");
      const body = z
        .object({
          username: z.string().min(3).max(32),
          password: z.string().min(8).max(128),
        })
        .parse(req.body);
      const user = await services.userStore.bootstrapAdmin(body.username, body.password);
      const publicUser = toPublicUser(user);
      const token = signAccessToken(services.env.JWT_SECRET, publicUser);
      res.json({ token, user: publicUser });
    })
  );

  app.get(
    "/api/auth/me",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (req, res) => {
      res.json({ user: req.auth });
    })
  );

  app.get(
    "/api/users",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (_req, res) => {
      const users = await services.userStore.listUsers();
      res.json({ users: users.map(toPublicUser) });
    })
  );

  app.get(
    "/api/config",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (_req, res) => {
      const config = await services.configStore.get();
      res.json({ config });
    })
  );

  app.put(
    "/api/config",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const config = await services.configStore.set(req.body);
      res.json({ config });
    })
  );

  app.get(
    "/api/seeds",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (req, res) => {
      const query = z
        .object({
          q: z.string().optional(),
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(50000).optional(),
          sortKey: z
            .enum(["name", "seedId", "plantId", "landLevelNeed", "seasons", "exp", "fruitId", "totalGrowSec"])
            .optional(),
          sortDir: z.enum(["asc", "desc"]).optional(),
        })
        .parse(req.query);

      /**
       * 按指定字段对列表排序（支持升降序）。
       */
      function sortItems(list: SeedListItem[], sortKey: string | undefined, sortDir: "asc" | "desc"): SeedListItem[] {
        if (!sortKey) return list;
        const dir = sortDir === "desc" ? -1 : 1;
        const copy = list.slice();
        copy.sort((a, b) => {
          if (sortKey === "name") return dir * a.name.localeCompare(b.name, "zh-Hans-CN");
          if (sortKey === "seedId") return dir * (a.seedId - b.seedId);
          if (sortKey === "plantId") return dir * (a.plantId - b.plantId);
          if (sortKey === "landLevelNeed") return dir * (a.landLevelNeed - b.landLevelNeed);
          if (sortKey === "seasons") return dir * (a.seasons - b.seasons);
          if (sortKey === "exp") return dir * (a.exp - b.exp);
          if (sortKey === "fruitId") {
            const av = a.fruitId ?? (sortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
            const bv = b.fruitId ?? (sortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
            return dir * (av - bv);
          }
          if (sortKey === "totalGrowSec") {
            const av = a.totalGrowSec ?? (sortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
            const bv = b.totalGrowSec ?? (sortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
            return dir * (av - bv);
          }
          return 0;
        });
        return copy;
      }

      const cache = getSeedList();
      const needle = (query.q ?? "").trim();
      const numNeedle = needle && /^\d+$/.test(needle) ? Number(needle) : null;

      const filtered = needle
        ? cache.items.filter((x) => {
            if (numNeedle != null && Number.isFinite(numNeedle)) {
              if (x.seedId === numNeedle) return true;
              if (x.plantId === numNeedle) return true;
              if (x.fruitId === numNeedle) return true;
            }
            return x.name.includes(needle);
          })
        : cache.items;

      const sorted = sortItems(filtered, query.sortKey, query.sortDir ?? "asc");
      const total = sorted.length;
      const page = query.page ?? 1;
      const pageSize = query.pageSize;
      const items = pageSize ? sorted.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) : sorted;

      res.json({ items, total, page, pageSize: pageSize ?? items.length, updatedAtMs: cache.updatedAtMs });
    })
  );

  app.get(
    "/api/seeds/lookup",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (req, res) => {
      const query = z
        .object({
          seedId: z.coerce.number().int().min(1),
        })
        .parse(req.query);

      const cache = getSeedList();
      const hit =
        cache.items.find((x) => x.seedId === query.seedId) ??
        cache.items.find((x) => x.plantId === query.seedId) ??
        cache.items.find((x) => x.fruitId === query.seedId) ??
        null;
      if (!hit) throw httpError(404, "NOT_FOUND");

      res.json({
        seed: { seedId: hit.seedId, plantId: hit.plantId, name: hit.name, updatedAtMs: cache.updatedAtMs },
      });
    })
  );

  const QrLibEnvelopeSchema = z
    .object({
      success: z.boolean().optional(),
      message: z.string().optional(),
    })
    .passthrough();

  const FARM_PRESET = "farm";
  const FARM_APP_ID = "1112386029";
  const FARM_QUA = "V1_HT5_QDT_0.70.2209190_x64_0_DEV_D";
  const enableBuiltinQrFallback = process.env.QRLIB_BUILTIN_FALLBACK !== "0";

  function isFarmPreset(preset: unknown): boolean {
    return typeof preset === "string" && preset.trim().toLowerCase() === FARM_PRESET;
  }

  function getErrorCode(err: unknown): string | null {
    if (!err || typeof err !== "object") return null;
    if (!("code" in err)) return null;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  function buildFarmHeaders(): Record<string, string> {
    return {
      qua: FARM_QUA,
      host: "q.qq.com",
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
    };
  }

  function buildQrImageFromUrl(url: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
  }

  async function builtInFarmCreatePayload(): Promise<Record<string, unknown>> {
    const resp = await axios.get("https://q.qq.com/ide/devtoolAuth/GetLoginCode", {
      headers: buildFarmHeaders(),
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", `内置扫码服务请求失败(${resp.status})`);
    }

    const parsed = z
      .object({
        code: z.union([z.number(), z.string()]),
        message: z.string().optional(),
        data: z
          .object({
            code: z.string().optional(),
          })
          .optional(),
      })
      .safeParse(resp.data);

    if (!parsed.success) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", "内置扫码服务返回格式异常");
    }

    const rootCode = Number(parsed.data.code);
    if (!Number.isFinite(rootCode) || rootCode !== 0) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", parsed.data.message || "内置扫码服务返回失败");
    }

    const loginCode = typeof parsed.data.data?.code === "string" ? parsed.data.data.code.trim() : "";
    if (!loginCode) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", "内置扫码服务未返回有效 qrsig");
    }

    const url = `https://h5.qzone.qq.com/qqq/code/${loginCode}?_proxy=1&from=ide`;
    return {
      success: true,
      isMiniProgram: true,
      provider: "builtin-farm",
      qrsig: loginCode,
      url,
      qrcode: buildQrImageFromUrl(url),
    };
  }

  async function builtInFarmCheckPayload(qrsig: string): Promise<Record<string, unknown>> {
    const statusResp = await axios.get(
      `https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${encodeURIComponent(qrsig)}`,
      {
        headers: buildFarmHeaders(),
        timeout: 10_000,
        validateStatus: () => true,
      }
    );

    if (statusResp.status < 200 || statusResp.status >= 300) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", `内置扫码状态查询失败(${statusResp.status})`);
    }

    const statusParsed = z
      .object({
        code: z.union([z.number(), z.string()]),
        message: z.string().optional(),
        data: z
          .object({
            ok: z.union([z.number(), z.string()]).optional(),
            ticket: z.string().optional(),
            uin: z.union([z.number(), z.string()]).optional(),
          })
          .optional(),
      })
      .safeParse(statusResp.data);

    if (!statusParsed.success) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", "内置扫码状态返回格式异常");
    }

    const rootCode = Number(statusParsed.data.code);
    if (!Number.isFinite(rootCode)) {
      throw httpError(424, "QRLIB_UPSTREAM_ERROR", "内置扫码状态码异常");
    }

    if (rootCode === -10003) {
      return { success: true, ret: "65", msg: "二维码已失效" };
    }

    if (rootCode !== 0) {
      return { success: true, ret: "66", msg: statusParsed.data.message || "等待扫码..." };
    }

    const ok = Number(statusParsed.data.data?.ok ?? 0);
    if (!Number.isFinite(ok) || ok !== 1) {
      return { success: true, ret: "66", msg: "等待扫码..." };
    }

    const ticket = typeof statusParsed.data.data?.ticket === "string" ? statusParsed.data.data.ticket.trim() : "";
    const uinRaw = statusParsed.data.data?.uin;
    const uin =
      typeof uinRaw === "string" ? uinRaw.trim() : typeof uinRaw === "number" && Number.isFinite(uinRaw) ? String(uinRaw) : "";
    const avatar = uin ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640` : "";

    if (!ticket) {
      return { success: true, ret: "67", msg: "已扫码，请在手机确认登录...", uin, avatar };
    }

    const authResp = await axios.post(
      "https://q.qq.com/ide/login",
      { appid: FARM_APP_ID, ticket },
      {
        headers: buildFarmHeaders(),
        timeout: 10_000,
        validateStatus: () => true,
      }
    );

    if (authResp.status < 200 || authResp.status >= 300) {
      return { success: true, ret: "67", msg: "已扫码，请稍后重试...", ticket, uin, avatar };
    }

    const authParsed = z
      .object({
        code: z.string().optional(),
      })
      .safeParse(authResp.data);
    const code = authParsed.success && typeof authParsed.data.code === "string" ? authParsed.data.code.trim() : "";

    if (!code) {
      return { success: true, ret: "67", msg: "已扫码，请稍后重试...", ticket, uin, avatar };
    }

    return {
      success: true,
      ret: "0",
      msg: "登录成功",
      code,
      ticket,
      uin,
      avatar,
    };
  }

  async function qrlibPost<T>(pathName: string, body: unknown): Promise<T> {
    const base = process.env.QRLIB_BASE_URL?.trim() ? process.env.QRLIB_BASE_URL.trim() : "http://127.0.0.1:5656";
    const url = new URL(pathName, base).toString();
    const maxAttempts = pathName === "/api/qr/create" ? 3 : 2;
    const isRetryableStatus = (status: number): boolean => [408, 409, 425, 429, 500, 502, 503, 504].includes(status);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const resp = await axios.post(url, body ?? {}, {
          timeout: 10_000,
          headers: { "content-type": "application/json" },
          validateStatus: () => true,
        });

        const payload: unknown = resp.data;
        const parsed = QrLibEnvelopeSchema.safeParse(payload);
        const payloadMessage = parsed.success ? parsed.data.message : undefined;

        if (resp.status < 200 || resp.status >= 300) {
          if (attempt < maxAttempts && isRetryableStatus(resp.status)) {
            await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
            continue;
          }
          throw httpError(424, "QRLIB_UPSTREAM_ERROR", payloadMessage || (typeof payload === "string" ? payload : undefined));
        }

        if (parsed.success && parsed.data.success === false) {
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
            continue;
          }
          throw httpError(424, "QRLIB_UPSTREAM_ERROR", payloadMessage || "二维码服务返回失败");
        }

        return payload as T;
      } catch (err) {
        if (err && typeof err === "object" && "status" in err && typeof err.status === "number") throw err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
          continue;
        }
        throw httpError(424, "QRLIB_UNAVAILABLE", `扫码服务不可用，请确认 QRLib 已启动且 QRLIB_BASE_URL 可访问（当前：${base}）`);
      }
    }

    throw httpError(424, "QRLIB_UNAVAILABLE", `扫码服务不可用，请确认 QRLib 已启动且 QRLIB_BASE_URL 可访问（当前：${base}）`);
  }

  app.post(
    "/api/qrlib/qr/create",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          preset: z.string().min(1).default("farm"),
        })
        .passthrough()
        .parse(req.body);
      let payload: unknown;
      try {
        payload = await qrlibPost<unknown>("/api/qr/create", body);
      } catch (err) {
        const code = getErrorCode(err);
        const canFallback =
          enableBuiltinQrFallback &&
          isFarmPreset(body.preset) &&
          (code === "QRLIB_UNAVAILABLE" || code === "QRLIB_UPSTREAM_ERROR");
        if (!canFallback) throw err;

        await services.logBuffer.append({
          level: "warn",
          scope: "QRLIB",
          message: "QRLib 不可用，已切换内置 farm 扫码兜底",
          details: { upstreamError: code },
        });
        payload = await builtInFarmCreatePayload();
      }
      const normalized = payload && typeof payload === "object" ? ({ ...payload } as Record<string, unknown>) : {};

      if (normalized.success === undefined) normalized.success = true;

      const rawData = normalized.data;
      const nested = rawData && typeof rawData === "object" ? (rawData as Record<string, unknown>) : null;

      if (!normalized.qrsig) {
        const fallbackSig =
          (typeof normalized.code === "string" && normalized.code.trim()) ||
          (nested && typeof nested.code === "string" && nested.code.trim()) ||
          "";
        if (fallbackSig) normalized.qrsig = fallbackSig;
      }

      if (!normalized.url && nested && typeof nested.url === "string" && nested.url.trim()) {
        normalized.url = nested.url;
      }

      if (!normalized.qrcode) {
        const directQr =
          (typeof normalized.image === "string" && normalized.image.trim()) ||
          (nested && typeof nested.qrcode === "string" && nested.qrcode.trim()) ||
          "";
        if (directQr) normalized.qrcode = directQr;
      }

      if (!normalized.qrcode && typeof normalized.url === "string" && normalized.url.trim()) {
        normalized.qrcode = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(normalized.url)}`;
      }

      if (
        normalized.success !== false &&
        typeof normalized.qrsig === "string" &&
        normalized.qrsig.trim() &&
        typeof normalized.qrcode === "string" &&
        normalized.qrcode.trim()
      ) {
        res.json(normalized);
        return;
      }

      throw httpError(424, "QRLIB_UPSTREAM_ERROR", "二维码服务返回数据不完整");
    })
  );

  app.post(
    "/api/qrlib/qr/check",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          qrsig: z.string().min(1),
          preset: z.string().min(1).default("farm"),
        })
        .passthrough()
        .parse(req.body);
      let payload: unknown;
      try {
        payload = await qrlibPost<unknown>("/api/qr/check", body);
      } catch (err) {
        const code = getErrorCode(err);
        const canFallback =
          enableBuiltinQrFallback &&
          isFarmPreset(body.preset) &&
          (code === "QRLIB_UNAVAILABLE" || code === "QRLIB_UPSTREAM_ERROR");
        if (!canFallback) throw err;

        await services.logBuffer.append({
          level: "warn",
          scope: "QRLIB",
          message: "QRLib 状态查询不可用，已切换内置 farm 扫码兜底",
          details: { upstreamError: code },
        });
        payload = await builtInFarmCheckPayload(body.qrsig);
      }
      const normalized = payload && typeof payload === "object" ? ({ ...payload } as Record<string, unknown>) : {};

      if (normalized.success === undefined) normalized.success = true;
      if (typeof normalized.ret === "number") normalized.ret = String(normalized.ret);
      if (!normalized.msg && typeof normalized.message === "string") normalized.msg = normalized.message;

      res.json(normalized);
    })
  );

  app.get(
    "/api/bot/status",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (_req, res) => {
      res.json({ status: services.bot.getStatus() });
    })
  );

  app.post(
    "/api/bot/start",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          code: z.string().min(5),
          platform: z.enum(["qq", "wx"]).optional(),
        })
        .parse(req.body);
      const didReset = await services.statsStore.resetIfCodeChanged(body.code);
      if (didReset) {
        await services.logBuffer.append({ level: "info", scope: "系统", message: "检测到 code 变更，统计已重置" });
      }
      const config = await services.configStore.get();
      await services.bot.start(BotController.toStartInput(config, body.code, body.platform));
      res.json({ ok: true, status: services.bot.getStatus() });
    })
  );

  app.post(
    "/api/bot/stop",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (_req, res) => {
      await services.bot.stop();
      res.json({ ok: true, status: services.bot.getStatus() });
    })
  );

  app.post(
    "/api/system/shutdown",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (_req, res) => {
      res.json({ ok: true });
      setTimeout(() => {
        void services.shutdown();
      }, 80);
    })
  );

  app.get(
    "/api/runtime/snapshot",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (_req, res) => {
      res.json({ snapshot: buildSnapshot(services) });
    })
  );

  app.get(
    "/api/logs",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (req, res) => {
      const query = z
        .object({
          level: z.enum(["debug", "info", "warn", "error"]).optional(),
          search: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);

      const { items, total } = services.logBuffer.query({
        filter: { level: query.level, search: query.search },
        page: query.page,
        pageSize: query.pageSize,
      });

      res.json({ items, total, page: query.page, pageSize: query.pageSize });
    })
  );

  app.get(
    "/api/logs/export",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (_req, res) => {
      res.download(services.logBuffer.getExportPath(), "logs.ndjson");
    })
  );

  app.get(
    "/api/logs/meta",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (_req, res) => {
      const sizeBytes = await services.logBuffer.getFileSizeBytes();
      const cfg = services.getRuntimeConfig();
      res.json({
        sizeBytes,
        path: services.logBuffer.getExportPath(),
        autoClearEnabled: Boolean(cfg.logs?.autoClearEnabled ?? false),
        autoClearIntervalHours: Number(cfg.logs?.autoClearIntervalHours ?? 24),
      });
    })
  );

  app.post(
    "/api/logs/clear",
    requireAuth(services.env.JWT_SECRET),
    requireRole("admin"),
    asyncHandler(async (_req, res) => {
      await services.logBuffer.clear();
      res.json({ ok: true });
    })
  );

  app.get(
    "/api/logs/:id",
    requireAuth(services.env.JWT_SECRET),
    asyncHandler(async (req, res) => {
      const id = z.string().parse(req.params.id);
      const entry = services.logBuffer.getById(id);
      if (!entry) throw httpError(404, "NOT_FOUND");
      res.json({ entry });
    })
  );

  const webDistDir = process.env.WEB_DIST_DIR?.trim()
    ? path.resolve(process.env.WEB_DIST_DIR.trim())
    : path.join(services.projectRoot, "apps", "admin-web", "dist");
  const webIndexPath = path.join(webDistDir, "index.html");
  if (fs.existsSync(webIndexPath)) {
    app.use(express.static(webDistDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(webIndexPath);
    });
  }

  app.use((_req, _res, next) => next(httpError(404, "NOT_FOUND")));
  app.use(errorMiddleware());

  return app;
}

export function buildSnapshot(services: Services): CoreSnapshot {
  const mem = process.memoryUsage();
  const config = services.getRuntimeConfig();
  const bot = services.bot.getStatus();
  const snapshot: CoreSnapshot = {
    ts: new Date().toISOString(),
    config,
    stats: {
      uptimeSec: Math.floor(process.uptime()),
      memoryRss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      wsClients: services.getWsClientCount(),
    },
    counters: services.statsStore.get(),
    bot: {
      running: bot.running,
      connected: bot.connected,
      platform: bot.platform,
      startedAt: bot.startedAt,
      user: bot.user,
      farmSummary: bot.farmSummary ?? null,
      lands: bot.lands ?? null,
      bag: bot.bag ?? null,
      visits: bot.visits ?? null,
      tasks: bot.tasks ?? null,
    },
  };
  return snapshot;
}
