/**
 * 前端共享业务常量。
 * 所有与应用级业务默认值相关的魔数统一收敛于此，避免在多处内联、漂移。
 */

/** 投递记录分页默认每页条数（与后端 routers/data.py 的 page_size=Query(20, ...) 对齐）。 */
export const DEFAULT_PAGE_SIZE = 20;

/** 投递记录分页可选每页条数。 */
export const PAGE_SIZE_OPTIONS = [10, 20, 50];

/** 每日投递上限默认值（与后端 app/config.py 的 daily_limit: int = 15 对齐）。 */
export const DAILY_LIMIT_DEFAULTS = { min: 1, max: 500, fallback: 15 };
