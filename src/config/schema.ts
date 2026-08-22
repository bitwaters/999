import { z } from 'zod';

const decimal = z.number().finite().nonnegative();
const percent = z.number().finite().min(0).max(1);
const chatId = z.string().regex(/^-?\d+$/u, 'Telegram IDs must be decimal strings');
const interval = z.enum(['1m', '5m']);
const enabledThreshold = z
  .object({ enabled: z.boolean(), verified: z.boolean(), max: percent })
  .strict();

const discoverySchema = z
  .object({
    trending_intervals: z.array(interval).min(1),
    hot_search_interval: interval,
    poll_interval_seconds: z.number().int().positive(),
    candidate_ttl_seconds: z.number().int().positive(),
    max_candidates: z.number().int().positive(),
    unresolved_retry_initial_seconds: z.number().int().positive(),
    unresolved_retry_max_seconds: z.number().int().positive(),
  })
  .strict();

const newbornSchema = z
  .object({
    max_age_seconds: z.number().int().positive(),
    min_g2_observation_seconds: z.number().int().positive(),
    min_absolute: z
      .object({
        buys: z.number().int().nonnegative(),
        buyers: z.number().int().nonnegative(),
        volume_usd: decimal,
      })
      .strict(),
    min_rate_per_second: z.object({ buys: decimal, buyers: decimal, volume_usd: decimal }).strict(),
  })
  .strict();

const establishedSchema = z
  .object({
    min_age_seconds: z.number().int().positive(),
    required_windows: z.array(z.enum(['m5', 'm15', 'm30'])).min(1),
  })
  .strict();

const level1Schema = z
  .object({
    refresh_interval_seconds: z.number().int().min(30).max(60),
    buyers_freshness_seconds: z.number().int().positive(),
  })
  .strict();

const solSafetySchema = z
  .object({
    freshness_seconds: z.number().int().positive(),
    s0: z
      .object({
        renounced_mint_required: z.literal(true),
        renounced_freeze_account_required: z.literal(true),
        verified: z.boolean(),
      })
      .strict(),
    s1: z
      .object({
        top_10_holder_rate: enabledThreshold,
        dev_team_hold_rate: enabledThreshold,
        bundler_rate: enabledThreshold,
        rug_ratio: enabledThreshold,
      })
      .strict(),
  })
  .strict();

const bscSafetySchema = z
  .object({
    freshness_seconds: z.number().int().positive(),
    s0: z
      .object({
        honeypot_must_be_false: z.literal(true),
        ownership_renounced_required: z.literal(true),
        open_source_required: z.literal(true),
        max_buy_tax: percent,
        max_sell_tax: percent,
        verified: z.boolean(),
      })
      .strict(),
    s1: z
      .object({
        top_10_holder_rate: enabledThreshold,
        dev_team_hold_rate: enabledThreshold,
        rug_ratio: enabledThreshold,
      })
      .strict(),
  })
  .strict();

const chainBaseSchema = z
  .object({
    discovery: discoverySchema,
    safety: z.unknown(),
    level1: level1Schema,
    newborn: newbornSchema,
    established: establishedSchema,
  })
  .strict();

const chainConfig = z
  .object({
    sol: chainBaseSchema.extend({ safety: solSafetySchema }),
    bsc: chainBaseSchema.extend({ safety: bscSafetySchema }),
  })
  .strict();

const providerSchema = z
  .object({
    gmgn: z
      .object({
        api_key_env: z.string().min(1),
        request_timeout_ms: z.number().int().positive(),
        max_response_bytes: z.number().int().positive(),
        max_decompressed_bytes: z.number().int().positive(),
        retry: z
          .object({
            max_attempts: z.number().int().min(1).max(10),
            base_delay_ms: z.number().int().positive(),
            max_delay_ms: z.number().int().positive(),
          })
          .strict(),
        rate_limit: z
          .object({
            discovery_weight: z.number().int().positive(),
            safety_weight: z.number().int().positive(),
            minimum_interval_ms: z.number().int().nonnegative(),
          })
          .strict(),
        signal_type_allowlist: z.array(z.number().int().min(1).max(21)).min(1),
      })
      .strict(),
    coingecko: z
      .object({
        api_key_env: z.string().min(1),
        rest_base_url: z.string().url(),
        websocket_url: z.string().url(),
        request_timeout_ms: z.number().int().positive(),
        max_response_bytes: z.number().int().positive(),
        max_decompressed_bytes: z.number().int().positive(),
        rest_requests_per_minute: z.number().int().positive(),
        monthly_credits: z.number().int().positive(),
        max_pools_per_batch: z.literal(50),
        scheduler: z
          .object({
            max_due_pools_per_chain: z.number().int().min(50),
            batch_concurrency: z.number().int().min(1).max(8),
            finalist_trades_concurrency: z.number().int().min(1).max(8),
            merge_delay_ms: z.number().int().min(200).max(500),
            scan_interval_seconds: z.number().int().min(1).max(10),
            cache_ttl_seconds: z.number().int().min(1).max(30),
            dynamic_recheck_seconds: z.number().int().min(1).max(60),
            key_refresh_seconds: z.number().int().min(30).max(600),
            max_dynamic_wait_seconds: z.number().int().min(10).max(300),
            reservation_ttl_seconds: z.number().int().min(10).max(120),
            initialization_retry: z
              .object({
                max_attempts: z.number().int().min(1).max(3),
                base_delay_ms: z.number().int().positive(),
                max_delay_ms: z.number().int().positive(),
              })
              .strict(),
            deadline_promotion_seconds: z.number().int().min(10).max(120),
            confirmation_reserved_percent: z.number().int().min(0).max(100),
            outcome_reserved_percent: z.number().int().min(0).max(100),
            backlog_high_watermark: z.number().int().positive(),
            backlog_hard_limit: z.number().int().positive(),
            shutdown_drain_ms: z.number().int().min(1000).max(30000),
          })
          .strict(),
        credit_buckets: z
          .object({
            pool_screening_percent: z.number().int().nonnegative(),
            g2_confirmation_percent: z.number().int().nonnegative(),
            outcome_percent: z.number().int().nonnegative(),
            recovery_percent: z.number().int().nonnegative(),
            reserve_percent: z.number().int().nonnegative(),
          })
          .strict(),
        g2: z
          .object({
            max_sockets: z.literal(1),
            max_subscriptions_per_socket: z.number().int().positive(),
            rolling_credits_per_message_upper_bound: decimal,
          })
          .strict(),
      })
      .strict(),
    telegram: z
      .object({
        bot_token_env: z.string().min(1),
        request_timeout_ms: z.number().int().positive(),
        max_response_bytes: z.number().int().positive(),
        max_decompressed_bytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const deliveryDestination = z.object({ enabled: z.boolean(), chat_id: chatId }).strict();

export const configSchema = z
  .object({
    meta: z
      .object({ project_name: z.string().min(1), config_schema_version: z.literal(1) })
      .strict(),
    global: z
      .object({
        run_mode: z.enum(['shadow', 'production']),
        timezone: z.string().min(1),
        max_clock_skew_seconds: z.number().int().nonnegative(),
      })
      .strict(),
    providers: providerSchema,
    chains: chainConfig,
    strategies: z
      .object({
        emerging_breakout: z
          .object({
            attention: z
              .object({
                max_rank: z.number().int().positive(),
                min_rank_improvement: z.number().int().nonnegative(),
                min_hot_search_growth: decimal,
              })
              .strict(),
            conviction: z
              .object({
                min_net_buy_usd: decimal,
                min_buy_volume_share: percent,
                min_buyers: z.number().int().positive(),
              })
              .strict(),
            organic_growth: z.object({ max_top1_share: percent, max_top3_share: percent }).strict(),
            entry_quality: z
              .object({
                min_reserve_usd: decimal,
                max_price_extension: decimal,
                max_pre_send_drift: decimal,
              })
              .strict(),
            cooldown_seconds: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    outcomes: z
      .object({
        horizons_seconds: z.array(z.number().int().positive()).min(1),
        entry_timeout_seconds: z.number().int().positive(),
        entry_max_event_delay_seconds: z.number().int().nonnegative(),
        max_future_event_skew_seconds: z.number().int().nonnegative(),
        outcome_max_lateness_seconds: z.number().int().nonnegative(),
        candle_interval_seconds: z.literal(30),
        rest_poll_segments_seconds: z.array(z.number().int().positive()).min(1),
      })
      .strict(),
    storage: z
      .object({
        database_path: z.string().min(1),
        backup_directory: z.string().min(1),
        replay_temp_directory: z.string().min(1),
        busy_timeout_ms: z.number().int().nonnegative(),
        max_write_rows: z.number().int().positive(),
        max_write_ms: z.number().int().positive(),
        disk_high_water_percent: z.number().int().min(1).max(99),
        backup_interval_seconds: z.number().int().positive(),
        backup_retention: z.number().int().positive(),
      })
      .strict(),
    delivery: z
      .object({
        outcome_anchor_destination: z.enum(['admin_private', 'channel', 'group']),
        entry_delivery_ttl_seconds: z.number().int().positive(),
        retry: z
          .object({
            max_attempts: z.number().int().positive(),
            base_delay_ms: z.number().int().positive(),
            max_delay_ms: z.number().int().positive(),
          })
          .strict(),
        report_max_age_seconds: z.number().int().positive(),
        system_max_age_seconds: z.number().int().positive(),
        admin_private: deliveryDestination.extend({ allowed_user_ids: z.array(chatId).min(1) }),
        channel: deliveryDestination,
        group: deliveryDestination,
      })
      .strict(),
    runtime: z
      .object({
        g2_queue: z
          .object({
            capacity: z.number().int().positive(),
            high_watermark: z.number().int().positive(),
            hard_limit: z.number().int().positive(),
          })
          .strict(),
        event_loop_lag: z
          .object({
            sample_interval_ms: z.number().int().positive(),
            incomplete_threshold_ms: z.number().int().positive(),
          })
          .strict(),
        sqlite: z
          .object({
            transaction_max_rows: z.number().int().positive(),
            transaction_max_ms: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    replay: z
      .object({
        delivery_delay_ms: z.number().int().nonnegative(),
        backup_page_batch: z.number().int().positive(),
        result_write_batch: z.number().int().positive(),
        max_scan_rows: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const buckets = config.providers.coingecko.credit_buckets;
    const bucketTotal = Object.values(buckets).reduce((sum, value) => sum + value, 0);
    if (bucketTotal !== 100)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'credit_buckets'],
        message: 'Credit bucket percentages must total 100',
      });

    const scheduler = config.providers.coingecko.scheduler;
    if (scheduler.confirmation_reserved_percent + scheduler.outcome_reserved_percent >= 100)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'scheduler'],
        message: 'Scheduler reserved percentages must leave shared capacity',
      });
    if (scheduler.backlog_high_watermark >= scheduler.backlog_hard_limit)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'scheduler'],
        message: 'Scheduler backlog requires high < hard',
      });
    if (scheduler.dynamic_recheck_seconds > scheduler.max_dynamic_wait_seconds)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'scheduler'],
        message: 'Dynamic recheck must not exceed maximum wait',
      });
    if (scheduler.scan_interval_seconds > scheduler.cache_ttl_seconds)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'scheduler', 'scan_interval_seconds'],
        message: 'Scheduler scan interval must not exceed the cache TTL',
      });
    if (scheduler.initialization_retry.base_delay_ms > scheduler.initialization_retry.max_delay_ms)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'scheduler', 'initialization_retry'],
        message: 'Initialization retry requires base <= max delay',
      });
    const buyersFreshness = Math.min(
      config.chains.sol.level1.buyers_freshness_seconds,
      config.chains.bsc.level1.buyers_freshness_seconds,
    );
    if (scheduler.cache_ttl_seconds > buyersFreshness)
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'coingecko', 'scheduler', 'cache_ttl_seconds'],
        message: 'Scheduler cache TTL must not exceed chain buyers freshness',
      });

    if (
      config.providers.gmgn.signal_type_allowlist.some((signalType) =>
        [14, 15, 16].includes(signalType),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', 'gmgn', 'signal_type_allowlist'],
        message: 'GMGN signal types 14, 15, and 16 are unsupported',
      });
    }

    const s1Groups = [
      ['sol', config.chains.sol.safety.s1],
      ['bsc', config.chains.bsc.safety.s1],
    ] as const;
    for (const [chain, s1] of s1Groups) {
      for (const [field, threshold] of Object.entries(s1)) {
        if (threshold.enabled && !threshold.verified)
          ctx.addIssue({
            code: 'custom',
            path: ['chains', chain, 'safety', 's1', field, 'verified'],
            message: 'Enabled S1 fields must be verified before activation',
          });
      }
    }

    const { capacity, high_watermark, hard_limit } = config.runtime.g2_queue;
    if (!(high_watermark < hard_limit && hard_limit <= capacity))
      ctx.addIssue({
        code: 'custom',
        path: ['runtime', 'g2_queue'],
        message: 'G2 watermarks must satisfy high < hard <= capacity',
      });

    const destinations = ['admin_private', 'channel', 'group'] as const;
    const enabled = destinations.filter((destination) => config.delivery[destination].enabled);
    const anchor = config.delivery.outcome_anchor_destination;
    if (!config.delivery[anchor].enabled)
      ctx.addIssue({
        code: 'custom',
        path: ['delivery', 'outcome_anchor_destination'],
        message: 'Anchor destination must be enabled',
      });
    if (enabled.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'At least one delivery destination must be enabled',
      });
    if (
      config.global.run_mode === 'shadow' &&
      (anchor !== 'admin_private' ||
        config.delivery.channel.enabled ||
        config.delivery.group.enabled)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'Shadow mode requires admin_private anchor and disables channel/group',
      });
    }
    if (config.global.run_mode === 'production') {
      const unverifiedS0 = [
        ['sol', config.chains.sol.safety.s0.verified],
        ['bsc', config.chains.bsc.safety.s0.verified],
      ].filter(([, verified]) => !verified);
      if (unverifiedS0.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: ['chains', 'safety', 's0', 'verified'],
          message: 'Production requires verified SOL and BSC S0 fixtures',
        });
    }
    if (
      !config.delivery.admin_private.allowed_user_ids.includes(
        config.delivery.admin_private.chat_id,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delivery', 'admin_private', 'allowed_user_ids'],
        message: 'Admin chat_id must be allowlisted',
      });
    }
    if (
      config.chains.sol.newborn.max_age_seconds >= config.chains.sol.established.min_age_seconds ||
      config.chains.bsc.newborn.max_age_seconds >= config.chains.bsc.established.min_age_seconds
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['chains'],
        message: 'Newborn age boundary must be below Established boundary',
      });
    }
  });

export type BotConfig = z.infer<typeof configSchema>;
