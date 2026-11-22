/**
 * Strategy V2 prospective experiment. Historical dynamic PAPER STREAM trades
 * were strongly net-negative, so qualifying STREAM / whale_stream signals
 * become observation-only until independently validated.
 *
 * Enabled by default ONLY in dynamic meme PAPER; an existing PM2 process may
 * retain its old environment during a guarded release restart. Setting the
 * operator's BOT_PAPER_STREAM_SHADOW_ONLY=0 explicitly opts out.
 *
 * This NEVER affects BURST, scored, exits, WATCH, or any LIVE path.
 */
export const PAPER_STREAM_SHADOW_REASON = 'strategy_v2_stream_shadow_only';

export function paperStreamShadowOnly(
  mode: string,
  signalType: string
): boolean {
  return mode === 'PAPER' &&
    process.env.BOT_PAPER_MEME_DISCOVERY === '1' &&
    process.env.BOT_PAPER_STREAM_SHADOW_ONLY !== '0' &&
    (signalType === 'stream' || signalType === 'whale_stream');
}

export function paperStreamEntryReasonBlocked(
  mode: string,
  entryReason: string | null | undefined
): boolean {
  return paperStreamShadowOnly(mode, 'stream') &&
    /^\[STREAM\]/i.test(entryReason || '');
}
