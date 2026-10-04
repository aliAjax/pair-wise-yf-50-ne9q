/**
 * 河湾片区恢复分组派工引擎（纯 TypeScript，不依赖 Vue）。
 *
 * 一条可恢复流水线：接收补传 → 冲突冻结 → 分组派工 → 同步送达。
 * - 重复家庭只保留一条，已派/在队任务随合并迁到保留记录
 * - 字段冲突未定的家庭冻结，不能占用小组名额
 * - 紧急度变化后只重排「排队」任务，已派出/进行中的任务不受影响
 * - 派工与送达全部幂等：进程中断后从检查点继续，已派出任务不重发
 */

export type NeedLevel = "紧急" | "高" | "一般";
export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type ReviewStatus = "排队" | "已派出" | "进行中" | "已完成";
export type ConflictStatus = "待处理" | "采用本地" | "采用远端";
export type DispatchStep = "接收补传" | "冲突冻结" | "派工" | "同步送达";

export const DISPATCH_STEPS: DispatchStep[] = ["接收补传", "冲突冻结", "派工", "同步送达"];

export interface DispatchHousehold {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus | string;
  version: number;
  deviceUpdatedAt: string;
  note: string;
  blocked?: boolean;
  mergedFrom?: string[];
}

export interface CrewGroup {
  id: string;
  name: string;
  /** 同时只能接一项现场复核：容量 = 可同时进行的现场复核数量 */
  capacity: number;
}

export interface ReviewTask {
  id: string;
  householdId: string;
  groupId: string;
  title: string;
  priority: NeedLevel;
  status: ReviewStatus;
  /** 入队顺序号，紧急度相同时按先到先得 */
  seq: number;
  enqueuedAt: string;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;
  /** 最近一次抢占/派工失败原因，成功派出后清空 */
  lastReason?: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: "address" | "members" | "needLevel" | "note" | "vulnerable";
  fieldLabel: string;
  localValue: string;
  remoteValue: string;
  sourceDevice: string;
  receivedAt: string;
  status: ConflictStatus;
}

export interface OutboxItem {
  id: string;
  /** 派工送达请求的幂等键，服务端按此去重 */
  requestId: string;
  reviewId: string;
  groupId: string;
  action: "派出现场复核";
  detail: string;
  time: string;
  sent: boolean;
  sentAt?: string;
}

export interface IncomingNeed {
  head: string;
  community: string;
  address: string;
  members?: number;
  vulnerable?: string[];
  needLevel: NeedLevel;
  needs: string[];
  note?: string;
}

export interface IncomingBatch {
  batchId?: string;
  device: string;
  items: IncomingNeed[];
}

export interface IncomingRecord extends IncomingNeed {
  id: string;
  batchId: string;
  device: string;
  receivedAt: string;
}

export interface JournalEntry {
  step: DispatchStep;
  at: string;
  ok: boolean;
  message: string;
}

export interface DispatchRun {
  runId: string;
  status: "进行中" | "失败" | "完成";
  checkpoints: Record<DispatchStep, boolean>;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** 断点注入：只触发一次，触发后清空，重试即可通过 */
  injectFailure?: DispatchStep;
  pendingBatch?: IncomingBatch;
  journal: JournalEntry[];
}

export interface LogEntry {
  id: string;
  time: string;
  kind: "补传" | "合并" | "冲突" | "派工" | "同步" | "重排";
  message: string;
}

export interface DispatchState {
  groups: CrewGroup[];
  reviews: ReviewTask[];
  conflicts: FieldConflict[];
  outbox: OutboxItem[];
  inbox: IncomingRecord[];
  processedBatches: string[];
  journals: DispatchRun[];
  activeRunId?: string;
  log: LogEntry[];
  seq: number;
}

export interface ClaimResult {
  ok: boolean;
  reason?: string;
  review?: ReviewTask;
}

export function uid(prefix = ""): string {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

function now(): string {
  return new Date().toISOString();
}

function dedupeKey(head: string, community: string): string {
  return `${head.trim().replace(/\s+/g, "")}|${community.trim().replace(/\s+/g, "")}`;
}

const LEVEL_RANK: Record<NeedLevel, number> = { 紧急: 0, 高: 1, 一般: 2 };
const FIELD_LABELS: Record<FieldConflict["field"], string> = {
  address: "地址",
  members: "家庭人数",
  needLevel: "紧急度",
  note: "现场说明",
  vulnerable: "特殊照护"
};

export function createInitialDispatchState(groups: CrewGroup[] = []): DispatchState {
  return {
    groups,
    reviews: [],
    conflicts: [],
    outbox: [],
    inbox: [],
    processedBatches: [],
    journals: [],
    activeRunId: undefined,
    log: [],
    seq: 1
  };
}

function pushLog(state: DispatchState, kind: LogEntry["kind"], message: string) {
  state.log.unshift({ id: uid("log"), time: now(), kind, message });
  if (state.log.length > 200) state.log.length = 200;
}

function headOf(households: DispatchHousehold[], id: string): string {
  return households.find((item) => item.id === id)?.head ?? "未知家庭";
}

/** 小组当前占用名额：已派出（待开工）与进行中都算占用，已完成释放 */
export function activeCount(state: DispatchState, groupId: string): number {
  return state.reviews.filter((item) => item.groupId === groupId && (item.status === "已派出" || item.status === "进行中")).length;
}

/** 排队任务排序：紧急度高者在前，同级按入队顺序；非排队任务不参与 */
export function queuedReviews(households: DispatchHousehold[], state: DispatchState, groupId?: string): ReviewTask[] {
  const levelOf = new Map(households.map((item) => [item.id, item.needLevel]));
  return state.reviews
    .filter((item) => item.status === "排队" && (groupId === undefined || item.groupId === groupId))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = LEVEL_RANK[levelOf.get(a.item.householdId) ?? "一般"] - LEVEL_RANK[levelOf.get(b.item.householdId) ?? "一般"];
      return diff !== 0 ? diff : a.item.seq - b.item.seq || a.index - b.index;
    })
    .map(({ item }) => item);
}

/** 紧急度变化后的重排：只动排队任务，已派出/进行中任务保持原位继续跑 */
export function reorderQueued(households: DispatchHousehold[], state: DispatchState) {
  const ordered = queuedReviews(households, state);
  const orderedIds = new Set(ordered.map((item) => item.id));
  const fixed = state.reviews.filter((item) => !orderedIds.has(item.id));
  state.reviews = [...ordered, ...fixed];
}

export function enqueueReview(
  households: DispatchHousehold[],
  state: DispatchState,
  input: { householdId: string; groupId: string; title?: string; priority?: NeedLevel }
): ReviewTask | undefined {
  const household = households.find((item) => item.id === input.householdId);
  const group = state.groups.find((item) => item.id === input.groupId);
  if (!household || !group) return undefined;
  // 同一家庭在同一小组已有未完成任务时幂等返回，避免重复入队
  const open = state.reviews.find(
    (item) => item.householdId === input.householdId && item.groupId === input.groupId && item.status !== "已完成"
  );
  if (open) return open;
  const review: ReviewTask = {
    id: uid("r"),
    householdId: input.householdId,
    groupId: input.groupId,
    title: input.title ?? "现场复核",
    priority: input.priority ?? household.needLevel,
    status: "排队",
    seq: state.seq,
    enqueuedAt: now()
  };
  state.seq += 1;
  state.reviews.push(review);
  reorderQueued(households, state);
  pushLog(state, "派工", `${household.head} 的${review.title}进入 ${group.name} 队列（#${review.seq}）`);
  return review;
}

/** 修改紧急度：未开工任务立即按新顺序重排，已开工任务不受影响 */
export function setNeedLevel(households: DispatchHousehold[], state: DispatchState, householdId: string, level: NeedLevel) {
  const household = households.find((item) => item.id === householdId);
  if (!household || household.needLevel === level) return;
  const from = household.needLevel;
  household.needLevel = level;
  household.version += 1;
  household.deviceUpdatedAt = now();
  reorderQueued(households, state);
  pushLog(state, "重排", `${household.head} 紧急度 ${from} → ${level}，排队任务已重排，开工任务不动`);
}

export function recomputeBlocked(households: DispatchHousehold[], state: DispatchState) {
  households.forEach((household) => {
    household.blocked = state.conflicts.some((item) => item.householdId === household.id && item.status === "待处理");
  });
}

function assignReview(
  households: DispatchHousehold[],
  state: DispatchState,
  review: ReviewTask,
  actor: string
): OutboxItem {
  review.status = "已派出";
  review.assignedAt = now();
  review.lastReason = undefined;
  const household = households.find((item) => item.id === review.householdId);
  const group = state.groups.find((item) => item.id === review.groupId)!;
  if (household && household.status !== "已完成") household.status = "已分派";
  const item: OutboxItem = {
    id: uid("o"),
    requestId: uid("req"),
    reviewId: review.id,
    groupId: group.id,
    action: "派出现场复核",
    detail: `${group.name} ← ${household?.head ?? review.householdId} / ${review.title}`,
    time: now(),
    sent: false
  };
  state.outbox.unshift(item);
  pushLog(state, "派工", `${actor} 派工成功：${item.detail}，送达请求 ${item.requestId.slice(-6)} 待同步`);
  return item;
}

/**
 * 抢占一个小组名额（单次原子操作）。
 * JS 单线程内检查-占用不可分割；并发双方按到达顺序依次进入，后到者只能看到已满容量。
 */
export function claimReview(
  households: DispatchHousehold[],
  state: DispatchState,
  request: { groupId: string; householdId: string; actor: string }
): ClaimResult {
  const group = state.groups.find((item) => item.id === request.groupId);
  if (!group) return { ok: false, reason: "小组不存在" };
  const review = state.reviews.find(
    (item) => item.groupId === request.groupId && item.householdId === request.householdId && item.status === "排队"
  );
  if (!review) {
    const dispatched = state.reviews.find(
      (item) => item.groupId === request.groupId && item.householdId === request.householdId && item.status !== "排队"
    );
    if (dispatched) return { ok: false, reason: "任务已经派出，不能重复派工", review: dispatched };
    return { ok: false, reason: "该家庭在该小组没有排队任务" };
  }
  const household = households.find((item) => item.id === request.householdId);
  if (!household) return { ok: false, reason: "家庭需求记录不存在" };
  if (household.blocked) return { ok: false, reason: "字段冲突尚未定稿，家庭冻结中，不能占用名额", review };
  if (activeCount(state, group.id) >= group.capacity) {
    review.lastReason = "名额已满，任务留在队列";
    pushLog(state, "派工", `${request.actor} 抢占 ${group.name} 失败：名额已满，${household.head} 留在队列`);
    return { ok: false, reason: `${group.name} 名额已满，任务留在队列`, review };
  }
  assignReview(households, state, review, request.actor);
  return { ok: true, review };
}

export interface ArrivalRequest {
  groupId: string;
  householdId: string;
  actor: string;
  arrivedAt: string;
}

/** 两人同时抢占最后一个名额：严格按到达时间排序，只让先到者接到任务 */
export function contendSlot(
  households: DispatchHousehold[],
  state: DispatchState,
  requests: ArrivalRequest[]
): Array<ClaimResult & { actor: string; arrivedAt: string }> {
  return [...requests]
    .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt))
    .map((request) => ({ actor: request.actor, arrivedAt: request.arrivedAt, ...claimReview(households, state, request) }));
}

/** 开工：已派出 → 进行中；开工后任务不再参与任何重排 */
export function startReview(households: DispatchHousehold[], state: DispatchState, reviewId: string) {
  const review = state.reviews.find((item) => item.id === reviewId);
  if (!review || review.status !== "已派出") return;
  review.status = "进行中";
  review.startedAt = now();
  pushLog(state, "派工", `${headOf(households, review.householdId)} 的${review.title}已开工，继续执行`);
}

/** 完工：释放小组名额；同家庭没有其他未完成任务时家庭闭环 */
export function completeReview(households: DispatchHousehold[], state: DispatchState, reviewId: string) {
  const review = state.reviews.find((item) => item.id === reviewId);
  if (!review || (review.status !== "进行中" && review.status !== "已派出")) return;
  review.status = "已完成";
  review.completedAt = now();
  const household = households.find((item) => item.id === review.householdId);
  const stillOpen = state.reviews.some(
    (item) => item.householdId === review.householdId && item.status !== "已完成"
  );
  if (household && !stillOpen) household.status = "已完成";
  const group = state.groups.find((item) => item.id === review.groupId);
  pushLog(state, "派工", `${household?.head ?? ""} 的${review.title}完成，${group?.name ?? ""} 释放 1 个名额`);
}

/** 冲突定稿；定稿后若该家庭没有其他待处理冲突则解冻 */
export function resolveConflict(
  households: DispatchHousehold[],
  state: DispatchState,
  conflictId: string,
  resolution: Exclude<ConflictStatus, "待处理">
) {
  const conflict = state.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.status !== "待处理") return;
  const household = households.find((item) => item.id === conflict.householdId);
  conflict.status = resolution;
  if (household) {
    if (resolution === "采用远端") {
      const value: unknown = conflict.field === "members" ? Number(conflict.remoteValue) : conflict.remoteValue;
      (household as unknown as Record<string, unknown>)[conflict.field] = value;
    }
    household.version += 1;
    household.deviceUpdatedAt = now();
    recomputeBlocked(households, state);
    pushLog(
      state,
      "冲突",
      `${household.head} 的「${conflict.fieldLabel}」冲突已定稿（${resolution}）${household.blocked ? "，仍有其他冲突冻结" : "，家庭解冻"}`
    );
  }
}

/**
 * 手动合并重复家庭（同设备重复登记）。
 * 保留 target 一条：需求/特殊照护取并集，排队与已派任务、未决冲突全部迁到保留记录。
 */
export function mergeInto(households: DispatchHousehold[], state: DispatchState, sourceId: string, targetId: string) {
  const source = households.find((item) => item.id === sourceId);
  const target = households.find((item) => item.id === targetId);
  if (!source || !target || source.id === target.id) return;
  target.needs = Array.from(new Set([...target.needs, ...source.needs]));
  target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
  if (source.note && source.note !== target.note) target.note = `${target.note}；${source.note}`;
  target.mergedFrom = [...(target.mergedFrom ?? []), source.id];
  target.version += 1;
  target.deviceUpdatedAt = now();
  state.reviews.forEach((review) => {
    if (review.householdId === sourceId) review.householdId = targetId;
  });
  state.conflicts.forEach((conflict) => {
    if (conflict.householdId !== sourceId) return;
    conflict.householdId = targetId;
  });
  // 同字段同远端值的冲突迁移后去重
  state.conflicts = state.conflicts.filter((conflict, index, all) => {
    if (conflict.householdId !== targetId) return true;
    return (
      all.findIndex(
        (other) =>
          other.householdId === targetId &&
          other.field === conflict.field &&
          other.remoteValue === conflict.remoteValue &&
          other.status === conflict.status
      ) === index
    );
  });
  households.splice(households.indexOf(source), 1);
  recomputeBlocked(households, state);
  reorderQueued(households, state);
  pushLog(state, "合并", `重复家庭 ${source.head}（${source.address}）已合并到保留记录，关联任务随迁`);
}

function normalizeNeed(raw: IncomingNeed, receivedAt: string): IncomingNeed {
  return {
    head: raw.head.trim(),
    community: raw.community.trim(),
    address: raw.address.trim(),
    members: raw.members ?? 1,
    vulnerable: raw.vulnerable ?? [],
    needLevel: raw.needLevel,
    needs: raw.needs.map((item) => item.trim()).filter(Boolean),
    note: raw.note?.trim() || ""
  };
}

function pushConflict(
  state: DispatchState,
  householdId: string,
  field: FieldConflict["field"],
  localValue: string,
  remoteValue: string,
  sourceDevice: string,
  receivedAt: string
) {
  const duplicate = state.conflicts.find(
    (item) =>
      item.householdId === householdId &&
      item.field === field &&
      item.remoteValue === remoteValue &&
      item.status === "待处理"
  );
  if (duplicate) return;
  state.conflicts.unshift({
    id: uid("c"),
    householdId,
    field,
    fieldLabel: FIELD_LABELS[field],
    localValue,
    remoteValue,
    sourceDevice,
    receivedAt,
    status: "待处理"
  });
}

export interface IngestResult {
  skipped: boolean;
  created: string[];
  merged: string[];
  conflicts: number;
}

/**
 * 接收其他设备补传的一批家庭需求（批次幂等）。
 * 新家庭入库并入队；重复家庭只保留一条，差异字段生成冲突并冻结，需求取并集。
 */
export function ingestBatch(
  households: DispatchHousehold[],
  state: DispatchState,
  batch: IncomingBatch,
  options?: { defaultGroupId?: string }
): IngestResult {
  const batchId = batch.batchId ?? `batch-${uid()}`;
  if (state.processedBatches.includes(batchId)) {
    pushLog(state, "补传", `批次 ${batchId.slice(-6)} 已处理过，整批跳过（断点重放不重复入库）`);
    return { skipped: true, created: [], merged: [], conflicts: 0 };
  }
  state.processedBatches.push(batchId);
  const result: IngestResult = { skipped: false, created: [], merged: [], conflicts: 0 };

  batch.items.forEach((raw) => {
    const item = normalizeNeed(raw, now());
    const receivedAt = now();
    state.inbox.unshift({ ...item, id: uid("in"), members: item.members, vulnerable: item.vulnerable, note: item.note, batchId, device: batch.device, receivedAt });
    const key = dedupeKey(item.head, item.community);
    const existing = households.find((household) => dedupeKey(household.head, household.community) === key);

    if (!existing) {
      const household: DispatchHousehold = {
        id: uid("h"),
        head: item.head,
        community: item.community,
        address: item.address,
        members: item.members ?? 1,
        vulnerable: item.vulnerable ?? [],
        needLevel: item.needLevel,
        needs: item.needs,
        status: "待复核",
        version: 1,
        deviceUpdatedAt: receivedAt,
        note: item.note ?? ""
      };
      households.unshift(household);
      result.created.push(household.id);
      pushLog(state, "补传", `${batch.device} 补传新家庭：${household.head}（${household.address}）`);
      if (options?.defaultGroupId) enqueueReview(households, state, { householdId: household.id, groupId: options.defaultGroupId });
      return;
    }

    // 重复家庭：合并到保留记录，逐字段比对
    const before = state.conflicts.length;
    const compare = (field: FieldConflict["field"], local: string | number, remote: string | number) => {
      if (String(local) !== String(remote)) {
        pushConflict(state, existing.id, field, String(local), String(remote), batch.device, receivedAt);
      }
    };
    compare("address", existing.address, item.address);
    compare("members", existing.members, item.members ?? existing.members);
    compare("needLevel", existing.needLevel, item.needLevel);
    compare("note", existing.note, item.note ?? "");
    compare("vulnerable", existing.vulnerable.join("、"), (item.vulnerable ?? []).join("、"));
    existing.needs = Array.from(new Set([...existing.needs, ...item.needs]));
    existing.vulnerable = Array.from(new Set([...existing.vulnerable, ...(item.vulnerable ?? [])]));
    existing.version += 1;
    existing.deviceUpdatedAt = receivedAt;
    const added = state.conflicts.length - before;
    result.conflicts += added;
    result.merged.push(existing.id);
    pushLog(
      state,
      "合并",
      added > 0
        ? `${batch.device} 补传重复家庭 ${existing.head}：保留一条记录，${added} 个字段冲突待人工定稿，家庭冻结`
        : `${batch.device} 补传 ${existing.head}：内容一致或为需求子集，只保留一条，不产生冲突`
    );
  });

  recomputeBlocked(households, state);
  reorderQueued(households, state);
  return result;
}

/** 派工排空：按小组容量与队列优先级尽量派；冲突冻结家庭跳过但留在队列 */
function drainAssignments(households: DispatchHousehold[], state: DispatchState, actor: string, injectHalt: boolean) {
  let claimed = 0;
  for (const group of state.groups) {
    while (activeCount(state, group.id) < group.capacity) {
      const candidate = queuedReviews(households, state, group.id).find((review) => {
        const household = households.find((item) => item.id === review.householdId);
        return household && !household.blocked;
      });
      if (!candidate) break;
      assignReview(households, state, candidate, actor);
      claimed += 1;
      // 模拟派工进程在第一项成功后崩溃：检查点未写入，重试时已派任务不会再派
      if (injectHalt) throw new Error("派工进程中断（模拟崩溃，将从检查点恢复）");
    }
  }
  return claimed;
}

/** 待同步发件箱：只发未送达项；已送达项靠 sent 标志永不重发 */
function flushOutbox(state: DispatchState, injectHalt: boolean) {
  const pending = state.outbox.filter((item) => !item.sent);
  if (injectHalt && pending.length > 0) {
    throw new Error("弱网中断：派工送达未确认，请求保留在待同步队列");
  }
  pending.forEach((item) => {
    item.sent = true;
    item.sentAt = now();
  });
  if (pending.length > 0) pushLog(state, "同步", `${pending.length} 条派工送达成功（按 requestId 幂等，已送达的不重发）`);
  return pending.length;
}

function activeRun(state: DispatchState): DispatchRun | undefined {
  return state.journals.find((run) => run.runId === state.activeRunId && run.status !== "完成");
}

/**
 * 一次可恢复的派工处理。失败后再次调用即从最后一个未完成检查点继续：
 * 已处理批次不重放、已派出任务不重派、已送达请求不重发。
 */
export function runDispatch(
  households: DispatchHousehold[],
  state: DispatchState,
  options?: { batch?: IncomingBatch; failAt?: DispatchStep; defaultGroupId?: string }
): DispatchRun {
  let run = activeRun(state);
  if (!run) {
    run = {
      runId: uid("run"),
      status: "进行中",
      checkpoints: { 接收补传: false, 冲突冻结: false, 派工: false, 同步送达: false },
      startedAt: now(),
      journal: [],
      injectFailure: options?.failAt,
      pendingBatch: options?.batch
    };
    state.activeRunId = run.runId;
    state.journals.unshift(run);
    pushLog(state, "派工", `派工处理 ${run.runId.slice(-6)} 开始`);
  }

  const executeStep = (step: DispatchStep, fn: () => void | number) => {
    if (run!.checkpoints[step]) {
      run!.journal.push({ step, at: now(), ok: true, message: "检查点已完成，跳过（不重复执行）" });
      return;
    }
    try {
      const done = fn();
      run!.checkpoints[step] = true;
      run!.journal.push({ step, at: now(), ok: true, message: done === undefined ? "完成" : `完成（${done}）` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run!.journal.push({ step, at: now(), ok: false, message });
      throw error instanceof Error ? error : new Error(message);
    }
  };

  try {
    executeStep("接收补传", () => {
      if (!run!.pendingBatch) return 0;
      const result = ingestBatch(households, state, run!.pendingBatch, { defaultGroupId: options?.defaultGroupId });
      run!.pendingBatch = undefined;
      if (result.skipped) return 0;
      return result.created.length + result.merged.length;
    });
    executeStep("冲突冻结", () => {
      recomputeBlocked(households, state);
      const frozen = households.filter((item) => item.blocked).length;
      if (frozen > 0) pushLog(state, "冲突", `${frozen} 个家庭存在未决字段冲突，本轮不占用小组名额`);
      return frozen;
    });
    executeStep("派工", () => drainAssignments(households, state, "负责人派工台", run!.injectFailure === "派工"));
    executeStep("同步送达", () => flushOutbox(state, run!.injectFailure === "同步送达"));
    run.status = "完成";
    run.finishedAt = now();
    run.injectFailure = undefined;
    state.activeRunId = undefined;
    pushLog(state, "派工", `派工处理 ${run.runId.slice(-6)} 全部完成`);
  } catch (error) {
    run.status = "失败";
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = now();
    // 故障注入只生效一次：保留各步检查点，下次调用从断点继续
    run.injectFailure = undefined;
    pushLog(state, "派工", `派工处理中断：${run.error}。已完成步骤已落检查点，可随时重试`);
  }
  return run;
}
