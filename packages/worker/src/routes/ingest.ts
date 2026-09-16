import type { Channel, IngestActivityItem, IngestDay, IngestPayload, CostStatus } from '@aiusage/shared';
import { jsonOk, jsonError } from '../utils/response.js';
import { verifyDeviceToken } from '../utils/token.js';
import { calculateIngestBreakdownCost, getWorstCostStatus } from '../utils/pricing.js';
import type { Env } from '../types.js';

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  // 校验 DEVICE_TOKEN
  const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!auth) return jsonError(401, 'INVALID_TOKEN', 'Missing authorization');

  const tokenPayload = await verifyDeviceToken(auth, env.DEVICE_TOKEN_SECRET);
  if (!tokenPayload) return jsonError(401, 'INVALID_TOKEN', 'Invalid device token');

  const body = await request.json<IngestPayload>();

  // 校验一致性
  if (body.siteId !== tokenPayload.siteId) {
    return jsonError(403, 'SITE_ID_MISMATCH', 'Site ID mismatch');
  }
  if (body.device.deviceId !== tokenPayload.deviceId) {
    return jsonError(403, 'DEVICE_ID_MISMATCH', 'Device ID mismatch');
  }

  // 校验设备状态与 token_version
  const device = await env.DB.prepare('SELECT status, token_version FROM devices WHERE device_id = ?')
    .bind(tokenPayload.deviceId)
    .first<{ status: string; token_version: number }>();

  if (!device) return jsonError(401, 'INVALID_TOKEN', 'Device not found');
  if (device.status !== 'active') return jsonError(403, 'DEVICE_DISABLED', 'Device has been disabled');
  if (device.token_version !== tokenPayload.tokenVersion) {
    return jsonError(401, 'TOKEN_VERSION_MISMATCH', 'Token version mismatch');
  }

  const now = new Date().toISOString();
  const costSummary: Record<string, { estimatedCostUsd: number; costStatus: CostStatus }> = {};

  for (const day of body.days) {
    const costStatuses: CostStatus[] = [];
    const breakdownsWithCost = [];
    let dayTotalCost = 0;
    let dayTotalEvents = 0;
    let dayTotalInput = 0;
    let dayTotalCachedInput = 0;
    let dayTotalCacheWrite = 0;
    let dayTotalOutput = 0;
    let dayTotalReasoning = 0;

    // 按 breakdown 写入
    for (const b of day.breakdowns) {
      const cacheWrite5mTokens = b.cacheWrite5mTokens ?? b.cacheWriteTokens;
      const cacheWrite1hTokens = b.cacheWrite1hTokens ?? 0;
      const cost = calculateIngestBreakdownCost(b);

      costStatuses.push(cost.costStatus);
      dayTotalCost += cost.estimatedCostUsd;
      dayTotalEvents += b.eventCount;
      dayTotalInput += b.inputTokens;
      dayTotalCachedInput += b.cachedInputTokens;
      dayTotalCacheWrite += b.cacheWriteTokens;
      dayTotalOutput += b.outputTokens;
      dayTotalReasoning += b.reasoningOutputTokens;
      breakdownsWithCost.push({ breakdown: b, cost, cacheWrite5mTokens, cacheWrite1hTokens });
    }

    const dayCostStatus = getWorstCostStatus(costStatuses);

    // 先写入父记录，避免 breakdown 外键约束失败
    await env.DB.prepare(`
      INSERT INTO daily_usage
        (device_id, usage_date, event_count, input_tokens, cached_input_tokens,
         cache_write_tokens, output_tokens, reasoning_output_tokens,
         estimated_cost_usd, cost_status, pricing_version,
         top_project_by_cost, top_project_cost_usd, top_model_by_cost, top_model_cost_usd,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (device_id, usage_date)
      DO UPDATE SET
        event_count = excluded.event_count,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        estimated_cost_usd = excluded.estimated_cost_usd,
        cost_status = excluded.cost_status,
        pricing_version = excluded.pricing_version,
        top_project_by_cost = excluded.top_project_by_cost,
        top_project_cost_usd = excluded.top_project_cost_usd,
        top_model_by_cost = excluded.top_model_by_cost,
        top_model_cost_usd = excluded.top_model_cost_usd,
        updated_at = excluded.updated_at
    `)
      .bind(
        tokenPayload.deviceId, day.usageDate,
        dayTotalEvents, dayTotalInput, dayTotalCachedInput, dayTotalCacheWrite,
        dayTotalOutput, dayTotalReasoning,
        Math.round(dayTotalCost * 10000) / 10000, dayCostStatus, 'current',
        'pending', 0,
        'pending', 0,
        now, now,
      )
      .run();

    const products = productsInDay(day);
    if (day.breakdowns.some(b => b.product === 'trae-cn' || b.product === 'trae-intl')) {
      products.add('trae');
    }
    await deleteBreakdownsForProducts(env, tokenPayload.deviceId, day.usageDate, [...products], Boolean(day.hourly));

    for (const { breakdown: b, cost, cacheWrite5mTokens, cacheWrite1hTokens } of breakdownsWithCost) {
      const rawProject = b.project || 'unknown';
      const isFullPath = rawProject.startsWith('/') || /^[A-Z]:\\/i.test(rawProject);
      const projectDisplay = b.projectDisplay ?? (isFullPath ? rawProject.split('/').filter(Boolean).pop() || 'unknown' : rawProject);
      const projectAlias = b.projectAlias ?? null;

      await env.DB.prepare(`
        INSERT INTO daily_usage_breakdown
          (device_id, usage_date, provider, product, channel, model, project,
           project_display, project_alias,
           event_count, session_count, input_tokens, cached_input_tokens, cache_write_tokens,
           output_tokens, reasoning_output_tokens, estimated_cost_usd, cost_status,
           pricing_version, extra_metrics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (device_id, usage_date, provider, product, channel, model, project)
        DO UPDATE SET
          project_display = excluded.project_display,
          project_alias = excluded.project_alias,
          event_count = excluded.event_count,
          session_count = excluded.session_count,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          estimated_cost_usd = excluded.estimated_cost_usd,
          cost_status = excluded.cost_status,
          pricing_version = excluded.pricing_version,
          extra_metrics_json = excluded.extra_metrics_json,
          updated_at = excluded.updated_at
      `)
        .bind(
          tokenPayload.deviceId, day.usageDate,
          b.provider, b.product, b.channel, b.model || 'unknown', rawProject,
          projectDisplay, projectAlias,
          b.eventCount, b.sessionCount ?? 0, b.inputTokens, b.cachedInputTokens, b.cacheWriteTokens,
          b.outputTokens, b.reasoningOutputTokens,
          cost.estimatedCostUsd, cost.costStatus, cost.pricingVersion,
          JSON.stringify({
            cache_write_5m_tokens: cacheWrite5mTokens,
            cache_write_1h_tokens: cacheWrite1hTokens,
          }),
          now, now,
        )
        .run();
    }

    if (Array.isArray(day.hourly)) {
      for (const bucket of day.hourly) {
        const hour = Math.trunc(Number(bucket.hour));
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
        for (const b of bucket.breakdowns ?? []) {
          const cacheWrite5mTokens = b.cacheWrite5mTokens ?? b.cacheWriteTokens;
          const cacheWrite1hTokens = b.cacheWrite1hTokens ?? 0;
          const cost = calculateIngestBreakdownCost(b);
          const rawProject = b.project || 'unknown';
          const isFullPath = rawProject.startsWith('/') || /^[A-Z]:\\/i.test(rawProject);
          const projectDisplay = b.projectDisplay ?? (isFullPath ? rawProject.split('/').filter(Boolean).pop() || 'unknown' : rawProject);
          const projectAlias = b.projectAlias ?? null;

          await env.DB.prepare(`
            INSERT INTO hourly_usage_breakdown
              (device_id, usage_date, usage_hour, provider, product, channel, model, project,
               project_display, project_alias,
               event_count, session_count, input_tokens, cached_input_tokens, cache_write_tokens,
               output_tokens, reasoning_output_tokens, estimated_cost_usd, cost_status,
               pricing_version, extra_metrics_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (device_id, usage_date, usage_hour, provider, product, channel, model, project)
            DO UPDATE SET
              project_display = excluded.project_display,
              project_alias = excluded.project_alias,
              event_count = excluded.event_count,
              session_count = excluded.session_count,
              input_tokens = excluded.input_tokens,
              cached_input_tokens = excluded.cached_input_tokens,
              cache_write_tokens = excluded.cache_write_tokens,
              output_tokens = excluded.output_tokens,
              reasoning_output_tokens = excluded.reasoning_output_tokens,
              estimated_cost_usd = excluded.estimated_cost_usd,
              cost_status = excluded.cost_status,
              pricing_version = excluded.pricing_version,
              extra_metrics_json = excluded.extra_metrics_json,
              updated_at = excluded.updated_at
          `)
            .bind(
              tokenPayload.deviceId, day.usageDate, hour,
              b.provider, b.product, b.channel, b.model || 'unknown', rawProject,
              projectDisplay, projectAlias,
              b.eventCount, b.sessionCount ?? 0, b.inputTokens, b.cachedInputTokens, b.cacheWriteTokens,
              b.outputTokens, b.reasoningOutputTokens,
              cost.estimatedCostUsd, cost.costStatus, cost.pricingVersion,
              JSON.stringify({
                cache_write_5m_tokens: cacheWrite5mTokens,
                cache_write_1h_tokens: cacheWrite1hTokens,
              }),
              now, now,
            )
            .run();
        }
      }
    }

    await replaceActivityMetrics(env, tokenPayload.deviceId, day.usageDate, day.activity?.items ?? [], now);

    // 计算 top project / model 并回填 daily_usage
    const topProject = await env.DB.prepare(`
      SELECT COALESCE(project_alias, project_display) as project, SUM(estimated_cost_usd) as total_cost
      FROM daily_usage_breakdown
      WHERE device_id = ? AND usage_date = ?
      GROUP BY COALESCE(project_alias, project_display) ORDER BY total_cost DESC LIMIT 1
    `).bind(tokenPayload.deviceId, day.usageDate)
      .first<{ project: string; total_cost: number }>();

    const topModel = await env.DB.prepare(`
      SELECT model, SUM(estimated_cost_usd) as total_cost
      FROM daily_usage_breakdown
      WHERE device_id = ? AND usage_date = ?
      GROUP BY model ORDER BY total_cost DESC LIMIT 1
    `).bind(tokenPayload.deviceId, day.usageDate)
      .first<{ model: string; total_cost: number }>();

    await env.DB.prepare(`
      UPDATE daily_usage
      SET top_project_by_cost = ?, top_project_cost_usd = ?,
          top_model_by_cost = ?, top_model_cost_usd = ?,
          updated_at = ?
      WHERE device_id = ? AND usage_date = ?
    `)
      .bind(
        topProject?.project ?? 'unknown', topProject?.total_cost ?? 0,
        topModel?.model ?? 'unknown', topModel?.total_cost ?? 0,
        now,
        tokenPayload.deviceId, day.usageDate,
      )
      .run();

    costSummary[day.usageDate] = {
      estimatedCostUsd: Math.round(dayTotalCost * 10000) / 10000,
      costStatus: dayCostStatus,
    };
  }

  // 更新 last_seen_at + 别名（sync 时自动同步本地别名）
  await env.DB.prepare(
    'UPDATE devices SET last_seen_at = ?, app_version = ?, public_label = COALESCE(?, public_label) WHERE device_id = ?',
  )
    .bind(now, body.device.appVersion, body.device.deviceAlias ?? null, tokenPayload.deviceId)
    .run();

  return jsonOk({ daysProcessed: body.days.length, costSummary });
}

/** Recalculate stored breakdown costs with the current shared catalog. */
export async function handleReprice(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!auth) return jsonError(401, 'INVALID_TOKEN', 'Missing authorization');

  const tokenPayload = await verifyDeviceToken(auth, env.DEVICE_TOKEN_SECRET);
  if (!tokenPayload) return jsonError(401, 'INVALID_TOKEN', 'Invalid device token');

  const device = await env.DB.prepare('SELECT status, token_version FROM devices WHERE device_id = ?')
    .bind(tokenPayload.deviceId)
    .first<{ status: string; token_version: number }>();

  if (!device) return jsonError(401, 'INVALID_TOKEN', 'Device not found');
  if (device.status !== 'active') return jsonError(403, 'DEVICE_DISABLED', 'Device has been disabled');
  if (device.token_version !== tokenPayload.tokenVersion) {
    return jsonError(401, 'TOKEN_VERSION_MISMATCH', 'Token version mismatch');
  }

  const product = new URL(request.url).searchParams.get('product')?.trim() || null;
  const now = new Date().toISOString();
  const dates = new Set<string>();
  let rowsUpdated = 0;
  let offset = 0;

  while (true) {
    const page = await env.DB.prepare(`
      SELECT usage_date, provider, product, channel, model, project, event_count,
             input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
             reasoning_output_tokens, extra_metrics_json
      FROM daily_usage_breakdown
      WHERE device_id = ?
        AND (? IS NULL OR product = ?)
      ORDER BY usage_date, provider, product, channel, model, project
      LIMIT 100 OFFSET ?
    `).bind(tokenPayload.deviceId, product, product, offset).all<{
      usage_date: string;
      provider: string;
      product: string;
      channel: string;
      model: string;
      project: string;
      event_count: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      extra_metrics_json: string | null;
    }>();

    const rows = page.results ?? [];
    if (rows.length === 0) break;

    const statements = rows.map((row) => {
      const extra = parseExtraMetrics(row.extra_metrics_json);
      const cost = calculateIngestBreakdownCost({
        provider: row.provider,
        product: row.product,
        channel: row.channel as Channel,
        model: row.model,
        project: row.project,
        eventCount: Number(row.event_count ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        cachedInputTokens: Number(row.cached_input_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        cacheWrite5mTokens: extra.cacheWrite5mTokens ?? Number(row.cache_write_tokens ?? 0),
        cacheWrite1hTokens: extra.cacheWrite1hTokens ?? 0,
        outputTokens: Number(row.output_tokens ?? 0),
        reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
      });
      dates.add(row.usage_date);
      return env.DB.prepare(`
        UPDATE daily_usage_breakdown
        SET estimated_cost_usd = ?, cost_status = ?, pricing_version = ?, updated_at = ?
        WHERE device_id = ? AND usage_date = ? AND provider = ? AND product = ?
          AND channel = ? AND model = ? AND project = ?
      `).bind(
        cost.estimatedCostUsd,
        cost.costStatus,
        cost.pricingVersion,
        now,
        tokenPayload.deviceId,
        row.usage_date,
        row.provider,
        row.product,
        row.channel,
        row.model,
        row.project,
      );
    });

    await env.DB.batch(statements);
    rowsUpdated += rows.length;
    offset += rows.length;
    if (rows.length < 100) break;
  }

  for (const usageDate of dates) {
    await refreshDailyUsageCost(env, tokenPayload.deviceId, usageDate, now);
  }

  return jsonOk({ rowsUpdated, daysUpdated: dates.size });
}

function parseExtraMetrics(raw: string | null): {
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cacheWrite5mTokens = Number(parsed.cache_write_5m_tokens ?? parsed.cacheWrite5mTokens);
    const cacheWrite1hTokens = Number(parsed.cache_write_1h_tokens ?? parsed.cacheWrite1hTokens);
    return {
      cacheWrite5mTokens: Number.isFinite(cacheWrite5mTokens) ? cacheWrite5mTokens : undefined,
      cacheWrite1hTokens: Number.isFinite(cacheWrite1hTokens) ? cacheWrite1hTokens : undefined,
    };
  } catch {
    return {};
  }
}

async function refreshDailyUsageCost(
  env: Env,
  deviceId: string,
  usageDate: string,
  now: string,
): Promise<void> {
  const rows = await env.DB.prepare(`
    SELECT estimated_cost_usd, cost_status
    FROM daily_usage_breakdown
    WHERE device_id = ? AND usage_date = ?
  `).bind(deviceId, usageDate).all<{ estimated_cost_usd: number; cost_status: CostStatus }>();

  const breakdowns = rows.results ?? [];
  const dayTotalCost = breakdowns.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0);
  const dayCostStatus = getWorstCostStatus(breakdowns.map((row) => row.cost_status));

  const topProject = await env.DB.prepare(`
    SELECT COALESCE(project_alias, project_display) as project, SUM(estimated_cost_usd) as total_cost
    FROM daily_usage_breakdown
    WHERE device_id = ? AND usage_date = ?
    GROUP BY COALESCE(project_alias, project_display) ORDER BY total_cost DESC LIMIT 1
  `).bind(deviceId, usageDate)
    .first<{ project: string; total_cost: number }>();

  const topModel = await env.DB.prepare(`
    SELECT model, SUM(estimated_cost_usd) as total_cost
    FROM daily_usage_breakdown
    WHERE device_id = ? AND usage_date = ?
    GROUP BY model ORDER BY total_cost DESC LIMIT 1
  `).bind(deviceId, usageDate)
    .first<{ model: string; total_cost: number }>();

  await env.DB.prepare(`
    UPDATE daily_usage
    SET estimated_cost_usd = ?, cost_status = ?, pricing_version = ?,
        top_project_by_cost = ?, top_project_cost_usd = ?,
        top_model_by_cost = ?, top_model_cost_usd = ?,
        updated_at = ?
    WHERE device_id = ? AND usage_date = ?
  `).bind(
    Math.round(dayTotalCost * 10000) / 10000,
    dayCostStatus,
    'current',
    topProject?.project ?? 'unknown',
    topProject?.total_cost ?? 0,
    topModel?.model ?? 'unknown',
    topModel?.total_cost ?? 0,
    now,
    deviceId,
    usageDate,
  ).run();
}

function productsInDay(day: IngestDay): Set<string> {
  const products = new Set<string>();
  for (const breakdown of day.breakdowns) {
    if (breakdown.product) products.add(breakdown.product);
  }
  for (const bucket of day.hourly ?? []) {
    for (const breakdown of bucket.breakdowns ?? []) {
      if (breakdown.product) products.add(breakdown.product);
    }
  }
  return products;
}

async function deleteBreakdownsForProducts(
  env: Env,
  deviceId: string,
  usageDate: string,
  products: string[],
  replaceHourly: boolean,
): Promise<void> {
  if (products.length === 0) return;
  const placeholders = products.map(() => '?').join(', ');
  await env.DB.prepare(
    `DELETE FROM daily_usage_breakdown WHERE device_id = ? AND usage_date = ? AND product IN (${placeholders})`,
  )
    .bind(deviceId, usageDate, ...products)
    .run();
  if (replaceHourly) {
    await env.DB.prepare(
      `DELETE FROM hourly_usage_breakdown WHERE device_id = ? AND usage_date = ? AND product IN (${placeholders})`,
    )
      .bind(deviceId, usageDate, ...products)
      .run();
  }
}

async function replaceActivityMetrics(
  env: Env,
  deviceId: string,
  usageDate: string,
  items: IngestActivityItem[],
  now: string,
): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM daily_activity_breakdown WHERE device_id = ? AND usage_date = ?')
      .bind(deviceId, usageDate)
      .run();

    for (const item of items) {
      const count = Math.max(0, Math.floor(Number(item.count ?? 0)));
      if (count === 0) continue;
      const rawProject = item.project || 'unknown';
      const isFullPath = rawProject.startsWith('/') || /^[A-Z]:\\/i.test(rawProject);
      const projectDisplay = item.projectDisplay ?? (isFullPath ? rawProject.split('/').filter(Boolean).pop() || 'unknown' : rawProject);

      await env.DB.prepare(`
        INSERT INTO daily_activity_breakdown
          (device_id, usage_date, provider, product, source, project,
           project_display, project_alias, kind, name, confidence, event_count,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          deviceId,
          usageDate,
          item.provider || 'unknown',
          item.product || 'unknown',
          item.source || `${item.provider || 'unknown'}/${item.product || 'unknown'}`,
          rawProject,
          projectDisplay,
          item.projectAlias ?? null,
          item.kind || 'unknown',
          item.name || 'unknown',
          item.confidence === 'proxy' ? 'proxy' : 'exact',
          count,
          now,
          now,
        )
        .run();
    }
  } catch (error) {
    if (String(error).includes('daily_activity_breakdown')) return;
    throw error;
  }
}
