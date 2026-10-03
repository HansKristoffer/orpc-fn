/** Internal bridge shared by the execution middleware and HTTP adapters. */
export const REQUEST_TIMING = Symbol('orpc-fn.requestTiming')
export type InvocationTiming = { procedureMs: number; calls: number }

export const RAW_INPUT = Symbol('orpc-fn.rawInput')
