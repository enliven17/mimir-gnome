/**
 * Market URLs: /arena/gno/<kind>/<id> is the market page. Pure. The chain argument is accepted from any row (the API
 * and index types carry it as a string) and ignored: gno.land is the only chain.
 */
export const marketPath = (_chain: string | null | undefined, kind: "vs" | "pool", id: number | string) => `/arena/gno/${kind}/${id}`;

/** "pool-3" / "vs-3" for share links and cards. */
export const marketRef = (_chain: string | null | undefined, kind: "vs" | "pool", id: number) => `${kind}-${id}`;
