import { z } from 'zod';

const looseObject = z.record(z.string(), z.unknown());

export const gmgnTrendingRawSchema = z
  .object({ code: z.number(), data: z.object({ rank: z.array(looseObject) }).strict() })
  .passthrough();
export const gmgnHotSearchesRawSchema = z.array(
  z.object({ chain: z.string(), tokens: z.array(looseObject) }).passthrough(),
);
export const gmgnSecurityRawSchema = z
  .object({
    address: z.string(),
    renounced_mint: z.unknown().optional(),
    renounced_freeze_account: z.unknown().optional(),
    is_honeypot: z.unknown().optional(),
    is_renounced: z.unknown().optional(),
    owner_renounced: z.unknown().optional(),
    is_open_source: z.unknown().optional(),
    buy_tax: z.unknown().optional(),
    sell_tax: z.unknown().optional(),
  })
  .passthrough();
export const gmgnTokenPoolRawSchema = z
  .object({ code: z.number(), data: looseObject })
  .passthrough();
export const coingeckoPoolBatchRawSchema = z
  .object({ data: z.array(looseObject), included: z.array(looseObject).optional() })
  .passthrough();
export const coingeckoTradesRawSchema = z.object({ data: z.array(looseObject) }).passthrough();
export const coingeckoG2RawSchema = z
  .object({ c: z.literal('G2'), n: z.string(), pa: z.string(), ty: z.unknown(), t: z.unknown() })
  .passthrough();
export const coingeckoOhlcv30sRawSchema = z
  .object({
    data: z.array(
      z.tuple([z.number(), z.string(), z.string(), z.string(), z.string(), z.string()]),
    ),
  })
  .passthrough();

export type GmgnTrendingRaw = z.infer<typeof gmgnTrendingRawSchema>;
export type CoingeckoG2Raw = z.infer<typeof coingeckoG2RawSchema>;
