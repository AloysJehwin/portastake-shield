/**
 * @portastake/sdk: paid on-chain tools (x402) and PortaStake tooling for Portaldot.
 *
 * - `@portastake/sdk/chain`: PortaStake vault, desk and mandate clients, a keeper, explorer links
 *   and Portaldot transaction helpers.
 * - `@portastake/sdk/x402`: a fetch that pays x402 APIs in xUSD, plus offer and settlement helpers.
 * - `@portastake/sdk/x402/server`: Express middleware that charges xUSD per request.
 * - `@portastake/sdk/x402/facilitator`: an x402 facilitator for Portaldot.
 */
export * from "./chain/index.js";
export { createPayingFetch, getOffer, getSettlement, payAndFetchJson, xusd, formatXusd, XUSD } from "./x402/index.js";
export type { PayingFetchOptions, PayerSigner, Offer } from "./x402/index.js";
